// End-to-end through the store worker with real mounts (needs /sbin/mount_nfs; run from a terminal):
// 4 LayerfsSession processes on one project at once, each runs bash (mount + Seatbelt + commit),
// writes a file and git-commits in its Branch; then the lead merges them all and applies.
// Run: node tests/worker-mount.smoke.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const role = process.argv[2];
const { resolveConfig } = await import("../src/config.ts");
const { LayerfsSession, stopNativeDaemons } = await import("../src/workspace.ts");
const env = "export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t;";
if (role === "child") {
  const [, , , , cwd, root, i] = process.argv;
  const config = { ...resolveConfig({ MINILFS_BUNDLE: process.env.MINILFS_BUNDLE }), root, prefix: "minilfs-wm-" };
  const s = new LayerfsSession(cwd, `wm-${i}-${Date.now()}`, config);
  try {
    await s.open();
    let out = "";
    const r = await s.mutate("b", "bash", () => s.exec(`${env} echo w${i} > w${i}.txt && git add w${i}.txt && git commit -qm by-w${i} && git log --oneline | wc -l`, cwd, { onData: (d) => (out += d) }));
    if (r.value.exitCode !== 0) throw new Error(`bash exit ${r.value.exitCode}: ${out}`);
    await s.mutate("w", "write", () => s.writeFile(join(cwd, `t${i}.txt`), `t${i}\n`));
    console.log(JSON.stringify({ ok: true, branch: s.workBranch, out: out.trim() }));
    await s.close();
  } catch (e) { console.log(JSON.stringify({ ok: false, error: String(e?.stack ?? e).slice(0, 400) })); }
  process.exit(0);
}
const id = Date.now().toString(36);
const base = join(homedir(), ".cache/minilfs-test", `wm-${id}`);
const root = join(base, "root");
const cwd = join(base, "proj");
mkdirSync(cwd, { recursive: true });
writeFileSync(join(cwd, "a.txt"), "a\n");
spawnSync("git", ["-C", cwd, "init", "-q", "-b", "main"]); spawnSync("git", ["-C", cwd, "add", "-A"]);
spawnSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "c1"]);
const config = { ...resolveConfig({ MINILFS_BUNDLE: process.env.MINILFS_BUNDLE }), root, prefix: "minilfs-wm-", team: true };
let ok = false;
try {
  const lead = new LayerfsSession(cwd, `wm-lead-${id}`, config);
  await lead.open();
  const t0 = Date.now();
  const N = 4;
  const outs = await Promise.all(Array.from({ length: N }, (_, i) => new Promise((res) => {
    const p = spawn(process.execPath, [new URL(import.meta.url).pathname, "child", "-", cwd, root, String(i)], { stdio: ["ignore", "pipe", "pipe"] });
    let o = ""; p.stdout.on("data", (d) => (o += d)); p.stderr.on("data", (d) => (o += d));
    p.on("close", () => { try { res(JSON.parse(o.trim().split("\n").pop())); } catch { res({ ok: false, error: o.slice(-400) }); } });
  })));
  console.log(`${N} sessions (open + bash/mount/commit + write) in ${Date.now() - t0} ms`);
  for (const o of outs) console.log(" ", JSON.stringify(o).slice(0, 200));
  assert.ok(outs.every((o) => o.ok), "every parallel session finished");
  for (const o of outs) {
    const m = await lead.mergeBranch(o.branch);
    assert.ok(m.merged, `merge ${o.branch}: ${JSON.stringify(m.conflicts)}`);
  }
  const ap = await lead.apply();
  assert.deepEqual(ap.conflicts, []);
  for (let i = 0; i < N; i++) {
    assert.equal(readFileSync(join(cwd, `w${i}.txt`), "utf8"), `w${i}\n`);
    assert.equal(readFileSync(join(cwd, `t${i}.txt`), "utf8"), `t${i}\n`);
  }
  assert.equal(spawnSync("git", ["-C", cwd, "fsck", "--connectivity-only", "--no-progress"]).status, 0, "git fsck in the folder");
  const workers = readdirSync(join(root, "worker"));
  assert.equal(workers.length, 1, `one store worker for the root: ${workers}`);
  await lead.close();
  ok = true;
  console.log("PASS worker-mount smoke: parallel sessions with real mounts through one store worker; merged, applied, fsck clean");
} catch (e) {
  console.log("FAIL", e?.stack ?? e);
} finally {
  await stopNativeDaemons(join(root, "local")).catch(() => {});
  process.exit(ok ? 0 : 1);
}
