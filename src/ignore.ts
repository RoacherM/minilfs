// Git ignore rules for the import set: a path git would not show (`git status` ignores it) is not
// imported, not synced and never applied, like MINILFS_BRANCH_ONLY. Tracked files always count.
//
// Sources, lowest to highest precedence (as in git): core.excludesFile, $GIT_DIR/info/exclude,
// each directory's .gitignore from the top of the work tree down, then <folder>/.minilfsignore.
// Within and across sources the last matching rule wins; a path inside an ignored directory is
// ignored (git cannot re-include it). Per-directory files are read lazily from the host folder.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { run } from "./core/exec-helper.ts";

interface Rule { rx: RegExp; negate: boolean; dirOnly: boolean; anchored: boolean }

const CACHE_LIMIT = 200_000;

/** gitignore glob (fnmatch with FNM_PATHNAME) -> regex source. */
function globSource(p: string): string {
  let r = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "\\" && i + 1 < p.length) { r += escapeRx(p[++i]); continue; }
    if (c === "*") {
      if (p[i + 1] === "*" && (i === 0 || p[i - 1] === "/") && (i + 2 === p.length || p[i + 2] === "/")) {
        if (p[i + 2] === "/") { r += "(?:.*/)?"; i += 2; } else { r += ".*"; i += 1; }
      } else {
        while (p[i + 1] === "*") i++;
        r += "[^/]*";
      }
      continue;
    }
    if (c === "?") { r += "[^/]"; continue; }
    if (c === "[") {
      let j = i + 1;
      if (p[j] === "!" || p[j] === "^") j++;
      if (p[j] === "]") j++;
      while (j < p.length && p[j] !== "]") j++;
      if (j >= p.length) { r += "\\["; continue; }
      let body = p.slice(i + 1, j);
      const neg = body[0] === "!" || body[0] === "^";
      if (neg) body = body.slice(1);
      r += `[${neg ? "^" : ""}${body.replace(/\\/g, "\\\\").replace(/^\]/, "\\]")}]`;
      i = j;
      continue;
    }
    r += escapeRx(c);
  }
  return r;
}

const escapeRx = (c: string) => c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

export function parseIgnore(text: string, ignoreCase: boolean): Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/(^|[^\\])\s+$/, "$1");
    if (!line || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) { negate = true; line = line.slice(1); }
    else if (line.startsWith("\\!") || line.startsWith("\\#")) line = line.slice(1);
    const dirOnly = line.endsWith("/");
    line = line.replace(/\/+$/, "");
    if (!line) continue;
    const anchored = line.includes("/");
    line = line.replace(/^\/+/, "");
    rules.push({ rx: new RegExp(`^${globSource(line)}$`, ignoreCase ? "i" : ""), negate, dirOnly, anchored });
  }
  return rules;
}

export class IgnoreRules {
  /** host folder (where the session's files come from) */
  readonly root: string;
  /** git work tree top and the folder's path inside it ("" when the folder is the top) */
  private top: string;
  private prefix = "";
  private ignoreCase = false;
  private base: Rule[] = [];
  private own: Rule[] = [];
  private tracked = new Set<string>();
  private trackedDirs = new Set<string>();
  private perDir = new Map<string, Rule[]>();
  private decided = new Map<string, boolean>();
  private isRepo = false;

  /** true when any rule can apply (the folder is in a git work tree, or has a .minilfsignore) */
  get active(): boolean { return this.isRepo || this.own.length > 0; }

  constructor(root: string) {
    this.root = root;
    this.top = root;
    this.own = parseIgnore(readText(join(root, ".minilfsignore")), false);
  }

  /** Reads git's view: work tree top, case rule, global and repo excludes, tracked files. */
  async load(): Promise<void> {
    const git = async (args: string[]) => {
      const r = await run("git", ["-C", this.root, ...args], { timeoutMs: 10_000 }).catch(() => null);
      return r?.code === 0 ? r.stdout.toString() : null;
    };
    const top = (await git(["rev-parse", "--show-toplevel"]))?.trim();
    if (top) {
      this.isRepo = true;
      this.top = top;
      const rel = relative(top, this.root).split("\\").join("/");
      this.prefix = rel && !rel.startsWith("..") ? rel : "";
      this.ignoreCase = (await git(["config", "--bool", "core.ignorecase"]))?.trim() === "true";
      const excludesFile = (await git(["config", "--path", "core.excludesFile"]))?.trim()
        || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "git", "ignore");
      let info = (await git(["rev-parse", "--git-path", "info/exclude"]))?.trim() ?? "";
      if (info && !isAbsolute(info)) info = join(this.root, info);
      this.base = [...parseIgnore(readText(excludesFile), this.ignoreCase), ...(info ? parseIgnore(readText(info), this.ignoreCase) : [])];
      this.own = parseIgnore(readText(join(this.root, ".minilfsignore")), this.ignoreCase);
      const files = (await git(["-c", "core.quotePath=false", "ls-files", "-z"])) ?? "";
      this.tracked.clear();
      this.trackedDirs.clear();
      for (const f of files.split("\0")) {
        if (!f) continue;
        this.tracked.add(f);
        for (let k = f.lastIndexOf("/"); k > 0; k = f.lastIndexOf("/", k - 1)) {
          const d = f.slice(0, k);
          if (this.trackedDirs.has(d)) break;
          this.trackedDirs.add(d);
        }
      }
    }
    this.reset();
  }

  /** Drops cached .gitignore files and answers (host .gitignore files may have changed). */
  reset(): void {
    this.perDir.clear();
    this.decided.clear();
  }

  /**
   * true when `rel` (relative to the folder) is ignored, as `git status` would treat it:
   * tracked files never are; untracked files inside an ignored directory always are. A directory
   * that holds tracked files is not ignored (a walk must descend to find them).
   */
  isIgnored(rel: string, isDir = false): boolean {
    const p = rel.replace(/^\/+/, "").replace(/\/+$/, "");
    if (!p || p === ".git" || p.startsWith(".git/")) return false;
    if (this.tracked.has(p) || (isDir && this.trackedDirs.has(p))) return false;
    for (let k = p.indexOf("/"); k > 0; k = p.indexOf("/", k + 1)) {
      if (this.decide(p.slice(0, k), true)) return true;
    }
    return this.decide(p, isDir);
  }

  private decide(p: string, isDir: boolean): boolean {
    const key = isDir ? `${p}/` : p;
    const known = this.decided.get(key);
    if (known !== undefined) return known;
    const full = this.prefix ? `${this.prefix}/${p}` : p;
    const name = full.slice(full.lastIndexOf("/") + 1);
    let ignored = false;
    const apply = (rules: Rule[], rel: string) => {
      for (const r of rules) {
        if (r.dirOnly && !isDir) continue;
        if (r.rx.test(r.anchored ? rel : name)) ignored = !r.negate;
      }
    };
    apply(this.base, full);
    apply(this.rulesIn(""), full);
    for (let k = full.indexOf("/"); k > 0; k = full.indexOf("/", k + 1)) {
      const dir = full.slice(0, k);
      apply(this.rulesIn(dir), full.slice(k + 1));
    }
    if (this.own.length) apply(this.own, p);
    if (this.decided.size > CACHE_LIMIT) this.decided.clear();
    this.decided.set(key, ignored);
    return ignored;
  }

  private rulesIn(dir: string): Rule[] {
    let rules = this.perDir.get(dir);
    if (!rules) {
      rules = parseIgnore(readText(join(this.top, dir, ".gitignore")), this.ignoreCase);
      this.perDir.set(dir, rules);
    }
    return rules;
  }
}

function readText(file: string): string {
  try { return readFileSync(file, "utf8"); } catch { return ""; }
}
