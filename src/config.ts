import { homedir } from "node:os";
import { join } from "node:path";
import { defaultBundleDir } from "./bundle.ts";

export interface LayerfsConfig {
  /** false only when the user explicitly opts out with MINILFS=0 */
  enabled: boolean;
  /** runtime sandbox mode: native in-process layerfs.node + Seatbelt (sandbox-exec) on macOS */
  sandbox: "native";
  /** outbound network access policy inside bash: allow (default), localhost, or deny */
  network: "allow" | "localhost" | "deny";
  /** optional custom mount helper / script for native NFS loopback */
  nfsMount?: string;
  /** LayerFS v1.1.0 bundle: layerfs-daemon, layerfs.node, api/ (@layerfs/*), bin/layerfs */
  bundle: string;
  /** private state: LayerFS home, bindings, manifests, staging */
  root: string;
  /** prefix for local daemon config and names */
  prefix: string;
  /** host paths never imported into a session or overwritten by apply */
  excludes: string[];
  /** TERM -> KILL grace when cancelling a command */
  killGraceMs: number;
  /** env vars forwarded into commands (besides MINILFS_*) */
  envAllow: string[];
  /**
   * Paths that live only in LayerFS branches (build output, caches: e.g. target/, .cargo-home/):
   * never imported from the host, never seen by host sync (so a full sync does not delete them
   * from main), never written by apply. Visible to the agent inside its branch. Empty by default.
   */
  branchOnly: string[];
  /** team mode: agent-facing `minilfs` tool (+ `minilfs_apply` for the top-level session) */
  team: boolean;
  /** execution driver name: "native" (default local macOS NFSv3 + Seatbelt) or a custom registered remote/distributed sandbox driver */
  driver: string;
  /** logical branch name alias (e.g. lead, or from MINILFS_BRANCH_NAME) */
  branchName?: string;
  /**
   * First-import and host-sync limits: a folder above them is refused before the copy instead of
   * failing after minutes (Init is bounded by initTimeoutMs) or holding GBs in memory.
   */
  maxImportFiles: number;
  maxImportBytes: number;
  /** LayerFS Init timeout (LayerFS.init's `timeout`, ms; default the SDK's INIT_TIMEOUT_MS, 300 s) */
  initTimeoutMs?: number;
  /** invalid settings found by resolveConfig; a session refuses to start while any is set */
  problems?: string[];
  /**
   * Store calls through one store worker per root (default), so parallel agents (separate processes)
   * share one Store connection; false (`MINILFS_STORE_WORKER=0`): each process opens the Store itself.
   */
  storeWorker?: boolean;
  /** overall time limit of one bash call, seconds (MINILFS_BASH_TIMEOUT_S, default 600); the caller's smaller `timeout` wins */
  bashTimeoutS?: number;
  /** deadline of one workspace.unmount, ms (default UNMOUNT_DEADLINE_MS, 30 s; a seam for tests) */
  unmountDeadlineMs?: number;
}

export type MinilfsConfig = LayerfsConfig;

/** Secret files: never imported, read or written. `!pattern` re-includes (env templates hold no secrets). */
export const DEFAULT_EXCLUDES = [
  ".env", ".env.*", "!.env.example", "!.env.sample", "!.env.template", "!.env.dist", "!.env.defaults",
  "*.pem", "*.key", "id_rsa*", "id_ed25519*", ".npmrc", ".netrc", ".pypirc",
  // credentials often kept only by .gitignore (the whole folder is imported now, ignored files too)
  "*.p12", "*.pfx", "*.jks", "*.keystore", "*.kdbx", "credentials.json", "client_secret*.json",
  "service-account*.json", ".git-credentials",
];

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): LayerfsConfig {
  const problems: string[] = [];
  /** A positive whole number from the environment; undefined when unset; a bad value is a problem (start refuses), never NaN. */
  const positiveInt = (value: string | undefined, name: string): number | undefined => {
    if (value === undefined || value.trim() === "") return undefined;
    const n = Number(value);
    if (Number.isSafeInteger(n) && n > 0) return n;
    problems.push(`${name} must be a positive whole number, not ${JSON.stringify(value)}`);
    return undefined;
  };
  const list = (value: string | undefined, fallback: string[]) =>
    value === undefined ? fallback : value.split(",").map((s) => s.trim()).filter(Boolean);
  const netEnv = env.MINILFS_NETWORK;
  const network: "allow" | "localhost" | "deny" =
    netEnv === "deny" || netEnv === "offline"
      ? "deny"
      : netEnv === "localhost"
        ? "localhost"
        : "allow";
  return {
    enabled: env.MINILFS !== "0",
    sandbox: "native",
    driver: env.MINILFS_DRIVER ?? "native",
    network,
    nfsMount: env.MINILFS_NFS_MOUNT || undefined,
    bundle: env.MINILFS_BUNDLE || defaultBundleDir(join(homedir(), ".cache/minilfs")),
    root: env.MINILFS_ROOT ?? join(homedir(), ".cache/minilfs"),
    prefix: env.MINILFS_PREFIX ?? "minilfs-",
    excludes: list(env.MINILFS_EXCLUDES, DEFAULT_EXCLUDES),
    killGraceMs: Number(env.MINILFS_KILL_GRACE_MS ?? 2000),
    envAllow: list(env.MINILFS_ENV_ALLOW, ["TERM", "LANG", "LC_ALL", "CI", "NO_COLOR", "FORCE_COLOR"]),
    branchOnly: list(env.MINILFS_BRANCH_ONLY, []),
    storeWorker: env.MINILFS_STORE_WORKER !== "0",
    bashTimeoutS: positiveInt(env.MINILFS_BASH_TIMEOUT_S, "MINILFS_BASH_TIMEOUT_S") ?? 600,
    team: env.MINILFS_TEAM === "1",
    branchName: env.MINILFS_BRANCH_NAME || undefined,
    // the full folder is imported (.git and dependencies too): a node_modules alone is often 50-150k files
    maxImportFiles: positiveInt(env.MINILFS_MAX_IMPORT_FILES, "MINILFS_MAX_IMPORT_FILES") ?? 300_000,
    maxImportBytes: (positiveInt(env.MINILFS_MAX_IMPORT_MB, "MINILFS_MAX_IMPORT_MB") ?? 8192) * 1024 * 1024,
    initTimeoutMs: positiveInt(env.MINILFS_INIT_TIMEOUT_MS, "MINILFS_INIT_TIMEOUT_MS"),
    problems,
  };
}
