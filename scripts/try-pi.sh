#!/usr/bin/env bash
# Try this checkout of minilfs in a real Pi session, fully apart from the minilfs you use every day.
#
#   scripts/try-pi.sh                      a fresh scratch git project (made by --reset or on first run)
#   scripts/try-pi.sh --project <dir>      an existing folder (careful: apply writes there)
#   scripts/try-pi.sh --reset              wipe the test state and the scratch project, then start
#   scripts/try-pi.sh -- <pi args...>      extra Pi arguments, e.g. -- --model magpie/grok/grok-4.7
#
# What is separate from your daily setup:
#   - the extension: Pi loads only ./src/index.ts of this checkout (-ne: no other extension discovery,
#     so the installed minilfs from ~/.epi/epi.json or ~/.pi is not loaded)
#   - state: MINILFS_ROOT=~/.cache/minilfs-try (Stores, bindings, daemons, mounts) instead of ~/.cache/minilfs
#   - daemons and sandboxes: MINILFS_PREFIX=minilfs-try- (never matches the running minilfs- daemons)
#   - the LayerFS bundle: MINILFS_BUNDLE (default: the bundle of the commit in layerfs.json,
#     ~/.cache/minilfs-try/bundle-<commit7>; built or copied by --bundle-from <dir>)
#   - Pi sessions: --session-dir ~/.cache/minilfs-try/sessions
#   - model providers from extensions: MINILFS_TRY_EXTRA_EXTENSIONS (default ~/.pi/agent/extensions/magpie.ts)
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
TRY="${MINILFS_TRY_ROOT:-${HOME}/.cache/minilfs-try}"
PIN=$(sed -n 's/.*"commit": *"\([0-9a-f]*\)".*/\1/p' "${HERE}/layerfs.json")
PROJECT="${TRY}/project"
BUNDLE="${MINILFS_BUNDLE:-${TRY}/bundle-${PIN:0:7}}"
BUNDLE_FROM=""
RESET=0
PI_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT=$(cd "$2" && pwd); shift 2 ;;
    --reset) RESET=1; shift ;;
    --bundle-from) BUNDLE_FROM=$2; shift 2 ;;
    --) shift; PI_ARGS=("$@"); break ;;
    -h|--help) sed -n 2,17p "$0"; exit 0 ;;
    *) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done

command -v pi >/dev/null || { echo "pi not found on PATH" >&2; exit 1; }

if [ "${RESET}" = 1 ]; then
  echo "==> reset: stopping test daemons, unmounting, removing ${TRY}/{root,sessions,project}"
  pkill -f "layerfs-daemon --config ${TRY}/root/local/" 2>/dev/null || true
  mount | awk -v p="${TRY}/root" 'index($3, p) == 1 { print $3 }' | while read -r m; do umount -f "$m" 2>/dev/null || true; done
  rm -rf "${TRY}/root" "${TRY}/sessions"
  [ "${PROJECT}" = "${TRY}/project" ] && rm -rf "${TRY}/project"
fi

# the bundle: copy a prebuilt one (e.g. --bundle-from /private/tmp/minilfs-bundle-v110), else it must exist
if [ -n "${BUNDLE_FROM}" ]; then
  echo "==> bundle: ${BUNDLE_FROM} -> ${BUNDLE}"
  rm -rf "${BUNDLE}"; mkdir -p "$(dirname "${BUNDLE}")"; cp -R "${BUNDLE_FROM}" "${BUNDLE}"
fi
for f in layerfs.node layerfs-daemon api/agent/sdk/src/index.js; do
  [ -e "${BUNDLE}/${f}" ] || {
    echo "no LayerFS bundle at ${BUNDLE} (missing ${f})." >&2
    echo "  build one:  scripts/setup-layerfs.sh --bundle ${BUNDLE}" >&2
    echo "  or copy:    $0 --bundle-from <bundle dir>" >&2
    exit 1
  }
done
grep -q "${PIN:0:7}" "${BUNDLE}/BUILD-INFO.txt" 2>/dev/null || echo "warning: ${BUNDLE}/BUILD-INFO.txt does not name LayerFS ${PIN:0:7}; minilfs will refuse a bundle of another commit" >&2

# a scratch project with git history, a submodule-like nested repo, ignored output and a secret
if [ ! -d "${PROJECT}" ]; then
  echo "==> scratch project: ${PROJECT}"
  mkdir -p "${PROJECT}/src"
  cd "${PROJECT}"
  printf 'node_modules/\ndist/\n*.log\n' > .gitignore
  printf 'export const add = (a, b) => a + b;\n' > src/math.js
  printf '{ "name": "try", "type": "module", "scripts": { "test": "node --test" } }\n' > package.json
  printf 'import test from "node:test";\nimport assert from "node:assert";\nimport { add } from "./src/math.js";\ntest("add", () => assert.equal(add(1, 2), 3));\n' > math.test.js
  printf 'API_KEY=do-not-leak\n' > .env
  mkdir -p node_modules/dep && printf 'module.exports = 1;\n' > node_modules/dep/index.js
  git init -q -b main
  git -c user.name=try -c user.email=try@local add -A
  git -c user.name=try -c user.email=try@local commit -qm "initial"
  cd - >/dev/null
fi

# model providers that live in extensions (Pi's -ne turns discovery off): load them explicitly
EXTRA_EXT=()
for f in ${MINILFS_TRY_EXTRA_EXTENSIONS:-${HOME}/.pi/agent/extensions/magpie.ts}; do
  [ -f "$f" ] && EXTRA_EXT+=(-e "$f")
done

mkdir -p "${TRY}/sessions"
echo "==> Pi with minilfs from ${HERE}"
echo "    project ${PROJECT} · state ${TRY}/root · bundle ${BUNDLE}"
echo "    checklist: ${HERE}/docs/TRY-IN-PI.md"
cd "${PROJECT}"
exec env \
  MINILFS_ROOT="${TRY}/root" \
  MINILFS_PREFIX="minilfs-try-" \
  MINILFS_BUNDLE="${BUNDLE}" \
  pi -ne -e "${HERE}/src/index.ts" "${EXTRA_EXT[@]+"${EXTRA_EXT[@]}"}" --session-dir "${TRY}/sessions" "${PI_ARGS[@]+"${PI_ARGS[@]}"}"
