// src/constants.ts
var PLUGIN_ID = "togetherweown.model-selection";
var PLUGIN_API_VERSION = 1;
var PLUGIN_VERSION = "0.1.0";
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
   * ANTHROPIC_DEFAULT_* env var, runtimeConfig.modelProfiles.cheap) disagree
   * with the lane-aware T3 recommendation. Read-only, always advisory: there
   * is no write path from this plugin to any of these surfaces (`ctx.agents`
   * has no update method, and `ctx.http.fetch` is SSRF-blocked from the
   * host's own internal API), so this can never be anything but a report.
   */
  ancillaryDrift: "model_selection_ancillary_drift"
};
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
  refreshScores: "refreshScores"
};
var TIERS = ["T1", "T2", "T3"];
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
var DEFAULT_OPERATOR_OVERRIDE_TTL_SECONDS = 60 * 60;
var DEFAULT_IDLE_REPIN_HYSTERESIS_SECONDS = 5 * 60;
var REOPEN_WINDOW_MS = 72 * 60 * 60 * 1e3;
var REJECTION_WINDOW_MS = 48 * 60 * 60 * 1e3;

// src/config/schema.ts
var MODEL_CAPABILITIES = ["tools", "structured-output", "vision", "long-context", "computer-use"];
var SECRET_REF_SCHEMA = {
  type: ["object", "null"],
  format: "secret-ref",
  additionalProperties: false,
  required: ["type", "secretId"],
  properties: {
    type: { const: "secret_ref" },
    secretId: { type: "string", format: "uuid" },
    version: { oneOf: [{ const: "latest" }, { type: "integer", minimum: 1 }] },
    projectionClass: { type: "string", enum: ["unclassified", "class_3_static_lease"] },
    projectionAllowlistKey: { type: ["string", "null"] }
  },
  default: null
};
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
        defaultTier: { type: "string", enum: [...TIERS], default: "T1" },
        stickyModelWithinIssue: { type: "boolean", default: true },
        holdOnUntrustedProfile: { type: "boolean", default: true },
        /**
         * Which cost term orders candidates. `list-price` (default) is the
         * existing `expectedCostUsd` sort, byte-for-byte unchanged.
         * `cost-per-accepted-card` is Slice 3 (TOG-2048 decision A) — computed
         * and shadow-diffed for 7 days before this ever flips in a live config.
         */
        objective: { type: "string", enum: ["list-price", "cost-per-accepted-card"], default: "list-price" }
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
          contextWindow: { type: "integer", minimum: 1, default: 2e5 },
          aaIndex: { type: ["number", "null"], default: null },
          releasedAt: { type: "string", format: "date" },
          fallbackOnly: { type: "boolean", default: false },
          note: { type: "string", default: "" },
          /**
           * Slice 1 stores the reviewed earn-in payload as roster metadata. The
           * admission logic remains off until slice 4 implements and validates
           * its deterministic counter and lane gates.
           */
          earnIn: { type: ["object", "null"], default: null },
          /** TOG-2137: which `pacing.lanes[].laneId` governs this model's pace. Omit for a model with no lane. */
          laneId: { type: "string", minLength: 1 }
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
    /**
     * TOG-2137, Defect 2. Company label id for the `operator` label, applied to
     * the escalation issue this plugin creates when a tier is fully
     * pace-exhausted. Same constraint as `tierLabelIds`: there is no label
     * surface in the plugin SDK, so the id cannot be resolved from the name —
     * it is operator-supplied, and optional (the escalation issue is still
     * created without it, just unlabelled).
     */
    operatorLabelId: { type: "string", minLength: 1, title: "Operator label id" },
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
    },
    /**
     * TOG-2137: lane-pace polling and pace-first within-tier ordering.
     * `off` polls nothing. `shadow` (default) polls, records the lane ledger,
     * and includes the pace-ordering trace, but never lets pace change which
     * model is selected. `enforce` lets pace reorder candidates within a
     * tier-cost group (never across an already-decided cost/tier order).
     */
    pacing: {
      type: "object",
      title: "Lane pacing",
      additionalProperties: false,
      properties: {
        mode: { type: "string", enum: [...PACING_MODES], default: "shadow" },
        lanes: {
          type: "array",
          title: "Lane sources",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["laneId", "statusUrl", "windows"],
            properties: {
              laneId: { type: "string", minLength: 1 },
              statusUrl: {
                type: "string",
                minLength: 1,
                pattern: "^https://[^/?#@]+(?:/[^?#]*)?$"
              },
              requestTimeoutMs: { type: "integer", minimum: 1, default: 5e3 },
              maxResponseBytes: { type: "integer", minimum: 1, default: 262144 },
              /** TOG-2379: resolved via `ctx.secrets.resolve()` and sent as `X-Api-Key` before each poll. */
              apiKeySecretRef: SECRET_REF_SCHEMA,
              /** True for a lane with no consumption ceiling — always serviceable, pace state `free`. */
              free: { type: "boolean", default: false },
              healthFields: {
                type: "array",
                items: { type: "string", minLength: 1 },
                default: ["health", "status"]
              },
              weightFields: {
                type: "array",
                items: { type: "string", minLength: 1 },
                default: ["weight"]
              },
              governingWindowField: { type: "string", minLength: 1, default: "governing_window" },
              windowSecondsField: { type: "string", minLength: 1, default: "window_seconds" },
              staleAfterSecondsField: { type: "string", minLength: 1, default: "staleAfterSeconds" },
              windows: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["name", "role", "utilizationFields"],
                  properties: {
                    name: { type: "string", minLength: 1 },
                    role: { type: "string", enum: ["serviceability", "allowance"] },
                    utilizationFields: {
                      type: "array",
                      minItems: 1,
                      items: { type: "string", minLength: 1 }
                    },
                    resetFields: {
                      type: "array",
                      items: { type: "string", minLength: 1 },
                      default: []
                    },
                    defaultWindowSeconds: { type: "integer", minimum: 1 }
                  }
                }
              },
              /** Overrides the pace engine's default margin/urgent-reset/staleness policy for this lane. */
              margin: { type: "number", minimum: 0, maximum: 1 },
              urgentResetSeconds: { type: "integer", minimum: 1 },
              maxSnapshotAgeSeconds: { type: "integer", minimum: 1 }
            }
          },
          default: []
        },
        /** Ahead-of-line throttling never drops a lane's slot share below this, while serviceable. */
        slotFloorFraction: { type: "number", minimum: 0, maximum: 1, default: 0.25 },
        /** Default TTL applied to an operator override recorded in the lane ledger. */
        operatorOverrideTtlSeconds: { type: "integer", minimum: 1, default: 3600 },
        /** Minimum idle time before a pace-driven repin may fire on the same issue again. */
        idleRepinHysteresisSeconds: { type: "integer", minimum: 0, default: 300 }
      },
      default: {}
    },
    /**
     * Slice 4 (TOG-2048 decision B): bounded T1 earn-in for unproven candidate
     * models. Default OFF — this section being absent, or `enabled: false`,
     * must leave dispatch behavior byte-for-byte identical to today.
     */
    earnIn: {
      type: "object",
      title: "Bounded T1 earn-in",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", default: false },
        perModelPerWeek: { type: "integer", minimum: 1, maximum: 8, default: 8 },
        maxActivePerModel: { type: "integer", minimum: 1, default: 1 },
        maxActivePerLane: { type: "integer", minimum: 1, default: 1 },
        classes: {
          type: "array",
          items: { type: "string", enum: ["research", "review"] },
          default: ["research", "review"]
        },
        stopOnFirstNFailures: { type: "integer", minimum: 1, default: 2 },
        stopWindow: { type: "integer", minimum: 1, default: 8 }
      },
      default: {}
    },
    /**
     * TOG-2137. Emits one `tog2138-decision-v1` JSONL record per `advise()`
     * call to the `shadowDecisions` local folder, for the 48h host/plugin
     * agreement stream `ops/tog-2138/gate_harness.py` correlates against.
     * Off by default — same inert-install discipline as `selection.mode`:
     * installing this plugin must not start writing files an operator did
     * not ask for.
     */
    shadowEmit: {
      type: "object",
      title: "TOG-2138 shadow decision emitter",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", default: false },
        /** The JSONL file is rewritten whole on every append; this caps its size by dropping the oldest records. */
        maxRecords: { type: "integer", minimum: 1, default: 5e3 }
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
    // TOG-2137: poll operator-configured lane-capacity status URLs.
    "http.outbound",
    // TOG-2379: resolve a lane's optional apiKeySecretRef before polling it.
    "secrets.read-ref",
    // Capture issue.updated (reopen) / issue.comment.created (rejection) signals
    // for the card-level acceptance ledger, since `activity_log` is not an
    // allowlisted table and cannot be queried directly (TOG-1917 §2.2).
    "events.subscribe",
    // TOG-2137, Defect 2: raise a `tier-exhausted` alarm when every tier from
    // the required floor through T1 is pace-exhausted — there is nowhere left
    // to escalate to, and this must reach an operator rather than fail
    // silently the way the reference dispatcher's `pick()` does. The alarm
    // reuses this instance's existing `Operator: <title>` + `operator`-label
    // issue-creation convention (confirmed against 20+ live examples, e.g.
    // TOG-2318/TOG-2324/TOG-2333), not a same-issue interaction card — an
    // `Operator:` issue is a real, separately-triaged unit of work, and that
    // is what a capacity dead end actually is.
    "issues.create",
    // Recompute volume profiles and success scores from heartbeat_runs/issues/issue_comments.
    "database.namespace.read",
    // Required by `pluginManifestV1Schema` for ANY manifest declaring
    // `database`, even one that owns no tables: the validator pairs
    // `namespace.migrate` with `namespace.read` unconditionally. Our migrations
    // directory is deliberately empty (see migrations/README.md), so this
    // capability is declared and never exercised. It is NOT
    // `database.namespace.write` — this plugin never writes a row of its own.
    "database.namespace.migrate",
    // TOG-2137. Append-only `tog2138-decision-v1` shadow-decision JSONL, the
    // plugin-shadow half of the 48h host/plugin agreement stream. `ctx.db` is
    // scoped to `heartbeat_runs` reads only (above) and cannot hold an
    // append-only audit log a company operator can point external tooling at
    // directly — a local folder is the SDK's plain-file surface for exactly
    // that.
    "local.folders"
  ],
  entrypoints: { worker: "./dist/worker.js" },
  instanceConfigSchema: SELECTION_CONFIG_SCHEMA,
  localFolders: [
    {
      folderKey: LOCAL_FOLDER_KEYS.shadowDecisions,
      displayName: "Shadow decision log",
      description: "Append-only tog2138-decision-v1 JSONL, one record per advise() call, for the TOG-2138 48h host/plugin-shadow agreement gate.",
      access: "readWrite"
    }
  ],
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
    // NOT `issue_work_products`, `activity_log`, or `labels` — reopen/rejection
    // signals are sourced from captured `ctx.events`, not a live join against a
    // table this plugin isn't allowlisted to read (TOG-1917 §2.2 / TOG-2136).
    coreReadTables: ["heartbeat_runs", "issues", "issue_comments", "issue_relations"]
  },
  jobs: [
    {
      jobKey: JOB_KEYS.refreshProfiles,
      displayName: "Refresh volume profiles",
      description: "Recompute per-tier token volume from this company's own runs. Without this the cost term goes stale and the engine holds at the agent floor rather than guess.",
      schedule: "17 */6 * * *"
    },
    {
      jobKey: JOB_KEYS.pollLanes,
      displayName: "Poll lane capacity",
      description: "Poll operator-configured lane-capacity status URLs and refresh the pace ledger. Pace's own freshness budget is on the order of minutes, so this runs far more often than the volume-profile refresh.",
      schedule: "*/5 * * * *"
    },
    {
      jobKey: JOB_KEYS.refreshScores,
      displayName: "Refresh model scores",
      description: "Recompute per-model, per-tier Bayesian success scores and the card-level acceptance ledger from this company's own runs and captured rework signals.",
      schedule: "37 */6 * * *"
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
    },
    {
      name: TOOL_NAMES.setOperatorOverride,
      displayName: "Set an operator override for an issue",
      description: "Record a time-boxed override: route this issue to the named model ahead of pace ordering and slot throttling, until it expires. Never bypasses a capability gate, tier floor/ceiling, the untrusted-profile hold, or a serviceability hard stop.",
      parametersSchema: {
        type: "object",
        required: ["issueId", "modelId"],
        properties: {
          issueId: { type: "string", minLength: 1 },
          modelId: { type: "string", minLength: 1 },
          ttlSeconds: { type: "integer", minimum: 1 }
        }
      }
    },
    {
      name: TOOL_NAMES.ancillaryDrift,
      displayName: "Report ancillary model pin drift",
      description: "Report which agents' ancillary model pins (ANTHROPIC_SMALL_FAST_MODEL, CLAUDE_CODE_SUBAGENT_MODEL, every ANTHROPIC_DEFAULT_* env var, runtimeConfig.modelProfiles.cheap) disagree with the lane-aware T3 recommendation, and who must act on each surface. Read-only; there is no write path from this plugin to any of these surfaces.",
      parametersSchema: { type: "object", additionalProperties: false, properties: {} }
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
