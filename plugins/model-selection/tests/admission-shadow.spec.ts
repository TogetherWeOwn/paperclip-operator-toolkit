import { describe, expect, it } from 'vitest';
import { budgetWindowId, type BudgetInput, type BudgetWindowObservation } from '../src/admission-budget.js';
import { reportAdmissionShadow, reportDecisionAdmissionShadow, type AdmissionShadowInput } from '../src/admission-shadow.js';

function fixture(): AdmissionShadowInput {
  const window: BudgetWindowObservation = {
    providerId: 'provider', poolId: 'pool', kind: 'weekly', startAt: 0, resetAt: 10_000,
    observedAt: 1_000, sourceRevision: 'fixture', schemaRevision: 'v1', unit: 'allowance',
    quota: 100, consumed: 2, safetyHeadroom: 1, planWeight: 20, dataState: 'known',
  };
  const id = budgetWindowId(window);
  const sample: BudgetInput = {
    now: 1_000, maxAgeMs: 500, windows: [window], holds: [], eligibleBindings: [{
      accountId: 'account', providerId: 'provider', bindingKey: 'eligible', lane: 'lane',
      windowIds: [id], canStart: true, activeSlots: 0, maxSlots: 1, cooldownUntil: null,
      estimate: { revision: 'v1', durationMs: 100, windows: [{
        windowId: id, unit: 'allowance', upperBurn: 1, burnPerMs: 0.001, remainingDemandBurn: 96,
      }] },
    }],
  };
  return {
    enabled: true, cohortId: 'fixture-cohort', accounts: [{ accountId: 'account', providerId: 'provider', windowIds: [id] }],
    evidenceKind: 'synthetic-replay', startAt: 0, endAt: 10_000, samples: [sample],
  };
}

describe('bounded opt-in shadow admission report', () => {
  it('is inert when disabled, including invalid dormant input', () => {
    expect(reportAdmissionShadow({ enabled: false } as AdmissionShadowInput)).toBeNull();
  });

  it('reports a fixed synthetic cohort without claiming production reservations or complete validation', () => {
    const input = fixture();
    const before = structuredClone(input);
    const report = reportAdmissionShadow(input)!;
    expect(report).toMatchObject({
      mode: 'shadow-only', governsHostStarts: false, claimsReservations: false, selectedOrServedAccount: null,
      evidenceKind: 'synthetic-replay', productionEvidenceCertified: false, sampleCount: 1,
      firstEvaluatedAt: 1000, lastEvaluatedAt: 1000, completeWindowValidation: 'unproven',
      freshObservationValidation: 'unproven',
    });
    expect(report.accounts[0]).toMatchObject({
      proposalCounts: { admit: 1, defer: 0, unknown: 0 },
      windows: [{ utilizationAtLastSample: 0.02, attainmentAtLastSample: 'underuse',
        earlyExhaustionObserved: false, estimatedVersusActualBurnError: null, reserveOverlapUncertainty: 'unknown' }],
    });
    expect(report.limitations).toContain('Synthetic fixtures are not production evidence.');
    expect(input).toEqual(before);
  });

  it('keeps low use and exhaustion independent, even with different units, plan weights and resets', () => {
    const input = fixture();
    const other = { ...input.samples[0]!.windows[0]!, poolId: 'other', unit: 'credit',
      consumed: 1000, quota: 1000, planWeight: 1, resetAt: 20_000 };
    const id = budgetWindowId(other);
    input.samples[0]!.windows.push(other);
    input.accounts.push({ accountId: 'exhausted', providerId: 'provider', windowIds: [id] });
    const report = reportAdmissionShadow(input)!;
    expect(report.accounts[0]!.windows[0]!.attainmentAtLastSample).toBe('underuse');
    expect(report.accounts[1]!).toMatchObject({
      proposalCounts: { admit: 0, defer: 0, unknown: 0 }, infeasibilityReasons: ['no-capable-demand'],
      windows: [{ attainmentAtLastSample: '98-100', earlyExhaustionObserved: true }],
    });
    expect(report.evaluations[0]!.windows).toHaveLength(2);
  });

  it('counts a shared pool once, keeps accounts named, and reports no capable demand without inventing bindings', () => {
    const input = fixture();
    input.accounts.push({ ...structuredClone(input.accounts[0]!), accountId: 'same-pool-no-demand' });
    input.samples[0]!.windows.push(structuredClone(input.samples[0]!.windows[0]!));
    const report = reportAdmissionShadow(input)!;
    expect(report.accounts).toHaveLength(2);
    expect(report.accounts[1]!.infeasibilityReasons).toContain('no-capable-demand');
    expect(report.evaluations[0]!.windows).toHaveLength(1);
    expect(report.evaluations[0]!.bindings).toHaveLength(1);
    expect(report.evaluations[0]!.observations).toHaveLength(2);
  });

  it('reports timestamped samples, per-account proposals and target infeasibility separately', () => {
    const input = fixture();
    const next = structuredClone(input.samples[0]!);
    next.now = 2_000;
    next.windows[0]!.observedAt = 2_000;
    next.windows[0]!.consumed = 98;
    next.eligibleBindings[0]!.cooldownUntil = 3_000;
    input.samples.push(next);
    const report = reportAdmissionShadow(input)!;
    expect(report.lastEvaluatedAt).toBe(2000);
    expect(report.accounts[0]!).toMatchObject({ sampleCount: 2, proposalCounts: { admit: 1, defer: 1, unknown: 0 },
      windows: [{ observedAt: 2000, utilizationAtLastSample: 0.98, attainmentAtLastSample: '98-100' }] });
    expect(report.evaluations[1]!.bindings[0]!.reasons).toContain('cooldown');
    expect(report.completeWindowValidation).toBe('unproven');
  });

  it.each(['unknown', 'stale', 'invalid'] as const)('preserves %s quota diagnostics, never calling it free capacity', state => {
    const input = fixture();
    input.samples[0]!.windows[0]!.dataState = state;
    const report = reportAdmissionShadow(input)!;
    expect(report.accounts[0]!).toMatchObject({ proposalCounts: { admit: 0, defer: 0, unknown: 1 },
      windows: [{ utilizationAtLastSample: null, attainmentAtLastSample: 'unknown' }] });
    expect(report.accounts[0]!.infeasibilityReasons).toContain('allowance-unknown');
  });

  it('intersects opaque bindings with the existing landing-tier candidates and observed lane only', () => {
    const fixtureInput = fixture();
    const sample = fixtureInput.samples[0]!;
    const input = {
      enabled: true, cohortId: fixtureInput.cohortId, accounts: fixtureInput.accounts,
      maxAgeMs: sample.maxAgeMs, windows: sample.windows, holds: sample.holds,
      bindings: [{ modelId: 'eligible-model', binding: sample.eligibleBindings[0]! },
        { modelId: 'fallback-or-wrong-tier', binding: { ...sample.eligibleBindings[0]!, bindingKey: 'rejected-binding' } }],
    };
    const report = reportDecisionAdmissionShadow(input, sample.now, [{ modelId: 'eligible-model', lane: 'lane' }])!;
    expect(report.evaluations[0]!.bindings.map(b => b.bindingKey)).toEqual(['eligible']);
    expect(reportDecisionAdmissionShadow(input, sample.now, [{ modelId: 'eligible-model', lane: 'other' }])!.evaluations[0]!.bindings).toEqual([]);
    expect(reportDecisionAdmissionShadow(input, sample.now, [])!.accounts[0]!.infeasibilityReasons)
      .toContain('no-observed-eligible-account-binding');
    Object.assign(input.windows[0]!, { displayName: 'unapproved-extra-field' });
    expect(() => reportDecisionAdmissionShadow(input, sample.now, [{ modelId: 'eligible-model', lane: 'lane' }]))
      .toThrow('unexpected-shadow-input-fields');
  });

  it('caps fresh observations at 24h and does not certify caller-declared provenance', () => {
    const input = { ...fixture(), evidenceKind: 'fresh-observations' as const, endAt: 86_400_000 };
    expect(reportAdmissionShadow(input)!.productionEvidenceCertified).toBe(false);
    input.endAt++;
    expect(() => reportAdmissionShadow(input)).toThrow('fresh-shadow-period-exceeds-24-hours');
  });

  it.each(['start', 'end'] as const)('rejects replay beyond a single governing window (%s)', side => {
    const input = fixture();
    if (side === 'start') {
      input.startAt = 0;
      input.samples[0]!.windows[0]!.startAt = 1;
      const id = budgetWindowId(input.samples[0]!.windows[0]!);
      input.accounts[0]!.windowIds = [id];
      input.samples[0]!.eligibleBindings = [];
    } else input.endAt = 10_001;
    expect(() => reportAdmissionShadow(input)).toThrow('shadow-replay-exceeds-one-window');
  });

  it('requires known replay bounds but can report counts-only unknowns in bounded fresh snapshots', () => {
    const input = fixture();
    input.samples[0]!.windows[0]!.startAt = null;
    input.samples[0]!.windows[0]!.quota = null;
    input.samples[0]!.windows[0]!.consumed = null;
    input.accounts[0]!.windowIds = [budgetWindowId(input.samples[0]!.windows[0]!)];
    input.samples[0]!.eligibleBindings[0]!.windowIds = null;
    expect(() => reportAdmissionShadow(input)).toThrow('unknown-replay-window-bounds');
    input.evidenceKind = 'fresh-observations';
    expect(reportAdmissionShadow(input)!.accounts[0]!.infeasibilityReasons).toContain('account-binding-unavailable');
    expect(reportAdmissionShadow(input)!.accounts[0]!.windows[0]!.attainmentAtLastSample).toBe('unknown');
  });

  it('rejects out-of-cohort observations/bindings and omission of a tighter governing window', () => {
    const input = fixture();
    const outside = { ...input.samples[0]!.windows[0]!, poolId: 'outside' };
    input.samples[0]!.windows.push(outside);
    expect(() => reportAdmissionShadow(input)).toThrow('observation-outside-fixed-shadow-cohort');
    input.samples[0]!.windows.pop();
    input.samples[0]!.eligibleBindings[0]!.accountId = 'outside';
    expect(() => reportAdmissionShadow(input)).toThrow('binding-outside-fixed-shadow-cohort');
    input.samples[0]!.eligibleBindings[0]!.accountId = 'account';
    input.accounts[0]!.windowIds.push(budgetWindowId(outside));
    expect(() => reportAdmissionShadow(input)).toThrow('binding-omits-governing-shadow-window');
  });

  it('rejects unstable/duplicate accounts, duplicate sample clocks and oversized runs', () => {
    const input = fixture();
    input.accounts[0]!.accountId = 'record-1';
    expect(() => reportAdmissionShadow(input)).toThrow('invalid-shadow-account-identity-or-windows');
    input.accounts[0]!.accountId = 'account';
    input.accounts.push(structuredClone(input.accounts[0]!));
    expect(() => reportAdmissionShadow(input)).toThrow('invalid-shadow-account-identity-or-windows');
    input.accounts.pop();
    input.samples.push(structuredClone(input.samples[0]!));
    expect(() => reportAdmissionShadow(input)).toThrow('invalid-shadow-sample-bounds');
    input.samples = Array.from({ length: 257 }, () => structuredClone(input.samples[0]!));
    expect(() => reportAdmissionShadow(input)).toThrow('invalid-shadow-bounds-or-cohort');
  });
});
