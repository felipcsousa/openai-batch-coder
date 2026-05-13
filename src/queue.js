import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { currentHead } from "./git.js";
import { loadState, saveState } from "./state.js";

export { loadState } from "./state.js";

function nowIso() {
  return new Date().toISOString();
}

function normalizeCandidates(candidates) {
  const value = Number(candidates ?? 1);
  if (!Number.isInteger(value) || value < 1 || value > 8) {
    throw new Error("candidates must be an integer from 1 to 8");
  }
  return value;
}

function safeRelativePath(file) {
  if (!file || typeof file !== "string") {
    throw new Error("file paths must be non-empty strings");
  }
  if (path.isAbsolute(file) || file.split(path.sep).includes("..") || file.includes("../")) {
    throw new Error(`file path must stay inside the workspace: ${file}`);
  }
  return file;
}

async function buildManifest(cwd, files) {
  const manifestFiles = [];
  for (const file of files.map(safeRelativePath)) {
    const absolute = path.join(cwd, file);
    const info = await stat(absolute);
    if (!info.isFile()) {
      throw new Error(`manifest entry is not a file: ${file}`);
    }
    if (info.size > 256 * 1024) {
      throw new Error(`file is too large for v1 context capture: ${file}`);
    }
    manifestFiles.push({
      path: file,
      bytes: info.size,
      content: await readFile(absolute, "utf8"),
    });
  }
  return { files: manifestFiles };
}

export async function enqueueTask({
  cwd = process.cwd(),
  goal,
  files,
  checks = [],
  baseSha,
  model,
  candidates = 1,
  metadata = {},
}) {
  if (!goal || typeof goal !== "string" || goal.trim().length < 12) {
    throw new Error("goal must be a concrete development task with at least 12 characters");
  }
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("enqueue requires at least one explicit file");
  }
  if (!Array.isArray(checks)) {
    throw new Error("checks must be an array of command strings");
  }

  const resolvedBaseSha = baseSha ?? (await currentHead(cwd));
  const task = {
    id: `task_${randomUUID()}`,
    status: "queued",
    goal: goal.trim(),
    files: files.map(safeRelativePath),
    checks,
    baseSha: resolvedBaseSha,
    model,
    candidates: normalizeCandidates(candidates),
    manifest: await buildManifest(cwd, files),
    metadata,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  const state = await loadState(cwd);
  state.tasks.push(task);
  await saveState(cwd, state);
  return task;
}

export async function updateTaskStatus(cwd, taskId, status, extra = {}) {
  const state = await loadState(cwd);
  const task = state.tasks.find((entry) => entry.id === taskId);
  if (!task) {
    throw new Error(`task not found: ${taskId}`);
  }
  Object.assign(task, extra, { status, updatedAt: nowIso() });
  await saveState(cwd, state);
  return task;
}

export async function queuedTasks(cwd = process.cwd()) {
  const state = await loadState(cwd);
  return state.tasks.filter((task) => task.status === "queued");
}
