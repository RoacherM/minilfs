// Real LayerFS backend test (no Pi, no model). Run: node tests/backend.test.mjs
// Uses its own root (~/.cache/pi-layerfs-test/<id>) and prefix pi-lfs-test-.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fsp, mkdirSync, writeFileSync, symlinkSync, readFileSync, existsSync, lstatSync, readlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveConfig } from "../src/config.ts";
import { LayerfsSession } from "../src/workspace.ts";

const id = Date.now().toString(36);
const base = join(homedir(), ".cache/pi-layerfs-test", id);
const results = [];
const step = async (name, fn) => {
  const t0 = Date.now();
  try { const ev = await fn(); results.push({ name, ok: true, ms: Date.now() - t0 }); console.log(`PASS ${name} (${Date.now() - t0} ms)${ev ? ` :: ${String(ev).slice(0, 200)}` : ""}`); }
  catch (e) { results.push({ name, ok: false, error: e.stack }); console.log(`FAIL ${name}: ${e.stack?.split("\n").slice(0, 3).join(" | ")}`); }
};
const docker = (...a) => spawnSync("docker", a, { encoding: "utf8" });
const sha = (b) => createHash("sha256").update(b).digest("hex");
const config = { ...resolveConfig({}), root: join(base, "root"), prefix: `pi-lfs-test-${id}-`, killGraceMs: 1000 };

function fixture(dir) {
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git/HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(dir, "README.md"), "hello\n");
  writeFileSync(join(dir, "src/app.js"), "export const a = 1;\n");
  writeFileSync(join(dir, "delete-me.txt"), "bye\n");
  writeFileSync(join(dir, "conflict.txt"), "base\n");
  writeFileSync(join(dir, ".env"), "SECRET=1\n");
  writeFileSync(join(dir, "img.bin"), Buffer.from([0, 1, 2, 255, 0, 10, 13]));
  symlinkSync("src/app.js", join(dir, "link"));
}

const cwd = join(base, "project");
const outside = join(base, "outside.txt");
fixture(cwd);
writeFileSync(outside, "outside-host\n");
const before = readFileSync(join(cwd, "README.md"), "utf8");
let s;

try {
  await step("preflight refuses missing image (no resources created)", async () => {
    const bad = { ...config, image: "pi-lfs-does-not-exist:none" };
    await assert.rejects(new LayerfsSession(cwd, "bad", bad).open(), (e) => e.code === "Preflight" && /not found/.test(e.message));
    assert.equal(docker("ps", "-aq", "--filter", `name=^${config.prefix}`).stdout.trim(), "");
  });

  await step("open: stage, init, prewarm, mount", async () => {
    s = new LayerfsSession(cwd, `test-${id}`, config, (m) => console.log(`  [lfs] ${m}`));
    await s.open();
    assert.match(s.wsDir, /^\/workspaces\/\d+$/);
    assert.ok(!("" + Object.keys(s.manifest)).includes(".env"), "manifest must not contain .env");
    return `${s.container} ${s.wsDir} ident=${s.ident} leaked=${JSON.stringify(s.leakedWorkspaces)}`;
  });

  await step("reads: text, binary byte-exact, outside-cwd from host, .env excluded", async () => {
    assert.equal((await s.readFile(join(cwd, "README.md"))).toString(), "hello\n");
    assert.equal(sha(await s.readFile(join(cwd, "img.bin"))), sha(readFileSync(join(cwd, "img.bin"))));
    assert.equal((await s.readFile(outside)).toString(), "outside-host\n");
    assert.equal(await s.exists(join(cwd, ".env")), false);
    assert.equal(await s.isDirectory(join(cwd, "src")), true);
    assert.deepEqual(await s.readdir(join(cwd, "src")), ["app.js"]);
  });

  await step("write outside cwd is refused", async () => {
    await assert.rejects(s.mutate("t0", "write", () => s.writeFile(outside, "x")), /outside the LayerFS workspace/);
    assert.equal(readFileSync(outside, "utf8"), "outside-host\n");
  });

  await step("write -> checkpoint commit; host untouched", async () => {
    const r = await s.mutate("t1", "write", () => s.writeFile(join(cwd, "README.md"), "hello from layerfs\n"));
    assert.ok(r.checkpoint?.commit, "expected a commit");
    assert.deepEqual(r.checkpoint.origins, ["t1"]);
    assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), before);
    const noop = await s.mutate("t2", "write", () => s.writeFile(join(cwd, "README.md"), "hello from layerfs\n"));
    assert.equal(noop.checkpoint, null, "unchanged write must not create a commit");
  });

  await step("bash: live streaming, exit code, env filtered, host abs path works", async () => {
    const chunks = [];
    const t0 = Date.now();
    const r = await s.exec(`for i in 1 2 3; do echo tick$i; sleep 0.4; done; echo PI_X=$PI_X SECRET=\${SECRET_KEY:-unset}; cat ${cwd}/README.md; exit 3`, cwd, {
      onData: (d) => chunks.push({ t: Date.now() - t0, s: d.toString() }),
      env: { PI_X: "yes", SECRET_KEY: "leak", PATH: "/host/path" },
    });
    assert.equal(r.exitCode, 3);
    const all = chunks.map((c) => c.s).join("");
    assert.match(all, /PI_X=yes SECRET=unset/);
    assert.match(all, /hello from layerfs/);
    assert.ok(chunks[0].t < 600 && chunks.at(-1).t > 1000, `not streaming: ${JSON.stringify(chunks.map((c) => c.t))}`);
  });

  await step("bash abort: TERM-ignoring tree is reaped, Promise rejects 'aborted'", async () => {
    const ac = new AbortController();
    const p = s.exec(`trap '' TERM; (trap '' TERM; sleep 300) & sleep 300; wait`, cwd, { onData: () => {}, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 800));
    const t0 = Date.now();
    ac.abort();
    await assert.rejects(p, /aborted/);
    const left = docker("exec", s.container, "sh", "-c", "pgrep -u " + s.ident.split(":")[0] + " -f 'sleep 300' || true").stdout.trim();
    assert.equal(left, "", `leftover: ${left}`);
    return `cancel took ${Date.now() - t0} ms`;
  });

  await step("bash timeout rejects 'timeout:1' and reaps", async () => {
    await assert.rejects(s.exec(`sleep 30`, cwd, { onData: () => {}, timeout: 1 }), /timeout:1/);
    assert.equal(docker("exec", s.container, "sh", "-c", "pgrep -u " + s.ident.split(":")[0] + " -f 'sleep 30' || true").stdout.trim(), "");
  });

  await step("checkpoint failure blocks mutations; retry records all pending origins", async () => {
    const realCall = s.worker.call.bind(s.worker);
    let failNext = true;
    s.worker.call = (op, args, t) => (op === "commit" && failNext ? (failNext = false, Promise.reject(Object.assign(new Error("injected"), { code: "Failed" }))) : realCall(op, args, t));
    const r1 = await s.mutate("t3", "write", () => s.writeFile(join(cwd, "src/app.js"), "export const a = 2;\n"));
    assert.ok(r1.error && s.blocked, "expected blocked gate");
    await assert.rejects(s.mutate("t4", "write", () => s.writeFile(join(cwd, "x.txt"), "x")), /blocked until \/layerfs retry/);
    assert.equal(await s.exists(join(cwd, "x.txt")), false, "blocked mutation must not run");
    const r2 = await s.retry();
    assert.ok(r2.checkpoint?.commit && !s.blocked);
    assert.deepEqual(r2.checkpoint.origins, ["t3", "retry"]);
    s.worker.call = realCall;
  });

  await step("bash mutations (add, delete, chmod, symlink, binary, .git) are checkpointed", async () => {
    const r = await s.mutate("t5", "bash", () => s.exec(`echo new > added.txt && rm delete-me.txt && chmod +x src/app.js && ln -sfn README.md link && printf '\\000\\377' > bin2.dat && echo x > .git/agent-touch && mkdir -p deep/er && echo d > deep/er/f.txt`, cwd, { onData: () => {} }));
    assert.equal(r.value.exitCode, 0);
    assert.ok(r.checkpoint?.commit);
  });

  await step("diff lists changes", async () => {
    const d = await s.diff();
    const paths = d.filter((i) => i.type !== "dir").map((i) => `${i.kind}:${i.path}`).sort();
    for (const want of ["Added:/added.txt", "Removed:/delete-me.txt", "Modified:/README.md", "Added:/bin2.dat"]) assert.ok(paths.includes(want), `missing ${want} in ${paths}`);
    return paths.join(" ");
  });

  await step("apply conflict: host edited a changed file -> nothing written", async () => {
    await s.mutate("t6", "write", () => s.writeFile(join(cwd, "conflict.txt"), "agent\n"));
    writeFileSync(join(cwd, "conflict.txt"), "host-edit\n");
    const r = await s.apply();
    assert.deepEqual(r.conflicts, ["conflict.txt"]);
    assert.deepEqual(r.applied, []);
    assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), before, "no partial apply");
    assert.equal(readFileSync(join(cwd, "conflict.txt"), "utf8"), "host-edit\n");
  });

  await step("apply clean: host matches workspace; .git skipped", async () => {
    writeFileSync(join(cwd, "conflict.txt"), "base\n"); // user reverts their edit
    const r = await s.apply();
    assert.deepEqual(r.conflicts, []);
    assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "hello from layerfs\n");
    assert.equal(readFileSync(join(cwd, "added.txt"), "utf8"), "new\n");
    assert.equal(existsSync(join(cwd, "delete-me.txt")), false);
    assert.ok(statSync(join(cwd, "src/app.js")).mode & 0o100, "exec bit applied");
    assert.equal(readFileSync(join(cwd, "src/app.js"), "utf8"), "export const a = 2;\n");
    assert.ok(lstatSync(join(cwd, "link")).isSymbolicLink() && readlinkSync(join(cwd, "link")) === "README.md");
    assert.equal(sha(readFileSync(join(cwd, "bin2.dat"))), sha(Buffer.from([0, 255])));
    assert.equal(readFileSync(join(cwd, "deep/er/f.txt"), "utf8"), "d\n");
    assert.equal(readFileSync(join(cwd, "conflict.txt"), "utf8"), "agent\n");
    assert.ok(r.skipped.includes(".git/agent-touch") && !existsSync(join(cwd, ".git/agent-touch")));
    assert.equal(readFileSync(join(cwd, ".env"), "utf8"), "SECRET=1\n");
    return `applied ${r.applied.length}: ${r.applied.join(" ")}`;
  });

  await step("apply again is a no-op", async () => {
    const r = await s.apply();
    assert.deepEqual(r.applied, []);
    assert.deepEqual(r.conflicts, []);
  });

  await step("close: containers removed, volume removed (all applied)", async () => {
    const r = await s.close();
    assert.equal(r.kept, false, JSON.stringify(r));
    assert.equal(docker("ps", "-aq", "--filter", `name=^${config.prefix}`).stdout.trim(), "");
    assert.equal(docker("volume", "ls", "-q", "--filter", `name=^${config.prefix}`).stdout.trim(), "");
    const again = await s.close();
    assert.deepEqual(again.notes, []);
    return JSON.stringify(r.notes);
  });

  await step("unapplied work keeps the volume at close", async () => {
    const s2 = new LayerfsSession(cwd, `test2-${id}`, { ...config, prewarmMs: 0 });
    await s2.open();
    await s2.mutate("u1", "write", () => s2.writeFile(join(cwd, "later.txt"), "later\n"));
    const r = await s2.close();
    assert.equal(r.kept, true);
    assert.equal(existsSync(join(cwd, "later.txt")), false);
    assert.ok(docker("volume", "inspect", s2.volume).status === 0, "volume kept");
    assert.equal(docker("ps", "-aq", "--filter", `name=^${config.prefix}`).stdout.trim(), "", "containers stopped");
    docker("volume", "rm", s2.volume);
    return r.notes.join("; ");
  });
} finally {
  if (s) await s.close().catch(() => {});
  const left = docker("ps", "-aq", "--filter", `name=^${config.prefix}`).stdout.trim().split("\n").filter(Boolean);
  if (left.length) docker("rm", "-f", ...left);
  const vols = docker("volume", "ls", "-q", "--filter", `name=^${config.prefix}`).stdout.trim().split("\n").filter(Boolean);
  if (vols.length) docker("volume", "rm", ...vols);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed; leftover containers ${left.length}, volumes ${vols.length}`);
  await fsp.rm(base, { recursive: true, force: true }).catch(() => {});
  process.exit(failed.length ? 1 : 0);
}
