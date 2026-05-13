import {
  applyCommand,
  enqueueCommand,
  importOutputCommand,
  pollCommand,
  reviewCommand,
  statusCommand,
  submitCommand,
} from "./commands.js";

function usage() {
  return `Usage:
  batch-coder enqueue --goal <text> --file <path> [--file <path>] [--check <cmd>] [--base-sha <sha>] [--candidates <n>]
  batch-coder submit [--model <model>] [--dry-run] [--allow-sensitive]
  batch-coder poll
  batch-coder import-output --output <path> [--batch-id <id>]
  batch-coder apply --task-id <id> [--candidate <n>]
  batch-coder review --task-id <id> [--candidate <n>]
  batch-coder status`;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { _: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith("--")) {
      options._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (["dry-run", "allow-sensitive"].includes(key)) {
      options[key] = true;
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for --${key}`);
    }
    index += 1;
    if (["file", "check"].includes(key)) {
      options[key] = [...(options[key] ?? []), value];
    } else {
      options[key] = value;
    }
  }
  return { command, options };
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function runCli(argv = process.argv.slice(2), cwd = process.cwd()) {
  const { command, options } = parseArgs(argv);
  switch (command) {
    case "enqueue":
      return enqueueCommand({
        cwd,
        goal: options.goal,
        files: options.file ?? [],
        checks: options.check ?? [],
        baseSha: options["base-sha"],
        candidates: options.candidates,
        model: options.model,
      });
    case "submit":
      return submitCommand({
        cwd,
        model: options.model,
        allowSensitive: options["allow-sensitive"] ?? false,
        dryRun: options["dry-run"] ?? false,
        baseUrl: options["base-url"],
      });
    case "poll":
      return pollCommand({ cwd, baseUrl: options["base-url"] });
    case "import-output":
      return importOutputCommand({
        cwd,
        outputPath: options.output,
        batchId: options["batch-id"],
      });
    case "apply":
      return applyCommand({
        cwd,
        taskId: options["task-id"],
        candidateIndex: options.candidate ?? 1,
      });
    case "review":
      return reviewCommand({
        cwd,
        taskId: options["task-id"],
        candidateIndex: options.candidate ?? 1,
      });
    case "status":
      return statusCommand({ cwd });
    case "help":
    case "--help":
    case "-h":
    case undefined:
      return { usage: usage() };
    default:
      throw new Error(`unknown command: ${command}\n${usage()}`);
  }
}

export async function main() {
  try {
    output(await runCli());
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
