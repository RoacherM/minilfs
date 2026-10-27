You are the lead of a brand-new project: Quarry, a SQL database in Rust, starting from
this nearly empty folder. You don't write the lane features yourself. You orchestrate a
team of eight sub-agents who build it together, as `SPEC.md` describes:

| Worker Role | Lane | Owns & Builds |
| --- | --- | --- |
| `C` (Corpus) | `test` | `tests/slt/`, `scripts/oracle.py`, `crates/quarry-slt`, `crates/quarry-gen`, `crates/quarry-accept` |
| `P1`, `P2`, `P3` | `sql` | `quarry-parser` (P1), `quarry-binder` (P2), `quarry-planner` (P3) |
| `X1`, `X2` | `exec` | `quarry-exec` (X1), `quarry-expr` & `quarry-server` (X2) |
| `S1`, `S2` | `store` | `quarry-storage` (S1), `quarry-txn` (S2) |

Run from start to terminal success (`Q01`–`Q12` all PASS) without asking the user
anything. Make every decision yourself, and record why in `PROGRESS.md`.

## Check the setup first

1. Call `minilfs` with `action: "status"`. It should answer with your branch (`alias: lead`).
   If `minilfs` is missing, stop and tell the user to start Pi with `scripts/run.sh`.
2. In one `bash` call: `. scripts/env.sh && rustc --version && cargo clippy --version &&
   python3 -c "import sqlite3; print(sqlite3.sqlite_version)"` should print your native
   macOS `rustc`, `clippy`, and `sqlite3` versions.

## Plan

1. **Skeleton round.** Build the skeleton from `SPEC.md` yourself: workspace `Cargo.toml`,
   profiles, dependency list, `Cargo.lock`, `. scripts/env.sh && cargo fetch`,
   `quarry-types` with `MemStorage`, stub crates, the `quarry` binary, and
   `docs/architecture.md`. Do NOT create `rust-toolchain.toml` (use the host's installed
   Rust toolchain directly). Publish the skeleton with `minilfs_apply` first so `main`
   has the complete workspace, and run `. scripts/env.sh && seed_target` so workers start with
   the dependencies already built; then start the Corpus worker (`C`, agent `quarry-corpus`)
   with `subagent` and `async: true` (or run `C` in parallel with the M1 lane workers).
2. **Rounds M1, M2, M3.** In each round, start the lane workers in parallel in a single
   turn: one `subagent` call each with agent `quarry-worker` and `async: true`, then wait
   with `bg_wait` until all have reported. Give each worker its role (`P1`..`S2` or `C`), owned crate(s),
   milestone requirements from `SPEC.md`, and these explicit worker instructions:
   - Call `minilfs` (`action: "status"`) first;
   - Work only in its owned crate(s); prefix every cargo command with `. scripts/env.sh &&`;
   - On macOS, in `quarry-accept` (for worker `C`), use `ps -o rss= -p <pid>` when `/proc/<pid>/status` is absent, and locate `quarry` via `std::env::var("CARGO_TARGET_DIR")`;
   - Run `minilfs` (`action: "sync"`), `cargo clippy -p <crate> --all-targets --locked --offline -- -D warnings`, `cargo test -p <crate> --locked --offline`, and `cargo fmt --all --check` before finishing;
   - **Never** call `minilfs_apply`;
   - Report `BRANCH: <workBranch from minilfs status>` on both the first and very last line of its final response.
   Once the workers return, integrate as `SPEC.md` says: call `minilfs` with `action: "merge"`
   for each worker's `BRANCH:` one at a time (you also have `action: "diff"`, `action: "show"`,
   `action: "checkout"`, and `strategy: "ours" | "theirs"`), run the quality gates, the slt
   corpus and the acceptance checks reached so far, fix integration bugs, update `PROGRESS.md`,
   call `minilfs_apply` so the next round's workers fork from the updated `main`, then
   `. scripts/env.sh && seed_target` so they also start from your built target.
3. **Finish.** Release build (`. scripts/env.sh && cargo build --release --locked --offline`),
   run `Q01`–`Q12` (`"$CARGO_TARGET_DIR/release/quarry-accept" run Qnn`), fix any remaining
   gaps until `Q01`–`Q12` all print `PASS`, run the quality gates, write `docs/BUILD-REPORT.md`
   as `SPEC.md`'s Report section says, call `minilfs_apply`, and end with a summary.

## Rules for the lead

- Every worker is `async: true`. A foreground child would not get its own branch.

- Workers can't see each other's work until you merge it and call `minilfs_apply` (so new
  sub-agents fork from the updated `main`, or running ones `sync`). Pass interface decisions
  in the subagent task text.
- Keep your own context small: read worker reports, `minilfs` `action: "diff"` and test output,
  not whole crates. Delegate fixes to the owning worker when they're more than small.
- `PROGRESS.md` (in the project root, yours) holds, per round: the workers' branches,
  the merges and conflicts, gate results, test counts, slt and Q results, decisions,
  and the time.
