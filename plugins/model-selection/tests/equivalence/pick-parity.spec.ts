import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { selectModel } from "../../src/engine/select.js";
import type { LaneLedger } from "../../src/engine/pacing.js";
import type { PaceWindowObservation } from "../../src/lane-capacity/pace.js";
import type {
  IssueDescriptor,
  ModelEntry,
  ModelScore,
  QualitySignal,
  TierScore,
  VolumeProfile,
} from "../../src/engine/types.js";
import type { Tier } from "../../src/constants.js";

/**
 * Diff a real Python evaluation of `tier_dispatcher.py`'s
 * `pick()` (via `pick_reference.py`, a verbatim port with file/podman I/O
 * replaced by stdin JSON — see that file's docstring) against the TypeScript
 * `selectModel()` engine, on identical inputs, across >= 20 scenarios.
 *
 * Design constraints this file relies on, each necessary for a fair
 * comparison rather than an artifact of the newer engine's extra features:
 *
 * 1. Every scenario's `models` are all AT the scenario's required tier.
 *    Python's `pick()` only ever considers `MODELS` rows with
 *    `tier == TIER` — it has no concept of a tier FLOOR that also admits
 *    more-capable tiers (that admit-higher-tier behavior is a genuine
 *    ADR-0008 evolution in `select.ts`, not a porting target, so it
 *    is deliberately kept out of scope here by never giving a scenario a
 *    higher-tier model to admit).
 * 2. `pacingMode: "shadow"` everywhere, not `"enforce"`. `shadow` still runs
 *    every gate this harness cares about (hard-stop, lane-avoid, lane-outage,
 *    lane-no-room — all gated on `paceActive`, true in both `shadow` and
 *    `enforce`), but does NOT let `orderCandidatesByPace`'s
 *    pace-state-rank reordering overwrite `applyPickOrdering`'s cost-band
 *    tiebreak — a reordering concept `tier_dispatcher.py` never had. Using
 *    `enforce` here would silently re-sort same-tier candidates by raw cost
 *    after the band tiebreak already ran, breaking parity on any band-tiebreak
 *    scenario for a reason that has nothing to do with a porting bug.
 * 3. `signals: []` (no quality signals) on every scenario, so
 *    `escalationRisk` is always 0 and `expectedCostUsd` reduces to the direct
 *    run cost — Python's `pick()` has no escalation-risk concept at all.
 * 4. Every scenario's volume profile is `{ avgInputTokens: 3_000_000,
 *    avgCacheReadTokens: 0, avgOutputTokens: 1_000_000 }`. With no cache-read
 *    term, `runCostUsd = 3*costPerMTokIn + costPerMTokOut` — exactly 4x
 *    Python's `blended(m) = (3*costPerMTokIn + costPerMTokOut)/4`. Same
 *    constant factor for every model in every scenario, so ordering by
 *    `expectedCostUsd` is always identical to ordering by `blended()`.
 * 5. `config.stickyWithinIssue: false` and no `descriptor.pinnedModelId` /
 *    `stickyModelId` — `tier_dispatcher.py` recomputes `pick()` from scratch
 *    every run; there is no sticky-model concept to reproduce.
 * 6. Every model in a scenario gets an EXPLICIT boolean `capable`/`proven`
 *    entry in both the Python `scores.models` payload and the TS
 *    `config.modelScores` map, for the scenario's required tier only. This
 *    sidesteps both engines' "no recorded score yet" fallback paths (Python's
 *    `aaIndex`-derived prior, TS's fail-open gate) — paths that are
 *    independently unit-tested elsewhere and are not what this harness is
 *    verifying.
 * 7. `allowFallback` maps straight across (`ALLOW_FALLBACK` / `allowFallback`
 *    in the Python scenario; TS has no equivalent knob — `selectModel` always
 *    tries the fallback-only roster once every regular candidate is gone, so
 *    no scenario here needs `allowFallback: false`).
 *
 * A Python `modelId` of `"cliproxy/xyz"` is compared against the TS
 * `modelId` of `"xyz"` after stripping the `cliproxy/` prefix — the TS
 * fixtures in this repo use bare ids throughout; the Python source's ids are
 * always `cliproxy/`-prefixed (matching the live roster format it reads).
 */

const PICK_REFERENCE_PATH = fileURLToPath(new URL("./pick_reference.py", import.meta.url));

function runPythonReference(scenario: unknown): { modelId: string | null; reason: string } {
  const result = spawnSync("python3", [PICK_REFERENCE_PATH], {
    input: JSON.stringify(scenario),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`pick_reference.py exited ${result.status}: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

function stripCliproxy(modelId: string | null): string | null {
  return modelId === null ? null : modelId.replace(/^cliproxy\//, "");
}

interface LaneState {
  /** Defaults true. `false` == Python's usage state "exhausted" == TS `verdict.serviceable === false`. */
  serviceable?: boolean;
  /** Defaults 0. Read by both engines' avoid-threshold gate and the cost-band utilization tiebreak. */
  utilization?: number;
  /** Healthy account count for this lane. Defaults 1. */
  accounts?: number;
  /** `lane_5h()` / the five-hour window's utilization. Defaults 0. */
  fiveHourUtil?: number;
  /** zai-only: weekly window utilization. Undefined means "never polled" (fail-open true on both sides). */
  zaiWeeklyUtil?: number;
  zaiWeeklyResetsAt?: string;
  /** `lane_active_pins()` / `activePinsWeightByLane`. Defaults 0. */
  activePinsWeight?: number;
}

interface ScenarioModel {
  id: string;
  costIn: number;
  costOut: number;
  laneId?: string;
  fallbackOnly?: boolean;
  enabled?: boolean;
  /** Explicit (capable, proven, p) for this scenario's required tier. Required — see design note 6. */
  score: { capable: boolean; proven: boolean; p: number };
}

interface ScenarioDef {
  name: string;
  tier: Tier;
  agent?: string;
  now?: number;
  models: ScenarioModel[];
  lanes?: Readonly<Record<string, LaneState>>;
  laneOutage?: { lanes: string[]; models: string[]; until: string };
  zaiPaceOverrideMargin?: number | null;
}

const DEFAULT_NOW = Date.parse("2026-09-10T12:00:00.000Z"); // Thursday 12:00 UTC — outside zai peak hours
const ZAI_WEEKLY_MARGIN = 0.15;
const LANE_CAP_PER_ACCOUNT: Readonly<Record<string, number>> = { "opencode-go": 2, zai: 3 };

function buildProfile(tier: Tier, nowMs: number): VolumeProfile {
  return {
    tier,
    sampleCount: 50,
    computedAt: new Date(nowMs - 60 * 60 * 1000).toISOString(),
    avgInputTokens: 3_000_000,
    avgCacheReadTokens: 0,
    avgOutputTokens: 1_000_000,
  };
}

function laneWindowsForPython(state: LaneState): { state: string; utilization: number } {
  return { state: state.serviceable === false ? "exhausted" : "available", utilization: state.utilization ?? 0 };
}

function emptyTierScore(overrides: Partial<TierScore>): TierScore {
  return {
    n: 0,
    ok: 0,
    failInfra: 0,
    failModel: 0,
    tmo: 0,
    nEff: 0,
    pObs: null,
    p: 0.8,
    capable: null,
    proven: false,
    costPerSuccessUsd: null,
    medMin: null,
    rework: 0,
    ...overrides,
  };
}

function buildPythonScenario(def: ScenarioDef, nowMs: number): unknown {
  const usageModels: Record<string, { state: string; utilization: number }> = {};
  const laneAccounts: Record<string, number> = {};
  const lane5h: Record<string, number> = {};
  const laneActivePinsWeight: Record<string, number> = {};
  let zaiWeekly: { weekly_utilization: number; weekly_resets_at: string } | null = null;

  for (const [laneId, state] of Object.entries(def.lanes ?? {})) {
    laneAccounts[laneId] = state.accounts ?? 1;
    lane5h[laneId] = state.fiveHourUtil ?? 0;
    laneActivePinsWeight[laneId] = state.activePinsWeight ?? 0;
    if (laneId === "zai" && state.zaiWeeklyUtil !== undefined) {
      zaiWeekly = { weekly_utilization: state.zaiWeeklyUtil, weekly_resets_at: state.zaiWeeklyResetsAt! };
    }
  }
  for (const model of def.models) {
    if (!model.laneId) continue;
    const state = (def.lanes ?? {})[model.laneId];
    if (!state) continue;
    usageModels[`cliproxy/${model.id}`] = laneWindowsForPython(state);
  }

  const scoresModels: Record<string, { tiers: Record<string, { capable: boolean; proven: boolean; p: number }> }> = {};
  for (const model of def.models) {
    scoresModels[`cliproxy/${model.id}`] = { tiers: { [def.tier]: model.score } };
  }

  return {
    models: def.models.map((model) => ({
      id: `cliproxy/${model.id}`,
      tier: def.tier,
      enabled: model.enabled ?? true,
      costPerMTokIn: model.costIn,
      costPerMTokOut: model.costOut,
      fallbackOnly: model.fallbackOnly ?? false,
    })),
    usage: { telemetry: "available", models: usageModels },
    laneOutage: def.laneOutage ?? { lanes: [], models: [] },
    scores: { models: scoresModels, thresholds: { T1: 0.85, T2: 0.8, T3: 0.75 } },
    laneActivePinsWeight,
    laneAccounts,
    lane5h,
    zaiWeekly,
    zaiPaceOverrideMargin: def.zaiPaceOverrideMargin ?? null,
    now: new Date(nowMs).toISOString(),
    agent: def.agent ?? null,
    tier: def.tier,
    floorModel: def.models[0]!.id,
    allowFallback: true,
  };
}

/**
 * Verbatim port of `pick_reference.py`'s `lane_of()` — Python infers a
 * model's lane from its ID TEXT (no explicit lane field exists in the
 * original), while the TS side carries an explicit `ModelEntry.laneId`. If a
 * scenario's model id doesn't textually match the lane it's declared to be
 * on, Python silently reclassifies it into a different (usually
 * "opencode-go" default) lane than TS uses — producing a pass or fail for the
 * wrong reason. This guards every scenario at collection time instead of
 * relying on each author to notice the mismatch by hand.
 */
function pythonLaneOf(rawId: string): string {
  const m = rawId.replace(/^cliproxy\//, "");
  if (m.endsWith("-go")) return "opencode-go";
  if (m.startsWith("zai/") || m.startsWith("zai-openai/") || m.startsWith("glm")) return "zai";
  if (m.startsWith("claude")) return "claude";
  if (m.startsWith("gpt") || m.startsWith("codex")) return "codex";
  if (m.startsWith("kimi")) return "kimi";
  return "opencode-go";
}

function assertLaneNamingConsistent(def: ScenarioDef): void {
  for (const model of def.models) {
    if (!model.laneId) continue;
    const inferred = pythonLaneOf(model.id);
    if (inferred !== model.laneId) {
      throw new Error(
        `scenario ${def.name}: model id "${model.id}" is declared on laneId "${model.laneId}" but ` +
          `pick_reference.py's lane_of() would classify it as "${inferred}" — rename the id to match ` +
          `the lane it's testing (prefixes: claude*, codex*/gpt*, zai/*|glm*, *-go, kimi*).`,
      );
    }
  }
}

function buildTsModel(model: ScenarioModel, tier: Tier): ModelEntry {
  return {
    id: model.id,
    tier,
    enabled: model.enabled ?? true,
    costPerMTokIn: model.costIn,
    costPerMTokOut: model.costOut,
    costPerMTokCacheRead: model.costIn,
    capabilities: ["tools"],
    contextWindow: 200_000,
    aaIndex: null,
    releasedAt: "2026-01-01",
    fallbackOnly: model.fallbackOnly ?? false,
    note: "",
    earnIn: null,
    laneId: model.laneId ?? null,
  };
}

function buildLaneLedger(def: ScenarioDef): LaneLedger {
  const ledger: LaneLedger = {};
  for (const [laneId, state] of Object.entries(def.lanes ?? {})) {
    const accountCount = state.accounts ?? 1;
    const windows: PaceWindowObservation[] = [
      { name: "five_hour", role: "allowance", utilization: state.fiveHourUtil ?? 0, resetsAt: null, windowSeconds: null, sourcePath: null },
    ];
    if (laneId === "zai" && state.zaiWeeklyUtil !== undefined) {
      windows.push({
        name: "weekly",
        role: "allowance" as const,
        utilization: state.zaiWeeklyUtil,
        resetsAt: state.zaiWeeklyResetsAt ?? null,
        windowSeconds: null,
        sourcePath: null,
      });
    }
    const accounts = Array.from({ length: accountCount }, (_unused, index) => ({
      accountKey: `acct-${index}`,
      health: "healthy" as const,
      weight: 1,
      weightSource: "reported" as const,
      governingWindow: "five_hour",
      windows,
    }));
    ledger[laneId] = {
      laneId,
      fetchedAt: "t",
      error: null,
      observation: { laneId, free: false, observedAt: "t", staleAfterSeconds: 900, accounts, error: null },
      verdict: {
        laneId,
        observedAt: "t",
        state: "on",
        serviceable: state.serviceable ?? true,
        // Legacy avoidance cases are all ahead of pace at this midpoint.
        // Keep the frozen raw-utilization oracle on that common domain;
        // near-reset behavior is intentionally different and tested separately.
        score: { utilization: state.utilization ?? 0, elapsed: 0.5, deviation: (state.utilization ?? 0) - 0.5 },
        accounts: [],
        knownAccountCount: accountCount,
        knownWeight: accountCount,
        serviceableAccountCount: state.serviceable === false ? 0 : accountCount,
        urgentResetAt: null,
        reason: "ok",
      },
    };
  }
  return ledger;
}

function buildTsModelScores(def: ScenarioDef): Record<string, ModelScore> {
  const out: Record<string, ModelScore> = {};
  for (const model of def.models) {
    const tierScore = emptyTierScore(model.score);
    out[model.id] = {
      modelId: model.id,
      aaIndex: null,
      priorP: model.score.p,
      tiers: { [def.tier]: tierScore } as Record<Tier, TierScore>,
      overall: tierScore,
    };
  }
  return out;
}

function runScenario(def: ScenarioDef): { python: string | null; ts: string | null } {
  assertLaneNamingConsistent(def);
  const nowMs = def.now ?? DEFAULT_NOW;
  const pythonScenario = buildPythonScenario(def, nowMs);
  const pythonResult = runPythonReference(pythonScenario);

  const models = def.models.map((model) => buildTsModel(model, def.tier));
  const descriptor: IssueDescriptor = {
    issueId: `equiv-${def.name}`,
    labelNames: [`tier:${def.tier}`],
    agentName: def.agent ?? null,
  };
  const profiles: VolumeProfile[] = [buildProfile(def.tier, nowMs)];
  const signals: QualitySignal[] = [];
  const laneLedger = buildLaneLedger(def);
  const modelScores = buildTsModelScores(def);

  const decision = selectModel({
    descriptor,
    profiles,
    signals,
    now: nowMs,
    config: {
      enforcementEnabled: true,
      defaultTier: def.tier,
      models,
      holdOnUntrustedProfile: true,
      stickyWithinIssue: false,
      pacingMode: "shadow",
      laneLedger,
      laneAvoidConfig: { defaultThreshold: 0.8, perLane: { codex: 0.99 } },
      codexLaneId: "codex",
      opencodeGoLaneId: "opencode-go",
      zaiLaneId: "zai",
      laneOutageOverride: def.laneOutage ?? null,
      laneRoom: {
        capPerAccount: LANE_CAP_PER_ACCOUNT,
        activePinsWeightByLane: Object.fromEntries(
          Object.entries(def.lanes ?? {}).map(([laneId, state]) => [laneId, state.activePinsWeight ?? 0]),
        ),
        fiveHourWindowName: "five_hour",
        zaiLaneId: "zai",
        zaiWeeklyWindowName: "weekly",
        zaiWeeklyDefaultMargin: ZAI_WEEKLY_MARGIN,
        zaiPaceOverrideMargin: def.zaiPaceOverrideMargin ?? null,
        now: nowMs,
      },
      modelScores,
      allowExplore: false,
    },
  });

  return { python: stripCliproxy(pythonResult.modelId), ts: decision.modelId };
}

const PEAK_NOW = Date.parse("2026-09-14T08:00:00.000Z"); // Monday 08:00 UTC — inside zai peak hours (06:00-10:00)
const OFF_PEAK_NOW = Date.parse("2026-09-14T12:00:00.000Z"); // same Monday, outside peak hours

const proven = (p = 0.9) => ({ capable: true, proven: true, p });
const unprovenCapable = (p = 0.9) => ({ capable: true, proven: false, p });

const SCENARIOS: ScenarioDef[] = [
  {
    name: "basic-cheapest-t3",
    tier: "T3",
    models: [
      { id: "claude-cheap-t3", costIn: 1, costOut: 5, laneId: "claude", score: proven() },
      { id: "claude-pricey-t3", costIn: 5, costOut: 25, laneId: "claude", score: proven() },
    ],
    lanes: { claude: {} },
  },
  {
    name: "basic-cheapest-t2",
    tier: "T2",
    models: [
      { id: "codex-cheap-t2", costIn: 3, costOut: 15, laneId: "codex", score: proven() },
      { id: "claude-pricey-t2", costIn: 10, costOut: 40, laneId: "claude", score: proven() },
    ],
    lanes: { codex: {}, claude: {} },
  },
  {
    name: "main-pool-includes-proven-and-unproven-above-free-floor",
    tier: "T2",
    models: [
      { id: "codex-cheap-unproven", costIn: 1, costOut: 1, laneId: "codex", score: unprovenCapable() },
      { id: "claude-pricier-proven", costIn: 5, costOut: 5, laneId: "claude", score: proven() },
    ],
    lanes: { codex: {}, claude: {} },
  },
  {
    name: "free-must-be-proven-excludes-cheap-unproven-free",
    tier: "T2",
    models: [
      { id: "zai/free-unproven", costIn: 0.05, costOut: 0.05, laneId: "zai", score: unprovenCapable() },
      { id: "codex-priced-proven", costIn: 2, costOut: 10, laneId: "codex", score: proven() },
    ],
    lanes: { zai: {}, codex: {} },
  },
  {
    name: "free-must-be-proven-admits-cheap-proven-free",
    tier: "T2",
    models: [
      { id: "zai/free-proven", costIn: 0.05, costOut: 0.05, laneId: "zai", score: proven() },
      { id: "codex-priced-proven-2", costIn: 2, costOut: 10, laneId: "codex", score: proven() },
    ],
    lanes: { zai: {}, codex: {} },
  },
  {
    name: "cost-band-prefers-less-utilized-lane",
    tier: "T2",
    models: [
      { id: "codex-cheapest-busy", costIn: 1, costOut: 1, laneId: "codex", score: proven() },
      { id: "claude-within-band-idle", costIn: 1.1, costOut: 1.1, laneId: "claude", score: proven() },
    ],
    lanes: { codex: { utilization: 0.7 }, claude: { utilization: 0.1 } },
  },
  {
    name: "cost-band-outside-band-cheapest-wins-anyway",
    tier: "T2",
    models: [
      { id: "codex-cheapest-busy-2", costIn: 1, costOut: 1, laneId: "codex", score: proven() },
      { id: "claude-outside-band-idle", costIn: 2, costOut: 2, laneId: "claude", score: proven() },
    ],
    lanes: { codex: { utilization: 0.7 }, claude: { utilization: 0.1 } },
  },
  {
    name: "capability-score-excludes-one-model",
    tier: "T1",
    models: [
      { id: "zai/cheap-not-capable", costIn: 1, costOut: 1, laneId: "zai", score: { capable: false, proven: true, p: 0.5 } },
      { id: "codex-pricier-capable", costIn: 5, costOut: 25, laneId: "codex", score: proven() },
    ],
    lanes: { zai: {}, codex: {} },
  },
  {
    // Deliberately NOT a "capability-score excludes every regular candidate,
    // no fallback exists" scenario: Python's `pick()` falls back to the
    // cheapest USABLE regular candidate regardless of capability in that
    // case (tier_dispatcher.py:220-222), while `select.ts`'s capability-score
    // gate is a hard, never-bypassed exclusion (see the comment at
    // select.ts:259-266) — a deliberate hardening documented
    // elsewhere, not a porting gap this harness needs to (or should) paper
    // over. This scenario instead exercises the ladder both engines agree
    // on: a fallback-only row is used, uncontested by capability, once every
    // regular candidate is excluded.
    name: "fallback-only-model-used-when-no-regular-capable",
    tier: "T2",
    models: [
      { id: "zai/regular-not-capable", costIn: 1, costOut: 1, laneId: "zai", score: { capable: false, proven: true, p: 0.5 } },
      { id: "codex-fallback-capable", costIn: 5, costOut: 25, laneId: "codex", fallbackOnly: true, score: proven() },
    ],
    lanes: { zai: {}, codex: {} },
  },
  {
    name: "lane-outage-active-excludes-model",
    tier: "T2",
    models: [
      { id: "codex-outaged-cheap", costIn: 1, costOut: 1, laneId: "codex", score: proven() },
      { id: "claude-healthy-pricier", costIn: 3, costOut: 15, laneId: "claude", score: proven() },
    ],
    lanes: { codex: {}, claude: {} },
    laneOutage: { lanes: ["codex"], models: [], until: "2026-09-11T00:00:00.000Z" },
  },
  {
    name: "lane-outage-expired-no-exclusion",
    tier: "T2",
    models: [
      { id: "codex-formerly-outaged-cheap", costIn: 1, costOut: 1, laneId: "codex", score: proven() },
      { id: "claude-healthy-pricier-2", costIn: 3, costOut: 15, laneId: "claude", score: proven() },
    ],
    lanes: { codex: {}, claude: {} },
    laneOutage: { lanes: ["codex"], models: [], until: "2026-09-09T00:00:00.000Z" },
  },
  {
    name: "avoid-default-threshold-excludes-busy-lane",
    tier: "T2",
    models: [
      { id: "claude-busy-cheap", costIn: 1, costOut: 1, laneId: "claude", score: proven() },
      { id: "codex-idle-pricier", costIn: 3, costOut: 15, laneId: "codex", score: proven() },
    ],
    lanes: { claude: { utilization: 0.85 }, codex: { utilization: 0.1 } },
  },
  {
    name: "avoid-lane-override-keeps-codex-admitted-at-0.85",
    tier: "T2",
    models: [
      { id: "codex-at-0.85", costIn: 1, costOut: 1, laneId: "codex", score: proven() },
      { id: "claude-fallback", costIn: 3, costOut: 15, laneId: "claude", score: proven() },
    ],
    lanes: { codex: { utilization: 0.85 }, claude: { utilization: 0.1 } },
  },
  {
    name: "lane-room-at-cap-excludes-go",
    tier: "T3",
    models: [
      { id: "flash-go-at-cap-go", costIn: 0.5, costOut: 0.5, laneId: "opencode-go", score: proven() },
      { id: "claude-fallback-choice", costIn: 1, costOut: 5, laneId: "claude", score: proven() },
    ],
    lanes: { "opencode-go": { accounts: 1, activePinsWeight: 2 }, claude: {} },
  },
  {
    name: "lane-room-under-cap-admits-go",
    tier: "T3",
    models: [
      { id: "flash-go-under-cap-go", costIn: 0.5, costOut: 0.5, laneId: "opencode-go", score: proven() },
      { id: "claude-pricier-choice", costIn: 1, costOut: 5, laneId: "claude", score: proven() },
    ],
    lanes: { "opencode-go": { accounts: 1, activePinsWeight: 1 }, claude: {} },
  },
  {
    name: "zai-weekly-pace-exceeded-excludes-zai",
    tier: "T2",
    models: [
      { id: "zai/over-pace", costIn: 0.5, costOut: 0.5, laneId: "zai", score: proven() },
      { id: "codex-fallback-2", costIn: 3, costOut: 15, laneId: "codex", score: proven() },
    ],
    lanes: {
      zai: { accounts: 1, zaiWeeklyUtil: 0.95, zaiWeeklyResetsAt: "2026-09-13T12:00:00.000Z" },
      codex: {},
    },
  },
  {
    name: "zai-peak-hour-throttle-excludes-with-one-active-pin",
    tier: "T2",
    now: PEAK_NOW,
    models: [
      { id: "zai/peak-throttled", costIn: 0.5, costOut: 0.5, laneId: "zai", score: proven() },
      { id: "codex-fallback-3", costIn: 3, costOut: 15, laneId: "codex", score: proven() },
    ],
    lanes: { zai: { accounts: 1, activePinsWeight: 1 }, codex: {} },
  },
  {
    name: "zai-off-peak-admits-active-1",
    tier: "T2",
    now: OFF_PEAK_NOW,
    models: [
      { id: "zai/off-peak", costIn: 0.5, costOut: 0.5, laneId: "zai", score: proven() },
      { id: "codex-pricier", costIn: 3, costOut: 15, laneId: "codex", score: proven() },
    ],
    lanes: { zai: { accounts: 1, activePinsWeight: 1 }, codex: {} },
  },
  {
    name: "t1-avoids-go-when-codex-has-room",
    tier: "T1",
    models: [
      { id: "flash-go-t1-cheap-go", costIn: 0.5, costOut: 0.5, laneId: "opencode-go", score: proven() },
      { id: "codex-t1-pricier", costIn: 10, costOut: 10, laneId: "codex", score: proven() },
    ],
    lanes: { "opencode-go": {}, codex: { utilization: 0.5 } },
  },
  {
    name: "zai-long-run-agent-avoid-when-codex-has-room",
    tier: "T1",
    agent: "CTO & Chief AI Officer",
    models: [
      { id: "zai/t1-cheap", costIn: 0.5, costOut: 0.5, laneId: "zai", score: proven() },
      { id: "codex-t1-pricier-2", costIn: 10, costOut: 10, laneId: "codex", score: proven() },
    ],
    lanes: { zai: { utilization: 0.3 }, codex: { utilization: 0.5 } },
  },
  {
    name: "no-usable-lane-returns-null",
    tier: "T2",
    models: [
      { id: "codex-dead-a", costIn: 1, costOut: 1, laneId: "codex", score: proven() },
      { id: "claude-dead-b", costIn: 2, costOut: 2, laneId: "claude", score: proven() },
    ],
    lanes: { codex: { serviceable: false }, claude: { serviceable: false } },
  },
  {
    // No prior scenario ever set `fiveHourUtil`, so
    // `lane_5h(lane) >= 0.5` (pick_reference.py:159) / the five-hour window
    // check inside `laneHasRoom()` (pacing.ts) was never exercised by this
    // harness. Named mutant: "5h stop dropped" — if that `>= 0.5` new-
    // admission check were deleted (or flipped to `> 0.5`, missing this exact
    // boundary), `flash-go-5h-blocked-go` would win on raw cost ($0.50/Mtok vs
    // claude's $1.25 blended) and both `python`/`ts` would read the go model
    // id instead of the claude fallback below — this test goes red the moment
    // that gate stops firing.
    name: "five-hour-window-new-admission-stop-excludes-go",
    tier: "T3",
    models: [
      { id: "flash-go-5h-blocked-go", costIn: 0.5, costOut: 0.5, laneId: "opencode-go", score: proven() },
      { id: "claude-5h-fallback-choice", costIn: 1, costOut: 5, laneId: "claude", score: proven() },
    ],
    lanes: { "opencode-go": { fiveHourUtil: 0.6 }, claude: {} },
  },
  {
    // Proves the fallback ladder does NOT silently land on
    // a lane that is itself over its own avoid threshold — every candidate
    // here (regular AND fallback-only) is over-avoid. Named mutant: "fallback
    // skips the avoid gate" — if the fallback-only branch of `select.ts`'s
    // model loop (or Python's `usable()` call inside the `for m in
    // sorted(fallback...)` loop) stopped checking `laneAvoidExcluded`/
    // `avoid_for()` for fallback-only rows, `codex-over-avoid-fallback` would
    // win despite its 0.995 utilization being over its own 0.99 threshold,
    // and both engines would return that id instead of null. See the
    // dedicated nullity assertion below this array.
    name: "all-lanes-over-avoid-fallback-never-lands-on-avoided-lane",
    tier: "T2",
    models: [
      { id: "claude-over-avoid-regular", costIn: 1, costOut: 1, laneId: "claude", score: proven() },
      { id: "codex-over-avoid-fallback", costIn: 5, costOut: 25, laneId: "codex", fallbackOnly: true, score: proven() },
    ],
    lanes: { claude: { utilization: 0.85 }, codex: { utilization: 0.995 } },
  },
];

describe("Task #10: pick_reference.py vs selectModel() equivalence", () => {
  it("covers at least 20 scenarios", () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(20);
  });

  for (const scenario of SCENARIOS) {
    it(`${scenario.name}: identical decision`, () => {
      const { python, ts } = runScenario(scenario);
      expect(ts).toBe(python);
    });
  }

  it("Fix 2/4: all-lanes-over-avoid-fallback-never-lands-on-avoided-lane resolves to no usable model on both engines, not merely to matching engines", () => {
    // The loop above only proves python === ts; it cannot by itself catch
    // both engines agreeing on the SAME wrong over-avoid lane. Assert the
    // stronger, specific property the issue asked for directly.
    const scenario = SCENARIOS.find((s) => s.name === "all-lanes-over-avoid-fallback-never-lands-on-avoided-lane")!;
    const { python, ts } = runScenario(scenario);
    expect(python).toBeNull();
    expect(ts).toBeNull();
  });
});
