import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsc, promises as fsp } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { BindingStore, type HostEntry, type HostIndex, type ProjectRecord, type SessionBinding } from "./bindings.ts";
import type { LayerfsConfig } from "./config.ts";
import { DockerError, dockerEnv, ok, run } from "./docker.ts";
import { type BoxSpec, createProjectClient, ensureStoreBox } from "./port/client.ts";

export interface Workspace { sandbox: string; path: string; image?: string }
export interface Checkpoint { origins: string[]; label: string; commit: string | null; branch: string; changed: boolean; at: number }
export interface ApplyResult { applied: string[]; skipped: string[]; conflicts: string[]; unchanged: string[] }
export interface OpenOptions {
  reason?: "startup" | "reload" | "new" | "resume" | "fork";
  resumeBinding?: { project?: string; baseBranch?: string; workBranch?: string; baseRef?: string; headCommit?: string | null };
  forkFromRef?: string | null;
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
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/**
 * v0.2 LayerFS Session:
 * - Shares one persistent Project Store per host folder across sessions/agents (`BindingStore`)
 * - Syncs external host edits into `"main"` on session start (fixes P0-6)
 * - Routes `read / write / edit / ls / find / grep` through `lfs.fs.*` directly on the Store,
 *   with automatic byte-exact Workspace fallback for binary, symlinks or >48KB lines (fixes P0-2, P0-5, P1-1..P1-4)
 * - Mounts a Workspace on demand per `bash` call (`mount -> docker exec setsid -> commit -> unmount`),
 *   with no global container symlink (fixes P0-3)
 * - Diffs and applies against this session's own `baseBranch` anchor and merges before publishing `"main"` (fixes P0-1, P0-4)
 * - Supports `/resume`, `/tree` and `/fork` time-travel via `switchToRef()` (fixes P1-5)
 */
export class LayerfsSession {
  readonly cwd: string;
  readonly sessionId: string;
  readonly shortId: string;
  readonly config: LayerfsConfig;
  readonly log: Log;

  bindings!: BindingStore;
  boxSpec!: BoxSpec;
  projectRecord!: ProjectRecord;
  lfs: any;
  operator: any;

  baseBranch = "";
  workBranch = "";
  baseRef = "";
  headCommit: string | null = null;
  seq = 0;

  blocked: { reason: string; heldWs?: Workspace } | null = null;
  pendingOrigins: string[] = [];
  checkpoints: Checkpoint[] = [];
  unapplied = false;

  private lastStoreCommit: { kind: string; head: string | null } | null = null;
  private identByContainer = new Map<string, string>();
  private activeSids = new Map<string, () => Promise<void>>();
  private mutex: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(cwd: string, sessionId: string, config: LayerfsConfig, log: Log = () => {}) {
    this.cwd = resolve(cwd);
    this.sessionId = sessionId;
    this.shortId = createHash("sha256").update(`${sessionId}:${randomBytes(8).toString("hex")}`).digest("hex").slice(0, 10);
    this.config = config;
    this.log = log;
  }

  get project(): string { return this.projectRecord?.name ?? ""; }
  get volume(): string { return this.projectRecord?.volume ?? ""; }
  /** Effective snapshot ref even when no Commit has been made on workBranch yet (P1-5). */
  get effectiveRef(): string { return this.headCommit ?? this.baseRef; }

  // ---------------------------------------------------------------- startup & project sharing

  static async preflight(config: LayerfsConfig): Promise<string> {
    const problems: string[] = [];
    for (const f of ["layerfs.node", "layerfs-daemon", "sdk/js/src/index.js"]) {
      try { await fsp.access(join(config.bundle, f), fsc.R_OK); } catch { problems.push(`missing ${join(config.bundle, f)}`); }
    }
    const info = await run(config.docker, ["info", "--format", "{{.OSType}}"], { timeoutMs: 15_000 }).catch((e) => ({ code: -1, stdout: Buffer.from(""), stderr: e.message }));
    if (info.code !== 0) problems.push(`Docker is not reachable (${info.stderr.trim().slice(0, 200)})`);
    let imageId = "";
    if (info.code === 0) {
      const img = await run(config.docker, ["image", "inspect", "--format", "{{.Id}}", config.image], { timeoutMs: 15_000 });
      if (img.code !== 0) problems.push(`runtime image ${config.image} not found`);
      else imageId = img.stdout.toString().trim();
    }
    if (problems.length) throw new LayerfsError("Preflight", `LayerFS is not available: ${problems.join("; ")}`);
    return imageId;
  }

  async open(options: OpenOptions = {}): Promise<void> {
    const t0 = Date.now();
    const imageId = await LayerfsSession.preflight(this.config);
    this.boxSpec = await ensureStoreBox(this.config, imageId);
    this.bindings = new BindingStore(join(this.config.root, "state"));

    const existing = this.bindings.byFolder(this.cwd);
    const usable = existing && await this.isProjectAlive(existing);
    if (!usable) {
      this.projectRecord = await this.initProjectForFolder(imageId);
    } else {
      this.projectRecord = existing!;
      const client = await createProjectClient(this.boxSpec, this.projectRecord);
      this.lfs = client.lfs;
      this.operator = client.operator;
      if (options.reason !== "reload" && options.reason !== "resume" && !options.forkFromRef) {
        await this.syncHostDriftIntoMain();
      }
    }

    await this.setupBranches(options);
    this.persistSessionBinding();
    this.log(`ready in ${Date.now() - t0} ms (project=${this.project} base=${this.baseBranch} work=${this.workBranch})`);
  }

  private async isProjectAlive(p: ProjectRecord): Promise<boolean> {
    const homeEntry = join(this.boxSpec.home, p.name);
    const hasHome = await fsp.access(homeEntry).then(() => true, () => false);
    if (!hasHome) return false;
    const v = await run(this.config.docker, ["volume", "inspect", p.volume], { timeoutMs: 10_000 });
    return v.code === 0;
  }

  private async initProjectForFolder(imageId: string): Promise<ProjectRecord> {
    const name = this.bindings.freeProjectName(this.cwd, this.boxSpec.home);
    return this.bindings.withProjectLock(name, async () => {
      const again = this.bindings.byFolder(this.cwd);
      if (again && await this.isProjectAlive(again)) {
        const client = await createProjectClient(this.boxSpec, again);
        this.lfs = client.lfs;
        this.operator = client.operator;
        return again;
      }
      const created = Date.now();
      const volume = `${this.config.prefix}${name}-store-${created.toString(36)}`;
      const staged = join(this.config.root, "staging", `${name}-${created}`);
      await fsp.mkdir(staged, { recursive: true });
      try {
        const rs = await runLocal("rsync", ["-a", ...this.config.excludes.map((e) => `--exclude=${e}`), `${this.cwd}/`, `${staged}/`]);
        if (rs.code !== 0) throw new LayerfsError("Failed", `staging copy failed: ${rs.stderr.slice(0, 400)}`);
        const hostIndex = await scanHostDirectory(this.cwd, this.config.excludes);
        const lwwPath = join(staged, ".lww");
        const hadLww = await fsp.access(lwwPath).then(() => true, () => false);
        if (!hadLww) await fsp.writeFile(lwwPath, "%include .gitignore\n");

        await ok(this.config.docker, ["volume", "create", "--label", "pi-layerfs.role=project", "--label", `pi-layerfs.project=${name}`, volume]);
        const record: ProjectRecord = { name, source: this.cwd, volume, image: imageId, mainRef: "", created, updatedAt: created };
        const client = await createProjectClient(this.boxSpec, record);
        this.lfs = client.lfs;
        this.operator = client.operator;
        try {
          const initRes = await this.lfs.project.init(staged);
          record.mainRef = initRes.layer;
        } catch (e) {
          await run(this.config.docker, ["volume", "rm", volume]).catch(() => {});
          await run(this.config.docker, ["exec", this.boxSpec.box, "rm", "-rf", join(this.boxSpec.home, name)]).catch(() => {});
          throw e;
        }
        this.bindings.writeHostIndex(name, hostIndex);
        this.bindings.addProject(this.cwd, record);
        return record;
      } finally {
        await fsp.rm(staged, { recursive: true, force: true }).catch(() => {});
      }
    });
  }

  /** P0-6 fix: detects host file edits / git pull outside Pi and syncs them into `"main"` before forking. */
  async syncHostDriftIntoMain(): Promise<{ synced: string[] }> {
    return this.bindings.withProjectLock(this.projectRecord.name, async () => {
      const prev = this.bindings.readHostIndex(this.projectRecord.name);
      const curr = await scanHostDirectory(this.cwd, this.config.excludes, prev);
      const changed: string[] = [];
      const removed: string[] = [];
      for (const [rel, ent] of Object.entries(curr)) {
        const old = prev[rel];
        if (!old || old.kind !== ent.kind || old.sig !== ent.sig || (ent.kind === "file" && old.mode !== ent.mode)) {
          changed.push(rel);
        }
      }
      for (const rel of Object.keys(prev)) {
        if (!curr[rel]) removed.push(rel);
      }
      if (!changed.length && !removed.length) {
        this.bindings.writeHostIndex(this.projectRecord.name, curr);
        return { synced: [] };
      }

      const syncBranch = `sync-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
      await this.lfs.branch.fork(syncBranch, "main");
      const storeOps: any[] = [];
      const mountJobs: Array<{ rel: string; entry: HostEntry }> = [];

      for (const rel of removed) {
        storeOps.push({ op: "rm", path: `/${rel}` });
      }
      for (const rel of changed) {
        const ent = curr[rel];
        const prevEnt = prev[rel];
        const modeChanged = ent.kind === "file" && ((prevEnt && prevEnt.mode !== ent.mode) || (!prevEnt && ((ent.mode ?? 0o644) & 0o111) !== 0));
        if (ent.kind === "symlink" || modeChanged || prevEnt?.kind === "symlink") {
          mountJobs.push({ rel, entry: ent });
        } else {
          const dir = posix.dirname(`/${rel}`);
          if (dir !== "/") storeOps.push({ op: "mkdir", path: dir });
          const bytes = await fsp.readFile(join(this.cwd, rel));
          storeOps.push({ op: "write", path: `/${rel}`, bytes });
        }
      }

      if (storeOps.length) {
        await this.lfs.fs.apply(syncBranch, storeOps, "sync host drift").catch(async () => {
          for (const rel of changed) {
            if (!mountJobs.some((m) => m.rel === rel)) mountJobs.push({ rel, entry: curr[rel] });
          }
          for (const rel of removed) {
            await this.lfs.fs.rm(syncBranch, `/${rel}`, "sync rm").catch(() => {});
          }
        });
      }

      if (mountJobs.length) {
        await this.withMountedBranch(syncBranch, true, "sync host special files", async (ctr, ident, wsPath) => {
          for (const { rel, entry } of mountJobs) {
            const dst = posix.join(wsPath, rel);
            if (entry.kind === "symlink") {
              const target = entry.sig.slice("link:".length);
              await this.dexec(ctr, ident, `mkdir -p "$(dirname "$1")" && rm -rf "$1" && ln -s "$2" "$1"`, [dst, target]);
            } else {
              const bytes = await fsp.readFile(join(this.cwd, rel));
              const modeOct = ((entry.mode ?? 0o644) & 0o7777).toString(8);
              await this.dexec(ctr, ident, `mkdir -p "$(dirname "$1")" && rm -f "$1" && cat > "$1" && chmod "$2" "$1"`, [dst, modeOct], bytes);
            }
          }
        });
      }

      const pub = await this.lfs.branch.publish(syncBranch);
      this.projectRecord.mainRef = pub.layer ?? this.projectRecord.mainRef;
      this.bindings.updateProjectMain(this.projectRecord.name, this.projectRecord.mainRef);
      this.bindings.writeHostIndex(this.projectRecord.name, curr);
      return { synced: [...changed, ...removed] };
    });
  }

  private async setupBranches(options: OpenOptions): Promise<void> {
    const saved = options.resumeBinding ?? (options.reason === "resume" || options.reason === "reload" ? this.bindings.session(this.sessionId) : null);
    if (saved && saved.project === this.projectRecord.name && !options.forkFromRef) {
      const branches = await this.listAllBranches();
      const wb = branches.find((b) => b.name === saved.workBranch);
      const bb = branches.find((b) => b.name === saved.baseBranch);
      const targetRef = saved.headCommit ?? saved.baseRef;
      if (wb && bb && (!targetRef || (wb.head ?? wb.base) === targetRef)) {
        this.baseBranch = saved.baseBranch!;
        this.workBranch = saved.workBranch!;
        this.baseRef = saved.baseRef ?? bb.head ?? bb.base;
        this.headCommit = wb.head ?? null;
        this.unapplied = (await this.diff()).filter((i) => i.type !== "dir").length > 0;
        return;
      }
      if (targetRef && bb) {
        this.seq++;
        this.baseBranch = saved.baseBranch!;
        this.baseRef = saved.baseRef ?? bb.head ?? bb.base;
        this.workBranch = `s-${this.shortId}-${this.seq}`;
        const f = await this.lfs.branch.fork(this.workBranch, targetRef);
        this.headCommit = f.head ?? null;
        this.unapplied = (await this.diff()).filter((i) => i.type !== "dir").length > 0;
        return;
      }
    }

    const fromRef = options.forkFromRef || "main";
    this.seq++;
    this.baseBranch = `b-${this.shortId}-${this.seq}`;
    this.workBranch = `s-${this.shortId}-${this.seq}`;
    // baseBranch always anchors to "main" (what is on the host disk), while workBranch starts from forkFromRef
    const fb = await this.lfs.branch.fork(this.baseBranch, "main");
    const fw = await this.lfs.branch.fork(this.workBranch, fromRef);
    this.baseRef = fb.head ?? fb.base;
    this.headCommit = fw.head ?? (fromRef !== "main" && fromRef !== this.baseRef ? fromRef : null);
    this.unapplied = fromRef !== "main" ? (await this.diff()).filter((i) => i.type !== "dir").length > 0 : false;
  }

  /** P1-5 fix: switches `workBranch` to a historical Commit or Layer ref (for `/tree` and `/fork`) after draining `mutex`. */
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
      this.unapplied = (await this.diff()).filter((i) => i.type !== "dir").length > 0;
      this.persistSessionBinding();
      return { branch: this.workBranch, ref: this.effectiveRef };
    });
    this.mutex = job.catch(() => {});
    return job;
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

  // ---------------------------------------------------------------- path mapping

  toRel(hostPath: string): string | null {
    const abs = resolve(this.cwd, hostPath);
    const rel = relative(this.cwd, abs);
    if (rel === "") return "";
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    return rel.split("\\").join("/");
  }

  toStorePath(hostPath: string): string | null {
    const rel = this.toRel(hostPath);
    if (rel === null) return null;
    return rel === "" ? "/" : `/${rel}`;
  }

  private mustStorePath(hostPath: string): string {
    const sp = this.toStorePath(hostPath);
    if (!sp) throw new Error(`${hostPath} is outside the LayerFS workspace (${this.cwd}); writes there are refused`);
    const rel = sp.replace(/^\/+/, "");
    if (rel && isExcludedPath(rel, this.config.excludes)) {
      throw enoent(hostPath, "excluded secret file");
    }
    return sp;
  }

  toWsPath(wsRoot: string, hostPath: string): string | null {
    const rel = this.toRel(hostPath);
    if (rel === null) return null;
    return rel === "" ? wsRoot : posix.join(wsRoot, rel);
  }

  // ---------------------------------------------------------------- Store file ops + byte-exact fallback

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

  /** Reads exact bytes of `storePath` at `ref` without loss (Store fast path + Workspace fallback for binary/long-line/symlink). */
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
          // P0-2 fix: a >48KiB line was clipped; fall back to raw bytes from a mount
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
    return this.withMountedBranch(branchToMount, false, "read bytes", async (ctr, ident, wsPath) => {
      const p = posix.join(wsPath, storePath.replace(/^\/+/, ""));
      const r = await this.dexec(ctr, ident, `cat -- "$1"`, [p]);
      if (r.code !== 0) throw enoent(originalHostPath, r.stderr);
      return r.stdout;
    });
  }

  async readFile(hostPath: string): Promise<Buffer> {
    const sp = this.toStorePath(hostPath);
    if (!sp) return fsp.readFile(resolve(this.cwd, hostPath));
    return this.readBytesAtRef(this.workBranch, sp, hostPath);
  }

  async access(hostPath: string, write = false): Promise<void> {
    const sp = this.toStorePath(hostPath);
    if (!sp) {
      if (write) this.mustStorePath(hostPath);
      return fsp.access(resolve(this.cwd, hostPath), fsc.R_OK);
    }
    const rel = sp.replace(/^\/+/, "");
    if (rel && isExcludedPath(rel, this.config.excludes)) throw enoent(hostPath, "not accessible");
    const st = await this.lfs.fs.stat(this.workBranch, sp).catch(() => null);
    if (st) return;
    if (await this.hasSymlinkInChain(posix.dirname(sp), this.workBranch)) {
      await this.withMountedBranch(this.workBranch, false, "access", async (ctr, ident, wsPath) => {
        const p = posix.join(wsPath, rel);
        const r = await this.dexec(ctr, ident, write ? `test -r "$1" && test -w "$1"` : `test -r "$1"`, [p]);
        if (r.code !== 0) throw enoent(hostPath, "not accessible");
      });
      return;
    }
    throw enoent(hostPath, "not accessible");
  }

  async exists(hostPath: string): Promise<boolean> {
    const sp = this.toStorePath(hostPath);
    if (!sp) return fsp.access(resolve(this.cwd, hostPath)).then(() => true, () => false);
    const rel = sp.replace(/^\/+/, "");
    if (rel && isExcludedPath(rel, this.config.excludes)) return false;
    const st = await this.lfs.fs.stat(this.workBranch, sp).catch(() => null);
    if (st) return true;
    if (await this.hasSymlinkInChain(posix.dirname(sp), this.workBranch)) {
      return this.withMountedBranch(this.workBranch, false, "exists", async (ctr, ident, wsPath) => {
        const r = await this.dexec(ctr, ident, `test -e "$1" || test -L "$1"`, [posix.join(wsPath, rel)]);
        return r.code === 0;
      });
    }
    return false;
  }

  async isDirectory(hostPath: string): Promise<boolean> {
    const sp = this.toStorePath(hostPath);
    if (!sp) return (await fsp.stat(resolve(this.cwd, hostPath))).isDirectory();
    const rel = sp.replace(/^\/+/, "");
    if (rel && isExcludedPath(rel, this.config.excludes)) throw enoent(hostPath, "no such file or directory");
    const st = await this.lfs.fs.stat(this.workBranch, sp).catch(() => null);
    if (st) {
      if (st.type === "dir") return true;
      if (st.type === "file") return false;
    }
    return this.withMountedBranch(this.workBranch, false, "isDirectory", async (ctr, ident, wsPath) => {
      const r = await this.dexec(ctr, ident, `if [ -d "$1" ]; then echo d; elif [ -e "$1" ]; then echo f; else exit 2; fi`, [posix.join(wsPath, rel)]);
      if (r.code !== 0) throw enoent(hostPath, "no such file or directory");
      return r.stdout.toString().trim() === "d";
    });
  }

  async readdir(hostPath: string): Promise<string[]> {
    const sp = this.toStorePath(hostPath);
    if (!sp) return fsp.readdir(resolve(this.cwd, hostPath));
    try {
      const names: string[] = [];
      for (let pos = 0; ; ) {
        const page = await this.lfs.fs.list(this.workBranch, sp, 1000, pos);
        for (const it of page.items ?? []) {
          if (it.name === ".lww" || isExcludedPath(it.path.replace(/^\/+/, ""), this.config.excludes)) continue;
          names.push(it.name);
        }
        if (!page.hasMore || !(page.items ?? []).length) break;
        pos = page.nextPagePos ?? (pos + page.items.length);
      }
      return names.sort();
    } catch (e: any) {
      if (e?.code === "NotDirectory" || e?.code === "NoSuchPath") {
        const rel = sp.replace(/^\/+/, "");
        return this.withMountedBranch(this.workBranch, false, "readdir", async (ctr, ident, wsPath) => {
          const r = await this.dexec(ctr, ident, `find "$1" -mindepth 1 -maxdepth 1 -printf '%f\\0'`, [posix.join(wsPath, rel)]);
          if (r.code !== 0) throw enoent(hostPath, r.stderr);
          return r.stdout.toString().split("\0").filter((n) => n && n !== ".lww" && !isExcludedPath(rel ? `${rel}/${n}` : n, this.config.excludes)).sort();
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
      this.lastStoreCommit = { kind: res.kind, head: res.commit?.id ?? res.head ?? null };
      return;
    }
    const rel = sp.replace(/^\/+/, "");
    await this.withMountedBranch(this.workBranch, true, `pi write [${this.pendingOrigins.join(",") || "write"}]`, async (ctr, ident, wsPath) => {
      const p = posix.join(wsPath, rel);
      const r = await this.dexec(ctr, ident, `mkdir -p "$(dirname "$1")" && cat > "$1"`, [p], bytes);
      if (r.code !== 0) throw new Error(`write ${hostPath} failed: ${r.stderr.trim()}`);
    });
  }

  // ---------------------------------------------------------------- Store-backed find & hybrid grep (P1-1, P1-2)

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
          matches++;
          lines.push(`${display}:${m.line}: ${String(m.text).replace(/\r?\n$/, "")}`);
        }
        if (!page.hasMore || !(page.items ?? []).length) break;
        pos = page.nextPagePos ?? (pos + page.items.length);
      }
      return { lines, matches, limitReached: false };
    }

    // Regex, ignoreCase or context lines -> short mount running GNU grep -P
    return this.withMountedBranch(this.workBranch, false, "grep", async (ctr, ident, wsPath) => {
      const rel = sp.replace(/^\/+/, "");
      const targetWs = rel ? posix.join(wsPath, rel) : wsPath;
      const flags = [
        "-rnIH", "--exclude=.lww", "--exclude-dir=.git", "--exclude-dir=node_modules",
        params.ignoreCase ? "-i" : "", params.literal ? "-F" : "-P",
        params.context ? `-C${Math.floor(params.context)}` : "",
        ...(globPatterns ? globPatterns.map((g) => `--include=${g}`) : []),
      ].filter(Boolean);
      const isDir = await this.isDirectory(targetHost);
      const script = isDir
        ? `cd "$1" && grep ${flags.map((f) => `'${f}'`).join(" ")} -e "$2" -- .`
        : `cd "$(dirname "$1")" && grep ${flags.map((f) => `'${f}'`).join(" ")} -e "$2" -- "$(basename "$1")"`;
      const r = await this.dexec(ctr, ident, script, [targetWs, params.pattern]);
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

  private async containerAndIdent(ws: Workspace): Promise<{ container: string; ident: string }> {
    const container = `${this.config.prefix}${this.projectRecord.name}-${ws.sandbox}`;
    let ident = this.identByContainer.get(container);
    if (!ident) {
      const r = await this.lfs.workspace.exec(ws, "id -u; id -g");
      const [uid, gid] = String(r.stdout).trim().split("\n");
      ident = `${uid || "501"}:${gid || "20"}`;
      this.identByContainer.set(container, ident);
    }
    return { container, ident };
  }

  private async dexec(container: string, ident: string, script: string, args: string[] = [], input?: Buffer | string) {
    const r = await run(
      this.config.docker,
      ["exec", ...(input !== undefined ? ["-i"] : []), "-u", ident, "-e", "HOME=/tmp", container, "sh", "-c", script, "_", ...args],
      { input, timeoutMs: 120_000 },
    );
    if (r.code !== 0) this.checkSandbox(container, r.stderr);
    return r;
  }

  private checkSandbox(container: string, stderr: string) {
    if (/No such container|is not running|container .* is paused/i.test(stderr)) {
      throw new LayerfsError("SandboxGone", `the LayerFS Sandbox ${container} is gone (${stderr.trim().slice(0, 160)}); committed work is safe in volume ${this.volume}.`);
    }
  }

  /** Mounts `branch`, runs `fn`, optionally commits, reaps any holders of `ws.path`, and unmounts immediately. */
  private async withMountedBranch<T>(
    branch: string,
    commitAfter: boolean,
    message: string,
    fn: (container: string, ident: string, wsPath: string, ws: Workspace) => Promise<T>,
  ): Promise<T> {
    const ws = await this.lfs.workspace.mount(branch);
    const { container, ident } = await this.containerAndIdent(ws);
    let keepMounted = false;
    try {
      const value = await fn(container, ident, ws.path, ws);
      if (commitAfter) {
        const res = await this.lfs.workspace.commit(ws, message.slice(0, 4000));
        this.lastStoreCommit = { kind: res.kind, head: res.commit?.id ?? res.head ?? null };
      }
      return value;
    } catch (e) {
      if (commitAfter) {
        try {
          const res = await this.lfs.workspace.commit(ws, `${message} (failed)`.slice(0, 4000));
          this.lastStoreCommit = { kind: res.kind, head: res.commit?.id ?? res.head ?? null };
        } catch (ce: any) {
          keepMounted = true;
          this.blocked = { reason: `${ce?.code ?? "Error"}: ${String(ce?.message ?? ce).slice(0, 200)}`, heldWs: ws };
        }
      }
      throw e;
    } finally {
      if (!keepMounted) {
        await this.reapHolders(container, ident, ws.path).catch(() => {});
        await this.lfs.workspace.unmount(ws, !commitAfter).catch(() => {});
      }
    }
  }

  /** Runs a shell snippet in a short-lived Workspace of `workBranch` (read-only helper for tests/apply). */
  async sh(script: string, args: string[] = []): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return this.withMountedBranch(this.workBranch, false, "sh", async (ctr, ident, wsPath) => {
      const rewrittenArgs = args.map((a) => (a === this.cwd ? wsPath : a.startsWith(`${this.cwd}/`) ? posix.join(wsPath, a.slice(this.cwd.length + 1)) : a));
      const r = await this.dexec(ctr, ident, `cd "$1" && shift && ${script}`, [wsPath, ...rewrittenArgs]);
      return { code: r.code, stdout: r.stdout.toString(), stderr: r.stderr };
    });
  }

  /**
   * Pi BashOperations.exec contract:
   * Mounts a Workspace for this command, streams stdout/stderr via `docker exec setsid`,
   * commits any file changes, reaps holders of this Workspace path, and unmounts immediately.
   * Never creates a global symlink in the container (fixes P0-3).
   */
  async exec(
    command: string,
    hostCwd: string,
    options: { onData: (d: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv },
  ): Promise<{ exitCode: number | null }> {
    if (options.signal?.aborted) throw new Error("aborted");
    const ws = await this.lfs.workspace.mount(this.workBranch);
    const { container, ident } = await this.containerAndIdent(ws);
    const wsCwd = this.toWsPath(ws.path, hostCwd) ?? ws.path;
    const rewrittenCmd = command.replaceAll(this.cwd, ws.path);

    const tag = `${this.shortId}-${randomBytes(4).toString("hex")}`;
    const sidFile = `/tmp/pi-lfs-${tag}.sid`;
    const envArgs: string[] = [];
    for (const [k, v] of Object.entries(options.env ?? {})) {
      if (typeof v === "string" && (k.startsWith("PI_") || this.config.envAllow.includes(k))) {
        envArgs.push("-e", `${k}=${v}`);
      }
    }

    const script = `echo $$ > ${sidFile}; ${gitHidePrelude(this.config.excludes)} cd "$1" || exit 1; exec bash -c "$0"`;
    const child = spawn(
      this.config.docker,
      ["exec", "-u", ident, "-e", "HOME=/tmp", ...envArgs, "-w", ws.path, container, "setsid", "-w", "bash", "-c", script, rewrittenCmd, wsCwd, ws.path],
      { stdio: ["ignore", "pipe", "pipe"], env: dockerEnv() },
    );
    let errText = "";
    child.stdout.on("data", options.onData);
    child.stderr.on("data", (d) => {
      errText = (errText + d).slice(-2000);
      options.onData(d);
    });

    let stopping: Promise<void> | null = null;
    const kill = () => (stopping ??= this.killSession(container, sidFile));
    this.activeSids.set(tag, kill);
    let timedOut = false;
    const timer = options.timeout && options.timeout > 0 ? setTimeout(() => { timedOut = true; void kill(); }, options.timeout * 1000) : undefined;
    const onAbort = () => void kill();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    let keepMounted = false;
    try {
      const code = await new Promise<number | null>((resolveCode, reject) => {
        child.on("error", reject);
        child.on("close", (c) => resolveCode(c));
      });
      if (stopping) await stopping;
      if (code === 1 || code === 125 || code === 126) this.checkSandbox(container, errText);

      await this.reapHolders(container, ident, ws.path).catch(() => {});
      await this.dexec(container, ident, `if [ ! -f "$1/.lww" ]; then printf '%%include .gitignore\\n' > "$1/.lww"; fi`, [ws.path]).catch(() => {});

      const msg = `pi bash (exit ${code ?? "sig"}) [${this.pendingOrigins.join(",") || "bash"}]`.slice(0, 4000);
      try {
        const res = await this.lfs.workspace.commit(ws, msg);
        this.lastStoreCommit = { kind: res.kind, head: res.commit?.id ?? res.head ?? null };
      } catch (ce: any) {
        keepMounted = true;
        this.blocked = { reason: `${ce?.code ?? "Error"}: ${String(ce?.message ?? ce).slice(0, 200)}`, heldWs: ws };
      }

      if (options.signal?.aborted) throw new Error("aborted");
      if (timedOut) throw new Error(`timeout:${options.timeout}`);
      return { exitCode: code };
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      this.activeSids.delete(tag);
      void run(this.config.docker, ["exec", "-u", "0", container, "rm", "-f", sidFile]).catch(() => {});
      if (!keepMounted) {
        await this.reapHolders(container, ident, ws.path).catch(() => {});
        await this.lfs.workspace.unmount(ws).catch(() => {});
      }
    }
  }

  private async killSession(container: string, sidFile: string): Promise<void> {
    const g = Math.max(0.1, this.config.killGraceMs / 1000);
    const script = `sid=$(cat ${sidFile} 2>/dev/null) || exit 0; [ -n "$sid" ] || exit 0; pkill -TERM -s "$sid"; i=0; while pgrep -s "$sid" >/dev/null && [ $i -lt $(awk "BEGIN{print int(${g}*10)}") ]; do sleep 0.1; i=$((i+1)); done; pkill -KILL -s "$sid"; true`;
    await run(this.config.docker, ["exec", "-u", "0", container, "sh", "-c", script], { timeoutMs: this.config.killGraceMs + 15_000 });
  }

  private async reapHolders(container: string, ident: string, wsPath: string): Promise<void> {
    await run(this.config.docker, [
      "exec", "-u", ident, container, "sh", "-c",
      `for p in /proc/[0-9]*; do c=$(readlink $p/cwd 2>/dev/null); case "$c" in ${wsPath}|${wsPath}/*) kill -KILL "\${p#/proc/}" 2>/dev/null;; esac; done; true`,
    ]);
  }

  // ---------------------------------------------------------------- mutation queue & checkpoint gate

  mutate<T>(origin: string, label: string, fn: () => Promise<T>): Promise<{ value: T; checkpoint: Checkpoint | null; error: Error | null }> {
    const job = this.mutex.then(async () => {
      if (this.blocked) {
        throw new Error(`LayerFS checkpoint failed earlier (${this.blocked.reason}); changes are blocked until /layerfs retry succeeds`);
      }
      this.pendingOrigins.push(origin);
      this.lastStoreCommit = null;
      let value: T;
      let fnError: unknown = null;
      try {
        value = await fn();
      } catch (e) {
        fnError = e;
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
      this.headCommit = res.head ?? this.headCommit;
      this.pendingOrigins = [];
      this.unapplied = true;
      this.checkpoints.push(cp);
      this.persistSessionBinding();
      return { checkpoint: cp, error: null };
    }
    this.blocked = { reason: `unexpected commit state ${res.kind}` };
    return { checkpoint: null, error: new Error(this.blocked.reason) };
  }

  async retry(): Promise<{ checkpoint: Checkpoint | null; error: Error | null }> {
    if (!this.blocked) return { checkpoint: null, error: null };
    const heldWs = this.blocked.heldWs;
    this.pendingOrigins.push("retry");
    if (heldWs) {
      try {
        const res = await this.lfs.workspace.commit(heldWs, `pi retry [${this.pendingOrigins.join(",")}]`.slice(0, 4000));
        this.lastStoreCommit = { kind: res.kind, head: res.commit?.id ?? res.head ?? null };
        this.blocked = null;
        await this.lfs.workspace.unmount(heldWs).catch(() => {});
        return this.finalizeCheckpoint("retry");
      } catch (e: any) {
        this.blocked = { reason: `${e?.code ?? "Error"}: ${String(e?.message ?? e).slice(0, 200)}`, heldWs };
        return { checkpoint: null, error: e };
      }
    }
    this.blocked = null;
    this.pendingOrigins = [];
    return { checkpoint: null, error: null };
  }

  // ---------------------------------------------------------------- diff & apply (P0-1, P0-4 fixes)

  /** Diffs this session's `baseBranch` against `workBranch` (never against a moving `"main"`). */
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

  private async readSigAtBranch(branch: string, rel: string): Promise<HostEntry | null> {
    const sp = `/${rel}`;
    const st = await this.lfs.fs.stat(branch, sp).catch(() => null);
    if (!st) return null;
    if (st.type === "symlink") {
      return this.withMountedBranch(branch, false, "read link", async (ctr, ident, wsPath) => {
        const r = await this.dexec(ctr, ident, `readlink -- "$1"`, [posix.join(wsPath, rel)]);
        if (r.code !== 0) return null;
        return { kind: "symlink", sig: `link:${r.stdout.toString().replace(/\n$/, "")}` };
      });
    }
    const data = await this.readBytesAtRef(branch, sp);
    return { kind: "file", sig: sha(data) };
  }

  /**
   * P0-1 & P0-4 safe apply:
   * 1. Diffs `this.baseBranch` -> `this.workBranch` (only files changed by THIS session).
   * 2. Skips `.git/**`, `.lww`, and `this.config.excludes` (`.env`, etc. are never overwritten).
   * 3. Reads `baseSig` from `this.baseBranch` in the Store (immutable, never clobbered by another session).
   * 4. Refuses the entire apply if any file was modified on the host (`hostSig !== baseSig && hostSig !== wantSig`),
   *    including `Added` files that already exist on the host (`baseSig === null && hostSig !== null`).
   * 5. Atomically writes changes to the host, merges with `"main"` if another session advanced `"main"`,
   *    publishes the new `"main"`, and advances `this.baseBranch` to `this.workBranch`.
   */
  async apply(): Promise<ApplyResult> {
    if (this.blocked) {
      throw new Error(`cannot apply while a checkpoint is pending (${this.blocked.reason}); run /layerfs retry`);
    }
    await this.mutex;
    return this.bindings.withProjectLock(this.projectRecord.name, async () => {
      const items = (await this.diff()).filter((i) => i.type !== "dir");
      const result: ApplyResult = { applied: [], skipped: [], conflicts: [], unchanged: [] };
      if (!items.length) {
        this.unapplied = false;
        this.persistSessionBinding();
        return result;
      }

      const plan: Array<{ rel: string; next: { kind: "file"; data: Buffer; mode: number } | { kind: "symlink"; target: string } | null }> = [];

      await this.withMountedBranch(this.workBranch, false, "apply read", async (ctr, ident, wsPath) => {
        for (const it of items) {
          const rel = it.path.replace(/^\/+/, "");
          if (rel === ".lww" || rel === ".git" || rel.startsWith(".git/") || isExcludedPath(rel, this.config.excludes)) {
            result.skipped.push(rel);
            continue;
          }
          let next: (typeof plan)[number]["next"] = null;
          if (it.kind !== "Removed") {
            const p = posix.join(wsPath, rel);
            if (it.type === "symlink") {
              const r = await this.dexec(ctr, ident, `readlink -- "$1"`, [p]);
              if (r.code !== 0) throw new Error(`cannot read link ${rel}: ${r.stderr}`);
              next = { kind: "symlink", target: r.stdout.toString().replace(/\n$/, "") };
            } else {
              const cat = await this.dexec(ctr, ident, `cat -- "$1"`, [p]);
              if (cat.code !== 0) throw new Error(`cannot read ${rel}: ${cat.stderr}`);
              const st = await this.dexec(ctr, ident, `stat -c %a -- "$1"`, [p]);
              next = { kind: "file", data: cat.stdout, mode: parseInt(st.stdout.toString().trim() || "644", 8) };
            }
          }

          const host = await signatureOfHost(join(this.cwd, rel));
          const base = it.kind === "Added" ? null : await this.readSigAtBranch(this.baseBranch, rel);
          const want = next
            ? next.kind === "file"
              ? ({ kind: "file", sig: sha(next.data) } as const)
              : ({ kind: "symlink", sig: `link:${next.target}` } as const)
            : null;

          if (sameSig(host, want)) {
            result.unchanged.push(rel);
            continue;
          }
          if (!sameSig(host, base)) {
            result.conflicts.push(rel);
            continue;
          }
          plan.push({ rel, next });
        }
      });

      if (result.conflicts.length) return result;

      const hostIndex = this.bindings.readHostIndex(this.projectRecord.name);
      for (const { rel, next } of plan) {
        const target = join(this.cwd, rel);
        if (!next) {
          await fsp.rm(target, { force: true });
          delete hostIndex[rel];
        } else if (next.kind === "symlink") {
          await fsp.mkdir(dirname(target), { recursive: true });
          await fsp.rm(target, { force: true });
          await fsp.symlink(next.target, target);
          const st = await fsp.lstat(target);
          hostIndex[rel] = { kind: "symlink", sig: `link:${next.target}`, mtimeMs: st.mtimeMs, size: st.size };
        } else {
          await fsp.mkdir(dirname(target), { recursive: true });
          const tmp = `${target}.pi-layerfs-${randomBytes(4).toString("hex")}`;
          await fsp.writeFile(tmp, next.data, { mode: next.mode & 0o7777 });
          await fsp.chmod(tmp, next.mode & 0o7777);
          await fsp.rename(tmp, target);
          const st = await fsp.lstat(target);
          hostIndex[rel] = { kind: "file", sig: sha(next.data), mode: next.mode & 0o7777, mtimeMs: st.mtimeMs, size: st.size };
        }
        result.applied.push(rel);
      }
      this.bindings.writeHostIndex(this.projectRecord.name, hostIndex);

      // Advance "main" in the Store: merge first if another session published since our baseBranch
      try {
        const mainVsBase = await this.lfs.branch.diff_branches("main", this.baseBranch, 1, 0, { hunks: false });
        const mainUnchanged = mainVsBase.from?.root && mainVsBase.from?.root === mainVsBase.to?.root;
        let toPublish = this.workBranch;
        if (!mainUnchanged) {
          const merged = `m-${this.shortId}-${(++this.seq)}`;
          await this.lfs.branch.merge("main", this.workBranch, merged, "merge applied session");
          toPublish = merged;
        }
        if (this.headCommit !== null || toPublish !== this.workBranch) {
          const pub = await this.lfs.branch.publish(toPublish);
          if (pub?.layer) this.bindings.updateProjectMain(this.projectRecord.name, pub.layer);
        }
      } catch {
        // Host files are already updated and hostIndex is saved; a publish/merge error on main does not undo host writes
      }

      // Advance this session's baseBranch anchor to workBranch's current state
      this.seq++;
      const nextBase = `b-${this.shortId}-${this.seq}`;
      const fb = await this.lfs.branch.fork(nextBase, this.headCommit ?? this.baseRef);
      this.baseBranch = nextBase;
      this.baseRef = fb.head ?? fb.base;
      this.unapplied = false;
      this.persistSessionBinding();
      return result;
    });
  }

  // ---------------------------------------------------------------- shutdown

  async close(): Promise<{ kept: boolean; notes: string[] }> {
    const notes: string[] = [];
    if (this.closed) return { kept: true, notes };
    this.closed = true;
    await Promise.allSettled([...this.activeSids.values()].map((k) => k()));
    if (this.blocked?.heldWs) {
      await this.lfs?.workspace.unmount(this.blocked.heldWs, true).catch(() => {});
    }
    this.persistSessionBinding();
    try { await this.lfs?.close?.(); } catch {}
    if (this.unapplied || this.blocked) {
      notes.push(`unapplied changes remain on branch ${this.workBranch} in project ${this.project} (volume ${this.volume})`);
    }
    return { kept: true, notes };
  }
}

// ---------------------------------------------------------------- helpers

function enoent(path: string, why: string) {
  return Object.assign(new Error(`ENOENT: ${path}: ${why.trim() || "not found"}`), { code: "ENOENT" });
}

function sameSig(a: { kind: string; sig: string } | null, b: { kind: string; sig: string } | null) {
  if (!a || !b) return a === b;
  return a.kind === b.kind && a.sig === b.sig;
}

/**
 * Shell prelude run before each bash command (workspace root is "$2"):
 * - excluded secret files (e.g. .env) that git tracks but are absent from the Branch are marked
 *   skip-worktree, so `git status` does not report them as deleted and the agent does not "restore" them;
 * - `.lww` (LayerFS merge rules) is listed in `.git/info/exclude`, so it never shows as untracked.
 * Only `.git/` changes, which apply never writes back to the host.
 */
export function gitHidePrelude(excludes: string[]): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const specs = excludes.flatMap((e) => [q(`:(glob)${e}`), q(`:(glob)**/${e}`)]).join(" ");
  return [
    `if [ -d "$2/.git" ] && command -v git >/dev/null 2>&1; then`,
    `mkdir -p "$2/.git/info" && (grep -qxF '/.lww' "$2/.git/info/exclude" 2>/dev/null || echo '/.lww' >> "$2/.git/info/exclude");`,
    `git -C "$2" ls-files -z -- ${specs} 2>/dev/null | while IFS= read -r -d '' f; do [ -e "$2/$f" ] || git -C "$2" update-index --skip-worktree -- "$f" 2>/dev/null; done;`,
    `fi;`,
  ].join(" ");
}

export function isExcludedPath(relPath: string, patterns: string[]): boolean {
  const rel = relPath.replace(/^\/+/, "");
  const base = posix.basename(rel);
  return patterns.some((p) => posix.matchesGlob(base, p) || posix.matchesGlob(rel, p));
}

export function expandBraces(pattern: string): string[] {
  const m = /\{([^{}]+)\}/.exec(pattern);
  if (!m) return [pattern];
  const prefix = pattern.slice(0, m.index);
  const suffix = pattern.slice(m.index + m[0].length);
  return m[1].split(",").flatMap((part) => expandBraces(`${prefix}${part}${suffix}`));
}

export function matchesToolGlob(rel: string, pattern: string): boolean {
  if (pattern.includes("/")) return posix.matchesGlob(rel, pattern) || posix.matchesGlob(rel, `**/${pattern}`);
  return posix.matchesGlob(posix.basename(rel), pattern);
}

async function signatureOfHost(abs: string): Promise<HostEntry | null> {
  const st = await fsp.lstat(abs).catch(() => null);
  if (!st) return null;
  if (st.isSymbolicLink()) return { kind: "symlink", sig: `link:${await fsp.readlink(abs)}`, mtimeMs: st.mtimeMs, size: st.size };
  if (st.isFile()) return { kind: "file", sig: sha(await fsp.readFile(abs)), mode: st.mode & 0o7777, mtimeMs: st.mtimeMs, size: st.size };
  return null;
}

async function scanHostDirectory(root: string, excludes: string[], cache: HostIndex = {}): Promise<HostIndex> {
  const out: HostIndex = {};
  const walk = async (dir: string) => {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const ent of entries) {
      if (ent.name === ".git" || ent.name === ".lww") continue;
      const abs = join(dir, ent.name);
      const rel = relative(root, abs).split("\\").join("/");
      if (isExcludedPath(rel, excludes)) continue;
      if (ent.isDirectory()) {
        await walk(abs);
      } else {
        const st = await fsp.lstat(abs).catch(() => null);
        if (!st) continue;
        const prev = cache[rel];
        if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
          out[rel] = prev;
        } else {
          const s = await signatureOfHost(abs);
          if (s) out[rel] = s;
        }
      }
    }
  };
  await walk(root);
  return out;
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

export { DockerError };
