// Finding what a bash call left running, on macOS (no PID namespaces).
//
// A call's processes normally share its process group (the shell is spawned detached, so it leads a
// new group) and die with `kill(-pgid)`. Some leave it: cargo and test harnesses start children in
// new groups or sessions (`setsid`), a server started with `&` outlives the shell and is re-parented
// to launchd (ppid 1). Such an orphan can hold the call's stdout/stderr pipe or keep a port, and has
// no file open on the Workspace mount when its data lives elsewhere (/var/folders, /tmp).
//
// The scan lists this user's processes through libproc (no privilege, works for hardened binaries,
// unlike reading another process's environment) and returns those that are
//   - in the call's process group, or
//   - orphans (ppid 1) started after the call began, whose executable or working directory is under
//     one of the call's roots (the Workspace, the branch scratch dir). Not the project's shared build
//     cache: every session of the project uses it, so another session's process may live there.
// A process the user started in their own terminal is not an orphan of launchd and is not killed;
// one started before the call is not killed either.
import { spawnSync } from "node:child_process";
import { run } from "./exec-helper.ts";

/** libproc listing: [pid, ppid, pgid, startSec, startUsec, executable, cwd] for every process of this user (or the pids given). */
const SCAN_PY = String.raw`
import ctypes, os, json, sys
lib = ctypes.CDLL("/usr/lib/libproc.dylib")
class BSD(ctypes.Structure):
    _fields_ = [("flags", ctypes.c_uint32), ("status", ctypes.c_uint32), ("xstatus", ctypes.c_uint32), ("pid", ctypes.c_uint32), ("ppid", ctypes.c_uint32),
                ("uid", ctypes.c_uint32), ("gid", ctypes.c_uint32), ("ruid", ctypes.c_uint32), ("rgid", ctypes.c_uint32), ("svuid", ctypes.c_uint32), ("svgid", ctypes.c_uint32),
                ("rfu", ctypes.c_uint32), ("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32), ("nfiles", ctypes.c_uint32), ("pgid", ctypes.c_uint32),
                ("pjobc", ctypes.c_uint32), ("tdev", ctypes.c_uint32), ("tpgid", ctypes.c_uint32), ("nice", ctypes.c_int32), ("start_sec", ctypes.c_uint64), ("start_usec", ctypes.c_uint64)]
class VI(ctypes.Structure):
    _fields_ = [("vi", ctypes.c_uint8 * 152), ("path", ctypes.c_char * 1024)]
class VPI(ctypes.Structure):
    _fields_ = [("cdir", VI), ("rdir", VI)]
if len(sys.argv) > 1:
    buf = [int(a) for a in sys.argv[1:]]
    n = len(buf)
else:
    n = lib.proc_listallpids(None, 0)
    buf = (ctypes.c_int * (n + 256))()
    n = lib.proc_listallpids(buf, ctypes.sizeof(buf))
uid, out = os.getuid(), []
for p in buf[:n]:
    if p <= 0: continue
    b = BSD()
    if lib.proc_pidinfo(p, 3, 0, ctypes.byref(b), ctypes.sizeof(b)) <= 0 or b.uid != uid: continue
    path = ctypes.create_string_buffer(4096)
    lib.proc_pidpath(p, path, 4096)
    v, cwd = VPI(), ""
    if lib.proc_pidinfo(p, 9, 0, ctypes.byref(v), ctypes.sizeof(v)) > 0: cwd = v.cdir.path.decode(errors="replace")
    out.append([p, b.ppid, b.pgid, b.start_sec, b.start_usec, path.value.decode(errors="replace"), cwd])
print(json.dumps(out))
`;

/** The interpreter for SCAN_PY (a seam for tests: a lookup that cannot run must signal nothing). */
export const procScan = { python: "/usr/bin/python3" };

/** A process; (pid, startSec, startUsec) identifies it (a pid alone may be reused). */
export interface ProcRow { pid: number; ppid: number; pgid: number; startSec: number; startUsec: number; exe: string; cwd: string }

const rowsOf = (stdout: string): ProcRow[] =>
  (JSON.parse(stdout) as any[]).map(([pid, ppid, pgid, startSec, startUsec, exe, cwd]) => ({ pid, ppid, pgid, startSec, startUsec, exe, cwd }));

/** This user's processes (empty when python3/libproc is unavailable). */
export async function listOwnProcesses(): Promise<ProcRow[]> {
  const r = await run(procScan.python, ["-c", SCAN_PY], { timeoutMs: 10_000 }).catch(() => null);
  if (!r || r.code !== 0) return [];
  try {
    return rowsOf(r.stdout.toString());
  } catch {
    return [];
  }
}

/** One process of this user with its start time (libproc), or null (gone, another user's, no python3). */
export function procStartTime(pid: number): ProcRow | null {
  return procStartTimes([pid])?.get(pid) ?? null;
}

/** These processes of this user (libproc, one look), by pid; absent: gone or another user's. null: cannot look (no python3). */
export function procStartTimes(pids: number[]): Map<number, ProcRow> | null {
  const r = spawnSync(procScan.python, ["-c", SCAN_PY, ...pids.map(String)], { encoding: "utf8", timeout: 10_000 });
  if (r.status !== 0) return null;
  try {
    return new Map(rowsOf(r.stdout).map((row) => [row.pid, row]));
  } catch {
    return null;
  }
}

/**
 * Microseconds since the epoch (wall clock, as libproc's start times), at microsecond resolution.
 * The high-resolution clock stops while the Mac sleeps: it is used only while it agrees with the
 * wall clock to within a millisecond, else the wall clock's milliseconds.
 */
export const nowUs = () => {
  const wall = Date.now();
  const fine = performance.timeOrigin + performance.now();
  return Math.floor((Math.abs(fine - wall) < 1 ? fine : wall) * 1000);
};
export const startUs = (r: Pick<ProcRow, "startSec" | "startUsec">) => r.startSec * 1_000_000 + (r.startUsec ?? 0);

/**
 * The processes a listing (lsof, pgrep) named, identified: each pid looked up (libproc) and kept
 * only when its process started before `beforeUs` (taken before the listing ran), so a pid that a
 * new process reused after the listing is never taken for the one listed. null when the lookup
 * cannot run: then nothing may be signalled.
 */
export function identifyListed(pids: number[], beforeUs: number): ProcRow[] | null {
  if (!pids.length) return [];
  const rows = procStartTimes(pids);
  if (!rows) return null;
  return [...rows.values()].filter((r) => startUs(r) < beforeUs);
}

/**
 * The processes a call left behind: its process group, plus launchd orphans started at or after
 * `sinceUs` (taken before the shell was spawned, so no slack is needed) whose executable or cwd is
 * under `roots` (every spelling given). Never this process or its parent.
 */
export function leftovers(rows: ProcRow[], opts: { pgid?: number; sinceUs: number; roots: string[] }): ProcRow[] {
  const under = (p: string) => !!p && opts.roots.some((r) => p === r || p.startsWith(`${r}/`));
  return rows.filter((r) => {
    if (r.pid === process.pid || r.pid === process.ppid || r.pid <= 1) return false;
    if (opts.pgid && r.pgid === opts.pgid) return true;
    return r.ppid === 1 && startUs(r) >= opts.sinceUs && (under(r.exe) || under(r.cwd));
  });
}

/**
 * Signals each process that is still the one found: its (pid, start time) is looked up again right
 * before (time has passed since the listing; the pid may now be another process), in one libproc
 * call for the whole batch (one python per pid would be too slow with many holders), with nothing
 * else between that lookup and the signals. A lookup that cannot run signals nothing. Never this
 * process or its parent. Returns how many were signalled (with `which`: the pids signalled).
 */
export function killAll(rows: Array<Pick<ProcRow, "pid" | "startSec" | "startUsec">>, sig?: NodeJS.Signals): number;
export function killAll(rows: Array<Pick<ProcRow, "pid" | "startSec" | "startUsec">>, sig: NodeJS.Signals, which: true): Set<number>;
export function killAll(rows: Array<Pick<ProcRow, "pid" | "startSec" | "startUsec">>, sig: NodeJS.Signals = "SIGKILL", which = false): number | Set<number> {
  const done = new Set<number>();
  const targets = rows.filter((r) => r.pid > 1 && r.pid !== process.pid && r.pid !== process.ppid);
  const now = targets.length ? procStartTimes(targets.map((r) => r.pid)) : null;
  for (const r of targets) {
    const cur = now?.get(r.pid);
    if (!cur || cur.startSec !== r.startSec || cur.startUsec !== r.startUsec) continue;
    try { process.kill(r.pid, sig); done.add(r.pid); } catch {}
  }
  return which ? done : done.size;
}
