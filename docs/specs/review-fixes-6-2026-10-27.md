# Spec: sixth-round fixes M1–M3, m1–m2 (2026-10-27)

Designed by auto/gemini-4-argon from `docs/issues/quarry-run-2026-10-27.md` §11, on decisions fixed by the coordinator (M2 is narrowed, not closed: git itself checks worktrees without a lock). Code wins over line numbers; keep the intent.

# Spec: Sixth-Round Review Fixes M1–M3 & m1–m2 (`8d18dc7..3fa6a86`)

Addresses `docs/issues/quarry-run-2026-10-27.md:305-315` (§11). Deliver in one or two commits.

---

## M1 — Exclusive Per-Repo Recovery Marker Check, Adoption, and `wx` Creation (`docs/issues/quarry-run-2026-10-27.md:311`)

- **Design (`src/workspace.ts:624-634, 2079-2082, 2258-2266, 2450-2456, 3476-3522`)**:
  - **Marker set (`src/workspace.ts:3476-3478`)**: Compute affected git dirs using `resolveGitPath(i.rel, layout).gitDir` and `commonGitDir(cwd, d)` (`src/workspace.ts:2852`) in addition to `".git"`, producing `markers = [...gitDirs].filter(isDir).map(d => "${d}/${RECOVERY_MARKER}")`.
  - **Pre-mutation check & adoption**:
    1. In `applyLocked` (`src/workspace.ts:2342`, right after `scanGitLayout` populates `layout` and before `put()` runs) and again in `writeGitLocked` (`src/workspace.ts:3565`, after Phase 1 locks and `listingsChanged()` succeed, before `persist()`), inspect `readFolderRecoveryMarker(cwd, m)` (`src/workspace.ts:3186`) for every affected git dir's marker `m`.
    2. If any marker exists (and is not in this apply's `createdMarkers` set), adopt it via `this.bindings.setRecoveryDir(this.projectRecord.name, dir, [m])` (`src/bindings.ts:206`) and `this.projectRecord.recoveryDir = dir`, release held locks (`await release()`), and throw `new LayerfsError("RecoveryPending", ...)` (`src/workspace.ts:2262`). In `applyLocked`'s `catch` (`src/workspace.ts:2479-2492`), rethrow `e` directly when `e?.code === "RecoveryPending"`.
    3. In `get recoveryDir()` (`src/workspace.ts:2079-2082`), fall back across `[".git/${RECOVERY_MARKER}", ...(rec?.recoveryMarkers ?? []), ...this.nestedMarkers]` via `readFolderRecoveryMarker(this.cwd, m)`.
  - **Exclusive creation & scoped removal (`src/workspace.ts:3479-3507`)**:
    - Track `const createdMarkers: string[] = []` in `writeGitLocked`.
    - In `persist()` (`src/workspace.ts:3496`), replace `writeFileDurable(join(cwd, m), ...)` (which opens with `"w"`, `src/workspace.ts:3201`) with `fsp.open(join(cwd, m), "wx", 0o644)`, writing `"${dir}\n"`, `chmod(0o644)`, `sync()`, `close()`, then `createdMarkers.push(m)`.
    - On `EEXIST`, read `existing = readFolderRecoveryMarker(cwd, m) ?? join(cwd, m)`, call `recovery.setRecoveryDir(existing, [m])`, skip clearing `setRecoveryDir(null)` in `persist()`'s `catch`, remove only `createdMarkers` and `dir`, and throw `LayerfsError("RecoveryPending", ...)`.
    - Change `removeMarkers()` (`src/workspace.ts:3479-3482`) to unlink and `fsyncDir` only `createdMarkers`.
- **Edge cases**: If two processes race into `persist()` on a nested submodule `.git`, `"wx"` guarantees the second fails with `EEXIST` before any unlink/rename, adopts the winner's marker, and leaves the winner's marker file intact.
- **Regression test (`tests/review-fixes.test.mjs`)**: Open parent session `s` on a repo with submodule `sub/.git`. After `s.open()`, write `/tmp/foreign-rec\n` to `sub/.git/minilfs-recovery` (simulating another session's failed submodule apply). Stage a submodule commit on `s` and call `s.apply()`. Assert `s.apply()` rejects with `code === "RecoveryPending"`, `s.recoveryDir === "/tmp/foreign-rec"`, and `readFileSync("sub/.git/minilfs-recovery", "utf8")` is still `"/tmp/foreign-rec\n"`. Fails now (`"w"` truncates and `forget()` deletes `sub/.git/minilfs-recovery`), passes after.

---

## M2 — Post-Rename Worktree `HEAD` Re-Check & Preimage Restoration (`docs/issues/quarry-run-2026-10-27.md:312`)

- **Design (`src/workspace.ts:3591-3608`, `README.md:191`)**:
  - In `writeGitLocked` Phase 4 (`src/workspace.ts:3601`, immediately after the `deletes` unlink loop and `writes` rename loop, before `await syncParents()`), re-scan `worktreeList(join(cwd, common))` (`src/workspace.ts:2824`) for every repo in `listings` (`src/workspace.ts:3248`).
  - For each worktree `<id>` (new or existing), read `join(cwd, common, "worktrees", id, "HEAD")` and follow its symbolic chain (`ref: <target>`).
  - If `<target>` (repo-relative `rel = "${common}/${target}"`) was deleted by this apply (either in `unlinked` or removed from `packed-refs` with no loose ref remaining) and we hold its preimage (`prev.get(rel)` for a loose deletion, or the prior OID from `prev.get("${common}/packed-refs")`):
    - Re-install `rel` from its preimage via `putBack(fh, rel, old)` (`src/workspace.ts:3360`) using the still-held `lockOf(rel)` (`src/workspace.ts:3606`) or `relock(rel, old.mode)` (`src/workspace.ts:3351`), remove `rel` from `unlinked`, record `rel` in a `restored` set so `applyLocked` (`src/workspace.ts:2459`) does not delete `hostIndex[rel]`, and push a warning to `recovery.warnings`: `"worktree ${id} checked out ${target} while apply was deleting it; ${target} was restored"`.
  - Document in a comment at `src/workspace.ts:3602` and in `README.md:191` that `git branch -d` checks worktree `HEAD`s without a lock (`worktree.c`), so a worktree created after this final check shares git's own narrow window.
- **Edge cases**: A worktree added on an unrelated branch is ignored (renames already landed; only deleted refs referenced by a worktree `HEAD` are put back).
- **Regression test (`tests/review-fixes.test.mjs`)**: Branch deletes `refs/heads/topic`. Hook `fsp.rename` (or `fsp.rm` on `refs/heads/topic`) so that right after `refs/heads/topic` is unlinked in Phase 4, `.git/worktrees/wt-new/HEAD` (`ref: refs/heads/topic\n`) and `commondir` are created. Assert `s.apply()` succeeds with `warnings` matching `/worktree wt-new.*refs\/heads\/topic.*restored/` and `.git/refs/heads/topic` retains its preimage OID on disk. Fails now (`topic` stays deleted, `wt-new/HEAD` dangles), passes after.

---

## M3 — `fsync` Git Objects and `objects/` Subdirectories Before Metadata Commit (`docs/issues/quarry-run-2026-10-27.md:313`)

- **Design (`src/workspace.ts:2389-2450`)**:
  - In `applyLocked`, track `const objectDirsToSync = new Set<string>()` and pass `git: GitPathKind` into `put(rel, next, git)` (`src/workspace.ts:2402, 2435`).
  - Inside `put()` (`src/workspace.ts:2416-2424`), when `next.kind === "file"`:
    - When `git === "object"` (`<gitDir>/objects/**`): before `fsp.mkdir(dirname(target), { recursive: true })`, check if `dirname(target)` exists; if not, add `dirname(dirname(target))` (`<gitDir>/objects`) to `objectDirsToSync`. Write `tmp` via `writeFileDurable(tmp, next.data, next.mode & 0o7777)` (`src/workspace.ts:3200`, which runs `fh.writeFile`, `fh.chmod`, `fh.sync()`, `fh.close()`), rename `tmp` to `target`, and add `dirname(target)` to `objectDirsToSync`.
    - When `git !== "object"` (working-tree files and `soft` git logs): keep the existing non-fsync `fsp.writeFile` + `fsp.chmod` + `fsp.rename`.
  - Before `writeGitLocked` is called (`src/workspace.ts:2449`), run `for (const d of objectDirsToSync) await fsyncDir(d)` (`src/workspace.ts:3195`).
- **Edge cases**: Multiple loose objects in `.git/objects/ab/` or packs in `.git/objects/pack/` add the subdirectory path to `objectDirsToSync` once and `fsyncDir` it once.
- **Regression test (`tests/review-fixes.test.mjs`)**: Spy on `FileHandle.prototype.sync` during an `apply()` that adds a commit (new `.git/objects/xx/yy...` and modified `src/a.txt`). Assert `sync` is called on the `.git/objects/xx/.yy...minilfs-*` temp file and on `.git/objects/xx` before `.git/refs/heads/main.lock` is renamed, and is NOT called for `src/a.txt`. Fails now (0 `sync` calls on object files/dirs), passes after.

---

## m1 — Directory Recovery Markers Excluded in `hostSkip` and Quarantined on `clearRecovery` (`docs/issues/quarry-run-2026-10-27.md:314`)

- **Design (`src/workspace.ts:607-615, 2052-2072, 3182-3192`, `src/core/tools.ts:388-390`, `src/index.ts:520-522`)**:
  - In `src/workspace.ts:3183-3185`, keep `isRecoveryMarker(rel)` for exact `(^|\/)\.git\/minilfs-recovery$/i` and add `isRecoveryMarkerTree(rel)` matching `(^|\/)\.git\/minilfs-recovery(\.bad-[^/]+)?(\/|$)/i`.
  - In `hostSkip` (`src/workspace.ts:611-614`), drop `!isDir`:
    `if (isRecoveryMarkerTree(rel)) { if (isRecoveryMarker(rel) && rel !== ".git/${RECOVERY_MARKER}") this.nestedMarkers.add(rel); return true; }`
    Both `listImportable` (`src/workspace.ts:3807`) and `scanHostDirectory` (`src/workspace.ts:3883`) skip the directory and its subtree without descending.
  - In `clearRecovery()` (`src/workspace.ts:2058-2064`), `lstat` each marker `abs`: if `st.isDirectory()`, never `rm -r`; instead `rename(abs, "${abs}.bad-${Date.now()}")` and collect the new path in `renamed: string[]` on the return value `{ cleared: recDir, renamed }`. Surface `renamed` in `src/core/tools.ts:390` and `src/index.ts:522`.
- **Edge cases**: Quarantined `.git/minilfs-recovery.bad-<ts>` directories match `isRecoveryMarkerTree`, so subsequent host scans never import them into `main` and `readFolderRecoveryMarker` no longer sees `.git/minilfs-recovery`.
- **Regression test (`tests/review-fixes.test.mjs`)**: Create directory `.git/minilfs-recovery/sub/file.txt` on host. Run `syncHostDriftIntoMain()`: assert `.git/minilfs-recovery/sub/file.txt` is not in `main` (`lfs.fs.stat` fails). Call `s.clearRecovery()`: assert `.git/minilfs-recovery` no longer exists, `.git/minilfs-recovery.bad-<ts>/sub/file.txt` exists intact, and the tool response reports the `.bad-` path. Fails now (subtree imported into `main`; `fsp.rm` without `recursive: true` throws `EISDIR`/`EPERM`), passes after.

---

## m2 — Throttled Non-`fsync` Host Index Checkpoints During `apply` (`docs/issues/quarry-run-2026-10-27.md:315`)

- **Design (`src/bindings.ts:64-72, 250-252`, `src/workspace.ts:2394-2492`)**:
  - In `src/bindings.ts:64-72`, add `durable = true` parameter to `writeFileAtomicSync(target, data, mode = 0o644, durable = true)`: when `!durable`, skip `fsyncSync(fd)` and directory `fsyncSync(dfd)`. Update `BindingStore.writeHostIndex(projectName, index, durable = true)` (`src/bindings.ts:250-252`) to pass `durable`. Outside `applyLocked` (`src/workspace.ts:475, 520, 558`), default `durable = true` remains unchanged.
  - In `applyLocked` (`src/workspace.ts:2394-2492`):
    - Maintain `dirtyIndex = 0` and `lastIndexWrite = Date.now()`, with helper `flushIndex(durable: boolean)` that writes `this.bindings.writeHostIndex(this.projectRecord.name, hostIndex, durable)` and resets both counters.
    - In `put()` (`src/workspace.ts:2426`), increment `dirtyIndex` and call `flushIndex(false)` only when `dirtyIndex >= 200 || Date.now() - lastIndexWrite >= 2000`.
    - In `setRecoveryDir` callback (`src/workspace.ts:2454`, invoked on recovery transitions in `persist()` and `forget()`), call `flushIndex(true)`.
    - Once after all file/git writes complete (at `src/workspace.ts:2474`, replacing `2466`) and in `catch` (`src/workspace.ts:2489`), call `flushIndex(true)`.
- **Edge cases**: An apply of <200 files taking <2 s with no git metadata writes the host index once (`flushIndex(true)` at completion); an aborted apply flushes durably in `catch`.
- **Regression test (`tests/review-fixes.test.mjs`)**: Branch creates 500 working-tree files (`f0.txt`..`f499.txt`). Count `fs.fsyncSync` + `FileHandle.prototype.sync` calls during `await s.apply()`. Assert total fsync count is `<= 10` (2 for final `writeHostIndex` + bindings updates). Fails now (>= 1000 `fsyncSync` calls), passes after.
