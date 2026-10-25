# minilfs Architecture, Evolution & Decision Record (ADR)

> **Repository:** [`https://github.com/RoacherM/minilfs`](https://github.com/RoacherM/minilfs) (`@roacherm/minilfs`)
> **Status:** v0.4.0 — Production-validated on multi-agent Node.js (`Wayfare`) and Rust (`Quarry`) benchmarks.

---

## 1. Executive Summary & Alignment with LayerFS 2.0

**minilfs** is a **100% Native, Zero-Docker** [LayerFS](https://github.com/Ephemeral-AI-Lab/layerfs) workspace runtime, multi-agent coordination engine, and universal harness adapter.

It implements the application-layer vision outlined in the **LayerFS 2.0 Roadmap ([Issue #446](https://github.com/Ephemeral-AI-Lab/layerfs/issues/446))** — *"Git for people, LayerFS for agents: Develop in LayerFS, then publish to Git"*:

| LayerFS 2.0 Blueprint Area | minilfs Implementation |
|---|---|
| **API / Plugin (`Node SDK`, `CLI`, `MCP`)** | Three-tier decoupled architecture: `src/core/` (pure Node SDK engine), `src/index.ts` (Pi / Epi native extension), and `src/cli.ts` (`minilfs` CLI + stdio MCP Server for Claude Code, Codex, Cursor, and DSH). |
| **File calls (`in-process, no sandbox`, `1 call = 1 Commit`)** | `read`, `write`, `edit`, `ls`, `find`, and `grep` call `layerfs.node` NAPI directly against the SQLite Store in-process (**0 Daemons / 0 Mounts**). Every `write` or `edit` produces an atomic LayerFS Commit in milliseconds, linked to conversation checkpoints (`/tree`, `/fork`, `/resume`). |
| **Bash calls (`mount -> exec -> commit -> unmount`, `Native · macOS`)** | Every `bash` call mounts a copy-on-write Workspace on demand via `layerfs-daemon`'s built-in NFSv3 loopback server (`/sbin/mount_nfs`), runs inside a macOS XNU Seatbelt sandbox (`/usr/bin/sandbox-exec`), commits mutations to the branch, and immediately unmounts. |
| **Cloud / Distributed Sandbox (`Cloud *`)** | Pluggable `ExecutionDriver` seam (`src/core/driver.ts` + `registerExecutionDriver()`) decouples workspace command execution from the upper-layer DAG/Store engine so execution can be dispatched to remote/cloud sandboxes without changing upper-layer tools. |
| **Publish to Git (`1 commit per task checkpoint`)** | Host project directory remains strictly read-only during agent execution. `/minilfs apply` (`minilfs_apply`) performs a 3-way conflict check against host drift before atomically writing merged changes back to the user's Git working tree. |

---

## 2. Three-Tier Architecture

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ Tier 1: Harness Adapters                                                   │
│  • src/index.ts  — Pi / Epi native extension (intercepts read/write/bash) │
│  • src/cli.ts    — Universal CLI (`minilfs <cmd>`) & stdio MCP Server     │
└─────────────────────────────────────┬──────────────────────────────────────┘
                                      │
┌─────────────────────────────────────▼──────────────────────────────────────┐
│ Tier 2: Harness-Agnostic Core Engine (src/core/*, src/workspace.ts)        │
│  • Zero Pi/Epi dependencies                                                │
│  • Store-direct file operations (`createHarnessOperations`)                │
│  • Branch lifecycle, logical aliases, 3-way fallback merge, 3-way apply    │
│  • Multi-process file locks (`BindingStore` with heartbeat & stale-reclaim)│
└─────────────────────────────────────┬──────────────────────────────────────┘
                                      │
┌─────────────────────────────────────▼──────────────────────────────────────┐
│ Tier 3: Pluggable ExecutionDriver Seam (src/core/driver.ts)                │
│  • LocalNativeDriver (default): macOS NFSv3 loopback + Seatbelt sandbox   │
│  • Custom Drivers (`registerExecutionDriver`): SSH / E2B / Cloudflare      │
└────────────────────────────────────────────────────────────────────────────┘
```

### Key Module Responsibilities
- **`src/config.ts`**: Resolves `MINILFS_*` environment variables (`MINILFS`, `MINILFS_DRIVER`, `MINILFS_BUNDLE`, `MINILFS_ROOT`, `MINILFS_NETWORK`, `MINILFS_EXCLUDES`, `MINILFS_BRANCH_ONLY`, `MINILFS_TEAM`, `MINILFS_BRANCH_NAME`).
- **`src/workspace.ts` (`LayerfsSession`)**: Manages project initialization, Store-direct reads/writes, on-demand workspace mounting, `mergeBranch` + `fallbackMergeBranch`, `apply`, `syncHostDriftIntoMain`, and session state persistence.
- **`src/seatbelt.ts`**: Generates dynamic macOS XNU Seatbelt (`sandbox-exec`) SBPL profiles per execution.
- **`src/core/driver.ts`**: Defines `ExecutionDriver`, `WorkspaceExecContext`, `LocalNativeDriver`, and `registerExecutionDriver`.
- **`src/core/tools.ts`**: Defines `createHarnessOperations` (reusable across Pi, Epi, and DSH) and executes `minilfs` (`status | diff | branches | show | ls | checkout | sync | merge | clean`) and `minilfs_apply`.

---

## 3. Root-Cause Diagnosis & Solutions for 10 Multi-Agent Pain Points

During our initial 9-agent Rust SQL database dogfooding run (`Quarry`), we uncovered 10 critical architectural bottlenecks in raw LayerFS multi-agent workflows. All 10 were systematically diagnosed and fixed in `minilfs`:

### 3.1 `invalid record: binding kind` in Native 3-Way Merge
- **Symptom**: After a worker ran `rm` or `mv` inside a mounted `bash` workspace, calling `lfs.branch.merge()` threw `InvalidRecord("binding kind")`, permanently blocking the Lead agent from merging that worker's branch.
- **Root Cause**: `layerfs-fuse` / `layerfs-nfs` recorded directory unlink/rename tombstones with a binding kind that `layerfs-content`'s native 3-way merge validator rejected during tree traversal.
- **Solution (`fallbackMergeBranch` in `src/workspace.ts`)**: When native `lfs.branch.merge()` throws `InvalidRecord` (or when `strategy: "ours" | "theirs"` is requested), `minilfs` automatically falls back to a **path-wise 3-way merge**:
  1. Finds the lowest common ancestor (`baseRef`) between `ours` and `theirs`.
  2. Enumerates changed paths via `diff_branches(base, ours)` and `diff_branches(base, theirs)`.
  3. Performs 3-way content merges using `git merge-file -p` for text files touched on both sides, while preserving executable bits (`+x`) and symlinks via a temporary mounted commit when needed.
  4. Applies the merged tree atomically onto `ours` and records the merge checkpoint.

### 3.2 Merge Conflict Deadlock (" Editing Your Own Branch Doesn't Resolve 3-Way Conflicts")
- **Symptom**: When two branches modified the same file, `merge` reported a conflict. If the Lead agent edited its own file to match the worker's version and retried `merge`, LayerFS still reported a 3-way conflict (because both sides still diverged from the common ancestor).
- **Solution**: Added `strategy: "ours" | "theirs"` (`--ours` / `--theirs` in CLI and `/minilfs merge`) and per-file `resolve` support to `mergeBranch`, plus `action="checkout"` so an agent can either resolve conflicts in one call or selectively pull files from any branch.

### 3.3 Stale Build Binaries Across Branches (`.lww` / `CARGO_TARGET_DIR` Mtime Skew)
- **Symptom**: When `target/` lived inside `.lww` (Last-Write-Wins) or a shared cache directory, merging a worker's source files into Lead preserved older file mtimes than the already-compiled `target/` fingerprint, causing `cargo test` to run stale binaries without recompiling the newly merged `.rs` files!
- **Solution (Two-Pronged)**:
  1. **Persistent `mergedFileMtimes` (`src/workspace.ts`)**: Whenever `mergeBranch` or `fallbackMergeBranch` brings in modified source files, their paths and merge timestamp are recorded in `mergedFileMtimes`. On every subsequent workspace mount, `minilfs` advances those files' mtimes if the NFS mount resets them—even across read-only `grep` commands before `cargo test`.
  2. **APFS Scratch Separation (`MINILFS_SCRATCH_DIR`)**: Injects `MINILFS_SCRATCH_DIR` and `MINILFS_SHARED_CACHE_DIR` on native APFS outside the NFS mount, keeping heavy build artifacts (`CARGO_TARGET_DIR`) at 100% native APFS speed and shrinking the LayerFS Store from `9.9 GB` to `9.1 MB`.

### 3.4 `action="show"` 49KB Truncation
- **Symptom**: `lfs.fs.read()` truncated files larger than ~49KB (`parser.rs`, `executor.rs`), making it impossible for Lead to inspect large worker files.
- **Solution**: Switched `action="show"` to `s.readBytesAtRef()` (which automatically falls back to a byte-exact workspace read for >48KB files) and raised the per-call cap to **100KB** with line-based pagination (`offset` and `limit`).

### 3.5 Missing Directory Listing & File Copy Across Branches
- **Symptom**: Agents could not list files on another branch or copy a single file/directory from a peer branch without merging the entire branch.
- **Solution**: Added `action="ls"` (list directory entries on any branch) and `action="checkout"` (copy one or more files or directories recursively from `<branch>` into the current branch).

### 3.6 Blind Cross-Branch Diffs
- **Symptom**: `diff` only compared the current session's branch against its own base. Lead could not preview what `worker-1` changed before merging.
- **Solution**: Enhanced `action="diff"` (`minilfs diff [branch] [base]`) to diff any target branch against its own base layer (or any explicit `base` branch).

### 3.7 Unstable Ephemeral Branch Names (`s-<hash>-1` -> `s-<hash>-2`)
- **Symptom**: Every merge or ref switch rotated the underlying LayerFS branch name (`-1` -> `-2` -> `-3`). Sub-agents reported `-1` or session IDs, causing Lead's `merge` calls to fail or merge stale heads.
- **Solution**:
  - Added stable **`logicalBranch` aliases** (`lead`, `MINILFS_BRANCH_NAME`, or `s-<shortId>`).
  - Implemented `resolveBranchName()` which resolves logical aliases, session IDs, and stale `-1` branch names to the latest active head (`-N`), prioritizing branches with actual commits (`headCommit !== null`).
  - Added `listUserBranches()` to filter out internal temporary branches (`a-*`, `b-*`, `h-*`, `m-*`, `r-*`, `sync-*`).

### 3.8 CLI Stateless Invocations Overwriting Active Branch Aliases
- **Symptom**: Running `minilfs --branch dsh-probe exec ...` followed by `minilfs --branch dsh-probe diff` opened a fresh session on the second CLI invocation, overwriting the `dsh-probe` alias with an empty branch.
- **Solution**: Updated `setupBranches()` and `openCliSession()` to automatically look up and resume existing sessions in `bindings.json` by `sessionId` or `logicalBranch` scoped to the project directory.

### 3.9 `cd <hostCwd>` Escaping the Mounted Workspace in `bash`
- **Symptom**: Prompts or scripts often ran `cd /Users/.../project && cargo test`. Because the host project path is read-only under Seatbelt while the writable branch is mounted at `$MINILFS_WS_REAL`, `cd <hostCwd>` caused subsequent writes or builds to fail with `EPERM` or inspect stale host files.
- **Solution (`buildNativeShellPrelude` in `src/core/driver.ts`)**: Injects a transparent shell wrapper for `cd` and `pushd` that rewrites `<hostCwd>` (and `<hostCwd>/subpath`) into `$MINILFS_WS_REAL` (and `$MINILFS_WS_REAL/subpath`), plus a built-in POSIX `timeout` function for macOS (returning exit code `124`).

### 3.10 Missing `ping` Handler in MCP Server
- **Symptom**: Strict MCP clients sending JSON-RPC `ping` received `-32601 Method not found`.
- **Solution**: Added `method === "ping"` response (`result: {}`) in `src/cli.ts`.

---

## 4. Key Architectural Decision Records (ADRs)

### ADR-001: Built-in NFSv3 Loopback + macOS Seatbelt over Docker or FUSE-T
- **Context**: On macOS, the original LayerFS runtime ran a Linux Docker container (`layerfs-store` + sandbox containers) over OrbStack/Docker VM volumes. This required a 4.5GB Docker image, incurred heavy VM virtiofs/volume I/O overhead, and left ~10GB per-project Docker volumes. FUSE-T / macFUSE required third-party kernel extensions or unstable user-space daemons.
- **Decision**: Compile `layerfs-daemon` (with `layerfs-nfs` loopback NFSv3 server) and `layerfs.node` natively for `darwin-arm64`. Mount workspaces via macOS's built-in `/sbin/mount_nfs` (`vers=3,tcp,nolocks,locallock,noac,actimeo=0`) and enforce isolation via macOS's built-in XNU `/usr/bin/sandbox-exec` (Seatbelt).
- **Consequences**:
  - **Zero third-party dependencies** (no Docker, no Homebrew FUSE).
  - **40–90ms workspace mount latency**; **0 daemons** during file reads/writes.
  - passed 3 rounds of Opus 5.5 adversarial security review: kernel-enforced deny-by-default `file-write*`, read/write isolation of `config.root` (`stores`, `bindings.json`), blocked `/sbin/mount_nfs` / `/sbin/umount` inside the sandbox, case-insensitive kernel `file-read-data` blocks on `.env`/`*.pem`/`$HOME/.ssh`, and `git -c core.fsmonitor=false -c core.hooksPath=/dev/null` hardening.

### ADR-002: Harness-Agnostic Core (`src/core/`) + Multi-Harness Sharing
- **Context**: Developers use multiple agent harnesses on the same machine (Epi, Pi, DSH, Claude Code, Codex, Cursor). Duplicating the LayerFS runtime per harness wastes disk and fragments project state.
- **Decision**: Strip all `@earendil-works/pi-coding-agent` dependencies out of `src/core/*` and `src/workspace.ts`. Store all project state in a shared root (`~/.cache/minilfs`) protected by cross-process file locks with 2-second heartbeats (`src/lock.ts`).
- **Consequences**:
  - One local installation (`/Users/byronwayne/Projects/sides/minilfs` + `~/.cache/minilfs/bundle-native`) serves Epi, Pi, DSH, Claude Code, and CLI simultaneously.
  - Multiple harnesses working on the same folder share the same Project Store and can inspect, diff, and merge each other's branches in real time.

### ADR-003: Pluggable `ExecutionDriver` Seam for Distributed Sandboxes
- **Context**: While local macOS execution is ideal for single-machine multi-agent runs, future workloads (and LayerFS 2.0's `Cloud *` roadmap) require dispatching heavy `bash` builds/tests to remote or cloud sandbox clusters.
- **Decision**: Introduce `ExecutionDriver` (`src/core/driver.ts`) with `preflight()`, `execInWorkspace(ctx)`, and `reapWorkspaceHolders()`.
- **Consequences**: Upper-layer tools (`read`, `write`, `edit`, `bash`, `minilfs`, `minilfs_apply`) and DAG merge logic remain 100% unchanged when swapping from `LocalNativeDriver` (`MINILFS_DRIVER=native`) to a remote driver.

---

## 5. Multi-Harness Integration Guide (Epi, Pi, DSH, Claude Code, Codex, Cursor)

Because `src/core/index.ts` has zero dependencies on any specific harness and shares a single state root (`~/.cache/minilfs`), all harnesses on a machine can share the **exact same repository, native binary bundle (`~/.cache/minilfs/bundle-native`), and per-project LayerFS Store**.

### 5.1 Integration Modes Overview

| Harness | Recommended Mode | Tool Interception (`read`/`write`/`edit`/`bash`) | Multi-Agent Team Tools (`minilfs` / `minilfs_apply`) |
|---|---|---|---|
| **Epi / Pi** | Native Extension (`src/index.ts`) | **Transparent (100% automatic)** | Built-in (`MINILFS_TEAM=1`) |
| **DSH (`deepseek-harness`)** | Mode A: Native Cordis Plugin (`src/core/index.ts`)<br>Mode B: MCP Server (`src/cli.ts mcp`) | Mode A: **Transparent**<br>Mode B: Explicit (`minilfs_bash`) | Built-in (`minilfs`, `minilfs_apply`, `minilfs_bash`) |
| **Claude Code / Codex / Cursor** | MCP Server (`src/cli.ts mcp`) + CLI (`src/cli.ts`) | Explicit (`minilfs_bash` or `minilfs exec`) | Built-in (`minilfs`, `minilfs_apply`, `minilfs_bash`) |

---

### 5.2 Integrating with Epi & Pi (Transparent Native Extension)

```bash
# Install from GitHub or local path
epi install git:github.com/RoacherM/minilfs
pi install git:github.com/RoacherM/minilfs
```

Every `read`, `write`, `edit`, `ls`, `find`, `grep`, and `bash` call is automatically intercepted and routed to the session's LayerFS branch.

---

### 5.3 Integrating with DSH (`deepseek-harness`)

#### Option A: Via DSH MCP Client (`cordis.patch.yml`, Ready Today)
Add `@deepseek-ai/dsh-mcp-client` to your profile's `cordis.patch.yml` (note: set `cwd` to the target project folder and give DSH its own `MINILFS_BRANCH_NAME` so it doesn't collide with `lead` in other harnesses):

```yaml
- insert:
    - id: mcp-minilfs
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: minilfs
        command: /opt/homebrew/bin/node
        args: [/Users/byronwayne/Projects/sides/minilfs/src/cli.ts, mcp]
        cwd: /path/to/your/project
        env:
          MINILFS_TEAM: "1"
          MINILFS_BRANCH_NAME: "dsh-lead"
```

#### Option B: Building a Transparent Native DSH Cordis Plugin (`dsh-minilfs`)
To transparently intercept DSH's built-in `read`, `write`, `edit`, `grep`, `find`, `ls`, and `bash` tools (just like Epi/Pi), import `@roacherm/minilfs/core` inside a Cordis plugin and replace `tool-fs` / `tool-bash` in the preset:

```ts
import {
  LayerfsSession,
  resolveConfig,
  createHarnessOperations,
  executeLayerfsAction,
  executeLayerfsApply,
  LAYERFS_TOOL_SCHEMA,
  LAYERFS_TOOL_DESCRIPTION,
  LAYERFS_APPLY_TOOL_SCHEMA,
  LAYERFS_APPLY_TOOL_DESCRIPTION,
} from "/Users/byronwayne/Projects/sides/minilfs/src/core/index.ts";

// 1. On DSH session start:
const config = resolveConfig({ ...process.env, MINILFS_BRANCH_NAME: `dsh-${sessionId.slice(0, 8)}` });
const s = new LayerfsSession(projectCwd, sessionId, config);
await s.open({ reason: "resume" });
const ops = createHarnessOperations(s);

// 2. Wire file tools directly to Store (0 mounts, 0 conflict with DSH sandbox):
//    - read:  ops.read.readFile(path) / ops.read.access(path)
//    - write: await s.mutate(callId, "write", () => ops.write.writeFile(path, content))
//    - edit:  await s.mutate(callId, "edit",  () => /* readFile + replace + writeFile */)
//    - grep:  await s.grepWorkspace({ pattern, path, glob, ignoreCase, literal, context, limit })
//    - bash:  await s.mutate(callId, "bash",  () => ops.bash.exec(command, projectCwd, { onData, signal, timeout }))

// 3. Register `minilfs` and `minilfs_apply` control tools using executeLayerfsAction(s, params) and executeLayerfsApply(s).
```

---

### 5.4 Integrating with Claude Code, Codex CLI, or Cursor (`.mcp.json` + CLI)

#### MCP Configuration (`.mcp.json`)
```json
{
  "mcpServers": {
    "minilfs": {
      "command": "node",
      "args": ["/Users/byronwayne/Projects/sides/minilfs/src/cli.ts", "mcp"],
      "env": {
        "MINILFS_TEAM": "1",
        "MINILFS_BRANCH_NAME": "claude-lead"
      }
    }
  }
}
```

#### CLI Invocation from Any Agent or Shell
Each `--branch <alias>` invocation automatically persists and resumes its branch state in `~/.cache/minilfs/state/bindings.json`:

```bash
# Worker runs build/tests inside an isolated branch + Seatbelt sandbox
node /Users/byronwayne/Projects/sides/minilfs/src/cli.ts --branch worker-auth exec -- cargo test

# Inspect or merge from another harness or terminal
node /Users/byronwayne/Projects/sides/minilfs/src/cli.ts diff worker-auth
node /Users/byronwayne/Projects/sides/minilfs/src/cli.ts --branch lead merge worker-auth
node /Users/byronwayne/Projects/sides/minilfs/src/cli.ts --branch lead apply
```

### 5.5 Best Practices When Sharing a Project Across Multiple Harnesses Simultaneously
1. **Assign Distinct `MINILFS_BRANCH_NAME` per Harness**: Set `MINILFS_BRANCH_NAME=epi-lead`, `MINILFS_BRANCH_NAME=dsh-lead`, etc., so each harness's top-level session has a distinct alias instead of all defaulting to `lead`.
2. **Coordinate `apply` Through One Lead Session**: Merge peer harness branches into your active lead branch (`minilfs merge dsh-lead`) before running `minilfs apply`, so `apply`'s 3-way host check advances `main` cleanly without two harnesses overwriting each other on the host disk.
3. **Do Not Mix Old Docker `dsh-layerfs` and Native `minilfs` on the Same Folder**: Ensure legacy `layerfs-store` Docker containers are stopped or unbound when switching a project to `minilfs`.

---

## 6. Production Benchmark Results

### 6.1 Benchmark 1: `Wayfare` (8-Agent Full-Stack Travel Planner, Node 24)
| Metric | DSH + LayerFS (Docker Baseline) | `minilfs` v0.4 (macOS Native + Seatbelt) | Delta / Improvement |
|---|---|---|---|
| **Runtime Architecture** | Docker Linux Container | **Zero-Docker macOS Native (`mount_nfs` + `sandbox-exec`)** | **0 Containers** |
| **Wall-Clock Time** | 56.0 min | **52.0 min** | **-7.1% faster** |
| **Acceptance Checks (`A01`–`A12`)** | 12 / 12 PASS | **12 / 12 PASS (100%)** | **100% Parity** |
| **Unit Tests** | — | **197 / 197 PASS (0 fail)** | **100% Pass** |
| **Total Tokens** | 119.16M | **71.01M** (97.9% cache hit) | **-40.4% fewer tokens** |
| **Merge Conflicts / Tool Errors** | Multiple retries | **0 conflicts / 0 errors** | **Zero friction** |
| **Store Disk Footprint** | Container Volume | **5.0 MB** | **Ultra-compact** |

### 6.2 Benchmark 2: `Quarry` (9-Agent Rust SQL Database Engine, 18.6k LOC)
| Metric | Old LayerFS (Docker Run) | DSH + LayerFS (Docker Baseline) | `minilfs` v0.4 (macOS Native) | Delta vs Old Docker |
|---|---|---|---|---|
| **Runtime Architecture** | Docker (`pi-lfs-store`) | Docker (`dsh-layerfs`) | **Zero-Docker macOS Native** | **No Docker VM** |
| **Wall-Clock Time** | ~320 min (5h20m, stalled) | 256.0 min (4h16m) | **152.6 min (2h32m)** | **2.1x faster (-52%)** |
| **Acceptance (`Q01`–`Q12`)** | 9 / 12 | 12 / 12 PASS | **12 / 12 PASS (100%)** | **+3 checks fixed** |
| **SLT Corpus (764 records)** | 733 / 733 | 764 / 764 PASS | **764 / 764 PASS (100%)** | **100% SQL Logic** |
| **Rust Unit Tests (`cargo test`)** | ~800 | ~1,000 | **1,225 / 1,225 PASS (0 fail)** | **+53% test coverage** |
| **Multi-Agent Merges** | 6 branches stranded | Manual bash merges | **24 / 24 branches merged** | **100% merge rate** |
| **LayerFS Store Disk Usage** | **9.9 GB** (Docker Vol) | Docker Volume | **9.1 MB** (APFS Store) | **-99.9% disk footprint** |
