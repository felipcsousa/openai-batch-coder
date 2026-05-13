import {
  applyCommand,
  enqueueCommand,
  enqueuePlanCommand,
  pollCommand,
  preflightGuidanceCommand,
  reviewCommand,
  statusCommand,
  submitCommand,
} from "./commands.js";

const tools = [
  {
    name: "batch_coder_enqueue",
    description: "Queue a well-scoped coding task for OpenAI Batch patch generation.",
    inputSchema: {
      type: "object",
      required: ["goal", "files"],
      properties: {
        cwd: { type: "string" },
        goal: { type: "string" },
        files: { type: "array", items: { type: "string" } },
        checks: { type: "array", items: { type: "string" } },
        baseSha: { type: "string" },
        candidates: { type: "integer", minimum: 1, maximum: 8 },
        model: { type: "string" },
      },
    },
  },
  {
    name: "batch_coder_preflight_guidance",
    description: "Return guidance for the current Codex agent before decomposing an open request into Batch Coder subtasks.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "batch_coder_enqueue_plan",
    description: "Queue multiple agent-prepared, batchable subtasks and return skipped interactive work separately.",
    inputSchema: {
      type: "object",
      required: ["openGoal", "subtasks"],
      properties: {
        cwd: { type: "string" },
        openGoal: { type: "string" },
        subtasks: {
          type: "array",
          items: {
            type: "object",
            required: ["goal", "batchability"],
            properties: {
              goal: { type: "string" },
              batchability: { type: "string", enum: ["batchable", "needs_interactive_codex"] },
              files: { type: "array", items: { type: "string" } },
              fileNotes: { type: "object", additionalProperties: { type: "string" } },
              checks: { type: "array", items: { type: "string" } },
              baseSha: { type: "string" },
              candidates: { type: "integer", minimum: 1, maximum: 8 },
              rationale: { type: "string" },
            },
          },
        },
      },
    },
  },
  {
    name: "batch_coder_submit",
    description: "Submit queued tasks to the OpenAI Batch API, or build a dry-run JSONL file.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        model: { type: "string" },
        dryRun: { type: "boolean" },
        allowSensitive: { type: "boolean" },
        baseUrl: { type: "string" },
      },
    },
  },
  {
    name: "batch_coder_poll",
    description: "Poll active OpenAI batches and import completed candidates.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        baseUrl: { type: "string" },
      },
    },
  },
  {
    name: "batch_coder_apply",
    description: "Apply a ready patch candidate into an isolated git worktree.",
    inputSchema: {
      type: "object",
      required: ["taskId"],
      properties: {
        cwd: { type: "string" },
        taskId: { type: "string" },
        candidateIndex: { type: "integer" },
      },
    },
  },
  {
    name: "batch_coder_review",
    description: "Run configured checks for an applied candidate.",
    inputSchema: {
      type: "object",
      required: ["taskId"],
      properties: {
        cwd: { type: "string" },
        taskId: { type: "string" },
        candidateIndex: { type: "integer" },
      },
    },
  },
  {
    name: "batch_coder_status",
    description: "Read local batch-coder queue, batch, and candidate state.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
      },
    },
  },
];

function content(result) {
  return [{ type: "text", text: JSON.stringify(result, null, 2) }];
}

async function callTool(name, args = {}) {
  switch (name) {
    case "batch_coder_enqueue":
      return enqueueCommand({
        cwd: args.cwd,
        goal: args.goal,
        files: args.files,
        checks: args.checks ?? [],
        baseSha: args.baseSha,
        candidates: args.candidates,
        model: args.model,
      });
    case "batch_coder_preflight_guidance":
      return preflightGuidanceCommand();
    case "batch_coder_enqueue_plan":
      return enqueuePlanCommand({
        cwd: args.cwd,
        openGoal: args.openGoal,
        subtasks: args.subtasks,
      });
    case "batch_coder_submit":
      return submitCommand({
        cwd: args.cwd,
        model: args.model,
        dryRun: args.dryRun ?? false,
        allowSensitive: args.allowSensitive ?? false,
        baseUrl: args.baseUrl,
      });
    case "batch_coder_poll":
      return pollCommand({ cwd: args.cwd, baseUrl: args.baseUrl });
    case "batch_coder_apply":
      return applyCommand({ cwd: args.cwd, taskId: args.taskId, candidateIndex: args.candidateIndex ?? 1 });
    case "batch_coder_review":
      return reviewCommand({ cwd: args.cwd, taskId: args.taskId, candidateIndex: args.candidateIndex ?? 1 });
    case "batch_coder_status":
      return statusCommand({ cwd: args.cwd });
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

export async function handleJsonRpcRequest(request) {
  try {
    if (request.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "codex-batch-coder", version: "0.1.0" },
        },
      };
    }
    if (request.method === "tools/list") {
      return { jsonrpc: "2.0", id: request.id, result: { tools } };
    }
    if (request.method === "tools/call") {
      const result = await callTool(request.params?.name, request.params?.arguments ?? {});
      return { jsonrpc: "2.0", id: request.id, result: { content: content(result) } };
    }
    if (request.id === undefined) {
      return undefined;
    }
    return {
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: `method not found: ${request.method}` },
    };
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32000, message: error.message },
    };
  }
}

export async function runMcpServer({ input = process.stdin, output = process.stdout } = {}) {
  let buffer = "";
  input.setEncoding("utf8");
  for await (const chunk of input) {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) {
        continue;
      }
      const response = await handleJsonRpcRequest(JSON.parse(line));
      if (response) {
        output.write(`${JSON.stringify(response)}\n`);
      }
    }
  }
}
