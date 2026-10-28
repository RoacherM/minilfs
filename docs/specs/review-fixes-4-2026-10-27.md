# Spec: fourth-round fixes N1–N7 (2026-10-27)

Designed by auto/gemini-4-argon from `docs/issues/quarry-run-2026-10-27.md` §9. Code wins over line numbers; keep the intent.

# Implementation Spec: Fourth-Round Review Fixes N1–N7 (2026-10-27)

Context: addresses findings N1–N7 in `docs/issues/quarry-run-2026-10-27.md:263-278` (§9, reviewing `b044726..2d23879`).

---

## 1. N1 (Major) — Validate the Resulting Symbolic-Ref Graph in `gitObjectsMissing` (`src/workspace.ts:2696-2828`)

### Problem
In `src/workspace.ts:2732-2777`, `gitObjectsMissing` skips deletions (`if (g.git === "soft" || !g.next || g.next.kind !== "file") continue;`) and records `d.symrefs` only from `meta` entries whose new content starts with `ref:`. Unchanged symbolic predecessors on the host/Branch (e.g. `HEAD -> refs/heads/main -> refs/tags/t` when only `refs/tags/t` is updated to a blob or deleted) are never added to `d.symrefs`, bypassing `expectedType` and deletion checks.

### Design
1. **Include all affected git dirs (including delete-only) (`src/workspace.ts:2732-2777`)**:
   - For every `g` in `meta` with `g.git !== "soft"`, resolve `{ gitDir: dir, tail: inner } = resolveGitPath(g.rel, layout)` (`src/workspace.ts:2735`) and initialize `d` in `byDir` **before** checking `!g.next`.
   - Track per-`dir`:
     - `touched: Set<string>` — every `inner` (`HEAD` or `refs/...`) modified or deleted in `meta`, plus every ref name whose line in planned `${dir}/packed-refs` was added, changed, or removed relative to host `join(cwd, dir, "packed-refs")`.
     - `deleted: Set<string>` — every ref `inner` deleted in `meta` (`!g.next`) or removed from `packed-refs` that is absent in the post-apply view (neither a planned loose file nor present in post-apply `packed-refs`).
     - If a loose ref deletion (`!g.next`) uncovers an entry for `inner` in post-apply `packed-refs` with `<oid>`, record `need(oid, expectedType(inner))` and `d.tips.add(oid)`.
2. **Collect post-apply symbolic refs from the host folder + `meta` (`collectPostApplySymrefs`)**:
   ```ts
   async function collectPostApplySymrefs(
     cwd: string,
     dir: string,
     meta: GitWrite[],
   ): Promise<{ symrefs: Map<string, string>; packed: Map<string, string>; error: string | null }>
   ```
   - **Where host refs are read**: directly from the user's folder under `join(cwd, dir)` (`HEAD`, `packed-refs`, and loose files under `join(cwd, dir, "refs")`), overlaid with `meta` (which already contains every Branch ref change/deletion being applied; unchanged Branch refs equal the host's):
     1. Read post-apply `packed-refs` (from `meta` if `${dir}/packed-refs` is planned, else `join(cwd, dir, "packed-refs")` once): populate `packed` (`ref -> oid`) and any `symrefs` (`^ref:\s*(\S+)$` if present).
     2. Check `HEAD` and walk `join(cwd, dir, "refs")` on the host for loose files not overridden by `meta`, plus all planned loose files in `meta` (`g.next?.kind === "file"`). If a file's post-apply text matches `/^ref: (\S+)$/`, set `symrefs.set(inner, target)`; if it is an oid, remove `inner` from `symrefs` (loose overrides packed).
   - **Cost bound**: runs only for git dirs in `byDir`; caps the loose `refs/` walk at `MAX_SYMREF_SCAN_FILES = 10_000` files per git dir and only reads host files with `st.size <= 1024` bytes (a valid ref or `ref: <target>` is ≤ 260 bytes). Exceeding `MAX_SYMREF_SCAN_FILES` returns `error: "${dir}/refs has more than 10000 loose refs"`.
3. **Resolve chains in the post-apply view (`resolveRefAfter`, `src/workspace.ts:2699-2718`)**:
   ```ts
   type ResolvedRef =
     | { kind: "oid"; oid: string; chain: string[] }
     | { kind: "missing"; target: string; chain: string[] }
     | { kind: "invalid"; target: string; chain: string[] }
     | { kind: "loop"; target: string; chain: string[] };
   ```
   - `resolveRefAfter(cwd, dir, inner, target, meta, packed)` follows up to 5 hops (`chain` starts as `[inner]` and pushes each visited `name`).
   - Filter to symbolic refs where (a) `touched.has(inner)` (the symref itself changed) or (b) `r.chain.some((n) => touched.has(n))` (its chain reaches any changed or deleted ref).
   - **Validation rules on each qualifying chain**:
     - `r.kind === "loop"` → refuse `"${dir}/${inner}: symbolic ref loop at ${r.target}"`.
     - `r.kind === "invalid"` → refuse `"${dir}/${inner} names ${r.target}, which is not a valid ref"`.
     - `r.kind === "missing"`:
       - If `inner !== "HEAD"` or `r.chain.some((n) => deleted.has(n))` (chain leads into a deleted ref while commits exist) → refuse `"${dir}/${inner} names ${r.target}, which does not exist"`.
       - If `inner === "HEAD"` and `!r.chain.some((n) => deleted.has(n))`, allow as `unborn = r.target` only when the repo has no commits (`!d.addsHeads && !d.tips.size` and `git rev-list -n 1 --all` is empty, `src/workspace.ts:2814-2817`).
     - `r.kind === "oid"`:
       - Verify `isOid(r.oid)`.
       - Apply `expectedType` to **every** name in `r.chain`: `const w = r.chain.some((n) => expectedType(n) === "commit") ? "commit" : "any"`; add `w` to `d.want.get(r.oid)` and `r.oid` to `d.tips`.
       - If `r.chain.some((n) => n.startsWith("refs/heads/"))`, set `d.addsHeads = true`.

### Edge Cases
- Host has `HEAD -> refs/heads/main` and `refs/heads/main -> refs/tags/t` (unchanged); Branch updates only `refs/tags/t` to a blob oid: `touched` has `"refs/tags/t"`, both chains reach `"refs/tags/t"`, `expectedType("refs/heads/main") === "commit"` requires `"commit"` on the blob oid, and `gitObjectsMissing` refuses.
- Host has `refs/heads/alias -> refs/heads/feat`; Branch deletes `refs/heads/feat` (only item in `meta`): `byDir` includes `.git`, `touched` and `deleted` contain `"refs/heads/feat"`, and `gitObjectsMissing` refuses `"refs/heads/alias names refs/heads/feat, which does not exist"`.

### Regression Test
- `tests/review-fixes.test.mjs`:
  - Setup: On host, create tag `refs/tags/t` pointing to initial commit and set `.git/refs/heads/sym` to `ref: refs/tags/t\n` (synced into `main`). In the Branch, overwrite only `.git/refs/tags/t` with the blob oid of `a.txt` (leaving `HEAD` and `refs/heads/sym` unchanged). Also test a second case where the Branch deletes `.git/refs/tags/t`.
  - Assertion: `await s.apply()` skips git metadata with `ap.warnings[0]` matching `/is a blob, not a commit/` (first case) and `/refs\/heads\/sym names refs\/tags\/t, which does not exist/` (second case), leaving host `.git/refs/tags/t` untouched. Fails now (both apply cleanly), passes after.

---

## 2. N2 (Major) — Durable Pre-Mutation Recovery State, Strict Guard & `recover --clear` (`src/workspace.ts:2079-2085, 2299-2356, 2853-3043`, `src/core/tools.ts`, `src/index.ts`)

### Problem
In `src/workspace.ts:2977-2990`, `recDir` is created only after `rollback()` fails; if `mkdir(recDir)` or `setRecoveryDir` fails (or the process dies mid-apply), preimages or the guard are lost. Moreover, `src/workspace.ts:2084` (`if (recDir) this.bindings.setRecoveryDir(this.projectRecord.name, null)`) silently clears `recoveryDir` when the folder is missing on disk, and `src/workspace.ts:2327-2329` skips `setMainStale` if `setRecoveryDir` or `writeHostIndex` throws.

### Design
1. **Write recovery preimages + manifest and set `recoveryDir` BEFORE the first destructive mutation (`src/workspace.ts:2853-3030`)**:
   - Extend `GitRecovery` (`src/workspace.ts:2831`):
     ```ts
     type GitRecovery = {
       root: string;
       project: string;
       warnings: string[];
       setRecoveryDir: (dir: string | null) => void;
     };
     ```
   - In `writeGitLocked`:
     - Phase 1 (`src/workspace.ts:2992-2995`) locks every non-`deferred` item (which includes all `deletes`, both `blocking` and non-`blocking`) and populates `prev` (`Map<string, { data: Buffer; mode: number } | null>`). Every `deferred` write lies below a `blocking` delete (which is a file on disk), so its preimage is `null`.
     - When `blocking.size === 0`, run Phase 3 locks and `overDir` checks before persisting recovery (since Phases 1–3 only create `.lock` files and empty dirs). When `blocking.size > 0`, Phase 2 unlinks `blocking` deletes, so persist recovery **immediately before Phase 2** (before the first `fsp.rm` or `fsp.rename`).
     - **`persistRecoveryBeforeMutation()`**:
       1. Create `recDir = join(recovery.root, "${recovery.project}-${Date.now()}-${randomBytes(3).toString("hex")}")`.
       2. Write every non-null `[rel, val]` in `prev` to `join(recDir, "preimages", rel)` (`mode: val.mode & 0o7777`).
       3. Write `join(recDir, "manifest.json")` with `{ project: recovery.project, cwd, at: Date.now(), status: "applying", absentBefore: items.filter((i) => !prev.get(i.rel)).map((i) => i.rel), preimages: "preimages/<path> holds each path's previous bytes" }`.
       4. Call `recovery.setRecoveryDir(recDir)`.
       5. **Abort rule**: if any step in (1)–(4) throws, clean up (`await fsp.rm(recDir, { recursive: true, force: true }).catch(() => {})`; `try { recovery.setRecoveryDir(null); } catch {}`), run `await release()` (unlock all `.lock` files and `removeCreatedDirs()`), and rethrow — **zero target files in the user's folder were mutated**.
     - **On successful commit (end of Phase 4, `src/workspace.ts:3028`) or complete rollback (`unrecovered.length === 0`, `src/workspace.ts:2976`)**:
       - `await fsp.rm(recDir, { recursive: true, force: true }).catch(() => {});`
       - `recovery.setRecoveryDir(null);`
     - **On incomplete rollback (`unrecovered.length > 0`, `src/workspace.ts:2977-2990`)**:
       - `recDir` (with all `preimages/`) and `recoveryDir` in `bindings.json` are already durable. Best-effort overwrite `join(recDir, "manifest.json")` adding `status: "rollback_incomplete"`, `unrecovered`, and `hostKept`. Throw `LayerfsError("RollbackIncomplete", ...)` with `err.recoveryDir = recDir`.
2. **Never auto-clear a missing `recoveryDir` on apply (`src/workspace.ts:2079-2085`)**:
   - Replace lines `2080-2084` with:
     ```ts
     const recDir = this.bindings.byName(this.projectRecord.name)?.recoveryDir;
     if (recDir) {
       const exists = existsSync(recDir);
       throw new LayerfsError(
         "RecoveryPending",
         exists
           ? `an earlier apply could not finish putting your folder's git metadata (refs, HEAD, index) back; their previous versions are saved in ${recDir} (see manifest.json there). Check the folder's git, restore what is needed, then run /minilfs recover --clear (or minilfs action=recover clear=true) to apply again.`
           : `an earlier apply recorded pending git recovery at ${recDir}, and that folder is missing. Check your folder's git (.git/HEAD, refs, index), then run /minilfs recover --clear (or minilfs action=recover clear=true, or remove recoveryDir from bindings.json) to apply again.`,
       );
     }
     ```
3. **Define user recovery clear command (`LayerfsSession.clearRecovery`, `minilfs` tool `action="recover"`, `/minilfs recover --clear`)**:
   - `LayerfsSession.clearRecovery(): Promise<{ cleared: string | null }>` (`src/workspace.ts`): under `this.bindings.withProjectLock(this.projectRecord.name, ...)`, reads `recDir = this.bindings.byName(this.projectRecord.name)?.recoveryDir ?? null`, removes `recDir` if present (`fsp.rm(recDir, { recursive: true, force: true }).catch(() => {})`), calls `this.bindings.setRecoveryDir(this.projectRecord.name, null)`, sets `this.projectRecord.recoveryDir = null`, marks `this.bindings.setMainStale(this.projectRecord.name, true)`, and returns `{ cleared: recDir }`.
   - `src/core/tools.ts`: add `"recover"` to `LAYERFS_TOOL_SCHEMA.properties.action.enum` and `clear: { type: "boolean" }` to `LAYERFS_TOOL_SCHEMA.properties` + `LayerfsActionParams`. In `executeLayerfsAction`: when `action === "recover"`, enforce lead-only (`if (resolveRole().role !== "lead") throw new Error(ONLY_LEAD)`), require `params.clear === true` (without `clear: true`, report the current `recoveryDir` and instruct to pass `clear=true`), and call `await s.clearRecovery()`.
   - `src/index.ts`: add `["recover", "检查 .git 后解除写回保护：recover --clear"]` to `SUBCOMMANDS` (`src/index.ts:392`) and handle `sub === "recover"` (lead-only; requires `--clear`; calls `await s.clearRecovery()`).
4. **Guarantee `setMainStale` even if binding updates throw (`src/workspace.ts:2324-2356`)**:
   - In the `catch (e: any)` block (`src/workspace.ts:2324-2333`), set in-memory `this.projectRecord.mainStale = true` and call `setMainStale` **first** in its own `try/catch`, isolating `setRecoveryDir` and `writeHostIndex` in separate `try/catch` blocks so none can prevent `setMainStale` or mask `err`. In `syncHostDriftIntoMain` (`src/workspace.ts:469`), check `Boolean(this.bindings.byName(this.projectRecord.name)?.mainStale || this.projectRecord.mainStale)`.

### Edge Cases
- `mkdir(recDir)` or `setRecoveryDir(recDir)` throws `ENOSPC`/`EACCES` before Phase 4: `writeGitLocked` releases `.lock` files and `createdDirs` and throws before any unlink/rename; host `.git` is untouched.
- `recDir` is deleted externally (or `mkdir` was lost on power cut after `setRecoveryDir`): next `s.apply()` still throws `RecoveryPending` naming the missing `recDir` and `/minilfs recover --clear`.

### Regression Test
- `tests/review-fixes.test.mjs`:
  1. Force `setRecoveryDir` (or writing `recDir/manifest.json`) to throw before Phase 4: assert `s.apply()` fails or skips git metadata with zero changes to host `.git/refs/heads/main`.
  2. Trigger `RollbackIncomplete`, then `rmSync(recDir, { recursive: true, force: true })` while `recoveryDir` remains in `bindings.json`: assert `s.apply()` still rejects with `code === "RecoveryPending"` mentioning `/minilfs recover --clear`. Then call `executeLayerfsAction(s, { action: "recover", clear: true })` (and verify worker role is rejected) and assert the next `s.apply()` succeeds.
  3. Force `s.bindings.writeHostIndex` to throw inside `applyLocked`'s catch block after a file was written: assert `s.bindings.byName(s.project).mainStale === true` and `s.projectRecord.mainStale === true`. Fails now, passes after.

---

## 3. N3 (Minor) — Keep Rescue Refs Under `refs/minilfs/` (`refs/minilfs-rescue/` Fallback) (`src/gitpaths.ts:309-348`, `src/workspace.ts:882-904`)

### Design
1. Export `isRescueRef(ref: string): boolean` in `src/gitpaths.ts` (and `src/core/index.ts`):
   ```ts
   export function isRescueRef(ref: string): boolean {
     return /^refs\/minilfs(?:-rescue(?:-[0-9a-f]+(?:-\d+)?)?)?\//.test(ref);
   }
   ```
2. Update `expectedType(inner)` (`src/gitpaths.ts:309-311`):
   ```ts
   export function expectedType(inner: string): "commit" | "any" {
     return inner === "HEAD" || inner.startsWith("refs/heads/") || /^refs\/minilfs(?:-rescue(?:-[0-9a-f]+(?:-\d+)?)?)?\/[^/]+\/(heads\/|HEAD$)/.test(inner) ? "commit" : "any";
   }
   ```
3. Update `allocateRescueRef(existing, dst, oid)` (`src/gitpaths.ts:323-348`):
   - When a file at `ancestor` blocks `dst`:
     - If `ancestor === "refs"` (invalid), throw.
     - If `ancestor === "refs/minilfs"` (`refs/minilfs` itself is a loose/packed ref file), pick the first `alt` from `names("refs/minilfs-rescue")` (`refs/minilfs-rescue`, `refs/minilfs-rescue-<oid12>`, `refs/minilfs-rescue-<oid>`, `refs/minilfs-rescue-<oid>-2`, …) where `!existing.has(alt)` (not a file), and set `dst = "${alt}${dst.slice("refs/minilfs".length)}"`.
     - Otherwise (`ancestor` is below `refs/minilfs/`, e.g. `refs/minilfs/<label>` or `refs/minilfs/<label>/heads/foo`), pick the first `alt` from `names(ancestor)` where `!existing.has(alt)` and set `dst = "${alt}${dst.slice(ancestor.length)}"` — keeping every candidate inside `refs/minilfs/`.
4. Update `keepLosingGitRefs` (`src/workspace.ts:882, 900`):
   - Line `882`: replace `/^refs\/(heads|tags|minilfs)\//.test(ref)` with `(/^refs\/(heads|tags)\//.test(ref) || isRescueRef(ref))`.
   - Line `900`: replace `else if (ref.startsWith("refs/minilfs/"))` with `else if (isRescueRef(ref))`.

### Edge Cases
- `existing` has file `"refs/minilfs"` AND file `"refs/minilfs-rescue"`: `names("refs/minilfs-rescue")` picks `"refs/minilfs-rescue-<oid12>/..."`, which `isRescueRef` and `expectedType` both recognize on subsequent merges.

### Regression Test
- `tests/elevate.test.mjs`: Set `ex = new Map([["refs/minilfs", other]])`; call `allocateRescueRef(ex, "refs/minilfs/w1/heads/main", oid)` and assert it returns `{ kind: "kept", ref: "refs/minilfs-rescue/w1/heads/main" }`, `isRescueRef(ref) === true`, and `expectedType(ref) === "commit"`. Fails now (produces `refs/minilfs-<oid12>/...` which `isRescueRef`/`expectedType` ignore).

---

## 4. N4 (Minor) — Collect Lock-Removal Failures in `writeGitLocked` (`src/workspace.ts:2902-3043`)

### Design
- In `writeGitLocked` (`src/workspace.ts`):
  - Define `unlockWarn = async (lockPath: string) => fsp.rm(lockPath, { force: true }).then(() => held.delete(lockPath), (e: any) => { held.delete(lockPath); recovery.warnings.push(\`could not remove ${relative(cwd, lockPath)}: ${e?.message ?? e}\`); })`.
  - Use `unlockWarn` in `release()` (`src/workspace.ts:2983`), post-commit `for (const d of deletes)` (`src/workspace.ts:3025`), and the outer `finally` (`src/workspace.ts:3041`).
  - Inside `rollback()`, in the `finally` blocks at `src/workspace.ts:2950, 2971` and in a final sweep over `[...held]` before `if (!unrecovered.length) return;`, record any lock removal failure into `unrecovered.push({ rel: relative(cwd, lockPath), err: String(e?.message ?? e) })`.

### Edge Cases
- A `.lock` removal fails during `release()` (before mutation): warning is added to `result.warnings`. During `rollback()`: recorded in `unrecovered`, triggering `RollbackIncomplete`.

### Regression Test
- `tests/review-fixes.test.mjs`: Mock `fsp.rm` to fail with `EACCES` on `.git/refs/heads/b.lock` when `release()` cleans up after `.git/refs/heads/a` changed on host: assert `ap.warnings` includes `could not remove .git/refs/heads/b.lock`. Fails now (error swallowed).

---

## 5. N5 (Minor) — Documented Limitation (`src/gitpaths.ts:104-114`)

- **Accepted as documented limitation (no code behavior change)**: A submodule whose name contains a transient git directory segment (`rebase-merge/`, `rebase-apply/`, `sequencer/`, `rr-cache/`) has its files classified `transient` by `STRICTNESS` (`src/gitpaths.ts:102`, tested in `tests/elevate.test.mjs:298`) so an agent-crafted fake git layout inside `rebase-merge/` can never lower `transient` to an applied ref or index. Add one comment line at `src/gitpaths.ts:114` and note in `docs/issues/quarry-run-2026-10-27.md`.

---

## 6. N6 (Minor) — Log Unresolved Holders & Add 30 s Unmount Deadline (`src/core/driver.ts:305-321`, `src/workspace.ts:1730-1755`)

### Design
1. **Report unresolved holders (`src/core/driver.ts:305-321`)**:
   - In `LocalNativeDriver.reapWorkspaceHolders(wsReal: string)`:
     - Track `const unresolved: number[] = []`.
     - After `const rows = identifyListed(pids, before)` and `killAll(rows)`: for every `pid` in `pids` that was not in `rows` (e.g. started during `lsof` with `startUs(r) >= before`) or whose start time changed before `killAll`, if the pid is still alive (`try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }`), push `pid` to `unresolved`.
     - After the loop: if `unverified > 0`, throw the existing unverified error; else if `unresolved.length > 0`, throw `new Error("${unresolved.length} process(es) holding the mount (${unresolved.join(", ")}) started during lsof or changed identity and were not signalled")`.
     - `LayerfsSession.reapHolders` (`src/workspace.ts:1926-1928`) already catches and logs `${e?.message ?? e} (${wsPath})` before `releaseWorkspace` proceeds.
2. **30 s deadline on `lfs.workspace.unmount` (`src/workspace.ts:1730-1755`)**:
   - Export `export const UNMOUNT_DEADLINE_MS = 30_000;` (and allow overriding via `this.config.unmountDeadlineMs ?? UNMOUNT_DEADLINE_MS` for tests) in `src/workspace.ts`.
   - In `releaseWorkspace` (`src/workspace.ts:1735`), wrap `lfs.workspace.unmount(ws, d)` in `Promise.race` with a timer that rejects with `Object.assign(new Error("workspace.unmount timed out"), { code: "UnmountDeadline" })` and `clearTimeout` in `finally`.

### Edge Cases
- First `unmount(ws, false)` hangs > deadline: rejects with `UnmountDeadline`, logs retry, runs `reapHolders`, retries `unmount(ws, true)` with deadline, and on second timeout runs `forceUnmount(wsReal)` while retaining the mount lease.

### Regression Test
- `tests/elevate.test.mjs`:
  1. Stub `lfs.workspace.unmount` to return a never-resolving promise with `unmountDeadlineMs = 50`: assert `releaseWorkspace` finishes in < 500 ms, logs `UnmountDeadline`, and leaves the lease on disk.
  2. Have a holder pid whose `startUs >= before`: assert `reapWorkspaceHolders` rejects mentioning the unresolved pid. Fails now, passes after.

---

## 7. N7 (Minor) — Bounded Outside `readdir` & Ref Validation Comment (`src/workspace.ts:153-163`, `src/gitpaths.ts:294-303`)

### Design
1. **Cap `readdir` in `OUTSIDE_READ_PL` (`src/workspace.ts:160`)**:
   - Replace `if ($op eq "readdir") { ... }` with a streaming loop capped at `100_000` entries and `16 * 1024 * 1024` bytes (16 MiB):
     ```perl
     if ($op eq "readdir") {
       opendir(my $d, $p) or fail();
       my (@names, $n, $bytes) = ((), 0, 0);
       while (defined(my $e = readdir($d))) {
         next if $e eq "." || $e eq "..";
         $n++; $bytes += length($e) + 1;
         refuse("EFBIG:directory exceeds 100000 entries or 16 MiB") if $n > 100000 || $bytes > 16777216;
         push @names, $e;
       }
       print join("\0", sort @names);
       exit 0;
     }
     ```
2. **Document stricter rules in `isValidGitRefName` (`src/gitpaths.ts:294-303`)**:
   - Keep `ref.length <= 255` and `!c.toLowerCase().endsWith(".lock")`; add comment explaining that `<= 255` bounds loose-ref path lengths and case-insensitive `.lock` prevents `FOO.LOCK` from aliasing git's lock files on case-insensitive APFS/HFS+.

### Regression Test
- `tests/elevate.test.mjs`: Pass a lower entry/byte cap (or test `OUTSIDE_READ_PL` with a temp directory exceeding the cap) and assert `s.readdir(outsideDir)` rejects with `code === "EFBIG"`. Fails now, passes after.

---

## 8. Commit Plan & Re-Run List

1. **Commit 1 — Majors N1 + N2 (`src/workspace.ts`, `src/core/tools.ts`, `src/index.ts`, `tests/review-fixes.test.mjs`)**:
   Resulting symbolic-ref graph validation (`collectPostApplySymrefs`, `resolveRefAfter` chain/deletion checks) in `gitObjectsMissing`; pre-mutation durable recovery folder + `recoveryDir` binding in `writeGitLocked`, strict `RecoveryPending` guard (even when folder is missing), `clearRecovery()` / `minilfs` tool `action="recover" clear=true` / `/minilfs recover --clear`, and isolated `setMainStale` in `applyLocked`.
2. **Commit 2 — Minors N3 + N4 + N5 + N6 + N7 (`src/gitpaths.ts`, `src/core/index.ts`, `src/core/driver.ts`, `src/workspace.ts`, `docs/issues/quarry-run-2026-10-27.md`, `tests/elevate.test.mjs`, `tests/review-fixes.test.mjs`)**:
   `isRescueRef` + `refs/minilfs-rescue` fallback in `allocateRescueRef` / `expectedType` / `keepLosingGitRefs` (N3), lock-removal failure collection in `writeGitLocked` (N4), N5 comment, unresolved holder logging + `UNMOUNT_DEADLINE_MS` in `releaseWorkspace` (N6), bounded outside `readdir` + `isValidGitRefName` comment (N7).

### Re-Run List
- `node tests/elevate.test.mjs`
- `node tests/review-fixes.test.mjs`
- `node tests/store-contention.test.mjs`
- `node tests/native-seatbelt.test.mjs`
- `node tests/backend.test.mjs`
- `node tests/orphan-mount.test.mjs`
- `node tests/concurrent-start.test.mjs`
- `node tests/cli.test.mjs`
- `node tests/rpc.test.mjs`
- `node tests/pi.test.mjs`
- `node tests/scale.test.mjs`
- `node tests/worker-mount.smoke.mjs`
