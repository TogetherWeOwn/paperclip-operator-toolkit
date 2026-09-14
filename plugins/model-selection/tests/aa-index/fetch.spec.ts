import { describe, expect, it } from "vitest";

import { fetchAaSnapshot, type AaHttpClient } from "../../src/aa-index/fetch.js";

function htmlResponse(status: number, body: string, redirected = false): Awaited<ReturnType<AaHttpClient["fetch"]>> {
  return {
    status,
    headers: { get: () => "text/html" },
    redirected,
    text: async () => body,
  };
}

const BASE_INPUT = { url: "https://artificialanalysis.ai/leaderboards/models", timeoutMs: 1000, maxResponseBytes: 1000 };

describe("fetchAaSnapshot", () => {
  it("returns the html on a plain 200", async () => {
    const http: AaHttpClient = { fetch: async () => htmlResponse(200, "<html>ok</html>") };
    const result = await fetchAaSnapshot({ ...BASE_INPUT, http });
    expect(result).toEqual({ ok: true, html: "<html>ok</html>", error: null });
  });

  it("fails neutral on a non-2xx status", async () => {
    const http: AaHttpClient = { fetch: async () => htmlResponse(503, "") };
    const result = await fetchAaSnapshot({ ...BASE_INPUT, http });
    expect(result.ok).toBe(false);
    expect(result.html).toBeNull();
    expect(result.error).toBe("aa-http-failed");
  });

  it("refuses a redirect rather than following it", async () => {
    const http: AaHttpClient = { fetch: async () => htmlResponse(200, "", true) };
    const result = await fetchAaSnapshot({ ...BASE_INPUT, http });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("aa-redirect-refused");
  });

  it("refuses a 3xx status", async () => {
    const http: AaHttpClient = { fetch: async () => htmlResponse(302, "") };
    const result = await fetchAaSnapshot({ ...BASE_INPUT, http });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("aa-redirect-refused");
  });

  it("rejects a non-https URL without ever calling fetch", async () => {
    let called = false;
    const http: AaHttpClient = { fetch: async () => { called = true; return htmlResponse(200, "ok"); } };
    const result = await fetchAaSnapshot({ ...BASE_INPUT, url: "http://artificialanalysis.ai/leaderboards/models", http });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("aa-url-rejected");
    expect(called).toBe(false);
  });

  it("rejects a URL carrying embedded credentials", async () => {
    const http: AaHttpClient = { fetch: async () => htmlResponse(200, "ok") };
    const result = await fetchAaSnapshot({ ...BASE_INPUT, url: "https://user:pass@artificialanalysis.ai/leaderboards/models", http });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("aa-url-rejected");
  });

  it("times out when the fetch never resolves within timeoutMs", async () => {
    const http: AaHttpClient = { fetch: () => new Promise(() => {}) };
    const result = await fetchAaSnapshot({ ...BASE_INPUT, timeoutMs: 20, http });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("aa-request-failed");
  });

  it("fails neutral when the http client throws outright", async () => {
    const http: AaHttpClient = { fetch: async () => { throw new Error("socket hang up"); } };
    const result = await fetchAaSnapshot({ ...BASE_INPUT, http });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("aa-request-failed");
  });

  it("fails neutral when .text() itself throws", async () => {
    const http: AaHttpClient = {
      fetch: async () => ({
        status: 200,
        headers: { get: () => "text/html" },
        redirected: false,
        text: async () => { throw new Error("stream error"); },
      }),
    };
    const result = await fetchAaSnapshot({ ...BASE_INPUT, http });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("aa-request-failed");
  });

  it("rejects a response larger than maxResponseBytes", async () => {
    const big = "x".repeat(2000);
    const http: AaHttpClient = { fetch: async () => htmlResponse(200, big) };
    const result = await fetchAaSnapshot({ ...BASE_INPUT, maxResponseBytes: 1000, http });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("aa-response-too-large");
  });

  it("accepts a response exactly at the byte cap", async () => {
    const exact = "x".repeat(1000);
    const http: AaHttpClient = { fetch: async () => htmlResponse(200, exact) };
    const result = await fetchAaSnapshot({ ...BASE_INPUT, maxResponseBytes: 1000, http });
    expect(result.ok).toBe(true);
    expect(result.html).toBe(exact);
  });
});
