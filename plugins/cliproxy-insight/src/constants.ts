export const PLUGIN_ID = "togetherweown.cliproxy-insight";
/** Literal 1, not "1": `PaperclipPluginManifestV1.apiVersion` is typed `1`. */
export const PLUGIN_API_VERSION = 1 as const;
export const PLUGIN_VERSION = "0.3.1";

/**
 * Display/seed ordering only — NOT an allowlist.
 *
 * v0.1.0 used this list to *filter* the polled payload, which silently drops
 * every provider whose lane name is not in it. The lane the operator actually
 * stood up serves `claude`, `codex`, `codex-spark`, `kimi`, `opencode-go` — so
 * `codex` and `codex-spark` were discarded (the old list says `openai`), and
 * `openai`/`antigravity`/`xai` would have read as permanently absent. Provider
 * identity now comes from the payload; this list only orders known names first.
 */
export const SEED_PROVIDER_ORDER = [
  "claude",
  "codex",
  "codex-spark",
  "openai",
  "antigravity",
  "opencode-go",
  "xai",
  "kimi",
] as const;

export const TOOL_NAMES = {
  /** Read-only: current usage/cooldown state for one or all providers. */
  getProviderUsage: "get_provider_usage",
} as const;

// Route keys are validated against a lowercase-only regex by
// `pluginManifestV1Schema` — camelCase is rejected at install time.
export const ROUTE_KEYS = {
  usageSummary: "usage-summary",
} as const;

export const JOB_KEYS = {
  poll: "cliproxy-poll",
} as const;

/**
 * The two files the containment lane serves (TOG-952). Relative to `baseUrl`,
 * which is the lane namespace, not the CLIProxy origin. Neither path is the
 * raw management API — `/v0/management/*` returns api-keys, config and
 * id_tokens in clear and is never reachable from here.
 */
export const LANE_PATHS = {
  requestRates: "request-rates.json",
  modelUsage: "model-usage-v1.json",
} as const;

/**
 * Caddy validates `x-api-key` on the lane (`header X-Api-Key {env...}`), and
 * the Model Router's own reader sends the same header
 * (`src/capacity/read.ts:24`). v0.1.0 sent `Authorization: Bearer`, which the
 * lane does not read — every poll would have 401'd.
 */
export const LANE_AUTH_HEADER = "x-api-key";

/**
 * The per-lane documents the telemetry lane actually serves today (v0.3.0).
 *
 * v0.2.0 polled only `LANE_PATHS` — the two aggregate files the 2026-09-05
 * sanitizer design specified. The lane has since been rebuilt around the
 * TOG-2693 collector contract: one file per lane, each an
 * `{schemaVersion, observedAt, staleAfterSeconds, records[]}` envelope, and
 * those are the files `model-selection`'s pacer polls in production
 * (`ops/model-selection/deploy-.../live-verification.json`). Measured 200s on
 * `claude.json` and `codex.json` 2026-09-17 00:54Z, and a 404 on `devin.json`
 * — the lane allowlist is explicit, so an unlisted name is simply not served.
 *
 * This is a DEFAULT, not an allowlist: `laneFiles` is config, because adding a
 * lane on the host must not require a plugin release.
 */
export const DEFAULT_LANE_FILES = [
  "claude.json",
  "codex.json",
  "kimi.json",
  "opencode-go.json",
  "zai.json",
  "antigravity.json",
] as const;

/**
 * Keys carrying the instant a credential leaves cooldown, newest contract name
 * first. `exhausted_until` is the head of the list the `model-selection`
 * normalizer accepts (`lane-capacity/pace.ts`), and the quota contract
 * (`cliproxy_quota_contract.py` v4) emits exactly that name flat, alongside a
 * nested `cooldown: {until, reason}` kept for humans. Read both: a nested
 * object is invisible to a flat-key reader, which is the defect that shipped
 * in the producer at `8a5b98de` and was fixed at `10864210`.
 */
export const LANE_COOLDOWN_FIELDS = [
  "exhausted_until",
  "exhaustedUntil",
  "cooldown_until",
  "cooldownUntil",
  "rate_limited_until",
  "rateLimitedUntil",
] as const;

/** Reason aliases published beside the cooldown instant. Bounded strings only. */
export const LANE_COOLDOWN_REASON_FIELDS = [
  "exhausted_reason",
  "exhaustedReason",
  "cooldown_reason",
  "cooldownReason",
] as const;

/**
 * `health` values that mean the lane account is refusing work. `cooldown` is
 * deliberately NOT here: the Router's `normalizeCapacityPayload` maps it to
 * `degraded` → posture `avoid`, which is still selectable (measured, TOG-811
 * 2026-09-17). Only `exhausted`/`unavailable` reach unserviceable.
 */
export const LANE_UNSERVICEABLE_HEALTH = ["exhausted", "unavailable"] as const;

export const STATE_KEYS = {
  provider: (provider: string) => `cliproxy-insight:provider:${provider}`,
  /** Plugin state has no scan/list, so the set of observed providers is itself state. */
  providerIndex: "cliproxy-insight:provider-index",
  modelUsage: "cliproxy-insight:model-usage",
  cooldownEvents: (provider: string) => `cliproxy-insight:cooldown-events:${provider}`,
  /** One persisted snapshot per lane document, keyed by its file name. */
  lane: (laneFile: string) => `cliproxy-insight:lane:${laneFile}`,
  /** Same reason as `providerIndex`: state offers no scan. */
  laneIndex: "cliproxy-insight:lane-index",
} as const;

/** Cap on retained cooldown-transition events per provider (TOG-811 design Q6). */
export const MAX_COOLDOWN_EVENTS_PER_PROVIDER = 200;

/**
 * Field aliases accepted in `request-rates.json`. The lane is operator-built,
 * so these aliases mean a cosmetic rename upstream degrades one counter to
 * null instead of silently reporting zero traffic.
 */
export const REQUEST_RATE_FIELDS = {
  success: ["success", "successes", "successCount", "success_count", "ok"],
  failed: ["failed", "failures", "failureCount", "failure_count", "errors"],
} as const;

/** Contract version this plugin implements for `model-usage-v1.json`. */
export const SUPPORTED_SCHEMA_VERSION = 1;
