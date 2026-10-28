import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, promises as fsp, readFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import type { HostEntry } from "./bindings.ts";
import { run } from "./core/exec-helper.ts";
import { LayerfsError } from "./errors.ts";
import { expectedType, GIT_APPLY_ORDER, gitSig, isValidGitRefName, parseIndexEntries, resolveGitPath, splitGitPath, type GitLayout, type GitPathKind } from "./gitpaths.ts";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

const sameSig = (a: HostEntry | null | undefined, b: HostEntry | null | undefined) =>
  a === b || (Boolean(a) && Boolean(b) && a!.kind === b!.kind && a!.sig === b!.sig && ((a!.mode ?? 0o644) & 0o7777) === ((b!.mode ?? 0o644) & 0o7777));

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

/**
 * A folder file the ref graph check read, as read: its bytes, null (absent, or a folder of refs), "big"
 * (a file too large to be a ref) or "other" (a symlink, device, unreadable).
 */
type RefFileState = Buffer | null | "big" | "other";
/**
 * The folder files (project-relative) gitObjectsMissing's answer rests on, as it read them; a key
 * ending in `worktrees/` is a git dir's worktree listing (names joined by newlines).
 */
type GitReads = Map<string, RefFileState>;
async function refFileState(abs: string, max = 1024): Promise<RefFileState> {
  const st = await fsp.lstat(abs).catch((e: any) => (e?.code === "ENOENT" || e?.code === "ENOTDIR" ? null : "other" as const));
  if (st === null || st === "other") return st;
  if (st.isDirectory()) return null;
  if (!st.isFile()) return "other";
  if (st.size > max) return "big";
  return fsp.readFile(abs).catch(() => "other" as const);
}
/** A git dir's linked worktrees (the names below `worktrees/`), sorted. */
const worktreeList = async (gitDirAbs: string) => (await fsp.readdir(join(gitDirAbs, "worktrees")).catch(() => [] as string[])).sort();
const sameRefFileState = (a: RefFileState, b: RefFileState) => (Buffer.isBuffer(a) && Buffer.isBuffer(b) ? a.equals(b) : a === b);

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
/** git's symbolic-ref depth limit (refs.c SYMREF_MAXDEPTH) */
const SYMREF_MAX_HOPS = 5;
/** loose refs read to find the folder's symbolic refs; beyond this apply refuses the git metadata (git packs refs long before) */
const MAX_SYMREF_SCAN_FILES = 10_000;

/**
 * The repository a git dir's refs live in: a linked worktree's (`<git dir>/worktrees/<id>`, with a
 * `commondir` file as git requires) shares its main git dir's refs; any other git dir is its own.
 */
const commonGitDir = (cwd: string, dir: string) => {
  const m = /^(.+)\/worktrees\/[^/]+$/.exec(dir);
  return m && existsSync(join(cwd, dir, "commondir")) ? m[1] : dir;
};
/** A ref each worktree has its own of (git's per-worktree refs). */
const isWorktreeLocalRef = (ref: string) => /^refs\/(bisect|rewritten|worktree)\//.test(ref);
/** A HEAD in a repository's ref view: its own, or a linked worktree's (`worktrees/<id>/HEAD`). */
const isHeadName = (name: string) => name === "HEAD" || /^worktrees\/[^/]+\/HEAD$/.test(name);

type ResolvedRef =
  | { kind: "oid"; oid: string; chain: string[] }
  | { kind: "missing" | "invalid" | "loop"; target: string; chain: string[] };

/**
 * The refs of one repository (`common`: its refs/, packed-refs, HEAD, and each linked worktree's
 * HEAD as `worktrees/<id>/HEAD`) as they will be once `meta` is written, looked up as git does: the
 * planned loose ref (or its deletion), else the folder's loose ref, else packed-refs (the planned
 * one, else the folder's). `touched`: every name `meta` writes or deletes, and every name whose
 * packed-refs line is added, changed or removed.
 */
async function refsAfter(cwd: string, common: string, meta: GitWrite[], layout?: GitLayout, reads?: GitReads) {
  const planned = new Map<string, GitWrite>();
  let packedPlan: GitWrite | null = null;
  for (const g of meta) {
    if (g.git === "soft") continue;
    const { gitDir, tail } = resolveGitPath(g.rel, layout);
    if (!gitDir || commonGitDir(cwd, gitDir) !== common) continue;
    const name = gitDir === common ? tail : `${gitDir.slice(common.length + 1)}/${tail}`;
    if (name === "packed-refs") packedPlan = g;
    else if (isHeadName(name) || /^(worktrees\/[^/]+\/)?refs\//.test(name)) planned.set(name, g);
  }
  const text = (g: GitWrite) => (g.next?.kind === "file" ? g.next.data.toString("utf8") : null);
  const parsePacked = (t: string) => {
    const out = new Map<string, string>();
    for (const line of t.split("\n")) {
      const m = /^([0-9a-f]+) (\S+)$/.exec(line);
      if (m) out.set(m[2], m[1]);
    }
    return out;
  };
  /** every folder file this view read, as read (writeGitLocked locks and re-reads the ones the check depends on) */
  const seen = new Map<string, RefFileState>();
  const packedState = await refFileState(join(cwd, common, "packed-refs"), Infinity);
  seen.set("packed-refs", packedState);
  const hostPacked = parsePacked(Buffer.isBuffer(packedState) ? packedState.toString("utf8") : "");
  const packed = packedPlan ? parsePacked(text(packedPlan) ?? "") : hostPacked;
  const touched = new Set(planned.keys());
  for (const n of new Set([...hostPacked.keys(), ...packed.keys()])) if (hostPacked.get(n) !== packed.get(n)) touched.add(n);
  /** the folder's loose ref: its text, null (none, or a folder of refs), or "" (too large to be a ref: resolves as invalid) */
  const hostLoose = async (name: string): Promise<string | null> => {
    let st = seen.get(name);
    if (st === undefined) seen.set(name, (st = await refFileState(join(cwd, common, name))));
    return Buffer.isBuffer(st) ? st.toString("utf8") : st === "big" ? "" : null;
  };
  /**
   * The graph check depends on these names as the folder has them now (a symbolic ref's chain, a
   * HEAD, and packed-refs): recorded in `reads` with what was read, so writeGitLocked holds their
   * locks and finds them unchanged until the folder's git metadata is written. Planned names are
   * locked and checked as writes already.
   */
  const depend = (names: string[]) => {
    if (!reads) return;
    reads.set(`${common}/packed-refs`, packedState);
    for (const n of names) if (!planned.has(n) && seen.has(n)) reads.set(`${common}/${n}`, seen.get(n)!);
  };
  const lookup = async (name: string): Promise<string | null> => {
    const p = planned.get(name);
    const loose = p ? text(p) : await hostLoose(name);
    return loose ?? packed.get(name) ?? null;
  };
  const resolve = async (start: string): Promise<ResolvedRef> => {
    const chain = [start];
    // a linked worktree's per-worktree refs (HEAD, refs/bisect|rewritten|worktree/) live in its own
    // git dir: from its HEAD they are worktrees/<id>/<ref>, never the common dir's or packed-refs'
    const wt = /^worktrees\/[^/]+\//.exec(start)?.[0] ?? "";
    for (let name = start; ; ) {
      const t = await lookup(name);
      if (t === null) return { kind: "missing", target: name, chain };
      const m = /^ref:\s*(\S+)$/.exec(t.trim());
      if (!m) return { kind: "oid", oid: t.trim(), chain };
      if (!isValidGitRefName(m[1])) return { kind: "invalid", target: m[1], chain };
      if (chain.length > SYMREF_MAX_HOPS) return { kind: "loop", target: m[1], chain };
      name = wt && isWorktreeLocalRef(m[1]) ? `${wt}${m[1]}` : m[1];
      chain.push(name);
    }
  };
  /**
   * Every name that will be a symbolic ref: HEAD, each worktree's HEAD, the folder's loose
   * symbolic refs (refs/ walked, bounded) and the planned ones; or why they cannot be listed.
   */
  /** the folder's loose refs (refs/ walked by symbolic()) */
  const looseHost = new Set<string>();
  /**
   * On a case-insensitive disk (`HEAD` and `head` one file) two refs whose names differ only in
   * case are one file: git reading one reads the other's oid (a loose `Main` shadows a packed
   * `main`), and a folder `Foo/` is the ref `foo`. Why the refs after `meta` would alias so, where
   * a changed name is involved, or null. Call after symbolic() (it lists the folder's loose refs).
   */
  const caseAliases = async (): Promise<string | null> => {
    const u = await fsp.lstat(join(cwd, common, "HEAD")).catch(() => null);
    const l = u ? await fsp.lstat(join(cwd, common, "head")).catch(() => null) : null;
    if (!u || !l || u.dev !== l.dev || u.ino !== l.ino) return null;
    const loose = new Set(looseHost);
    for (const [n, g] of planned) if (n.startsWith("refs/")) { if (g.next) loose.add(n); else loose.delete(n); }
    const byFold = new Map<string, Set<string>>();
    const add = (n: string) => { const k = n.toLowerCase(); (byFold.get(k) ?? byFold.set(k, new Set()).get(k)!).add(n); };
    for (const n of loose) add(n);
    for (const n of packed.keys()) add(n);
    for (const [, names] of byFold) {
      // only packed names: packed-refs is one text file, its names compare exactly
      if (names.size < 2 || ![...names].some((n) => loose.has(n)) || ![...names].some((n) => touched.has(n))) continue;
      const [a, b] = [...names].sort();
      return `${common}/${a} and ${common}/${b} differ only in case on a case-insensitive file system`;
    }
    // a loose ref and a folder of loose refs whose names differ only in case
    for (const n of loose) {
      for (let p = posix.dirname(n); p.split("/").length > 2; p = posix.dirname(p)) {
        const other = [...(byFold.get(p.toLowerCase()) ?? [])].find((x) => x !== p && loose.has(x));
        if (other && (touched.has(n) || touched.has(other))) return `${common}/${other} and ${common}/${n} differ only in case on a case-insensitive file system`;
      }
    }
    return null;
  };
  const symbolic = async (): Promise<string[] | { error: string }> => {
    const names = new Set<string>(["HEAD", ...planned.keys()]);
    const worktrees = await worktreeList(join(cwd, common));
    for (const w of worktrees) names.add(`worktrees/${w}/HEAD`);
    // a worktree added meanwhile brings a HEAD this check never saw: the listing is re-read under the locks
    reads?.set(`${common}/worktrees/`, Buffer.from(worktrees.join("\n")));
    let files = 0;
    const walk = async (rel: string): Promise<string | null> => {
      for (const e of await fsp.readdir(join(cwd, common, rel), { withFileTypes: true }).catch(() => [])) {
        const child = `${rel}/${e.name}`;
        if (e.isDirectory()) { const why = await walk(child); if (why) return why; continue; }
        if (e.isFile() && isValidGitRefName(child)) looseHost.add(child);
        if (!e.isFile() || planned.has(child) || !isValidGitRefName(child)) continue; // a lock file is no ref
        if (++files > MAX_SYMREF_SCAN_FILES) return `${common}/refs has more than ${MAX_SYMREF_SCAN_FILES} loose refs (run git pack-refs in your folder)`;
        if (/^ref:/.test((await hostLoose(child)) ?? "")) names.add(child);
      }
      return null;
    };
    const why = await walk("refs");
    if (why) return { error: why };
    const out: string[] = [];
    for (const n of names) if (/^ref:/.test(((await lookup(n)) ?? "").trim())) out.push(n);
    // every HEAD, symbolic or detached: a checkout in the folder meanwhile makes it name another branch
    depend([...names].filter(isHeadName));
    return out;
  };
  return { planned, touched, lookup, resolve, symbolic, depend, caseAliases };
}

/**
 * Why the folder cannot take these refs/HEAD/index, or null. In each git dir (as the folder has it):
 * every ref parses (oids of the repository's hash length), branch heads and HEAD name commits, index
 * entries name blobs (not gitlinks, not intent-to-add), packed-refs' peeled `^` lines are what their
 * tag peels to, symbolic refs resolve (HEAD may be unborn on a branch this apply does not delete: the
 * folder's own unborn HEAD always, one the Branch's change leads there only in a repository without
 * commits), and
 * everything the new commits and tags reach is there (`rev-list --objects --missing=print`, minus
 * what the folder's refs already reach). git runs with cleanGitEnv, no hooks, no fsmonitor. A ref
 * written by a file tool, or objects never added, would otherwise leave the folder's git broken.
 */
async function gitObjectsMissing(cwd: string, meta: GitWrite[], layout?: GitLayout, reads?: GitReads): Promise<string | null> {
  type Want = "commit" | "blob" | "any";
  type Dir = { want: Map<string, Set<Want>>; tips: Set<string>; peeled: Array<[string, string]>; addsHeads: boolean; unborn: string | null };
  const byDir = new Map<string, Dir>();
  const dirOf = (dir: string) => {
    let d = byDir.get(dir);
    if (!d) byDir.set(dir, (d = { want: new Map(), tips: new Set(), peeled: [], addsHeads: false, unborn: null }));
    return d;
  };
  const need = (d: Dir, oid: string, w: Want) => d.want.set(oid, (d.want.get(oid) ?? new Set<Want>()).add(w));
  /** repositories whose refs change (a deletion alone counts: it can leave a branch or HEAD naming nothing) */
  const commons = new Set<string>();
  for (const g of meta) {
    if (g.git === "soft") continue;
    // the same reading of the path as apply's (resolveGitPath with the layout), so its git dir is the one checked
    const { gitDir: dir, tail: inner } = resolveGitPath(g.rel, layout);
    if (!dir) continue;
    if (g.git !== "index") commons.add(commonGitDir(cwd, dir));
    if (!g.next || g.next.kind !== "file") continue;
    const d = dirOf(dir);
    const text = g.next.data.toString("utf8");
    if (g.git === "index") {
      const entries = parseIndexEntries(g.next.data);
      if (entries === null) return `${g.rel} cannot be read`;
      for (const e of entries) {
        if (e.mode === 0o160000 || e.flags & 0x2000) continue; // a submodule's commit; intent-to-add (no blob yet)
        need(d, e.oid, e.mode === 0o040000 ? "any" : "blob"); // sparse index: a directory entry names a tree
      }
    } else if (inner === "packed-refs") {
      // git keeps only oids in packed-refs: a `ref:` line (or anything else) is malformed
      let last: string | null = null;
      for (const line of text.split("\n")) {
        if (!line || line.startsWith("#")) continue;
        const peel = /^\^([0-9a-f]+)$/.exec(line);
        if (peel) {
          if (!last) return `${g.rel} has a malformed line`;
          d.peeled.push([last, peel[1]]);
          need(d, peel[1], "any");
          last = null;
          continue;
        }
        const m = /^([0-9a-f]+) (\S+)$/.exec(line);
        if (!m || !isValidGitRefName(m[2])) return `${g.rel} has a malformed line`;
        // every line, even one a loose ref shadows: git uses it once that loose ref is deleted
        need(d, m[1], expectedType(m[2]));
        d.tips.add(m[1]);
        if (m[2].startsWith("refs/heads/")) d.addsHeads = true;
        last = m[1];
      }
    } else {
      const t = text.trim();
      // a loose ref git would refuse by name (refs/heads/a..b) breaks every git command that lists refs
      if (inner !== "HEAD" && !isValidGitRefName(inner)) return `${g.rel} is not a valid ref name`;
      if (t.startsWith("ref:")) {
        const m = /^ref:\s*(\S+)$/.exec(t);
        if (!m || !isValidGitRefName(m[1])) return `${g.rel} is not a ref`;
        continue; // resolved below, in the graph
      }
      if (!/^[0-9a-f]+$/.test(t)) return `${g.rel} is not a ref`;
      need(d, t, expectedType(inner));
      d.tips.add(t);
      if (inner.startsWith("refs/heads/")) d.addsHeads = true;
    }
  }
  // The refs once everything is written, as one graph per repository: every changed name (written,
  // deleted, or its packed-refs line changed: a deleted loose ref uncovers its packed one) and every
  // symbolic ref (HEAD, worktree HEADs, the folder's own) whose chain reaches a changed name, even
  // through refs the Branch did not touch (HEAD -> refs/heads/main -> refs/tags/t, only t changed),
  // must end where its names require: a branch or HEAD at a commit, nothing at a deleted ref.
  for (const common of commons) {
    const view = await refsAfter(cwd, common, meta, layout, reads);
    if (!view.touched.size) continue;
    const symbolic = await view.symbolic();
    if (!Array.isArray(symbolic)) return symbolic.error;
    const alias = await view.caseAliases();
    if (alias) return alias;
    const d = dirOf(common);
    const deleted = new Set<string>();
    for (const n of view.touched) if ((await view.lookup(n)) === null) deleted.add(n);
    // HEADs last: a refusal names the ref closest to the change (refs/heads/x before the HEAD on it)
    for (const name of [...new Set([...view.touched, ...symbolic])].sort((a, b) => Number(isHeadName(a)) - Number(isHeadName(b)))) {
      const r = await view.resolve(name);
      // the answer rests on every name the chain read, also when it reaches no change (any of them
      // retargeted onto a change meanwhile, it would): locked and re-checked by writeGitLocked
      view.depend(r.chain);
      if (!view.touched.has(name) && !r.chain.some((n) => view.touched.has(n))) continue;
      const at = `${common}/${name}`;
      if (r.kind === "loop") return `${at}: symbolic ref loop at ${r.target}`;
      if (r.kind === "invalid") return `${at} names ${r.target}, which is not a valid ref`;
      if (r.kind === "missing") {
        if (r.chain.length === 1 && !isHeadName(name)) continue; // the ref itself is deleted: nothing names it
        if (r.chain.length === 1) return `${at} would not exist`;
        // HEAD on a branch not born yet, never one this apply deletes. The folder's own unborn HEAD (a
        // new repository, git checkout --orphan) is valid in git whatever other branches hold: its
        // chain reaches no change (a changed name missing afterwards is a deleted one), so it is never
        // checked here. A HEAD the Branch's change leads to a branch not born yet: only in a
        // repository without commits (checked below)
        if (isHeadName(name) && !r.chain.some((n) => deleted.has(n))) { d.unborn ??= `${at} names ${r.target}`; continue; }
        // a remote's default branch left behind by a prune (git fetch --prune does the same): git warns, nothing breaks
        if (!view.touched.has(name) && /^refs\/remotes\/[^/]+\/HEAD$/.test(name)) continue;
        return `${at} names ${r.target}, which does not exist`;
      }
      // a branch (or HEAD) anywhere on the chain must end at a commit: refs/heads/x -> refs/tags/blob is refused
      need(d, r.oid, r.chain.some((n) => isHeadName(n) || expectedType(n) === "commit") ? "commit" : "any");
      d.tips.add(r.oid);
      if (r.chain.some((n) => n.startsWith("refs/heads/"))) d.addsHeads = true;
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
    if (d.unborn) {
      // the new refs count too: rev-list --all sees only the folder's refs as they are now
      const any = d.addsHeads || [...d.tips].some((o) => types.get(o) === "commit") ? null : await git(["rev-list", "-n", "1", "--all"]);
      if (!any || any.code !== 0 || any.stdout.toString().trim()) return `${d.unborn}, which does not exist`;
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
 * Where writeGitLocked saves the folder's git metadata before changing it, where it reports, and how
 * it records (and, once the folder is whole again, forgets) the pending recovery for the project.
 */
type GitRecovery = {
  root: string; project: string; warnings: string[]; setRecoveryDir: (dir: string | null, markers?: string[]) => void;
  /** filled with the deletions put back for a worktree added meanwhile (the folder keeps them) */
  restored?: string[];
};

/**
 * The folder's own record of a pending git recovery: `<git dir>/minilfs-recovery` (its text: the
 * recovery folder). It moves with the folder (a moved folder is a new project for minilfs, without
 * the binding's record). Inside .git and not on the allowlist: protected (the sandbox, file tools
 * and apply never write it), never imported or synced into main (hostSkip).
 */
export const RECOVERY_MARKER = "minilfs-recovery";
const RECOVERY_MARKER_RX = /(^|\/)\.git\/minilfs-recovery$/i;
export const isRecoveryMarker = (rel: string) => RECOVERY_MARKER_RX.test(rel);
/** A marker, a path below a marker that is a folder, or a quarantined one (`minilfs-recovery.bad-<time>`, see clearRecovery) and below. */
export const isRecoveryMarkerTree = (rel: string) => /(^|\/)\.git\/minilfs-recovery(\.bad-[^/]+)?(\/|$)/i.test(rel);
/** The recovery folder the folder's top-level marker (or the marker `rel`) names (the marker's own path when it names none), or null. */
export function readFolderRecoveryMarker(cwd: string, rel = `.git/${RECOVERY_MARKER}`): string | null {
  const m = join(cwd, rel);
  let st;
  try { st = lstatSync(m); } catch { return null; }
  if (!st.isFile()) return m;
  try { return readFileSync(m, "utf8").trim() || m; } catch { return m; }
}

/** Apply refuses: an earlier apply's git recovery (the saved versions in `recDir`) is pending. */
function recoveryPendingError(recDir: string): LayerfsError {
  const how = "then run /minilfs recover --clear (or the minilfs tool with action=recover clear=true) to apply again";
  return new LayerfsError("RecoveryPending", existsSync(recDir)
    ? `an earlier apply could not finish putting your folder's git metadata (refs, HEAD, index) back; their previous versions are saved in ${recDir} (see manifest.json there). Check the folder's git, restore what is needed from that folder, ${how}.`
    : `an earlier apply did not finish changing your folder's git metadata (refs, HEAD, index); its saved previous versions (${recDir}) are gone. Check the folder's git (git status, git fsck), ${how}.`);
}

/**
 * The folder's markers a write of these git paths records (`<git dir>/minilfs-recovery`, see
 * RECOVERY_MARKER): in the top-level .git (the folder's identity) and in every other .git a path is
 * in (a nested repository; a submodule's or linked worktree's git dir lives inside its .git). Only
 * folders named .git: the ones hostSkip, the recoveryDir getter and clearRecovery recognise.
 */
function recoveryMarkersFor(cwd: string, rels: string[]): string[] {
  return [...new Set([".git", ...rels.map((r) => splitGitPath(r)?.dir).filter((d): d is string => Boolean(d))])]
    .filter((d) => lstatSync(join(cwd, d), { throwIfNoEntry: false })?.isDirectory())
    .map((d) => `${d}/${RECOVERY_MARKER}`);
}
/** The markers among `markers` the folder has (another session's pending recovery), with the recovery folder each names. */
const foundRecoveryMarkers = (cwd: string, markers: string[]) =>
  markers.map((m) => ({ m, dir: readFolderRecoveryMarker(cwd, m) })).filter((x): x is { m: string; dir: string } => Boolean(x.dir));

/** Makes `dir`'s entries (a rename, a new or removed name in it) durable. */
async function fsyncDir(dir: string): Promise<void> {
  const dh = await fsp.open(dir, "r");
  try { await dh.sync(); } finally { await dh.close(); }
}

/** Writes `dst` and fsyncs it before returning. */
async function writeFileDurable(dst: string, data: Buffer | string, mode = 0o644): Promise<void> {
  const fh = await fsp.open(dst, "w", mode);
  try {
    await fh.writeFile(data);
    await fh.chmod(mode);
    await fh.sync();
  } finally { await fh.close(); }
}

/**
 * Writes refs, HEAD and the index the way git does, so a git command running in the folder at the
 * same time is never overwritten: `<path>.lock` taken exclusively for every path first (sorted),
 * the folder's version checked again under the lock, the new bytes written into the lock file.
 * Only then does anything in the folder change: deletions, then each lock renamed over its path
 * (refs, then the index, then HEAD). A ref namespace change works both ways: a ref below a deleted
 * ref (`foo` -> `foo/bar`) takes its lock once that ref is deleted (the only deletions made before
 * every lock is held); a ref over a folder of deleted refs (`foo/bar` -> `foo`) is renamed once the
 * folder is empty. Returns why nothing was written (a lock git holds, a path that moved), or null
 * when all were written; an I/O error is thrown. Either way after a change, everything is put back
 * (rollback): never over a value the folder's git wrote meanwhile (that one is kept, with a
 * warning). Before the first change, the previous versions are saved under
 * `<root>/recovery/<project>-<time>-<rand>` and the project records that folder (apply refuses while
 * it is recorded); both go once everything is written or put back. When something cannot be put
 * back (or the process dies midway) the record stays and RollbackIncomplete is thrown.
 */
async function writeGitLocked(cwd: string, items: GitWrite[], layout: GitLayout | undefined, recovery: GitRecovery, reads: GitReads = new Map()): Promise<string | null> {
  if (!items.length) return null;
  const depth = (r: string) => r.split("/").length;
  const below = (a: string, b: string) => a.startsWith(`${b}/`);
  const byName = (a: { rel: string }, b: { rel: string }) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
  const deletes = items.filter((i) => !i.next).sort((a, b) => depth(b.rel) - depth(a.rel));
  const writes = items.filter((i) => i.next).sort((a, b) => GIT_APPLY_ORDER[a.git] - GIT_APPLY_ORDER[b.git] || depth(a.rel) - depth(b.rel) || byName(a, b));
  // locked only once the ref file in their way is deleted
  const deferred = new Set(writes.filter((w) => deletes.some((d) => below(w.rel, d.rel))));
  // renamed over a folder the deletions empty
  const overDir = new Set(writes.filter((w) => deletes.some((d) => below(d.rel, w.rel))));
  /**
   * The folder files gitObjectsMissing read (unchanged HEADs, symbolic refs on a checked chain,
   * packed-refs) and the items do not write: locked like git does (`<path>.lock`) and checked
   * unchanged, held until the end, never renamed or deleted. Those below a ref the items delete
   * wait for that deletion, like deferred writes.
   */
  const itemRels = new Set(items.map((i) => i.rel));
  const listings = [...reads].filter(([rel]) => rel.endsWith("/worktrees/"));
  // (a path below a ref the items write cannot exist once that ref is a file: that ref's lock covers it)
  const readDeps = [...reads]
    .filter(([rel]) => !rel.endsWith("/") && !itemRels.has(rel) && !items.some((i) => i.next && below(rel, i.rel)))
    .map(([rel, expected]) => ({ rel, expected }));
  const deferredReads = new Set(readDeps.filter((r) => deletes.some((d) => below(r.rel, d.rel))));
  const readLocks = new Set<string>();
  // the deletions that must happen before every lock is held; the others wait for step 4
  const blocking = new Set(deletes.filter((d) => [...deferred, ...deferredReads].some((w) => below(w.rel, d.rel)) || [...overDir].some((w) => below(d.rel, w.rel))));
  const held = new Set<string>();
  /** what each locked path held before (null: absent) */
  const prev = new Map<string, { data: Buffer; mode: number } | null>();
  /** folders this call created (to take a lock below a deleted ref), shallowest first */
  const createdDirs: string[] = [];
  /** paths deleted, and paths renamed into place with exactly these bytes */
  const unlinked = new Set<string>();
  const installed = new Map<string, { data: Buffer; mode: number; git: GitPathKind }>();
  const lockOf = (rel: string) => `${join(cwd, rel)}.lock`;
  const ensureDir = async (relDir: string) => {
    let cur = "";
    for (const c of relDir.split("/")) {
      cur = cur ? `${cur}/${c}` : c;
      const made = await fsp.mkdir(join(cwd, cur)).then(() => true, (e: any) => (e?.code === "EEXIST" ? false : Promise.reject(e)));
      if (made) createdDirs.push(cur);
    }
  };
  /** takes `it`'s lock and checks the folder still has `it.host`; null when taken, else why not */
  const take = async (it: GitWrite): Promise<string | null> => {
    const target = join(cwd, it.rel);
    await ensureDir(posix.dirname(it.rel));
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
        await fh.sync(); // durable before it is renamed into place
      }
    } finally {
      await fh.close();
    }
    return null;
  };
  /** takes the lock of a path the check read and checks it still holds what was read; null when held, else why not */
  const takeRead = async (r: { rel: string; expected: RefFileState }): Promise<string | null> => {
    const target = join(cwd, r.rel);
    // a ref file where a folder of this path should be: no lock there, and no ref either until that
    // file goes (git deletes it under its own lock): an absent name stays absent, checked below
    const dirOk = await ensureDir(posix.dirname(r.rel)).then(() => true, (e: any) => (e?.code === "ENOTDIR" ? false : Promise.reject(e)));
    const fh = !dirOk ? ("blocked" as const) : await fsp.open(`${target}.lock`, "wx", 0o644).catch((e: any) => {
      if (e?.code === "EEXIST") return "held" as const;
      if (e?.code === "ENOTDIR" || e?.code === "ENOENT") return "blocked" as const;
      return Promise.reject(e);
    });
    if (fh === "held") return `${r.rel}.lock exists: git is running there`;
    if (fh === "blocked" && r.expected !== null) return `${r.rel} cannot be locked`;
    if (fh !== "blocked") {
      held.add(`${target}.lock`);
      readLocks.add(`${target}.lock`);
      await fh.close();
    }
    const now = await refFileState(target, /(^|\/)packed-refs$/.test(r.rel) ? Infinity : 1024);
    return sameRefFileState(now, r.expected) ? null : `${r.rel} changed`;
  };
  /** the folders holding every path written or deleted (and every folder this call made): their entries made durable */
  const syncParents = async () => {
    const dirs = new Set<string>();
    for (const it of items) dirs.add(posix.dirname(it.rel));
    for (const d of createdDirs) dirs.add(posix.dirname(d));
    for (const d of restoredDirs) dirs.add(d);
    for (const d of dirs) {
      // a folder removed meanwhile (a namespace change emptied it): its parent holds the removal
      for (let cur = d; ; cur = posix.dirname(cur)) {
        const ok = await fsyncDir(join(cwd, cur)).then(() => true, (e: any) => (e?.code === "ENOENT" || e?.code === "ENOTDIR" ? false : Promise.reject(e)));
        if (ok || cur === "." || !cur.includes("/")) break;
      }
    }
  };
  const unlock = async (rel: string) => {
    // forgotten only once removed: a lock whose removal failed is still ours for the rollback
    if (held.has(lockOf(rel))) { await fsp.rm(lockOf(rel), { force: true }); held.delete(lockOf(rel)); }
  };
  /**
   * Removes one of our locks where no rollback follows; a lock that stays blocks git on that path,
   * so a failure is reported (never swallowed): returned, and a warning unless `quiet`.
   */
  const unlockWarn = async (lockPath: string, quiet = false): Promise<string | null> => {
    const why = await fsp.rm(lockPath, { force: true }).then(() => null, (e: any) => `could not remove ${relative(cwd, lockPath)}: ${e?.message ?? e}`);
    held.delete(lockPath);
    if (why && !quiet) recovery.warnings.push(`${why} (git refuses that path until it is removed)`);
    return why;
  };
  const removeCreatedDirs = async () => {
    for (const d of [...createdDirs].sort((a, b) => depth(b) - depth(a))) await fsp.rmdir(join(cwd, d)).catch(() => {});
  };
  /**
   * git's lock on `rel` again, waiting up to 2 s while git holds it (briefly, usually). Still held:
   * thrown, so the path counts as not put back (git may yet give up and leave our value there)
   */
  const relock = async (rel: string, mode: number) => {
    for (let i = 0; ; i++) {
      try { return await fsp.open(lockOf(rel), "wx", mode); } catch (e: any) {
        if (e?.code !== "EEXIST" || i >= 40) throw e?.code === "EEXIST" ? new Error(`${rel}.lock is held by git`) : e;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  };
  /** `old` into `rel` through the open lock `fh` (closed here) */
  const putBack = async (fh: import("node:fs/promises").FileHandle, rel: string, old: { data: Buffer; mode: number }) => {
    try {
      await fh.writeFile(old.data);
      await fh.chmod(old.mode & 0o7777);
      await fh.sync();
    } finally { await fh.close(); }
    await fsp.rename(lockOf(rel), join(cwd, rel));
  };
  /**
   * Puts the folder back as it was, without overwriting what its git wrote meanwhile (compare and
   * swap under git's lock). Order: the paths renamed into place, then the folders this call created
   * (now empty: their locks are gone and the new refs in them removed), then the deleted paths
   * (`foo` comes back once `foo/deep/` is gone; `foo/bar` once the ref `foo` over it is gone).
   */
  const rollback = async () => {
    const unrecovered: Array<{ rel: string; err: string }> = [];
    const hostKept: string[] = [];
    // locks of deleted paths we still hold stay: their path comes back through them, no window for
    // another writer; the read locks stay too (a checkout meanwhile could land on a ref put back)
    // (a read lock below a deleted ref goes: that ref comes back where its folder was)
    for (const l of [...held]) {
      const belowDeleted = [...unlinked].some((rel) => l.startsWith(`${join(cwd, rel)}/`));
      if ((readLocks.has(l) && !belowDeleted) || [...unlinked].some((rel) => lockOf(rel) === l)) continue;
      await fsp.rm(l, { force: true }).then(() => held.delete(l), (e: any) => unrecovered.push({ rel: relative(cwd, l), err: `its lock could not be removed: ${e?.message ?? e}` }));
    }
    /** our lock on `rel` goes; a lock that stays is not put back (git refuses the path): unrecovered */
    const unlockOrRecord = (rel: string) => unlock(rel).catch((e: any) => {
      held.delete(lockOf(rel));
      unrecovered.push({ rel: `${rel}.lock`, err: `could not be removed: ${e?.message ?? e}` });
    });
    for (const [rel, put] of [...installed].sort((a, b) => depth(b[0]) - depth(a[0]))) {
      const old = prev.get(rel) ?? null;
      let fh: import("node:fs/promises").FileHandle | null = null;
      try {
        fh = await relock(rel, old?.mode ?? 0o644);
        held.add(lockOf(rel));
        const cur = await readRawEntry(join(cwd, rel));
        // still what we wrote? the index by its entries (a `git status` meanwhile only refreshes its stat data)
        const ours = cur && cur !== "other" && "data" in cur && (cur.mode & 0o7777) === (put.mode & 0o7777)
          && (put.git === "index" ? gitSig("index", cur) === gitSig("index", put) : cur.data.equals(put.data));
        if (!ours) {
          hostKept.push(rel); // the folder's git moved it after our rename: its value stays
          continue;
        }
        if (!old) {
          await fsp.rm(join(cwd, rel), { force: true });
          continue;
        }
        const f = fh;
        fh = null;
        await putBack(f, rel, old);
        held.delete(lockOf(rel));
      } catch (e: any) {
        unrecovered.push({ rel, err: String(e?.message ?? e) });
      } finally {
        await fh?.close().catch(() => {});
        await unlockOrRecord(rel);
      }
    }
    for (const [rel] of installed) if (!prev.get(rel)) await removeEmptyGitRefParents(cwd, rel, layout);
    await removeCreatedDirs();
    for (const rel of [...unlinked].sort((a, b) => depth(a) - depth(b))) {
      const old = prev.get(rel) ?? null;
      if (!old) continue;
      const target = join(cwd, rel);
      let fh: import("node:fs/promises").FileHandle | null = null;
      try {
        if ((await fsp.lstat(target).catch(() => null))?.isDirectory()) await fsp.rmdir(target); // fails when not empty: unrecovered
        await fsp.mkdir(dirname(target), { recursive: true });
        fh = held.has(lockOf(rel)) ? await fsp.open(lockOf(rel), "w", old.mode & 0o7777) : await relock(rel, old.mode & 0o7777);
        held.add(lockOf(rel));
        const cur = await readRawEntry(target);
        if (cur && cur !== "other" && "data" in cur && cur.data.equals(old.data)) continue; // already as it was
        if (cur !== null) { hostKept.push(rel); continue; } // the folder's git made it again meanwhile
        const f = fh;
        fh = null;
        await putBack(f, rel, old);
        held.delete(lockOf(rel));
      } catch (e: any) {
        unrecovered.push({ rel, err: String(e?.message ?? e) });
      } finally {
        await fh?.close().catch(() => {});
        await unlockOrRecord(rel);
      }
    }
    await removeCreatedDirs();
    // every lock of ours is gone by now; one that is not (or cannot be removed) is reported (a read
    // lock changed nothing: a warning, like any lock left once all is done)
    for (const l of [...held]) {
      const why = await unlockWarn(l, !readLocks.has(l));
      if (why && !readLocks.has(l)) unrecovered.push({ rel: relative(cwd, l), err: why });
    }
    if (hostKept.length) recovery.warnings.push(`your folder's git updated ${hostKept.join(", ")} while apply was putting git metadata back; its value was kept`);
    if (!unrecovered.length) {
      // the folder is whole again only once that is on disk: then the record goes
      await syncParents();
      return forget();
    }
    // the folder's git metadata cannot be fully put back: its previous versions were saved before the
    // first change, and the project already records them (apply refuses); the manifest says what failed
    await writeFileDurable(join(recDir!, "manifest.json"), JSON.stringify({ ...manifest, status: "rollback_incomplete", unrecovered, hostKept }, null, 2) + "\n").catch(() => {});
    const err = new LayerfsError("RollbackIncomplete", `git rollback could not restore ${unrecovered.map((u) => `${u.rel} (${u.err.slice(0, 80)})`).join(", ")}; the previous versions are saved in ${recDir} (manifest.json lists what is where)`);
    (err as any).recoveryDir = recDir;
    throw err;
  };
  const mutated = () => unlinked.size > 0 || installed.size > 0;
  /** the saved previous versions (set once saved and recorded for the project) */
  let recDir: string | null = null;
  let manifest: Record<string, unknown> = {};
  /**
   * Saves every previous version and records the folder for the project, before anything in the
   * folder changes: a failure afterwards (or the process dying) leaves the record, and apply
   * refuses until the user clears it. A failure here changes nothing in the folder: thrown.
   */
  /**
   * The folder's markers (`<git dir>/minilfs-recovery`, see RECOVERY_MARKER): in the top-level .git
   * (the folder's identity) and in every other .git a written path is in (a nested repository).
   */
  const markers = recoveryMarkersFor(cwd, items.map((i) => i.rel));
  /** the markers this call created (exclusively): the only ones it ever removes */
  const createdMarkers: string[] = [];
  /** another session's pending recovery in a marker of `markers`: adopted for the project; apply refuses */
  const adoptForeign = (found: Array<{ m: string; dir: string }>) => {
    recovery.setRecoveryDir(found[0].dir, found.map((x) => x.m));
    return recoveryPendingError(found[0].dir);
  };
  const removeMarkers = async () => {
    for (const m of [...createdMarkers]) { await fsp.rm(join(cwd, m), { force: true }); createdMarkers.splice(createdMarkers.indexOf(m), 1); }
    for (const m of markers) await fsyncDir(join(cwd, posix.dirname(m))).catch(() => {});
  };
  const persist = async () => {
    const dir = join(recovery.root, `${recovery.project}-${Date.now()}-${randomBytes(3).toString("hex")}`);
    try {
      // durable before the first change (fsync: the files, then the folders holding them, up to the
      // recovery root's parent), then the folder's markers, then the binding (fsynced in save)
      const dirs = new Set<string>([dir, recovery.root, dirname(recovery.root)]);
      for (const [rel, val] of prev) {
        if (!val) continue;
        const dst = join(dir, "preimages", rel);
        await fsp.mkdir(dirname(dst), { recursive: true });
        await writeFileDurable(dst, val.data, val.mode & 0o7777);
        for (let d = dirname(dst); d !== dir && d.startsWith(`${dir}/`); d = dirname(d)) dirs.add(d);
      }
      manifest = { project: recovery.project, cwd, at: Date.now(), status: "applying", absentBefore: items.filter((i) => !prev.get(i.rel)).map((i) => i.rel), preimages: "preimages/<path> holds each path's previous bytes", markers };
      await fsp.mkdir(dir, { recursive: true });
      await writeFileDurable(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
      for (const d of [...dirs].sort((a, b) => b.length - a.length)) await fsyncDir(d);
      // created exclusively: a marker another session wrote meanwhile (a nested repository's own
      // apply) is never overwritten: adopted, and this apply stops before any change
      for (const m of markers) {
        const fh = await fsp.open(join(cwd, m), "wx", 0o644).catch((e: any) => (e?.code === "EEXIST" ? null : Promise.reject(e)));
        if (!fh) {
          const err = adoptForeign([{ m, dir: readFolderRecoveryMarker(cwd, m) ?? join(cwd, m) }]);
          (err as any).adopted = true;
          throw err;
        }
        createdMarkers.push(m);
        try {
          await fh.writeFile(`${dir}\n`);
          await fh.chmod(0o644);
          await fh.sync();
        } finally { await fh.close(); }
      }
      for (const m of markers) await fsyncDir(join(cwd, posix.dirname(m)));
      recovery.setRecoveryDir(dir, markers);
      recDir = dir;
    } catch (e: any) {
      // the record goes before the markers and the folder: a record whose folder is gone still blocks apply (never the reverse)
      // (an adopted record is another session's: kept)
      let cleared = true;
      if (!e?.adopted) try { recovery.setRecoveryDir(null); } catch { cleared = false; }
      if (cleared) {
        await removeMarkers().catch(() => {});
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
      throw e;
    }
  };
  /**
   * The folder's git is whole again (all written, or all put back, and on disk): the markers go,
   * then the record, then the saved versions. Either guard alone still blocks apply.
   */
  const forget = async () => {
    if (!recDir) return;
    try {
      await removeMarkers();
      recovery.setRecoveryDir(null);
    } catch (e: any) {
      recovery.warnings.push(`could not clear the pending git recovery (${e?.message ?? e}); apply stays blocked until /minilfs recover --clear (the previous versions stay in ${recDir})`);
      return;
    }
    await fsp.rm(recDir, { recursive: true, force: true }).catch(() => {});
    recDir = null;
  };
  /** nothing changed in the folder yet: our locks and folders go, nothing else to undo */
  const release = async () => {
    for (const l of [...held]) await unlockWarn(l);
    await removeCreatedDirs();
    await forget();
  };
  const stop = async (why: string) => {
    if (mutated()) await rollback();
    else await release();
    return why;
  };
  /** a worktree added or removed since the check (its HEAD has no lock to hold before it exists): checked under the locks, again before the renames */
  const listingsChanged = async (): Promise<string | null> => {
    for (const [rel, names] of listings) {
      const now = Buffer.from((await worktreeList(join(cwd, rel.slice(0, -"/worktrees/".length)))).join("\n"));
      if (!sameRefFileState(now, names)) return `${rel.slice(0, -1)} changed (a worktree was added or removed)`;
    }
    return null;
  };
  /** folders of refs restoreForNewWorktrees wrote that no item names (made durable with the others) */
  const restoredDirs = new Set<string>();
  /** see the call in step 4: a deleted ref a worktree HEAD names now comes back */
  const restoreForNewWorktrees = async () => {
    const commons = new Set(listings.map(([rel]) => rel.slice(0, -"/worktrees/".length)));
    for (const common of commons) {
      const packedRel = `${common}/packed-refs`;
      const packedOf = (b: Buffer | undefined | null) => {
        const out = new Map<string, string>();
        for (const line of (b?.toString("utf8") ?? "").split("\n")) { const m = /^([0-9a-f]+) (\S+)$/.exec(line); if (m) out.set(m[2], m[1]); }
        return out;
      };
      // rewritten or deleted here (the Branch's packed-refs gone: its refs live loose or nowhere)
      const packedBefore = installed.has(packedRel) || unlinked.has(packedRel) ? packedOf(prev.get(packedRel)?.data) : null;
      for (const id of await worktreeList(join(cwd, common))) {
        const wt = `worktrees/${id}`;
        let text = await refFileState(join(cwd, common, wt, "HEAD"));
        for (let hop = 0; hop < SYMREF_MAX_HOPS && Buffer.isBuffer(text); hop++) {
          const m = /^ref:\s*(\S+)$/.exec(text.toString("utf8").trim());
          if (!m || !isValidGitRefName(m[1])) break;
          const target = m[1];
          const rel = `${common}/${isWorktreeLocalRef(target) ? `${wt}/${target}` : target}`;
          text = await refFileState(join(cwd, rel));
          if (text !== null) continue; // there (loose): follow it
          const packedNow = isWorktreeLocalRef(target) ? new Map<string, string>() : packedOf(await fsp.readFile(join(cwd, packedRel)).catch(() => null));
          if (packedNow.has(target)) break; // a packed line still holds it
          let old: { data: Buffer; mode: number } | null = null;
          if (unlinked.has(rel)) old = prev.get(rel) ?? null;
          else if (packedBefore?.has(target) && !isWorktreeLocalRef(target)) old = { data: Buffer.from(`${packedBefore.get(target)}\n`), mode: 0o644 };
          if (!old) break; // not deleted here (packed, or unborn): nothing of ours to put back
          await ensureDir(posix.dirname(rel));
          const fh = held.has(lockOf(rel)) ? await fsp.open(lockOf(rel), "w", old.mode & 0o7777) : await relock(rel, old.mode & 0o7777);
          held.add(lockOf(rel));
          await putBack(fh, rel, old);
          held.delete(lockOf(rel));
          unlinked.delete(rel);
          restoredDirs.add(posix.dirname(rel));
          recovery.restored?.push(rel);
          recovery.warnings.push(`worktree ${id} checked out ${target} while apply was deleting it; ${target} was restored`);
          break;
        }
      }
    }
  };
  type Lockable = { rel: string; read?: { rel: string; expected: RefFileState }; item?: GitWrite };
  const takeAny = (l: Lockable) => (l.item ? take(l.item) : takeRead(l.read!));
  try {
    // 1. every lock that can be taken now, writes and reads in one sorted pass (git's order: no
    //    deadlock with a git that locks several refs); nothing in the folder changes yet
    const first: Lockable[] = [
      ...items.filter((i) => !deferred.has(i)).map((item) => ({ rel: item.rel, item })),
      ...readDeps.filter((r) => !deferredReads.has(r)).map((read) => ({ rel: read.rel, read })),
    ];
    for (const l of first.sort(byName)) {
      const why = await takeAny(l);
      if (why) return await stop(why);
    }
    const listed = await listingsChanged();
    if (listed) return await stop(listed);
    // a marker another session wrote since applyLocked checked (a nested repository's own apply that
    // could not finish): adopted, nothing changed; persist() creates ours exclusively after this
    const foreign = foundRecoveryMarkers(cwd, markers);
    if (foreign.length) throw adoptForeign(foreign);
    // the folder changes from step 2 on (step 2 and 3 run only for deletions a lock or a rename
    // waits for; else step 4): the previous versions are saved and recorded first
    await persist();
    // 2. only the deletions a lock or a rename waits for, deepest first; a folder a ref replaces is emptied (its locks go first)
    for (const d of deletes) {
      if (!blocking.has(d)) continue;
      await fsp.rm(join(cwd, d.rel), { force: true });
      unlinked.add(d.rel);
      const over = [...overDir].find((w) => below(d.rel, w.rel));
      if (!over) continue;
      await unlock(d.rel);
      for (let dir = posix.dirname(d.rel); below(dir, over.rel) || dir === over.rel; dir = posix.dirname(dir)) {
        if (!(await fsp.rmdir(join(cwd, dir)).then(() => true, () => false))) break;
      }
    }
    // 3. the locks that had to wait for a deletion; the emptied folders must be gone
    const later: Lockable[] = [...[...deferred].map((item) => ({ rel: item.rel, item })), ...[...deferredReads].map((read) => ({ rel: read.rel, read }))];
    for (const l of later.sort(byName)) {
      const why = await takeAny(l);
      if (why) return await stop(why);
    }
    for (const w of overDir) {
      if ((await readRawEntry(join(cwd, w.rel))) !== null) return await stop(`${w.rel} changed`);
    }
    const listing = await listingsChanged();
    if (listing) return await stop(listing);
    // 4. every lock is held: the other deletions, then the new versions in git's order; then the deletions' locks
    for (const d of deletes) {
      if (blocking.has(d)) continue;
      await fsp.rm(join(cwd, d.rel), { force: true });
      unlinked.add(d.rel);
    }
    for (const w of writes) {
      const next = w.next as { kind: "file"; data: Buffer; mode: number };
      await fsp.rename(lockOf(w.rel), join(cwd, w.rel));
      held.delete(lockOf(w.rel));
      installed.set(w.rel, { data: next.data, mode: next.mode & 0o7777, git: w.git });
    }
    // A linked worktree's HEAD has no lock to hold before it exists: `git worktree add` after the
    // last listing check can put one on a branch deleted here. Re-checked now, after the deletions
    // and renames, and such a branch is put back from its previous version. This narrows the
    // window, it does not close it: a worktree added after this check still dangles. git's own
    // `git branch -d` has the same window (worktree.c reads the worktree HEADs without a lock).
    await restoreForNewWorktrees();
    // the renames and deletions on disk before anything clears the record
    await syncParents();
    // everything is written: a deletion's lock that cannot be removed is reported, nothing is undone
    for (const d of deletes) {
      if (held.has(lockOf(d.rel))) await unlockWarn(lockOf(d.rel));
      await removeEmptyGitRefParents(cwd, d.rel, layout);
    }
    await forget();
    return null;
  } catch (e: any) {
    if (e?.code === "RollbackIncomplete") throw e;
    if (mutated()) {
      try { await rollback(); } catch (re: any) {
        re.message = `${re.message} (after: ${e?.message ?? e})`;
        throw re;
      }
    } else await release();
    throw e;
  } finally {
    for (const l of [...held]) await unlockWarn(l);
    // a folder made only for a read lock is empty again (one holding a new ref stays)
    if (readLocks.size) await removeCreatedDirs();
  }
}

/** Removes folders a deleted ref leaves empty, below `<git dir>/refs/<kind>/` (never refs/, refs/heads/, ...). */
async function removeEmptyGitRefParents(root: string, rel: string, layout?: GitLayout): Promise<void> {
  const dir = resolveGitPath(rel, layout).gitDir;
  if (!dir) return;
  for (let d = posix.dirname(rel); ; d = posix.dirname(d)) {
    const inner = d.slice(dir.length + 1);
    if (!inner.startsWith("refs/") || depthOf(inner) < 3) return;
    if (!(await fsp.rmdir(join(root, d)).then(() => true, () => false))) return;
  }
}
const depthOf = (r: string) => r.split("/").length;

export { cleanGitEnv, fileSig, foundRecoveryMarkers, fsyncDir, gitObjectsMissing, hostState, linkSig, readRawEntry, recoveryMarkersFor, recoveryPendingError, refFileState, refsAfter, removeEmptyGitRefParents, sameSig, writeFileDurable, writeGitLocked };
export type { GitReads, GitRecovery, GitWrite, RawEntry, RefFileState };
