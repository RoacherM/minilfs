# pi-layerfs

Pi extension: **every Pi session works in an isolated [LayerFS](https://github.com/Ephemeral-AI-Lab/layerfs) workspace by default.**
`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` and user `!` commands run against a
Linux LayerFS Branch/Workspace imported from the project folder. Your folder changes only
when you run `/layerfs apply`.

Status: v0.1, tested with stock Pi 1.2.0 and LayerFS `5fb68dd` on macOS arm64 + Docker Desktop.
Not wired into Epi yet.

## How it works

```
Pi (host)  ── tools ──▶ docker exec ──▶ Sandbox container: /workspaces/N  (FUSE, LayerFS)
   │                                         ▲
   └── SDK calls (JSON lines) ──▶ worker container (--network host, real layerfs.node)
```

Per session: filtered copy of the cwd (secrets excluded) → `project.init` → Branch `work` →
one mounted Workspace. Every change (write/edit/bash/`!cmd`) is committed as a checkpoint
recorded with its tool-call id (`layerfs-checkpoint` session entry). `/layerfs apply` writes
the Branch's changes to the folder, refusing everything if you edited any of those files
yourself since the session started.

## Setup

1. Build LayerFS (no published artifacts) — see `dsh/README.md` step 1 upstream; this repo
   used the Docker recipe into `~/.cache/epi-layerfs/bundle-5fb68dd` (`layerfs-daemon`,
   `layerfs.node`, `sdk/js`), ~4 min cold.
2. Runtime image: `docker build -t epi-lfs-runtime:node24-5fb68dd <layerfs>/dsh/tools/history/runtime`.
3. Run Pi with the extension: `pi -e /path/to/pi-layerfs` (or add it as a Pi package).

| Env | Default |
|---|---|
| `PI_LAYERFS` | on; `0` = explicit opt-out |
| `PI_LAYERFS_BUNDLE` | `~/.cache/epi-layerfs/bundle-5fb68dd` |
| `PI_LAYERFS_IMAGE` | `epi-lfs-runtime:node24-5fb68dd` |
| `PI_LAYERFS_ROOT` | `~/.cache/pi-layerfs` (LayerFS home, session records) |
| `PI_LAYERFS_EXCLUDES` | `.env,.env.*,*.pem,*.key,id_rsa*,id_ed25519*,.npmrc,.netrc,.pypirc` |
| `PI_LAYERFS_ENV_ALLOW` | env vars passed into commands besides `PI_*` (host env is NOT forwarded) |

Opt-out flag: `--no-layerfs` — put it **before** the prompt/other args (Pi boolean extension
flags consume a following non-flag argument).

## Commands

`/layerfs status` · `/layerfs diff` · `/layerfs apply` (confirm dialog when a UI exists) · `/layerfs retry`

## Guarantees (each covered by tests)

- Fail-closed: if Docker/image/bundle/worker is unavailable, file tools error; nothing falls back to the host folder.
- Host folder is written only by `/layerfs apply`; apply is all-or-nothing on conflicts; `.git/` internals are never applied.
- Files outside the project are read-only (reads go to the host, e.g. skills); writes are refused.
- Live bash output; abort/timeout TERM→KILL the command's whole session inside the Sandbox.
- A failed checkpoint blocks further changes until `/layerfs retry`; the next checkpoint records every pending tool-call id.
- Parallel tool calls are serialized for mutation + checkpoint.
- Shutdown stops commands, checkpoints, reaps processes holding the mount, unmounts, removes containers; the project volume is kept only when work is unapplied or unconfirmed.

## Tests

```bash
npm test               # all suites, real LayerFS + Docker (≈4 min)
npm run test:backend   # session backend, no Pi (16)
npm run test:pi        # real Pi AgentSession + scripted model (17)
npm run test:cli       # real `pi -p` binary incl. concurrent sessions (5)
npm run test:rpc       # real `pi --mode rpc`: status line, notify, apply confirm (6)
npm run test:scale     # APFS clone of a real repo (default ~/Projects/sides/epi)
npm run probe:real     # low-level LayerFS probes (see probes/real/FINDINGS.md)
```

## Known limits

- **Startup**: ~8 s for a small project, ~20 s for a 23k-file repo with node_modules (copy + hashing ≈9 s, init + prewarm + mount ≈11 s). Tools wait for it.
- **Upstream bug**: the first Workspace of a fresh Sandbox fails to unmount (deterministic here); a 2 s throwaway prewarm Workspace absorbs it and is leaked per session.
- On the default Docker bridge network the binding cannot reach a new Sandbox; the worker uses `--network host`.
- Commands run in Linux: host (darwin) `node_modules` native addons are copied as-is and will not load there.
- Only the 7 built-in tools and `!` commands are isolated; other extensions/MCP tools still act on the host.
- No resume: a resumed/forked Pi session starts a fresh workspace from the current folder; unapplied work of an ended session stays in its Docker volume (`~/.cache/pi-layerfs/sessions/<project>/session.json`) without a restore command yet.
- **No orphan GC yet**: if Pi is killed hard (SIGKILL/crash) its worker/Sandbox containers and volume stay behind (`docker ps -a --filter name=pi-lfs-`). Needs a startup sweeper or `/layerfs gc`.
- `grep` uses GNU `grep -P` in the Sandbox (not ripgrep); `find` globs use Node `path.matchesGlob`.
- Interactive TUI rendering was not driven directly; its dialogs/status were tested through RPC mode.
