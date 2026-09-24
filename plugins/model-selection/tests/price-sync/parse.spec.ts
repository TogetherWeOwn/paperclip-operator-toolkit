import { describe, expect, it } from "vitest";

import { parsePriceCatalog } from "../../src/price-sync/parse.js";

/** Shaped like the real `api.json`: provider -> models -> record -> cost. */
function feed(providers: Record<string, Record<string, unknown>>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(providers).map(([id, models]) => [id, { id, models }])),
  );
}

describe("parsePriceCatalog", () => {
  it("lifts the three cost fields the selector reads, keyed by provider then bare id", () => {
    // Real 2026-09-22 values from the feed.
    const catalog = parsePriceCatalog(
      feed({ anthropic: { "claude-sonnet-5": { cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 } } } }),
    );
    expect(catalog?.get("anthropic")?.get("claude-sonnet-5")).toEqual({
      providerId: "anthropic",
      modelId: "claude-sonnet-5",
      input: 2,
      output: 10,
      cacheRead: 0.2,
    });
  });

  // The same bare id under two providers at two prices is exactly why
  // resolution is lane-keyed; the catalogue has to keep them apart.
  it("keeps a model that appears under two providers separate", () => {
    const catalog = parsePriceCatalog(
      feed({
        moonshotai: { "kimi-k2.6": { cost: { input: 1, output: 4 } } },
        "opencode-go": { "kimi-k2.6": { cost: { input: 0.5, output: 2 } } },
      }),
    );
    expect(catalog?.get("moonshotai")?.get("kimi-k2.6")?.input).toBe(1);
    expect(catalog?.get("opencode-go")?.get("kimi-k2.6")?.input).toBe(0.5);
  });

  // `zhipuai/glm-4.5v` really does publish `{input, output}` only. Recording
  // the absent field as 0 would manufacture a drift row against every
  // correctly-priced roster row whose provider has no cache rate.
  it("records an unpublished cache_read as null, not zero", () => {
    const catalog = parsePriceCatalog(feed({ zhipuai: { "glm-4.5v": { cost: { input: 0.6, output: 1.8 } } } }));
    const record = catalog?.get("zhipuai")?.get("glm-4.5v");
    expect(record?.cacheRead).toBeNull();
    expect(record?.cacheRead).not.toBe(0);
  });

  // "Present but unpriced" and "absent from the feed" are different facts and
  // only the second is the card's "absence is not evidence" case.
  it("keeps a model with no cost block, with every field null", () => {
    const catalog = parsePriceCatalog(feed({ openai: { "gpt-image-1.5": {} } }));
    expect(catalog?.get("openai")?.has("gpt-image-1.5")).toBe(true);
    expect(catalog?.get("openai")?.get("gpt-image-1.5")).toMatchObject({
      input: null,
      output: null,
      cacheRead: null,
    });
  });

  it("treats a non-finite or non-numeric cost as unpublished", () => {
    const catalog = parsePriceCatalog(
      // 1e999 parses to Infinity; "2" is a string, not a price.
      '{"p":{"models":{"m":{"cost":{"input":1e999,"output":"2","cache_read":null}}}}}',
    );
    expect(catalog?.get("p")?.get("m")).toMatchObject({ input: null, output: null, cacheRead: null });
  });

  it("returns null rather than a partial map on unparseable JSON", () => {
    expect(parsePriceCatalog("<!doctype html>")).toBeNull();
    expect(parsePriceCatalog("")).toBeNull();
  });

  it("returns null on a non-object root", () => {
    expect(parsePriceCatalog("[]")).toBeNull();
    expect(parsePriceCatalog("null")).toBeNull();
    expect(parsePriceCatalog('"a string"')).toBeNull();
  });

  // An object that parsed but carries no models at all is a shape change, not
  // an empty industry. Returning an empty map would report the whole roster as
  // absent from the feed.
  it("returns null when no provider carries models", () => {
    expect(parsePriceCatalog('{"anthropic":{"id":"anthropic"}}')).toBeNull();
    expect(parsePriceCatalog("{}")).toBeNull();
    expect(parsePriceCatalog(feed({ anthropic: {} }))).toBeNull();
  });

  it("skips a modelless provider while keeping the rest", () => {
    const catalog = parsePriceCatalog(
      '{"empty":{"id":"empty"},"anthropic":{"models":{"claude-sonnet-5":{"cost":{"input":2}}}}}',
    );
    expect(catalog?.has("empty")).toBe(false);
    expect(catalog?.get("anthropic")?.get("claude-sonnet-5")?.input).toBe(2);
  });
});
