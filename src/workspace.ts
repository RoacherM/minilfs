import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { promises as fsp, constants as fsc } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import type { LayerfsConfig } from "./config.ts";
import { dockerEnv, ok, run, DockerError } from "./docker.ts";
import { LayerfsError, WorkerClient } from "./worker-client.ts";
export { LayerfsError };

export interface Workspace { sandbox: string; path: string; image?: string }
export interface Checkpoint { origins: string[]; label: string; commit: string | null; changed: boolean; at: number }
export interface ManifestEntry { kind: "file" | "symlink"; sig: string; mode?: number }
export type Manifest = Record<string, ManifestEntry>;
export interface ApplyResult { applied: string[]; skipped: string[]; conflicts: string[]; unchanged: string[] }

type Log = (msg: string) => void;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * One Pi session's isolated LayerFS workspace: a fresh project imported from a
 * filtered copy of the host cwd, one Branch ("work") and one mounted Workspace.
 * Every project file operation and command goes through that one mount, so the
 * agent never sees two views. The host cwd is only written by apply().
 */
export class LayerfsSession {
  readonly project: string;
  readonly volume: string;
  readonly dir: string; // private session folder under config.root
  worker!: WorkerClient;
  ws!: Workspace;
  container = "";
  ident = "";
  manifest: Manifest = {};
  blocked: { reason: string } | null = null;
  pendingOrigins: string[] = [];
  checkpoints: Checkpoint[] = [];
  unapplied = false;
  leakedWorkspaces: string[] = [];
  private activeSids = new Map<string, () => Promise<void>>();
  private mutex: Promise<unknown> = Promise.resolve();
  private closed = false;

  readonly cwd: string;
  readonly sessionId: string;
  readonly config: LayerfsConfig;
  readonly log: Log;
  constructor(cwd: string, sessionId: string, config: LayerfsConfig, log: Log = () => {}) {
    this.cwd = cwd;
    this.sessionId = sessionId;
    this.config = config;
    this.log = log;
    const cwdHash = createHash("sha256").update(cwd).digest("hex").slice(0, 8);
    // unique per run: session ids are time-prefixed, so hash the whole id plus randomness
    const sid = createHash("sha256").update(`${sessionId}:${randomBytes(16).toString("hex")}`).digest("hex").slice(0, 12);
    this.project = `s${cwdHash}-${sid}`;
    this.volume = `${config.prefix}${this.project}`;
    this.dir = join(config.root, "sessions", this.project);
  }

  get wsDir() { return this.ws.path; }

  // ---------------------------------------------------------------- startup

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

  async open(): Promise<void> {
    const t0 = Date.now();
    const imageId = await LayerfsSession.preflight(this.config);
    const staged = join(this.dir, "staged");
    const home = join(this.config.root, "home");
    await fsp.mkdir(staged, { recursive: true });
    await fsp.mkdir(home, { recursive: true, mode: 0o700 });
    await fsp.chmod(home, 0o700);
    // 1. filtered copy of the host cwd (secrets excluded) + manifest of what was imported
    const rsync = await runLocal("rsync", ["-a", ...this.config.excludes.map((e) => `--exclude=${e}`), `${this.cwd}/`, `${staged}/`]);
    if (rsync.code !== 0) throw new LayerfsError("Failed", `staging copy failed: ${rsync.stderr.slice(0, 400)}`);
    this.manifest = await buildManifest(staged);
    await fsp.writeFile(join(this.dir, "manifest.json"), JSON.stringify(this.manifest));
    this.log(`staged ${Object.keys(this.manifest).length} files in ${Date.now() - t0} ms`);
    // 2. worker + project
    await ok(this.config.docker, ["volume", "create", "--label", "pi-layerfs.role=project", this.volume]);
    this.worker = new WorkerClient({
      docker: this.config.docker, imageId, bundle: this.config.bundle, root: this.config.root, home,
      project: this.project, volume: this.volume, prefix: this.config.prefix, name: `${this.config.prefix}${this.project}-worker`,
    });
    await this.worker.call("ping", [], 60_000);
    await this.worker.call("init", [staged], 600_000);
    await fsp.rm(staged, { recursive: true, force: true });
    await this.worker.call("fork", ["work"]);
    // 3. prewarm the fresh Sandbox (upstream: first Workspace may fail to unmount)
    if (this.config.prewarmMs > 0) {
      await this.worker.call("fork", ["warm"]);
      const warm = await this.worker.call<Workspace>("mount", ["warm"]);
      await sleep(this.config.prewarmMs);
      await this.worker.call("unmount", [warm]).catch((e) => { this.leakedWorkspaces.push(`${warm.path} (prewarm: ${e.code})`); });
    }
    // 4. the session Workspace
    this.ws = await this.worker.call<Workspace>("mount", ["work"]);
    this.container = `${this.config.prefix}${this.project}-${this.ws.sandbox}`;
    const id = await this.worker.call("exec", [this.ws, "id -u; id -g"]);
    const [uid, gid] = String(id.stdout).trim().split("\n");
    this.ident = `${uid}:${gid}`;
    // make host absolute paths under cwd resolve inside the Sandbox too
    await ok(this.config.docker, ["exec", "-u", "0", this.container, "sh", "-c", `mkdir -p ${shq(dirname(this.cwd))} && ln -sfn ${shq(this.wsDir)} ${shq(this.cwd)}`]);
    await this.saveRecord();
    this.log(`ready in ${Date.now() - t0} ms (${this.container}:${this.wsDir})`);
  }

  // ---------------------------------------------------------------- paths

  /** Host path inside cwd -> path in the Workspace; null when outside the project. */
  toWs(hostPath: string): string | null {
    const abs = resolve(this.cwd, hostPath);
    const rel = relative(this.cwd, abs);
    if (rel === "") return this.wsDir;
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    return posix.join(this.wsDir, rel.split("\\").join("/"));
  }

  private mustWs(hostPath: string): string {
    const p = this.toWs(hostPath);
    if (!p) throw new Error(`${hostPath} is outside the LayerFS workspace (${this.cwd}); writes there are refused`);
    return p;
  }

  // ---------------------------------------------------------------- file ops (docker exec)

  private async dexec(script: string, args: string[] = [], input?: Buffer | string) {
    const r = await run(this.config.docker, ["exec", ...(input !== undefined ? ["-i"] : []), "-u", this.ident, "-e", "HOME=/tmp", this.container, "sh", "-c", script, "_", ...args], { input, timeoutMs: 120_000 });
    if (r.code !== 0) this.checkSandbox(r.stderr);
    return r;
  }

  /** docker exec failures caused by a missing/stopped Sandbox become one clear error. */
  private checkSandbox(stderr: string) {
    if (/No such container|is not running|container .* is paused/i.test(stderr)) {
      throw new LayerfsError("SandboxGone", `the LayerFS Sandbox ${this.container} is gone (${stderr.trim().slice(0, 160)}); committed work is safe in volume ${this.volume}. Restart the Pi session.`);
    }
  }

  async readFile(hostPath: string): Promise<Buffer> {
    const p = this.toWs(hostPath);
    if (!p) return fsp.readFile(resolve(this.cwd, hostPath)); // outside project: host, read-only (skills, docs)
    const r = await this.dexec(`cat -- "$1"`, [p]);
    if (r.code !== 0) throw enoent(hostPath, r.stderr);
    return r.stdout;
  }

  async access(hostPath: string, write = false): Promise<void> {
    const p = this.toWs(hostPath);
    if (!p) { if (write) this.mustWs(hostPath); return fsp.access(resolve(this.cwd, hostPath), fsc.R_OK); }
    const r = await this.dexec(write ? `test -r "$1" && test -w "$1"` : `test -r "$1"`, [p]);
    if (r.code !== 0) throw enoent(hostPath, "not accessible");
  }

  async exists(hostPath: string): Promise<boolean> {
    const p = this.toWs(hostPath);
    if (!p) return fsp.access(resolve(this.cwd, hostPath)).then(() => true, () => false);
    return (await this.dexec(`test -e "$1" || test -L "$1"`, [p])).code === 0;
  }

  async isDirectory(hostPath: string): Promise<boolean> {
    const p = this.toWs(hostPath);
    if (!p) return (await fsp.stat(resolve(this.cwd, hostPath))).isDirectory();
    const r = await this.dexec(`if [ -d "$1" ]; then echo d; elif [ -e "$1" ]; then echo f; else exit 2; fi`, [p]);
    if (r.code !== 0) throw enoent(hostPath, "no such file or directory");
    return r.stdout.toString().trim() === "d";
  }

  async readdir(hostPath: string): Promise<string[]> {
    const p = this.toWs(hostPath);
    if (!p) return fsp.readdir(resolve(this.cwd, hostPath));
    const r = await this.dexec(`find "$1" -mindepth 1 -maxdepth 1 -printf '%f\\0'`, [p]);
    if (r.code !== 0) throw enoent(hostPath, r.stderr);
    return r.stdout.toString().split("\0").filter(Boolean).sort();
  }

  async writeFile(hostPath: string, content: string | Buffer): Promise<void> {
    const p = this.mustWs(hostPath);
    const r = await this.dexec(`mkdir -p "$(dirname "$1")" && cat > "$1"`, [p], Buffer.from(content));
    if (r.code !== 0) throw new Error(`write ${hostPath} failed: ${r.stderr.trim()}`);
  }

  async mkdir(hostPath: string): Promise<void> {
    const p = this.mustWs(hostPath);
    const r = await this.dexec(`mkdir -p "$1"`, [p]);
    if (r.code !== 0) throw new Error(`mkdir ${hostPath} failed: ${r.stderr.trim()}`);
  }

  /** Runs `script` in the Workspace (as the command identity) and returns stdout. */
  async sh(script: string, args: string[] = []): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const r = await this.dexec(script, args);
    return { code: r.code, stdout: r.stdout.toString(), stderr: r.stderr };
  }

  // ---------------------------------------------------------------- commands

  /** Pi BashOperations.exec contract: live output, signal, timeout, filtered env. */
  async exec(command: string, hostCwd: string, options: { onData: (d: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv }): Promise<{ exitCode: number | null }> {
    if (options.signal?.aborted) throw new Error("aborted");
    const cwd = this.toWs(hostCwd) ?? this.wsDir;
    const tag = randomBytes(6).toString("hex");
    const sidFile = `/tmp/pi-lfs-${tag}.sid`;
    const envArgs: string[] = [];
    for (const [k, v] of Object.entries(options.env ?? {})) {
      if (typeof v === "string" && (k.startsWith("PI_") || this.config.envAllow.includes(k))) envArgs.push("-e", `${k}=${v}`);
    }
    // setsid gives the command its own session; the session leader records its SID first.
    const script = `echo $$ > ${sidFile}; cd "$1" || exit 1; exec bash -c "$0"`;
    const child = spawn(this.config.docker, ["exec", "-u", this.ident, "-e", "HOME=/tmp", ...envArgs, "-w", this.wsDir, this.container, "setsid", "-w", "bash", "-c", script, command, cwd], { stdio: ["ignore", "pipe", "pipe"], env: dockerEnv() });
    child.stdout.on("data", options.onData);
    child.stderr.on("data", options.onData);
    let stopping: Promise<void> | null = null;
    const kill = () => (stopping ??= this.killSession(sidFile));
    this.activeSids.set(tag, kill);
    let timedOut = false;
    const timer = options.timeout && options.timeout > 0 ? setTimeout(() => { timedOut = true; void kill(); }, options.timeout * 1000) : undefined;
    const onAbort = () => void kill();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      let errText = "";
      child.stderr.on("data", (d) => (errText = (errText + d).slice(-2000)));
      const code = await new Promise<number | null>((resolveCode, reject) => {
        child.on("error", reject);
        child.on("close", (c) => resolveCode(c));
      });
      if (code === 1 || code === 125 || code === 126) this.checkSandbox(errText);
      if (stopping) await stopping;
      if (options.signal?.aborted) throw new Error("aborted");
      if (timedOut) throw new Error(`timeout:${options.timeout}`);
      return { exitCode: code };
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      this.activeSids.delete(tag);
      void run(this.config.docker, ["exec", "-u", "0", this.container, "rm", "-f", sidFile]).catch(() => {});
    }
  }

  /** TERM the whole session, wait, then KILL whatever is left (remote; the local client dying does not stop it). */
  private async killSession(sidFile: string): Promise<void> {
    const g = Math.max(0.1, this.config.killGraceMs / 1000);
    const script = `sid=$(cat ${sidFile} 2>/dev/null) || exit 0; [ -n "$sid" ] || exit 0; pkill -TERM -s "$sid"; i=0; while pgrep -s "$sid" >/dev/null && [ $i -lt $(awk "BEGIN{print int(${g}*10)}") ]; do sleep 0.1; i=$((i+1)); done; pkill -KILL -s "$sid"; true`;
    await run(this.config.docker, ["exec", "-u", "0", this.container, "sh", "-c", script], { timeoutMs: this.config.killGraceMs + 15_000 });
  }

  // ---------------------------------------------------------------- mutation + checkpoint

  /** Serializes mutating operations and their checkpoint; refuses while a checkpoint is pending. */
  mutate<T>(origin: string, label: string, fn: () => Promise<T>): Promise<{ value: T; checkpoint: Checkpoint | null; error: Error | null }> {
    const job = this.mutex.then(async () => {
      if (this.blocked) throw new Error(`LayerFS checkpoint failed earlier (${this.blocked.reason}); changes are blocked until /layerfs retry succeeds`);
      let value: T;
      let fnError: unknown = null;
      try { value = await fn(); } catch (e) { fnError = e; }
      const cp = await this.checkpoint(origin, label);
      if (fnError) throw fnError;
      return { value: value!, ...cp };
    });
    this.mutex = job.catch(() => {});
    return job;
  }

  /** Commit pending Workspace changes; records every origin since the last good checkpoint. */
  async checkpoint(origin: string, label: string): Promise<{ checkpoint: Checkpoint | null; error: Error | null }> {
    this.pendingOrigins.push(origin);
    try {
      // commit answers UpToDate when nothing changed (no Commit is created)
      const res = await this.worker.call("commit", [this.ws, `pi ${label} [${this.pendingOrigins.join(",")}]`.slice(0, 4000)]);
      if (res?.kind === "UpToDate") {
        this.pendingOrigins = [];
        this.blocked = null;
        return { checkpoint: null, error: null };
      }
      if (res?.kind !== "Committed") throw Object.assign(new Error(`unexpected commit answer ${res?.kind}`), { code: "Unknown" });
      const cp: Checkpoint = { origins: [...this.pendingOrigins], label, commit: res?.commit?.id ?? res?.head ?? null, changed: true, at: Date.now() };
      this.pendingOrigins = [];
      this.blocked = null;
      this.unapplied = true;
      this.checkpoints.push(cp);
      return { checkpoint: cp, error: null };
    } catch (e: any) {
      this.blocked = { reason: `${e?.code ?? "Error"}: ${String(e?.message ?? e).slice(0, 200)}` };
      return { checkpoint: null, error: e };
    }
  }

  async retry(): Promise<{ checkpoint: Checkpoint | null; error: Error | null }> {
    const wasBlocked = this.blocked;
    this.blocked = null;
    const r = await this.checkpoint("retry", "retry");
    if (r.error && !this.blocked) this.blocked = wasBlocked;
    return r;
  }

  // ---------------------------------------------------------------- review + apply

  async diff(): Promise<Array<{ path: string; kind: string; type: string }>> {
    const items: Array<{ path: string; kind: string; type: string }> = [];
    for (let pos = 0; ; ) {
      const page = await this.worker.call("diff_branches", ["main", "work", 1000, pos, { hunks: false }]);
      for (const it of page.items ?? []) items.push({ path: it.path, kind: it.kind, type: it.type });
      pos += (page.items ?? []).length;
      if (!page.hasMore || !(page.items ?? []).length) break;
    }
    return items;
  }

  /**
   * Writes the session's changes to the host cwd. All-or-nothing: any path the
   * host changed since import (vs the manifest) is a conflict and nothing is
   * written. Never touches .git internals.
   */
  async apply(): Promise<ApplyResult> {
    if (this.blocked) throw new Error(`cannot apply while a checkpoint is pending (${this.blocked.reason}); run /layerfs retry`);
    await this.mutate("apply", "before-apply", async () => {});
    const items = (await this.diff()).filter((i) => i.type !== "dir");
    const result: ApplyResult = { applied: [], skipped: [], conflicts: [], unchanged: [] };
    const plan: Array<{ rel: string; next: { kind: "file"; data: Buffer; mode: number } | { kind: "symlink"; target: string } | null }> = [];
    for (const it of items) {
      const rel = it.path.replace(/^\/+/, "");
      if (rel === ".git" || rel.startsWith(".git/")) { result.skipped.push(rel); continue; }
      let next: (typeof plan)[number]["next"] = null;
      if (it.kind !== "Removed") {
        const wsPath = posix.join(this.wsDir, rel);
        if (it.type === "symlink") {
          const r = await this.sh(`readlink -- "$1"`, [wsPath]);
          if (r.code !== 0) throw new Error(`cannot read link ${rel}: ${r.stderr}`);
          next = { kind: "symlink", target: r.stdout.replace(/\n$/, "") };
        } else {
          const data = await this.readFile(join(this.cwd, rel));
          const m = await this.sh(`stat -c %a -- "$1"`, [wsPath]);
          next = { kind: "file", data, mode: parseInt(m.stdout.trim() || "644", 8) };
        }
      }
      const host = await signatureOf(join(this.cwd, rel));
      const base = this.manifest[rel] ?? null;
      const want = next ? (next.kind === "file" ? { kind: "file" as const, sig: sha(next.data) } : { kind: "symlink" as const, sig: `link:${next.target}` }) : null;
      if (sameSig(host, want)) { result.unchanged.push(rel); continue; }
      if (!sameSig(host, base)) { result.conflicts.push(rel); continue; }
      plan.push({ rel, next });
    }
    if (result.conflicts.length) return result;
    for (const { rel, next } of plan) {
      const target = join(this.cwd, rel);
      if (!next) {
        await fsp.rm(target, { force: true });
        delete this.manifest[rel];
      } else if (next.kind === "symlink") {
        await fsp.mkdir(dirname(target), { recursive: true });
        await fsp.rm(target, { force: true });
        await fsp.symlink(next.target, target);
        this.manifest[rel] = { kind: "symlink", sig: `link:${next.target}` };
      } else {
        await fsp.mkdir(dirname(target), { recursive: true });
        const tmp = `${target}.pi-layerfs-${randomBytes(4).toString("hex")}`;
        await fsp.writeFile(tmp, next.data, { mode: next.mode & 0o7777 });
        await fsp.chmod(tmp, next.mode & 0o7777);
        await fsp.rename(tmp, target);
        this.manifest[rel] = { kind: "file", sig: sha(next.data), mode: next.mode };
      }
      result.applied.push(rel);
    }
    for (const rel of result.unchanged) {
      const s = await signatureOf(join(this.cwd, rel));
      if (s) this.manifest[rel] = s; else delete this.manifest[rel];
    }
    await fsp.writeFile(join(this.dir, "manifest.json"), JSON.stringify(this.manifest));
    this.unapplied = false;
    await this.saveRecord();
    return result;
  }

  // ---------------------------------------------------------------- shutdown

  /** Idempotent: stop commands, checkpoint, reap holders, unmount, stop containers; keep the volume only if work is unapplied. */
  async close(): Promise<{ kept: boolean; notes: string[] }> {
    const notes: string[] = [];
    if (this.closed) return { kept: this.unapplied, notes };
    this.closed = true;
    await Promise.allSettled([...this.activeSids.values()].map((k) => k()));
    if (this.worker?.alive && this.ws) {
      const cp = await this.checkpoint("shutdown", "shutdown");
      if (cp.error) notes.push(`final checkpoint failed: ${cp.error.message}`);
      await this.reapHolders().catch((e) => notes.push(`reap failed: ${e.message}`));
      await this.worker.call("unmount", [this.ws], 30_000).catch((e: any) => {
        this.leakedWorkspaces.push(`${this.ws.path} (${e.code})`);
        notes.push(`unmount failed (${e.code}); committed work is safe in the Store`);
      });
    }
    await this.worker?.close().catch(() => {});
    await run(this.config.docker, ["rm", "-f", `${this.config.prefix}${this.project}-worker`]).catch(() => {});
    const ids = (await run(this.config.docker, ["ps", "-aq", "--filter", `label=layerfs.project=${this.project}`, "--filter", `name=^${this.config.prefix}${this.project}-`])).stdout.toString().split("\n").filter(Boolean);
    if (ids.length) await run(this.config.docker, ["rm", "-f", ...ids]);
    // keep the project when work is unapplied OR a change was never checkpointed
    const kept = this.unapplied || this.blocked !== null;
    if (!kept) {
      await run(this.config.docker, ["volume", "rm", this.volume]).catch(() => {});
      await fsp.rm(join(this.config.root, "home", this.project), { recursive: true, force: true });
      await fsp.rm(this.dir, { recursive: true, force: true });
    } else {
      notes.push(`unapplied changes kept in Docker volume ${this.volume} (record: ${join(this.dir, "session.json")})`);
      await this.saveRecord().catch(() => {});
    }
    return { kept, notes };
  }

  private async reapHolders(): Promise<void> {
    const dir = this.wsDir;
    await run(this.config.docker, ["exec", "-u", this.ident, this.container, "sh", "-c",
      `for p in /proc/[0-9]*; do c=$(readlink $p/cwd 2>/dev/null); case "$c" in ${dir}|${dir}/*) kill -KILL "\${p#/proc/}" 2>/dev/null;; esac; done; true`]);
  }

  private async saveRecord(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
    await fsp.writeFile(join(this.dir, "session.json"), JSON.stringify({
      project: this.project, volume: this.volume, cwd: this.cwd, sessionId: this.sessionId,
      ws: this.ws, container: this.container, unapplied: this.unapplied, checkpoints: this.checkpoints.length,
      leakedWorkspaces: this.leakedWorkspaces, updatedAt: new Date().toISOString(),
    }, null, 2));
  }
}

// ---------------------------------------------------------------- helpers

function enoent(path: string, why: string) {
  return Object.assign(new Error(`ENOENT: ${path}: ${why.trim() || "not found"}`), { code: "ENOENT" });
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function sameSig(a: { kind: string; sig: string } | null, b: { kind: string; sig: string } | null) {
  if (!a || !b) return a === b;
  return a.kind === b.kind && a.sig === b.sig;
}

async function signatureOf(abs: string): Promise<ManifestEntry | null> {
  const st = await fsp.lstat(abs).catch(() => null);
  if (!st) return null;
  if (st.isSymbolicLink()) return { kind: "symlink", sig: `link:${await fsp.readlink(abs)}` };
  if (st.isFile()) return { kind: "file", sig: sha(await fsp.readFile(abs)), mode: st.mode & 0o7777 };
  return { kind: "file", sig: `other:${st.mode}` };
}

async function buildManifest(root: string): Promise<Manifest> {
  const out: Manifest = {};
  const walk = async (dir: string) => {
    for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) await walk(abs);
      else {
        const s = await signatureOf(abs);
        if (s) out[relative(root, abs).split("\\").join("/")] = s;
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
