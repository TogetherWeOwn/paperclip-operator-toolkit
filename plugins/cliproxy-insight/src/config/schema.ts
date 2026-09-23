/**
 * Company-scoped config. Every number that decides anything lives here.
 *
 * v0.2.0 re-points this plugin at the **containment lane**, not at CLIProxy.
 * The operator stood the lane up on 2026-09-05 (TOG-952): a host collector
 * reads the CLIProxy management API with the host-held key and publishes
 * sanitized static JSON at `https://router.example.net/telemetry/cliproxy/`,
 * gated on an `x-api-key` bearer we mint (`cliproxy-usage-lane-key`).
 *
 * That collapses this plugin's owner-reserved gate. The CLIProxy management
 * key is NOT placed in Paperclip and never was — the only credential here is
 * the lane bearer, which reads two sanitized files and can reach nothing else.
 * `/v0/management/*` is not routable through the lane at all. So the hard gate
 * in TOG-811 ("placing the management key is owner-reserved") is satisfied by
 * never placing that key, rather than by containing it.
 *
 * v0.3.0 changes WHICH files are read, not where from. The lane now serves one
 * document per lane in the TOG-2693 collector contract (`claude.json`,
 * `zai.json`, …) — the same files `model-selection`'s pacer polls — and those
 * carry the per-account cooldown the owner asked for on 2026-09-17 00:44Z,
 * after a Z.ai cooldown nobody could see cost seven runs. The two v0.2.0
 * aggregate files are now opt-in (`legacyAggregateFiles`).
 *
 * `pollingEnabled` still defaults false: installing is not enabling.
 */
import { DEFAULT_LANE_FILES } from "../constants.js";

export const CLIPROXY_INSIGHT_CONFIG_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  additionalProperties: false,
  required: [],
  properties: {
    pollingEnabled: {
      type: "boolean",
      title: "Enable polling",
      description:
        "OFF until laneApiKeySecretRef holds the cliproxy-usage-lane-key secret. While off, the scheduled job writes a heartbeat metric and does nothing else — no outbound request is made.",
      default: false,
    },
    baseUrl: {
      type: "string",
      title: "Telemetry lane base URL",
      description:
        "The Caddy-fronted sanitized telemetry namespace (TOG-952) — NEVER the CLIProxy management origin. Serves static JSON only; no management route is reachable through it. Public HTTPS, so the standard SSRF boundary applies unmodified.",
      default: "https://router.example.net/telemetry/cliproxy",
      minLength: 1,
    },
    laneApiKeySecretRef: {
      type: ["object", "null"],
      format: "secret-ref",
      title: "Telemetry lane bearer (secret reference)",
      description:
        "Reference to the cliproxy-usage-lane-key Paperclip secret, sent as the x-api-key header. Never a raw key; resolved at call time only, never logged, never written to plugin.state. This is the lane bearer, NOT the CLIProxy management key — that key stays on the host and is never placed in Paperclip.",
      default: null,
    },
    requestTimeoutMs: {
      type: "number",
      title: "Request timeout (ms)",
      default: 10000,
      minimum: 1000,
      maximum: 30000,
    },
    maxCooldownEventsPerProvider: {
      type: "number",
      title: "Max retained cooldown events per provider",
      description: "Rolling cap on the persisted cooldown/exhaustion event log per provider.",
      default: 200,
      minimum: 10,
      maximum: 2000,
    },
    staleAfterSeconds: {
      type: "number",
      title: "Snapshot staleness budget (seconds)",
      description:
        "A persisted snapshot older than this is reported stale by get_provider_usage and the usage-summary route. The host collector publishes every 2 minutes; this is the consumer-side budget, and model-usage-v1.json may carry its own staleAfterSeconds, which wins when present.",
      default: 600,
      minimum: 60,
      maximum: 86400,
    },
    laneFiles: {
      type: "array",
      title: "Lane documents to poll",
      description:
        "File names under baseUrl, one per lane, each an {schemaVersion, observedAt, records[]} document in the TOG-2693 collector contract — the same files model-selection's pacer polls. Names not on the lane's Caddy allowlist are simply not served (devin.json 404s today), so an unserved name costs one 404 per firing and nothing else. Empty disables lane polling.",
      default: [...DEFAULT_LANE_FILES],
      maxItems: 32,
      items: { type: "string", minLength: 1, maxLength: 128 },
    },
    legacyAggregateFiles: {
      type: "boolean",
      title: "Also poll the v0.2.0 aggregate files",
      description:
        "Polls request-rates.json and model-usage-v1.json, the two files the 2026-09-05 sanitizer design specified. The lane was rebuilt around per-lane documents before either was ever read from Paperclip, so this defaults OFF: leaving it on against a lane that does not serve them writes two poll_errors every firing, which is the noise that hides a real failure.",
      default: false,
    },
  },
};
