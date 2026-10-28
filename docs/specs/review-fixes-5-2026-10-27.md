# Spec: fifth-round fixes P1–P9 (2026-10-27)

Designed by auto/gemini-4-argon from `docs/issues/quarry-run-2026-10-27.md` §10. Code wins over line
numbers; keep the intent.

**Correction to §2 (P2), decided here — the designer's text below wavers between two options:**
a moved folder must NOT make the session fail to open (then `/minilfs recover --clear` has no session
to run in, and the only way out would be deleting a file by hand). Rule:
- On open / fresh import, if `<git dir>/minilfs-recovery` exists, adopt its path into the project
  record's `recoveryDir` (and never import the marker into main: `hostSkip` excludes it).
- `applyLocked` (and `syncHostDriftIntoMain`'s publishing step if it would overwrite main's .git)
  refuse `RecoveryPending` while `recoveryDir` is set OR the marker exists.
- `clearRecovery` (lead only) removes the marker, the recovery folder and the record in one step
  (P9: one bindings write that sets mainStale and clears recoveryDir).
- Status / `minilfs action=status` shows the pending recovery and how to clear it.

# Spec: Fifth-Round Review Fixes P1–P9 (2026-10-27)

Context: addresses findings P1–P9 in `docs/issues/quarry-run-2026-10-27.md:280-303` (§10, reviewing `ab1ed08..4fce1c4`). Implement in one or two commits.

---

## 1. P1 (Major) — Lock and Re-Verify Read Dependencies of the Ref Graph (`src/workspace.ts:2784-3016, 3040-3350`)

### Design
1. **Return the read dependency set from `gitObjectsMissing` (`src/workspace.ts:2792-3016`)**:
   - Change signature to:
     ```ts
     type GitReadDep = { rel: string; raw: Buffer | null };
     async function gitObjectsMissing(
       cwd: string,
       meta: GitWrite[],
       layout?: GitLayout,
     ): Promise<{ error: string | null; reads: Map<string, Buffer | null> }>
     ```
   - In `refsAfter(cwd, common, meta, layout)` (`src/workspace.ts:2792-2863`):
     - Track `reads = new Map<string, Buffer | null>()` (keyed by project-relative path `rel`, e.g. `${common}/HEAD`, `${common}/packed-refs`, `${common}/worktrees/w/HEAD`, `${common}/refs/heads/main`, where `null` means absent on host).
     - Whenever `packed-refs` is NOT in `planned` (`!packedPlan`) and is read from host (`src/workspace.ts:2812`), record `reads.set("${common}/packed-refs", bufOrNull)`.
     - Whenever `hostLoose(name)` (`src/workspace.ts:2816-2821`) is called by `lookup(name)` during `resolve(start)` for a chain that is actually validated (`view.touched.has(name) || r.chain.some((n) => view.touched.has(n))`, `src/workspace.ts:2945`) — including `HEAD`, each `worktrees/<id>/HEAD`, and every unchanged symbolic predecessor or target along that chain — record `reads.set("${common}/${name}", bufOrNull)`.
   - Also record `${dir}/HEAD` in `reads` when `d.unborn` is checked (`src/workspace.ts:2998`).
   - Exclude any path already in `locked` (`items` passed to `writeGitLocked`, which `take()` already locks and verifies against `it.host`).
2. **Hold read `.lock` files and verify bytes in `writeGitLocked` Phase 1 (`src/workspace.ts:3040-3350`)**:
   - Pass `reads: Map<string, Buffer | null>` into `writeGitLocked`.
   - Define `takeRead(rel: string, expected: Buffer | null): Promise<string | null>`:
     - `const target = join(cwd, rel); await ensureDir(posix.dirname(rel));`
     - Open `${target}.lock` with `"wx"` (`0o644`); on `EEXIST` return `"${rel}.lock exists: git is running there"`. Add `${target}.lock` to `held` (never added to `writes` or `deletes`, so never renamed or unlinked).Close `fh` immediately.
     - Read current host state `raw = await readRawEntry(target)`.
     - If `expected === null`: if `raw !== null` (unless `raw === "other"` is a directory of refs when `rel` is a ref prefix), return `"${rel} changed"`.
     - If `expected !== null`: if `!raw || raw === "other" || !("data" in raw) || !raw.data.equals(expected)`, return `"${rel} changed"`.
   - In Phase 1 (`src/workspace.ts:3271`), merge write items (`!deferred.has(i)`) and `reads` entries into a single lexicographically sorted lock acquisition pass by `rel` (preventing lock-order deadlocks).
   - Release all read `.lock` files along with deletion locks at the end of Phase 4 (`for (const l of [...held]) await unlockWarn(l)`, `src/workspace.ts:3310-3318`) and in `release()` / `rollback()`.

### Edge Cases
- A read dependency is a ref inside a directory that does not exist yet on host (`expected === null`, e.g., `HEAD -> refs/heads/unborn/branch`): `ensureDir` records `createdDirs`, locks `refs/heads/unborn/branch.lock`, verifies absence, and `removeCreatedDirs()` cleans up empty dirs after unlocking at the end of Phase 4.
- Host `git checkout topic` runs between `gitObjectsMissing` and `writeGitLocked` while Branch deletes `topic`: `.git/HEAD` is in `reads`; either `HEAD.lock` is held by git or `HEAD`'s bytes differ from `expected`, returning `".git/HEAD changed"` (`moved`) and skipping git metadata with a warning.

### Regression Test
- `tests/review-fixes.test.mjs`: Repo with `main` and `topic`; Branch deletes `topic` (`git branch -D topic`). Hook `fsp.open` so that the first time `.git/HEAD.lock` (or `.git/refs/heads/topic.lock`) is opened in `writeGitLocked`, the hook writes `ref: refs/heads/topic\n` to host `.git/HEAD` before the lock is checked. Assert `await s.apply()` skips git metadata with `ap.warnings` matching `/moved while applying \(\.git\/HEAD changed\)/`, leaving host `refs/heads/topic` intact (`git Symbolic-ref HEAD` resolves). Fails now (`HEAD` is not locked/re-checked, `topic` is deleted, `HEAD` dangles), passes after.

---

## 2. P2 (Major) — Repo-Local `.git/minilfs-recovery` Marker Surviving Folder Moves (`src/gitpaths.ts:28-88`, `src/workspace.ts:360-480, 2007-2026, 2198-2207, 3229-3265`)

### Design
1. **Protection in `src/gitpaths.ts` (`src/gitpaths.ts:28-88`)**:
   - Writing `<gitDir>/minilfs-recovery` inside the user's `.git` is safe: git ignores unknown top-level files in `.git`, and `GIT_ALLOWED_BODY` (`src/gitpaths.ts:28-52`) does NOT list `minilfs-recovery`. Thus `gitPathKind(".git/minilfs-recovery")` (and `.git/modules/*/minilfs-recovery`, `.git/worktrees/*/minilfs-recovery`) is already `"protected"` — Seatbelt denies sandbox writes, file tools refuse it (`isProtectedPath`), and `apply` / `syncHostDriftIntoMain` skip or ignore it (`hostSkip` must also exclude `(^|\/)\.git\/minilfs-recovery$` so host drift never imports it into `main`).
2. **Write marker before first mutation, remove on `forget()` and `clearRecovery()` (`src/workspace.ts:3229-3265`)**:
   - Define `recoveryMarkerPaths(cwd: string, items?: GitWrite[], layout?: GitLayout): string[]`: returns `join(cwd, ".git", "minilfs-recovery")` whenever `join(cwd, ".git")` is a directory, plus `join(cwd, gitDir, "minilfs-recovery")` for any affected `gitDir` in `items`.
   - In `writeGitLocked`'s `persist()` (`src/workspace.ts:3230-3250`), before the first target unlink/rename, write `dir + "\n"` to each marker path (and fsync per P3) in addition to `recovery.setRecoveryDir(dir)`.
   - In `forget()` (`src/workspace.ts:3252-3260`, called on clean commit or complete `rollback()`), remove the marker file(s) (`fsp.rm(m, { force: true })`) before clearing `setRecoveryDir(null)`. If `rollback()` fails (`RollbackIncomplete`), the marker file stays in `.git/minilfs-recovery`.
3. **Check marker on `applyLocked` AND `open` / `initProjectForFolder` (`src/workspace.ts:367-425, 2011-2026, 2198-2207`)**:
   - Helper `readFolderRecoveryMarker(cwd: string): string | null`: reads `join(cwd, ".git", "minilfs-recovery")` if present and returns its trimmed path (or `join(cwd, ".git", "minilfs-recovery")` if empty).
   - In `applyLocked` (`src/workspace.ts:2200`): check `const recDir = this.bindings.byName(this.projectRecord.name)?.recoveryDir || readFolderRecoveryMarker(this.cwd);` — if truthy, throw `LayerfsError("RecoveryPending", ...)`.
   - In `initProjectForFolder` (`src/workspace.ts:411`, before staging/importing a moved or newly bound folder): if `const recDir = readFolderRecoveryMarker(this.cwd)`, throw `LayerfsError("RecoveryPending", ...)` (and in `open()`, if `existing` exists and `readFolderRecoveryMarker(this.cwd)` is set while `existing.recoveryDir` is unset, persist `this.bindings.setRecoveryDir(existing.name, recDir)` so `s.recoveryDir` and `action="recover"` work after a move).
   - Actually, to allow `/minilfs recover --clear` on a moved folder: in `open()` (`src/workspace.ts:367`), do NOT refuse `open()`; let `initProjectForFolder` import (excluding `.git/minilfs-recovery` via `hostSkip`) and immediately copy `readFolderRecoveryMarker(this.cwd)` into `record.recoveryDir`! And in `initProjectForFolder`, before `syncHostDriftIntoMain` or `applyLocked`, refuse `syncHostDriftIntoMain` and `applyLocked` with `RecoveryPending` whenever `this.recoveryDir` (which checks `bindings...recoveryDir ?? readFolderRecoveryMarker(this.cwd)`) is non-null. Wait: the prompt specifies: *"On apply AND on fresh import, if `.git/minilfs-recovery` exists, refuse RecoveryPending naming it; clearRecovery removes it."*
   - Follow the prompt literally:
     - In `initProjectForFolder` (`src/workspace.ts:414`, before `reserveProjectName`), if `const m = readFolderRecoveryMarker(this.cwd)`, throw `LayerfsError("RecoveryPending", ...)` naming `m` (and `.git/minilfs-recovery`).
     - In `applyLocked` (`src/workspace.ts:2200`), check `const recDir = this.bindings.byName(this.projectRecord.name)?.recoveryDir ?? readFolderRecoveryMarker(this.cwd)`.
     - In `get recoveryDir()` (`src/workspace.ts:2024`) and `clearRecovery()` (`src/workspace.ts:2011`), read `this.bindings?.byName(this.projectRecord?.name)?.recoveryDir ?? readFolderRecoveryMarker(this.cwd)`, and in `clearRecovery()` also `await fsp.rm(join(this.cwd, ".git", "minilfs-recovery"), { force: true }).catch(() => {})`.

### Edge Cases
- Folder moved (`mv repo repo2`) after `RollbackIncomplete`: `repo2/.git/minilfs-recovery` moves with the folder; opening a new session in `repo2` hits `initProjectForFolder` and throws `RecoveryPending` naming the recovery dir; calling `clearRecovery()` on a session (or removing `.git/minilfs-recovery`) clears it.
- `gitPathKind(".git/minilfs-recovery") === "protected"` and `isProtectedPath(".git/minilfs-recovery") === true`.

### Regression Test
- `tests/review-fixes.test.mjs`: Trigger `RollbackIncomplete` in `cwd`, assert `existsSync(join(cwd, ".git/minilfs-recovery")) === true` and `gitPathKind(".git/minilfs-recovery") === "protected"`. Rename `cwd` to `cwd2 = "${cwd}-moved"`. Assert opening a new `LayerfsSession` at `cwd2` rejects in `open()` (`initProjectForFolder`) with `code === "RecoveryPending"` naming `recDir`, and `s.clearRecovery()` removes `.git/minilfs-recovery`. Fails now (`cwd2` imports cleanly and applies over broken `.git`), passes after.

---

## 3. P3 (Major) — `fsync` Durability for Recovery State, Bindings, and Target Parent Dirs (`src/bindings.ts:116-122`, `src/workspace.ts:3230-3320`)

### Design
1. **Helpers (`src/bindings.ts` and `src/workspace.ts`)**:
   - Sync helper in `src/bindings.ts`:
     ```ts
     function writeFileAtomicSync(target: string, data: string | Buffer, mode = 0o644): void {
       const tmp = `${target}.${process.pid}.tmp`;
       const fd = openSync(tmp, "w", mode);
       try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
       renameSync(tmp, target);
       const dfd = openSync(dirname(target), "r");
       try { fsyncSync(dfd); } finally { closeSync(dfd); }
     }
     ```
     Use `writeFileAtomicSync` in `BindingStore.save()` (`src/bindings.ts:116-122`) and `BindingStore.writeHostIndex()` (`src/bindings.ts:226-231`).
   - Async helpers in `src/workspace.ts`:
     - `fsyncDir(dir: string)`: `const dh = await fsp.open(dir, "r"); try { await dh.sync(); } finally { await dh.close(); }`
     - `writeFileSyncDurable(dst: string, data: Buffer | string, mode = 0o644)`: open `dst` with `"w"`, `fh.writeFile(data)`, `fh.chmod(mode)`, `fh.sync()`, `fh.close()`.
2. **Pre-mutation `persist()` in `writeGitLocked` (`src/workspace.ts:3230-3250`)**:
   - Write each preimage file via `writeFileSyncDurable` and collect its parent directories.
   - Write `join(dir, "manifest.json")` via `writeFileSyncDurable`.
   - `fsyncDir` every created preimage directory, `dir`, and `recovery.root` (`dirname(dir)`).
   - Write `.git/minilfs-recovery` via `writeFileSyncDurable` and `fsyncDir(join(cwd, ".git"))`.
   - Call `recovery.setRecoveryDir(dir)` (which runs `BindingStore.save()`, fsyncing `bindings.json` and `stateDir`).
3. **Post-mutation parent directory `fsync` before `forget()` (`src/workspace.ts:3300-3318`)**:
   - Also `await fh.sync()` on each `.lock` file in `take()` (`src/workspace.ts:3093`) and `putBack()` (`src/workspace.ts:3125`) before closing/renaming.
   - After all target deletions and `fsp.rename(lockOf(w.rel), join(cwd, w.rel))` complete in Phase 4 (`src/workspace.ts:3310`) — and before calling `await forget()` — call `await fsyncDir(join(cwd, d))` for every unique parent directory `posix.dirname(it.rel)` of `items`.
   - Note: Node exposes `fsync` (not macOS `F_FULLFSYNC`); `fsync` on file handles and `open(dir, "r") + sync()` on APFS directories is the accepted contract.

### Edge Cases
- If `fsync` fails during `persist()`, the `catch` block cleans up `recDir`, marker, and locks before any target mutation occurs.

### Regression Test
- `tests/elevate.test.mjs` (or `tests/review-fixes.test.mjs`): Spy on ` fsp.open` / `FileHandle.prototype.sync` and `fs.fsyncSync` during an `apply()` that updates `.git/refs/heads/main`: assert `sync` was called on the preimage file, `manifest.json`, `.git/minilfs-recovery`, `recDir`, `.git/refs/heads/main.lock`, and `.git/refs/heads` (parent dir) in order before `forget()` removes `recDir`. Fails now (0 `sync`/`fsyncSync` calls), passes after.

---

## 4. P4 (Minor) — Case-Insensitive Loose-Ref Alias Detection (`src/workspace.ts:2792-2863, 2874-2960`)

### Design
- **Fix (~15 lines in `src/workspace.ts`)**:
  - In `gitObjectsMissing` per `common` git dir, detect case-insensitivity once:
    ```ts
    const stU = await fsp.lstat(join(cwd, common, "HEAD")).catch(() => null);
    const stL = stU ? await fsp.lstat(join(cwd, common, "head")).catch(() => null) : null;
    const caseFold = Boolean(stU && stL && stU.dev === stL.dev && stU.ino === stL.ino);
    ```
  - When `caseFold` is true: collect all loose ref paths under `common` (both planned in `meta` and existing loose files walked under `join(cwd, common, "refs")`, plus packed-refs names that also have a case-variant loose ref). Check a `Map<string, string>` from `ref.toLowerCase()` to `ref`: if two distinct ref names (`a !== b`) map to the same `a.toLowerCase()` and at least one is touched in `meta`, return `"${common}/${a} and ${common}/${b} differ only in case on a case-insensitive filesystem"` (which triggers `dropMeta`: warns and writes no git metadata).

### Regression Test
- `tests/review-fixes.test.mjs`: On APFS, host has `refs/heads/main` (packed into `packed-refs` so loose creation in Branch or packed-refs addition can create both `refs/heads/main` and `refs/heads/Main` in `meta`). Apply a Branch change that writes `refs/heads/Main`: assert `ap.warnings[0]` matches `/differ only in case/` and host refs are untouched. Fails now, passes after.

---

## 5. P5–P9 (Minors) — Decisions

### P5 — Linked-worktree `refs/worktree/*` resolved in common dir (`src/workspace.ts:2777-2828`)
- **Decision: Fix (~8 lines)**.
- **Design**: Per-worktree refs are `HEAD`, `refs/bisect/*`, `refs/rewritten/*`, and `refs/worktree/*` (`isWorktreeLocalRef(tail)`). In `refsAfter` (`src/workspace.ts:2799`), prefix worktree-local refs from `worktrees/<id>` as `worktrees/<id>/${tail}`; in `resolve(start)` (`src/workspace.ts:2827`), when `start` starts with `worktrees/<id>/` and a hop targets `m[1]` matching `^(HEAD|refs/(bisect|rewritten|worktree)(/|$))`, resolve it as `worktrees/<id>/${m[1]}` (which `hostLoose` reads at `join(cwd, common, name)` and never falls back to `common/packed-refs`).
- **Regression Test** (`tests/elevate.test.mjs` or `tests/review-fixes.test.mjs`): Linked worktree `.git/worktrees/wt1/HEAD` points to `ref: refs/worktree/x` where `.git/worktrees/wt1/refs/worktree/x` is a blob oid: assert `gitObjectsMissing` refuses with `is a blob, not a commit`. Fails now (looked up in `common/refs/worktree/x` as missing), passes after.

### P6 — Dangling `refs/remotes/*/HEAD` after prune; unborn HEAD when another branch gains first commit (`src/workspace.ts:2948-2958, 2998-3002`)
- **Decision: Fix (~6 lines)**.
- **Design**:
  1. In `gitObjectsMissing` (`src/workspace.ts:2952`), when `r.kind === "missing"` and `name` is an unchanged symbolic `refs/remotes/*/HEAD` (`!view.touched.has(name) && /^refs\/remotes\/[^/]+\/HEAD$/.test(name)`), allow it (continue) instead of refusing all metadata when a remote branch was pruned.
  2. In `src/workspace.ts:2998-3002`, an unborn `HEAD` (`HEAD -> refs/heads/main` where `refs/heads/main` does not exist) is valid in git even when another branch (e.g. `refs/heads/other` or `refs/minilfs/*`) has commits (`git checkout --orphan`), as long as `r.target` was not deleted in `meta` (`!r.chain.some((n) => deleted.has(n))`, already checked at line `2954`). Remove the `if (d.unborn)` rev-list rejection block (`src/workspace.ts:2998-3002`) and `unborn` field: line `2954` already refuses when `HEAD`'s target branch was deleted by `meta`, while an untouched unborn/orphan `HEAD` stays valid when another ref is added.
- **Regression Test** (`tests/review-fixes.test.mjs`): (1) Host has `refs/remotes/origin/HEAD -> refs/remotes/origin/old` and Branch deletes `refs/remotes/origin/old`: apply succeeds cleanly. (2) Empty repo (`HEAD -> refs/heads/main`, unborn), Branch creates `refs/heads/feat` commit without touching `main`: apply writes `refs/heads/feat` cleanly. Both fail now, pass after.

### P7 — Rescue fallback of a fallback root leaves the recognised namespace (`src/gitpaths.ts:461-505`)
- **Decision: Fix (2 lines)**.
- **Design**: In `allocateRescueRef` (`src/gitpaths.ts:499`), replace `const from = ancestor === "refs/minilfs" ? "refs/minilfs-rescue" : ancestor;` with `const from = /^refs\/minilfs(-rescue.*)?$/.test(ancestor) ? "refs/minilfs-rescue" : ancestor;`. That way, if `ancestor` is already a top-level rescue root (e.g., `refs/minilfs-rescue`), `names("refs/minilfs-rescue")` always generates `refs/minilfs-rescue-<oid12>`, never `refs/minilfs-rescue-<oid12>-<oid12>`.
- **Regression Test** (`tests/elevate.test.mjs`): Call `allocateRescueRef(new Map([["refs/minilfs-rescue", other]]), "refs/minilfs-rescue/w1/heads/main", oid)`: assert `a.ref` matches `^refs/minilfs-rescue-[0-9a-f]{12}/` and `isRescueRef(a.ref) === true`. Fails now, passes after.

### P8 — Error responses omit accumulated lock warnings (`src/workspace.ts:2422-2436`, `src/core/tools.ts:390-398`, `src/index.ts:496-505`)
- **Decision: Fix (~4 lines)**.
- **Design**: `applyLocked`'s `catch` (`src/workspace.ts:2433`) already attaches `(err as any).result = result` (which contains `result.warnings`). In `executeLayerfsApply` (`src/core/tools.ts:394-396`) and `/minilfs apply` (`src/index.ts:500-504`), append `partial?.warnings?.length ? " (warnings: " + partial.warnings.join("; ") + ")" : ""` to the error message.
- **Regression Test** (`tests/review-fixes.test.mjs`): Force `writeGitLocked` to throw after pushing a lock removal warning to `result.warnings`; assert `executeLayerfsApply(s)` rejects with a message containing that warning. Fails now, passes after.

### P9 — `clearRecovery` clears the guard before marking `mainStale` (`src/workspace.ts:2011-2021`)
- **Decision: Fix (3 lines)**.
- **Design**: In `LayerfsSession.clearRecovery()` (`src/workspace.ts:2011-2021`), set `this.projectRecord.mainStale = true` and `this.projectRecord.recoveryDir = null`, then perform a single atomic `this.bindings.update((d) => { const p = d.projects[this.projectRecord.name]; if (p) { p.mainStale = true; delete p.recoveryDir; } })` before removing the marker and `recDir`.
- **Regression Test** (`tests/elevate.test.mjs`): Call `clearRecovery()` and assert `bindings.update` / `save` runs once with `mainStale === true` and `recoveryDir === undefined` in the same write. Fails now (two writes, `recoveryDir` cleared first), passes after.
