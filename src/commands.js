import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { applyCandidate, runChecks } from "./apply.js";
import { buildBatchJsonl } from "./batch.js";
import { OpenAIBatchClient } from "./openai-client.js";
import { assertManifestIsSafe } from "./privacy.js";
import { enqueueTask, loadState, queuedTasks, updateTaskStatus } from "./queue.js";
import { parseBatchOutput } from "./results.js";
import { saveState, stateDir } from "./state.js";

function nowIso() {
  return new Date().toISOString();
}

function findTask(state, taskId) {
  const task = state.tasks.find((entry) => entry.id === taskId);
  if (!task) {
    throw new Error(`task not found: ${taskId}`);
  }
  return task;
}

export async function enqueueCommand(options) {
  return enqueueTask(options);
}

function normalizeBatchability(value) {
  return value ?? "batchable";
}

function validateOpenGoal(openGoal) {
  if (!openGoal || typeof openGoal !== "string" || openGoal.trim().length < 12) {
    throw new Error("openGoal must describe the broad user request with at least 12 characters");
  }
  return openGoal.trim();
}

function validateSubtasks(subtasks) {
  if (!Array.isArray(subtasks) || subtasks.length === 0) {
    throw new Error("enqueue plan requires at least one subtask");
  }
}

function validatePlanSubtask(subtask, index) {
  if (!subtask?.goal || typeof subtask.goal !== "string" || subtask.goal.trim().length < 12) {
    throw new Error(`subtask ${index + 1} goal must be a concrete task with at least 12 characters`);
  }
  const batchability = normalizeBatchability(subtask.batchability);
  if (!["batchable", "needs_interactive_codex"].includes(batchability)) {
    throw new Error(`unknown batchability for subtask ${index + 1}: ${batchability}`);
  }
  if (batchability === "batchable" && (!Array.isArray(subtask.files) || subtask.files.length === 0)) {
    throw new Error(`batchable subtask ${index + 1} requires at least one file`);
  }
  if (subtask.checks !== undefined && !Array.isArray(subtask.checks)) {
    throw new Error(`subtask ${index + 1} checks must be an array of command strings`);
  }
  if (subtask.candidates !== undefined) {
    const candidates = Number(subtask.candidates);
    if (!Number.isInteger(candidates) || candidates < 1 || candidates > 8) {
      throw new Error(`subtask ${index + 1} candidates must be an integer from 1 to 8`);
    }
  }
}

function warningForMissingChecks(subtask) {
  return {
    kind: "missing_checks",
    goal: subtask.goal,
    message: `Batchable subtask has no checks and will rely on apply/review: ${subtask.goal}`,
  };
}

export function preflightGuidanceCommand() {
  return {
    instructions: [
      "Explore the repository before calling batch_coder_enqueue_plan.",
      "Decompose broad requests into localized subtasks that can be solved from static files.",
      "For each batchable subtask, include explicit file paths and short fileNotes explaining why each file matters.",
      "Mark debugging, command-iteration, missing-context, or ambiguous work as needs_interactive_codex instead of forcing it into Batch.",
      "After enqueueing, keep Batch submission manual; use batch-coder submit --dry-run to review the manifest first.",
    ],
    enqueueTool: "batch_coder_enqueue_plan",
  };
}

export async function enqueuePlanCommand({ cwd = process.cwd(), openGoal, subtasks = [] } = {}) {
  const normalizedOpenGoal = validateOpenGoal(openGoal);
  validateSubtasks(subtasks);
  subtasks.forEach(validatePlanSubtask);

  const queued = [];
  const skipped = [];
  const warnings = [];
  const accepted = [];
  const preflightId = `preflight_${Date.now()}_${randomUUID()}`;

  for (const [index, subtask] of subtasks.entries()) {
    const batchability = normalizeBatchability(subtask.batchability);
    if (batchability === "needs_interactive_codex") {
      skipped.push({
        index,
        goal: subtask.goal,
        batchability,
        rationale: subtask.rationale,
      });
      continue;
    }
    const subtaskWarnings = [];
    if (!Array.isArray(subtask.checks) || subtask.checks.length === 0) {
      const warning = warningForMissingChecks(subtask);
      warnings.push(warning);
      subtaskWarnings.push(warning);
    }

    const task = await enqueueTask({
      cwd,
      goal: subtask.goal,
      files: subtask.files,
      checks: subtask.checks ?? [],
      baseSha: subtask.baseSha,
      candidates: subtask.candidates ?? 1,
      model: subtask.model,
      metadata: {
        source: "agent_preflight",
        preflightId,
        openGoal: normalizedOpenGoal,
        rationale: subtask.rationale,
        fileNotes: subtask.fileNotes ?? {},
        warnings: subtaskWarnings,
      },
    });

    const summary = {
      taskId: task.id,
      goal: task.goal,
      files: task.files,
      checks: task.checks,
      candidates: task.candidates,
      rationale: subtask.rationale,
      fileNotes: subtask.fileNotes ?? {},
      warnings: subtaskWarnings,
    };
    queued.push(summary);
    accepted.push(summary);
  }

  const preflightDir = path.join(stateDir(cwd), "preflights");
  await mkdir(preflightDir, { recursive: true });
  const preflightPath = path.join(preflightDir, `${preflightId}.json`);
  await writeFile(
    preflightPath,
    `${JSON.stringify(
      {
        id: preflightId,
        openGoal: normalizedOpenGoal,
        accepted,
        skipped,
        warnings,
        createdAt: nowIso(),
      },
      null,
      2,
    )}\n`,
  );

  return {
    preflightPath,
    queued,
    skipped,
    warnings,
    nextStep: "Run batch-coder submit --dry-run to review the manifest before uploading to OpenAI Batch.",
  };
}

export async function submitCommand({
  cwd = process.cwd(),
  model = "gpt-5.4",
  allowSensitive = false,
  dryRun = false,
  apiKey,
  baseUrl,
} = {}) {
  const tasks = await queuedTasks(cwd);
  if (tasks.length === 0) {
    return { submitted: false, reason: "no queued tasks" };
  }
  const findings = tasks.flatMap((task) =>
    assertManifestIsSafe(task.manifest, { allowSensitive }).map((finding) => ({
      taskId: task.id,
      ...finding,
    })),
  );
  const jsonl = buildBatchJsonl({ tasks, model });
  const batchLocalId = `local_${Date.now()}`;
  const batchesDir = path.join(stateDir(cwd), "batches", batchLocalId);
  await mkdir(batchesDir, { recursive: true });
  const inputPath = path.join(batchesDir, "input.jsonl");
  const manifestPath = path.join(batchesDir, "manifest.json");
  await writeFile(inputPath, jsonl);
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        model,
        endpoint: "/v1/responses",
        taskIds: tasks.map((task) => task.id),
        findings,
        generatedAt: nowIso(),
      },
      null,
      2,
    )}\n`,
  );

  if (dryRun) {
    return { submitted: false, dryRun: true, inputPath, manifestPath, requestCount: jsonl.trim().split("\n").length };
  }

  const client = new OpenAIBatchClient({ apiKey, baseUrl });
  const { file, batch } = await client.createBatchFromJsonl({
    filename: "codex-batch-coder.jsonl",
    jsonl,
    metadata: { source: "codex-batch-coder", local_id: batchLocalId },
  });

  const state = await loadState(cwd);
  state.batches.push({
    localId: batchLocalId,
    id: batch.id,
    inputFileId: file.id,
    status: batch.status,
    taskIds: tasks.map((task) => task.id),
    inputPath,
    manifestPath,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
  for (const task of tasks) {
    task.status = "submitted";
    task.batchId = batch.id;
    task.updatedAt = nowIso();
  }
  await saveState(cwd, state);
  return { submitted: true, batch, file, inputPath, manifestPath };
}

export async function pollCommand({ cwd = process.cwd(), apiKey, baseUrl } = {}) {
  const client = new OpenAIBatchClient({ apiKey, baseUrl });
  const state = await loadState(cwd);
  const updated = [];
  for (const batch of state.batches.filter((entry) => !["completed", "failed", "expired", "cancelled"].includes(entry.status))) {
    const remote = await client.retrieveBatch(batch.id);
    batch.status = remote.status;
    batch.remote = remote;
    batch.updatedAt = nowIso();
    updated.push(batch);
    if (remote.status === "completed" && remote.output_file_id) {
      const output = await client.downloadFile(remote.output_file_id);
      const outputPath = path.join(path.dirname(batch.inputPath), "output.jsonl");
      await writeFile(outputPath, output);
      batch.outputPath = outputPath;
      const candidates = parseBatchOutput(output);
      for (const candidate of candidates) {
        state.candidates.push({
          ...candidate,
          batchId: batch.id,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        });
      }
    }
    if (["failed", "expired", "cancelled"].includes(remote.status)) {
      for (const taskId of batch.taskIds) {
        const task = findTask(state, taskId);
        task.status = remote.status === "expired" ? "batch_expired" : "batch_failed";
        task.updatedAt = nowIso();
      }
    }
  }
  await saveState(cwd, state);
  return { updated };
}

export async function applyCommand({ cwd = process.cwd(), taskId, candidateIndex = 1 } = {}) {
  const state = await loadState(cwd);
  const task = findTask(state, taskId);
  const candidateRecord = state.candidates.find(
    (entry) => entry.taskId === taskId && entry.candidateIndex === Number(candidateIndex),
  );
  if (!candidateRecord) {
    throw new Error(`candidate not found for ${taskId}:${candidateIndex}`);
  }
  if (candidateRecord.status !== "ready") {
    throw new Error(`candidate is not ready: ${candidateRecord.status}`);
  }
  if (candidateRecord.candidate.confidence < 0.5) {
    candidateRecord.status = "low_confidence";
    candidateRecord.updatedAt = nowIso();
    await saveState(cwd, state);
    return candidateRecord;
  }
  try {
    const applied = await applyCandidate({
      cwd,
      task,
      candidate: candidateRecord.candidate,
      candidateIndex,
    });
    candidateRecord.status = "applied";
    candidateRecord.applied = applied;
    candidateRecord.updatedAt = nowIso();
    task.status = "candidate_applied";
    task.updatedAt = nowIso();
    await saveState(cwd, state);
    return candidateRecord;
  } catch (error) {
    candidateRecord.status = "apply_conflict";
    candidateRecord.error = { message: error.message };
    candidateRecord.updatedAt = nowIso();
    await saveState(cwd, state);
    return candidateRecord;
  }
}

export async function reviewCommand({ cwd = process.cwd(), taskId, candidateIndex = 1 } = {}) {
  const state = await loadState(cwd);
  const task = findTask(state, taskId);
  const candidateRecord = state.candidates.find(
    (entry) => entry.taskId === taskId && entry.candidateIndex === Number(candidateIndex),
  );
  if (!candidateRecord?.applied?.worktreePath) {
    throw new Error("candidate must be applied before review");
  }
  const checkResults = await runChecks({
    cwd: candidateRecord.applied.worktreePath,
    checks: task.checks ?? [],
  });
  const failed = checkResults.some((result) => result.status === "failed");
  candidateRecord.checks = checkResults;
  candidateRecord.status = failed ? "tests_failed" : "completed";
  candidateRecord.updatedAt = nowIso();
  task.status = candidateRecord.status;
  task.updatedAt = nowIso();
  await saveState(cwd, state);
  return candidateRecord;
}

export async function statusCommand({ cwd = process.cwd() } = {}) {
  return loadState(cwd);
}

export async function importOutputCommand({ cwd = process.cwd(), batchId, outputPath }) {
  const text = await readFile(outputPath, "utf8");
  const state = await loadState(cwd);
  const candidates = parseBatchOutput(text);
  for (const candidate of candidates) {
    state.candidates.push({
      ...candidate,
      batchId: batchId ?? "manual",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
  }
  await saveState(cwd, state);
  return { imported: candidates.length };
}
