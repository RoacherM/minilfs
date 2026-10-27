# AGENTS.md: Quarry on Pi + Native `minilfs` (Zero Docker)

This folder is the Native Quarry experiment on **Pi** with the `minilfs` extension
(LayerFS v1.1.0, pure sandbox) and `pi-subagents`: a team of agents builds
a SQL database in Rust (`SPEC.md`), each agent working on its own isolated LayerFS
branch with macOS Seatbelt sandboxing. Read `SPEC.md` and `HANDOFF.md` before any work.

## Where your files go

- Every file tool (`read`, `write`, `edit`, `ls`, `find`, `grep`) and `bash` call acts
  on **your isolated LayerFS branch**, not this host folder.
  The host folder changes only when the lead calls `minilfs_apply`.
- `scripts/env.sh` gives every agent its own `CARGO_TARGET_DIR` on native APFS scratch storage
  (`$MINILFS_SCRATCH_DIR/target`, cloned from a shared seed so dependencies are not rebuilt) and a
  shared `CARGO_HOME`: builds run at native speed, nothing enters the LayerFS Store, and parallel
  agents never overwrite each other's binaries. Never point cargo at another target dir.
- Each `bash` call runs natively on macOS inside a Seatbelt (`sandbox-exec`) sandbox
  mounted over loopback NFSv3. Background processes end when the `bash` call ends.
- The project's `.git` is in your branch: `git status`, `diff`, `log`, `add` and `commit`
  work inside `bash`. `git config`, `git remote add` and hooks are refused (protected).

## The `minilfs` tool

| action | does |
| --- | --- |
| `status` | your branch name and alias (`lead` or `sub-...` / `s-<shortId>`), head, unapplied changes |
| `diff [branch] [base]` | files changed on your branch (or on `branch` relative to its base) |
| `branches` | active user/worker branches of the project (with aliases) |
| `ls [branch] [path]` | list directory entries on any branch |
| `show branch path [offset] [limit]` | read a file (up to 100KB per page) or list a directory from another branch |
| `checkout branch path\|paths` | copy file(s) or directories byte-for-byte from another branch into yours |
| `sync [branch] [strategy]` | merge `main` (or `branch="lead"`) into your branch; optional `strategy="ours"\|"theirs"` |
| `merge branch [strategy]` | merge another branch into yours (LayerFS three-way merge; `.git` and `node_modules` come whole from one side); optional `strategy="ours"\|"theirs"` |
| `clean` | clean temporary scratch build caches |

Only the lead (the top-level session) should call `minilfs_apply`. Subagents must **never** call `minilfs_apply`.

## Roles

- **Lead**: the top-level session. Follow `HANDOFF.md`.
- **Workers**: 1 corpus worker (`C`, agent `quarry-corpus`) + 7 lane workers
  (`P1, P2, P3, X1, X2, S1, S2`, agent `quarry-worker`), started in parallel by the lead with
  `subagent({ agent, task, async: true })`. Every worker must:
  1. Call `minilfs` with `action: "status"` at the start and before finishing;
  2. Never call `minilfs_apply`;
  3. End its report with `BRANCH: <workBranch>` on both the first and very last line.

## Rules for everyone

- Own your files. Two agents never edit the same file in one round. Shared files
  (root `Cargo.toml`, `Cargo.lock`, `crates/quarry-types`, `crates/quarry`) belong
  to the lead.
- Cargo: `. scripts/env.sh && timeout 110 cargo … --locked --offline`. Note that binary
  executables are built into `$CARGO_TARGET_DIR/release/quarry` (or `debug/quarry`), so
  always source `. scripts/env.sh` and use `"$CARGO_TARGET_DIR/release/quarry"` or
  `cargo run`!
- Don't edit `.lww`, `.gitignore` or `scripts/env.sh`.
- Gates before reporting: `cargo fmt --all --check`, clippy with `-D warnings`,
  and tests for the crates you touched.
- Don't ask the user anything. Make decisions, and record why in your report
  (workers) or in `PROGRESS.md` (lead).
