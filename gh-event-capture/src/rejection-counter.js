// Coalescing write buffer in front of `store.noteRejection`.
//
// WHY THIS EXISTS. `POST /gh/webhook` is unauthenticated by construction —
// GitHub has to reach it, so everyone can. Counting rejections per (UTC day,
// reason) instead of storing a row each already bounds how many ROWS a
// passer-by can create: the cardinality is fixed. It does not bound how many
// WRITES they can cause. One `INSERT ... ON CONFLICT` per rejected request
// means an anonymous flood converts directly into D1 write volume, on the same
// Cloudflare account that serves `routeware-shadow-api` in production, against
// an account-level daily write allowance the two Workers share. Attacking the
// security control would degrade an unrelated production service — the worst
// shape this could take, because the endpoint whose job is to notice trouble is
// the lever that causes it.
//
// So the counter buffers in the isolate and settles to D1 at most once per
// `intervalMs`. A flood costs one write per interval per isolate instead of one
// per request.
//
// PER ISOLATE IS THE WHOLE CAVEAT. The sentence above is exact about it; the
// README's narrative was not, and read as though a flood were globally bounded
// (fixed when the per-isolate caveat was documented). Measured: 500 forged requests through ONE isolate cost 1
// write, the same 500 across cold isolates cost 500, because the
// immediate-first-flush below fires once per isolate. The real bound is
// roughly `isolates_touched * (1 + duration / intervalMs)`, and a caller raises
// `isolates_touched` for free by distributing the flood geographically. Capping
// the immediate flush to the first N per isolate does not improve that: the
// cold-isolate case already costs exactly one write per isolate, and no N >= 1
// goes below one. Only dropping the immediate flush would, at the cost of the
// lone-probe signal it exists for.
//
// THE FIRST REJECTION IN AN ISOLATE FLUSHES IMMEDIATELY. Deliberate: a single
// probe against a quiet endpoint is exactly the event worth seeing, and
// buffering it would mean a lone request never lands at all. It is a sustained
// flood that gets coalesced, which is the case where each individual write
// stopped carrying information anyway.
//
// WHAT THIS COSTS, stated plainly because the README promises no hidden
// caveats: the counters become APPROXIMATE AND LOW. Counts buffered when an
// isolate is evicted are lost, and Cloudflare evicts isolates freely. A count
// of 40 means "at least 40". That is an acceptable trade only because these
// counters were never evidence — they answer "is someone probing this
// endpoint?", a question a lower bound answers just as well. Nothing in
// `deliveries` goes through here; every verified delivery is still written
// synchronously, exactly once, before its 200.

export const FLUSH_INTERVAL_MS = 10_000

// The day and the reason are joined with a character that cannot occur in
// either — `YYYY-MM-DD` is digits and dashes, a REJECT.* identifier is
// snake_case. Not a NUL: a NUL byte in a source file makes git treat it as
// binary, which silently removed this module's neighbour from CI's `git grep -I`
// secret scan on 2026-08-24. The suite now asserts no source file contains one.
const SEP = '|'

/**
 * @param {object} deps
 * @param {any} deps.store                 anything with `noteRejection(day, reason, count)`
 * @param {() => number} [deps.now]
 * @param {number} [deps.intervalMs]       0 disables buffering (writes through)
 * @returns {{ note: (day: string, reason: string) => Promise<void>,
 *             flush: () => Promise<void>,
 *             pending: () => number }}
 */
export function createRejectionCounter({ store, now = () => Date.now(), intervalMs = FLUSH_INTERVAL_MS }) {
  /** @type {Map<string, number>} */
  const buffered = new Map()
  /** @type {number | null} */
  let nextFlushMs = null

  async function flush() {
    if (buffered.size === 0) return
    // Snapshot and clear BEFORE awaiting, so rejections arriving during the
    // flush accumulate into the next window rather than being double-counted
    // or lost to the clear that follows the await.
    const batch = [...buffered.entries()]
    buffered.clear()

    for (const [key, count] of batch) {
      const at = key.indexOf(SEP)
      try {
        await store.noteRejection(key.slice(0, at), key.slice(at + 1), count)
      } catch {
        // A failed counter write is dropped, never retried and never rethrown.
        //
        // Rethrowing would turn a 401 into a 500, which is strictly worse: it
        // tells a prober their forgery broke something, and GitHub retries a
        // 5xx. Retrying in-process would grow this buffer without bound while
        // D1 is unavailable — an unauthenticated caller filling the isolate's
        // memory, which is the failure this module exists to prevent, moved one
        // layer down. Losing a lower-bound counter is the cheapest thing here.
      }
    }
  }

  return {
    async note(day, reason) {
      const key = `${day}${SEP}${reason}`
      buffered.set(key, (buffered.get(key) ?? 0) + 1)

      const t = now()
      if (nextFlushMs !== null && t < nextFlushMs) return // inside the window: buffer only
      nextFlushMs = t + intervalMs
      await flush()
    },

    /**
     * Settle the buffer now. Called on the AUTHENTICATED read paths so an
     * operator running `query.sh stats` sees a current number rather than one
     * lagging by up to `intervalMs` — a read cannot be used to force writes,
     * because reaching it costs a valid QUERY_TOKEN.
     */
    flush,

    /** Buffered-but-unwritten total. Test seam and health reporting. */
    pending() {
      let n = 0
      for (const c of buffered.values()) n += c
      return n
    },
  }
}
