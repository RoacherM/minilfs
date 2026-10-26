// Mount leases: one small file per mounted Workspace, written right after workspace.mount and
// removed right after the unmount. A process killed while a Workspace is mounted (SIGKILL, crash,
// task timeout) cannot run its own cleanup; the lease lets the next session of the project find
// that mount and reclaim it, so neither the NFS mount nor its layerfs-daemon (which only exits
// when it has no Workspace) is left behind.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { alive } from "./lock.ts";

export interface MountLease {
  pid: number;
  host: string;
  project: string;
  sandbox: string;
  path: string;
  wsReal: string;
  at: number;
}

export class MountLeases {
  readonly dir: string;
  constructor(dir: string) { this.dir = dir; }

  private file(path: string): string {
    return join(this.dir, `${createHash("sha256").update(path).digest("hex").slice(0, 24)}.json`);
  }

  add(project: string, ws: { sandbox: string; path: string }, wsReal: string): void {
    mkdirSync(this.dir, { recursive: true });
    const lease: MountLease = { pid: process.pid, host: hostname(), project, sandbox: ws.sandbox, path: ws.path, wsReal, at: Date.now() };
    const tmp = `${this.file(ws.path)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(lease));
    renameSync(tmp, this.file(ws.path));
  }

  /** Removes the lease of `path` if `owner` still holds it (a new mount of the same path may have replaced it). */
  remove(path: string, owner = process.pid): void {
    const lease = this.read(path);
    if (!lease || lease.pid === owner) rmSync(this.file(path), { force: true });
  }

  read(path: string): MountLease | null {
    try { return JSON.parse(readFileSync(this.file(path), "utf8")); } catch { return null; }
  }

  /** Leases whose owner process on this host has exited. */
  orphans(): MountLease[] {
    let names: string[];
    try { names = readdirSync(this.dir); } catch { return []; }
    const out: MountLease[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      let lease: MountLease;
      try { lease = JSON.parse(readFileSync(join(this.dir, name), "utf8")); } catch { continue; }
      if (isOrphan(lease)) out.push(lease);
    }
    return out;
  }
}

export function isOrphan(lease: MountLease | null): boolean {
  return Boolean(lease) && lease!.host === hostname() && lease!.pid !== process.pid && !alive(lease!.pid);
}
