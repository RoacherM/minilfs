// The minilfs Store worker, client side: find the root's running worker or start one, so every
// Pi process of a minilfs root (the lead and its sub-agents) makes its Store calls in one process.
// The worker itself is src/store-worker.mjs; the design is docs/DESIGN-store-worker.md.
//
// One worker per root and build. The build names the LayerFS commit, the bundle and the NFS mount
// helper, so two minilfs versions on one root never talk to a worker of the other: each gets its
// own (they then share the Store the old way, protected by the Busy retry in client.ts).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, truncateSync } from "node:fs";
import { connect } from "node:net";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { acquireLock, alive } from "../lock.ts";
import { procStartTime } from "./proc-scan.ts";

export interface WorkerEndpoint { home: string; port: number; secret: string; build: string; pid: number; startedAt?: number; startSec?: number; startUsec?: number }

const SCRIPT = fileURLToPath(new URL("../store-worker.mjs", import.meta.url));
const READY_MS = 15_000;
/** A busy worker (a long call on its thread pool) answers a ping late; this long is not stuck. */
const PING_MS = 3000;
/** Stuck = this many missed pings, PING_GAP_MS apart, over at least STUCK_MS. */
const STUCK_PINGS = 3, PING_GAP_MS = 500, STUCK_MS = 6000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LOG_LIMIT = 5 * 1024 * 1024;

/** The worker's folder for this root and build: <root>/worker/<build>. */
export function workerDir(root: string, build: string): string {
  return join(root, "worker", build);
}

/** A short id of what the worker loads: LayerFS commit, bundle path, NFS mount helper. */
export function workerBuild(bundle: string, commit: string, nfsMount?: string): string {
  return `${commit.slice(0, 7)}-${createHash("sha256").update(`${bundle}\0${nfsMount ?? ""}`).digest("hex").slice(0, 8)}`;
}

function readEndpoint(file: string): WorkerEndpoint | null {
  try {
    const e = JSON.parse(readFileSync(file, "utf8"));
    return Number.isInteger(e.port) && /^[0-9a-f]{64}$/.test(e.secret ?? "") ? e : null;
  } catch {
    return null;
  }
}

let frames: Promise<{ frame: (v: unknown) => Buffer; readFrames: (...a: any[]) => void }> | null = null;
const framesOf = (bundle: string) => (frames ??= import(pathToFileURL(join(bundle, "api/agent/sdk/src/internal.js")).href));

/** The worker's ping answer ({ ready, build, pid, ... }) within `ms`, else null. */
export async function pingWorker(bundle: string, e: WorkerEndpoint, ms = PING_MS): Promise<any | null> {
  const { frame, readFrames } = await framesOf(bundle);
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: e.port });
    const done = (v: any) => { clearTimeout(timer); socket.destroy(); resolve(v); };
    const timer = setTimeout(() => done(null), ms);
    socket.on("connect", () => socket.write(frame({ secret: e.secret })));
    readFrames(socket, ({ id, answer }: any) => {
      if (id === 0 && answer?.value === "hello") socket.write(frame({ id: 1, fn: "ping" }));
      else done(id === 1 ? answer?.value ?? null : null);
    }, () => done(null));
    socket.on("error", () => done(null));
    socket.on("close", () => done(null));
  });
}

/**
 * The endpoint's pid is still that worker: alive, the start time it recorded, a node executable,
 * its cwd the worker's folder. A reused pid (another program, or a later process) never matches;
 * an endpoint without a start time (older worker) cannot be checked and does not match either.
 */
function isWorkerProcess(e: WorkerEndpoint, dir: string): boolean {
  if (!e.pid || e.startSec === undefined || e.startUsec === undefined || !alive(e.pid)) return false;
  const p = procStartTime(e.pid);
  if (!p || p.startSec !== e.startSec || p.startUsec !== e.startUsec || !/node/i.test(basename(p.exe))) return false;
  try { return p.cwd === realpathSync(dir); } catch { return false; }
}

/** SIGTERM, then SIGKILL after 2 s, each only while the pid is still that worker. */
async function stopWorkerProcess(e: WorkerEndpoint, dir: string): Promise<void> {
  // seconds of pings passed since it was identified: the pid may be another process by now
  if (!isWorkerProcess(e, dir)) return;
  try { process.kill(e.pid, "SIGTERM"); } catch { return; }
  for (const until = Date.now() + 2000; Date.now() < until; ) {
    await sleep(100);
    if (!isWorkerProcess(e, dir)) return;
  }
  if (isWorkerProcess(e, dir)) try { process.kill(e.pid, "SIGKILL"); } catch {}
}

/** Node to run the worker with: this process's when it is node, else `node` on PATH. */
function nodeBinary(): string {
  return /node/i.test(basename(process.execPath)) ? process.execPath : "node";
}

/**
 * The endpoint file of the root's running worker, started when none answers. Starts at most one
 * per root and build (a lock), and replaces a worker that died or stopped answering.
 */
export async function ensureWorker(opts: { root: string; home: string; bundle: string; build: string; nfsMount?: string; log?: (m: string) => void }): Promise<string> {
  const dir = workerDir(opts.root, opts.build);
  const file = join(dir, "endpoint.json");
  const answering = async () => {
    const e = readEndpoint(file);
    return e && e.home === opts.home && (await pingWorker(opts.bundle, e))?.ready ? e : null;
  };
  if (await answering()) return file;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = await acquireLock(join(dir, "start.lock"), READY_MS * 2);
  try {
    if (await answering()) return file; // another process started it while we waited
    // a worker that runs but does not answer may be busy: replace it only when it misses pings for
    // a while, and signal it only when the pid is still that worker (else just start a new one)
    const stale = readEndpoint(file);
    if (stale && stale.home === opts.home && isWorkerProcess(stale, dir)) {
      const t0 = Date.now();
      for (let missed = 0; ; ) {
        if ((await pingWorker(opts.bundle, stale))?.ready) return file;
        if (++missed >= STUCK_PINGS && Date.now() - t0 >= STUCK_MS) break;
        await sleep(PING_GAP_MS);
      }
      opts.log?.(`store worker ${stale.pid} does not answer; replacing it`);
      await stopWorkerProcess(stale, dir);
    }
    const logFile = join(dir, "worker.log");
    try { if (statSync(logFile).size > LOG_LIMIT) truncateSync(logFile, 0); } catch {}
    const fd = openSync(logFile, "a", 0o600);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, TMPDIR: process.env.TMPDIR,
      // what the native addon reads from the process (mounts, daemons)
      LAYERFS_SANDBOX: "native",
      LAYERFS_NATIVE: join(opts.bundle, "layerfs.node"),
      ...(opts.nfsMount ? { LAYERFS_NFS_MOUNT: opts.nfsMount } : {}),
    };
    // MINILFS_WORKER_IDLE_MS: how long the worker waits with no client before it exits (default 10 min)
    const idle = process.env.MINILFS_TEST_WORKER_IDLE_MS || process.env.MINILFS_WORKER_IDLE_MS;
    const child = spawn(nodeBinary(), [SCRIPT, "--dir", dir, "--home", opts.home, "--bundle", opts.bundle, "--build", opts.build, ...(idle ? ["--idle-ms", idle] : [])], {
      detached: true, stdio: ["ignore", fd, fd], env, cwd: dir,
    });
    closeSync(fd);
    child.unref();
    const startedPid = child.pid;
    for (const until = Date.now() + READY_MS; ;) {
      const e = await answering();
      if (e && e.pid === startedPid) break;
      if (startedPid && !alive(startedPid)) throw new Error(`the minilfs store worker exited at start; see ${logFile}`);
      if (Date.now() > until) throw new Error(`the minilfs store worker did not answer within ${READY_MS / 1000} s; see ${logFile}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    opts.log?.(`store worker ${startedPid} started for ${opts.root} (build ${opts.build})`);
    return file;
  } finally {
    lock.release();
  }
}

/** Stops every store worker of `root` (all builds); for close(stopDaemons) and test cleanup. */
export function stopWorkers(root: string): void {
  const base = join(root, "worker");
  let builds: string[] = [];
  try { builds = readdirSync(base); } catch { return; }
  for (const b of builds) {
    const e = readEndpoint(join(base, b, "endpoint.json"));
    // only the worker itself, never a process that reused its pid
    if (e?.pid && e.pid !== process.pid && isWorkerProcess(e, join(base, b))) {
      try { process.kill(e.pid, "SIGTERM"); } catch {}
    }
  }
}

/** The minilfs root of a spec (its home is <root>/home). */
export const rootOfHome = (home: string) => dirname(home);
