export const PLUGIN_ID = "togetherweown.model-selection";
/** Literal 1, not "1": `PaperclipPluginManifestV1.apiVersion` is typed `1`. */
export const PLUGIN_API_VERSION = 1 as const;
export const PLUGIN_VERSION = "0.1.0";

export const TOOL_NAMES = {
  /** Advise a tier + model for one issue. Read-only, always safe to call. */
  advise: "model_selection_advise",
  /** Advise and, if enforcement is on for this company, write the override. */
  apply: "model_selection_apply",
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
} as const;

/**
 * Label names are the durable tier record (ADR-0008). The name encodes work
 * kind, never a model id — `tier:T1` stays `tier:T1` when the model behind T1
 * changes.
 */
export const TIER_LABEL_PREFIX = "tier:";
export const TIERS = ["T1", "T2", "T3"] as const;
export type Tier = (typeof TIERS)[number];

/** T1 cheapest ... T3 most capable. Index order is load-bearing. */
export const TIER_ORDER: readonly Tier[] = TIERS;

export const PLUGIN_STATE_KEYS = {
  volumeProfiles: "volumeProfiles",
} as const;
