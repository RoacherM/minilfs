#!/usr/bin/env bash
# Creates a fresh Quarry-on-Pi test folder from this template (one setup commit, like the DSH
# test folders), then runs the preflight.
#   examples/quarry-pi/new.sh [dir] [--bundle-from <LayerFS bundle dir>]
# Default dir: ~/Projects/sides/quarry-minilfs-test. Refuses an existing non-empty dir.
set -euo pipefail
tpl="$(cd "$(dirname "$0")" && pwd)"
minilfs="$(cd "$tpl/../.." && pwd)"
dir="$HOME/Projects/sides/quarry-minilfs-test"
bundle_from=""
while [ $# -gt 0 ]; do
  case "$1" in
    --bundle-from) bundle_from=$2; shift 2 ;;
    -h|--help) sed -n 2,6p "$0"; exit 0 ;;
    *) dir=$1; shift ;;
  esac
done
if [ -e "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then
  echo "$dir exists and is not empty; pick another dir or remove it" >&2; exit 1
fi
mkdir -p "$dir"
cp -R "$tpl/." "$dir/"
rm -f "$dir/new.sh"
name=$(basename "$dir")
# cargo caches are per test folder (the DSH folders do the same)
sed -i '' "s#/scratch/quarry-minilfs-test/shared#/scratch/${name}/shared#" "$dir/scripts/env.sh"
sed -i '' "s#cd ~/Projects/sides/quarry-minilfs-test#cd ${dir}#" "$dir/README.md"
sed -i '' "s#\${QUARRY_MINILFS_SRC:-\$HOME/Projects/sides/minilfs}#\${QUARRY_MINILFS_SRC:-${minilfs}}#" "$dir/scripts/env-experiment.sh"
cd "$dir"
git init -q -b main
git add -A
git -c user.name=lead -c user.email=lead@local commit -qm "chore: setup Quarry benchmark specs for Pi + minilfs (LayerFS v1.1.0)"
echo "created $dir ($(git rev-parse --short HEAD)); minilfs under test: $minilfs"
args=(--check)
[ -n "$bundle_from" ] && args=(--bundle-from "$bundle_from" --check)
QUARRY_MINILFS_SRC="${QUARRY_MINILFS_SRC:-$minilfs}" scripts/run.sh "${args[@]}" || {
  echo "preflight failed: fix the above, then: cd $dir && scripts/run.sh --check" >&2; exit 1; }
echo "start: cd $dir && scripts/run.sh"
