# Spec: extract src/gitapply.ts, fix R1 (2026-10-28)

Designed by auto/gemini-4-argon. Q3 (§12) was already fixed in d407762; this spec covers the
refactor and R1 (§13). Code wins over line numbers; keep the intent.


## Commit A — Extract git-metadata apply transaction to `src/gitapply.ts`

### 1. Exact Moved Set (`src/workspace.ts:2884-3850` → `src/gitapply.ts`)
Move the contiguous block `src/workspace.ts:2884-3850` (keep all function/type/const names and bodies verbatim; exclude `cleanRef` at `src/workspace.ts:2887`):
- **Signature & host helpers** (`2884-2908`): `sameSig`, `fileSig`, `linkSig`, `type RawEntry`, `readRawEntry`, `hostState` (plus the 1-line `const sha` helper from `src/workspace.ts:171`, kept in both files).
- **Ref-graph & object validation** (`2914-3274`): `type RefFileState`, `type GitReads`, `refFileState`, `worktreeList`, `sameRefFileState`, `type GitWrite`, `cleanGitEnv`, `SYMREF_MAX_HOPS`, `MAX_SYMREF_SCAN_FILES`, `commonGitDir`, `isWorktreeLocalRef`, `isHeadName`, `type ResolvedRef`, `refsAfter`, `gitObjectsMissing`.
- **Recovery markers & durable I/O** (`3279-3343`): `type GitRecovery`, `RECOVERY_MARKER`, `RECOVERY_MARKER_RX`, `isRecoveryMarker`, `isRecoveryMarkerTree`, `readFolderRecoveryMarker`, `recoveryPendingError`, `recoveryMarkersFor`, `foundRecoveryMarkers`, `fsyncDir`, `writeFileDurable`.
- **Lock transaction & ref-dir cleanup** (`3358-3850`): `writeGitLocked`, `removeEmptyGitRefParents`, `depthOf`.

### 2. What Stays in `src/workspace.ts` and Why
- `LayerfsSession` methods (`applyLocked`, `clearRecovery`, `recoveryDir`, `adoptRecovery`, `markMainStale`, `readRawEntriesAtBranch`, `branchObjectTypes`, `joinGitHistories`), `cleanRef` (`2887`), `removeEmptyParents` (`3852`), and all Store/Sandbox/Binding/Seatbelt helpers — they touch `this`, `BindingStore`, `ProjectClient`, or workspace mounts.

### 3. Public Interface of `src/gitapply.ts`
- **Exported functions/consts**: `sameSig`, `fileSig`, `linkSig`, `readRawEntry`, `hostState`, `refFileState`, `refsAfter`, `cleanGitEnv`, `gitObjectsMissing`, `RECOVERY_MARKER`, `isRecoveryMarker`, `isRecoveryMarkerTree`, `readFolderRecoveryMarker`, `recoveryPendingError`, `recoveryMarkersFor`, `foundRecoveryMarkers`, `fsyncDir`, `writeFileDurable`, `writeGitLocked`, `removeEmptyGitRefParents`.
- **Exported types**: `RawEntry`, `RefFileState`, `GitReads`, `GitWrite`, `GitRecovery`.

### 4. Circularity (`src/errors.ts`), Imports & Re-exports
- `recoveryPendingError` (`src/workspace.ts:3306`) and `writeGitLocked` (`src/workspace.ts:3594`) construct `LayerfsError`. Move `export class LayerfsError` (`src/workspace.ts:143-151`) to a new 10-line `src/errors.ts` so `src/gitapply.ts` never imports `src/workspace.ts`.
- `src/gitapply.ts` imports only node built-ins (`node:crypto`, `node:fs`, `node:path`), `type HostEntry` from `./bindings.ts`, `{ run }` from `./core/exec-helper.ts`, `{ expectedType, GIT_APPLY_ORDER, gitSig, isValidGitRefName, parseIndexEntries, resolveGitPath, splitGitPath, type GitLayout, type GitPathKind }` from `./gitpaths.ts`, and `{ LayerfsError }` from `./errors.ts`.
- `src/workspace.ts` imports `{ LayerfsError }` from `./errors.ts` and `{ cleanGitEnv, fileSig, foundRecoveryMarkers, fsyncDir, gitObjectsMissing, hostState, isRecoveryMarker, isRecoveryMarkerTree, linkSig, readFolderRecoveryMarker, readRawEntry, RECOVERY_MARKER, recoveryMarkersFor, recoveryPendingError, sameSig, writeFileDurable, writeGitLocked, type GitReads, type RawEntry }` from `./gitapply.ts`.
- **Re-exports for compatibility**: `src/workspace.ts` re-exports `export { LayerfsError } from "./errors.ts"` and `export { RECOVERY_MARKER, isRecoveryMarker, isRecoveryMarkerTree, readFolderRecoveryMarker } from "./gitapply.ts"`. (`tests/elevate.test.mjs:19` and `src/core/index.ts:10` import `LayerfsError` from `workspace.ts`; no tests import the other moved helpers directly.)

### 5. Pure-Move Verification
- `git diff --color-moved=zebra --color-moved-ws=ignore-all-space --stat` and `git diff --color-moved=dimmed-zebra` must show `src/workspace.ts:2884-3850` and `143-151` as pure moved blocks into `src/gitapply.ts` and `src/errors.ts`, with only import/export lines added.
- Run full test suite (`node --test` / test scripts across `tests/*.test.mjs`).

---

## Commit B — R1 Fix: Preflight `objectDirs` readability before first host mutation (`docs/issues/quarry-run-2026-10-27.md` §13)

### 1. Problem & Design
In `LayerfsSession.applyLocked` (`src/workspace.ts:2459-2515`), `objectDirs` collects every ancestor of every `f.git === "object" && f.next` path up to `this.cwd`, then calls `fsyncDir(d)` (`fsp.open(d, "r")`) **after** the `ordered` loop has already mutated the host via `put()`. If an existing ancestor directory has mode `0o311` (`-wx--x--x`: traversable and writable, not readable), `lstat`/`readRawEntry`/`put()` succeed, sources and objects are written to the host, and `fsyncDir(d)` throws `EACCES` before `gitMeta` is applied (`PartialApply`).

**Fix (refuse the whole apply up front, before any host mutation):**
1. Add helper `preflightDirsReadable(dirs: Iterable<string>): Promise<void>` in `src/gitapply.ts` (or inline next to `fsyncDir`): for each `d` (sorted deepest-first or insertion order), `fsp.open(d, "r")` then immediately `dh.close()`; ignore `ENOENT` and `ENOTDIR` (directories not yet created will be created by `mkdir(..., { recursive: true })` with `0o755`, readable by us); on any other error (e.g. `EACCES`, `EPERM`), throw `new LayerfsError(e.code ?? "EACCES", \`cannot open folder ${d} to sync git objects (${e.code ?? e.message}); nothing was written\`)`.
2. In `applyLocked` (`src/workspace.ts:2459-2501`), compute `objectDirs` and `await preflightDirsReadable(objectDirs)` **before** entering the `for (const { rel, next, host, git } of ordered)` loop (before `touchHost()` and the first `put()`), outside the `PartialApply` `try/catch` (or rethrown before `hostTouched` so nothing is written and `mainStale` is not set).

### 2. Edge Cases
- **Non-existent sub-directories** (e.g. `.git/objects/ab` for a new fanout prefix): `open(d, "r")` rejects with `ENOENT`, ignored by preflight; `put()` later creates it readable.
- **File replaced by directory in the same apply**: `open(d, "r")` rejects with `ENOTDIR`, ignored by preflight.
- **No git objects in `found`**: `objectDirs` is empty; preflight is a no-op (even if an unrelated directory is `0o311`).
- **Existing ancestor unreadable (`0o311`, e.g. `sub` or `sub/.git`)**: preflight fails before `touchHost()`, no source file or git object is written, `mainStale` remains `false`.

### 3. Regression Test (`tests/review-fixes.test.mjs`)
Add step `"R1 an unreadable ancestor of a git objects folder refuses apply before any file is written"`:
1. Create project `cwd` with nested repo `sub` (`sub/.git`, `sub/s.txt`), commit in both; open session `s`.
2. In the Branch, modify `a.txt` (top-level source file) and make a new commit in `sub` (creates new objects under `sub/.git/objects/..`).
3. On the host, `chmodSync(join(cwd, "sub"), 0o311)` (traverse+write, no read).
4. Assert `await s.apply()` rejects with `/EACCES|cannot open/` (and in `finally`, restore `chmodSync(join(cwd, "sub"), 0o755)`).
5. Assert host `readFileSync(join(cwd, "a.txt"), "utf8")` is unchanged, `s.bindings.byName(s.project).mainStale ?? false` is `false`, and after restoring `0o755`, `await s.apply()` succeeds cleanly.
