# Spec: review fixes R1–R18 (2026-10-27)

Designed by gemini-4-argon from `docs/issues/quarry-run-2026-10-27.md` §6. Implementer: follow it;
where a line number below disagrees with the code, the code wins (the spec cites approximate lines).

Checked before handing off:
- R13: `-c attr.tree=<empty tree>` stops a `filter.*.clean` from `.git/config` + `.gitattributes`
  during `update-index --add` (verified with git 2.56: without it the filter ran, with it not).
- R2: the SDK texts are in `/private/tmp/minilfs-bundle-v110/api/agent/sdk/src/transport/worker_client.js`:
  unsent = "…the call was not sent", "the LayerFS worker did not answer … the call was not sent",
  "the LayerFS worker is not running…"; lost after send = "the connection to the LayerFS worker was
  lost … after the call was sent; it may have completed".
- Corrections to the spec text: the LayerFS commit is `a700af8f492ef360d150877e5d469031767e473f`
  (layerfs.json), not `a700af83…`; `src/bundle.json` has only `darwin-arm64`.

---

## 1. R1 — host-backed file-tool private-path guard (Blocker)

Add `export function isPrivateMinilfsPath(abs, config: { root; bundle }): boolean` (every spelling of
`config.root` and `config.bundle` via `bothSpellings`) and `LayerfsSession.resolveOutsideRead(hostPath):
Promise<string>`: `abs = resolve(cwd, hostPath)`, `real = realpath(abs)` (or the nearest existing
ancestor's realpath + the rest), refuse with `EACCES` when `isPrivateMinilfsPath(abs|real)` or
`isOutsideSecret(abs|real)`; return `real`. Use it in every `if (!sp)` branch of `readFile`, `access`
(write → `mustStorePath`), `exists` (EACCES/ENOENT → false), `isDirectory`, `readdir`. `findFiles` /
`grep` keep refusing outside paths. No per-connection ACL in the worker (the SDK sends no session
identity; sub-agents legitimately read other Branches): the file-tool guard + Seatbelt close it.

Edge cases: symlink (in /tmp or the Workspace) to `<root>/worker/<build>/endpoint.json` or `~/.ssh`;
/tmp vs /private/tmp, /var vs /private/var; probing a non-existent child under `<root>/worker`;
`exists` returns false (does not throw) on denied paths.

Test: `elevate` (unit, stubbed) and `review-fixes` (real worker): `readFile(endpoint)`,
`readFile(/tmp/link-to-endpoint)`, `readdir(<root>/worker)`, `access(endpoint)`,
`isDirectory(<root>/worker)` reject EACCES; `exists(endpoint)` is false. Fails before.

## 2. R2(b) — uncertain writes after worker loss (Major)

`retryBusy`: on a worker-gone or lost-after-send error, `revive()` FIRST, then verify. Verification
returns `{ landed: true, value } | { landed: false }`; if verification throws, revive, back off and
verify again; never resend an uncertain call until verification says `landed: false`; no
`onUncertain` → throw. `fs.*` writes: the `before` head read is mandatory (retry it; if it still fails,
throw before sending). `list_branches` pages fully.

| Call | Unsent (worker gone / Busy before effect) | Lost or uncertain (Unknown / lost after send) |
| --- | --- | --- |
| reads (fs.read/list/stat/grep/glob/diff_files/blame, branch.list_commits/diff_*, project.list_*, sandbox.list_workspaces) | revive, resend | revive, resend |
| fs writes | revive, resend | revive, verify head vs before: moved → `{ kind: "Committed", head, commit: { id }, recovered: true }`; same → resend; verify failed → verify again, never blind |
| branch.fork / branch.merge | revive, resend | revive, list branches (paged): target exists → recovered result; absent → resend |
| branch.publish | revive, resend | never resend; throw (callers handle) |
| workspace.mount/commit/unmount/exec, sandbox.create/close | revive, resend | never resend; throw |

Test (`store-contention`): fault-inject a lost reply after an `fs.apply` lands (destroy the socket
before the reply) and make the first verification read fail once: exactly 1 Commit, `recovered: true`.

## 3. R3 + R4 — process identity, safe reaping and worker replacement (Major)

Identity = (pid, startSec, startUsec) from libproc (`pbi_start_sec`, `pbi_start_usec`).
- `proc-scan.ts`: `ProcRow` gains `startUsec`; `procStartTime(pid)`; `leftovers` compares
  (startSec, startUsec) ≥ the call's start, no `- 1` slack.
- `driver.ts`: the call records its start in µs; orphan roots = Workspace + branch scratch only
  (drop `sharedCacheDir`, shared by every session of a project).
- `store-worker.mjs` records its own start time in `endpoint.json`; `worker.ts`: ping timeout 3 s;
  replacing a worker needs 3 failed pings over ≥ 6 s (500 ms apart) AND identity match (pid alive,
  start time equal, exe node, cwd = worker dir); then SIGTERM, wait 2 s, SIGKILL if still the same
  process. Mismatch → never signal, just start a new worker. Same check in `stopWorkers`.

Tests: `native-seatbelt` — a setsid'd process with cwd in `sharedCacheDir` started during another
call survives that call; one in the branch scratch dir is killed. `store-contention` — an endpoint
with a dead port and the pid of an innocent `sleep` (cwd /tmp): the sleep survives `ensureWorker`; a
worker whose ping is delayed 1.5 s is reused, not replaced.

## 4. R5 + R6 — atomic git join, NUL-safe paths (Major / Minor)

Run the script with `/bin/bash`. Conflict paths: `while IFS= read -r -d '' p; do … done < "$list"`
(no `tr`). Move the ref safely: `g read-tree "$new"` (index = new tree, work tree untouched) BEFORE
`update-ref "$BRANCH" "$new" $cur`; if update-ref fails, `read-tree "$cur"` back and report fail.

Tests (`elevate`): a conflicting file named `line1\nline2.txt` resolved in the work tree → mode
worktree, the name intact in the commit; `.git/index.lock` present → mode fail and the branch ref
unchanged.

## 5. R7 — `minilfs_apply` only for the lead (Major)

Check `role.role === "lead"` inside the tool's `execute` and in `/minilfs apply`; refuse otherwise
("only the lead applies; report your branch name"). On `session_start`, when the role is worker,
remove `minilfs_apply` from the active tools if `pi.getActiveTools/setActiveTools` exist.

Test (`elevate`): load with no env and an Epi task session file
(`…/runtime/task/sessions/<uuid>.jsonl`): `minilfs_apply.execute` rejects "only … lead".

## 6. R8 — alias resolution prefers live, then newer (Major)

`compareSessionsForAlias(a, b)`: live beats dead (`sessionAlive`, with the start-time check of R3
when recorded), then newer `updatedAt`, then has-commit. Use it in `setupBranches` and
`resolveBranchName`.

Test: bindings with a dead `lead` (commit, older) and a live `lead` (no commit, newer):
`resolveBranchName("lead")` → the live one.

## 7. R9 — publish result field

`pub?.publishedLayer ?? pub?.layer` in `syncHostDriftIntoMain` and `applyLocked`; on UpToDate keep the
old ref but refresh the project's `updatedAt`.

Test: after `apply()`, the project's recorded mainRef is the new published layer.

## 8. R10 + R11 — apply: git lock protocol and object closure (Major)

Order: sources, then git objects; then:
- R11: collect every target object of planned refs (`packed-refs` lines incl. peeled `^`), detached
  HEAD, and index entries (blob oids, not mode 160000); `git --git-dir=<host git dir>
  -c core.hooksPath=/dev/null -c core.fsmonitor=false cat-file --batch-check`; any missing or a
  malformed ref → write no ref/HEAD/index/soft git file, warn, mark main stale. Files still applied.
- R10: for the remaining ref/HEAD/index paths, take git's own `<target>.lock` (`open(…, "wx")`),
  all of them before renaming any (sorted by path), re-check the host state under the lock, write
  the new bytes into the lock file, then rename each lock over its target (deletion: unlink target,
  then the lock). `EEXIST` or a changed target → remove our locks, write no git metadata, warn as
  "the folder's git moved".

Tests (`review-fixes`): a dangling 40-hex oid written into `.git/refs/heads/main` + a normal file →
the file applied, host ref unchanged, warning, `git fsck` clean. A held `.git/refs/heads/main.lock`
during apply → host ref unchanged, no lock of ours left, fsck clean.

## 9. R12 — monotonic rescue of the losing side's refs (Major)

Besides `refs/heads/*`: carry `refs/minilfs/*` verbatim (same path, no nesting), `refs/tags/*`
(missing on target → same name; different oid → `refs/minilfs/<label>/tags/<name>`), and a detached
HEAD (raw oid not equal to the target's HEAD) → `refs/minilfs/<label>/HEAD`. Read loose refs and
packed-refs. Only `isSafeRefName` names.

Test (`review-fixes`): w1 has branch feat, tag v1.0 and a detached-HEAD commit; merge w1 into w2
(w2 has committed), then lead commits and merges w2 (lead's .git wins): in lead, the feat rescue,
v1.0 and the HEAD rescue all resolve and the commits exist.

## 10. R13 — no filter drivers in the join

`g()` adds `-c attr.tree=$empty` (empty tree of the repo's hash: `git hash-object -t tree /dev/null`)
and `-c core.autocrlf=false`.

Test (`elevate`): a repo with `filter.pwn.clean` touching a marker and `* filter=pwn`, a resolved
conflict: mode worktree, marker absent.

## 11. R14 — prelude `timeout` returns 124 only when it fired

The watchdog creates a marker file just before it kills; `timeout` returns 124 only if the marker
exists (then removes it), else the command's own code.

Test: `timeout 10 sh -c 'kill -TERM $$'` → 143; `timeout 1 sh -c 'sleep 10'` → 124.

## 12. R18 — dead state

Remove `LocalNativeDriver.activeKills` and `LayerfsSession.activeSids`; `LayerfsSession.exec` links an
`AbortController` per call (kept in `activeExecs`), passes its signal to the driver; `close()` aborts
them all.

Test: `close()` during `exec("sleep 60")` aborts it promptly.

## 13. R16 — release gate

Before a release: every `src/bundle.json` entry's tag contains `-<layerfs commit 7>-`, sha256 is 64
hex, and the URL answers 200 (HEAD). Run in CI on release, or `MINILFS_RELEASE_CHECK=1` in `elevate`.

## Plan (commit-sized)

1. R1 · 2. R7 · 3. R2(b) · 4. R3 R4 R14 R18 · 5. R10 R11 · 6. R5 R6 R12 R13 · 7. R8 R9.
Then the full suite on the host (elevate, store-contention, native-seatbelt, review-fixes, backend,
orphan-mount, concurrent-start, cli, rpc, pi, scale, worker-mount smoke): all pass, nothing left
running.
