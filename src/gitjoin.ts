// Joining git histories after a LayerFS merge.
//
// When two Branches that both ran `git commit` merge, LayerFS takes `.git` (refs, HEAD, index) whole
// from one side (merge unit "git") and merges the files. The other side's commits are in the
// objects but not on any branch. A `git merge` in the merged Workspace cannot fix that (it refuses:
// the work tree already holds the merged files), so minilfs records the join itself, with git's own
// plumbing, which never touches the work tree and runs no hook:
//
//   ours  = the lead side's branch head (first parent: the main line stays the lead's)
//   theirs = the other side's head
//   - theirs is an ancestor of ours        -> nothing to do            (uptodate)
//   - ours is an ancestor of theirs        -> the branch moves to theirs (ff)
//   - else git merge-tree --write-tree     -> a commit with both parents and git's merged tree (merged)
//   - merge-tree conflicts                 -> the tree of the merged work tree instead (worktree):
//                                             LayerFS already resolved the files, the commit records it
// The index is set to the new head's tree first (`git read-tree`, the work tree untouched), then the
// branch moves (`update-ref` against its old value); if that fails the index is put back byte for
// byte from a copy (staged changes kept), so a failed join leaves no half state; when even that
// fails the copy is kept and reported (`restore-index <copy>`). Either way minilfs commits the
// Workspace only after a join that succeeded, so a failed one never reaches the Store. `git status`
// then shows exactly the changes neither side committed.
// The script runs with bash under the session's Seatbelt profile, with hooks, fsmonitor, automatic
// gc and every attribute driver off: no attribute source (attr.tree = the empty tree for the
// Branch's .gitattributes, core.attributesFile and the system file off) and, since
// .git/info/attributes cannot be turned off, every filter and merge driver the config defines is
// overridden on the command line (clean/smudge/process empty, required false, merge driver `false`).

/** Bash script (run with /bin/bash); arguments: $1 ours, $2 theirs, $3 branch ref (refs/heads/x), $4 message. (`${"$"}{` below is a literal `${`.) */
export const GIT_JOIN_SCRIPT = String.raw`
set -u
export GIT_ATTR_NOSYSTEM=1
EMPTY=$(git hash-object -t tree /dev/null) || { echo "JOIN fail empty-tree"; exit 0; }
DRV=(-c core.hooksPath=/dev/null -c core.fsmonitor=false -c gc.auto=0 -c maintenance.auto=false -c advice.detachedHead=false -c core.attributesFile=/dev/null -c attr.tree="$EMPTY" -c core.autocrlf=false)
# .git/info/attributes still applies: neutralize every driver it could name
while IFS= read -r k; do
  case "$k" in
    filter.*.required) DRV+=(-c "$k=false") ;;
    filter.*) DRV+=(-c "$k=") ;;
    merge.*.driver) DRV+=(-c "$k=false") ;;
  esac
done < <(git config --includes --name-only --get-regexp '^(filter|merge)\.' 2>/dev/null || true)
g() { git "${"$"}{DRV[@]}" "$@"; }
OURS=$1; THEIRS=$2; BRANCH=$3; MSG=$4
# merge-tree --write-tree --no-messages needs git 2.40
v=$(g version | awk '{ split($3, a, "."); print a[1] * 1000 + a[2] }')
[ "$v" -ge 2040 ] 2>/dev/null || { echo "JOIN skip git-older-than-2.40"; exit 0; }
[ "$(g symbolic-ref -q HEAD)" = "$BRANCH" ] || { echo "JOIN skip HEAD-not-$BRANCH"; exit 0; }
g cat-file -e "$OURS^{commit}" 2>/dev/null || { echo "JOIN skip missing-ours"; exit 0; }
g cat-file -e "$THEIRS^{commit}" 2>/dev/null || { echo "JOIN skip missing-theirs"; exit 0; }
cur=$(g rev-parse -q --verify "$BRANCH^{commit}" || true)
if g merge-base --is-ancestor "$THEIRS" "$OURS"; then
  new=$OURS; mode=uptodate
elif g merge-base --is-ancestor "$OURS" "$THEIRS"; then
  new=$THEIRS; mode=ff
else
  tree=$(g merge-tree --write-tree --no-messages "$OURS" "$THEIRS" 2>/dev/null)
  rc=$?
  tree=$(printf '%s\n' "$tree" | head -n 1)
  mode=merged
  if [ $rc -eq 1 ] && [ -n "$tree" ] && [ "$v" -lt 2043 ]; then
    # update-index below would run the Branch's filter drivers: attr.tree (which turns them off) is git 2.43
    echo "JOIN fail worktree-needs-git-2.43"; exit 0
  elif [ $rc -eq 1 ] && [ -n "$tree" ]; then
    # git sees conflicts LayerFS resolved. Take git's merged tree (every clean change of both sides)
    # and only the conflicting paths from the merged work tree: the commit records LayerFS's
    # resolution and nothing neither side committed
    # the conflicting paths, NUL-separated (any byte in a name is safe): "<tree>\0<path>\0..."
    list=$(mktemp "/tmp/minilfs-join-paths.XXXXXX") || exit 1
    idx=$(mktemp "/tmp/minilfs-join-index.XXXXXX") || exit 1
    rm -f "$idx" # git creates the index file itself (an empty file is not an index)
    # skip the tree id and its NUL (40 hex for SHA-1, 64 for SHA-256)
    g merge-tree --write-tree --no-messages --name-only -z "$OURS" "$THEIRS" 2>/dev/null | tail -c +"$(printf '%s' "$tree" | wc -c | awk '{ print $1 + 2 }')" > "$list"
    # a path in the merged work tree is added; one LayerFS resolved by deleting is removed
    tree=$(export GIT_INDEX_FILE="$idx"; g read-tree "$tree" || exit 1
      # read NUL by NUL: a newline is a valid byte in a file name
      while IFS= read -r -d '' p; do
        [ -n "$p" ] || continue
        if [ -e "$p" ] || [ -L "$p" ]; then g update-index --add -- "$p" || exit 1
        else g update-index --force-remove -- "$p" || exit 1; fi
      done < "$list" || exit 1
      g write-tree)
    rc=$?
    rm -f "$idx" "$list"
    [ $rc -eq 0 ] && [ -n "$tree" ] || { echo "JOIN fail worktree-tree"; exit 0; }
    mode=worktree
  elif [ $rc -ne 0 ] || [ -z "$tree" ]; then
    echo "JOIN fail merge-tree-$rc"; exit 0
  fi
  new=$(printf '%s\n' "$MSG" | g commit-tree "$tree" -p "$OURS" -p "$THEIRS") || { echo "JOIN fail commit-tree"; exit 0; }
fi
if [ "$new" != "$cur" ]; then
  # index first (fails cleanly, e.g. on index.lock, before anything moved), then the ref; a copy of
  # the index puts it back exactly (read-tree "$cur" would drop what was staged)
  orig_idx=$(mktemp "/tmp/minilfs-join-orig-index.XXXXXX") || { echo "JOIN fail mktemp"; exit 0; }
  had_idx=0
  if [ -f .git/index ]; then
    cp -p .git/index "$orig_idx" || { rm -f "$orig_idx"; echo "JOIN fail backup-index"; exit 0; }
    had_idx=1
  fi
  if ! g read-tree "$new"; then
    rm -f "$orig_idx"; echo "JOIN fail read-tree"; exit 0
  fi
  if ! g update-ref -m "minilfs: $MSG" "$BRANCH" "$new" $cur; then
    # put the index back the way git writes it: the copy into index.lock (taken exclusively), then
    # renamed over the index; the copy is kept, and the failure reported, unless that worked
    if [ "$had_idx" -eq 1 ]; then
      if ! ( set -C; : > .git/index.lock ) 2>/dev/null; then echo "JOIN fail restore-index $orig_idx"; exit 0; fi
      if ! { cat "$orig_idx" > .git/index.lock && mv -f .git/index.lock .git/index; } 2>/dev/null || ! cmp -s "$orig_idx" .git/index; then
        rm -f .git/index.lock 2>/dev/null; echo "JOIN fail restore-index $orig_idx"; exit 0
      fi
    elif ! rm -f .git/index 2>/dev/null || [ -e .git/index ]; then
      echo "JOIN fail restore-index .git/index"; exit 0
    fi
    rm -f "$orig_idx"; echo "JOIN fail update-ref"; exit 0
  fi
  rm -f "$orig_idx"
  # the stat cache read-tree dropped (so status need not hash every file); a changed file is fine
  g update-index -q --refresh >/dev/null 2>&1 || true
fi
echo "JOIN $mode $new"
`;

export interface JoinResult { mode: "uptodate" | "ff" | "merged" | "worktree" | "skip" | "fail"; commit?: string; why?: string }

/** The last JOIN line of the script's output (the reason whole: `restore-index <backup>`). Anything else is a failure. */
export function parseJoin(stdout: string): JoinResult {
  const line = String(stdout).split("\n").filter((l) => l.startsWith("JOIN ")).pop();
  const m = line ? /^JOIN (\S+)(?: (.*))?$/.exec(line) : null;
  if (!m) return { mode: "fail", why: "no output" };
  const [, mode, rest = ""] = m;
  if (mode === "skip" || mode === "fail") return { mode, why: rest };
  if (!["uptodate", "ff", "merged", "worktree"].includes(mode) || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(rest)) return { mode: "fail", why: `bad output: ${line!.slice(0, 80)}` };
  return { mode: mode as JoinResult["mode"], commit: rest };
}

/** `ref: refs/heads/x` -> `refs/heads/x`; a detached HEAD (an oid) -> null. */
export function symbolicHead(text: string): string | null {
  const m = /^ref:\s*(refs\/heads\/\S+)\s*$/.exec(String(text).trim());
  return m ? m[1] : null;
}
