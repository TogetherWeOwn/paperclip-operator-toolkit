export const PLUGIN_ID = "togetherweown.model-selection";
/** Literal 1, not "1": `PaperclipPluginManifestV1.apiVersion` is typed `1`. */
export const PLUGIN_API_VERSION = 1 as const;
export const PLUGIN_VERSION = "0.1.0";

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
} as const;

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
} as const;

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
