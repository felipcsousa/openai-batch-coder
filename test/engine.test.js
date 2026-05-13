import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildBatchJsonl } from "../src/batch.js";
import { enqueuePlanCommand } from "../src/commands.js";
import { enqueueTask, loadState } from "../src/queue.js";
import { parseBatchOutputLine } from "../src/results.js";
import { scanManifestForSensitiveData } from "../src/privacy.js";

async function tempWorkspace() {
  return mkdtemp(path.join(tmpdir(), "batch-coder-test-"));
}

test("enqueueTask stores a localized task with base SHA, manifest, and candidate count", async () => {
  const cwd = await tempWorkspace();
  await writeFile(path.join(cwd, "feature.js"), "export const value = 1;\n");

  const task = await enqueueTask({
    cwd,
    goal: "Change value to 2",
    files: ["feature.js"],
    checks: ["npm test"],
    baseSha: "abc123",
    candidates: 2,
  });

  assert.equal(task.status, "queued");
  assert.equal(task.baseSha, "abc123");
  assert.equal(task.candidates, 2);
  assert.deepEqual(task.files, ["feature.js"]);
  assert.equal(task.manifest.files[0].path, "feature.js");

  const state = await loadState(cwd);
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].id, task.id);
});

test("scanManifestForSensitiveData blocks sensitive filenames and token-like content", async () => {
  const findings = scanManifestForSensitiveData({
    files: [
      { path: ".env", content: "OPENAI_API_KEY=sk-test" },
      { path: "src/app.js", content: "const token = 'ghp_1234567890abcdefghijklmnopqrstuv';" },
    ],
  });

  assert.equal(findings.length, 2);
  assert.equal(findings[0].kind, "sensitive_path");
  assert.equal(findings[1].kind, "sensitive_content");
});

test("buildBatchJsonl emits one Responses request per candidate with stable custom IDs", async () => {
  const task = {
    id: "task_1",
    goal: "Change value",
    baseSha: "abc123",
    checks: ["npm test"],
    candidates: 2,
    manifest: {
      files: [{ path: "feature.js", content: "export const value = 1;\n" }],
    },
  };

  const jsonl = buildBatchJsonl({ tasks: [task], model: "gpt-5.4" });
  const lines = jsonl.trim().split("\n").map((line) => JSON.parse(line));

  assert.equal(lines.length, 2);
  assert.equal(lines[0].custom_id, "task_1:candidate:1");
  assert.equal(lines[0].url, "/v1/responses");
  assert.equal(lines[0].body.model, "gpt-5.4");
  assert.match(lines[0].body.instructions, /JSON object/);
  assert.match(JSON.stringify(lines[0].body.input), /feature.js/);
});

test("parseBatchOutputLine extracts and validates structured patch candidate output", () => {
  const candidate = {
    summary: "Updates feature value",
    confidence: 0.82,
    unified_diff: "diff --git a/feature.js b/feature.js\n--- a/feature.js\n+++ b/feature.js\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
    files_changed: ["feature.js"],
    tests: ["npm test"],
    risks: ["Low coverage"],
    needs_interactive_codex: false,
  };
  const line = JSON.stringify({
    custom_id: "task_1:candidate:1",
    response: { body: { output_text: JSON.stringify(candidate) } },
    error: null,
  });

  const parsed = parseBatchOutputLine(line);

  assert.equal(parsed.taskId, "task_1");
  assert.equal(parsed.candidateIndex, 1);
  assert.equal(parsed.status, "ready");
  assert.deepEqual(parsed.candidate.files_changed, ["feature.js"]);
});

test("parseBatchOutputLine marks malformed model output invalid_output", () => {
  const line = JSON.stringify({
    custom_id: "task_1:candidate:1",
    response: { body: { output_text: "not json" } },
    error: null,
  });

  const parsed = parseBatchOutputLine(line);

  assert.equal(parsed.status, "invalid_output");
  assert.match(parsed.error.message, /valid JSON/);
});

test("CLI status can read a queued task", async () => {
  const cwd = await tempWorkspace();
  await writeFile(path.join(cwd, "feature.js"), "export const value = 1;\n");
  await enqueueTask({
    cwd,
    goal: "Change value to 2",
    files: ["feature.js"],
    baseSha: "abc123",
  });

  const stateFile = path.join(cwd, ".batch-coder", "state.json");
  const raw = await readFile(stateFile, "utf8");

  assert.match(raw, /Change value to 2/);
});

test("enqueuePlanCommand queues batchable subtasks and writes preflight audit artifact", async () => {
  const cwd = await tempWorkspace();
  await writeFile(path.join(cwd, "feature.js"), "export const value = 1;\n");
  await writeFile(path.join(cwd, "feature.test.js"), "test('placeholder', () => {});\n");

  const result = await enqueuePlanCommand({
    cwd,
    openGoal: "Improve the feature value flow",
    subtasks: [
      {
        goal: "Change value export to support the new flow",
        batchability: "batchable",
        files: ["feature.js"],
        fileNotes: { "feature.js": "Contains the exported value used by callers." },
        checks: ["node --test feature.test.js"],
        baseSha: "abc123",
        candidates: 2,
        rationale: "Localized source update.",
      },
      {
        goal: "Debug intermittent CI failure after the patch lands",
        batchability: "needs_interactive_codex",
        rationale: "Requires running CI logs and iterating on failures.",
      },
    ],
  });

  assert.equal(result.queued.length, 1);
  assert.equal(result.skipped.length, 1);
  assert.match(result.nextStep, /batch-coder submit --dry-run/);

  const state = await loadState(cwd);
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].metadata.source, "agent_preflight");
  assert.equal(state.tasks[0].metadata.openGoal, "Improve the feature value flow");
  assert.equal(state.tasks[0].metadata.rationale, "Localized source update.");
  assert.deepEqual(state.tasks[0].metadata.fileNotes, {
    "feature.js": "Contains the exported value used by callers.",
  });

  const preflight = JSON.parse(await readFile(result.preflightPath, "utf8"));
  assert.equal(preflight.openGoal, "Improve the feature value flow");
  assert.equal(preflight.accepted[0].taskId, state.tasks[0].id);
  assert.equal(preflight.skipped[0].goal, "Debug intermittent CI failure after the patch lands");
});

test("enqueuePlanCommand warns when a batchable subtask has no checks", async () => {
  const cwd = await tempWorkspace();
  await writeFile(path.join(cwd, "feature.js"), "export const value = 1;\n");

  const result = await enqueuePlanCommand({
    cwd,
    openGoal: "Update feature docs",
    subtasks: [
      {
        goal: "Update feature value source without a local check",
        batchability: "batchable",
        files: ["feature.js"],
        baseSha: "abc123",
        rationale: "Small source change.",
      },
    ],
  });

  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0].message, /no checks/i);

  const state = await loadState(cwd);
  assert.deepEqual(state.tasks[0].metadata.warnings, result.warnings);
});

test("enqueuePlanCommand rejects batchable subtasks without files", async () => {
  const cwd = await tempWorkspace();

  await assert.rejects(
    enqueuePlanCommand({
      cwd,
      openGoal: "Improve feature flow",
      subtasks: [
        {
          goal: "Change feature behavior",
          batchability: "batchable",
          files: [],
          baseSha: "abc123",
        },
      ],
    }),
    /batchable subtask .* requires at least one file/,
  );
});

test("enqueuePlanCommand does not queue partial plans when validation fails", async () => {
  const cwd = await tempWorkspace();
  await writeFile(path.join(cwd, "feature.js"), "export const value = 1;\n");

  await assert.rejects(
    enqueuePlanCommand({
      cwd,
      openGoal: "Improve feature flow",
      subtasks: [
        {
          goal: "Change feature behavior in a known file",
          batchability: "batchable",
          files: ["feature.js"],
          baseSha: "abc123",
        },
        {
          goal: "Change another feature behavior without context",
          batchability: "batchable",
          files: [],
          baseSha: "abc123",
        },
      ],
    }),
    /batchable subtask .* requires at least one file/,
  );

  const state = await loadState(cwd);
  assert.equal(state.tasks.length, 0);
});
