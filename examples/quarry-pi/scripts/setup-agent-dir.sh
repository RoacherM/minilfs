#!/usr/bin/env bash
# Builds the experiment's own Pi agent dir (.quarry-agent/): the Magpie model provider,
# pi-subagents, and the minilfs checkout under test (LayerFS v1.1.0, pure sandbox).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
. "$here/scripts/env-experiment.sh"
dir="$PI_CODING_AGENT_DIR"
src="${PI_SOURCE_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -p "$dir/extensions/subagent"
[ -f "$src/extensions/magpie.ts" ] && cp "$src/extensions/magpie.ts" "$dir/extensions/"
if [ -f "$src/auth.json" ]; then cp "$src/auth.json" "$dir/" && chmod 600 "$dir/auth.json" || echo "warning: could not copy $src/auth.json (log in with /login inside Pi)" >&2; fi
model="${QUARRY_MODEL:-magpie/deepseek/deepseek-flash:high}"
provider="${model%%/*}"; rest="${model#*/}"; id="${rest%%:*}"
cat > "$dir/settings.json" <<JSON
{
  "defaultProvider": "$provider",
  "defaultModel": "$id",
  "defaultThinkingLevel": "high",
  "httpIdleTimeoutMs": 900000,
  "packages": ["npm:pi-subagents", "$QUARRY_MINILFS_SRC"]
}
JSON
cat > "$dir/extensions/subagent/config.json" <<'JSON'
{
  "maxActiveAsyncRunsPerSession": 8,
  "timeoutMs": 5400000,
  "waitTool": { "defaultTimeoutMs": 5400000 }
}
JSON
printf '{\n  "%s": true\n}\n' "$here" > "$dir/trust.json"
if [ ! -d "$dir/npm/node_modules/pi-subagents" ]; then
  pi install npm:pi-subagents >/dev/null 2>&1 || {
    # offline: reuse the copy from the earlier Pi experiment
    old="$HOME/Projects/sides/quarry-native-test/.quarry-agent/npm"
    [ -d "$old/node_modules/pi-subagents" ] && mkdir -p "$dir/npm" && cp -R "$old/." "$dir/npm/"
  }
fi
[ -d "$dir/npm/node_modules/pi-subagents" ] || { echo "pi-subagents not installed in $dir/npm" >&2; exit 1; }
echo "agent dir ready: $dir (minilfs: $QUARRY_MINILFS_SRC)"
