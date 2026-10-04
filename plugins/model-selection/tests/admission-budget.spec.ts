import { describe, expect, it } from 'vitest';
import {
  budgetWindowId, evaluateBudgets,
  type BudgetInput, type BudgetWindowObservation, type EligibleBudgetBinding,
} from '../src/admission-budget.js';

export function windowFixture(overrides: Partial<BudgetWindowObservation> = {}): BudgetWindowObservation {
  return {
    providerId: 'provider', poolId: 'pool-a', kind: 'weekly', startAt: 0,
    resetAt: 10_000, observedAt: 1_000, sourceRevision: 'fixture-1', schemaRevision: 'v1',
    unit: 'allowance', quota: 100, consumed: 2, safetyHeadroom: 1, planWeight: 20,
    dataState: 'known', ...overrides,
  };
}

export function bindingFixture(windows = [windowFixture()], overrides: Partial<EligibleBudgetBinding> = {}): EligibleBudgetBinding {
  return {
    bindingKey: 'opaque-eligible-binding', lane: 'lane', accountId: 'account-a', providerId: 'provider',
    windowIds: windows.map(budgetWindowId), canStart: true, activeSlots: 0, maxSlots: 3, cooldownUntil: null,
    estimate: { revision: 'estimate-v1', durationMs: 100, windows: windows.map(w => ({
      windowId: budgetWindowId(w), unit: w.unit!, upperBurn: 1, burnPerMs: 0.001, remainingDemandBurn: 96,
    })) }, ...overrides,
  };
}

export function inputFixture(windows = [windowFixture()], bindings = [bindingFixture(windows)]): BudgetInput {
  return { now: 1_000, maxAgeMs: 500, windows, eligibleBindings: bindings, holds: [] };
}

describe('shadow account/window budget evaluator', () => {
  it('keeps independent reset identities and plan weights, never blending low use with exhaustion', () => {
    const low = windowFixture();
    const exhausted = windowFixture({ poolId: 'pool-b', resetAt: 20_000, consumed: 100, planWeight: 1 });
    const input = inputFixture([low, exhausted], [bindingFixture([low]), bindingFixture([exhausted], {
      accountId: 'account-b', bindingKey: 'other-binding',
    })]);
    const result = evaluateBudgets(input);
    expect(result.windows.map(w => [w.utilization, w.raw.planWeight, w.raw.resetAt])).toEqual([
      [0.02, 20, 10_000], [1, 1, 20_000],
    ]);
    expect(result.bindings[0]!.proposal).toBe('admit');
    expect(result.bindings[1]!.proposal).toBe('defer');
    expect(result.bindings[1]!.allowedStarts).toBe(0);
    expect(input.windows[0]!.consumed).toBe(2);
  });

  it.each(['five-hour', 'monthly'] as const)('applies exhausted %s alongside weekly headroom', kind => {
    const windows = [windowFixture(), windowFixture({ kind, resetAt: 5_000, consumed: 100 })];
    const result = evaluateBudgets(inputFixture(windows));
    expect(result.bindings[0]!.proposal).toBe('defer');
    expect(result.bindings[0]!.reasons).toContain('safe-budget-insufficient');
  });

  it('counts identical shared pools once and keeps unlike units separate', () => {
    const shared = windowFixture();
    const tokens = windowFixture({ poolId: 'token-pool', unit: 'vendor-credit', quota: 1000, consumed: 100 });
    const result = evaluateBudgets(inputFixture([shared, { ...shared }, tokens]));
    expect(result.windows).toHaveLength(2);
    expect(result.windows.map(w => w.safeBudget)).toEqual([97, 899]);
    expect(result.observations).toHaveLength(3);
    const input = inputFixture([shared, tokens]);
    input.eligibleBindings[0]!.estimate!.windows[1]!.unit = 'allowance';
    expect(evaluateBudgets(input).bindings[0]!.proposal).toBe('unknown');
  });

  it('rejects conflicting duplicate pool observations, preserving raw data', () => {
    const result = evaluateBudgets(inputFixture([windowFixture(), windowFixture({ consumed: 5 })]));
    expect(result.windows[0]!.dataState).toBe('invalid');
    expect(result.windows[0]!.safeBudget).toBeNull();
    expect(result.observations.map(w => w.consumed)).toEqual([2, 5]);
  });

  it.each([
    ['unknown', { quota: null }, 'unknown'],
    ['stale', { observedAt: 499 }, 'stale'],
    ['invalid', { consumed: 101 }, 'invalid'],
    ['negative usage', { consumed: -1 }, 'invalid'],
    ['future clock', { observedAt: 1001 }, 'invalid'],
    ['bad reset', { resetAt: 0 }, 'invalid'],
    ['no start', { startAt: null }, 'unknown'],
    ['no unit', { unit: null }, 'unknown'],
    ['no revision', { schemaRevision: null }, 'unknown'],
    ['email identity', { poolId: 'person@example.com' }, 'invalid'],
    ['order identity', { poolId: 'record-17' }, 'invalid'],
  ] as const)('fails closed on %s without substituting zero', (_name, patch, state) => {
    const result = evaluateBudgets(inputFixture([windowFixture(patch)]));
    expect(result.windows[0]!.dataState).toBe(state);
    expect(result.windows[0]!.safeBudget).toBeNull();
    expect(result.bindings[0]!.proposal).toBe('unknown');
    expect(result.bindings[0]!.allowedStarts).toBeNull();
  });

  it.each([0, -1, Infinity, NaN])('requires explicit finite positive maxAgeMs (%s)', maxAgeMs => {
    const input = { ...inputFixture(), maxAgeMs };
    expect(evaluateBudgets(input).windows[0]!.dataState).toBe('invalid');
  });

  it('keeps counts-only serviceability as unknown allowance and unobserved binding as unknown', () => {
    const input = inputFixture([windowFixture({ quota: null, consumed: null })]);
    expect(evaluateBudgets(input).bindings[0]!).toMatchObject({
      proposal: 'unknown', allowedStarts: null, continuousConcurrency: null,
      targetInfeasibility: ['allowance-unknown'],
    });
    input.eligibleBindings[0]!.windowIds = null;
    expect(evaluateBudgets(input).bindings[0]!.targetInfeasibility).toContain('account-binding-unavailable');
  });

  it('does not admit missing burn estimates or invent an account from the lane', () => {
    const input = inputFixture();
    input.eligibleBindings[0]!.estimate = null;
    expect(evaluateBudgets(input).bindings[0]!.proposal).toBe('unknown');
    expect(evaluateBudgets(input).selectedOrServedAccount).toBeNull();
  });

  it('separates deficit D from safe rate S when headroom precludes 98%', () => {
    const input = inputFixture([windowFixture({ safetyHeadroom: 10 })]);
    input.holds = [{ windowId: budgetWindowId(input.windows[0]!), unit: 'allowance', amount: 3 }];
    const result = evaluateBudgets(input);
    expect(result.windows[0]!).toMatchObject({ reserved: 3, safeBudget: 85 });
    expect(result.windows[0]!.targetRatePerMs).toBe(93 / 9000);
    expect(result.windows[0]!.sustainableRatePerMs).toBe(85 / 9000);
    expect(result.bindings[0]!.targetInfeasibility).toContain('safety-ceiling-precludes-target');
    expect(result.bindings[0]!.proposal).toBe('admit');
    expect(result.bindings[0]!.projections[0]!).toEqual({
      windowId: budgetWindowId(input.windows[0]!), projectedEndUtilization: 1.01, earlyExhaustionRisk: true,
    });
  });

  it('clamps slots independently of quota, respecting cooldown and lane gates', () => {
    const input = inputFixture();
    input.eligibleBindings[0]!.cooldownUntil = 2_000;
    expect(evaluateBudgets(input).bindings[0]!).toMatchObject({ proposal: 'defer', allowedStarts: 0, nextEligibleStartAt: 2_000 });
    input.eligibleBindings[0]!.cooldownUntil = null;
    input.eligibleBindings[0]!.activeSlots = 3;
    expect(evaluateBudgets(input).bindings[0]!.reasons).toContain('active-slot-limit');
    input.eligibleBindings[0]!.activeSlots = 0;
    input.eligibleBindings[0]!.canStart = false;
    expect(evaluateBudgets(input).bindings[0]!.reasons).toContain('lane-gate-closed');
  });

  it('offers a bounded fractional-concurrency start and requires re-evaluation at that time', () => {
    const input = inputFixture([windowFixture({ consumed: 94 })]);
    const result = evaluateBudgets(input).bindings[0]!;
    expect(result.continuousConcurrency).toBeCloseTo(5 / 9);
    expect(result.integerConcurrency).toBe(0);
    expect(result.nextEligibleStartAt).toBe(5_000);
    expect(result.proposal).toBe('defer');
    // Same data is now stale, so a start is NOT automatically permitted.
    expect(evaluateBudgets({ ...input, now: 5_000 }).bindings[0]!.proposal).toBe('unknown');
    input.windows[0]!.observedAt = 5_000;
    expect(evaluateBudgets({ ...input, now: 5_000 }).bindings[0]!.proposal).toBe('admit');
  });

  it('checks the rounded advisory start against reset, not its unrounded fraction', () => {
    const input = inputFixture([windowFixture({ resetAt: 1000.2, consumed: 99.99985, safetyHeadroom: 0 })]);
    input.eligibleBindings[0]!.estimate!.durationMs = 0.1;
    input.eligibleBindings[0]!.estimate!.windows[0]!.upperBurn = 0.00001;
    expect(evaluateBudgets(input).bindings[0]!.nextEligibleStartAt).toBeNull();
  });

  it('cannot promise next-start eligibility across a tighter reset', () => {
    const windows = [windowFixture({ consumed: 94 }), windowFixture({ kind: 'five-hour', resetAt: 3_000 })];
    expect(evaluateBudgets(inputFixture(windows)).bindings[0]!.nextEligibleStartAt).toBeNull();
  });

  it('explicitly rejects jobs that cross reset and diagnoses insufficient demand', () => {
    const input = inputFixture();
    input.eligibleBindings[0]!.estimate!.durationMs = 9_000;
    expect(evaluateBudgets(input).bindings[0]!.reasons).toContain('reset-crossover-unsupported');
    input.eligibleBindings[0]!.estimate!.durationMs = 100;
    input.eligibleBindings[0]!.estimate!.windows[0]!.remainingDemandBurn = 1;
    expect(evaluateBudgets(input).bindings[0]!.targetInfeasibility).toContain('insufficient-eligible-demand');
  });

  it('rejects contradictory reset identities for the same active pool and kind', () => {
    const result = evaluateBudgets(inputFixture([windowFixture(), windowFixture({ resetAt: 20_000 })]));
    expect(result.windows.every(w => w.dataState === 'invalid')).toBe(true);
    expect(result.bindings[0]!.proposal).toBe('unknown');
  });

  it('rejects duplicate binding keys instead of reporting ambiguous admission', () => {
    const input = inputFixture();
    input.eligibleBindings.push(structuredClone(input.eligibleBindings[0]!));
    expect(evaluateBudgets(input).bindings.every(b => b.proposal === 'unknown' && b.allowedStarts === null)).toBe(true);
  });

  it('consumes only the existing eligible binding set, never reconstructing tier/effort/fallback eligibility', () => {
    const input = inputFixture();
    input.eligibleBindings = [];
    expect(evaluateBudgets(input).bindings).toEqual([]);
    expect(evaluateBudgets(input).windows).toHaveLength(1);
  });
});
