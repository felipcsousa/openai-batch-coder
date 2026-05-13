import assert from "node:assert/strict";
import { test } from "node:test";

import { OpenAIBatchClient } from "../src/openai-client.js";

test("OpenAIBatchClient creates a batch from an uploaded JSONL file", async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({
      method: options.method,
      url: new URL(url).pathname,
      auth: options.headers.authorization,
    });
    if (url.endsWith("/files")) {
      return new Response(JSON.stringify({ id: "file_123" }), { status: 200 });
    }
    if (url.endsWith("/batches")) {
      return new Response(JSON.stringify({ id: "batch_123", status: "validating" }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };

  const client = new OpenAIBatchClient({
    apiKey: "test-key",
    baseUrl: "https://api.test/v1",
    fetchImpl,
  });
  const result = await client.createBatchFromJsonl({
    filename: "batch.jsonl",
    jsonl: "{\"custom_id\":\"1\"}\n",
    metadata: { source: "test" },
  });

  assert.equal(result.file.id, "file_123");
  assert.equal(result.batch.id, "batch_123");
  assert.deepEqual(
    seen.map((request) => [request.method, request.url, request.auth]),
    [
      ["POST", "/v1/files", "Bearer test-key"],
      ["POST", "/v1/batches", "Bearer test-key"],
    ],
  );
});
