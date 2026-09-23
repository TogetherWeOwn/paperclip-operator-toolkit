// src/constants.ts
var PLUGIN_ID = "togetherweown.cliproxy-insight";
var PLUGIN_API_VERSION = 1;
var PLUGIN_VERSION = "0.3.1";
var TOOL_NAMES = {
  /** Read-only: current usage/cooldown state for one or all providers. */
  getProviderUsage: "get_provider_usage"
};
var ROUTE_KEYS = {
  usageSummary: "usage-summary"
};
var JOB_KEYS = {
  poll: "cliproxy-poll"
};
var DEFAULT_LANE_FILES = [
  "claude.json",
  "codex.json",
  "kimi.json",
  "opencode-go.json",
  "zai.json",
  "antigravity.json"
];

// src/config/schema.ts
var CLIPROXY_INSIGHT_CONFIG_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  additionalProperties: false,
  required: [],
  properties: {
    pollingEnabled: {
      type: "boolean",
      title: "Enable polling",
      description: "OFF until laneApiKeySecretRef holds the cliproxy-usage-lane-key secret. While off, the scheduled job writes a heartbeat metric and does nothing else \u2014 no outbound request is made.",
      default: false
    },
    baseUrl: {
      type: "string",
      title: "Telemetry lane base URL",
      description: "The Caddy-fronted sanitized telemetry namespace (TOG-952) \u2014 NEVER the CLIProxy management origin. Serves static JSON only; no management route is reachable through it. Public HTTPS, so the standard SSRF boundary applies unmodified.",
      default: "https://router.example.net/telemetry/cliproxy",
      minLength: 1
    },
    laneApiKeySecretRef: {
      type: ["object", "null"],
      format: "secret-ref",
      title: "Telemetry lane bearer (secret reference)",
      description: "Reference to the cliproxy-usage-lane-key Paperclip secret, sent as the x-api-key header. Never a raw key; resolved at call time only, never logged, never written to plugin.state. This is the lane bearer, NOT the CLIProxy management key \u2014 that key stays on the host and is never placed in Paperclip.",
      default: null
    },
    requestTimeoutMs: {
      type: "number",
      title: "Request timeout (ms)",
      default: 1e4,
      minimum: 1e3,
      maximum: 3e4
    },
    maxCooldownEventsPerProvider: {
      type: "number",
      title: "Max retained cooldown events per provider",
      description: "Rolling cap on the persisted cooldown/exhaustion event log per provider.",
      default: 200,
      minimum: 10,
      maximum: 2e3
    },
    staleAfterSeconds: {
      type: "number",
      title: "Snapshot staleness budget (seconds)",
      description: "A persisted snapshot older than this is reported stale by get_provider_usage and the usage-summary route. The host collector publishes every 2 minutes; this is the consumer-side budget, and model-usage-v1.json may carry its own staleAfterSeconds, which wins when present.",
      default: 600,
      minimum: 60,
      maximum: 86400
    },
    laneFiles: {
      type: "array",
      title: "Lane documents to poll",
      description: "File names under baseUrl, one per lane, each an {schemaVersion, observedAt, records[]} document in the TOG-2693 collector contract \u2014 the same files model-selection's pacer polls. Names not on the lane's Caddy allowlist are simply not served (devin.json 404s today), so an unserved name costs one 404 per firing and nothing else. Empty disables lane polling.",
      default: [...DEFAULT_LANE_FILES],
      maxItems: 32,
      items: { type: "string", minLength: 1, maxLength: 128 }
    },
    legacyAggregateFiles: {
      type: "boolean",
      title: "Also poll the v0.2.0 aggregate files",
      description: "Polls request-rates.json and model-usage-v1.json, the two files the 2026-09-05 sanitizer design specified. The lane was rebuilt around per-lane documents before either was ever read from Paperclip, so this defaults OFF: leaving it on against a lane that does not serve them writes two poll_errors every firing, which is the noise that hides a real failure.",
      default: false
    }
  }
};

// src/manifest.ts
var manifest = {
  id: PLUGIN_ID,
  apiVersion: PLUGIN_API_VERSION,
  version: PLUGIN_VERSION,
  displayName: "CLIProxy Insight",
  description: "Durable per-upstream-provider usage/cooldown telemetry from the sanitized CLIProxy lane, plus per-model capacity windows. Read-only forever.",
  author: "CTO & Chief AI Officer (Paperclip)",
  categories: ["automation"],
  capabilities: [
    // The substrate. Every poll runs from here.
    "jobs.schedule",
    // Outbound GET to the public HTTPS telemetry lane.
    "http.outbound",
    // Resolve the lane bearer at call time only — never cached, logged, or
    // written to state (ADR-0004 discipline).
    "secrets.read-ref",
    // Durable snapshot + cooldown-event persistence — this IS the deliverable:
    // Paperclip becomes the history neither CLIProxy nor the lane keeps.
    "plugin.state.read",
    "plugin.state.write",
    // Weekly-scorecard metrics, every firing (dispatch precedent: a gauge
    // that stops being written is indistinguishable from a healthy zero).
    "metrics.write",
    // ctx.activity.log() on poll failure, cooldown transition, and change.
    "activity.log.write",
    // get_provider_usage, so an agent can consult quota state before a burst.
    "agent.tools.register",
    // Usage summary surface for the board UI.
    "api.routes.register"
  ],
  entrypoints: { worker: "./dist/worker.js" },
  jobs: [
    {
      jobKey: JOB_KEYS.poll,
      displayName: "CLIProxy usage poll",
      description: "Reads the sanitized telemetry lane and persists per-provider counters and per-model capacity windows. No-op (heartbeat metric only) while config.pollingEnabled is false or no secret is configured.",
      // The host collector republishes every 2 minutes. Polling at */5 keeps
      // history meaningfully fresh without ever retrying inside a firing —
      // a tight retry loop is how a poller IP-bans itself (TOG-811 recon).
      schedule: "*/5 * * * *"
    }
  ],
  instanceConfigSchema: CLIPROXY_INSIGHT_CONFIG_SCHEMA,
  tools: [
    {
      name: TOOL_NAMES.getProviderUsage,
      displayName: "Get provider usage",
      description: "Read the most recently persisted CLIProxy usage state: per-provider success/failed counters, cooldown history, and per-model capacity windows, each flagged stale when older than the freshness budget. Read-only; consults stored history, never calls CLIProxy.",
      parametersSchema: {
        type: "object",
        required: ["companyId"],
        properties: {
          companyId: { type: "string", description: "Company whose CLIProxy history applies" },
          provider: {
            type: "string",
            description: "Optional. One provider key as published by the lane (e.g. claude, codex, codex-spark, kimi, opencode-go). Omit to return every provider observed so far."
          }
        }
      }
    }
  ],
  apiRoutes: [
    {
      routeKey: ROUTE_KEYS.usageSummary,
      method: "GET",
      path: "/usage-summary",
      auth: "board-or-agent",
      capability: "api.routes.register",
      checkoutPolicy: "none",
      companyResolution: { from: "query", key: "companyId" }
    }
  ]
};
var manifest_default = manifest;
export {
  manifest_default as default,
  manifest
};
//# sourceMappingURL=manifest.js.map
