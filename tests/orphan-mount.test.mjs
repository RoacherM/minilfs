// Regression for issue #1: no Workspace mount (and so no layerfs-daemon) may outlive its session.
// Real backend (macOS native NFS). Run: node tests/orphan-mount.test.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, promises as fsp, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "../src/config.ts";
import { LayerfsSession, stopNativeDaemons } from "../src/workspace.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const id = Date.now().toString(36);
const base = join(homedir(), ".cache/minilfs-test", `orphan-${id}`);
const cwd = join(base, "project");
mkdirSync(cwd, { recursive: true });
writeFileSync(join(cwd, "a.txt"), "a\n");
const config = { ...resolveConfig({ MINILFS_BUNDLE: process.env.MINILFS_BUNDLE }), root: join(base, "root"), prefix: `minilfs-orphan-${id}-`, killGraceMs: 500 };
const leaseDir = join(config.root, "state", "mounts");
const mountsUnderBase = () => spawnSync("/sbin/mount", [], { encoding: "utf8" }).stdout.split("\n").filter((l) => l.includes(base));
const leases = () => { try { return readdirSync(leaseDir).filter((f) => f.endsWith(".json")); } catch { return []; } };

const results = [];
const step = async (name, fn) => {
  try { await fn(); results.push(true); console.log(`PASS ${name}`); }
  catch (e) { results.push(false); console.log(`FAIL ${name}: ${e.stack?.split("\n").slice(0, 4).join(" | ")}`); }
};

try {
  await step("setup failure after mount still unmounts (exec try/finally covers post-mount steps)", async () => {
    const s = new LayerfsSession(cwd, `setup-${id}`, config);
    await s.open();
    try {
      s.restoreMergedMtimes = async () => { throw new Error("injected setup failure"); };
      await assert.rejects(s.exec("true", cwd, { onData: () => {} }), /injected setup failure/);
      await new Promise((r) => setTimeout(r, 500)); // error path unmounts in the background
      assert.deepEqual(mountsUnderBase(), []);
      assert.deepEqual(leases(), []);
    } finally {
      await s.close();
    }
  });

  await step("close() unmounts a Workspace held after a failed checkpoint", async () => {
    const s = new LayerfsSession(cwd, `held-${id}`, config);
    await s.open();
    const realCommit = s.lfs.workspace.commit;
    s.lfs.workspace.commit = async () => { throw Object.assign(new Error("injected commit failure"), { code: "Failed" }); };
    await s.mutate("t", "bash", () => s.exec("echo x > held.txt", cwd, { onData: () => {} })).catch(() => {});
    s.lfs.workspace.commit = realCommit;
    assert.ok(s.blocked?.heldWs, "commit failure must hold the Workspace");
    assert.equal(mountsUnderBase().length, 1);
    await s.close();
    assert.deepEqual(mountsUnderBase(), []);
    assert.deepEqual(leases(), []);
  });

  await step("a client killed mid-bash leaves a mount that the next session reclaims", async () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      const { LayerfsSession } = await import(${JSON.stringify(join(repo, "src/workspace.ts"))});
      const s = new LayerfsSession(${JSON.stringify(cwd)}, "victim-${id}", ${JSON.stringify(config)});
      await s.open();
      s.exec("echo started; sleep 300", ${JSON.stringify(cwd)}, { onData: (d) => process.stdout.write(d) });
    `], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("victim did not start")), 60_000);
      child.stdout.on("data", (d) => { if (String(d).includes("started")) { clearTimeout(t); resolve(); } });
    });
    child.kill("SIGKILL");
    spawnSync("pkill", ["-9", "-f", "sleep 300"]);
    await new Promise((r) => child.on("exit", r));
    assert.equal(mountsUnderBase().length, 1, "SIGKILL leaves the mount (the bug)");
    assert.equal(leases().length, 1, "the mount has a lease");

    const s = new LayerfsSession(cwd, `next-${id}`, config);
    await s.open();
    try {
      assert.deepEqual(mountsUnderBase(), [], "open() must reclaim the orphan mount");
      assert.deepEqual(leases(), []);
      const r = await s.mutate("t", "bash", () => s.exec("echo ok", cwd, { onData: () => {} }));
      assert.equal(r.value.exitCode, 0);
    } finally {
      await s.close();
    }
    assert.deepEqual(mountsUnderBase(), []);
  });
} finally {
  await stopNativeDaemons(join(config.root, "local")).catch(() => {});
  for (const l of mountsUnderBase()) spawnSync("/sbin/umount", ["-f", l.split(" on ")[1].split(" (")[0]]);
  await fsp.rm(base, { recursive: true, force: true }).catch(() => {});
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
