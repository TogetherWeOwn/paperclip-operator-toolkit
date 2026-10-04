import { describe, expect, it } from "vitest";

import { CARD_CENSOR_DAYS, CARD_ZERO_ACCEPT_MIN_RESOLVED, CARD_ZERO_ACCEPT_WINDOW_DAYS } from "../src/constants.js";
import { orderByObjective } from "../src/engine/objective.js";
import { buildCardLedger, type CardRow, zeroAcceptEvidence as readZeroAcceptEvidence } from "../src/engine/scores.js";
import { selectModel } from "../src/engine/select.js";
import type { Candidate, CardLedgerEntry, ModelEntry } from "../src/engine/types.js";
import { MODELS, NO_ESCALATION, NOW, PROFILES, config } from "./fixtures.js";

const base = { profiles: PROFILES, signals: NO_ESCALATION, now: NOW };
const DAY = 24 * 60 * 60 * 1000;
const EXPIRES = NOW + CARD_ZERO_ACCEPT_WINDOW_DAYS * DAY;

function zeroAcceptEvidence(modelId: string, tier: CardLedgerEntry["tier"], ledger: Record<string, CardLedgerEntry>) {
  return readZeroAcceptEvidence(modelId, tier, ledger, NOW);
}

const opus = MODELS.find((entry) => entry.id === "claude-opus-5")!;

/**
 * Two T1 rows with the same capabilities, so price is the ONLY thing
 * separating them — and the zero-accept row is the cheap one by 25x. Every
 * test below that expects the pricier row to win is therefore testing the
 * gate and nothing else: without it, list price picks `zero-accept` every
 * time.
 */
const ZERO_ACCEPT: ModelEntry = { ...opus, id: "zero-accept", costPerMTokIn: 0.2, costPerMTokOut: 1, costPerMTokCacheRead: 0.02 };
const PROVEN: ModelEntry = { ...opus, id: "proven", costPerMTokIn: 5, costPerMTokOut: 25, costPerMTokCacheRead: 0.5 };

function ledgerEntry(overrides: Partial<CardLedgerEntry> & Pick<CardLedgerEntry, "modelId">): CardLedgerEntry {
  const entry: CardLedgerEntry = {
    tier: "T1",
    cardsClosed: 20,
    cardsResolved: 20,
    cardsAccepted: 18,
    acceptRate: 0.9,
    costPerCard: 2,
    runsPerCard: 1,
    foreignRunShare: 0,
    costPerAcceptedCard: 2 / 0.9,
    pending: false,
    ...overrides,
  };
  return entry;
}

/** A row with zero accepts across enough RESOLVED cards to act on. */
function zeroAcceptRow(overrides: Partial<CardLedgerEntry> = {}): CardLedgerEntry {
  const resolved = CARD_ZERO_ACCEPT_MIN_RESOLVED;
  return ledgerEntry({
    modelId: "zero-accept",
    cardsClosed: resolved,
    cardsResolved: resolved,
    cardsAccepted: 0,
    acceptRate: 0,
    costPerCard: 1.95,
    costPerAcceptedCard: null,
    qualityCohort: {
      cardsResolved: overrides.cardsResolved ?? resolved,
      cardsAccepted: overrides.cardsAccepted ?? 0,
      oldestClosedAtMs: NOW - CARD_CENSOR_DAYS * DAY,
      newestClosedAtMs: NOW - CARD_CENSOR_DAYS * DAY,
      observedAtMs: NOW,
    },
    ...overrides,
  });
}

function decide(cardLedger: Record<string, CardLedgerEntry>, models: ModelEntry[] = [ZERO_ACCEPT, PROVEN]) {
  return selectModel({
    ...base,
    descriptor: { issueId: "card-accept-gate-1", labelNames: ["tier:T1"] },
    config: config({ models }),
    cardLedger,
  });
}

describe("card-accept-rate gate", () => {
  it("never picks a zero-accept model over a proven one, whatever the cost delta", () => {
    const decision = decide({
      "zero-accept:T1": zeroAcceptRow(),
      "proven:T1": ledgerEntry({ modelId: "proven" }),
    });
    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe("proven");
  });

  it("still refuses the zero-accept model when it is a further order of magnitude cheaper", () => {
    // The whole point of an exclusion over a rank penalty: no price makes it
    // back into the set. 0.002/MTok in is effectively free.
    const nearlyFree: ModelEntry = { ...ZERO_ACCEPT, costPerMTokIn: 0.002, costPerMTokOut: 0.01, costPerMTokCacheRead: 0.0002 };
    const decision = decide(
      { "zero-accept:T1": zeroAcceptRow(), "proven:T1": ledgerEntry({ modelId: "proven" }) },
      [nearlyFree, PROVEN],
    );
    expect(decision.modelId).toBe("proven");
  });

  it("records the exclusion as a named rejection carrying the resolved/accepted counts", () => {
    const decision = decide({
      "zero-accept:T1": zeroAcceptRow(),
      "proven:T1": ledgerEntry({ modelId: "proven" }),
    });
    const rejection = decision.rejections.find((candidate) => candidate.modelId === "zero-accept");
    expect(rejection?.stage).toBe("card-accept-rate");
    expect(rejection?.reason).toContain(`0 of ${CARD_ZERO_ACCEPT_MIN_RESOLVED} mature T1 cards`);
    expect(rejection?.operand).toEqual({
      kind: "card-accept-rate",
      tier: "T1",
      cardsResolved: CARD_ZERO_ACCEPT_MIN_RESOLVED,
      cardsAccepted: 0,
    });
  });

  it("is a quality exclusion, not a capacity one: an all-excluded tier is no-eligible-model", () => {
    // `tier-exhausted` tells an operator to go buy capacity. Capacity is not
    // the problem here — the roster is serviceable and the rows are rejects.
    const decision = decide({ "zero-accept:T1": zeroAcceptRow(), "proven:T1": zeroAcceptRow({ modelId: "proven" }) }, [
      ZERO_ACCEPT,
      PROVEN,
    ]);
    expect(decision.outcome).toBe("no-eligible-model");
    // Every T1 row was excluded, and by this stage specifically — so the
    // `tier-exhausted` classifier saw a set it could have claimed and did not.
    expect(decision.rejections.map((entry) => entry.stage)).toEqual(["card-accept-rate", "card-accept-rate"]);
  });
});

describe("card-accept-rate gate fails open", () => {
  it("never excludes a pending row, however many cards it has closed", () => {
    // `muse-spark-1.3-contributor:T1` read 109 cards closed and `pending:
    // true` on 2026-09-22. A pending row's acceptRate is a PRIOR, not a
    // measurement: it needs MORE traffic to graduate, which is the opposite
    // of what this gate does.
    const pending = zeroAcceptRow({ cardsClosed: 109, cardsResolved: 0, acceptRate: 0, pending: true });
    expect(zeroAcceptEvidence("zero-accept", "T1", { "zero-accept:T1": pending })).toBeNull();
    const decision = decide({ "zero-accept:T1": pending, "proven:T1": ledgerEntry({ modelId: "proven" }) });
    expect(decision.modelId).toBe("zero-accept");
    expect(decision.rejections.some((entry) => entry.stage === "card-accept-rate")).toBe(false);
  });

  it("never excludes on astra's real shape: one resolved card, zero accepted", () => {
    // The card that prompted this reported `acceptRate: 0` over
    // `cardsClosed: 20`. The live ledger says 0-of-ONE resolved, with the
    // other 24 closed cards still inside the censor window. Banning a tier
    // on a single rejection is exactly the failure this floor exists for.
    const astra = zeroAcceptRow({ cardsClosed: 25, cardsResolved: 1, cardsAccepted: 0 });
    expect(zeroAcceptEvidence("zero-accept", "T1", { "zero-accept:T1": astra })).toBeNull();
    expect(decide({ "zero-accept:T1": astra, "proven:T1": ledgerEntry({ modelId: "proven" }) }).modelId).toBe("zero-accept");
  });

  it("never excludes a row that claims BOTH pending and enough resolved cards", () => {
    // `plugin_state` is untyped JSON, so the two fields can disagree — a
    // half-written refresh, or a hand-edited row. `pending` is the field that
    // says "this acceptRate is a prior", so it wins the contradiction: a row
    // we cannot read coherently is not evidence of anything.
    const contradictory = zeroAcceptRow({ cardsResolved: CARD_ZERO_ACCEPT_MIN_RESOLVED + 12, pending: true });
    expect(zeroAcceptEvidence("zero-accept", "T1", { "zero-accept:T1": contradictory })).toBeNull();
    expect(decide({ "zero-accept:T1": contradictory, "proven:T1": ledgerEntry({ modelId: "proven" }) }).modelId).toBe(
      "zero-accept",
    );
  });

  it("excludes at exactly the floor and not one resolved card below it", () => {
    const key = "zero-accept:T1";
    const below = CARD_ZERO_ACCEPT_MIN_RESOLVED - 1;
    expect(zeroAcceptEvidence("zero-accept", "T1", { [key]: zeroAcceptRow({ cardsResolved: below }) })).toBeNull();
    expect(zeroAcceptEvidence("zero-accept", "T1", { [key]: zeroAcceptRow() })).toEqual({
      cardsResolved: CARD_ZERO_ACCEPT_MIN_RESOLVED,
      cardsAccepted: 0,
      expiresAtMs: EXPIRES,
    });
  });

  it("never excludes a legacy row that has no cardsResolved field", () => {
    // `plugin_state` is untyped JSON written by whichever build last ran the
    // refresh pass, so a row written before this change carries only
    // `cardsClosed` — which counts precisely the censored cards the gate must
    // not see. Absent must stay absent, never be reconstructed from it.
    const legacy = zeroAcceptRow({ cardsClosed: 40 }) as Partial<CardLedgerEntry>;
    delete legacy.cardsResolved;
    delete legacy.cardsAccepted;
    const ledger = { "zero-accept:T1": legacy as CardLedgerEntry };
    expect(zeroAcceptEvidence("zero-accept", "T1", ledger)).toBeNull();
    expect(decide({ ...ledger, "proven:T1": ledgerEntry({ modelId: "proven" }) }).modelId).toBe("zero-accept");
  });

  it("never excludes a model with no ledger row at all", () => {
    expect(zeroAcceptEvidence("zero-accept", "T1", {})).toBeNull();
    expect(decide({ "proven:T1": ledgerEntry({ modelId: "proven" }) }).modelId).toBe("zero-accept");
  });

  it("never excludes on a different tier's evidence", () => {
    const ledger = { "zero-accept:T2": zeroAcceptRow({ tier: "T2" }) };
    expect(zeroAcceptEvidence("zero-accept", "T1", ledger)).toBeNull();
    expect(decide({ ...ledger, "proven:T1": ledgerEntry({ modelId: "proven" }) }).modelId).toBe("zero-accept");
  });

  it("never excludes a row with even one accepted card", () => {
    const ledger = { "zero-accept:T1": zeroAcceptRow({ cardsResolved: 40, cardsAccepted: 1, acceptRate: 0.025 }) };
    expect(zeroAcceptEvidence("zero-accept", "T1", ledger)).toBeNull();
  });
});

describe("untyped ledger validation", () => {
  const good = zeroAcceptRow();
  const cohort = good.qualityCohort!;
  const corruptions: Array<[string, Record<string, unknown>]> = [
    ["wrong model", { modelId: "another-model" }],
    ["wrong tier", { tier: "T2" }],
    ["missing pending", { pending: undefined }],
    ["null pending", { pending: null }],
    ["numeric pending", { pending: 0 }],
    ["negative accepts", { cardsAccepted: -1 }],
    ["fractional resolved", { cardsResolved: 8.5, cardsClosed: 9 }],
    ["missing resolved", { cardsResolved: undefined }],
    ["missing closed", { cardsClosed: undefined }],
    ["string counts", { cardsClosed: "8" }],
    ["infinite counts", { cardsClosed: Infinity }],
    ["NaN counts", { cardsResolved: NaN }],
    ["unsafe counts", { cardsClosed: Number.MAX_SAFE_INTEGER + 1 }],
    ["resolved exceeds closed", { cardsClosed: 7 }],
    ["accepts exceeds resolved", { cardsAccepted: 9 }],
    ["contradictory rate", { acceptRate: 0.5 }],
    ["missing rate", { acceptRate: undefined }],
    ["legacy cohort", { qualityCohort: undefined }],
    ["fractional cohort", { qualityCohort: { ...cohort, cardsResolved: 7.5 } }],
    ["cohort exceeds resolved", { qualityCohort: { ...cohort, cardsResolved: 9 } }],
    ["cohort negative accepts", { qualityCohort: { ...cohort, cardsAccepted: -1 } }],
    ["cohort positive accepts", { qualityCohort: { ...cohort, cardsAccepted: 1 } }],
    ["cohort accepts exceeds resolved", { qualityCohort: { ...cohort, cardsAccepted: 9 } }],
    ["future observation", { qualityCohort: { ...cohort, observedAtMs: NOW + 1 } }],
    ["missing observation", { qualityCohort: { ...cohort, observedAtMs: undefined } }],
    ["inverted dates", { qualityCohort: { ...cohort, oldestClosedAtMs: cohort.newestClosedAtMs + 1 } }],
    ["immature cohort", { qualityCohort: { ...cohort, newestClosedAtMs: NOW - DAY } }],
    ["negative date", { qualityCohort: { ...cohort, oldestClosedAtMs: -1 } }],
  ];
  it.each(corruptions)("fails open on %s, with a valid exclusion control", (_name, fields) => {
    expect(zeroAcceptEvidence("zero-accept", "T1", { "zero-accept:T1": good })).not.toBeNull();
    const malformed = { ...good, ...fields } as CardLedgerEntry;
    expect(zeroAcceptEvidence("zero-accept", "T1", { "zero-accept:T1": malformed })).toBeNull();
    expect(decide({ "zero-accept:T1": malformed }).modelId).toBe("zero-accept");
  });
});

describe("symmetric maturity and bounded re-entry", () => {
  function cards(rejected: number, accepted: number, closedAtMs: number): CardRow[] {
    return Array.from({ length: rejected + accepted }, (_, index) => ({
      modelId: "zero-accept", tier: "T1", closedAtMs,
      rejected: index < rejected, costUsd: 1, runCount: 1, foreignRun: false,
    }));
  }
  const build = (rows: CardRow[], now: number) => buildCardLedger(rows, now, {}, {});
  const select = (ledger: Record<string, CardLedgerEntry>, now: number) => selectModel({
    ...base, now, descriptor: { issueId: "maturity-reentry", labelNames: ["tier:T1"] },
    profiles: PROFILES.map((profile) => ({ ...profile, computedAt: new Date(now).toISOString() })),
    config: config({ models: [ZERO_ACCEPT, PROVEN] }), cardLedger: ledger,
  });

  it("never bans the review's 8 rejects + 100 censored cards at day 3 or day 14", () => {
    const rows = cards(8, 100, NOW);
    const young = build(rows, NOW + 3 * DAY);
    expect(young["zero-accept:T1"]!.cardsResolved).toBe(8);
    expect(young["zero-accept:T1"]!.acceptRate).toBe(0);
    expect(select(young, NOW + 3 * DAY).modelId).toBe("zero-accept");
    const mature = build(rows, NOW + 14 * DAY);
    expect(mature["zero-accept:T1"]!.qualityCohort?.cardsResolved).toBe(108);
    expect(mature["zero-accept:T1"]!.qualityCohort?.cardsAccepted).toBe(100);
    expect(select(mature, NOW + 14 * DAY).modelId).toBe("zero-accept");
  });

  it("excludes eight actual rejects only at maturity, then re-enters on stale AND refreshed ledgers", () => {
    const rows = cards(8, 0, NOW);
    const maturity = NOW + 14 * DAY;
    expect(select(build(rows, maturity - 1), maturity - 1).modelId).toBe("zero-accept");
    const mature = build(rows, maturity);
    expect(select(mature, maturity).modelId).toBe("proven");
    const expiry = NOW + 21 * DAY;
    expect(select(mature, expiry - 1).modelId).toBe("proven");
    expect(select(mature, expiry).modelId).toBe("zero-accept");
    expect(select(build(rows, expiry), expiry).modelId).toBe("zero-accept");
    // Refresh cannot restart the lifetime of old failures.
    const refreshed = build(rows, expiry - DAY);
    expect(select(refreshed, expiry).modelId).toBe("zero-accept");
  });

  it("does not count fresh rejects toward an otherwise undersized mature cohort", () => {
    const now = NOW + 14 * DAY;
    const rows = [...cards(7, 0, NOW), ...cards(100, 0, now - DAY)];
    const ledger = build(rows, now);
    expect(ledger["zero-accept:T1"]!.cardsResolved).toBe(107);
    expect(ledger["zero-accept:T1"]!.qualityCohort?.cardsResolved).toBe(7);
    expect(select(ledger, now).modelId).toBe("zero-accept");
  });

  it("expires a cached mixed-age cohort when its oldest card leaves the window", () => {
    const rows = [...cards(1, 0, NOW - 6 * DAY), ...cards(7, 0, NOW)];
    const now = NOW + 14 * DAY;
    const ledger = build(rows, now);
    expect(select(ledger, now).modelId).toBe("proven");
    expect(readZeroAcceptEvidence("zero-accept", "T1", ledger, now)?.expiresAtMs).toBe(NOW + 15 * DAY);
    expect(select(ledger, NOW + 15 * DAY).modelId).toBe("zero-accept");
    expect(select(build(rows, NOW + 15 * DAY), NOW + 15 * DAY).modelId).toBe("zero-accept");
  });
});

describe("a null costPerAcceptedCard sorts last, never first", () => {
  function candidate(modelId: string, expectedCostUsd: number): Candidate {
    return {
      modelId,
      runCostUsd: expectedCostUsd,
      inputCostUsd: expectedCostUsd,
      cacheReadCostUsd: 0,
      outputCostUsd: 0,
      escalationRiskUsd: 0,
      expectedCostUsd,
      profileTier: "T1",
      profileTrusted: true,
      tier: "T1",
      releasedAt: "2026-01-01",
      fallbackOnly: false,
    };
  }

  it("ranks an unmeasured candidate behind a measured one even when it is cheapest on list price", () => {
    const ordered = orderByObjective([candidate("no-cost-data", 0.1), candidate("measured", 9)], "cost-per-accepted-card", {
      "measured:T1": ledgerEntry({ modelId: "measured", costPerAcceptedCard: 99 }),
    });
    expect(ordered.map((entry) => entry.modelId)).toEqual(["measured", "no-cost-data"]);
  });

  it("keeps the unmeasured candidate in the set rather than dropping it", () => {
    // Dropping and last-place look equivalent until every row is unmeasured:
    // the old empty-result fallback then returned the untouched list-price
    // order, and a null-cost row won after all.
    const candidates = [candidate("a", 1), candidate("b", 2)];
    const ordered = orderByObjective(candidates, "cost-per-accepted-card", {});
    expect(ordered).toEqual(candidates);
    expect(ordered).toHaveLength(2);
  });

  it("orders several unmeasured candidates stably behind the measured ones", () => {
    const ordered = orderByObjective(
      [candidate("null-second", 1), candidate("measured-pricey", 2), candidate("null-first", 3), candidate("measured-cheap", 4)],
      "cost-per-accepted-card",
      {
        "measured-pricey:T1": ledgerEntry({ modelId: "measured-pricey", costPerAcceptedCard: 8 }),
        "measured-cheap:T1": ledgerEntry({ modelId: "measured-cheap", costPerAcceptedCard: 3 }),
      },
    );
    expect(ordered.map((entry) => entry.modelId)).toEqual(["measured-cheap", "measured-pricey", "null-second", "null-first"]);
  });

  it("leaves the shadow diff null when no candidate is costable, rather than naming an unmeasured winner", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "card-accept-gate-shadow", labelNames: ["tier:T1"] },
      config: config({ models: [ZERO_ACCEPT, PROVEN] }),
      cardLedger: { "proven:T1": ledgerEntry({ modelId: "proven", costPerCard: null, costPerAcceptedCard: null }) },
    });
    expect(decision.shadowDiff).toBeNull();
  });
});
