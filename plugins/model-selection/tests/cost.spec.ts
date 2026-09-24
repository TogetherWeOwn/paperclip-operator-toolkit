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
    // TOG-4384: the guard is `age > PROFILE_MAX_AGE_MS`, so a profile aged
    // exactly 14 days is still trusted — the fail-closed edge, not past it.
    const atThreshold: VolumeProfile[] = [
      { ...t1, computedAt: new Date(NOW - PROFILE_MAX_AGE_MS).toISOString() },
    ];
    expect(resolveProfile("T1", atThreshold, NOW).trusted).toBe(true);
  });

  it("fails closed one millisecond past the 14-day threshold", () => {
    // TOG-4384: `age > PROFILE_MAX_AGE_MS` rejects anything older, so the
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
    expect(tierAbove("T1")).toBeNull();
    expect(escalationRisk("T1", MODELS, PROFILES, NO_ESCALATION, NOW)).toBe(0);
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
