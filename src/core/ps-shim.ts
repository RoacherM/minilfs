// `ps` for sandboxed bash. /bin/ps is setuid root, and a Seatbelt-sandboxed process may not exec
// setuid programs (kernel log: `deny forbidden-exec-sugid`); an unsigned copy is killed by code
// signing. Tools that measure memory with `ps -o rss= -p <pid>` (benchmarks, test harnesses)
// would fail. This stand-in reads the same facts through libproc (proc_pid_rusage, proc_pidinfo),
// which needs no privilege for the caller's own processes.
import { promises as fsp } from "node:fs";
import { join } from "node:path";

/** Bump when the script changes, so an old copy in scratch is replaced. */
const VERSION = "1";

export const PS_SHIM = `#!/usr/bin/python3
# minilfs ps shim v${VERSION}: /bin/ps is setuid and cannot run inside the macOS sandbox.
# Supports: ps -o <fields> -p <pid[,pid]>, ps -A/-e/-ax -o <fields>; fields pid ppid pgid uid rss vsz time comm command args.
import ctypes, os, sys
lib = ctypes.CDLL("/usr/lib/libproc.dylib")
class RU(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_uint8 * 16), ("user", ctypes.c_uint64), ("system", ctypes.c_uint64), ("idle", ctypes.c_uint64),
                ("wk", ctypes.c_uint64), ("pageins", ctypes.c_uint64), ("wired", ctypes.c_uint64), ("resident", ctypes.c_uint64),
                ("footprint", ctypes.c_uint64), ("start", ctypes.c_uint64), ("exit", ctypes.c_uint64)]
class BSD(ctypes.Structure):
    _fields_ = [("flags", ctypes.c_uint32), ("status", ctypes.c_uint32), ("xstatus", ctypes.c_uint32), ("pid", ctypes.c_uint32), ("ppid", ctypes.c_uint32),
                ("uid", ctypes.c_uint32), ("gid", ctypes.c_uint32), ("ruid", ctypes.c_uint32), ("rgid", ctypes.c_uint32), ("svuid", ctypes.c_uint32), ("svgid", ctypes.c_uint32),
                ("rfu", ctypes.c_uint32), ("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32), ("nfiles", ctypes.c_uint32), ("pgid", ctypes.c_uint32),
                ("pjobc", ctypes.c_uint32), ("tdev", ctypes.c_uint32), ("tpgid", ctypes.c_uint32), ("nice", ctypes.c_int32), ("start_sec", ctypes.c_uint64), ("start_usec", ctypes.c_uint64)]
def info(pid):
    ru, b = RU(), BSD()
    if lib.proc_pid_rusage(pid, 0, ctypes.byref(ru)) != 0: return None
    lib.proc_pidinfo(pid, 3, 0, ctypes.byref(b), ctypes.sizeof(b))
    path = ctypes.create_string_buffer(4096); lib.proc_pidpath(pid, path, 4096)
    comm = path.value.decode(errors="replace") or b.comm.decode(errors="replace")
    return {"pid": pid, "ppid": b.ppid, "pgid": b.pgid, "uid": b.uid, "rss": ru.resident // 1024, "vsz": 0,
            "time": (ru.user + ru.system) // 10**9, "comm": comm, "command": comm, "args": comm}
args, fields, pids, every, header = sys.argv[1:], ["pid", "time", "command"], None, False, True
i = 0
while i < len(args):
    a = args[i]
    if a in ("-o", "-O") and i + 1 < len(args):
        i += 1; spec = args[i].split(",")
        if any(s.endswith("=") for s in spec): header = False
        fields = [s.split("=")[0] for s in spec]
    elif a == "-p" and i + 1 < len(args): i += 1; pids = [int(x) for x in args[i].replace(",", " ").split()]
    elif a.startswith("-p") and a[2:].isdigit(): pids = [int(a[2:])]
    elif a in ("-A", "-e", "-ax", "-ef", "aux", "-axo"): every = True
    elif a.isdigit(): pids = (pids or []) + [int(a)]
    i += 1
if pids is None:
    if every:
        n = lib.proc_listallpids(None, 0); buf = (ctypes.c_int * (n + 64))(); n = lib.proc_listallpids(buf, ctypes.sizeof(buf))
        pids = sorted(p for p in buf[:n] if p > 0)
    else: pids = [os.getppid()]
rows = [r for r in (info(p) for p in pids) if r]
if header: print(" ".join(f.upper() for f in fields))
for r in rows: print(" ".join(str(r.get(f, "-")) for f in fields))
sys.exit(0 if rows else 1)
`;

/** Writes the shim into `<scratchDir>/bin` (readable inside the sandbox) and returns that directory. */
export async function ensurePsShim(scratchDir: string): Promise<string> {
  const dir = join(scratchDir, "bin");
  const file = join(dir, "ps");
  const current = await fsp.readFile(file, "utf8").catch(() => "");
  if (current !== PS_SHIM) {
    await fsp.mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, PS_SHIM, { mode: 0o755 });
    await fsp.rename(tmp, file);
  }
  return dir;
}
