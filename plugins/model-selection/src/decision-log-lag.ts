/**
 * : watchdog decision-log lag detector — emit vs observed (propose-only).
 *
 * Parent  (watchdog detector; complements in_progress  /
 * ). Executor: DevOps & Reliability Engineer.
 * Scope (<=4h, read-only, propose-only, no live mutation).
 *
 * WHAT IT IS:
 * - A pure lag function over decision-log timestamps: each record's
 *   scheduled-job EMIT timestamp (`record.ts`, written when `advise()` /
 *   `apply()` serializes the host/shadow pair into its hour shard
 *   `decisions-YYYY-MM-DD-HHZ.jsonl`) versus the SWEEP-OBSERVED timestamp
 *   (`now`, supplied by the authorized caller that listed/read the shard).
 * - `lagSeconds = floor((observedMs - emitMs) / 1000)` per computable record;
 *   the detector verdict follows the MAX lag across records against warn/crit
 *   thresholds, and always returns a proposal SHAPE (never routes an alert,
 *   never recovers anything).
 * - Caller supplies already-authorized observations; this module never fetches,
 *   never reads folders, never resolves secrets, never writes ledgers, never
 *   routes alerts, never touches the host.
 *
 * THRESHOLDS (defaults):
 * - warn 600 s: one full 10-minute scheduled-pass interval (worker.ts) with no
 *   fresh visible decision — the sweep is looking at a stale log.
 * - crit 3600 s: one full hourly shard interval with no fresh visible
 *   decision — an entire shard hour went unseen.
 * - Overrides are accepted per call (validated: 0 < warn < crit) so tests and
 *   future callers can tighten/loosen without forking the module.
 *
 * NON-GOALS (owned elsewhere, do NOT duplicate):
 * -  shadow-emit gap (blocked): missing records; this measures LAG
 *   of present records, never completeness.
 * -  quota-expiry (blocked): quota windows, not log freshness.
 * -  run-stall (in_progress): run progress, not decision visibility.
 * -  exit-143 probe (in_progress): OOM probe, not log lag.
 * -  stale-review (blocked): review age, not decision-log age.
 * -  /  proposal-delivery (blocked / in_progress):
 *   proposal transport, not lag measurement.
 * -  host-disk (done): disk pressure, not log freshness.
 * -  red-main triage (done): CI triage, not log lag.
 * -  supply-famine (in_progress): capacity famine, not log lag.
 */

export const DECISION_LOG_LAG_SCHEMA = "decision-log-lag-v1";

/** One full 10-minute scheduled-pass interval with no fresh decision: warn. */
export const WARN_LAG_SECONDS = 600;
/** One full hourly shard interval with no fresh decision: crit. */
export const CRIT_LAG_SECONDS = 3600;

export const MAX_LAG_RECORDS = 256;
export const MAX_BREACH_IDS = 32;

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const clock = (n: unknown): n is number => finite(n) && (n as number) >= 0;

/** One decision-log record's emit observation, supplied by the caller. */
export interface DecisionLogEmitObservation {
  recordId: string;
  /** Epoch ms of `record.ts`; null/undefined means unobserved. */
  emitAt?: number | null;
}

export interface DecisionLogLagThresholds {
  warnSeconds: number;
  critSeconds: number;
}

export interface DecisionLogLagInput {
  /** Sweep-observed epoch ms (when the caller saw the log). */
  now: number;
  emits: DecisionLogEmitObservation[];
  /** Optional override of the defaults; validated when present. */
  thresholds?: DecisionLogLagThresholds;
}

export type LagRecordStatus = "ok" | "warn" | "crit" | "unknown";

export interface DecisionLogLagRecord {
  recordId: string;
  emitAt: number | null;
  /** Null when emit is unobserved or in the future (clock skew). */
  lagSeconds: number | null;
  status: LagRecordStatus;
}

export type LagVerdict = "ok" | "warn" | "crit" | "unknown";

export type LagProposalAction = "none" | "investigate" | "propose-escalation";

export interface DecisionLogLagProposal {
  action: LagProposalAction;
  reason: string;
  /** Max computable lag; null when nothing was computable. */
  maxLagSeconds: number | null;
  /** The breached threshold, or null when nothing breached. */
  thresholdSeconds: number | null;
  /** Sorted, capped ids at/above the breached threshold. */
  breachingRecordIds: string[];
  /** Propose-only proof: this object is never sent anywhere by this module. */
  routedAsAlert: false;
  autoRecoveryAttempted: false;
}

export interface DecisionLogLagResult {
  schema: typeof DECISION_LOG_LAG_SCHEMA;
  mode: "propose-only";
  routesAlerts: false;
  autoRecovers: false;
  evaluatedAt: number;
  observedAt: number;
  recordCount: number;
  computableCount: number;
  /** Max computable lag; null when nothing was computable. */
  maxLagSeconds: number | null;
  verdict: LagVerdict;
  lags: DecisionLogLagRecord[];
  proposal: DecisionLogLagProposal;
  rollbackNotes: string[];
  limitations: string[];
}

function fail(reason: string): never {
  throw new Error(reason);
}

function resolveThresholds(input: DecisionLogLagInput): { warn: number; crit: number } {
  if (input.thresholds === undefined) return { warn: WARN_LAG_SECONDS, crit: CRIT_LAG_SECONDS };
  const t = input.thresholds;
  if (!t || !finite(t.warnSeconds) || t.warnSeconds <= 0) fail("invalid-lag-warn-threshold");
  if (!finite(t.critSeconds) || t.critSeconds <= 0) fail("invalid-lag-crit-threshold");
  if (!(t.warnSeconds < t.critSeconds)) fail("lag-threshold-bands-must-separate");
  return { warn: t.warnSeconds, crit: t.critSeconds };
}

function validateInput(input: DecisionLogLagInput): void {
  if (!clock(input.now)) fail("invalid-lag-clock");
  if (!Array.isArray(input.emits) || input.emits.length > MAX_LAG_RECORDS) fail("too-many-lag-records");
  const ids = new Set<string>();
  for (const emit of input.emits) {
    if (!emit || typeof emit.recordId !== "string" || !ID_RE.test(emit.recordId) || ids.has(emit.recordId)) {
      fail("invalid-lag-record-identity");
    }
    ids.add(emit.recordId);
    if (emit.emitAt !== undefined && emit.emitAt !== null && !clock(emit.emitAt)) fail("invalid-lag-emit-at");
  }
  resolveThresholds(input);
}

function statusFor(lagSeconds: number | null, warn: number, crit: number): LagRecordStatus {
  if (lagSeconds === null) return "unknown";
  if (lagSeconds >= crit) return "crit";
  if (lagSeconds >= warn) return "warn";
  return "ok";
}

/**
 * Pure emit-vs-observed lag detector. Never fetches, never writes, never
 * routes, never recovers — it returns a verdict plus a proposal SHAPE.
 *
 * A future-dated emit (`emitAt > now`) is clock skew, not a negative lag: the
 * record is `unknown` and excluded from the max, so skew can never read as a
 * fresh (all-clear) measurement.
 */
export function detectDecisionLogLag(input: DecisionLogLagInput): DecisionLogLagResult {
  validateInput(input);
  const { warn, crit } = resolveThresholds(input);

  const lags: DecisionLogLagRecord[] = input.emits.map((emit) => {
    const emitAt = emit.emitAt ?? null;
    // Null emit or future emit: uncomputable. Future is skew, not freshness.
    const lagSeconds =
      emitAt === null || emitAt > input.now ? null : Math.floor((input.now - emitAt) / 1000);
    return { recordId: emit.recordId, emitAt, lagSeconds, status: statusFor(lagSeconds, warn, crit) };
  });

  const computable = lags.filter((l) => l.lagSeconds !== null);
  const maxLagSeconds = computable.length > 0 ? Math.max(...computable.map((l) => l.lagSeconds as number)) : null;

  const verdict: LagVerdict =
    maxLagSeconds === null ? "unknown" : maxLagSeconds >= crit ? "crit" : maxLagSeconds >= warn ? "warn" : "ok";

  const thresholdSeconds = verdict === "crit" ? crit : verdict === "warn" ? warn : null;
  const breachingRecordIds =
    thresholdSeconds === null
      ? []
      : lags
          .filter((l) => l.lagSeconds !== null && (l.lagSeconds as number) >= (thresholdSeconds as number))
          .map((l) => l.recordId)
          .sort()
          .slice(0, MAX_BREACH_IDS);

  const proposal: DecisionLogLagProposal =
    verdict === "crit"
      ? {
          action: "propose-escalation",
          reason: "decision-log-lag-at-or-above-crit",
          maxLagSeconds,
          thresholdSeconds,
          breachingRecordIds,
          routedAsAlert: false,
          autoRecoveryAttempted: false,
        }
      : verdict === "warn"
        ? {
            action: "investigate",
            reason: "decision-log-lag-at-or-above-warn",
            maxLagSeconds,
            thresholdSeconds,
            breachingRecordIds,
            routedAsAlert: false,
            autoRecoveryAttempted: false,
          }
        : verdict === "unknown"
          ? {
              action: "none",
              reason: "no-computable-emit-timestamps",
              maxLagSeconds,
              thresholdSeconds,
              breachingRecordIds,
              routedAsAlert: false,
              autoRecoveryAttempted: false,
            }
          : {
              action: "none",
              reason: "lag-within-band",
              maxLagSeconds,
              thresholdSeconds,
              breachingRecordIds,
              routedAsAlert: false,
              autoRecoveryAttempted: false,
            };

  return {
    schema: DECISION_LOG_LAG_SCHEMA,
    mode: "propose-only",
    routesAlerts: false,
    autoRecovers: false,
    evaluatedAt: input.now,
    observedAt: input.now,
    recordCount: lags.length,
    computableCount: computable.length,
    maxLagSeconds,
    verdict,
    lags,
    proposal,
    rollbackNotes: [
      "Detector mutates nothing: rollback is discarding this object.",
      "No alert-routing change, no auto-recovery, no host access was performed.",
      "A high lag alone never pages, never re-emits, never trims the log.",
    ],
    limitations: [
      "Caller-declared timestamps are not certified production evidence.",
      "Lag is a point-in-time visibility measure, not a completeness audit: absent records are , not this detector.",
      "Clock skew (future emits) reads as unknown, never as fresh.",
    ],
  };
}
