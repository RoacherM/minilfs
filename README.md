# minilfs (`RoacherM/minilfs`)

> **One-sentence summary:** While upstream LayerFS is the underlying copy-on-write storage engine (originally Docker/FUSE-based), **`minilfs` is its zero-Docker macOS-native Agent Runtime and multi-agent harness adapter**: it runs file tools in-process (`0` mounts) and `bash` in on-demand NFSv3 + Seatbelt sandboxes (`0` containers), adds multi-agent branch coordination (`merge` with 3-way fallback, `sync`, `diff`, stable branch aliases) plus single-command host elevation (`elevated: true`), and keeps your real folder untouched until `apply` writes back with a 3-way check.

**minilfs** (`@roacherm/minilfs`) is a **100% Native, Zero-Docker** [LayerFS](https://github.com/Ephemeral-AI-Lab/layerfs) workspace runtime, [Pi](https://pi.dev) / [Epi](https://github.com/RoacherM/epi) extension, universal CLI / MCP server, and pluggable distributed execution engine.

It isolates coding agents' file operations and shell commands on copy-on-write LayerFS branches, guarded at the OS kernel level by a Claude Code (`@anthropic-ai/sandbox-runtime` / `srt`)-inspired macOS Seatbelt (`sandbox-exec`) sandbox — while providing a clean `ExecutionDriver` seam to route workloads to remote or distributed Sandboxes without changing a single upper-layer call.

---

## Architecture: Three-Tier Pluggable Design

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Tier 1: Universal Agent Harness Adapters                                │
│  ├─ Pi & Epi Extension (`src/index.ts`)                                 │
│  │    `epi install git:github.com/RoacherM/minilfs`                     │
│  │    `pi install git:github.com/RoacherM/minilfs`                      │
│  ├─ CLI & MCP Server (`src/cli.ts`)                                     │
│  │    `minilfs mcp` -> Claude Code / Codex / Cursor MCP Server          │
│  │    `minilfs exec -- <cmd>` -> Sandboxed branch command runner        │
│  └─ Programmatic SDK (`@roacherm/minilfs/core`, `src/core/index.ts`)    │
├─────────────────────────────────────────────────────────────────────────┤
│ Tier 2: Harness-Agnostic Workspace & DAG Engine (`src/workspace.ts`)    │
│  • In-process APFS SQLite Store (`layerfs.node`) — 1–8ms file ops       │
│  • Multi-Agent Team DAG: `merge` (with automatic 3-way path fallback),  │
│    `sync`, `diff`, `ls`, `show` (paginated), `checkout`, `apply`        │
│  • Persistent post-merge `mtime` refresh across remounts                │
├─────────────────────────────────────────────────────────────────────────┤
│ Tier 3: Pluggable ExecutionDriver Seam (`src/core/driver.ts`)           │
│  ├─ `LocalNativeDriver` (Default):                                      │
│  │    • Local `layerfs-daemon` NFSv3 loopback + `/sbin/mount_nfs`       │
│  │    • Claude Code (`srt`)-style macOS Seatbelt (`sandbox-exec`)       │
│  │    • Built-in `cd <hostCwd>` redirect, macOS `timeout` shim,         │
│  │      and per-branch APFS scratch (`$MINILFS_SCRATCH_DIR`)            │
│  └─ `registerExecutionDriver(name, driver)` (Distributed Seam):         │
│       Route `execInWorkspace` to remote/distributed Sandboxes           │
│       (Cloudflare Sandbox, E2B, Modal, SSH/RPC compute nodes)           │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 1. Prerequisites (Once per Mac — Zero Docker, Zero Root, Zero macFUSE)

Nothing on Apple silicon (macOS 11+): the first start downloads the prebuilt LayerFS bundle (`layerfs-daemon`, `layerfs.node`, JS SDK; ~8 MB) from this repository's [GitHub release](https://github.com/RoacherM/minilfs/releases/tag/bundle-layerfs-833acf7), checks its sha256 and installs it in `~/.cache/minilfs/bundle-native` (`MINILFS_BUNDLE`).

To build it from LayerFS source instead (needs Rust), or on another machine:

```bash
git clone https://github.com/RoacherM/minilfs.git
./minilfs/scripts/setup-layerfs.sh
```

---

## 2. Install in Epi or Pi

### Epi

```bash
# Global install (~/.epi/epi.json)
epi install git:github.com/RoacherM/minilfs

# Or project-only (.epi/epi.json)
epi install -l --approve git:github.com/RoacherM/minilfs
```

### Pi

```bash
# Global install (~/.pi/agent/settings.json)
pi install git:github.com/RoacherM/minilfs

# Or project-only (.pi/settings.json)
pi install -l git:github.com/RoacherM/minilfs
```

---

## 3. Use in Claude Code, Codex CLI, or Cursor (MCP + CLI)

### As an MCP Server (`.mcp.json` or `epi mcp add`)

```json
{
  "mcpServers": {
    "minilfs": {
      "command": "node",
      "args": ["/path/to/minilfs/src/cli.ts", "mcp"]
    }
  }
}
```

### As a Standalone CLI (`minilfs`)

```bash
# Run any command inside an isolated LayerFS branch + macOS Seatbelt sandbox
node ./src/cli.ts --branch worker-1 exec -- timeout 110 cargo test

# Inspect, diff, merge, apply, and clean scratch caches
node ./src/cli.ts status
node ./src/cli.ts branches
node ./src/cli.ts diff worker-1
node ./src/cli.ts merge worker-1
node ./src/cli.ts apply
node ./src/cli.ts clean
```

---

## 4. Pluggable Distributed / Remote Sandbox Driver (`@roacherm/minilfs/driver`)

To dispatch workspace command execution to remote or distributed sandbox nodes while keeping all upper-layer tool calls unchanged:

```ts
import {
  registerExecutionDriver,
  LayerfsSession,
  resolveConfig,
} from "@roacherm/minilfs/core";

registerExecutionDriver("remote-cluster", {
  name: "remote-cluster",
  async preflight() { return "remote-cluster"; },
  async execInWorkspace(ctx) {
    // Dispatch ctx.command + ctx.wsReal state to remote worker node, stream stdout to ctx.options.onData
    return { exitCode: 0 };
  },
  async reapWorkspaceHolders() {},
});

const session = new LayerfsSession(process.cwd(), "worker-1", {
  ...resolveConfig(),
  driver: "remote-cluster",
});
await session.open();
```

---

## 5. Interactive Commands (`/minilfs`)

| Command | Does |
|---|---|
| `/minilfs status` | branch, logical alias, checkpoints, blocked state |
| `/minilfs diff [branch] [base]` | files changed on this session's branch (or between any two branches) |
| `/minilfs history [n]` | checkpoints: tool, time, changed files, HEAD / applied |
| `/minilfs apply [--revert]` | 3-way checked write back to your host folder |
| `/minilfs sync [--full]` | sync external host edits into LayerFS `main` |
| `/minilfs branches` | active user/worker branches with logical aliases |
| `/minilfs merge <branch> [--ours\|--theirs]` | merge another branch into yours (with automatic path-wise fallback merge) |
| `/minilfs clean` | remove temporary scratch build caches for this project |
| `/minilfs retry` | retry after a failed checkpoint |

---

## 6. Configuration (`MINILFS_*`)

| Env | Default |
|---|---|
| `MINILFS` | on; `0` turns it off (`--no-minilfs` flag also disables for one run) |
| `MINILFS_DRIVER` | `native` (or custom registered driver name) |
| `MINILFS_BUNDLE` | `~/.cache/minilfs/bundle-native` (downloaded on first start when missing) |
| `MINILFS_ROOT` | `~/.cache/minilfs` (home, APFS Stores, local mounts, bindings) |
| `MINILFS_PREFIX` | `minilfs-` |
| `MINILFS_NETWORK` | `allow` \| `localhost` \| `deny` (`offline`) — Seatbelt outbound network policy inside `bash` |
| `MINILFS_EXCLUDES` | `.env,.env.*,!.env.example,!.env.sample,!.env.template,!.env.dist,!.env.defaults,*.pem,*.key,id_rsa*,id_ed25519*,.npmrc,.netrc,.pypirc` — secrets: never imported, read or written; `!pattern` re-includes |
| `MINILFS_BRANCH_ONLY` | comma-separated build-output patterns (e.g. `target/,.cargo-home/`) |
| `MINILFS_BRANCH_NAME` | logical branch alias for this session (defaults to `lead` or `s-<shortId>`) |
| `MINILFS_MAX_IMPORT_FILES` | `100000` — first import is refused above this (LayerFS Init has a fixed 60 s deadline) |
| `MINILFS_MAX_IMPORT_MB` | `4096` — same, by total size |
| `MINILFS_ELEVATE` | `auto` (default) \| `ask` \| `never` — single elevated bash commands of the main agent; same as `--minilfs-elevate` and `/minilfs elevate` |
| `MINILFS_ELEVATE_ALLOW` | comma-separated command prefixes that need no confirmation under `ask`, e.g. `git *,docker *` |
| `MINILFS_ROLE` | force `lead` or `worker` (normally detected: Pi sub-agents, Epi tasks) |

**What is imported: the files git sees.** A session's Branch holds the project as `git status` sees it: tracked files plus untracked files that are not ignored. `.git/` is not imported: it stays the folder's. Git-ignored paths (`.gitignore` in every directory, `.git/info/exclude`, `core.excludesFile`) are not imported, not synced from the host and never applied back; agents can still create them inside their Branch (build output, `node_modules/` after an install). A tracked file is always imported, even if a pattern matches it. There is no switch for this.

**Each Branch is a git work tree of the folder's repository.** `.git` is never imported, stored or merged. For each sandboxed command the Workspace gets a `.git` file in git's own linked-worktree layout (`gitdir:` an admin directory under minilfs scratch, whose `commondir` is the folder's repository), so `git log`, `status`, `diff`, `show` and `branch` are current after every elevated commit or host-side change, and `status` shows exactly what apply would change. The sandbox cannot write the repository: `git add`, `commit`, `reset`, `checkout`/`switch`, `stash`, `merge`, `rebase`, `pull` and `push` fail with a hint and run with `elevated: true`. minilfs adds one local line, `/.lww`, to the folder's `.git/info/exclude` (never committed). Projects imported by older versions drop their stored `.git` copy at the next sync.

`<project>/.minilfsignore` adds patterns for minilfs only (gitignore syntax, `!` re-includes), for folders you keep out of git's ignore list but agents need not edit. Secrets (`MINILFS_EXCLUDES`) are excluded on top of both.

A first import is refused before copying when the files to import exceed `MINILFS_MAX_IMPORT_FILES` / `MINILFS_MAX_IMPORT_MB` (LayerFS Init has a fixed 60 s limit); the error lists the largest folders to ignore. After fixing, `/minilfs retry` starts again without restarting.

**Every agent on a Branch; the main agent can elevate single commands.** Every agent's file tools and `bash` act on its own isolated Branch, the main agent included (checkpoints per tool call, `/tree` restores files, the folder changes only on apply). When a step cannot run in the sandbox (git commit/push, Docker, mounts, setuid tools like `ps`, long-running services, "Operation not permitted"), the main agent runs **that one** `bash` call with `elevated: true` and a `reason`: the Branch's unapplied changes are applied to the folder first, the command runs on the real folder with the host's permissions, and the folder's changes come back into the Branch as a `host:` checkpoint. There is no mode to switch.

- Policy (`--minilfs-elevate`, `MINILFS_ELEVATE`, `/minilfs elevate`): `auto` (default, no confirmation), `ask` (the user confirms each command; "always allow" remembers a command prefix), `never`.
- **Under `auto` the main agent's sandbox is a guard rail, not a security boundary**: a prompt-injected main agent can run anything on the host. Use `ask` or `never` if that matters.
- Sub-agents (Pi sub-agents, Epi tasks) never elevate and have no `minilfs_apply`; their branches reach the folder when the main agent merges them (`minilfs merge <branch>`) and applies.
- The user's `!cmd` runs on the real folder (same apply-first / sync-back steps).

**Isolation is for writes, not reads.** `bash` runs under a "wide read, narrow write" Seatbelt profile (like Claude Code's srt): it can read host files outside the Branch except the secret patterns (`.env`, `*.pem`, `~/.ssh`, the Store, …). Do not treat minilfs as a confidentiality boundary.

## 7. Architecture & Design Decisions

See **[`docs/ARCHITECTURE-AND-DECISIONS.md`](./docs/ARCHITECTURE-AND-DECISIONS.md)** for:
- Alignment with the **LayerFS 2.0 Roadmap** (`#446`)
- Three-Tier Architecture (`Adapters` -> `Core Engine` -> `ExecutionDriver`)
- Root-cause diagnosis and solutions for all 10 multi-agent pain points
- Architectural Decision Records (ADRs: Native NFSv3 + Seatbelt vs Docker/FUSE, Multi-Harness Store Sharing, Pluggable Distributed Driver)
- Full `Wayfare` and `Quarry` multi-agent benchmark comparisons

## License

MIT.
