import {
  budgetWindowId, evaluateBudgets,
  type BudgetEvaluation, type BudgetInput, type EligibleBudgetBinding,
} from './admission-budget.js';

export type ReservationState = 'held' | 'committed' | 'reconciled' | 'cancelled-before-start';
export interface SimulatedReservation {
  reservationId: string;
  idempotencyKey: string;
  bindingKey: string;
  lane: string;
  estimateRevision: string;
  durationMs: number;
  state: ReservationState;
  slotHeld: boolean;
  reconciliation: 'known' | 'unknown';
  amounts: Array<{
    windowId: string;
    unit: string;
    reservedAmount: number;
    remainingAmount: number;
    windowClosed: boolean;
  }>;
}

export interface SimulatedAttempt {
  idempotencyKey: string;
  bindingKey: string;
  estimate: NonNullable<EligibleBudgetBinding['estimate']>;
}

export interface SimulatedAllocation {
  mode: 'simulation-only';
  admitted: boolean;
  reasons: string[];
  reservation: SimulatedReservation | null;
}

export interface SimulatedReconciliation {
  reconciliationId: string;
  reservationId: string;
  windowId: string;
  unit: string;
  reflectedAmount: number;
  /** Absolute window consumption observed with trustworthy attempt attribution. */
  consumed: number;
  observedAt: number;
  sourceRevision: string;
  /** Monotone per-window watermark, not an order-derived account identity. */
  usageWatermark: number | null;
  attributionTrusted: boolean;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/**
 * Deterministic single-process fixture simulator. Synchronous reserve is one
 * atomic transition here; this is NOT durable storage or a production consumer.
 * No TTL releases quota. Cross-reset starts are explicitly unsupported.
 */
export class AdmissionSimulator {
  private input: BudgetInput;
  private reservations = new Map<string, SimulatedReservation>();
  private attempts = new Map<string, { fingerprint: string; result: SimulatedAllocation }>();
  private reconciliations = new Map<string, { fingerprint: string; result: SimulatedReservation }>();
  private watermarks = new Map<string, number>();

  constructor(input: BudgetInput) {
    this.input = structuredClone(input);
  }

  evaluate(): BudgetEvaluation {
    const input = structuredClone(this.input);
    for (const reservation of this.reservations.values()) {
      for (const amount of reservation.amounts) {
        if (amount.remainingAmount > 0 && !amount.windowClosed) {
          input.holds.push({ windowId: amount.windowId, unit: amount.unit, amount: amount.remainingAmount });
        }
      }
    }
    for (const binding of input.eligibleBindings) {
      binding.activeSlots += [...this.reservations.values()].filter(r => r.slotHeld && r.lane === binding.lane).length;
    }
    return evaluateBudgets(input);
  }

  reserve(attempt: SimulatedAttempt): SimulatedAllocation {
    const fingerprint = canonical(attempt);
    const previous = this.attempts.get(attempt.idempotencyKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('idempotency-key-payload-mismatch');
      return structuredClone(previous.result);
    }
    const binding = this.input.eligibleBindings.find(b => b.bindingKey === attempt.bindingKey);
    let reasons: string[];
    if (!attempt.idempotencyKey.trim() || attempt.idempotencyKey.length > 256) reasons = ['invalid-idempotency-key'];
    else if (!binding) reasons = ['binding-not-already-eligible'];
    else if (canonical(attempt.estimate) !== canonical(binding.estimate)) reasons = ['estimate-mismatch'];
    else {
      const budget = this.evaluate().bindings.find(b => b.bindingKey === attempt.bindingKey)!;
      reasons = budget.proposal === 'admit' ? [] : budget.reasons;
    }
    let reservation: SimulatedReservation | null = null;
    if (!reasons.length && binding) {
      reservation = {
        reservationId: `sim-${this.reservations.size + 1}`, idempotencyKey: attempt.idempotencyKey,
        bindingKey: binding.bindingKey, lane: binding.lane, estimateRevision: attempt.estimate.revision,
        durationMs: attempt.estimate.durationMs,
        state: 'held', slotHeld: true, reconciliation: 'unknown',
        amounts: [...new Set(binding.windowIds!)].map(windowId => {
          const burn = attempt.estimate.windows.find(w => w.windowId === windowId)!;
          return { windowId, unit: burn.unit, reservedAmount: burn.upperBurn, remainingAmount: burn.upperBurn, windowClosed: false };
        }),
      };
      this.reservations.set(reservation.reservationId, reservation);
    }
    const result: SimulatedAllocation = { mode: 'simulation-only', admitted: reservation !== null, reasons, reservation };
    this.attempts.set(attempt.idempotencyKey, { fingerprint, result: structuredClone(result) });
    return structuredClone(result);
  }

  commit(reservationId: string): SimulatedReservation {
    const r = this.requireReservation(reservationId);
    if (r.state === 'cancelled-before-start') throw new Error('cannot-commit-cancelled-reservation');
    if (r.state === 'held') {
      if (r.amounts.some(a => {
        const w = this.input.windows.find(w => budgetWindowId(w) === a.windowId);
        return a.windowClosed || !w?.resetAt || this.input.now + r.durationMs >= w.resetAt;
      })) throw new Error('cannot-start-expired-reservation');
      r.state = 'committed';
    }
    return structuredClone(r);
  }

  cancelBeforeStart(reservationId: string): SimulatedReservation {
    const r = this.requireReservation(reservationId);
    if (r.state !== 'held' && r.state !== 'cancelled-before-start') throw new Error('cannot-refund-started-attempt');
    r.state = 'cancelled-before-start';
    r.slotHeld = false;
    for (const amount of r.amounts) amount.remainingAmount = 0;
    return structuredClone(r);
  }

  /** A confirmed end frees a slot, NOT allowance. Failure/timeout may be charged. */
  finish(reservationId: string): SimulatedReservation {
    const r = this.requireReservation(reservationId);
    if (r.state !== 'committed' && r.state !== 'reconciled') throw new Error('attempt-not-started');
    r.slotHeld = false;
    return structuredClone(r);
  }

  reconcile(event: SimulatedReconciliation): SimulatedReservation {
    const fingerprint = canonical(event);
    const previous = this.reconciliations.get(event.reconciliationId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('reconciliation-key-payload-mismatch');
      return structuredClone(previous.result);
    }
    if (!event.reconciliationId.trim()) throw new Error('invalid-reconciliation-key');
    const r = this.requireReservation(event.reservationId);
    if (r.state !== 'committed' && r.state !== 'reconciled') throw new Error('attempt-not-started');
    const amount = r.amounts.find(a => a.windowId === event.windowId);
    if (!amount || amount.unit !== event.unit) throw new Error('reservation-window-or-unit-mismatch');
    if (!event.attributionTrusted || event.usageWatermark === null) {
      r.reconciliation = 'unknown';
    } else {
      const observations = this.input.windows.filter(w => budgetWindowId(w) === event.windowId);
      const w = observations[0];
      const oldWatermark = this.watermarks.get(event.windowId) ?? -1;
      if (!w || amount.windowClosed || w.dataState !== 'known' || w.consumed === null || w.quota === null
          || w.observedAt === null || w.startAt === null || w.resetAt === null
          || !Number.isSafeInteger(event.usageWatermark) || event.usageWatermark <= oldWatermark
          || !Number.isFinite(event.reflectedAmount) || event.reflectedAmount < 0
          || event.reflectedAmount > amount.remainingAmount
          || !Number.isFinite(event.consumed) || event.consumed < w.consumed || event.consumed > w.quota
          || event.consumed - w.consumed < event.reflectedAmount
          || !Number.isFinite(event.observedAt) || event.observedAt < w.observedAt
          || event.observedAt < w.startAt || event.observedAt >= w.resetAt || event.observedAt > this.input.now
          || !event.sourceRevision.trim()) throw new Error('invalid-usage-watermark-or-attribution');
      for (const observation of observations) {
        observation.consumed = event.consumed;
        observation.observedAt = event.observedAt;
        observation.sourceRevision = event.sourceRevision;
      }
      amount.remainingAmount -= event.reflectedAmount;
      this.watermarks.set(event.windowId, event.usageWatermark);
      r.reconciliation = r.amounts.every(a => a.remainingAmount === 0) ? 'known' : 'unknown';
      if (r.reconciliation === 'known') r.state = 'reconciled';
    }
    const result = structuredClone(r);
    this.reconciliations.set(event.reconciliationId, { fingerprint, result });
    return structuredClone(result);
  }

  /** Advancing time retires ONLY holds for windows that actually closed. */
  advanceTo(now: number): void {
    if (!Number.isFinite(now) || now < this.input.now) throw new Error('nonmonotonic-simulation-clock');
    this.input.now = now;
    for (const r of this.reservations.values()) {
      for (const amount of r.amounts) {
        const w = this.input.windows.find(w => budgetWindowId(w) === amount.windowId);
        if (w?.resetAt != null && now >= w.resetAt) {
          amount.remainingAmount = 0;
          amount.windowClosed = true;
        }
      }
      // A reset closes a hold, not a running job's slot or proof of reconciliation.
    }
  }

  snapshot(): SimulatedReservation[] {
    return structuredClone([...this.reservations.values()]);
  }

  private requireReservation(id: string): SimulatedReservation {
    const r = this.reservations.get(id);
    if (!r) throw new Error('unknown-reservation');
    return r;
  }
}
