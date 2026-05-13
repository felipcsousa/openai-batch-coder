const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "confidence",
    "unified_diff",
    "files_changed",
    "tests",
    "risks",
    "needs_interactive_codex",
  ],
  properties: {
    summary: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    unified_diff: { type: "string" },
    files_changed: { type: "array", items: { type: "string" } },
    tests: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    needs_interactive_codex: { type: "boolean" },
  },
};

function taskPrompt(task, candidateIndex) {
  return JSON.stringify(
    {
      role: "codex-batch-coder",
      task_id: task.id,
      candidate_index: candidateIndex,
      goal: task.goal,
      base_sha: task.baseSha,
      checks: task.checks ?? [],
      files: task.manifest.files.map((file) => ({
        path: file.path,
        content: file.content,
      })),
      output_contract: OUTPUT_SCHEMA,
    },
    null,
    2,
  );
}

export function buildResponseBody({ task, model, candidateIndex }) {
  return {
    model: task.model ?? model,
    instructions:
      "You are a coding agent producing one localized patch candidate. " +
      "Return only a valid JSON object matching the requested schema. " +
      "Do not include markdown fences. If the task needs local execution or more context, set needs_interactive_codex=true and leave unified_diff empty.",
    input: taskPrompt(task, candidateIndex),
    text: {
      format: {
        type: "json_schema",
        name: "codex_batch_patch_candidate",
        schema: OUTPUT_SCHEMA,
        strict: true,
      },
    },
  };
}

export function buildBatchRequests({ tasks, model }) {
  const requests = [];
  for (const task of tasks) {
    const candidates = task.candidates ?? 1;
    for (let index = 1; index <= candidates; index += 1) {
      requests.push({
        custom_id: `${task.id}:candidate:${index}`,
        method: "POST",
        url: "/v1/responses",
        body: buildResponseBody({ task, model, candidateIndex: index }),
      });
    }
  }
  return requests;
}

export function buildBatchJsonl({ tasks, model }) {
  return `${buildBatchRequests({ tasks, model })
    .map((request) => JSON.stringify(request))
    .join("\n")}\n`;
}
