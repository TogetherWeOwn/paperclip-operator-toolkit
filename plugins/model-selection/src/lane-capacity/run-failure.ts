import { resolveConfiguredModelId } from "../engine/model-id.js";
import type { LaneOutageOverride } from "../engine/pacing.js";
import type { ModelEntry } from "../engine/types.js";

/**
 * TOG-3012. Immediate lane feedback from a failed run.
 *
 * The 2026-09-16 16:40Z Codex exhaustion cost 21 failed runs across 14 cards
 * before any pin moved. The router's *decision* was right — it picked Claude
 * for every one of those cards once it knew — but it only learned the lane was
 * gone from the five-minute `pollLanes` cron (ledger first read `exhausted` at
 * 16:45:50Z, ~5m50s after the first rejection) and only acted on it from the
 * ten-minute `labelOnlyPass`/`repinPass` crons. Runs kept launching into a
 * dead lane for the whole of that window.
 *
 * A run that dies with "all credentials are cooling down" is strictly better
 * evidence than the telemetry poll: it is a rejection from the lane itself, at
 * the moment of use, with no snapshot-freshness question attached. This module
 * turns that rejection into the same `LaneOutageOverride` an operator would
 * declare by hand with `model_selection_set_lane_outage`, so it flows through
 * `laneOutageExcluded` (`select.ts:363`) with no new selection logic.
 *
 * Everything here is pure. The event handler in `worker.ts` owns the state
 * write and the repin; this file owns the two judgements that must be exactly
 * reproducible: "is this failure a lane exhaustion?" and "what does that do to
 * the outage record?".
 */

/**
 * Phrases that mean the LANE is out of capacity, not that this one request was
 * shaped badly or arrived too fast.
 *
 * Deliberately narrow. A bare `429` is NOT on this list: CLIProxy returns 429
 * for per-minute throttling on a perfectly healthy lane, and quarantining on
 * that would evacuate the cheap lanes into Claude every time a burst lands —
 * the exact opposite of the routing objective. Each entry below is a phrase
 * that only appears once an account's *allowance* is gone.
 *
 * Sources, all observed in this company's own `heartbeat_runs.error` values:
 *  - `All credentials for model <id> are cooling down` — CLIProxy, every
 *    account for a model in cooldown (the 2026-09-16 and 2026-09-11 outages).
 *  - `usage_limit_reached` — the upstream reason CLIProxy reports underneath.
 *  - `All credentials ... are cooling down` without a model id, and
 *    `all upstream accounts` — older CLIProxy phrasings kept for the same
 *    class.
 */
const LANE_EXHAUSTION_PHRASES: readonly RegExp[] = [
  /all credentials for model\s+\S+\s+are cooling down/i,
  /all credentials .{0,40}cooling down/i,
  /usage[_ ]limit[_ ]reached/i,
  /all upstream accounts .{0,40}(exhausted|unavailable|cooling)/i,
  /weekly (quota|limit) (exhausted|reached)/i,
];

/**
 * Pulls the model id out of CLIProxy's cooling-down rejection.
 *
 * The id is reported in the lane's own namespace (`gpt-5.6-sol`), while the
 * roster may carry it either bare or `cliproxy/`-qualified — so the captured
 * text is handed to {@link resolveConfiguredModelId}, which accepts that one
 * legacy wrapper and refuses to guess by suffix. An id we cannot resolve is
 * treated as absent rather than approximated: quarantining the wrong lane is
 * worse than falling back to the caller's supplied model.
 */
const MODEL_IN_COOLDOWN_RE = /all credentials for model\s+([^\s,)]+)\s+are cooling down/i;

export interface RunFailureLaneVerdict {
  /** The roster id of the model whose lane ran out. */
  modelId: string;
  /** The lane to quarantine. Never null — a model with no lane cannot be quarantined and is filtered out before this is built. */
  laneId: string;
  /** Which phrase matched, recorded verbatim in the activity log so a false positive is diagnosable without re-reading the run. */
  matchedPhrase: string;
  /** True when the model id came out of the error text itself rather than the caller's fallback. */
  modelFromErrorText: boolean;
}

export interface RunFailureLaneInput {
  /** `heartbeat_runs.error`, as carried on the `agent.run.failed` plugin event payload. */
  error: string | null | undefined;
  /** `heartbeat_runs.error_code`. Searched alongside `error` — some rejections put the reason only here. */
  errorCode?: string | null | undefined;
  /** The company's configured roster, used to resolve an observed id and read its lane. */
  models: readonly ModelEntry[];
  /**
   * The model the failed run was actually going to use (the issue's pinned
   * override, else the assignee's floor), for the rejections that name no
   * model. Ignored unless a lane-exhaustion phrase matched.
   */
  fallbackModelId?: string | null;
}

/**
 * Classify a failed run. Returns null unless the failure is a lane-capacity
 * exhaustion AND it can be attributed to exactly one configured lane.
 */
export function laneExhaustionFromRunFailure(input: RunFailureLaneInput): RunFailureLaneVerdict | null {
  const haystack = [input.error ?? "", input.errorCode ?? ""].join(" ");
  if (!haystack.trim()) return null;

  const matched = LANE_EXHAUSTION_PHRASES.find((phrase) => phrase.test(haystack));
  if (!matched) return null;

  const embedded = MODEL_IN_COOLDOWN_RE.exec(haystack)?.[1] ?? null;
  const fromText = resolveConfiguredModelId(embedded, input.models);
  const modelId = fromText ?? resolveConfiguredModelId(input.fallbackModelId ?? null, input.models);
  if (!modelId) return null;

  const laneId = input.models.find((model) => model.id === modelId)?.laneId ?? null;
  if (!laneId) return null;

  return {
    modelId,
    laneId,
    matchedPhrase: matched.source,
    modelFromErrorText: fromText !== null,
  };
}

/**
 * Fold an auto-quarantine into whatever outage record already exists.
 *
 * `laneOutage` is a single company-scoped object, not a map, so a blind write
 * would silently drop an operator's hand-declared outage — the one case where
 * the operator knows something the telemetry and the rejections both do not.
 * This unions instead: lanes and models accumulate, and `until` takes the
 * LATER of the two, so an automatic 15-minute quarantine can never shorten a
 * multi-hour operator declaration.
 *
 * An already-expired `existing` is treated as absent (same rule as
 * `isLaneOutageActive`), so yesterday's cleared outage does not resurrect.
 */
export function mergeLaneOutage(
  existing: LaneOutageOverride | null,
  addition: { lanes: readonly string[]; models: readonly string[]; until: string; reason?: string },
  nowIso: string,
): LaneOutageOverride {
  const live = existing && existing.until > nowIso ? existing : null;
  const lanes = [...new Set([...(live?.lanes ?? []), ...addition.lanes])];
  const models = [...new Set([...(live?.models ?? []), ...addition.models])];
  const until = live && live.until > addition.until ? live.until : addition.until;
  const reason = live?.reason ? `${live.reason}; ${addition.reason ?? ""}`.replace(/; $/, "") : addition.reason;
  return { lanes, models, until, ...(reason ? { reason } : {}) };
}

/**
 * How long an auto-quarantine holds without further evidence.
 *
 * Sized against the two clocks that clear it. `pollLanes` runs every 5 minutes
 * and writes the lane's real verdict, and a recovered lane becomes serviceable
 * there — but the outage override is checked independently of the ledger, so
 * it needs an expiry of its own. 15 minutes is three poll cycles: long enough
 * that a lane genuinely out for the week is not re-probed every few minutes by
 * an unlucky card, short enough that a false positive on a healthy lane costs
 * at most one quarter-hour of traffic pushed up to Claude.
 *
 * It is deliberately NOT sized to the weekly reset. A quarantine that outlived
 * the evidence for it would be indistinguishable from the operator lane-outage
 * record it shares storage with, and the failure mode of guessing long here
 * (an entire lane's paid-for weekly allowance destroyed unused) is much more
 * expensive than the failure mode of guessing short (one more failed run,
 * which re-arms the quarantine for another 15 minutes).
 */
export const AUTO_QUARANTINE_SECONDS = 15 * 60;

/** Build the outage addition for a classified failure. Split out so the TTL and the wording are testable without a clock. */
export function autoQuarantineFor(
  verdict: RunFailureLaneVerdict,
  nowMs: number,
  ttlSeconds: number = AUTO_QUARANTINE_SECONDS,
): { lanes: string[]; models: string[]; until: string; reason: string } {
  return {
    lanes: [verdict.laneId],
    // The lane is what ran out, not the individual model — every model on the
    // lane shares the same exhausted credentials. Listing only the lane keeps
    // the record honest and lets a lane with several models clear in one go.
    models: [],
    until: new Date(nowMs + ttlSeconds * 1_000).toISOString(),
    reason: `auto: run rejected on ${verdict.laneId} (${verdict.modelId}) with a lane-capacity error`,
  };
}
