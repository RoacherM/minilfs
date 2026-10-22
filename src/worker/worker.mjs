// Runs INSIDE the Linux worker container (real layerfs.node). One worker per Pi
// session and project. Protocol: JSON lines on stdin/stdout,
//   request  { id, op, args: [...] }
//   response { id, ok: true, value } | { id, ok: false, error: { code, message, detail } }
// stdout carries only protocol lines; diagnostics go to stderr.
import { createInterface } from "node:readline";

const bundle = process.env.LFS_BUNDLE;
const { LayerFS } = await import(`${bundle}/sdk/js/src/index.js`);
const lfs = new LayerFS(process.env.LFS_PROJECT);

const ops = {
  ping: async () => "pong",
  init: ([source]) => lfs.project.init(source),
  fork: ([name, from]) => (from ? lfs.branch.fork(name, from) : lfs.branch.fork(name)),
  mount: ([branch]) => lfs.workspace.mount(branch),
  exec: ([ws, command, message]) => lfs.workspace.exec(ws, command, message),
  status: ([ws]) => lfs.workspace.status(ws),
  commit: ([ws, message]) => lfs.workspace.commit(ws, message),
  unmount: ([ws, discard]) => lfs.workspace.unmount(ws, discard === true),
  diff_branches: ([from, to, size, pos, options]) => lfs.branch.diff_branches(from, to, size, pos, options),
  list_commits: ([branch, size, pos]) => lfs.branch.list_commits(branch, size, pos),
};

const write = (value) =>
  process.stdout.write(`${JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}\n`);

let pending = 0;
let ending = false;
const finish = () => {
  if (!ending || pending > 0) return;
  try { lfs.close?.(); } catch {}
  process.exit(0);
};

createInterface({ input: process.stdin }).on("line", async (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  const { id, op, args = [] } = request;
  pending++;
  try {
    if (!ops[op]) throw Object.assign(new Error(`unknown op ${op}`), { code: "InvalidInput" });
    write({ id, ok: true, value: (await ops[op](args)) ?? null });
  } catch (error) {
    write({ id, ok: false, error: { code: error?.code ?? "Failed", message: String(error?.message ?? error), detail: error?.detail ?? null } });
  } finally {
    pending--;
    finish();
  }
}).on("close", () => { ending = true; finish(); });

process.stderr.write("pi-layerfs worker ready\n");
