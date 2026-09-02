// src/constants.ts
var PLUGIN_ID = "togetherweown.model-selection";
var PLUGIN_API_VERSION = 1;
var PLUGIN_VERSION = "0.1.0";
var TOOL_NAMES = {
  /** Advise a tier + model for one issue. Read-only, always safe to call. */
  advise: "model_selection_advise",
  /** Advise and, if enforcement is on for this company, write the override. */
  apply: "model_selection_apply"
};
var ROUTE_KEYS = {
  advise: "advise",
  applyIssue: "apply-issue"
};
var JOB_KEYS = {
  /** Recompute per-tier volume profiles from this company's own runs. */
  refreshProfiles: "refreshVolumeProfiles"
};
var TIERS = ["T1", "T2", "T3"];

// src/config/schema.ts
var MODEL_CAPABILITIES = ["tools", "structured-output", "vision", "long-context", "computer-use"];
var SELECTION_CONFIG_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  additionalProperties: false,
  required: ["models"],
  properties: {
    selection: {
      type: "object",
      title: "Selection",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", default: true },
        /**
         * `advise` records a decision and writes nothing. It is the default
         * and it is the whole Stage-2 safety story: install, watch, then
         * enforce — never two live selection variables in one window.
         */
        mode: { type: "string", enum: ["advise", "enforce"], default: "advise" },
        defaultTier: { type: "string", enum: [...TIERS], default: "T3" },
        stickyModelWithinIssue: { type: "boolean", default: true },
        holdOnUntrustedProfile: { type: "boolean", default: true }
      },
      default: {}
    },
    models: {
      type: "array",
      title: "Model table",
      description: "Models this company will run a harness on. Rates are $/Mtok recovered from our own heartbeat_runs, not vendor list prices.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "tier", "costPerMTokIn", "costPerMTokOut", "costPerMTokCacheRead"],
        properties: {
          id: { type: "string", minLength: 1 },
          tier: { type: "string", enum: [...TIERS] },
          enabled: { type: "boolean", default: true },
          costPerMTokIn: { type: "number", minimum: 0 },
          costPerMTokOut: { type: "number", minimum: 0 },
          costPerMTokCacheRead: { type: "number", minimum: 0 },
          capabilities: {
            type: "array",
            items: { type: "string", enum: MODEL_CAPABILITIES },
            default: []
          },
          contextWindow: { type: "integer", minimum: 1, default: 2e5 }
        }
      },
      default: []
    },
    /**
     * Company label ids for `tier:T1` / `tier:T2` / `tier:T3`, keyed by tier.
     *
     * These are operator-supplied because the plugin genuinely cannot look them
     * up: there is no label surface anywhere in the plugin SDK, and `labels` is
     * absent from PLUGIN_DATABASE_CORE_READ_TABLES, so `ctx.db.query` against it
     * is rejected by `assertAllowedPublicRead`. Leaving this unset is a
     * supported configuration — the override is still written, just without the
     * label, which is additive information rather than a gate (ADR-0008).
     */
    tierLabelIds: {
      type: "object",
      title: "Tier label ids",
      additionalProperties: false,
      properties: Object.fromEntries(
        TIERS.map((tier) => [tier, { type: "string", minLength: 1 }])
      ),
      default: {}
    },
    profiles: {
      type: "object",
      title: "Volume profiles",
      additionalProperties: false,
      properties: {
        /** Days of runs the refresh job reads when recomputing profiles. */
        windowDays: { type: "integer", minimum: 1, maximum: 90, default: 7 },
        minSamples: { type: "integer", minimum: 1, default: 5 },
        maxAgeDays: { type: "integer", minimum: 1, maximum: 90, default: 14 }
      },
      default: {}
    },
    quality: {
      type: "object",
      title: "Quality floor (ADR-0005)",
      additionalProperties: false,
      properties: {
        /**
         * Escalation ceilings per tier. A T1 breach diagnoses a wrong TIER
         * BOUNDARY, not a wrong model — move the task type up, do not swap the
         * model.
         */
        t1EscalationCeiling: { type: "number", minimum: 0, maximum: 1, default: 0.05 },
        t2EscalationCeiling: { type: "number", minimum: 0, maximum: 1, default: 0.15 },
        /** A silent quality failure counts this many escalations. */
        silentFailureWeight: { type: "integer", minimum: 1, default: 10 }
      },
      default: {}
    }
  }
};

// src/manifest.ts
var DESCRIPTOR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["issueId"],
  properties: {
    issueId: { type: "string", minLength: 1 },
    /**
     * The capability-exclusion answer is SUPPLIED, never inferred. ADR-0004's
     * boundary is capability, not difficulty, and no text classifier can read
     * "does this touch money, credentials, fleet config, or an irreversible
     * action" off an issue title.
     */
    exclusion: {
      type: "object",
      additionalProperties: false,
      required: ["excluded"],
      properties: {
        excluded: { type: "boolean" },
        reasons: { type: "array", items: { type: "string" } }
      }
    },
    requiredCapabilities: {
      type: "array",
      items: { type: "string", enum: ["tools", "structured-output", "vision", "long-context", "computer-use"] }
    },
    requiredContextTokens: { type: "integer", minimum: 1 }
  }
};
var manifest = {
  id: PLUGIN_ID,
  apiVersion: PLUGIN_API_VERSION,
  version: PLUGIN_VERSION,
  displayName: "Model Selection",
  description: "Chooses the cheapest fully-capable model for each harness run, keyed on a recorded tier judgement and ordered by a volume-aware cost term measured from this company's own runs.",
  author: "TogetherWeOwn",
  categories: ["automation"],
  capabilities: [
    // Read the issue, its labels, and the assignee's tier floor.
    "issues.read",
    "agents.read",
    // Write the per-issue override and the tier label. This is System 1 in
    // ADR-0010's taxonomy, reached through `issues.update` — the task-level
    // override — and deliberately NOT through `agents.managed`, which would
    // write agent rows verbatim and unvalidated. This plugin never changes an
    // agent's floor; it only decides one issue at a time, reversibly.
    "issues.update",
    // The decision record. Every selection is auditable after the fact.
    "activity.log.write",
    "metrics.write",
    "plugin.state.read",
    "plugin.state.write",
    "agent.tools.register",
    "api.routes.register",
    "jobs.schedule",
    "companies.read",
    // Recompute volume profiles from heartbeat_runs.
    "database.namespace.read",
    // Required by `pluginManifestV1Schema` for ANY manifest declaring
    // `database`, even one that owns no tables: the validator pairs
    // `namespace.migrate` with `namespace.read` unconditionally. Our migrations
    // directory is deliberately empty (see migrations/README.md), so this
    // capability is declared and never exercised. It is NOT
    // `database.namespace.write` — this plugin never writes a row of its own.
    "database.namespace.migrate"
  ],
  entrypoints: { worker: "./dist/worker.js" },
  instanceConfigSchema: SELECTION_CONFIG_SCHEMA,
  /**
   * `ctx.db` is only wired once the plugin has an ACTIVE namespace, and
   * `ensureNamespace` returns null unless `manifest.database` is present
   * (`plugin-database.ts:469-471`, `413-419`). Declaring the namespace is
   * therefore a precondition for reading `heartbeat_runs` at all, even though
   * this plugin owns no tables of its own — hence an empty migrations dir.
   *
   * `coreReadTables` is the read allowlist enforced per query by
   * `assertAllowedPublicRead` (`plugin-database.ts:157-168`): a `public.` table
   * absent from this list is rejected, and only in a FROM/JOIN/REFERENCES
   * position. We ask for exactly the one table the volume profile is measured
   * from, and nothing else.
   */
  database: {
    namespaceSlug: "model_selection",
    migrationsDir: "./migrations",
    coreReadTables: ["heartbeat_runs"]
  },
  jobs: [
    {
      jobKey: JOB_KEYS.refreshProfiles,
      displayName: "Refresh volume profiles",
      description: "Recompute per-tier token volume from this company's own runs. Without this the cost term goes stale and the engine holds at the agent floor rather than guess.",
      schedule: "17 */6 * * *"
    }
  ],
  tools: [
    {
      name: TOOL_NAMES.advise,
      displayName: "Advise a model for an issue",
      description: "Return the tier judgement, the costed candidates, and the recommended model for one issue. Read-only; writes nothing.",
      parametersSchema: DESCRIPTOR_SCHEMA
    },
    {
      name: TOOL_NAMES.apply,
      displayName: "Apply a model selection to an issue",
      description: "Advise, then write the per-issue override and tier label if enforcement is enabled for this company. No-ops on an issue that already has an override.",
      parametersSchema: DESCRIPTOR_SCHEMA
    }
  ],
  apiRoutes: [
    {
      routeKey: ROUTE_KEYS.advise,
      method: "POST",
      path: "/advise",
      auth: "board-or-agent",
      capability: "api.routes.register",
      checkoutPolicy: "none",
      companyResolution: { from: "query", key: "companyId" }
    },
    {
      routeKey: ROUTE_KEYS.applyIssue,
      method: "POST",
      path: "/issues/:issueId/apply",
      auth: "board-or-agent",
      capability: "api.routes.register",
      checkoutPolicy: "none",
      companyResolution: { from: "issue", param: "issueId" }
    }
  ]
};
var manifest_default = manifest;
export {
  manifest_default as default
};
//# sourceMappingURL=manifest.js.map
