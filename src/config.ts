import { homedir } from "node:os";
import { join } from "node:path";

export interface LayerfsConfig {
  /** false only when the user explicitly opts out with PI_LAYERFS=0 */
  enabled: boolean;
  /** runtime sandbox mode: native in-process layerfs.node + Seatbelt (sandbox-exec) on macOS */
  sandbox: "native";
  /** outbound network access policy inside bash: allow (default), localhost, or deny */
  network: "allow" | "localhost" | "deny";
  /** optional custom mount helper / script for native NFS loopback */
  nfsMount?: string;
  /** folder with layerfs-daemon, layerfs.node and sdk/js (built from source) */
  bundle: string;
  /** private state: LayerFS home, bindings, manifests, staging */
  root: string;
  /** prefix for local daemon config and names */
  prefix: string;
  /** host paths never imported into a session or overwritten by apply */
  excludes: string[];
  /** TERM -> KILL grace when cancelling a command */
  killGraceMs: number;
  /** env vars forwarded into commands (besides PI_*) */
  envAllow: string[];
  /**
   * Paths that live only in LayerFS branches (build output, caches: e.g. target/, .cargo-home/):
   * never imported from the host, never seen by host sync (so a full sync does not delete them
   * from main), never written by apply. Visible to the agent inside its branch. Empty by default.
   */
  branchOnly: string[];
  /** team mode: agent-facing `layerfs` tool (+ `layerfs_apply` for the top-level session) */
  team: boolean;
  /** execution driver name: "native" (default local macOS NFSv3 + Seatbelt) or a custom registered remote/distributed sandbox driver */
  driver: string;
  /** logical branch name alias (e.g. lead, or from PI_LAYERFS_BRANCH_NAME / MINILFS_BRANCH_NAME) */
  branchName?: string;
}

export const DEFAULT_EXCLUDES = [
  ".env", ".env.*", "*.pem", "*.key", "id_rsa*", "id_ed25519*", ".npmrc", ".netrc", ".pypirc",
];

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): LayerfsConfig {
  const list = (value: string | undefined, fallback: string[]) =>
    value === undefined ? fallback : value.split(",").map((s) => s.trim()).filter(Boolean);
  const netEnv = env.MINILFS_NETWORK ?? env.PI_LAYERFS_NETWORK;
  const network: "allow" | "localhost" | "deny" =
    netEnv === "deny" || netEnv === "offline"
      ? "deny"
      : netEnv === "localhost"
        ? "localhost"
        : "allow";
  const defaultBundle = join(homedir(), ".cache/epi-layerfs/bundle-native");
  return {
    enabled: (env.MINILFS ?? env.PI_LAYERFS) !== "0",
    sandbox: "native",
    driver: env.MINILFS_DRIVER ?? env.PI_LAYERFS_DRIVER ?? "native",
    network,
    nfsMount: env.MINILFS_NFS_MOUNT || env.PI_LAYERFS_NFS_MOUNT || undefined,
    bundle: env.MINILFS_BUNDLE ?? env.PI_LAYERFS_BUNDLE ?? defaultBundle,
    root: env.MINILFS_ROOT ?? env.PI_LAYERFS_ROOT ?? join(homedir(), ".cache/pi-layerfs"),
    prefix: env.MINILFS_PREFIX ?? env.PI_LAYERFS_PREFIX ?? "pi-lfs-",
    excludes: list(env.MINILFS_EXCLUDES ?? env.PI_LAYERFS_EXCLUDES, DEFAULT_EXCLUDES),
    killGraceMs: Number(env.MINILFS_KILL_GRACE_MS ?? env.PI_LAYERFS_KILL_GRACE_MS ?? 2000),
    envAllow: list(env.MINILFS_ENV_ALLOW ?? env.PI_LAYERFS_ENV_ALLOW, ["TERM", "LANG", "LC_ALL", "CI", "NO_COLOR", "FORCE_COLOR"]),
    branchOnly: list(env.MINILFS_BRANCH_ONLY ?? env.PI_LAYERFS_BRANCH_ONLY, []),
    team: (env.MINILFS_TEAM ?? env.PI_LAYERFS_TEAM) === "1",
    branchName: env.MINILFS_BRANCH_NAME || env.PI_LAYERFS_BRANCH_NAME || undefined,
  };
}
