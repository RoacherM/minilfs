// Cross-process directory locks for bindings.json and per-project mutations.
//
// Fixes from the implementation review (P0-3):
// - A lock is stale only when its owner process is gone (pid + process start marker),
//   or when its heartbeat stopped (owner on another host / pid reused); never just
//   because a long operation exceeded a fixed age.
// - The holder refreshes a heartbeat while it runs, so long syncs/applies keep the lock.
// - Reclaiming is race-free: a stale lock is renamed away atomically (only one
//   reclaimer can win the rename), then the winner retries mkdir.
// - Waiting is async (setTimeout), never Atomics.wait, so the event loop keeps running.
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

const HEARTBEAT_MS = 2_000;
const HEARTBEAT_STALE_MS = 30_000;

interface Owner { pid: number; host: string; token: string; at: number }

function readOwner(lockDir: string): Owner | null {
  try { return JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8")); } catch { return null; }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}

function isStale(lockDir: string): boolean {
  let st;
  try { st = statSync(lockDir); } catch { return false; }
  const owner = readOwner(lockDir);
  const heartbeatAge = Date.now() - Math.max(st.mtimeMs, owner?.at ?? 0);
  if (!owner) return heartbeatAge > HEARTBEAT_STALE_MS; // crashed between mkdir and owner write
  if (owner.host === hostname() && !alive(owner.pid)) return true;
  return heartbeatAge > HEARTBEAT_STALE_MS;
}

function tryReclaim(lockDir: string): void {
  const grave = `${lockDir}.stale-${process.pid}-${Date.now()}`;
  try {
    renameSync(lockDir, grave); // atomic: only one reclaimer moves it
    rmSync(grave, { recursive: true, force: true });
  } catch {
    // someone else reclaimed or the owner released it first
  }
}

export interface LockHandle { release(): void }

function tryAcquire(lockDir: string): LockHandle | null {
  try {
    mkdirSync(lockDir);
  } catch (e: any) {
    if (e?.code !== "EEXIST") throw e;
    return null;
  }
  const token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const write = () => {
    try {
      writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, host: hostname(), token, at: Date.now() } satisfies Owner));
      const now = new Date();
      utimesSync(lockDir, now, now);
    } catch {}
  };
  write();
  const timer = setInterval(write, HEARTBEAT_MS);
  timer.unref?.();
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      if (readOwner(lockDir)?.token === token) rmSync(lockDir, { recursive: true, force: true });
    },
  };
}

/** Acquires `lockDir` asynchronously (refused as Busy after `timeoutMs`). */
export async function acquireLock(lockDir: string, timeoutMs = 60_000): Promise<LockHandle> {
  mkdirSync(join(lockDir, ".."), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (let delay = 10; ; delay = Math.min(delay * 2, 200)) {
    const got = tryAcquire(lockDir);
    if (got) return got;
    if (isStale(lockDir)) { tryReclaim(lockDir); continue; }
    if (Date.now() > deadline) throw Object.assign(new Error(`lock busy: ${lockDir}`), { code: "Busy" });
    await new Promise((r) => setTimeout(r, delay));
  }
}

/** Synchronous variant for short critical sections (bindings.json read-modify-write, a few ms). */
export function acquireLockSync(lockDir: string, timeoutMs = 10_000): LockHandle {
  mkdirSync(join(lockDir, ".."), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = tryAcquire(lockDir);
    if (got) return got;
    if (isStale(lockDir)) { tryReclaim(lockDir); continue; }
    if (Date.now() > deadline) throw Object.assign(new Error(`lock busy: ${lockDir}`), { code: "Busy" });
    // short critical sections only: a brief synchronous spin keeps bindings writes atomic
    const until = Date.now() + 5;
    while (Date.now() < until) { /* spin */ }
  }
}
