import { describe, expect, it } from "vitest";

import { resolveConfig } from "../src/config/resolve.js";
import {
  RUN_RESOLVE_ENV_KEYS,
  resolveRunDecision,
  runDecisionEnv,
  type ResolveRunModelParams,
  type RunDecisionRecord,
  type RunResolveInput,
  type RunResolveSnapshot,
} from "../src/engine/run-resolve.js";
import { stoppedLane, type LaneLedger } from "./run-resolve-helpers.js";
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

const prior = (record: Partial<RunDecisionRecord> & Pick<RunDecisionRecord, "model">): RunDecisionRecord => ({
  decisionId: "decision-prev",
  tier: "T2",
  fallback: false,
  ...record,
});

function decided(resolution: ReturnType<typeof resolveRunDecision>) {
  if (resolution.kind !== "decide") throw new Error(`expected decide, got ${JSON.stringify(resolution)}`);
  return resolution;
}

describe("run-scoped decision (TOG-11793)", () => {
  it("decides a first run from the tier label, recording the first decision", () => {
    const resolution = decided(resolveRunDecision(input()));
    expect(resolution.result.model).toBe("claude-sonnet-5");
    expect(resolution.result.decisionId).toBe("decision-fixed");
    expect(resolution.result.tier).toBe("T2");
    expect(resolution.tierSource).toBe("label");
    expect(resolution.switch).toMatchObject({ reason: "first-decision", to: "claude-sonnet-5" });
    expect(resolution.result.fallback).toBeUndefined();
  });

  describe("sticky rule matrix", () => {
    it("serviceable: keeps the previous run's model and records no switch", () => {
      const resolution = decided(
        resolveRunDecision(
          input({
            params: params({ previous: { runId: "run-1", model: "claude-sonnet-5", decisionId: "decision-prev" } }),
            prior: prior({ model: "claude-sonnet-5" }),
          }),
        ),
      );
      expect(resolution.result.model).toBe("claude-sonnet-5");
      expect(resolution.switch).toBeNull();
      expect(resolution.result.reason).toContain("sticky");
    });

    it("serviceable: keeps a pricier incumbent over a cheaper fresh pick of the same tier", () => {
      // opus is T1; at a T2 card the fresh pick is the cheaper sonnet, but the
      // warm session on opus (tier unchanged, lane serviceable) must stay.
      const resolution = decided(
        resolveRunDecision(
          input({
            params: params({ previous: { runId: "run-1", model: "claude-opus-5", decisionId: "decision-prev" } }),
            prior: prior({ model: "claude-opus-5", tier: "T2" }),
          }),
        ),
      );
      expect(resolution.result.model).toBe("claude-opus-5");
      expect(resolution.switch).toBeNull();
    });

    it("unserviceable: switches off a model whose lane has stopped, with the reason", () => {
      const ledger: LaneLedger = { [LANES.sonnet]: stoppedLane(LANES.sonnet) };
      const resolution = decided(
        resolveRunDecision(
          input({
            snapshot: snapshot({ ledger }),
            params: params({ previous: { runId: "run-1", model: "claude-sonnet-5", decisionId: "decision-prev" } }),
            prior: prior({ model: "claude-sonnet-5" }),
          }),
        ),
      );
      expect(resolution.result.model).toBe("claude-opus-5");
      expect(resolution.switch).toMatchObject({
        from: "claude-sonnet-5",
        to: "claude-opus-5",
        reason: "unserviceable",
      });
      expect(resolution.switch?.detail).toContain("lane-unserviceable");
      // Escalated off the T2 judgement: a fallback, which the next run revisits.
      expect(resolution.result.fallback).toBe(true);
      expect(resolution.result.tier).toBe("T2");
    });

    it("fallback with the primary serviceable again: switches back and says so", () => {
      const resolution = decided(
        resolveRunDecision(
          input({
            params: params({ previous: { runId: "run-1", model: "claude-opus-5", decisionId: "decision-prev" } }),
            prior: prior({ model: "claude-opus-5", tier: "T2", fallback: true }),
          }),
        ),
      );
      expect(resolution.result.model).toBe("claude-sonnet-5");
      expect(resolution.switch).toMatchObject({ from: "claude-opus-5", to: "claude-sonnet-5", reason: "primary-recovered" });
      expect(resolution.result.fallback).toBeUndefined();
    });

    it("fallback with the primary still down: stays on the fallback", () => {
      const ledger: LaneLedger = { [LANES.sonnet]: stoppedLane(LANES.sonnet) };
      const resolution = decided(
        resolveRunDecision(
          input({
            snapshot: snapshot({ ledger }),
            params: params({ previous: { runId: "run-1", model: "claude-opus-5", decisionId: "decision-prev" } }),
            prior: prior({ model: "claude-opus-5", tier: "T2", fallback: true }),
          }),
        ),
      );
      expect(resolution.result.model).toBe("claude-opus-5");
      expect(resolution.switch).toBeNull();
      expect(resolution.result.fallback).toBe(true);
    });

    it("tier raised: switches up and records the tier change", () => {
      const resolution = decided(
        resolveRunDecision(
          input({
            tier: "T1",
            params: params({ previous: { runId: "run-1", model: "claude-sonnet-5", decisionId: "decision-prev" } }),
            prior: prior({ model: "claude-sonnet-5", tier: "T2" }),
          }),
        ),
      );
      expect(resolution.result.model).toBe("claude-opus-5");
      expect(resolution.switch).toMatchObject({ reason: "tier-changed", from: "claude-sonnet-5", to: "claude-opus-5" });
      expect(resolution.switch?.detail).toContain("T2 -> T1");
    });

    it("tier lowered: switches down too — a changed tier is a switch in either direction", () => {
      const resolution = decided(
        resolveRunDecision(
          input({
            tier: "T3",
            params: params({ previous: { runId: "run-1", model: "claude-opus-5", decisionId: "decision-prev" } }),
            prior: prior({ model: "claude-opus-5", tier: "T1" }),
          }),
        ),
      );
      expect(resolution.result.model).toBe("claude-haiku-4-5-20251001");
      expect(resolution.switch).toMatchObject({ reason: "tier-changed", to: "claude-haiku-4-5-20251001" });
    });

    it("tier changed but the fresh pick is the same model: no switch is recorded", () => {
      const resolution = decided(
        resolveRunDecision(
          input({
            tier: "T1",
            params: params({ previous: { runId: "run-1", model: "claude-opus-5", decisionId: "decision-prev" } }),
            prior: prior({ model: "claude-opus-5", tier: "T2" }),
          }),
        ),
      );
      expect(resolution.result.model).toBe("claude-opus-5");
      expect(resolution.switch).toBeNull();
    });

    it("a prior record without a tier cannot fire the tier-change switch", () => {
      const resolution = decided(
        resolveRunDecision(
          input({
            tier: "T1",
            params: params({ previous: { runId: "run-1", model: "claude-sonnet-5", decisionId: "decision-prev" } }),
            // The degraded prior: the model the previous run reported, tier unknown.
            prior: prior({ model: "claude-sonnet-5", tier: null }),
          }),
        ),
      );
      // Sticky on tier alone is declined by the engine's own tier-floor gate
      // (sonnet is below T1), so the move still happens — as unserviceable.
      expect(resolution.switch?.reason).toBe("unserviceable");
      expect(resolution.result.model).toBe("claude-opus-5");
    });
  });

  describe("tier", () => {
    it("without a label, uses the deterministic heuristic and says so", () => {
      const resolution = decided(resolveRunDecision(input({ tier: null })));
      expect(resolution.tierSource).toBe("heuristic");
      // The agent floor is the T3 model: the heuristic judges T3.
      expect(resolution.tier).toBe("T3");
      expect(resolution.result.source).toBe("model-selection:heuristic");
    });

    it("uses a classification that finished while the hook waited", () => {
      const resolution = decided(resolveRunDecision(input({ tier: null, classifiedTier: "T1" })));
      expect(resolution.tierSource).toBe("classifier");
      expect(resolution.tier).toBe("T1");
      expect(resolution.result.model).toBe("claude-opus-5");
    });

    it("a label wins over a classification result", () => {
      const resolution = decided(resolveRunDecision(input({ tier: "T3", classifiedTier: "T1" })));
      expect(resolution.tierSource).toBe("label");
      expect(resolution.tier).toBe("T3");
    });
  });

  describe("outcomes the host must not read as a default", () => {
    it("nothing serviceable at any rung: defer, never a model", () => {
      const ledger: LaneLedger = {
        [LANES.sonnet]: stoppedLane(LANES.sonnet),
        [LANES.opus]: stoppedLane(LANES.opus),
      };
      const resolution = resolveRunDecision(input({ snapshot: snapshot({ ledger }) }));
      expect(resolution.kind).toBe("defer");
    });

    it("a company with no roster answers keep (the router is not configured)", () => {
      expect(resolveRunDecision(input({ snapshot: snapshot({ models: [] }) })).kind).toBe("keep");
    });

    it("an issue that already carries an override model is left alone", () => {
      const resolution = resolveRunDecision(input({ params: params({ issueOverrideModel: "claude-opus-5" }) }));
      expect(resolution.kind).toBe("keep");
    });

    it("a non-issue run is left alone", () => {
      expect(resolveRunDecision(input({ params: params({ issueId: null }) })).kind).toBe("keep");
    });
  });

  describe("env allowlist", () => {
    const agentEnv = {
      GH_TOKEN: { type: "secret_ref", secretId: "s-1", version: "latest" },
      ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "s-2", version: "latest" },
      PLAIN_AGENT_VAR: { type: "plain", value: "x" },
      ANTHROPIC_DEFAULT_SONNET_MODEL: { type: "plain", value: "old" },
    };

    it("returns only declared plugin keys, as plain strings, and never an agent env key", () => {
      const resolution = decided(
        resolveRunDecision(input({ agent: { name: "FE", adapterConfig: { env: agentEnv } } })),
      );
      const env = resolution.result.env ?? {};
      expect(Object.keys(env).length).toBeGreaterThan(0);
      for (const [key, value] of Object.entries(env)) {
        expect(RUN_RESOLVE_ENV_KEYS).toContain(key);
        expect(typeof value).toBe("string");
      }
      for (const forbidden of ["GH_TOKEN", "ANTHROPIC_API_KEY", "PLAIN_AGENT_VAR"]) {
        expect(env).not.toHaveProperty(forbidden);
      }
      expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-5");
    });

    it("skips a declared key the agent binds to a secret, instead of letting the host refuse the decision", () => {
      const env = runDecisionEnv({
        model: { id: "claude-sonnet-5", contextWindow: 1_000_000 },
        cheapModelId: "claude-haiku-4-5-20251001",
        adapterType: "claude_local",
        agentEnv: { ANTHROPIC_DEFAULT_SONNET_MODEL: { type: "secret_ref", secretId: "s-9", version: "latest" } },
        agentEnvContextTokens: 200_000,
        compactionRatio: 0.75,
      });
      expect(env).not.toHaveProperty("ANTHROPIC_DEFAULT_SONNET_MODEL");
      expect(env.PAPERCLIP_ASSIGNED_MODEL).toBe("claude-sonnet-5");
      expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe("claude-haiku-4-5-20251001");
    });

    it("stamps the context cap only for a window below the agent cap", () => {
      const small = runDecisionEnv({
        model: { id: "m", contextWindow: 128_000 },
        cheapModelId: null,
        adapterType: "claude_local",
        agentEnv: {},
        agentEnvContextTokens: 200_000,
        compactionRatio: 0.75,
      });
      expect(small.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("128000");
      const large = runDecisionEnv({
        model: { id: "m", contextWindow: 1_000_000 },
        cheapModelId: null,
        adapterType: "claude_local",
        agentEnv: {},
        agentEnvContextTokens: 200_000,
        compactionRatio: 0.75,
      });
      expect(large).not.toHaveProperty("CLAUDE_CODE_MAX_CONTEXT_TOKENS");
    });

    it("writes no model env for an adapter-blocked model", () => {
      const env = runDecisionEnv({
        model: { id: "devin/swe", contextWindow: 1_000_000 },
        cheapModelId: null,
        adapterType: "claude_local",
        agentEnv: {},
        agentEnvContextTokens: 200_000,
        compactionRatio: 0.75,
      });
      expect(env).toEqual({});
    });
  });

  describe("effort", () => {
    it("carries a roster effort for the adapter whose key is `effort`", () => {
      const models = roster({ "claude-sonnet-5": { effort: "high" } });
      const resolution = decided(resolveRunDecision(input({ snapshot: snapshot({ models }) })));
      expect(resolution.result.effort).toBe("high");
    });

    it("never invents the single `effort` key for another adapter", () => {
      const models = roster({ "claude-sonnet-5": { effort: "high" } });
      const resolution = decided(
        resolveRunDecision(
          input({ snapshot: snapshot({ models }), params: params({ adapterType: "codex_local" }) }),
        ),
      );
      expect(resolution.result.effort).toBeUndefined();
    });
  });

  it("decides for a wake that carries a wake reason without forcing it advisory", () => {
    const resolution = decided(resolveRunDecision(input({ params: params({ wakeReason: "monitor" }) })));
    expect(resolution.result.model).toBe("claude-sonnet-5");
  });
});
