/** Pure shadow budget math. No account routing, reservations or host actuation. */
export type BudgetDataState = 'known' | 'unknown' | 'stale' | 'invalid';
export type WindowKind = 'weekly' | 'five-hour' | 'monthly' | 'rolling';

/**
 * Unit of an observation that is only a provider-reported utilization fraction
 * (`quota: 1`, `consumed: fraction`). It supports attainment reporting and
 * nothing else: no safe budget, no rates, no start claim, no headroom or plan
 * weight (neither is observed), and a binding governed by it is never admitted.
 */
export const UTILIZATION_ONLY_UNIT = 'utilization-fraction';

export interface BudgetWindowObservation {
  providerId: string;
  poolId: string;
  kind: WindowKind;
  startAt: number | null;
  resetAt: number | null;
  observedAt: number | null;
  sourceRevision: string | null;
  schemaRevision: string | null;
  unit: string | null;
  quota: number | null;
  consumed: number | null;
  safetyHeadroom: number | null;
  planWeight: number | null;
  dataState: BudgetDataState;
}

export interface WindowBurnEstimate {
  windowId: string;
  unit: string;
  upperBurn: number;
  /** Conservative allowance units per occupied millisecond; never model tokens. */
  burnPerMs?: number;
  /** Explicit estimate of all remaining already-eligible demand in this window. */
  remainingDemandBurn?: number;
}

/** Supplied AFTER existing tier/capability/context/effort/fallback-only gates. */
export interface EligibleBudgetBinding {
  bindingKey: string;
  lane: string;
  accountId: string;
  providerId: string;
  /** null means account/pool compatibility was not observed. */
  windowIds: string[] | null;
  canStart: boolean;
  activeSlots: number;
  maxSlots: number;
  cooldownUntil: number | null;
  estimate: {
    revision: string;
    durationMs: number;
    windows: WindowBurnEstimate[];
  } | null;
}

export interface IncrementalHold {
  windowId: string;
  unit: string;
  amount: number;
}

export interface BudgetInput {
  now: number;
  maxAgeMs: number;
  windows: BudgetWindowObservation[];
  eligibleBindings: EligibleBudgetBinding[];
  /** Only incremental burn NOT reflected in observed consumption. */
  holds: IncrementalHold[];
}

export interface WindowBudget {
  windowId: string;
  raw: BudgetWindowObservation;
  dataState: BudgetDataState;
  reasons: string[];
  reserved: number | null;
  elapsedFraction: number | null;
  utilization: number | null;
  safeBudget: number | null;
  targetRatePerMs: number | null;
  sustainableRatePerMs: number | null;
}

export interface BindingBudget {
  bindingKey: string;
  lane: string;
  accountId: string;
  proposal: 'admit' | 'defer' | 'unknown';
  reasons: string[];
  targetInfeasibility: string[];
  continuousConcurrency: number | null;
  integerConcurrency: number | null;
  allowedStarts: number | null;
  /** Advisory only; a caller MUST re-evaluate every window at this time. */
  nextEligibleStartAt: number | null;
  projections: Array<{
    windowId: string;
    projectedEndUtilization: number | null;
    earlyExhaustionRisk: boolean | null;
  }>;
}

export interface BudgetEvaluation {
  mode: 'shadow-only';
  governsHostStarts: false;
  selectedOrServedAccount: null;
  evaluatedAt: number;
  maxAgeMs: number;
  windows: WindowBudget[];
  /** Includes duplicate/conflicting observations for diagnosis, without aggregation. */
  observations: BudgetWindowObservation[];
  bindings: BindingBudget[];
}

const finiteBudgetValue = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const nonnegative = (n: unknown): n is number => finiteBudgetValue(n) && n >= 0;
const positive = (n: unknown): n is number => finiteBudgetValue(n) && n > 0;
const budgetText = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0;

/** IDs are opaque non-secret keys, not email/display IDs or record order. */
export function stableBudgetId(s: unknown): s is string {
  return typeof s === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(s)
    && !/^record-\d+$/i.test(s);
}

export function budgetWindowId(w: Pick<BudgetWindowObservation, 'providerId' | 'poolId' | 'kind' | 'startAt' | 'resetAt'>): string {
  return JSON.stringify([w.providerId, w.poolId, w.kind, w.startAt, w.resetAt]);
}

function evaluateWindow(raw: BudgetWindowObservation, input: BudgetInput, conflicting: boolean): WindowBudget {
  const windowId = budgetWindowId(raw);
  const result: WindowBudget = {
    windowId, raw: { ...raw }, dataState: raw.dataState, reasons: [], reserved: null,
    elapsedFraction: null, utilization: null, safeBudget: null,
    targetRatePerMs: null, sustainableRatePerMs: null,
  };
  const invalid: string[] = [];
  const unknown: string[] = [];
  if (conflicting) invalid.push('conflicting-pool-observations');
  if (!stableBudgetId(raw.providerId) || !stableBudgetId(raw.poolId)) invalid.push('unstable-identity');
  if (!['weekly', 'five-hour', 'monthly', 'rolling'].includes(raw.kind)) invalid.push('invalid-window-kind');
  if (!['known', 'unknown', 'stale', 'invalid'].includes(raw.dataState)) invalid.push('invalid-data-state');
  if (!positive(input.maxAgeMs) || !nonnegative(input.now)) invalid.push('invalid-evaluation-clock-or-freshness');
  const utilizationOnly = raw.unit === UTILIZATION_ONLY_UNIT;
  for (const field of ['startAt', 'resetAt', 'observedAt', 'quota', 'consumed', 'safetyHeadroom', 'planWeight'] as const) {
    if (raw[field] == null) {
      if (!(utilizationOnly && (field === 'safetyHeadroom' || field === 'planWeight'))) unknown.push(`missing-${field}`);
    } else if (!nonnegative(raw[field])) invalid.push(`invalid-${field}`);
  }
  for (const field of ['unit', 'sourceRevision', 'schemaRevision'] as const) {
    if (!budgetText(raw[field])) unknown.push(`missing-${field}`);
  }
  if (finiteBudgetValue(raw.quota) && raw.quota <= 0) invalid.push('nonpositive-quota');
  if (finiteBudgetValue(raw.planWeight) && raw.planWeight <= 0) invalid.push('nonpositive-plan-weight');
  if (finiteBudgetValue(raw.consumed) && finiteBudgetValue(raw.quota) && raw.consumed > raw.quota) invalid.push('usage-out-of-range');
  if (finiteBudgetValue(raw.startAt) && finiteBudgetValue(raw.resetAt) && raw.startAt >= raw.resetAt) invalid.push('contradictory-window');
  if (finiteBudgetValue(raw.observedAt) && (raw.observedAt > input.now || (finiteBudgetValue(raw.startAt) && raw.observedAt < raw.startAt)
      || (finiteBudgetValue(raw.resetAt) && raw.observedAt >= raw.resetAt))) invalid.push('contradictory-observation-clock');
  if (finiteBudgetValue(raw.startAt) && input.now < raw.startAt) unknown.push('window-not-open');
  if (finiteBudgetValue(raw.resetAt) && input.now >= raw.resetAt) unknown.push('window-closed');
  if (raw.dataState !== 'known') result.reasons.push(`source-${raw.dataState}`);
  result.reasons.push(...invalid, ...unknown);
  // A source-declared invalid observation is never downgraded to merely unknown.
  if (invalid.length || raw.dataState === 'invalid') result.dataState = 'invalid';
  else if (unknown.length) result.dataState = 'unknown';
  else if (input.now - raw.observedAt! > input.maxAgeMs) {
    result.dataState = 'stale';
    result.reasons.push('observation-too-old');
  }
  if (result.dataState !== 'known') return result;
  if (utilizationOnly) {
    return {
      ...result, reasons: [...result.reasons, 'utilization-only-no-budget'],
      elapsedFraction: (input.now - raw.startAt!) / (raw.resetAt! - raw.startAt!),
      utilization: raw.consumed! / raw.quota!,
    };
  }

  const holds = input.holds.filter(h => h.windowId === windowId);
  if (holds.some(h => h.unit !== raw.unit || !nonnegative(h.amount))) {
    return { ...result, dataState: 'invalid', reasons: [...result.reasons, 'invalid-incremental-hold'] };
  }
  const reserved = holds.reduce((sum, h) => sum + h.amount, 0);
  const remainingMs = raw.resetAt! - input.now;
  const safeBudget = Math.max(0, raw.quota! - raw.consumed! - reserved - raw.safetyHeadroom!);
  if (!finiteBudgetValue(reserved) || !finiteBudgetValue(remainingMs)) {
    return { ...result, dataState: 'invalid', reasons: [...result.reasons, 'numeric-overflow'] };
  }
  const targetRatePerMs = Math.max(0, 0.98 * raw.quota! - raw.consumed! - reserved) / remainingMs;
  const sustainableRatePerMs = safeBudget / remainingMs;
  if (!finiteBudgetValue(targetRatePerMs) || !finiteBudgetValue(sustainableRatePerMs)) {
    return { ...result, dataState: 'invalid', reasons: [...result.reasons, 'numeric-overflow'] };
  }
  return {
    ...result, reserved,
    elapsedFraction: (input.now - raw.startAt!) / (raw.resetAt! - raw.startAt!),
    utilization: raw.consumed! / raw.quota!, safeBudget, targetRatePerMs, sustainableRatePerMs,
  };
}

function evaluateBinding(binding: EligibleBudgetBinding, windows: Map<string, WindowBudget>, input: BudgetInput): BindingBudget {
  const result: BindingBudget = {
    bindingKey: binding.bindingKey, lane: binding.lane, accountId: binding.accountId,
    proposal: 'unknown', reasons: [], targetInfeasibility: [], continuousConcurrency: null,
    integerConcurrency: null, allowedStarts: null, nextEligibleStartAt: null, projections: [],
  };
  const add = (reason: string) => { result.reasons.push(reason); };
  if (!stableBudgetId(binding.accountId) || !stableBudgetId(binding.providerId)
      || !budgetText(binding.bindingKey) || !budgetText(binding.lane)) add('invalid-binding-identity');
  if (!binding.windowIds?.length) {
    add('account-binding-unavailable');
    result.targetInfeasibility.push('account-binding-unavailable');
    return result;
  }
  if (!Number.isSafeInteger(binding.activeSlots) || binding.activeSlots < 0
      || !Number.isSafeInteger(binding.maxSlots) || binding.maxSlots < 0
      || typeof binding.canStart !== 'boolean'
      || (binding.cooldownUntil !== null && !nonnegative(binding.cooldownUntil))) add('invalid-operational-gates');
  const constraints = [...new Set(binding.windowIds)].map(id => windows.get(id));
  if (constraints.some(w => !w || w.dataState !== 'known' || w.raw.unit === UTILIZATION_ONLY_UNIT)) {
    add('allowance-unknown');
    result.targetInfeasibility.push('allowance-unknown');
  }
  if (constraints.some(w => w && w.raw.providerId !== binding.providerId)) add('incompatible-provider');
  const estimate = binding.estimate;
  if (!estimate || !budgetText(estimate.revision) || !positive(estimate.durationMs)) {
    add('burn-unknown');
    result.targetInfeasibility.push('burn-unknown');
  }
  const burns = new Map<string, WindowBurnEstimate>();
  for (const burn of estimate?.windows ?? []) {
    if (burns.has(burn.windowId)) add('duplicate-window-estimate');
    burns.set(burn.windowId, burn);
  }
  if (result.reasons.length) return result;

  let starts = Infinity;
  let concurrency = Infinity;
  let hasRuntimeBurn = true;
  let nextStart = input.now;
  let insufficient = false;
  for (const w of constraints as WindowBudget[]) {
    const burn = burns.get(w.windowId);
    if (!burn || !positive(burn.upperBurn) || burn.unit !== w.raw.unit
        || (burn.burnPerMs !== undefined && !positive(burn.burnPerMs))
        || (burn.remainingDemandBurn !== undefined && !nonnegative(burn.remainingDemandBurn))) {
      add('burn-unknown-or-unit-mismatch');
      result.targetInfeasibility.push('burn-unknown');
      continue;
    }
    if (input.now + estimate!.durationMs >= w.raw.resetAt!) add('reset-crossover-unsupported');
    starts = Math.min(starts, Math.floor(w.safeBudget! / burn.upperBurn));
    if (burn.upperBurn > w.safeBudget!) insufficient = true;
    if (w.targetRatePerMs! > w.sustainableRatePerMs!) result.targetInfeasibility.push('safety-ceiling-precludes-target');
    if (burn.remainingDemandBurn === undefined) result.targetInfeasibility.push('remaining-demand-unknown');
    else if (w.raw.consumed! + w.reserved! + burn.remainingDemandBurn < 0.98 * w.raw.quota!) {
      result.targetInfeasibility.push('insufficient-eligible-demand');
    }
    const projected = burn.remainingDemandBurn === undefined ? null
      : (w.raw.consumed! + w.reserved! + burn.remainingDemandBurn) / w.raw.quota!;
    result.projections.push({
      windowId: w.windowId, projectedEndUtilization: projected,
      earlyExhaustionRisk: projected === null ? null
        : w.raw.consumed! + w.reserved! + burn.remainingDemandBurn! > w.raw.quota! - w.raw.safetyHeadroom!,
    });
    if (burn.burnPerMs === undefined) hasRuntimeBurn = false;
    else {
      const windowConcurrency = w.sustainableRatePerMs! / burn.burnPerMs;
      if (!finiteBudgetValue(windowConcurrency)) {
        add('runtime-burn-overflow');
        continue;
      }
      concurrency = Math.min(concurrency, windowConcurrency);
      // At the existing observations/holds, S/b reaches one at reset - B/b.
      nextStart = Math.max(nextStart, w.raw.resetAt! - w.safeBudget! / burn.burnPerMs);
    }
  }
  result.targetInfeasibility = [...new Set(result.targetInfeasibility)];
  if (result.reasons.length) return result;
  const slots = Math.max(0, binding.maxSlots - binding.activeSlots);
  const cooling = binding.cooldownUntil !== null && binding.cooldownUntil > input.now;
  result.allowedStarts = binding.canStart && !cooling ? Math.min(starts, slots) : 0;
  if (hasRuntimeBurn) {
    result.continuousConcurrency = concurrency;
    result.integerConcurrency = binding.canStart && !cooling ? Math.min(Math.floor(concurrency), slots) : 0;
    nextStart = Math.ceil(Math.max(nextStart, binding.cooldownUntil ?? input.now));
    if (binding.canStart && slots > 0 && !insufficient
        && constraints.every(w => nextStart + estimate!.durationMs < w!.raw.resetAt!)) {
      result.nextEligibleStartAt = Math.ceil(nextStart);
    }
  } else result.targetInfeasibility.push('runtime-burn-unknown');
  if (insufficient) add('safe-budget-insufficient');
  if (!binding.canStart) add('lane-gate-closed');
  if (!slots) add('active-slot-limit');
  if (cooling) add('cooldown');
  if (hasRuntimeBurn && result.integerConcurrency === 0) add('fractional-concurrency-or-operational-limit');
  result.proposal = result.reasons.length ? 'defer' : 'admit';
  return result;
}

export function evaluateBudgets(input: BudgetInput): BudgetEvaluation {
  const groups = new Map<string, BudgetWindowObservation[]>();
  for (const w of input.windows) {
    const id = budgetWindowId(w);
    groups.set(id, [...(groups.get(id) ?? []), w]);
  }
  const currentWindows = new Map<string, Set<string>>();
  for (const w of input.windows) {
    if (w.kind === 'rolling' || !finiteBudgetValue(w.startAt) || !finiteBudgetValue(w.resetAt)
        || w.startAt > input.now || w.resetAt <= input.now) continue;
    const key = JSON.stringify([w.providerId, w.poolId, w.kind]);
    const ids = currentWindows.get(key) ?? new Set<string>();
    ids.add(budgetWindowId(w));
    currentWindows.set(key, ids);
  }
  const windows = [...groups.values()].map(group => {
    const first = group[0]!;
    const fingerprint = (w: BudgetWindowObservation) => JSON.stringify(w, Object.keys(w).sort());
    const contradictoryReset = (currentWindows.get(JSON.stringify([first.providerId, first.poolId, first.kind]))?.size ?? 0) > 1;
    return evaluateWindow(first, input, contradictoryReset || group.some(w => fingerprint(w) !== fingerprint(first)));
  });
  const byId = new Map(windows.map(w => [w.windowId, w]));
  const bindingCounts = new Map<string, number>();
  for (const b of input.eligibleBindings) bindingCounts.set(b.bindingKey, (bindingCounts.get(b.bindingKey) ?? 0) + 1);
  return {
    mode: 'shadow-only', governsHostStarts: false, selectedOrServedAccount: null,
    evaluatedAt: input.now, maxAgeMs: input.maxAgeMs, windows,
    observations: input.windows.map(w => ({ ...w })),
    bindings: input.eligibleBindings.map(b => {
      const budget = evaluateBinding(b, byId, input);
      return bindingCounts.get(b.bindingKey)! > 1 ? {
        ...budget, proposal: 'unknown', reasons: [...budget.reasons, 'ambiguous-binding-key'],
        continuousConcurrency: null, integerConcurrency: null, allowedStarts: null, nextEligibleStartAt: null,
      } : budget;
    }),
  };
}
