// src/worker.ts
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

// src/constants.ts
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
var TIER_LABEL_PREFIX = "tier:";
var TIERS = ["T1", "T2", "T3"];
var TIER_ORDER = ["T3", "T2", "T1"];
var OPERATOR_PIN_LABEL = "pin:operator";
var PLUGIN_STATE_KEYS = {
  volumeProfiles: "volumeProfiles",
  /** Per-company lane pace verdicts and slot-throttle counters. */
  laneLedger: "laneLedger",
  /** Per-issue operator overrides, each with an expiry (TOG-2137). */
  operatorOverrides: "operatorOverrides",
  /** Per-issue timestamp of the last pace-driven repin, for the idle-repin hysteresis (TOG-2137). */
  paceRepinHistory: "paceRepinHistory",
  /** `ModelScore[]` written by the `refreshScores` job. */
  modelScores: "modelScores",
  /** Reopen/rejection signals captured from `ctx.events` between `refreshScores` runs. */
  reworkSignals: "reworkSignals",
  /** Rolling 7-day list-price vs cost-per-accepted-card shadow-diff records (Slice 3). */
  shadowDiffs: "shadowDiffs",
  /** Slice-4 bounded T1 earn-in dispatch bookkeeping. */
  earnInState: "earnInState",
  /**
   * TOG-2137, Defect 2. Per-issue timestamp of the last raised `tier-exhausted`
   * operator alarm, so a decision that stays exhausted across repeated
   * `advise`/`apply` calls does not spam a fresh card every time — one open
   * card per continuous exhaustion streak. Cleared the first time the same
   * issue's outcome is no longer `tier-exhausted`, so the NEXT exhaustion
   * raises a fresh card rather than staying silent forever.
   */
  tierExhaustedAlarms: "tierExhaustedAlarms"
};
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
var DEFAULT_SLOT_FLOOR_FRACTION = 0.25;
var DEFAULT_OPERATOR_OVERRIDE_TTL_SECONDS = 60 * 60;
var DEFAULT_IDLE_REPIN_HYSTERESIS_SECONDS = 5 * 60;
var SCORE_THRESHOLDS = { T1: 0.85, T2: 0.8, T3: 0.75 };
var SCORE_PRIOR_K = 6;
var SCORE_PROVEN_N = 8;
var CARD_CENSOR_DAYS = 14;
var SCORE_WINDOW_DAYS = 14;
var CARD_LEDGER_WINDOW_DAYS = 60;
var REOPEN_WINDOW_MS = 72 * 60 * 60 * 1e3;
var REJECTION_WINDOW_MS = 48 * 60 * 60 * 1e3;
var REWORK_WEIGHT_REOPEN = 1;
var REWORK_WEIGHT_REJECTED = 0.5;

// src/engine/pacing.ts
function mergeLedgerEntry(ledger, result) {
  return { ...ledger, [result.laneId]: { laneId: result.laneId, verdict: result.verdict, fetchedAt: result.fetchedAt, error: result.error } };
}
function laneVerdictFor(ledger, laneId) {
  if (!laneId) return null;
  return ledger[laneId]?.verdict ?? null;
}
var PACE_STATE_RANK = {
  "behind-urgent": 0,
  behind: 1,
  on: 2,
  unknown: 3,
  free: 4,
  ahead: 5,
  exhausted: 6
};
function paceStateOf(ledger, model) {
  if (!model) return "unknown";
  return laneVerdictFor(ledger, model.laneId ?? null)?.state ?? "unknown";
}
function deviationOf(ledger, model) {
  if (!model) return 0;
  return laneVerdictFor(ledger, model.laneId ?? null)?.score?.deviation ?? 0;
}
function modelOf(models, candidate) {
  return models.find((model) => model.id === candidate.modelId);
}
var PREFERRED_ELAPSED_THRESHOLD = 0.8;
function isPreferredNearReset(verdict, elapsedThreshold = PREFERRED_ELAPSED_THRESHOLD) {
  if (!verdict || verdict.serviceable !== true || !verdict.score) return false;
  return verdict.score.elapsed >= elapsedThreshold && verdict.score.deviation < 0;
}
function preferredOf(ledger, model, elapsedThreshold) {
  if (!model) return false;
  return isPreferredNearReset(laneVerdictFor(ledger, model.laneId ?? null), elapsedThreshold);
}
function preferredCandidateId(candidates, models, ledger, elapsedThreshold = PREFERRED_ELAPSED_THRESHOLD) {
  const preferred = candidates.find((candidate) => preferredOf(ledger, modelOf(models, candidate), elapsedThreshold));
  return preferred?.modelId ?? null;
}
function orderCandidatesByPace(candidates, models, ledger, options) {
  const elapsedThreshold = options?.preferredElapsedThreshold ?? PREFERRED_ELAPSED_THRESHOLD;
  const byTier = /* @__PURE__ */ new Map();
  const orderedTierKeys = [];
  for (const candidate of candidates) {
    let group = byTier.get(candidate.tier);
    if (!group) {
      group = [];
      byTier.set(candidate.tier, group);
      orderedTierKeys.push(candidate.tier);
    }
    group.push(candidate);
  }
  const result = [];
  for (const tierKey of orderedTierKeys) {
    const group = byTier.get(tierKey);
    group.sort((left, right) => {
      const leftModel = modelOf(models, left);
      const rightModel = modelOf(models, right);
      const leftPreferred = preferredOf(ledger, leftModel, elapsedThreshold);
      const rightPreferred = preferredOf(ledger, rightModel, elapsedThreshold);
      if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1;
      const stateDelta = PACE_STATE_RANK[paceStateOf(ledger, leftModel)] - PACE_STATE_RANK[paceStateOf(ledger, rightModel)];
      if (stateDelta !== 0) return stateDelta;
      const deviationDelta = deviationOf(ledger, leftModel) - deviationOf(ledger, rightModel);
      if (deviationDelta !== 0) return deviationDelta;
      if (left.expectedCostUsd !== right.expectedCostUsd) return left.expectedCostUsd - right.expectedCostUsd;
      const leftRelease = leftModel?.releasedAt ?? "1970-01-01";
      const rightRelease = rightModel?.releasedAt ?? "1970-01-01";
      if (leftRelease !== rightRelease) return leftRelease > rightRelease ? -1 : 1;
      return left.modelId.localeCompare(right.modelId);
    });
    result.push(...group);
  }
  return result;
}
function hardStopExcluded(ledger, model) {
  const verdict = laneVerdictFor(ledger, model.laneId ?? null);
  if (!verdict) return false;
  return verdict.serviceable === false;
}
function hashUnitInterval(input) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}
function slotFactorFor(ledger, model, slotFloorFraction) {
  const verdict = laneVerdictFor(ledger, model.laneId ?? null);
  if (!verdict || verdict.state !== "ahead") return 1;
  const floor = Math.max(Number.EPSILON, slotFloorFraction);
  return floor;
}
function slotAllowed(issueId, ledger, model, slotFloorFraction) {
  const factor = slotFactorFor(ledger, model, slotFloorFraction);
  if (factor >= 1) return true;
  return hashUnitInterval(issueId) < factor;
}
function activeOperatorOverride(overrides, issueId, nowIso) {
  const entry = overrides[issueId];
  if (!entry) return null;
  return entry.expiresAt > nowIso ? entry : null;
}
function recordOperatorOverride(overrides, issueId, modelId, nowIso, ttlSeconds) {
  const expiresAt = new Date(Date.parse(nowIso) + ttlSeconds * 1e3).toISOString();
  return { ...overrides, [issueId]: { issueId, modelId, setAt: nowIso, expiresAt } };
}
function repinAllowed(context) {
  if (context.hasOperatorPin && !context.isServiceabilityHardStop) {
    return { allowed: false, reason: `${OPERATOR_PIN_LABEL} survives a routine pace repin` };
  }
  if (!context.isIdle) {
    return { allowed: false, reason: "issue has a running or queued run; never repin live work" };
  }
  if (context.lastRepinAt) {
    const elapsedSeconds = (Date.parse(context.now) - Date.parse(context.lastRepinAt)) / 1e3;
    if (elapsedSeconds < context.idleRepinHysteresisSeconds) {
      return { allowed: false, reason: `only ${Math.round(elapsedSeconds)}s since the last pace repin, below the ${context.idleRepinHysteresisSeconds}s hysteresis` };
    }
  }
  return { allowed: true, reason: context.isServiceabilityHardStop ? "serviceability hard stop overrides the operator pin" : "idle and past the repin hysteresis" };
}

// src/actuate/apply.ts
var TERMINAL_STATUSES = /* @__PURE__ */ new Set(["done", "cancelled"]);
function planApply(decision, context, targetIssueId) {
  const nothing = (reason) => ({
    write: false,
    issueId: targetIssueId,
    patch: null,
    labelName: null,
    reason
  });
  if (decision.advisory) {
    return nothing("advisory mode: enforcement is off for this company");
  }
  if (decision.outcome !== "selected" || !decision.modelId) {
    return nothing(`no model selected (outcome ${decision.outcome})`);
  }
  if (TERMINAL_STATUSES.has(context.status)) {
    return nothing(`issue status is ${context.status}; not re-pinning finished work`);
  }
  if (context.hasExistingOverride) {
    if (!context.paceRepin) {
      return nothing(
        "issue already carries assigneeAdapterOverrides; re-pinning would reset the session and discard the prompt cache"
      );
    }
    const gate = repinAllowed(context.paceRepin);
    if (!gate.allowed) {
      return nothing(`pace repin declined: ${gate.reason}`);
    }
  }
  const tier2 = decision.effectiveTier;
  return {
    write: true,
    issueId: targetIssueId,
    patch: { assigneeAdapterOverrides: { adapterConfig: { model: decision.modelId } } },
    labelName: context.hasExistingTierLabel || !tier2 ? null : tierLabelName(tier2),
    reason: `pinning ${decision.modelId} at ${tier2} \u2014 ${decision.trace.at(-1) ?? "selected"}`
  };
}
function tierLabelName(tier2) {
  return `${TIER_LABEL_PREFIX}${tier2}`;
}

// src/config/secret-ref.ts
var ALLOWED_KEYS = /* @__PURE__ */ new Set([
  "type",
  "secretId",
  "version",
  "projectionClass",
  "projectionAllowlistKey"
]);
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validateSecretRefShape(value, path) {
  if (value === null || value === void 0) return null;
  if (typeof value === "string") {
    return `${path} must be a Paperclip secret reference object, not a string. A pasted credential is never stored \u2014 use the secret picker, which submits { type: "secret_ref", secretId }.`;
  }
  if (!isRecord(value)) {
    return `${path} must be an object of the form { type: "secret_ref", secretId } or null`;
  }
  if (value.type !== "secret_ref") {
    return `${path} is not a secret reference: it must be { type: "secret_ref", secretId, version? }. An object holding a credential value would be stored in this company's config in clear.`;
  }
  if (typeof value.secretId !== "string" || !UUID.test(value.secretId)) {
    return `${path}.secretId must be the UUID of a Paperclip secret`;
  }
  if (value.projectionClass !== void 0 && value.projectionClass !== "unclassified" && value.projectionClass !== "class_3_static_lease") {
    return `${path}.projectionClass must be "unclassified" or "class_3_static_lease"`;
  }
  if (value.version !== void 0 && value.version !== "latest" && !(typeof value.version === "number" && Number.isInteger(value.version) && value.version > 0)) {
    return `${path}.version must be "latest" or a positive integer`;
  }
  const extra = Object.keys(value).filter((key) => !ALLOWED_KEYS.has(key));
  if (extra.length > 0) {
    return `${path} carries unexpected field(s): ${extra.sort().join(", ")}. A secret reference holds no value, only a pointer.`;
  }
  return null;
}

// src/config/resolve.ts
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function num(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function bool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}
function string(value, fallback) {
  return typeof value === "string" ? value : fallback;
}
function nullableNum(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function nullableRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function secretRef(value) {
  return value === void 0 ? null : value;
}
function tier(value, fallback) {
  return typeof value === "string" && TIERS.includes(value) ? value : fallback;
}
function resolveConfig(raw) {
  const root = record(raw);
  const selection = record(root.selection);
  const profiles = record(root.profiles);
  const quality = record(root.quality);
  const pacing = record(root.pacing);
  const earnIn = record(root.earnIn);
  const shadowEmit = record(root.shadowEmit);
  const models = Array.isArray(root.models) ? root.models.flatMap((entry) => {
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
        capabilities: Array.isArray(model.capabilities) ? model.capabilities.filter((c) => typeof c === "string") : [],
        contextWindow: num(model.contextWindow, 2e5),
        aaIndex: nullableNum(model.aaIndex),
        releasedAt: string(model.releasedAt, "1970-01-01"),
        fallbackOnly: bool(model.fallbackOnly, false),
        note: string(model.note, ""),
        earnIn: nullableRecord(model.earnIn),
        laneId: typeof model.laneId === "string" && model.laneId.length > 0 ? model.laneId : null
      }
    ];
  }) : [];
  const rawLabelIds = record(root.tierLabelIds);
  const tierLabelIds = {};
  for (const t of TIERS) {
    const id = rawLabelIds[t];
    if (typeof id === "string" && id.length > 0) tierLabelIds[t] = id;
  }
  const operatorLabelId = typeof root.operatorLabelId === "string" && root.operatorLabelId.length > 0 ? root.operatorLabelId : null;
  const lanes = Array.isArray(pacing.lanes) ? pacing.lanes.flatMap((entry) => {
    const rawLane = record(entry);
    if (typeof rawLane.laneId !== "string" || rawLane.laneId.length === 0) return [];
    if (typeof rawLane.statusUrl !== "string" || rawLane.statusUrl.length === 0) return [];
    const windows = Array.isArray(rawLane.windows) ? rawLane.windows.flatMap((w) => {
      const window = record(w);
      if (typeof window.name !== "string" || window.name.length === 0) return [];
      if (window.role !== "serviceability" && window.role !== "allowance") return [];
      const utilizationFields = Array.isArray(window.utilizationFields) ? window.utilizationFields.filter((f) => typeof f === "string") : [];
      if (utilizationFields.length === 0) return [];
      return [
        {
          name: window.name,
          role: window.role,
          utilizationFields,
          resetFields: Array.isArray(window.resetFields) ? window.resetFields.filter((f) => typeof f === "string") : [],
          defaultWindowSeconds: typeof window.defaultWindowSeconds === "number" ? window.defaultWindowSeconds : null
        }
      ];
    }) : [];
    if (windows.length === 0) return [];
    return [
      {
        laneId: rawLane.laneId,
        statusUrl: rawLane.statusUrl,
        requestTimeoutMs: num(rawLane.requestTimeoutMs, 5e3),
        maxResponseBytes: num(rawLane.maxResponseBytes, 262144),
        apiKeySecretRef: secretRef(rawLane.apiKeySecretRef),
        lane: {
          laneId: rawLane.laneId,
          free: bool(rawLane.free, false),
          healthFields: Array.isArray(rawLane.healthFields) ? rawLane.healthFields.filter((f) => typeof f === "string") : ["health", "status"],
          weightFields: Array.isArray(rawLane.weightFields) ? rawLane.weightFields.filter((f) => typeof f === "string") : ["weight"],
          governingWindowField: typeof rawLane.governingWindowField === "string" ? rawLane.governingWindowField : "governing_window",
          windowSecondsField: typeof rawLane.windowSecondsField === "string" ? rawLane.windowSecondsField : "window_seconds",
          staleAfterSecondsField: typeof rawLane.staleAfterSecondsField === "string" ? rawLane.staleAfterSecondsField : "staleAfterSeconds",
          windows
        },
        policy: {
          ...typeof rawLane.margin === "number" ? { margin: rawLane.margin } : {},
          ...typeof rawLane.urgentResetSeconds === "number" ? { urgentResetSeconds: rawLane.urgentResetSeconds } : {},
          ...typeof rawLane.maxSnapshotAgeSeconds === "number" ? { maxSnapshotAgeSeconds: rawLane.maxSnapshotAgeSeconds } : {}
        }
      }
    ];
  }) : [];
  return {
    selection: {
      enabled: bool(selection.enabled, true),
      mode: selection.mode === "enforce" ? "enforce" : "advise",
      defaultTier: tier(selection.defaultTier, "T1"),
      stickyModelWithinIssue: bool(selection.stickyModelWithinIssue, true),
      holdOnUntrustedProfile: bool(selection.holdOnUntrustedProfile, true),
      objective: selection.objective === "cost-per-accepted-card" ? "cost-per-accepted-card" : "list-price"
    },
    models,
    tierLabelIds,
    operatorLabelId,
    profiles: {
      windowDays: num(profiles.windowDays, 7),
      minSamples: num(profiles.minSamples, 5),
      maxAgeDays: num(profiles.maxAgeDays, 14)
    },
    quality: {
      t1EscalationCeiling: num(quality.t1EscalationCeiling, 0.05),
      t2EscalationCeiling: num(quality.t2EscalationCeiling, 0.15),
      silentFailureWeight: num(quality.silentFailureWeight, 10)
    },
    pacing: {
      mode: PACING_MODES.includes(pacing.mode) ? pacing.mode : "shadow",
      lanes,
      slotFloorFraction: num(pacing.slotFloorFraction, DEFAULT_SLOT_FLOOR_FRACTION),
      operatorOverrideTtlSeconds: num(pacing.operatorOverrideTtlSeconds, DEFAULT_OPERATOR_OVERRIDE_TTL_SECONDS),
      idleRepinHysteresisSeconds: num(pacing.idleRepinHysteresisSeconds, DEFAULT_IDLE_REPIN_HYSTERESIS_SECONDS)
    },
    earnIn: {
      enabled: bool(earnIn.enabled, false),
      perModelPerWeek: num(earnIn.perModelPerWeek, 8),
      maxActivePerModel: num(earnIn.maxActivePerModel, 1),
      maxActivePerLane: num(earnIn.maxActivePerLane, 1),
      classes: Array.isArray(earnIn.classes) ? earnIn.classes.filter((c) => typeof c === "string") : ["research", "review"],
      stopOnFirstNFailures: num(earnIn.stopOnFirstNFailures, 2),
      stopWindow: num(earnIn.stopWindow, 8)
    },
    shadowEmit: {
      enabled: bool(shadowEmit.enabled, false),
      maxRecords: num(shadowEmit.maxRecords, 5e3)
    }
  };
}
function validateConfig(config) {
  const errors = [];
  const warnings = [];
  const seen = /* @__PURE__ */ new Set();
  for (const model of config.models) {
    const rosterKey = `${model.id}::${model.tier}`;
    if (seen.has(rosterKey)) errors.push(`duplicate model+tier row: ${model.id} ${model.tier}`);
    seen.add(rosterKey);
    if (!Number.isFinite(Date.parse(`${model.releasedAt}T00:00:00.000Z`))) {
      errors.push(`invalid releasedAt date: ${model.id} ${model.tier} ${model.releasedAt}`);
    }
    if (model.costPerMTokCacheRead === 0 && model.costPerMTokIn > 0) {
      warnings.push(
        `${model.id} has costPerMTokCacheRead 0 \u2014 cache read is the largest cost line; a zero rate hides it`
      );
    }
  }
  if (config.selection.enabled && config.models.length === 0) {
    warnings.push("selection is enabled but no models are configured; every decision will be no-eligible-model");
  }
  for (const t of TIERS) {
    if (!config.models.some((model) => model.enabled && model.tier === t)) {
      warnings.push(`no enabled model at tier ${t}`);
    }
  }
  if (config.selection.mode === "enforce" && Object.keys(config.tierLabelIds).length === 0) {
    warnings.push(
      "no tierLabelIds configured; overrides will be written without a tier:* label, because the plugin cannot resolve a label id from its name"
    );
  }
  if (config.selection.mode === "enforce") {
    warnings.push(
      "mode is enforce: this plugin will write assigneeAdapterOverrides. Confirm Stage 2 is stable before running this alongside another live selection change."
    );
  }
  const laneIds = /* @__PURE__ */ new Set();
  for (const lane of config.pacing.lanes) {
    if (laneIds.has(lane.laneId)) errors.push(`duplicate lane id: ${lane.laneId}`);
    laneIds.add(lane.laneId);
    const secretError = validateSecretRefShape(lane.apiKeySecretRef, `pacing.lanes.${lane.laneId}.apiKeySecretRef`);
    if (secretError) errors.push(secretError);
  }
  if (config.pacing.mode !== "off" && config.pacing.lanes.length === 0) {
    warnings.push(`pacing.mode is ${config.pacing.mode} but no lanes are configured; pace ordering has nothing to key on`);
  }
  if (config.pacing.mode === "enforce" && config.pacing.slotFloorFraction <= 0) {
    errors.push("pacing.slotFloorFraction must stay above 0 while lanes are serviceable \u2014 ahead-of-line throttling must never reach zero");
  }
  if (config.selection.objective === "cost-per-accepted-card") {
    warnings.push(
      "selection.objective is cost-per-accepted-card: candidate ordering now depends on the card ledger, not just list price. Confirm the 7-day shadow diff agreed before this was switched."
    );
  }
  if (config.earnIn.enabled) {
    warnings.push(
      "earnIn.enabled is true: unproven T1 candidates may be dispatched bounded research/review work. Confirm lane and pace posture gates are live before relying on this."
    );
  }
  if (config.pacing.mode !== "off") {
    const referencedLaneIds = /* @__PURE__ */ new Set();
    for (const model of config.models) {
      if (model.laneId) referencedLaneIds.add(model.laneId);
    }
    for (const laneId of referencedLaneIds) {
      if (!laneIds.has(laneId)) {
        errors.push(
          `model roster references laneId "${laneId}", which is not in pacing.lanes \u2014 pace routing for that model would silently never activate`
        );
      }
    }
  }
  return { errors, warnings };
}

// src/engine/cost.ts
var MIN_PROFILE_SAMPLES = 5;
var PROFILE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1e3;
function tierIndex(tier2) {
  return TIER_ORDER.indexOf(tier2);
}
function tierAbove(tier2) {
  return TIER_ORDER[tierIndex(tier2) + 1] ?? null;
}
function resolveProfile(tier2, profiles, now) {
  const profile = profiles.find((entry) => entry.tier === tier2) ?? null;
  if (!profile) {
    return { profile: null, trusted: false, reason: `no volume profile recorded for ${tier2}` };
  }
  if (profile.sampleCount < MIN_PROFILE_SAMPLES) {
    return {
      profile,
      trusted: false,
      reason: `${tier2} profile has ${profile.sampleCount} runs, below the ${MIN_PROFILE_SAMPLES}-run minimum`
    };
  }
  const age = now - Date.parse(profile.computedAt);
  if (!Number.isFinite(age)) {
    return { profile, trusted: false, reason: `${tier2} profile has an unparseable computedAt` };
  }
  if (age > PROFILE_MAX_AGE_MS) {
    const days = Math.round(age / (24 * 60 * 60 * 1e3));
    return { profile, trusted: false, reason: `${tier2} profile is ${days} days old` };
  }
  return { profile, trusted: true, reason: `${tier2} profile: ${profile.sampleCount} runs` };
}
function runCost(model, profile) {
  const inputCostUsd = profile.avgInputTokens / 1e6 * model.costPerMTokIn;
  const cacheReadCostUsd = profile.avgCacheReadTokens / 1e6 * model.costPerMTokCacheRead;
  const outputCostUsd = profile.avgOutputTokens / 1e6 * model.costPerMTokOut;
  return {
    inputCostUsd,
    cacheReadCostUsd,
    outputCostUsd,
    runCostUsd: inputCostUsd + cacheReadCostUsd + outputCostUsd
  };
}
function escalationRisk(tier2, models, profiles, signals, now) {
  const above = tierAbove(tier2);
  if (!above) return 0;
  const signal = signals.find((entry) => entry.tier === tier2);
  if (!signal || signal.sampleCount <= 0) return 0;
  const silentRate = signal.silentFailureCount * 10 / signal.sampleCount;
  const effectiveRate = Math.min(1, Math.max(0, signal.escalationRate) + silentRate);
  if (effectiveRate <= 0) return 0;
  const verdict = resolveProfile(above, profiles, now);
  if (!verdict.profile) return 0;
  const redo = models.filter((model) => model.enabled && !model.fallbackOnly && model.tier === above).map((model) => runCost(model, verdict.profile).runCostUsd).sort((left, right) => left - right)[0];
  return redo === void 0 ? 0 : redo * effectiveRate;
}
function costOf(model, profileTier, profiles, models, signals, now) {
  const verdict = resolveProfile(profileTier, profiles, now);
  if (!verdict.profile) return null;
  const direct = runCost(model, verdict.profile);
  const escalationRiskUsd = escalationRisk(model.tier, models, profiles, signals, now);
  return {
    modelId: model.id,
    ...direct,
    escalationRiskUsd,
    expectedCostUsd: direct.runCostUsd + escalationRiskUsd,
    profileTier,
    profileTrusted: verdict.trusted
  };
}

// src/engine/objective.ts
function costPerAcceptedCardFor(modelId, tier2, ledger) {
  return ledger[`${modelId}:${tier2}`]?.costPerAcceptedCard ?? null;
}
function orderByCostPerAcceptedCard(candidates, ledger) {
  return candidates.map((candidate) => ({ candidate, cost: costPerAcceptedCardFor(candidate.modelId, candidate.tier, ledger) })).filter((row) => row.cost !== null).sort((a, b) => a.cost - b.cost || a.candidate.modelId.localeCompare(b.candidate.modelId)).map((row) => row.candidate);
}
function computeShadowDiff(issueId, tier2, candidates, listPriceWinnerId, ledger) {
  if (listPriceWinnerId === null) return null;
  const byCard = orderByCostPerAcceptedCard(candidates, ledger);
  const costPerAcceptedCardWinner = byCard[0]?.modelId ?? null;
  if (costPerAcceptedCardWinner === null) return null;
  return {
    issueId,
    tier: tier2,
    listPriceWinner: listPriceWinnerId,
    costPerAcceptedCardWinner,
    agree: costPerAcceptedCardWinner === listPriceWinnerId
  };
}
function orderByObjective(candidates, objective, ledger) {
  if (objective === "list-price") return [...candidates];
  const reordered = orderByCostPerAcceptedCard(candidates, ledger);
  return reordered.length > 0 ? reordered : [...candidates];
}

// src/engine/tier.ts
function isTier(value) {
  return TIERS.includes(value);
}
function tierFromLabels(labelNames) {
  if (!labelNames) return null;
  const found = [];
  for (const name of labelNames) {
    if (!name.startsWith(TIER_LABEL_PREFIX)) continue;
    const suffix = name.slice(TIER_LABEL_PREFIX.length);
    if (isTier(suffix)) found.push(suffix);
  }
  if (found.length === 0) return null;
  return found.sort((left, right) => TIER_ORDER.indexOf(right) - TIER_ORDER.indexOf(left))[0];
}
function tierOfModel(modelId, models) {
  if (!modelId) return null;
  const matches = models.filter((model) => model.id === modelId && model.enabled);
  if (matches.length === 0) return null;
  return matches.reduce(
    (highest, model) => TIER_ORDER.indexOf(model.tier) > TIER_ORDER.indexOf(highest) ? model.tier : highest,
    matches[0].tier
  );
}
function resolveTier(descriptor, models, configDefaultTier, options) {
  if (descriptor.exclusion?.excluded) {
    return {
      tier: "T1",
      source: "capability-exclusion",
      detail: `capability exclusion forces T1: ${descriptor.exclusion.reasons.join("; ") || "unspecified"}`
    };
  }
  const pinnedMatches = models.filter((model) => model.id === descriptor.pinnedModelId && model.enabled);
  const servicablePinnedMatches = pinnedMatches.filter(
    (model) => !(options?.isLaneUnserviceable?.(model) ?? false)
  );
  if (pinnedMatches.length > 0 && servicablePinnedMatches.length === 0) {
  } else if (servicablePinnedMatches.length > 0) {
    const pinnedTier = servicablePinnedMatches.reduce(
      (highest, model) => TIER_ORDER.indexOf(model.tier) > TIER_ORDER.indexOf(highest) ? model.tier : highest,
      servicablePinnedMatches[0].tier
    );
    return {
      tier: pinnedTier,
      source: "issue-override",
      detail: `assigneeAdapterOverrides pins ${descriptor.pinnedModelId} (${pinnedTier})`
    };
  }
  const labelTier = tierFromLabels(descriptor.labelNames);
  if (labelTier) {
    return { tier: labelTier, source: "issue-label", detail: `${TIER_LABEL_PREFIX}${labelTier} label on the issue` };
  }
  const floorTier = tierOfModel(descriptor.agentFloorModelId, models);
  if (floorTier) {
    return {
      tier: floorTier,
      source: "agent-floor",
      detail: `no issue-level judgement; assignee floor ${descriptor.agentFloorModelId} (${floorTier})`
    };
  }
  return {
    tier: configDefaultTier,
    source: "config-default",
    detail: `no judgement and no recognised agent floor; config default ${configDefaultTier}`
  };
}

// src/engine/select.ts
function selectModel(input) {
  const { descriptor, config, profiles, signals, now } = input;
  const trace = [];
  const rejections = [];
  const pacingMode = config.pacingMode ?? "shadow";
  const paceActive = pacingMode !== "off";
  const paceEnforced = pacingMode === "enforce";
  const ledger = config.laneLedger ?? {};
  const slotFloorFraction = config.slotFloorFraction ?? 0.25;
  const overrideModelId = config.operatorOverrideModelId ?? null;
  const judgement = resolveTier(descriptor, config.models, config.defaultTier, {
    isLaneUnserviceable: (model) => paceActive && hardStopExcluded(ledger, model)
  });
  trace.push(`tier ${judgement.tier} via ${judgement.source} \u2014 ${judgement.detail}`);
  const base = {
    outcome: "no-eligible-model",
    modelId: null,
    judgement,
    effectiveTier: null,
    candidates: [],
    rejections,
    trace,
    advisory: !config.enforcementEnabled,
    heldReason: null,
    pacingApplied: false,
    shadowDiff: null,
    escalatedFromTier: null
  };
  if (config.models.length === 0) {
    trace.push("no models configured for this company");
    return { ...base, outcome: "disabled" };
  }
  trace.push(`tier floor ${judgement.tier}: no lower-capability model is eligible`);
  if (config.stickyWithinIssue && descriptor.stickyModelId) {
    const incumbent = config.models.find(
      (model) => model.id === descriptor.stickyModelId && model.enabled
    );
    const incumbentUnserviceable = incumbent && paceActive && hardStopExcluded(ledger, incumbent);
    if (incumbent && tierIndex(incumbent.tier) < tierIndex(judgement.tier)) {
      trace.push(
        `sticky ${incumbent.id} (${incumbent.tier}) declined: below the ${judgement.tier} required tier`
      );
      rejections.push({
        modelId: incumbent.id,
        stage: "tier-floor",
        reason: `tier ${incumbent.tier} is below the ${judgement.tier} required tier`
      });
    } else if (incumbent && incumbentUnserviceable) {
      trace.push(
        `sticky ${incumbent.id} declined: lane ${incumbent.laneId ?? "(none)"} is not serviceable \u2014 re-selecting instead of wedging this issue on a dead lane`
      );
      rejections.push({
        modelId: incumbent.id,
        stage: "lane-unserviceable",
        reason: `lane ${incumbent.laneId ?? "(none)"} is not serviceable`
      });
    } else if (incumbent) {
      trace.push(
        `sticky: ${incumbent.id} is already running this issue \u2014 switching would reset the session and discard the prompt cache`
      );
      return { ...base, outcome: "selected", modelId: incumbent.id, effectiveTier: incumbent.tier };
    }
  }
  const requiredTier = judgement.tier;
  const required = new Set(descriptor.requiredCapabilities ?? []);
  if (required.size > 0) {
    trace.push(`hard capability gate: ${[...required].sort().join(", ")}`);
  }
  const qualified = [];
  for (const model of config.models) {
    if (!model.enabled) {
      rejections.push({ modelId: model.id, stage: "disabled", reason: "disabled in the roster" });
      continue;
    }
    const missing = [...required].filter((capability) => !model.capabilities.includes(capability));
    if (missing.length > 0) {
      rejections.push({
        modelId: model.id,
        stage: "capability",
        reason: `missing ${missing.sort().join(", ")}`
      });
      continue;
    }
    if (tierIndex(model.tier) < tierIndex(requiredTier)) {
      rejections.push({
        modelId: model.id,
        stage: "tier-floor",
        reason: `tier ${model.tier} is below the ${requiredTier} required tier`
      });
      continue;
    }
    if (typeof descriptor.requiredContextTokens === "number" && model.contextWindow < descriptor.requiredContextTokens) {
      rejections.push({
        modelId: model.id,
        stage: "context-window",
        reason: `context window ${model.contextWindow} < required ${descriptor.requiredContextTokens}`
      });
      continue;
    }
    if (paceActive && hardStopExcluded(ledger, model)) {
      rejections.push({
        modelId: model.id,
        stage: "lane-unserviceable",
        reason: `lane ${model.laneId ?? "(none)"} is not serviceable`
      });
      continue;
    }
    qualified.push(model);
  }
  if (qualified.length === 0) {
    const atOrAboveRequired = rejections.filter((rejection) => {
      const rejectedModel = config.models.find((entry) => entry.id === rejection.modelId);
      return rejectedModel ? tierIndex(rejectedModel.tier) >= tierIndex(requiredTier) : false;
    });
    const tierExhausted = atOrAboveRequired.length > 0 && atOrAboveRequired.every((rejection) => rejection.stage === "lane-unserviceable");
    if (tierExhausted) {
      trace.push(
        `tier exhausted: every candidate from ${requiredTier} through the T1 ceiling was excluded by the pace serviceability hard stop (${atOrAboveRequired.length} rejection${atOrAboveRequired.length === 1 ? "" : "s"}) \u2014 nowhere left to escalate to`
      );
      return { ...base, outcome: "tier-exhausted", effectiveTier: requiredTier };
    }
    trace.push(`no model cleared the gates (${rejections.length} rejected)`);
    return base;
  }
  const profileVerdict = resolveProfile(requiredTier, profiles, now);
  trace.push(`volume profile: ${profileVerdict.reason}`);
  function costCandidates(models) {
    const candidates2 = [];
    for (const model of models) {
      const cost = costOf(model, requiredTier, profiles, config.models, signals, now);
      if (!cost) {
        rejections.push({
          modelId: model.id,
          stage: "no-profile",
          reason: `no volume profile for ${requiredTier}; cannot cost this candidate`
        });
        continue;
      }
      candidates2.push({
        ...cost,
        tier: model.tier,
        releasedAt: model.releasedAt,
        fallbackOnly: model.fallbackOnly
      });
    }
    return candidates2;
  }
  let candidates = [];
  let landingTier = requiredTier;
  for (let rung = requiredTier; rung !== null; rung = tierAbove(rung)) {
    const atRung = qualified.filter((model) => model.tier === rung);
    if (atRung.length === 0) continue;
    let rungCandidates = costCandidates(atRung.filter((model) => !model.fallbackOnly));
    if (rungCandidates.length === 0) {
      const fallbackModels = atRung.filter((model) => model.fallbackOnly);
      if (fallbackModels.length > 0) {
        trace.push(`no regular candidate survived at ${rung}; considering fallback-only roster rows`);
        rungCandidates = costCandidates(fallbackModels);
      }
    }
    if (rungCandidates.length > 0) {
      landingTier = rung;
      candidates = rungCandidates;
      break;
    }
  }
  if (candidates.length === 0) {
    trace.push("no candidate could be costed \u2014 refusing to choose on a guessed volume term");
    return { ...base, effectiveTier: requiredTier };
  }
  const escalatedFromTier = landingTier !== requiredTier ? requiredTier : null;
  if (escalatedFromTier) {
    trace.push(
      `escalated from ${requiredTier} to ${landingTier}: no candidate at ${requiredTier} survived the gates or could be costed`
    );
  }
  candidates.sort((left, right) => {
    if (left.expectedCostUsd !== right.expectedCostUsd) {
      return left.expectedCostUsd - right.expectedCostUsd;
    }
    const releaseOrder = Date.parse(right.releasedAt) - Date.parse(left.releasedAt);
    if (releaseOrder !== 0) return releaseOrder;
    return left.modelId.localeCompare(right.modelId);
  });
  let orderedCandidates = candidates;
  if (paceActive) {
    const paceOrdered = orderCandidatesByPace(candidates, config.models, ledger);
    const changed = paceOrdered.some((candidate, index) => candidate.modelId !== candidates[index]?.modelId);
    trace.push(
      changed ? `pace ordering (${pacingMode}) reorders to ${paceOrdered.map((c) => c.modelId).join(" > ")}` : `pace ordering (${pacingMode}) agrees with cost ordering`
    );
    const preferredId = preferredCandidateId(candidates, config.models, ledger);
    if (preferredId) {
      trace.push(`${preferredId}'s lane is trailing pace near its reset window close \u2014 preferred for new dispatch`);
    }
    if (paceEnforced) orderedCandidates = paceOrdered;
  }
  function pickWinnerIndex(ordered) {
    const overrideIndex = overrideModelId ? ordered.findIndex((candidate) => candidate.modelId === overrideModelId) : -1;
    if (overrideIndex >= 0) return overrideIndex;
    const allowedIndex = ordered.findIndex((candidate) => {
      const model = config.models.find((entry) => entry.id === candidate.modelId);
      return !model || slotAllowed(descriptor.issueId, ledger, model, slotFloorFraction);
    });
    return allowedIndex >= 0 ? allowedIndex : 0;
  }
  let paceWinnerIndex = 0;
  if (paceEnforced) {
    paceWinnerIndex = pickWinnerIndex(orderedCandidates);
    const overrideIndex = overrideModelId ? orderedCandidates.findIndex((candidate) => candidate.modelId === overrideModelId) : -1;
    if (overrideIndex >= 0 && overrideIndex === paceWinnerIndex) {
      if (overrideIndex !== 0) {
        trace.push(`operator override: routing to ${overrideModelId} ahead of pace ordering and slot throttling`);
      }
    } else if (paceWinnerIndex !== 0) {
      trace.push(
        `slot throttle: ${orderedCandidates[0].modelId} deferred (ahead-of-line, floor ${slotFloorFraction}); using ${orderedCandidates[paceWinnerIndex].modelId}`
      );
    }
  }
  const paceOnlyWinner = orderedCandidates[paceWinnerIndex];
  const pacingApplied = paceEnforced && paceOnlyWinner.modelId !== candidates[0].modelId;
  const listPriceWinner = candidates[0];
  const cardLedger = input.cardLedger ?? {};
  const shadowDiff = computeShadowDiff(descriptor.issueId, landingTier, candidates, listPriceWinner.modelId, cardLedger);
  const objective = config.objective ?? "list-price";
  let winner = paceOnlyWinner;
  if (objective === "cost-per-accepted-card") {
    const objectiveOrdered = orderByObjective(orderedCandidates, objective, cardLedger);
    if (objectiveOrdered.length > 0) {
      winner = paceEnforced ? objectiveOrdered[pickWinnerIndex(objectiveOrdered)] : objectiveOrdered[0];
    }
  }
  const withCandidates = {
    ...base,
    candidates,
    effectiveTier: landingTier,
    pacingApplied,
    shadowDiff,
    escalatedFromTier
  };
  if (config.holdOnUntrustedProfile && !winner.profileTrusted) {
    const reason = `volume profile for ${requiredTier} is not trusted (${profileVerdict.reason})`;
    trace.push(`held at agent floor: ${reason}`);
    return { ...withCandidates, outcome: "held-at-floor", heldReason: reason };
  }
  trace.push(
    `selected ${winner.modelId} at an expected $${winner.expectedCostUsd.toFixed(4)}/run (direct $${winner.runCostUsd.toFixed(4)} = in $${winner.inputCostUsd.toFixed(4)} + cache-read $${winner.cacheReadCostUsd.toFixed(4)} + out $${winner.outputCostUsd.toFixed(4)}; escalation risk $${winner.escalationRiskUsd.toFixed(4)}) \u2014 cheapest of ${candidates.length}; exact ties prefer newest releasedAt then stable model id${winner.fallbackOnly ? "; fallback-only path" : ""}`
  );
  if (!config.enforcementEnabled) {
    trace.push("advisory mode: enforcement is off, so this decision is recorded and not written");
  }
  return { ...withCandidates, outcome: "selected", modelId: winner.modelId };
}

// src/engine/ancillary.ts
var ANCILLARY_ENV_KEYS = ["ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"];
var ANTHROPIC_DEFAULT_PREFIX = "ANTHROPIC_DEFAULT_";
var CHEAP_PROFILE_SURFACE = "runtimeConfig.modelProfiles.cheap";
function remediationFor(surface) {
  if (surface === CHEAP_PROFILE_SURFACE) {
    return "no ctx.agents write method exists in the plugin SDK, so this plugin can only report the drift; a differently-authenticated operator tool with a direct PATCH /api/agents/{id} can act on it (docs/model-lane-probe.md)";
  }
  return "console only \u2014 adapterConfig is 403 to every agent, structurally; this plugin has no write path to it either";
}
function recommendAncillaryModel(input) {
  return selectModel({
    descriptor: { issueId: "__ancillary_t3__", labelNames: ["tier:T3"] },
    config: {
      ...input.config,
      // Always advisory: a company-wide ancillary recommendation is never
      // something this tool writes, regardless of `selection.mode`.
      enforcementEnabled: false,
      defaultTier: "T3",
      stickyWithinIssue: false,
      operatorOverrideModelId: null
    },
    profiles: input.profiles,
    signals: input.signals,
    now: input.now
  });
}
function envBindingModelId(binding) {
  if (typeof binding === "string") return { modelId: binding, unresolvable: false };
  if (binding && typeof binding === "object") {
    const record2 = binding;
    if (record2.type === "plain" && typeof record2.value === "string") {
      return { modelId: record2.value, unresolvable: false };
    }
    if (record2.type === "secret_ref" || record2.type === "user_secret_ref") {
      return { modelId: null, unresolvable: true };
    }
  }
  return { modelId: null, unresolvable: false };
}
function readAncillarySurfaces(agent) {
  const readings = [];
  const env = agent.adapterConfig && typeof agent.adapterConfig === "object" ? agent.adapterConfig.env : void 0;
  if (env && typeof env === "object") {
    const ancillaryKeys = new Set(ANCILLARY_ENV_KEYS);
    for (const key of Object.keys(env)) {
      if (!ancillaryKeys.has(key) && !key.startsWith(ANTHROPIC_DEFAULT_PREFIX)) continue;
      const { modelId, unresolvable } = envBindingModelId(env[key]);
      readings.push({ surface: key, currentModelId: modelId, unresolvable });
    }
  }
  const runtimeConfig = agent.runtimeConfig && typeof agent.runtimeConfig === "object" ? agent.runtimeConfig : null;
  const modelProfiles = runtimeConfig && typeof runtimeConfig.modelProfiles === "object" && runtimeConfig.modelProfiles ? runtimeConfig.modelProfiles : null;
  const cheap = modelProfiles && typeof modelProfiles.cheap === "object" && modelProfiles.cheap ? modelProfiles.cheap : null;
  if (cheap) {
    const adapterConfig = cheap.adapterConfig && typeof cheap.adapterConfig === "object" ? cheap.adapterConfig : null;
    const modelId = adapterConfig && typeof adapterConfig.model === "string" ? adapterConfig.model : null;
    readings.push({ surface: CHEAP_PROFILE_SURFACE, currentModelId: modelId, unresolvable: false });
  }
  return readings;
}
function ancillaryDriftForAgent(agent, recommendedModelId) {
  if (!recommendedModelId) return [];
  return readAncillarySurfaces(agent).filter(
    (reading) => !reading.unresolvable && reading.currentModelId !== null && reading.currentModelId !== recommendedModelId
  ).map((reading) => ({
    ...reading,
    agentId: agent.id,
    agentName: agent.name,
    recommendedModelId,
    remediation: remediationFor(reading.surface)
  }));
}

// src/engine/profiles.ts
function buildVolumeProfiles(rows, models, computedAt) {
  const tiersOf = /* @__PURE__ */ new Map();
  for (const model of models) {
    if (!model.enabled) continue;
    const tiers = tiersOf.get(model.id) ?? [];
    if (!tiers.includes(model.tier)) tiers.push(model.tier);
    tiersOf.set(model.id, tiers);
  }
  const buckets = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const tiers = row.model ? tiersOf.get(row.model) : void 0;
    if (!tiers || tiers.length !== 1) continue;
    const tier2 = tiers[0];
    const input = row.inputTokens ?? 0;
    const cache = row.cachedInputTokens ?? 0;
    const output = row.outputTokens ?? 0;
    if (input === 0 && cache === 0 && output === 0) continue;
    const bucket = buckets.get(tier2) ?? { n: 0, input: 0, cache: 0, output: 0 };
    bucket.n += 1;
    bucket.input += input;
    bucket.cache += cache;
    bucket.output += output;
    buckets.set(tier2, bucket);
  }
  return [...buckets.entries()].map(([tier2, bucket]) => ({
    tier: tier2,
    sampleCount: bucket.n,
    computedAt,
    avgInputTokens: bucket.input / bucket.n,
    avgCacheReadTokens: bucket.cache / bucket.n,
    avgOutputTokens: bucket.output / bucket.n
  }));
}
function buildQualitySignals(rows, computedAt) {
  return rows.map((row) => ({
    tier: row.tier,
    escalationRate: row.issues > 0 ? row.escalations / row.issues : 0,
    silentFailureCount: row.silentFailures,
    sampleCount: row.issues,
    computedAt
  }));
}

// src/engine/scores.ts
function priorP(aaIndex) {
  if (aaIndex === null) return 0.8;
  return Math.max(0.55, Math.min(1, 0.55 + 0.45 * (aaIndex / 60)));
}
function emptyTierScoreStats() {
  return { n: 0, ok: 0, failInfra: 0, failModel: 0, tmo: 0, wOk: 0, wBad: 0, rework: 0, okCost: [], okMins: [] };
}
function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const lo = sorted[mid - 1];
    const hi = sorted[mid];
    return (lo + hi) / 2;
  }
  return sorted[mid];
}
function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
function summarize(stats, tier2, priorPValue, priorK = SCORE_PRIOR_K, provenN = SCORE_PROVEN_N, thresholds = SCORE_THRESHOLDS) {
  const nEff = stats.wOk + stats.wBad;
  const pObs = nEff > 0 ? stats.wOk / nEff : null;
  const p = (stats.wOk + priorK * priorPValue) / (nEff + priorK);
  const thr = tier2 === null ? void 0 : thresholds[tier2];
  const proven = stats.ok + stats.failModel + stats.tmo >= provenN;
  let capable = null;
  if (thr !== void 0) {
    capable = p >= thr;
    if (proven && pObs !== null && pObs < thr - 0.1) capable = false;
  }
  return {
    n: stats.n,
    ok: stats.ok,
    failInfra: stats.failInfra,
    failModel: round(stats.failModel, 1),
    tmo: stats.tmo,
    nEff: round(nEff, 1),
    pObs: pObs === null ? null : round(pObs, 3),
    p: round(p, 3),
    capable,
    proven,
    costPerSuccessUsd: stats.okCost.length ? round(median(stats.okCost), 3) : null,
    medMin: stats.okMins.length ? round(median(stats.okMins), 1) : null,
    rework: stats.rework
  };
}
function buildModelScore(modelId, aaIndex, statsByTier, tiers) {
  const pp = priorP(aaIndex);
  const tierScores = {};
  for (const tier2 of tiers) {
    const stats = statsByTier[tier2];
    tierScores[tier2] = stats ? summarize(stats, tier2, pp) : {
      n: 0,
      ok: 0,
      failInfra: 0,
      failModel: 0,
      tmo: 0,
      nEff: 0,
      pObs: null,
      p: round(pp, 3),
      capable: pp >= SCORE_THRESHOLDS[tier2],
      proven: false,
      costPerSuccessUsd: null,
      medMin: null,
      rework: 0
    };
  }
  const agg = emptyTierScoreStats();
  for (const tier2 of tiers) {
    const stats = statsByTier[tier2];
    if (!stats) continue;
    agg.n += stats.n;
    agg.ok += stats.ok;
    agg.failInfra += stats.failInfra;
    agg.failModel += stats.failModel;
    agg.tmo += stats.tmo;
    agg.wOk += stats.wOk;
    agg.wBad += stats.wBad;
    agg.rework += stats.rework;
    agg.okCost.push(...stats.okCost);
    agg.okMins.push(...stats.okMins);
  }
  return {
    modelId,
    aaIndex,
    priorP: round(pp, 3),
    tiers: tierScores,
    overall: summarize(agg, null, pp)
  };
}
var FREE_LANE_RE = /(-free$|^big-pickle$|-alpha$|-preview$)/;
var MODEL_FAIL_RE = /flagged for possible cybersecurity|exceeded the adapter execution timeout|timeoutSec|refus/i;
var INFRA_RE = /503|502|529|Overloaded|429|exhausted|All credentials|circuit breaker|Stream idle timeout|Stream ended|stalled mid-stream|stopped arriving|mid-response|disabled Claude subscription|ECONN|process_lost|all upstream accounts|not supported for format|issue with the selected model|budget_paused|Missing required permissions|recovery backstop|sandbox gone|401|404/i;
function normModelId(modelId) {
  return modelId.replace(/^(cliproxy\/|openrouter\/|opencode-go\/)/, "");
}
function classifyRunFailure(errorText, errorCode, modelId) {
  if (FREE_LANE_RE.test(normModelId(modelId))) return { kind: "model", weight: 1 };
  if (errorCode === "timeout" || MODEL_FAIL_RE.test(errorText ?? "")) return { kind: "model", weight: 1 };
  if (INFRA_RE.test(errorText ?? "")) return { kind: "infra", weight: 0 };
  if (/400 status code \(no body\)/.test(errorText ?? "")) return { kind: "model", weight: 0.5 };
  return { kind: "model", weight: 0.5 };
}
function accumulateRunStats(rows) {
  const out = {};
  for (const row of rows) {
    if (row.tier === null) continue;
    const modelBucket = out[row.modelId] ?? {};
    const stats = modelBucket[row.tier] ?? emptyTierScoreStats();
    const w = Math.exp(-row.ageDays / 10);
    const next = {
      ...stats,
      n: stats.n + 1,
      okCost: [...stats.okCost],
      okMins: [...stats.okMins]
    };
    if (row.status === "succeeded") {
      next.ok += 1;
      next.wOk += w;
      if (row.costUsd !== null) next.okCost.push(row.costUsd);
      if (row.mins !== null) next.okMins.push(row.mins);
    } else if (row.status === "timed_out") {
      next.tmo += 1;
      next.wBad += w;
    } else {
      const { kind, weight } = classifyRunFailure(row.error, row.errorCode, row.modelId);
      if (kind === "infra") next.failInfra += 1;
      else {
        next.failModel += weight;
        next.wBad += w * weight;
      }
    }
    modelBucket[row.tier] = next;
    out[row.modelId] = modelBucket;
  }
  return out;
}
function foldReworkIntoStats(stats, reworkEvents) {
  const out = {};
  for (const [modelId, byTier] of Object.entries(stats)) {
    out[modelId] = { ...byTier };
  }
  for (const event of reworkEvents) {
    const weight = event.kind === "reopen" ? REWORK_WEIGHT_REOPEN : REWORK_WEIGHT_REJECTED;
    const modelBucket = out[event.modelId] ?? {};
    const tierStats = modelBucket[event.tier] ?? emptyTierScoreStats();
    modelBucket[event.tier] = {
      ...tierStats,
      failModel: tierStats.failModel + weight,
      wBad: tierStats.wBad + weight,
      rework: tierStats.rework + 1
    };
    out[event.modelId] = modelBucket;
  }
  return out;
}
function findClosingRun(issueId, atMs, windowMs, closingRuns, excludeAgentId) {
  let best = null;
  for (const run of closingRuns) {
    if (run.issueId !== issueId || run.tier === null) continue;
    if (excludeAgentId != null && run.agentId === excludeAgentId) continue;
    const delta = atMs - run.finishedAtMs;
    if (delta < 0 || delta > windowMs) continue;
    if (!best || run.finishedAtMs > best.finishedAtMs) best = run;
  }
  return best;
}
function buildCardLedger(cards, nowMs, priorPByModel, blendedListPriceByModel) {
  const byKey = /* @__PURE__ */ new Map();
  for (const card of cards) {
    const key = `${card.modelId}\0${card.tier}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(card);
    else byKey.set(key, [card]);
  }
  const out = {};
  for (const [key, rows] of byKey) {
    const [modelId, tier2] = key.split("\0");
    const censorMs = CARD_CENSOR_DAYS * 24 * 60 * 60 * 1e3;
    const resolved = rows.filter((r) => r.rejected || nowMs - r.closedAtMs >= censorMs);
    const accepted = resolved.filter((r) => !r.rejected);
    const costs = resolved.map((r) => r.costUsd).filter((c) => c !== null);
    const runs = resolved.map((r) => r.runCount);
    const foreignCount = resolved.filter((r) => r.foreignRun).length;
    const measured = resolved.length > 0;
    const acceptRate = measured ? accepted.length / resolved.length : priorPByModel[modelId] ?? 0.8;
    const costPerCard = costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : blendedListPriceByModel[modelId] ?? null;
    out[key.replace("\0", ":")] = {
      modelId,
      tier: tier2,
      cardsClosed: rows.length,
      acceptRate,
      costPerCard,
      runsPerCard: runs.length ? runs.reduce((a, b) => a + b, 0) / runs.length : null,
      foreignRunShare: resolved.length ? foreignCount / resolved.length : null,
      costPerAcceptedCard: costPerCard !== null && acceptRate > 0 ? costPerCard / acceptRate : null,
      pending: !measured
    };
  }
  return out;
}

// src/lane-capacity/value-normalization.ts
function recordOf(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function firstValue(record2, fields) {
  for (const field of fields) {
    if (field in record2) return { value: record2[field], field };
  }
  return null;
}
function fraction(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}
function timestamp(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}
function normalizeHealth(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["healthy", "available", "allowed", "ready", "ok", "active"].includes(normalized)) return "healthy";
  if (["degraded", "limited", "warning", "cooldown", "cooling_down"].includes(normalized)) return "degraded";
  if (["exhausted", "quota_exhausted", "rate_limited"].includes(normalized)) return "exhausted";
  if (["unavailable", "disabled", "offline", "error", "blocked"].includes(normalized)) return "unavailable";
  if (["unknown", "stale"].includes(normalized)) return "unknown";
  return null;
}

// src/lane-capacity/pace.ts
var SCALE = 1e3;
var DEFAULT_MARGIN = 0.1;
var DEFAULT_URGENT_RESET_SECONDS = 24 * 60 * 60;
var DEFAULT_MAX_SNAPSHOT_AGE_SECONDS = 15 * 60;
function positiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
function windowSeconds(record2, field, window) {
  const raw = record2[field];
  if (typeof raw === "number") return positiveNumber(raw);
  const mapped = recordOf(raw);
  if (mapped) {
    return positiveNumber(mapped[window.name]) ?? positiveNumber(mapped[window.name.replace(/-/g, "_")]);
  }
  return positiveNumber(window.defaultWindowSeconds);
}
function normalizedWeight(record2, fields) {
  const reported = positiveNumber(firstValue(record2, fields)?.value);
  return reported === null ? { weight: 1, source: "default" } : { weight: reported, source: "reported" };
}
function normalizeLaneDocument(input) {
  const document = recordOf(input.document);
  if (!document) {
    return { laneId: input.definition.laneId, free: Boolean(input.definition.free), observedAt: null, staleAfterSeconds: null, accounts: [], error: "invalid-document" };
  }
  const records = Array.isArray(document.records) ? document.records : [];
  const observedAt = timestamp(document.observedAt);
  const staleAfterSeconds = positiveNumber(document[input.definition.staleAfterSecondsField ?? "staleAfterSeconds"]);
  const governingWindowField = input.definition.governingWindowField ?? "governing_window";
  const windowSecondsField = input.definition.windowSecondsField ?? "window_seconds";
  const accounts = records.flatMap((value, index) => {
    const record2 = recordOf(value);
    if (!record2) return [];
    const weight = normalizedWeight(record2, input.definition.weightFields ?? ["weight"]);
    const reportedGoverningWindow = typeof record2[governingWindowField] === "string" ? record2[governingWindowField] : null;
    return [{
      accountKey: `record-${index + 1}`,
      health: normalizeHealth(firstValue(record2, input.definition.healthFields)?.value) ?? "unknown",
      weight: weight.weight,
      weightSource: weight.source,
      governingWindow: reportedGoverningWindow,
      windows: input.definition.windows.map((window) => {
        const utilization = firstValue(record2, window.utilizationFields);
        const reset = firstValue(record2, window.resetFields);
        return {
          name: window.name,
          role: window.role,
          utilization: fraction(utilization?.value),
          resetsAt: timestamp(reset?.value),
          windowSeconds: windowSeconds(record2, windowSecondsField, window),
          sourcePath: utilization?.field ?? null
        };
      })
    }];
  });
  return {
    laneId: input.definition.laneId,
    free: Boolean(input.definition.free),
    observedAt,
    staleAfterSeconds,
    accounts,
    error: records.length === 0 ? "no-records" : null
  };
}
function roundHalfEven(value) {
  const lower = Math.floor(value);
  const fraction2 = value - lower;
  if (Math.abs(fraction2 - 0.5) <= 1e-12) return lower % 2 === 0 ? lower : lower + 1;
  return Math.round(value);
}
function toMilli(value) {
  return roundHalfEven(Math.min(1, Math.max(0, value)) * SCALE);
}
function score(utilizationMilli, elapsedMilli) {
  return {
    utilization: utilizationMilli / SCALE,
    elapsed: elapsedMilli / SCALE,
    deviation: (utilizationMilli - elapsedMilli) / SCALE
  };
}
function weightedMilli(values) {
  const weight = values.reduce((sum, entry) => sum + entry.weight, 0);
  return roundHalfEven(values.reduce((sum, entry) => sum + entry.value * entry.weight, 0) / weight);
}
function governingWindow(account) {
  let fallback = null;
  for (const window of account.windows) {
    if (window.role !== "allowance" || window.utilization === null || window.resetsAt === null || window.windowSeconds === null) continue;
    if (window.name === account.governingWindow) return window;
    if (fallback === null || window.windowSeconds > fallback.windowSeconds || window.windowSeconds === fallback.windowSeconds && window.name < fallback.name) fallback = window;
  }
  return fallback;
}
function serviceable(account, governing) {
  if (account.health === "exhausted" || account.health === "unavailable") return false;
  if (governing?.utilization !== null && governing && governing.utilization >= 1) return false;
  return account.windows.every(
    (window) => window.role !== "serviceability" || window.utilization === null || window.utilization < 1
  );
}
function stateFor(deviationMilli, marginMilli) {
  if (deviationMilli > marginMilli) return "ahead";
  if (deviationMilli < -marginMilli) return "behind";
  return "on";
}
function evaluateLanePace(input) {
  const marginMilli = toMilli(input.policy?.margin ?? DEFAULT_MARGIN);
  const urgentResetSeconds = input.policy?.urgentResetSeconds ?? DEFAULT_URGENT_RESET_SECONDS;
  const maxSnapshotAgeSeconds = input.policy?.maxSnapshotAgeSeconds ?? DEFAULT_MAX_SNAPSHOT_AGE_SECONDS;
  const asOf = timestamp(input.asOf ?? input.observation.observedAt);
  if (input.observation.free) {
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "free", serviceable: true, score: null, accounts: [], knownAccountCount: 0, knownWeight: 0, serviceableAccountCount: 0, urgentResetAt: null, reason: "free-lane" };
  }
  if (input.observation.error === "invalid-document" || input.observation.observedAt === null || asOf === null) {
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "unknown", serviceable: null, score: null, accounts: [], knownAccountCount: 0, knownWeight: 0, serviceableAccountCount: 0, urgentResetAt: null, reason: "document-unavailable" };
  }
  if (input.observation.error === "no-records") {
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "unknown", serviceable: null, score: null, accounts: [], knownAccountCount: 0, knownWeight: 0, serviceableAccountCount: 0, urgentResetAt: null, reason: "no-records" };
  }
  const observedAtMs = Date.parse(input.observation.observedAt);
  const asOfMs = Date.parse(asOf);
  const freshnessBudget = Math.min(input.observation.staleAfterSeconds ?? maxSnapshotAgeSeconds, maxSnapshotAgeSeconds);
  if ((asOfMs - observedAtMs) / 1e3 > freshnessBudget) {
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "unknown", serviceable: null, score: null, accounts: [], knownAccountCount: 0, knownWeight: 0, serviceableAccountCount: 0, urgentResetAt: null, reason: "snapshot-stale" };
  }
  const internal = input.observation.accounts.map((account) => {
    const governing = governingWindow(account);
    const accountServiceable = serviceable(account, governing);
    if (!governing) {
      const exhausted2 = account.health === "exhausted" || account.health === "unavailable";
      return {
        verdict: { accountKey: account.accountKey, health: account.health, weight: account.weight, weightSource: account.weightSource, governingWindow: null, governingResetAt: null, serviceable: accountServiceable, state: exhausted2 ? "exhausted" : "unknown", score: null },
        utilizationMilli: null,
        elapsedMilli: null,
        resetAtMs: null
      };
    }
    const utilizationMilli2 = toMilli(governing.utilization);
    const remainingSeconds = (Date.parse(governing.resetsAt) - observedAtMs) / 1e3;
    const elapsedMilli2 = toMilli(1 - Math.min(1, Math.max(0, remainingSeconds / governing.windowSeconds)));
    const accountScore = score(utilizationMilli2, elapsedMilli2);
    const exhausted = account.health === "exhausted" || account.health === "unavailable" || governing.utilization >= 1;
    let state2 = exhausted ? "exhausted" : stateFor(utilizationMilli2 - elapsedMilli2, marginMilli);
    const resetSeconds = (Date.parse(governing.resetsAt) - asOfMs) / 1e3;
    if (state2 === "behind" && resetSeconds >= 0 && resetSeconds < urgentResetSeconds) state2 = "behind-urgent";
    return {
      verdict: { accountKey: account.accountKey, health: account.health, weight: account.weight, weightSource: account.weightSource, governingWindow: governing.name, governingResetAt: governing.resetsAt, serviceable: accountServiceable, state: state2, score: accountScore },
      utilizationMilli: utilizationMilli2,
      elapsedMilli: elapsedMilli2,
      resetAtMs: Date.parse(governing.resetsAt)
    };
  });
  const serviceableAccountCount = internal.filter((entry) => entry.verdict.serviceable).length;
  const accounts = internal.map((entry) => entry.verdict);
  if (serviceableAccountCount === 0) {
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "exhausted", serviceable: false, score: null, accounts, knownAccountCount: internal.filter((entry) => entry.utilizationMilli !== null).length, knownWeight: internal.filter((entry) => entry.utilizationMilli !== null).reduce((sum, entry) => sum + entry.verdict.weight, 0), serviceableAccountCount, urgentResetAt: null, reason: "all-accounts-unserviceable" };
  }
  const known = internal.filter(
    (entry) => entry.utilizationMilli !== null && entry.elapsedMilli !== null && entry.resetAtMs !== null
  );
  if (known.length === 0) {
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "unknown", serviceable: true, score: null, accounts, knownAccountCount: 0, knownWeight: 0, serviceableAccountCount, urgentResetAt: null, reason: "no-computable-governing-window" };
  }
  const utilizationMilli = weightedMilli(known.map((entry) => ({ value: entry.utilizationMilli, weight: entry.verdict.weight })));
  const elapsedMilli = weightedMilli(known.map((entry) => ({ value: entry.elapsedMilli, weight: entry.verdict.weight })));
  const laneScore = score(utilizationMilli, elapsedMilli);
  let state = stateFor(utilizationMilli - elapsedMilli, marginMilli);
  const urgent = known.filter((entry) => entry.verdict.state === "behind-urgent").sort((left, right) => left.resetAtMs - right.resetAtMs)[0];
  if (state === "behind" && urgent) state = "behind-urgent";
  return {
    laneId: input.observation.laneId,
    observedAt: input.observation.observedAt,
    state,
    serviceable: true,
    score: laneScore,
    accounts,
    knownAccountCount: known.length,
    knownWeight: known.reduce((sum, entry) => sum + entry.verdict.weight, 0),
    serviceableAccountCount,
    urgentResetAt: urgent?.verdict.governingResetAt ?? null,
    reason: "ok"
  };
}

// src/lane-capacity/url-policy.ts
function parseIpv4(hostname) {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const bytes = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}
function parseIpv6(hostname) {
  const input = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!input.includes(":") || input.includes("%") || input.split("::").length > 2) return null;
  const parseSide = (side) => {
    if (!side) return [];
    const parts = side.split(":");
    const output = [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (part.includes(".")) {
        if (index !== parts.length - 1) return null;
        const ipv4 = parseIpv4(part);
        if (!ipv4) return null;
        output.push(ipv4[0] << 8 | ipv4[1], ipv4[2] << 8 | ipv4[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
        output.push(Number.parseInt(part, 16));
      }
    }
    return output;
  };
  const halves = input.split("::");
  const left = parseSide(halves[0] ?? "");
  const right = parseSide(halves[1] ?? "");
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  if (left.length + right.length >= 8) return null;
  return [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
}
function isReservedIpv4(bytes) {
  const [a, b, c] = bytes;
  return a === 0 || a === 10 || a === 100 && b >= 64 && b <= 127 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 0 && c === 0 || a === 192 && b === 0 && c === 2 || a === 192 && b === 88 && c === 99 || a === 192 && b === 168 || a === 198 && (b === 18 || b === 19) || a === 198 && b === 51 && c === 100 || a === 203 && b === 0 && c === 113 || a >= 224;
}
function isReservedIpv6(words) {
  const allZero = words.every((word) => word === 0);
  const loopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
  const ipv4Mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 65535;
  if (ipv4Mapped) {
    return isReservedIpv4([
      words[6] >> 8,
      words[6] & 255,
      words[7] >> 8,
      words[7] & 255
    ]);
  }
  return allZero || loopback || (words[0] & 65024) === 64512 || (words[0] & 65472) === 65152 || (words[0] & 65280) === 65280 || words[0] === 100 && words[1] === 65435 && words[2] === 0 && words[3] === 0 && words[4] === 0 && words[5] === 0 || words[0] === 100 && words[1] === 65435 && words[2] === 1 || words[0] === 256 && words.slice(1, 4).every((word) => word === 0) || words[0] === 8193 && words[1] === 0 || words[0] === 8193 && words[1] === 2 || words[0] === 8193 && (words[1] & 65520) === 16 || words[0] === 8193 && (words[1] & 65520) === 32 || words[0] === 8193 && words[1] === 3512 || words[0] === 8194 || words[0] === 16383 && (words[1] & 61440) === 0;
}
function isReservedLiteralHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const ipv4 = parseIpv4(host);
  if (ipv4) return isReservedIpv4(ipv4);
  const ipv6 = parseIpv6(host);
  return ipv6 ? isReservedIpv6(ipv6) : false;
}

// src/lane-capacity/poll.ts
function verdictFor(document, lane, policy, asOf) {
  try {
    return evaluateLanePace({
      observation: normalizeLaneDocument({ document, definition: lane }),
      asOf,
      policy
    });
  } catch {
    return null;
  }
}
async function pollOne(source, http, now) {
  const fetchedAt = now();
  const fail = (error) => ({ laneId: source.laneId, fetchedAt, verdict: null, error });
  let parsed;
  try {
    parsed = new URL(source.statusUrl);
  } catch {
    return fail("lane-url-rejected");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || isReservedLiteralHost(parsed.hostname)) {
    return fail("lane-url-rejected");
  }
  let response;
  try {
    let timer;
    response = await Promise.race([
      http.fetch(source.statusUrl, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "identity",
          ...source.apiKey ? { "X-Api-Key": source.apiKey } : {}
        },
        redirect: "manual"
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("lane-request-timeout")), source.requestTimeoutMs);
      })
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  } catch {
    return fail("lane-request-failed");
  }
  if (response.redirected || response.status >= 300 && response.status < 400) {
    return fail("lane-redirect-refused");
  }
  if (response.status === 401 || response.status === 403) {
    return fail("lane-authentication-failed");
  }
  if (response.status < 200 || response.status >= 300) {
    return fail("lane-http-failed");
  }
  const mediaType = response.headers.get("content-type")?.toLowerCase().split(";", 1)[0]?.trim();
  if (!mediaType?.endsWith("/json") && !mediaType?.endsWith("+json")) {
    return fail("lane-unexpected-media-type");
  }
  let text;
  try {
    text = await response.text();
  } catch {
    return fail("lane-request-failed");
  }
  if (new TextEncoder().encode(text).byteLength > source.maxResponseBytes) {
    return fail("lane-response-too-large");
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    return fail("lane-invalid-json");
  }
  if (document === null || typeof document !== "object") {
    return fail("lane-invalid-json");
  }
  return {
    laneId: source.laneId,
    fetchedAt,
    verdict: verdictFor(document, source.lane, source.policy, fetchedAt),
    error: null
  };
}
async function pollLanes(input) {
  return Promise.all(
    input.sources.map(
      (source) => pollOne(source, input.http, input.now).catch(
        () => ({ laneId: source.laneId, fetchedAt: input.now(), verdict: null, error: "lane-poll-failed" })
      )
    )
  );
}

// src/shadow-emit.ts
var SHADOW_SCHEMA_VERSION = "tog2138-decision-v1";
function laneStateLabel(verdict) {
  if (!verdict) return "unavailable";
  if (verdict.state === "exhausted") return "exhausted";
  if (verdict.serviceable === false) return "unavailable";
  if (verdict.state === "ahead") return "degraded";
  if (verdict.serviceable === true) return "available";
  return "unavailable";
}
function buildLaneSnapshot(models, ledger, slotFloorFraction, nowIso) {
  const laneIds = /* @__PURE__ */ new Set();
  for (const model of models) {
    if (model.laneId) laneIds.add(model.laneId);
  }
  const lanes = {};
  const laneFetchErrors = [];
  let sawAnyLane = false;
  let allFreshAndClean = true;
  let maxAgeSeconds = 0;
  for (const laneId of laneIds) {
    sawAnyLane = true;
    const entry = ledger[laneId];
    if (!entry) {
      allFreshAndClean = false;
      lanes[laneId] = { weekly: null, fiveHour: null, state: "unavailable", paceDeviation: 0 };
      continue;
    }
    if (entry.error) {
      laneFetchErrors.push(laneId);
      allFreshAndClean = false;
    }
    const ageSeconds = (Date.parse(nowIso) - Date.parse(entry.fetchedAt)) / 1e3;
    if (Number.isFinite(ageSeconds)) maxAgeSeconds = Math.max(maxAgeSeconds, ageSeconds);
    const verdict = entry.verdict;
    if (!verdict) allFreshAndClean = false;
    const model = models.find((candidate) => candidate.laneId === laneId);
    lanes[laneId] = {
      // The vendored pace engine reports one governing-window utilization, not
      // separate weekly/five-hour readings — the host dispatcher's own
      // five-hour/weekly split is specific to its Anthropic-style windows and
      // has no equivalent field here. Both columns report the same governing
      // score rather than fabricate a second number.
      weekly: verdict?.score?.utilization ?? null,
      fiveHour: verdict?.score?.utilization ?? null,
      state: laneStateLabel(verdict),
      paceDeviation: verdict?.score?.deviation ?? 0,
      ...model ? { slotFactor: slotFactorFor(ledger, model, slotFloorFraction) } : {}
    };
  }
  return {
    ageSeconds: Math.round(Math.max(0, maxAgeSeconds)),
    quality: !sawAnyLane ? "unknown" : allFreshAndClean ? "live" : "cached",
    laneFetchErrors,
    lanes
  };
}
function buildCandidates(decision, models) {
  return decision.candidates.map((candidate) => {
    const model = models.find((entry) => entry.id === candidate.modelId);
    return {
      model: candidate.modelId,
      lane: model?.laneId ?? "unknown",
      tier: candidate.tier,
      // Every rejection stage (capability/tier-floor/context-window/disabled/
      // lane-unserviceable) already removed non-qualifying models before
      // `select.ts` ever costs a candidate — everything reaching
      // `decision.candidates` is capable and usable at this snapshot.
      capable: true,
      usable: true,
      // This engine has no unproven/exploration-slot concept (unlike the
      // reference dispatcher's 10% EXPLORE lane for unproven T2/T3
      // candidates) — TOG-2137 slices 2-5 do not add one, so every candidate
      // is reported proven rather than guessing at an unmodeled distinction.
      proven: true,
      // Dollars for one run at the judged tier's measured volume — the number
      // this engine actually orders on (`expectedCostUsd`), not a $/Mtok rate.
      // The reference dispatcher's "blended $/M" is a per-token price; this
      // plugin's cost term is volume-aware (ADR-0002/cost.ts) and has no
      // single per-token figure to report instead.
      blended: Number(candidate.expectedCostUsd.toFixed(6))
    };
  });
}
function buildShadowRecord(input) {
  const { decision, descriptor } = input;
  const tier2 = decision.effectiveTier ?? decision.judgement.tier;
  const stickyKept = decision.outcome === "selected" && descriptor.pinnedModelId != null && decision.modelId === descriptor.pinnedModelId && decision.trace.some((line) => line.startsWith("sticky:"));
  return {
    schema: SHADOW_SCHEMA_VERSION,
    writer: "plugin-shadow",
    issueId: input.issueId,
    issueIdentifier: input.issueIdentifier,
    ts: input.nowIso,
    // Best-effort, not an independently-verified trigger classification — the
    // harness re-derives its own classes from stateFingerprint/laneSnapshot
    // rather than trusting a writer's self-tagged fields (see `explanations`).
    trigger: input.hasOverride ? "repin" : "new-card",
    tier: tier2,
    pickedModel: decision.modelId,
    keptPin: stickyKept ? descriptor.pinnedModelId : null,
    stateFingerprint: {
      status: input.status,
      hadOverride: input.hasOverride,
      hadRunningRun: !input.isIdle,
      pinOperator: input.hasOperatorPin
    },
    laneSnapshot: buildLaneSnapshot(input.models, input.laneLedger, input.slotFloorFraction, input.nowIso),
    candidates: buildCandidates(decision, input.models),
    // Self-tagged DF-*/PI-* classes are the harness's job to derive
    // (`classify_pair`), not this writer's — an empty array here is correct,
    // not a placeholder.
    explanations: [],
    operatorOverride: input.operatorOverride ? { id: input.operatorOverride.modelId, expiresAt: input.operatorOverride.expiresAt } : null,
    pickWhy: decision.trace.join("; ")
  };
}

// src/worker.ts
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function summary(decision) {
  if (decision.outcome === "selected") {
    return `${decision.modelId} at ${decision.effectiveTier} (tier via ${decision.judgement.source})${decision.advisory ? " \u2014 advisory, nothing written" : ""}`;
  }
  if (decision.outcome === "held-at-floor") {
    return `Held at the agent floor: ${decision.heldReason}`;
  }
  if (decision.outcome === "disabled") return "Model Selection is not configured for this company.";
  if (decision.outcome === "tier-exhausted") {
    return `Tier exhausted: every model from ${decision.judgement.tier} through T1 is pace-exhausted; nowhere left to escalate to.`;
  }
  return "No eligible model for this issue.";
}
function createPlugin() {
  let context = null;
  return definePlugin({
    multiCompanyConfig: true,
    async setup(ctx) {
      context = ctx;
      const companyConfig = async (companyId) => resolveConfig(await ctx.config.get(companyId));
      const profilesKey = (companyId) => ({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.volumeProfiles
      });
      const readProfiles = async (companyId) => {
        const stored = asRecord(await ctx.state.get(profilesKey(companyId)));
        return {
          profiles: Array.isArray(stored.profiles) ? stored.profiles : [],
          signals: Array.isArray(stored.signals) ? stored.signals : []
        };
      };
      const laneLedgerKey = (companyId) => ({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.laneLedger
      });
      const readLaneLedger = async (companyId) => {
        const stored = await ctx.state.get(laneLedgerKey(companyId));
        return stored && typeof stored === "object" ? stored : {};
      };
      const operatorOverridesKey = (companyId) => ({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.operatorOverrides
      });
      const readOperatorOverrides = async (companyId) => {
        const stored = await ctx.state.get(operatorOverridesKey(companyId));
        return stored && typeof stored === "object" ? stored : {};
      };
      const paceRepinHistoryKey = (companyId) => ({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.paceRepinHistory
      });
      const readPaceRepinHistory = async (companyId) => {
        const stored = asRecord(await ctx.state.get(paceRepinHistoryKey(companyId)));
        const history = {};
        for (const [issueId, at] of Object.entries(stored)) {
          if (typeof at === "string") history[issueId] = at;
        }
        return history;
      };
      const tierExhaustedAlarmsKey = (companyId) => ({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.tierExhaustedAlarms
      });
      const readTierExhaustedAlarms = async (companyId) => {
        const stored = asRecord(await ctx.state.get(tierExhaustedAlarmsKey(companyId)));
        const alarms = {};
        for (const [issueId, at] of Object.entries(stored)) {
          if (typeof at === "string") alarms[issueId] = at;
        }
        return alarms;
      };
      const raiseOrClearTierExhaustedAlarm = async (companyId, issueId, issueTitle, issueIdentifier, decision, authorAgentId) => {
        const alarms = await readTierExhaustedAlarms(companyId);
        if (decision.outcome !== "tier-exhausted") {
          if (issueId in alarms) {
            const { [issueId]: _dropped, ...rest } = alarms;
            await ctx.state.set(tierExhaustedAlarmsKey(companyId), rest);
          }
          return;
        }
        if (issueId in alarms) return;
        const config = await companyConfig(companyId);
        const reference = issueIdentifier ? `${issueIdentifier} (${issueTitle})` : issueTitle;
        await ctx.issues.create({
          companyId,
          parentId: issueId,
          title: `Operator: model tier exhausted on ${reference}`,
          description: `Every model from ${decision.judgement.tier} through T1 is pace-exhausted for ${reference} \u2014 there is nowhere left for Model Selection to escalate to.

Intervene to unblock: add lane capacity, adjust pacing, or set an operator override (\`model_selection_set_operator_override\`). This escalation stays open until the lane recovers and a fresh \`model_selection_advise\`/\`apply\` call on the original issue no longer reports \`tier-exhausted\`.`,
          priority: "critical",
          labelIds: config.operatorLabelId ? [config.operatorLabelId] : void 0,
          actor: { actorAgentId: authorAgentId ?? void 0 }
        });
        await ctx.state.set(tierExhaustedAlarmsKey(companyId), { ...alarms, [issueId]: (/* @__PURE__ */ new Date()).toISOString() });
      };
      const SHADOW_DECISIONS_FILE = "decisions.jsonl";
      const isMissingShadowFileError = (err) => {
        const message = err instanceof Error ? err.message : String(err);
        return /not found/i.test(message) || /ENOENT/.test(message);
      };
      const shadowEmitChains = /* @__PURE__ */ new Map();
      const emitShadowRecordSerialized = async (companyId, record2) => {
        let existing = "";
        try {
          existing = await ctx.localFolders.readText(companyId, LOCAL_FOLDER_KEYS.shadowDecisions, SHADOW_DECISIONS_FILE);
        } catch (err) {
          if (!isMissingShadowFileError(err)) {
            ctx.logger.warn("model-selection: shadow decision emit aborted \u2014 could not read existing log", {
              error: String(err)
            });
            return;
          }
          existing = "";
        }
        const lines = existing.split("\n").filter((line) => line.trim().length > 0);
        lines.push(JSON.stringify(record2));
        const config = await companyConfig(companyId);
        const capped = lines.length > config.shadowEmit.maxRecords ? lines.slice(-config.shadowEmit.maxRecords) : lines;
        try {
          await ctx.localFolders.writeTextAtomic(
            companyId,
            LOCAL_FOLDER_KEYS.shadowDecisions,
            SHADOW_DECISIONS_FILE,
            capped.join("\n") + "\n"
          );
        } catch (err) {
          ctx.logger.warn("model-selection: shadow decision emit failed", { error: String(err) });
        }
      };
      const emitShadowRecord = (companyId, record2) => {
        const previous = shadowEmitChains.get(companyId) ?? Promise.resolve();
        const next = previous.catch(() => {
        }).then(() => emitShadowRecordSerialized(companyId, record2));
        shadowEmitChains.set(companyId, next);
        return next;
      };
      const laneHttp = {
        fetch: (url, init) => ctx.http.fetch(url, init)
      };
      const reworkSignalsKey = (companyId) => ({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.reworkSignals
      });
      const readReworkSignals = async (companyId) => {
        const stored = asRecord(await ctx.state.get(reworkSignalsKey(companyId)));
        return Array.isArray(stored.signals) ? stored.signals : [];
      };
      const scoresKey = (companyId) => ({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.modelScores
      });
      const readCardLedger = async (companyId) => {
        const stored = asRecord(await ctx.state.get(scoresKey(companyId)));
        const ledger = asRecord(stored.cardLedger);
        return ledger;
      };
      const shadowDiffsKey = (companyId) => ({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.shadowDiffs
      });
      const describeIssue = async (companyId, issueId, supplied) => {
        const issue = await ctx.issues.get(issueId, companyId);
        if (!issue) return null;
        const overrides = asRecord(issue.assigneeAdapterOverrides);
        const adapterConfig = asRecord(overrides.adapterConfig);
        const pinnedModelId = typeof adapterConfig.model === "string" ? adapterConfig.model : null;
        const labels = issue.labels ?? [];
        const labelNames = labels.map((label) => label.name).filter((name) => typeof name === "string");
        const scheduledRetryStatus = issue.scheduledRetry?.status ?? null;
        const isIdle = !issue.checkoutRunId && !issue.executionRunId && scheduledRetryStatus !== "queued" && scheduledRetryStatus !== "running";
        let agentFloorModelId = null;
        const assigneeAgentId = issue.assigneeAgentId;
        if (typeof assigneeAgentId === "string") {
          try {
            const agent = await ctx.agents.get(assigneeAgentId, companyId);
            const config = asRecord(asRecord(agent).adapterConfig);
            if (typeof config.model === "string") agentFloorModelId = config.model;
          } catch {
          }
        }
        const exclusionRaw = asRecord(supplied.exclusion);
        const descriptor = {
          issueId,
          labelNames,
          pinnedModelId,
          agentFloorModelId,
          // Sticky is derived from the pin: if the issue is already pinned, the
          // run is already on that model and a change would reset the session.
          stickyModelId: pinnedModelId,
          requiredCapabilities: Array.isArray(supplied.requiredCapabilities) ? supplied.requiredCapabilities : void 0,
          requiredContextTokens: typeof supplied.requiredContextTokens === "number" ? supplied.requiredContextTokens : void 0,
          ...typeof exclusionRaw.excluded === "boolean" ? {
            exclusion: {
              excluded: exclusionRaw.excluded,
              reasons: Array.isArray(exclusionRaw.reasons) ? exclusionRaw.reasons : []
            }
          } : {}
        };
        const existingLabelIds = issue.labelIds ?? labels.map((label) => label.id).filter((id) => typeof id === "string");
        return {
          descriptor,
          status: String(issue.status ?? ""),
          hasOverride: Object.keys(overrides).length > 0,
          existingLabelIds,
          hasTierLabel: labelNames.some((name) => name.startsWith(TIER_LABEL_PREFIX)),
          hasOperatorPin: labelNames.includes(OPERATOR_PIN_LABEL),
          isIdle,
          title: String(issue.title ?? ""),
          identifier: typeof issue.identifier === "string" ? issue.identifier : null
        };
      };
      const advise = async (companyId, params) => {
        const issueId = typeof params.issueId === "string" ? params.issueId : null;
        if (!issueId) return null;
        const config = await companyConfig(companyId);
        const described = await describeIssue(companyId, issueId, params);
        if (!described) return null;
        const { profiles, signals } = await readProfiles(companyId);
        const laneLedger = await readLaneLedger(companyId);
        const nowIso = (/* @__PURE__ */ new Date()).toISOString();
        const overrides = await readOperatorOverrides(companyId);
        const liveOverride = activeOperatorOverride(overrides, issueId, nowIso);
        const cardLedger = await readCardLedger(companyId);
        const decision = selectModel({
          descriptor: described.descriptor,
          config: {
            enforcementEnabled: config.selection.enabled && config.selection.mode === "enforce",
            defaultTier: config.selection.defaultTier,
            models: config.models,
            holdOnUntrustedProfile: config.selection.holdOnUntrustedProfile,
            stickyWithinIssue: config.selection.stickyModelWithinIssue,
            pacingMode: config.pacing.mode,
            laneLedger,
            slotFloorFraction: config.pacing.slotFloorFraction,
            operatorOverrideModelId: liveOverride?.modelId ?? null,
            objective: config.selection.objective
          },
          profiles,
          signals,
          now: Date.now(),
          cardLedger
        });
        const pinnedModel = config.models.find((model) => model.id === described.descriptor.pinnedModelId);
        const isServiceabilityHardStop = config.pacing.mode !== "off" && !!pinnedModel && hardStopExcluded(laneLedger, pinnedModel);
        await ctx.metrics.write(`model_selection.decision.${decision.outcome}`, 1);
        if (decision.shadowDiff) {
          const stored = asRecord(await ctx.state.get(shadowDiffsKey(companyId)));
          const existing = Array.isArray(stored.records) ? stored.records : [];
          const cutoffMs = Date.now() - 7 * 24 * 60 * 60 * 1e3;
          const records = [
            ...existing.filter((r) => r.atMs >= cutoffMs),
            { ...decision.shadowDiff, atMs: Date.now() }
          ];
          await ctx.state.set(shadowDiffsKey(companyId), { records });
        }
        if (config.shadowEmit.enabled) {
          const shadowRecord = buildShadowRecord({
            issueId,
            issueIdentifier: described.identifier,
            nowIso,
            decision,
            descriptor: described.descriptor,
            status: described.status,
            hasOverride: described.hasOverride,
            hasOperatorPin: described.hasOperatorPin,
            isIdle: described.isIdle,
            models: config.models,
            laneLedger,
            slotFloorFraction: config.pacing.slotFloorFraction,
            operatorOverride: liveOverride
          });
          await emitShadowRecord(companyId, shadowRecord);
        }
        return {
          decision,
          issueId,
          status: described.status,
          hasOverride: described.hasOverride,
          existingLabelIds: described.existingLabelIds,
          hasTierLabel: described.hasTierLabel,
          hasOperatorPin: described.hasOperatorPin,
          isIdle: described.isIdle,
          isServiceabilityHardStop,
          nowIso,
          config,
          title: described.title,
          identifier: described.identifier
        };
      };
      ctx.tools.register(
        TOOL_NAMES.advise,
        {
          displayName: "Advise a model for an issue",
          description: "Return the tier judgement and costed candidates for one issue. Writes nothing.",
          parametersSchema: { type: "object" }
        },
        async (params, runCtx) => {
          const result = await advise(runCtx.companyId, asRecord(params));
          if (!result) return { content: "Issue not found, or issueId was missing.", data: null };
          await raiseOrClearTierExhaustedAlarm(
            runCtx.companyId,
            result.issueId,
            result.title,
            result.identifier,
            result.decision,
            runCtx.agentId ?? null
          );
          return { content: summary(result.decision), data: result.decision };
        }
      );
      ctx.tools.register(
        TOOL_NAMES.apply,
        {
          displayName: "Apply a model selection to an issue",
          description: "Advise, then write the per-issue override and tier label when enforcement is on. No-ops on an issue that already has an override.",
          parametersSchema: { type: "object" }
        },
        async (params, runCtx) => {
          const result = await advise(runCtx.companyId, asRecord(params));
          if (!result) return { content: "Issue not found, or issueId was missing.", data: null };
          await raiseOrClearTierExhaustedAlarm(
            runCtx.companyId,
            result.issueId,
            result.title,
            result.identifier,
            result.decision,
            runCtx.agentId ?? null
          );
          const paceRepinEligible = result.hasOverride && result.config.pacing.mode === "enforce";
          const repinHistory = paceRepinEligible ? await readPaceRepinHistory(runCtx.companyId) : {};
          const plan = planApply(
            result.decision,
            {
              hasExistingOverride: result.hasOverride,
              // Read from the issue's actual labels, not from the judgement
              // source. An issue can carry a tier label that did NOT key this
              // decision (an override outranks it), and inferring "has a label"
              // from "the label decided it" would re-add a duplicate.
              hasExistingTierLabel: result.hasTierLabel,
              status: result.status,
              ...paceRepinEligible ? {
                paceRepin: {
                  hasOperatorPin: result.hasOperatorPin,
                  isIdle: result.isIdle,
                  lastRepinAt: repinHistory[result.issueId] ?? null,
                  now: result.nowIso,
                  idleRepinHysteresisSeconds: result.config.pacing.idleRepinHysteresisSeconds,
                  isServiceabilityHardStop: result.isServiceabilityHardStop
                }
              } : {}
            },
            result.issueId
          );
          if (!plan.write || !plan.patch) {
            return { content: `No write: ${plan.reason}`, data: { decision: result.decision, plan } };
          }
          const patch = { ...plan.patch };
          let labelNote = "";
          if (plan.labelName && result.decision.effectiveTier) {
            const labelId = result.config.tierLabelIds[result.decision.effectiveTier];
            if (labelId) {
              patch.labelIds = [.../* @__PURE__ */ new Set([...result.existingLabelIds, labelId])];
            } else {
              labelNote = ` (no configured label id for ${plan.labelName}; override written without it)`;
            }
          }
          await ctx.issues.update(
            result.issueId,
            patch,
            runCtx.companyId,
            { actorAgentId: runCtx.agentId ?? null, actorRunId: runCtx.runId ?? null }
          );
          await ctx.activity.log({
            companyId: runCtx.companyId,
            message: `Model Selection pinned ${result.decision.modelId} (${result.decision.effectiveTier}) on this issue`,
            entityType: "issue",
            entityId: result.issueId,
            metadata: {
              modelId: result.decision.modelId,
              tier: result.decision.effectiveTier,
              tierSource: result.decision.judgement.source,
              trace: result.decision.trace
            }
          });
          if (paceRepinEligible) {
            await ctx.state.set(paceRepinHistoryKey(runCtx.companyId), {
              ...repinHistory,
              [result.issueId]: result.nowIso
            });
          }
          return { content: plan.reason + labelNote, data: { decision: result.decision, plan } };
        }
      );
      ctx.tools.register(
        TOOL_NAMES.setOperatorOverride,
        {
          displayName: "Set an operator override for an issue",
          description: "Record a time-boxed override: `model_selection_advise`/`apply` will route this issue to the named model ahead of pace ordering and slot throttling, until it expires. It never bypasses a capability gate, tier floor/ceiling, the untrusted-profile hold, or a serviceability hard stop.",
          parametersSchema: {
            type: "object",
            required: ["issueId", "modelId"],
            properties: {
              issueId: { type: "string" },
              modelId: { type: "string" },
              ttlSeconds: { type: "integer", minimum: 1 }
            }
          }
        },
        async (params, runCtx) => {
          const supplied = asRecord(params);
          const issueId = typeof supplied.issueId === "string" ? supplied.issueId : null;
          const modelId = typeof supplied.modelId === "string" ? supplied.modelId : null;
          if (!issueId || !modelId) {
            return { content: "issueId and modelId are both required.", data: null };
          }
          const config = await companyConfig(runCtx.companyId);
          const ttlSeconds = typeof supplied.ttlSeconds === "number" && supplied.ttlSeconds > 0 ? supplied.ttlSeconds : config.pacing.operatorOverrideTtlSeconds;
          const nowIso = (/* @__PURE__ */ new Date()).toISOString();
          const existing = await readOperatorOverrides(runCtx.companyId);
          const updated = recordOperatorOverride(existing, issueId, modelId, nowIso, ttlSeconds);
          await ctx.state.set(operatorOverridesKey(runCtx.companyId), updated);
          const entry = updated[issueId];
          return {
            content: `operator override recorded: ${issueId} -> ${modelId}, expires ${entry.expiresAt}`,
            data: entry
          };
        }
      );
      const appendReworkSignal = async (companyId, signal) => {
        const existing = await readReworkSignals(companyId);
        const cutoffMs = Date.now() - SCORE_WINDOW_DAYS * 2 * 24 * 60 * 60 * 1e3;
        const pruned = existing.filter((s) => s.atMs >= cutoffMs);
        await ctx.state.set(reworkSignalsKey(companyId), { signals: [...pruned, signal] });
      };
      ctx.events.on("issue.updated", async (event) => {
        const payload = asRecord(event.payload);
        const changes = asRecord(payload.changes);
        const status = asRecord(changes.status);
        const from = typeof status.from === "string" ? status.from : null;
        const to = typeof status.to === "string" ? status.to : null;
        const issueId = typeof event.entityId === "string" ? event.entityId : null;
        if (!issueId || from !== "done" || to === "done" || to === "cancelled" || !to) return;
        await appendReworkSignal(event.companyId, {
          issueId,
          atMs: Date.parse(event.occurredAt) || Date.now(),
          kind: "reopen",
          excludeAgentId: null
        });
      });
      const REJECTION_RE = /request(ed)? changes|^## *(rejected|fail|blocked by review)|not accepted|changes requested|re-?do this|does not pass review/i;
      ctx.events.on("issue.comment.created", async (event) => {
        const payload = asRecord(event.payload);
        const snippet = typeof payload.bodySnippet === "string" ? payload.bodySnippet : "";
        if (!REJECTION_RE.test(snippet)) return;
        const issueId = typeof event.entityId === "string" ? event.entityId : null;
        if (!issueId) return;
        await appendReworkSignal(event.companyId, {
          issueId,
          atMs: Date.parse(event.occurredAt) || Date.now(),
          kind: "rejected",
          excludeAgentId: typeof event.actorId === "string" ? event.actorId : null
        });
      });
      ctx.tools.register(
        TOOL_NAMES.ancillaryDrift,
        {
          displayName: "Report ancillary model pin drift",
          description: "Report which agents' ancillary model pins disagree with the lane-aware T3 recommendation. Read-only.",
          parametersSchema: { type: "object" }
        },
        async (_params, runCtx) => {
          const config = await companyConfig(runCtx.companyId);
          if (config.models.length === 0) {
            return { content: "Model Selection is not configured for this company.", data: { recommendedModelId: null, drift: [] } };
          }
          const { profiles, signals } = await readProfiles(runCtx.companyId);
          const laneLedger = await readLaneLedger(runCtx.companyId);
          const decision = recommendAncillaryModel({
            config: {
              models: config.models,
              holdOnUntrustedProfile: config.selection.holdOnUntrustedProfile,
              pacingMode: config.pacing.mode,
              laneLedger,
              slotFloorFraction: config.pacing.slotFloorFraction
            },
            profiles,
            signals,
            now: Date.now()
          });
          if (decision.outcome !== "selected" && decision.outcome !== "held-at-floor") {
            return {
              content: `No ancillary recommendation: ${summary(decision)}`,
              data: { recommendedModelId: null, decision, drift: [] }
            };
          }
          const recommendedModelId = decision.modelId;
          const drift = [];
          let offset = 0;
          const pageSize = 200;
          for (; ; ) {
            const page = await ctx.agents.list({ companyId: runCtx.companyId, limit: pageSize, offset });
            for (const agent of page) {
              drift.push(
                ...ancillaryDriftForAgent(
                  {
                    id: agent.id,
                    name: agent.name,
                    adapterConfig: asRecord(agent.adapterConfig),
                    runtimeConfig: asRecord(agent.runtimeConfig)
                  },
                  recommendedModelId
                )
              );
            }
            if (page.length < pageSize) break;
            offset += pageSize;
          }
          await ctx.metrics.write("model_selection.ancillary_drift.count", drift.length);
          const content = drift.length === 0 ? `No ancillary drift: every reported ancillary surface already matches the recommended ${recommendedModelId}.` : `${drift.length} ancillary surface${drift.length === 1 ? "" : "s"} drifted from the recommended ${recommendedModelId}.`;
          return { content, data: { recommendedModelId, decision, drift } };
        }
      );
      ctx.jobs.register(JOB_KEYS.refreshProfiles, async () => {
        const companies = await ctx.companies.list();
        for (const company of companies) {
          try {
            const config = await companyConfig(company.id);
            if (config.models.length === 0) continue;
            const rows = await ctx.db.query(
              `select usage_json->>'model' as model,
                      (usage_json->>'inputTokens')::numeric as input_tokens,
                      (usage_json->>'cachedInputTokens')::numeric as cached_input_tokens,
                      (usage_json->>'outputTokens')::numeric as output_tokens
                 from heartbeat_runs
                where company_id = $1
                  and started_at > now() - ($2 || ' days')::interval
                  and status = 'succeeded'
                  and (usage_json->>'costUsd')::numeric > 0`,
              [company.id, String(config.profiles.windowDays)]
            );
            const runRows = (Array.isArray(rows) ? rows : []).map((row) => {
              const r = asRecord(row);
              return {
                model: typeof r.model === "string" ? r.model : null,
                inputTokens: Number(r.input_tokens ?? 0),
                cachedInputTokens: Number(r.cached_input_tokens ?? 0),
                outputTokens: Number(r.output_tokens ?? 0)
              };
            });
            const computedAt = (/* @__PURE__ */ new Date()).toISOString();
            const profiles = buildVolumeProfiles(runRows, config.models, computedAt);
            const existing = await readProfiles(company.id);
            await ctx.state.set(profilesKey(company.id), {
              profiles,
              // Quality signals are refreshed by their own measurement path;
              // preserve whatever is stored rather than zeroing it here, which
              // would silently drop the escalation term to zero.
              signals: existing.signals
            });
            ctx.logger.info("volume profiles refreshed", {
              companyId: company.id,
              tiers: profiles.map((p) => `${p.tier}:${p.sampleCount}`).join(",")
            });
          } catch (cause) {
            ctx.logger.error("volume profile refresh failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause)
            });
          }
        }
      });
      ctx.jobs.register(JOB_KEYS.pollLanes, async () => {
        const companies = await ctx.companies.list();
        for (const company of companies) {
          try {
            const config = await companyConfig(company.id);
            if (config.pacing.lanes.length === 0) continue;
            const secretFailures = [];
            const sources = [];
            const fetchedAt = (/* @__PURE__ */ new Date()).toISOString();
            for (const lane of config.pacing.lanes) {
              let apiKey = null;
              if (lane.apiKeySecretRef) {
                try {
                  apiKey = await ctx.secrets.resolve(lane.apiKeySecretRef, {
                    companyId: company.id,
                    configPath: `pacing.lanes.${lane.laneId}.apiKeySecretRef`
                  });
                } catch {
                  secretFailures.push({ laneId: lane.laneId, fetchedAt, verdict: null, error: "lane-secret-unavailable" });
                  continue;
                }
              }
              sources.push({
                laneId: lane.laneId,
                statusUrl: lane.statusUrl,
                requestTimeoutMs: lane.requestTimeoutMs,
                maxResponseBytes: lane.maxResponseBytes,
                lane: lane.lane,
                policy: lane.policy,
                apiKey
              });
            }
            const results = await pollLanes({
              sources,
              http: laneHttp,
              now: () => (/* @__PURE__ */ new Date()).toISOString()
            });
            let ledger = await readLaneLedger(company.id);
            for (const result of [...results, ...secretFailures]) {
              ledger = mergeLedgerEntry(ledger, result);
            }
            await ctx.state.set(laneLedgerKey(company.id), ledger);
            ctx.logger.info("lane capacity polled", {
              companyId: company.id,
              lanes: [...results, ...secretFailures].map((r) => `${r.laneId}:${r.verdict?.state ?? "error"}`).join(",")
            });
          } catch (cause) {
            ctx.logger.error("lane capacity poll failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause)
            });
          }
        }
      });
      ctx.jobs.register(JOB_KEYS.refreshScores, async () => {
        const companies = await ctx.companies.list();
        for (const company of companies) {
          try {
            const config = await companyConfig(company.id);
            if (config.models.length === 0) continue;
            const scoreRunRows = await ctx.db.query(
              `select r.usage_json->>'model' as model,
                      r.status as status,
                      coalesce(r.context_snapshot->>'issueId','') as issue_id,
                      coalesce(r.error_code,'') as error_code,
                      left(coalesce(r.error,''),200) as error,
                      coalesce(r.usage_json->>'costUsd','') as cost_usd,
                      extract(epoch from (r.finished_at - r.started_at))/60.0 as mins,
                      extract(epoch from (now() - r.created_at))/86400.0 as age_days
                 from heartbeat_runs r
                where r.company_id = $1
                  and r.created_at > now() - ($2 || ' days')::interval
                  and r.usage_json ? 'model'
                  and r.status in ('succeeded','failed','timed_out')
                  and r.usage_json->>'model' not in ('unknown','auto/best-coding')
                  and r.finished_at is not null`,
              [company.id, String(SCORE_WINDOW_DAYS)]
            );
            const closingRunRows = await ctx.db.query(
              `select coalesce(r.context_snapshot->>'issueId','') as issue_id,
                      r.usage_json->>'model' as model,
                      coalesce(r.agent_id::text,'') as agent_id,
                      coalesce(r.usage_json->>'costUsd','') as cost_usd,
                      extract(epoch from r.finished_at) * 1000 as finished_at_ms
                 from heartbeat_runs r
                where r.company_id = $1
                  and r.status = 'succeeded'
                  and r.finished_at > now() - ($2 || ' days')::interval
                  and r.usage_json ? 'model'`,
              [company.id, String(CARD_LEDGER_WINDOW_DAYS)]
            );
            const issueIds = /* @__PURE__ */ new Set();
            for (const row of scoreRunRows) {
              const r = asRecord(row);
              if (typeof r.issue_id === "string" && r.issue_id) issueIds.add(r.issue_id);
            }
            for (const row of closingRunRows) {
              const r = asRecord(row);
              if (typeof r.issue_id === "string" && r.issue_id) issueIds.add(r.issue_id);
            }
            const tierByIssue = /* @__PURE__ */ new Map();
            for (const issueId of issueIds) {
              try {
                const issue = await ctx.issues.get(issueId, company.id);
                const labelNames = (issue?.labels ?? []).map((label) => label.name).filter((name) => typeof name === "string");
                const tierLabel = labelNames.find((name) => name.startsWith(TIER_LABEL_PREFIX));
                const tierValue = tierLabel ? tierLabel.slice(TIER_LABEL_PREFIX.length) : null;
                tierByIssue.set(
                  issueId,
                  tierValue && TIERS.includes(tierValue) ? tierValue : null
                );
              } catch {
                tierByIssue.set(issueId, null);
              }
            }
            const toNumber = (value) => {
              if (typeof value === "number") return Number.isFinite(value) ? value : null;
              if (typeof value === "string" && value.length > 0) {
                const parsed = Number(value);
                return Number.isFinite(parsed) ? parsed : null;
              }
              return null;
            };
            const runOutcomeRows = scoreRunRows.map((row) => {
              const r = asRecord(row);
              const issueId = typeof r.issue_id === "string" ? r.issue_id : "";
              return {
                modelId: typeof r.model === "string" ? r.model : "",
                tier: issueId ? tierByIssue.get(issueId) ?? null : null,
                status: r.status,
                errorCode: typeof r.error_code === "string" && r.error_code ? r.error_code : null,
                error: typeof r.error === "string" && r.error ? r.error : null,
                costUsd: toNumber(r.cost_usd),
                mins: toNumber(r.mins),
                ageDays: toNumber(r.age_days) ?? 0
              };
            });
            let statsByModel = accumulateRunStats(runOutcomeRows);
            const closingRuns = closingRunRows.map((row) => {
              const r = asRecord(row);
              const issueId = typeof r.issue_id === "string" ? r.issue_id : "";
              return {
                issueId,
                modelId: typeof r.model === "string" ? r.model : "",
                tier: issueId ? tierByIssue.get(issueId) ?? null : null,
                finishedAtMs: toNumber(r.finished_at_ms) ?? 0,
                agentId: typeof r.agent_id === "string" && r.agent_id ? r.agent_id : null
              };
            });
            const reworkSignals = await readReworkSignals(company.id);
            const reworkEvents = [];
            const rejectedIssueIds = /* @__PURE__ */ new Set();
            for (const signal of reworkSignals) {
              const windowMs = signal.kind === "reopen" ? REOPEN_WINDOW_MS : REJECTION_WINDOW_MS;
              const closing = findClosingRun(signal.issueId, signal.atMs, windowMs, closingRuns, signal.excludeAgentId);
              if (!closing || closing.tier === null) continue;
              reworkEvents.push({ modelId: closing.modelId, tier: closing.tier, kind: signal.kind });
              rejectedIssueIds.add(signal.issueId);
            }
            statsByModel = foldReworkIntoStats(statsByModel, reworkEvents);
            const modelScores = config.models.map(
              (model) => buildModelScore(model.id, model.aaIndex, statsByModel[model.id] ?? {}, TIERS)
            );
            const cardIssueRows = await ctx.db.query(
              `select id::text as id,
                      extract(epoch from coalesce(completed_at, cancelled_at)) * 1000 as closed_at_ms,
                      assignee_adapter_overrides->'adapterConfig'->>'model' as pinned_model
                 from issues
                where company_id = $1
                  and coalesce(completed_at, cancelled_at) is not null
                  and coalesce(completed_at, cancelled_at) > now() - ($2 || ' days')::interval`,
              [company.id, String(CARD_LEDGER_WINDOW_DAYS)]
            );
            const latestClosingRunByIssue = /* @__PURE__ */ new Map();
            const runCountByIssue = /* @__PURE__ */ new Map();
            for (const [index, run] of closingRuns.entries()) {
              if (!run.issueId) continue;
              runCountByIssue.set(run.issueId, (runCountByIssue.get(run.issueId) ?? 0) + 1);
              const existing = latestClosingRunByIssue.get(run.issueId);
              if (!existing || run.finishedAtMs > existing.finishedAtMs) {
                const costUsd = toNumber(asRecord(closingRunRows[index]).cost_usd);
                latestClosingRunByIssue.set(run.issueId, { ...run, costUsd });
              }
            }
            const cardRows = [];
            for (const row of cardIssueRows) {
              const r = asRecord(row);
              const issueId = typeof r.id === "string" ? r.id : null;
              if (!issueId) continue;
              const closingRun = latestClosingRunByIssue.get(issueId);
              if (!closingRun || closingRun.tier === null) continue;
              const pinnedModel = typeof r.pinned_model === "string" && r.pinned_model ? r.pinned_model : null;
              cardRows.push({
                modelId: closingRun.modelId,
                tier: closingRun.tier,
                closedAtMs: toNumber(r.closed_at_ms) ?? 0,
                rejected: rejectedIssueIds.has(issueId),
                costUsd: closingRun.costUsd,
                runCount: runCountByIssue.get(issueId) ?? 1,
                foreignRun: pinnedModel !== null && pinnedModel !== closingRun.modelId
              });
            }
            const priorPByModel = {};
            const blendedListPriceByModel = {};
            for (const model of config.models) {
              priorPByModel[model.id] = priorP(model.aaIndex);
              blendedListPriceByModel[model.id] = null;
            }
            const cardLedger = buildCardLedger(
              cardRows,
              Date.now(),
              priorPByModel,
              blendedListPriceByModel
            );
            await ctx.state.set(scoresKey(company.id), { modelScores, cardLedger });
            ctx.logger.info("model scores refreshed", {
              companyId: company.id,
              models: modelScores.length,
              cardsInLedger: cardRows.length
            });
          } catch (cause) {
            ctx.logger.error("score refresh failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause)
            });
          }
        }
      });
      ctx.logger.info("Model Selection worker ready", { version: PLUGIN_VERSION });
    },
    async onHealth() {
      return { status: "ok", message: `Model Selection ${PLUGIN_VERSION}` };
    },
    async onValidateConfig(raw) {
      const { errors, warnings } = validateConfig(resolveConfig(raw));
      return { ok: errors.length === 0, errors, warnings };
    },
    async onApiRequest(input) {
      if (!context) return { status: 503, body: { error: "worker is not initialised" } };
      if (input.routeKey !== ROUTE_KEYS.advise && input.routeKey !== ROUTE_KEYS.applyIssue) {
        return { status: 404, body: { error: `unknown route ${input.routeKey}` } };
      }
      return { status: 501, body: { error: "use the registered tools; the HTTP surface is reserved" } };
    }
  });
}
var plugin = createPlugin();
var worker_default = plugin;
runWorker(plugin, import.meta.url);
export {
  createPlugin,
  worker_default as default
};
//# sourceMappingURL=worker.js.map
