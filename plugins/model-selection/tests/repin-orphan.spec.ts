import { describe, expect, it } from "vitest";

import { resolveConfig } from "../src/config/resolve.js";
import {
  resolveRunDecision,
  type ResolveRunModelParams,
  type RunResolveInput,
  type RunResolveSnapshot,
} from "../src/engine/run-resolve.js";
import type { LaneLedger } from "./run-resolve-helpers.js";
import { MODELS, NOW, PROFILES, NO_ESCALATION } from "./fixtures.js";

const LANES = { haiku: "lane-haiku", sonnet: "lane-sonnet", opus: "lane-opus" };

function roster(overrides: Record<string, Record<string, unknown>> = {}) {
  const laneById: Record<string, string> = {
    "claude-haiku-4-5-20251001": LANES.haiku,
    "claude-sonnet-5": LANES.sonnet,
    "claude-opus-5": LANES.opus,
  };
  return MODELS.map((model) => ({ ...model, laneId: laneById[model.id], ...(overrides[model.id] ?? {}) }));
}

function snapshot(
  options: { ledger?: LaneLedger; models?: ReturnType<typeof roster>; selection?: Record<string, unknown> } = {},
): RunResolveSnapshot {
  const config = resolveConfig({
    selection: { enabled: true, mode: "enforce", holdOnUntrustedProfile: true, ...(options.selection ?? {}) },
    models: options.models ?? roster(),
    runResolve: { enabled: true },
  });
  return {
    config,
    profiles: PROFILES,
    signals: NO_ESCALATION,
    laneLedger: options.ledger ?? {},
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

function input(overrides: Partial<RunResolveInput> & { tier?: "T1" | "T2" | "T3" | null } = {}): RunResolveInput {
  const { tier, ...rest } = overrides;
  const labelNames = tier === null ? [] : [`tier:${tier ?? "T2"}`];
  return {
    params: params(),
    issue: { labelNames, priority: null, title: "A card", status: "todo" },
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

function decided(resolution: ReturnType<typeof resolveRunDecision>) {
  if (resolution.kind !== "decide") throw new Error(`expected decide, got ${JSON.stringify(resolution)}`);
  return resolution;
}

describe(" repin orphan guard: an override whose model is gone from the roster", () => {
  it("keeps a run whose override names an enabled roster row", () => {
    const resolution = resolveRunDecision(input({ params: params({ issueOverrideModel: "claude-opus-5" }) }));
    expect(resolution.kind).toBe("keep");
  });

  it("drops an override naming a model absent from the roster and decides fresh", () => {
    // The bridge-model shape: the card was pinned while the row existed, then
    // the row was retired. The T2 card must fall through to the fresh pick
    // (sonnet), never keep the orphan.
    const models = roster().filter((model) => model.id !== "claude-opus-5");
    const resolution = decided(
      resolveRunDecision(
        input({
          snapshot: snapshot({ models }),
          params: params({ issueOverrideModel: "claude-opus-5" }),
        }),
      ),
    );
    expect(resolution.result.model).toBe("claude-sonnet-5");
    expect(resolution.switch?.reason).toBe("first-decision");
  });

  it("drops an override naming a disabled roster row and decides fresh", () => {
    const models = roster({ "claude-opus-5": { enabled: false } });
    const resolution = decided(
      resolveRunDecision(
        input({
          snapshot: snapshot({ models }),
          params: params({ issueOverrideModel: "claude-opus-5" }),
        }),
      ),
    );
    expect(resolution.result.model).toBe("claude-sonnet-5");
    expect(resolution.switch?.reason).toBe("first-decision");
  });
});
