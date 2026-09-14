import { describe, expect, it } from "vitest";

import { callClassifier, type ClassificationCallInput, type ClassificationHttpClient } from "../src/engine/classify-call.js";

function input(overrides: Partial<ClassificationCallInput> = {}): ClassificationCallInput {
  return {
    baseUrl: "https://api.anthropic.example.com",
    protocol: "anthropic-messages",
    modelId: "claude-sonnet-5",
    apiKey: "secret-value-123",
    system: "system prompt",
    userPrompt: "user prompt",
    maxOutputTokens: 120,
    requestTimeoutMs: 1000,
    maxResponseBytes: 65536,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Awaited<ReturnType<ClassificationHttpClient["fetch"]>> {
  return {
    status,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
    redirected: false,
    text: async () => JSON.stringify(body),
  };
}

describe("callClassifier", () => {
  it("builds an anthropic-messages request against /v1/messages with x-api-key auth", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    let seenBody = "";
    const http: ClassificationHttpClient = {
      fetch: async (url, init) => {
        seenUrl = url;
        seenHeaders = init.headers;
        seenBody = init.body;
        return jsonResponse(200, { content: [{ type: "text", text: '{"tier":"T2","confidence":0.9,"exclusion":false,"reason":"x"}' }] });
      },
    };
    const result = await callClassifier(input(), http);
    expect(seenUrl).toBe("https://api.anthropic.example.com/v1/messages");
    expect(seenHeaders).toMatchObject({ "x-api-key": "secret-value-123", "anthropic-version": "2023-06-01" });
    expect(seenHeaders).not.toHaveProperty("Authorization");
    expect(JSON.parse(seenBody)).toMatchObject({ model: "claude-sonnet-5", system: "system prompt" });
    expect(result.error).toBeNull();
    expect(result.text).toContain('"tier":"T2"');
  });

  it("builds an openai-chat-completions request against /v1/chat/completions with Bearer auth", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    let seenBody = "";
    const http: ClassificationHttpClient = {
      fetch: async (url, init) => {
        seenUrl = url;
        seenHeaders = init.headers;
        seenBody = init.body;
        return jsonResponse(200, { choices: [{ message: { content: '{"tier":"T3","confidence":0.9,"exclusion":false,"reason":"x"}' } }] });
      },
    };
    const result = await callClassifier(input({ protocol: "openai-chat-completions", baseUrl: "https://api.openai.example.com" }), http);
    expect(seenUrl).toBe("https://api.openai.example.com/v1/chat/completions");
    expect(seenHeaders).toMatchObject({ Authorization: "Bearer secret-value-123" });
    expect(seenHeaders).not.toHaveProperty("x-api-key");
    const parsedBody = JSON.parse(seenBody);
    expect(parsedBody.messages[0]).toEqual({ role: "system", content: "system prompt" });
    expect(result.text).toContain('"tier":"T3"');
  });

  it("omits auth headers entirely when no apiKey is resolved", async () => {
    let seenHeaders: Record<string, string> = {};
    const http: ClassificationHttpClient = {
      fetch: async (_url, init) => {
        seenHeaders = init.headers;
        return jsonResponse(200, { content: [{ type: "text", text: "{}" }] });
      },
    };
    await callClassifier(input({ apiKey: null }), http);
    expect(seenHeaders).not.toHaveProperty("x-api-key");
    expect(seenHeaders).not.toHaveProperty("Authorization");
  });

  it("rejects a reserved-literal-host baseUrl rather than calling it", async () => {
    const http: ClassificationHttpClient = {
      fetch: async () => jsonResponse(200, { content: [] }),
    };
    const result = await callClassifier(input({ baseUrl: "https://127.0.0.1" }), http);
    expect(result.error).toBe("classification-url-rejected");
    expect(result.text).toBeNull();
  });

  it("rejects a non-https baseUrl", async () => {
    const http: ClassificationHttpClient = {
      fetch: async () => jsonResponse(200, { content: [] }),
    };
    const result = await callClassifier(input({ baseUrl: "http://api.anthropic.example.com" }), http);
    expect(result.error).toBe("classification-url-rejected");
  });

  it("never follows a redirect", async () => {
    const http: ClassificationHttpClient = {
      fetch: async () => ({
        status: 200,
        headers: { get: () => "application/json" },
        redirected: true,
        text: async () => "{}",
      }),
    };
    const result = await callClassifier(input(), http);
    expect(result.error).toBe("classification-redirect-refused");
  });

  it("distinguishes an auth failure (401/403) from a generic http failure", async () => {
    const http: ClassificationHttpClient = { fetch: async () => jsonResponse(401, { error: "unauthorized" }) };
    const result = await callClassifier(input(), http);
    expect(result.error).toBe("classification-authentication-failed");
  });

  it("fails on a non-2xx status that is not a redirect or auth failure", async () => {
    const http: ClassificationHttpClient = { fetch: async () => jsonResponse(500, { error: "boom" }) };
    const result = await callClassifier(input(), http);
    expect(result.error).toBe("classification-http-failed");
  });

  it("rejects a non-JSON media type", async () => {
    const http: ClassificationHttpClient = {
      fetch: async () => ({
        status: 200,
        headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "text/html" : null) },
        redirected: false,
        text: async () => "<html></html>",
      }),
    };
    const result = await callClassifier(input(), http);
    expect(result.error).toBe("classification-unexpected-media-type");
  });

  it("enforces the response size cap", async () => {
    const http: ClassificationHttpClient = {
      fetch: async () => jsonResponse(200, { content: [{ type: "text", text: "x".repeat(1000) }] }),
    };
    const result = await callClassifier(input({ maxResponseBytes: 10 }), http);
    expect(result.error).toBe("classification-response-too-large");
  });

  it("fails cleanly on invalid JSON in the response body", async () => {
    const http: ClassificationHttpClient = {
      fetch: async () => ({
        status: 200,
        headers: { get: () => "application/json" },
        redirected: false,
        text: async () => "not json",
      }),
    };
    const result = await callClassifier(input(), http);
    expect(result.error).toBe("classification-invalid-json");
  });

  it("fails cleanly rather than throwing when the fetch itself rejects", async () => {
    const http: ClassificationHttpClient = {
      fetch: async () => {
        throw new Error("socket hang up");
      },
    };
    const result = await callClassifier(input(), http);
    expect(result.error).toBe("classification-request-failed");
    expect(result.text).toBeNull();
  });

  it("returns classification-empty-response when the provider returns no text content", async () => {
    const http: ClassificationHttpClient = { fetch: async () => jsonResponse(200, { content: [] }) };
    const result = await callClassifier(input(), http);
    expect(result.error).toBe("classification-empty-response");
  });
});
