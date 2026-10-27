# minilfs (`RoacherM/minilfs`)

> **One-sentence summary:** **`minilfs` is the zero-Docker macOS-native Agent Runtime for [LayerFS v1.1.0](https://github.com/Ephemeral-AI-Lab/layerfs)**: it pairs the official `@layerfs/agent` SDK (`1 call = 1 Commit`, full-tree import including `.git` and dependencies, explicit Sandbox + NFSv3 Workspace lifecycle, native 3-way `branch.merge` with merge units + `.lww`) with an Anthropic (`@anthropic-ai/sandbox-runtime` / `srt`)-style macOS Seatbelt (`sandbox-exec`) pure sandbox, so agents read, edit, build, test, commit, and merge entirely inside isolated Branches until `apply` writes back to your host folder.

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

Nothing on Apple silicon (macOS 11+): the first start downloads the prebuilt LayerFS bundle (`layerfs-daemon`, `layerfs.node`, JS SDK; ~8 MB) from this repository's [GitHub releases](https://github.com/RoacherM/minilfs/releases), checks its pinned sha256 and installs it in `~/.cache/minilfs/bundle-<commit7>` (named after the LayerFS commit pinned in `layerfs.json`; `MINILFS_BUNDLE` overrides it). A bundle of another LayerFS commit is refused, never used.

The bundle is built in CI: `.github/workflows/bundle.yml` runs `scripts/setup-layerfs.sh` on a macOS Apple-silicon runner whenever that recipe changes (or by hand), packs it with `scripts/package-bundle.sh`, smoke-tests it (`scripts/smoke-bundle.mjs`: LayerFS Init and a read with the packed binaries), publishes a release and pins its URL and sha256 in `src/bundle.json`. To upgrade LayerFS, change the commit in `scripts/setup-layerfs.sh` and push.

To build it from LayerFS source yourself (needs Rust), or on another machine:

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
| `MINILFS_BUNDLE` | `~/.cache/minilfs/bundle-<commit7>` for the commit in `layerfs.json` (downloaded on first start when missing) |
| `MINILFS_ROOT` | `~/.cache/minilfs` (home, APFS Stores, local mounts, bindings) |
| `MINILFS_PREFIX` | `minilfs-` |
| `MINILFS_NETWORK` | `allow` \| `localhost` \| `deny` (`offline`) — Seatbelt outbound network policy inside `bash` |
| `MINILFS_EXCLUDES` | `.env,.env.*,!.env.example,!.env.sample,!.env.template,!.env.dist,!.env.defaults,*.pem,*.key,id_rsa*,id_ed25519*,.npmrc,.netrc,.pypirc,*.p12,*.pfx,*.jks,*.keystore,*.kdbx,credentials.json,client_secret*.json,service-account*.json,.git-credentials` — secrets: never imported, read or written; `!pattern` re-includes. Ignored files are imported now, so add any other secret file names here |
| `MINILFS_BRANCH_ONLY` | comma-separated build-output patterns (e.g. `target/,.cargo-home/`) |
| `MINILFS_BRANCH_NAME` | logical branch alias for this session (defaults to `lead` or `s-<shortId>`) |
| `MINILFS_MAX_IMPORT_FILES` | `300000` — a first import or a host sync above this is refused before copying |
| `MINILFS_MAX_IMPORT_MB` | `8192` — same, by total size |
| `MINILFS_INIT_TIMEOUT_MS` | LayerFS Init timeout in milliseconds (defaults to `@layerfs/agent`'s `INIT_TIMEOUT_MS`, `300000` / 300 s) |
| `MINILFS_STORE_WORKER` | `1` (default): every Pi process of a root (lead and sub-agents) makes its Store calls through one native store worker (`<root>/worker/`, 127.0.0.1 + secret, exits when idle), so parallel agents never race for the Store. `0`: each process opens the Store itself (only a Busy retry protects it). See `docs/DESIGN-store-worker.md` |
| `MINILFS_WORKER_IDLE_MS` | how long the store worker waits with no client before it exits (default `600000`, 10 min) |
| `MINILFS_ROLE` | force `lead` or `worker` (normally detected: Pi sub-agents, Epi tasks) |

**What is imported: the full project tree (aligned with official LayerFS).** Following LayerFS's core mental model (*"A Workspace is a complete mutable filesystem view over an immutable committed root. Include `.git` and its index, ignored files, dependencies, symlinks, caches and output; Git ignore rules do not filter LayerFS state"*), a session's Branch holds the complete project tree, `.git/` and dependencies included (`06 · Instant Bootstrap`). Only secret patterns (`MINILFS_EXCLUDES`) and explicit `MINILFS_BRANCH_ONLY` patterns stay out.

**Pure Sandbox Model (In-Sandbox Git & Builds, Zero Host Elevation).** Every agent's file tools (`read`, `write`, `edit`, `ls`, `find`, `grep`) and `bash` act strictly on its own isolated LayerFS Branch (`1 call = 1 Commit`):
- Because `.git/` lives inside each Branch's Workspace, `git status`, `diff`, `log`, `add`, `commit`, `branch` and `merge` work natively inside the sandboxed `bash` without touching the host folder.
- **`.git` is an allowlist** (`src/gitpaths.ts`): only git's data is writable — objects, refs, logs, `HEAD`, `index`, `packed-refs`, in-progress state. Everything else in a git directory can make git run code (`config`, `config.worktree`, `hooks/`, `commondir`, `info/attributes`, `objects/info/alternates`, submodule `modules/*/config|hooks`, …): Seatbelt denies it (regex, any letter case), file tools refuse it, and apply never writes it. So `git config`, `git remote add` and hook installs fail in the sandbox; the user runs those.
- **Merging Branches that both ran git:** `.git` is one LayerFS merge unit (`branch.merge(…, units)`): refs, `HEAD` and the index come whole from one side, so the merged repository is consistent; objects merge as a union, and minilfs then records the join itself: a git merge commit on the checked-out branch whose parents are both sides' heads (lead first), made with git plumbing (`merge-tree`, `commit-tree`, `update-ref`; no work-tree change, no hook), so `git log main` holds every Branch's commits. Where git sees a conflict that LayerFS resolved, the merge commit records LayerFS's merged files. A fast-forward or an up-to-date side needs no commit. The other side's other branch heads are kept as `refs/minilfs/<branch>/heads/<name>`. `node_modules` is a merge unit too. `/.lww` defaults to `%include .gitignore` (generated output is last-writer-wins).
- **Apply and the folder's git:** objects are added (never replaced or deleted); refs, `HEAD` and the index are three-way (the index by its entries, not its stat data). If the folder's git moved meanwhile (a commit made there), no ref, `HEAD` or index is written: the files are applied and show as uncommitted, and the folder's history is never overwritten. Locks and in-progress state are never applied. `/minilfs diff` and the apply preview add one `.git:` line, since views hide `.git`.
- Sub-agents work on their own branches and report their branch name; the lead agent merges sub-agent branches (`minilfs merge <branch>`) and writes the result back to the host folder with `minilfs_apply` (`/minilfs apply`).

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
