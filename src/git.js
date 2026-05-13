import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function git(cwd, args, options = {}) {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
    });
    return result.stdout.trim();
  } catch (error) {
    const stderr = error.stderr?.trim();
    const stdout = error.stdout?.trim();
    const detail = stderr || stdout || error.message;
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
}

export async function currentHead(cwd) {
  return git(cwd, ["rev-parse", "HEAD"]);
}

export async function ensureGitRepo(cwd) {
  await git(cwd, ["rev-parse", "--show-toplevel"]);
}
