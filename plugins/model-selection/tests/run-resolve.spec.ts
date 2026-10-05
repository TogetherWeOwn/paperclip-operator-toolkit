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
import { LANED_MODELS, MODELS, NOW, PROFILES, NO_ESCALATION, account, laneDoc } from "./fixtures.js";

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
  options: {
    ledger?: LaneLedger;
    models?: readonly Record<string, unknown>[];
    selection?: Record<string, unknown>;
    /** The published lane-availability document as the worker loads it; `null` = nothing published. */
    availabilityRaw?: unknown;
  } = {},
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
    availabilityRaw: options.availabilityRaw ?? null,
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

describe("run-scoped decision ()", () => {
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

/**
 * The sticky rule against the published quota document.
 *
 * Every other case in this file builds its snapshot with `availabilityRaw:
 * null`, so the lane-availability term was never part of a sticky decision: a
 * resolver that ignored the document passed all of them. `tests/availability.
 * spec.ts` covers the term through `selectModel` with a fresh pick, not through
 * the keep-or-switch rule that decides an enforced run (the stale-pin shape of
 * ).
 *
 * Roster (`LANED_MODELS`): haiku is the only T3 row and sits alone on lane
 * `zai`; sonnet (T2) and opus (T1) share `claude`. The incumbent is haiku on a
 * `tier:T3` card, so a `zai` outage is a one-lane event with an unambiguous
 * escalation target (sonnet), and a `zai` state that must NOT move the card
 * leaves haiku in place.
 *
 * Each excluded state is paired with a healthy control decided under the same
 * `holdOnUnknownAvailability` setting: a resolver that fails closed on every
 * document would pass the excluded half alone.
 */
describe("sticky rule against the published quota document ()", () => {
  const HAIKU = "claude-haiku-4-5-20251001";
  const SONNET = "claude-sonnet-5";
  const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
  const MINUTE = 60_000;

  /** Both lanes' accounts, `zaiOverrides` applied to `zai` only, `allOverrides` to every account. */
  function fleet(
    zaiOverrides: Record<string, unknown> = {},
    options: { observedAt?: string; allOverrides?: Record<string, unknown> } = {},
  ) {
    const all = options.allOverrides ?? {};
    return laneDoc(
      [
        ...["claude-a", "claude-b"].map((key) => account("claude", key, all)),
        ...["zai-a", "zai-b"].map((key) => account("zai", key, { ...all, ...zaiOverrides })),
      ],
      options.observedAt,
    );
  }

  const healthy = () => fleet();

  /** The zai account windows with the five-hour serviceability window at `utilization`. */
  const zaiWindows = (utilization: number) => ({
    windows: [
      {
        name: "five_hour",
        role: "serviceability",
        utilization,
        resets_at: at(60 * MINUTE),
        window_seconds: 18_000,
        allowance_weight: 1,
      },
      {
        name: "weekly",
        role: "allowance",
        utilization: 0.5,
        resets_at: at(48 * 60 * MINUTE),
        window_seconds: 604_800,
        allowance_weight: 1,
      },
    ],
  });

  /** Decide a `tier:T3` run whose previous routed model was haiku, against the given document. */
  function decideSticky(availabilityRaw: unknown, holdOnUnknownAvailability: boolean, now: number = NOW) {
    return resolveRunDecision(
      input({
        tier: "T3",
        now,
        snapshot: snapshot({
          models: LANED_MODELS as unknown as Record<string, unknown>[],
          availabilityRaw,
          selection: { holdOnUnknownAvailability },
        }),
        params: params({ previous: { runId: "run-1", model: HAIKU, decisionId: "decision-prev" } }),
        prior: prior({ model: HAIKU, tier: "T3" }),
      }),
    );
  }

  function expectKeptHaiku(resolution: ReturnType<typeof resolveRunDecision>) {
    const decision = decided(resolution);
    expect(decision.result.model).toBe(HAIKU);
    expect(decision.switch).toBeNull();
    expect(decision.result.reason).toBe(`sticky: ${HAIKU} still serviceable at T3`);
    expect(decision.result.fallback).toBeUndefined();
  }

  function expectSwitchedToSonnet(resolution: ReturnType<typeof resolveRunDecision>, detailPrefix: string) {
    const decision = decided(resolution);
    expect(decision.result.model).toBe(SONNET);
    expect(decision.switch).toMatchObject({ from: HAIKU, to: SONNET, reason: "unserviceable" });
    expect(decision.switch?.detail).toContain(detailPrefix);
    expect(decision.result.reason).toBe(`unserviceable: ${decision.switch?.detail}`);
    // Escalated off the T3 judgement: a fallback the next run revisits, and the
    // judged tier stays T3 so the escalation is not read as a tier change.
    expect(decision.result.fallback).toBe(true);
    expect(decision.result.tier).toBe("T3");
  }

  function expectHeldAtFloor(resolution: ReturnType<typeof resolveRunDecision>, because: string) {
    expect(resolution.kind).toBe("keep");
    if (resolution.kind !== "keep") return;
    expect(resolution.reason).toMatch(/^held-at-floor: .*UNKNOWN/);
    expect(resolution.reason).toContain(because);
  }

  describe.each([false, true])("known lane state, holdOnUnknownAvailability=%s", (hold) => {
    it("exhausted window on the incumbent's lane: switches off it, naming the quota", () => {
      expectKeptHaiku(decideSticky(healthy(), hold));
      expectSwitchedToSonnet(decideSticky(fleet(zaiWindows(1)), hold), "lane-availability: quota");
    });

    it("window at 0.99 is still serviceable: no switch", () => {
      // The near-miss half of the exhausted pair: the term trips at utilization
      // 1.0 (`availability.ts`), it is not "any busy window".
      expectKeptHaiku(decideSticky(fleet(zaiWindows(0.99)), hold));
    });

    it("live cooldown on the incumbent's lane: switches off it, naming the cooldown", () => {
      const cooling = fleet({ cooldown: { until: at(10 * MINUTE), reason: "rate limit" } });
      expectKeptHaiku(decideSticky(healthy(), hold));
      expectSwitchedToSonnet(decideSticky(cooling, hold), "lane-availability: cooldown");
    });

    it("expired cooldown: the incumbent stays, no switch", () => {
      const expired = fleet({ cooldown: { until: at(-MINUTE), reason: "expired" } });
      expectKeptHaiku(decideSticky(healthy(), hold));
      expectKeptHaiku(decideSticky(expired, hold));
    });

    it("an exhausted OTHER lane does not move an incumbent that is not on it", () => {
      // Cross-lane control: `claude` is dead, haiku sits on `zai`.
      const claudeDead = laneDoc([
        ...["claude-a", "claude-b"].map((key) => account("claude", key, zaiWindows(1))),
        ...["zai-a", "zai-b"].map((key) => account("zai", key)),
      ]);
      expectKeptHaiku(decideSticky(claudeDead, hold));
    });
  });

  describe("unknown lane state: the incumbent follows holdOnUnknownAvailability", () => {
    it("document past the shared 120-minute cutoff: kept silently with the hold off, parked at the floor with it on", () => {
      // `stale_after_seconds` is raised so the 120-minute floor, not a record's
      // own tighter cutoff, is what separates the 119- and 121-minute documents.
      const aged = (minutes: number) =>
        fleet({}, { observedAt: at(-minutes * MINUTE), allOverrides: { stale_after_seconds: 86_400 } });

      for (const hold of [false, true]) {
        expectKeptHaiku(decideSticky(aged(119), hold)); // control: inside the cutoff, readable
      }
      expectKeptHaiku(decideSticky(aged(121), false));
      expectHeldAtFloor(decideSticky(aged(121), true), "exceeds the");
    });

    it("a record's own tighter stale_after_seconds makes an otherwise recent document unknown", () => {
      const tight = fleet({}, { observedAt: at(-10 * MINUTE), allOverrides: { stale_after_seconds: 300 } });
      expectKeptHaiku(decideSticky(tight, false));
      expectHeldAtFloor(decideSticky(tight, true), "exceeds the");
      // Control: the same records, observed a minute ago.
      expectKeptHaiku(
        decideSticky(fleet({}, { observedAt: at(-MINUTE), allOverrides: { stale_after_seconds: 300 } }), true),
      );
    });

    it("future-dated document: kept with the hold off, parked at the floor with it on", () => {
      const future = fleet({}, { observedAt: at(3 * 60 * MINUTE) });
      for (const hold of [false, true]) {
        expectKeptHaiku(decideSticky(healthy(), hold)); // control: a document observed in the past
      }
      expectKeptHaiku(decideSticky(future, false));
      expectHeldAtFloor(decideSticky(future, true), "observation is in the future");
    });

    it.each([
      ["no document published (null)", null, "availability document is not an object"],
      ["a string", "nope", "availability document is not an object"],
      ["a number", 42, "availability document is not an object"],
      ["an array", [], "availability document is not an object"],
      ["an object with no observedAt", {}, "no readable observedAt"],
    ])("unreadable document, %s: kept with the hold off, parked at the floor with it on", (_name, raw, because) => {
      for (const hold of [false, true]) {
        expectKeptHaiku(decideSticky(healthy(), hold)); // control: the well-formed document
      }
      expectKeptHaiku(decideSticky(raw, false));
      expectHeldAtFloor(decideSticky(raw, true), because);
    });

    it("a document that ages inside a cached snapshot is read against the decision's clock, not the load time", () => {
      // The snapshot is cached up to its TTL (the worker's minute job refreshes
      // it), so the document is normalized at decision time. Same snapshot,
      // same raw document: readable at NOW, unknown three hours on.
      const doc = fleet({}, { allOverrides: { stale_after_seconds: 86_400 } });
      expectKeptHaiku(decideSticky(doc, true, NOW));
      expectHeldAtFloor(decideSticky(doc, true, NOW + 3 * 60 * MINUTE), "exceeds the");
    });
  });
});
