import { describe, expect, it } from 'vitest';
import {
  budgetWindowId,
  type BudgetWindowObservation,
  type EligibleBudgetBinding,
} from '../src/admission-budget.js';
import {
  attributedServesFromAttestation,
  buildCapacityAccountingInput,
  evaluateCapacityAccounting,
  type CapacityAccountingInput,
} from '../src/capacity-accounting.js';

function weeklyWindow(overrides: Partial<BudgetWindowObservation> = {}): BudgetWindowObservation {
  return {
    providerId: 'claude',
    poolId: 'pool',
    kind: 'weekly',
    startAt: 0,
    resetAt: 10_000,
    observedAt: 10_000,
    sourceRevision: 'fixture',
    schemaRevision: 'v1',
    unit: 'allowance',
    quota: 100,
    consumed: 2,
    safetyHeadroom: 1,
    planWeight: 20,
    dataState: 'known',
    ...overrides,
  };
}

function inputFor(windows: BudgetWindowObservation[]): CapacityAccountingInput {
  const unique = [...new Set(windows.map(budgetWindowId))];
  return {
    now: 10_000,
    maxAgeMs: 60_000,
    accounts: [
      { accountId: 'low-use', providerId: 'claude', windowIds: [unique[0]!] },
      { accountId: 'exhausted', providerId: 'claude', windowIds: [unique[1] ?? unique[0]!] },
    ],
    windows,
  };
}

/** Open + close observation pair for one window, so completeness spans start..reset. */
function windowPair(poolId: string, consumedClose: number, consumedOpen = 0): BudgetWindowObservation[] {
  return [
    weeklyWindow({ poolId, consumed: consumedOpen, observedAt: 0 }),
    weeklyWindow({ poolId, consumed: consumedClose, observedAt: 10_000 }),
  ];
}

describe('capacity accounting fixtures-first contract ( slice 1)', () => {
  it('keeps low-use and exhausted accounts independent, never a lane average', () => {
    const report = evaluateCapacityAccounting(inputFor([...windowPair('low-pool', 2), ...windowPair('spent-pool', 100)]));
    const [lowProof, spentProof] = [
      report.accounts[0]!.windows[0]!,
      report.accounts[1]!.windows[0]!,
    ];
    expect(lowProof.complete).toBe(true);
    expect(lowProof.attainmentAtClose).toBe('underuse');
    expect(spentProof.attainmentAtClose).toBe('98-100');
    // Two pools with no attribution is plain unknown, not a 51% average.
    expect(report.servingIdentity).toMatchObject({ kind: 'unknown', reason: 'no-attribution' });
  });

  it('proves served-account affinity only from attributed records covering ALL governing windows', () => {
    const low = weeklyWindow({ poolId: 'low-pool', consumed: 2 });
    const spent = weeklyWindow({ poolId: 'spent-pool', consumed: 100 });
    const base = inputFor([low, spent]);
    const report = evaluateCapacityAccounting({
      ...base,
      serves: [{
        accountId: 'low-use',
        providerId: 'claude',
        servedAt: 9_000,
        windowIds: base.accounts[0]!.windowIds,
        collectorServedAuth: 'auth-low',
      }],
    });
    expect(report.servingIdentity).toMatchObject({
      kind: 'served-account',
      accountId: 'low-use',
      attribution: 'collector-served-auth',
    });
  });

  it('rejects affinity that omits a governing window instead of guessing', () => {
    const both = weeklyWindow({ poolId: 'pool', consumed: 2 });
    const id = budgetWindowId(both);
    const second = weeklyWindow({ poolId: 'pool', kind: 'monthly', startAt: 0, resetAt: 20_000, observedAt: 10_000 });
    const secondId = budgetWindowId(second);
    const input: CapacityAccountingInput = {
      now: 10_000,
      maxAgeMs: 60_000,
      accounts: [{ accountId: 'account', providerId: 'claude', windowIds: [id, secondId] }],
      windows: [both, second],
      serves: [{ accountId: 'account', providerId: 'claude', servedAt: 9_000, windowIds: [id] }],
    };
    expect(() => evaluateCapacityAccounting(input)).toThrow('serve-omits-governing-accounting-window');
  });

  it('falls back to a conservative shared-pool bound with no per-account attribution', () => {
    const first = weeklyWindow({ poolId: 'shared', consumed: 90 });
    const second = weeklyWindow({ poolId: 'shared', consumed: 40, observedAt: 9_000 });
    // Same pool, same window family: same budgetWindowId only when start/reset match,
    // so model the pool bound off two samples of one account cohort.
    const id = budgetWindowId(first);
    const input: CapacityAccountingInput = {
      now: 10_000,
      maxAgeMs: 60_000,
      accounts: [{ accountId: 'account', providerId: 'claude', windowIds: [id] }],
      windows: [first, second],
    };
    const report = evaluateCapacityAccounting(input);
    expect(report.servingIdentity).toMatchObject({
      kind: 'shared-pool-bound',
      poolId: 'shared',
      boundUtilization: 0.9,
      conservative: true,
    });
  });

  it('keeps missing Meta and short-window evidence unknown, never free', () => {
    const meta: BudgetWindowObservation = {
      ...weeklyWindow({ providerId: 'meta', poolId: 'meta-pool' }),
      dataState: 'unknown',
      consumed: null,
      quota: null,
    };
    const id = budgetWindowId(meta);
    const report = evaluateCapacityAccounting({
      now: 10_000,
      maxAgeMs: 60_000,
      accounts: [{ accountId: 'meta-account', providerId: 'meta', windowIds: [id] }],
      windows: [meta],
    });
    expect(report.accounts[0]!.windows[0]).toMatchObject({ complete: false, attainmentAtClose: 'unknown' });
    expect(report.servingIdentity).toMatchObject({ kind: 'unknown', reason: 'missing-meta' });
    expect(report.calibration[0]).toMatchObject({ calibrated: false, burnError: null });
  });

  it('marks conflicting attribution unknown instead of picking a winner', () => {
    const low = weeklyWindow({ poolId: 'low-pool', consumed: 2 });
    const spent = weeklyWindow({ poolId: 'spent-pool', consumed: 100 });
    const base = inputFor([low, spent]);
    const report = evaluateCapacityAccounting({
      ...base,
      serves: [
        { accountId: 'low-use', providerId: 'claude', servedAt: 9_000, windowIds: base.accounts[0]!.windowIds },
        { accountId: 'low-use', providerId: 'claude', servedAt: 9_100, windowIds: base.accounts[0]!.windowIds },
      ],
    });
    expect(report.servingIdentity).toMatchObject({ kind: 'unknown', reason: 'conflicting-attribution' });
  });

  it('marks distinct-account serves conflicting instead of first-wins', () => {
    const low = weeklyWindow({ poolId: 'low-pool', consumed: 2 });
    const spent = weeklyWindow({ poolId: 'spent-pool', consumed: 100 });
    const base = inputFor([low, spent]);
    const report = evaluateCapacityAccounting({
      ...base,
      serves: [
        { accountId: 'low-use', providerId: 'claude', servedAt: 9_000, windowIds: base.accounts[0]!.windowIds },
        { accountId: 'exhausted', providerId: 'claude', servedAt: 9_100, windowIds: base.accounts[1]!.windowIds },
      ],
    });
    expect(report.servingIdentity).toMatchObject({ kind: 'unknown', reason: 'conflicting-attribution' });
  });

  it('refuses watermark regression instead of silently rewinding', () => {
    const low = weeklyWindow({ poolId: 'low-pool', consumed: 2 });
    const spent = weeklyWindow({ poolId: 'spent-pool', consumed: 100 });
    const base = inputFor([low, spent]);
    const id = budgetWindowId(low);
    expect(() =>
      evaluateCapacityAccounting({
        ...base,
        priorWatermarks: [{ accountId: 'low-use', windowId: id, watermarkConsumed: 50, watermarkObservedAt: 10_000, monotone: true }],
      }),
    ).toThrow('accounting-watermark-regression');
  });

  it('rejects out-of-cohort observations and unstable identities loudly', () => {
    const low = weeklyWindow({ poolId: 'low-pool', consumed: 2 });
    const spent = weeklyWindow({ poolId: 'spent-pool', consumed: 100 });
    const base = inputFor([low, spent]);
    const outside = weeklyWindow({ poolId: 'outside', consumed: 1 });
    expect(() => evaluateCapacityAccounting({ ...base, windows: [...base.windows, outside] })).toThrow(
      'observation-outside-accounting-cohort',
    );
    expect(() =>
      evaluateCapacityAccounting({ ...base, accounts: [{ accountId: 'record-1', providerId: 'claude', windowIds: base.accounts[0]!.windowIds }] }),
    ).toThrow('invalid-accounting-account-identity-or-windows');
  });

  it('calibrates native consumed deltas against estimated burn without inventing either side', () => {
    const first = weeklyWindow({ poolId: 'pool', consumed: 20, observedAt: 5_000 });
    const second = weeklyWindow({ poolId: 'pool', consumed: 30, observedAt: 10_000 });
    const id = budgetWindowId(first);
    const input: CapacityAccountingInput = {
      now: 10_000,
      maxAgeMs: 60_000,
      accounts: [{ accountId: 'account', providerId: 'claude', windowIds: [id] }],
      windows: [first, second],
      estimatedBurnByWindowId: { [id]: 12 },
    };
    const report = evaluateCapacityAccounting(input);
    expect(report.calibration[0]).toMatchObject({
      windowId: id,
      nativeConsumedDelta: 10,
      estimatedBurn: 12,
      calibrated: true,
    });
    expect(report.calibration[0]!.burnError).toBeCloseTo(0.2, 6);
  });
});

function testBinding(overrides: Partial<EligibleBudgetBinding> = {}): EligibleBudgetBinding {
  return {
    bindingKey: 'lane:account',
    lane: 'lane',
    accountId: 'account',
    providerId: 'claude',
    windowIds: [],
    canStart: true,
    activeSlots: 0,
    maxSlots: 1,
    cooldownUntil: null,
    estimate: null,
    ...overrides,
  };
}

describe('capacity accounting feed adapter ( slice 2)', () => {
  it('feeds quota-contract windows plus pace bindings into a shared-pool bound with calibration', () => {
    const open = weeklyWindow({ poolId: 'shared', consumed: 0, observedAt: 0 });
    const close = weeklyWindow({ poolId: 'shared', consumed: 90, observedAt: 10_000 });
    const id = budgetWindowId(open);
    const feed = buildCapacityAccountingInput({
      now: 10_000,
      maxAgeMs: 60_000,
      windows: [open, close],
      eligibleBindings: [
        testBinding({
          windowIds: [id],
          estimate: {
            revision: 'fixture',
            durationMs: 1_000,
            windows: [{ windowId: id, unit: 'allowance', upperBurn: 12, remainingDemandBurn: 12 }],
          },
        }),
      ],
    });
    expect(feed.droppedStaleWindowIds).toEqual([]);
    expect(feed.excludedBindingKeys).toEqual([]);
    const report = evaluateCapacityAccounting(feed.input);
    expect(report.servingIdentity).toMatchObject({
      kind: 'shared-pool-bound',
      poolId: 'shared',
      boundUtilization: 0.9,
      conservative: true,
    });
    expect(report.calibration).toMatchObject([{ windowId: id, nativeConsumedDelta: 90, estimatedBurn: 12 }]);
  });

  it('drops stale samples outside the bounded fresh-observations window', () => {
    const fresh = weeklyWindow({ poolId: 'shared', consumed: 90, observedAt: 200_000 });
    const stale = weeklyWindow({ poolId: 'shared', consumed: 1, observedAt: 0 });
    const id = budgetWindowId(fresh);
    const feed = buildCapacityAccountingInput({
      now: 200_000,
      maxAgeMs: 60_000,
      windows: [fresh, stale],
      eligibleBindings: [testBinding({ windowIds: [id] })],
    });
    expect(feed.droppedStaleWindowIds).toEqual([budgetWindowId(stale)]);
    expect(feed.input.windows).toHaveLength(1);
  });

  it('refuses to certify when no fresh observation exists', () => {
    const stale = weeklyWindow({ poolId: 'shared', consumed: 1, observedAt: 0 });
    const id = budgetWindowId(stale);
    expect(() =>
      buildCapacityAccountingInput({
        now: 200_000,
        maxAgeMs: 60_000,
        windows: [stale],
        eligibleBindings: [testBinding({ windowIds: [id] })],
      }),
    ).toThrow('accounting-feed-no-fresh-observations');
  });

  it('excludes bindings with unobserved account/pool compatibility instead of guessing a cohort', () => {
    const open = weeklyWindow({ poolId: 'shared', consumed: 0, observedAt: 0 });
    const close = weeklyWindow({ poolId: 'shared', consumed: 50, observedAt: 10_000 });
    const id = budgetWindowId(open);
    const feed = buildCapacityAccountingInput({
      now: 10_000,
      maxAgeMs: 60_000,
      windows: [open, close],
      eligibleBindings: [
        testBinding({ bindingKey: 'lane:known', accountId: 'account', windowIds: [id] }),
        testBinding({ bindingKey: 'lane:ghost', accountId: 'ghost', windowIds: null }),
      ],
    });
    expect(feed.excludedBindingKeys).toEqual(['lane:ghost']);
    expect(feed.input.accounts).toMatchObject([{ accountId: 'account' }]);
  });

  it('takes the max remaining-demand burn across bindings, never the sum', () => {
    const first = weeklyWindow({ poolId: 'shared', consumed: 20, observedAt: 5_000 });
    const second = weeklyWindow({ poolId: 'shared', consumed: 30, observedAt: 10_000 });
    const id = budgetWindowId(first);
    const feed = buildCapacityAccountingInput({
      now: 10_000,
      maxAgeMs: 60_000,
      windows: [first, second],
      eligibleBindings: [
        testBinding({
          bindingKey: 'lane:a',
          windowIds: [id],
          estimate: {
            revision: 'fixture',
            durationMs: 1_000,
            windows: [{ windowId: id, unit: 'allowance', upperBurn: 8, remainingDemandBurn: 8 }],
          },
        }),
        testBinding({
          bindingKey: 'lane:b',
          windowIds: [id],
          estimate: {
            revision: 'fixture',
            durationMs: 1_000,
            windows: [{ windowId: id, unit: 'allowance', upperBurn: 12, remainingDemandBurn: 12 }],
          },
        }),
      ],
    });
    expect(feed.input.estimatedBurnByWindowId?.[id]).toBe(12);
  });
});

describe('capacity accounting attested-serve join ( slice 3)', () => {
  it('proves served-account affinity end to end: feed plus attested serve', () => {
    const open = weeklyWindow({ poolId: 'shared', consumed: 0, observedAt: 0 });
    const close = weeklyWindow({ poolId: 'shared', consumed: 90, observedAt: 10_000 });
    const id = budgetWindowId(open);
    const feed = buildCapacityAccountingInput({
      now: 10_000,
      maxAgeMs: 60_000,
      windows: [open, close],
      eligibleBindings: [testBinding({ windowIds: [id] })],
    });
    const serves = attributedServesFromAttestation(['auth-low', null], [{
      accountId: 'account',
      providerId: 'claude',
      servedAuth: 'auth-low',
      servedAt: 9_000,
      windowIds: [id],
    }]);
    const report = evaluateCapacityAccounting({ ...feed.input, serves });
    expect(report.servingIdentity).toMatchObject({
      kind: 'served-account',
      accountId: 'account',
      attribution: 'collector-served-auth',
    });
  });

  it('refuses an attested auth never observed in the cohort instead of guessing', () => {
    expect(() =>
      attributedServesFromAttestation(['auth-low'], [{
        accountId: 'account',
        providerId: 'claude',
        servedAuth: 'auth-ghost',
        servedAt: 9_000,
        windowIds: ['window'],
      }]),
    ).toThrow('serve-auth-not-in-observed-cohort');
  });

  it('refuses empty observed cohorts and malformed attestations loudly', () => {
    const attestation = {
      accountId: 'account',
      providerId: 'claude',
      servedAuth: 'auth-low',
      servedAt: 9_000,
      windowIds: ['window'],
    };
    expect(() => attributedServesFromAttestation([], [attestation])).toThrow(
      'serve-auth-not-in-observed-cohort',
    );
    expect(() => attributedServesFromAttestation([null], [attestation])).toThrow(
      'serve-auth-not-in-observed-cohort',
    );
    expect(() =>
      attributedServesFromAttestation(['auth-low'], [{ ...attestation, servedAuth: '' }]),
    ).toThrow('invalid-accounting-attestation');
    expect(() =>
      attributedServesFromAttestation(['auth-low'], [{ ...attestation, windowIds: [] }]),
    ).toThrow('invalid-accounting-serve-windows');
  });
});
