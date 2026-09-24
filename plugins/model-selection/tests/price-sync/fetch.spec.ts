import { describe, expect, it } from "vitest";

import { fetchPriceCatalog, type PriceHttpClient } from "../../src/price-sync/fetch.js";

function jsonResponse(
  status: number,
  body: string,
  redirected = false,
): Awaited<ReturnType<PriceHttpClient["fetch"]>> {
  return {
    status,
    headers: { get: () => "application/json" },
    redirected,
    text: async () => body,
  };
}

const BASE_INPUT = {
  url: "https://models.dev/api.json",
  userAgent: "TogetherWeOwn-model-selection/1.0",
  timeoutMs: 1000,
  maxResponseBytes: 1000,
};

describe("fetchPriceCatalog", () => {
  it("returns the body on a plain 200", async () => {
    const http: PriceHttpClient = { fetch: async () => jsonResponse(200, '{"anthropic":{}}') };
    const result = await fetchPriceCatalog({ ...BASE_INPUT, http });
    expect(result).toEqual({ ok: true, json: '{"anthropic":{}}', error: null });
  });

  // The header is load-bearing, not cosmetic: models.dev sits behind
  // Cloudflare, which 403s default library agents at the edge.
  it("sends the caller's User-Agent", async () => {
    let seen: Record<string, string> | null = null;
    const http: PriceHttpClient = {
      fetch: async (_url, init) => {
        seen = init.headers;
        return jsonResponse(200, "{}");
      },
    };
    await fetchPriceCatalog({ ...BASE_INPUT, http });
    expect(seen).not.toBeNull();
    expect(seen!["User-Agent"]).toBe("TogetherWeOwn-model-selection/1.0");
  });

  // A 403 is the single most likely failure here and it is NOT the same fact
  // as a withdrawn feed, so it gets its own code — an operator reading the log
  // should check the User-Agent, not go hunting for a dead endpoint.
  it("names a 403 separately from any other failed status", async () => {
    const forbidden = await fetchPriceCatalog({ ...BASE_INPUT, http: { fetch: async () => jsonResponse(403, "") } });
    expect(forbidden.error).toBe("price-http-forbidden");

    const unavailable = await fetchPriceCatalog({ ...BASE_INPUT, http: { fetch: async () => jsonResponse(503, "") } });
    expect(unavailable.error).toBe("price-http-failed");
  });

  it("fails neutral on a non-2xx status", async () => {
    const result = await fetchPriceCatalog({ ...BASE_INPUT, http: { fetch: async () => jsonResponse(500, "") } });
    expect(result.ok).toBe(false);
    expect(result.json).toBeNull();
  });

  it("refuses a redirect rather than following it", async () => {
    const flagged = await fetchPriceCatalog({ ...BASE_INPUT, http: { fetch: async () => jsonResponse(200, "", true) } });
    expect(flagged.error).toBe("price-redirect-refused");

    const status3xx = await fetchPriceCatalog({ ...BASE_INPUT, http: { fetch: async () => jsonResponse(302, "") } });
    expect(status3xx.error).toBe("price-redirect-refused");
  });

  it("rejects a non-https URL without ever calling fetch", async () => {
    let called = false;
    const http: PriceHttpClient = {
      fetch: async () => {
        called = true;
        return jsonResponse(200, "{}");
      },
    };
    const result = await fetchPriceCatalog({ ...BASE_INPUT, url: "http://models.dev/api.json", http });
    expect(result.error).toBe("price-url-rejected");
    expect(called).toBe(false);
  });

  it("rejects a URL carrying embedded credentials", async () => {
    const http: PriceHttpClient = { fetch: async () => jsonResponse(200, "{}") };
    const result = await fetchPriceCatalog({ ...BASE_INPUT, url: "https://user:pass@models.dev/api.json", http });
    expect(result.error).toBe("price-url-rejected");
  });

  it("rejects an unparseable URL", async () => {
    const http: PriceHttpClient = { fetch: async () => jsonResponse(200, "{}") };
    const result = await fetchPriceCatalog({ ...BASE_INPUT, url: "not a url", http });
    expect(result.error).toBe("price-url-rejected");
  });

  it("caps an oversized body by BYTES, not characters", async () => {
    // 400 astral-plane characters is 1600 UTF-8 bytes but only 800 UTF-16
    // code units, so a `.length` check would wave this through the 1000-byte
    // cap. The real feed is ~4.8 MB; the cap is the only thing bounding it.
    const body = "\u{1F600}".repeat(400);
    expect(body.length).toBeLessThan(BASE_INPUT.maxResponseBytes);
    const result = await fetchPriceCatalog({ ...BASE_INPUT, http: { fetch: async () => jsonResponse(200, body) } });
    expect(result.error).toBe("price-response-too-large");
  });

  it("fails neutral when the transport throws", async () => {
    const http: PriceHttpClient = {
      fetch: async () => {
        throw new Error("socket hang up");
      },
    };
    const result = await fetchPriceCatalog({ ...BASE_INPUT, http });
    expect(result).toEqual({ ok: false, json: null, error: "price-request-failed" });
  });

  it("fails neutral when reading the body throws", async () => {
    const http: PriceHttpClient = {
      fetch: async () => ({
        status: 200,
        headers: { get: () => "application/json" },
        redirected: false,
        text: async () => {
          throw new Error("truncated");
        },
      }),
    };
    const result = await fetchPriceCatalog({ ...BASE_INPUT, http });
    expect(result.error).toBe("price-request-failed");
  });

  // `ctx.http.fetch` silently drops `AbortSignal` on the real host, so the
  // timeout has to be a `Promise.race` — a hung feed must not hang the job.
  it("times out a hanging request instead of hanging the job", async () => {
    const http: PriceHttpClient = { fetch: () => new Promise(() => {}) };
    const result = await fetchPriceCatalog({ ...BASE_INPUT, timeoutMs: 5, http });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("price-request-failed");
  });
});
