import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  UTILIZATION_ONLY_UNIT, budgetWindowId, evaluateBudgets, type EligibleBudgetBinding,
} from '../src/admission-budget.js';
import { COMMITTED_LANE_ACCOUNT_BINDINGS } from '../src/admission-lane-bindings.js';
import {
  RESET_IDENTITY_GRID_MS, adaptLaneQuotaSnapshot, validateLaneAccountBindings,
  type LaneAccountBinding, type LaneQuotaSnapshot,
} from '../src/admission-observation.js';
import { reportAdmissionShadow, reportDecisionAdmissionShadow } from '../src/admission-shadow.js';

// SYNTHETIC: reconstructed from the card text in the real lane-document record
// shape; not a byte copy of the 2026-10-03T02:01Z snapshot.
const SNAPSHOT: LaneQuotaSnapshot = JSON.parse(readFileSync(
  new URL('./fixtures/lane-quota-snapshot.synthetic-2026-10-03T0201Z.json', import.meta.url), 'utf8')).snapshot;
const NOW = Date.parse('2026-10-03T02:01:30Z');
const MAX_AGE = 300_000;
// The committed table already carries the Meta lanes (live-document evidence
// in tests/fixtures/meta-lane-evidence-20261003.json); the suite exercises it
// directly so a drift between the table and the tests cannot hide.
const BINDINGS: LaneAccountBinding[] = [...COMMITTED_LANE_ACCOUNT_BINDINGS];
// Live host telemetry copy (unscoped, NOT a named-cohort acceptance run): the
// eight observed Meta records with the capture provenance.
const META_EVIDENCE = JSON.parse(readFileSync(
  new URL('./fixtures/meta-lane-evidence-20261003.json', import.meta.url), 'utf8')) as {
  provenance: { observedAt: string }; records: Array<Record<string, unknown>> };
const META_OBSERVED_AT = Date.parse(META_EVIDENCE.provenance.observedAt);
const META_SNAPSHOT: LaneQuotaSnapshot = {
  schemaVersion: 1,
  observedAt: META_EVIDENCE.provenance.observedAt,
  staleAfterSeconds: 600,
  records: META_EVIDENCE.records,
};

type Record_ = Record<string, unknown>;
const adapt = (snapshot: LaneQuotaSnapshot = SNAPSHOT, patch: Record_ = {}) => adaptLaneQuotaSnapshot({
  snapshot, now: NOW, maxAgeMs: MAX_AGE, evidenceKind: 'synthetic-replay', bindings: BINDINGS, ...patch,
});
const row = (result: ReturnType<typeof adapt>, laneId: string, kind: 'five-hour' | 'weekly') =>
  result.rows.find(r => r.laneId === laneId && r.windowKind === kind)!;
const patched = (lane: string, patch: Record_): LaneQuotaSnapshot => ({
  ...SNAPSHOT, records: SNAPSHOT.records.map(r => r.lane === lane ? { ...r, ...patch } : r),
});
const without = (lane: string, field: string): LaneQuotaSnapshot => ({
  ...SNAPSHOT, records: SNAPSHOT.records.map(r => {
    if (r.lane !== lane) return r;
    const copy = { ...r };
    delete copy[field];
    return copy;
  }),
});
const freshReport = (result: ReturnType<typeof adapt>, eligibleBindings: EligibleBudgetBinding[] = []) =>
  reportAdmissionShadow({
    enabled: true, cohortId: 'fixture-cohort', accounts: result.accounts, evidenceKind: 'fresh-observations',
    startAt: NOW, endAt: NOW,
    samples: [{ now: NOW, maxAgeMs: MAX_AGE, windows: result.windows, holds: [], eligibleBindings }],
  })!;

describe('lane quota snapshot -> shadow observation adapter', () => {
  it('declares ALL governing windows for every account from the explicit table', () => {
    const result = adapt();
    const windowsOf = (accountId: string) => result.accounts.find(a => a.accountId === accountId)!.windowIds.length;
    expect(windowsOf('claude-acct-1')).toBe(2);
    expect(windowsOf('claude-acct-2')).toBe(2);
    expect(windowsOf('codex-acct-1')).toBe(1);
    expect(windowsOf('zai-acct-1')).toBe(2);
    expect(windowsOf('meta-acct-3')).toBe(2);
    expect(result.accounts).toHaveLength(BINDINGS.length);
    expect(result.windows).toHaveLength(2 * 2 + 3 * 1 + 8 * 2 + 2);
    expect(result.rows.map(r => r.accountId)).not.toContain(undefined);
    expect(result.unmappedLanes).toEqual([]);
    expect(result.missingLanes).toEqual([]);
    expect(result.evidenceKind).toBe('synthetic-replay');
  });

  it('keeps Claude lane-2 weekly (resets 10-03T10:00Z) independent of lane-1 weekly (10-09), absorbing sub-second reset jitter', () => {
    const result = adapt();
    const one = row(result, 'claude-lane-1', 'weekly');
    const two = row(result, 'claude-lane-2', 'weekly');
    expect(two.resetAt).toBe(Date.parse('2026-10-03T10:00:00Z'));
    expect(two.reportedResetAt).toBe('2026-10-03T09:59:59.666Z');
    expect(one.resetAt).toBe(Date.parse('2026-10-09T19:00:00Z'));
    expect(two.windowId).not.toBe(one.windowId);
    const windowOf = (r: typeof one) => result.windows.find(w => budgetWindowId(w) === r.windowId)!;
    expect(windowOf(two)).toMatchObject({ providerId: 'claude', poolId: 'claude-pool-2', kind: 'weekly',
      startAt: Date.parse('2026-10-03T10:00:00Z') - 604_800_000, consumed: 0.93, unit: UTILIZATION_ONLY_UNIT });
    expect(windowOf(one)).toMatchObject({ poolId: 'claude-pool-1', consumed: 0.55 });
    // 5h and weekly are separate governing windows, never merged.
    expect(row(result, 'claude-lane-2', 'five-hour').windowId).not.toBe(two.windowId);
    expect(row(result, 'claude-lane-2', 'five-hour')).toMatchObject({ resetAt: Date.parse('2026-10-03T06:50:00Z'), utilization: 0.18 });
    expect(result.windows.find(w => budgetWindowId(w) === row(result, 'claude-lane-2', 'five-hour').windowId)!.startAt)
      .toBe(Date.parse('2026-10-03T06:50:00Z') - 18_000_000);
  });

  it('snaps reset jitter to a stable window identity but keeps genuinely different resets apart', () => {
    const base = row(adapt(), 'claude-lane-2', 'weekly');
    for (const reset of ['2026-10-03T09:59:59.100Z', '2026-10-03T10:00:00.900Z', '2026-10-03T10:00:00Z']) {
      expect(row(adapt(patched('claude-lane-2', { seven_day_resets_at: reset })), 'claude-lane-2', 'weekly').windowId).toBe(base.windowId);
    }
    const shifted = row(adapt(patched('claude-lane-2', { seven_day_resets_at: '2026-10-03T10:02:00Z' })), 'claude-lane-2', 'weekly');
    expect(shifted.windowId).not.toBe(base.windowId);
    expect(shifted.resetAt! - base.resetAt!).toBe(2 * RESET_IDENTITY_GRID_MS);
  });

  it('keeps eight Meta lanes that share one weekly reset instant per account, never averaged', () => {
    const result = adapt();
    const report = freshReport(result);
    const weekly = [1, 2, 3, 4, 5, 6, 7, 8].map(n => row(result, `meta-lane-${n}`, 'weekly'));
    expect(new Set(weekly.map(r => r.resetAt))).toEqual(new Set([Date.parse('2026-10-05T00:00:00Z')]));
    expect(new Set(weekly.map(r => r.windowId)).size).toBe(8);
    expect(weekly.map(r => r.utilization)).toEqual([0.04, 0.11, 0.27, 0.46, 0.63, 0.81, 0.93, 0.99]);
    const latest = report.evaluations[0]!.windows;
    expect(weekly.map(r => latest.find(w => w.windowId === r.windowId)!.utilization))
      .toEqual([0.04, 0.11, 0.27, 0.46, 0.63, 0.81, 0.93, 0.99]);
    const attainment = (accountId: string, windowId: string) => report.accounts.find(a => a.accountId === accountId)!
      .windows.find(w => w.windowId === windowId)!.attainmentAtLastSample;
    expect(attainment('meta-acct-1', weekly[0]!.windowId)).toBe('underuse');
    expect(attainment('meta-acct-8', weekly[7]!.windowId)).toBe('98-100');
    const fiveHour8 = row(result, 'meta-lane-8', 'five-hour');
    expect(report.accounts.find(a => a.accountId === 'meta-acct-8')!.windows
      .find(w => w.windowId === fiveHour8.windowId)).toMatchObject({ attainmentAtLastSample: '98-100', earlyExhaustionObserved: true });
    expect(JSON.stringify(report)).not.toMatch(/average|fleet/i);
  });

  it('reports the live Meta lane evidence with committed identities and keeps cached meta-lane-4 stale', () => {
    const result = adaptLaneQuotaSnapshot({
      snapshot: META_SNAPSHOT, now: META_OBSERVED_AT + 120_000, maxAgeMs: 600_000,
      evidenceKind: 'synthetic-replay',
    });
    // Default bindings: identity comes only from the committed table.
    expect(result.accounts.map(a => a.accountId)).toEqual(
      COMMITTED_LANE_ACCOUNT_BINDINGS.map(b => b.accountId));
    expect(result.unmappedLanes).toEqual([]);
    // The live capture holds only Meta records: the other committed lanes are absent, not unmapped.
    expect(result.missingLanes).toEqual(
      ['claude-lane-1', 'claude-lane-2', 'codex-lane-1', 'codex-lane-2', 'codex-lane-3', 'zai-lane-1']);
    // Live field names align with the committed Meta bindings.
    expect(row(result, 'meta-lane-2', 'weekly')).toMatchObject({
      state: 'known', freshness: 'fresh', utilization: 0.81,
      resetAt: Date.parse('2026-10-05T00:00:00Z') });
    expect(row(result, 'meta-lane-7', 'weekly')).toMatchObject({ state: 'known', utilization: 0.19 });
    // meta-lane-4 was cached/unavailable at capture: stale, never certified fresh.
    for (const kind of ['five-hour', 'weekly'] as const) {
      expect(row(result, 'meta-lane-4', kind)).toMatchObject({
        state: 'stale', freshness: 'cached', observationQuality: 'cached',
        reasons: expect.arrayContaining(['cached-observation']) });
    }
  });

  it('marks cached Codex observations stale and reports no attainment for them', () => {
    const result = adapt();
    for (const n of [1, 2, 3]) {
      expect(row(result, `codex-lane-${n}`, 'weekly')).toMatchObject({
        state: 'stale', freshness: 'cached', observationQuality: 'cached', reasons: ['cached-observation'] });
    }
    const report = freshReport(result);
    const codex = report.accounts.find(a => a.accountId === 'codex-acct-1')!;
    expect(codex.windows[0]).toMatchObject({ utilizationAtLastSample: null, attainmentAtLastSample: 'unknown' });
    expect(codex.infeasibilityReasons).toContain('allowance-unknown');
    expect(report.evaluations[0]!.windows.find(w => w.windowId === codex.windows[0]!.windowId)!.dataState).toBe('stale');
  });

  it('applies the explicit maxAgeMs inclusively at the boundary', () => {
    const edge = adapt(SNAPSHOT, { now: Date.parse('2026-10-03T02:01:00Z') + MAX_AGE });
    expect(row(edge, 'claude-lane-1', 'weekly')).toMatchObject({ state: 'known', freshness: 'fresh', reasons: [] });
    const past = adapt(SNAPSHOT, { now: Date.parse('2026-10-03T02:01:00Z') + MAX_AGE + 1 });
    expect(row(past, 'claude-lane-1', 'weekly')).toMatchObject({
      state: 'stale', freshness: 'too-old', reasons: ['older-than-max-age'] });
    expect(past.windows.find(w => budgetWindowId(w) === row(past, 'claude-lane-1', 'weekly').windowId)!.dataState).toBe('stale');
  });

  it.each([0, -1, Infinity, NaN, undefined])('requires an explicit finite positive maxAgeMs (%s)', maxAgeMs => {
    expect(() => adapt(SNAPSHOT, { maxAgeMs })).toThrow('invalid-observation-max-age');
  });

  it('rejects an invalid clock and an unknown evidence kind', () => {
    expect(() => adapt(SNAPSHOT, { now: NaN })).toThrow('invalid-observation-clock');
    expect(() => adapt(SNAPSHOT, { now: -1 })).toThrow('invalid-observation-clock');
    expect(() => adapt(SNAPSHOT, { evidenceKind: 'certified' })).toThrow('invalid-observation-evidence-kind');
  });

  it('marks a missing reset invalid with a reason and never substitutes zero', () => {
    const result = adapt(without('claude-lane-2', 'seven_day_resets_at'));
    const weekly = row(result, 'claude-lane-2', 'weekly');
    expect(weekly).toMatchObject({ state: 'invalid', reasons: ['missing-reset'], resetAt: null, reportedResetAt: null });
    const observation = result.windows.find(w => budgetWindowId(w) === weekly.windowId)!;
    expect(observation).toMatchObject({ startAt: null, resetAt: null, dataState: 'invalid' });
    const evaluated = evaluateBudgets({ now: NOW, maxAgeMs: MAX_AGE, windows: [observation], holds: [], eligibleBindings: [] });
    expect(evaluated.windows[0]).toMatchObject({ dataState: 'invalid', utilization: null, safeBudget: null });
    expect(evaluated.windows[0]!.reasons).toContain('missing-resetAt');
    // The sibling five-hour window is judged on its own evidence.
    expect(row(result, 'claude-lane-2', 'five-hour').state).toBe('known');
  });

  it.each([
    ['unparseable', 'tomorrow', 'reset-unparseable'],
    ['offsetless', '2026-10-03T10:00:00', 'reset-unparseable'],
    ['non-string', true, 'reset-unparseable'],
    ['before the observation', '2026-10-03T02:00:00Z', 'reset-not-after-observation'],
    ['at the observation', '2026-10-03T02:01:00Z', 'reset-not-after-observation'],
    ['beyond one window length', '2026-10-10T02:02:00Z', 'reset-beyond-window-length'],
  ])('marks a %s weekly reset invalid', (_name, reset, reason) => {
    const result = adapt(patched('claude-lane-2', { seven_day_resets_at: reset }));
    expect(row(result, 'claude-lane-2', 'weekly')).toMatchObject({ state: 'invalid', reasons: [reason] });
  });

  it('caps numeric epochs above 8.64e15 instead of throwing in toISOString', () => {
    const badClock = adapt({ ...SNAPSHOT, observedAt: 9e15 });
    expect(badClock.snapshotObservedAt).toBeNull();
    expect(badClock.rows.every(r => r.state === 'invalid')).toBe(true);
    expect(badClock.rows[0]!.reasons).toContain('missing-observed-at');
    const badReset = adapt(patched('claude-lane-2', { seven_day_resets_at: 9e15 }));
    expect(row(badReset, 'claude-lane-2', 'weekly')).toMatchObject({
      state: 'invalid', reasons: ['reset-unparseable'], resetAt: null, reportedResetAt: null });
    // Positive control: exactly 8.64e15 is the largest valid instant and parses.
    const capped = adapt({ ...SNAPSHOT, observedAt: 8.64e15 });
    expect(capped.snapshotObservedAt).toBe(8.64e15);
    expect(capped.rows[0]!.reasons).toContain('observation-in-future');
  });

  it('snaps resets within half the grid onto the boundary and keeps resets outside it apart', () => {
    const base = row(adapt(), 'claude-lane-2', 'weekly');
    const near = row(adapt(patched('claude-lane-2', { seven_day_resets_at: '2026-10-03T09:59:31Z' })), 'claude-lane-2', 'weekly');
    expect(near.windowId).toBe(base.windowId);
    expect(near.reportedResetAt).toBe('2026-10-03T09:59:31.000Z');
    const far = row(adapt(patched('claude-lane-2', { seven_day_resets_at: '2026-10-03T09:59:29Z' })), 'claude-lane-2', 'weekly');
    expect(far.windowId).not.toBe(base.windowId);
  });

  it('keeps a reset exactly one window ahead valid and flags a future observation', () => {
    const exact = adapt(patched('claude-lane-2', { seven_day_resets_at: '2026-10-10T02:01:00Z' }));
    expect(row(exact, 'claude-lane-2', 'weekly').state).toBe('known');
    const future = adapt(SNAPSHOT, { now: Date.parse('2026-10-03T02:00:59Z') });
    expect(row(future, 'claude-lane-1', 'weekly')).toMatchObject({ state: 'invalid', reasons: ['observation-in-future'] });
    expect(adapt({ ...SNAPSHOT, observedAt: 'yesterday' }).rows.every(r => r.state === 'invalid')).toBe(true);
    expect(adapt({ ...SNAPSHOT, observedAt: 'yesterday' }).rows[0]!.reasons).toContain('missing-observed-at');
  });

  it('never substitutes zero for missing or malformed utilization', () => {
    const missing = adapt(without('zai-lane-1', 'weekly_utilization'));
    const weekly = row(missing, 'zai-lane-1', 'weekly');
    expect(weekly).toMatchObject({ state: 'unknown', reasons: ['missing-utilization'], utilization: null });
    expect(missing.windows.find(w => budgetWindowId(w) === weekly.windowId)).toMatchObject({ quota: null, consumed: null });
    expect(adapt(patched('zai-lane-1', { weekly_utilization: null })).rows
      .find(r => r.laneId === 'zai-lane-1' && r.windowKind === 'weekly')!.state).toBe('unknown');
    for (const bad of ['0.4', NaN, 1.01, -0.01]) {
      const result = adapt(patched('zai-lane-1', { weekly_utilization: bad }));
      expect(row(result, 'zai-lane-1', 'weekly').state).toBe('invalid');
    }
    expect(row(adapt(patched('zai-lane-1', { weekly_utilization: '0.4' })), 'zai-lane-1', 'weekly').reasons)
      .toEqual(['utilization-not-a-number']);
    expect(row(adapt(patched('zai-lane-1', { weekly_utilization: 1.01 })), 'zai-lane-1', 'weekly').reasons)
      .toEqual(['utilization-out-of-range']);
    expect(row(adapt(patched('zai-lane-1', { weekly_utilization: 1 })), 'zai-lane-1', 'weekly').state).toBe('known');
    expect(row(adapt(patched('zai-lane-1', { weekly_utilization: 0 })), 'zai-lane-1', 'weekly')).toMatchObject({
      state: 'known', utilization: 0 });
  });

  it('turns counts-only and unlabelled observations into unknown allowance, not quota', () => {
    const counts = adapt(patched('zai-lane-1', { observationQuality: 'counts-only', weekly_utilization: 0.9 }));
    expect(row(counts, 'zai-lane-1', 'weekly')).toMatchObject({
      state: 'unknown', reasons: ['counts-only-no-utilization'], utilization: null });
    expect(counts.windows.find(w => budgetWindowId(w) === row(counts, 'zai-lane-1', 'weekly').windowId))
      .toMatchObject({ quota: null, consumed: null });
    for (const quality of [undefined, 'maybe-live', 'LIVE']) {
      const result = adapt(patched('zai-lane-1', { observationQuality: quality }));
      expect(row(result, 'zai-lane-1', 'weekly')).toMatchObject({
        state: 'unknown', reasons: ['observation-quality-missing-or-unrecognized'], observationQuality: null });
    }
    const snapshotLevel = adapt({ ...SNAPSHOT, observationQuality: 'live',
      records: SNAPSHOT.records.map(({ observationQuality: _quality, ...rest }) => rest) });
    expect(row(snapshotLevel, 'zai-lane-1', 'weekly').state).toBe('known');
  });

  it('takes identity only from the committed table: unmapped, unstable and absent lanes are never invented', () => {
    const extra = { ...SNAPSHOT, records: [...SNAPSHOT.records,
      { lane: 'newlane-9', observationQuality: 'live', weekly_utilization: 0.1, weekly_resets_at: '2026-10-05T00:00:00Z' },
      { lane: 'someone@example.com', observationQuality: 'live' }, { lane: 'record-3' }, { lane: 'Display Name' }, { lane: 7 }, {},
    ] };
    const result = adapt(extra);
    expect(result.unmappedLanes).toEqual(['newlane-9']);
    expect(result.unstableLaneCount).toBe(5);
    expect(result.accounts.map(a => a.accountId)).not.toContain('newlane-9');
    expect(JSON.stringify(result)).not.toContain('example.com');
    const missing = adapt({ ...SNAPSHOT, records: SNAPSHOT.records.filter(r => r.lane !== 'meta-lane-4') });
    expect(missing.missingLanes).toEqual(['meta-lane-4']);
    expect(row(missing, 'meta-lane-4', 'weekly')).toMatchObject({
      state: 'unknown', reasons: ['lane-absent-from-snapshot'], freshness: 'unobserved', utilization: null });
    expect(missing.accounts.find(a => a.accountId === 'meta-acct-4')!.windowIds).toHaveLength(2);
    const duplicate = adapt({ ...SNAPSHOT, records: [...SNAPSHOT.records, SNAPSHOT.records[0]!] });
    expect(row(duplicate, 'claude-lane-1', 'weekly')).toMatchObject({ state: 'invalid', reasons: ['duplicate-lane-record'] });
    expect(duplicate.missingLanes).toEqual([]);
  });

  it('reads only whitelisted record fields and copies none of the rest', () => {
    const noisy = patched('claude-lane-1', { email: 'person@example.com', apiKey: 'sk-secret-value', display: 'Pat P.' });
    const serialized = JSON.stringify(adapt(noisy));
    for (const secret of ['person@example.com', 'sk-secret-value', 'Pat P.']) expect(serialized).not.toContain(secret);
  });

  it('counts a shared pool once and refuses to pick between disagreeing observations', () => {
    const committedMeta = (laneId: string): LaneAccountBinding =>
      ({ ...COMMITTED_LANE_ACCOUNT_BINDINGS.find(b => b.laneId === laneId)!, poolId: 'meta-shared' });
    const shared: LaneAccountBinding[] = [committedMeta('meta-lane-1'), committedMeta('meta-lane-2')];
    const aligned = SNAPSHOT.records.map(r => r.lane === 'meta-lane-2'
      ? { ...r, five_hour_utilization: 0, five_hour_resets_at: SNAPSHOT.records.find(x => x.lane === 'meta-lane-1')!.five_hour_resets_at,
        weekly_utilization: 0.04 } : r);
    const once = adapt({ ...SNAPSHOT, records: aligned.map(r => r.lane === 'meta-lane-1' ? { ...r, five_hour_utilization: 0 } : r) },
      { bindings: shared });
    expect(once.windows).toHaveLength(2);
    const [first, second] = once.accounts;
    expect(second!.windowIds).toEqual(first!.windowIds);
    expect(once.rows.every(r => r.state === 'known')).toBe(true);
    // Different utilization of the SAME pool/window: neither is chosen, nothing is averaged.
    const disagree = adapt({ ...SNAPSHOT, records: aligned.map(r => r.lane === 'meta-lane-2' ? { ...r, weekly_utilization: 0.5 } : r) },
      { bindings: shared });
    const weekly = disagree.rows.filter(r => r.windowKind === 'weekly');
    expect(weekly.map(r => r.state)).toEqual(['invalid', 'invalid']);
    expect(weekly.every(r => r.reasons.includes('conflicting-shared-pool-observations'))).toBe(true);
    expect(disagree.windows.filter(w => w.kind === 'weekly').every(w => w.dataState === 'invalid')).toBe(true);
    expect(disagree.rows.filter(r => r.windowKind === 'five-hour').every(r => r.state === 'known' || r.state === 'invalid')).toBe(true);
  });

  it('does not mutate its input and is deterministic', () => {
    const before = structuredClone(SNAPSHOT);
    const tableBefore = structuredClone(BINDINGS);
    expect(JSON.stringify(adapt())).toBe(JSON.stringify(adapt()));
    expect(SNAPSHOT).toEqual(before);
    expect(BINDINGS).toEqual(tableBefore);
  });
});

describe('committed lane/account table validation', () => {
  it('validates the committed table and the test table', () => {
    expect(() => validateLaneAccountBindings(COMMITTED_LANE_ACCOUNT_BINDINGS)).not.toThrow();
    expect(() => validateLaneAccountBindings(BINDINGS)).not.toThrow();
    expect(COMMITTED_LANE_ACCOUNT_BINDINGS.every(b => !/record-\d+|@/.test(`${b.accountId}${b.laneId}${b.poolId}`))).toBe(true);
  });

  const one = COMMITTED_LANE_ACCOUNT_BINDINGS[0]!;
  const two = COMMITTED_LANE_ACCOUNT_BINDINGS[1]!;
  it.each([
    ['an empty table', [], 'invalid-lane-binding-table-size'],
    ['an oversized table', Array.from({ length: 65 }, (_, n) => ({ ...one, laneId: `l${n}`, accountId: `a${n}`, poolId: `p${n}` })), 'invalid-lane-binding-table-size'],
    ['a record-N account', [{ ...one, accountId: 'record-1' }], 'unstable-lane-binding-identity'],
    ['a record-N lane', [{ ...one, laneId: 'record-1' }], 'unstable-lane-binding-identity'],
    ['an email account', [{ ...one, accountId: 'person@example.com' }], 'unstable-lane-binding-identity'],
    ['a display-name pool', [{ ...one, poolId: 'Pat Pool' }], 'unstable-lane-binding-identity'],
    ['a duplicate lane', [one, { ...two, laneId: one.laneId }], 'duplicate-lane-binding'],
    ['a duplicate account', [one, { ...two, accountId: one.accountId }], 'duplicate-account-binding'],
    ['no windows', [{ ...one, windows: [] }], 'invalid-lane-binding-windows'],
    ['a repeated window kind', [{ ...one, windows: [one.windows[0]!, one.windows[0]!] }], 'invalid-lane-binding-windows'],
    ['an unsupported window kind', [{ ...one, windows: [{ ...one.windows[0]!, kind: 'monthly' }] }], 'invalid-lane-binding-windows'],
    ['a missing field name', [{ ...one, windows: [{ ...one.windows[0]!, resetField: '' }] }], 'invalid-lane-binding-windows'],
    ['a shared pool across providers', [one, { ...two, poolId: one.poolId, providerId: 'other' }], 'inconsistent-shared-pool'],
    ['a shared pool with different windows', [one, { ...two, poolId: one.poolId, windows: [one.windows[0]!] }], 'inconsistent-shared-pool'],
  ] as Array<[string, LaneAccountBinding[], string]>)('rejects %s', (_name, table, error) => {
    expect(() => validateLaneAccountBindings(table)).toThrow(error);
  });
});

describe('utilization-only observations are advisory attainment, never budget', () => {
  it('reports attainment, no safe budget, rates or start claim, even for a binding with a fraction-unit estimate', () => {
    const result = adapt();
    const target = row(result, 'claude-lane-2', 'weekly');
    const evaluatedWindows = result.windows;
    const binding: EligibleBudgetBinding = {
      bindingKey: 'opaque-claude-2', lane: 'cliproxy-claude', accountId: 'claude-acct-2', providerId: 'claude',
      windowIds: result.accounts.find(a => a.accountId === 'claude-acct-2')!.windowIds, canStart: true,
      activeSlots: 0, maxSlots: 4, cooldownUntil: null,
      estimate: { revision: 'fixture', durationMs: 1000, windows: result.accounts.find(a => a.accountId === 'claude-acct-2')!.windowIds
        .map(windowId => ({ windowId, unit: UTILIZATION_ONLY_UNIT, upperBurn: 0.0001, burnPerMs: 0.00000001, remainingDemandBurn: 0.5 })) },
    };
    const evaluation = evaluateBudgets({ now: NOW, maxAgeMs: MAX_AGE, windows: evaluatedWindows, holds: [
      { windowId: target.windowId, unit: UTILIZATION_ONLY_UNIT, amount: 0.5 }], eligibleBindings: [binding] });
    const window = evaluation.windows.find(w => w.windowId === target.windowId)!;
    expect(window).toMatchObject({ dataState: 'known', utilization: 0.93, safeBudget: null, reserved: null,
      targetRatePerMs: null, sustainableRatePerMs: null });
    expect(window.reasons).toEqual(['utilization-only-no-budget']);
    expect(window.elapsedFraction).toBeGreaterThan(0);
    expect(evaluation.bindings[0]).toMatchObject({ proposal: 'unknown', allowedStarts: null, integerConcurrency: null,
      nextEligibleStartAt: null });
    expect(evaluation.bindings[0]!.reasons).toContain('allowance-unknown');
    expect(evaluation.bindings[0]!.targetInfeasibility).toContain('allowance-unknown');
  });

  it('requires neither headroom nor plan weight for a utilization-only window, but still validates what is present', () => {
    const observation = adapt().windows[0]!;
    expect(observation).toMatchObject({ safetyHeadroom: null, planWeight: null });
    const run = (patch: object) => evaluateBudgets({ now: NOW, maxAgeMs: MAX_AGE, windows: [{ ...observation, ...patch }],
      holds: [], eligibleBindings: [] }).windows[0]!;
    expect(run({}).dataState).toBe('known');
    expect(run({ safetyHeadroom: -1 }).dataState).toBe('invalid');
    expect(run({ planWeight: 0 }).dataState).toBe('invalid');
    // A real-unit window still needs both.
    expect(run({ unit: 'allowance' }).dataState).toBe('unknown');
    expect(run({ unit: 'allowance' }).reasons).toEqual(expect.arrayContaining(['missing-safetyHeadroom', 'missing-planWeight']));
  });

  it('never lets an unknown start downgrade a source-declared invalid observation', () => {
    const observation = { ...adapt().windows[0]!, startAt: null, dataState: 'invalid' as const };
    const evaluated = evaluateBudgets({ now: NOW, maxAgeMs: MAX_AGE, windows: [observation], holds: [], eligibleBindings: [] });
    expect(evaluated.windows[0]!.dataState).toBe('invalid');
    expect(evaluated.windows[0]!.reasons).toEqual(expect.arrayContaining(['source-invalid', 'missing-startAt']));
  });

  it('labels the report as shadow-only, caller-declared and unproven, with per-window provenance rows', () => {
    const report = freshReport(adapt());
    expect(report).toMatchObject({ mode: 'shadow-only', governsHostStarts: false, claimsReservations: false,
      selectedOrServedAccount: null, evidenceKind: 'fresh-observations', productionEvidenceCertified: false,
      completeWindowValidation: 'unproven', freshObservationValidation: 'unproven' });
    expect(report.accounts.every(a => a.infeasibilityReasons.includes('allowance-unknown'))).toBe(true);
    expect(report.accounts.every(a => a.proposalCounts.admit === 0)).toBe(true);
    expect(report.evaluations[0]!.windows.filter(w => w.dataState === 'known').every(w => w.safeBudget === null)).toBe(true);
  });
});

describe('decision report caller path', () => {
  const eligible = [{ modelId: 'model-a', lane: 'cliproxy-claude' }];
  const input = (extra: Record_ = {}) => ({
    enabled: true, cohortId: 'fixture-cohort', maxAgeMs: MAX_AGE, laneQuotaSnapshot: SNAPSHOT, ...extra,
  });
  const claudeBinding = (windowIds: string[] | null) => ({ modelId: 'model-a', binding: {
    bindingKey: 'opaque', lane: 'cliproxy-claude', accountId: 'claude-acct-1', providerId: 'claude', windowIds,
    canStart: true, activeSlots: 0, maxSlots: 1, cooldownUntil: null, estimate: null,
  } });

  it('stays off unless explicitly enabled and is a true no-op when disabled', () => {
    expect(reportDecisionAdmissionShadow(input({ enabled: false }) as never, NOW, eligible)).toBeNull();
    expect(() => reportDecisionAdmissionShadow(input({ enabled: undefined }) as never, NOW, eligible)).toThrow();
  });

  it('derives accounts and windows from the committed table and attaches the provenance rows', () => {
    // The committed table carries the Meta lanes from live-document evidence,
    // and the synthetic snapshot covers every committed lane: nothing unmapped, nothing missing.
    const report = reportDecisionAdmissionShadow(input() as never, NOW, eligible)!;
    expect(report.accounts.map(a => a.accountId)).toEqual(COMMITTED_LANE_ACCOUNT_BINDINGS.map(b => b.accountId));
    expect(report.observationAdapter).toMatchObject({ schema: 'lane-quota-observation-adapter-v1',
      evidenceKind: 'fresh-observations', snapshotObservedAt: Date.parse('2026-10-03T02:01:00Z'), maxAgeMs: MAX_AGE,
      unstableLaneCount: 0, missingLanes: [] });
    expect(report.observationAdapter!.unmappedLanes).toEqual([]);
    expect(report.observationAdapter!.rows).toHaveLength(2 * 2 + 3 + 2 + 8 * 2);
    expect(report.limitations.join(' ')).toContain('advisory attainment only');
    expect(report.accounts.every(a => a.infeasibilityReasons.includes('no-observed-eligible-account-binding'))).toBe(true);
  });

  it('never admits a supplied binding from utilization-only data and rejects ambiguous inputs', () => {
    const report = reportDecisionAdmissionShadow(input({ bindings: [claudeBinding(null)] }) as never, NOW, eligible)!;
    const binding = report.evaluations[0]!.bindings[0]!;
    expect(binding.proposal).toBe('unknown');
    expect(binding.allowedStarts).toBeNull();
    expect(report.accounts.find(a => a.accountId === 'claude-acct-1')!.proposalCounts).toEqual({ admit: 0, defer: 0, unknown: 1 });
    expect(() => reportDecisionAdmissionShadow(input({ accounts: [] }) as never, NOW, eligible)).toThrow('unexpected-shadow-input-fields');
    expect(() => reportDecisionAdmissionShadow(input({ windows: [] }) as never, NOW, eligible)).toThrow('unexpected-shadow-input-fields');
    expect(() => reportDecisionAdmissionShadow(input({ laneQuotaSnapshot: { ...SNAPSHOT, accessToken: 'x' } }) as never, NOW, eligible))
      .toThrow('unexpected-shadow-input-fields');
    expect(() => reportDecisionAdmissionShadow(input({ maxAgeMs: undefined }) as never, NOW, eligible)).toThrow('invalid-observation-max-age');
  });

  it('keeps stale and invalid windows out of the attainment numbers', () => {
    const snapshot = patched('claude-lane-2', { seven_day_resets_at: undefined });
    const report = reportDecisionAdmissionShadow(input({ laneQuotaSnapshot: snapshot }) as never, NOW, eligible)!;
    const rows = report.observationAdapter!.rows;
    expect(rows.find(r => r.laneId === 'claude-lane-2' && r.windowKind === 'weekly')).toMatchObject({
      state: 'invalid', reasons: ['missing-reset'] });
    expect(rows.filter(r => r.state === 'stale').map(r => r.laneId)).toEqual(['codex-lane-1', 'codex-lane-2', 'codex-lane-3']);
    const account = report.accounts.find(a => a.accountId === 'claude-acct-2')!;
    expect(account.windows.map(w => w.attainmentAtLastSample).sort()).toEqual(['underuse', 'unknown']);
  });
});
