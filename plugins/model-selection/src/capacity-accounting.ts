/**
 *  slice 1: capacity-accounting interface + deterministic fixtures.
 *
 * WHY THIS FILE EXISTS
 *
 * `admission-shadow.ts` is explicit about what it does NOT prove:
 * `selectedOrServedAccount` is always null, burn error is null, reservation
 * overlap is unknown, and complete-window / fresh-observation validation are
 * `unproven`. `shadow-emit.ts:239-242` keeps `servedAuth: null` because the
 * collector contract does not carry the auth that served an issue.
 *
 * This module is the fixtures-first contract for closing that gap WITHOUT new
 * credentials, live control, pool changes or spend (final-decision
 * scope). It is pure: the caller supplies already-authorized observations
 * (budget windows, bindings, optional attributed-serve records); this module
 * never fetches, resolves secrets, or writes ledgers.
 *
 * WHAT IT PROVES (when evidence exists)
 *
 * - Serving identity: actual served-account affinity from an attributed record,
 *   OR a conservative shared-pool bound when per-account attribution is absent.
 * - Per-account/window completeness: the observation covers the applicable
 *   window (start..reset), not a last-sample glimpse.
 * - Native demand calibration: native consumed deltas versus estimated burn.
 * - Accounting watermark: monotone per-account/window consumed high-water mark
 *   that retires only the matching incremental hold (mirrors the simulator's
 *   "attributed monotone usage watermarks retire only the matching hold" rule).
 *
 * WHAT STAYS UNKNOWN
 *
 * Missing Meta / short-window evidence is `unknown`, never free capacity.
 * Unknown attribution retains holds conservatively; no TTL implies a refund.
 * Lane-average utilization across accounts is rejected, not averaged (the
 *  blended-account defect: one exhausted + one fresh account must
 * never read as "35% full").
 */

import {
  budgetWindowId,
  stableBudgetId,
  type BudgetWindowObservation,
  type EligibleBudgetBinding,
} from './admission-budget.js';

export const MAX_ACCOUNTING_ACCOUNTS = 64;
export const MAX_ACCOUNTING_WINDOWS = 256;
export const MAX_ACCOUNTING_SERVES = 256;

export type ServingIdentity =
  | {
      kind: 'served-account';
      accountId: string;
      windowIds: string[];
      /** Where the affinity came from; never inferred from routing weights. */
      attribution: 'attributed-ledger' | 'collector-served-auth';
      servedAt: number;
    }
  | {
      kind: 'shared-pool-bound';
      providerId: string;
      poolId: string;
      /** The window the bound is read off (tightest known allowance). */
      boundWindowId: string;
      /** Conservative max utilization across the pool's known observations. */
      boundUtilization: number;
      conservative: true;
      reason: 'no-per-account-attribution';
    }
  | {
      kind: 'unknown';
      reason: 'missing-meta' | 'short-window-unobserved' | 'no-attribution' | 'conflicting-attribution';
    };

/** One attributed serve record supplied by an authorized ledger/collector. */
export interface AttributedServe {
  accountId: string;
  providerId: string;
  servedAt: number;
  /** Opaque non-secret window ids from `budgetWindowId`; must cover ALL of the account's governing windows. */
  windowIds: string[];
  /** Present when the collector itself carried the serving auth. */
  collectorServedAuth?: string | null;
}

export interface AccountWindowProof {
  accountId: string;
  windowId: string;
  /** True only when observations span the applicable window start..reset. */
  complete: boolean;
  completenessReason:
    | 'complete-window-observed'
    | 'window-not-open-yet'
    | 'partial-window'
    | 'allowance-unknown'
    | 'missing-meta'
    | 'short-window-unobserved';
  observedFrom: number | null;
  observedTo: number | null;
  utilizationAtClose: number | null;
  /** 98-100% attainment at close; null unless complete and known. */
  attainmentAtClose: '98-100' | 'underuse' | 'unknown';
}

export interface NativeDemandCalibration {
  windowId: string;
  nativeConsumedDelta: number | null;
  estimatedBurn: number | null;
  /** (estimated - native) / max(native, epsilon); null without both sides. */
  burnError: number | null;
  calibrated: boolean;
  reason: 'calibrated' | 'no-attributed-burn' | 'allowance-unknown' | 'missing-meta';
}

export interface AccountingWatermark {
  accountId: string;
  windowId: string;
  watermarkConsumed: number;
  watermarkObservedAt: number;
  monotone: boolean;
}

export interface CapacityAccountingInput {
  now: number;
  maxAgeMs: number;
  accounts: Array<{ accountId: string; providerId: string; windowIds: string[] }>;
  windows: BudgetWindowObservation[];
  /** Optional already-authorized attributed serves; absent means no affinity. */
  serves?: AttributedServe[];
  /** Optional per-window estimated remaining-demand burn (allowance units). */
  estimatedBurnByWindowId?: Record<string, number>;
  /** Optional prior watermarks; regression is invalid, never silent. */
  priorWatermarks?: AccountingWatermark[];
}

export interface CapacityAccountingReport {
  mode: 'accounting-only';
  governsHostStarts: false;
  evaluatedAt: number;
  servingIdentity: ServingIdentity;
  accounts: Array<{
    accountId: string;
    providerId: string;
    windows: AccountWindowProof[];
    watermark: AccountingWatermark | null;
  }>;
  calibration: NativeDemandCalibration[];
  limitations: string[];
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const nonneg = (n: unknown): n is number => finite(n) && n >= 0;
const clock = (n: unknown): n is number => finite(n) && n >= 0;

/** Reject lane-average smuggling: a utilization that is not on any one window. */
export function assertNoBlendedUtilization(value: unknown, field: string): void {
  if (value !== null && value !== undefined && !finite(value)) {
    throw new Error(`blended-account-average-rejected:${field}`);
  }
}

function validateInput(input: CapacityAccountingInput): Map<string, BudgetWindowObservation[]> {
  if (!clock(input.now) || !finite(input.maxAgeMs) || input.maxAgeMs <= 0) {
    throw new Error('invalid-accounting-clock-or-freshness');
  }
  if (!input.accounts.length || input.accounts.length > MAX_ACCOUNTING_ACCOUNTS) {
    throw new Error('invalid-accounting-cohort');
  }
  if (input.windows.length > MAX_ACCOUNTING_WINDOWS) throw new Error('too-many-accounting-windows');
  if ((input.serves?.length ?? 0) > MAX_ACCOUNTING_SERVES) throw new Error('too-many-accounting-serves');
  const accountIds = new Set<string>();
  const cohortWindowIds = new Set<string>();
  for (const account of input.accounts) {
    if (
      !stableBudgetId(account.accountId) ||
      !stableBudgetId(account.providerId) ||
      accountIds.has(account.accountId) ||
      !account.windowIds.length ||
      new Set(account.windowIds).size !== account.windowIds.length
    ) {
      throw new Error('invalid-accounting-account-identity-or-windows');
    }
    accountIds.add(account.accountId);
    for (const id of account.windowIds) cohortWindowIds.add(id);
  }
  if (cohortWindowIds.size > MAX_ACCOUNTING_WINDOWS) throw new Error('too-many-accounting-windows');
  const byId = new Map<string, BudgetWindowObservation[]>();
  for (const window of input.windows) {
    const id = budgetWindowId(window);
    if (!cohortWindowIds.has(id)) throw new Error('observation-outside-accounting-cohort');
    byId.set(id, [...(byId.get(id) ?? []), window]);
  }
  for (const serve of input.serves ?? []) {
    if (!stableBudgetId(serve.accountId) || !stableBudgetId(serve.providerId) || !clock(serve.servedAt)) {
      throw new Error('invalid-accounting-serve-identity');
    }
    if (!accountIds.has(serve.accountId)) throw new Error('serve-outside-accounting-cohort');
    if (!serve.windowIds.length || new Set(serve.windowIds).size !== serve.windowIds.length) {
      throw new Error('invalid-accounting-serve-windows');
    }
    const account = input.accounts.find((a) => a.accountId === serve.accountId)!;
    if (serve.providerId !== account.providerId) throw new Error('accounting-cohort-provider-mismatch');
    if (serve.windowIds.some((id) => !account.windowIds.includes(id))) {
      throw new Error('serve-outside-account-governing-windows');
    }
    // Affinity must cover ALL governing windows, not a convenient subset.
    if (account.windowIds.some((id) => !serve.windowIds.includes(id))) {
      throw new Error('serve-omits-governing-accounting-window');
    }
  }
  for (const prior of input.priorWatermarks ?? []) {
    if (!stableBudgetId(prior.accountId) || !nonneg(prior.watermarkConsumed) || !clock(prior.watermarkObservedAt)) {
      throw new Error('invalid-accounting-watermark');
    }
  }
  return byId;
}

function windowProof(
  accountId: string,
  windowId: string,
  observations: BudgetWindowObservation[] | undefined,
  now: number,
): AccountWindowProof {
  const base = {
    accountId,
    windowId,
    observedFrom: null as number | null,
    observedTo: null as number | null,
    utilizationAtClose: null as number | null,
    attainmentAtClose: 'unknown' as const,
  };
  if (!observations?.length) {
    const short = /five-hour|rolling/i.test(windowId);
    return {
      ...base,
      complete: false,
      completenessReason: short ? 'short-window-unobserved' : 'allowance-unknown',
    };
  }
  // Meta lanes publish no allowance windows in our collector; absence of any
  // known/meta window observation stays unknown, never free.
  if (observations.every((w) => w.dataState !== 'known')) {
    const meta = observations.some((w) => w.providerId.toLowerCase().includes('meta'));
    return { ...base, complete: false, completenessReason: meta ? 'missing-meta' : 'allowance-unknown' };
  }
  const known = observations.filter((w) => w.dataState === 'known');
  const starts = known.map((w) => w.startAt).filter(nonneg);
  const resets = known.map((w) => w.resetAt).filter(nonneg);
  const observed = known.map((w) => w.observedAt).filter(nonneg);
  if (!starts.length || !resets.length || !observed.length) {
    return { ...base, complete: false, completenessReason: 'allowance-unknown' };
  }
  const from = Math.min(...observed);
  const to = Math.max(...observed);
  const start = Math.min(...starts);
  const reset = Math.max(...resets);
  if (now < reset && now >= start) {
    return { ...base, observedFrom: from, observedTo: to, complete: false, completenessReason: 'window-not-open-yet' };
  }
  // Complete only when observations span start..reset (bounded tolerance: the
  // close sample must be at/after reset and the open sample at/before start).
  const coversOpen = from <= start;
  const coversClose = to >= reset;
  if (!coversOpen || !coversClose) {
    return { ...base, observedFrom: from, observedTo: to, complete: false, completenessReason: 'partial-window' };
  }
  const latest = known.reduce((a, b) => (b.observedAt! > a.observedAt! ? b : a));
  assertNoBlendedUtilization(latest.consumed, 'consumed');
  assertNoBlendedUtilization(latest.quota, 'quota');
  if (!nonneg(latest.consumed) || !nonneg(latest.quota) || latest.quota === 0) {
    return { ...base, observedFrom: from, observedTo: to, complete: false, completenessReason: 'allowance-unknown' };
  }
  const utilization = latest.consumed / latest.quota;
  return {
    ...base,
    observedFrom: from,
    observedTo: to,
    complete: true,
    completenessReason: 'complete-window-observed',
    utilizationAtClose: utilization,
    attainmentAtClose: utilization >= 0.98 && utilization <= 1 ? '98-100' : utilization > 1 ? 'unknown' : 'underuse',
  };
}

function watermarkFor(
  accountId: string,
  windowId: string,
  observations: BudgetWindowObservation[] | undefined,
  prior: AccountingWatermark | undefined,
): AccountingWatermark | null {
  const known = (observations ?? []).filter((w) => w.dataState === 'known' && nonneg(w.consumed) && nonneg(w.observedAt));
  if (!known.length) return null;
  const latest = known.reduce((a, b) => (b.observedAt! > a.observedAt! ? b : a));
  const watermark: AccountingWatermark = {
    accountId,
    windowId,
    watermarkConsumed: latest.consumed!,
    watermarkObservedAt: latest.observedAt!,
    monotone: true,
  };
  if (prior && prior.windowId === windowId && prior.accountId === accountId) {
    if (watermark.watermarkConsumed < prior.watermarkConsumed || watermark.watermarkObservedAt < prior.watermarkObservedAt) {
      throw new Error('accounting-watermark-regression');
    }
  }
  return watermark;
}

/**
 * Pure capacity-accounting evaluation. Never fetches, never resolves secrets,
 * never writes. Unknown stays unknown; blended averages throw.
 */
export function evaluateCapacityAccounting(input: CapacityAccountingInput): CapacityAccountingReport {
  const byId = validateInput(input);
  const serves = input.serves ?? [];

  let servingIdentity: ServingIdentity;
  if (serves.length === 0) {
    // No per-account attribution: conservative shared-pool bound when exactly
    // one pool/window family is observable, else plain unknown.
    const pools = new Map<string, { providerId: string; poolId: string; utilizations: number[]; windowId: string }>();
    for (const window of input.windows) {
      if (window.dataState !== 'known' || !nonneg(window.consumed) || !nonneg(window.quota) || window.quota === 0) continue;
      const id = budgetWindowId(window);
      const key = JSON.stringify([window.providerId, window.poolId]);
      const entry = pools.get(key) ?? { providerId: window.providerId, poolId: window.poolId, utilizations: [], windowId: id };
      entry.utilizations.push(window.consumed / window.quota);
      // Tightest (max) known utilization is the conservative bound.
      if (window.consumed / window.quota >= Math.max(...entry.utilizations)) entry.windowId = id;
      pools.set(key, entry);
    }
    if (pools.size === 1) {
      const [entry] = [...pools.values()];
      assertNoBlendedUtilization(entry!.utilizations[0], 'bound');
      servingIdentity = {
        kind: 'shared-pool-bound',
        providerId: entry!.providerId,
        poolId: entry!.poolId,
        boundWindowId: entry!.windowId,
        boundUtilization: Math.max(...entry!.utilizations),
        conservative: true,
        reason: 'no-per-account-attribution',
      };
    } else {
      const hasMeta = input.accounts.some((a) => a.providerId.toLowerCase().includes('meta'));
      servingIdentity = {
        kind: 'unknown',
        reason: hasMeta ? 'missing-meta' : 'no-attribution',
      };
    }
  } else {
    // Competing attribution claims for one evaluation: >1 serve rows is
    // conflicting whether they disagree (distinct accounts) or duplicate
    // (same account twice) — never first-wins. A single attributed serve
    // proves served-account affinity; anything more stays unknown.
    if (serves.length > 1) {
      servingIdentity = { kind: 'unknown', reason: 'conflicting-attribution' };
    } else {
      const serve = serves[0]!;
      servingIdentity = {
        kind: 'served-account',
        accountId: serve.accountId,
        windowIds: [...serve.windowIds],
        attribution: serve.collectorServedAuth ? 'collector-served-auth' : 'attributed-ledger',
        servedAt: serve.servedAt,
      };
    }
  }

  const accounts = input.accounts.map((account) => ({
    accountId: account.accountId,
    providerId: account.providerId,
    windows: account.windowIds.map((id) => windowProof(account.accountId, id, byId.get(id), input.now)),
    watermark: null as AccountingWatermark | null,
  }));
  // Watermarks advance per account/window; regression throws above.
  for (const entry of accounts) {
    const priors = (input.priorWatermarks ?? []).filter((p) => p.accountId === entry.accountId);
    const marks = entry.windows.map((w) =>
      watermarkFor(entry.accountId, w.windowId, byId.get(w.windowId), priors.find((p) => p.windowId === w.windowId)),
    );
    entry.watermark = marks.filter((m): m is AccountingWatermark => m !== null).sort((a, b) => b.watermarkObservedAt - a.watermarkObservedAt)[0] ?? null;
  }

  const calibration: NativeDemandCalibration[] = input.accounts.flatMap((account) =>
    account.windowIds.map((windowId) => {
      const observations = byId.get(windowId) ?? [];
      const known = observations.filter((w) => w.dataState === 'known' && nonneg(w.consumed));
      const estimated = input.estimatedBurnByWindowId?.[windowId];
      if (!known.length || estimated === undefined || !nonneg(estimated)) {
        const meta = observations.some((w) => w.providerId.toLowerCase().includes('meta'));
        return {
          windowId,
          nativeConsumedDelta: null,
          estimatedBurn: nonneg(estimated) ? (estimated as number) : null,
          burnError: null,
          calibrated: false,
          reason: meta ? ('missing-meta' as const) : ('no-attributed-burn' as const),
        };
      }
      const sorted = [...known].sort((a, b) => a.observedAt! - b.observedAt!);
      const delta = sorted.length > 1 ? sorted[sorted.length - 1]!.consumed! - sorted[0]!.consumed! : sorted[0]!.consumed!;
      if (delta < 0) throw new Error('accounting-watermark-regression');
      const burnError = delta === 0 ? (estimated === 0 ? 0 : null) : (estimated - delta) / Math.max(delta, 1e-9);
      return {
        windowId,
        nativeConsumedDelta: delta,
        estimatedBurn: estimated,
        burnError,
        calibrated: burnError !== null,
        reason: burnError !== null ? ('calibrated' as const) : ('no-attributed-burn' as const),
      };
    }),
  );

  return {
    mode: 'accounting-only',
    governsHostStarts: false,
    evaluatedAt: input.now,
    servingIdentity,
    accounts,
    calibration,
    limitations: [
      'Interface/fixtures slice: no collection, no live control, no pool change.',
      'Caller-declared observations are not certified production evidence.',
      'Missing Meta/short-window evidence stays unknown, never free capacity.',
      'Unknown attribution retains holds conservatively; no TTL implies a refund.',
    ],
  };
}

/**
 *  slice 2: feed adapter from authorized collector/adapter samples.
 *
 * Maps already-authorized quota-contract windows (`BudgetWindowObservation[]`)
 * plus admission/pace bindings (`EligibleBudgetBinding[]`, which carry the
 * account cohort and per-window `remainingDemandBurn` estimates) into a
 * `CapacityAccountingInput` for `evaluateCapacityAccounting`.
 *
 * Pure: never fetches, never resolves secrets, never writes. Bounded
 * fresh-observations window enforced with the same rule as the budget gate
 * (`now - observedAt > maxAgeMs` is stale and dropped). Null-observedAt
 * windows pass through as unknown evidence, never free capacity.
 *
 * Does NOT invent attribution: `serves` is only forwarded when the caller
 * supplies already-authorized attributed records (today `shadow-emit`
 * keeps `servedAuth: null`, so the feed path proves the
 * shared-pool-bound/unknown branches on real-shaped samples).
 */
export interface CapacityAccountingFeedInput {
  now: number;
  maxAgeMs: number;
  /** Already-authorized quota-contract window observations. */
  windows: BudgetWindowObservation[];
  /** Already-authorized admission/pace bindings; the account cohort source. */
  eligibleBindings: EligibleBudgetBinding[];
  /** Already-authorized attributed serves; absent means no affinity claimed. */
  serves?: AttributedServe[];
  /** Optional prior watermarks; regression is invalid, never silent. */
  priorWatermarks?: AccountingWatermark[];
}

export interface CapacityAccountingFeed {
  input: CapacityAccountingInput;
  /** windowIds dropped as stale (observedAt older than now - maxAgeMs). */
  droppedStaleWindowIds: string[];
  /** Binding keys excluded because account/pool compatibility was unobserved. */
  excludedBindingKeys: string[];
}

/**
 *  slice 3: caller-attested served-auth join.
 *
 * The collector contract does not yet carry the auth that served an issue
 * (`shadow-emit.ts` keeps `servedAuth: null` rather than guessing from
 * routing weights), so live served-account affinity is still unproven. This
 * is the honest choke point for when an authorized caller CAN attest service:
 * given the auth keys actually observed in lane-capacity/shadow snapshots
 * plus explicit caller attestations ("issue flow X was served by auth Y at T"),
 * it emits validated `AttributedServe[]` for `evaluateCapacityAccounting`.
 *
 * It never derives service from weights, shares, or utilization — an
 * attested auth absent from the observed cohort throws
 * `serve-auth-not-in-observed-cohort` instead of resolving to the
 * highest-weight account. Caller attestation is still not certified
 * production evidence (see report `limitations`); full proof needs the
 * collector to carry served auth per issue plus complete windows.
 */
export interface ServedAuthAttestation {
  accountId: string;
  providerId: string;
  /** The serving auth the caller attests; must appear in the observed cohort. */
  servedAuth: string;
  servedAt: number;
  /** Must cover ALL of the account's governing windows (checked downstream). */
  windowIds: string[];
}

export function attributedServesFromAttestation(
  observedAuthKeys: Array<string | null>,
  attestations: ServedAuthAttestation[],
): AttributedServe[] {
  if (attestations.length > MAX_ACCOUNTING_SERVES) throw new Error('too-many-accounting-serves');
  const observed = new Set(observedAuthKeys.filter((key): key is string => typeof key === 'string' && key.length > 0));
  return attestations.map((attestation) => {
    if (
      !stableBudgetId(attestation.accountId) ||
      !stableBudgetId(attestation.providerId) ||
      !clock(attestation.servedAt) ||
      typeof attestation.servedAuth !== 'string' ||
      attestation.servedAuth.length === 0
    ) {
      throw new Error('invalid-accounting-attestation');
    }
    if (
      !attestation.windowIds.length ||
      new Set(attestation.windowIds).size !== attestation.windowIds.length
    ) {
      throw new Error('invalid-accounting-serve-windows');
    }
    if (!observed.has(attestation.servedAuth)) {
      throw new Error('serve-auth-not-in-observed-cohort');
    }
    return {
      accountId: attestation.accountId,
      providerId: attestation.providerId,
      servedAt: attestation.servedAt,
      windowIds: [...attestation.windowIds],
      collectorServedAuth: attestation.servedAuth,
    };
  });
}

export function buildCapacityAccountingInput(feed: CapacityAccountingFeedInput): CapacityAccountingFeed {
  if (!clock(feed.now) || !finite(feed.maxAgeMs) || feed.maxAgeMs <= 0) {
    throw new Error('invalid-accounting-clock-or-freshness');
  }
  // Bounded fresh-observations window: stale samples are dropped, never certified.
  const fresh: BudgetWindowObservation[] = [];
  const droppedStaleWindowIds: string[] = [];
  for (const window of feed.windows) {
    if (window.observedAt === null || window.observedAt === undefined) {
      fresh.push(window);
      continue;
    }
    if (!finite(window.observedAt) || feed.now - window.observedAt > feed.maxAgeMs) {
      droppedStaleWindowIds.push(budgetWindowId(window));
      continue;
    }
    fresh.push(window);
  }
  const hasFreshKnown = fresh.some(
    (w) => w.dataState === 'known' && finite(w.observedAt) && feed.now - w.observedAt! <= feed.maxAgeMs,
  );
  if (!hasFreshKnown) throw new Error('accounting-feed-no-fresh-observations');

  // Account cohort from bindings; null windowIds mean compatibility unobserved.
  const excludedBindingKeys: string[] = [];
  const cohort = new Map<string, { accountId: string; providerId: string; windowIds: string[] }>();
  const estimatedBurnByWindowId: Record<string, number> = {};
  for (const binding of feed.eligibleBindings) {
    if (!stableBudgetId(binding.accountId) || !stableBudgetId(binding.providerId)) {
      throw new Error('accounting-feed-unstable-binding-identity');
    }
    if (binding.windowIds === null || binding.windowIds.length === 0) {
      excludedBindingKeys.push(binding.bindingKey);
      continue;
    }
    const key = JSON.stringify([binding.accountId, binding.providerId]);
    const entry = cohort.get(key) ?? { accountId: binding.accountId, providerId: binding.providerId, windowIds: [] as string[] };
    for (const id of binding.windowIds) {
      if (!entry.windowIds.includes(id)) entry.windowIds.push(id);
    }
    cohort.set(key, entry);
    // Per-window remaining-demand burn: max across bindings, never summed,
    // so shared-window demand is not double-counted.
    for (const estimate of binding.estimate?.windows ?? []) {
      if (estimate.remainingDemandBurn === undefined || !nonneg(estimate.remainingDemandBurn)) continue;
      estimatedBurnByWindowId[estimate.windowId] = Math.max(
        estimatedBurnByWindowId[estimate.windowId] ?? Number.NEGATIVE_INFINITY,
        estimate.remainingDemandBurn,
      );
    }
  }
  if (cohort.size === 0) throw new Error('accounting-feed-no-eligible-bindings');

  return {
    input: {
      now: feed.now,
      maxAgeMs: feed.maxAgeMs,
      accounts: [...cohort.values()],
      windows: fresh,
      ...(feed.serves ? { serves: feed.serves } : {}),
      ...(Object.keys(estimatedBurnByWindowId).length ? { estimatedBurnByWindowId } : {}),
      ...(feed.priorWatermarks ? { priorWatermarks: feed.priorWatermarks } : {}),
    },
    droppedStaleWindowIds,
    excludedBindingKeys,
  };
}
