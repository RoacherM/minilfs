// The LayerFS native bundle (layerfs-daemon, layerfs.node, JS SDK) that minilfs runs on.
// A first start on a new Mac downloads a prebuilt bundle from this repository's GitHub release,
// checks its sha256, and unpacks it atomically. scripts/setup-layerfs.sh still builds one from source.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsc, promises as fsp } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { acquireLock } from "./lock.ts";

/** Files minilfs needs from a bundle. */
export const BUNDLE_FILES = ["layerfs.node", "layerfs-daemon", "sdk/js/src/index.js"];

/** The prebuilt bundle for this minilfs version (LayerFS 833acf7, see scripts/setup-layerfs.sh). */
export const PREBUILT = {
  "darwin-arm64": {
    url: "https://github.com/RoacherM/minilfs/releases/download/bundle-layerfs-833acf7/layerfs-bundle-darwin-arm64.tar.gz",
    sha256: "3203b9bfd9f738b0b398408ebfe7fd74906785afe94895224e1fbd067fbf51d8",
  },
} as Record<string, { url: string; sha256: string }>;

export async function missingBundleFiles(bundle: string): Promise<string[]> {
  const missing: string[] = [];
  for (const f of BUNDLE_FILES) {
    try { await fsp.access(join(bundle, f), fsc.R_OK); } catch { missing.push(join(bundle, f)); }
  }
  return missing;
}

/**
 * Makes sure `bundle` holds a LayerFS bundle: when files are missing, downloads the prebuilt one for
 * this machine, checks its sha256 and unpacks it in place (one process at a time). Returns a problem
 * text when it cannot (no prebuilt for this machine, offline, checksum mismatch), else null.
 */
export async function ensureBundle(bundle: string, log: (msg: string) => void = () => {}): Promise<string | null> {
  if (!(await missingBundleFiles(bundle)).length) return null;
  const key = `${platform()}-${arch()}`;
  const pre = PREBUILT[key];
  const build = "build one from source with scripts/setup-layerfs.sh in the minilfs repository (needs Rust)";
  if (!pre) return `no prebuilt LayerFS bundle for ${key}; ${build}`;
  const lock = await acquireLock(`${bundle}.lock`, 10 * 60_000);
  try {
    if (!(await missingBundleFiles(bundle)).length) return null; // another process installed it meanwhile
    log(`downloading the LayerFS bundle (${key}, ~8 MB)…`);
    const res = await fetch(pre.url).catch((e) => ({ ok: false, status: 0, statusText: String(e?.cause?.code ?? e?.message ?? e) }) as any);
    if (!res.ok) return `downloading the LayerFS bundle failed (${res.status || ""} ${res.statusText}) from ${pre.url}; check the network and retry, or ${build}`;
    const data = Buffer.from(await res.arrayBuffer());
    const got = createHash("sha256").update(data).digest("hex");
    if (got !== pre.sha256) return `the downloaded LayerFS bundle has sha256 ${got}, expected ${pre.sha256}; nothing was installed`;
    const parent = dirname(bundle);
    await fsp.mkdir(parent, { recursive: true });
    const stage = await fsp.mkdtemp(join(parent, ".bundle-"));
    try {
      const archive = join(stage, "bundle.tar.gz");
      await fsp.writeFile(archive, data);
      const out = join(stage, "out");
      await fsp.mkdir(out);
      const code = await new Promise<number | null>((done) => {
        const p = spawn("/usr/bin/tar", ["-xzf", archive, "-C", out], { stdio: "ignore" });
        p.on("error", () => done(-1));
        p.on("close", done);
      });
      if (code !== 0) return `unpacking the LayerFS bundle failed (tar exit ${code})`;
      if ((await missingBundleFiles(out)).length) return "the downloaded LayerFS bundle is incomplete; nothing was installed";
      // keep a partial or older bundle aside instead of deleting it
      const old = await fsp.lstat(bundle).catch(() => null);
      if (old) await fsp.rename(bundle, `${bundle}.old-${Date.now().toString(36)}`);
      await fsp.rename(out, bundle);
      log(`LayerFS bundle installed in ${bundle}`);
      return null;
    } finally {
      await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    }
  } finally {
    lock.release();
  }
}
