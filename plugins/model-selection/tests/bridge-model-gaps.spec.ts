import { describe, expect, it } from "vitest";

import { parseAaFreeList } from "../src/aa-free/parse.js";
import { AaEffortRegistry } from "../src/aa-free/registry.js";
import { resolveConfig } from "../src/config/resolve.js";
import { resolveConfiguredModelId } from "../src/engine/model-id.js";
import {
  resolveRunDecision,
  type ResolveRunModelParams,
  type RunDecisionRecord,
  type RunResolveInput,
  type RunResolveSnapshot,
} from "../src/engine/run-resolve.js";
import type { LaneLedger } from "./run-resolve-helpers.js";
import type { ModelEntry } from "../src/engine/types.js";
import { legacyBody } from "./aa-free/fixture.js";
import { MODELS, NOW, PROFILES, NO_ESCALATION } from "./fixtures.js";

/**
 * bridge-model roster resolution gaps (parent epic ).
 *
 * The 60s bridge timer chooses one of three models the reviewed roster (on
 * main) carries no enabled row for: the MUSE form with a parenthesized effort
 * (`muse-spark-1.3-contributor(xhigh)`), `claude-sonnet-5-5`, and
 * `gpt-6.1-sol`. These specs pin the three safe-handling behaviors that must
 * hold with or without those rows: exact resolution (never a guess),
 * fallback to a rostered pick (never echoing an unrostered id), and no
 * quota-consuming work on the resolution path.
 *
 * Pure unit tests only: no live dispatch, no pin/floor writes, no quota
 * figures, no network. Every input is inline; nothing reads the live board.
 */

// Bridge ids exactly as the bridge timer logs them.
const MUSE_BRIDGE = "muse-spark-1.3-contributor(xhigh)";
const MUSE_BARE = "muse-spark-1.3-contributor";
const SONNET_BRIDGE = "claude-sonnet-5-5";
const SOL_BRIDGE = "gpt-6.1-sol";

function bridgeModel(id: string, tier: ModelEntry["tier"]): ModelEntry {
  return {
    id,
    tier,
    enabled: true,
    costPerMTokIn: 1,
    costPerMTokOut: 5,
    costPerMTokCacheRead: 0.1,
    capabilities: ["tools"],
    contextWindow: 1_000_000,
    aaIndex: null,
    releasedAt: "2026-06-24",
    fallbackOnly: false,
    note: "",
    earnIn: null,
  };
}

const BRIDGE_ROSTER: ModelEntry[] = [
  bridgeModel(MUSE_BARE, "T3"),
  bridgeModel(SONNET_BRIDGE, "T2"),
  bridgeModel(SOL_BRIDGE, "T1"),
];

describe("bridge-model gaps: resolution", () => {
  it("resolves each bare bridge id exactly when the roster carries it", () => {
    expect(resolveConfiguredModelId(MUSE_BARE, BRIDGE_ROSTER)).toBe(MUSE_BARE);
    expect(resolveConfiguredModelId(SONNET_BRIDGE, BRIDGE_ROSTER)).toBe(SONNET_BRIDGE);
    expect(resolveConfiguredModelId(SOL_BRIDGE, BRIDGE_ROSTER)).toBe(SOL_BRIDGE);
  });

  it("maps the legacy cliproxy/ wrapper to the exact bridge roster id", () => {
    expect(resolveConfiguredModelId(`cliproxy/${SONNET_BRIDGE}`, BRIDGE_ROSTER)).toBe(SONNET_BRIDGE);
    expect(resolveConfiguredModelId(`cliproxy/${SOL_BRIDGE}`, BRIDGE_ROSTER)).toBe(SOL_BRIDGE);
  });

  it("never strips the parenthesized effort: the MUSE bridge form does not resolve", () => {
    // The bridge logs `muse-spark-1.3-contributor(xhigh)`; roster ids never
    // carry `(effort)`. Resolving by suffix-guess would silently move the
    // run to a different effort's evidence, so this must stay null until a
    // caller maps the effort explicitly.
    expect(resolveConfiguredModelId(MUSE_BRIDGE, BRIDGE_ROSTER)).toBeNull();
    expect(resolveConfiguredModelId(MUSE_BRIDGE, [])).toBeNull();
  });

  it("fails closed on a bridge id the roster does not carry", () => {
    expect(resolveConfiguredModelId(SONNET_BRIDGE, [])).toBeNull();
    expect(resolveConfiguredModelId(SOL_BRIDGE, MODELS)).toBeNull();
    expect(resolveConfiguredModelId("gpt-6.1-sol(xhigh)", BRIDGE_ROSTER)).toBeNull();
  });
});

const LANES = { haiku: "lane-haiku", sonnet: "lane-sonnet", opus: "lane-opus" };

function roster(): ModelEntry[] {
  const laneById: Record<string, string> = {
    "claude-haiku-4-5-20251001": LANES.haiku,
    "claude-sonnet-5": LANES.sonnet,
    "claude-opus-5": LANES.opus,
  };
  return MODELS.map((model) => ({ ...model, laneId: laneById[model.id] }));
}

function snapshot(models: ModelEntry[] = roster(), ledger: LaneLedger = {}): RunResolveSnapshot {
  const config = resolveConfig({
    selection: { enabled: true, mode: "enforce", holdOnUntrustedProfile: true },
    models,
    runResolve: { enabled: true },
  });
  return {
    config,
    profiles: PROFILES,
    signals: NO_ESCALATION,
    laneLedger: ledger,
    operatorOverrides: {},
    cardLedger: {},
    modelScores: {},
    laneOutageOverride: null,
    zaiPaceOverride: null,
    pinsWeightByLane: {},
    availabilityRaw: null,
    laneEvidence: { lanes: [], windowHours: 24, unreadableReason: null },
    loadedAtMs: NOW,
  };
}

function params(overrides: Partial<ResolveRunModelParams> = {}): ResolveRunModelParams {
  return {
    runId: "run-2",
    companyId: "co-1",
    agentId: "agent-1",
    issueId: "issue-1",
    adapterType: "claude_local",
    invocationSource: "assignment",
    wakeReason: null,
    agentDefaultModel: "claude-haiku-4-5-20251001",
    previous: null,
    issueOverrideModel: null,
    deadlineMs: 1500,
    ...overrides,
  };
}

function input(overrides: Partial<RunResolveInput> & { tier?: "T1" | "T2" | "T3" } = {}): RunResolveInput {
  const { tier, ...rest } = overrides;
  return {
    params: params(),
    issue: { labelNames: [`tier:${tier ?? "T2"}`], priority: null, title: "A card", status: "todo" },
    agent: { name: "Founding Engineer", adapterConfig: {} },
    snapshot: snapshot(),
    prior: null,
    classifiedTier: null,
    lastRunPeakTokens: null,
    now: NOW,
    newDecisionId: () => "decision-fixed",
    ...rest,
  };
}

const prior = (record: Partial<RunDecisionRecord> & Pick<RunDecisionRecord, "model">): RunDecisionRecord => ({
  decisionId: "decision-prev",
  tier: "T2",
  fallback: false,
  ...record,
});

const ROSTER_IDS = ["claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-5"];

describe("bridge-model gaps: fallback", () => {
  it("never echoes an unrostered bridge previous: falls back to the tier pick", () => {
    const resolution = resolveRunDecision(
      input({
        params: params({ previous: { runId: "run-1", model: SONNET_BRIDGE, decisionId: "decision-prev" } }),
        prior: prior({ model: SONNET_BRIDGE }),
      }),
    );
    expect(resolution.kind).toBe("decide");
    if (resolution.kind !== "decide") return;
    expect(ROSTER_IDS).toContain(resolution.result.model);
    expect(resolution.result.model).not.toBe(SONNET_BRIDGE);
    expect(resolution.result.model).toBe("claude-sonnet-5");
  });

  it("an unrostered bridge id at T1 still decides a rostered T1 model", () => {
    const resolution = resolveRunDecision(
      input({
        tier: "T1",
        params: params({ previous: { runId: "run-1", model: SOL_BRIDGE, decisionId: "decision-prev" } }),
        prior: prior({ model: SOL_BRIDGE, tier: "T1" }),
      }),
    );
    expect(resolution.kind).toBe("decide");
    if (resolution.kind !== "decide") return;
    expect(ROSTER_IDS).toContain(resolution.result.model);
    expect(resolution.result.model).not.toBe(SOL_BRIDGE);
  });
});

describe("bridge-model gaps: no quota use", () => {
  const emptySnapshot = parseAaFreeList(legacyBody([]), "2026-10-03T00:00:00Z")!;
  const registry = new AaEffortRegistry([]);

  it("an unbound bridge model+lane is ineligible synchronously — no probe, no dispatch", () => {
    const identity = { requestedEffort: "xhigh", effectiveEffort: "xhigh", observedServedEffort: null } as const;
    const first = registry.lookup(emptySnapshot, { modelId: MUSE_BARE, laneId: "lane-meta", identity });
    expect(first).toMatchObject({ status: "ineligible", reason: "no-binding", candidateId: null });
    expect(first).not.toBeInstanceOf(Promise);
    // Deterministic: a second call reads no hidden quota state.
    expect(registry.lookup(emptySnapshot, { modelId: MUSE_BARE, laneId: "lane-meta", identity })).toEqual(first);
  });

  it("resolution is pure: frozen roster, same answer twice, nothing mutated", () => {
    const frozen = Object.freeze(BRIDGE_ROSTER.map((m) => Object.freeze({ ...m })));
    const before = JSON.stringify(frozen);
    expect(resolveConfiguredModelId(SONNET_BRIDGE, frozen)).toBe(SONNET_BRIDGE);
    expect(resolveConfiguredModelId(SONNET_BRIDGE, frozen)).toBe(SONNET_BRIDGE);
    expect(JSON.stringify(frozen)).toBe(before);
  });

  it("the run-decision fallback path is synchronous — it cannot await a live dispatch", () => {
    const resolution = resolveRunDecision(
      input({
        params: params({ previous: { runId: "run-1", model: SONNET_BRIDGE, decisionId: "decision-prev" } }),
        prior: prior({ model: SONNET_BRIDGE }),
      }),
    );
    expect(resolution).not.toBeInstanceOf(Promise);
  });
});
