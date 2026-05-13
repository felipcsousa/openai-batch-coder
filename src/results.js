function parseCustomId(customId) {
  const match = /^(?<taskId>.+):candidate:(?<candidateIndex>\d+)$/.exec(customId ?? "");
  if (!match) {
    throw new Error(`invalid custom_id: ${customId}`);
  }
  return {
    taskId: match.groups.taskId,
    candidateIndex: Number(match.groups.candidateIndex),
  };
}

function outputTextFromResponseBody(body) {
  if (typeof body?.output_text === "string") {
    return body.output_text;
  }
  if (typeof body?.choices?.[0]?.message?.content === "string") {
    return body.choices[0].message.content;
  }
  const textParts = [];
  for (const item of body?.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === "string") {
        textParts.push(content.text);
      }
    }
  }
  return textParts.join("");
}

export function validateCandidate(candidate) {
  const required = [
    "summary",
    "confidence",
    "unified_diff",
    "files_changed",
    "tests",
    "risks",
    "needs_interactive_codex",
  ];
  for (const key of required) {
    if (!(key in candidate)) {
      throw new Error(`candidate is missing required field: ${key}`);
    }
  }
  if (typeof candidate.summary !== "string") {
    throw new Error("candidate.summary must be a string");
  }
  if (typeof candidate.confidence !== "number" || candidate.confidence < 0 || candidate.confidence > 1) {
    throw new Error("candidate.confidence must be a number from 0 to 1");
  }
  if (typeof candidate.unified_diff !== "string") {
    throw new Error("candidate.unified_diff must be a string");
  }
  for (const key of ["files_changed", "tests", "risks"]) {
    if (!Array.isArray(candidate[key]) || candidate[key].some((value) => typeof value !== "string")) {
      throw new Error(`candidate.${key} must be an array of strings`);
    }
  }
  if (typeof candidate.needs_interactive_codex !== "boolean") {
    throw new Error("candidate.needs_interactive_codex must be a boolean");
  }
  return candidate;
}

export function parseBatchOutputLine(line) {
  const record = JSON.parse(line);
  const { taskId, candidateIndex } = parseCustomId(record.custom_id);
  if (record.error) {
    return {
      taskId,
      candidateIndex,
      status: "batch_failed",
      error: record.error,
      raw: record,
    };
  }
  const outputText = outputTextFromResponseBody(record.response?.body);
  try {
    const candidate = validateCandidate(JSON.parse(outputText));
    return {
      taskId,
      candidateIndex,
      status: candidate.needs_interactive_codex ? "needs_interactive_codex" : "ready",
      candidate,
      raw: record,
    };
  } catch (error) {
    return {
      taskId,
      candidateIndex,
      status: "invalid_output",
      error: {
        message: `model output must be valid JSON matching the candidate schema: ${error.message}`,
      },
      raw: record,
    };
  }
}

export function parseBatchOutput(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map(parseBatchOutputLine);
}
