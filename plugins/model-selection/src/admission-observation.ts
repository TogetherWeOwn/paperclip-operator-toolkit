import {
  UTILIZATION_ONLY_UNIT, budgetWindowId, stableBudgetId,
  type BudgetDataState, type BudgetWindowObservation,
} from './admission-budget.js';
import { COMMITTED_LANE_ACCOUNT_BINDINGS } from './admission-lane-bindings.js';

/**
 * Pure, read-only adapter from a per-lane quota snapshot to shadow-report
 * accounts and window observations. It reads no storage, calls no provider and
 * changes no selection. Identity comes only from the committed lane table;
 * utilization-only data is advisory attainment (see `UTILIZATION_ONLY_UNIT`).
 */
export type ObservationWindowKind = 'five-hour' | 'weekly';

export interface LaneWindowBinding {
  kind: ObservationWindowKind;
  utilizationField: string;
  resetField: string;
}

export interface LaneAccountBinding {
  /** The lane id the snapshot emits for this account. */
  laneId: string;
  accountId: string;
  /** Lanes that deliberately share a pool share its windows and are counted once. */
  poolId: string;
  providerId: string;
  /** ALL governing windows for the account. */
  windows: LaneWindowBinding[];
}

export interface LaneQuotaSnapshot {
  schemaVersion?: number;
  /** Snapshot-level clock; every record is observed at this instant. */
  observedAt: string | number;
  /** Accepted for lane-document compatibility and ignored: freshness is the explicit `maxAgeMs`. */
  staleAfterSeconds?: number;
  observationQuality?: string;
  /** Extra record fields are never read, copied or persisted. */
  records: Array<Record<string, unknown>>;
}

export interface ObservationRow {
  laneId: string;
  accountId: string;
  poolId: string;
  providerId: string;
  windowKind: ObservationWindowKind;
  windowId: string;
  state: BudgetDataState;
  reasons: string[];
  observationQuality: 'live' | 'cached' | 'counts-only' | null;
  freshness: 'fresh' | 'cached' | 'too-old' | 'unobserved' | 'unknown';
  /** As reported, preserved even when the observation is not usable. */
  utilization: number | null;
  /** Exact reported instant; `resetAt` below is snapped to `RESET_IDENTITY_GRID_MS`. */
  reportedResetAt: string | null;
  resetAt: number | null;
}

export interface LaneObservationAdapterResult {
  schema: 'lane-quota-observation-adapter-v1';
  /** Caller-declared provenance; the adapter does not certify it. */
  evidenceKind: 'synthetic-replay' | 'observed-replay' | 'fresh-observations';
  snapshotObservedAt: number | null;
  maxAgeMs: number;
  accounts: Array<{ accountId: string; providerId: string; windowIds: string[] }>;
  windows: BudgetWindowObservation[];
  rows: ObservationRow[];
  unmappedLanes: string[];
  unstableLaneCount: number;
  missingLanes: string[];
  limitations: string[];
}

export interface LaneObservationAdapterInput {
  snapshot: LaneQuotaSnapshot;
  now: number;
  /** Explicit finite positive freshness bound; there is no default. */
  maxAgeMs: number;
  evidenceKind: LaneObservationAdapterResult['evidenceKind'];
  bindings?: readonly LaneAccountBinding[];
}

export const WINDOW_MS: Record<ObservationWindowKind, number> = {
  'five-hour': 5 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};
/**
 * Reported resets carry jitter of up to about a second around the provider's
 * real boundary (for example 09:59:59.666 and 19:00:00.443 for whole-minute
 * resets). The window id embeds the reset, so it is snapped to the nearest
 * minute to stay stable across polls; the exact instant stays on the row.
 */
export const RESET_IDENTITY_GRID_MS = 60_000;
const MAX_BINDING_ACCOUNTS = 64;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const finiteObserved = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** Rejects a table that could blur identities; never repairs it. */
export function validateLaneAccountBindings(bindings: readonly LaneAccountBinding[]): void {
  if (!bindings.length || bindings.length > MAX_BINDING_ACCOUNTS) throw new Error('invalid-lane-binding-table-size');
  const lanes = new Set<string>();
  const accounts = new Set<string>();
  const pools = new Map<string, { providerId: string; kinds: string }>();
  for (const entry of bindings) {
    if (![entry.laneId, entry.accountId, entry.poolId, entry.providerId].every(stableBudgetId)) {
      throw new Error('unstable-lane-binding-identity');
    }
    if (lanes.has(entry.laneId)) throw new Error('duplicate-lane-binding');
    if (accounts.has(entry.accountId)) throw new Error('duplicate-account-binding');
    lanes.add(entry.laneId);
    accounts.add(entry.accountId);
    const kinds = entry.windows.map(w => w.kind);
    if (!kinds.length || new Set(kinds).size !== kinds.length
        || entry.windows.some(w => !(w.kind in WINDOW_MS) || !w.utilizationField || !w.resetField)) {
      throw new Error('invalid-lane-binding-windows');
    }
    const key = [...kinds].sort().join(',');
    const pool = pools.get(entry.poolId);
    if (pool && (pool.providerId !== entry.providerId || pool.kinds !== key)) throw new Error('inconsistent-shared-pool');
    pools.set(entry.poolId, { providerId: entry.providerId, kinds: key });
  }
}

/** Only an ISO-8601 instant with an explicit offset, or finite epoch milliseconds. */
function epochMs(value: unknown): number | null {
  if (finiteObserved(value)) return value >= 0 ? value : null;
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

const qualityOf = (value: unknown): ObservationRow['observationQuality'] =>
  value === 'live' || value === 'cached' || value === 'counts-only' ? value : null;

const RANK: Record<BudgetDataState, number> = { known: 0, stale: 1, unknown: 2, invalid: 3 };

export function adaptLaneQuotaSnapshot(input: LaneObservationAdapterInput): LaneObservationAdapterResult {
  const bindings = input.bindings ?? COMMITTED_LANE_ACCOUNT_BINDINGS;
  validateLaneAccountBindings(bindings);
  if (!finiteObserved(input.maxAgeMs) || input.maxAgeMs <= 0) throw new Error('invalid-observation-max-age');
  if (!finiteObserved(input.now) || input.now < 0) throw new Error('invalid-observation-clock');
  if (!['synthetic-replay', 'observed-replay', 'fresh-observations'].includes(input.evidenceKind)) {
    throw new Error('invalid-observation-evidence-kind');
  }
  const snapshot = input.snapshot;
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.records) || snapshot.records.length > 256) {
    throw new Error('invalid-lane-quota-snapshot');
  }

  const observedAt = epochMs(snapshot.observedAt);
  const sourceRevision = observedAt === null ? null : `lane-quota-snapshot@${new Date(observedAt).toISOString()}`;
  const schemaRevision = Number.isSafeInteger(snapshot.schemaVersion) ? `lane-quota-snapshot-v${snapshot.schemaVersion}` : null;

  const byLane = new Map<string, Array<Record<string, unknown>>>();
  const unmappedLanes: string[] = [];
  let unstableLaneCount = 0;
  const known = new Set(bindings.map(b => b.laneId));
  for (const record of snapshot.records) {
    const lane = record && typeof record === 'object' ? (record.lane ?? record.laneId) : undefined;
    if (!stableBudgetId(lane)) { unstableLaneCount += 1; continue; }
    byLane.set(lane, [...(byLane.get(lane) ?? []), record]);
    if (!known.has(lane) && !unmappedLanes.includes(lane)) unmappedLanes.push(lane);
  }

  const windows: BudgetWindowObservation[] = [];
  const rows: ObservationRow[] = [];
  const seen = new Set<string>();
  const accounts: LaneObservationAdapterResult['accounts'] = [];
  const missingLanes: string[] = [];

  for (const binding of bindings) {
    const records = byLane.get(binding.laneId) ?? [];
    const record = records.length === 1 ? records[0]! : null;
    if (!records.length) missingLanes.push(binding.laneId);
    const windowIds: string[] = [];

    for (const window of binding.windows) {
      const reasons: string[] = [];
      let state: BudgetDataState = 'known';
      const raise = (next: BudgetDataState, reason: string) => {
        reasons.push(reason);
        if (RANK[next] > RANK[state]) state = next;
      };

      const rawQuality = record?.observationQuality ?? snapshot.observationQuality;
      const observationQuality = qualityOf(rawQuality);
      const rawUtilization = record?.[window.utilizationField];
      const reportedReset = record?.[window.resetField];
      const reportedResetMs = epochMs(reportedReset);
      // Provider jitter must not mint a new window identity.
      const resetAt = reportedResetMs === null ? null
        : Math.round(reportedResetMs / RESET_IDENTITY_GRID_MS) * RESET_IDENTITY_GRID_MS;
      const startAt = resetAt === null ? null : resetAt - WINDOW_MS[window.kind];
      const utilization = finiteObserved(rawUtilization) ? rawUtilization : null;

      if (!records.length) raise('unknown', 'lane-absent-from-snapshot');
      else if (!record) raise('invalid', 'duplicate-lane-record');
      if (record) {
        if (observationQuality === 'counts-only') raise('unknown', 'counts-only-no-utilization');
        else if (observationQuality === null) raise('unknown', 'observation-quality-missing-or-unrecognized');
        if (rawUtilization === undefined || rawUtilization === null) raise('unknown', 'missing-utilization');
        else if (utilization === null) raise('invalid', 'utilization-not-a-number');
        else if (utilization < 0 || utilization > 1) raise('invalid', 'utilization-out-of-range');
        if (reportedReset === undefined || reportedReset === null) raise('invalid', 'missing-reset');
        else if (reportedResetMs === null) raise('invalid', 'reset-unparseable');
      }
      if (observedAt === null) raise('invalid', 'missing-observed-at');
      else {
        if (observedAt > input.now) raise('invalid', 'observation-in-future');
        if (resetAt !== null && resetAt <= observedAt) raise('invalid', 'reset-not-after-observation');
        if (resetAt !== null && resetAt - observedAt > WINDOW_MS[window.kind]) raise('invalid', 'reset-beyond-window-length');
      }
      if (record && observationQuality === 'cached') raise('stale', 'cached-observation');
      const tooOld = !!record && observedAt !== null && input.now - observedAt > input.maxAgeMs;
      if (tooOld) raise('stale', 'older-than-max-age');

      const countsOnly = observationQuality === 'counts-only';
      const observation: BudgetWindowObservation = {
        providerId: binding.providerId, poolId: binding.poolId, kind: window.kind,
        startAt, resetAt, observedAt, sourceRevision, schemaRevision,
        unit: UTILIZATION_ONLY_UNIT,
        quota: utilization !== null && !countsOnly ? 1 : null,
        consumed: countsOnly ? null : utilization,
        safetyHeadroom: null, planWeight: null, dataState: state,
      };
      rows.push({
        laneId: binding.laneId, accountId: binding.accountId, poolId: binding.poolId, providerId: binding.providerId,
        windowKind: window.kind, windowId: budgetWindowId(observation), state, reasons,
        observationQuality, utilization: countsOnly ? null : utilization,
        reportedResetAt: reportedResetMs === null ? null : new Date(reportedResetMs).toISOString(),
        resetAt,
        freshness: !record ? 'unobserved' : observationQuality === 'cached' ? 'cached' : tooOld ? 'too-old'
          : observationQuality === 'live' ? 'fresh' : 'unknown',
      });
      windowIds.push(budgetWindowId(observation));

      // Lanes that share a pool describe one window: identical values count once.
      const print = JSON.stringify(observation);
      if (!seen.has(print)) {
        seen.add(print);
        windows.push(observation);
      }
    }
    accounts.push({ accountId: binding.accountId, providerId: binding.providerId, windowIds });
  }

  // Disagreeing observations of one shared pool/kind are never averaged or picked.
  const groupKey = (w: { providerId: string; poolId: string; kind: string }) => JSON.stringify([w.providerId, w.poolId, w.kind]);
  const usable = (state: BudgetDataState) => state === 'known' || state === 'stale';
  const prints = new Map<string, Set<string>>();
  for (const w of windows) {
    if (usable(w.dataState)) prints.set(groupKey(w), new Set([...(prints.get(groupKey(w)) ?? []), JSON.stringify(w)]));
  }
  const conflicted = new Set([...prints].filter(([, group]) => group.size > 1).map(([key]) => key));
  for (const w of windows) if (conflicted.has(groupKey(w)) && usable(w.dataState)) w.dataState = 'invalid';
  for (const row of rows) {
    if (!conflicted.has(groupKey({ providerId: row.providerId, poolId: row.poolId, kind: row.windowKind })) || !usable(row.state)) continue;
    row.state = 'invalid';
    row.reasons.push('conflicting-shared-pool-observations');
  }

  return {
    schema: 'lane-quota-observation-adapter-v1', evidenceKind: input.evidenceKind,
    snapshotObservedAt: observedAt, maxAgeMs: input.maxAgeMs,
    accounts, windows, rows, unmappedLanes, unstableLaneCount, missingLanes,
    limitations: [
      'Utilization fractions are advisory attainment only: no budget, headroom, plan weight or allowed-start claim.',
      'Lane-to-account identity is the committed table, not an observed served account.',
      'Evidence kind is caller-declared; this adapter does not certify provenance or freshness beyond maxAgeMs.',
    ],
  };
}
