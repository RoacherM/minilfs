# minilfs

A Pi/Epi extension: each AI agent works on its own LayerFS Branch, runs bash in an NFS Workspace under macOS Seatbelt, and `apply` writes a Branch back to the user's folder. Design: `docs/ARCHITECTURE-AND-DECISIONS.md`.

## Development flow

Every feature or fix goes through spec → implement → review. The main session only coordinates and accepts. It sends each step to an Epi subagent (`task` tool, fresh context) and does not write specs or feature code itself. All three roles go through Magpie's `auto/` routing group:

| Step | `task` `model` | Deliverable | Done when |
| --- | --- | --- | --- |
| 1. spec | `magpie/auto/gemini-4-argon` (agent `reader`) | `docs/specs/<topic>-<date>.md`, committed by the main session | Each finding or feature has a design, its edge cases, and a regression test that fails now and passes after |
| 2. implement | `magpie/auto/claude-opus-5-5:high` (background) | One commit per spec step, not pushed | Each regression test was run before the fix (FAIL) and after (PASS), and the commit body says so; the full suite passes; deviations from the spec and why are in the commit body |
| 3. review | `magpie/auto/gpt-6-1-sol:high` (agent `reader`, read-only) | Verdict per finding, new findings with `file:line`, push-ready yes/no | No Blocker or Major |

- **Self-contained task packets**: the subagent cannot see the main session. Name the spec, the commit range (`<base>..HEAD`), the test commands below, and the files it must not touch.
- **Severity for reviews**: Major = can lose user data, break the user's repository, let a sandboxed agent escape or run code on the host, or kill an unrelated process in a realistic scenario. Theoretical issues, or ones that need a cooperating attacker inside the agent's own sandbox for no gain, are Minor. Paste this into every review packet.
- **Loop**: if the review has a Major, record it as a new § in `docs/issues/`, then write a new spec, implement it, and send it to a new reviewer. A residual risk that git itself shares (for example, the host running git during apply) can be accepted: document it in the code and the README, then tell the reviewer it is accepted.
- **Push** only once the reviewer says push-ready and the user agrees. Pushing to `main` triggers `.github/workflows/bundle.yml` when `layerfs.json` or the build scripts changed.
- **Model unavailable**: the `auto/` group already routes across channels. If a call still fails, stop and report; do not switch models quietly. If the user names another model, use it.
- Small changes (doc wording, one-line fixes) are made by the main session directly, followed by the tests they touch.

## Tests

- Integration suites need the LayerFS bundle: `MINILFS_BUNDLE=$HOME/.cache/minilfs-quarry/bundle-a700af8 node tests/<suite>.test.mjs`. The suites are the ones in `npm test`, plus `tests/concurrent-start.test.mjs` and `tests/worker-mount.smoke.mjs`.
- Run one review-fixes step with `MINILFS_TEST_ONLY=<regex>`. Wrap long runs in `perl -e 'alarm 1500; exec @ARGV' node …` and log to a file.
- Run the load check (import every module, `node src/cli.ts --help`) without `MINILFS_BUNDLE` exported.
- Afterwards, leave no test processes or mounts running, and delete leftovers under `~/.cache/minilfs-test`.

## Conventions

- TypeScript run by node ≥ 22 type stripping; there is no build step and no tsc.
- `src/gitapply.ts` holds the git-metadata apply transaction and must not import `src/workspace.ts`.
- Fix rounds leave `examples/`, `docs/replay/` and `src/bundle.json` alone (CI writes `src/bundle.json`).
- Code comments and commit messages are in English; commit subjects are imperative.
