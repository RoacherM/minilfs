// Workspace mode switch (branch <-> host) in the Pi/Epi extension. Runs anywhere, including inside
// a minilfs sandbox: LayerfsSession's Store operations are stubbed, the host side is real files.
// Run: node tests/mode.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = join(tmpdir(), `minilfs-mode-${Date.now().toString(36)}`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "a.txt"), "host-original\n");

const ws = await import("../src/workspace.ts");
let failOpen = false, restarts = 0, synced = [], live = null;
Object.assign(ws.LayerfsSession.prototype, {
  async open() {
    live = this;
    if (failOpen) throw new ws.LayerfsError("TooLarge", "folder too large");
    this.projectRecord = { name: "p", volume: "v" }; this.workBranch = "s-x-1"; this.baseBranch = "b-x-1"; this.baseRef = "r";
  },
  async syncHostDriftIntoMain() { return { synced }; },
  async restartFromMain() { if (this.unapplied) return false; restarts++; this.workBranch = `s-x-${1 + restarts}`; return true; },
  async mergeBranch() { return { merged: true, conflicts: [] }; },
  async close() { return { kept: true, notes: [] }; },
});
const { default: ext, MODE_ENTRY } = await import("../src/index.ts");

const results = [];
const step = async (name, fn) => {
  try { await fn(); results.push(true); console.log(`PASS ${name}`); }
  catch (e) { results.push(false); console.log(`FAIL ${name}: ${e.stack?.split("\n").slice(0, 3).join(" | ")}`); }
};
const mk = () => {
  const h = {}, c = {}, tools = {}, entries = [];
  ext({ registerFlag() {}, registerTool: (t) => (tools[t.name] = t), getFlag: () => false, on: (n, f) => (h[n] = f), registerCommand: (n, x) => (c[n] = x),
    appendEntry: (t, d) => entries.push({ type: "custom", customType: t, data: d }), events: { emit() {} } });
  return { h, c, tools, entries };
};
const ctxOf = (branch = []) => ({ cwd: dir, hasUI: true, ui: { notify() {}, setStatus() {} }, sessionManager: { getBranch: () => branch, getSessionId: () => "sid" } });
const T = (r) => r.content.map((x) => x.text).join("");
const mode = (e, ctx, p) => e.tools.workspace_mode.execute("x", p, null, null, ctx).then(T);
const settle = () => new Promise((r) => setTimeout(r, 20));

try {
  const e = mk(); const ctx = ctxOf();
  await e.h.session_start({ reason: "startup" }, ctx); await settle();

  await step("starts in branch mode", async () => {
    assert.match(await mode(e, ctx, { mode: "status" }), /^branch mode on s-x-1/);
  });
  await step("branch -> host is refused while the Branch has unapplied changes", async () => {
    live.unapplied = true;
    assert.match(await mode(e, ctx, { mode: "host", reason: "nested sandbox" }), /^Refused: the Branch s-x-1 has unapplied changes/);
  });
  await step("discard=true switches; read/write act on the real folder; the switch is recorded", async () => {
    assert.match(await mode(e, ctx, { mode: "host", reason: "nested sandbox", discard: true }), /^Now in host mode \(nested sandbox\).*Unapplied changes stay on s-x-1/);
    assert.match(T(await e.tools.read.execute("r", { path: join(dir, "a.txt") }, undefined, undefined, ctx)), /host-original/);
    await e.tools.write.execute("w", { path: join(dir, "b.txt"), content: "made on host\n" }, undefined, undefined, ctx);
    assert.equal(readFileSync(join(dir, "b.txt"), "utf8"), "made on host\n");
    assert.ok(e.entries.some((x) => x.customType === MODE_ENTRY && x.data.mode === "host"));
  });
  await step("host -> branch with unapplied Branch work merges the host edits into it", async () => {
    synced = ["b.txt"];
    assert.match(await mode(e, ctx, { mode: "branch" }), /^Back in branch mode on s-x-1\. Merged 1 host edit/);
  });
  await step("host -> branch with a clean Branch starts a fresh Branch from main", async () => {
    live.unapplied = false;
    await mode(e, ctx, { mode: "host" });
    assert.match(await mode(e, ctx, { mode: "branch" }), /fresh Branch s-x-2 from main\. It includes your 1 host edit/);
  });
  await step("/minilfs mode reports and switches", async () => {
    const out = [];
    await e.c.minilfs.handler("mode", { ...ctx, ui: { notify: (m) => out.push(m), setStatus() {} } });
    assert.match(out[0], /^branch mode/);
  });
  await step("resume restores host mode from the conversation", async () => {
    const e2 = mk(); const ctx2 = ctxOf([{ type: "custom", customType: MODE_ENTRY, data: { mode: "host" } }]);
    await e2.h.session_start({ reason: "resume" }, ctx2); await settle();
    assert.match(await mode(e2, ctx2, { mode: "status" }), /^host mode/);
  });
  await step("failed start: host mode still works; branch mode explains why it cannot start", async () => {
    failOpen = true;
    const e3 = mk(); const ctx3 = ctxOf();
    await e3.h.session_start({ reason: "startup" }, ctx3); await settle();
    assert.match(await mode(e3, ctx3, { mode: "host", reason: "minilfs broken" }), /^Now in host mode/);
    assert.match(T(await e3.tools.read.execute("r", { path: join(dir, "a.txt") }, undefined, undefined, ctx3)), /host-original/);
    assert.match(await mode(e3, ctx3, { mode: "branch" }), /^Cannot switch to branch mode: minilfs is not running \(folder too large\)/);
    failOpen = false;
  });
  await step("HostWorkspace (for DSH/MCP): secrets refused, files/grep/exec on the folder", async () => {
    const { HostWorkspace, resolveConfig } = await import("../src/core/index.ts");
    const h = new HostWorkspace(dir, resolveConfig({}));
    writeFileSync(join(dir, ".env"), "S=1\n");
    await assert.rejects(h.readFile(".env"), /secret file/);
    await assert.rejects(h.writeFile(".env", "x"), /secret/);
    await h.writeFile("d/c.ts", "find me\n");
    assert.equal((await h.findFiles("**/*.ts", dir, { ignore: [], limit: 10 })).length, 1);
    assert.deepEqual((await h.grepWorkspace({ pattern: "find me" })).lines, ["d/c.ts:1:find me"]);
    const out = []; assert.equal((await h.exec("echo hi", ".", { onData: (d) => out.push(String(d)) })).exitCode, 0);
    assert.equal(out.join(""), "hi\n");
  });
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch {} // a sandbox may refuse to delete .env
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
