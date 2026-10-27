// Checks a packed LayerFS v1.1.0 bundle before it is published: unpacks it, loads the official
// @layerfs/agent with its own layerfs.node, creates a project from a small folder
// (LayerFS.init("smoke", src)), reads a file back, reopens it (LayerFS.open("smoke")), loads
// @layerfs/backend through the bundle's node_modules links, and runs `bin/layerfs --help`.
// Usage: node scripts/smoke-bundle.mjs <bundle.tar.gz>
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const tarball = process.argv[2];
if (!tarball) { console.error("usage: node scripts/smoke-bundle.mjs <bundle.tar.gz>"); process.exit(2); }
const root = mkdtempSync(join(tmpdir(), "lfs-smoke-"));
try {
  const bundle = join(root, "bundle");
  mkdirSync(bundle);
  const tar = spawnSync("/usr/bin/tar", ["-xzf", tarball, "-C", bundle], { stdio: "inherit" });
  if (tar.status !== 0) throw new Error("tar failed");
  const daemon = spawnSync(join(bundle, "layerfs-daemon"), [], { encoding: "utf8" });
  if (!/usage: layerfs-daemon/.test(`${daemon.stdout}${daemon.stderr}`)) throw new Error(`layerfs-daemon did not run: ${daemon.error ?? daemon.stderr}`);

  const src = join(root, "src");
  mkdirSync(src);
  writeFileSync(join(src, "hello.txt"), "hello bundle\n");
  const store = join(root, "store");
  mkdirSync(join(store, "global"), { recursive: true });
  const local = join(root, "local");
  mkdirSync(local, { mode: 0o755 });
  chmodSync(local, 0o755);
  // @layerfs/agent has no options argument: every setting comes from LAYERFS_*
  Object.assign(process.env, {
    LAYERFS_NATIVE: join(bundle, "layerfs.node"), LAYERFS_SANDBOX: "native",
    LAYERFS_HOME: join(root, "home"), LAYERFS_STORE_PATH: join(store, "global", "store.sqlite"),
    LAYERFS_LOCAL_DIR: local, LAYERFS_DAEMON: join(bundle, "layerfs-daemon"),
    LAYERFS_VOLUME: "smoke-store", LAYERFS_CONTAINER_PREFIX: "smoke-",
  });
  const { LayerFS } = await import(pathToFileURL(join(bundle, "api/agent/sdk/src/index.js")).href);
  const { LayerFSBackend } = await import(pathToFileURL(join(bundle, "api/backend/src/index.js")).href);
  const lfs = await LayerFS.init("smoke", src);
  const read = await lfs.fs.read("main", "/hello.txt");
  if (read.text !== "hello bundle\n") throw new Error(`read back ${JSON.stringify(read.text)}`);
  const layer = String(lfs.created?.layer ?? "").slice(0, 12);
  await lfs.close();
  const again = await LayerFS.open("smoke");
  const branches = (await again.project.list_branches(10, 0)).items.map((b) => b.name);
  if (!branches.includes("main")) throw new Error(`reopened project has no main: ${branches}`);
  LayerFSBackend.of(again);
  await again.close();
  const cli = spawnSync(process.execPath, [join(bundle, "bin/layerfs"), "--help"], { encoding: "utf8" });
  if (cli.error || !`${cli.stdout}${cli.stderr}`.trim()) throw new Error(`bin/layerfs did not run: ${cli.error ?? cli.stderr}`);
  console.log(`bundle ok: init layer ${layer}, read back hello.txt, reopened, backend + CLI load`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
