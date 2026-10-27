// Roles and the pure sandbox model in the Pi/Epi extension. Runs anywhere (no LayerFS needed):
// LayerfsSession's Store side is stubbed. There is no elevation: bash (and the user's !cmd) always run
// on the Branch, and git commit/merge happen in the Branch's own .git.
// Run: node tests/elevate.test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = join(tmpdir(), `minilfs-sandbox-${Date.now().toString(36)}`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "a.txt"), "host-original\n");

const ws = await import("../src/workspace.ts");
let failOpen = false;
const execs = [];
Object.assign(ws.LayerfsSession.prototype, {
  async open() {
    if (failOpen) throw new ws.LayerfsError("TooLarge", "folder too large");
    this.projectRecord = { name: "p", volume: "v" }; this.workBranch = "s-x-1"; this.baseBranch = "b-x-1"; this.baseRef = "r";
  },
  async exec(cmd, cwd, o) { execs.push({ cmd, cwd }); o.onData(Buffer.from(`ran on branch: ${cmd}\n`)); return { exitCode: 0 }; },
  mutate(_id, _label, fn) { return fn().then((value) => ({ value, checkpoint: null, error: null })); },
  async close() { return { kept: true, notes: [] }; },
});
const { default: ext } = await import("../src/index.ts");
const { resolveRole } = await import("../src/core/role.ts");
const core = await import("../src/core/index.ts");
const { buildSeatbeltProfile } = await import("../src/seatbelt.ts");

const results = [];
const step = async (name, fn) => {
  try { await fn(); results.push(true); console.log(`PASS ${name}`); }
  catch (e) { results.push(false); console.log(`FAIL ${name}: ${e.stack?.split("\n").slice(0, 3).join(" | ")}`); }
};
const load = async ({ env = {}, sessionFile, hasUI = true, branch = [] } = {}) => {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  const h = {}, c = {}, tools = {}, entries = [], notes = [], flags = [];
  const active = { names: [] };
  try {
    ext({ registerFlag: (n) => flags.push(n), registerTool: (t) => (tools[t.name] = t, active.names.push(t.name)), getFlag: () => false, on: (n, f) => (h[n] = f),
      getActiveTools: () => [...active.names], setActiveTools: (names) => (active.names = [...names]),
      registerCommand: (n, x) => (c[n] = x), appendEntry: (t, d) => entries.push({ type: "custom", customType: t, data: d }), events: { emit() {} } });
    const ctx = { cwd: dir, hasUI, ui: { notify: (m) => notes.push(m), setStatus() {}, select: async () => "Run" },
      sessionManager: { getBranch: () => branch, getSessionId: () => "sid", getSessionFile: () => sessionFile } };
    await h.session_start({ reason: "startup" }, ctx);
    await new Promise((r) => setTimeout(r, 10));
    return { h, c, tools, entries, notes, ctx, flags, active };
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

  await step("pure sandbox: no elevation API is exported; no --minilfs-elevate flag; no /minilfs elevate", async () => {
    for (const name of ["elevatePolicy", "elevateAllowed", "ELEVATE_PARAM_DESCRIPTIONS"]) assert.equal(core[name], undefined, `${name} removed`);
    assert.equal(typeof ws.LayerfsSession.prototype.runElevated, "undefined", "runElevated removed");
    const e = await load();
    assert.deepEqual(e.flags, ["no-minilfs"]);
    const said = [];
    await e.c.minilfs.handler("elevate auto", { ...e.ctx, ui: { ...e.ctx.ui, notify: (m) => said.push(m) } });
    assert.match(said.at(-1), /未知子命令|unknown/i, "elevate is not a subcommand any more");
  });

  await step("lead: bash schema has no elevated/reason; minilfs + minilfs_apply registered", async () => {
    const e = await load();
    assert.equal(e.tools.bash.parameters.properties.elevated, undefined);
    assert.equal(e.tools.bash.parameters.properties.reason, undefined);
    assert.ok(e.tools.minilfs_apply, "lead can apply");
    assert.ok(e.tools.minilfs, "minilfs tool always registered");
  });

  await step("worker: same bash schema; no minilfs_apply", async () => {
    const e = await load({ env: { PI_SUBAGENT_CHILD: "1" } });
    assert.equal(e.tools.bash.parameters.properties.elevated, undefined);
    assert.equal(e.tools.minilfs_apply, undefined);
  });

  await step("R7 an Epi task found only at session_start (session file) cannot apply: tool and /minilfs apply refuse, tool deactivated", async () => {
    const e = await load({ sessionFile: "/Users/x/.epi/runtime/task/sessions/0193abcd-1111-2222-3333-444455556666.jsonl" });
    assert.ok(e.tools.minilfs_apply, "registered at load (no env marker yet)");
    await assert.rejects(e.tools.minilfs_apply.execute("id", {}, undefined, undefined, e.ctx), /only .*lead/);
    const said = [];
    await e.c.minilfs.handler("apply", { ...e.ctx, ui: { ...e.ctx.ui, notify: (m) => said.push(m) } });
    assert.match(said.at(-1), /only .*lead/);
    assert.equal(e.active.names.includes("minilfs_apply"), false, "removed from the active tools");
    const lead = await load();
    assert.ok(lead.active.names.includes("minilfs_apply"), "the lead keeps it");
  });

  await step("bash always runs on the Branch, even when an old caller passes elevated: true", async () => {
    const e = await load();
    execs.length = 0;
    const r = await bash(e, { command: "echo hi > made.txt", elevated: true, reason: "legacy" });
    assert.match(text(r), /ran on branch/);
    assert.equal(execs.length, 1);
    assert.equal(existsSync(join(dir, "made.txt")), false, "the real folder is never written");
    const p = await bash(e, { command: "touch x" });
    assert.doesNotMatch(text(p), /elevated/, "no hint to elevate");
  });

  await step("user !cmd runs on the Branch (sandbox), not on the real folder", async () => {
    const e = await load();
    execs.length = 0;
    const routed = await e.h.user_bash({ type: "user_bash", command: "echo u > u.txt", cwd: dir }, e.ctx);
    const chunks = [];
    const r = await routed.operations.exec("echo u > u.txt", dir, { onData: (d) => chunks.push(d.toString()) });
    assert.equal(r.exitCode, 0);
    assert.equal(execs.length, 1, "went through LayerfsSession.exec");
    assert.equal(existsSync(join(dir, "u.txt")), false);
  });

  await step("system prompt describes the pure sandbox model (in-sandbox git, merge + apply), never elevated", async () => {
    const lead = await load();
    const { systemPrompt } = await lead.h.before_agent_start({ systemPrompt: "BASE" });
    assert.match(systemPrompt, /1 call = 1 Commit/);
    assert.match(systemPrompt, /git status, diff, log, add, commit/);
    assert.match(systemPrompt, /minilfs_apply/);
    assert.doesNotMatch(systemPrompt, /elevated: true/);
    const worker = await load({ env: { PI_SUBAGENT_CHILD: "1" } });
    const w = await worker.h.before_agent_start({ systemPrompt: "BASE" });
    assert.match(w.systemPrompt, /report your branch name/);
    assert.doesNotMatch(w.systemPrompt, /elevated/);
  });

  await step("seatbelt: .git is an allowlist (data writable; config, hooks, commondir, alternates, submodule config/hooks are not), any case", async () => {
    const p = buildSeatbeltProfile({ wsPath: "/private/tmp/ws-x", hostCwd: "/private/tmp/host-x", scratchDir: "/private/tmp/scr-x", excludes: [], outsideSecrets: [], network: "allow" });
    assert.ok(p.includes('(regex #"^/private/tmp/ws-x/\\.[lL][wW][wW]$")'), ".lww in any case");
    assert.ok(p.includes('(regex #"^/private/tmp/ws-x/\\.[gG][iI][tT]($|/.*)")'), "the whole .git denied first, any case");
    assert.ok(!p.includes('(subpath "/private/tmp/ws-x/.git")'), "no subpath rule: the allowlist re-allows git data");
    assert.ok(!/bundle/.test(p), "no bundle read rule (the sandbox has no LayerFS access)");
    // evaluate the rules the way Seatbelt does (last matching rule wins), with JS regexes
    const rules = [...p.matchAll(/\((allow|deny) file-write\*\n((?:  \(regex #"[^"]*"\)\n)+)\)/g)]
      .map(([, verb, body]) => ({ verb, rxs: [...body.matchAll(/regex #"([^"]*)"/g)].map((m) => new RegExp(m[1])) }));
    const writable = (rel) => {
      let ok = true;
      for (const r of rules) if (r.rxs.some((rx) => rx.test(`/private/tmp/ws-x/${rel}`))) ok = r.verb === "allow";
      return ok;
    };
    for (const rel of [".git/HEAD", ".git/index", ".git/index.lock", ".git/refs/heads/main", ".git/objects/ab/cdef", ".git/objects/pack/pack-1.pack",
      ".git/logs/HEAD", ".git/packed-refs", ".git/COMMIT_EDITMSG", ".git/ORIG_HEAD", ".git/modules/sub/HEAD", ".git/modules/sub/refs/heads/main", "src/app.js", "sub/.git/config"]) {
      assert.equal(writable(rel), true, `${rel} writable`);
    }
    for (const rel of [".git", ".git/config", ".git/CONFIG", ".GIT/config", ".git/config.worktree", ".git/hooks/pre-commit", ".git/Hooks/pre-commit", ".git/commondir",
      ".git/info/attributes", ".git/objects/info/alternates", ".git/modules/sub/config", ".git/modules/sub/hooks/post-checkout", ".git/modules/a/refs/config",
      ".git/modules/a/refs/hooks/x", ".git/worktrees/w/gitdir", ".git/worktrees/w/commondir", ".git/worktrees/w/config.worktree", ".lww", ".LWW",
      ".git/refs/../hooks/pre-commit", ".git/logs/../config", ".git/objects/info/commit-graphs/../alternates", ".git/lfs/hooks-ish/x"]) {
      assert.equal(writable(rel), false, `${rel} must not be writable`);
    }
  });

  await step("protected paths: allowlist of git data; every name git runs code from is refused, at any depth and case", async () => {
    for (const rel of [".lww", ".git", ".git/config", ".GIT/config", ".git/config.worktree", ".git/hooks/pre-commit", ".git/commondir", ".git/info/attributes",
      ".git/objects/info/alternates", ".git/modules/sub/config", ".git/modules/sub/hooks/x", ".git/modules/a/refs/config", ".git/worktrees/w/gitdir", "sub/.git", "sub/.git/config",
      ".git/refs/../hooks/x", ".git/refs/./x", ".git/lfs/other"]) {
      assert.equal(core.isProtectedPath(rel), true, rel);
    }
    for (const rel of [".git/index", ".git/HEAD", ".git/objects/ab/cd", ".git/refs/heads/hooks", ".git/refs/heads/config", ".git/logs/HEAD", "sub/.git/HEAD", "src/app.js", "app/hooks/use.ts", "src/config.ts", ".gitignore", ".github/workflows/x.yml"]) {
      assert.equal(core.isProtectedPath(rel), false, rel);
    }
    assert.equal(core.LWW_DEFAULT, "%include .gitignore\n", ".git is a merge unit, never per-file last-writer-wins");
    assert.deepEqual(core.MERGE_UNITS.map((u) => u.name), ["git", "deps"]);
  });

  await step("apply decisions for git paths: objects add-only, refs/HEAD/index three-way, locks and config never", async () => {
    const d = core.decideGitPath;
    assert.equal(d("object", null, null, "o1"), "write", "a new object is added");
    assert.equal(d("object", "o0", "o0", "o1"), "skip", "an existing object is never replaced");
    assert.equal(d("object", "o0", "o0", null), "skip", "objects are never deleted from the folder");
    assert.equal(d("ref", "c1", "c1", "c2"), "write", "the folder still at the base: the ref moves");
    assert.equal(d("ref", "c9", "c1", "c2"), "conflict", "the folder committed meanwhile: conflict, never overwrite");
    assert.equal(d("head", "c9", "c1", "c2"), "conflict");
    assert.equal(d("index", "index:9", "index:1", "index:1"), "unchanged", "the Branch did not change the index: leave the folder's");
    assert.equal(d("index", "file:9", "file:1", "file:2"), "skip", "an unparsed index (split index) is never taken for a host commit");
    assert.equal(d("index", "index:9", "index:1", "index:2"), "conflict", "a parsed index the folder changed is");
    assert.equal(d("soft", "l9", "l1", "l2"), "skip", "logs the folder changed are left");
    assert.equal(d("ref", "c2", "c1", "c2"), "unchanged");
    assert.equal(d("transient", null, null, "x"), "skip");
    assert.equal(d("protected", null, null, "x"), "skip");
    assert.equal(core.gitPathKind(".git/index.lock"), "transient");
    assert.equal(core.gitPathKind(".git/objects/info/packs"), "transient", "caches git rebuilds are not applied");
    const { isSafeRefName, GIT_JOIN_HINT } = await import("../src/gitpaths.ts");
    for (const ok of ["main", "feat/x-1", "release/1.2"]) assert.equal(isSafeRefName(ok), true, ok);
    for (const bad of ["foo;touch /tmp/x", "$(id)", "a b", "../x", "a..b", ".hidden", "x.lock", "-x", "a//b", "`id`"]) assert.equal(isSafeRefName(bad), false, bad);
    assert.match(GIT_JOIN_HINT("refs/minilfs/s-1/heads/main"), /'refs\/minilfs\/s-1\/heads\/main'/, "the ref is quoted");
  });

  await step("index signature compares staged entries, not stat data (a host index with other inodes equals the Branch's)", async () => {
    const { execSync } = await import("node:child_process");
    const { readFileSync } = await import("node:fs");
    const g = join(dir, "idx");
    mkdirSync(join(g, "d"), { recursive: true });
    const git = (c) => execSync(`git -c user.email=a@b -c user.name=a ${c}`, { cwd: g, stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    git("init -q");
    for (let i = 0; i < 20; i++) writeFileSync(join(g, "d", `f${i}`), String(i));
    git("add -A");
    for (const v of [2, 3, 4]) {
      git(`update-index --index-version ${v}`);
      const e = core.indexEntries(readFileSync(join(g, ".git/index")));
      assert.ok(e, `index v${v} parses`);
      assert.equal(e.split("\n").length, 20);
    }
    const before = core.indexEntries(readFileSync(join(g, ".git/index")));
    execSync("touch d/f1", { cwd: g });
    git("update-index --refresh");
    assert.equal(core.indexEntries(readFileSync(join(g, ".git/index"))), before, "stat-only change: same entries");
    writeFileSync(join(g, "d", "f1"), "changed");
    git("add d/f1");
    assert.notEqual(core.indexEntries(readFileSync(join(g, ".git/index"))), before, "staged content change: different entries");
  });

  await step("S11 index entries: an empty index parses as []; a path holding a newline stays one entry with its real oid", async () => {
    const { execSync } = await import("node:child_process");
    const { readFileSync } = await import("node:fs");
    const g = join(dir, "s11");
    mkdirSync(g, { recursive: true });
    const git = (c) => execSync(`git ${c}`, { cwd: g, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
    git("init -q");
    git("read-tree --empty");
    const empty = readFileSync(join(g, ".git/index"));
    assert.deepEqual(core.parseIndexEntries(empty), []);
    assert.equal(core.indexEntries(empty), "", "an empty index is not unreadable");
    assert.match(core.gitSig("index", { data: empty, mode: 0o644 }), /^index:/);
    const name = `line1\n100644 ${"f".repeat(40)} 0 0 bogus`;
    writeFileSync(join(g, name), "x\n");
    git("add -A");
    const e = core.parseIndexEntries(readFileSync(join(g, ".git/index")));
    assert.equal(e.length, 1);
    assert.equal(e[0].path, name);
    assert.equal(e[0].oid, git("hash-object --stdin <<< x"), "the real blob, not the oid inside the name");
    assert.notEqual(e[0].oid, "f".repeat(40));
  });

  await step("S9 gitDirOf: a submodule named a/refs is its own git dir (on disk and by name); a submodule's reflog and odd branch names stay in it", async () => {
    const { gitDirOf } = await import("../src/gitpaths.ts");
    const t = join(dir, "s9");
    for (const d of [".git/modules/a/refs/objects", ".git/modules/a/refs/refs/heads", ".git/modules/x/objects", ".git/modules/x/refs/heads", ".git/modules/x/logs/refs/heads"]) mkdirSync(join(t, d), { recursive: true });
    writeFileSync(join(t, ".git/modules/a/refs/HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(t, ".git/modules/x/HEAD"), "ref: refs/heads/main\n");
    assert.equal(gitDirOf(".git/modules/a/refs/refs/heads/main", t), ".git/modules/a/refs");
    assert.equal(gitDirOf(".git/modules/a/refs/refs/heads/main"), ".git/modules/a/refs");
    assert.equal(gitDirOf(".git/modules/x/logs/refs/heads/main", t), ".git/modules/x");
    assert.equal(gitDirOf(".git/modules/x/logs/refs/heads/main"), ".git/modules/x");
    assert.equal(gitDirOf(".git/modules/x/refs/heads/index"), ".git/modules/x", "a branch named index");
    assert.equal(gitDirOf(".git/modules/x/refs/heads/main", t), ".git/modules/x");
    assert.equal(gitDirOf(".git/refs/heads/modules/x"), ".git");
    assert.equal(gitDirOf("sub/.git/worktrees/w/HEAD"), "sub/.git/worktrees/w");
    assert.equal(core.gitPathKind(".git/modules/a/refs/index"), "index", "the index of submodule a/refs");
    assert.equal(core.gitPathKind(".git/modules/x/refs/heads/index"), "ref");
  });

  await step("config: a bad number is a start problem, never NaN; new defaults fit a full-tree import", async () => {
    const { resolveConfig } = await import("../src/config.ts");
    const c = resolveConfig({ MINILFS_INIT_TIMEOUT_MS: "5min", MINILFS_MAX_IMPORT_FILES: "-1" });
    assert.equal(c.initTimeoutMs, undefined);
    assert.equal(c.problems.length, 2, c.problems.join("; "));
    const d = resolveConfig({});
    assert.equal(d.problems.length, 0);
    assert.ok(d.maxImportFiles >= 300_000);
    assert.match(d.bundle, /bundle-[0-9a-f]{7}$/, "the default bundle folder is named after the pinned LayerFS commit");
    assert.ok(d.excludes.includes("service-account*.json") && d.excludes.includes(".git-credentials"));
  });

  await step("bundle pin: a prebuilt of another LayerFS commit is never downloaded for this code", async () => {
    const b = await import("../src/bundle.ts");
    const { readFileSync } = await import("node:fs");
    const pin = JSON.parse(readFileSync(new URL("../layerfs.json", import.meta.url), "utf8")).commit;
    assert.equal(b.LAYERFS_COMMIT, pin);
    const script = readFileSync(new URL("../scripts/setup-layerfs.sh", import.meta.url), "utf8");
    assert.ok(script.includes(`REF="${pin}"`), "setup-layerfs.sh builds the pinned commit");
    const empty = join(dir, "no-bundle");
    const problem = await b.ensureBundle(empty);
    const pre = b.PREBUILT[`${process.platform}-${process.arch}`];
    if (pre && !pre.tag.includes(`-${pin.slice(0, 7)}-`)) assert.match(problem, /not published yet/, "refuses a stale pinned release");
    mkdirSync(join(dir, "old-bundle", "api/agent/sdk/src"), { recursive: true });
    for (const f of b.BUNDLE_FILES) writeFileSync(join(dir, "old-bundle", f), "");
    writeFileSync(join(dir, "old-bundle", "BUILD-INFO.txt"), "LayerFS 833acf7b12b206396381c0b5605fe861f7f7d5a0 (native)\n");
    assert.match(await b.ensureBundle(join(dir, "old-bundle")), /needs [0-9a-f]{12}/, "a complete bundle of another commit is refused");
  });

  await step("failed start: tools error, nothing runs on the folder", async () => {
    failOpen = true;
    const e = await load();
    await assert.rejects(bash(e, { command: "echo ok > after-fail.txt" }), /failed to start/);
    assert.equal(existsSync(join(dir, "after-fail.txt")), false);
    failOpen = false;
  });

  await step("git join after a LayerFS merge: merge commit with both parents, ff, up to date, git conflicts LayerFS resolved; index clean", async () => {
    const { execSync, spawnSync } = await import("node:child_process");
    const { GIT_JOIN_SCRIPT, parseJoin } = await import("../src/gitjoin.ts");
    const genv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@b", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@b" };
    const sh = (cwd, c) => execSync(c, { cwd, env: genv, encoding: "utf8", shell: "/bin/sh" }).trim();
    const joinIn = (cwd, ours, theirs) => parseJoin(spawnSync("/bin/bash", ["-c", GIT_JOIN_SCRIPT, "_", ours, theirs, "refs/heads/main", "Merge w into main"], { cwd, env: genv, encoding: "utf8" }).stdout);
    const repo = (name) => { const d = join(dir, "join-" + name); mkdirSync(d, { recursive: true }); sh(d, "git init -q -b main && echo a > a.txt && git add -A && git commit -qm base"); return d; };
    // diverged; the work tree holds LayerFS's merge (both files) plus one uncommitted edit
    let d = repo("div");
    sh(d, "git checkout -q -b w && echo w > w.txt && git add w.txt && git commit -qm by-w"); let theirs = sh(d, "git rev-parse HEAD");
    sh(d, "git checkout -q main && echo l > l.txt && git add l.txt && git commit -qm by-l"); let ours = sh(d, "git rev-parse HEAD");
    writeFileSync(join(d, "w.txt"), "w\n"); writeFileSync(join(d, "a.txt"), "uncommitted\n");
    let r = joinIn(d, ours, theirs);
    assert.equal(r.mode, "merged");
    assert.equal(sh(d, "git cat-file -p HEAD | grep -c ^parent"), "2");
    assert.equal(sh(d, "git rev-parse HEAD^1"), ours, "the lead side is the first parent");
    assert.equal(sh(d, "git status --porcelain"), "M a.txt", "only what neither side committed stays a change");
    // fast-forward: the lead made no commit
    d = repo("ff"); ours = sh(d, "git rev-parse HEAD");
    sh(d, "git checkout -q -b w && echo w > w.txt && git add w.txt && git commit -qm by-w"); theirs = sh(d, "git rev-parse HEAD");
    sh(d, "git checkout -q main"); writeFileSync(join(d, "w.txt"), "w\n");
    r = joinIn(d, ours, theirs);
    assert.deepEqual([r.mode, r.commit], ["ff", theirs]);
    assert.equal(sh(d, "git status --porcelain"), "");
    // up to date
    d = repo("up"); theirs = sh(d, "git rev-parse HEAD"); sh(d, "echo l > l.txt && git add -A && git commit -qm l"); ours = sh(d, "git rev-parse HEAD");
    assert.equal(joinIn(d, ours, theirs).mode, "uptodate");
    // both edited a.txt (git conflict); LayerFS resolved it in the work tree; clean changes of both sides kept
    d = repo("conf");
    sh(d, "git checkout -q -b w && echo W > a.txt && echo wo > w.txt && git add -A && git commit -qm by-w"); theirs = sh(d, "git rev-parse HEAD");
    sh(d, "git checkout -q main && echo L > a.txt && echo lo > l.txt && git add -A && git commit -qm by-l"); ours = sh(d, "git rev-parse HEAD");
    writeFileSync(join(d, "a.txt"), "resolved\n"); writeFileSync(join(d, "w.txt"), "wo\n"); writeFileSync(join(d, "scratch.tmp"), "x\n");
    r = joinIn(d, ours, theirs);
    assert.equal(r.mode, "worktree");
    assert.equal(sh(d, "git show HEAD:a.txt"), "resolved", "the commit records LayerFS's resolution");
    assert.equal(sh(d, "git ls-tree --name-only HEAD | tr '\\n' ' '"), "a.txt l.txt w.txt", "both sides' clean changes, no uncommitted file");
    assert.equal(sh(d, "git status --porcelain"), "?? scratch.tmp");
    assert.equal(spawnSync("git", ["fsck", "--no-progress"], { cwd: d }).status, 0);
    // modify/delete conflict LayerFS resolved by deleting, and a conflict on a path with a space
    d = repo("moddel");
    sh(d, "echo d > d.txt && echo s > 'sp ace.txt' && git add -A && git commit -qm more");
    sh(d, "git checkout -q -b w && git rm -q d.txt && echo W > 'sp ace.txt' && git commit -qam by-w"); theirs = sh(d, "git rev-parse HEAD");
    sh(d, "git checkout -q main && echo L > d.txt && echo L > 'sp ace.txt' && git commit -qam by-l"); ours = sh(d, "git rev-parse HEAD");
    rmSync(join(d, "d.txt")); writeFileSync(join(d, "sp ace.txt"), "merged\n");
    r = joinIn(d, ours, theirs);
    assert.equal(r.mode, "worktree", JSON.stringify(r));
    assert.equal(sh(d, "git ls-tree --name-only HEAD | tr '\\n' '|'"), "a.txt|sp ace.txt|", "the deleted file is gone from the merge commit");
    assert.equal(sh(d, "git show 'HEAD:sp ace.txt'"), "merged");
    assert.equal(sh(d, "git status --porcelain"), "");
    // HEAD on another branch: nothing is changed
    d = repo("other"); sh(d, "git checkout -q -b feat"); const h = sh(d, "git rev-parse HEAD");
    assert.equal(joinIn(d, h, h).mode, "skip");
  });

  await step("R5 R6 R13 git join: a newline in a conflicting name, a held index.lock (no half state), no filter driver runs", async () => {
    const { execSync, spawnSync } = await import("node:child_process");
    const { GIT_JOIN_SCRIPT, parseJoin } = await import("../src/gitjoin.ts");
    const genv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@b", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@b" };
    const sh = (cwd, c) => execSync(c, { cwd, env: genv, encoding: "utf8", shell: "/bin/bash" }).trim();
    const joinIn = (cwd, ours, theirs) => parseJoin(spawnSync("/bin/bash", ["-c", GIT_JOIN_SCRIPT, "_", ours, theirs, "refs/heads/main", "Merge w into main"], { cwd, env: genv, encoding: "utf8" }).stdout);
    // both sides edit `file`, plus a clean change each: git conflicts on `file`, LayerFS resolved it
    const conflicted = (name, file) => {
      const d = join(dir, "r5-" + name); mkdirSync(d, { recursive: true });
      const f = file.replace(/'/g, "'\\''");
      sh(d, `git init -q -b main && printf base > '${f}' && git add -A && git commit -qm base`);
      sh(d, `git checkout -q -b w && printf W > '${f}' && echo w > w.txt && git add -A && git commit -qm by-w`); const theirs = sh(d, "git rev-parse HEAD");
      sh(d, `git checkout -q main && printf L > '${f}' && echo l > l.txt && git add -A && git commit -qm by-l`); const ours = sh(d, "git rev-parse HEAD");
      writeFileSync(join(d, file), "resolved"); writeFileSync(join(d, "w.txt"), "w\n");
      return { d, ours, theirs };
    };
    // R6: the name holds a newline
    let { d, ours, theirs } = conflicted("nl", "line1\nline2.txt");
    let r = joinIn(d, ours, theirs);
    assert.equal(r.mode, "worktree", JSON.stringify(r));
    assert.equal(sh(d, "git show 'HEAD:line1\nline2.txt'"), "resolved", "the name is intact in the commit");
    assert.deepEqual(sh(d, "git ls-tree -z --name-only HEAD").split("\0").filter(Boolean), ["l.txt", "line1\nline2.txt", "w.txt"]);
    // R5: index.lock held -> fail, the branch ref unchanged
    ({ d, ours, theirs } = conflicted("lock", "a.txt"));
    writeFileSync(join(d, ".git/index.lock"), "");
    r = joinIn(d, ours, theirs);
    assert.equal(r.mode, "fail", JSON.stringify(r));
    assert.equal(sh(d, "git rev-parse refs/heads/main"), ours, "the branch did not move");
    rmSync(join(d, ".git/index.lock"));
    // R13: a clean filter from the repo's config + .gitattributes never runs
    ({ d, ours, theirs } = conflicted("filter", "a.txt"));
    const marker = join(dir, "r13-pwned");
    sh(d, `git config filter.pwn.clean 'touch ${marker}; cat' && echo '* filter=pwn' > .gitattributes`);
    r = joinIn(d, ours, theirs);
    assert.equal(r.mode, "worktree", JSON.stringify(r));
    assert.equal(existsSync(marker), false, "the filter driver did not run");
  });

  await step("team lead alias: a finished or crashed earlier lead does not keep `lead`; a running one does", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/workspace.ts", import.meta.url), "utf8");
    assert.match(src, /s\.logicalBranch === "lead" && sessionAlive\(s\)/, "the lead alias check requires a live holder");
    assert.match(src, /pid: this\.closed \? undefined : process\.pid/, "a closed session drops its pid");
    // the liveness rule itself
    const fn = new Function("hostname", "alive", "process", `${/function sessionAlive[\s\S]*?\n}\n/.exec(src)[0].replace(/: SessionBinding|: boolean/g, "")}; return sessionAlive;`);
    const sessionAlive = fn(() => "h1", (pid) => pid === 4242, { pid: 1 });
    assert.equal(sessionAlive({}), false, "no pid (closed / older binding): gone");
    assert.equal(sessionAlive({ pid: 999999, host: "h1" }), false, "dead pid on this host: gone");
    assert.equal(sessionAlive({ pid: 4242, host: "h1" }), true, "live pid: holds the alias");
    assert.equal(sessionAlive({ pid: 999999, host: "other" }), true, "another host: cannot check, assume it runs");
  });

  await step("R8 alias resolution: a live lead (newer, no commit) beats a dead earlier lead with commits", async () => {
    const { resolveConfig } = await import("../src/config.ts");
    const { hostname } = await import("node:os");
    const s = new ws.LayerfsSession(dir, "r8", resolveConfig({}));
    s.projectRecord = { name: "p", volume: "v" };
    const now = Date.now();
    s.bindings = { reload() {}, data: { sessions: {
      dead: { project: "p", logicalBranch: "lead", workBranch: "s-dead-3", headCommit: "c1", updatedAt: now - 60_000, pid: 999999, host: hostname() },
      live: { project: "p", logicalBranch: "lead", workBranch: "s-live-1", headCommit: null, updatedAt: now, pid: process.pid, host: hostname() },
    } } };
    assert.equal(await s.resolveBranchName("lead"), "s-live-1");
    const cmp = ws.compareSessionsForAlias;
    assert.equal(typeof cmp, "function");
    const live = () => true;
    assert.ok(cmp({ updatedAt: 2 }, { updatedAt: 1, headCommit: "c" }, live) < 0, "both live: the newer first");
    assert.ok(cmp({ updatedAt: 1 }, { updatedAt: 1, headCommit: "c" }, live) > 0, "same time: the one with a commit first");
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
  await step("R1 file tools cannot read minilfs's root (worker endpoint), in any spelling or through a symlink; exists is false", async () => {
    const { resolveConfig } = await import("../src/config.ts");
    const { symlinkSync } = await import("node:fs");
    const { homedir } = await import("node:os");
    const t = `/tmp/minilfs-r1-${Date.now().toString(36)}`;
    const root = join(t, "root"), wdir = join(root, "worker", "b1"), endpoint = join(wdir, "endpoint.json");
    mkdirSync(wdir, { recursive: true }); mkdirSync(join(t, "proj")); writeFileSync(endpoint, '{"secret":"s"}');
    writeFileSync(join(t, "notes.md"), "ok\n");
    symlinkSync(endpoint, join(t, "link-to-endpoint"));
    symlinkSync(join(homedir(), ".ssh"), join(t, "link-to-ssh"));
    try {
      const s = new ws.LayerfsSession(join(t, "proj"), "r1", { ...resolveConfig({}), root });
      const denied = (e) => e.code === "EACCES";
      for (const p of [endpoint, `/private${endpoint}`, join(t, "link-to-endpoint")]) await assert.rejects(s.readFile(p), denied, p);
      await assert.rejects(s.readdir(join(root, "worker")), denied);
      await assert.rejects(s.readdir(`/private${root}/worker`), denied);
      await assert.rejects(s.readdir(join(t, "link-to-ssh")), denied);
      await assert.rejects(s.access(endpoint), denied);
      await assert.rejects(s.access(join(root, "worker", "nope", "x")), denied, "a missing child under the root: EACCES, not ENOENT");
      await assert.rejects(s.isDirectory(join(root, "worker")), denied);
      assert.equal(await s.exists(endpoint), false);
      assert.equal(await s.exists(join(t, "link-to-endpoint")), false);
      assert.equal((await s.readFile(join(t, "notes.md"))).toString(), "ok\n", "other outside files stay readable");
      assert.equal(await s.exists(join(t, "notes.md")), true);
      // S2: APFS is case-insensitive; a case variant of the root (or a missing child under one) is the root
      const upRoot = join(t, "ROOT");
      for (const p of [endpoint.replace("/worker/", "/WORKER/"), join(upRoot, "worker", "b1", "endpoint.json"), join(upRoot, "worker", "nope", "endpoint.json")]) {
        await assert.rejects(s.readFile(p), denied, p);
        await assert.rejects(s.access(p), denied, p);
        assert.equal(await s.exists(p), false, p);
      }
      for (const p of [join(upRoot, "WORKER"), join(root, "Worker")]) {
        await assert.rejects(s.readdir(p), denied, p);
        await assert.rejects(s.isDirectory(p), denied, p);
      }
    } finally { rmSync(t, { recursive: true, force: true }); }
  });
  await step("S1 outside reads are checked by the kernel: an ancestor swapped for a symlink to the root (or ~/.ssh) after the check is refused", async () => {
    const { resolveConfig } = await import("../src/config.ts");
    const { symlinkSync } = await import("node:fs");
    const { homedir } = await import("node:os");
    const t = `/tmp/minilfs-s1-${Date.now().toString(36)}`;
    const root = join(t, "root"), wdir = join(root, "worker", "b1");
    mkdirSync(wdir, { recursive: true }); mkdirSync(join(t, "proj")); writeFileSync(join(wdir, "endpoint.json"), '{"secret":"s"}');
    const flip = join(t, "flip");
    try {
      const s = new ws.LayerfsSession(join(t, "proj"), "s1", { ...resolveConfig({}), root });
      // the race, made deterministic: `flip` is a harmless folder while the path is checked, and a
      // symlink to `to` right after (an agent's bash can do this between the check and the read)
      let to = wdir;
      const check = s.resolveOutsideRead.bind(s);
      s.resolveOutsideRead = async (p) => {
        const r = await check(p);
        rmSync(flip, { recursive: true, force: true });
        symlinkSync(to, flip);
        return r;
      };
      const arm = (target) => {
        to = target;
        rmSync(flip, { recursive: true, force: true });
        mkdirSync(flip);
        writeFileSync(join(flip, "endpoint.json"), "harmless");
      };
      const denied = (e) => e.code === "EACCES";
      arm(wdir); await assert.rejects(s.readFile(join(flip, "endpoint.json")), denied, "readFile");
      arm(wdir); await assert.rejects(s.access(join(flip, "endpoint.json")), denied, "access");
      arm(wdir); assert.equal(await s.exists(join(flip, "endpoint.json")), false, "exists");
      arm(join(root, "worker")); await assert.rejects(s.readdir(flip), denied, "readdir");
      arm(join(root, "worker")); await assert.rejects(s.isDirectory(flip), denied, "isDirectory");
      if (existsSync(join(homedir(), ".ssh"))) { arm(join(homedir(), ".ssh")); await assert.rejects(s.readdir(flip), denied, "readdir ~/.ssh"); }
      // unhooked: ordinary outside reads still work through the kernel-checked path
      s.resolveOutsideRead = check;
      arm(wdir);
      assert.equal((await s.readFile(join(flip, "endpoint.json"))).toString(), "harmless");
      assert.deepEqual(await s.readdir(flip), ["endpoint.json"]);
      assert.equal(await s.isDirectory(flip), true);
      assert.equal(await s.isDirectory(join(flip, "endpoint.json")), false);
      assert.equal(await s.exists(join(flip, "nope")), false);
      await assert.rejects(s.readFile(join(flip, "nope")), (e) => e.code === "ENOENT");
      await assert.rejects(s.readFile(flip), (e) => e.code === "EISDIR");
      writeFileSync(join(t, "empty"), "");
      assert.equal((await s.readFile(join(t, "empty"))).length, 0);
    } finally { rmSync(t, { recursive: true, force: true }); }
  });
  await step("R14 prelude timeout: 124 only when the limit fired, a command's own SIGTERM exit stays 143", async () => {
    const { spawnSync } = await import("node:child_process");
    const { buildNativeShellPrelude } = await import("../src/core/driver.ts");
    // PATH without GNU timeout, so the prelude defines its own
    const sh = (cmd) => spawnSync("/bin/bash", ["-c", `${buildNativeShellPrelude(dir, dir)}\n${cmd}; echo "rc=$?"`], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", TMPDIR: dir } }).stdout.trim();
    assert.equal(sh("command -v timeout"), "timeout\nrc=0", "the prelude's function, not a binary");
    assert.equal(sh("timeout 10 sh -c 'kill -TERM $$'"), "rc=143");
    assert.equal(sh("timeout 1 sh -c 'sleep 10'"), "rc=124");
    assert.equal(sh("timeout 5 sh -c 'exit 3'"), "rc=3");
    assert.deepEqual((await import("node:fs")).readdirSync(dir).filter((n) => n.startsWith(".minilfs-timeout")), [], "no marker left");
  });
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
