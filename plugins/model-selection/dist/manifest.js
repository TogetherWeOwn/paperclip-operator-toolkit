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
  /** TOG-12206 P2: the last free-list sync diff (verified/broken/ambiguous/unbound), as an operator-reviewable report. Read-only. */
  aaFreeSyncReport: "model_selection_aa_free_sync_report",
  /** TOG-12206 P2: run the free-list fetch + diff immediately instead of waiting for the daily tick. Still report-only. */
  refreshAaFreeSyncNow: "model_selection_refresh_aa_free_sync_now",
  /** TOG-12972: the first-party accepted-work posterior overlay, as an operator-reviewable report. Read-only. */
  acceptedWorkReport: "model_selection_accepted_work_report",
  /**
   * TOG-4959. Per-tier lane-poll outcome counters. Read-only: the
   * `pollLaneCapacity` job increments, this tool reads back.
   */
  tierOutcomes: "model_selection_tier_outcomes",
  /** Read the last explicitly enabled account shadow snapshot; never actuates. */
  admissionShadowReport: "model_selection_admission_shadow_report",
  /** TOG-2481 port of `lane_outage.json`: declare or clear a telemetry-invisible lane outage. */
  setLaneOutage: "model_selection_set_lane_outage",
  /** TOG-2481 port of `zai_pace_override()` / `zai_pace_override.json`. */
  setZaiPaceOverride: "model_selection_set_zai_pace_override",
  /**
   * TOG-12490 (TOG-11543 P2, TOG-11549 D4). Add, edit, remove, validate or diff
   * tier-policy tiers. Prepare/validate/diff only: returns `proposalOnly` or
   * `rejected`, never writes state or config, never changes routing.
   */
  tierPolicy: "model_selection_tier_policy"
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
  /** TOG-12206 P2: fetch the free AA legacy list (quota-gated) and store the CAS snapshot + per-company reviewable diff. Never writes pins/tiers/enabled. */
  refreshAaFreeSync: "refreshAaFreeSync",
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
  /** TOG-11793: warm the run-scoped decision's hot snapshot once a minute. */
  refreshRunResolve: "refreshRunResolveSnapshot"
};
var TIERS = ["T1", "T2", "T3"];
var TIER_ORDER = ["T3", "T2", "T1"];
var NO_ELIGIBLE_NOTICE_THROTTLE_MS = 60 * 60 * 1e3;
var AA_FREE_FETCH_INTERVAL_MS = 24 * 60 * 60 * 1e3;
var AA_FREE_RETRY_INTERVAL_MS = 60 * 60 * 1e3;
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
var SCORE_THRESHOLDS = { T1: 0.85, T2: 0.8, T3: 0.75 };
var SCORE_PRIOR_K = 6;
var SCORE_PROVEN_N = 8;
var REOPEN_WINDOW_MS = 72 * 60 * 60 * 1e3;
var REJECTION_WINDOW_MS = 48 * 60 * 60 * 1e3;
var CLASSIFY_JOB_BUDGET_MS = 200 * 1e3;
var CLASSIFY_ROW_TIMEOUT_MS = 30 * 1e3;
var LABEL_ONLY_PASS_JOB_BUDGET_MS = 200 * 1e3;
var LABEL_ONLY_PASS_ROW_TIMEOUT_MS = 30 * 1e3;
var REPIN_PASS_JOB_BUDGET_MS = 200 * 1e3;
var REPIN_PASS_ROW_TIMEOUT_MS = 30 * 1e3;
var PIN_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
var BALANCE_PASS_JOB_BUDGET_MS = 200 * 1e3;
var BALANCE_PASS_ROW_TIMEOUT_MS = 30 * 1e3;
var DISPATCH_SWEEP_JOB_BUDGET_MS = 4 * 60 * 1e3;

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
        contextRunLogRoot: {
          type: "string",
          minLength: 1,
          description: "Operator-verified absolute local run-log root. Unset or unreadable logs use the labelled fleet-ceiling fallback; no run totals are used as peaks."
        },
        /**
         * TOG-11642. The agent-level context cap the per-pin
         * `CLAUDE_CODE_MAX_CONTEXT_TOKENS` stamp compares against. Split from
         * `fleetContextCeilingTokens` (the admission ceiling, held at 200k for
         * glm-5.3): a pin stamps
         * `max(floor(window*ratio), min(window, 250000))` when its window is
         * below THIS cap and inherits the agent env otherwise. Unset resolves
         * to the fleet ceiling, so behaviour is unchanged until the operator
         * sets it (1M to release Muse's 1,048,576 window).
         */
        agentEnvContextTokens: { type: "integer", minimum: 1, default: 1e6 },
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
         * excluded from NEW admission only when its governing pace deviation
         * also exceeds the pace engine's default 0.1 margin —
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
        /**
         * TOG-13566. Legacy single-file cap, kept for read compatibility with
         * an existing `decisions.jsonl`. New writes go to hourly shards (see
         * `shardMaxRecords`); this number no longer sizes any write.
         */
        maxRecords: { type: "integer", minimum: 1, default: 5e3 },
        /**
         * TOG-13566. Each hourly shard file is rewritten whole on every
         * append; this caps a shard by dropping its oldest records. Small on
         * purpose: the whole-file atomic rewrite that timed out at 30 s on a
         * ~38 MB single file stays a kilobyte-scale RPC payload per shard.
         */
        shardMaxRecords: { type: "integer", minimum: 2, default: 200 },
        /**
         * TOG-13566. How many newest hourly shard files to keep. Whole old
         * shards are deleted past this count. 48 covers the 48-hour agreement
         * stream the gate harness correlates.
         */
        retentionShards: { type: "integer", minimum: 1, default: 48 }
      },
      default: {}
    },
    accountAdmissionShadow: {
      type: "object",
      title: "Account admission shadow report (never enforces)",
      additionalProperties: false,
      properties: { enabled: { type: "boolean", default: false } },
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
     * TOG-12206 P2: free-list sync/discovery/shadow. Default OFF — an absent
     * section, or `enabled: false`, leaves dispatch byte-for-byte identical
     * to today (no fetch, no snapshot, no evidence). Bindings are curated
     * model x effective-effort rows (see `aa-free/sync.ts verifyBindings`);
     * the secret ref reuses the existing company `ARTIFICIALANALYSIS_API_KEY`
     * binding resolved at `aaFreeSync.apiKeySecretRef` — never printed,
     * persisted or exported, never substituted.
     */
    aaFreeSync: {
      type: "object",
      title: "aa.ai free-list sync (TOG-12206 P2)",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", default: false },
        apiKeySecretRef: SECRET_REF_SCHEMA,
        bindings: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["candidateId", "modelId", "laneId", "evaluatedEffort", "aaSlug"],
            properties: {
              candidateId: { type: "string", minLength: 1 },
              modelId: { type: "string", minLength: 1 },
              laneId: { type: "string", minLength: 1 },
              evaluatedEffort: { type: "string", minLength: 1 },
              aaSlug: { type: "string", minLength: 1 },
              observationalOnly: { type: "boolean" }
            }
          },
          default: []
        },
        /** Hours a snapshot stays fresh for shadow evidence. Bounded; stale yields no evidence. */
        maxSnapshotAgeHours: { type: "number", minimum: 1, default: 49 }
      },
      default: {}
    },
    /**
     * TOG-12972: first-party accepted-work posterior producer. Default OFF —
     * an absent section, or `enabled: false`, builds no overlay and stores
     * nothing (no fetch, no state change). The producer only folds this
     * company's own closed-card outcomes into a versioned posterior overlay;
     * nothing reads it for routing in this slice.
     */
    acceptedWork: {
      type: "object",
      title: "First-party accepted-work posterior (TOG-12972)",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", default: false }
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
    },
    /**
     * TOG-11793 (TOG-11780 §4.3). Run-scoped model decision. Requires a host
     * built with the `run.model.resolve` hook and a manifest built with
     * `MODEL_SELECTION_RUN_RESOLVE=1`. Off by default: `onResolveRunModel`
     * answers `keep` and every legacy pin path is unchanged. On: each issue run
     * is decided at its start from hot caches, and the creation/assignment
     * pins, `labelOnlyPass`/`balancePass` pin writes and the `repinPass` /
     * `agent.run.failed` re-pins are retired. Tier labels stay.
     */
    runResolve: {
      type: "object",
      title: "Run-scoped model decision (TOG-11793)",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", default: false },
        /** The hot snapshot is refreshed once older than this; stale data is served while it refreshes. */
        snapshotTtlMs: { type: "integer", minimum: 5e3, maximum: 3e5, default: 45e3 },
        /** Longest wait for an already-in-flight classification. Capped at 1000: the hook never starts one. */
        classifierWaitMs: { type: "integer", minimum: 0, maximum: 1e3, default: 1e3 },
        /** `retryAfterMs` carried by a `defer` answer. */
        deferRetryMs: { type: "integer", minimum: 1e3, maximum: 6e4, default: 5e3 }
      },
      default: {}
    }
  }
};

// src/aa-free/sync.ts
var BINDABLE_EFFORTS = /* @__PURE__ */ new Set([...EFFORT_LADDER, "none"]);

// src/lane-capacity/pace.ts
var DEFAULT_URGENT_RESET_SECONDS = 24 * 60 * 60;
var DEFAULT_MAX_SNAPSHOT_AGE_SECONDS = 15 * 60;

// src/engine/cost.ts
var PROFILE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1e3;

// src/aa-free/parse.ts
var AA_FREE_SOURCE = "artificialanalysis.ai/api/v2/data/llms/models";
var AA_FREE_PROFILE = "aa-free-v1";

// src/engine/tier-policy.ts
var TIER_POLICY_SCHEMA_VERSION = 2;
var LEGACY_EVALUATOR_ID = "legacy-model-selection-v1";
var EVIDENCE_V2_EVALUATOR_ID = "evidence-v2";
var CAPABILITY_PRIOR_BINDING = "existing-capability-prior-v1";
var LEGACY_CAPABILITY_PARAMS = Object.freeze({
  /** Pseudo-observations contributed by the prior (posterior weight). */
  priorK: SCORE_PRIOR_K,
  /** Judged runs before a (model, tier) verdict is "proven". */
  provenN: SCORE_PROVEN_N,
  /** A proven model is vetoed when its observed rate is this far under the bar. */
  vetoMargin: 0.1
});
var ALL_AA_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "default",
  "unknown"
];
var DECISION_BINDINGS = Object.freeze({
  "aa-free-v1/intelligence-index": {
    id: "aa-free-v1/intelligence-index",
    kind: "numeric-metric",
    metric: "artificial_analysis_intelligence_index",
    source: AA_FREE_SOURCE,
    publishedVersion: "unknown",
    unit: "index-points"
  },
  [CAPABILITY_PRIOR_BINDING]: {
    id: CAPABILITY_PRIOR_BINDING,
    kind: "capability-predicate",
    metric: null,
    source: null,
    publishedVersion: null,
    unit: null
  }
});
var UNVERSIONED = /* @__PURE__ */ new Set(["", "latest", "unknown"]);
var KNOWN_EFFORTS = new Set(ALL_AA_EFFORTS);
var LEGACY_TIER_IDS = TIER_ORDER;
function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}
function inUnitInterval(v) {
  return isFiniteNumber(v) && v > 0 && v <= 1;
}
function validateRule(rule, path, evaluator, issues) {
  const push = (code, message, at = path) => issues.push({ path: at, code, message });
  if (rule.optionalSourceRule) {
    const o = rule.optionalSourceRule;
    if (!o.source || !o.metric) push("optional-source-incomplete", "optionalSourceRule needs a source and a metric");
    if (typeof o.version !== "string" || UNVERSIONED.has(o.version)) {
      push("unversioned-metric", "optionalSourceRule must pin a metric version", `${path}.optionalSourceRule.version`);
    }
  }
  if (rule.kind === "capability-predicate") {
    if (rule.decisionBinding !== CAPABILITY_PRIOR_BINDING) {
      push("unknown-binding", `capability predicate must bind ${CAPABILITY_PRIOR_BINDING}`);
    }
    if (rule.policyRevision !== evaluator) {
      push("predicate-evaluator-mismatch", `capability predicate names ${rule.policyRevision}, policy runs ${evaluator}`);
    }
    return;
  }
  if (rule.kind !== "numeric-metric") {
    push("unknown-rule-kind", `unknown rule kind ${String(rule.kind)}`);
    return;
  }
  if (typeof rule.version !== "string" || UNVERSIONED.has(rule.version)) {
    push("unversioned-metric", "a numeric rule must pin a metric version (no unversioned comparisons)", `${path}.version`);
  }
  if (rule.operator === "between") {
    const v = rule.value;
    if (!Array.isArray(v) || v.length !== 2 || !v.every(isFiniteNumber) || v[0] > v[1]) {
      push("invalid-value", "between needs a finite [lo, hi] with lo <= hi", `${path}.value`);
    }
  } else if (rule.operator === "gte" || rule.operator === "lte") {
    if (!isFiniteNumber(rule.value)) push("invalid-value", "value must be a finite number", `${path}.value`);
  } else {
    push("unsupported-operator", `unsupported operator ${String(rule.operator)}`, `${path}.operator`);
  }
  if (rule.maxAgeHours !== void 0 && !(isFiniteNumber(rule.maxAgeHours) && rule.maxAgeHours > 0)) {
    push("invalid-ttl", "maxAgeHours must be a positive finite number", `${path}.maxAgeHours`);
  }
  if (rule.onMissing !== "reject" && rule.onMissing !== "legacy") {
    push("invalid-on-missing", "onMissing must be reject or legacy", `${path}.onMissing`);
  }
  const binding = DECISION_BINDINGS[rule.decisionBinding];
  if (!binding) {
    if (!rule.optionalSourceRule) push("unknown-metric", `no decision binding ${rule.decisionBinding} in ${AA_FREE_PROFILE}`);
    return;
  }
  if (binding.kind !== "numeric-metric") {
    push("binding-kind-mismatch", `${binding.id} is not a numeric metric`);
    return;
  }
  if (rule.metric !== binding.metric || rule.source !== binding.source) {
    push("unknown-metric", `${rule.source}/${rule.metric} is not what ${binding.id} binds`);
  }
  if (rule.unit !== binding.unit) push("unsupported-unit", `${binding.id} is measured in ${binding.unit}`, `${path}.unit`);
  if (evaluator === LEGACY_EVALUATOR_ID && !UNVERSIONED.has(binding.publishedVersion ?? "")) {
    push("legacy-numeric-unsupported", `${LEGACY_EVALUATOR_ID} cannot enforce ${binding.id}`);
  }
}
function validateTierPolicy(policy, options = {}) {
  const issues = [];
  const push = (path, code, message) => issues.push({ path, code, message });
  if (policy.schemaVersion !== TIER_POLICY_SCHEMA_VERSION) push("schemaVersion", "unsupported-schema", `schemaVersion must be ${TIER_POLICY_SCHEMA_VERSION}`);
  if (!Number.isInteger(policy.revision) || policy.revision < 1) push("revision", "invalid-revision", "revision must be a positive integer");
  if (policy.decisionProfile !== AA_FREE_PROFILE) push("decisionProfile", "unsupported-profile", `decisionProfile must be ${AA_FREE_PROFILE}`);
  if (policy.optionalRichDecisionWeight !== 0) push("optionalRichDecisionWeight", "optional-rich-weighted", "optional rich data has zero decision weight");
  if (policy.evaluator === EVIDENCE_V2_EVALUATOR_ID) {
    push("evaluator", "evaluator-unavailable", "evidence-v2 is opt-in and not available in this build");
  } else if (policy.evaluator !== LEGACY_EVALUATOR_ID) {
    push("evaluator", "unknown-evaluator", `unknown evaluator ${String(policy.evaluator)}`);
  }
  const tiers = Array.isArray(policy.tiers) ? policy.tiers : [];
  if (tiers.length === 0) push("tiers", "no-tiers", "a policy needs at least one tier");
  const ids = /* @__PURE__ */ new Set();
  const orders = /* @__PURE__ */ new Set();
  tiers.forEach((tier, i) => {
    const at = `tiers[${i}]`;
    if (typeof tier.id !== "string" || tier.id.length === 0) push(`${at}.id`, "invalid-id", "tier id must be a non-empty string");
    if (ids.has(tier.id)) push(`${at}.id`, "duplicate-id", `duplicate tier id ${tier.id}`);
    ids.add(tier.id);
    if (typeof tier.name !== "string" || tier.name.trim().length === 0) push(`${at}.name`, "invalid-name", "tier name must be non-empty");
    if (!Number.isInteger(tier.order)) push(`${at}.order`, "invalid-order", "order must be an integer");
    if (orders.has(tier.order)) push(`${at}.order`, "duplicate-order", `duplicate order ${tier.order}`);
    orders.add(tier.order);
    const rules = tier.entryRules?.all ?? [];
    if (rules.length === 0) push(`${at}.entryRules`, "no-entry-rules", "a tier needs at least one entry rule");
    rules.forEach((rule, r) => validateRule(rule, `${at}.entryRules.all[${r}]`, policy.evaluator, issues));
    if (policy.evaluator === LEGACY_EVALUATOR_ID && !rules.some((r) => r.kind === "capability-predicate")) {
      push(`${at}.entryRules`, "missing-capability-predicate", `${LEGACY_EVALUATOR_ID} admits only through ${CAPABILITY_PRIOR_BINDING}`);
    }
    const efforts = tier.allowedEfforts ?? [];
    if (efforts.length === 0) push(`${at}.allowedEfforts`, "no-efforts", "allowedEfforts must not be empty");
    if (new Set(efforts).size !== efforts.length) push(`${at}.allowedEfforts`, "duplicate-effort", "allowedEfforts has duplicates");
    for (const e of efforts) if (!KNOWN_EFFORTS.has(e)) push(`${at}.allowedEfforts`, "unknown-effort", `unknown effort ${String(e)}`);
    const ev = tier.evidence;
    if (!ev || !["legacy", "prior-only", "posterior-required"].includes(ev.mode)) {
      push(`${at}.evidence.mode`, "invalid-evidence-mode", "unknown evidence mode");
    } else {
      if (!Number.isInteger(ev.minIndependentTasks) || ev.minIndependentTasks < 0) {
        push(`${at}.evidence.minIndependentTasks`, "invalid-sample-gate", "minIndependentTasks must be a non-negative integer");
      }
      if (ev.maxAgeDays !== void 0 && !(isFiniteNumber(ev.maxAgeDays) && ev.maxAgeDays > 0)) {
        push(`${at}.evidence.maxAgeDays`, "invalid-ttl", "maxAgeDays must be a positive finite number");
      }
      if (policy.evaluator === LEGACY_EVALUATOR_ID && (ev.mode !== "legacy" || ev.cohort !== "legacy-model-id")) {
        push(`${at}.evidence`, "evidence-evaluator-mismatch", `${LEGACY_EVALUATOR_ID} uses legacy evidence on the legacy-model-id cohort`);
      }
    }
    if (!inUnitInterval(tier.legacy?.scoreThreshold)) push(`${at}.legacy.scoreThreshold`, "invalid-threshold", "scoreThreshold must be finite in (0, 1]");
    if (!inUnitInterval(tier.legacy?.capabilityThreshold)) {
      push(`${at}.legacy.capabilityThreshold`, "invalid-threshold", "capabilityThreshold must be finite in (0, 1]");
    }
  });
  if (!ids.has(policy.defaultTierId)) push("defaultTierId", "unknown-tier-ref", `default tier ${policy.defaultTierId} does not exist`);
  for (const [taskClass, ref] of Object.entries(policy.taskClassTierRefs ?? {})) {
    if (!ids.has(ref)) push(`taskClassTierRefs.${taskClass}`, "unknown-tier-ref", `task class ${taskClass} names missing tier ${ref}`);
  }
  if (policy.evaluator === LEGACY_EVALUATOR_ID && tiers.length > 0) validateLegacyLadder(tiers, push);
  if (options.previous) validateSTierNotWeakened(options.previous, policy, push);
  return issues;
}
function validateLegacyLadder(tiers, push) {
  const ids = tiers.map((t) => t.id);
  const missing = LEGACY_TIER_IDS.filter((id) => !ids.includes(id));
  const extra = ids.filter((id) => !LEGACY_TIER_IDS.includes(id));
  if (missing.length > 0) push("tiers", "legacy-tier-missing", `${LEGACY_EVALUATOR_ID} needs tiers ${missing.join(", ")}`);
  if (extra.length > 0) push("tiers", "legacy-tier-unknown", `${LEGACY_EVALUATOR_ID} cannot evaluate tiers ${extra.join(", ")}`);
  if (missing.length > 0 || extra.length > 0) return;
  const ascending = [...tiers].sort((a, b) => a.order - b.order).map((t) => t.id);
  if (ascending.join(",") !== LEGACY_TIER_IDS.join(",")) {
    push("tiers", "invalid-tier-order", `order must ascend ${LEGACY_TIER_IDS.join(" < ")}; got ${ascending.join(" < ")}`);
    return;
  }
  const byId = new Map(tiers.map((t) => [t.id, t]));
  for (let i = 1; i < LEGACY_TIER_IDS.length; i++) {
    const lower = byId.get(LEGACY_TIER_IDS[i - 1]);
    const upper = byId.get(LEGACY_TIER_IDS[i]);
    if (!(upper.legacy?.scoreThreshold > lower.legacy?.scoreThreshold)) {
      push(`tiers.${upper.id}.legacy.scoreThreshold`, "overlapping-tiers", `${upper.id} cut must be above ${lower.id} cut`);
    }
    if (!(upper.legacy?.capabilityThreshold >= lower.legacy?.capabilityThreshold)) {
      push(`tiers.${upper.id}.legacy.capabilityThreshold`, "inverted-capability", `${upper.id} capability bar is below ${lower.id}`);
    }
  }
}
function validateSTierNotWeakened(previous, next, push) {
  for (const before of previous.tiers) {
    if (!before.sTier) continue;
    const after = next.tiers.find((t) => t.id === before.id);
    const at = `tiers.${before.id}`;
    if (!after) {
      push(at, "s-tier-weakened", `S-tier ${before.id} cannot be removed`);
      continue;
    }
    if (!after.sTier) push(`${at}.sTier`, "s-tier-weakened", `${before.id} cannot drop its S-tier flag`);
    if (before.fallbackOnly && !after.fallbackOnly) push(`${at}.fallbackOnly`, "s-tier-weakened", `${before.id} must stay fallbackOnly`);
    if (after.legacy.scoreThreshold < before.legacy.scoreThreshold || after.legacy.capabilityThreshold < before.legacy.capabilityThreshold) {
      push(`${at}.legacy`, "s-tier-weakened", `${before.id} thresholds cannot be lowered`);
    }
  }
}
var TierPolicyError = class extends Error {
  constructor(issues) {
    super(`invalid tier policy: ${issues.map((i) => `${i.path}: ${i.code}`).join("; ")}`);
    this.issues = issues;
    this.name = "TierPolicyError";
  }
};
function ruleEnforcement(rule) {
  if (rule.optionalSourceRule) return "not-enforced-in-aa-free-v1";
  if (rule.kind === "capability-predicate") return "enforced";
  if (!DECISION_BINDINGS[rule.decisionBinding]) return "not-enforced-in-aa-free-v1";
  return "not-enforced-version-unknown";
}
function compileTierPolicy(policy, options = {}) {
  const issues = validateTierPolicy(policy, options);
  if (issues.length > 0) throw new TierPolicyError(issues);
  const byId = new Map(policy.tiers.map((t) => [t.id, t]));
  const scoreThresholds = {};
  const capabilityThresholds = {};
  const tierNames = {};
  for (const id of LEGACY_TIER_IDS) {
    const tier = byId.get(id);
    scoreThresholds[id] = tier.legacy.scoreThreshold;
    capabilityThresholds[id] = tier.legacy.capabilityThreshold;
    tierNames[id] = tier.name;
  }
  const rules = [];
  for (const tier of policy.tiers) {
    tier.entryRules.all.forEach((rule, ruleIndex) => {
      const status = ruleEnforcement(rule);
      rules.push({ tierId: tier.id, ruleIndex, status, replacement: status === "enforced" ? null : CAPABILITY_PRIOR_BINDING });
    });
  }
  return Object.freeze({
    revision: policy.revision,
    evaluator: LEGACY_EVALUATOR_ID,
    scoreThresholds: Object.freeze(scoreThresholds),
    capabilityThresholds: Object.freeze(capabilityThresholds),
    capability: LEGACY_CAPABILITY_PARAMS,
    defaultTierId: policy.defaultTierId,
    tierNames: Object.freeze(tierNames),
    rules: Object.freeze(rules)
  });
}
var T1_CAPABILITY_THRESHOLD = 0.8;
function legacyTier(id, name, order, capabilityThreshold) {
  return {
    id,
    name,
    order,
    entryRules: { all: [{ kind: "capability-predicate", decisionBinding: CAPABILITY_PRIOR_BINDING, policyRevision: LEGACY_EVALUATOR_ID }] },
    allowedEfforts: ALL_AA_EFFORTS,
    evidence: { mode: "legacy", minIndependentTasks: 0, cohort: "legacy-model-id" },
    fallbackOnly: false,
    sTier: false,
    legacy: { scoreThreshold: SCORE_THRESHOLDS[id], capabilityThreshold, sourceRevision: "3da20ab13+t1cap080" }
  };
}
var LEGACY_MODEL_SELECTION_V1 = Object.freeze({
  schemaVersion: TIER_POLICY_SCHEMA_VERSION,
  revision: 1,
  evaluator: LEGACY_EVALUATOR_ID,
  decisionProfile: AA_FREE_PROFILE,
  optionalRichDecisionWeight: 0,
  tiers: Object.freeze([
    legacyTier("T3", "T3", 0, SCORE_THRESHOLDS.T3),
    legacyTier("T2", "T2", 1, SCORE_THRESHOLDS.T2),
    legacyTier("T1", "T1", 2, T1_CAPABILITY_THRESHOLD)
  ]),
  defaultTierId: "T1",
  taskClassTierRefs: Object.freeze({}),
  legacyCompatibility: Object.freeze({
    sourceRevision: "3da20ab13",
    servingBuild: "model-selection-0.4.0-main5a9be61-t1cap080",
    servingWorkerSha256: "dde5fe180cc86856d2332a6ee56ff3ea62fedd349c91c1550de8bd8773b3c099",
    rosterSnapshotHash: null,
    baselineDecisionCorpusHash: null
  })
});
var LEGACY_TIER_POLICY = compileTierPolicy(LEGACY_MODEL_SELECTION_V1);

// src/engine/scores.ts
var TIER_ORDER_BY_CAPABILITY_DESC = [...TIER_ORDER].reverse();

// src/engine/context.ts
var CONTEXT_LIMIT_ENV_KEY = "CLAUDE_CODE_MAX_CONTEXT_TOKENS";
var ANCILLARY_MODEL_ENV_KEYS = [
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL"
];
var PIN_LANE_MODEL_ENV_KEYS = [
  "PAPERCLIP_ASSIGNED_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL"
];
var ALL_MODEL_ENV_KEYS = [
  ...PIN_LANE_MODEL_ENV_KEYS,
  ...ANCILLARY_MODEL_ENV_KEYS
];

// src/engine/run-resolve.ts
var RUN_RESOLVE_ENV_KEYS = [
  CONTEXT_LIMIT_ENV_KEY,
  ...PIN_LANE_MODEL_ENV_KEYS,
  ...ANCILLARY_MODEL_ENV_KEYS
];

// src/tier-policy-tool.ts
var TIER_POLICY_ACTIONS = ["add", "edit", "remove", "validate", "diff"];
var EDITABLE_TIER_FIELDS = [
  "name",
  "order",
  "entryRules",
  "allowedEfforts",
  "evidence",
  "fallbackOnly",
  "sTier",
  "legacy"
];
var TIER_POLICY_TOOL_DISPLAY_NAME = "Tier policy: add, edit, remove, validate, diff";
var TIER_POLICY_TOOL_DESCRIPTION = "Prepare a tier-policy change as data (TOG-11549 D4): add, edit (name, order, entry rules, efforts, evidence, fallbackOnly/sTier, legacy thresholds) or remove a tier, or validate/diff a candidate policy. add/edit/remove need expectedRevision (must equal the base revision) and a reason. Returns proposalOnly or rejected with issues, a diff keyed by tier id, the dry-run impact and an audit id. Prepare/validate/diff only: writes nothing and never changes routing; the base is the built-in active policy unless basePolicy is supplied.";
var TIER_POLICY_TOOL_PARAMETERS = {
  type: "object",
  required: ["action"],
  properties: {
    action: { type: "string", enum: [...TIER_POLICY_ACTIONS] },
    expectedRevision: { type: "integer", minimum: 1, description: "Compare-and-set: must equal the base policy revision." },
    reason: { type: "string", description: "Why the change is wanted; required for add/edit/remove." },
    dryRun: { type: "boolean", description: "Defaults to true. This build never persists either way." },
    tierId: { type: "string", description: "The tier to edit or remove." },
    tier: { type: "object", description: "add: the full tier definition." },
    patch: {
      type: "object",
      description: `edit: fields to change, any of ${EDITABLE_TIER_FIELDS.join(", ")}; legacy and evidence merge shallowly.`
    },
    policy: { type: "object", description: "validate/diff: a full candidate policy at the next revision." },
    basePolicy: { type: "object", description: "Optional base to edit instead of the built-in active policy." }
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
    requiredContextTokens: { type: "integer", minimum: 1 },
    admissionShadow: {
      type: "object",
      description: "Optional non-secret account/window snapshot. Only evaluated when accountAdmissionShadow.enabled is true; never changes the decision or applies admission."
    }
  }
};
var baseManifest = {
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
      description: "Poll operator-configured lane-capacity status URLs and refresh the pace ledger. TOG-8108: every 2 minutes, inside the tightest publisher-declared freshness budget (180s live) \u2014 at 5 minutes, picks older than 180s read every lane UNKNOWN ~half the time. Pace's own freshness budget is on the order of minutes, so this runs far more often than the volume-profile refresh.",
      schedule: "*/2 * * * *"
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
      jobKey: JOB_KEYS.refreshAaFreeSync,
      displayName: "Refresh aa.ai free-list sync",
      description: "Fetch the official aa.ai FREE-tier legacy list (at most once a day; 429 honors Retry-After; 401/403 stops the source) and store the CAS snapshot plus a per-company reviewable diff of curated model x effort bindings. Report-only: it never writes a binding, pin, tier, or price. Off unless a company enables aaFreeSync.",
      schedule: "23 6 * * *"
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
    },
    {
      jobKey: JOB_KEYS.refreshRunResolve,
      displayName: "Warm the run-scoped decision snapshot",
      description: "TOG-11793: reload the hot caches (volume profiles, lane ledger, scores, availability, lane evidence, live lane weights) the run-scoped model decision reads, so the decision path never loads them inline. Reads only; a no-op for a company that has not enabled runResolve.",
      schedule: "* * * * *"
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
      name: TOOL_NAMES.admissionShadowReport,
      displayName: "Account admission shadow report",
      description: "Read the last opt-in bounded account admission shadow snapshot. No reservations, host start coverage or served-account proof; never invokes selection or actuation.",
      parametersSchema: { type: "object", additionalProperties: false }
    },
    {
      name: TOOL_NAMES.aaFreeSyncReport,
      displayName: "aa.ai free-list sync report",
      description: "The last free-list sync diff: which curated model x effort bindings verify against the snapshot, which break and why, which slugs are ambiguous, and which roster rows have no binding. Read-only; writes nothing.",
      parametersSchema: { type: "object" }
    },
    {
      name: TOOL_NAMES.refreshAaFreeSyncNow,
      displayName: "Refresh aa.ai free-list sync now",
      description: "Run the free-list fetch + per-company diff immediately instead of waiting for the daily tick. Same logic as the cron job, and just as report-only: it never writes a binding, pin, tier, or price.",
      parametersSchema: { type: "object" }
    },
    {
      name: TOOL_NAMES.tierOutcomes,
      displayName: "Tier poll outcomes",
      description: "Per-tier lane-poll success/fail counters: how many polls each tier's lanes served or missed. Read-only; writes nothing and never changes selection.",
      parametersSchema: { type: "object" }
    },
    {
      name: TOOL_NAMES.acceptedWorkReport,
      displayName: "Accepted-work posterior report",
      description: "Per-cohort accepted-work posteriors: which served model x effort x task-class cohorts have mature accept/rework evidence, and what each cohort's posterior is. Read-only; writes nothing and never changes selection.",
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
    },
    {
      name: TOOL_NAMES.tierPolicy,
      displayName: TIER_POLICY_TOOL_DISPLAY_NAME,
      description: TIER_POLICY_TOOL_DESCRIPTION,
      parametersSchema: TIER_POLICY_TOOL_PARAMETERS
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
var RUN_MODEL_RESOLVE_CAPABILITY = "run.model.resolve";
var RUN_RESOLVE_IN_MANIFEST = true ? false : process.env.MODEL_SELECTION_RUN_RESOLVE === "1";
function buildManifest(runResolve) {
  if (!runResolve) return baseManifest;
  return {
    ...baseManifest,
    capabilities: [...baseManifest.capabilities, RUN_MODEL_RESOLVE_CAPABILITY],
    modelRouting: { envKeys: [...RUN_RESOLVE_ENV_KEYS] }
  };
}
var manifest = buildManifest(RUN_RESOLVE_IN_MANIFEST);
var manifest_default = manifest;
export {
  RUN_MODEL_RESOLVE_CAPABILITY,
  RUN_RESOLVE_IN_MANIFEST,
  buildManifest,
  manifest_default as default
};
//# sourceMappingURL=manifest.js.map
