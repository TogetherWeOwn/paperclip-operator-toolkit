// Coalescing buffer in front of store.noteRejection. The anonymous webhook
// route must not turn every forged request into a storage write. A fixed
// (UTC day, reason) row count alone does not bound write volume.
//
// Each counter instance flushes its first rejection immediately, preserving a
// lone probe's signal, then coalesces a sustained flood by intervalMs. The bound
// is per instance, NOT global: 500 probes against one instance in an interval
// cost one initial write; 500 cold instances can still cost 500 initial writes.
// Distributed collection needs an external global abuse control.
//
// Counts are approximate lower bounds: eviction or failed writes drop buffered
// rejections. They are probing indicators, not delivery evidence. Verified
// deliveries bypass this buffer and persist synchronously before a 200.

export const FLUSH_INTERVAL_MS = 10_000

// The day and the reason are joined with a character that cannot occur in
// either — `YYYY-MM-DD` is digits and dashes, a REJECT.* identifier is
// snake_case. Avoid a literal NUL: git treats such source as binary, which
// text-only secret scans can silently skip. The suite rejects source NUL bytes.
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
        // storage is unavailable — an unauthenticated caller filling the instance's
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
     * operator reading stats sees a current number rather than one
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
