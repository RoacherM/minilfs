// Who an agent is, and what the main agent may do outside its Branch.
//
// Role: decided once, by the harness, when the agent starts.
//   lead    the top-level session: works on its Branch, may apply and run elevated commands
//   worker  a sub-agent: works on its own Branch; never applies, never elevates
// Default is lead: a top-level session has no sub-agent markers.
//
// Elevation: one bash command runs on the real folder, outside the Branch and its sandbox.
//   auto  (default) the main agent elevates when it judges it needs to, without asking
//   ask   the user confirms each elevated command (a command-prefix allow list skips the dialog)
//   never no elevation
import { basename, dirname, sep } from "node:path";

export type Role = "lead" | "worker";
export type ElevatePolicy = "auto" | "ask" | "never";

export interface RoleInfo {
  role: Role;
  /** why this role was chosen (shown in /minilfs status) */
  source: string;
  /** stable branch name for a worker, from the harness's own task id */
  branchName?: string;
}

/**
 * - MINILFS_ROLE=lead|worker forces the role.
 * - Pi sub-agents: PI_SUBAGENT_CHILD=1.
 * - Epi tasks: EPI_TASK_JOB_ID (requested from Epi), else the task session file
 *   `<epiHome>/runtime/task/sessions/<jobId>.jsonl` (Epi's internal layout; a fallback only).
 */
export function resolveRole(opts: { env?: NodeJS.ProcessEnv; sessionFile?: string; sessionId?: string } = {}): RoleInfo {
  const env = opts.env ?? process.env;
  const forced = env.MINILFS_ROLE;
  if (forced === "lead") return { role: "lead", source: "MINILFS_ROLE" };
  if (forced === "worker") return { role: "worker", source: "MINILFS_ROLE", branchName: env.MINILFS_BRANCH_NAME || undefined };
  if (env.EPI_TASK_JOB_ID) return { role: "worker", source: "EPI_TASK_JOB_ID", branchName: `task-${env.EPI_TASK_JOB_ID}` };
  const file = opts.sessionFile ?? "";
  if (file) {
    const dir = dirname(file);
    const parts = dir.split(sep);
    const n = parts.length;
    if (n >= 3 && parts[n - 1] === "sessions" && parts[n - 2] === "task" && parts[n - 3] === "runtime") {
      return { role: "worker", source: "Epi task session", branchName: `task-${basename(file).replace(/\.jsonl$/, "")}` };
    }
    // a session under an Epi runtime folder we do not recognise: isolate rather than guess lead
    if (parts.includes("runtime") && parts.includes("task")) return { role: "worker", source: "unrecognised task runtime path" };
  }
  if (env.PI_SUBAGENT_CHILD === "1") return { role: "worker", source: "PI_SUBAGENT_CHILD", branchName: env.MINILFS_BRANCH_NAME || undefined };
  return { role: "lead", source: "top-level session" };
}

export function elevatePolicy(env: NodeJS.ProcessEnv = process.env, flag?: unknown): ElevatePolicy {
  const v = String(flag || env.MINILFS_ELEVATE || "auto").toLowerCase();
  return v === "ask" || v === "never" ? v : "auto";
}

/** `MINILFS_ELEVATE_ALLOW="git *,docker *"`: commands that need no confirmation under `ask`. */
export function elevateAllowed(command: string, env: NodeJS.ProcessEnv = process.env, extra: string[] = []): boolean {
  const patterns = [...String(env.MINILFS_ELEVATE_ALLOW ?? "").split(","), ...extra].map((p) => p.trim()).filter(Boolean);
  const cmd = command.trim();
  return patterns.some((p) => (p.endsWith("*") ? cmd.startsWith(p.slice(0, -1).trimEnd()) : cmd === p));
}

export const ELEVATE_PARAM_DESCRIPTIONS = {
  elevated: "Run this one command on the user's real project folder, outside your minilfs Branch and its sandbox (host PATH, permissions, network, .git). Use it when the sandbox blocks the step (\"Operation not permitted\"), for git commit/push/checkout, Docker, mounts, setuid tools like ps, or long-running services. Before it runs, your Branch's unapplied changes are written to the folder; afterwards the folder's changes come back into your Branch. File tools never need this.",
  reason: "Required with elevated: one sentence on why this command must run on the real folder (shown to the user, recorded in history).",
} as const;
