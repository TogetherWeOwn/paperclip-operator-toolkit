export const PLUGIN_ID = "togetherweown.model-selection";
/** Literal 1, not "1": `PaperclipPluginManifestV1.apiVersion` is typed `1`. */
export const PLUGIN_API_VERSION = 1 as const;
export const PLUGIN_VERSION = "0.3.0";

export const TOOL_NAMES = {
  /** Advise a tier + model for one issue. Read-only, always safe to call. */
  advise: "model_selection_advise",
  /** Advise and, if enforcement is on for this company, write the override. */
  apply: "model_selection_apply",
  /** Record a time-boxed operator override: route this issue to a named model regardless of pace. */
  setOperatorOverride: "model_selection_set_operator_override",
  /**
   * TOG-2137, Defect 3. Report where an agent's ancillary model pins
   * (ANTHROPIC_SMALL_FAST_MODEL, CLAUDE_CODE_SUBAGENT_MODEL, every
   * ANTHROPIC_DEFAULT_* env var, runtimeConfig.modelProfiles.cheap) disagree
   * with the lane-aware T3 recommendation. Read-only, always advisory: there
   * is no write path from this plugin to any of these surfaces (`ctx.agents`
   * has no update method, and `ctx.http.fetch` is SSRF-blocked from the
   * host's own internal API), so this can never be anything but a report.
   */
  ancillaryDrift: "model_selection_ancillary_drift",
  /** Per-model aa.ai configured vs. live index and tier-boundary drift. Read-only (TOG-2438). */
  aaDriftReport: "model_selection_aa_drift_report",
  /** Manually run the aa.ai fetch + drift-surfacing sweep outside the cron cadence (TOG-2438 reopen AC4). */
  refreshAaIndexNow: "model_selection_refresh_aa_index_now",
  /** TOG-2481 port of `lane_outage.json`: declare or clear a telemetry-invisible lane outage. */
  setLaneOutage: "model_selection_set_lane_outage",
  /** TOG-2481 port of `zai_pace_override()` / `zai_pace_override.json`. */
  setZaiPaceOverride: "model_selection_set_zai_pace_override",
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
  /** Refresh the aa.ai Intelligence Index snapshot and surface tier-boundary drift (TOG-2438). */
  refreshAaIndex: "refreshAaIndex",
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
   * Per-issue capability-exclusion flag recorded by `classifyIssues`
   * (ported from `tier_dispatcher.py` `main()`'s `excl` local). The tier:*
   * LABEL always records the confidence-demoted tier regardless of
   * exclusion; this flag is the only place exclusion survives past the
   * classify job, for a later apply-sweep (TOG-2481 task #6/#7) to supply as
   * `descriptor.exclusion` and force the T1 model-pick bucket.
   */
  classificationExclusions: "classificationExclusions",
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
  /**
   * TOG-2481 port of the `dispatch` plugin's `stateKey()` — the last-firing
   * summary a sweep compares against to gate the activity-log line to state
   * changes only. Namespaced separately from the rest of this plugin's state
   * (`namespace: "dispatch"`, matching the original plugin's key exactly) so
   * absorbing it does not collide with `laneLedger`/etc.
   */
  dispatchLastFiring: "dispatchLastFiring",
} as const;

/** aa.ai's public leaderboard page — the only viable data source (no documented API exists). */
export const AA_LEADERBOARD_URL = "https://artificialanalysis.ai/leaderboards/models";
/** Full-page HTML fetch, not a small JSON blob — generous but bounded. */
export const AA_FETCH_TIMEOUT_MS = 10_000;
export const AA_MAX_RESPONSE_BYTES = 8_000_000;
/** How many past full-detail fetches `aaSnapshotHistory` retains (TOG-2438 scope expansion). At the 6h cadence this is 7 days. */
export const AA_SNAPSHOT_HISTORY_LIMIT = 28;

export const PACING_MODES = ["off", "shadow", "enforce"] as const;
export type PacingMode = (typeof PACING_MODES)[number];

export const LOCAL_FOLDER_KEYS = {
  /**
   * TOG-2137. Append-only `tog2138-decision-v1` JSONL records, one per
   * `advise()` call, for the 48h host/plugin-shadow agreement stream
   * `ops/tog-2138/gate_harness.py` correlates against. Plugin-owned path —
   * never `ops/tog-2138/`, which is TOG-2138's own directory.
   *
   * Lowercase-and-hyphen only: `pluginManifestV1Schema` rejects a `folderKey`
   * that doesn't match `^[a-z0-9][a-z0-9._:-]*$` (no camelCase).
   */
  shadowDecisions: "shadow-decisions",
} as const;

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
/** A card closed less than this many days ago is right-censored: never accepted, never rejected. */
export const CARD_CENSOR_DAYS = 14;
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

/** `tier_dispatcher.py` `label_only_pass()`'s fixed `limit 100` row fetch. No separate write cap in the source. */
export const LABEL_ONLY_PASS_FETCH_LIMIT = 100;
/** `tier_dispatcher.py` `repin_pass()`'s fixed `limit 400` row fetch. */
export const REPIN_PASS_FETCH_LIMIT = 400;
/** `tier_dispatcher.py` `repin_pass(limit=6)`'s default write cap per run. */
export const REPIN_PASS_WRITE_LIMIT = 6;
/** `tier_dispatcher.py` `balance_pass()`'s fixed `limit 400` row fetch. */
export const BALANCE_PASS_FETCH_LIMIT = 400;
/** `tier_dispatcher.py` `balance_pass(limit=8)`'s default write cap per run. */
export const BALANCE_PASS_WRITE_LIMIT = 8;
/** `balance_pass()`'s `cheaper = blended(nm) <= 0.8*blended(pm)` cost-down threshold. */
export const BALANCE_PASS_COST_DOWN_MULTIPLIER = 0.8;
/** `balance_pass()`'s `busier = (cur_u-new_u)>=0.25` rebalance threshold. */
export const BALANCE_PASS_BUSIER_UTILIZATION_DELTA = 0.25;
/** `balance_pass()`'s `probation` branch: a pinned model priced under this (blended $/Mtok) and still unproven may hold only one active card. */
export const BALANCE_PASS_PROBATION_PRICE_USD = 0.1;

/**
 * TOG-2481 port of the `dispatch` plugin's `ISSUE_PAGE_LIMIT` — the sweep's
 * single-page `ctx.issues.list` fetch cap. A company with more open issues
 * than this per firing is a saturation condition the sweep notes rather than
 * paginating through, matching the standalone plugin's own behavior exactly.
 */
export const DISPATCH_ISSUE_PAGE_LIMIT = 1000;
