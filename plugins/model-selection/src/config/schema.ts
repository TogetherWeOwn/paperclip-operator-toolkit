import { PACING_MODES, TIERS } from "../constants.js";

const MODEL_CAPABILITIES = ["tools", "structured-output", "vision", "long-context", "computer-use"];

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
        /**
         * Which cost term orders candidates. `list-price` (default) is the
         * existing `expectedCostUsd` sort, byte-for-byte unchanged.
         * `cost-per-accepted-card` is Slice 3 (TOG-2048 decision A) — computed
         * and shadow-diffed for 7 days before this ever flips in a live config.
         */
        objective: { type: "string", enum: ["list-price", "cost-per-accepted-card"], default: "list-price" },
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
              /** True for a lane with no consumption ceiling — always serviceable, pace state `free`. */
              free: { type: "boolean", default: false },
              healthFields: {
                type: "array",
                items: { type: "string", minLength: 1 },
                default: ["health", "status"],
              },
              weightFields: {
                type: "array",
                items: { type: "string", minLength: 1 },
                default: ["weight"],
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
  },
} as const;
