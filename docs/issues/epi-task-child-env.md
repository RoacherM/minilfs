# Epi issue draft: let extensions in a task worker know they are a task (job id, parent session)

**Title:** task workers: expose `EPI_TASK_JOB_ID` / `EPI_TASK_PARENT_SESSION` to the child process, and a read-only task lifecycle event for extensions

## Problem

A third-party Manifest extension is loaded in task workers by default (`dist/worker.js:317`, `additionalExtensionPaths`), which is good. But inside the worker the extension cannot tell that it runs as a subagent, or which job it is:

- The child env is `{ ...process.env, PI_CODING_AGENT_DIR }` (`dist/task-runtime.js:594-596`); no job id, no parent session.
- The only signal today is the session file path `<epiHome>/runtime/task/sessions/<jobId>.jsonl`, an internal layout that can change.

Use case: minilfs (LayerFS isolation) gives every subagent its own branch named after the job, and must not give subagents the parent's privileges (writing the user's folder, elevated commands). Getting the role wrong either isolates the main session or lets a subagent write the real folder.

On the parent side, extensions can observe `task_stop` only through the hooks bridge channel `epi/hooks/task/v1` (`dist/hook-events.js`), whose `request.run` slot belongs to `epi:hooks`; an extension that sets it breaks task settlement (`dist/extensions/task.js:424-427`).

## Request

1. Set in the worker's environment:
   - `EPI_TASK_JOB_ID=<full job uuid>`
   - `EPI_TASK_PARENT_SESSION=<parent session id or file>`
   (and keep them out of the parent's env).
2. A documented, read-only lifecycle event for extensions in the parent, e.g. `pi.events` channel `epi/task/v1` with `{ type: "start" | "stop", job: { id, status, cwd, sessionPath } }`, separate from the hooks decision bridge.

## Compatibility

Additive: new env vars and a new event channel; nothing existing changes.
