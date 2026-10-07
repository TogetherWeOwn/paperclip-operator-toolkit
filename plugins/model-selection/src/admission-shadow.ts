import {
  budgetWindowId, evaluateBudgets, stableBudgetId,
  type BudgetEvaluation, type BudgetInput, type BudgetWindowObservation,
  type EligibleBudgetBinding, type IncrementalHold,
} from './admission-budget.js';
import { adaptLaneQuotaSnapshot, type LaneObservationAdapterResult, type LaneQuotaSnapshot } from './admission-observation.js';
import {
  fleetProposalRecord, proposeShadowFleetAdmission,
  type FleetAdmissionShadowProposal, type FleetShadowInput,
} from './fleet-admission-shadow.js';

export interface ShadowAccount {
  accountId: string;
  providerId: string;
  /** Explicitly observed compatibility, not an account inferred from a lane. */
  windowIds: string[];
}

export interface AdmissionShadowInput {
  enabled: boolean;
  cohortId: string;
  accounts: ShadowAccount[];
  evidenceKind: 'synthetic-replay' | 'observed-replay' | 'fresh-observations';
  startAt: number;
  endAt: number;
  /** Caller supplies the result of existing eligibility gates, not a roster. */
  samples: BudgetInput[];
}

export interface AdmissionShadowReport {
  mode: 'shadow-only';
  governsHostStarts: false;
  claimsReservations: false;
  selectedOrServedAccount: null;
  cohortId: string;
  evidenceKind: AdmissionShadowInput['evidenceKind'];
  /** Input provenance is caller-declared; this report does not certify it. */
  productionEvidenceCertified: false;
  startAt: number;
  endAt: number;
  sampleCount: number;
  firstEvaluatedAt: number;
  lastEvaluatedAt: number;
  /** Sampling a window is not proof of a complete provider usage ledger. */
  completeWindowValidation: 'unproven';
  freshObservationValidation: 'unproven';
  accounts: Array<{
    accountId: string;
    providerId: string;
    sampleCount: number;
    proposalCounts: { admit: number; defer: number; unknown: number };
    infeasibilityReasons: string[];
    /** No sum of percentages, unlike units, plan weights or shared pools. */
    windows: Array<{
      windowId: string;
      observedAt: number | null;
      utilizationAtLastSample: number | null;
      attainmentAtLastSample: '98-100' | 'underuse' | 'unknown';
      earlyExhaustionObserved: boolean | null;
      estimatedVersusActualBurnError: null;
      reserveOverlapUncertainty: 'unknown';
    }>;
  }>;
  /** Unique pool/window evaluations; shared allowance appears once per sample. */
  evaluations: BudgetEvaluation[];
  /**
   * Shadow fleet admission proposal for this cycle, when the caller supplied
   * lane verdicts and burn-downs and the fleet picture was computable.
   * Absent on `unknown`: an unreadable fleet records nothing.
   */
  fleetProposal?: FleetAdmissionShadowProposal;
  limitations: string[];
  /** Present only when accounts/windows were derived from a lane quota snapshot. */
  observationAdapter?: Pick<LaneObservationAdapterResult, 'schema' | 'evidenceKind' | 'snapshotObservedAt' | 'maxAgeMs'
    | 'rows' | 'unmappedLanes' | 'unstableLaneCount' | 'missingLanes'>;
}

export interface DecisionAdmissionShadowInput {
  enabled: boolean;
  cohortId: string;
  accounts: ShadowAccount[];
  maxAgeMs: number;
  windows: BudgetWindowObservation[];
  holds: IncrementalHold[];
  /** Explicit model-to-opaque-binding observation; never decode a binding key. */
  bindings: Array<{ modelId: string; binding: EligibleBudgetBinding }>;
}

/**
 * Alternative to explicit `accounts`/`windows`: a lane quota snapshot whose
 * identities come ONLY from the committed lane table. Supplying both is rejected.
 */
export interface LaneSnapshotAdmissionShadowInput {
  enabled: boolean;
  cohortId: string;
  maxAgeMs: number;
  laneQuotaSnapshot: LaneQuotaSnapshot;
  holds?: IncrementalHold[];
  bindings?: DecisionAdmissionShadowInput['bindings'];
}

/**
 * Intersects supplied bindings with the ALREADY computed landing-tier set.
 *
 * The optional `fleet` input carries the already-evaluated lane verdicts and
 * burn-downs plus the previous cycle's proposal level (upgrade-only
 * hysteresis). The proposal is shadow-only: it is recorded on the report and
 * never reaches selection or actuation. An unreadable fleet (`unknown`) or a
 * proposal failure records nothing and changes nothing.
 */
export function reportDecisionAdmissionShadow(
  rawInput: DecisionAdmissionShadowInput | LaneSnapshotAdmissionShadowInput,
  now: number,
  eligibleModels: ReadonlyArray<{ modelId: string; lane: string | null }>,
  fleet?: FleetShadowInput,
): AdmissionShadowReport | null {
  if (rawInput.enabled === false) return null;
  if (JSON.stringify(rawInput).length > 128 * 1024 || (rawInput.bindings?.length ?? 0) > 256) {
    throw new Error('decision-shadow-input-too-large');
  }
  // Do not persist arbitrary fields from a raw provider/credential document.
  const fields = (value: object, allowed: string[]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !allowed.includes(key))) throw new Error('unexpected-shadow-input-fields');
  };
  let adapted: LaneObservationAdapterResult | null = null;
  let input: DecisionAdmissionShadowInput;
  if ('laneQuotaSnapshot' in rawInput && rawInput.laneQuotaSnapshot !== undefined) {
    fields(rawInput, ['enabled', 'cohortId', 'maxAgeMs', 'laneQuotaSnapshot', 'holds', 'bindings']);
    fields(rawInput.laneQuotaSnapshot, ['schemaVersion', 'observedAt', 'staleAfterSeconds', 'observationQuality', 'records']);
    // Hardcoded: a stored lane document carries no provenance of its own, so the
    // lane-snapshot path always labels 'fresh-observations'. Fixture replays use
    // the explicit accounts/windows path with their own evidenceKind.
    adapted = adaptLaneQuotaSnapshot({
      snapshot: rawInput.laneQuotaSnapshot, now, maxAgeMs: rawInput.maxAgeMs, evidenceKind: 'fresh-observations',
    });
    input = {
      enabled: rawInput.enabled, cohortId: rawInput.cohortId, accounts: adapted.accounts, maxAgeMs: rawInput.maxAgeMs,
      windows: adapted.windows, holds: rawInput.holds ?? [], bindings: rawInput.bindings ?? [],
    };
  } else input = rawInput as DecisionAdmissionShadowInput;
  fields(input, ['enabled', 'cohortId', 'accounts', 'maxAgeMs', 'windows', 'holds', 'bindings']);
  for (const account of input.accounts) fields(account, ['accountId', 'providerId', 'windowIds']);
  for (const window of input.windows) fields(window, ['providerId', 'poolId', 'kind', 'startAt', 'resetAt',
    'observedAt', 'sourceRevision', 'schemaRevision', 'unit', 'quota', 'consumed', 'safetyHeadroom', 'planWeight', 'dataState']);
  for (const hold of input.holds) fields(hold, ['windowId', 'unit', 'amount']);
  for (const entry of input.bindings) {
    fields(entry, ['modelId', 'binding']);
    fields(entry.binding, ['bindingKey', 'lane', 'accountId', 'providerId', 'windowIds', 'canStart',
      'activeSlots', 'maxSlots', 'cooldownUntil', 'estimate']);
    if (entry.binding.estimate !== null) {
      fields(entry.binding.estimate!, ['revision', 'durationMs', 'windows']);
      for (const burn of entry.binding.estimate!.windows) fields(burn,
        ['windowId', 'unit', 'upperBurn', 'burnPerMs', 'remainingDemandBurn']);
    }
  }
  const bindings = input.bindings.filter(entry => eligibleModels.some(model =>
    model.modelId === entry.modelId && model.lane !== null && model.lane === entry.binding.lane));
  const report = reportAdmissionShadow({
    enabled: input.enabled, cohortId: input.cohortId, accounts: input.accounts,
    evidenceKind: 'fresh-observations', startAt: now, endAt: now,
    samples: [{ now, maxAgeMs: input.maxAgeMs, windows: input.windows, holds: input.holds,
      eligibleBindings: bindings.map(entry => entry.binding) }],
  });
  if (report) {
    if (fleet !== undefined) {
      try {
        const previousLevel = fleet.previousLevel ?? null;
        const record = fleetProposalRecord(proposeShadowFleetAdmission(fleet), previousLevel);
        if (record) report.fleetProposal = record;
      } catch {
        // Fail-neutral: a broken proposal input must not veto the shadow report.
      }
    }
    // No mapping is not proof of no demand, especially for a sticky incumbent
    // whose existing selector intentionally does not enumerate candidates.
    for (const account of report.accounts) {
      account.infeasibilityReasons = account.infeasibilityReasons.map(reason =>
        reason === 'no-capable-demand' ? 'no-observed-eligible-account-binding' : reason);
    }
    report.limitations.push(`Existing landing-tier candidates only; ${input.bindings.length - bindings.length} supplied bindings excluded. No eligibility was added.`);
    if (adapted) {
      const { schema, evidenceKind, snapshotObservedAt, maxAgeMs, rows, unmappedLanes, unstableLaneCount, missingLanes } = adapted;
      report.observationAdapter = { schema, evidenceKind, snapshotObservedAt, maxAgeMs, rows, unmappedLanes, unstableLaneCount, missingLanes };
      report.limitations.push(...adapted.limitations);
    }
    if (JSON.stringify(report).length > 512 * 1024) throw new Error('decision-shadow-report-too-large');
  }
  return report;
}

const MAX_ACCOUNTS = 64;
const MAX_SAMPLES = 256;
const MAX_WINDOWS = 256;
const DAY_MS = 24 * 60 * 60 * 1000;
const clock = (n: number) => Number.isFinite(n) && n >= 0;

/** Bounded, pure report. Does not reserve, persist, select, pin or start anything. */
export function reportAdmissionShadow(input: AdmissionShadowInput): AdmissionShadowReport | null {
  // Off is a true no-op, even when the dormant report input is incomplete.
  if (input.enabled === false) return null;
  if (input.enabled !== true || !stableBudgetId(input.cohortId)
      || !input.accounts.length || input.accounts.length > MAX_ACCOUNTS
      || !input.samples.length || input.samples.length > MAX_SAMPLES
      || !clock(input.startAt) || !clock(input.endAt) || input.endAt < input.startAt
      || !['synthetic-replay', 'observed-replay', 'fresh-observations'].includes(input.evidenceKind)) {
    throw new Error('invalid-shadow-bounds-or-cohort');
  }
  const accountIds = new Set<string>();
  const windowIds = new Set<string>();
  for (const account of input.accounts) {
    if (!stableBudgetId(account.accountId) || !stableBudgetId(account.providerId)
        || accountIds.has(account.accountId) || !account.windowIds.length
        || account.windowIds.length > MAX_WINDOWS || new Set(account.windowIds).size !== account.windowIds.length) {
      throw new Error('invalid-shadow-account-identity-or-windows');
    }
    accountIds.add(account.accountId);
    for (const id of account.windowIds) windowIds.add(id);
  }
  if (windowIds.size > MAX_WINDOWS) throw new Error('too-many-shadow-windows');
  if (input.evidenceKind === 'fresh-observations' && input.endAt - input.startAt > DAY_MS) {
    throw new Error('fresh-shadow-period-exceeds-24-hours');
  }

  const accounts = new Map(input.accounts.map(a => [a.accountId, a]));
  const replayWindows = new Map<string, { startAt: number; resetAt: number }>();
  let previousAt = -1;
  for (const sample of input.samples) {
    if (!clock(sample.now) || sample.now < input.startAt || sample.now > input.endAt || sample.now <= previousAt
        || sample.windows.length > MAX_WINDOWS || sample.eligibleBindings.length > 256 || sample.holds.length > 1024) {
      throw new Error('invalid-shadow-sample-bounds');
    }
    previousAt = sample.now;
    for (const observation of sample.windows) {
      const id = budgetWindowId(observation);
      if (!windowIds.has(id)) throw new Error('observation-outside-fixed-shadow-cohort');
      if (observation.startAt !== null && observation.resetAt !== null
          && clock(observation.startAt) && clock(observation.resetAt) && observation.resetAt > observation.startAt) {
        replayWindows.set(id, { startAt: observation.startAt, resetAt: observation.resetAt });
      }
      for (const account of input.accounts.filter(a => a.windowIds.includes(id))) {
        if (account.providerId !== observation.providerId) throw new Error('shadow-cohort-provider-mismatch');
      }
    }
    for (const binding of sample.eligibleBindings) {
      const account = accounts.get(binding.accountId);
      if (!account || binding.providerId !== account.providerId
          || binding.windowIds?.some(id => !account.windowIds.includes(id))) {
        throw new Error('binding-outside-fixed-shadow-cohort');
      }
      // An observed binding must cover ALL governing limits declared for that account.
      if (binding.windowIds !== null && account.windowIds.some(id => !binding.windowIds!.includes(id))) {
        throw new Error('binding-omits-governing-shadow-window');
      }
    }
    if (sample.holds.some(h => !windowIds.has(h.windowId))) throw new Error('hold-outside-fixed-shadow-cohort');
  }
  if (input.evidenceKind !== 'fresh-observations') {
    // Unknown clocks cannot authorize an unbounded replay. Fresh snapshots may
    // still report those observations as unknown/invalid within the 24h bound.
    if ([...windowIds].some(id => !replayWindows.has(id))) throw new Error('unknown-replay-window-bounds');
    for (const { startAt, resetAt } of replayWindows.values()) {
      if (input.startAt < startAt || input.endAt > resetAt) throw new Error('shadow-replay-exceeds-one-window');
    }
  }

  const evaluations = input.samples.map(evaluateBudgets);
  const latest = evaluations[evaluations.length - 1]!;
  return {
    mode: 'shadow-only', governsHostStarts: false, claimsReservations: false, selectedOrServedAccount: null,
    cohortId: input.cohortId, evidenceKind: input.evidenceKind,
    productionEvidenceCertified: false,
    startAt: input.startAt, endAt: input.endAt, sampleCount: evaluations.length,
    firstEvaluatedAt: evaluations[0]!.evaluatedAt, lastEvaluatedAt: latest.evaluatedAt,
    completeWindowValidation: 'unproven', freshObservationValidation: 'unproven',
    accounts: input.accounts.map(account => {
      const bindingBudgets = evaluations.flatMap(e => e.bindings.filter(b => b.accountId === account.accountId));
      const reasons = [...new Set(bindingBudgets.flatMap(b => b.targetInfeasibility))];
      if (evaluations.some(e => !e.bindings.some(b => b.accountId === account.accountId))) reasons.push('no-capable-demand');
      // A known utilization-only window has no allowance: it is not budget.
      if (account.windowIds.some(id => !latest.windows.some(w => w.windowId === id && w.dataState === 'known'
          && w.safeBudget !== null))) {
        reasons.push('allowance-unknown');
      }
      return {
        accountId: account.accountId, providerId: account.providerId, sampleCount: evaluations.length,
        proposalCounts: {
          admit: bindingBudgets.filter(b => b.proposal === 'admit').length,
          defer: bindingBudgets.filter(b => b.proposal === 'defer').length,
          unknown: bindingBudgets.filter(b => b.proposal === 'unknown').length,
        },
        infeasibilityReasons: [...new Set(reasons)],
        windows: account.windowIds.map(windowId => {
          const window = latest.windows.find(w => w.windowId === windowId);
          const utilization = window?.utilization ?? null;
          const known = evaluations.flatMap(e => e.windows.filter(w => w.windowId === windowId && w.dataState === 'known'));
          return {
            windowId, observedAt: window?.raw.observedAt ?? null, utilizationAtLastSample: utilization,
            attainmentAtLastSample: utilization === null ? 'unknown' as const
              : utilization >= 0.98 && utilization <= 1 ? '98-100' as const : 'underuse' as const,
            earlyExhaustionObserved: known.length ? known.some(w => w.utilization === 1) : null,
            estimatedVersusActualBurnError: null, reserveOverlapUncertainty: 'unknown' as const,
          };
        }),
      };
    }),
    evaluations,
    limitations: [
      'No host start/retry/wake paths covered; no production atomic reservation storage.',
      'Account compatibility is supplied evidence, not proof of selected or served upstream account.',
      'Attainment is at the last valid sample, not certified end-of-window utilization.',
      'No attributed actual-burn ledger: burn error and reservation overlap remain unknown.',
      'Complete-window replay and fresh provider-observation validation remain unproven.',
      ...(input.evidenceKind === 'synthetic-replay' ? ['Synthetic fixtures are not production evidence.'] : []),
    ],
  };
}
