import { describe, expect, it } from "vitest";

import {
  LANE_PRICE_PROVIDERS,
  bareModelId,
  matchRosterRow,
  priceExclusionReason,
} from "../../src/price-sync/match.js";

const CATALOG = new Map<string, Map<string, unknown>>([
  ["anthropic", new Map([["claude-sonnet-5", {}]])],
  ["moonshotai", new Map([["kimi-k2.6", {}]])],
  ["opencode-go", new Map([["kimi-k2.6", {}]])],
  ["meta", new Map([["muse-spark-1.3", {}]])],
]);

describe("bareModelId", () => {
  it("strips a provider prefix", () => {
    expect(bareModelId("cliproxy/claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(bareModelId("opencode-go/glm-5.3")).toBe("glm-5.3");
  });

  it("leaves an unprefixed id alone", () => {
    expect(bareModelId("gpt-5.5")).toBe("gpt-5.5");
  });

  // models.dev keys are the vendor's own ids, dots and case included.
  // Normalizing them would break the match rather than fix it.
  it("does not normalize case or punctuation", () => {
    expect(bareModelId("glm-4.5v")).toBe("glm-4.5v");
    expect(bareModelId("Claude-Sonnet-5")).toBe("Claude-Sonnet-5");
  });
});

describe("priceExclusionReason", () => {
  it("excludes every devin/* row: Devin meters by subscription, not per token", () => {
    expect(priceExclusionReason("devin/devin-1")).toBe("metered-not-per-token");
    expect(priceExclusionReason("devin/devin-2-turbo")).toBe("metered-not-per-token");
  });

  it("excludes -free rows, where 0 is the true price and not a missing one", () => {
    expect(priceExclusionReason("opencode-go/glm-5.3-free")).toBe("free-tier");
    expect(priceExclusionReason("muse-spark-1.3-contributor-free")).toBe("free-tier");
  });

  // Absence from the feed is not evidence of a wrong price. These six were
  // checked by hand against historical rate cards on 2026-09-22.
  it("excludes the six verified retired Anthropic ids, prefixed or not", () => {
    for (const id of [
      "claude-3-5-haiku-20241022",
      "claude-3-7-sonnet-20250219",
      "claude-opus-4-1-20250805",
      "claude-opus-4-20250514",
      "claude-sonnet-4-20250514",
      "claude-opus-4-6-thinking",
    ]) {
      expect(priceExclusionReason(id)).toBe("retired-verified");
      expect(priceExclusionReason(`cliproxy/${id}`)).toBe("retired-verified");
    }
  });

  it("excludes the per-image models, which $/Mtok does not describe", () => {
    expect(priceExclusionReason("gpt-image-1.5")).toBe("per-image");
    expect(priceExclusionReason("cliproxy/gpt-image-2")).toBe("per-image");
  });

  it("does not exclude an ordinary priced row", () => {
    expect(priceExclusionReason("cliproxy/claude-sonnet-5")).toBeNull();
    expect(priceExclusionReason("muse-spark-1.3")).toBeNull();
    // A live id that merely contains a retired one's prefix stays in scope.
    expect(priceExclusionReason("claude-opus-4-6")).toBeNull();
  });
});

describe("matchRosterRow", () => {
  // The load-bearing invariant: the provider comes from the lane. `kimi-k2.6`
  // is on both moonshotai and opencode-go at different rates, so an id-only
  // search returns the wrong number about as often as the right one.
  it("resolves the provider from the laneId, not from the model id", () => {
    const viaKimi = matchRosterRow({ modelId: "kimi-k2.6", laneId: "cliproxy-kimi" }, CATALOG);
    const viaOpencode = matchRosterRow({ modelId: "kimi-k2.6", laneId: "cliproxy-opencode-go" }, CATALOG);
    expect(viaKimi).toEqual({ kind: "matched", providerId: "moonshotai", bareId: "kimi-k2.6" });
    expect(viaOpencode).toEqual({ kind: "matched", providerId: "opencode-go", bareId: "kimi-k2.6" });
  });

  it("matches on the bare id after stripping a provider prefix", () => {
    expect(matchRosterRow({ modelId: "cliproxy/claude-sonnet-5", laneId: "cliproxy-claude" }, CATALOG)).toEqual({
      kind: "matched",
      providerId: "anthropic",
      bareId: "claude-sonnet-5",
    });
  });

  it("carries the whole audited lane mapping", () => {
    expect(LANE_PRICE_PROVIDERS).toEqual({
      "cliproxy-claude": "anthropic",
      "cliproxy-codex": "openai",
      "cliproxy-meta": "meta",
      "cliproxy-zai": "zhipuai",
      "cliproxy-kimi": "moonshotai",
      "cliproxy-opencode-go": "opencode-go",
    });
  });

  // Checked before any feed lookup: an excluded row must not produce a
  // finding even when the feed carries an id that looks like it.
  it("excludes before looking anything up in the feed", () => {
    expect(matchRosterRow({ modelId: "meta/muse-spark-1.3-free", laneId: "cliproxy-meta" }, CATALOG)).toEqual({
      kind: "excluded",
      reason: "free-tier",
    });
    expect(matchRosterRow({ modelId: "devin/devin-1", laneId: "cliproxy-claude" }, CATALOG)).toEqual({
      kind: "excluded",
      reason: "metered-not-per-token",
    });
  });

  it("excludes a note-marked free offer even when a mapped provider lists a paid namesake", () => {
    const catalog = new Map([["opencode-go", new Map([["big-pickle", {}]])]]);
    expect(matchRosterRow({
      modelId: "opencode-go/big-pickle", laneId: "cliproxy-opencode-go", note: "free Zen model",
    }, catalog)).toEqual({ kind: "excluded", reason: "free-tier" });
    expect(matchRosterRow({
      modelId: "opencode-go/big-pickle", laneId: "cliproxy-opencode-go",
    }, catalog)).toEqual({ kind: "matched", providerId: "opencode-go", bareId: "big-pickle" });
  });

  // Three distinct non-matches, never collapsed into one silent skip.
  it("reports a row with no lane as unresolved rather than guessing a provider", () => {
    expect(matchRosterRow({ modelId: "claude-sonnet-5", laneId: null }, CATALOG)).toEqual({ kind: "no-lane" });
  });

  it("reports an unmapped lane rather than guessing a provider", () => {
    expect(matchRosterRow({ modelId: "claude-sonnet-5", laneId: "cliproxy-brand-new" }, CATALOG)).toEqual({
      kind: "unmapped-lane",
      laneId: "cliproxy-brand-new",
    });
  });

  it("distinguishes absent-from-feed from every other outcome", () => {
    expect(matchRosterRow({ modelId: "claude-sonnet-99", laneId: "cliproxy-claude" }, CATALOG)).toEqual({
      kind: "absent-from-feed",
      providerId: "anthropic",
      bareId: "claude-sonnet-99",
    });
  });

  // A model priced under a DIFFERENT provider is absent under this one. It
  // must not silently fall through to the other provider's number.
  it("does not fall back to another provider when the lane's provider lacks the model", () => {
    expect(matchRosterRow({ modelId: "muse-spark-1.3", laneId: "cliproxy-claude" }, CATALOG)).toEqual({
      kind: "absent-from-feed",
      providerId: "anthropic",
      bareId: "muse-spark-1.3",
    });
  });
});
