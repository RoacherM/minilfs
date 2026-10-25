# pi-layerfs (`RoacherM/pi-layerfs`)

A **100% Native, Zero-Docker** [LayerFS](https://github.com/Ephemeral-AI-Lab/layerfs) runtime, [Pi](https://pi.dev) / [Epi](https://github.com/RoacherM/epi) extension, and universal CLI / MCP server that isolates agent file operations and shell commands on copy-on-write LayerFS branches, guarded at the OS kernel level by a Claude Code (`@anthropic-ai/sandbox-runtime` / `srt`)-inspired macOS Seatbelt (`sandbox-exec`) sandbox.

Your real project folder changes **only** when you run `/layerfs apply` (or `layerfs_apply` / `pi-layerfs apply`).

---

## Architecture: Harness-Agnostic Core + Universal Adapters

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Upper Layer: Universal Harness Surfaces                                 │
│  ├─ Pi & Epi Extension (`src/index.ts`)                                 │
│  │    `epi install git:github.com/RoacherM/pi-layerfs`                  │
│  │    `pi install git:github.com/RoacherM/pi-layerfs`                   │
│  ├─ CLI & MCP Server (`src/cli.ts`)                                     │
│  │    `pi-layerfs mcp` -> Claude Code / Codex / Cursor MCP Server       │
│  │    `pi-layerfs exec -- <cmd>` -> Sandboxed branch command runner     │
│  └─ Programmatic SDK (`@roacherm/pi-layerfs/core`, `src/core/index.ts`) │
├─────────────────────────────────────────────────────────────────────────┤
│ Lower Layer: Harness-Agnostic Native Workspace Engine (`src/core/`)     │
│  Zero Pi/Epi dependencies! Pure Node.js + Native LayerFS + OS Seatbelt. │
│  ├─ In-process APFS SQLite Store (`layerfs.node`)                       │
│  │    read / write / edit / ls / find / grep / diff / history in ~1–8ms │
│  ├─ Local NFSv3 Loopback Daemon (`layerfs-daemon` on 127.0.0.1)         │
│  │    Unprivileged `/sbin/mount_nfs` per-branch Workspace mounts        │
│  ├─ Claude Code (`srt`)-Style macOS Seatbelt Sandbox (`src/seatbelt.ts`)│
│  │    • Deny-by-default writes: only mounted branch & scratch writable  │
│  │    • Kernel write-lock on real host project folder & `.git/config`   │
│  │    • Kernel read-deny & move-blocking on `.env*`, `*.key`, `~/.ssh`  │
│  │    • Kernel `file-mount`/`file-unmount` & optional network lockdown  │
│  └─ Multi-Agent Team DAG (`merge`, 3-way fallback, `checkout`, `sync`)  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 1. Prerequisites (Once per Mac — Zero Docker, Zero Root, Zero macFUSE)

| Need | Why |
|---|---|
| macOS (Apple Silicon / Intel) | Uses macOS built-in `/sbin/mount_nfs` and `/usr/bin/sandbox-exec` |
| Rust (`cargo`) & `git` | Builds the native `layerfs-daemon` and `layerfs.node` once |

Build the native bundle (`~/.cache/epi-layerfs/bundle-native`, ~1 min):

```bash
git clone https://github.com/RoacherM/pi-layerfs.git
./pi-layerfs/scripts/setup-layerfs.sh
```

---

## 2. Install in Epi or Pi (Direct from GitHub!)

### Epi

```bash
# Global install (~/.epi/epi.json)
epi install git:github.com/RoacherM/pi-layerfs

# Or project-only (.epi/epi.json)
epi install -l --approve git:github.com/RoacherM/pi-layerfs
```

### Pi

```bash
# Global install (~/.pi/agent/settings.json)
pi install git:github.com/RoacherM/pi-layerfs

# Or project-only (.pi/settings.json)
pi install -l git:github.com/RoacherM/pi-layerfs
```

---

## 3. Use in Claude Code, Codex CLI, or Cursor (MCP + CLI)

### As an MCP Server (`.mcp.json` or `epi mcp add`)

```json
{
  "mcpServers": {
    "layerfs": {
      "command": "node",
      "args": ["/path/to/pi-layerfs/src/cli.ts", "mcp"],
      "env": {
        "PI_LAYERFS_TEAM": "1"
      }
    }
  }
}
```

### As a Standalone CLI

```bash
# Run any command inside an isolated LayerFS branch + macOS Seatbelt sandbox
node ./src/cli.ts --branch worker-1 exec -- cargo test

# Inspect, diff, merge, and apply branches
node ./src/cli.ts status
node ./src/cli.ts branches
node ./src/cli.ts diff worker-1
node ./src/cli.ts merge worker-1
node ./src/cli.ts apply
```

---

## 4. Programmatic SDK (`@roacherm/pi-layerfs/core`)

`src/core/index.ts` has **zero** `@earendil-works/pi-coding-agent` dependencies. Any Node.js harness can embed it directly:

```ts
import {
  LayerfsSession,
  resolveConfig,
  createHarnessOperations,
  executeLayerfsAction,
  executeLayerfsApply,
} from "@roacherm/pi-layerfs/core";

const session = new LayerfsSession(process.cwd(), "worker-1", resolveConfig({ PI_LAYERFS_TEAM: "1" }));
await session.open();

const ops = createHarnessOperations(session);
await session.mutate("w1", "write", () => ops.write.writeFile("src/feature.ts", "export const ok = true;\n"));
console.log(await executeLayerfsAction(session, { action: "diff" }));
console.log(await executeLayerfsApply(session));

await session.close();
```

---

## 5. Interactive Commands (`/layerfs`)

| Command | Does |
|---|---|
| `/layerfs status` | branch, logical alias, checkpoints, blocked state |
| `/layerfs diff [branch] [base]` | files changed on this session's branch (or between any two branches) |
| `/layerfs history [n]` | checkpoints: tool, time, changed files, HEAD / applied |
| `/layerfs apply [--revert]` | 3-way checked write back to your host folder |
| `/layerfs sync [--full]` | sync external host edits into LayerFS `main` |
| `/layerfs branches` | active user/worker branches with logical aliases |
| `/layerfs merge <branch> [--ours\|--theirs]` | merge another branch into yours (with automatic path-wise fallback merge) |
| `/layerfs retry` | retry after a failed checkpoint |

---

## 6. Configuration

| Env | Default |
|---|---|
| `PI_LAYERFS` | on; `0` turns it off (`--no-layerfs` flag also disables for one run) |
| `PI_LAYERFS_BUNDLE` | `~/.cache/epi-layerfs/bundle-native` |
| `PI_LAYERFS_ROOT` | `~/.cache/pi-layerfs` (home, APFS Stores, local mounts, bindings) |
| `PI_LAYERFS_PREFIX` | `pi-lfs-` |
| `PI_LAYERFS_NETWORK` | `allow` \| `localhost` \| `deny` (`offline`) — Seatbelt outbound network policy inside `bash` |
| `PI_LAYERFS_EXCLUDES` | `.env,.env.*,*.pem,*.key,id_rsa*,id_ed25519*,.npmrc,.netrc,.pypirc` |
| `PI_LAYERFS_BRANCH_ONLY` | comma-separated build-output patterns (e.g. `target/,.cargo-home/`) kept only in branches |
| `PI_LAYERFS_TEAM` | `1` enables multi-agent `layerfs` / `layerfs_apply` tools |
| `PI_LAYERFS_BRANCH_NAME` | logical branch alias for this session (defaults to `lead` or `s-<shortId>`) |

## License

MIT.
