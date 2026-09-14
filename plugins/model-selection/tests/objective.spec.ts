import { describe, expect, it } from "vitest";

import { selectModel } from "../src/engine/select.js";
import { orderByObjective } from "../src/engine/objective.js";
import type { Candidate, CardLedgerEntry } from "../src/engine/types.js";
import { MODELS, NO_ESCALATION, NOW, PROFILES, config } from "./fixtures.js";

const base = { profiles: PROFILES, signals: NO_ESCALATION, now: NOW };

function candidate(overrides: Partial<Candidate>): Candidate {
  return {
    modelId: "m",
    runCostUsd: 1,
    inputCostUsd: 1,
    cacheReadCostUsd: 0,
    outputCostUsd: 0,
    escalationRiskUsd: 0,
    expectedCostUsd: 1,
    profileTier: "T1",
    profileTrusted: true,
    tier: "T1",
    releasedAt: "2026-01-01",
    fallbackOnly: false,
    ...overrides,
  };
}

describe("selection.objective default (list-price) leaves selection untouched", () => {
  it("picks the same winner as before objective existed", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T3"] },
      config: config(),
    });
    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe("claude-haiku-4-5-20251001");
  });

  it("never changes decision.modelId even when the ledger favors a different candidate", () => {
    const ledger: Record<string, CardLedgerEntry> = {
      "claude-haiku-4-5-20251001:T3": {
        modelId: "claude-haiku-4-5-20251001",
        tier: "T3",
        cardsClosed: 10,
        acceptRate: 0.4,
        costPerCard: 0.1,
        runsPerCard: 1,
        foreignRunShare: 0,
        costPerAcceptedCard: 0.1 / 0.4, // expensive per accepted card
        pending: false,
      },
      "claude-opus-5:T3": {
        modelId: "claude-opus-5",
        tier: "T3",
        cardsClosed: 10,
        acceptRate: 0.99,
        costPerCard: 2.8,
        runsPerCard: 1,
        foreignRunShare: 0,
        costPerAcceptedCard: 2.8 / 0.99,
        pending: false,
      },
    };
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T3"] },
      config: config(), // objective left at default (list-price)
      cardLedger: ledger,
    });
    expect(decision.modelId).toBe("claude-haiku-4-5-20251001"); // list-price winner, unchanged
    expect(decision.shadowDiff).not.toBeNull();
    expect(decision.shadowDiff?.listPriceWinner).toBe("claude-haiku-4-5-20251001");
  });
});

describe("orderByObjective — Slice 3 pure ordering", () => {
  it("is a no-op for list-price (same array contents/order)", () => {
    const candidates = [candidate({ modelId: "b", expectedCostUsd: 2 }), candidate({ modelId: "a", expectedCostUsd: 1 })];
    const result = orderByObjective(candidates, "list-price", {});
    expect(result).toEqual(candidates);
  });

  it("orders by costPerAcceptedCard when objective is cost-per-accepted-card", () => {
    const candidates = [candidate({ modelId: "cheap-list-price" }), candidate({ modelId: "expensive-list-price" })];
    const ledger: Record<string, CardLedgerEntry> = {
      "cheap-list-price:T1": {
        modelId: "cheap-list-price",
        tier: "T1",
        cardsClosed: 5,
        acceptRate: 0.2,
        costPerCard: 1,
        runsPerCard: 1,
        foreignRunShare: 0,
        costPerAcceptedCard: 5, // 1/0.2
        pending: false,
      },
      "expensive-list-price:T1": {
        modelId: "expensive-list-price",
        tier: "T1",
        cardsClosed: 5,
        acceptRate: 0.95,
        costPerCard: 2,
        runsPerCard: 1,
        foreignRunShare: 0,
        costPerAcceptedCard: 2.105,
        pending: false,
      },
    };
    const result = orderByObjective(candidates, "cost-per-accepted-card", ledger);
    expect(result[0]?.modelId).toBe("expensive-list-price");
  });

  it("falls back to the original order when no candidate has a ledger entry", () => {
    const candidates = [candidate({ modelId: "a" }), candidate({ modelId: "b" })];
    const result = orderByObjective(candidates, "cost-per-accepted-card", {});
    expect(result).toEqual(candidates);
  });
});

describe("shadow diff", () => {
  it("computes agree=true when both objectives pick the same model", () => {
    const ledger: Record<string, CardLedgerEntry> = {
      "claude-haiku-4-5-20251001:T3": {
        modelId: "claude-haiku-4-5-20251001",
        tier: "T3",
        cardsClosed: 10,
        acceptRate: 0.99,
        costPerCard: 0.1,
        runsPerCard: 1,
        foreignRunShare: 0,
        costPerAcceptedCard: 0.1 / 0.99,
        pending: false,
      },
    };
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T3"] },
      config: config(),
      cardLedger: ledger,
    });
    expect(decision.shadowDiff?.agree).toBe(true);
  });

  it("is null when there is no ledger entry for any candidate", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T3"] },
      config: config(),
    });
    expect(decision.shadowDiff).toBeNull();
  });
});
