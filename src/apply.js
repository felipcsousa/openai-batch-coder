import { exec } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { git } from "./git.js";
import { stateDir } from "./state.js";

const execAsync = promisify(exec);

function safeBranchPart(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80);
}

export async function applyCandidate({
  cwd = process.cwd(),
  task,
  candidate,
  candidateIndex,
  worktreeRoot = path.join(stateDir(cwd), "worktrees"),
}) {
  const branch = `batch-coder/${safeBranchPart(task.id)}/candidate-${candidateIndex}`;
  const worktreePath = path.join(worktreeRoot, `${safeBranchPart(task.id)}-candidate-${candidateIndex}`);
  await mkdir(worktreeRoot, { recursive: true });
  await git(cwd, ["worktree", "add", "-B", branch, worktreePath, task.baseSha]);
  const patchPath = path.join(worktreePath, ".batch-coder-candidate.patch");
  await writeFile(patchPath, candidate.unified_diff);
  try {
    await git(worktreePath, ["apply", "--index", patchPath], { maxBuffer: 20 * 1024 * 1024 });
  } catch (error) {
    error.code = "apply_conflict";
    error.worktreePath = worktreePath;
    throw error;
  }
  return { branch, worktreePath, patchPath };
}

export async function runChecks({ cwd, checks = [] }) {
  const results = [];
  for (const command of checks) {
    try {
      const result = await execAsync(command, { cwd, maxBuffer: 20 * 1024 * 1024 });
      results.push({ command, status: "passed", stdout: result.stdout, stderr: result.stderr });
    } catch (error) {
      results.push({
        command,
        status: "failed",
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? error.message,
      });
      break;
    }
  }
  return results;
}
