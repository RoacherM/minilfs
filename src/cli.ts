#!/usr/bin/env node
// Universal CLI & MCP Server for `@roacherm/minilfs` (Claude Code, Codex, Cursor, DSH, Shell).
// Zero Pi/Epi dependencies — built directly on `src/core/index.ts`.
//
// Commands:
//   minilfs mcp                        Start stdio MCP server (for Claude Code / Codex / Cursor)
//   minilfs exec [--branch B] -- <cmd> Run a shell command on a LayerFS branch inside macOS Seatbelt
//   minilfs status | diff | branches | show | ls | checkout | sync | merge | apply | history | clean
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import {
  executeLayerfsAction,
  executeLayerfsApply,
  formatHistory,
  LAYERFS_APPLY_TOOL_DESCRIPTION,
  LAYERFS_APPLY_TOOL_SCHEMA,
  LAYERFS_TOOL_DESCRIPTION,
  LAYERFS_TOOL_SCHEMA,
  LayerfsSession,
  loadHistory,
  resolveConfig,
} from "./core/index.ts";

async function openCliSession(cwd = process.cwd(), branchName?: string): Promise<LayerfsSession> {
  const config = resolveConfig({
    ...process.env,
    ...(branchName ? { MINILFS_BRANCH_NAME: branchName } : {}),
  });
  const sessionId = process.env.MINILFS_SESSION_ID || branchName || "cli-default";
  const s = new LayerfsSession(cwd, sessionId, config);
  await s.open({ reason: "resume" });
  return s;
}

async function runMcpServer(): Promise<void> {
  const cwd = process.cwd();
  const branchName = process.env.MINILFS_BRANCH_NAME;
  const isChild = process.env.PI_SUBAGENT_CHILD === "1";
  let sessionPromise: Promise<LayerfsSession> | null = null;
  const getSession = () => (sessionPromise ??= openCliSession(cwd, branchName));

  const tools = [
    {
      name: "layerfs",
      description: LAYERFS_TOOL_DESCRIPTION,
      inputSchema: LAYERFS_TOOL_SCHEMA,
    },
    ...(!isChild
      ? [
          {
            name: "layerfs_apply",
            description: LAYERFS_APPLY_TOOL_DESCRIPTION,
            inputSchema: LAYERFS_APPLY_TOOL_SCHEMA,
          },
        ]
      : []),
    {
      name: "layerfs_bash",
      description: "Run a shell command on your isolated LayerFS branch inside the macOS Seatbelt sandbox, automatically committing changes.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
          timeout: { type: "integer", description: "Optional timeout in seconds" },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  ];

  const send = (msg: unknown) => {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  };

  const rl = createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let req: any;
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    const { id, method, params } = req;
    if (id === undefined) continue; // notification

    try {
      if (method === "initialize") {
        send({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: params?.protocolVersion || "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "minilfs", version: "0.4.0" },
          },
        });
        continue;
      }
      if (method === "tools/list") {
        send({ jsonrpc: "2.0", id, result: { tools } });
        continue;
      }
      if (method === "tools/call") {
        const s = await getSession();
        const name = params?.name;
        const args = params?.arguments ?? {};
        if (name === "layerfs") {
          const out = await executeLayerfsAction(s, args);
          send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: out }] } });
          continue;
        }
        if (name === "layerfs_apply") {
          const out = await executeLayerfsApply(s);
          send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: out }] } });
          continue;
        }
        if (name === "layerfs_bash") {
          const chunks: Buffer[] = [];
          const r = await s.mutate(`mcp-${id}`, "bash", () =>
            s.exec(String(args.command ?? ""), s.cwd, {
              onData: (d) => chunks.push(d),
              timeout: typeof args.timeout === "number" ? args.timeout : undefined,
            }),
          );
          const output = Buffer.concat(chunks).toString("utf8");
          const isError = (r.value.exitCode ?? 0) !== 0;
          send({
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: output || `(exit ${r.value.exitCode ?? 0})` }],
              isError,
            },
          });
          continue;
        }
        throw new Error(`Unknown tool: ${name}`);
      }
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
    } catch (e: any) {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: `Error: ${e?.message ?? e}` }],
          isError: true,
        },
      });
    }
  }
  if (sessionPromise) {
    const s = await sessionPromise.catch(() => null);
    await s?.close().catch(() => {});
  }
}

async function main() {
  const argv = process.argv.slice(2);
  let branchName: string | undefined;
  let cwd = process.cwd();
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      rest.push("--", ...argv.slice(i + 1));
      break;
    }
    if (a === "--branch" || a === "-b") {
      branchName = argv[++i];
    } else if (a === "--cwd" || a === "-C") {
      cwd = resolve(argv[++i]);
    } else {
      rest.push(a);
    }
  }

  const sub = rest[0] || "status";
  if (sub === "-h" || sub === "--help" || sub === "help") {
    console.log([
      "Usage: minilfs [--branch <alias>] [--cwd <dir>] <command> [args...]",
      "",
      "Commands:",
      "  mcp                            Start stdio MCP server (for Claude Code / Codex / Cursor)",
      "  exec -- <command...>           Run a shell command in the isolated LayerFS branch + Seatbelt",
      "  status                         Show current branch, alias, head, and unapplied state",
      "  diff [branch] [base]           List changed source files",
      "  branches                       List active branches with aliases",
      "  ls [branch] [path]             List directory entries on a branch",
      "  show <branch> <path> [offset]  Show file contents from a branch",
      "  checkout <branch> <path...>    Copy file(s) or directory from a branch into yours",
      "  sync [branch] [--ours|--theirs] Merge main (or <branch>) into your branch",
      "  merge <branch> [--ours|--theirs] Merge <branch> into your branch",
      "  apply                          3-way checked write back to host folder",
      "  history [limit]                Show branch commit history",
      "  clean                          Remove project scratch build caches",
    ].join("\n"));
    return;
  }

  if (sub === "mcp") {
    await runMcpServer();
    return;
  }

  const s = await openCliSession(cwd, branchName);
  try {
    if (sub === "exec" || sub === "run") {
      const dashIdx = rest.indexOf("--");
      const cmdParts = dashIdx >= 0 ? rest.slice(dashIdx + 1) : rest.slice(1);
      const command = cmdParts.join(" ");
      if (!command) throw new Error("Usage: minilfs exec -- <command...>");
      const r = await s.mutate("cli-exec", "bash", () =>
        s.exec(command, s.cwd, { onData: (d) => process.stdout.write(d) }),
      );
      process.exitCode = r.value.exitCode ?? 0;
      return;
    }
    if (sub === "apply") {
      console.log(await executeLayerfsApply(s));
      return;
    }
    if (sub === "history") {
      const limit = Number(rest[1] ?? 20);
      console.log(formatHistory(await loadHistory(s, Number.isFinite(limit) && limit > 0 ? limit : 20)));
      return;
    }
    const strategy = rest.includes("--theirs") ? "theirs" : rest.includes("--ours") ? "ours" : undefined;
    const positional = rest.slice(1).filter((a) => a !== "--theirs" && a !== "--ours");
    if (sub === "status" || sub === "branches" || sub === "clean") {
      console.log(await executeLayerfsAction(s, { action: sub }));
      return;
    }
    if (sub === "diff") {
      console.log(await executeLayerfsAction(s, { action: "diff", branch: positional[0], base: positional[1] }));
      return;
    }
    if (sub === "ls") {
      console.log(await executeLayerfsAction(s, { action: "ls", branch: positional.length > 1 ? positional[0] : undefined, path: positional.at(-1) }));
      return;
    }
    if (sub === "show") {
      console.log(
        await executeLayerfsAction(s, {
          action: "show",
          branch: positional[0],
          path: positional[1],
          offset: positional[2] ? Number(positional[2]) : undefined,
          limit: positional[3] ? Number(positional[3]) : undefined,
        }),
      );
      return;
    }
    if (sub === "checkout") {
      console.log(await executeLayerfsAction(s, { action: "checkout", branch: positional[0], paths: positional.slice(1) }));
      return;
    }
    if (sub === "sync" || sub === "merge") {
      console.log(await executeLayerfsAction(s, { action: sub, branch: positional[0], strategy }));
      return;
    }
    throw new Error(`Unknown command: ${sub}`);
  } finally {
    await s.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error(`minilfs: ${e?.message ?? e}`);
  process.exit(1);
});
