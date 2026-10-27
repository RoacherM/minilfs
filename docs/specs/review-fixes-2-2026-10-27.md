# Spec: second-round fixes S1–S13 (2026-10-27)

Designed by gemini-4-argon from `docs/issues/quarry-run-2026-10-27.md` §7. Implementer: follow it;
where a line number or name disagrees with the code, the code wins; keep the intent.

Checked here before handing off (2026-10-27):
- S1: a read under `sandbox-exec` with the session profile (configRoot = minilfs root, wsPath and
  scratchDir `/dev/null`) is refused by the kernel for the root's files, a directory listing of
  `<root>/worker`, and a `/tmp` symlink to the endpoint; ordinary outside files (`/tmp/x`,
  `~/.cargo/env`) read fine; ~9 ms per call with `/usr/bin/perl`.
- S12: with `-c attr.tree=<empty> -c core.attributesFile=/dev/null` a `filter.<n>.clean` still ran via
  `.git/info/attributes`; adding `-c filter.<n>.clean= -c filter.<n>.required=false` stopped it
  (update-index still succeeded).
- S2: not reproduced; regression test only.
- S4/S5: `git update-ref --stdin` refuses a D/F change in one transaction (spec's finding), hence the
  own lock transaction below.

The full design follows (as written by the designer).

# Implementation Spec: Quarry Follow-up Review Fixes S1–S13 (2026-10-27)

Context: follow-up to `docs/specs/review-fixes-2026-10-27.md` (`9e027d7..cf47bca`), addressing findings S1–S13 in `docs/issues/quarry-run-2026-10-27.md:172-194` (§7).

---

## 1. S1 — Kernel-Enforced Outside-Read Guard via Seatbelt Subprocess (Blocker)

### Decision
Keep `LayerfsSession.resolveOutsideRead(hostPath)` (`src/workspace.ts:1098-1108`) as a fast in-process pre-check (catching non-existent children under `<root>`/`<bundle>`/`outsideSecrets` with `EACCES` in <0.1 ms), and execute the actual host I/O for outside paths (`!sp` branches in `readFile`, `access`, `exists`, `isDirectory`, `readdir` at `src/workspace.ts:1110-1180`) in a short-lived subprocess under `/usr/bin/sandbox-exec` using the session's Seatbelt read-deny rules.

- **Why not (a) open + `fstat` / `/dev/fd/N` or (b) static allowlist**: On macOS `/dev/fd` is `fdescfs` (character devices, not symlinks: `fs.realpathSync('/dev/fd/N')` returns `"/dev/fd/N"`), Node has no `fcntl(F_GETPATH)`, and `(dev, ino)` of private root directories cannot cover nested files (`endpoint.json`, `~/.ssh/id_rsa`) or unanchored `.env`/`*.pem` excludes; (b) breaks legitimate agent reads of `~/.cargo/registry`, `/opt/homebrew`, sibling repos, and `/tmp` logs.
- **Seatbelt profile (`src/seatbelt.ts:127-325`, `src/workspace.ts:1098`)**:
  - Add optional `extraDenyRoots?: string[]` to `SeatbeltOptions` (`src/seatbelt.ts:6-15`). When non-empty, `buildSeatbeltProfile` adds `bothSpellings` of each entry to the rule-2 `(deny file-read* file-write* (subpath ...))` block (`src/seatbelt.ts:174-179`) and the rule-10b re-include guard (`src/seatbelt.ts:304`). Default `buildSeatbeltProfile` output without `extraDenyRoots` is unchanged (preserving `tests/elevate.test.mjs:139`).
  - Cache `private outsideReadProfile(): string` on `LayerfsSession`: calls `buildSeatbeltProfile({ wsPath: "/dev/null", hostCwd: this.cwd, scratchDir: "/dev/null", configRoot: this.config.root, extraDenyRoots: [this.config.bundle], excludes: this.config.excludes, outsideSecrets: OUTSIDE_SECRET_PATTERNS, network: "deny" })`. Because `wsPath` and `scratchDir` are `"/dev/null"`, nothing under `config.root` or `config.bundle` is re-allowed for read.
- **Subprocess helper (`src/workspace.ts`)**:
  ```ts
  private async runOutsideRead(op: "read" | "access" | "isDir" | "readdir", hostPath: string): Promise<Buffer>
  ```
  1. Call `await this.resolveOutsideRead(hostPath)` first (throws `EACCES` immediately when `abs` or `real` is denied).
  2. Pass `abs = resolve(this.cwd, hostPath)` (not `real`, so the kernel resolves symlinks at `open()`/`opendir()` time inside Seatbelt) to `/usr/bin/sandbox-exec -p <outsideReadProfile> /usr/bin/perl -e <script> <op> <abs>`.
  3. In the Perl one-liner (~8 ms on macOS):
     - `die_err`: `my ($c) = grep { $!{$_} } keys %!; warn(($c || "EACCES") . ":$!\n"); exit 1;`
     - `read`: `sysopen(my $f, $p, 0) or die_err(); if (-d $f) { warn "EISDIR:is a directory\n"; exit 1 } binmode($f); local $/; my $d = <$f>; die_err() if !defined $d; print $d;`
     - `access`: `sysopen(my $f, $p, 0) or die_err();` (`sysopen` with `O_RDONLY` checks `file-read-data` in XNU on both files and directories, unlike `stat()` which only checks `file-read-metadata`).
     - `isDir`: `sysopen(my $f, $p, 0) or die_err(); print((-d $f) ? "1" : "0");`
     - `readdir`: `opendir(my $d, $p) or die_err(); print join("\0", sort grep { $_ ne "." && $_ ne ".." } readdir($d));`
  4. On non-zero exit, parse `^([A-Z]+):(.*)$` from `stderr`, map `EPERM` → `EACCES`, and throw `Object.assign(new Error(`${code}: ${msg} (${hostPath})`), { code })`.
  5. Wire `!sp` branches (`src/workspace.ts:1110-1180`):
     - `readFile`: `return this.runOutsideRead("read", hostPath);`
     - `access`: `if (write) this.mustStorePath(hostPath); await this.runOutsideRead("access", hostPath); return;`
     - `exists`: `return this.access(hostPath, false).then(() => true, () => false);`
     - `isDirectory`: `return (await this.runOutsideRead("isDir", hostPath)).toString() === "1";`
     - `readdir`: `const b = await this.runOutsideRead("readdir", hostPath); return b.length ? b.toString("utf8").split("\0") : [];`

### Edge Cases
- Symlink swapped after `resolveOutsideRead` resolves and before `sysopen`/`opendir` runs: kernel Seatbelt hook denies `open` on the target vnode (`EPERM` → `EACCES`).
- Directory `stat` metadata carve-out (`(allow file-read-metadata (vnode-type DIRECTORY))` at `src/seatbelt.ts:321`): `sysopen(..., O_RDONLY)` requires `file-read-data`, so `access(<root>/worker)` and `isDirectory(<root>/worker)` are kernel-denied even if `resolveOutsideRead` was bypassed by a race.
- Filenames containing `\n` in outside `readdir`: NUL-delimited stdout preserves exact entry names.

### Regression Test
- `tests/elevate.test.mjs`: deterministic TOCTOU simulation — stub `resolveOutsideRead` on a session instance (or swap a `/tmp` symlink between `resolveOutsideRead` and `runOutsideRead` by hooking `resolveOutsideRead` to flip `/tmp/.../flip` from a harmless file/dir to `<root>/worker/b1/endpoint.json` and `~/.ssh` right before returning). Assert `readFile`, `access`, `isDirectory`, `readdir` all reject with `code === "EACCES"` and `exists` returns `false`. Fails before (reads `endpoint.json`), passes after.

---

## 2. S2 — APFS Case-Variant Outside-Read Regression Test

### Decision
No code change needed (`realpathNearest` at `src/workspace.ts:1887-1897` canonicalizes case via `fsp.realpath` on the nearest existing ancestor). Add a regression test only.

### Regression Test
- `tests/elevate.test.mjs` (inside the R1 step at `tests/elevate.test.mjs:372-395`): probe case-altered spellings of `root` and `endpoint` (e.g. `endpoint.replace("/worker/", "/WORKER/")`, uppercased root basename, and a non-existent child `<upperRoot>/worker/nope/endpoint.json`). Assert `readFile`, `access`, `readdir`, `isDirectory` reject with `EACCES` and `exists` returns `false`.

---

## 3. S3 — Single `workspace.commit` and Uncertain-Commit Reconciliation (Major)

### Decision
Separate `fn(wsPath, ws)` failure from `workspace.commit` failure in `withMountedBranch` (`src/workspace.ts:1316-1351`) and share a single helper with `execOnce` (`src/workspace.ts:1419-1425`) so `workspace.commit` is never called a second time when the first `workspace.commit` throws.

- **Helper signature (`src/workspace.ts`)**:
  ```ts
  private async commitWorkspaceOnce(ws: Workspace, branch: string, message: string, label: string): Promise<void>
  ```
- **Exact rules**:
  1. Read `before`: if `branch === this.workBranch`, use `this.headCommit`; else query `(await this.lfs.branch.list_commits(branch, 1, 0).catch(() => null))?.items?.[0]?.id ?? null`.
  2. Call `const res = await this.lfs.workspace.commit(ws, message.slice(0, 4000))`.
  3. On success: build `rec = { kind: res.kind, head: res.commit?.id ?? res.head ?? null }`; if `branch === this.workBranch`, call `this.recordStoreCommit(rec, label)`, else set `this.lastStoreCommit = rec`.
  4. On error `ce`: reconcile once via `const now = (await this.lfs.branch.list_commits(branch, 1, 0).catch(() => null))?.items?.[0]?.id ?? null`.
     - If `now && now !== before`: the commit landed before the reply/connection failed. Record `rec = { kind: "Committed", head: now }` (`recordStoreCommit` for `workBranch`, else `this.lastStoreCommit`) and return normally (do not block, do not keep mounted).
     - Otherwise: set `this.blocked = { reason: `${ce?.code ?? "Error"}: ${String(ce?.message ?? ce).slice(0, 200)}`, heldWs: ws }` and rethrow `ce`.
  5. In `withMountedBranch`:
     ```ts
     let value!: T;
     let fnErr: unknown = null;
     try { value = await fn(wsPath, ws); } catch (e) { fnErr = e; }
     if (commitAfter) {
       try {
         await this.commitWorkspaceOnce(ws, branch, fnErr ? `${message} (failed)` : message, message);
       } catch (ce) {
         keepMounted = true;
         fnErr ??= ce;
       }
     }
     if (fnErr) throw fnErr;
     return value;
     ```
- **Why not retry `workspace.commit` inside `withContentionRetry`**: `workspace.commit` mutates daemon mount state and is non-idempotent; reconciling `head` vs `before` and falling back to `this.blocked` (so `/minilfs retry` holds `ws`) matches the checkpoint state machine.

### Edge Cases
- `fn` succeeds, `workspace.commit` throws `Busy` (did not land): `commitWorkspaceOnce` runs once, sees `now === before`, sets `this.blocked`, keeps `ws` mounted, and throws `Busy` (never sends a second `"… (failed)"` commit).
- `fn` succeeds, `workspace.commit` lands in the worker but the reply is lost (`Unknown`): `commitWorkspaceOnce` sees `now !== before`, updates `headCommit`, unmounts cleanly, and returns `value`.

### Regression Test
- `tests/review-fixes.test.mjs`: mount-backed write (via a symlinked path in `writeFile` or `copyHostIntoBranch`) where `lfs.workspace.commit` is wrapped once to throw after forwarding (lost reply) and once to throw before forwarding (`Busy`): assert `workspace.commit` is called exactly once in both cases; the lost-reply case advances `headCommit` with `blocked === null`; the `Busy` case sets `s.blocked.heldWs` and leaves commit count unchanged. Fails before (calls `workspace.commit` twice).

---

## 4. S4 + S5 — Transactional Git Metadata Apply & Ref Namespace (D/F) Changes (Major)

### Decision
Replace the two-loop `writeGitLocked` (`src/workspace.ts:1833-1870`) with a 4-phase lock + D/F-ordered commit + pre-image rollback transaction, and ensure `applyLocked` (`src/workspace.ts:2079-2116`) marks `mainStale` whenever any host write or git metadata mutation was attempted before an error.

- **Why not `git update-ref --stdin`**: Verified on git 2.56.0 that `git update-ref --stdin` rejects D/F changes (`delete refs/heads/foo` + `create refs/heads/foo/bar`) in `prepare` (`fatal: prepare: cannot lock ref 'refs/heads/foo/bar': 'refs/heads/foo' exists`), and cannot apply raw `.git/packed-refs` or `.git/index` updates.
- **Exact rules for `writeGitLocked(cwd: string, items: GitWrite[]): Promise<string | null>`**:
  1. Partition `items` into `deletes = items.filter((i) => !i.next)` (sorted deepest path first: `b.rel.split("/").length - a.rel.split("/").length`) and `writes = items.filter((i) => i.next)` (sorted by `GIT_APPLY_ORDER[a.git] - GIT_APPLY_ORDER[b.git] || a.rel.split("/").length - b.rel.split("/").length || a.rel.localeCompare(b.rel)` so `ref` precedes `index` precedes `head`).
  2. Identify `deferredWrites`: writes in `writes` whose path is under a file being deleted (`deletes.some((d) => w.rel.startsWith(`${d.rel}/`))`, e.g. deleting `refs/heads/foo` and creating `refs/heads/foo/bar`). All other items are `initialLocks` (sorted by `rel`).
  3. **Phase 1 (Lock & snapshot pre-images)**: For each `it` in `initialLocks`:
     - `mkdir(dirname(target), { recursive: true })`, open `${target}.lock` with `"wx"`. On `EEXIST`, return `"${it.rel}.lock exists: git is running there"` (cleanup unlinks all `held` locks; nothing touched yet).
     - Read `raw = await readRawEntry(target)`. Convert to `now = raw === "other" ? "other" : raw ? ("target" in raw ? linkSig(raw.target) : fileSig(raw.data, raw.mode)) : null`. If `now === "other" || !sameSig(now, it.host)`, return `"${it.rel} changed"`.
     - Save `prev.set(it.rel, raw && "data" in raw ? raw : null)`.
     - If `it.next?.kind === "file"` and `!deletes.some((d) => d.rel.startsWith(`${it.rel}/`))`, write `it.next.data` and `chmod` to `${target}.lock`.
  4. **Phase 2 (Apply deletes, deepest first)**: For each `d` in `deletes`:
     - Record `touched.push(d.rel)`. `await fsp.rm(join(cwd, d.rel), { force: true })`.
     - If `d` is an ancestor of a write in `deferredWrites` or a descendant of a write in `writes` (e.g. `refs/heads/foo/bar` deleted while `refs/heads/foo` is written), unlink `${join(cwd, d.rel)}.lock` (removing it from `held`) and call `await removeEmptyGitRefParents(cwd, d.rel)` (removes empty directories up to `refs/heads`, `refs/tags`, `refs`, or the git dir).
  5. **Phase 3 (Lock deferred writes & writes that replaced a directory)**:
     - For each `w` in `deferredWrites`: `mkdir(dirname(target), { recursive: true })`, open `${target}.lock` with `"wx"`. If `EEXIST` or `await readRawEntry(target) !== null`, trigger rollback and return `"${w.rel} changed"`. Save `prev.set(w.rel, null)`, write `w.next.data` and `chmod` to `${target}.lock`.
     - For any write `w` in `initialLocks` that had a deleted descendant directory (`deletes.some((d) => d.rel.startsWith(`${w.rel}/`))`), verify `await readRawEntry(target) === null` (no untracked sibling ref left in that directory), and write `w.next.data` into its already-held `${target}.lock`. If a directory still remains at `target`, trigger rollback and return `"${w.rel} changed"`.
  6. **Phase 4 (Commit writes in order, then release remaining delete locks)**:
     - For each `w` in `writes`: record `touched.push(w.rel)`, `await fsp.rename(`${join(cwd, w.rel)}.lock`, join(cwd, w.rel))`, remove `${join(cwd, w.rel)}.lock` from `held`.
     - For any remaining `d` in `deletes`: unlink `${join(cwd, d.rel)}.lock` (if still in `held`) and call `await removeEmptyGitRefParents(cwd, d.rel)`.
  7. **Rollback (`rollback()`)**: On any conflict after Phase 2 begins or any thrown exception in Phases 2–4:
     - First unlink all remaining `held` `.lock` files.
     - For each `rel` in `touched.reverse()`:
       - Look up `old = prev.get(rel)`.
       - If `!old`: `await fsp.rm(join(cwd, rel), { force: true })` and `await removeEmptyGitRefParents(cwd, rel)`.
       - If `old`: `await fsp.rm(join(cwd, rel), { recursive: true, force: true })`, `await fsp.mkdir(dirname(join(cwd, rel)), { recursive: true })`, write `old.data` (mode `old.mode`) to a temp file in `dirname(join(cwd, rel))` and `rename` over `join(cwd, rel)`.
     - If an unexpected I/O exception triggered rollback, rethrow it after rollback; in `applyLocked` (`src/workspace.ts:2109-2115`), track `let hostTouched = false` (set to `true` before the `ordered` loop and before `writeGitLocked`) and call `if (result.applied.length || hostTouched) this.bindings.setMainStale(this.projectRecord.name, true)` in `catch`.

### Edge Cases
- `refs/heads/foo` (file) → `refs/heads/foo/bar` (file) and reverse `refs/heads/foo/bar` → `refs/heads/foo`.
- Mid-apply rename failure on the 2nd ref: 1st ref is restored to its exact `prev` bytes and mode; `mainStale` is set if any throw escapes.

### Regression Tests
- `tests/review-fixes.test.mjs`:
  1. **S5**: In the sandbox, delete branch `foo` and create branch `foo/bar` (and in a second apply, delete `foo/bar` and create `foo`); `apply()` succeeds both ways, host `git rev-parse refs/heads/foo/bar` and `refs/heads/foo` match, `git fsck` clean. Fails before (`ENOTDIR` / `EISDIR`).
  2. **S4**: Two branch refs changed (`refs/heads/a`, `refs/heads/b`); inject a failure on the second `fsp.rename` inside `writeGitLocked` (or hold `refs/heads/foo/bar.lock` during a D/F change after `foo` is unlinked): assert `refs/heads/a` (and `refs/heads/foo`) is rolled back to its original host oid, no `.lock` remains, and `mainStale` is `true` if `writeGitLocked` throws. Fails before.

---

## 5. S6 — Strict Git Object Type, Reachability Closure, Symbolic Refs & Sanitized Env (Major)

### Decision
Harden `gitObjectsMissing(cwd: string, meta: GitWrite[])` (`src/workspace.ts:1787-1825`) to validate object format, object types, symbolic ref targets, and commit/tag reachability closure under a sanitized environment.

- **Sanitized git environment (`cleanGitEnv(scratchHome: string): NodeJS.ProcessEnv`)**:
  ```ts
  const cleanGitEnv = (home: string): NodeJS.ProcessEnv => ({
    PATH: process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    TMPDIR: "/private/tmp",
    LANG: "C",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  });
  ```
  Never spread `process.env` (strips `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_INDEX_FILE`, `GIT_NAMESPACE`, `GIT_REPLACE_REF_BASE`). Always pass explicit `cwd` and `--git-dir <absGitDir> -c core.hooksPath=/dev/null -c core.fsmonitor=false`.
- **Exact validation rules per git dir `dir` (`absGitDir = join(cwd, dir)`)**:
  1. **Expected hash length**: Detect repo object format via `git --git-dir <absGitDir> rev-parse --show-object-format` (default `"sha1"` → 40 hex; `"sha256"` → 64 hex). Reject any oid whose length does not match `oidLen`.
  2. **Expected object types (`wantType: "commit" | "blob" | "any"`)**:
     - `g.git === "index"`: parse via `parseIndexEntries(g.next.data)` (S11). If `null`, return `"${g.rel} cannot be read"`. For each entry with `e.mode !== 0o160000`, require `e.oid` to have type `"blob"`.
     - `packed-refs`: for each non-empty, non-`#` line:
       - `<oid> <ref>`: require `isSafeRefName(ref)` and valid `oid`; if `ref.startsWith("refs/heads/") || ref === "HEAD" || /^refs\/minilfs\/[^/]+\/(heads\/|HEAD$)/.test(ref)`, require type `"commit"`, else `"any"`, and if `"commit" | "tag"` add `oid` to `newTips`.
       - `^<peeledOid>`: must immediately follow a `<tagOid> <ref>` line; require `<peeledOid>` to exist and match `<tagOid>^{}` (verified via `cat-file --batch-check` on `<tagOid>^{}`).
     - Loose ref or `HEAD`:
       - If `t.startsWith("ref:")`: must match `/^ref: (refs\/\S+)$/` with `isSafeRefName(target)`. Add `(g.rel, target)` to `symrefs`.
       - Else: must be an `oidLen`-hex oid. If `g.git === "head"` or `inner.startsWith("refs/heads/")` or `/^refs\/minilfs\/[^/]+\/(heads\/|HEAD$)/.test(inner)`, require type `"commit"`, else `"any"`; add to `newTips`.
  3. **Symbolic ref resolution check**:
     - For each `(rel, target)` in `symrefs`: follow up to 5 hops through `meta` (matching `dir` + inner ref path; if `meta` deletes that ref, it is absent) and then host loose ref / host `packed-refs`.
     - Reject a symref loop or chain > 5 hops.
     - For non-`HEAD` symrefs: target must resolve to an existing commit/object after `meta`.
     - For `HEAD` (`ref: refs/heads/<bName>`): if `refs/heads/<bName>` exists after `meta` (in `meta` or on host), it must resolve to a valid `"commit"`; if it does not exist (unborn branch), allow only when the host git dir has no commits at all (`git rev-list -n 1 --all` is empty) and `meta` adds no `refs/heads/*`.
  4. **Batch type check**: Run `git --git-dir <absGitDir> -c core.hooksPath=/dev/null -c core.fsmonitor=false cat-file --batch-check='%(objectname) %(objecttype)'` with `cleanGitEnv`. Reject if any object is `"missing"`, if a `"commit"`-required oid is not `"commit"`, if a `"blob"`-required oid is not `"blob"`, or if a peeled `^<oid>` does not match `<tagOid>^{}`.
  5. **Reachability / connectivity closure**: For all `commit` and `tag` oids in `newTips`, run:
     `git --git-dir <absGitDir> -c core.hooksPath=/dev/null -c core.fsmonitor=false rev-list --objects --missing=print --stdin`
     with input `[...newTips, "--not", "--all", ""].join("\n")` and `cleanGitEnv`.
     If `r.code !== 0` or any stdout line starts with `"?"`, return `"missing reachable objects in ${dir}: …"`.

### Edge Cases
- Blob or tree oid written to `.git/refs/heads/main` or detached `.git/HEAD`: rejected (`expected commit, got blob`).
- Commit object exists in `.git/objects`, but its parent commit or tree or blob is missing: `rev-list --objects --missing=print` outputs `?<oid>` and rejects.
- `process.env.GIT_OBJECT_DIRECTORY` set to an external dir containing the missing object: stripped by `cleanGitEnv`, so `gitObjectsMissing` still rejects.
- `.git/HEAD` written as `ref: refs/heads/nonexistent` in a repo with commits: rejected.

### Regression Test
- `tests/review-fixes.test.mjs`:
  1. Write the valid blob oid of `a.txt` into `.git/refs/heads/main` → `apply()` skips git metadata with warning, host ref unchanged.
  2. Write a synthesized commit object whose parent oid is `ab`.repeat(20) (missing) into `.git/objects` and `.git/refs/heads/main`, plus set `process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES` pointing to a temp object dir that has `ab`.repeat(20) → `apply()` still rejects the git metadata, host ref unchanged, `git fsck` clean.
  3. Write `ref: refs/heads/no-such-branch\n` into `.git/HEAD` → `apply()` skips git metadata with warning, host `HEAD` unchanged.

---

## 6. S7 — Process Identity Re-Check Before Every Signal & True µs Clock (Major)

### Decision
1. **`nowUs()` in `src/core/proc-scan.ts:62`**:
   Change `export const nowUs = () => Date.now() * 1000;` to:
   ```ts
   export const nowUs = () => Math.floor((performance.timeOrigin + performance.now()) * 1000);
   ```
   (gives microsecond resolution matching XNU's `microtime()` in `fork1`, without spawning a subprocess).
2. **Identity-verified signalling in `src/core/proc-scan.ts:78-84`**:
   Change `killAll` to accept identity rows and re-verify `(pid, startSec, startUsec)` via `procStartTime(r.pid)` immediately before each `process.kill`:
   ```ts
   export function killAll(rows: Array<Pick<ProcRow, "pid" | "startSec" | "startUsec">>, sig: NodeJS.Signals = "SIGKILL"): number {
     let n = 0;
     for (const r of rows) {
       if (r.pid <= 1 || r.pid === process.pid || r.pid === process.ppid) continue;
       const cur = procStartTime(r.pid);
       if (!cur || cur.startSec !== r.startSec || cur.startUsec !== r.startUsec) continue;
       try { process.kill(r.pid, sig); n++; } catch {}
     }
     return n;
   }
   ```
3. **Callers (`src/core/driver.ts`, `src/core/worker.ts`, `src/workspace.ts`)**:
   - `LocalNativeDriver.reapLeftovers` (`src/core/driver.ts:265-268`): pass `leftovers(rows, { pgid, sinceUs, roots })` directly to `killAll(...)` (preserving `{ pid, startSec, startUsec }`).
   - `LocalNativeDriver.reapWorkspaceHolders` (`src/core/driver.ts:302-319`): resolve each `lsof -t` pid with `procStartTime(n)` and signal via `killAll`.
   - `stopWorkerProcess` (`src/core/worker.ts:75-83`): check `if (!isWorkerProcess(e, dir)) return;` immediately before `process.kill(e.pid, "SIGTERM")` (since 6 s of ping retries elapsed since `ensureWorker` first checked `isWorkerProcess`), as well as before `SIGKILL`.

### Edge Cases
- A target process exits after `listOwnProcesses()` (or during the 6 s ping loop in `ensureWorker`) and its PID is reused by another process with a different `(startSec, startUsec)` before `killAll` / `stopWorkerProcess` signals: `procStartTime` / `isWorkerProcess` mismatches and no signal is sent.

### Regression Test
- `tests/elevate.test.mjs`: spawn a helper `sleep 60`, read its `row = procStartTime(pid)`, call `killAll([{ pid, startSec: row.startSec, startUsec: row.startUsec + 1 }])` → returns `0` and the process is still alive; then `killAll([row])` → returns `1` and stops it. Also assert `(nowUs() % 1000)` is not identically `0` across microsecond ticks.

---

## 7. S8 — Collision-Free, Validated Git Ref Rescues (`keepLosingGitRefs`) (Major)

### Decision
Update `keepLosingGitRefs` and `gitRefOid` (`src/workspace.ts:843-956`) to enforce repo-exact oid lengths, verify rescued objects exist with the right type in `target`, and use deterministic oid-qualified ref names on any collision.

- **Exact rules**:
  1. **Exact hash length (`oidLen`)**: Read `/.git/config` on `target` via `this.lfs.fs.read(target, "/.git/config", 1)`. Set `oidLen = /^\s*objectformat\s*=\s*sha256\s*$/im.test(cfg) ? 64 : 40` and `isOid = (s: string) => s.length === oidLen && /^[0-9a-f]+$/.test(s)`. Pass `oidLen` to `gitRefOid(branch, ref, oidLen = 40)` and the packed-refs / loose-ref readers (replacing `{40,64}`).
  2. **Verify rescued objects exist with valid type on `target`**:
     - Add `private async verifyBranchObjects(branch: string, checks: Array<{ oid: string; kind: "commit" | "any" }>): Promise<Set<string>>`:
       - Fast path (no mount): for each unique `oid`, read `/.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}` via `this.readBytesAtRef(branch, ...)`. If present, `zlib.inflateSync(buf)` and parse the header `<type> <size>\0`.
       - Fallback (for any `oid` not found loose, e.g. in a packfile): in one `withMountedBranch(branch, false, "check git objects", ...)` run `git --git-dir <wsPath>/.git cat-file --batch-check='%(objectname) %(objecttype)'` with `cleanGitEnv`.
       - Return the set of `oid`s that exist and satisfy `kind === "any" || type === "commit"`.
     - Filter `refs` and `lostHead` so only verified `oid`s are rescued (`refs/heads/*`, detached `HEAD`, and `refs/minilfs/*/heads/*` or `refs/minilfs/*/HEAD` require `"commit"`; `refs/tags/*` and `refs/minilfs/*/tags/*` require `"any"`).
  3. **Deterministic collision resolution (`allocateRescueRef`)**:
     - Build `existingRefs: Map<string, string>` of all refs on `target` (loose + `packed-refs`, read once).
     - Sort candidate rescues deterministically by source `ref` name, then `oid`.
     - For a candidate `(preferredRef, oid)`:
       - First check if `target` already has the exact same history recorded at `preferredRef` (`existingRefs.get(preferredRef) === oid`): if so, nothing to write.
       - For `ref.startsWith("refs/minilfs/")`: if `existingRefs.get(ref)` is absent, use `ref`; if `existingRefs.get(ref) === oid`, skip; if `existingRefs.get(ref)` is a **different** oid, do NOT drop it — allocate `${ref}-${oid.slice(0, 12)}` (or `${ref}-${oid}` if the 12-char prefix also collides with a different oid).
       - Apply the same collision rule to generated `refs/minilfs/${safeLabel}/heads/<name>`, `refs/minilfs/${safeLabel}/tags/<name>`, and `refs/minilfs/${safeLabel}/HEAD`: if `existingRefs.get(dst)` (or a prior entry in `existingRefs` from the current batch) holds a different oid, qualify `dst` as `${dst}-${oid.slice(0, 12)}` (falling back to `${dst}-${oid}`), and record `existingRefs.set(chosenDst, oid)`.

### Edge Cases
- Two merges from branches with the same `safeLabel` or a 3-way cascade (`w1 -> w2`, then `w1` commits again and `w1 -> lead` after `w2 -> lead`) where `refs/minilfs/<label>/heads/feat` already exists on `target` at an older commit: the newer commit is kept at `refs/minilfs/<label>/heads/feat-<oid12>` instead of overwriting or being dropped.
- A corrupt/42-hex or dangling loose ref written by a tool in the losing branch: skipped by `isOid` / `verifyBranchObjects`.

### Regression Test
- `tests/review-fixes.test.mjs`:
  1. `w1` commits `c1` on `feat`; `lead` merges `w1` (creates `refs/minilfs/<w1>/heads/feat` at `c1`). Then `w2` has `refs/minilfs/<w1>/heads/feat` pointing at a different commit `c2` (plus its own commit on `main`) and `lead` merges `w2`: assert BOTH `c1` (`refs/minilfs/<w1>/heads/feat`) and `c2` (`refs/minilfs/<w1>/heads/feat-${c2.slice(0, 12)}`) exist on `lead`.
  2. `w2` also has a bogus 42-hex ref and a dangling 40-hex ref `refs/heads/ghost` (no object): assert neither is copied into `lead`, and `git fsck` on `lead` is clean. Fails before.

---

## 8. S9 — Submodule Git Directory Boundary Resolution (`gitDirOf`) (Major)

### Decision
Update `innerOfGitDir` and `gitDirOf(rel: string, cwd?: string)` in `src/gitpaths.ts:103-122` (and pass `cwd` from `gitObjectsMissing` in `src/workspace.ts:1790`) so nested submodule git dirs whose names contain `/` or git-like tokens (e.g. `.git/modules/a/refs/refs/heads/main`) resolve to the true submodule git dir.

- **Exact rules (`src/gitpaths.ts`)**:
  1. Add ` candidateGitDirs(g: { dir: string; inner: string }): Array<{ gitDir: string; tail: string }>`:
     - If `BODY_RX.test(g.inner)`, include `{ gitDir: g.dir, tail: g.inner }`.
     - If `g.inner.startsWith(" worktrees/")`: match `^worktrees/([^/]+)/(.+)$`; if the remainder matches `BODY_RX`, include `{ gitDir: `${g.dir}/worktrees/${id}`, tail }`.
     - If `g.inner.startsWith("modules/")`: split `g.inner` on `"/"`. For every split point `k >= 2` where `tail = parts.slice(k).join("/")` matches `BODY_RX`, include `{ gitDir: `${g.dir}/${parts.slice(0, k).join("/")}`, tail }`.
  2. **Layout check when `cwd` is provided**:
     A candidate `gitDir` has a git-dir layout on disk iff `join(cwd, gitDir, "HEAD")` is a file and `join(cwd, gitDir, "objects")` and `join(cwd, gitDir, "refs")` are directories (`statSync` / `lstatSync`). Among candidates matching on-disk layout, return the one with the longest `gitDir` (most specific nested submodule).
  3. **Lexical fallback (when `cwd` is omitted or no candidate exists on disk yet)**:
     Exclude candidates where the last segment of `gitDir` is `"logs"`, `"objects"`, `"info"`, or `"lfs"` when a shorter candidate exists (so `modules/x/logs/refs/heads/main` stays in `modules/x` with tail `logs/refs/heads/main`); otherwise pick the candidate whose `tail` is NOT `refs/refs/...` (preferring canonical tails `HEAD`, `index`, `packed-refs`, `refs/heads/...`, `refs/tags/...`, `refs/remotes/...`, `objects/...`, `logs/...`, i.e. longest `gitDir` whose last segment is not `"logs"`).

### Edge Cases
- Submodule named `a/refs` (`.git/modules/a/refs/refs/heads/main`): layout check sees `HEAD`, `objects/`, `refs/` inside `.git/modules/a/refs` and returns `.git/modules/a/refs`.
- Reflog inside submodule `x` (`.git/modules/x/logs/refs/heads/main`): `.git/modules/x/logs` has no `HEAD`/`objects/`, so both layout and lexical fallback return `.git/modules/x`.

### Regression Test
- `tests/elevate.test.mjs`: create `.git/modules/a/refs/{HEAD,objects,refs}` on disk in a temp dir; assert `gitDirOf(".git/modules/a/refs/refs/heads/main", tmp)` and `gitDirOf(".git/modules/a/refs/refs/heads/main")` both equal `".git/modules/a/refs"`, while `gitDirOf(".git/modules/x/logs/refs/heads/main", tmp)` equals `".git/modules/x"`. Fails before (returns `".git/modules/a"`).

---

## 9. S10 — Restore Original `.git/index` on Join Failure (Major)

### Decision
In `GIT_JOIN_SCRIPT` (`src/gitjoin.ts:62-72`), save a byte-exact copy of `.git/index` before running `g read-tree "$new"`, and restore it if `read-tree` or `update-ref` fails.

- **Exact script change (`src/gitjoin.ts:62-72`)**:
  ```sh
  if [ "$new" != "$cur" ]; then
    orig_idx=$(mktemp "/tmp/minilfs-join-orig-index.XXXXXX") || { echo "JOIN fail mktemp"; exit 0; }
    had_idx=0
    if [ -f .git/index ]; then
      cp -p .git/index "$orig_idx" || { rm -f "$orig_idx"; echo "JOIN fail backup-index"; exit 0; }
      had_idx=1
    fi
    if ! g read-tree "$new"; then
      rm -f "$orig_idx"
      echo "JOIN fail read-tree"; exit 0
    fi
    if ! g update-ref -m "minilfs: $MSG" "$BRANCH" "$new" $cur; then
      if [ "$had_idx" -eq 1 ]; then cp -p "$orig_idx" .git/index 2>/dev/null || true; else rm -f .git/index; fi
      rm -f "$orig_idx"
      echo "JOIN fail update-ref"; exit 0
    fi
    rm -f "$orig_idx"
    g update-index -q --refresh >/dev/null 2>&1 || true
  fi
  ```
- **Why not `g read-tree "$cur"`**: `read-tree "$cur"` resets the index to `HEAD`'s tree and destroys any pre-existing staged changes (`git add`) that were in `.git/index` before the join.

### Edge Cases
- `.git/refs/heads/main.lock` held while `.git/index` has staged changes (`staged.txt` added before the join): `read-tree "$new"` succeeds, `update-ref` fails on `main.lock`, `.git/index` is restored from `$orig_idx`, and `git diff --cached --name-only` still lists `staged.txt`.

### Regression Test
- `tests/elevate.test.mjs`: in a conflicted repo, stage an extra file (`echo staged > staged.txt && git add staged.txt`), hold `.git/refs/heads/main.lock`, run `joinIn(d, ours, theirs)`: assert `r.mode === "fail"`, `refs/heads/main` is still `ours`, and `sh(d, "git diff --cached --name-only")` is `"staged.txt"`. Fails before (`staged.txt` is unstaged by `read-tree "$cur"`).

---

## 10. S11 — Structured Index Entries & Empty Index Support (Minor)

### Decision
Add `parseIndexEntries(buf: Buffer): IndexEntry[] | null` in `src/gitpaths.ts:190-264` (exported via `src/core/index.ts`), fix the `if (out)` truthiness bug on empty indexes (`count === 0`), hash NUL-delimited entries in `gitSig`, and iterate structured entries in `gitObjectsMissing`.

- **Signatures (`src/gitpaths.ts`)**:
  ```ts
  export interface IndexEntry { mode: number; oid: string; stage: number; flags: number; path: string }
  export function parseIndexEntries(buf: Buffer): IndexEntry[] | null
  export function indexEntries(buf: Buffer): string | null
  ```
- **Exact rules**:
  1. `parseEntries(buf, version, count, hashLen)` returns `IndexEntry[] | null`: each entry is `{ mode, oid, stage: (flags >> 12) & 3, flags: ext & 0x6000, path: name }`. When `count === 0` and the checksum trailer is at `pos === end`, it returns `[]`.
  2. `parseIndexEntries(buf)` loops `for (const hashLen of [20, 32]) { const out = parseEntries(buf, version, count, hashLen); if (out !== null) return out; } return null;`.
  3. `indexEntries(buf)` calls `const out = parseIndexEntries(buf); return out === null ? null : out.map((e) => `${e.mode.toString(8)} ${e.oid} ${e.stage} ${e.flags} ${e.path}`).join("\n");` (returns `""` instead of `null` for an empty index, keeping `tests/elevate.test.mjs:214` working).
  4. `gitSig("index", entry)` calls `const e = parseIndexEntries(entry.data); if (e !== null) return "index:" + createHash("sha256").update(e.map((x) => `${x.mode.toString(8)} ${x.oid} ${x.stage} ${x.flags} ${x.path}\0`).join("")).digest("hex");`.
  5. `gitObjectsMissing` (`src/workspace.ts:1794-1800`) calls `parseIndexEntries(g.next.data)` and adds `e.oid` (with expected type `"blob"`) when `e.mode !== 0o160000`.

### Edge Cases
- Empty index (`git rm -rf .` or `git read-tree --empty`, `count === 0`): `parseIndexEntries` returns `[]`, `indexEntries` returns `""`, `gitSig` returns `"index:<sha256>"`, and `apply()` applies the empty index without warning `".git/index cannot be read"`.
- Index containing a path with `\n` (`"line1\n100644 deadbeef... fake"`): `parseIndexEntries` keeps the full path in `e.path` and the real 40-hex blob oid in `e.oid`.

### Regression Test
- `tests/elevate.test.mjs`:
  1. Run `git read-tree --empty` in a test repo; assert `core.parseIndexEntries(buf)` is `[]`, `core.indexEntries(buf)` is `""` (not `null`), and `core.gitSig("index", { data: buf, mode: 0o644 })` starts with `"index:"`.
  2. Stage a file named `"line1\n100644 " + "f".repeat(40) + " 0 0 bogus"`; assert `core.parseIndexEntries(buf)` has length 1 with the real blob oid, and `apply()` does not see `"f".repeat(40)` as a missing object. Fails before.

---

## 11. S12 — Neutralize All Git Attribute & Driver Sources in `GIT_JOIN_SCRIPT` (Minor)

### Decision
In `GIT_JOIN_SCRIPT` (`src/gitjoin.ts:24-26`), set `export GIT_ATTR_NOSYSTEM=1`, pass `-c core.attributesFile=/dev/null` and `-c attr.tree="$EMPTY"`, and override every configured `filter.*` and `merge.*` driver key in `.git/config` (including any `include.path` files) on the command line so even `.git/info/attributes` (which has higher precedence than `attr.tree` in git) cannot trigger any clean, smudge, process, or merge driver.

- **Exact script change (`src/gitjoin.ts:24-26`)**:
  ```sh
  export GIT_ATTR_NOSYSTEM=1
  EMPTY=$(git hash-object -t tree /dev/null) || { echo "JOIN fail empty-tree"; exit 0; }
  DRV=(-c core.hooksPath=/dev/null -c core.fsmonitor=false -c gc.auto=0 -c maintenance.auto=false -c advice.detachedHead=false -c core.attributesFile=/dev/null -c attr.tree="$EMPTY" -c core.autocrlf=false)
  while IFS= read -r k; do
    [ -n "$k" ] || continue
    case "$k" in
      filter.*.required) DRV+=(-c "$k=false") ;;
      filter.*) DRV+=(-c "$k=") ;;
      merge.*.driver) DRV+=(-c "$k=false") ;;
    esac
  done < <(git config --includes --name-only --get-regexp '^(filter|merge)\.' 2>/dev/null || true)
  g() { git "${DRV[@]}" "$@"; }
  ```
- **Why this over a temporary `GIT_DIR` overlay**: A symlinked `GIT_DIR` overlay causes `git read-tree` and `git update-ref` to rename `.lock` files over the symlinks in `/tmp` rather than updating `.git/index` and `.git/refs` in the Workspace, whereas disabling `filter.*` and `merge.*` via `-c` plus `GIT_ATTR_NOSYSTEM=1`, `core.attributesFile=/dev/null`, and `attr.tree="$EMPTY"` neutralizes `.git/info/attributes`, `core.attributesFile`, `/etc/gitattributes`, and `.gitattributes` while still letting `mode=worktree` joins succeed.

### Edge Cases
- `.git/info/attributes` has `* filter=pwn merge=pwn`, `core.attributesFile` points to a file with `* filter=pwn`, and `.git/config` has `filter.pwn.clean`, `filter.pwn.process`, `filter.pwn.required=true`, and `merge.pwn.driver`: `merge-tree` treats the custom merge driver as a conflict (`rc=1`), `update-index --add` runs no clean/process filter, and the join succeeds with `mode: "worktree"`.

### Regression Test
- `tests/elevate.test.mjs` (extend the R13 step at `tests/elevate.test.mjs:332-338`): write `* filter=pwn merge=pwn` into `.git/info/attributes` AND into a file referenced by `git config core.attributesFile`, plus `git config filter.pwn.required true` and `git config merge.pwn.driver "touch ${marker}"`. Run `joinIn(d, ours, theirs)`: assert `r.mode === "worktree"` and `existsSync(marker) === false`. Fails before (`marker` is created via `.git/info/attributes`).

---

## 12. S13 — Verify Start Time Even When `s.pid === process.pid` (`sessionAlive`) (Minor)

### Decision
In `sessionAlive` (`src/workspace.ts:2273-2283`), remove the early `if (s.pid === process.pid) return true;` shortcut that bypassed `pidStartSec`/`pidStartUsec` verification, and export `sessionAlive`.

- **Exact function (`src/workspace.ts:2273-2283`)**:
  ```ts
  export function sessionAlive(s: SessionBinding): boolean {
    if (!s.pid) return false;
    if (s.host && s.host !== hostname()) return true;
    if (s.pid !== process.pid && !alive(s.pid)) return false;
    // a recorded start time tells the session's process from a later one that reused its pid
    if (s.pidStartSec === undefined) return true;
    const p = procStartTime(s.pid);
    return !p || (p.startSec === s.pidStartSec && p.startUsec === s.pidStartUsec);
  }
  ```
  (Keeps the exact signature shape expected by `tests/elevate.test.mjs:346` while checking `procStartTime(process.pid)` whenever `s.pidStartSec !== undefined`.)

### Edge Cases
- A stale session binding in `bindings.json` whose `pid` happens to equal the current `process.pid` (PID reuse) with an older `(pidStartSec, pidStartUsec)`: `sessionAlive` returns `false`, so the dead session cannot shadow a new session's alias.
- A live session of the current process (`s.pid === process.pid` with matching `ownStart()` or `pidStartSec === undefined`): `sessionAlive` returns `true`.

### Regression Test
- `tests/elevate.test.mjs`: call `ws.sessionAlive({ pid: process.pid, host: hostname(), pidStartSec: 1, pidStartUsec: 0 })` → assert `false`; call with current `procStartTime(process.pid)` `(startSec, startUsec)` → assert `true`. Fails before (returned `true` for `pidStartSec: 1`).

---

## 13. Commit-Sized Ordered Plan & Verification Suite

1. **Commit 1 — S1 + S2 (`src/seatbelt.ts`, `src/workspace.ts`, `tests/elevate.test.mjs`)**:
   Kernel-enforced outside-read subprocess under Seatbelt (`runOutsideRead` + `extraDenyRoots` for `config.bundle`), plus TOCTOU and APFS case-variant regression tests in `tests/elevate.test.mjs`.
2. **Commit 2 — S3 (`src/workspace.ts`, `tests/review-fixes.test.mjs`)**:
   `commitWorkspaceOnce` in `withMountedBranch` and `execOnce`: single `workspace.commit` call, `before` vs `now` head reconciliation on uncertain failure, session blocking on unlanded commit.
3. **Commit 3 — S4 + S5 (`src/workspace.ts`, `tests/review-fixes.test.mjs`)**:
   4-phase `writeGitLocked` with D/F ref deletion/creation ordering, pre-image rollback on mid-apply failure, and unconditional `setMainStale(true)` when host/git writes were attempted before a throw.
4. **Commit 4 — S6 + S9 + S11 (`src/gitpaths.ts`, `src/core/index.ts`, `src/workspace.ts`, `tests/elevate.test.mjs`, `tests/review-fixes.test.mjs`)**:
   Structured `parseIndexEntries` + empty-index support (S11), layout-aware `gitDirOf` for nested submodules (S9), and strict `gitObjectsMissing` object-type, `rev-list --objects --missing=print` closure, symref check, and `cleanGitEnv` (S6).
5. **Commit 5 — S8 + S10 + S12 (`src/gitjoin.ts`, `src/workspace.ts`, `tests/elevate.test.mjs`, `tests/review-fixes.test.mjs`)**:
   Deterministic oid-qualified rescue refs + repo-exact hash length + object verification in `keepLosingGitRefs` (S8), original `.git/index` backup/restore in `GIT_JOIN_SCRIPT` (S10), and full attribute/driver neutralization including `.git/info/attributes` (S12).
6. **Commit 6 — S7 + S13 (`src/core/proc-scan.ts`, `src/core/driver.ts`, `src/core/worker.ts`, `src/workspace.ts`, `tests/elevate.test.mjs`)**:
   Microsecond `nowUs()`, start-time re-verification before every signal in `killAll` / `stopWorkerProcess` (S7), and start-time check for `s.pid === process.pid` in `sessionAlive` (S13).

### Re-Run List (must all pass with zero leftover daemons/workers/sleeps)
- `node tests/elevate.test.mjs`
- `node tests/store-contention.test.mjs`
- `node tests/native-seatbelt.test.mjs`
- `node tests/review-fixes.test.mjs`
- `node tests/backend.test.mjs`
- `node tests/orphan-mount.test.mjs`
- `node tests/concurrent-start.test.mjs`
- `node tests/cli.test.mjs`
- `node tests/rpc.test.mjs`
- `node tests/pi.test.mjs`
- `node tests/scale.test.mjs`
- `node tests/worker-mount.test.mjs` (or worker-mount smoke)
