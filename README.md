# minilfs (`RoacherM/minilfs`)

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
      "args": ["/path/to/minilfs/src/cli.ts", "mcp"],
      "env": {
        "MINILFS_TEAM": "1"
      }
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

## 5. Interactive Commands (`/layerfs`)

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
| `MINILFS_BUNDLE` | `~/.cache/minilfs/bundle-native` |
| `MINILFS_ROOT` | `~/.cache/minilfs` (home, APFS Stores, local mounts, bindings) |
| `MINILFS_PREFIX` | `minilfs-` |
| `MINILFS_NETWORK` | `allow` \| `localhost` \| `deny` (`offline`) — Seatbelt outbound network policy inside `bash` |
| `MINILFS_EXCLUDES` | `.env,.env.*,*.pem,*.key,id_rsa*,id_ed25519*,.npmrc,.netrc,.pypirc` |
| `MINILFS_BRANCH_ONLY` | comma-separated build-output patterns (e.g. `target/,.cargo-home/`) |
| `MINILFS_TEAM` | `1` enables multi-agent `layerfs` / `layerfs_apply` tools |
| `MINILFS_BRANCH_NAME` | logical branch alias for this session (defaults to `lead` or `s-<shortId>`) |

## License

MIT.
