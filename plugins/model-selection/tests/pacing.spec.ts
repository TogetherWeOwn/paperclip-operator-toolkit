import { describe, expect, it } from "vitest";

import {
  activeOperatorOverride,
  hardStopExcluded,
  mergeLedgerEntry,
  orderCandidatesByPace,
  recordOperatorOverride,
  repinAllowed,
  slotAllowed,
  slotFactorFor,
  type LaneLedger,
} from "../src/engine/pacing.js";
import type { Candidate, ModelEntry } from "../src/engine/types.js";
import type { LanePaceVerdict } from "../src/lane-capacity/pace.js";

function verdict(overrides: Partial<LanePaceVerdict> = {}): LanePaceVerdict {
  return {
    laneId: "lane-a",
    observedAt: "2026-08-31T12:00:00.000Z",
    state: "on",
    serviceable: true,
    score: { utilization: 0.5, elapsed: 0.5, deviation: 0 },
    accounts: [],
    knownAccountCount: 1,
    knownWeight: 1,
    serviceableAccountCount: 1,
    urgentResetAt: null,
    reason: "ok",
    ...overrides,
  };
}

function model(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id: "m1",
    tier: "T1",
    enabled: true,
    costPerMTokIn: 1,
    costPerMTokOut: 1,
    costPerMTokCacheRead: 1,
    capabilities: [],
    contextWindow: 200_000,
    aaIndex: null,
    releasedAt: "2026-01-01",
    fallbackOnly: false,
    note: "",
    earnIn: null,
    laneId: "lane-a",
    ...overrides,
  };
}

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    modelId: "m1",
    tier: "T1",
    releasedAt: "2026-01-01",
    fallbackOnly: false,
    expectedCostUsd: 1,
    runCostUsd: 1,
    inputCostUsd: 0,
    outputCostUsd: 0,
    cacheReadCostUsd: 0,
    escalationRiskUsd: 0,
    profileTier: "T1",
    profileTrusted: true,
    ...overrides,
  };
}

describe("mergeLedgerEntry", () => {
  it("never lets a failed poll overwrite a good verdict with a fabricated one — a failure always records null", () => {
    // Named mutant: "stale snapshot used". A prior poll returned a good
    // verdict; this poll failed. The merge must record the FAILURE (verdict
    // null, error set), never silently keep serving the old good verdict
    // relabeled as fresh, and never invent a new verdict out of the failure.
    let ledger: LaneLedger = {};
    ledger = mergeLedgerEntry(ledger, {
      laneId: "lane-a",
      fetchedAt: "2026-08-31T12:00:00.000Z",
      verdict: verdict({ state: "behind" }),
      error: null,
    });
    expect(ledger["lane-a"]!.verdict!.state).toBe("behind");

    ledger = mergeLedgerEntry(ledger, {
      laneId: "lane-a",
      fetchedAt: "2026-08-31T12:05:00.000Z",
      verdict: null,
      error: "lane-request-timeout",
    });
    expect(ledger["lane-a"]!.verdict).toBeNull();
    expect(ledger["lane-a"]!.error).toBe("lane-request-timeout");
  });

  it("keys strictly by laneId — one lane's entry never leaks into another's", () => {
    // Named mutant: "lane key logged" (a poll result attributed to the wrong
    // lane). Merging a result for lane-b must not disturb lane-a's entry.
    let ledger: LaneLedger = {};
    ledger = mergeLedgerEntry(ledger, {
      laneId: "lane-a",
      fetchedAt: "t1",
      verdict: verdict({ laneId: "lane-a", state: "behind" }),
      error: null,
    });
    ledger = mergeLedgerEntry(ledger, {
      laneId: "lane-b",
      fetchedAt: "t2",
      verdict: verdict({ laneId: "lane-b", state: "ahead" }),
      error: null,
    });
    expect(ledger["lane-a"]!.verdict!.state).toBe("behind");
    expect(ledger["lane-b"]!.verdict!.state).toBe("ahead");
    expect(Object.keys(ledger).sort()).toEqual(["lane-a", "lane-b"]);
  });
});

describe("orderCandidatesByPace", () => {
  it("never lets pace move a candidate ahead of one in a cheaper/more-restrictive tier", () => {
    // Named mutant: "pace crosses tiers". A T2 candidate with a perfect pace
    // score (behind-urgent) must never sort ahead of a T1 candidate, however
    // bad the T1 lane's pace state is (exhausted-adjacent "ahead" here).
    // Group order comes from first-appearance in the (already cost-sorted)
    // input array — T1 appears first here, matching select.ts's own ordering.
    const models = [
      model({ id: "t1-model", tier: "T1", laneId: "lane-t1" }),
      model({ id: "t2-model", tier: "T2", laneId: "lane-t2" }),
    ];
    const ledger: LaneLedger = {
      "lane-t1": { laneId: "lane-t1", fetchedAt: "t", error: null, verdict: verdict({ laneId: "lane-t1", state: "ahead" }) },
      "lane-t2": { laneId: "lane-t2", fetchedAt: "t", error: null, verdict: verdict({ laneId: "lane-t2", state: "behind-urgent" }) },
    };
    const candidates = [
      candidate({ modelId: "t1-model", tier: "T1", expectedCostUsd: 1 }),
      candidate({ modelId: "t2-model", tier: "T2", expectedCostUsd: 1 }),
    ];
    const ordered = orderCandidatesByPace(candidates, models, ledger);
    expect(ordered.map((c) => c.modelId)).toEqual(["t1-model", "t2-model"]);
  });

  it("orders within a tier by pace state, then deviation, then cost, then release date, then id", () => {
    const models = [
      model({ id: "behind-model", tier: "T1", laneId: "lane-behind" }),
      model({ id: "ahead-model", tier: "T1", laneId: "lane-ahead" }),
    ];
    const ledger: LaneLedger = {
      "lane-behind": { laneId: "lane-behind", fetchedAt: "t", error: null, verdict: verdict({ laneId: "lane-behind", state: "behind" }) },
      "lane-ahead": { laneId: "lane-ahead", fetchedAt: "t", error: null, verdict: verdict({ laneId: "lane-ahead", state: "ahead" }) },
    };
    const candidates = [
      candidate({ modelId: "ahead-model", tier: "T1", expectedCostUsd: 0.5 }),
      candidate({ modelId: "behind-model", tier: "T1", expectedCostUsd: 2 }),
    ];
    const ordered = orderCandidatesByPace(candidates, models, ledger);
    expect(ordered[0]!.modelId).toBe("behind-model");
  });

  it("prefers the newer releasedAt on an exact tie of everything else, matching select.ts's own tie-break", () => {
    const models = [
      model({ id: "older-model", tier: "T1", laneId: "lane-a", releasedAt: "2025-01-01" }),
      model({ id: "newer-model", tier: "T1", laneId: "lane-a", releasedAt: "2026-01-01" }),
    ];
    const ledger: LaneLedger = {
      "lane-a": { laneId: "lane-a", fetchedAt: "t", error: null, verdict: verdict({ state: "on" }) },
    };
    const candidates = [
      candidate({ modelId: "older-model", tier: "T1", expectedCostUsd: 1, releasedAt: "2025-01-01" }),
      candidate({ modelId: "newer-model", tier: "T1", expectedCostUsd: 1, releasedAt: "2026-01-01" }),
    ];
    const ordered = orderCandidatesByPace(candidates, models, ledger);
    expect(ordered[0]!.modelId).toBe("newer-model");
  });
});

describe("hardStopExcluded", () => {
  it("excludes a model whose lane is unserviceable", () => {
    const ledger: LaneLedger = {
      "lane-a": { laneId: "lane-a", fetchedAt: "t", error: null, verdict: verdict({ serviceable: false, state: "exhausted" }) },
    };
    expect(hardStopExcluded(ledger, model({ laneId: "lane-a" }))).toBe(true);
  });

  it("is fail-neutral: an unpolled or unknown lane excludes nothing", () => {
    const ledger: LaneLedger = {};
    expect(hardStopExcluded(ledger, model({ laneId: "lane-a" }))).toBe(false);
    const unknownLedger: LaneLedger = {
      "lane-a": { laneId: "lane-a", fetchedAt: "t", error: null, verdict: verdict({ serviceable: null, state: "unknown" }) },
    };
    expect(hardStopExcluded(unknownLedger, model({ laneId: "lane-a" }))).toBe(false);
  });
});

describe("slotFactorFor / slotAllowed", () => {
  it("never drops a serviceable ahead lane's slot factor to zero, however low the configured floor", () => {
    // Named mutant: "slot factor reaches zero". Even a floor of 0 must clamp to
    // a strictly-positive epsilon — the invariant is "never zero", not
    // "whatever the config says".
    const ledger: LaneLedger = {
      "lane-a": { laneId: "lane-a", fetchedAt: "t", error: null, verdict: verdict({ state: "ahead" }) },
    };
    const factor = slotFactorFor(ledger, model({ laneId: "lane-a" }), 0);
    expect(factor).toBeGreaterThan(0);
  });

  it("gives full slot share to any state other than ahead", () => {
    const ledger: LaneLedger = {
      "lane-a": { laneId: "lane-a", fetchedAt: "t", error: null, verdict: verdict({ state: "behind" }) },
    };
    expect(slotFactorFor(ledger, model({ laneId: "lane-a" }), 0.25)).toBe(1);
  });

  it("is deterministic per issue id — the same issue always lands on the same side of the cap", () => {
    const ledger: LaneLedger = {
      "lane-a": { laneId: "lane-a", fetchedAt: "t", error: null, verdict: verdict({ state: "ahead" }) },
    };
    const m = model({ laneId: "lane-a" });
    const first = slotAllowed("issue-42", ledger, m, 0.25);
    const second = slotAllowed("issue-42", ledger, m, 0.25);
    expect(first).toBe(second);
  });
});

describe("operator overrides", () => {
  it("does not honor an expired override — an expired entry is treated as if none existed", () => {
    // Named mutant: "expired override honored".
    const overrides = recordOperatorOverride({}, "issue-1", "claude-opus-5", "2026-08-31T12:00:00.000Z", 60);
    const live = activeOperatorOverride(overrides, "issue-1", "2026-08-31T12:00:30.000Z");
    expect(live?.modelId).toBe("claude-opus-5");
    const expired = activeOperatorOverride(overrides, "issue-1", "2026-08-31T12:01:01.000Z");
    expect(expired).toBeNull();
  });
});

describe("repinAllowed", () => {
  const context = {
    hasOperatorPin: false,
    isIdle: true,
    lastRepinAt: null as string | null,
    now: "2026-08-31T12:00:00.000Z",
    idleRepinHysteresisSeconds: 300,
    isServiceabilityHardStop: false,
  };

  it("never repins an issue with a running or queued run", () => {
    // Named mutant: "running card repinned".
    const gate = repinAllowed({ ...context, isIdle: false });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("running or queued run");
  });

  it("lets pin:operator survive a routine pace repin", () => {
    const gate = repinAllowed({ ...context, hasOperatorPin: true });
    expect(gate.allowed).toBe(false);
  });

  it("forces a repin through pin:operator when it is a serviceability hard stop", () => {
    const gate = repinAllowed({ ...context, hasOperatorPin: true, isServiceabilityHardStop: true });
    expect(gate.allowed).toBe(true);
  });

  it("blocks a repin inside the idle-repin hysteresis window", () => {
    const gate = repinAllowed({
      ...context,
      lastRepinAt: "2026-08-31T11:58:00.000Z",
    });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("hysteresis");
  });

  it("allows a repin once past the hysteresis window", () => {
    const gate = repinAllowed({
      ...context,
      lastRepinAt: "2026-08-31T11:50:00.000Z",
    });
    expect(gate.allowed).toBe(true);
  });
});
