import { SHADOW_EXPLANATIONS_CAP, SHADOW_PICK_WHY_MAX_CHARS } from "./constants.js";
import { slotFactorFor, type LaneLedger, type OperatorOverrideEntry } from "./engine/pacing.js";
import type { IssueDescriptor, ModelEntry, Rejection, RejectionOperand, SelectionDecision } from "./engine/types.js";
import type { LanePaceVerdict } from "./lane-capacity/pace.js";

/**
 *  /  / . `paired-decision-v1`, the paired
 * host/plugin-shadow agreement stream `ops/gate_harness.py`
 * correlates.  retired the separate host dispatcher, so both writer
 * projections now come from the same authoritative `advise()` decision. This
 * module only builds records; `worker.ts` appends the pair via
 * `ctx.localFolders`.
 */
export const SHADOW_SCHEMA_VERSION = "paired-decision-v1";
export type DecisionWriter = "host" | "plugin-shadow";

export type ShadowLaneState = "available" | "degraded" | "exhausted" | "unavailable";

export interface ShadowAccountSnapshot {
  accountKey: string;
  authKey: string | null;
  plan: string | null;
  health: LanePaceVerdict["accounts"][number]["health"];
  serviceable: boolean;
  weight: number | null;
  weightSource: LanePaceVerdict["accounts"][number]["weightSource"];
  governingWindow: string | null;
  governingResetAt: string | null;
  bindingWindow: string | null;
  bindingResetAt: string | null;
  normalizedRemaining: number | null;
  utilization: number | null;
  elapsedTarget: number | null;
  targetBurnRate: number | null;
  observedBurnRate: number | null;
  deficit: number | null;
  recommendedShare: number;
  paceDebt: number | null;
  clearRate: number | null;
  state: LanePaceVerdict["accounts"][number]["state"];
  desiredPriority: number;
  desiredWeight: number;
  servedAuth: string | null;
}

export interface ShadowLaneSnapshot {
  weekly: number | null;
  fiveHour: number | null;
  state: ShadowLaneState;
  paceDeviation: number;
  targetBurnRate: number | null;
  observedBurnRate: number | null;
  deficit: number | null;
  accounts: ShadowAccountSnapshot[];
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

/**
 * . One rejected candidate's gate and operand — the machine-readable
 * counterpart to `Rejection.reason`, so a consumer can tell which of several
 * plausible gates actually excluded a model without parsing prose.
 */
export interface ShadowExplanation {
  modelId: string;
  gate: Rejection["stage"];
  operand: RejectionOperand;
}

export interface ShadowDecisionRecord {
  schema: typeof SHADOW_SCHEMA_VERSION;
  writer: DecisionWriter;
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
  /**
   * . One entry per rejected candidate, capped at
   * `SHADOW_EXPLANATIONS_CAP` — see `explanationsTruncated` for the count of
   * any rejections that did not fit, so a capped list never reads as a
   * complete one.
   */
  explanations: ShadowExplanation[];
  /** . Count of rejections dropped past `SHADOW_EXPLANATIONS_CAP`; 0 when nothing was cut. */
  explanationsTruncated: number;
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
  /**
   * Which named allowance windows the per-lane `weekly`/`fiveHour` columns
   * report. Config-named rather than inferred from `windowSeconds`, so the
   * reporting columns and `pacing.fiveHourWindowName`'s admission gate can
   * never disagree about which window is the five-hour one.
   */
  windowNames: { weekly: string; fiveHour: string };
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

/**
 * Utilization of ONE NAMED allowance window across a lane's accounts, for the
 * comparison stream's per-lane `weekly`/`fiveHour` columns.
 *
 * Deliberately NOT `pacing.ts`'s `laneNamedWindowUtilization`. That one is a
 * GATE input and is fail-neutral to `0`, because an unpolled lane must never
 * exclude a model on ignorance. A reporting column with the same default is a
 * false measurement: `0` on the quota page reads as "this window is untouched",
 * which is the most dangerous thing it could say about a window nobody has
 * observed. So this returns `null` when no account reports the window at all.
 *
 * `max`, not the weight-weighted mean the lane's governing `score` uses. The
 * column answers "how close is this window to gone", and a mean over one
 * exhausted and two fresh accounts (1.00, 0.02, 0.02 -> 0.35) hides precisely
 * the account that is about to stop serving. Max is also the statistic the
 * `lane_5h()` admission gate reads, so the page and the gate cannot tell
 * different stories about the same window.
 *
 * Every account is scanned, not just the healthy ones the gate filters to: an
 * exhausted account's 1.00 is the reading the owner most needs, and the gate
 * drops it only because it is deciding admission rather than describing
 * capacity.
 */
function namedWindowUtilization(verdict: LanePaceVerdict | null, windowName: string): number | null {
  const utilizations = (verdict?.accounts ?? []).flatMap((account) => {
    const window = account.windows?.find((entry) => entry.name === windowName);
    return typeof window?.utilization === "number" ? [window.utilization] : [];
  });
  return utilizations.length > 0 ? Math.max(...utilizations) : null;
}

function desiredAccountPriority(account: LanePaceVerdict["accounts"][number]): number {
  return account.state === "push" ? 100 : 0;
}

function accountSnapshots(verdict: LanePaceVerdict | null): ShadowAccountSnapshot[] {
  const accounts = verdict?.accounts ?? [];
  const reportedShare = accounts.some((account) => account.recommendedShare != null);
  const fallbackDenominator = reportedShare
    ? 0
    : accounts.reduce((sum, account) =>
      account.serviceable && account.clearRate != null ? sum + Math.max(0, account.clearRate) : sum,
    0);
  return accounts.map((account) => {
    const priority = desiredAccountPriority(account);
    const share = !account.serviceable
      ? 0
      : account.recommendedShare ?? (
        account.clearRate != null && fallbackDenominator > 0
          ? Math.max(0, account.clearRate) / fallbackDenominator
          : 0
      );
    const desiredWeight = share <= 0
      ? 0
      : Math.max(1, Math.min(1_000_000, Math.round(share * 1_000_000)));
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
      servedAuth: null,
    };
  });
}

function buildLaneSnapshot(
  models: readonly ModelEntry[],
  ledger: LaneLedger,
  slotFloorFraction: number,
  windowNames: ShadowRecordInput["windowNames"],
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
      lanes[laneId] = { weekly: null, fiveHour: null, state: "unavailable", paceDeviation: 0, targetBurnRate: null, observedBurnRate: null, deficit: null, accounts: [] };
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
      // candidates) —  slices 2-5 do not add one, so every candidate
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

/**
 * . Clamp the one unbounded free-text field so a single record can
 * never be an oversized JSONL/RPC line by itself. Pure string cut with an
 * explicit `...[truncated N chars]` tail — the marker makes the cut visible
 * to the comparison stream instead of a silent truncation.
 */
export function boundPickWhy(trace: readonly string[]): string {
  const full = trace.join("; ");
  if (full.length <= SHADOW_PICK_WHY_MAX_CHARS) return full;
  const cut = full.slice(0, SHADOW_PICK_WHY_MAX_CHARS);
  return `${cut}...[truncated ${full.length - SHADOW_PICK_WHY_MAX_CHARS} chars]`;
}

function buildDecisionRecord(input: ShadowRecordInput, writer: DecisionWriter): ShadowDecisionRecord {
  const { decision, descriptor } = input;
  const tier = decision.effectiveTier ?? decision.judgement.tier;
  const stickyKept =
    decision.outcome === "selected" &&
    descriptor.pinnedModelId != null &&
    decision.modelId === descriptor.pinnedModelId &&
    decision.trace.some((line) => line.startsWith("sticky:"));

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
    tier,
    pickedModel: decision.modelId,
    keptPin: stickyKept ? descriptor.pinnedModelId! : null,
    stateFingerprint: {
      status: input.status,
      hadOverride: input.hasOverride,
      hadRunningRun: !input.isIdle,
      pinOperator: input.hasOperatorPin,
    },
    laneSnapshot: buildLaneSnapshot(input.models, input.laneLedger, input.slotFloorFraction, input.windowNames, input.nowIso),
    candidates: buildCandidates(decision, input.models),
    // : one entry per rejected candidate, naming the gate that
    // rejected it and that gate's operand — `pickWhy`/`trace` only summarise
    // the outcome ("no model cleared the gates (112 rejected)"), which was
    // not reconstructable after the fact once the roster grew past what a
    // human could enumerate by hand. Capped, with the excess counted rather
    // than silently dropped, so a truncated list never reads as complete.
    explanations: decision.rejections.slice(0, SHADOW_EXPLANATIONS_CAP).map((rejection) => ({
      modelId: rejection.modelId,
      gate: rejection.stage,
      operand: rejection.operand,
    })),
    explanationsTruncated: Math.max(0, decision.rejections.length - SHADOW_EXPLANATIONS_CAP),
    operatorOverride: input.operatorOverride
      ? { id: input.operatorOverride.modelId, expiresAt: input.operatorOverride.expiresAt }
      : null,
    pickWhy: boundPickWhy(decision.trace),
  };
}

export function buildShadowRecord(input: ShadowRecordInput): ShadowDecisionRecord {
  return buildDecisionRecord(input, "plugin-shadow");
}

/**
 * . The host projection is emitted from the same native-plugin
 * decision as the shadow projection. It is evidence about the authoritative
 * host choice, not a second actuator or an independently recomputed pick.
 */
export function buildHostRecord(input: ShadowRecordInput): ShadowDecisionRecord {
  return buildDecisionRecord(input, "host");
}
