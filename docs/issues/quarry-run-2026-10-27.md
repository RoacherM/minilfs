# Issues from the Quarry run of 2026-10-27 (Pi + minilfs, 8 parallel workers)

Status: open. Proposed fixes in §3, to be reviewed before implementation.

## 0. The run

- Setup: `examples/quarry-pi` (same SPEC/HANDOFF as the DSH run `layerfs-dsh-test-2@4b37305`), Pi +
  `pi-subagents`, lead + 8 async workers per round (P1–P3, X1–X2, S1–S2, C), model
  `magpie/deepseek/deepseek-flash:high`, minilfs from the local checkout (uncommitted, store worker
  on), LayerFS a700af8, test folder `~/Projects/sides/quarry-minilfs-test`, run
  `runs/20261027-173940`, root `~/.cache/minilfs-quarry`.
- Result: 260 min wall. Q01–Q03, Q05, Q07, Q08, Q10, Q12 PASS; Q04, Q06, Q09, Q11 FAIL (Quarry
  performance / a missing recovery link, not minilfs). 24 agent sessions, 27 `minilfs merge`
  (6 conflicts, all resolved with `strategy`/`checkout`), 40 `sync`, 8 `apply`, **0 Store
  contention errors** (the store worker held). Disk: Store 13 MB; cargo scratch 5.7 GB outside it.
- Evidence: `docs/replay/replay.html` (+ `data.js` from `docs/replay/extract.py`), the run's
  `PROGRESS.md` and `docs/BUILD-REPORT.md`, session logs under the test folder's `.quarry-agent/sessions`.

## 1. Issues (minilfs)

### I1. A bash call can hang forever (cost ~105 min in this run) — HIGH

**What happened.** Three times a tool call never returned: X2's
`timeout 115 cargo test -p quarry-server --test copy 2>&1 | tail -40` (80 min, blocked the lead's
`bg_wait`), C's call that started `quarry serve … &` (80 min), and the lead's
`timeout 400 cargo build … && cargo test …` (26 min). Each was unblocked only by a human killing
the orphan (`kill -9`).

**Root cause (verified with ps/lsof).** The process holding the call's stdout/stderr pipe was an
orphan (`ppid 1`): a hung test binary (`target/debug/deps/copy-…`, a COPY FROM STDIN deadlock in
Quarry) or a background server. minilfs waits for the pipe to close (`child.on("close")` in
`LocalNativeDriver.execInWorkspace`), so the call waits as long as any descendant holds the pipe.
None of the guards caught it:
1. the agent's `timeout N`: on macOS minilfs's prelude defines a shell `timeout` function that
   kills only the direct child (`cargo`), not cargo's children (the test binary);
2. minilfs sets no overall time limit for a call (only the caller's optional `options.timeout`);
3. clean-up after the shell exits kills the process group (`kill(-pid)`) and `lsof <mount>` holders;
   the orphan left the group (cargo/test harness spawn in new groups or `setsid`) and holds no file
   on the mount (its data was under `/var/folders`, logs in `/tmp`).

### I2. Git histories are not joined after a merge — HIGH

**What happened.** After 27 merges, `main` has **1** merge commit. Workers' own commits (e.g. P3
`765d349`, S1 `c3a8e3b`, C `7f61ac4`) are reachable only from `refs/minilfs/*`; `git log main` and
`git blame` attribute everything to the lead's single-parent "integrate X" commits.

**Root cause.** minilfs merges files with LayerFS and takes `.git` whole from one side (merge unit),
then asks the agent to run `git merge -s ours --no-commit <ref>`. git refuses (the work tree
already holds the merged files, it is "dirty"); the lead then committed by hand with one parent.

**Fix already written (not yet released):** `src/gitjoin.ts` + `LayerfsSession.joinGitHistories`:
after the LayerFS merge, minilfs records the join itself with plumbing (`merge-tree --write-tree`,
`commit-tree -p ours -p theirs`, `update-ref`, `reset --mixed`), under Seatbelt with hooks off;
fast-forward / up-to-date need no commit; when git sees a conflict LayerFS resolved, the commit
takes git's clean result plus the conflicting paths from the merged work tree. Unit tests pass
(5 cases, real git); integration tests written (`review-fixes`: two-branch join, three-worker
Quarry pattern) but not yet run on mounts.

### I3. `git commit` reports `pack-refs` failure in the sandbox — MEDIUM

**What happened.** `error: unable to create file …/.git/packed-refs.new: Operation not permitted`
/ `error: task 'pack-refs' failed` after commits (git's auto-maintenance). Agents worked around it
with `-c gc.auto=0 -c maintenance.auto=false`; the report lists it as a sandbox quirk.

**Root cause (verified with `gitPathKind`).** The `.git` allowlist (`src/gitpaths.ts`
`GIT_ALLOWED_BODY`, also the Seatbelt rule) allows `packed-refs` and `packed-refs.lock` but not
`packed-refs.new`, the temp file `git pack-refs` writes then renames: `gitPathKind(".git/packed-refs.new")`
is `protected`. Already allowed (transient): `*.lock` of refs/logs/HEAD/index, `objects/pack/tmp_*`,
`objects/info/commit-graphs/tmp_*`. `config.lock` is protected on purpose (git config is refused).

### I4. Shared `CARGO_TARGET_DIR` races between parallel agents — MEDIUM (template)

**What happened.** Two agents building at once replaced each other's `release/quarry*` binaries;
one worker saw a phantom "method not found" from a stale rlib; agents made private target dirs
(`s1-target` 1.1 GB, `p1-target`) and the lead copied binaries aside for acceptance.

**Root cause.** `examples/quarry-pi/scripts/env.sh` (same as the DSH template) points every agent's
`CARGO_TARGET_DIR` to one shared directory; cargo's lock serializes builds but not "build, then run
the binary": another agent's build replaces the binary in between. This is the experiment template,
not minilfs core, but minilfs exports `MINILFS_SHARED_CACHE_DIR` and `MINILFS_SCRATCH_DIR` (per
branch) that the template could use.

### I5. Lead did not apply after M2 — LOW (orchestration, not minilfs)

M3 workers forked from M1's `main`; ~40 min to recover. Not a minilfs bug; minilfs could make it
visible (e.g. `minilfs status` / the merge result says "N merges since the last apply; workers
started now fork from <time>").

### I6. The developer's own Epi session hit `Busy: Sandbox 1 was started again while it was reclaimed` — LOW

Seen in the session that drove the run (the installed GitHub minilfs, old code, in-process Store).
Not reproduced with the new code; likely the old per-process Store race the store worker removes.
Record only; verify after release.

## 2. Constraints for the fixes

- macOS native, no Docker; Seatbelt boundary unchanged (bash still spawned by the agent's process).
- No change to Store / merge / apply semantics beyond I2 and I3.
- Every fix gets a regression test that fails before and passes after.

## 3. Proposed fixes (for review)

### F1 (I1). Bounded bash calls and full process-tree clean-up

1. **Overall time limit per call**: `MINILFS_BASH_TIMEOUT_S` (default 600 s; Pi's own `timeout`
   param wins when smaller). On expiry: kill the tree (below), return the output so far with
   `[minilfs] command exceeded N s; its processes were stopped`.
2. **Mark the tree**: every call's environment gets `MINILFS_CALL=<random token>`. Descendants
   inherit it unless they clear their env. Clean-up = (a) `kill(-pgid)`, (b) every process whose
   environment contains the token (`ps -E -o pid,command` / `sysctl kern.procargs2` on macOS, same
   user only), (c) `lsof <mount>` holders, (d) every process holding the call's stdout/stderr pipe
   (`lsof -t` on the pipe inode, macOS `lsof -p` lists pipe endpoints).
3. **Do not wait for the pipe after the shell exits**: when the top shell exits, wait up to 2 s for
   the pipe to drain, then run clean-up and resolve with the exit code (output after that is dropped).
4. **Prelude `timeout`**: run the command in its own process group (`set -m` or `perl -e setpgrp`)
   and kill the group (`kill -TERM -$pgid`), so `timeout 115 cargo test` stops cargo's children.
5. Tests: `(sleep 999 &); echo done | cat` returns in < 5 s; `timeout 2 sh -c 'sleep 999 & wait'`
   returns 124 in < 5 s; a child that `setsid`s and holds stdout is killed at the call limit;
   a server started with `&` and output to `/tmp` is gone after the call.

### F2 (I2). Release the git join (already implemented)

Run the written integration tests on mounts; also: join when the lead's HEAD is detached (skip
today) is not needed. Open question for review: the first parent is the lead side (ours); for
`sync` (main into a worker) ours is the worker. Is that the right convention for `git log
--first-parent`?

### F3 (I3). Complete the `.git` temp-file allowlist

Allow `packed-refs.new` (and `shallow.new`, the same pattern in `git fetch --depth`), classified
`transient` (never applied). Check git's sources for other `.new` temp files on allowed paths before
adding more. Test: in the sandbox, `git pack-refs --all`, `git gc --auto` with enough loose refs and
objects, `git maintenance run --task=pack-refs` succeed; a real-git sweep (as in
`scripts`/the allowlist test of the 2026-10-27 review) records every path git writes and asserts
none is `protected`.

### F4 (I4). Per-agent cargo target dir in the template

`examples/quarry-pi/scripts/env.sh`: `CARGO_TARGET_DIR=$MINILFS_SHARED_CACHE_DIR/target-$(role or
branch)`… but a per-agent target means every agent compiles every dependency once (~2–4 min,
~1 GB each). Alternative: shared `target` for dependencies (`CARGO_TARGET_DIR` shared) plus
`--artifact-dir`/copy-before-run for binaries, or sccache. Needs a decision.

### F5 (I5). Surface "merged but not applied"

The `minilfs merge` result and `status` add: `main is N merges behind this branch; workers started
now fork from main (last apply HH:MM)`. Text only.

## 4. Review (gemini-4-argon, 2026-10-27) and the accepted plan

Full review kept in this session's log; verdicts: F1 approve with changes, F2 approve with changes,
F3 approve with changes, F4 redesign, F5 approve with changes. What is taken, and what was checked
here before accepting:

| Review point | Decision |
| --- | --- |
| F1: resolve on the shell's `exit`, drain the pipe for a bounded time, then destroy our read ends; clean up after that | **Taken** (the core fix: no descendant can hold the call open) |
| F1: env-token scan is bypassable (`env -i`) and `ps -E` / `kern.procargs2` is unreliable for hardened binaries | **Taken**: no env-token scan. Clean-up = process group + pipe drain cut-off + mount holders + same-user orphans (`ppid 1`) whose executable or cwd is under the Workspace, the branch scratch dir or the shared cache dir (libproc, via the existing ps shim approach) |
| F1: prelude `timeout()` kills only the direct child and leaks its watchdog `sleep` holding the pipe | **Taken**: run the command as its own process group (`perl -e 'setpgrp; exec'`), kill the group, watchdog with stdio closed and its `sleep` killed |
| F1: overall limit `MINILFS_BASH_TIMEOUT_S` (600 s), min with Pi's `timeout`, notice appended to the output | **Taken** |
| F1: `LayerfsSession.reapHolders` / `killNativeSession` duplicate the driver's | **Taken**: route through `driver.reapWorkspaceHolders` |
| Missed: a timed-out/aborted bash still commits the Workspace | **Kept on purpose** (the files the command wrote are real changes, the next call needs them; the same as a killed process on a normal disk); add: remove `.git/*.lock` / `*.new` git left behind before the commit, so the Branch's git is not wedged |
| F2: `update-index --add --remove` fails for a conflict LayerFS resolved by deleting | **Taken**: per path `--add` if it exists, `--force-remove` if not; NUL-separated (`-z`) path list |
| F2: `--no-messages` needs git ≥ 2.40 | **Taken**: check `git version`; older git: skip the join with a note (the refs stay kept) |
| F2: `keepLosingGitRefs` reads only the loose ref on the target | **Taken**: also read `packed-refs` |
| F2: first parent = this Branch for both merge and sync | **Kept** (same as `git merge` / `git pull`) |
| F3: `.new` for `packed-refs`/`shallow`; `.lock` for `sharedindex.*`, `objects/info/{packs,commit-graph}`; classify `\.(lock|new)$` transient | **Taken**; verify with a real-git sweep (pack-refs, gc, commit-graph, maintenance) that nothing git writes is protected |
| F4: per-branch `CARGO_TARGET_DIR` seeded by APFS clone (`cp -cR`) of a warm shared target | **Taken** for the template; the lead refreshes the seed after each apply |
| F5: count merges since the last apply on the session (reset by apply/adopt); show in merge and status | **Taken** |

Order: F3 → F2 → F1 → F5 → F4. Each with its regression test; then the full suite on the host,
then a new Quarry run compared with this one in the replay page.

## 5. Implemented (2026-10-27) and verified

| Fix | Change | Regression test |
| --- | --- | --- |
| F3 | `src/gitpaths.ts`: `packed-refs.new`, `shallow.new`, `sharedindex.*.lock`, `objects/info/{packs,commit-graph}.lock` allowed; `\.(lock|new)$` transient | real-git sweep (60 commits/tags/branches, auto-gc, pack-refs, gc, commit-graph, multi-pack-index, maintenance, split-index, repack, reflog expire, prune): all 530 paths git wrote are allowed |
| F2 | `src/gitjoin.ts`: git ≥ 2.40 check; conflicting paths read NUL-separated (`-z`, tree id length from the output, SHA-1/256); each path `--add` if present, `--force-remove` if LayerFS deleted it. `workspace.ts`: `gitRefOid` (loose, then packed-refs) used for the target's refs too | `elevate`: modify/delete conflict resolved by deletion + path with a space; `review-fixes`: two-branch join (HEAD has 2 parents, `git log main` has both, status clean, folder after apply), three workers in parallel (3 merge commits, 7 commits on main, fsck) |
| F1 | `core/driver.ts`: resolves on the shell's `exit`, pipe drain capped at 2 s; overall limit `MINILFS_BASH_TIMEOUT_S` (600 s; caller's smaller `timeout` wins; minilfs's own limit returns exit 124 + a notice); after the call kills the process group, mount holders and leftovers (`core/proc-scan.ts`: libproc, same user, launchd orphans started after the call with exe or cwd under the Workspace/branch scratch/shared cache). Prelude `timeout`: command in its own process group (`perl setpgrp`), group killed, watchdog without pipes. `workspace.ts`: removes `.git` `*.lock`/`*.new`/`tmp_*` after a stopped command; `reapHolders` delegates to the driver; dead `killNativeSession` removed | `native-seatbelt` 7.1c: `(sleep &)` holder, `env -i` + `setsid` holder, `timeout 2` with a grandchild (rc 124), the overall limit (exit 124, notice, process gone), a killed command's `index.lock` does not wedge git; no `sleep` left |
| F5 | `workspace.ts` `mergedSinceApply` (reset by apply), `mainUpdatedAt`; `tools.ts` `unappliedMergesNote` in `merge` and `status` | (covered by the merge tests' output; a note at sub-agent spawn needs Pi's `tool_result` contract: later) |
| F4 | `examples/quarry-pi/scripts/env.sh`: per-agent `CARGO_TARGET_DIR=$MINILFS_SCRATCH_DIR/target`, cloned (`cp -cR`) from `target-seed`; `seed_target` for the lead after each apply; AGENTS/SPEC/HANDOFF/README updated | shell check: lead seeds, a new branch's target starts from the clone |

Full suite on the host (2026-10-27, LayerFS a700af8): elevate 17/17, store-contention 4/4,
native-seatbelt 24/24, review-fixes 47/47, backend 15/15, orphan-mount 3/3, concurrent-start 1/1,
cli 4/4, rpc 6/6, pi 15/15, scale PASS, worker-mount smoke PASS; nothing left running.

Next: a new Quarry run (`examples/quarry-pi/new.sh`), compared in `docs/replay/` with this one:
expect merge commits on main ≈ number of worker merges (was 1), no hung call, Store contention 0.

## 6. Review of the committed change (b162c9b..68296c9), 2026-10-27

Reviewers: deepseek-v4.1-flash (high thinking) and gpt-6.1-sol (high thinking), independently.
Both read the source only (no shell). Each finding below was re-checked against the code here;
"checked" says what was verified.

| # | Finding | From | Checked | Severity |
| --- | --- | --- | --- | --- |
| R1 | File tools read paths outside the project with only `isOutsideSecret`: an agent can `read` `<root>/worker/<build>/endpoint.json` (the store worker's secret) and then call any Store method on any Branch. Seatbelt denies the root to bash, not to the in-process file tools. Same for `access`/`exists`/`isDirectory`/`readdir` | GPT | `workspace.ts` readFile/access/exists/readdir `if (!sp)` branches read the host directly | **Blocker** |
| R2 | Retry resends a delivered non-idempotent call: (a) `isWorkerGone` matches "connection is closed" but the SDK says that only for unsent calls, OK; (b) after a lost reply the outcome check runs before `revive`, fails against the dead worker, is taken as "not landed", then the write is resent; also writes proceed when the first head read failed | DeepSeek (M1), GPT (#3) | (a) SDK `worker_client.js:85` "the call was not sent": not a bug; (b) `client.ts` retryBusy: `onUncertain().catch(() => undefined)` before `revive`: real | **Major** |
| R3 | Leftover reaping uses the project-shared `sharedCacheDir` as a root: one call can kill another session's detached process; `startedSec - 1` slack | both | `driver.ts` roots include `sharedCacheDir`; `proc-scan.ts` rule | **Major** |
| R4 | Stuck-worker replacement SIGKILLs after a 1 s ping miss (a busy worker) and trusts the endpoint pid (pid reuse) | both | `worker.ts` `pingWorker(…, 1000)`, `alive(stale.pid)` → SIGKILL | **Major** |
| R5 | Join leaves a half state if `reset` fails after `update-ref` | DeepSeek | `gitjoin.ts` update-ref then reset, no rollback | **Major** |
| R6 | `tr '\0' '\n'` undoes `-z`: a newline in a conflicting filename splits the path | both | `gitjoin.ts` | Minor |
| R7 | `minilfs_apply` is registered by the role at load time; an Epi task found later (session file) keeps it; the handler does not re-check | GPT | `index.ts` registers when `role.role === "lead"` at load; role re-resolved at session_start; no check in the handler | **Major** |
| R8 | Alias resolution prefers a session with a commit over a newer one: `lead` resolves to the dead previous lead's Branch | GPT | `workspace.ts` resolveBranchName sort | Major |
| R9 | `publish` result read as `pub.layer`; the SDK field is `publishedLayer` (main ref not recorded after apply / sync) | GPT | SDK `branch.md:162`; `workspace.ts` two places | Minor (pre-existing) |
| R10 | Apply writes refs without git's lock protocol: a host commit between the final check and the rename is overwritten | GPT | `applyLocked` checks `hostState` then `rename`; no `.lock` | Major |
| R11 | Apply can install a ref to an object the folder does not have (a ref written by a file tool, objects never added) | GPT | decideGitPath accepts any ref content; no object check | Major |
| R12 | `keepLosingGitRefs` keeps only `refs/heads/*`: earlier `refs/minilfs/*` rescues, tags and a detached HEAD of the losing side are dropped by a later merge | GPT | walks only `/.git/refs/heads` | Major |
| R13 | Join runs `update-index --add` with the Branch's `.gitattributes`: a clean filter from the imported config runs (inside Seatbelt) | DeepSeek | `gitjoin.ts` `g()` sets hooksPath/fsmonitor only | Minor (sandboxed) |
| R14 | Prelude `timeout` maps a command's own 143/137 to 124 | DeepSeek | prelude | Minor |
| R15 | Pipe cut after 2 s may drop the tail for a slow consumer | DeepSeek | by design; onData is synchronous here | Nit |
| R16 | `bundle.json` still pins the 833acf7 prebuilt: fresh installs get a clear "not published yet" refusal | GPT | known; CI publishes on merge | Release blocker (known) |
| R17 | `revive` cannot rebind an existing client | DeepSeek (M5) | SDK `workerClient` re-reads the endpoint file on every send: **not a bug** | — |
| R18 | `activeKills` map written but never read | DeepSeek | dead state | Nit |

Tests the reviewers would add first: an Epi-worker boundary test (endpoint not readable through
file tools, no apply); a lost-reply write (worker killed after commit, before the reply, first
verification fails): exactly one Commit; host commit racing apply: host commit stays reachable,
`git fsck` clean; a second call's orphan under the shared cache survives another call's reap.
