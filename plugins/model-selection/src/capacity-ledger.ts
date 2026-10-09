/**
 * Durable aggregate reservation ledger — .
 *
 * First mergeable slice of the  "durable store" contract (plan rev 7):
 * one aggregate compare-and-swap (CAS) per allocation domain, executed as a
 * single conditional UPDATE and validated in agent-testdb/CI only.
 *
 * What this is:
 * - One ledger row per (tenant, allocation domain) holds every governing
 *   window's counters, the slot count, per-window reconciliation watermarks
 *   and the attempt journal. A reservation debits ALL its windows in ONE
 *   UPDATE, so multi-window admission is all-or-none by construction.
 * - The writer pins the read version, the fencing epoch and the trusted
 *   tenant identity in the WHERE clause. A stale/controller-superseded writer
 *   or a cross-tenant writer matches zero rows and changes nothing.
 * - `ctx.db.execute` returns only `{ rowCount }`, never rows. The driver
 *   treats `1` as won and `0` as "read back and classify": our fingerprint
 *   present means a prior/lost response already won (ambiguous-response
 *   recovery); absent means safe to retry the SAME idempotency key; a
 *   different fingerprint means payload mismatch. A timeout NEVER mints a
 *   fresh permit.
 * - The driver is stateless: every decision starts from a row read, so a
 *   restarted worker recovers by reading. Allowance is never refunded by TTL
 *   expiry; only never-started work releases, and only trusted, watermarked
 *   reconciliation reduces a held debit (charged outcomes stay charged).
 *
 * What this is NOT:
 * - Not a migration, not a live writer, not enforcement. DDL here is the
 *   test/proof artifact; runtime migration, grants and any production
 *   cutover need their own reviewed path.
 * - Not a second admission evaluator. Debit vectors come from the accepted
 *   pure evaluator (`admission-budget.ts`); see `debitsFromBudgetBinding`.
 *   The in-memory `AdmissionSimulator` remains a simulation-only fixture and
 *   must not be promoted to storage.
 *
 * Runtime SQL limits respected (per the  capacity-evidence survey):
 * exactly one statement per call, single SELECT or INSERT/UPDATE/DELETE,
 * `$n` binds only, no BEGIN/COMMIT, no multi-statement batch, no mutation
 * CTE. Table namespace is a validated identifier, never interpolated input.
 */

import type {
  BudgetEvaluation,
  EligibleBudgetBinding,
} from './admission-budget.js';

/** Minimal plugin `ctx.db` surface the ledger needs. */
export interface LedgerDb {
  query(sql: string, params: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  execute(sql: string, params: unknown[]): Promise<{ rowCount: number }>;
}

export type LedgerOutcome =
  | 'held'
  | 'committed'
  | 'reconciled'
  | 'cancelled-before-start';

export interface LedgerWindowDebit {
  windowId: string;
  unit: string;
  /** Upper-bound burn in the window's native units (evaluator `upperBurn`). */
  amount: number;
  /** `reserved` observed at `readVersion`; the CAS pins this exact value. */
  readReserved: number;
}

export interface LedgerAttempt {
  idempotencyKey: string;
  bindingKey: string;
  estimateRevision: string;
  durationMs: number;
  debits: LedgerWindowDebit[];
}

export interface LedgerReservation {
  idempotencyKey: string;
  outcome: LedgerOutcome;
  version: number;
}

export type ReserveStatus =
  | 'held'
  | 'deferred'
  | 'replayed-identical'
  | 'payload-mismatch'
  | 'fenced'
  | 'lost'
  | 'unknown-retry-same-key'
  | 'won-after-ambiguity';

export interface ReserveResult {
  status: ReserveStatus;
  reasons: string[];
  reservation: LedgerReservation | null;
  version: number | null;
}

const MAX_DEBITS_PER_RESERVE = 16;
const MAX_KEY_LEN = 256;
// Release residue allowance in EPSILON x magnitude, sized above simulated 10^5-operation churn.
const RELEASE_RESIDUE_EPSILONS = 1024;

const NAMESPACE_RE = /^[a-z][a-z0-9_]{0,62}$/;
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

function fail(reason: string): never {
  throw new Error(reason);
}

function checkId(value: unknown, what: string): string {
  if (typeof value !== 'string' || !ID_RE.test(value)) fail(`invalid-${what}`);
  return value;
}

function checkKey(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_KEY_LEN) {
    fail(`invalid-${what}`);
  }
  return value;
}

function checkNonnegative(n: unknown, what: string): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) fail(`invalid-${what}`);
  return n;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** Attempt fingerprint: binds an idempotency key to one exact payload. */
export function fingerprintAttempt(attempt: LedgerAttempt): string {
  return stableJson({
    bindingKey: attempt.bindingKey,
    debits: [...attempt.debits]
      .sort((a, b) => (a.windowId < b.windowId ? -1 : 1))
      .map(d => [d.windowId, d.unit, d.amount]),
    duration_ms: attempt.durationMs,
    estimateRevision: attempt.estimateRevision,
  });
}

export function ledgerTable(namespace: string): string {
  if (!NAMESPACE_RE.test(namespace)) fail('invalid-ledger-namespace');
  return `${namespace}.capacity_ledger`;
}

/** Test/proof DDL only. Runtime migration needs its own reviewed path. */
export function ledgerDdl(namespace: string): string {
  const table = ledgerTable(namespace);
  return `CREATE TABLE IF NOT EXISTS ${table} (` +
    `tenant_id TEXT NOT NULL, ` +
    `domain_key TEXT NOT NULL, ` +
    `version BIGINT NOT NULL DEFAULT 0, ` +
    `fencing_epoch BIGINT NOT NULL DEFAULT 0, ` +
    `slot_max INTEGER NOT NULL DEFAULT 0, ` +
    `slots_held INTEGER NOT NULL DEFAULT 0, ` +
    `windows JSONB NOT NULL DEFAULT '{}', ` +
    `attempts JSONB NOT NULL DEFAULT '{}', ` +
    `watermarks JSONB NOT NULL DEFAULT '{}', ` +
    `PRIMARY KEY (tenant_id, domain_key))`;
}

export function ledgerReadSql(namespace: string): string {
  const table = ledgerTable(namespace);
  return `SELECT tenant_id, domain_key, version, fencing_epoch, slot_max, slots_held, ` +
    `windows, attempts, watermarks FROM ${table} WHERE tenant_id = $1 AND domain_key = $2`;
}

export function ledgerSeedSql(namespace: string): string {
  const table = ledgerTable(namespace);
  return `INSERT INTO ${table} ` +
    `(tenant_id, domain_key, fencing_epoch, slot_max, windows, attempts, watermarks) ` +
    `VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`;
}

export interface ReserveStatement {
  sql: string;
  params: unknown[];
}

/**
 * One conditional UPDATE reserving every debit window atomically.
 *
 * Server-side predicates (all must hold for the single row to update):
 * tenant + domain + read version + fencing epoch, attempt key absent,
 * slot headroom, and per window: key present, unit match, no reset
 * crossover at `$now + duration`, sufficiency against CURRENT counters,
 * and `reserved` still equal to the read value.
 */
export function buildReserveStatement(
  namespace: string,
  tenantId: string,
  domainKey: string,
  readVersion: number,
  fencingEpoch: number,
  nowMs: number,
  attempt: LedgerAttempt,
  nextVersion: number,
  nextWindowsJson: string,
  nextAttemptsJson: string,
  nextSlotsHeld: number,
): ReserveStatement {
  const table = ledgerTable(namespace);
  checkId(tenantId, 'tenant-id');
  checkKey(domainKey, 'domain-key');
  checkKey(attempt.idempotencyKey, 'idempotency-key');
  if (!Number.isSafeInteger(readVersion) || readVersion < 0) fail('invalid-read-version');
  if (!Number.isSafeInteger(fencingEpoch) || fencingEpoch < 0) fail('invalid-fencing-epoch');
  if (!Number.isSafeInteger(nextVersion) || nextVersion !== readVersion + 1) fail('invalid-next-version');
  if (!Number.isFinite(nowMs) || nowMs < 0) fail('invalid-now');
  if (!Number.isSafeInteger(nextSlotsHeld) || nextSlotsHeld < 0) fail('invalid-next-slots');
  if (attempt.debits.length === 0 || attempt.debits.length > MAX_DEBITS_PER_RESERVE) {
    fail('invalid-debit-count');
  }
  if (!Number.isSafeInteger(attempt.durationMs) || attempt.durationMs <= 0) fail('invalid-duration');

  const params: unknown[] = [tenantId, domainKey, readVersion, fencingEpoch, attempt.idempotencyKey];
  let i = params.length;
  const clauses: string[] = [
    `tenant_id = $1`,
    `domain_key = $2`,
    `version = $3`,
    `fencing_epoch = $4`,
    `NOT (attempts ? $5)`,
    `slots_held + 1 <= slot_max`,
  ];
  for (const d of attempt.debits) {
    checkKey(d.windowId, 'window-id');
    if (typeof d.unit !== 'string' || d.unit.trim().length === 0) fail('invalid-window-unit');
    checkNonnegative(d.amount, 'debit-amount');
    if (d.amount <= 0) fail('invalid-debit-amount');
    checkNonnegative(d.readReserved, 'read-reserved');
    const wId = `$${++i}`;
    const unit = `$${++i}`;
    const amount = `$${++i}`;
    const readReserved = `$${++i}`;
    const deadline = `$${++i}`;
    params.push(d.windowId, d.unit, d.amount, d.readReserved, nowMs + attempt.durationMs);
    clauses.push(
      `(windows -> ${wId} IS NOT NULL)`,
      `(windows -> ${wId} ->> 'unit') = ${unit}`,
      `${deadline} < ((windows -> ${wId} ->> 'reset_at')::bigint)`,
      `((windows -> ${wId} ->> 'reserved')::numeric) = (${readReserved})::numeric`,
      `((windows -> ${wId} ->> 'reserved')::numeric) + (${amount})::numeric <= ` +
        `((windows -> ${wId} ->> 'quota')::numeric) - ` +
        `((windows -> ${wId} ->> 'consumed')::numeric) - ` +
        `((windows -> ${wId} ->> 'safety_headroom')::numeric)`,
    );
  }
  const windowsJson = `$${++i}`;
  const attemptsJson = `$${++i}`;
  const slotsHeld = `$${++i}`;
  const versionParam = `$${++i}`;
  params.push(nextWindowsJson, nextAttemptsJson, nextSlotsHeld, nextVersion);
  const sql =
    `UPDATE ${table} SET windows = ${windowsJson}::jsonb, ` +
    `attempts = ${attemptsJson}::jsonb, slots_held = ${slotsHeld}, version = ${versionParam} ` +
    `WHERE ${clauses.join(' AND ')}`;
  return { sql, params };
}

export function buildCommitStatement(
  namespace: string,
  tenantId: string,
  domainKey: string,
  readVersion: number,
  fencingEpoch: number,
  nowMs: number,
  idempotencyKey: string,
  fingerprint: string,
  debitWindowIds: string[],
  nextAttemptsJson: string,
): ReserveStatement {
  const table = ledgerTable(namespace);
  checkId(tenantId, 'tenant-id');
  checkKey(domainKey, 'domain-key');
  checkKey(idempotencyKey, 'idempotency-key');
  if (debitWindowIds.length === 0 || debitWindowIds.length > MAX_DEBITS_PER_RESERVE) fail('invalid-debit-count');
  const params: unknown[] = [tenantId, domainKey, readVersion, fencingEpoch, idempotencyKey, fingerprint, nowMs];
  let i = params.length;
  const clauses = [
    `tenant_id = $1`,
    `domain_key = $2`,
    `version = $3`,
    `fencing_epoch = $4`,
    `(attempts -> $5 ->> 'fingerprint') = $6`,
    `(attempts -> $5 ->> 'outcome') = 'held'`,
  ];
  for (const wid of debitWindowIds) {
    checkKey(wid, 'window-id');
    const wId = `$${++i}`;
    params.push(wid);
    clauses.push(
      `($7 + ((attempts -> $5 ->> 'duration_ms')::bigint) < ((windows -> ${wId} ->> 'reset_at')::bigint))`,
    );
  }
  const attemptsJson = `$${++i}`;
  params.push(nextAttemptsJson);
  const sql =
    `UPDATE ${table} SET attempts = ${attemptsJson}::jsonb, version = version + 1 ` +
    `WHERE ${clauses.join(' AND ')}`;
  return { sql, params };
}

export function buildCancelStatement(
  namespace: string,
  tenantId: string,
  domainKey: string,
  readVersion: number,
  fencingEpoch: number,
  idempotencyKey: string,
  fingerprint: string,
  nextWindowsJson: string,
  nextAttemptsJson: string,
): ReserveStatement {
  const table = ledgerTable(namespace);
  checkId(tenantId, 'tenant-id');
  checkKey(domainKey, 'domain-key');
  checkKey(idempotencyKey, 'idempotency-key');
  const params: unknown[] = [
    tenantId, domainKey, readVersion, fencingEpoch, idempotencyKey, fingerprint,
    nextWindowsJson, nextAttemptsJson,
  ];
  const sql =
    `UPDATE ${table} SET windows = $7::jsonb, attempts = $8::jsonb, ` +
    `slots_held = slots_held - 1, version = version + 1 ` +
    `WHERE tenant_id = $1 AND domain_key = $2 AND version = $3 AND fencing_epoch = $4 ` +
    `AND (attempts -> $5 ->> 'fingerprint') = $6 ` +
    `AND (attempts -> $5 ->> 'outcome') = 'held' AND slots_held > 0`;
  return { sql, params };
}

export function buildFinishStatement(
  namespace: string,
  tenantId: string,
  domainKey: string,
  readVersion: number,
  fencingEpoch: number,
  idempotencyKey: string,
  fingerprint: string,
  nextAttemptsJson: string,
): ReserveStatement {
  const table = ledgerTable(namespace);
  checkId(tenantId, 'tenant-id');
  checkKey(domainKey, 'domain-key');
  checkKey(idempotencyKey, 'idempotency-key');
  const params: unknown[] = [
    tenantId, domainKey, readVersion, fencingEpoch, idempotencyKey, fingerprint, nextAttemptsJson,
  ];
  // Frees the slot only and journals the release on the attempt. Held
  // allowance stays held: a finished attempt may still be charged, so only
  // trusted reconciliation reduces it. The slot_released predicate makes a
  // retried or concurrent second finish match zero rows instead of
  // double-freeing the slot.
  const sql =
    `UPDATE ${table} SET slots_held = slots_held - 1, attempts = $7::jsonb, version = version + 1 ` +
    `WHERE tenant_id = $1 AND domain_key = $2 AND version = $3 AND fencing_epoch = $4 ` +
    `AND (attempts -> $5 ->> 'fingerprint') = $6 ` +
    `AND (attempts -> $5 ->> 'outcome') IN ('committed', 'reconciled') ` +
    `AND COALESCE(((attempts -> $5 ->> 'slot_released')::boolean), false) = false ` +
    `AND slots_held > 0`;
  return { sql, params };
}

export function buildReconcileStatement(
  namespace: string,
  tenantId: string,
  domainKey: string,
  readVersion: number,
  fencingEpoch: number,
  idempotencyKey: string,
  fingerprint: string,
  windowId: string,
  reconciliationId: string,
  reflectedAmount: number,
  consumedNow: number,
  watermark: number,
  nextWindowsJson: string,
  nextAttemptsJson: string,
  nextWatermarksJson: string,
): ReserveStatement {
  const table = ledgerTable(namespace);
  checkId(tenantId, 'tenant-id');
  checkKey(domainKey, 'domain-key');
  checkKey(idempotencyKey, 'idempotency-key');
  checkKey(windowId, 'window-id');
  checkKey(reconciliationId, 'reconciliation-id');
  checkNonnegative(reflectedAmount, 'reflected-amount');
  checkNonnegative(consumedNow, 'consumed-now');
  if (!Number.isSafeInteger(watermark) || watermark <= 0) fail('invalid-watermark');
  const params: unknown[] = [
    tenantId, domainKey, readVersion, fencingEpoch, idempotencyKey, fingerprint,
    windowId, reconciliationId, reflectedAmount, consumedNow, watermark,
    nextWindowsJson, nextAttemptsJson, nextWatermarksJson,
  ];
  const sql =
    `UPDATE ${table} SET windows = $12::jsonb, attempts = $13::jsonb, watermarks = $14::jsonb, ` +
    `version = version + 1 ` +
    `WHERE tenant_id = $1 AND domain_key = $2 AND version = $3 AND fencing_epoch = $4 ` +
    `AND (attempts -> $5 ->> 'fingerprint') = $6 ` +
    `AND (attempts -> $5 ->> 'outcome') IN ('committed', 'reconciled') ` +
    `AND NOT (COALESCE((attempts -> $5 -> 'reconciliation_ids'), '[]'::jsonb) ? $8) ` +
    `AND (($9)::numeric <= ((attempts -> $5 -> 'debits' -> $7 ->> 'remaining')::numeric)) ` +
    `AND (($10)::numeric >= ((windows -> $7 ->> 'consumed')::numeric)) ` +
    `AND (($10)::numeric - ((windows -> $7 ->> 'consumed')::numeric) >= ($9)::numeric) ` +
    `AND (($11)::int > COALESCE(((watermarks -> $7)::int), 0))`;
  return { sql, params };
}

interface RowState {
  version: number;
  fencingEpoch: number;
  slotsHeld: number;
  slotMax: number;
  windows: Record<string, { unit: string; quota: number; consumed: number; reserved: number; safety_headroom: number; reset_at: number }>;
  attempts: Record<string, { fingerprint: string; outcome: LedgerOutcome; reservation_version: number; debits: Record<string, { unit: string; amount: number; remaining: number }>; duration_ms: number; reconciliation_ids: string[]; slot_released: boolean }>;
  watermarks: Record<string, number>;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return fail('malformed-ledger-row');
}

function parseRow(row: Record<string, unknown>): RowState {
  const num = (v: unknown, what: string): number => {
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isFinite(n)) fail(`malformed-ledger-row-${what}`);
    return n;
  };
  const windows = asRecord(typeof row['windows'] === 'string' ? JSON.parse(row['windows'] as string) : row['windows']);
  const attempts = asRecord(typeof row['attempts'] === 'string' ? JSON.parse(row['attempts'] as string) : row['attempts']);
  const watermarks = asRecord(typeof row['watermarks'] === 'string' ? JSON.parse(row['watermarks'] as string) : row['watermarks']);
  // Rows seeded before reconciliation ids existed carry no journal; treat
  // them as empty rather than failing the read.
  for (const entry of Object.values(attempts)) {
    const e = asRecord(entry);
    if (!Array.isArray(e['reconciliation_ids'])) e['reconciliation_ids'] = [];
    if (typeof e['slot_released'] !== 'boolean') e['slot_released'] = false;
  }
  return {
    version: num(row['version'], 'version'),
    fencingEpoch: num(row['fencing_epoch'], 'epoch'),
    slotsHeld: num(row['slots_held'], 'slots'),
    slotMax: num(row['slot_max'], 'slot-max'),
    windows: windows as RowState['windows'],
    attempts: attempts as RowState['attempts'],
    watermarks: watermarks as RowState['watermarks'],
  };
}

/**
 * Stateless driver over the aggregate row. Every mutating call reads first,
 * evaluates against the read, writes with one conditional UPDATE, and on
 * zero rows (or a lost execute response) re-reads and classifies — it never
 * retries blindly and never mints a fresh permit after ambiguity.
 */
export class CapacityLedger {
  constructor(
    private readonly db: LedgerDb,
    private readonly namespace: string,
    private readonly tenantId: string,
    private readonly domainKey: string,
  ) {
    ledgerTable(namespace);
    checkId(tenantId, 'tenant-id');
    checkKey(domainKey, 'domain-key');
  }

  async seed(fencingEpoch: number, slotMax: number, windows: RowState['windows']): Promise<void> {
    if (!Number.isSafeInteger(fencingEpoch) || fencingEpoch < 0) fail('invalid-fencing-epoch');
    if (!Number.isSafeInteger(slotMax) || slotMax < 0) fail('invalid-slot-max');
    await this.db.execute(ledgerSeedSql(this.namespace), [
      this.tenantId, this.domainKey, fencingEpoch, slotMax,
      JSON.stringify(windows), JSON.stringify({}), JSON.stringify({}),
    ]);
  }

  async read(): Promise<RowState | null> {
    const out = await this.db.query(ledgerReadSql(this.namespace), [this.tenantId, this.domainKey]);
    if (out.rows.length === 0) return null;
    return parseRow(out.rows[0]!);
  }

  /**
   * Classify a row against our attempt WITHOUT writing. Shared by the
   * zero-row path and the lost-response path.
   */
  classify(
    row: RowState | null,
    idempotencyKey: string,
    fingerprint: string,
    fencingEpoch: number,
  ): 'won' | 'absent' | 'payload-mismatch' | 'fenced' | 'lost' | 'domain-unknown' {
    if (row === null) return 'domain-unknown';
    if (row.fencingEpoch !== fencingEpoch) return 'fenced';
    const entry = row.attempts[idempotencyKey];
    if (!entry) return 'absent';
    if (entry.fingerprint !== fingerprint) return 'payload-mismatch';
    return 'won';
  }

  private evaluateAgainst(
    row: RowState,
    attempt: LedgerAttempt,
    nowMs: number,
  ): string[] {
    const reasons: string[] = [];
    if (row.slotsHeld + 1 > row.slotMax) reasons.push('active-slot-limit');
    for (const d of attempt.debits) {
      const w = row.windows[d.windowId];
      if (!w) {
        reasons.push(`allowance-unknown:${d.windowId}`);
        continue;
      }
      if (w.unit !== d.unit) reasons.push(`unit-mismatch:${d.windowId}`);
      if (!(nowMs + attempt.durationMs < w.reset_at)) reasons.push(`reset-crossover-unsupported:${d.windowId}`);
      if (!(w.reserved + d.amount <= w.quota - w.consumed - w.safety_headroom)) {
        reasons.push(`safe-budget-insufficient:${d.windowId}`);
      }
    }
    return reasons;
  }

  async reserve(
    attempt: LedgerAttempt,
    fencingEpoch: number,
    nowMs: number,
  ): Promise<ReserveResult> {
    const fingerprint = fingerprintAttempt(attempt);
    const row = await this.read();
    if (row === null) {
      return { status: 'deferred', reasons: ['domain-unknown'], reservation: null, version: null };
    }
    if (row.fencingEpoch !== fencingEpoch) {
      return { status: 'fenced', reasons: ['fenced-stale-epoch'], reservation: null, version: row.version };
    }
    const prior = row.attempts[attempt.idempotencyKey];
    if (prior) {
      if (prior.fingerprint === fingerprint) {
        return {
          status: 'replayed-identical',
          reasons: [],
          reservation: {
            idempotencyKey: attempt.idempotencyKey,
            outcome: prior.outcome,
            version: prior.reservation_version,
          },
          version: row.version,
        };
      }
      return { status: 'payload-mismatch', reasons: ['idempotency-key-payload-mismatch'], reservation: null, version: row.version };
    }
    const reasons = this.evaluateAgainst(row, attempt, nowMs);
    if (reasons.length > 0) {
      return { status: 'deferred', reasons, reservation: null, version: row.version };
    }

    const nextWindows = structuredClone(row.windows);
    for (const d of attempt.debits) nextWindows[d.windowId]!.reserved += d.amount;
    const nextAttempts = structuredClone(row.attempts);
    nextAttempts[attempt.idempotencyKey] = {
      fingerprint,
      outcome: 'held',
      reservation_version: row.version + 1,
      debits: Object.fromEntries(attempt.debits.map(d => [d.windowId, { unit: d.unit, amount: d.amount, remaining: d.amount }])),
      duration_ms: attempt.durationMs,
      reconciliation_ids: [],
      slot_released: false,
    };
    const stmt = buildReserveStatement(
      this.namespace, this.tenantId, this.domainKey,
      row.version, fencingEpoch, nowMs, attempt,
      row.version + 1, JSON.stringify(nextWindows), JSON.stringify(nextAttempts), row.slotsHeld + 1,
    );
    let rowCount: number;
    try {
      rowCount = (await this.db.execute(stmt.sql, stmt.params)).rowCount;
    } catch {
      return this.resolveAfterAmbiguity(attempt.idempotencyKey, fingerprint, fencingEpoch, 'reserve-execute-ambiguous');
    }
    if (rowCount === 1) {
      return {
        status: 'held',
        reasons: [],
        reservation: { idempotencyKey: attempt.idempotencyKey, outcome: 'held', version: row.version + 1 },
        version: row.version + 1,
      };
    }
    if (rowCount !== 0) fail('ambiguous-row-count');
    const fresh = await this.read();
    const verdict = this.classify(fresh, attempt.idempotencyKey, fingerprint, fencingEpoch);
    if (verdict === 'won') {
      return {
        status: 'won-after-ambiguity',
        reasons: [],
        reservation: {
          idempotencyKey: attempt.idempotencyKey,
          outcome: fresh!.attempts[attempt.idempotencyKey]!.outcome,
          version: fresh!.attempts[attempt.idempotencyKey]!.reservation_version,
        },
        version: fresh!.version,
      };
    }
    if (verdict === 'payload-mismatch') {
      return { status: 'payload-mismatch', reasons: ['idempotency-key-payload-mismatch'], reservation: null, version: fresh!.version };
    }
    if (verdict === 'fenced') {
      return { status: 'fenced', reasons: ['fenced-stale-epoch'], reservation: null, version: fresh!.version };
    }
    if (verdict === 'domain-unknown') {
      return { status: 'lost', reasons: ['domain-unknown'], reservation: null, version: null };
    }
    const freshReasons = this.evaluateAgainst(fresh!, attempt, nowMs);
    return { status: 'lost', reasons: freshReasons.length > 0 ? freshReasons : ['write-conflict-retry-same-key'], reservation: null, version: fresh!.version };
  }

  private async resolveAfterAmbiguity(
    idempotencyKey: string,
    fingerprint: string,
    fencingEpoch: number,
    reason: string,
  ): Promise<ReserveResult> {
    const fresh = await this.read();
    const verdict = this.classify(fresh, idempotencyKey, fingerprint, fencingEpoch);
    if (verdict === 'won') {
      return {
        status: 'won-after-ambiguity',
        reasons: [],
        reservation: {
          idempotencyKey,
          outcome: fresh!.attempts[idempotencyKey]!.outcome,
          version: fresh!.attempts[idempotencyKey]!.reservation_version,
        },
        version: fresh!.version,
      };
    }
    if (verdict === 'payload-mismatch') {
      return { status: 'payload-mismatch', reasons: ['idempotency-key-payload-mismatch'], reservation: null, version: fresh?.version ?? null };
    }
    if (verdict === 'fenced') {
      return { status: 'fenced', reasons: ['fenced-stale-epoch'], reservation: null, version: fresh?.version ?? null };
    }
    // Absent (or domain missing): the ambiguous write provably did not land
    // for our key, so retrying the SAME key is safe. A fresh key is forbidden.
    return { status: 'unknown-retry-same-key', reasons: [reason], reservation: null, version: fresh?.version ?? null };
  }

  async commit(
    idempotencyKey: string,
    fingerprint: string,
    fencingEpoch: number,
    nowMs: number,
  ): Promise<{ committed: boolean; reasons: string[] }> {
    const row = await this.read();
    if (row === null) return { committed: false, reasons: ['domain-unknown'] };
    if (row.fencingEpoch !== fencingEpoch) return { committed: false, reasons: ['fenced-stale-epoch'] };
    const entry = row.attempts[idempotencyKey];
    if (!entry || entry.fingerprint !== fingerprint) return { committed: false, reasons: ['unknown-attempt'] };
    if (entry.outcome === 'committed' || entry.outcome === 'reconciled') return { committed: true, reasons: [] };
    if (entry.outcome !== 'held') return { committed: false, reasons: ['cannot-commit-cancelled-reservation'] };
    for (const [wid, debit] of Object.entries(entry.debits)) {
      const w = row.windows[wid];
      if (!w || !(nowMs + entry.duration_ms < w.reset_at)) {
        return { committed: false, reasons: ['cannot-start-expired-reservation'] };
      }
      void debit;
    }
    const nextAttempts = structuredClone(row.attempts);
    nextAttempts[idempotencyKey]!.outcome = 'committed';
    const stmt = buildCommitStatement(
      this.namespace, this.tenantId, this.domainKey, row.version, fencingEpoch,
      nowMs, idempotencyKey, fingerprint, Object.keys(entry.debits), JSON.stringify(nextAttempts),
    );
    let rowCount: number;
    try {
      rowCount = (await this.db.execute(stmt.sql, stmt.params)).rowCount;
    } catch {
      const fresh = await this.read();
      const current = fresh?.attempts[idempotencyKey];
      if (current?.fingerprint === fingerprint && (current.outcome === 'committed' || current.outcome === 'reconciled')) {
        return { committed: true, reasons: [] };
      }
      return { committed: false, reasons: ['commit-execute-ambiguous'] };
    }
    if (rowCount === 1) return { committed: true, reasons: [] };
    if (rowCount !== 0) fail('ambiguous-row-count');
    const fresh = await this.read();
    const current = fresh?.attempts[idempotencyKey];
    if (current?.fingerprint === fingerprint && (current.outcome === 'committed' || current.outcome === 'reconciled')) {
      return { committed: true, reasons: [] };
    }
    return { committed: false, reasons: ['cannot-start-expired-reservation'] };
  }

  /** Refuses with zero writes when a held debit cannot be released coherently. */
  async cancelBeforeStart(
    idempotencyKey: string,
    fingerprint: string,
    fencingEpoch: number,
  ): Promise<{ cancelled: boolean; reasons: string[] }> {
    const row = await this.read();
    if (row === null) return { cancelled: false, reasons: ['domain-unknown'] };
    if (row.fencingEpoch !== fencingEpoch) return { cancelled: false, reasons: ['fenced-stale-epoch'] };
    const entry = row.attempts[idempotencyKey];
    if (!entry || entry.fingerprint !== fingerprint) return { cancelled: false, reasons: ['unknown-attempt'] };
    if (entry.outcome === 'cancelled-before-start') return { cancelled: true, reasons: [] };
    if (entry.outcome !== 'held') return { cancelled: false, reasons: ['cannot-refund-started-attempt'] };
    const debits = Object.entries(entry.debits);
    if (debits.some(([wid]) => !row.windows[wid])) {
      return { cancelled: false, reasons: ['reservation-window-missing'] };
    }
    const nextWindows = structuredClone(row.windows);
    for (const [wid, debit] of debits) {
      const w = nextWindows[wid]!;
      const released = w.reserved - debit.remaining;
      if (
        !Number.isFinite(w.reserved) || !Number.isFinite(debit.remaining) ||
        !Number.isFinite(w.quota) || !Number.isFinite(released)
      ) {
        return { cancelled: false, reasons: ['reservation-window-malformed'] };
      }
      const tolerance = RELEASE_RESIDUE_EPSILONS * Number.EPSILON
        * Math.max(Math.abs(w.reserved), Math.abs(debit.remaining), w.quota);
      if (released < -tolerance) return { cancelled: false, reasons: ['reservation-release-exceeds-reserved'] };
      const otherLive = Object.entries(row.attempts).some(([key, other]) =>
        key !== idempotencyKey && (other.outcome === 'held' || other.outcome === 'committed')
        && (other.debits[wid]?.remaining ?? 0) > 0);
      w.reserved = released <= tolerance ? (otherLive ? Math.max(0, released) : 0) : released;
    }
    const nextAttempts = structuredClone(row.attempts);
    nextAttempts[idempotencyKey]!.outcome = 'cancelled-before-start';
    const stmt = buildCancelStatement(
      this.namespace, this.tenantId, this.domainKey, row.version, fencingEpoch,
      idempotencyKey, fingerprint, JSON.stringify(nextWindows), JSON.stringify(nextAttempts),
    );
    let rowCount: number;
    try {
      rowCount = (await this.db.execute(stmt.sql, stmt.params)).rowCount;
    } catch {
      const fresh = await this.read();
      const current = fresh?.attempts[idempotencyKey];
      if (current?.fingerprint === fingerprint && current.outcome === 'cancelled-before-start') {
        return { cancelled: true, reasons: [] };
      }
      return { cancelled: false, reasons: ['cancel-execute-ambiguous'] };
    }
    if (rowCount === 1) return { cancelled: true, reasons: [] };
    if (rowCount !== 0) fail('ambiguous-row-count');
    const fresh = await this.read();
    const current = fresh?.attempts[idempotencyKey];
    if (current?.fingerprint === fingerprint && current.outcome === 'cancelled-before-start') {
      return { cancelled: true, reasons: [] };
    }
    return { cancelled: false, reasons: ['write-conflict-retry-same-key'] };
  }

  /** Frees the slot only; held allowance stays held (may still be charged). */
  async finish(
    idempotencyKey: string,
    fingerprint: string,
    fencingEpoch: number,
  ): Promise<{ finished: boolean; reasons: string[] }> {
    const row = await this.read();
    if (row === null) return { finished: false, reasons: ['domain-unknown'] };
    if (row.fencingEpoch !== fencingEpoch) return { finished: false, reasons: ['fenced-stale-epoch'] };
    const entry = row.attempts[idempotencyKey];
    if (!entry || entry.fingerprint !== fingerprint) return { finished: false, reasons: ['unknown-attempt'] };
    if (entry.outcome !== 'committed' && entry.outcome !== 'reconciled') {
      return { finished: false, reasons: ['attempt-not-started'] };
    }
    // Already-released retry (or a concurrent second finish): the slot was
    // freed exactly once, so report success with no second write.
    if (entry.slot_released) return { finished: true, reasons: [] };
    const nextAttempts = structuredClone(row.attempts);
    nextAttempts[idempotencyKey]!.slot_released = true;
    const stmt = buildFinishStatement(
      this.namespace, this.tenantId, this.domainKey, row.version, fencingEpoch,
      idempotencyKey, fingerprint, JSON.stringify(nextAttempts),
    );
    let rowCount: number;
    try {
      rowCount = (await this.db.execute(stmt.sql, stmt.params)).rowCount;
    } catch {
      return this.resolveFinishAmbiguity(idempotencyKey, fingerprint, 'finish-execute-ambiguous');
    }
    if (rowCount === 1) return { finished: true, reasons: [] };
    if (rowCount !== 0) fail('ambiguous-row-count');
    const fresh = await this.read();
    const current = fresh?.attempts[idempotencyKey];
    if (current?.fingerprint === fingerprint && current.slot_released) {
      return { finished: true, reasons: [] };
    }
    return { finished: false, reasons: ['write-conflict-retry-same-key'] };
  }

  private async resolveFinishAmbiguity(
    idempotencyKey: string,
    fingerprint: string,
    reason: string,
  ): Promise<{ finished: boolean; reasons: string[] }> {
    const fresh = await this.read();
    const current = fresh?.attempts[idempotencyKey];
    if (current?.fingerprint === fingerprint && current.slot_released) {
      return { finished: true, reasons: [] };
    }
    return { finished: false, reasons: [reason] };
  }

  /**
   * Trusted, watermarked reconciliation. Untrusted attribution or a missing
   * watermark performs NO write and keeps the conservative hold.
   */
  async reconcile(
    idempotencyKey: string,
    fingerprint: string,
    fencingEpoch: number,
    windowId: string,
    reconciliationId: string,
    reflectedAmount: number,
    consumedNow: number,
    sourceRevision: string,
    usageWatermark: number | null,
    attributionTrusted: boolean,
  ): Promise<{ reconciled: boolean; fullyReconciled: boolean; reasons: string[] }> {
    if (!attributionTrusted || usageWatermark === null) {
      return { reconciled: false, fullyReconciled: false, reasons: ['uncertain-attribution-hold-retained'] };
    }
    if (typeof sourceRevision !== 'string' || sourceRevision.trim().length === 0) {
      return { reconciled: false, fullyReconciled: false, reasons: ['invalid-source-revision'] };
    }
    try {
      checkKey(reconciliationId, 'reconciliation-id');
    } catch {
      return { reconciled: false, fullyReconciled: false, reasons: ['invalid-reconciliation-id'] };
    }
    const row = await this.read();
    if (row === null) return { reconciled: false, fullyReconciled: false, reasons: ['domain-unknown'] };
    if (row.fencingEpoch !== fencingEpoch) return { reconciled: false, fullyReconciled: false, reasons: ['fenced-stale-epoch'] };
    const entry = row.attempts[idempotencyKey];
    if (!entry || entry.fingerprint !== fingerprint) {
      return { reconciled: false, fullyReconciled: false, reasons: ['unknown-attempt'] };
    }
    // Replayed reconciliation id: the reflection already applied (or was
    // classified) under this id, so return the current state with no write.
    if (entry.reconciliation_ids.includes(reconciliationId)) {
      return { reconciled: true, fullyReconciled: entry.outcome === 'reconciled', reasons: [] };
    }
    const debit = entry.debits[windowId];
    const w = row.windows[windowId];
    if (!debit || !w) return { reconciled: false, fullyReconciled: false, reasons: ['reservation-window-or-unit-mismatch'] };
    if (!(reflectedAmount <= debit.remaining)) {
      return { reconciled: false, fullyReconciled: false, reasons: ['invalid-usage-watermark-or-attribution'] };
    }
    if (!(consumedNow >= w.consumed && consumedNow - w.consumed >= reflectedAmount)) {
      return { reconciled: false, fullyReconciled: false, reasons: ['invalid-usage-watermark-or-attribution'] };
    }
    const oldWatermark = row.watermarks[windowId] ?? 0;
    if (!(Number.isSafeInteger(usageWatermark) && usageWatermark > oldWatermark)) {
      return { reconciled: false, fullyReconciled: false, reasons: ['invalid-usage-watermark-or-attribution'] };
    }
    const nextWindows = structuredClone(row.windows);
    nextWindows[windowId]!.consumed = consumedNow;
    nextWindows[windowId]!.reserved -= reflectedAmount;
    const nextAttempts = structuredClone(row.attempts);
    nextAttempts[idempotencyKey]!.debits[windowId]!.remaining -= reflectedAmount;
    nextAttempts[idempotencyKey]!.reconciliation_ids = [...entry.reconciliation_ids, reconciliationId];
    const fullyReconciled = Object.values(nextAttempts[idempotencyKey]!.debits).every(d => d.remaining === 0);
    if (fullyReconciled) nextAttempts[idempotencyKey]!.outcome = 'reconciled';
    const nextWatermarks = structuredClone(row.watermarks);
    nextWatermarks[windowId] = usageWatermark;
    const stmt = buildReconcileStatement(
      this.namespace, this.tenantId, this.domainKey, row.version, fencingEpoch,
      idempotencyKey, fingerprint, windowId, reconciliationId, reflectedAmount, consumedNow, usageWatermark,
      JSON.stringify(nextWindows), JSON.stringify(nextAttempts), JSON.stringify(nextWatermarks),
    );
    let rowCount: number;
    try {
      rowCount = (await this.db.execute(stmt.sql, stmt.params)).rowCount;
    } catch {
      const fresh = await this.read();
      const current = fresh?.attempts[idempotencyKey];
      if (current?.fingerprint === fingerprint && current.reconciliation_ids.includes(reconciliationId)) {
        return { reconciled: true, fullyReconciled: current.outcome === 'reconciled', reasons: [] };
      }
      return { reconciled: false, fullyReconciled: false, reasons: ['reconcile-execute-ambiguous'] };
    }
    if (rowCount === 1) return { reconciled: true, fullyReconciled, reasons: [] };
    if (rowCount !== 0) fail('ambiguous-row-count');
    return { reconciled: false, fullyReconciled: false, reasons: ['write-conflict-retry-same-key'] };
  }
}

/**
 * Derive ledger debits from the accepted pure evaluator: the binding's
 * estimate supplies upper-bound burns per window, and the evaluation's
 * window rows supply the read-time `reserved` the CAS pins. Returns null
 * when the evaluator did not admit the binding (nothing to reserve).
 */
export function debitsFromBudgetBinding(
  binding: EligibleBudgetBinding,
  evaluation: BudgetEvaluation,
): LedgerAttempt | null {
  const decided = evaluation.bindings.find(b => b.bindingKey === binding.bindingKey);
  if (!decided || decided.proposal !== 'admit' || !binding.estimate) return null;
  const byId = new Map(evaluation.windows.map(w => [w.windowId, w]));
  const debits: LedgerWindowDebit[] = [];
  for (const burn of binding.estimate.windows) {
    const w = byId.get(burn.windowId);
    if (!w || w.dataState !== 'known' || w.reserved === null) return null;
    debits.push({ windowId: burn.windowId, unit: burn.unit, amount: burn.upperBurn, readReserved: w.reserved });
  }
  if (debits.length === 0) return null;
  return {
    idempotencyKey: '',
    bindingKey: binding.bindingKey,
    estimateRevision: binding.estimate.revision,
    durationMs: binding.estimate.durationMs,
    debits,
  };
}
