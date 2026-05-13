import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { applyCommand, importOutputCommand, reviewCommand } from "../src/commands.js";
import { enqueueTask } from "../src/queue.js";

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  return execFileAsync("git", args, { cwd });
}

async function repo() {
  const cwd = await mkdtemp(path.join(tmpdir(), "batch-coder-git-test-"));
  await git(cwd, ["init"]);
  await writeFile(path.join(cwd, "feature.js"), "export const value = 1;\n");
  await writeFile(
    path.join(cwd, "feature.test.js"),
    "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { value } from './feature.js';\ntest('value', () => assert.equal(value, 2));\n",
  );
  await git(cwd, ["add", "."]);
  await git(cwd, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "initial"]);
  const { stdout } = await git(cwd, ["rev-parse", "HEAD"]);
  return { cwd, baseSha: stdout.trim() };
}

test("imported candidate applies in an isolated worktree and passes review checks", async () => {
  const { cwd, baseSha } = await repo();
  const task = await enqueueTask({
    cwd,
    goal: "Change exported value to 2",
    files: ["feature.js", "feature.test.js"],
    checks: ["node --test"],
    baseSha,
  });
  const candidate = {
    summary: "Changes value to 2",
    confidence: 0.9,
    unified_diff:
      "diff --git a/feature.js b/feature.js\n--- a/feature.js\n+++ b/feature.js\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
    files_changed: ["feature.js"],
    tests: ["node --test"],
    risks: [],
    needs_interactive_codex: false,
  };
  const outputPath = path.join(cwd, "output.jsonl");
  await writeFile(
    outputPath,
    `${JSON.stringify({
      custom_id: `${task.id}:candidate:1`,
      response: { body: { output_text: JSON.stringify(candidate) } },
      error: null,
    })}\n`,
  );

  await importOutputCommand({ cwd, outputPath, batchId: "batch_test" });
  const applied = await applyCommand({ cwd, taskId: task.id, candidateIndex: 1 });
  assert.equal(applied.status, "applied");
  assert.match(await readFile(path.join(applied.applied.worktreePath, "feature.js"), "utf8"), /value = 2/);

  const reviewed = await reviewCommand({ cwd, taskId: task.id, candidateIndex: 1 });
  assert.equal(reviewed.status, "completed");
  assert.equal(reviewed.checks[0].status, "passed");
});
