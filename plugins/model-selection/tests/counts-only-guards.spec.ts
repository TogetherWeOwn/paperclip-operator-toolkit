import { describe, expect, it } from "vitest";

import { hardStopExcluded, mergeLedgerEntry, type LaneLedger } from "../src/engine/pacing.js";
import { selectModel } from "../src/engine/select.js";
import { evaluateLanePace, normalizeLaneDocument, type LanePaceDefinition } from "../src/lane-capacity/pace.js";
import { MODELS, NO_ESCALATION, NOW, PROFILES, config } from "./fixtures.js";

const iso = (ms: number) => new Date(ms).toISOString();

// Synthetic ALLOWANCE documents, not a claim about the current producer schema.
// A counts-only exception must not be inferred from a lane name or null utilization.
describe.each(["cliproxy-xai", "cliproxy-devin"])("counts-only boundary: %s", (laneId) => {
  const definition: LanePaceDefinition = {
    laneId,
    healthFields: ["health"],
    accountKeyFields: ["account_key"],
    weightFields: ["plan_weight"],
    windows: [{ name: "weekly", role: "allowance", utilizationFields: [], resetFields: [] }],
  };
  const baseline = MODELS.find((model) => model.tier === "T1")!;
  const cheap = {
    ...baseline,
    id: "cheap-allowance-model",
    laneId,
    costPerMTokIn: 0.1,
    costPerMTokOut: 0.1,
    costPerMTokCacheRead: 0.1,
  };
  const alternative = { ...baseline, id: "healthy-alternative" };

  function document(utilization: unknown, windowOverrides: Record<string, unknown> = {}) {
    return {
      observedAt: iso(NOW),
      staleAfterSeconds: 900,
      records: [{
        account_key: "synthetic-account",
        health: "healthy",
        plan_weight: 1,
        governing_window: "weekly",
        windows: [{
          name: "weekly",
          role: "allowance",
          utilization,
          resets_at: iso(NOW + 48 * 3600_000),
          window_seconds: 604_800,
          allowance_weight: 1,
          ...windowOverrides,
        }],
      }],
    };
  }

  function evaluate(raw: unknown) {
    const observation = normalizeLaneDocument({ document: raw, definition });
    const verdict = evaluateLanePace({ observation, asOf: iso(NOW) });
    const ledger = mergeLedgerEntry({}, {
      laneId,
      observation,
      verdict,
      fetchedAt: iso(NOW),
      error: null,
    });
    return { observation, verdict, ledger };
  }

  function select(ledger: LaneLedger) {
    return selectModel({
      profiles: PROFILES,
      signals: NO_ESCALATION,
      now: NOW,
      descriptor: { issueId: "counts-only-guard", labelNames: ["tier:T1"] },
      config: config({ models: [cheap, alternative], laneLedger: ledger, pacingMode: "enforce" }),
    });
  }

  it("keeps zero allowance utilization computable, rather than treating zero as absent", () => {
    const result = evaluate(document(0));
    expect(result.observation.accounts[0]?.windows[0]?.utilization).toBe(0);
    expect(result.verdict).toMatchObject({ serviceable: true, reason: "ok", score: { utilization: 0 } });
    expect(result.verdict.accounts[0]?.governingWindow).toBe("weekly");
    expect(result.verdict.targetBurnRate).toBeGreaterThan(0);
    expect(hardStopExcluded(result.ledger, cheap)).toBe(false);
    expect(select(result.ledger).modelId).toBe(cheap.id);
  });

  it.each([undefined, null, NaN, Infinity, -Infinity, "0.2"])(
    "keeps unreadable allowance utilization (%s) indeterminate and out of selection",
    (utilization) => {
      const result = evaluate(document(utilization));
      expect(result.observation.accounts[0]?.windows[0]?.utilization).toBeNull();
      expect(result.verdict).toMatchObject({
        serviceable: null,
        reason: "invalid-configured-governing-window",
        score: null,
        targetBurnRate: null,
        serviceableAccountCount: 0,
      });
      expect(hardStopExcluded(result.ledger, cheap)).toBe(true);
      expect(select(result.ledger).modelId).toBe(alternative.id);
    },
  );

  it("does not rescue zero utilization with a missing reset as counts-only", () => {
    const result = evaluate(document(0, { resets_at: null }));
    expect(result.verdict).toMatchObject({ serviceable: null, reason: "invalid-configured-governing-window", score: null });
    expect(hardStopExcluded(result.ledger, cheap)).toBe(true);
    expect(select(result.ledger).modelId).toBe(alternative.id);
  });

  it("keeps a genuinely spent allowance excluded", () => {
    const result = evaluate(document(1));
    expect(result.verdict).toMatchObject({ serviceable: false, state: "exhausted", serviceableAccountCount: 0 });
    expect(hardStopExcluded(result.ledger, cheap)).toBe(true);
    expect(select(result.ledger).modelId).toBe(alternative.id);
  });

  it("does not turn a stale allowance sample into positive serviceability", () => {
    const result = evaluate({ ...document(0), observedAt: iso(NOW - 901_000) });
    expect(result.verdict).toMatchObject({ serviceable: null, reason: "snapshot-stale", score: null, serviceableAccountCount: 0 });
  });

  it.each([null, { observedAt: iso(NOW), records: [null] }, { observedAt: "invalid", records: [] }])(
    "does not turn a malformed source into positive serviceability",
    (raw) => {
      const result = evaluate(raw);
      expect(result.verdict).toMatchObject({ serviceable: null, reason: "document-unavailable", score: null, serviceableAccountCount: 0 });
    },
  );

  it("preserves a real hard stop across a failed fetch", () => {
    const exhausted = evaluate(document(1));
    const ledger = mergeLedgerEntry(exhausted.ledger, {
      laneId,
      observation: null,
      verdict: null,
      fetchedAt: iso(NOW + 60_000),
      error: "lane-request-failed",
    });
    expect(hardStopExcluded(ledger, cheap)).toBe(true);
    expect(select(ledger).modelId).toBe(alternative.id);
  });
});
