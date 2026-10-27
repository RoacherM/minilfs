import { createHash } from "node:crypto";

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
  const g = splitGitPath(rel);
  if (!g) return "none";
  if (!g.inner) return "protected"; // the `.git` entry itself as a file or symlink (gitdir pointer)
  if (/^modules\//.test(g.inner) && g.inner.split("/").some((c) => REFUSED_COMPONENT_RX.test(c))) return "protected";
  if (new RegExp(DOT_COMPONENT_RX).test(g.inner)) return "protected";
  if (!ALLOWED_RX.test(g.inner)) return "protected";
  // the git directory this path belongs to may be nested (modules/<name>/, worktrees/<id>/): classify by the tail
  const inner = innerOfGitDir(g.inner);
  if (/\.(lock|new)$/.test(inner)) return "transient"; // git's temp files: renamed over the real one
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

const BODY_RX = new RegExp(`^(${GIT_ALLOWED_BODY})$`);
const NESTED_RX = new RegExp(`^((modules/.+?/)|(worktrees/[^/]+/))(${GIT_ALLOWED_BODY})$`);

/**
 * The path below its own git directory: `modules/a/b/refs/x` -> `refs/x`. A top-level entry wins
 * (`refs/heads/modules/x` is a ref); else the shortest `modules/<name>/` prefix, so
 * `modules/x/logs/refs/heads/main` is a log of `modules/x`, not a ref.
 */
function innerOfGitDir(inner: string): string {
  if (BODY_RX.test(inner)) return inner;
  const m = NESTED_RX.exec(inner);
  return m ? inner.slice(m[1].length) : inner;
}

/** The git directory (relative path, e.g. `.git` or `.git/modules/x`) a git path belongs to. */
export function gitDirOf(rel: string): string | null {
  const g = splitGitPath(rel);
  if (!g || !g.inner) return null;
  const tail = innerOfGitDir(g.inner);
  const prefix = g.inner.slice(0, g.inner.length - tail.length).replace(/\/+$/, "");
  return prefix ? `${g.dir}/${prefix}` : g.dir;
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
export function gitChangeSummary(paths: string[]): string {
  const refs: string[] = [];
  let head = false, index = false, objects = 0, other = 0;
  for (const raw of paths) {
    const rel = String(raw).replace(/^\/+/, "");
    const kind = gitPathKind(rel);
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
  try {
    if (buf.length < 12 + 20 || buf.toString("latin1", 0, 4) !== "DIRC") return null;
    const version = buf.readUInt32BE(4);
    if (version < 2 || version > 4) return null;
    const count = buf.readUInt32BE(8);
    for (const hashLen of [20, 32]) {
      const out = parseEntries(buf, version, count, hashLen);
      if (out) return out;
    }
    return null;
  } catch {
    return null;
  }
}

function parseEntries(buf: Buffer, version: number, count: number, hashLen: number): string | null {
  const end = buf.length - hashLen; // trailing checksum
  let pos = 12;
  let prev = "";
  const lines: string[] = [];
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
    lines.push(`${mode.toString(8)} ${oid} ${(flags >> 12) & 3} ${ext & 0x6000} ${name}`);
  }
  // extensions follow; a split index ("link") keeps entries elsewhere: not comparable by entries
  while (pos + 8 <= end) {
    const sig = buf.toString("latin1", pos, pos + 4);
    const size = buf.readUInt32BE(pos + 4);
    if (sig === "link") return null;
    pos += 8 + size;
  }
  if (pos !== end) return null;
  return lines.join("\n");
}

/**
 * The signature apply compares for one git path: the index by its entries (see indexEntries), every
 * other file by its bytes and mode. null for an absent path.
 */
export function gitSig(kind: GitPathKind, entry: { data: Buffer; mode: number } | { target: string } | null): string | null {
  if (!entry) return null;
  if ("target" in entry) return `link:${entry.target}`;
  if (kind === "index") {
    const e = indexEntries(entry.data);
    if (e !== null) return `index:${createHash("sha256").update(e).digest("hex")}`;
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
  return /^[A-Za-z0-9._\/-]{1,200}$/.test(name)
    && !/(^|\/)\./.test(name) && !/\.\./.test(name) && !/\/\//.test(name)
    && !/(^\/|\/$|\.lock$|\.$|^-)/.test(name) && !/(^|\/)\.lock(\/|$)/.test(name);
}
