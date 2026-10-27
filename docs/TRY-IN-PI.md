# Try minilfs in Pi (manual check)

A checklist to run this checkout of minilfs in a real Pi session before it replaces the installed one.
It covers the pure sandbox model and the `.git` fixes (allowlist, merge units, git-aware apply).

## Start

```bash
# once: copy the LayerFS bundle of the pinned commit (layerfs.json) into the test area
scripts/try-pi.sh --reset --bundle-from /private/tmp/minilfs-bundle-v110
# later runs (keeps the test project and its Store)
scripts/try-pi.sh
# pick a model
scripts/try-pi.sh -- --model magpie/grok/grok-4.7
```

The script keeps everything apart from your daily minilfs:

| What | Test run | Daily minilfs |
| --- | --- | --- |
| Extension code | this checkout's `src/index.ts` only (`pi -ne -e`) | `~/.epi/epi.json` / Pi packages |
| State, Stores, mounts | `~/.cache/minilfs-try/root` | `~/.cache/minilfs` |
| Daemon / Sandbox names | `minilfs-try-…` | `minilfs-…` |
| Bundle | `~/.cache/minilfs-try/bundle-<commit7>` | `~/.cache/minilfs/bundle-native` |
| Pi sessions | `~/.cache/minilfs-try/sessions` | `~/.pi/agent/sessions` |
| Project | `~/.cache/minilfs-try/project` (scratch git repo) | your folders |

Run it from a normal terminal, **not** inside an agent's sandboxed bash: minilfs mounts NFS, which a
sandbox forbids.

Watch the status bar: `minilfs starting… Ns`, then the branch name. `/minilfs status` shows the
project, branch and base.

## Checklist

Type each prompt (or `!cmd` / slash command) as written. "Expect" is what passes.

### 1. Start, import, secrets
- `/minilfs status` → a branch `s-…`, project, `pure sandbox (no elevated commands)`.
- Prompt: `list every file in the project including hidden ones, and print .env`
  → expect `.git/`, `node_modules/dep/index.js`, `.gitignore` listed; `.env` **not readable**.

### 2. In-sandbox git (allowed)
- Prompt: `change add() in src/math.js to also handle three arguments, run npm test, then git add and git commit with message "three args"`
  → tests pass; `git log -1` in the agent's bash shows `three args`.
- `!git log --oneline -1` → `three args` (your `!cmd` runs on the Branch, in the sandbox, too).
- From another terminal: `git -C ~/.cache/minilfs-try/project log --oneline -1` → still `initial` (nothing applied yet).
- `/minilfs diff` → `src/math.js` plus one line `.git: 1 ref(s): refs/heads/main, HEAD, index, N object file(s)`.

### 3. Git attacks (must all fail)
Ask the agent to try each, one per prompt, and paste the output:
- `run: git config core.fsmonitor "touch /tmp/minilfs-pwned"`
- `run: printf '#!/bin/sh\ntouch /tmp/minilfs-pwned\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit`
- `run: echo ../../evil > .git/commondir; echo x > .git/CONFIG; echo x > .git/config.worktree`
- `run: mkdir -p .git/modules/s && echo '[core]' > .git/modules/s/config`
- `run: ln -s .git/hooks hk && echo hi > hk/post-commit`
- `run: mv .git .git-old`
- `use the write tool to create .git/hooks/post-checkout with any content`

Expect: every bash attempt says `Operation not permitted`; the write tool says `refused for security`.
After all of them: `ls /tmp/minilfs-pwned` → no such file.

### 4. Apply (git-aware)
- `/minilfs apply` → the confirmation lists the files and a `.git:` line; after it: `Git: .git: …`.
- From a terminal:
  ```bash
  cd ~/.cache/minilfs-try/project
  git log --oneline -2      # three args, initial
  git status --short        # empty
  git fsck --connectivity-only && echo FSCK-OK
  cat .git/config           # unchanged, no fsmonitor/hooksPath
  ls .git/hooks             # only git's *.sample files
  ```

### 5. Host commit meanwhile (must not be overwritten)
- Prompt: `create notes.txt with "branch" and commit it`.
- From a terminal, before applying:
  ```bash
  cd ~/.cache/minilfs-try/project
  echo host > host.txt && git add host.txt && git commit -qm by-host && git rev-parse HEAD
  ```
- `/minilfs apply` → a warning `your folder's git moved…`; files applied.
- Terminal: `git log --oneline -1` → still `by-host` (same id as above); `git status --short` → `?? notes.txt` (or `A`); `git fsck --connectivity-only` OK.
- Then `/minilfs sync` in Pi → the Branch takes the folder's history (`git log` in the agent's bash shows `by-host`).

### 6. Sub-agent merge with git on both sides
Needs a sub-agent tool (Epi `task`, or `pi-subagents`); without one, open a second Pi with
`scripts/try-pi.sh -- --session-id worker1` and work there, then `/minilfs branches` in the first.
- Worker: `create w.txt, git add, git commit -m by-worker; tell me your branch (minilfs action=status)`.
- Lead: `create l.txt, git add, git commit -m by-lead`, then `merge branch <worker branch>`.
  → `Merged …` and a `Git:` line: `main now has a merge commit … with both sides' commits as parents`.
- Lead: `run git fsck --connectivity-only; git log --oneline --graph main; git status --short`
  → fsck clean; `by-worker` and `by-lead` both on main under one `Merge s-… into main` commit; status clean.
- `/minilfs apply`, then in a terminal `git log --oneline -4` shows the join, `git fsck` OK.

### 7. Recovery and edges
- `/tree` to an earlier message, then `/minilfs apply` → refuses with `WouldRevert` (unless `--revert`).
- Leave Pi idle > 2 minutes, then ask for `ls` → still works (a closed Sandbox is replaced).
- `MINILFS_INIT_TIMEOUT_MS=abc scripts/try-pi.sh` → start fails with `must be a positive whole number`, nothing written.

## Report a bug

Include the step number, the exact prompt, the tool output, and:
```bash
ls ~/.cache/minilfs-try/root/state      # bindings
pgrep -fl "layerfs-daemon --config $HOME/.cache/minilfs-try"
mount | grep minilfs-try
```

## Clean up

```bash
scripts/try-pi.sh --reset   # stops test daemons, unmounts, removes test state and the scratch project
rm -rf ~/.cache/minilfs-try # everything, bundle included
```
