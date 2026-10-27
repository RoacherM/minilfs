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
//     one of the call's roots (the Workspace, the branch scratch dir, the shared build cache).
// A process the user started in their own terminal is not an orphan of launchd and is not killed;
// one started before the call is not killed either.
import { run } from "./exec-helper.ts";

/** libproc listing: [pid, ppid, pgid, startSec, executable, cwd] for every process of this user. */
const SCAN_PY = String.raw`
import ctypes, os, json
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
    out.append([p, b.ppid, b.pgid, b.start_sec, path.value.decode(errors="replace"), cwd])
print(json.dumps(out))
`;

export interface ProcRow { pid: number; ppid: number; pgid: number; startSec: number; exe: string; cwd: string }

/** This user's processes (empty when python3/libproc is unavailable). */
export async function listOwnProcesses(): Promise<ProcRow[]> {
  const r = await run("/usr/bin/python3", ["-c", SCAN_PY], { timeoutMs: 10_000 }).catch(() => null);
  if (!r || r.code !== 0) return [];
  try {
    return (JSON.parse(r.stdout.toString()) as any[]).map(([pid, ppid, pgid, startSec, exe, cwd]) => ({ pid, ppid, pgid, startSec, exe, cwd }));
  } catch {
    return [];
  }
}

/**
 * The processes a call left behind: its process group, plus launchd orphans started since `sinceSec`
 * whose executable or cwd is under `roots` (every spelling given). Never this process or its parent.
 */
export function leftovers(rows: ProcRow[], opts: { pgid?: number; sinceSec: number; roots: string[] }): ProcRow[] {
  const under = (p: string) => !!p && opts.roots.some((r) => p === r || p.startsWith(`${r}/`));
  return rows.filter((r) => {
    if (r.pid === process.pid || r.pid === process.ppid || r.pid <= 1) return false;
    if (opts.pgid && r.pgid === opts.pgid) return true;
    return r.ppid === 1 && r.startSec >= opts.sinceSec - 1 && (under(r.exe) || under(r.cwd));
  });
}

/** SIGKILLs `pids`; returns how many were signalled. */
export function killAll(pids: number[]): number {
  let n = 0;
  for (const pid of pids) {
    try { process.kill(pid, "SIGKILL"); n++; } catch {}
  }
  return n;
}
