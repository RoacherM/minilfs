// Workspace mode: where an agent's file tools and bash act.
//
//   branch (default)  the session's isolated minilfs Branch; the host folder changes only by apply.
//   host              the real project folder, without the Branch layer and without the minilfs
//                     Seatbelt profile. For work a Branch cannot do: nested sandboxes, mounts,
//                     privileged or setuid tools, long-running host services, very large folders.
//
// Switching keeps the two sides consistent instead of letting them drift:
//   branch -> host  refused while the Branch has unapplied changes (apply them first, or pass
//                   discard), so host work starts from everything the Branch did.
//   host -> branch  host edits are synced into main, then main is merged into the Branch, so the
//                   Branch continues from everything done on the host.
import type { LayerfsSession } from "../workspace.ts";

export type WorkspaceMode = "branch" | "host";

export const MODE_TOOL_NAME = "workspace_mode";

export const MODE_TOOL_DESCRIPTION =
  "Switch where your file tools and bash act. Default is mode=\"branch\": an isolated minilfs Branch; the user's folder changes only through minilfs_apply. " +
  "Switch to mode=\"host\" only when the Branch cannot do the job: a nested sandbox (sandbox-exec, Docker, VMs), mounts, setuid or privileged tools, " +
  "a dev server or daemon that must outlive one bash call, or testing minilfs itself. In host mode your edits land in the user's folder immediately, with no isolation and no undo. " +
  "Switching to host is refused while the Branch has unapplied changes (apply them, or pass discard=true). Switching back to branch brings your host edits into the Branch. " +
  "Give a short reason; it is shown to the user. Switch back as soon as the host-only step is done.";

export const MODE_TOOL_SCHEMA = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["branch", "host", "status"], description: "branch (isolated, default) | host (real folder) | status" },
    reason: { type: "string", description: "why the switch is needed (shown to the user)" },
    discard: { type: "boolean", description: "switch to host even though the Branch has unapplied changes; they stay on the Branch, unapplied" },
  },
  required: ["mode"],
  additionalProperties: false,
} as const;

export interface ModeSwitchResult { ok: boolean; mode: WorkspaceMode; message: string }

/** `MINILFS_MODE=host` starts in host mode; anything else starts on the Branch. */
export function initialMode(env: NodeJS.ProcessEnv = process.env): WorkspaceMode {
  return env.MINILFS_MODE === "host" ? "host" : "branch";
}

/**
 * Who may move an agent to host mode (the user can always switch with /minilfs mode).
 *   ask     (default) the agent asks; the user confirms each switch. Without a UI it is refused.
 *   auto    the agent switches on its own when it judges the Branch cannot do the job.
 *   bypass  every session starts in host mode and the agent switches freely ("bypass permissions").
 *   never   the agent cannot leave the Branch.
 */
export type HostPolicy = "ask" | "auto" | "bypass" | "never";

export function hostPolicy(env: NodeJS.ProcessEnv = process.env, flag?: unknown): HostPolicy {
  const v = String(flag || env.MINILFS_HOST_POLICY || "ask").toLowerCase();
  return v === "auto" || v === "bypass" || v === "never" ? v : "ask";
}

/**
 * Validates and performs a switch. `session` is null when minilfs did not start; then only host
 * mode is possible and switching to branch reports why.
 */
export async function switchMode(
  session: LayerfsSession | null,
  current: WorkspaceMode,
  target: WorkspaceMode,
  options: { reason?: string; discard?: boolean; startError?: string | null } = {},
): Promise<ModeSwitchResult> {
  const why = options.reason ? ` (${options.reason})` : "";
  if (target === current) {
    return { ok: true, mode: current, message: `Already in ${current} mode.` };
  }
  if (target === "host") {
    // a stale "unapplied" (the folder already has the same bytes, e.g. after git pull) is no reason to refuse
    if (session && session.unapplied && !options.discard && !(await session.pendingAlreadyOnHost().catch(() => false))) {
      return {
        ok: false, mode: current,
        message: `Refused: the Branch ${session.workBranch} has unapplied changes. Host work would start without them and the two would diverge. ` +
          "Run minilfs_apply first (or switch with discard=true to leave them unapplied on the Branch).",
      };
    }
    const kept = session?.unapplied ? ` Unapplied changes stay on ${session.workBranch}.` : "";
    return {
      ok: true, mode: "host",
      message: `Now in host mode${why}: file tools and bash act directly on ${session?.cwd ?? "the user's folder"}, without isolation.${kept} Switch back with mode="branch" when done.`,
    };
  }
  // host -> branch
  if (!session) {
    return { ok: false, mode: current, message: `Cannot switch to branch mode: minilfs is not running${options.startError ? ` (${options.startError})` : ""}. Fix it and run /minilfs retry.` };
  }
  const drift = await session.syncHostDriftIntoMain();
  const list = `${drift.synced.slice(0, 5).join(", ")}${drift.synced.length > 5 ? ", …" : ""}`;
  // Usual case: nothing unapplied on the Branch (host mode required that). Start a fresh Branch from
  // main, so host edits become the new base: they are already in the folder, nothing to apply.
  if (await session.restartFromMain()) {
    const brought = drift.synced.length ? ` It includes your ${drift.synced.length} host edit(s) (${list}).` : "";
    return { ok: true, mode: "branch", message: `Back in branch mode${why} on a fresh Branch ${session.workBranch} from main.${brought}` };
  }
  // Entered host mode with discard=true: keep the Branch work and merge the host edits into it.
  let merged = "";
  if (drift.synced.length) {
    const r = await session.mergeBranch("main");
    if (!r.merged) {
      return {
        ok: false, mode: current,
        message: `Host edits (${drift.synced.length} file(s)) are in main, but merging main into ${session.workBranch} conflicts on: ` +
          `${r.conflicts.map((c) => c.path).slice(0, 10).join(", ")}. Still in host mode. Resolve with minilfs action=merge branch=main strategy=theirs|ours, then switch again.`,
      };
    }
    merged = ` Merged ${drift.synced.length} host edit(s) into it (${list}).`;
  }
  return { ok: true, mode: "branch", message: `Back in branch mode${why} on ${session.workBranch}.${merged}` };
}
