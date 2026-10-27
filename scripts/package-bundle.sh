#!/usr/bin/env bash
# Packs a LayerFS v1.1.0 bundle built by setup-layerfs.sh into the release tarball minilfs downloads
# on first start: layerfs-daemon, layerfs.node, the official JS packages (@layerfs/agent, backend,
# runtime, the layerfs CLI) with their node_modules links, api/binding/layerfs.node as a link to the
# one binary, bin/layerfs, the layerfs-js-sdk skill, LICENSE-layerfs and BUILD-INFO.txt.
# Prints the tarball's sha256.
#
# Usage: scripts/package-bundle.sh <bundle dir> <out.tar.gz>
set -euo pipefail
BUNDLE=${1:?bundle dir}; OUT=${2:?output tarball}
STAGE=$(mktemp -d); trap 'rm -rf "${STAGE}"' EXIT
for f in layerfs-daemon layerfs.node api/package.json \
         api/agent/sdk/src/index.js api/agent/sdk/package.json api/agent/cli/src/layerfs.js api/agent/cli/package.json \
         api/backend/src/index.js api/backend/package.json api/runtime/src/index.js api/runtime/package.json; do
  [ -e "${BUNDLE}/${f}" ] || { echo "bundle incomplete: missing ${f}" >&2; exit 1; }
done
mkdir -p "${STAGE}/api/binding" "${STAGE}/api/agent/sdk" "${STAGE}/api/agent/cli" "${STAGE}/api/backend" "${STAGE}/api/runtime" \
  "${STAGE}/api/node_modules/@layerfs" "${STAGE}/bin"
cp "${BUNDLE}/layerfs-daemon" "${BUNDLE}/layerfs.node" "${STAGE}/"
cp "${BUNDLE}/api/package.json" "${STAGE}/api/"
cp -R "${BUNDLE}/api/agent/sdk/src" "${BUNDLE}/api/agent/sdk/package.json" "${STAGE}/api/agent/sdk/"
cp -R "${BUNDLE}/api/agent/cli/src" "${BUNDLE}/api/agent/cli/package.json" "${STAGE}/api/agent/cli/"
cp -R "${BUNDLE}/api/backend/src" "${BUNDLE}/api/backend/package.json" "${STAGE}/api/backend/"
cp -R "${BUNDLE}/api/runtime/src" "${BUNDLE}/api/runtime/package.json" "${STAGE}/api/runtime/"
ln -s ../../layerfs.node "${STAGE}/api/binding/layerfs.node"
ln -s ../../agent/sdk "${STAGE}/api/node_modules/@layerfs/agent"
ln -s ../../backend "${STAGE}/api/node_modules/@layerfs/backend"
ln -s ../../runtime "${STAGE}/api/node_modules/@layerfs/runtime"
chmod +x "${STAGE}/api/agent/cli/src/layerfs.js"
ln -s ../api/agent/cli/src/layerfs.js "${STAGE}/bin/layerfs"
[ -d "${BUNDLE}/skills/layerfs-js-sdk" ] && { mkdir -p "${STAGE}/skills"; cp -R "${BUNDLE}/skills/layerfs-js-sdk" "${STAGE}/skills/"; }
for f in LICENSE-layerfs BUILD-INFO.txt; do [ -f "${BUNDLE}/${f}" ] && cp "${BUNDLE}/${f}" "${STAGE}/"; done
mkdir -p "$(dirname "${OUT}")"
(cd "${STAGE}" && COPYFILE_DISABLE=1 tar --uid 0 --gid 0 --uname root --gname wheel -czf - .) > "${OUT}"
shasum -a 256 "${OUT}" | cut -d' ' -f1
