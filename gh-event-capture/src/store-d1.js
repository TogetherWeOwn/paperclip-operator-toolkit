// Cloudflare D1 store. The durable half of the control.
//
// Every statement here is parameterised. There is no string interpolation into
// SQL anywhere in this file and there must never be one: `repository`, `sender`
// and `event` all arrive from a query string on a public host.
//
// Append-only is enforced in the SCHEMA (see `migrations/d1/0001_init.sql`),
// not here — a trigger refuses UPDATE and DELETE on `deliveries` for every
// caller, including a future version of this file. That is a real property of
// the database rather than a discipline this module happens to keep. Its limit
// is stated plainly in the README: anyone with Cloudflare account access can
// drop the trigger, and dropping it is not itself recorded.

const COLUMNS = [
  'delivery_id',
  'received_at',
  'received_ms',
  'event',
  'action',
  'sender',
  'repository',
  'organization',
  'installation_id',
  'hook_id',
  'target_type',
  'signature',
  'body_sha256',
  'body_bytes',
  'body_truncated',
  'body',
  'headers_json',
]

// Everything except the raw body — the default shape of a list result.
const LIST_COLUMNS = COLUMNS.filter((c) => c !== 'body').join(', ')

const INSERT = `INSERT OR IGNORE INTO deliveries (${COLUMNS.join(', ')})
                VALUES (${COLUMNS.map(() => '?').join(', ')})`

/**
 * @param {D1Database} db
 * @returns {object} store
 */
export function createD1Store(db) {
  return {
    /**
     * @param {any} r
     * @returns {Promise<{ inserted: boolean }>}
     */
    async append(r) {
      const res = await db
        .prepare(INSERT)
        .bind(...COLUMNS.map((c) => r[c] ?? null))
        .run()
      // `INSERT OR IGNORE` succeeds with zero changes when the delivery id is
      // already present. That is the dedupe: a GitHub retry lands here and
      // changes nothing, and the caller answers 200 so the retries stop.
      return { inserted: (res.meta?.changes ?? 0) > 0 }
    },

    /**
     * @param {string} deliveryId
     * @returns {Promise<any | null>}
     */
    async get(deliveryId) {
      return await db
        .prepare(`SELECT ${COLUMNS.join(', ')} FROM deliveries WHERE delivery_id = ?`)
        .bind(deliveryId)
        .first()
    },

    /**
     * @param {any} f  filters from `parseQuery`
     * @returns {Promise<any[]>}
     */
    async list(f) {
      const where = []
      const bind = []

      for (const col of ['event', 'action', 'repository', 'sender', 'organization', 'delivery_id']) {
        if (f[col]) {
          where.push(`${col} = ?`)
          bind.push(f[col])
        }
      }
      if (f.sinceMs !== null) {
        where.push('received_ms >= ?')
        bind.push(f.sinceMs)
      }
      if (f.untilMs !== null) {
        where.push('received_ms <= ?')
        bind.push(f.untilMs)
      }
      if (f.cursor) {
        // Keyset pagination. OFFSET would re-scan and, worse, would shift under
        // a concurrently-arriving delivery — this store is written to while it
        // is being read.
        where.push('(received_ms < ? OR (received_ms = ? AND delivery_id < ?))')
        bind.push(f.cursor.receivedMs, f.cursor.receivedMs, f.cursor.deliveryId)
      }

      const cols = f.includeBody ? COLUMNS.join(', ') : LIST_COLUMNS
      const sql =
        `SELECT ${cols} FROM deliveries` +
        (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
        ' ORDER BY received_ms DESC, delivery_id DESC LIMIT ?'

      const res = await db
        .prepare(sql)
        .bind(...bind, f.limit)
        .all()
      return res.results ?? []
    },

    /**
     * Bounded counter — one row per (UTC day, reason), never one per request.
     * The webhook route is unauthenticated by construction; a per-request row
     * would be an open write channel into the store the control depends on.
     *
     * `count` is an INCREMENT, not a total, because callers arrive coalesced:
     * `rejection-counter.js` buffers in the isolate and settles here at most
     * once per interval. Bounding the row cardinality was never enough on its
     * own — it left write VOLUME unbounded on an account shared with a
     * production Worker. Read that module's header before changing this.
     *
     * @param {string} day  `YYYY-MM-DD`
     * @param {string} reason  a `REJECT.*` identifier
     * @param {number} [count]  how many to add; must be a positive integer
     */
    async noteRejection(day, reason, count = 1) {
      const n = Number.isInteger(count) && count > 0 ? count : 1
      await db
        .prepare(
          `INSERT INTO rejections (day, reason, count) VALUES (?, ?, ?)
           ON CONFLICT(day, reason) DO UPDATE SET count = count + excluded.count`,
        )
        .bind(day, reason, n)
        .run()
    },

    /** @returns {Promise<any>} */
    async stats() {
      const totals = await db
        .prepare(
          `SELECT COUNT(*) AS deliveries,
                  MIN(received_ms) AS oldest_ms,
                  MAX(received_ms) AS newest_ms
             FROM deliveries`,
        )
        .first()

      const byEvent = await db
        .prepare('SELECT event, COUNT(*) AS count FROM deliveries GROUP BY event ORDER BY count DESC, event ASC')
        .all()

      // Last 30 days is a display bound, not a retention bound: nothing is
      // deleted. `GET /events?since=…` still reaches every row ever stored.
      const rejections = await db
        .prepare('SELECT day, reason, count FROM rejections ORDER BY day DESC, reason ASC LIMIT 30')
        .all()

      return {
        deliveries: totals?.deliveries ?? 0,
        oldest_received_at: totals?.oldest_ms ? new Date(totals.oldest_ms).toISOString() : null,
        newest_received_at: totals?.newest_ms ? new Date(totals.newest_ms).toISOString() : null,
        by_event: byEvent.results ?? [],
        rejections: rejections.results ?? [],
      }
    },

    /**
     * Claim a bridge de-dupe key. `INSERT OR IGNORE` either wins the claim or
     * changes nothing — see `migrations/d1/0002_bridge_claims.sql`.
     *
     * @param {{ claimKey: string, issueRef: string, headSha: string | null, kind: string, deliveryId: string, claimedMs: number }} c
     * @returns {Promise<{ claimed: boolean }>}
     */
    async claimBridge({ claimKey, issueRef, headSha, kind, deliveryId, claimedMs }) {
      const res = await db
        .prepare(
          `INSERT OR IGNORE INTO bridge_claims
             (claim_key, issue_ref, head_sha, kind, delivery_id, claimed_at, claimed_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(claimKey, issueRef, headSha ?? null, kind, deliveryId, new Date(claimedMs).toISOString(), claimedMs)
        .run()
      return { claimed: (res.meta?.changes ?? 0) > 0 }
    },

    /**
     * @param {{ issueRef?: string | null, limit: number }} f
     * @returns {Promise<any[]>}
     */
    async listBridgeClaims(f) {
      const where = []
      const bind = []
      if (f.issueRef) {
        where.push('issue_ref = ?')
        bind.push(f.issueRef)
      }
      const sql =
        'SELECT claim_key, issue_ref, head_sha, kind, delivery_id, claimed_at, claimed_ms FROM bridge_claims' +
        (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
        ' ORDER BY claimed_ms DESC LIMIT ?'
      const res = await db
        .prepare(sql)
        .bind(...bind, f.limit)
        .all()
      return res.results ?? []
    },
  }
}
