// src/constants.ts
var PLUGIN_ID = "togetherweown.model-selection";
var PLUGIN_API_VERSION = 1;
var PLUGIN_VERSION = "0.4.0";
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
   * ANTHROPIC_DEFAULT_* env var) disagree with the lane-aware T3
   * recommendation. Read-only, always advisory: there is no write path from
   * this plugin to any of these surfaces (`ctx.agents` has no update method,
   * and `ctx.http.fetch` is SSRF-blocked from the host's own internal API),
   * so this can never be anything but a report.
   *
   * TOG-3348: `runtimeConfig.modelProfiles.cheap` was a fifth surface here
   * until Paperclip migration 0236 (v2026.916.0) deleted it with no
   * replacement; removed rather than kept as a frozen snapshot.
   */
  ancillaryDrift: "model_selection_ancillary_drift",
  /** Per-model aa.ai configured vs. live index and tier-boundary drift. Read-only (TOG-2438). */
  aaDriftReport: "model_selection_aa_drift_report",
  /** Manually run the aa.ai fetch + drift-surfacing sweep outside the cron cadence (TOG-2438 reopen AC4). */
  refreshAaIndexNow: "model_selection_refresh_aa_index_now",
  /** TOG-3996: the last models.dev price reconciliation, as an operator-approvable diff. Read-only. */
  priceDriftReport: "model_selection_price_drift_report",
  /** TOG-3996: run the models.dev fetch + price reconciliation now instead of waiting for the daily tick. Still report-only. */
  reconcilePricesNow: "model_selection_reconcile_prices_now",
  /** TOG-2481 port of `lane_outage.json`: declare or clear a telemetry-invisible lane outage. */
  setLaneOutage: "model_selection_set_lane_outage",
  /** TOG-2481 port of `zai_pace_override()` / `zai_pace_override.json`. */
  setZaiPaceOverride: "model_selection_set_zai_pace_override"
};
var LANE_ID_CODEX = "cliproxy-codex";
var LANE_ID_OPENCODE_GO = "cliproxy-opencode-go";
var LANE_ID_ZAI = "cliproxy-zai";
var DEFAULT_PACE_ACCOUNT_KEY_FIELDS = ["account_key", "accountKey", "name", "id"];
var DEFAULT_PACE_WEIGHT_FIELDS = ["plan_weight", "weight"];
var DEFAULT_LANE_CAP_PER_ACCOUNT = {
  [LANE_ID_OPENCODE_GO]: 2,
  [LANE_ID_ZAI]: 3
};
var DEFAULT_AVOID_PER_LANE = {
  [LANE_ID_CODEX]: 0.99
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
  refreshScores: "refreshScores",
  /** Refresh the aa.ai Intelligence Index snapshot and surface tier-boundary drift (TOG-2438). */
  refreshAaIndex: "refreshAaIndex",
  /** TOG-3996: reconcile roster prices against models.dev and report drift (never auto-applies). */
  reconcilePrices: "reconcilePrices",
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
  dispatchSweep: "dispatch-sweep"
};
var TIERS = ["T1", "T2", "T3"];
var NO_ELIGIBLE_NOTICE_THROTTLE_MS = 60 * 60 * 1e3;
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
var CLASSIFY_JOB_BUDGET_MS = 4 * 60 * 1e3;
var BALANCE_PASS_JOB_BUDGET_MS = 4 * 60 * 1e3;

// src/engine/effort.ts
var EFFORT_LADDER = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra"
];

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
        holdOnUnknownAvailability: { type: "boolean", default: false },
        /**
         * Which cost term orders candidates. `list-price` (default) is the
         * existing `expectedCostUsd` sort, byte-for-byte unchanged.
         * `cost-per-accepted-card` is Slice 3 (TOG-2048 decision A) — computed
         * and shadow-diffed for 7 days before this ever flips in a live config.
         */
        objective: { type: "string", enum: ["list-price", "cost-per-accepted-card"], default: "list-price" },
        /** Fleet-wide harness compaction ceiling. Models at/above it need no per-issue env override. */
        fleetContextCeilingTokens: { type: "integer", minimum: 1, default: 1e6 },
        /** Fraction of a narrower model's context window where Claude Code should compact. */
        compactionRatio: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1, default: 0.75 }
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
          /** TOG-2438: explicit aa.ai leaderboard slug override, when normalized-id matching won't find it. */
          aaSlug: { type: "string", minLength: 1 },
          /** TOG-2438: snapshot date the roster's aaIndex above was curated from. Informational only. */
          aaIndexUpdatedAt: { type: ["string", "null"], format: "date", default: null },
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
          laneId: { type: "string", minLength: 1 },
          /**
           * TOG-3995: reasoning effort to pin alongside this model. Omit to
           * leave effort to the agent row.
           *
           * The enum is the UNION of every adapter's vocabulary, so it rejects
           * a typo here rather than at the CLI. It deliberately does not prove
           * the value is legal for this model — that depends on the assignee's
           * adapter, which config validation cannot see. `resolveEffortPin`
           * clamps at write time (`engine/effort.ts`).
           */
          effort: { type: "string", enum: [...EFFORT_LADDER] }
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
              accountKeyFields: {
                type: "array",
                minItems: 1,
                items: { type: "string", minLength: 1 },
                default: [...DEFAULT_PACE_ACCOUNT_KEY_FIELDS]
              },
              weightFields: {
                type: "array",
                minItems: 1,
                items: { type: "string", minLength: 1 },
                default: [...DEFAULT_PACE_WEIGHT_FIELDS]
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
        idleRepinHysteresisSeconds: { type: "integer", minimum: 0, default: 300 },
        /**
         * TOG-2481 port of `tier_dispatcher.py`'s module-level `AVOID = 0.8` /
         * `AVOID_LANE = {"codex": 0.99}`. A lane at or above its threshold is
         * excluded from NEW admission even while still serviceable —
         * `defaultThreshold` is the blanket rule, `perLane` is how a specific
         * lane (e.g. codex, per the 2026-09-07 07:12Z owner rule) earns a
         * higher threshold than the default.
         */
        avoid: {
          type: "object",
          title: "Lane avoid thresholds",
          additionalProperties: false,
          properties: {
            defaultThreshold: { type: "number", minimum: 0, maximum: 1, default: 0.8 },
            perLane: {
              type: "object",
              additionalProperties: { type: "number", minimum: 0, maximum: 1 },
              default: { "cliproxy-codex": 0.99 }
            }
          },
          default: {}
        },
        /**
         * TOG-2481 port of `tier_dispatcher.py`'s `LANE_CAP_PER_ACCOUNT =
         * {"opencode-go": 2, "zai": 3}` (2026-09-06 17:1xZ / 2026-09-07
         * 12:32Z owner rules). Caps the number of ACTIVE (todo/in_progress)
         * cards a lane may hold per healthy account; unset entries have no
         * cap. Defaults to the same two lanes the Python source capped,
         * canonicalized to this deployment's live lane ids.
         */
        laneCapPerAccount: {
          type: "object",
          title: "Per-account active-card cap",
          additionalProperties: { type: "number", minimum: 0 },
          default: { "cliproxy-opencode-go": 2, "cliproxy-zai": 3 }
        },
        /** Named 5h allowance window `lane_5h()` reads; new admission stops at >= 0.5 utilization (2026-09-07 03:15Z: 0.6 -> 0.5). Default matches this deployment's live hyphenated `five-hour` window name. */
        fiveHourWindowName: { type: "string", minLength: 1, default: "five-hour" },
        /** Named weekly allowance window reported in the shadow stream's per-lane snapshot. Reporting only — no gate reads it (the Z.ai weekly gate has its own `zai.weeklyWindowName`). */
        weeklyWindowName: { type: "string", minLength: 1, default: "weekly" },
        /**
         * TOG-2481 port of `tier_dispatcher.py` `pick()`'s Codex/OpenCode-Go
         * fallback rule (2026-09-07 03:15Z owner rule): `codexLaneId` names
         * which configured lane is Codex, so the T1-Go-fallback and Z.ai
         * long-run-agent-exclusion rules know which lane's avoid threshold/
         * utilization to check before routing away from Go/Zai.
         */
        codexLaneId: { type: "string", minLength: 1, default: "cliproxy-codex" },
        /** Names which configured lane is OpenCode Go, for the T1-Go-fallback rule above. */
        opencodeGoLaneId: { type: "string", minLength: 1, default: "cliproxy-opencode-go" },
        /**
         * TOG-2481 port of `zai_peak_now()` / `zai_weekly_pace_ok()`
         * (2026-09-08 13:20Z owner rule). `laneId` names which configured
         * lane is the Z.ai lane so the peak-hour throttle and weekly-pacing
         * gate know which lane to apply to.
         */
        zai: {
          type: "object",
          title: "Z.ai lane pacing",
          additionalProperties: false,
          properties: {
            laneId: { type: "string", minLength: 1, default: "cliproxy-zai" },
            weeklyWindowName: { type: "string", minLength: 1, default: "weekly" },
            weeklyDefaultMargin: { type: "number", minimum: 0, maximum: 1, default: 0.15 }
          },
          default: {}
        }
      },
      default: {}
    },
    /**
     * Ported from `tier_dispatcher.py`'s `classify()`/RUBRIC (TOG-2481). Default
     * OFF: this section being absent, or `enabled: false`, means the plugin
     * writes no tier labels of its own — a company that only ever records tier
     * via explicit pins/labels sees no behavior change from this section
     * existing. This is also the AC3 kill switch: there is deliberately no
     * `~/paperclip-enterprise-company/.tier-dispatcher-disabled` file check
     * anywhere in this plugin, only this config flag.
     */
    classification: {
      type: "object",
      title: "Tier classification (LLM)",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", default: false },
        /**
         * Called directly (mirroring paperclip-model-router's own upstream
         * call), never through model-router's `/invoke` route: the host's
         * `isPrivateIP()` block on `ctx.http.fetch()` makes a same-host
         * `/invoke` hop unreachable from a plugin (TOG-2481 architecture note).
         */
        baseUrl: {
          type: "string",
          minLength: 1,
          pattern: "^https://[^/?#@]+(?:/[^?#]*)?$"
        },
        protocol: {
          type: "string",
          enum: ["anthropic-messages", "openai-chat-completions"],
          default: "anthropic-messages"
        },
        modelId: { type: "string", minLength: 1 },
        apiKeySecretRef: SECRET_REF_SCHEMA,
        requestTimeoutMs: { type: "integer", minimum: 1, default: 15e3 },
        maxResponseBytes: { type: "integer", minimum: 1, default: 65536 },
        /** tier_dispatcher.py truncates the description to this many chars before prompting. */
        descriptionChars: { type: "integer", minimum: 1, default: 1500 },
        maxOutputTokens: { type: "integer", minimum: 1, default: 120 },
        /** `T3` demotes to `T2` below this confidence (tier_dispatcher.py main():386). */
        t3ConfidenceFloor: { type: "number", minimum: 0, maximum: 1, default: 0.7 },
        /** `T2` demotes to `T1` below this confidence (tier_dispatcher.py main():387). */
        t2ConfidenceFloor: { type: "number", minimum: 0, maximum: 1, default: 0.6 },
        /** How many eligible issues one job run classifies. */
        batchSize: { type: "integer", minimum: 1, maximum: 200, default: 20 },
        /**
         * TOG-3200. Re-examine a card whose `tier:*` label this plugin did not
         * write (provenance in `PLUGIN_STATE_KEYS.classifierLabeledIssues`).
         *
         * Defaults TRUE, deliberately: with it false the job is a one-shot
         * stamp that never revisits a card, and on 2026-09-17 that meant 36
         * consecutive runs classifying zero issues while 97% of the board's
         * tier labels were agent self-assessments. A default of false would
         * make the fix inert until somebody wrote a config key, which is the
         * same failure in a new place.
         *
         * Rollback is this one key: set it false and the job returns to its
         * pre-3200 skip-any-tier-label behaviour exactly. A `pin:operator`
         * card is still never touched either way.
         */
        reclassifyForeignLabels: { type: "boolean", default: true }
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
     * TOG-2137 / TOG-2504. Emits paired `host` and `plugin-shadow`
     * `tog2138-decision-v1` JSONL records per `advise()` call to the
     * `shadowDecisions` local folder, for the 48h agreement stream
     * `ops/tog-2138/gate_harness.py` correlates.
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
    },
    /**
     * TOG-2438: aa.ai Intelligence Index sync. A single kill switch — the
     * feed URL and thresholds are code constants, not operator-configurable
     * (this isn't a per-company data source the way pacing lanes are).
     */
    aaSync: {
      type: "object",
      title: "aa.ai ranking sync",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", default: true }
      },
      default: {}
    },
    /**
     * TOG-3996: models.dev price reconciliation. A kill switch and nothing
     * else, for the same reason `aaSync` is — the feed URL and the
     * lane-to-provider map are code constants, because a wrong provider
     * produces a confidently wrong price and that is a code review's
     * question, not a config field's.
     *
     * There is deliberately no `autoApply` option. A price change reorders
     * the whole fleet's routing; this job reports and an operator applies.
     */
    priceSync: {
      type: "object",
      title: "models.dev price reconciliation",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", default: true }
      },
      default: {}
    },
    /**
     * TOG-2481: absorbs the standalone `dispatch` plugin (TOG-747, design
     * TOG-706) so the `plugins` table shows one dispatcher, not two. Mirrors
     * that plugin's `instanceConfigSchema` field-for-field, including its
     * defaults — `wakeEnabled: false` so absorbing it changes nothing live
     * until an operator explicitly flips the wake gate.
     */
    dispatch: {
      type: "object",
      title: "Stall-sweep dispatch (TOG-706/TOG-747)",
      additionalProperties: false,
      properties: {
        wakeEnabled: {
          type: "boolean",
          title: "Enable the wake action",
          description: "OFF until the evidence gate passes. While off, the sweep runs the real selection policy and reports what it WOULD have woken, and calls requestWakeup zero times.",
          default: false
        },
        idleMinutes: {
          type: "number",
          title: "Idle threshold (minutes)",
          description: "How long since the last heartbeat run scoped to that issue before it counts as stalled. Measured against heartbeat_runs.context_snapshot->>'issueId', not updated_at, which any comment refreshes (ADR 0003).",
          default: 120,
          minimum: 5,
          maximum: 10080
        },
        maxWakesPerFiring: {
          type: "number",
          title: "Maximum wakes per firing",
          description: "Cap on selected issues per sweep. Picks are spread across distinct assignees, because host coalescing is per-agent (ADR 0001) and two picks for one agent collapse into one run.",
          default: 3,
          minimum: 1,
          maximum: 25
        },
        focusProjectIds: {
          type: "array",
          title: "Focus project IDs",
          description: "Optional. When set, only issues in these projects are selectable. Empty means the whole company.",
          default: [],
          items: { type: "string" }
        }
      },
      default: {}
    },
    /**
     * TOG-3210. A monitor tick, continuation wake, or label-only pass
     * re-checking an already-tiered card is correctly judged T1 (or T2) by
     * every rubric anchor — the classifier grades the card, not the wake, and
     * that is correct. What is actually cheap is the RE-CHECK, not the card:
     * this section lets a caller-supplied `wakeReason` request a lower
     * required tier for ONE decision without ever touching the card's real
     * `tier:*` label/pin — see `select.ts`'s `SelectionConfig.wakeScopedFloor`
     * for the mechanism (the decision is forced advisory, so it can never be
     * written). One-key rollback, matching the `classification` pattern
     * above: `wakeScopedFloor.enabled: false` restores byte-identical
     * pre-TOG-3210 behavior. Default ON, because — unlike `classification` —
     * this section can never itself cause a write; `wakeReasons` defaults to
     * empty, so it is a no-op until an operator names the actual
     * `PAPERCLIP_WAKE_REASON` values their dispatcher sends for cheap wakes.
     */
    wakeScopedFloor: {
      type: "object",
      title: "Wake-scoped floor (TOG-3210)",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", default: true },
        /** `PAPERCLIP_WAKE_REASON` values treated as a cheap re-check of an already-tiered card. Empty = inert. */
        wakeReasons: {
          type: "array",
          items: { type: "string", minLength: 1 },
          default: []
        },
        /** The lower floor a matching wake reason gets. Only takes effect below the card's judged tier — never raises it. */
        floorTier: { type: "string", enum: [...TIERS], default: "T3" }
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
    // TOG-2481 absorption of the standalone `dispatch` plugin (TOG-747/TOG-706):
    // the stall-sweep reads blocker relations and the orchestration summary
    // (which mirrors the server's own budget-invocation-block verdict, see
    // dispatch-selection.ts's BUDGET_RAIL_MIRROR_SOURCE), and wakes a stalled
    // issue's existing run. Declared even though `dispatch.wakeEnabled`
    // defaults to false, matching the standalone plugin's own manifest.
    "issue.relations.read",
    "issues.orchestration.read",
    "issues.wakeup",
    // TOG-2572: the sweep must not wake a card that has its own monitor
    // wake scheduled (`monitorNextCheckAt`, read straight off the `Issue`
    // rows `issues.list` already returns) or a pending human-only ask —
    // neither of those is on `PluginIssueOrchestrationSummary`, so a
    // separate per-issue interaction read is required.
    "issue.interactions.read",
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
    // "agents" added for TOG-2481's classification job (join issues -> agents
    // to read the assignee's role/name for the classification prompt).
    coreReadTables: ["heartbeat_runs", "issues", "issue_comments", "issue_relations", "agents"]
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
    },
    {
      jobKey: JOB_KEYS.refreshAaIndex,
      displayName: "Refresh aa.ai Intelligence Index",
      description: "Refresh the aa.ai leaderboard snapshot and log per-model index changes. A change that crosses a tier boundary is surfaced via the activity log as a prompt to re-evaluate \u2014 never applied automatically. A fetch/parse failure keeps the prior snapshot and records the failed attempt (TOG-2438). Every-6h cadence matches refreshScores's family (TOG-2438 reopen AC4) \u2014 aa.ai moves faster than a daily check surfaced.",
      schedule: "53 */6 * * *"
    },
    {
      jobKey: JOB_KEYS.reconcilePrices,
      displayName: "Reconcile roster prices against models.dev",
      description: "Fetch models.dev's catalogue and compare every roster row's $/Mtok against the list price its LANE's provider publishes. Reports drift to the activity log and stores the diff for an operator to approve \u2014 it never writes a price. A 2026-09-22 hand audit found 26 of 117 rows wrong, five of them priced 0/0/0, so this exists to make the next drift visible within a day instead of at the next audit. Daily, not 6-hourly: vendor list prices change on the order of months, and the feed is 4.8 MB.",
      schedule: "41 5 * * *"
    },
    {
      jobKey: JOB_KEYS.classifyIssues,
      displayName: "Classify unlabeled issues",
      description: "Ported from tier_dispatcher.py main(): classify open, unlabeled, agent-assigned issues with the RUBRIC and write a tier:* label. Off by default (classification.enabled=false) \u2014 the AC3 kill switch for TOG-2481.",
      schedule: "*/10 * * * *"
    },
    {
      jobKey: JOB_KEYS.labelOnlyPass,
      displayName: "Pin from an existing tier label",
      description: "Ported from tier_dispatcher.py label_only_pass(): pin issues that already carry a tier:* label (e.g. inherited from a cloned card) but no override, without re-classifying.",
      schedule: "*/10 * * * *"
    },
    {
      jobKey: JOB_KEYS.repinPass,
      displayName: "Re-pin off an unusable or demoted model",
      description: "Ported from tier_dispatcher.py repin_pass(): idle issues pinned to a model whose lane is now unusable, or that has been measurably demoted for their tier, get re-pinned within the same tier.",
      schedule: "*/10 * * * *"
    },
    {
      jobKey: JOB_KEYS.balancePass,
      displayName: "Balance pinned and formerly-excluded issues",
      description: "Ported from tier_dispatcher.py balance_pass(): give unpinned+labelled cards a balanced T1-class pin, and re-pin cards whose pinned model has gone cost-down-eligible, incapable/on-probation/over-cap, or whose lane is far busier than another usable lane.",
      schedule: "*/10 * * * *"
    },
    {
      jobKey: JOB_KEYS.dispatchSweep,
      displayName: "Stall-sweep dispatch",
      description: "TOG-2481 absorption of the standalone dispatch plugin (TOG-747/TOG-706): finds stalled, wakeable issues and requests a wake, spread across distinct assignees. Report-only until dispatch.wakeEnabled is set \u2014 same cadence and same default as the plugin it replaces.",
      schedule: "*/30 * * * *"
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
      description: "Report which agents' ancillary model pins (ANTHROPIC_SMALL_FAST_MODEL, CLAUDE_CODE_SUBAGENT_MODEL, every ANTHROPIC_DEFAULT_* env var) disagree with the lane-aware T3 recommendation, and who must act on each surface. Read-only; there is no write path from this plugin to any of these surfaces.",
      parametersSchema: { type: "object", additionalProperties: false, properties: {} }
    },
    {
      name: TOOL_NAMES.aaDriftReport,
      displayName: "aa.ai drift report",
      description: "Per-model aa.ai Intelligence Index: the roster's configured value and snapshot date, alongside the latest fetched live value and whether it now implies a different tier. Read-only; writes nothing.",
      parametersSchema: { type: "object" }
    },
    {
      name: TOOL_NAMES.refreshAaIndexNow,
      displayName: "Refresh aa.ai Intelligence Index now",
      description: "Manually run the aa.ai leaderboard fetch + drift-surfacing sweep instead of waiting for the next scheduled tick. Same logic as the cron job: never writes tier/enabled, only updates the snapshot and logs drift.",
      parametersSchema: { type: "object" }
    },
    {
      name: TOOL_NAMES.priceDriftReport,
      displayName: "models.dev price drift report",
      description: "The latest roster-vs-models.dev price reconciliation: which rows are mispriced, by how much, and the exact note clause to record if the correction is approved. Read-only; writes nothing. List prices \u2014 correct for relative cost ordering, not what the company actually pays on a flat plan.",
      parametersSchema: { type: "object" }
    },
    {
      name: TOOL_NAMES.reconcilePricesNow,
      displayName: "Reconcile roster prices against models.dev now",
      description: "Run the models.dev fetch + price reconciliation immediately instead of waiting for the daily tick. Same logic as the cron job, and just as report-only: it never writes a roster price.",
      parametersSchema: { type: "object" }
    },
    {
      name: TOOL_NAMES.setLaneOutage,
      displayName: "Declare or clear a lane outage",
      description: "TOG-2481 port of lane_outage.json: declare a telemetry-invisible outage on named lanes/models until an ISO timestamp, or clear it by omitting both lanes and models.",
      parametersSchema: {
        type: "object",
        required: ["until"],
        properties: {
          lanes: { type: "array", items: { type: "string" } },
          models: { type: "array", items: { type: "string" } },
          until: { type: "string", minLength: 1 },
          reason: { type: "string" }
        }
      }
    },
    {
      name: TOOL_NAMES.setZaiPaceOverride,
      displayName: "Set or clear the Z.ai weekly-pace margin override",
      description: "TOG-2481 port of zai_pace_override.json: temporarily widen (or tighten) the margin zaiWeeklyPaceOk allows above elapsed-week fraction, e.g. during a Codex outage. Clear by omitting margin.",
      parametersSchema: {
        type: "object",
        required: ["until"],
        properties: {
          margin: { type: "number", minimum: 0, maximum: 1 },
          until: { type: "string" }
        }
      }
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
