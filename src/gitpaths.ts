import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";

// Paths inside a git directory (`.git/` at any depth) and what minilfs lets a Branch do with them.
//
// The Branch carries the project's real `.git`, so git runs in the sandbox. Git also runs code that
// its directory names: hooks, `core.fsmonitor` / `core.hooksPath` / filter drivers in config (and
// config.worktree), `commondir` / `gitdir` (another directory's config and hooks), submodule git
// dirs (`modules/<name>/config|hooks`, and a submodule name may contain `/`). A blocklist always
// misses one, so this is an ALLOWLIST: inside a git directory only the data git needs for status,
// add, commit, branch, merge and log may change (objects, refs, logs, HEAD, index, ...). Below
// `modules/` (submodule git dirs, whose names may contain `/`), a name that can make git run code
// (`hooks`, `config*`, `commondir`, `gitdir`) is refused at ANY depth, so a git dir nested inside
// an allowed subtree (a submodule named `x/refs` has its git dir at `.git/modules/x/refs/`) gets
// no config and no hooks.
// Protected paths: the sandbox (Seatbelt) cannot write them, file tools refuse them, apply never
// writes them to the folder.
//
// The allowlist is case-sensitive; the refused names match in any case (on a case-insensitive disk
// `.git/CONFIG` is `.git/config`).

/** Top-level files git writes for in-progress operations and messages. */
const STATE_FILES = "HEAD|ORIG_HEAD|FETCH_HEAD|MERGE_HEAD|MERGE_MODE|MERGE_MSG|MERGE_RR|MERGE_AUTOSTASH|AUTO_MERGE|SQUASH_MSG|COMMIT_EDITMSG|TAG_EDITMSG|CHERRY_PICK_HEAD|REVERT_HEAD|REBASE_HEAD|BISECT_[A-Z_][A-Z_]*|NOTES_[A-Z_][A-Z_]*";

/**
 * What may change inside one git directory, as a regex body over the path below `.git/`. Written
 * only with constructs Seatbelt's regex accepts too (no `+`, `{n}`, `(?:`), so the same text is the
 * sandbox rule. Directories in the list are allowed themselves (git creates them).
 */
export const GIT_ALLOWED_BODY = [
  `(${STATE_FILES})(\\.lock)?`,
  "index(\\.lock)?",
  "sharedindex\\.[0-9a-f][0-9a-f]*(\\.lock)?",
  // git writes <file>.new then renames it over <file> (pack-refs, fetch --depth)
  "packed-refs(\\.(lock|new))?",
  "shallow(\\.(lock|new))?",
  "description",
  "refs(/.*)?",
  "logs(/.*)?",
  "objects",
  "objects/([0-9a-f][0-9a-f]|pack)(/.*)?",
  "objects/(maintenance|gc)\\.lock",
  "objects/incoming-[^/]*(/.*)?",
  "objects/info(/(packs(\\.lock)?|commit-graph(\\.lock)?|commit-graphs(/.*)?))?",
  "info(/(exclude|refs|sparse-checkout))?",
  "lfs",
  "lfs/(objects|tmp|incomplete)(/.*)?",
  "rebase-merge(/.*)?",
  "rebase-apply(/.*)?",
  "sequencer(/.*)?",
  "rr-cache(/.*)?",
  "gc\\.pid",
  "gc\\.log",
].join("|");

/** A nested git directory inside a git directory: a submodule's (`modules/<name>/`) or a linked worktree's. */
export const GIT_NESTED_PREFIX = "((modules/..*/)|(worktrees/[^/][^/]*/))?";

/** Names git can run code from, refused at any depth below `.git` (as a regex over one path component). */
export const GIT_REFUSED_NAME = "hooks|config|config\\.worktree|commondir|gitdir";

const ALLOWED_RX = new RegExp(`^${GIT_NESTED_PREFIX}(${GIT_ALLOWED_BODY})$`);
/** A `.` or `..` path component (`.*` in the allowlist would otherwise span `refs/../hooks`). */
export const DOT_COMPONENT_RX = "(^|/)\\.\\.?(/|$)";
const REFUSED_COMPONENT_RX = new RegExp(`^(${GIT_REFUSED_NAME})$`, "i");

/** `{ dir, inner }` for a path inside a git directory (`dir` ends in `.git`), else null. */
export function splitGitPath(rel: string): { dir: string; inner: string } | null {
  const p = String(rel ?? "").replace(/^\/+/, "");
  const m = /(^|\/)\.git(\/|$)/i.exec(p);
  if (!m) return null;
  const start = m.index + m[1].length;
  return { dir: p.slice(0, start + 4), inner: p.slice(start + 5) };
}

/**
 * How apply treats a path:
 * - none       not git metadata: ordinary three-way apply
 * - protected  never written by the sandbox, tools or apply (config, hooks, commondir, alternates,
 *              a `.git` file or link that points git at another directory, ...)
 * - transient  locks, in-progress state and caches: kept in the Branch, never applied
 * - object     content-addressed (objects, packs, lfs objects): added when missing, never replaced or deleted
 * - ref        refs and packed-refs: three-way; a ref the folder moved meanwhile is a conflict
 * - head       HEAD: three-way, written last
 * - index      the staging area: three-way on its entries, not its bytes (stat data differs per disk)
 * - soft       logs, messages, info/exclude: written when the folder still has the base version, else left
 */
export type GitPathKind = "none" | "protected" | "transient" | "object" | "ref" | "head" | "index" | "soft";

export function gitPathKind(rel: string): GitPathKind {
  return resolveGitPath(rel).kind;
}

/** How a path below its own git directory (`refs/heads/x`, `index`, ...) is applied. */
function classifyGitTail(inner: string): GitPathKind {
  if (/\.(lock|new)$/.test(inner)) return "transient"; // git's temp files: renamed over the real one
  // Known limitation (accepted): a submodule whose name holds one of these folders (`a/rebase-merge/s`)
  // has its files read as transient too (strictest wins in resolveGitPath), so its refs and index are
  // never applied; the other way, a fake git dir inside rebase-merge/ could lower transient to a ref.
  if (/^(rebase-merge|rebase-apply|sequencer|rr-cache)(\/|$)/.test(inner)) return "transient";
  if (/^(FETCH_HEAD|MERGE_[A-Z_]+|AUTO_MERGE|SQUASH_MSG|CHERRY_PICK_HEAD|REVERT_HEAD|REBASE_HEAD|BISECT_[A-Z_]+|gc\.pid|gc\.log)$/.test(inner)) return "transient";
  if (/^objects\/info(\/|$)/.test(inner)) return "transient"; // caches git rebuilds (packs list, commit-graph)
  if (/(^|\/)tmp_[^/]*$/.test(inner)) return "transient"; // half-written object or pack
  if (/^objects\/incoming-/.test(inner)) return "transient"; // receive-pack quarantine
  if (/^lfs\/(tmp|incomplete)(\/|$)/.test(inner)) return "transient";
  if (/^(objects|lfs)(\/|$)/.test(inner) || /^sharedindex\./.test(inner)) return "object";
  if (inner === "HEAD") return "head";
  if (inner === "index") return "index";
  if (/^refs\//.test(inner) || inner === "packed-refs") return "ref";
  return "soft";
}

/** The git directories that exist (HEAD a file, objects/ and refs/ folders), relative paths such as `.git/modules/a/logs`. */
export type GitLayout = ReadonlySet<string>;
/** A git path read as `<gitDir>/<tail>` and what apply does with it. */
export interface ResolvedGitPath { gitDir: string | null; tail: string; kind: GitPathKind }

/** How strictly apply treats a kind (higher: stricter); see resolveGitPath. */
const STRICTNESS: Record<GitPathKind, number> = { none: 0, soft: 1, object: 2, ref: 3, index: 3, head: 3, protected: 4, transient: 5 };

/**
 * Which git directory `rel` belongs to and its kind. Protected is decided on the whole path (no
 * layout can lift it). A submodule name may contain `/`, so `modules/a/logs/index` is the reflog
 * folder of submodule `a` or the index of submodule `a/logs`: the reading by name (pickByName) and
 * every reading whose git dir exists in `layout` (scanGitLayout over the Branch and the folder)
 * are considered, and the strictest wins (transient: never applied; ref/HEAD/index: locked and
 * checked; object, soft: unchecked), the most specific git dir among equals. A layout comes partly
 * from the Branch (agent-made): a fake git dir (`refs/heads/{HEAD,objects,refs}`) can then only
 * make a path stricter, never turn a ref into an unchecked log or object.
 */
export function resolveGitPath(rel: string, layout?: GitLayout): ResolvedGitPath {
  const g = splitGitPath(rel);
  if (!g) return { gitDir: null, tail: "", kind: "none" };
  const protectedPath: ResolvedGitPath = { gitDir: g.dir, tail: g.inner, kind: "protected" };
  if (!g.inner) return protectedPath; // the `.git` entry itself as a file or symlink (gitdir pointer)
  if (/^modules\//.test(g.inner) && g.inner.split("/").some((c) => REFUSED_COMPONENT_RX.test(c))) return protectedPath;
  if (new RegExp(DOT_COMPONENT_RX).test(g.inner)) return protectedPath;
  if (!ALLOWED_RX.test(g.inner)) return protectedPath;
  const all = candidateGitDirs(g.dir, g.inner);
  const byName = pickByName(all);
  if (!byName) return protectedPath;
  let best: ResolvedGitPath = { ...byName, kind: classifyGitTail(byName.tail) };
  for (const c of all) {
    if (c === byName || !layout?.has(c.gitDir)) continue;
    const kind = classifyGitTail(c.tail);
    if (STRICTNESS[kind] > STRICTNESS[best.kind] || (STRICTNESS[kind] === STRICTNESS[best.kind] && c.gitDir.length > (best.gitDir?.length ?? 0))) best = { ...c, kind };
  }
  return best;
}

/**
 * The git dirs among the candidate readings of `relPaths` that exist under any of `roots` (the
 * Branch's mount and the folder), for resolveGitPath.
 */
export function scanGitLayout(roots: string[], relPaths: string[]): Set<string> {
  const seen = new Set<string>();
  const layout = new Set<string>();
  for (const rel of relPaths) {
    const g = splitGitPath(rel);
    if (!g || !g.inner) continue;
    for (const gitDir of [g.dir, ...candidateGitDirs(g.dir, g.inner).map((c) => c.gitDir)]) {
      if (seen.has(gitDir)) continue;
      seen.add(gitDir);
      if (roots.some((r) => hasGitLayout(join(r, gitDir)))) layout.add(gitDir);
    }
  }
  return layout;
}

const BODY_RX = new RegExp(`^(${GIT_ALLOWED_BODY})$`);

/**
 * Every way to read `inner` (a path below a top-level `.git`) as `<git dir>/<tail>`, shortest git
 * dir first: the top-level dir, a linked worktree's, and each `modules/<name>/` split (a submodule
 * name may contain `/`, so `modules/a/refs/refs/heads/main` is both `modules/a` + `refs/refs/...`
 * and the submodule `a/refs` + `refs/heads/main`).
 */
function candidateGitDirs(dir: string, inner: string): Array<{ gitDir: string; tail: string }> {
  const out: Array<{ gitDir: string; tail: string }> = [];
  if (BODY_RX.test(inner)) out.push({ gitDir: dir, tail: inner });
  const wt = /^worktrees\/([^/]+)\/(.+)$/.exec(inner);
  if (wt && BODY_RX.test(wt[2])) out.push({ gitDir: `${dir}/worktrees/${wt[1]}`, tail: wt[2] });
  if (inner.startsWith("modules/")) {
    const parts = inner.split("/");
    for (let k = 2; k < parts.length; k++) {
      const tail = parts.slice(k).join("/");
      if (BODY_RX.test(tail)) out.push({ gitDir: `${dir}/${parts.slice(0, k).join("/")}`, tail });
    }
  }
  return out;
}

/** a git directory on disk: HEAD a file, objects/ and refs/ folders */
function hasGitLayout(abs: string): boolean {
  try {
    return lstatSync(join(abs, "HEAD")).isFile() && lstatSync(join(abs, "objects")).isDirectory() && lstatSync(join(abs, "refs")).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The git dir a path belongs to. With `cwd`, the most specific candidate that is a git dir on disk.
 * Else (or none is) by name: the most specific candidate that is not inside a namespace of a shorter
 * one, so `modules/x/logs/refs/heads/main` is a log of `modules/x` and `modules/x/refs/heads/index`
 * a branch of `modules/x`, while `modules/a/refs/refs/heads/main` is a ref of the submodule `a/refs`.
 */
function pickGitDir(dir: string, inner: string, cwd?: string): { gitDir: string; tail: string } | null {
  const all = candidateGitDirs(dir, inner);
  if (!all.length) return null;
  if (cwd) {
    const onDisk = all.filter((c) => hasGitLayout(join(cwd, c.gitDir)));
    if (onDisk.length) return onDisk[onDisk.length - 1];
  }
  return pickByName(all);
}

/** By name only (see pickGitDir); an element of `all`. A transient folder (rebase-merge/, ...) is a namespace too. */
function pickByName(all: Array<{ gitDir: string; tail: string }>): { gitDir: string; tail: string } | null {
  if (!all.length) return null;
  const inNamespace = (c: { gitDir: string }, i: number) => all.slice(0, i).some((s) => {
    const rel = c.gitDir.slice(s.gitDir.length + 1);
    return /^(logs|objects|info|lfs|rebase-merge|rebase-apply|sequencer|rr-cache)(\/|$)/.test(rel) || /^refs\/[^/]+/.test(rel);
  });
  const ok = all.filter((c, i) => i === 0 || !inNamespace(c, i));
  return ok[ok.length - 1];
}

/**
 * The git directory (relative path, e.g. `.git` or `.git/modules/x`) a git path belongs to; with
 * `cwd`, git dirs that exist there decide an ambiguous submodule name.
 */
export function gitDirOf(rel: string, cwd?: string): string | null {
  const g = splitGitPath(rel);
  if (!g || !g.inner) return null;
  return pickGitDir(g.dir, g.inner, cwd)?.gitDir ?? g.dir;
}

/**
 * Paths no tool may write and apply never writes: LayerFS merge rules (`/.lww`) and every git
 * path outside the allowlist.
 */
export function isProtectedPath(rel: string): boolean {
  const p = String(rel ?? "").replace(/^\/+/, "");
  if (p.toLowerCase() === ".lww") return true;
  return gitPathKind(p) === "protected";
}

/**
 * LayerFS merge units (branch.merge `units`) every merge passes:
 * - git: each side's git metadata (HEAD, index, refs, logs, packed-refs) is one unit, taken whole
 *   from the side that wrote it last, so the merged `.git` is one side's consistent repository,
 *   never refs of one side mixed with the index of the other. Objects and packs are left out of the
 *   unit: content-addressed, they merge as a union, so the other side's commits stay reachable by id.
 * - deps: a dependency tree (`node_modules`) comes whole from one side, never mixed file by file.
 */
export const MERGE_UNITS = [
  { name: "git", patterns: [".git", "!**/.git/**/objects/??", "!**/.git/**/objects/pack", "!**/.git/**/lfs/objects", "!**/.git/objects/??", "!**/.git/objects/pack", "!**/.git/lfs/objects"] },
  { name: "deps", patterns: ["node_modules"] },
];

export type ApplyDecision = "write" | "unchanged" | "skip" | "conflict";

/**
 * What apply does with one git path, from the folder's current state (`host`), the Branch's base
 * (`base`) and the Branch (`want`); each a signature string or null (absent). `same(x, y)` compares
 * two of them (for the index: by entries). Objects are add-only; transient and protected never move.
 */
export function decideGitPath(kind: GitPathKind, host: string | null, base: string | null, want: string | null): ApplyDecision {
  if (kind === "protected" || kind === "transient" || kind === "none") return "skip";
  if (host === want) return "unchanged";
  if (kind === "object") return want !== null && host === null ? "write" : "skip";
  if (want === base) return "unchanged"; // the Branch did not change it (e.g. only git's stat cache moved)
  if (host === base) return "write";
  // an index this parser cannot read (split index, a newer format) compares by bytes, stat data
  // included, so it differs on every disk: never take that for a commit made in the folder
  if (kind === "index" && (host?.startsWith("file:") || base?.startsWith("file:"))) return "skip";
  return kind === "soft" ? "skip" : "conflict";
}

/** One line on the git metadata among changed paths (views hide `.git`; this says what apply does to it). */
export function gitChangeSummary(paths: string[], layout?: GitLayout): string {
  const refs: string[] = [];
  let head = false, index = false, objects = 0, other = 0;
  for (const raw of paths) {
    const rel = String(raw).replace(/^\/+/, "");
    const kind = resolveGitPath(rel, layout).kind;
    if (kind === "none") continue;
    if (kind === "ref") refs.push(splitGitPath(rel)!.inner);
    else if (kind === "head") head = true;
    else if (kind === "index") index = true;
    else if (kind === "object") objects++;
    else other++;
  }
  const parts = [
    refs.length ? `${refs.length} ref(s): ${refs.slice(0, 4).join(", ")}${refs.length > 4 ? ", …" : ""}` : "",
    head ? "HEAD" : "",
    index ? "index" : "",
    objects ? `${objects} object file(s)` : "",
    other ? `${other} other` : "",
  ].filter(Boolean);
  return parts.length ? `.git: ${parts.join(", ")}` : "";
}

/**
 * The entries of a git index file without stat data (`mode oid stage flags path`, one per line), so
 * two indexes that stage the same content compare equal even when written on different disks (the
 * stat cache in a Branch's index names NFS inodes and times). null when the bytes are not an index
 * this parser reads (split index, unknown version, damaged): callers then compare bytes.
 */
export function indexEntries(buf: Buffer): string | null {
  const out = parseIndexEntries(buf);
  return out === null ? null : out.map(entryLine).join("\n");
}

/** One staged entry of a git index (no stat data). */
export interface IndexEntry { mode: number; oid: string; stage: number; flags: number; path: string }
const entryLine = (e: IndexEntry) => `${e.mode.toString(8)} ${e.oid} ${e.stage} ${e.flags} ${e.path}`;

/** The entries of a git index file ([] for an empty index), or null (see indexEntries). Paths may hold any byte, `\n` too. */
export function parseIndexEntries(buf: Buffer): IndexEntry[] | null {
  try {
    if (buf.length < 12 + 20 || buf.toString("latin1", 0, 4) !== "DIRC") return null;
    const version = buf.readUInt32BE(4);
    if (version < 2 || version > 4) return null;
    const count = buf.readUInt32BE(8);
    for (const hashLen of [20, 32]) {
      const out = parseEntries(buf, version, count, hashLen);
      if (out !== null) return out;
    }
    return null;
  } catch {
    return null;
  }
}

function parseEntries(buf: Buffer, version: number, count: number, hashLen: number): IndexEntry[] | null {
  const end = buf.length - hashLen; // trailing checksum
  let pos = 12;
  let prev = "";
  const lines: IndexEntry[] = [];
  for (let i = 0; i < count; i++) {
    const start = pos;
    if (pos + 40 + hashLen + 2 > end) return null;
    const mode = buf.readUInt32BE(pos + 24);
    const oid = buf.toString("hex", pos + 40, pos + 40 + hashLen);
    pos += 40 + hashLen;
    const flags = buf.readUInt16BE(pos);
    pos += 2;
    let ext = 0;
    if (flags & 0x4000) {
      if (version < 3) return null;
      ext = buf.readUInt16BE(pos);
      pos += 2;
    }
    let name: string;
    if (version === 4) {
      let c = buf[pos++];
      let strip = c & 127;
      while (c & 128) { c = buf[pos++]; strip = ((strip + 1) << 7) | (c & 127); }
      const nul = buf.indexOf(0, pos);
      if (nul < 0 || nul > end || strip > prev.length) return null;
      name = prev.slice(0, prev.length - strip) + buf.toString("utf8", pos, nul);
      pos = nul + 1;
    } else {
      const nul = buf.indexOf(0, pos);
      if (nul < 0 || nul > end) return null;
      name = buf.toString("utf8", pos, nul);
      pos = start + Math.ceil((nul + 1 - start) / 8) * 8; // 1..8 NULs pad the entry to 8 bytes
    }
    if (pos > end) return null;
    prev = name;
    lines.push({ mode, oid, stage: (flags >> 12) & 3, flags: ext & 0x6000, path: name });
  }
  // extensions follow; a split index ("link") keeps entries elsewhere: not comparable by entries
  while (pos + 8 <= end) {
    const sig = buf.toString("latin1", pos, pos + 4);
    const size = buf.readUInt32BE(pos + 4);
    if (sig === "link") return null;
    pos += 8 + size;
  }
  if (pos !== end) return null;
  return lines;
}

/**
 * The signature apply compares for one git path: the index by its entries (see indexEntries), every
 * other file by its bytes and mode. null for an absent path.
 */
export function gitSig(kind: GitPathKind, entry: { data: Buffer; mode: number } | { target: string } | null): string | null {
  if (!entry) return null;
  if ("target" in entry) return `link:${entry.target}`;
  if (kind === "index") {
    // NUL-terminated: a path holding "\n" cannot pass for two entries
    const e = parseIndexEntries(entry.data);
    if (e !== null) return `index:${createHash("sha256").update(e.map((x) => `${entryLine(x)}\0`).join("")).digest("hex")}`;
  }
  return `file:${createHash("sha256").update(entry.data).digest("hex")}:${(entry.mode & 0o111) ? "x" : "-"}`;
}

/** Apply order for git paths: objects before the refs that name them, HEAD and the index last. */
export const GIT_APPLY_ORDER: Record<GitPathKind, number> = { none: 0, object: 1, soft: 2, ref: 3, index: 4, head: 5, transient: 9, protected: 9 };

/**
 * The fallback command (shown only when the automatic join, src/gitjoin.ts, could not run) that joins
 * a kept ref's history into the checked-out branch. LayerFS already merged the files, so the work
 * tree differs from HEAD and `git merge` refuses; plumbing records a commit of the merged work tree
 * with both parents instead, without touching the work tree.
 */
export const GIT_JOIN_HINT = (ref: string) =>
  `git add -A && git update-ref -m 'join' HEAD "$(git commit-tree "$(git write-tree)" -p HEAD -p '${ref}' -m 'join ${ref.split("/").slice(2, 3).join("")}')"`;

/**
 * A plain git branch name (the rules of `git check-ref-format`, restricted to safe characters): it
 * comes from another Branch's `.git` and is shown in a command, so anything unusual is left out.
 */
export function isSafeRefName(name: string): boolean {
  return /^[A-Za-z0-9._\/-]{1,200}$/.test(name) && !name.includes("@{")
    && !/(^|\/)\./.test(name) && !/\.\./.test(name) && !/\/\//.test(name)
    && !/(^\/|\/$|\.lock$|\.$|^-)/.test(name) && !/(^|\/)\.lock(\/|$)/.test(name);
}

/**
 * A full ref name git accepts (the rules of `git check-ref-format`): under refs/, no control
 * character, space or `~^:?*[\\`, no `..`, `@{`, `//`, trailing `/` or `.`, no component that starts
 * with `.` or ends with `.lock`. A name git would refuse is never written to the folder (git would
 * then fail on every command that lists refs). Stricter than git on purpose: at most 255 characters
 * (a loose ref is a file path; longer names fail on most file systems, NAME_MAX per component and
 * deep paths), and `.lock` in any case (`FOO.LOCK` is git's lock file `FOO.lock` on a
 * case-insensitive APFS/HFS+ disk).
 */
export function isValidGitRefName(ref: string): boolean {
  if (!ref.startsWith("refs/") || ref.length <= 5 || ref.length > 255) return false;
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(ref)) return false;
  if (ref.includes("..") || ref.includes("@{") || ref.includes("//") || ref.endsWith("/") || ref.endsWith(".")) return false;
  return ref.split("/").every((c) => c.length > 0 && !c.startsWith(".") && !c.toLowerCase().endsWith(".lock"));
}

/**
 * The namespaces of minilfs's rescued refs: `refs/minilfs/`, and the places allocateRescueRef moves
 * them to when a ref named `refs/minilfs` blocks that folder (`refs/minilfs-rescue/`,
 * `refs/minilfs-rescue-<oid12>/`, `refs/minilfs-rescue-<oid>[-n]/`).
 */
const RESCUE_NS = "refs/minilfs(-rescue(-[0-9a-f]+(-[0-9]+)?)?)?/";
const RESCUE_RX = new RegExp(`^${RESCUE_NS}`);
const RESCUED_HEAD_RX = new RegExp(`^${RESCUE_NS}[^/]+/(heads/|HEAD$)`);

/** A ref minilfs keeps for a merged Branch (see RESCUE_NS); later merges carry these along. */
export function isRescueRef(ref: string): boolean {
  return RESCUE_RX.test(ref);
}

/**
 * The object type a ref must name: HEAD, branch heads and minilfs's rescues of them a commit; any
 * other ref (tags, notes, ...) anything. For a symbolic ref, every name on its chain counts
 * (`refs/heads/x` -> `refs/tags/t` must still end at a commit).
 */
export function expectedType(inner: string): "commit" | "any" {
  return inner === "HEAD" || inner.startsWith("refs/heads/") || RESCUED_HEAD_RX.test(inner) ? "commit" : "any";
}

export type RescueAllocation = { kind: "kept" | "already"; ref: string };

/**
 * Where a rescued ref (`oid`, preferred name `dst`) goes among `existing` (full ref name -> oid, ""
 * for a name in use that holds no oid; a key ending in `/` is a folder of refs; the chosen name is
 * added): `dst`, then `dst-<oid12>`, `dst-<oid>`, `dst-<oid>-2`, `-3`, ... The first name that already
 * holds `oid` means it is kept already; else the first that is free and is neither a folder of refs
 * nor inside a ref (git keeps refs as paths: `foo` and `foo/bar` cannot both exist). A ref above
 * `dst` blocks every suffix, so that component is renamed (`<ancestor>-<oid12>/...`, the first of
 * its names that is not a ref) and the search restarts; a ref named `refs/minilfs` itself moves the
 * rescue to `refs/minilfs-rescue[...]/`, so it stays a rescue (isRescueRef) for later merges.
 * Always answers (`existing` is finite): nothing is dropped.
 */
export function allocateRescueRef(existing: Map<string, string>, dst: string, oid: string): RescueAllocation {
  const names = function* (d: string) {
    yield d;
    yield `${d}-${oid.slice(0, 12)}`;
    yield `${d}-${oid}`;
    for (let n = 2; ; n++) yield `${d}-${oid}-${n}`;
  };
  for (;;) {
    let ancestor: string | null = null;
    for (const cand of names(dst)) {
      if (existing.get(cand) === oid) return { kind: "already", ref: cand };
      let clash = false;
      for (const k of existing.keys()) {
        if (!k.endsWith("/") && cand.startsWith(`${k}/`)) { ancestor = k; break; }
        if (k === cand || k.startsWith(`${cand}/`)) clash = true;
      }
      if (ancestor) break;
      if (!clash) {
        existing.set(cand, oid);
        return { kind: "kept", ref: cand };
      }
    }
    // the suffix never leaves the ancestor's subtree (a suffix has no `/`): rename that component
    if (!ancestor || ancestor.split("/").length < 2) throw new Error(`no place for ${dst}: ${ancestor} is a ref`);
    // the first name for it that is no ref itself (a folder of refs there is fine: dst goes inside it)
    // refs/minilfs or one of the rescue roots: renamed among the rescue roots (a suffix on a rescue
    // root, refs/minilfs-rescue-<oid12>-<oid12>, would leave the namespace isRescueRef recognises)
    const from = /^refs\/minilfs(-rescue[^/]*)?$/.test(ancestor) ? "refs/minilfs-rescue" : ancestor;
    let alt = from;
    for (const c of names(from)) if (!(existing.has(c) && !c.endsWith("/"))) { alt = c; break; }
    dst = `${alt}${dst.slice(ancestor.length)}`;
  }
}
