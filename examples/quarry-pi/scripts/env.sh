# Source before every cargo command:  . scripts/env.sh && cargo ...
# Native macOS mode: CARGO_HOME and CARGO_TARGET_DIR live on native APFS scratch storage outside the
# NFSv3 workspace mount, so Rust builds run at full APFS speed and no build output enters the Store.
#
# Each agent (each minilfs Branch) gets its OWN target dir, $MINILFS_SCRATCH_DIR/target: parallel
# agents never replace each other's binaries or rlibs (a shared target raced: "build, then run"
# picked up another agent's binary). A new target dir starts as an APFS clone (cp -c, copy-on-write:
# instant, no extra disk) of the shared seed, so dependencies are not rebuilt per agent. The lead
# refreshes the seed after each apply with `seed_target`.
export PATH="$HOME/.cargo/bin:$PATH"
_q_shared="${MINILFS_SHARED_CACHE_DIR:-${MINILFS_ROOT:-$HOME/.cache/minilfs}/scratch/quarry-minilfs-test/shared}"
_q_own="${MINILFS_SCRATCH_DIR:-$_q_shared/branches/host}"
mkdir -p "$_q_shared/cargo-home" "$_q_own"
export CARGO_HOME="$_q_shared/cargo-home"
export CARGO_TARGET_DIR="$_q_own/target"
if [ ! -d "$CARGO_TARGET_DIR" ] && [ -d "$_q_shared/target-seed" ]; then
  cp -cR "$_q_shared/target-seed" "$CARGO_TARGET_DIR" 2>/dev/null || cp -R "$_q_shared/target-seed" "$CARGO_TARGET_DIR"
fi
mkdir -p "$CARGO_TARGET_DIR"
export CARGO_NET_RETRY=5
export CARGO_BUILD_JOBS=4
export CARGO_INCREMENTAL=0
unset RUSTC_WRAPPER RUSTC_WORKSPACE_WRAPPER

# seed_target: make this agent's target dir the starting point of agents started from now on
# (the lead runs it after each minilfs_apply). A clone, so it costs no disk and no time.
seed_target() {
  rm -rf "$_q_shared/target-seed.new"
  cp -cR "$CARGO_TARGET_DIR" "$_q_shared/target-seed.new" 2>/dev/null || cp -R "$CARGO_TARGET_DIR" "$_q_shared/target-seed.new"
  rm -rf "$_q_shared/target-seed" && mv "$_q_shared/target-seed.new" "$_q_shared/target-seed" && echo "target seed refreshed from $CARGO_TARGET_DIR"
}
