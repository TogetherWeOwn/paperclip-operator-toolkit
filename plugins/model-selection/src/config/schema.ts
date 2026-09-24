import {
  DEFAULT_PACE_ACCOUNT_KEY_FIELDS,
  DEFAULT_PACE_WEIGHT_FIELDS,
  PACING_MODES,
  TIERS,
} from "../constants.js";
import { EFFORT_LADDER } from "../engine/effort.js";

const MODEL_CAPABILITIES = ["tools", "structured-output", "vision", "long-context", "computer-use"];

/** Mirrors paperclip-model-router's `SECRET_REF_SCHEMA` (TOG-2379). */
const SECRET_REF_SCHEMA = {
  type: ["object", "null"],
  format: "secret-ref",
  additionalProperties: false,
  required: ["type", "secretId"],
  properties: {
    type: { const: "secret_ref" },
    secretId: { type: "string", format: "uuid" },
    version: { oneOf: [{ const: "latest" }, { type: "integer", minimum: 1 }] },
    projectionClass: { type: "string", enum: ["unclassified", "class_3_static_lease"] },
    projectionAllowlistKey: { type: ["string", "null"] },
  },
  default: null,
} as const;

/**
 * Company-scoped config. Every number that decides anything lives here, so the
 * same input gives the same output on every run — none of it is re-improvised
 * per invocation.
 */
export const SELECTION_CONFIG_SCHEMA = {
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
        fleetContextCeilingTokens: { type: "integer", minimum: 1, default: 1000000 },
        /** Fraction of a narrower model's context window where Claude Code should compact. */
        compactionRatio: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1, default: 0.75 },
      },
      default: {},
    },
    models: {
      type: "array",
      title: "Model table",
      description:
        "Models this company will run a harness on. Rates are $/Mtok recovered from our own heartbeat_runs, not vendor list prices.",
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
            default: [],
          },
          contextWindow: { type: "integer", minimum: 1, default: 200000 },
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
          effort: { type: "string", enum: [...EFFORT_LADDER] },
        },
      },
      default: [],
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
        TIERS.map((tier) => [tier, { type: "string", minLength: 1 }]),
      ),
      default: {},
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
        maxAgeDays: { type: "integer", minimum: 1, maximum: 90, default: 14 },
      },
      default: {},
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
        silentFailureWeight: { type: "integer", minimum: 1, default: 10 },
      },
      default: {},
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
                pattern: "^https://[^/?#@]+(?:/[^?#]*)?$",
              },
              requestTimeoutMs: { type: "integer", minimum: 1, default: 5000 },
              maxResponseBytes: { type: "integer", minimum: 1, default: 262144 },
              /** TOG-2379: resolved via `ctx.secrets.resolve()` and sent as `X-Api-Key` before each poll. */
              apiKeySecretRef: SECRET_REF_SCHEMA,
              /** True for a lane with no consumption ceiling — always serviceable, pace state `free`. */
              free: { type: "boolean", default: false },
              healthFields: {
                type: "array",
                items: { type: "string", minLength: 1 },
                default: ["health", "status"],
              },
              accountKeyFields: {
                type: "array",
                minItems: 1,
                items: { type: "string", minLength: 1 },
                default: [...DEFAULT_PACE_ACCOUNT_KEY_FIELDS],
              },
              weightFields: {
                type: "array",
                minItems: 1,
                items: { type: "string", minLength: 1 },
                default: [...DEFAULT_PACE_WEIGHT_FIELDS],
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
                      items: { type: "string", minLength: 1 },
                    },
                    resetFields: {
                      type: "array",
                      items: { type: "string", minLength: 1 },
                      default: [],
                    },
                    defaultWindowSeconds: { type: "integer", minimum: 1 },
                  },
                },
              },
              /** Overrides the pace engine's default margin/urgent-reset/staleness policy for this lane. */
              margin: { type: "number", minimum: 0, maximum: 1 },
              urgentResetSeconds: { type: "integer", minimum: 1 },
              maxSnapshotAgeSeconds: { type: "integer", minimum: 1 },
            },
          },
          default: [],
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
              default: { "cliproxy-codex": 0.99 },
            },
          },
          default: {},
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
          default: { "cliproxy-opencode-go": 2, "cliproxy-zai": 3 },
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
            weeklyDefaultMargin: { type: "number", minimum: 0, maximum: 1, default: 0.15 },
          },
          default: {},
        },
      },
      default: {},
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
          pattern: "^https://[^/?#@]+(?:/[^?#]*)?$",
        },
        protocol: {
          type: "string",
          enum: ["anthropic-messages", "openai-chat-completions"],
          default: "anthropic-messages",
        },
        modelId: { type: "string", minLength: 1 },
        apiKeySecretRef: SECRET_REF_SCHEMA,
        requestTimeoutMs: { type: "integer", minimum: 1, default: 15000 },
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
        reclassifyForeignLabels: { type: "boolean", default: true },
      },
      default: {},
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
          default: ["research", "review"],
        },
        stopOnFirstNFailures: { type: "integer", minimum: 1, default: 2 },
        stopWindow: { type: "integer", minimum: 1, default: 8 },
      },
      default: {},
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
        maxRecords: { type: "integer", minimum: 1, default: 5000 },
      },
      default: {},
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
        enabled: { type: "boolean", default: true },
      },
      default: {},
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
        enabled: { type: "boolean", default: true },
      },
      default: {},
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
          description:
            "OFF until the evidence gate passes. While off, the sweep runs the real selection policy and reports what it WOULD have woken, and calls requestWakeup zero times.",
          default: false,
        },
        idleMinutes: {
          type: "number",
          title: "Idle threshold (minutes)",
          description:
            "How long since the last heartbeat run scoped to that issue before it counts as stalled. Measured against heartbeat_runs.context_snapshot->>'issueId', not updated_at, which any comment refreshes (ADR 0003).",
          default: 120,
          minimum: 5,
          maximum: 10080,
        },
        maxWakesPerFiring: {
          type: "number",
          title: "Maximum wakes per firing",
          description:
            "Cap on selected issues per sweep. Picks are spread across distinct assignees, because host coalescing is per-agent (ADR 0001) and two picks for one agent collapse into one run.",
          default: 3,
          minimum: 1,
          maximum: 25,
        },
        focusProjectIds: {
          type: "array",
          title: "Focus project IDs",
          description:
            "Optional. When set, only issues in these projects are selectable. Empty means the whole company.",
          default: [],
          items: { type: "string" },
        },
      },
      default: {},
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
          default: [],
        },
        /** The lower floor a matching wake reason gets. Only takes effect below the card's judged tier — never raises it. */
        floorTier: { type: "string", enum: [...TIERS], default: "T3" },
      },
      default: {},
    },
  },
} as const;
