import { slotFactorFor, type LaneLedger, type OperatorOverrideEntry } from "./engine/pacing.js";
import type { IssueDescriptor, ModelEntry, SelectionDecision } from "./engine/types.js";
import type { LanePaceVerdict } from "./lane-capacity/pace.js";

/**
 * TOG-2137 / TOG-2138. `tog2138-decision-v1`, the plugin-shadow half of the
 * 48h host/plugin-shadow agreement stream `ops/tog-2138/gate_harness.py`
 * correlates against (schema confirmed by reading that file end to end,
 * cross-checked against `ops/tog-2138/fixtures/A_shadow.jsonl`). This module
 * only builds the record; `worker.ts` decides when to call it and appends the
 * JSONL line via `ctx.localFolders`.
 *
 * `ops/tog-1926/tier_dispatcher.py` (the reference host writer this scope
 * line names) does not itself emit this schema — see the TOG-2137 comment
 * thread. This emitter can only ever produce the plugin-shadow side; the
 * comparison stream needs a matching host-side writer this card cannot build
 * (it lives outside this plugin's file scope).
 */
export const SHADOW_SCHEMA_VERSION = "tog2138-decision-v1";

export type ShadowLaneState = "available" | "degraded" | "exhausted" | "unavailable";

export interface ShadowLaneSnapshot {
  weekly: number | null;
  fiveHour: number | null;
  state: ShadowLaneState;
  paceDeviation: number;
  slotFactor?: number;
}

export interface ShadowCandidate {
  model: string;
  lane: string;
  tier: string;
  capable: boolean;
  proven: boolean;
  usable: boolean;
  blended: number;
}

export interface ShadowDecisionRecord {
  schema: typeof SHADOW_SCHEMA_VERSION;
  writer: "plugin-shadow";
  issueId: string;
  issueIdentifier: string | null;
  ts: string;
  trigger: "new-card" | "repin";
  tier: string;
  pickedModel: string | null;
  keptPin: string | null;
  stateFingerprint: {
    status: string;
    hadOverride: boolean;
    hadRunningRun: boolean;
    pinOperator: boolean;
  };
  laneSnapshot: {
    ageSeconds: number;
    quality: "live" | "cached" | "unknown";
    laneFetchErrors: string[];
    lanes: Record<string, ShadowLaneSnapshot>;
  };
  candidates: ShadowCandidate[];
  explanations: string[];
  operatorOverride: { id: string; expiresAt: string } | null;
  pickWhy: string;
}

export interface ShadowRecordInput {
  issueId: string;
  issueIdentifier: string | null;
  nowIso: string;
  decision: SelectionDecision;
  descriptor: IssueDescriptor;
  status: string;
  hasOverride: boolean;
  hasOperatorPin: boolean;
  isIdle: boolean;
  models: readonly ModelEntry[];
  laneLedger: LaneLedger;
  slotFloorFraction: number;
  operatorOverride: OperatorOverrideEntry | null;
}

/**
 * `LanePaceVerdict` (the vendored pace engine, `lane-capacity/pace.ts`) has no
 * `available|degraded|exhausted|unavailable` field of its own — it reports
 * `state`/`serviceable`. This is the one place that maps our vocabulary onto
 * the harness's: `exhausted` and a `serviceable === false` verdict both mean
 * the hard stop excludes the model, so both map to a non-`available` bucket;
 * `ahead` (slot-throttled, never fully excluded) maps to `degraded`, matching
 * what the throttle actually does. A `null` verdict (never polled) is
 * reported as `unavailable` rather than `available` — this differs from
 * `hardStopExcluded`'s own fail-neutral default (an unpolled lane excludes no
 * model), because an unpolled lane genuinely has no known capacity, and the
 * comparison stream should see that as a data gap, not a false all-clear.
 */
function laneStateLabel(verdict: LanePaceVerdict | null): ShadowLaneState {
  if (!verdict) return "unavailable";
  if (verdict.state === "exhausted") return "exhausted";
  if (verdict.serviceable === false) return "unavailable";
  if (verdict.state === "ahead") return "degraded";
  if (verdict.serviceable === true) return "available";
  return "unavailable";
}

function buildLaneSnapshot(
  models: readonly ModelEntry[],
  ledger: LaneLedger,
  slotFloorFraction: number,
  nowIso: string,
): ShadowDecisionRecord["laneSnapshot"] {
  const laneIds = new Set<string>();
  for (const model of models) {
    if (model.laneId) laneIds.add(model.laneId);
  }

  const lanes: Record<string, ShadowLaneSnapshot> = {};
  const laneFetchErrors: string[] = [];
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
    const ageSeconds = (Date.parse(nowIso) - Date.parse(entry.fetchedAt)) / 1000;
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
      ...(model ? { slotFactor: slotFactorFor(ledger, model, slotFloorFraction) } : {}),
    };
  }

  return {
    ageSeconds: Math.round(Math.max(0, maxAgeSeconds)),
    quality: !sawAnyLane ? "unknown" : allFreshAndClean ? "live" : "cached",
    laneFetchErrors,
    lanes,
  };
}

function buildCandidates(decision: SelectionDecision, models: readonly ModelEntry[]): ShadowCandidate[] {
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
      blended: Number(candidate.expectedCostUsd.toFixed(6)),
    };
  });
}

export function buildShadowRecord(input: ShadowRecordInput): ShadowDecisionRecord {
  const { decision, descriptor } = input;
  const tier = decision.effectiveTier ?? decision.judgement.tier;
  const stickyKept =
    decision.outcome === "selected" &&
    descriptor.pinnedModelId != null &&
    decision.modelId === descriptor.pinnedModelId &&
    decision.trace.some((line) => line.startsWith("sticky:"));

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
    tier,
    pickedModel: decision.modelId,
    keptPin: stickyKept ? descriptor.pinnedModelId! : null,
    stateFingerprint: {
      status: input.status,
      hadOverride: input.hasOverride,
      hadRunningRun: !input.isIdle,
      pinOperator: input.hasOperatorPin,
    },
    laneSnapshot: buildLaneSnapshot(input.models, input.laneLedger, input.slotFloorFraction, input.nowIso),
    candidates: buildCandidates(decision, input.models),
    // Self-tagged DF-*/PI-* classes are the harness's job to derive
    // (`classify_pair`), not this writer's — an empty array here is correct,
    // not a placeholder.
    explanations: [],
    operatorOverride: input.operatorOverride
      ? { id: input.operatorOverride.modelId, expiresAt: input.operatorOverride.expiresAt }
      : null,
    pickWhy: decision.trace.join("; "),
  };
}
