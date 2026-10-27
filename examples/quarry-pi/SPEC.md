# Quarry: a SQL database in Rust, built by a team of agents on `minilfs`

> Adapted from the LayerFS Quarry demo spec
> (https://github.com/Ephemeral-AI-Lab/layerfs/blob/main/dsh/demo/quarry/SPEC.md, MIT,
> Copyright (c) 2026 Ephemeral-AI). The SQL scope, skeleton, lanes and acceptance
> checks are unchanged; the team process, tools and build settings are configured for
> native macOS `minilfs` on Pi (`pi -e minilfs` + `pi-subagents`).

Quarry is a SQL database: its own parser, a cost-based optimizer, a vectorized
executor that spills to disk, paged storage with B+tree indexes, a write-ahead log,
MVCC with snapshot isolation, crash recovery, vacuum, and the PostgreSQL wire
protocol. A lead agent and seven workers in three lanes (plus a corpus worker) build it
as a Cargo workspace.

This file says **what** to build and **how the team works**. Inside each crate the
design is up to the team: choose names, modules and algorithms freely, as long as the
behavior below holds and the tests prove it. Results are checked against SQLite, so
"works" means "returns the same rows".

## Team

| Agent | Count | Lane | Owns |
| --- | --- | --- | --- |
| Lead (the top-level session) | 1 | all | Skeleton, `quarry-types`, the root `Cargo.toml`/`Cargo.lock`, the `quarry` binary, lane briefs, merges and conflicts, integration, applying (`minilfs_apply`), report |
| Corpus worker (`C`) | 1 | test | The slt corpus (`tests/slt/`), `scripts/oracle.py`, `quarry-slt`, `quarry-gen`, `quarry-accept` (runs during the skeleton/M1 round, and again when the lead asks) |
| `sql` workers P1, P2, P3 | 3 | sql | P1 the parser (`quarry-parser`), P2 the binder, catalog and types (`quarry-binder`), P3 the planner and optimizer (`quarry-planner`) |
| `exec` workers X1, X2 | 2 | exec | X1 the operators (`quarry-exec`), X2 expressions, functions (`quarry-expr`) and the wire-protocol server (`quarry-server`) |
| `store` workers S1, S2 | 2 | store | S1 pages, buffer pool, heap and indexes (`quarry-storage`), S2 the WAL, transactions, recovery and vacuum (`quarry-txn`) |

Workers are pi-subagents children (agent `quarry-worker`, or `quarry-corpus`) started with
`subagent({ agent, task, async: true })`. The lead never writes lane features itself, except to fix
integration bugs.

## Stack

- Native macOS Rust toolchain (edition 2024, `rust-version = "1.85"`), Clippy and rustfmt, and
  Python 3 with SQLite 3 (the oracle). Every bash call runs in a native macOS Seatbelt sandbox
  mounted over loopback NFSv3 (do NOT create a `rust-toolchain.toml` file, so the installed
  host `rustc`/`cargo` is used directly).
- One Cargo workspace at the project root, `resolver = "3"`.
- **Dependencies** are declared once, in the root `[workspace.dependencies]`, and
  crates use `{ workspace = true }`. The lead fixes this list in the skeleton:

  | Crate | Use |
  | --- | --- |
  | `tokio` (rt-multi-thread, net, macros, sync, time, fs, io-util, signal), `bytes` | The wire-protocol server |
  | `serde` (derive), `serde_json` | Plans for `EXPLAIN (FORMAT JSON)`, test fixtures |
  | `thiserror` 2, `anyhow` | Errors |
  | `tracing`, `tracing-subscriber` (env-filter, json) | Logging |
  | `clap` 4 (derive) | The `quarry` binary |
  | `crc32fast`, `rand` 0.8 | Checksums, generators |
  | `tempfile`, `proptest` (dev) | Tests |
  | `tokio-postgres` 0.7 (dev) | A real PostgreSQL client for wire-protocol tests |

  No SQL parser, query engine, storage engine or protocol crate: Quarry builds those
  itself. A worker that needs another crate asks the lead.
- **Build settings**, for every agent and every command (`scripts/env.sh` sets them;
  start every cargo bash call with `. scripts/env.sh &&`):

  `scripts/env.sh` sets `CARGO_HOME` to a shared native APFS scratch directory and
  `CARGO_TARGET_DIR` to the agent's own (`$MINILFS_SCRATCH_DIR/target`, an APFS clone of a
  shared seed), so compilation runs at native APFS speed without bloating the LayerFS Store
  and parallel agents never replace each other's binaries. Always locate
  built binaries at `"$CARGO_TARGET_DIR/release/quarry"` (or via `std::env::var("CARGO_TARGET_DIR")`
  in `quarry-accept`).

  The root `Cargo.toml` sets `debug = "line-tables-only"` for `[profile.dev]` and
  `[profile.test]`. After the skeleton's `cargo fetch`, every Cargo command uses
  `--locked --offline`.
- **Tests:** unit tests in each crate, and **at least four integration test files per
  crate** in its `tests/` folder. Property tests with `proptest` where the behavior
  has a model. Network tests bind `127.0.0.1:0` and use a temporary data folder.
- **Quality gates:** `cargo fmt --all --check`, `cargo clippy --workspace --all-targets
  --locked --offline -- -D warnings`, `cargo test --workspace --locked --offline`.
- `unsafe` only in `quarry-storage`'s page access, each block with a comment saying
  why it's sound.

There's no size target. Build the features well; don't pad.

## SQL that Quarry supports

Types: `BIGINT` (and `INT`, `INTEGER`), `DOUBLE PRECISION` (and `FLOAT`, `REAL`),
`TEXT` (and `VARCHAR(n)`), `BOOLEAN`, and `NULL`. Dates are ISO-8601 `TEXT`.
Three-valued logic and SQL `NULL` semantics throughout. Integer overflow and division
by zero are errors, not wraparound.

| Area | Statements and features |
| --- | --- |
| DDL | `CREATE TABLE` (`PRIMARY KEY`, `NOT NULL`, `UNIQUE`, `DEFAULT`, `CHECK`), `DROP TABLE`, `ALTER TABLE … ADD COLUMN`, `CREATE [UNIQUE] INDEX` (multi-column), `DROP INDEX`, `CREATE VIEW` |
| DML | `INSERT` (multi-row `VALUES`, `INSERT … SELECT`, `ON CONFLICT DO NOTHING / DO UPDATE`), `UPDATE`, `DELETE`, `RETURNING`, `COPY t FROM STDIN` over the wire |
| Queries | `WHERE`, `GROUP BY`, `HAVING`, `ORDER BY … [ASC|DESC] [NULLS FIRST|LAST]`, `LIMIT`/`OFFSET`, `DISTINCT`; `INNER`, `LEFT`, `RIGHT`, `FULL` and `CROSS` joins; scalar, `IN`, `EXISTS` and correlated subqueries; `UNION [ALL]`, `INTERSECT`, `EXCEPT`; `WITH` and `WITH RECURSIVE`; window functions (`ROW_NUMBER`, `RANK`, `DENSE_RANK`, `LAG`, `LEAD`, aggregates `OVER` with `ROWS` and `RANGE` frames) |
| Expressions | Arithmetic, comparison, `AND`/`OR`/`NOT`, `CASE`, `CAST`, `COALESCE`, `NULLIF`, `LIKE`, `BETWEEN`, `IN` lists, `IS [NOT] NULL`, `||`; `lower`, `upper`, `length`, `substr`, `trim`, `replace`, `abs`, `round`, `mod`; `count`, `count(DISTINCT)`, `sum`, `avg`, `min`, `max`, `string_agg` |
| Transactions | `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `ROLLBACK TO`; snapshot isolation; a write-write conflict fails the later committer with SQLSTATE `40001` |
| Other | `EXPLAIN`, `EXPLAIN ANALYZE`, `EXPLAIN (FORMAT JSON)`; `ANALYZE` (statistics); `VACUUM`; `SET work_mem`, `SET statement_timeout`, `SET enable_indexscan`, `SET enable_hashjoin` |

Errors carry PostgreSQL SQLSTATE codes: at least `42601` syntax error (with the
position), `42P01` undefined table, `42703` undefined column, `42804` datatype
mismatch, `23502` not-null violation, `23505` unique violation, `23514` check
violation, `22003` numeric out of range, `22012` division by zero, `40001`
serialization failure, `57014` query canceled.

## Skeleton (lead and Corpus worker `C`, before the lane workers start)

- Root `Cargo.toml` with the workspace, `[workspace.dependencies]`, the profiles and
  every crate below as a member; `Cargo.lock` from `cargo generate-lockfile`, then
  `cargo fetch --locked` (do not create `rust-toolchain.toml`).
- `.gitignore` is already there (`target/`, `.cargo-home/` and `runs/`):
  leave it, and don't create or edit `/.lww` (`minilfs` manages it).
- **`quarry-types`** (owned by the lead; lanes may make small additive edits):
  - `DataType`, `Value`, `Schema`, `Row`, and a columnar `Batch` of up to 1,024 rows;
  - `Error` with SQLSTATE codes and an optional position;
  - the AST, `Expr`, `LogicalPlan` and `PhysicalPlan` types the lanes hand to each
    other;
  - the traits every lane codes against: `Catalog`, `Storage` (tables with row ids:
    scan, insert, update, delete), `Index` (point and range lookups), `TxnManager`
    and `Txn` (begin, snapshot, commit, abort), and `Statistics`;
  - `MemStorage`, an in-memory implementation of those traits with a trivial
    transaction manager, so the `sql` and `exec` lanes can build and test before the
    `store` lane lands.
- **Stub crates**, each building and with one passing test: `quarry-parser`,
  `quarry-binder`, `quarry-planner` (sql); `quarry-exec`, `quarry-expr`,
  `quarry-server` (exec); `quarry-storage`, `quarry-txn` (store).
- **`quarry`** (binary): `quarry serve --data <dir> --port <n>` and
  `quarry sql --data <dir>` (a local shell), wiring the crates together. Lanes add to
  it with small edits.
- **Test infrastructure** (Corpus worker `C`):
  - `tests/slt/*.slt`: a sqllogictest corpus of **at least 600 records** across
    every area of the SQL table above, with expected results produced by SQLite
    through `scripts/oracle.py`, and expected errors with their SQLSTATE;
  - `crates/quarry-slt`: a runner for that format (`statement ok`, `statement error
    <sqlstate>`, `query <types> [rowsort]`), against an embedded Quarry or a server;
  - `scripts/oracle.py`: runs a script of statements on SQLite and prints normalized
    results (booleans as `true`/`false`, floats rounded to 9 significant digits,
    `NULL` as `NULL`);
  - `crates/quarry-gen`: a seeded random query generator over a fixed schema (joins,
    filters, aggregates, subqueries, set operations, window functions; only
    constructs whose results SQLite and Quarry define the same way), and a seeded
    TPC-H-style data generator (`--scale 0.05` ≈ 50 MB);
  - `crates/quarry-accept`: the acceptance harness below, with no checks yet.
- `docs/architecture.md`: the crates, the traits, the path of a query from bytes on
  the wire to rows on the wire, and how a lane plugs in.
- The skeleton is done when the build, the quality gates and the slt runner (with the
  corpus marked expected-to-fail) all run. The lead then calls `minilfs_apply`: the
  source reaches the project folder and updates `main` for the workers' branches.

Each lane owns its crates. Lanes meet only through `quarry-types`.

## Lane `sql`: P1, P2, P3

| Milestone | Finished behavior |
| --- | --- |
| P-M1 | **P1:** `quarry-parser`: a hand-written lexer and recursive-descent parser for DDL, DML and `SELECT` (filters, grouping, ordering, limits, all join kinds), with errors that carry the byte position (`42601`). **P2:** `quarry-binder`: name resolution with aliases and qualified names, type checking with the implicit casts SQLite and PostgreSQL agree on, the catalog for DDL over `MemStorage`, constraint metadata. **P3:** `quarry-planner`: logical plans; rewrites (constant folding, predicate pushdown, projection pruning); physical plans (sequential scan, filter, project, nested-loop and hash join, hash aggregate, sort, limit); `EXPLAIN`. |
| P-M2 | **P1:** subqueries, set operations, `WITH`, `INSERT … SELECT`, `ON CONFLICT`, `RETURNING`, `CASE`, `CAST`, views. **P2:** correlated subquery binding; views; `ALTER TABLE`; constraint checks at bind time where possible. **P3:** decorrelation of `IN`/`EXISTS` into semi and anti joins; a cost model fed by `ANALYZE` statistics (row counts, distinct values, histograms); index selection; join reordering (dynamic programming up to 6 tables, greedy above). |
| P-M3 | **P1:** window functions, `WITH RECURSIVE`, `$n` parameters, `EXPLAIN ANALYZE` and `EXPLAIN (FORMAT JSON)`. **P2:** window binding; parameter type inference for prepared statements. **P3:** window planning; merge join when inputs are ordered; top-N sort; a plan cache for prepared statements, invalidated by DDL and `ANALYZE`. |

## Lane `exec`: X1, X2

| Milestone | Finished behavior |
| --- | --- |
| X-M1 | **X1:** `quarry-exec`: a pull-based vectorized engine over `Batch`; sequential scan over `Storage`, filter, project, nested-loop join, hash join (inner, left), hash aggregate, sort, limit; DML operators. **X2:** `quarry-expr`: a vectorized evaluator with three-valued logic, arithmetic with overflow and division errors, comparisons, `LIKE`, `CAST`, the string and math functions. `quarry-server`: the PostgreSQL startup handshake (no TLS, trust auth), the simple query protocol, `RowDescription`/`DataRow`/`CommandComplete`, `ErrorResponse` with SQLSTATE and position. |
| X-M2 | **X1:** right, full, semi and anti joins; merge join; `DISTINCT`; set operations; **spilling**: sort, hash aggregate and hash join stay within `work_mem` (default 16 MiB) by spilling to temporary files. **X2:** aggregates (`count(DISTINCT)`, `avg`, `string_agg`), `CASE`, `COALESCE`, `NULLIF`; the extended query protocol (Parse, Bind, Describe, Execute, Sync, Close), prepared statements with typed parameters, many concurrent sessions. |
| X-M3 | **X1:** window operators with `ROWS` and `RANGE` frames; top-N; per-operator counters for `EXPLAIN ANALYZE` (rows, loops, time, bytes spilled). **X2:** cancel requests and `statement_timeout` (`57014`); `COPY … FROM STDIN`; session `SET` variables; server metrics (`quarry serve --metrics-port`). |

## Lane `store`: S1, S2

| Milestone | Finished behavior |
| --- | --- |
| S-M1 | **S1:** `quarry-storage`: 8 KiB slotted pages with checksums, a disk manager, a buffer pool bounded in pages with pin counts and clock eviction, heap files with row ids, and `Storage` scan, insert, update and delete. **S2:** `quarry-txn`: a WAL with LSNs, CRC-framed records and group commit; redo recovery for heap changes; `BEGIN`/`COMMIT`/`ROLLBACK` with one writer at a time. |
| S-M2 | **S1:** B+tree indexes (unique and non-unique, multi-column keys, splits and merges, range scans) behind `Index`; values over 2 KiB in overflow pages; a sampling API for `ANALYZE`. **S2:** MVCC: versioned tuples (creating and deleting transaction ids), snapshots, snapshot isolation with concurrent readers and writers, first-committer-wins write conflicts (`40001`). |
| S-M3 | **S1:** a free-space map; `VACUUM` reclaiming dead versions and their index entries; checkpoints flushing dirty pages. **S2:** full crash recovery (redo, then undo of transactions that never committed) covering heap, indexes and transaction state; checkpoints that bound recovery; savepoints; a `kill -9` torture test in `tests/`. |

A lane that needs another lane's crate uses its `quarry-types` trait, never its
internals. Until a real implementation lands, use `MemStorage` or a stub behind your
own interface, and ask the lead.

## How the team works (`minilfs` team mode)

- **Every session has its own branch.** File tools and bash act on it; nothing reaches
  the project folder until the lead calls `minilfs_apply`. A new session (lead or
  worker) starts from `main`, the state of the last apply.
- **Rounds.** The lead builds and applies the skeleton, then runs milestone rounds
  M1, M2, M3. In each round it starts the lane workers together (one `subagent` call each,
  `async: true`), waits with `bg_wait`, and integrates.
- **A worker's round:**
  1. `minilfs` (`action: "status"`): note the branch.
  2. Build its features with tests, in its own crate(s) only.
  3. Before reporting: `minilfs` (`action: "sync"`, brings in what was applied since it started),
     then the quality gates for its crates (`-p <crate>`), plus `cargo fmt --all
     --check`.
  4. Report, first and last line `BRANCH: <branch from minilfs status>`, with test
     counts, what is done, what's left, and what it needs from other lanes. Never call `minilfs_apply`.
- **Ownership.** Each worker owns its crate(s) exclusively. Shared files belong to the
  lead: the root `Cargo.toml`, `Cargo.lock`, `quarry-types`, the `quarry` binary.
  A worker that needs a change there describes it in its report (or makes a small,
  additive edit and says so). Two lanes never edit the same file.
- **Integration (lead).** Merge each worker branch with `minilfs` (`action: "merge"`), one at a
  time. On a conflict nothing changes: fix it using `strategy: "ours" | "theirs"`, `action: "checkout"`,
  or editing the lead branch. Then run the quality gates, the slt corpus and the acceptance checks
  the round has reached, fix integration bugs, record the round in `PROGRESS.md`, and call
  `minilfs_apply`. The next round's workers start from the new `main`.
- **Time.** Keep every command under 2 minutes: `timeout 110 cargo build …`. If one
  times out, run it again: Cargo continues where it stopped. If rustc or the linker is
  killed for memory (exit 137), rerun with `CARGO_BUILD_JOBS=1`.
- **Processes.** Each bash call runs in its own sandbox; background processes end
  with the call. Start a server and its client in one bash call.
- Workers never call `minilfs merge` on teammates' branches; only `sync`.

## Acceptance (`quarry-accept`)

`cargo build --release -p quarry -p quarry-accept` (lead, at integration), then
`"$CARGO_TARGET_DIR/release/quarry-accept" run Qnn` for each check, each under 100 s.
`quarry-accept` starts `"$CARGO_TARGET_DIR/release/quarry" serve` (locating `quarry` via
`CARGO_TARGET_DIR`, Current Exe parent dir, or `./target/release/quarry`) as a child
process on an ephemeral port with a fresh data folder, and prints `Qnn PASS` or
`Qnn FAIL <why>`. On macOS, for Q06 memory checks, read RSS via `ps -o rss= -p <pid>`
when `/proc/<pid>/status` is absent.
Comparisons with SQLite go through `scripts/oracle.py` on the same data.

| Check | Scenario |
| --- | --- |
| Q01 | The whole slt corpus passes against the server over the wire: every record, results and SQLSTATEs. |
| Q02 | Differential testing: 2,000 generated queries (`quarry-gen --seed 1`) over generated data return exactly SQLite's rows (sorted when there is no `ORDER BY`). |
| Q03 | TPC-H-style data at scale 0.05, loaded with `COPY`: queries Q1, Q3, Q5, Q6, Q10, Q12, Q14 and Q19 (dates as ISO text, intervals precomputed) return SQLite's rows, each in under 10 s. |
| Q04 | 8 clients run 30 s of transactions (transfers between accounts) while the server is killed with SIGKILL at a random moment. After restart the total balance is unchanged, every committed transaction is visible, none of the uncommitted ones is, and every index agrees with its table (`quarry check`). |
| Q05 | Isolation: no dirty read, no non-repeatable read and no lost update; two concurrent updates of one row make the later committer fail with `40001`; a write-skew case behaves as snapshot isolation allows, as documented. |
| Q06 | Spilling: with `SET work_mem = '8MB'`, an `ORDER BY` and a hash join over 200 MB of rows return correct results while the server's peak resident memory stays under 256 MiB (`ps -o rss= -p <pid>` on macOS or `VmHWM` in `/proc/<pid>/status`), and `EXPLAIN ANALYZE` reports bytes spilled. |
| Q07 | Indexes: a selective lookup on 1,000,000 rows uses an index scan (`EXPLAIN`) and runs at least 20× faster than with `SET enable_indexscan = off`. A unique index rejects a duplicate with `23505`. |
| Q08 | Join order: after `ANALYZE`, a 6-table join written in a bad order gets a plan whose estimated cost is lower than the written order's, and finishes in under 5 s. |
| Q09 | Wire protocol through `tokio-postgres`: prepared statements with parameters of every type, 16 concurrent sessions, a cancel request and `statement_timeout` (`57014`), and the SQLSTATEs listed above. |
| Q10 | Window functions and `WITH RECURSIVE` (a graph walk and a running total) return SQLite's rows. |
| Q11 | Vacuum: 5 rounds of updating every row of a 100,000-row table with `VACUUM` between rounds: the table's file stops growing after the second round. |
| Q12 | `EXPLAIN ANALYZE` row counts match the rows each operator really produced, and executing one prepared statement 1,000 times plans it once (the plan cache counter). |

## Report

At the end the lead writes `docs/BUILD-REPORT.md`, calls `minilfs_apply`, and ends. It covers:

- what was built, crate by crate, and the decisions that shaped it;
- each round: the worker branches, the merges and conflicts and how each was
  resolved, the applies;
- the final check: quality gates, test counts per crate, slt records passed,
  `Q01`–`Q12`;
- surprises: refusals, slow steps, anything a future team should know.
