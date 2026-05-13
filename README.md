# Codex Batch Coder

Codex Batch Coder is a Codex CLI plugin and local CLI for queueing well-scoped coding tasks, submitting them to the OpenAI Batch API, importing structured patch candidates, and validating those candidates in isolated git worktrees.

For broad requests, the intended flow is agent-first: the current Codex agent explores the repository, decomposes the work into localized subtasks, and calls the MCP `batch_coder_enqueue_plan` tool. Batch Coder validates and stores the prepared plan; it does not guess files or run a nested Codex session.

The v1 flow intentionally does not schedule around off-peak windows. OpenAI Batch pricing is tied to the Batch API mode itself, not a specific local clock window.

## Requirements

- Node.js 20+
- Git for apply/review flows
- `OPENAI_API_KEY` for real Batch API submission

## Quick Start

### Agent Preflight Flow

1. Ask Codex to inspect the repository and prepare the open request for Batch Coder.
2. The agent calls `batch_coder_preflight_guidance`.
3. The agent calls `batch_coder_enqueue_plan` with batchable subtasks and skipped interactive work.
4. Review the generated preflight artifact under `.batch-coder/preflights/`.
5. Run `batch-coder submit --dry-run` before uploading anything to OpenAI Batch.

### Direct CLI Flow

```bash
batch-coder enqueue \
  --goal "Change exported value to 2" \
  --file feature.js \
  --check "node --test" \
  --candidates 1

batch-coder submit --dry-run --model gpt-5.4
batch-coder submit --model gpt-5.4
batch-coder poll
batch-coder apply --task-id <task_id> --candidate 1
batch-coder review --task-id <task_id> --candidate 1
batch-coder status
```

## Safety Model

- `enqueue` requires explicit files. Batch Coder does not crawl the whole repository.
- `batch_coder_enqueue_plan` also requires explicit files for each batchable subtask; non-batchable work is returned as skipped.
- Agent preflight artifacts are written under `.batch-coder/preflights/` with accepted task IDs, skipped items, warnings, file notes, and rationale.
- `submit` writes a JSONL input and manifest under `.batch-coder/batches/`.
- Sensitive-looking paths and token-like content are blocked unless `--allow-sensitive` is passed.
- Candidates apply to the original base SHA in an isolated worktree under `.batch-coder/worktrees/`.
- A candidate is only `completed` after it applies and configured checks pass.

## Plugin Layout

- `.codex-plugin/plugin.json`: Codex plugin manifest.
- `.mcp.json`: MCP server declaration.
- `skills/batch-coder/SKILL.md`: model-facing workflow guidance.
- `bin/batch-coder.js`: human/CI CLI.
- `bin/batch-coder-mcp.js`: MCP stdio server.

## Status Values

Expected failure/status values include `invalid_output`, `apply_conflict`, `tests_failed`, `low_confidence`, `needs_interactive_codex`, `batch_failed`, and `batch_expired`.
