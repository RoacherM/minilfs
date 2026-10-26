// Host mode for harnesses that call the session API directly (DSH, MCP, CLI): an object with the
// same file/shell methods the tools use on a LayerfsSession, acting on the real folder instead.
// No Branch, no mount, no minilfs Seatbelt profile; the harness's own sandbox (if any) still applies.
// Secrets stay refused: the same exclude list guards reads and writes.
import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import type { LayerfsConfig } from "../config.ts";
import { expandBraces, isExcludedPath, matchesToolGlob } from "../workspace.ts";

export class HostWorkspace {
  readonly cwd: string;
  readonly config: LayerfsConfig;
  readonly mode = "host" as const;
  /** Host edits are immediate; nothing is ever pending here. */
  readonly unapplied = false;
  readonly blocked = null;
  readonly workBranch = "(host)";
  readonly logicalBranch = "host";

  constructor(cwd: string, config: LayerfsConfig) {
    this.cwd = resolve(cwd);
    this.config = config;
  }

  private rel(path: string): string {
    return relative(this.cwd, resolve(this.cwd, path)).split("\\").join("/");
  }

  private guard(path: string, verb: string): string {
    const abs = resolve(this.cwd, path);
    const rel = this.rel(abs);
    if (rel && !rel.startsWith("..") && isExcludedPath(rel, this.config.excludes)) {
      throw new Error(`cannot ${verb} ${path}: secret file (excluded by MINILFS_EXCLUDES)`);
    }
    return abs;
  }

  async readFile(path: string): Promise<Buffer> {
    return fsp.readFile(this.guard(path, "read"));
  }

  async writeFile(path: string, content: string | Buffer): Promise<void> {
    const abs = this.guard(path, "write");
    await fsp.mkdir(dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content);
  }

  async exists(path: string): Promise<boolean> {
    return fsp.access(resolve(this.cwd, path)).then(() => true, () => false);
  }

  async findFiles(pattern: string, searchCwd: string, options: { ignore: string[]; limit: number }): Promise<string[]> {
    const root = resolve(this.cwd, searchCwd);
    const patterns = expandBraces(pattern);
    const out: string[] = [];
    const walk = async (dir: string) => {
      if (out.length >= options.limit) return;
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (out.length >= options.limit) return;
        if (e.name === ".git" || e.name === "node_modules") continue;
        const abs = join(dir, e.name);
        const relRoot = relative(root, abs).split("\\").join("/");
        if (isExcludedPath(this.rel(abs), this.config.excludes)) continue;
        if (options.ignore.some((g) => matchesToolGlob(relRoot, g))) continue;
        if (e.isDirectory()) await walk(abs);
        else if (patterns.some((p) => matchesToolGlob(relRoot, p))) out.push(abs);
      }
    };
    await walk(root);
    return out;
  }

  async grepWorkspace(params: { pattern: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number }): Promise<{ lines: string[]; matches: number; limitReached: boolean }> {
    const limit = Math.max(1, params.limit ?? 100);
    const args = ["-rnIH", "--exclude-dir=.git", "--exclude-dir=node_modules", params.ignoreCase ? "-i" : "", params.literal ? "-F" : "-E",
      params.context ? `-C${Math.floor(params.context)}` : "", ...(params.glob ? expandBraces(params.glob).map((g) => `--include=${g}`) : []),
      ...this.config.excludes.filter((p) => !p.startsWith("!")).map((p) => `--exclude=${p.replace(/\/$/, "")}`),
      "--", params.pattern, resolve(this.cwd, params.path ?? ".")].filter(Boolean);
    const { stdout } = await capture("grep", args, this.cwd);
    const lines: string[] = [];
    let matches = 0;
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      if (matches >= limit) return { lines, matches, limitReached: true };
      lines.push(line.startsWith(this.cwd + "/") ? line.slice(this.cwd.length + 1) : line);
      matches++;
    }
    return { lines, matches, limitReached: false };
  }

  async exec(command: string, cwd: string, options: { onData: (d: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv }): Promise<{ exitCode: number | null }> {
    return new Promise((done, fail) => {
      const child = spawn("bash", ["-c", command], { cwd: resolve(this.cwd, cwd), env: options.env ?? process.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      const kill = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } };
      let timedOut = false;
      const timer = options.timeout ? setTimeout(() => { timedOut = true; kill(); }, options.timeout * 1000) : undefined;
      options.signal?.addEventListener("abort", kill, { once: true });
      child.stdout.on("data", options.onData);
      child.stderr.on("data", options.onData);
      child.on("error", fail);
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", kill);
        if (options.signal?.aborted) return fail(new Error("aborted"));
        if (timedOut) return fail(new Error(`timeout:${options.timeout}`));
        done({ exitCode: code });
      });
    });
  }

  /** Same shape as LayerfsSession.mutate: there is no checkpoint on the host. */
  async mutate<T>(_id: string, _label: string, body: () => Promise<T>): Promise<{ value: T; checkpoint: null; error: null }> {
    return { value: await body(), checkpoint: null, error: null };
  }

  /** posix-style path relative to the folder, for messages. */
  display(path: string): string {
    return posix.normalize(this.rel(path) || ".");
  }
}

function capture(cmd: string, args: string[], cwd: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("error", () => done({ code: -1, stdout: "" }));
    child.on("close", (code) => done({ code, stdout }));
  });
}
