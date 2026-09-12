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
} as const;

export const PACING_MODES = ["off", "shadow", "enforce"] as const;
export type PacingMode = (typeof PACING_MODES)[number];

/** Ahead-of-line throttling never drives a lane's slot share below this. */
export const DEFAULT_SLOT_FLOOR_FRACTION = 0.25;

/** Default TTL for an operator override recorded in the lane ledger. */
export const DEFAULT_OPERATOR_OVERRIDE_TTL_SECONDS = 60 * 60;

/** A repin below the agent floor's normal churn must wait at least this long, and only while the issue is idle. */
export const DEFAULT_IDLE_REPIN_HYSTERESIS_SECONDS = 5 * 60;
