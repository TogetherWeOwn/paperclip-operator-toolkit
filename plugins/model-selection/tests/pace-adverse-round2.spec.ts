/**
 * Negative controls for the four P1 defects the review reproduced at
 * `af17915c9a64e7c98dc7c40afc7f3080c1a2a81f` (adverse-verdict addenda 1 and 2).
 *
 * Every test in this file FAILS on that SHA. They are kept together, and named
 * after the defect rather than the behaviour, so that a later refactor that
 * reintroduces one is attributable to the review that found it.
 */
import { describe, expect, it } from "vitest";

import { assembleAdditiveConfig } from "../scripts/assemble-additive-config.mjs";
import { hardStopExcluded, orderCandidatesByPace, type LaneLedger } from "../src/engine/pacing.js";
import type { Candidate, ModelEntry } from "../src/engine/types.js";
import {
  evaluateLanePace,
  normalizeLaneDocument,
  type LanePaceVerdict,
} from "../src/lane-capacity/pace.js";

function laneModel(id: string, laneId: string): ModelEntry {
  return {
    id,
    tier: "T2",
    enabled: true,
    costPerMTokIn: 1,
    costPerMTokOut: 1,
    costPerMTokCacheRead: 1,
    capabilities: [],
    contextWindow: 200_000,
    aaIndex: null,
    releasedAt: "2026-01-01",
    fallbackOnly: false,
    note: "",
    earnIn: null,
    laneId,
  } as ModelEntry;
}

function laneVerdict(overrides: Partial<LanePaceVerdict>): LanePaceVerdict {
  return {
    laneId: "lane",
    observedAt: "2026-09-15T12:00:00.000Z",
    state: "on",
    serviceable: true,
    score: { utilization: 0.5, elapsed: 0.5, deviation: 0 },
    targetBurnRate: 0.1,
    observedBurnRate: 0.1,
    deficit: 0,
    accounts: [],
    knownAccountCount: 1,
    knownWeight: 1,
    serviceableAccountCount: 1,
    urgentResetAt: null,
    reason: "ok",
    ...overrides,
  };
}

function ledgerOf(...verdicts: LanePaceVerdict[]): LaneLedger {
  return Object.fromEntries(verdicts.map((verdict) => [verdict.laneId, {
    laneId: verdict.laneId,
    verdict,
    observation: null,
    fetchedAt: "2026-09-15T12:00:00.000Z",
    error: null,
  }]));
}

describe("P1-1 — an indeterminate lane must hard-stop, not merely rank unknown", () => {
  const indeterminate = ([
    "indeterminate-account-weight",
    "invalid-configured-governing-window",
  ] as const);

  it.each(indeterminate)("excludes a lane whose capacity is indeterminate (%s)", (reason) => {
    const ledger = ledgerOf(laneVerdict({
      laneId: "cheap-lane",
      state: "unknown",
      serviceable: null,
      score: null,
      reason,
    }));

    expect(hardStopExcluded(ledger, laneModel("cheap", "cheap-lane"))).toBe(true);
  });

  it.each(["document-unavailable", "snapshot-stale", "no-records", "invalid-account-identity"] as const)(
    "stays fail-neutral when the lane was simply not observed (%s)",
    (reason) => {
      const ledger = ledgerOf(laneVerdict({
        laneId: "unobserved-lane",
        state: "unknown",
        serviceable: null,
        score: null,
        reason,
      }));

      expect(hardStopExcluded(ledger, laneModel("unobserved", "unobserved-lane"))).toBe(false);
    },
  );

  it("does not let a cheaper indeterminate lane outrank a known-capacity fallback", () => {
    // The defect end to end: pace ordering ranks `unknown` ahead of `ahead`, so
    // without the hard stop the cheap indeterminate lane sorts first AND is not
    // excluded, and selection takes a lane whose remaining capacity nobody
    // could compute over one whose capacity is known.
    const cheap = laneModel("cheap", "indeterminate-lane");
    const fallback = laneModel("fallback", "known-lane");
    const ledger = ledgerOf(
      laneVerdict({ laneId: "indeterminate-lane", state: "unknown", serviceable: null, score: null, reason: "indeterminate-account-weight" }),
      laneVerdict({ laneId: "known-lane", state: "ahead", serviceable: true }),
    );
    const candidates: Candidate[] = [
      { modelId: "cheap", tier: "T2", expectedCostUsd: 0.01 } as Candidate,
      { modelId: "fallback", tier: "T2", expectedCostUsd: 1 } as Candidate,
    ];

    const ordered = orderCandidatesByPace(candidates, [cheap, fallback], ledger);
    expect(ordered[0]?.modelId).toBe("cheap");

    const survivors = ordered.filter((candidate) =>
      !hardStopExcluded(ledger, [cheap, fallback].find((entry) => entry.id === candidate.modelId)!));
    expect(survivors.map((candidate) => candidate.modelId)).toEqual(["fallback"]);
  });
});

describe("P1-2 — a reported-but-invalid allowance weight is indeterminate, not a default", () => {
  const evaluateWeight = (allowanceWeight: unknown, present: boolean) => {
    const observedAt = "2026-09-15T12:00:00.000Z";
    return evaluateLanePace({
      observation: normalizeLaneDocument({
        document: {
          observedAt,
          records: [{
            account_key: "max-20x",
            plan_weight: 20,
            health: "healthy",
            windows: [{
              name: "weekly",
              role: "allowance",
              utilization: 0.2,
              resets_at: "2026-09-20T12:00:00.000Z",
              window_seconds: 604_800,
              ...(present ? { allowance_weight: allowanceWeight } : {}),
            }],
          }],
        },
        definition: {
          laneId: "cliproxy-claude",
          healthFields: ["health"],
          accountKeyFields: ["account_key"],
          weightFields: ["plan_weight"],
          windows: [{ name: "weekly", role: "allowance", utilizationFields: [], resetFields: [] }],
        },
      }),
      asOf: observedAt,
    });
  };

  it.each([0, -1, "2", Number.NaN])(
    "refuses to substitute the account plan weight for a broken reported weight (%p)",
    (allowanceWeight) => {
      const result = evaluateWeight(allowanceWeight, true);

      expect(result).toMatchObject({ state: "unknown", serviceable: null, reason: "indeterminate-account-weight" });
      expect(result.knownWeight).not.toBe(20);
      expect(result.accounts[0]?.windows?.[0]).toMatchObject({
        allowanceWeight: null,
        allowanceWeightSource: "unknown",
      });
    },
  );

  it.each([[undefined, false], [null, true]] as const)(
    "still falls back to the account plan weight when no weight was reported (%p)",
    (allowanceWeight, present) => {
      const result = evaluateWeight(allowanceWeight, present);

      expect(result.reason).toBe("ok");
      expect(result.knownWeight).toBe(20);
      expect(result.accounts[0]?.windows?.[0]).toMatchObject({
        allowanceWeight: 20,
        allowanceWeightSource: "account",
      });
    },
  );
});

describe("P1-3 — a stale declared governor must not mask a tighter window or suppress the push", () => {
  const observedAt = "2026-09-15T12:00:00.000Z";
  const definition = {
    laneId: "cliproxy-opencode-go",
    healthFields: ["health"],
    accountKeyFields: ["account_key"],
    windows: [
      { name: "weekly", role: "allowance" as const, utilizationFields: [], resetFields: [] },
      { name: "monthly", role: "allowance" as const, utilizationFields: [], resetFields: [] },
    ],
  };

  it("binds on the tighter monthly allowance even though the record declares weekly", () => {
    const result = evaluateLanePace({
      observation: normalizeLaneDocument({
        document: {
          observedAt,
          records: [{
            account_key: "go-2",
            health: "healthy",
            // Stale: the account still names weekly, but its monthly allowance
            // has run down to 1% with 8 days left to spend it over.
            governing_window: "weekly",
            windows: [
              { name: "weekly", role: "allowance", utilization: 0.1, resets_at: "2026-09-20T12:00:00.000Z", window_seconds: 604_800, allowance_weight: 0.5 },
              { name: "monthly", role: "allowance", utilization: 0.99, resets_at: "2026-09-23T12:00:00.000Z", window_seconds: 2_592_000, allowance_weight: 1 },
            ],
          }],
        },
        definition,
      }),
      asOf: observedAt,
    });

    expect(result.accounts[0]).toMatchObject({
      bindingWindow: "monthly",
      bindingResetAt: "2026-09-23T12:00:00.000Z",
      governingWindow: "monthly",
    });
    // Paced off the weekly window this reads 0.1 — a lane told to burn harder
    // while 1% of the month is all that is left.
    expect(result.score?.utilization).toBe(0.99);
  });

  it("does not relabel the decision with a window it was not computed from", () => {
    const result = evaluateLanePace({
      observation: normalizeLaneDocument({
        document: {
          observedAt,
          records: [{
            account_key: "go-2",
            health: "healthy",
            governing_window: "weekly",
            windows: [
              { name: "weekly", role: "allowance", utilization: 0.1, resets_at: "2026-09-20T12:00:00.000Z", window_seconds: 604_800, allowance_weight: 0.5 },
              { name: "monthly", role: "allowance", utilization: 0.99, resets_at: "2026-09-23T12:00:00.000Z", window_seconds: 2_592_000, allowance_weight: 1 },
            ],
          }],
        },
        definition,
      }),
      asOf: observedAt,
    });

    expect(result.accounts[0]?.bindingWindow).not.toBe("weekly");
    expect(result.accounts[0]?.clearRate).toBeCloseTo(1 * 0.01 / 192, 12);
  });

  it("fires the final-24h push on a window resetting inside the horizon, not only the governing one", () => {
    const result = evaluateLanePace({
      observation: normalizeLaneDocument({
        document: {
          observedAt,
          records: [{
            account_key: "go-2",
            health: "healthy",
            governing_window: "monthly",
            // Stale reported reset: points a month out, so keying the push on
            // it can never see the weekly window closing in 20 hours.
            governing_reset_at: "2026-10-12T07:01:00.000Z",
            windows: [
              // 10% of a weekly allowance used with 20h to go: 90% of this
              // subscription window is about to be destroyed unused.
              { name: "weekly", role: "allowance", utilization: 0.1, resets_at: "2026-09-16T08:00:00.000Z", window_seconds: 604_800, allowance_weight: 0.5 },
              { name: "monthly", role: "allowance", utilization: 0.4, resets_at: "2026-10-12T07:01:00.000Z", window_seconds: 2_592_000, allowance_weight: 1 },
            ],
          }],
        },
        definition,
      }),
      asOf: observedAt,
    });

    expect(result.accounts[0]).toMatchObject({
      state: "push",
      urgentResetAt: "2026-09-16T08:00:00.000Z",
    });
    expect(result).toMatchObject({
      state: "behind-urgent",
      urgentResetAt: "2026-09-16T08:00:00.000Z",
    });
  });

  it("still refuses to resolve a declared governor this snapshot cannot compute", () => {
    // The P1-a guard must survive the change above: competing on clear rate is
    // not the same as standing in for an unresolvable declaration.
    const result = evaluateLanePace({
      observation: normalizeLaneDocument({
        document: {
          observedAt,
          records: [{
            account_key: "go-1",
            health: "healthy",
            governing_window: "monthly",
            windows: [
              { name: "weekly", role: "allowance", utilization: 0.1, resets_at: "2026-09-20T12:00:00.000Z", window_seconds: 604_800, allowance_weight: 0.5 },
              { name: "monthly", role: "allowance", utilization: 0.33, window_seconds: 2_592_000, allowance_weight: 1 },
            ],
          }],
        },
        definition,
      }),
      asOf: observedAt,
    });

    expect(result).toMatchObject({ state: "unknown", serviceable: null, reason: "invalid-configured-governing-window" });
    expect(result.accounts[0]).toMatchObject({ bindingWindow: null, serviceable: false });
  });

  it("drops a reported decision once a tighter window takes over the account", () => {
    // Choosing the tighter window is only half the fix. `target_burn_rate`,
    // `deficit`, `recommended_share`, `normalized_remaining` and
    // `governing_reset_at` are the subscription pool's decision ABOUT THE
    // WINDOW THE RECORD NAMED. Once monthly governs instead, carrying them
    // over paces the account off a window it is no longer on — here they say
    // "4 units/hour behind, burn 5 units/hour" off a weekly allowance that is
    // 90% unspent, while 1% of the month is all that is actually left.
    const result = evaluateLanePace({
      observation: normalizeLaneDocument({
        document: {
          observedAt,
          records: [{
            account_key: "go-2",
            health: "healthy",
            governing_window: "weekly",
            governing_reset_at: "2026-09-20T12:00:00.000Z",
            target_burn_rate: 5,
            deficit: 4,
            recommended_share: 0.9,
            normalized_remaining: 0.9,
            windows: [
              { name: "weekly", role: "allowance", utilization: 0.1, resets_at: "2026-09-20T12:00:00.000Z", window_seconds: 604_800, allowance_weight: 0.5 },
              { name: "monthly", role: "allowance", utilization: 0.99, resets_at: "2026-09-23T12:00:00.000Z", window_seconds: 2_592_000, allowance_weight: 1 },
            ],
          }],
        },
        definition,
      }),
      asOf: observedAt,
    });

    expect(result.accounts[0]).toMatchObject({
      governingWindow: "monthly",
      // Not the weekly reset the record reported alongside its stale decision.
      governingResetAt: "2026-09-23T12:00:00.000Z",
      // Over-consumed against the monthly clock, so throttle — not the
      // "behind, burn harder" the stale weekly deficit asserts.
      state: "ahead",
    });
    // Recomputed off monthly, not the reported 5 units/hour.
    expect(result.accounts[0]?.targetBurnRate).toBeCloseTo(1 * 0.01 / 192, 12);
    expect(result.accounts[0]?.deficit).toBeCloseTo(1 * 0.01 / 192, 12);
    expect(result.accounts[0]?.normalizedRemaining).toBeCloseTo(0.01, 12);
  });
});

describe("P1-4 — an additive assembly must not drop a live selection setting", () => {
  const pacing = {
    mode: "off",
    lanes: [{
      laneId: "cliproxy-claude",
      statusUrl: "https://status.example/claude",
      apiKeySecretRef: { type: "secret_ref", secretId: "secret-claude" },
      windows: [{ name: "primary", role: "serviceability", utilizationFields: ["used"] }],
    }],
  };
  const models = [{ id: "cliproxy/claude-opus-5", tier: "T1", enabled: true, laneId: "cliproxy-claude" }];

  it("preserves live context-fit fields the reviewed roster does not mention", () => {
    const live = {
      selection: { mode: "enforce", fleetContextCeilingTokens: 200_000, compactionRatio: 0.5 },
      models,
      pacing,
    };
    const roster = { selection: { mode: "advise" }, models };

    const { config } = assembleAdditiveConfig(roster, live, { minimumLaneBoundModels: 0 });

    expect(config.selection).toEqual({
      mode: "advise",
      fleetContextCeilingTokens: 200_000,
      compactionRatio: 0.5,
    });
  });

  it("merges every live section key-wise, not just selection", () => {
    const live = { selection: { mode: "enforce" }, telemetry: { sink: "db", sampleRate: 0.25 }, models, pacing };
    const roster = { telemetry: { sampleRate: 1 }, models };

    const { config } = assembleAdditiveConfig(roster, live, { minimumLaneBoundModels: 0 });

    expect(config.telemetry).toEqual({ sink: "db", sampleRate: 1 });
    expect(config.selection).toEqual({ mode: "enforce" });
  });

  it("fails loudly rather than shipping a config that silently resolves to defaults", () => {
    const live = { selection: { mode: "enforce", fleetContextCeilingTokens: 200_000 }, models, pacing };
    const roster = { selection: "advise", models };

    expect(() => assembleAdditiveConfig(roster, live, { minimumLaneBoundModels: 0 }))
      .toThrow(/dropped live settings: selection/);
  });
});
