# Spec: third-round fixes F1–F7 and m (2026-10-27)

Designed by gemini-4-argon from `docs/issues/quarry-run-2026-10-27.md` §8. Implementer: where a line
number or name disagrees with the code, the code wins; keep the intent. Corrections noted here:
- F4 `killAll`: one `procStartTime` per pid spawns one python each; keep the batch read but do it
  immediately before the kills of that call (one lookup, then signal only matching rows) — a
  per-pid python call is too slow when many holders exist. Recheck happens within the same call.
- The recovery folder uses the project name, not a global; `RecoveryPending` must name it.

# Implementation Spec: Third-Round Review Fixes F1–F7 & Minor `m` (2026-10-27)

Context: addresses findings F1–F7 and `m` in `docs/issues/quarry-run-2026-10-27.md:247-261` (§8, reviewing `757155a..fe7746d` / `docs/specs/review-fixes-2-2026-10-27.md`).

---

## 1. F1 + F2 — Reduced-Window, Total, CAS-Safe `writeGitLocked` Rollback & Recovery (`src/workspace.ts:2892-2986`, `src/bindings.ts:6-17,208`)

### Design
1. **Guard `applyLocked` on pending recovery (`src/workspace.ts:2079-2085`, `src/bindings.ts:10-16`)**:
   - Add `recoveryDir?: string | null` to `ProjectRecord` (`src/bindings.ts:6-17`) and `setRecoveryDir(name: string, dir: string | null): void` on `BindingStore` (`src/bindings.ts:208`).
   - At the start of `applyLocked` (`src/workspace.ts:2079`), before `withProjectLock` or inside it before forking `snapBranch`:
     ```ts
     const recDir = this.bindings.byName(this.projectRecord.name)?.recoveryDir;
     if (recDir && existsSync(recDir)) {
       throw new LayerfsError(
         "RecoveryPending",
         `a previous apply could not finish rolling back git metadata; preimages are saved in ${recDir} — restore or remove that folder before applying again`,
       );
     }
     ```
2. **Reduce the mutation window in `writeGitLocked` (`src/workspace.ts:2892-2986`)**:
   - Partition `items` into `deletes` (`!i.next`, sorted deepest-first) and `writes` (`i.next`, sorted by `GIT_APPLY_ORDER`, depth, `rel`).
   - Split `deletes` into:
     - `blockingDeletes`: deletes that block a `deferred` write (`writes.some((w) => below(w.rel, d.rel))`) or empty a directory for an `overDir` write (`overDir.some((w) => below(d.rel, w.rel))`).
     - `plainDeletes`: all other deletes (`deletes.filter((d) => !blockingDeletes.has(d))`).
   - **Rule**: `plainDeletes` are locked in Phase 1 (`${d.rel}.lock` held, preimage recorded in `prev`) but are **not unlinked until Phase 4** (after every lock is held and every `.lock` payload is written). When `blockingDeletes.size === 0` (the common case), Phases 1–3 make **zero mutations to target refs/HEAD/index**, so any lock contention or host-drift check before Phase 4 simply unlinks `held` locks and `rmdir`s `createdDirs` without needing rollback.
3. **Track every created directory, lock, preimage, and installed value**:
   - `held = new Set<string>()` (absolute `.lock` paths currently held).
   - `createdDirs: string[] = []` (relative paths of directories created by this transaction, recorded shallowest-to-deepest via helper `ensureDir(relDir: string)` that walks components and calls `fsp.mkdir(join(cwd, cur))`, pushing `cur` to `createdDirs` when newly created).
   - `prev = new Map<string, { data: Buffer; mode: number } | null>()` (preimage for every locked path).
   - `unlinked = new Set<string>()` (`rel` of files unlinked in Phase 2 or Phase 4).
   - `installed = new Map<string, { data: Buffer; mode: number }>()` (`rel` → exact `{ data, mode }` renamed into place in Phase 4).
4. **Total, deepest-first, CAS-safe `rollback()`**:
   ```ts
   type GitLockOutcome = { blocked: string | null; warnings: string[] };
   async function writeGitLocked(cwd: string, items: GitWrite[], recoveryRoot: string, layout?: GitLayout): Promise<GitLockOutcome>
   ```
   When a check fails after `unlinked.size > 0 || installed.size > 0` or an exception is thrown:
   - **Step A**: Unlink every lock in `held` (`fsp.rm(l, { force: true })`) and `held.clear()`.
   - **Step B**: Remove transaction-created directories deepest-first:
     ```ts
     for (const d of [...createdDirs].sort((a, b) => depth(b) - depth(a))) {
       await fsp.rmdir(join(cwd, d)).catch(() => {});
     }
     ```
     Because `deferred` `.lock` files were unlinked in Step A, `foo/deep` and `foo` are now empty and removed before restoring file `foo` (closes F1).
   - **Step C**: Compute `targets = [...new Set([...installed.keys(), ...unlinked])].sort((a, b) => depth(b) - depth(a))` (deepest-first). Track `hostKept: string[] = []` and `unrecovered: Array<{ rel: string; err: string }> = []`.
   - For each `rel` in `targets`:
     - `target = join(cwd, rel)`, `lock = "${target}.lock"`, `old = prev.get(rel) ?? null`, `put = installed.get(rel)`.
     - Try:
       - If `put` (was renamed by Phase 4):
         - Re-acquire `lock` (`fsp.open(lock, "wx", 0o600)`). On `EEXIST`, push `rel` to `hostKept` and continue (host git holds the lock).
         - Read `cur = await readRawEntry(target)` under `lock`.
         - **CAS check**: if `cur === null || cur === "other" || !("data" in cur) || !cur.data.equals(put.data) || (cur.mode & 0o7777) !== (put.mode & 0o7777)`, the host updated `rel` after our rename — close/unlink `lock`, push `rel` to `hostKept`, and leave the host's value untouched (closes F2).
         - If `old === null`: `await fsp.rm(target, { force: true })`, close/unlink `lock`, and `await removeEmptyGitRefParents(cwd, rel, layout)`.
         - If `old !== null`: write `old.data` (mode `old.mode`) to `lock`, `chmod(old.mode)`, close, and `await fsp.rename(lock, target)`.
       - Else (`rel` was only in `unlinked`, e.g. a Phase 2 `blockingDelete`):
         - If `!old`, continue.
         - If `(await fsp.lstat(target).catch(() => null))?.isDirectory()`, `await fsp.rmdir(target)`.
         - `await fsp.mkdir(dirname(target), { recursive: true })`.
         - Acquire `lock` (`wx`). On `EEXIST`, push `rel` to `hostKept` and continue.
         - If `(await readRawEntry(target)) !== null` (host created `rel` meanwhile), close/unlink `lock`, push `rel` to `hostKept`, and continue.
         - Write `old.data` (mode `old.mode`) to `lock`, `chmod(old.mode)`, close, and `await fsp.rename(lock, target)`.
     - Catch `err`: ensure `lock` is unlinked if we created it, and push `{ rel, err: String(err?.message ?? err) }` to `unrecovered`.
   - **Step D**: Run a final deepest-first pass over `createdDirs` (`fsp.rmdir`, ignoring errors).
   - **Step E (Recovery folder on incomplete rollback)**:
     - If `unrecovered.length > 0`:
       - Create `recDir = join(recoveryRoot, "${projectName}-${Date.now()}")` (`<config.root>/recovery/<project>-<ts>`).
       - For every `[rel, val]` in `prev.entries()`, if `val !== null`, write `val.data` (mode `val.mode`) to `join(recDir, "preimages", rel)`.
       - Write `join(recDir, "manifest.json")` with `{ project: projectName, cwd, at: Date.now(), unrecovered, hostKept, absentBefore: [...prev.entries()].filter(([, v]) => v === null).map(([k]) => k) }`.
       - Call `this.bindings.setMainStale(this.projectRecord.name, true)` and `this.bindings.setRecoveryDir(this.projectRecord.name, recDir)`.
       - Throw `new LayerfsError("RollbackIncomplete", "git rollback could not restore " + unrecovered.map((u) => u.rel).join(", ") + "; preimages saved in " + recDir)`.
   - If `hostKept.length > 0`, append warning `"host updated ${hostKept.join(", ")} during git rollback; kept host value"`.

### Edge Cases
- `refs/heads/foo` (file) → `refs/heads/foo/deep/bar` (file) where locking `foo/deep/bar` fails (`EEXIST`): `createdDirs` has `["refs/heads/foo", "refs/heads/foo/deep"]`; Step B removes `foo/deep` then `foo`; Step C restores file `refs/heads/foo`.
- `refs/heads/a` renamed to `c2`, then `refs/heads/b` rename throws `ENOSPC`, and before rollback locks `a`, host updates `refs/heads/a` to `c3`: CAS sees `c3 !== c2`, keeps `c3`, and reports `refs/heads/a` in `warnings`.

### Regression Test
- `tests/review-fixes.test.mjs`:
  1. **F1**: Branch deletes `refs/heads/foo` and creates `refs/heads/foo/deep/bar`; pre-create `.git/refs/heads/foo/deep/bar.lock` on host right when `foo` is unlinked (or via `fsp.open` hook on `bar.lock`). Assert `apply()` leaves `refs/heads/foo` intact with its original oid and `.git/refs/heads/foo/deep` removed. Fails before (`foo` stays a directory containing `deep`, original `foo` lost).
  2. **F2 + recovery**: Branch updates `refs/heads/a` and `refs/heads/b`. Hook `fsp.rename` on `refs/heads/b` to first write a new host commit `cHost` into `.git/refs/heads/a` and then throw `ENOSPC`. Assert `refs/heads/a` retains `cHost` (not overwritten with `c1`) and `mainStale` is `true`. Second subcase: also make restoring `refs/heads/a` fail with `EIO`; assert `<root>/recovery/<project>-*` exists with `preimages/.git/refs/heads/a` and `manifest.json`, and a subsequent `s.apply()` rejects with `code === "RecoveryPending"` naming that recovery folder. Fails before.

---

## 2. F3 — Unified `expectedType(inner)` Across Direct, Symbolic, Packed & Rescued Refs (`src/gitpaths.ts`, `src/workspace.ts:886-889,2766-2863`)

### Design
1. Export `expectedType(inner: string): "commit" | "any"` from `src/gitpaths.ts` (and re-export from `src/core/index.ts`):
   ```ts
   export function expectedType(inner: string): "commit" | "any" {
     return inner === "HEAD" || inner.startsWith("refs/heads/") || /^refs\/minilfs\/[^/]+\/(heads\/|HEAD$)/.test(inner)
       ? "commit"
       : "any";
   }
   ```
2. Replace `wantsCommit` (`src/workspace.ts:2766`) and `needsCommit` (`src/workspace.ts:886`) with `expectedType(inner)`:
   - **Direct loose refs** (`src/workspace.ts:2835`): `need(t, expectedType(inner))`.
   - **`packed-refs`** (`src/workspace.ts:2822`): `need(m[1], expectedType(m[2]))`.
   - **Rescued refs** (`src/workspace.ts:886-888`): `const verified = (ref: string, oid: string) => { const t = types.get(oid); return Boolean(t) && (expectedType(ref) === "any" || t === "commit"); };`.
   - **Symbolic refs at any depth** (`src/workspace.ts:2769-2787, 2850-2861`):
     Update `resolveRefAfter` to return `{ oid: string; chain: string[] } | null | "loop"` where `chain` contains the starting `inner` (`symref` source) and every intermediate/final ref target `name` visited across up to 5 hops.
     In `gitObjectsMissing` (`src/workspace.ts:2850-2861`):
     ```ts
     const reqCommit = [inner, ...r.chain].some((refName) => expectedType(refName) === "commit");
     need(r.oid, reqCommit ? "commit" : "any");
     d.tips.add(r.oid);
     if ([inner, ...r.chain].some((refName) => refName.startsWith("refs/heads/"))) d.addsHeads = true;
     ```

### Edge Cases
- `refs/heads/x` is `ref: refs/tags/blob` (1 hop) or `refs/tags/sym1 -> refs/heads/y -> refs/tags/blob` (2 hops): `expectedType` on the chain sees a branch ref and requires `"commit"`, rejecting the blob.

### Regression Test
- `tests/review-fixes.test.mjs`: Create a tag `refs/tags/tblob` pointing directly to the blob oid of `a.txt`, and write `ref: refs/tags/tblob\n` into `.git/refs/heads/symbranch` in the Branch. Run `s.apply()`: assert `ap.warnings` matches `/is a blob, not a commit/` and `.git/refs/heads/symbranch` is not created on the host. Fails before (`symbranch` is applied pointing to a blob).

---

## 3. F4 — Fail-Closed Holder Verification & Single-Call Per-Signal Check (`src/core/proc-scan.ts:60-104`, `src/core/driver.ts:299-314`, `src/workspace.ts:1304-1327`)

### Current Unmount Path Behavior (`src/workspace.ts:1304-1327`, `1511-1513`)
Today `releaseWorkspace` calls `this.reapHolders(wsReal).catch(() => {})` (`src/workspace.ts:1305`), then attempts `lfs.workspace.unmount(ws, false)` (`src/workspace.ts:1310`). If the mount is busy, it logs `"unmount <path> refused; retrying with discard"` (`src/workspace.ts:1315`), runs `reapHolders` again, and retries `lfs.workspace.unmount(ws, true)`. If `unmount` still fails (`err !== null`), it logs `"forcing the OS unmount"` (`src/workspace.ts:1321`), runs `forceUnmount(wsReal)` (`/sbin/umount -f`, `src/workspace.ts:3201-3206`), and **keeps the mount lease on disk** (`if (!err) this.leases?.remove(ws.path, owner)` at `src/workspace.ts:1326`) so future sessions retry via `reclaimOrphanMounts`.

### Design
1. **Fail closed when holder identity cannot be verified (`src/core/driver.ts:299-314`, `src/workspace.ts:1511-1513`)**:
   - In `LocalNativeDriver.reapWorkspaceHolders(wsReal: string)` (`src/core/driver.ts:299-314`):
     - Remove the `else for (const n of pids) try { process.kill(n, "SIGKILL"); } catch {}` fallback (`src/core/driver.ts:311`).
     - Call `const rows = procStartTimes(pids)`.
     - If `!rows` or any `pid` in `pids` is missing from `rows` (unless `!alive(pid)` — i.e., if a live pid has no verified `ProcRow`): do **not** signal that pid. If `!rows`, throw `new Error("holders could not be verified")` after checking any remaining spellings.
   - In `LayerfsSession.reapHolders` (`src/workspace.ts:1511-1513`):
     ```ts
     private async reapHolders(wsPath: string): Promise<void> {
       await this.driver.reapWorkspaceHolders?.(wsPath).catch((e: any) => {
         this.log(`${e?.message ?? e} (${wsPath})`);
       });
     }
     ```
     `releaseWorkspace` then proceeds through its existing `unmount(ws, false)` → `unmount(ws, true)` → `forceUnmount` + retained lease flow.
2. **Per-signal check with a single-call window (`src/core/proc-scan.ts:95-104`)**:
   - In `killAll(rows, sig)` (`src/core/proc-scan.ts:95-104`), re-read each target pid's start time immediately before signalling that pid (never reusing a batch snapshot across multiple `kill` calls):
     ```ts
     export function killAll(rows: Array<Pick<ProcRow, "pid" | "startSec" | "startUsec">>, sig: NodeJS.Signals = "SIGKILL"): number {
       const targets = rows.filter((r) => r.pid > 1 && r.pid !== process.pid && r.pid !== process.ppid);
       let n = 0;
       for (const r of targets) {
         const cur = procStartTime(r.pid);
         if (!cur || cur.startSec !== r.startSec || cur.startUsec !== r.startUsec) continue;
         try { process.kill(r.pid, sig); n++; } catch {}
       }
       return n;
     }
     ```

### Edge Cases
- `/usr/bin/python3` missing or times out (`procStartTimes` returns `null`): zero processes are signalled; `reapWorkspaceHolders` throws `"holders could not be verified"`, `reapHolders` logs it, and `releaseWorkspace` falls back to `unmount(..., true)` / `umount -f`.

### Regression Test
- `tests/elevate.test.mjs`: Spawn a live helper `sleep 600`. Stub or run `reapWorkspaceHolders` with a fake mount path where `lsof` returns the helper's `pid` and `python3` lookup is forced to fail (e.g. via a testable lookup seam or `procStartTimes` returning `null`): assert `reapWorkspaceHolders` rejects with `/holders could not be verified/` and the helper process is still alive (`child.signalCode === null`). Fails before (`reapWorkspaceHolders` SIGKILLs the bare pid).

---

## 4. F5 — Total, Namespace-Aware Rescue Ref Allocator (`src/gitpaths.ts`, `src/workspace.ts:882-914`)

### Design
1. Export `allocateRescueRef` in `src/gitpaths.ts` (and `src/core/index.ts`):
   ```ts
   export type RescueAllocation = { kind: "kept" | "already"; ref: string };

   export function allocateRescueRef(existing: Map<string, string>, dst: string, oid: string): RescueAllocation {
     const candidates = function* () {
       yield dst;
       yield `${dst}-${oid.slice(0, 12)}`;
       yield `${dst}-${oid}`;
       for (let n = 2; ; n++) yield `${dst}-${oid}-${n}`;
     };
     for (const cand of candidates()) {
       if (existing.get(cand) === oid) return { kind: "already", ref: cand };
       let conflict = false;
       const prefix = `${cand}/`;
       for (const k of existing.keys()) {
         if (k === cand || k.startsWith(prefix) || cand.startsWith(`${k}/`)) {
           conflict = true;
           break;
         }
       }
       if (!conflict) {
         existing.set(cand, oid);
         return { kind: "kept", ref: cand };
       }
     }
     throw new Error("unreachable");
   }
   ```
2. Wire into `keepLosingGitRefs` (`src/workspace.ts:882-914`):
   - Remove `&& existing.get(ref) !== oid` from the `candidates` filter at `src/workspace.ts:882` (since `refs/heads/foo` rescues to `refs/minilfs/<safeLabel>/heads/foo`, which must be checked at its destination, not at `refs/heads/foo` unless `existing.get(ref) === oid` on the same ref). Keep `existing.get(ref) !== oid` only when `ref` is already identical on `target` at that exact `ref`, or let `want` check `allocateRescueRef`:
     - If `existing.get(ref) === oid`, skip (already reachable under the exact same ref on `target`).
     - Otherwise compute preferred `dst` (`refs/minilfs/${safeLabel}/heads/...`, `ref`, or `refs/minilfs/${safeLabel}/tags/...`), call `const alloc = allocateRescueRef(existing, dst, oid)`, and if `alloc.kind === "kept"` push `[alloc.ref, oid]` to `wanted`.

### Edge Cases
- `dst`, `dst-<oid12>`, and `dst-<oid>` all hold other commits: `allocateRescueRef` returns `{ kind: "kept", ref: "${dst}-${oid}-2" }`.
- `existing` has `refs/minilfs/w1/heads/foo/sub` (descendant) or `refs/minilfs/w1/heads` (ancestor) at another oid: `dst = refs/minilfs/w1/heads/foo` is skipped as a D/F conflict, and `${dst}-${oid.slice(0, 12)}` (sibling of `foo/`) is selected.

### Regression Test
- `tests/elevate.test.mjs` & `tests/review-fixes.test.mjs`:
  1. Pre-populate `existing` with `dst`, `dst-<oid12>`, and `dst-<oid>` pointing to other oids: assert `allocateRescueRef(existing, dst, oid)` returns `{ kind: "kept", ref: "${dst}-${oid}-2" }`.
  2. Pre-populate `existing` with `refs/minilfs/w1/heads/foo/bar = otherOid`: assert `allocateRescueRef(existing, "refs/minilfs/w1/heads/foo", oid)` skips `.../foo` (descendant occupied) and returns `{ kind: "kept", ref: "refs/minilfs/w1/heads/foo-" + oid.slice(0, 12) }`. Fails before (returned `refs/minilfs/w1/heads/foo` on D/F conflict and `null` when all 3 slots were taken).

---

## 5. F6 — Layout-Aware `resolveGitPath(rel, layout)` in Apply (`src/gitpaths.ts:60-156`, `src/workspace.ts:2115-2240,2798`)

### Design
1. **Types & functions in `src/gitpaths.ts`**:
   ```ts
   export type GitLayout = ReadonlySet<string>;
   export interface ResolvedGitPath { gitDir: string | null; tail: string; kind: GitPathKind }

   export function resolveGitPath(rel: string, layout?: GitLayout): ResolvedGitPath
   export async function scanGitLayout(roots: string[], relPaths: string[]): Promise<GitLayout>
   ```
2. **How `scanGitLayout(roots, relPaths)` works**:
   - Built once per `applyLocked` inside the `snapBranch` mount (`roots = [wsPath, this.cwd]`, `relPaths = items.map((i) => i.path.replace(/^\/+/, ""))`).
   - For every `rel` in `relPaths`, split `g = splitGitPath(rel)`. If `g && g.inner`, collect `g.dir` and every candidate `c.gitDir` from `candidateGitDirs(g.dir, g.inner)`.
   - For each unique candidate `gitDir`, check if `roots.some((r) => hasGitLayout(join(r, gitDir)))` (`HEAD` is a file, `objects` and `refs` are directories). If true, add `gitDir` to `layout`.
3. **How `resolveGitPath(rel, layout)` works**:
   - Split `g = splitGitPath(rel)`. If `!g`, return `{ gitDir: null, tail: "", kind: "none" }`.
   - If `!g.inner`, or `/^modules\//.test(g.inner) && g.inner.split("/").some((c) => REFUSED_COMPONENT_RX.test(c))`, or `new RegExp(DOT_COMPONENT_RX).test(g.inner)`, or `!ALLOWED_RX.test(g.inner)`, return `{ gitDir: g.dir, tail: g.inner, kind: "protected" }`.
   - Compute `all = candidateGitDirs(g.dir, g.inner)`.
   - If `layout`: filter `onLayout = all.filter((c) => layout.has(c.gitDir))`. Pick `chosen = onLayout.length ? onLayout[onLayout.length - 1] : pickGitDir(g.dir, g.inner)`.
   - Else: `chosen = pickGitDir(g.dir, g.inner)`.
   - If `!chosen`, return `{ gitDir: g.dir, tail: g.inner, kind: "protected" }`.
   - Compute `kind = classifyGitTail(chosen.tail)` (the exact tail rules currently in `gitPathKind` lines `82-93`).
   - Return `{ gitDir: chosen.gitDir, tail: chosen.tail, kind }`.
   - Keep `gitPathKind(rel)` as `return resolveGitPath(rel).kind;` for Seatbelt and quick checks.
4. **Use `resolveGitPath(rel, layout)` throughout `applyLocked` (`src/workspace.ts:2120-2240`)**:
   - Build `const layout = await scanGitLayout([wsPath, this.cwd], items.map((i) => i.path.replace(/^\/+/, "")))` at the top of the `withMountedBranch(snapBranch, ...)` callback (`src/workspace.ts:2121`).
   - Replace `gitPathKind(rel)` in `applyLocked` (`src/workspace.ts:2124, 2239`) with `const resolved = resolveGitPath(rel, layout)`.
   - Pass `layout` to `gitObjectsMissing(this.cwd, gitMeta, layout)`, `writeGitLocked(this.cwd, locked, join(this.config.root, "recovery"), layout)`, `removeEmptyGitRefParents(cwd, rel, layout)`, and `gitChangeSummary(appliedGitPaths, layout)`.
   - Inside `gitObjectsMissing` (`src/workspace.ts:2803`), obtain `{ gitDir: dir, tail: inner } = resolveGitPath(g.rel, layout)` instead of `gitDirOf(g.rel, cwd)`.

### Edge Cases
- A submodule named `a/logs` (`.git/modules/a/logs/{HEAD,objects,refs}`): `scanGitLayout` records `".git/modules/a/logs"` in `layout`. `resolveGitPath(".git/modules/a/logs/index", layout)` returns `{ gitDir: ".git/modules/a/logs", tail: "index", kind: "index" }` (not `tail: "logs/index", kind: "soft"`), so its index is checked by `gitObjectsMissing` and locked by `writeGitLocked`.

### Regression Test
- `tests/review-fixes.test.mjs`: Create a repo with a submodule git dir at `.git/modules/a/logs` (containing `HEAD`, `objects/`, `refs/`, and `index`). In the Branch, stage a bogus/missing blob oid into `.git/modules/a/logs/index`. Assert `resolveGitPath(".git/modules/a/logs/index", layout)` has `kind === "index"` and `gitDir === ".git/modules/a/logs"`, and `s.apply()` refuses the git metadata via `gitObjectsMissing` (`missing in .git/modules/a/logs`) instead of applying `.git/modules/a/logs/index` as `soft`. Fails before (applies corrupt submodule index as `soft`).

---

## 6. F7 — Atomic Index Restore & Blocking on Join Restore Failure (`src/gitjoin.ts:69-100`, `src/workspace.ts:965-994`)

### Design
1. **Atomic temp + rename restore in `GIT_JOIN_SCRIPT` (`src/gitjoin.ts:69-86`)**:
   ```sh
   if ! g update-ref -m "minilfs: $MSG" "$BRANCH" "$new" $cur; then
     if [ "$had_idx" -eq 1 ]; then
       restore_tmp=".git/index.restore.$$"
       if ! (cp -p "$orig_idx" "$restore_tmp" 2>/dev/null && mv -f "$restore_tmp" .git/index 2>/dev/null); then
         rm -f "$restore_tmp" 2>/dev/null || true
         echo "JOIN fail restore-index $orig_idx"; exit 0
       fi
       rm -f "$orig_idx"
     else
       rm -f "$orig_idx"
       if ! (rm -f .git/index 2>/dev/null && [ ! -e .git/index ]); then
         echo "JOIN fail restore-index .git/index"; exit 0
       fi
     fi
     echo "JOIN fail update-ref"; exit 0
   fi
   ```
2. **Preserve full failure reason in `parseJoin` (`src/gitjoin.ts:93-99`)**:
   ```ts
   export function parseJoin(stdout: string): JoinResult {
     const line = String(stdout).split("\n").filter((l) => l.startsWith("JOIN ")).pop();
     if (!line) return { mode: "fail", why: "no output" };
     const m = /^JOIN (\S+)(?: (.*))?$/.exec(line);
     if (!m) return { mode: "fail", why: "no output" };
     const [, mode, rest = ""] = m;
     if (mode === "skip" || mode === "fail") return { mode, why: rest };
     return { mode: mode as JoinResult["mode"], commit: rest };
   }
   ```
3. **Do not commit Workspace on `restore-index` failure; block instead (`src/workspace.ts:806-811, 919-923, 965-994`)**:
   - In `joinGitHistories` (`src/workspace.ts:965-994`), mount `target` with `commitAfter = false` and explicitly call `await this.commitWorkspaceOnce(ws, target, ...)` **only** when `result.mode !== "fail" && result.mode !== "skip"`.
   - When `result.mode === "fail" && result.why?.startsWith("restore-index")`:
     - Set `this.blocked = { reason: \`JOIN fail ${result.why}\`, heldWs: ws }`.
     - Keep `ws` mounted (`keepMounted = true` so `releaseWorkspace` is not called).
     - Throw `new LayerfsError("JoinRestoreFailed", \`git join could not restore .git/index (${result.why}); workspace held\`)`.
   - In `keepLosingGitRefs` (`src/workspace.ts:919-922`) and `mergeBranchLocked` (`src/workspace.ts:806-811`), rethrow when `e?.code === "JoinRestoreFailed"` or `this.blocked` is set so the merge call rejects and leaves the session blocked without committing the damaged `.git/index`.

### Edge Cases
- `update-ref` fails (`main.lock` held) AND `.git` is made read-only (`chmod 500 .git`) before `mv -f "$restore_tmp" .git/index`: script outputs `JOIN fail restore-index /tmp/minilfs-join-orig-index.XXXXXX`, `$orig_idx` still exists on disk with the original index bytes, `workspace.commit` is NOT called on `target`, and `s.blocked` is set.

### Regression Test
- `tests/elevate.test.mjs` & `tests/review-fixes.test.mjs`:
  1. Unit (`tests/elevate.test.mjs`): Hold `.git/refs/heads/main.lock` and replace `mv` in `PATH` with a wrapper that fails on `.git/index`: assert `parseJoin` returns `{ mode: "fail", why: "restore-index <backupPath>" }` and `readFileSync(backupPath)` equals the pre-join `.git/index`.
  2. Session (`tests/review-fixes.test.mjs`): Trigger `restore-index` failure during `joinGitHistories`; assert `mergeBranch` rejects with `JoinRestoreFailed`, `s.blocked.reason` matches `/^JOIN fail restore-index \/tmp\/minilfs-join-orig-index\./`, the backup file exists, and no join commit was written to the Store. Fails before.

---

## 7. Minor `m` — Bounded/Filtered/Throttled Outside Reads, `git check-ref-format` & Clean Env in `IgnoreRules.load`

### Design
1. **Outside reads (`src/workspace.ts:154-169, 1118-1128`)**:
   - **64 MiB byte bound & device refusal in `OUTSIDE_READ_PL` (`src/workspace.ts:154-169`)**:
     ```perl
     use Fcntl qw(O_RDONLY O_NONBLOCK);
     my ($op, $p) = @ARGV;
     sub fail { my ($c) = grep { $!{$_} } keys %!; print STDERR (($c || "EACCES") . ":$!\n"); exit 1 }
     binmode(STDOUT);
     if ($op eq "readdir") { opendir(my $d, $p) or fail(); print join("\0", sort grep { $_ ne "." && $_ ne ".." } readdir($d)); exit 0 }
     sysopen(my $f, $p, O_RDONLY | O_NONBLOCK) or fail();
     my @st = stat($f) or fail();
     if ($op eq "isDir") { print((-d _) ? "1" : "0"); exit 0 }
     if ($op eq "read") {
       if (-d _) { print STDERR "EISDIR:Is a directory\n"; exit 1 }
       if (-b _) { print STDERR "EINVAL:Refusing to read block device\n"; exit 1 }
       if (-c _) {
         my @dn = stat("/dev/null");
         if (!@dn || $st[0] != $dn[0] || $st[1] != $dn[1]) {
           print STDERR "EINVAL:Refusing to read character device\n"; exit 1;
         }
       }
       my $max = 67108864;
       if (-f _ && $st[7] > $max) { print STDERR "EFBIG:File exceeds 64 MiB limit\n"; exit 1 }
       binmode($f);
       my ($buf, $chunk) = ("", "");
       while (1) {
         my $n = sysread($f, $chunk, 65536);
         fail() if !defined $n;
         last if $n == 0;
         if (length($buf) + $n > $max) { print STDERR "EFBIG:File exceeds 64 MiB limit\n"; exit 1 }
         $buf .= $chunk;
       }
       print $buf;
     }
     exit 0;
     ```
   - **Concurrency semaphore (`src/workspace.ts:1118`)**:
     Cap concurrent `sandbox-exec` outside-read subprocesses at `OUTSIDE_READ_CONCURRENCY = 8` via a module-level FIFO semaphore `withOutsideReadSlot` wrapping `run("/usr/bin/sandbox-exec", ...)` in `runOutsideRead`.
2. **`git check-ref-format`-equivalent ref validation (`src/gitpaths.ts:296`, `src/workspace.ts:2764`)**:
   - Export `isValidGitRefName(ref: string): boolean` in `src/gitpaths.ts`:
     ```ts
     export function isValidGitRefName(ref: string): boolean {
       if (!ref.startsWith("refs/") || ref.length <= 5 || ref.length > 255) return false;
       if (/[\x00-\x20\x7f~^:?*\[\\]/.test(ref)) return false;
       if (ref.includes("..") || ref.includes("@{") || ref.includes("//") || ref.endsWith("/") || ref.endsWith(".")) return false;
       return ref.split("/").every((c) => c.length > 0 && !c.startsWith(".") && !c.toLowerCase().endsWith(".lock"));
     }
     ```
   - Also add `!name.includes("@{")` to `isSafeRefName` (`src/gitpaths.ts:296`).
   - Replace `isRefTarget` (`src/workspace.ts:2764`) with `isValidGitRefName` (used for `packed-refs` lines, loose symref targets, and `resolveRefAfter` hops).
3. **Sanitized environment in `IgnoreRules.load` (`src/ignore.ts:95-98`)**:
   - Pass explicit `env` and `-c core.hooksPath=/dev/null -c core.fsmonitor=false` in `IgnoreRules.load()`:
     ```ts
     const env: NodeJS.ProcessEnv = {
       PATH: process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
       HOME: homedir(),
       ...(process.env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } : {}),
       TMPDIR: "/private/tmp",
       LANG: "C",
       GIT_TERMINAL_PROMPT: "0",
     };
     const r = await run("git", ["-C", this.root, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { env, timeoutMs: 10_000 }).catch(() => null);
     ```

### Regression Tests
- `tests/elevate.test.mjs`:
  1. Outside read: `s.readFile("/dev/null")` returns `Buffer.alloc(0)`; `s.readFile("/dev/zero")` rejects with `code === "EINVAL"`; reading a sparse/65 MiB temp file `/tmp/minilfs-big-...` (`fsp.truncate(p, 65 * 1024 * 1024)`) rejects with `code === "EFBIG"`; 20 parallel `s.readFile` calls all succeed with max active subprocesses ≤ 8.
  2. `isValidGitRefName`: rejects `"refs/heads/a..b"`, `"refs/heads/a@{0}"`, `"refs/heads/foo.lock"`, `"refs/heads/foo.lock/bar"`, `"refs/heads/.hidden"`, `"refs/heads/a b"`; accepts `"refs/heads/feat/x-1"`. `apply()` rejects `packed-refs` containing `<oid> refs/heads/a..b`.
  3. `IgnoreRules.load`: set `process.env.GIT_DIR = "/nonexistent"` and `process.env.GIT_INDEX_FILE = "/nonexistent"`; call `await rules.load()` on a real git repo and assert `rules.active === true` and tracked files are loaded. Fails before (`git rev-parse` fails under `GIT_DIR=/nonexistent`).

---

## 8. Commit-Sized Plan & Re-Run List

1. **Commit 1 — F3 + F5 + F6 (`src/gitpaths.ts`, `src/core/index.ts`, `src/workspace.ts`, `tests/elevate.test.mjs`, `tests/review-fixes.test.mjs`)**:
   `expectedType(inner)`, total namespace-aware `allocateRescueRef`, `isValidGitRefName`, and layout-aware `resolveGitPath(rel, layout)` + `scanGitLayout` wired through `applyLocked` and `gitObjectsMissing`.
2. **Commit 2 — F1 + F2 (`src/bindings.ts`, `src/workspace.ts`, `tests/review-fixes.test.mjs`)**:
   Deferred-only Phase 2 unlinks, `createdDirs` tracking, deepest-first CAS-safe rollback in `writeGitLocked`, `<root>/recovery/<project>-<ts>` fallback + `RecoveryPending` guard in `applyLocked`.
3. **Commit 3 — F4 + F7 + `m` (`src/core/proc-scan.ts`, `src/core/driver.ts`, `src/gitjoin.ts`, `src/ignore.ts`, `src/workspace.ts`, `tests/elevate.test.mjs`, `tests/review-fixes.test.mjs`)**:
   Fail-closed `reapWorkspaceHolders` + per-signal `procStartTime` in `killAll` (F4), temp+rename index restore + `JoinRestoreFailed` blocking in `joinGitHistories` (F7), outside-read 64 MiB limit / device check / concurrency semaphore, and sanitized env in `IgnoreRules.load` (`m`).

### Re-Run List
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
- `node tests/worker-mount.test.mjs`
