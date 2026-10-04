import { describe, expect, it } from 'vitest';
import { budgetWindowId } from '../src/admission-budget.js';
import { AdmissionSimulator } from '../src/admission-simulator.js';
import {
  BEHIND_PACE_ACCOUNTS,
  BEHIND_PACE_NOW,
  EXPIRY_WEEK_NOW,
  EXPIRY_WEEK_QUOTA,
  EXPIRY_WEEK_RESET,
  VARIED_BURN_ACCOUNTS,
  driveAccountToLanding,
  expiryWeekAccount,
  expiryWeekInput,
} from './expiry-week-fixtures.js';

/**
 * Expiry-week scenario pack proving 98-100% window landing.
 *
 * Fixtures + unit tests only: the
 * pacer logic under test (`AdmissionSimulator` + `evaluateBudgets`) already
 * exists. No live dispatch, no enforcement change, no credentials.
 *
 * NON-GOALS (owned elsewhere): the use-before-expiry tie-break; the
 * weekly-pace vs 5h-backstop conflict; the pacing.lanes wire-up; the joint
 * snapshot assembly.
 */

describe('Expiry week: varied burn positions land at 98-100%', () => {
  it.each([
    { start: 10, landing: 0.98 },
    { start: 50, landing: 0.98 },
    { start: 85, landing: 0.99 },
  ])('opens at $start and lands at $landing without exceeding quota', ({ start }) => {
    const plan = VARIED_BURN_ACCOUNTS.find(p => p.startConsumed === start)!;
    const account = expiryWeekAccount(plan, EXPIRY_WEEK_NOW);
    expect(account.window.quota).toBe(EXPIRY_WEEK_QUOTA);
    const sim = new AdmissionSimulator(expiryWeekInput([account], EXPIRY_WEEK_NOW));
    const landing = driveAccountToLanding(sim, account, 100);
    expect(landing.admittedStarts).toBe(plan.plannedStarts);
    expect(landing.finalConsumed).toBe(plan.startConsumed + plan.plannedBurn);
    expect(landing.maxConsumed).toBeLessThanOrEqual(EXPIRY_WEEK_QUOTA);
    expect(landing.utilization).toBeGreaterThanOrEqual(0.98);
    expect(landing.utilization).toBeLessThanOrEqual(1);
    // The pacer stops on budget, never on the clock: deferral is the
    // safe-budget gate, not an error or an unknown.
    expect(landing.stopProposal).toBe('defer');
    expect(landing.stopReasons).toContain('safe-budget-insufficient');
  });

  it('lands every account in one shared expiry week without cross-account debt', () => {
    const accounts = VARIED_BURN_ACCOUNTS.map(plan => expiryWeekAccount(plan, EXPIRY_WEEK_NOW));
    const sim = new AdmissionSimulator(expiryWeekInput(accounts, EXPIRY_WEEK_NOW));
    // Each account draws on its own pool; drive them in round-robin so no
    // account's holds can mask another's budget.
    const landings = accounts.map(account => driveAccountToLanding(sim, account, 50));
    for (const landing of landings) {
      expect(landing.utilization).toBeGreaterThanOrEqual(0.98);
      expect(landing.utilization).toBeLessThanOrEqual(1);
    }
    expect(landings.map(l => l.finalConsumed)).toEqual([98, 98, 99]);
  });
});

describe('Expiry week: behind-pace lanes catch up before reset', () => {
  it.each([
    { start: 20, landing: 0.98, starts: 13 },
    { start: 30, landing: 0.98, starts: 17 },
  ])('behind at $start with 20% of the window left still lands at $landing', ({ start, starts }) => {
    const plan = BEHIND_PACE_ACCOUNTS.find(p => p.startConsumed === start)!;
    const account = expiryWeekAccount(plan, BEHIND_PACE_NOW);
    const sim = new AdmissionSimulator(expiryWeekInput([account], BEHIND_PACE_NOW));
    const landing = driveAccountToLanding(sim, account, 50);
    expect(landing.admittedStarts).toBe(starts);
    expect(landing.utilization).toBeGreaterThanOrEqual(0.98);
    expect(landing.utilization).toBeLessThanOrEqual(1);
    expect(landing.maxConsumed).toBeLessThanOrEqual(EXPIRY_WEEK_QUOTA);
  });
});

describe('Expiry week: reset boundary retires holds and opens fresh', () => {
  it('closes the old week with no carried debt and admits immediately in the new one', () => {
    const plan = VARIED_BURN_ACCOUNTS[0]!;
    const account = expiryWeekAccount(plan, EXPIRY_WEEK_NOW);
    const windowId = budgetWindowId(account.window);
    const sim = new AdmissionSimulator(expiryWeekInput([account], EXPIRY_WEEK_NOW));

    const allocation = sim.reserve({
      idempotencyKey: 'boundary-attempt-1',
      bindingKey: plan.bindingKey,
      estimate: structuredClone(account.binding.estimate!),
    });
    expect(allocation.admitted).toBe(true);
    const reservationId = allocation.reservation!.reservationId;
    sim.commit(reservationId);

    // The reset crosses while the attempt is still held: the hold retires
    // (remaining zero, window closed) but the running job keeps its slot and
    // its reconciliation stays honestly unknown.
    sim.advanceTo(EXPIRY_WEEK_RESET);
    const snapshot = sim.snapshot();
    expect(snapshot[0]!.amounts).toEqual([{
      windowId, unit: 'allowance', reservedAmount: plan.upperBurn,
      remainingAmount: 0, windowClosed: true,
    }]);
    expect(snapshot[0]!.slotHeld).toBe(true);
    expect(snapshot[0]!.reconciliation).toBe('unknown');

    // A new weekly window (new start/reset identity) opens at zero: the same
    // pacer admits immediately, proving no debt carried over the boundary.
    const next = expiryWeekAccount(plan, EXPIRY_WEEK_RESET, {
      consumed: 0,
      startAt: EXPIRY_WEEK_RESET,
      resetAt: 2 * EXPIRY_WEEK_RESET,
      observedAt: EXPIRY_WEEK_RESET,
    });
    const nextSim = new AdmissionSimulator(expiryWeekInput([next], EXPIRY_WEEK_RESET));
    const first = nextSim.reserve({
      idempotencyKey: 'new-week-attempt-1',
      bindingKey: plan.bindingKey,
      estimate: structuredClone(next.binding.estimate!),
    });
    expect(first.admitted).toBe(true);
    expect(first.reasons).toEqual([]);
  });
});
