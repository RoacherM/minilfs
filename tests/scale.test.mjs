// Real-size repo smoke test: APFS clone of a source tree (default: the epi checkout),
// then open / grep / git / write / diff / apply / close with timings.
// Run: node tests/scale.test.mjs [sourceDir]
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config.ts";
import { LayerfsSession } from "../src/workspace.ts";

const source = process.argv[2] ?? join(homedir(), "Projects/sides/epi");
const id = Date.now().toString(36);
const base = join(homedir(), ".cache/pi-layerfs-test", `scale-${id}`);
const cwd = join(base, "repo");
mkdirSync(base, { recursive: true });
const clone = spawnSync("cp", ["-c", "-R", source, cwd], { encoding: "utf8" });
assert.equal(clone.status, 0, clone.stderr);
const prefix = `pi-lfs-sc-${id}-`;
const docker = (...a) => spawnSync("docker", a, { encoding: "utf8" });
const timings = {};
const time = async (k, fn) => { const t0 = Date.now(); const v = await fn(); timings[k] = Date.now() - t0; return v; };
const s = new LayerfsSession(cwd, `scale-${id}`, { ...resolveConfig({}), root: join(base, "lfs"), prefix }, (m) => console.log(`  [lfs] ${m}`));
let ok = false;
try {
  await time("open", () => s.open());
  const files = Object.keys(s.manifest).length;
  const g = await time("grep TaskRuntime", () => s.sh(`cd "$1" && grep -rlI TaskRuntime src | head -5`, [s.wsDir]));
  assert.match(g.stdout, /task-runtime/);
  const git = await time("git status+log", () => s.sh(`cd "$1" && git status --short | wc -l && git log -1 --oneline`, [s.wsDir]));
  const nm = await time("ls node_modules", () => s.sh(`ls "$1/node_modules" | wc -l`, [s.wsDir]));
  const before = readFileSync(join(cwd, "README.md"), "utf8");
  const w = await time("write+checkpoint", () => s.mutate("w1", "write", () => s.writeFile(join(cwd, "README.md"), before + "\nlayerfs scale test\n")));
  assert.ok(w.checkpoint?.commit);
  const b = await time("bash build-ish (find|wc)", () => s.mutate("b1", "bash", () => s.exec(`find src -name '*.ts' | xargs wc -l | tail -1 > loc.txt`, cwd, { onData: () => {} })));
  assert.equal(b.value.exitCode, 0);
  const d = await time("diff", () => s.diff());
  const a = await time("apply", () => s.apply());
  assert.deepEqual(a.conflicts, []);
  assert.match(readFileSync(join(cwd, "README.md"), "utf8"), /layerfs scale test/);
  const c = await time("close", () => s.close());
  assert.equal(c.kept, false);
  console.log(JSON.stringify({ source, files, gitStatusLines: git.stdout.trim().split("\n")[0], gitHead: git.stdout.trim().split("\n")[1], nodeModulesEntries: nm.stdout.trim(), diff: d.filter((i) => i.type !== "dir").map((i) => `${i.kind}:${i.path}`), applied: a.applied, timings }, null, 2));
  ok = true;
} catch (e) {
  console.log("ERROR", e.stack?.split("\n").slice(0, 6).join("\n"), "\ntimings so far", JSON.stringify(timings));
} finally {
  await s.close().catch(() => {});
  const left = docker("ps", "-aq", "--filter", `name=^${prefix}`).stdout.trim().split("\n").filter(Boolean);
  if (left.length) docker("rm", "-f", ...left);
  const vols = docker("volume", "ls", "-q", "--filter", `name=^${prefix}`).stdout.trim().split("\n").filter(Boolean);
  if (vols.length) docker("volume", "rm", ...vols);
  rmSync(base, { recursive: true, force: true });
  console.log(`${ok ? "PASS" : "FAIL"} scale; leftover containers ${left.length}, volumes ${vols.length}`);
  process.exit(ok ? 0 : 1);
}
