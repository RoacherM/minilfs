// Pluggable ExecutionDriver seam for `minilfs`:
// Separates the LayerFS branch/DAG/checkpoint state machine (`LayerfsSession`) from where
// mounted workspace commands actually execute:
//   - `LocalNativeDriver` (default): macOS native NFSv3 loopback + Seatbelt (`sandbox-exec`),
//     with built-in `cd <hostCwd>` redirection, macOS `timeout` shim, and per-branch APFS scratch.
//   - `RemoteSandboxDriver` (extensible seam): route `execInWorkspace` to remote/distributed
//     sandbox workers (Cloudflare Sandbox, E2B, Modal, SSH/RPC cluster nodes) without changing
//     any upper-layer agent tool, MCP, or CLI call.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as fsc, existsSync, promises as fsp, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LayerfsConfig } from "../config.ts";
import { bothSpellings, buildSeatbeltProfile } from "../seatbelt.ts";
import type { Workspace } from "../workspace.ts";
import { run } from "./exec-helper.ts";

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
    `    "$@" &`,
    `    local _cpid=$!`,
    `    ( sleep "$_dur" 2>/dev/null && kill -TERM "$_cpid" 2>/dev/null && sleep 1 && kill -KILL "$_cpid" 2>/dev/null ) >/dev/null 2>&1 &`,
    `    local _wpid=$!`,
    `    wait "$_cpid" 2>/dev/null`,
    `    local _rc=$?`,
    `    kill -KILL "$_wpid" 2>/dev/null || true`,
    `    wait "$_wpid" 2>/dev/null || true`,
    `    if [ $_rc -eq 143 ] || [ $_rc -eq 137 ]; then return 124; fi`,
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
  private activeKills = new Map<string, () => Promise<void>>();

  async preflight(config: LayerfsConfig): Promise<string> {
    const problems: string[] = [];
    for (const f of ["layerfs.node", "layerfs-daemon", "sdk/js/src/index.js"]) {
      try {
        await fsp.access(join(config.bundle, f), fsc.R_OK);
      } catch {
        problems.push(`missing ${join(config.bundle, f)}`);
      }
    }
    for (const bin of ["/sbin/mount_nfs", "/usr/bin/sandbox-exec"]) {
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

    const childEnv: NodeJS.ProcessEnv = {
      HOME: homedir(),
      PATH: process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
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

    const prelude = buildNativeShellPrelude(hostCwd, wsReal);
    const wrappedCommand = `${prelude}\n${command}`;

    const child = spawn(
      "/usr/bin/sandbox-exec",
      ["-p", profile, "/bin/bash", "-c", wrappedCommand],
      { cwd: runCwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"], detached: true },
    );
    child.stdout.on("data", options.onData);
    child.stderr.on("data", options.onData);

    const tag = randomBytes(6).toString("hex");
    let stopping: Promise<void> | null = null;
    const kill = () => (stopping ??= this.killProcessGroup(child, wsReal, config.killGraceMs));
    this.activeKills.set(tag, kill);

    let timedOut = false;
    const timer =
      options.timeout && options.timeout > 0
        ? setTimeout(() => {
            timedOut = true;
            void kill();
          }, options.timeout * 1000)
        : undefined;
    const onAbort = () => void kill();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) void kill();

    try {
      const code = await new Promise<number | null>((resolveCode, reject) => {
        child.on("error", reject);
        child.on("close", (c) => resolveCode(c));
      });
      if (stopping) await stopping;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
      await this.reapWorkspaceHolders(wsReal).catch(() => {});

      const lwwFile = join(wsReal, ".lww");
      if (!existsSync(lwwFile)) {
        writeFileSync(lwwFile, lwwContent);
      }

      if (options.signal?.aborted) throw new Error("aborted");
      if (timedOut) throw new Error(`timeout:${options.timeout}`);
      return { exitCode: code };
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      this.activeKills.delete(tag);
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
    }
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
      const r = await run("lsof", ["-t", "+D", p], { timeoutMs: 5000 }).catch(() => null);
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
