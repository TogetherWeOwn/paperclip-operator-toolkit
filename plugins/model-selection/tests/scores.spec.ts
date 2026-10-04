import { describe, expect, it } from "vitest";

import { SCORE_PRIOR_K, SCORE_THRESHOLDS, type Tier } from "../src/constants.js";
import {
  accumulateRunStats,
  buildCardLedger,
  buildModelScore,
  emptyTierScoreStats,
  enforceMonotoneCapability,
  foldReworkIntoStats,
  priorP,
  tierScoreFor,
  summarize,
  type CardRow,
  type ReworkClosingRun,
  type RunOutcomeRow,
} from "../src/engine/scores.js";
import type { TierScoreStats } from "../src/engine/types.js";

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Verbatim `rows` from a frozen `host-evidence.json` (27 rows,
 * copied from `model_scores.json`'s `models[mid]['tiers'][tier]`). `p`/`pObs`/
 * `nEff` are already rounded to 3/3/1 decimals in this fixture — see the
 * "Key design resolution" note in the governing plan for why the spot check
 * below only asserts `p` round-trips, not `pObs`.
 */
const HOST_EVIDENCE_ROWS: ReadonlyArray<{
  model: string;
  tier: Tier;
  n: number;
  ok: number;
  failInfra: number;
  failModel: number;
  tmo: number;
  nEff: number;
  pObs: number | null;
  p: number;
  capable: boolean;
  proven: boolean;
}> = [
  { model: "cliproxy/gpt-5.6-sol", tier: "T1", n: 797, ok: 722, failInfra: 47, failModel: 24.0, tmo: 9, nEff: 565.6, pObs: 0.948, p: 0.947, capable: true, proven: true },
  { model: "cliproxy/gpt-5.6-sol", tier: "T2", n: 546, ok: 490, failInfra: 30, failModel: 22.5, tmo: 9, nEff: 446.5, pObs: 0.935, p: 0.935, capable: true, proven: true },
  { model: "cliproxy/gpt-5.6-sol", tier: "T3", n: 35, ok: 34, failInfra: 1, failModel: 0.0, tmo: 0, nEff: 24.8, pObs: 1.0, p: 0.987, capable: true, proven: true },
  { model: "claude-opus-5", tier: "T1", n: 416, ok: 321, failInfra: 89, failModel: 6.0, tmo: 3, nEff: 198.0, pObs: 0.966, p: 0.965, capable: true, proven: true },
  { model: "claude-opus-5", tier: "T2", n: 144, ok: 106, failInfra: 33, failModel: 6.0, tmo: 2, nEff: 68.0, pObs: 0.902, p: 0.907, capable: true, proven: true },
  { model: "claude-opus-5", tier: "T3", n: 68, ok: 62, failInfra: 6, failModel: 0.0, tmo: 0, nEff: 29.8, pObs: 1.0, p: 0.992, capable: true, proven: true },
  { model: "cliproxy/gpt-5.6-luna", tier: "T1", n: 22, ok: 11, failInfra: 8, failModel: 1.0, tmo: 1, nEff: 10.8, pObs: 0.841, p: 0.852, capable: true, proven: true },
  { model: "cliproxy/gpt-5.6-luna", tier: "T2", n: 17, ok: 7, failInfra: 4, failModel: 2.0, tmo: 2, nEff: 9.6, pObs: 0.639, p: 0.729, capable: false, proven: true },
  { model: "cliproxy/gpt-5.6-luna", tier: "T3", n: 52, ok: 44, failInfra: 8, failModel: 0.0, tmo: 0, nEff: 33.8, pObs: 1.0, p: 0.981, capable: true, proven: true },
  { model: "cliproxy/glm-5.3", tier: "T1", n: 23, ok: 8, failInfra: 15, failModel: 1.0, tmo: 0, nEff: 7.0, pObs: 0.858, p: 0.885, capable: true, proven: true },
  { model: "cliproxy/glm-5.3", tier: "T2", n: 39, ok: 19, failInfra: 17, failModel: 2.0, tmo: 0, nEff: 18.6, pObs: 0.902, p: 0.906, capable: true, proven: true },
  { model: "cliproxy/glm-5.3", tier: "T3", n: 0, ok: 0, failInfra: 0, failModel: 0, tmo: 0, nEff: 0, pObs: null, p: 0.917, capable: true, proven: false },
  { model: "cliproxy/deepseek-v4-pro", tier: "T1", n: 36, ok: 23, failInfra: 13, failModel: 0.0, tmo: 0, nEff: 16.5, pObs: 1.0, p: 0.964, capable: true, proven: true },
  { model: "cliproxy/deepseek-v4-pro", tier: "T2", n: 8, ok: 1, failInfra: 7, failModel: 0.0, tmo: 0, nEff: 0.7, pObs: 1.0, p: 0.88, capable: true, proven: false },
  { model: "cliproxy/deepseek-v4-pro", tier: "T3", n: 0, ok: 0, failInfra: 0, failModel: 0, tmo: 0, nEff: 0, pObs: null, p: 0.865, capable: true, proven: false },
  { model: "cliproxy/deepseek-v4-flash", tier: "T1", n: 0, ok: 0, failInfra: 0, failModel: 0, tmo: 0, nEff: 0, pObs: null, p: 0.858, capable: true, proven: false },
  { model: "cliproxy/deepseek-v4-flash", tier: "T2", n: 30, ok: 21, failInfra: 7, failModel: 1.0, tmo: 0, nEff: 17.8, pObs: 0.957, p: 0.932, capable: true, proven: true },
  { model: "cliproxy/deepseek-v4-flash", tier: "T3", n: 2, ok: 2, failInfra: 0, failModel: 0.0, tmo: 0, nEff: 1.5, pObs: 1.0, p: 0.886, capable: true, proven: false },
  { model: "cliproxy/kimi-k2.7-code-go", tier: "T1", n: 0, ok: 0, failInfra: 0, failModel: 0, tmo: 0, nEff: 0, pObs: null, p: 0.805, capable: false, proven: false },
  { model: "cliproxy/kimi-k2.7-code-go", tier: "T2", n: 14, ok: 14, failInfra: 0, failModel: 0.0, tmo: 0, nEff: 9.8, pObs: 1.0, p: 0.926, capable: true, proven: true },
  { model: "cliproxy/kimi-k2.7-code-go", tier: "T3", n: 0, ok: 0, failInfra: 0, failModel: 0, tmo: 0, nEff: 0, pObs: null, p: 0.805, capable: true, proven: false },
  { model: "cliproxy/gpt-6-astra", tier: "T1", n: 0, ok: 0, failInfra: 0, failModel: 0, tmo: 0, nEff: 0, pObs: null, p: 0.963, capable: true, proven: false },
  { model: "cliproxy/gpt-6-astra", tier: "T2", n: 1, ok: 1, failInfra: 0, failModel: 0.0, tmo: 0, nEff: 0.8, pObs: 1.0, p: 0.967, capable: true, proven: false },
  { model: "cliproxy/gpt-6-astra", tier: "T3", n: 0, ok: 0, failInfra: 0, failModel: 0, tmo: 0, nEff: 0, pObs: null, p: 0.963, capable: true, proven: false },
  { model: "cliproxy/claude-fable-5-1", tier: "T1", n: 1, ok: 1, failInfra: 0, failModel: 0.0, tmo: 0, nEff: 0.7, pObs: 1.0, p: 0.98, capable: true, proven: false },
  { model: "cliproxy/claude-fable-5-1", tier: "T2", n: 1, ok: 1, failInfra: 0, failModel: 0.0, tmo: 0, nEff: 0.8, pObs: 1.0, p: 0.98, capable: true, proven: false },
  { model: "cliproxy/claude-fable-5-1", tier: "T3", n: 0, ok: 0, failInfra: 0, failModel: 0, tmo: 0, nEff: 0, pObs: null, p: 0.978, capable: true, proven: false },
];

describe("priorP", () => {
  it("matches the aa.ai-anchored formula for a known index", () => {
    // claude-opus-5, aaIndex 51: 0.55 + 0.45*(51/60) = 0.9325
    expect(priorP(51)).toBeCloseTo(0.9325, 10);
  });

  it("floors at 0.55 for a very low index", () => {
    expect(priorP(0)).toBe(0.55);
  });

  it("ceils at 1.0 for a very high index", () => {
    expect(priorP(1000)).toBe(1.0);
  });

  it("falls back to 0.80 when aaIndex is null (model_scores.py:47)", () => {
    expect(priorP(null)).toBe(0.8);
  });
});

describe("summarize — exact-formula replay (acceptance criterion)", () => {
  it("reproduces a hand-computed p/capable/proven from synthetic stats, without rounding inputs", () => {
    // Mirrors verify-evidence.py's own `fourRunsPlusReworkProven` synthetic fixture:
    // 4 succeeded runs, all reworked (failModel weight 1.0 each) -> nEff = wOk+wBad = 4+4 = 8.
    const stats: TierScoreStats = {
      n: 4,
      ok: 4,
      failInfra: 0,
      failModel: 4.0,
      tmo: 0,
      wOk: 4.0,
      wBad: 4.0,
      rework: 4,
      okCost: [],
      okMins: [],
    };
    const pp = 0.9; // prior_p fixture used by verify-evidence.py's harness
    const result = summarize(stats, "T1", pp, SCORE_PRIOR_K, 8, SCORE_THRESHOLDS);

    // p = (wOk + PRIOR_K*pp) / (nEff + PRIOR_K) = (4 + 6*0.9) / (8 + 6) = 9.4/14 = 0.671428...
    const expectedP = (4 + 6 * 0.9) / (8 + 6);
    expect(result.p).toBeCloseTo(0.671, 3);
    expect(round3(expectedP)).toBe(0.671);
    expect(result.proven).toBe(true); // ok+failModel+tmo = 4+4+0 = 8 >= PROVEN_N
    expect(result.capable).toBe(false); // p=0.671 < the 0.85 bar passed explicitly (the default T1 capability bar is 0.8)
    expect(result.n).toBe(4);
    expect(result.rework).toBe(4);
  });

  it("returns pObs=null and n-derived nEff=0 when there is no weighted evidence", () => {
    const stats: TierScoreStats = {
      n: 0,
      ok: 0,
      failInfra: 0,
      failModel: 0,
      tmo: 0,
      wOk: 0,
      wBad: 0,
      rework: 0,
      okCost: [],
      okMins: [],
    };
    const result = summarize(stats, "T2", 0.9);
    expect(result.pObs).toBeNull();
    expect(result.nEff).toBe(0);
    expect(result.p).toBeCloseTo(0.9, 10); // falls back to pure prior when nEff=0
  });

  it("lets hard evidence override a proven model's prior-driven capable=true (model_scores.py:142)", () => {
    // proven, pObs far below thr-0.10 -> capable forced false even if p alone would clear thr.
    const stats: TierScoreStats = {
      n: 20,
      ok: 2,
      failInfra: 0,
      failModel: 18,
      tmo: 0,
      wOk: 2,
      wBad: 18,
      rework: 0,
      okCost: [],
      okMins: [],
    };
    const result = summarize(stats, "T1", 0.95, SCORE_PRIOR_K, 8, SCORE_THRESHOLDS);
    expect(result.proven).toBe(true);
    expect(result.pObs).toBeLessThan(SCORE_THRESHOLDS.T1 - 0.1);
    expect(result.capable).toBe(false);
  });
});

describe("summarize — frozen host-evidence.json spot check (fixture fidelity)", () => {
  it("recomputes p exactly for all 27 rows when wOk is derived from p itself", () => {
    // wOk = p*(nEff+K) - K*priorP, wBad = nEff - wOk. priorP per model taken from
    // model_scores.py's AA_INDEX-derived prior_p (captured once, offline, from the
    // 2026-09-06 leaderboard read) — reproduced here only for rows with nEff>0.
    const priorPByModel: Record<string, number> = {
      "cliproxy/gpt-5.6-sol": priorP(51),
      "claude-opus-5": priorP(54),
      "cliproxy/gpt-5.6-luna": priorP(43),
      "cliproxy/glm-5.3": priorP(49),
      "cliproxy/deepseek-v4-pro": priorP(42),
      "cliproxy/deepseek-v4-flash": priorP(41),
      "cliproxy/kimi-k2.7-code-go": priorP(34),
      "cliproxy/gpt-6-astra": priorP(55),
      "cliproxy/claude-fable-5-1": priorP(57),
    };
    let checked = 0;
    for (const row of HOST_EVIDENCE_ROWS) {
      if (row.nEff === 0) continue;
      const pp = priorPByModel[row.model];
      if (pp === undefined) throw new Error(`missing fixture prior for ${row.model}`);
      const wOk = row.p * (row.nEff + SCORE_PRIOR_K) - SCORE_PRIOR_K * pp;
      const wBad = row.nEff - wOk;
      const stats: TierScoreStats = {
        n: row.n,
        ok: row.ok,
        failInfra: row.failInfra,
        failModel: row.failModel,
        tmo: row.tmo,
        wOk,
        wBad,
        rework: 0,
        okCost: [],
        okMins: [],
      };
      const recomputed = summarize(stats, row.tier, pp);
      expect(recomputed.p).toBeCloseTo(row.p, 3);
      checked += 1;
    }
    expect(checked).toBe(HOST_EVIDENCE_ROWS.filter((r) => r.nEff > 0).length);
    expect(checked).toBeGreaterThan(0);
  });
});

describe("accumulateRunStats -> summarize — raw-row replay of frozen host-evidence rows", () => {
  // Reviewer ask: the spot check above derives
  // wOk/wBad ALGEBRAICALLY from each row's target `p`, so it never actually
  // exercises `accumulateRunStats`'s recency-decay formula
  // (`Math.exp(-row.ageDays / 10.0)`, scores.ts) — a mutation to that constant
  // (/10.0 -> /5.0) survived all existing tests undetected. This drives real
  // `RunOutcomeRow[]` (raw `n`/`ok`/`failInfra` counts, an explicit `ageDays`
  // per row) through `accumulateRunStats` itself, so a decay-constant mutant
  // fails here.
  //
  // For each row below (all drawn from HOST_EVIDENCE_ROWS above, restricted to
  // rows with `failModel === 0` and `tmo === 0` so wBad is contributed only by
  // `failInfra`-free math, i.e. wBad stays 0 and nEff === wOk): every
  // succeeded run is given the SAME `ageDays`, solved so that
  // `ok * exp(-ageDays/10)` reproduces the frozen row's `nEff` exactly. Every
  // failInfra run carries a real infra error string ("503 ...") so
  // `classifyRunFailure` routes it to `failInfra` (no wBad contribution) via
  // the same classification path production code uses — nothing about the
  // outcome classification is bypassed either.
  const rawReplayCases: ReadonlyArray<{
    model: string;
    tier: Tier;
    aaIndex: number;
    ok: number;
    failInfra: number;
    nEff: number;
    p: number;
    priorPValue: number;
  }> = [
    { model: "cliproxy/kimi-k2.7-code-go", tier: "T2", aaIndex: 34, ok: 14, failInfra: 0, nEff: 9.8, p: 0.926, priorPValue: priorP(34) },
    { model: "cliproxy/deepseek-v4-pro", tier: "T1", aaIndex: 42, ok: 23, failInfra: 13, nEff: 16.5, p: 0.964, priorPValue: priorP(42) },
    { model: "claude-opus-5", tier: "T3", aaIndex: 54, ok: 62, failInfra: 6, nEff: 29.8, p: 0.992, priorPValue: priorP(54) },
  ];

  it("reproduces frozen p for each case from raw rows run through the real decay formula", () => {
    for (const testCase of rawReplayCases) {
      const ratio = testCase.nEff / testCase.ok;
      const ageDays = -10 * Math.log(ratio);

      const rows: RunOutcomeRow[] = [
        ...Array.from({ length: testCase.ok }, (): RunOutcomeRow => ({
          modelId: testCase.model,
          tier: testCase.tier,
          status: "succeeded",
          errorCode: null,
          error: null,
          costUsd: 1,
          mins: 5,
          ageDays,
        })),
        ...Array.from({ length: testCase.failInfra }, (): RunOutcomeRow => ({
          modelId: testCase.model,
          tier: testCase.tier,
          status: "failed",
          errorCode: null,
          error: "503 upstream error",
          costUsd: null,
          mins: null,
          ageDays,
        })),
      ];

      const statsByModel = accumulateRunStats(rows);
      const tierStats = statsByModel[testCase.model]?.[testCase.tier];
      if (!tierStats) throw new Error(`missing accumulated stats for ${testCase.model}:${testCase.tier}`);

      expect(tierStats.ok).toBe(testCase.ok);
      expect(tierStats.failInfra).toBe(testCase.failInfra);
      expect(tierStats.wBad).toBe(0); // infra failures never contribute to wBad

      const result = summarize(tierStats, testCase.tier, testCase.priorPValue);
      expect(result.nEff).toBeCloseTo(testCase.nEff, 2);
      expect(result.p).toBeCloseTo(testCase.p, 3);

      const modelScore = buildModelScore(testCase.model, testCase.aaIndex, { [testCase.tier]: tierStats }, ["T1", "T2", "T3"]);
      expect(modelScore.tiers[testCase.tier].p).toBeCloseTo(testCase.p, 3);
    }
  });

  it("fails to reproduce frozen p if the recency-decay constant is perturbed (mutation sentinel)", () => {
    // Same construction as above, but this asserts the OPPOSITE outcome under
    // a hand-simulated mutant (/10.0 -> /5.0) to prove the test above is not
    // vacuously insensitive to that constant.
    const testCase = rawReplayCases[0]!;
    const ratio = testCase.nEff / testCase.ok;
    const ageDays = -10 * Math.log(ratio);
    const mutantWeight = Math.exp(-ageDays / 5.0); // mutant denominator
    const mutantWOk = testCase.ok * mutantWeight;
    const mutantStats: TierScoreStats = {
      n: testCase.ok,
      ok: testCase.ok,
      failInfra: 0,
      failModel: 0,
      tmo: 0,
      wOk: mutantWOk,
      wBad: 0,
      rework: 0,
      okCost: [],
      okMins: [],
    };
    const mutantResult = summarize(mutantStats, testCase.tier, testCase.priorPValue);
    expect(mutantResult.p).not.toBeCloseTo(testCase.p, 3);
  });
});

describe("buildCardLedger — censor", () => {
  const nowMs = Date.parse("2026-09-12T00:00:00.000Z");
  const dayMs = 24 * 60 * 60 * 1000;

  it("marks a card closed 5 days ago as pending, excluded from acceptRate", () => {
    const cards: CardRow[] = [
      { modelId: "m1", tier: "T1", closedAtMs: nowMs - 5 * dayMs, rejected: false, costUsd: 1, runCount: 1, foreignRun: false },
    ];
    const ledger = buildCardLedger(cards, nowMs, { m1: 0.8 }, { m1: 2 });
    const entry = ledger["m1:T1"];
    if (!entry) throw new Error("missing ledger entry m1:T1");
    expect(entry.pending).toBe(true);
    expect(entry.acceptRate).toBe(0.8); // falls back to prior, not treated as accepted
    expect(entry.costPerCard).toBe(2); // falls back to blended list price
  });

  it("counts a card closed 15 days ago with no rejection as accepted", () => {
    const cards: CardRow[] = [
      { modelId: "m1", tier: "T1", closedAtMs: nowMs - 15 * dayMs, rejected: false, costUsd: 3, runCount: 1, foreignRun: false },
    ];
    const ledger = buildCardLedger(cards, nowMs, { m1: 0.8 }, { m1: 2 });
    const entry = ledger["m1:T1"];
    if (!entry) throw new Error("missing ledger entry m1:T1");
    expect(entry.pending).toBe(false);
    expect(entry.acceptRate).toBe(1);
    expect(entry.costPerCard).toBe(3);
    expect(entry.costPerAcceptedCard).toBe(3);
  });

  it("counts a rejected card immediately, even if closed recently (rejection is not censored)", () => {
    const cards: CardRow[] = [
      { modelId: "m1", tier: "T1", closedAtMs: nowMs - 1 * dayMs, rejected: true, costUsd: 3, runCount: 2, foreignRun: false },
    ];
    const ledger = buildCardLedger(cards, nowMs, { m1: 0.8 }, { m1: 2 });
    const entry = ledger["m1:T1"];
    if (!entry) throw new Error("missing ledger entry m1:T1");
    expect(entry.pending).toBe(false);
    expect(entry.acceptRate).toBe(0);
    expect(entry.costPerAcceptedCard).toBeNull();
  });

  it("blends pending and resolved cards correctly in acceptRate", () => {
    const cards: CardRow[] = [
      { modelId: "m1", tier: "T1", closedAtMs: nowMs - 20 * dayMs, rejected: false, costUsd: 2, runCount: 1, foreignRun: false },
      { modelId: "m1", tier: "T1", closedAtMs: nowMs - 20 * dayMs, rejected: true, costUsd: 2, runCount: 1, foreignRun: false },
      { modelId: "m1", tier: "T1", closedAtMs: nowMs - 2 * dayMs, rejected: false, costUsd: 2, runCount: 1, foreignRun: false }, // pending, excluded
    ];
    const ledger = buildCardLedger(cards, nowMs, { m1: 0.8 }, { m1: 2 });
    const entry = ledger["m1:T1"];
    if (!entry) throw new Error("missing ledger entry m1:T1");
    expect(entry.cardsClosed).toBe(3);
    expect(entry.pending).toBe(false); // some rows resolved
    expect(entry.acceptRate).toBe(0.5); // 1 accepted / 2 resolved, pending row excluded
  });

  // `cardsClosed` is not the `acceptRate` denominator, and reading it
  // as one is how `gpt-6-astra:T1` looked like "0 accepted out of 25" on
  // 2026-09-22 when the truth was 0-of-ONE resolved. These publish the two
  // counts that make the difference readable to a consumer.
  it("publishes cardsResolved/cardsAccepted separately from cardsClosed", () => {
    const cards: CardRow[] = [
      { modelId: "m1", tier: "T1", closedAtMs: nowMs - 20 * dayMs, rejected: false, costUsd: 2, runCount: 1, foreignRun: false },
      { modelId: "m1", tier: "T1", closedAtMs: nowMs - 20 * dayMs, rejected: true, costUsd: 2, runCount: 1, foreignRun: false },
      { modelId: "m1", tier: "T1", closedAtMs: nowMs - 2 * dayMs, rejected: false, costUsd: 2, runCount: 1, foreignRun: false },
      { modelId: "m1", tier: "T1", closedAtMs: nowMs - 1 * dayMs, rejected: false, costUsd: 2, runCount: 1, foreignRun: false },
    ];
    const entry = buildCardLedger(cards, nowMs, { m1: 0.8 }, { m1: 2 })["m1:T1"];
    if (!entry) throw new Error("missing ledger entry m1:T1");
    expect(entry.cardsClosed).toBe(4); // includes the 2 censored rows
    expect(entry.cardsResolved).toBe(2);
    expect(entry.cardsAccepted).toBe(1);
    expect(entry.acceptRate).toBe(entry.cardsAccepted / entry.cardsResolved);
  });

  it("reports astra's real shape — 0 of 1 resolved, not 0 of 25 closed", () => {
    const cards: CardRow[] = [
      { modelId: "astra", tier: "T1", closedAtMs: nowMs - 20 * dayMs, rejected: true, costUsd: 2, runCount: 1, foreignRun: false },
      ...Array.from({ length: 24 }, () => ({
        modelId: "astra",
        tier: "T1" as const,
        closedAtMs: nowMs - 1 * dayMs,
        rejected: false,
        costUsd: 2,
        runCount: 1,
        foreignRun: false,
      })),
    ];
    const entry = buildCardLedger(cards, nowMs, { astra: 0.8 }, { astra: 2 })["astra:T1"];
    if (!entry) throw new Error("missing ledger entry astra:T1");
    expect(entry.cardsClosed).toBe(25);
    expect(entry.cardsResolved).toBe(1);
    expect(entry.cardsAccepted).toBe(0);
    expect(entry.acceptRate).toBe(0);
  });

  it("reports zero resolved cards on a fully censored row", () => {
    const cards: CardRow[] = [
      { modelId: "m1", tier: "T1", closedAtMs: nowMs - 2 * dayMs, rejected: false, costUsd: 2, runCount: 1, foreignRun: false },
    ];
    const entry = buildCardLedger(cards, nowMs, { m1: 0.8 }, { m1: 2 })["m1:T1"];
    if (!entry) throw new Error("missing ledger entry m1:T1");
    expect(entry.pending).toBe(true);
    expect(entry.cardsResolved).toBe(0);
    expect(entry.cardsAccepted).toBe(0);
    expect(entry.acceptRate).toBe(0.8); // the prior, not 0/0
  });
});

describe("foldReworkIntoStats — rework is soft evidence, never a raw observation (count-rework-as-n)", () => {
  it("inflates failModel/wBad/rework on a reopen event but leaves n untouched", () => {
    const events: ReworkClosingRun[] = [{ modelId: "m1", tier: "T1", kind: "reopen" }];
    const folded = foldReworkIntoStats({}, events);
    const stats = folded.m1?.T1;
    if (!stats) throw new Error("missing folded stats for m1:T1");
    // Rework must never count toward `n` — it did not originate from a run
    // row in accumulateRunStats, so treating it as an observation would
    // double-count evidence and skew nEff.
    expect(stats.n).toBe(0);
    expect(stats.failModel).toBeGreaterThan(0);
    expect(stats.wBad).toBeGreaterThan(0);
    expect(stats.rework).toBe(1);
  });

  it("leaves n at its pre-existing value when folding on top of prior run-derived stats", () => {
    const existing = {
      m1: { T1: { n: 5, ok: 5, failInfra: 0, failModel: 0, tmo: 0, wOk: 4, wBad: 0, rework: 0, okCost: [], okMins: [] } },
    };
    const events: ReworkClosingRun[] = [{ modelId: "m1", tier: "T1", kind: "rejected" }];
    const folded = foldReworkIntoStats(existing, events);
    expect(folded.m1?.T1?.n).toBe(5);
  });
});

describe("monotone tier capability", () => {
  const stats = (partial: Partial<TierScoreStats>): TierScoreStats => ({ ...emptyTierScoreStats(), ...partial });
  // glm-5.3 on the 2026-10-02 decisions window: 89/89 at T3, measured failing
  // T2 (p=0.585, proven), and no T1 runs of its own.
  const T3_PROVEN_PASS = stats({ n: 89, ok: 89, wOk: 89 });
  const T2_PROVEN_FAIL = stats({ n: 44, ok: 22, failInfra: 4, failModel: 18, wOk: 21.6, wBad: 18.4 });
  const T1_PROVEN_PASS = stats({ n: 20, ok: 18, failModel: 2, wOk: 18, wBad: 2 });
  const GLM_AA_INDEX = 44.86;
  const TIERS: Tier[] = ["T1", "T2", "T3"];

  it("excludes a glm-5.3-shaped model at T1 and T2: T3 proven-pass, T2 measured-fail, T1 empty", () => {
    const score = buildModelScore("glm-5.3", GLM_AA_INDEX, { T3: T3_PROVEN_PASS, T2: T2_PROVEN_FAIL }, TIERS);
    // The defect: an empty T1 alone passes on its prior.
    expect(score.priorP).toBeGreaterThanOrEqual(0.8);
    expect(score.tiers.T2).toMatchObject({ p: 0.585, proven: true, capable: false });
    expect(score.tiers.T2.cappedBy).toBeUndefined();
    expect(score.tiers.T1).toMatchObject({ n: 0, proven: false, capable: false, cappedBy: "T2" });
    expect(score.tiers.T3).toMatchObject({ proven: true, capable: true });
    expect(score.tiers.T3.cappedBy).toBeUndefined();
    // Only `capable`/`cappedBy` move: p and the derived tier are untouched.
    expect(score.tiers.T1.p).toBe(round3(score.priorP));
    expect(score.derivedTier).toBe("T1");
  });

  it("keeps current behaviour for a model with an empty T2 and a passing prior", () => {
    const score = buildModelScore("m", GLM_AA_INDEX, { T3: T3_PROVEN_PASS }, TIERS);
    for (const tier of ["T2", "T1"] as const) {
      expect(score.tiers[tier]).toMatchObject({ n: 0, proven: false, capable: true });
      expect(score.tiers[tier].cappedBy).toBeUndefined();
    }
    expect(enforceMonotoneCapability(score.tiers)).toEqual(score.tiers);
  });

  it("lets a harder tier's own proven evidence stand over an easier failure", () => {
    const score = buildModelScore("m", GLM_AA_INDEX, { T3: T3_PROVEN_PASS, T2: T2_PROVEN_FAIL, T1: T1_PROVEN_PASS }, TIERS);
    expect(score.tiers.T2.capable).toBe(false);
    expect(score.tiers.T1).toMatchObject({ proven: true, capable: true });
    expect(score.tiers.T1.cappedBy).toBeUndefined();
  });

  it("caps an UNPROVEN harder tier even when it has a few runs of its own", () => {
    const sparseT1 = stats({ n: 3, ok: 3, wOk: 3 });
    const score = buildModelScore("m", GLM_AA_INDEX, { T2: T2_PROVEN_FAIL, T1: sparseT1 }, TIERS);
    expect(score.tiers.T1).toMatchObject({ n: 3, proven: false, capable: false, cappedBy: "T2" });
  });

  it("names the nearest own-verdict failure, and caps every harder unproven tier above it", () => {
    const score = buildModelScore("m", GLM_AA_INDEX, { T3: T2_PROVEN_FAIL }, TIERS);
    expect(score.tiers.T3).toMatchObject({ capable: false });
    expect(score.tiers.T3.cappedBy).toBeUndefined();
    expect(score.tiers.T2).toMatchObject({ capable: false, cappedBy: "T3" });
    expect(score.tiers.T1).toMatchObject({ capable: false, cappedBy: "T3" });
  });

  it("is idempotent, and re-applied at read time to scores stored before the rule existed", () => {
    const capped = buildModelScore("glm-5.3", GLM_AA_INDEX, { T3: T3_PROVEN_PASS, T2: T2_PROVEN_FAIL }, TIERS);
    expect(enforceMonotoneCapability(capped.tiers)).toEqual(capped.tiers);
    // A stored score from before capability became monotone in tier order: T1
    // still carries its isolated prior verdict.
    const { cappedBy: _cappedBy, ...isolatedT1 } = capped.tiers.T1;
    const stored = { ...capped, tiers: { ...capped.tiers, T1: { ...isolatedT1, capable: true } } };
    expect(tierScoreFor(stored, "T1")).toMatchObject({ capable: false, cappedBy: "T2" });
    expect(tierScoreFor(stored, "T3")).toEqual(capped.tiers.T3);
    expect(tierScoreFor(undefined, "T1")).toBeUndefined();
  });
});
