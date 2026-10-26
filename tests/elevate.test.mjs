// Main-agent elevation and roles in the Pi/Epi extension. Runs anywhere (no LayerFS needed):
// LayerfsSession's Store side is stubbed; elevated commands really run in a temp folder.
// Run: node tests/elevate.test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = join(tmpdir(), `minilfs-elev-${Date.now().toString(36)}`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "a.txt"), "host-original\n");

const ws = await import("../src/workspace.ts");
let failOpen = false;
const calls = [];
Object.assign(ws.LayerfsSession.prototype, {
  async open() {
    if (failOpen) throw new ws.LayerfsError("TooLarge", "folder too large");
    this.projectRecord = { name: "p", volume: "v" }; this.workBranch = "s-x-1"; this.baseBranch = "b-x-1"; this.baseRef = "r";
  },
  async runElevated(run, opts) { calls.push(opts.reason); const value = await run(); return { value, applied: ["a.txt"], synced: ["new.txt"], checkpoint: { commit: "c1", origins: [`host: ${opts.reason}`] }, note: "" }; },
  mutate(_id, _label, fn) { return fn().then((value) => ({ value, checkpoint: null, error: null })); },
  async close() { return { kept: true, notes: [] }; },
});
const { default: ext, POLICY_ENTRY } = await import("../src/index.ts");
const { resolveRole, elevateAllowed } = await import("../src/core/role.ts");

const results = [];
const step = async (name, fn) => {
  try { await fn(); results.push(true); console.log(`PASS ${name}`); }
  catch (e) { results.push(false); console.log(`FAIL ${name}: ${e.stack?.split("\n").slice(0, 3).join(" | ")}`); }
};
const load = async ({ flag = "", env = {}, sessionFile, select, hasUI = true, branch = [] } = {}) => {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  const h = {}, c = {}, tools = {}, entries = [], notes = [];
  try {
    ext({ registerFlag() {}, registerTool: (t) => (tools[t.name] = t), getFlag: (n) => (n === "minilfs-elevate" ? flag : false), on: (n, f) => (h[n] = f),
      registerCommand: (n, x) => (c[n] = x), appendEntry: (t, d) => entries.push({ type: "custom", customType: t, data: d }), events: { emit() {} } });
    const ctx = { cwd: dir, hasUI, ui: { notify: (m) => notes.push(m), setStatus() {}, select: select ?? (async () => "Run") },
      sessionManager: { getBranch: () => branch, getSessionId: () => "sid", getSessionFile: () => sessionFile } };
    await h.session_start({ reason: "startup" }, ctx);
    await new Promise((r) => setTimeout(r, 10));
    return { h, c, tools, entries, notes, ctx };
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};
const text = (r) => (r.content ?? []).map((x) => x.text ?? "").join("");
const bash = (e, params) => e.tools.bash.execute("id", params, undefined, undefined, e.ctx);

try {
  await step("roles: top-level is lead; Epi task session / PI_SUBAGENT_CHILD / EPI_TASK_JOB_ID / MINILFS_ROLE are workers", async () => {
    assert.equal(resolveRole({ env: {} }).role, "lead");
    const epi = resolveRole({ env: {}, sessionFile: "/Users/x/.epi/runtime/task/sessions/0193abcd-1111-2222-3333-444455556666.jsonl" });
    assert.equal(epi.role, "worker"); assert.equal(epi.branchName, "task-0193abcd-1111-2222-3333-444455556666");
    assert.equal(resolveRole({ env: {}, sessionFile: "/Users/x/.epi/pi/sessions/--proj--/s.jsonl" }).role, "lead", "a normal Epi session is lead");
    assert.equal(resolveRole({ env: {}, sessionFile: "/Users/x/.epi/runtime/task/other/x.jsonl" }).role, "worker", "unrecognised task runtime path: isolate");
    assert.equal(resolveRole({ env: { PI_SUBAGENT_CHILD: "1" } }).role, "worker");
    assert.equal(resolveRole({ env: { EPI_TASK_JOB_ID: "abc" } }).branchName, "task-abc");
    assert.equal(resolveRole({ env: { MINILFS_ROLE: "lead", PI_SUBAGENT_CHILD: "1" } }).role, "lead");
  });

  await step("lead: bash schema has elevated + reason; minilfs_apply registered; no workspace_mode tool", async () => {
    const e = await load();
    assert.ok(e.tools.bash.parameters.properties.elevated && e.tools.bash.parameters.properties.reason);
    assert.ok(e.tools.minilfs_apply, "lead can apply");
    assert.ok(e.tools.minilfs, "minilfs tool always registered (no MINILFS_TEAM)");
    assert.equal(e.tools.workspace_mode, undefined);
  });

  await step("worker: bash schema has no elevated; no minilfs_apply; elevated call refused", async () => {
    const e = await load({ env: { PI_SUBAGENT_CHILD: "1" } });
    assert.equal(e.tools.bash.parameters.properties.elevated, undefined);
    assert.equal(e.tools.minilfs_apply, undefined);
    await assert.rejects(bash(e, { command: "echo hi", elevated: true, reason: "x" }), /sub-agents cannot run elevated/);
  });

  await step("auto (default): elevated runs on the real folder without asking; reason required; notes appended; checkpoint recorded", async () => {
    let asked = 0;
    const e = await load({ select: async () => { asked++; return "Run"; } });
    await assert.rejects(bash(e, { command: "echo x", elevated: true }), /needs a reason/);
    const r = await bash(e, { command: "echo host-made > made.txt && cat a.txt", elevated: true, reason: "write on host" });
    assert.equal(asked, 0, "auto does not ask");
    assert.equal(readFileSync(join(dir, "made.txt"), "utf8"), "host-made\n", "ran in the real folder");
    assert.match(text(r), /host-original/);
    assert.match(text(r), /Applied 1 Branch change/);
    assert.match(text(r), /Brought 1 changed file/);
    assert.equal(calls.at(-1), "write on host");
    assert.ok(e.entries.some((x) => x.customType === "minilfs-checkpoint" && x.data.commit === "c1"));
  });

  await step("ask: Run / Always allow (prefix) / Deny / no UI; allow list env", async () => {
    let answer = "Run", asked = 0;
    const e = await load({ flag: "ask", select: async () => { asked++; return answer; } });
    await bash(e, { command: "echo one", elevated: true, reason: "r" }); assert.equal(asked, 1);
    answer = 'Always allow "git …" this session';
    await bash(e, { command: "git --version", elevated: true, reason: "r" }); assert.equal(asked, 2);
    await bash(e, { command: "git status", elevated: true, reason: "r" }); assert.equal(asked, 2, "prefix remembered");
    answer = "Deny";
    await assert.rejects(bash(e, { command: "echo no", elevated: true, reason: "r" }), /denied/);
    const headless = await load({ flag: "ask", hasUI: false });
    await assert.rejects(bash(headless, { command: "echo x", elevated: true, reason: "r" }), /no UI/);
    assert.equal(elevateAllowed("docker build .", { MINILFS_ELEVATE_ALLOW: "git *,docker *" }), true);
    assert.equal(elevateAllowed("rm -rf /", { MINILFS_ELEVATE_ALLOW: "git *" }), false);
  });

  await step("never: refused; /minilfs elevate switches the policy and saves it; resume restores it", async () => {
    const e = await load({ flag: "never" });
    await assert.rejects(bash(e, { command: "echo x", elevated: true, reason: "r" }), /disabled/);
    const said = []; const uctx = { ...e.ctx, ui: { ...e.ctx.ui, notify: (m) => said.push(m) } };
    await e.c.minilfs.handler("elevate auto", uctx);
    assert.match(said.at(-1), /Elevated commands: auto/);
    await bash(e, { command: "true", elevated: true, reason: "r" });
    const saved = e.entries.filter((x) => x.customType === POLICY_ENTRY).at(-1);
    const resumed = await load({ branch: [saved] });
    const s2 = []; await resumed.c.minilfs.handler("elevate", { ...resumed.ctx, ui: { ...resumed.ctx.ui, notify: (m) => s2.push(m) } });
    assert.match(s2.at(-1), /Elevated commands: auto/);
  });

  await step("sandboxed bash: an 'Operation not permitted' result gets the elevate hint (lead only)", async () => {
    const e = await load();
    Object.assign(ws.LayerfsSession.prototype, { async exec(_c, _cwd, o) { o.onData(Buffer.from("touch: x: Operation not permitted\n")); return { exitCode: 1 }; } });
    const r = await bash(e, { command: "touch x" });
    assert.match(text(r), /retry with elevated: true/);
    const w = await load({ env: { PI_SUBAGENT_CHILD: "1" } });
    const rw = await bash(w, { command: "touch x" });
    assert.doesNotMatch(text(rw), /elevated: true/, "workers are not told to elevate");
  });

  await step("failed start: elevated still runs on the folder (nothing to converge)", async () => {
    failOpen = true;
    const e = await load();
    const r = await bash(e, { command: "echo ok > after-fail.txt", elevated: true, reason: "minilfs down" });
    assert.equal(readFileSync(join(dir, "after-fail.txt"), "utf8"), "ok\n");
    void r; failOpen = false;
  });

  await step("paths in any macOS spelling of the project root map into the Branch (/var vs /private/var, /tmp)", async () => {
    const { resolveConfig } = await import("../src/config.ts");
    const real = "/private/var/folders/ct/xx/T/dsh-minilfs-test-c86npk/project";
    const s = new ws.LayerfsSession(real, "spell", resolveConfig({}));
    assert.equal(s.toStorePath("/var/folders/ct/xx/T/dsh-minilfs-test-c86npk/project/w1.txt"), "/w1.txt");
    assert.equal(s.toStorePath(`${real}/w1.txt`), "/w1.txt");
    assert.equal(s.toStorePath("/var/folders/ct/xx/T/dsh-minilfs-test-c86npk/other/w1.txt"), null);
    assert.equal(s.toStorePath(`${real}-evil/x`), null);
  });
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
