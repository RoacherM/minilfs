#!/usr/bin/env node
// Sums Pi session logs (lead + every sub-agent) under a directory: tokens, cache hit rate,
// tool calls by name, LayerFS merges/conflicts/applies, wall time per session.
// Usage: node scripts/metrics.mjs [.quarry-agent/sessions] [--since <unix-seconds>]
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const root = args.find((a) => !a.startsWith("--")) ?? ".quarry-agent/sessions";
const sinceIdx = args.indexOf("--since");
const since = sinceIdx >= 0 ? Number(args[sinceIdx + 1]) * 1000 : 0;

if (!existsSync(root)) {
  console.log(`No session logs yet under ${root}`);
  process.exit(0);
}

const files = [];
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) {
      if (e.name !== "subagent-artifacts") walk(p);
    } else if (e.name.endsWith(".jsonl") && statSync(p).mtimeMs >= since) {
      files.push(p);
    }
  }
};
walk(root);

const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
const tools = new Map();
const lfs = { merge: 0, conflict: 0, sync: 0, apply: 0, checkout: 0, diff: 0, show: 0, ls: 0 };
const rows = [];
for (const f of files) {
  const s = { file: f, model: "", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tools: 0, first: Infinity, last: 0 };
  const pendingLfs = new Map();
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const t = Date.parse(e.timestamp ?? "");
    if (t) { s.first = Math.min(s.first, t); s.last = Math.max(s.last, t); }
    if (e.type === "model_change") s.model = `${e.provider}/${e.modelId}`;
    const m = e.message;
    if (e.type !== "message" || !m) continue;
    if (m.role === "assistant") {
      const u = m.usage ?? {};
      s.input += u.input ?? 0;
      s.output += u.output ?? 0;
      s.cacheRead += u.cacheRead ?? 0;
      s.cacheWrite += u.cacheWrite ?? 0;
      total.cost += u.cost?.total ?? 0;
      total.turns++;
      for (const c of m.content ?? []) {
        if (c.type !== "toolCall") continue;
        s.tools++;
        tools.set(c.name, (tools.get(c.name) ?? 0) + 1);
        if ((c.name === "minilfs" || c.name === "layerfs") && c.arguments?.action) {
          pendingLfs.set(c.id, c.arguments.action);
        }
        if (c.name === "minilfs_apply" || c.name === "layerfs_apply") lfs.apply++;
      }
    }
    if (m.role === "toolResult" && pendingLfs.has(m.toolCallId)) {
      const text = (m.content ?? []).map((c) => c.text ?? "").join("");
      const act = pendingLfs.get(m.toolCallId);
      if (act in lfs) lfs[act]++;
      if (/^CONFLICT/.test(text)) lfs.conflict++;
    }
  }
  for (const k of ["input", "output", "cacheRead", "cacheWrite"]) total[k] += s[k];
  rows.push(s);
}

const M = (n) => (n / 1e6).toFixed(2) + "M";
const promptTokens = total.input + total.cacheRead + total.cacheWrite;
console.log(`sessions: ${rows.length}  assistant turns: ${total.turns}`);
console.log(`tokens: input ${M(total.input)}  cacheRead ${M(total.cacheRead)}  cacheWrite ${M(total.cacheWrite)}  output ${M(total.output)}  total ${M(promptTokens + total.output)}`);
console.log(`cache hit rate: ${promptTokens ? ((total.cacheRead / promptTokens) * 100).toFixed(1) : 0}%   reported cost: ${total.cost.toFixed(4)}`);
console.log(`minilfs: merges ${lfs.merge}  syncs ${lfs.sync}  checkouts ${lfs.checkout}  diffs ${lfs.diff}  shows ${lfs.show}  ls ${lfs.ls}  conflicts ${lfs.conflict}  applies ${lfs.apply}`);
console.log(`tools: ${[...tools.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}`);
console.log("\nper session (wall min, tools, prompt tokens, output):");
for (const s of rows.sort((a, b) => a.first - b.first)) {
  const wall = s.last > s.first ? ((s.last - s.first) / 60000).toFixed(1) : "0";
  console.log(`  ${new Date(s.first).toISOString().slice(11, 19)}  ${wall.padStart(6)}m  ${String(s.tools).padStart(4)} tools  ${M(s.input + s.cacheRead + s.cacheWrite).padStart(8)}  ${M(s.output).padStart(7)}  ${s.file.split("/").slice(-2).join("/")}`);
}
