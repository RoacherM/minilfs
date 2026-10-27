// The LayerFS v1.1.0 native bundle (layerfs-daemon, layerfs.node, @layerfs/agent) that minilfs runs on.
// The LayerFS commit is pinned once, in layerfs.json; the default bundle folder is named after it
// (~/.cache/minilfs/bundle-<commit7>), so a new pin never replaces a bundle running sessions use.
// A first start on a new Mac downloads a prebuilt bundle from this repository's GitHub release,
// checks its sha256, and unpacks it atomically. scripts/setup-layerfs.sh still builds one from source.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsc, promises as fsp, readFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { acquireLock } from "./lock.ts";

/** Files minilfs needs from a bundle (@layerfs/agent imports only its own files and node:*; the store worker uses internal.js frames). */
export const BUNDLE_FILES = ["layerfs.node", "layerfs-daemon", "api/agent/sdk/src/index.js", "api/agent/sdk/src/internal.js"];

/** The LayerFS commit this minilfs runs on (layerfs.json; scripts/setup-layerfs.sh builds the same REF). */
export const LAYERFS_COMMIT: string = JSON.parse(readFileSync(new URL("../layerfs.json", import.meta.url), "utf8")).commit;

/** The default bundle folder for the pinned commit. */
export function defaultBundleDir(cacheRoot: string): string {
  return join(cacheRoot, `bundle-${LAYERFS_COMMIT.slice(0, 7)}`);
}

/** A problem text when `bundle` was built from another LayerFS commit (its BUILD-INFO.txt), else null. */
export async function bundleVersionProblem(bundle: string): Promise<string | null> {
  const info = await fsp.readFile(join(bundle, "BUILD-INFO.txt"), "utf8").catch(() => null);
  if (info === null) return null; // a hand-made bundle: its files were checked
  const m = /\b([0-9a-f]{7,40})\b/.exec(info);
  if (!m || LAYERFS_COMMIT.startsWith(m[1]) || m[1].startsWith(LAYERFS_COMMIT)) return null;
  return `the LayerFS bundle in ${bundle} is LayerFS ${m[1].slice(0, 12)}, but this minilfs needs ${LAYERFS_COMMIT.slice(0, 12)} (layerfs.json); remove MINILFS_BUNDLE to use the default folder, or rebuild with scripts/setup-layerfs.sh --bundle ${bundle}`;
}

/**
 * The prebuilt bundle per machine (`<platform>-<arch>`): its release URL and pinned sha256.
 * Written by the "LayerFS bundle" workflow (.github/workflows/bundle.yml), which builds the bundle
 * with scripts/setup-layerfs.sh on a macOS runner whenever that recipe changes.
 */
export const PREBUILT = JSON.parse(
  readFileSync(new URL("./bundle.json", import.meta.url), "utf8"),
) as Record<string, { tag: string; url: string; sha256: string }>;

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
  if (!(await missingBundleFiles(bundle)).length) return bundleVersionProblem(bundle);
  const key = `${platform()}-${arch()}`;
  const pre = PREBUILT[key];
  const build = `build one from source with scripts/setup-layerfs.sh --bundle ${bundle} in the minilfs repository (needs Rust)`;
  if (!pre) return `no prebuilt LayerFS bundle for ${key}; ${build}`;
  // the pinned release must be built from the commit this code needs (tag bundle-layerfs-<commit7>-<recipe>)
  if (!pre.tag.includes(`-${LAYERFS_COMMIT.slice(0, 7)}-`)) {
    return `the prebuilt LayerFS bundle for ${LAYERFS_COMMIT.slice(0, 7)} is not published yet (src/bundle.json pins ${pre.tag}); ${build}`;
  }
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
