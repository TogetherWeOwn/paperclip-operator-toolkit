import { describe, expect, it } from "vitest";

import {
  MIN_PROFILE_SAMPLES,
  PROFILE_MAX_AGE_MS,
  costOf,
  escalationRisk,
  resolveProfile,
  runCost,
  tierAbove,
} from "../src/engine/cost.js";
import type { QualitySignal, VolumeProfile } from "../src/engine/types.js";
import { FRESH, MODELS, NO_ESCALATION, NOW, PROFILES } from "./fixtures.js";

const opus = MODELS.find((m) => m.id === "claude-opus-5")!;
const t1 = PROFILES.find((p) => p.tier === "T1")!;

describe("the cost term is volume-aware", () => {
  it("reproduces the measured average opus run cost within a few percent", () => {
    // Live 7d measurement, 2026-08-31: opus avg_cost_run = $7.158 over 214 runs.
    // If this drifts far from that, the rate card or the profile is wrong.
    const cost = runCost(opus, t1);
    expect(cost.runCostUsd).toBeGreaterThan(6.5);
    expect(cost.runCostUsd).toBeLessThan(7.8);
  });

  it("prices cache read as the largest single line, not as input", () => {
    // ADR-0002: cache read is 44% of the opus bill. An engine that folds it
    // into input, or omits it, orders on the wrong term.
    const cost = runCost(opus, t1);
    expect(cost.cacheReadCostUsd).toBeGreaterThan(cost.inputCostUsd);
    expect(cost.cacheReadCostUsd).toBeGreaterThan(cost.outputCostUsd);
    const share = cost.cacheReadCostUsd / cost.runCostUsd;
    expect(share).toBeGreaterThan(0.4);
  });

  it("differs from a single-request estimate by more than an order of magnitude", () => {
    // The reference engine (paperclip-model-router select.ts:70-77) defaults to
    // 8k input / 2k output and has no cache-read term. That is the blindness
    // this module exists to fix — assert the gap is real, not cosmetic.
    const referenceStyle =
      (8_000 / 1_000_000) * opus.costPerMTokIn + (2_000 / 1_000_000) * opus.costPerMTokOut;
    const volumeAware = runCost(opus, t1).runCostUsd;
    expect(volumeAware / referenceStyle).toBeGreaterThan(10);
  });
});

describe("profile trust", () => {
  it("rejects a profile below the sample minimum", () => {
    const thin: VolumeProfile[] = [{ ...t1, sampleCount: MIN_PROFILE_SAMPLES - 1 }];
    const verdict = resolveProfile("T1", thin, NOW);
    expect(verdict.trusted).toBe(false);
    expect(verdict.reason).toContain("below the");
  });

  it("rejects a stale profile", () => {
    const stale: VolumeProfile[] = [
      { ...t1, computedAt: new Date(NOW - 30 * 24 * 60 * 60 * 1000).toISOString() },
    ];
    const verdict = resolveProfile("T1", stale, NOW);
    expect(verdict.trusted).toBe(false);
    expect(verdict.reason).toContain("days old");
  });

  it("trusts a profile exactly at the 14-day threshold", () => {
    // the guard is `age > PROFILE_MAX_AGE_MS`, so a profile aged
    // exactly 14 days is still trusted — the fail-closed edge, not past it.
    const atThreshold: VolumeProfile[] = [
      { ...t1, computedAt: new Date(NOW - PROFILE_MAX_AGE_MS).toISOString() },
    ];
    expect(resolveProfile("T1", atThreshold, NOW).trusted).toBe(true);
  });

  it("fails closed one millisecond past the 14-day threshold", () => {
    // `age > PROFILE_MAX_AGE_MS` rejects anything older, so the
    // seeded PROFILES (computedAt = NOW - 1h) only stay trusted while `now`
    // stays near NOW — the regression this freeze exists to pin.
    const justStale: VolumeProfile[] = [
      { ...t1, computedAt: new Date(NOW - PROFILE_MAX_AGE_MS - 1).toISOString() },
    ];
    const verdict = resolveProfile("T1", justStale, NOW);
    expect(verdict.trusted).toBe(false);
    expect(verdict.reason).toContain("days old");
  });

  it("reports a missing profile rather than substituting a default", () => {
    const verdict = resolveProfile("T1", [], NOW);
    expect(verdict.profile).toBeNull();
    expect(verdict.trusted).toBe(false);
  });

  it("accepts a fresh, well-sampled profile", () => {
    expect(resolveProfile("T3", PROFILES, NOW).trusted).toBe(true);
  });
});

describe("escalation risk", () => {
  it("is zero at the top tier — there is nothing to escalate to", () => {
    expect(tierAbove("T0")).toBeNull();
    expect(escalationRisk("T0", MODELS, PROFILES, NO_ESCALATION, NOW, "T0")).toBe(0);
  });

  describe("T0 sits above T1 but is not an implicit escalation target", () => {
    const t0Opus = { ...opus, id: "t0-model", tier: "T0" as const };
    const withT0 = [...MODELS, t0Opus];
    const t0Profile: VolumeProfile = { ...t1, tier: "T0" };
    const profiles = [...PROFILES, t0Profile];
    const signals: QualitySignal[] = [
      { tier: "T1", escalationRate: 0.5, silentFailureCount: 0, sampleCount: 40, computedAt: FRESH },
    ];

    it("tierAbove walks the ladder through T1 to T0", () => {
      expect(tierAbove("T3")).toBe("T2");
      expect(tierAbove("T2")).toBe("T1");
      expect(tierAbove("T1")).toBe("T0");
    });

    it("charges a T1 card no T0 redo at the implicit ceiling, however high the T1 escalation rate", () => {
      expect(escalationRisk("T1", withT0, profiles, signals, NOW)).toBe(0);
    });

    it("prices the T0 redo only when the decision is admitted to T0 (positive control)", () => {
      const risk = escalationRisk("T1", withT0, profiles, signals, NOW, "T0");
      expect(risk).toBeCloseTo(runCost(t0Opus, t0Profile).runCostUsd * 0.5, 6);
      expect(risk).toBeGreaterThan(0);
    });

    it("never prices a fallback-only T0 row as the redo", () => {
      const fallbackOnlyT0 = [...MODELS, { ...t0Opus, fallbackOnly: true }];
      expect(escalationRisk("T1", fallbackOnlyT0, profiles, signals, NOW, "T0")).toBe(0);
    });

    it("costOf takes the same ceiling: a T1 candidate carries no T0 escalation term by default", () => {
      const implicit = costOf(opus, "T1", profiles, withT0, signals, NOW);
      const admitted = costOf(opus, "T1", profiles, withT0, signals, NOW, "T0");
      expect(implicit?.escalationRiskUsd).toBe(0);
      expect(admitted?.escalationRiskUsd).toBeGreaterThan(0);
    });
  });

  it("is zero when the measured escalation rate is a true zero", () => {
    // Pre-flip, escalation was genuinely 0.0% (self-test 3/3 PASS), so the
    // term must vanish rather than invent a penalty.
    expect(escalationRisk("T2", MODELS, PROFILES, NO_ESCALATION, NOW)).toBe(0);
  });

  it("prices an escalation as a full extra run at the tier above", () => {
    const signals: QualitySignal[] = [
      { tier: "T2", escalationRate: 0.5, silentFailureCount: 0, sampleCount: 40, computedAt: FRESH },
    ];
    const risk = escalationRisk("T2", MODELS, PROFILES, signals, NOW);
    const t1Cost = runCost(opus, PROFILES.find((p) => p.tier === "T1")!).runCostUsd;
    expect(risk).toBeCloseTo(t1Cost * 0.5, 6);
  });

  it("weights one silent quality failure as ten escalations", () => {
    // ADR-0005's load-bearing asymmetry: an escalation is visible and
    // self-correcting; a silent failure is invisible by construction.
    const oneSilent: QualitySignal[] = [
      { tier: "T2", escalationRate: 0, silentFailureCount: 1, sampleCount: 100, computedAt: FRESH },
    ];
    const tenEscalations: QualitySignal[] = [
      { tier: "T2", escalationRate: 0.1, silentFailureCount: 0, sampleCount: 100, computedAt: FRESH },
    ];
    expect(escalationRisk("T2", MODELS, PROFILES, oneSilent, NOW)).toBeCloseTo(
      escalationRisk("T2", MODELS, PROFILES, tenEscalations, NOW),
      6,
    );
  });

  it("never lets the effective rate exceed 1", () => {
    const catastrophic: QualitySignal[] = [
      { tier: "T2", escalationRate: 0.9, silentFailureCount: 50, sampleCount: 60, computedAt: FRESH },
    ];
    const risk = escalationRisk("T2", MODELS, PROFILES, catastrophic, NOW);
    const t1Cost = runCost(opus, PROFILES.find((p) => p.tier === "T1")!).runCostUsd;
    expect(risk).toBeCloseTo(t1Cost, 6);
  });
});

describe("costOf", () => {
  it("returns null rather than guessing when the profile is absent", () => {
    expect(costOf(opus, "T1", [], MODELS, NO_ESCALATION, NOW)).toBeNull();
  });

  it("marks an untrusted profile so the caller can refuse to act on it", () => {
    const thin: VolumeProfile[] = [{ ...t1, sampleCount: 1 }];
    const cost = costOf(opus, "T1", thin, MODELS, NO_ESCALATION, NOW);
    expect(cost?.profileTrusted).toBe(false);
  });
});
