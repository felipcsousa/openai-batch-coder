import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { handleJsonRpcRequest } from "../src/mcp.js";

async function tempWorkspace() {
  return mkdtemp(path.join(tmpdir(), "batch-coder-mcp-test-"));
}

test("MCP handler lists batch-coder tools", async () => {
  const response = await handleJsonRpcRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  });

  assert.equal(response.id, 1);
  assert.ok(response.result.tools.some((tool) => tool.name === "batch_coder_status"));
  assert.ok(response.result.tools.some((tool) => tool.name === "batch_coder_enqueue"));
  assert.ok(response.result.tools.some((tool) => tool.name === "batch_coder_preflight_guidance"));
  assert.ok(response.result.tools.some((tool) => tool.name === "batch_coder_enqueue_plan"));
});

test("MCP preflight guidance returns agent-facing instructions", async () => {
  const response = await handleJsonRpcRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "batch_coder_preflight_guidance",
      arguments: {},
    },
  });

  assert.equal(response.id, 2);
  const text = response.result.content[0].text;
  assert.match(text, /Explore the repository/);
  assert.match(text, /batch_coder_enqueue_plan/);
});

test("MCP enqueue plan returns queued, skipped, warnings, and next step", async () => {
  const cwd = await tempWorkspace();
  await writeFile(path.join(cwd, "feature.js"), "export const value = 1;\n");

  const response = await handleJsonRpcRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "batch_coder_enqueue_plan",
      arguments: {
        cwd,
        openGoal: "Improve feature value behavior",
        subtasks: [
          {
            goal: "Change feature value source with explicit context",
            batchability: "batchable",
            files: ["feature.js"],
            fileNotes: { "feature.js": "Small localized source file." },
            baseSha: "abc123",
            rationale: "Batch can produce a patch from this static file.",
          },
          {
            goal: "Run exploratory debugging for unknown failures",
            batchability: "needs_interactive_codex",
            rationale: "Requires command iteration.",
          },
        ],
      },
    },
  });

  assert.equal(response.id, 3);
  const result = JSON.parse(response.result.content[0].text);
  assert.equal(result.queued.length, 1);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.warnings.length, 1);
  assert.match(result.nextStep, /batch-coder submit --dry-run/);
});
