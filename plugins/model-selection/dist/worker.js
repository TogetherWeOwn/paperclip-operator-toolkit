// src/worker.ts
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

// src/constants.ts
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
var DEFAULT_FIVE_HOUR_WINDOW_NAME = "five-hour";
var DEFAULT_WEEKLY_WINDOW_NAME = "weekly";
var DEFAULT_ZAI_WEEKLY_WINDOW_NAME = "weekly";
var DEFAULT_ZAI_WEEKLY_MARGIN = 0.15;
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
  tierExhaustedAlarms: "tierExhaustedAlarms",
  /**
   * Instance-scoped (aa.ai data is not company-specific): the last-fetched
   * aa.ai snapshot `{fetchedAt, bySlug, lastAttemptAt, lastError}` (TOG-2438).
   * `bySlug` maps every aa.ai slug (one per model x effort-level) to its full
   * `AaModelRecord` (TOG-2438 scope expansion) — not just the intelligence
   * index.
   */
  aaIndexSnapshot: "aaIndexSnapshot",
  /**
   * Instance-scoped: a bounded rolling history of past fetches, `{entries:
   * Array<{fetchedAt, bySlug}>}`, newest last, capped at
   * `AA_SNAPSHOT_HISTORY_LIMIT` entries (TOG-2438 scope expansion — "store
   * the raw snapshot per fetch so history is queryable"). Separate key from
   * `aaIndexSnapshot` so a plain drift read never has to load the whole
   * history.
   */
  aaSnapshotHistory: "aaSnapshotHistory",
  /**
   * Instance-scoped: `{ids: string[]}`, the set of companies this worker has
   * ever seen a stored config for, persisted so a bare crash-restart (which
   * replays no `configChanged` calls, unlike a full plugin reload) doesn't
   * reset scheduled jobs to iterating zero companies (TOG-2438 reopen).
   */
  knownCompanies: "knownCompanies",
  /** Per-company: which `(modelId, freshImpliedTier)` drift pairs have already been surfaced (TOG-2438). */
  aaDriftSurfaced: "aaDriftSurfaced",
  /**
   * Per-issue capability-exclusion flag recorded by `classifyIssues`
   * (ported from `tier_dispatcher.py` `main()`'s `excl` local). The tier:*
   * LABEL always records the confidence-demoted tier regardless of
   * exclusion; this flag is the only place exclusion survives past the
   * classify job, for a later apply-sweep (TOG-2481 task #6/#7) to supply as
   * `descriptor.exclusion` and force the T1 model-pick bucket.
   */
  classificationExclusions: "classificationExclusions",
  /**
   * TOG-3200. Per-issue provenance for the `tier:*` label: `{issueId: "T2"}`
   * for every tier label THIS job wrote. Without it `classifyIssues` cannot
   * tell its own verdict from an agent's self-assessment, so it had to skip
   * every card already carrying a tier label — and that skip is what starved
   * it.
   *
   * Measured 2026-09-17: 1,542 tier labels exist company-wide, of which 44
   * (2.9%) were written by this plugin. The rest are agent self-assessments
   * made under a bundle instruction that says to go up a tier when in doubt.
   * Because 120 of the 126 eligible open cards already carried one, the job
   * ran 36 times that day and classified ZERO issues. Provenance is what makes
   * the skip narrow enough to be correct: skip our own recorded verdict,
   * re-examine somebody else's.
   */
  classifierLabeledIssues: "classifierLabeledIssues",
  /**
   * TOG-2481 port of `lane_outage.json` — an operator-declared outage the
   * telemetry cannot see. Runtime-settable (mirroring `operatorOverrides`),
   * not deploy-time config: the Python source is a hand-edited file read
   * fresh on every dispatcher run, and an outage is exactly the kind of
   * thing that needs to be set/cleared without a plugin config redeploy.
   */
  laneOutage: "laneOutage",
  /**
   * TOG-2481 port of `zai_pace_override.json` — an operator-declared
   * temporary margin override for `zaiWeeklyPaceOk`, e.g. during a Codex
   * outage. Runtime-settable, same rationale as `laneOutage`.
   */
  zaiPaceOverride: "zaiPaceOverride",
  /** Keyset cursor for the bounded balance-pass page, persisted per company. */
  balancePassCursor: "balancePassCursor",
  /**
   * TOG-2481 port of the `dispatch` plugin's `stateKey()` — the last-firing
   * summary a sweep compares against to gate the activity-log line to state
   * changes only. Namespaced separately from the rest of this plugin's state
   * (`namespace: "dispatch"`, matching the original plugin's key exactly) so
   * absorbing it does not collide with `laneLedger`/etc.
   */
  dispatchLastFiring: "dispatchLastFiring",
  /**
   * TOG-3111 AC3. Per-issue timestamp of the last "cannot pin — no eligible
   * model on any serviceable lane" activity notice, so a card that stays
   * unpinnable across repeated pass firings surfaces once per throttle window
   * instead of on every 10-minute tick. Same shape/rationale as
   * `tierExhaustedAlarms`, scoped to the per-card notice rather than the
   * operator alarm card.
   */
  noEligibleNotices: "noEligibleNotices"
};
var NO_ELIGIBLE_NOTICE_THROTTLE_MS = 60 * 60 * 1e3;
var AA_LEADERBOARD_URL = "https://artificialanalysis.ai/leaderboards/models";
var AA_FETCH_TIMEOUT_MS = 1e4;
var AA_MAX_RESPONSE_BYTES = 8e6;
var AA_SNAPSHOT_HISTORY_LIMIT = 28;
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
var SHADOW_EXPLANATIONS_CAP = 200;
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
var EXPLORE_FRACTION = 0.1;
var FREE_MUST_BE_PROVEN_USD = 0.1;
var COST_BAND_MULTIPLIER = 1.2;
var CLASSIFY_FETCH_MULTIPLIER = 10;
var CLASSIFY_FETCH_LIMIT_MAX = 400;
var CLASSIFY_JOB_BUDGET_MS = 4 * 60 * 1e3;
var LABEL_ONLY_PASS_FETCH_LIMIT = 100;
var REPIN_PASS_FETCH_LIMIT = 400;
var REPIN_PASS_WRITE_LIMIT = 6;
var BALANCE_PASS_FETCH_LIMIT = 50;
var BALANCE_PASS_JOB_BUDGET_MS = 4 * 60 * 1e3;
var BALANCE_PASS_WRITE_LIMIT = 8;
var BALANCE_PASS_COST_DOWN_MULTIPLIER = 0.8;
var BALANCE_PASS_BUSIER_UTILIZATION_DELTA = 0.25;
var BALANCE_PASS_PROBATION_PRICE_USD = 0.1;
var DISPATCH_ISSUE_PAGE_LIMIT = 1e3;

// src/engine/pacing.ts
function mergeLedgerEntry(ledger, result) {
  const previous = ledger[result.laneId];
  const observed = result.verdict ? unserviceableVerdict(result.verdict) : null;
  const priorSince = previous?.unserviceableSince ?? null;
  const priorReason = previous?.unserviceableReason ?? null;
  let unserviceableSince;
  let unserviceableReason;
  if (observed === null) {
    unserviceableSince = priorSince;
    unserviceableReason = priorReason;
  } else if (observed) {
    unserviceableSince = priorSince ?? result.fetchedAt;
    unserviceableReason = result.verdict.reason;
  } else {
    unserviceableSince = null;
    unserviceableReason = null;
  }
  return {
    ...ledger,
    [result.laneId]: {
      laneId: result.laneId,
      verdict: result.verdict,
      observation: result.observation ?? null,
      fetchedAt: result.fetchedAt,
      error: result.error,
      unserviceableSince,
      unserviceableReason
    }
  };
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
var INDETERMINATE_CAPACITY_REASONS = /* @__PURE__ */ new Set([
  "indeterminate-account-weight",
  "invalid-configured-governing-window"
]);
function hardStopExcluded(ledger, model) {
  const laneId = model.laneId ?? null;
  if (!laneId) return false;
  const entry = ledger[laneId];
  if (!entry) return false;
  if (entry.verdict) return unserviceableVerdict(entry.verdict);
  return (entry.unserviceableSince ?? null) !== null;
}
function unserviceableVerdict(verdict) {
  if (verdict.serviceable === false) return true;
  return verdict.serviceable === null && INDETERMINATE_CAPACITY_REASONS.has(verdict.reason);
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
function avoidThresholdFor(config, laneId) {
  return config.perLane[laneId] ?? config.defaultThreshold;
}
function laneAvoidExcluded(ledger, model, config) {
  if (!model.laneId) return false;
  const verdict = laneVerdictFor(ledger, model.laneId);
  const utilization = verdict?.score?.utilization;
  if (utilization === null || utilization === void 0) return false;
  return utilization >= avoidThresholdFor(config, model.laneId);
}
function isLaneOutageActive(override, nowIso) {
  if (!override) return false;
  return override.until > nowIso;
}
function laneOutageExcluded(override, nowIso, model) {
  if (!isLaneOutageActive(override, nowIso)) return false;
  if (override.models.includes(model.id)) return true;
  if (model.laneId && override.lanes.includes(model.laneId)) return true;
  return false;
}
function blendedListPrice(model) {
  return (3 * model.costPerMTokIn + model.costPerMTokOut) / 4;
}
var ZAI_LONG_RUN_AGENTS = /* @__PURE__ */ new Set([
  "Founding Engineer",
  "Web Engineer",
  "Automation Engineer",
  "DevOps & Reliability Engineer",
  "CTO & Chief AI Officer",
  "Director of Engineering"
]);
function laneEffectiveUtilization(ledger, laneId) {
  const verdict = laneVerdictFor(ledger, laneId);
  const utilization = verdict?.score?.utilization;
  return utilization === null || utilization === void 0 ? 0.5 : utilization;
}
function zaiPeakNow(nowMs) {
  const now = new Date(nowMs);
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  return day >= 1 && day <= 5 && hour >= 6 && hour < 10;
}
function laneNamedWindowUtilization(ledger, laneId, windowName) {
  const observation = ledger[laneId]?.observation;
  if (!observation) return 0;
  const utilizations = observation.accounts.filter((account) => account.health === "healthy").flatMap((account) => {
    const window = account.windows.find((w) => w.name === windowName);
    return typeof window?.utilization === "number" ? [window.utilization] : [];
  });
  return utilizations.length > 0 ? Math.max(...utilizations) : 0;
}
function laneHealthyAccountCount(ledger, laneId) {
  const observation = ledger[laneId]?.observation;
  if (!observation) return 1;
  return observation.accounts.filter((account) => account.health === "healthy").length;
}
function activeZaiPaceOverride(override, nowIso) {
  if (!override) return null;
  return override.until > nowIso ? override.margin : null;
}
function zaiWeeklyPaceOk(input) {
  const margin = input.overrideMargin ?? input.defaultMargin;
  const observation = input.ledger[input.laneId]?.observation;
  const account = observation?.accounts[0];
  if (!account) return true;
  const window = account.windows.find((w) => w.name === input.weeklyWindowName);
  if (!window || window.utilization === null || window.resetsAt === null) return true;
  const remainingMs = Date.parse(window.resetsAt) - input.nowMs;
  const elapsed = 1 - Math.max(0, Math.min(1, remainingMs / (7 * 24 * 60 * 60 * 1e3)));
  return window.utilization <= elapsed + margin;
}
function laneHasRoom(input) {
  if (input.laneId === input.zaiLaneId) {
    const weeklyOk = zaiWeeklyPaceOk({
      ledger: input.ledger,
      laneId: input.laneId,
      weeklyWindowName: input.zaiWeeklyWindowName,
      defaultMargin: input.zaiWeeklyDefaultMargin,
      overrideMargin: input.zaiPaceOverrideMargin,
      nowMs: input.nowMs
    });
    if (!weeklyOk) return false;
  }
  let per = input.capPerAccount[input.laneId];
  if (input.laneId === input.zaiLaneId && per !== void 0 && zaiPeakNow(input.nowMs)) {
    per = 1;
  }
  if (per === void 0) return true;
  if (laneNamedWindowUtilization(input.ledger, input.laneId, input.fiveHourWindowName) >= 0.5) return false;
  const accounts = Math.max(1, laneHealthyAccountCount(input.ledger, input.laneId));
  return input.activePinsWeight + (input.extra ?? 0) < per * accounts;
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
    modelId: null,
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
    modelId: decision.modelId,
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
function fieldList(value, fallback) {
  const fields = Array.isArray(value) ? value.filter((field) => typeof field === "string" && field.length > 0) : [];
  return fields.length > 0 ? fields : [...fallback];
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
  const classification = record(root.classification);
  const earnIn = record(root.earnIn);
  const shadowEmit = record(root.shadowEmit);
  const aaSync = record(root.aaSync);
  const dispatch = record(root.dispatch);
  const wakeScopedFloor = record(root.wakeScopedFloor);
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
        aaSlug: typeof model.aaSlug === "string" && model.aaSlug.length > 0 ? model.aaSlug : null,
        aaIndexUpdatedAt: typeof model.aaIndexUpdatedAt === "string" ? model.aaIndexUpdatedAt : null,
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
          healthFields: fieldList(rawLane.healthFields, ["health", "status"]),
          accountKeyFields: fieldList(rawLane.accountKeyFields, DEFAULT_PACE_ACCOUNT_KEY_FIELDS),
          weightFields: fieldList(rawLane.weightFields, DEFAULT_PACE_WEIGHT_FIELDS),
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
      objective: selection.objective === "cost-per-accepted-card" ? "cost-per-accepted-card" : "list-price",
      fleetContextCeilingTokens: num(selection.fleetContextCeilingTokens, 1e6),
      compactionRatio: num(selection.compactionRatio, 0.75)
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
      idleRepinHysteresisSeconds: num(pacing.idleRepinHysteresisSeconds, DEFAULT_IDLE_REPIN_HYSTERESIS_SECONDS),
      avoid: (() => {
        const avoid = record(pacing.avoid);
        const rawPerLane = record(avoid.perLane);
        const keys = Object.keys(rawPerLane);
        if (keys.length === 0) {
          return { defaultThreshold: num(avoid.defaultThreshold, 0.8), perLane: { ...DEFAULT_AVOID_PER_LANE } };
        }
        const perLane = {};
        for (const [laneId, threshold] of Object.entries(rawPerLane)) {
          if (typeof threshold === "number" && Number.isFinite(threshold)) perLane[laneId] = threshold;
        }
        return { defaultThreshold: num(avoid.defaultThreshold, 0.8), perLane };
      })(),
      laneCapPerAccount: (() => {
        const raw2 = record(pacing.laneCapPerAccount);
        const keys = Object.keys(raw2);
        if (keys.length === 0) return { ...DEFAULT_LANE_CAP_PER_ACCOUNT };
        const perAccount = {};
        for (const [laneId, cap] of Object.entries(raw2)) {
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
          weeklyDefaultMargin: num(zai.weeklyDefaultMargin, DEFAULT_ZAI_WEEKLY_MARGIN)
        };
      })()
    },
    classification: {
      enabled: bool(classification.enabled, false),
      baseUrl: typeof classification.baseUrl === "string" && classification.baseUrl.length > 0 ? classification.baseUrl : null,
      protocol: classification.protocol === "openai-chat-completions" ? "openai-chat-completions" : "anthropic-messages",
      modelId: typeof classification.modelId === "string" && classification.modelId.length > 0 ? classification.modelId : null,
      apiKeySecretRef: secretRef(classification.apiKeySecretRef),
      requestTimeoutMs: num(classification.requestTimeoutMs, 15e3),
      maxResponseBytes: num(classification.maxResponseBytes, 65536),
      descriptionChars: num(classification.descriptionChars, 1500),
      maxOutputTokens: num(classification.maxOutputTokens, 120),
      t3ConfidenceFloor: num(classification.t3ConfidenceFloor, 0.7),
      t2ConfidenceFloor: num(classification.t2ConfidenceFloor, 0.6),
      batchSize: num(classification.batchSize, 20),
      reclassifyForeignLabels: bool(classification.reclassifyForeignLabels, true)
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
    },
    aaSync: {
      enabled: bool(aaSync.enabled, true)
    },
    dispatch: {
      wakeEnabled: bool(dispatch.wakeEnabled, false),
      idleMinutes: num(dispatch.idleMinutes, 120),
      maxWakesPerFiring: num(dispatch.maxWakesPerFiring, 3),
      focusProjectIds: Array.isArray(dispatch.focusProjectIds) ? dispatch.focusProjectIds.filter((p) => typeof p === "string") : []
    },
    wakeScopedFloor: {
      enabled: bool(wakeScopedFloor.enabled, true),
      wakeReasons: Array.isArray(wakeScopedFloor.wakeReasons) ? wakeScopedFloor.wakeReasons.filter((r) => typeof r === "string" && r.length > 0) : [],
      floorTier: tier(wakeScopedFloor.floorTier, "T3")
    }
  };
}
function validateConfig(config) {
  const errors = [];
  const warnings = [];
  const seen = /* @__PURE__ */ new Set();
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
      warnings.push(
        `${model.id} has costPerMTokCacheRead 0 \u2014 cache read is the largest cost line; a zero rate hides it`
      );
    }
  }
  if (!Number.isFinite(config.selection.compactionRatio) || config.selection.compactionRatio <= 0 || config.selection.compactionRatio >= 1) {
    errors.push("selection.compactionRatio must be greater than 0 and less than 1");
  }
  if (!Number.isFinite(config.selection.fleetContextCeilingTokens) || config.selection.fleetContextCeilingTokens < 1) {
    errors.push("selection.fleetContextCeilingTokens must be a positive number");
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
  if (config.classification.enabled) {
    if (!config.classification.baseUrl) {
      errors.push("classification.enabled is true but no classification.baseUrl is configured");
    }
    if (!config.classification.modelId) {
      errors.push("classification.enabled is true but no classification.modelId is configured");
    }
    const secretError = validateSecretRefShape(
      config.classification.apiKeySecretRef,
      "classification.apiKeySecretRef"
    );
    if (secretError) errors.push(secretError);
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
  if (config.wakeScopedFloor.enabled && config.wakeScopedFloor.wakeReasons.length === 0) {
    warnings.push(
      "wakeScopedFloor.enabled is true but wakeReasons is empty; no decision will ever qualify until an operator names the actual PAPERCLIP_WAKE_REASON values for cheap wakes (e.g. monitor ticks)"
    );
  }
  if (config.wakeScopedFloor.enabled && config.wakeScopedFloor.wakeReasons.length > 0) {
    const floorIndex = TIER_ORDER.indexOf(config.wakeScopedFloor.floorTier);
    const defaultIndex = TIER_ORDER.indexOf(config.selection.defaultTier);
    if (floorIndex >= defaultIndex) {
      warnings.push(
        `wakeScopedFloor.floorTier (${config.wakeScopedFloor.floorTier}) is not below selection.defaultTier (${config.selection.defaultTier}); a wake-scoped decision will only ever lower the floor for a card judged above that`
      );
    }
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

// src/engine/benchmark-prior.ts
var BENCHMARK_SPEC_VERSION = "tog2636-v1";
var BENCHMARKS = [
  { key: "terminalBenchV4Pass1", anchor: 0.6, weight: 0.25 },
  { key: "mercorApex11Pass1", anchor: 0.7, weight: 0.2 },
  { key: "automationBenchAaGuardrailAdjusted", anchor: 0.7, weight: 0.2 },
  { key: "aaOmniscienceSignedIndex", anchor: 45, weight: 0.2 },
  { key: "deepSweV11Pass1", anchor: 0.75, weight: 0.15 }
];
var MIN_POPULATED_BENCHMARKS = 3;
var MIN_AVAILABLE_WEIGHT = 0.75;
var BENCHMARK_BLEND = 0.3;
function clip(value, lo = 0, hi = 1) {
  return Math.max(lo, Math.min(hi, value));
}
function benchmarkPrior(row) {
  if (!row) return null;
  let weighted = 0;
  let availableWeight = 0;
  let populated = 0;
  for (const { key, anchor, weight } of BENCHMARKS) {
    const raw = row[key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    weighted += weight * clip(raw / anchor);
    availableWeight += weight;
    populated += 1;
  }
  if (populated < MIN_POPULATED_BENCHMARKS) return null;
  if (availableWeight < MIN_AVAILABLE_WEIGHT) return null;
  return weighted / availableWeight;
}
function indexPriorOrNull(aaIndex) {
  if (typeof aaIndex !== "number" || !Number.isFinite(aaIndex)) return null;
  return clip(0.55 + 0.45 * (aaIndex / 60), 0.55, 1);
}
function blendedPrior(aaIndex, row) {
  const index = indexPriorOrNull(aaIndex);
  if (index === null) return { value: null, basis: "unscored" };
  const basket = benchmarkPrior(row);
  if (basket === null) return { value: index, basis: "index-only" };
  return {
    value: (1 - BENCHMARK_BLEND) * index + BENCHMARK_BLEND * (0.55 + 0.45 * basket),
    basis: "blended"
  };
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

// src/engine/scores.ts
function priorP(aaIndex) {
  if (aaIndex === null) return 0.8;
  return Math.max(0.55, Math.min(1, 0.55 + 0.45 * (aaIndex / 60)));
}
function blendedPriorP(aaIndex, benchmarkRow) {
  const blended = blendedPrior(aaIndex, benchmarkRow);
  if (blended.value !== null) return blended.value;
  return priorP(aaIndex);
}
var TIER_ORDER_BY_CAPABILITY_DESC = [...TIER_ORDER].reverse();
function tierForPosterior(p, thresholds = SCORE_THRESHOLDS) {
  for (const tier2 of TIER_ORDER_BY_CAPABILITY_DESC) {
    const threshold = thresholds[tier2];
    if (threshold !== void 0 && p >= threshold) return { tier: tier2, belowT3Floor: false };
  }
  return { tier: "T3", belowT3Floor: true };
}
function deriveModelTier(aaIndex, benchmarkRow, overallStats, priorK = SCORE_PRIOR_K, thresholds = SCORE_THRESHOLDS) {
  const { value: prior, basis } = blendedPrior(aaIndex, benchmarkRow);
  if (prior === null) {
    return { tier: null, belowT3Floor: false, basis, prior: null, p: null, specVersion: BENCHMARK_SPEC_VERSION };
  }
  const nEff = overallStats.wOk + overallStats.wBad;
  const p = (overallStats.wOk + priorK * prior) / (nEff + priorK);
  const { tier: tier2, belowT3Floor } = tierForPosterior(p, thresholds);
  return { tier: tier2, belowT3Floor, basis, prior: round(prior, 4), p: round(p, 4), specVersion: BENCHMARK_SPEC_VERSION };
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
function buildModelScore(modelId, aaIndex, statsByTier, tiers, benchmarkRow) {
  const pp = blendedPriorP(aaIndex, benchmarkRow);
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
  const derivedTier = deriveModelTier(aaIndex, benchmarkRow, agg);
  return {
    modelId,
    aaIndex,
    priorP: round(pp, 3),
    tiers: tierScores,
    overall: summarize(agg, null, pp),
    derivedTier: derivedTier.tier,
    belowT3Floor: derivedTier.belowT3Floor,
    priorBasis: derivedTier.basis,
    tierSpecVersion: derivedTier.specVersion
  };
}
function applyDerivedTiers(models, scoresByModelId, specVersion = BENCHMARK_SPEC_VERSION) {
  const topRung = topConfiguredRungs(models);
  return models.map((model) => {
    const score2 = scoresByModelId[model.id];
    if (!score2 || !score2.derivedTier) return model;
    if (score2.tierSpecVersion !== specVersion) return model;
    const derived = score2.derivedTier;
    if (derived === model.tier) return model;
    if (tierIndex(derived) > tierIndex(model.tier)) {
      if (score2.priorBasis === "index-only") return model;
      if (model.tier !== topRung(model.id)) return model;
    }
    return { ...model, tier: derived };
  });
}
function topConfiguredRungs(models) {
  const enabledTop = /* @__PURE__ */ new Map();
  const anyTop = /* @__PURE__ */ new Map();
  const raise = (into, id, tier2) => {
    const current = into.get(id);
    if (current === void 0 || tierIndex(tier2) > tierIndex(current)) into.set(id, tier2);
  };
  for (const model of models) {
    raise(anyTop, model.id, model.tier);
    if (model.enabled !== false) raise(enabledTop, model.id, model.tier);
  }
  return (modelId) => enabledTop.get(modelId) ?? anyTop.get(modelId);
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

// src/aa-index/match.ts
var ID_PREFIX_RE = /^(cliproxy\/|openrouter\/|opencode-go\/|zai\/)/;
function normalizeModelId(modelId) {
  return modelId.replace(ID_PREFIX_RE, "").toLowerCase().replace(/\./g, "-");
}
function resolveAaSlug(modelId, knownSlugs, explicitSlug) {
  if (explicitSlug) return knownSlugs.has(explicitSlug) ? explicitSlug : null;
  const normalized = normalizeModelId(modelId);
  return knownSlugs.has(normalized) ? normalized : null;
}
function tierImpliedByIndex(index) {
  const p = priorP(index);
  for (const tier2 of [...TIER_ORDER].reverse()) {
    if (p >= SCORE_THRESHOLDS[tier2]) return tier2;
  }
  return null;
}
var EFFORT_SUFFIX_RE = /-(low|medium|high|xhigh|non-reasoning)$/;
function effortSuffixOf(slug) {
  return EFFORT_SUFFIX_RE.exec(slug)?.[1] ?? null;
}

// src/aa-index/parse.ts
var STRING_FIELDS = ["name", "shortName", "modelCreatorName", "paramClass", "priceClass"];
var BOOLEAN_FIELDS = ["deprecated", "isReasoning", "isOpenWeights", "intelligenceIndexIsEstimated"];
var AA_NUMERIC_FIELDS = [
  "intelligenceIndex",
  "intelligenceIndexCostPerTask",
  "price1mInputTokens",
  "price1mOutputTokens",
  "cacheHitPrice",
  "cacheWritePrice",
  "medianOutputTokensPerSecond",
  "outputTokensPerSecondP5",
  "outputTokensPerSecondP25",
  "outputTokensPerSecondP75",
  "outputTokensPerSecondP95",
  "medianTimeToFirstTokenSeconds",
  "medianTimeToFirstAnswerTokenSeconds",
  "medianEndToEndResponseTimeSeconds",
  "medianReasoningTimeSeconds",
  "contextWindowTokens",
  "gpqa",
  "hle",
  "critpt",
  "lcr",
  "ifbench",
  "tau2",
  "terminalbenchHard",
  "mmmuPro",
  "gdpvalNormalized",
  "terminalbenchV21",
  "tauBanking",
  "scicode",
  "terminalbenchV40",
  "itbenchSre",
  "analystAgent",
  "apexAgents",
  "omniscience",
  "omniscienceAccuracy",
  "omniscienceNonHallucination"
];
var ANCHOR = '{\\"models\\":[{\\"slug\\":\\"glm-4-5v\\"';
var ANCHOR_BRACKET_OFFSET = ANCHOR.indexOf("[");
function findAnchorIndex(html) {
  return html.indexOf(ANCHOR);
}
function extractBalancedArray(html, arrayStart) {
  let depth = 0;
  let inString = false;
  let i = arrayStart;
  for (; i < html.length; ) {
    const ch = html[i];
    const next = html[i + 1];
    if (ch === "\\" && next === '"') {
      inString = !inString;
      i += 2;
      continue;
    }
    if (ch === "\\" && next === "\\") {
      i += 2;
      continue;
    }
    if (inString) {
      i += 1;
      continue;
    }
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return html.slice(arrayStart, i + 1);
    }
    i += 1;
  }
  return null;
}
function unescapeOuterLayer(raw) {
  return raw.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}
function stringField(rec, key) {
  const value = rec[key];
  return typeof value === "string" ? value : null;
}
function booleanField(rec, key) {
  const value = rec[key];
  return typeof value === "boolean" ? value : null;
}
function numberField(rec, key) {
  const value = rec[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function buildRecord(rec) {
  const slug = rec.slug;
  if (typeof slug !== "string" || slug.length === 0) return null;
  const record2 = { slug };
  for (const key of STRING_FIELDS) record2[key] = stringField(rec, key);
  for (const key of BOOLEAN_FIELDS) record2[key] = booleanField(rec, key);
  for (const key of AA_NUMERIC_FIELDS) record2[key] = numberField(rec, key);
  return record2;
}
function parseAaLeaderboardHtml(html) {
  const anchorIndex = findAnchorIndex(html);
  if (anchorIndex < 0) return null;
  const arrayStart = anchorIndex + ANCHOR_BRACKET_OFFSET;
  const balanced = extractBalancedArray(html, arrayStart);
  if (balanced === null) return null;
  const unescaped = unescapeOuterLayer(balanced);
  let parsed;
  try {
    parsed = JSON.parse(unescaped);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const rows = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const record2 = buildRecord(entry);
    if (record2) rows.push(record2);
  }
  return rows.length > 0 ? rows : null;
}

// src/aa-index/diff.ts
function diffFields(previous, fresh) {
  const deltas = [];
  for (const field of AA_NUMERIC_FIELDS) {
    const prevValue = previous ? previous[field] : null;
    const freshValue = fresh[field];
    if (prevValue === null && freshValue === null) continue;
    if (prevValue === freshValue) continue;
    deltas.push({
      field,
      previous: prevValue,
      fresh: freshValue,
      delta: prevValue === null || freshValue === null ? null : freshValue - prevValue
    });
  }
  return deltas;
}
function diffSnapshot(models, freshBySlug, previousBySlug = /* @__PURE__ */ new Map()) {
  const rows = [];
  for (const model of models) {
    if (!model.slug) continue;
    const freshRecord = freshBySlug.get(model.slug);
    if (freshRecord === void 0 || freshRecord.intelligenceIndex === null) continue;
    const freshIndex = freshRecord.intelligenceIndex;
    const previousIndex = model.previousIndex;
    const delta = previousIndex === null ? null : freshIndex - previousIndex;
    const previousImpliedTier = previousIndex === null ? null : tierImpliedByIndex(previousIndex);
    const freshImpliedTier = tierImpliedByIndex(freshIndex);
    rows.push({
      modelId: model.modelId,
      previousIndex,
      freshIndex,
      delta,
      previousImpliedTier,
      freshImpliedTier,
      crossesBoundary: previousImpliedTier !== freshImpliedTier,
      fieldDeltas: diffFields(previousBySlug.get(model.slug), freshRecord)
    });
  }
  return rows;
}

// src/aa-index/fetch.ts
async function fetchAaSnapshot(input) {
  const fail = (error) => ({ ok: false, html: null, error });
  let parsed;
  try {
    parsed = new URL(input.url);
  } catch {
    return fail("aa-url-rejected");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    return fail("aa-url-rejected");
  }
  let response;
  try {
    let timer;
    response = await Promise.race([
      input.http.fetch(input.url, {
        method: "GET",
        headers: { Accept: "text/html", "Accept-Encoding": "identity" },
        redirect: "manual"
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("aa-request-timeout")), input.timeoutMs);
      })
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  } catch {
    return fail("aa-request-failed");
  }
  if (response.redirected || response.status >= 300 && response.status < 400) {
    return fail("aa-redirect-refused");
  }
  if (response.status < 200 || response.status >= 300) {
    return fail("aa-http-failed");
  }
  let text2;
  try {
    text2 = await response.text();
  } catch {
    return fail("aa-request-failed");
  }
  if (new TextEncoder().encode(text2).byteLength > input.maxResponseBytes) {
    return fail("aa-response-too-large");
  }
  return { ok: true, html: text2, error: null };
}

// src/engine/model-id.ts
var OMNIROUTE_PROVIDER_PREFIX = "cliproxy/";
function resolveConfiguredModelId(modelId, models) {
  if (!modelId) return null;
  if (models.some((model) => model.id === modelId)) return modelId;
  if (!modelId.startsWith(OMNIROUTE_PROVIDER_PREFIX)) return null;
  const directModelId = modelId.slice(OMNIROUTE_PROVIDER_PREFIX.length);
  return models.some((model) => model.id === directModelId) ? directModelId : null;
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
  const configuredId = resolveConfiguredModelId(modelId, models);
  if (!configuredId) return null;
  const matches = models.filter((model) => model.id === configuredId && model.enabled);
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
  const pinnedModelId = resolveConfiguredModelId(descriptor.pinnedModelId, models);
  const pinnedMatches = models.filter((model) => model.id === pinnedModelId && model.enabled);
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
      detail: `assigneeAdapterOverrides pins ${pinnedModelId} (${pinnedTier})`
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

// src/engine/pick-order.ts
function provenFor(modelScores, modelId, tier2) {
  return modelScores[modelId]?.tiers[tier2]?.proven ?? false;
}
function applyPickOrdering(candidates, models, ledger, modelScores, requiredTier, issueId, allowExplore = true) {
  if (candidates.length === 0) {
    return { ordered: [], explored: false, exploreModelId: null };
  }
  const modelOf2 = (candidate) => models.find((model) => model.id === candidate.modelId);
  const utilizationOf = (candidate) => {
    const model = modelOf2(candidate);
    return model?.laneId ? laneEffectiveUtilization(ledger, model.laneId) : 0.5;
  };
  const listPriceOf = (candidate) => {
    const model = modelOf2(candidate);
    return model ? blendedListPrice(model) : candidate.expectedCostUsd;
  };
  const provenOf = (candidate) => provenFor(modelScores, candidate.modelId, requiredTier);
  const unproven = candidates.filter((candidate) => !provenOf(candidate));
  if (allowExplore && requiredTier !== "T1" && unproven.length > 0 && hashUnitInterval(`explore:${requiredTier}:${issueId}`) < EXPLORE_FRACTION) {
    const explored = [...unproven].sort((a, b) => a.expectedCostUsd - b.expectedCostUsd)[0];
    return {
      ordered: [explored, ...candidates.filter((candidate) => candidate.modelId !== explored.modelId)],
      explored: true,
      exploreModelId: explored.modelId
    };
  }
  const main = candidates.filter((candidate) => provenOf(candidate) || listPriceOf(candidate) >= FREE_MUST_BE_PROVEN_USD);
  const pool = main.length > 0 ? main : candidates;
  const cheapest = Math.min(...pool.map((candidate) => candidate.expectedCostUsd));
  const band = pool.filter((candidate) => candidate.expectedCostUsd <= cheapest * COST_BAND_MULTIPLIER);
  const rest = candidates.filter((candidate) => !band.some((banded) => banded.modelId === candidate.modelId));
  const bandOrdered = [...band].sort((a, b) => {
    const utilizationDelta = utilizationOf(a) - utilizationOf(b);
    if (utilizationDelta !== 0) return utilizationDelta;
    if (a.expectedCostUsd !== b.expectedCostUsd) return a.expectedCostUsd - b.expectedCostUsd;
    const provenDelta = (provenOf(a) ? 0 : 1) - (provenOf(b) ? 0 : 1);
    if (provenDelta !== 0) return provenDelta;
    const tieA = hashUnitInterval(`${issueId}:${a.modelId}`);
    const tieB = hashUnitInterval(`${issueId}:${b.modelId}`);
    if (tieA !== tieB) return tieA - tieB;
    return a.modelId.localeCompare(b.modelId);
  });
  return { ordered: [...bandOrdered, ...rest], explored: false, exploreModelId: null };
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
  const overrideModelId = resolveConfiguredModelId(config.operatorOverrideModelId, config.models);
  const judgement = resolveTier(descriptor, config.models, config.defaultTier, {
    isLaneUnserviceable: (model) => paceActive && hardStopExcluded(ledger, model)
  });
  trace.push(`tier ${judgement.tier} via ${judgement.source} \u2014 ${judgement.detail}`);
  const wakeFloorConfig = config.wakeScopedFloor;
  const wakeReason = descriptor.wakeReason ?? null;
  const wakeFloorEligible = !!wakeFloorConfig?.enabled && !!wakeReason && wakeFloorConfig.wakeReasons.includes(wakeReason) && tierIndex(wakeFloorConfig.floorTier) < tierIndex(judgement.tier);
  const requiredTier = wakeFloorEligible ? wakeFloorConfig.floorTier : judgement.tier;
  if (wakeFloorEligible) {
    trace.push(
      `wake-scoped floor: wake reason "${wakeReason}" lowers the required tier from ${judgement.tier} to ${requiredTier} for this decision only \u2014 card tier unchanged, decision forced advisory`
    );
  }
  const base = {
    outcome: "no-eligible-model",
    modelId: null,
    judgement,
    effectiveTier: null,
    candidates: [],
    rejections,
    trace,
    advisory: !config.enforcementEnabled || wakeFloorEligible,
    heldReason: null,
    pacingApplied: false,
    shadowDiff: null,
    escalatedFromTier: null,
    wakeScopedTier: wakeFloorEligible ? requiredTier : null
  };
  const nowIso = new Date(now).toISOString();
  if (config.models.length === 0) {
    trace.push("no models configured for this company");
    return { ...base, outcome: "disabled" };
  }
  trace.push(`tier floor ${requiredTier}: no lower-capability model is eligible`);
  if (config.stickyWithinIssue && descriptor.stickyModelId) {
    const stickyModelId = resolveConfiguredModelId(descriptor.stickyModelId, config.models);
    const incumbent = config.models.find(
      (model) => model.id === stickyModelId && model.enabled
    );
    const incumbentUnserviceable = incumbent && paceActive && hardStopExcluded(ledger, incumbent);
    if (incumbent && tierIndex(incumbent.tier) < tierIndex(requiredTier)) {
      trace.push(
        `sticky ${incumbent.id} (${incumbent.tier}) declined: below the ${requiredTier} required tier`
      );
      rejections.push({
        modelId: incumbent.id,
        stage: "tier-floor",
        reason: `tier ${incumbent.tier} is below the ${requiredTier} required tier`,
        operand: { kind: "tier-floor", tier: incumbent.tier, requiredTier }
      });
    } else if (incumbent && typeof descriptor.requiredContextTokens === "number" && incumbent.contextWindow < descriptor.requiredContextTokens) {
      trace.push(
        `sticky ${incumbent.id} declined: context window ${incumbent.contextWindow} < required ${descriptor.requiredContextTokens}`
      );
      rejections.push({
        modelId: incumbent.id,
        stage: "context-window",
        reason: `context window ${incumbent.contextWindow} < required ${descriptor.requiredContextTokens}`,
        operand: {
          kind: "context-window",
          contextWindow: incumbent.contextWindow,
          requiredContextTokens: descriptor.requiredContextTokens
        }
      });
    } else if (incumbent && incumbentUnserviceable) {
      trace.push(
        `sticky ${incumbent.id} declined: lane ${incumbent.laneId ?? "(none)"} is not serviceable \u2014 re-selecting instead of wedging this issue on a dead lane`
      );
      rejections.push({
        modelId: incumbent.id,
        stage: "lane-unserviceable",
        reason: `lane ${incumbent.laneId ?? "(none)"} is not serviceable`,
        operand: {
          kind: "lane-unserviceable",
          laneId: incumbent.laneId ?? null,
          verdict: laneVerdictFor(ledger, incumbent.laneId)?.state ?? null
        }
      });
    } else if (incumbent) {
      trace.push(
        `sticky: ${incumbent.id} is already running this issue \u2014 switching would reset the session and discard the prompt cache`
      );
      return { ...base, outcome: "selected", modelId: incumbent.id, effectiveTier: incumbent.tier };
    }
  }
  const required = new Set(descriptor.requiredCapabilities ?? []);
  if (required.size > 0) {
    trace.push(`hard capability gate: ${[...required].sort().join(", ")}`);
  }
  const qualified = [];
  for (const model of config.models) {
    if (!model.enabled) {
      rejections.push({ modelId: model.id, stage: "disabled", reason: "disabled in the roster", operand: { kind: "disabled" } });
      continue;
    }
    const missing = [...required].filter((capability) => !model.capabilities.includes(capability));
    if (missing.length > 0) {
      rejections.push({
        modelId: model.id,
        stage: "capability",
        reason: `missing ${missing.sort().join(", ")}`,
        operand: { kind: "capability", missing: missing.sort() }
      });
      continue;
    }
    if (tierIndex(model.tier) < tierIndex(requiredTier)) {
      rejections.push({
        modelId: model.id,
        stage: "tier-floor",
        reason: `tier ${model.tier} is below the ${requiredTier} required tier`,
        operand: { kind: "tier-floor", tier: model.tier, requiredTier }
      });
      continue;
    }
    const score2 = config.modelScores?.[model.id]?.tiers[requiredTier];
    if (score2 && score2.capable === false) {
      rejections.push({
        modelId: model.id,
        stage: "capability-score",
        reason: `measured ${requiredTier} success rate (p=${score2.p}) is below the capability threshold`,
        operand: { kind: "capability-score", tier: requiredTier, p: score2.p }
      });
      continue;
    }
    if (typeof descriptor.requiredContextTokens === "number" && model.contextWindow < descriptor.requiredContextTokens) {
      rejections.push({
        modelId: model.id,
        stage: "context-window",
        reason: `context window ${model.contextWindow} < required ${descriptor.requiredContextTokens}`,
        operand: {
          kind: "context-window",
          contextWindow: model.contextWindow,
          requiredContextTokens: descriptor.requiredContextTokens
        }
      });
      continue;
    }
    if (paceActive && hardStopExcluded(ledger, model)) {
      rejections.push({
        modelId: model.id,
        stage: "lane-unserviceable",
        reason: `lane ${model.laneId ?? "(none)"} is not serviceable`,
        operand: {
          kind: "lane-unserviceable",
          laneId: model.laneId ?? null,
          verdict: laneVerdictFor(ledger, model.laneId)?.state ?? null
        }
      });
      continue;
    }
    if (paceActive && config.laneAvoidConfig && laneAvoidExcluded(ledger, model, config.laneAvoidConfig)) {
      rejections.push({
        modelId: model.id,
        stage: "lane-avoid",
        reason: `lane ${model.laneId ?? "(none)"} is at or above its avoid threshold`,
        operand: { kind: "lane-avoid", laneId: model.laneId ?? null }
      });
      continue;
    }
    if (paceActive && laneOutageExcluded(config.laneOutageOverride ?? null, nowIso, model)) {
      rejections.push({
        modelId: model.id,
        stage: "lane-outage",
        reason: `lane ${model.laneId ?? "(none)"} is under an operator-declared outage`,
        operand: { kind: "lane-outage", laneId: model.laneId ?? null }
      });
      continue;
    }
    if (paceActive && config.laneRoom && model.laneId) {
      const room = config.laneRoom;
      const admitted = laneHasRoom({
        laneId: model.laneId,
        activePinsWeight: room.activePinsWeightByLane[model.laneId] ?? 0,
        ledger,
        capPerAccount: room.capPerAccount,
        fiveHourWindowName: room.fiveHourWindowName,
        zaiLaneId: room.zaiLaneId,
        zaiWeeklyWindowName: room.zaiWeeklyWindowName,
        zaiWeeklyDefaultMargin: room.zaiWeeklyDefaultMargin,
        zaiPaceOverrideMargin: room.zaiPaceOverrideMargin,
        nowMs: room.now
      });
      if (!admitted) {
        rejections.push({
          modelId: model.id,
          stage: "lane-no-room",
          reason: `lane ${model.laneId} has no room for a new active card right now`,
          operand: { kind: "lane-no-room", laneId: model.laneId }
        });
        continue;
      }
    }
    if (paceActive && requiredTier === "T1" && model.laneId === (config.opencodeGoLaneId ?? LANE_ID_OPENCODE_GO) && config.laneAvoidConfig && laneEffectiveUtilization(ledger, config.codexLaneId ?? LANE_ID_CODEX) < avoidThresholdFor(config.laneAvoidConfig, config.codexLaneId ?? LANE_ID_CODEX)) {
      rejections.push({
        modelId: model.id,
        stage: "lane-avoid",
        reason: "T1 stays off opencode-go while the codex lane still has room (Go fallback only)",
        operand: { kind: "lane-avoid", laneId: model.laneId ?? null }
      });
      continue;
    }
    const zaiLaneId = config.zaiLaneId ?? LANE_ID_ZAI;
    const codexLaneId = config.codexLaneId ?? LANE_ID_CODEX;
    if (paceActive && model.laneId === zaiLaneId && descriptor.agentName && ZAI_LONG_RUN_AGENTS.has(descriptor.agentName) && config.laneAvoidConfig && laneEffectiveUtilization(ledger, codexLaneId) < avoidThresholdFor(config.laneAvoidConfig, codexLaneId) && config.models.some((entry) => entry.laneId === codexLaneId && entry.enabled)) {
      rejections.push({
        modelId: model.id,
        stage: "lane-avoid",
        reason: `long-turn agent "${descriptor.agentName}" stays off zai while the codex lane still has room (Z.ai 1214 risk)`,
        operand: { kind: "lane-avoid", laneId: model.laneId ?? null }
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
          reason: `no volume profile for ${requiredTier}; cannot cost this candidate`,
          operand: { kind: "no-profile", tier: requiredTier }
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
  if (config.modelScores) {
    const pickResult = applyPickOrdering(
      candidates,
      config.models,
      ledger,
      config.modelScores,
      requiredTier,
      descriptor.issueId,
      config.allowExplore ?? true
    );
    candidates = pickResult.ordered;
    trace.push(
      pickResult.explored ? `explore: routing to unproven ${pickResult.exploreModelId} to gather ${requiredTier} evidence` : "pick ordering: free-must-be-proven + 20% cost-band least-utilized-lane tiebreak applied"
    );
  }
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
    const floorModelId = resolveConfiguredModelId(descriptor.agentFloorModelId ?? null, config.models);
    const floorModel = floorModelId ? config.models.find((model) => model.id === floorModelId) : void 0;
    const floorLaneDead = paceActive && !!floorModel && (hardStopExcluded(ledger, floorModel) || !!config.laneAvoidConfig && laneAvoidExcluded(ledger, floorModel, config.laneAvoidConfig) || laneOutageExcluded(config.laneOutageOverride ?? null, nowIso, floorModel));
    if (floorLaneDead) {
      trace.push(
        `held-at-floor declined: floor ${floorModel.id} lane ${floorModel.laneId ?? "(none)"} is not serviceable \u2014 writing an explicit pin to ${winner.modelId} instead (${reason})`
      );
      return { ...withCandidates, outcome: "selected", modelId: winner.modelId };
    }
    trace.push(`held at agent floor: ${reason}`);
    return { ...withCandidates, outcome: "held-at-floor", heldReason: reason };
  }
  trace.push(
    `selected ${winner.modelId} at an expected $${winner.expectedCostUsd.toFixed(4)}/run (direct $${winner.runCostUsd.toFixed(4)} = in $${winner.inputCostUsd.toFixed(4)} + cache-read $${winner.cacheReadCostUsd.toFixed(4)} + out $${winner.outputCostUsd.toFixed(4)}; escalation risk $${winner.escalationRiskUsd.toFixed(4)}) \u2014 cheapest of ${candidates.length}; exact ties prefer newest releasedAt then stable model id${winner.fallbackOnly ? "; fallback-only path" : ""}`
  );
  if (!config.enforcementEnabled) {
    trace.push("advisory mode: enforcement is off, so this decision is recorded and not written");
  } else if (wakeFloorEligible) {
    trace.push(
      `advisory mode: wake-scoped floor decisions are never written, regardless of enforcement \u2014 the card's ${judgement.tier} tier is untouched`
    );
  }
  return { ...withCandidates, outcome: "selected", modelId: winner.modelId };
}

// src/engine/ancillary.ts
var ANCILLARY_ENV_KEYS = ["ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"];
var ANTHROPIC_DEFAULT_PREFIX = "ANTHROPIC_DEFAULT_";
function remediationFor(_surface) {
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
  return readings;
}
function ancillaryDriftForAgent(agent, recommendedModelId, models = []) {
  if (!recommendedModelId) return [];
  return readAncillarySurfaces(agent).filter((reading) => {
    if (reading.unresolvable || reading.currentModelId === null) return false;
    const configuredModelId = resolveConfiguredModelId(reading.currentModelId, models);
    return (configuredModelId ?? reading.currentModelId) !== recommendedModelId;
  }).map((reading) => ({
    ...reading,
    agentId: agent.id,
    agentName: agent.name,
    recommendedModelId,
    remediation: remediationFor(reading.surface)
  }));
}

// src/engine/context.ts
var CONTEXT_LIMIT_ENV_KEY = "CLAUDE_CODE_MAX_CONTEXT_TOKENS";
function positiveInteger(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}
function estimateIssueContext(input) {
  const explicit = positiveInteger(input.explicitTokens);
  if (explicit !== null) return { tokens: explicit, source: "explicit" };
  const fleetCeiling = positiveInteger(input.fleetCeilingTokens);
  const capObserved = (value) => {
    const tokens = positiveInteger(value);
    if (tokens === null) return null;
    return fleetCeiling === null ? tokens : Math.min(tokens, fleetCeiling);
  };
  const inputContextTotal = (uncached, cached) => {
    const parts = [uncached, cached].filter(
      (value) => typeof value === "number" && Number.isFinite(value) && value >= 0
    );
    if (parts.length === 0) return null;
    return positiveInteger(parts.reduce((total, value) => total + Math.floor(value), 0));
  };
  const lastRun = capObserved(
    inputContextTotal(input.lastRunInputTokens, input.lastRunCachedInputTokens)
  );
  if (lastRun !== null) return { tokens: lastRun, source: "last-run-context" };
  return { tokens: null, source: "none" };
}
var ANCILLARY_MODEL_ENV_KEYS = [
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL"
];
function isSecretBinding(binding) {
  if (!binding || typeof binding !== "object") return false;
  const type = binding.type;
  return type === "secret_ref" || type === "user_secret_ref";
}
function modelOverrideForContext(input) {
  const agentEnvKnown = input.agentEnv !== null && input.agentEnv !== void 0;
  const agentEnv = input.agentEnv ?? {};
  const overrideEnv = input.existingOverrideEnv ?? {};
  const env = { ...agentEnv, ...overrideEnv };
  const fleetCeiling = positiveInteger(input.fleetCeilingTokens);
  const modelWindow = positiveInteger(input.model.contextWindow);
  const ratio = Number.isFinite(input.compactionRatio) && input.compactionRatio > 0 && input.compactionRatio < 1 ? input.compactionRatio : 0.75;
  if (fleetCeiling !== null && modelWindow !== null && modelWindow < fleetCeiling) {
    env[CONTEXT_LIMIT_ENV_KEY] = {
      type: "plain",
      value: String(Math.max(1, Math.floor(modelWindow * ratio)))
    };
  } else {
    delete env[CONTEXT_LIMIT_ENV_KEY];
  }
  if (agentEnvKnown) {
    for (const key of ANCILLARY_MODEL_ENV_KEYS) {
      if (isSecretBinding(env[key])) continue;
      env[key] = { type: "plain", value: input.model.id };
    }
  }
  const mustWriteEnv = Object.keys(env).length > 0 || CONTEXT_LIMIT_ENV_KEY in agentEnv || CONTEXT_LIMIT_ENV_KEY in overrideEnv;
  return {
    assigneeAdapterOverrides: {
      adapterConfig: {
        model: input.model.id,
        ...mustWriteEnv ? { env } : {}
      }
    }
  };
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
    const configuredId = resolveConfiguredModelId(row.model, models);
    const tiers = configuredId ? tiersOf.get(configuredId) : void 0;
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

// src/engine/benchmark-data.ts
var FROZEN_BENCHMARK_ROWS = {
  "claude-fable-5-1": { terminalBenchV4Pass1: 0.52020202020202, mercorApex11Pass1: 0.6859999999999999, automationBenchAaGuardrailAdjusted: 0.5937591715646424, aaOmniscienceSignedIndex: 43.45 },
  "claude-haiku-4-5-20251001": { aaOmniscienceSignedIndex: -7.56666666666667 },
  "claude-opus-5": { terminalBenchV4Pass1: 0.48989898989899, mercorApex11Pass1: 0.6579999999999999, automationBenchAaGuardrailAdjusted: 0.565735557649325, aaOmniscienceSignedIndex: 37.0666666666667 },
  "claude-sonnet-5": { terminalBenchV4Pass1: 0.141414141414141, aaOmniscienceSignedIndex: 16.45 },
  "deepseek-v4-flash": { terminalBenchV4Pass1: 0.121212121212121, aaOmniscienceSignedIndex: -14.2833333333333 },
  "deepseek-v4-flash-free": { terminalBenchV4Pass1: 0.121212121212121, aaOmniscienceSignedIndex: -14.2833333333333 },
  "deepseek-v4-flash-vision-exp": { terminalBenchV4Pass1: 0.121212121212121, aaOmniscienceSignedIndex: -17.6333333333333 },
  "deepseek-v4-pro": { terminalBenchV4Pass1: 0.141414141414141, automationBenchAaGuardrailAdjusted: 0.5671165546344002, aaOmniscienceSignedIndex: 0.833333333333333 },
  "deepseek-v4.1-flash": { terminalBenchV4Pass1: 0.267676767676768, automationBenchAaGuardrailAdjusted: 0.6889097769674057, aaOmniscienceSignedIndex: -5.3 },
  "gemini-3-flash": { aaOmniscienceSignedIndex: -4.31666666666667 },
  "gemini-3.6-flash-high": { terminalBenchV4Pass1: 0.0707070707070707, mercorApex11Pass1: 0.469, aaOmniscienceSignedIndex: 22.1333333333333 },
  "gemini-3.7-flash-high": { terminalBenchV4Pass1: 0.136363636363636, mercorApex11Pass1: 0.6779999999999999, aaOmniscienceSignedIndex: 26.4833333333333 },
  "gemini-3.8-flash-high": { terminalBenchV4Pass1: 0.196969696969697, mercorApex11Pass1: 0.643, automationBenchAaGuardrailAdjusted: 0.5993009432118243, aaOmniscienceSignedIndex: 29.55 },
  "glm-5": { aaOmniscienceSignedIndex: 0.266666666666667 },
  "glm-5.1": { terminalBenchV4Pass1: 0.0202020202020202, aaOmniscienceSignedIndex: 0.85 },
  "glm-5.2": { terminalBenchV4Pass1: 0.0101010101010101, aaOmniscienceSignedIndex: 4.43333333333333 },
  "glm-5.3": { terminalBenchV4Pass1: 0.419191919191919, mercorApex11Pass1: 0.5660000000000001, automationBenchAaGuardrailAdjusted: 0.622028649962642, aaOmniscienceSignedIndex: 14.3 },
  "glm-5.3-flash": { terminalBenchV4Pass1: 0.328282828282828, mercorApex11Pass1: 0.528, automationBenchAaGuardrailAdjusted: 0.6036862782167782, aaOmniscienceSignedIndex: 7.46666666666667 },
  "gpt-5.5": { terminalBenchV4Pass1: 0.146464646464646, mercorApex11Pass1: 0.551, aaOmniscienceSignedIndex: 20.5166666666667 },
  "gpt-5.6-luna": { terminalBenchV4Pass1: 0.116161616161616, automationBenchAaGuardrailAdjusted: 0.5020861763756194, aaOmniscienceSignedIndex: -10.2833333333333 },
  "gpt-5.6-sol": { terminalBenchV4Pass1: 0.398989898989899, mercorApex11Pass1: 0.514, automationBenchAaGuardrailAdjusted: 0.6008114996276329, aaOmniscienceSignedIndex: 21.9666666666667 },
  "gpt-5.6-terra": { terminalBenchV4Pass1: 0.353535353535354, mercorApex11Pass1: 0.5820000000000001, automationBenchAaGuardrailAdjusted: 0.5964995802534495, aaOmniscienceSignedIndex: 0.05 },
  "gpt-oss-120b-medium": { terminalBenchV4Pass1: 0, automationBenchAaGuardrailAdjusted: 0.0019906990691605595, aaOmniscienceSignedIndex: -49.25 },
  "mimo-v2-omni": { aaOmniscienceSignedIndex: -20.1333333333333 },
  "mimo-v2-pro": { aaOmniscienceSignedIndex: 4.61666666666667 },
  "mimo-v2.5-pro": { terminalBenchV4Pass1: 0, aaOmniscienceSignedIndex: 3.25 },
  "minimax-m2.5": { aaOmniscienceSignedIndex: -38.8666666666667 },
  "minimax-m3": { terminalBenchV4Pass1: 0.0202020202020202, automationBenchAaGuardrailAdjusted: 0.21251257600749407, aaOmniscienceSignedIndex: 1.35 },
  "qwen3.6-plus": { aaOmniscienceSignedIndex: 0.883333333333333 },
  "qwen3.7-max": { terminalBenchV4Pass1: 0.0151515151515152, aaOmniscienceSignedIndex: 13.4833333333333 },
  "qwen3.8-max": { terminalBenchV4Pass1: 0.186868686868687, aaOmniscienceSignedIndex: 3.4 },
  "zai-openai/glm-5.3": { terminalBenchV4Pass1: 0.419191919191919, mercorApex11Pass1: 0.5660000000000001, automationBenchAaGuardrailAdjusted: 0.622028649962642, aaOmniscienceSignedIndex: 14.3 },
  "zai-openai/glm-5.3-flash": { terminalBenchV4Pass1: 0.328282828282828, mercorApex11Pass1: 0.528, automationBenchAaGuardrailAdjusted: 0.6036862782167782, aaOmniscienceSignedIndex: 7.46666666666667 },
  "zai/glm-5.3": { terminalBenchV4Pass1: 0.419191919191919, mercorApex11Pass1: 0.5660000000000001, automationBenchAaGuardrailAdjusted: 0.622028649962642, aaOmniscienceSignedIndex: 14.3 },
  "zai/glm-5.3-flash": { terminalBenchV4Pass1: 0.328282828282828, mercorApex11Pass1: 0.528, automationBenchAaGuardrailAdjusted: 0.6036862782167782, aaOmniscienceSignedIndex: 7.46666666666667 }
};

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
function nonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function firstNumber(record2, fields, mode = "finite") {
  const value = firstValue(record2, fields)?.value;
  return mode === "non-negative" ? nonNegativeNumber(value) : finiteNumber(value);
}
function text(record2, fields) {
  const value = firstValue(record2, fields)?.value;
  return typeof value === "string" && value.trim() ? value : null;
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
  return reported === null ? { weight: null, source: "unknown" } : { weight: reported, source: "reported" };
}
function accountKey(record2, fields) {
  return text(record2, fields)?.trim() ?? null;
}
function hasReportedAccountDecision(account) {
  return account.governingWindow !== null && (account.targetBurnRate !== null || account.deficit !== null || account.recommendedShare !== null);
}
function recordWindows(record2) {
  return Array.isArray(record2.windows) ? record2.windows.map(recordOf).filter((window) => window !== null) : [];
}
function matchingWindowRecord(record2, window) {
  return recordWindows(record2).find((candidate) => candidate.name === window.name) ?? null;
}
function nestedOrFlatValue(record2, nested, nestedField, flatFields) {
  if (nested && nestedField in nested) return { field: `windows.${nestedField}`, value: nested[nestedField] };
  return firstValue(record2, flatFields) ?? null;
}
function normalizeLaneDocument(input) {
  const document = recordOf(input.document);
  if (!document) {
    return { laneId: input.definition.laneId, free: Boolean(input.definition.free), observedAt: null, staleAfterSeconds: null, accounts: [], error: "invalid-document" };
  }
  const records = Array.isArray(document.records) ? document.records : [];
  const observedAt = timestamp(document.observedAt);
  const staleAfterSeconds = positiveNumber(document[input.definition.staleAfterSecondsField ?? "staleAfterSeconds"]);
  const empty = (error) => ({
    laneId: input.definition.laneId,
    free: Boolean(input.definition.free),
    observedAt,
    staleAfterSeconds,
    accounts: [],
    error
  });
  if (records.length === 0) return empty("no-records");
  const parsedRecords = records.map(recordOf);
  if (parsedRecords.some((record2) => record2 === null)) return empty("invalid-document");
  const validRecords = parsedRecords;
  const accountKeyFields = [...input.definition.accountKeyFields ?? DEFAULT_PACE_ACCOUNT_KEY_FIELDS];
  const accountKeys = validRecords.map((record2) => accountKey(record2, accountKeyFields));
  if (accountKeys.some((key) => key === null) || new Set(accountKeys).size !== accountKeys.length) {
    return empty("invalid-account-identity");
  }
  const governingWindowField = input.definition.governingWindowField ?? "governing_window";
  const windowSecondsField = input.definition.windowSecondsField ?? "window_seconds";
  const weightFields = [...input.definition.weightFields ?? DEFAULT_PACE_WEIGHT_FIELDS];
  const accounts = validRecords.map((record2, index) => {
    const weight = normalizedWeight(record2, weightFields);
    const reportedGoverningWindow = typeof record2[governingWindowField] === "string" ? record2[governingWindowField] : null;
    return {
      accountKey: accountKeys[index],
      authKey: text(record2, ["auth_key", "authKey"]),
      plan: text(record2, ["plan"]),
      health: normalizeHealth(firstValue(record2, input.definition.healthFields)?.value) ?? "unknown",
      weight: weight.weight,
      weightSource: weight.source,
      governingWindow: reportedGoverningWindow,
      governingResetAt: timestamp(firstValue(record2, ["governing_reset_at", "governing_resets_at", "governingResetAt", "binding_reset_at", "bindingResetAt"])?.value),
      normalizedRemaining: firstNumber(record2, ["normalized_remaining", "normalizedRemaining"], "non-negative"),
      targetBurnRate: firstNumber(record2, ["target_burn_rate", "targetBurnRate", "clear_rate", "clearRate"], "non-negative"),
      observedBurnRate: firstNumber(record2, ["observed_burn_rate", "observedBurnRate", "recent_burn_units_per_hour"], "non-negative"),
      deficit: firstNumber(record2, ["deficit"]),
      recommendedShare: firstNumber(record2, ["recommended_share", "recommendedShare"], "non-negative"),
      recentBurnUnitsPerHour: firstNumber(record2, ["recent_burn_units_per_hour"], "non-negative"),
      staleAfterSeconds: positiveNumber(record2.stale_after_seconds),
      windows: input.definition.windows.map((window) => {
        const nested = matchingWindowRecord(record2, window);
        const utilization = nestedOrFlatValue(record2, nested, "utilization", window.utilizationFields);
        const reset = nestedOrFlatValue(record2, nested, "resets_at", window.resetFields);
        const reportedAllowanceWeight = positiveNumber(nested?.allowance_weight);
        const invalidReportedAllowanceWeight = nested !== null && "allowance_weight" in nested && nested.allowance_weight !== null && nested.allowance_weight !== void 0 && reportedAllowanceWeight === null;
        return {
          name: window.name,
          role: window.role,
          utilization: fraction(utilization?.value),
          resetsAt: timestamp(reset?.value),
          windowSeconds: positiveNumber(nested?.window_seconds) ?? windowSeconds(record2, windowSecondsField, window),
          allowanceWeight: invalidReportedAllowanceWeight ? null : reportedAllowanceWeight ?? (window.role === "allowance" ? weight.weight : null),
          allowanceWeightSource: invalidReportedAllowanceWeight ? "unknown" : reportedAllowanceWeight !== null ? "reported" : weight.source === "reported" ? "account" : "unknown",
          sourcePath: utilization?.field ?? null
        };
      })
    };
  });
  return {
    laneId: input.definition.laneId,
    free: Boolean(input.definition.free),
    observedAt,
    staleAfterSeconds,
    accounts,
    error: null
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
function scoredWindow(window, observedAtMs) {
  if (window.utilization === null || window.resetsAt === null || window.windowSeconds === null) {
    return {
      ...window,
      elapsed: null,
      normalizedRemaining: null,
      paceDebt: null,
      clearRate: null,
      serviceable: window.utilization === null || window.utilization < 1
    };
  }
  const remainingSeconds = (Date.parse(window.resetsAt) - observedAtMs) / 1e3;
  const elapsed = Math.min(1, Math.max(0, 1 - remainingSeconds / window.windowSeconds));
  const allowanceWeight = window.allowanceWeight ?? null;
  const normalizedRemaining = allowanceWeight === null ? null : allowanceWeight * Math.max(0, 1 - window.utilization);
  const remainingHours = Math.max(1, remainingSeconds / 3600);
  return {
    ...window,
    elapsed,
    normalizedRemaining,
    paceDebt: allowanceWeight === null ? null : allowanceWeight * (elapsed - window.utilization),
    clearRate: normalizedRemaining === null ? null : normalizedRemaining / remainingHours,
    serviceable: window.utilization < 1
  };
}
function bindingWindow(windows, configured) {
  const allowances = windows.filter(
    (window) => window.role === "allowance" && window.utilization !== null && window.resetsAt !== null && window.windowSeconds !== null && window.clearRate !== null
  );
  const tightest = [...allowances].sort(
    (left, right) => left.clearRate - right.clearRate || left.name.localeCompare(right.name)
  )[0] ?? null;
  if (configured === null) return tightest;
  const declared = allowances.find((window) => window.name === configured) ?? null;
  if (declared === null) return null;
  return tightest !== null && tightest.clearRate < declared.clearRate ? tightest : declared;
}
function urgentPushResetAt(windows, asOfMs, marginMilli, urgentResetSeconds) {
  return windows.filter((window) => window.role === "allowance" && window.serviceable && window.utilization !== null && window.elapsed !== null && window.resetsAt !== null && stateFor(toMilli(window.utilization) - toMilli(window.elapsed), marginMilli) === "behind").map((window) => ({ resetsAt: window.resetsAt, resetSeconds: (Date.parse(window.resetsAt) - asOfMs) / 1e3 })).filter((entry) => entry.resetSeconds >= 0 && entry.resetSeconds < urgentResetSeconds).sort((left, right) => left.resetSeconds - right.resetSeconds)[0]?.resetsAt ?? null;
}
function governingWindow(account, windows) {
  const binding = bindingWindow(windows, account.governingWindow);
  if (binding) return binding;
  if (account.governingWindow !== null) return null;
  return windows.filter((window) => window.role === "serviceability" && window.utilization !== null).sort((left, right) => right.windowSeconds - left.windowSeconds || left.name.localeCompare(right.name))[0] ?? null;
}
function serviceable(account, windows) {
  if (account.health === "exhausted" || account.health === "unavailable") return false;
  return windows.every((window) => window.utilization === null || window.utilization < 1);
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
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "free", serviceable: true, score: null, targetBurnRate: null, observedBurnRate: null, deficit: null, accounts: [], knownAccountCount: 0, knownWeight: 0, serviceableAccountCount: 0, urgentResetAt: null, reason: "free-lane" };
  }
  if (input.observation.error === "invalid-document" || input.observation.observedAt === null || asOf === null) {
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "unknown", serviceable: null, score: null, targetBurnRate: null, observedBurnRate: null, deficit: null, accounts: [], knownAccountCount: 0, knownWeight: 0, serviceableAccountCount: 0, urgentResetAt: null, reason: "document-unavailable" };
  }
  if (input.observation.error === "invalid-account-identity") {
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "unknown", serviceable: null, score: null, targetBurnRate: null, observedBurnRate: null, deficit: null, accounts: [], knownAccountCount: 0, knownWeight: 0, serviceableAccountCount: 0, urgentResetAt: null, reason: "invalid-account-identity" };
  }
  if (input.observation.error === "no-records") {
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "unknown", serviceable: null, score: null, targetBurnRate: null, observedBurnRate: null, deficit: null, accounts: [], knownAccountCount: 0, knownWeight: 0, serviceableAccountCount: 0, urgentResetAt: null, reason: "no-records" };
  }
  const observedAtMs = Date.parse(input.observation.observedAt);
  const asOfMs = Date.parse(asOf);
  const freshnessBudget = Math.min(input.observation.staleAfterSeconds ?? maxSnapshotAgeSeconds, maxSnapshotAgeSeconds);
  if ((asOfMs - observedAtMs) / 1e3 > freshnessBudget) {
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "unknown", serviceable: null, score: null, targetBurnRate: null, observedBurnRate: null, deficit: null, accounts: [], knownAccountCount: 0, knownWeight: 0, serviceableAccountCount: 0, urgentResetAt: null, reason: "snapshot-stale" };
  }
  const internal = input.observation.accounts.map((account) => {
    const windows = account.windows.map((window) => scoredWindow(window, observedAtMs));
    const binding = bindingWindow(windows, account.governingWindow);
    const governing = governingWindow(account, windows);
    const accountStale = account.staleAfterSeconds != null && (asOfMs - observedAtMs) / 1e3 > account.staleAfterSeconds;
    const accountServiceable = !accountStale && serviceable(account, windows);
    const unknownAllowanceWeight = windows.some(
      (window) => window.role === "allowance" && window.utilization !== null && window.resetsAt !== null && window.windowSeconds !== null && window.allowanceWeight === null
    );
    if (!governing) {
      const exhausted2 = account.health === "exhausted" || account.health === "unavailable";
      const indeterminateGovernor = accountServiceable && account.governingWindow !== null;
      return {
        verdict: {
          accountKey: account.accountKey,
          authKey: account.authKey,
          plan: account.plan,
          health: account.health,
          weight: account.weight,
          weightSource: account.weightSource,
          governingWindow: null,
          governingResetAt: null,
          bindingWindow: null,
          bindingResetAt: null,
          recentBurnUnitsPerHour: account.recentBurnUnitsPerHour,
          staleAfterSeconds: account.staleAfterSeconds,
          serviceable: accountServiceable && !indeterminateGovernor,
          state: exhausted2 ? "exhausted" : "unknown",
          score: null,
          normalizedRemaining: null,
          targetBurnRate: null,
          observedBurnRate: account.recentBurnUnitsPerHour ?? null,
          deficit: null,
          recommendedShare: 0,
          paceDebt: null,
          clearRate: null,
          windows
        },
        utilizationMilli: null,
        elapsedMilli: null,
        resetAtMs: null,
        aggregateWeight: null,
        indeterminateWeight: accountServiceable && unknownAllowanceWeight,
        indeterminateGovernor
      };
    }
    const utilizationMilli2 = toMilli(governing.utilization);
    const elapsedMilli2 = toMilli(governing.elapsed);
    const accountScore = score(utilizationMilli2, elapsedMilli2);
    const exhausted = !accountServiceable;
    const declaredGoverns = account.governingWindow !== null && governing.name === account.governingWindow;
    const reportedTargetBurnRate = declaredGoverns ? account.targetBurnRate : null;
    const reportedDeficit = declaredGoverns ? account.deficit : null;
    const effectiveTargetBurnRate = reportedTargetBurnRate ?? governing.clearRate;
    const reportedDecision = declaredGoverns && hasReportedAccountDecision(account);
    const effectiveDeficit = reportedDeficit ?? ((account.observedBurnRate ?? account.recentBurnUnitsPerHour) == null || effectiveTargetBurnRate == null ? effectiveTargetBurnRate : effectiveTargetBurnRate - (account.observedBurnRate ?? account.recentBurnUnitsPerHour));
    let state2 = exhausted ? "exhausted" : reportedDecision && effectiveDeficit !== null ? effectiveDeficit > 0 ? "behind" : effectiveDeficit < 0 ? "ahead" : "on" : stateFor(utilizationMilli2 - elapsedMilli2, marginMilli);
    const resetAt = (declaredGoverns ? account.governingResetAt : null) ?? governing.resetsAt;
    const resetSeconds = (Date.parse(resetAt) - asOfMs) / 1e3;
    const governingUrgent = state2 === "behind" && resetSeconds >= 0 && resetSeconds < urgentResetSeconds;
    const windowUrgentResetAt = exhausted ? null : urgentPushResetAt(windows, asOfMs, marginMilli, urgentResetSeconds);
    const urgentResetAt = governingUrgent ? windowUrgentResetAt !== null && Date.parse(windowUrgentResetAt) < Date.parse(resetAt) ? windowUrgentResetAt : resetAt : windowUrgentResetAt;
    if (!exhausted && urgentResetAt !== null) state2 = "push";
    return {
      verdict: {
        accountKey: account.accountKey,
        authKey: account.authKey,
        plan: account.plan,
        health: account.health,
        weight: account.weight,
        weightSource: account.weightSource,
        governingWindow: governing.name,
        governingResetAt: resetAt,
        bindingWindow: binding?.name ?? null,
        bindingResetAt: binding?.resetsAt ?? null,
        urgentResetAt,
        recentBurnUnitsPerHour: account.recentBurnUnitsPerHour,
        staleAfterSeconds: account.staleAfterSeconds,
        serviceable: accountServiceable,
        state: state2,
        score: accountScore,
        normalizedRemaining: (declaredGoverns ? account.normalizedRemaining : null) ?? governing.normalizedRemaining,
        targetBurnRate: effectiveTargetBurnRate,
        observedBurnRate: account.observedBurnRate ?? account.recentBurnUnitsPerHour ?? null,
        deficit: effectiveDeficit,
        recommendedShare: declaredGoverns ? account.recommendedShare : null,
        paceDebt: governing.paceDebt,
        clearRate: governing.clearRate,
        windows
      },
      utilizationMilli: utilizationMilli2,
      elapsedMilli: elapsedMilli2,
      resetAtMs: Date.parse(urgentResetAt ?? resetAt),
      aggregateWeight: governing.allowanceWeight ?? account.weight,
      indeterminateWeight: accountServiceable && (governing.allowanceWeight ?? account.weight) === null,
      indeterminateGovernor: false
    };
  });
  const serviceableAccountCount = internal.filter((entry) => entry.verdict.serviceable).length;
  const shareCandidates = internal.filter((entry) => entry.verdict.serviceable && entry.verdict.targetBurnRate != null);
  const useReportedShares = shareCandidates.length > 0 && shareCandidates.every((entry) => entry.verdict.recommendedShare != null);
  const rawShare = (entry) => useReportedShares ? Math.max(0, entry.verdict.recommendedShare) : Math.max(0, entry.verdict.deficit ?? entry.verdict.targetBurnRate);
  const shareDenominator = shareCandidates.reduce((sum, entry) => sum + rawShare(entry), 0);
  const accounts = internal.map((entry) => ({
    ...entry.verdict,
    recommendedShare: !entry.verdict.serviceable || entry.verdict.targetBurnRate == null || shareDenominator <= 0 ? 0 : rawShare(entry) / shareDenominator
  }));
  if (internal.some((entry) => entry.indeterminateWeight)) {
    const weighted = internal.filter((entry) => entry.verdict.serviceable && entry.aggregateWeight !== null);
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "unknown", serviceable: null, score: null, targetBurnRate: null, observedBurnRate: null, deficit: null, accounts, knownAccountCount: weighted.length, knownWeight: weighted.reduce((sum, entry) => sum + entry.aggregateWeight, 0), serviceableAccountCount, urgentResetAt: null, reason: "indeterminate-account-weight" };
  }
  if (internal.some((entry) => entry.indeterminateGovernor)) {
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "unknown", serviceable: null, score: null, targetBurnRate: null, observedBurnRate: null, deficit: null, accounts, knownAccountCount: 0, knownWeight: 0, serviceableAccountCount, urgentResetAt: null, reason: "invalid-configured-governing-window" };
  }
  if (serviceableAccountCount === 0) {
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "exhausted", serviceable: false, score: null, targetBurnRate: 0, observedBurnRate: 0, deficit: 0, accounts, knownAccountCount: internal.filter((entry) => entry.utilizationMilli !== null).length, knownWeight: internal.filter((entry) => entry.utilizationMilli !== null).reduce((sum, entry) => sum + (entry.aggregateWeight ?? 0), 0), serviceableAccountCount, urgentResetAt: null, reason: "all-accounts-unserviceable" };
  }
  const known = internal.filter(
    (entry) => entry.verdict.serviceable && entry.utilizationMilli !== null && entry.elapsedMilli !== null && entry.resetAtMs !== null && entry.aggregateWeight !== null
  );
  if (known.length === 0) {
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "unknown", serviceable: true, score: null, targetBurnRate: null, observedBurnRate: null, deficit: null, accounts, knownAccountCount: 0, knownWeight: 0, serviceableAccountCount, urgentResetAt: null, reason: "no-computable-governing-window" };
  }
  const utilizationMilli = weightedMilli(known.map((entry) => ({ value: entry.utilizationMilli, weight: entry.aggregateWeight })));
  const elapsedMilli = weightedMilli(known.map((entry) => ({ value: entry.elapsedMilli, weight: entry.aggregateWeight })));
  const laneScore = score(utilizationMilli, elapsedMilli);
  const targetBurnRate = accounts.reduce(
    (sum, account) => account.serviceable && account.targetBurnRate != null ? sum + account.targetBurnRate : sum,
    0
  );
  const observedBurnRate = accounts.reduce(
    (sum, account) => account.serviceable && account.observedBurnRate != null ? sum + account.observedBurnRate : sum,
    0
  );
  const deficit = accounts.reduce(
    (sum, account) => account.serviceable && account.deficit != null ? sum + account.deficit : sum,
    0
  );
  let state = stateFor(utilizationMilli - elapsedMilli, marginMilli);
  const urgent = known.filter((entry) => entry.verdict.state === "push").sort((left, right) => left.resetAtMs - right.resetAtMs)[0];
  if (urgent) state = "behind-urgent";
  return {
    laneId: input.observation.laneId,
    observedAt: input.observation.observedAt,
    state,
    serviceable: true,
    score: laneScore,
    targetBurnRate,
    observedBurnRate,
    deficit,
    accounts,
    knownAccountCount: known.length,
    knownWeight: known.reduce((sum, entry) => sum + entry.aggregateWeight, 0),
    serviceableAccountCount,
    urgentResetAt: urgent?.verdict.urgentResetAt ?? urgent?.verdict.governingResetAt ?? null,
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
    const observation = normalizeLaneDocument({ document, definition: lane });
    return { verdict: evaluateLanePace({ observation, asOf, policy }), observation };
  } catch {
    return null;
  }
}
async function pollOne(source, http, now) {
  const fetchedAt = now();
  const fail = (error) => ({ laneId: source.laneId, fetchedAt, verdict: null, observation: null, error });
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
  let text2;
  try {
    text2 = await response.text();
  } catch {
    return fail("lane-request-failed");
  }
  if (new TextEncoder().encode(text2).byteLength > source.maxResponseBytes) {
    return fail("lane-response-too-large");
  }
  let document;
  try {
    document = JSON.parse(text2);
  } catch {
    return fail("lane-invalid-json");
  }
  if (document === null || typeof document !== "object") {
    return fail("lane-invalid-json");
  }
  const evaluated = verdictFor(document, source.lane, source.policy, fetchedAt);
  return {
    laneId: source.laneId,
    fetchedAt,
    verdict: evaluated?.verdict ?? null,
    observation: evaluated?.observation ?? null,
    error: null
  };
}
async function pollLanes(input) {
  return Promise.all(
    input.sources.map(
      (source) => pollOne(source, input.http, input.now).catch(
        () => ({ laneId: source.laneId, fetchedAt: input.now(), verdict: null, observation: null, error: "lane-poll-failed" })
      )
    )
  );
}

// src/lane-capacity/run-failure.ts
var LANE_EXHAUSTION_PHRASES = [
  /all credentials for model\s+\S+\s+are cooling down/i,
  /all credentials .{0,40}cooling down/i,
  /usage[_ ]limit[_ ]reached/i,
  /all upstream accounts .{0,40}(exhausted|unavailable|cooling)/i,
  /weekly (quota|limit) (exhausted|reached)/i
];
var MODEL_IN_COOLDOWN_RE = /all credentials for model\s+([^\s,)]+)\s+are cooling down/i;
function laneExhaustionFromRunFailure(input) {
  const haystack = [input.error ?? "", input.errorCode ?? ""].join(" ");
  if (!haystack.trim()) return null;
  const matched = LANE_EXHAUSTION_PHRASES.find((phrase) => phrase.test(haystack));
  if (!matched) return null;
  const embedded = MODEL_IN_COOLDOWN_RE.exec(haystack)?.[1] ?? null;
  const fromText = resolveConfiguredModelId(embedded, input.models);
  const modelId = fromText ?? resolveConfiguredModelId(input.fallbackModelId ?? null, input.models);
  if (!modelId) return null;
  const laneId = input.models.find((model) => model.id === modelId)?.laneId ?? null;
  if (!laneId) return null;
  return {
    modelId,
    laneId,
    matchedPhrase: matched.source,
    modelFromErrorText: fromText !== null
  };
}
function mergeLaneOutage(existing, addition, nowIso) {
  const live = existing && existing.until > nowIso ? existing : null;
  const lanes = [.../* @__PURE__ */ new Set([...live?.lanes ?? [], ...addition.lanes])];
  const models = [.../* @__PURE__ */ new Set([...live?.models ?? [], ...addition.models])];
  const until = live && live.until > addition.until ? live.until : addition.until;
  const reason = live?.reason ? `${live.reason}; ${addition.reason ?? ""}`.replace(/; $/, "") : addition.reason;
  return { lanes, models, until, ...reason ? { reason } : {} };
}
var AUTO_QUARANTINE_SECONDS = 15 * 60;
function autoQuarantineFor(verdict, nowMs, ttlSeconds = AUTO_QUARANTINE_SECONDS) {
  return {
    lanes: [verdict.laneId],
    // The lane is what ran out, not the individual model — every model on the
    // lane shares the same exhausted credentials. Listing only the lane keeps
    // the record honest and lets a lane with several models clear in one go.
    models: [],
    until: new Date(nowMs + ttlSeconds * 1e3).toISOString(),
    reason: `auto: run rejected on ${verdict.laneId} (${verdict.modelId}) with a lane-capacity error`
  };
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
function namedWindowUtilization(verdict, windowName) {
  const utilizations = (verdict?.accounts ?? []).flatMap((account) => {
    const window = account.windows?.find((entry) => entry.name === windowName);
    return typeof window?.utilization === "number" ? [window.utilization] : [];
  });
  return utilizations.length > 0 ? Math.max(...utilizations) : null;
}
function desiredAccountPriority(account) {
  return account.state === "push" ? 100 : 0;
}
function accountSnapshots(verdict) {
  const accounts = verdict?.accounts ?? [];
  const reportedShare = accounts.some((account) => account.recommendedShare != null);
  const fallbackDenominator = reportedShare ? 0 : accounts.reduce(
    (sum, account) => account.serviceable && account.clearRate != null ? sum + Math.max(0, account.clearRate) : sum,
    0
  );
  return accounts.map((account) => {
    const priority = desiredAccountPriority(account);
    const share = !account.serviceable ? 0 : account.recommendedShare ?? (account.clearRate != null && fallbackDenominator > 0 ? Math.max(0, account.clearRate) / fallbackDenominator : 0);
    const desiredWeight = share <= 0 ? 0 : Math.max(1, Math.min(1e6, Math.round(share * 1e6)));
    return {
      accountKey: account.accountKey,
      authKey: account.authKey ?? null,
      plan: account.plan ?? null,
      health: account.health,
      serviceable: account.serviceable,
      weight: account.weight,
      weightSource: account.weightSource,
      governingWindow: account.governingWindow,
      governingResetAt: account.governingResetAt,
      bindingWindow: account.bindingWindow ?? account.governingWindow,
      bindingResetAt: account.bindingResetAt ?? account.governingResetAt,
      normalizedRemaining: account.normalizedRemaining ?? null,
      utilization: account.score?.utilization ?? null,
      elapsedTarget: account.score?.elapsed ?? null,
      targetBurnRate: account.targetBurnRate ?? account.clearRate ?? null,
      observedBurnRate: account.observedBurnRate ?? account.recentBurnUnitsPerHour ?? null,
      deficit: account.deficit ?? account.paceDebt ?? null,
      recommendedShare: share,
      paceDebt: account.paceDebt ?? null,
      clearRate: account.clearRate ?? null,
      state: account.state,
      desiredPriority: account.serviceable ? priority : 0,
      desiredWeight,
      // The collector contract does not yet carry the auth that served this
      // issue. Keep the field explicit and null rather than guessing from the
      // routing weights.
      servedAuth: null
    };
  });
}
function buildLaneSnapshot(models, ledger, slotFloorFraction, windowNames, nowIso) {
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
      lanes[laneId] = { weekly: null, fiveHour: null, state: "unavailable", paceDeviation: 0, targetBurnRate: null, observedBurnRate: null, deficit: null, accounts: [] };
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
      // Each column reports ITS OWN named window, read off the per-account
      // window verdicts. These were both `verdict.score.utilization` — one
      // governing-window number written into both columns, which measured
      // identical in 25,000/25,000 lane observations and put a governing-window
      // reading on the quota page under a `fiveHour` label. A mislabelled
      // number is worse than a missing one: it reads as a measurement. `null`
      // when this lane reports no such window (see `namedWindowUtilization`).
      weekly: namedWindowUtilization(verdict, windowNames.weekly),
      fiveHour: namedWindowUtilization(verdict, windowNames.fiveHour),
      state: laneStateLabel(verdict),
      paceDeviation: verdict?.score?.deviation ?? 0,
      targetBurnRate: verdict?.targetBurnRate ?? null,
      observedBurnRate: verdict?.observedBurnRate ?? null,
      deficit: verdict?.deficit ?? null,
      accounts: accountSnapshots(verdict),
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
function buildDecisionRecord(input, writer) {
  const { decision, descriptor } = input;
  const tier2 = decision.effectiveTier ?? decision.judgement.tier;
  const stickyKept = decision.outcome === "selected" && descriptor.pinnedModelId != null && decision.modelId === descriptor.pinnedModelId && decision.trace.some((line) => line.startsWith("sticky:"));
  return {
    schema: SHADOW_SCHEMA_VERSION,
    writer,
    issueId: input.issueId,
    issueIdentifier: input.issueIdentifier,
    ts: input.nowIso,
    // Best-effort, not an independently-verified trigger classification — the
    // harness re-derives its own classes from stateFingerprint/laneSnapshot
    // rather than trusting a writer's self-tagged field.
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
    laneSnapshot: buildLaneSnapshot(input.models, input.laneLedger, input.slotFloorFraction, input.windowNames, input.nowIso),
    candidates: buildCandidates(decision, input.models),
    // TOG-3211: one entry per rejected candidate, naming the gate that
    // rejected it and that gate's operand — `pickWhy`/`trace` only summarise
    // the outcome ("no model cleared the gates (112 rejected)"), which was
    // not reconstructable after the fact once the roster grew past what a
    // human could enumerate by hand. Capped, with the excess counted rather
    // than silently dropped, so a truncated list never reads as complete.
    explanations: decision.rejections.slice(0, SHADOW_EXPLANATIONS_CAP).map((rejection) => ({
      modelId: rejection.modelId,
      gate: rejection.stage,
      operand: rejection.operand
    })),
    explanationsTruncated: Math.max(0, decision.rejections.length - SHADOW_EXPLANATIONS_CAP),
    operatorOverride: input.operatorOverride ? { id: input.operatorOverride.modelId, expiresAt: input.operatorOverride.expiresAt } : null,
    pickWhy: decision.trace.join("; ")
  };
}
function buildShadowRecord(input) {
  return buildDecisionRecord(input, "plugin-shadow");
}
function buildHostRecord(input) {
  return buildDecisionRecord(input, "host");
}

// src/sql.ts
var REFRESH_SCORE_RUNS_SQL = `select usage_json->>'model' as model,
       status as status,
       coalesce(context_snapshot->>'issueId','') as issue_id,
       coalesce(error_code,'') as error_code,
       left(coalesce(error,''),200) as error,
       coalesce(usage_json->>'costUsd','') as cost_usd,
       extract(epoch from (finished_at - started_at))/60.0 as mins,
       extract(epoch from (now() - created_at))/86400.0 as age_days
  from heartbeat_runs
 where company_id = $1
   and created_at > now() - ($2 || ' days')::interval
   and usage_json ? 'model'
   and status in ('succeeded','failed','timed_out')
   and usage_json->>'model' not in ('unknown','auto/best-coding')
   and finished_at is not null`;
var LAST_RUN_CONTEXT_USAGE_SQL = `select input_tokens, cached_input_tokens
  from ((select (usage_json->>'inputTokens')::numeric as input_tokens,
                (usage_json->>'cachedInputTokens')::numeric as cached_input_tokens,
                created_at as created_at
           from heartbeat_runs
          where company_id = $1
            and context_snapshot->>'issueId' = $2
            and (usage_json ? 'inputTokens' or usage_json ? 'cachedInputTokens')
          order by created_at desc
          limit 1)
        union all
        (select (usage_json->>'inputTokens')::numeric as input_tokens,
                (usage_json->>'cachedInputTokens')::numeric as cached_input_tokens,
                created_at as created_at
           from heartbeat_runs
          where company_id = $1
            and context_snapshot->>'taskId' = $2
            and context_snapshot->>'issueId' is null
            and (usage_json ? 'inputTokens' or usage_json ? 'cachedInputTokens')
          order by created_at desc
          limit 1)) matches
 order by created_at desc
 limit 1`;
var REFRESH_SCORE_CLOSING_RUNS_SQL = `select coalesce(context_snapshot->>'issueId','') as issue_id,
       usage_json->>'model' as model,
       coalesce(agent_id::text,'') as agent_id,
       coalesce(usage_json->>'costUsd','') as cost_usd,
       extract(epoch from finished_at) * 1000 as finished_at_ms
  from heartbeat_runs
 where company_id = $1
   and status = 'succeeded'
   and finished_at > now() - ($2 || ' days')::interval
   and usage_json ? 'model'`;

// src/engine/classify-call.ts
function upstreamUrl(baseUrl, protocol) {
  const parsed = new URL(baseUrl);
  const suffix = protocol === "openai-chat-completions" ? "/v1/chat/completions" : "/v1/messages";
  let path = parsed.pathname.replace(/\/+$/, "");
  if (path.endsWith(suffix)) path = path.slice(0, -suffix.length);
  parsed.pathname = `${path}${suffix}`.replace(/\/{2,}/g, "/");
  return parsed.toString();
}
function buildBody(input) {
  if (input.protocol === "openai-chat-completions") {
    return JSON.stringify({
      model: input.modelId,
      max_tokens: input.maxOutputTokens,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.userPrompt }
      ]
    });
  }
  return JSON.stringify({
    model: input.modelId,
    max_tokens: input.maxOutputTokens,
    system: input.system,
    messages: [{ role: "user", content: input.userPrompt }]
  });
}
function buildHeaders(input) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "Accept-Encoding": "identity"
  };
  if (!input.apiKey) return headers;
  if (input.protocol === "openai-chat-completions") {
    headers.Authorization = `Bearer ${input.apiKey}`;
  } else {
    headers["x-api-key"] = input.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  }
  return headers;
}
function extractText(protocol, parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  const body = parsed;
  if (protocol === "openai-chat-completions") {
    const choices = Array.isArray(body.choices) ? body.choices : [];
    const first = choices[0];
    const message = first && typeof first.message === "object" ? first.message : null;
    return typeof message?.content === "string" ? message.content : null;
  }
  const content = Array.isArray(body.content) ? body.content : [];
  const text2 = content.filter((block) => !!block && typeof block === "object").map((block) => typeof block.text === "string" ? block.text : "").join("");
  return text2.length > 0 ? text2 : null;
}
async function callClassifier(input, http) {
  const fail = (error) => ({ text: null, error });
  let target;
  let parsedUrl;
  try {
    target = upstreamUrl(input.baseUrl, input.protocol);
    parsedUrl = new URL(target);
  } catch {
    return fail("classification-url-rejected");
  }
  if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash || isReservedLiteralHost(parsedUrl.hostname)) {
    return fail("classification-url-rejected");
  }
  let response;
  try {
    let timer;
    response = await Promise.race([
      http.fetch(target, {
        method: "POST",
        headers: buildHeaders(input),
        body: buildBody(input),
        redirect: "manual"
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("classification-request-timeout")), input.requestTimeoutMs);
      })
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  } catch {
    return fail("classification-request-failed");
  }
  if (response.redirected || response.status >= 300 && response.status < 400) {
    return fail("classification-redirect-refused");
  }
  if (response.status === 401 || response.status === 403) {
    return fail("classification-authentication-failed");
  }
  if (response.status < 200 || response.status >= 300) {
    return fail("classification-http-failed");
  }
  const mediaType = response.headers.get("content-type")?.toLowerCase().split(";", 1)[0]?.trim();
  if (!mediaType?.endsWith("/json") && !mediaType?.endsWith("+json")) {
    return fail("classification-unexpected-media-type");
  }
  let text2;
  try {
    text2 = await response.text();
  } catch {
    return fail("classification-request-failed");
  }
  if (new TextEncoder().encode(text2).byteLength > input.maxResponseBytes) {
    return fail("classification-response-too-large");
  }
  let document;
  try {
    document = JSON.parse(text2);
  } catch {
    return fail("classification-invalid-json");
  }
  const extracted = extractText(input.protocol, document);
  if (extracted === null) return fail("classification-empty-response");
  return { text: extracted, error: null };
}

// src/engine/classify.ts
var RUBRIC = `You classify a software-company work item into a model tier. Answer ONLY a JSON object:
{"tier":"T1"|"T2"|"T3","confidence":0.0-1.0,"exclusion":true|false,"reason":"<=20 words"}
T1 = judgement-heavy, consequential, trust-sensitive, or irreversible: architecture/design decisions; security or adversarial review; incident response; upstream/public actions; owner-facing decisions; factual analysis that feeds consequential decisions; credentials, permissions, access, production deploys, approvals, policy.
T2 = ordinary engineering and fact-producing knowledge work: implementation with tests, normal code review, CI, runbooks, debugging, data pipelines, bounded multi-app automation with deterministic checks, research or reports that must discover or reconcile facts.
T3 = mechanically checkable, low-stakes transformation of supplied evidence: formatting, renames, boilerplate, verbatim extraction, status restatement, label/triage hygiene, registering an existing test, deterministic reruns. A report or summary is T3 only when it creates no new factual premise.
Anchors. These resolve the boundaries that get misread most often. They do not move the definitions above; they say which side of them specific recurring work sits on:
- Reviewing a named PR, commit or SHA against criteria that are already written down is T2, even when the code under review is security-sensitive. Reviewing is not deciding. Choosing whether to ADOPT a security posture, or giving an approval that is itself the irreversible act, stays T1.
- Work that PRESENTS options for someone else to choose is T2. Only work that MAKES or COMMITS TO the decision is T1. "Owner-facing decisions" above means the deciding, not the informing.
- A coordinating or parent card whose own body says the work happens elsewhere ("do not build here", "track only", "the children do the work") is T3: its output is restated status, not engineering.
- Building or fixing a tool, plugin, CI harness or test rig against a stated failure is T2. Its acceptance test is a deterministic check, which is what makes it ordinary engineering rather than judgement.
- Entering, transcribing or reconciling roster, score or measurement data from a supplied source is T2, and re-running a measurement whose method is already fixed is T2.
exclusion=true when the task touches secrets, credentials, permissions, access reviews, provisioning, or owner approvals (these must stay on the assignee's default model regardless of tier).
Be conservative where conservatism buys safety, and only there. If you are unsure between T1 and T2, choose T1 only when a concrete T1 trigger is actually present in the item: an irreversible or externally-visible action, credentials/permissions/access, a production deploy, an approval, a security-posture decision, or an incident in progress. Otherwise choose T2. If you are unsure between T2 and T3, choose T2. Do not choose T1 because the subject matter sounds important, because the card is high priority, or because it names a sensitive system that it does not itself change.`;
function buildClassificationPrompt(title, description, agentRole, descriptionChars) {
  const truncated = (description ?? "").slice(0, descriptionChars);
  return `Assignee role: ${agentRole}
Title: ${title}
Description:
${truncated}`;
}
var TIER_VALUES = ["T1", "T2", "T3"];
function parseClassificationResponse(text2) {
  const match = /\{[\s\S]*\}/.exec(text2);
  if (!match) return null;
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed;
  if (typeof obj.tier !== "string" || !TIER_VALUES.includes(obj.tier)) return null;
  const confidence = typeof obj.confidence === "number" && Number.isFinite(obj.confidence) ? obj.confidence : 0;
  return {
    tier: obj.tier,
    confidence,
    exclusion: obj.exclusion === true,
    reason: typeof obj.reason === "string" ? obj.reason : ""
  };
}
function applyConfidenceDemotion(tier2, confidence, t3ConfidenceFloor, t2ConfidenceFloor) {
  let next = tier2;
  if (next === "T3" && confidence < t3ConfidenceFloor) next = "T2";
  if (next === "T2" && confidence < t2ConfidenceFloor) next = "T1";
  return next;
}
function resolveClassifiedTiers(judgement, config) {
  const labelTier = applyConfidenceDemotion(
    judgement.tier,
    judgement.confidence,
    config.t3ConfidenceFloor,
    config.t2ConfidenceFloor
  );
  return { labelTier, pickTier: judgement.exclusion ? "T1" : labelTier };
}

// src/engine/dispatch-selection.ts
var WAKEUP_REFUSED_STATUSES = ["backlog", "done", "cancelled"];
var TERMINAL_STATUSES2 = ["done", "cancelled"];
var SELECTION_COUNTERS = [
  "refused_backlog",
  "refused_unassigned",
  "refused_blocked",
  "refused_monitor_armed",
  "parked_on_human_ask",
  "refused_in_review",
  "parked_on_named_owner",
  "woken"
];
var LEGACY_COUNTERS = ["candidates_ready", "runnable_queue", "deadlocked_agents"];
var ACTIVE_RUN_STATUSES = ["queued", "running"];
var toMillis = (value) => {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
};
function computeIdleMs(issue, runs, nowMs) {
  const scoped = (runs ?? []).filter((run) => run.issueId === issue.id);
  if (scoped.some((run) => ACTIVE_RUN_STATUSES.includes(run.status))) {
    return { idleMs: 0, anchor: "active_run", hasRun: true };
  }
  let latest = null;
  for (const run of scoped) {
    for (const stamp of [run.finishedAt, run.startedAt, run.createdAt]) {
      const ms = toMillis(stamp);
      if (ms !== null && (latest === null || ms > latest)) latest = ms;
    }
  }
  if (latest !== null) {
    return { idleMs: Math.max(0, nowMs - latest), anchor: "last_run", hasRun: true };
  }
  const created = toMillis(issue.createdAt);
  if (created === null) return { idleMs: 0, anchor: "unknown", hasRun: false };
  return { idleMs: Math.max(0, nowMs - created), anchor: "issue_created_never_run", hasRun: false };
}
function isParkedOnNamedOwner(issue) {
  const descriptor = issue.unblockDescriptor;
  return descriptor !== null && descriptor !== void 0;
}
function isMonitorArmed(issue, nowMs) {
  const at = toMillis(issue.monitorNextCheckAt ?? null);
  return at !== null && at > nowMs;
}
var PENDING_INTERACTION_STATUS = "pending";
function isParkedOnHumanAsk(interactions, assigneeAgentId) {
  return (interactions ?? []).some((interaction) => {
    if (interaction.status !== PENDING_INTERACTION_STATUS) return false;
    if (interaction.effectiveResolverPolicy === "human_only") return true;
    return interaction.addresseeAgentId != null && interaction.addresseeAgentId !== assigneeAgentId;
  });
}
function isReviewerNamedAssignee(interactions, assigneeAgentId) {
  return (interactions ?? []).some(
    (interaction) => interaction.status === PENDING_INTERACTION_STATUS && interaction.addresseeAgentId === assigneeAgentId
  );
}
function classifyIssue(input) {
  const { issue, blockedBy = [], invocationBlock = null, pendingInteractions, idleMinutes, idle, nowMs } = input;
  if (TERMINAL_STATUSES2.includes(issue.status)) {
    return { outcome: "excluded_terminal" };
  }
  if (!issue.assigneeAgentId) {
    return { outcome: "refused_unassigned" };
  }
  if (WAKEUP_REFUSED_STATUSES.includes(issue.status)) {
    return { outcome: "refused_backlog" };
  }
  if (blockedBy.some((blocker) => blocker.status !== "done")) {
    return { outcome: "refused_blocked" };
  }
  if (isMonitorArmed(issue, nowMs)) {
    return { outcome: "refused_monitor_armed", wakeable: true };
  }
  if (isParkedOnHumanAsk(pendingInteractions, issue.assigneeAgentId)) {
    return { outcome: "parked_on_human_ask", wakeable: true };
  }
  if (issue.status === "in_review" && !isReviewerNamedAssignee(pendingInteractions, issue.assigneeAgentId)) {
    return { outcome: "refused_in_review", wakeable: true };
  }
  if (invocationBlock) {
    return { outcome: "refused_budget_block", wakeable: true, blockReason: invocationBlock.reason };
  }
  if (isParkedOnNamedOwner(issue)) {
    return { outcome: "parked_on_named_owner", wakeable: true };
  }
  if (idle.idleMs < idleMinutes * 6e4) {
    return { outcome: "wakeable_not_idle", wakeable: true };
  }
  return { outcome: "actionable", wakeable: true };
}
var PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3 };
function spreadAcrossAssignees(actionable, maxPicks) {
  const ordered = [...actionable].sort((a, b) => {
    if (b.idleMs !== a.idleMs) return b.idleMs - a.idleMs;
    const pa = PRIORITY_RANK[a.issue.priority] ?? 9;
    const pb = PRIORITY_RANK[b.issue.priority] ?? 9;
    if (pa !== pb) return pa - pb;
    return String(a.issue.id).localeCompare(String(b.issue.id));
  });
  const picks = [];
  const coalesced = [];
  const claimed = /* @__PURE__ */ new Set();
  for (const candidate of ordered) {
    const agentId = candidate.issue.assigneeAgentId;
    if (claimed.has(agentId)) {
      coalesced.push(candidate);
      continue;
    }
    if (picks.length >= maxPicks) break;
    claimed.add(agentId);
    picks.push(candidate);
  }
  const overflow = ordered.filter(
    (candidate) => !picks.includes(candidate) && !coalesced.includes(candidate)
  );
  return { picks, coalescedWithEarlierPick: coalesced, overflow };
}
function selectDispatch(population, options) {
  const { idleMinutes, maxWakesPerFiring, focusProjectIds = [], now } = options;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const counters = {
    refused_backlog: 0,
    refused_unassigned: 0,
    refused_blocked: 0,
    refused_monitor_armed: 0,
    parked_on_human_ask: 0,
    refused_in_review: 0,
    parked_on_named_owner: 0,
    // Filled in by the worker after the wake attempts. The policy cannot know
    // it: whether a wake succeeds is the server's call, not ours.
    woken: 0
  };
  const focus = new Set(focusProjectIds);
  const actionable = [];
  const parked = [];
  const budgetBlocked = [];
  let wakeable = 0;
  let excludedTerminal = 0;
  let outOfFocus = 0;
  for (const entry of population) {
    const { issue, blockedBy = [], runs = [], invocationBlock = null, pendingInteractions } = entry;
    const idle = computeIdleMs(issue, runs, nowMs);
    const result = classifyIssue({ issue, blockedBy, invocationBlock, pendingInteractions, idleMinutes, idle, nowMs });
    if (result.outcome === "excluded_terminal") {
      excludedTerminal += 1;
      continue;
    }
    if (result.wakeable) wakeable += 1;
    if (result.outcome in counters) counters[result.outcome] += 1;
    if (result.outcome === "refused_budget_block") {
      budgetBlocked.push({ issue, idleMs: idle.idleMs, reason: result.blockReason ?? null });
      continue;
    }
    if (result.outcome === "parked_on_named_owner") {
      parked.push({ issue, idleMs: idle.idleMs, idleAnchor: idle.anchor });
      continue;
    }
    if (result.outcome !== "actionable") continue;
    if (focus.size > 0 && !focus.has(issue.projectId ?? "")) {
      outOfFocus += 1;
      continue;
    }
    actionable.push({ issue, idleMs: idle.idleMs, idleAnchor: idle.anchor });
  }
  const { picks, coalescedWithEarlierPick, overflow } = spreadAcrossAssignees(actionable, maxWakesPerFiring);
  return {
    counters,
    legacy: {
      // The set we would select from: rails passed, not parked, idle over
      // threshold, in focus.
      candidates_ready: actionable.length,
      // The wakeable surface: rails 1-3 passed, before our two own rails. This
      // is the 26 in docs/dispatch-plugin-facts.md §3.
      runnable_queue: wakeable,
      // No native equivalent (Q5). null, never 0 — see LEGACY_COUNTERS.
      deadlocked_agents: null
    },
    picks,
    parked,
    // Not one of the five counters — a sixth outcome the design did not know
    // was measurable. Reported alongside them, never folded into one of them.
    budgetBlocked,
    actionable,
    coalescedWithEarlierPick,
    overflow,
    excludedTerminal,
    outOfFocus
  };
}
function identifyRoutingOwners(agents) {
  const owners = [];
  for (const agent of agents ?? []) {
    if (agent.status === "terminated") continue;
    if (agent.role === "ceo") {
      owners.push({ agentId: agent.id, name: agent.name, source: "ceo_role" });
      continue;
    }
    if (agent.permissions?.canCreateAgents === true) {
      owners.push({ agentId: agent.id, name: agent.name, source: "agent_creator" });
    }
  }
  return {
    owners,
    complete: false,
    unreadableSources: ["explicit_grant", "simple_default"]
  };
}
function summariseRoutingGap(population) {
  const unassigned = population.map((entry) => entry.issue).filter((issue) => !TERMINAL_STATUSES2.includes(issue.status) && !issue.assigneeAgentId);
  const byProject = {};
  for (const issue of unassigned) {
    const key = issue.projectId ?? "(no project)";
    byProject[key] = (byProject[key] ?? 0) + 1;
  }
  return { count: unassigned.length, byProject, issueIds: unassigned.map((issue) => issue.id) };
}

// src/dispatch-reporting.ts
var METRIC_PREFIX = "dispatch";
function summariseFiring(companyId, selection, wakeOutcomes) {
  const woken = wakeOutcomes.filter((outcome) => outcome.queued).length;
  const wakeFailures = wakeOutcomes.filter((outcome) => !outcome.queued).length;
  return {
    companyId,
    counters: { ...selection.counters, woken },
    legacy: { ...selection.legacy },
    pickedIssueIds: selection.picks.map((p) => p.issue.id).sort(),
    parkedIssueIds: selection.parked.map((p) => p.issue.id).sort(),
    budgetBlockedIssueIds: selection.budgetBlocked.map((b) => b.issue.id).sort(),
    routingGapCount: selection.routingGap?.count ?? 0,
    routingOwnerIds: (selection.routingGap?.owners?.owners ?? []).map((o) => o.agentId).sort(),
    routingOwnersComplete: selection.routingGap?.owners?.complete ?? false,
    wakeFailures
  };
}
function canonicalise(summary2) {
  const sortedCounters = Object.fromEntries(Object.entries(summary2.counters).sort(([a], [b]) => a.localeCompare(b)));
  const sortedLegacy = Object.fromEntries(Object.entries(summary2.legacy).sort(([a], [b]) => a.localeCompare(b)));
  return {
    companyId: summary2.companyId,
    counters: sortedCounters,
    legacy: sortedLegacy,
    pickedIssueIds: [...summary2.pickedIssueIds].sort(),
    parkedIssueIds: [...summary2.parkedIssueIds].sort(),
    budgetBlockedIssueIds: [...summary2.budgetBlockedIssueIds].sort(),
    routingGapCount: summary2.routingGapCount,
    routingOwnerIds: [...summary2.routingOwnerIds].sort(),
    routingOwnersComplete: summary2.routingOwnersComplete,
    wakeFailures: summary2.wakeFailures
  };
}
function hasStateChanged(previous, current) {
  if (!previous) return true;
  return JSON.stringify(canonicalise(previous)) !== JSON.stringify(canonicalise(current));
}
async function emitMetrics(ctx, input) {
  const { companyId, summary: summary2, wakeEnabled } = input;
  const tags = { companyId, wakeEnabled: String(wakeEnabled) };
  for (const counter of SELECTION_COUNTERS) {
    await ctx.metrics.write(`${METRIC_PREFIX}.${counter}`, summary2.counters[counter] ?? 0, tags);
  }
  for (const counter of LEGACY_COUNTERS) {
    const value = summary2.legacy[counter];
    if (typeof value === "number") {
      await ctx.metrics.write(`${METRIC_PREFIX}.${counter}`, value, tags);
    }
  }
  await ctx.metrics.write(`${METRIC_PREFIX}.routing_gap`, summary2.routingGapCount, tags);
  await ctx.metrics.write(`${METRIC_PREFIX}.wake_failures`, summary2.wakeFailures, tags);
}
async function logStateChange(ctx, input) {
  const { companyId, summary: summary2, wakeEnabled, notes = [] } = input;
  const mode = wakeEnabled ? "live" : "report-only";
  const action = wakeEnabled ? "woken" : "would have woken";
  const routing = summary2.routingGapCount > 0 ? ` Unassigned (routing gap): ${summary2.routingGapCount}${summary2.routingOwnersComplete ? "" : " (routing owners: partial list)"}.` : " Unassigned (routing gap): 0.";
  const message = `Dispatch sweep (${mode}): ${action} of ${summary2.legacy.candidates_ready} candidates from a wakeable surface of ${summary2.legacy.runnable_queue}. Parked on a named owner: ${summary2.counters.parked_on_named_owner ?? 0}.` + routing;
  await ctx.activity.log({
    companyId,
    message,
    entityType: "plugin",
    entityId: "dispatch",
    metadata: { ...summary2, wakeEnabled, notes }
  });
}

// src/worker.ts
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function summary(decision) {
  if (decision.outcome === "selected") {
    const wakeNote = decision.wakeScopedTier ? ` \u2014 wake-scoped floor ${decision.wakeScopedTier} (card tier ${decision.judgement.tier} unchanged)` : "";
    return `${decision.modelId} at ${decision.effectiveTier} (tier via ${decision.judgement.source})${decision.advisory ? " \u2014 advisory, nothing written" : ""}${wakeNote}`;
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
  const knownCompanyIds = /* @__PURE__ */ new Set();
  const listKnownCompanies = () => [...knownCompanyIds].map((id) => ({ id }));
  const knownCompaniesKey = () => ({
    scopeKind: "instance",
    stateKey: PLUGIN_STATE_KEYS.knownCompanies
  });
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
      const laneOutageKey = (companyId) => ({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.laneOutage
      });
      const readLaneOutage = async (companyId) => {
        const stored = await ctx.state.get(laneOutageKey(companyId));
        if (!stored || typeof stored !== "object") return null;
        const record2 = stored;
        if (!Array.isArray(record2.lanes) || !Array.isArray(record2.models) || typeof record2.until !== "string") {
          return null;
        }
        return {
          lanes: record2.lanes.filter((l) => typeof l === "string"),
          models: record2.models.filter((m) => typeof m === "string"),
          until: record2.until,
          ...typeof record2.reason === "string" ? { reason: record2.reason } : {}
        };
      };
      const zaiPaceOverrideKey = (companyId) => ({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.zaiPaceOverride
      });
      const readZaiPaceOverride = async (companyId) => {
        const stored = await ctx.state.get(zaiPaceOverrideKey(companyId));
        if (!stored || typeof stored !== "object") return null;
        const record2 = stored;
        if (typeof record2.margin !== "number" || typeof record2.until !== "string") return null;
        return { margin: record2.margin, until: record2.until };
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
      const decisionEmitChains = /* @__PURE__ */ new Map();
      const emitDecisionPairSerialized = async (companyId, records) => {
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
        lines.push(...records.map((record2) => JSON.stringify(record2)));
        const config = await companyConfig(companyId);
        const pairAlignedCap = Math.max(2, config.shadowEmit.maxRecords - config.shadowEmit.maxRecords % 2);
        const capped = lines.length > pairAlignedCap ? lines.slice(-pairAlignedCap) : lines;
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
      const emitDecisionPair = (companyId, records) => {
        const previous = decisionEmitChains.get(companyId) ?? Promise.resolve();
        const next = previous.catch(() => {
        }).then(() => emitDecisionPairSerialized(companyId, records));
        decisionEmitChains.set(companyId, next);
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
      const classificationHttp = {
        fetch: (url, init) => ctx.http.fetch(url, init)
      };
      const classificationExclusionsKey = (companyId) => ({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.classificationExclusions
      });
      const readClassificationExclusions = async (companyId) => {
        const stored = asRecord(await ctx.state.get(classificationExclusionsKey(companyId)));
        const out = {};
        for (const [issueId, excluded] of Object.entries(stored)) {
          if (excluded === true) out[issueId] = true;
        }
        return out;
      };
      const classifierLabeledKey = (companyId) => ({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.classifierLabeledIssues
      });
      const readClassifierLabeled = async (companyId) => {
        const stored = asRecord(await ctx.state.get(classifierLabeledKey(companyId)));
        const out = {};
        for (const [issueId, tier2] of Object.entries(stored)) {
          if (typeof tier2 === "string" && TIERS.includes(tier2)) out[issueId] = tier2;
        }
        return out;
      };
      const readCardLedger = async (companyId) => {
        const stored = asRecord(await ctx.state.get(scoresKey(companyId)));
        const ledger = asRecord(stored.cardLedger);
        return ledger;
      };
      const readModelScores = async (companyId) => {
        const stored = asRecord(await ctx.state.get(scoresKey(companyId)));
        const scores = Array.isArray(stored.modelScores) ? stored.modelScores : [];
        const byModelId = {};
        for (const score2 of scores) byModelId[score2.modelId] = score2;
        return byModelId;
      };
      const shadowDiffsKey = (companyId) => ({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.shadowDiffs
      });
      const dispatchLastFiringKey = (companyId) => ({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.dispatchLastFiring
      });
      const activePinsWeightByLane = async (companyId, models) => {
        const rows = await ctx.db.query(
          `select assignee_adapter_overrides->'adapterConfig'->>'model' as pinned_model
             from issues
            where company_id = $1
              and status in ('todo','in_progress')
              and assignee_adapter_overrides->'adapterConfig'->>'model' is not null`,
          [companyId]
        );
        const weightByLane = {};
        for (const row of rows) {
          const r = asRecord(row);
          const rawModelId = typeof r.pinned_model === "string" ? r.pinned_model : null;
          const modelId = resolveConfiguredModelId(rawModelId, models);
          const model = models.find((m) => m.id === modelId);
          if (!model || !model.laneId) continue;
          const weight = blendedListPrice(model) < 1 ? 0.5 : 1;
          weightByLane[model.laneId] = (weightByLane[model.laneId] ?? 0) + weight;
        }
        return weightByLane;
      };
      const aaSnapshotKey = () => ({
        scopeKind: "instance",
        stateKey: PLUGIN_STATE_KEYS.aaIndexSnapshot
      });
      const aaSnapshotHistoryKey = () => ({
        scopeKind: "instance",
        stateKey: PLUGIN_STATE_KEYS.aaSnapshotHistory
      });
      const readAaSnapshot = async () => {
        const stored = asRecord(await ctx.state.get(aaSnapshotKey()));
        return {
          fetchedAt: typeof stored.fetchedAt === "string" ? stored.fetchedAt : null,
          bySlug: asRecord(stored.bySlug),
          lastAttemptAt: typeof stored.lastAttemptAt === "string" ? stored.lastAttemptAt : null,
          lastError: typeof stored.lastError === "string" ? stored.lastError : null
        };
      };
      const appendAaSnapshotHistory = async (entry) => {
        const stored = asRecord(await ctx.state.get(aaSnapshotHistoryKey()));
        const existing = Array.isArray(stored.entries) ? stored.entries : [];
        const next = [...existing, entry].slice(-AA_SNAPSHOT_HISTORY_LIMIT);
        await ctx.state.set(aaSnapshotHistoryKey(), { entries: next });
      };
      const aaDriftSurfacedKey = (companyId) => ({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.aaDriftSurfaced
      });
      const readAaDriftSurfaced = async (companyId) => {
        const stored = asRecord(await ctx.state.get(aaDriftSurfacedKey(companyId)));
        return new Set(Array.isArray(stored.keys) ? stored.keys : []);
      };
      const aaHttp = {
        fetch: (url, init) => ctx.http.fetch(url, init)
      };
      const readLastRunContextUsage = async (companyId, issueId) => {
        const contextRows = await ctx.db.query(LAST_RUN_CONTEXT_USAGE_SQL, [companyId, issueId]);
        const contextRow = asRecord(contextRows[0]);
        const rawInput = Number(contextRow.input_tokens);
        const rawCached = Number(contextRow.cached_input_tokens);
        return {
          lastRunInputTokens: Number.isFinite(rawInput) && rawInput >= 0 ? Math.floor(rawInput) : null,
          lastRunCachedInputTokens: Number.isFinite(rawCached) && rawCached >= 0 ? Math.floor(rawCached) : null
        };
      };
      const loadContextUsage = (companyId, issueId, cache) => {
        if (!cache) return readLastRunContextUsage(companyId, issueId);
        const key = `${companyId}:${issueId}`;
        const memo = cache.get(key);
        if (memo) return memo;
        const pending = readLastRunContextUsage(companyId, issueId);
        cache.set(key, pending);
        return pending;
      };
      const describeIssue = async (companyId, issueId, supplied, contextUsageCache) => {
        const issue = await ctx.issues.get(issueId, companyId);
        if (!issue) return null;
        const overrides = asRecord(issue.assigneeAdapterOverrides);
        const adapterConfig = asRecord(overrides.adapterConfig);
        const existingOverrideEnv = asRecord(adapterConfig.env);
        const pinnedModelId = typeof adapterConfig.model === "string" ? adapterConfig.model : null;
        const labels = issue.labels ?? [];
        const labelNames = labels.map((label) => label.name).filter((name) => typeof name === "string");
        const scheduledRetryStatus = issue.scheduledRetry?.status ?? null;
        const isIdle = !issue.checkoutRunId && !issue.executionRunId && scheduledRetryStatus !== "queued" && scheduledRetryStatus !== "running";
        let agentFloorModelId = null;
        let agentName = null;
        let agentEnv = null;
        const assigneeAgentId = issue.assigneeAgentId;
        if (typeof assigneeAgentId === "string") {
          try {
            const agent = await ctx.agents.get(assigneeAgentId, companyId);
            const agentRecord = asRecord(agent);
            const config = asRecord(agentRecord.adapterConfig);
            if (typeof config.model === "string") agentFloorModelId = config.model;
            agentEnv = asRecord(config.env);
            if (typeof agentRecord.name === "string") agentName = agentRecord.name;
          } catch {
          }
        }
        const exclusionRaw = asRecord(supplied.exclusion);
        const descriptor = {
          issueId,
          labelNames,
          pinnedModelId,
          agentFloorModelId,
          agentName,
          // Sticky is derived from the pin: if the issue is already pinned, the
          // run is already on that model and a change would reset the session.
          stickyModelId: pinnedModelId,
          requiredCapabilities: Array.isArray(supplied.requiredCapabilities) ? supplied.requiredCapabilities : void 0,
          // Only the CALLER-supplied value is eager. The measured fallback
          // needs the `heartbeat_runs` read, so callers that want it await
          // `contextUsage()` and set this themselves (`advise`, `repinPass`) —
          // the passes that only decide repinnability never pay for it.
          requiredContextTokens: typeof supplied.requiredContextTokens === "number" ? supplied.requiredContextTokens : void 0,
          // TOG-3210: the caller's PAPERCLIP_WAKE_REASON for this run, if any.
          // Feeds SelectionConfig.wakeScopedFloor only — resolveTier() never
          // reads it, so it can never change the card's own judged tier.
          wakeReason: typeof supplied.wakeReason === "string" ? supplied.wakeReason : void 0,
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
          identifier: typeof issue.identifier === "string" ? issue.identifier : null,
          assigneeAgentId: typeof assigneeAgentId === "string" ? assigneeAgentId : null,
          description: String(issue.description ?? ""),
          agentEnv,
          existingOverrideEnv,
          contextUsage: () => loadContextUsage(companyId, issueId, contextUsageCache)
        };
      };
      const advise = async (companyId, params, allowExplore = true, forceTier, suppressSticky = false, contextUsageCache) => {
        const issueId = typeof params.issueId === "string" ? params.issueId : null;
        if (!issueId) return null;
        const config = await companyConfig(companyId);
        const described = await describeIssue(companyId, issueId, params, contextUsageCache);
        if (!described) return null;
        if (forceTier) {
          described.descriptor.labelNames = [`${TIER_LABEL_PREFIX}${forceTier}`];
        }
        if (suppressSticky) {
          described.descriptor.stickyModelId = null;
        }
        const { profiles, signals } = await readProfiles(companyId);
        const laneLedger = await readLaneLedger(companyId);
        const pacingActive = config.pacing.mode !== "off";
        const profileTier = resolveTier(
          described.descriptor,
          config.models,
          config.selection.defaultTier,
          {
            isLaneUnserviceable: (model) => pacingActive && hardStopExcluded(laneLedger, model)
          }
        ).tier;
        const profile = profiles.find((entry) => entry.tier === profileTier) ?? null;
        const usage = await described.contextUsage();
        const contextEstimate = estimateIssueContext({
          explicitTokens: typeof params.requiredContextTokens === "number" ? params.requiredContextTokens : void 0,
          lastRunInputTokens: usage.lastRunInputTokens,
          lastRunCachedInputTokens: usage.lastRunCachedInputTokens,
          fleetCeilingTokens: config.selection.fleetContextCeilingTokens
        });
        described.descriptor.requiredContextTokens = contextEstimate.tokens ?? void 0;
        const nowIso = (/* @__PURE__ */ new Date()).toISOString();
        const overrides = await readOperatorOverrides(companyId);
        const liveOverride = activeOperatorOverride(overrides, issueId, nowIso);
        const cardLedger = await readCardLedger(companyId);
        const modelScores = await readModelScores(companyId);
        const laneOutageOverride = await readLaneOutage(companyId);
        const zaiPaceOverride = await readZaiPaceOverride(companyId);
        const now = Date.now();
        const pinsWeightByLane = config.pacing.mode !== "off" ? await activePinsWeightByLane(companyId, config.models) : {};
        const decision = selectModel({
          descriptor: described.descriptor,
          config: {
            enforcementEnabled: config.selection.enabled && config.selection.mode === "enforce",
            defaultTier: config.selection.defaultTier,
            // TOG-2988: the roster's hand-placed tier is overlaid with the tier
            // `refreshScores` derived from the model's posterior. Unscored models
            // and scores from a superseded spec version keep the configured tier.
            models: applyDerivedTiers(config.models, modelScores),
            holdOnUntrustedProfile: config.selection.holdOnUntrustedProfile,
            stickyWithinIssue: config.selection.stickyModelWithinIssue,
            pacingMode: config.pacing.mode,
            laneLedger,
            slotFloorFraction: config.pacing.slotFloorFraction,
            operatorOverrideModelId: liveOverride?.modelId ?? null,
            laneAvoidConfig: config.pacing.avoid,
            codexLaneId: config.pacing.codexLaneId,
            opencodeGoLaneId: config.pacing.opencodeGoLaneId,
            zaiLaneId: config.pacing.zai.laneId,
            laneOutageOverride,
            laneRoom: {
              capPerAccount: config.pacing.laneCapPerAccount,
              activePinsWeightByLane: pinsWeightByLane,
              fiveHourWindowName: config.pacing.fiveHourWindowName,
              zaiLaneId: config.pacing.zai.laneId,
              zaiWeeklyWindowName: config.pacing.zai.weeklyWindowName,
              zaiWeeklyDefaultMargin: config.pacing.zai.weeklyDefaultMargin,
              zaiPaceOverrideMargin: activeZaiPaceOverride(zaiPaceOverride, new Date(now).toISOString()),
              now
            },
            objective: config.selection.objective,
            modelScores,
            allowExplore,
            wakeScopedFloor: config.wakeScopedFloor
          },
          profiles,
          signals,
          now,
          cardLedger
        });
        const pinnedModelId = resolveConfiguredModelId(
          described.descriptor.pinnedModelId,
          config.models
        );
        const pinnedModel = config.models.find((model) => model.id === pinnedModelId);
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
          const recordInput = {
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
            windowNames: {
              weekly: config.pacing.weeklyWindowName,
              fiveHour: config.pacing.fiveHourWindowName
            },
            operatorOverride: liveOverride
          };
          await emitDecisionPair(companyId, [buildHostRecord(recordInput), buildShadowRecord(recordInput)]);
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
          identifier: described.identifier,
          agentFloorModelId: described.descriptor.agentFloorModelId ?? null,
          pinnedModelId: described.descriptor.pinnedModelId ?? null,
          agentEnv: described.agentEnv,
          existingOverrideEnv: described.existingOverrideEnv
        };
      };
      ctx.tools.register(
        TOOL_NAMES.advise,
        {
          displayName: "Advise a model for an issue",
          description: "Return the tier judgement and costed candidates for one issue. Writes nothing.",
          parametersSchema: {
            type: "object",
            properties: {
              issueId: { type: "string" },
              wakeReason: {
                type: "string",
                description: "TOG-3210. Pass the run's PAPERCLIP_WAKE_REASON here so a cheap re-check (e.g. a monitor tick) can get a lower advisory floor without ever changing the card's own tier \u2014 see wakeScopedFloor config."
              }
            }
          }
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
          parametersSchema: {
            type: "object",
            properties: {
              issueId: { type: "string" },
              wakeReason: {
                type: "string",
                description: "TOG-3210. A wake-scoped decision is always forced advisory, so passing this on `apply` never writes a lowered tier \u2014 it only ever affects the returned recommendation for this call."
              }
            }
          }
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
          if (!plan.write || !plan.modelId) {
            return { content: `No write: ${plan.reason}`, data: { decision: result.decision, plan } };
          }
          const selectedModel = result.config.models.find((model) => model.id === plan.modelId);
          if (!selectedModel) {
            return {
              content: `No write: selected model ${plan.modelId} is absent from the resolved roster`,
              data: { decision: result.decision, plan }
            };
          }
          const patch = modelOverrideForContext({
            model: selectedModel,
            fleetCeilingTokens: result.config.selection.fleetContextCeilingTokens,
            compactionRatio: result.config.selection.compactionRatio,
            agentEnv: result.agentEnv,
            existingOverrideEnv: result.existingOverrideEnv
          });
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
          const configuredModelId = resolveConfiguredModelId(modelId, config.models);
          if (!configuredModelId) {
            return {
              content: `modelId ${modelId} is not a configured roster entry.`,
              data: null
            };
          }
          const ttlSeconds = typeof supplied.ttlSeconds === "number" && supplied.ttlSeconds > 0 ? supplied.ttlSeconds : config.pacing.operatorOverrideTtlSeconds;
          const nowIso = (/* @__PURE__ */ new Date()).toISOString();
          const existing = await readOperatorOverrides(runCtx.companyId);
          const updated = recordOperatorOverride(existing, issueId, configuredModelId, nowIso, ttlSeconds);
          await ctx.state.set(operatorOverridesKey(runCtx.companyId), updated);
          const entry = updated[issueId];
          return {
            content: `operator override recorded: ${issueId} -> ${configuredModelId}, expires ${entry.expiresAt}`,
            data: entry
          };
        }
      );
      ctx.tools.register(
        TOOL_NAMES.setLaneOutage,
        {
          displayName: "Declare or clear a lane outage",
          description: "TOG-2481 port of lane_outage.json: declare a telemetry-invisible outage on named lanes/models until an ISO timestamp, or clear it by omitting both lanes and models.",
          parametersSchema: {
            type: "object",
            required: ["until"],
            properties: {
              lanes: { type: "array", items: { type: "string" } },
              models: { type: "array", items: { type: "string" } },
              until: { type: "string" },
              reason: { type: "string" }
            }
          }
        },
        async (params, runCtx) => {
          const supplied = asRecord(params);
          const lanes = Array.isArray(supplied.lanes) ? supplied.lanes.filter((l) => typeof l === "string") : [];
          const models = Array.isArray(supplied.models) ? supplied.models.filter((m) => typeof m === "string") : [];
          const until = typeof supplied.until === "string" ? supplied.until : null;
          if (!until) return { content: "until is required (ISO-8601 UTC timestamp).", data: null };
          if (lanes.length === 0 && models.length === 0) {
            await ctx.state.set(laneOutageKey(runCtx.companyId), null);
            return { content: "lane outage cleared.", data: null };
          }
          const reason = typeof supplied.reason === "string" ? supplied.reason : void 0;
          const override = { lanes, models, until, ...reason ? { reason } : {} };
          await ctx.state.set(laneOutageKey(runCtx.companyId), override);
          return { content: `lane outage recorded: ${[...lanes, ...models].join(", ")} until ${until}`, data: override };
        }
      );
      ctx.tools.register(
        TOOL_NAMES.setZaiPaceOverride,
        {
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
        async (params, runCtx) => {
          const supplied = asRecord(params);
          const until = typeof supplied.until === "string" ? supplied.until : null;
          if (!until) return { content: "until is required (ISO-8601 UTC timestamp).", data: null };
          if (typeof supplied.margin !== "number") {
            await ctx.state.set(zaiPaceOverrideKey(runCtx.companyId), null);
            return { content: "zai pace override cleared.", data: null };
          }
          const override = { margin: supplied.margin, until };
          await ctx.state.set(zaiPaceOverrideKey(runCtx.companyId), override);
          return { content: `zai pace override recorded: margin ${supplied.margin} until ${until}`, data: override };
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
        const issueId = typeof event.entityId === "string" ? event.entityId : null;
        const assignment = asRecord(changes.assigneeAgentId);
        const assignedTo = typeof assignment.to === "string" ? assignment.to : null;
        if (issueId && assignedTo && assignment.from == null) {
          try {
            await pinAtDecisionTime(event.companyId, issueId, "issue.updated:assignment");
          } catch (cause) {
            ctx.logger.error("assignment-time pin failed", {
              companyId: event.companyId,
              issueId,
              error: cause instanceof Error ? cause.message : String(cause)
            });
          }
        }
        const status = asRecord(changes.status);
        const from = typeof status.from === "string" ? status.from : null;
        const to = typeof status.to === "string" ? status.to : null;
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
      const maybeLogUnpinnableCard = async (companyId, issueId, identifier, decision) => {
        if (!decision) return;
        if (decision.outcome !== "no-eligible-model" && decision.outcome !== "tier-exhausted") return;
        const key = {
          scopeKind: "company",
          scopeId: companyId,
          stateKey: PLUGIN_STATE_KEYS.noEligibleNotices
        };
        const stored = asRecord(await ctx.state.get(key));
        const rawLast = stored[issueId];
        if (typeof rawLast === "string") {
          const lastAtMs = Date.parse(rawLast);
          if (!Number.isNaN(lastAtMs) && Date.now() - lastAtMs < NO_ELIGIBLE_NOTICE_THROTTLE_MS) return;
        }
        const laneLedger = await readLaneLedger(companyId);
        const laneStates = Object.values(laneLedger).map(
          (entry) => `${entry.laneId}=${entry.verdict ?? "?"}@${Math.round(laneEffectiveUtilization(laneLedger, entry.laneId) * 100)}%${entry.error ? "(poll-error)" : ""}`
        ).join(" ");
        const pruned = {};
        for (const [id, at] of Object.entries(stored)) {
          if (typeof at === "string" && Date.now() - Date.parse(at) < 7 * 24 * 60 * 60 * 1e3) pruned[id] = at;
        }
        await ctx.state.set(key, { ...pruned, [issueId]: (/* @__PURE__ */ new Date()).toISOString() });
        await ctx.activity.log({
          companyId,
          message: `Model Selection cannot pin this card: ${decision.outcome}. Lane states: ${laneStates || "no lane data"}. It stays on its current model until a lane recovers or an operator pins one (TOG-3111).`,
          entityType: "issue",
          entityId: issueId,
          metadata: {
            outcome: decision.outcome,
            identifier,
            lanes: Object.values(laneLedger).map((entry) => ({
              laneId: entry.laneId,
              verdict: entry.verdict,
              error: entry.error
            })),
            trace: decision.trace
          }
        });
      };
      const pinAtDecisionTime = async (companyId, issueId, source) => {
        const config = await companyConfig(companyId);
        if (!config.classification.enabled) return;
        const described = await describeIssue(companyId, issueId, {});
        if (!described) return;
        if (!described.assigneeAgentId) return;
        if (!balanceOpenStatuses.has(described.status)) return;
        if (described.hasOperatorPin) return;
        if (described.descriptor.pinnedModelId) return;
        let tier2 = described.hasTierLabel ? tierFromLabels(described.descriptor.labelNames) : null;
        if (!described.hasTierLabel) {
          if (!config.classification.baseUrl || !config.classification.modelId) return;
          let apiKey = null;
          if (config.classification.apiKeySecretRef) {
            try {
              apiKey = await ctx.secrets.resolve(config.classification.apiKeySecretRef, {
                companyId,
                configPath: "classification.apiKeySecretRef"
              });
            } catch {
              ctx.logger.error("creation-pin classification secret unavailable", { companyId, issueId });
              return;
            }
          }
          const classified = await callClassifier(
            {
              baseUrl: config.classification.baseUrl,
              protocol: config.classification.protocol,
              modelId: config.classification.modelId,
              apiKey,
              system: RUBRIC,
              userPrompt: buildClassificationPrompt(
                described.title,
                described.description,
                described.descriptor.agentName ?? "",
                config.classification.descriptionChars
              ),
              maxOutputTokens: config.classification.maxOutputTokens,
              requestTimeoutMs: config.classification.requestTimeoutMs,
              maxResponseBytes: config.classification.maxResponseBytes
            },
            classificationHttp
          );
          if (!classified.text) {
            ctx.logger.info("creation-pin classification skipped", {
              companyId,
              issueId,
              why: classified.error
            });
            return;
          }
          const judgement = parseClassificationResponse(classified.text);
          if (!judgement) {
            ctx.logger.info("creation-pin classification unparseable", { companyId, issueId });
            return;
          }
          const { labelTier } = resolveClassifiedTiers(judgement, {
            t3ConfidenceFloor: config.classification.t3ConfidenceFloor,
            t2ConfidenceFloor: config.classification.t2ConfidenceFloor
          });
          tier2 = labelTier;
          const labelId = config.tierLabelIds[labelTier];
          if (labelId) {
            await ctx.issues.update(
              issueId,
              { labelIds: [.../* @__PURE__ */ new Set([...described.existingLabelIds, labelId])] },
              companyId
            );
          }
          if (judgement.exclusion) {
            const exclusions = await readClassificationExclusions(companyId);
            await ctx.state.set(classificationExclusionsKey(companyId), { ...exclusions, [issueId]: true });
          }
          await ctx.activity.log({
            companyId,
            message: `Model Selection classified this issue as ${labelTier} (confidence ${judgement.confidence})${judgement.exclusion ? ", capability-excluded" : ""} at card creation`,
            entityType: "issue",
            entityId: issueId,
            metadata: {
              tier: labelTier,
              confidence: judgement.confidence,
              reason: judgement.reason,
              source
            }
          });
        }
        if (!tier2) return;
        const result = await advise(companyId, { issueId }, false, tier2, false);
        if (!result || result.decision.outcome !== "selected" || !result.decision.modelId) {
          await maybeLogUnpinnableCard(companyId, issueId, described.identifier, result?.decision ?? null);
          return;
        }
        if (!result.isIdle || !balanceOpenStatuses.has(result.status)) return;
        if (result.pinnedModelId !== null) return;
        const floorModelId = resolveConfiguredModelId(result.agentFloorModelId, config.models);
        if (result.decision.modelId === floorModelId) {
          ctx.logger.info("creation-time pin skipped: pick equals floor", { companyId, issueId, source });
          return;
        }
        const selectedModel = config.models.find((model) => model.id === result.decision.modelId);
        if (!selectedModel) return;
        if (!await balanceWriteStillSafe(companyId, issueId, null, config.models)) return;
        await ctx.issues.update(
          issueId,
          modelOverrideForContext({
            model: selectedModel,
            fleetCeilingTokens: config.selection.fleetContextCeilingTokens,
            compactionRatio: config.selection.compactionRatio,
            agentEnv: result.agentEnv,
            existingOverrideEnv: result.existingOverrideEnv
          }),
          companyId
        );
        await ctx.activity.log({
          companyId,
          message: `Model Selection pinned ${result.decision.modelId} (${result.decision.effectiveTier}) at card creation \u2014 TOG-3111 (${source})`,
          entityType: "issue",
          entityId: issueId,
          metadata: {
            modelId: result.decision.modelId,
            tier: result.decision.effectiveTier,
            source,
            trace: result.decision.trace
          }
        });
      };
      ctx.events.on("issue.created", async (event) => {
        const issueId = typeof event.entityId === "string" ? event.entityId : null;
        if (!issueId) return;
        try {
          await pinAtDecisionTime(event.companyId, issueId, "issue.created");
        } catch (cause) {
          ctx.logger.error("creation-time pin failed", {
            companyId: event.companyId,
            issueId,
            error: cause instanceof Error ? cause.message : String(cause)
          });
        }
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
                    adapterConfig: asRecord(agent.adapterConfig)
                  },
                  recommendedModelId,
                  config.models
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
      ctx.tools.register(
        TOOL_NAMES.aaDriftReport,
        {
          displayName: "aa.ai drift report",
          description: "Per-model aa.ai Intelligence Index: the roster's configured value and snapshot date, alongside the latest fetched live value and whether it now implies a different tier. Read-only \u2014 never writes tier/enablement.",
          parametersSchema: { type: "object" }
        },
        async (_params, runCtx) => {
          const config = await companyConfig(runCtx.companyId);
          const snapshot = await readAaSnapshot();
          const knownSlugs = new Set(Object.keys(snapshot.bySlug));
          const rows = config.models.map((model) => {
            const slug = resolveAaSlug(model.id, knownSlugs, model.aaSlug ?? null);
            const liveRecord = slug ? snapshot.bySlug[slug] ?? null : null;
            const liveIndex = liveRecord?.intelligenceIndex ?? null;
            const configuredImpliedTier = model.aaIndex === null ? null : tierImpliedByIndex(model.aaIndex);
            const liveImpliedTier = liveIndex === null ? null : tierImpliedByIndex(liveIndex);
            return {
              modelId: model.id,
              configuredIndex: model.aaIndex,
              configuredAsOf: model.aaIndexUpdatedAt ?? null,
              liveIndex,
              liveAsOf: snapshot.fetchedAt,
              delta: model.aaIndex !== null && liveIndex !== null ? liveIndex - model.aaIndex : null,
              crossesBoundary: liveIndex !== null && configuredImpliedTier !== liveImpliedTier,
              // TOG-2438 scope expansion: full-record fields, surface only —
              // never fed back into tier/enablement decisions.
              aaCostPerTask: liveRecord?.intelligenceIndexCostPerTask ?? null,
              aaPriceIn: liveRecord?.price1mInputTokens ?? null,
              aaPriceOut: liveRecord?.price1mOutputTokens ?? null,
              aaTokensPerSec: liveRecord?.medianOutputTokensPerSecond ?? null,
              aaTtftSeconds: liveRecord?.medianTimeToFirstTokenSeconds ?? null,
              aaContextWindow: liveRecord?.contextWindowTokens ?? null,
              aaTerminalbenchHard: liveRecord?.terminalbenchHard ?? null,
              aaTau2: liveRecord?.tau2 ?? null,
              aaIfbench: liveRecord?.ifbench ?? null,
              aaGpqa: liveRecord?.gpqa ?? null,
              aaHle: liveRecord?.hle ?? null,
              aaEffort: slug ? effortSuffixOf(slug) : null,
              aaSnapshotAt: liveRecord ? snapshot.fetchedAt : null
            };
          });
          return {
            content: `${rows.length} models; snapshot ${snapshot.fetchedAt ?? "never fetched"}${snapshot.lastError ? ` (last attempt error: ${snapshot.lastError})` : ""}`,
            data: { snapshot: { fetchedAt: snapshot.fetchedAt, lastAttemptAt: snapshot.lastAttemptAt, lastError: snapshot.lastError }, rows }
          };
        }
      );
      ctx.jobs.register(JOB_KEYS.refreshProfiles, async () => {
        const companies = listKnownCompanies();
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
        const companies = listKnownCompanies();
        for (const company of companies) {
          try {
            const config = await companyConfig(company.id);
            if (config.pacing.lanes.length === 0) continue;
            const secretFailures = [];
            const sources = [];
            const fetchedAt = (/* @__PURE__ */ new Date()).toISOString();
            for (const [laneIndex, lane] of config.pacing.lanes.entries()) {
              let apiKey = null;
              if (lane.apiKeySecretRef) {
                try {
                  apiKey = await ctx.secrets.resolve(lane.apiKeySecretRef, {
                    companyId: company.id,
                    // Must match the array-index path plugin-secrets-handler.ts's
                    // extractSecretRefBindingsFromConfig binds on config write
                    // (TOG-2500) — a laneId-keyed path here reads back nothing
                    // because syncSecretRefsForTarget replaceAll wipes non-matching rows.
                    configPath: `pacing.lanes.${laneIndex}.apiKeySecretRef`
                  });
                } catch {
                  secretFailures.push({ laneId: lane.laneId, fetchedAt, verdict: null, observation: null, error: "lane-secret-unavailable" });
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
      const runAaIndexRefresh = async () => {
        const nowIso = (/* @__PURE__ */ new Date()).toISOString();
        const previous = await readAaSnapshot();
        const fetched = await fetchAaSnapshot({
          url: AA_LEADERBOARD_URL,
          http: aaHttp,
          timeoutMs: AA_FETCH_TIMEOUT_MS,
          maxResponseBytes: AA_MAX_RESPONSE_BYTES
        });
        let snapshot = previous;
        if (!fetched.ok || !fetched.html) {
          snapshot = { ...previous, lastAttemptAt: nowIso, lastError: fetched.error ?? "aa-fetch-failed" };
          await ctx.state.set(aaSnapshotKey(), snapshot);
          ctx.logger.error("aa.ai snapshot fetch failed; keeping prior snapshot", {
            error: fetched.error,
            previousFetchedAt: previous.fetchedAt
          });
        } else {
          const parsed = parseAaLeaderboardHtml(fetched.html);
          if (!parsed) {
            snapshot = { ...previous, lastAttemptAt: nowIso, lastError: "aa-parse-failed" };
            await ctx.state.set(aaSnapshotKey(), snapshot);
            ctx.logger.error("aa.ai snapshot parse failed; keeping prior snapshot", {
              previousFetchedAt: previous.fetchedAt
            });
          } else {
            const bySlug = {};
            for (const row of parsed) bySlug[row.slug] = row;
            snapshot = { fetchedAt: nowIso, bySlug, lastAttemptAt: nowIso, lastError: null };
            await ctx.state.set(aaSnapshotKey(), snapshot);
            await appendAaSnapshotHistory({ fetchedAt: nowIso, bySlug });
            ctx.logger.info("aa.ai snapshot refreshed", { fetchedAt: nowIso, models: parsed.length });
          }
        }
        const freshBySlug = new Map(Object.entries(snapshot.bySlug));
        if (freshBySlug.size === 0) {
          return { fetchedAt: snapshot.fetchedAt, error: snapshot.lastError, modelsFetched: 0 };
        }
        const previousBySlug = new Map(Object.entries(previous.bySlug));
        const companies = listKnownCompanies();
        for (const company of companies) {
          try {
            const config = await companyConfig(company.id);
            if (!config.aaSync.enabled || config.models.length === 0) continue;
            const knownSlugs = new Set(freshBySlug.keys());
            const diffInputs = config.models.map((model) => ({
              modelId: model.id,
              previousIndex: model.aaIndex,
              slug: resolveAaSlug(model.id, knownSlugs, model.aaSlug ?? null)
            }));
            const rows = diffSnapshot(diffInputs, freshBySlug, previousBySlug);
            for (const row of rows) {
              if (row.fieldDeltas.length > 0) {
                ctx.logger.info("aa.ai fields changed", {
                  companyId: company.id,
                  modelId: row.modelId,
                  fieldDeltas: row.fieldDeltas
                });
              }
              if (row.delta !== null && row.delta !== 0) {
                ctx.logger.info("aa.ai index changed", {
                  companyId: company.id,
                  modelId: row.modelId,
                  previousIndex: row.previousIndex,
                  freshIndex: row.freshIndex,
                  delta: row.delta
                });
              }
            }
            const crossing = rows.filter((row) => row.crossesBoundary);
            if (crossing.length === 0) continue;
            const surfaced = await readAaDriftSurfaced(company.id);
            let surfacedChanged = false;
            for (const row of crossing) {
              const dedupeKey = `${row.modelId}::${row.freshImpliedTier ?? "none"}`;
              if (surfaced.has(dedupeKey)) continue;
              await ctx.activity.log({
                companyId: company.id,
                message: `aa.ai drift crosses a tier boundary for ${row.modelId} \u2014 re-evaluate, do not auto-apply`,
                entityType: "model",
                entityId: row.modelId,
                metadata: {
                  modelId: row.modelId,
                  previousIndex: row.previousIndex,
                  freshIndex: row.freshIndex,
                  previousImpliedTier: row.previousImpliedTier,
                  freshImpliedTier: row.freshImpliedTier
                }
              });
              surfaced.add(dedupeKey);
              surfacedChanged = true;
            }
            if (surfacedChanged) {
              await ctx.state.set(aaDriftSurfacedKey(company.id), { keys: [...surfaced] });
            }
          } catch (cause) {
            ctx.logger.error("aa.ai drift surfacing failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause)
            });
          }
        }
        return { fetchedAt: snapshot.fetchedAt, error: snapshot.lastError, modelsFetched: freshBySlug.size };
      };
      ctx.jobs.register(JOB_KEYS.refreshAaIndex, async () => {
        await runAaIndexRefresh();
      });
      ctx.tools.register(
        TOOL_NAMES.refreshAaIndexNow,
        {
          displayName: "Refresh aa.ai Intelligence Index now",
          description: "Manually run the aa.ai leaderboard fetch + drift-surfacing sweep instead of waiting for the next scheduled tick. Same logic as the cron job: never writes tier/enabled, only updates the snapshot and logs drift.",
          parametersSchema: { type: "object" }
        },
        async () => {
          const result = await runAaIndexRefresh();
          if (result.error) {
            return { content: `aa.ai refresh attempted but failed: ${result.error}`, data: result };
          }
          return {
            content: `aa.ai snapshot refreshed: ${result.modelsFetched} models, fetched at ${result.fetchedAt}`,
            data: result
          };
        }
      );
      ctx.jobs.register(JOB_KEYS.refreshScores, async () => {
        const companies = listKnownCompanies();
        for (const company of companies) {
          try {
            const config = await companyConfig(company.id);
            if (config.models.length === 0) continue;
            const scoreRunRows = await ctx.db.query(
              REFRESH_SCORE_RUNS_SQL,
              [company.id, String(SCORE_WINDOW_DAYS)]
            );
            const closingRunRows = await ctx.db.query(
              REFRESH_SCORE_CLOSING_RUNS_SQL,
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
            const runOutcomeRows = scoreRunRows.flatMap((row) => {
              const r = asRecord(row);
              const modelId = resolveConfiguredModelId(
                typeof r.model === "string" ? r.model : null,
                config.models
              );
              if (!modelId) return [];
              const issueId = typeof r.issue_id === "string" ? r.issue_id : "";
              return [{
                modelId,
                tier: issueId ? tierByIssue.get(issueId) ?? null : null,
                status: r.status,
                errorCode: typeof r.error_code === "string" && r.error_code ? r.error_code : null,
                error: typeof r.error === "string" && r.error ? r.error : null,
                costUsd: toNumber(r.cost_usd),
                mins: toNumber(r.mins),
                ageDays: toNumber(r.age_days) ?? 0
              }];
            });
            let statsByModel = accumulateRunStats(runOutcomeRows);
            const closingRuns = closingRunRows.flatMap((row) => {
              const r = asRecord(row);
              const modelId = resolveConfiguredModelId(
                typeof r.model === "string" ? r.model : null,
                config.models
              );
              if (!modelId) return [];
              const issueId = typeof r.issue_id === "string" ? r.issue_id : "";
              return [{
                issueId,
                modelId,
                tier: issueId ? tierByIssue.get(issueId) ?? null : null,
                finishedAtMs: toNumber(r.finished_at_ms) ?? 0,
                agentId: typeof r.agent_id === "string" && r.agent_id ? r.agent_id : null,
                costUsd: toNumber(r.cost_usd)
              }];
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
            const aaSnapshot = await readAaSnapshot();
            const aaKnownSlugs = new Set(Object.keys(aaSnapshot.bySlug));
            const liveAaIndex = (model) => {
              const slug = resolveAaSlug(model.id, aaKnownSlugs, model.aaSlug ?? null);
              if (!slug) return model.aaIndex;
              const live = aaSnapshot.bySlug[slug]?.intelligenceIndex;
              return typeof live === "number" ? live : model.aaIndex;
            };
            const benchmarkRow = (model) => FROZEN_BENCHMARK_ROWS[model.id] ?? null;
            const modelScores = config.models.map(
              (model) => buildModelScore(model.id, liveAaIndex(model), statsByModel[model.id] ?? {}, TIERS, benchmarkRow(model))
            );
            const scoresByModelId = {};
            for (const score2 of modelScores) scoresByModelId[score2.modelId] = score2;
            const overlaid = applyDerivedTiers(config.models, scoresByModelId);
            const retierings = overlaid.flatMap((model, index) => {
              const configured = config.models[index];
              if (!configured || configured.tier === model.tier) return [];
              const p = scoresByModelId[model.id]?.overall.p;
              const lane = configured.laneId ? `@${configured.laneId}` : "";
              return [`${model.id}${lane} ${configured.tier} -> ${model.tier} (p=${p})`];
            });
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
            for (const run of closingRuns) {
              if (!run.issueId) continue;
              runCountByIssue.set(run.issueId, (runCountByIssue.get(run.issueId) ?? 0) + 1);
              const existing = latestClosingRunByIssue.get(run.issueId);
              if (!existing || run.finishedAtMs > existing.finishedAtMs) {
                latestClosingRunByIssue.set(run.issueId, run);
              }
            }
            const cardRows = [];
            for (const row of cardIssueRows) {
              const r = asRecord(row);
              const issueId = typeof r.id === "string" ? r.id : null;
              if (!issueId) continue;
              const closingRun = latestClosingRunByIssue.get(issueId);
              if (!closingRun || closingRun.tier === null) continue;
              const rawPinnedModel = typeof r.pinned_model === "string" && r.pinned_model ? r.pinned_model : null;
              const pinnedModel = resolveConfiguredModelId(
                rawPinnedModel,
                config.models
              );
              cardRows.push({
                modelId: closingRun.modelId,
                tier: closingRun.tier,
                closedAtMs: toNumber(r.closed_at_ms) ?? 0,
                rejected: rejectedIssueIds.has(issueId),
                costUsd: closingRun.costUsd,
                runCount: runCountByIssue.get(issueId) ?? 1,
                foreignRun: rawPinnedModel !== null && pinnedModel !== closingRun.modelId
              });
            }
            const priorPByModel = {};
            const blendedListPriceByModel = {};
            for (const model of config.models) {
              priorPByModel[model.id] = blendedPriorP(liveAaIndex(model), benchmarkRow(model));
              blendedListPriceByModel[model.id] = null;
            }
            const cardLedger = buildCardLedger(
              cardRows,
              Date.now(),
              priorPByModel,
              blendedListPriceByModel
            );
            const computedAt = (/* @__PURE__ */ new Date()).toISOString();
            await ctx.state.set(scoresKey(company.id), { modelScores, cardLedger, computedAt });
            ctx.logger.info("model scores refreshed", {
              companyId: company.id,
              models: modelScores.length,
              cardsInLedger: cardRows.length,
              tierSpecVersion: BENCHMARK_SPEC_VERSION,
              computedAt,
              retiered: retierings.length,
              unscored: modelScores.filter((score2) => score2.derivedTier === null).length,
              belowT3Floor: modelScores.filter((score2) => score2.belowT3Floor).length,
              // Named, not just counted: a tier move is the one thing here an
              // operator may need to reverse, and a bare count cannot be acted on.
              retierings
            });
          } catch (cause) {
            ctx.logger.error("score refresh failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause)
            });
          }
        }
      });
      ctx.jobs.register(JOB_KEYS.classifyIssues, async () => {
        const companies = listKnownCompanies();
        for (const company of companies) {
          try {
            const config = await companyConfig(company.id);
            if (!config.classification.enabled) continue;
            if (!config.classification.baseUrl || !config.classification.modelId) continue;
            let apiKey = null;
            if (config.classification.apiKeySecretRef) {
              try {
                apiKey = await ctx.secrets.resolve(config.classification.apiKeySecretRef, {
                  companyId: company.id,
                  configPath: "classification.apiKeySecretRef"
                });
              } catch {
                ctx.logger.error("classification secret unavailable", { companyId: company.id });
                continue;
              }
            }
            const classifyFetchLimit = Math.min(
              config.classification.batchSize * CLASSIFY_FETCH_MULTIPLIER,
              CLASSIFY_FETCH_LIMIT_MAX
            );
            const classifyDeadline = Date.now() + CLASSIFY_JOB_BUDGET_MS;
            const candidateRows = await ctx.db.query(
              `select i.id::text as id,
                      i.identifier as identifier,
                      i.status as status,
                      coalesce(a.name,'') as agent_name,
                      i.title as title,
                      coalesce(i.description,'') as description
                 from issues i
                 join agents a on a.id = i.assignee_agent_id
                where i.company_id = $1
                  and i.status in ('todo','in_progress','blocked','in_review')
                  and a.status <> 'terminated'
                  and i.assignee_agent_id is not null
                  and (i.assignee_adapter_overrides is null
                       or i.assignee_adapter_overrides->'adapterConfig'->>'model' is null)
                  and not exists (
                    select 1 from heartbeat_runs r
                     where r.status in ('running','queued')
                       and r.context_snapshot->>'issueId' = i.id::text
                  )
                order by case i.status when 'todo' then 0 when 'blocked' then 1 when 'in_review' then 2 else 3 end,
                         i.updated_at desc
                limit $2`,
              [company.id, String(classifyFetchLimit)]
            );
            const exclusions = await readClassificationExclusions(company.id);
            const classifierLabeled = await readClassifierLabeled(company.id);
            let classified = 0;
            let reclassified = 0;
            for (const row of candidateRows) {
              const r = asRecord(row);
              const issueId = typeof r.id === "string" ? r.id : null;
              const identifier = typeof r.identifier === "string" ? r.identifier : issueId;
              if (!issueId) continue;
              if (classified >= config.classification.batchSize) break;
              if (Date.now() >= classifyDeadline) break;
              let issue;
              try {
                issue = await ctx.issues.get(issueId, company.id);
              } catch {
                continue;
              }
              if (!issue) continue;
              const labelNames = (issue.labels ?? []).map((label) => label.name).filter((name) => typeof name === "string");
              const existingLabelIds = issue.labelIds ?? (issue.labels ?? []).map((label) => label.id).filter((id) => typeof id === "string");
              if (labelNames.includes(OPERATOR_PIN_LABEL)) continue;
              const existingLabelTier = tierFromLabels(labelNames);
              const ourRecordedTier = classifierLabeled[issueId];
              const ourLabelId = ourRecordedTier ? config.tierLabelIds[ourRecordedTier] : void 0;
              const stillCarriesOurLabel = ourRecordedTier !== void 0 && (ourRecordedTier === existingLabelTier || typeof ourLabelId === "string" && existingLabelIds.includes(ourLabelId));
              const isForeignLabel = existingLabelTier !== null && !stillCarriesOurLabel;
              if (existingLabelTier !== null) {
                if (!config.classification.reclassifyForeignLabels) continue;
                if (!isForeignLabel) continue;
              }
              const agentName = typeof r.agent_name === "string" ? r.agent_name : "";
              const title = typeof r.title === "string" ? r.title : "";
              const description = typeof r.description === "string" ? r.description : "";
              const prompt = buildClassificationPrompt(title, description, agentName, config.classification.descriptionChars);
              const result = await callClassifier(
                {
                  baseUrl: config.classification.baseUrl,
                  protocol: config.classification.protocol,
                  modelId: config.classification.modelId,
                  apiKey,
                  system: RUBRIC,
                  userPrompt: prompt,
                  maxOutputTokens: config.classification.maxOutputTokens,
                  requestTimeoutMs: config.classification.requestTimeoutMs,
                  maxResponseBytes: config.classification.maxResponseBytes
                },
                classificationHttp
              );
              if (!result.text) {
                ctx.logger.info("classification skipped", { companyId: company.id, issue: identifier, why: result.error });
                continue;
              }
              const judgement = parseClassificationResponse(result.text);
              if (!judgement) {
                ctx.logger.info("classification unparseable", { companyId: company.id, issue: identifier });
                continue;
              }
              const { labelTier, pickTier } = resolveClassifiedTiers(judgement, {
                t3ConfidenceFloor: config.classification.t3ConfidenceFloor,
                t2ConfidenceFloor: config.classification.t2ConfidenceFloor
              });
              const labelId = config.tierLabelIds[labelTier];
              if (labelId) {
                const tierLabelIdsOnIssue = new Set(
                  (issue.labels ?? []).filter((label) => typeof label.name === "string" && label.name.startsWith(TIER_LABEL_PREFIX)).map((label) => label.id).filter((id) => typeof id === "string")
                );
                for (const id of Object.values(config.tierLabelIds)) {
                  if (typeof id === "string") tierLabelIdsOnIssue.add(id);
                }
                const nextLabelIds = [
                  .../* @__PURE__ */ new Set([...existingLabelIds.filter((id) => !tierLabelIdsOnIssue.has(id)), labelId])
                ];
                await ctx.issues.update(
                  issueId,
                  { labelIds: nextLabelIds },
                  company.id
                );
                await ctx.state.set(classifierLabeledKey(company.id), { ...classifierLabeled, [issueId]: labelTier });
                classifierLabeled[issueId] = labelTier;
              }
              if (judgement.exclusion) {
                await ctx.state.set(classificationExclusionsKey(company.id), { ...exclusions, [issueId]: true });
                exclusions[issueId] = true;
              }
              await ctx.activity.log({
                companyId: company.id,
                message: `Model Selection classified this issue as ${labelTier} (confidence ${judgement.confidence})${judgement.exclusion ? ", capability-excluded" : ""}${isForeignLabel ? `, replacing an unattributed ${existingLabelTier} label` : ""}`,
                entityType: "issue",
                entityId: issueId,
                metadata: {
                  tier: labelTier,
                  pickTier,
                  confidence: judgement.confidence,
                  reason: judgement.reason,
                  ...isForeignLabel ? { replacedLabelTier: existingLabelTier } : {}
                }
              });
              classified += 1;
              if (isForeignLabel) reclassified += 1;
            }
            ctx.logger.info("issue classification pass complete", {
              companyId: company.id,
              classified,
              reclassified,
              candidates: candidateRows.length
            });
          } catch (cause) {
            ctx.logger.error("issue classification failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause)
            });
          }
        }
      });
      const balanceOpenStatuses = /* @__PURE__ */ new Set(["todo", "in_progress", "blocked", "in_review"]);
      const activeBalanceRunIssueIds = async (companyId) => {
        const rows = await ctx.db.query(
          `select distinct coalesce(context_snapshot->>'issueId', context_snapshot->>'taskId') as issue_id
             from heartbeat_runs
            where company_id = $1
              and status in ('running','queued')
              and coalesce(context_snapshot->>'issueId', context_snapshot->>'taskId') is not null`,
          [companyId]
        );
        return new Set(
          rows.map((row) => asRecord(row).issue_id).filter((issueId) => typeof issueId === "string" && issueId.length > 0)
        );
      };
      const balanceWriteStillSafe = async (companyId, issueId, expectedPinnedModelId, models) => {
        const issue = await ctx.issues.get(issueId, companyId);
        if (!issue || !balanceOpenStatuses.has(String(issue.status ?? ""))) return false;
        const scheduledRetryStatus = issue.scheduledRetry?.status ?? null;
        if (issue.checkoutRunId || issue.executionRunId || scheduledRetryStatus === "queued" || scheduledRetryStatus === "running") {
          return false;
        }
        if ((issue.labels ?? []).some((label) => label.name === OPERATOR_PIN_LABEL)) return false;
        const overrides = asRecord(issue.assigneeAdapterOverrides);
        const adapterConfig = asRecord(overrides.adapterConfig);
        const rawPinnedModelId = typeof adapterConfig.model === "string" ? adapterConfig.model : null;
        const currentPinnedModelId = resolveConfiguredModelId(rawPinnedModelId, models);
        if (rawPinnedModelId && !currentPinnedModelId) return false;
        if (currentPinnedModelId !== expectedPinnedModelId) return false;
        const activeRows = await ctx.db.query(
          `select coalesce(context_snapshot->>'issueId', context_snapshot->>'taskId') as issue_id
             from heartbeat_runs
            where company_id = $1
              and status in ('running','queued')
              and coalesce(context_snapshot->>'issueId', context_snapshot->>'taskId') = $2
            limit 1`,
          [companyId, issueId]
        );
        return !activeRows.some((row) => asRecord(row).issue_id === issueId);
      };
      const isUsableAndCapable = (modelId, tier2, requiredContextTokens, config, laneLedger, laneOutageOverride, modelScores, nowIso) => {
        if (!modelId) return false;
        const model = config.models.find((m) => m.id === modelId && m.enabled);
        if (!model) return false;
        if (typeof requiredContextTokens === "number" && model.contextWindow < requiredContextTokens) return false;
        if (config.pacing.mode === "off") return true;
        if (hardStopExcluded(laneLedger, model)) return false;
        if (laneAvoidExcluded(laneLedger, model, config.pacing.avoid)) return false;
        if (laneOutageExcluded(laneOutageOverride, nowIso, model)) return false;
        const score2 = modelScores[model.id]?.tiers[tier2];
        if (score2 && score2.capable === false) return false;
        return true;
      };
      const countActivePinsOfModel = async (companyId, modelId) => {
        const rows = await ctx.db.query(
          `select count(*)::int as n
             from issues i
            where i.company_id = $1
              and i.status in ('todo','in_progress','in_review','blocked')
              and i.assignee_adapter_overrides->'adapterConfig'->>'model' = $2`,
          [companyId, modelId]
        );
        const r = asRecord(rows[0]);
        return typeof r.n === "number" ? r.n : 0;
      };
      const tierWithFallback = (descriptor, models, defaultTier) => tierFromLabels(descriptor.labelNames) ?? tierOfModel(descriptor.pinnedModelId, models) ?? tierOfModel(descriptor.agentFloorModelId, models) ?? defaultTier;
      ctx.jobs.register(JOB_KEYS.labelOnlyPass, async () => {
        const companies = listKnownCompanies();
        for (const company of companies) {
          try {
            const config = await companyConfig(company.id);
            if (!config.classification.enabled) continue;
            const candidateRows = await ctx.db.query(
              `select i.id::text as id,
                      i.identifier as identifier,
                      i.status as status,
                      coalesce(a.adapter_config->>'model','') as floor_model
                 from issues i
                 join agents a on a.id = i.assignee_agent_id
                where i.company_id = $1
                  and i.status in ('todo','in_progress','blocked','in_review')
                  and a.status <> 'terminated'
                  and (i.assignee_adapter_overrides is null
                       or i.assignee_adapter_overrides->'adapterConfig'->>'model' is null)
                  and not exists (
                    select 1 from heartbeat_runs r
                     where r.status in ('running','queued')
                       and r.context_snapshot->>'issueId' = i.id::text
                  )
                order by i.updated_at desc
                limit $2`,
              [company.id, String(LABEL_ONLY_PASS_FETCH_LIMIT)]
            );
            const laneLedger = await readLaneLedger(company.id);
            const laneOutageOverride = await readLaneOutage(company.id);
            const modelScores = await readModelScores(company.id);
            const nowIso = (/* @__PURE__ */ new Date()).toISOString();
            const contextUsageCache = /* @__PURE__ */ new Map();
            let pinned = 0;
            for (const row of candidateRows) {
              const r = asRecord(row);
              const issueId = typeof r.id === "string" ? r.id : null;
              const identifier = typeof r.identifier === "string" ? r.identifier : issueId;
              if (!issueId) continue;
              const described = await describeIssue(company.id, issueId, {}, contextUsageCache);
              if (!described) continue;
              if (described.hasOperatorPin) continue;
              const labelTier = tierFromLabels(described.descriptor.labelNames);
              const tier2 = tierWithFallback(described.descriptor, config.models, config.selection.defaultTier);
              const result = await advise(company.id, { issueId }, false, void 0, false, contextUsageCache);
              if (!result || result.decision.outcome !== "selected" || !result.decision.modelId) {
                ctx.logger.info("label-only pass: no pick", { companyId: company.id, issue: identifier, tier: tier2 });
                await maybeLogUnpinnableCard(company.id, issueId, identifier, result?.decision ?? null);
                continue;
              }
              const floorModelId = resolveConfiguredModelId(result.agentFloorModelId, config.models);
              if (result.decision.modelId === floorModelId && isUsableAndCapable(
                floorModelId,
                tier2,
                described.descriptor.requiredContextTokens,
                config,
                laneLedger,
                laneOutageOverride,
                modelScores,
                nowIso
              )) {
                ctx.logger.info("label-only pass skipped: pick equals healthy floor", {
                  companyId: company.id,
                  issue: identifier,
                  tier: tier2
                });
                continue;
              }
              const selectedModel = config.models.find((model) => model.id === result.decision.modelId);
              if (!selectedModel) continue;
              await ctx.issues.update(
                issueId,
                modelOverrideForContext({
                  model: selectedModel,
                  fleetCeilingTokens: config.selection.fleetContextCeilingTokens,
                  compactionRatio: config.selection.compactionRatio,
                  agentEnv: described.agentEnv,
                  existingOverrideEnv: described.existingOverrideEnv
                }),
                company.id
              );
              await ctx.activity.log({
                companyId: company.id,
                message: result.decision.modelId === floorModelId ? `Model Selection explicitly pinned ${result.decision.modelId} (${tier2}): floor lane unserviceable` : `Model Selection label-only pinned ${result.decision.modelId} (${tier2}) from ${labelTier ? "the existing tier label" : "the tier floor/default (no tier label present)"}`,
                entityType: "issue",
                entityId: issueId,
                metadata: { modelId: result.decision.modelId, tier: tier2, fromLabel: labelTier !== null, trace: result.decision.trace }
              });
              pinned += 1;
            }
            ctx.logger.info("label-only pass complete", { companyId: company.id, pinned, candidates: candidateRows.length });
          } catch (cause) {
            ctx.logger.error("label-only pass failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause)
            });
          }
        }
      });
      const runRepinPassForCompany = async (companyId) => {
        const company = { id: companyId };
        let repinnedTotal = 0;
        {
          try {
            const config = await companyConfig(company.id);
            if (!config.classification.enabled) return 0;
            const candidateRows = await ctx.db.query(
              `select i.id::text as id,
                      i.identifier as identifier,
                      i.status as status,
                      i.updated_at as updated_at
                 from issues i
                 join agents a on a.id = i.assignee_agent_id
                where i.company_id = $1
                  and i.status in ('todo','in_progress','blocked','in_review')
                  and a.status <> 'terminated'
                  and i.assignee_adapter_overrides->'adapterConfig'->>'model' is not null
                  and not exists (
                    select 1 from heartbeat_runs r
                     where r.status in ('running','queued')
                       and r.context_snapshot->>'issueId' = i.id::text
                  )
                order by i.updated_at asc
                limit $2`,
              [company.id, String(REPIN_PASS_FETCH_LIMIT)]
            );
            const laneLedger = await readLaneLedger(company.id);
            const laneOutageOverride = await readLaneOutage(company.id);
            const modelScores = await readModelScores(company.id);
            const nowIso = (/* @__PURE__ */ new Date()).toISOString();
            const contextUsageCache = /* @__PURE__ */ new Map();
            let repinned = 0;
            for (const row of candidateRows) {
              if (repinned >= REPIN_PASS_WRITE_LIMIT) break;
              const r = asRecord(row);
              const issueId = typeof r.id === "string" ? r.id : null;
              const identifier = typeof r.identifier === "string" ? r.identifier : issueId;
              if (!issueId) continue;
              const described = await describeIssue(company.id, issueId, {}, contextUsageCache);
              if (!described) continue;
              if (described.hasOperatorPin) continue;
              const tier2 = tierWithFallback(described.descriptor, config.models, config.selection.defaultTier);
              const pinnedModelId = resolveConfiguredModelId(described.descriptor.pinnedModelId, config.models);
              const usage = await described.contextUsage();
              const contextEstimate = estimateIssueContext({
                lastRunInputTokens: usage.lastRunInputTokens,
                lastRunCachedInputTokens: usage.lastRunCachedInputTokens,
                fleetCeilingTokens: config.selection.fleetContextCeilingTokens
              });
              described.descriptor.requiredContextTokens = contextEstimate.tokens ?? void 0;
              if (isUsableAndCapable(
                pinnedModelId,
                tier2,
                described.descriptor.requiredContextTokens,
                config,
                laneLedger,
                laneOutageOverride,
                modelScores,
                nowIso
              )) {
                continue;
              }
              const result = await advise(company.id, { issueId }, false, void 0, true, contextUsageCache);
              if (!result || result.decision.outcome !== "selected" || !result.decision.modelId) continue;
              if (result.decision.modelId === pinnedModelId) continue;
              if (!isUsableAndCapable(
                result.decision.modelId,
                tier2,
                described.descriptor.requiredContextTokens,
                config,
                laneLedger,
                laneOutageOverride,
                modelScores,
                nowIso
              )) {
                continue;
              }
              const selectedModel = config.models.find((model) => model.id === result.decision.modelId);
              if (!selectedModel) continue;
              await ctx.issues.update(
                issueId,
                modelOverrideForContext({
                  model: selectedModel,
                  fleetCeilingTokens: config.selection.fleetContextCeilingTokens,
                  compactionRatio: config.selection.compactionRatio,
                  agentEnv: described.agentEnv,
                  existingOverrideEnv: described.existingOverrideEnv
                }),
                company.id
              );
              await ctx.activity.log({
                companyId: company.id,
                message: `Model Selection re-pinned ${pinnedModelId} -> ${result.decision.modelId} (${tier2}): lane unusable or measurably demoted`,
                entityType: "issue",
                entityId: issueId,
                metadata: { from: pinnedModelId, modelId: result.decision.modelId, tier: tier2, trace: result.decision.trace }
              });
              repinned += 1;
            }
            repinnedTotal = repinned;
            ctx.logger.info("repin pass complete", { companyId: company.id, repinned, candidates: candidateRows.length });
          } catch (cause) {
            ctx.logger.error("repin pass failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause)
            });
          }
        }
        return repinnedTotal;
      };
      ctx.jobs.register(JOB_KEYS.repinPass, async () => {
        for (const company of listKnownCompanies()) {
          await runRepinPassForCompany(company.id);
        }
      });
      ctx.events.on("agent.run.failed", async (event) => {
        const payload = asRecord(event.payload);
        const companyId = event.companyId;
        const issueId = typeof payload.issueId === "string" ? payload.issueId : null;
        let config;
        try {
          config = await companyConfig(companyId);
        } catch {
          return;
        }
        if (config.models.length === 0) return;
        const fallbackModelId = async () => {
          if (!issueId) return null;
          try {
            const described = await describeIssue(companyId, issueId, {});
            return described?.descriptor.pinnedModelId ?? null;
          } catch {
            return null;
          }
        };
        const quickVerdict = laneExhaustionFromRunFailure({
          error: typeof payload.error === "string" ? payload.error : null,
          errorCode: typeof payload.errorCode === "string" ? payload.errorCode : null,
          models: config.models
        });
        const verdict = quickVerdict ?? laneExhaustionFromRunFailure({
          error: typeof payload.error === "string" ? payload.error : null,
          errorCode: typeof payload.errorCode === "string" ? payload.errorCode : null,
          models: config.models,
          fallbackModelId: await fallbackModelId()
        });
        if (!verdict) return;
        const nowMs = Date.parse(event.occurredAt) || Date.now();
        const nowIso = new Date(nowMs).toISOString();
        const existing = await readLaneOutage(companyId);
        if (isLaneOutageActive(existing, nowIso) && existing.lanes.includes(verdict.laneId)) {
          ctx.logger.info("lane already quarantined, skipping repeat sweep", {
            companyId,
            laneId: verdict.laneId,
            until: existing.until
          });
          return;
        }
        const addition = autoQuarantineFor(verdict, nowMs);
        await ctx.state.set(laneOutageKey(companyId), mergeLaneOutage(existing, addition, nowIso));
        await ctx.activity.log({
          companyId,
          message: `Model Selection quarantined lane ${verdict.laneId} until ${addition.until}: a run was rejected on ${verdict.modelId} with a lane-capacity error. Re-pinning open cards off this lane now.`,
          ...issueId ? { entityType: "issue", entityId: issueId } : {},
          metadata: {
            laneId: verdict.laneId,
            modelId: verdict.modelId,
            until: addition.until,
            matchedPhrase: verdict.matchedPhrase,
            modelFromErrorText: verdict.modelFromErrorText,
            runId: typeof payload.runId === "string" ? payload.runId : null
          }
        });
        const repinned = await runRepinPassForCompany(companyId);
        ctx.logger.info("lane quarantine repin complete", { companyId, laneId: verdict.laneId, repinned });
      });
      ctx.jobs.register(JOB_KEYS.balancePass, async () => {
        const companies = listKnownCompanies();
        const jobStartedAt = Date.now();
        const deadlineAt = jobStartedAt + BALANCE_PASS_JOB_BUDGET_MS;
        for (const company of companies) {
          if (Date.now() >= deadlineAt) {
            ctx.logger.warn("balance pass stopped before the host RPC wall", {
              companyId: company.id,
              durationMs: Date.now() - jobStartedAt,
              budgetMs: BALANCE_PASS_JOB_BUDGET_MS
            });
            break;
          }
          const startedAt = Date.now();
          try {
            const config = await companyConfig(company.id);
            if (!config.classification.enabled) continue;
            const cursorKey = {
              scopeKind: "company",
              scopeId: company.id,
              stateKey: PLUGIN_STATE_KEYS.balancePassCursor
            };
            const storedCursor = asRecord(await ctx.state.get(cursorKey));
            const afterId = typeof storedCursor.afterId === "string" ? storedCursor.afterId : "";
            const candidateRows = await ctx.db.query(
              `select i.id::text as id,
                      i.identifier as identifier
                 from issues i
                 join agents a on a.id = i.assignee_agent_id
                where i.company_id = $1
                  and i.id::text > $2
                  and i.status in ('todo','in_progress','blocked','in_review')
                  and a.status <> 'terminated'
                order by i.id::text asc
                limit $3`,
              [company.id, afterId, String(BALANCE_PASS_FETCH_LIMIT)]
            );
            const activeRunIssueIds = await activeBalanceRunIssueIds(company.id);
            const laneLedger = await readLaneLedger(company.id);
            const laneOutageOverride = await readLaneOutage(company.id);
            const modelScores = await readModelScores(company.id);
            const nowIso = (/* @__PURE__ */ new Date()).toISOString();
            const now = Date.now();
            const contextUsageCache = /* @__PURE__ */ new Map();
            let balanced = 0;
            let scanned = 0;
            let lastScannedId = afterId;
            let budgetExhausted = false;
            for (const row of candidateRows) {
              if (balanced >= BALANCE_PASS_WRITE_LIMIT) break;
              if (Date.now() >= deadlineAt) {
                budgetExhausted = true;
                break;
              }
              const r = asRecord(row);
              const issueId = typeof r.id === "string" ? r.id : null;
              const identifier = typeof r.identifier === "string" ? r.identifier : issueId;
              if (!issueId) continue;
              scanned += 1;
              lastScannedId = issueId;
              if (activeRunIssueIds.has(issueId)) continue;
              const described = await describeIssue(company.id, issueId, {}, contextUsageCache);
              if (!described) continue;
              if (!balanceOpenStatuses.has(described.status)) continue;
              if (!described.isIdle) continue;
              if (described.hasOperatorPin) continue;
              const status = described.status;
              const labelTier = tierFromLabels(described.descriptor.labelNames);
              const pinnedModelId = resolveConfiguredModelId(described.descriptor.pinnedModelId, config.models);
              const pinnedModel = pinnedModelId ? config.models.find((m) => m.id === pinnedModelId) : void 0;
              if (!labelTier && !pinnedModelId) continue;
              const tier2 = labelTier ?? tierWithFallback(described.descriptor, config.models, config.selection.defaultTier);
              if (pinnedModelId && pinnedModel) {
                const currentUtilization = pinnedModel.laneId ? laneEffectiveUtilization(laneLedger, pinnedModel.laneId) : null;
                const result = await advise(company.id, { issueId }, false, void 0, true, contextUsageCache);
                if (!result || result.decision.outcome !== "selected" || !result.decision.modelId) continue;
                if (!result.isIdle || !balanceOpenStatuses.has(result.status)) continue;
                if (resolveConfiguredModelId(result.pinnedModelId, config.models) !== pinnedModelId) continue;
                if (result.decision.modelId === pinnedModelId) continue;
                const newModel = config.models.find((m) => m.id === result.decision.modelId);
                if (!newModel) continue;
                const newUtilization = newModel.laneId ? laneEffectiveUtilization(laneLedger, newModel.laneId) : null;
                const cheaper = blendedListPrice(newModel) <= BALANCE_PASS_COST_DOWN_MULTIPLIER * blendedListPrice(pinnedModel);
                const pinnedScore = modelScores[pinnedModelId]?.tiers[tier2];
                let incapable = pinnedScore ? pinnedScore.capable === false : false;
                if (!incapable && blendedListPrice(pinnedModel) < BALANCE_PASS_PROBATION_PRICE_USD && !(pinnedScore?.proven ?? false)) {
                  const activeCount = await countActivePinsOfModel(company.id, pinnedModelId);
                  if (activeCount > 1) incapable = true;
                }
                if (!incapable && (status === "todo" || status === "in_progress") && pinnedModel.laneId && config.pacing.mode !== "off") {
                  const pinsWeightByLane = await activePinsWeightByLane(company.id, config.models);
                  const admitted = laneHasRoom({
                    laneId: pinnedModel.laneId,
                    activePinsWeight: pinsWeightByLane[pinnedModel.laneId] ?? 0,
                    extra: -1,
                    ledger: laneLedger,
                    capPerAccount: config.pacing.laneCapPerAccount,
                    fiveHourWindowName: config.pacing.fiveHourWindowName,
                    zaiLaneId: config.pacing.zai.laneId,
                    zaiWeeklyWindowName: config.pacing.zai.weeklyWindowName,
                    zaiWeeklyDefaultMargin: config.pacing.zai.weeklyDefaultMargin,
                    zaiPaceOverrideMargin: null,
                    nowMs: now
                  });
                  if (!admitted) incapable = true;
                }
                const busier = currentUtilization !== null && newUtilization !== null && currentUtilization - newUtilization >= BALANCE_PASS_BUSIER_UTILIZATION_DELTA;
                if (!(cheaper || incapable || busier)) continue;
                const selectedModel = config.models.find((model) => model.id === result.decision.modelId);
                if (!selectedModel) continue;
                if (!await balanceWriteStillSafe(company.id, issueId, pinnedModelId, config.models)) continue;
                await ctx.issues.update(
                  issueId,
                  modelOverrideForContext({
                    model: selectedModel,
                    fleetCeilingTokens: config.selection.fleetContextCeilingTokens,
                    compactionRatio: config.selection.compactionRatio,
                    agentEnv: result.agentEnv,
                    existingOverrideEnv: result.existingOverrideEnv
                  }),
                  company.id
                );
                await ctx.activity.log({
                  companyId: company.id,
                  message: `Model Selection balanced ${pinnedModelId} -> ${result.decision.modelId} (${tier2}): ${cheaper ? "cost-down" : incapable ? "demote" : "rebalance"}`,
                  entityType: "issue",
                  entityId: issueId,
                  metadata: { from: pinnedModelId, modelId: result.decision.modelId, tier: tier2, cheaper, incapable, busier }
                });
                balanced += 1;
              } else {
                const result = await advise(company.id, { issueId }, false, "T1", false, contextUsageCache);
                if (!result || result.decision.outcome !== "selected" || !result.decision.modelId) {
                  await maybeLogUnpinnableCard(company.id, issueId, identifier, result?.decision ?? null);
                  continue;
                }
                if (!result.isIdle || !balanceOpenStatuses.has(result.status)) continue;
                if (result.pinnedModelId !== null) continue;
                const floorModelId = resolveConfiguredModelId(result.agentFloorModelId, config.models);
                const floorHealthy = result.decision.modelId === floorModelId && isUsableAndCapable(
                  floorModelId,
                  tier2,
                  described.descriptor.requiredContextTokens,
                  config,
                  laneLedger,
                  laneOutageOverride,
                  modelScores,
                  nowIso
                );
                if (floorHealthy) continue;
                const selectedModel = config.models.find((model) => model.id === result.decision.modelId);
                if (!selectedModel) continue;
                if (!await balanceWriteStillSafe(company.id, issueId, null, config.models)) continue;
                await ctx.issues.update(
                  issueId,
                  modelOverrideForContext({
                    model: selectedModel,
                    fleetCeilingTokens: config.selection.fleetContextCeilingTokens,
                    compactionRatio: config.selection.compactionRatio,
                    agentEnv: result.agentEnv,
                    existingOverrideEnv: result.existingOverrideEnv
                  }),
                  company.id
                );
                await ctx.activity.log({
                  companyId: company.id,
                  message: result.decision.modelId === floorModelId ? `Model Selection explicitly pinned ${result.decision.modelId} (T1): floor lane unserviceable` : `Model Selection balanced floor -> ${result.decision.modelId} (T1): unpinned labelled card given a balanced T1 pin`,
                  entityType: "issue",
                  entityId: issueId,
                  metadata: { from: floorModelId, modelId: result.decision.modelId, tier: "T1" }
                });
                balanced += 1;
              }
            }
            const cycleComplete = scanned === candidateRows.length && candidateRows.length < BALANCE_PASS_FETCH_LIMIT;
            const nextAfterId = cycleComplete ? null : lastScannedId || null;
            await ctx.state.set(cursorKey, { afterId: nextAfterId });
            ctx.logger.info("balance pass complete", {
              companyId: company.id,
              balanced,
              candidates: candidateRows.length,
              scanned,
              afterId: afterId || null,
              nextAfterId,
              cycleComplete,
              budgetExhausted,
              durationMs: Date.now() - startedAt,
              jobDurationMs: Date.now() - jobStartedAt
            });
            if (budgetExhausted) break;
          } catch (cause) {
            ctx.logger.error("balance pass failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause),
              durationMs: Date.now() - startedAt,
              jobDurationMs: Date.now() - jobStartedAt
            });
          }
        }
      });
      ctx.jobs.register(JOB_KEYS.dispatchSweep, async (job) => {
        const companies = listKnownCompanies();
        for (const company of companies) {
          try {
            const config = await companyConfig(company.id);
            const dispatchConfig = config.dispatch;
            const notes = [];
            const issues = await ctx.issues.list({
              companyId: company.id,
              limit: DISPATCH_ISSUE_PAGE_LIMIT
            });
            if (issues.length >= DISPATCH_ISSUE_PAGE_LIMIT) {
              ctx.logger.warn("dispatch sweep: issue page saturated, some issues were not seen this firing", {
                companyId: company.id,
                pageLimit: DISPATCH_ISSUE_PAGE_LIMIT
              });
              notes.push(
                `issue list saturated at limit ${DISPATCH_ISSUE_PAGE_LIMIT} \u2014 counters undercount the board`
              );
            }
            const nonTerminal = issues.filter(
              (issue) => !TERMINAL_STATUSES2.includes(issue.status)
            );
            const routingGapBase = summariseRoutingGap(nonTerminal.map((issue) => ({ issue })));
            let routingGap = routingGapBase;
            if (routingGapBase.count > 0) {
              try {
                const agents = await ctx.agents.list({ companyId: company.id });
                routingGap = { ...routingGapBase, owners: identifyRoutingOwners(agents) };
                if (!routingGap.owners?.complete) {
                  notes.push(
                    `routing owners are a partial list: ${(routingGap.owners?.unreadableSources ?? []).join(", ")} are not readable from the plugin capability surface`
                  );
                }
              } catch (cause) {
                ctx.logger.warn("dispatch sweep: could not read agents for routing-gap owners", {
                  companyId: company.id,
                  error: cause instanceof Error ? cause.message : String(cause)
                });
              }
            }
            const assigned = nonTerminal.filter((issue) => issue.assigneeAgentId);
            const population = [];
            let unreadable = 0;
            for (const issue of nonTerminal) {
              if (!issue.assigneeAgentId) {
                population.push({ issue });
                continue;
              }
              try {
                const orchestration = await ctx.issues.summaries.getOrchestration({
                  issueId: issue.id,
                  companyId: company.id
                });
                const relation = orchestration.relations[issue.id];
                const interactions = await ctx.issues.listInteractions(issue.id, company.id);
                population.push({
                  issue,
                  blockedBy: (relation?.blockedBy ?? []).map((b) => ({ id: b.id, status: b.status })),
                  runs: orchestration.runs.map((r) => ({
                    issueId: r.issueId,
                    status: r.status,
                    finishedAt: r.finishedAt,
                    startedAt: r.startedAt,
                    createdAt: r.createdAt
                  })),
                  invocationBlock: orchestration.invocationBlocks.find((b) => b.issueId === issue.id) ?? null,
                  pendingInteractions: interactions.filter((i) => i.status === "pending").map((i) => ({
                    status: i.status,
                    addresseeAgentId: i.addresseeAgentId ?? null,
                    effectiveResolverPolicy: i.effectiveResolverPolicy ?? null
                  }))
                });
              } catch (cause) {
                unreadable += 1;
                ctx.logger.warn("dispatch sweep: could not read orchestration for an issue, excluding it", {
                  companyId: company.id,
                  issueId: issue.id,
                  error: cause instanceof Error ? cause.message : String(cause)
                });
              }
            }
            if (unreadable > 0) {
              notes.push(`${unreadable} assigned issues could not be read and are excluded from selection`);
            }
            const selection = selectDispatch(population, {
              idleMinutes: dispatchConfig.idleMinutes,
              maxWakesPerFiring: dispatchConfig.maxWakesPerFiring,
              focusProjectIds: [...dispatchConfig.focusProjectIds],
              now: Date.now()
            });
            selection.routingGap = routingGap;
            const wakeOutcomes = [];
            if (dispatchConfig.wakeEnabled) {
              for (const pick of selection.picks) {
                try {
                  const result = await ctx.issues.requestWakeup(pick.issue.id, company.id, {
                    reason: "dispatch_stalled_issue",
                    contextSource: "plugin.dispatch.sweep",
                    idempotencyKey: `dispatch:${job.runId}:${pick.issue.id}`
                  });
                  wakeOutcomes.push({ issueId: pick.issue.id, queued: result.queued });
                } catch (cause) {
                  wakeOutcomes.push({
                    issueId: pick.issue.id,
                    queued: false,
                    error: cause instanceof Error ? cause.message : String(cause)
                  });
                }
              }
            }
            if (!dispatchConfig.wakeEnabled && selection.picks.length > 0) {
              notes.push(
                `report-only: would have woken ${selection.picks.map((p) => p.issue.identifier ?? p.issue.id).join(", ")}`
              );
            }
            const summary2 = summariseFiring(company.id, selection, wakeOutcomes);
            await emitMetrics(ctx, { companyId: company.id, summary: summary2, wakeEnabled: dispatchConfig.wakeEnabled });
            const previous = await ctx.state.get(dispatchLastFiringKey(company.id));
            if (hasStateChanged(previous, summary2)) {
              await logStateChange(ctx, { companyId: company.id, summary: summary2, wakeEnabled: dispatchConfig.wakeEnabled, notes });
              await ctx.state.set(dispatchLastFiringKey(company.id), summary2);
            }
            ctx.logger.info("dispatch sweep complete", {
              companyId: company.id,
              woken: summary2.counters.woken,
              candidatesReady: summary2.legacy.candidates_ready,
              runnableQueue: summary2.legacy.runnable_queue,
              routingGap: summary2.routingGapCount,
              assignedGathered: assigned.length
            });
          } catch (cause) {
            ctx.logger.error("dispatch sweep failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause)
            });
          }
        }
      });
      const persistedCompanies = asRecord(await ctx.state.get(knownCompaniesKey()));
      if (Array.isArray(persistedCompanies.ids)) {
        for (const id of persistedCompanies.ids) {
          if (typeof id === "string") knownCompanyIds.add(id);
        }
      }
      ctx.logger.info("Model Selection worker ready", { version: PLUGIN_VERSION });
    },
    async onHealth() {
      return { status: "ok", message: `Model Selection ${PLUGIN_VERSION}` };
    },
    /**
     * TOG-2438 reopen: the sole feed for `knownCompanyIds` (see the comment
     * above its declaration). The host calls this unconditionally for every
     * configured company at worker startup (`plugin-loader.ts` step 5b) and
     * again on every operator config save — so this set converges to exactly
     * "companies with stored config for this plugin" without ever calling
     * `ctx.companies.list()` ourselves. `context.companyId === null` is an
     * instance/global save, which this plugin's config schema doesn't use;
     * skip it rather than tracking a non-company id.
     *
     * Persisted immediately (not just held in memory) so a bare crash-restart
     * — which respawns the worker without replaying `configChanged` — can
     * still recover the set from state in `setup()` above, instead of silently
     * running every scheduled job over zero companies.
     */
    async onConfigChanged(_newConfig, changeContext) {
      const companyId = changeContext?.companyId;
      if (!companyId || knownCompanyIds.has(companyId)) return;
      knownCompanyIds.add(companyId);
      if (context) {
        await context.state.set(knownCompaniesKey(), { ids: [...knownCompanyIds] });
      }
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
