export class OpenAIBatchClient {
  constructor({ apiKey = process.env.OPENAI_API_KEY, baseUrl = "https://api.openai.com/v1", fetchImpl = fetch } = {}) {
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required");
    }
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetch = fetchImpl;
  }

  async request(path, options = {}) {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(options.body instanceof FormData ? {} : { "content-type": "application/json" }),
        ...(options.headers ?? {}),
      },
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(`OpenAI API ${response.status}: ${body.error?.message ?? text}`);
    }
    return body;
  }

  async uploadBatchInput({ filename, jsonl }) {
    const form = new FormData();
    form.append("purpose", "batch");
    form.append("file", new Blob([jsonl], { type: "application/jsonl" }), filename);
    return this.request("/files", { method: "POST", body: form });
  }

  async createBatch({ inputFileId, endpoint = "/v1/responses", metadata = {} }) {
    return this.request("/batches", {
      method: "POST",
      body: JSON.stringify({
        input_file_id: inputFileId,
        endpoint,
        completion_window: "24h",
        metadata,
      }),
    });
  }

  async createBatchFromJsonl({ filename, jsonl, metadata = {} }) {
    const file = await this.uploadBatchInput({ filename, jsonl });
    const batch = await this.createBatch({ inputFileId: file.id, metadata });
    return { file, batch };
  }

  async retrieveBatch(batchId) {
    return this.request(`/batches/${batchId}`);
  }

  async downloadFile(fileId) {
    const response = await this.fetch(`${this.baseUrl}/files/${fileId}/content`, {
      headers: { authorization: `Bearer ${this.apiKey}` },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`OpenAI file download ${response.status}: ${text}`);
    }
    return text;
  }
}
