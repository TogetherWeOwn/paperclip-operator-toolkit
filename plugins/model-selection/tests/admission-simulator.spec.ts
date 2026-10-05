import { describe, expect, it } from 'vitest';
import { budgetWindowId, type BudgetInput, type BudgetWindowObservation } from '../src/admission-budget.js';
import { AdmissionSimulator, type SimulatedAttempt, type SimulatedReconciliation, type SimulatedReservation } from '../src/admission-simulator.js';

function fixture(): BudgetInput {
  const windows: BudgetWindowObservation[] = [{
    providerId: 'provider', poolId: 'pool', kind: 'weekly', startAt: 0, resetAt: 10_000,
    observedAt: 1_000, sourceRevision: 'fixture', schemaRevision: 'v1', unit: 'allowance',
    quota: 100, consumed: 90, safetyHeadroom: 0, planWeight: 1, dataState: 'known',
  }];
  return {
    now: 1_000, maxAgeMs: 500, windows, holds: [], eligibleBindings: [{
      bindingKey: 'eligible', lane: 'lane', accountId: 'account', providerId: 'provider',
      windowIds: windows.map(budgetWindowId), canStart: true, activeSlots: 0, maxSlots: 3, cooldownUntil: null,
      estimate: { revision: 'v1', durationMs: 100, windows: [{
        windowId: budgetWindowId(windows[0]!), unit: 'allowance', upperBurn: 10,
      }] },
    }],
  };
}
function attempt(input: BudgetInput, idempotencyKey = 'logical-attempt-1'): SimulatedAttempt {
  return { idempotencyKey, bindingKey: 'eligible', estimate: structuredClone(input.eligibleBindings[0]!.estimate!) };
}
function reflection(input: BudgetInput, reservationId: string): SimulatedReconciliation {
  return {
    reconciliationId: 'reflection-1', reservationId, windowId: budgetWindowId(input.windows[0]!),
    unit: 'allowance', reflectedAmount: 10, consumed: 100, observedAt: 1_000,
    sourceRevision: 'fixture-2', usageWatermark: 1, attributionTrusted: true,
  };
}

function ownershipFixture(): BudgetInput {
  const input = fixture();
  input.windows[0]!.consumed = 40;
  input.holds.push({ windowId: budgetWindowId(input.windows[0]!), unit: 'allowance', amount: 10 });
  input.eligibleBindings[0]!.maxSlots = 2;
  return input;
}

function corruptReservation(reservation: SimulatedReservation): void {
  reservation.reservationId = 'caller-id';
  reservation.idempotencyKey = 'caller-key';
  reservation.bindingKey = 'caller-binding';
  reservation.lane = 'caller-lane';
  reservation.estimateRevision = 'caller-revision';
  reservation.durationMs = 9_000;
  reservation.state = 'cancelled-before-start';
  reservation.slotHeld = false;
  reservation.reconciliation = 'known';
  Object.assign(reservation.amounts[0]!, {
    windowId: 'caller-window', unit: 'caller-unit', reservedAmount: 0, remainingAmount: 0, windowClosed: true,
  });
  reservation.amounts.push({ ...reservation.amounts[0]! });
}

function partialReflection(input: BudgetInput, reservationId: string): SimulatedReconciliation {
  return { ...reflection(input, reservationId), reflectedAmount: 4, consumed: 44 };
}

describe('simulation-only reservation lifecycle', () => {
  it('replays an identical logical attempt; rejects a changed payload on the same key', () => {
    const input = fixture();
    const sim = new AdmissionSimulator(input);
    const request = attempt(input);
    const first = sim.reserve(request);
    expect(first.admitted).toBe(true);
    expect(sim.reserve(structuredClone(request))).toEqual(first);
    expect(sim.snapshot()).toHaveLength(1);
    request.estimate.windows[0]!.upperBurn = 1;
    expect(() => sim.reserve(request)).toThrow('idempotency-key-payload-mismatch');
    expect(sim.evaluate().windows[0]!.reserved).toBe(10);
  });

  it('serializes two simultaneous last-budget attempts without spending twice', async () => {
    const input = fixture();
    const sim = new AdmissionSimulator(input);
    const results = await Promise.all(['a', 'b'].map(key => Promise.resolve().then(() => sim.reserve(attempt(input, key)))));
    expect(results.map(r => r.admitted)).toEqual([true, false]);
    expect(sim.evaluate().windows[0]!.safeBudget).toBe(0);
    // Replaying the losing logical attempt cannot become a new start.
    sim.cancelBeforeStart(results[0]!.reservation!.reservationId);
    expect(sim.reserve(attempt(input, 'b'))).toEqual(results[1]);
  });

  it('checks all pools before allocation and never partially holds a passing weekly window', () => {
    const input = fixture();
    const shorter = { ...input.windows[0]!, kind: 'five-hour' as const, resetAt: 5_000, consumed: 100 };
    input.windows.push(shorter);
    input.eligibleBindings[0]!.windowIds!.push(budgetWindowId(shorter));
    input.eligibleBindings[0]!.estimate!.windows.push({ windowId: budgetWindowId(shorter), unit: 'allowance', upperBurn: 10 });
    const sim = new AdmissionSimulator(input);
    expect(sim.reserve(attempt(input)).admitted).toBe(false);
    expect(sim.snapshot()).toEqual([]);
    expect(sim.evaluate().windows.map(w => w.reserved)).toEqual([0, 0]);
  });

  it('cancels only before start and makes commit/cancel idempotent', () => {
    const input = fixture();
    const sim = new AdmissionSimulator(input);
    const id = sim.reserve(attempt(input)).reservation!.reservationId;
    const cancelled = sim.cancelBeforeStart(id);
    expect(sim.cancelBeforeStart(id)).toEqual(cancelled);
    expect(sim.evaluate().windows[0]!.safeBudget).toBe(10);
    expect(() => sim.commit(id)).toThrow('cannot-commit-cancelled-reservation');
    const next = sim.reserve(attempt(input, 'retry-after-proven-cancellation')).reservation!;
    const committed = sim.commit(next.reservationId);
    expect(sim.commit(next.reservationId)).toEqual(committed);
    expect(() => sim.cancelBeforeStart(next.reservationId)).toThrow('cannot-refund-started-attempt');
  });

  it('retains allowance on charged failure/timeout even after an observed job end frees its slot', () => {
    const input = fixture();
    const sim = new AdmissionSimulator(input);
    const id = sim.reserve(attempt(input)).reservation!.reservationId;
    sim.commit(id);
    expect(sim.finish(id)).toMatchObject({ slotHeld: false, state: 'committed', reconciliation: 'unknown' });
    expect(sim.evaluate().windows[0]!.reserved).toBe(10);
    expect(sim.reserve(attempt(input, 'failure-retry')).admitted).toBe(false);
  });

  it('applies attributed consumption and retires the matching hold once, never double deducting', () => {
    const input = fixture();
    const sim = new AdmissionSimulator(input);
    const id = sim.reserve(attempt(input)).reservation!.reservationId;
    sim.commit(id);
    const event = reflection(input, id);
    const reconciled = sim.reconcile(event);
    expect(reconciled.state).toBe('reconciled');
    expect(sim.evaluate().windows[0]!).toMatchObject({ reserved: 0, safeBudget: 0, raw: { consumed: 100 } });
    expect(sim.reconcile(event)).toEqual(reconciled);
    expect(sim.evaluate().windows[0]!.raw.consumed).toBe(100);
    expect(() => sim.reconcile({ ...event, consumed: 99 })).toThrow('reconciliation-key-payload-mismatch');
    expect(() => sim.reconcile({ ...event, reconciliationId: 'another', usageWatermark: 1 })).toThrow('invalid-usage-watermark-or-attribution');
  });

  it('retains incremental remainder on partial reflection and refuses invented or unmatched refunds', () => {
    const input = fixture();
    const sim = new AdmissionSimulator(input);
    const id = sim.reserve(attempt(input)).reservation!.reservationId;
    sim.commit(id);
    const event = { ...reflection(input, id), reflectedAmount: 4, consumed: 94 };
    expect(sim.reconcile(event)).toMatchObject({ state: 'committed', reconciliation: 'unknown' });
    expect(sim.evaluate().windows[0]!).toMatchObject({ reserved: 6, safeBudget: 0, raw: { consumed: 94 } });
    expect(() => sim.reconcile({ ...event, reconciliationId: 'bad', unit: 'tokens' })).toThrow('reservation-window-or-unit-mismatch');
    expect(() => sim.reconcile({ ...event, reconciliationId: 'bad-delta', usageWatermark: 2, reflectedAmount: 6, consumed: 94 })).toThrow('invalid-usage-watermark-or-attribution');
  });

  it.each([{ attributionTrusted: false }, { usageWatermark: null }])('keeps conservative holds with uncertain attribution (%s)', patch => {
    const input = fixture();
    const sim = new AdmissionSimulator(input);
    const id = sim.reserve(attempt(input)).reservation!.reservationId;
    sim.commit(id);
    expect(sim.reconcile({ ...reflection(input, id), ...patch }).reconciliation).toBe('unknown');
    expect(sim.evaluate().windows[0]!.reserved).toBe(10);
    expect(sim.evaluate().windows[0]!.raw.consumed).toBe(90);
  });

  it('retires only the closed window, not another pool or still-active shorter window, and never the slot', () => {
    const input = fixture();
    const weekly = input.windows[0]!;
    weekly.resetAt = 2_000;
    const shorter = { ...weekly, kind: 'five-hour' as const, resetAt: 3_000 };
    input.windows.push(shorter);
    input.eligibleBindings[0]!.windowIds = input.windows.map(budgetWindowId);
    input.eligibleBindings[0]!.estimate!.windows = input.windows.map(w => ({ windowId: budgetWindowId(w), unit: 'allowance', upperBurn: 10 }));
    const other = { ...weekly, poolId: 'other-pool', resetAt: 4_000 };
    input.windows.push(other);
    input.eligibleBindings.push({ ...structuredClone(input.eligibleBindings[0]!), accountId: 'other-account', bindingKey: 'other', lane: 'other-lane',
      windowIds: [budgetWindowId(other)], estimate: { revision: 'v1', durationMs: 100, windows: [{ windowId: budgetWindowId(other), unit: 'allowance', upperBurn: 10 }] },
    });
    const sim = new AdmissionSimulator(input);
    const first = sim.reserve(attempt(input)).reservation!;
    sim.commit(first.reservationId);
    expect(sim.reserve({ ...attempt(input, 'other'), bindingKey: 'other', estimate: input.eligibleBindings[1]!.estimate! }).admitted).toBe(true);
    sim.advanceTo(2_000);
    const snapshots = sim.snapshot();
    expect(snapshots[0]!.amounts.map(a => [a.remainingAmount, a.windowClosed])).toEqual([[0, true], [10, false]]);
    expect(snapshots[1]!.amounts[0]!.remainingAmount).toBe(10);
    expect(snapshots[0]!.slotHeld).toBe(true);
    expect(snapshots[0]!.reconciliation).toBe('unknown');
  });

  it('refuses a delayed commit that would start across reset', () => {
    const input = fixture();
    const sim = new AdmissionSimulator(input);
    const id = sim.reserve(attempt(input)).reservation!.reservationId;
    sim.advanceTo(9_950);
    expect(() => sim.commit(id)).toThrow('cannot-start-expired-reservation');
    sim.advanceTo(10_000);
    expect(() => sim.commit(id)).toThrow('cannot-start-expired-reservation');
  });

  it('checks slots across eligible bindings on the same lane independently of pool allowance', () => {
    const input = fixture();
    input.eligibleBindings[0]!.maxSlots = 1;
    const other = { ...input.windows[0]!, poolId: 'other-pool' };
    input.windows.push(other);
    input.eligibleBindings.push({ ...structuredClone(input.eligibleBindings[0]!), bindingKey: 'other', accountId: 'other-account', windowIds: [budgetWindowId(other)],
      estimate: { revision: 'v1', durationMs: 100, windows: [{ windowId: budgetWindowId(other), unit: 'allowance', upperBurn: 10 }] },
    });
    const sim = new AdmissionSimulator(input);
    expect(sim.reserve(attempt(input)).admitted).toBe(true);
    expect(sim.reserve({ ...attempt(input, 'other'), bindingKey: 'other', estimate: input.eligibleBindings[1]!.estimate! })).toMatchObject({ admitted: false, reasons: ['active-slot-limit'] });
    expect(sim.evaluate().windows[1]!.reserved).toBe(0);
  });

  it('does not permit non-eligible bindings, reset crossover, or estimates different from the validated input', () => {
    const input = fixture();
    const sim = new AdmissionSimulator(input);
    expect(sim.reserve({ ...attempt(input), bindingKey: 'not-eligible' }).admitted).toBe(false);
    const req = attempt(input, 'changed');
    req.estimate.windows[0]!.upperBurn = 1;
    expect(sim.reserve(req).reasons).toEqual(['estimate-mismatch']);
    input.eligibleBindings[0]!.estimate!.durationMs = 9_000;
    expect(new AdmissionSimulator(input).reserve(attempt(input)).reasons).toEqual(['reset-crossover-unsupported']);
  });
});

describe('simulation-only object ownership', () => {
  const constructorMutations: Array<[string, (input: BudgetInput) => void]> = [
    ['clock', input => { input.now = 2_000; }],
    ['freshness', input => { input.maxAgeMs = 0; }],
    ['window observation', input => { input.windows[0]!.consumed = 100; input.windows[0]!.resetAt = 1_050; }],
    ['windows array', input => { input.windows.length = 0; }],
    ['existing hold', input => { input.holds[0]!.amount = 100; }],
    ['holds array', input => { input.holds.push({ ...input.holds[0]! }); }],
    ['binding gates', input => { input.eligibleBindings[0]!.maxSlots = 0; input.eligibleBindings[0]!.canStart = false; }],
    ['bindings array', input => { input.eligibleBindings.length = 0; }],
    ['binding window IDs', input => { input.eligibleBindings[0]!.windowIds![0] = 'caller-window'; }],
    ['estimate metadata', input => { input.eligibleBindings[0]!.estimate!.revision = 'caller-revision'; input.eligibleBindings[0]!.estimate!.durationMs = 9_000; }],
    ['estimate window', input => { input.eligibleBindings[0]!.estimate!.windows[0]!.upperBurn = 100; }],
    ['estimate windows array', input => { input.eligibleBindings[0]!.estimate!.windows.length = 0; }],
  ];

  it.each(constructorMutations)('detaches constructor %s from established state', (_name, mutate) => {
    const input = ownershipFixture();
    const pristine = structuredClone(input);
    const sim = new AdmissionSimulator(input);
    const baseline = new AdmissionSimulator(pristine);
    const request = attempt(pristine);
    const first = baseline.reserve(request);
    expect(first.admitted).toBe(true);
    expect(sim.reserve(request)).toEqual(first);
    expect(baseline.evaluate().windows[0]!).toMatchObject({ reserved: 20, safeBudget: 40 });
    expect(baseline.evaluate().bindings[0]!.allowedStarts).toBe(1);

    mutate(input);
    expect(input).not.toEqual(pristine);
    // Positive control: the mutation changes evaluation or estimate validation
    // if it is actually supplied to a fresh simulator, rather than being ignored.
    const changedControl = new AdmissionSimulator(input);
    const pristineControl = new AdmissionSimulator(pristine);
    expect({ evaluation: changedControl.evaluate(), allocation: changedControl.reserve(request) }).not.toEqual({
      evaluation: pristineControl.evaluate(), allocation: pristineControl.reserve(request),
    });

    expect(sim.evaluate()).toEqual(baseline.evaluate());
    expect(sim.snapshot()).toEqual(baseline.snapshot());
    expect(sim.reserve(structuredClone(request))).toEqual(first);
    const next = attempt(pristine, 'next-logical-attempt');
    expect(sim.reserve(next)).toEqual(baseline.reserve(next));
    expect(sim.evaluate().windows[0]!).toMatchObject({ reserved: 30, safeBudget: 30 });
    expect(sim.reserve(attempt(pristine, 'slot-control'))).toMatchObject({ admitted: false, reasons: ['active-slot-limit'] });
  });

  it.each(['fresh allocation', 'attempt replay'])('detaches returned %s and preserves its historical payload', exposure => {
    const input = ownershipFixture();
    const sim = new AdmissionSimulator(input);
    const baseline = new AdmissionSimulator(input);
    const request = attempt(input);
    const first = baseline.reserve(request);
    let returned = sim.reserve(request);
    if (exposure === 'attempt replay') returned = sim.reserve(structuredClone(request));
    expect(returned).toEqual(first);
    expect(returned.reservation).not.toBe(first.reservation);

    returned.admitted = false;
    returned.reasons.push('caller-reason');
    corruptReservation(returned.reservation!);
    expect(returned).not.toEqual(first);
    expect(sim.snapshot()).toEqual(baseline.snapshot());
    expect(sim.evaluate()).toEqual(baseline.evaluate());
    expect(sim.reserve(structuredClone(request))).toEqual(first);

    const id = first.reservation!.reservationId;
    expect(sim.commit(id)).toEqual(baseline.commit(id));
    // The attempt cache owns the original held allocation, not the live row.
    expect(sim.reserve(structuredClone(request))).toEqual(first);
    const next = attempt(input, 'next-logical-attempt');
    expect(sim.reserve(next)).toEqual(baseline.reserve(next));
    expect(sim.evaluate().windows[0]!).toMatchObject({ reserved: 30, safeBudget: 30 });
    expect(sim.reserve(attempt(input, 'slot-control'))).toMatchObject({ admitted: false, reasons: ['active-slot-limit'] });
  });

  it('detaches snapshot rows, amount objects and arrays from reservations and attempt replay', () => {
    const input = ownershipFixture();
    const sim = new AdmissionSimulator(input);
    const baseline = new AdmissionSimulator(input);
    const request = attempt(input);
    const first = baseline.reserve(request);
    expect(sim.reserve(request)).toEqual(first);
    const returned = sim.snapshot();
    expect(returned).toEqual(baseline.snapshot());
    corruptReservation(returned[0]!);
    returned.push(structuredClone(returned[0]!));
    expect(returned).not.toEqual(baseline.snapshot());

    expect(sim.snapshot()).toEqual(baseline.snapshot());
    expect(sim.evaluate()).toEqual(baseline.evaluate());
    expect(sim.reserve(structuredClone(request))).toEqual(first);
    const next = attempt(input, 'next-logical-attempt');
    expect(sim.reserve(next)).toEqual(baseline.reserve(next));
    expect(sim.snapshot()).toEqual(baseline.snapshot());
    expect(sim.evaluate().windows[0]!).toMatchObject({ reserved: 30, safeBudget: 30 });
    expect(sim.reserve(attempt(input, 'slot-control'))).toMatchObject({ admitted: false, reasons: ['active-slot-limit'] });
  });

  const reservationExposures: Array<{
    name: string;
    state: SimulatedReservation['state'];
    remainingAmount: number;
    slotHeld: boolean;
    expose: (sim: AdmissionSimulator, input: BudgetInput, id: string) => SimulatedReservation;
  }> = [
    { name: 'commit', state: 'committed', remainingAmount: 10, slotHeld: true,
      expose: (sim, _input, id) => sim.commit(id) },
    { name: 'cancelBeforeStart', state: 'cancelled-before-start', remainingAmount: 0, slotHeld: false,
      expose: (sim, _input, id) => sim.cancelBeforeStart(id) },
    { name: 'finish', state: 'committed', remainingAmount: 10, slotHeld: false,
      expose: (sim, _input, id) => { sim.commit(id); return sim.finish(id); } },
    { name: 'reconcile', state: 'committed', remainingAmount: 6, slotHeld: true,
      expose: (sim, input, id) => { sim.commit(id); return sim.reconcile(partialReflection(input, id)); } },
    { name: 'reconciliation replay', state: 'committed', remainingAmount: 6, slotHeld: true,
      expose: (sim, input, id) => {
        sim.commit(id);
        sim.reconcile(partialReflection(input, id));
        return sim.reconcile(partialReflection(input, id));
      } },
  ];

  it.each(reservationExposures)('detaches $name output from live state and historical replay', ({ expose, state, remainingAmount, slotHeld, name }) => {
    const input = ownershipFixture();
    const sim = new AdmissionSimulator(input);
    const baseline = new AdmissionSimulator(input);
    const request = attempt(input);
    const first = baseline.reserve(request);
    expect(sim.reserve(request)).toEqual(first);
    const id = first.reservation!.reservationId;
    const expected = expose(baseline, input, id);
    const returned = expose(sim, input, id);
    expect(expected).toMatchObject({ state, slotHeld, amounts: [{ remainingAmount }] });
    expect(returned).toEqual(expected);
    corruptReservation(returned);
    expect(returned).not.toEqual(expected);

    expect(sim.evaluate()).toEqual(baseline.evaluate());
    expect(sim.snapshot()).toEqual(baseline.snapshot());
    expect(expose(sim, input, id)).toEqual(expected);
    expect(sim.reserve(structuredClone(request))).toEqual(first);
    if (name === 'reconcile' || name === 'reconciliation replay') {
      const later = { ...partialReflection(input, id), reconciliationId: 'reflection-2', usageWatermark: 2,
        reflectedAmount: 2, consumed: 46 };
      expect(sim.reconcile(later)).toEqual(baseline.reconcile(later));
      expect(sim.snapshot()[0]!.amounts[0]!.remainingAmount).toBe(4);
      // A later transition must not rewrite an earlier reconciliation result.
      expect(sim.reconcile(partialReflection(input, id))).toEqual(expected);
      expect(sim.evaluate().windows[0]!).toMatchObject({ reserved: 14, safeBudget: 40 });
    }
    const next = attempt(input, 'next-logical-attempt');
    const allocated = sim.reserve(next);
    expect(allocated.admitted).toBe(true);
    expect(allocated).toEqual(baseline.reserve(next));
    expect(sim.snapshot()).toEqual(baseline.snapshot());
    expect(sim.evaluate()).toEqual(baseline.evaluate());
  });

  it('detaches evaluation observations and nested readouts before another reserve or replay', () => {
    const input = ownershipFixture();
    const sim = new AdmissionSimulator(input);
    const baseline = new AdmissionSimulator(input);
    const request = attempt(input);
    const first = baseline.reserve(request);
    expect(sim.reserve(request)).toEqual(first);
    const expected = baseline.evaluate();
    const returned = sim.evaluate();
    expect(returned).toEqual(expected);
    returned.windows[0]!.raw.consumed = 100;
    returned.windows[0]!.raw.resetAt = 1_050;
    returned.windows[0]!.reserved = 0;
    returned.windows[0]!.reasons.push('caller-reason');
    returned.observations[0]!.consumed = 100;
    returned.bindings[0]!.allowedStarts = 0;
    returned.bindings[0]!.projections[0]!.windowId = 'caller-window';
    expect(returned).not.toEqual(expected);

    expect(sim.evaluate()).toEqual(expected);
    expect(sim.snapshot()).toEqual(baseline.snapshot());
    expect(sim.reserve(structuredClone(request))).toEqual(first);
    const next = attempt(input, 'next-logical-attempt');
    expect(sim.reserve(next)).toEqual(baseline.reserve(next));
    expect(sim.evaluate().windows[0]!).toMatchObject({ reserved: 30, safeBudget: 30 });
  });
});
