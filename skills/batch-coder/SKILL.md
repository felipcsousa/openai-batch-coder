---
name: batch-coder
description: Queue localized coding tasks for asynchronous OpenAI Batch patch generation, then import, apply, and review candidates in isolated git worktrees.
---

# Batch Coder

Use this skill when a coding task can be decomposed into localized subtasks that can be solved from static repository context without interactive tool use during generation.

## Workflow

1. Explore the repository with normal Codex tools before enqueueing anything.
2. Call `batch_coder_preflight_guidance` for the decomposition contract.
3. Split broad requests into localized subtasks. Mark debugging, command iteration, missing-context work, and ambiguous work as `needs_interactive_codex`.
4. Call `batch_coder_enqueue_plan` with `openGoal`, batchable subtasks, skipped interactive subtasks, file paths, file notes, checks, candidates, and rationale.
5. Run `batch-coder submit --dry-run` and inspect `.batch-coder/batches/<id>/manifest.json` before uploading.
6. Run `batch-coder submit` when ready. It uses `OPENAI_API_KEY`.
7. Run `batch-coder poll` until candidates are imported.
8. Run `batch-coder apply --task-id <id> --candidate <n>` to apply a candidate in an isolated worktree.
9. Run `batch-coder review --task-id <id> --candidate <n>` to execute configured checks.

## Direct CLI Path

Use `batch-coder enqueue --goal "<goal>" --file <path>` only when the files are already known. This is the lower-level path; open-ended requests should use agent preflight first.

## Guardrails

- The agent decides semantic batchability after repo exploration; the plugin validates that batchable subtasks have explicit files.
- Non-batchable subtasks are returned as skipped and should remain in the current Codex conversation.
- Do not enqueue secrets or private data. The submit step blocks sensitive-looking paths and tokens unless explicitly overridden.
- Prefer `candidates=1`; use multiple candidates only for important tasks where extra cost is justified.
- Treat Batch output as a candidate, not completed work. Apply, test, and review before merging.
