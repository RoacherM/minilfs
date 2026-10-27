# Design: parallel agents on one Store (a minilfs Store worker)

Status: implemented 2026-10-27 (`src/store-worker.mjs`, `src/core/worker.ts`, `src/core/client.ts`).
Off switch: `MINILFS_STORE_WORKER=0` (each process opens the Store itself, Busy retry only).

## 0. Results

| Check | Result |
| --- | --- |
| `tests/store-contention.test.mjs` 1: 8 processes × (open, fork, 25 writes, fork, write, merge) | all done in ~620 ms, **0 retries**, every Branch exactly 26 Commits, one worker |
| 2: worker SIGKILLed under load (6 processes × 40 writes) | a new worker starts on the next call; all done, nothing lost or doubled (2 resends per agent) |
| 3: idle | the worker exits after its idle time and removes its endpoint |
| 4: `MINILFS_STORE_WORKER=0` | same load finishes through the Busy retry (4–10 retries per agent) |
| `tests/worker-mount.smoke.mjs`: 4 sessions at once, real NFS mounts + Seatbelt bash + git commit, then merge + apply | all done in ~1 s; folder `git fsck` clean; one worker |
| Security | endpoint 0600, listens on 127.0.0.1 only, a connection without the secret is closed in 2 ms; `<root>/worker` is under the Seatbelt-denied configRoot |
| Full suite on the host | backend 15/15, native-seatbelt 23/23, review-fixes 46/46, orphan-mount 3/3, concurrent-start 1/1, cli 4/4, rpc 6/6, pi 15/15, scale 1/1, elevate 16/16 |

## 1. Problem

In the Quarry test (Pi, lead + 8 `pi-subagents` workers), 5 of 8 workers failed at start:
every tool call answered `minilfs failed to start: Failed: Store open: Store busy before effect`.

Every Pi process loads `@layerfs/agent` with the **in-process transport**: it opens the project's
Store file (`store.sqlite`) itself, through the native addon. N agents = N processes = N SQLite
connections to one file. LayerFS does not queue a call that meets another process's write; it
refuses it.

Measured on LayerFS a700af8, Store calls only (no mount):

| Setup | Result |
| --- | --- |
| 8 **processes**, each `LayerFS.open` + fork + write | 7 of 8 refused at once: `Store busy before effect`, `Storage(Busy)`, `History(Busy)`, `Unknown: Service(History(Busy))`, `Busy` |
| 8 processes, jittered retry around every call | 8 of 8 done; 25 writes + fork + merge each landed exactly once (4 runs) |
| 8 **clients in one process**, all calls concurrent | 8 of 8 done, 0 errors, 526 ms, no retry |

| 8 processes through a **native Store worker** prototype (official worker transport, no retry) | 8 of 8 done, 0 errors, 568–637 ms over 4 runs; every Branch exactly 26 Commits, merges correct |

So LayerFS supports parallel work **inside one process** (it serializes Store access itself);
it does not support several processes writing one Store. Routing every process through one
process (the worker) gives multi-process agents the one-process behavior at about the same speed.

## 2. What official LayerFS does

`@layerfs/agent` has two transports (`api/agent/sdk/src/transport/index.js`):

- **in-process**: the addon in the caller's process. The official note: "Store calls open the
  project's Store here (Linux only)" — one integration process per home.
- **worker**: when `LAYERFS_WORKER_ENDPOINT` names an endpoint file `{ home, port, secret, build }`,
  every binding call is one frame over loopback TCP to a long-lived worker
  (`api/runtime/src/worker/server.js`), which makes the call with the real addon and keeps each
  project's Store open while calls use it. Many processes, one Store connection.

The official worker is built for Docker: on macOS `@layerfs/runtime` runs it in a Linux container
and `server.js` refuses anything but a **sealed Linux bundle** (`manifest.json`). minilfs is
native macOS with no Docker, so it cannot run the official worker as is. The **wire protocol**
and the **client side** are public within the SDK: setting `LAYERFS_WORKER_ENDPOINT` is "open to
any integration" (transport/index.js, owner note 2026-10-24).

## 3. Why retry is not the answer

The retry layer (already written, `withContentionRetry`) makes the test pass, but:

- It is contention, not coordination: with 8 agents doing cargo builds and commits, each Commit
  races the others. Latency grows with the agent count; the 120 s budget can still run out.
- `Unknown` outcomes need a guess (did the head move?). Correct for a session that owns its
  Branch; wrong for shared Branches (`main` publish, `lead` merges) where another writer moves it.
- Every process holds its own SQLite connection, cache and WAL view: N times the memory, and
  checkpoints fight.
- It hides a design limit instead of removing it.

Retry stays as a safety net (worker restarts, a Store opened by a tool outside minilfs), not as
the concurrency model.

## 4. Proposal: one native Store worker per minilfs root

```
 Pi lead ──┐                         ┌──────────────────────────────┐
 Pi P1  ───┤  @layerfs/agent         │ minilfs store worker (Node)  │
 Pi P2  ───┼─ worker transport ────▶ │  layerfs.node (macOS addon)  │──▶ store.sqlite (one connection)
 ...       │  (LAYERFS_WORKER_       │  same frame protocol as      │──▶ layerfs-daemon (mounts)
 Pi C   ───┘   ENDPOINT, TCP 127.0.0.1)│  official server.js          │
                                     └──────────────────────────────┘
```

- **Process:** `src/store-worker.ts`, a small Node server speaking the official frame protocol
  (`frame`/`readFrames`/`decode` from `@layerfs/agent/internal`, same request
  `{ id, fn, op, args, open }`, same answers). It loads the bundle's macOS `layerfs.node` and
  forwards `call` / `backendCall` / `storeOpen` / `storeClose`, keeping each Store open while
  used (refcount + idle close, as `server.js` does). No manifest check (minilfs's bundle is
  pinned by `layerfs.json` and its own sha256).
- **Endpoint:** `<root>/worker/<build>/endpoint.json` `{ home, port, secret, build, pid }`, mode 0600,
  127.0.0.1 only, 64-hex secret checked on the first frame (as `server.js`).
- **Lifecycle:** the first minilfs session of a root starts it (detached, under the root's lock,
  like the daemons); later sessions find it by `ping`. It exits after N minutes with no client
  and no open Store. A crashed worker is restarted by the next call that cannot reach it.
- **Clients:** `createProjectClient` sets `LAYERFS_WORKER_ENDPOINT` for the factory call, so the
  official SDK picks the worker transport; nothing else in minilfs changes (every `lfs.*` call
  is the same API).
- **Mounts:** `workspace.mount/exec/commit` go through the worker too. The daemon and NFS mount
  stay native; the bash command itself is still spawned by the agent's own process under its
  Seatbelt profile (minilfs runs bash itself, not via `workspace.exec`), so the sandbox
  boundary is unchanged.
- **Sandbox:** the agent's bash never sees the endpoint (no `LAYERFS_*` in its env, already the
  case) and Seatbelt denies `<root>/worker` like the rest of the root.

## 5. Risks and checks

| Risk | Check before shipping |
| --- | --- |
| Worker is a single point of failure | kill -9 the worker mid-run: the next call restarts it; a call lost after send answers `Unknown` (SDK), minilfs verifies by head as today |
| Long calls block others (Init, big apply) | the addon runs calls on a 64-thread pool (`UV_THREADPOOL_SIZE`); test 8 agents with one 300 MB Init running |
| Throughput | 8 processes × (fork, 25 writes, merge) through the worker vs in-process: target ≤ 2× the one-process time |
| Version skew | endpoint carries `build` = LayerFS commit; a client of another commit refuses and asks for a restart |
| Security | loopback + secret file 0600 + Seatbelt deny of `<root>/worker`; never exposed to agent bash |

Tests: `tests/store-contention.test.mjs` without the retry layer (must pass through the worker
alone), the full suite, and the Quarry run with 8 parallel workers.

## 6. Alternatives considered

- **Retry only** — see §3.
- **One process for all agents** (agents as threads, Epi `task`-style in-process sub-agents):
  not possible with `pi-subagents`, which starts separate processes; would tie minilfs to one host.
- **Official worker in Docker** — contradicts minilfs's zero-Docker goal.
- **Upstream LayerFS: queue instead of refuse** (SQLite `busy_timeout` in the addon) — the right
  long-term fix for multi-process use; propose it upstream, but minilfs cannot wait on it.
