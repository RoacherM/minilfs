// Several processes (a lead and its sub-agents) share one LayerFS Store. In-process, an open or write
// that meets another process's write is refused (Busy / Failed: Store busy before effect / Unknown:
// Service(History(Busy))). minilfs routes every process of a root through one store worker
// (src/store-worker.mjs), so they share one Store connection; see docs/DESIGN-store-worker.md.
//
// Checks, Store calls only (no NFS mount):
//   1. worker: 8 processes open, fork, write 25 times, fork, write, merge at once, with the retry
//      safety net counted: no call needs a retry, nothing lands twice, one worker serves all
//   2. the worker dies (SIGKILL) under load: the next calls start a new one and finish
//   3. idle: the worker exits after its idle time and removes its endpoint
//   4. in-process mode (MINILFS_STORE_WORKER=0): the same load finishes through the Busy retry
// Run: node tests/store-contention.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const role = process.argv[2];
const { createProjectClient, initProjectClient, ensureNativeDirs, retryStats } = await import("../src/core/client.ts");
const { resolveConfig } = await import("../src/config.ts");
const bundle = process.env.MINILFS_BUNDLE || resolveConfig({}).bundle;
const specOf = (root, storeWorker) => ensureNativeDirs({ root, bundle, prefix: "c-", storeWorker });
const proj = { name: "p1", volume: "v" };

// ---- child: one "agent" process
if (role === "child") {
  const [, , , , root, i, mode, writes] = process.argv;
  const w = `w${i}`;
  const spec = specOf(root, mode === "worker");
  // every call the safety net sent again (client.ts retryStats): with the worker there must be none
  const retriesOf = () => retryStats.busy + retryStats.workerGone + retryStats.uncertain;
  try {
    const { lfs } = await createProjectClient(spec, proj);
    await lfs.branch.fork(w, "main");
    for (let k = 0; k < Number(writes); k++) await lfs.fs.apply(w, [{ op: "write", path: `/f${k}.txt`, bytes: Buffer.from("x" + k) }], `w${k}`);
    await lfs.branch.fork(`${w}-b`, w);
    await lfs.fs.write(`${w}-b`, "/side.txt", "s");
    await lfs.fs.write(w, "/main-side.txt", "m");
    const m = await lfs.branch.merge(w, `${w}-b`, `${w}-m`, "merge");
    await lfs.close();
    console.log(JSON.stringify({ ok: true, w, kind: m.kind, retries: retriesOf(), stats: retryStats }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, w, error: `${e.code}: ${String(e.message).slice(0, 160)}`, retries: retriesOf(), stats: retryStats }));
  }
  process.exit(0);
}

// ---- parent
const results = [];
const step = async (name, fn) => {
  const t0 = Date.now();
  try { const ev = await fn(); results.push(true); console.log(`PASS ${name} (${Date.now() - t0} ms)${ev ? ` :: ${ev}` : ""}`); }
  catch (e) { results.push(false); console.log(`FAIL ${name}: ${e.stack?.split("\n").slice(0, 3).join(" | ")}`); }
};

async function newProject(storeWorker) {
  const root = join(process.env.MINILFS_TEST_TMP ?? tmpdir(), `minilfs-contend-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  const src = join(root, "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "a.txt"), "a\n");
  const spec = specOf(root, storeWorker);
  const { lfs } = await initProjectClient(spec, proj, src);
  return { root, spec, lead: lfs };
}

function agents(root, mode, n, writes, onSpawn) {
  return Promise.all(Array.from({ length: n }, (_, i) => new Promise((res) => {
    const p = spawn(process.execPath, [join(here, "store-contention.test.mjs"), "child", "-", root, String(i), mode, String(writes)], { stdio: ["ignore", "pipe", "pipe"] });
    let o = "";
    p.stdout.on("data", (d) => (o += d));
    p.stderr.on("data", (d) => (o += d));
    p.on("close", () => { try { res(JSON.parse(o.trim().split("\n").pop())); } catch { res({ ok: false, error: o.slice(-300) }); } });
    onSpawn?.(p);
  })));
}

async function consistent(lead, n, writes) {
  for (let i = 0; i < n; i++) {
    const commits = [];
    for (let pos = 0; ; ) { const p = await lead.branch.list_commits(`w${i}`, 100, pos); commits.push(...p.items); if (!p.hasMore) break; pos += p.items.length; }
    const files = (await lead.fs.list(`w${i}-m`, "/", 1000, 0)).items.length;
    assert.equal(commits.length, writes + 1, `w${i}: ${commits.length} commits, want ${writes + 1} (nothing twice, nothing lost)`);
    assert.equal(files, writes + 3, `w${i}-m: ${files} files, want ${writes + 3}`);
  }
}

const workerPids = (root) => {
  const out = [];
  for (const b of existsSync(join(root, "worker")) ? readdirSync(join(root, "worker")) : []) {
    try { out.push(JSON.parse(readFileSync(join(root, "worker", b, "endpoint.json"), "utf8")).pid); } catch {}
  }
  return out;
};
const { stopWorkers } = await import("../src/core/worker.ts");
const roots = [];

try {
  await step("worker: 8 processes at once, no retry needed, nothing lands twice, one worker serves all", async () => {
    const { root, lead } = await newProject(true);
    roots.push(root);
    const N = 8, W = 25;
    const t0 = Date.now();
    const out = await agents(root, "worker", N, W);
    const ms = Date.now() - t0;
    assert.ok(out.every((o) => o.ok), JSON.stringify(out.filter((o) => !o.ok)));
    await consistent(lead, N, W);
    assert.deepEqual(out.map((o) => o.retries), Array(N).fill(0), `retries per agent: ${out.map((o) => o.retries)}`);
    assert.equal(workerPids(root).length, 1, "one worker for the root");
    await lead.close();
    return `${N} agents in ${ms} ms, worker ${workerPids(root)[0]}`;
  });

  await step("worker dies under load (SIGKILL): later calls start a new one and every agent finishes", async () => {
    const { root, lead } = await newProject(true);
    roots.push(root);
    const N = 6, W = 40;
    const first = workerPids(root)[0];
    const run = agents(root, "worker", N, W);
    await new Promise((r) => setTimeout(r, 400));
    process.kill(first, "SIGKILL");
    const out = await run;
    assert.ok(out.every((o) => o.ok), JSON.stringify(out.filter((o) => !o.ok)));
    await consistent(lead, N, W);
    const now = workerPids(root);
    assert.ok(now.length === 1 && now[0] !== first, `a new worker replaced ${first}: ${now}`);
    await lead.close();
    return `worker ${first} -> ${now[0]}; retries ${out.map((o) => o.retries).join(",")}`;
  });

  await step("idle: the worker exits after its idle time and removes its endpoint", async () => {
    const { root, spec, lead } = await newProject(true);
    roots.push(root);
    await lead.close();
    const [pid] = workerPids(root);
    assert.ok(pid, "a worker runs after the client opened");
    // a worker with a short idle time: stop this one, start one with --idle-ms 800
    stopWorkers(root);
    await new Promise((r) => setTimeout(r, 300));
    const { ensureWorker, workerBuild } = await import("../src/core/worker.ts");
    const { LAYERFS_COMMIT } = await import("../src/bundle.ts");
    process.env.MINILFS_TEST_WORKER_IDLE_MS = "800";
    const file = await ensureWorker({ root, home: spec.home, bundle, build: workerBuild(bundle, LAYERFS_COMMIT) });
    delete process.env.MINILFS_TEST_WORKER_IDLE_MS;
    const p2 = JSON.parse(readFileSync(file, "utf8")).pid;
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(existsSync(file), false, "endpoint removed");
    let running = true;
    try { process.kill(p2, 0); } catch { running = false; }
    assert.equal(running, false, `worker ${p2} exited when idle`);
  });

  await step("in-process mode (MINILFS_STORE_WORKER=0): the same load finishes through the Busy retry", async () => {
    const { root, lead } = await newProject(false);
    roots.push(root);
    const N = 8, W = 25;
    const out = await agents(root, "inprocess", N, W);
    assert.ok(out.every((o) => o.ok), JSON.stringify(out.filter((o) => !o.ok)));
    await consistent(lead, N, W);
    assert.equal(workerPids(root).length, 0, "no worker in in-process mode");
    await lead.close();
    return `retries per agent: ${out.map((o) => o.retries).join(",")}`;
  });
} finally {
  for (const r of roots) stopWorkers(r);
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
