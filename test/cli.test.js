import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const bin = path.resolve("bin/batch-coder.js");

async function tempWorkspace() {
  const cwd = await mkdtemp(path.join(tmpdir(), "batch-coder-cli-test-"));
  await writeFile(path.join(cwd, "feature.js"), "export const value = 1;\n");
  return cwd;
}

async function runCli(cwd, args) {
  const result = await execFileAsync(process.execPath, [bin, ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: "1" },
  });
  return JSON.parse(result.stdout);
}

test("batch-coder CLI enqueues, reports status, and builds a dry-run batch", async () => {
  const cwd = await tempWorkspace();

  const enqueued = await runCli(cwd, [
    "enqueue",
    "--goal",
    "Change exported value to 2",
    "--file",
    "feature.js",
    "--check",
    "node --test",
    "--base-sha",
    "abc123",
    "--candidates",
    "2",
  ]);
  assert.equal(enqueued.status, "queued");

  const status = await runCli(cwd, ["status"]);
  assert.equal(status.tasks.length, 1);
  assert.equal(status.tasks[0].candidates, 2);

  const submitted = await runCli(cwd, ["submit", "--dry-run", "--model", "gpt-5.4"]);
  assert.equal(submitted.dryRun, true);
  assert.equal(submitted.requestCount, 2);

  const jsonl = await readFile(submitted.inputPath, "utf8");
  assert.equal(jsonl.trim().split("\n").length, 2);
});
