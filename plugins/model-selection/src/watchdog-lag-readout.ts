/**
 * watchdog lag-detector sweep wire-up — propose-only freshness readout.
 *
 * Parent  under epic . Consumes the
 * done  decision-log-lag pure module in the scheduled sweep path.
 * Executor: DevOps & Reliability Engineer. Scope (<=4h, read-only,
 * propose-only, no live mutation).
 *
 * WHAT IT IS:
 * - The sweep-path adapter over `detectDecisionLogLag`: the scheduled sweep
 *   already reads decision shards (`decisions-YYYY-MM-DD-HHZ.jsonl` lines are
 *   `ShadowDecisionRecord`s with `issueId`, `writer`, `ts`). This module maps
 *   those already-authorized observations to lag emits and returns the
 *   detector's verdict plus proposal SHAPE. It never reads folders, never
 *   resolves secrets, never writes ledgers, never routes an alert, never
 *   recovers anything, never touches the host.
 * - `recordId` is `${issueId}:${writer}:${ts}`: the host/shadow pair shares
 *   one issue AND one ts by construction, so the writer is what keeps the two
 *   projections distinct; the ts is what keeps successive decisions on one
 *   issue distinct.
 * - An unparseable `ts` is an unobserved emit (null), matching the detector's
 *   null-emit handling: it reads as `unknown` and is excluded from the max,
 *   never as fresh.
 * - Byte-identical re-reads (legacy `decisions.jsonl` plus its hourly shard
 *   during upgrade overlap) collapse to one observation; anything else
 *   sharing a recordId fails closed in the detector.
 *
 * THRESHOLDS (defaults, re-exported from the detector):
 * - warn 600 s: one full 10-minute scheduled-pass interval with no fresh
 *   visible decision. crit 3600 s: one full hourly shard interval with no
 *   fresh visible decision. Per-call overrides are validated by the detector
 *   (0 < warn < crit); blended or non-positive bands throw.
 *
 * CALLER CONTRACT: pass the newest distinct observations, newest-first, at
 * most 256 (the detector's cap — more throws rather than silently dropping
 * the stalest line, which would read as fresher than the log is).
 *
 * NON-GOALS (owned elsewhere, do NOT duplicate):
 * - shadow-emit gap (blocked): missing records; this measures LAG
 *   of present records, never completeness.
 * - proposal-delivery (in_progress): proposal transport, not lag
 *   measurement.
 * - run-stall (done): run progress, not decision visibility.
 */

import {
  CRIT_LAG_SECONDS,
  WARN_LAG_SECONDS,
  detectDecisionLogLag,
  type DecisionLogEmitObservation,
  type DecisionLogLagResult,
  type DecisionLogLagThresholds,
} from "./decision-log-lag.js";

/** One full 10-minute scheduled-pass interval with no fresh decision: warn. */
export const SWEEP_LAG_WARN_SECONDS = WARN_LAG_SECONDS;
/** One full hourly shard interval with no fresh decision: crit. */
export const SWEEP_LAG_CRIT_SECONDS = CRIT_LAG_SECONDS;

/**
 * One parsed decision-log line as the sweep observed it. Structurally
 * compatible with `ShadowDecisionRecord` (shadow-emit.ts), so the sweep can
 * pass records straight through; only these three fields are read.
 */
export interface SweepLagDecision {
  issueId: string;
  writer: string;
  /** ISO timestamp of the decision emit; unparseable reads as unobserved. */
  ts: string;
}

export interface SweepLagReadoutInput {
  /** Sweep-observed epoch ms (when the caller saw the log). */
  now: number;
  /** Newest distinct observations, newest-first, at most 256. */
  decisions: readonly SweepLagDecision[];
  /** Optional override of the defaults; validated when present. */
  thresholds?: DecisionLogLagThresholds;
}

function fail(reason: string): never {
  throw new Error(reason);
}

/**
 * Sweep-path freshness readout over decision-log emits. Pure: maps the
 * caller's observations to lag emits and delegates to the 
 * detector. Always returns the full result including the proposal SHAPE —
 * never a bare verdict, never a routed alert, never a recovery.
 */
export function readoutSweepLagFreshness(input: SweepLagReadoutInput): DecisionLogLagResult {
  const seen = new Set<string>();
  const emits: DecisionLogEmitObservation[] = [];
  // The detector's record-id alphabet excludes `+` (ISO `+00:00` offsets),
  // so the timestamp portion is epoch ms, never the raw string. Unparseable
  // timestamps keep distinctness through a per-call counter suffix; they are
  // unknown either way and excluded from the max.
  let unparseableCount = 0;
  for (const decision of input.decisions) {
    if (
      !decision ||
      typeof decision.issueId !== "string" ||
      decision.issueId.length === 0 ||
      typeof decision.writer !== "string" ||
      decision.writer.length === 0 ||
      typeof decision.ts !== "string" ||
      decision.ts.length === 0
    ) {
      fail("invalid-sweep-lag-decision");
    }
    const emitMs = Date.parse(decision.ts);
    const recordId = Number.isFinite(emitMs)
      ? `${decision.issueId}:${decision.writer}:${emitMs}`
      : `${decision.issueId}:${decision.writer}:unparseable-${unparseableCount}`;
    if (Number.isFinite(emitMs)) {
      if (seen.has(recordId)) continue;
    } else {
      unparseableCount += 1;
    }
    seen.add(recordId);
    emits.push({ recordId, emitAt: Number.isFinite(emitMs) ? emitMs : null });
  }
  return detectDecisionLogLag({ now: input.now, emits, thresholds: input.thresholds });
}
