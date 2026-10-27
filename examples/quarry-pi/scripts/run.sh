#!/usr/bin/env bash
# Start the Quarry lead on Pi + minilfs (zero Docker: macOS Seatbelt + NFSv3 loopback).
#   scripts/run.sh                    interactive (HANDOFF.md is sent as the first message)
#   scripts/run.sh -p                 headless; log in runs/<timestamp>/lead.log
#   scripts/run.sh --check            preflight only (bundle, minilfs, toolchain, pi-subagents)
#   scripts/run.sh --clean            stop test daemons, unmount, wipe minilfs state and generated files
#   scripts/run.sh --bundle-from DIR  copy a LayerFS bundle (of the commit in minilfs's layerfs.json) first
# Env: QUARRY_MODEL (default magpie/deepseek/deepseek-flash:high), QUARRY_MINILFS_SRC (minilfs checkout)
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/env-experiment.sh

mode=interactive
while [ $# -gt 0 ]; do
  case "$1" in
    -p) mode=headless; shift ;;
    --check) mode=check; shift ;;
    --clean) mode=clean; shift ;;
    --bundle-from)
      echo "bundle: $2 -> $MINILFS_BUNDLE"
      rm -rf "$MINILFS_BUNDLE"; mkdir -p "$(dirname "$MINILFS_BUNDLE")"; cp -R "$2" "$MINILFS_BUNDLE"; shift 2 ;;
    -h|--help) sed -n 2,9p "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ "$mode" = clean ]; then
  pkill -f "layerfs-daemon --config $MINILFS_ROOT/local/" 2>/dev/null || true
  mount | awk -v p="$MINILFS_ROOT/" 'index($3, p) == 1 { print $3 }' | while read -r m; do /sbin/umount -f "$m" 2>/dev/null || true; done
  # keep the bundle; drop Stores, bindings, scratch (cargo caches included)
  find "$MINILFS_ROOT" -mindepth 1 -maxdepth 1 ! -name 'bundle-*' -exec rm -rf {} + 2>/dev/null || true
  rm -rf .quarry-agent/sessions
  # back to the setup commit: generated crates, docs and git history of the run are dropped
  root=$(git rev-list --max-parents=0 HEAD | tail -1)
  git reset -q --hard "$root" && git clean -qfdx -e .quarry-agent -e runs
  git for-each-ref --format='%(refname)' refs/minilfs refs/heads | grep -v "refs/heads/main$" | while read -r r; do git update-ref -d "$r"; done
  echo "cleaned $MINILFS_ROOT (bundle kept); folder reset to the setup commit $(git rev-parse --short HEAD)"
  exit 0
fi

# ---- preflight: report every problem at once
problems=()
[ -f "$QUARRY_MINILFS_SRC/src/gitpaths.ts" ] || problems+=("$QUARRY_MINILFS_SRC is not the LayerFS v1.1.0 minilfs (no src/gitpaths.ts); set QUARRY_MINILFS_SRC")
pin=$(sed -n 's/.*"commit": *"\([0-9a-f]*\)".*/\1/p' "$QUARRY_MINILFS_SRC/layerfs.json" 2>/dev/null || true)
for f in layerfs.node layerfs-daemon api/agent/sdk/src/index.js; do
  [ -e "$MINILFS_BUNDLE/$f" ] || { problems+=("no LayerFS bundle at $MINILFS_BUNDLE (missing $f): scripts/run.sh --bundle-from <dir>, or $QUARRY_MINILFS_SRC/scripts/setup-layerfs.sh --bundle $MINILFS_BUNDLE"); break; }
done
if [ -f "$MINILFS_BUNDLE/BUILD-INFO.txt" ] && ! grep -q "${pin:0:7}" "$MINILFS_BUNDLE/BUILD-INFO.txt"; then
  problems+=("bundle $MINILFS_BUNDLE is not LayerFS ${pin:0:7} ($(head -1 "$MINILFS_BUNDLE/BUILD-INFO.txt"))")
fi
command -v pi >/dev/null || problems+=("pi not on PATH")
command -v cargo >/dev/null || problems+=("cargo not on PATH (rustup)")
cargo clippy --version >/dev/null 2>&1 || problems+=("cargo clippy missing (rustup component add clippy)")
python3 -c "import sqlite3" 2>/dev/null || problems+=("python3 with sqlite3 missing")
[ -x /sbin/mount_nfs ] || problems+=("/sbin/mount_nfs missing")
if [ -n "${MINILFS_SCRATCH_DIR:-}" ]; then
  problems+=("running inside a minilfs sandbox (an agent's bash): start this from a normal terminal, minilfs must mount NFS")
fi
[ -d .quarry-agent/npm/node_modules/pi-subagents ] || bash scripts/setup-agent-dir.sh || problems+=("agent dir setup failed (.quarry-agent)")
if [ ${#problems[@]} -gt 0 ]; then
  printf 'preflight failed:\n'; printf '  - %s\n' "${problems[@]}"; exit 1
fi
src_rev="$(git -C "$QUARRY_MINILFS_SRC" rev-parse --short HEAD 2>/dev/null)$(git -C "$QUARRY_MINILFS_SRC" diff --quiet 2>/dev/null || echo '+dirty')"
echo "preflight ok: minilfs $QUARRY_MINILFS_SRC ($src_rev), LayerFS ${pin:0:7}, $(rustc --version)"
[ "$mode" = check ] && exit 0

model="${QUARRY_MODEL:-magpie/deepseek/deepseek-flash:high}"
stamp="$(date +%Y%m%d-%H%M%S)"
mkdir -p "runs/$stamp"
date +%s > "runs/$stamp/started"
printf 'model: %s\nminilfs: %s (%s)\nlayerfs: %s\nroot: %s  prefix: %s\n' \
  "$model" "$QUARRY_MINILFS_SRC" "$src_rev" "$pin" "$MINILFS_ROOT" "$MINILFS_PREFIX" > "runs/$stamp/setup.txt"
echo "run: runs/$stamp  model: $model  minilfs root: $MINILFS_ROOT"
if [ "$mode" = headless ]; then
  set +e
  pi -p --approve --model "$model" "$(cat HANDOFF.md)" > "runs/$stamp/lead.log" 2>&1 < /dev/null
  echo "exit $?" >> "runs/$stamp/lead.log"
  set -e
else
  pi --model "$model" "$(cat HANDOFF.md)" || true
fi
date +%s > "runs/$stamp/ended"
node scripts/metrics.mjs .quarry-agent/sessions --since "$(cat "runs/$stamp/started")" | tee "runs/$stamp/metrics.txt" || true
