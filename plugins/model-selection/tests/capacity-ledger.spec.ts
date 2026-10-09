import { describe, expect, it } from 'vitest';

import { evaluateBudgets, type BudgetInput } from '../src/admission-budget.js';
import {
  buildCancelStatement,
  buildCommitStatement,
  buildFinishStatement,
  buildReconcileStatement,
  buildReserveStatement,
  CapacityLedger,
  debitsFromBudgetBinding,
  fingerprintAttempt,
  ledgerDdl,
  ledgerReadSql,
  ledgerSeedSql,
  type LedgerAttempt,
  type LedgerDb,
} from '../src/capacity-ledger.js';

const NS = 'plugin_capacity_ledger_test';
const TENANT = 'tenant-a';
const DOMAIN = 'domain-1';
const EPOCH = 7;
const NOW = 1_000;

const WEEKLY = '["prov","pool","weekly",0,10000]';
const FIVE_HOUR = '["prov","pool","five-hour",0,5000]';

function windowsJson() {
  return JSON.stringify({
    [WEEKLY]: { unit: 'allowance', quota: 100, consumed: 90, reserved: 0, safety_headroom: 0, reset_at: 10000 },
    [FIVE_HOUR]: { unit: 'allowance', quota: 50, consumed: 10, reserved: 0, safety_headroom: 5, reset_at: 5000 },
  });
}

function rowJson(over: {
  version?: number; epoch?: number; slotsHeld?: number; slotMax?: number;
  windows?: string; attempts?: string; watermarks?: string;
} = {}) {
  return {
    tenant_id: TENANT,
    domain_key: DOMAIN,
    // node-pg returns BIGINT as strings; the driver must accept both.
    version: String(over.version ?? 0),
    fencing_epoch: String(over.epoch ?? EPOCH),
    slot_max: String(over.slotMax ?? 3),
    slots_held: String(over.slotsHeld ?? 0),
    windows: over.windows ?? windowsJson(),
    attempts: over.attempts ?? JSON.stringify({}),
    watermarks: over.watermarks ?? JSON.stringify({}),
  };
}

function attempt(key = 'attempt-1'): LedgerAttempt {
  return {
    idempotencyKey: key,
    bindingKey: 'eligible',
    estimateRevision: 'v1',
    durationMs: 100,
    debits: [
      { windowId: WEEKLY, unit: 'allowance', amount: 10, readReserved: 0 },
      { windowId: FIVE_HOUR, unit: 'allowance', amount: 5, readReserved: 0 },
    ],
  };
}

interface Seen {
  sql: string;
  params: unknown[];
}

class ScriptedDb implements LedgerDb {
  seen: Seen[] = [];
  constructor(
    private readonly rows: Array<Array<Record<string, unknown>>>,
    private readonly executes: Array<{ rowCount: number } | { error: string }>,
  ) {}

  async query(sql: string, params: unknown[]) {
    this.seen.push({ sql, params });
    const next = this.rows.shift();
    if (!next) throw new Error('unexpected-query');
    return { rows: next };
  }

  async execute(sql: string, params: unknown[]) {
    this.seen.push({ sql, params });
    const next = this.executes.shift();
    if (!next) throw new Error('unexpected-execute');
    if ('error' in next) throw new Error(next.error);
    return { rowCount: next.rowCount };
  }

  get queries() {
    return this.seen.filter(s => /^\s*select/i.test(s.sql));
  }

  get writes() {
    return this.seen.filter(s => /^\s*(update|insert)/i.test(s.sql));
  }
}

function reserveStmt() {
  return buildReserveStatement(NS, TENANT, DOMAIN, 0, EPOCH, NOW, attempt(), 1, windowsJson(), JSON.stringify({}), 1);
}

describe('capacity-ledger runtime SQL shape', () => {
  const statements = () => [
    ['reserve', reserveStmt()],
    ['commit', buildCommitStatement(NS, TENANT, DOMAIN, 1, EPOCH, NOW, 'k', 'fp', [WEEKLY], JSON.stringify({}))],
    ['cancel', buildCancelStatement(NS, TENANT, DOMAIN, 1, EPOCH, 'k', 'fp', windowsJson(), JSON.stringify({}))],
    ['finish', buildFinishStatement(NS, TENANT, DOMAIN, 1, EPOCH, 'k', 'fp', '{}')],
    ['reconcile', buildReconcileStatement(NS, TENANT, DOMAIN, 1, EPOCH, 'k', 'fp', WEEKLY, 'rec-1', 4, 94, 1, windowsJson(), JSON.stringify({}), JSON.stringify({}))],
  ] as const;

  it.each(statements())('the %s update is one conditional statement with tenant, version and fencing pins', (_n, stmt) => {
    expect(stmt.sql).not.toContain(';');
    expect(stmt.sql.trim().toLowerCase().startsWith('update')).toBe(true);
    const lower = stmt.sql.toLowerCase();
    // Word boundaries: the legit 'committed' outcome literal must not trip
    // the transaction-keyword guard.
    expect(lower).not.toMatch(/\bbegin\b/);
    expect(lower).not.toMatch(/\bcommit\b/);
    expect(lower).not.toMatch(/^\s*with\b/);
    expect(stmt.sql).toContain('tenant_id = $1');
    expect(stmt.sql).toContain('version = $3');
    expect(stmt.sql).toContain('fencing_epoch = $4');
    expect(stmt.params.slice(0, 4)).toEqual([TENANT, DOMAIN, expect.any(Number), EPOCH]);
  });

  it('the reserve update binds every debit window as a parameter and interpolates none', () => {
    const { sql, params } = reserveStmt();
    for (const wid of [WEEKLY, FIVE_HOUR]) {
      expect(sql).not.toContain(wid);
      expect(params).toContain(wid);
    }
    // One UPDATE, all windows inside it: all-or-none by construction.
    expect(sql.match(/update/gi)).toHaveLength(1);
    expect(sql).toContain('NOT (attempts ? $5)');
    expect(sql).toContain('slots_held + 1 <= slot_max');
  });

  it('stored journal keys match the keys the SQL predicates read (no silent NULL predicate)', async () => {
    // Regression anchor: camelCase/snake_case drift between the SET
    // documents and the WHERE predicates turns a predicate NULL, which
    // silently matches zero rows (commit could never land, duplicate
    // reconciliation was never blocked). The driver writes through the
    // same builders, so assert on a real reserve write.
    const db = new ScriptedDb([[rowJson()]], [{ rowCount: 1 }]);
    await new CapacityLedger(db, NS, TENANT, DOMAIN).reserve(attempt(), EPOCH, NOW);
    const write = db.writes[0]!;
    const attemptsDoc = JSON.parse(write.params[write.params.length - 3] as string);
    expect(Object.keys(attemptsDoc['attempt-1']).sort()).toEqual(
      ['debits', 'duration_ms', 'fingerprint', 'outcome', 'reconciliation_ids', 'reservation_version', 'slot_released'],
    );
    for (const needle of ["->> 'fingerprint'", "->> 'outcome'", "->> 'duration_ms'", "'reconciliation_ids'"]) {
      expect(
        buildCommitStatement(NS, TENANT, DOMAIN, 1, EPOCH, NOW, 'k', 'fp', [WEEKLY], '{}').sql +
        buildReconcileStatement(NS, TENANT, DOMAIN, 1, EPOCH, 'k', 'fp', WEEKLY, 'r', 1, 1, 1, '{}', '{}', '{}').sql,
      ).toContain(needle);
    }
  });

  it('the read is a single tenant-scoped select; the seed is a single insert-or-nothing', () => {
    const read = ledgerReadSql(NS);
    expect(read).not.toContain(';');
    expect(read.trim().toLowerCase().startsWith('select')).toBe(true);
    expect(read).toContain('tenant_id = $1');
    const seed = ledgerSeedSql(NS);
    expect(seed).not.toContain(';');
    expect(seed.trim().toLowerCase().startsWith('insert')).toBe(true);
    expect(seed).toContain('ON CONFLICT DO NOTHING');
    expect(ledgerDdl(NS)).toContain('PRIMARY KEY (tenant_id, domain_key)');
  });

  it('rejects a hostile namespace and a hostile tenant before any SQL is built', () => {
    expect(() => ledgerDdl('public; DROP TABLE x; --')).toThrow('invalid-ledger-namespace');
    expect(() => buildReserveStatement('ok_ns', 'not a tenant!!', DOMAIN, 0, EPOCH, NOW, attempt(), 1, '{}', '{}', 1))
      .toThrow('invalid-tenant-id');
  });

  it('the finish update frees the slot and touches no allowance column', () => {
    const { sql } = buildFinishStatement(NS, TENANT, DOMAIN, 1, EPOCH, 'k', 'fp', '{}');
    expect(sql).toContain('slots_held = slots_held - 1');
    expect(sql).not.toContain('windows =');
    expect(sql).not.toContain('reserved');
  });
});

describe('capacity-ledger reserve policy', () => {
  it('holds on one matched row and records version+1 with both debits applied', async () => {
    const db = new ScriptedDb([[rowJson()]], [{ rowCount: 1 }]);
    const ledger = new CapacityLedger(db, NS, TENANT, DOMAIN);
    const res = await ledger.reserve(attempt(), EPOCH, NOW);
    expect(res.status).toBe('held');
    expect(res.reservation).toMatchObject({ idempotencyKey: 'attempt-1', outcome: 'held', version: 1 });
    const write = db.writes[0]!;
    // SET order is windows, attempts, slots, version: the windows document
    // sits four slots from the end (debit window-id params share content).
    const patched = JSON.parse(write.params[write.params.length - 4] as string);
    expect(patched[WEEKLY].reserved).toBe(10);
    expect(patched[FIVE_HOUR].reserved).toBe(5);
  });

  it('defers without writing when any window cannot cover the debit', async () => {
    const short = JSON.parse(windowsJson());
    short[WEEKLY].consumed = 100;
    const db = new ScriptedDb([[rowJson({ windows: JSON.stringify(short) })]], []);
    const ledger = new CapacityLedger(db, NS, TENANT, DOMAIN);
    const res = await ledger.reserve(attempt(), EPOCH, NOW);
    expect(res.status).toBe('deferred');
    expect(res.reasons).toContain(`safe-budget-insufficient:${WEEKLY}`);
    expect(db.writes).toHaveLength(0);
  });

  it('replays an identical key with no write; rejects a changed payload on the same key', async () => {
    const fp = fingerprintAttempt(attempt());
    const held = JSON.stringify({ 'attempt-1': {
      fingerprint: fp, outcome: 'held', reservation_version: 1,
      debits: { [WEEKLY]: { unit: 'allowance', amount: 10, remaining: 10 } }, duration_ms: 100,
    } });
    const db = new ScriptedDb([[rowJson({ version: 1, attempts: held })]], []);
    const ledger = new CapacityLedger(db, NS, TENANT, DOMAIN);
    const replay = await ledger.reserve(attempt(), EPOCH, NOW);
    expect(replay.status).toBe('replayed-identical');
    expect(replay.reservation).toMatchObject({ outcome: 'held', version: 1 });
    expect(db.writes).toHaveLength(0);

    const changed = attempt();
    changed.debits[0]!.amount = 1;
    const db2 = new ScriptedDb([[rowJson({ version: 1, attempts: held })]], []);
    const res = await new CapacityLedger(db2, NS, TENANT, DOMAIN).reserve(changed, EPOCH, NOW);
    expect(res.status).toBe('payload-mismatch');
    expect(db2.writes).toHaveLength(0);
  });

  it('a lost write with no entry on re-read is a loss classified on fresh state, not a silent retry', async () => {
    const full = rowJson({ version: 1, slotsHeld: 3, attempts: JSON.stringify({}) });
    const db = new ScriptedDb([[rowJson()], [full]], [{ rowCount: 0 }]);
    const res = await new CapacityLedger(db, NS, TENANT, DOMAIN).reserve(attempt(), EPOCH, NOW);
    expect(res.status).toBe('lost');
    expect(res.reasons).toContain('active-slot-limit');
    expect(res.reservation).toBeNull();
  });

  it('a lost execute response resolves to won when the fingerprint landed', async () => {
    const fp = fingerprintAttempt(attempt());
    const landed = rowJson({ version: 1, slotsHeld: 1, attempts: JSON.stringify({ 'attempt-1': {
      fingerprint: fp, outcome: 'held', reservation_version: 1,
      debits: { [WEEKLY]: { unit: 'allowance', amount: 10, remaining: 10 } }, duration_ms: 100,
    } }) });
    const db = new ScriptedDb([[rowJson()], [landed]], [{ error: 'connection-timeout' }]);
    const res = await new CapacityLedger(db, NS, TENANT, DOMAIN).reserve(attempt(), EPOCH, NOW);
    expect(res.status).toBe('won-after-ambiguity');
    expect(res.reservation).toMatchObject({ outcome: 'held', version: 1 });
  });

  it('a lost execute response with no entry is retry-safe on the same key, never a fresh permit', async () => {
    const db = new ScriptedDb([[rowJson()], [rowJson({ version: 1 })]], [{ error: 'connection-timeout' }]);
    const res = await new CapacityLedger(db, NS, TENANT, DOMAIN).reserve(attempt(), EPOCH, NOW);
    expect(res.status).toBe('unknown-retry-same-key');
    expect(res.reservation).toBeNull();
  });

  it('a stale fencing epoch is fenced without writing, even with budget available', async () => {
    const db = new ScriptedDb([[rowJson({ epoch: EPOCH + 1 })]], []);
    const res = await new CapacityLedger(db, NS, TENANT, DOMAIN).reserve(attempt(), EPOCH, NOW);
    expect(res.status).toBe('fenced');
    expect(db.writes).toHaveLength(0);
  });

  it('a tenant reads only its own row: another tenant has no domain here', async () => {
    const db = new ScriptedDb([[/* zero rows */]], []);
    const res = await new CapacityLedger(db, NS, 'tenant-b', DOMAIN).reserve(attempt(), EPOCH, NOW);
    expect(res.status).toBe('deferred');
    expect(res.reasons).toContain('domain-unknown');
    expect(db.queries[0]!.params[0]).toBe('tenant-b');
  });

  it('a restarted worker recovers the prior hold by reading: no memory, no double debit', async () => {
    const fp = fingerprintAttempt(attempt());
    const landed = rowJson({ version: 1, slotsHeld: 1, attempts: JSON.stringify({ 'attempt-1': {
      fingerprint: fp, outcome: 'held', reservation_version: 1,
      debits: { [WEEKLY]: { unit: 'allowance', amount: 10, remaining: 10 } }, duration_ms: 100,
    } }) });
    const db = new ScriptedDb([[rowJson()], [landed]], [{ rowCount: 1 }]);
    const first = new CapacityLedger(db, NS, TENANT, DOMAIN);
    expect((await first.reserve(attempt(), EPOCH, NOW)).status).toBe('held');
    const restarted = new CapacityLedger(db, NS, TENANT, DOMAIN);
    const replay = await restarted.reserve(attempt(), EPOCH, NOW);
    expect(replay.status).toBe('replayed-identical');
    expect(replay.reservation).toMatchObject({ outcome: 'held', version: 1 });
  });

  it('a driver-honest rowCount outside {0,1} fails loudly instead of guessing', async () => {
    const db = new ScriptedDb([[rowJson()]], [{ rowCount: 2 }]);
    await expect(new CapacityLedger(db, NS, TENANT, DOMAIN).reserve(attempt(), EPOCH, NOW))
      .rejects.toThrow('ambiguous-row-count');
  });
});

describe('capacity-ledger lifecycle: charged outcomes', () => {
  function heldRow() {
    const fp = fingerprintAttempt(attempt());
    // A coherent post-reserve row: the windows carry the held debits the
    // attempt journal references.
    const held = JSON.parse(windowsJson());
    held[WEEKLY].reserved = 10;
    held[FIVE_HOUR].reserved = 5;
    return {
      fp,
      row: rowJson({ version: 1, slotsHeld: 1, windows: JSON.stringify(held), attempts: JSON.stringify({ 'attempt-1': {
        fingerprint: fp, outcome: 'held', reservation_version: 1,
        debits: {
          [WEEKLY]: { unit: 'allowance', amount: 10, remaining: 10 },
          [FIVE_HOUR]: { unit: 'allowance', amount: 5, remaining: 5 },
        }, duration_ms: 100, reconciliation_ids: [],
      } }) }),
    };
  }

  it('commits a held attempt; refuses a start across reset without writing', async () => {
    const { fp, row } = heldRow();
    const db = new ScriptedDb([[row]], [{ rowCount: 1 }]);
    const ok = await new CapacityLedger(db, NS, TENANT, DOMAIN).commit('attempt-1', fp, EPOCH, NOW);
    expect(ok).toEqual({ committed: true, reasons: [] });

    const db2 = new ScriptedDb([[row]], []);
    const late = await new CapacityLedger(db2, NS, TENANT, DOMAIN).commit('attempt-1', fp, EPOCH, 9_950);
    expect(late).toEqual({ committed: false, reasons: ['cannot-start-expired-reservation'] });
    expect(db2.writes).toHaveLength(0);
  });

  it('an ambiguous commit that landed resolves to committed on re-read', async () => {
    const { fp } = heldRow();
    const committed = rowJson({ version: 2, slotsHeld: 1, attempts: JSON.stringify({ 'attempt-1': {
      fingerprint: fp, outcome: 'committed', reservation_version: 1,
      debits: { [WEEKLY]: { unit: 'allowance', amount: 10, remaining: 10 } }, duration_ms: 100,
    } }) });
    const { row } = heldRow();
    const db = new ScriptedDb([[row], [committed]], [{ error: 'socket-hangup' }]);
    const res = await new CapacityLedger(db, NS, TENANT, DOMAIN).commit('attempt-1', fp, EPOCH, NOW);
    expect(res).toEqual({ committed: true, reasons: [] });
  });

  it('cancels only before start and releases both window debits atomically', async () => {
    const { fp, row } = heldRow();
    const db = new ScriptedDb([[row]], [{ rowCount: 1 }]);
    const res = await new CapacityLedger(db, NS, TENANT, DOMAIN).cancelBeforeStart('attempt-1', fp, EPOCH);
    expect(res).toEqual({ cancelled: true, reasons: [] });
    const write = db.writes[0]!;
    const patched = JSON.parse(write.params[6] as string);
    // 0 observed + 10 held, minus 10 released: back to zero on both windows.
    expect(patched[WEEKLY].reserved).toBe(0);
    expect(patched[FIVE_HOUR].reserved).toBe(0);

    const committed = rowJson({ version: 2, attempts: JSON.stringify({ 'attempt-1': {
      fingerprint: fp, outcome: 'committed', reservation_version: 1, debits: {}, duration_ms: 100,
    } }) });
    const db2 = new ScriptedDb([[committed]], []);
    const refused = await new CapacityLedger(db2, NS, TENANT, DOMAIN).cancelBeforeStart('attempt-1', fp, EPOCH);
    expect(refused).toEqual({ cancelled: false, reasons: ['cannot-refund-started-attempt'] });
    expect(db2.writes).toHaveLength(0);
  });

  describe('cancelBeforeStart refusals and residue', () => {
    function withWindows(mutate: (windows: Record<string, Record<string, unknown>>) => void) {
      const { fp, row } = heldRow();
      const windows = JSON.parse(row.windows as string);
      mutate(windows);
      return { fp, row: { ...row, windows: JSON.stringify(windows) } };
    }

    async function cancelRefused(row: ReturnType<typeof heldRow>['row'], fp: string) {
      const db = new ScriptedDb([[row]], []);
      const res = await new CapacityLedger(db, NS, TENANT, DOMAIN).cancelBeforeStart('attempt-1', fp, EPOCH);
      expect(db.writes).toHaveLength(0);
      expect(db.queries).toHaveLength(1);
      return res;
    }

    // One window; each amount is a held attempt. Reserved is the left-to-right sum reserve writes.
    function singleWindowHolds(amounts: number[]) {
      const fps: Record<string, string> = {};
      const entries: Record<string, unknown> = {};
      let reserved = 0;
      amounts.forEach((amount, i) => {
        const key = `hold-${i}`;
        const journaled: LedgerAttempt = {
          ...attempt(key),
          debits: [{ windowId: WEEKLY, unit: 'allowance', amount, readReserved: 0 }],
        };
        fps[key] = fingerprintAttempt(journaled);
        entries[key] = {
          fingerprint: fps[key], outcome: 'held', reservation_version: 1,
          debits: { [WEEKLY]: { unit: 'allowance', amount, remaining: amount } },
          duration_ms: 100, reconciliation_ids: [],
        };
        reserved += amount;
      });
      const windows = {
        [WEEKLY]: { unit: 'allowance', quota: 100, consumed: 0, reserved, safety_headroom: 0, reset_at: 10000 },
      };
      const row = rowJson({
        version: amounts.length, slotsHeld: amounts.length, slotMax: amounts.length,
        windows: JSON.stringify(windows), attempts: JSON.stringify(entries),
      });
      return { row, fps, keys: Object.keys(entries) };
    }

    // Cancels in order, feeding each write back as the next read; stops at the first refusal.
    async function cancelInOrder(start: Record<string, unknown>, fps: Record<string, string>, order: string[]) {
      let row = start;
      const persisted: number[] = [];
      for (const key of order) {
        const db = new ScriptedDb([[row]], [{ rowCount: 1 }]);
        const res = await new CapacityLedger(db, NS, TENANT, DOMAIN).cancelBeforeStart(key, fps[key]!, EPOCH);
        if (!res.cancelled) return { res, persisted };
        const write = db.writes[0]!;
        persisted.push(JSON.parse(write.params[6] as string)[WEEKLY].reserved);
        row = { ...row, windows: write.params[6] as string, attempts: write.params[7] as string };
      }
      return { res: { cancelled: true, reasons: [] as string[] }, persisted };
    }

    function mulberry32(seed: number) {
      let s = seed >>> 0;
      return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    function shuffled<T>(items: T[], rand: () => number): T[] {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    }

    it('refuses with reservation-window-missing when any journaled window is absent', async () => {
      const noFiveHour = withWindows(w => { delete w[FIVE_HOUR]; });
      expect(await cancelRefused(noFiveHour.row, noFiveHour.fp))
        .toEqual({ cancelled: false, reasons: ['reservation-window-missing'] });
      const noWeekly = withWindows(w => { delete w[WEEKLY]; });
      expect(await cancelRefused(noWeekly.row, noWeekly.fp))
        .toEqual({ cancelled: false, reasons: ['reservation-window-missing'] });
    });

    it('commit and reconcile refuse the same absent window without writing', async () => {
      const { fp, row } = withWindows(w => { delete w[FIVE_HOUR]; });
      const dbCommit = new ScriptedDb([[row]], []);
      expect(await new CapacityLedger(dbCommit, NS, TENANT, DOMAIN).commit('attempt-1', fp, EPOCH, NOW))
        .toEqual({ committed: false, reasons: ['cannot-start-expired-reservation'] });
      expect(dbCommit.writes).toHaveLength(0);

      // Reconcile only applies to a started attempt, so seed one over the same missing window.
      const started = JSON.parse(row.attempts as string);
      started['attempt-1'].outcome = 'committed';
      const dbRec = new ScriptedDb([[{ ...row, attempts: JSON.stringify(started) }]], []);
      expect(await new CapacityLedger(dbRec, NS, TENANT, DOMAIN)
        .reconcile('attempt-1', fp, EPOCH, FIVE_HOUR, 'rec-1', 5, 15, 'src-1', 1, true))
        .toEqual({ reconciled: false, fullyReconciled: false, reasons: ['reservation-window-or-unit-mismatch'] });
      expect(dbRec.writes).toHaveLength(0);
    });

    it('refuses a release that would drive a reserved counter below zero, on either window', async () => {
      const under = withWindows(w => { w[WEEKLY]!.reserved = 4; });
      expect(await cancelRefused(under.row, under.fp))
        .toEqual({ cancelled: false, reasons: ['reservation-release-exceeds-reserved'] });
      const underLast = withWindows(w => { w[FIVE_HOUR]!.reserved = 4; });
      expect(await cancelRefused(underLast.row, underLast.fp))
        .toEqual({ cancelled: false, reasons: ['reservation-release-exceeds-reserved'] });
    });

    it('refuses an exactly representable whole-unit over-release at large magnitude', async () => {
      const { fp, row } = heldRow();
      const windows = JSON.parse(row.windows as string);
      windows[WEEKLY].reserved = 1e9;
      const attempts = JSON.parse(row.attempts as string);
      attempts['attempt-1'].debits[WEEKLY].amount = 1e9 + 1;
      attempts['attempt-1'].debits[WEEKLY].remaining = 1e9 + 1;
      const damaged = { ...row, windows: JSON.stringify(windows), attempts: JSON.stringify(attempts) };
      expect(await cancelRefused(damaged, fp))
        .toEqual({ cancelled: false, reasons: ['reservation-release-exceeds-reserved'] });
    });

    it('refuses a whole-unit over-release when the window quota is large', async () => {
      const { fp, row } = heldRow();
      const windows = JSON.parse(row.windows as string);
      windows[WEEKLY].quota = 1e12;
      windows[WEEKLY].reserved = 1e9;
      const attempts = JSON.parse(row.attempts as string);
      attempts['attempt-1'].debits[WEEKLY].amount = 1e9 + 1;
      attempts['attempt-1'].debits[WEEKLY].remaining = 1e9 + 1;
      const damaged = { ...row, windows: JSON.stringify(windows), attempts: JSON.stringify(attempts) };
      expect(await cancelRefused(damaged, fp))
        .toEqual({ cancelled: false, reasons: ['reservation-release-exceeds-reserved'] });
    });

    it('refuses a tiny over-release against a zero counter', async () => {
      const { fp, row } = heldRow();
      const windows = JSON.parse(row.windows as string);
      windows[WEEKLY].reserved = 0;
      const attempts = JSON.parse(row.attempts as string);
      attempts['attempt-1'].debits[WEEKLY].amount = 1e-10;
      attempts['attempt-1'].debits[WEEKLY].remaining = 1e-10;
      const damaged = { ...row, windows: JSON.stringify(windows), attempts: JSON.stringify(attempts) };
      expect(await cancelRefused(damaged, fp))
        .toEqual({ cancelled: false, reasons: ['reservation-release-exceeds-reserved'] });
    });

    it('reports a missing window ahead of an over-release on another window', async () => {
      const both = withWindows(w => { w[WEEKLY]!.reserved = 0; delete w[FIVE_HOUR]; });
      expect(await cancelRefused(both.row, both.fp))
        .toEqual({ cancelled: false, reasons: ['reservation-window-missing'] });
    });

    it('refuses non-finite release arithmetic instead of persisting a null counter', async () => {
      const bad = withWindows(w => { w[WEEKLY]!.reserved = 'NaN'; });
      expect(await cancelRefused(bad.row, bad.fp))
        .toEqual({ cancelled: false, reasons: ['reservation-window-malformed'] });
    });

    it('refuses a non-finite window quota rather than accepting a negative release', async () => {
      const bad = withWindows(w => { w[WEEKLY]!.quota = 'NaN'; w[WEEKLY]!.reserved = 4; });
      expect(await cancelRefused(bad.row, bad.fp))
        .toEqual({ cancelled: false, reasons: ['reservation-window-malformed'] });
    });

    it('releases fractional float residue as zero and never persists a negative reserved', async () => {
      // 0.3 held on the window, but the journal released 0.1 + 0.2 = 0.30000000000000004.
      const { fp, row } = heldRow();
      const windows = JSON.parse(row.windows as string);
      windows[WEEKLY].reserved = 0.3;
      const attempts = JSON.parse(row.attempts as string);
      attempts['attempt-1'].debits[WEEKLY].remaining = 0.1 + 0.2;
      const db = new ScriptedDb([[{ ...row, windows: JSON.stringify(windows), attempts: JSON.stringify(attempts) }]], [{ rowCount: 1 }]);
      const res = await new CapacityLedger(db, NS, TENANT, DOMAIN).cancelBeforeStart('attempt-1', fp, EPOCH);
      expect(res).toEqual({ cancelled: true, reasons: [] });
      const patched = JSON.parse(db.writes[0]!.params[6] as string);
      expect(patched[WEEKLY].reserved).toBe(0);
      expect(Object.is(patched[WEEKLY].reserved, -0)).toBe(false);
      expect(patched[FIVE_HOUR].reserved).toBe(0);
    });

    it('a window whose reset_at has passed but whose row still exists releases as before', async () => {
      // cancelBeforeStart takes no clock: a past reset_at is not a refusal reason.
      const { fp, row } = withWindows(w => { w[WEEKLY]!.reset_at = 1; w[FIVE_HOUR]!.reset_at = 1; });
      const db = new ScriptedDb([[row]], [{ rowCount: 1 }]);
      const res = await new CapacityLedger(db, NS, TENANT, DOMAIN).cancelBeforeStart('attempt-1', fp, EPOCH);
      expect(res).toEqual({ cancelled: true, reasons: [] });
      const patched = JSON.parse(db.writes[0]!.params[6] as string);
      expect(patched[WEEKLY]).toMatchObject({ reserved: 0, reset_at: 1 });
      expect(patched[FIVE_HOUR]).toMatchObject({ reserved: 0, reset_at: 1 });
    });

    it('six FIFO holds on one window cancel one by one and end at reserved 0', async () => {
      // The counter peaks at 37.1; the last cancel's residue is set by that peak, not the last hold.
      const { row, fps, keys } = singleWindowHolds([8.17, 9.77, 0.16, 6.15, 9.41, 3.44]);
      const out = await cancelInOrder(row, fps, keys);
      expect(out.res).toEqual({ cancelled: true, reasons: [] });
      expect(out.persisted.every(v => v >= 0)).toBe(true);
      expect(out.persisted.at(-1)).toBe(0);
    });

    it('keeps a sub-tolerance residue on the window while another hold is still live', async () => {
      const { row, fps } = singleWindowHolds([1e-14, 5]);
      const out = await cancelInOrder(row, fps, ['hold-1', 'hold-0']);
      expect(out.res).toEqual({ cancelled: true, reasons: [] });
      expect(out.persisted[0]).toBeGreaterThan(0);
      expect(out.persisted.at(-1)).toBe(0);
    });

    it('a lone hold cancels after 100000 reserve and release updates at concurrency 16', async () => {
      // Seed 10 leaves the counter 8.6e-13 below the lone hold, which a 16-epsilon allowance would refuse.
      const rand = mulberry32(10);
      let reserved = 0;
      const live: number[] = [];
      const release = (i: number) => { reserved -= live.splice(i, 1)[0]!; };
      for (let op = 0; op < 100_000; op++) {
        if (live.length < 16 && (live.length === 0 || rand() < 0.5)) {
          const amount = 0.01 + rand() * 9.99;
          if (reserved + amount <= 100) { live.push(amount); reserved += amount; continue; }
        }
        if (live.length > 0) release(Math.floor(rand() * live.length));
      }
      while (live.length > 1) release(Math.floor(rand() * live.length));
      const { row, fps, keys } = singleWindowHolds([live[0]!]);
      const windows = JSON.parse(row.windows as string);
      windows[WEEKLY].reserved = reserved;
      const out = await cancelInOrder({ ...row, windows: JSON.stringify(windows) }, fps, keys);
      expect(out.res).toEqual({ cancelled: true, reasons: [] });
      expect(out.persisted).toEqual([0]);
    });

    it('seeded FIFO, LIFO and shuffled cancels of fully held sets all end at reserved 0', async () => {
      for (let seed = 1; seed <= 200; seed++) {
        const rand = mulberry32(seed);
        const count = 1 + Math.floor(rand() * 16);
        const raw = Array.from({ length: count }, () =>
          seed % 2 === 0 ? Math.round((0.01 + rand() * 9.99) * 100) / 100 : 0.01 + rand() * 9.99);
        const total = raw.reduce((sum, a) => sum + a, 0);
        const amounts = total > 95 ? raw.map(a => (a * 95) / total) : raw;
        const { row, fps, keys } = singleWindowHolds(amounts);
        for (const order of [keys, [...keys].reverse(), shuffled(keys, rand)]) {
          const out = await cancelInOrder(row, fps, order);
          expect(out.res, `seed ${seed}`).toEqual({ cancelled: true, reasons: [] });
          expect(out.persisted.every(v => v >= 0), `seed ${seed}`).toBe(true);
          expect(out.persisted.at(-1), `seed ${seed}`).toBe(0);
        }
      }
    });
  });

  it('finish frees the slot once, journals the release, and keeps the held debit charged', async () => {
    const { fp } = heldRow();
    const committed = rowJson({ version: 2, slotsHeld: 1, attempts: JSON.stringify({ 'attempt-1': {
      fingerprint: fp, outcome: 'committed', reservation_version: 1,
      debits: { [WEEKLY]: { unit: 'allowance', amount: 10, remaining: 10 } }, duration_ms: 100,
      reconciliation_ids: [], slot_released: false,
    } }) });
    const db = new ScriptedDb([[committed]], [{ rowCount: 1 }]);
    const res = await new CapacityLedger(db, NS, TENANT, DOMAIN).finish('attempt-1', fp, EPOCH);
    expect(res).toEqual({ finished: true, reasons: [] });
    // No allowance column is touched by finish: the debit stays charged.
    expect(db.writes[0]!.sql).not.toContain('windows');
    const patched = JSON.parse(db.writes[0]!.params[6] as string);
    expect(patched['attempt-1'].slot_released).toBe(true);

    const { row } = heldRow();
    const db2 = new ScriptedDb([[row]], []);
    const early = await new CapacityLedger(db2, NS, TENANT, DOMAIN).finish('attempt-1', fp, EPOCH);
    expect(early).toEqual({ finished: false, reasons: ['attempt-not-started'] });
    expect(db2.writes).toHaveLength(0);
  });

  it('a retried or concurrent second finish reports success with no second slot decrement', async () => {
    const { fp } = heldRow();
    const released = rowJson({ version: 3, slotsHeld: 0, attempts: JSON.stringify({ 'attempt-1': {
      fingerprint: fp, outcome: 'committed', reservation_version: 1,
      debits: { [WEEKLY]: { unit: 'allowance', amount: 10, remaining: 10 } }, duration_ms: 100,
      reconciliation_ids: [], slot_released: true,
    } }) });
    const db = new ScriptedDb([[released]], []);
    const res = await new CapacityLedger(db, NS, TENANT, DOMAIN).finish('attempt-1', fp, EPOCH);
    expect(res).toEqual({ finished: true, reasons: [] });
    expect(db.writes).toHaveLength(0);
  });

  it('an ambiguous finish that landed resolves to finished; an unlanded one stays unknown', async () => {
    const { fp } = heldRow();
    const released = rowJson({ version: 3, slotsHeld: 0, attempts: JSON.stringify({ 'attempt-1': {
      fingerprint: fp, outcome: 'committed', reservation_version: 1,
      debits: { [WEEKLY]: { unit: 'allowance', amount: 10, remaining: 10 } }, duration_ms: 100,
      reconciliation_ids: [], slot_released: true,
    } }) });
    const { row } = heldRow();
    const committed = rowJson({ version: 2, slotsHeld: 1, attempts: JSON.stringify({ 'attempt-1': {
      fingerprint: fp, outcome: 'committed', reservation_version: 1,
      debits: { [WEEKLY]: { unit: 'allowance', amount: 10, remaining: 10 } }, duration_ms: 100,
      reconciliation_ids: [], slot_released: false,
    } }) });
    void row;
    const landed = new ScriptedDb([[committed], [released]], [{ error: 'socket-hangup' }]);
    expect(await new CapacityLedger(landed, NS, TENANT, DOMAIN).finish('attempt-1', fp, EPOCH))
      .toEqual({ finished: true, reasons: [] });
    const unlanded = new ScriptedDb([[committed], [committed]], [{ error: 'socket-hangup' }]);
    expect(await new CapacityLedger(unlanded, NS, TENANT, DOMAIN).finish('attempt-1', fp, EPOCH))
      .toEqual({ finished: false, reasons: ['finish-execute-ambiguous'] });
  });

  it('ambiguous cancel and reconcile resolve through the journal instead of throwing', async () => {
    const { fp, row } = heldRow();
    const cancelled = rowJson({ version: 2, slotsHeld: 0, attempts: JSON.stringify({ 'attempt-1': {
      fingerprint: fp, outcome: 'cancelled-before-start', reservation_version: 1,
      debits: { [WEEKLY]: { unit: 'allowance', amount: 10, remaining: 0 } }, duration_ms: 100,
      reconciliation_ids: [], slot_released: false,
    } }) });
    const dbCancel = new ScriptedDb([[row], [cancelled]], [{ error: 'connection-timeout' }]);
    expect(await new CapacityLedger(dbCancel, NS, TENANT, DOMAIN).cancelBeforeStart('attempt-1', fp, EPOCH))
      .toEqual({ cancelled: true, reasons: [] });

    const committed = rowJson({ version: 2, slotsHeld: 0, attempts: JSON.stringify({ 'attempt-1': {
      fingerprint: fp, outcome: 'committed', reservation_version: 1,
      debits: { [WEEKLY]: { unit: 'allowance', amount: 10, remaining: 10 } }, duration_ms: 100,
      reconciliation_ids: [], slot_released: false,
    } }) });
    const journaled = rowJson({ version: 3, slotsHeld: 0, attempts: JSON.stringify({ 'attempt-1': {
      fingerprint: fp, outcome: 'committed', reservation_version: 1,
      debits: { [WEEKLY]: { unit: 'allowance', amount: 10, remaining: 6 } }, duration_ms: 100,
      reconciliation_ids: ['rec-1'], slot_released: false,
    } }) });
    const dbRec = new ScriptedDb([[committed], [journaled]], [{ error: 'connection-timeout' }]);
    expect(await new CapacityLedger(dbRec, NS, TENANT, DOMAIN)
      .reconcile('attempt-1', fp, EPOCH, WEEKLY, 'rec-1', 4, 94, 'src-1', 1, true))
      .toEqual({ reconciled: true, fullyReconciled: false, reasons: [] });
  });

  it('trusted watermarked reconciliation reduces the hold; replayed or untrusted reflections do not', async () => {
    const { fp } = heldRow();
    const charged = JSON.parse(windowsJson());
    charged[WEEKLY].reserved = 10;
    const committed = rowJson({ version: 2, slotsHeld: 0, windows: JSON.stringify(charged), attempts: JSON.stringify({ 'attempt-1': {
      fingerprint: fp, outcome: 'committed', reservation_version: 1,
      debits: { [WEEKLY]: { unit: 'allowance', amount: 10, remaining: 10 } }, duration_ms: 100,
      reconciliation_ids: [],
    } }) });
    const db = new ScriptedDb([[committed]], [{ rowCount: 1 }]);
    const res = await new CapacityLedger(db, NS, TENANT, DOMAIN)
      .reconcile('attempt-1', fp, EPOCH, WEEKLY, 'rec-1', 10, 100, 'src-2', 1, true);
    expect(res).toEqual({ reconciled: true, fullyReconciled: true, reasons: [] });
    // The journal records the applied id, so a redelivery cannot double-apply.
    const write = db.writes[0]!;
    const patchedAttempts = JSON.parse(write.params[12] as string);
    expect(patchedAttempts['attempt-1'].reconciliation_ids).toEqual(['rec-1']);
    const patchedWindows = JSON.parse(write.params[11] as string);
    expect(patchedWindows[WEEKLY]).toMatchObject({ consumed: 100, reserved: 0 });

    // Same reconciliation id against the post-write row: no second write.
    const applied = rowJson({ version: 3, slotsHeld: 0, attempts: JSON.stringify({ 'attempt-1': {
      fingerprint: fp, outcome: 'reconciled', reservation_version: 1,
      debits: { [WEEKLY]: { unit: 'allowance', amount: 10, remaining: 0 } }, duration_ms: 100,
      reconciliation_ids: ['rec-1'],
    } }) });
    const db2 = new ScriptedDb([[applied]], []);
    const replay = await new CapacityLedger(db2, NS, TENANT, DOMAIN)
      .reconcile('attempt-1', fp, EPOCH, WEEKLY, 'rec-1', 10, 100, 'src-2', 1, true);
    expect(replay).toEqual({ reconciled: true, fullyReconciled: true, reasons: [] });
    expect(db2.writes).toHaveLength(0);

    // Untrusted attribution performs no write and retains the hold.
    const db3 = new ScriptedDb([[]], []);
    const kept = await new CapacityLedger(db3, NS, TENANT, DOMAIN)
      .reconcile('attempt-1', fp, EPOCH, WEEKLY, 'rec-9', 10, 100, 'src-2', null, false);
    expect(kept).toEqual({
      reconciled: false, fullyReconciled: false, reasons: ['uncertain-attribution-hold-retained'],
    });
    expect(db3.seen).toHaveLength(0);
  });
});

describe('capacity-ledger reuses the accepted evaluator', () => {
  function budgetInput(): BudgetInput {
    const windows = [
      {
        providerId: 'prov', poolId: 'pool', kind: 'weekly' as const,
        startAt: 0, resetAt: 10_000, observedAt: 900, sourceRevision: 'fixture', schemaRevision: 'v1',
        unit: 'allowance', quota: 100, consumed: 90, safetyHeadroom: 0, planWeight: 1, dataState: 'known' as const,
      },
      {
        providerId: 'prov', poolId: 'pool', kind: 'five-hour' as const,
        startAt: 0, resetAt: 5_000, observedAt: 900, sourceRevision: 'fixture', schemaRevision: 'v1',
        unit: 'allowance', quota: 50, consumed: 10, safetyHeadroom: 5, planWeight: 1, dataState: 'known' as const,
      },
    ];
    return {
      now: NOW, maxAgeMs: 500, windows, holds: [],
      eligibleBindings: [{
        bindingKey: 'eligible', lane: 'lane', accountId: 'account', providerId: 'prov',
        windowIds: windows.map(w => JSON.stringify([w.providerId, w.poolId, w.kind, w.startAt, w.resetAt])),
        canStart: true, activeSlots: 0, maxSlots: 3, cooldownUntil: null,
        estimate: {
          revision: 'v1', durationMs: 100,
          windows: windows.map(w => ({
            windowId: JSON.stringify([w.providerId, w.poolId, w.kind, w.startAt, w.resetAt]),
            unit: 'allowance', upperBurn: w.kind === 'weekly' ? 10 : 5,
          })),
        },
      }],
    };
  }

  it('derives reserve debits from an admitted binding and nothing from a deferred one', () => {
    const input = budgetInput();
    const evaluation = evaluateBudgets(input);
    expect(evaluation.bindings[0]!.proposal).toBe('admit');
    const attempt = debitsFromBudgetBinding(input.eligibleBindings[0]!, evaluation);
    expect(attempt).not.toBeNull();
    expect(attempt!.debits).toEqual([
      expect.objectContaining({ unit: 'allowance', amount: 10, readReserved: 0 }),
      expect.objectContaining({ unit: 'allowance', amount: 5, readReserved: 0 }),
    ]);
    expect(attempt!.durationMs).toBe(100);

    const exhausted = budgetInput();
    exhausted.windows[0]!.consumed = 100;
    const denied = evaluateBudgets(exhausted);
    expect(denied.bindings[0]!.proposal).toBe('defer');
    expect(debitsFromBudgetBinding(exhausted.eligibleBindings[0]!, denied)).toBeNull();
  });
});
