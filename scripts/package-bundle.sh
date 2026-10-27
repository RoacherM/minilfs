#!/usr/bin/env bash
# Packs a bundle built by setup-layerfs.sh into the release tarball minilfs downloads on first start.
# Only what minilfs loads: layerfs-daemon, layerfs.node, the JS SDK (src, operator, package.json),
# with sdk/js/native/layerfs.node as a link to the one binary, plus LICENSE-layerfs and BUILD-INFO.txt.
# Prints the tarball's sha256.
#
# Usage: scripts/package-bundle.sh <bundle dir> <out.tar.gz>
set -euo pipefail
BUNDLE=${1:?bundle dir}; OUT=${2:?output tarball}
STAGE=$(mktemp -d); trap 'rm -rf "${STAGE}"' EXIT
for f in layerfs-daemon layerfs.node sdk/js/src/index.js sdk/js/operator sdk/js/package.json; do
  [ -e "${BUNDLE}/${f}" ] || { echo "bundle incomplete: missing ${f}" >&2; exit 1; }
done
mkdir -p "${STAGE}/sdk/js/native"
cp "${BUNDLE}/layerfs-daemon" "${BUNDLE}/layerfs.node" "${STAGE}/"
cp -R "${BUNDLE}/sdk/js/src" "${BUNDLE}/sdk/js/operator" "${BUNDLE}/sdk/js/package.json" "${STAGE}/sdk/js/"
ln -s ../../../layerfs.node "${STAGE}/sdk/js/native/layerfs.node"
for f in LICENSE-layerfs BUILD-INFO.txt; do [ -f "${BUNDLE}/${f}" ] && cp "${BUNDLE}/${f}" "${STAGE}/"; done
mkdir -p "$(dirname "${OUT}")"
(cd "${STAGE}" && COPYFILE_DISABLE=1 tar --uid 0 --gid 0 --uname root --gname wheel -czf - .) > "${OUT}"
shasum -a 256 "${OUT}" | cut -d' ' -f1
