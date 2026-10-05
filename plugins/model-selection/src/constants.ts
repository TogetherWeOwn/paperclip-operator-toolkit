export const PLUGIN_ID = "togetherweown.model-selection";
/** Literal 1, not "1": `PaperclipPluginManifestV1.apiVersion` is typed `1`. */
export const PLUGIN_API_VERSION = 1 as const;
export const PLUGIN_VERSION = "0.4.0";

export const TOOL_NAMES = {
  /** Advise a tier + model for one issue. Read-only, always safe to call. */
  advise: "model_selection_advise",
  /** Advise and, if enforcement is on for this company, write the override. */
  apply: "model_selection_apply",
  /** Record a time-boxed operator override: route this issue to a named model regardless of pace. */
  setOperatorOverride: "model_selection_set_operator_override",
  /**
   * , Defect 3. Report where an agent's ancillary model pins
   * (ANTHROPIC_SMALL_FAST_MODEL, CLAUDE_CODE_SUBAGENT_MODEL, every
   * ANTHROPIC_DEFAULT_* env var) disagree with the lane-aware T3
   * recommendation. Read-only, always advisory: there is no write path from
   * this plugin to any of these surfaces (`ctx.agents` has no update method,
   * and `ctx.http.fetch` is SSRF-blocked from the host's own internal API),
   * so this can never be anything but a report.
   *
   * `runtimeConfig.modelProfiles.cheap` was a fifth surface here
   * until Paperclip migration 0236 (v2026.916.0) deleted it with no
   * replacement; removed rather than kept as a frozen snapshot.
   */
  ancillaryDrift: "model_selection_ancillary_drift",
  /** Per-model aa.ai configured vs. live index and tier-boundary drift. Read-only. */
  aaDriftReport: "model_selection_aa_drift_report",
  /** Manually run the aa.ai fetch + drift-surfacing sweep outside the cron cadence. */
  refreshAaIndexNow: "model_selection_refresh_aa_index_now",
  /** the last models.dev price reconciliation, as an operator-approvable diff. Read-only. */
  priceDriftReport: "model_selection_price_drift_report",
  /** run the models.dev fetch + price reconciliation now instead of waiting for the daily tick. Still report-only. */
  reconcilePricesNow: "model_selection_reconcile_prices_now",
  /** P2: the last free-list sync diff (verified/broken/ambiguous/unbound), as an operator-reviewable report. Read-only. */
  aaFreeSyncReport: "model_selection_aa_free_sync_report",
  /** P2: run the free-list fetch + diff immediately instead of waiting for the daily tick. Still report-only. */
  refreshAaFreeSyncNow: "model_selection_refresh_aa_free_sync_now",
  /** the first-party accepted-work posterior overlay, as an operator-reviewable report. Read-only. */
  acceptedWorkReport: "model_selection_accepted_work_report",
  /**
   * Per-tier lane-poll outcome counters. Read-only: the
   * `pollLaneCapacity` job increments, this tool reads back.
   */
  tierOutcomes: "model_selection_tier_outcomes",
  /** Read the last explicitly enabled account shadow snapshot; never actuates. */
  admissionShadowReport: "model_selection_admission_shadow_report",
  /** port of `lane_outage.json`: declare or clear a telemetry-invisible lane outage. */
  setLaneOutage: "model_selection_set_lane_outage",
  /** port of `zai_pace_override()` / `zai_pace_override.json`. */
  setZaiPaceOverride: "model_selection_set_zai_pace_override",
  /**
   * Add, edit, remove, validate or diff
   * tier-policy tiers. Prepare/validate/diff only: returns `proposalOnly` or
   * `rejected`, never writes state or config, never changes routing.
   */
  tierPolicy: "model_selection_tier_policy",
} as const;

/**
 * Default lane-id strings for the three named lanes `tier_dispatcher.py`
 * hardcodes (`lane_of()`), canonicalized to this deployment's actual live
 * `pacing.lanes[].laneId` vocabulary (`cliproxy-codex`/`cliproxy-opencode-go`/
 * `cliproxy-zai` — the Python source's bare `codex`/`opencode-go`/`zai` were
 * never the live lane ids here). Configurable via `SelectionConfig.codexLaneId`
 * / `opencodeGoLaneId` / `pacing.zai.laneId` — these are only the fallback
 * when a company config doesn't override them, so a company still free to
 * name its lanes however it likes without losing these dated rules.
 */
export const LANE_ID_CODEX = "cliproxy-codex";
export const LANE_ID_OPENCODE_GO = "cliproxy-opencode-go";
export const LANE_ID_ZAI = "cliproxy-zai";

export const DEFAULT_PACE_ACCOUNT_KEY_FIELDS = ["account_key", "accountKey", "name", "id"] as const;
export const DEFAULT_PACE_WEIGHT_FIELDS = ["plan_weight", "weight"] as const;

/**
 * 2026-09-06 17:1xZ / 2026-09-07 12:32Z owner rule: per-account active-card
 * ceiling, ported verbatim from `tier_dispatcher.py`'s
 * `LANE_CAP_PER_ACCOUNT={"opencode-go":2,"zai":3}`, keyed on the canonical
 * live lane ids.
 */
export const DEFAULT_LANE_CAP_PER_ACCOUNT: Readonly<Record<string, number>> = {
  [LANE_ID_OPENCODE_GO]: 2,
  [LANE_ID_ZAI]: 3,
};

/**
 * 2026-09-07 07:12Z owner rule, ported from `tier_dispatcher.py`'s
 * `AVOID_LANE = {"codex": 0.99}`: the live company config sets no
 * `pacing.avoid.perLane` override at all, so this is the only place codex's
 * higher-than-default avoid threshold takes effect. Keyed on the canonical
 * live lane id.
 */
export const DEFAULT_AVOID_PER_LANE: Readonly<Record<string, number>> = {
  [LANE_ID_CODEX]: 0.99,
};

/** `tier_dispatcher.py`'s `lane_5h()` reads this fixed JSON key; kept as the default window name, canonicalized to the live `five-hour` (hyphenated) window name. */
export const DEFAULT_FIVE_HOUR_WINDOW_NAME = "five-hour";
/**
 * The lane-wide weekly allowance window, reported alongside `five-hour` in the
 * shadow stream's per-lane snapshot. Distinct from `zai.weeklyWindowName`,
 * which names the window the Z.ai-specific pace gate reads: that one is a
 * gating input for one lane, this one is the reporting name for every lane.
 * They share a default because the live lane documents use `weekly` throughout.
 */
export const DEFAULT_WEEKLY_WINDOW_NAME = "weekly";
/** `tier_dispatcher.py`'s `zai_weekly_pace_ok()` reads `weekly_utilization`/`weekly_resets_at`. */
export const DEFAULT_ZAI_WEEKLY_WINDOW_NAME = "weekly";
/** `tier_dispatcher.py`'s `zai_weekly_pace_ok(margin=0.15)` default. */
export const DEFAULT_ZAI_WEEKLY_MARGIN = 0.15;

// Route keys are validated against a lowercase-only regex by
// `pluginManifestV1Schema` — camelCase is rejected at install time.
export const ROUTE_KEYS = {
  advise: "advise",
  applyIssue: "apply-issue",
} as const;

export const JOB_KEYS = {
  /** Recompute per-tier volume profiles from this company's own runs. */
  refreshProfiles: "refreshVolumeProfiles",
  /** Poll configured lane-capacity sources and refresh the lane ledger. */
  pollLanes: "pollLaneCapacity",
  /** Recompute per-model, per-tier Bayesian success scores and the card ledger. */
  refreshScores: "refreshScores",
  /** Refresh the aa.ai Intelligence Index snapshot and surface tier-boundary drift. */
  refreshAaIndex: "refreshAaIndex",
  /** reconcile roster prices against models.dev and report drift (never auto-applies). */
  reconcilePrices: "reconcilePrices",
  /** P2: fetch the free AA legacy list (quota-gated) and store the CAS snapshot + per-company reviewable diff. Never writes pins/tiers/enabled. */
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
   * absorption of the standalone `dispatch` plugin:
   * stall-sweep + wakeup, ported wholesale so the `plugins` table shows one
   * dispatcher, not two.
   */
  dispatchSweep: "dispatch-sweep",
  /** warm the run-scoped decision's hot snapshot once a minute. */
  refreshRunResolve: "refreshRunResolveSnapshot",
} as const;

/**
 * Label names are the durable tier record (ADR-0008). The name encodes work
 * kind, never a model id — `tier:T1` stays `tier:T1` when the model behind T1
 * changes.
 */
export const TIER_LABEL_PREFIX = "tier:";
export const TIERS = ["T1", "T2", "T3"] as const;
export type Tier = (typeof TIERS)[number];

/** T3 mechanical ... T1 most capable. Index order is load-bearing. */
export const TIER_ORDER: readonly Tier[] = ["T3", "T2", "T1"];

/**
 * An operator-set label meaning "leave the model choice on this issue alone."
 * Pace-driven repins and hysteretic repins must not touch a `pin:operator`
 * issue, with one exception: a serviceability hard stop (the pinned model's
 * lane is exhausted/unavailable) still forces a move, because staying pinned
 * to a dead lane is not "leaving it alone", it is silently failing the issue.
 */
export const OPERATOR_PIN_LABEL = "pin:operator";

export const PLUGIN_STATE_KEYS = {
  volumeProfiles: "volumeProfiles",
  /** Per-company lane pace verdicts and slot-throttle counters. */
  laneLedger: "laneLedger",
  /**
   * Per-company published quota-contract document, the input to the 
   * availability term. Written by the collector; until that runs,
   * every lane reads UNKNOWN — recorded and traced, and under the default
   * policy not blocking.
   */
  laneAvailability: "laneAvailability",
  /** Per-issue operator overrides, each with an expiry. */
  operatorOverrides: "operatorOverrides",
  /** Per-issue timestamp of the last pace-driven repin, for the idle-repin hysteresis. */
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
   * , Defect 2. Per-issue timestamp of the last raised `tier-exhausted`
   * operator alarm, so a decision that stays exhausted across repeated
   * `advise`/`apply` calls does not spam a fresh card every time — one open
   * card per continuous exhaustion streak. Cleared the first time the same
   * issue's outcome is no longer `tier-exhausted`, so the NEXT exhaustion
   * raises a fresh card rather than staying silent forever.
   */
  tierExhaustedAlarms: "tierExhaustedAlarms",
  /**
   * Instance-scoped (aa.ai data is not company-specific): the last-fetched
   * aa.ai snapshot `{fetchedAt, bySlug, lastAttemptAt, lastError}`.
   * `bySlug` maps every aa.ai slug (one per model x effort-level) to its full
   * `AaModelRecord` — not just the intelligence
   * index.
   */
  aaIndexSnapshot: "aaIndexSnapshot",
  /**
   * Instance-scoped: a bounded rolling history of past fetches, `{entries:
   * Array<{fetchedAt, bySlug}>}`, newest last, capped at
   * `AA_SNAPSHOT_HISTORY_LIMIT` entries. Separate key from
   * `aaIndexSnapshot` so a plain drift read never has to load the whole
   * history.
   */
  aaSnapshotHistory: "aaSnapshotHistory",
  /**
   * Instance-scoped: `{ids: string[]}`, the set of companies this worker has
   * ever seen a stored config for, persisted so a bare crash-restart (which
   * replays no `configChanged` calls, unlike a full plugin reload) doesn't
   * reset scheduled jobs to iterating zero companies.
   */
  knownCompanies: "knownCompanies",
  /** Per-company: which `(modelId, freshImpliedTier)` drift pairs have already been surfaced. */
  aaDriftSurfaced: "aaDriftSurfaced",
  /**
   * , per-company: the most recent models.dev price reconciliation
   * report (`{report, ranAt, error}`), so `priceDriftReport` can answer
   * without re-fetching a 4.8 MB catalogue on every read. The report is the
   * artifact — this job writes no price anywhere.
   */
  priceReconcileReport: "priceReconcileReport",
  /**
   * , per-company: which `(modelId, field, feedPrice)` drift findings
   * have already been surfaced to the activity log, so a misprice nobody has
   * applied yet does not re-alarm on every daily tick. Same dedup shape and
   * rationale as `aaDriftSurfaced`; keyed on the FEED price so a second,
   * different price change on the same row does surface again.
   */
  priceDriftSurfaced: "priceDriftSurfaced",
  /**
   * P2, instance-scoped (the free list is not company-specific):
   * the last-good free-list snapshot `{fetchedAt, digest, snapshot,
   * lastAttemptAt, lastError, nextEligibleAt}`. A failed fetch keeps the
   * last good snapshot in place and records the attempt; the snapshot is
   * dated, so a stale one is legible as stale. `nextEligibleAt` is the D1
   * quota gate (at most one scheduled fetch/day, 429 honors Retry-After).
   */
  aaFreeSyncSnapshot: "aaFreeSyncSnapshot",
  /**
   * P2, per-company: the most recent free-list sync diff
   * (`{ranAt, digest, error, diff}`), so `aaFreeSyncReport` can answer
   * without re-fetching. The diff is the artifact — this job writes no
   * binding anywhere.
   */
  aaFreeSyncDiff: "aaFreeSyncDiff",
  /**
   * , per-company: the first-party accepted-work posterior overlay
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
   * classify job, for a later apply-sweep to supply as
   * `descriptor.exclusion` and force the T1 model-pick bucket.
   */
  classificationExclusions: "classificationExclusions",
  /**
   * Per-issue provenance for the `tier:*` label: `{issueId: "T2"}`
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
   * port of `lane_outage.json` — an operator-declared outage the
   * telemetry cannot see. Runtime-settable (mirroring `operatorOverrides`),
   * not deploy-time config: the Python source is a hand-edited file read
   * fresh on every dispatcher run, and an outage is exactly the kind of
   * thing that needs to be set/cleared without a plugin config redeploy.
   */
  laneOutage: "laneOutage",
  /**
   * port of `zai_pace_override.json` — an operator-declared
   * temporary margin override for `zaiWeeklyPaceOk`, e.g. during a Codex
   * outage. Runtime-settable, same rationale as `laneOutage`.
   */
  zaiPaceOverride: "zaiPaceOverride",
  /** Keyset cursor for the bounded balance-pass page, persisted per company. */
  balancePassCursor: "balancePassCursor",
  /**
   * per-pass high-water marks (`{at: ISOString}`) for the
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
   * port of the `dispatch` plugin's `stateKey()` — the last-firing
   * summary a sweep compares against to gate the activity-log line to state
   * changes only. Namespaced separately from the rest of this plugin's state
   * (`namespace: "dispatch"`, matching the original plugin's key exactly) so
   * absorbing it does not collide with `laneLedger`/etc.
   */
  dispatchLastFiring: "dispatchLastFiring",
  /**
   * AC3. Per-issue timestamp of the last "cannot pin — no eligible
   * model on any serviceable lane" activity notice, so a card that stays
   * unpinnable across repeated pass firings surfaces once per throttle window
   * instead of on every 10-minute tick. Same shape/rationale as
   * `tierExhaustedAlarms`, scoped to the per-card notice rather than the
   * operator alarm card.
   */
  noEligibleNotices: "noEligibleNotices",
  /**
   * Per-issue pin timestamps (`{issueId: ISOString}`), the pin
   * lifecycle's only clock. Written on every pin and clear, read by the
   * repin pass: a pin older than PIN_MAX_AGE_MS is re-validated through
   * `advise` even when the pinned lane still reads usable. Missing entry =
   * expired (fail-safe toward re-validation, never toward keeping).
   */
  pinPinnedAt: "pinPinnedAt",
  /**
   * , per-company: per-tier lane-poll outcome counters
   * (`{tiers: {T1: {polls, succeeded, failed, lastAt}, ...}, updatedAt}`).
   * Written by the `pollLaneCapacity` job, read by the read-only
   * `model_selection_tier_outcomes` tool. Read-only telemetry: selection
   * never reads this key, so the counters cannot change routing.
   */
  tierPollOutcomes: "tierPollOutcomes",
  /**
   * , per-company: index of issues whose pin carries a fallback
   * provenance stamp (`{issueId: {decisionId, decidedAt, checkedAt}}`).
   * Written next to every pin write and clear; read by the fallback lease
   * pass, which examines only these issues. The stamp on the issue is the
   * authority: an entry whose `decisionId` no longer matches is dropped.
   */
  fallbackPins: "fallbackPins",
} as const;

/**
 * AC3. Minimum gap between repeated per-card "cannot pin" notices
 * for the same issue. One hour: long enough that a sustained outage is still
 * visible on the card's activity feed, short enough that a pass every 10
 * minutes cannot flood it.
 */
export const NO_ELIGIBLE_NOTICE_THROTTLE_MS = 60 * 60 * 1000;

/** aa.ai's public leaderboard page — the only viable data source (no documented API exists). */
export const AA_LEADERBOARD_URL = "https://artificialanalysis.ai/leaderboards/models";
/** Full-page HTML fetch, not a small JSON blob — generous but bounded. */
export const AA_FETCH_TIMEOUT_MS = 10_000;
export const AA_MAX_RESPONSE_BYTES = 8_000_000;
/** How many past full-detail fetches `aaSnapshotHistory` retains. At the 6h cadence this is 7 days. */
export const AA_SNAPSHOT_HISTORY_LIMIT = 28;

/**
 * models.dev's public catalogue — the reference the 2026-09-22
 * manual audit used to find 26 mispriced rows out of 117.
 *
 * These are LIST prices. Where this company is on a flat subscription (Meta
 * Muse Power at $50/mo, Codex Pro, Claude Max) the marginal cost of a token
 * is not the list price and is usually far below it. List prices are still
 * the right input here because ADR-0001's cost term is a comparator: it needs
 * the correct RELATIVE ordering between candidates, which list prices give and
 * a flat subscription does not. Nothing derived from this feed may be
 * presented as what the company actually pays — that is the cost-ledger's
 * question, sourced from `cost_events`.
 */
export const MODELS_DEV_CATALOG_URL = "https://models.dev/api.json";
/**
 * Cloudflare fronts models.dev and 403s default library agents at the edge
 * (`Python-urllib` is the one the manual audit tripped over). A real
 * `User-Agent` is a correctness requirement, not politeness — and naming
 * ourselves is what lets models.dev's operators identify our traffic.
 */
export const MODELS_DEV_USER_AGENT =
  "TogetherWeOwn-model-selection/1.0 (+https://github.com/TogetherWeOwn/paperclip-ops-tooling)";
/** The catalogue measured 4.8 MB on 2026-09-22; this leaves room to roughly triple. */
export const MODELS_DEV_MAX_RESPONSE_BYTES = 16_000_000;
export const MODELS_DEV_FETCH_TIMEOUT_MS = 20_000;

/**
 * P2 (D1 quota). The free legacy list is fetched at most once a
 * day on the schedule, plus bounded transient retries. 429 honors
 * `Retry-After`; 401/403 stops the source for the day (no substitution).
 * Never conflate with the new `/language/models/free` 100/24h budget.
 */
export const AA_FREE_FETCH_TIMEOUT_MS = 10_000;
/** The legacy list measured ~688 rows; this leaves wide headroom without inviting abuse. */
export const AA_FREE_MAX_RESPONSE_BYTES = 8_000_000;
export const AA_FREE_FETCH_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const AA_FREE_RETRY_INTERVAL_MS = 60 * 60 * 1000;

export const PACING_MODES = ["off", "shadow", "enforce"] as const;
export type PacingMode = (typeof PACING_MODES)[number];

export const LOCAL_FOLDER_KEYS = {
  /**
   * Append-only `paired-decision-v1` JSONL records, one per
   * `advise()` call, for the 48h host/plugin-shadow agreement stream
   * `ops//gate_harness.py` correlates against. Plugin-owned path —
   * never `ops//`, which is 's own directory.
   *
   * Lowercase-and-hyphen only: `pluginManifestV1Schema` rejects a `folderKey`
   * that doesn't match `^[a-z0-9][a-z0-9._:-]*$` (no camelCase).
   */
  shadowDecisions: "shadow-decisions",
} as const;

/**
 * Cap on how many `rejections` entries a decision record's
 * `explanations` carries.  measured up to 112 rejected candidates in
 * one decision on today's roster; this leaves headroom while still keeping
 * the record bounded as the roster grows, rather than letting it scale
 * unbounded with roster size. A decision with more rejections than this
 * reports the excess in `explanationsTruncated` instead of silently
 * dropping them.
 */
export const SHADOW_EXPLANATIONS_CAP = 200;

/**
 * Shadow-decision records are single JSONL lines, and the
 * `writeTextAtomic` payload is itself one newline-delimited JSON-RPC line on
 * the worker's stdout. A live-shape record measured ~16 KB, but a roster or
 * lane-account blowup can push one line past the host's per-line cap, which
 * the host answers by dropping the line ("dropping oversized worker line").
 * `pickWhy` (the joined `select.ts` trace) is the one unbounded free-text
 * field, so it is clamped to this many characters with a `...[truncated N
 * chars]` marker rather than silently cut. Structured fields (candidates,
 * explanations, lane snapshot) are never truncated — a truncated list would
 * read as a complete measurement.
 */
export const SHADOW_PICK_WHY_MAX_CHARS = 8000;

/** Ahead-of-line throttling never drives a lane's slot share below this. */
export const DEFAULT_SLOT_FLOOR_FRACTION = 0.25;

/** Default TTL for an operator override recorded in the lane ledger. */
export const DEFAULT_OPERATOR_OVERRIDE_TTL_SECONDS = 60 * 60;

/** A repin below the agent floor's normal churn must wait at least this long, and only while the issue is idle. */
export const DEFAULT_IDLE_REPIN_HYSTERESIS_SECONDS = 5 * 60;

/** Required smoothed success probability to be "capable" for a tier (model_scores.py THRESH). */
export const SCORE_THRESHOLDS: Record<Tier, number> = { T1: 0.85, T2: 0.8, T3: 0.75 };
/** Bayesian prior weight — pseudo-observations contributed by `priorP`. */
export const SCORE_PRIOR_K = 6;
/** Minimum weighted-outcome count before a (model, tier) verdict is "proven". */
export const SCORE_PROVEN_N = 8;
/** Acceptance observation window; the reporting metric may record rejections earlier. */
export const CARD_CENSOR_DAYS = 14;
/**
 * Eight MATURE cards, not eight early rejections, before a hard
 * zero-accept exclusion. This matches SCORE_PROVEN_N. Under independent
 * outcomes with p(accept)=0.60, eight rejects have probability 0.4^8=6.6e-4;
 * correlated fleet failures invalidate that illustration, so N alone is not
 * a safety argument. A symmetric observation window and expiry are required.
 */
export const CARD_ZERO_ACCEPT_MIN_RESOLVED = 8;
/**
 * Mature cards can support exclusion for only seven days after their 14-day
 * observation window. Rolling refreshes never extend a card's lifetime. With
 * no new closures, ordinary eligibility returns within 21 days of the last
 * closure, even if the cached ledger never refreshes. Other safety gates still
 * apply; this is re-entry eligibility, not a forced probe or a hand-pin.
 */
export const CARD_ZERO_ACCEPT_WINDOW_DAYS = 7;
/** `refreshScores` reads this many days of `heartbeat_runs` (model_scores.py WINDOW default). */
export const SCORE_WINDOW_DAYS = 14;
/** `refreshScores` reads this many days of closed `issues` for the card-level acceptance ledger. */
export const CARD_LEDGER_WINDOW_DAYS = 60;
/** A reopen within this many hours of the closing run counts as rework (model_scores.py:107). */
export const REOPEN_WINDOW_MS = 72 * 60 * 60 * 1000;
/** A rejection comment within this many hours of the closing run counts as rework (model_scores.py:123). */
export const REJECTION_WINDOW_MS = 48 * 60 * 60 * 1000;
/** Rework weights (model_scores.py:130): a reopen is worse evidence than a review rejection. */
export const REWORK_WEIGHT_REOPEN = 1.0;
export const REWORK_WEIGHT_REJECTED = 0.5;

/**
 * 2026-09-06 14:2xZ owner rule ("always use the cheapest capable model for
 * each task"), ported from `tier_dispatcher.py` `pick()`. 10% of T2/T3 picks
 * go to the cheapest not-yet-proven capable candidate so real work can
 * confirm or demote it. Never T1 — an unproven candidate never earns judgement
 * work.
 */
export const EXPLORE_FRACTION = 0.1;
/**
 * 2026-09-06 16:2xZ owner rule: a free/stealth candidate (blended list price
 * under this, $/Mtok) must be PROVEN before it enters the main pick pool —
 * ported from `tier_dispatcher.py` `pick()`'s `main` filter
 * (`caps[m["id"]][1] or blended(m)>=0.10`).
 */
export const FREE_MUST_BE_PROVEN_USD = 0.1;
/**
 * 2026-09-05 spread rule: within this multiple of the cheapest candidate's
 * cost, prefer the least-utilized lane over the raw cost order — ported from
 * `tier_dispatcher.py` `pick()`'s `blended(m)<=cheapest*1.20` band.
 */
export const COST_BAND_MULTIPLIER = 1.2;

/**
 * How many candidate rows `classifyIssues` FETCHES per
 * `classification.batchSize` it intends to classify.
 *
 * The fetch and the write cap used to be the same number, which is a
 * starvation bug the moment any candidate is skipped after the row query: the
 * query cannot see labels, so `pin:operator` cards, and (now) cards this job
 * has already classified, are filtered per-row afterwards. With `limit =
 * batchSize` the same top-N rows come back every run, get skipped every run,
 * and row N+1 is never reached. Over-fetching and stopping at `batchSize`
 * ACTUAL classifications lets the backlog drain.
 */
export const CLASSIFY_FETCH_MULTIPLIER = 10;
/** Hard ceiling on that over-fetch, so a large `batchSize` cannot page the whole board. */
export const CLASSIFY_FETCH_LIMIT_MAX = 400;
/**
 * Stop starting new classifications with 100 s left before the host's 300 s
 * job RPC wall. Was a 4-minute cooperative budget — but this
 * pass hit 288 s max over the last 4 h, right at the wall: its rows
 * (`ctx.issues.get` plus the classifier HTTP call) pay the same contended
 * host-RPC cost as every other row-walking pass. 200 s caps the job at
 * two-thirds of the wall, leaving a full 100 s — more than the slowest
 * observed row — for the in-flight row when the host fires.
 */
export const CLASSIFY_JOB_BUDGET_MS = 200 * 1000;
/**
 * per-row admission headroom for the classify pass. The classifier
 * HTTP call defaults to 15 s (`resolve.ts`) but the row also pays a
 * `ctx.issues.get` read, and rows cost 40-95 s each in contended host RPC
 * across the row-walking passes — no new row starts unless this much job
 * budget remains. Paired with the adaptive admission in worker.ts, which
 * raises the bar to 1.5x the slowest row seen this firing.
 */
export const CLASSIFY_ROW_TIMEOUT_MS = 30 * 1000;

/** `tier_dispatcher.py` `label_only_pass()`'s fixed `limit 100` row fetch. No separate write cap in the source. */
export const LABEL_ONLY_PASS_FETCH_LIMIT = 100;
/**
 * Stop starting new label-only pins with 100 s left before the host's 300 s
 * RPC wall. Was a 4-minute cooperative budget with the host's
 * full minute of headroom — but the observed row costs (40-95 s each in
 * describeIssue + advise host RPC) mean an admitted row can still spend ~95 s
 * past admission and blow the wall: the timeout postmortem shows failures at
 * ~300 s alongside successes at 259-295 s, i.e. no margin at all. 200 s caps
 * the job at two-thirds of the wall, leaving a full 100 s — more than the
 * slowest observed row — for the in-flight row's abandoned promise to settle
 * without the host firing first.
 */
export const LABEL_ONLY_PASS_JOB_BUDGET_MS = 200 * 1000;
/**
 * (2026-09-28 reopen): per-row admission headroom for the label-only
 * pass. The 4-minute job budget above is only checked BETWEEN rows, so a row
 * admitted with 1 ms of budget left can still spend ~98 s in host calls
 * and blow the host's 300 s wall. No new row
 * starts unless this much job budget remains — admission stops at ~210 s
 * elapsed, leaving the rest of the job budget plus the full minute of host
 * headroom. A row that goes slow anyway trips the write gate in worker.ts
 * (no routing mutation after the budget) instead of an orphaned write.
 */
export const LABEL_ONLY_PASS_ROW_TIMEOUT_MS = 30 * 1000;
/**
 * per-firing row cap for the label-only pass. The candidate fetch
 * pulls 100 rows, and rows cost 40-95 s each in host RPC — without a cap the
 * pass can never drain inside any sub-wall budget, so the same backlog rows
 * are re-fetched (and re-timed-out on) every firing. Eight rows bound the
 * worst case below the 200 s budget even at the slowest observed row cost;
 * the watermark is the cursor (uncapped excess rows stay newer than the
 * creep mark and are reached on later firings).
 */
export const LABEL_ONLY_PASS_MAX_ROWS_PER_FIRING = 8;
/** `tier_dispatcher.py` `repin_pass()`'s fixed `limit 400` row fetch. */
export const REPIN_PASS_FETCH_LIMIT = 400;
/** `tier_dispatcher.py` `repin_pass(limit=6)`'s default write cap per run. */
export const REPIN_PASS_WRITE_LIMIT = 6;
/**
 * Stop starting new repin work with 100 s left before the host's 300 s job
 * RPC wall. This pass had NO job budget at all — it walked up
 * to 400 fetched rows bounded only by the 6-write cap, and failed 2/24
 * firings at 301 s over the last 4 h. 200 s caps the job at two-thirds of
 * the wall, leaving more than the slowest observed row of headroom.
 */
export const REPIN_PASS_JOB_BUDGET_MS = 200 * 1000;
/**
 * per-row admission headroom for the repin pass — same
 * slow-admitted-row defect as the label-only and balance passes (a row
 * admitted with budget left spends 40-95 s in describeIssue + advise host
 * RPC and crosses the wall). No new row starts unless this much job budget
 * remains; paired with the adaptive admission in worker.ts, which raises
 * the bar to 1.5x the slowest row seen this firing.
 */
export const REPIN_PASS_ROW_TIMEOUT_MS = 30 * 1000;
/**
 * A pin older than this is re-validated through `advise` on the
 * next repin pass even when the pinned lane still reads usable. 24h: the
 * 2026-09-27 census found 73/92 live pins stale by `updated_at`, and the
 * pass fires every 10 minutes, so anything much shorter would re-validate
 * the whole board every firing while anything much longer leaves a dead
 * pin parked for days.
 */
export const PIN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * The fallback
 * lease pass examines at most this many indexed issues per firing, least
 * recently checked first, so a large index rotates through over several
 * firings instead of stretching one past the host's 300 s job wall.
 */
export const FALLBACK_LEASE_EXAMINE_LIMIT = 20;
/** Re-pins per lease-pass firing; same cap as the repin pass. */
export const FALLBACK_LEASE_WRITE_LIMIT = 6;
/**
 * Hard ceiling on the fallback-pin index. Past it the oldest
 * decisions are evicted; an evicted pin is still re-validated by the 24 h
 * pin expiry, only later.
 */
export const FALLBACK_PIN_INDEX_MAX = 500;
/** Bounded keyset page size: 400 rows caused the host's 300 s job RPC wall to fire before completion. */
export const BALANCE_PASS_FETCH_LIMIT = 50;
/**
 * Stop starting new balance work with 100 s left before the host's 300 s
 * RPC wall. Same evidence as the label-only pass: this pass also
 * failed at 300004 ms on 2026-09-28 11:00Z, and its rows pay the same
 * describeIssue + advise host-RPC cost. 200 s leaves more than the slowest
 * observed row of headroom for the in-flight row when the host fires.
 */
export const BALANCE_PASS_JOB_BUDGET_MS = 200 * 1000;
/**
 * (2026-09-28 reopen): per-row admission headroom for the balance
 * pass — same slow-admitted-row defect as the label-only pass (balance also
 * failed at 300004 ms on 2026-09-28 11:00Z). Same semantics: no new row
 * starts unless this much job budget remains; a slow row trips the write
 * gate (no routing mutation after the budget, keyset cursor held) instead of
 * an orphaned write past the host wall.
 */
export const BALANCE_PASS_ROW_TIMEOUT_MS = 30 * 1000;
/** `tier_dispatcher.py` `balance_pass(limit=8)`'s default write cap per run. */
export const BALANCE_PASS_WRITE_LIMIT = 8;
/** `balance_pass()`'s `cheaper = blended(nm) <= 0.8*blended(pm)` cost-down threshold. */
export const BALANCE_PASS_COST_DOWN_MULTIPLIER = 0.8;
/** `balance_pass()`'s `busier = (cur_u-new_u)>=0.25` rebalance threshold. */
export const BALANCE_PASS_BUSIER_UTILIZATION_DELTA = 0.25;
/** `balance_pass()`'s `probation` branch: a pinned model priced under this (blended $/Mtok) and still unproven may hold only one active card. */
export const BALANCE_PASS_PROBATION_PRICE_USD = 0.1;

/**
 * port of the `dispatch` plugin's `ISSUE_PAGE_LIMIT` — the sweep's
 * single-page `ctx.issues.list` fetch cap. A company with more open issues
 * than this per firing is a saturation condition the sweep notes rather than
 * paginating through, matching the standalone plugin's own behavior exactly.
 */
export const DISPATCH_ISSUE_PAGE_LIMIT = 1000;

/**
 * stop starting new dispatch-sweep work with a full minute left
 * before the host's 300 s job RPC wall. The sweep had no job time budget and
 * hit the wall three firings running on 2026-09-28; classify and balance both
 * already carry this 4-minute cooperative deadline.
 */
export const DISPATCH_SWEEP_JOB_BUDGET_MS = 4 * 60 * 1000;

/**
 * lookback for the lane-evidence aggregate over `heartbeat_runs`.
 *
 * 24h is the window the 2026-09-17 measurement was taken over, and the
 * shortest one that made `devin/*` conclusive (0/74). Much shorter and a lane
 * taking only a few cards an hour never leaves `unproven`; much longer and a
 * lane fixed an hour ago stays excluded by yesterday's failures.
 */
export const LANE_EVIDENCE_WINDOW_HOURS = 24;

/**
 * How long a lane-evidence aggregate is reused before the query is re-run.
 *
 * Per-sweep de-duplication, not a cache of the verdict: `balance_pass` walks
 * every open card and would otherwise re-run the same company-wide aggregate
 * once per issue.
 */
export const LANE_EVIDENCE_TTL_MS = 60_000;
