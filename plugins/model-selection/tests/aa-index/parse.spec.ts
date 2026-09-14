import { describe, expect, it } from "vitest";

import { parseAaLeaderboardHtml, type AaModelRecord } from "../../src/aa-index/parse.js";

/**
 * Builds a minimal HTML fixture that mimics aa.ai's Next.js RSC embedding: the
 * metrics array is JSON, embedded as a doubly-escaped string inside a
 * `self.__next_f.push([1, "..."])` script tag. This mirrors how the real page
 * escapes every JSON quote to `\"` — never a bare `"` inside the payload.
 */
function buildHtml(models: ReadonlyArray<Record<string, unknown>>, trailing = ""): string {
  const inner = JSON.stringify({ models });
  const escaped = inner.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `<script>self.__next_f.push([1, "1:[[\\"$\\",\\"div\\",null,{}]]\\n2:${escaped}${trailing}\\n"])</script>`;
}

/** A full null-filled `AaModelRecord`, overridden only where the fixture sets a value. */
function rec(slug: string, overrides: Partial<AaModelRecord> = {}): AaModelRecord {
  return {
    slug,
    name: null,
    shortName: null,
    modelCreatorName: null,
    deprecated: null,
    isReasoning: null,
    isOpenWeights: null,
    paramClass: null,
    priceClass: null,
    intelligenceIndex: null,
    intelligenceIndexIsEstimated: null,
    intelligenceIndexCostPerTask: null,
    price1mInputTokens: null,
    price1mOutputTokens: null,
    cacheHitPrice: null,
    cacheWritePrice: null,
    medianOutputTokensPerSecond: null,
    outputTokensPerSecondP5: null,
    outputTokensPerSecondP25: null,
    outputTokensPerSecondP75: null,
    outputTokensPerSecondP95: null,
    medianTimeToFirstTokenSeconds: null,
    medianTimeToFirstAnswerTokenSeconds: null,
    medianEndToEndResponseTimeSeconds: null,
    medianReasoningTimeSeconds: null,
    contextWindowTokens: null,
    gpqa: null,
    hle: null,
    critpt: null,
    lcr: null,
    ifbench: null,
    tau2: null,
    terminalbenchHard: null,
    mmmuPro: null,
    gdpvalNormalized: null,
    terminalbenchV21: null,
    tauBanking: null,
    scicode: null,
    terminalbenchV40: null,
    itbenchSre: null,
    analystAgent: null,
    apexAgents: null,
    omniscience: null,
    omniscienceAccuracy: null,
    omniscienceNonHallucination: null,
    ...overrides,
  };
}

function idx(slug: string, intelligenceIndex: number): AaModelRecord {
  return rec(slug, { intelligenceIndex });
}

describe("parseAaLeaderboardHtml", () => {
  it("parses a valid embedded payload anchored on the first model", () => {
    const html = buildHtml([
      { slug: "glm-4-5v", intelligenceIndex: 33.2 },
      { slug: "claude-opus-5", intelligenceIndex: 54.1 },
    ]);
    const result = parseAaLeaderboardHtml(html);
    expect(result).toEqual([idx("glm-4-5v", 33.2), idx("claude-opus-5", 54.1)]);
  });

  it("returns null when the anchor is missing entirely", () => {
    const html = "<script>self.__next_f.push([1, \"no leaderboard data here\"])</script>";
    expect(parseAaLeaderboardHtml(html)).toBeNull();
  });

  it("returns null on an unbalanced/truncated array", () => {
    const full = buildHtml([{ slug: "glm-4-5v", intelligenceIndex: 33.2 }]);
    const truncated = full.slice(0, full.length - 30);
    expect(parseAaLeaderboardHtml(truncated)).toBeNull();
  });

  it("ignores trailing non-JSON content after the array's closing bracket", () => {
    // The bracket-balanced extraction stops exactly at the array's closing
    // bracket, so arbitrary JS following it on the same line (as the real RSC
    // payload always has) must not affect parsing at all.
    const html = buildHtml([{ slug: "glm-4-5v", intelligenceIndex: 33.2 }], " some trailing js, not json");
    expect(parseAaLeaderboardHtml(html)).toEqual([idx("glm-4-5v", 33.2)]);
  });

  it("keeps a row with a slug but no numeric intelligenceIndex (still real price/speed data), drops a row with no slug at all", () => {
    const inner = JSON.stringify({
      models: [
        { slug: "glm-4-5v", intelligenceIndex: 33.2 },
        { slug: "no-index", price1mInputTokens: 2 },
        { intelligenceIndex: 40 },
        { slug: "claude-opus-5", intelligenceIndex: 54.1 },
      ],
    });
    const escaped = inner.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const html = `<script>2:${escaped}</script>`;
    expect(parseAaLeaderboardHtml(html)).toEqual([
      idx("glm-4-5v", 33.2),
      rec("no-index", { price1mInputTokens: 2 }),
      idx("claude-opus-5", 54.1),
    ]);
  });

  it("returns null when every row is malformed (no usable slug)", () => {
    const inner = JSON.stringify({ models: [{ intelligenceIndex: 40 }] });
    const escaped = inner.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const html = `<script>2:${escaped}</script>`;
    expect(parseAaLeaderboardHtml(html)).toBeNull();
  });

  it("never throws on adversarial input", () => {
    expect(() => parseAaLeaderboardHtml("")).not.toThrow();
    expect(() => parseAaLeaderboardHtml('{\\"models\\":[{\\"slug\\":\\"glm-4-5v\\"')).not.toThrow();
    expect(parseAaLeaderboardHtml("")).toBeNull();
  });

  it("handles a slug value containing an escaped backslash without corrupting bracket balance", () => {
    const inner = JSON.stringify({
      models: [
        { slug: "glm-4-5v", intelligenceIndex: 10 },
        { slug: "weird\\slug", intelligenceIndex: 99.9 },
      ],
    });
    const escaped = inner.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const html = `<script>2:${escaped}</script>`;
    expect(parseAaLeaderboardHtml(html)).toEqual([idx("glm-4-5v", 10), idx("weird\\slug", 99.9)]);
  });
});
