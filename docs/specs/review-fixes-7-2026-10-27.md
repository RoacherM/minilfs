# Spec: seventh-round fixes Q1–Q3 (2026-10-27)

Designed by auto/gemini-4-argon from `docs/issues/quarry-run-2026-10-27.md` §12, on decisions fixed by the coordinator. Code wins over line numbers; keep the intent.

### Q1 — Worktree post-rename re-check when `packed-refs` was deleted

**Design (`src/workspace.ts:3678`)**
- In `writeGitLocked` → `restoreForNewWorktrees` (`src/workspace.ts:3670–3708`), change `packedBefore` derivation at `src/workspace.ts:3678` from checking only `installed.has(packedRel)` to checking `installed.has(packedRel) || unlinked.has(packedRel)`:
  `const packedBefore = installed.has(packedRel) || unlinked.has(packedRel) ? packedOf(prev.get(packedRel)?.data) : null;`
- Keep the existing `refFileState` ("no current loose": `src/workspace.ts:3687`) and `packedNow.has(target)` ("no current packed line": `src/workspace.ts:3689`) checks, and keep restoring the ref loose via `putBack(fh, rel, old)` (`src/workspace.ts:3698`).

**Edge cases**
- `packed-refs` unlinked (`next === null`, recorded in `unlinked` at `src/workspace.ts:3737` or `3757`): `prev.get(packedRel)?.data` holds the preimage; `packedNow` reads `null` (`ENOENT`), so any ref that lived only in `packed-refs` is found in `packedBefore` and written loose to `<common>/<target>` (`0o644`), with its parent dir added to `restoredDirs` for `syncParents()`.
- Worktree-local refs (`isWorktreeLocalRef(target)`): still excluded from `packedBefore` (`src/workspace.ts:3693`).
- Ref still present loose or in a rewritten `packed-refs`: skipped before `packedBefore` is consulted.

**Regression test (`tests/review-fixes.test.mjs`)**
- *Setup*: Init repo with `main` and branch `topic`, run `git pack-refs --all --prune` so `refs/heads/topic` exists only in `.git/packed-refs`. Open session; in bash, delete `topic` and `rm -f .git/packed-refs`. Hook `fsp.rm` so when `.git/packed-refs` is unlinked in step 4, `.git/worktrees/wt-new/{HEAD,commondir,gitdir}` is created pointing to `ref: refs/heads/topic`.
- *Assertion*: `s.apply()` warns `/worktree wt-new.*refs\/heads\/topic.*restored/`, `.git/refs/heads/topic` exists loose with `topic`'s OID, and `git rev-parse topic` succeeds. (Fails now: `installed.has(".git/packed-refs")` is false when unlinked; passes after.)

---

### Q2 — Object directory fsync fence covers unchanged planned objects

**Design (`src/workspace.ts:2431–2481`)**
- In `applyLocked`, seed `objectDirs` (`src/workspace.ts:2431`) not only from `put()` (`src/workspace.ts:2449, 2460`), but also from every `found` entry with `f.git === "object"` and `f.next !== null` (including those classified `"unchanged"` at `src/workspace.ts:2371` and omitted from `gitPlan`).
- For each such entry `f.rel`, walk `dirname(join(this.cwd, f.rel))` up to `<cwd>/<gitDir>/objects` (inclusive, discovered via `resolveGitPath(f.rel, layout).gitDir`), adding existing directories (including `objects/<xx>`, `objects/pack`, `objects/info`) to `objectDirs` so the fence loop `for (const d of objectDirs) await fsyncDir(d)` (`src/workspace.ts:2480`) fsyncs them before `writeGitLocked`. Bounded by ≤ ~258 dirs per git dir.
- Do not re-fsync unchanged object/pack/idx files. Add a comment at `src/workspace.ts:2479`: an earlier interrupted apply already `writeFileDurable`-fsynced the file's bytes before renaming it into place (`put()`, M3); only the directory entry (`rename`) may still be unfenced in the OS cache when the retry sees the file as `unchanged`, so directory `fsync` suffices.

**Edge cases**
- Unchanged loose objects (`objects/xx/yy...`), pack/idx files (`objects/pack/*`), or `objects/info/*` from an interrupted apply: `decideGitPath` returns `"unchanged"`, skipping `put()`, yet their parent dirs are still in `objectDirs` and fenced before refs/index lock/rename.
- Planned object deletion (`f.next === null`) or missing directory on disk: `fsyncDir` only runs on existing directories (or ignore `ENOENT`).

**Regression test (`tests/review-fixes.test.mjs`)**
- *Setup*: Create commit `c2` in the Branch. Simulate an interrupted first apply by copying the new loose objects from the Branch into host `.git/objects/<xx>/` without updating `.git/refs/heads/main`. Spy on `FileHandle.prototype.sync` as in test M3 (`tests/review-fixes.test.mjs:2084`). Run `s.apply()`.
- *Assertion*: Every `c2` object's `.git/objects/<xx>` directory receives `sync` before `.git/refs/heads/main` is renamed into place, while the unchanged object files themselves are not re-written. (Fails now: `gitObjects` is empty on retry so `objectDirs` is empty; passes after.)

---

### Q3 — Durable `mainStale` before host mutation and missing/corrupt host-index fallback

**Design (`src/workspace.ts:492–498, 2418–2575`, `src/bindings.ts:264–273`)**
- **`src/bindings.ts`**: Add `readHostIndexOrNull(projectName: string): HostIndex | null` (or return `{ index: HostIndex; ok: boolean }`) that returns `null` when `manifestFile(projectName)` does not exist or `JSON.parse` throws (`src/bindings.ts:264–268`); keep `readHostIndex` returning `{}` for callers that want an empty map, or update callers.
- **`src/workspace.ts` (`applyLocked`)**:
  - Record `const wasMainStale = Boolean(this.bindings.byName(this.projectRecord.name)?.mainStale || this.projectRecord.mainStale);` before mutations.
  - In `put()` (before the first host mutation, when `!hostTouched` at `src/workspace.ts:2434`) and before `writeGitLocked` when `ordered` was empty (`src/workspace.ts:2493`), set `hostTouched = true` and durably mark stale once: `if (!wasMainStale) this.markMainStale();` (`bindings.setMainStale(name, true)` does one durable `bindings.json` write).
  - Fix the comment above `flushIndex` (`src/workspace.ts:2420–2422`): state that checkpoints are non-durable because `mainStale` is set durably before the first host write, and a missing/unreadable host index forces a full comparison against `main`.
  - At the end of a successful apply (after `flushIndex(true)` and successful `publish` to `main`, `src/workspace.ts:2575`), if `!wasMainStale && !gitDiverged`, clear `mainStale` (`this.bindings.setMainStale(this.projectRecord.name, false); this.projectRecord.mainStale = false;`).
- **`src/workspace.ts` (`syncHostDriftIntoMain`, `src/workspace.ts:492–498`)**:
  - Read host index via `readHostIndexOrNull`. Set `const full = options.full || Boolean(this.bindings.byName(this.projectRecord.name)?.mainStale || this.projectRecord.mainStale) || hostIdx === null;`. When `full` is true, `prev` is `await this.mainIndex()`, so deletions on the host relative to `main` are detected and removed from `main`.

**Edge cases**
- Apply with no host changes (`ordered.length === 0` and `gitMeta.length === 0` or `missing` objects): `hostTouched` stays false; `mainStale` is not flipped.
- Project was already `mainStale === true` before `applyLocked`: `wasMainStale` is true, so `mainStale` remains `true` after apply until `syncHostDriftIntoMain` runs a full sync.
- Corrupt/truncated or missing `manifests/<project>.json` with `mainStale === false`: `hostIdx === null` forces `full = true` (`prev = await this.mainIndex()`).

**Regression test (`tests/review-fixes.test.mjs`)**
- *Setup*: Import project with `a.txt`, open session. Delete `a.txt` on the host, and corrupt `s.bindings.manifestFile(s.project)` with `"{corrupt"` (or unlink it) while `mainStale` is `false`. Run `await s.syncHostDriftIntoMain()`. Also test aborting `apply()` on the 2nd file in `put()` and verifying `s.bindings.byName(s.project).mainStale === true` was persisted before the first file mutation completed.
- *Assertion*: `sync.synced` includes `"a.txt"` and `s.lfs.fs.stat("main", "/a.txt")` rejects (`ENOENT`). (Fails now: `readHostIndex` returns `{}`, so `prev` is `{}` and `removed` is `[]`, leaving `a.txt` in `main`; passes after.)
