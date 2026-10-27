#!/usr/bin/env bash
# Builds the official LayerFS v1.1.0 (#428 + #427) native bundle minilfs runs on, on macOS:
#   - layerfs-daemon and layerfs.node (macOS native build via cargo, zero Docker)
#   - the official JS packages: @layerfs/agent (api/agent/sdk), @layerfs/backend, @layerfs/runtime
#     and the `layerfs` CLI (api/agent/cli), linked together without npm install
#   - the layerfs-js-sdk agent skill
# Bundle layout (${BUNDLE}):
#   layerfs-daemon, layerfs.node, api/binding/layerfs.node, api/package.json,
#   api/agent/{sdk,cli}/{src,package.json}, api/{backend,runtime}/{src,package.json},
#   api/node_modules/@layerfs/{agent,backend,runtime} -> ../../{agent/sdk,backend,runtime},
#   bin/layerfs -> ../api/agent/cli/src/layerfs.js, skills/layerfs-js-sdk
#
# Usage: scripts/setup-layerfs.sh [--ref <git ref>] [--bundle <dir>]
set -euo pipefail

REF="a700af8f492ef360d150877e5d469031767e473f" # keep equal to layerfs.json (checked below)
BUNDLE="${HOME}/.cache/minilfs/bundle-${REF:0:7}"
SRC="${HOME}/.cache/minilfs/src-native"

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF=$2; shift 2 ;;
    --bundle) BUNDLE=$2; shift 2 ;;
    -h|--help) sed -n 2,13p "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

PIN=$(sed -n 's/.*"commit": *"\([0-9a-f]*\)".*/\1/p' "$(dirname "$0")/../layerfs.json" 2>/dev/null || true)
if [ -n "${PIN}" ] && [ "${PIN}" != "a700af8f492ef360d150877e5d469031767e473f" ]; then
  echo "layerfs.json pins ${PIN}, but this script's REF default differs: update both" >&2; exit 1
fi

export PATH="${HOME}/.cargo/bin:${PATH}"
command -v cargo >/dev/null || { echo "cargo not found: install Rust via https://rustup.rs" >&2; exit 1; }
command -v git >/dev/null || { echo "git not found" >&2; exit 1; }

echo "==> LayerFS source ${REF} -> ${SRC} (sparse checkout)"
if [ ! -d "${SRC}/.git" ]; then
  mkdir -p "$(dirname "${SRC}")"
  git clone --filter=blob:none --no-checkout https://github.com/Ephemeral-AI-Lab/layerfs.git "${SRC}"
fi
git -C "${SRC}" sparse-checkout set --no-cone '/core/' '!/core/docs/' '/api/' '/.cargo/' '/LICENSE' '/.agents/skills/layerfs-js-sdk/'

for attempt in 1 2 3 4 5; do
  git -C "${SRC}" fetch --filter=blob:none origin "${REF}" && git -C "${SRC}" checkout --force --quiet "${REF}" && break
  echo "fetch/checkout failed (attempt ${attempt}); retrying in 5 s..." >&2
  sleep 5
  [ "${attempt}" = 5 ] && { echo "could not fetch LayerFS ${REF}; rerun this script to resume" >&2; exit 1; }
done
git -C "${SRC}" reset --hard "${REF}" && git -C "${SRC}" clean -fd

for f in core/Cargo.lock .cargo/config.toml api/package.json api/agent/sdk/src/index.js api/agent/cli/src/layerfs.js \
         api/backend/src/index.js api/runtime/src/index.js .agents/skills/layerfs-js-sdk/SKILL.md; do
  [ -f "${SRC}/${f}" ] || { echo "LayerFS checkout incomplete: missing ${f}; rerun to resume" >&2; exit 1; }
done

echo "==> Building layerfs-daemon + layerfs.node (macOS native, zero Docker)"
# run from the checkout root: cargo reads .cargo/config.toml (the aarch64 AEAD flags) from the current directory
(cd "${SRC}" && CARGO_PROFILE_RELEASE_STRIP=none cargo build --manifest-path core/Cargo.toml --release \
  -p layerfs-node --lib -p layerfs-daemon --bins)

TARGET_DIR="${SRC}/core/target/release"
if [ ! -d "${TARGET_DIR}" ] && [ -d "${SRC}/target/release" ]; then
  TARGET_DIR="${SRC}/target/release"
fi
ADDON=""
for f in liblayerfs_node.dylib liblayerfs_node.so; do
  [ -f "${TARGET_DIR}/${f}" ] && { ADDON="${TARGET_DIR}/${f}"; break; }
done
[ -n "${ADDON}" ] || { echo "build did not produce liblayerfs_node in ${TARGET_DIR}" >&2; exit 1; }

echo "==> Assembling native bundle -> ${BUNDLE}"
rm -rf "${BUNDLE}"
mkdir -p "${BUNDLE}/api/binding" "${BUNDLE}/api/agent/sdk" "${BUNDLE}/api/agent/cli" \
  "${BUNDLE}/api/backend" "${BUNDLE}/api/runtime" "${BUNDLE}/api/node_modules/@layerfs" "${BUNDLE}/bin" "${BUNDLE}/skills"

cp "${TARGET_DIR}/layerfs-daemon" "${BUNDLE}/layerfs-daemon"
cp "${ADDON}" "${BUNDLE}/layerfs.node"
cp "${ADDON}" "${BUNDLE}/api/binding/layerfs.node"
chmod +x "${BUNDLE}/layerfs-daemon" "${BUNDLE}/layerfs.node"

cp "${SRC}/api/package.json" "${BUNDLE}/api/package.json"
cp -R "${SRC}/api/agent/sdk/src" "${SRC}/api/agent/sdk/package.json" "${BUNDLE}/api/agent/sdk/"
cp -R "${SRC}/api/agent/cli/src" "${SRC}/api/agent/cli/package.json" "${BUNDLE}/api/agent/cli/"
cp -R "${SRC}/api/backend/src" "${SRC}/api/backend/package.json" "${BUNDLE}/api/backend/"
cp -R "${SRC}/api/runtime/src" "${SRC}/api/runtime/package.json" "${BUNDLE}/api/runtime/"

# @layerfs/backend, @layerfs/runtime and the CLI import @layerfs/agent by name: link the workspaces
# the way `npm install` in api/ would, without running npm
ln -s ../../agent/sdk "${BUNDLE}/api/node_modules/@layerfs/agent"
ln -s ../../backend "${BUNDLE}/api/node_modules/@layerfs/backend"
ln -s ../../runtime "${BUNDLE}/api/node_modules/@layerfs/runtime"

chmod +x "${BUNDLE}/api/agent/cli/src/layerfs.js"
ln -s ../api/agent/cli/src/layerfs.js "${BUNDLE}/bin/layerfs"

cp -R "${SRC}/.agents/skills/layerfs-js-sdk" "${BUNDLE}/skills/layerfs-js-sdk"

[ -f "${SRC}/LICENSE" ] && cp "${SRC}/LICENSE" "${BUNDLE}/LICENSE-layerfs"
printf 'LayerFS %s (v1.1.0 native), built by minilfs scripts/setup-layerfs.sh\n' "${REF}" > "${BUNDLE}/BUILD-INFO.txt"

echo
echo "Done."
echo "  bundle: ${BUNDLE}"
