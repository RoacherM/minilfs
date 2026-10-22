#!/bin/sh
# Runs one Pi bash command in a LayerFS Workspace (copied into each Sandbox, run as root).
# Usage: pi-lfs-run.sh <sid-file> <workspace-path> <host-project-root> <run-cwd> <uid> <gid> <command>
#
# - Records this process's session id in <sid-file> (root-owned dir) so the host can
#   TERM/KILL the whole command tree.
# - Creates a private mount namespace and bind-mounts the Workspace at the host's own
#   project path, so absolute host paths in commands just work and nothing is rewritten.
#   The bind is invisible to every other process (other sessions sharing the Sandbox).
# - Hides excluded secrets from `git status` (skip-worktree) and .lww (info/exclude).
# - Drops to the command identity and execs bash.
set -u
sid_file=$1 ws=$2 root=$3 run_cwd=$4 uid=$5 gid=$6 cmd=$7
mkdir -p "$(dirname "$sid_file")" && echo $$ > "$sid_file" || exit 125
exec unshare -m --propagation private /bin/sh -c '
  ws=$1 root=$2 run_cwd=$3 uid=$4 gid=$5 cmd=$6
  mkdir -p "$root" && mount --bind "$ws" "$root" || exit 125
  cd "$run_cwd" 2>/dev/null || cd "$root" || exit 125
  exec setpriv --reuid="$uid" --regid="$gid" --clear-groups /bin/sh -c "
    if [ -d \"\$1/.git\" ] && command -v git >/dev/null 2>&1; then
      mkdir -p \"\$1/.git/info\" && { grep -qxF /.lww \"\$1/.git/info/exclude\" 2>/dev/null || echo /.lww >> \"\$1/.git/info/exclude\"; }
      if [ -n \"\${PI_LFS_EXCLUDES:-}\" ]; then
        printf %s \"\$PI_LFS_EXCLUDES\" | tr \",\" \"\\n\" | while IFS= read -r pat; do
          [ -n \"\$pat\" ] || continue
          git -C \"\$1\" -c core.quotePath=false ls-files -v -- \":(glob,icase)\$pat\" \":(glob,icase)**/\$pat\" 2>/dev/null
        done | while IFS= read -r line; do
          t=\${line%% *}; f=\${line#* }
          [ \"\$t\" = S ] && continue
          [ -e \"\$1/\$f\" ] || git -C \"\$1\" update-index --skip-worktree -- \"\$f\" 2>/dev/null
        done
      fi
    fi
    exec bash -c \"\$0\"
  " "$cmd" "$root"
' _ "$ws" "$root" "$run_cwd" "$uid" "$gid" "$cmd"
