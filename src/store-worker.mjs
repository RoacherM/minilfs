#!/usr/bin/env node
// minilfs Store worker: one process per minilfs root that makes every LayerFS Store call, so the
// lead and its sub-agents (separate Pi processes) share one Store connection instead of racing
// each other for the SQLite file (LayerFS refuses a call that meets another process's write:
// "Store busy before effect"). See docs/DESIGN-store-worker.md.
//
// It speaks the official @layerfs/agent worker protocol (transport/worker_client.js ↔
// @layerfs/runtime worker/server.js, #428): a 4-byte length, then a tagged JSON frame. The first
// frame must carry the secret; then each { id, fn, op, args, open } is answered { id, answer }.
// The official server needs a sealed Linux bundle in a container; this one loads the bundle's
// native macOS addon (minilfs's bundle is pinned by layerfs.json and its sha256).
//
//   node store-worker.mjs --dir <worker dir> --home <LayerFS home> --bundle <bundle dir> [--build B] [--idle-ms N]
//
// It writes <dir>/endpoint.json { home, port, secret, build, pid } (0600) once listening,
// on 127.0.0.1 only; the secret is made here and never passed in argv or env. It exits after
// --idle-ms (default 10 min) with no client connection and no call running, closing its Stores
// and removing its endpoint file.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const dir = arg("dir");
const home = arg("home");
const bundle = arg("bundle");
const build = arg("build", "unknown");
const IDLE_MS = Number(arg("idle-ms", String(10 * 60_000)));
const STORE_IDLE_MS = 60_000;
if (!dir || !home || !bundle) {
  console.error("store-worker: needs --dir, --home and --bundle");
  process.exit(2);
}
const FIRST_LIMIT = 4096, SECRET_MS = 5000;
const FUNCTIONS = new Set(["call", "backendCall", "releaseStore"]);
// every binding call runs on Node's worker pool; a mount or Init holds a thread while it runs
process.env.UV_THREADPOOL_SIZE ??= "64";

const { frame, readFrames } = await import(pathToFileURL(join(bundle, "api/agent/sdk/src/internal.js")).href);
const binding = createRequire(import.meta.url)(join(bundle, "layerfs.node"));


const endpointFile = join(dir, "endpoint.json");
const secret = randomBytes(32);
const log = (msg) => console.error(`${new Date().toISOString()} store-worker[${process.pid}] ${msg}`);

// ---------------------------------------------------------------- Stores (as the official server.js)
/** open Stores by path: { opening, users, timer, args, closing } */
const stores = new Map();
const storeOf = (a) => ({ project: a.project, home: a.home, storePath: a.storePath });

async function closeStore(path) {
  const held = stores.get(path);
  if (!held) return { value: null };
  if (held.users) return { refused: { code: "Busy", message: "the project's Store has active calls", detail: null } };
  clearTimeout(held.timer);
  held.closing ??= held.opening.then(() => binding.storeClose(storeOf(held.args))).finally(() => {
    if (stores.get(path) === held) stores.delete(path);
  });
  await held.closing;
  return { value: null };
}

/** Runs `work` with the call's Store open (one open per Store, shared by every client). */
async function withStore(args, work) {
  let held = stores.get(args.storePath);
  while (held?.closing) { await held.closing.catch(() => {}); held = stores.get(args.storePath); }
  if (!held) stores.set(args.storePath, (held = { opening: binding.storeOpen(storeOf(args)), users: 0, timer: null, args }));
  held.users++;
  clearTimeout(held.timer);
  try {
    const opened = await held.opening.catch((error) => ({ thrown: error }));
    if (opened?.refused || opened?.thrown) {
      if (stores.get(args.storePath) === held) stores.delete(args.storePath);
      if (opened.thrown) throw opened.thrown;
      return opened;
    }
    return await work();
  } finally {
    if (--held.users === 0 && stores.get(args.storePath) === held) {
      held.timer = setTimeout(() => closeStore(args.storePath).catch((e) => log(`closing ${args.storePath}: ${e}`)), STORE_IDLE_MS);
    }
  }
}

// a spooled exec's output, read here and returned whole (as the official worker/call.js)
const PAGE = 1 << 20;
async function made(fn, op, args) {
  const answer = await binding[fn](op, args);
  if (!(fn === "call" && op === "workspace.exec" && answer.value?.output !== undefined)) return answer;
  const { output, ...value } = answer.value;
  const page = Buffer.allocUnsafe(PAGE);
  try {
    for (const name of ["stdout", "stderr"]) {
      if (value[name] !== null) continue;
      const parts = [];
      for (let offset = 0, end = false; !end; ) {
        const read = await binding.execOutput({ output, stream: name, offset }, page);
        if (read.refused) return read;
        parts.push(Buffer.from(page.subarray(0, read.value.length)));
        offset += read.value.length;
        end = read.value.end || read.value.length === 0;
      }
      const bytes = Buffer.concat(parts);
      value[`${name}Bytes`] = bytes.length;
      value[name] = args.spool ? bytes : bytes.toString("utf8");
    }
  } finally {
    await binding.call("workspace.exec_release", { output });
  }
  return { ...answer, value };
}

async function answer({ fn, op, args, open }) {
  if (fn === "releaseStore") return closeStore(args.storePath);
  const call = () => made(fn, op, args);
  return open ? withStore(args, call) : call();
}

// ---------------------------------------------------------------- server
const sockets = new Set();
let active = 0, idleTimer = null, stopping = false;

function armIdle() {
  clearTimeout(idleTimer);
  if (sockets.size || active) return;
  idleTimer = setTimeout(() => stop("idle").catch((e) => log(`stop: ${e}`)), IDLE_MS);
  idleTimer.unref?.();
}

async function stop(why) {
  if (stopping) return;
  stopping = true;
  log(`stopping (${why})`);
  server.close();
  // only our own endpoint: a newer worker may have replaced it
  try {
    const cur = JSON.parse(readFileSync(endpointFile, "utf8"));
    if (cur.pid === process.pid) rmSync(endpointFile, { force: true });
  } catch {}
  for (const path of [...stores.keys()]) await closeStore(path).catch((e) => log(`close ${path}: ${e}`));
  for (const s of sockets) s.destroy();
  process.exit(0);
}

const server = createServer((socket) => {
  sockets.add(socket);
  clearTimeout(idleTimer);
  socket.setNoDelay(true);
  socket.on("error", () => {}); // a client that went away; its calls still finish here
  socket.on("close", () => { sockets.delete(socket); armIdle(); });
  let trusted = false;
  const silent = setTimeout(() => socket.destroy(), SECRET_MS);
  socket.on("close", () => clearTimeout(silent));
  readFrames(socket, async (request) => {
    if (!trusted) {
      const given = Buffer.from(String(request?.secret ?? ""), "hex");
      if (given.length !== secret.length || !timingSafeEqual(given, secret)) return socket.destroy();
      trusted = true;
      clearTimeout(silent);
      return socket.write(frame({ id: 0, answer: { value: "hello" } }));
    }
    const { id, fn, args } = request;
    if (fn === "ping") return socket.write(frame({ id, answer: { value: { ready: true, active, clients: sockets.size, stores: stores.size, build, pid: process.pid } } }));
    if (stopping) return socket.write(frame({ id, answer: { refused: { code: "Failed", message: "the LayerFS worker is closing; the call was not attempted", detail: null } } }));
    if (!FUNCTIONS.has(fn) || args?.home !== home) return socket.destroy();
    active++;
    let result;
    try { result = await answer(request); } catch (error) { result = { thrown: String(error?.stack ?? error) }; } finally { active--; armIdle(); }
    if (!socket.destroyed) socket.write(frame({ id, answer: result }));
  }, (error) => { log(`bad frame: ${error.message}`); socket.destroy(); }, { firstLimit: FIRST_LIMIT });
});

process.on("SIGTERM", () => stop("SIGTERM").catch(() => process.exit(1)));
process.on("SIGINT", () => stop("SIGINT").catch(() => process.exit(1)));

server.listen(0, "127.0.0.1", () => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = { home, port: server.address().port, secret: secret.toString("hex"), build, pid: process.pid, startedAt: Date.now() };
  writeFileSync(`${endpointFile}.${process.pid}`, JSON.stringify(info), { mode: 0o600 });
  renameSync(`${endpointFile}.${process.pid}`, endpointFile);
  log(`listening on 127.0.0.1:${info.port} (build ${build}, bundle ${bundle})`);
  armIdle();
});
