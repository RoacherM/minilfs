import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { dockerEnv } from "./docker.ts";

export class LayerfsError extends Error {
  code: string;
  detail: unknown;
  constructor(code: string, message: string, detail: unknown = null) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

export interface WorkerSpec {
  docker: string;
  imageId: string;
  bundle: string;
  root: string;
  home: string;
  project: string;
  volume: string;
  prefix: string;
  name: string;
}

const WORKER_DIR = dirname(fileURLToPath(new URL("./worker/worker.mjs", import.meta.url)));

/**
 * The Linux side: a `docker run -i --rm --network host` child process running
 * worker.mjs with the real native binding. Host networking is required: on the
 * default bridge network the binding's single connect to a new Sandbox's
 * daemon is refused (probe finding 1).
 */
export class WorkerClient {
  private child: ChildProcessWithoutNullStreams;
  private next = 1;
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }>();
  private stderr = "";
  private exited: Error | null = null;

  readonly spec: WorkerSpec;
  constructor(spec: WorkerSpec) {
    this.spec = spec;
    const s = spec;
    const args = [
      "run", "-i", "--rm", "--pull", "never", "--network", "host", "--name", s.name,
      "--label", "pi-layerfs.role=worker", "--label", `pi-layerfs.project=${s.project}`,
      "-v", "/var/run/docker.sock:/var/run/docker.sock", "-v", "/var/lib/docker/volumes:/var/lib/docker/volumes",
      "-v", `${s.root}:${s.root}`, "-v", `${s.bundle}:${s.bundle}:ro`, "-v", `${WORKER_DIR}:${WORKER_DIR}:ro`,
      "-e", `LFS_BUNDLE=${s.bundle}`, "-e", `LFS_PROJECT=${s.project}`,
      "-e", `LAYERFS_NATIVE=${s.bundle}/layerfs.node`, "-e", `LAYERFS_HOME=${s.home}`, "-e", `LAYERFS_IMAGE=${s.imageId}`,
      "-e", `LAYERFS_VOLUME=${s.volume}`, "-e", `LAYERFS_DAEMON=${s.bundle}/layerfs-daemon`,
      "-e", `LAYERFS_STORE_PATH=/var/lib/docker/volumes/${s.volume}/_data/global/store.sqlite`,
      "-e", `LAYERFS_CONTAINER_PREFIX=${s.prefix}`, "-e", "UV_THREADPOOL_SIZE=64",
      "--entrypoint", "node", s.imageId, `${WORKER_DIR}/worker.mjs`,
    ];
    this.child = spawn(s.docker, args, { stdio: ["pipe", "pipe", "pipe"], env: dockerEnv() });
    this.child.stderr.on("data", (d) => (this.stderr = (this.stderr + d).slice(-4000)));
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let msg: any;
      try { msg = JSON.parse(line); } catch { return; }
      const w = this.waiting.get(msg.id);
      if (!w) return;
      this.waiting.delete(msg.id);
      if (w.timer) clearTimeout(w.timer);
      if (msg.ok) w.resolve(msg.value);
      else w.reject(new LayerfsError(msg.error?.code ?? "Failed", msg.error?.message ?? "unknown LayerFS error", msg.error?.detail ?? null));
    });
    const fail = (e: Error) => {
      this.exited ??= e;
      for (const w of this.waiting.values()) { if (w.timer) clearTimeout(w.timer); w.reject(this.exited); }
      this.waiting.clear();
    };
    this.child.on("error", (e) => fail(new LayerfsError("WorkerDown", `cannot start LayerFS worker: ${e.message}`)));
    this.child.on("close", (code) => fail(new LayerfsError("WorkerDown", `LayerFS worker exited (${code}): ${this.stderr.trim().slice(-800)}`)));
    this.child.stdin.on("error", () => {});
  }

  /** One SDK call. Never retried here: an Unknown outcome must be inspected, not replayed. */
  call<T = any>(op: string, args: unknown[] = [], timeoutMs = 120_000): Promise<T> {
    if (this.exited) return Promise.reject(this.exited);
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new LayerfsError("Unknown", `LayerFS ${op} did not answer within ${timeoutMs} ms; its outcome is unknown`));
      }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, op, args })}\n`);
    });
  }

  get alive() { return !this.exited; }

  /** Ends stdin; the worker closes the Store after in-flight calls and exits. */
  async close(timeoutMs = 10_000): Promise<void> {
    if (this.exited) return;
    this.child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.child.kill("SIGKILL"); resolve(); }, timeoutMs);
      this.child.once("close", () => { clearTimeout(timer); resolve(); });
    });
  }
}
