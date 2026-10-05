// In-memory store. Test double for `store-d1.js`, and the reason the whole
// suite runs with `node --test` and no credentials, no network and no
// Cloudflare account (CONTRIBUTING § "What done means", item 6: if a change can
// only be tested against the real thing, it will stop being tested).
//
// It must mirror the D1 adapter's OBSERVABLE semantics exactly — the same
// dedupe behaviour, the same ordering, the same append-only refusal — or the
// suite passes against something the deployment does not do. Where the two
// could drift, the SQL is the specification and this file follows it.

/**
 * @returns {object} a store with the same surface as `createD1Store`
 */
export function createMemoryStore() {
  /** @type {Map<string, any>} */
  const rows = new Map()
  /** @type {Map<string, number>} */
  const rejections = new Map()
  /** @type {Map<string, any>} mirrors bridge_claims, keyed on claim_key */
  const bridgeClaims = new Map()

  // How many times `noteRejection` was actually CALLED, as distinct from how
  // much it counted. In D1 one call is one write, so this is the suite's proxy
  // for write volume — the quantity `rejection-counter.js` exists to bound. A
  // test that only checked the totals would pass just as happily against the
  // per-request version that could burn a shared production D1 allowance.
  let noteRejectionCalls = 0

  /** Mirrors `deliveries_no_update` / `deliveries_no_delete` in the migration. */
  const APPEND_ONLY = 'deliveries is append-only'

  return {
    /**
     * @param {any} record
     * @returns {Promise<{ inserted: boolean }>}
     */
    async append(record) {
      // INSERT OR IGNORE. GitHub retries a delivery it did not see a 2xx for,
      // and a retry carries the SAME X-GitHub-Delivery — so a duplicate is
      // normal traffic, not an error, and must not overwrite the first receipt.
      if (rows.has(record.delivery_id)) return { inserted: false }
      rows.set(record.delivery_id, { ...record })
      return { inserted: true }
    },

    /**
     * @param {string} deliveryId
     * @returns {Promise<any | null>}
     */
    async get(deliveryId) {
      const row = rows.get(deliveryId)
      return row ? { ...row } : null
    },

    /**
     * @param {any} filters from `parseQuery`
     * @returns {Promise<any[]>}
     */
    async list(filters) {
      let out = [...rows.values()]

      for (const key of ['event', 'action', 'repository', 'sender', 'organization', 'delivery_id']) {
        const want = filters[key]
        if (want) out = out.filter((r) => r[key] === want)
      }
      if (filters.sinceMs !== null) out = out.filter((r) => r.received_ms >= filters.sinceMs)
      if (filters.untilMs !== null) out = out.filter((r) => r.received_ms <= filters.untilMs)

      // Newest first, delivery_id breaking ties so the keyset cursor is total.
      out.sort((a, b) =>
        b.received_ms - a.received_ms || (a.delivery_id < b.delivery_id ? 1 : a.delivery_id > b.delivery_id ? -1 : 0),
      )

      if (filters.cursor) {
        const { receivedMs, deliveryId } = filters.cursor
        out = out.filter(
          (r) => r.received_ms < receivedMs || (r.received_ms === receivedMs && r.delivery_id < deliveryId),
        )
      }

      return out.slice(0, filters.limit).map((r) => {
        const { body, headers_json, ...rest } = r
        return filters.includeBody ? { ...rest, headers_json, body } : { ...rest, headers_json }
      })
    },

    /**
     * Bounded counter, keyed on (UTC day, reason). Deliberately NOT a row per
     * rejected request: this endpoint is unauthenticated by construction, so a
     * per-request row would hand any passer-by an unbounded write channel into
     * the store the control depends on.
     *
     * `count` is an INCREMENT, mirroring the D1 adapter's `count + excluded.count`.
     * Callers arrive coalesced from `rejection-counter.js`.
     *
     * @param {string} day  `YYYY-MM-DD`
     * @param {string} reason  a `REJECT.*` identifier
     * @param {number} [count]  how many to add; must be a positive integer
     */
    async noteRejection(day, reason, count = 1) {
      const n = Number.isInteger(count) && count > 0 ? count : 1
      const key = `${day}|${reason}`
      rejections.set(key, (rejections.get(key) ?? 0) + n)
      noteRejectionCalls++
    },

    /** @returns {Promise<any>} */
    async stats() {
      const all = [...rows.values()]
      /** @type {Map<string, number>} */
      const byEvent = new Map()
      for (const r of all) byEvent.set(r.event, (byEvent.get(r.event) ?? 0) + 1)

      const times = all.map((r) => r.received_ms).sort((a, b) => a - b)
      return {
        deliveries: all.length,
        oldest_received_at: times.length ? new Date(times[0]).toISOString() : null,
        newest_received_at: times.length ? new Date(times[times.length - 1]).toISOString() : null,
        by_event: [...byEvent.entries()]
          .map(([event, count]) => ({ event, count }))
          .sort((a, b) => b.count - a.count || (a.event < b.event ? -1 : 1)),
        rejections: [...rejections.entries()]
          .map(([k, count]) => {
            const [day, reason] = k.split('|')
            return { day, reason, count }
          })
          .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : a.reason < b.reason ? -1 : 1)),
      }
    },

    /**
     * @param {{ claimKey: string, issueRef: string, headSha: string | null, kind: string, deliveryId: string, claimedMs: number }} c
     * @returns {Promise<{ claimed: boolean }>}
     */
    async claimBridge({ claimKey, issueRef, headSha, kind, deliveryId, claimedMs }) {
      if (bridgeClaims.has(claimKey)) return { claimed: false }
      bridgeClaims.set(claimKey, {
        claim_key: claimKey,
        issue_ref: issueRef,
        head_sha: headSha ?? null,
        kind,
        delivery_id: deliveryId,
        claimed_at: new Date(claimedMs).toISOString(),
        claimed_ms: claimedMs,
      })
      return { claimed: true }
    },

    /**
     * @param {{ issueRef?: string | null, limit: number }} f
     * @returns {Promise<any[]>}
     */
    async listBridgeClaims(f) {
      let out = [...bridgeClaims.values()]
      if (f.issueRef) out = out.filter((c) => c.issue_ref === f.issueRef)
      out.sort((a, b) => b.claimed_ms - a.claimed_ms)
      return out.slice(0, f.limit).map((c) => ({ ...c }))
    },

    // Test-only seams. Not part of the D1 adapter's surface; the suite uses
    // them to assert that append-only is a property of the STORE and not a
    // politeness the app happens to observe.
    _forbiddenMutation() {
      throw new Error(APPEND_ONLY)
    },
    _size() {
      return rows.size
    },
    /** Write volume, not counted volume. See `noteRejectionCalls` above. */
    _noteRejectionCalls() {
      return noteRejectionCalls
    },
  }
}
