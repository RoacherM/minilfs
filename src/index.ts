/**
 * pi-layerfs v0.2: every Pi session works on an isolated LayerFS Branch in a
 * shared Project Store by default.
 * - File tools (`read`, `write`, `edit`, `ls`, `find`, `grep`) go directly to the Store
 *   with automatic byte-exact Workspace fallback for binary, symlinks and >48KB lines.
 * - `bash` and `!cmd` mount a Workspace on demand, stream output, and unmount immediately.
 * - `/resume`, `/tree` and `/fork` restore or branch the file state alongside the conversation.
 * - The host folder is written only by `/layerfs apply` (with three-way conflict detection).
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
export const SESSION_ENTRY = "layerfs-session";
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

export default function layerfsExtension(pi: ExtensionAPI) {
  pi.registerFlag("no-layerfs", { description: "Disable LayerFS isolation for this run (tools act on the host folder)", type: "boolean", default: false });

  let session: LayerfsSession | null = null;
  let ready: Promise<LayerfsSession> | null = null;
  let disabled = false;
  let startError: Error | null = null;
  let pendingForkRef: string | null = null;

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
  const describe = (s: LayerfsSession) =>
    `LayerFS ${s.blocked ? "BLOCKED" : `on (${s.workBranch})`} · ${s.checkpoints.length} checkpoints${s.unapplied ? " · unapplied" : ""}`;

  async function need(): Promise<LayerfsSession> {
    if (disabled) throw new Error("LayerFS is disabled for this run");
    if (startError) throw new Error(`LayerFS failed to start: ${startError.message}. File tools are disabled (no fallback to the host folder).`);
    if (!ready) throw new Error("LayerFS has not started (no session)");
    return ready.catch((e) => { throw new Error(`LayerFS failed to start: ${e.message}. File tools are disabled (no fallback to the host folder).`); });
  }

  function report(ctx: ExtensionContext | undefined, s: LayerfsSession, r: { checkpoint: Checkpoint | null; error: Error | null }) {
    if (r.checkpoint) pi.appendEntry(CHECKPOINT_ENTRY, { ...r.checkpoint, project: s.project, branch: s.workBranch });
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
      glob: (pattern: string, cwd: string, o: { ignore: string[]; limit: number }) => s.findFiles(pattern, cwd, o),
    },
  });

  pi.registerTool({
    ...local.read,
    async execute(id, params, signal, onUpdate) {
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
      const g = await s.grepWorkspace(params);
      if (g.matches === 0) return { content: [{ type: "text" as const, text: "No matches found" }], details: undefined };
      const limit = Math.max(1, params.limit ?? 100);
      const t = truncateHead(g.lines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
      const notes = [g.limitReached ? `${limit} matches limit reached` : "", t.truncated ? `${formatSize(DEFAULT_MAX_BYTES)} limit reached` : ""].filter(Boolean);
      return { content: [{ type: "text" as const, text: t.content + (notes.length ? `\n\n[${notes.join(". ")}]` : "") }], details: undefined };
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

  // ------------------------------------------------------------- lifecycle & tree / fork / resume

  /** Extracts the snapshot ref and session binding along a session entry chain (up to optional `stopAtEntryId`). */
  function inspectBranchEntries(entries: any[], stopAtEntryId?: string, inclusive = true) {
    let baseRef: string | undefined;
    let baseBranch: string | undefined;
    let workBranch: string | undefined;
    let project: string | undefined;
    let headCommit: string | null = null;
    for (const e of entries) {
      if (stopAtEntryId && e.id === stopAtEntryId && !inclusive) break;
      if (e.type === "custom" && e.customType === SESSION_ENTRY && e.data) {
        project = e.data.project ?? project;
        baseBranch = e.data.baseBranch ?? baseBranch;
        workBranch = e.data.workBranch ?? workBranch;
        baseRef = e.data.baseRef ?? baseRef;
      }
      if (e.type === "custom" && e.customType === CHECKPOINT_ENTRY && e.data?.commit) {
        headCommit = e.data.commit;
        workBranch = e.data.branch ?? workBranch;
      }
      if (stopAtEntryId && e.id === stopAtEntryId && inclusive) break;
    }
    return { project, baseBranch, workBranch, baseRef, headCommit };
  }

  pi.on("session_before_fork", async (event, ctx) => {
    if (disabled || !session) return;
    const branchEntries = ctx.sessionManager.getBranch();
    const info = inspectBranchEntries(branchEntries, event.entryId, event.position === "at");
    pendingForkRef = info.headCommit ?? info.baseRef ?? session.effectiveRef;
  });

  pi.on("session_tree", async (_event, ctx) => {
    if (disabled) return;
    const s = await need().catch(() => null);
    if (!s) return;
    const info = inspectBranchEntries(ctx.sessionManager.getBranch());
    const targetRef = info.headCommit ?? info.baseRef ?? s.baseRef;
    const switched = await s.switchToRef(targetRef);
    pi.appendEntry(SESSION_ENTRY, {
      project: s.project, volume: s.volume, cwd: s.cwd,
      baseBranch: s.baseBranch, workBranch: switched.branch, baseRef: s.baseRef, headCommit: s.headCommit,
    });
    status(ctx, describe(s));
  });

  pi.on("session_start", async (event, ctx) => {
    const config = resolveConfig();
    hostCwd = ctx.cwd;
    disabled = !config.enabled || pi.getFlag("no-layerfs") === true;
    if (disabled) {
      status(ctx, "LayerFS off");
      if (ctx.hasUI) ctx.ui.notify("LayerFS isolation is OFF for this run: tools act directly on the host folder.", "warning");
      return;
    }
    if (session && event.reason === "reload") {
      status(ctx, describe(session));
      return;
    }
    const branchInfo = inspectBranchEntries(ctx.sessionManager.getBranch());
    const forkRef = event.reason === "fork" ? (pendingForkRef ?? branchInfo.headCommit ?? branchInfo.baseRef ?? null) : null;
    pendingForkRef = null;

    const s = new LayerfsSession(ctx.cwd, ctx.sessionManager.getSessionId(), config);
    session = s;
    startError = null;
    status(ctx, "LayerFS starting…");
    ready = s.open({
      reason: event.reason,
      resumeBinding: branchInfo.project ? branchInfo : undefined,
      forkFromRef: forkRef,
    }).then(() => {
      pi.appendEntry(SESSION_ENTRY, {
        project: s.project, volume: s.volume, cwd: s.cwd,
        baseBranch: s.baseBranch, workBranch: s.workBranch, baseRef: s.baseRef, headCommit: s.headCommit,
      });
      status(ctx, describe(s));
      return s;
    }, (e) => {
      startError = e;
      status(ctx, "LayerFS FAILED");
      if (ctx.hasUI) ctx.ui.notify(`LayerFS failed to start: ${e.message}\nFile tools are disabled; nothing is written to the host folder.`, "error");
      throw e;
    });
    ready.catch(() => {});
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason === "reload") return;
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
      "File tools and bash run on an isolated LayerFS Branch of this project.",
      `Paths under ${session?.cwd ?? "the working directory"} refer to that Branch; edits there do NOT reach the user's folder until the user runs /layerfs apply.`,
      "Files outside the working directory are read-only. Secret files such as .env are not imported.",
    ].join("\n");
    return { systemPrompt: `${event.systemPrompt}\n${note}` };
  });

  // ------------------------------------------------------------- command

  const SUBCOMMANDS: Array<[string, string]> = [
    ["status", "当前分支、checkpoint 数、是否有未写回的改动"],
    ["diff", "列出本会话改了哪些文件"],
    ["apply", "把改动写回你的项目目录（有冲突则一个都不写）"],
    ["sync", "把你在 Pi 外的改动同步进 LayerFS main"],
    ["branches", "列出项目里所有 LayerFS 分支"],
    ["retry", "checkpoint 失败被锁住后重试"],
  ];
  pi.registerCommand("layerfs", {
    description: "LayerFS workspace: status | diff | apply | retry | sync | branches",
    getArgumentCompletions: (prefix: string) => {
      const items = SUBCOMMANDS.filter(([n]) => n.startsWith(prefix.trim())).map(([value, description]) => ({ value, label: value, description }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim().split(/\s+/)[0] || "status";
      const say = (t: string, level: "info" | "warning" | "error" = "info") => (ctx.hasUI ? ctx.ui.notify(t, level) : console.log(t));
      if (disabled) return say("LayerFS is off for this run.", "warning");
      let s: LayerfsSession;
      try { s = await need(); } catch (e: any) { return say(e.message, "error"); }
      if (sub === "status") {
        return say([
          describe(s),
          `project ${s.project} · volume ${s.volume}`,
          `branch ${s.workBranch} (base ${s.baseBranch} @ ${s.baseRef.slice(0, 12)}) · head ${(s.headCommit ?? "none").slice(0, 12)}`,
          s.blocked ? `blocked: ${s.blocked.reason}` : "",
        ].filter(Boolean).join("\n"));
      }
      if (sub === "branches") {
        const list = await s.listAllBranches();
        return say(list.map((b) => `${b.name.padEnd(20)} head ${(b.head ?? "-").slice(0, 12)} base ${(b.base ?? "-").slice(0, 12)}`).join("\n"));
      }
      if (sub === "diff") {
        const d = (await s.diff()).filter((i) => i.type !== "dir");
        return say(d.length ? d.map((i) => `${i.kind.padEnd(8)} ${i.path.replace(/^\//, "")}`).join("\n") : "No changes in the LayerFS workspace.");
      }
      if (sub === "sync") {
        const res = await s.syncHostDriftIntoMain();
        return say(res.synced.length ? `Synced ${res.synced.length} host file(s) into main: ${res.synced.join(", ")}` : "Host folder is already in sync with main.");
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
      return say([`未知子命令 "${sub}"。可用：`, ...SUBCOMMANDS.map(([n, d]) => `  /layerfs ${n.padEnd(9)} ${d}`)].join("\n"), "warning");
    },
  });
}
