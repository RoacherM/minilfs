// Pluggable ExecutionDriver seam for `minilfs`:
// Separates the LayerFS branch/DAG/checkpoint state machine (`LayerfsSession`) from where
// mounted workspace commands actually execute:
//   - `LocalNativeDriver` (default): macOS native NFSv3 loopback + Seatbelt (`sandbox-exec`),
//     with built-in `cd <hostCwd>` redirection, macOS `timeout` shim, and per-branch APFS scratch.
//   - `RemoteSandboxDriver` (extensible seam): route `execInWorkspace` to remote/distributed
//     sandbox workers (Cloudflare Sandbox, E2B, Modal, SSH/RPC cluster nodes) without changing
//     any upper-layer agent tool, MCP, or CLI call.
import { spawn } from "node:child_process";
import { constants as fsc, existsSync, promises as fsp, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LayerfsConfig } from "../config.ts";
import { bothSpellings, buildSeatbeltProfile } from "../seatbelt.ts";
import { killAll, leftovers, listOwnProcesses, nowUs } from "./proc-scan.ts";

/** After the shell exits, how long its output may keep draining before the pipe is cut. */
const PIPE_DRAIN_MS = 2000;
import { ensureBundle, missingBundleFiles } from "../bundle.ts";
import type { Workspace } from "../workspace.ts";
import { run } from "./exec-helper.ts";
import { ensurePsShim } from "./ps-shim.ts";

export interface DriverExecOptions {
  onData: (chunk: Buffer) => void;
  signal?: AbortSignal;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}

export interface DriverExecContext {
  ws: Workspace;
  wsReal: string;
  hostCwd: string;
  runCwd: string;
  scratchDir: string;
  branchScratchDir: string;
  sharedCacheDir: string;
  config: LayerfsConfig;
  projectName: string;
  logicalBranch: string;
  outsideSecrets: string[];
  lwwContent: string;
  command: string;
  options: DriverExecOptions;
}

export interface ExecutionDriver {
  readonly name: string;
  preflight(config: LayerfsConfig): Promise<string>;
  execInWorkspace(ctx: DriverExecContext): Promise<{ exitCode: number | null }>;
  reapWorkspaceHolders(wsReal: string): Promise<void>;
  stopDaemons?(localDir?: string): Promise<void>;
}

/**
 * Shell prelude injected into every `LocalNativeDriver` bash execution:
 * 1. Transparently redirects `cd <hostCwd>` (and any subpath under `<hostCwd>`) into the mounted
 *    LayerFS branch workspace (`$MINILFS_WS_REAL`), preventing agents from accidentally escaping
 *    into the read-only host project folder.
 * 2. Provides a POSIX/bash `timeout` function on macOS hosts where GNU `timeout` is not installed.
 */
export function buildNativeShellPrelude(hostCwd: string, wsReal: string): string {
  const hostSpellings = bothSpellings(hostCwd);
  const caseBranches = hostSpellings
    .map((h) => {
      const q = h.replace(/'/g, "'\\''");
      return `      '${q}') builtin cd "$MINILFS_WS_REAL" ;;\n      '${q}'/*) builtin cd "$MINILFS_WS_REAL/\${_target#'${q}'/}" ;;`;
    })
    .join("\n");

  return [
    `export MINILFS_HOST_CWD=${JSON.stringify(hostCwd)}`,
    `export MINILFS_WS_REAL=${JSON.stringify(wsReal)}`,
    `cd() {`,
    `  if [ $# -eq 0 ]; then builtin cd "$MINILFS_WS_REAL"; return $?; fi`,
    `  local _target="$1"`,
    `  if [ "$_target" = "-P" ] || [ "$_target" = "-L" ]; then`,
    `    shift`,
    `    _target="\${1:-$MINILFS_WS_REAL}"`,
    `  fi`,
    `  case "$_target" in`,
    caseBranches,
    `      *) builtin cd "$@" ;;`,
    `  esac`,
    `}`,
    `if ! command -v timeout >/dev/null 2>&1; then`,
    `  timeout() {`,
    `    local _dur=""`,
    `    while [ $# -gt 0 ]; do`,
    `      case "$1" in`,
    `        -k|-s) shift 2 ;;`,
    `        -*) shift ;;`,
    `        *) _dur="$1"; shift; break ;;`,
    `      esac`,
    `    done`,
    `    [ -n "$_dur" ] || return 125`,
    `    _dur="\${_dur%s}"`,
    // the command leads its own process group (perl setpgrp, then exec), so the timeout stops its
    // children too (cargo test spawns the test binary); the watchdog holds no pipe and exits with it
    `    /usr/bin/perl -e 'setpgrp(0, 0); exec @ARGV or exit 127' "$@" &`,
    `    local _cpid=$!`,
    // the watchdog leaves a marker just before it kills: 124 means "timeout fired", never the
    // command's own 143/137 (a command that kills itself)
    `    local _mark="\${TMPDIR:-/tmp}/.minilfs-timeout.$$.$_cpid"`,
    `    rm -f "$_mark"`,
    `    ( exec </dev/null >/dev/null 2>&1; sleep "$_dur" & _s=$!; trap 'kill -KILL $_s 2>/dev/null; exit 0' TERM; wait $_s && : > "$_mark" && kill -TERM -- "-$_cpid" "$_cpid" 2>/dev/null && sleep 1 && kill -KILL -- "-$_cpid" "$_cpid" 2>/dev/null ) &`,
    `    local _wpid=$!`,
    `    wait "$_cpid" 2>/dev/null`,
    `    local _rc=$?`,
    `    kill -TERM "$_wpid" 2>/dev/null || true`,
    `    wait "$_wpid" 2>/dev/null || true`,
    `    kill -KILL -- "-$_cpid" 2>/dev/null || true`,
    `    if [ -e "$_mark" ]; then rm -f "$_mark"; return 124; fi`,
    `    return $_rc`,
    `  }`,
    `fi`,
  ].join("\n");
}

/**
 * Default macOS Native Driver:
 * - In-process `layerfs.node` + local `layerfs-daemon` (loopback NFSv3 + `/sbin/mount_nfs`)
 * - Claude Code (`srt`)-style Seatbelt (`sandbox-exec`) isolation
 * - Per-branch APFS scratch & shared cache directories
 */
export class LocalNativeDriver implements ExecutionDriver {
  readonly name = "native";

  async preflight(config: LayerfsConfig): Promise<string> {
    const problems: string[] = [];
    const fetchProblem = await ensureBundle(config.bundle).catch((e) => `installing the LayerFS bundle failed: ${e?.message ?? e}`);
    for (const f of await missingBundleFiles(config.bundle)) problems.push(`missing ${f}`);
    // a missing file reports the download problem too; a complete bundle of another LayerFS commit is a problem by itself
    if (fetchProblem && (problems.length || /needs [0-9a-f]{12}/.test(fetchProblem))) problems.push(fetchProblem);
    const mountBin = config.nfsMount ? config.nfsMount.trim().split(/\s+/)[0] : "/sbin/mount_nfs";
    for (const bin of [mountBin, "/usr/bin/sandbox-exec"]) {
      try {
        await fsp.access(bin, fsc.X_OK);
      } catch {
        problems.push(`missing or non-executable ${bin}`);
      }
    }
    if (problems.length) {
      const err = new Error(`LayerFS is not available: ${problems.join("; ")}`);
      (err as any).code = "Preflight";
      throw err;
    }
    return "native";
  }

  async execInWorkspace(ctx: DriverExecContext): Promise<{ exitCode: number | null }> {
    const {
      wsReal,
      hostCwd,
      runCwd,
      scratchDir,
      branchScratchDir,
      sharedCacheDir,
      config,
      outsideSecrets,
      lwwContent,
      command,
      options,
    } = ctx;

    await fsp.mkdir(branchScratchDir, { recursive: true });
    await fsp.mkdir(sharedCacheDir, { recursive: true });

    const profile = buildSeatbeltProfile({
      wsPath: wsReal,
      hostCwd,
      scratchDir,
      configRoot: config.root,
      excludes: config.excludes,
      outsideSecrets,
      network: config.network,
    });

    // first on PATH: a `ps` that works inside the sandbox (/bin/ps is setuid and cannot run here)
    const shimDir = await ensurePsShim(scratchDir).catch(() => null);
    const basePath = process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
    const pathParts = [shimDir, basePath].filter(Boolean);
    const childEnv: NodeJS.ProcessEnv = {
      HOME: homedir(),
      PATH: pathParts.join(":"),
      TMPDIR: "/private/tmp",
      USER: process.env.USER || "user",
      LOGNAME: process.env.LOGNAME || "user",
      MINILFS_SCRATCH_DIR: branchScratchDir,
      MINILFS_SHARED_CACHE_DIR: sharedCacheDir,
    };
    for (const [k, v] of Object.entries(options.env ?? process.env)) {
      if (typeof v === "string" && (k.startsWith("PI_") || k.startsWith("MINILFS_") || config.envAllow.includes(k))) {
        childEnv[k] = v;
      }
    }
    // No LAYERFS_* settings: the Stores under configRoot are denied in the sandbox, so the layerfs
    // CLI or SDK could not work there; the agent's Branch tools are the `minilfs` tool and apply.

    const prelude = buildNativeShellPrelude(hostCwd, wsReal);
    const wrappedCommand = `${prelude}\n${command}`;

    // taken before the spawn: everything the call starts is at or after it (proc-scan.ts)
    const startedUs = nowUs();
    const child = spawn(
      "/usr/bin/sandbox-exec",
      ["-p", profile, "/bin/bash", "-c", wrappedCommand],
      { cwd: runCwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"], detached: true },
    );
    child.stdout.on("data", options.onData);
    child.stderr.on("data", options.onData);
    // the call's processes may be found under these roots after the shell is gone (see proc-scan.ts);
    // not sharedCacheDir: every session of the project uses it
    const roots = [...new Set([wsReal, branchScratchDir].flatMap((p) => bothSpellings(p)))];

    let stopping: Promise<void> | null = null;
    const kill = () => (stopping ??= this.killProcessGroup(child, wsReal, config.killGraceMs));

    // the caller's limit (Pi's bash `timeout`), else the overall limit every call has
    const limitS = Math.min(options.timeout && options.timeout > 0 ? options.timeout : Infinity, config.bashTimeoutS ?? 600);
    let timedOut = false;
    const timer = Number.isFinite(limitS)
      ? setTimeout(() => {
          timedOut = true;
          void kill();
        }, limitS * 1000)
      : undefined;
    const onAbort = () => void kill();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) void kill();

    try {
      // Resolve when the shell exits, not when the pipe closes: a descendant that outlives the shell
      // (a background server, a test binary in its own session) would hold the pipe, and the call,
      // open forever. Its output after a short drain is dropped, and it is killed below.
      const code = await new Promise<number | null>((resolveCode, reject) => {
        child.on("error", reject);
        // each stream reports its own end; one may have closed before the shell exited
        const closed = (st: NodeJS.ReadableStream & { closed?: boolean; destroyed?: boolean }) =>
          st.closed || st.destroyed ? Promise.resolve() : new Promise<void>((r) => st.once("close", () => r()));
        const streams = Promise.all([closed(child.stdout), closed(child.stderr)]);
        child.once("exit", (c) => {
          const cut = setTimeout(() => {
            child.stdout.destroy();
            child.stderr.destroy();
            resolveCode(c);
          }, PIPE_DRAIN_MS);
          void streams.then(() => { clearTimeout(cut); resolveCode(c); });
        });
      });
      if (stopping) await stopping;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
      await this.reapWorkspaceHolders(wsReal).catch(() => {});
      await this.reapLeftovers(child.pid, startedUs, roots).catch(() => {});

      const lwwFile = join(wsReal, ".lww");
      if (!existsSync(lwwFile)) {
        writeFileSync(lwwFile, lwwContent);
      }

      if (options.signal?.aborted) throw new Error("aborted");
      if (timedOut) {
        if (options.timeout && options.timeout <= limitS) throw new Error(`timeout:${options.timeout}`);
        // minilfs's own limit: report it with the output so far, as a failed command
        options.onData(Buffer.from(`\n[minilfs] the command ran longer than ${limitS} s (MINILFS_BASH_TIMEOUT_S); it and the processes it started were stopped.\n`));
        return { exitCode: 124 };
      }
      return { exitCode: code };
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
    }
  }

  /** Kills what a call left running outside its process group (see proc-scan.ts). */
  private async reapLeftovers(pgid: number | undefined, sinceUs: number, roots: string[]): Promise<void> {
    const rows = await listOwnProcesses();
    killAll(leftovers(rows, { pgid, sinceUs, roots }).map((r) => r.pid));
  }

  private async killProcessGroup(child: ReturnType<typeof spawn>, wsReal: string, killGraceMs: number): Promise<void> {
    const pid = child.pid;
    if (!pid) return;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {}
    }
    const grace = Math.max(100, killGraceMs);
    const start = Date.now();
    let alive = true;
    while (Date.now() - start < grace) {
      await new Promise((r) => setTimeout(r, 50));
      try {
        process.kill(-pid, 0);
      } catch {
        alive = false;
        break;
      }
    }
    if (alive) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    }
    await this.reapWorkspaceHolders(wsReal).catch(() => {});
  }

  async reapWorkspaceHolders(wsReal: string): Promise<void> {
    const spellings = bothSpellings(wsReal);
    for (const p of spellings) {
      // `lsof <mount point>` lists every process using that file system without walking it;
      // `+D` walked the whole tree over NFS before every unmount (1 s per 20k files).
      const r = await run("lsof", ["-t", p], { timeoutMs: 5000 }).catch(() => null);
      if (r?.stdout && r.stdout.length > 0) {
        const pids = r.stdout.toString().split(/\s+/).filter(Boolean);
        for (const pid of pids) {
          const n = Number(pid);
          if (n > 0 && n !== process.pid) {
            try {
              process.kill(n, "SIGKILL");
            } catch {}
          }
        }
      }
    }
  }

  async stopDaemons(localDir?: string): Promise<void> {
    const pattern = localDir ? `layerfs-daemon --config ${localDir}/` : "layerfs-daemon --config ";
    const r = await run("pgrep", ["-f", pattern]).catch(() => null);
    if (r?.code === 0 && r.stdout.length > 0) {
      const pids = r.stdout.toString().split(/\s+/).filter(Boolean);
      for (const pid of pids) {
        const n = Number(pid);
        if (n > 0 && n !== process.pid) {
          try {
            process.kill(n, "SIGTERM");
          } catch {}
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

const customDrivers = new Map<string, ExecutionDriver>();

/**
 * Registers a custom or remote/distributed Sandbox ExecutionDriver (e.g. "remote", "cloudflare", "e2b", "modal").
 */
export function registerExecutionDriver(name: string, driver: ExecutionDriver): void {
  customDrivers.set(name, driver);
}

export function resolveExecutionDriver(name = "native"): ExecutionDriver {
  if (name === "native") return new LocalNativeDriver();
  const custom = customDrivers.get(name);
  if (!custom) {
    throw new Error(`Unknown execution driver "${name}". Register it via registerExecutionDriver("${name}", driver) first.`);
  }
  return custom;
}
