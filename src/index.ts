/**
 * minilfs: every session works on an isolated LayerFS Branch in a
 * shared Project Store by default.
 * - File tools (`read`, `write`, `edit`, `ls`, `find`, `grep`) go directly to the Store
 *   with automatic byte-exact Workspace fallback for binary, symlinks and >48KB lines.
 * - `bash` and `!cmd` mount a Workspace on demand, stream output, and unmount immediately.
 * - `/resume`, `/tree` and `/fork` restore or branch the file state alongside the conversation.
 * - The host folder is written only by `/minilfs apply` (with three-way conflict detection).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createBashTool, createEditTool, createFindTool, createGrepTool, createLsTool, createReadTool, createWriteTool,
  DEFAULT_MAX_BYTES, formatSize, truncateHead,
} from "@earendil-works/pi-coding-agent";
import {
  createHarnessOperations,
  executeLayerfsAction,
  executeLayerfsApply,
  formatHistory,
  hiddenPath,
  hostPolicy,
  initialMode,
  type HostPolicy,
  MODE_TOOL_DESCRIPTION,
  MODE_TOOL_NAME,
  MODE_TOOL_SCHEMA,
  switchMode,
  type WorkspaceMode,
  LAYERFS_APPLY_TOOL_DESCRIPTION,
  LAYERFS_APPLY_TOOL_SCHEMA,
  LAYERFS_TOOL_DESCRIPTION,
  LAYERFS_TOOL_SCHEMA,
  LayerfsSession,
  loadHistory,
  resolveConfig,
  type Checkpoint,
} from "./core/index.ts";

export const CHECKPOINT_ENTRY = "minilfs-checkpoint";
export const SESSION_ENTRY = "minilfs-session";
export const MODE_ENTRY = "minilfs-mode";
const boot0 = () => resolveConfig();

export default function minilfsExtension(pi: ExtensionAPI) {
  pi.registerFlag("no-minilfs", { description: "Disable minilfs isolation for this run (tools act on the host folder)", type: "boolean", default: false });
  pi.registerFlag("minilfs-host", { description: "Who may switch the agent to host mode: ask (default) | auto | bypass (start in host mode) | never", type: "string", default: "" });

  let session: LayerfsSession | null = null;
  let ready: Promise<LayerfsSession> | null = null;
  let disabled = false;
  /**
   * Where tools act right now. "branch" (default): the minilfs Branch. "host": the real folder, for
   * work the Branch cannot do (nested sandboxes, mounts, privileged tools, host services). The agent
   * or the user switches; tools read this on every call, so a switch takes effect immediately.
   */
  let mode: WorkspaceMode = initialMode();
  /** set at session start from --minilfs-host / MINILFS_HOST_POLICY; /minilfs policy changes it */
  let policy: HostPolicy = hostPolicy();
  let lastCtx: ExtensionContext | undefined;
  const onHostNow = () => disabled || mode === "host";
  let startError: Error | null = null;
  /** the session once open() succeeded (null while starting or after a failed start) */
  let openSession: LayerfsSession | null = null;
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

  const status = (ctx: ExtensionContext | undefined, text: string | undefined) => {
    try { ctx?.ui.setStatus("minilfs", text); } catch {}
    try {
      if (text === undefined) {
        pi.events.emit("notify:status", { source: "minilfs", state: "cleared" });
      } else {
        const isError = /FAILED|BLOCKED/.test(text);
        pi.events.emit("notify:status", {
          source: "minilfs",
          state: isError ? "error" : "active",
          label: text.replace(/^minilfs\s*/, "") || text,
          icon: "LFS",
        });
      }
    } catch {}
  };
  const describe = (s: LayerfsSession) => {
    if (mode === "host") return "minilfs HOST mode · edits go to your folder";
    if (s.blocked) return "minilfs BLOCKED · /minilfs retry";
    const pending = s.unapplied ? ` · ${s.checkpoints.length} unapplied` : "";
    return `minilfs ${s.workBranch}${pending}`;
  };

  async function need(): Promise<LayerfsSession> {
    if (disabled) throw new Error("minilfs is disabled for this run");
    const hint = "Fix the cause and run /minilfs retry, or switch to host mode (workspace_mode mode=host) to work on the folder directly.";
    if (startError) throw new Error(`minilfs failed to start: ${startError.message}. ${hint}`);
    if (!ready) throw new Error("minilfs has not started (no session)");
    return ready.catch((e) => { throw new Error(`minilfs failed to start: ${e.message}. ${hint}`); });
  }

  function report(ctx: ExtensionContext | undefined, s: LayerfsSession, r: { checkpoint: Checkpoint | null; error: Error | null }) {
    if (r.checkpoint) pi.appendEntry(CHECKPOINT_ENTRY, { ...r.checkpoint, project: s.project, branch: s.workBranch });
    status(ctx, describe(s));
    return r.error
      ? `\n\n[minilfs] The change is in the workspace but its checkpoint failed (${(r.error as any).code ?? "Error"}: ${r.error.message}). Further changes are blocked until /minilfs retry succeeds.`
      : "";
  }

  const recordSession = (s: LayerfsSession) =>
    pi.appendEntry(SESSION_ENTRY, { project: s.project, volume: s.volume, cwd: s.cwd, baseBranch: s.baseBranch, workBranch: s.workBranch, baseRef: s.baseRef, headCommit: s.headCommit });
  const recordMerge = (s: LayerfsSession, other: string, r: { head: string | null; branch: string }) => {
    if (r.head) pi.appendEntry(CHECKPOINT_ENTRY, { origins: [`merge:${other}`], label: "merge", commit: r.head, branch: r.branch, changed: true, at: Date.now(), project: s.project });
    recordSession(s);
  };
  const applicableDiff = async (s: LayerfsSession) => (await s.diff()).filter((i) => i.type !== "dir" && !hiddenPath(i.path) && s.isApplicable(i.path));

  const withNote = (result: any, note: string) =>
    note ? { ...result, content: [...(result.content ?? []), { type: "text", text: note }] } : result;

  // ------------------------------------------------------------- tools

  const ops = (s: LayerfsSession) => createHarnessOperations(s);

  pi.registerTool({
    ...local.read,
    async execute(id, params, signal, onUpdate) {
      if (onHostNow()) return onHost("read", id, params, signal, onUpdate);
      const s = await need();
      return createReadTool(s.cwd, { operations: ops(s).read }).execute(id, params, signal, onUpdate);
    },
  });

  for (const name of ["write", "edit", "bash"] as const) {
    pi.registerTool({
      ...local[name],
      async execute(id: string, params: any, signal: any, onUpdate: any, ctx: ExtensionContext) {
        if (onHostNow()) return onHost(name, id, params, signal, onUpdate);
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
      if (onHostNow()) return onHost("ls", id, params, signal, onUpdate);
      const s = await need();
      return createLsTool(s.cwd, { operations: ops(s).ls }).execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...local.find,
    async execute(id, params, signal, onUpdate) {
      if (onHostNow()) return onHost("find", id, params, signal, onUpdate);
      const s = await need();
      return createFindTool(s.cwd, { operations: ops(s).find }).execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...local.grep,
    async execute(id, params: any, signal, onUpdate) {
      if (onHostNow()) return onHost("grep", id, params, signal, onUpdate);
      const s = await need();
      const g = await s.grepWorkspace(params);
      if (g.matches === 0) return { content: [{ type: "text" as const, text: "No matches found" }], details: undefined };
      const limit = Math.max(1, params.limit ?? 100);
      const t = truncateHead(g.lines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
      const notes = [g.limitReached ? `${limit} matches limit reached` : "", t.truncated ? `${formatSize(DEFAULT_MAX_BYTES)} limit reached` : ""].filter(Boolean);
      return { content: [{ type: "text" as const, text: t.content + (notes.length ? `\n\n[${notes.join(". ")}]` : "") }], details: undefined };
    },
  });

  // ------------------------------------------------------------- workspace mode (branch | host)

  /** Switches mode for the agent tool and /minilfs mode; shows the result to the user. */
  async function changeMode(target: "branch" | "host" | "status", reason: string | undefined, discard: boolean, ctx: ExtensionContext | undefined, byUser = false) {
    if (target === "status") {
      const where = mode === "host"
        ? `host mode: tools act on ${hostCwd} directly.`
        : `branch mode${session?.workBranch ? ` on ${session.workBranch}` : ""}: tools act on the isolated Branch.`;
      return `${where} Host policy: ${policy}.`;
    }
    if (target === "host" && mode !== "host" && !byUser) {
      if (policy === "never") return "Refused: the host policy is \"never\"; the agent cannot leave the Branch. The user can switch with /minilfs mode host or /minilfs policy.";
      if (policy === "ask") {
        const c = ctx ?? lastCtx;
        if (!c?.hasUI) return "Refused: switching to host mode needs the user's approval and there is no UI. Start with --minilfs-host auto, or have the user run /minilfs mode host.";
        const ok = await c.ui.confirm("Let the agent work on your real folder (host mode)?",
          `${reason || "no reason given"}\n\nFile tools and bash will act directly on ${hostCwd}, without isolation, until the agent switches back.\nTo stop being asked: /minilfs policy auto`);
        if (!ok) return "The user declined host mode. Stay on the Branch, or ask the user what to do.";
      }
    }
    let s: LayerfsSession | null = null;
    // To host: do not wait behind a start still in progress (e.g. a long first import); use the
    // session only if it is already open. To branch: the Branch must exist, so wait for it.
    if (target === "host") s = openSession;
    else { try { s = await need(); } catch { s = null; } }
    const r = await switchMode(s, mode, target, { reason, discard, startError: startError?.message ?? null });
    if (r.ok && r.mode !== mode) {
      mode = r.mode;
      if (s) recordSession(s);
      pi.appendEntry(MODE_ENTRY, { mode, policy, reason: reason ?? "", at: Date.now() });
      const c = ctx ?? lastCtx;
      status(c, s ? describe(s) : mode === "host" ? "minilfs HOST mode · edits go to your folder" : undefined);
      if (c?.hasUI) c.ui.notify(`minilfs: ${r.message}`, mode === "host" ? "warning" : "info");
    }
    return r.message;
  }

  if (boot0().enabled) {
    pi.registerTool({
      name: MODE_TOOL_NAME,
      label: "workspace mode",
      description: MODE_TOOL_DESCRIPTION,
      parameters: MODE_TOOL_SCHEMA as any,
      async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: ExtensionContext) {
        if (disabled) return { content: [{ type: "text" as const, text: "minilfs is off for this run: tools already act on the user's folder." }], details: undefined };
        const text = await changeMode(params.mode, params.reason, Boolean(params.discard), ctx, false);
        return { content: [{ type: "text" as const, text }], details: undefined };
      },
    } as any);
  }

  // ------------------------------------------------------------- team mode (MINILFS_TEAM=1)
  const boot = resolveConfig();
  const isChild = process.env.PI_SUBAGENT_CHILD === "1";
  if (boot.team && boot.enabled) {
    const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });
    pi.registerTool({
      name: "minilfs",
      label: "minilfs",
      description: LAYERFS_TOOL_DESCRIPTION,
      parameters: LAYERFS_TOOL_SCHEMA as any,
      async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: ExtensionContext) {
        if (disabled) return text("minilfs is off for this run: there are no branches; tools act on the user's folder.");
        const s = await need();
        const out = await executeLayerfsAction(s, params, {
          onStatusChange: () => status(ctx, describe(s)),
          onMerged: (other, r) => recordMerge(s, other, r),
        });
        return text(out);
      },
    } as any);

    if (!isChild) {
      pi.registerTool({
        name: "minilfs_apply",
        label: "minilfs apply",
        description: LAYERFS_APPLY_TOOL_DESCRIPTION,
        parameters: LAYERFS_APPLY_TOOL_SCHEMA as any,
        async execute(_id: string, _params: any, _signal: any, _onUpdate: any, ctx: ExtensionContext) {
          if (disabled) return text("minilfs is off for this run: your edits are already in the user's folder.");
          const s = await need();
          const out = await executeLayerfsApply(s, {
            onStatusChange: () => status(ctx, describe(s)),
            onApplied: () => recordSession(s),
          });
          return text(out);
        },
      } as any);
    }
  }

  pi.on("user_bash", async (_event, ctx) => {
    if (onHostNow()) return undefined;
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
    disabled = !config.enabled || pi.getFlag("no-minilfs") === true;
    if (disabled) {
      status(ctx, "minilfs off");
      if (ctx.hasUI) ctx.ui.notify("minilfs isolation is OFF for this run: tools act directly on the host folder.", "warning");
      return;
    }
    if (session && event.reason === "reload") {
      status(ctx, describe(session));
      return;
    }
    lastCtx = ctx;
    const branchEntries = ctx.sessionManager.getBranch();
    const lastMode = [...branchEntries].reverse().find((e: any) => e.type === "custom" && e.customType === MODE_ENTRY) as any;
    policy = lastMode?.data?.policy ?? hostPolicy(process.env, pi.getFlag("minilfs-host"));
    mode = lastMode?.data?.mode === "host" || (!lastMode && policy === "bypass") ? "host" : initialMode();
    const branchInfo = inspectBranchEntries(branchEntries);
    const forkRef = event.reason === "fork" ? (pendingForkRef ?? branchInfo.headCommit ?? branchInfo.baseRef ?? null) : null;
    pendingForkRef = null;
    restart = () => start(ctx, event.reason, branchInfo, forkRef);
    // a retry after a fork reuses the fork ref; the pending one was consumed above
    start(ctx, event.reason, branchInfo, forkRef);
  });

  /** Re-runs a failed start (`/minilfs retry`), e.g. after ignoring large folders in .gitignore. */
  let restart: (() => void) | null = null;

  function start(ctx: ExtensionContext, reason: any, branchInfo: ReturnType<typeof inspectBranchEntries>, forkRef: string | null) {
    const config = resolveConfig();
    const event = { reason };
    const s = new LayerfsSession(ctx.cwd, ctx.sessionManager.getSessionId(), config);
    session = s;
    openSession = null;
    startError = null;
    // Show the phase and elapsed seconds, so a long first import is visible instead of a frozen "starting…".
    const t0 = Date.now();
    let phase = "starting…";
    const tick = () => { if (session === s) status(ctx, `minilfs ${phase} ${Math.round((Date.now() - t0) / 1000)}s`); };
    status(ctx, "minilfs starting…");
    const ticker = setInterval(tick, 1000);
    ticker.unref?.();
    ready = s.open({
      reason: event.reason,
      resumeBinding: branchInfo.project ? branchInfo : undefined,
      forkFromRef: forkRef,
      onPhase: (p) => { phase = p; tick(); },
    }).finally(() => clearInterval(ticker)).then(() => {
      pi.appendEntry(SESSION_ENTRY, {
        project: s.project, volume: s.volume, cwd: s.cwd,
        baseBranch: s.baseBranch, workBranch: s.workBranch, baseRef: s.baseRef, headCommit: s.headCommit,
      });
      if (session === s) openSession = s;
      status(ctx, describe(s));
      if (s.resumeLost && ctx.hasUI) ctx.ui.notify(`minilfs: ${s.resumeLost}.`, "warning");
      return s;
    }, (e) => {
      startError = e;
      status(ctx, "minilfs FAILED · /minilfs retry");
      if (ctx.hasUI) ctx.ui.notify(`minilfs failed to start: ${e.message}\nNothing is written to the host folder. Fix the cause, then /minilfs retry, or /minilfs mode host to work on the folder directly.`, "error");
      throw e;
    });
    ready.catch(() => {});
  }

  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason === "reload") return;
    const s = session;
    session = null;
    openSession = null;
    const r = ready;
    ready = null;
    if (!s) return;
    // Do not hold /resume, /new or quit behind a long first import: if start has not finished in
    // 2 s, mark the session closing (open stops at its next step) and close it when start settles.
    const settled = await Promise.race([r?.then(() => true, () => true) ?? true, new Promise((res) => setTimeout(() => res(false), 2000))]);
    if (!settled) {
      s.abortOpen();
      void r?.catch(() => {}).then(() => s.close()).catch(() => {});
      status(ctx, undefined);
      return;
    }
    const out = await s.close().catch((e) => ({ kept: true, notes: [`close failed: ${e.message}`] }));
    status(ctx, undefined);
    if (out.notes.length && ctx.hasUI) ctx.ui.notify(`minilfs: ${out.notes.join("; ")}`, out.kept ? "warning" : "info");
  });

  pi.on("before_agent_start", async (event) => {
    if (disabled) return undefined;
    if (mode === "host") {
      return { systemPrompt: `${event.systemPrompt}\n\nminilfs is in HOST mode: file tools and bash act directly on ${hostCwd}, without isolation; edits are immediate and not undoable. Switch back with workspace_mode mode=branch as soon as the host-only step is done.` };
    }
    const note = [
      "",
      "File tools and bash run on an isolated minilfs Branch of this project.",
      policy === "never"
        ? "You cannot leave the Branch (host policy: never). If a step cannot work here, tell the user."
        : `If a step cannot work on the Branch (nested sandbox, mounts, setuid/privileged tools, git operations on the user's repo, a long-running dev server, testing minilfs itself), switch with workspace_mode mode=host, then back to mode=branch.${policy === "ask" ? " The user approves each switch to host." : ""}`,
      `Paths under ${session?.cwd ?? "the working directory"} refer to that Branch; edits there do NOT reach the user's folder until the user runs /minilfs apply.`,
      "Files outside the working directory are read-only. Secret files such as .env are not imported.",
      "Each bash call runs in its own sandbox: background processes (`cmd &`, dev servers) end when that call ends. Start and use a server within one bash call.",
      ...(resolveConfig().team ? [
        isChild
          ? "Team mode: you work on your own branch. Use the `minilfs` tool (status/diff/sync); report your branch name from `minilfs status` when you finish. You cannot write the user's folder."
          : "Team mode: the `minilfs` tool merges other branches (e.g. sub-agents') into yours; `minilfs_apply` writes your branch into the user's folder and advances main, which new sub-agents start from.",
      ] : []),
    ].join("\n");
    return { systemPrompt: `${event.systemPrompt}\n${note}` };
  });

  // ------------------------------------------------------------- command

  const SUBCOMMANDS: Array<[string, string]> = [
    ["status", "当前分支、checkpoint 数、是否有未写回的改动"],
    ["diff", "列出本会话改了哪些文件"],
    ["history", "本会话的保存历史：每次改动、来自哪个工具、改了哪些文件（可加条数，如 history 50）"],
    ["apply", "把改动写回你的项目目录（有冲突则一个都不写；--revert 允许回退已写回的内容）"],
    ["sync", "把你在外面的改动同步进 LayerFS main（--full 全量重新校验）"],
    ["branches", "列出项目里所有分支"],
    ["merge", "把另一个分支（如子 agent 的分支）合并进本会话：merge <branch>"],
    ["retry", "checkpoint 失败被锁住后重试；启动失败（如目录太大）后重新启动"],
    ["clean", "清理本项目的 scratch 构建缓存目录"],
    ["mode", "切换工作位置：mode branch（隔离分支，默认）| mode host（直接在你的目录）| mode（查看）"],
    ["policy", "agent 能否自己切到 host：ask（默认，每次问你）| auto（自己切）| bypass（直接在 host 工作）| never"],
  ];

  pi.registerCommand("minilfs", {
    description: "minilfs workspace: status | diff | history | apply | merge | retry | sync | branches | clean | mode | policy",
    getArgumentCompletions: (prefix: string) => {
      const typed = prefix.trim();
      if (SUBCOMMANDS.some(([n]) => n === typed || typed.startsWith(`${n} `))) return null;
      const items = SUBCOMMANDS.filter(([n]) => n.startsWith(typed)).map(([value, description]) => ({ value, label: value, description }));
      return items.length ? items : null;
    },
    handler: async (args: string | undefined, ctx: ExtensionContext) => {
      const argv = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = argv[0] || "status";
      const say = (t: string, level: "info" | "warning" | "error" = "info") => (ctx.hasUI ? ctx.ui.notify(t, level) : console.log(t));
      if (disabled) return say("minilfs is off for this run.", "warning");
      if (sub === "mode") {
        const target = (argv[1] ?? "status") as any;
        if (!["branch", "host", "status"].includes(target)) return say("用法：/minilfs mode [branch|host] [--discard]", "warning");
        return say(await changeMode(target, "user command", argv.includes("--discard"), ctx, true));
      }
      if (sub === "policy") {
        const v = argv[1];
        if (!v) return say(`Host policy: ${policy} (ask | auto | bypass | never).`);
        if (!["ask", "auto", "bypass", "never"].includes(v)) return say("用法：/minilfs policy ask|auto|bypass|never", "warning");
        policy = v as HostPolicy;
        pi.appendEntry(MODE_ENTRY, { mode, policy, reason: "policy change", at: Date.now() });
        if (policy === "bypass" && mode !== "host") return say(`Host policy: bypass. ${await changeMode("host", "bypass permissions", argv.includes("--discard"), ctx, true)}`);
        return say(`Host policy: ${policy}.`);
      }
      if (sub === "retry" && startError && restart) {
        say("Restarting minilfs…");
        restart();
        try { await need(); } catch (e: any) { return say(e.message, "error"); }
        return say("minilfs started.");
      }
      let s: LayerfsSession;
      try { s = await need(); } catch (e: any) { return say(e.message, "error"); }
      if (sub === "status") {
        return say([
          describe(s),
          `project ${s.project} · volume ${s.volume}`,
          `branch ${s.workBranch} (alias: ${s.logicalBranch}, base ${s.baseBranch} @ ${s.baseRef.slice(0, 12)}) · head ${(s.headCommit ?? "none").slice(0, 12)}`,
          s.blocked ? `blocked: ${s.blocked.reason}` : "",
        ].filter(Boolean).join("\n"));
      }
      if (sub === "history") {
        const n = Number(argv[1] ?? 20);
        const limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : 20;
        return say(formatHistory(await loadHistory(s, limit)));
      }
      if (sub === "branches") {
        const list = await s.listUserBranches();
        return say(list.map((b) => `${b.name.padEnd(20)} ${(b.logicalBranch ? `[${b.logicalBranch}]` : "").padEnd(14)} head ${(b.head ?? "-").slice(0, 12)} base ${(b.base ?? "-").slice(0, 12)}`).join("\n"));
      }
      if (sub === "merge") {
        const otherParam = argv[1];
        if (!otherParam) return say("用法：/minilfs merge <branch> [--ours|--theirs]（分支名见 /minilfs branches）", "warning");
        const strategy = argv.includes("--theirs") ? "theirs" : argv.includes("--ours") ? "ours" : undefined;
        const other = await s.resolveBranchName(otherParam);
        const r = await s.mergeBranch(other, strategy ? { strategy } : undefined);
        status(ctx, describe(s));
        if (!r.merged) return say([`Conflict merging ${other}; nothing changed. Conflicting files:`, ...r.conflicts.map((c) => `  ${c.path}${c.kind ? ` (${c.kind})` : ""}`)].join("\n"), "error");
        recordMerge(s, other, r);
        const lwwInfo = r.lww ? (r.lwwPaths?.length ? `, ${r.lww} generated file(s) took the newer side: ${r.lwwPaths.slice(0, 5).join(", ")}${r.lwwPaths.length > 5 ? ", …" : ""}` : `, ${r.lww} generated file(s) took the newer side`) : "";
        return say(`Merged ${other} into this session (now on ${r.branch}${lwwInfo}). /minilfs diff to review, /minilfs apply to write to your folder.`);
      }
      if (sub === "diff") {
        if (argv[1]) {
          const targetBranch = await s.resolveBranchName(argv[1]);
          let baseBranch = s.baseBranch;
          if (argv[2]) {
            baseBranch = await s.resolveBranchName(argv[2]);
          } else if (targetBranch !== "main") {
            const bInfo = (await s.listAllBranches()).find((b) => b.name === targetBranch);
            if (bInfo?.base) {
              baseBranch = `h-${bInfo.base.slice(0, 20)}`;
              await s.lfs.branch.fork(baseBranch, bInfo.base).catch(() => {});
            }
          }
          const all: Array<{ path: string; kind: string; type: string }> = [];
          for (let pos = 0; ; ) {
            const page = await s.lfs.branch.diff_branches(baseBranch, targetBranch, 1000, pos, { hunks: false });
            for (const it of page.items ?? []) {
              if (it.path === "/.lww" || !it.path || it.type === "dir" || hiddenPath(it.path)) continue;
              all.push({ path: it.path, kind: it.kind, type: it.type });
            }
            if (!page.hasMore || !(page.items ?? []).length) break;
            pos = page.nextPagePos ?? (pos + page.items.length);
          }
          const d = all.filter((i) => s.isApplicable(i.path));
          return say(d.length ? d.map((i) => `${i.kind.padEnd(8)} ${i.path.replace(/^\//, "")}`).join("\n") : `No changes between ${baseBranch} and ${targetBranch}.`);
        }
        const d = await applicableDiff(s);
        return say(d.length ? d.map((i) => `${i.kind.padEnd(8)} ${i.path.replace(/^\//, "")}`).join("\n") : "No changes in the minilfs workspace.");
      }
      if (sub === "sync") {
        const res = await s.syncHostDriftIntoMain({ full: argv.includes("--full") });
        return say(res.synced.length ? `Synced ${res.synced.length} host file(s) into main: ${res.synced.join(", ")}` : "Host folder is already in sync with main.");
      }
      if (sub === "retry") {
        const r = await s.retry();
        report(ctx, s, r);
        return say(r.error ? `Retry failed: ${r.error.message}` : "Checkpoint saved; changes are unblocked.", r.error ? "error" : "info");
      }
      if (sub === "clean") {
        const res = await s.cleanScratch();
        return say(`Cleaned scratch build caches at ${res.removedPath}.`);
      }
      if (sub === "apply") {
        const allowRevert = argv.includes("--revert");
        const d = await applicableDiff(s);
        if (!d.length) return say("Nothing to apply.");
        if (ctx.hasUI && !(await ctx.ui.confirm("Apply minilfs changes to your folder?", d.map((i) => `${i.kind} ${i.path}`).slice(0, 40).join("\n")))) return say("Apply cancelled.");
        let r;
        try {
          r = await s.apply({ allowRevert });
        } catch (e: any) {
          status(ctx, describe(s));
          const partial = e?.result as { applied: string[]; conflicts: string[] } | undefined;
          if (e?.code === "WouldRevert") return say(e.message, "warning");
          return say([
            `Apply stopped: ${e?.message ?? e}`,
            partial?.applied.length ? `Already written to your folder: ${partial.applied.join(", ")}` : "Nothing was written to your folder.",
            partial?.conflicts.length ? `Changed on disk during apply: ${partial.conflicts.join(", ")}` : "",
          ].filter(Boolean).join("\n"), "error");
        }
        if (r.conflicts.length) return say(`Nothing applied: these files changed on disk since the session started (or are directories now):\n${r.conflicts.join("\n")}`, "error");
        status(ctx, describe(s));
        return say([
          `Applied ${r.applied.length} change(s) to ${s.cwd}.`,
          r.skipped.length ? `Skipped (never applied): ${r.skipped.filter((p) => !hiddenPath(p)).join(", ") || "git metadata"}` : "",
          ...r.warnings.map((w) => `Warning: ${w}`),
          s.unapplied ? "Changes made while applying are still pending: run /minilfs apply again." : "",
        ].filter(Boolean).join("\n"), r.warnings.length ? "warning" : "info");
      }
      return say([`未知子命令 "${sub}"。可用：`, ...SUBCOMMANDS.map(([n, d]) => `  /minilfs ${n.padEnd(9)} ${d}`)].join("\n"), "warning");
    },
  });
}
