import { isAbsolute } from "node:path";

import {
  DEFAULT_AVOID_PER_LANE,
  DEFAULT_FIVE_HOUR_WINDOW_NAME,
  DEFAULT_IDLE_REPIN_HYSTERESIS_SECONDS,
  DEFAULT_LANE_CAP_PER_ACCOUNT,
  DEFAULT_OPERATOR_OVERRIDE_TTL_SECONDS,
  DEFAULT_PACE_ACCOUNT_KEY_FIELDS,
  DEFAULT_PACE_WEIGHT_FIELDS,
  DEFAULT_SLOT_FLOOR_FRACTION,
  DEFAULT_WEEKLY_WINDOW_NAME,
  DEFAULT_ZAI_WEEKLY_MARGIN,
  DEFAULT_ZAI_WEEKLY_WINDOW_NAME,
  LANE_ID_CODEX,
  LANE_ID_OPENCODE_GO,
  LANE_ID_ZAI,
  PACING_MODES,
  TIER_LABEL_PREFIX,
  TIER_ORDER,
  TIERS,
  isImplicitlyAdmittedTier,
  type PacingMode,
  type Tier,
} from "../constants.js";
import { validateSecretRefShape } from "./secret-ref.js";
import { resolveFormatCompatibility, type FormatCompatibility } from "../format-compatibility.js";
import type { ModelEntry } from "../engine/types.js";
import type { LanePaceDefinition, PaceWindowDefinition, PacePolicy } from "../lane-capacity/pace.js";

/** Mirrors paperclip-model-router's `SecretRef`. */
export interface SecretRef {
  type: "secret_ref";
  secretId: string;
  version?: "latest" | number;
  projectionClass?: "unclassified" | "class_3_static_lease";
  projectionAllowlistKey?: string | null;
}

export interface LaneSourceConfig {
  laneId: string;
  statusUrl: string;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  lane: LanePaceDefinition;
  policy: PacePolicy;
  /** : resolved via `ctx.secrets.resolve()` before each poll, sent as `X-Api-Key`. Null for an unauthenticated lane. */
  apiKeySecretRef: SecretRef | null;
  /** Read this lane straight from CLIProxy `/v0/management/auth-files` quota signals. */
  authFilesProvider: "claude" | "codex" | null;
  /**
   * Plan allowance weights by account key for an auth-files lane. The
   * response carries no plan sizes, so the operator maps each account key
   * (auth index) to its plan weight here. Null when the lane is not an
   * auth-files lane or no mapping is configured.
   */
  planWeights: Record<string, number> | null;
  /**
   * . Combined utilization (0-1] at or above which the lane is
   * withdrawn from NEW dispatch. Omitted (the default) never withdraws.
   */
  withdrawAtUtilization?: number;
}

export type SelectionObjective = "list-price" | "cost-per-accepted-card";

export type ClassificationProtocol = "anthropic-messages" | "openai-chat-completions";

export interface ClassificationConfig {
  enabled: boolean;
  baseUrl: string | null;
  protocol: ClassificationProtocol;
  modelId: string | null;
  apiKeySecretRef: SecretRef | null;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  descriptionChars: number;
  maxOutputTokens: number;
  t3ConfidenceFloor: number;
  t2ConfidenceFloor: number;
  batchSize: number;
  /** : re-examine a `tier:*` label this plugin did not write. Defaults on. */
  reclassifyForeignLabels: boolean;
}

export interface ResolvedConfig {
  selection: {
    enabled: boolean;
    mode: "advise" | "enforce";
    defaultTier: Tier;
    stickyModelWithinIssue: boolean;
    holdOnUntrustedProfile: boolean;
    /** : exclude a model whose lane availability is UNKNOWN, rather than recording it and proceeding. */
    holdOnUnknownAvailability: boolean;
    objective: SelectionObjective;
    fleetContextCeilingTokens: number;
    /** Operator-verified local run-log root; absent means honest fleet fallback. */
    contextRunLogRoot: string | null;
    /** : agent-level cap for the per-pin env stamp. Unset resolves to the fleet ceiling. */
    agentEnvContextTokens: number;
    compactionRatio: number;
    /** Agent ids the router never routes (`selection.exemptAgentIds`). Empty exempts nobody. */
    exemptAgentIds: string[];
  };
  models: ModelEntry[];
  /**
   * Operator-supplied label ids per tier. Partial by design: a tier with no id
   * simply gets no label written. See the schema for why these cannot be looked
   * up by name.
   */
  tierLabelIds: Partial<Record<Tier, string>>;
  /** , Defect 2. Label id for `operator`, applied to escalation issues. Optional. */
  operatorLabelId: string | null;
  profiles: { windowDays: number; minSamples: number; maxAgeDays: number };
  quality: { t1EscalationCeiling: number; t2EscalationCeiling: number; silentFailureWeight: number };
  pacing: {
    mode: PacingMode;
    lanes: LaneSourceConfig[];
    slotFloorFraction: number;
    operatorOverrideTtlSeconds: number;
    idleRepinHysteresisSeconds: number;
    /**  port of `AVOID`/`AVOID_LANE`. */
    avoid: { defaultThreshold: number; perLane: Record<string, number>; withdrawAt?: Record<string, number> };
    /**  port of `LANE_CAP_PER_ACCOUNT`. */
    laneCapPerAccount: Record<string, number>;
    /**  port of `lane_5h()`'s hardcoded 5h JSON key, and its >= 0.5 new-admission stop. */
    fiveHourWindowName: string;
    /** Named weekly allowance window reported in the shadow stream's per-lane snapshot (reporting only). */
    weeklyWindowName: string;
    /** Which configured lane is Codex, for the T1-Go-fallback / Z.ai long-run-agent-exclusion rules. */
    codexLaneId: string;
    /** Which configured lane is OpenCode Go, for the T1-Go-fallback rule. */
    opencodeGoLaneId: string;
    zai: {
      laneId: string;
      weeklyWindowName: string;
      weeklyDefaultMargin: number;
    };
  };
  classification: ClassificationConfig;
  earnIn: {
    enabled: boolean;
    perModelPerWeek: number;
    maxActivePerModel: number;
    maxActivePerLane: number;
    classes: readonly string[];
    stopOnFirstNFailures: number;
    stopWindow: number;
  };
  shadowEmit: { enabled: boolean; maxRecords: number; shardMaxRecords: number; retentionShards: number };
  formatCompatibility?: FormatCompatibility;
  accountAdmissionShadow: { enabled: boolean };
  aaSync: { enabled: boolean };
  /**  P2: default-off free-list sync. Absent/disabled = legacy behavior exactly. */
  aaFreeSync: {
    enabled: boolean;
    apiKeySecretRef: SecretRef | null;
    bindings: Array<{
      candidateId: string;
      modelId: string;
      laneId: string;
      evaluatedEffort: string;
      aaSlug: string;
      observationalOnly?: boolean;
    }>;
    maxSnapshotAgeHours: number;
  };
  /** : default-off accepted-work posterior producer. Absent/disabled = no overlay built. */
  acceptedWork: { enabled: boolean };
  /**  models.dev price reconciliation kill switch. Report-only by construction; there is no apply mode. */
  priceSync: { enabled: boolean };
  /**  absorption of the standalone `dispatch` plugin (/). */
  dispatch: {
    wakeEnabled: boolean;
    idleMinutes: number;
    maxWakesPerFiring: number;
    focusProjectIds: readonly string[];
  };
  /** . See `select.ts`'s `SelectionConfig.wakeScopedFloor` for the mechanism. */
  wakeScopedFloor: {
    enabled: boolean;
    wakeReasons: readonly string[];
    floorTier: Tier;
  };
  /**
   *  ( §4.3). The run-scoped decision flag. Off (default):
   * `onResolveRunModel` answers `keep` and every legacy pin path runs exactly as
   * before. On: the handler decides each run's model from hot caches and the
   * creation/assignment pins, `labelOnlyPass`/`balancePass` pin writes and the
   * `repinPass`/`agent.run.failed` re-pins are retired. Labels stay.
   */
  runResolve: {
    enabled: boolean;
    /** Hot snapshot (config-derived reads, lane ledger, scores) is refreshed once older than this. */
    snapshotTtlMs: number;
    /** Hard cap on waiting for an in-flight classification (never starts one). */
    classifierWaitMs: number;
    /** `retryAfterMs` for a `defer` answer. */
    deferRetryMs: number;
  };
}

const AGENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function string(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function fieldList(value: unknown, fallback: readonly string[]): string[] {
  const fields = Array.isArray(value)
    ? value.filter((field): field is string => typeof field === "string" && field.length > 0)
    : [];
  return fields.length > 0 ? fields : [...fallback];
}

/**
 * Trimmed, non-empty strings, in order. Anything that is not a string is
 * dropped here; the config schema is what rejects it loudly
 * (`items: { type: "string" }`), so a malformed list never reaches this far on
 * the install path.
 */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const id = entry.trim();
    if (id.length > 0) out.push(id);
  }
  return out;
}

/**
 * Host agent ids are lowercase UUIDs. An operator-pasted uppercase id passes
 * the UUID check (which ignores case) yet never matches, so the router would
 * pin the agent it was meant to leave alone. Lowercasing at read keeps the
 * match working. This is also where the list is de-duplicated, case-insensitively
 * and in first-seen order.
 */
function lowercaseIds(ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const lower = id.toLowerCase();
    if (!out.includes(lower)) out.push(lower);
  }
  return out;
}

function nullableNum(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function secretRef(value: unknown): SecretRef | null {
  // Deliberately NOT narrowed to an object shape (let alone `type ===
  // "secret_ref"`) here: an ill-shaped value — including a raw string —
  // must survive resolution so `validateConfig`'s `validateSecretRefShape`
  // call below can see it and reject it with a specific reason, rather than
  // have resolution silently swallow it to null first.
  return value === undefined ? null : (value as SecretRef | null);
}

/**
 * Keep only strictly positive finite plan weights; anything else can never
 * serve as a pace allowance weight. Non-object values survive untouched so
 * schema validation can reject them with a specific reason.
 */
function planWeights(value: unknown): Record<string, number> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return value as Record<string, number> | null;
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "number" && Number.isFinite(entry) && entry > 0) out[key] = entry;
  }
  return out;
}

function tier(value: unknown, fallback: Tier): Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value)
    ? (value as Tier)
    : fallback;
}

/**
 * Defaults are chosen so that an unconfigured install is inert: advise mode,
 * conservative T1 default tier, hold on an untrusted profile. Nothing about
 * installing this plugin changes a live selection variable until someone sets
 * `mode: enforce`.
 */
export function resolveConfig(raw: Record<string, unknown> | null | undefined): ResolvedConfig {
  const root = record(raw);
  const selection = record(root.selection);
  const profiles = record(root.profiles);
  const quality = record(root.quality);
  const pacing = record(root.pacing);
  const classification = record(root.classification);
  const earnIn = record(root.earnIn);
  const shadowEmit = record(root.shadowEmit);
  const accountAdmissionShadow = record(root.accountAdmissionShadow);
  const aaSync = record(root.aaSync);
  const aaFreeSync = record(root.aaFreeSync);
  const acceptedWork = record(root.acceptedWork);
  const priceSync = record(root.priceSync);
  const dispatch = record(root.dispatch);
  const wakeScopedFloor = record(root.wakeScopedFloor);
  const runResolve = record(root.runResolve);

  const models: ModelEntry[] = Array.isArray(root.models)
    ? root.models.flatMap((entry) => {
        const model = record(entry);
        if (typeof model.id !== "string" || model.id.length === 0) return [];
        return [
          {
            id: model.id,
            tier: tier(model.tier, "T3"),
            enabled: bool(model.enabled, true),
            costPerMTokIn: num(model.costPerMTokIn, 0),
            costPerMTokOut: num(model.costPerMTokOut, 0),
            costPerMTokCacheRead: num(model.costPerMTokCacheRead, 0),
            capabilities: Array.isArray(model.capabilities)
              ? model.capabilities.filter((c): c is string => typeof c === "string")
              : [],
            contextWindow: num(model.contextWindow, 200_000),
            aaIndex: nullableNum(model.aaIndex),
            aaSlug: typeof model.aaSlug === "string" && model.aaSlug.length > 0 ? model.aaSlug : null,
            aaIndexUpdatedAt: typeof model.aaIndexUpdatedAt === "string" ? model.aaIndexUpdatedAt : null,
            releasedAt: string(model.releasedAt, "1970-01-01"),
            fallbackOnly: bool(model.fallbackOnly, false),
            note: string(model.note, ""),
            earnIn: nullableRecord(model.earnIn),
            laneId: typeof model.laneId === "string" && model.laneId.length > 0 ? model.laneId : null,
            effort: typeof model.effort === "string" && model.effort.length > 0 ? model.effort : null,
          } satisfies ModelEntry,
        ];
      })
    : [];

  const rawLabelIds = record(root.tierLabelIds);
  const tierLabelIds: Partial<Record<Tier, string>> = {};
  for (const t of TIERS) {
    const id = rawLabelIds[t];
    if (typeof id === "string" && id.length > 0) tierLabelIds[t] = id;
  }
  const operatorLabelId = typeof root.operatorLabelId === "string" && root.operatorLabelId.length > 0
    ? root.operatorLabelId
    : null;

  const lanes: LaneSourceConfig[] = Array.isArray(pacing.lanes)
    ? pacing.lanes.flatMap((entry) => {
        const rawLane = record(entry);
        if (typeof rawLane.laneId !== "string" || rawLane.laneId.length === 0) return [];
        if (typeof rawLane.statusUrl !== "string" || rawLane.statusUrl.length === 0) return [];
        const windows: PaceWindowDefinition[] = Array.isArray(rawLane.windows)
          ? rawLane.windows.flatMap((w) => {
              const window = record(w);
              if (typeof window.name !== "string" || window.name.length === 0) return [];
              if (window.role !== "serviceability" && window.role !== "allowance") return [];
              const utilizationFields = Array.isArray(window.utilizationFields)
                ? window.utilizationFields.filter((f): f is string => typeof f === "string")
                : [];
              if (utilizationFields.length === 0) return [];
              return [
                {
                  name: window.name,
                  role: window.role,
                  utilizationFields,
                  resetFields: Array.isArray(window.resetFields)
                    ? window.resetFields.filter((f): f is string => typeof f === "string")
                    : [],
                  defaultWindowSeconds:
                    typeof window.defaultWindowSeconds === "number" ? window.defaultWindowSeconds : null,
                } satisfies PaceWindowDefinition,
              ];
            })
          : [];
        if (windows.length === 0) return [];
        return [
          {
            laneId: rawLane.laneId,
            statusUrl: rawLane.statusUrl,
            requestTimeoutMs: num(rawLane.requestTimeoutMs, 5000),
            maxResponseBytes: num(rawLane.maxResponseBytes, 262_144),
            apiKeySecretRef: secretRef(rawLane.apiKeySecretRef),
            authFilesProvider:
              record(rawLane.source).kind === "cliproxy-auth-files" &&
              (record(rawLane.source).provider === "claude" || record(rawLane.source).provider === "codex")
                ? (record(rawLane.source).provider as "claude" | "codex")
                : null,
            planWeights: planWeights(rawLane.planWeights),
            // Kept as written, finite numbers only: `validateConfig` reports an
            // out-of-range ceiling rather than this dropping it silently.
            ...(typeof rawLane.withdrawAtUtilization === "number" && Number.isFinite(rawLane.withdrawAtUtilization)
              ? { withdrawAtUtilization: rawLane.withdrawAtUtilization }
              : {}),
            lane: {
              laneId: rawLane.laneId,
              free: bool(rawLane.free, false),
              healthFields: fieldList(rawLane.healthFields, ["health", "status"]),
              accountKeyFields: fieldList(rawLane.accountKeyFields, DEFAULT_PACE_ACCOUNT_KEY_FIELDS),
              weightFields: fieldList(rawLane.weightFields, DEFAULT_PACE_WEIGHT_FIELDS),
              governingWindowField:
                typeof rawLane.governingWindowField === "string" ? rawLane.governingWindowField : "governing_window",
              windowSecondsField:
                typeof rawLane.windowSecondsField === "string" ? rawLane.windowSecondsField : "window_seconds",
              staleAfterSecondsField:
                typeof rawLane.staleAfterSecondsField === "string"
                  ? rawLane.staleAfterSecondsField
                  : "staleAfterSeconds",
              windows,
            },
            policy: {
              ...(typeof rawLane.margin === "number" ? { margin: rawLane.margin } : {}),
              ...(typeof rawLane.urgentResetSeconds === "number"
                ? { urgentResetSeconds: rawLane.urgentResetSeconds }
                : {}),
              ...(typeof rawLane.maxSnapshotAgeSeconds === "number"
                ? { maxSnapshotAgeSeconds: rawLane.maxSnapshotAgeSeconds }
                : {}),
            },
          } satisfies LaneSourceConfig,
        ];
      })
    : [];

  return {
    selection: {
      enabled: bool(selection.enabled, true),
      mode: selection.mode === "enforce" ? "enforce" : "advise",
      defaultTier: tier(selection.defaultTier, "T1"),
      stickyModelWithinIssue: bool(selection.stickyModelWithinIssue, true),
      holdOnUntrustedProfile: bool(selection.holdOnUntrustedProfile, true),
      holdOnUnknownAvailability: bool(selection.holdOnUnknownAvailability, false),
      objective: selection.objective === "cost-per-accepted-card" ? "cost-per-accepted-card" : "list-price",
      fleetContextCeilingTokens: num(selection.fleetContextCeilingTokens, 1_000_000),
      contextRunLogRoot: typeof selection.contextRunLogRoot === "string" && selection.contextRunLogRoot.trim()
        ? selection.contextRunLogRoot.trim() : null,
      // : unset resolves to the fleet ceiling, so behaviour is
      // unchanged until the operator sets it (1M to release Muse's window).
      agentEnvContextTokens: num(
        selection.agentEnvContextTokens,
        num(selection.fleetContextCeilingTokens, 1_000_000),
      ),
      compactionRatio: num(selection.compactionRatio, 0.75),
      exemptAgentIds: lowercaseIds(stringList(selection.exemptAgentIds)),
    },
    models,
    tierLabelIds,
    operatorLabelId,
    profiles: {
      windowDays: num(profiles.windowDays, 7),
      minSamples: num(profiles.minSamples, 5),
      maxAgeDays: num(profiles.maxAgeDays, 14),
    },
    quality: {
      t1EscalationCeiling: num(quality.t1EscalationCeiling, 0.05),
      t2EscalationCeiling: num(quality.t2EscalationCeiling, 0.15),
      silentFailureWeight: num(quality.silentFailureWeight, 10),
    },
    pacing: {
      mode: (PACING_MODES as readonly string[]).includes(pacing.mode as string)
        ? (pacing.mode as PacingMode)
        : "shadow",
      lanes,
      slotFloorFraction: num(pacing.slotFloorFraction, DEFAULT_SLOT_FLOOR_FRACTION),
      operatorOverrideTtlSeconds: num(pacing.operatorOverrideTtlSeconds, DEFAULT_OPERATOR_OVERRIDE_TTL_SECONDS),
      idleRepinHysteresisSeconds: num(pacing.idleRepinHysteresisSeconds, DEFAULT_IDLE_REPIN_HYSTERESIS_SECONDS),
      avoid: (() => {
        const avoid = record(pacing.avoid);
        const rawPerLane = record(avoid.perLane);
        const keys = Object.keys(rawPerLane);
        // : the withdrawal ceilings live on the lane entries, so the
        // key is only present when a lane has one and every existing config
        // resolves to exactly the shape it always did.
        const withdrawAt = Object.fromEntries(
          lanes.flatMap((lane) => (lane.withdrawAtUtilization === undefined ? [] : [[lane.laneId, lane.withdrawAtUtilization] as const])),
        );
        const withdrawal = Object.keys(withdrawAt).length > 0 ? { withdrawAt } : {};
        if (keys.length === 0) {
          return { defaultThreshold: num(avoid.defaultThreshold, 0.8), perLane: { ...DEFAULT_AVOID_PER_LANE }, ...withdrawal };
        }
        const perLane: Record<string, number> = {};
        for (const [laneId, threshold] of Object.entries(rawPerLane)) {
          if (typeof threshold === "number" && Number.isFinite(threshold)) perLane[laneId] = threshold;
        }
        return { defaultThreshold: num(avoid.defaultThreshold, 0.8), perLane, ...withdrawal };
      })(),
      laneCapPerAccount: (() => {
        const raw = record(pacing.laneCapPerAccount);
        const keys = Object.keys(raw);
        if (keys.length === 0) return { ...DEFAULT_LANE_CAP_PER_ACCOUNT };
        const perAccount: Record<string, number> = {};
        for (const [laneId, cap] of Object.entries(raw)) {
          if (typeof cap === "number" && Number.isFinite(cap)) perAccount[laneId] = cap;
        }
        return perAccount;
      })(),
      fiveHourWindowName: string(pacing.fiveHourWindowName, DEFAULT_FIVE_HOUR_WINDOW_NAME),
      weeklyWindowName: string(pacing.weeklyWindowName, DEFAULT_WEEKLY_WINDOW_NAME),
      codexLaneId: string(pacing.codexLaneId, LANE_ID_CODEX),
      opencodeGoLaneId: string(pacing.opencodeGoLaneId, LANE_ID_OPENCODE_GO),
      zai: (() => {
        const zai = record(pacing.zai);
        return {
          laneId: string(zai.laneId, LANE_ID_ZAI),
          weeklyWindowName: string(zai.weeklyWindowName, DEFAULT_ZAI_WEEKLY_WINDOW_NAME),
          weeklyDefaultMargin: num(zai.weeklyDefaultMargin, DEFAULT_ZAI_WEEKLY_MARGIN),
        };
      })(),
    },
    classification: {
      enabled: bool(classification.enabled, false),
      baseUrl: typeof classification.baseUrl === "string" && classification.baseUrl.length > 0
        ? classification.baseUrl
        : null,
      protocol:
        classification.protocol === "openai-chat-completions" ? "openai-chat-completions" : "anthropic-messages",
      modelId: typeof classification.modelId === "string" && classification.modelId.length > 0
        ? classification.modelId
        : null,
      apiKeySecretRef: secretRef(classification.apiKeySecretRef),
      requestTimeoutMs: num(classification.requestTimeoutMs, 15000),
      maxResponseBytes: num(classification.maxResponseBytes, 65_536),
      descriptionChars: num(classification.descriptionChars, 1500),
      maxOutputTokens: num(classification.maxOutputTokens, 120),
      t3ConfidenceFloor: num(classification.t3ConfidenceFloor, 0.7),
      t2ConfidenceFloor: num(classification.t2ConfidenceFloor, 0.6),
      batchSize: num(classification.batchSize, 20),
      reclassifyForeignLabels: bool(classification.reclassifyForeignLabels, true),
    },
    earnIn: {
      enabled: bool(earnIn.enabled, false),
      perModelPerWeek: num(earnIn.perModelPerWeek, 8),
      maxActivePerModel: num(earnIn.maxActivePerModel, 1),
      maxActivePerLane: num(earnIn.maxActivePerLane, 1),
      classes: Array.isArray(earnIn.classes)
        ? earnIn.classes.filter((c): c is string => typeof c === "string")
        : ["research", "review"],
      stopOnFirstNFailures: num(earnIn.stopOnFirstNFailures, 2),
      stopWindow: num(earnIn.stopWindow, 8),
    },
    accountAdmissionShadow: { enabled: bool(accountAdmissionShadow.enabled, false) },
    formatCompatibility: resolveFormatCompatibility(root.formatCompatibility),
    shadowEmit: {
      enabled: bool(shadowEmit.enabled, false),
      maxRecords: num(shadowEmit.maxRecords, 5000),
      shardMaxRecords: Math.max(2, Math.floor(num(shadowEmit.shardMaxRecords, 200))),
      retentionShards: Math.max(1, Math.floor(num(shadowEmit.retentionShards, 48))),
    },
    aaSync: {
      enabled: bool(aaSync.enabled, true),
    },
    aaFreeSync: {
      enabled: bool(aaFreeSync.enabled, false),
      apiKeySecretRef: secretRef(aaFreeSync.apiKeySecretRef),
      bindings: Array.isArray(aaFreeSync.bindings)
        ? aaFreeSync.bindings.flatMap((entry) => {
            const b = record(entry);
            if (
              typeof b.candidateId !== "string" || b.candidateId.length === 0 ||
              typeof b.modelId !== "string" || b.modelId.length === 0 ||
              typeof b.laneId !== "string" || b.laneId.length === 0 ||
              typeof b.evaluatedEffort !== "string" || b.evaluatedEffort.length === 0 ||
              typeof b.aaSlug !== "string" || b.aaSlug.length === 0
            ) return [];
            return [{
              candidateId: b.candidateId,
              modelId: b.modelId,
              laneId: b.laneId,
              evaluatedEffort: b.evaluatedEffort,
              aaSlug: b.aaSlug,
              ...(typeof b.observationalOnly === "boolean" ? { observationalOnly: b.observationalOnly } : {}),
            }];
          })
        : [],
      maxSnapshotAgeHours: num(aaFreeSync.maxSnapshotAgeHours, 49),
    },
    acceptedWork: {
      enabled: bool(acceptedWork.enabled, false),
    },
    priceSync: {
      enabled: bool(priceSync.enabled, true),
    },
    dispatch: {
      wakeEnabled: bool(dispatch.wakeEnabled, false),
      idleMinutes: num(dispatch.idleMinutes, 120),
      maxWakesPerFiring: num(dispatch.maxWakesPerFiring, 3),
      focusProjectIds: Array.isArray(dispatch.focusProjectIds)
        ? dispatch.focusProjectIds.filter((p): p is string => typeof p === "string")
        : [],
    },
    wakeScopedFloor: {
      enabled: bool(wakeScopedFloor.enabled, true),
      wakeReasons: Array.isArray(wakeScopedFloor.wakeReasons)
        ? wakeScopedFloor.wakeReasons.filter((r): r is string => typeof r === "string" && r.length > 0)
        : [],
      floorTier: tier(wakeScopedFloor.floorTier, "T3"),
    },
    runResolve: {
      enabled: bool(runResolve.enabled, false),
      snapshotTtlMs: Math.min(Math.max(num(runResolve.snapshotTtlMs, 45_000), 5_000), 300_000),
      classifierWaitMs: Math.min(Math.max(num(runResolve.classifierWaitMs, 1_000), 0), 1_000),
      deferRetryMs: Math.min(Math.max(num(runResolve.deferRetryMs, 5_000), 1_000), 60_000),
    },
  };
}

/**
 *  enforce preflight: refuse an enforce request whose roster has an
 * ENABLED lane missing its pacing.lanes entry. Enforce pins cards onto the
 * lane's models, and with no pacing.lanes entry `laneVerdictFor` degrades the
 * lane to "unpolled" forever (fail-neutral by design) — the pin would run
 * with no pace governance and no serviceability hard stop, a silent failure.
 * One error per missing lane id, naming the lane id and the missing
 * pacing.lanes key. Disabled rows can never be pinned, so a disabled row's
 * missing lane entry passes; lane-less rows (no laneId) pass — there is
 * nothing to wire.
 *
 * Deliberately NOT gated on pacing.mode:  Defect 6 already refuses a
 * missing laneId when pacing is on, for every row; this gate covers the
 * enforce flip itself, including pacing.mode=off where Defect 6 stays
 * silent. Advise mode never writes a pin, so it carries no refusal either.
 * Live lanes wiring stays on ; this predicate runs on fixtures here.
 */
export function unwiredEnforceLaneErrors(config: ResolvedConfig): string[] {
  if (config.selection.mode !== "enforce") return [];
  const wired = new Set(config.pacing.lanes.map((lane) => lane.laneId));
  const missing = new Map<string, string>();
  for (const model of config.models) {
    if (!model.enabled || !model.laneId || wired.has(model.laneId)) continue;
    if (!missing.has(model.laneId)) {
      missing.set(
        model.laneId,
        `selection.mode is enforce but enabled model "${model.id}" references laneId "${model.laneId}", which has no pacing.lanes entry — wire pacing.lanes["${model.laneId}"] before enforcing so pace routing governs the pin`,
      );
    }
  }
  return [...missing.values()];
}

/** Config problems worth refusing or warning about at install time. */
export function validateConfig(config: ResolvedConfig): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const seen = new Set<string>();
  for (const model of config.models) {
    if (model.id.startsWith("cliproxy/")) {
      errors.push(`model id must use the direct CLIProxy namespace without an OmniRoute cliproxy/ wrapper: ${model.id}`);
    }
    const rosterKey = `${model.id}::${model.tier}`;
    if (seen.has(rosterKey)) errors.push(`duplicate model+tier row: ${model.id} ${model.tier}`);
    seen.add(rosterKey);
    if (!Number.isFinite(Date.parse(`${model.releasedAt}T00:00:00.000Z`))) {
      errors.push(`invalid releasedAt date: ${model.id} ${model.tier} ${model.releasedAt}`);
    }
    if (model.costPerMTokCacheRead === 0 && model.costPerMTokIn > 0) {
      // A zero cache-read rate makes the largest cost line free and would order
      // candidates on the wrong term entirely (ADR-0002).
      warnings.push(
        `${model.id} has costPerMTokCacheRead 0 — cache read is the largest cost line; a zero rate hides it`,
      );
    }
  }

  if (
    !Number.isFinite(config.selection.compactionRatio) ||
    config.selection.compactionRatio <= 0 ||
    config.selection.compactionRatio >= 1
  ) {
    errors.push("selection.compactionRatio must be greater than 0 and less than 1");
  }
  if (
    !Number.isFinite(config.selection.fleetContextCeilingTokens) ||
    config.selection.fleetContextCeilingTokens < 1
  ) {
    errors.push("selection.fleetContextCeilingTokens must be a positive number");
  }
  if (
    !Number.isFinite(config.selection.agentEnvContextTokens) ||
    config.selection.agentEnvContextTokens < 1
  ) {
    errors.push("selection.agentEnvContextTokens must be a positive number");
  }

  if (config.selection.contextRunLogRoot && !isAbsolute(config.selection.contextRunLogRoot)) {
    errors.push("selection.contextRunLogRoot must be an absolute path");
  }

  // An exemption that names no real agent protects nothing, and the failure is
  // silent: the router simply pins the agent it was meant to leave alone. Agent
  // ids are UUIDs, so an entry that is not one is almost certainly a truncated
  // or mistyped paste. A warning, not an error: a non-UUID id is not unsafe.
  for (const agentId of config.selection.exemptAgentIds) {
    if (!AGENT_ID_PATTERN.test(agentId)) {
      warnings.push(
        `selection.exemptAgentIds entry "${agentId}" is not a full agent UUID; it will exempt no agent unless it matches an agent id exactly`,
      );
    }
  }

  if (config.selection.enabled && config.models.length === 0) {
    warnings.push("selection is enabled but no models are configured; every decision will be no-eligible-model");
  }
  //  enforce preflight: selection.mode=enforce pins cards onto a
  // tier's models, so a tier with zero enabled rows must refuse at
  // config-resolve time — enforce can never pin onto an unserved tier.
  // Advise mode never writes a pin, so it keeps the historical warning only.
  // Disabled selection writes nothing, so it skips the enforce gate (re-start
  // re-runs validation, so enabling later cannot slip an empty tier through).
  const emptyTiers = TIERS.filter(
    (t) => !config.models.some((model) => model.enabled && model.tier === t),
  );
  // : T0 is explicit-only, so an empty T0 cannot make enforce pin a
  // card onto an unserved tier — only a card that opted in with `tier:T0` waits
  // (it holds at its floor). It stays a warning, which also lets the build ship
  // before the roster gains its first T0 row; the migration cannot precede the
  // build, because the previous build rejects `tier: "T0"` as an unknown tier.
  if (config.selection.enabled && config.selection.mode === "enforce") {
    for (const t of emptyTiers) {
      if (isImplicitlyAdmittedTier(t)) {
        errors.push(
          `selection.mode is enforce but tier ${t} has no enabled models; enforce cannot pin onto an unserved tier`,
        );
      } else {
        warnings.push(
          `no enabled model at tier ${t}; cards that opt in with ${TIER_LABEL_PREFIX}${t} hold at their floor until one is enabled`,
        );
      }
    }
  } else {
    for (const t of emptyTiers) {
      warnings.push(`no enabled model at tier ${t}`);
    }
  }
  //  enforce preflight: fail closed when an enabled lane has no
  // pacing.lanes entry — see `unwiredEnforceLaneErrors` for the exact gate.
  errors.push(...unwiredEnforceLaneErrors(config));
  if (config.selection.mode === "enforce" && Object.keys(config.tierLabelIds).length === 0) {
    // Not an error: the label is additive (ADR-0008). But an operator who meant
    // to get tier labels on the board should hear that they will not appear.
    warnings.push(
      "no tierLabelIds configured; overrides will be written without a tier:* label, because the plugin cannot resolve a label id from its name",
    );
  }
  if (config.selection.mode === "enforce") {
    warnings.push(
      "mode is enforce: this plugin will write assigneeAdapterOverrides. Confirm Stage 2 is stable before running this alongside another live selection change.",
    );
  }

  const laneIds = new Set<string>();
  for (const lane of config.pacing.lanes) {
    if (laneIds.has(lane.laneId)) errors.push(`duplicate lane id: ${lane.laneId}`);
    laneIds.add(lane.laneId);
    const secretError = validateSecretRefShape(lane.apiKeySecretRef, `pacing.lanes.${lane.laneId}.apiKeySecretRef`);
    if (secretError) errors.push(secretError);
    // : 0 would withdraw the lane on every reading and above 1 could
    // never fire; either is a silent misconfiguration, so refuse it.
    if (lane.withdrawAtUtilization !== undefined && !(lane.withdrawAtUtilization > 0 && lane.withdrawAtUtilization <= 1)) {
      errors.push(
        `pacing.lanes.${lane.laneId}.withdrawAtUtilization must be above 0 and at most 1 (got ${lane.withdrawAtUtilization}); omit it to never withdraw the lane`,
      );
    }
  }
  if (config.pacing.mode !== "off" && config.pacing.lanes.length === 0) {
    warnings.push(`pacing.mode is ${config.pacing.mode} but no lanes are configured; pace ordering has nothing to key on`);
  }
  if (config.pacing.mode === "enforce" && config.pacing.slotFloorFraction <= 0) {
    errors.push("pacing.slotFloorFraction must stay above 0 while lanes are serviceable — ahead-of-line throttling must never reach zero");
  }

  if (config.classification.enabled) {
    if (!config.classification.baseUrl) {
      errors.push("classification.enabled is true but no classification.baseUrl is configured");
    }
    if (!config.classification.modelId) {
      errors.push("classification.enabled is true but no classification.modelId is configured");
    }
    const secretError = validateSecretRefShape(
      config.classification.apiKeySecretRef,
      "classification.apiKeySecretRef",
    );
    if (secretError) errors.push(secretError);
  }

  if (config.selection.objective === "cost-per-accepted-card") {
    warnings.push(
      "selection.objective is cost-per-accepted-card: candidate ordering now depends on the card ledger, not just list price. Confirm the 7-day shadow diff agreed before this was switched.",
    );
  }
  if (config.earnIn.enabled) {
    warnings.push(
      "earnIn.enabled is true: unproven T1 candidates may be dispatched bounded research/review work. Confirm lane and pace posture gates are live before relying on this.",
    );
  }

  //  P2: the free-list sync never writes, but a misconfigured one
  // produces a silently empty or misleading diff — fail loudly here instead.
  if (config.aaFreeSync.enabled) {
    const secretError = validateSecretRefShape(config.aaFreeSync.apiKeySecretRef, "aaFreeSync.apiKeySecretRef");
    if (secretError) errors.push(secretError);
    if (!config.aaFreeSync.apiKeySecretRef) {
      errors.push("aaFreeSync.enabled is true but no aaFreeSync.apiKeySecretRef is configured; the free list cannot be fetched");
    }
    if (config.aaFreeSync.bindings.length === 0) {
      warnings.push(
        "aaFreeSync.enabled is true but no aaFreeSync.bindings are curated; the job fetches the snapshot but every diff will report unbound-only",
      );
    }
    const seen = new Set<string>();
    for (const b of config.aaFreeSync.bindings) {
      const key = `${b.modelId} ${b.laneId} ${b.evaluatedEffort}`;
      if (seen.has(key)) errors.push(`duplicate aaFreeSync binding: ${key}`);
      seen.add(key);
    }
    if (!Number.isFinite(config.aaFreeSync.maxSnapshotAgeHours) || config.aaFreeSync.maxSnapshotAgeHours < 1) {
      errors.push("aaFreeSync.maxSnapshotAgeHours must be a positive number of hours");
    }
  }

  if (config.wakeScopedFloor.enabled && config.wakeScopedFloor.wakeReasons.length === 0) {
    warnings.push(
      "wakeScopedFloor.enabled is true but wakeReasons is empty; no decision will ever qualify until an operator names the actual PAPERCLIP_WAKE_REASON values for cheap wakes (e.g. monitor ticks)",
    );
  }
  if (config.wakeScopedFloor.enabled && config.wakeScopedFloor.wakeReasons.length > 0) {
    // TIER_ORDER is least- to most-capable (T3..T1) — this must NOT use the
    // declarative TIERS array above, whose order is unrelated to capability.
    const floorIndex = TIER_ORDER.indexOf(config.wakeScopedFloor.floorTier);
    const defaultIndex = TIER_ORDER.indexOf(config.selection.defaultTier);
    if (floorIndex >= defaultIndex) {
      warnings.push(
        `wakeScopedFloor.floorTier (${config.wakeScopedFloor.floorTier}) is not below selection.defaultTier (${config.selection.defaultTier}); a wake-scoped decision will only ever lower the floor for a card judged above that`,
      );
    }
  }

  // , Defect 6. A model row's `laneId` that does not resolve to a
  // configured `pacing.lanes[].laneId` is exactly the silent-failure shape
  // the reference dispatcher's unvalidated `pinnedModelId`/fallback config
  // has: `laneVerdictFor` degrades a typo'd or renamed lane id to
  // "unpolled" forever (fail-neutral by design, so it never excludes the
  // model), which means this roster row's serviceability hard stop and pace
  // ordering both silently never activate — no error at dispatch, just a
  // model that quietly never gets pace-governed. Fail loudly here instead,
  // once, at config load, rather than leaving it to be noticed later as an
  // absence of behavior nobody can point at.
  if (config.pacing.mode !== "off") {
    const referencedLaneIds = new Set<string>();
    for (const model of config.models) {
      // : a disabled row can never be selected or pinned, so its
      // lane can never silently evade pace governance — only enabled rows
      // must resolve. This keeps the gate consistent with the enforce
      // preflight (`unwiredEnforceLaneErrors`), where a disabled lane
      // without a pacing.lanes entry passes.
      if (model.enabled && model.laneId) referencedLaneIds.add(model.laneId);
    }
    for (const laneId of referencedLaneIds) {
      if (!laneIds.has(laneId)) {
        errors.push(
          `model roster references laneId "${laneId}", which is not in pacing.lanes — pace routing for that model would silently never activate`,
        );
      }
    }
  }

  return { errors, warnings };
}
