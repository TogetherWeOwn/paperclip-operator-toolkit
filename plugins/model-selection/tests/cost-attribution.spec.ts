import { describe, expect, it } from "vitest";
import {
  attributableCostUsd,
  classifyCostAttribution,
  isAnthropicModelId,
} from "../src/engine/cost-attribution.js";
import { buildCardLedger, type CardRow } from "../src/engine/scores.js";
import { REFRESH_SCORE_CLOSING_RUNS_SQL, REFRESH_SCORE_RUNS_SQL } from "../src/sql.js";

/**
 * The regression these guard is: `heartbeat_runs.usage_json` carries
 * the *serving CLI's* cost figure plus a hardcoded `provider: "anthropic"`
 * from `claude-local`, so every CLIProxy-served non-Anthropic model lands an
 * Anthropic-priced cost that the card ledger then averages into
 * `costPerAcceptedCard` and routes on.
 *
 * Model ids below are the real ones observed on this company's
 * `/costs/by-provider` rows for the 7d to 2026-09-22.
 */
describe("isAnthropicModelId", () => {
  it.each([
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-haiku-4-5-20251001",
    "claude-fable-5-1",
    "cliproxy/claude-sonnet-5",
    "anthropic/claude-opus-5",
  ])("accepts the anthropic-served id %s", (id) => {
    expect(isAnthropicModelId(id)).toBe(true);
  });

  it.each([
    "muse-spark-1.3-contributor",
    "muse-spark-1.2-contributor",
    "gpt-6-astra",
    "gpt-5.6-sol",
    "glm-5.3",
    "devin/deepseek-v4-flash",
    "devin/gpt-5-6-sol",
    "openai/gpt-oss-20b",
    "qwen3.8-max",
  ])("rejects the non-anthropic id %s", (id) => {
    expect(isAnthropicModelId(id)).toBe(false);
  });

  it("matches the id namespace, never a substring", () => {
    // A vendor could ship an id that merely contains "claude"; passing it
    // would reopen exactly the misattribution this module closes.
    expect(isAnthropicModelId("muse-spark-claude-compat")).toBe(false);
    expect(isAnthropicModelId("zai/claude-proxy")).toBe(false);
    expect(isAnthropicModelId("notclaude-5")).toBe(false);
  });
});

describe("classifyCostAttribution", () => {
  it("rejects an anthropic-priced run on a non-anthropic model", () => {
    const verdict = classifyCostAttribution("muse-spark-1.3-contributor", "anthropic");
    expect(verdict.attributable).toBe(false);
    expect(verdict.reason).toContain("muse-spark-1.3-contributor");
  });

  it("accepts an anthropic-priced run on an anthropic model", () => {
    expect(classifyCostAttribution("claude-opus-5", "anthropic").attributable).toBe(true);
  });

  it("leaves every non-anthropic provider alone", () => {
    // These adapters price with their own tables, so the recorded cost is
    // real evidence and must not be discarded as collateral.
    expect(classifyCostAttribution("gpt-5.6-sol", "openai").attributable).toBe(true);
    expect(classifyCostAttribution("glm-5.3", "zai").attributable).toBe(true);
    expect(classifyCostAttribution("deepseek-v4-flash", "deepseek").attributable).toBe(true);
  });

  it("treats a missing provider as attributable, not as misattributed", () => {
    // Absence is not evidence of misattribution; rejecting it would silently
    // discard every run recorded before provider capture existed.
    expect(classifyCostAttribution("muse-spark-1.3-contributor", null).attributable).toBe(true);
    expect(classifyCostAttribution("muse-spark-1.3-contributor", "").attributable).toBe(true);
    expect(classifyCostAttribution("muse-spark-1.3-contributor", "   ").attributable).toBe(true);
  });

  it("normalizes provider case and padding", () => {
    expect(classifyCostAttribution("muse-spark-1.3-contributor", " Anthropic ").attributable).toBe(
      false,
    );
  });
});

describe("attributableCostUsd", () => {
  it("nulls a misattributed cost and preserves an attributable one", () => {
    expect(attributableCostUsd("muse-spark-1.3-contributor", "anthropic", 2.867)).toBeNull();
    expect(attributableCostUsd("claude-opus-5", "anthropic", 4.256)).toBe(4.256);
    expect(attributableCostUsd("gpt-6-astra", "openai", 2.598)).toBe(2.598);
  });

  it("keeps a real zero rather than collapsing it to unknown", () => {
    expect(attributableCostUsd("glm-5.3", "zai", 0)).toBe(0);
  });

  it("passes an already-null cost straight through", () => {
    expect(attributableCostUsd("claude-opus-5", "anthropic", null)).toBeNull();
  });
});

describe("the refresh queries expose the provider the guard needs", () => {
  // Without these columns the worker has nothing to classify on and the guard
  // silently degrades to "always attributable".
  it.each([
    ["REFRESH_SCORE_RUNS_SQL", REFRESH_SCORE_RUNS_SQL],
    ["REFRESH_SCORE_CLOSING_RUNS_SQL", REFRESH_SCORE_CLOSING_RUNS_SQL],
  ])("%s selects usage_json->>'provider' as provider", (_name, sql) => {
    expect(sql).toContain("usage_json->>'provider'");
    expect(sql).toMatch(/as provider/);
  });
});

describe("card ledger under the guard", () => {
  const card = (over: Partial<CardRow>): CardRow => ({
    modelId: "muse-spark-1.3-contributor",
    tier: "T1",
    closedAtMs: 0,
    rejected: false,
    costUsd: null,
    runCount: 1,
    foreignRun: false,
    ...over,
  });

  // Well past CARD_CENSOR_DAYS so every card below is resolved, not pending.
  const nowMs = 1_000 * 60 * 60 * 24 * 365;
  const closedLongAgo = nowMs - 1_000 * 60 * 60 * 24 * 60;

  it("reports an unknown cost rather than an anthropic-priced one", () => {
    // The pre-fix behaviour: 2.867/card for Muse against astra's 2.598, which
    // inverts the true ordering (0.031 vs 6.188 on this company's own T1
    // volume profile) and makes the expensive model look like the saving.
    const poisoned = [2.867, 2.867, 2.867].map((costUsd) =>
      card({ costUsd, closedAtMs: closedLongAgo }),
    );
    const beforeFix = buildCardLedger(poisoned, nowMs, {}, {})["muse-spark-1.3-contributor:T1"];
    if (!beforeFix) throw new Error("missing ledger entry muse-spark-1.3-contributor:T1");
    expect(beforeFix.costPerCard).toBeCloseTo(2.867);

    const guarded = poisoned.map((row) => ({
      ...row,
      costUsd: attributableCostUsd(row.modelId, "anthropic", row.costUsd),
    }));
    const entry = buildCardLedger(guarded, nowMs, {}, {})["muse-spark-1.3-contributor:T1"];
    if (!entry) throw new Error("missing ledger entry muse-spark-1.3-contributor:T1");
    expect(entry.costPerCard).toBeNull();
    expect(entry.costPerAcceptedCard).toBeNull();
    // Acceptance evidence survives: only the cost term is invalidated.
    expect(entry.cardsClosed).toBe(3);
    expect(entry.acceptRate).toBe(1);
    expect(entry.pending).toBe(false);
  });

  it("does not disturb a correctly-attributed model's cost", () => {
    const rows = [4.2, 4.4].map((costUsd) =>
      card({ modelId: "claude-opus-5", costUsd, closedAtMs: closedLongAgo }),
    );
    const guarded = rows.map((row) => ({
      ...row,
      costUsd: attributableCostUsd(row.modelId, "anthropic", row.costUsd),
    }));
    const entry = buildCardLedger(guarded, nowMs, {}, {})["claude-opus-5:T1"];
    if (!entry) throw new Error("missing ledger entry claude-opus-5:T1");
    expect(entry.costPerCard).toBeCloseTo(4.3);
  });
});
