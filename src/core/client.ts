// The official LayerFS v1.1.0 (#428 + #427) JavaScript SDK, loaded from the bundle:
//   @layerfs/agent (api/agent/sdk/src/index.js): LayerFS, LayerFSError, INIT_TIMEOUT_MS
// @layerfs/agent has no public constructor and takes no options object: `LayerFS.open(name)` and
// `LayerFS.init(name, folder, timeout?)` read every setting from `process.env.LAYERFS_*` once, when
// they make the client. We set the project's variables for exactly that call, then restore them, so
// one process can hold clients of several projects.
import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { LayerfsConfig } from "../config.ts";
import { LAYERFS_COMMIT } from "../bundle.ts";
import { ensureWorker, workerBuild } from "./worker.ts";

export interface NativeSpec {
  home: string;
  bundle: string;
  prefix: string;
  localDir: string;
  stores: string;
  nfsMount?: string;
  /** the minilfs root (its store worker lives in <root>/worker) */
  root: string;
  /** Store calls through the root's store worker (default) or in this process (`MINILFS_STORE_WORKER=0`) */
  storeWorker: boolean;
}

export interface ProjectClient {
  /** the @layerfs/agent client of this project */
  lfs: any;
  LayerFSError: any;
}

export function ensureNativeDirs(config: LayerfsConfig): NativeSpec {
  const home = join(config.root, "home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // the native runtime refuses a local root that is group/other writable or not traversable (0755)
  const localDir = join(config.root, "local");
  mkdirSync(localDir, { recursive: true, mode: 0o755 });
  try { chmodSync(localDir, 0o755); } catch {}
  const stores = join(config.root, "stores");
  mkdirSync(stores, { recursive: true, mode: 0o700 });
  return {
    home,
    bundle: config.bundle,
    prefix: config.prefix,
    localDir,
    stores,
    nfsMount: config.nfsMount,
    root: config.root,
    storeWorker: config.storeWorker !== false,
  };
}

interface Sdk {
  LayerFS: any;
  LayerFSError: any;
  INIT_TIMEOUT_MS: number;
}

let sdkPromise: Promise<Sdk> | null = null;
let loadedBundle: string | null = null;

const realBundle = (bundle: string) => { try { return realpathSync(bundle); } catch { return bundle; } };

/** Loads @layerfs/agent once per process (it refuses a second copy). */
export async function loadSdk(bundle: string): Promise<Sdk> {
  const root = realBundle(bundle);
  // the in-process transport loads the addon named here (else api/binding/layerfs.node)
  process.env.LAYERFS_NATIVE = join(root, "layerfs.node");
  process.env.LAYERFS_SANDBOX = "native";
  if (!sdkPromise || loadedBundle !== root) {
    loadedBundle = root;
    const agentUrl = pathToFileURL(join(root, "api/agent/sdk/src/index.js")).href;
    sdkPromise = import(agentUrl).then((agent) => ({
      LayerFS: agent.LayerFS,
      LayerFSError: agent.LayerFSError,
      INIT_TIMEOUT_MS: agent.INIT_TIMEOUT_MS,
    }));
    sdkPromise.catch(() => { if (loadedBundle === root) { sdkPromise = null; loadedBundle = null; } });
  }
  return sdkPromise;
}

/** The project's Store file. */
export function storePathOf(spec: NativeSpec, project: { volume: string }): string {
  return join(spec.stores, project.volume, "global", "store.sqlite");
}

/** The LAYERFS_* settings of one project: what `LayerFS.open/init` read when they make the client. */
export function layerfsEnv(spec: NativeSpec, project: { name: string; volume: string }): Record<string, string> {
  const bundle = realBundle(spec.bundle);
  const env: Record<string, string> = {
    LAYERFS_PROJECT: project.name,
    LAYERFS_HOME: spec.home,
    LAYERFS_SANDBOX: "native",
    LAYERFS_DAEMON: join(bundle, "layerfs-daemon"),
    LAYERFS_LOCAL_DIR: spec.localDir,
    LAYERFS_VOLUME: project.volume,
    LAYERFS_STORE_PATH: storePathOf(spec, project),
    LAYERFS_CONTAINER_PREFIX: spec.prefix,
    LAYERFS_NATIVE: join(bundle, "layerfs.node"),
  };
  if (spec.nfsMount) env.LAYERFS_NFS_MOUNT = spec.nfsMount;
  return env;
}

/**
 * Client factories run one at a time per process: each sets the project's LAYERFS_* variables,
 * awaits the factory and restores them. Two at once would interleave (B saves A's values, A restores,
 * B restores A's values back) and leave another project's settings in process.env.
 */
let envChain: Promise<unknown> = Promise.resolve();

/**
 * Runs `fn` with the project's LAYERFS_* variables set, then restores them. `endpoint`: the store
 * worker's endpoint file, so the client `fn` makes uses the worker transport (official
 * @layerfs/agent: a client keeps the binding it was made with); none: the addon in this process.
 */
function withProjectEnv<T>(spec: NativeSpec, project: { name: string; volume: string }, fn: () => Promise<T>, endpoint?: string): Promise<T> {
  const job = envChain.then(() => withProjectEnvNow(spec, project, fn, endpoint));
  envChain = job.catch(() => {});
  return job;
}

async function withProjectEnvNow<T>(spec: NativeSpec, project: { name: string; volume: string }, fn: () => Promise<T>, endpoint?: string): Promise<T> {
  const vars: Record<string, string | undefined> = { ...layerfsEnv(spec, project), LAYERFS_WORKER_ENDPOINT: endpoint };
  if (!spec.nfsMount) vars.LAYERFS_NFS_MOUNT = undefined;
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      // the addon path, sandbox kind and optional custom NFS mount helper stay set for the whole process
      if (k === "LAYERFS_NATIVE" || k === "LAYERFS_SANDBOX" || (k === "LAYERFS_NFS_MOUNT" && spec.nfsMount)) continue;
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function prepareStoreDir(spec: NativeSpec, project: { volume: string }): void {
  mkdirSync(join(spec.stores, project.volume, "global"), { recursive: true, mode: 0o700 });
}

/**
 * Creates the project from `stagedFolder` (one LayerFS Init, bounded by `timeoutMs`, default the
 * SDK's INIT_TIMEOUT_MS) and opens it: `await LayerFS.init(project.name, stagedFolder, timeoutMs)`.
 * `lfs.created` is what Init returned (`layer`, `root`, …).
 */
export async function initProjectClient(
  spec: NativeSpec,
  project: { name: string; volume: string },
  stagedFolder: string,
  timeoutMs?: number,
): Promise<ProjectClient> {
  const sdk = await loadSdk(spec.bundle);
  prepareStoreDir(spec, project);
  // Init in this process: the project is new and held under the folder's project lock, so no other
  // process uses its Store yet; then the session's client is the worker's like every other
  const created = await withProjectEnv(spec, project, () => sdk.LayerFS.init(project.name, stagedFolder, timeoutMs ?? sdk.INIT_TIMEOUT_MS));
  if (!spec.storeWorker) return { lfs: withContentionRetry(created), LayerFSError: sdk.LayerFSError };
  const info = created.created;
  await created.close();
  const opened = await createProjectClient(spec, project);
  opened.lfs.created = info;
  return opened;
}

/** The store worker's endpoint file for `spec` (started when none answers), or undefined (in-process). */
async function workerEndpoint(spec: NativeSpec): Promise<string | undefined> {
  if (!spec.storeWorker) return undefined;
  const bundle = realBundle(spec.bundle);
  return ensureWorker({ root: spec.root, home: spec.home, bundle, build: workerBuild(bundle, LAYERFS_COMMIT, spec.nfsMount), nfsMount: spec.nfsMount });
}

/**
 * Opens the existing project: `await LayerFS.open(project.name)`, through the root's store worker
 * (every Pi process of the root shares its one Store connection) unless `spec.storeWorker` is off.
 */
export async function createProjectClient(spec: NativeSpec, project: { name: string; volume: string }): Promise<ProjectClient> {
  const sdk = await loadSdk(spec.bundle);
  prepareStoreDir(spec, project);
  const open = async () => {
    const endpoint = await workerEndpoint(spec);
    return withProjectEnv(spec, project, () => sdk.LayerFS.open(project.name), endpoint);
  };
  // Busy: in-process mode, or a Store another minilfs version holds in-process; a worker that just
  // died answers Failed before the call is sent, and the next open starts a new one
  // open makes no change: always safe to send again
  const lfs = await retryBusy(open, async () => ({ landed: false }), (e) => isBusyRefusal(e) || isWorkerGone(e) || LOST_AFTER_SEND.test(String(e?.message)))
    .catch((e) => (e?.code === "Unknown" ? open() : Promise.reject(e)));
  return { lfs: withContentionRetry(lfs, spec.storeWorker ? () => workerEndpoint(spec).then(() => {}) : undefined), LayerFSError: sdk.LayerFSError };
}

/** A worker transport refusal that means the worker is not there (crashed, idle-stopped, restarting). */
export function isWorkerGone(e: any): boolean {
  return e?.code === "Failed" && /LayerFS worker (is not running|did not answer|connection is closed|is closing)/.test(String(e?.message ?? ""));
}

// ---------------------------------------------------------------- safety net: contention and worker loss
//
// With the store worker (default) every Pi process of a root makes its Store calls in one process,
// and LayerFS serializes them itself: no contention, no retry needed. Two cases remain:
// - Busy-class refusals: the Store is also opened in-process by something else (MINILFS_STORE_WORKER=0,
//   another minilfs version on the same root, a tool). LayerFS refuses a call that meets another
//   process's write (`Busy`, `Failed: Store open: Store busy before effect`, `Failed: Store Commit at
//   Begin: Storage(Busy)`, `Unknown: Service(History(Busy))`). Measured on a700af8: no refused write
//   had taken effect, so a jittered retry is safe; an uncertain one is checked before resending.
// - The worker went away (crash, idle stop, restart): the SDK answers `Failed: the LayerFS worker ...`
//   for a call it did not send. `revive` starts a worker again; the call is then resent. A call lost
//   after it was sent answers `Unknown`: `revive` first (the check needs a worker), then it is
//   checked like an uncertain write, and resent only when the check says it did not land.

const BUSY_RX = /\bBusy\b|busy before effect/i;
/** true for a refusal caused by another process holding the Store (any code: Busy, Failed, Unknown) */
export function isBusyRefusal(e: any): boolean {
  return BUSY_RX.test(String(e?.message ?? "")) || e?.code === "Busy";
}
/** an outcome LayerFS calls uncertain: the call may have taken effect */
const isUncertain = (e: any) =>
  e?.code === "Unknown" || (e?.code === "Failed" && isBusyRefusal(e) && !/before effect|at Begin/.test(String(e?.message)));
const RETRY_BUDGET_MS = 120_000;
/** calls the safety net sent again in this process, by reason (for tests and logs) */
export const retryStats = { busy: 0, workerGone: 0, uncertain: 0 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt: number) => Math.min(2_000, 25 * 2 ** attempt) * (0.5 + Math.random());

/** What a check of an uncertain call found: it took effect (with the answer to return), or it did not. */
export type Landed<T> = { landed: true; value: T } | { landed: false };

/**
 * Runs `call` again while `retryable(error)`, within RETRY_BUDGET_MS. After the worker went away,
 * `revive` runs first. An uncertain outcome is resent only when `verify` says it did not land; a
 * check that fails is retried (revive, back off), never taken as "not landed". No `verify`: thrown.
 */
export async function retryBusy<T>(
  call: () => Promise<T>,
  verify?: () => Promise<Landed<T>>,
  retryable: (e: any) => boolean = isBusyRefusal,
  revive?: () => Promise<void>,
): Promise<T> {
  const t0 = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (e: any) {
      if (!retryable(e) || Date.now() - t0 > RETRY_BUDGET_MS) throw e;
      const gone = isWorkerGone(e) || LOST_AFTER_SEND.test(String(e?.message));
      if (gone) {
        retryStats.workerGone++;
        await revive?.().catch(() => {});
      }
      if (isUncertain(e)) {
        if (!verify) throw e; // a read is safe to resend; a write without a check is not
        retryStats.uncertain++;
        for (let v = 0; ; v++) {
          try {
            const r = await verify();
            if (r.landed) return r.value;
            break;
          } catch {
            // the check itself failed (the worker may still be restarting): look again, never resend blind
            if (Date.now() - t0 > RETRY_BUDGET_MS) throw e;
            await revive?.().catch(() => {});
            await sleep(backoff(v));
          }
        }
      } else if (!gone) retryStats.busy++;
      await sleep(backoff(attempt));
    }
  }
}

const headOf = async (lfs: any, branch: string): Promise<string | null> =>
  (await lfs.branch.list_commits(branch, 1, 0)).items?.[0]?.id ?? null;

/** Reads, listings and other calls that change nothing: always safe to send again. */
const READ_ONLY = new Set(["read", "list", "stat", "grep", "glob", "diff_files", "blame", "list_commits", "diff_commits", "diff_branches", "list_branches", "list_sandboxes", "list_workspaces"]);
/** the SDK's own refusal for a call lost after it was sent to the worker */
const LOST_AFTER_SEND = /connection to the LayerFS worker was lost/;

/**
 * `lfs` with the safety net above on every call. Writes check whether an uncertain attempt landed:
 * fs.* writes by the Branch's head, branch.fork / branch.merge by the new Branch existing. Each
 * session writes only its own Branches, so a moved head is its own write. Mount, exec, commit,
 * unmount, publish and sandbox calls are resent only when they surely did not run (Busy before
 * effect, or the worker was not reached).
 */
export function withContentionRetry(lfs: any, revive?: () => Promise<void>): any {
  const raw = { fs: lfs.fs, branch: lfs.branch, project: lfs.project, sandbox: lfs.sandbox, workspace: lfs.workspace };
  const notRun = (e: any) => (isBusyRefusal(e) && !isUncertain(e)) || isWorkerGone(e);
  const any = (e: any) => isBusyRefusal(e) || isWorkerGone(e) || LOST_AFTER_SEND.test(String(e?.message));
  const wrapNs = (ns: string) => {
    const out: Record<string, any> = {};
    for (const [name, fn] of Object.entries(raw[ns as keyof typeof raw] ?? {})) {
      const f = fn as (...a: any[]) => Promise<any>;
      out[name] = async (...args: any[]) => {
        if (READ_ONLY.has(name)) return retryBusy(() => f(...args), async () => ({ landed: false as const }), any, revive).catch(async (e) => {
          // a lost read: just read again
          if (e?.code === "Unknown") return retryBusy(() => f(...args), undefined, notRun, revive);
          throw e;
        });
        if (ns === "fs") {
          const branch = args[0];
          // the head before the write is what tells an uncertain write landed: no write without it
          const before = await retryBusy(() => headOf(raw, branch), async () => ({ landed: false as const }), any, revive);
          return retryBusy(() => f(...args), async () => {
            const now = await headOf(raw, branch);
            return now && now !== before ? { landed: true as const, value: { kind: "Committed", head: now, commit: { id: now }, recovered: true } } : { landed: false as const };
          }, any, revive);
        }
        if (ns === "branch" && (name === "fork" || name === "merge")) {
          const target = name === "fork" ? args[0] : args[2];
          const exists = async () => {
            for (let pos = 0; ; ) {
              const page = await raw.project.list_branches(1000, pos);
              const b = (page.items ?? []).find((x: any) => x.name === target);
              if (b) return { landed: true as const, value: { kind: name === "fork" ? "Forked" : "Merged", branch: target, base: b.base, head: b.head ?? null, recovered: true } };
              if (!page.hasMore || !(page.items ?? []).length) return { landed: false as const };
              pos = page.nextPagePos ?? (pos + page.items.length);
            }
          };
          return retryBusy(() => f(...args), exists, any, revive);
        }
        return retryBusy(() => f(...args), undefined, notRun, revive);
      };
    }
    return out;
  };
  const wrapped: Record<string, any> = {};
  for (const ns of Object.keys(raw)) wrapped[ns] = wrapNs(ns);
  return new Proxy(lfs, { get: (t, p, r) => (typeof p === "string" && p in wrapped ? wrapped[p] : Reflect.get(t, p, r)) });
}
