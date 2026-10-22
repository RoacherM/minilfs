/**
 * pi-layerfs: every Pi session works in an isolated LayerFS Branch/Workspace
 * by default. The host project folder is only written by `/layerfs apply`.
 *
 *   pi -e /path/to/pi-layerfs            # on by default
 *   PI_LAYERFS=0 pi -e ...  |  pi -e ... --no-layerfs   # explicit opt-out
 *
 * Fail-closed: if LayerFS cannot start, file tools and bash fail with the
 * reason; they never fall back to the host folder.
 */
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createBashTool, createEditTool, createFindTool, createGrepTool, createLsTool, createReadTool, createWriteTool,
  DEFAULT_MAX_BYTES, formatSize, truncateHead,
} from "@earendil-works/pi-coding-agent";
import { resolveConfig } from "./config.ts";
import { LayerfsSession, type Checkpoint } from "./workspace.ts";

export const CHECKPOINT_ENTRY = "layerfs-checkpoint";
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

export default function layerfsExtension(pi: ExtensionAPI) {
  pi.registerFlag("no-layerfs", { description: "Disable LayerFS isolation for this run (tools act on the host folder)", type: "boolean", default: false });

  let session: LayerfsSession | null = null;
  let ready: Promise<LayerfsSession> | null = null;
  let disabled = false;
  let startError: Error | null = null;
  // prototypes for names/schemas/renderers; host tools are rebuilt with the session cwd when opted out
  const proto = process.cwd();
  let hostCwd = proto;
  const local = {
    read: createReadTool(proto), write: createWriteTool(proto), edit: createEditTool(proto), bash: createBashTool(proto),
    grep: createGrepTool(proto), find: createFindTool(proto), ls: createLsTool(proto),
  };
  const host: Record<string, (cwd: string) => any> = {
    read: createReadTool, write: createWriteTool, edit: createEditTool, bash: createBashTool, grep: createGrepTool, find: createFindTool, ls: createLsTool,
  };
  const onHost = (name: string, id: string, params: any, signal: any, onUpdate: any) => host[name](hostCwd).execute(id, params, signal, onUpdate);

  const status = (ctx: ExtensionContext | undefined, text: string | undefined) => { try { ctx?.ui.setStatus("layerfs", text); } catch {} };
  const describe = (s: LayerfsSession) => `LayerFS ${s.blocked ? "BLOCKED" : "on"} · ${s.checkpoints.length} checkpoints${s.unapplied ? " · unapplied" : ""}`;

  async function need(): Promise<LayerfsSession> {
    if (disabled) throw new Error("LayerFS is disabled for this run");
    if (startError) throw new Error(`LayerFS failed to start: ${startError.message}. File tools are disabled (no fallback to the host folder).`);
    if (!ready) throw new Error("LayerFS has not started (no session)");
    return ready.catch((e) => { throw new Error(`LayerFS failed to start: ${e.message}. File tools are disabled (no fallback to the host folder).`); });
  }

  function report(ctx: ExtensionContext | undefined, s: LayerfsSession, r: { checkpoint: Checkpoint | null; error: Error | null }) {
    if (r.checkpoint) pi.appendEntry(CHECKPOINT_ENTRY, { ...r.checkpoint, project: s.project, branch: "work" });
    status(ctx, describe(s));
    return r.error
      ? `\n\n[LayerFS] The change is in the workspace but its checkpoint failed (${(r.error as any).code ?? "Error"}: ${r.error.message}). Further changes are blocked until /layerfs retry succeeds.`
      : "";
  }

  const withNote = (result: any, note: string) =>
    note ? { ...result, content: [...(result.content ?? []), { type: "text", text: note }] } : result;

  // ------------------------------------------------------------- tools

  const ops = (s: LayerfsSession) => ({
    read: {
      readFile: (p: string) => s.readFile(p),
      access: (p: string) => s.access(p),
      detectImageMimeType: async (p: string) => IMAGE_TYPES[path.extname(p).toLowerCase()] ?? null,
    },
    write: { writeFile: (p: string, c: string) => s.writeFile(p, c), mkdir: (p: string) => s.mkdir(p) },
    edit: { readFile: (p: string) => s.readFile(p), writeFile: (p: string, c: string) => s.writeFile(p, c), access: (p: string) => s.access(p, true) },
    bash: { exec: (cmd: string, cwd: string, o: any) => s.exec(cmd, cwd, o) },
    ls: {
      exists: (p: string) => s.exists(p),
      stat: async (p: string) => { const d = await s.isDirectory(p); return { isDirectory: () => d }; },
      readdir: (p: string) => s.readdir(p),
    },
    find: {
      exists: (p: string) => s.exists(p),
      glob: (pattern: string, cwd: string, o: { ignore: string[]; limit: number }) => findInWorkspace(s, pattern, cwd, o),
    },
  });

  pi.registerTool({
    ...local.read,
    async execute(id, params, signal, onUpdate, ctx) {
      if (disabled) return onHost("read", id, params, signal, onUpdate);
      const s = await need();
      return createReadTool(s.cwd, { operations: ops(s).read }).execute(id, params, signal, onUpdate);
    },
  });

  for (const name of ["write", "edit", "bash"] as const) {
    pi.registerTool({
      ...local[name],
      async execute(id: string, params: any, signal: any, onUpdate: any, ctx: ExtensionContext) {
        if (disabled) return onHost(name, id, params, signal, onUpdate);
        const s = await need();
        const o = ops(s);
        const tool: any = name === "write" ? createWriteTool(s.cwd, { operations: o.write })
          : name === "edit" ? createEditTool(s.cwd, { operations: o.edit })
          : createBashTool(s.cwd, { operations: o.bash });
        const r = await s.mutate(id, name, () => tool.execute(id, params, signal, onUpdate));
        return withNote(r.value, report(ctx, s, r));
      },
    } as any);
  }

  pi.registerTool({
    ...local.ls,
    async execute(id, params, signal, onUpdate) {
      if (disabled) return onHost("ls", id, params, signal, onUpdate);
      const s = await need();
      return createLsTool(s.cwd, { operations: ops(s).ls }).execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...local.find,
    async execute(id, params, signal, onUpdate) {
      if (disabled) return onHost("find", id, params, signal, onUpdate);
      const s = await need();
      return createFindTool(s.cwd, { operations: ops(s).find }).execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...local.grep,
    async execute(id, params: any, signal, onUpdate) {
      if (disabled) return onHost("grep", id, params, signal, onUpdate);
      const s = await need();
      return grepInWorkspace(s, params);
    },
  });

  pi.on("user_bash", async (_event, ctx) => {
    if (disabled) return undefined;
    const s = await need();
    return {
      operations: {
        exec: async (cmd: string, cwd: string, o: any) => {
          const r = await s.mutate("user_bash", "user_bash", () => s.exec(cmd, cwd, o));
          const note = report(ctx, s, r);
          if (note) o.onData(Buffer.from(note));
          return r.value;
        },
      },
    };
  });

  // ------------------------------------------------------------- lifecycle

  pi.on("session_start", async (_event, ctx) => {
    const config = resolveConfig();
    hostCwd = ctx.cwd;
    disabled = !config.enabled || pi.getFlag("no-layerfs") === true;
    if (disabled) {
      status(ctx, "LayerFS off");
      if (ctx.hasUI) ctx.ui.notify("LayerFS isolation is OFF for this run: tools act directly on the host folder.", "warning");
      return;
    }
    if (session) return;
    const s = new LayerfsSession(ctx.cwd, ctx.sessionManager.getSessionId(), config);
    session = s;
    startError = null;
    status(ctx, "LayerFS starting…");
    ready = s.open().then(() => { status(ctx, describe(s)); return s; }, (e) => {
      startError = e;
      status(ctx, "LayerFS FAILED");
      if (ctx.hasUI) ctx.ui.notify(`LayerFS failed to start: ${e.message}\nFile tools are disabled; nothing is written to the host folder.`, "error");
      throw e;
    });
    ready.catch(() => {});
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const s = session;
    session = null;
    const r = ready;
    ready = null;
    if (!s) return;
    await r?.catch(() => {});
    const out = await s.close().catch((e) => ({ kept: true, notes: [`close failed: ${e.message}`] }));
    status(ctx, undefined);
    if (out.notes.length && ctx.hasUI) ctx.ui.notify(`LayerFS: ${out.notes.join("; ")}`, out.kept ? "warning" : "info");
  });

  pi.on("before_agent_start", async (event) => {
    if (disabled) return undefined;
    const note = [
      "",
      "File tools and bash run in an isolated LayerFS workspace of this project (Linux).",
      `Paths under ${session?.cwd ?? "the working directory"} refer to that workspace; edits there do NOT reach the user's folder until the user runs /layerfs apply.`,
      "Files outside the working directory are read-only. Secret files such as .env are not imported.",
    ].join("\n");
    return { systemPrompt: `${event.systemPrompt}\n${note}` };
  });

  // ------------------------------------------------------------- command

  pi.registerCommand("layerfs", {
    description: "LayerFS workspace: status | diff | apply | retry",
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim().split(/\s+/)[0] || "status";
      const say = (t: string, level: "info" | "warning" | "error" = "info") => (ctx.hasUI ? ctx.ui.notify(t, level) : console.log(t));
      if (disabled) return say("LayerFS is off for this run.", "warning");
      let s: LayerfsSession;
      try { s = await need(); } catch (e: any) { return say(e.message, "error"); }
      if (sub === "status") {
        return say([
          describe(s), `project ${s.project} · volume ${s.volume}`, `workspace ${s.container}:${s.wsDir}`,
          s.blocked ? `blocked: ${s.blocked.reason}` : "", s.leakedWorkspaces.length ? `leaked: ${s.leakedWorkspaces.join(", ")}` : "",
        ].filter(Boolean).join("\n"));
      }
      if (sub === "diff") {
        const d = (await s.diff()).filter((i) => i.type !== "dir");
        return say(d.length ? d.map((i) => `${i.kind.padEnd(8)} ${i.path.replace(/^\//, "")}`).join("\n") : "No changes in the LayerFS workspace.");
      }
      if (sub === "retry") {
        const r = await s.retry();
        report(ctx, s, r);
        return say(r.error ? `Retry failed: ${r.error.message}` : "Checkpoint saved; changes are unblocked.", r.error ? "error" : "info");
      }
      if (sub === "apply") {
        const d = (await s.diff()).filter((i) => i.type !== "dir");
        if (!d.length) return say("Nothing to apply.");
        if (ctx.hasUI && !(await ctx.ui.confirm("Apply LayerFS changes to your folder?", d.map((i) => `${i.kind} ${i.path}`).slice(0, 40).join("\n")))) return say("Apply cancelled.");
        const r = await s.apply();
        if (r.conflicts.length) return say(`Nothing applied: you changed these files since the session started:\n${r.conflicts.join("\n")}`, "error");
        status(ctx, describe(s));
        return say([`Applied ${r.applied.length} change(s) to ${s.cwd}.`, r.skipped.length ? `Skipped (never applied): ${r.skipped.join(", ")}` : ""].filter(Boolean).join("\n"));
      }
      return say(`Unknown subcommand ${sub}. Use: status | diff | apply | retry`, "warning");
    },
  });
}

// ------------------------------------------------------------- grep / find in the workspace

function matchesToolGlob(rel: string, pattern: string): boolean {
  if (pattern.includes("/")) return path.posix.matchesGlob(rel, pattern) || path.posix.matchesGlob(rel, `**/${pattern}`);
  return path.posix.matchesGlob(path.posix.basename(rel), pattern);
}

async function findInWorkspace(s: LayerfsSession, pattern: string, cwd: string, o: { ignore: string[]; limit: number }): Promise<string[]> {
  const root = s.toWs(cwd);
  if (!root) throw new Error(`${cwd} is outside the LayerFS workspace`);
  const r = await s.sh(`cd "$1" && find . \\( -name .git -o -name node_modules \\) -prune -o \\( -type f -o -type l \\) -print0`, [root]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `find failed in ${cwd}`);
  const out: string[] = [];
  for (const raw of r.stdout.split("\0")) {
    if (!raw) continue;
    const rel = raw.replace(/^\.\//, "");
    if (o.ignore.some((g) => path.posix.matchesGlob(rel, g))) continue;
    if (!matchesToolGlob(rel, pattern)) continue;
    out.push(path.join(cwd, rel));
    if (out.length >= o.limit) break;
  }
  return out;
}

async function grepInWorkspace(s: LayerfsSession, p: { pattern: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number }) {
  const target = path.resolve(s.cwd, p.path ?? ".");
  const ws = s.toWs(target);
  if (!ws) throw new Error(`${p.path} is outside the LayerFS workspace`);
  const limit = Math.max(1, p.limit ?? 100);
  const flags = ["-rnIH", "--exclude-dir=.git", "--exclude-dir=node_modules", p.ignoreCase ? "-i" : "", p.literal ? "-F" : "-P", p.context ? `-C${Math.floor(p.context)}` : "", p.glob ? `--include=${p.glob}` : ""].filter(Boolean);
  const isDir = await s.isDirectory(target);
  const script = isDir ? `cd "$1" && grep ${flags.map((f) => `'${f}'`).join(" ")} -e "$2" -- .` : `cd "$(dirname "$1")" && grep ${flags.map((f) => `'${f}'`).join(" ")} -e "$2" -- "$(basename "$1")"`;
  const r = await s.sh(script, [ws, p.pattern]);
  if (r.code === 1) return { content: [{ type: "text" as const, text: "No matches found" }], details: undefined };
  if (r.code !== 0) throw new Error(r.stderr.trim() || "grep failed");
  const lines: string[] = [];
  let matches = 0;
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    const clean = line.replace(/^\.\//, "");
    if (/^.+?:\d+:/.test(clean)) { if (matches >= limit) break; matches++; }
    lines.push(clean.replace(/^(.+?):(\d+):/, "$1:$2: ").replace(/^(.+?)-(\d+)-/, "$1-$2- "));
  }
  const t = truncateHead(lines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
  const notes = [matches >= limit ? `${limit} matches limit reached` : "", t.truncated ? `${formatSize(DEFAULT_MAX_BYTES)} limit reached` : ""].filter(Boolean);
  return { content: [{ type: "text" as const, text: t.content + (notes.length ? `\n\n[${notes.join(". ")}]` : "") }], details: undefined };
}
