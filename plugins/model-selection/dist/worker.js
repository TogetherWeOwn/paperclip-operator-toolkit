// src/worker.ts
import { randomUUID } from "node:crypto";
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

// src/constants.ts
var PLUGIN_VERSION = "0.4.0";
var TOOL_NAMES = {
  /** Advise a tier + model for one issue. Read-only, always safe to call. */
  advise: "model_selection_advise",
  /** Advise and, if enforcement is on for this company, write the override. */
  apply: "model_selection_apply",
  /** Record a time-boxed operator override: route this issue to a named model regardless of pace. */
  setOperatorOverride: "model_selection_set_operator_override",
  /**
   * TOG-2137, Defect 3. Report where an agent's ancillary model pins
   * (ANTHROPIC_SMALL_FAST_MODEL, CLAUDE_CODE_SUBAGENT_MODEL, every
   * ANTHROPIC_DEFAULT_* env var) disagree with the lane-aware T3
   * recommendation. Read-only, always advisory: there is no write path from
   * this plugin to any of these surfaces (`ctx.agents` has no update method,
   * and `ctx.http.fetch` is SSRF-blocked from the host's own internal API),
   * so this can never be anything but a report.
   *
   * TOG-3348: `runtimeConfig.modelProfiles.cheap` was a fifth surface here
   * until Paperclip migration 0236 (v2026.916.0) deleted it with no
   * replacement; removed rather than kept as a frozen snapshot.
   */
  ancillaryDrift: "model_selection_ancillary_drift",
  /** Per-model aa.ai configured vs. live index and tier-boundary drift. Read-only (TOG-2438). */
  aaDriftReport: "model_selection_aa_drift_report",
  /** Manually run the aa.ai fetch + drift-surfacing sweep outside the cron cadence (TOG-2438 reopen AC4). */
  refreshAaIndexNow: "model_selection_refresh_aa_index_now",
  /** TOG-3996: the last models.dev price reconciliation, as an operator-approvable diff. Read-only. */
  priceDriftReport: "model_selection_price_drift_report",
  /** TOG-3996: run the models.dev fetch + price reconciliation now instead of waiting for the daily tick. Still report-only. */
  reconcilePricesNow: "model_selection_reconcile_prices_now",
  /** TOG-12206 P2: the last free-list sync diff (verified/broken/ambiguous/unbound), as an operator-reviewable report. Read-only. */
  aaFreeSyncReport: "model_selection_aa_free_sync_report",
  /** TOG-12206 P2: run the free-list fetch + diff immediately instead of waiting for the daily tick. Still report-only. */
  refreshAaFreeSyncNow: "model_selection_refresh_aa_free_sync_now",
  /** TOG-12972: the first-party accepted-work posterior overlay, as an operator-reviewable report. Read-only. */
  acceptedWorkReport: "model_selection_accepted_work_report",
  /**
   * TOG-4959. Per-tier lane-poll outcome counters. Read-only: the
   * `pollLaneCapacity` job increments, this tool reads back.
   */
  tierOutcomes: "model_selection_tier_outcomes",
  /** Read the last explicitly enabled account shadow snapshot; never actuates. */
  admissionShadowReport: "model_selection_admission_shadow_report",
  /** TOG-2481 port of `lane_outage.json`: declare or clear a telemetry-invisible lane outage. */
  setLaneOutage: "model_selection_set_lane_outage",
  /** TOG-2481 port of `zai_pace_override()` / `zai_pace_override.json`. */
  setZaiPaceOverride: "model_selection_set_zai_pace_override",
  /**
   * TOG-12490 (TOG-11543 P2, TOG-11549 D4). Add, edit, remove, validate or diff
   * tier-policy tiers. Prepare/validate/diff only: returns `proposalOnly` or
   * `rejected`, never writes state or config, never changes routing.
   */
  tierPolicy: "model_selection_tier_policy"
};
var LANE_ID_CODEX = "cliproxy-codex";
var LANE_ID_OPENCODE_GO = "cliproxy-opencode-go";
var LANE_ID_ZAI = "cliproxy-zai";
var DEFAULT_PACE_ACCOUNT_KEY_FIELDS = ["account_key", "accountKey", "name", "id"];
var DEFAULT_PACE_WEIGHT_FIELDS = ["plan_weight", "weight"];
var DEFAULT_LANE_CAP_PER_ACCOUNT = {
  [LANE_ID_OPENCODE_GO]: 2,
  [LANE_ID_ZAI]: 3
};
var DEFAULT_AVOID_PER_LANE = {
  [LANE_ID_CODEX]: 0.99
};
var DEFAULT_FIVE_HOUR_WINDOW_NAME = "five-hour";
var DEFAULT_WEEKLY_WINDOW_NAME = "weekly";
var DEFAULT_ZAI_WEEKLY_WINDOW_NAME = "weekly";
var DEFAULT_ZAI_WEEKLY_MARGIN = 0.15;
var ROUTE_KEYS = {
  advise: "advise",
  applyIssue: "apply-issue"
};
var JOB_KEYS = {
  /** Recompute per-tier volume profiles from this company's own runs. */
  refreshProfiles: "refreshVolumeProfiles",
  /** Poll configured lane-capacity sources and refresh the lane ledger. */
  pollLanes: "pollLaneCapacity",
  /** Recompute per-model, per-tier Bayesian success scores and the card ledger. */
  refreshScores: "refreshScores",
  /** Refresh the aa.ai Intelligence Index snapshot and surface tier-boundary drift (TOG-2438). */
  refreshAaIndex: "refreshAaIndex",
  /** TOG-3996: reconcile roster prices against models.dev and report drift (never auto-applies). */
  reconcilePrices: "reconcilePrices",
  /** TOG-12206 P2: fetch the free AA legacy list (quota-gated) and store the CAS snapshot + per-company reviewable diff. Never writes pins/tiers/enabled. */
  refreshAaFreeSync: "refreshAaFreeSync",
  /** Ported from `tier_dispatcher.py` `main()`: classify unlabeled issues and write a tier:* label. */
  classifyIssues: "classifyIssues",
  /** Ported from `tier_dispatcher.py`'s `label_only_pass()`. */
  labelOnlyPass: "labelOnlyPass",
  /** Ported from `tier_dispatcher.py`'s `repin_pass()`. */
  repinPass: "repinPass",
  /** Ported from `tier_dispatcher.py`'s `balance_pass()`. */
  balancePass: "balancePass",
  /**
   * TOG-2481 absorption of the standalone `dispatch` plugin (TOG-747/TOG-706):
   * stall-sweep + wakeup, ported wholesale so the `plugins` table shows one
   * dispatcher, not two.
   */
  dispatchSweep: "dispatch-sweep",
  /** TOG-11793: warm the run-scoped decision's hot snapshot once a minute. */
  refreshRunResolve: "refreshRunResolveSnapshot"
};
var TIER_LABEL_PREFIX = "tier:";
var TIERS = ["T1", "T2", "T3"];
var TIER_ORDER = ["T3", "T2", "T1"];
var OPERATOR_PIN_LABEL = "pin:operator";
var PLUGIN_STATE_KEYS = {
  volumeProfiles: "volumeProfiles",
  /** Per-company lane pace verdicts and slot-throttle counters. */
  laneLedger: "laneLedger",
  /**
   * Per-company published quota-contract document, the input to the TOG-3132
   * availability term. Written by the collector (TOG-3133); until that runs,
   * every lane reads UNKNOWN — recorded and traced, and under the default
   * policy not blocking.
   */
  laneAvailability: "laneAvailability",
  /** Per-issue operator overrides, each with an expiry (TOG-2137). */
  operatorOverrides: "operatorOverrides",
  /** Per-issue timestamp of the last pace-driven repin, for the idle-repin hysteresis (TOG-2137). */
  paceRepinHistory: "paceRepinHistory",
  /** `ModelScore[]` written by the `refreshScores` job. */
  modelScores: "modelScores",
  /** Reopen/rejection signals captured from `ctx.events` between `refreshScores` runs. */
  reworkSignals: "reworkSignals",
  /** Rolling 7-day list-price vs cost-per-accepted-card shadow-diff records (Slice 3). */
  shadowDiffs: "shadowDiffs",
  /** One bounded, caller-supplied account shadow snapshot, never a reservation ledger. */
  admissionShadowReport: "admissionShadowReport",
  /** Slice-4 bounded T1 earn-in dispatch bookkeeping. */
  earnInState: "earnInState",
  /**
   * TOG-2137, Defect 2. Per-issue timestamp of the last raised `tier-exhausted`
   * operator alarm, so a decision that stays exhausted across repeated
   * `advise`/`apply` calls does not spam a fresh card every time — one open
   * card per continuous exhaustion streak. Cleared the first time the same
   * issue's outcome is no longer `tier-exhausted`, so the NEXT exhaustion
   * raises a fresh card rather than staying silent forever.
   */
  tierExhaustedAlarms: "tierExhaustedAlarms",
  /**
   * Instance-scoped (aa.ai data is not company-specific): the last-fetched
   * aa.ai snapshot `{fetchedAt, bySlug, lastAttemptAt, lastError}` (TOG-2438).
   * `bySlug` maps every aa.ai slug (one per model x effort-level) to its full
   * `AaModelRecord` (TOG-2438 scope expansion) — not just the intelligence
   * index.
   */
  aaIndexSnapshot: "aaIndexSnapshot",
  /**
   * Instance-scoped: a bounded rolling history of past fetches, `{entries:
   * Array<{fetchedAt, bySlug}>}`, newest last, capped at
   * `AA_SNAPSHOT_HISTORY_LIMIT` entries (TOG-2438 scope expansion — "store
   * the raw snapshot per fetch so history is queryable"). Separate key from
   * `aaIndexSnapshot` so a plain drift read never has to load the whole
   * history.
   */
  aaSnapshotHistory: "aaSnapshotHistory",
  /**
   * Instance-scoped: `{ids: string[]}`, the set of companies this worker has
   * ever seen a stored config for, persisted so a bare crash-restart (which
   * replays no `configChanged` calls, unlike a full plugin reload) doesn't
   * reset scheduled jobs to iterating zero companies (TOG-2438 reopen).
   */
  knownCompanies: "knownCompanies",
  /** Per-company: which `(modelId, freshImpliedTier)` drift pairs have already been surfaced (TOG-2438). */
  aaDriftSurfaced: "aaDriftSurfaced",
  /**
   * TOG-3996, per-company: the most recent models.dev price reconciliation
   * report (`{report, ranAt, error}`), so `priceDriftReport` can answer
   * without re-fetching a 4.8 MB catalogue on every read. The report is the
   * artifact — this job writes no price anywhere.
   */
  priceReconcileReport: "priceReconcileReport",
  /**
   * TOG-3996, per-company: which `(modelId, field, feedPrice)` drift findings
   * have already been surfaced to the activity log, so a misprice nobody has
   * applied yet does not re-alarm on every daily tick. Same dedup shape and
   * rationale as `aaDriftSurfaced`; keyed on the FEED price so a second,
   * different price change on the same row does surface again.
   */
  priceDriftSurfaced: "priceDriftSurfaced",
  /**
   * TOG-12206 P2, instance-scoped (the free list is not company-specific):
   * the last-good free-list snapshot `{fetchedAt, digest, snapshot,
   * lastAttemptAt, lastError, nextEligibleAt}`. A failed fetch keeps the
   * last good snapshot in place and records the attempt; the snapshot is
   * dated, so a stale one is legible as stale. `nextEligibleAt` is the D1
   * quota gate (at most one scheduled fetch/day, 429 honors Retry-After).
   */
  aaFreeSyncSnapshot: "aaFreeSyncSnapshot",
  /**
   * TOG-12206 P2, per-company: the most recent free-list sync diff
   * (`{ranAt, digest, error, diff}`), so `aaFreeSyncReport` can answer
   * without re-fetching. The diff is the artifact — this job writes no
   * binding anywhere.
   */
  aaFreeSyncDiff: "aaFreeSyncDiff",
  /**
   * TOG-12972, per-company: the first-party accepted-work posterior overlay
   * (`{specVersion, computedAt, cohorts, unattributed}`), so
   * `acceptedWorkReport` can answer without re-reading runs. The overlay is
   * the artifact — nothing reads it for routing in this slice.
   */
  acceptedWorkOverlay: "acceptedWorkOverlay",
  /**
   * Per-issue capability-exclusion flag recorded by `classifyIssues`
   * (ported from `tier_dispatcher.py` `main()`'s `excl` local). The tier:*
   * LABEL always records the confidence-demoted tier regardless of
   * exclusion; this flag is the only place exclusion survives past the
   * classify job, for a later apply-sweep (TOG-2481 task #6/#7) to supply as
   * `descriptor.exclusion` and force the T1 model-pick bucket.
   */
  classificationExclusions: "classificationExclusions",
  /**
   * TOG-3200. Per-issue provenance for the `tier:*` label: `{issueId: "T2"}`
   * for every tier label THIS job wrote. Without it `classifyIssues` cannot
   * tell its own verdict from an agent's self-assessment, so it had to skip
   * every card already carrying a tier label — and that skip is what starved
   * it.
   *
   * Measured 2026-09-17: 1,542 tier labels exist company-wide, of which 44
   * (2.9%) were written by this plugin. The rest are agent self-assessments
   * made under a bundle instruction that says to go up a tier when in doubt.
   * Because 120 of the 126 eligible open cards already carried one, the job
   * ran 36 times that day and classified ZERO issues. Provenance is what makes
   * the skip narrow enough to be correct: skip our own recorded verdict,
   * re-examine somebody else's.
   */
  classifierLabeledIssues: "classifierLabeledIssues",
  /**
   * TOG-2481 port of `lane_outage.json` — an operator-declared outage the
   * telemetry cannot see. Runtime-settable (mirroring `operatorOverrides`),
   * not deploy-time config: the Python source is a hand-edited file read
   * fresh on every dispatcher run, and an outage is exactly the kind of
   * thing that needs to be set/cleared without a plugin config redeploy.
   */
  laneOutage: "laneOutage",
  /**
   * TOG-2481 port of `zai_pace_override.json` — an operator-declared
   * temporary margin override for `zaiWeeklyPaceOk`, e.g. during a Codex
   * outage. Runtime-settable, same rationale as `laneOutage`.
   */
  zaiPaceOverride: "zaiPaceOverride",
  /** Keyset cursor for the bounded balance-pass page, persisted per company. */
  balancePassCursor: "balancePassCursor",
  /**
   * TOG-3585: per-pass high-water marks (`{at: ISOString}`) for the
   * incremental scans. Each pass reads only issues updated since its own
   * mark and advances the mark past what it scanned. A pass whose scan finds
   * nothing logs a skip and still advances — an empty scan proves nothing
   * changed. Separate keys per pass (not one shared cursor) so a slow pass
   * never starves a fast one.
   */
  classifyLastScanAt: "classifyLastScanAt",
  labelOnlyLastScanAt: "labelOnlyLastScanAt",
  repinLastScanAt: "repinLastScanAt",
  balanceLastScanAt: "balanceLastScanAt",
  /**
   * TOG-2481 port of the `dispatch` plugin's `stateKey()` — the last-firing
   * summary a sweep compares against to gate the activity-log line to state
   * changes only. Namespaced separately from the rest of this plugin's state
   * (`namespace: "dispatch"`, matching the original plugin's key exactly) so
   * absorbing it does not collide with `laneLedger`/etc.
   */
  dispatchLastFiring: "dispatchLastFiring",
  /**
   * TOG-3111 AC3. Per-issue timestamp of the last "cannot pin — no eligible
   * model on any serviceable lane" activity notice, so a card that stays
   * unpinnable across repeated pass firings surfaces once per throttle window
   * instead of on every 10-minute tick. Same shape/rationale as
   * `tierExhaustedAlarms`, scoped to the per-card notice rather than the
   * operator alarm card.
   */
  noEligibleNotices: "noEligibleNotices",
  /**
   * TOG-6895. Per-issue pin timestamps (`{issueId: ISOString}`), the pin
   * lifecycle's only clock. Written on every pin and clear, read by the
   * repin pass: a pin older than PIN_MAX_AGE_MS is re-validated through
   * `advise` even when the pinned lane still reads usable. Missing entry =
   * expired (fail-safe toward re-validation, never toward keeping).
   */
  pinPinnedAt: "pinPinnedAt",
  /**
   * TOG-4959, per-company: per-tier lane-poll outcome counters
   * (`{tiers: {T1: {polls, succeeded, failed, lastAt}, ...}, updatedAt}`).
   * Written by the `pollLaneCapacity` job, read by the read-only
   * `model_selection_tier_outcomes` tool. Read-only telemetry: selection
   * never reads this key, so the counters cannot change routing.
   */
  tierPollOutcomes: "tierPollOutcomes",
  /**
   * TOG-12234, per-company: index of issues whose pin carries a fallback
   * provenance stamp (`{issueId: {decisionId, decidedAt, checkedAt}}`).
   * Written next to every pin write and clear; read by the fallback lease
   * pass, which examines only these issues. The stamp on the issue is the
   * authority: an entry whose `decisionId` no longer matches is dropped.
   */
  fallbackPins: "fallbackPins"
};
var NO_ELIGIBLE_NOTICE_THROTTLE_MS = 60 * 60 * 1e3;
var AA_LEADERBOARD_URL = "https://artificialanalysis.ai/leaderboards/models";
var AA_FETCH_TIMEOUT_MS = 1e4;
var AA_MAX_RESPONSE_BYTES = 8e6;
var AA_SNAPSHOT_HISTORY_LIMIT = 28;
var MODELS_DEV_CATALOG_URL = "https://models.dev/api.json";
var MODELS_DEV_USER_AGENT = "TogetherWeOwn-model-selection/1.0 (+https://github.com/TogetherWeOwn/paperclip-ops-tooling)";
var MODELS_DEV_MAX_RESPONSE_BYTES = 16e6;
var MODELS_DEV_FETCH_TIMEOUT_MS = 2e4;
var AA_FREE_FETCH_TIMEOUT_MS = 1e4;
var AA_FREE_MAX_RESPONSE_BYTES = 8e6;
var AA_FREE_FETCH_INTERVAL_MS = 24 * 60 * 60 * 1e3;
var AA_FREE_RETRY_INTERVAL_MS = 60 * 60 * 1e3;
var PACING_MODES = ["off", "shadow", "enforce"];
var LOCAL_FOLDER_KEYS = {
  /**
   * TOG-2137. Append-only `tog2138-decision-v1` JSONL records, one per
   * `advise()` call, for the 48h host/plugin-shadow agreement stream
   * `ops/tog-2138/gate_harness.py` correlates against. Plugin-owned path —
   * never `ops/tog-2138/`, which is TOG-2138's own directory.
   *
   * Lowercase-and-hyphen only: `pluginManifestV1Schema` rejects a `folderKey`
   * that doesn't match `^[a-z0-9][a-z0-9._:-]*$` (no camelCase).
   */
  shadowDecisions: "shadow-decisions"
};
var SHADOW_EXPLANATIONS_CAP = 200;
var SHADOW_PICK_WHY_MAX_CHARS = 8e3;
var DEFAULT_SLOT_FLOOR_FRACTION = 0.25;
var DEFAULT_OPERATOR_OVERRIDE_TTL_SECONDS = 60 * 60;
var DEFAULT_IDLE_REPIN_HYSTERESIS_SECONDS = 5 * 60;
var SCORE_THRESHOLDS = { T1: 0.85, T2: 0.8, T3: 0.75 };
var SCORE_PRIOR_K = 6;
var SCORE_PROVEN_N = 8;
var CARD_CENSOR_DAYS = 14;
var CARD_ZERO_ACCEPT_MIN_RESOLVED = 8;
var CARD_ZERO_ACCEPT_WINDOW_DAYS = 7;
var SCORE_WINDOW_DAYS = 14;
var CARD_LEDGER_WINDOW_DAYS = 60;
var REOPEN_WINDOW_MS = 72 * 60 * 60 * 1e3;
var REJECTION_WINDOW_MS = 48 * 60 * 60 * 1e3;
var REWORK_WEIGHT_REOPEN = 1;
var REWORK_WEIGHT_REJECTED = 0.5;
var EXPLORE_FRACTION = 0.1;
var FREE_MUST_BE_PROVEN_USD = 0.1;
var COST_BAND_MULTIPLIER = 1.2;
var CLASSIFY_FETCH_MULTIPLIER = 10;
var CLASSIFY_FETCH_LIMIT_MAX = 400;
var CLASSIFY_JOB_BUDGET_MS = 200 * 1e3;
var CLASSIFY_ROW_TIMEOUT_MS = 30 * 1e3;
var LABEL_ONLY_PASS_FETCH_LIMIT = 100;
var LABEL_ONLY_PASS_JOB_BUDGET_MS = 200 * 1e3;
var LABEL_ONLY_PASS_ROW_TIMEOUT_MS = 30 * 1e3;
var LABEL_ONLY_PASS_MAX_ROWS_PER_FIRING = 8;
var REPIN_PASS_FETCH_LIMIT = 400;
var REPIN_PASS_WRITE_LIMIT = 6;
var REPIN_PASS_JOB_BUDGET_MS = 200 * 1e3;
var REPIN_PASS_ROW_TIMEOUT_MS = 30 * 1e3;
var PIN_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
var FALLBACK_LEASE_EXAMINE_LIMIT = 20;
var FALLBACK_LEASE_WRITE_LIMIT = 6;
var FALLBACK_PIN_INDEX_MAX = 500;
var BALANCE_PASS_FETCH_LIMIT = 50;
var BALANCE_PASS_JOB_BUDGET_MS = 200 * 1e3;
var BALANCE_PASS_ROW_TIMEOUT_MS = 30 * 1e3;
var BALANCE_PASS_WRITE_LIMIT = 8;
var BALANCE_PASS_COST_DOWN_MULTIPLIER = 0.8;
var BALANCE_PASS_BUSIER_UTILIZATION_DELTA = 0.25;
var BALANCE_PASS_PROBATION_PRICE_USD = 0.1;
var DISPATCH_ISSUE_PAGE_LIMIT = 1e3;
var DISPATCH_SWEEP_JOB_BUDGET_MS = 4 * 60 * 1e3;
var LANE_EVIDENCE_WINDOW_HOURS = 24;
var LANE_EVIDENCE_TTL_MS = 6e4;

// src/lane-capacity/value-normalization.ts
function recordOf(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function firstValue(record3, fields) {
  for (const field of fields) {
    if (field in record3) return { value: record3[field], field };
  }
  return null;
}
function fraction(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}
function timestamp(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}
function normalizeHealth(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["healthy", "available", "allowed", "ready", "ok", "active"].includes(normalized)) return "healthy";
  if (["degraded", "limited", "warning", "cooldown", "cooling_down"].includes(normalized)) return "degraded";
  if (["exhausted", "quota_exhausted", "rate_limited"].includes(normalized)) return "exhausted";
  if (["unavailable", "disabled", "offline", "error", "blocked"].includes(normalized)) return "unavailable";
  if (["unknown", "stale"].includes(normalized)) return "unknown";
  return null;
}

// src/lane-capacity/counts-only.ts
function utcTimestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/.test(value) && Number.isFinite(Date.parse(value));
}
function count(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function countsOnlyEvidence(raw, utilizationFields = []) {
  if (raw.observationQuality !== "counts-only") return null;
  if (Object.keys(raw).some((key) => /utilization|allowance/i.test(key) || utilizationFields.includes(key))) return null;
  if ("windows" in raw || !count(raw.requests_today) || !count(raw.requests_lifetime)) return null;
  const seconds = recordOf(raw.window_seconds)?.daily;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (raw.governing_window !== "daily" || !utcTimestamp(raw.day_resets_at)) return null;
  if (typeof raw.health !== "string" || !raw.health.trim()) return null;
  return {
    requestsToday: raw.requests_today,
    requestsLifetime: raw.requests_lifetime,
    dayResetsAt: raw.day_resets_at,
    dailySeconds: seconds
  };
}
function modelCooldowns(raw) {
  if (!("model_cooldowns" in raw)) return [];
  if (!Array.isArray(raw.model_cooldowns)) return null;
  const entries = [];
  for (const value of raw.model_cooldowns) {
    const entry = recordOf(value);
    if (!entry || !(entry.model === null || typeof entry.model === "string" && entry.model.trim())) return null;
    if (typeof entry.scope !== "string" || !entry.scope.trim() || typeof entry.reason !== "string" || !entry.reason.trim()) return null;
    if (!utcTimestamp(entry.retry_at)) return null;
    entries.push({ model: entry.model, scope: entry.scope, reason: entry.reason, retry_at: entry.retry_at });
  }
  return entries;
}
function activeModelCooldown(entries, modelId, nowMs) {
  return entries.some((entry) => entry.reason !== "transient_error" && (entry.model === null || entry.model === modelId) && Date.parse(entry.retry_at) > nowMs);
}

// src/lane-capacity/pace.ts
var SCALE = 1e3;
var DEFAULT_MARGIN = 0.1;
var DEFAULT_URGENT_RESET_SECONDS = 24 * 60 * 60;
var DEFAULT_MAX_SNAPSHOT_AGE_SECONDS = 15 * 60;
function positiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
function nonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function firstNumber(record3, fields, mode = "finite") {
  const value = firstValue(record3, fields)?.value;
  return mode === "non-negative" ? nonNegativeNumber(value) : finiteNumber(value);
}
function text(record3, fields) {
  const value = firstValue(record3, fields)?.value;
  return typeof value === "string" && value.trim() ? value : null;
}
function windowSeconds(record3, field, window) {
  const raw = record3[field];
  if (typeof raw === "number") return positiveNumber(raw);
  const mapped = recordOf(raw);
  if (mapped) {
    return positiveNumber(mapped[window.name]) ?? positiveNumber(mapped[window.name.replace(/-/g, "_")]);
  }
  return positiveNumber(window.defaultWindowSeconds);
}
function normalizedWeight(record3, fields) {
  const reported = positiveNumber(firstValue(record3, fields)?.value);
  return reported === null ? { weight: null, source: "unknown" } : { weight: reported, source: "reported" };
}
function accountKey(record3, fields) {
  return text(record3, fields)?.trim() ?? null;
}
function hasReportedAccountDecision(account) {
  return account.governingWindow !== null && (account.targetBurnRate !== null || account.deficit !== null || account.recommendedShare !== null);
}
function recordWindows(record3) {
  return Array.isArray(record3.windows) ? record3.windows.map(recordOf).filter((window) => window !== null) : [];
}
function matchingWindowRecord(record3, window) {
  return recordWindows(record3).find((candidate) => candidate.name === window.name) ?? null;
}
function nestedOrFlatValue(record3, nested, nestedField, flatFields) {
  if (nested && nestedField in nested) return { field: `windows.${nestedField}`, value: nested[nestedField] };
  return firstValue(record3, flatFields) ?? null;
}
function normalizeLaneDocument(input) {
  const document = recordOf(input.document);
  if (!document) {
    return { laneId: input.definition.laneId, free: Boolean(input.definition.free), observedAt: null, staleAfterSeconds: null, accounts: [], error: "invalid-document" };
  }
  const records = Array.isArray(document.records) ? document.records : [];
  const observedAt = timestamp(document.observedAt);
  const staleAfterSeconds = positiveNumber(document[input.definition.staleAfterSecondsField ?? "staleAfterSeconds"]);
  const empty = (error) => ({
    laneId: input.definition.laneId,
    free: Boolean(input.definition.free),
    observedAt,
    staleAfterSeconds,
    accounts: [],
    error
  });
  if (records.length === 0) return empty("no-records");
  const parsedRecords = records.map(recordOf);
  if (parsedRecords.some((record3) => record3 === null)) return empty("invalid-document");
  const validRecords = parsedRecords;
  const utilizationFields = input.definition.windows.flatMap((window) => window.utilizationFields);
  const counts = validRecords.map((record3) => countsOnlyEvidence(record3, utilizationFields));
  const cooldowns = validRecords.map(modelCooldowns);
  if (validRecords.some((record3, index) => record3.observationQuality === "counts-only" && counts[index] === null || cooldowns[index] === null)) {
    return empty("invalid-document");
  }
  const accountKeyFields = [...input.definition.accountKeyFields ?? DEFAULT_PACE_ACCOUNT_KEY_FIELDS];
  const accountKeys = validRecords.map((record3) => accountKey(record3, accountKeyFields));
  if (accountKeys.some((key) => key === null) || new Set(accountKeys).size !== accountKeys.length) {
    return empty("invalid-account-identity");
  }
  const governingWindowField = input.definition.governingWindowField ?? "governing_window";
  const windowSecondsField = input.definition.windowSecondsField ?? "window_seconds";
  const weightFields = [...input.definition.weightFields ?? DEFAULT_PACE_WEIGHT_FIELDS];
  const accounts = validRecords.map((record3, index) => {
    const weight = normalizedWeight(record3, weightFields);
    const reportedGoverningWindow = typeof record3[governingWindowField] === "string" ? record3[governingWindowField] : null;
    const countsOnly = counts[index];
    const reportedHealth = firstValue(record3, input.definition.healthFields)?.value;
    const health = normalizeHealth(reportedHealth);
    return {
      accountKey: accountKeys[index],
      authKey: text(record3, ["auth_key", "authKey"]),
      plan: text(record3, ["plan"]),
      health: countsOnly ? record3.exhausted === true ? "exhausted" : reportedHealth === "unknown" ? "unknown" : health === "unknown" ? "unavailable" : health ?? "unavailable" : health ?? "unknown",
      ...countsOnly ? { countsOnly } : {},
      ...cooldowns[index].length > 0 ? { modelCooldowns: cooldowns[index] } : {},
      weight: weight.weight,
      weightSource: weight.source,
      governingWindow: reportedGoverningWindow,
      governingResetAt: timestamp(firstValue(record3, ["governing_reset_at", "governing_resets_at", "governingResetAt", "binding_reset_at", "bindingResetAt"])?.value),
      normalizedRemaining: firstNumber(record3, ["normalized_remaining", "normalizedRemaining"], "non-negative"),
      targetBurnRate: firstNumber(record3, ["target_burn_rate", "targetBurnRate", "clear_rate", "clearRate"], "non-negative"),
      observedBurnRate: firstNumber(record3, ["observed_burn_rate", "observedBurnRate", "recent_burn_units_per_hour"], "non-negative"),
      deficit: firstNumber(record3, ["deficit"]),
      recommendedShare: firstNumber(record3, ["recommended_share", "recommendedShare"], "non-negative"),
      recentBurnUnitsPerHour: firstNumber(record3, ["recent_burn_units_per_hour"], "non-negative"),
      staleAfterSeconds: positiveNumber(record3.stale_after_seconds),
      windows: countsOnly ? [] : input.definition.windows.map((window) => {
        const nested = matchingWindowRecord(record3, window);
        const utilization = nestedOrFlatValue(record3, nested, "utilization", window.utilizationFields);
        const reset = nestedOrFlatValue(record3, nested, "resets_at", window.resetFields);
        const reportedAllowanceWeight = positiveNumber(nested?.allowance_weight);
        const invalidReportedAllowanceWeight = nested !== null && "allowance_weight" in nested && nested.allowance_weight !== null && nested.allowance_weight !== void 0 && reportedAllowanceWeight === null;
        return {
          name: window.name,
          role: window.role,
          utilization: fraction(utilization?.value),
          resetsAt: timestamp(reset?.value),
          windowSeconds: positiveNumber(nested?.window_seconds) ?? windowSeconds(record3, windowSecondsField, window),
          allowanceWeight: invalidReportedAllowanceWeight ? null : reportedAllowanceWeight ?? (window.role === "allowance" ? weight.weight : null),
          allowanceWeightSource: invalidReportedAllowanceWeight ? "unknown" : reportedAllowanceWeight !== null ? "reported" : weight.source === "reported" ? "account" : "unknown",
          sourcePath: utilization?.field ?? null
        };
      })
    };
  });
  return {
    laneId: input.definition.laneId,
    free: Boolean(input.definition.free),
    observedAt,
    staleAfterSeconds,
    accounts,
    error: null
  };
}
function roundHalfEven(value) {
  const lower = Math.floor(value);
  const fraction2 = value - lower;
  if (Math.abs(fraction2 - 0.5) <= 1e-12) return lower % 2 === 0 ? lower : lower + 1;
  return Math.round(value);
}
function toMilli(value) {
  return roundHalfEven(Math.min(1, Math.max(0, value)) * SCALE);
}
function score(utilizationMilli, elapsedMilli) {
  return {
    utilization: utilizationMilli / SCALE,
    elapsed: elapsedMilli / SCALE,
    deviation: (utilizationMilli - elapsedMilli) / SCALE
  };
}
function weightedMilli(values) {
  const weight = values.reduce((sum, entry) => sum + entry.weight, 0);
  return roundHalfEven(values.reduce((sum, entry) => sum + entry.value * entry.weight, 0) / weight);
}
function scoredWindow(window, observedAtMs) {
  if (window.utilization === null || window.resetsAt === null || window.windowSeconds === null) {
    return {
      ...window,
      elapsed: null,
      normalizedRemaining: null,
      paceDebt: null,
      clearRate: null,
      serviceable: window.utilization === null || window.utilization < 1
    };
  }
  const remainingSeconds = (Date.parse(window.resetsAt) - observedAtMs) / 1e3;
  const elapsed = Math.min(1, Math.max(0, 1 - remainingSeconds / window.windowSeconds));
  const allowanceWeight = window.allowanceWeight ?? null;
  const normalizedRemaining = allowanceWeight === null ? null : allowanceWeight * Math.max(0, 1 - window.utilization);
  const remainingHours = Math.max(1, remainingSeconds / 3600);
  return {
    ...window,
    elapsed,
    normalizedRemaining,
    paceDebt: allowanceWeight === null ? null : allowanceWeight * (elapsed - window.utilization),
    clearRate: normalizedRemaining === null ? null : normalizedRemaining / remainingHours,
    serviceable: window.utilization < 1
  };
}
function bindingWindow(windows, configured) {
  const allowances = windows.filter(
    (window) => window.role === "allowance" && window.utilization !== null && window.resetsAt !== null && window.windowSeconds !== null && window.clearRate !== null
  );
  const tightest = [...allowances].sort(
    (left, right) => left.clearRate - right.clearRate || left.name.localeCompare(right.name)
  )[0] ?? null;
  if (configured === null) return tightest;
  const declared = allowances.find((window) => window.name === configured) ?? null;
  if (declared === null) return null;
  return tightest !== null && tightest.clearRate < declared.clearRate ? tightest : declared;
}
function urgentPushResetAt(windows, asOfMs, marginMilli, urgentResetSeconds) {
  return windows.filter((window) => window.role === "allowance" && window.serviceable && window.utilization !== null && window.elapsed !== null && window.resetsAt !== null && stateFor(toMilli(window.utilization) - toMilli(window.elapsed), marginMilli) === "behind").map((window) => ({ resetsAt: window.resetsAt, resetSeconds: (Date.parse(window.resetsAt) - asOfMs) / 1e3 })).filter((entry) => entry.resetSeconds >= 0 && entry.resetSeconds < urgentResetSeconds).sort((left, right) => left.resetSeconds - right.resetSeconds)[0]?.resetsAt ?? null;
}
function governingWindow(account, windows) {
  const binding = bindingWindow(windows, account.governingWindow);
  if (binding) return binding;
  if (account.governingWindow !== null) return null;
  return windows.filter((window) => window.role === "serviceability" && window.utilization !== null).sort((left, right) => right.windowSeconds - left.windowSeconds || left.name.localeCompare(right.name))[0] ?? null;
}
function serviceable(account, windows, tripCeilingMilli) {
  if (account.health === "exhausted" || account.health === "unavailable") return false;
  if (account.countsOnly && account.health !== "healthy" && account.health !== "unknown") return false;
  if (trippedServiceabilityWindows(windows, tripCeilingMilli).length > 0) return false;
  return windows.every((window) => window.utilization === null || window.utilization < 1);
}
function trippedServiceabilityWindows(windows, tripCeilingMilli) {
  return windows.filter(
    (window) => window.role === "serviceability" && window.utilization !== null && toMilli(window.utilization) >= tripCeilingMilli
  );
}
function stateFor(deviationMilli, marginMilli) {
  if (deviationMilli > marginMilli) return "ahead";
  if (deviationMilli < -marginMilli) return "behind";
  return "on";
}
function evaluateLanePace(input) {
  const marginMilli = toMilli(input.policy?.margin ?? DEFAULT_MARGIN);
  const tripCeilingMilli = SCALE - marginMilli;
  const urgentResetSeconds = input.policy?.urgentResetSeconds ?? DEFAULT_URGENT_RESET_SECONDS;
  const maxSnapshotAgeSeconds = input.policy?.maxSnapshotAgeSeconds ?? DEFAULT_MAX_SNAPSHOT_AGE_SECONDS;
  const asOf = timestamp(input.asOf ?? input.observation.observedAt);
  if (input.observation.free) {
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "free", serviceable: true, score: null, targetBurnRate: null, observedBurnRate: null, deficit: null, accounts: [], knownAccountCount: 0, knownWeight: 0, serviceableAccountCount: 0, urgentResetAt: null, reason: "free-lane" };
  }
  if (input.observation.error === "invalid-document" || input.observation.observedAt === null || asOf === null) {
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "unknown", serviceable: null, score: null, targetBurnRate: null, observedBurnRate: null, deficit: null, accounts: [], knownAccountCount: 0, knownWeight: 0, serviceableAccountCount: 0, urgentResetAt: null, reason: "document-unavailable" };
  }
  if (input.observation.error === "invalid-account-identity") {
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "unknown", serviceable: null, score: null, targetBurnRate: null, observedBurnRate: null, deficit: null, accounts: [], knownAccountCount: 0, knownWeight: 0, serviceableAccountCount: 0, urgentResetAt: null, reason: "invalid-account-identity" };
  }
  if (input.observation.error === "no-records") {
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "unknown", serviceable: null, score: null, targetBurnRate: null, observedBurnRate: null, deficit: null, accounts: [], knownAccountCount: 0, knownWeight: 0, serviceableAccountCount: 0, urgentResetAt: null, reason: "no-records" };
  }
  const observedAtMs = Date.parse(input.observation.observedAt);
  const asOfMs = Date.parse(asOf);
  const freshnessBudget = Math.min(input.observation.staleAfterSeconds ?? maxSnapshotAgeSeconds, maxSnapshotAgeSeconds);
  if ((asOfMs - observedAtMs) / 1e3 > freshnessBudget || input.observation.accounts.some((account) => account.countsOnly) && observedAtMs - asOfMs > 6e4) {
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "unknown", serviceable: null, score: null, targetBurnRate: null, observedBurnRate: null, deficit: null, accounts: [], knownAccountCount: 0, knownWeight: 0, serviceableAccountCount: 0, urgentResetAt: null, reason: "snapshot-stale" };
  }
  const internal = input.observation.accounts.map((account) => {
    const windows = account.windows.map((window) => scoredWindow(window, observedAtMs));
    const binding = bindingWindow(windows, account.governingWindow);
    const governing = governingWindow(account, windows);
    const accountStale = account.staleAfterSeconds != null && (asOfMs - observedAtMs) / 1e3 > account.staleAfterSeconds;
    const accountServiceable = !accountStale && serviceable(account, windows, tripCeilingMilli);
    const tripped = trippedServiceabilityWindows(windows, tripCeilingMilli);
    const trippedResetsAt = tripped.flatMap((window) => window.resetsAt === null ? [] : [{ ms: Date.parse(window.resetsAt), resetsAt: window.resetsAt }]).filter((entry) => !Number.isNaN(entry.ms));
    const unknownAllowanceWeight = windows.some(
      (window) => window.role === "allowance" && window.utilization !== null && window.resetsAt !== null && window.windowSeconds !== null && window.allowanceWeight === null
    );
    if (!governing) {
      const exhausted2 = account.health === "exhausted" || account.health === "unavailable" || tripped.length > 0;
      const indeterminateGovernor = accountServiceable && !account.countsOnly && account.governingWindow !== null;
      return {
        verdict: {
          accountKey: account.accountKey,
          authKey: account.authKey,
          plan: account.plan,
          health: account.health,
          weight: account.weight,
          weightSource: account.weightSource,
          governingWindow: null,
          governingResetAt: null,
          bindingWindow: null,
          bindingResetAt: null,
          recentBurnUnitsPerHour: account.recentBurnUnitsPerHour,
          staleAfterSeconds: account.staleAfterSeconds,
          serviceable: accountServiceable && !indeterminateGovernor,
          state: exhausted2 ? "exhausted" : "unknown",
          score: null,
          normalizedRemaining: null,
          targetBurnRate: null,
          observedBurnRate: account.countsOnly ? null : account.recentBurnUnitsPerHour ?? null,
          deficit: null,
          recommendedShare: 0,
          paceDebt: null,
          clearRate: null,
          windows
        },
        utilizationMilli: null,
        elapsedMilli: null,
        resetAtMs: null,
        aggregateWeight: null,
        indeterminateWeight: accountServiceable && unknownAllowanceWeight,
        indeterminateGovernor,
        tripped: tripped.length > 0,
        trippedResetsAt
      };
    }
    const utilizationMilli2 = toMilli(governing.utilization);
    const elapsedMilli2 = toMilli(governing.elapsed);
    const accountScore = score(utilizationMilli2, elapsedMilli2);
    const exhausted = !accountServiceable;
    const declaredGoverns = account.governingWindow !== null && governing.name === account.governingWindow;
    const reportedTargetBurnRate = declaredGoverns ? account.targetBurnRate : null;
    const reportedDeficit = declaredGoverns ? account.deficit : null;
    const effectiveTargetBurnRate = reportedTargetBurnRate ?? governing.clearRate;
    const reportedDecision = declaredGoverns && hasReportedAccountDecision(account);
    const effectiveDeficit = reportedDeficit ?? ((account.observedBurnRate ?? account.recentBurnUnitsPerHour) == null || effectiveTargetBurnRate == null ? effectiveTargetBurnRate : effectiveTargetBurnRate - (account.observedBurnRate ?? account.recentBurnUnitsPerHour));
    let state2 = exhausted ? "exhausted" : reportedDecision && effectiveDeficit !== null ? effectiveDeficit > 0 ? "behind" : effectiveDeficit < 0 ? "ahead" : "on" : stateFor(utilizationMilli2 - elapsedMilli2, marginMilli);
    const resetAt = (declaredGoverns ? account.governingResetAt : null) ?? governing.resetsAt;
    const resetSeconds = (Date.parse(resetAt) - asOfMs) / 1e3;
    const governingUrgent = state2 === "behind" && resetSeconds >= 0 && resetSeconds < urgentResetSeconds;
    const windowUrgentResetAt = exhausted ? null : urgentPushResetAt(windows, asOfMs, marginMilli, urgentResetSeconds);
    const urgentResetAt = governingUrgent ? windowUrgentResetAt !== null && Date.parse(windowUrgentResetAt) < Date.parse(resetAt) ? windowUrgentResetAt : resetAt : windowUrgentResetAt;
    if (!exhausted && urgentResetAt !== null) state2 = "push";
    return {
      verdict: {
        accountKey: account.accountKey,
        authKey: account.authKey,
        plan: account.plan,
        health: account.health,
        weight: account.weight,
        weightSource: account.weightSource,
        governingWindow: governing.name,
        governingResetAt: resetAt,
        bindingWindow: binding?.name ?? null,
        bindingResetAt: binding?.resetsAt ?? null,
        urgentResetAt,
        recentBurnUnitsPerHour: account.recentBurnUnitsPerHour,
        staleAfterSeconds: account.staleAfterSeconds,
        serviceable: accountServiceable,
        state: state2,
        score: accountScore,
        normalizedRemaining: (declaredGoverns ? account.normalizedRemaining : null) ?? governing.normalizedRemaining,
        targetBurnRate: effectiveTargetBurnRate,
        observedBurnRate: account.observedBurnRate ?? account.recentBurnUnitsPerHour ?? null,
        deficit: effectiveDeficit,
        recommendedShare: declaredGoverns ? account.recommendedShare : null,
        paceDebt: governing.paceDebt,
        clearRate: governing.clearRate,
        windows
      },
      utilizationMilli: utilizationMilli2,
      elapsedMilli: elapsedMilli2,
      resetAtMs: Date.parse(urgentResetAt ?? resetAt),
      aggregateWeight: governing.allowanceWeight ?? account.weight,
      indeterminateWeight: accountServiceable && (governing.allowanceWeight ?? account.weight) === null,
      indeterminateGovernor: false,
      tripped: tripped.length > 0,
      trippedResetsAt
    };
  });
  const serviceableAccountCount = internal.filter((entry) => entry.verdict.serviceable).length;
  const shareCandidates = internal.filter((entry) => entry.verdict.serviceable && entry.verdict.targetBurnRate != null);
  const useReportedShares = shareCandidates.length > 0 && shareCandidates.every((entry) => entry.verdict.recommendedShare != null);
  const rawShare = (entry) => useReportedShares ? Math.max(0, entry.verdict.recommendedShare) : Math.max(0, entry.verdict.deficit ?? entry.verdict.targetBurnRate);
  const shareDenominator = shareCandidates.reduce((sum, entry) => sum + rawShare(entry), 0);
  const accounts = internal.map((entry) => ({
    ...entry.verdict,
    recommendedShare: !entry.verdict.serviceable || entry.verdict.targetBurnRate == null || shareDenominator <= 0 ? 0 : rawShare(entry) / shareDenominator
  }));
  if (internal.some((entry) => entry.tripped) && serviceableAccountCount === 0) {
    const trippedResets = internal.flatMap((entry) => entry.trippedResetsAt).sort((left, right) => left.ms - right.ms);
    const known2 = internal.filter((entry) => entry.utilizationMilli !== null);
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "exhausted", serviceable: false, score: null, targetBurnRate: 0, observedBurnRate: 0, deficit: 0, accounts, knownAccountCount: known2.length, knownWeight: known2.reduce((sum, entry) => sum + (entry.aggregateWeight ?? 0), 0), serviceableAccountCount, urgentResetAt: trippedResets[0]?.resetsAt ?? null, reason: "serviceability-window-exhausted" };
  }
  if (internal.some((entry) => entry.indeterminateWeight)) {
    const weighted = internal.filter((entry) => entry.verdict.serviceable && entry.aggregateWeight !== null);
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "unknown", serviceable: null, score: null, targetBurnRate: null, observedBurnRate: null, deficit: null, accounts, knownAccountCount: weighted.length, knownWeight: weighted.reduce((sum, entry) => sum + entry.aggregateWeight, 0), serviceableAccountCount, urgentResetAt: null, reason: "indeterminate-account-weight" };
  }
  if (internal.some((entry) => entry.indeterminateGovernor)) {
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "unknown", serviceable: null, score: null, targetBurnRate: null, observedBurnRate: null, deficit: null, accounts, knownAccountCount: 0, knownWeight: 0, serviceableAccountCount, urgentResetAt: null, reason: "invalid-configured-governing-window" };
  }
  if (serviceableAccountCount === 0) {
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "exhausted", serviceable: false, score: null, targetBurnRate: 0, observedBurnRate: 0, deficit: 0, accounts, knownAccountCount: internal.filter((entry) => entry.utilizationMilli !== null).length, knownWeight: internal.filter((entry) => entry.utilizationMilli !== null).reduce((sum, entry) => sum + (entry.aggregateWeight ?? 0), 0), serviceableAccountCount, urgentResetAt: null, reason: "all-accounts-unserviceable" };
  }
  const known = internal.filter(
    (entry) => entry.verdict.serviceable && entry.utilizationMilli !== null && entry.elapsedMilli !== null && entry.resetAtMs !== null && entry.aggregateWeight !== null
  );
  if (known.length === 0) {
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "unknown", serviceable: true, score: null, targetBurnRate: null, observedBurnRate: null, deficit: null, accounts, knownAccountCount: 0, knownWeight: 0, serviceableAccountCount, urgentResetAt: null, reason: "no-computable-governing-window" };
  }
  const utilizationMilli = weightedMilli(known.map((entry) => ({ value: entry.utilizationMilli, weight: entry.aggregateWeight })));
  const elapsedMilli = weightedMilli(known.map((entry) => ({ value: entry.elapsedMilli, weight: entry.aggregateWeight })));
  const laneScore = score(utilizationMilli, elapsedMilli);
  const targetBurnRate = accounts.reduce(
    (sum, account) => account.serviceable && account.targetBurnRate != null ? sum + account.targetBurnRate : sum,
    0
  );
  const observedBurnRate = accounts.reduce(
    (sum, account) => account.serviceable && account.observedBurnRate != null ? sum + account.observedBurnRate : sum,
    0
  );
  const deficit = accounts.reduce(
    (sum, account) => account.serviceable && account.deficit != null ? sum + account.deficit : sum,
    0
  );
  let state = stateFor(utilizationMilli - elapsedMilli, marginMilli);
  const urgent = known.filter((entry) => entry.verdict.state === "push").sort((left, right) => left.resetAtMs - right.resetAtMs)[0];
  if (urgent) state = "behind-urgent";
  return {
    laneId: input.observation.laneId,
    observedAt: input.observation.observedAt,
    state,
    serviceable: true,
    score: laneScore,
    targetBurnRate,
    observedBurnRate,
    deficit,
    accounts,
    knownAccountCount: known.length,
    knownWeight: known.reduce((sum, entry) => sum + entry.aggregateWeight, 0),
    serviceableAccountCount,
    urgentResetAt: urgent?.verdict.urgentResetAt ?? urgent?.verdict.governingResetAt ?? null,
    reason: "ok"
  };
}

// src/engine/same-price-family.ts
function modelFamily(modelId) {
  const bare = modelId.includes("/") ? modelId.slice(modelId.lastIndexOf("/") + 1) : modelId;
  const segments = bare.split("-");
  while (segments.length > 1 && /^\d/.test(segments[segments.length - 1])) {
    segments.pop();
  }
  return segments.join("-");
}
function priceSignature(model) {
  return `${model.costPerMTokIn}:${model.costPerMTokOut}:${model.costPerMTokCacheRead}`;
}
function sharesPriceFamily(a, b) {
  return a.id !== b.id && a.enabled !== false && b.enabled !== false && a.tier === b.tier && modelFamily(a.id) === modelFamily(b.id) && priceSignature(a) === priceSignature(b);
}
function provenBetterVerdict(model) {
  const earnIn = model.earnIn;
  if (!earnIn || typeof earnIn !== "object") return false;
  return earnIn.verdict === "provenBetter";
}
function compareSamePriceFamily(a, b) {
  if (!sharesPriceFamily(a, b)) return 0;
  const aIsOlder = Date.parse(a.releasedAt) < Date.parse(b.releasedAt);
  const older = aIsOlder ? a : b;
  const newer = aIsOlder ? b : a;
  const winner = provenBetterVerdict(older) ? older : newer;
  return winner === a ? -1 : 1;
}

// src/engine/pacing.ts
function mergeLedgerEntry(ledger, result) {
  const previous = ledger[result.laneId];
  const observed = result.verdict ? unserviceableVerdict(result.verdict) : null;
  const priorSince = previous?.unserviceableSince ?? null;
  const priorReason = previous?.unserviceableReason ?? null;
  let unserviceableSince;
  let unserviceableReason;
  if (observed === null) {
    unserviceableSince = priorSince;
    unserviceableReason = priorReason;
  } else if (observed) {
    unserviceableSince = priorSince ?? result.fetchedAt;
    unserviceableReason = result.verdict.reason;
  } else {
    unserviceableSince = null;
    unserviceableReason = null;
  }
  return {
    ...ledger,
    [result.laneId]: {
      laneId: result.laneId,
      verdict: result.verdict,
      observation: result.observation ?? null,
      fetchedAt: result.fetchedAt,
      error: result.error,
      unserviceableSince,
      unserviceableReason,
      modelCooldownEvidence: result.verdict ? cooldownEvidence(result.observation ?? null) : previous?.modelCooldownEvidence ?? cooldownEvidence(previous?.observation ?? null)
    }
  };
}
function laneVerdictFor(ledger, laneId) {
  if (!laneId) return null;
  return ledger[laneId]?.verdict ?? null;
}
var PACE_STATE_RANK = {
  "behind-urgent": 0,
  behind: 1,
  on: 2,
  unknown: 3,
  free: 4,
  ahead: 5,
  exhausted: 6
};
function paceStateOf(ledger, model) {
  if (!model) return "unknown";
  return laneVerdictFor(ledger, model.laneId ?? null)?.state ?? "unknown";
}
var PACE_PULL_STATES = /* @__PURE__ */ new Set(["behind", "behind-urgent"]);
function isBehindPace(ledger, model) {
  return PACE_PULL_STATES.has(paceStateOf(ledger, model));
}
function pacePreferenceRank(ledger, model) {
  return PACE_STATE_RANK[paceStateOf(ledger, model)];
}
function deviationOf(ledger, model) {
  if (!model) return 0;
  return laneVerdictFor(ledger, model.laneId ?? null)?.score?.deviation ?? 0;
}
function modelOf(models, candidate) {
  return models.find((model) => model.id === candidate.modelId);
}
var PREFERRED_ELAPSED_THRESHOLD = 0.8;
function isPreferredNearReset(verdict, elapsedThreshold = PREFERRED_ELAPSED_THRESHOLD) {
  if (!verdict || verdict.serviceable !== true || !verdict.score) return false;
  return verdict.score.elapsed >= elapsedThreshold && verdict.score.deviation < 0;
}
function preferredOf(ledger, model, elapsedThreshold) {
  if (!model) return false;
  return isPreferredNearReset(laneVerdictFor(ledger, model.laneId ?? null), elapsedThreshold);
}
function preferredCandidateId(candidates, models, ledger, elapsedThreshold = PREFERRED_ELAPSED_THRESHOLD) {
  const preferred = candidates.find((candidate) => preferredOf(ledger, modelOf(models, candidate), elapsedThreshold));
  return preferred?.modelId ?? null;
}
function orderCandidatesByPace(candidates, models, ledger, options) {
  const elapsedThreshold = options?.preferredElapsedThreshold ?? PREFERRED_ELAPSED_THRESHOLD;
  const byTier = /* @__PURE__ */ new Map();
  const orderedTierKeys = [];
  for (const candidate of candidates) {
    let group = byTier.get(candidate.tier);
    if (!group) {
      group = [];
      byTier.set(candidate.tier, group);
      orderedTierKeys.push(candidate.tier);
    }
    group.push(candidate);
  }
  const result = [];
  for (const tierKey of orderedTierKeys) {
    const group = byTier.get(tierKey);
    group.sort((left, right) => {
      const leftModel = modelOf(models, left);
      const rightModel = modelOf(models, right);
      const leftPreferred = preferredOf(ledger, leftModel, elapsedThreshold);
      const rightPreferred = preferredOf(ledger, rightModel, elapsedThreshold);
      if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1;
      const stateDelta = PACE_STATE_RANK[paceStateOf(ledger, leftModel)] - PACE_STATE_RANK[paceStateOf(ledger, rightModel)];
      if (stateDelta !== 0) return stateDelta;
      const deviationDelta = deviationOf(ledger, leftModel) - deviationOf(ledger, rightModel);
      if (deviationDelta !== 0) return deviationDelta;
      if (left.expectedCostUsd !== right.expectedCostUsd) return left.expectedCostUsd - right.expectedCostUsd;
      if (leftModel && rightModel) {
        const familyOrder = compareSamePriceFamily(leftModel, rightModel);
        if (familyOrder !== 0) return familyOrder;
      }
      const leftRelease = leftModel?.releasedAt ?? "1970-01-01";
      const rightRelease = rightModel?.releasedAt ?? "1970-01-01";
      if (leftRelease !== rightRelease) return leftRelease > rightRelease ? -1 : 1;
      return left.modelId.localeCompare(right.modelId);
    });
    result.push(...group);
  }
  return result;
}
var INDETERMINATE_CAPACITY_REASONS = /* @__PURE__ */ new Set([
  "indeterminate-account-weight",
  "invalid-configured-governing-window"
]);
function cooldownEvidence(observation) {
  if (!observation || observation.error !== null || !observation.observedAt) return [];
  return observation.accounts.flatMap((account) => account.modelCooldowns?.length ? [{
    observedAt: observation.observedAt,
    staleAfterSeconds: Math.min(900, observation.staleAfterSeconds ?? 900, account.staleAfterSeconds ?? 900),
    entries: account.modelCooldowns
  }] : []);
}
function modelCooldownExcluded(ledger, model, nowMs) {
  const entry = model.laneId ? ledger[model.laneId] : null;
  if (!entry) return false;
  const evidence = entry.modelCooldownEvidence ?? cooldownEvidence(entry.observation);
  return evidence.some((sample) => {
    const ageMs = nowMs - Date.parse(sample.observedAt);
    return ageMs >= -6e4 && ageMs <= sample.staleAfterSeconds * 1e3 && activeModelCooldown(sample.entries, model.id, nowMs);
  });
}
function hardStopExcluded(ledger, model, nowMs = Date.now()) {
  const laneId = model.laneId ?? null;
  if (!laneId) return false;
  const entry = ledger[laneId];
  if (!entry) return false;
  if (modelCooldownExcluded(ledger, model, nowMs)) return true;
  if (entry.verdict) return unserviceableVerdict(entry.verdict);
  return (entry.unserviceableSince ?? null) !== null;
}
function unserviceableVerdict(verdict) {
  if (verdict.serviceable === false) return true;
  return verdict.serviceable === null && INDETERMINATE_CAPACITY_REASONS.has(verdict.reason);
}
function hashUnitInterval(input) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}
function slotFactorFor(ledger, model, slotFloorFraction) {
  const verdict = laneVerdictFor(ledger, model.laneId ?? null);
  if (!verdict || verdict.state !== "ahead") return 1;
  const floor = Math.max(Number.EPSILON, slotFloorFraction);
  return floor;
}
function slotAllowed(issueId, ledger, model, slotFloorFraction) {
  const factor = slotFactorFor(ledger, model, slotFloorFraction);
  if (factor >= 1) return true;
  return hashUnitInterval(issueId) < factor;
}
function activeOperatorOverride(overrides, issueId, nowIso) {
  const entry = overrides[issueId];
  if (!entry) return null;
  return entry.expiresAt > nowIso ? entry : null;
}
function recordOperatorOverride(overrides, issueId, modelId, nowIso, ttlSeconds) {
  const expiresAt = new Date(Date.parse(nowIso) + ttlSeconds * 1e3).toISOString();
  return { ...overrides, [issueId]: { issueId, modelId, setAt: nowIso, expiresAt } };
}
function avoidThresholdFor(config, laneId) {
  return config.perLane[laneId] ?? config.defaultThreshold;
}
function laneAvoidExcluded(ledger, model, config) {
  if (!model.laneId) return false;
  const score2 = laneVerdictFor(ledger, model.laneId)?.score;
  if (!score2 || !Number.isFinite(score2.utilization) || !Number.isFinite(score2.elapsed) || !Number.isFinite(score2.deviation)) return false;
  return score2.utilization >= avoidThresholdFor(config, model.laneId) && score2.deviation > DEFAULT_MARGIN;
}
function isLaneOutageActive(override, nowIso) {
  if (!override) return false;
  return override.until > nowIso;
}
function laneOutageExcluded(override, nowIso, model) {
  if (!isLaneOutageActive(override, nowIso)) return false;
  if (override.models.includes(model.id)) return true;
  if (model.laneId && override.lanes.includes(model.laneId)) return true;
  return false;
}
function blendedListPrice(model) {
  return (3 * model.costPerMTokIn + model.costPerMTokOut) / 4;
}
var ZAI_LONG_RUN_AGENTS = /* @__PURE__ */ new Set([
  "Founding Engineer",
  "Web Engineer",
  "Automation Engineer",
  "DevOps & Reliability Engineer",
  "CTO & Chief AI Officer",
  "Director of Engineering"
]);
function laneEffectiveUtilization(ledger, laneId) {
  const verdict = laneVerdictFor(ledger, laneId);
  const utilization = verdict?.score?.utilization;
  return utilization === null || utilization === void 0 ? 0.5 : utilization;
}
function zaiPeakNow(nowMs) {
  const now = new Date(nowMs);
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  return day >= 1 && day <= 5 && hour >= 6 && hour < 10;
}
function laneNamedWindowUtilization(ledger, laneId, windowName) {
  const observation = ledger[laneId]?.observation;
  if (!observation) return 0;
  const utilizations = observation.accounts.filter((account) => account.health === "healthy").flatMap((account) => {
    const window = account.windows.find((w) => w.name === windowName);
    return typeof window?.utilization === "number" ? [window.utilization] : [];
  });
  return utilizations.length > 0 ? Math.max(...utilizations) : 0;
}
function laneHealthyAccountCount(ledger, laneId) {
  const observation = ledger[laneId]?.observation;
  if (!observation) return 1;
  return observation.accounts.filter((account) => account.health === "healthy").length;
}
function activeZaiPaceOverride(override, nowIso) {
  if (!override) return null;
  return override.until > nowIso ? override.margin : null;
}
function zaiWeeklyPaceOk(input) {
  const margin = input.overrideMargin ?? input.defaultMargin;
  const observation = input.ledger[input.laneId]?.observation;
  const account = observation?.accounts[0];
  if (!account) return true;
  const window = account.windows.find((w) => w.name === input.weeklyWindowName);
  if (!window || window.utilization === null || window.resetsAt === null) return true;
  const remainingMs = Date.parse(window.resetsAt) - input.nowMs;
  const elapsed = 1 - Math.max(0, Math.min(1, remainingMs / (7 * 24 * 60 * 60 * 1e3)));
  return window.utilization <= elapsed + margin;
}
function laneHasRoom(input) {
  if (input.laneId === input.zaiLaneId) {
    const weeklyOk = zaiWeeklyPaceOk({
      ledger: input.ledger,
      laneId: input.laneId,
      weeklyWindowName: input.zaiWeeklyWindowName,
      defaultMargin: input.zaiWeeklyDefaultMargin,
      overrideMargin: input.zaiPaceOverrideMargin,
      nowMs: input.nowMs
    });
    if (!weeklyOk) return false;
  }
  let per = input.capPerAccount[input.laneId];
  if (input.laneId === input.zaiLaneId && per !== void 0 && zaiPeakNow(input.nowMs)) {
    per = 1;
  }
  if (per === void 0) return true;
  if (laneNamedWindowUtilization(input.ledger, input.laneId, input.fiveHourWindowName) >= 0.5) return false;
  const accounts = Math.max(1, laneHealthyAccountCount(input.ledger, input.laneId));
  return input.activePinsWeight + (input.extra ?? 0) < per * accounts;
}
function repinAllowed(context) {
  if (context.hasOperatorPin && !context.isServiceabilityHardStop) {
    return { allowed: false, reason: `${OPERATOR_PIN_LABEL} survives a routine pace repin` };
  }
  if (!context.isIdle) {
    return { allowed: false, reason: "issue has a running or queued run; never repin live work" };
  }
  if (context.lastRepinAt) {
    const elapsedSeconds = (Date.parse(context.now) - Date.parse(context.lastRepinAt)) / 1e3;
    if (elapsedSeconds < context.idleRepinHysteresisSeconds) {
      return { allowed: false, reason: `only ${Math.round(elapsedSeconds)}s since the last pace repin, below the ${context.idleRepinHysteresisSeconds}s hysteresis` };
    }
  }
  return { allowed: true, reason: context.isServiceabilityHardStop ? "serviceability hard stop overrides the operator pin" : "idle and past the repin hysteresis" };
}

// src/actuate/apply.ts
var TERMINAL_STATUSES = /* @__PURE__ */ new Set(["done", "cancelled"]);
function planApply(decision, context, targetIssueId) {
  const plan = planPin(decision, context, targetIssueId);
  if (plan.write || decision.advisory || !context.hasExistingOverride || !context.envRepair) return plan;
  const repair = planEnvRepair(context.envRepair, targetIssueId);
  if (!repair) return plan;
  return { ...repair, reason: `${repair.reason} (pin path declined: ${plan.reason})` };
}
function planEnvRepair(context, targetIssueId) {
  if (!context.pinnedModelId || context.staleSecretRefKeys.length === 0) return null;
  return {
    write: true,
    issueId: targetIssueId,
    modelId: context.pinnedModelId,
    labelName: null,
    envRepairOnly: true,
    reason: `env repair on pinned ${context.pinnedModelId}: override binds secret refs the assignee does not carry (${context.staleSecretRefKeys.join(", ")}); model unchanged`
  };
}
function planPin(decision, context, targetIssueId) {
  const nothing = (reason) => ({
    write: false,
    issueId: targetIssueId,
    modelId: null,
    labelName: null,
    reason,
    envRepairOnly: false
  });
  if (decision.advisory) {
    return nothing("advisory mode: enforcement is off for this company");
  }
  if (decision.outcome !== "selected" || !decision.modelId) {
    return nothing(`no model selected (outcome ${decision.outcome})`);
  }
  if (TERMINAL_STATUSES.has(context.status)) {
    return nothing(`issue status is ${context.status}; not re-pinning finished work`);
  }
  if (context.hasExistingOverride) {
    if (!context.paceRepin) {
      return nothing(
        "issue already carries assigneeAdapterOverrides; re-pinning would reset the session and discard the prompt cache"
      );
    }
    const gate = repinAllowed(context.paceRepin);
    if (!gate.allowed) {
      return nothing(`pace repin declined: ${gate.reason}`);
    }
  }
  const tier2 = decision.effectiveTier;
  return {
    write: true,
    issueId: targetIssueId,
    modelId: decision.modelId,
    labelName: context.hasExistingTierLabel || !tier2 ? null : tierLabelName(tier2),
    reason: `pinning ${decision.modelId} at ${tier2} \u2014 ${decision.trace.at(-1) ?? "selected"}`,
    envRepairOnly: false
  };
}
function tierLabelName(tier2) {
  return `${TIER_LABEL_PREFIX}${tier2}`;
}
function selectionWritesAllowed(config) {
  return config.selection.enabled && config.selection.mode === "enforce";
}

// src/admission-budget.ts
var UTILIZATION_ONLY_UNIT = "utilization-fraction";
var finiteBudgetValue = (n) => typeof n === "number" && Number.isFinite(n);
var nonnegative = (n) => finiteBudgetValue(n) && n >= 0;
var positive = (n) => finiteBudgetValue(n) && n > 0;
var budgetText = (s) => typeof s === "string" && s.trim().length > 0;
function stableBudgetId(s) {
  return typeof s === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(s) && !/^record-\d+$/i.test(s);
}
function budgetWindowId(w) {
  return JSON.stringify([w.providerId, w.poolId, w.kind, w.startAt, w.resetAt]);
}
function evaluateWindow(raw, input, conflicting) {
  const windowId = budgetWindowId(raw);
  const result = {
    windowId,
    raw: { ...raw },
    dataState: raw.dataState,
    reasons: [],
    reserved: null,
    elapsedFraction: null,
    utilization: null,
    safeBudget: null,
    targetRatePerMs: null,
    sustainableRatePerMs: null
  };
  const invalid = [];
  const unknown = [];
  if (conflicting) invalid.push("conflicting-pool-observations");
  if (!stableBudgetId(raw.providerId) || !stableBudgetId(raw.poolId)) invalid.push("unstable-identity");
  if (!["weekly", "five-hour", "monthly", "rolling"].includes(raw.kind)) invalid.push("invalid-window-kind");
  if (!["known", "unknown", "stale", "invalid"].includes(raw.dataState)) invalid.push("invalid-data-state");
  if (!positive(input.maxAgeMs) || !nonnegative(input.now)) invalid.push("invalid-evaluation-clock-or-freshness");
  const utilizationOnly = raw.unit === UTILIZATION_ONLY_UNIT;
  for (const field of ["startAt", "resetAt", "observedAt", "quota", "consumed", "safetyHeadroom", "planWeight"]) {
    if (raw[field] == null) {
      if (!(utilizationOnly && (field === "safetyHeadroom" || field === "planWeight"))) unknown.push(`missing-${field}`);
    } else if (!nonnegative(raw[field])) invalid.push(`invalid-${field}`);
  }
  for (const field of ["unit", "sourceRevision", "schemaRevision"]) {
    if (!budgetText(raw[field])) unknown.push(`missing-${field}`);
  }
  if (finiteBudgetValue(raw.quota) && raw.quota <= 0) invalid.push("nonpositive-quota");
  if (finiteBudgetValue(raw.planWeight) && raw.planWeight <= 0) invalid.push("nonpositive-plan-weight");
  if (finiteBudgetValue(raw.consumed) && finiteBudgetValue(raw.quota) && raw.consumed > raw.quota) invalid.push("usage-out-of-range");
  if (finiteBudgetValue(raw.startAt) && finiteBudgetValue(raw.resetAt) && raw.startAt >= raw.resetAt) invalid.push("contradictory-window");
  if (finiteBudgetValue(raw.observedAt) && (raw.observedAt > input.now || finiteBudgetValue(raw.startAt) && raw.observedAt < raw.startAt || finiteBudgetValue(raw.resetAt) && raw.observedAt >= raw.resetAt)) invalid.push("contradictory-observation-clock");
  if (finiteBudgetValue(raw.startAt) && input.now < raw.startAt) unknown.push("window-not-open");
  if (finiteBudgetValue(raw.resetAt) && input.now >= raw.resetAt) unknown.push("window-closed");
  if (raw.dataState !== "known") result.reasons.push(`source-${raw.dataState}`);
  result.reasons.push(...invalid, ...unknown);
  if (invalid.length || raw.dataState === "invalid") result.dataState = "invalid";
  else if (unknown.length) result.dataState = "unknown";
  else if (input.now - raw.observedAt > input.maxAgeMs) {
    result.dataState = "stale";
    result.reasons.push("observation-too-old");
  }
  if (result.dataState !== "known") return result;
  if (utilizationOnly) {
    return {
      ...result,
      reasons: [...result.reasons, "utilization-only-no-budget"],
      elapsedFraction: (input.now - raw.startAt) / (raw.resetAt - raw.startAt),
      utilization: raw.consumed / raw.quota
    };
  }
  const holds = input.holds.filter((h) => h.windowId === windowId);
  if (holds.some((h) => h.unit !== raw.unit || !nonnegative(h.amount))) {
    return { ...result, dataState: "invalid", reasons: [...result.reasons, "invalid-incremental-hold"] };
  }
  const reserved = holds.reduce((sum, h) => sum + h.amount, 0);
  const remainingMs = raw.resetAt - input.now;
  const safeBudget = Math.max(0, raw.quota - raw.consumed - reserved - raw.safetyHeadroom);
  if (!finiteBudgetValue(reserved) || !finiteBudgetValue(remainingMs)) {
    return { ...result, dataState: "invalid", reasons: [...result.reasons, "numeric-overflow"] };
  }
  const targetRatePerMs = Math.max(0, 0.98 * raw.quota - raw.consumed - reserved) / remainingMs;
  const sustainableRatePerMs = safeBudget / remainingMs;
  if (!finiteBudgetValue(targetRatePerMs) || !finiteBudgetValue(sustainableRatePerMs)) {
    return { ...result, dataState: "invalid", reasons: [...result.reasons, "numeric-overflow"] };
  }
  return {
    ...result,
    reserved,
    elapsedFraction: (input.now - raw.startAt) / (raw.resetAt - raw.startAt),
    utilization: raw.consumed / raw.quota,
    safeBudget,
    targetRatePerMs,
    sustainableRatePerMs
  };
}
function evaluateBinding(binding, windows, input) {
  const result = {
    bindingKey: binding.bindingKey,
    lane: binding.lane,
    accountId: binding.accountId,
    proposal: "unknown",
    reasons: [],
    targetInfeasibility: [],
    continuousConcurrency: null,
    integerConcurrency: null,
    allowedStarts: null,
    nextEligibleStartAt: null,
    projections: []
  };
  const add = (reason) => {
    result.reasons.push(reason);
  };
  if (!stableBudgetId(binding.accountId) || !stableBudgetId(binding.providerId) || !budgetText(binding.bindingKey) || !budgetText(binding.lane)) add("invalid-binding-identity");
  if (!binding.windowIds?.length) {
    add("account-binding-unavailable");
    result.targetInfeasibility.push("account-binding-unavailable");
    return result;
  }
  if (!Number.isSafeInteger(binding.activeSlots) || binding.activeSlots < 0 || !Number.isSafeInteger(binding.maxSlots) || binding.maxSlots < 0 || typeof binding.canStart !== "boolean" || binding.cooldownUntil !== null && !nonnegative(binding.cooldownUntil)) add("invalid-operational-gates");
  const constraints = [...new Set(binding.windowIds)].map((id) => windows.get(id));
  if (constraints.some((w) => !w || w.dataState !== "known" || w.raw.unit === UTILIZATION_ONLY_UNIT)) {
    add("allowance-unknown");
    result.targetInfeasibility.push("allowance-unknown");
  }
  if (constraints.some((w) => w && w.raw.providerId !== binding.providerId)) add("incompatible-provider");
  const estimate = binding.estimate;
  if (!estimate || !budgetText(estimate.revision) || !positive(estimate.durationMs)) {
    add("burn-unknown");
    result.targetInfeasibility.push("burn-unknown");
  }
  const burns = /* @__PURE__ */ new Map();
  for (const burn of estimate?.windows ?? []) {
    if (burns.has(burn.windowId)) add("duplicate-window-estimate");
    burns.set(burn.windowId, burn);
  }
  if (result.reasons.length) return result;
  let starts = Infinity;
  let concurrency = Infinity;
  let hasRuntimeBurn = true;
  let nextStart = input.now;
  let insufficient = false;
  for (const w of constraints) {
    const burn = burns.get(w.windowId);
    if (!burn || !positive(burn.upperBurn) || burn.unit !== w.raw.unit || burn.burnPerMs !== void 0 && !positive(burn.burnPerMs) || burn.remainingDemandBurn !== void 0 && !nonnegative(burn.remainingDemandBurn)) {
      add("burn-unknown-or-unit-mismatch");
      result.targetInfeasibility.push("burn-unknown");
      continue;
    }
    if (input.now + estimate.durationMs >= w.raw.resetAt) add("reset-crossover-unsupported");
    starts = Math.min(starts, Math.floor(w.safeBudget / burn.upperBurn));
    if (burn.upperBurn > w.safeBudget) insufficient = true;
    if (w.targetRatePerMs > w.sustainableRatePerMs) result.targetInfeasibility.push("safety-ceiling-precludes-target");
    if (burn.remainingDemandBurn === void 0) result.targetInfeasibility.push("remaining-demand-unknown");
    else if (w.raw.consumed + w.reserved + burn.remainingDemandBurn < 0.98 * w.raw.quota) {
      result.targetInfeasibility.push("insufficient-eligible-demand");
    }
    const projected = burn.remainingDemandBurn === void 0 ? null : (w.raw.consumed + w.reserved + burn.remainingDemandBurn) / w.raw.quota;
    result.projections.push({
      windowId: w.windowId,
      projectedEndUtilization: projected,
      earlyExhaustionRisk: projected === null ? null : w.raw.consumed + w.reserved + burn.remainingDemandBurn > w.raw.quota - w.raw.safetyHeadroom
    });
    if (burn.burnPerMs === void 0) hasRuntimeBurn = false;
    else {
      const windowConcurrency = w.sustainableRatePerMs / burn.burnPerMs;
      if (!finiteBudgetValue(windowConcurrency)) {
        add("runtime-burn-overflow");
        continue;
      }
      concurrency = Math.min(concurrency, windowConcurrency);
      nextStart = Math.max(nextStart, w.raw.resetAt - w.safeBudget / burn.burnPerMs);
    }
  }
  result.targetInfeasibility = [...new Set(result.targetInfeasibility)];
  if (result.reasons.length) return result;
  const slots = Math.max(0, binding.maxSlots - binding.activeSlots);
  const cooling = binding.cooldownUntil !== null && binding.cooldownUntil > input.now;
  result.allowedStarts = binding.canStart && !cooling ? Math.min(starts, slots) : 0;
  if (hasRuntimeBurn) {
    result.continuousConcurrency = concurrency;
    result.integerConcurrency = binding.canStart && !cooling ? Math.min(Math.floor(concurrency), slots) : 0;
    nextStart = Math.ceil(Math.max(nextStart, binding.cooldownUntil ?? input.now));
    if (binding.canStart && slots > 0 && !insufficient && constraints.every((w) => nextStart + estimate.durationMs < w.raw.resetAt)) {
      result.nextEligibleStartAt = Math.ceil(nextStart);
    }
  } else result.targetInfeasibility.push("runtime-burn-unknown");
  if (insufficient) add("safe-budget-insufficient");
  if (!binding.canStart) add("lane-gate-closed");
  if (!slots) add("active-slot-limit");
  if (cooling) add("cooldown");
  if (hasRuntimeBurn && result.integerConcurrency === 0) add("fractional-concurrency-or-operational-limit");
  result.proposal = result.reasons.length ? "defer" : "admit";
  return result;
}
function evaluateBudgets(input) {
  const groups = /* @__PURE__ */ new Map();
  for (const w of input.windows) {
    const id = budgetWindowId(w);
    groups.set(id, [...groups.get(id) ?? [], w]);
  }
  const currentWindows = /* @__PURE__ */ new Map();
  for (const w of input.windows) {
    if (w.kind === "rolling" || !finiteBudgetValue(w.startAt) || !finiteBudgetValue(w.resetAt) || w.startAt > input.now || w.resetAt <= input.now) continue;
    const key = JSON.stringify([w.providerId, w.poolId, w.kind]);
    const ids = currentWindows.get(key) ?? /* @__PURE__ */ new Set();
    ids.add(budgetWindowId(w));
    currentWindows.set(key, ids);
  }
  const windows = [...groups.values()].map((group) => {
    const first = group[0];
    const fingerprint = (w) => JSON.stringify(w, Object.keys(w).sort());
    const contradictoryReset = (currentWindows.get(JSON.stringify([first.providerId, first.poolId, first.kind]))?.size ?? 0) > 1;
    return evaluateWindow(first, input, contradictoryReset || group.some((w) => fingerprint(w) !== fingerprint(first)));
  });
  const byId = new Map(windows.map((w) => [w.windowId, w]));
  const bindingCounts = /* @__PURE__ */ new Map();
  for (const b of input.eligibleBindings) bindingCounts.set(b.bindingKey, (bindingCounts.get(b.bindingKey) ?? 0) + 1);
  return {
    mode: "shadow-only",
    governsHostStarts: false,
    selectedOrServedAccount: null,
    evaluatedAt: input.now,
    maxAgeMs: input.maxAgeMs,
    windows,
    observations: input.windows.map((w) => ({ ...w })),
    bindings: input.eligibleBindings.map((b) => {
      const budget = evaluateBinding(b, byId, input);
      return bindingCounts.get(b.bindingKey) > 1 ? {
        ...budget,
        proposal: "unknown",
        reasons: [...budget.reasons, "ambiguous-binding-key"],
        continuousConcurrency: null,
        integerConcurrency: null,
        allowedStarts: null,
        nextEligibleStartAt: null
      } : budget;
    })
  };
}

// src/admission-lane-bindings.ts
var FIVE_HOUR = { kind: "five-hour", utilizationField: "five_hour_utilization", resetField: "five_hour_resets_at" };
var SEVEN_DAY = { kind: "weekly", utilizationField: "seven_day_utilization", resetField: "seven_day_resets_at" };
var WEEKLY = { kind: "weekly", utilizationField: "weekly_utilization", resetField: "weekly_resets_at" };
var COMMITTED_LANE_ACCOUNT_BINDINGS = [
  { laneId: "claude-lane-1", accountId: "claude-acct-1", poolId: "claude-pool-1", providerId: "claude", windows: [FIVE_HOUR, SEVEN_DAY] },
  { laneId: "claude-lane-2", accountId: "claude-acct-2", poolId: "claude-pool-2", providerId: "claude", windows: [FIVE_HOUR, SEVEN_DAY] },
  { laneId: "codex-lane-1", accountId: "codex-acct-1", poolId: "codex-pool-1", providerId: "codex", windows: [WEEKLY] },
  { laneId: "codex-lane-2", accountId: "codex-acct-2", poolId: "codex-pool-2", providerId: "codex", windows: [WEEKLY] },
  { laneId: "codex-lane-3", accountId: "codex-acct-3", poolId: "codex-pool-3", providerId: "codex", windows: [WEEKLY] },
  { laneId: "zai-lane-1", accountId: "zai-acct-1", poolId: "zai-pool-1", providerId: "zai", windows: [FIVE_HOUR, WEEKLY] }
];

// src/admission-observation.ts
var WINDOW_MS = {
  "five-hour": 5 * 60 * 60 * 1e3,
  weekly: 7 * 24 * 60 * 60 * 1e3
};
var RESET_IDENTITY_GRID_MS = 6e4;
var MAX_BINDING_ACCOUNTS = 64;
var ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
var finiteObserved = (n) => typeof n === "number" && Number.isFinite(n);
function validateLaneAccountBindings(bindings) {
  if (!bindings.length || bindings.length > MAX_BINDING_ACCOUNTS) throw new Error("invalid-lane-binding-table-size");
  const lanes = /* @__PURE__ */ new Set();
  const accounts = /* @__PURE__ */ new Set();
  const pools = /* @__PURE__ */ new Map();
  for (const entry of bindings) {
    if (![entry.laneId, entry.accountId, entry.poolId, entry.providerId].every(stableBudgetId)) {
      throw new Error("unstable-lane-binding-identity");
    }
    if (lanes.has(entry.laneId)) throw new Error("duplicate-lane-binding");
    if (accounts.has(entry.accountId)) throw new Error("duplicate-account-binding");
    lanes.add(entry.laneId);
    accounts.add(entry.accountId);
    const kinds = entry.windows.map((w) => w.kind);
    if (!kinds.length || new Set(kinds).size !== kinds.length || entry.windows.some((w) => !(w.kind in WINDOW_MS) || !w.utilizationField || !w.resetField)) {
      throw new Error("invalid-lane-binding-windows");
    }
    const key = [...kinds].sort().join(",");
    const pool = pools.get(entry.poolId);
    if (pool && (pool.providerId !== entry.providerId || pool.kinds !== key)) throw new Error("inconsistent-shared-pool");
    pools.set(entry.poolId, { providerId: entry.providerId, kinds: key });
  }
}
function epochMs(value) {
  if (finiteObserved(value)) return value >= 0 ? value : null;
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
var qualityOf = (value) => value === "live" || value === "cached" || value === "counts-only" ? value : null;
var RANK = { known: 0, stale: 1, unknown: 2, invalid: 3 };
function adaptLaneQuotaSnapshot(input) {
  const bindings = input.bindings ?? COMMITTED_LANE_ACCOUNT_BINDINGS;
  validateLaneAccountBindings(bindings);
  if (!finiteObserved(input.maxAgeMs) || input.maxAgeMs <= 0) throw new Error("invalid-observation-max-age");
  if (!finiteObserved(input.now) || input.now < 0) throw new Error("invalid-observation-clock");
  if (!["synthetic-replay", "observed-replay", "fresh-observations"].includes(input.evidenceKind)) {
    throw new Error("invalid-observation-evidence-kind");
  }
  const snapshot = input.snapshot;
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.records) || snapshot.records.length > 256) {
    throw new Error("invalid-lane-quota-snapshot");
  }
  const observedAt = epochMs(snapshot.observedAt);
  const sourceRevision = observedAt === null ? null : `lane-quota-snapshot@${new Date(observedAt).toISOString()}`;
  const schemaRevision = Number.isSafeInteger(snapshot.schemaVersion) ? `lane-quota-snapshot-v${snapshot.schemaVersion}` : null;
  const byLane = /* @__PURE__ */ new Map();
  const unmappedLanes = [];
  let unstableLaneCount = 0;
  const known = new Set(bindings.map((b) => b.laneId));
  for (const record3 of snapshot.records) {
    const lane = record3 && typeof record3 === "object" ? record3.lane ?? record3.laneId : void 0;
    if (!stableBudgetId(lane)) {
      unstableLaneCount += 1;
      continue;
    }
    byLane.set(lane, [...byLane.get(lane) ?? [], record3]);
    if (!known.has(lane) && !unmappedLanes.includes(lane)) unmappedLanes.push(lane);
  }
  const windows = [];
  const rows = [];
  const seen = /* @__PURE__ */ new Set();
  const accounts = [];
  const missingLanes = [];
  for (const binding of bindings) {
    const records = byLane.get(binding.laneId) ?? [];
    const record3 = records.length === 1 ? records[0] : null;
    if (!records.length) missingLanes.push(binding.laneId);
    const windowIds = [];
    for (const window of binding.windows) {
      const reasons = [];
      let state = "known";
      const raise = (next, reason) => {
        reasons.push(reason);
        if (RANK[next] > RANK[state]) state = next;
      };
      const rawQuality = record3?.observationQuality ?? snapshot.observationQuality;
      const observationQuality = qualityOf(rawQuality);
      const rawUtilization = record3?.[window.utilizationField];
      const reportedReset = record3?.[window.resetField];
      const reportedResetMs = epochMs(reportedReset);
      const resetAt = reportedResetMs === null ? null : Math.round(reportedResetMs / RESET_IDENTITY_GRID_MS) * RESET_IDENTITY_GRID_MS;
      const startAt = resetAt === null ? null : resetAt - WINDOW_MS[window.kind];
      const utilization = finiteObserved(rawUtilization) ? rawUtilization : null;
      if (!records.length) raise("unknown", "lane-absent-from-snapshot");
      else if (!record3) raise("invalid", "duplicate-lane-record");
      if (record3) {
        if (observationQuality === "counts-only") raise("unknown", "counts-only-no-utilization");
        else if (observationQuality === null) raise("unknown", "observation-quality-missing-or-unrecognized");
        if (rawUtilization === void 0 || rawUtilization === null) raise("unknown", "missing-utilization");
        else if (utilization === null) raise("invalid", "utilization-not-a-number");
        else if (utilization < 0 || utilization > 1) raise("invalid", "utilization-out-of-range");
        if (reportedReset === void 0 || reportedReset === null) raise("invalid", "missing-reset");
        else if (reportedResetMs === null) raise("invalid", "reset-unparseable");
      }
      if (observedAt === null) raise("invalid", "missing-observed-at");
      else {
        if (observedAt > input.now) raise("invalid", "observation-in-future");
        if (resetAt !== null && resetAt <= observedAt) raise("invalid", "reset-not-after-observation");
        if (resetAt !== null && resetAt - observedAt > WINDOW_MS[window.kind]) raise("invalid", "reset-beyond-window-length");
      }
      if (record3 && observationQuality === "cached") raise("stale", "cached-observation");
      const tooOld = !!record3 && observedAt !== null && input.now - observedAt > input.maxAgeMs;
      if (tooOld) raise("stale", "older-than-max-age");
      const countsOnly = observationQuality === "counts-only";
      const observation = {
        providerId: binding.providerId,
        poolId: binding.poolId,
        kind: window.kind,
        startAt,
        resetAt,
        observedAt,
        sourceRevision,
        schemaRevision,
        unit: UTILIZATION_ONLY_UNIT,
        quota: utilization !== null && !countsOnly ? 1 : null,
        consumed: countsOnly ? null : utilization,
        safetyHeadroom: null,
        planWeight: null,
        dataState: state
      };
      rows.push({
        laneId: binding.laneId,
        accountId: binding.accountId,
        poolId: binding.poolId,
        providerId: binding.providerId,
        windowKind: window.kind,
        windowId: budgetWindowId(observation),
        state,
        reasons,
        observationQuality,
        utilization: countsOnly ? null : utilization,
        reportedResetAt: reportedResetMs === null ? null : new Date(reportedResetMs).toISOString(),
        resetAt,
        freshness: !record3 ? "unobserved" : observationQuality === "cached" ? "cached" : tooOld ? "too-old" : observationQuality === "live" ? "fresh" : "unknown"
      });
      windowIds.push(budgetWindowId(observation));
      const print = JSON.stringify(observation);
      if (!seen.has(print)) {
        seen.add(print);
        windows.push(observation);
      }
    }
    accounts.push({ accountId: binding.accountId, providerId: binding.providerId, windowIds });
  }
  const groupKey = (w) => JSON.stringify([w.providerId, w.poolId, w.kind]);
  const usable = (state) => state === "known" || state === "stale";
  const prints = /* @__PURE__ */ new Map();
  for (const w of windows) {
    if (usable(w.dataState)) prints.set(groupKey(w), /* @__PURE__ */ new Set([...prints.get(groupKey(w)) ?? [], JSON.stringify(w)]));
  }
  const conflicted = new Set([...prints].filter(([, group]) => group.size > 1).map(([key]) => key));
  for (const w of windows) if (conflicted.has(groupKey(w)) && usable(w.dataState)) w.dataState = "invalid";
  for (const row of rows) {
    if (!conflicted.has(groupKey({ providerId: row.providerId, poolId: row.poolId, kind: row.windowKind })) || !usable(row.state)) continue;
    row.state = "invalid";
    row.reasons.push("conflicting-shared-pool-observations");
  }
  return {
    schema: "lane-quota-observation-adapter-v1",
    evidenceKind: input.evidenceKind,
    snapshotObservedAt: observedAt,
    maxAgeMs: input.maxAgeMs,
    accounts,
    windows,
    rows,
    unmappedLanes,
    unstableLaneCount,
    missingLanes,
    limitations: [
      "Utilization fractions are advisory attainment only: no budget, headroom, plan weight or allowed-start claim.",
      "Lane-to-account identity is the committed table, not an observed served account.",
      "Evidence kind is caller-declared; this adapter does not certify provenance or freshness beyond maxAgeMs."
    ]
  };
}

// src/admission-shadow.ts
function reportDecisionAdmissionShadow(rawInput, now, eligibleModels) {
  if (rawInput.enabled === false) return null;
  if (JSON.stringify(rawInput).length > 128 * 1024 || (rawInput.bindings?.length ?? 0) > 256) {
    throw new Error("decision-shadow-input-too-large");
  }
  const fields = (value, allowed) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("unexpected-shadow-input-fields");
  };
  let adapted = null;
  let input;
  if ("laneQuotaSnapshot" in rawInput && rawInput.laneQuotaSnapshot !== void 0) {
    fields(rawInput, ["enabled", "cohortId", "maxAgeMs", "laneQuotaSnapshot", "holds", "bindings"]);
    fields(rawInput.laneQuotaSnapshot, ["schemaVersion", "observedAt", "staleAfterSeconds", "observationQuality", "records"]);
    adapted = adaptLaneQuotaSnapshot({
      snapshot: rawInput.laneQuotaSnapshot,
      now,
      maxAgeMs: rawInput.maxAgeMs,
      evidenceKind: "fresh-observations"
    });
    input = {
      enabled: rawInput.enabled,
      cohortId: rawInput.cohortId,
      accounts: adapted.accounts,
      maxAgeMs: rawInput.maxAgeMs,
      windows: adapted.windows,
      holds: rawInput.holds ?? [],
      bindings: rawInput.bindings ?? []
    };
  } else input = rawInput;
  fields(input, ["enabled", "cohortId", "accounts", "maxAgeMs", "windows", "holds", "bindings"]);
  for (const account of input.accounts) fields(account, ["accountId", "providerId", "windowIds"]);
  for (const window of input.windows) fields(window, [
    "providerId",
    "poolId",
    "kind",
    "startAt",
    "resetAt",
    "observedAt",
    "sourceRevision",
    "schemaRevision",
    "unit",
    "quota",
    "consumed",
    "safetyHeadroom",
    "planWeight",
    "dataState"
  ]);
  for (const hold of input.holds) fields(hold, ["windowId", "unit", "amount"]);
  for (const entry of input.bindings) {
    fields(entry, ["modelId", "binding"]);
    fields(entry.binding, [
      "bindingKey",
      "lane",
      "accountId",
      "providerId",
      "windowIds",
      "canStart",
      "activeSlots",
      "maxSlots",
      "cooldownUntil",
      "estimate"
    ]);
    if (entry.binding.estimate !== null) {
      fields(entry.binding.estimate, ["revision", "durationMs", "windows"]);
      for (const burn of entry.binding.estimate.windows) fields(
        burn,
        ["windowId", "unit", "upperBurn", "burnPerMs", "remainingDemandBurn"]
      );
    }
  }
  const bindings = input.bindings.filter((entry) => eligibleModels.some((model) => model.modelId === entry.modelId && model.lane !== null && model.lane === entry.binding.lane));
  const report = reportAdmissionShadow({
    enabled: input.enabled,
    cohortId: input.cohortId,
    accounts: input.accounts,
    evidenceKind: "fresh-observations",
    startAt: now,
    endAt: now,
    samples: [{
      now,
      maxAgeMs: input.maxAgeMs,
      windows: input.windows,
      holds: input.holds,
      eligibleBindings: bindings.map((entry) => entry.binding)
    }]
  });
  if (report) {
    for (const account of report.accounts) {
      account.infeasibilityReasons = account.infeasibilityReasons.map((reason) => reason === "no-capable-demand" ? "no-observed-eligible-account-binding" : reason);
    }
    report.limitations.push(`Existing landing-tier candidates only; ${input.bindings.length - bindings.length} supplied bindings excluded. No eligibility was added.`);
    if (adapted) {
      const { schema, evidenceKind, snapshotObservedAt, maxAgeMs, rows, unmappedLanes, unstableLaneCount, missingLanes } = adapted;
      report.observationAdapter = { schema, evidenceKind, snapshotObservedAt, maxAgeMs, rows, unmappedLanes, unstableLaneCount, missingLanes };
      report.limitations.push(...adapted.limitations);
    }
    if (JSON.stringify(report).length > 512 * 1024) throw new Error("decision-shadow-report-too-large");
  }
  return report;
}
var MAX_ACCOUNTS = 64;
var MAX_SAMPLES = 256;
var MAX_WINDOWS = 256;
var DAY_MS = 24 * 60 * 60 * 1e3;
var clock = (n) => Number.isFinite(n) && n >= 0;
function reportAdmissionShadow(input) {
  if (input.enabled === false) return null;
  if (input.enabled !== true || !stableBudgetId(input.cohortId) || !input.accounts.length || input.accounts.length > MAX_ACCOUNTS || !input.samples.length || input.samples.length > MAX_SAMPLES || !clock(input.startAt) || !clock(input.endAt) || input.endAt < input.startAt || !["synthetic-replay", "observed-replay", "fresh-observations"].includes(input.evidenceKind)) {
    throw new Error("invalid-shadow-bounds-or-cohort");
  }
  const accountIds = /* @__PURE__ */ new Set();
  const windowIds = /* @__PURE__ */ new Set();
  for (const account of input.accounts) {
    if (!stableBudgetId(account.accountId) || !stableBudgetId(account.providerId) || accountIds.has(account.accountId) || !account.windowIds.length || account.windowIds.length > MAX_WINDOWS || new Set(account.windowIds).size !== account.windowIds.length) {
      throw new Error("invalid-shadow-account-identity-or-windows");
    }
    accountIds.add(account.accountId);
    for (const id of account.windowIds) windowIds.add(id);
  }
  if (windowIds.size > MAX_WINDOWS) throw new Error("too-many-shadow-windows");
  if (input.evidenceKind === "fresh-observations" && input.endAt - input.startAt > DAY_MS) {
    throw new Error("fresh-shadow-period-exceeds-24-hours");
  }
  const accounts = new Map(input.accounts.map((a) => [a.accountId, a]));
  const replayWindows = /* @__PURE__ */ new Map();
  let previousAt = -1;
  for (const sample of input.samples) {
    if (!clock(sample.now) || sample.now < input.startAt || sample.now > input.endAt || sample.now <= previousAt || sample.windows.length > MAX_WINDOWS || sample.eligibleBindings.length > 256 || sample.holds.length > 1024) {
      throw new Error("invalid-shadow-sample-bounds");
    }
    previousAt = sample.now;
    for (const observation of sample.windows) {
      const id = budgetWindowId(observation);
      if (!windowIds.has(id)) throw new Error("observation-outside-fixed-shadow-cohort");
      if (observation.startAt !== null && observation.resetAt !== null && clock(observation.startAt) && clock(observation.resetAt) && observation.resetAt > observation.startAt) {
        replayWindows.set(id, { startAt: observation.startAt, resetAt: observation.resetAt });
      }
      for (const account of input.accounts.filter((a) => a.windowIds.includes(id))) {
        if (account.providerId !== observation.providerId) throw new Error("shadow-cohort-provider-mismatch");
      }
    }
    for (const binding of sample.eligibleBindings) {
      const account = accounts.get(binding.accountId);
      if (!account || binding.providerId !== account.providerId || binding.windowIds?.some((id) => !account.windowIds.includes(id))) {
        throw new Error("binding-outside-fixed-shadow-cohort");
      }
      if (binding.windowIds !== null && account.windowIds.some((id) => !binding.windowIds.includes(id))) {
        throw new Error("binding-omits-governing-shadow-window");
      }
    }
    if (sample.holds.some((h) => !windowIds.has(h.windowId))) throw new Error("hold-outside-fixed-shadow-cohort");
  }
  if (input.evidenceKind !== "fresh-observations") {
    if ([...windowIds].some((id) => !replayWindows.has(id))) throw new Error("unknown-replay-window-bounds");
    for (const { startAt, resetAt } of replayWindows.values()) {
      if (input.startAt < startAt || input.endAt > resetAt) throw new Error("shadow-replay-exceeds-one-window");
    }
  }
  const evaluations = input.samples.map(evaluateBudgets);
  const latest = evaluations[evaluations.length - 1];
  return {
    mode: "shadow-only",
    governsHostStarts: false,
    claimsReservations: false,
    selectedOrServedAccount: null,
    cohortId: input.cohortId,
    evidenceKind: input.evidenceKind,
    productionEvidenceCertified: false,
    startAt: input.startAt,
    endAt: input.endAt,
    sampleCount: evaluations.length,
    firstEvaluatedAt: evaluations[0].evaluatedAt,
    lastEvaluatedAt: latest.evaluatedAt,
    completeWindowValidation: "unproven",
    freshObservationValidation: "unproven",
    accounts: input.accounts.map((account) => {
      const bindingBudgets = evaluations.flatMap((e) => e.bindings.filter((b) => b.accountId === account.accountId));
      const reasons = [...new Set(bindingBudgets.flatMap((b) => b.targetInfeasibility))];
      if (evaluations.some((e) => !e.bindings.some((b) => b.accountId === account.accountId))) reasons.push("no-capable-demand");
      if (account.windowIds.some((id) => !latest.windows.some((w) => w.windowId === id && w.dataState === "known" && w.safeBudget !== null))) {
        reasons.push("allowance-unknown");
      }
      return {
        accountId: account.accountId,
        providerId: account.providerId,
        sampleCount: evaluations.length,
        proposalCounts: {
          admit: bindingBudgets.filter((b) => b.proposal === "admit").length,
          defer: bindingBudgets.filter((b) => b.proposal === "defer").length,
          unknown: bindingBudgets.filter((b) => b.proposal === "unknown").length
        },
        infeasibilityReasons: [...new Set(reasons)],
        windows: account.windowIds.map((windowId) => {
          const window = latest.windows.find((w) => w.windowId === windowId);
          const utilization = window?.utilization ?? null;
          const known = evaluations.flatMap((e) => e.windows.filter((w) => w.windowId === windowId && w.dataState === "known"));
          return {
            windowId,
            observedAt: window?.raw.observedAt ?? null,
            utilizationAtLastSample: utilization,
            attainmentAtLastSample: utilization === null ? "unknown" : utilization >= 0.98 && utilization <= 1 ? "98-100" : "underuse",
            earlyExhaustionObserved: known.length ? known.some((w) => w.utilization === 1) : null,
            estimatedVersusActualBurnError: null,
            reserveOverlapUncertainty: "unknown"
          };
        })
      };
    }),
    evaluations,
    limitations: [
      "No host start/retry/wake paths covered; no production atomic reservation storage.",
      "Account compatibility is supplied evidence, not proof of selected or served upstream account.",
      "Attainment is at the last valid sample, not certified end-of-window utilization.",
      "No attributed actual-burn ledger: burn error and reservation overlap remain unknown.",
      "Complete-window replay and fresh provider-observation validation remain unproven.",
      ...input.evidenceKind === "synthetic-replay" ? ["Synthetic fixtures are not production evidence."] : []
    ]
  };
}

// src/context-evidence.ts
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
var MAX_CONTEXT_LOG_BYTES = 8 * 1024 * 1024;
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function count2(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function peakFromRunLog(log) {
  if (log.includes("[paperclip truncated run log chunk")) return null;
  let stdout = "";
  try {
    for (const line of log.split("\n")) {
      if (!line.trim()) continue;
      const envelope = record(JSON.parse(line));
      if (typeof envelope.chunk !== "string" || envelope.stream !== "stdout" && envelope.stream !== "stderr") return null;
      if (envelope.stream === "stdout") stdout += envelope.chunk;
    }
    let peak = 0;
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      const event = record(JSON.parse(line));
      if (event.type === "turn.completed") return null;
      if (event.type !== "assistant") continue;
      const message = record(event.message);
      const usage = record(message.usage);
      const parts = [usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens].map(count2);
      if (parts.some((part) => part === null)) return null;
      const tokens = parts.reduce((sum, part) => sum + part, 0);
      if (!Number.isSafeInteger(tokens)) return null;
      peak = Math.max(peak, tokens);
    }
    return peak > 0 ? peak : null;
  } catch {
    return null;
  }
}
async function readRunContextEvidence(row, companyId, logRoot) {
  const run = record(row);
  const runId = typeof run.id === "string" ? run.id : null;
  const fallback = (evidence) => ({
    lastRunPeakTokens: null,
    history: "run-found",
    runId,
    evidence
  });
  if (!runId) return fallback("malformed-run-row");
  if (!logRoot || !isAbsolute(logRoot)) return fallback("log-root-unconfigured");
  if (run.log_store !== "local_file" || run.log_compressed !== false)
    return fallback("unsupported-log-store");
  const agentId = typeof run.agent_id === "string" ? run.agent_id : "";
  const safeId = /^[a-zA-Z0-9_-]+$/;
  if (![companyId, agentId, runId].every((id) => safeId.test(id)))
    return fallback("invalid-log-identity");
  const expectedRef = `${companyId}/${agentId}/${runId}.ndjson`;
  if (run.log_ref !== expectedRef) return fallback("log-identity-mismatch");
  const expectedBytes = typeof run.log_bytes === "string" ? Number(run.log_bytes) : run.log_bytes;
  if (count2(expectedBytes) === null || expectedBytes > MAX_CONTEXT_LOG_BYTES || typeof run.log_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(run.log_sha256))
    return fallback("missing-or-oversized-log-integrity");
  try {
    const root = await realpath(logRoot);
    const path = await realpath(join(root, expectedRef));
    const within = relative(root, path);
    if (!within || isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`))
      return fallback("log-outside-root");
    if (path !== join(root, expectedRef)) return fallback("log-noncanonical-path");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== expectedBytes) return fallback("log-integrity-mismatch");
      const buffer = Buffer.alloc(expectedBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = await file.read(buffer, length, buffer.length - length, null);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      const bytes = buffer.subarray(0, length);
      if (length !== expectedBytes || createHash("sha256").update(bytes).digest("hex") !== run.log_sha256)
        return fallback("log-integrity-mismatch");
      const peak = peakFromRunLog(bytes.toString("utf8"));
      return peak === null ? fallback("missing-or-invalid-request-usage") : {
        lastRunPeakTokens: peak,
        history: "run-found",
        runId,
        evidence: "local-file/claude-assistant-usage"
      };
    } finally {
      await file.close();
    }
  } catch {
    return fallback("log-unreadable");
  }
}

// src/config/resolve.ts
import { isAbsolute as isAbsolute2 } from "node:path";

// src/config/secret-ref.ts
var ALLOWED_KEYS = /* @__PURE__ */ new Set([
  "type",
  "secretId",
  "version",
  "projectionClass",
  "projectionAllowlistKey"
]);
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validateSecretRefShape(value, path) {
  if (value === null || value === void 0) return null;
  if (typeof value === "string") {
    return `${path} must be a Paperclip secret reference object, not a string. A pasted credential is never stored \u2014 use the secret picker, which submits { type: "secret_ref", secretId }.`;
  }
  if (!isRecord(value)) {
    return `${path} must be an object of the form { type: "secret_ref", secretId } or null`;
  }
  if (value.type !== "secret_ref") {
    return `${path} is not a secret reference: it must be { type: "secret_ref", secretId, version? }. An object holding a credential value would be stored in this company's config in clear.`;
  }
  if (typeof value.secretId !== "string" || !UUID.test(value.secretId)) {
    return `${path}.secretId must be the UUID of a Paperclip secret`;
  }
  if (value.projectionClass !== void 0 && value.projectionClass !== "unclassified" && value.projectionClass !== "class_3_static_lease") {
    return `${path}.projectionClass must be "unclassified" or "class_3_static_lease"`;
  }
  if (value.version !== void 0 && value.version !== "latest" && !(typeof value.version === "number" && Number.isInteger(value.version) && value.version > 0)) {
    return `${path}.version must be "latest" or a positive integer`;
  }
  const extra = Object.keys(value).filter((key) => !ALLOWED_KEYS.has(key));
  if (extra.length > 0) {
    return `${path} carries unexpected field(s): ${extra.sort().join(", ")}. A secret reference holds no value, only a pointer.`;
  }
  return null;
}

// src/config/resolve.ts
function record2(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function num(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function bool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}
function string(value, fallback) {
  return typeof value === "string" ? value : fallback;
}
function fieldList(value, fallback) {
  const fields = Array.isArray(value) ? value.filter((field) => typeof field === "string" && field.length > 0) : [];
  return fields.length > 0 ? fields : [...fallback];
}
function nullableNum(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function nullableRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function secretRef(value) {
  return value === void 0 ? null : value;
}
function tier(value, fallback) {
  return typeof value === "string" && TIERS.includes(value) ? value : fallback;
}
function resolveConfig(raw) {
  const root = record2(raw);
  const selection = record2(root.selection);
  const profiles = record2(root.profiles);
  const quality = record2(root.quality);
  const pacing = record2(root.pacing);
  const classification = record2(root.classification);
  const earnIn = record2(root.earnIn);
  const shadowEmit = record2(root.shadowEmit);
  const accountAdmissionShadow = record2(root.accountAdmissionShadow);
  const aaSync = record2(root.aaSync);
  const aaFreeSync = record2(root.aaFreeSync);
  const acceptedWork = record2(root.acceptedWork);
  const priceSync = record2(root.priceSync);
  const dispatch = record2(root.dispatch);
  const wakeScopedFloor = record2(root.wakeScopedFloor);
  const runResolve = record2(root.runResolve);
  const models = Array.isArray(root.models) ? root.models.flatMap((entry) => {
    const model = record2(entry);
    if (typeof model.id !== "string" || model.id.length === 0) return [];
    return [
      {
        id: model.id,
        tier: tier(model.tier, "T3"),
        enabled: bool(model.enabled, true),
        costPerMTokIn: num(model.costPerMTokIn, 0),
        costPerMTokOut: num(model.costPerMTokOut, 0),
        costPerMTokCacheRead: num(model.costPerMTokCacheRead, 0),
        capabilities: Array.isArray(model.capabilities) ? model.capabilities.filter((c) => typeof c === "string") : [],
        contextWindow: num(model.contextWindow, 2e5),
        aaIndex: nullableNum(model.aaIndex),
        aaSlug: typeof model.aaSlug === "string" && model.aaSlug.length > 0 ? model.aaSlug : null,
        aaIndexUpdatedAt: typeof model.aaIndexUpdatedAt === "string" ? model.aaIndexUpdatedAt : null,
        releasedAt: string(model.releasedAt, "1970-01-01"),
        fallbackOnly: bool(model.fallbackOnly, false),
        note: string(model.note, ""),
        earnIn: nullableRecord(model.earnIn),
        laneId: typeof model.laneId === "string" && model.laneId.length > 0 ? model.laneId : null,
        effort: typeof model.effort === "string" && model.effort.length > 0 ? model.effort : null
      }
    ];
  }) : [];
  const rawLabelIds = record2(root.tierLabelIds);
  const tierLabelIds = {};
  for (const t of TIERS) {
    const id = rawLabelIds[t];
    if (typeof id === "string" && id.length > 0) tierLabelIds[t] = id;
  }
  const operatorLabelId = typeof root.operatorLabelId === "string" && root.operatorLabelId.length > 0 ? root.operatorLabelId : null;
  const lanes = Array.isArray(pacing.lanes) ? pacing.lanes.flatMap((entry) => {
    const rawLane = record2(entry);
    if (typeof rawLane.laneId !== "string" || rawLane.laneId.length === 0) return [];
    if (typeof rawLane.statusUrl !== "string" || rawLane.statusUrl.length === 0) return [];
    const windows = Array.isArray(rawLane.windows) ? rawLane.windows.flatMap((w) => {
      const window = record2(w);
      if (typeof window.name !== "string" || window.name.length === 0) return [];
      if (window.role !== "serviceability" && window.role !== "allowance") return [];
      const utilizationFields = Array.isArray(window.utilizationFields) ? window.utilizationFields.filter((f) => typeof f === "string") : [];
      if (utilizationFields.length === 0) return [];
      return [
        {
          name: window.name,
          role: window.role,
          utilizationFields,
          resetFields: Array.isArray(window.resetFields) ? window.resetFields.filter((f) => typeof f === "string") : [],
          defaultWindowSeconds: typeof window.defaultWindowSeconds === "number" ? window.defaultWindowSeconds : null
        }
      ];
    }) : [];
    if (windows.length === 0) return [];
    return [
      {
        laneId: rawLane.laneId,
        statusUrl: rawLane.statusUrl,
        requestTimeoutMs: num(rawLane.requestTimeoutMs, 5e3),
        maxResponseBytes: num(rawLane.maxResponseBytes, 262144),
        apiKeySecretRef: secretRef(rawLane.apiKeySecretRef),
        lane: {
          laneId: rawLane.laneId,
          free: bool(rawLane.free, false),
          healthFields: fieldList(rawLane.healthFields, ["health", "status"]),
          accountKeyFields: fieldList(rawLane.accountKeyFields, DEFAULT_PACE_ACCOUNT_KEY_FIELDS),
          weightFields: fieldList(rawLane.weightFields, DEFAULT_PACE_WEIGHT_FIELDS),
          governingWindowField: typeof rawLane.governingWindowField === "string" ? rawLane.governingWindowField : "governing_window",
          windowSecondsField: typeof rawLane.windowSecondsField === "string" ? rawLane.windowSecondsField : "window_seconds",
          staleAfterSecondsField: typeof rawLane.staleAfterSecondsField === "string" ? rawLane.staleAfterSecondsField : "staleAfterSeconds",
          windows
        },
        policy: {
          ...typeof rawLane.margin === "number" ? { margin: rawLane.margin } : {},
          ...typeof rawLane.urgentResetSeconds === "number" ? { urgentResetSeconds: rawLane.urgentResetSeconds } : {},
          ...typeof rawLane.maxSnapshotAgeSeconds === "number" ? { maxSnapshotAgeSeconds: rawLane.maxSnapshotAgeSeconds } : {}
        }
      }
    ];
  }) : [];
  return {
    selection: {
      enabled: bool(selection.enabled, true),
      mode: selection.mode === "enforce" ? "enforce" : "advise",
      defaultTier: tier(selection.defaultTier, "T1"),
      stickyModelWithinIssue: bool(selection.stickyModelWithinIssue, true),
      holdOnUntrustedProfile: bool(selection.holdOnUntrustedProfile, true),
      holdOnUnknownAvailability: bool(selection.holdOnUnknownAvailability, false),
      objective: selection.objective === "cost-per-accepted-card" ? "cost-per-accepted-card" : "list-price",
      fleetContextCeilingTokens: num(selection.fleetContextCeilingTokens, 1e6),
      contextRunLogRoot: typeof selection.contextRunLogRoot === "string" && selection.contextRunLogRoot.trim() ? selection.contextRunLogRoot.trim() : null,
      // TOG-11642: unset resolves to the fleet ceiling, so behaviour is
      // unchanged until the operator sets it (1M to release Muse's window).
      agentEnvContextTokens: num(
        selection.agentEnvContextTokens,
        num(selection.fleetContextCeilingTokens, 1e6)
      ),
      compactionRatio: num(selection.compactionRatio, 0.75)
    },
    models,
    tierLabelIds,
    operatorLabelId,
    profiles: {
      windowDays: num(profiles.windowDays, 7),
      minSamples: num(profiles.minSamples, 5),
      maxAgeDays: num(profiles.maxAgeDays, 14)
    },
    quality: {
      t1EscalationCeiling: num(quality.t1EscalationCeiling, 0.05),
      t2EscalationCeiling: num(quality.t2EscalationCeiling, 0.15),
      silentFailureWeight: num(quality.silentFailureWeight, 10)
    },
    pacing: {
      mode: PACING_MODES.includes(pacing.mode) ? pacing.mode : "shadow",
      lanes,
      slotFloorFraction: num(pacing.slotFloorFraction, DEFAULT_SLOT_FLOOR_FRACTION),
      operatorOverrideTtlSeconds: num(pacing.operatorOverrideTtlSeconds, DEFAULT_OPERATOR_OVERRIDE_TTL_SECONDS),
      idleRepinHysteresisSeconds: num(pacing.idleRepinHysteresisSeconds, DEFAULT_IDLE_REPIN_HYSTERESIS_SECONDS),
      avoid: (() => {
        const avoid = record2(pacing.avoid);
        const rawPerLane = record2(avoid.perLane);
        const keys = Object.keys(rawPerLane);
        if (keys.length === 0) {
          return { defaultThreshold: num(avoid.defaultThreshold, 0.8), perLane: { ...DEFAULT_AVOID_PER_LANE } };
        }
        const perLane = {};
        for (const [laneId, threshold] of Object.entries(rawPerLane)) {
          if (typeof threshold === "number" && Number.isFinite(threshold)) perLane[laneId] = threshold;
        }
        return { defaultThreshold: num(avoid.defaultThreshold, 0.8), perLane };
      })(),
      laneCapPerAccount: (() => {
        const raw2 = record2(pacing.laneCapPerAccount);
        const keys = Object.keys(raw2);
        if (keys.length === 0) return { ...DEFAULT_LANE_CAP_PER_ACCOUNT };
        const perAccount = {};
        for (const [laneId, cap] of Object.entries(raw2)) {
          if (typeof cap === "number" && Number.isFinite(cap)) perAccount[laneId] = cap;
        }
        return perAccount;
      })(),
      fiveHourWindowName: string(pacing.fiveHourWindowName, DEFAULT_FIVE_HOUR_WINDOW_NAME),
      weeklyWindowName: string(pacing.weeklyWindowName, DEFAULT_WEEKLY_WINDOW_NAME),
      codexLaneId: string(pacing.codexLaneId, LANE_ID_CODEX),
      opencodeGoLaneId: string(pacing.opencodeGoLaneId, LANE_ID_OPENCODE_GO),
      zai: (() => {
        const zai = record2(pacing.zai);
        return {
          laneId: string(zai.laneId, LANE_ID_ZAI),
          weeklyWindowName: string(zai.weeklyWindowName, DEFAULT_ZAI_WEEKLY_WINDOW_NAME),
          weeklyDefaultMargin: num(zai.weeklyDefaultMargin, DEFAULT_ZAI_WEEKLY_MARGIN)
        };
      })()
    },
    classification: {
      enabled: bool(classification.enabled, false),
      baseUrl: typeof classification.baseUrl === "string" && classification.baseUrl.length > 0 ? classification.baseUrl : null,
      protocol: classification.protocol === "openai-chat-completions" ? "openai-chat-completions" : "anthropic-messages",
      modelId: typeof classification.modelId === "string" && classification.modelId.length > 0 ? classification.modelId : null,
      apiKeySecretRef: secretRef(classification.apiKeySecretRef),
      requestTimeoutMs: num(classification.requestTimeoutMs, 15e3),
      maxResponseBytes: num(classification.maxResponseBytes, 65536),
      descriptionChars: num(classification.descriptionChars, 1500),
      maxOutputTokens: num(classification.maxOutputTokens, 120),
      t3ConfidenceFloor: num(classification.t3ConfidenceFloor, 0.7),
      t2ConfidenceFloor: num(classification.t2ConfidenceFloor, 0.6),
      batchSize: num(classification.batchSize, 20),
      reclassifyForeignLabels: bool(classification.reclassifyForeignLabels, true)
    },
    earnIn: {
      enabled: bool(earnIn.enabled, false),
      perModelPerWeek: num(earnIn.perModelPerWeek, 8),
      maxActivePerModel: num(earnIn.maxActivePerModel, 1),
      maxActivePerLane: num(earnIn.maxActivePerLane, 1),
      classes: Array.isArray(earnIn.classes) ? earnIn.classes.filter((c) => typeof c === "string") : ["research", "review"],
      stopOnFirstNFailures: num(earnIn.stopOnFirstNFailures, 2),
      stopWindow: num(earnIn.stopWindow, 8)
    },
    accountAdmissionShadow: { enabled: bool(accountAdmissionShadow.enabled, false) },
    shadowEmit: {
      enabled: bool(shadowEmit.enabled, false),
      maxRecords: num(shadowEmit.maxRecords, 5e3),
      shardMaxRecords: Math.max(2, Math.floor(num(shadowEmit.shardMaxRecords, 200))),
      retentionShards: Math.max(1, Math.floor(num(shadowEmit.retentionShards, 48)))
    },
    aaSync: {
      enabled: bool(aaSync.enabled, true)
    },
    aaFreeSync: {
      enabled: bool(aaFreeSync.enabled, false),
      apiKeySecretRef: secretRef(aaFreeSync.apiKeySecretRef),
      bindings: Array.isArray(aaFreeSync.bindings) ? aaFreeSync.bindings.flatMap((entry) => {
        const b = record2(entry);
        if (typeof b.candidateId !== "string" || b.candidateId.length === 0 || typeof b.modelId !== "string" || b.modelId.length === 0 || typeof b.laneId !== "string" || b.laneId.length === 0 || typeof b.evaluatedEffort !== "string" || b.evaluatedEffort.length === 0 || typeof b.aaSlug !== "string" || b.aaSlug.length === 0) return [];
        return [{
          candidateId: b.candidateId,
          modelId: b.modelId,
          laneId: b.laneId,
          evaluatedEffort: b.evaluatedEffort,
          aaSlug: b.aaSlug,
          ...typeof b.observationalOnly === "boolean" ? { observationalOnly: b.observationalOnly } : {}
        }];
      }) : [],
      maxSnapshotAgeHours: num(aaFreeSync.maxSnapshotAgeHours, 49)
    },
    acceptedWork: {
      enabled: bool(acceptedWork.enabled, false)
    },
    priceSync: {
      enabled: bool(priceSync.enabled, true)
    },
    dispatch: {
      wakeEnabled: bool(dispatch.wakeEnabled, false),
      idleMinutes: num(dispatch.idleMinutes, 120),
      maxWakesPerFiring: num(dispatch.maxWakesPerFiring, 3),
      focusProjectIds: Array.isArray(dispatch.focusProjectIds) ? dispatch.focusProjectIds.filter((p) => typeof p === "string") : []
    },
    wakeScopedFloor: {
      enabled: bool(wakeScopedFloor.enabled, true),
      wakeReasons: Array.isArray(wakeScopedFloor.wakeReasons) ? wakeScopedFloor.wakeReasons.filter((r) => typeof r === "string" && r.length > 0) : [],
      floorTier: tier(wakeScopedFloor.floorTier, "T3")
    },
    runResolve: {
      enabled: bool(runResolve.enabled, false),
      snapshotTtlMs: Math.min(Math.max(num(runResolve.snapshotTtlMs, 45e3), 5e3), 3e5),
      classifierWaitMs: Math.min(Math.max(num(runResolve.classifierWaitMs, 1e3), 0), 1e3),
      deferRetryMs: Math.min(Math.max(num(runResolve.deferRetryMs, 5e3), 1e3), 6e4)
    }
  };
}
function validateConfig(config) {
  const errors = [];
  const warnings = [];
  const seen = /* @__PURE__ */ new Set();
  for (const model of config.models) {
    if (model.id.startsWith("cliproxy/")) {
      errors.push(`model id must use the direct CLIProxy namespace without an OmniRoute cliproxy/ wrapper: ${model.id}`);
    }
    const rosterKey = `${model.id}::${model.tier}`;
    if (seen.has(rosterKey)) errors.push(`duplicate model+tier row: ${model.id} ${model.tier}`);
    seen.add(rosterKey);
    if (!Number.isFinite(Date.parse(`${model.releasedAt}T00:00:00.000Z`))) {
      errors.push(`invalid releasedAt date: ${model.id} ${model.tier} ${model.releasedAt}`);
    }
    if (model.costPerMTokCacheRead === 0 && model.costPerMTokIn > 0) {
      warnings.push(
        `${model.id} has costPerMTokCacheRead 0 \u2014 cache read is the largest cost line; a zero rate hides it`
      );
    }
  }
  if (!Number.isFinite(config.selection.compactionRatio) || config.selection.compactionRatio <= 0 || config.selection.compactionRatio >= 1) {
    errors.push("selection.compactionRatio must be greater than 0 and less than 1");
  }
  if (!Number.isFinite(config.selection.fleetContextCeilingTokens) || config.selection.fleetContextCeilingTokens < 1) {
    errors.push("selection.fleetContextCeilingTokens must be a positive number");
  }
  if (!Number.isFinite(config.selection.agentEnvContextTokens) || config.selection.agentEnvContextTokens < 1) {
    errors.push("selection.agentEnvContextTokens must be a positive number");
  }
  if (config.selection.contextRunLogRoot && !isAbsolute2(config.selection.contextRunLogRoot)) {
    errors.push("selection.contextRunLogRoot must be an absolute path");
  }
  if (config.selection.enabled && config.models.length === 0) {
    warnings.push("selection is enabled but no models are configured; every decision will be no-eligible-model");
  }
  const emptyTiers = TIERS.filter(
    (t) => !config.models.some((model) => model.enabled && model.tier === t)
  );
  if (config.selection.enabled && config.selection.mode === "enforce") {
    for (const t of emptyTiers) {
      errors.push(
        `selection.mode is enforce but tier ${t} has no enabled models; enforce cannot pin onto an unserved tier`
      );
    }
  } else {
    for (const t of emptyTiers) {
      warnings.push(`no enabled model at tier ${t}`);
    }
  }
  if (config.selection.mode === "enforce" && Object.keys(config.tierLabelIds).length === 0) {
    warnings.push(
      "no tierLabelIds configured; overrides will be written without a tier:* label, because the plugin cannot resolve a label id from its name"
    );
  }
  if (config.selection.mode === "enforce") {
    warnings.push(
      "mode is enforce: this plugin will write assigneeAdapterOverrides. Confirm Stage 2 is stable before running this alongside another live selection change."
    );
  }
  const laneIds = /* @__PURE__ */ new Set();
  for (const lane of config.pacing.lanes) {
    if (laneIds.has(lane.laneId)) errors.push(`duplicate lane id: ${lane.laneId}`);
    laneIds.add(lane.laneId);
    const secretError = validateSecretRefShape(lane.apiKeySecretRef, `pacing.lanes.${lane.laneId}.apiKeySecretRef`);
    if (secretError) errors.push(secretError);
  }
  if (config.pacing.mode !== "off" && config.pacing.lanes.length === 0) {
    warnings.push(`pacing.mode is ${config.pacing.mode} but no lanes are configured; pace ordering has nothing to key on`);
  }
  if (config.pacing.mode === "enforce" && config.pacing.slotFloorFraction <= 0) {
    errors.push("pacing.slotFloorFraction must stay above 0 while lanes are serviceable \u2014 ahead-of-line throttling must never reach zero");
  }
  if (config.classification.enabled) {
    if (!config.classification.baseUrl) {
      errors.push("classification.enabled is true but no classification.baseUrl is configured");
    }
    if (!config.classification.modelId) {
      errors.push("classification.enabled is true but no classification.modelId is configured");
    }
    const secretError = validateSecretRefShape(
      config.classification.apiKeySecretRef,
      "classification.apiKeySecretRef"
    );
    if (secretError) errors.push(secretError);
  }
  if (config.selection.objective === "cost-per-accepted-card") {
    warnings.push(
      "selection.objective is cost-per-accepted-card: candidate ordering now depends on the card ledger, not just list price. Confirm the 7-day shadow diff agreed before this was switched."
    );
  }
  if (config.earnIn.enabled) {
    warnings.push(
      "earnIn.enabled is true: unproven T1 candidates may be dispatched bounded research/review work. Confirm lane and pace posture gates are live before relying on this."
    );
  }
  if (config.aaFreeSync.enabled) {
    const secretError = validateSecretRefShape(config.aaFreeSync.apiKeySecretRef, "aaFreeSync.apiKeySecretRef");
    if (secretError) errors.push(secretError);
    if (!config.aaFreeSync.apiKeySecretRef) {
      errors.push("aaFreeSync.enabled is true but no aaFreeSync.apiKeySecretRef is configured; the free list cannot be fetched");
    }
    if (config.aaFreeSync.bindings.length === 0) {
      warnings.push(
        "aaFreeSync.enabled is true but no aaFreeSync.bindings are curated; the job fetches the snapshot but every diff will report unbound-only"
      );
    }
    const seen2 = /* @__PURE__ */ new Set();
    for (const b of config.aaFreeSync.bindings) {
      const key = `${b.modelId} ${b.laneId} ${b.evaluatedEffort}`;
      if (seen2.has(key)) errors.push(`duplicate aaFreeSync binding: ${key}`);
      seen2.add(key);
    }
    if (!Number.isFinite(config.aaFreeSync.maxSnapshotAgeHours) || config.aaFreeSync.maxSnapshotAgeHours < 1) {
      errors.push("aaFreeSync.maxSnapshotAgeHours must be a positive number of hours");
    }
  }
  if (config.wakeScopedFloor.enabled && config.wakeScopedFloor.wakeReasons.length === 0) {
    warnings.push(
      "wakeScopedFloor.enabled is true but wakeReasons is empty; no decision will ever qualify until an operator names the actual PAPERCLIP_WAKE_REASON values for cheap wakes (e.g. monitor ticks)"
    );
  }
  if (config.wakeScopedFloor.enabled && config.wakeScopedFloor.wakeReasons.length > 0) {
    const floorIndex = TIER_ORDER.indexOf(config.wakeScopedFloor.floorTier);
    const defaultIndex = TIER_ORDER.indexOf(config.selection.defaultTier);
    if (floorIndex >= defaultIndex) {
      warnings.push(
        `wakeScopedFloor.floorTier (${config.wakeScopedFloor.floorTier}) is not below selection.defaultTier (${config.selection.defaultTier}); a wake-scoped decision will only ever lower the floor for a card judged above that`
      );
    }
  }
  if (config.pacing.mode !== "off") {
    const referencedLaneIds = /* @__PURE__ */ new Set();
    for (const model of config.models) {
      if (model.laneId) referencedLaneIds.add(model.laneId);
    }
    for (const laneId of referencedLaneIds) {
      if (!laneIds.has(laneId)) {
        errors.push(
          `model roster references laneId "${laneId}", which is not in pacing.lanes \u2014 pace routing for that model would silently never activate`
        );
      }
    }
  }
  return { errors, warnings };
}

// src/engine/benchmark-prior.ts
var BENCHMARK_SPEC_VERSION = "tog2636-v1";
var BENCHMARKS = [
  { key: "terminalBenchV4Pass1", anchor: 0.6, weight: 0.25 },
  { key: "mercorApex11Pass1", anchor: 0.7, weight: 0.2 },
  { key: "automationBenchAaGuardrailAdjusted", anchor: 0.7, weight: 0.2 },
  { key: "aaOmniscienceSignedIndex", anchor: 45, weight: 0.2 },
  { key: "deepSweV11Pass1", anchor: 0.75, weight: 0.15 }
];
var MIN_POPULATED_BENCHMARKS = 3;
var MIN_AVAILABLE_WEIGHT = 0.75;
var BENCHMARK_BLEND = 0.3;
function clip(value, lo = 0, hi = 1) {
  return Math.max(lo, Math.min(hi, value));
}
function benchmarkPrior(row) {
  if (!row) return null;
  let weighted = 0;
  let availableWeight = 0;
  let populated = 0;
  for (const { key, anchor, weight } of BENCHMARKS) {
    const raw = row[key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    weighted += weight * clip(raw / anchor);
    availableWeight += weight;
    populated += 1;
  }
  if (populated < MIN_POPULATED_BENCHMARKS) return null;
  if (availableWeight < MIN_AVAILABLE_WEIGHT) return null;
  return weighted / availableWeight;
}
function indexPriorOrNull(aaIndex) {
  if (typeof aaIndex !== "number" || !Number.isFinite(aaIndex)) return null;
  return clip(0.55 + 0.45 * (aaIndex / 60), 0.55, 1);
}
function blendedPrior(aaIndex, row) {
  const index = indexPriorOrNull(aaIndex);
  if (index === null) return { value: null, basis: "unscored" };
  const basket = benchmarkPrior(row);
  if (basket === null) return { value: index, basis: "index-only" };
  return {
    value: (1 - BENCHMARK_BLEND) * index + BENCHMARK_BLEND * (0.55 + 0.45 * basket),
    basis: "blended"
  };
}

// src/engine/cost.ts
var MIN_PROFILE_SAMPLES = 5;
var PROFILE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1e3;
function tierIndex(tier2) {
  return TIER_ORDER.indexOf(tier2);
}
function tierAbove(tier2) {
  return TIER_ORDER[tierIndex(tier2) + 1] ?? null;
}
function resolveProfile(tier2, profiles, now) {
  const profile = profiles.find((entry) => entry.tier === tier2) ?? null;
  if (!profile) {
    return { profile: null, trusted: false, reason: `no volume profile recorded for ${tier2}` };
  }
  if (profile.sampleCount < MIN_PROFILE_SAMPLES) {
    return {
      profile,
      trusted: false,
      reason: `${tier2} profile has ${profile.sampleCount} runs, below the ${MIN_PROFILE_SAMPLES}-run minimum`
    };
  }
  const age = now - Date.parse(profile.computedAt);
  if (!Number.isFinite(age)) {
    return { profile, trusted: false, reason: `${tier2} profile has an unparseable computedAt` };
  }
  if (age > PROFILE_MAX_AGE_MS) {
    const days = Math.round(age / (24 * 60 * 60 * 1e3));
    return { profile, trusted: false, reason: `${tier2} profile is ${days} days old` };
  }
  return { profile, trusted: true, reason: `${tier2} profile: ${profile.sampleCount} runs` };
}
function runCost(model, profile) {
  const inputCostUsd = profile.avgInputTokens / 1e6 * model.costPerMTokIn;
  const cacheReadCostUsd = profile.avgCacheReadTokens / 1e6 * model.costPerMTokCacheRead;
  const outputCostUsd = profile.avgOutputTokens / 1e6 * model.costPerMTokOut;
  return {
    inputCostUsd,
    cacheReadCostUsd,
    outputCostUsd,
    runCostUsd: inputCostUsd + cacheReadCostUsd + outputCostUsd
  };
}
function escalationRisk(tier2, models, profiles, signals, now) {
  const above = tierAbove(tier2);
  if (!above) return 0;
  const signal = signals.find((entry) => entry.tier === tier2);
  if (!signal || signal.sampleCount <= 0) return 0;
  const silentRate = signal.silentFailureCount * 10 / signal.sampleCount;
  const effectiveRate = Math.min(1, Math.max(0, signal.escalationRate) + silentRate);
  if (effectiveRate <= 0) return 0;
  const verdict = resolveProfile(above, profiles, now);
  if (!verdict.profile) return 0;
  const redo = models.filter((model) => model.enabled && !model.fallbackOnly && model.tier === above).map((model) => runCost(model, verdict.profile).runCostUsd).sort((left, right) => left - right)[0];
  return redo === void 0 ? 0 : redo * effectiveRate;
}
function costOf(model, profileTier, profiles, models, signals, now) {
  const verdict = resolveProfile(profileTier, profiles, now);
  if (!verdict.profile) return null;
  const direct = runCost(model, verdict.profile);
  const escalationRiskUsd = escalationRisk(model.tier, models, profiles, signals, now);
  return {
    modelId: model.id,
    ...direct,
    escalationRiskUsd,
    expectedCostUsd: direct.runCostUsd + escalationRiskUsd,
    profileTier,
    profileTrusted: verdict.trusted
  };
}

// src/aa-free/parse.ts
var AA_FREE_EVALUATION_KEYS = [
  "artificial_analysis_intelligence_index",
  "artificial_analysis_coding_index",
  "artificial_analysis_math_index",
  "mmlu_pro",
  "gpqa",
  "hle",
  "livecodebench",
  "scicode",
  "math_500",
  "aime",
  "aime_25",
  "ifbench",
  "lcr",
  "terminalbench_hard",
  "terminalbench_v2_1",
  "terminalbench_v4_0",
  "tau2",
  "tau_banking"
];
var AA_FREE_SOURCE = "artificialanalysis.ai/api/v2/data/llms/models";
var AA_FREE_PROFILE = "aa-free-v1";
function num2(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v) {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function obj(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
function buildRow(raw) {
  const r = obj(raw);
  const slug = str(r.slug);
  if (slug === null) return null;
  const id = typeof r.id === "string" ? r.id : slug;
  const pricing = obj(r.pricing);
  const ev = obj(r.evaluations);
  const evaluations = {};
  for (const key of AA_FREE_EVALUATION_KEYS) evaluations[key] = num2(ev[key]);
  return Object.freeze({
    id,
    slug,
    name: str(r.name),
    releaseDate: str(r.release_date),
    creatorName: str(obj(r.model_creator).name),
    aaIndex: evaluations.artificial_analysis_intelligence_index,
    free: Object.freeze({
      priceInput1m: num2(pricing.price_1m_input_tokens),
      priceOutput1m: num2(pricing.price_1m_output_tokens),
      priceBlended3to1: num2(pricing.price_1m_blended_3_to_1),
      medianOutputTokensPerSecond: num2(r.median_output_tokens_per_second),
      medianTimeToFirstTokenSeconds: num2(r.median_time_to_first_token_seconds),
      medianTimeToFirstAnswerTokenSeconds: num2(r.median_time_to_first_answer_token),
      evaluations: Object.freeze(evaluations)
    }),
    optionalRich: Object.freeze({})
  });
}
function parseAaFreeList(text2, retrievedAt) {
  let body;
  try {
    body = JSON.parse(text2);
  } catch {
    return null;
  }
  const top = obj(body);
  if (!Array.isArray(top.data)) return null;
  const rows = [];
  const seen = /* @__PURE__ */ new Set();
  const dup = /* @__PURE__ */ new Set();
  for (const entry of top.data) {
    const row = buildRow(entry);
    if (!row) continue;
    if (seen.has(row.slug)) dup.add(row.slug);
    seen.add(row.slug);
    rows.push(row);
  }
  if (rows.length === 0) return null;
  const opts = obj(top.prompt_options);
  return Object.freeze({
    profile: AA_FREE_PROFILE,
    source: AA_FREE_SOURCE,
    sourceVersion: "unknown",
    retrievedAt,
    workload: { parallelQueries: num2(opts.parallel_queries), promptLength: num2(opts.prompt_length) },
    rows: Object.freeze(rows),
    duplicateSlugs: Object.freeze([...dup].sort())
  });
}

// src/engine/tier-policy.ts
var TIER_POLICY_SCHEMA_VERSION = 2;
var LEGACY_EVALUATOR_ID = "legacy-model-selection-v1";
var EVIDENCE_V2_EVALUATOR_ID = "evidence-v2";
var CAPABILITY_PRIOR_BINDING = "existing-capability-prior-v1";
var LEGACY_CAPABILITY_PARAMS = Object.freeze({
  /** Pseudo-observations contributed by the prior (posterior weight). */
  priorK: SCORE_PRIOR_K,
  /** Judged runs before a (model, tier) verdict is "proven". */
  provenN: SCORE_PROVEN_N,
  /** A proven model is vetoed when its observed rate is this far under the bar. */
  vetoMargin: 0.1
});
var ALL_AA_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "default",
  "unknown"
];
var DECISION_BINDINGS = Object.freeze({
  "aa-free-v1/intelligence-index": {
    id: "aa-free-v1/intelligence-index",
    kind: "numeric-metric",
    metric: "artificial_analysis_intelligence_index",
    source: AA_FREE_SOURCE,
    publishedVersion: "unknown",
    unit: "index-points"
  },
  [CAPABILITY_PRIOR_BINDING]: {
    id: CAPABILITY_PRIOR_BINDING,
    kind: "capability-predicate",
    metric: null,
    source: null,
    publishedVersion: null,
    unit: null
  }
});
var UNVERSIONED = /* @__PURE__ */ new Set(["", "latest", "unknown"]);
var KNOWN_EFFORTS = new Set(ALL_AA_EFFORTS);
var LEGACY_TIER_IDS = TIER_ORDER;
function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}
function inUnitInterval(v) {
  return isFiniteNumber(v) && v > 0 && v <= 1;
}
function validateRule(rule, path, evaluator, issues) {
  const push = (code, message, at = path) => issues.push({ path: at, code, message });
  if (rule.optionalSourceRule) {
    const o = rule.optionalSourceRule;
    if (!o.source || !o.metric) push("optional-source-incomplete", "optionalSourceRule needs a source and a metric");
    if (typeof o.version !== "string" || UNVERSIONED.has(o.version)) {
      push("unversioned-metric", "optionalSourceRule must pin a metric version", `${path}.optionalSourceRule.version`);
    }
  }
  if (rule.kind === "capability-predicate") {
    if (rule.decisionBinding !== CAPABILITY_PRIOR_BINDING) {
      push("unknown-binding", `capability predicate must bind ${CAPABILITY_PRIOR_BINDING}`);
    }
    if (rule.policyRevision !== evaluator) {
      push("predicate-evaluator-mismatch", `capability predicate names ${rule.policyRevision}, policy runs ${evaluator}`);
    }
    return;
  }
  if (rule.kind !== "numeric-metric") {
    push("unknown-rule-kind", `unknown rule kind ${String(rule.kind)}`);
    return;
  }
  if (typeof rule.version !== "string" || UNVERSIONED.has(rule.version)) {
    push("unversioned-metric", "a numeric rule must pin a metric version (no unversioned comparisons)", `${path}.version`);
  }
  if (rule.operator === "between") {
    const v = rule.value;
    if (!Array.isArray(v) || v.length !== 2 || !v.every(isFiniteNumber) || v[0] > v[1]) {
      push("invalid-value", "between needs a finite [lo, hi] with lo <= hi", `${path}.value`);
    }
  } else if (rule.operator === "gte" || rule.operator === "lte") {
    if (!isFiniteNumber(rule.value)) push("invalid-value", "value must be a finite number", `${path}.value`);
  } else {
    push("unsupported-operator", `unsupported operator ${String(rule.operator)}`, `${path}.operator`);
  }
  if (rule.maxAgeHours !== void 0 && !(isFiniteNumber(rule.maxAgeHours) && rule.maxAgeHours > 0)) {
    push("invalid-ttl", "maxAgeHours must be a positive finite number", `${path}.maxAgeHours`);
  }
  if (rule.onMissing !== "reject" && rule.onMissing !== "legacy") {
    push("invalid-on-missing", "onMissing must be reject or legacy", `${path}.onMissing`);
  }
  const binding = DECISION_BINDINGS[rule.decisionBinding];
  if (!binding) {
    if (!rule.optionalSourceRule) push("unknown-metric", `no decision binding ${rule.decisionBinding} in ${AA_FREE_PROFILE}`);
    return;
  }
  if (binding.kind !== "numeric-metric") {
    push("binding-kind-mismatch", `${binding.id} is not a numeric metric`);
    return;
  }
  if (rule.metric !== binding.metric || rule.source !== binding.source) {
    push("unknown-metric", `${rule.source}/${rule.metric} is not what ${binding.id} binds`);
  }
  if (rule.unit !== binding.unit) push("unsupported-unit", `${binding.id} is measured in ${binding.unit}`, `${path}.unit`);
  if (evaluator === LEGACY_EVALUATOR_ID && !UNVERSIONED.has(binding.publishedVersion ?? "")) {
    push("legacy-numeric-unsupported", `${LEGACY_EVALUATOR_ID} cannot enforce ${binding.id}`);
  }
}
function validateTierPolicy(policy, options = {}) {
  const issues = [];
  const push = (path, code, message) => issues.push({ path, code, message });
  if (policy.schemaVersion !== TIER_POLICY_SCHEMA_VERSION) push("schemaVersion", "unsupported-schema", `schemaVersion must be ${TIER_POLICY_SCHEMA_VERSION}`);
  if (!Number.isInteger(policy.revision) || policy.revision < 1) push("revision", "invalid-revision", "revision must be a positive integer");
  if (policy.decisionProfile !== AA_FREE_PROFILE) push("decisionProfile", "unsupported-profile", `decisionProfile must be ${AA_FREE_PROFILE}`);
  if (policy.optionalRichDecisionWeight !== 0) push("optionalRichDecisionWeight", "optional-rich-weighted", "optional rich data has zero decision weight");
  if (policy.evaluator === EVIDENCE_V2_EVALUATOR_ID) {
    push("evaluator", "evaluator-unavailable", "evidence-v2 is opt-in and not available in this build");
  } else if (policy.evaluator !== LEGACY_EVALUATOR_ID) {
    push("evaluator", "unknown-evaluator", `unknown evaluator ${String(policy.evaluator)}`);
  }
  const tiers = Array.isArray(policy.tiers) ? policy.tiers : [];
  if (tiers.length === 0) push("tiers", "no-tiers", "a policy needs at least one tier");
  const ids = /* @__PURE__ */ new Set();
  const orders = /* @__PURE__ */ new Set();
  tiers.forEach((tier2, i) => {
    const at = `tiers[${i}]`;
    if (typeof tier2.id !== "string" || tier2.id.length === 0) push(`${at}.id`, "invalid-id", "tier id must be a non-empty string");
    if (ids.has(tier2.id)) push(`${at}.id`, "duplicate-id", `duplicate tier id ${tier2.id}`);
    ids.add(tier2.id);
    if (typeof tier2.name !== "string" || tier2.name.trim().length === 0) push(`${at}.name`, "invalid-name", "tier name must be non-empty");
    if (!Number.isInteger(tier2.order)) push(`${at}.order`, "invalid-order", "order must be an integer");
    if (orders.has(tier2.order)) push(`${at}.order`, "duplicate-order", `duplicate order ${tier2.order}`);
    orders.add(tier2.order);
    const rules = tier2.entryRules?.all ?? [];
    if (rules.length === 0) push(`${at}.entryRules`, "no-entry-rules", "a tier needs at least one entry rule");
    rules.forEach((rule, r) => validateRule(rule, `${at}.entryRules.all[${r}]`, policy.evaluator, issues));
    if (policy.evaluator === LEGACY_EVALUATOR_ID && !rules.some((r) => r.kind === "capability-predicate")) {
      push(`${at}.entryRules`, "missing-capability-predicate", `${LEGACY_EVALUATOR_ID} admits only through ${CAPABILITY_PRIOR_BINDING}`);
    }
    const efforts = tier2.allowedEfforts ?? [];
    if (efforts.length === 0) push(`${at}.allowedEfforts`, "no-efforts", "allowedEfforts must not be empty");
    if (new Set(efforts).size !== efforts.length) push(`${at}.allowedEfforts`, "duplicate-effort", "allowedEfforts has duplicates");
    for (const e of efforts) if (!KNOWN_EFFORTS.has(e)) push(`${at}.allowedEfforts`, "unknown-effort", `unknown effort ${String(e)}`);
    const ev = tier2.evidence;
    if (!ev || !["legacy", "prior-only", "posterior-required"].includes(ev.mode)) {
      push(`${at}.evidence.mode`, "invalid-evidence-mode", "unknown evidence mode");
    } else {
      if (!Number.isInteger(ev.minIndependentTasks) || ev.minIndependentTasks < 0) {
        push(`${at}.evidence.minIndependentTasks`, "invalid-sample-gate", "minIndependentTasks must be a non-negative integer");
      }
      if (ev.maxAgeDays !== void 0 && !(isFiniteNumber(ev.maxAgeDays) && ev.maxAgeDays > 0)) {
        push(`${at}.evidence.maxAgeDays`, "invalid-ttl", "maxAgeDays must be a positive finite number");
      }
      if (policy.evaluator === LEGACY_EVALUATOR_ID && (ev.mode !== "legacy" || ev.cohort !== "legacy-model-id")) {
        push(`${at}.evidence`, "evidence-evaluator-mismatch", `${LEGACY_EVALUATOR_ID} uses legacy evidence on the legacy-model-id cohort`);
      }
    }
    if (!inUnitInterval(tier2.legacy?.scoreThreshold)) push(`${at}.legacy.scoreThreshold`, "invalid-threshold", "scoreThreshold must be finite in (0, 1]");
    if (!inUnitInterval(tier2.legacy?.capabilityThreshold)) {
      push(`${at}.legacy.capabilityThreshold`, "invalid-threshold", "capabilityThreshold must be finite in (0, 1]");
    }
  });
  if (!ids.has(policy.defaultTierId)) push("defaultTierId", "unknown-tier-ref", `default tier ${policy.defaultTierId} does not exist`);
  for (const [taskClass, ref] of Object.entries(policy.taskClassTierRefs ?? {})) {
    if (!ids.has(ref)) push(`taskClassTierRefs.${taskClass}`, "unknown-tier-ref", `task class ${taskClass} names missing tier ${ref}`);
  }
  if (policy.evaluator === LEGACY_EVALUATOR_ID && tiers.length > 0) validateLegacyLadder(tiers, push);
  if (options.previous) validateSTierNotWeakened(options.previous, policy, push);
  return issues;
}
function validateLegacyLadder(tiers, push) {
  const ids = tiers.map((t) => t.id);
  const missing = LEGACY_TIER_IDS.filter((id) => !ids.includes(id));
  const extra = ids.filter((id) => !LEGACY_TIER_IDS.includes(id));
  if (missing.length > 0) push("tiers", "legacy-tier-missing", `${LEGACY_EVALUATOR_ID} needs tiers ${missing.join(", ")}`);
  if (extra.length > 0) push("tiers", "legacy-tier-unknown", `${LEGACY_EVALUATOR_ID} cannot evaluate tiers ${extra.join(", ")}`);
  if (missing.length > 0 || extra.length > 0) return;
  const ascending = [...tiers].sort((a, b) => a.order - b.order).map((t) => t.id);
  if (ascending.join(",") !== LEGACY_TIER_IDS.join(",")) {
    push("tiers", "invalid-tier-order", `order must ascend ${LEGACY_TIER_IDS.join(" < ")}; got ${ascending.join(" < ")}`);
    return;
  }
  const byId = new Map(tiers.map((t) => [t.id, t]));
  for (let i = 1; i < LEGACY_TIER_IDS.length; i++) {
    const lower = byId.get(LEGACY_TIER_IDS[i - 1]);
    const upper = byId.get(LEGACY_TIER_IDS[i]);
    if (!(upper.legacy?.scoreThreshold > lower.legacy?.scoreThreshold)) {
      push(`tiers.${upper.id}.legacy.scoreThreshold`, "overlapping-tiers", `${upper.id} cut must be above ${lower.id} cut`);
    }
    if (!(upper.legacy?.capabilityThreshold >= lower.legacy?.capabilityThreshold)) {
      push(`tiers.${upper.id}.legacy.capabilityThreshold`, "inverted-capability", `${upper.id} capability bar is below ${lower.id}`);
    }
  }
}
function validateSTierNotWeakened(previous, next, push) {
  for (const before of previous.tiers) {
    if (!before.sTier) continue;
    const after = next.tiers.find((t) => t.id === before.id);
    const at = `tiers.${before.id}`;
    if (!after) {
      push(at, "s-tier-weakened", `S-tier ${before.id} cannot be removed`);
      continue;
    }
    if (!after.sTier) push(`${at}.sTier`, "s-tier-weakened", `${before.id} cannot drop its S-tier flag`);
    if (before.fallbackOnly && !after.fallbackOnly) push(`${at}.fallbackOnly`, "s-tier-weakened", `${before.id} must stay fallbackOnly`);
    if (after.legacy.scoreThreshold < before.legacy.scoreThreshold || after.legacy.capabilityThreshold < before.legacy.capabilityThreshold) {
      push(`${at}.legacy`, "s-tier-weakened", `${before.id} thresholds cannot be lowered`);
    }
  }
}
var TierPolicyError = class extends Error {
  constructor(issues) {
    super(`invalid tier policy: ${issues.map((i) => `${i.path}: ${i.code}`).join("; ")}`);
    this.issues = issues;
    this.name = "TierPolicyError";
  }
};
function ruleEnforcement(rule) {
  if (rule.optionalSourceRule) return "not-enforced-in-aa-free-v1";
  if (rule.kind === "capability-predicate") return "enforced";
  if (!DECISION_BINDINGS[rule.decisionBinding]) return "not-enforced-in-aa-free-v1";
  return "not-enforced-version-unknown";
}
function compileTierPolicy(policy, options = {}) {
  const issues = validateTierPolicy(policy, options);
  if (issues.length > 0) throw new TierPolicyError(issues);
  const byId = new Map(policy.tiers.map((t) => [t.id, t]));
  const scoreThresholds = {};
  const capabilityThresholds = {};
  const tierNames = {};
  for (const id of LEGACY_TIER_IDS) {
    const tier2 = byId.get(id);
    scoreThresholds[id] = tier2.legacy.scoreThreshold;
    capabilityThresholds[id] = tier2.legacy.capabilityThreshold;
    tierNames[id] = tier2.name;
  }
  const rules = [];
  for (const tier2 of policy.tiers) {
    tier2.entryRules.all.forEach((rule, ruleIndex) => {
      const status = ruleEnforcement(rule);
      rules.push({ tierId: tier2.id, ruleIndex, status, replacement: status === "enforced" ? null : CAPABILITY_PRIOR_BINDING });
    });
  }
  return Object.freeze({
    revision: policy.revision,
    evaluator: LEGACY_EVALUATOR_ID,
    scoreThresholds: Object.freeze(scoreThresholds),
    capabilityThresholds: Object.freeze(capabilityThresholds),
    capability: LEGACY_CAPABILITY_PARAMS,
    defaultTierId: policy.defaultTierId,
    tierNames: Object.freeze(tierNames),
    rules: Object.freeze(rules)
  });
}
var T1_CAPABILITY_THRESHOLD = 0.8;
function legacyTier(id, name, order, capabilityThreshold) {
  return {
    id,
    name,
    order,
    entryRules: { all: [{ kind: "capability-predicate", decisionBinding: CAPABILITY_PRIOR_BINDING, policyRevision: LEGACY_EVALUATOR_ID }] },
    allowedEfforts: ALL_AA_EFFORTS,
    evidence: { mode: "legacy", minIndependentTasks: 0, cohort: "legacy-model-id" },
    fallbackOnly: false,
    sTier: false,
    legacy: { scoreThreshold: SCORE_THRESHOLDS[id], capabilityThreshold, sourceRevision: "3da20ab13+t1cap080" }
  };
}
var LEGACY_MODEL_SELECTION_V1 = Object.freeze({
  schemaVersion: TIER_POLICY_SCHEMA_VERSION,
  revision: 1,
  evaluator: LEGACY_EVALUATOR_ID,
  decisionProfile: AA_FREE_PROFILE,
  optionalRichDecisionWeight: 0,
  tiers: Object.freeze([
    legacyTier("T3", "T3", 0, SCORE_THRESHOLDS.T3),
    legacyTier("T2", "T2", 1, SCORE_THRESHOLDS.T2),
    legacyTier("T1", "T1", 2, T1_CAPABILITY_THRESHOLD)
  ]),
  defaultTierId: "T1",
  taskClassTierRefs: Object.freeze({}),
  legacyCompatibility: Object.freeze({
    sourceRevision: "3da20ab13",
    servingBuild: "model-selection-0.4.0-main5a9be61-t1cap080",
    servingWorkerSha256: "dde5fe180cc86856d2332a6ee56ff3ea62fedd349c91c1550de8bd8773b3c099",
    rosterSnapshotHash: null,
    baselineDecisionCorpusHash: null
  })
});
var LEGACY_TIER_POLICY = compileTierPolicy(LEGACY_MODEL_SELECTION_V1);

// src/engine/scores.ts
function priorP(aaIndex) {
  if (aaIndex === null) return 0.8;
  return Math.max(0.55, Math.min(1, 0.55 + 0.45 * (aaIndex / 60)));
}
function blendedPriorP(aaIndex, benchmarkRow) {
  const blended = blendedPrior(aaIndex, benchmarkRow);
  if (blended.value !== null) return blended.value;
  return priorP(aaIndex);
}
var TIER_ORDER_BY_CAPABILITY_DESC = [...TIER_ORDER].reverse();
function tierForPosterior(p, thresholds = LEGACY_TIER_POLICY.scoreThresholds) {
  for (const tier2 of TIER_ORDER_BY_CAPABILITY_DESC) {
    const threshold = thresholds[tier2];
    if (threshold !== void 0 && p >= threshold) return { tier: tier2, belowT3Floor: false };
  }
  return { tier: "T3", belowT3Floor: true };
}
function deriveModelTier(aaIndex, benchmarkRow, overallStats, priorK = SCORE_PRIOR_K, thresholds = LEGACY_TIER_POLICY.scoreThresholds) {
  const { value: prior, basis } = blendedPrior(aaIndex, benchmarkRow);
  if (prior === null) {
    return { tier: null, belowT3Floor: false, basis, prior: null, p: null, specVersion: BENCHMARK_SPEC_VERSION };
  }
  const nEff = overallStats.wOk + overallStats.wBad;
  const p = (overallStats.wOk + priorK * prior) / (nEff + priorK);
  const { tier: tier2, belowT3Floor } = tierForPosterior(p, thresholds);
  return { tier: tier2, belowT3Floor, basis, prior: round(prior, 4), p: round(p, 4), specVersion: BENCHMARK_SPEC_VERSION };
}
function emptyTierScoreStats() {
  return { n: 0, ok: 0, failInfra: 0, failModel: 0, tmo: 0, wOk: 0, wBad: 0, rework: 0, okCost: [], okMins: [] };
}
function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const lo = sorted[mid - 1];
    const hi = sorted[mid];
    return (lo + hi) / 2;
  }
  return sorted[mid];
}
function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
function summarize(stats, tier2, priorPValue, priorK = SCORE_PRIOR_K, provenN = SCORE_PROVEN_N, thresholds = LEGACY_TIER_POLICY.capabilityThresholds, vetoMargin = LEGACY_TIER_POLICY.capability.vetoMargin) {
  const nEff = stats.wOk + stats.wBad;
  const pObs = nEff > 0 ? stats.wOk / nEff : null;
  const p = (stats.wOk + priorK * priorPValue) / (nEff + priorK);
  const thr = tier2 === null ? void 0 : thresholds[tier2];
  const proven = stats.ok + stats.failModel + stats.tmo >= provenN;
  let capable = null;
  if (thr !== void 0) {
    capable = p >= thr;
    if (proven && pObs !== null && pObs < thr - vetoMargin) capable = false;
  }
  return {
    n: stats.n,
    ok: stats.ok,
    failInfra: stats.failInfra,
    failModel: round(stats.failModel, 1),
    tmo: stats.tmo,
    nEff: round(nEff, 1),
    pObs: pObs === null ? null : round(pObs, 3),
    p: round(p, 3),
    capable,
    proven,
    costPerSuccessUsd: stats.okCost.length ? round(median(stats.okCost), 3) : null,
    medMin: stats.okMins.length ? round(median(stats.okMins), 1) : null,
    rework: stats.rework
  };
}
function buildModelScore(modelId, aaIndex, statsByTier, tiers, benchmarkRow, policy = LEGACY_TIER_POLICY) {
  const pp = blendedPriorP(aaIndex, benchmarkRow);
  const { capabilityThresholds, scoreThresholds, capability } = policy;
  const tierScores = {};
  for (const tier2 of tiers) {
    const stats = statsByTier[tier2];
    tierScores[tier2] = stats ? summarize(stats, tier2, pp, capability.priorK, capability.provenN, capabilityThresholds, capability.vetoMargin) : {
      n: 0,
      ok: 0,
      failInfra: 0,
      failModel: 0,
      tmo: 0,
      nEff: 0,
      pObs: null,
      p: round(pp, 3),
      capable: pp >= capabilityThresholds[tier2],
      proven: false,
      costPerSuccessUsd: null,
      medMin: null,
      rework: 0
    };
  }
  const monotoneTierScores = enforceMonotoneCapability(tierScores);
  const agg = emptyTierScoreStats();
  for (const tier2 of tiers) {
    const stats = statsByTier[tier2];
    if (!stats) continue;
    agg.n += stats.n;
    agg.ok += stats.ok;
    agg.failInfra += stats.failInfra;
    agg.failModel += stats.failModel;
    agg.tmo += stats.tmo;
    agg.wOk += stats.wOk;
    agg.wBad += stats.wBad;
    agg.rework += stats.rework;
    agg.okCost.push(...stats.okCost);
    agg.okMins.push(...stats.okMins);
  }
  const derivedTier = deriveModelTier(aaIndex, benchmarkRow, agg, capability.priorK, scoreThresholds);
  return {
    modelId,
    aaIndex,
    priorP: round(pp, 3),
    tiers: monotoneTierScores,
    overall: summarize(agg, null, pp, capability.priorK, capability.provenN, capabilityThresholds, capability.vetoMargin),
    derivedTier: derivedTier.tier,
    belowT3Floor: derivedTier.belowT3Floor,
    priorBasis: derivedTier.basis,
    tierSpecVersion: derivedTier.specVersion
  };
}
function enforceMonotoneCapability(tiers) {
  const out = { ...tiers };
  let adverse = null;
  for (const tier2 of TIER_ORDER) {
    const score2 = tiers[tier2];
    if (!score2) continue;
    if (adverse !== null && !score2.proven && score2.capable !== false) {
      out[tier2] = { ...score2, capable: false, cappedBy: adverse };
      continue;
    }
    if (score2.capable === false && score2.cappedBy === void 0) adverse = tier2;
  }
  return out;
}
function tierScoreFor(score2, tier2) {
  if (!score2?.tiers) return void 0;
  return enforceMonotoneCapability(score2.tiers)[tier2];
}
function promotionCeiling(score2) {
  if (!score2.tiers) return void 0;
  const tiers = enforceMonotoneCapability(score2.tiers);
  let ceiling;
  for (const tier2 of TIER_ORDER) {
    const verdict = tiers[tier2];
    if (verdict && verdict.capable !== false) ceiling = tier2;
  }
  return ceiling;
}
function applyDerivedTiers(models, scoresByModelId, specVersion = BENCHMARK_SPEC_VERSION) {
  const topRung = topConfiguredRungs(models);
  return models.map((model) => {
    const score2 = scoresByModelId[model.id];
    if (!score2 || !score2.derivedTier) return model;
    if (score2.tierSpecVersion !== specVersion) return model;
    const derived = score2.derivedTier;
    if (derived === model.tier) return model;
    if (tierIndex(derived) > tierIndex(model.tier)) {
      if (score2.priorBasis === "index-only") return model;
      if (model.tier !== topRung(model.id)) return model;
      const ceiling = promotionCeiling(score2);
      if (ceiling === void 0 || tierIndex(ceiling) <= tierIndex(model.tier)) return model;
      if (tierIndex(derived) > tierIndex(ceiling)) return { ...model, tier: ceiling };
    }
    return { ...model, tier: derived };
  });
}
function topConfiguredRungs(models) {
  const enabledTop = /* @__PURE__ */ new Map();
  const anyTop = /* @__PURE__ */ new Map();
  const raise = (into, id, tier2) => {
    const current = into.get(id);
    if (current === void 0 || tierIndex(tier2) > tierIndex(current)) into.set(id, tier2);
  };
  for (const model of models) {
    raise(anyTop, model.id, model.tier);
    if (model.enabled !== false) raise(enabledTop, model.id, model.tier);
  }
  return (modelId) => enabledTop.get(modelId) ?? anyTop.get(modelId);
}
var FREE_LANE_RE = /(-free$|^big-pickle$|-alpha$|-preview$)/;
var MODEL_FAIL_RE = /flagged for possible cybersecurity|exceeded the adapter execution timeout|timeoutSec|refus/i;
var INFRA_RE = /503|502|529|Overloaded|429|exhausted|All credentials|circuit breaker|Stream idle timeout|Stream ended|stalled mid-stream|stopped arriving|mid-response|disabled Claude subscription|ECONN|process_lost|all upstream accounts|not supported for format|issue with the selected model|budget_paused|Missing required permissions|recovery backstop|sandbox gone|401|404|subscription( is)? required/i;
function normModelId(modelId) {
  return modelId.replace(/^(cliproxy\/|openrouter\/|opencode-go\/)/, "");
}
function classifyRunFailure(errorText, errorCode, modelId) {
  if (FREE_LANE_RE.test(normModelId(modelId))) return { kind: "model", weight: 1 };
  if (errorCode === "timeout" || MODEL_FAIL_RE.test(errorText ?? "")) return { kind: "model", weight: 1 };
  if (INFRA_RE.test(errorText ?? "")) return { kind: "infra", weight: 0 };
  if (/400 status code \(no body\)/.test(errorText ?? "")) return { kind: "model", weight: 0.5 };
  return { kind: "model", weight: 0.5 };
}
function accumulateRunStats(rows) {
  const out = {};
  for (const row of rows) {
    if (row.tier === null) continue;
    const modelBucket = out[row.modelId] ?? {};
    const stats = modelBucket[row.tier] ?? emptyTierScoreStats();
    const w = Math.exp(-row.ageDays / 10);
    const next = {
      ...stats,
      n: stats.n + 1,
      okCost: [...stats.okCost],
      okMins: [...stats.okMins]
    };
    if (row.status === "succeeded") {
      next.ok += 1;
      next.wOk += w;
      if (row.costUsd !== null) next.okCost.push(row.costUsd);
      if (row.mins !== null) next.okMins.push(row.mins);
    } else if (row.status === "timed_out") {
      next.tmo += 1;
      next.wBad += w;
    } else {
      const { kind, weight } = classifyRunFailure(row.error, row.errorCode, row.modelId);
      if (kind === "infra") next.failInfra += 1;
      else {
        next.failModel += weight;
        next.wBad += w * weight;
      }
    }
    modelBucket[row.tier] = next;
    out[row.modelId] = modelBucket;
  }
  return out;
}
function foldReworkIntoStats(stats, reworkEvents) {
  const out = {};
  for (const [modelId, byTier] of Object.entries(stats)) {
    out[modelId] = { ...byTier };
  }
  for (const event of reworkEvents) {
    const weight = event.kind === "reopen" ? REWORK_WEIGHT_REOPEN : REWORK_WEIGHT_REJECTED;
    const modelBucket = out[event.modelId] ?? {};
    const tierStats = modelBucket[event.tier] ?? emptyTierScoreStats();
    modelBucket[event.tier] = {
      ...tierStats,
      failModel: tierStats.failModel + weight,
      wBad: tierStats.wBad + weight,
      rework: tierStats.rework + 1
    };
    out[event.modelId] = modelBucket;
  }
  return out;
}
function findClosingRun(issueId, atMs, windowMs, closingRuns, excludeAgentId) {
  let best = null;
  for (const run of closingRuns) {
    if (run.issueId !== issueId || run.tier === null) continue;
    if (excludeAgentId != null && run.agentId === excludeAgentId) continue;
    const delta = atMs - run.finishedAtMs;
    if (delta < 0 || delta > windowMs) continue;
    if (!best || run.finishedAtMs > best.finishedAtMs) best = run;
  }
  return best;
}
function zeroAcceptEvidence(modelId, tier2, ledger, nowMs) {
  const entry = ledger[`${modelId}:${tier2}`];
  if (!entry) return null;
  if (entry.modelId !== modelId || entry.tier !== tier2) return null;
  if (entry.pending !== false) return null;
  if (![entry.cardsClosed, entry.cardsResolved, entry.cardsAccepted].every(validCount)) return null;
  if (entry.cardsResolved > entry.cardsClosed || entry.cardsAccepted > entry.cardsResolved) return null;
  if (entry.cardsAccepted !== 0 || entry.acceptRate !== 0) return null;
  const cohort = entry.qualityCohort;
  if (!cohort) return null;
  if (![cohort.cardsResolved, cohort.cardsAccepted].every(validCount)) return null;
  if (cohort.cardsResolved > entry.cardsResolved || cohort.cardsAccepted > cohort.cardsResolved) return null;
  if (cohort.cardsResolved < CARD_ZERO_ACCEPT_MIN_RESOLVED) return null;
  if (cohort.cardsAccepted !== 0) return null;
  if (![nowMs, cohort.observedAtMs, cohort.oldestClosedAtMs, cohort.newestClosedAtMs].every(validCount)) return null;
  const censorMs = CARD_CENSOR_DAYS * 24 * 60 * 60 * 1e3;
  const windowMs = CARD_ZERO_ACCEPT_WINDOW_DAYS * 24 * 60 * 60 * 1e3;
  if (cohort.observedAtMs > nowMs || cohort.oldestClosedAtMs > cohort.newestClosedAtMs) return null;
  if (cohort.newestClosedAtMs > cohort.observedAtMs - censorMs) return null;
  const expiresAtMs = cohort.oldestClosedAtMs + censorMs + windowMs;
  if (nowMs >= expiresAtMs) return null;
  return { cardsResolved: cohort.cardsResolved, cardsAccepted: cohort.cardsAccepted, expiresAtMs };
}
function validCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
function buildCardLedger(cards, nowMs, priorPByModel, blendedListPriceByModel) {
  const byKey = /* @__PURE__ */ new Map();
  for (const card of cards) {
    const key = `${card.modelId}\0${card.tier}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(card);
    else byKey.set(key, [card]);
  }
  const out = {};
  for (const [key, rows] of byKey) {
    const [modelId, tier2] = key.split("\0");
    const censorMs = CARD_CENSOR_DAYS * 24 * 60 * 60 * 1e3;
    const resolved = rows.filter((r) => r.rejected || nowMs - r.closedAtMs >= censorMs);
    const accepted = resolved.filter((r) => !r.rejected);
    const qualityWindowMs = CARD_ZERO_ACCEPT_WINDOW_DAYS * 24 * 60 * 60 * 1e3;
    const mature = rows.filter((r) => {
      const age = nowMs - r.closedAtMs;
      return age >= censorMs && age < censorMs + qualityWindowMs;
    });
    const qualityCohort = mature.length ? {
      cardsResolved: mature.length,
      cardsAccepted: mature.filter((r) => !r.rejected).length,
      oldestClosedAtMs: mature.reduce((oldest, r) => Math.min(oldest, r.closedAtMs), Infinity),
      newestClosedAtMs: mature.reduce((newest, r) => Math.max(newest, r.closedAtMs), -Infinity),
      observedAtMs: nowMs
    } : void 0;
    const costs = resolved.map((r) => r.costUsd).filter((c) => c !== null);
    const runs = resolved.map((r) => r.runCount);
    const foreignCount = resolved.filter((r) => r.foreignRun).length;
    const measured = resolved.length > 0;
    const acceptRate = measured ? accepted.length / resolved.length : priorPByModel[modelId] ?? 0.8;
    const costPerCard = costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : blendedListPriceByModel[modelId] ?? null;
    out[key.replace("\0", ":")] = {
      modelId,
      tier: tier2,
      cardsClosed: rows.length,
      // TOG-3997. Published so a consumer can tell "never accepted" from
      // "not resolved yet". `cardsClosed` alone cannot: it counts the
      // censored rows, so a brand-new entrant reads as a long losing streak.
      cardsResolved: resolved.length,
      cardsAccepted: accepted.length,
      acceptRate,
      costPerCard,
      runsPerCard: runs.length ? runs.reduce((a, b) => a + b, 0) / runs.length : null,
      foreignRunShare: resolved.length ? foreignCount / resolved.length : null,
      costPerAcceptedCard: costPerCard !== null && acceptRate > 0 ? costPerCard / acceptRate : null,
      pending: !measured,
      qualityCohort
    };
  }
  return out;
}

// src/aa-index/match.ts
var ID_PREFIX_RE = /^(cliproxy\/|openrouter\/|opencode-go\/|zai\/)/;
function normalizeModelId(modelId) {
  return modelId.replace(ID_PREFIX_RE, "").toLowerCase().replace(/\./g, "-");
}
function resolveAaSlug(modelId, knownSlugs, explicitSlug) {
  if (explicitSlug) return knownSlugs.has(explicitSlug) ? explicitSlug : null;
  const normalized = normalizeModelId(modelId);
  return knownSlugs.has(normalized) ? normalized : null;
}
function tierImpliedByIndex(index, thresholds = LEGACY_TIER_POLICY.scoreThresholds) {
  const p = priorP(index);
  for (const tier2 of [...TIER_ORDER].reverse()) {
    if (p >= thresholds[tier2]) return tier2;
  }
  return null;
}
var EFFORT_SUFFIX_RE = /-(low|medium|high|xhigh|non-reasoning)$/;
function effortSuffixOf(slug) {
  return EFFORT_SUFFIX_RE.exec(slug)?.[1] ?? null;
}

// src/aa-index/parse.ts
var STRING_FIELDS = ["name", "shortName", "modelCreatorName", "paramClass", "priceClass"];
var BOOLEAN_FIELDS = ["deprecated", "isReasoning", "isOpenWeights", "intelligenceIndexIsEstimated"];
var AA_NUMERIC_FIELDS = [
  "intelligenceIndex",
  "intelligenceIndexCostPerTask",
  "price1mInputTokens",
  "price1mOutputTokens",
  "cacheHitPrice",
  "cacheWritePrice",
  "medianOutputTokensPerSecond",
  "outputTokensPerSecondP5",
  "outputTokensPerSecondP25",
  "outputTokensPerSecondP75",
  "outputTokensPerSecondP95",
  "medianTimeToFirstTokenSeconds",
  "medianTimeToFirstAnswerTokenSeconds",
  "medianEndToEndResponseTimeSeconds",
  "medianReasoningTimeSeconds",
  "contextWindowTokens",
  "gpqa",
  "hle",
  "critpt",
  "lcr",
  "ifbench",
  "tau2",
  "terminalbenchHard",
  "mmmuPro",
  "gdpvalNormalized",
  "terminalbenchV21",
  "tauBanking",
  "scicode",
  "terminalbenchV40",
  "itbenchSre",
  "analystAgent",
  "apexAgents",
  "omniscience",
  "omniscienceAccuracy",
  "omniscienceNonHallucination"
];
var ANCHOR = '{\\"models\\":[{\\"slug\\":\\"glm-4-5v\\"';
var ANCHOR_BRACKET_OFFSET = ANCHOR.indexOf("[");
function findAnchorIndex(html) {
  return html.indexOf(ANCHOR);
}
function extractBalancedArray(html, arrayStart) {
  let depth = 0;
  let inString = false;
  let i = arrayStart;
  for (; i < html.length; ) {
    const ch = html[i];
    const next = html[i + 1];
    if (ch === "\\" && next === '"') {
      inString = !inString;
      i += 2;
      continue;
    }
    if (ch === "\\" && next === "\\") {
      i += 2;
      continue;
    }
    if (inString) {
      i += 1;
      continue;
    }
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return html.slice(arrayStart, i + 1);
    }
    i += 1;
  }
  return null;
}
function unescapeOuterLayer(raw) {
  return raw.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}
function stringField(rec, key) {
  const value = rec[key];
  return typeof value === "string" ? value : null;
}
function booleanField(rec, key) {
  const value = rec[key];
  return typeof value === "boolean" ? value : null;
}
function numberField(rec, key) {
  const value = rec[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function buildRecord(rec) {
  const slug = rec.slug;
  if (typeof slug !== "string" || slug.length === 0) return null;
  const record3 = { slug };
  for (const key of STRING_FIELDS) record3[key] = stringField(rec, key);
  for (const key of BOOLEAN_FIELDS) record3[key] = booleanField(rec, key);
  for (const key of AA_NUMERIC_FIELDS) record3[key] = numberField(rec, key);
  return record3;
}
function parseAaLeaderboardHtml(html) {
  const anchorIndex = findAnchorIndex(html);
  if (anchorIndex < 0) return null;
  const arrayStart = anchorIndex + ANCHOR_BRACKET_OFFSET;
  const balanced = extractBalancedArray(html, arrayStart);
  if (balanced === null) return null;
  const unescaped = unescapeOuterLayer(balanced);
  let parsed;
  try {
    parsed = JSON.parse(unescaped);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const rows = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const record3 = buildRecord(entry);
    if (record3) rows.push(record3);
  }
  return rows.length > 0 ? rows : null;
}

// src/aa-index/diff.ts
function diffFields(previous, fresh) {
  const deltas = [];
  for (const field of AA_NUMERIC_FIELDS) {
    const prevValue = previous ? previous[field] : null;
    const freshValue = fresh[field];
    if (prevValue === null && freshValue === null) continue;
    if (prevValue === freshValue) continue;
    deltas.push({
      field,
      previous: prevValue,
      fresh: freshValue,
      delta: prevValue === null || freshValue === null ? null : freshValue - prevValue
    });
  }
  return deltas;
}
function diffSnapshot(models, freshBySlug, previousBySlug = /* @__PURE__ */ new Map()) {
  const rows = [];
  for (const model of models) {
    if (!model.slug) continue;
    const freshRecord = freshBySlug.get(model.slug);
    if (freshRecord === void 0 || freshRecord.intelligenceIndex === null) continue;
    const freshIndex = freshRecord.intelligenceIndex;
    const previousIndex = model.previousIndex;
    const delta = previousIndex === null ? null : freshIndex - previousIndex;
    const previousImpliedTier = previousIndex === null ? null : tierImpliedByIndex(previousIndex);
    const freshImpliedTier = tierImpliedByIndex(freshIndex);
    rows.push({
      modelId: model.modelId,
      previousIndex,
      freshIndex,
      delta,
      previousImpliedTier,
      freshImpliedTier,
      crossesBoundary: previousImpliedTier !== freshImpliedTier,
      fieldDeltas: diffFields(previousBySlug.get(model.slug), freshRecord)
    });
  }
  return rows;
}

// src/aa-index/fetch.ts
async function fetchAaSnapshot(input) {
  const fail = (error) => ({ ok: false, html: null, error });
  let parsed;
  try {
    parsed = new URL(input.url);
  } catch {
    return fail("aa-url-rejected");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    return fail("aa-url-rejected");
  }
  let response;
  try {
    let timer;
    response = await Promise.race([
      input.http.fetch(input.url, {
        method: "GET",
        headers: { Accept: "text/html", "Accept-Encoding": "identity" },
        redirect: "manual"
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("aa-request-timeout")), input.timeoutMs);
      })
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  } catch {
    return fail("aa-request-failed");
  }
  if (response.redirected || response.status >= 300 && response.status < 400) {
    return fail("aa-redirect-refused");
  }
  if (response.status < 200 || response.status >= 300) {
    return fail("aa-http-failed");
  }
  let text2;
  try {
    text2 = await response.text();
  } catch {
    return fail("aa-request-failed");
  }
  if (new TextEncoder().encode(text2).byteLength > input.maxResponseBytes) {
    return fail("aa-response-too-large");
  }
  return { ok: true, html: text2, error: null };
}

// src/aa-free/fetch.ts
var AA_FREE_LIST_URL = "https://artificialanalysis.ai/api/v2/data/llms/models";
async function fetchAaFreeList(input) {
  const url = input.url ?? AA_FREE_LIST_URL;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "aa-url-rejected", retryable: false };
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    return { ok: false, error: "aa-url-rejected", retryable: false };
  }
  if (!input.apiKey) return { ok: false, error: "aa-access-denied", status: 401, retryable: false };
  let response;
  let timer;
  try {
    response = await Promise.race([
      input.http.fetch(url, {
        method: "GET",
        headers: { Accept: "application/json", "Accept-Encoding": "identity", "x-api-key": input.apiKey },
        redirect: "manual"
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("aa-request-timeout")), input.timeoutMs);
      })
    ]);
  } catch {
    return { ok: false, error: "aa-request-failed", retryable: true };
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, error: "aa-access-denied", status: response.status, retryable: false };
  }
  if (response.status === 429) {
    const header = response.headers.get("retry-after");
    const raw = header === null || header.trim() === "" ? NaN : Number(header);
    return {
      ok: false,
      error: "aa-rate-limited",
      retryable: true,
      retryAfterSeconds: Number.isFinite(raw) && raw >= 0 ? raw : null
    };
  }
  if (response.redirected || response.status >= 300 && response.status < 400) {
    return { ok: false, error: "aa-redirect-refused", retryable: false };
  }
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, error: "aa-http-failed", retryable: response.status >= 500 };
  }
  let text2;
  try {
    text2 = await response.text();
  } catch {
    return { ok: false, error: "aa-request-failed", retryable: true };
  }
  if (new TextEncoder().encode(text2).byteLength > input.maxResponseBytes) {
    return { ok: false, error: "aa-response-too-large", retryable: false };
  }
  return { ok: true, text: text2 };
}

// src/engine/effort.ts
var EFFORT_LADDER = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra"
];
var CLAUDE_LOCAL_EFFORTS = ["low", "medium", "high"];
var OPENCODE_LOCAL_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
];
var CODEX_LOCAL_DEFAULT_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh"
];
var CODEX_LOCAL_ASTRA_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra"
];
var CODEX_LOCAL_ASTRA_MODEL = "gpt-6-astra";
function effortConfigKeyFor(adapterType) {
  switch (adapterType) {
    case "claude_local":
      return "effort";
    case "codex_local":
      return "modelReasoningEffort";
    case "opencode_local":
      return "variant";
    default:
      return null;
  }
}
function inheritedEffortFrom(adapterType, adapterConfig) {
  if (!adapterConfig) return null;
  const key = effortConfigKeyFor(adapterType);
  if (key === null) return null;
  const primary = adapterConfig[key];
  if (typeof primary === "string" && primary.trim().length > 0) return primary;
  if (adapterType === "codex_local") {
    const legacy = adapterConfig.reasoningEffort;
    if (typeof legacy === "string" && legacy.trim().length > 0) return legacy;
  }
  return null;
}
function effortVocabularyFor(adapterType, modelId) {
  switch (adapterType) {
    case "claude_local":
      return CLAUDE_LOCAL_EFFORTS;
    case "opencode_local":
      return OPENCODE_LOCAL_EFFORTS;
    case "codex_local":
      return normalizeCodexModel(modelId) === CODEX_LOCAL_ASTRA_MODEL ? CODEX_LOCAL_ASTRA_EFFORTS : CODEX_LOCAL_DEFAULT_EFFORTS;
    default:
      return null;
  }
}
var CODEX_LOCAL_MODEL_ALIASES = {
  "gpt-5.6": "gpt-5.6-sol"
};
function normalizeCodexModel(modelId) {
  const trimmed = typeof modelId === "string" ? modelId.trim() : "";
  return CODEX_LOCAL_MODEL_ALIASES[trimmed] ?? trimmed;
}
function ladderIndex(value) {
  return EFFORT_LADDER.indexOf(value);
}
function normalizeEffort(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
function clampToVocabulary(requestedIndex, vocabulary) {
  let best = null;
  let bestIndex = -1;
  let coolest = null;
  let coolestIndex = Number.POSITIVE_INFINITY;
  for (const candidate of vocabulary) {
    const index = ladderIndex(candidate);
    if (index < 0) continue;
    if (index < coolestIndex) {
      coolestIndex = index;
      coolest = candidate;
    }
    if (index <= requestedIndex && index > bestIndex) {
      bestIndex = index;
      best = candidate;
    }
  }
  return best ?? coolest;
}
function clearWritesFor(adapterType, key) {
  const writes = { [key]: "" };
  if (adapterType === "codex_local") writes.reasoningEffort = "";
  return writes;
}
function resolveEffortPin(input) {
  const key = effortConfigKeyFor(input.adapterType);
  const vocabulary = effortVocabularyFor(input.adapterType, input.modelId);
  const nothing = (outcome, reason) => ({
    writes: {},
    outcome,
    reason
  });
  if (key === null || vocabulary === null) {
    return nothing(
      "adapter-unsupported",
      `adapter ${input.adapterType ?? "unknown"} has no issue-level effort surface; leaving effort untouched`
    );
  }
  const legal = new Set(vocabulary);
  const rosterEffort = normalizeEffort(input.rosterEffort);
  if (rosterEffort) {
    if (legal.has(rosterEffort)) {
      return {
        writes: { [key]: rosterEffort },
        outcome: "pinned",
        reason: `roster effort ${rosterEffort} is legal for ${input.modelId} on ${input.adapterType}`
      };
    }
    const requestedIndex = ladderIndex(rosterEffort);
    if (requestedIndex < 0) {
      return nothing(
        "rejected",
        `roster effort "${rosterEffort}" is not a recognised level; refusing to write an unverifiable pair for ${input.modelId}`
      );
    }
    const clamped2 = clampToVocabulary(requestedIndex, vocabulary);
    if (clamped2 === null) {
      return nothing(
        "rejected",
        `no legal effort level for ${input.modelId} on ${input.adapterType}; refusing to write`
      );
    }
    return {
      writes: { [key]: clamped2 },
      outcome: "clamped",
      reason: `roster effort ${rosterEffort} is not offered by ${input.modelId} on ${input.adapterType} (${vocabulary.join("|")}); clamped to ${clamped2}`
    };
  }
  const inherited = normalizeEffort(input.inheritedEffort);
  if (!inherited) {
    return nothing(
      "none",
      `no roster effort for ${input.modelId} and nothing inherited; leaving effort unset`
    );
  }
  if (legal.has(inherited)) {
    return nothing(
      "inherited-ok",
      `no roster effort for ${input.modelId}; inherited ${inherited} is legal on ${input.adapterType}; left alone`
    );
  }
  const inheritedIndex = ladderIndex(inherited);
  const clamped = inheritedIndex < 0 ? null : clampToVocabulary(inheritedIndex, vocabulary);
  if (clamped === null) {
    return {
      writes: clearWritesFor(input.adapterType, key),
      outcome: "neutralized-cleared",
      reason: `inherited effort "${inherited}" is illegal for ${input.modelId} on ${input.adapterType} and has no clamp target; emptying ${Object.keys(clearWritesFor(input.adapterType, key)).join(" and ")} so the adapter falls back to its own default`
    };
  }
  return {
    writes: { [key]: clamped },
    outcome: "neutralized-clamped",
    reason: `inherited effort ${inherited} is illegal for ${input.modelId} on ${input.adapterType} (${vocabulary.join("|")}); clamped to ${clamped}`
  };
}

// src/aa-free/registry.ts
var KNOWN_EFFORTS2 = /* @__PURE__ */ new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra"
]);
function asEffort(v) {
  const e = (v ?? "").trim().toLowerCase();
  return KNOWN_EFFORTS2.has(e) ? e : "unknown";
}
function resolveEffectiveEffort(input) {
  const requested = asEffort(input.requestedEffort);
  const pin = resolveEffortPin({
    adapterType: input.adapterType,
    modelId: input.modelId,
    rosterEffort: input.requestedEffort ?? null,
    inheritedEffort: input.inheritedEffort ?? null
  });
  const key = effortConfigKeyFor(input.adapterType);
  let effective;
  switch (pin.outcome) {
    case "pinned":
    case "clamped":
    case "neutralized-clamped":
      effective = asEffort(key ? pin.writes[key] : null);
      break;
    case "inherited-ok":
      effective = asEffort(input.inheritedEffort);
      break;
    case "none":
    case "neutralized-cleared":
      effective = "default";
      break;
    default:
      effective = "unknown";
  }
  return { requestedEffort: requested, effectiveEffort: effective, observedServedEffort: null };
}
var AaEffortRegistry = class _AaEffortRegistry {
  byKey = /* @__PURE__ */ new Map();
  constructor(bindings) {
    for (const b of bindings) {
      const key = _AaEffortRegistry.key(b.modelId, b.laneId, b.evaluatedEffort);
      if (this.byKey.has(key)) throw new Error(`duplicate aa binding ${key}`);
      this.byKey.set(key, b);
    }
  }
  static key(modelId, laneId, effort) {
    return `${modelId}\0${laneId}\0${effort}`;
  }
  lookup(snapshot, input) {
    const { identity } = input;
    const eff = identity.effectiveEffort;
    if (eff === "unknown" || eff === "default") {
      return { status: "ineligible", reason: "effort-unknown", candidateId: null, identity };
    }
    const binding = this.byKey.get(_AaEffortRegistry.key(input.modelId, input.laneId, eff));
    if (!binding) return { status: "ineligible", reason: "no-binding", candidateId: null, identity };
    if (binding.observationalOnly) {
      return { status: "ineligible", reason: "observational-only", candidateId: binding.candidateId, identity };
    }
    if (snapshot.duplicateSlugs.includes(binding.aaSlug)) {
      return { status: "ineligible", reason: "slug-ambiguous", candidateId: binding.candidateId, identity };
    }
    const row = snapshot.rows.find((r) => r.slug === binding.aaSlug);
    if (!row) {
      return { status: "ineligible", reason: "slug-absent-from-snapshot", candidateId: binding.candidateId, identity };
    }
    return { status: "matched", candidateId: binding.candidateId, row, identity, binding };
  }
};

// src/aa-free/sync.ts
var BINDABLE_EFFORTS = /* @__PURE__ */ new Set([...EFFORT_LADDER, "none"]);
function normalizeRosterId(modelId) {
  const slash = modelId.lastIndexOf("/");
  const bare = slash === -1 ? modelId : modelId.slice(slash + 1);
  return bare.toLowerCase().replace(/\./g, "-");
}
function verifyBindings(input) {
  const verified = [];
  const broken = [];
  const ambiguous = [];
  const keyCounts = /* @__PURE__ */ new Map();
  for (const binding of input.bindings) {
    const key = binding.modelId + "\0" + binding.laneId + "\0" + binding.evaluatedEffort;
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }
  for (const binding of input.bindings) {
    const key = binding.modelId + "\0" + binding.laneId + "\0" + binding.evaluatedEffort;
    if ((keyCounts.get(key) ?? 0) > 1) {
      broken.push({ binding, reason: "duplicate-binding", detail: `duplicate binding for ${binding.modelId} x ${binding.laneId} x ${binding.evaluatedEffort}` });
      continue;
    }
    const model = input.models.find((m) => m.id === binding.modelId);
    if (!model) {
      broken.push({ binding, reason: "model-unknown", detail: `roster has no model ${binding.modelId}` });
      continue;
    }
    if (!model.laneId || model.laneId !== binding.laneId) {
      broken.push({
        binding,
        reason: "lane-mismatch",
        detail: `binding lane ${binding.laneId} !== roster lane ${model.laneId ?? "none"}`
      });
      continue;
    }
    if (!BINDABLE_EFFORTS.has(binding.evaluatedEffort)) {
      broken.push({
        binding,
        reason: "effort-inexpressible",
        detail: `evaluatedEffort ${binding.evaluatedEffort} is not a measurable effort level`
      });
      continue;
    }
    if (input.snapshot.duplicateSlugs.includes(binding.aaSlug)) {
      broken.push({ binding, reason: "slug-ambiguous", detail: `slug ${binding.aaSlug} is duplicated in the snapshot` });
      continue;
    }
    const row = input.snapshot.rows.find((r) => r.slug === binding.aaSlug);
    if (!row) {
      broken.push({ binding, reason: "slug-absent", detail: `slug ${binding.aaSlug} is absent from the snapshot` });
      continue;
    }
    verified.push({
      binding,
      aaIndex: row.aaIndex,
      held: model.fallbackOnly ? "fallback-only" : model.enabled ? null : "model-disabled"
    });
  }
  const bySlug = /* @__PURE__ */ new Map();
  for (const v of verified) {
    const group = bySlug.get(v.binding.aaSlug) ?? [];
    group.push(v);
    bySlug.set(v.binding.aaSlug, group);
  }
  const kept = [];
  for (const [aaSlug, group] of bySlug) {
    if (group.length > 1) {
      ambiguous.push({ aaSlug, candidateIds: group.map((g) => g.binding.candidateId).sort() });
    } else {
      kept.push(group[0]);
    }
  }
  return { verified: kept, broken, ambiguous };
}
function discoverUnbound(input) {
  const claimedSlugs = new Set(input.verified.map((v) => v.binding.aaSlug));
  const unbound = [];
  for (const model of input.models) {
    if (!model.enabled || !model.laneId) continue;
    const hasBinding = input.verified.some((v) => v.binding.modelId === model.id && v.binding.laneId === model.laneId);
    if (hasBinding) continue;
    const norm = normalizeRosterId(model.id);
    const suggestedSlug = input.snapshot.rows.some((r) => r.slug === norm) ? norm : null;
    const familySlugs = input.snapshot.rows.map((r) => r.slug).filter((slug) => slug !== norm && slug.startsWith(`${norm}-`)).sort();
    unbound.push({ modelId: model.id, laneId: model.laneId, suggestedSlug, familySlugs });
  }
  const knownFamilies = /* @__PURE__ */ new Set();
  for (const model of input.models) {
    if (!model.laneId) continue;
    const norm = normalizeRosterId(model.id);
    knownFamilies.add(norm);
    for (const row of input.snapshot.rows) {
      if (row.slug.startsWith(`${norm}-`)) knownFamilies.add(row.slug);
    }
  }
  const unmatched = input.snapshot.rows.map((r) => r.slug).filter((slug) => !claimedSlugs.has(slug) && !knownFamilies.has(slug)).sort();
  const cap = input.unmatchedCap ?? 100;
  return {
    unbound,
    unmatchedSlugs: unmatched.slice(0, cap),
    unmatchedTruncated: Math.max(0, unmatched.length - cap)
  };
}
function buildSyncDiff(input) {
  const { verified, broken, ambiguous } = verifyBindings(input);
  const { unbound, unmatchedSlugs, unmatchedTruncated } = discoverUnbound({ ...input, verified });
  return {
    digest: input.digest,
    fetchedAt: input.snapshot.retrievedAt,
    rowCount: input.snapshot.rows.length,
    verified,
    broken,
    ambiguous,
    unbound,
    unmatchedSlugs,
    unmatchedTruncated
  };
}
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}
function fnv1aHex(text2) {
  let hash = 2166136261;
  for (let i = 0; i < text2.length; i++) {
    hash ^= text2.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function freeSnapshotDigest(snapshot) {
  const rows = [...snapshot.rows].sort((a, b) => a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
  return fnv1aHex(JSON.stringify(canonicalize({ profile: snapshot.profile, source: snapshot.source, rows })));
}
function shouldFetchFreeSync(state, nowMs) {
  if (!state.nextEligibleAt) return true;
  const eligible = Date.parse(state.nextEligibleAt);
  return Number.isNaN(eligible) || nowMs >= eligible;
}
function nextEligibleAfter(outcome, nowMs, retryAfterSeconds, intervals) {
  const successMs = intervals?.successMs ?? 24 * 60 * 60 * 1e3;
  const retryMs = intervals?.retryMs ?? 60 * 60 * 1e3;
  let waitMs;
  switch (outcome) {
    case "ok":
    case "fatal":
      waitMs = successMs;
      break;
    case "retryable":
      waitMs = retryMs;
      break;
    case "rate-limited":
      waitMs = retryAfterSeconds !== null && retryAfterSeconds >= 0 ? retryAfterSeconds * 1e3 : retryMs;
      break;
  }
  return new Date(nowMs + waitMs).toISOString();
}
function isSnapshotFresh(fetchedAt, nowMs, maxAgeMs) {
  if (!fetchedAt) return false;
  const at = Date.parse(fetchedAt);
  return Number.isFinite(at) && nowMs >= at && nowMs - at <= maxAgeMs;
}
function buildAdviseEvidence(input) {
  if (input.bindings.length === 0) return null;
  const identity = resolveEffectiveEffort({
    adapterType: input.adapterType,
    modelId: input.model.id,
    requestedEffort: input.requestedEffort,
    inheritedEffort: input.inheritedEffort
  });
  const base = {
    requestedEffort: identity.requestedEffort,
    effectiveEffort: identity.effectiveEffort,
    // Advise time is pre-serving: served effort is unknown by construction,
    // so the field is the literal null rather than the identity's wider type.
    observedServedEffort: null,
    snapshotDigest: input.digest,
    stale: input.stale
  };
  const held = input.model.fallbackOnly ? "fallback-only" : null;
  if (input.stale) {
    return { ...base, status: "ineligible", candidateId: null, reason: "snapshot-stale", aaIndex: null, held };
  }
  let registry;
  try {
    registry = new AaEffortRegistry(input.bindings);
  } catch {
    return null;
  }
  const looked = registry.lookup(input.snapshot, {
    modelId: input.model.id,
    laneId: input.model.laneId ?? "",
    identity
  });
  if (looked.status === "matched") {
    const claimants = input.bindings.filter((b) => b.aaSlug === looked.binding.aaSlug).length;
    if (claimants > 1) {
      return { ...base, status: "ineligible", candidateId: looked.candidateId, reason: "slug-ambiguous", aaIndex: null, held };
    }
    return { ...base, status: "matched", candidateId: looked.candidateId, reason: null, aaIndex: looked.row.aaIndex, held };
  }
  return { ...base, status: "ineligible", candidateId: looked.candidateId, reason: looked.reason, aaIndex: null, held };
}
function recoverSelectedCandidate(models, decision) {
  if (!decision.modelId) return null;
  const found = models.find((m) => m.id === decision.modelId);
  if (!found) return null;
  return { ...found, candidateId: decision.aaEffortEvidence?.candidateId ?? null };
}

// src/accepted-work/cohort.ts
var UNKNOWN_COHORT_VALUE = "unknown";
var MEASURABLE_EFFORTS = /* @__PURE__ */ new Set([...EFFORT_LADDER, "none"]);
var OMNIROUTE_PROVIDER_PREFIX = "cliproxy/";
var EFFORT_PIN_KEYS = ["effort", "modelReasoningEffort", "variant", "reasoningEffort"];
function resolveServedModel(observed, models) {
  const trimmed = typeof observed === "string" ? observed.trim() : "";
  if (!trimmed || trimmed === UNKNOWN_COHORT_VALUE) {
    return { status: "unknown", servedModel: UNKNOWN_COHORT_VALUE, reason: "missing-identity" };
  }
  const exact = models.find((model) => model.id === trimmed);
  if (exact) {
    return { status: "known", servedModel: exact.id, reason: "exact-match" };
  }
  if (trimmed.startsWith(OMNIROUTE_PROVIDER_PREFIX)) {
    const stripped = trimmed.slice(OMNIROUTE_PROVIDER_PREFIX.length);
    const target = models.find((model) => model.id === stripped);
    if (target) {
      return { status: "known", servedModel: target.id, reason: "legacy-wrapper" };
    }
  }
  return { status: "unknown", servedModel: UNKNOWN_COHORT_VALUE, reason: "unmatched-identity" };
}
function resolveServedEffort(effortKeys) {
  const values = /* @__PURE__ */ new Set();
  if (effortKeys && typeof effortKeys === "object") {
    for (const key of EFFORT_PIN_KEYS) {
      const raw = effortKeys[key];
      if (typeof raw === "string" && raw.trim().length > 0) values.add(raw.trim());
    }
  }
  if (values.size === 0) {
    return { status: "unknown", servedEffort: UNKNOWN_COHORT_VALUE, reason: "missing-effort" };
  }
  if (values.size > 1) {
    return { status: "unknown", servedEffort: UNKNOWN_COHORT_VALUE, reason: "conflicting-effort" };
  }
  const [sole] = [...values];
  const effort = sole.toLowerCase();
  if (!MEASURABLE_EFFORTS.has(effort)) {
    return { status: "unknown", servedEffort: UNKNOWN_COHORT_VALUE, reason: "unmeasurable-effort" };
  }
  return { status: "known", servedEffort: effort, reason: "pinned-effort" };
}
function resolveTaskClass(recorded) {
  if (typeof recorded !== "string") return UNKNOWN_COHORT_VALUE;
  const trimmed = recorded.trim();
  if (trimmed.length === 0 || trimmed === UNKNOWN_COHORT_VALUE) return UNKNOWN_COHORT_VALUE;
  return trimmed;
}
var TASK_CLASS_LABEL_PREFIX = "class:";
function resolveTaskClassFromLabels(labelNames) {
  if (!labelNames) return UNKNOWN_COHORT_VALUE;
  for (const name of labelNames) {
    if (!name.startsWith(TASK_CLASS_LABEL_PREFIX)) continue;
    return resolveTaskClass(name.slice(TASK_CLASS_LABEL_PREFIX.length));
  }
  return UNKNOWN_COHORT_VALUE;
}
function cohortKey(cohort) {
  return [cohort.servedModel, cohort.servedEffort, cohort.taskClass].join("\0");
}

// src/accepted-work/posterior.ts
var ACCEPTED_WORK_SPEC_VERSION = "tog12972-v1";
function round2(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
function isSafeCount(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function attributeAcceptedWorkCard(card, models) {
  const model = resolveServedModel(card.rawServedModel, models);
  const effort = resolveServedEffort(card.pinAdapterConfig);
  const taskClass = resolveTaskClassFromLabels(card.labelNames);
  const served = model.status === "known" ? models.find((m) => m.id === model.servedModel) ?? null : null;
  const held = served?.fallbackOnly === true ? "fallback-only" : null;
  return {
    cohort: { servedModel: model.servedModel, servedEffort: effort.servedEffort, taskClass },
    held,
    attribution: { modelReason: model.reason, effortReason: effort.reason }
  };
}
function buildAcceptedWorkOverlay(input) {
  const censorMs = CARD_CENSOR_DAYS * 24 * 60 * 60 * 1e3;
  const byKey = /* @__PURE__ */ new Map();
  for (const card of input.cards) {
    const { cohort, held } = attributeAcceptedWorkCard(card, input.models);
    const key = cohortKey(cohort);
    const bucket = byKey.get(key);
    if (bucket) bucket.rows.push(card);
    else byKey.set(key, { cohort, held, rows: [card] });
  }
  const cohorts = [...byKey.values()].map(({ cohort, held, rows }) => {
    const resolved = rows.filter((r) => r.rejected || input.nowMs - r.closedAtMs >= censorMs);
    const accepted = resolved.filter((r) => !r.rejected);
    const priorP2 = cohort.servedModel === UNKNOWN_COHORT_VALUE ? 0.8 : input.priorPByModel[cohort.servedModel] ?? 0.8;
    const p = (accepted.length + SCORE_PRIOR_K * priorP2) / (resolved.length + SCORE_PRIOR_K);
    const first = rows[0];
    const trail = attributeAcceptedWorkCard(first, input.models).attribution;
    return {
      ...cohort,
      resolved: resolved.length,
      accepted: accepted.length,
      rejected: resolved.length - accepted.length,
      pending: rows.length - resolved.length,
      priorP: round2(priorP2, 4),
      p: round2(p, 3),
      proven: resolved.length >= SCORE_PROVEN_N,
      held,
      attribution: trail
    };
  });
  cohorts.sort(
    (a, b) => cohortKey(a) < cohortKey(b) ? -1 : cohortKey(a) > cohortKey(b) ? 1 : 0
  );
  return {
    specVersion: ACCEPTED_WORK_SPEC_VERSION,
    computedAt: input.nowIso,
    cohorts,
    unattributed: { ...input.unattributed }
  };
}
function normalizeAcceptedWorkOverlay(stored) {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;
  const record3 = stored;
  if (record3.specVersion !== ACCEPTED_WORK_SPEC_VERSION) return null;
  if (!Array.isArray(record3.cohorts)) return null;
  if (typeof record3.computedAt !== "string") return null;
  const unattributed = record3.unattributed;
  const cohorts = [];
  for (const entry of record3.cohorts) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const row = entry;
    if (typeof row.servedModel !== "string" || typeof row.servedEffort !== "string" || typeof row.taskClass !== "string" || !isSafeCount(row.resolved) || !isSafeCount(row.accepted) || !isSafeCount(row.rejected) || !isSafeCount(row.pending) || typeof row.priorP !== "number" || !Number.isFinite(row.priorP) || typeof row.p !== "number" || !Number.isFinite(row.p) || typeof row.proven !== "boolean" || row.held !== null && row.held !== "fallback-only") {
      return null;
    }
    cohorts.push(row);
  }
  return {
    specVersion: ACCEPTED_WORK_SPEC_VERSION,
    computedAt: record3.computedAt,
    cohorts,
    unattributed: {
      closedCardsWithoutClosingRun: isSafeCount(unattributed?.closedCardsWithoutClosingRun) ? unattributed.closedCardsWithoutClosingRun : 0
    }
  };
}

// src/price-sync/match.ts
var LANE_PRICE_PROVIDERS = {
  "cliproxy-claude": "anthropic",
  "cliproxy-codex": "openai",
  "cliproxy-meta": "meta",
  "cliproxy-zai": "zhipuai",
  "cliproxy-kimi": "moonshotai",
  "cliproxy-opencode-go": "opencode-go"
};
var DEVIN_PREFIX = "devin/";
var RETIRED_VERIFIED_IDS = /* @__PURE__ */ new Set([
  "claude-3-5-haiku-20241022",
  "claude-3-7-sonnet-20250219",
  "claude-opus-4-1-20250805",
  "claude-opus-4-20250514",
  "claude-sonnet-4-20250514",
  "claude-opus-4-6-thinking"
]);
var PER_IMAGE_IDS = /* @__PURE__ */ new Set(["gpt-image-1.5", "gpt-image-2"]);
function bareModelId(modelId) {
  const slash = modelId.lastIndexOf("/");
  return slash === -1 ? modelId : modelId.slice(slash + 1);
}
function priceExclusionReason(modelId, note) {
  if (modelId.startsWith(DEVIN_PREFIX)) return "metered-not-per-token";
  const bare = bareModelId(modelId);
  if (bare.endsWith("-free") || /(?:free Zen model|no Go quota)/i.test(note ?? "")) return "free-tier";
  if (RETIRED_VERIFIED_IDS.has(bare)) return "retired-verified";
  if (PER_IMAGE_IDS.has(bare)) return "per-image";
  return null;
}
function matchRosterRow(row, catalog) {
  const excluded = priceExclusionReason(row.modelId, row.note);
  if (excluded) return { kind: "excluded", reason: excluded };
  if (!row.laneId) return { kind: "no-lane" };
  const providerId = LANE_PRICE_PROVIDERS[row.laneId];
  if (!providerId) return { kind: "unmapped-lane", laneId: row.laneId };
  const bareId = bareModelId(row.modelId);
  const models = catalog.get(providerId);
  if (!models || !models.has(bareId)) return { kind: "absent-from-feed", providerId, bareId };
  return { kind: "matched", providerId, bareId };
}

// src/price-sync/diff.ts
var PRICE_FIELDS = ["costPerMTokIn", "costPerMTokOut", "costPerMTokCacheRead"];
var FEED_FIELD_OF = {
  costPerMTokIn: "input",
  costPerMTokOut: "output",
  costPerMTokCacheRead: "cacheRead"
};
var PRICE_EPSILON_RELATIVE = 1e-9;
function samePrice(a, b) {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) <= PRICE_EPSILON_RELATIVE * scale;
}
function buildNote(row, fetchDate) {
  const parts = row.fields.map((f) => {
    const label = f.field === "costPerMTokIn" ? "in" : f.field === "costPerMTokOut" ? "out" : "cache read";
    return `${label} ${f.roster} \u2192 ${f.feed}`;
  });
  return `${fetchDate} models.dev price reconciliation (source: https://models.dev/api.json, provider ${row.providerId}): ${parts.join(", ")}. List price \u2014 correct for relative cost ordering, not what we actually pay on a flat plan.`;
}
function severityOf(fields) {
  if (fields.some((f) => f.roster === 0)) return "zero-priced";
  return fields.some((f) => f.ratio !== null && f.ratio > 1) ? "understated" : "overstated";
}
var SEVERITY_ORDER = {
  "zero-priced": 0,
  understated: 1,
  overstated: 2
};
function reconcilePrices(input) {
  const fetchDate = input.fetchedAt.slice(0, 10);
  const report = {
    fetchedAt: input.fetchedAt,
    checked: 0,
    unchanged: 0,
    drift: [],
    excluded: [],
    unresolved: []
  };
  for (const row of input.rows) {
    const outcome = matchRosterRow({ modelId: row.id, laneId: row.laneId, note: row.note }, input.catalog);
    if (outcome.kind === "excluded") {
      report.excluded.push({ modelId: row.id, reason: outcome.reason });
      continue;
    }
    if (outcome.kind === "no-lane") {
      report.unresolved.push({
        modelId: row.id,
        kind: "no-lane",
        detail: "row carries no laneId, so no provider can be resolved without guessing"
      });
      continue;
    }
    if (outcome.kind === "unmapped-lane") {
      report.unresolved.push({
        modelId: row.id,
        kind: "unmapped-lane",
        detail: `lane ${outcome.laneId} has no models.dev provider in LANE_PRICE_PROVIDERS`
      });
      continue;
    }
    if (outcome.kind === "absent-from-feed") {
      report.unresolved.push({
        modelId: row.id,
        kind: "absent-from-feed",
        detail: `${outcome.providerId} publishes no model ${outcome.bareId}; absence is not evidence of a wrong price`
      });
      continue;
    }
    const record3 = input.catalog.get(outcome.providerId)?.get(outcome.bareId);
    if (!record3) {
      report.unresolved.push({
        modelId: row.id,
        kind: "absent-from-feed",
        detail: `${outcome.providerId}/${outcome.bareId} vanished between match and read`
      });
      continue;
    }
    const fields = [];
    let anyComparable = false;
    for (const field of PRICE_FIELDS) {
      const feed = record3[FEED_FIELD_OF[field]];
      if (feed === null) continue;
      anyComparable = true;
      const roster = row[field];
      if (samePrice(roster, feed)) continue;
      fields.push({ field, roster, feed, ratio: roster === 0 ? null : feed / roster });
    }
    if (!anyComparable) {
      report.unresolved.push({
        modelId: row.id,
        kind: "unpriced-in-feed",
        detail: `${outcome.providerId}/${outcome.bareId} is in the feed but publishes no cost block`
      });
      continue;
    }
    report.checked += 1;
    if (fields.length === 0) {
      report.unchanged += 1;
      continue;
    }
    const severity = severityOf(fields);
    const ratios = fields.map((f) => f.ratio).filter((r) => r !== null);
    const maxRatio = Math.max(...ratios.map((r) => Math.max(r, 1 / r)));
    const driftRow = {
      modelId: row.id,
      providerId: outcome.providerId,
      bareId: outcome.bareId,
      enabled: row.enabled,
      fields,
      severity,
      maxRatio: severity === "zero-priced" || !Number.isFinite(maxRatio) ? null : maxRatio,
      suggestedNote: ""
    };
    driftRow.suggestedNote = buildNote(driftRow, fetchDate);
    report.drift.push(driftRow);
  }
  report.drift.sort((left, right) => {
    const bySeverity = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
    if (bySeverity !== 0) return bySeverity;
    if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
    if (left.maxRatio !== right.maxRatio) {
      if (left.maxRatio === null) return -1;
      if (right.maxRatio === null) return 1;
      return right.maxRatio - left.maxRatio;
    }
    return left.modelId.localeCompare(right.modelId);
  });
  return report;
}

// src/price-sync/fetch.ts
async function fetchPriceCatalog(input) {
  const fail = (error) => ({ ok: false, json: null, error });
  let parsed;
  try {
    parsed = new URL(input.url);
  } catch {
    return fail("price-url-rejected");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    return fail("price-url-rejected");
  }
  let response;
  try {
    let timer;
    response = await Promise.race([
      input.http.fetch(input.url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "identity",
          "User-Agent": input.userAgent
        },
        redirect: "manual"
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("price-request-timeout")), input.timeoutMs);
      })
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  } catch {
    return fail("price-request-failed");
  }
  if (response.redirected || response.status >= 300 && response.status < 400) {
    return fail("price-redirect-refused");
  }
  if (response.status === 403) {
    return fail("price-http-forbidden");
  }
  if (response.status < 200 || response.status >= 300) {
    return fail("price-http-failed");
  }
  let text2;
  try {
    text2 = await response.text();
  } catch {
    return fail("price-request-failed");
  }
  if (new TextEncoder().encode(text2).byteLength > input.maxResponseBytes) {
    return fail("price-response-too-large");
  }
  return { ok: true, json: text2, error: null };
}

// src/price-sync/parse.ts
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function finiteNumber2(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function parsePriceCatalog(json) {
  let root;
  try {
    root = JSON.parse(json);
  } catch {
    return null;
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) return null;
  const catalog = /* @__PURE__ */ new Map();
  for (const [providerId, providerValue] of Object.entries(root)) {
    const models = asRecord(asRecord(providerValue).models);
    if (Object.keys(models).length === 0) continue;
    const byModel = /* @__PURE__ */ new Map();
    for (const [modelId, modelValue] of Object.entries(models)) {
      const cost = asRecord(asRecord(modelValue).cost);
      byModel.set(modelId, {
        providerId,
        modelId,
        input: finiteNumber2(cost.input),
        output: finiteNumber2(cost.output),
        cacheRead: finiteNumber2(cost.cache_read)
      });
    }
    catalog.set(providerId, byModel);
  }
  return catalog.size === 0 ? null : catalog;
}

// src/engine/model-id.ts
var OMNIROUTE_PROVIDER_PREFIX2 = "cliproxy/";
function resolveConfiguredModelId(modelId, models) {
  if (!modelId) return null;
  if (models.some((model) => model.id === modelId)) return modelId;
  if (!modelId.startsWith(OMNIROUTE_PROVIDER_PREFIX2)) return null;
  const directModelId = modelId.slice(OMNIROUTE_PROVIDER_PREFIX2.length);
  return models.some((model) => model.id === directModelId) ? directModelId : null;
}
var DEVIN_MODEL_PREFIX = "devin/";
var ADAPTER_CLAUDE_LOCAL = "claude_local";
function isDevinModelId(modelId) {
  return typeof modelId === "string" && modelId.startsWith(DEVIN_MODEL_PREFIX);
}
function isAdapterBlockedModel(modelId, adapterType) {
  return adapterType === ADAPTER_CLAUDE_LOCAL && isDevinModelId(modelId);
}

// src/engine/objective.ts
function costPerAcceptedCardFor(modelId, tier2, ledger) {
  return ledger[`${modelId}:${tier2}`]?.costPerAcceptedCard ?? null;
}
function hasCostPerAcceptedCard(candidate, ledger) {
  return costPerAcceptedCardFor(candidate.modelId, candidate.tier, ledger) !== null;
}
function orderByCostPerAcceptedCard(candidates, ledger) {
  return candidates.map((candidate) => ({ candidate, cost: costPerAcceptedCardFor(candidate.modelId, candidate.tier, ledger) })).sort((a, b) => {
    if (a.cost === null && b.cost === null) return 0;
    if (a.cost === null) return 1;
    if (b.cost === null) return -1;
    return a.cost - b.cost || a.candidate.modelId.localeCompare(b.candidate.modelId);
  }).map((row) => row.candidate);
}
function computeShadowDiff(issueId, tier2, candidates, listPriceWinnerId, ledger) {
  if (listPriceWinnerId === null) return null;
  const costable = candidates.filter((candidate) => hasCostPerAcceptedCard(candidate, ledger));
  const byCard = orderByCostPerAcceptedCard(costable, ledger);
  const costPerAcceptedCardWinner = byCard[0]?.modelId ?? null;
  if (costPerAcceptedCardWinner === null) return null;
  return {
    issueId,
    tier: tier2,
    listPriceWinner: listPriceWinnerId,
    costPerAcceptedCardWinner,
    agree: costPerAcceptedCardWinner === listPriceWinnerId
  };
}
function orderByObjective(candidates, objective, ledger) {
  if (objective === "list-price") return [...candidates];
  return orderByCostPerAcceptedCard(candidates, ledger);
}

// src/engine/tier.ts
function isTier(value) {
  return TIERS.includes(value);
}
function tierFromLabels(labelNames) {
  if (!labelNames) return null;
  const found = [];
  for (const name of labelNames) {
    if (!name.startsWith(TIER_LABEL_PREFIX)) continue;
    const suffix = name.slice(TIER_LABEL_PREFIX.length);
    if (isTier(suffix)) found.push(suffix);
  }
  if (found.length === 0) return null;
  return found.sort((left, right) => TIER_ORDER.indexOf(right) - TIER_ORDER.indexOf(left))[0];
}
function tierOfModel(modelId, models) {
  const configuredId = resolveConfiguredModelId(modelId, models);
  if (!configuredId) return null;
  const matches = models.filter((model) => model.id === configuredId && model.enabled);
  if (matches.length === 0) return null;
  return matches.reduce(
    (highest, model) => TIER_ORDER.indexOf(model.tier) > TIER_ORDER.indexOf(highest) ? model.tier : highest,
    matches[0].tier
  );
}
function resolveTier(descriptor, models, configDefaultTier, options) {
  if (descriptor.exclusion?.excluded) {
    return {
      tier: "T1",
      source: "capability-exclusion",
      detail: `capability exclusion forces T1: ${descriptor.exclusion.reasons.join("; ") || "unspecified"}`
    };
  }
  const pinnedModelId = resolveConfiguredModelId(descriptor.pinnedModelId, models);
  const pinnedMatches = models.filter((model) => model.id === pinnedModelId && model.enabled);
  const servicablePinnedMatches = pinnedMatches.filter(
    (model) => !(options?.isLaneUnserviceable?.(model) ?? false)
  );
  if (pinnedMatches.length > 0 && servicablePinnedMatches.length === 0) {
  } else if (servicablePinnedMatches.length > 0) {
    const pinnedTier = servicablePinnedMatches.reduce(
      (highest, model) => TIER_ORDER.indexOf(model.tier) > TIER_ORDER.indexOf(highest) ? model.tier : highest,
      servicablePinnedMatches[0].tier
    );
    return {
      tier: pinnedTier,
      source: "issue-override",
      detail: `assigneeAdapterOverrides pins ${pinnedModelId} (${pinnedTier})`
    };
  }
  const labelTier = tierFromLabels(descriptor.labelNames);
  if (labelTier) {
    return { tier: labelTier, source: "issue-label", detail: `${TIER_LABEL_PREFIX}${labelTier} label on the issue` };
  }
  const floorTier = tierOfModel(descriptor.agentFloorModelId, models);
  if (floorTier) {
    return {
      tier: floorTier,
      source: "agent-floor",
      detail: `no issue-level judgement; assignee floor ${descriptor.agentFloorModelId} (${floorTier})`
    };
  }
  return {
    tier: configDefaultTier,
    source: "config-default",
    detail: `no judgement and no recognised agent floor; config default ${configDefaultTier}`
  };
}

// src/engine/lane-evidence.ts
var Z_95 = 1.959963985;
var EVIDENCE_MIN_SAMPLES = 5;
var EVIDENCE_ZERO_SUCCESS_SAMPLES = EVIDENCE_MIN_SAMPLES;
var EVIDENCE_DEAD_THRESHOLD = 0.2;
var EVIDENCE_GOOD_THRESHOLD = 0.5;
function wilsonInterval(successes, total, z = Z_95) {
  if (total <= 0) return { lower: 0, upper: 1 };
  const phat = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (phat + z2 / (2 * total)) / denominator;
  const margin = z / denominator * Math.sqrt(phat * (1 - phat) / total + z2 / (4 * total * total));
  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin)
  };
}
function evaluateLaneEvidence(counts, thresholds = {}) {
  const minSamples = thresholds.minSamples ?? EVIDENCE_MIN_SAMPLES;
  const zeroSuccessSamples = thresholds.zeroSuccessSamples ?? EVIDENCE_ZERO_SUCCESS_SAMPLES;
  const dead = thresholds.deadThreshold ?? EVIDENCE_DEAD_THRESHOLD;
  const good = thresholds.goodThreshold ?? EVIDENCE_GOOD_THRESHOLD;
  const succeeded = Math.max(0, Math.trunc(counts.succeeded));
  const failed = Math.max(0, Math.trunc(counts.failed));
  const total = succeeded + failed;
  const { lower, upper } = wilsonInterval(succeeded, total);
  const successRate = total > 0 ? succeeded / total : null;
  const base = {
    laneId: counts.laneId,
    succeeded,
    failed,
    total,
    successRate,
    lowerBound: lower,
    upperBound: upper
  };
  if (total === 0) {
    return {
      ...base,
      state: "unproven",
      rule: "no-runs",
      reason: `${counts.laneId}: no recorded runs in the window`
    };
  }
  if (succeeded === 0 && total >= zeroSuccessSamples) {
    return {
      ...base,
      state: "proven-dead",
      rule: "zero-success",
      reason: `${counts.laneId}: 0/${total} succeeded \u2014 no lane success in ${total} observations (zero-success rule fires at ${zeroSuccessSamples})`
    };
  }
  if (upper <= dead) {
    return {
      ...base,
      state: "proven-dead",
      rule: "wilson-upper",
      reason: `${counts.laneId}: ${succeeded}/${total} succeeded \u2014 95% upper bound ${upper.toFixed(3)} is at or below the ${dead} dead threshold`
    };
  }
  if (total >= minSamples && lower >= good) {
    return {
      ...base,
      state: "proven-good",
      rule: "wilson-lower",
      reason: `${counts.laneId}: ${succeeded}/${total} succeeded \u2014 95% lower bound ${lower.toFixed(3)} is at or above the ${good} good threshold`
    };
  }
  return {
    ...base,
    state: "unproven",
    rule: "inconclusive",
    reason: `${counts.laneId}: ${succeeded}/${total} succeeded \u2014 95% interval [${lower.toFixed(3)}, ${upper.toFixed(3)}] proves neither good nor dead`
  };
}
function buildLaneEvidence(counts, windowHours, thresholds = {}) {
  const lanes = counts.map((entry) => evaluateLaneEvidence(entry, thresholds)).sort((left, right) => left.laneId.localeCompare(right.laneId));
  return { lanes, windowHours, unreadableReason: null };
}
function evidenceStateFor(snapshot, laneId) {
  if (!snapshot || snapshot.unreadableReason) return "unproven";
  if (!laneId) return "unproven";
  return snapshot.lanes.find((lane) => lane.laneId === laneId)?.state ?? "unproven";
}
function costDownWouldAbandonProvenLane(fromState, toState) {
  return fromState === "proven-good" && toState !== "proven-good";
}

// src/engine/pick-order.ts
function provenFor(modelScores, modelId, tier2) {
  return modelScores[modelId]?.tiers[tier2]?.proven ?? false;
}
function applyPickOrdering(candidates, models, ledger, modelScores, requiredTier, issueId, allowExplore = true) {
  if (candidates.length === 0) {
    return { ordered: [], explored: false, exploreModelId: null };
  }
  const modelOf3 = (candidate) => models.find((model) => model.id === candidate.modelId);
  const utilizationOf = (candidate) => {
    const model = modelOf3(candidate);
    return model?.laneId ? laneEffectiveUtilization(ledger, model.laneId) : 0.5;
  };
  const listPriceOf = (candidate) => {
    const model = modelOf3(candidate);
    return model ? blendedListPrice(model) : candidate.expectedCostUsd;
  };
  const provenOf = (candidate) => provenFor(modelScores, candidate.modelId, requiredTier);
  const unproven = candidates.filter((candidate) => !provenOf(candidate));
  if (allowExplore && requiredTier !== "T1" && unproven.length > 0 && hashUnitInterval(`explore:${requiredTier}:${issueId}`) < EXPLORE_FRACTION) {
    const explored = [...unproven].sort((a, b) => a.expectedCostUsd - b.expectedCostUsd)[0];
    return {
      ordered: [explored, ...candidates.filter((candidate) => candidate.modelId !== explored.modelId)],
      explored: true,
      exploreModelId: explored.modelId
    };
  }
  const main = candidates.filter((candidate) => provenOf(candidate) || listPriceOf(candidate) >= FREE_MUST_BE_PROVEN_USD);
  const pool = main.length > 0 ? main : candidates;
  const cheapest = Math.min(...pool.map((candidate) => candidate.expectedCostUsd));
  const band = pool.filter((candidate) => candidate.expectedCostUsd <= cheapest * COST_BAND_MULTIPLIER);
  const rest = candidates.filter((candidate) => !band.some((banded) => banded.modelId === candidate.modelId));
  const bandOrdered = [...band].sort((a, b) => {
    const utilizationDelta = utilizationOf(a) - utilizationOf(b);
    if (utilizationDelta !== 0) return utilizationDelta;
    if (a.expectedCostUsd !== b.expectedCostUsd) return a.expectedCostUsd - b.expectedCostUsd;
    const provenDelta = (provenOf(a) ? 0 : 1) - (provenOf(b) ? 0 : 1);
    if (provenDelta !== 0) return provenDelta;
    const tieA = hashUnitInterval(`${issueId}:${a.modelId}`);
    const tieB = hashUnitInterval(`${issueId}:${b.modelId}`);
    if (tieA !== tieB) return tieA - tieB;
    return a.modelId.localeCompare(b.modelId);
  });
  return { ordered: [...bandOrdered, ...rest], explored: false, exploreModelId: null };
}

// src/engine/free-lane-earn-in.ts
var EARN_IN_PROTECTED_PRIORITIES = /* @__PURE__ */ new Set(["critical", "high", "urgent"]);
var REVIEW_GATE_TITLE_RE = /\b(review|reviews|reviewer|reviewing|gate|gates|gating|gateway)\b/i;
function earnInGuardFor(descriptor) {
  const priority = typeof descriptor?.priority === "string" ? descriptor.priority.trim().toLowerCase() : "";
  if (EARN_IN_PROTECTED_PRIORITIES.has(priority)) {
    return { protected: true, reason: `priority ${descriptor.priority} never takes experimental earn-in traffic` };
  }
  const title = typeof descriptor?.title === "string" ? descriptor.title : "";
  if (REVIEW_GATE_TITLE_RE.test(title)) {
    return { protected: true, reason: "review/gate cards never take experimental earn-in traffic" };
  }
  return { protected: false, reason: null };
}
function modelOf2(models, candidate) {
  return models.find((model) => model.id === candidate.modelId);
}
function freeEarnInCandidates(candidates, models, ledger, modelScores, requiredTier, descriptor) {
  if (earnInGuardFor(descriptor).protected) return [];
  const picks = [];
  for (const candidate of candidates) {
    const model = modelOf2(models, candidate);
    const laneId = model?.laneId ?? null;
    if (!laneId) continue;
    const verdict = laneVerdictFor(ledger, laneId);
    if (!verdict || verdict.state !== "free" || verdict.serviceable !== true) continue;
    const tierScore = tierScoreFor(modelScores?.[candidate.modelId], requiredTier);
    if (tierScore?.proven) continue;
    if (tierScore?.capable === false) continue;
    picks.push({ candidate, laneId, observations: tierScore?.n ?? 0 });
  }
  return picks;
}
function freeEarnInWinner(candidates, models, ledger, modelScores, requiredTier, descriptor) {
  const picks = freeEarnInCandidates(candidates, models, ledger, modelScores, requiredTier, descriptor);
  if (picks.length === 0) return null;
  const sorted = [...picks].sort((a, b) => {
    if (a.candidate.expectedCostUsd !== b.candidate.expectedCostUsd) {
      return a.candidate.expectedCostUsd - b.candidate.expectedCostUsd;
    }
    if (a.candidate.releasedAt !== b.candidate.releasedAt) {
      return a.candidate.releasedAt > b.candidate.releasedAt ? -1 : 1;
    }
    return a.candidate.modelId.localeCompare(b.candidate.modelId);
  });
  return sorted[0];
}

// src/engine/select.ts
function selectModel(input) {
  const { descriptor, config, profiles, signals, now } = input;
  const trace = [];
  const rejections = [];
  const pacingMode = config.pacingMode ?? "shadow";
  const paceActive = pacingMode !== "off";
  const paceEnforced = pacingMode === "enforce";
  const ledger = config.laneLedger ?? {};
  const slotFloorFraction = config.slotFloorFraction ?? 0.25;
  const overrideModelId = resolveConfiguredModelId(config.operatorOverrideModelId, config.models);
  const availability = input.availability;
  const availableLanes = new Map(
    (availability?.lanes ?? []).map((lane) => [lane.laneId, lane])
  );
  const holdOnUnknownAvailability = config.holdOnUnknownAvailability ?? false;
  const trafficScale = descriptor.trafficScale ?? "issue";
  const excludedByLane = [];
  const unknownLanes = [];
  function laneRead(model) {
    if (modelCooldownExcluded(ledger, model, now)) {
      return { state: "unavailable", term: "cooldown", reason: `lane ${model.laneId}: active cooldown for ${model.id}` };
    }
    if (!availability) return { state: "available" };
    if (availability.unreadableReason) {
      return { state: "unknown", term: "staleness", reason: availability.unreadableReason };
    }
    const laneId = model.laneId ?? null;
    if (!laneId) {
      return { state: "unknown", term: "unmapped", reason: `${model.id} declares no laneId` };
    }
    const lane = availableLanes.get(laneId);
    if (!lane) {
      return { state: "unknown", term: "unmapped", reason: `lane ${laneId} is absent from the snapshot` };
    }
    if (lane.state === "unavailable") {
      return { state: "unavailable", term: lane.term ?? "health", reason: `lane ${laneId}: ${lane.reason}` };
    }
    if (lane.state === "unknown") {
      return { state: "unknown", term: lane.term ?? "staleness", reason: `lane ${laneId}: ${lane.reason}` };
    }
    if (activeModelCooldown(lane.modelCooldowns ?? [], model.id, now)) {
      return { state: "unavailable", term: "cooldown", reason: `lane ${laneId}: active cooldown for ${model.id}` };
    }
    if (trafficScale === "fleet-default" && lane.serviceableAccountCount <= 1) {
      return {
        state: "unavailable",
        term: "accounts",
        reason: `lane ${laneId}: ${lane.serviceableAccountCount} serviceable account(s) cannot carry fleet-default-scale traffic at any quota level`
      };
    }
    return { state: "available" };
  }
  function clearsLane(model) {
    const read = laneRead(model);
    if (read.state === "available") return true;
    const note = {
      modelId: model.id,
      laneId: model.laneId ?? null,
      term: read.term,
      reason: read.reason
    };
    const bucket = read.state === "unavailable" ? excludedByLane : unknownLanes;
    if (!bucket.some((entry) => entry.modelId === model.id)) bucket.push(note);
    if (read.state === "unknown" && !holdOnUnknownAvailability) return true;
    if (!rejections.some((r) => r.modelId === model.id && r.stage === "lane-availability")) {
      rejections.push({
        modelId: model.id,
        stage: "lane-availability",
        reason: `${read.term}: ${read.reason}`,
        operand: { kind: "lane-availability", laneId: model.laneId ?? null, term: read.term, state: read.state }
      });
    }
    return false;
  }
  const laneEvidence = input.laneEvidence;
  const evidenceExcluded = [];
  const incumbentEvidence = evidenceStateFor(
    laneEvidence,
    config.models.find(
      (model) => model.id === resolveConfiguredModelId(descriptor.stickyModelId ?? "", config.models)
    )?.laneId ?? null
  );
  function clearsEvidence(model) {
    if (!laneEvidence) return true;
    const state = evidenceStateFor(laneEvidence, model.laneId ?? null);
    const record3 = laneEvidence.lanes.find((lane) => lane.laneId === model.laneId);
    const detail = record3?.reason ?? laneEvidence.unreadableReason ?? `lane ${model.laneId ?? "(none)"} has no recorded runs in the ${laneEvidence.windowHours}h window`;
    if (state === "proven-dead") {
      const note = {
        modelId: model.id,
        laneId: model.laneId ?? null,
        term: "evidence",
        reason: detail
      };
      if (!evidenceExcluded.some((entry) => entry.modelId === model.id)) evidenceExcluded.push(note);
      if (!rejections.some((r) => r.modelId === model.id && r.stage === "lane-evidence")) {
        rejections.push({
          modelId: model.id,
          stage: "lane-evidence",
          reason: `proven-dead [${record3?.rule ?? "unknown"}]: ${detail}`,
          operand: {
            kind: "lane-evidence",
            laneId: model.laneId ?? null,
            state: "proven-dead",
            rule: record3?.rule ?? null
          }
        });
      }
      return false;
    }
    if (costDownWouldAbandonProvenLane(incumbentEvidence, state)) {
      const note = {
        modelId: model.id,
        laneId: model.laneId ?? null,
        term: "evidence",
        reason: `${detail} \u2014 refusing to move off a proven-good lane onto an ${state} one`
      };
      if (!evidenceExcluded.some((entry) => entry.modelId === model.id)) evidenceExcluded.push(note);
      if (!rejections.some((r) => r.modelId === model.id && r.stage === "lane-evidence")) {
        rejections.push({
          modelId: model.id,
          stage: "lane-evidence",
          reason: `${state}: ${detail} \u2014 incumbent lane is proven-good`,
          operand: { kind: "lane-evidence", laneId: model.laneId ?? null, state, rule: null }
        });
      }
      return false;
    }
    return true;
  }
  const judgement = resolveTier(descriptor, config.models, config.defaultTier, {
    // An issue-override pin on a lane that will not serve falls through to the
    // tier label / agent floor, the same as for the pace hard stop. An UNKNOWN
    // never moves a pin: a blind instrument is not grounds to discard a
    // recorded human judgement.
    isLaneUnserviceable: (model) => paceActive && hardStopExcluded(ledger, model, now) || laneRead(model).state === "unavailable"
  });
  trace.push(`tier ${judgement.tier} via ${judgement.source} \u2014 ${judgement.detail}`);
  const wakeFloorConfig = config.wakeScopedFloor;
  const wakeReason = descriptor.wakeReason ?? null;
  const wakeFloorEligible = !!wakeFloorConfig?.enabled && !!wakeReason && wakeFloorConfig.wakeReasons.includes(wakeReason) && tierIndex(wakeFloorConfig.floorTier) < tierIndex(judgement.tier);
  const requiredTier = wakeFloorEligible ? wakeFloorConfig.floorTier : judgement.tier;
  if (wakeFloorEligible) {
    trace.push(
      `wake-scoped floor: wake reason "${wakeReason}" lowers the required tier from ${judgement.tier} to ${requiredTier} for this decision only \u2014 card tier unchanged, decision forced advisory`
    );
  }
  const base = {
    outcome: "no-eligible-model",
    modelId: null,
    judgement,
    effectiveTier: null,
    candidates: [],
    rejections,
    trace,
    advisory: !config.enforcementEnabled || wakeFloorEligible,
    heldReason: null,
    pacingApplied: false,
    shadowDiff: null,
    escalatedFromTier: null,
    // Live references: every early return below carries whatever the gate had
    // recorded by then, so a decision can never report an empty availability
    // record it did not actually observe.
    availability: {
      configured: Boolean(availability),
      unreadableReason: availability?.unreadableReason ?? null,
      excluded: excludedByLane,
      unknown: unknownLanes,
      selectedOnUnknownLane: false,
      evidenceExcluded,
      incumbentEvidence
    },
    wakeScopedTier: wakeFloorEligible ? requiredTier : null
  };
  const nowIso = new Date(now).toISOString();
  if (config.models.length === 0) {
    trace.push("no models configured for this company");
    return { ...base, outcome: "disabled" };
  }
  trace.push(`tier floor ${requiredTier}: no lower-capability model is eligible`);
  if (config.stickyWithinIssue && descriptor.stickyModelId) {
    const stickyModelId = resolveConfiguredModelId(descriptor.stickyModelId, config.models);
    const incumbent = config.models.find(
      (model) => model.id === stickyModelId && model.enabled
    );
    const incumbentUnserviceable = incumbent && paceActive && hardStopExcluded(ledger, incumbent, now);
    if (incumbent && tierIndex(incumbent.tier) < tierIndex(requiredTier)) {
      trace.push(
        `sticky ${incumbent.id} (${incumbent.tier}) declined: below the ${requiredTier} required tier`
      );
      rejections.push({
        modelId: incumbent.id,
        stage: "tier-floor",
        reason: `tier ${incumbent.tier} is below the ${requiredTier} required tier`,
        operand: { kind: "tier-floor", tier: incumbent.tier, requiredTier }
      });
    } else if (incumbent && isAdapterBlockedModel(incumbent.id, descriptor.agentAdapterType)) {
      trace.push(
        `sticky ${incumbent.id} declined: incompatible with the ${descriptor.agentAdapterType} adapter \u2014 re-selecting instead of wedging this issue on a refusing lane`
      );
      rejections.push({
        modelId: incumbent.id,
        stage: "adapter",
        reason: `${incumbent.id} is incompatible with the ${descriptor.agentAdapterType} adapter (Devin rejects the Claude Code system banner)`,
        operand: { kind: "adapter", modelId: incumbent.id, adapterType: descriptor.agentAdapterType }
      });
    } else if (incumbent && typeof descriptor.requiredContextTokens === "number" && incumbent.contextWindow < descriptor.requiredContextTokens) {
      trace.push(
        `sticky ${incumbent.id} declined: context window ${incumbent.contextWindow} < required ${descriptor.requiredContextTokens}`
      );
      rejections.push({
        modelId: incumbent.id,
        stage: "context-window",
        reason: `context window ${incumbent.contextWindow} < required ${descriptor.requiredContextTokens}`,
        operand: {
          kind: "context-window",
          contextWindow: incumbent.contextWindow,
          requiredContextTokens: descriptor.requiredContextTokens
        }
      });
    } else if (incumbent && incumbentUnserviceable) {
      trace.push(
        `sticky ${incumbent.id} declined: lane ${incumbent.laneId ?? "(none)"} is not serviceable \u2014 re-selecting instead of wedging this issue on a dead lane`
      );
      rejections.push({
        modelId: incumbent.id,
        stage: "lane-unserviceable",
        reason: `lane ${incumbent.laneId ?? "(none)"} is not serviceable`,
        operand: {
          kind: "lane-unserviceable",
          laneId: incumbent.laneId ?? null,
          verdict: laneVerdictFor(ledger, incumbent.laneId)?.state ?? null
        }
      });
    } else if (incumbent && !clearsEvidence(incumbent)) {
      trace.push(
        `sticky ${incumbent.id} declined: lane ${incumbent.laneId ?? "(none)"} evidence \u2014 ${evidenceExcluded.find((note) => note.modelId === incumbent.id)?.reason ?? "proven-dead"}`
      );
    } else if (incumbent && !clearsLane(incumbent)) {
      trace.push(
        `sticky ${incumbent.id} declined: lane ${incumbent.laneId ?? "(none)"} availability \u2014 ${excludedByLane.concat(unknownLanes).find((note) => note.modelId === incumbent.id)?.reason ?? "unavailable"}`
      );
    } else if (incumbent) {
      trace.push(
        `sticky: ${incumbent.id} is already running this issue \u2014 switching would reset the session and discard the prompt cache`
      );
      return { ...base, outcome: "selected", modelId: incumbent.id, effectiveTier: incumbent.tier };
    }
  }
  const required = new Set(descriptor.requiredCapabilities ?? []);
  if (required.size > 0) {
    trace.push(`hard capability gate: ${[...required].sort().join(", ")}`);
  }
  const cardLedger = input.cardLedger ?? {};
  const qualified = [];
  for (const model of config.models) {
    if (!model.enabled) {
      rejections.push({ modelId: model.id, stage: "disabled", reason: "disabled in the roster", operand: { kind: "disabled" } });
      continue;
    }
    if (isAdapterBlockedModel(model.id, descriptor.agentAdapterType)) {
      const adapterType = descriptor.agentAdapterType;
      rejections.push({
        modelId: model.id,
        stage: "adapter",
        reason: `${model.id} is incompatible with the ${adapterType} adapter (Devin rejects the Claude Code system banner)`,
        operand: { kind: "adapter", modelId: model.id, adapterType }
      });
      continue;
    }
    const missing = [...required].filter((capability) => !model.capabilities.includes(capability));
    if (missing.length > 0) {
      rejections.push({
        modelId: model.id,
        stage: "capability",
        reason: `missing ${missing.sort().join(", ")}`,
        operand: { kind: "capability", missing: missing.sort() }
      });
      continue;
    }
    if (tierIndex(model.tier) < tierIndex(requiredTier)) {
      rejections.push({
        modelId: model.id,
        stage: "tier-floor",
        reason: `tier ${model.tier} is below the ${requiredTier} required tier`,
        operand: { kind: "tier-floor", tier: model.tier, requiredTier }
      });
      continue;
    }
    const modelScore = config.modelScores?.[model.id];
    const score2 = tierScoreFor(modelScore, requiredTier);
    if (score2 && score2.capable === false) {
      const cappedBy = score2.cappedBy;
      rejections.push({
        modelId: model.id,
        stage: "capability-score",
        reason: cappedBy === void 0 ? `measured ${requiredTier} success rate (p=${score2.p}) is below the capability threshold` : `no proven ${requiredTier} evidence of its own, and it fails the easier ${cappedBy} tier (p=${modelScore?.tiers[cappedBy]?.p})`,
        operand: cappedBy === void 0 ? { kind: "capability-score", tier: requiredTier, p: score2.p } : { kind: "capability-score", tier: requiredTier, p: score2.p, cappedBy }
      });
      continue;
    }
    const zeroAccept = zeroAcceptEvidence(model.id, requiredTier, cardLedger, now);
    if (zeroAccept) {
      rejections.push({
        modelId: model.id,
        stage: "card-accept-rate",
        reason: `0 of ${zeroAccept.cardsResolved} mature ${requiredTier} cards were accepted (all reopened or rejected); evidence expires ${new Date(zeroAccept.expiresAtMs).toISOString()}`,
        operand: {
          kind: "card-accept-rate",
          tier: requiredTier,
          cardsResolved: zeroAccept.cardsResolved,
          cardsAccepted: zeroAccept.cardsAccepted
        }
      });
      continue;
    }
    if (typeof descriptor.requiredContextTokens === "number" && model.contextWindow < descriptor.requiredContextTokens) {
      rejections.push({
        modelId: model.id,
        stage: "context-window",
        reason: `context window ${model.contextWindow} < required ${descriptor.requiredContextTokens}`,
        operand: {
          kind: "context-window",
          contextWindow: model.contextWindow,
          requiredContextTokens: descriptor.requiredContextTokens
        }
      });
      continue;
    }
    if (paceActive && hardStopExcluded(ledger, model, now)) {
      rejections.push({
        modelId: model.id,
        stage: "lane-unserviceable",
        reason: `lane ${model.laneId ?? "(none)"} is not serviceable`,
        operand: {
          kind: "lane-unserviceable",
          laneId: model.laneId ?? null,
          verdict: laneVerdictFor(ledger, model.laneId)?.state ?? null
        }
      });
      continue;
    }
    if (!clearsLane(model)) continue;
    if (!clearsEvidence(model)) continue;
    if (paceActive && config.laneAvoidConfig && laneAvoidExcluded(ledger, model, config.laneAvoidConfig)) {
      rejections.push({
        modelId: model.id,
        stage: "lane-avoid",
        reason: `lane ${model.laneId ?? "(none)"} is at or above its avoid threshold and ahead of its window pace margin`,
        operand: { kind: "lane-avoid", laneId: model.laneId ?? null }
      });
      continue;
    }
    if (paceActive && laneOutageExcluded(config.laneOutageOverride ?? null, nowIso, model)) {
      rejections.push({
        modelId: model.id,
        stage: "lane-outage",
        reason: `lane ${model.laneId ?? "(none)"} is under an operator-declared outage`,
        operand: { kind: "lane-outage", laneId: model.laneId ?? null }
      });
      continue;
    }
    if (paceActive && config.laneRoom && model.laneId) {
      const room = config.laneRoom;
      const admitted = laneHasRoom({
        laneId: model.laneId,
        activePinsWeight: room.activePinsWeightByLane[model.laneId] ?? 0,
        ledger,
        capPerAccount: room.capPerAccount,
        fiveHourWindowName: room.fiveHourWindowName,
        zaiLaneId: room.zaiLaneId,
        zaiWeeklyWindowName: room.zaiWeeklyWindowName,
        zaiWeeklyDefaultMargin: room.zaiWeeklyDefaultMargin,
        zaiPaceOverrideMargin: room.zaiPaceOverrideMargin,
        nowMs: room.now
      });
      if (!admitted) {
        rejections.push({
          modelId: model.id,
          stage: "lane-no-room",
          reason: `lane ${model.laneId} has no room for a new active card right now`,
          operand: { kind: "lane-no-room", laneId: model.laneId }
        });
        continue;
      }
    }
    if (paceActive && requiredTier === "T1" && model.laneId === (config.opencodeGoLaneId ?? LANE_ID_OPENCODE_GO) && config.laneAvoidConfig && laneEffectiveUtilization(ledger, config.codexLaneId ?? LANE_ID_CODEX) < avoidThresholdFor(config.laneAvoidConfig, config.codexLaneId ?? LANE_ID_CODEX)) {
      rejections.push({
        modelId: model.id,
        stage: "lane-avoid",
        reason: "T1 stays off opencode-go while the codex lane still has room (Go fallback only)",
        operand: { kind: "lane-avoid", laneId: model.laneId ?? null }
      });
      continue;
    }
    const zaiLaneId = config.zaiLaneId ?? LANE_ID_ZAI;
    const codexLaneId = config.codexLaneId ?? LANE_ID_CODEX;
    if (paceActive && model.laneId === zaiLaneId && descriptor.agentName && ZAI_LONG_RUN_AGENTS.has(descriptor.agentName) && config.laneAvoidConfig && laneEffectiveUtilization(ledger, codexLaneId) < avoidThresholdFor(config.laneAvoidConfig, codexLaneId) && config.models.some((entry) => entry.laneId === codexLaneId && entry.enabled)) {
      rejections.push({
        modelId: model.id,
        stage: "lane-avoid",
        reason: `long-turn agent "${descriptor.agentName}" stays off zai while the codex lane still has room (Z.ai 1214 risk)`,
        operand: { kind: "lane-avoid", laneId: model.laneId ?? null }
      });
      continue;
    }
    qualified.push(model);
  }
  if (!availability) {
    trace.push("lane availability: no lane input supplied \u2014 the term is not configured and excluded nothing");
  } else if (excludedByLane.length > 0) {
    trace.push(
      `lane availability excluded ${excludedByLane.length} candidate(s): ` + excludedByLane.map((note) => `${note.modelId} [${note.term}] ${note.reason}`).join("; ")
    );
  }
  if (unknownLanes.length > 0) {
    trace.push(
      `lane availability UNKNOWN for ${unknownLanes.length} candidate(s): ` + unknownLanes.map((note) => `${note.modelId} [${note.term}] ${note.reason}`).join("; ")
    );
  }
  if (!laneEvidence) {
    trace.push("lane evidence: no run-outcome input supplied \u2014 the term is not configured and excluded nothing");
  } else {
    trace.push(
      `lane evidence over ${laneEvidence.windowHours}h` + (laneEvidence.unreadableReason ? ` UNREADABLE (${laneEvidence.unreadableReason}) \u2014 every lane is unproven` : `: ${laneEvidence.lanes.filter((lane) => lane.state === "proven-good").length} proven-good, ${laneEvidence.lanes.filter((lane) => lane.state === "proven-dead").length} proven-dead, ${laneEvidence.lanes.filter((lane) => lane.state === "unproven").length} unproven`) + `; incumbent lane is ${incumbentEvidence}`
    );
    if (evidenceExcluded.length > 0) {
      trace.push(
        `lane evidence excluded ${evidenceExcluded.length} candidate(s): ` + evidenceExcluded.map((note) => `${note.modelId} [${note.term}] ${note.reason}`).join("; ")
      );
    }
  }
  const adapterExcluded = rejections.filter((rejection) => rejection.stage === "adapter");
  if (adapterExcluded.length > 0) {
    trace.push(
      `adapter compatibility excluded ${adapterExcluded.length} candidate(s): ` + adapterExcluded.map((rejection) => `${rejection.modelId} [adapter]: ${rejection.reason}`).join("; ")
    );
  }
  if (qualified.length === 0) {
    const atOrAboveRequired = rejections.filter((rejection) => {
      const rejectedModel = config.models.find((entry) => entry.id === rejection.modelId);
      return rejectedModel ? tierIndex(rejectedModel.tier) >= tierIndex(requiredTier) : false;
    });
    const CAPACITY_STAGES = /* @__PURE__ */ new Set(["lane-unserviceable", "lane-availability", "lane-evidence"]);
    const unknownModelIds = new Set(unknownLanes.map((note) => note.modelId));
    if (atOrAboveRequired.length > 0 && atOrAboveRequired.every(
      (rejection) => rejection.stage === "lane-availability" && unknownModelIds.has(rejection.modelId)
    )) {
      const reason = `lane availability is UNKNOWN for every candidate at or above ${requiredTier} (${unknownLanes.map((note) => note.reason).join("; ")}) and selection.holdOnUnknownAvailability is on`;
      trace.push(`held at agent floor: ${reason}`);
      return { ...base, outcome: "held-at-floor", heldReason: reason };
    }
    const tierExhausted = atOrAboveRequired.length > 0 && atOrAboveRequired.every((rejection) => CAPACITY_STAGES.has(rejection.stage));
    if (tierExhausted) {
      trace.push(
        `tier exhausted: every candidate from ${requiredTier} through the T1 ceiling was excluded by a capacity gate (${atOrAboveRequired.length} rejection${atOrAboveRequired.length === 1 ? "" : "s"}) \u2014 nowhere left to escalate to`
      );
      return { ...base, outcome: "tier-exhausted", effectiveTier: requiredTier };
    }
    trace.push(`no model cleared the gates (${rejections.length} rejected)`);
    return base;
  }
  const regularModels = qualified.filter((model) => !model.fallbackOnly);
  const selectionPool = regularModels.length > 0 ? regularModels : qualified;
  if (regularModels.length === 0) {
    trace.push("no qualified regular candidate survived; considering fallback-only roster rows");
  }
  const profileVerdict = resolveProfile(requiredTier, profiles, now);
  trace.push(`volume profile: ${profileVerdict.reason}`);
  function costCandidates(models) {
    const candidates2 = [];
    for (const model of models) {
      const cost = costOf(model, requiredTier, profiles, config.models, signals, now);
      if (!cost) {
        rejections.push({
          modelId: model.id,
          stage: "no-profile",
          reason: `no volume profile for ${requiredTier}; cannot cost this candidate`,
          operand: { kind: "no-profile", tier: requiredTier }
        });
        continue;
      }
      candidates2.push({
        ...cost,
        tier: model.tier,
        releasedAt: model.releasedAt,
        fallbackOnly: model.fallbackOnly
      });
    }
    return candidates2;
  }
  let candidates = [];
  let landingTier = requiredTier;
  for (let rung = requiredTier; rung !== null; rung = tierAbove(rung)) {
    const atRung = selectionPool.filter((model) => model.tier === rung);
    if (atRung.length === 0) continue;
    const rungCandidates = costCandidates(atRung);
    if (rungCandidates.length > 0) {
      landingTier = rung;
      candidates = rungCandidates;
      break;
    }
  }
  if (candidates.length === 0) {
    trace.push("no candidate could be costed \u2014 refusing to choose on a guessed volume term");
    return { ...base, effectiveTier: requiredTier };
  }
  const escalatedFromTier = landingTier !== requiredTier ? requiredTier : null;
  if (escalatedFromTier) {
    trace.push(
      `escalated from ${requiredTier} to ${landingTier}: no candidate at ${requiredTier} survived the gates or could be costed`
    );
  }
  candidates.sort((left, right) => {
    if (left.expectedCostUsd !== right.expectedCostUsd) {
      return left.expectedCostUsd - right.expectedCostUsd;
    }
    const leftModel = config.models.find((model) => model.id === left.modelId);
    const rightModel = config.models.find((model) => model.id === right.modelId);
    if (leftModel && rightModel) {
      const familyOrder = compareSamePriceFamily(leftModel, rightModel);
      if (familyOrder !== 0) return familyOrder;
    }
    const releaseOrder = Date.parse(right.releasedAt) - Date.parse(left.releasedAt);
    if (releaseOrder !== 0) return releaseOrder;
    return left.modelId.localeCompare(right.modelId);
  });
  if (config.modelScores) {
    const pickResult = applyPickOrdering(
      candidates,
      config.models,
      ledger,
      config.modelScores,
      requiredTier,
      descriptor.issueId,
      config.allowExplore ?? true
    );
    candidates = pickResult.ordered;
    trace.push(
      pickResult.explored ? `explore: routing to unproven ${pickResult.exploreModelId} to gather ${requiredTier} evidence` : "pick ordering: free-must-be-proven + 20% cost-band least-utilized-lane tiebreak applied"
    );
  }
  let orderedCandidates = candidates;
  if (paceActive) {
    const paceOrdered = orderCandidatesByPace(candidates, config.models, ledger);
    const changed = paceOrdered.some((candidate, index) => candidate.modelId !== candidates[index]?.modelId);
    trace.push(
      changed ? `pace ordering (${pacingMode}) reorders to ${paceOrdered.map((c) => c.modelId).join(" > ")}` : `pace ordering (${pacingMode}) agrees with cost ordering`
    );
    const preferredId = preferredCandidateId(candidates, config.models, ledger);
    if (preferredId) {
      trace.push(`${preferredId}'s lane is trailing pace near its reset window close \u2014 preferred for new dispatch`);
    }
    if (paceEnforced) orderedCandidates = paceOrdered;
  }
  function pickWinnerIndex(ordered) {
    const overrideIndex = overrideModelId ? ordered.findIndex((candidate) => candidate.modelId === overrideModelId) : -1;
    if (overrideIndex >= 0) return overrideIndex;
    const allowedIndex = ordered.findIndex((candidate) => {
      const model = config.models.find((entry) => entry.id === candidate.modelId);
      return !model || slotAllowed(descriptor.issueId, ledger, model, slotFloorFraction);
    });
    return allowedIndex >= 0 ? allowedIndex : 0;
  }
  let paceWinnerIndex = 0;
  if (paceEnforced) {
    paceWinnerIndex = pickWinnerIndex(orderedCandidates);
    const overrideIndex = overrideModelId ? orderedCandidates.findIndex((candidate) => candidate.modelId === overrideModelId) : -1;
    if (overrideIndex >= 0 && overrideIndex === paceWinnerIndex) {
      if (overrideIndex !== 0) {
        trace.push(`operator override: routing to ${overrideModelId} ahead of pace ordering and slot throttling`);
      }
    } else if (paceWinnerIndex !== 0) {
      trace.push(
        `slot throttle: ${orderedCandidates[0].modelId} deferred (ahead-of-line, floor ${slotFloorFraction}); using ${orderedCandidates[paceWinnerIndex].modelId}`
      );
    }
  }
  const paceOnlyWinner = orderedCandidates[paceWinnerIndex];
  const pacingApplied = paceEnforced && paceOnlyWinner.modelId !== candidates[0].modelId;
  const earnInGuard = earnInGuardFor(descriptor);
  const earnInPick = freeEarnInWinner(
    orderedCandidates,
    config.models,
    ledger,
    config.modelScores,
    requiredTier,
    descriptor
  );
  if (earnInGuard.protected) {
    trace.push(`free-lane earn-in skipped: ${earnInGuard.reason}`);
  }
  const earnInOverridden = !!overrideModelId && orderedCandidates.some((candidate) => candidate.modelId === overrideModelId);
  if (earnInPick && !earnInOverridden && earnInPick.candidate.modelId !== orderedCandidates[0]?.modelId) {
    trace.push(
      `free-lane earn-in: routing to unproven ${earnInPick.candidate.modelId} on serviceable free lane ${earnInPick.laneId} (${earnInPick.observations} recorded ${requiredTier} runs, not yet proven) to gather ${requiredTier} evidence`
    );
    orderedCandidates = [
      earnInPick.candidate,
      ...orderedCandidates.filter((candidate) => candidate.modelId !== earnInPick.candidate.modelId)
    ];
  }
  const earnInWinner = earnInPick && !earnInOverridden ? earnInPick.candidate : null;
  const listPriceWinner = candidates[0];
  const shadowDiff = computeShadowDiff(descriptor.issueId, landingTier, candidates, listPriceWinner.modelId, cardLedger);
  const objective = config.objective ?? "list-price";
  let winner = earnInWinner ?? paceOnlyWinner;
  if (!earnInWinner && objective === "cost-per-accepted-card") {
    const objectiveOrdered = orderByObjective(orderedCandidates, objective, cardLedger);
    if (objectiveOrdered.length > 0) {
      winner = paceEnforced ? objectiveOrdered[pickWinnerIndex(objectiveOrdered)] : objectiveOrdered[0];
    }
  }
  const withCandidates = {
    ...base,
    candidates,
    effectiveTier: landingTier,
    pacingApplied,
    shadowDiff,
    escalatedFromTier
  };
  if (config.holdOnUntrustedProfile && !winner.profileTrusted) {
    const reason = `volume profile for ${requiredTier} is not trusted (${profileVerdict.reason})`;
    const floorModelId = resolveConfiguredModelId(descriptor.agentFloorModelId ?? null, config.models);
    const floorModel = floorModelId ? config.models.find((model) => model.id === floorModelId) : void 0;
    const floorLaneRead = floorModel ? laneRead(floorModel) : null;
    const floorLaneUnavailable = floorLaneRead !== null && floorLaneRead.state === "unavailable";
    if (floorModel && floorLaneRead !== null && floorLaneRead.state === "unavailable") {
      if (!excludedByLane.some((entry) => entry.modelId === floorModel.id)) {
        excludedByLane.push({
          modelId: floorModel.id,
          laneId: floorModel.laneId ?? null,
          term: floorLaneRead.term,
          reason: floorLaneRead.reason
        });
      }
    }
    const floorLaneDead = !!floorModel && (paceActive && (hardStopExcluded(ledger, floorModel, now) || !!config.laneAvoidConfig && laneAvoidExcluded(ledger, floorModel, config.laneAvoidConfig) || laneOutageExcluded(config.laneOutageOverride ?? null, nowIso, floorModel)) || floorLaneUnavailable);
    if (floorLaneDead) {
      trace.push(
        `held-at-floor declined: floor ${floorModel.id} lane ${floorModel.laneId ?? "(none)"} is not serviceable` + (floorLaneUnavailable ? ` [${floorLaneRead.term}: ${floorLaneRead.reason}]` : "") + ` \u2014 writing an explicit pin to ${winner.modelId} instead (${reason})`
      );
      return { ...withCandidates, outcome: "selected", modelId: winner.modelId };
    }
    trace.push(`held at agent floor: ${reason}`);
    return { ...withCandidates, outcome: "held-at-floor", heldReason: reason };
  }
  trace.push(
    `selected ${winner.modelId} at an expected $${winner.expectedCostUsd.toFixed(4)}/run (direct $${winner.runCostUsd.toFixed(4)} = in $${winner.inputCostUsd.toFixed(4)} + cache-read $${winner.cacheReadCostUsd.toFixed(4)} + out $${winner.outputCostUsd.toFixed(4)}; escalation risk $${winner.escalationRiskUsd.toFixed(4)}) \u2014 cheapest of ${candidates.length}; exact ties prefer newest releasedAt then stable model id${winner.fallbackOnly ? "; fallback-only path" : ""}`
  );
  if (!config.enforcementEnabled) {
    trace.push("advisory mode: enforcement is off, so this decision is recorded and not written");
  } else if (wakeFloorEligible) {
    trace.push(
      `advisory mode: wake-scoped floor decisions are never written, regardless of enforcement \u2014 the card's ${judgement.tier} tier is untouched`
    );
  }
  const winnerUnknown = unknownLanes.find((note) => note.modelId === winner.modelId);
  if (winnerUnknown) {
    trace.push(
      `availability UNKNOWN for the selected model: ${winnerUnknown.reason} \u2014 not treated as available; selection proceeded because selection.holdOnUnknownAvailability is off`
    );
  }
  return {
    ...withCandidates,
    outcome: "selected",
    modelId: winner.modelId,
    availability: { ...withCandidates.availability, selectedOnUnknownLane: Boolean(winnerUnknown) }
  };
}

// src/engine/ancillary.ts
var ANCILLARY_ENV_KEYS = ["ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"];
var ANTHROPIC_DEFAULT_PREFIX = "ANTHROPIC_DEFAULT_";
function remediationFor(_surface) {
  return "console only \u2014 adapterConfig is 403 to every agent, structurally; this plugin has no write path to it either";
}
function recommendAncillaryModel(input) {
  return selectModel({
    descriptor: { issueId: "__ancillary_t3__", labelNames: ["tier:T3"] },
    config: {
      ...input.config,
      // Always advisory: a company-wide ancillary recommendation is never
      // something this tool writes, regardless of `selection.mode`.
      enforcementEnabled: false,
      defaultTier: "T3",
      stickyWithinIssue: false,
      operatorOverrideModelId: null
    },
    profiles: input.profiles,
    signals: input.signals,
    now: input.now
  });
}
function envBindingModelId(binding) {
  if (typeof binding === "string") return { modelId: binding, unresolvable: false };
  if (binding && typeof binding === "object") {
    const record3 = binding;
    if (record3.type === "plain" && typeof record3.value === "string") {
      return { modelId: record3.value, unresolvable: false };
    }
    if (record3.type === "secret_ref" || record3.type === "user_secret_ref") {
      return { modelId: null, unresolvable: true };
    }
  }
  return { modelId: null, unresolvable: false };
}
function readAncillarySurfaces(agent) {
  const readings = [];
  const env = agent.adapterConfig && typeof agent.adapterConfig === "object" ? agent.adapterConfig.env : void 0;
  if (env && typeof env === "object") {
    const ancillaryKeys = new Set(ANCILLARY_ENV_KEYS);
    for (const key of Object.keys(env)) {
      if (!ancillaryKeys.has(key) && !key.startsWith(ANTHROPIC_DEFAULT_PREFIX)) continue;
      const { modelId, unresolvable } = envBindingModelId(env[key]);
      readings.push({ surface: key, currentModelId: modelId, unresolvable });
    }
  }
  return readings;
}
function ancillaryDriftForAgent(agent, recommendedModelId, models = []) {
  if (!recommendedModelId) return [];
  return readAncillarySurfaces(agent).filter((reading) => {
    if (reading.unresolvable || reading.currentModelId === null) return false;
    const configuredModelId = resolveConfiguredModelId(reading.currentModelId, models);
    return (configuredModelId ?? reading.currentModelId) !== recommendedModelId;
  }).map((reading) => ({
    ...reading,
    agentId: agent.id,
    agentName: agent.name,
    recommendedModelId,
    remediation: remediationFor(reading.surface)
  }));
}

// src/engine/context.ts
var CONTEXT_LIMIT_ENV_KEY = "CLAUDE_CODE_MAX_CONTEXT_TOKENS";
var MIN_STAMPED_CONTEXT_TOKENS = 25e4;
var PIN_PROVENANCE_ENV_KEY = "MODEL_SELECTION_PIN_PROVENANCE";
function readPinProvenance(env) {
  const entry = env?.[PIN_PROVENANCE_ENV_KEY];
  const raw = typeof entry === "string" ? entry : entry && typeof entry === "object" && entry.type === "plain" ? entry.value : void 0;
  if (typeof raw !== "string") return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record3 = parsed;
  if (typeof record3.decisionId !== "string" || !record3.decisionId) return null;
  if (record3.fallback !== true) return null;
  if (typeof record3.decidedAt !== "string" || !Number.isFinite(Date.parse(record3.decidedAt))) return null;
  const agentId = typeof record3.agentId === "string" ? record3.agentId : null;
  return { decisionId: record3.decisionId, agentId, fallback: true, decidedAt: record3.decidedAt };
}
function positiveInteger(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}
function estimateIssueContext(input) {
  const explicit = positiveInteger(input.explicitTokens);
  if (explicit !== null) return { tokens: explicit, source: "explicit" };
  const peak = positiveInteger(input.lastRunPeakTokens);
  if (peak !== null) return { tokens: peak, source: "last-run-peak" };
  if (input.history === "run-found" || input.history === "unavailable") {
    return {
      tokens: positiveInteger(input.fleetCeilingTokens),
      source: "fleet-ceiling-fallback"
    };
  }
  return { tokens: null, source: "none" };
}
var ANCILLARY_MODEL_ENV_KEYS = [
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL"
];
var PIN_LANE_MODEL_ENV_KEYS = [
  "PAPERCLIP_ASSIGNED_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL"
];
function cheapestHealthyModelIdForTier(input) {
  const candidates = input.models.filter(
    (model) => model.enabled && !model.fallbackOnly && model.tier === input.tier
  );
  const healthy = candidates.filter((model) => {
    if (input.pacingMode === "off") return true;
    if (hardStopExcluded(input.ledger, model)) return false;
    if (laneAvoidExcluded(input.ledger, model, input.laneAvoidConfig)) return false;
    if (laneOutageExcluded(input.laneOutageOverride, input.nowIso, model)) return false;
    const score2 = tierScoreFor(input.modelScores[model.id], input.tier);
    if (score2?.capable === false) return false;
    return true;
  });
  healthy.sort((left, right) => blendedListPrice(left) - blendedListPrice(right));
  return healthy[0]?.id ?? null;
}
var ALL_MODEL_ENV_KEYS = [
  ...PIN_LANE_MODEL_ENV_KEYS,
  ...ANCILLARY_MODEL_ENV_KEYS
];
function overrideEnvOnExcludedLane(input) {
  if (input.pacingMode === "off") return false;
  const env = input.existingOverrideEnv;
  if (!env) return false;
  for (const key of ALL_MODEL_ENV_KEYS) {
    const entry = env[key];
    if (entry === void 0 || isSecretBinding(entry)) continue;
    const raw = typeof entry === "string" ? entry : entry && typeof entry === "object" ? entry.value : void 0;
    if (typeof raw !== "string" || !raw) continue;
    const model = input.models.find((candidate) => candidate.id === raw);
    if (!model) continue;
    if (hardStopExcluded(input.ledger, model)) return true;
    if (laneAvoidExcluded(input.ledger, model, input.laneAvoidConfig)) return true;
    if (laneOutageExcluded(input.laneOutageOverride, input.nowIso, model)) return true;
  }
  return false;
}
function isSecretBinding(binding) {
  if (!binding || typeof binding !== "object") return false;
  const type = binding.type;
  return type === "secret_ref" || type === "user_secret_ref";
}
function secretBindingIdentity(binding) {
  if (!isSecretBinding(binding)) return null;
  const record3 = binding;
  const ref = record3.type === "secret_ref" ? record3.secretId : record3.key;
  return typeof ref === "string" && ref.length > 0 ? `${String(record3.type)}:${ref}` : null;
}
function staleOverrideSecretRefKeys(existingOverrideEnv, agentEnv) {
  if (!existingOverrideEnv || agentEnv === null || agentEnv === void 0) return [];
  const stale = [];
  for (const [key, binding] of Object.entries(existingOverrideEnv)) {
    const identity = secretBindingIdentity(binding);
    if (identity === null) continue;
    const record3 = binding;
    if (record3.type === "user_secret_ref" && (record3.required === false || record3.allowMissingOverride === true)) {
      continue;
    }
    if (identity !== secretBindingIdentity(agentEnv[key])) stale.push(key);
  }
  return stale.sort();
}
var PLUGIN_OWNED_ENV_KEYS = [CONTEXT_LIMIT_ENV_KEY];
function modelOverrideForContext(input) {
  const agentEnvKnown = input.agentEnv !== null && input.agentEnv !== void 0;
  const agentEnv = input.agentEnv ?? {};
  const overrideEnv = input.existingOverrideEnv ?? {};
  let carriedOverrideEnv;
  if (agentEnvKnown) {
    carriedOverrideEnv = {};
    for (const key of PLUGIN_OWNED_ENV_KEYS) {
      if (key in overrideEnv) carriedOverrideEnv[key] = overrideEnv[key];
    }
  } else {
    carriedOverrideEnv = overrideEnv;
  }
  const env = { ...agentEnv, ...carriedOverrideEnv };
  const agentEnvCap = positiveInteger(input.agentEnvContextTokens);
  const modelWindow = positiveInteger(input.model.contextWindow);
  const ratio = Number.isFinite(input.compactionRatio) && input.compactionRatio > 0 && input.compactionRatio < 1 ? input.compactionRatio : 0.75;
  if (agentEnvCap !== null && modelWindow !== null && modelWindow < agentEnvCap) {
    env[CONTEXT_LIMIT_ENV_KEY] = {
      type: "plain",
      value: String(
        Math.max(
          Math.floor(modelWindow * ratio),
          Math.min(modelWindow, MIN_STAMPED_CONTEXT_TOKENS)
        )
      )
    };
  } else {
    delete env[CONTEXT_LIMIT_ENV_KEY];
  }
  const ancillaryBlocked = isAdapterBlockedModel(input.model.id, input.agentAdapterType);
  if (!ancillaryBlocked) {
    for (const key of PIN_LANE_MODEL_ENV_KEYS) {
      if (!agentEnvKnown && !(key in overrideEnv)) continue;
      if (isSecretBinding(env[key])) continue;
      env[key] = { type: "plain", value: input.model.id };
    }
    const cheapPick = input.cheapModelId || input.model.id;
    const cheapId = isAdapterBlockedModel(cheapPick, input.agentAdapterType) ? input.model.id : cheapPick;
    for (const key of ANCILLARY_MODEL_ENV_KEYS) {
      if (!agentEnvKnown && !(key in overrideEnv)) continue;
      if (isSecretBinding(env[key])) continue;
      env[key] = { type: "plain", value: cheapId };
    }
  }
  delete env[PIN_PROVENANCE_ENV_KEY];
  if (input.provenance && (agentEnvKnown || Object.keys(env).length > 0)) {
    env[PIN_PROVENANCE_ENV_KEY] = { type: "plain", value: JSON.stringify(input.provenance) };
  }
  const mustWriteEnv = Object.keys(env).length > 0 || CONTEXT_LIMIT_ENV_KEY in agentEnv || CONTEXT_LIMIT_ENV_KEY in overrideEnv;
  const effortPin = effortPinForOverride(input);
  return {
    assigneeAdapterOverrides: {
      adapterConfig: {
        model: input.model.id,
        ...effortPin.writes,
        ...mustWriteEnv ? { env } : {}
      }
    }
  };
}
function effortPinForOverride(input) {
  return resolveEffortPin({
    adapterType: input.agentAdapterType,
    modelId: input.model.id,
    rosterEffort: input.model.effort,
    inheritedEffort: inheritedEffortFrom(input.agentAdapterType, input.agentAdapterConfig)
  });
}

// src/engine/cost-attribution.ts
var ANTHROPIC_PROVIDER = "anthropic";
var OMNIROUTE_PROVIDER_PREFIX3 = "cliproxy/";
var ANTHROPIC_MODEL_ID_RE = /^(?:anthropic\/)?claude(?:[-.][a-z0-9.-]*)?$/i;
function isAnthropicModelId(modelId) {
  const trimmed = modelId.trim();
  const bare = trimmed.toLowerCase().startsWith(OMNIROUTE_PROVIDER_PREFIX3) ? trimmed.slice(OMNIROUTE_PROVIDER_PREFIX3.length) : trimmed;
  return ANTHROPIC_MODEL_ID_RE.test(bare);
}
function classifyCostAttribution(modelId, recordedProvider) {
  const provider = (recordedProvider ?? "").trim().toLowerCase();
  if (!provider) {
    return { attributable: true, reason: "no provider recorded on the run" };
  }
  if (provider !== ANTHROPIC_PROVIDER) {
    return { attributable: true, reason: `run priced by ${provider}` };
  }
  if (isAnthropicModelId(modelId)) {
    return { attributable: true, reason: "anthropic-priced run on an anthropic model" };
  }
  return {
    attributable: false,
    reason: `run recorded provider=anthropic for non-anthropic model ${modelId}; cost priced against the wrong table (TOG-4022)`
  };
}

// src/engine/profiles.ts
function buildVolumeProfiles(rows, models, computedAt) {
  const tiersOf = /* @__PURE__ */ new Map();
  for (const model of models) {
    if (!model.enabled) continue;
    const tiers = tiersOf.get(model.id) ?? [];
    if (!tiers.includes(model.tier)) tiers.push(model.tier);
    tiersOf.set(model.id, tiers);
  }
  const buckets = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const configuredId = resolveConfiguredModelId(row.model, models);
    const tiers = configuredId ? tiersOf.get(configuredId) : void 0;
    if (!tiers || tiers.length !== 1) continue;
    const tier2 = tiers[0];
    const input = row.inputTokens ?? 0;
    const cache = row.cachedInputTokens ?? 0;
    const output = row.outputTokens ?? 0;
    if (input === 0 && cache === 0 && output === 0) continue;
    const bucket = buckets.get(tier2) ?? { n: 0, input: 0, cache: 0, output: 0 };
    bucket.n += 1;
    bucket.input += input;
    bucket.cache += cache;
    bucket.output += output;
    buckets.set(tier2, bucket);
  }
  return [...buckets.entries()].map(([tier2, bucket]) => ({
    tier: tier2,
    sampleCount: bucket.n,
    computedAt,
    avgInputTokens: bucket.input / bucket.n,
    avgCacheReadTokens: bucket.cache / bucket.n,
    avgOutputTokens: bucket.output / bucket.n
  }));
}
function buildQualitySignals(rows, computedAt) {
  return rows.map((row) => ({
    tier: row.tier,
    escalationRate: row.issues > 0 ? row.escalations / row.issues : 0,
    silentFailureCount: row.silentFailures,
    sampleCount: row.issues,
    computedAt
  }));
}

// src/engine/availability.ts
var MAX_AGE_MINUTES = 120;
var FUTURE_TOLERANCE_MS = 6e4;
function asRecord2(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function parseTs(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function bindingAllowance(windows, nowMs) {
  let binding = null;
  for (const window of windows) {
    if (window.role !== "allowance") continue;
    const utilization = finite(window.utilization);
    const weight = finite(window.allowance_weight);
    const reset = parseTs(window.resets_at);
    if (utilization === null || weight === null || reset === null) continue;
    const hoursToReset = Math.max((reset - nowMs) / 36e5, 1);
    const remaining = Math.max(0, 1 - utilization) * weight;
    const clearRate = remaining / hoursToReset;
    const name = typeof window.name === "string" ? window.name : "(unnamed)";
    if (!binding || clearRate < binding.clearRate || clearRate === binding.clearRate && reset < binding.reset) {
      binding = { remaining, name, clearRate, reset };
    }
  }
  return binding ? { remaining: binding.remaining, name: binding.name } : null;
}
function evaluateRecord(raw, observedAtMs, nowMs) {
  const key = typeof raw.account_key === "string" ? raw.account_key : "(unkeyed)";
  const ageMs = nowMs - observedAtMs;
  if (ageMs < -FUTURE_TOLERANCE_MS) {
    return { state: "unknown", term: "staleness", reason: `${key}: observation is in the future` };
  }
  const declared = finite(raw.stale_after_seconds);
  const cutoffMs = Math.min(
    MAX_AGE_MINUTES * 6e4,
    declared !== null && declared > 0 ? declared * 1e3 : Number.POSITIVE_INFINITY
  );
  if (ageMs > cutoffMs) {
    return {
      state: "unknown",
      term: "staleness",
      reason: `${key}: sample age ${Math.round(ageMs / 6e4)}min exceeds the ${Math.round(cutoffMs / 6e4)}min cutoff`
    };
  }
  const cooldown = asRecord2(raw.cooldown);
  if (cooldown) {
    const until = parseTs(cooldown.until);
    const why = typeof cooldown.reason === "string" ? `: ${cooldown.reason}` : "";
    if (until === null) {
      return {
        state: "unavailable",
        term: "cooldown",
        reason: `${key}: cooldown present with no readable \`until\`${why}`
      };
    }
    if (until > nowMs) {
      return {
        state: "unavailable",
        term: "cooldown",
        reason: `${key}: in cooldown until ${new Date(until).toISOString()}${why}`
      };
    }
  }
  const health = typeof raw.health === "string" ? raw.health : null;
  if (health === null) {
    return { state: "unknown", term: "staleness", reason: `${key}: no health field` };
  }
  const countsOnly = countsOnlyEvidence(raw);
  if (raw.exhausted === true && countsOnly) {
    return { state: "unavailable", term: "health", reason: `${key}: explicitly exhausted` };
  }
  if (health !== "healthy" && !(countsOnly && health === "unknown")) {
    const term = health === "cooldown" || health === "cooling_down" ? "cooldown" : "health";
    return { state: "unavailable", term, reason: `${key}: health ${health}` };
  }
  if (countsOnly) return { state: "available", term: null, reason: `${key}: counts-only serviceability; pace unknown` };
  const windows = Array.isArray(raw.windows) ? raw.windows.flatMap((w) => {
    const rec = asRecord2(w);
    return rec ? [rec] : [];
  }) : [];
  if (windows.length === 0) {
    return { state: "unknown", term: "staleness", reason: `${key}: no windows published` };
  }
  for (const window of windows) {
    const utilization = finite(window.utilization);
    if (utilization !== null && utilization >= 1) {
      const name = typeof window.name === "string" ? window.name : "(unnamed)";
      return {
        state: "unavailable",
        term: "quota",
        reason: `${key}: window ${name} at utilization ${utilization.toFixed(2)}`
      };
    }
  }
  const binding = bindingAllowance(windows, nowMs);
  if (!binding) {
    return { state: "unknown", term: "staleness", reason: `${key}: no readable allowance window` };
  }
  if (binding.remaining <= 0) {
    return {
      state: "unavailable",
      term: "quota",
      reason: `${key}: binding allowance ${binding.name} has no remaining allowance`
    };
  }
  return { state: "available", term: null, reason: `${key}: serviceable` };
}
function rollUp(laneId, verdicts, ageMinutes) {
  const serviceable2 = verdicts.filter((v) => v.state === "available");
  const unavailable = verdicts.filter((v) => v.state === "unavailable");
  const unknown = verdicts.filter((v) => v.state === "unknown");
  const base = {
    laneId,
    accountCount: verdicts.length,
    serviceableAccountCount: serviceable2.length,
    modelCooldowns: verdicts.flatMap((verdict) => verdict.modelCooldowns ?? []),
    ageMinutes
  };
  if (serviceable2.length > 0) {
    return {
      ...base,
      state: "available",
      term: null,
      reason: `${serviceable2.length}/${verdicts.length} accounts serviceable`
    };
  }
  if (unavailable.length > 0) {
    const order = ["cooldown", "quota", "health"];
    const term = order.find((t) => unavailable.some((v) => v.term === t)) ?? unavailable[0].term ?? "health";
    const reasons = unavailable.map((v) => v.reason).join("; ");
    return { ...base, state: "unavailable", term, reason: `no serviceable account \u2014 ${reasons}` };
  }
  return {
    ...base,
    state: "unknown",
    term: "staleness",
    reason: unknown.length > 0 ? unknown.map((v) => v.reason).join("; ") : "no records for this lane"
  };
}
function normalizeAvailability(raw, nowMs, options = {}) {
  const document = asRecord2(raw);
  if (!document) {
    return { lanes: [], unreadableReason: "availability document is not an object" };
  }
  const observedAtMs = parseTs(document.observedAt);
  if (observedAtMs === null) {
    return { lanes: [], unreadableReason: "availability document has no readable observedAt" };
  }
  const records = Array.isArray(document.records) ? document.records.flatMap((r) => {
    const rec = asRecord2(r);
    return rec ? [rec] : [];
  }) : [];
  if (records.length === 0) {
    return { lanes: [], unreadableReason: "availability document carried no records" };
  }
  const ageMinutes = (nowMs - observedAtMs) / 6e4;
  const laneIdOf = options.laneIdOf ?? ((rec) => typeof rec.provider === "string" ? rec.provider : null);
  const byLane = /* @__PURE__ */ new Map();
  for (const record3 of records) {
    const laneId = laneIdOf(record3);
    if (!laneId) continue;
    const verdicts = byLane.get(laneId) ?? [];
    const cooldowns = modelCooldowns(record3);
    const invalidCounts = record3.observationQuality === "counts-only" && !countsOnlyEvidence(record3);
    const verdict = cooldowns === null || invalidCounts ? { state: "unknown", term: "staleness", reason: "invalid counts-only or model cooldown telemetry" } : evaluateRecord(record3, observedAtMs, nowMs);
    if (verdict.state !== "unknown" && cooldowns) verdict.modelCooldowns = cooldowns;
    verdicts.push(verdict);
    byLane.set(laneId, verdicts);
  }
  const lanes = [...byLane.entries()].map(([laneId, verdicts]) => rollUp(laneId, verdicts, ageMinutes)).sort((left, right) => left.laneId.localeCompare(right.laneId));
  return { lanes, unreadableReason: null };
}

// src/engine/benchmark-data.ts
var FROZEN_BENCHMARK_ROWS = {
  "claude-fable-5-1": { terminalBenchV4Pass1: 0.52020202020202, mercorApex11Pass1: 0.6859999999999999, automationBenchAaGuardrailAdjusted: 0.5937591715646424, aaOmniscienceSignedIndex: 43.45 },
  "claude-haiku-4-5-20251001": { aaOmniscienceSignedIndex: -7.56666666666667 },
  "claude-opus-5": { terminalBenchV4Pass1: 0.48989898989899, mercorApex11Pass1: 0.6579999999999999, automationBenchAaGuardrailAdjusted: 0.565735557649325, aaOmniscienceSignedIndex: 37.0666666666667 },
  "claude-sonnet-5": { terminalBenchV4Pass1: 0.141414141414141, aaOmniscienceSignedIndex: 16.45 },
  "deepseek-v4-flash": { terminalBenchV4Pass1: 0.121212121212121, aaOmniscienceSignedIndex: -14.2833333333333 },
  "deepseek-v4-flash-free": { terminalBenchV4Pass1: 0.121212121212121, aaOmniscienceSignedIndex: -14.2833333333333 },
  "deepseek-v4-flash-vision-exp": { terminalBenchV4Pass1: 0.121212121212121, aaOmniscienceSignedIndex: -17.6333333333333 },
  "deepseek-v4-pro": { terminalBenchV4Pass1: 0.141414141414141, automationBenchAaGuardrailAdjusted: 0.5671165546344002, aaOmniscienceSignedIndex: 0.833333333333333 },
  "deepseek-v4.1-flash": { terminalBenchV4Pass1: 0.267676767676768, automationBenchAaGuardrailAdjusted: 0.6889097769674057, aaOmniscienceSignedIndex: -5.3 },
  "gemini-3-flash": { aaOmniscienceSignedIndex: -4.31666666666667 },
  "gemini-3.6-flash-high": { terminalBenchV4Pass1: 0.0707070707070707, mercorApex11Pass1: 0.469, aaOmniscienceSignedIndex: 22.1333333333333 },
  "gemini-3.7-flash-high": { terminalBenchV4Pass1: 0.136363636363636, mercorApex11Pass1: 0.6779999999999999, aaOmniscienceSignedIndex: 26.4833333333333 },
  "gemini-3.8-flash-high": { terminalBenchV4Pass1: 0.196969696969697, mercorApex11Pass1: 0.643, automationBenchAaGuardrailAdjusted: 0.5993009432118243, aaOmniscienceSignedIndex: 29.55 },
  "glm-5": { aaOmniscienceSignedIndex: 0.266666666666667 },
  "glm-5.1": { terminalBenchV4Pass1: 0.0202020202020202, aaOmniscienceSignedIndex: 0.85 },
  "glm-5.2": { terminalBenchV4Pass1: 0.0101010101010101, aaOmniscienceSignedIndex: 4.43333333333333 },
  "glm-5.3": { terminalBenchV4Pass1: 0.419191919191919, mercorApex11Pass1: 0.5660000000000001, automationBenchAaGuardrailAdjusted: 0.622028649962642, aaOmniscienceSignedIndex: 14.3 },
  "glm-5.3-flash": { terminalBenchV4Pass1: 0.328282828282828, mercorApex11Pass1: 0.528, automationBenchAaGuardrailAdjusted: 0.6036862782167782, aaOmniscienceSignedIndex: 7.46666666666667 },
  "gpt-5.5": { terminalBenchV4Pass1: 0.146464646464646, mercorApex11Pass1: 0.551, aaOmniscienceSignedIndex: 20.5166666666667 },
  "gpt-5.6-luna": { terminalBenchV4Pass1: 0.116161616161616, automationBenchAaGuardrailAdjusted: 0.5020861763756194, aaOmniscienceSignedIndex: -10.2833333333333 },
  "gpt-5.6-sol": { terminalBenchV4Pass1: 0.398989898989899, mercorApex11Pass1: 0.514, automationBenchAaGuardrailAdjusted: 0.6008114996276329, aaOmniscienceSignedIndex: 21.9666666666667 },
  "gpt-5.6-terra": { terminalBenchV4Pass1: 0.353535353535354, mercorApex11Pass1: 0.5820000000000001, automationBenchAaGuardrailAdjusted: 0.5964995802534495, aaOmniscienceSignedIndex: 0.05 },
  "gpt-oss-120b-medium": { terminalBenchV4Pass1: 0, automationBenchAaGuardrailAdjusted: 0.0019906990691605595, aaOmniscienceSignedIndex: -49.25 },
  "mimo-v2-omni": { aaOmniscienceSignedIndex: -20.1333333333333 },
  "mimo-v2-pro": { aaOmniscienceSignedIndex: 4.61666666666667 },
  "mimo-v2.5-pro": { terminalBenchV4Pass1: 0, aaOmniscienceSignedIndex: 3.25 },
  "minimax-m2.5": { aaOmniscienceSignedIndex: -38.8666666666667 },
  "minimax-m3": { terminalBenchV4Pass1: 0.0202020202020202, automationBenchAaGuardrailAdjusted: 0.21251257600749407, aaOmniscienceSignedIndex: 1.35 },
  "qwen3.6-plus": { aaOmniscienceSignedIndex: 0.883333333333333 },
  "qwen3.7-max": { terminalBenchV4Pass1: 0.0151515151515152, aaOmniscienceSignedIndex: 13.4833333333333 },
  "qwen3.8-max": { terminalBenchV4Pass1: 0.186868686868687, aaOmniscienceSignedIndex: 3.4 },
  "zai-openai/glm-5.3": { terminalBenchV4Pass1: 0.419191919191919, mercorApex11Pass1: 0.5660000000000001, automationBenchAaGuardrailAdjusted: 0.622028649962642, aaOmniscienceSignedIndex: 14.3 },
  "zai-openai/glm-5.3-flash": { terminalBenchV4Pass1: 0.328282828282828, mercorApex11Pass1: 0.528, automationBenchAaGuardrailAdjusted: 0.6036862782167782, aaOmniscienceSignedIndex: 7.46666666666667 },
  "zai/glm-5.3": { terminalBenchV4Pass1: 0.419191919191919, mercorApex11Pass1: 0.5660000000000001, automationBenchAaGuardrailAdjusted: 0.622028649962642, aaOmniscienceSignedIndex: 14.3 },
  "zai/glm-5.3-flash": { terminalBenchV4Pass1: 0.328282828282828, mercorApex11Pass1: 0.528, automationBenchAaGuardrailAdjusted: 0.6036862782167782, aaOmniscienceSignedIndex: 7.46666666666667 }
};

// src/engine/tier-policy-edit.ts
import { createHash as createHash2 } from "node:crypto";

// src/tier-policy-tool.ts
var TIER_POLICY_ACTIONS = ["add", "edit", "remove", "validate", "diff"];
var EDITABLE_TIER_FIELDS = [
  "name",
  "order",
  "entryRules",
  "allowedEfforts",
  "evidence",
  "fallbackOnly",
  "sTier",
  "legacy"
];
var TIER_POLICY_TOOL_DISPLAY_NAME = "Tier policy: add, edit, remove, validate, diff";
var TIER_POLICY_TOOL_DESCRIPTION = "Prepare a tier-policy change as data (TOG-11549 D4): add, edit (name, order, entry rules, efforts, evidence, fallbackOnly/sTier, legacy thresholds) or remove a tier, or validate/diff a candidate policy. add/edit/remove need expectedRevision (must equal the base revision) and a reason. Returns proposalOnly or rejected with issues, a diff keyed by tier id, the dry-run impact and an audit id. Prepare/validate/diff only: writes nothing and never changes routing; the base is the built-in active policy unless basePolicy is supplied.";
var TIER_POLICY_TOOL_PARAMETERS = {
  type: "object",
  required: ["action"],
  properties: {
    action: { type: "string", enum: [...TIER_POLICY_ACTIONS] },
    expectedRevision: { type: "integer", minimum: 1, description: "Compare-and-set: must equal the base policy revision." },
    reason: { type: "string", description: "Why the change is wanted; required for add/edit/remove." },
    dryRun: { type: "boolean", description: "Defaults to true. This build never persists either way." },
    tierId: { type: "string", description: "The tier to edit or remove." },
    tier: { type: "object", description: "add: the full tier definition." },
    patch: {
      type: "object",
      description: `edit: fields to change, any of ${EDITABLE_TIER_FIELDS.join(", ")}; legacy and evidence merge shallowly.`
    },
    policy: { type: "object", description: "validate/diff: a full candidate policy at the next revision." },
    basePolicy: { type: "object", description: "Optional base to edit instead of the built-in active policy." }
  }
};

// src/engine/tier-policy-edit.ts
var MUTATING_ACTIONS = /* @__PURE__ */ new Set(["add", "edit", "remove"]);
var MERGED_TIER_FIELDS = /* @__PURE__ */ new Set(["legacy", "evidence"]);
var ACTIVE_TIER_POLICY_SOURCE = "built-in:LEGACY_MODEL_SELECTION_V1";
var MAX_REASON_LENGTH = 2e3;
var PROPOSAL_ONLY_NOTE = "proposalOnly: nothing was written and routing is unchanged. Activation needs a persistence path proven to enforce expectedRevision against one authoritative revision (TOG-11549 D4).";
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function cloneJson(value) {
  try {
    const text2 = JSON.stringify(value);
    return text2 === void 0 ? void 0 : JSON.parse(text2);
  } catch {
    return void 0;
  }
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).filter((k) => value[k] !== void 0).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
function sha256(text2) {
  return createHash2("sha256").update(text2).digest("hex");
}
function shapeIssues(policy, at) {
  const issues = [];
  const push = (path, message) => issues.push({ path, code: "malformed-policy", message });
  if (!isPlainObject(policy)) {
    push(at, "policy must be an object");
    return issues;
  }
  if (!Array.isArray(policy.tiers)) push(`${at}.tiers`, "tiers must be an array");
  else policy.tiers.forEach((tier2, i) => issues.push(...tierShapeIssues(tier2, `${at}.tiers[${i}]`)));
  if (policy.taskClassTierRefs !== void 0 && !isPlainObject(policy.taskClassTierRefs)) {
    push(`${at}.taskClassTierRefs`, "taskClassTierRefs must be an object");
  }
  return issues;
}
function tierShapeIssues(tier2, at) {
  const issues = [];
  const push = (path, message) => issues.push({ path, code: "malformed-policy", message });
  if (!isPlainObject(tier2)) {
    push(at, "tier must be an object");
    return issues;
  }
  if (!isPlainObject(tier2.entryRules) || !Array.isArray(tier2.entryRules.all)) {
    push(`${at}.entryRules.all`, "entryRules.all must be an array");
  } else {
    tier2.entryRules.all.forEach((rule, r) => {
      if (!isPlainObject(rule)) push(`${at}.entryRules.all[${r}]`, "entry rule must be an object");
    });
  }
  if (!Array.isArray(tier2.allowedEfforts)) push(`${at}.allowedEfforts`, "allowedEfforts must be an array");
  if (!isPlainObject(tier2.evidence)) push(`${at}.evidence`, "evidence must be an object");
  if (!isPlainObject(tier2.legacy)) push(`${at}.legacy`, "legacy must be an object");
  return issues;
}
function tiersById(value) {
  if (!Array.isArray(value)) return null;
  const byId = /* @__PURE__ */ new Map();
  for (const tier2 of value) {
    const id = isPlainObject(tier2) ? tier2.id : void 0;
    if (typeof id !== "string" || byId.has(id)) return null;
    byId.set(id, tier2);
  }
  return byId;
}
function diffValues(path, before, after, out) {
  if (canonicalJson(before) === canonicalJson(after)) return;
  if (before === void 0 || after === void 0) {
    out.push({ path, change: before === void 0 ? "added" : "removed", before: before ?? null, after: after ?? null });
    return;
  }
  const beforeTiers = path === "tiers" ? tiersById(before) : null;
  const afterTiers = path === "tiers" ? tiersById(after) : null;
  if (beforeTiers && afterTiers) {
    const ids = [...beforeTiers.keys(), ...[...afterTiers.keys()].filter((id) => !beforeTiers.has(id))];
    for (const id of ids) diffValues(`tiers.${id}`, beforeTiers.get(id), afterTiers.get(id), out);
    return;
  }
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [.../* @__PURE__ */ new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) diffValues(path ? `${path}.${key}` : key, before[key], after[key], out);
    return;
  }
  out.push({ path, change: "changed", before, after });
}
function diffTierPolicies(before, after) {
  const out = [];
  diffValues("", before, after, out);
  return out;
}
function summarize2(compiled) {
  const enforcedRules = compiled.rules.filter((r) => r.status === "enforced").length;
  return {
    revision: compiled.revision,
    defaultTierId: compiled.defaultTierId,
    tierNames: { ...compiled.tierNames },
    scoreThresholds: { ...compiled.scoreThresholds },
    capabilityThresholds: { ...compiled.capabilityThresholds },
    enforcedRules,
    notEnforcedRules: compiled.rules.length - enforcedRules
  };
}
function compileSummary(policy) {
  if (!policy) return null;
  try {
    return summarize2(compileTierPolicy(policy));
  } catch {
    return null;
  }
}
function servingKey(summary2) {
  if (!summary2) return null;
  return canonicalJson({
    defaultTierId: summary2.defaultTierId,
    scoreThresholds: summary2.scoreThresholds,
    capabilityThresholds: summary2.capabilityThresholds
  });
}
function proposalIssues(proposed, base, active, baseIsActive) {
  const issues = validateTierPolicy(proposed, { previous: base });
  if (!baseIsActive) {
    const seen = new Set(issues.map((i) => `${i.path}|${i.code}`));
    for (const issue of validateTierPolicy(proposed, { previous: active })) {
      if (issue.code !== "s-tier-weakened" || seen.has(`${issue.path}|${issue.code}`)) continue;
      issues.push(issue);
    }
  }
  return issues;
}
function requiredTierId(value, issues) {
  if (typeof value === "string" && value.length > 0) return value;
  issues.push({ path: "tierId", code: "invalid-tier-id", message: "tierId must be a non-empty string" });
  return null;
}
function applyEdit(base, request, issues) {
  const tierId = requiredTierId(request.tierId, issues);
  if (!isPlainObject(request.patch) || Object.keys(request.patch).length === 0) {
    issues.push({ path: "patch", code: "invalid-patch", message: "patch must be a non-empty object" });
    return null;
  }
  const patch = request.patch;
  for (const key of Object.keys(patch)) {
    if (key === "id") {
      issues.push({ path: "patch.id", code: "immutable-id", message: "a tier id never changes; rename with patch.name" });
    } else if (!EDITABLE_TIER_FIELDS.includes(key)) {
      issues.push({ path: `patch.${key}`, code: "unknown-patch-key", message: `${key} is not an editable tier field` });
    }
  }
  if (tierId === null || issues.length > 0) return null;
  const index = base.tiers.findIndex((t) => t.id === tierId);
  if (index < 0) {
    issues.push({ path: "tierId", code: "unknown-tier", message: `no tier ${tierId} in base revision ${base.revision}` });
    return null;
  }
  const current = base.tiers[index];
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    next[key] = MERGED_TIER_FIELDS.has(key) && isPlainObject(value) && isPlainObject(current[key]) ? { ...current[key], ...value } : value;
  }
  return base.tiers.map((t, i) => i === index ? next : t);
}
function applyRemove(base, request, issues) {
  const tierId = requiredTierId(request.tierId, issues);
  if (tierId === null) return null;
  if (!base.tiers.some((t) => t.id === tierId)) {
    issues.push({ path: "tierId", code: "unknown-tier", message: `no tier ${tierId} in base revision ${base.revision}` });
    return null;
  }
  if (base.defaultTierId === tierId) {
    issues.push({ path: "tierId", code: "tier-is-default", message: `${tierId} is the default tier; move defaultTierId first` });
  }
  const referencing = Object.entries(base.taskClassTierRefs ?? {}).filter(([, ref]) => ref === tierId).map(([taskClass]) => taskClass).sort();
  if (referencing.length > 0) {
    issues.push({ path: "tierId", code: "tier-referenced", message: `${tierId} is referenced by task classes ${referencing.join(", ")}` });
  }
  return base.tiers.filter((t) => t.id !== tierId);
}
function prepareTierPolicyEdit(request, actor, active = LEGACY_MODEL_SELECTION_V1) {
  const issues = [];
  const action = TIER_POLICY_ACTIONS.includes(request.action) ? request.action : null;
  const dryRun = request.dryRun !== false;
  const reason = typeof request.reason === "string" && request.reason.trim().length > 0 ? request.reason.trim() : null;
  const baseIsActive = request.basePolicy === void 0;
  let base = null;
  if (baseIsActive) {
    base = cloneJson(active) ?? null;
  } else {
    const supplied = cloneJson(request.basePolicy);
    const malformed = shapeIssues(supplied, "basePolicy");
    if (malformed.length > 0) issues.push(...malformed);
    else base = supplied;
  }
  const baseRevision = base && Number.isInteger(base.revision) ? base.revision : null;
  if (action === null) {
    issues.push({ path: "action", code: "invalid-action", message: `action must be one of ${TIER_POLICY_ACTIONS.join(", ")}` });
  }
  if (action !== null && MUTATING_ACTIONS.has(action)) {
    if (reason === null) issues.push({ path: "reason", code: "missing-reason", message: `${action} needs a reason for the audit record` });
    else if (reason.length > MAX_REASON_LENGTH) {
      issues.push({ path: "reason", code: "invalid-reason", message: `reason is limited to ${MAX_REASON_LENGTH} characters` });
    }
    if (request.expectedRevision === void 0) {
      issues.push({ path: "expectedRevision", code: "missing-expected-revision", message: `${action} needs expectedRevision (compare-and-set)` });
    }
  }
  if (request.expectedRevision !== void 0 && baseRevision !== null && request.expectedRevision !== baseRevision) {
    issues.push({
      path: "expectedRevision",
      code: "revision-conflict",
      message: `expectedRevision ${String(request.expectedRevision)} does not match base revision ${baseRevision}`
    });
  }
  if (base !== null && baseRevision === null) {
    issues.push({ path: "basePolicy.revision", code: "invalid-revision", message: "base revision must be a positive integer" });
  }
  let proposed = null;
  if (issues.length === 0 && action !== null && base !== null && baseRevision !== null) {
    const nextRevision = baseRevision + 1;
    if (action === "add") {
      const tier2 = cloneJson(request.tier);
      if (!isPlainObject(tier2)) {
        issues.push({ path: "tier", code: "invalid-tier", message: "add needs a tier object" });
      } else {
        proposed = { ...base, revision: nextRevision, tiers: [...base.tiers, tier2] };
      }
    } else if (action === "edit") {
      const tiers = applyEdit(base, request, issues);
      if (tiers) proposed = { ...base, revision: nextRevision, tiers };
    } else if (action === "remove") {
      const tiers = applyRemove(base, request, issues);
      if (tiers) proposed = { ...base, revision: nextRevision, tiers };
    } else if (request.policy !== void 0) {
      const candidate = cloneJson(request.policy);
      const malformed = shapeIssues(candidate, "policy");
      if (malformed.length > 0) {
        issues.push(...malformed);
      } else {
        proposed = candidate;
        if (proposed.revision !== nextRevision) {
          issues.push({
            path: "policy.revision",
            code: "revision-not-next",
            message: `a replacement for revision ${baseRevision} must be revision ${nextRevision}`
          });
        }
      }
    } else if (action === "diff") {
      issues.push({ path: "policy", code: "missing-policy", message: "diff needs a candidate policy" });
    } else {
      issues.push(...validateTierPolicy(base));
    }
  }
  if (proposed !== null && base !== null) {
    const malformed = shapeIssues(proposed, "proposed");
    if (malformed.length > 0) {
      issues.push(...malformed);
    } else {
      try {
        issues.push(...proposalIssues(proposed, base, active, baseIsActive));
      } catch (cause) {
        issues.push({ path: "proposed", code: "malformed-policy", message: cause instanceof Error ? cause.message : String(cause) });
      }
    }
  }
  const ok = issues.length === 0;
  const before = compileSummary(base);
  const after = ok ? compileSummary(proposed) : null;
  const diff = proposed !== null && base !== null ? diffTierPolicies(base, proposed) : [];
  const auditId = `tpa_${sha256(
    canonicalJson({
      action,
      baseSource: baseIsActive ? ACTIVE_TIER_POLICY_SOURCE : "supplied",
      baseHash: base ? sha256(canonicalJson(base)) : null,
      proposedHash: proposed ? sha256(canonicalJson(proposed)) : null,
      reason,
      dryRun,
      agentId: actor.agentId,
      runId: actor.runId
    })
  ).slice(0, 24)}`;
  return {
    ok,
    ...ok ? {} : { error: issues[0].code },
    outcome: ok ? "proposalOnly" : "rejected",
    action,
    baseSource: baseIsActive ? ACTIVE_TIER_POLICY_SOURCE : "supplied",
    baseRevision,
    proposedRevision: proposed && Number.isInteger(proposed.revision) ? proposed.revision : null,
    dryRun,
    persisted: false,
    issues,
    diff,
    impact: {
      appliedToServing: false,
      wouldChangeServing: after !== null && before !== null && servingKey(after) !== servingKey(before),
      before,
      after
    },
    proposedPolicy: proposed,
    reason,
    auditId,
    note: PROPOSAL_ONLY_NOTE
  };
}
function renderTierPolicyEditResult(result) {
  const head = `${result.action ?? "invalid action"}: ${result.outcome} (base ${result.baseSource} revision ${result.baseRevision ?? "?"}${result.proposedRevision !== null ? ` -> proposed ${result.proposedRevision}` : ""}; audit ${result.auditId})`;
  const lines = [head];
  if (result.issues.length > 0) {
    lines.push(`${result.issues.length} issue(s):`);
    for (const issue of result.issues.slice(0, 20)) lines.push(`- ${issue.path}: ${issue.code}: ${issue.message}`);
    if (result.issues.length > 20) lines.push(`- ... ${result.issues.length - 20} more in data.issues`);
  }
  if (result.diff.length > 0) {
    lines.push(`${result.diff.length} change(s): ${result.diff.slice(0, 20).map((d) => d.path).join(", ")}`);
  }
  if (result.ok && result.proposedRevision !== null) {
    lines.push(result.impact.wouldChangeServing ? "Once activated this would change a tier cut, capability bar or the default tier." : "Once activated this would not change any tier cut, capability bar or the default tier.");
  }
  lines.push(result.note);
  return lines.join("\n");
}

// src/lane-capacity/availability-source.ts
var MAX_AGE_SECONDS = MAX_AGE_MINUTES * 60;
function parseMs(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
function remainingFreshnessSeconds(account, observation, laneObservedAtMs, stampMs) {
  const declared = account.staleAfterSeconds ?? observation.staleAfterSeconds;
  const cutoff = typeof declared === "number" && Number.isFinite(declared) && declared > 0 ? Math.min(declared, MAX_AGE_SECONDS) : MAX_AGE_SECONDS;
  const lagSeconds = Math.max(0, (stampMs - laneObservedAtMs) / 1e3);
  const remaining = Math.floor(cutoff - lagSeconds);
  return remaining > 0 ? remaining : null;
}
function windowsOf(account) {
  return account.windows.map((window) => ({
    name: window.name,
    role: window.role,
    utilization: window.utilization,
    // `bindingAllowance` needs a weight on the allowance window; the account's
    // own weight is the contract's fallback when the window does not report one.
    allowance_weight: window.allowanceWeight ?? account.weight,
    resets_at: window.resetsAt
  }));
}
function publishedRecordFor(rawRecords, accountKey2) {
  if (!rawRecords) return null;
  for (const raw of rawRecords) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record3 = raw;
    if (record3.account_key === accountKey2) return record3;
  }
  return null;
}
function healthOf(published, account) {
  if (published && typeof published.health === "string" && published.health.trim()) {
    return published.health;
  }
  return account.health === "unknown" ? null : account.health;
}
function availabilityDocumentFrom(input) {
  const stampMs = parseMs(input.observedAt);
  const records = [];
  if (stampMs === null) return { observedAt: input.observedAt, records };
  for (const result of input.results) {
    const observation = result.observation;
    if (!observation || observation.error !== null) continue;
    const laneObservedAtMs = parseMs(observation.observedAt);
    if (laneObservedAtMs === null) continue;
    if (observation.accounts.some((account) => account.countsOnly) && laneObservedAtMs - stampMs > 6e4) continue;
    for (const account of observation.accounts) {
      const remaining = remainingFreshnessSeconds(account, observation, laneObservedAtMs, stampMs);
      if (remaining === null) continue;
      const published = publishedRecordFor(result.rawRecords, account.accountKey);
      const cooldown = published?.cooldown;
      const health = healthOf(published, account);
      records.push({
        // The lane id, not the document's own `provider`: `ModelEntry.laneId`
        // is what the reader matches on, and a lane may poll a publisher whose
        // provider string differs from the lane it is configured as.
        provider: result.laneId,
        account_key: account.accountKey,
        stale_after_seconds: remaining,
        ...account.countsOnly ? {
          observationQuality: "counts-only",
          requests_today: account.countsOnly.requestsToday,
          requests_lifetime: account.countsOnly.requestsLifetime,
          governing_window: "daily",
          window_seconds: { daily: account.countsOnly.dailySeconds },
          day_resets_at: account.countsOnly.dayResetsAt,
          health: account.health
        } : {
          windows: windowsOf(account),
          ...health === null ? {} : { health }
        },
        ...account.modelCooldowns ? { model_cooldowns: account.modelCooldowns } : {},
        ...cooldown && typeof cooldown === "object" && !Array.isArray(cooldown) ? { cooldown } : {}
      });
    }
  }
  return { observedAt: input.observedAt, records };
}

// src/lane-capacity/url-policy.ts
function parseIpv4(hostname) {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const bytes = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}
function parseIpv6(hostname) {
  const input = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!input.includes(":") || input.includes("%") || input.split("::").length > 2) return null;
  const parseSide = (side) => {
    if (!side) return [];
    const parts = side.split(":");
    const output = [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (part.includes(".")) {
        if (index !== parts.length - 1) return null;
        const ipv4 = parseIpv4(part);
        if (!ipv4) return null;
        output.push(ipv4[0] << 8 | ipv4[1], ipv4[2] << 8 | ipv4[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
        output.push(Number.parseInt(part, 16));
      }
    }
    return output;
  };
  const halves = input.split("::");
  const left = parseSide(halves[0] ?? "");
  const right = parseSide(halves[1] ?? "");
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  if (left.length + right.length >= 8) return null;
  return [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
}
function isReservedIpv4(bytes) {
  const [a, b, c] = bytes;
  return a === 0 || a === 10 || a === 100 && b >= 64 && b <= 127 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 0 && c === 0 || a === 192 && b === 0 && c === 2 || a === 192 && b === 88 && c === 99 || a === 192 && b === 168 || a === 198 && (b === 18 || b === 19) || a === 198 && b === 51 && c === 100 || a === 203 && b === 0 && c === 113 || a >= 224;
}
function isReservedIpv6(words) {
  const allZero = words.every((word) => word === 0);
  const loopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
  const ipv4Mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 65535;
  if (ipv4Mapped) {
    return isReservedIpv4([
      words[6] >> 8,
      words[6] & 255,
      words[7] >> 8,
      words[7] & 255
    ]);
  }
  return allZero || loopback || (words[0] & 65024) === 64512 || (words[0] & 65472) === 65152 || (words[0] & 65280) === 65280 || words[0] === 100 && words[1] === 65435 && words[2] === 0 && words[3] === 0 && words[4] === 0 && words[5] === 0 || words[0] === 100 && words[1] === 65435 && words[2] === 1 || words[0] === 256 && words.slice(1, 4).every((word) => word === 0) || words[0] === 8193 && words[1] === 0 || words[0] === 8193 && words[1] === 2 || words[0] === 8193 && (words[1] & 65520) === 16 || words[0] === 8193 && (words[1] & 65520) === 32 || words[0] === 8193 && words[1] === 3512 || words[0] === 8194 || words[0] === 16383 && (words[1] & 61440) === 0;
}
function isReservedLiteralHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const ipv4 = parseIpv4(host);
  if (ipv4) return isReservedIpv4(ipv4);
  const ipv6 = parseIpv6(host);
  return ipv6 ? isReservedIpv6(ipv6) : false;
}

// src/lane-capacity/poll.ts
function verdictFor(document, lane, policy, asOf) {
  try {
    const observation = normalizeLaneDocument({ document, definition: lane });
    return { verdict: evaluateLanePace({ observation, asOf, policy }), observation };
  } catch {
    return null;
  }
}
async function pollOne(source, http, now) {
  const fetchedAt = now();
  const fail = (error) => ({ laneId: source.laneId, fetchedAt, verdict: null, observation: null, error });
  let parsed;
  try {
    parsed = new URL(source.statusUrl);
  } catch {
    return fail("lane-url-rejected");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || isReservedLiteralHost(parsed.hostname)) {
    return fail("lane-url-rejected");
  }
  let response;
  try {
    let timer;
    response = await Promise.race([
      http.fetch(source.statusUrl, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "identity",
          ...source.apiKey ? { "X-Api-Key": source.apiKey } : {}
        },
        redirect: "manual"
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("lane-request-timeout")), source.requestTimeoutMs);
      })
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  } catch {
    return fail("lane-request-failed");
  }
  if (response.redirected || response.status >= 300 && response.status < 400) {
    return fail("lane-redirect-refused");
  }
  if (response.status === 401 || response.status === 403) {
    return fail("lane-authentication-failed");
  }
  if (response.status < 200 || response.status >= 300) {
    return fail("lane-http-failed");
  }
  const mediaType = response.headers.get("content-type")?.toLowerCase().split(";", 1)[0]?.trim();
  if (!mediaType?.endsWith("/json") && !mediaType?.endsWith("+json")) {
    return fail("lane-unexpected-media-type");
  }
  let text2;
  try {
    text2 = await response.text();
  } catch {
    return fail("lane-request-failed");
  }
  if (new TextEncoder().encode(text2).byteLength > source.maxResponseBytes) {
    return fail("lane-response-too-large");
  }
  let document;
  try {
    document = JSON.parse(text2);
  } catch {
    return fail("lane-invalid-json");
  }
  if (document === null || typeof document !== "object") {
    return fail("lane-invalid-json");
  }
  const evaluated = verdictFor(document, source.lane, source.policy, fetchedAt);
  const rawRecords = document.records;
  return {
    laneId: source.laneId,
    fetchedAt,
    verdict: evaluated?.verdict ?? null,
    observation: evaluated?.observation ?? null,
    ...Array.isArray(rawRecords) ? { rawRecords } : {},
    error: null
  };
}
async function pollLanes(input) {
  return Promise.all(
    input.sources.map(
      (source) => pollOne(source, input.http, input.now).catch(
        () => ({ laneId: source.laneId, fetchedAt: input.now(), verdict: null, observation: null, error: "lane-poll-failed" })
      )
    )
  );
}

// src/lane-capacity/run-failure.ts
var LANE_EXHAUSTION_PHRASES = [
  /all credentials for model\s+\S+\s+are cooling down/i,
  /all credentials .{0,40}cooling down/i,
  /usage[_ ]limit[_ ]reached/i,
  /all upstream accounts .{0,40}(exhausted|unavailable|cooling)/i,
  /weekly (quota|limit) (exhausted|reached)/i,
  // Bounded rather than `.*`: verified identical on the 14-day corpus (56 of
  // 2,193 either way, zero disagreements), and a bound keeps a future
  // multi-sentence error from matching across an unrelated clause.
  /no healthy managed .{0,60}capacity remains/i,
  /subscription( is)? required/i
];
var MODEL_IN_COOLDOWN_RE = /all credentials for model\s+([^\s,)]+)\s+are cooling down/i;
function laneExhaustionFromRunFailure(input) {
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
    modelFromErrorText: fromText !== null
  };
}
function mergeLaneOutage(existing, addition, nowIso) {
  const live = existing && existing.until > nowIso ? existing : null;
  const lanes = [.../* @__PURE__ */ new Set([...live?.lanes ?? [], ...addition.lanes])];
  const models = [.../* @__PURE__ */ new Set([...live?.models ?? [], ...addition.models])];
  const until = live && live.until > addition.until ? live.until : addition.until;
  const reason = live?.reason ? `${live.reason}; ${addition.reason ?? ""}`.replace(/; $/, "") : addition.reason;
  return { lanes, models, until, ...reason ? { reason } : {} };
}
var AUTO_QUARANTINE_SECONDS = 15 * 60;
function autoQuarantineFor(verdict, nowMs, ttlSeconds = AUTO_QUARANTINE_SECONDS) {
  return {
    lanes: [verdict.laneId],
    // The lane is what ran out, not the individual model — every model on the
    // lane shares the same exhausted credentials. Listing only the lane keeps
    // the record honest and lets a lane with several models clear in one go.
    models: [],
    until: new Date(nowMs + ttlSeconds * 1e3).toISOString(),
    reason: `auto: run rejected on ${verdict.laneId} (${verdict.modelId}) with a lane-capacity error`
  };
}

// src/shadow-emit.ts
var SHADOW_SCHEMA_VERSION = "tog2138-decision-v1";
function laneStateLabel(verdict) {
  if (!verdict) return "unavailable";
  if (verdict.state === "exhausted") return "exhausted";
  if (verdict.serviceable === false) return "unavailable";
  if (verdict.state === "ahead") return "degraded";
  if (verdict.serviceable === true) return "available";
  return "unavailable";
}
function namedWindowUtilization(verdict, windowName) {
  const utilizations = (verdict?.accounts ?? []).flatMap((account) => {
    const window = account.windows?.find((entry) => entry.name === windowName);
    return typeof window?.utilization === "number" ? [window.utilization] : [];
  });
  return utilizations.length > 0 ? Math.max(...utilizations) : null;
}
function desiredAccountPriority(account) {
  return account.state === "push" ? 100 : 0;
}
function accountSnapshots(verdict) {
  const accounts = verdict?.accounts ?? [];
  const reportedShare = accounts.some((account) => account.recommendedShare != null);
  const fallbackDenominator = reportedShare ? 0 : accounts.reduce(
    (sum, account) => account.serviceable && account.clearRate != null ? sum + Math.max(0, account.clearRate) : sum,
    0
  );
  return accounts.map((account) => {
    const priority = desiredAccountPriority(account);
    const share = !account.serviceable ? 0 : account.recommendedShare ?? (account.clearRate != null && fallbackDenominator > 0 ? Math.max(0, account.clearRate) / fallbackDenominator : 0);
    const desiredWeight = share <= 0 ? 0 : Math.max(1, Math.min(1e6, Math.round(share * 1e6)));
    return {
      accountKey: account.accountKey,
      authKey: account.authKey ?? null,
      plan: account.plan ?? null,
      health: account.health,
      serviceable: account.serviceable,
      weight: account.weight,
      weightSource: account.weightSource,
      governingWindow: account.governingWindow,
      governingResetAt: account.governingResetAt,
      bindingWindow: account.bindingWindow ?? account.governingWindow,
      bindingResetAt: account.bindingResetAt ?? account.governingResetAt,
      normalizedRemaining: account.normalizedRemaining ?? null,
      utilization: account.score?.utilization ?? null,
      elapsedTarget: account.score?.elapsed ?? null,
      targetBurnRate: account.targetBurnRate ?? account.clearRate ?? null,
      observedBurnRate: account.observedBurnRate ?? account.recentBurnUnitsPerHour ?? null,
      deficit: account.deficit ?? account.paceDebt ?? null,
      recommendedShare: share,
      paceDebt: account.paceDebt ?? null,
      clearRate: account.clearRate ?? null,
      state: account.state,
      desiredPriority: account.serviceable ? priority : 0,
      desiredWeight,
      // The collector contract does not yet carry the auth that served this
      // issue. Keep the field explicit and null rather than guessing from the
      // routing weights.
      servedAuth: null
    };
  });
}
function buildLaneSnapshot(models, ledger, slotFloorFraction, windowNames, nowIso) {
  const laneIds = /* @__PURE__ */ new Set();
  for (const model of models) {
    if (model.laneId) laneIds.add(model.laneId);
  }
  const lanes = {};
  const laneFetchErrors = [];
  let sawAnyLane = false;
  let allFreshAndClean = true;
  let maxAgeSeconds = 0;
  for (const laneId of laneIds) {
    sawAnyLane = true;
    const entry = ledger[laneId];
    if (!entry) {
      allFreshAndClean = false;
      lanes[laneId] = { weekly: null, fiveHour: null, state: "unavailable", paceDeviation: 0, targetBurnRate: null, observedBurnRate: null, deficit: null, accounts: [] };
      continue;
    }
    if (entry.error) {
      laneFetchErrors.push(laneId);
      allFreshAndClean = false;
    }
    const ageSeconds = (Date.parse(nowIso) - Date.parse(entry.fetchedAt)) / 1e3;
    if (Number.isFinite(ageSeconds)) maxAgeSeconds = Math.max(maxAgeSeconds, ageSeconds);
    const verdict = entry.verdict;
    if (!verdict) allFreshAndClean = false;
    const model = models.find((candidate) => candidate.laneId === laneId);
    lanes[laneId] = {
      // Each column reports ITS OWN named window, read off the per-account
      // window verdicts. These were both `verdict.score.utilization` — one
      // governing-window number written into both columns, which measured
      // identical in 25,000/25,000 lane observations and put a governing-window
      // reading on the quota page under a `fiveHour` label. A mislabelled
      // number is worse than a missing one: it reads as a measurement. `null`
      // when this lane reports no such window (see `namedWindowUtilization`).
      weekly: namedWindowUtilization(verdict, windowNames.weekly),
      fiveHour: namedWindowUtilization(verdict, windowNames.fiveHour),
      state: laneStateLabel(verdict),
      paceDeviation: verdict?.score?.deviation ?? 0,
      targetBurnRate: verdict?.targetBurnRate ?? null,
      observedBurnRate: verdict?.observedBurnRate ?? null,
      deficit: verdict?.deficit ?? null,
      accounts: accountSnapshots(verdict),
      ...model ? { slotFactor: slotFactorFor(ledger, model, slotFloorFraction) } : {}
    };
  }
  return {
    ageSeconds: Math.round(Math.max(0, maxAgeSeconds)),
    quality: !sawAnyLane ? "unknown" : allFreshAndClean ? "live" : "cached",
    laneFetchErrors,
    lanes
  };
}
function buildCandidates(decision, models) {
  return decision.candidates.map((candidate) => {
    const model = models.find((entry) => entry.id === candidate.modelId);
    return {
      model: candidate.modelId,
      lane: model?.laneId ?? "unknown",
      tier: candidate.tier,
      // Every rejection stage (capability/tier-floor/context-window/disabled/
      // lane-unserviceable) already removed non-qualifying models before
      // `select.ts` ever costs a candidate — everything reaching
      // `decision.candidates` is capable and usable at this snapshot.
      capable: true,
      usable: true,
      // This engine has no unproven/exploration-slot concept (unlike the
      // reference dispatcher's 10% EXPLORE lane for unproven T2/T3
      // candidates) — TOG-2137 slices 2-5 do not add one, so every candidate
      // is reported proven rather than guessing at an unmodeled distinction.
      proven: true,
      // Dollars for one run at the judged tier's measured volume — the number
      // this engine actually orders on (`expectedCostUsd`), not a $/Mtok rate.
      // The reference dispatcher's "blended $/M" is a per-token price; this
      // plugin's cost term is volume-aware (ADR-0002/cost.ts) and has no
      // single per-token figure to report instead.
      blended: Number(candidate.expectedCostUsd.toFixed(6))
    };
  });
}
function boundPickWhy(trace) {
  const full = trace.join("; ");
  if (full.length <= SHADOW_PICK_WHY_MAX_CHARS) return full;
  const cut = full.slice(0, SHADOW_PICK_WHY_MAX_CHARS);
  return `${cut}...[truncated ${full.length - SHADOW_PICK_WHY_MAX_CHARS} chars]`;
}
function buildDecisionRecord(input, writer) {
  const { decision, descriptor } = input;
  const tier2 = decision.effectiveTier ?? decision.judgement.tier;
  const stickyKept = decision.outcome === "selected" && descriptor.pinnedModelId != null && decision.modelId === descriptor.pinnedModelId && decision.trace.some((line) => line.startsWith("sticky:"));
  return {
    schema: SHADOW_SCHEMA_VERSION,
    writer,
    issueId: input.issueId,
    issueIdentifier: input.issueIdentifier,
    ts: input.nowIso,
    // Best-effort, not an independently-verified trigger classification — the
    // harness re-derives its own classes from stateFingerprint/laneSnapshot
    // rather than trusting a writer's self-tagged field.
    trigger: input.hasOverride ? "repin" : "new-card",
    tier: tier2,
    pickedModel: decision.modelId,
    keptPin: stickyKept ? descriptor.pinnedModelId : null,
    stateFingerprint: {
      status: input.status,
      hadOverride: input.hasOverride,
      hadRunningRun: !input.isIdle,
      pinOperator: input.hasOperatorPin
    },
    laneSnapshot: buildLaneSnapshot(input.models, input.laneLedger, input.slotFloorFraction, input.windowNames, input.nowIso),
    candidates: buildCandidates(decision, input.models),
    // TOG-3211: one entry per rejected candidate, naming the gate that
    // rejected it and that gate's operand — `pickWhy`/`trace` only summarise
    // the outcome ("no model cleared the gates (112 rejected)"), which was
    // not reconstructable after the fact once the roster grew past what a
    // human could enumerate by hand. Capped, with the excess counted rather
    // than silently dropped, so a truncated list never reads as complete.
    explanations: decision.rejections.slice(0, SHADOW_EXPLANATIONS_CAP).map((rejection) => ({
      modelId: rejection.modelId,
      gate: rejection.stage,
      operand: rejection.operand
    })),
    explanationsTruncated: Math.max(0, decision.rejections.length - SHADOW_EXPLANATIONS_CAP),
    operatorOverride: input.operatorOverride ? { id: input.operatorOverride.modelId, expiresAt: input.operatorOverride.expiresAt } : null,
    pickWhy: boundPickWhy(decision.trace)
  };
}
function buildShadowRecord(input) {
  return buildDecisionRecord(input, "plugin-shadow");
}
function buildHostRecord(input) {
  return buildDecisionRecord(input, "host");
}

// src/sql.ts
var REFRESH_SCORE_RUNS_SQL = `select usage_json->>'model' as model,
       status as status,
       coalesce(context_snapshot->>'issueId','') as issue_id,
       coalesce(error_code,'') as error_code,
       left(coalesce(error,''),200) as error,
       coalesce(usage_json->>'costUsd','') as cost_usd,
       -- TOG-4022: see REFRESH_SCORE_CLOSING_RUNS_SQL. Same guard applies to
       -- the score rows' okCost sample.
       coalesce(usage_json->>'provider','') as provider,
       extract(epoch from (finished_at - started_at))/60.0 as mins,
       extract(epoch from (now() - created_at))/86400.0 as age_days
  from heartbeat_runs
 where company_id = $1
   and created_at > now() - ($2 || ' days')::interval
   and usage_json ? 'model'
   and status in ('succeeded','failed','timed_out')
   and usage_json->>'model' not in ('unknown','auto/best-coding')
   and finished_at is not null`;
var LAST_RUN_CONTEXT_USAGE_SQL = `select id, agent_id, log_store, log_ref,
       log_bytes, log_sha256, log_compressed
  from ((select id::text, agent_id::text, log_store, log_ref,
                log_bytes, log_sha256, log_compressed, created_at
           from heartbeat_runs
          where company_id = $1
            and context_snapshot->>'issueId' = $2
            and finished_at is not null
          order by created_at desc
          limit 1)
        union all
        (select id::text, agent_id::text, log_store, log_ref,
                log_bytes, log_sha256, log_compressed, created_at
           from heartbeat_runs
          where company_id = $1
            and context_snapshot->>'taskId' = $2
            and context_snapshot->>'issueId' is null
            and finished_at is not null
          order by created_at desc
          limit 1)) matches
 order by created_at desc
 limit 1`;
var CREATION_PIN_LIVE_RUNS_SQL = `select status as status,
       started_at as started_at
  from ((select status as status,
                started_at as started_at,
                created_at as created_at
           from heartbeat_runs
          where company_id = $1
            and status in ('queued', 'running')
            and context_snapshot->>'issueId' = $2
          order by created_at desc
          limit 5)
        union all
        (select status as status,
                started_at as started_at,
                created_at as created_at
           from heartbeat_runs
          where company_id = $1
            and status in ('queued', 'running')
            and context_snapshot->>'taskId' = $2
            and context_snapshot->>'issueId' is null
          order by created_at desc
          limit 5)) matches
 order by created_at desc
 limit 10`;
var REFRESH_SCORE_CLOSING_RUNS_SQL = `select coalesce(context_snapshot->>'issueId','') as issue_id,
       usage_json->>'model' as model,
       coalesce(agent_id::text,'') as agent_id,
       coalesce(usage_json->>'costUsd','') as cost_usd,
       -- TOG-4022: which provider's price table produced cost_usd. The Claude
       -- CLI lane stamps 'anthropic' for every model it serves, including the
       -- CLIProxy lanes serving Meta/Devin models, so cost_usd is only
       -- evidence once this column agrees with the model. See
       -- engine/cost-attribution.ts.
       coalesce(usage_json->>'provider','') as provider,
       extract(epoch from finished_at) * 1000 as finished_at_ms
  from heartbeat_runs
 where company_id = $1
   and status = 'succeeded'
   and finished_at > now() - ($2 || ' days')::interval
   and usage_json ? 'model'`;
var LANE_EVIDENCE_RUNS_SQL = `select usage_json->>'model' as model,
       count(*) filter (where status = 'succeeded')::int as succeeded,
       count(*) filter (where status in ('failed','timed_out'))::int as failed
  from heartbeat_runs
 where company_id = $1
   and created_at > now() - ($2 || ' hours')::interval
   and usage_json ? 'model'
 group by 1`;
var PREVIOUS_RUN_DECISION_SQL = `select context_snapshot->'modelDecision' as model_decision
  from heartbeat_runs
 where company_id = $1
   and id = $2::uuid
 limit 1`;
var ACTIVE_ROUTED_RUN_MODELS_SQL = `select context_snapshot->'modelDecision'->>'model' as routed_model
  from heartbeat_runs
 where company_id = $1
   and status in ('queued', 'running')
   and context_snapshot->'modelDecision'->>'model' is not null
 limit 2000`;

// src/hot-cache.ts
var HotCacheTimeout = class extends Error {
  constructor(key, budgetMs) {
    super(`hot cache load for "${key}" exceeded ${budgetMs} ms`);
    this.key = key;
    this.budgetMs = budgetMs;
    this.name = "HotCacheTimeout";
  }
};
var HotCache = class {
  constructor(options) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }
  entries = /* @__PURE__ */ new Map();
  inflight = /* @__PURE__ */ new Map();
  now;
  /** Applies a config-driven TTL to entries already held and to future reads. */
  setTtl(ttlMs) {
    this.options.ttlMs = ttlMs;
  }
  /** Cached value or `undefined`; never triggers a load. */
  peek(key) {
    const entry = this.entries.get(key);
    return entry ? { value: entry.value, ageMs: this.now() - entry.loadedAtMs } : void 0;
  }
  set(key, value) {
    this.entries.delete(key);
    this.entries.set(key, { value, loadedAtMs: this.now() });
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === void 0) break;
      this.entries.delete(oldest);
    }
  }
  invalidate(key) {
    this.entries.delete(key);
  }
  load(key, loader) {
    const running = this.inflight.get(key);
    if (running) return running;
    const started = loader().then((value) => {
      this.set(key, value);
      return value;
    });
    const tracked = started.finally(() => {
      if (this.inflight.get(key) === tracked) this.inflight.delete(key);
    });
    this.inflight.set(key, tracked);
    tracked.catch(() => {
    });
    return tracked;
  }
  async get(key, loader, budgetMs) {
    const cached = this.peek(key);
    if (cached) {
      if (cached.ageMs < this.options.ttlMs) return { ...cached, stale: false };
      this.load(key, loader).catch((error) => this.options.onRefreshError?.(key, error));
      return { ...cached, stale: true };
    }
    const pending = this.load(key, loader);
    let timer;
    const budget = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new HotCacheTimeout(key, budgetMs)), Math.max(0, budgetMs));
    });
    try {
      const value = await Promise.race([pending, budget]);
      return { value, ageMs: 0, stale: false };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  /** Awaitable refresh used by the warm-up job; failures keep the stale entry. */
  async refresh(key, loader) {
    try {
      await this.load(key, loader);
      return true;
    } catch (error) {
      this.options.onRefreshError?.(key, error);
      return false;
    }
  }
};
async function withinMs(promise, ms, fallback) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), Math.max(0, ms));
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// src/engine/run-resolve.ts
var RUN_RESOLVE_ENV_KEYS = [
  CONTEXT_LIMIT_ENV_KEY,
  ...PIN_LANE_MODEL_ENV_KEYS,
  ...ANCILLARY_MODEL_ENV_KEYS
];
function buildRunSelectionConfig(snapshot, issueId, nowIso, now, sticky) {
  const { config } = snapshot;
  const liveOverride = activeOperatorOverride(snapshot.operatorOverrides, issueId, nowIso);
  return {
    // The handler is only reached on an enforcing install, and a run-scoped
    // decision is never written durably, so no decision is forced advisory.
    enforcementEnabled: true,
    defaultTier: config.selection.defaultTier,
    models: applyDerivedTiers(config.models, snapshot.modelScores),
    holdOnUntrustedProfile: config.selection.holdOnUntrustedProfile,
    stickyWithinIssue: sticky,
    pacingMode: config.pacing.mode,
    laneLedger: snapshot.laneLedger,
    slotFloorFraction: config.pacing.slotFloorFraction,
    operatorOverrideModelId: liveOverride?.modelId ?? null,
    laneAvoidConfig: config.pacing.avoid,
    codexLaneId: config.pacing.codexLaneId,
    opencodeGoLaneId: config.pacing.opencodeGoLaneId,
    zaiLaneId: config.pacing.zai.laneId,
    laneOutageOverride: snapshot.laneOutageOverride,
    laneRoom: {
      capPerAccount: config.pacing.laneCapPerAccount,
      activePinsWeightByLane: snapshot.pinsWeightByLane,
      fiveHourWindowName: config.pacing.fiveHourWindowName,
      zaiLaneId: config.pacing.zai.laneId,
      zaiWeeklyWindowName: config.pacing.zai.weeklyWindowName,
      zaiWeeklyDefaultMargin: config.pacing.zai.weeklyDefaultMargin,
      zaiPaceOverrideMargin: activeZaiPaceOverride(snapshot.zaiPaceOverride, nowIso),
      now
    },
    objective: config.selection.objective,
    modelScores: snapshot.modelScores,
    // A decision at a run boundary re-affirms or replaces, it does not seed
    // evidence: the same rule every pinned-branch pass applies.
    allowExplore: false,
    holdOnUnknownAvailability: config.selection.holdOnUnknownAvailability,
    wakeScopedFloor: config.wakeScopedFloor
  };
}
function isFallbackDecision(decision, model) {
  return decision.escalatedFromTier !== null || model?.fallbackOnly === true;
}
function rejectionFor(decision, modelId) {
  const rejection = decision.rejections.find((entry) => entry.modelId === modelId);
  return rejection ? `${rejection.stage}: ${rejection.reason}` : "declined by the selection engine";
}
function runDecisionEnv(input) {
  const env = {};
  const secretBound = (key) => {
    const entry = input.agentEnv[key];
    if (!entry || typeof entry !== "object") return false;
    const type = entry.type;
    return type === "secret_ref" || type === "user_secret_ref";
  };
  const set = (key, value) => {
    if (!RUN_RESOLVE_ENV_KEYS.includes(key) || secretBound(key)) return;
    env[key] = value;
  };
  const window = Number.isFinite(input.model.contextWindow) && input.model.contextWindow > 0 ? Math.floor(input.model.contextWindow) : null;
  const cap = Number.isFinite(input.agentEnvContextTokens) && input.agentEnvContextTokens > 0 ? Math.floor(input.agentEnvContextTokens) : null;
  const ratio = input.compactionRatio > 0 && input.compactionRatio < 1 ? input.compactionRatio : 0.75;
  if (cap !== null && window !== null && window < cap) {
    set(
      CONTEXT_LIMIT_ENV_KEY,
      String(Math.max(Math.floor(window * ratio), Math.min(window, MIN_STAMPED_CONTEXT_TOKENS)))
    );
  }
  if (!isAdapterBlockedModel(input.model.id, input.adapterType)) {
    for (const key of PIN_LANE_MODEL_ENV_KEYS) set(key, input.model.id);
    const cheapPick = input.cheapModelId || input.model.id;
    const cheapId = isAdapterBlockedModel(cheapPick, input.adapterType) ? input.model.id : cheapPick;
    for (const key of ANCILLARY_MODEL_ENV_KEYS) set(key, cheapId);
  }
  return env;
}
function resolveRunDecision(input) {
  const { params, issue, agent, snapshot, prior, now } = input;
  const issueId = params.issueId;
  if (!issueId) return { kind: "keep", reason: "non-issue run" };
  if (params.issueOverrideModel) return { kind: "keep", reason: "issue carries an override model" };
  const { config } = snapshot;
  if (config.models.length === 0) return { kind: "keep", reason: "no models configured" };
  const nowIso = new Date(now).toISOString();
  const hasTierLabel = issue.labelNames.some((name) => name.startsWith(TIER_LABEL_PREFIX));
  const descriptorBase = {
    issueId,
    labelNames: !hasTierLabel && input.classifiedTier ? [...issue.labelNames, `${TIER_LABEL_PREFIX}${input.classifiedTier}`] : issue.labelNames,
    pinnedModelId: null,
    agentFloorModelId: params.agentDefaultModel,
    agentAdapterType: params.adapterType,
    priority: issue.priority,
    title: issue.title,
    agentName: agent.name,
    wakeReason: params.wakeReason ?? void 0
  };
  const estimate = estimateIssueContext({
    lastRunPeakTokens: input.lastRunPeakTokens,
    history: prior || params.previous ? "run-found" : "no-history",
    fleetCeilingTokens: config.selection.fleetContextCeilingTokens
  });
  if (estimate.tokens !== null) descriptorBase.requiredContextTokens = estimate.tokens;
  const availability = normalizeAvailability(snapshot.availabilityRaw, now);
  const selectWith = (stickyModelId) => selectModel({
    descriptor: { ...descriptorBase, stickyModelId },
    config: buildRunSelectionConfig(snapshot, issueId, nowIso, now, stickyModelId !== null),
    profiles: snapshot.profiles,
    signals: snapshot.signals,
    now,
    cardLedger: snapshot.cardLedger,
    availability,
    laneEvidence: snapshot.laneEvidence
  });
  const fresh = selectWith(null);
  const currentTier = fresh.judgement.tier;
  const tierSource = fresh.judgement.source === "issue-label" ? hasTierLabel ? "label" : "classifier" : "heuristic";
  const defer = (why, decision) => ({
    kind: "defer",
    reason: `${why} (${decision.outcome}${decision.trace.length ? `: ${decision.trace[decision.trace.length - 1]}` : ""})`
  });
  const unselected = (decision) => {
    if (decision.outcome === "selected" && decision.modelId) return null;
    if (decision.outcome === "held-at-floor" || decision.outcome === "disabled") {
      return { kind: "keep", reason: `${decision.outcome}: ${decision.trace[decision.trace.length - 1] ?? ""}` };
    }
    return defer("no serviceable model", decision);
  };
  let chosen = fresh;
  let switchInfo = null;
  const priorModelId = prior ? resolveConfiguredModelId(prior.model, config.models) ?? prior.model : null;
  if (!prior || !priorModelId) {
    const out = unselected(fresh);
    if (out) return out;
    switchInfo = {
      from: params.previous?.model ?? null,
      to: fresh.modelId,
      reason: "first-decision",
      detail: "no prior routed decision on this issue and agent"
    };
  } else {
    const probe = selectWith(priorModelId);
    const probeKeeps = probe.outcome === "selected" && probe.modelId === priorModelId;
    const out = unselected(fresh);
    if (prior.tier !== null && prior.tier !== currentTier) {
      if (out) return out;
      if (fresh.modelId !== priorModelId) {
        chosen = fresh;
        switchInfo = {
          from: priorModelId,
          to: fresh.modelId,
          reason: "tier-changed",
          detail: `tier ${prior.tier} -> ${currentTier} (${tierSource})`
        };
      }
    } else if (!probeKeeps) {
      const probeOut = unselected(probe);
      if (probeOut) return probeOut;
      chosen = probe;
      switchInfo = {
        from: priorModelId,
        to: probe.modelId,
        reason: "unserviceable",
        detail: rejectionFor(probe, priorModelId)
      };
    } else if (prior.fallback && !out) {
      const freshModel = config.models.find((model) => model.id === fresh.modelId);
      if (!isFallbackDecision(fresh, freshModel) && fresh.modelId !== priorModelId) {
        chosen = fresh;
        switchInfo = {
          from: priorModelId,
          to: fresh.modelId,
          reason: "primary-recovered",
          detail: `fallback ${priorModelId} replaced: primary ${fresh.modelId} is serviceable again`
        };
      } else {
        chosen = probe;
      }
    } else {
      chosen = probe;
    }
  }
  const selectedModel = recoverSelectedCandidate(config.models, chosen);
  if (!selectedModel) return defer("selected model is not in the roster", chosen);
  const roster = config.models.find((model) => model.id === selectedModel.id);
  const cheapModelId = cheapestHealthyModelIdForTier({
    models: config.models,
    tier: "T3",
    ledger: snapshot.laneLedger,
    laneOutageOverride: snapshot.laneOutageOverride,
    nowIso,
    modelScores: snapshot.modelScores,
    laneAvoidConfig: config.pacing.avoid,
    pacingMode: config.pacing.mode
  });
  const agentEnv = agent.adapterConfig.env && typeof agent.adapterConfig.env === "object" && !Array.isArray(agent.adapterConfig.env) ? agent.adapterConfig.env : {};
  const env = runDecisionEnv({
    model: selectedModel,
    cheapModelId,
    adapterType: params.adapterType,
    agentEnv,
    agentEnvContextTokens: config.selection.agentEnvContextTokens,
    compactionRatio: config.selection.compactionRatio
  });
  const effortPin = resolveEffortPin({
    adapterType: params.adapterType,
    modelId: selectedModel.id,
    rosterEffort: selectedModel.effort,
    inheritedEffort: inheritedEffortFrom(params.adapterType, agent.adapterConfig)
  });
  const effort = effortConfigKeyFor(params.adapterType) === "effort" && typeof effortPin.writes.effort === "string" && effortPin.writes.effort ? effortPin.writes.effort : void 0;
  const effectiveTier = chosen.effectiveTier ?? currentTier;
  const keptPrior = prior !== null && switchInfo === null && priorModelId === selectedModel.id;
  const fallback = keptPrior ? prior.fallback : isFallbackDecision(chosen, roster);
  const decisionId = (input.newDecisionId ?? (() => globalThis.crypto.randomUUID()))();
  const reason = switchInfo ? `${switchInfo.reason}: ${switchInfo.detail}` : `sticky: ${selectedModel.id} still serviceable at ${currentTier}`;
  return {
    kind: "decide",
    result: {
      kind: "decide",
      decisionId,
      model: selectedModel.id,
      ...effort !== void 0 ? { effort } : {},
      ...Object.keys(env).length > 0 ? { env } : {},
      // The judged tier, not the landing tier: the next run compares against
      // it, and an escalation must not read as a tier change on the next run.
      tier: currentTier,
      source: `model-selection:${tierSource}`,
      ...fallback ? { fallback: true } : {},
      reason
    },
    switch: switchInfo,
    tier: currentTier,
    tierSource,
    trace: [...chosen.trace, `effective tier ${effectiveTier}`, `effort: ${effortPin.reason}`]
  };
}

// src/engine/tier-outcomes.ts
function emptyTierPollOutcomes() {
  const tiers = {};
  for (const tier2 of TIERS) tiers[tier2] = { polls: 0, succeeded: 0, failed: 0, lastAt: null };
  return { tiers, updatedAt: null };
}
function tiersForLane(models, laneId) {
  const tiers = /* @__PURE__ */ new Set();
  for (const model of models) {
    if (model.enabled === false) continue;
    if ((model.laneId ?? null) !== laneId) continue;
    tiers.add(model.tier);
  }
  return [...tiers];
}
function isSafeCount2(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function normalizeTierPollOutcomes(stored) {
  const empty = emptyTierPollOutcomes();
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return empty;
  const record3 = stored;
  const tiersRecord = record3.tiers && typeof record3.tiers === "object" && !Array.isArray(record3.tiers) ? record3.tiers : null;
  if (!tiersRecord) return empty;
  for (const tier2 of TIERS) {
    const entry = tiersRecord[tier2];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry;
    const base = empty.tiers[tier2];
    empty.tiers[tier2] = {
      polls: isSafeCount2(row.polls) ? row.polls : base.polls,
      succeeded: isSafeCount2(row.succeeded) ? row.succeeded : base.succeeded,
      failed: isSafeCount2(row.failed) ? row.failed : base.failed,
      lastAt: typeof row.lastAt === "string" ? row.lastAt : base.lastAt
    };
  }
  return {
    tiers: empty.tiers,
    updatedAt: typeof record3.updatedAt === "string" ? record3.updatedAt : null
  };
}
function accumulateTierPollOutcomes(prev, results, models, nowIso) {
  const tiers = {};
  for (const tier2 of TIERS) tiers[tier2] = { ...prev.tiers[tier2] };
  let touched = false;
  for (const result of results) {
    for (const tier2 of tiersForLane(models, result.laneId)) {
      const counter = tiers[tier2];
      counter.polls += 1;
      if (result.error === null && result.serviceable === true) counter.succeeded += 1;
      else if (result.error !== null || result.serviceable === false) counter.failed += 1;
      counter.lastAt = nowIso;
      touched = true;
    }
  }
  return { tiers, updatedAt: touched ? nowIso : prev.updatedAt };
}

// src/engine/classify-call.ts
function upstreamUrl(baseUrl, protocol) {
  const parsed = new URL(baseUrl);
  const suffix = protocol === "openai-chat-completions" ? "/v1/chat/completions" : "/v1/messages";
  let path = parsed.pathname.replace(/\/+$/, "");
  if (path.endsWith(suffix)) path = path.slice(0, -suffix.length);
  parsed.pathname = `${path}${suffix}`.replace(/\/{2,}/g, "/");
  return parsed.toString();
}
function buildBody(input) {
  if (input.protocol === "openai-chat-completions") {
    return JSON.stringify({
      model: input.modelId,
      max_tokens: input.maxOutputTokens,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.userPrompt }
      ]
    });
  }
  return JSON.stringify({
    model: input.modelId,
    max_tokens: input.maxOutputTokens,
    system: input.system,
    messages: [{ role: "user", content: input.userPrompt }]
  });
}
function buildHeaders(input) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "Accept-Encoding": "identity"
  };
  if (!input.apiKey) return headers;
  if (input.protocol === "openai-chat-completions") {
    headers.Authorization = `Bearer ${input.apiKey}`;
  } else {
    headers["x-api-key"] = input.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  }
  return headers;
}
function extractText(protocol, parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  const body = parsed;
  if (protocol === "openai-chat-completions") {
    const choices = Array.isArray(body.choices) ? body.choices : [];
    const first = choices[0];
    const message = first && typeof first.message === "object" ? first.message : null;
    return typeof message?.content === "string" ? message.content : null;
  }
  const content = Array.isArray(body.content) ? body.content : [];
  const text2 = content.filter((block) => !!block && typeof block === "object").map((block) => typeof block.text === "string" ? block.text : "").join("");
  return text2.length > 0 ? text2 : null;
}
async function callClassifier(input, http) {
  const fail = (error) => ({ text: null, error });
  let target;
  let parsedUrl;
  try {
    target = upstreamUrl(input.baseUrl, input.protocol);
    parsedUrl = new URL(target);
  } catch {
    return fail("classification-url-rejected");
  }
  if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash || isReservedLiteralHost(parsedUrl.hostname)) {
    return fail("classification-url-rejected");
  }
  let response;
  try {
    let timer;
    response = await Promise.race([
      http.fetch(target, {
        method: "POST",
        headers: buildHeaders(input),
        body: buildBody(input),
        redirect: "manual"
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("classification-request-timeout")), input.requestTimeoutMs);
      })
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  } catch {
    return fail("classification-request-failed");
  }
  if (response.redirected || response.status >= 300 && response.status < 400) {
    return fail("classification-redirect-refused");
  }
  if (response.status === 401 || response.status === 403) {
    return fail("classification-authentication-failed");
  }
  if (response.status < 200 || response.status >= 300) {
    return fail("classification-http-failed");
  }
  const mediaType = response.headers.get("content-type")?.toLowerCase().split(";", 1)[0]?.trim();
  if (!mediaType?.endsWith("/json") && !mediaType?.endsWith("+json")) {
    return fail("classification-unexpected-media-type");
  }
  let text2;
  try {
    text2 = await response.text();
  } catch {
    return fail("classification-request-failed");
  }
  if (new TextEncoder().encode(text2).byteLength > input.maxResponseBytes) {
    return fail("classification-response-too-large");
  }
  let document;
  try {
    document = JSON.parse(text2);
  } catch {
    return fail("classification-invalid-json");
  }
  const extracted = extractText(input.protocol, document);
  if (extracted === null) return fail("classification-empty-response");
  return { text: extracted, error: null };
}

// src/row-walk.ts
async function runRowWithinBudget(work, deadlineAt) {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    work.catch(() => void 0);
    return { timedOut: true };
  }
  let timer = null;
  try {
    return await Promise.race([
      work.then((value) => ({ timedOut: false, value })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), remainingMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
function rowAdmissionHeadroomMs(rowTimeoutMs, slowestRowMs) {
  return Math.max(rowTimeoutMs, Math.ceil(1.5 * slowestRowMs));
}
async function walkRowsWithinDeadline(rows, limits, perRow) {
  const walk = {
    examined: [],
    settledPrefix: 0,
    unsettled: 0,
    slowestRowMs: limits.slowestRowMs ?? 0,
    budgetExhausted: false,
    rowCapHit: false,
    stoppedByCaller: false,
    abandoned: null
  };
  let prefixOpen = true;
  for (const row of rows) {
    if (limits.maxRows !== void 0 && walk.examined.length >= limits.maxRows) {
      walk.rowCapHit = true;
      break;
    }
    if (limits.deadlineAt !== null && limits.deadlineAt - Date.now() < rowAdmissionHeadroomMs(limits.rowTimeoutMs, walk.slowestRowMs)) {
      walk.budgetExhausted = true;
      break;
    }
    const rowStartedAt = Date.now();
    const work = (async () => perRow(row, rowStartedAt))();
    const outcome = limits.deadlineAt === null ? { timedOut: false, value: await work } : await runRowWithinBudget(work, limits.deadlineAt);
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
function updatedAtMs(row) {
  const raw = row && typeof row === "object" ? row.updated_at : void 0;
  const ms = raw instanceof Date ? raw.getTime() : typeof raw === "string" ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}
function scanMarkAfterWalk(rows, settledPrefix, fetchLimit, firingStartMs) {
  if (settledPrefix >= rows.length && rows.length < fetchLimit) return firingStartMs;
  let lastSettled = null;
  for (const row of rows.slice(0, settledPrefix)) {
    const ms = updatedAtMs(row);
    if (ms !== null && (lastSettled === null || ms > lastSettled)) lastSettled = ms;
  }
  if (lastSettled === null) return null;
  let firstUnpassed = null;
  for (const row of rows.slice(settledPrefix)) {
    const ms = updatedAtMs(row);
    if (ms !== null && (firstUnpassed === null || ms < firstUnpassed)) firstUnpassed = ms;
  }
  if (firstUnpassed === null) return lastSettled - 1;
  return Math.min(lastSettled, firstUnpassed - 1);
}

// src/engine/classify.ts
var RUBRIC = `You classify a software-company work item into a model tier. Answer ONLY a JSON object:
{"tier":"T1"|"T2"|"T3","confidence":0.0-1.0,"exclusion":true|false,"reason":"<=20 words"}
T1 = judgement-heavy, consequential, trust-sensitive, or irreversible: architecture/design decisions; security or adversarial review; incident response; upstream/public actions; owner-facing decisions; factual analysis that feeds consequential decisions; credentials, permissions, access, production deploys, approvals, policy.
T2 = ordinary engineering and fact-producing knowledge work: implementation with tests, normal code review, CI, runbooks, debugging, data pipelines, bounded multi-app automation with deterministic checks, research or reports that must discover or reconcile facts.
T3 = mechanically checkable, low-stakes transformation of supplied evidence: formatting, renames, boilerplate, verbatim extraction, status restatement, label/triage hygiene, registering an existing test, deterministic reruns. A report or summary is T3 only when it creates no new factual premise.
Anchors. These resolve the boundaries that get misread most often. They do not move the definitions above; they say which side of them specific recurring work sits on:
- Reviewing a named PR, commit or SHA against criteria that are already written down is T2, even when the code under review is security-sensitive. Reviewing is not deciding. Choosing whether to ADOPT a security posture, or giving an approval that is itself the irreversible act, stays T1.
- Work that PRESENTS options for someone else to choose is T2. Only work that MAKES or COMMITS TO the decision is T1. "Owner-facing decisions" above means the deciding, not the informing.
- A coordinating or parent card whose own body says the work happens elsewhere ("do not build here", "track only", "the children do the work") is T3: its output is restated status, not engineering.
- Building or fixing a tool, plugin, CI harness or test rig against a stated failure is T2. Its acceptance test is a deterministic check, which is what makes it ordinary engineering rather than judgement.
- Entering, transcribing or reconciling roster, score or measurement data from a supplied source is T2, and re-running a measurement whose method is already fixed is T2.
exclusion=true when the task touches secrets, credentials, permissions, access reviews, provisioning, or owner approvals (these must stay on the assignee's default model regardless of tier).
Be conservative where conservatism buys safety, and only there. If you are unsure between T1 and T2, choose T1 only when a concrete T1 trigger is actually present in the item: an irreversible or externally-visible action, credentials/permissions/access, a production deploy, an approval, a security-posture decision, or an incident in progress. Otherwise choose T2. If you are unsure between T2 and T3, choose T2. Do not choose T1 because the subject matter sounds important, because the card is high priority, or because it names a sensitive system that it does not itself change.`;
function buildClassificationPrompt(title, description, agentRole, descriptionChars) {
  const truncated = (description ?? "").slice(0, descriptionChars);
  return `Assignee role: ${agentRole}
Title: ${title}
Description:
${truncated}`;
}
var TIER_VALUES = ["T1", "T2", "T3"];
function parseClassificationResponse(text2) {
  const match = /\{[\s\S]*\}/.exec(text2);
  if (!match) return null;
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj2 = parsed;
  if (typeof obj2.tier !== "string" || !TIER_VALUES.includes(obj2.tier)) return null;
  const confidence = typeof obj2.confidence === "number" && Number.isFinite(obj2.confidence) ? obj2.confidence : 0;
  return {
    tier: obj2.tier,
    confidence,
    exclusion: obj2.exclusion === true,
    reason: typeof obj2.reason === "string" ? obj2.reason : ""
  };
}
function applyConfidenceDemotion(tier2, confidence, t3ConfidenceFloor, t2ConfidenceFloor) {
  let next = tier2;
  if (next === "T3" && confidence < t3ConfidenceFloor) next = "T2";
  if (next === "T2" && confidence < t2ConfidenceFloor) next = "T1";
  return next;
}
function resolveClassifiedTiers(judgement, config) {
  const labelTier = applyConfidenceDemotion(
    judgement.tier,
    judgement.confidence,
    config.t3ConfidenceFloor,
    config.t2ConfidenceFloor
  );
  return { labelTier, pickTier: judgement.exclusion ? "T1" : labelTier };
}

// src/engine/dispatch-selection.ts
var WAKEUP_REFUSED_STATUSES = ["backlog", "done", "cancelled"];
var TERMINAL_STATUSES2 = ["done", "cancelled"];
var SELECTION_COUNTERS = [
  "refused_backlog",
  "refused_unassigned",
  "refused_blocked",
  "refused_monitor_armed",
  "parked_on_human_ask",
  "refused_in_review",
  "parked_on_named_owner",
  "actionable_idle_assignee",
  "skipped_lane_down",
  "woken"
];
var LEGACY_COUNTERS = ["candidates_ready", "runnable_queue", "deadlocked_agents"];
var ACTIVE_RUN_STATUSES = ["queued", "running"];
var toMillis = (value) => {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
};
function computeIdleMs(issue, runs, nowMs) {
  const scoped = (runs ?? []).filter((run) => run.issueId === issue.id);
  if (scoped.some((run) => ACTIVE_RUN_STATUSES.includes(run.status))) {
    return { idleMs: 0, anchor: "active_run", hasRun: true };
  }
  let latest = null;
  for (const run of scoped) {
    for (const stamp of [run.finishedAt, run.startedAt, run.createdAt]) {
      const ms = toMillis(stamp);
      if (ms !== null && (latest === null || ms > latest)) latest = ms;
    }
  }
  if (latest !== null) {
    return { idleMs: Math.max(0, nowMs - latest), anchor: "last_run", hasRun: true };
  }
  const created = toMillis(issue.createdAt);
  if (created === null) return { idleMs: 0, anchor: "unknown", hasRun: false };
  return { idleMs: Math.max(0, nowMs - created), anchor: "issue_created_never_run", hasRun: false };
}
function isParkedOnNamedOwner(issue) {
  const descriptor = issue.unblockDescriptor;
  return descriptor !== null && descriptor !== void 0;
}
function isMonitorArmed(issue, nowMs) {
  const at = toMillis(issue.monitorNextCheckAt ?? null);
  return at !== null && at > nowMs;
}
var PENDING_INTERACTION_STATUS = "pending";
function isParkedOnHumanAsk(interactions, assigneeAgentId) {
  return (interactions ?? []).some((interaction) => {
    if (interaction.status !== PENDING_INTERACTION_STATUS) return false;
    if (interaction.effectiveResolverPolicy === "human_only") return true;
    return interaction.addresseeAgentId != null && interaction.addresseeAgentId !== assigneeAgentId;
  });
}
function isReviewerNamedAssignee(interactions, assigneeAgentId) {
  return (interactions ?? []).some(
    (interaction) => interaction.status === PENDING_INTERACTION_STATUS && interaction.addresseeAgentId === assigneeAgentId
  );
}
function classifyIssue(input) {
  const {
    issue,
    blockedBy = [],
    invocationBlock = null,
    pendingInteractions,
    idleMinutes,
    idle,
    nowMs,
    assigneeIdle = false
  } = input;
  if (TERMINAL_STATUSES2.includes(issue.status)) {
    return { outcome: "excluded_terminal" };
  }
  if (!issue.assigneeAgentId) {
    return { outcome: "refused_unassigned" };
  }
  if (WAKEUP_REFUSED_STATUSES.includes(issue.status)) {
    return { outcome: "refused_backlog" };
  }
  if (blockedBy.some((blocker) => blocker.status !== "done")) {
    return { outcome: "refused_blocked" };
  }
  if (isMonitorArmed(issue, nowMs)) {
    return { outcome: "refused_monitor_armed", wakeable: true };
  }
  if (isParkedOnHumanAsk(pendingInteractions, issue.assigneeAgentId)) {
    return { outcome: "parked_on_human_ask", wakeable: true };
  }
  if (issue.status === "in_review" && !isReviewerNamedAssignee(pendingInteractions, issue.assigneeAgentId)) {
    return { outcome: "refused_in_review", wakeable: true };
  }
  if (invocationBlock) {
    return { outcome: "refused_budget_block", wakeable: true, blockReason: invocationBlock.reason };
  }
  if (isParkedOnNamedOwner(issue)) {
    return { outcome: "parked_on_named_owner", wakeable: true };
  }
  if (idle.idleMs < idleMinutes * 6e4) {
    if (assigneeIdle && (issue.status === "todo" || issue.status === "in_progress")) {
      return { outcome: "actionable_idle_assignee", wakeable: true };
    }
    return { outcome: "wakeable_not_idle", wakeable: true };
  }
  return { outcome: "actionable", wakeable: true };
}
var PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3 };
function spreadAcrossAssignees(actionable, maxPicks) {
  const ordered = [...actionable].sort((a, b) => {
    if (b.idleMs !== a.idleMs) return b.idleMs - a.idleMs;
    const pa = PRIORITY_RANK[a.issue.priority] ?? 9;
    const pb = PRIORITY_RANK[b.issue.priority] ?? 9;
    if (pa !== pb) return pa - pb;
    return String(a.issue.id).localeCompare(String(b.issue.id));
  });
  const picks = [];
  const coalesced = [];
  const claimed = /* @__PURE__ */ new Set();
  for (const candidate of ordered) {
    const agentId = candidate.issue.assigneeAgentId;
    if (claimed.has(agentId)) {
      coalesced.push(candidate);
      continue;
    }
    if (picks.length >= maxPicks) break;
    claimed.add(agentId);
    picks.push(candidate);
  }
  const overflow = ordered.filter(
    (candidate) => !picks.includes(candidate) && !coalesced.includes(candidate)
  );
  return { picks, coalescedWithEarlierPick: coalesced, overflow };
}
function selectDispatch(population, options) {
  const {
    idleMinutes,
    maxWakesPerFiring,
    focusProjectIds = [],
    now,
    idleAssignees,
    laneByIssueId,
    isLaneDown
  } = options;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const counters = {
    refused_backlog: 0,
    refused_unassigned: 0,
    refused_blocked: 0,
    refused_monitor_armed: 0,
    parked_on_human_ask: 0,
    refused_in_review: 0,
    parked_on_named_owner: 0,
    actionable_idle_assignee: 0,
    skipped_lane_down: 0,
    // Filled in by the worker after the wake attempts. The policy cannot know
    // it: whether a wake succeeds is the server's call, not ours.
    woken: 0
  };
  const focus = new Set(focusProjectIds);
  const actionable = [];
  const idleAssigneeActionable = [];
  const laneDownSkipped = [];
  const parked = [];
  const budgetBlocked = [];
  let wakeable = 0;
  let excludedTerminal = 0;
  let outOfFocus = 0;
  for (const entry of population) {
    const { issue, blockedBy = [], runs = [], invocationBlock = null, pendingInteractions } = entry;
    const idle = computeIdleMs(issue, runs, nowMs);
    const assigneeIdle = !!issue.assigneeAgentId && !!idleAssignees?.has(issue.assigneeAgentId) && !runs.some((run) => run.issueId === issue.id && (run.status === "queued" || run.status === "running"));
    const result = classifyIssue({
      issue,
      blockedBy,
      invocationBlock,
      pendingInteractions,
      idleMinutes,
      idle,
      nowMs,
      assigneeIdle
    });
    if (result.outcome === "excluded_terminal") {
      excludedTerminal += 1;
      continue;
    }
    if (result.wakeable) wakeable += 1;
    if (result.outcome in counters) counters[result.outcome] += 1;
    if (result.outcome === "refused_budget_block") {
      budgetBlocked.push({ issue, idleMs: idle.idleMs, reason: result.blockReason ?? null });
      continue;
    }
    if (result.outcome === "parked_on_named_owner") {
      parked.push({ issue, idleMs: idle.idleMs, idleAnchor: idle.anchor });
      continue;
    }
    if (result.outcome !== "actionable" && result.outcome !== "actionable_idle_assignee") continue;
    if (focus.size > 0 && !focus.has(issue.projectId ?? "")) {
      outOfFocus += 1;
      continue;
    }
    const laneId = laneByIssueId?.get(issue.id) ?? null;
    if (laneId !== null && isLaneDown?.(laneId)) {
      counters.skipped_lane_down += 1;
      laneDownSkipped.push({ issue, laneId });
      continue;
    }
    const candidate = { issue, idleMs: idle.idleMs, idleAnchor: idle.anchor };
    actionable.push(candidate);
    if (result.outcome === "actionable_idle_assignee") idleAssigneeActionable.push(candidate);
  }
  const { picks, coalescedWithEarlierPick, overflow } = spreadAcrossAssignees(actionable, maxWakesPerFiring);
  return {
    counters,
    legacy: {
      // The set we would select from: rails passed, not parked, not
      // lane-down, in focus — both the threshold class and the TOG-3585
      // idle-assignee class.
      candidates_ready: actionable.length,
      // The wakeable surface: rails 1-3 passed, before our two own rails. This
      // is the 26 in docs/dispatch-plugin-facts.md §3.
      runnable_queue: wakeable,
      // No native equivalent (Q5). null, never 0 — see LEGACY_COUNTERS.
      deadlocked_agents: null
    },
    picks,
    parked,
    // Not one of the five counters — a sixth outcome the design did not know
    // was measurable. Reported alongside them, never folded into one of them.
    budgetBlocked,
    actionable,
    idleAssigneeActionable,
    laneDownSkipped,
    coalescedWithEarlierPick,
    overflow,
    excludedTerminal,
    outOfFocus
  };
}
function identifyRoutingOwners(agents) {
  const owners = [];
  for (const agent of agents ?? []) {
    if (agent.status === "terminated") continue;
    if (agent.role === "ceo") {
      owners.push({ agentId: agent.id, name: agent.name, source: "ceo_role" });
      continue;
    }
    if (agent.permissions?.canCreateAgents === true) {
      owners.push({ agentId: agent.id, name: agent.name, source: "agent_creator" });
    }
  }
  return {
    owners,
    complete: false,
    unreadableSources: ["explicit_grant", "simple_default"]
  };
}
function summariseRoutingGap(population) {
  const unassigned = population.map((entry) => entry.issue).filter((issue) => !TERMINAL_STATUSES2.includes(issue.status) && !issue.assigneeAgentId);
  const byProject = {};
  for (const issue of unassigned) {
    const key = issue.projectId ?? "(no project)";
    byProject[key] = (byProject[key] ?? 0) + 1;
  }
  return { count: unassigned.length, byProject, issueIds: unassigned.map((issue) => issue.id) };
}

// src/dispatch-reporting.ts
var METRIC_PREFIX = "dispatch";
function wakeFailureCodeFor(message) {
  const text2 = message.toLowerCase();
  if (/no assigned agent|no assignee/.test(text2)) return "unassigned";
  if (/not wakeable in status|bad status|backlog|terminal/.test(text2)) return "bad_status";
  if (/blocked by|unresolved blocker/.test(text2)) return "blocked";
  if (/budget|invocation.?block|quota|exhausted|insufficient/.test(text2)) return "budget_block";
  if (/429|rate.?limit|too many/.test(text2)) return "rate_limited";
  if (/timed? ?out|deadline|rpc.*(fail|error)|unavailable/.test(text2)) return "timeout";
  return "unknown";
}
function normalizeWakeFailure(error) {
  if (!error) return null;
  if (typeof error === "string") return { code: wakeFailureCodeFor(error), message: error };
  return { code: error.code, message: error.message };
}
function summariseFiring(companyId, selection, wakeOutcomes) {
  const woken = wakeOutcomes.filter((outcome) => outcome.queued).length;
  const failures = wakeOutcomes.filter((outcome) => !outcome.queued);
  const wakeFailureDetails = failures.map((outcome) => {
    const failure = normalizeWakeFailure(outcome.error) ?? {
      code: "unknown",
      message: "wake not queued, no error recorded"
    };
    return { issueId: outcome.issueId, code: failure.code, message: failure.message };
  });
  const wakeFailuresByReason = {};
  for (const detail of wakeFailureDetails) {
    wakeFailuresByReason[detail.code] = (wakeFailuresByReason[detail.code] ?? 0) + 1;
  }
  const pickedIds = new Set(selection.picks.map((p) => p.issue.id));
  const idleAssigneeIds = new Set((selection.idleAssigneeActionable ?? []).map((p) => p.issue.id));
  return {
    companyId,
    counters: { ...selection.counters, woken },
    legacy: { ...selection.legacy },
    pickedIssueIds: [...pickedIds].sort(),
    parkedIssueIds: selection.parked.map((p) => p.issue.id).sort(),
    budgetBlockedIssueIds: selection.budgetBlocked.map((b) => b.issue.id).sort(),
    laneDownSkippedIssueIds: (selection.laneDownSkipped ?? []).map((s) => s.issue.id).sort(),
    idleAssigneePickedIssueIds: [...pickedIds].filter((id) => idleAssigneeIds.has(id)).sort(),
    routingGapCount: selection.routingGap?.count ?? 0,
    routingOwnerIds: (selection.routingGap?.owners?.owners ?? []).map((o) => o.agentId).sort(),
    routingOwnersComplete: selection.routingGap?.owners?.complete ?? false,
    wakeFailures: failures.length,
    wakeFailuresByReason,
    wakeFailureDetails
  };
}
function canonicalise(summary2) {
  const sortedCounters = Object.fromEntries(Object.entries(summary2.counters).sort(([a], [b]) => a.localeCompare(b)));
  const sortedLegacy = Object.fromEntries(Object.entries(summary2.legacy).sort(([a], [b]) => a.localeCompare(b)));
  const sortedReasons = Object.fromEntries(
    Object.entries(summary2.wakeFailuresByReason ?? {}).sort(([a], [b]) => a.localeCompare(b))
  );
  const failureKeys = [...summary2.wakeFailureDetails ?? []].map((d) => `${d.issueId}:${d.code}`).sort();
  return {
    companyId: summary2.companyId,
    counters: sortedCounters,
    legacy: sortedLegacy,
    pickedIssueIds: [...summary2.pickedIssueIds].sort(),
    parkedIssueIds: [...summary2.parkedIssueIds].sort(),
    budgetBlockedIssueIds: [...summary2.budgetBlockedIssueIds].sort(),
    laneDownSkippedIssueIds: [...summary2.laneDownSkippedIssueIds ?? []].sort(),
    idleAssigneePickedIssueIds: [...summary2.idleAssigneePickedIssueIds ?? []].sort(),
    routingGapCount: summary2.routingGapCount,
    routingOwnerIds: [...summary2.routingOwnerIds].sort(),
    routingOwnersComplete: summary2.routingOwnersComplete,
    wakeFailures: summary2.wakeFailures,
    wakeFailuresByReason: sortedReasons,
    wakeFailureKeys: failureKeys
  };
}
function hasStateChanged(previous, current) {
  if (!previous) return true;
  return JSON.stringify(canonicalise(previous)) !== JSON.stringify(canonicalise(current));
}
async function emitMetrics(ctx, input) {
  const { companyId, summary: summary2, wakeEnabled } = input;
  const tags = { companyId, wakeEnabled: String(wakeEnabled) };
  for (const counter of SELECTION_COUNTERS) {
    await ctx.metrics.write(`${METRIC_PREFIX}.${counter}`, summary2.counters[counter] ?? 0, tags);
  }
  for (const counter of LEGACY_COUNTERS) {
    const value = summary2.legacy[counter];
    if (typeof value === "number") {
      await ctx.metrics.write(`${METRIC_PREFIX}.${counter}`, value, tags);
    }
  }
  await ctx.metrics.write(`${METRIC_PREFIX}.routing_gap`, summary2.routingGapCount, tags);
  await ctx.metrics.write(`${METRIC_PREFIX}.wake_failures`, summary2.wakeFailures, tags);
  const reasons = [
    "budget_block",
    "blocked",
    "unassigned",
    "bad_status",
    "rate_limited",
    "timeout",
    "unknown"
  ];
  for (const reason of reasons) {
    await ctx.metrics.write(`${METRIC_PREFIX}.wake_failures`, summary2.wakeFailuresByReason?.[reason] ?? 0, {
      ...tags,
      reason
    });
  }
  await ctx.metrics.write(
    `${METRIC_PREFIX}.lane_down_skips`,
    summary2.laneDownSkippedIssueIds?.length ?? 0,
    tags
  );
  await ctx.metrics.write(
    `${METRIC_PREFIX}.idle_assignee_picks`,
    summary2.idleAssigneePickedIssueIds?.length ?? 0,
    tags
  );
}
async function logStateChange(ctx, input) {
  const { companyId, summary: summary2, wakeEnabled, notes = [] } = input;
  const mode = wakeEnabled ? "live" : "report-only";
  const action = wakeEnabled ? "woken" : "would have woken";
  const routing = summary2.routingGapCount > 0 ? ` Unassigned (routing gap): ${summary2.routingGapCount}${summary2.routingOwnersComplete ? "" : " (routing owners: partial list)"}.` : " Unassigned (routing gap): 0.";
  const idleAssigneePicks = summary2.idleAssigneePickedIssueIds?.length ?? 0;
  const laneDownSkips = summary2.laneDownSkippedIssueIds?.length ?? 0;
  const failureReasons = Object.entries(summary2.wakeFailuresByReason ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([code, count3]) => `${code} ${count3}`).join(", ");
  const failures = summary2.wakeFailures > 0 ? ` Wake failures: ${summary2.wakeFailures}${failureReasons ? ` (${failureReasons})` : ""}.` : "";
  const message = `Dispatch sweep (${mode}): ${action} of ${summary2.legacy.candidates_ready} candidates from a wakeable surface of ${summary2.legacy.runnable_queue} (${idleAssigneePicks} idle-assignee). Parked on a named owner: ${summary2.counters.parked_on_named_owner ?? 0}. Lane-down skips: ${laneDownSkips}.` + failures + routing;
  await ctx.activity.log({
    companyId,
    message,
    entityType: "plugin",
    entityId: "dispatch",
    metadata: { ...summary2, wakeEnabled, notes }
  });
}

// src/worker.ts
function safeJsonParse(text2) {
  try {
    return JSON.parse(text2);
  } catch {
    return null;
  }
}
function asRecord3(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function toolRejection(error, extra = {}) {
  return { ok: false, error, ...extra };
}
function summary(decision) {
  if (decision.outcome === "selected") {
    const wakeNote = decision.wakeScopedTier ? ` \u2014 wake-scoped floor ${decision.wakeScopedTier} (card tier ${decision.judgement.tier} unchanged)` : "";
    return `${decision.modelId} at ${decision.effectiveTier} (tier via ${decision.judgement.source})${decision.advisory ? " \u2014 advisory, nothing written" : ""}${wakeNote}`;
  }
  if (decision.outcome === "held-at-floor") {
    return `Held at the agent floor: ${decision.heldReason}`;
  }
  if (decision.outcome === "disabled") return "Model Selection is not configured for this company.";
  if (decision.outcome === "tier-exhausted") {
    return `Tier exhausted: every model from ${decision.judgement.tier} through T1 is pace-exhausted; nowhere left to escalate to.`;
  }
  return "No eligible model for this issue.";
}
function createPlugin() {
  let context = null;
  const knownCompanyIds = /* @__PURE__ */ new Set();
  const listKnownCompanies = () => [...knownCompanyIds].map((id) => ({ id }));
  const knownCompaniesKey = () => ({
    scopeKind: "instance",
    stateKey: PLUGIN_STATE_KEYS.knownCompanies
  });
  let runResolveHandler = null;
  let invalidateRunSnapshot = null;
  return definePlugin({
    multiCompanyConfig: true,
    async setup(ctx) {
      context = ctx;
      const companyConfig = async (companyId) => resolveConfig(await ctx.config.get(companyId));
      const profilesKey = (companyId) => ({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.volumeProfiles
      });
      const readProfiles = async (companyId) => {
        const stored = asRecord3(await ctx.state.get(profilesKey(companyId)));
        return {
          profiles: Array.isArray(stored.profiles) ? stored.profiles : [],
          signals: Array.isArray(stored.signals) ? stored.signals : []
        };
      };
      const laneLedgerKey = (companyId) => ({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.laneLedger
      });
      const readLaneLedger = async (companyId) => {
        const stored = await ctx.state.get(laneLedgerKey(companyId));
        return stored && typeof stored === "object" ? stored : {};
      };
      const laneAvailabilityKey = (companyId) => ({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.laneAvailability
      });
      const readAvailability = async (companyId, nowMs) => {
        const stored = await ctx.state.get(laneAvailabilityKey(companyId));
        return normalizeAvailability(stored, nowMs);
      };
      let laneEvidenceCache = null;
      const readLaneEvidence = async (companyId, models, nowMs) => {
        if (laneEvidenceCache && laneEvidenceCache.companyId === companyId && nowMs - laneEvidenceCache.atMs < LANE_EVIDENCE_TTL_MS) {
          return laneEvidenceCache.snapshot;
        }
        let snapshot;
        try {
          const rows = await ctx.db.query(LANE_EVIDENCE_RUNS_SQL, [
            companyId,
            String(LANE_EVIDENCE_WINDOW_HOURS)
          ]);
          const byLane = /* @__PURE__ */ new Map();
          for (const row of rows) {
            const record3 = asRecord3(row);
            const modelId = typeof record3.model === "string" ? record3.model : null;
            if (!modelId) continue;
            const laneId = models.find((entry) => entry.id === modelId)?.laneId ?? null;
            if (!laneId) continue;
            const bucket = byLane.get(laneId) ?? { succeeded: 0, failed: 0 };
            bucket.succeeded += Number(record3.succeeded) || 0;
            bucket.failed += Number(record3.failed) || 0;
            byLane.set(laneId, bucket);
          }
          snapshot = buildLaneEvidence(
            [...byLane.entries()].map(([laneId, counts]) => ({ laneId, ...counts })),
            LANE_EVIDENCE_WINDOW_HOURS
          );
        } catch (error) {
          snapshot = {
            lanes: [],
            windowHours: LANE_EVIDENCE_WINDOW_HOURS,
            unreadableReason: `heartbeat_runs read failed: ${error instanceof Error ? error.message : String(error)}`
          };
        }
        laneEvidenceCache = { companyId, atMs: nowMs, snapshot };
        return snapshot;
      };
      const operatorOverridesKey = (companyId) => ({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.operatorOverrides
      });
      const readOperatorOverrides = async (companyId) => {
        const stored = await ctx.state.get(operatorOverridesKey(companyId));
        return stored && typeof stored === "object" ? stored : {};
      };
      const laneOutageKey = (companyId) => ({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.laneOutage
      });
      const readLaneOutage = async (companyId) => {
        const stored = await ctx.state.get(laneOutageKey(companyId));
        if (!stored || typeof stored !== "object") return null;
        const record3 = stored;
        if (!Array.isArray(record3.lanes) || !Array.isArray(record3.models) || typeof record3.until !== "string") {
          return null;
        }
        return {
          lanes: record3.lanes.filter((l) => typeof l === "string"),
          models: record3.models.filter((m) => typeof m === "string"),
          until: record3.until,
          ...typeof record3.reason === "string" ? { reason: record3.reason } : {}
        };
      };
      const zaiPaceOverrideKey = (companyId) => ({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.zaiPaceOverride
      });
      const readZaiPaceOverride = async (companyId) => {
        const stored = await ctx.state.get(zaiPaceOverrideKey(companyId));
        if (!stored || typeof stored !== "object") return null;
        const record3 = stored;
        if (typeof record3.margin !== "number" || typeof record3.until !== "string") return null;
        return { margin: record3.margin, until: record3.until };
      };
      const paceRepinHistoryKey = (companyId) => ({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.paceRepinHistory
      });
      const readPaceRepinHistory = async (companyId) => {
        const stored = asRecord3(await ctx.state.get(paceRepinHistoryKey(companyId)));
        const history = {};
        for (const [issueId, at] of Object.entries(stored)) {
          if (typeof at === "string") history[issueId] = at;
        }
        return history;
      };
      const tierExhaustedAlarmsKey = (companyId) => ({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.tierExhaustedAlarms
      });
      const readTierExhaustedAlarms = async (companyId) => {
        const stored = asRecord3(await ctx.state.get(tierExhaustedAlarmsKey(companyId)));
        const alarms = {};
        for (const [issueId, at] of Object.entries(stored)) {
          if (typeof at === "string") alarms[issueId] = at;
        }
        return alarms;
      };
      const raiseOrClearTierExhaustedAlarm = async (companyId, issueId, issueTitle, issueIdentifier, decision, authorAgentId) => {
        const alarms = await readTierExhaustedAlarms(companyId);
        if (decision.outcome !== "tier-exhausted") {
          if (issueId in alarms) {
            const { [issueId]: _dropped, ...rest } = alarms;
            await ctx.state.set(tierExhaustedAlarmsKey(companyId), rest);
          }
          return;
        }
        if (issueId in alarms) return;
        const config = await companyConfig(companyId);
        const reference = issueIdentifier ? `${issueIdentifier} (${issueTitle})` : issueTitle;
        await ctx.issues.create({
          companyId,
          parentId: issueId,
          title: `Operator: model tier exhausted on ${reference}`,
          description: `Every model from ${decision.judgement.tier} through T1 is pace-exhausted for ${reference} \u2014 there is nowhere left for Model Selection to escalate to.

Intervene to unblock: add lane capacity, adjust pacing, or set an operator override (\`model_selection_set_operator_override\`). This escalation stays open until the lane recovers and a fresh \`model_selection_advise\`/\`apply\` call on the original issue no longer reports \`tier-exhausted\`.`,
          priority: "critical",
          labelIds: config.operatorLabelId ? [config.operatorLabelId] : void 0,
          actor: { actorAgentId: authorAgentId ?? void 0 }
        });
        await ctx.state.set(tierExhaustedAlarmsKey(companyId), { ...alarms, [issueId]: (/* @__PURE__ */ new Date()).toISOString() });
      };
      const SHADOW_SHARD_PREFIX = "decisions-";
      const SHADOW_SHARD_PATTERN = /^decisions-(\d{4}-\d{2}-\d{2}-\d{2})Z\.jsonl$/;
      const shadowShardFor = (nowIso) => {
        const hour = new Date(nowIso).toISOString().slice(0, 13).replace("T", "-");
        return `${SHADOW_SHARD_PREFIX}${hour}Z.jsonl`;
      };
      const isMissingShadowFileError = (err) => {
        const message = err instanceof Error ? err.message : String(err);
        return /not found/i.test(message) || /ENOENT/.test(message);
      };
      const decisionEmitChains = /* @__PURE__ */ new Map();
      const emitDecisionPairSerialized = async (companyId, records) => {
        const config = await companyConfig(companyId);
        const shard = shadowShardFor(records[0]?.ts ?? (/* @__PURE__ */ new Date()).toISOString());
        let existing = "";
        try {
          existing = await ctx.localFolders.readText(companyId, LOCAL_FOLDER_KEYS.shadowDecisions, shard);
        } catch (err) {
          if (!isMissingShadowFileError(err)) {
            ctx.logger.warn("model-selection: shadow decision emit aborted \u2014 could not read existing log", {
              error: String(err)
            });
            return;
          }
          existing = "";
        }
        const lines = existing.split("\n").filter((line) => line.trim().length > 0);
        lines.push(...records.map((record3) => JSON.stringify(record3)));
        const pairAlignedCap = Math.max(2, config.shadowEmit.shardMaxRecords - config.shadowEmit.shardMaxRecords % 2);
        const capped = lines.length > pairAlignedCap ? lines.slice(-pairAlignedCap) : lines;
        try {
          await ctx.localFolders.writeTextAtomic(
            companyId,
            LOCAL_FOLDER_KEYS.shadowDecisions,
            shard,
            capped.join("\n") + "\n"
          );
        } catch (err) {
          ctx.logger.warn("model-selection: shadow decision emit failed", { error: String(err) });
          return;
        }
        try {
          const listing = await ctx.localFolders.list(companyId, LOCAL_FOLDER_KEYS.shadowDecisions);
          const shards = listing.entries.filter((entry) => entry.kind === "file" && SHADOW_SHARD_PATTERN.test(entry.name)).map((entry) => entry.name).sort();
          const excess = shards.length - Math.max(1, config.shadowEmit.retentionShards);
          for (let i = 0; i < excess; i++) {
            await ctx.localFolders.deleteFile(companyId, LOCAL_FOLDER_KEYS.shadowDecisions, shards[i]);
          }
        } catch (err) {
          ctx.logger.warn("model-selection: shadow shard retention skipped", { error: String(err) });
        }
      };
      const emitDecisionPair = (companyId, records) => {
        const previous = decisionEmitChains.get(companyId) ?? Promise.resolve();
        const next = previous.catch(() => {
        }).then(() => emitDecisionPairSerialized(companyId, records));
        decisionEmitChains.set(companyId, next);
        return next;
      };
      const laneHttp = {
        fetch: (url, init) => ctx.http.fetch(url, init)
      };
      const reworkSignalsKey = (companyId) => ({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.reworkSignals
      });
      const readReworkSignals = async (companyId) => {
        const stored = asRecord3(await ctx.state.get(reworkSignalsKey(companyId)));
        return Array.isArray(stored.signals) ? stored.signals : [];
      };
      const scoresKey = (companyId) => ({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.modelScores
      });
      const classificationHttp = {
        fetch: (url, init) => ctx.http.fetch(url, init)
      };
      const classificationExclusionsKey = (companyId) => ({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.classificationExclusions
      });
      const readClassificationExclusions = async (companyId) => {
        const stored = asRecord3(await ctx.state.get(classificationExclusionsKey(companyId)));
        const out = {};
        for (const [issueId, excluded] of Object.entries(stored)) {
          if (excluded === true) out[issueId] = true;
        }
        return out;
      };
      const classifierLabeledKey = (companyId) => ({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.classifierLabeledIssues
      });
      const readClassifierLabeled = async (companyId) => {
        const stored = asRecord3(await ctx.state.get(classifierLabeledKey(companyId)));
        const out = {};
        for (const [issueId, tier2] of Object.entries(stored)) {
          if (typeof tier2 === "string" && TIERS.includes(tier2)) out[issueId] = tier2;
        }
        return out;
      };
      const readCardLedger = async (companyId) => {
        const stored = asRecord3(await ctx.state.get(scoresKey(companyId)));
        const ledger = asRecord3(stored.cardLedger);
        return ledger;
      };
      const readModelScores = async (companyId) => {
        const stored = asRecord3(await ctx.state.get(scoresKey(companyId)));
        const scores = Array.isArray(stored.modelScores) ? stored.modelScores : [];
        const byModelId = {};
        for (const score2 of scores) byModelId[score2.modelId] = score2;
        return byModelId;
      };
      const shadowDiffsKey = (companyId) => ({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.shadowDiffs
      });
      const dispatchLastFiringKey = (companyId) => ({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.dispatchLastFiring
      });
      const activePinsWeightByLane = async (companyId, models) => {
        const rows = await ctx.db.query(
          `select assignee_adapter_overrides->'adapterConfig'->>'model' as pinned_model
             from issues
            where company_id = $1
              and status in ('todo','in_progress')
              and assignee_adapter_overrides->'adapterConfig'->>'model' is not null`,
          [companyId]
        );
        const weightByLane = {};
        for (const row of rows) {
          const r = asRecord3(row);
          const rawModelId = typeof r.pinned_model === "string" ? r.pinned_model : null;
          const modelId = resolveConfiguredModelId(rawModelId, models);
          const model = models.find((m) => m.id === modelId);
          if (!model || !model.laneId) continue;
          const weight = blendedListPrice(model) < 1 ? 0.5 : 1;
          weightByLane[model.laneId] = (weightByLane[model.laneId] ?? 0) + weight;
        }
        return weightByLane;
      };
      const aaSnapshotKey = () => ({
        scopeKind: "instance",
        stateKey: PLUGIN_STATE_KEYS.aaIndexSnapshot
      });
      const aaSnapshotHistoryKey = () => ({
        scopeKind: "instance",
        stateKey: PLUGIN_STATE_KEYS.aaSnapshotHistory
      });
      const readAaSnapshot = async () => {
        const stored = asRecord3(await ctx.state.get(aaSnapshotKey()));
        return {
          fetchedAt: typeof stored.fetchedAt === "string" ? stored.fetchedAt : null,
          bySlug: asRecord3(stored.bySlug),
          lastAttemptAt: typeof stored.lastAttemptAt === "string" ? stored.lastAttemptAt : null,
          lastError: typeof stored.lastError === "string" ? stored.lastError : null
        };
      };
      const appendAaSnapshotHistory = async (entry) => {
        const stored = asRecord3(await ctx.state.get(aaSnapshotHistoryKey()));
        const existing = Array.isArray(stored.entries) ? stored.entries : [];
        const next = [...existing, entry].slice(-AA_SNAPSHOT_HISTORY_LIMIT);
        await ctx.state.set(aaSnapshotHistoryKey(), { entries: next });
      };
      const aaDriftSurfacedKey = (companyId) => ({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.aaDriftSurfaced
      });
      const readAaDriftSurfaced = async (companyId) => {
        const stored = asRecord3(await ctx.state.get(aaDriftSurfacedKey(companyId)));
        return new Set(Array.isArray(stored.keys) ? stored.keys : []);
      };
      const aaHttp = {
        fetch: (url, init) => ctx.http.fetch(url, init)
      };
      const readLastRunContextUsage = async (companyId, issueId, logRoot) => {
        try {
          const rows = await ctx.db.query(LAST_RUN_CONTEXT_USAGE_SQL, [companyId, issueId]);
          if (!Array.isArray(rows)) throw new Error("Malformed history result");
          if (rows.length === 0) return {
            lastRunPeakTokens: null,
            history: "no-history",
            runId: null,
            evidence: "no-finalized-run"
          };
          return await readRunContextEvidence(rows[0], companyId, logRoot);
        } catch {
          return {
            lastRunPeakTokens: null,
            history: "unavailable",
            runId: null,
            evidence: "history-read-failed"
          };
        }
      };
      const loadContextUsage = (companyId, issueId, logRoot, cache) => {
        if (!cache) return readLastRunContextUsage(companyId, issueId, logRoot);
        const key = `${companyId}:${issueId}`;
        const memo = cache.get(key);
        if (memo) return memo;
        const pending = readLastRunContextUsage(companyId, issueId, logRoot);
        cache.set(key, pending);
        return pending;
      };
      const describeIssue = async (companyId, issueId, supplied, contextUsageCache) => {
        const issue = await ctx.issues.get(issueId, companyId);
        if (!issue) return null;
        const overrides = asRecord3(issue.assigneeAdapterOverrides);
        const adapterConfig = asRecord3(overrides.adapterConfig);
        const existingOverrideEnv = asRecord3(adapterConfig.env);
        const pinnedModelId = typeof adapterConfig.model === "string" ? adapterConfig.model : null;
        const labels = issue.labels ?? [];
        const labelNames = labels.map((label) => label.name).filter((name) => typeof name === "string");
        const scheduledRetryStatus = issue.scheduledRetry?.status ?? null;
        const isIdle = !issue.checkoutRunId && !issue.executionRunId && scheduledRetryStatus !== "queued" && scheduledRetryStatus !== "running";
        let agentFloorModelId = null;
        let agentName = null;
        let agentEnv = null;
        let agentAdapterType = null;
        let agentAdapterConfig = null;
        const assigneeAgentId = issue.assigneeAgentId;
        if (typeof assigneeAgentId === "string") {
          try {
            const agent = await ctx.agents.get(assigneeAgentId, companyId);
            const agentRecord = asRecord3(agent);
            const config = asRecord3(agentRecord.adapterConfig);
            if (typeof config.model === "string") agentFloorModelId = config.model;
            agentEnv = asRecord3(config.env);
            agentAdapterConfig = config;
            if (typeof agentRecord.adapterType === "string") agentAdapterType = agentRecord.adapterType;
            if (typeof agentRecord.name === "string") agentName = agentRecord.name;
          } catch {
          }
        }
        const exclusionRaw = asRecord3(supplied.exclusion);
        const descriptor = {
          issueId,
          labelNames,
          pinnedModelId,
          agentFloorModelId,
          // TOG-8108: adapter-compatibility gate (`devin/*` vs `claude_local`)
          // and the earn-in guard (priority + review/gate title) both read
          // these. Recorded from the issue/agent rows, never inferred.
          agentAdapterType,
          priority: typeof issue.priority === "string" ? issue.priority : null,
          title: String(issue.title ?? ""),
          agentName,
          // Sticky is derived from the pin: if the issue is already pinned, the
          // run is already on that model and a change would reset the session.
          stickyModelId: pinnedModelId,
          requiredCapabilities: Array.isArray(supplied.requiredCapabilities) ? supplied.requiredCapabilities : void 0,
          // Only the CALLER-supplied value is eager. The measured fallback
          // needs the `heartbeat_runs` read, so callers that want it await
          // `contextUsage()` and set this themselves (`advise`, `repinPass`) —
          // the passes that only decide repinnability never pay for it.
          requiredContextTokens: typeof supplied.requiredContextTokens === "number" ? supplied.requiredContextTokens : void 0,
          // TOG-3210: the caller's PAPERCLIP_WAKE_REASON for this run, if any.
          // Feeds SelectionConfig.wakeScopedFloor only — resolveTier() never
          // reads it, so it can never change the card's own judged tier.
          wakeReason: typeof supplied.wakeReason === "string" ? supplied.wakeReason : void 0,
          ...typeof exclusionRaw.excluded === "boolean" ? {
            exclusion: {
              excluded: exclusionRaw.excluded,
              reasons: Array.isArray(exclusionRaw.reasons) ? exclusionRaw.reasons : []
            }
          } : {}
        };
        const existingLabelIds = issue.labelIds ?? labels.map((label) => label.id).filter((id) => typeof id === "string");
        return {
          descriptor,
          status: String(issue.status ?? ""),
          hasOverride: Object.keys(overrides).length > 0,
          existingLabelIds,
          hasTierLabel: labelNames.some((name) => name.startsWith(TIER_LABEL_PREFIX)),
          hasOperatorPin: labelNames.includes(OPERATOR_PIN_LABEL),
          isIdle,
          title: String(issue.title ?? ""),
          identifier: typeof issue.identifier === "string" ? issue.identifier : null,
          assigneeAgentId: typeof assigneeAgentId === "string" ? assigneeAgentId : null,
          assigneeUserId: typeof issue.assigneeUserId === "string" && issue.assigneeUserId.length > 0 ? issue.assigneeUserId : null,
          description: String(issue.description ?? ""),
          agentEnv,
          agentAdapterType,
          agentAdapterConfig,
          existingOverrideEnv,
          contextUsage: (logRoot) => loadContextUsage(companyId, issueId, logRoot, contextUsageCache)
        };
      };
      const aaFreeSyncSnapshotKey = () => ({
        scopeKind: "instance",
        stateKey: PLUGIN_STATE_KEYS.aaFreeSyncSnapshot
      });
      const readAaFreeSyncSnapshot = async () => {
        const stored = asRecord3(await ctx.state.get(aaFreeSyncSnapshotKey()));
        const snapshot = asRecord3(stored.snapshot);
        return {
          fetchedAt: typeof stored.fetchedAt === "string" ? stored.fetchedAt : null,
          digest: typeof stored.digest === "string" ? stored.digest : null,
          snapshot: Array.isArray(snapshot.rows) && typeof snapshot.retrievedAt === "string" ? stored.snapshot : null,
          lastAttemptAt: typeof stored.lastAttemptAt === "string" ? stored.lastAttemptAt : null,
          lastError: typeof stored.lastError === "string" ? stored.lastError : null,
          nextEligibleAt: typeof stored.nextEligibleAt === "string" ? stored.nextEligibleAt : null
        };
      };
      const aaFreeSyncDiffKey = (companyId) => ({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.aaFreeSyncDiff
      });
      const buildAaFreeEvidence = async (input) => {
        if (!input.config.aaFreeSync.enabled) return null;
        if (input.config.aaFreeSync.bindings.length === 0) return null;
        if (!input.decision.modelId) return null;
        const selected = input.config.models.find((model) => model.id === input.decision.modelId);
        if (!selected) return null;
        const stored = await readAaFreeSyncSnapshot();
        if (!stored.snapshot || !stored.digest || !stored.fetchedAt) return null;
        const maxAgeMs = input.config.aaFreeSync.maxSnapshotAgeHours * 60 * 60 * 1e3;
        const stale = !isSnapshotFresh(stored.fetchedAt, Date.now(), maxAgeMs);
        return buildAdviseEvidence({
          bindings: input.config.aaFreeSync.bindings.map((b) => ({
            candidateId: b.candidateId,
            modelId: b.modelId,
            laneId: b.laneId,
            evaluatedEffort: b.evaluatedEffort,
            aaSlug: b.aaSlug,
            ...b.observationalOnly !== void 0 ? { observationalOnly: b.observationalOnly } : {}
          })),
          snapshot: stored.snapshot,
          digest: stored.digest,
          stale,
          // ModelEntry.laneId is optional; the sync view requires the key.
          model: { id: selected.id, laneId: selected.laneId ?? null, fallbackOnly: selected.fallbackOnly, enabled: selected.enabled },
          adapterType: input.agentAdapterType,
          requestedEffort: selected.effort ?? null,
          inheritedEffort: inheritedEffortFrom(input.agentAdapterType, input.agentAdapterConfig)
        });
      };
      const advise = async (companyId, params, allowExplore = true, forceTier, suppressSticky = false, contextUsageCache) => {
        const issueId = typeof params.issueId === "string" ? params.issueId : null;
        if (!issueId) return null;
        const config = await companyConfig(companyId);
        const described = await describeIssue(companyId, issueId, params, contextUsageCache);
        if (!described) return null;
        const selectionDescriptor = {
          ...described.descriptor,
          ...forceTier ? { pinnedModelId: null, labelNames: [`${TIER_LABEL_PREFIX}${forceTier}`] } : {},
          ...suppressSticky ? { stickyModelId: null } : {}
        };
        const { profiles, signals } = await readProfiles(companyId);
        const laneLedger = await readLaneLedger(companyId);
        const pacingActive = config.pacing.mode !== "off";
        const profileTier = resolveTier(
          selectionDescriptor,
          config.models,
          config.selection.defaultTier,
          {
            isLaneUnserviceable: (model) => pacingActive && hardStopExcluded(laneLedger, model)
          }
        ).tier;
        const profile = profiles.find((entry) => entry.tier === profileTier) ?? null;
        const usage = await described.contextUsage(config.selection.contextRunLogRoot);
        const contextEstimate = estimateIssueContext({
          explicitTokens: typeof params.requiredContextTokens === "number" ? params.requiredContextTokens : void 0,
          lastRunPeakTokens: usage.lastRunPeakTokens,
          history: usage.history,
          fleetCeilingTokens: config.selection.fleetContextCeilingTokens
        });
        selectionDescriptor.requiredContextTokens = contextEstimate.tokens ?? void 0;
        const nowIso = (/* @__PURE__ */ new Date()).toISOString();
        const overrides = await readOperatorOverrides(companyId);
        const liveOverride = activeOperatorOverride(overrides, issueId, nowIso);
        const cardLedger = await readCardLedger(companyId);
        const modelScores = await readModelScores(companyId);
        const laneOutageOverride = await readLaneOutage(companyId);
        const zaiPaceOverride = await readZaiPaceOverride(companyId);
        const now = Date.now();
        const pinsWeightByLane = config.pacing.mode !== "off" ? await activePinsWeightByLane(companyId, config.models) : {};
        const decision = selectModel({
          descriptor: selectionDescriptor,
          config: {
            enforcementEnabled: selectionWritesAllowed(config),
            defaultTier: config.selection.defaultTier,
            // TOG-2988: the roster's hand-placed tier is overlaid with the tier
            // `refreshScores` derived from the model's posterior. Unscored models
            // and scores from a superseded spec version keep the configured tier.
            models: applyDerivedTiers(config.models, modelScores),
            holdOnUntrustedProfile: config.selection.holdOnUntrustedProfile,
            stickyWithinIssue: config.selection.stickyModelWithinIssue,
            pacingMode: config.pacing.mode,
            laneLedger,
            slotFloorFraction: config.pacing.slotFloorFraction,
            operatorOverrideModelId: liveOverride?.modelId ?? null,
            laneAvoidConfig: config.pacing.avoid,
            codexLaneId: config.pacing.codexLaneId,
            opencodeGoLaneId: config.pacing.opencodeGoLaneId,
            zaiLaneId: config.pacing.zai.laneId,
            laneOutageOverride,
            laneRoom: {
              capPerAccount: config.pacing.laneCapPerAccount,
              activePinsWeightByLane: pinsWeightByLane,
              fiveHourWindowName: config.pacing.fiveHourWindowName,
              zaiLaneId: config.pacing.zai.laneId,
              zaiWeeklyWindowName: config.pacing.zai.weeklyWindowName,
              zaiWeeklyDefaultMargin: config.pacing.zai.weeklyDefaultMargin,
              zaiPaceOverrideMargin: activeZaiPaceOverride(zaiPaceOverride, new Date(now).toISOString()),
              now
            },
            objective: config.selection.objective,
            modelScores,
            allowExplore,
            holdOnUnknownAvailability: config.selection.holdOnUnknownAvailability,
            wakeScopedFloor: config.wakeScopedFloor
          },
          profiles,
          signals,
          now,
          cardLedger,
          availability: await readAvailability(companyId, now),
          laneEvidence: await readLaneEvidence(companyId, config.models, now)
        });
        decision.trace.push(
          `context: source=${contextEstimate.source} tokens=${contextEstimate.tokens ?? "unknown"} run=${usage.runId ?? "none"} evidence=${usage.evidence}`
        );
        const v2Evidence = await buildAaFreeEvidence({
          companyId,
          config,
          decision,
          agentAdapterType: described.agentAdapterType,
          agentAdapterConfig: described.agentAdapterConfig
        });
        if (v2Evidence) decision.aaEffortEvidence = v2Evidence;
        const pinnedModelId = resolveConfiguredModelId(
          described.descriptor.pinnedModelId,
          config.models
        );
        const pinnedModel = config.models.find((model) => model.id === pinnedModelId);
        const isServiceabilityHardStop = config.pacing.mode !== "off" && !!pinnedModel && hardStopExcluded(laneLedger, pinnedModel);
        await ctx.metrics.write(`model_selection.decision.${decision.outcome}`, 1);
        for (const note of decision.availability.excluded) {
          await ctx.metrics.write(`model_selection.lane_excluded.${note.term}`, 1);
        }
        if (decision.availability.selectedOnUnknownLane) {
          await ctx.metrics.write("model_selection.lane_unknown_selected", 1);
        }
        if (decision.shadowDiff) {
          const stored = asRecord3(await ctx.state.get(shadowDiffsKey(companyId)));
          const existing = Array.isArray(stored.records) ? stored.records : [];
          const cutoffMs = Date.now() - 7 * 24 * 60 * 60 * 1e3;
          const records = [
            ...existing.filter((r) => r.atMs >= cutoffMs),
            { ...decision.shadowDiff, atMs: Date.now() }
          ];
          await ctx.state.set(shadowDiffsKey(companyId), { records });
        }
        if (config.shadowEmit.enabled) {
          const recordInput = {
            issueId,
            issueIdentifier: described.identifier,
            nowIso,
            decision,
            descriptor: selectionDescriptor,
            status: described.status,
            hasOverride: described.hasOverride,
            hasOperatorPin: described.hasOperatorPin,
            isIdle: described.isIdle,
            models: config.models,
            laneLedger,
            slotFloorFraction: config.pacing.slotFloorFraction,
            windowNames: {
              weekly: config.pacing.weeklyWindowName,
              fiveHour: config.pacing.fiveHourWindowName
            },
            operatorOverride: liveOverride
          };
          await emitDecisionPair(companyId, [buildHostRecord(recordInput), buildShadowRecord(recordInput)]);
        }
        if (config.accountAdmissionShadow.enabled && params.admissionShadow !== void 0) {
          try {
            const report = reportDecisionAdmissionShadow(
              params.admissionShadow,
              now,
              decision.candidates.map((candidate) => ({
                modelId: candidate.modelId,
                lane: config.models.find((model) => model.id === candidate.modelId)?.laneId ?? null
              }))
            );
            if (report) await ctx.state.set({
              scopeKind: "company",
              scopeId: companyId,
              stateKey: PLUGIN_STATE_KEYS.admissionShadowReport
            }, { issueId, evaluatedAt: now, report });
          } catch {
            ctx.logger.warn("model-selection: account admission shadow failed; selection unchanged");
          }
        }
        const ancillaryModelId = cheapestHealthyModelIdForTier({
          models: config.models,
          tier: "T3",
          ledger: laneLedger,
          laneOutageOverride,
          nowIso,
          modelScores,
          laneAvoidConfig: config.pacing.avoid,
          pacingMode: config.pacing.mode
        });
        return {
          decision,
          issueId,
          status: described.status,
          hasOverride: described.hasOverride,
          existingLabelIds: described.existingLabelIds,
          hasTierLabel: described.hasTierLabel,
          hasOperatorPin: described.hasOperatorPin,
          isIdle: described.isIdle,
          isServiceabilityHardStop,
          nowIso,
          config,
          title: described.title,
          identifier: described.identifier,
          agentFloorModelId: described.descriptor.agentFloorModelId ?? null,
          pinnedModelId: described.descriptor.pinnedModelId ?? null,
          agentEnv: described.agentEnv,
          agentAdapterType: described.agentAdapterType,
          agentAdapterConfig: described.agentAdapterConfig,
          existingOverrideEnv: described.existingOverrideEnv,
          ancillaryModelId,
          assigneeAgentId: described.assigneeAgentId
        };
      };
      ctx.tools.register(
        TOOL_NAMES.advise,
        {
          displayName: "Advise a model for an issue",
          description: "Return the tier judgement and costed candidates for one issue. Writes nothing.",
          parametersSchema: {
            type: "object",
            properties: {
              issueId: { type: "string" },
              admissionShadow: { type: "object", description: "Optional non-secret, report-only account snapshot; requires accountAdmissionShadow.enabled." },
              wakeReason: {
                type: "string",
                description: "TOG-3210. Pass the run's PAPERCLIP_WAKE_REASON here so a cheap re-check (e.g. a monitor tick) can get a lower advisory floor without ever changing the card's own tier \u2014 see wakeScopedFloor config."
              }
            }
          }
        },
        async (params, runCtx) => {
          const result = await advise(runCtx.companyId, asRecord3(params));
          if (!result) return { content: "Issue not found, or issueId was missing.", data: toolRejection("issue-not-found") };
          await raiseOrClearTierExhaustedAlarm(
            runCtx.companyId,
            result.issueId,
            result.title,
            result.identifier,
            result.decision,
            runCtx.agentId ?? null
          );
          return { content: summary(result.decision), data: result.decision };
        }
      );
      ctx.tools.register(
        TOOL_NAMES.apply,
        {
          displayName: "Apply a model selection to an issue",
          description: "Advise, then write the per-issue override and tier label when enforcement is on. No-ops on an issue that already has an override.",
          parametersSchema: {
            type: "object",
            properties: {
              issueId: { type: "string" },
              admissionShadow: { type: "object", description: "Optional non-secret, report-only account snapshot; requires accountAdmissionShadow.enabled." },
              wakeReason: {
                type: "string",
                description: "TOG-3210. A wake-scoped decision is always forced advisory, so passing this on `apply` never writes a lowered tier \u2014 it only ever affects the returned recommendation for this call."
              }
            }
          }
        },
        async (params, runCtx) => {
          const result = await advise(runCtx.companyId, asRecord3(params));
          if (!result) return { content: "Issue not found, or issueId was missing.", data: toolRejection("issue-not-found") };
          await raiseOrClearTierExhaustedAlarm(
            runCtx.companyId,
            result.issueId,
            result.title,
            result.identifier,
            result.decision,
            runCtx.agentId ?? null
          );
          const paceRepinEligible = result.hasOverride && result.config.pacing.mode === "enforce";
          const repinHistory = paceRepinEligible ? await readPaceRepinHistory(runCtx.companyId) : {};
          const plan = planApply(
            result.decision,
            {
              hasExistingOverride: result.hasOverride,
              // Read from the issue's actual labels, not from the judgement
              // source. An issue can carry a tier label that did NOT key this
              // decision (an override outranks it), and inferring "has a label"
              // from "the label decided it" would re-add a duplicate.
              hasExistingTierLabel: result.hasTierLabel,
              status: result.status,
              // TOG-12305. Consulted only when the pin path declines: an
              // existing override that binds secret refs the assignee does not
              // carry cannot start a run, so it is rebuilt on the SAME model.
              envRepair: {
                pinnedModelId: result.pinnedModelId,
                staleSecretRefKeys: staleOverrideSecretRefKeys(result.existingOverrideEnv, result.agentEnv)
              },
              ...paceRepinEligible ? {
                paceRepin: {
                  hasOperatorPin: result.hasOperatorPin,
                  isIdle: result.isIdle,
                  lastRepinAt: repinHistory[result.issueId] ?? null,
                  now: result.nowIso,
                  idleRepinHysteresisSeconds: result.config.pacing.idleRepinHysteresisSeconds,
                  isServiceabilityHardStop: result.isServiceabilityHardStop
                }
              } : {}
            },
            result.issueId
          );
          if (!plan.write || !plan.modelId) {
            return { content: `No write: ${plan.reason}`, data: { decision: result.decision, plan } };
          }
          const selectedModel = recoverSelectedCandidate(result.config.models, {
            modelId: plan.modelId,
            aaEffortEvidence: result.decision.aaEffortEvidence
          });
          if (!selectedModel) {
            return {
              content: `No write: selected model ${plan.modelId} is absent from the resolved roster`,
              data: { decision: result.decision, plan }
            };
          }
          const patch = modelOverrideForContext({
            model: selectedModel,
            agentEnvContextTokens: result.config.selection.agentEnvContextTokens,
            compactionRatio: result.config.selection.compactionRatio,
            agentEnv: result.agentEnv,
            agentAdapterType: result.agentAdapterType,
            agentAdapterConfig: result.agentAdapterConfig,
            existingOverrideEnv: result.existingOverrideEnv,
            cheapModelId: result.ancillaryModelId,
            provenance: fallbackPinProvenance(selectedModel, result.assigneeAgentId)
          });
          let labelNote = "";
          if (plan.labelName && result.decision.effectiveTier) {
            const labelId = result.config.tierLabelIds[result.decision.effectiveTier];
            if (labelId) {
              patch.labelIds = [.../* @__PURE__ */ new Set([...result.existingLabelIds, labelId])];
            } else {
              labelNote = ` (no configured label id for ${plan.labelName}; override written without it)`;
            }
          }
          await ctx.issues.update(
            result.issueId,
            patch,
            runCtx.companyId,
            { actorAgentId: runCtx.agentId ?? null, actorRunId: runCtx.runId ?? null }
          );
          await recordFallbackPin(runCtx.companyId, result.issueId, patch);
          if (plan.envRepairOnly) {
            await ctx.activity.log({
              companyId: runCtx.companyId,
              message: `Model Selection repaired the env of its ${plan.modelId} pin on this issue (model unchanged)`,
              entityType: "issue",
              entityId: result.issueId,
              metadata: {
                modelId: plan.modelId,
                staleSecretRefKeys: staleOverrideSecretRefKeys(result.existingOverrideEnv, result.agentEnv),
                trigger: "apply"
              }
            });
            return { content: plan.reason, data: { decision: result.decision, plan } };
          }
          await ctx.activity.log({
            companyId: runCtx.companyId,
            message: `Model Selection pinned ${result.decision.modelId} (${result.decision.effectiveTier}) on this issue`,
            entityType: "issue",
            entityId: result.issueId,
            metadata: {
              modelId: result.decision.modelId,
              tier: result.decision.effectiveTier,
              tierSource: result.decision.judgement.source,
              trace: result.decision.trace
            }
          });
          if (paceRepinEligible) {
            await ctx.state.set(paceRepinHistoryKey(runCtx.companyId), {
              ...repinHistory,
              [result.issueId]: result.nowIso
            });
          }
          return { content: plan.reason + labelNote, data: { decision: result.decision, plan } };
        }
      );
      ctx.tools.register(
        TOOL_NAMES.setOperatorOverride,
        {
          displayName: "Set an operator override for an issue",
          description: "Record a time-boxed override: `model_selection_advise`/`apply` will route this issue to the named model ahead of pace ordering and slot throttling, until it expires. It never bypasses a capability gate, tier floor/ceiling, the untrusted-profile hold, or a serviceability hard stop.",
          parametersSchema: {
            type: "object",
            required: ["issueId", "modelId"],
            properties: {
              issueId: { type: "string" },
              modelId: { type: "string" },
              ttlSeconds: { type: "integer", minimum: 1 }
            }
          }
        },
        async (params, runCtx) => {
          const supplied = asRecord3(params);
          const issueId = typeof supplied.issueId === "string" ? supplied.issueId : null;
          const modelId = typeof supplied.modelId === "string" ? supplied.modelId : null;
          if (!issueId || !modelId) {
            return { content: "issueId and modelId are both required.", data: toolRejection("missing-params") };
          }
          const config = await companyConfig(runCtx.companyId);
          const configuredModelId = resolveConfiguredModelId(modelId, config.models);
          if (!configuredModelId) {
            return {
              content: `modelId ${modelId} is not a configured roster entry.`,
              data: toolRejection("unknown-model", { modelId })
            };
          }
          const ttlSeconds = typeof supplied.ttlSeconds === "number" && supplied.ttlSeconds > 0 ? supplied.ttlSeconds : config.pacing.operatorOverrideTtlSeconds;
          const nowIso = (/* @__PURE__ */ new Date()).toISOString();
          const existing = await readOperatorOverrides(runCtx.companyId);
          const updated = recordOperatorOverride(existing, issueId, configuredModelId, nowIso, ttlSeconds);
          await ctx.state.set(operatorOverridesKey(runCtx.companyId), updated);
          const entry = updated[issueId];
          return {
            content: `operator override recorded: ${issueId} -> ${configuredModelId}, expires ${entry.expiresAt}`,
            data: entry
          };
        }
      );
      ctx.tools.register(
        TOOL_NAMES.setLaneOutage,
        {
          displayName: "Declare or clear a lane outage",
          description: "TOG-2481 port of lane_outage.json: declare a telemetry-invisible outage on named lanes/models until an ISO timestamp, or clear it by omitting both lanes and models.",
          parametersSchema: {
            type: "object",
            required: ["until"],
            properties: {
              lanes: { type: "array", items: { type: "string" } },
              models: { type: "array", items: { type: "string" } },
              until: { type: "string" },
              reason: { type: "string" }
            }
          }
        },
        async (params, runCtx) => {
          const supplied = asRecord3(params);
          const lanes = Array.isArray(supplied.lanes) ? supplied.lanes.filter((l) => typeof l === "string") : [];
          const models = Array.isArray(supplied.models) ? supplied.models.filter((m) => typeof m === "string") : [];
          const until = typeof supplied.until === "string" ? supplied.until : null;
          if (!until) return { content: "until is required (ISO-8601 UTC timestamp).", data: toolRejection("missing-until") };
          if (lanes.length === 0 && models.length === 0) {
            await ctx.state.set(laneOutageKey(runCtx.companyId), null);
            return { content: "lane outage cleared.", data: { ok: true, cleared: true } };
          }
          const reason = typeof supplied.reason === "string" ? supplied.reason : void 0;
          const override = { lanes, models, until, ...reason ? { reason } : {} };
          await ctx.state.set(laneOutageKey(runCtx.companyId), override);
          return { content: `lane outage recorded: ${[...lanes, ...models].join(", ")} until ${until}`, data: override };
        }
      );
      ctx.tools.register(
        TOOL_NAMES.setZaiPaceOverride,
        {
          displayName: "Set or clear the Z.ai weekly-pace margin override",
          description: "TOG-2481 port of zai_pace_override.json: temporarily widen (or tighten) the margin zaiWeeklyPaceOk allows above elapsed-week fraction, e.g. during a Codex outage. Clear by omitting margin.",
          parametersSchema: {
            type: "object",
            required: ["until"],
            properties: {
              margin: { type: "number", minimum: 0, maximum: 1 },
              until: { type: "string" }
            }
          }
        },
        async (params, runCtx) => {
          const supplied = asRecord3(params);
          const until = typeof supplied.until === "string" ? supplied.until : null;
          if (!until) return { content: "until is required (ISO-8601 UTC timestamp).", data: toolRejection("missing-until") };
          if (typeof supplied.margin !== "number") {
            await ctx.state.set(zaiPaceOverrideKey(runCtx.companyId), null);
            return { content: "zai pace override cleared.", data: { ok: true, cleared: true } };
          }
          const override = { margin: supplied.margin, until };
          await ctx.state.set(zaiPaceOverrideKey(runCtx.companyId), override);
          return { content: `zai pace override recorded: margin ${supplied.margin} until ${until}`, data: override };
        }
      );
      ctx.tools.register(
        TOOL_NAMES.tierPolicy,
        {
          displayName: TIER_POLICY_TOOL_DISPLAY_NAME,
          description: TIER_POLICY_TOOL_DESCRIPTION,
          parametersSchema: TIER_POLICY_TOOL_PARAMETERS
        },
        async (params, runCtx) => {
          const result = prepareTierPolicyEdit(asRecord3(params), {
            agentId: typeof runCtx?.agentId === "string" ? runCtx.agentId : null,
            runId: typeof runCtx?.runId === "string" ? runCtx.runId : null
          });
          ctx.logger.info("tier policy proposal", {
            auditId: result.auditId,
            action: result.action,
            outcome: result.outcome,
            baseSource: result.baseSource,
            baseRevision: result.baseRevision,
            proposedRevision: result.proposedRevision,
            issueCodes: result.issues.map((i) => i.code),
            changedPaths: result.diff.length,
            companyId: runCtx?.companyId ?? null,
            agentId: runCtx?.agentId ?? null,
            runId: runCtx?.runId ?? null
          });
          return { content: renderTierPolicyEditResult(result), data: result };
        }
      );
      const appendReworkSignal = async (companyId, signal) => {
        const existing = await readReworkSignals(companyId);
        const cutoffMs = Date.now() - SCORE_WINDOW_DAYS * 2 * 24 * 60 * 60 * 1e3;
        const pruned = existing.filter((s) => s.atMs >= cutoffMs);
        await ctx.state.set(reworkSignalsKey(companyId), { signals: [...pruned, signal] });
      };
      ctx.events.on("issue.updated", async (event) => {
        const payload = asRecord3(event.payload);
        const changes = asRecord3(payload.changes);
        const issueId = typeof event.entityId === "string" ? event.entityId : null;
        if (issueId) runIssueCache.invalidate(runIssueKey(event.companyId, issueId));
        const assignment = asRecord3(changes.assigneeAgentId);
        const assignedTo = typeof assignment.to === "string" ? assignment.to : null;
        const assignedFrom = typeof assignment.from === "string" ? assignment.from : null;
        if (issueId && assignedTo && assignment.from == null) {
          try {
            await pinAtDecisionTime(event.companyId, issueId, "issue.updated:assignment");
          } catch (cause) {
            ctx.logger.error("assignment-time pin failed", {
              companyId: event.companyId,
              issueId,
              error: cause instanceof Error ? cause.message : String(cause)
            });
          }
        } else if (issueId && assignedTo && assignedFrom && assignedFrom !== assignedTo) {
          try {
            await rehomePinOnReassignment(event.companyId, issueId, assignedFrom, assignedTo);
          } catch (cause) {
            ctx.logger.error("reassignment pin re-home failed", {
              companyId: event.companyId,
              issueId,
              error: cause instanceof Error ? cause.message : String(cause)
            });
          }
        }
        const status = asRecord3(changes.status);
        const from = typeof status.from === "string" ? status.from : null;
        const to = typeof status.to === "string" ? status.to : null;
        if (!issueId || from !== "done" || to === "done" || to === "cancelled" || !to) return;
        await appendReworkSignal(event.companyId, {
          issueId,
          atMs: Date.parse(event.occurredAt) || Date.now(),
          kind: "reopen",
          excludeAgentId: null
        });
      });
      const REJECTION_RE = /request(ed)? changes|^## *(rejected|fail|blocked by review)|not accepted|changes requested|re-?do this|does not pass review/i;
      ctx.events.on("issue.comment.created", async (event) => {
        const payload = asRecord3(event.payload);
        const snippet = typeof payload.bodySnippet === "string" ? payload.bodySnippet : "";
        if (!REJECTION_RE.test(snippet)) return;
        const issueId = typeof event.entityId === "string" ? event.entityId : null;
        if (!issueId) return;
        await appendReworkSignal(event.companyId, {
          issueId,
          atMs: Date.parse(event.occurredAt) || Date.now(),
          kind: "rejected",
          excludeAgentId: typeof event.actorId === "string" ? event.actorId : null
        });
      });
      const maybeLogUnpinnableCard = async (companyId, issueId, identifier, decision) => {
        if (!decision) return;
        if (decision.outcome !== "no-eligible-model" && decision.outcome !== "tier-exhausted") return;
        const key = {
          scopeKind: "company",
          scopeId: companyId,
          stateKey: PLUGIN_STATE_KEYS.noEligibleNotices
        };
        const stored = asRecord3(await ctx.state.get(key));
        const rawLast = stored[issueId];
        if (typeof rawLast === "string") {
          const lastAtMs = Date.parse(rawLast);
          if (!Number.isNaN(lastAtMs) && Date.now() - lastAtMs < NO_ELIGIBLE_NOTICE_THROTTLE_MS) return;
        }
        const laneLedger = await readLaneLedger(companyId);
        const laneStates = Object.values(laneLedger).map(
          (entry) => `${entry.laneId}=${entry.verdict ?? "?"}@${Math.round(laneEffectiveUtilization(laneLedger, entry.laneId) * 100)}%${entry.error ? "(poll-error)" : ""}`
        ).join(" ");
        const pruned = {};
        for (const [id, at] of Object.entries(stored)) {
          if (typeof at === "string" && Date.now() - Date.parse(at) < 7 * 24 * 60 * 60 * 1e3) pruned[id] = at;
        }
        await ctx.state.set(key, { ...pruned, [issueId]: (/* @__PURE__ */ new Date()).toISOString() });
        const rejectionSummary = decision.rejections.slice(0, 8).map((entry) => `${entry.modelId} [${entry.stage}]: ${entry.reason}`).join("; ");
        const nextAction = decision.outcome === "tier-exhausted" ? "The router can retry when lane capacity recovers." : "The router can retry when eligibility evidence changes or expires; lane recovery alone may not resolve this.";
        await ctx.activity.log({
          companyId,
          message: `Model Selection cannot pin this card: ${decision.outcome}. Rejections: ${rejectionSummary || "see decision trace"}. Lane states: ${laneStates || "no lane data"}. ${nextAction}`,
          entityType: "issue",
          entityId: issueId,
          metadata: {
            outcome: decision.outcome,
            identifier,
            rejections: decision.rejections,
            lanes: Object.values(laneLedger).map((entry) => ({
              laneId: entry.laneId,
              verdict: entry.verdict,
              error: entry.error
            })),
            trace: decision.trace
          }
        });
      };
      const runResolveActive = (config) => config.runResolve.enabled && selectionWritesAllowed(config);
      const classificationsInFlight = /* @__PURE__ */ new Map();
      const trackClassification = (issueId, work) => {
        const tracked = work.catch(() => null).finally(() => {
          if (classificationsInFlight.get(issueId) === tracked) classificationsInFlight.delete(issueId);
        });
        classificationsInFlight.set(issueId, tracked);
        return tracked;
      };
      const pinAtDecisionTime = async (companyId, issueId, source) => {
        const receivedAtMs = Date.now();
        const config = await companyConfig(companyId);
        if (!config.classification.enabled) return;
        const described = await describeIssue(companyId, issueId, {});
        if (!described) return;
        if (!described.assigneeAgentId) return;
        if (!balanceOpenStatuses.has(described.status)) return;
        if (described.hasOperatorPin) return;
        if (described.descriptor.pinnedModelId) return;
        const runScoped = runResolveActive(config);
        const heuristicTier = resolveTier(described.descriptor, config.models, config.selection.defaultTier).tier;
        const firstPinnedModelId = await pinAtTier(companyId, issueId, described.identifier, source, config, {
          tier: heuristicTier,
          expectedPinnedModelId: null,
          receivedAtMs
        });
        if (described.hasTierLabel) return;
        const labelTier = await trackClassification(
          issueId,
          classifyForPin(companyId, issueId, described, config, source)
        );
        if (runScoped) return;
        if (!labelTier || labelTier === heuristicTier) return;
        await pinAtTier(companyId, issueId, described.identifier, source, config, {
          tier: labelTier,
          expectedPinnedModelId: firstPinnedModelId,
          receivedAtMs
        });
      };
      const classifyForPin = async (companyId, issueId, described, config, source) => {
        if (!config.classification.baseUrl || !config.classification.modelId) return null;
        let apiKey = null;
        if (config.classification.apiKeySecretRef) {
          try {
            apiKey = await ctx.secrets.resolve(config.classification.apiKeySecretRef, {
              companyId,
              configPath: "classification.apiKeySecretRef"
            });
          } catch {
            ctx.logger.error("creation-pin classification secret unavailable", { companyId, issueId });
            return null;
          }
        }
        const classified = await callClassifier(
          {
            baseUrl: config.classification.baseUrl,
            protocol: config.classification.protocol,
            modelId: config.classification.modelId,
            apiKey,
            system: RUBRIC,
            userPrompt: buildClassificationPrompt(
              described.title,
              described.description,
              described.descriptor.agentName ?? "",
              config.classification.descriptionChars
            ),
            maxOutputTokens: config.classification.maxOutputTokens,
            requestTimeoutMs: config.classification.requestTimeoutMs,
            maxResponseBytes: config.classification.maxResponseBytes
          },
          classificationHttp
        );
        if (!classified.text) {
          ctx.logger.info("creation-pin classification skipped", {
            companyId,
            issueId,
            why: classified.error
          });
          return null;
        }
        const judgement = parseClassificationResponse(classified.text);
        if (!judgement) {
          ctx.logger.info("creation-pin classification unparseable", { companyId, issueId });
          return null;
        }
        const { labelTier } = resolveClassifiedTiers(judgement, {
          t3ConfidenceFloor: config.classification.t3ConfidenceFloor,
          t2ConfidenceFloor: config.classification.t2ConfidenceFloor
        });
        const labelId = config.tierLabelIds[labelTier];
        if (labelId) {
          await ctx.issues.update(
            issueId,
            { labelIds: [.../* @__PURE__ */ new Set([...described.existingLabelIds, labelId])] },
            companyId
          );
        }
        if (judgement.exclusion) {
          const exclusions = await readClassificationExclusions(companyId);
          await ctx.state.set(classificationExclusionsKey(companyId), { ...exclusions, [issueId]: true });
        }
        await ctx.activity.log({
          companyId,
          message: `Model Selection classified this issue as ${labelTier} (confidence ${judgement.confidence})${judgement.exclusion ? ", capability-excluded" : ""} at card creation`,
          entityType: "issue",
          entityId: issueId,
          metadata: {
            tier: labelTier,
            confidence: judgement.confidence,
            reason: judgement.reason,
            source
          }
        });
        return labelTier;
      };
      const pinAtTier = async (companyId, issueId, identifier, source, config, attempt) => {
        if (runResolveActive(config)) return null;
        const { tier: tier2, expectedPinnedModelId, receivedAtMs } = attempt;
        const isRepin = expectedPinnedModelId !== null;
        const result = await advise(companyId, { issueId }, false, tier2, isRepin);
        if (!result || result.decision.outcome !== "selected" || !result.decision.modelId) {
          await maybeLogUnpinnableCard(companyId, issueId, identifier, result?.decision ?? null);
          return null;
        }
        if (!balanceOpenStatuses.has(result.status)) return null;
        const currentPinnedModelId = resolveConfiguredModelId(result.pinnedModelId, config.models) ?? result.pinnedModelId;
        if (currentPinnedModelId !== expectedPinnedModelId) return null;
        if (!await pinnableBeforeStart(companyId, issueId)) {
          if (isRepin) {
            ctx.logger.info("classified tier applies from next boundary: run already started", {
              companyId,
              issueId,
              source,
              tier: tier2
            });
          }
          return null;
        }
        if (result.decision.modelId === expectedPinnedModelId) return null;
        const floorModelId = resolveConfiguredModelId(result.agentFloorModelId, config.models);
        if (result.decision.modelId === floorModelId) {
          ctx.logger.info("creation-time pin skipped: pick equals floor", { companyId, issueId, source });
          return null;
        }
        const selectedModel = recoverSelectedCandidate(config.models, result.decision);
        if (!selectedModel) return null;
        if (!await creationWriteStillSafe(companyId, issueId, config.models, expectedPinnedModelId)) return null;
        const writesAllowed = selectionWritesAllowed(config);
        if (writesAllowed) {
          const creationPatch = modelOverrideForContext({
            model: selectedModel,
            agentEnvContextTokens: config.selection.agentEnvContextTokens,
            compactionRatio: config.selection.compactionRatio,
            agentEnv: result.agentEnv,
            agentAdapterType: result.agentAdapterType,
            agentAdapterConfig: result.agentAdapterConfig,
            existingOverrideEnv: result.existingOverrideEnv,
            provenance: fallbackPinProvenance(selectedModel, result.assigneeAgentId)
          });
          await ctx.issues.update(issueId, creationPatch, companyId);
          await recordFallbackPin(companyId, issueId, creationPatch);
        }
        const latencyMs = Date.now() - receivedAtMs;
        if (writesAllowed) {
          const afterRows = await ctx.db.query(CREATION_PIN_LIVE_RUNS_SQL, [
            companyId,
            issueId
          ]);
          if (afterRows.some((row) => {
            const run = asRecord3(row);
            return run.status !== "queued" || run.started_at != null;
          })) {
            ctx.logger.info("creation-time pin landed after run start (applies from next run)", {
              companyId,
              issueId,
              source
            });
          }
        } else {
          ctx.logger.info("creation-time pin skipped: advisory selection, nothing written", {
            companyId,
            issueId,
            source,
            modelId: result.decision.modelId
          });
        }
        await ctx.activity.log({
          companyId,
          // TOG-8108: name the card that was actually pinned. This message
          // hardcoded TOG-3111 (the card that built this path), so every
          // creation-time pin pointed at the wrong card.
          message: isRepin ? `Model Selection re-pinned ${expectedPinnedModelId} -> ${result.decision.modelId} (${result.decision.effectiveTier}) after classification, before the first run started \u2014 ${identifier ?? issueId} (${source})${writesAllowed ? "" : " \u2014 advisory, nothing written"}` : `Model Selection pinned ${result.decision.modelId} (${result.decision.effectiveTier}) at card creation \u2014 ${identifier ?? issueId} (${source})${writesAllowed ? "" : " \u2014 advisory, nothing written"}`,
          entityType: "issue",
          entityId: issueId,
          metadata: {
            modelId: result.decision.modelId,
            tier: result.decision.effectiveTier,
            source,
            phase: isRepin ? "classified-repin" : "first-pin",
            ...isRepin ? { from: expectedPinnedModelId } : {},
            latencyMs,
            identifier,
            trace: result.decision.trace,
            // TOG-12206 P2: the served leg of the v2 identity — which
            // curated candidate this pin actually served (null on legacy).
            candidateId: selectedModel.candidateId,
            // TOG-12431: present only when the gate above skipped the write.
            ...writesAllowed ? {} : { advisory: true, written: false }
          }
        });
        return writesAllowed ? selectedModel.id : null;
      };
      ctx.events.on("issue.created", async (event) => {
        const issueId = typeof event.entityId === "string" ? event.entityId : null;
        if (!issueId) return;
        runIssueCache.invalidate(runIssueKey(event.companyId, issueId));
        try {
          await pinAtDecisionTime(event.companyId, issueId, "issue.created");
        } catch (cause) {
          ctx.logger.error("creation-time pin failed", {
            companyId: event.companyId,
            issueId,
            error: cause instanceof Error ? cause.message : String(cause)
          });
        }
      });
      const RUN_RESOLVE_DEADLINE_MARGIN_MS = 150;
      const RUN_RESOLVE_ISSUE_TTL_MS = 15e3;
      const RUN_RESOLVE_AGENT_TTL_MS = 6e4;
      const RUN_RESOLVE_PEAK_TTL_MS = 10 * 6e4;
      const RUN_RESOLVE_CACHE_ENTRIES = 5e3;
      const logRunResolveRefreshError = (key, error) => {
        ctx.logger.warn("run-resolve cache refresh failed; serving stale", {
          key,
          error: error instanceof Error ? error.message : String(error)
        });
      };
      const runSnapshotCache = new HotCache({
        ttlMs: 45e3,
        maxEntries: 64,
        onRefreshError: logRunResolveRefreshError
      });
      const runIssueCache = new HotCache({
        ttlMs: RUN_RESOLVE_ISSUE_TTL_MS,
        maxEntries: RUN_RESOLVE_CACHE_ENTRIES,
        onRefreshError: logRunResolveRefreshError
      });
      const runAgentCache = new HotCache({
        ttlMs: RUN_RESOLVE_AGENT_TTL_MS,
        maxEntries: 1e3,
        onRefreshError: logRunResolveRefreshError
      });
      const runPeakCache = new HotCache({
        ttlMs: RUN_RESOLVE_PEAK_TTL_MS,
        maxEntries: RUN_RESOLVE_CACHE_ENTRIES,
        onRefreshError: logRunResolveRefreshError
      });
      const runDecisionCache = new HotCache({
        ttlMs: Number.MAX_SAFE_INTEGER,
        maxEntries: RUN_RESOLVE_CACHE_ENTRIES
      });
      const runSnapshotKey = (companyId) => companyId;
      const runIssueKey = (companyId, issueId) => `${companyId}:${issueId}`;
      invalidateRunSnapshot = (companyId) => runSnapshotCache.invalidate(runSnapshotKey(companyId));
      const loadRunResolveSnapshot = async (companyId) => {
        const config = await companyConfig(companyId);
        const loadedAtMs = Date.now();
        if (!runResolveActive(config) || config.models.length === 0) {
          return {
            config,
            profiles: [],
            signals: [],
            laneLedger: {},
            operatorOverrides: {},
            cardLedger: {},
            modelScores: {},
            laneOutageOverride: null,
            zaiPaceOverride: null,
            pinsWeightByLane: {},
            availabilityRaw: null,
            laneEvidence: { lanes: [], windowHours: LANE_EVIDENCE_WINDOW_HOURS, unreadableReason: "snapshot not loaded" },
            loadedAtMs
          };
        }
        const [
          { profiles, signals },
          laneLedger,
          operatorOverrides,
          cardLedger,
          modelScores,
          laneOutageOverride,
          zaiPaceOverride,
          availabilityRaw,
          laneEvidence,
          pinsWeightByLane
        ] = await Promise.all([
          readProfiles(companyId),
          readLaneLedger(companyId),
          readOperatorOverrides(companyId),
          readCardLedger(companyId),
          readModelScores(companyId),
          readLaneOutage(companyId),
          readZaiPaceOverride(companyId),
          ctx.state.get(laneAvailabilityKey(companyId)),
          readLaneEvidence(companyId, config.models, loadedAtMs),
          config.pacing.mode !== "off" ? runLaneWeights(companyId, config.models) : Promise.resolve({})
        ]);
        return {
          config,
          profiles,
          signals,
          laneLedger,
          operatorOverrides,
          cardLedger,
          modelScores,
          laneOutageOverride,
          zaiPaceOverride,
          pinsWeightByLane,
          availabilityRaw,
          laneEvidence,
          loadedAtMs
        };
      };
      const runLaneWeights = async (companyId, models) => {
        const weights = await activePinsWeightByLane(companyId, models);
        const rows = await ctx.db.query(ACTIVE_ROUTED_RUN_MODELS_SQL, [companyId]);
        for (const row of rows) {
          const rawModelId = asRecord3(row).routed_model;
          const modelId = resolveConfiguredModelId(typeof rawModelId === "string" ? rawModelId : null, models);
          const model = models.find((candidate) => candidate.id === modelId);
          if (!model || !model.laneId) continue;
          weights[model.laneId] = (weights[model.laneId] ?? 0) + (blendedListPrice(model) < 1 ? 0.5 : 1);
        }
        return weights;
      };
      const loadRunIssueFacts = async (companyId, issueId) => {
        const issue = await ctx.issues.get(issueId, companyId);
        if (!issue) return null;
        return {
          labelNames: (issue.labels ?? []).map((label) => label.name).filter((name) => typeof name === "string"),
          priority: typeof issue.priority === "string" ? issue.priority : null,
          title: String(issue.title ?? ""),
          status: String(issue.status ?? "")
        };
      };
      const loadRunAgentFacts = async (companyId, agentId) => {
        const agent = asRecord3(await ctx.agents.get(agentId, companyId));
        if (Object.keys(agent).length === 0) return null;
        return {
          name: typeof agent.name === "string" ? agent.name : null,
          adapterConfig: asRecord3(agent.adapterConfig)
        };
      };
      const parseDecisionRecord = (raw, decisionId) => {
        const record3 = asRecord3(typeof raw === "string" ? safeJsonParse(raw) : raw);
        if (record3.decisionId !== decisionId || typeof record3.model !== "string" || record3.model.length === 0) return null;
        const tier2 = typeof record3.tier === "string" && TIERS.includes(record3.tier) ? record3.tier : null;
        return { decisionId, model: record3.model, tier: tier2, fallback: record3.fallback === true };
      };
      const readPriorDecision = async (params, budgetMs) => {
        const previous = params.previous;
        if (!previous || !previous.decisionId || !previous.model) return null;
        const cached = runDecisionCache.peek(previous.decisionId);
        if (cached) return cached.value;
        const degraded = {
          decisionId: previous.decisionId,
          model: previous.model,
          tier: null,
          fallback: false
        };
        const read = (async () => {
          const rows = await ctx.db.query(PREVIOUS_RUN_DECISION_SQL, [params.companyId, previous.runId]);
          return parseDecisionRecord(asRecord3(rows[0]).model_decision, previous.decisionId);
        })().catch(() => null);
        const record3 = await withinMs(read, budgetMs, null);
        if (!record3) return degraded;
        runDecisionCache.set(previous.decisionId, record3);
        return record3;
      };
      const fireAndForget = (work, what) => {
        work.catch((error) => {
          ctx.logger.warn(`run-resolve ${what} failed`, { error: error instanceof Error ? error.message : String(error) });
        });
      };
      const resolveRunModel = async (params) => {
        const startedAt = performance.now();
        const elapsed = () => performance.now() - startedAt;
        const budgetMs = Math.max(50, params.deadlineMs - RUN_RESOLVE_DEADLINE_MARGIN_MS);
        const remaining = () => Math.max(0, budgetMs - elapsed());
        const finish = (result, outcome) => {
          fireAndForget(
            Promise.all([
              ctx.metrics.write("model_selection.run_resolve.latency_ms", Math.round(elapsed() * 100) / 100),
              ctx.metrics.write(`model_selection.run_resolve.${outcome}`, 1)
            ]),
            "metrics"
          );
          return result;
        };
        let deferRetryMs = 5e3;
        try {
          if (!params.issueId) return finish({ kind: "keep" }, "keep.non_issue");
          const issueId = params.issueId;
          const companyId = params.companyId;
          const snapshotRead = await runSnapshotCache.get(
            runSnapshotKey(companyId),
            () => loadRunResolveSnapshot(companyId),
            remaining()
          );
          const snapshot = snapshotRead.value;
          const { config } = snapshot;
          deferRetryMs = config.runResolve.deferRetryMs;
          runSnapshotCache.setTtl(config.runResolve.snapshotTtlMs);
          if (snapshotRead.stale) fireAndForget(Promise.resolve(ctx.metrics.write("model_selection.run_resolve.stale_snapshot", 1)), "metrics");
          if (!runResolveActive(config)) return finish({ kind: "keep" }, "keep.inactive");
          if (params.issueOverrideModel) return finish({ kind: "keep" }, "keep.override");
          const [issueRead, agentRead] = await Promise.all([
            runIssueCache.get(runIssueKey(companyId, issueId), () => loadRunIssueFacts(companyId, issueId), remaining()),
            runAgentCache.get(`${companyId}:${params.agentId}`, () => loadRunAgentFacts(companyId, params.agentId), remaining())
          ]);
          const issue = issueRead.value;
          const agent = agentRead.value;
          if (!issue) return finish({ kind: "keep" }, "keep.issue_unreadable");
          if (!agent) {
            return finish({ kind: "defer", retryAfterMs: deferRetryMs, reason: "assignee agent is unreadable" }, "defer");
          }
          let classifiedTier = null;
          const hasTierLabel = issue.labelNames.some((name) => name.startsWith(TIER_LABEL_PREFIX));
          const inFlight = hasTierLabel ? void 0 : classificationsInFlight.get(issueId);
          if (inFlight) {
            classifiedTier = await withinMs(
              inFlight,
              Math.min(config.runResolve.classifierWaitMs, Math.max(0, remaining() - 50)),
              null
            );
          }
          const prior = await readPriorDecision(params, Math.min(100, remaining()));
          const peak = runPeakCache.peek(runIssueKey(companyId, issueId))?.value ?? null;
          const resolution = resolveRunDecision({
            params,
            issue,
            agent,
            snapshot,
            prior,
            classifiedTier,
            lastRunPeakTokens: peak,
            now: Date.now()
          });
          if (resolution.kind === "keep") return finish({ kind: "keep" }, "keep.engine");
          if (resolution.kind === "defer") {
            return finish({ kind: "defer", retryAfterMs: deferRetryMs, reason: resolution.reason }, "defer");
          }
          const { result } = resolution;
          runDecisionCache.set(result.decisionId, {
            decisionId: result.decisionId,
            model: result.model,
            tier: resolution.tier,
            fallback: result.fallback === true
          });
          if ((prior || params.previous) && !runPeakCache.peek(runIssueKey(companyId, issueId))) {
            fireAndForget(
              runPeakCache.refresh(runIssueKey(companyId, issueId), async () => {
                const usage = await loadContextUsage(companyId, issueId, config.selection.contextRunLogRoot);
                return usage.lastRunPeakTokens;
              }),
              "context warm"
            );
          }
          fireAndForget(Promise.resolve(ctx.metrics.write(`model_selection.run_resolve.tier_source.${resolution.tierSource}`, 1)), "metrics");
          if (resolution.switch) {
            const change = resolution.switch;
            fireAndForget(
              ctx.activity.log({
                companyId,
                message: `Model Selection ${change.reason === "first-decision" ? "decided" : "switched"} the run model ${change.from ?? "(default)"} -> ${change.to} (${resolution.tier}, ${resolution.tierSource}): ${change.reason} \u2014 ${change.detail}`,
                entityType: "issue",
                entityId: issueId,
                metadata: {
                  runId: params.runId,
                  decisionId: result.decisionId,
                  from: change.from,
                  to: change.to,
                  reason: change.reason,
                  detail: change.detail,
                  tier: resolution.tier,
                  tierSource: resolution.tierSource,
                  fallback: result.fallback === true,
                  trace: resolution.trace
                }
              }),
              "switch activity"
            );
          }
          return finish(result, "decide");
        } catch (error) {
          const reason = error instanceof HotCacheTimeout ? `hot cache cold: ${error.message}` : `internal error: ${error instanceof Error ? error.message : String(error)}`;
          ctx.logger.warn("run-resolve deferred", { runId: params.runId, reason });
          return finish({ kind: "defer", retryAfterMs: deferRetryMs, reason }, "defer");
        }
      };
      runResolveHandler = resolveRunModel;
      ctx.jobs.register(JOB_KEYS.refreshRunResolve, async () => {
        for (const company of listKnownCompanies()) {
          await runSnapshotCache.refresh(runSnapshotKey(company.id), () => loadRunResolveSnapshot(company.id));
        }
      });
      ctx.tools.register(
        TOOL_NAMES.ancillaryDrift,
        {
          displayName: "Report ancillary model pin drift",
          description: "Report which agents' ancillary model pins disagree with the lane-aware T3 recommendation. Read-only.",
          parametersSchema: { type: "object" }
        },
        async (_params, runCtx) => {
          const config = await companyConfig(runCtx.companyId);
          if (config.models.length === 0) {
            return { content: "Model Selection is not configured for this company.", data: { recommendedModelId: null, drift: [] } };
          }
          const { profiles, signals } = await readProfiles(runCtx.companyId);
          const laneLedger = await readLaneLedger(runCtx.companyId);
          const decision = recommendAncillaryModel({
            config: {
              models: config.models,
              holdOnUntrustedProfile: config.selection.holdOnUntrustedProfile,
              pacingMode: config.pacing.mode,
              laneLedger,
              slotFloorFraction: config.pacing.slotFloorFraction
            },
            profiles,
            signals,
            now: Date.now()
          });
          if (decision.outcome !== "selected" && decision.outcome !== "held-at-floor") {
            return {
              content: `No ancillary recommendation: ${summary(decision)}`,
              data: { recommendedModelId: null, decision, drift: [] }
            };
          }
          const recommendedModelId = decision.modelId;
          const drift = [];
          let offset = 0;
          const pageSize = 200;
          for (; ; ) {
            const page = await ctx.agents.list({ companyId: runCtx.companyId, limit: pageSize, offset });
            for (const agent of page) {
              drift.push(
                ...ancillaryDriftForAgent(
                  {
                    id: agent.id,
                    name: agent.name,
                    adapterConfig: asRecord3(agent.adapterConfig)
                  },
                  recommendedModelId,
                  config.models
                )
              );
            }
            if (page.length < pageSize) break;
            offset += pageSize;
          }
          await ctx.metrics.write("model_selection.ancillary_drift.count", drift.length);
          const content = drift.length === 0 ? `No ancillary drift: every reported ancillary surface already matches the recommended ${recommendedModelId}.` : `${drift.length} ancillary surface${drift.length === 1 ? "" : "s"} drifted from the recommended ${recommendedModelId}.`;
          return { content, data: { recommendedModelId, decision, drift } };
        }
      );
      ctx.tools.register(
        TOOL_NAMES.aaDriftReport,
        {
          displayName: "aa.ai drift report",
          description: "Per-model aa.ai Intelligence Index: the roster's configured value and snapshot date, alongside the latest fetched live value and whether it now implies a different tier. Read-only \u2014 never writes tier/enablement.",
          parametersSchema: { type: "object" }
        },
        async (_params, runCtx) => {
          const config = await companyConfig(runCtx.companyId);
          const snapshot = await readAaSnapshot();
          const knownSlugs = new Set(Object.keys(snapshot.bySlug));
          const rows = config.models.map((model) => {
            const slug = resolveAaSlug(model.id, knownSlugs, model.aaSlug ?? null);
            const liveRecord = slug ? snapshot.bySlug[slug] ?? null : null;
            const liveIndex = liveRecord?.intelligenceIndex ?? null;
            const configuredImpliedTier = model.aaIndex === null ? null : tierImpliedByIndex(model.aaIndex);
            const liveImpliedTier = liveIndex === null ? null : tierImpliedByIndex(liveIndex);
            return {
              modelId: model.id,
              configuredIndex: model.aaIndex,
              configuredAsOf: model.aaIndexUpdatedAt ?? null,
              liveIndex,
              liveAsOf: snapshot.fetchedAt,
              delta: model.aaIndex !== null && liveIndex !== null ? liveIndex - model.aaIndex : null,
              crossesBoundary: liveIndex !== null && configuredImpliedTier !== liveImpliedTier,
              // TOG-2438 scope expansion: full-record fields, surface only —
              // never fed back into tier/enablement decisions.
              aaCostPerTask: liveRecord?.intelligenceIndexCostPerTask ?? null,
              aaPriceIn: liveRecord?.price1mInputTokens ?? null,
              aaPriceOut: liveRecord?.price1mOutputTokens ?? null,
              aaTokensPerSec: liveRecord?.medianOutputTokensPerSecond ?? null,
              aaTtftSeconds: liveRecord?.medianTimeToFirstTokenSeconds ?? null,
              aaContextWindow: liveRecord?.contextWindowTokens ?? null,
              aaTerminalbenchHard: liveRecord?.terminalbenchHard ?? null,
              aaTau2: liveRecord?.tau2 ?? null,
              aaIfbench: liveRecord?.ifbench ?? null,
              aaGpqa: liveRecord?.gpqa ?? null,
              aaHle: liveRecord?.hle ?? null,
              aaEffort: slug ? effortSuffixOf(slug) : null,
              aaSnapshotAt: liveRecord ? snapshot.fetchedAt : null
            };
          });
          return {
            content: `${rows.length} models; snapshot ${snapshot.fetchedAt ?? "never fetched"}${snapshot.lastError ? ` (last attempt error: ${snapshot.lastError})` : ""}`,
            data: { snapshot: { fetchedAt: snapshot.fetchedAt, lastAttemptAt: snapshot.lastAttemptAt, lastError: snapshot.lastError }, rows }
          };
        }
      );
      ctx.jobs.register(JOB_KEYS.refreshProfiles, async () => {
        const companies = listKnownCompanies();
        for (const company of companies) {
          try {
            const config = await companyConfig(company.id);
            if (config.models.length === 0) continue;
            const rows = await ctx.db.query(
              `select usage_json->>'model' as model,
                      (usage_json->>'inputTokens')::numeric as input_tokens,
                      (usage_json->>'cachedInputTokens')::numeric as cached_input_tokens,
                      (usage_json->>'outputTokens')::numeric as output_tokens
                 from heartbeat_runs
                where company_id = $1
                  and started_at > now() - ($2 || ' days')::interval
                  and status = 'succeeded'
                  and (usage_json->>'costUsd')::numeric > 0`,
              [company.id, String(config.profiles.windowDays)]
            );
            const runRows = (Array.isArray(rows) ? rows : []).map((row) => {
              const r = asRecord3(row);
              return {
                model: typeof r.model === "string" ? r.model : null,
                inputTokens: Number(r.input_tokens ?? 0),
                cachedInputTokens: Number(r.cached_input_tokens ?? 0),
                outputTokens: Number(r.output_tokens ?? 0)
              };
            });
            const computedAt = (/* @__PURE__ */ new Date()).toISOString();
            const profiles = buildVolumeProfiles(runRows, config.models, computedAt);
            const existing = await readProfiles(company.id);
            await ctx.state.set(profilesKey(company.id), {
              profiles,
              // Quality signals are refreshed by their own measurement path;
              // preserve whatever is stored rather than zeroing it here, which
              // would silently drop the escalation term to zero.
              signals: existing.signals
            });
            ctx.logger.info("volume profiles refreshed", {
              companyId: company.id,
              tiers: profiles.map((p) => `${p.tier}:${p.sampleCount}`).join(",")
            });
          } catch (cause) {
            ctx.logger.error("volume profile refresh failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause)
            });
          }
        }
      });
      ctx.jobs.register(JOB_KEYS.pollLanes, async () => {
        const companies = listKnownCompanies();
        for (const company of companies) {
          try {
            const config = await companyConfig(company.id);
            if (config.pacing.lanes.length === 0) continue;
            const secretFailures = [];
            const sources = [];
            const fetchedAt = (/* @__PURE__ */ new Date()).toISOString();
            for (const [laneIndex, lane] of config.pacing.lanes.entries()) {
              let apiKey = null;
              if (lane.apiKeySecretRef) {
                try {
                  apiKey = await ctx.secrets.resolve(lane.apiKeySecretRef, {
                    companyId: company.id,
                    // Must match the array-index path plugin-secrets-handler.ts's
                    // extractSecretRefBindingsFromConfig binds on config write
                    // (TOG-2500) — a laneId-keyed path here reads back nothing
                    // because syncSecretRefsForTarget replaceAll wipes non-matching rows.
                    configPath: `pacing.lanes.${laneIndex}.apiKeySecretRef`
                  });
                } catch {
                  secretFailures.push({ laneId: lane.laneId, fetchedAt, verdict: null, observation: null, error: "lane-secret-unavailable" });
                  continue;
                }
              }
              sources.push({
                laneId: lane.laneId,
                statusUrl: lane.statusUrl,
                requestTimeoutMs: lane.requestTimeoutMs,
                maxResponseBytes: lane.maxResponseBytes,
                lane: lane.lane,
                policy: lane.policy,
                apiKey
              });
            }
            const results = await pollLanes({
              sources,
              http: laneHttp,
              now: () => (/* @__PURE__ */ new Date()).toISOString()
            });
            let ledger = await readLaneLedger(company.id);
            for (const result of [...results, ...secretFailures]) {
              ledger = mergeLedgerEntry(ledger, result);
            }
            await ctx.state.set(laneLedgerKey(company.id), ledger);
            try {
              const stored = await ctx.state.get({
                scopeKind: "company",
                scopeId: company.id,
                stateKey: PLUGIN_STATE_KEYS.tierPollOutcomes
              });
              const outcomes = accumulateTierPollOutcomes(
                normalizeTierPollOutcomes(stored),
                [...results, ...secretFailures].map((result) => ({
                  laneId: result.laneId,
                  error: result.error,
                  serviceable: result.verdict?.serviceable ?? null
                })),
                config.models,
                fetchedAt
              );
              await ctx.state.set(
                {
                  scopeKind: "company",
                  scopeId: company.id,
                  stateKey: PLUGIN_STATE_KEYS.tierPollOutcomes
                },
                outcomes
              );
            } catch (cause) {
              ctx.logger.warn("tier poll outcome counters not updated", {
                companyId: company.id,
                error: cause instanceof Error ? cause.message : String(cause)
              });
            }
            const availabilityDocument = availabilityDocumentFrom({
              results,
              observedAt: fetchedAt
            });
            await ctx.state.set(laneAvailabilityKey(company.id), availabilityDocument);
            ctx.logger.info("lane capacity polled", {
              companyId: company.id,
              lanes: [...results, ...secretFailures].map((r) => `${r.laneId}:${r.verdict?.state ?? "error"}`).join(","),
              availabilityRecords: availabilityDocument.records.length
            });
          } catch (cause) {
            ctx.logger.error("lane capacity poll failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause)
            });
          }
        }
      });
      const runAaIndexRefresh = async () => {
        const nowIso = (/* @__PURE__ */ new Date()).toISOString();
        const previous = await readAaSnapshot();
        const fetched = await fetchAaSnapshot({
          url: AA_LEADERBOARD_URL,
          http: aaHttp,
          timeoutMs: AA_FETCH_TIMEOUT_MS,
          maxResponseBytes: AA_MAX_RESPONSE_BYTES
        });
        let snapshot = previous;
        if (!fetched.ok || !fetched.html) {
          snapshot = { ...previous, lastAttemptAt: nowIso, lastError: fetched.error ?? "aa-fetch-failed" };
          await ctx.state.set(aaSnapshotKey(), snapshot);
          ctx.logger.error("aa.ai snapshot fetch failed; keeping prior snapshot", {
            error: fetched.error,
            previousFetchedAt: previous.fetchedAt
          });
        } else {
          const parsed = parseAaLeaderboardHtml(fetched.html);
          if (!parsed) {
            snapshot = { ...previous, lastAttemptAt: nowIso, lastError: "aa-parse-failed" };
            await ctx.state.set(aaSnapshotKey(), snapshot);
            ctx.logger.error("aa.ai snapshot parse failed; keeping prior snapshot", {
              previousFetchedAt: previous.fetchedAt
            });
          } else {
            const bySlug = {};
            for (const row of parsed) bySlug[row.slug] = row;
            snapshot = { fetchedAt: nowIso, bySlug, lastAttemptAt: nowIso, lastError: null };
            await ctx.state.set(aaSnapshotKey(), snapshot);
            await appendAaSnapshotHistory({ fetchedAt: nowIso, bySlug });
            ctx.logger.info("aa.ai snapshot refreshed", { fetchedAt: nowIso, models: parsed.length });
          }
        }
        const freshBySlug = new Map(Object.entries(snapshot.bySlug));
        if (freshBySlug.size === 0) {
          return { fetchedAt: snapshot.fetchedAt, error: snapshot.lastError, modelsFetched: 0 };
        }
        const previousBySlug = new Map(Object.entries(previous.bySlug));
        const companies = listKnownCompanies();
        for (const company of companies) {
          try {
            const config = await companyConfig(company.id);
            if (!config.aaSync.enabled || config.models.length === 0) continue;
            const knownSlugs = new Set(freshBySlug.keys());
            const diffInputs = config.models.map((model) => ({
              modelId: model.id,
              previousIndex: model.aaIndex,
              slug: resolveAaSlug(model.id, knownSlugs, model.aaSlug ?? null)
            }));
            const rows = diffSnapshot(diffInputs, freshBySlug, previousBySlug);
            for (const row of rows) {
              if (row.fieldDeltas.length > 0) {
                ctx.logger.info("aa.ai fields changed", {
                  companyId: company.id,
                  modelId: row.modelId,
                  fieldDeltas: row.fieldDeltas
                });
              }
              if (row.delta !== null && row.delta !== 0) {
                ctx.logger.info("aa.ai index changed", {
                  companyId: company.id,
                  modelId: row.modelId,
                  previousIndex: row.previousIndex,
                  freshIndex: row.freshIndex,
                  delta: row.delta
                });
              }
            }
            const crossing = rows.filter((row) => row.crossesBoundary);
            if (crossing.length === 0) continue;
            const surfaced = await readAaDriftSurfaced(company.id);
            let surfacedChanged = false;
            for (const row of crossing) {
              const dedupeKey = `${row.modelId}::${row.freshImpliedTier ?? "none"}`;
              if (surfaced.has(dedupeKey)) continue;
              await ctx.activity.log({
                companyId: company.id,
                message: `aa.ai drift crosses a tier boundary for ${row.modelId} \u2014 re-evaluate, do not auto-apply`,
                entityType: "model",
                entityId: row.modelId,
                metadata: {
                  modelId: row.modelId,
                  previousIndex: row.previousIndex,
                  freshIndex: row.freshIndex,
                  previousImpliedTier: row.previousImpliedTier,
                  freshImpliedTier: row.freshImpliedTier
                }
              });
              surfaced.add(dedupeKey);
              surfacedChanged = true;
            }
            if (surfacedChanged) {
              await ctx.state.set(aaDriftSurfacedKey(company.id), { keys: [...surfaced] });
            }
          } catch (cause) {
            ctx.logger.error("aa.ai drift surfacing failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause)
            });
          }
        }
        return { fetchedAt: snapshot.fetchedAt, error: snapshot.lastError, modelsFetched: freshBySlug.size };
      };
      ctx.jobs.register(JOB_KEYS.refreshAaIndex, async () => {
        await runAaIndexRefresh();
      });
      ctx.tools.register(
        TOOL_NAMES.refreshAaIndexNow,
        {
          displayName: "Refresh aa.ai Intelligence Index now",
          description: "Manually run the aa.ai leaderboard fetch + drift-surfacing sweep instead of waiting for the next scheduled tick. Same logic as the cron job: never writes tier/enabled, only updates the snapshot and logs drift.",
          parametersSchema: { type: "object" }
        },
        async () => {
          const result = await runAaIndexRefresh();
          if (result.error) {
            return { content: `aa.ai refresh attempted but failed: ${result.error}`, data: result };
          }
          return {
            content: `aa.ai snapshot refreshed: ${result.modelsFetched} models, fetched at ${result.fetchedAt}`,
            data: result
          };
        }
      );
      const priceReconcileReportKey = (companyId) => ({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.priceReconcileReport
      });
      const priceDriftSurfacedKey = (companyId) => ({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.priceDriftSurfaced
      });
      const readPriceDriftSurfaced = async (companyId) => {
        const stored = asRecord3(await ctx.state.get(priceDriftSurfacedKey(companyId)));
        return new Set(Array.isArray(stored.keys) ? stored.keys : []);
      };
      const priceHttp = {
        fetch: (url, init) => ctx.http.fetch(url, init)
      };
      const runPriceReconcile = async () => {
        const ranAt = (/* @__PURE__ */ new Date()).toISOString();
        const fetched = await fetchPriceCatalog({
          url: MODELS_DEV_CATALOG_URL,
          userAgent: MODELS_DEV_USER_AGENT,
          http: priceHttp,
          timeoutMs: MODELS_DEV_FETCH_TIMEOUT_MS,
          maxResponseBytes: MODELS_DEV_MAX_RESPONSE_BYTES
        });
        if (!fetched.ok || !fetched.json) {
          const error = fetched.error ?? "price-fetch-failed";
          ctx.logger.error("models.dev fetch failed; keeping the prior price report", { error });
          return { ranAt, error, companies: [] };
        }
        const catalog = parsePriceCatalog(fetched.json);
        if (!catalog) {
          ctx.logger.error("models.dev parse failed; keeping the prior price report", { bytes: fetched.json.length });
          return { ranAt, error: "price-parse-failed", companies: [] };
        }
        const outcome = { ranAt, error: null, companies: [] };
        for (const company of listKnownCompanies()) {
          try {
            const config = await companyConfig(company.id);
            if (!config.priceSync.enabled || config.models.length === 0) continue;
            const rows = config.models.map((model) => ({
              id: model.id,
              laneId: model.laneId ?? null,
              enabled: model.enabled,
              costPerMTokIn: model.costPerMTokIn,
              costPerMTokOut: model.costPerMTokOut,
              costPerMTokCacheRead: model.costPerMTokCacheRead,
              note: model.note
            }));
            const report = reconcilePrices({ rows, catalog, fetchedAt: ranAt });
            await ctx.state.set(priceReconcileReportKey(company.id), { ranAt, report });
            outcome.companies.push({ companyId: company.id, drifted: report.drift.length, checked: report.checked });
            ctx.logger.info("models.dev price reconciliation complete", {
              companyId: company.id,
              checked: report.checked,
              unchanged: report.unchanged,
              drifted: report.drift.length,
              excluded: report.excluded.length,
              unresolved: report.unresolved.length
            });
            const surfaced = await readPriceDriftSurfaced(company.id);
            let surfacedChanged = false;
            for (const row of report.drift) {
              const dedupeKey = `${row.modelId}::${row.fields.map((f) => `${f.field}=${f.feed}`).join(",")}`;
              if (surfaced.has(dedupeKey)) continue;
              await ctx.activity.log({
                companyId: company.id,
                message: `models.dev list price disagrees with the roster for ${row.modelId} (${row.severity}) \u2014 review and apply by hand, this job never writes a price`,
                entityType: "model",
                entityId: row.modelId,
                metadata: {
                  modelId: row.modelId,
                  providerId: row.providerId,
                  enabled: row.enabled,
                  severity: row.severity,
                  maxRatio: row.maxRatio,
                  fields: row.fields,
                  suggestedNote: row.suggestedNote,
                  source: MODELS_DEV_CATALOG_URL,
                  fetchedAt: ranAt,
                  // Stated on every record, because the number itself does not
                  // carry the caveat and somebody will eventually quote it.
                  priceBasis: "vendor list price; not this company's marginal cost under a flat subscription"
                }
              });
              surfaced.add(dedupeKey);
              surfacedChanged = true;
            }
            if (surfacedChanged) {
              await ctx.state.set(priceDriftSurfacedKey(company.id), { keys: [...surfaced] });
            }
          } catch (cause) {
            ctx.logger.error("price reconciliation failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause)
            });
          }
        }
        return outcome;
      };
      ctx.jobs.register(JOB_KEYS.reconcilePrices, async () => {
        await runPriceReconcile();
      });
      const runAaFreeSync = async () => {
        const ranAt = (/* @__PURE__ */ new Date()).toISOString();
        const nowMs = Date.now();
        const empty = { ranAt, fetched: false, error: null, digest: null, companies: [] };
        const enabled = [];
        for (const company of listKnownCompanies()) {
          try {
            const config = await companyConfig(company.id);
            if (config.aaFreeSync.enabled) enabled.push({ id: company.id, config });
          } catch (cause) {
            ctx.logger.error("free-list sync config read failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause)
            });
          }
        }
        if (enabled.length === 0) return empty;
        const previous = await readAaFreeSyncSnapshot();
        let snapshot = previous.snapshot;
        let digest = previous.digest;
        let fetchedAt = previous.fetchedAt;
        let fetchError = null;
        let fetched = false;
        if (shouldFetchFreeSync({ nextEligibleAt: previous.nextEligibleAt }, nowMs)) {
          const provider = enabled.find((entry) => entry.config.aaFreeSync.apiKeySecretRef);
          if (!provider || !provider.config.aaFreeSync.apiKeySecretRef) {
            fetchError = "aa-free-no-credential";
            ctx.logger.error("free-list sync skipped: no enabled company configured aaFreeSync.apiKeySecretRef", {});
          } else {
            let apiKey = null;
            try {
              apiKey = await ctx.secrets.resolve(provider.config.aaFreeSync.apiKeySecretRef, {
                companyId: provider.id,
                configPath: "aaFreeSync.apiKeySecretRef"
              });
            } catch {
              fetchError = "aa-free-secret-unavailable";
              ctx.logger.error("free-list sync secret unavailable; keeping prior snapshot", {
                companyId: provider.id
              });
            }
            if (!fetchError) {
              const result = await fetchAaFreeList({
                http: { fetch: (url, init) => ctx.http.fetch(url, init) },
                apiKey: apiKey ?? "",
                timeoutMs: AA_FREE_FETCH_TIMEOUT_MS,
                maxResponseBytes: AA_FREE_MAX_RESPONSE_BYTES
              });
              const attemptAt = (/* @__PURE__ */ new Date()).toISOString();
              if (!result.ok) {
                const outcome2 = result.error === "aa-access-denied" ? "fatal" : result.error === "aa-rate-limited" ? "rate-limited" : result.retryable ? "retryable" : "fatal";
                fetchError = result.error;
                await ctx.state.set(aaFreeSyncSnapshotKey(), {
                  fetchedAt: previous.fetchedAt,
                  digest: previous.digest,
                  snapshot: previous.snapshot,
                  lastAttemptAt: attemptAt,
                  lastError: result.error,
                  nextEligibleAt: nextEligibleAfter(
                    outcome2,
                    nowMs,
                    result.error === "aa-rate-limited" ? result.retryAfterSeconds : null,
                    { successMs: AA_FREE_FETCH_INTERVAL_MS, retryMs: AA_FREE_RETRY_INTERVAL_MS }
                  )
                });
                ctx.logger.error("free-list sync fetch failed; keeping prior snapshot", { error: result.error });
              } else {
                const parsed = parseAaFreeList(result.text, attemptAt);
                if (!parsed) {
                  fetchError = "aa-free-parse-failed";
                  await ctx.state.set(aaFreeSyncSnapshotKey(), {
                    fetchedAt: previous.fetchedAt,
                    digest: previous.digest,
                    snapshot: previous.snapshot,
                    lastAttemptAt: attemptAt,
                    lastError: fetchError,
                    nextEligibleAt: nextEligibleAfter(
                      "retryable",
                      nowMs,
                      null,
                      { successMs: AA_FREE_FETCH_INTERVAL_MS, retryMs: AA_FREE_RETRY_INTERVAL_MS }
                    )
                  });
                  ctx.logger.error("free-list sync parse failed; keeping prior snapshot", {});
                } else {
                  fetched = true;
                  snapshot = parsed;
                  digest = freeSnapshotDigest(parsed);
                  fetchedAt = attemptAt;
                  await ctx.state.set(aaFreeSyncSnapshotKey(), {
                    fetchedAt,
                    digest,
                    snapshot: parsed,
                    lastAttemptAt: attemptAt,
                    lastError: null,
                    nextEligibleAt: nextEligibleAfter(
                      "ok",
                      nowMs,
                      null,
                      { successMs: AA_FREE_FETCH_INTERVAL_MS, retryMs: AA_FREE_RETRY_INTERVAL_MS }
                    )
                  });
                  ctx.logger.info("free-list sync snapshot refreshed", {
                    fetchedAt,
                    digest,
                    rows: parsed.rows.length
                  });
                }
              }
            }
          }
        }
        const outcome = { ranAt, fetched, error: fetchError, digest, companies: [] };
        for (const { id, config } of enabled) {
          try {
            if (!snapshot || !digest || !fetchedAt) {
              await ctx.state.set(aaFreeSyncDiffKey(id), {
                ranAt,
                digest: null,
                error: fetchError ?? "aa-free-no-snapshot-yet",
                diff: null
              });
              continue;
            }
            const bindings = config.aaFreeSync.bindings.map((b) => ({
              candidateId: b.candidateId,
              modelId: b.modelId,
              laneId: b.laneId,
              evaluatedEffort: b.evaluatedEffort,
              aaSlug: b.aaSlug,
              ...b.observationalOnly !== void 0 ? { observationalOnly: b.observationalOnly } : {}
            }));
            const models = config.models.map((model) => ({
              id: model.id,
              laneId: model.laneId ?? null,
              fallbackOnly: model.fallbackOnly,
              enabled: model.enabled
            }));
            const diff = buildSyncDiff({ bindings, models, snapshot, digest });
            await ctx.state.set(aaFreeSyncDiffKey(id), { ranAt, digest, error: fetchError, diff });
            outcome.companies.push({
              companyId: id,
              verified: diff.verified.length,
              broken: diff.broken.length,
              ambiguous: diff.ambiguous.length,
              unbound: diff.unbound.length
            });
            ctx.logger.info("free-list sync diff complete", {
              companyId: id,
              verified: diff.verified.length,
              broken: diff.broken.length,
              ambiguous: diff.ambiguous.length,
              unbound: diff.unbound.length
            });
          } catch (cause) {
            ctx.logger.error("free-list sync diff failed for a company", {
              companyId: id,
              error: cause instanceof Error ? cause.message : String(cause)
            });
          }
        }
        return outcome;
      };
      ctx.jobs.register(JOB_KEYS.refreshAaFreeSync, async () => {
        await runAaFreeSync();
      });
      ctx.tools.register(
        TOOL_NAMES.aaFreeSyncReport,
        {
          displayName: "aa.ai free-list sync report",
          description: "The last free-list sync diff: which curated model x effort bindings verify against the snapshot, which break and why, which slugs are ambiguous, and which roster rows have no binding. Read-only; writes nothing.",
          parametersSchema: { type: "object" }
        },
        async (_args, toolCtx) => {
          const companyId = toolCtx?.companyId;
          if (!companyId) {
            return { content: "No company scope on this call; cannot read a per-company sync report.", data: toolRejection("missing-company-scope") };
          }
          const stored = asRecord3(await ctx.state.get(aaFreeSyncDiffKey(companyId)));
          const diff = asRecord3(stored.diff);
          if (!stored.diff || !diff || !Array.isArray(diff.verified)) {
            return {
              content: `No free-list sync diff has completed for this company yet. Run ${TOOL_NAMES.refreshAaFreeSyncNow} or wait for the daily job.`,
              data: toolRejection("no-report-yet")
            };
          }
          const lines = [];
          for (const v of diff.verified) {
            lines.push(
              `- verified ${v.binding.candidateId} (${v.binding.modelId} x ${v.binding.laneId} x ${v.binding.evaluatedEffort}): index ${v.aaIndex ?? "unknown"}${v.held ? ` [held: ${v.held}]` : ""}`
            );
          }
          for (const b of diff.broken) {
            lines.push(`- BROKEN ${b.binding.candidateId} (${b.binding.modelId} x ${b.binding.laneId} x ${b.binding.evaluatedEffort}): ${b.reason} \u2014 ${b.detail}`);
          }
          for (const a of diff.ambiguous) {
            lines.push(`- AMBIGUOUS slug ${a.aaSlug}: claimed by ${a.candidateIds.join(", ")}`);
          }
          for (const u of diff.unbound) {
            lines.push(
              `- unbound ${u.modelId} (${u.laneId})${u.suggestedSlug ? `: exact slug ${u.suggestedSlug} is a curation proposal` : ""}${u.familySlugs.length > 0 ? ` [family: ${u.familySlugs.join(", ")}]` : ""}`
            );
          }
          return {
            content: `free-list sync as of ${stored.ranAt ?? "unknown"} (snapshot ${String(stored.digest ?? "none")}): ${diff.verified.length} verified, ${diff.broken.length} broken, ${diff.ambiguous.length} ambiguous, ${diff.unbound.length} unbound, ${diff.unmatchedSlugs.length} unmatched snapshot slugs${diff.unmatchedTruncated > 0 ? ` (+${diff.unmatchedTruncated} truncated)` : ""}${stored.error ? ` [fetch: ${String(stored.error)}]` : ""}.
${lines.join("\n") || "No rows."}
A reviewable diff only \u2014 curate bindings by hand, this job never writes one.`,
            data: { ranAt: stored.ranAt ?? null, digest: stored.digest ?? null, error: stored.error ?? null, diff }
          };
        }
      );
      ctx.tools.register(
        TOOL_NAMES.refreshAaFreeSyncNow,
        {
          displayName: "Refresh aa.ai free-list sync now",
          description: "Run the free-list fetch + per-company diff immediately instead of waiting for the daily tick. Same logic as the cron job, and just as report-only: it never writes a binding, pin, tier, or price.",
          parametersSchema: { type: "object" }
        },
        async () => {
          const result = await runAaFreeSync();
          if (result.error) {
            return { content: `free-list sync attempted but failed: ${result.error}`, data: result };
          }
          const verified = result.companies.reduce((sum, c) => sum + c.verified, 0);
          const broken = result.companies.reduce((sum, c) => sum + c.broken, 0);
          return {
            content: result.companies.length === 0 ? "free-list sync ran: no company has aaFreeSync enabled, so nothing was fetched. Reported only \u2014 nothing was written." : `free-list sync complete: ${verified} verified, ${broken} broken across ${result.companies.length} companies. Reported only \u2014 no binding was written.`,
            data: result
          };
        }
      );
      ctx.tools.register(
        TOOL_NAMES.reconcilePricesNow,
        {
          displayName: "Reconcile roster prices against models.dev now",
          description: "Run the models.dev fetch + price reconciliation immediately instead of waiting for the daily tick. Same logic as the cron job, and just as report-only: it never writes a roster price.",
          parametersSchema: { type: "object" }
        },
        async () => {
          const result = await runPriceReconcile();
          if (result.error) {
            return { content: `models.dev reconciliation failed: ${result.error}`, data: result };
          }
          const drifted = result.companies.reduce((sum, c) => sum + c.drifted, 0);
          const checked = result.companies.reduce((sum, c) => sum + c.checked, 0);
          return {
            content: `models.dev reconciliation complete: ${drifted} of ${checked} priced rows drifted. Reported only \u2014 no price was written.`,
            data: result
          };
        }
      );
      ctx.tools.register(
        TOOL_NAMES.admissionShadowReport,
        {
          displayName: "Account admission shadow report",
          description: "Read the last explicitly enabled account shadow snapshot; never selects, reserves or actuates.",
          parametersSchema: { type: "object", additionalProperties: false }
        },
        async (_args, toolCtx) => {
          if (!toolCtx?.companyId) return { content: "Company scope required.", data: toolRejection("missing-company-scope") };
          const stored = asRecord3(await ctx.state.get({
            scopeKind: "company",
            scopeId: toolCtx.companyId,
            stateKey: PLUGIN_STATE_KEYS.admissionShadowReport
          }));
          return {
            content: stored.report ? "Last caller-supplied account shadow snapshot; no host starts or reservations governed. Check evaluatedAt and observation freshness; this is not a live admission decision." : "No explicitly enabled account shadow snapshot has been recorded.",
            data: stored.report ? stored : toolRejection("no-report-yet")
          };
        }
      );
      ctx.tools.register(
        TOOL_NAMES.tierOutcomes,
        {
          displayName: "Tier poll outcomes",
          description: "Per-tier lane-poll success/fail counters: how many polls each tier's lanes served or missed. Read-only; writes nothing and never changes selection.",
          parametersSchema: { type: "object" }
        },
        async (_args, toolCtx) => {
          const companyId = toolCtx?.companyId;
          if (!companyId) {
            return { content: "No company scope on this call; cannot read per-tier poll outcomes.", data: toolRejection("missing-company-scope") };
          }
          const stored = await ctx.state.get({
            scopeKind: "company",
            scopeId: companyId,
            stateKey: PLUGIN_STATE_KEYS.tierPollOutcomes
          });
          const outcomes = normalizeTierPollOutcomes(stored);
          const lines = Object.keys(outcomes.tiers).map((tier2) => {
            const counter = outcomes.tiers[tier2];
            return `- ${tier2}: ${counter.polls} polls, ${counter.succeeded} served, ${counter.failed} missed${counter.lastAt ? ` (last ${counter.lastAt})` : ""}`;
          });
          return {
            content: `Tier poll outcomes${outcomes.updatedAt ? ` as of ${outcomes.updatedAt}` : " (no lane poll recorded yet)"}.
${lines.join("\n")}
Per-tier lane-poll outcomes \u2014 how often each tier's lanes served. Read-only; not a routing input.`,
            data: { updatedAt: outcomes.updatedAt, tiers: outcomes.tiers }
          };
        }
      );
      ctx.tools.register(
        TOOL_NAMES.acceptedWorkReport,
        {
          displayName: "Accepted-work posterior report",
          description: "Per-cohort accepted-work posteriors: which served model x effort x task-class cohorts have mature accept/rework evidence, and what each cohort's posterior is. Read-only; writes nothing and never changes selection.",
          parametersSchema: { type: "object" }
        },
        async (_args, toolCtx) => {
          const companyId = toolCtx?.companyId;
          if (!companyId) {
            return { content: "No company scope on this call; cannot read the accepted-work overlay.", data: toolRejection("missing-company-scope") };
          }
          const stored = await ctx.state.get({
            scopeKind: "company",
            scopeId: companyId,
            stateKey: PLUGIN_STATE_KEYS.acceptedWorkOverlay
          });
          const overlay = normalizeAcceptedWorkOverlay(stored);
          if (!overlay) {
            return {
              content: "No accepted-work overlay has been produced for this company yet. Enable `acceptedWork` and wait for the scheduled score refresh. Read-only; nothing was written.",
              data: toolRejection("no-report-yet")
            };
          }
          const lines = overlay.cohorts.map((cohort) => {
            const held = cohort.held ? ` [held: ${cohort.held}]` : "";
            const maturity = cohort.proven ? "proven" : `sparse (${cohort.resolved}/8)`;
            return `- ${cohort.servedModel} x ${cohort.servedEffort} x ${cohort.taskClass}: p=${cohort.p.toFixed(3)} (prior ${cohort.priorP.toFixed(3)}), ${cohort.accepted}/${cohort.resolved} accepted, ${cohort.pending} pending, ${maturity}${held}`;
          });
          return {
            content: `Accepted-work posterior as of ${overlay.computedAt} (${overlay.specVersion}): ${overlay.cohorts.length} cohorts, ${overlay.unattributed.closedCardsWithoutClosingRun} closed cards unattributed.
${lines.join("\n") || "No cohorts."}
First-party accepted-work posteriors \u2014 independent review/rework outcomes per served cohort. Read-only; not a routing input.`,
            data: {
              specVersion: overlay.specVersion,
              computedAt: overlay.computedAt,
              cohorts: overlay.cohorts,
              unattributed: overlay.unattributed
            }
          };
        }
      );
      ctx.tools.register(
        TOOL_NAMES.priceDriftReport,
        {
          displayName: "models.dev price drift report",
          description: "The latest roster-vs-models.dev price reconciliation: which rows are mispriced, by how much, and the exact note clause to record if the correction is approved. Read-only; writes nothing.",
          parametersSchema: { type: "object" }
        },
        async (_args, toolCtx) => {
          const companyId = toolCtx?.companyId;
          if (!companyId) {
            return { content: "No company scope on this call; cannot read a per-company price report.", data: toolRejection("missing-company-scope") };
          }
          const stored = asRecord3(await ctx.state.get(priceReconcileReportKey(companyId)));
          const report = stored.report;
          if (!report) {
            return {
              content: `No models.dev price reconciliation has completed for this company yet. Run ${TOOL_NAMES.reconcilePricesNow} or wait for the daily job.`,
              data: toolRejection("no-report-yet")
            };
          }
          const lines = report.drift.map((row) => {
            const fields = row.fields.map((f) => `${f.field}: ${f.roster} -> ${f.feed}${f.ratio === null ? "" : ` (x${f.ratio.toFixed(2)})`}`).join("; ");
            return `- ${row.modelId} [${row.severity}${row.enabled ? ", enabled" : ", disabled"}] ${fields}`;
          });
          return {
            content: `models.dev reconciliation as of ${report.fetchedAt}: ${report.drift.length} of ${report.checked} priced rows drift (${report.unchanged} correct, ${report.excluded.length} out of scope by policy, ${report.unresolved.length} unresolved).
${lines.join("\n") || "No drift."}
List prices from models.dev \u2014 correct for the selector's relative cost ordering, NOT what this company pays on a flat subscription.`,
            data: { ranAt: stored.ranAt ?? null, report }
          };
        }
      );
      ctx.jobs.register(JOB_KEYS.refreshScores, async () => {
        const companies = listKnownCompanies();
        for (const company of companies) {
          try {
            const config = await companyConfig(company.id);
            if (config.models.length === 0) continue;
            const scoreRunRows = await ctx.db.query(
              REFRESH_SCORE_RUNS_SQL,
              [company.id, String(SCORE_WINDOW_DAYS)]
            );
            const closingRunRows = await ctx.db.query(
              REFRESH_SCORE_CLOSING_RUNS_SQL,
              [company.id, String(CARD_LEDGER_WINDOW_DAYS)]
            );
            const issueIds = /* @__PURE__ */ new Set();
            for (const row of scoreRunRows) {
              const r = asRecord3(row);
              if (typeof r.issue_id === "string" && r.issue_id) issueIds.add(r.issue_id);
            }
            for (const row of closingRunRows) {
              const r = asRecord3(row);
              if (typeof r.issue_id === "string" && r.issue_id) issueIds.add(r.issue_id);
            }
            const tierByIssue = /* @__PURE__ */ new Map();
            const labelsByIssue = /* @__PURE__ */ new Map();
            const pinConfigByIssue = /* @__PURE__ */ new Map();
            for (const issueId of issueIds) {
              try {
                const issue = await ctx.issues.get(issueId, company.id);
                const labelNames = (issue?.labels ?? []).map((label) => label.name).filter((name) => typeof name === "string");
                const tierLabel = labelNames.find((name) => name.startsWith(TIER_LABEL_PREFIX));
                const tierValue = tierLabel ? tierLabel.slice(TIER_LABEL_PREFIX.length) : null;
                tierByIssue.set(
                  issueId,
                  tierValue && TIERS.includes(tierValue) ? tierValue : null
                );
                labelsByIssue.set(issueId, labelNames);
                pinConfigByIssue.set(
                  issueId,
                  asRecord3(asRecord3(issue?.assigneeAdapterOverrides).adapterConfig)
                );
              } catch {
                tierByIssue.set(issueId, null);
                labelsByIssue.set(issueId, []);
                pinConfigByIssue.set(issueId, null);
              }
            }
            const toNumber = (value) => {
              if (typeof value === "number") return Number.isFinite(value) ? value : null;
              if (typeof value === "string" && value.length > 0) {
                const parsed = Number(value);
                return Number.isFinite(parsed) ? parsed : null;
              }
              return null;
            };
            let unattributableCostRuns = 0;
            const attributableCost = (modelId, provider, costUsd) => {
              if (costUsd === null) return null;
              const verdict = classifyCostAttribution(
                modelId,
                typeof provider === "string" ? provider : null
              );
              if (verdict.attributable) return costUsd;
              unattributableCostRuns += 1;
              return null;
            };
            const runOutcomeRows = scoreRunRows.flatMap((row) => {
              const r = asRecord3(row);
              const modelId = resolveConfiguredModelId(
                typeof r.model === "string" ? r.model : null,
                config.models
              );
              if (!modelId) return [];
              const issueId = typeof r.issue_id === "string" ? r.issue_id : "";
              return [{
                modelId,
                tier: issueId ? tierByIssue.get(issueId) ?? null : null,
                status: r.status,
                errorCode: typeof r.error_code === "string" && r.error_code ? r.error_code : null,
                error: typeof r.error === "string" && r.error ? r.error : null,
                costUsd: attributableCost(modelId, r.provider, toNumber(r.cost_usd)),
                mins: toNumber(r.mins),
                ageDays: toNumber(r.age_days) ?? 0
              }];
            });
            let statsByModel = accumulateRunStats(runOutcomeRows);
            const closingRuns = closingRunRows.flatMap((row) => {
              const r = asRecord3(row);
              const modelId = resolveConfiguredModelId(
                typeof r.model === "string" ? r.model : null,
                config.models
              );
              if (!modelId) return [];
              const issueId = typeof r.issue_id === "string" ? r.issue_id : "";
              return [{
                issueId,
                modelId,
                tier: issueId ? tierByIssue.get(issueId) ?? null : null,
                finishedAtMs: toNumber(r.finished_at_ms) ?? 0,
                agentId: typeof r.agent_id === "string" && r.agent_id ? r.agent_id : null,
                costUsd: attributableCost(modelId, r.provider, toNumber(r.cost_usd))
              }];
            });
            const reworkSignals = await readReworkSignals(company.id);
            const reworkEvents = [];
            const rejectedIssueIds = /* @__PURE__ */ new Set();
            for (const signal of reworkSignals) {
              const windowMs = signal.kind === "reopen" ? REOPEN_WINDOW_MS : REJECTION_WINDOW_MS;
              const closing = findClosingRun(signal.issueId, signal.atMs, windowMs, closingRuns, signal.excludeAgentId);
              if (!closing || closing.tier === null) continue;
              reworkEvents.push({ modelId: closing.modelId, tier: closing.tier, kind: signal.kind });
              rejectedIssueIds.add(signal.issueId);
            }
            statsByModel = foldReworkIntoStats(statsByModel, reworkEvents);
            const aaSnapshot = await readAaSnapshot();
            const aaKnownSlugs = new Set(Object.keys(aaSnapshot.bySlug));
            const liveAaIndex = (model) => {
              const slug = resolveAaSlug(model.id, aaKnownSlugs, model.aaSlug ?? null);
              if (!slug) return model.aaIndex;
              const live = aaSnapshot.bySlug[slug]?.intelligenceIndex;
              return typeof live === "number" ? live : model.aaIndex;
            };
            const benchmarkRow = (model) => FROZEN_BENCHMARK_ROWS[model.id] ?? null;
            const modelScores = config.models.map(
              (model) => buildModelScore(model.id, liveAaIndex(model), statsByModel[model.id] ?? {}, TIERS, benchmarkRow(model))
            );
            const scoresByModelId = {};
            for (const score2 of modelScores) scoresByModelId[score2.modelId] = score2;
            const overlaid = applyDerivedTiers(config.models, scoresByModelId);
            const retierings = overlaid.flatMap((model, index) => {
              const configured = config.models[index];
              if (!configured || configured.tier === model.tier) return [];
              const p = scoresByModelId[model.id]?.overall.p;
              const lane = configured.laneId ? `@${configured.laneId}` : "";
              return [`${model.id}${lane} ${configured.tier} -> ${model.tier} (p=${p})`];
            });
            const cardIssueRows = await ctx.db.query(
              `select id::text as id,
                      extract(epoch from coalesce(completed_at, cancelled_at)) * 1000 as closed_at_ms,
                      assignee_adapter_overrides->'adapterConfig'->>'model' as pinned_model
                 from issues
                where company_id = $1
                  and coalesce(completed_at, cancelled_at) is not null
                  and coalesce(completed_at, cancelled_at) > now() - ($2 || ' days')::interval`,
              [company.id, String(CARD_LEDGER_WINDOW_DAYS)]
            );
            const latestClosingRunByIssue = /* @__PURE__ */ new Map();
            const runCountByIssue = /* @__PURE__ */ new Map();
            for (const run of closingRuns) {
              if (!run.issueId) continue;
              runCountByIssue.set(run.issueId, (runCountByIssue.get(run.issueId) ?? 0) + 1);
              const existing = latestClosingRunByIssue.get(run.issueId);
              if (!existing || run.finishedAtMs > existing.finishedAtMs) {
                latestClosingRunByIssue.set(run.issueId, run);
              }
            }
            const rawClosingModelByIssue = /* @__PURE__ */ new Map();
            const rawClosingAtByIssue = /* @__PURE__ */ new Map();
            for (const row of closingRunRows) {
              const r = asRecord3(row);
              const issueId = typeof r.issue_id === "string" ? r.issue_id : "";
              if (!issueId) continue;
              const atMs = toNumber(r.finished_at_ms) ?? 0;
              const currentMs = rawClosingAtByIssue.get(issueId) ?? -1;
              if (!rawClosingModelByIssue.has(issueId) || atMs > currentMs) {
                rawClosingModelByIssue.set(
                  issueId,
                  typeof r.model === "string" && r.model ? r.model : null
                );
                rawClosingAtByIssue.set(issueId, atMs);
              }
            }
            const cardRows = [];
            for (const row of cardIssueRows) {
              const r = asRecord3(row);
              const issueId = typeof r.id === "string" ? r.id : null;
              if (!issueId) continue;
              const closingRun = latestClosingRunByIssue.get(issueId);
              if (!closingRun || closingRun.tier === null) continue;
              const rawPinnedModel = typeof r.pinned_model === "string" && r.pinned_model ? r.pinned_model : null;
              const pinnedModel = resolveConfiguredModelId(
                rawPinnedModel,
                config.models
              );
              cardRows.push({
                modelId: closingRun.modelId,
                tier: closingRun.tier,
                closedAtMs: toNumber(r.closed_at_ms) ?? 0,
                rejected: rejectedIssueIds.has(issueId),
                costUsd: closingRun.costUsd,
                runCount: runCountByIssue.get(issueId) ?? 1,
                foreignRun: rawPinnedModel !== null && pinnedModel !== closingRun.modelId
              });
            }
            const priorPByModel = {};
            const blendedListPriceByModel = {};
            for (const model of config.models) {
              priorPByModel[model.id] = blendedPriorP(liveAaIndex(model), benchmarkRow(model));
              blendedListPriceByModel[model.id] = null;
            }
            const cardLedger = buildCardLedger(
              cardRows,
              Date.now(),
              priorPByModel,
              blendedListPriceByModel
            );
            const acceptedWorkKey = {
              scopeKind: "company",
              scopeId: company.id,
              stateKey: PLUGIN_STATE_KEYS.acceptedWorkOverlay
            };
            if (config.acceptedWork.enabled) {
              let closedCardsWithoutClosingRun = 0;
              const acceptedWorkCards = [];
              for (const row of cardIssueRows) {
                const r = asRecord3(row);
                const issueId = typeof r.id === "string" ? r.id : null;
                if (!issueId) continue;
                if (!rawClosingModelByIssue.has(issueId)) {
                  closedCardsWithoutClosingRun += 1;
                  continue;
                }
                acceptedWorkCards.push({
                  issueId,
                  rawServedModel: rawClosingModelByIssue.get(issueId) ?? null,
                  pinAdapterConfig: pinConfigByIssue.get(issueId) ?? null,
                  labelNames: labelsByIssue.get(issueId) ?? [],
                  closedAtMs: toNumber(r.closed_at_ms) ?? 0,
                  rejected: rejectedIssueIds.has(issueId)
                });
              }
              const nowMs = Date.now();
              const overlay = buildAcceptedWorkOverlay({
                cards: acceptedWorkCards,
                models: config.models,
                priorPByModel,
                unattributed: { closedCardsWithoutClosingRun },
                nowMs,
                nowIso: new Date(nowMs).toISOString()
              });
              await ctx.state.set(acceptedWorkKey, overlay);
              ctx.logger.info("accepted-work overlay refreshed", {
                companyId: company.id,
                cohorts: overlay.cohorts.length,
                cards: acceptedWorkCards.length,
                unattributed: closedCardsWithoutClosingRun,
                specVersion: overlay.specVersion,
                computedAt: overlay.computedAt
              });
            }
            const computedAt = (/* @__PURE__ */ new Date()).toISOString();
            await ctx.state.set(scoresKey(company.id), { modelScores, cardLedger, computedAt });
            ctx.logger.info("model scores refreshed", {
              companyId: company.id,
              models: modelScores.length,
              cardsInLedger: cardRows.length,
              // TOG-4022: runs whose recorded cost was priced against the
              // wrong provider's table and therefore excluded. Non-zero means
              // the upstream claude-local `provider: "anthropic"` literal is
              // still live; zero means it was fixed or no such runs landed.
              unattributableCostRuns,
              tierSpecVersion: BENCHMARK_SPEC_VERSION,
              computedAt,
              retiered: retierings.length,
              unscored: modelScores.filter((score2) => score2.derivedTier === null).length,
              belowT3Floor: modelScores.filter((score2) => score2.belowT3Floor).length,
              // Named, not just counted: a tier move is the one thing here an
              // operator may need to reverse, and a bare count cannot be acted on.
              retierings
            });
          } catch (cause) {
            ctx.logger.error("score refresh failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause)
            });
          }
        }
      });
      ctx.jobs.register(JOB_KEYS.classifyIssues, async () => {
        const classifyJobStartedAt = Date.now();
        const classifyDeadline = classifyJobStartedAt + CLASSIFY_JOB_BUDGET_MS;
        let classifySlowestRowMs = 0;
        const companies = listKnownCompanies();
        for (const company of companies) {
          if (Date.now() >= classifyDeadline) {
            ctx.logger.warn("issue classification pass stopped before the host RPC wall", {
              companyId: company.id,
              jobDurationMs: Date.now() - classifyJobStartedAt
            });
            break;
          }
          try {
            const config = await companyConfig(company.id);
            if (!config.classification.enabled) continue;
            if (!config.classification.baseUrl || !config.classification.modelId) continue;
            const classifyBaseUrl = config.classification.baseUrl;
            const classifyModelId = config.classification.modelId;
            let apiKey = null;
            if (config.classification.apiKeySecretRef) {
              try {
                apiKey = await ctx.secrets.resolve(config.classification.apiKeySecretRef, {
                  companyId: company.id,
                  configPath: "classification.apiKeySecretRef"
                });
              } catch {
                ctx.logger.error("classification secret unavailable", { companyId: company.id });
                continue;
              }
            }
            const classifyFetchLimit = Math.min(
              config.classification.batchSize * CLASSIFY_FETCH_MULTIPLIER,
              CLASSIFY_FETCH_LIMIT_MAX
            );
            const classifyFiringStartMs = Date.now();
            const classifySinceIso = new Date(await readScanMark(company.id, PLUGIN_STATE_KEYS.classifyLastScanAt)).toISOString();
            const candidateRows = await ctx.db.query(
              `select i.id::text as id,
                      i.identifier as identifier,
                      i.status as status,
                      coalesce(a.name,'') as agent_name,
                      i.title as title,
                      coalesce(i.description,'') as description,
                      i.updated_at as updated_at
                 from issues i
                 join agents a on a.id = i.assignee_agent_id
                where i.company_id = $1
                  and i.status in ('todo','in_progress','blocked','in_review')
                  and a.status <> 'terminated'
                  and i.assignee_agent_id is not null
                  and i.updated_at > $3
                  and (i.assignee_adapter_overrides is null
                       or i.assignee_adapter_overrides->'adapterConfig'->>'model' is null)
                  and not exists (
                    select 1 from heartbeat_runs r
                     where r.status in ('running','queued')
                       and r.context_snapshot->>'issueId' = i.id::text
                  )
                order by i.updated_at asc
                limit $2`,
              [company.id, String(classifyFetchLimit), classifySinceIso]
            );
            if (candidateRows.length === 0) {
              ctx.logger.info("issue classification pass skipped: no issues changed since last scan", {
                companyId: company.id,
                since: classifySinceIso
              });
              await writeScanMark(company.id, PLUGIN_STATE_KEYS.classifyLastScanAt, classifyFiringStartMs);
              continue;
            }
            const exclusions = await readClassificationExclusions(company.id);
            const classifierLabeled = await readClassifierLabeled(company.id);
            let classified = 0;
            let reclassified = 0;
            const walk = await walkRowsWithinDeadline(
              candidateRows,
              { deadlineAt: classifyDeadline, rowTimeoutMs: CLASSIFY_ROW_TIMEOUT_MS, slowestRowMs: classifySlowestRowMs },
              async (row, rowStartedAt) => {
                const r = asRecord3(row);
                const issueId = typeof r.id === "string" ? r.id : null;
                const identifier = typeof r.identifier === "string" ? r.identifier : issueId;
                if (!issueId) return "settled";
                let issue;
                try {
                  issue = await ctx.issues.get(issueId, company.id);
                } catch {
                  return "settled";
                }
                if (!issue) return "settled";
                const labelNames = (issue.labels ?? []).map((label) => label.name).filter((name) => typeof name === "string");
                const existingLabelIds = issue.labelIds ?? (issue.labels ?? []).map((label) => label.id).filter((id) => typeof id === "string");
                if (labelNames.includes(OPERATOR_PIN_LABEL)) return "settled";
                const existingLabelTier = tierFromLabels(labelNames);
                const ourRecordedTier = classifierLabeled[issueId];
                const ourLabelId = ourRecordedTier ? config.tierLabelIds[ourRecordedTier] : void 0;
                const stillCarriesOurLabel = ourRecordedTier !== void 0 && (ourRecordedTier === existingLabelTier || typeof ourLabelId === "string" && existingLabelIds.includes(ourLabelId));
                const isForeignLabel = existingLabelTier !== null && !stillCarriesOurLabel;
                if (existingLabelTier !== null) {
                  if (!config.classification.reclassifyForeignLabels) return "settled";
                  if (!isForeignLabel) return "settled";
                }
                const agentName = typeof r.agent_name === "string" ? r.agent_name : "";
                const title = typeof r.title === "string" ? r.title : "";
                const description = typeof r.description === "string" ? r.description : "";
                const prompt = buildClassificationPrompt(title, description, agentName, config.classification.descriptionChars);
                const result = await callClassifier(
                  {
                    baseUrl: classifyBaseUrl,
                    protocol: config.classification.protocol,
                    modelId: classifyModelId,
                    apiKey,
                    system: RUBRIC,
                    userPrompt: prompt,
                    maxOutputTokens: config.classification.maxOutputTokens,
                    requestTimeoutMs: config.classification.requestTimeoutMs,
                    maxResponseBytes: config.classification.maxResponseBytes
                  },
                  classificationHttp
                );
                if (!result.text) {
                  ctx.logger.info("classification skipped", { companyId: company.id, issue: identifier, why: result.error });
                  return "settled";
                }
                const judgement = parseClassificationResponse(result.text);
                if (!judgement) {
                  ctx.logger.info("classification unparseable", { companyId: company.id, issue: identifier });
                  return "settled";
                }
                const { labelTier, pickTier } = resolveClassifiedTiers(judgement, {
                  t3ConfidenceFloor: config.classification.t3ConfidenceFloor,
                  t2ConfidenceFloor: config.classification.t2ConfidenceFloor
                });
                if (Date.now() >= classifyDeadline || Date.now() - rowStartedAt >= CLASSIFY_ROW_TIMEOUT_MS) {
                  ctx.logger.warn("classification pass skipped slow row write: row exceeded its time slice", {
                    companyId: company.id,
                    issue: identifier,
                    rowDurationMs: Date.now() - rowStartedAt,
                    rowTimeoutMs: CLASSIFY_ROW_TIMEOUT_MS
                  });
                  return "unsettled";
                }
                const labelId = config.tierLabelIds[labelTier];
                if (labelId) {
                  const tierLabelIdsOnIssue = new Set(
                    (issue.labels ?? []).filter((label) => typeof label.name === "string" && label.name.startsWith(TIER_LABEL_PREFIX)).map((label) => label.id).filter((id) => typeof id === "string")
                  );
                  for (const id of Object.values(config.tierLabelIds)) {
                    if (typeof id === "string") tierLabelIdsOnIssue.add(id);
                  }
                  const nextLabelIds = [
                    .../* @__PURE__ */ new Set([...existingLabelIds.filter((id) => !tierLabelIdsOnIssue.has(id)), labelId])
                  ];
                  await ctx.issues.update(
                    issueId,
                    { labelIds: nextLabelIds },
                    company.id
                  );
                  await ctx.state.set(classifierLabeledKey(company.id), { ...classifierLabeled, [issueId]: labelTier });
                  classifierLabeled[issueId] = labelTier;
                }
                if (judgement.exclusion) {
                  await ctx.state.set(classificationExclusionsKey(company.id), { ...exclusions, [issueId]: true });
                  exclusions[issueId] = true;
                }
                await ctx.activity.log({
                  companyId: company.id,
                  message: `Model Selection classified this issue as ${labelTier} (confidence ${judgement.confidence})${judgement.exclusion ? ", capability-excluded" : ""}${isForeignLabel ? `, replacing an unattributed ${existingLabelTier} label` : ""}`,
                  entityType: "issue",
                  entityId: issueId,
                  metadata: {
                    tier: labelTier,
                    pickTier,
                    confidence: judgement.confidence,
                    reason: judgement.reason,
                    ...isForeignLabel ? { replacedLabelTier: existingLabelTier } : {}
                  }
                });
                classified += 1;
                if (isForeignLabel) reclassified += 1;
                return classified >= config.classification.batchSize ? "stop" : "settled";
              }
            );
            classifySlowestRowMs = walk.slowestRowMs;
            if (walk.abandoned) {
              const abandoned = asRecord3(walk.abandoned.row);
              ctx.logger.warn("classification pass abandoned a slow row at the deadline", {
                companyId: company.id,
                issue: typeof abandoned.identifier === "string" ? abandoned.identifier : abandoned.id,
                rowDurationMs: walk.abandoned.rowDurationMs
              });
            }
            await advanceScanCursor(
              company.id,
              PLUGIN_STATE_KEYS.classifyLastScanAt,
              candidateRows,
              walk.settledPrefix,
              classifyFetchLimit,
              classifyFiringStartMs
            );
            ctx.logger.info("issue classification pass complete", {
              companyId: company.id,
              classified,
              reclassified,
              candidates: candidateRows.length,
              examined: walk.examined.length,
              skippedSlowRows: walk.unsettled,
              slowestRowMs: walk.slowestRowMs,
              budgetExhausted: walk.budgetExhausted,
              jobDurationMs: Date.now() - classifyJobStartedAt
            });
            if (walk.budgetExhausted) break;
          } catch (cause) {
            ctx.logger.error("issue classification failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause)
            });
          }
        }
      });
      const balanceOpenStatuses = /* @__PURE__ */ new Set(["todo", "in_progress", "blocked", "in_review"]);
      const activeBalanceRunIssueIds = async (companyId) => {
        const rows = await ctx.db.query(
          `select distinct coalesce(context_snapshot->>'issueId', context_snapshot->>'taskId') as issue_id
             from heartbeat_runs
            where company_id = $1
              and status in ('running','queued')
              and coalesce(context_snapshot->>'issueId', context_snapshot->>'taskId') is not null`,
          [companyId]
        );
        return new Set(
          rows.map((row) => asRecord3(row).issue_id).filter((issueId) => typeof issueId === "string" && issueId.length > 0)
        );
      };
      const readScanMark = async (companyId, stateKey) => {
        const stored = asRecord3(await ctx.state.get({ scopeKind: "company", scopeId: companyId, stateKey }));
        const at = typeof stored.at === "string" ? Date.parse(stored.at) : Number.NaN;
        return Number.isFinite(at) ? at : 0;
      };
      const writeScanMark = async (companyId, stateKey, atMs) => {
        await ctx.state.set(
          { scopeKind: "company", scopeId: companyId, stateKey },
          { at: new Date(atMs).toISOString() }
        );
      };
      const advanceScanCursor = async (companyId, stateKey, rows, settledPrefix, fetchLimit, firingStartMs) => {
        const mark = scanMarkAfterWalk(rows, settledPrefix, fetchLimit, firingStartMs);
        if (mark !== null) await writeScanMark(companyId, stateKey, mark);
      };
      const pinPinnedAtKey = (companyId) => ({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.pinPinnedAt
      });
      const readPinPinnedAt = async (companyId) => {
        const stored = asRecord3(await ctx.state.get(pinPinnedAtKey(companyId)));
        const out = {};
        for (const [issueId, at] of Object.entries(stored)) {
          if (typeof at === "string") out[issueId] = at;
        }
        return out;
      };
      const isPinExpired = (pinnedAt, issueId, nowMs) => {
        const raw = pinnedAt[issueId];
        if (typeof raw !== "string") return true;
        const atMs = Date.parse(raw);
        if (!Number.isFinite(atMs)) return true;
        return nowMs - atMs >= PIN_MAX_AGE_MS;
      };
      const recordPinTimestamp = async (companyId, issueId, atIso) => {
        try {
          const stored = await readPinPinnedAt(companyId);
          const pruned = {};
          const nowMs = Date.parse(atIso ?? "") || Date.now();
          for (const [id, at] of Object.entries(stored)) {
            if (id !== issueId && nowMs - Date.parse(at) < 7 * 24 * 60 * 60 * 1e3) pruned[id] = at;
          }
          if (atIso !== null) pruned[issueId] = atIso;
          await ctx.state.set(pinPinnedAtKey(companyId), pruned);
        } catch {
        }
      };
      const fallbackPinsKey = (companyId) => ({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.fallbackPins
      });
      const readFallbackPins = async (companyId) => {
        const stored = asRecord3(await ctx.state.get(fallbackPinsKey(companyId)));
        const out = {};
        for (const [issueId, raw] of Object.entries(stored)) {
          const entry = asRecord3(raw);
          if (typeof entry.decisionId !== "string" || typeof entry.decidedAt !== "string") continue;
          out[issueId] = {
            decisionId: entry.decisionId,
            decidedAt: entry.decidedAt,
            checkedAt: typeof entry.checkedAt === "string" ? entry.checkedAt : null
          };
        }
        return out;
      };
      const fallbackPinProvenance = (model, agentId) => model.fallbackOnly === true ? { decisionId: randomUUID(), agentId, fallback: true, decidedAt: (/* @__PURE__ */ new Date()).toISOString() } : null;
      const recordFallbackPin = async (companyId, issueId, written) => {
        try {
          const stamp = readPinProvenance(written?.assigneeAdapterOverrides?.adapterConfig?.env);
          const stored = await readFallbackPins(companyId);
          if (stamp === null) {
            if (!(issueId in stored)) return;
            delete stored[issueId];
          } else {
            stored[issueId] = { decisionId: stamp.decisionId, decidedAt: stamp.decidedAt, checkedAt: null };
            const entries = Object.entries(stored);
            if (entries.length > FALLBACK_PIN_INDEX_MAX) {
              entries.sort(([, a], [, b]) => a.decidedAt.localeCompare(b.decidedAt)).slice(0, entries.length - FALLBACK_PIN_INDEX_MAX).forEach(([id]) => delete stored[id]);
            }
          }
          await ctx.state.set(fallbackPinsKey(companyId), stored);
        } catch (cause) {
          ctx.logger.warn("fallback pin index write failed", {
            companyId,
            issueId,
            error: cause instanceof Error ? cause.message : String(cause)
          });
        }
      };
      const pinnableBeforeStart = async (companyId, issueId) => {
        const issue = await ctx.issues.get(issueId, companyId);
        if (!issue) return false;
        if (issue.checkoutRunId) return false;
        const scheduledRetryStatus = issue.scheduledRetry?.status ?? null;
        if (scheduledRetryStatus === "queued" || scheduledRetryStatus === "running") return false;
        const liveRows = await ctx.db.query(CREATION_PIN_LIVE_RUNS_SQL, [
          companyId,
          issueId
        ]);
        return liveRows.every((row) => {
          const run = asRecord3(row);
          return run.status === "queued" && run.started_at == null;
        });
      };
      const creationWriteStillSafe = async (companyId, issueId, models, expectedPinnedModelId) => {
        const issue = await ctx.issues.get(issueId, companyId);
        if (!issue || !balanceOpenStatuses.has(String(issue.status ?? ""))) return false;
        if ((issue.labels ?? []).some((label) => label.name === OPERATOR_PIN_LABEL)) return false;
        const overrides = asRecord3(issue.assigneeAdapterOverrides);
        const adapterConfig = asRecord3(overrides.adapterConfig);
        const rawPinnedModelId = typeof adapterConfig.model === "string" ? adapterConfig.model : null;
        const currentPinnedModelId = resolveConfiguredModelId(rawPinnedModelId, models);
        if (rawPinnedModelId && !currentPinnedModelId) return false;
        if (currentPinnedModelId !== expectedPinnedModelId) return false;
        return pinnableBeforeStart(companyId, issueId);
      };
      const rehomePinOnReassignment = async (companyId, issueId, fromAgentId, toAgentId) => {
        const issue = await ctx.issues.get(issueId, companyId);
        if (!issue || issue.assigneeAgentId !== toAgentId) return;
        const adapterConfig = asRecord3(asRecord3(issue.assigneeAdapterOverrides).adapterConfig);
        if (adapterConfig.env == null) return;
        const rawPinnedModelId = typeof adapterConfig.model === "string" ? adapterConfig.model : null;
        const config = await companyConfig(companyId);
        const writesAllowed = selectionWritesAllowed(config);
        const advisorySuffix = writesAllowed ? "" : " \u2014 advisory, nothing written";
        const pinnedModelId = resolveConfiguredModelId(rawPinnedModelId, config.models);
        const pinnedModel = config.models.find((model) => model.id === pinnedModelId) ?? null;
        const described = await describeIssue(companyId, issueId, {});
        if (config.classification.enabled && pinnedModel !== null && described !== null && described.assigneeAgentId === toAgentId && described.agentEnv !== null && balanceOpenStatuses.has(described.status) && !described.hasOperatorPin) {
          const patch = modelOverrideForContext({
            model: pinnedModel,
            agentEnvContextTokens: config.selection.agentEnvContextTokens,
            compactionRatio: config.selection.compactionRatio,
            agentEnv: described.agentEnv,
            agentAdapterType: described.agentAdapterType,
            agentAdapterConfig: described.agentAdapterConfig,
            existingOverrideEnv: described.existingOverrideEnv,
            cheapModelId: cheapestHealthyModelIdForTier({
              models: config.models,
              tier: "T3",
              ledger: await readLaneLedger(companyId),
              laneOutageOverride: await readLaneOutage(companyId),
              nowIso: (/* @__PURE__ */ new Date()).toISOString(),
              modelScores: await readModelScores(companyId),
              laneAvoidConfig: config.pacing.avoid,
              pacingMode: config.pacing.mode
            }),
            // Same decision, new home: a fallback pin keeps its stamp, so the
            // lease pass still finds it.
            provenance: readPinProvenance(described.existingOverrideEnv)
          });
          const fresh = await ctx.issues.get(issueId, companyId);
          const freshModel = asRecord3(asRecord3(fresh?.assigneeAdapterOverrides).adapterConfig).model;
          if (fresh?.assigneeAgentId === toAgentId && freshModel === adapterConfig.model && await pinnableBeforeStart(companyId, issueId)) {
            if (writesAllowed) {
              await ctx.issues.update(issueId, patch, companyId);
              await recordFallbackPin(companyId, issueId, patch);
            } else {
              ctx.logger.info("reassignment re-home advisory: would rebuild the pin env, nothing written", {
                companyId,
                issue: described.identifier ?? issueId,
                modelId: pinnedModel.id,
                fromAgentId,
                toAgentId
              });
            }
            await ctx.activity.log({
              companyId,
              message: `Model Selection rebuilt the ${pinnedModel.id} pin's env for the new assignee on ${described.identifier ?? issueId}${advisorySuffix}`,
              entityType: "issue",
              entityId: issueId,
              metadata: {
                modelId: pinnedModel.id,
                fromAgentId,
                toAgentId,
                action: "rebuild-env",
                ...writesAllowed ? {} : { advisory: true, written: false }
              }
            });
            return;
          }
        }
        const current = await ctx.issues.get(issueId, companyId);
        if (!current || current.assigneeAgentId !== toAgentId) return;
        const overrides = { ...asRecord3(current.assigneeAdapterOverrides) };
        const keptAdapterConfig = { ...asRecord3(overrides.adapterConfig) };
        if (keptAdapterConfig.env == null) return;
        delete keptAdapterConfig.env;
        delete overrides.adapterConfig;
        if (Object.keys(keptAdapterConfig).length > 0) overrides.adapterConfig = keptAdapterConfig;
        if (writesAllowed) {
          await ctx.issues.update(
            issueId,
            { assigneeAdapterOverrides: Object.keys(overrides).length > 0 ? overrides : null },
            companyId
          );
          await recordFallbackPin(companyId, issueId, null);
        } else {
          ctx.logger.info("reassignment re-home advisory: would clear the previous assignee's pin env, nothing written", {
            companyId,
            issue: described?.identifier ?? issueId,
            fromAgentId,
            toAgentId
          });
        }
        await ctx.activity.log({
          companyId,
          message: `Model Selection cleared the previous assignee's pin env on ${described?.identifier ?? issueId}; model pin kept${advisorySuffix}`,
          entityType: "issue",
          entityId: issueId,
          metadata: {
            modelId: typeof keptAdapterConfig.model === "string" ? keptAdapterConfig.model : null,
            fromAgentId,
            toAgentId,
            action: "clear-env",
            ...writesAllowed ? {} : { advisory: true, written: false }
          }
        });
      };
      const balanceWriteStillSafe = async (companyId, issueId, expectedPinnedModelId, models) => {
        const issue = await ctx.issues.get(issueId, companyId);
        if (!issue || !balanceOpenStatuses.has(String(issue.status ?? ""))) return false;
        const scheduledRetryStatus = issue.scheduledRetry?.status ?? null;
        if (issue.checkoutRunId || issue.executionRunId || scheduledRetryStatus === "queued" || scheduledRetryStatus === "running") {
          return false;
        }
        if ((issue.labels ?? []).some((label) => label.name === OPERATOR_PIN_LABEL)) return false;
        const overrides = asRecord3(issue.assigneeAdapterOverrides);
        const adapterConfig = asRecord3(overrides.adapterConfig);
        const rawPinnedModelId = typeof adapterConfig.model === "string" ? adapterConfig.model : null;
        const currentPinnedModelId = resolveConfiguredModelId(rawPinnedModelId, models);
        if (rawPinnedModelId && !currentPinnedModelId) return false;
        if (currentPinnedModelId !== expectedPinnedModelId) return false;
        const activeRows = await ctx.db.query(
          `select coalesce(context_snapshot->>'issueId', context_snapshot->>'taskId') as issue_id
             from heartbeat_runs
            where company_id = $1
              and status in ('running','queued')
              and coalesce(context_snapshot->>'issueId', context_snapshot->>'taskId') = $2
            limit 1`,
          [companyId, issueId]
        );
        return !activeRows.some((row) => asRecord3(row).issue_id === issueId);
      };
      const isUsableAndCapable = (modelId, tier2, requiredContextTokens, config, laneLedger, laneOutageOverride, modelScores, nowIso) => {
        if (!modelId) return false;
        const model = applyDerivedTiers(config.models, modelScores).find((m) => m.id === modelId && m.enabled);
        if (!model || tierIndex(model.tier) < tierIndex(tier2)) return false;
        if (typeof requiredContextTokens === "number" && model.contextWindow < requiredContextTokens) return false;
        if (config.pacing.mode === "off") return true;
        if (hardStopExcluded(laneLedger, model)) return false;
        if (laneAvoidExcluded(laneLedger, model, config.pacing.avoid)) return false;
        if (laneOutageExcluded(laneOutageOverride, nowIso, model)) return false;
        const score2 = tierScoreFor(modelScores[model.id], tier2);
        if (score2 && score2.capable === false) return false;
        return true;
      };
      const countActivePinsOfModel = async (companyId, modelId) => {
        const rows = await ctx.db.query(
          `select count(*)::int as n
             from issues i
            where i.company_id = $1
              and i.status in ('todo','in_progress','in_review','blocked')
              and i.assignee_adapter_overrides->'adapterConfig'->>'model' = $2`,
          [companyId, modelId]
        );
        const r = asRecord3(rows[0]);
        return typeof r.n === "number" ? r.n : 0;
      };
      const tierWithFallback = (descriptor, models, defaultTier) => {
        const judgedTier = resolveTier(descriptor, models, defaultTier).tier;
        const labelTier = tierFromLabels(descriptor.labelNames);
        return labelTier && tierIndex(labelTier) > tierIndex(judgedTier) ? labelTier : judgedTier;
      };
      ctx.jobs.register(JOB_KEYS.labelOnlyPass, async () => {
        const companies = listKnownCompanies();
        const jobStartedAt = Date.now();
        const deadlineAt = jobStartedAt + LABEL_ONLY_PASS_JOB_BUDGET_MS;
        let slowestRowMs = 0;
        for (const company of companies) {
          if (Date.now() >= deadlineAt) {
            ctx.logger.warn("label-only pass stopped before the host RPC wall", {
              companyId: company.id,
              durationMs: Date.now() - jobStartedAt,
              budgetMs: LABEL_ONLY_PASS_JOB_BUDGET_MS
            });
            break;
          }
          try {
            const config = await companyConfig(company.id);
            if (!config.classification.enabled) continue;
            if (runResolveActive(config)) {
              ctx.logger.info("label-only pass skipped: run-scoped model decisions are live", { companyId: company.id });
              continue;
            }
            const writesAllowed = selectionWritesAllowed(config);
            const advisorySuffix = writesAllowed ? "" : " \u2014 advisory, nothing written";
            const labelOnlyFiringStartMs = Date.now();
            const labelOnlySinceIso = new Date(
              await readScanMark(company.id, PLUGIN_STATE_KEYS.labelOnlyLastScanAt)
            ).toISOString();
            const candidateRows = await ctx.db.query(
              `select i.id::text as id,
                      i.identifier as identifier,
                      i.status as status,
                      coalesce(a.adapter_config->>'model','') as floor_model,
                      i.updated_at as updated_at
                 from issues i
                 join agents a on a.id = i.assignee_agent_id
                where i.company_id = $1
                  and i.status in ('todo','in_progress','blocked','in_review')
                  and a.status <> 'terminated'
                  -- TOG-5227: a user-assigned card rejects issues.update
                  -- with an agent override ("Issue can only have one
                  -- assignee"), which used to abort the whole pass.
                  and i.assignee_user_id is null
                  and i.updated_at > $3
                  and (i.assignee_adapter_overrides is null
                       or i.assignee_adapter_overrides->'adapterConfig'->>'model' is null)
                  and not exists (
                    select 1 from heartbeat_runs r
                     where r.status in ('running','queued')
                       and r.context_snapshot->>'issueId' = i.id::text
                  )
                order by i.updated_at asc
                limit $2`,
              [company.id, String(LABEL_ONLY_PASS_FETCH_LIMIT), labelOnlySinceIso]
            );
            if (candidateRows.length === 0) {
              ctx.logger.info("label-only pass skipped: no issues changed since last scan", {
                companyId: company.id,
                since: labelOnlySinceIso
              });
              await writeScanMark(company.id, PLUGIN_STATE_KEYS.labelOnlyLastScanAt, labelOnlyFiringStartMs);
              continue;
            }
            const laneLedger = await readLaneLedger(company.id);
            const laneOutageOverride = await readLaneOutage(company.id);
            const modelScores = await readModelScores(company.id);
            const nowIso = (/* @__PURE__ */ new Date()).toISOString();
            const contextUsageCache = /* @__PURE__ */ new Map();
            let pinned = 0;
            const walk = await walkRowsWithinDeadline(
              candidateRows,
              {
                deadlineAt,
                rowTimeoutMs: LABEL_ONLY_PASS_ROW_TIMEOUT_MS,
                maxRows: LABEL_ONLY_PASS_MAX_ROWS_PER_FIRING,
                slowestRowMs
              },
              async (row, rowStartedAt) => {
                const r = asRecord3(row);
                const issueId = typeof r.id === "string" ? r.id : null;
                const identifier = typeof r.identifier === "string" ? r.identifier : issueId;
                if (!issueId) return "settled";
                const described = await describeIssue(company.id, issueId, {}, contextUsageCache);
                if (!described) return "settled";
                if (described.hasOperatorPin) return "settled";
                if (described.assigneeUserId) return "settled";
                const labelTier = tierFromLabels(described.descriptor.labelNames);
                const tier2 = tierWithFallback(described.descriptor, config.models, config.selection.defaultTier);
                const result = await advise(company.id, { issueId }, false, void 0, false, contextUsageCache);
                if (!result || result.decision.outcome !== "selected" || !result.decision.modelId) {
                  if (Date.now() >= deadlineAt) return "unsettled";
                  ctx.logger.info("label-only pass: no pick", { companyId: company.id, issue: identifier, tier: tier2 });
                  await maybeLogUnpinnableCard(company.id, issueId, identifier, result?.decision ?? null);
                  return "settled";
                }
                const floorModelId = resolveConfiguredModelId(result.agentFloorModelId, config.models);
                if (result.decision.modelId === floorModelId && isUsableAndCapable(
                  floorModelId,
                  tier2,
                  described.descriptor.requiredContextTokens,
                  config,
                  laneLedger,
                  laneOutageOverride,
                  modelScores,
                  nowIso
                )) {
                  ctx.logger.info("label-only pass skipped: pick equals healthy floor", {
                    companyId: company.id,
                    issue: identifier,
                    tier: tier2
                  });
                  return "settled";
                }
                const selectedModel = recoverSelectedCandidate(config.models, result.decision);
                if (!selectedModel) return "settled";
                if (Date.now() >= deadlineAt || Date.now() - rowStartedAt >= LABEL_ONLY_PASS_ROW_TIMEOUT_MS) {
                  ctx.logger.warn("label-only pass skipped slow row write: row exceeded its time slice", {
                    companyId: company.id,
                    issue: identifier,
                    tier: tier2,
                    rowDurationMs: Date.now() - rowStartedAt,
                    rowTimeoutMs: LABEL_ONLY_PASS_ROW_TIMEOUT_MS
                  });
                  return "unsettled";
                }
                if (writesAllowed) {
                  try {
                    const labelOnlyPatch = modelOverrideForContext({
                      model: selectedModel,
                      agentEnvContextTokens: config.selection.agentEnvContextTokens,
                      compactionRatio: config.selection.compactionRatio,
                      agentEnv: described.agentEnv,
                      agentAdapterType: described.agentAdapterType,
                      agentAdapterConfig: described.agentAdapterConfig,
                      existingOverrideEnv: described.existingOverrideEnv,
                      // TOG-3116: haiku-class sub-call keys follow the cheapest
                      // healthy T3 pick (falls back to the pin when none).
                      cheapModelId: result.ancillaryModelId,
                      provenance: fallbackPinProvenance(selectedModel, described.assigneeAgentId)
                    });
                    await ctx.issues.update(issueId, labelOnlyPatch, company.id);
                    await recordFallbackPin(company.id, issueId, labelOnlyPatch);
                  } catch (cause) {
                    ctx.logger.warn("label-only pass skipped a card it could not pin", {
                      companyId: company.id,
                      issue: identifier,
                      error: cause instanceof Error ? cause.message : String(cause)
                    });
                    return "settled";
                  }
                } else {
                  ctx.logger.info("label-only pass advisory: would pin, nothing written", {
                    companyId: company.id,
                    issue: identifier,
                    tier: tier2,
                    modelId: result.decision.modelId
                  });
                }
                await ctx.activity.log({
                  companyId: company.id,
                  message: result.decision.modelId === floorModelId ? `Model Selection explicitly pinned ${result.decision.modelId} (${tier2}): floor lane unserviceable${advisorySuffix}` : `Model Selection label-only pinned ${result.decision.modelId} (${tier2}) from ${labelTier ? "the existing tier label" : "the tier floor/default (no tier label present)"}${advisorySuffix}`,
                  entityType: "issue",
                  entityId: issueId,
                  // TOG-12206 P2: the served leg of the v2 identity (null on legacy).
                  metadata: { modelId: result.decision.modelId, tier: tier2, fromLabel: labelTier !== null, trace: result.decision.trace, candidateId: selectedModel.candidateId, ...writesAllowed ? {} : { advisory: true, written: false } }
                });
                if (writesAllowed) pinned += 1;
                return "settled";
              }
            );
            slowestRowMs = walk.slowestRowMs;
            if (walk.abandoned) {
              const abandoned = asRecord3(walk.abandoned.row);
              ctx.logger.warn("label-only pass abandoned a slow row at the deadline", {
                companyId: company.id,
                issue: typeof abandoned.identifier === "string" ? abandoned.identifier : abandoned.id,
                rowDurationMs: walk.abandoned.rowDurationMs
              });
            }
            await advanceScanCursor(
              company.id,
              PLUGIN_STATE_KEYS.labelOnlyLastScanAt,
              candidateRows,
              walk.settledPrefix,
              LABEL_ONLY_PASS_FETCH_LIMIT,
              labelOnlyFiringStartMs
            );
            ctx.logger.info("label-only pass complete", {
              companyId: company.id,
              pinned,
              candidates: candidateRows.length,
              examined: walk.examined.length,
              skippedSlowRows: walk.unsettled,
              slowestRowMs: walk.slowestRowMs,
              rowCapHit: walk.rowCapHit,
              budgetExhausted: walk.budgetExhausted,
              jobDurationMs: Date.now() - jobStartedAt
            });
            if (walk.budgetExhausted) break;
          } catch (cause) {
            ctx.logger.error("label-only pass failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause)
            });
          }
        }
      });
      const runRepinPassForCompany = async (companyId, incremental) => {
        const company = { id: companyId };
        let repinnedTotal = 0;
        let budgetExhausted = false;
        let repinSlowestRowMs = incremental?.slowestRowMs ?? 0;
        {
          try {
            const config = await companyConfig(company.id);
            if (!config.classification.enabled) return { repinned: 0, budgetExhausted: false, slowestRowMs: repinSlowestRowMs };
            if (runResolveActive(config)) return { repinned: 0, budgetExhausted: false, slowestRowMs: repinSlowestRowMs };
            const writesAllowed = selectionWritesAllowed(config);
            const advisorySuffix = writesAllowed ? "" : " \u2014 advisory, nothing written";
            const repinJobStartedAt = Date.now();
            const repinDeadlineAt = incremental ? incremental.deadlineAt : null;
            const candidateRows = await ctx.db.query(
              `select i.id::text as id,
                      i.identifier as identifier,
                      i.status as status,
                      i.updated_at as updated_at
                 from issues i
                 join agents a on a.id = i.assignee_agent_id
                where i.company_id = $1
                  and i.status in ('todo','in_progress','blocked','in_review')
                  and a.status <> 'terminated'
                  and i.assignee_adapter_overrides->'adapterConfig'->>'model' is not null
                  ${incremental ? "and i.updated_at > $3" : ""}
                  and not exists (
                    select 1 from heartbeat_runs r
                     where r.status in ('running','queued')
                       and r.context_snapshot->>'issueId' = i.id::text
                  )
                order by i.updated_at asc
                limit $2`,
              incremental ? [company.id, String(REPIN_PASS_FETCH_LIMIT), incremental.sinceIso] : [company.id, String(REPIN_PASS_FETCH_LIMIT)]
            );
            if (incremental && candidateRows.length === 0) {
              ctx.logger.info("repin pass skipped: no issues changed since last scan", {
                companyId: company.id,
                since: incremental.sinceIso
              });
              await writeScanMark(company.id, PLUGIN_STATE_KEYS.repinLastScanAt, incremental.firingStartMs);
              return { repinned: 0, budgetExhausted: false, slowestRowMs: repinSlowestRowMs };
            }
            const laneLedger = await readLaneLedger(company.id);
            const laneOutageOverride = await readLaneOutage(company.id);
            const modelScores = await readModelScores(company.id);
            const nowIso = (/* @__PURE__ */ new Date()).toISOString();
            const nowMs = Date.parse(nowIso);
            const pinPinnedAt = await readPinPinnedAt(company.id);
            const contextUsageCache = /* @__PURE__ */ new Map();
            let repinned = 0;
            const rowSliceSpent = (rowStartedAt) => repinDeadlineAt !== null && (Date.now() >= repinDeadlineAt || Date.now() - rowStartedAt >= REPIN_PASS_ROW_TIMEOUT_MS);
            const walk = await walkRowsWithinDeadline(
              candidateRows,
              {
                deadlineAt: repinDeadlineAt,
                rowTimeoutMs: REPIN_PASS_ROW_TIMEOUT_MS,
                slowestRowMs: incremental?.slowestRowMs
              },
              async (row, rowStartedAt) => {
                const r = asRecord3(row);
                const issueId = typeof r.id === "string" ? r.id : null;
                const identifier = typeof r.identifier === "string" ? r.identifier : issueId;
                if (!issueId) return "settled";
                const described = await describeIssue(company.id, issueId, {}, contextUsageCache);
                if (!described) return "settled";
                if (described.hasOperatorPin || !described.isIdle) return "settled";
                const tier2 = tierWithFallback(described.descriptor, config.models, config.selection.defaultTier);
                const pinnedModelId = resolveConfiguredModelId(described.descriptor.pinnedModelId, config.models);
                if (described.status === "blocked") {
                  if (rowSliceSpent(rowStartedAt)) {
                    ctx.logger.warn("repin pass skipped slow row write: row exceeded its time slice", {
                      companyId: company.id,
                      issue: identifier,
                      tier: tier2,
                      rowDurationMs: Date.now() - rowStartedAt,
                      rowTimeoutMs: REPIN_PASS_ROW_TIMEOUT_MS
                    });
                    return "unsettled";
                  }
                  if (writesAllowed) {
                    await ctx.issues.update(
                      issueId,
                      { assigneeAdapterOverrides: null },
                      company.id
                    );
                    await recordPinTimestamp(company.id, issueId, null);
                    await recordFallbackPin(company.id, issueId, null);
                  } else {
                    ctx.logger.info("repin pass advisory: would clear pin, nothing written", {
                      companyId: company.id,
                      issue: identifier,
                      tier: tier2
                    });
                  }
                  await ctx.activity.log({
                    companyId: company.id,
                    message: `Model Selection cleared pin on ${identifier ?? issueId} (blocked): lane reservation released${advisorySuffix}`,
                    entityType: "issue",
                    entityId: issueId,
                    metadata: { from: pinnedModelId, modelId: null, tier: tier2, reason: "clear-on-blocked", ...writesAllowed ? {} : { advisory: true, written: false } }
                  });
                  if (writesAllowed) repinned += 1;
                  return repinned >= REPIN_PASS_WRITE_LIMIT ? "stop" : "settled";
                }
                const usage = await described.contextUsage(config.selection.contextRunLogRoot);
                const contextEstimate = estimateIssueContext({
                  lastRunPeakTokens: usage.lastRunPeakTokens,
                  history: usage.history,
                  fleetCeilingTokens: config.selection.fleetContextCeilingTokens
                });
                described.descriptor.requiredContextTokens = contextEstimate.tokens ?? void 0;
                const pinExpired = isPinExpired(pinPinnedAt, issueId, nowMs);
                const pinnedIsFallbackOnly = config.models.find((model) => model.id === pinnedModelId)?.fallbackOnly === true;
                const hasRecoveredNormal = pinnedIsFallbackOnly && config.models.some(
                  (model) => !model.fallbackOnly && isUsableAndCapable(
                    model.id,
                    tier2,
                    described.descriptor.requiredContextTokens,
                    config,
                    laneLedger,
                    laneOutageOverride,
                    modelScores,
                    nowIso
                  )
                );
                if (!pinExpired && !hasRecoveredNormal && isUsableAndCapable(
                  pinnedModelId,
                  tier2,
                  described.descriptor.requiredContextTokens,
                  config,
                  laneLedger,
                  laneOutageOverride,
                  modelScores,
                  nowIso
                )) {
                  return "settled";
                }
                const result = await advise(company.id, { issueId }, false, tier2, true, contextUsageCache);
                if (!result || result.decision.outcome !== "selected" || !result.decision.modelId) return "settled";
                if (result.decision.modelId === pinnedModelId) {
                  if (pinExpired) {
                    if (repinDeadlineAt !== null && Date.now() >= repinDeadlineAt) return "unsettled";
                    await recordPinTimestamp(company.id, issueId, nowIso);
                  }
                  return "settled";
                }
                if (!isUsableAndCapable(
                  result.decision.modelId,
                  tier2,
                  described.descriptor.requiredContextTokens,
                  config,
                  laneLedger,
                  laneOutageOverride,
                  modelScores,
                  nowIso
                )) {
                  return "settled";
                }
                const selectedModel = recoverSelectedCandidate(config.models, result.decision);
                if (!selectedModel) return "settled";
                if (pinnedIsFallbackOnly && selectedModel.fallbackOnly) {
                  if (pinExpired) {
                    if (repinDeadlineAt !== null && Date.now() >= repinDeadlineAt) return "unsettled";
                    await recordPinTimestamp(company.id, issueId, nowIso);
                  }
                  return "settled";
                }
                if (rowSliceSpent(rowStartedAt)) {
                  ctx.logger.warn("repin pass skipped slow row write: row exceeded its time slice", {
                    companyId: company.id,
                    issue: identifier,
                    tier: tier2,
                    rowDurationMs: Date.now() - rowStartedAt,
                    rowTimeoutMs: REPIN_PASS_ROW_TIMEOUT_MS
                  });
                  return "unsettled";
                }
                if (!await balanceWriteStillSafe(company.id, issueId, pinnedModelId, config.models)) return "settled";
                if (writesAllowed) {
                  const repinPatch = modelOverrideForContext({
                    model: selectedModel,
                    agentEnvContextTokens: config.selection.agentEnvContextTokens,
                    compactionRatio: config.selection.compactionRatio,
                    agentEnv: described.agentEnv,
                    agentAdapterType: described.agentAdapterType,
                    agentAdapterConfig: described.agentAdapterConfig,
                    existingOverrideEnv: described.existingOverrideEnv,
                    cheapModelId: result.ancillaryModelId,
                    provenance: fallbackPinProvenance(selectedModel, described.assigneeAgentId)
                  });
                  await ctx.issues.update(issueId, repinPatch, company.id);
                  await recordPinTimestamp(company.id, issueId, nowIso);
                  await recordFallbackPin(company.id, issueId, repinPatch);
                } else {
                  ctx.logger.info("repin pass advisory: would re-pin, nothing written", {
                    companyId: company.id,
                    issue: identifier,
                    tier: tier2,
                    from: pinnedModelId,
                    modelId: result.decision.modelId
                  });
                }
                await ctx.activity.log({
                  companyId: company.id,
                  message: `Model Selection re-pinned ${pinnedModelId} -> ${result.decision.modelId} (${tier2}): ${pinExpired ? "pin expired, re-validated" : hasRecoveredNormal ? "fallback lane recovered; normal lane serviceable again" : "lane unusable or measurably demoted"}${advisorySuffix}`,
                  entityType: "issue",
                  entityId: issueId,
                  // TOG-12206 P2: the served leg of the v2 identity (null on legacy).
                  metadata: { from: pinnedModelId, modelId: result.decision.modelId, tier: tier2, trace: result.decision.trace, candidateId: selectedModel.candidateId, ...writesAllowed ? {} : { advisory: true, written: false } }
                });
                if (writesAllowed) repinned += 1;
                return repinned >= REPIN_PASS_WRITE_LIMIT ? "stop" : "settled";
              }
            );
            repinSlowestRowMs = walk.slowestRowMs;
            if (walk.abandoned) {
              const abandoned = asRecord3(walk.abandoned.row);
              ctx.logger.warn("repin pass abandoned a slow row at the deadline", {
                companyId: company.id,
                issue: typeof abandoned.identifier === "string" ? abandoned.identifier : abandoned.id,
                rowDurationMs: walk.abandoned.rowDurationMs
              });
            }
            repinnedTotal = repinned;
            budgetExhausted = walk.budgetExhausted;
            if (incremental) {
              await advanceScanCursor(
                company.id,
                PLUGIN_STATE_KEYS.repinLastScanAt,
                candidateRows,
                walk.settledPrefix,
                REPIN_PASS_FETCH_LIMIT,
                incremental.firingStartMs
              );
            }
            ctx.logger.info("repin pass complete", {
              companyId: company.id,
              repinned,
              candidates: candidateRows.length,
              examined: walk.examined.length,
              skippedSlowRows: walk.unsettled,
              slowestRowMs: walk.slowestRowMs,
              budgetExhausted: walk.budgetExhausted,
              jobDurationMs: Date.now() - repinJobStartedAt
            });
          } catch (cause) {
            ctx.logger.error("repin pass failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause)
            });
          }
        }
        return { repinned: repinnedTotal, budgetExhausted, slowestRowMs: repinSlowestRowMs };
      };
      const runFallbackLeasePass = async (companyId) => {
        let released = 0;
        try {
          const indexed = Object.entries(await readFallbackPins(companyId));
          if (indexed.length === 0) return 0;
          const config = await companyConfig(companyId);
          if (!config.classification.enabled) return 0;
          const writesAllowed = selectionWritesAllowed(config);
          const advisorySuffix = writesAllowed ? "" : " \u2014 advisory, nothing written";
          const laneLedger = await readLaneLedger(companyId);
          const laneOutageOverride = await readLaneOutage(companyId);
          const modelScores = await readModelScores(companyId);
          const nowIso = (/* @__PURE__ */ new Date()).toISOString();
          const contextUsageCache = /* @__PURE__ */ new Map();
          const primaries = applyDerivedTiers(config.models, modelScores).filter(
            (model) => model.enabled && !model.fallbackOnly
          );
          const dropped = /* @__PURE__ */ new Map();
          const checked = /* @__PURE__ */ new Map();
          indexed.sort(
            ([, a], [, b]) => (a.checkedAt ?? "").localeCompare(b.checkedAt ?? "") || a.decidedAt.localeCompare(b.decidedAt)
          );
          for (const [issueId, entry] of indexed.slice(0, FALLBACK_LEASE_EXAMINE_LIMIT)) {
            if (released >= FALLBACK_LEASE_WRITE_LIMIT) break;
            const described = await describeIssue(companyId, issueId, {}, contextUsageCache);
            const stamp = described ? readPinProvenance(described.existingOverrideEnv) : null;
            const pinnedModelId = described ? resolveConfiguredModelId(described.descriptor.pinnedModelId, config.models) : null;
            if (!described || stamp?.decisionId !== entry.decisionId || !pinnedModelId || described.hasOperatorPin || !balanceOpenStatuses.has(described.status)) {
              dropped.set(issueId, entry.decisionId);
              continue;
            }
            checked.set(issueId, entry.decisionId);
            if (!described.isIdle || described.status === "blocked") continue;
            const tier2 = tierWithFallback(described.descriptor, config.models, config.selection.defaultTier);
            const usage = await described.contextUsage(config.selection.contextRunLogRoot);
            described.descriptor.requiredContextTokens = estimateIssueContext({
              lastRunPeakTokens: usage.lastRunPeakTokens,
              history: usage.history,
              fleetCeilingTokens: config.selection.fleetContextCeilingTokens
            }).tokens ?? void 0;
            const usable = (modelId) => isUsableAndCapable(
              modelId,
              tier2,
              described.descriptor.requiredContextTokens,
              config,
              laneLedger,
              laneOutageOverride,
              modelScores,
              nowIso
            );
            if (!primaries.some((model) => usable(model.id))) continue;
            const result = await advise(companyId, { issueId }, false, tier2, true, contextUsageCache);
            if (!result || result.decision.outcome !== "selected" || !result.decision.modelId) continue;
            const selectedModel = config.models.find((model) => model.id === result.decision.modelId);
            if (!selectedModel || selectedModel.fallbackOnly || selectedModel.id === pinnedModelId) continue;
            if (!usable(selectedModel.id)) continue;
            if (!await balanceWriteStillSafe(companyId, issueId, pinnedModelId, config.models)) continue;
            const patch = modelOverrideForContext({
              model: selectedModel,
              agentEnvContextTokens: config.selection.agentEnvContextTokens,
              compactionRatio: config.selection.compactionRatio,
              agentEnv: described.agentEnv,
              agentAdapterType: described.agentAdapterType,
              agentAdapterConfig: described.agentAdapterConfig,
              existingOverrideEnv: described.existingOverrideEnv,
              cheapModelId: result.ancillaryModelId,
              provenance: null
            });
            if (writesAllowed) {
              await ctx.issues.update(issueId, patch, companyId);
              dropped.set(issueId, entry.decisionId);
              await recordPinTimestamp(companyId, issueId, nowIso);
            } else {
              ctx.logger.info("fallback lease pass advisory: would release the fallback pin, nothing written", {
                companyId,
                issue: described.identifier ?? issueId,
                from: pinnedModelId,
                modelId: selectedModel.id,
                tier: tier2
              });
            }
            await ctx.activity.log({
              companyId,
              message: `Model Selection moved ${described.identifier ?? issueId} off fallback ${pinnedModelId} -> ${selectedModel.id} (${tier2}): primary serviceable again${advisorySuffix}`,
              entityType: "issue",
              entityId: issueId,
              metadata: {
                from: pinnedModelId,
                modelId: selectedModel.id,
                tier: tier2,
                decisionId: entry.decisionId,
                reason: "fallback-lease",
                trace: result.decision.trace,
                ...writesAllowed ? {} : { advisory: true, written: false }
              }
            });
            if (writesAllowed) released += 1;
          }
          const latest = await readFallbackPins(companyId);
          for (const [issueId, decisionId] of dropped) {
            if (latest[issueId]?.decisionId === decisionId) delete latest[issueId];
          }
          for (const [issueId, decisionId] of checked) {
            const current = latest[issueId];
            if (current?.decisionId === decisionId) current.checkedAt = nowIso;
          }
          await ctx.state.set(fallbackPinsKey(companyId), latest);
          ctx.logger.info("fallback lease pass complete", { companyId, released, indexed: indexed.length });
        } catch (cause) {
          ctx.logger.error("fallback lease pass failed for a company", {
            companyId,
            error: cause instanceof Error ? cause.message : String(cause)
          });
        }
        return released;
      };
      ctx.jobs.register(JOB_KEYS.repinPass, async () => {
        const jobStartedAt = Date.now();
        const deadlineAt = jobStartedAt + REPIN_PASS_JOB_BUDGET_MS;
        let slowestRowMs = 0;
        for (const company of listKnownCompanies()) {
          if (Date.now() >= deadlineAt) {
            ctx.logger.warn("repin pass stopped before the host RPC wall", {
              companyId: company.id,
              jobDurationMs: Date.now() - jobStartedAt
            });
            break;
          }
          const firingStartMs = Date.now();
          const sinceIso = new Date(await readScanMark(company.id, PLUGIN_STATE_KEYS.repinLastScanAt)).toISOString();
          const sweep = await runRepinPassForCompany(company.id, { sinceIso, firingStartMs, deadlineAt, slowestRowMs });
          slowestRowMs = sweep.slowestRowMs;
          if (sweep.budgetExhausted) break;
          await runFallbackLeasePass(company.id);
        }
      });
      const repairPinEnvAfterConfigFailure = async (companyId, issueId, runId) => {
        let result;
        try {
          result = await advise(companyId, { issueId }, false);
        } catch {
          return;
        }
        if (!result || !result.hasOverride || result.decision.advisory) return;
        const staleSecretRefKeys = staleOverrideSecretRefKeys(result.existingOverrideEnv, result.agentEnv);
        const plan = planEnvRepair({ pinnedModelId: result.pinnedModelId, staleSecretRefKeys }, issueId);
        if (!plan?.modelId) return;
        const pinnedModel = result.config.models.find((model) => model.id === plan.modelId);
        if (!pinnedModel) {
          ctx.logger.warn("pin env repair skipped: pinned model is absent from the resolved roster", {
            companyId,
            issueId,
            modelId: plan.modelId
          });
          return;
        }
        const patch = modelOverrideForContext({
          model: pinnedModel,
          agentEnvContextTokens: result.config.selection.agentEnvContextTokens,
          compactionRatio: result.config.selection.compactionRatio,
          agentEnv: result.agentEnv,
          agentAdapterType: result.agentAdapterType,
          agentAdapterConfig: result.agentAdapterConfig,
          existingOverrideEnv: result.existingOverrideEnv,
          cheapModelId: result.ancillaryModelId
        });
        try {
          await ctx.issues.update(issueId, patch, companyId);
        } catch (cause) {
          ctx.logger.warn("pin env repair write rejected", {
            companyId,
            issueId,
            error: cause instanceof Error ? cause.message : String(cause)
          });
          return;
        }
        await ctx.activity.log({
          companyId,
          message: `Model Selection repaired the env of its ${plan.modelId} pin on this issue (model unchanged): a run failed configuration_incomplete on secret refs the assignee no longer carries.`,
          entityType: "issue",
          entityId: issueId,
          metadata: { modelId: plan.modelId, staleSecretRefKeys, runId, trigger: "agent.run.failed" }
        });
      };
      ctx.events.on("agent.run.failed", async (event) => {
        const payload = asRecord3(event.payload);
        const companyId = event.companyId;
        const issueId = typeof payload.issueId === "string" ? payload.issueId : null;
        let config;
        try {
          config = await companyConfig(companyId);
        } catch {
          return;
        }
        if (config.models.length === 0) return;
        if (payload.errorCode === "configuration_incomplete") {
          if (issueId) {
            await repairPinEnvAfterConfigFailure(
              companyId,
              issueId,
              typeof payload.runId === "string" ? payload.runId : null
            );
          }
          return;
        }
        const fallbackModelId = async () => {
          if (!issueId) return null;
          try {
            const described = await describeIssue(companyId, issueId, {});
            return described?.descriptor.pinnedModelId ?? null;
          } catch {
            return null;
          }
        };
        const quickVerdict = laneExhaustionFromRunFailure({
          error: typeof payload.error === "string" ? payload.error : null,
          errorCode: typeof payload.errorCode === "string" ? payload.errorCode : null,
          models: config.models
        });
        const verdict = quickVerdict ?? laneExhaustionFromRunFailure({
          error: typeof payload.error === "string" ? payload.error : null,
          errorCode: typeof payload.errorCode === "string" ? payload.errorCode : null,
          models: config.models,
          fallbackModelId: await fallbackModelId()
        });
        if (!verdict) return;
        const nowMs = Date.parse(event.occurredAt) || Date.now();
        const nowIso = new Date(nowMs).toISOString();
        const existing = await readLaneOutage(companyId);
        if (isLaneOutageActive(existing, nowIso) && existing.lanes.includes(verdict.laneId)) {
          ctx.logger.info("lane already quarantined, skipping repeat sweep", {
            companyId,
            laneId: verdict.laneId,
            until: existing.until
          });
          return;
        }
        const addition = autoQuarantineFor(verdict, nowMs);
        await ctx.state.set(laneOutageKey(companyId), mergeLaneOutage(existing, addition, nowIso));
        await ctx.activity.log({
          companyId,
          message: `Model Selection quarantined lane ${verdict.laneId} until ${addition.until}: a run was rejected on ${verdict.modelId} with a lane-capacity error. Re-pinning open cards off this lane now.`,
          ...issueId ? { entityType: "issue", entityId: issueId } : {},
          metadata: {
            laneId: verdict.laneId,
            modelId: verdict.modelId,
            until: addition.until,
            matchedPhrase: verdict.matchedPhrase,
            modelFromErrorText: verdict.modelFromErrorText,
            runId: typeof payload.runId === "string" ? payload.runId : null
          }
        });
        const { repinned } = await runRepinPassForCompany(companyId);
        ctx.logger.info("lane quarantine repin complete", { companyId, laneId: verdict.laneId, repinned });
      });
      ctx.jobs.register(JOB_KEYS.balancePass, async () => {
        const companies = listKnownCompanies();
        const jobStartedAt = Date.now();
        const deadlineAt = jobStartedAt + BALANCE_PASS_JOB_BUDGET_MS;
        let slowestRowMs = 0;
        for (const company of companies) {
          if (Date.now() >= deadlineAt) {
            ctx.logger.warn("balance pass stopped before the host RPC wall", {
              companyId: company.id,
              durationMs: Date.now() - jobStartedAt,
              budgetMs: BALANCE_PASS_JOB_BUDGET_MS
            });
            break;
          }
          const startedAt = Date.now();
          try {
            const config = await companyConfig(company.id);
            if (!config.classification.enabled) continue;
            if (runResolveActive(config)) {
              ctx.logger.info("balance pass skipped: run-scoped model decisions are live", { companyId: company.id });
              continue;
            }
            const writesAllowed = selectionWritesAllowed(config);
            const advisorySuffix = writesAllowed ? "" : " \u2014 advisory, nothing written";
            const balanceFiringStartMs = startedAt;
            const balanceScanMarkMs = await readScanMark(company.id, PLUGIN_STATE_KEYS.balanceLastScanAt);
            const balanceMaxMs = await (async () => {
              try {
                const maxRows = await ctx.db.query(
                  `select max(updated_at) as max_updated
                     from issues
                    where company_id = $1
                      -- TOG-5227: the gate watches routable cards only, so a
                      -- user-assigned card changing cannot force a cycle that
                      -- would only skip it again.
                      and assignee_user_id is null
                      and status in ('todo','in_progress','blocked','in_review')`,
                  [company.id]
                );
                const rawMax = asRecord3(maxRows[0]).max_updated;
                if (rawMax instanceof Date) return rawMax.getTime();
                if (typeof rawMax === "string") {
                  const ms = Date.parse(rawMax);
                  return Number.isFinite(ms) ? ms : null;
                }
                return null;
              } catch {
                return null;
              }
            })();
            if (balanceMaxMs !== null && balanceMaxMs <= balanceScanMarkMs) {
              ctx.logger.info("balance pass skipped: no issues changed since last scan", {
                companyId: company.id,
                since: new Date(balanceScanMarkMs).toISOString()
              });
              await writeScanMark(company.id, PLUGIN_STATE_KEYS.balanceLastScanAt, balanceFiringStartMs);
              continue;
            }
            const cursorKey = {
              scopeKind: "company",
              scopeId: company.id,
              stateKey: PLUGIN_STATE_KEYS.balancePassCursor
            };
            const storedCursor = asRecord3(await ctx.state.get(cursorKey));
            const afterId = typeof storedCursor.afterId === "string" ? storedCursor.afterId : "";
            const candidateRows = await ctx.db.query(
              `select i.id::text as id,
                      i.identifier as identifier
                 from issues i
                 join agents a on a.id = i.assignee_agent_id
                where i.company_id = $1
                  and i.id::text > $2
                  and i.status in ('todo','in_progress','blocked','in_review')
                  and a.status <> 'terminated'
                  -- TOG-5227: a user-assigned card rejects issues.update
                  -- with an agent override ("Issue can only have one
                  -- assignee"), which used to abort the whole pass.
                  and i.assignee_user_id is null
                order by i.id::text asc
                limit $3`,
              [company.id, afterId, String(BALANCE_PASS_FETCH_LIMIT)]
            );
            const activeRunIssueIds = await activeBalanceRunIssueIds(company.id);
            const laneLedger = await readLaneLedger(company.id);
            const laneOutageOverride = await readLaneOutage(company.id);
            const modelScores = await readModelScores(company.id);
            const nowIso = (/* @__PURE__ */ new Date()).toISOString();
            const now = Date.now();
            const contextUsageCache = /* @__PURE__ */ new Map();
            let balanced = 0;
            let pacePullWeights = null;
            let pacePullZaiMargin = null;
            const pacePullFreeSlots = /* @__PURE__ */ new Map();
            const pacePullMoved = /* @__PURE__ */ new Map();
            const isPastWriteDeadline = (rowStartedAt) => Date.now() >= deadlineAt || Date.now() - rowStartedAt >= BALANCE_PASS_ROW_TIMEOUT_MS;
            const walk = await walkRowsWithinDeadline(
              candidateRows,
              { deadlineAt, rowTimeoutMs: BALANCE_PASS_ROW_TIMEOUT_MS, slowestRowMs },
              async (row, rowStartedAt) => {
                const r = asRecord3(row);
                const issueId = typeof r.id === "string" ? r.id : null;
                const identifier = typeof r.identifier === "string" ? r.identifier : issueId;
                if (!issueId) return "settled";
                if (activeRunIssueIds.has(issueId)) return "settled";
                const described = await describeIssue(company.id, issueId, {}, contextUsageCache);
                if (!described) return "settled";
                if (!balanceOpenStatuses.has(described.status)) return "settled";
                if (!described.isIdle) return "settled";
                if (described.hasOperatorPin) return "settled";
                if (described.assigneeUserId) return "settled";
                const status = described.status;
                const labelTier = tierFromLabels(described.descriptor.labelNames);
                const pinnedModelId = resolveConfiguredModelId(described.descriptor.pinnedModelId, config.models);
                const pinnedModel = pinnedModelId ? config.models.find((m) => m.id === pinnedModelId) : void 0;
                if (!labelTier && !pinnedModelId) return "settled";
                const tier2 = labelTier ?? tierWithFallback(described.descriptor, config.models, config.selection.defaultTier);
                const skipSlowWrite = (logTier) => {
                  ctx.logger.warn("balance pass skipped slow row write: row exceeded its time slice", {
                    companyId: company.id,
                    issue: identifier,
                    tier: logTier,
                    rowDurationMs: Date.now() - rowStartedAt,
                    rowTimeoutMs: BALANCE_PASS_ROW_TIMEOUT_MS
                  });
                  return "unsettled";
                };
                if (pinnedModelId && pinnedModel) {
                  const currentUtilization = pinnedModel.laneId ? laneEffectiveUtilization(laneLedger, pinnedModel.laneId) : null;
                  const result2 = await advise(company.id, { issueId }, false, void 0, true, contextUsageCache);
                  if (!result2 || result2.decision.outcome !== "selected" || !result2.decision.modelId) return "settled";
                  if (!result2.isIdle || !balanceOpenStatuses.has(result2.status)) return "settled";
                  if (resolveConfiguredModelId(result2.pinnedModelId, config.models) !== pinnedModelId) return "settled";
                  const envDrifted = overrideEnvOnExcludedLane({
                    existingOverrideEnv: result2.existingOverrideEnv,
                    models: config.models,
                    ledger: laneLedger,
                    laneOutageOverride,
                    nowIso,
                    laneAvoidConfig: config.pacing.avoid,
                    pacingMode: config.pacing.mode
                  });
                  if (result2.decision.modelId === pinnedModelId && !envDrifted) return "settled";
                  const newModel = config.models.find((m) => m.id === result2.decision.modelId);
                  if (!newModel) return "settled";
                  const newUtilization = newModel.laneId ? laneEffectiveUtilization(laneLedger, newModel.laneId) : null;
                  const cheaper = blendedListPrice(newModel) <= BALANCE_PASS_COST_DOWN_MULTIPLIER * blendedListPrice(pinnedModel);
                  const pinnedScore = tierScoreFor(modelScores[pinnedModelId], tier2);
                  let incapable = pinnedScore ? pinnedScore.capable === false : false;
                  if (!incapable && blendedListPrice(pinnedModel) < BALANCE_PASS_PROBATION_PRICE_USD && !(pinnedScore?.proven ?? false)) {
                    const activeCount = await countActivePinsOfModel(company.id, pinnedModelId);
                    if (activeCount > 1) incapable = true;
                  }
                  if (!incapable && (status === "todo" || status === "in_progress") && pinnedModel.laneId && config.pacing.mode !== "off") {
                    const pinsWeightByLane = await activePinsWeightByLane(company.id, config.models);
                    const admitted = laneHasRoom({
                      laneId: pinnedModel.laneId,
                      activePinsWeight: pinsWeightByLane[pinnedModel.laneId] ?? 0,
                      extra: -1,
                      ledger: laneLedger,
                      capPerAccount: config.pacing.laneCapPerAccount,
                      fiveHourWindowName: config.pacing.fiveHourWindowName,
                      zaiLaneId: config.pacing.zai.laneId,
                      zaiWeeklyWindowName: config.pacing.zai.weeklyWindowName,
                      zaiWeeklyDefaultMargin: config.pacing.zai.weeklyDefaultMargin,
                      zaiPaceOverrideMargin: null,
                      nowMs: now
                    });
                    if (!admitted) incapable = true;
                  }
                  const busier = currentUtilization !== null && newUtilization !== null && currentUtilization - newUtilization >= BALANCE_PASS_BUSIER_UTILIZATION_DELTA;
                  let pacePull = false;
                  let pacePullTargetLaneId = null;
                  if (!cheaper && !incapable && !busier && !envDrifted && config.pacing.mode === "enforce" && !result2.decision.advisory && result2.decision.modelId !== pinnedModelId && isBehindPace(laneLedger, newModel) && pacePreferenceRank(laneLedger, newModel) < pacePreferenceRank(laneLedger, pinnedModel)) {
                    const targetLaneId = newModel.laneId ?? null;
                    if (targetLaneId) {
                      if (pacePullWeights === null) {
                        pacePullWeights = await activePinsWeightByLane(company.id, config.models);
                        pacePullZaiMargin = activeZaiPaceOverride(await readZaiPaceOverride(company.id), nowIso);
                      }
                      const moved = pacePullMoved.get(targetLaneId) ?? 0;
                      let freeSlots = pacePullFreeSlots.get(targetLaneId);
                      if (freeSlots === void 0) {
                        const per = config.pacing.laneCapPerAccount[targetLaneId];
                        const accounts = Math.max(1, laneHealthyAccountCount(laneLedger, targetLaneId));
                        freeSlots = per === void 0 ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(per * accounts - (pacePullWeights[targetLaneId] ?? 0)));
                        pacePullFreeSlots.set(targetLaneId, freeSlots);
                      }
                      const targetRoom = moved < freeSlots && laneHasRoom({
                        laneId: targetLaneId,
                        activePinsWeight: pacePullWeights[targetLaneId] ?? 0,
                        ledger: laneLedger,
                        capPerAccount: config.pacing.laneCapPerAccount,
                        fiveHourWindowName: config.pacing.fiveHourWindowName,
                        zaiLaneId: config.pacing.zai.laneId,
                        zaiWeeklyWindowName: config.pacing.zai.weeklyWindowName,
                        zaiWeeklyDefaultMargin: config.pacing.zai.weeklyDefaultMargin,
                        zaiPaceOverrideMargin: pacePullZaiMargin,
                        nowMs: now
                      });
                      if (targetRoom) {
                        pacePull = true;
                        pacePullTargetLaneId = targetLaneId;
                      }
                    }
                  }
                  if (!(cheaper || incapable || busier || envDrifted || pacePull)) return "settled";
                  const selectedModel2 = recoverSelectedCandidate(config.models, result2.decision);
                  if (!selectedModel2) return "settled";
                  if (cheaper && !incapable && !busier) {
                    const evidence = await readLaneEvidence(company.id, config.models, now);
                    const from = evidenceStateFor(evidence, pinnedModel.laneId ?? null);
                    const to = evidenceStateFor(evidence, selectedModel2.laneId ?? null);
                    if (costDownWouldAbandonProvenLane(from, to)) {
                      if (Date.now() >= deadlineAt) return "unsettled";
                      await ctx.activity.log({
                        companyId: company.id,
                        message: `Model Selection held ${pinnedModelId} (cost-down to ${selectedModel2.id} refused): lane ${pinnedModel.laneId ?? "(none)"} is proven-good over ${evidence.windowHours}h, lane ${selectedModel2.laneId ?? "(none)"} is ${to}`,
                        entityType: "issue",
                        entityId: issueId,
                        metadata: {
                          from: pinnedModelId,
                          heldAgainst: selectedModel2.id,
                          fromEvidence: from,
                          toEvidence: to,
                          reason: "lane-evidence"
                        }
                      });
                      return "settled";
                    }
                  }
                  if (!await balanceWriteStillSafe(company.id, issueId, pinnedModelId, config.models)) return "settled";
                  if (isPastWriteDeadline(rowStartedAt)) return skipSlowWrite(tier2);
                  if (writesAllowed) {
                    try {
                      const balancePatch = modelOverrideForContext({
                        model: selectedModel2,
                        agentEnvContextTokens: config.selection.agentEnvContextTokens,
                        compactionRatio: config.selection.compactionRatio,
                        agentEnv: result2.agentEnv,
                        agentAdapterType: result2.agentAdapterType,
                        agentAdapterConfig: result2.agentAdapterConfig,
                        existingOverrideEnv: result2.existingOverrideEnv,
                        // TOG-3116: haiku-class sub-call keys follow the
                        // cheapest healthy T3 pick (falls back to the pin).
                        cheapModelId: result2.ancillaryModelId,
                        provenance: fallbackPinProvenance(selectedModel2, result2.assigneeAgentId)
                      });
                      await ctx.issues.update(issueId, balancePatch, company.id);
                      await recordFallbackPin(company.id, issueId, balancePatch);
                    } catch (cause) {
                      ctx.logger.warn("balance pass skipped a card it could not pin", {
                        companyId: company.id,
                        issue: identifier,
                        error: cause instanceof Error ? cause.message : String(cause)
                      });
                      return "settled";
                    }
                  } else {
                    ctx.logger.info("balance pass advisory: would balance, nothing written", {
                      companyId: company.id,
                      issue: identifier,
                      tier: tier2,
                      from: pinnedModelId,
                      modelId: result2.decision.modelId
                    });
                  }
                  await ctx.activity.log({
                    companyId: company.id,
                    message: (result2.decision.modelId === pinnedModelId ? `Model Selection evacuated sub-call env off a dead lane on ${pinnedModelId} (${tier2}): pin unchanged` : `Model Selection balanced ${pinnedModelId} -> ${result2.decision.modelId} (${tier2}): ${cheaper ? "cost-down" : incapable ? "demote" : busier ? "rebalance" : pacePull ? "pace-pull" : "env-evacuation"}`) + advisorySuffix,
                    entityType: "issue",
                    entityId: issueId,
                    metadata: {
                      from: pinnedModelId,
                      modelId: result2.decision.modelId,
                      tier: tier2,
                      cheaper,
                      incapable,
                      busier,
                      envDrifted,
                      pacePull,
                      // TOG-12206 P2: the served leg of the v2 identity (null on legacy).
                      candidateId: selectedModel2.candidateId,
                      ...writesAllowed ? {} : { advisory: true, written: false }
                    }
                  });
                  if (writesAllowed) {
                    balanced += 1;
                    if (pacePullTargetLaneId) {
                      pacePullMoved.set(
                        pacePullTargetLaneId,
                        (pacePullMoved.get(pacePullTargetLaneId) ?? 0) + 1
                      );
                    }
                  }
                  return balanced >= BALANCE_PASS_WRITE_LIMIT ? "stop" : "settled";
                }
                const result = await advise(company.id, { issueId }, false, "T1", false, contextUsageCache);
                if (!result || result.decision.outcome !== "selected" || !result.decision.modelId) {
                  if (Date.now() >= deadlineAt) return "unsettled";
                  await maybeLogUnpinnableCard(company.id, issueId, identifier, result?.decision ?? null);
                  return "settled";
                }
                if (!result.isIdle || !balanceOpenStatuses.has(result.status)) return "settled";
                if (result.pinnedModelId !== null) return "settled";
                const floorModelId = resolveConfiguredModelId(result.agentFloorModelId, config.models);
                const floorHealthy = result.decision.modelId === floorModelId && isUsableAndCapable(
                  floorModelId,
                  tier2,
                  described.descriptor.requiredContextTokens,
                  config,
                  laneLedger,
                  laneOutageOverride,
                  modelScores,
                  nowIso
                );
                if (floorHealthy) return "settled";
                const selectedModel = recoverSelectedCandidate(config.models, result.decision);
                if (!selectedModel) return "settled";
                if (!await balanceWriteStillSafe(company.id, issueId, null, config.models)) return "settled";
                if (isPastWriteDeadline(rowStartedAt)) return skipSlowWrite("T1");
                if (writesAllowed) {
                  try {
                    const balancePatch = modelOverrideForContext({
                      model: selectedModel,
                      agentEnvContextTokens: config.selection.agentEnvContextTokens,
                      compactionRatio: config.selection.compactionRatio,
                      agentEnv: result.agentEnv,
                      agentAdapterType: result.agentAdapterType,
                      agentAdapterConfig: result.agentAdapterConfig,
                      existingOverrideEnv: result.existingOverrideEnv,
                      // TOG-3116: haiku-class sub-call keys follow the
                      // cheapest healthy T3 pick (falls back to the pin).
                      cheapModelId: result.ancillaryModelId,
                      provenance: fallbackPinProvenance(selectedModel, result.assigneeAgentId)
                    });
                    await ctx.issues.update(issueId, balancePatch, company.id);
                    await recordFallbackPin(company.id, issueId, balancePatch);
                  } catch (cause) {
                    ctx.logger.warn("balance pass skipped a card it could not pin", {
                      companyId: company.id,
                      issue: identifier,
                      error: cause instanceof Error ? cause.message : String(cause)
                    });
                    return "settled";
                  }
                } else {
                  ctx.logger.info("balance pass advisory: would pin unpinned card, nothing written", {
                    companyId: company.id,
                    issue: identifier,
                    modelId: result.decision.modelId
                  });
                }
                await ctx.activity.log({
                  companyId: company.id,
                  message: (result.decision.modelId === floorModelId ? `Model Selection explicitly pinned ${result.decision.modelId} (T1): floor lane unserviceable` : `Model Selection balanced floor -> ${result.decision.modelId} (T1): unpinned labelled card given a balanced T1 pin`) + advisorySuffix,
                  entityType: "issue",
                  entityId: issueId,
                  // TOG-12206 P2: the served leg of the v2 identity (null on legacy).
                  metadata: { from: floorModelId, modelId: result.decision.modelId, tier: "T1", candidateId: selectedModel.candidateId, ...writesAllowed ? {} : { advisory: true, written: false } }
                });
                if (writesAllowed) balanced += 1;
                return balanced >= BALANCE_PASS_WRITE_LIMIT ? "stop" : "settled";
              }
            );
            slowestRowMs = walk.slowestRowMs;
            if (walk.abandoned) {
              const abandoned = asRecord3(walk.abandoned.row);
              ctx.logger.warn("balance pass abandoned a slow row at the deadline", {
                companyId: company.id,
                issue: typeof abandoned.identifier === "string" ? abandoned.identifier : abandoned.id,
                rowDurationMs: walk.abandoned.rowDurationMs
              });
            }
            const scanned = walk.examined.length;
            const lastExamined = scanned > 0 ? asRecord3(walk.examined[scanned - 1]).id : void 0;
            const lastScannedId = typeof lastExamined === "string" ? lastExamined : afterId;
            const cycleComplete = scanned === candidateRows.length && candidateRows.length < BALANCE_PASS_FETCH_LIMIT;
            const nextAfterId = cycleComplete ? null : lastScannedId || null;
            await ctx.state.set(cursorKey, { afterId: nextAfterId });
            if (cycleComplete) {
              await writeScanMark(company.id, PLUGIN_STATE_KEYS.balanceLastScanAt, balanceFiringStartMs);
            }
            ctx.logger.info("balance pass complete", {
              companyId: company.id,
              balanced,
              candidates: candidateRows.length,
              scanned,
              skippedSlowRows: walk.unsettled,
              slowestRowMs: walk.slowestRowMs,
              afterId: afterId || null,
              nextAfterId,
              cycleComplete,
              budgetExhausted: walk.budgetExhausted,
              durationMs: Date.now() - startedAt,
              jobDurationMs: Date.now() - jobStartedAt
            });
            if (walk.budgetExhausted) break;
          } catch (cause) {
            ctx.logger.error("balance pass failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause),
              durationMs: Date.now() - startedAt,
              jobDurationMs: Date.now() - jobStartedAt
            });
          }
        }
      });
      ctx.jobs.register(JOB_KEYS.dispatchSweep, async (job) => {
        const companies = listKnownCompanies();
        const jobStartedAt = Date.now();
        const deadlineAt = jobStartedAt + DISPATCH_SWEEP_JOB_BUDGET_MS;
        for (const company of companies) {
          if (Date.now() >= deadlineAt) {
            ctx.logger.warn("dispatch sweep stopped before the host RPC wall", {
              companyId: company.id,
              durationMs: Date.now() - jobStartedAt,
              budgetMs: DISPATCH_SWEEP_JOB_BUDGET_MS
            });
            break;
          }
          try {
            const config = await companyConfig(company.id);
            const dispatchConfig = config.dispatch;
            const notes = [];
            const issues = await ctx.issues.list({
              companyId: company.id,
              limit: DISPATCH_ISSUE_PAGE_LIMIT
            });
            if (issues.length >= DISPATCH_ISSUE_PAGE_LIMIT) {
              ctx.logger.warn("dispatch sweep: issue page saturated, some issues were not seen this firing", {
                companyId: company.id,
                pageLimit: DISPATCH_ISSUE_PAGE_LIMIT
              });
              notes.push(
                `issue list saturated at limit ${DISPATCH_ISSUE_PAGE_LIMIT} \u2014 counters undercount the board`
              );
            }
            const nonTerminal = issues.filter(
              (issue) => !TERMINAL_STATUSES2.includes(issue.status)
            );
            const routingGapBase = summariseRoutingGap(nonTerminal.map((issue) => ({ issue })));
            let routingGap = routingGapBase;
            if (routingGapBase.count > 0) {
              try {
                const agents = await ctx.agents.list({ companyId: company.id });
                routingGap = { ...routingGapBase, owners: identifyRoutingOwners(agents) };
                if (!routingGap.owners?.complete) {
                  notes.push(
                    `routing owners are a partial list: ${(routingGap.owners?.unreadableSources ?? []).join(", ")} are not readable from the plugin capability surface`
                  );
                }
              } catch (cause) {
                ctx.logger.warn("dispatch sweep: could not read agents for routing-gap owners", {
                  companyId: company.id,
                  error: cause instanceof Error ? cause.message : String(cause)
                });
              }
            }
            const assigned = nonTerminal.filter((issue) => issue.assigneeAgentId);
            const population = [];
            const busyAssigneesFromRuns = /* @__PURE__ */ new Set();
            let unreadable = 0;
            let budgetExhausted = false;
            let budgetStopLogged = false;
            const stopOnBudget = (extra) => {
              if (Date.now() < deadlineAt) return false;
              budgetExhausted = true;
              if (!budgetStopLogged) {
                budgetStopLogged = true;
                ctx.logger.warn("dispatch sweep stopped before the host RPC wall", {
                  companyId: company.id,
                  durationMs: Date.now() - jobStartedAt,
                  budgetMs: DISPATCH_SWEEP_JOB_BUDGET_MS,
                  ...extra
                });
              }
              return true;
            };
            const sweepNowMs = Date.now();
            for (const issue of nonTerminal) {
              if (stopOnBudget({
                gathered: population.length,
                remaining: nonTerminal.length - population.length
              })) {
                break;
              }
              if (!issue.assigneeAgentId) {
                population.push({ issue });
                continue;
              }
              if (isParkedOnNamedOwner(issue) || isMonitorArmed(issue, sweepNowMs)) {
                population.push({ issue });
                continue;
              }
              try {
                const orchestration = await ctx.issues.summaries.getOrchestration({
                  issueId: issue.id,
                  companyId: company.id
                });
                const relation = orchestration.relations[issue.id];
                if (stopOnBudget({
                  gathered: population.length,
                  remaining: nonTerminal.length - population.length
                })) {
                  break;
                }
                const interactions = await ctx.issues.listInteractions(issue.id, company.id);
                const runs = orchestration.runs.map((r) => ({
                  issueId: r.issueId,
                  status: r.status,
                  finishedAt: r.finishedAt,
                  startedAt: r.startedAt,
                  createdAt: r.createdAt
                }));
                if (issue.assigneeAgentId && runs.some((r) => r.issueId === issue.id && (r.status === "queued" || r.status === "running"))) {
                  busyAssigneesFromRuns.add(issue.assigneeAgentId);
                }
                population.push({
                  issue,
                  blockedBy: (relation?.blockedBy ?? []).map((b) => ({ id: b.id, status: b.status })),
                  runs,
                  invocationBlock: orchestration.invocationBlocks.find((b) => b.issueId === issue.id) ?? null,
                  pendingInteractions: interactions.filter((i) => i.status === "pending").map((i) => ({
                    status: i.status,
                    addresseeAgentId: i.addresseeAgentId ?? null,
                    effectiveResolverPolicy: i.effectiveResolverPolicy ?? null
                  }))
                });
              } catch (cause) {
                unreadable += 1;
                ctx.logger.warn("dispatch sweep: could not read orchestration for an issue, excluding it", {
                  companyId: company.id,
                  issueId: issue.id,
                  error: cause instanceof Error ? cause.message : String(cause)
                });
              }
            }
            if (unreadable > 0) {
              notes.push(`${unreadable} assigned issues could not be read and are excluded from selection`);
            }
            const busyAssignees = new Set(busyAssigneesFromRuns);
            try {
              const busyRows = await ctx.db.query(
                `select distinct agent_id::text as agent_id
                   from heartbeat_runs
                  where company_id = $1
                    and status in ('running','queued')
                    and agent_id is not null`,
                [company.id]
              );
              for (const row of busyRows) {
                const agentId = asRecord3(row).agent_id;
                if (typeof agentId === "string" && agentId.length > 0) busyAssignees.add(agentId);
              }
            } catch (cause) {
              notes.push("agent busyness unreadable this firing \u2014 idle-assignee class may over-select");
              ctx.logger.warn("dispatch sweep: could not read busy agents, failing open", {
                companyId: company.id,
                error: cause instanceof Error ? cause.message : String(cause)
              });
            }
            const idleAssignees = /* @__PURE__ */ new Set();
            for (const entry of population) {
              const assignee = entry.issue.assigneeAgentId;
              if (assignee && !busyAssignees.has(assignee)) idleAssignees.add(assignee);
            }
            const laneLedger = await readLaneLedger(company.id);
            const laneOutageOverride = await readLaneOutage(company.id);
            const availability = await readAvailability(company.id, sweepNowMs);
            const nowIso = new Date(sweepNowMs).toISOString();
            const unavailableLanes = new Set(
              availability.lanes.filter((lane) => lane.state === "unavailable").map((lane) => lane.laneId)
            );
            const isLaneDown = (laneId) => {
              if (hardStopExcluded(laneLedger, { laneId })) return true;
              if (isLaneOutageActive(laneOutageOverride, nowIso) && (laneOutageOverride?.lanes ?? []).includes(laneId)) {
                return true;
              }
              return unavailableLanes.has(laneId);
            };
            const agentFloorLaneByAgent = /* @__PURE__ */ new Map();
            const laneOfModel = (modelId) => {
              if (!modelId) return null;
              const resolved = resolveConfiguredModelId(modelId, config.models);
              return config.models.find((m) => m.id === resolved)?.laneId ?? null;
            };
            const floorLaneOf = async (assigneeAgentId) => {
              if (agentFloorLaneByAgent.has(assigneeAgentId)) {
                return agentFloorLaneByAgent.get(assigneeAgentId) ?? null;
              }
              let lane = null;
              try {
                const agent = await ctx.agents.get(assigneeAgentId, company.id);
                const adapterConfig = asRecord3(asRecord3(agent).adapterConfig);
                const floorModel = typeof adapterConfig.model === "string" ? adapterConfig.model : null;
                lane = laneOfModel(floorModel);
              } catch {
                lane = null;
              }
              agentFloorLaneByAgent.set(assigneeAgentId, lane);
              return lane;
            };
            const laneByIssueId = /* @__PURE__ */ new Map();
            for (const entry of population) {
              if (stopOnBudget({ lanesResolved: laneByIssueId.size, population: population.length })) {
                break;
              }
              const assignee = entry.issue.assigneeAgentId;
              if (!assignee) continue;
              const row = entry.issue;
              const overrides = asRecord3(row.assigneeAdapterOverrides ?? row.assignee_adapter_overrides);
              const pinned = asRecord3(overrides.adapterConfig).model;
              const pinnedLane = laneOfModel(typeof pinned === "string" ? pinned : null);
              laneByIssueId.set(
                entry.issue.id,
                pinnedLane ?? await floorLaneOf(assignee)
              );
            }
            const selection = selectDispatch(population, {
              idleMinutes: dispatchConfig.idleMinutes,
              maxWakesPerFiring: dispatchConfig.maxWakesPerFiring,
              focusProjectIds: [...dispatchConfig.focusProjectIds],
              now: sweepNowMs,
              idleAssignees,
              laneByIssueId,
              isLaneDown
            });
            selection.routingGap = routingGap;
            const wakeOutcomes = [];
            if (dispatchConfig.wakeEnabled) {
              for (const pick of selection.picks) {
                if (stopOnBudget({
                  picksWoken: wakeOutcomes.filter((o) => o.queued).length,
                  picksRemaining: selection.picks.length - wakeOutcomes.length
                })) {
                  break;
                }
                try {
                  const result = await ctx.issues.requestWakeup(pick.issue.id, company.id, {
                    reason: "dispatch_stalled_issue",
                    contextSource: "plugin.dispatch.sweep",
                    idempotencyKey: `dispatch:${job.runId}:${pick.issue.id}`
                  });
                  if (result.queued) {
                    wakeOutcomes.push({ issueId: pick.issue.id, queued: true });
                  } else {
                    const message = "requestWakeup answered queued:false without an error";
                    wakeOutcomes.push({
                      issueId: pick.issue.id,
                      queued: false,
                      error: { code: wakeFailureCodeFor(message), message }
                    });
                    ctx.logger.error("dispatch sweep: wake not queued", {
                      companyId: company.id,
                      issueId: pick.issue.id,
                      code: wakeFailureCodeFor(message),
                      error: message
                    });
                  }
                } catch (cause) {
                  const message = cause instanceof Error ? cause.message : String(cause);
                  const code = wakeFailureCodeFor(message);
                  wakeOutcomes.push({ issueId: pick.issue.id, queued: false, error: { code, message } });
                  ctx.logger.error("dispatch sweep: wake failed", {
                    companyId: company.id,
                    issueId: pick.issue.id,
                    code,
                    error: message
                  });
                }
              }
            }
            if (budgetExhausted) {
              notes.push(
                `partial firing: job budget ${DISPATCH_SWEEP_JOB_BUDGET_MS}ms reached \u2014 gathered ${population.length} of ${nonTerminal.length} issues, resolved lanes for ${laneByIssueId.size} of ${population.length}, woke ${wakeOutcomes.filter((o) => o.queued).length} of ${selection.picks.length} picks`
              );
            }
            if (!dispatchConfig.wakeEnabled && selection.picks.length > 0) {
              notes.push(
                `report-only: would have woken ${selection.picks.map((p) => p.issue.identifier ?? p.issue.id).join(", ")}`
              );
            }
            const summary2 = summariseFiring(company.id, selection, wakeOutcomes);
            await emitMetrics(ctx, { companyId: company.id, summary: summary2, wakeEnabled: dispatchConfig.wakeEnabled });
            const previous = await ctx.state.get(dispatchLastFiringKey(company.id));
            if (hasStateChanged(previous, summary2)) {
              await logStateChange(ctx, { companyId: company.id, summary: summary2, wakeEnabled: dispatchConfig.wakeEnabled, notes });
              await ctx.state.set(dispatchLastFiringKey(company.id), summary2);
            }
            ctx.logger.info("dispatch sweep complete", {
              companyId: company.id,
              budgetExhausted,
              woken: summary2.counters.woken,
              candidatesReady: summary2.legacy.candidates_ready,
              runnableQueue: summary2.legacy.runnable_queue,
              routingGap: summary2.routingGapCount,
              assignedGathered: assigned.length,
              idleAssigneePicks: summary2.idleAssigneePickedIssueIds.length,
              laneDownSkips: summary2.laneDownSkippedIssueIds.length,
              wakeFailures: summary2.wakeFailures,
              wakeFailuresByReason: summary2.wakeFailuresByReason
            });
          } catch (cause) {
            ctx.logger.error("dispatch sweep failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause)
            });
          }
        }
      });
      const persistedCompanies = asRecord3(await ctx.state.get(knownCompaniesKey()));
      if (Array.isArray(persistedCompanies.ids)) {
        for (const id of persistedCompanies.ids) {
          if (typeof id === "string") knownCompanyIds.add(id);
        }
      }
      ctx.logger.info("Model Selection worker ready", { version: PLUGIN_VERSION });
    },
    async onHealth() {
      return { status: "ok", message: `Model Selection ${PLUGIN_VERSION}` };
    },
    /**
     * TOG-11793 (TOG-11780 §4.3). Answers the host's run-scoped model
     * decision from hot caches only. Declared on the definition so the fork's
     * SDK advertises `resolveRunModel`; a host without the hook never calls it.
     */
    async onResolveRunModel(params) {
      if (!runResolveHandler) {
        return { kind: "defer", retryAfterMs: 2e3, reason: "model-selection worker is not ready" };
      }
      return runResolveHandler(params);
    },
    /**
     * TOG-2438 reopen: the sole feed for `knownCompanyIds` (see the comment
     * above its declaration). The host calls this unconditionally for every
     * configured company at worker startup (`plugin-loader.ts` step 5b) and
     * again on every operator config save — so this set converges to exactly
     * "companies with stored config for this plugin" without ever calling
     * `ctx.companies.list()` ourselves. `context.companyId === null` is an
     * instance/global save, which this plugin's config schema doesn't use;
     * skip it rather than tracking a non-company id.
     *
     * Persisted immediately (not just held in memory) so a bare crash-restart
     * — which respawns the worker without replaying `configChanged` — can
     * still recover the set from state in `setup()` above, instead of silently
     * running every scheduled job over zero companies.
     */
    async onConfigChanged(_newConfig, changeContext) {
      const companyId = changeContext?.companyId;
      if (companyId) invalidateRunSnapshot?.(companyId);
      if (!companyId || knownCompanyIds.has(companyId)) return;
      knownCompanyIds.add(companyId);
      if (context) {
        await context.state.set(knownCompaniesKey(), { ids: [...knownCompanyIds] });
      }
    },
    async onValidateConfig(raw) {
      const { errors, warnings } = validateConfig(resolveConfig(raw));
      return { ok: errors.length === 0, errors, warnings };
    },
    async onApiRequest(input) {
      if (!context) return { status: 503, body: { error: "worker is not initialised" } };
      if (input.routeKey !== ROUTE_KEYS.advise && input.routeKey !== ROUTE_KEYS.applyIssue) {
        return { status: 404, body: { error: `unknown route ${input.routeKey}` } };
      }
      return { status: 501, body: { error: "use the registered tools; the HTTP surface is reserved" } };
    }
  });
}
var plugin = createPlugin();
var worker_default = plugin;
runWorker(plugin, import.meta.url);
export {
  createPlugin,
  worker_default as default
};
//# sourceMappingURL=worker.js.map
