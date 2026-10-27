import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsc, createReadStream, promises as fsp, realpathSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { ensureBundle, missingBundleFiles } from "./bundle.ts";
import { BindingStore, type HostEntry, type HostIndex, type ProjectRecord, type SessionBinding } from "./bindings.ts";
import type { LayerfsConfig } from "./config.ts";
import { createProjectClient, ensureNativeDirs, initProjectClient, type NativeSpec, type ProjectClient } from "./core/client.ts";
import { resolveExecutionDriver, type ExecutionDriver } from "./core/driver.ts";
import { run } from "./core/exec-helper.ts";
import { bothSpellings, buildSeatbeltProfile } from "./seatbelt.ts";
import { decideGitPath, GIT_APPLY_ORDER, GIT_JOIN_HINT, gitChangeSummary, gitDirOf, gitPathKind, gitSig, isProtectedPath, parseIndexEntries, isSafeRefName, MERGE_UNITS, type GitPathKind } from "./gitpaths.ts";
import { isOrphan, MountLeases } from "./mount-leases.ts";
import { GIT_JOIN_SCRIPT, parseJoin, symbolicHead, type JoinResult } from "./gitjoin.ts";
import { stopWorkers } from "./core/worker.ts";
import { alive } from "./lock.ts";
import { procStartTime } from "./core/proc-scan.ts";

export interface Workspace { sandbox: string; path: string; image?: string }
export interface Checkpoint { origins: string[]; label: string; commit: string | null; branch: string; changed: boolean; at: number }
export interface ApplyResult {
  applied: string[]; skipped: string[]; conflicts: string[]; unchanged: string[]; warnings: string[];
  /** what apply did to the folder's git metadata (views hide `.git`), e.g. ".git: 1 ref(s): refs/heads/main, HEAD, index, 3 object file(s)" */
  git?: string;
}
export interface UserBranch { name: string; base: string; head: string | null; logicalBranch: string; isYours: boolean }
export interface MergeResult {
  merged: boolean;
  branch: string;
  head: string | null;
  conflicts: Array<{ path: string; kind?: string }>;
  lww: number;
  lwwPaths?: string[];
  /** conflicting paths decided by `strategy` (copied from the chosen side before merging again) */
  resolved?: string[];
  /**
   * Both sides ran git: the merged `.git` (refs, HEAD, index) is one side's whole; the other side's
   * branch heads are kept as refs under `refs/minilfs/<branch>/` (their objects are merged), so its
   * commits stay reachable. Says which side was kept and how to combine them.
   */
  gitNote?: string;
}
export interface MergeOptions {
  /**
   * On a Conflict, the side whose version wins on the conflicting paths. LayerFS branch.merge has no
   * force; this follows the official recipe (resolving conflicts, scenario 9): copy the chosen side's
   * files onto a working fork of the other side, then merge again; identical files merge cleanly.
   */
  strategy?: "ours" | "theirs";
  /** official LayerFS merge units (branch.merge's `units`) */
  units?: Array<string | { name: string; patterns: string[] }>;
}
export interface OpenOptions {
  /** reports the current start phase (shown in the status bar while starting) */
  onPhase?: (phase: string) => void;
  reason?: "startup" | "reload" | "new" | "resume" | "fork";
  resumeBinding?: { project?: string; baseBranch?: string; workBranch?: string; baseRef?: string; headCommit?: string | null; seq?: number; alignedRef?: string | null };
  forkFromRef?: string | null;
}

/**
 * Refuses a write whose real destination (symlinks resolved: every parent, and the final node when
 * `followFinal`, as fs.writeFile does) is a protected path of `root` (src/gitpaths.ts), so a link
 * such as `x -> .git/hooks` cannot carry a write into `.git/hooks/pre-commit`.
 */
export async function assertNotProtectedTarget(root: string, candidate: string, followFinal: boolean): Promise<void> {
  let probe = candidate;
  const rest: string[] = [];
  if (!followFinal) { rest.unshift(basename(probe)); probe = dirname(probe); }
  for (let i = 0; i < 4096; i++) {
    const real = await fsp.realpath(probe).catch(() => null);
    if (real) {
      const full = rest.length ? join(real, ...rest) : real;
      for (const r of bothSpellings(root)) {
        if (full !== r && !full.startsWith(`${r}/`)) continue;
        const rel = full.slice(r.length + 1);
        if (isProtectedPath(rel)) {
          const err = new Error(`writes to ${rel} are refused for security (reached through a symlink)`);
          (err as any).code = "EACCES";
          throw err;
        }
      }
      return;
    }
    rest.unshift(basename(probe));
    const up = dirname(probe);
    if (up === probe) return;
    probe = up;
  }
}

export async function assertInsideWorkspace(wsReal: string, candidate: string, allowFinalSymlink = false): Promise<string> {
  const allowed = bothSpellings(wsReal);
  const isInside = (target: string) => allowed.some((w) => target === w || target.startsWith(`${w}/`));
  const denyOutside = () => {
    const err = new Error("refusing to write through a symlink pointing outside the LayerFS workspace");
    (err as any).code = "EPERM";
    return err;
  };
  if (!isInside(candidate)) throw denyOutside();

  const checkSingleNode = async (nodePath: string) => {
    let hop = nodePath;
    for (let depth = 0; depth < 40; depth++) {
      if (!isInside(hop)) throw denyOutside();
      const lst = await fsp.lstat(hop).catch(() => null);
      if (lst?.isSymbolicLink()) {
        const rawTarget = await fsp.readlink(hop);
        hop = resolve(dirname(hop), rawTarget);
        if (!isInside(hop)) throw denyOutside();
        continue;
      }
      if (lst) {
        const real = await fsp.realpath(hop).catch(() => null);
        if (!real || !isInside(real)) throw denyOutside();
        return;
      }
      // Target does not exist yet: walk up to nearest existing ancestor and verify it is inside wsReal
      let anc = dirname(hop);
      while (anc && anc !== dirname(anc)) {
        const realAnc = await fsp.realpath(anc).catch(() => null);
        if (realAnc) {
          if (!isInside(realAnc)) throw denyOutside();
          break;
        }
        anc = dirname(anc);
      }
      return;
    }
    throw denyOutside();
  };

  let cur = allowFinalSymlink ? dirname(candidate) : candidate;
  while (cur && isInside(cur) && cur !== dirname(cur)) {
    await checkSingleNode(cur);
    if (allowed.includes(cur)) break;
    cur = dirname(cur);
  }
  return candidate;
}

export class LayerfsError extends Error {
  code: string;
  detail: unknown;
  constructor(code: string, message: string, detail: unknown = null) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

type Log = (msg: string) => void;
/**
 * The project's initial `/.lww` (LayerFS merge rules) when the folder has none: git-ignored output
 * merges last-writer-wins. `.git` and `node_modules` are not here: every merge passes them as merge
 * units (MERGE_UNITS, src/gitpaths.ts), each taken whole from one side, never mixed file by file.
 */
export const LWW_DEFAULT = "%include .gitignore\n";
/** Workspaces one LayerFS Sandbox holds (workspace.mount answers Capacity beyond it). */
const SANDBOX_CAPACITY = 16;
const HOMES = [...new Set([homedir(), (() => { try { return realpathSync(homedir()); } catch { return homedir(); } })()])];
/** Extra secrets never readable outside the project, on top of config.excludes. */
const OUTSIDE_SECRET_PATTERNS = [
  ".ssh", ".aws", ".gnupg", ".kube", ".docker/config.json", ".config/gh", ".config/gcloud", ".azure",
  ".netrc", ".git-credentials", ".npmrc", ".pypirc", ".pi/agent/auth.json", ".epi/pi/auth.json", "auth.json",
];
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
/**
 * The outside-read helper (run under sandbox-exec): `<op> <path>`; prints the bytes, `1`/`0`, or
 * NUL-separated names; on failure prints `<ERRNO>:<message>` to stderr. sysopen needs
 * file-read-data (unlike stat), so Seatbelt's denial applies to directories too; O_NONBLOCK: a FIFO
 * never hangs the call.
 */
const OUTSIDE_READ_PL = String.raw`
use Fcntl qw(O_RDONLY O_NONBLOCK);
my ($op, $p) = @ARGV;
sub fail { my ($c) = grep { $!{$_} } keys %!; print STDERR (($c || "EACCES") . ":$!\n"); exit 1 }
binmode(STDOUT);
if ($op eq "readdir") { opendir(my $d, $p) or fail(); print join("\0", sort grep { $_ ne "." && $_ ne ".." } readdir($d)); exit 0 }
sysopen(my $f, $p, O_RDONLY | O_NONBLOCK) or fail();
if ($op eq "isDir") { print((-d $f) ? "1" : "0"); exit 0 }
if ($op eq "read") {
  if (-d $f) { print STDERR "EISDIR:Is a directory\n"; exit 1 }
  binmode($f); local $/; my $d = <$f>; fail() if !defined $d; print $d;
}
exit 0;
`;

/**
 * Native LayerFS v1.1.0 Session (official @layerfs/agent, pure sandbox model):
 * - Shares one persistent Project Store per host folder across sessions/agents (`BindingStore`)
 * - Imports the full tree (`.git`, ignored files, dependencies, symlinks, caches, output); only
 *   secrets (`config.excludes`) and explicit `config.branchOnly` patterns stay out
 * - Syncs external host edits into `"main"` on session start
 * - Routes `read / write / edit / ls / find / grep` through `lfs.fs.*` directly on the Store,
 *   with automatic byte-exact Workspace fallback for binary, symlinks or >48KB lines
 * - Runs each `bash` call in a Workspace: `sandbox.create` / `workspace.mount(sandbox, branch)`,
 *   native NFSv3 loopback + Seatbelt (`sandbox-exec`), `workspace.commit`, `workspace.unmount`
 * - Merges Branches with `branch.merge`, applies against this session's `baseBranch` anchor and
 *   publishes `"main"`
 * - Supports `/resume`, `/tree` and `/fork` time-travel via `switchToRef()`
 */
export class LayerfsSession {
  readonly cwd: string;
  /** the folder as the harness named it (may be a symlinked spelling of `cwd`) */
  readonly originalCwd: string;
  sessionId: string;
  shortId: string;
  logicalBranch: string;
  readonly touchPathsOnNextExec = new Set<string>();
  readonly mergedFileMtimes = new Map<string, number>();
  readonly config: LayerfsConfig;
  readonly driver: ExecutionDriver;
  readonly log: Log;

  get isNative(): boolean { return true; }

  bindings!: BindingStore;
  spec!: NativeSpec;
  get boxSpec(): NativeSpec { return this.spec; }
  projectRecord!: ProjectRecord;
  lfs: any;
  LayerFSError: any;

  baseBranch = "";
  workBranch = "";
  baseRef = "";
  headCommit: string | null = null;
  seq = 0;

  blocked: { reason: string; heldWs?: Workspace } | null = null;
  /**
   * A Commit of the work branch that holds everything in the base (set when the base moves: apply,
   * sync, merging main). While the work branch still descends from it, the base..branch diff is the
   * Branch's own work, so apply cannot revert anything: no guessing. null: unknown, apply guesses.
   */
  alignedRef: string | null = null;
  /** When main last moved (apply or host sync), from the project record; null if unknown. */
  get mainUpdatedAt(): number | null {
    return this.bindings?.byName(this.projectRecord?.name)?.updatedAt ?? null;
  }
  /** Branches merged into this one since the last apply (main, and new sub-agents, do not have them yet). */
  mergedSinceApply: string[] = [];
  pendingOrigins: string[] = [];
  checkpoints: Checkpoint[] = [];
  unapplied = false;

  private lastStoreCommit: { kind: string; head: string | null } | null = null;
  private inMutate = false;
  /** running bash calls: close() aborts each and waits for it (its Commit and unmount) */
  private activeExecs = new Map<AbortController, Promise<unknown>>();
  private pendingUnmounts = new Set<Promise<unknown>>();
  /** Workspaces this session has mounted and not yet unmounted, by `ws.path`. */
  private mounts = new Map<string, { ws: Workspace; wsReal: string }>();
  private leases!: MountLeases;
  private mutex: Promise<unknown> = Promise.resolve();
  private closed = false;
  private openAborted = false;
  /** the Sandbox this session mounts its Workspaces in (a number such as "1"), once known */
  private sandboxId: string | null = null;
  /** set by open() when a resumed conversation's file state could not be restored */
  resumeLost: string | null = null;

  /** The host session is going away: `open()` stops at its next phase. A running native Init is not interruptible. */
  abortOpen(): void { this.openAborted = true; }

  constructor(cwd: string, sessionId: string, config: LayerfsConfig, log: Log = () => {}, driver?: ExecutionDriver) {
    // canonical path: /tmp/x and /private/tmp/x (or a symlinked folder) are one project
    this.originalCwd = resolve(cwd);
    this.cwd = (() => { try { return realpathSync(resolve(cwd)); } catch { return resolve(cwd); } })();
    this.sessionId = sessionId;
    this.shortId = createHash("sha256").update(`${sessionId}:${randomBytes(8).toString("hex")}`).digest("hex").slice(0, 10);
    this.logicalBranch = config.branchName || (config.team && process.env.PI_SUBAGENT_CHILD !== "1" ? "lead" : `s-${this.shortId}`);
    this.config = config;
    this.driver = driver ?? resolveExecutionDriver(config.driver ?? "native");
    this.log = log;
  }

  get project(): string { return this.projectRecord?.name ?? ""; }
  get volume(): string { return this.projectRecord?.volume ?? ""; }
  /** Effective snapshot ref even when no Commit has been made on workBranch yet. */
  get effectiveRef(): string { return this.headCommit ?? this.baseRef; }

  // ---------------------------------------------------------------- startup & project sharing

  static async preflight(config: LayerfsConfig, onPhase?: (phase: string) => void): Promise<string> {
    const problems: string[] = [];
    // first start on a new Mac: fetch the prebuilt bundle instead of failing
    const fetchProblem = await ensureBundle(config.bundle, (m) => onPhase?.(m)).catch((e) => `installing the LayerFS bundle failed: ${e?.message ?? e}`);
    for (const f of await missingBundleFiles(config.bundle)) problems.push(`missing ${f}`);
    // a missing file reports the download problem too; a complete bundle of another LayerFS commit is a problem by itself
    if (fetchProblem && (problems.length || /needs [0-9a-f]{12}/.test(fetchProblem))) problems.push(fetchProblem);
    problems.push(...(config.problems ?? []));
    const mountBin = config.nfsMount ? config.nfsMount.trim().split(/\s+/)[0] : "/sbin/mount_nfs";
    for (const bin of [mountBin, "/usr/bin/sandbox-exec"]) {
      try { await fsp.access(bin, fsc.X_OK); } catch { problems.push(`missing or non-executable ${bin}`); }
    }
    if (problems.length) throw new LayerfsError("Preflight", `LayerFS is not available: ${problems.join("; ")}`);
    return "native";
  }

  async open(options: OpenOptions = {}): Promise<void> {
    const t0 = Date.now();
    await LayerfsSession.preflight(this.config, options.onPhase);
    this.spec = ensureNativeDirs(this.config);
    this.bindings = new BindingStore(join(this.config.root, "state"));
    this.leases = new MountLeases(join(this.config.root, "state", "mounts"));

    const phase = (p: string) => {
      if (this.openAborted) throw new LayerfsError("Aborted", "session closed while minilfs was starting");
      options.onPhase?.(p);
    };
    const existing = this.bindings.byFolder(this.cwd);
    const usable = existing && (await this.isProjectAlive(existing));
    if (!usable) {
      phase("importing folder (first run)…");
      this.projectRecord = await this.initProjectForFolder();
    } else {
      this.projectRecord = existing!;
      this.useClient(await createProjectClient(this.spec, this.projectRecord));
      const hasPriorSession =
        Boolean(options.resumeBinding?.workBranch) ||
        Boolean(this.bindings.session(this.sessionId)?.project === this.projectRecord.name) ||
        Boolean(
          this.config.branchName &&
            Object.values(this.bindings.data.sessions).some(
              (s) => s.project === this.projectRecord.name && (s.logicalBranch === this.config.branchName || s.workBranch === this.config.branchName),
            ),
        );
      if (options.reason !== "reload" && !(options.reason === "resume" && hasPriorSession) && !options.forkFromRef) {
        phase("syncing host changes…");
        await this.syncHostDriftIntoMain();
      }
    }
    await this.reclaimOrphanMounts().catch((e) => this.log(`reclaiming orphan mounts failed: ${e?.message ?? e}`));

    phase("preparing branch…");
    await this.setupBranches(options);
    phase("ready");
    this.persistSessionBinding();
    this.log(`ready in ${Date.now() - t0} ms (project=${this.project} base=${this.baseBranch} work=${this.workBranch})`);
  }

  private useClient(client: ProjectClient): void {
    this.lfs = client.lfs;
    this.LayerFSError = client.LayerFSError;
  }

  private async isProjectAlive(p: ProjectRecord): Promise<boolean> {
    const homeEntry = join(this.spec.home, p.name);
    const hasHome = await fsp.access(homeEntry).then(() => true, () => false);
    if (!hasHome) return false;
    return fsp.access(join(this.spec.stores, p.volume, "global", "store.sqlite")).then(() => true, () => false);
  }

  private async initProjectForFolder(): Promise<ProjectRecord> {
    // One lock per folder: importing a large folder must not block other projects from starting.
    // Waiters for the same folder wait as long as the importer is alive (it heartbeats the lock).
    const folderLock = `_init-${sha(this.cwd).slice(0, 16)}`;
    return this.bindings.withProjectLock(folderLock, async () => {
      const again = this.bindings.byFolder(this.cwd);
      if (again && (await this.isProjectAlive(again))) {
        this.useClient(await createProjectClient(this.spec, again));
        return again;
      }
      const reserved = this.bindings.reserveProjectName(this.cwd, this.spec.home);
      const name = reserved.name;
      const created = Date.now();
      const volume = `${this.config.prefix}${name}-store-${created.toString(36)}`;
      const staged = join(this.config.root, "staging", `${name}-${created}`);
      await fsp.mkdir(staged, { recursive: true });
      try {
        const list = join(this.config.root, "staging", `${name}-${created}.files`);
        const importable = await listImportable(this.cwd, this.hostSkip);
        await checkImportSize(this.cwd, importable, this.config);
        await fsp.writeFile(list, importable.join("\0"));
        const rs = await runLocal("rsync", ["-a", "--no-implied-dirs", "--links", "--from0", `--files-from=${list}`, `${this.cwd}/`, `${staged}/`]);
        await fsp.rm(list, { force: true });
        if (rs.code !== 0) throw new LayerfsError("Failed", `staging copy failed: ${rs.stderr.slice(0, 400)}`);

        const stagedScan = await scanHostDirectory(staged, this.hostSkip, {}, true, false);
        const hostIndex: HostIndex = {};
        for (const [rel, ent] of Object.entries(stagedScan.index)) {
          hostIndex[rel] = ent;
        }
        const lwwPath = join(staged, ".lww");
        const hadLww = await fsp.access(lwwPath).then(() => true, () => false);
        if (!hadLww) await fsp.writeFile(lwwPath, LWW_DEFAULT + this.config.branchOnly.map((p) => `${p}\n`).join(""));
        // the Branch's own git should not list .lww as untracked: one local exclude line in the staged
        // copy's .git (after the host index was taken, so host sync does not see it as drift)
        const stagedExclude = join(staged, ".git", "info", "exclude");
        if ((await fsp.lstat(join(staged, ".git")).catch(() => null))?.isDirectory()) {
          const text = await fsp.readFile(stagedExclude, "utf8").catch(() => "");
          if (!text.split("\n").includes("/.lww")) {
            await fsp.mkdir(dirname(stagedExclude), { recursive: true });
            await fsp.writeFile(stagedExclude, `${text}${text.length && !text.endsWith("\n") ? "\n" : ""}/.lww\n`);
          }
        }

        await fsp.mkdir(join(this.spec.stores, volume), { recursive: true, mode: 0o700 });
        const record: ProjectRecord = { name, source: this.cwd, volume, mainRef: "", created, updatedAt: created };
        try {
          // official @layerfs/agent: one Init from the staged copy, then the client is open
          this.useClient(await initProjectClient(this.spec, record, staged, this.config.initTimeoutMs));
          record.mainRef = this.lfs.created?.layer ?? "";
        } catch (e: any) {
          await fsp.rm(join(this.spec.stores, volume), { recursive: true, force: true }).catch(() => {});
          await fsp.rm(join(this.spec.home, name), { recursive: true, force: true }).catch(() => {});
          if (/Deadline/.test(String(e?.message ?? e))) {
            const mb = Math.round(Object.values(hostIndex).reduce((s, x) => s + (x.size ?? 0), 0) / 1024 / 1024);
            throw new LayerfsError("InitDeadline",
              `importing ${Object.keys(hostIndex).length} files (${mb} MB) took longer than the LayerFS Init limit (${Math.round((this.config.initTimeoutMs ?? 300_000) / 1000)} s); nothing was kept. ` +
              `Raise MINILFS_INIT_TIMEOUT_MS, or keep large folders agents need not edit out with MINILFS_BRANCH_ONLY (e.g. "data/"), then run /minilfs retry.`, e);
          }
          throw e;
        }
        this.bindings.writeHostIndex(name, hostIndex);
        this.bindings.addProject(this.cwd, record);
        return record;
      } finally {
        reserved.release();
        await fsp.rm(staged, { recursive: true, force: true }).catch(() => {});
      }
    }, INIT_LOCK_WAIT_MS);
  }

  /**
   * Detects host edits made outside Pi (editor, git pull) and syncs them into "main" before forking.
   */
  async syncHostDriftIntoMain(options: { full?: boolean } = {}): Promise<{ synced: string[] }> {
    return this.bindings.withProjectLock(this.projectRecord.name, async (guard) => {
      const full = options.full || Boolean(this.bindings.byName(this.projectRecord.name)?.mainStale);
      const prev = full ? await this.mainIndex() : this.bindings.readHostIndex(this.projectRecord.name);
      const scanned = await scanHostDirectory(this.cwd, this.hostSkip, full ? {} : prev, true);
      const curr = scanned.index;
      const changed: string[] = [];
      const removed: string[] = [];
      for (const [rel, ent] of Object.entries(curr)) {
        const old = prev[rel];
        if (!old || !sameSig(old, ent)) changed.push(rel);
      }
      // a path that is now secret or branch-only stays in main (never a mass delete)
      const skip = this.hostSkip;
      for (const rel of Object.keys(prev)) if (!curr[rel] && !skip(rel, false)) removed.push(rel);
      if (changed.length) {
        // never pull a huge new tree into memory and the Store unasked (e.g. the first start after an
        // upgrade that imports .git and dependencies: the old host index lacks them)
        const bytes = changed.reduce((n, rel) => n + (curr[rel]?.size ?? 0), 0);
        if (changed.length > this.config.maxImportFiles || bytes > this.config.maxImportBytes) {
          throw new LayerfsError("TooLarge", `${changed.length} changed file(s), ${Math.round(bytes / 1048576)} MB in your folder exceed the import limit (${this.config.maxImportFiles} files / ${Math.round(this.config.maxImportBytes / 1048576)} MB). Raise MINILFS_MAX_IMPORT_FILES / MINILFS_MAX_IMPORT_MB, or keep large data folders out with MINILFS_BRANCH_ONLY; then /minilfs retry.`);
        }
      }
      if (!changed.length && !removed.length) {
        this.bindings.writeHostIndex(this.projectRecord.name, curr);
        if (full) this.bindings.setMainStale(this.projectRecord.name, false);
        return { synced: [] };
      }

      const syncBranch = `sync-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
      await this.lfs.branch.fork(syncBranch, "main");
      const changedBytes = changed.reduce((n, rel) => n + (curr[rel]?.size ?? 0), 0);
      const special = (rel: string) => {
        const ent = curr[rel];
        const prevEnt = prev[rel];
        const exec = ((ent.mode ?? 0o644) & 0o111) !== 0;
        const execFlip = prevEnt?.mode !== undefined && ((prevEnt.mode ^ (ent.mode ?? 0o644)) & 0o111) !== 0;
        return ent.kind === "symlink" || prevEnt?.kind === "symlink" || exec || execFlip;
      };
      const viaStore = changed.length + removed.length <= SYNC_STORE_MAX_FILES && changedBytes <= SYNC_STORE_BATCH_BYTES;
      if (viaStore) {
        // small drift (the usual case): one Store Commit, no mount, plus one mount for symlinks and modes
        const storeOps: any[] = [];
        const mountJobs: string[] = [];
        for (const rel of removed) storeOps.push({ op: "rm", path: `/${rel}` });
        for (const rel of changed) {
          if (special(rel)) { mountJobs.push(rel); continue; }
          const dir = posix.dirname(`/${rel}`);
          if (dir !== "/") storeOps.push({ op: "mkdir", path: dir });
          storeOps.push({ op: "write", path: `/${rel}`, bytes: scanned.bytes.get(rel) ?? (await fsp.readFile(join(this.cwd, rel))) });
        }
        if (storeOps.length) await this.lfs.fs.apply(syncBranch, storeOps, "sync host drift");
        if (mountJobs.length) await this.copyHostIntoBranch(syncBranch, mountJobs, [], curr, "sync host special files");
      } else {
        // large drift: one mount, files copied from the folder one by one (bounded memory, one Commit)
        await this.copyHostIntoBranch(syncBranch, changed, removed, curr, "sync host drift");
      }
      guard();
      const pub = await this.lfs.branch.publish(syncBranch);
      // the SDK answers the new Layer as `publishedLayer` ({ id, ... }); UpToDate has none (main keeps its Layer)
      this.projectRecord.mainRef = pub?.publishedLayer?.id ?? pub?.layer ?? this.projectRecord.mainRef;
      this.bindings.updateProjectMain(this.projectRecord.name, this.projectRecord.mainRef);
      this.bindings.writeHostIndex(this.projectRecord.name, curr);
      if (full) this.bindings.setMainStale(this.projectRecord.name, false);
      return { synced: [...changed, ...removed] };
    });
  }

  /** Copies `changed` paths from the folder into `branch` and removes `removed`, in one mount and one Commit. */
  private async copyHostIntoBranch(branch: string, changed: string[], removed: string[], curr: HostIndex, message: string): Promise<void> {
    await this.withMountedBranch(branch, true, message, async (wsPath) => {
      for (const rel of removed) {
        const dst = posix.join(wsPath, rel);
        await this.assertInsideWs(wsPath, dst, true);
        await fsp.rm(dst, { force: true });
      }
      for (const rel of changed) {
        const entry = curr[rel];
        const dst = posix.join(wsPath, rel);
        await this.assertInsideWs(wsPath, dst, true);
        await fsp.mkdir(dirname(dst), { recursive: true });
        await fsp.rm(dst, { recursive: true, force: true });
        if (entry.kind === "symlink") {
          await fsp.symlink(entry.sig.slice("link:".length), dst);
        } else {
          await fsp.copyFile(join(this.cwd, rel), dst);
          await fsp.chmod(dst, (entry.mode ?? 0o644) & 0o7777);
        }
      }
    });
  }

  /** Signatures of every file in main, read via one short mount without subprocesses. */
  private async mainIndex(): Promise<HostIndex> {
    const tmp = `r-${this.shortId}-${(++this.seq)}`;
    await this.lfs.branch.fork(tmp, "main");
    return this.withMountedBranch(tmp, false, "main index", async (wsPath) => {
      return (await scanHostDirectory(wsPath, this.hostSkip, {}, true, false)).index;
    });
  }

  /**
   * Host paths never imported or synced: secrets (`config.excludes`) and explicit `config.branchOnly`
   * patterns only. Official LayerFS model: `.git` (with its index), ignored files, dependencies,
   * symlinks, caches and output are all project state; git ignore rules do not filter it.
   */
  private get hostSkip(): Skip {
    const patterns = [...this.config.excludes, ...this.config.branchOnly];
    return (rel, isDir) => isExcludedPath(rel, patterns) || (isDir && isExcludedPath(`${rel}/x`, patterns));
  }

  private async setupBranches(options: OpenOptions): Promise<void> {
    let saved: Partial<SessionBinding> | undefined = options.resumeBinding;
    if (!saved && (options.reason === "resume" || options.reason === "reload")) {
      const byId = this.bindings.session(this.sessionId);
      if (byId && byId.project === this.projectRecord.name) {
        saved = byId;
      } else if (this.config.branchName) {
        const byAlias = aliasOrder();
        const match = Object.entries(this.bindings.data.sessions)
          .filter(([, s]) => s.project === this.projectRecord.name && (s.logicalBranch === this.config.branchName || s.workBranch === this.config.branchName))
          .sort((a, b) => byAlias(a[1], b[1]))[0];
        if (match) {
          this.sessionId = match[0];
          saved = match[1];
        }
      }
    }
    if (saved?.workBranch && (options.reason === "resume" || options.reason === "reload")) {
      const m = /^s-([a-f0-9]+)-(\d+)$/.exec(saved.workBranch);
      if (m) {
        this.shortId = m[1];
        this.seq = Math.max(this.seq, parseInt(m[2], 10), saved.seq ?? 0);
      } else if (saved.seq) {
        this.seq = Math.max(this.seq, saved.seq);
      }
      if (saved.logicalBranch && !this.config.branchName) {
        this.logicalBranch = saved.logicalBranch;
      }
      const branches = await this.listAllBranches();
      // The saved seq can lag: a session entry in the conversation log has no seq, and apply/sync
      // advance seq without renaming the work branch. Never reuse a name this session already made.
      this.seq = Math.max(this.seq, highestSeq(branches, this.shortId));
      this.alignedRef = saved.alignedRef ?? null;
      const wb = branches.find((b) => b.name === saved!.workBranch);
      const bb = saved.baseBranch ? branches.find((b) => b.name === saved!.baseBranch) : null;
      const targetRef = saved.headCommit ?? saved.baseRef;
      if (wb && bb) {
        this.baseBranch = saved.baseBranch!;
        this.workBranch = saved.workBranch;
        this.baseRef = saved.baseRef ?? bb.head ?? bb.base;
        this.headCommit = wb.head;
        this.unapplied = await this.hasApplicable();
        return;
      }
      if (targetRef && !bb) {
        // the conversation's file state lived in a Store that no longer has it (Store recreated)
        this.resumeLost = `the saved file state (${saved.workBranch} @ ${String(targetRef).slice(0, 12)}) is not in this project's Store any more; starting a fresh branch from main`;
      }
      if (targetRef && bb) {
        this.seq++;
        this.baseBranch = saved.baseBranch!;
        this.baseRef = saved.baseRef ?? bb.head ?? bb.base;
        this.workBranch = `s-${this.shortId}-${this.seq}`;
        const f = await this.lfs.branch.fork(this.workBranch, targetRef);
        this.headCommit = f.head ?? null;
        this.unapplied = await this.hasApplicable();
        return;
      }
    }

    if (!this.config.branchName && this.logicalBranch === "lead") {
      // `lead` is taken only by a session whose process still runs: a finished run (or a crashed
      // one) keeps its branch, but not the alias
      const existingLead = Object.entries(this.bindings.data.sessions).find(
        ([sid, s]) => s.project === this.projectRecord.name && sid !== this.sessionId && s.logicalBranch === "lead" && sessionAlive(s),
      );
      if (existingLead) {
        this.logicalBranch = `s-${this.shortId}`;
      }
    }

    const fromRef = options.forkFromRef || "main";
    this.alignedRef = null;
    this.seq++;
    this.baseBranch = `b-${this.shortId}-${this.seq}`;
    this.workBranch = `s-${this.shortId}-${this.seq}`;
    const fb = await this.lfs.branch.fork(this.baseBranch, "main");
    const fw = await this.lfs.branch.fork(this.workBranch, fromRef);
    this.baseRef = fb.head ?? fb.base;
    this.headCommit = fw.head ?? (fromRef !== "main" && fromRef !== this.baseRef ? fromRef : null);
    this.unapplied = fromRef !== "main" ? (await this.diff()).filter((i) => i.type !== "dir").length > 0 : false;
  }

  /**
   * Merges main (the folder's state, after a host sync) into the work branch, then moves the base to main.
   * Afterwards base..branch is exactly this Branch's own work. Merges when `force`, or when main differs
   * from the base. Throws Conflict (nothing moved) when the merge conflicts. Caller holds the mutex.
   */
  private async adoptMainLocked(force: boolean, strategy: "ours" | "theirs" = "theirs"): Promise<MergeResult | null> {
    let m: MergeResult | null = null;
    if (force || (await this.mainDiffersFromBase())) {
      m = await this.mergeBranchLocked("main", { strategy });
      if (!m.merged) throw new LayerfsError("Conflict", `merging the folder's changes into the Branch conflicts on ${m.conflicts.map((c) => c.path).join(", ")}`);
    }
    this.seq++;
    const nextBase = `b-${this.shortId}-${this.seq}`;
    const fb = await this.lfs.branch.fork(nextBase, "main");
    this.baseBranch = nextBase;
    this.baseRef = fb.head ?? fb.base;
    // after a merge the Branch holds main, which is now the base; with no merge main equals the old
    // base, so what held the old base still holds the new one
    if (m?.head) this.alignedRef = m.head;
    this.unapplied = await this.hasApplicable();
    this.persistSessionBinding();
    return m;
  }

  /** true when main has content the base does not (another session applied, or the folder was synced) */
  private async mainDiffersFromBase(): Promise<boolean> {
    const d = await this.lfs.branch.diff_branches(this.baseBranch, "main", 50, 0, { hunks: false });
    if (d.from?.root && d.from.root === d.to?.root) return false;
    return (d.items ?? []).some((it: any) => it.path !== "/.lww" && it.type !== "dir");
  }

  /**
   * The `sync` action from main (after syncHostDriftIntoMain): merge main into the Branch and move the
   * base to main. Always merges, so a Branch whose base already equals main but lacks main's content
   * (left by older versions) recovers. Conflicting paths are decided by `strategy` (default theirs).
   */
  async adoptMain(strategy: "ours" | "theirs" = "theirs"): Promise<MergeResult> {
    const job = this.mutex.then(async () => {
      if (this.blocked) throw new Error(`cannot merge while a checkpoint is pending (${this.blocked.reason}); run /minilfs retry`);
      return (await this.adoptMainLocked(true, strategy))!;
    });
    this.mutex = job.catch(() => {});
    return job;
  }

  /** Switches `workBranch` to a historical Commit or Layer ref (for `/tree` and `/fork`). */
  async switchToRef(targetRef: string | null | undefined): Promise<{ branch: string; ref: string }> {
    const job = this.mutex.then(async () => {
      const ref = targetRef || this.baseRef;
      this.seq++;
      const nextWork = `s-${this.shortId}-${this.seq}`;
      const forked = await this.lfs.branch.fork(nextWork, ref);
      this.workBranch = nextWork;
      this.headCommit = forked.head ?? (ref !== this.baseRef ? ref : null);
      this.blocked = null;
      this.pendingOrigins = [];
      this.unapplied = await this.hasApplicable();
      this.persistSessionBinding();
      return { branch: this.workBranch, ref: this.effectiveRef };
    });
    this.mutex = job.catch(() => {});
    return job;
  }

  /**
   * Merges another Branch of this project into this session's work branch with the official
   * `branch.merge(work, other, target, message, units)`: three-way, `/.lww` rules of the work branch,
   * both parents recorded. On a Conflict nothing changes and the conflicts are returned, unless
   * `options.strategy` names the side that wins on the conflicting paths (see MergeOptions).
   */
  async mergeBranch(other: string, options?: MergeOptions): Promise<MergeResult> {
    const job = this.mutex.then(() => this.mergeBranchLocked(other, options));
    this.mutex = job.catch(() => {});
    return job;
  }

  /** mergeBranch body; the caller holds the session mutex. */
  private async mergeBranchLocked(other: string, options: MergeOptions = {}): Promise<MergeResult> {
    {
      if (this.blocked) throw new Error(`cannot merge while a checkpoint is pending (${this.blocked.reason}); run /minilfs retry`);
      let resolvedOther = await this.resolveBranchName(other);
      if (resolvedOther === "main") {
        // "main" is published, not a Branch: LayerFS merge needs a Branch, so pin a snapshot of it
        resolvedOther = `h-main-${this.shortId}-${Date.now().toString(36)}`; // does not consume seq: work-branch names stay -1, -2, …
        await this.lfs.branch.fork(resolvedOther, "main");
      } else {
        const branches = await this.listAllBranches();
        if (!branches.some((b) => b.name === resolvedOther)) throw new LayerfsError("NoSuchBranch", `no LayerFS branch named ${other} (see /minilfs branches)`);
      }

      const priorWork = this.workBranch;
      const message = `merge ${resolvedOther} into ${this.workBranch}`;
      let ours = this.workBranch;
      let theirs = resolvedOther;
      let resolved: string[] = [];
      let m: any;
      this.seq++;
      let target = `s-${this.shortId}-${this.seq}`;
      const units = mergeUnits(options.units);
      try {
        m = await this.lfs.branch.merge(ours, theirs, target, message, units);
      } catch (e: any) {
        if (e?.code !== "Conflict") throw e;
        const conflicts = conflictList(e);
        if (!options.strategy || !conflicts.length) return { merged: false, branch: this.workBranch, head: this.headCommit, conflicts, lww: 0 };
        // official recipe (no force on branch.merge): copy the winning side's version of each
        // conflicting path onto a working fork of the losing side, then merge again
        const stamp = `${this.shortId}-${Date.now().toString(36)}`;
        if (options.strategy === "theirs") {
          ours = `c-${stamp}-o`;
          await this.lfs.branch.fork(ours, this.workBranch);
          await this.copyPaths(resolvedOther, ours, conflicts, `take ${resolvedOther}'s side of conflicting files`);
        } else {
          theirs = `c-${stamp}-t`;
          await this.lfs.branch.fork(theirs, resolvedOther);
          await this.copyPaths(this.workBranch, theirs, conflicts, `keep ${this.workBranch}'s side of conflicting files`);
        }
        resolved = conflicts.map((c) => c.path);
        this.seq++;
        target = `s-${this.shortId}-${this.seq}`;
        try {
          m = await this.lfs.branch.merge(ours, theirs, target, `${message} (${options.strategy} on ${resolved.length} conflicting file(s))`, units);
        } catch (e2: any) {
          if (e2?.code !== "Conflict") throw e2;
          return { merged: false, branch: this.workBranch, head: this.headCommit, conflicts: conflictList(e2), lww: 0 };
        }
      }
      {
        // both sides ran git: keep the losing side's branch heads reachable (objects are a union)
        const gitNote = await this.keepLosingGitRefs(m, target, ours, theirs, resolvedOther).catch(async (e: any) => {
          this.log(`keeping the other side's git refs failed: ${e?.message ?? e}`);
          // it may have committed part of its work: the branch head is what the Store says now
          const b = (await this.listAllBranches()).find((x) => x.name === target);
          return { note: `both sides ran git; keeping the other side's commits failed (${e?.code ?? "Error"}), so .git is one side's only`, head: b?.head ?? null };
        });
        if (gitNote?.head) m = { ...m, head: gitNote.head };
        this.workBranch = target;
        // A fast-forward onto a branch with no Commit (a snapshot of main) answers no head: the branch is
        // then that Layer. Never keep the old head here: apply would snapshot it and revert the merge.
        let head: string | null = m.head ?? null;
        if (!head) {
          const b = (await this.listAllBranches()).find((x) => x.name === target);
          head = b?.head ?? b?.base ?? null;
        }
        this.headCommit = head;
        this.unapplied = await this.hasApplicable();
        this.persistSessionBinding();
        if (head) this.checkpoints.push({ origins: [`merge:${resolvedOther}`], label: "merge", commit: head, branch: target, changed: true, at: Date.now() });
        if (!resolvedOther.startsWith("h-main-")) this.mergedSinceApply.push(resolvedOther);

        const diffItems: any[] = [];
        for (let pos = 0; ; ) {
          const page = await this.lfs.branch.diff_branches(priorWork, resolvedOther, 1000, pos, { hunks: false }).catch(() => null);
          for (const it of page?.items ?? []) diffItems.push(it);
          if (!page?.hasMore || !(page?.items ?? []).length) break;
          pos = page.nextPagePos ?? (pos + page.items.length);
        }
        const mergedAt = Date.now();
        for (const it of diffItems) {
          if (it.type !== "dir" && this.isApplicable(it.path)) {
            const rel = it.path.replace(/^\/+/, "");
            this.touchPathsOnNextExec.add(rel);
            this.mergedFileMtimes.set(rel, mergedAt);
          }
        }

        const lwwPaths: string[] = [];
        for (const entry of (m.lww ?? [])) {
          const p = String(entry.path ?? "").replace(/^\/+/, "");
          if (p && !p.startsWith(".git/") && p !== ".git") {
            lwwPaths.push(p);
          }
        }

        return { merged: true, branch: target, head, conflicts: [], lww: (m.lww ?? []).length, lwwPaths, ...(resolved.length ? { resolved } : {}), ...(gitNote?.note ? { gitNote: gitNote.note } : {}) };
      }
    }
  }

  /**
   * Copies `paths` from branch `from` onto branch `to` as one Commit: both mounted once, each path
   * replaced whole (file, symlink or directory tree, with modes); a path missing on `from` is removed.
   * One Workspace commit, so it is atomic and has no request size limit.
   */
  private async copyPaths(from: string, to: string, paths: Array<{ path: string }>, message: string): Promise<void> {
    await this.withMountedBranch(from, false, "merge read", async (srcWs) => {
      await this.withMountedBranch(to, true, message, async (dstWs) => {
        for (const { path: rel } of paths) {
          const src = posix.join(srcWs, rel);
          const dst = posix.join(dstWs, rel);
          await this.assertInsideWs(srcWs, src, true);
          await this.assertInsideWs(dstWs, dst, true);
          await assertNotProtectedTarget(dstWs, dst, false);
          await fsp.rm(dst, { recursive: true, force: true });
          if (!(await fsp.lstat(src).catch(() => null))) continue;
          await fsp.mkdir(dirname(dst), { recursive: true });
          await fsp.cp(src, dst, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, force: true, errorOnExist: false });
        }
      });
    });
  }

  /**
   * After a merge in which both sides changed the `git` unit: the merged `.git` is the kept side's
   * whole (consistent refs, HEAD and index). The losing side's refs (loose refs and packed-refs) are
   * kept in the merged Branch: branch heads as `refs/minilfs/<label>/heads/<name>`, earlier rescues
   * `refs/minilfs/*` as they are, tags, and a detached HEAD: its commits stay reachable (gc keeps them). Only refs whose
   * objects the merged branch has (branch heads: commits); a name it already uses for another commit
   * gets `-<oid12>` appended, so nothing is overwritten or dropped. The files are already merged by LayerFS, so
   * the histories join with `git merge -s ours --no-commit <ref> && git add -A && git commit`
   * (verified: both parents recorded, tree = the merged files, fsck clean).
   */
  private async keepLosingGitRefs(m: any, target: string, ours: string, theirs: string, label: string): Promise<{ note: string; head: string | null } | undefined> {
    const unit = (m?.units ?? []).find((u: any) => u.unit === "git");
    if (!unit || !(unit.changedOurs > 0 && unit.changedTheirs > 0)) return undefined;
    // objects merge as a union, but a side that ran `git gc --prune` deleted objects the other side
    // may still name: put back every object either side has and the merge dropped
    const dropped = new Map<string, string>();
    for (const side of [ours, theirs]) {
      for (let pos = 0; ; ) {
        const page = await this.lfs.branch.diff_branches(side, target, 1000, pos, { hunks: false });
        for (const it of page.items ?? []) {
          const rel = String(it.path).replace(/^\/+/, "");
          if (it.kind === "Removed" && it.type !== "dir" && gitPathKind(rel) === "object" && !dropped.has(rel)) dropped.set(rel, side);
        }
        if (!page.hasMore || !(page.items ?? []).length) break;
        pos = page.nextPagePos ?? (pos + page.items.length);
      }
    }
    let head: string | null = null;
    for (const side of [ours, theirs]) {
      const paths = [...dropped].filter(([, s]) => s === side).map(([path]) => ({ path }));
      if (paths.length) {
        await this.copyPaths(side, target, paths, `keep git objects ${side === ours ? "this Branch" : label} still names`);
        head = this.lastStoreCommit?.head ?? head;
      }
    }
    const losing = unit.kept === "ours" ? theirs : ours;
    const keptName = unit.kept === "ours" ? "this Branch" : label;
    const lostName = unit.kept === "ours" ? label : "this Branch";
    // the repository's hash length: a 42-digit "oid" is no ref
    const cfg = await this.lfs.fs.read(target, "/.git/config", 1).then((r: any) => String(r.text ?? ""), () => "");
    const oidLen = /^\s*objectformat\s*=\s*sha256\s*$/im.test(cfg) ? 64 : 40;
    // every ref of the losing side and of the merged branch (packed-refs, then loose refs, which win), by full name
    const refs = await this.readGitRefs(losing, oidLen);
    const existing = await this.readGitRefs(target, oidLen);
    // the refs are named after the side they come from: the other Branch, or this session (the work branch before the merge)
    const safeLabel = (unit.kept === "ours" ? label : this.workBranch).replace(/[^A-Za-z0-9._-]/g, "-");
    const rawHead = (b: string) => this.lfs.fs.read(b, "/.git/HEAD").then((r: any) => String(r.text ?? "").trim(), () => "");
    const lostHead = await rawHead(losing);
    // what could be kept: plain ref names only (they are shown in a command), objects the merged
    // branch has with the right type (a branch head is a commit), in a fixed order
    const isOid = (o: string) => o.length === oidLen && /^[0-9a-f]+$/.test(o);
    // (a ref the merged branch has at the same commit needs nothing)
    const candidates = [...refs].filter(([ref, oid]) => isSafeRefName(ref) && isOid(oid) && /^refs\/(heads|tags|minilfs)\//.test(ref) && existing.get(ref) !== oid)
      .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
    const detached = isOid(lostHead) && lostHead !== (await rawHead(target));
    const needsCommit = (ref: string) => ref === "HEAD" || /^refs\/heads\//.test(ref) || /^refs\/minilfs\/[^/]+\/(heads\/|HEAD$)/.test(ref);
    const types = await this.branchObjectTypes(target, [...candidates.map(([, oid]) => oid), ...(detached ? [lostHead] : [])]);
    const verified = (ref: string, oid: string) => { const t = types.get(oid); return Boolean(t) && (!needsCommit(ref) || t === "commit"); };
    // a name the merged branch already uses for another commit is never overwritten nor skipped:
    // the commit is kept as <name>-<oid12> (or <name>-<oid>)
    const allocate = (dst: string, oid: string): string | null => {
      for (const name of [dst, `${dst}-${oid.slice(0, 12)}`, `${dst}-${oid}`]) {
        const cur = existing.get(name);
        if (cur === oid) return null; // already kept there
        if (!cur) { existing.set(name, oid); return name; }
      }
      return null;
    };
    // where each ref goes in the merged .git, so nothing the losing side could reach is dropped (each
    // merge round keeps the earlier rescues): branch heads under refs/minilfs/<label>/heads/, earlier
    // rescues (refs/minilfs/*) at the same path, tags under their name (or refs/minilfs/<label>/tags/
    // when the kept side has that tag at another commit), a detached HEAD as refs/minilfs/<label>/HEAD
    const wanted: Array<[string, string]> = [];
    const want = (dst: string, oid: string) => { const name = allocate(dst, oid); if (name) wanted.push([name, oid]); };
    const base = new Map(existing);
    for (const [ref, oid] of candidates) {
      if (!verified(ref, oid)) continue;
      if (ref.startsWith("refs/heads/")) {
        want(`refs/minilfs/${safeLabel}/heads/${ref.slice("refs/heads/".length)}`, oid);
      } else if (ref.startsWith("refs/minilfs/")) {
        want(ref, oid);
      } else {
        if (!base.get(ref)) want(ref, oid);
        else want(`refs/minilfs/${safeLabel}/tags/${ref.slice("refs/tags/".length)}`, oid);
      }
    }
    if (detached && verified("HEAD", lostHead)) want(`refs/minilfs/${safeLabel}/HEAD`, lostHead);
    const ops: any[] = [];
    const kept: string[] = [];
    for (const [ref, oid] of wanted) {
      const refPath = `/.git/${ref}`;
      ops.push({ op: "mkdir", path: posix.dirname(refPath) }, { op: "write", path: refPath, bytes: Buffer.from(`${oid}\n`) });
      kept.push(ref);
    }
    if (ops.length) {
      const res = await this.lfs.fs.apply(target, ops, `keep ${lostName}'s git refs`);
      head = res.commit?.id ?? res.head ?? head;
    }

    // Join the checked-out branch's histories: one commit with both sides' heads as parents (the lead
    // side first), so `git log` of the branch shows both sides' commits. LayerFS merged the files;
    // git plumbing records it without touching the work tree (src/gitjoin.ts).
    const joined = await this.joinGitHistories(target, ours, theirs, label).catch((e: any) => {
      this.log(`joining git histories failed: ${e?.message ?? e}`);
      return null;
    });
    if (joined?.head) head = joined.head;
    const keptRefs = kept.length ? ` Its other refs are kept as ${kept.slice(0, 3).join(", ")}${kept.length > 3 ? ", …" : ""}.` : "";
    const what = joined?.result;
    if (what && (what.mode === "merged" || what.mode === "worktree")) {
      return { head, note: `both sides ran git; ${joined!.branch} now has a merge commit ${what.commit!.slice(0, 7)} with both sides' commits as parents${what.mode === "worktree" ? " (git saw conflicts; the commit records LayerFS's merged files)" : ""}.${keptRefs}` };
    }
    if (what && (what.mode === "ff" || what.mode === "uptodate")) {
      return { head, note: `both sides ran git; ${joined!.branch} ${what.mode === "ff" ? `moved forward to ${lostName}'s commits` : `already held ${lostName}'s commits`}.${keptRefs}` };
    }
    const why = what?.why ? ` (${what.why})` : "";
    if (!kept.length) return { note: `both sides ran git; .git (refs, HEAD, index) is ${keptName}'s, ${lostName}'s branch heads were already in it${why}`, head };
    return {
      head,
      note: `both sides ran git; .git (refs, HEAD, index) is ${keptName}'s; the histories could not be joined automatically${why}.${keptRefs} Join them in bash with \`${GIT_JOIN_HINT(kept.find((k) => k.includes("/heads/")) ?? kept[0])}\``,
    };
  }

  /** A git ref's commit on `branch` (loose ref, else packed-refs), or null; an oid of exactly `oidLen` digits (40 or 64 when not given). */
  private async gitRefOid(branch: string, ref: string, oidLen?: number): Promise<string | null> {
    const ok = (o: string) => (oidLen ? o.length === oidLen : o.length === 40 || o.length === 64) && /^[0-9a-f]+$/.test(o);
    const loose = await this.lfs.fs.read(branch, `/.git/${ref}`).then((r: any) => String(r.text ?? "").trim(), () => "");
    if (ok(loose)) return loose;
    for (let line = 1; line > 0; ) {
      const r: any = await this.lfs.fs.read(branch, "/.git/packed-refs", line).catch(() => null);
      if (!r) break;
      for (const l of String(r.text ?? "").split("\n")) {
        const m = /^([0-9a-f]+) (\S+)$/.exec(l.trim());
        if (m && m[2] === ref && ok(m[1])) return m[1];
      }
      line = r.truncated && r.endLine ? r.endLine + 1 : 0;
    }
    return null;
  }

  /** Every ref of `branch`'s git (packed-refs, then loose refs, which win) whose value is an oid of `oidLen` digits. */
  private async readGitRefs(branch: string, oidLen: number): Promise<Map<string, string>> {
    const refs = new Map<string, string>();
    const isOid = (o: string) => o.length === oidLen && /^[0-9a-f]+$/.test(o);
    // packed-refs can exceed one fs.read window (2000 lines / 48 KiB): page through it
    let packed = "";
    for (let line = 1; line > 0; ) {
      const r: any = await this.lfs.fs.read(branch, "/.git/packed-refs", line).catch(() => null);
      if (!r) break;
      packed += String(r.text ?? "");
      line = r.truncated && r.endLine ? r.endLine + 1 : 0;
    }
    for (const line of packed.split("\n")) {
      const mm = /^([0-9a-f]+) (refs\/.+)$/.exec(line.trim());
      if (mm && isOid(mm[1])) refs.set(mm[2], mm[1]);
    }
    const walk = async (dir: string, prefix: string) => {
      for (let pos = 0; ; ) {
        const page = await this.lfs.fs.list(branch, dir, 1000, pos).catch(() => null);
        for (const it of page?.items ?? []) {
          const sp = `${dir}/${it.name}`;
          if (it.type === "dir") await walk(sp, `${prefix}${it.name}/`);
          else if (it.type === "file") {
            const oid = await this.lfs.fs.read(branch, sp).then((r: any) => String(r.text ?? "").trim(), () => "");
            if (isOid(oid)) refs.set(`${prefix}${it.name}`, oid);
          }
        }
        if (!page?.hasMore || !(page?.items ?? []).length) break;
        pos = page.nextPagePos ?? (pos + page.items.length);
      }
    };
    await walk("/.git/refs", "refs/");
    return refs;
  }

  /**
   * The type of each of `oids` that `branch`'s git has (absent: missing), in one mount: git
   * cat-file under the session's Seatbelt profile, with a clean environment (the Branch's .git is
   * agent state).
   */
  private async branchObjectTypes(branch: string, oids: string[]): Promise<Map<string, string>> {
    const types = new Map<string, string>();
    const list = [...new Set(oids)];
    if (!list.length) return types;
    await this.withMountedBranch(branch, false, "check git objects", async (wsPath) => {
      const scratchDir = join(this.config.root, "scratch", this.projectRecord.name, "join");
      await fsp.mkdir(scratchDir, { recursive: true });
      const profile = buildSeatbeltProfile({
        wsPath, hostCwd: this.cwd, scratchDir, configRoot: this.config.root,
        excludes: this.config.excludes, outsideSecrets: OUTSIDE_SECRET_PATTERNS, network: "deny",
      });
      const r = await run("/usr/bin/sandbox-exec", ["-p", profile, "git", "--git-dir", join(wsPath, ".git"), "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
        "cat-file", "--batch-check=%(objectname) %(objecttype)"], { cwd: wsPath, env: cleanGitEnv(scratchDir), input: list.join("\n") + "\n", timeoutMs: 60_000 });
      if (r.code !== 0) throw new LayerfsError("Failed", `git cat-file failed: ${r.stderr.trim().slice(0, 160)}`);
      const lines = r.stdout.toString().split("\n");
      list.forEach((oid, i) => {
        const [name, type] = (lines[i] ?? "").split(" ");
        if (name === oid && type && type !== "missing") types.set(oid, type);
      });
    });
    return types;
  }

  /**
   * Records a merge commit of both sides' checked-out branch heads in `target`'s git (src/gitjoin.ts),
   * in one mounted step under the session's Seatbelt profile; the result is one LayerFS Commit.
   * Skips when the sides have HEAD on different branches or detached.
   */
  private async joinGitHistories(target: string, ours: string, theirs: string, label: string): Promise<{ result: JoinResult; head: string | null; branch: string } | null> {
    const headOf = async (b: string) => symbolicHead(await this.lfs.fs.read(b, "/.git/HEAD").then((r: any) => String(r.text ?? ""), () => ""));
    const refOid = (b: string, ref: string) => this.gitRefOid(b, ref);
    const [hOurs, hTheirs] = await Promise.all([headOf(ours), headOf(theirs)]);
    if (!hOurs || hOurs !== hTheirs) return { result: { mode: "skip", why: hOurs ? `the other side has ${hTheirs ?? "a detached HEAD"} checked out, not ${hOurs}` : "detached HEAD" }, head: null, branch: hOurs ?? "HEAD" };
    const [oOurs, oTheirs] = await Promise.all([refOid(ours, hOurs), refOid(theirs, hOurs)]);
    if (!oOurs || !oTheirs) return { result: { mode: "skip", why: "a side has no commit on the branch" }, head: null, branch: hOurs };
    if (oOurs === oTheirs) return { result: { mode: "uptodate", commit: oOurs }, head: null, branch: hOurs };
    const branchName = hOurs.replace(/^refs\/heads\//, "");
    const message = `Merge ${label} into ${branchName} (minilfs: LayerFS merged the files)`;
    let result: JoinResult = { mode: "fail", why: "not run" };
    await this.withMountedBranch(target, true, `git: join ${label} into ${branchName}`, async (wsPath) => {
      const scratchDir = join(this.config.root, "scratch", this.projectRecord.name, "join");
      await fsp.mkdir(scratchDir, { recursive: true });
      const profile = buildSeatbeltProfile({
        wsPath, hostCwd: this.cwd, scratchDir, configRoot: this.config.root,
        excludes: this.config.excludes, outsideSecrets: OUTSIDE_SECRET_PATTERNS, network: "deny",
      });
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH, HOME: scratchDir, TMPDIR: "/private/tmp", LANG: "C",
        GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: "minilfs", GIT_AUTHOR_EMAIL: "minilfs@localhost", GIT_COMMITTER_NAME: "minilfs", GIT_COMMITTER_EMAIL: "minilfs@localhost",
      };
      const r = await run("/usr/bin/sandbox-exec", ["-p", profile, "/bin/bash", "-c", GIT_JOIN_SCRIPT, "minilfs-join", oOurs, oTheirs, hOurs, message], { cwd: wsPath, env, timeoutMs: 120_000 });
      result = parseJoin(r.stdout.toString());
      if (result.mode === "fail") this.log(`git join: ${r.stdout.toString().slice(-300)} ${r.stderr.slice(-300)}`);
    });
    return { result, head: this.lastStoreCommit?.head ?? null, branch: branchName };
  }

  private persistSessionBinding(): void {
    if (!this.bindings || !this.projectRecord) return;
    this.bindings.setSession(this.sessionId, {
      project: this.projectRecord.name,
      cwd: this.cwd,
      baseBranch: this.baseBranch,
      workBranch: this.workBranch,
      baseRef: this.baseRef,
      headCommit: this.headCommit,
      unapplied: this.unapplied,
      seq: this.seq,
      updatedAt: Date.now(),
      logicalBranch: this.logicalBranch,
      alignedRef: this.alignedRef,
      pid: this.closed ? undefined : process.pid,
      ...(this.closed ? {} : ownStart()),
      host: hostname(),
    });
  }

  async listAllBranches(): Promise<Array<{ name: string; base: string; head: string | null }>> {
    const out: Array<{ name: string; base: string; head: string | null }> = [];
    for (let pos = 0; ; ) {
      const page = await this.lfs.project.list_branches(100, pos);
      out.push(...(page.items ?? []));
      if (!page.hasMore || !(page.items ?? []).length) break;
      pos = page.nextPagePos ?? (pos + page.items.length);
    }
    return out;
  }

  async resolveBranchName(name: string): Promise<string> {
    const trimmed = String(name ?? "").trim();
    if (!trimmed || trimmed === "main") return "main";
    this.bindings?.reload();

    const sessions = Object.values(this.bindings?.data?.sessions ?? {})
      .filter((s) => s.project === this.projectRecord?.name)
      .sort(aliasOrder());

    for (const s of sessions) {
      if (s.logicalBranch === trimmed || (s as any).sessionId === trimmed) {
        return s.workBranch;
      }
    }

    for (const s of sessions) {
      if (s.workBranch === trimmed) {
        return s.workBranch;
      }
    }

    const branches = await this.listAllBranches();
    const sm = /^(?:s-)?([a-f0-9]{8,16})(?:-(\d+))?$/.exec(trimmed);
    if (sm) {
      const shortId = sm[1];
      for (const s of sessions) {
        if (s.workBranch?.startsWith(`s-${shortId}-`)) {
          return s.workBranch;
        }
      }
      if (sm[2] && branches.some((b) => b.name === trimmed)) {
        return trimmed;
      }
      let highestBranch: string | null = null;
      let highestSeq = -1;
      for (const b of branches) {
        const bm = /^s-([a-f0-9]+)-(\d+)$/.exec(b.name);
        if (bm && bm[1] === shortId) {
          const seq = parseInt(bm[2], 10);
          if (seq > highestSeq) {
            highestSeq = seq;
            highestBranch = b.name;
          }
        }
      }
      if (highestBranch) return highestBranch;
    }

    for (const b of branches) {
      if (b.name === trimmed) return b.name;
    }
    return trimmed;
  }

  async listUserBranches(): Promise<UserBranch[]> {
    this.bindings?.reload();
    const all = await this.listAllBranches();
    const isInternal = (name: string) => /^(?:[abcrhm]|sync|test-merge)-/.test(name);
    const nonInternal = all.filter((b) => !isInternal(b.name));

    const sessions = Object.values(this.bindings?.data?.sessions ?? {})
      .filter((s) => s.project === this.projectRecord?.name);

    const sMap = new Map<string, { branch: (typeof all)[0]; seq: number }>();
    const others: typeof all = [];

    for (const b of nonInternal) {
      const m = /^s-([a-f0-9]+)-(\d+)$/.exec(b.name);
      if (m) {
        const shortId = m[1];
        const seq = parseInt(m[2], 10);
        const existing = sMap.get(shortId);
        if (!existing || seq > existing.seq) {
          sMap.set(shortId, { branch: b, seq });
        }
      } else {
        others.push(b);
      }
    }

    const branchesToShow = [...Array.from(sMap.values()).map((v) => v.branch), ...others];

    const out: UserBranch[] = [];
    for (const b of branchesToShow) {
      if (b.name === "main") continue;
      const matchingSession = sessions.find((s) => s.workBranch === b.name);
      out.push({
        name: b.name,
        base: b.base,
        head: b.head,
        logicalBranch: matchingSession?.logicalBranch || "",
        isYours: b.name === this.workBranch,
      });
    }
    return out;
  }

  toRel(hostPath: string): string | null {
    const trimmed = String(hostPath ?? "").trim();
    if (!trimmed || trimmed === "." || trimmed === "./") return "";
    const abs = resolve(this.cwd, trimmed);
    // this.cwd is the real path (/private/var/..., /private/tmp/...); agents and harnesses often
    // pass the symlinked spelling (/var/..., /tmp/..., a symlinked project folder). Accept every
    // spelling of the project root, then compute the path relative to it.
    for (const root of this.cwdSpellings) {
      const rel = relative(root, abs);
      if (rel === "") return "";
      if (!rel.startsWith("..") && !isAbsolute(rel)) return rel.split("\\").join("/");
    }
    return null;
  }

  /** The project root under every macOS spelling (real path first), computed once. */
  private get cwdSpellings(): string[] {
    if (!this._cwdSpellings) {
      const extra = this.originalCwd && this.originalCwd !== this.cwd ? [this.originalCwd] : [];
      this._cwdSpellings = [...new Set([this.cwd, ...bothSpellings(this.cwd), ...extra])];
    }
    return this._cwdSpellings;
  }
  private _cwdSpellings: string[] | null = null;

  toStorePath(hostPath: string): string | null {
    const rel = this.toRel(hostPath);
    if (rel === null) return null;
    return rel === "" ? "/" : `/${rel}`;
  }

  private mustStorePath(hostPath: string): string {
    const sp = this.toStorePath(hostPath);
    if (!sp) throw new Error(`${hostPath} is outside the LayerFS workspace (${this.cwd}); writes there are refused`);
    const rel = sp.replace(/^\/+/, "");
    if (isProtectedPath(rel)) {
      const err = new Error(`writes to ${rel} are refused for security`);
      (err as any).code = "EACCES";
      throw err;
    }
    if (isExcludedPath(rel, this.config.excludes)) {
      const err = new Error(`writes to excluded path ${rel} are refused`);
      (err as any).code = "EACCES";
      throw err;
    }
    return sp;
  }

  private async hasSymlinkInChain(storePath: string, ref = this.workBranch): Promise<boolean> {
    const parts = storePath.split("/").filter(Boolean);
    let cur = "";
    for (const part of parts) {
      cur += `/${part}`;
      const st = await this.lfs.fs.stat(ref, cur).catch(() => null);
      if (!st) return false;
      if (st.type === "symlink") return true;
    }
    return false;
  }

  /** Reads exact bytes of `storePath` at `ref` without loss. */
  async readBytesAtRef(ref: string, storePath: string, originalHostPath = storePath): Promise<Buffer> {
    const rel = storePath.replace(/^\/+/, "");
    if (rel && isExcludedPath(rel, this.config.excludes)) throw enoent(originalHostPath, "not found");

    const st = await this.lfs.fs.stat(ref, storePath).catch((e: any) => {
      if (e?.code === "NoSuchPath") return null;
      throw e;
    });
    if (!st) {
      if (await this.hasSymlinkInChain(posix.dirname(storePath), ref)) {
        return this.readBytesViaMount(ref, storePath, originalHostPath);
      }
      throw enoent(originalHostPath, "does not exist");
    }
    if (st.type === "dir") throw Object.assign(new Error(`EISDIR: ${originalHostPath} is a directory`), { code: "EISDIR" });
    if (st.type === "symlink") return this.readBytesViaMount(ref, storePath, originalHostPath);
    if (st.size === 0) return Buffer.alloc(0);

    try {
      const parts: string[] = [];
      for (let line: number | null = 1; line !== null; ) {
        const page = await this.lfs.fs.read(ref, storePath, line);
        if (page.lineTruncated) {
          return this.readBytesViaMount(ref, storePath, originalHostPath);
        }
        parts.push(page.text);
        line = page.nextLine ?? null;
      }
      const buf = Buffer.from(parts.join(""), "utf8");
      if (typeof st.size === "number" && buf.length !== st.size) {
        return this.readBytesViaMount(ref, storePath, originalHostPath);
      }
      return buf;
    } catch (e: any) {
      if (e?.code === "Binary") {
        return this.readBytesViaMount(ref, storePath, originalHostPath);
      }
      throw e;
    }
  }

  private async readBytesViaMount(ref: string, storePath: string, originalHostPath = storePath): Promise<Buffer> {
    let branchToMount = ref;
    if (ref !== this.workBranch && ref !== this.baseBranch && !ref.startsWith("b-") && !ref.startsWith("s-")) {
      branchToMount = `r-${this.shortId}-${(++this.seq)}`;
      await this.lfs.branch.fork(branchToMount, ref);
    }
    return this.withMountedBranch(branchToMount, false, "read bytes", async (wsPath) => {
      const p = posix.join(wsPath, storePath.replace(/^\/+/, ""));
      try {
        await this.assertInsideWs(wsPath, p, false);
      } catch (e: any) {
        throw enoent(originalHostPath, e.message);
      }
      return await fsp.readFile(p);
    });
  }

  /**
   * The real path of a read outside the project, or EACCES when it (as named, or after symlinks) is
   * minilfs's private state (the store worker's endpoint secret, Stores, bindings), the bundle, a
   * configured exclude or a $HOME credential. Seatbelt guards bash; the file tools run in this
   * process and need this check themselves.
   */
  async resolveOutsideRead(hostPath: string): Promise<string> {
    const abs = resolve(this.cwd, hostPath);
    const real = await realpathNearest(abs);
    for (const p of [abs, real]) {
      if (isPrivateMinilfsPath(p, this.config) || isOutsideSecret(p, this.config.excludes)) {
        const err = new Error(`cannot read ${hostPath}: secret file outside the project is not readable`);
        (err as any).code = "EACCES";
        throw err;
      }
    }
    return real;
  }

  /** Seatbelt profile for outside reads: minilfs's root and the bundle denied whole (nothing re-allowed), secrets as for bash. */
  private outsideReadProfile(): string {
    this._outsideReadProfile ??= buildSeatbeltProfile({
      wsPath: "/dev/null", hostCwd: this.cwd, scratchDir: "/dev/null", configRoot: this.config.root, extraDenyRoots: [this.config.bundle],
      excludes: this.config.excludes, outsideSecrets: OUTSIDE_SECRET_PATTERNS, network: "deny",
    });
    return this._outsideReadProfile;
  }
  private _outsideReadProfile: string | null = null;

  /**
   * Does one outside read in a short-lived process under Seatbelt. resolveOutsideRead alone is
   * check-then-use: an ancestor swapped for a symlink between the check and the open would carry
   * the read into minilfs's root; the kernel checks the path it actually opens.
   */
  private async runOutsideRead(op: "read" | "access" | "isDir" | "readdir", hostPath: string): Promise<Buffer> {
    await this.resolveOutsideRead(hostPath); // fast refusal, also for paths that do not exist yet
    const abs = resolve(this.cwd, hostPath); // not the realpath: the kernel resolves symlinks at open
    const r = await run("/usr/bin/sandbox-exec", ["-p", this.outsideReadProfile(), "/usr/bin/perl", "-e", OUTSIDE_READ_PL, op, abs], {
      env: { PATH: "/usr/bin:/bin", LANG: "C" }, timeoutMs: 120_000,
    });
    if (r.code === 0) return r.stdout;
    const m = /^([A-Z][A-Z0-9]*):(.*)$/m.exec(r.stderr);
    const code = m ? (m[1] === "EPERM" ? "EACCES" : m[1]) : "EIO";
    throw Object.assign(new Error(`${code}: ${m ? m[2] : r.stderr.trim().slice(0, 200) || `exit ${r.code}`} (${hostPath})`), { code });
  }

  async readFile(hostPath: string): Promise<Buffer> {
    const sp = this.toStorePath(hostPath);
    if (!sp) return this.runOutsideRead("read", hostPath);
    return this.readBytesAtRef(this.workBranch, sp, hostPath);
  }

  async access(hostPath: string, write = false): Promise<void> {
    const sp = this.toStorePath(hostPath);
    if (!sp) {
      if (write) this.mustStorePath(hostPath);
      await this.runOutsideRead("access", hostPath);
      return;
    }
    const rel = sp.replace(/^\/+/, "");
    if (rel && isExcludedPath(rel, this.config.excludes)) throw enoent(hostPath, "not accessible");
    const st = await this.lfs.fs.stat(this.workBranch, sp).catch(() => null);
    if (st) return;
    if (await this.hasSymlinkInChain(posix.dirname(sp), this.workBranch)) {
      await this.withMountedBranch(this.workBranch, false, "access", async (wsPath) => {
        const p = posix.join(wsPath, rel);
        await this.assertInsideWs(wsPath, p, false);
        await fsp.access(p, write ? (fsc.R_OK | fsc.W_OK) : fsc.R_OK);
      });
      return;
    }
    throw enoent(hostPath, "not accessible");
  }

  async exists(hostPath: string): Promise<boolean> {
    const sp = this.toStorePath(hostPath);
    if (!sp) {
      // a denied path does not exist for the agent (no EACCES that would confirm it is there)
      return this.access(hostPath, false).then(() => true, () => false);
    }
    const rel = sp.replace(/^\/+/, "");
    if (rel && isExcludedPath(rel, this.config.excludes)) return false;
    const st = await this.lfs.fs.stat(this.workBranch, sp).catch(() => null);
    if (st) return true;
    if (await this.hasSymlinkInChain(posix.dirname(sp), this.workBranch)) {
      return this.withMountedBranch(this.workBranch, false, "exists", async (wsPath) => {
        const p = posix.join(wsPath, rel);
        await this.assertInsideWs(wsPath, p, false);
        return await fsp.access(p).then(() => true, () => false);
      });
    }
    return false;
  }

  async isDirectory(hostPath: string): Promise<boolean> {
    const sp = this.toStorePath(hostPath);
    if (!sp) return (await this.runOutsideRead("isDir", hostPath)).toString() === "1";
    const rel = sp.replace(/^\/+/, "");
    if (rel && isExcludedPath(rel, this.config.excludes)) throw enoent(hostPath, "no such file or directory");
    const st = await this.lfs.fs.stat(this.workBranch, sp).catch(() => null);
    if (st) {
      if (st.type === "dir") return true;
      if (st.type === "file") return false;
    }
    return this.withMountedBranch(this.workBranch, false, "isDirectory", async (wsPath) => {
      const p = posix.join(wsPath, rel);
      await this.assertInsideWs(wsPath, p, false);
      const s = await fsp.stat(p).catch((e) => { throw enoent(hostPath, e.message); });
      return s.isDirectory();
    });
  }

  async readdir(hostPath: string): Promise<string[]> {
    const sp = this.toStorePath(hostPath);
    if (!sp) {
      const b = await this.runOutsideRead("readdir", hostPath);
      return b.length ? b.toString("utf8").split("\0") : [];
    }
    try {
      const names: string[] = [];
      for (let pos = 0; ; ) {
        const page = await this.lfs.fs.list(this.workBranch, sp, 1000, pos);
        for (const it of page.items ?? []) {
          if (it.name !== ".lww" && !isExcludedPath(posix.join(sp.replace(/^\/+/, ""), it.name), this.config.excludes)) {
            names.push(it.name);
          }
        }
        if (!page.hasMore || !(page.items ?? []).length) break;
        pos = page.nextPagePos ?? (pos + page.items.length);
      }
      return names.sort();
    } catch (e: any) {
      if (e?.code === "NotDirectory" || e?.code === "NoSuchPath") {
        const rel = sp.replace(/^\/+/, "");
        return this.withMountedBranch(this.workBranch, false, "readdir", async (wsPath) => {
          const dir = posix.join(wsPath, rel);
          await this.assertInsideWs(wsPath, dir, false);
          const entries = await fsp.readdir(dir).catch(() => []);
          return entries.filter((n) => n && n !== ".lww" && !isExcludedPath(rel ? `${rel}/${n}` : n, this.config.excludes)).sort();
        });
      }
      throw e;
    }
  }

  async mkdir(hostPath: string): Promise<void> {
    this.mustStorePath(hostPath);
  }

  async writeFile(hostPath: string, content: string | Buffer): Promise<void> {
    const sp = this.mustStorePath(hostPath);
    const bytes = Buffer.from(content);
    const hasLink = await this.hasSymlinkInChain(sp, this.workBranch);
    if (!hasLink) {
      const parent = posix.dirname(sp);
      const ops: any[] = parent !== "/" ? [{ op: "mkdir", path: parent }, { op: "write", path: sp, bytes }] : [{ op: "write", path: sp, bytes }];
      const msg = `pi write [${this.pendingOrigins.join(",") || "write"}]`.slice(0, 4000);
      const res = await this.lfs.fs.apply(this.workBranch, ops, msg);
      this.recordStoreCommit({ kind: res.kind, head: res.commit?.id ?? res.head ?? null }, "write");
      return;
    }
    const rel = sp.replace(/^\/+/, "");
    await this.withMountedBranch(this.workBranch, true, `pi write [${this.pendingOrigins.join(",") || "write"}]`, async (wsPath) => {
      const p = posix.join(wsPath, rel);
      await this.assertInsideWs(wsPath, p, false);
      await assertNotProtectedTarget(wsPath, p, true);
      await fsp.mkdir(dirname(p), { recursive: true });
      await fsp.writeFile(p, bytes);
    });
  }

  // ---------------------------------------------------------------- Store-backed find & hybrid grep

  async findFiles(pattern: string, searchCwd: string, options: { ignore: string[]; limit: number }): Promise<string[]> {
    const baseSp = this.toStorePath(searchCwd);
    if (!baseSp) throw new Error(`${searchCwd} is outside the LayerFS workspace`);
    const expanded = expandBraces(pattern);
    const out: string[] = [];
    const walk = async (dirSp: string, relFromSearch: string) => {
      if (out.length >= options.limit) return;
      for (let pos = 0; ; ) {
        const page = await this.lfs.fs.list(this.workBranch, dirSp, 1000, pos);
        for (const it of page.items ?? []) {
          if (out.length >= options.limit) return;
          if (it.name === ".git" || it.name === "node_modules" || it.name === ".lww") continue;
          const repoRel = it.path.replace(/^\/+/, "");
          if (isExcludedPath(repoRel, this.config.excludes)) continue;
          const rel = relFromSearch ? `${relFromSearch}/${it.name}` : it.name;
          if (options.ignore.some((g) => posix.matchesGlob(rel, g))) continue;
          if (it.type === "dir") {
            await walk(it.path, rel);
          } else if (expanded.some((pat) => matchesToolGlob(rel, pat))) {
            out.push(join(searchCwd, rel));
          }
        }
        if (!page.hasMore || !(page.items ?? []).length) break;
        pos = page.nextPagePos ?? (pos + page.items.length);
      }
    };
    await walk(baseSp, "");
    return out;
  }

  async grepWorkspace(params: { pattern: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number }): Promise<{ lines: string[]; matches: number; limitReached: boolean }> {
    const targetHost = resolve(this.cwd, params.path ?? ".");
    const sp = this.toStorePath(targetHost);
    if (!sp) throw new Error(`${params.path} is outside the LayerFS workspace`);
    const limit = Math.max(1, params.limit ?? 100);
    const isPlainLiteral = (params.literal === true || !/[\\^$.|?*+()[\]{}]/.test(params.pattern)) && !params.ignoreCase && !(params.context && params.context > 0);
    const globPatterns = params.glob ? expandBraces(params.glob) : null;

    if (isPlainLiteral) {
      const lines: string[] = [];
      let matches = 0;
      const prefix = sp === "/" ? "" : `${sp}/`;
      for (let pos = 0; ; ) {
        const page = await this.lfs.fs.grep(this.workBranch, params.pattern, sp, 500, pos);
        for (const m of page.items ?? []) {
          const repoRel = m.path.replace(/^\/+/, "");
          if (repoRel === ".lww" || repoRel.startsWith(".git/") || repoRel.includes("/node_modules/") || repoRel.startsWith("node_modules/") || isExcludedPath(repoRel, this.config.excludes)) continue;
          const display = sp === "/" ? repoRel : m.path === sp ? posix.basename(sp) : m.path.startsWith(prefix) ? m.path.slice(prefix.length) : repoRel;
          if (globPatterns && !globPatterns.some((g) => matchesToolGlob(display, g))) continue;
          if (matches >= limit) return { lines, matches, limitReached: true };
          lines.push(`${display}:${m.line}: ${String(m.text).replace(/\r?\n$/, "")}`);
          matches++;
        }
        if (!page.hasMore || !(page.items ?? []).length) break;
        pos = page.nextPagePos ?? (pos + page.items.length);
      }
      return { lines, matches, limitReached: false };
    }

    return this.withMountedBranch(this.workBranch, false, "grep", async (wsPath) => {
      const rel = sp.replace(/^\/+/, "");
      const targetWs = rel ? posix.join(wsPath, rel) : wsPath;
      const flags = [
        "-rnIH", "--exclude=.lww", "--exclude-dir=.git", "--exclude-dir=node_modules",
        params.ignoreCase ? "-i" : "", params.literal ? "-F" : "-E",
        params.context ? `-C${Math.floor(params.context)}` : "",
        ...(globPatterns ? globPatterns.map((g) => `--include=${g}`) : []),
      ].filter(Boolean);
      const isDir = await this.isDirectory(targetHost);
      const scratchDir = join(this.config.root, "scratch", this.projectRecord.name, "grep");
      await fsp.mkdir(scratchDir, { recursive: true });
      const profile = buildSeatbeltProfile({
        wsPath,
        hostCwd: this.cwd,
        scratchDir,
        configRoot: this.config.root,
        excludes: this.config.excludes,
        outsideSecrets: OUTSIDE_SECRET_PATTERNS,
        network: "deny",
      });
      const args = [
        "-p", profile,
        "grep",
        ...flags,
        "-e", params.pattern,
        isDir ? "." : basename(targetWs),
      ];
      const r = await run("/usr/bin/sandbox-exec", args, { cwd: isDir ? targetWs : dirname(targetWs) });
      if (r.code === 1) return { lines: [], matches: 0, limitReached: false };
      if (r.code !== 0) throw new Error(r.stderr.trim() || "grep failed");
      const lines: string[] = [];
      let matches = 0;
      let limitReached = false;
      for (const raw of r.stdout.toString().split("\n")) {
        if (!raw) continue;
        const clean = raw.replace(/^\.\//, "");
        if (/^.+?:\d+:/.test(clean)) {
          if (matches >= limit) { limitReached = true; break; }
          matches++;
        }
        lines.push(clean.replace(/^(.+?):(\d+):/, "$1:$2: ").replace(/^(.+?)-(\d+)-/, "$1-$2- "));
      }
      return { lines, matches, limitReached };
    });
  }

  // ---------------------------------------------------------------- on-demand Workspace mount & bash executor

  private async assertInsideWs(wsReal: string, candidate: string, allowFinalSymlink = false): Promise<void> {
    await assertInsideWorkspace(wsReal, candidate, allowFinalSymlink);
  }

  /**
   * The Sandbox this session mounts in (official v1.1.0: `workspace.mount(sandbox, branch)` names its
   * Sandbox and never starts one). Picks a running Sandbox of the project with room
   * (`project.list_sandboxes`, < 16 Workspaces), else `sandbox.create()` under the project's
   * sandbox lock, so concurrent sessions share Sandboxes instead of each starting one.
   */
  async ensureSandbox(options: { avoid?: string | null } = {}): Promise<{ sandbox: string; created: boolean }> {
    const avoid = options.avoid ?? null;
    if (this.sandboxId && this.sandboxId !== avoid) return { sandbox: this.sandboxId, created: false };
    // a running Sandbox of the project with room, fewest Workspaces first; never the one that refused
    const pick = async (): Promise<string | null> => {
      const page = await this.lfs.project.list_sandboxes(100, 0);
      const ok = (page.items ?? []).filter((s: any) => s.sandbox !== avoid && (s.workspaces ?? 0) < SANDBOX_CAPACITY);
      ok.sort((a: any, b: any) => (a.workspaces ?? 0) - (b.workspaces ?? 0) || Number(a.sandbox) - Number(b.sandbox));
      return ok[0]?.sandbox ?? null;
    };
    let id = await pick();
    let created = false;
    if (!id) {
      ({ id, created } = await this.bindings.withProjectLock(`_sandbox-${this.projectRecord.name}`, async () => {
        // another session may have created one while we waited for the lock
        const again = await pick();
        if (again) return { id: again, created: false };
        try {
          return { id: (await this.lfs.sandbox.create()).sandbox as string, created: true };
        } catch (e: any) {
          if (e?.code !== "Busy") throw e;
          await new Promise((r) => setTimeout(r, 300)); // Busy: another create of this project runs; once
          return { id: (await this.lfs.sandbox.create()).sandbox as string, created: true };
        }
      }, 120_000));
    }
    this.sandboxId = id;
    return { sandbox: id!, created };
  }

  /**
   * Mounts a Workspace of `branch` (`workspace.mount(sandbox, branch)`) and records it twice: in
   * `this.mounts` (released by `close()`) and as a lease file (reclaimed by the next session if this
   * process dies without cleanup). A Sandbox that closed itself (NoSuchSandbox) or is full (Capacity)
   * is replaced once by another (or a new) Sandbox.
   */
  private async mountWorkspace(branch: string): Promise<{ ws: Workspace; wsReal: string }> {
    let ws: Workspace;
    let box = await this.ensureSandbox();
    try {
      ws = await this.lfs.workspace.mount(box.sandbox, branch);
    } catch (e: any) {
      if (e?.code !== "NoSuchSandbox" && e?.code !== "Capacity") throw e;
      // a Sandbox closes itself 2 min after its last Workspace: take another running one, else a new one
      this.log(`Sandbox ${box.sandbox} refused the mount (${e.code}); using another Sandbox`);
      box = await this.ensureSandbox({ avoid: box.sandbox });
      try {
        ws = await this.lfs.workspace.mount(box.sandbox, branch);
      } catch (e2) {
        // a Sandbox this call started and could not use: stop it now instead of waiting for its idle timer
        if (box.created) {
          await this.lfs.sandbox.close(box.sandbox).catch(() => {});
          if (this.sandboxId === box.sandbox) this.sandboxId = null;
        }
        throw e2;
      }
    }
    // synchronous until the lease is on disk: a reused slot path must not look orphaned meanwhile
    const wsReal = (() => { try { return realpathSync(ws.path); } catch { return ws.path; } })();
    this.mounts.set(ws.path, { ws, wsReal });
    try { this.leases.add(this.projectRecord.name, ws, wsReal); } catch (e: any) { this.log(`mount lease not written: ${e?.message ?? e}`); }
    return { ws, wsReal };
  }

  /**
   * Ends a Workspace so that neither the OS mount nor the daemon's Workspace slot leaks:
   * reap holders, unmount (`discard` as asked), then retry once with discard, then force the
   * OS unmount. The lease stays when LayerFS still holds the Workspace, so a later session retries.
   */
  private async releaseWorkspace(ws: Workspace, wsReal: string, discard: boolean, owner = process.pid, lfs = this.lfs): Promise<void> {
    await this.reapHolders(wsReal).catch(() => {});
    let err: any = null;
    let gone = false;
    for (const d of discard ? [true] : [false, true]) {
      try {
        await lfs.workspace.unmount(ws, d);
        err = null;
        break;
      } catch (e: any) {
        err = e;
        if (e?.code === "NotMounted" || e?.code === "NoSuchSandbox") { err = null; gone = true; break; }
        if (!d) this.log(`unmount ${ws.path} refused (${e?.code ?? e?.message}); retrying with discard`);
        await this.reapHolders(wsReal).catch(() => {});
      }
    }
    this.mounts.delete(ws.path);
    if (err) this.log(`unmount ${ws.path} failed (${err?.code ?? "Error"}: ${String(err?.message ?? err).slice(0, 200)}); forcing the OS unmount`);
    // also after NotMounted/NoSuchSandbox: a daemon that died leaves its NFS mount in the OS table.
    // Skip when a live process has mounted a new Workspace at this path meanwhile (its lease replaced ours).
    const current = this.leases?.read(ws.path);
    if ((err || gone) && (!current || current.pid === owner)) await forceUnmount(wsReal);
    if (!err) this.leases?.remove(ws.path, owner);
  }

  /**
   * Unmounts Workspaces left by processes that died while one was mounted (found by their lease),
   * for every project under this root: a project nobody reopens would otherwise keep its daemon.
   * Their changes were never committed, so they are discarded.
   */
  private async reclaimOrphanMounts(): Promise<number> {
    if (!this.leases || !this.spec || !this.bindings) return 0;
    if (this.leases.orphans().length === 0) return 0;
    // one reclaimer at a time, so two sessions never unmount the same path twice
    return this.bindings.withProjectLock("_mounts", () => this.reclaimOrphanMountsLocked(), 15_000);
  }

  private async reclaimOrphanMountsLocked(): Promise<number> {
    let n = 0;
    const clients = new Map<string, any>();
    for (const lease of this.leases.orphans()) {
      // re-check right before acting: another session may have reclaimed it meanwhile
      if (!isOrphan(this.leases.read(lease.path))) continue;
      let lfs = lease.project === this.projectRecord?.name ? this.lfs : clients.get(lease.project);
      if (!lfs) {
        const record = this.bindings.byName(lease.project);
        if (!record) { this.leases.remove(lease.path, lease.pid); continue; }
        lfs = (await createProjectClient(this.spec, record)).lfs;
        clients.set(lease.project, lfs);
      }
      this.log(`reclaiming Workspace ${lease.path} left by exited process ${lease.pid}`);
      await this.releaseWorkspace({ sandbox: lease.sandbox, path: lease.path }, lease.wsReal, true, lease.pid, lfs);
      n++;
    }
    for (const c of clients.values()) { try { await c.close?.(); } catch {} }
    return n;
  }

  /** Mounts `branch`, runs `fn`, optionally commits, reaps holders of `ws.path`, and unmounts immediately. */
  private async withMountedBranch<T>(
    branch: string,
    commitAfter: boolean,
    message: string,
    fn: (wsPath: string, ws: Workspace) => Promise<T>,
  ): Promise<T> {
    const { ws, wsReal: wsPath } = await this.mountWorkspace(branch);
    let keepMounted = false;
    try {
      let value!: T;
      let fnErr: unknown = null;
      let failed = false;
      try { value = await fn(wsPath, ws); } catch (e) { fnErr = e; failed = true; }
      if (commitAfter) {
        // one commit, whatever fn did: a second one after a failed commit could resend a landed one
        try {
          await this.commitWorkspaceOnce(ws, branch, failed ? `${message} (failed)` : message, message);
        } catch (ce) {
          keepMounted = true;
          if (!failed) { fnErr = ce; failed = true; }
        }
      }
      if (failed) throw fnErr;
      return value;
    } finally {
      if (!keepMounted) await this.releaseWorkspace(ws, wsPath, !commitAfter);
    }
  }

  /**
   * `workspace.commit` exactly once (it is not idempotent). When it fails, the branch head tells
   * whether it landed anyway (a lost reply): then it is recorded as made; else the session is blocked
   * with the Workspace held for /minilfs retry, and the error is thrown.
   */
  private async commitWorkspaceOnce(ws: Workspace, branch: string, message: string, label: string): Promise<void> {
    // read from the Store, not headCommit (which may name a Layer): compared with the same read below
    const headOf = () => this.lfs.branch.list_commits(branch, 1, 0).then((p: any) => (p?.items?.[0]?.id ?? null) as string | null);
    const before = await headOf().catch(() => undefined);
    let rec: { kind: string; head: string | null };
    try {
      const res = await this.lfs.workspace.commit(ws, message.slice(0, 4000));
      rec = { kind: res.kind, head: res.commit?.id ?? res.head ?? null };
    } catch (ce: any) {
      const now = before === undefined ? null : await headOf().catch(() => null);
      if (!now || now === before) {
        this.blocked = { reason: `${ce?.code ?? "Error"}: ${String(ce?.message ?? ce).slice(0, 200)}`, heldWs: ws };
        throw ce;
      }
      this.log(`workspace commit answered ${ce?.code ?? "Error"} but landed as ${now}`);
      rec = { kind: "Committed", head: now };
    }
    // a commit on another branch (a merge fork, a sync branch) is no checkpoint of this session
    if (branch === this.workBranch) this.recordStoreCommit(rec, label);
    else this.lastStoreCommit = rec;
  }

  /** Runs a shell snippet in a short-lived Workspace of `workBranch` (read-only helper for tests/apply). */
  async sh(script: string, args: string[] = []): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return this.withMountedBranch(this.workBranch, false, "sh", async (wsPath) => {
      const rewrittenArgs = args.map((a) => (a === this.cwd ? wsPath : a.startsWith(`${this.cwd}/`) ? posix.join(wsPath, a.slice(this.cwd.length + 1)) : a));
      const scratchDir = join(this.config.root, "scratch", this.projectRecord.name, "sh");
      await fsp.mkdir(scratchDir, { recursive: true });
      const profile = buildSeatbeltProfile({
        wsPath,
        hostCwd: this.cwd,
        scratchDir,
        configRoot: this.config.root,
        excludes: this.config.excludes,
        outsideSecrets: OUTSIDE_SECRET_PATTERNS,
        network: "allow",
      });
      const r = await run("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", script, "_", ...rewrittenArgs], { cwd: wsPath });
      return { code: r.code, stdout: r.stdout.toString(), stderr: r.stderr };
    });
  }

  /**
   * Mounts a Workspace for this command, delegates execution to `this.driver` (macOS Seatbelt +
   * NFSv3 by default, or a pluggable remote/distributed Sandbox driver), commits any file changes,
   * reaps holders of this Workspace path, and unmounts immediately.
   */
  async exec(
    command: string,
    hostCwd: string,
    options: { onData: (d: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv },
  ): Promise<{ exitCode: number | null }> {
    if (options.signal?.aborted) throw new Error("aborted");
    // one controller per call, linked to the caller's signal, so close() can stop it too
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const running = this.execOnce(command, hostCwd, { ...options, signal: ctl.signal });
    this.activeExecs.set(ctl, running);
    try {
      return await running;
    } finally {
      this.activeExecs.delete(ctl);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  private async execOnce(
    command: string,
    hostCwd: string,
    options: { onData: (d: Buffer) => void; signal: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv },
  ): Promise<{ exitCode: number | null }> {
    const branch = this.workBranch;
    const { ws, wsReal } = await this.mountWorkspace(branch);
    // Everything after the mount sits inside this try, so a throw anywhere still releases the Workspace.
    let keepMounted = false;
    let execErr: unknown = null;
    try {
      await this.restoreMergedMtimes(wsReal);

      const scratchDir = join(this.config.root, "scratch");
      const branchScratchDir = join(scratchDir, this.projectRecord.name, "branches", this.logicalBranch);
      const sharedCacheDir = join(scratchDir, this.projectRecord.name, "shared");
      const relCwd = this.toRel(hostCwd);
      const runCwd = relCwd ? join(wsReal, relCwd) : wsReal;
      const lwwContent = LWW_DEFAULT + this.config.branchOnly.map((p) => `${p}\n`).join("");

      let code: number | null = null;
      try {
        const res = await this.driver.execInWorkspace({
          ws,
          wsReal,
          hostCwd: this.cwd,
          runCwd,
          scratchDir,
          branchScratchDir,
          sharedCacheDir,
          config: this.config,
          projectName: this.projectRecord.name,
          logicalBranch: this.logicalBranch,
          outsideSecrets: OUTSIDE_SECRET_PATTERNS,
          lwwContent,
          command,
          options,
        });
        code = res.exitCode;
      } catch (e) {
        execErr = e;
      }

      // a command stopped mid-way (timeout, abort) can leave git's lock files: the Branch's git would
      // refuse every later command ("index.lock exists"). Nothing runs in the Workspace any more.
      if (execErr || code === 124 || code === null) await removeGitLeftovers(wsReal).catch(() => {});
      const msg = `pi bash (exit ${code ?? "sig"}) [${this.pendingOrigins.join(",") || "bash"}]`.slice(0, 4000);
      try {
        await this.commitWorkspaceOnce(ws, branch, msg, "bash");
      } catch {
        keepMounted = true; // blocked, the Workspace held for /minilfs retry
      }
      if (execErr) throw execErr;
      return { exitCode: code };
    } catch (e) {
      execErr ??= e;
      throw e;
    } finally {
      if (!keepMounted) {
        // after a Commit nothing in the Workspace is worth keeping; before one (setup failed) nothing was made yet
        const u = this.releaseWorkspace(ws, wsReal, true);
        if (options.signal?.aborted || Boolean(execErr)) this.pendingUnmounts.add(u.finally(() => this.pendingUnmounts.delete(u)));
        else await u;
      }
    }
  }

  /** Gives files brought in by a merge a fresh mtime, so build tools see them as changed. */
  private async restoreMergedMtimes(wsReal: string): Promise<void> {
    if (this.touchPathsOnNextExec.size === 0 && this.mergedFileMtimes.size === 0) return;
    const nowMs = Date.now();
    for (const p of this.touchPathsOnNextExec) {
      if (!this.mergedFileMtimes.has(p)) this.mergedFileMtimes.set(p, nowMs);
    }
    this.touchPathsOnNextExec.clear();
    for (const [p, mergedAt] of this.mergedFileMtimes.entries()) {
      const full = join(wsReal, p);
      try {
        await this.assertInsideWs(wsReal, full, true);
        const st = await fsp.lstat(full).catch(() => null);
        if (st && st.mtimeMs < mergedAt && typeof fsp.lutimes === "function") {
          const d = new Date(mergedAt);
          await fsp.lutimes(full, d, d).catch(() => {});
        }
      } catch {}
    }
  }

  /** Removes the per-project scratch build cache directory (`<root>/scratch/<project>`). */
  async cleanScratch(): Promise<{ removedPath: string }> {
    const target = join(this.config.root, "scratch", this.projectRecord?.name || "");
    await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
    return { removedPath: target };
  }

  /** Kills processes still using the Workspace mount (the driver's reaper, one implementation). */
  private async reapHolders(wsPath: string): Promise<void> {
    await this.driver.reapWorkspaceHolders?.(wsPath);
  }

  // ---------------------------------------------------------------- mutation queue & checkpoint gate

  private recordStoreCommit(res: { kind: string; head: string | null }, defaultLabel: string): void {
    this.lastStoreCommit = res;
    if (!this.inMutate && res.kind === "Committed") {
      const cp: Checkpoint = {
        origins: [defaultLabel],
        label: defaultLabel,
        commit: res.head,
        branch: this.workBranch,
        changed: true,
        at: Date.now(),
      };
      this.headCommit = res.head;
      this.unapplied = true;
      this.checkpoints.push(cp);
      this.persistSessionBinding();
    }
  }

  mutate<T>(origin: string, label: string, fn: () => Promise<T>): Promise<{ value: T; checkpoint: Checkpoint | null; error: Error | null }> {
    const job = this.mutex.then(async () => {
      if (this.blocked) {
        throw new Error(`minilfs checkpoint failed earlier (${this.blocked.reason}); changes are blocked until /minilfs retry succeeds`);
      }
      this.inMutate = true;
      this.pendingOrigins.push(origin);
      this.lastStoreCommit = null;
      let value: T;
      let fnError: unknown = null;
      try {
        value = await fn();
      } catch (e) {
        fnError = e;
      } finally {
        this.inMutate = false;
      }
      const cp = await this.finalizeCheckpoint(label);
      if (fnError) throw fnError;
      return { value: value!, ...cp };
    });
    this.mutex = job.catch(() => {});
    return job;
  }

  private async finalizeCheckpoint(label: string): Promise<{ checkpoint: Checkpoint | null; error: Error | null }> {
    if (this.blocked) {
      return { checkpoint: null, error: new Error(this.blocked.reason) };
    }
    const res = this.lastStoreCommit;
    this.lastStoreCommit = null;
    if (!res || res.kind === "UpToDate") {
      this.pendingOrigins = [];
      return { checkpoint: null, error: null };
    }
    if (res.kind === "Committed") {
      const cp: Checkpoint = {
        origins: [...this.pendingOrigins],
        label,
        commit: res.head,
        branch: this.workBranch,
        changed: true,
        at: Date.now(),
      };
      this.headCommit = res.head;
      this.unapplied = true;
      this.pendingOrigins = [];
      this.checkpoints.push(cp);
      this.persistSessionBinding();
      return { checkpoint: cp, error: null };
    }
    return { checkpoint: null, error: null };
  }

  async retry(): Promise<{ checkpoint: Checkpoint | null; error: Error | null }> {
    const job = this.mutex.then(async () => {
      if (!this.blocked) return { checkpoint: null, error: null };
      const held = this.blocked.heldWs;
      if (held) {
        try {
          const res = await this.lfs.workspace.commit(held, `retry [${this.pendingOrigins.join(",") || "retry"}]`);
          this.blocked = null;
          await this.releaseWorkspace(held, this.mounts.get(held.path)?.wsReal ?? held.path, true);
          this.lastStoreCommit = { kind: res.kind, head: res.commit?.id ?? res.head ?? null };
          return await this.finalizeCheckpoint("retry");
        } catch (e: any) {
          this.blocked = { reason: `${e?.code ?? "Error"}: ${String(e?.message ?? e).slice(0, 200)}`, heldWs: held };
          return { checkpoint: null, error: e };
        }
      }
      this.blocked = null;
      return { checkpoint: null, error: null };
    });
    this.mutex = job.catch(() => {});
    return job;
  }

  async diff(): Promise<Array<{ path: string; kind: string; type: string }>> {
    const items: Array<{ path: string; kind: string; type: string }> = [];
    for (let pos = 0; ; ) {
      const page = await this.lfs.branch.diff_branches(this.baseBranch, this.workBranch, 1000, pos, { hunks: false });
      for (const it of page.items ?? []) {
        if (it.path === "/.lww") continue;
        items.push({ path: it.path, kind: it.kind, type: it.type });
      }
      if (!page.hasMore || !(page.items ?? []).length) break;
      pos = page.nextPagePos ?? (pos + page.items.length);
    }
    return items;
  }

  /** Signature (content + exec bit, or link target) of `rel` at `branch`. One short mount reads both. */
  private async readSigAtBranch(branch: string, rel: string): Promise<HostEntry | null> {
    const sp = `/${rel}`;
    const st = await this.lfs.fs.stat(branch, sp).catch(() => null);
    if (!st || st.type === "dir") return null;
    return this.withMountedBranch(branch, false, "read base", async (wsPath) => {
      const p = posix.join(wsPath, rel);
      await this.assertInsideWs(wsPath, p, true);
      const lst = await fsp.lstat(p).catch(() => null);
      if (!lst) return null;
      if (lst.isSymbolicLink()) {
        const target = await fsp.readlink(p);
        return linkSig(target);
      }
      const data = await fsp.readFile(p);
      return fileSig(data, lst.mode);
    });
  }

  /** The content of many paths on `branch`, read in one mount (absent paths map to null). */
  private async readRawEntriesAtBranch(branch: string, rels: string[]): Promise<Map<string, RawEntry>> {
    const out = new Map<string, RawEntry>();
    return this.withMountedBranch(branch, false, "read base", async (wsPath) => {
      for (const rel of rels) {
        const p = posix.join(wsPath, rel);
        await this.assertInsideWs(wsPath, p, true);
        out.set(rel, await readRawEntry(p));
      }
      return out;
    });
  }

  async apply(options: { allowRevert?: boolean } = {}): Promise<ApplyResult> {
    const job = this.mutex.then(() => this.applyLocked(options));
    this.mutex = job.catch(() => {});
    return job;
  }

  private async applyLocked(options: { allowRevert?: boolean }): Promise<ApplyResult> {
    if (this.blocked) {
      throw new Error(`cannot apply while a checkpoint is pending (${this.blocked.reason}); run /minilfs retry`);
    }
    return this.bindings.withProjectLock(this.projectRecord.name, async (guard) => {
      const result: ApplyResult = { applied: [], skipped: [], conflicts: [], unchanged: [], warnings: [] };
      const snapRef = this.headCommit ?? this.baseRef;
      this.seq++;
      const snapBranch = `a-${this.shortId}-${this.seq}`;
      const snap = await this.lfs.branch.fork(snapBranch, snapRef);

      const items: Array<{ path: string; kind: string; type: string }> = [];
      for (let pos = 0; ; ) {
        const page = await this.lfs.branch.diff_branches(this.baseBranch, snapBranch, 1000, pos, { hunks: false });
        for (const it of page.items ?? []) {
          if (it.type !== "dir" && !this.isBranchOnly(it.path)) {
            items.push({ path: it.path, kind: it.kind, type: it.type });
          } else if (it.before && it.before.type !== "dir" && !this.isBranchOnly(it.path)) {
            // a file that became a folder (refs/heads/foo -> refs/heads/foo/bar): the file is removed
            items.push({ path: it.path, kind: "Removed", type: it.before.type });
          }
        }
        if (!page.hasMore || !(page.items ?? []).length) break;
        pos = page.nextPagePos ?? (pos + page.items.length);
      }
      // nothing to write cannot revert anything: check only when apply would change the folder
      if (!options.allowRevert && (await this.changesBytes(items, snapBranch)) && !(await this.snapshotContainsBase(snapBranch))) {
        throw new LayerfsError("WouldRevert", "this Branch may lack files that are already in your folder (it went back with /tree or /fork, or the folder moved on); applying could revert them, so nothing was written. Run the minilfs tool with action=sync (it merges the folder's state into the Branch and keeps your edits), then apply again. To revert the folder on purpose: /minilfs apply --revert.");
      }
      // name the next base now: a taken name must fail before the folder is touched, not after
      this.seq++;
      const nextBase = `b-${this.shortId}-${this.seq}`;
      const fb = await this.lfs.branch.fork(nextBase, snapRef);
      if (!items.length && !this.config.branchOnly.length) {
        this.unapplied = false;
        this.persistSessionBinding();
        return result;
      }

      type Next = { kind: "file"; data: Buffer; mode: number } | { kind: "symlink"; target: string } | null;
      const plan: Array<{ rel: string; next: Next; host: HostEntry | null; git: GitPathKind }> = [];
      const toRaw = (n: Next) => (n ? (n.kind === "file" ? { data: n.data, mode: n.mode } : { target: n.target }) : null);

      // 1. what the Branch has (one mount of the snapshot) and what the folder has now
      const found: Array<{ rel: string; kind: string; next: Next; host: HostEntry | null; hostRaw: RawEntry; git: GitPathKind }> = [];
      await this.withMountedBranch(snapBranch, false, "apply read", async (wsPath) => {
        for (const it of items) {
          const rel = it.path.replace(/^\/+/, "");
          const git = gitPathKind(rel);
          // .lww, secrets, branch-only output, protected git files (config, hooks, ...) and git's
          // transient state (locks, in-progress operations, caches) never reach the folder
          if (rel === ".lww" || isProtectedPath(rel) || git === "transient" || this.hostSkip(rel, false)) {
            result.skipped.push(rel);
            continue;
          }
          let next: Next = null;
          if (it.kind !== "Removed" && it.kind !== "deleted") {
            const p = posix.join(wsPath, rel);
            await this.assertInsideWs(wsPath, p, true);
            const lst = await fsp.lstat(p).catch(() => null);
            if (!lst) continue;
            if (lst.isSymbolicLink()) next = { kind: "symlink", target: await fsp.readlink(p) };
            else if (lst.isFile()) next = { kind: "file", data: await fsp.readFile(p), mode: lst.mode & 0o7777 };
            else continue;
          }
          let hostRaw = await readRawEntry(join(this.cwd, rel));
          // a folder where the Branch has a ref (or its log) is a ref namespace the Branch replaced
          // (refs/heads/foo/ -> refs/heads/foo): no ref there; writeGitLocked empties it or refuses
          if (hostRaw === "other" && (git === "ref" || git === "soft") && (await fsp.lstat(join(this.cwd, rel))).isDirectory()) hostRaw = null;
          if (hostRaw === "other") { result.conflicts.push(rel); continue; }
          const host = hostRaw ? ("target" in hostRaw ? linkSig(hostRaw.target) : fileSig(hostRaw.data, hostRaw.mode)) : null;
          found.push({ rel, kind: it.kind, next, host, hostRaw, git });
        }
      });
      if (result.conflicts.length) return result;

      // 2. the base version of every path the folder may have changed (one mount of the base, not one per file)
      const needBase = found.filter((f) => f.kind !== "Added" || f.git !== "none").map((f) => f.rel);
      const baseRaw = needBase.length ? await this.readRawEntriesAtBranch(this.baseBranch, needBase) : new Map<string, RawEntry>();

      // 3. decide. Sources: three-way, any conflict stops the whole apply. Git metadata: objects are
      //    added, never replaced; refs, HEAD and the index are three-way, and when the folder's git
      //    moved meanwhile (a commit made there) no ref, HEAD, index or log is written (new objects
      //    still are, unreferenced): the files still land in the folder, and the folder's own history
      //    is never overwritten
      const gitPlan: typeof plan = [];
      const gitConflicts: string[] = [];
      /** main (published below) will hold git metadata the folder does not: resync main from the folder next start */
      let gitDiverged = false;
      for (const f of found) {
        const want = f.next ? (f.next.kind === "file" ? fileSig(f.next.data, f.next.mode) : linkSig(f.next.target)) : null;
        if (f.git === "none") {
          if (sameSig(f.host, want)) { result.unchanged.push(f.rel); continue; }
          const b = baseRaw.get(f.rel) ?? null;
          const base = b && b !== "other" ? ("target" in b ? linkSig(b.target) : fileSig(b.data, b.mode)) : null;
          if (!sameSig(f.host, base)) { result.conflicts.push(f.rel); continue; }
          plan.push({ rel: f.rel, next: f.next, host: f.host, git: f.git });
          continue;
        }
        // git never makes symlinks inside its directory: one there could point a later write anywhere
        if (f.next?.kind === "symlink" || (f.hostRaw && "target" in f.hostRaw)) { result.skipped.push(f.rel); continue; }
        const b = baseRaw.get(f.rel);
        const d = decideGitPath(f.git, gitSig(f.git, f.hostRaw as any), gitSig(f.git, b && b !== "other" ? b : null), gitSig(f.git, toRaw(f.next)));
        if (d === "unchanged") result.unchanged.push(f.rel);
        else if (d === "skip") { result.skipped.push(f.rel); if (f.git !== "object") gitDiverged = true; }
        else if (d === "conflict") gitConflicts.push(f.rel);
        else gitPlan.push({ rel: f.rel, next: f.next, host: f.host, git: f.git });
      }
      if (result.conflicts.length) return result;
      if (gitConflicts.length) {
        gitDiverged = true;
        const kept = gitPlan.filter((g) => g.git === "object");
        result.skipped.push(...gitPlan.filter((g) => g.git !== "object").map((g) => g.rel), ...gitConflicts);
        gitPlan.length = 0;
        gitPlan.push(...kept);
        result.warnings.push(`your folder's git moved since this Branch started (${gitConflicts.slice(0, 4).join(", ")}${gitConflicts.length > 4 ? ", …" : ""}): the files were applied, but no ref, HEAD or index was changed, so the Branch's commits are not on your branches (their objects were added; the changes show as uncommitted). Commit them in your folder, or sync the Branch and apply again.`);
      }
      const depth = (r: string) => r.split("/").length;
      // git metadata (refs, HEAD, index, logs) comes after the files and the objects, all or none:
      // only when every object it names is in the folder, and under git's own lock files
      const gitObjects = gitPlan.filter((g) => g.git === "object");
      const gitMeta = gitPlan.filter((g) => g.git !== "object");
      const ordered = [
        ...plan.filter((p) => !p.next).sort((a, b) => depth(b.rel) - depth(a.rel)),
        ...plan.filter((p) => p.next).sort((a, b) => depth(a.rel) - depth(b.rel)),
        ...gitObjects.sort((a, b) => depth(a.rel) - depth(b.rel)),
      ];
      const hostIndex = this.bindings.readHostIndex(this.projectRecord.name);
      const tmps: string[] = [];
      const checkTarget = async (rel: string) => {
        const target = join(this.cwd, rel);
        await assertInsideWorkspace(this.cwd, target, true);
        await assertNotProtectedTarget(this.cwd, target, false);
        return target;
      };
      /** set before the folder is first changed: a stop after it leaves main behind the folder */
      let hostTouched = false;
      const put = async (rel: string, next: Next) => {
        const target = join(this.cwd, rel);
        hostTouched = true;
        if (!next) {
          await fsp.rm(target, { force: true });
          delete hostIndex[rel];
          await removeEmptyParents(this.cwd, rel);
        } else if (next.kind === "symlink") {
          await fsp.mkdir(dirname(target), { recursive: true });
          await fsp.rm(target, { force: true });
          await fsp.symlink(next.target, target);
          const st = await fsp.lstat(target);
          hostIndex[rel] = { ...linkSig(next.target), mtimeMs: st.mtimeMs, size: st.size };
        } else {
          await fsp.mkdir(dirname(target), { recursive: true });
          const tmp = join(dirname(target), `.${posix.basename(rel)}.minilfs-${randomBytes(4).toString("hex")}`);
          tmps.push(tmp);
          await fsp.writeFile(tmp, next.data, { mode: next.mode & 0o7777 });
          await fsp.chmod(tmp, next.mode & 0o7777);
          await fsp.rename(tmp, target);
          tmps.pop();
          const st = await fsp.lstat(target);
          hostIndex[rel] = { ...fileSig(next.data, next.mode), mode: next.mode & 0o7777, mtimeMs: st.mtimeMs, size: st.size };
        }
        result.applied.push(rel);
        this.bindings.writeHostIndex(this.projectRecord.name, hostIndex);
      };
      try {
        for (const { rel, next, host } of ordered) {
          guard();
          const target = await checkTarget(rel);
          const now = await hostState(target);
          if (now === "other" || !sameSig(now, host)) {
            result.conflicts.push(rel);
            throw new LayerfsError("ChangedDuringApply", `${rel} changed on disk while applying`);
          }
          await put(rel, next);
        }
        if (gitMeta.length) {
          guard();
          const dropMeta = (why: string) => {
            gitDiverged = true;
            result.skipped.push(...gitMeta.map((g) => g.rel));
            result.warnings.push(`${why}: the files were applied, but no ref, HEAD or index was changed, so the Branch's commits are not on your branches (their objects were added; the changes show as uncommitted). Commit them in your folder, or sync the Branch and apply again.`);
          };
          for (const g of gitMeta) await checkTarget(g.rel);
          const missing = await gitObjectsMissing(this.cwd, gitMeta);
          const locked = gitMeta.filter((g) => g.git !== "soft");
          if (!missing) hostTouched = true;
          const moved = missing ? null : await writeGitLocked(this.cwd, locked);
          if (missing) dropMeta(`the Branch's git names objects your folder does not have (${missing})`);
          else if (moved) dropMeta(`your folder's git moved while applying (${moved})`);
          else {
            for (const g of locked) {
              result.applied.push(g.rel);
              if (!g.next) delete hostIndex[g.rel];
              else {
                const st = await fsp.lstat(join(this.cwd, g.rel)).catch(() => null);
                if (st) hostIndex[g.rel] = { ...fileSig(g.next.data, g.next.mode), mtimeMs: st.mtimeMs, size: st.size };
              }
            }
            this.bindings.writeHostIndex(this.projectRecord.name, hostIndex);
            // logs and messages: only where the folder still has the base version
            // deletions first, deepest first, so a log namespace change (logs/refs/heads/foo -> foo/bar) works
            const soft = gitMeta.filter((x) => x.git === "soft");
            for (const g of [...soft.filter((x) => !x.next).sort((a, b) => depth(b.rel) - depth(a.rel)), ...soft.filter((x) => x.next)]) {
              const now = await hostState(join(this.cwd, g.rel));
              if (now !== "other" && sameSig(now, g.host)) await put(g.rel, g.next);
              else result.skipped.push(g.rel);
            }
          }
        }
        const gitSummary = gitChangeSummary(result.applied.filter((r) => gitPathKind(r) !== "none"));
        if (gitSummary) result.git = gitSummary;
      } catch (e: any) {
        for (const t of tmps) await fsp.rm(t, { force: true }).catch(() => {});
        this.bindings.writeHostIndex(this.projectRecord.name, hostIndex);
        if (result.applied.length || hostTouched) this.bindings.setMainStale(this.projectRecord.name, true);
        const err = new LayerfsError(e?.code ?? "PartialApply", `apply stopped after ${result.applied.length} file(s): ${e?.message ?? e}`);
        (err as any).result = result;
        throw err;
      }

      try {
        guard();
        const mainVsBase = await this.lfs.branch.diff_branches("main", this.baseBranch, 1, 0, { hunks: false });
        const mainUnchanged = Boolean(mainVsBase.from?.root) && mainVsBase.from?.root === mainVsBase.to?.root;
        // a snapshot with no Commit is the base Layer itself (no edits yet): nothing new for main
        let toPublish: string | null = snap?.head ? snapBranch : null;
        if (toPublish && !mainUnchanged) {
          const merged = `m-${this.shortId}-${(++this.seq)}`;
          const m = await this.lfs.branch.merge("main", snapBranch, merged, "merge applied session", mergeUnits());
          if (m?.kind && m.kind !== "Merged" && m.kind !== "FastForward" && m.kind !== "UpToDate") throw new Error(`merge answered ${m.kind}`);
          // UpToDate: main already holds the snapshot; the merge branch has no Commit to publish
          toPublish = m?.kind === "UpToDate" ? null : merged;
        }
        if (toPublish) {
          const pub = await this.lfs.branch.publish(toPublish);
          // the SDK answers the new Layer as `publishedLayer` ({ id, ... }); UpToDate has none: keep the ref, refresh the time
          const layer = pub?.publishedLayer?.id ?? pub?.layer ?? this.bindings.byName(this.projectRecord.name)?.mainRef ?? this.projectRecord.mainRef;
          if (layer) {
            this.projectRecord.mainRef = layer;
            this.bindings.updateProjectMain(this.projectRecord.name, layer);
          }
        }
      } catch (e: any) {
        this.bindings.setMainStale(this.projectRecord.name, true);
        result.warnings.push(`your folder is updated, but LayerFS main could not be updated (${e?.code ?? "Error"}: ${String(e?.message ?? e).slice(0, 160)}); the next session will resync main from your folder`);
      }

      if (gitDiverged) this.bindings.setMainStale(this.projectRecord.name, true);
      this.baseBranch = nextBase;
      this.baseRef = fb.head ?? fb.base;
      // the folder now matches snapRef (the work branch's head, pinned under the mutex)
      if (this.headCommit) this.alignedRef = this.headCommit;
      this.unapplied = this.headCommit !== snapRef;
      this.mergedSinceApply = [];
      this.persistSessionBinding();
      return result;
    });
  }

  private async snapshotContainsBase(snapBranch: string): Promise<boolean> {
    // exact answer first: the snapshot descends from a Commit that held the whole base
    if (this.alignedRef && (await this.branchHasCommit(snapBranch, this.alignedRef))) return true;
    try {
      const baseIsCommit = await this.baseIsCommit();
      const cleanedBaseRef = cleanRef(this.baseRef);
      for (let pos = 0; ; ) {
        const page = await this.lfs.branch.list_commits(snapBranch, 500, pos);
        for (const c of page.items ?? []) {
          const cid = cleanRef(c.id);
          const cbase = cleanRef(c.base);
          if (baseIsCommit && (c.id === this.baseRef || cid === cleanedBaseRef)) return true;
          if (!baseIsCommit && c.base !== this.baseRef && cbase !== cleanedBaseRef) {
            return await this.mergeAddsNothing(snapBranch, this.baseBranch);
          }
        }
        if (!page.hasMore || !(page.items ?? []).length) break;
        pos = page.nextPagePos ?? (pos + page.items.length);
      }
      if (!baseIsCommit) return true;
      return await this.mergeAddsNothing(snapBranch, this.baseBranch);
    } catch {
      return false;
    }
  }

  /** `commit` is a Commit of `branch`, or the Layer `branch` starts from (a fast-forward onto a main snapshot) */
  private async branchHasCommit(branch: string, commit: string): Promise<boolean> {
    const want = cleanRef(commit);
    try {
      const b = (await this.listAllBranches()).find((x) => x.name === branch);
      if (b && (b.base === commit || cleanRef(b.base) === want)) return true;
      for (let pos = 0; ; ) {
        const page = await this.lfs.branch.list_commits(branch, 500, pos);
        for (const c of page.items ?? []) if (c.id === commit || cleanRef(c.id) === want) return true;
        if (!page.hasMore || !(page.items ?? []).length) return false;
        pos = page.nextPagePos ?? (pos + page.items.length);
      }
    } catch {
      return false;
    }
  }

  private async baseIsCommit(): Promise<boolean> {
    const list = await this.lfs.branch.list_commits(this.baseBranch, 1, 0).catch(() => ({ items: [] }));
    return Boolean(list.items?.length);
  }

  private async mergeAddsNothing(targetBranch: string, otherBranch: string): Promise<boolean> {
    const testMerge = `test-merge-${this.shortId}-${(++this.seq)}`;
    try {
      await this.lfs.branch.merge(targetBranch, otherBranch, testMerge, "test merge", mergeUnits());
      const d = await this.lfs.branch.diff_branches(targetBranch, testMerge, 1, 0, { hunks: false });
      return (d.items ?? []).length === 0;
    } catch {
      return false;
    }
  }

  /**
   * Paths that apply may write to the host: everything in the Branch (sources, `.git` data, ignored
   * output, dependencies) except secrets, explicit branch-only patterns, protected git paths (config,
   * hooks, ...: src/gitpaths.ts) and git's transient state. Git data has its own rules in apply.
   */
  isApplicable(path: string): boolean {
    const p = String(path ?? "").replace(/^\/+/, "");
    if (isProtectedPath(p)) return false;
    if (gitPathKind(p) === "transient") return false; // locks and in-progress git state stay in the Branch
    if (this.isBranchOnly(p)) return false;
    return !isExcludedPath(p, this.config.excludes);
  }

  /** Lives only in branches (explicit MINILFS_BRANCH_ONLY patterns): never applied, never synced. */
  isBranchOnly(path: string): boolean {
    const p = String(path ?? "").replace(/^\/+/, "");
    if (!p || p === ".lww") return false;
    return this.config.branchOnly.length > 0 && isExcludedPath(p, this.config.branchOnly);
  }

  /** true when every applicable change on the Branch already has identical bytes in the host folder */
  async pendingAlreadyOnHost(): Promise<boolean> {
    for (const it of await this.diff()) {
      if (it.type === "dir" || !this.isApplicable(it.path)) continue;
      const rel = it.path.replace(/^\/+/, "");
      const host = await fsp.readFile(join(this.cwd, rel)).catch(() => null);
      if (it.kind === "Removed" || it.kind === "deleted") { if (host !== null) return false; continue; }
      const mine = await this.readBytesAtRef(this.workBranch, it.path).catch(() => null);
      if (host === null || mine === null || !host.equals(mine)) return false;
    }
    return true;
  }

  private async hasApplicable(): Promise<boolean> {
    return this.changesBytes(await this.diff(), this.workBranch);
  }

  /**
   * true when some applicable path of `items` (a base..`branch` diff) differs in bytes. A merge that
   * rewrites a file reports it "Modified" with identical bytes (new inode): not a change.
   */
  private async changesBytes(items: Array<{ path: string; kind: string; type: string }>, branch: string): Promise<boolean> {
    for (const i of items) {
      const rel = i.path.replace(/^\/+/, "");
      if (i.type === "dir" || rel === ".lww" || !this.isApplicable(i.path)) continue;
      if (i.kind === "Modified") {
        const [a, b] = await Promise.all([
          this.readBytesAtRef(this.baseBranch, i.path).catch(() => null),
          this.readBytesAtRef(branch, i.path).catch(() => null),
        ]);
        if (a && b && a.equals(b)) continue;
      }
      return true;
    }
    return false;
  }

  async stopNativeDaemons(): Promise<void> {
    if (!this.spec?.localDir) return;
    return stopNativeDaemons(this.spec.localDir);
  }

  async close(options: { stopDaemons?: boolean } = {}): Promise<{ kept: boolean; notes: string[] }> {
    const notes: string[] = [];
    if (this.closed) return { kept: true, notes };
    this.closed = true;
    for (const ctl of this.activeExecs.keys()) ctl.abort();
    await Promise.allSettled([...this.activeExecs.values()]);
    await Promise.allSettled([...this.pendingUnmounts]);
    if (this.blocked?.heldWs && !this.mounts.has(this.blocked.heldWs.path)) {
      this.mounts.set(this.blocked.heldWs.path, { ws: this.blocked.heldWs, wsReal: this.blocked.heldWs.path });
    }
    // every Workspace still mounted (a held checkpoint, one dropped by /tree, an interrupted call)
    if (this.lfs) {
      await Promise.allSettled([...this.mounts.values()].map(({ ws, wsReal }) => this.releaseWorkspace(ws, wsReal, true)));
      await this.reclaimOrphanMounts().catch(() => {});
    }
    this.persistSessionBinding();
    try { await this.lfs?.close?.(); } catch {}
    if (options.stopDaemons) {
      await this.stopNativeDaemons().catch(() => {});
    }
    if (this.unapplied || this.blocked) {
      notes.push(`unapplied changes remain on branch ${this.workBranch} in project ${this.project} (volume ${this.volume})`);
    }
    return { kept: true, notes };
  }
}

// ---------------------------------------------------------------- helpers

/**
 * true while the process that holds `s` runs. No pid (a closed session, or one written by an older
 * version): gone. Another host's pid cannot be checked: assume it runs.
 */
function sessionAlive(s: SessionBinding): boolean {
  if (!s.pid) return false;
  if (s.host && s.host !== hostname()) return true;
  if (s.pid === process.pid) return true;
  if (!alive(s.pid)) return false;
  // a recorded start time tells the session's process from a later one that reused its pid
  if (s.pidStartSec === undefined) return true;
  const p = procStartTime(s.pid);
  return !p || (p.startSec === s.pidStartSec && p.startUsec === s.pidStartUsec);
}

/** This process's start time (libproc), recorded with the session's pid; looked up once. */
let ownStartCache: { pidStartSec?: number; pidStartUsec?: number } | null = null;
function ownStart(): { pidStartSec?: number; pidStartUsec?: number } {
  if (!ownStartCache) {
    const p = procStartTime(process.pid);
    ownStartCache = p ? { pidStartSec: p.startSec, pidStartUsec: p.startUsec } : {};
  }
  return ownStartCache;
}

/**
 * Which session holds an alias (`lead`, a worker's name) first: one whose process runs beats a
 * finished or crashed one, then the newer, then one with a Commit. A dead earlier lead's Branch with
 * commits must not shadow the running lead.
 */
export function compareSessionsForAlias(a: SessionBinding, b: SessionBinding, isAlive: (s: SessionBinding) => boolean = sessionAlive): number {
  const la = isAlive(a) ? 1 : 0, lb = isAlive(b) ? 1 : 0;
  if (la !== lb) return lb - la;
  if ((a.updatedAt ?? 0) !== (b.updatedAt ?? 0)) return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  return (b.headCommit ? 1 : 0) - (a.headCommit ? 1 : 0);
}

/** compareSessionsForAlias with each session's liveness looked up once per sort. */
function aliasOrder(): (a: SessionBinding, b: SessionBinding) => number {
  const memo = new Map<SessionBinding, boolean>();
  const live = (s: SessionBinding) => {
    let v = memo.get(s);
    if (v === undefined) memo.set(s, (v = sessionAlive(s)));
    return v;
  };
  return (a, b) => compareSessionsForAlias(a, b, live);
}

/** Removes git's lock and temp files (`*.lock`, `*.new`, `tmp_*`) left in a Workspace's `.git` by a killed command. */
async function removeGitLeftovers(wsReal: string): Promise<void> {
  const gitDir = join(wsReal, ".git");
  const top = await fsp.readdir(gitDir).catch(() => [] as string[]);
  const victims = top.filter((n) => /\.(lock|new)$/.test(n)).map((n) => join(gitDir, n));
  for (const sub of ["refs", "objects/pack", "objects/info"]) {
    const walk = async (d: string): Promise<void> => {
      for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [] as any[])) {
        const p = join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else if (/\.(lock|new)$|^tmp_/.test(e.name)) victims.push(p);
      }
    };
    await walk(join(gitDir, sub));
  }
  for (const v of victims) await fsp.rm(v, { force: true }).catch(() => {});
}

/** Merge units for branch.merge: the caller's first (a path two units match belongs to the first), then MERGE_UNITS. */
function mergeUnits(extra: MergeOptions["units"] = []): Array<string | { name: string; patterns: string[] }> {
  const out = [...(extra ?? [])];
  const names = new Set(out.map((u) => (typeof u === "string" ? u : u.name)));
  for (const u of MERGE_UNITS) if (!names.has(u.name)) out.push({ name: u.name, patterns: [...u.patterns] });
  return out;
}

/** The conflicting paths of a LayerFS `Conflict` refusal. */
function conflictList(e: any): Array<{ path: string; kind?: string }> {
  return (e?.detail?.conflicts ?? []).map((c: any) => ({ path: String(c.path).replace(/^\/+/, ""), kind: c.kind }));
}

function enoent(path: string, why: string) {
  const err = new Error(`ENOENT: ${path} (${why})`);
  (err as any).code = "ENOENT";
  return err;
}

const sameSig = (a: HostEntry | null | undefined, b: HostEntry | null | undefined) =>
  a === b || (Boolean(a) && Boolean(b) && a!.kind === b!.kind && a!.sig === b!.sig && ((a!.mode ?? 0o644) & 0o7777) === ((b!.mode ?? 0o644) & 0o7777));

const cleanRef = (ref: string | null | undefined) => (ref ?? "").replace(/^(\w+)-/, "").slice(0, 12);
const fileSig = (data: Buffer, mode?: number): HostEntry => ({ kind: "file", sig: sha(data), ...(mode !== undefined ? { mode: mode & 0o7777 } : {}) });
const linkSig = (target: string): HostEntry => ({ kind: "symlink", sig: `link:${target}` });

/** A path's content: a file's bytes and mode, a symlink's target, null (absent) or "other" (a directory, device, ...). */
type RawEntry = { data: Buffer; mode: number } | { target: string } | null | "other";

async function readRawEntry(abs: string): Promise<RawEntry> {
  const st = await fsp.lstat(abs).catch((e: any) => (e?.code === "ENOENT" || e?.code === "ENOTDIR" ? null : Promise.reject(e)));
  if (!st) return null;
  if (st.isSymbolicLink()) return { target: await fsp.readlink(abs) };
  if (st.isFile()) return { data: await fsp.readFile(abs), mode: st.mode & 0o7777 };
  return "other";
}

async function hostState(abs: string): Promise<HostEntry | null | "other"> {
  const st = await fsp.lstat(abs).catch((e: any) => (e?.code === "ENOENT" || e?.code === "ENOTDIR" ? null : Promise.reject(e)));
  if (!st) return null;
  if (st.isSymbolicLink()) return linkSig(await fsp.readlink(abs));
  if (st.isFile()) return fileSig(await fsp.readFile(abs), st.mode);
  return "other";
}

type GitWrite = { rel: string; git: GitPathKind; next: { kind: "file"; data: Buffer; mode: number } | { kind: "symlink"; target: string } | null; host: HostEntry | null };
/**
 * git's environment for checks on a repository: nothing inherited from this process (GIT_DIR,
 * GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_INDEX_FILE, ... would point git at
 * other objects), no global or system config or attributes, no prompt.
 */
const cleanGitEnv = (home = "/var/empty"): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
  HOME: home,
  TMPDIR: "/private/tmp",
  LANG: "C",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
});
/** A ref a symbolic ref may name: under refs/, no `.`/`..` component (it is looked up as a path). */
const isRefTarget = (r: string) => /^refs\/\S+$/.test(r) && !/(^|\/)\.\.?(\/|$)/.test(r) && !r.includes("//");
/** Refs that must name a commit: HEAD, branch heads (and minilfs's rescues of them). */
const wantsCommit = (inner: string) => inner === "HEAD" || inner.startsWith("refs/heads/") || /^refs\/minilfs\/[^/]+\/(heads\/|HEAD$)/.test(inner);

/**
 * What `name` (a ref of git dir `dir`) resolves to once `meta` is written: an oid, null (no such
 * ref), or "loop" (more than 5 symbolic hops). Planned refs first, then the folder's loose ref, then
 * packed-refs (the planned one, else the folder's), as git looks them up.
 */
async function resolveRefAfter(cwd: string, dir: string, name: string, meta: GitWrite[]): Promise<string | null | "loop"> {
  const planned = (inner: string) => meta.find((g) => g.rel === `${dir}/${inner}`);
  const content = (g: GitWrite) => (g.next?.kind === "file" ? g.next.data.toString("utf8") : null);
  for (let hop = 0; hop < 5; hop++) {
    const p = planned(name);
    const text = p ? content(p) : await fsp.readFile(join(cwd, dir, name), "utf8").catch(() => null);
    if (text === null) {
      const pp = planned("packed-refs");
      const packed = pp ? (content(pp) ?? "") : await fsp.readFile(join(cwd, dir, "packed-refs"), "utf8").catch(() => "");
      for (const line of packed.split("\n")) {
        const m = /^([0-9a-f]+) (\S+)$/.exec(line);
        if (m && m[2] === name) return m[1];
      }
      return null;
    }
    const m = /^ref: (\S+)$/.exec(text.trim());
    if (!m) return text.trim();
    if (!isRefTarget(m[1])) return null;
    name = m[1];
  }
  return "loop";
}

/**
 * Why the folder cannot take these refs/HEAD/index, or null. In each git dir (as the folder has it):
 * every ref parses (oids of the repository's hash length), branch heads and HEAD name commits, index
 * entries name blobs (not gitlinks, not intent-to-add), packed-refs' peeled `^` lines are what their
 * tag peels to, symbolic refs resolve (HEAD may be unborn only in a repository without commits), and
 * everything the new commits and tags reach is there (`rev-list --objects --missing=print`, minus
 * what the folder's refs already reach). git runs with cleanGitEnv, no hooks, no fsmonitor. A ref
 * written by a file tool, or objects never added, would otherwise leave the folder's git broken.
 */
async function gitObjectsMissing(cwd: string, meta: GitWrite[]): Promise<string | null> {
  type Want = "commit" | "blob" | "any";
  type Dir = { want: Map<string, Set<Want>>; tips: Set<string>; peeled: Array<[string, string]>; symrefs: Array<[string, string]>; addsHeads: boolean };
  const byDir = new Map<string, Dir>();
  for (const g of meta) {
    if (g.git === "soft" || !g.next || g.next.kind !== "file") continue;
    const dir = gitDirOf(g.rel, cwd);
    if (!dir) continue;
    const inner = g.rel.slice(dir.length + 1);
    let d = byDir.get(dir);
    if (!d) byDir.set(dir, (d = { want: new Map(), tips: new Set(), peeled: [], symrefs: [], addsHeads: false }));
    const need = (oid: string, w: Want) => d!.want.set(oid, (d!.want.get(oid) ?? new Set<Want>()).add(w));
    const text = g.next.data.toString("utf8");
    if (g.git === "index") {
      const entries = parseIndexEntries(g.next.data);
      if (entries === null) return `${g.rel} cannot be read`;
      for (const e of entries) {
        if (e.mode === 0o160000 || e.flags & 0x2000) continue; // a submodule's commit; intent-to-add (no blob yet)
        need(e.oid, e.mode === 0o040000 ? "any" : "blob"); // sparse index: a directory entry names a tree
      }
    } else if (inner === "packed-refs") {
      let last: string | null = null;
      for (const line of text.split("\n")) {
        if (!line || line.startsWith("#")) continue;
        const peel = /^\^([0-9a-f]+)$/.exec(line);
        if (peel) {
          if (!last) return `${g.rel} has a malformed line`;
          d.peeled.push([last, peel[1]]);
          need(peel[1], "any");
          last = null;
          continue;
        }
        const m = /^([0-9a-f]+) (\S+)$/.exec(line);
        if (!m || !isRefTarget(m[2])) return `${g.rel} has a malformed line`;
        need(m[1], wantsCommit(m[2]) ? "commit" : "any");
        d.tips.add(m[1]);
        if (m[2].startsWith("refs/heads/")) d.addsHeads = true;
        last = m[1];
      }
    } else {
      const t = text.trim();
      if (t.startsWith("ref:")) {
        const m = /^ref: (\S+)$/.exec(t);
        if (!m || !isRefTarget(m[1])) return `${g.rel} is not a ref`;
        d.symrefs.push([inner, m[1]]);
        continue;
      }
      if (!/^[0-9a-f]+$/.test(t)) return `${g.rel} is not a ref`;
      need(t, wantsCommit(inner) ? "commit" : "any");
      d.tips.add(t);
      if (inner.startsWith("refs/heads/")) d.addsHeads = true;
    }
  }
  for (const [dir, d] of byDir) {
    const git = (args: string[], input?: string) =>
      run("git", ["--git-dir", join(cwd, dir), "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd, env: cleanGitEnv(), input, timeoutMs: 120_000 })
        .catch((e) => ({ code: null, stdout: Buffer.alloc(0), stderr: String(e?.message ?? e) }));
    const fmt = await git(["rev-parse", "--show-object-format"]);
    if (fmt.code !== 0) return `git failed in ${dir}: ${fmt.stderr.trim().slice(0, 120)}`;
    const oidLen = fmt.stdout.toString().trim() === "sha256" ? 64 : 40;
    const isOid = (o: string) => o.length === oidLen && /^[0-9a-f]+$/.test(o);
    // symbolic refs resolve once everything is written
    let unborn: string | null = null;
    for (const [inner, target] of d.symrefs) {
      const r = await resolveRefAfter(cwd, dir, target, meta);
      if (r === "loop") return `${dir}/${inner}: symbolic ref loop at ${target}`;
      if (r === null) {
        if (inner !== "HEAD") return `${dir}/${inner} names ${target}, which does not exist`;
        unborn = target;
        continue;
      }
      if (!isOid(r)) return `${dir}/${inner} names ${target}, which is not a ref`;
      d.want.set(r, (d.want.get(r) ?? new Set<Want>()).add(inner === "HEAD" ? "commit" : "any"));
      d.tips.add(r);
    }
    const oids = [...d.want.keys()];
    const bad = oids.find((o) => !isOid(o));
    if (bad) return `${dir} names ${bad.slice(0, 16)}…, not a ${oidLen}-digit object id`;
    // every object: there, of the right type; a peeled line is its tag's target
    const types = new Map<string, string>();
    const queries = [...oids, ...d.peeled.map(([tag]) => `${tag}^{}`)];
    if (queries.length) {
      const r = await git(["cat-file", "--batch-check=%(objectname) %(objecttype)"], queries.join("\n") + "\n");
      if (r.code !== 0) return `git cat-file failed in ${dir}: ${r.stderr.trim().slice(0, 120)}`;
      const lines = r.stdout.toString().split("\n");
      const missing: string[] = [];
      const wrong: string[] = [];
      queries.forEach((q, i) => {
        const [name, type] = (lines[i] ?? "").split(" ");
        if (!type || type === "missing") { missing.push(q.slice(0, 12)); return; }
        if (i < oids.length) {
          types.set(q, type);
          for (const w of d.want.get(q)!) if (w !== "any" && w !== type) wrong.push(`${q.slice(0, 12)} is a ${type}, not a ${w}`);
        } else if (name !== d.peeled[i - oids.length][1]) wrong.push(`${q.slice(0, 12)} does not peel to ${d.peeled[i - oids.length][1].slice(0, 12)}`);
      });
      if (missing.length) return `${missing.length} missing in ${dir}: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""}`;
      if (wrong.length) return `${dir}: ${wrong.slice(0, 3).join(", ")}${wrong.length > 3 ? ", …" : ""}`;
    }
    if (unborn) {
      const any = d.addsHeads ? null : await git(["rev-list", "-n", "1", "--all"]);
      if (!any || any.code !== 0 || any.stdout.toString().trim()) return `${dir}/HEAD names ${unborn}, which does not exist`;
    }
    // everything the new commits and tags reach (their parents, trees, blobs), beyond what the folder's refs reach
    const tips = [...d.tips].filter((o) => types.get(o) === "commit" || types.get(o) === "tag");
    if (tips.length) {
      const r = await git(["rev-list", "--objects", "--missing=print", "--stdin"], [...tips, "--not", "--all", ""].join("\n"));
      const lost = r.stdout.toString().split("\n").filter((l) => l.startsWith("?")).map((l) => l.slice(1, 13));
      if (r.code !== 0 || lost.length) return `missing reachable objects in ${dir}: ${lost.slice(0, 3).join(", ") || r.stderr.trim().slice(0, 120)}`;
    }
  }
  return null;
}

/**
 * Writes refs, HEAD and the index the way git does, so a git command running in the folder at the
 * same time is never overwritten: `<path>.lock` taken exclusively for every path first (sorted),
 * the folder's version checked again under the lock, the new bytes written into the lock file; then
 * deletions (deepest first), then each lock renamed over its path (refs, then the index, then HEAD).
 * A ref namespace change works both ways: a ref below a deleted ref (`foo` -> `foo/bar`) takes its
 * lock after the deletion; a ref over a folder of deleted refs (`foo/bar` -> `foo`) is renamed once
 * the folder is empty. Anything that fails after the first change puts every touched path back to
 * the bytes it had (all or nothing). Returns why nothing was written (a lock git holds, a path that
 * moved), or null when all were written; an I/O error is thrown after the rollback.
 */
async function writeGitLocked(cwd: string, items: GitWrite[]): Promise<string | null> {
  const depth = (r: string) => r.split("/").length;
  const below = (a: string, b: string) => a.startsWith(`${b}/`);
  const deletes = items.filter((i) => !i.next).sort((a, b) => depth(b.rel) - depth(a.rel));
  const writes = items.filter((i) => i.next).sort((a, b) =>
    GIT_APPLY_ORDER[a.git] - GIT_APPLY_ORDER[b.git] || depth(a.rel) - depth(b.rel) || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  // locked only once the ref file in their way is deleted
  const deferred = new Set(writes.filter((w) => deletes.some((d) => below(w.rel, d.rel))));
  // renamed over a folder the deletions empty
  const overDir = new Set(writes.filter((w) => deletes.some((d) => below(d.rel, w.rel))));
  const held = new Set<string>();
  /** what each path held before (null: absent), for the rollback */
  const prev = new Map<string, { data: Buffer; mode: number } | null>();
  const touched: string[] = [];
  const lockOf = (rel: string) => `${join(cwd, rel)}.lock`;
  /** takes `it`'s lock and checks the folder still has `it.host`; null when taken, else why not */
  const take = async (it: GitWrite): Promise<string | null> => {
    const target = join(cwd, it.rel);
    await fsp.mkdir(dirname(target), { recursive: true });
    const mode = it.next?.kind === "file" ? it.next.mode & 0o7777 : 0o644;
    const fh = await fsp.open(`${target}.lock`, "wx", mode).catch((e: any) => (e?.code === "EEXIST" ? null : Promise.reject(e)));
    if (!fh) return `${it.rel}.lock exists: git is running there`;
    held.add(`${target}.lock`);
    try {
      const raw = await readRawEntry(target);
      const emptied = overDir.has(it) && raw === "other" && (await fsp.lstat(target)).isDirectory();
      const now = raw === "other" ? "other" : raw ? ("target" in raw ? linkSig(raw.target) : fileSig(raw.data, raw.mode)) : null;
      if (!emptied && (now === "other" || !sameSig(now, it.host))) return `${it.rel} changed`;
      prev.set(it.rel, raw && raw !== "other" && "data" in raw ? raw : null);
      if (it.next?.kind === "file") {
        await fh.writeFile(it.next.data);
        await fh.chmod(mode);
      }
    } finally {
      await fh.close();
    }
    return null;
  };
  const unlock = async (rel: string) => {
    if (held.delete(lockOf(rel))) await fsp.rm(lockOf(rel), { force: true });
  };
  const rollback = async () => {
    for (const l of held) await fsp.rm(l, { force: true }).catch(() => {});
    held.clear();
    for (const rel of touched.reverse()) {
      const target = join(cwd, rel);
      const old = prev.get(rel);
      try {
        if ((await fsp.lstat(target).catch(() => null))?.isDirectory()) await fsp.rmdir(target);
        else await fsp.rm(target, { force: true });
        if (!old) { await removeEmptyGitRefParents(cwd, rel); continue; }
        await fsp.mkdir(dirname(target), { recursive: true });
        const tmp = join(dirname(target), `.${basename(rel)}.minilfs-${randomBytes(4).toString("hex")}`);
        await fsp.writeFile(tmp, old.data, { mode: old.mode });
        await fsp.chmod(tmp, old.mode);
        await fsp.rename(tmp, target);
      } catch {} // best effort; the caller marks main stale
    }
  };
  try {
    // 1. every lock that can be taken now, sorted; nothing in the folder changes yet
    for (const it of [...items].filter((i) => !deferred.has(i)).sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
      const why = await take(it);
      if (why) return why;
    }
    // 2. deletions, deepest first; a folder a ref replaces is emptied (its locks go first)
    for (const d of deletes) {
      await fsp.rm(join(cwd, d.rel), { force: true });
      touched.push(d.rel);
      const over = [...overDir].find((w) => below(d.rel, w.rel));
      if (!over) continue;
      await unlock(d.rel);
      for (let dir = posix.dirname(d.rel); below(dir, over.rel) || dir === over.rel; dir = posix.dirname(dir)) {
        if (!(await fsp.rmdir(join(cwd, dir)).then(() => true, () => false))) break;
      }
    }
    // 3. the locks that had to wait for a deletion; the emptied folders must be gone
    for (const w of deferred) {
      const why = await take(w);
      if (why) { await rollback(); return why; }
    }
    for (const w of overDir) {
      if ((await readRawEntry(join(cwd, w.rel))) !== null) { await rollback(); return `${w.rel} changed`; }
    }
    // 4. the new versions, in git's order; then the deletions' locks
    for (const w of writes) {
      await fsp.rename(lockOf(w.rel), join(cwd, w.rel));
      held.delete(lockOf(w.rel));
      touched.push(w.rel);
    }
    for (const d of deletes) {
      await unlock(d.rel);
      await removeEmptyGitRefParents(cwd, d.rel);
    }
    return null;
  } catch (e) {
    if (touched.length) await rollback();
    throw e;
  } finally {
    for (const l of held) await fsp.rm(l, { force: true }).catch(() => {});
  }
}

/** Removes folders a deleted ref leaves empty, below `<git dir>/refs/<kind>/` (never refs/, refs/heads/, ...). */
async function removeEmptyGitRefParents(root: string, rel: string): Promise<void> {
  const dir = gitDirOf(rel);
  if (!dir) return;
  for (let d = posix.dirname(rel); ; d = posix.dirname(d)) {
    const inner = d.slice(dir.length + 1);
    if (!inner.startsWith("refs/") || depthOf(inner) < 3) return;
    if (!(await fsp.rmdir(join(root, d)).then(() => true, () => false))) return;
  }
}
const depthOf = (r: string) => r.split("/").length;

async function removeEmptyParents(root: string, rel: string): Promise<void> {
  let dir = posix.dirname(rel);
  while (dir && dir !== "." && dir !== "/") {
    try { await fsp.rmdir(join(root, dir)); } catch { return; }
    dir = posix.dirname(dir);
  }
}

/** True when `abs` is minilfs's root (Stores, bindings, the store worker's endpoint) or its bundle, in any spelling. */
export function isPrivateMinilfsPath(abs: string, config: { root: string; bundle: string }): boolean {
  const dirs = [config.root, config.bundle].filter(Boolean).flatMap((d) => bothSpellings(d));
  return dirs.some((d) => abs === d || abs.startsWith(`${d}/`));
}

/** realpath of `abs`, or of its nearest existing ancestor plus the rest (a path that does not exist yet). */
async function realpathNearest(abs: string): Promise<string> {
  const rest: string[] = [];
  for (let probe = abs; ; ) {
    const real = await fsp.realpath(probe).catch(() => null);
    if (real) return rest.length ? join(real, ...rest) : real;
    const up = dirname(probe);
    if (up === probe) return abs;
    rest.unshift(basename(probe));
    probe = up;
  }
}

export function isOutsideSecret(abs: string, excludes: string[]): boolean {
  if (isExcludedPath(abs, excludes.filter((p) => !p.replace(/\/$/, "").includes("/")))) return true;
  for (const home of HOMES) {
    if (abs.startsWith(`${home}/`) && isExcludedPath(abs.slice(home.length + 1), OUTSIDE_SECRET_PATTERNS)) return true;
  }
  return false;
}

interface CompiledPattern { pat: string; dirOnly: boolean; anchored: boolean; negate: boolean; hits: Map<string, boolean> }
const compiledPatterns = new Map<string, CompiledPattern[]>();
function compilePatterns(patterns: string[]): CompiledPattern[] {
  const key = patterns.join("\0");
  let out = compiledPatterns.get(key);
  if (out) return out;
  out = [];
  for (const raw of patterns.flatMap(expandBraces)) {
    let pat = raw.trim().toLowerCase();
    const negate = pat.startsWith("!");
    if (negate) pat = pat.slice(1);
    if (!pat) continue;
    const dirOnly = pat.endsWith("/");
    if (dirOnly) pat = pat.slice(0, -1);
    const anchored = pat.startsWith("/") || pat.includes("/");
    out.push({ pat: pat.replace(/^\/+/, ""), dirOnly, anchored, negate, hits: new Map() });
  }
  if (compiledPatterns.size > 64) compiledPatterns.clear();
  compiledPatterns.set(key, out);
  return out;
}

/** Path components repeat (index.js, src, node_modules): remember each match result. */
function componentMatches(c: string, p: CompiledPattern): boolean {
  let hit = p.hits.get(c);
  if (hit === undefined) {
    hit = posix.matchesGlob(c, p.pat);
    if (p.hits.size > 100_000) p.hits.clear();
    p.hits.set(c, hit);
  }
  return hit;
}

function patternMatches(cp: CompiledPattern, parts: string[]): boolean {
  if (!cp.anchored) return (cp.dirOnly ? parts.slice(0, -1) : parts).some((c) => componentMatches(c, cp));
  for (let i = 1; i <= parts.length; i++) {
    if (cp.dirOnly && i === parts.length) break;
    if (posix.matchesGlob(parts.slice(0, i).join("/"), cp.pat)) return true;
  }
  return false;
}

/**
 * Case-insensitive gitignore-like match. A `!pattern` re-includes a path matched by an earlier
 * pattern (last match wins), e.g. `.env.*` then `!.env.example`.
 */
export function isExcludedPath(relPath: string, patterns: string[]): boolean {
  const rel = relPath.replace(/^\/+/, "").toLowerCase();
  if (!rel) return false;
  const parts = rel.split("/");
  let excluded = false;
  for (const cp of compilePatterns(patterns)) {
    if (cp.negate ? excluded : !excluded) {
      if (patternMatches(cp, parts)) excluded = !cp.negate;
    }
  }
  return excluded;
}

export function rsyncExcludeArgs(patterns: string[]): string[] {
  const ci = (p: string) => p.replace(/\[[^\]]*\]|[a-z]/gi, (m) => (m.length > 1 ? m : `[${m.toLowerCase()}${m.toUpperCase()}]`));
  return patterns.flatMap(expandBraces).map((p) => p.trim()).filter(Boolean).map((p) => {
    const include = p.startsWith("!");
    if (include) p = p.slice(1);
    const dirOnly = p.endsWith("/");
    const body = dirOnly ? p.slice(0, -1) : p;
    const anchored = body.startsWith("/") || body.includes("/");
    const rule = `${anchored ? `/${body.replace(/^\/+/, "")}` : body}${dirOnly ? "/" : ""}`;
    return `--${include ? "include" : "exclude"}=${ci(rule)}`;
  }).sort((a, b) => Number(b.startsWith("--include")) - Number(a.startsWith("--include"))); // rsync: first match wins
}

export function expandBraces(pattern: string): string[] {
  const m = /\{([^{}]+)\}/.exec(pattern);
  if (!m) return [pattern];
  const prefix = pattern.slice(0, m.index);
  const suffix = pattern.slice(m.index + m[0].length);
  return m[1].split(",").flatMap((part) => expandBraces(`${prefix}${part}${suffix}`));
}

/** Refuses an import above the configured limits (memory, Init time); names the biggest folders. */
async function checkImportSize(root: string, files: string[], config: LayerfsConfig): Promise<void> {
  let bytes = 0;
  const perTop = new Map<string, { files: number; bytes: number }>();
  for (let i = 0; i < files.length; i += SCAN_CONCURRENCY) {
    const sizes = await Promise.all(files.slice(i, i + SCAN_CONCURRENCY).map((rel) => fsp.lstat(join(root, rel)).then((s) => s.size, () => 0)));
    sizes.forEach((size, k) => {
      const rel = files[i + k];
      bytes += size;
      const top = rel.includes("/") ? `${rel.split("/")[0]}/` : rel;
      const t = perTop.get(top) ?? { files: 0, bytes: 0 };
      t.files++; t.bytes += size;
      perTop.set(top, t);
    });
  }
  if (files.length <= config.maxImportFiles && bytes <= config.maxImportBytes) return;
  const mb = (b: number) => `${Math.round(b / 1024 / 1024)} MB`;
  const biggest = [...perTop.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 5)
    .map(([p, t]) => `${p} (${t.files} files, ${mb(t.bytes)})`).join(", ");
  throw new LayerfsError("TooLarge",
    `folder too large to import (${files.length} files, ${mb(bytes)}; limit ${config.maxImportFiles} files / ${mb(config.maxImportBytes)}). ` +
    `Largest: ${biggest}. LayerFS imports the whole folder (.git, dependencies, ignored output). ` +
    `Raise MINILFS_MAX_IMPORT_FILES / MINILFS_MAX_IMPORT_MB (and MINILFS_INIT_TIMEOUT_MS for a slow import), ` +
    `or keep data folders agents need not edit out with MINILFS_BRANCH_ONLY (comma-separated, e.g. "runs/,data/"; never .git or node_modules); then /minilfs retry.`);
}

/** true for a host path that is never imported or synced (`isDir`: the path is a directory) */
export type Skip = (rel: string, isDir: boolean) => boolean;

/** Highest `<kind>-<shortId>-<n>` number among `branches` (0 when none): the floor for a resumed seq. */
export function highestSeq(branches: Array<{ name: string }>, shortId: string): number {
  let max = 0;
  const tail = `-${shortId}-`;
  for (const b of branches) {
    const i = b.name.lastIndexOf(tail);
    if (i <= 0) continue;
    const n = Number(b.name.slice(i + tail.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max;
}

async function listImportable(root: string, skip: Skip): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e: any) {
      if (e?.code === "ENOENT") return;
      throw new LayerfsError("ScanFailed", `cannot read ${relative(root, dir) || "."}: ${e?.code ?? e}`);
    }
    for (const ent of entries) {
      const abs = join(dir, ent.name);
      const rel = relative(root, abs).split("\\").join("/");
      if (skip(rel, ent.isDirectory())) continue; // full tree: .git, ignored files and dependencies included
      if (ent.isDirectory()) await walk(abs);
      else out.push(rel);
    }
  };
  await walk(root);
  return out;
}

export function matchesToolGlob(rel: string, pattern: string): boolean {
  if (pattern.includes("/")) return posix.matchesGlob(rel, pattern) || posix.matchesGlob(rel, `**/${pattern}`);
  return posix.matchesGlob(posix.basename(rel), pattern);
}

/** Same-folder starters wait for a live importer; a large first import can take minutes. */
const INIT_LOCK_WAIT_MS = 30 * 60_000;

const STREAM_HASH_BYTES = 8 * 1024 * 1024;
/** A scan keeps at most this many changed bytes in memory; a sync re-reads the rest from disk. */
const SCAN_KEEP_BYTES = 64 * 1024 * 1024;
/** Host sync writes changes through the Store (`fs.apply`) in batches of this many bytes/ops; larger drift goes through one mount. */
const SYNC_STORE_BATCH_BYTES = 8 * 1024 * 1024;
const SYNC_STORE_MAX_FILES = 2000;
async function streamSha(abs: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(abs, { highWaterMark: 1024 * 1024 })) h.update(chunk as Buffer);
  return h.digest("hex");
}

/** Parallel directory reads/stats: a sequential walk of a 160k-file folder takes seconds. */
const SCAN_CONCURRENCY = 32;

/**
 * Signatures of every file under `root`. Files whose mtime/size/mode match `cache` reuse the
 * cached entry without reading. With `keepBytes`, bytes are kept only for files whose signature
 * differs from `cache` (the ones a sync must write); never for the whole tree, which can be GBs.
 */
async function scanHostDirectory(root: string, skip: Skip, cache: HostIndex = {}, strict = false, keepBytes = true): Promise<{ index: HostIndex; bytes: Map<string, Buffer> }> {
  const index: HostIndex = {};
  const bytes = new Map<string, Buffer>();
  let keptBytes = 0;
  const visit = async (abs: string, rel: string) => {
    const st = await fsp.lstat(abs).catch((e: any) => (e?.code === "ENOENT" ? null : Promise.reject(e)));
    if (!st) return;
    const prev = cache[rel];
    if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size && (prev.mode === undefined || prev.mode === (st.mode & 0o7777))) {
      index[rel] = prev;
      return;
    }
    if (st.isSymbolicLink()) {
      index[rel] = { ...linkSig(await fsp.readlink(abs)), mtimeMs: st.mtimeMs, size: st.size };
    } else if (st.isFile()) {
      if (st.size > STREAM_HASH_BYTES) {
        // hash big files as a stream; a sync that needs the bytes re-reads them
        index[rel] = { kind: "file", sig: await streamSha(abs), mode: st.mode & 0o7777, mtimeMs: st.mtimeMs, size: st.size };
        return;
      }
      const data = await fsp.readFile(abs);
      const entry: HostEntry = { ...fileSig(data, st.mode), mtimeMs: st.mtimeMs, size: st.size };
      index[rel] = entry;
      if (keepBytes && !sameSig(prev, entry) && keptBytes + data.length <= SCAN_KEEP_BYTES) {
        bytes.set(rel, data);
        keptBytes += data.length;
      }
    }
  };
  // read one directory: queue its sub-directories, stat its files
  const readDir = async (dir: string, dirRel: string) => {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (e: any) {
        if (e?.code === "ENOENT" || !strict) return;
        throw new LayerfsError("ScanFailed", `cannot read ${dirRel || "."}: ${e?.code ?? e}`);
      }
      const files: Array<[string, string]> = [];
      for (const ent of entries) {
        if ((!dirRel && ent.name === ".lww") || ent.name.includes(".minilfs-")) continue;
        const rel = dirRel ? `${dirRel}/${ent.name}` : ent.name;
        // an ignored directory is skipped whole, without reading it
        if (skip(rel, ent.isDirectory())) continue;
        const abs = join(dir, ent.name);
        if (ent.isDirectory()) pending.push([abs, rel]);
        else files.push([abs, rel]);
      }
      for (let i = 0; i < files.length; i += SCAN_CONCURRENCY) {
        await Promise.all(files.slice(i, i + SCAN_CONCURRENCY).map(([a, r]) => visit(a, r)));
      }
  };
  const pending: Array<[string, string]> = [[root, ""]];
  let active = 0;
  let failure: unknown = null;
  await new Promise<void>((done) => {
    const pump = () => {
      while (!failure && active < SCAN_CONCURRENCY && pending.length) {
        const [abs, rel] = pending.pop()!;
        active++;
        readDir(abs, rel).catch((e) => { failure ??= e; }).finally(() => { active--; pump(); });
      }
      if (!active && (failure || !pending.length)) done();
    };
    pump();
  });
  if (failure) throw failure;
  return { index, bytes };
}

function runLocal(cmd: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => resolveRun({ code: -1, stderr: e.message }));
    child.on("close", (code) => resolveRun({ code, stderr }));
  });
}

/** True if `path` (any spelling) is a mount point in the OS mount table. */
async function isMountPoint(path: string): Promise<boolean> {
  const r = await run("/sbin/mount", [], { timeoutMs: 5000 }).catch(() => null);
  if (!r?.stdout) return false;
  const table = r.stdout.toString();
  return bothSpellings(path).some((p) => table.includes(` on ${p} (`));
}

/** Last resort when LayerFS cannot end a Workspace: remove its NFS mount from the OS mount table. */
async function forceUnmount(wsReal: string): Promise<void> {
  for (const p of bothSpellings(wsReal)) {
    if (!(await isMountPoint(p))) continue;
    await run("/sbin/umount", ["-f", p], { timeoutMs: 10_000 }).catch(() => null);
  }
}

export async function stopNativeDaemons(localDir?: string): Promise<void> {
  // the root's store workers first (they hold the Stores), then the daemons; <root>/local is localDir
  if (localDir) stopWorkers(dirname(localDir));
  const pattern = localDir ? `layerfs-daemon --config ${localDir}/` : "layerfs-daemon --config ";
  const r = await run("pgrep", ["-f", pattern]).catch(() => null);
  if (r?.code === 0 && r.stdout.length > 0) {
    const pids = r.stdout.toString().split(/\s+/).filter(Boolean);
    for (const pid of pids) {
      const n = Number(pid);
      if (n > 0 && n !== process.pid) {
        try { process.kill(n, "SIGTERM"); } catch {}
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}
