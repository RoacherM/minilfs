// Who an agent is. Pure sandbox model: every agent (lead included) works only on its own LayerFS
// Branch, inside the sandbox; nothing runs on the real folder outside it. git commit/merge happen
// in the Branch's own `.git`, and Branches combine with LayerFS merge.
//
// Role: decided once, by the harness, when the agent starts.
//   lead    the top-level session: works on its Branch, merges sub-agent Branches, applies to the folder
//   worker  a sub-agent: works on its own Branch; reports its branch name; never applies
// Default is lead: a top-level session has no sub-agent markers.
import { basename, dirname, sep } from "node:path";

export type Role = "lead" | "worker";

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
