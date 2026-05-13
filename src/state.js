import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const STATE_DIR = ".batch-coder";
export const STATE_FILE = "state.json";

export function stateDir(cwd) {
  return path.join(cwd, STATE_DIR);
}

export function statePath(cwd) {
  return path.join(stateDir(cwd), STATE_FILE);
}

export function emptyState() {
  return {
    version: 1,
    tasks: [],
    batches: [],
    candidates: [],
  };
}

export async function loadState(cwd = process.cwd()) {
  try {
    const raw = await readFile(statePath(cwd), "utf8");
    const parsed = JSON.parse(raw);
    return {
      ...emptyState(),
      ...parsed,
      tasks: parsed.tasks ?? [],
      batches: parsed.batches ?? [],
      candidates: parsed.candidates ?? [],
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return emptyState();
    }
    throw error;
  }
}

export async function saveState(cwd = process.cwd(), state) {
  await mkdir(stateDir(cwd), { recursive: true });
  await writeFile(statePath(cwd), `${JSON.stringify(state, null, 2)}\n`);
}

export async function updateState(cwd, update) {
  const state = await loadState(cwd);
  const next = await update(state);
  await saveState(cwd, next);
  return next;
}
