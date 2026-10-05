import {
  budgetWindowId,
  type BudgetInput,
  type BudgetWindowObservation,
  type EligibleBudgetBinding,
} from '../src/admission-budget.js';
import { AdmissionSimulator } from '../src/admission-simulator.js';

/**
 *  fixture set: expiry-week scenario pack proving 98-100% window landing.
 *
 * Parent  under epic . Fixtures + driver only: every
 * behavioral target (`AdmissionSimulator`, `evaluateBudgets`) already exists.
 * No live dispatch, no enforcement change, no credentials.
 *
 * WHAT THIS PROVES (in simulation):
 * - accounts opening the expiry week at varied burn positions (10/50/85 of a
 *   100-unit weekly quota) each land at 98-100% when the pacer admits every
 *   start that fits the safe budget and defers the rest — never exceeding
 *   quota, never stopping early on the clock;
 * - behind-pace lanes (20-30% used at 80% elapsed) still admit catch-up
 *   volume late in the window and land at 98%;
 * - crossing the weekly reset retires holds without carrying debt: the next
 *   week opens fresh at zero and admits immediately.
 *
 * NON-GOALS (owned elsewhere, do NOT duplicate):  use-before-expiry
 * tie-break (blocked);  weekly-pace vs 5h-backstop conflict
 * (blocked);  pacing.lanes wire-up (in_progress);  joint
 * snapshot assembly (in_review).
 */

export const EXPIRY_WEEK_QUOTA = 100;
export const EXPIRY_WEEK_START = 0;
/** Compressed-week reset: the whole window is 10 000 ms in fixtures. */
export const EXPIRY_WEEK_RESET = 10_000;
export const EXPIRY_WEEK_HEADROOM = 1;
export const EXPIRY_WEEK_NOW = 1_000;
/** Late-window clock for the behind-pace scenarios: 80% elapsed. */
export const BEHIND_PACE_NOW = 8_000;
export const EXPIRY_WEEK_MAX_AGE_MS = 10_000;

export interface ExpiryWeekAccountPlan {
  accountId: string;
  poolId: string;
  lane: string;
  bindingKey: string;
  /** Allowance already consumed when the simulated week opens. */
  startConsumed: number;
  /** Upper burn per paced start; every fitting start is admitted. */
  upperBurn: number;
  durationMs: number;
  /** Total planned burn, sized so start + planned lands inside 98-100. */
  plannedBurn: number;
  plannedStarts: number;
}

/** Varied burn positions: early 10 + 8x11 = 98, mid 50 + 6x8 = 98, late 85 + 2x7 = 99. */
export const VARIED_BURN_ACCOUNTS: ExpiryWeekAccountPlan[] = [
  { accountId: 'expiry-early', poolId: 'expiry-pool-early', lane: 'lane-early', bindingKey: 'expiry-binding-early',
    startConsumed: 10, upperBurn: 11, durationMs: 100, plannedBurn: 88, plannedStarts: 8 },
  { accountId: 'expiry-mid', poolId: 'expiry-pool-mid', lane: 'lane-mid', bindingKey: 'expiry-binding-mid',
    startConsumed: 50, upperBurn: 8, durationMs: 100, plannedBurn: 48, plannedStarts: 6 },
  { accountId: 'expiry-late', poolId: 'expiry-pool-late', lane: 'lane-late', bindingKey: 'expiry-binding-late',
    startConsumed: 85, upperBurn: 7, durationMs: 100, plannedBurn: 14, plannedStarts: 2 },
];

/** Behind-pace lanes at 80% elapsed: 20 + 13x6 = 98, 30 + 17x4 = 98. */
export const BEHIND_PACE_ACCOUNTS: ExpiryWeekAccountPlan[] = [
  { accountId: 'expiry-behind-a', poolId: 'expiry-pool-behind-a', lane: 'lane-behind-a', bindingKey: 'expiry-binding-behind-a',
    startConsumed: 20, upperBurn: 6, durationMs: 50, plannedBurn: 78, plannedStarts: 13 },
  { accountId: 'expiry-behind-b', poolId: 'expiry-pool-behind-b', lane: 'lane-behind-b', bindingKey: 'expiry-binding-behind-b',
    startConsumed: 30, upperBurn: 4, durationMs: 50, plannedBurn: 68, plannedStarts: 17 },
];

export interface ExpiryWeekAccount {
  plan: ExpiryWeekAccountPlan;
  window: BudgetWindowObservation;
  binding: EligibleBudgetBinding;
}

export function expiryWeekAccount(
  plan: ExpiryWeekAccountPlan,
  now: number,
  windowOverrides: Partial<BudgetWindowObservation> = {},
): ExpiryWeekAccount {
  const window: BudgetWindowObservation = {
    providerId: 'provider', poolId: plan.poolId, kind: 'weekly',
    startAt: EXPIRY_WEEK_START, resetAt: EXPIRY_WEEK_RESET,
    observedAt: now, sourceRevision: 'expiry-week-fixture', schemaRevision: 'v1',
    unit: 'allowance', quota: EXPIRY_WEEK_QUOTA, consumed: plan.startConsumed,
    safetyHeadroom: EXPIRY_WEEK_HEADROOM, planWeight: 1, dataState: 'known',
    ...windowOverrides,
  };
  const windowId = budgetWindowId(window);
  const binding: EligibleBudgetBinding = {
    bindingKey: plan.bindingKey, lane: plan.lane, accountId: plan.accountId, providerId: 'provider',
    windowIds: [windowId], canStart: true, activeSlots: 0, maxSlots: 100, cooldownUntil: null,
    // No burnPerMs: the expiry-week question is allowance landing (upperBurn
    // against safeBudget), not continuous runtime concurrency. A burnPerMs
    // here would trip the fractional-concurrency defer gate because one job's
    // instantaneous burn exceeds the window's sustainable rate. 98% targeting
    // comes from remainingDemandBurn + quota math, matching the existing
    // simulator fixture convention.
    estimate: { revision: 'expiry-week-v1', durationMs: plan.durationMs, windows: [{
      windowId, unit: 'allowance', upperBurn: plan.upperBurn, remainingDemandBurn: plan.plannedBurn,
    }] },
  };
  return { plan, window, binding };
}

export function expiryWeekInput(accounts: ExpiryWeekAccount[], now: number): BudgetInput {
  return {
    now, maxAgeMs: EXPIRY_WEEK_MAX_AGE_MS,
    windows: accounts.map(a => a.window),
    eligibleBindings: accounts.map(a => a.binding),
    holds: [],
  };
}

export interface ExpiryWeekLanding {
  accountId: string;
  admittedStarts: number;
  finalConsumed: number;
  maxConsumed: number;
  utilization: number;
  stopProposal: 'admit' | 'defer' | 'unknown';
  stopReasons: string[];
}

/**
 * Pace one account to its landing: while the budget evaluation admits, take
 * exactly one reserve/commit/finish/reconcile cycle per step and advance the
 * simulation clock. Returns the landing record when the pacer first defers.
 * Throws (never silently under-lands) if a start the pacer approved cannot
 * complete.
 */
export function driveAccountToLanding(
  sim: AdmissionSimulator,
  account: ExpiryWeekAccount,
  stepMs: number,
): ExpiryWeekLanding {
  const windowId = budgetWindowId(account.window);
  let admitted = 0;
  let maxConsumed = account.plan.startConsumed;
  for (let guard = 0; guard < 1000; guard++) {
    const evaluation = sim.evaluate();
    const budget = evaluation.bindings.find(b => b.bindingKey === account.plan.bindingKey);
    if (!budget) throw new Error(`expiry-week-binding-missing:${account.plan.bindingKey}`);
    const window = evaluation.windows.find(w => w.windowId === windowId);
    if (!window || window.raw.consumed === null) throw new Error(`expiry-week-window-missing:${account.plan.bindingKey}`);
    if (window.raw.consumed > EXPIRY_WEEK_QUOTA) {
      throw new Error(`expiry-week-over-quota:${account.plan.accountId}:${window.raw.consumed}`);
    }
    maxConsumed = Math.max(maxConsumed, window.raw.consumed);
    if (budget.proposal !== 'admit') {
      const finalConsumed = window.raw.consumed;
      return {
        accountId: account.plan.accountId, admittedStarts: admitted,
        finalConsumed, maxConsumed, utilization: finalConsumed / EXPIRY_WEEK_QUOTA,
        stopProposal: budget.proposal, stopReasons: [...budget.reasons],
      };
    }
    const now = evaluation.evaluatedAt;
    const allocation = sim.reserve({
      idempotencyKey: `${account.plan.bindingKey}-attempt-${admitted + 1}`,
      bindingKey: account.plan.bindingKey,
      estimate: structuredClone(account.binding.estimate!),
    });
    if (!allocation.admitted || !allocation.reservation) {
      throw new Error(`expiry-week-approved-start-refused:${account.plan.accountId}:${allocation.reasons.join(',')}`);
    }
    const reservationId = allocation.reservation.reservationId;
    sim.commit(reservationId);
    sim.finish(reservationId);
    const consumed = sim.evaluate().windows.find(w => w.windowId === windowId)!.raw.consumed!;
    sim.reconcile({
      reconciliationId: `${account.plan.bindingKey}-reflection-${admitted + 1}`,
      reservationId, windowId, unit: 'allowance',
      reflectedAmount: account.plan.upperBurn, consumed: consumed + account.plan.upperBurn,
      observedAt: now, sourceRevision: 'expiry-week-driver',
      usageWatermark: admitted + 1, attributionTrusted: true,
    });
    admitted++;
    sim.advanceTo(now + stepMs);
  }
  throw new Error(`expiry-week-driver-did-not-land:${account.plan.accountId}`);
}
