// Checks a packed LayerFS bundle before it is published: unpacks it, loads the SDK with its own
// layerfs.node, creates a Store from a small folder (LayerFS Init) and reads a file back.
// Usage: node scripts/smoke-bundle.mjs <bundle.tar.gz>
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  Object.assign(process.env, {
    LAYERFS_NATIVE: join(bundle, "layerfs.node"), LAYERFS_BUNDLE: bundle, LAYERFS_SANDBOX: "native",
    LAYERFS_HOME: join(root, "home"), LAYERFS_STORE_PATH: join(store, "global", "store.sqlite"),
    LAYERFS_LOCAL_DIR: join(root, "local"), LAYERFS_DAEMON: join(bundle, "layerfs-daemon"),
  });
  const { LayerFS } = await import(pathToFileURL(join(bundle, "sdk/js/src/index.js")).href);
  const lfs = new LayerFS("smoke", {
    storePath: join(store, "global", "store.sqlite"), sandbox: "native", localDir: join(root, "local"),
    daemon: join(bundle, "layerfs-daemon"), containerPrefix: "smoke-",
  });
  const init = await lfs.project.init(src);
  const read = await lfs.fs.read("main", "/hello.txt");
  if (read.text !== "hello bundle\n") throw new Error(`read back ${JSON.stringify(read.text)}`);
  console.log(`bundle ok: init layer ${String(init.layer).slice(0, 12)}, read back hello.txt`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
