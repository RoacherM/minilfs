import { homedir } from "node:os";
import { join } from "node:path";

export interface LayerfsConfig {
  /** false only when the user explicitly opts out with MINILFS=0 */
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
}

export type MinilfsConfig = LayerfsConfig;

export const DEFAULT_EXCLUDES = [
  ".env", ".env.*", "*.pem", "*.key", "id_rsa*", "id_ed25519*", ".npmrc", ".netrc", ".pypirc",
];

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): LayerfsConfig {
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
    bundle: env.MINILFS_BUNDLE ?? join(homedir(), ".cache/minilfs/bundle-native"),
    root: env.MINILFS_ROOT ?? join(homedir(), ".cache/minilfs"),
    prefix: env.MINILFS_PREFIX ?? "minilfs-",
    excludes: list(env.MINILFS_EXCLUDES, DEFAULT_EXCLUDES),
    killGraceMs: Number(env.MINILFS_KILL_GRACE_MS ?? 2000),
    envAllow: list(env.MINILFS_ENV_ALLOW, ["TERM", "LANG", "LC_ALL", "CI", "NO_COLOR", "FORCE_COLOR"]),
    branchOnly: list(env.MINILFS_BRANCH_ONLY, []),
    team: env.MINILFS_TEAM === "1",
    branchName: env.MINILFS_BRANCH_NAME || undefined,
  };
}
