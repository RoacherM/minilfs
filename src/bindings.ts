// Project & session bindings (adapted from dsh/packages/host/src/binding.js),
// plus per-project file locks and host-index manifests for P0-1 / P0-6 / P1-6.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { acquireLock, acquireLockSync } from "./lock.ts";
import { basename, dirname, join } from "node:path";

export interface ProjectRecord {
  name: string;
  source: string;
  volume: string;
  image?: string;
  mainRef: string;
  /** main in the Store may lag the host (a publish after apply failed): resync on next start */
  mainStale?: boolean;
  /** an apply could not put the folder's git metadata back; its previous versions are here: apply refuses while it exists */
  recoveryDir?: string | null;
  /** the folder's recovery markers (`<git dir>/minilfs-recovery`, relative to the folder) recorded with recoveryDir */
  recoveryMarkers?: string[];
  created: number;
  updatedAt: number;
}

export interface SessionBinding {
  project: string;
  cwd: string;
  baseBranch: string;
  workBranch: string;
  baseRef: string;
  headCommit: string | null;
  unapplied: boolean;
  seq: number;
  updatedAt: number;
  logicalBranch?: string;
  /** see LayerfsSession.alignedRef */
  alignedRef?: string | null;
  /** the process that holds this session; an alias such as `lead` is taken only while it runs */
  pid?: number;
  /** the process's start time (libproc): a later process that reused the pid is not this session */
  pidStartSec?: number;
  pidStartUsec?: number;
  host?: string;
}

export interface HostEntry {
  kind: "file" | "symlink";
  sig: string;
  mode?: number;
  mtimeMs?: number;
  size?: number;
}

export type HostIndex = Record<string, HostEntry>;

interface BindingsData {
  version: 1;
  projects: Record<string, ProjectRecord>;
  workspaces: Record<string, { lastUsed: string | null }>;
  sessions: Record<string, SessionBinding>;
}

/**
 * Writes `target` so that once this returns it survives a power loss: the bytes are fsynced in a
 * temporary file, renamed over `target`, and the folder holding it is fsynced (the rename itself).
 */
export function writeFileAtomicSync(target: string, data: string | Buffer, mode = 0o644): void {
  const tmp = `${target}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", mode);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, target);
  const dfd = openSync(dirname(target), "r");
  try { fsyncSync(dfd); } finally { closeSync(dfd); }
}

const NAME_RE = /^[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?$/;

export function nameFromFolder(folder: string): string {
  const base = basename(folder).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "").slice(0, 48);
  return NAME_RE.test(base) ? base : "project";
}

export class BindingStore {
  readonly stateDir: string;
  readonly file: string;
  readonly lockDir: string;
  private stamp: string | null = null;
  private depth = 0;
  private _data: BindingsData = { version: 1, projects: {}, workspaces: {}, sessions: {} };

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.file = join(stateDir, "bindings.json");
    this.lockDir = `${this.file}.lock`;
    mkdirSync(stateDir, { recursive: true });
    this.reload();
  }

  reload(): void {
    let stat;
    try { stat = statSync(this.file); } catch { return; }
    const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    if (stamp === this.stamp) return;
    this._data = JSON.parse(readFileSync(this.file, "utf8"));
    this.stamp = stamp;
  }

  get data(): BindingsData {
    if (this.depth === 0) this.reload();
    return this._data;
  }

  update<T>(change: (data: BindingsData) => T): T {
    if (this.depth > 0) return change(this._data);
    const lock = acquireLockSync(this.lockDir);
    const release = () => lock.release();
    this.depth++;
    try {
      this.stamp = null;
      this.reload();
      const result = change(this._data);
      this.save();
      return result;
    } finally {
      this.depth--;
      release();
    }
  }

  private save(): void {
    // durable: the pending git recovery (recoveryDir) and mainStale guard the folder after a power loss
    writeFileAtomicSync(this.file, JSON.stringify(this._data, null, 2) + "\n");
    const stat = statSync(this.file);
    this.stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  }

  /** Serializes project-level mutations (init, host-drift sync, apply + publish) across processes. */
  async withProjectLock<T>(projectName: string, fn: (guard: () => void) => Promise<T>, timeoutMs = 60_000): Promise<T> {
    const lockDir = join(this.stateDir, "locks", `${projectName}.lock`);
    const lock = await acquireLock(lockDir, timeoutMs);
    // call guard() before an irreversible step: it throws if another process took the lock over
    const guard = () => {
      if (lock.lost) throw Object.assign(new Error(`lost the project lock for ${projectName} (process was frozen?); aborting`), { code: "LockLost" });
    };
    try {
      return await fn(guard);
    } finally {
      lock.release();
    }
  }

  /**
   * Picks a free project name and reserves it across processes (atomic mkdir), so two
   * folders with the same basename can import at the same time without sharing a name.
   * A reservation left by a crashed process only costs a numeric suffix.
   */
  reserveProjectName(folder: string, homeDir: string): { name: string; release: () => void } {
    const dir = join(this.stateDir, "reserved");
    mkdirSync(dir, { recursive: true });
    const base = nameFromFolder(folder);
    const taken = new Set(Object.keys(this.data.projects));
    for (let i = 0; ; i++) {
      const candidate = i === 0 ? base : `${base.slice(0, 55)}-${i}`;
      if (taken.has(candidate) || existsSync(join(homeDir, candidate))) continue;
      const slot = join(dir, candidate);
      try { mkdirSync(slot); } catch (e: any) { if (e?.code === "EEXIST") continue; throw e; }
      return { name: candidate, release: () => rmSync(slot, { recursive: true, force: true }) };
    }
  }

  byFolder(folder: string): ProjectRecord | null {
    const name = this.data.workspaces[folder]?.lastUsed;
    return name ? (this.data.projects[name] ?? null) : null;
  }

  byName(name: string): ProjectRecord | null {
    return this.data.projects[name] ?? null;
  }

  projects(): ProjectRecord[] {
    return Object.values(this.data.projects).sort((a, b) => a.created - b.created);
  }

  addProject(folder: string, project: ProjectRecord): void {
    this.update((d) => {
      d.projects[project.name] = project;
      (d.workspaces[folder] ||= { lastUsed: null }).lastUsed = project.name;
    });
  }

  updateProjectMain(name: string, mainRef: string): void {
    this.update((d) => {
      if (d.projects[name]) {
        d.projects[name].mainRef = mainRef;
        d.projects[name].updatedAt = Date.now();
      }
    });
  }

  setMainStale(name: string, stale: boolean): void {
    this.update((d) => {
      if (d.projects[name]) d.projects[name].mainStale = stale;
    });
  }

  /** Records (or, with null, forgets) a pending git recovery and the folder's markers of it. */
  setRecoveryDir(name: string, dir: string | null, markers?: string[]): void {
    this.update((d) => {
      const p = d.projects[name];
      if (!p) return;
      if (dir) {
        p.recoveryDir = dir;
        if (markers) p.recoveryMarkers = [...new Set([...(p.recoveryMarkers ?? []), ...markers])];
      } else {
        delete p.recoveryDir;
        delete p.recoveryMarkers;
      }
    });
  }


  /** The user dealt with a pending git recovery: forgotten, and main marked stale, in one write. */
  clearRecovery(name: string): void {
    this.update((d) => {
      const p = d.projects[name];
      if (!p) return;
      p.mainStale = true;
      delete p.recoveryDir;
      delete p.recoveryMarkers;
    });
  }

  removeProject(name: string): void {
    this.update((d) => {
      delete d.projects[name];
      for (const w of Object.values(d.workspaces)) if (w.lastUsed === name) w.lastUsed = null;
      for (const [sid, s] of Object.entries(d.sessions)) if (s.project === name) delete d.sessions[sid];
    });
    try {
      const f = this.manifestFile(name);
      if (existsSync(f)) renameSync(f, `${f}.removed.${Date.now()}`);
    } catch {}
  }

  session(sessionId: string): SessionBinding | null {
    return this.data.sessions[sessionId] ?? null;
  }

  setSession(sessionId: string, binding: SessionBinding): void {
    this.update((d) => {
      d.sessions[sessionId] = binding;
    });
  }

  manifestFile(projectName: string): string {
    const dir = join(this.stateDir, "manifests");
    mkdirSync(dir, { recursive: true });
    return join(dir, `${projectName}.json`);
  }

  readHostIndex(projectName: string): HostIndex {
    const f = this.manifestFile(projectName);
    if (!existsSync(f)) return {};
    try { return JSON.parse(readFileSync(f, "utf8")); } catch { return {}; }
  }

  writeHostIndex(projectName: string, index: HostIndex): void {
    writeFileAtomicSync(this.manifestFile(projectName), JSON.stringify(index));
  }
}
