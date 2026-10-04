/**
 * The one hard-return-by-deadline row walk shared by every
 * row-walking scheduled pass (classifyIssues, labelOnlyPass, repinPass,
 * balancePass).
 *
 * The 2026-10-01 postmortem: rows cost 40-95 s each in host RPC
 * (`describeIssue`, `advise`, `ctx.issues.get`, the classifier call), and a
 * between-row deadline check cannot contain a row that is already running —
 * an admitted row ran ~95 s past the budget into the host's 300 s `runJob`
 * wall (labelOnly 11/24, balance 8/24, repin 2/24 firings failed at 301 s).
 * Each pass used to carry its own copy of the loop, and three of the four
 * left a host read outside the race. One walk, used everywhere, owns:
 *
 *  1. ADAPTIVE ADMISSION — a row starts only when the remaining budget
 *     covers both the fixed row slice AND 1.5x the slowest row this firing;
 *  2. a HARD RETURN — the caller's WHOLE row body races the remaining
 *     budget, so the walk returns by the deadline whatever the row is doing;
 *     a timer win abandons the row, which counts as NOT examined (the cursor
 *     stops before it and next firing retries it). The abandoned promise
 *     keeps running, so every write in a row body must sit behind the
 *     caller's write gate (`Date.now() >= deadlineAt || row slice spent`),
 *     which refuses to commit past the deadline;
 *  3. an optional per-firing ROW CAP;
 *  4. the SETTLED PREFIX — how many leading rows the scan cursor may pass.
 */

/** What a pass's row body reports for one row. */
export type RowVerdict =
  /** Decided (written, elided, or skipped by design): the cursor may pass it. */
  | "settled"
  /** Seen but not handled (the write gate refused a slow row): retry it. */
  | "unsettled"
  /** Settled, and the caller's own limit (write cap, batch size) ends the walk. */
  | "stop";

export interface RowWalkLimits {
  /** Absolute epoch-ms deadline; `null` walks unbounded (no race, no admission). */
  deadlineAt: number | null;
  /** The fixed per-row slice — the admission floor before any row has run. */
  rowTimeoutMs: number;
  /** Optional cap on rows examined per firing. */
  maxRows?: number;
  /**
   * The slowest row already seen this firing (an earlier company's walk):
   * admission is 1.5x the slowest row of the FIRING, not of this walk.
   */
  slowestRowMs?: number;
}

export interface RowWalk<R> {
  /** Rows whose body finished, in walk order. An abandoned row is NOT here. */
  examined: R[];
  /**
   * Leading input rows the scan cursor may pass: every row before the first
   * unsettled, abandoned or unreached one.
   */
  settledPrefix: number;
  /** Rows the body reported `unsettled`. */
  unsettled: number;
  /** Wall time of the slowest row this firing (seed included), abandoned row included. */
  slowestRowMs: number;
  /** Admission refused for lack of budget, or a row abandoned at the deadline. */
  budgetExhausted: boolean;
  rowCapHit: boolean;
  /** The body returned `stop`. */
  stoppedByCaller: boolean;
  /** The row still running at the deadline: its outcome is unknown. */
  abandoned: { row: R; rowDurationMs: number } | null;
}

/**
 * Race `work` against `deadlineAt`. Settles `{ timedOut: true }` on a timer
 * win and `{ timedOut: false, value }` otherwise; the timer is always cleared
 * on settle and unref'd so a raced loser never holds the worker open. A
 * rejection of `work` before the deadline still rejects (the caller's own
 * try/catch owns row errors); a rejection after a timer win is swallowed by
 * the attached handler, so no unhandled rejection escapes either way.
 */
export async function runRowWithinBudget<T>(
  work: Promise<T>,
  deadlineAt: number,
): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    work.catch(() => undefined);
    return { timedOut: true };
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      work.then((value) => ({ timedOut: false as const, value })),
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), remainingMs);
        // The host wall (not this timer) owns job death.
        (timer as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Adaptive admission: the fixed slice alone admits a row with 30 s left that
 * then spends the observed 95 s. The headroom is the larger of the fixed
 * slice and 1.5x the slowest row this firing (the live cost of a row on THIS
 * board). Before any row has run, `slowestRowMs` is 0 and this is exactly
 * the fixed-slice check.
 */
export function rowAdmissionHeadroomMs(rowTimeoutMs: number, slowestRowMs: number): number {
  return Math.max(rowTimeoutMs, Math.ceil(1.5 * slowestRowMs));
}

/** Walk `rows` in order under `limits`, racing each `perRow` body. */
export async function walkRowsWithinDeadline<R>(
  rows: readonly R[],
  limits: RowWalkLimits,
  perRow: (row: R, rowStartedAt: number) => Promise<RowVerdict>,
): Promise<RowWalk<R>> {
  const walk: RowWalk<R> = {
    examined: [],
    settledPrefix: 0,
    unsettled: 0,
    slowestRowMs: limits.slowestRowMs ?? 0,
    budgetExhausted: false,
    rowCapHit: false,
    stoppedByCaller: false,
    abandoned: null,
  };
  let prefixOpen = true;
  for (const row of rows) {
    if (limits.maxRows !== undefined && walk.examined.length >= limits.maxRows) {
      walk.rowCapHit = true;
      break;
    }
    if (
      limits.deadlineAt !== null &&
      limits.deadlineAt - Date.now() < rowAdmissionHeadroomMs(limits.rowTimeoutMs, walk.slowestRowMs)
    ) {
      walk.budgetExhausted = true;
      break;
    }
    const rowStartedAt = Date.now();
    // Invoked inside the async wrapper so a body that throws synchronously
    // still lands in the race's rejection path.
    const work = (async () => perRow(row, rowStartedAt))();
    const outcome =
      limits.deadlineAt === null
        ? { timedOut: false as const, value: await work }
        : await runRowWithinBudget(work, limits.deadlineAt);
    const rowDurationMs = Date.now() - rowStartedAt;
    if (rowDurationMs > walk.slowestRowMs) walk.slowestRowMs = rowDurationMs;
    if (outcome.timedOut) {
      walk.budgetExhausted = true;
      walk.abandoned = { row, rowDurationMs };
      break;
    }
    walk.examined.push(row);
    if (outcome.value === "unsettled") {
      walk.unsettled += 1;
      prefixOpen = false;
    } else if (prefixOpen) {
      walk.settledPrefix += 1;
    }
    if (outcome.value === "stop") {
      walk.stoppedByCaller = true;
      break;
    }
  }
  return walk;
}

function updatedAtMs(row: unknown): number | null {
  const raw = row && typeof row === "object" ? (row as Record<string, unknown>).updated_at : undefined;
  const ms = raw instanceof Date ? raw.getTime() : typeof raw === "string" ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The scan mark after a walk over `rows` (fetched `updated_at asc`, read
 * back with `updated_at > mark`), or `null` to leave the mark where it is.
 *
 * - Every row settled and the fetch drained: the firing start.
 * - Otherwise the mark is a CURSOR: it moves past the settled prefix and
 *   stops before the first row that is unsettled, abandoned or unreached.
 *   The old rule — creep to the OLDEST examined row — re-read every examined
 *   row next firing; once a deadline-bounded walk reached only a handful of
 *   rows per firing, the pass re-walked the same decided-without-write rows
 *   forever and never reached the rest.
 * - `>` hides a row that shares the mark's timestamp, so the mark backs off
 *   one millisecond below the first unpassed row when that row is not
 *   provably newer — and below the last settled row of a capped fetch, whose
 *   next row is unseen. Re-reading a settled row is harmless; skipping an
 *   unsettled one is the starvation bug.
 * - Rows without a parseable `updated_at` never move the mark.
 */
export function scanMarkAfterWalk(
  rows: readonly unknown[],
  settledPrefix: number,
  fetchLimit: number,
  firingStartMs: number,
): number | null {
  if (settledPrefix >= rows.length && rows.length < fetchLimit) return firingStartMs;
  let lastSettled: number | null = null;
  for (const row of rows.slice(0, settledPrefix)) {
    const ms = updatedAtMs(row);
    if (ms !== null && (lastSettled === null || ms > lastSettled)) lastSettled = ms;
  }
  if (lastSettled === null) return null;
  let firstUnpassed: number | null = null;
  for (const row of rows.slice(settledPrefix)) {
    const ms = updatedAtMs(row);
    if (ms !== null && (firstUnpassed === null || ms < firstUnpassed)) firstUnpassed = ms;
  }
  if (firstUnpassed === null) return lastSettled - 1;
  return Math.min(lastSettled, firstUnpassed - 1);
}
