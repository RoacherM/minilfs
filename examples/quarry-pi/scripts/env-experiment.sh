# Environment for every Pi process of the Quarry-on-minilfs experiment (bash & zsh compatible).
# Sourced by scripts/run.sh; sub-agents inherit it from the lead.
_src="${BASH_SOURCE[0]:-${(%):-%x}}"
here="$(cd "$(dirname "$_src")/.." && pwd)"
unset _src
export PATH="$HOME/.cargo/bin:$PATH"
# Pi: the experiment's own agent dir (models, pi-subagents, this minilfs checkout), never ~/.pi/agent
export PI_CODING_AGENT_DIR="$here/.quarry-agent"
# minilfs under test (a checkout; default the local repository)
export QUARRY_MINILFS_SRC="${QUARRY_MINILFS_SRC:-$HOME/Projects/sides/minilfs}"
# minilfs: team mode (lead alias, minilfs + minilfs_apply tools), own state, own daemon names
export MINILFS_TEAM=1
export MINILFS_ROOT="${MINILFS_ROOT:-$HOME/.cache/minilfs-quarry}"
export MINILFS_PREFIX="${MINILFS_PREFIX:-minilfs-q-}"
_pin=$(sed -n 's/.*"commit": *"\([0-9a-f]*\)".*/\1/p' "$QUARRY_MINILFS_SRC/layerfs.json" 2>/dev/null || true)
export MINILFS_BUNDLE="${MINILFS_BUNDLE:-$MINILFS_ROOT/bundle-${_pin:0:7}}"
unset _pin
# host-only: never imported into branches, never applied (on top of minilfs's default secrets)
export MINILFS_EXCLUDES=".env,.env.*,!.env.example,*.pem,*.key,id_rsa*,id_ed25519*,.npmrc,.netrc,.pypirc,*.p12,*.pfx,credentials.json,service-account*.json,.git-credentials,.quarry-agent/,runs/"
# a calling Pi/Epi session must not leak into the experiment
unset PI_SESSION_FILE PI_SESSION_ID PI_MODEL PI_PROVIDER PI_REASONING_LEVEL PI_SUBAGENT_CHILD PI_SUBAGENT_PARENT_SESSION EPI_TASK_JOB_ID MINILFS_ROLE MINILFS_BRANCH_NAME
