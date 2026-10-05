import { describe, expect, it } from "vitest";

import { resolveConfig, validateConfig } from "../src/config/resolve.js";
import { SELECTION_CONFIG_SCHEMA } from "../src/config/schema.js";
import { cheapestHealthyModelIdForTier, overrideEnvOnExcludedLane } from "../src/engine/context.js";
import {
  laneCombinedUtilization,
  laneWithdrawal,
  laneWithdrawnExcluded,
  mergeLedgerEntry,
  type LaneAvoidConfig,
  type LaneLedger,
} from "../src/engine/pacing.js";
import { selectModel } from "../src/engine/select.js";
import type { ModelEntry } from "../src/engine/types.js";
import type { LanePaceVerdict, PaceAccountVerdict } from "../src/lane-capacity/pace.js";
import { MODELS, NO_ESCALATION, NOW, PROFILES, config } from "./fixtures.js";

/**
 * `pacing.lanes[].withdrawAtUtilization`. The selector kept a lane
 * open while one account could serve and preferred it near its reset, so with
 * 7 of 8 Meta accounts exhausted it still took every new T1. These specs pin
 * the rule: how "combined" is measured, that it is off by default, that it
 * survives a failed poll until the window resets, and that it removes the
 * lane's models from NEW dispatch through the hard-stop path.
 */

const NOW_ISO = new Date(NOW).toISOString();
const RESET = new Date(NOW + 2 * 60 * 60 * 1000).toISOString();
const LANE = "cliproxy-meta";
const base = { profiles: PROFILES, signals: NO_ESCALATION, now: NOW };

function account(overrides: Partial<PaceAccountVerdict> & { utilization?: number | null } = {}): PaceAccountVerdict {
  const { utilization = 0.5, ...rest } = overrides;
  return {
    accountKey: "meta-lane-1",
    health: "healthy",
    weight: 1,
    weightSource: "reported",
    governingWindow: "weekly",
    governingResetAt: RESET,
    serviceable: true,
    state: "on",
    score: utilization === null ? null : { utilization, elapsed: 0.5, deviation: utilization - 0.5 },
    ...rest,
  };
}

function verdict(accounts: PaceAccountVerdict[], overrides: Partial<LanePaceVerdict> = {}): LanePaceVerdict {
  return {
    laneId: LANE,
    observedAt: NOW_ISO,
    state: "available" as LanePaceVerdict["state"],
    serviceable: accounts.some((entry) => entry.serviceable),
    score: { utilization: 0.99, elapsed: 0.9, deviation: 0.09 },
    accounts,
    knownAccountCount: accounts.length,
    knownWeight: accounts.length,
    serviceableAccountCount: accounts.filter((entry) => entry.serviceable).length,
    urgentResetAt: null,
    reason: "ok",
    ...overrides,
  };
}

/** The 21:48Z shape that motivated the card: 7 of 8 exhausted at 0.99, one serviceable at 0.85. */
function sevenOfEightExhausted(): PaceAccountVerdict[] {
  return [
    ...Array.from({ length: 7 }, (_, index) =>
      account({ accountKey: `meta-lane-${index + 1}`, health: "exhausted", serviceable: false, utilization: 0.99, state: "exhausted" }),
    ),
    account({ accountKey: "meta-lane-8", utilization: 0.85 }),
  ];
}

function ledgerFrom(entryVerdict: LanePaceVerdict | null, fetchedAt = NOW_ISO): LaneLedger {
  return mergeLedgerEntry({}, { laneId: LANE, fetchedAt, verdict: entryVerdict, error: null });
}

const avoid = (withdrawAt?: Record<string, number>): LaneAvoidConfig => ({
  defaultThreshold: 0.8,
  perLane: {},
  ...(withdrawAt ? { withdrawAt } : {}),
});

describe("laneCombinedUtilization", () => {
  it("counts an unserviceable account as fully spent, not at its 0.99 trip reading", () => {
    const reading = laneCombinedUtilization(verdict(sevenOfEightExhausted()), NOW_ISO)!;
    // (7 * 1 + 0.85) / 8. The plain mean is 0.9725, which a 0.98 ceiling never reaches.
    expect(reading.utilization).toBeCloseTo(0.98125, 10);
    expect(reading.accounts).toBe(8);
    expect(reading.resetsAt).toBe(RESET);
    expect(reading.measuredAt).toBe(NOW_ISO);
  });

  it("weights serviceable accounts by their reported weight", () => {
    const reading = laneCombinedUtilization(
      verdict([account({ weight: 20, utilization: 0.1 }), account({ accountKey: "b", weight: 5, utilization: 0.9 })]),
      NOW_ISO,
    )!;
    expect(reading.utilization).toBeCloseTo((20 * 0.1 + 5 * 0.9) / 25, 10);
  });

  it("falls back to equal weights unless every contributor reports one", () => {
    const reading = laneCombinedUtilization(
      verdict([account({ weight: 20, utilization: 0.1 }), account({ accountKey: "b", weight: null, weightSource: "unknown", utilization: 0.9 })]),
      NOW_ISO,
    )!;
    expect(reading.utilization).toBeCloseTo(0.5, 10);
  });

  it("leaves an account with no governing-window reading out of the mean", () => {
    const reading = laneCombinedUtilization(
      verdict([account({ utilization: 0.4 }), account({ accountKey: "blind", utilization: null }), account({ accountKey: "c", utilization: 0.6 })]),
      NOW_ISO,
    )!;
    expect(reading.utilization).toBeCloseTo(0.5, 10);
    expect(reading.accounts).toBe(2);
  });

  it("clamps a serviceable reading into 0-1 and reports the earliest reset", () => {
    const soon = new Date(NOW + 60_000).toISOString();
    const reading = laneCombinedUtilization(
      verdict([account({ utilization: 1.4, governingResetAt: RESET }), account({ accountKey: "b", utilization: -0.2, governingResetAt: soon })]),
      NOW_ISO,
    )!;
    expect(reading.utilization).toBeCloseTo(0.5, 10);
    expect(reading.resetsAt).toBe(soon);
  });

  it("is null when no account contributes: a free lane, or one nobody can read", () => {
    expect(laneCombinedUtilization(verdict([]), NOW_ISO)).toBeNull();
    expect(laneCombinedUtilization(verdict([account({ utilization: null })]), NOW_ISO)).toBeNull();
  });
});

describe("combined utilization in the lane ledger", () => {
  it("is stored from a verdict the poll returned, and absent from entries that never had one", () => {
    expect(ledgerFrom(verdict(sevenOfEightExhausted()))[LANE]!.combinedUtilization?.utilization).toBeCloseTo(0.98125, 10);
    // Same shape as before for a lane with no reading: no key, so existing ledgers compare equal.
    expect("combinedUtilization" in ledgerFrom(verdict([]))[LANE]!).toBe(false);
  });

  it("survives a failed poll, so a flapping poll cannot readmit a withdrawn lane", () => {
    const held = ledgerFrom(verdict(sevenOfEightExhausted()));
    const afterFailure = mergeLedgerEntry(held, { laneId: LANE, fetchedAt: "later", verdict: null, error: "timeout" });
    expect(afterFailure[LANE]!.verdict).toBeNull();
    expect(afterFailure[LANE]!.combinedUtilization).toEqual(held[LANE]!.combinedUtilization);
    expect(laneWithdrawal(afterFailure, LANE, avoid({ [LANE]: 0.98 }), NOW)).not.toBeNull();
  });

  it("keeps the prior reading when a poll returns a verdict with nothing to read", () => {
    const held = ledgerFrom(verdict(sevenOfEightExhausted()));
    const stale = mergeLedgerEntry(held, {
      laneId: LANE,
      fetchedAt: "later",
      verdict: verdict([], { state: "unknown", serviceable: null, score: null, reason: "snapshot-stale" }),
      error: null,
    });
    expect(stale[LANE]!.combinedUtilization).toEqual(held[LANE]!.combinedUtilization);
  });

  it("is replaced by a poll that measured the lane again, down as well as up", () => {
    const held = ledgerFrom(verdict(sevenOfEightExhausted()));
    const recovered = mergeLedgerEntry(held, {
      laneId: LANE,
      fetchedAt: "later",
      verdict: verdict([account({ utilization: 0.2 })]),
      error: null,
    });
    expect(recovered[LANE]!.combinedUtilization?.utilization).toBeCloseTo(0.2, 10);
    expect(laneWithdrawal(recovered, LANE, avoid({ [LANE]: 0.98 }), NOW)).toBeNull();
  });
});

describe("laneWithdrawal", () => {
  const ledger = ledgerFrom(verdict(sevenOfEightExhausted()));

  it("is off by default: no ceiling configured, no withdrawal", () => {
    expect(laneWithdrawal(ledger, LANE, avoid(), NOW)).toBeNull();
    expect(laneWithdrawal(ledger, LANE, avoid({}), NOW)).toBeNull();
  });

  it("withdraws at or above the ceiling and reports why", () => {
    expect(laneWithdrawal(ledger, LANE, avoid({ [LANE]: 0.98 }), NOW)).toEqual({
      laneId: LANE,
      utilization: 0.98125,
      ceiling: 0.98,
      accounts: 8,
    });
  });

  it("keeps the lane open below the ceiling", () => {
    expect(laneWithdrawal(ledger, LANE, avoid({ [LANE]: 0.99 }), NOW)).toBeNull();
  });

  it("treats a reading exactly at the ceiling as withdrawn, through float drift", () => {
    // 7.84 / 8 is 0.98 only up to the last bit; the comparison must not flip on it.
    const exact = ledgerFrom(verdict(Array.from({ length: 8 }, (_, index) => account({ accountKey: `a${index}`, utilization: 0.98 }))));
    expect(laneWithdrawal(exact, LANE, avoid({ [LANE]: 0.98 }), NOW)).not.toBeNull();
    expect(laneWithdrawal(exact, LANE, avoid({ [LANE]: 0.9801 }), NOW)).toBeNull();
  });

  it("scopes the ceiling to its own lane", () => {
    expect(laneWithdrawal(ledger, "cliproxy-claude", avoid({ [LANE]: 0.5 }), NOW)).toBeNull();
    expect(laneWithdrawal(ledger, null, avoid({ [LANE]: 0.5 }), NOW)).toBeNull();
  });

  it.each([0, -0.5, Number.NaN])("ignores a non-positive or non-finite ceiling (%s) instead of withdrawing every lane", (ceiling) => {
    expect(laneWithdrawal(ledger, LANE, avoid({ [LANE]: ceiling }), NOW)).toBeNull();
  });

  it("stops counting a reading once the earliest contributing window has reset", () => {
    const resetMs = Date.parse(RESET);
    expect(laneWithdrawal(ledger, LANE, avoid({ [LANE]: 0.98 }), resetMs - 1)).not.toBeNull();
    expect(laneWithdrawal(ledger, LANE, avoid({ [LANE]: 0.98 }), resetMs)).toBeNull();
  });

  it("is fail-neutral on a lane with no reading", () => {
    expect(laneWithdrawal({}, LANE, avoid({ [LANE]: 0.5 }), NOW)).toBeNull();
    expect(laneWithdrawal(ledgerFrom(null), LANE, avoid({ [LANE]: 0.5 }), NOW)).toBeNull();
  });
});

describe("selection under a withdrawal ceiling", () => {
  const t1 = MODELS.find((entry) => entry.tier === "T1")!;
  const metaCheap = { ...t1, id: "meta-cheap", laneId: LANE, costPerMTokIn: 0.1, costPerMTokOut: 0.1, costPerMTokCacheRead: 0.01 } satisfies ModelEntry;
  const metaTwin = { ...metaCheap, id: "meta-twin" } satisfies ModelEntry;
  const elsewhere = { ...t1, id: "elsewhere", laneId: "cliproxy-codex", costPerMTokIn: 2, costPerMTokOut: 8, costPerMTokCacheRead: 0.2 } satisfies ModelEntry;
  const ledger = ledgerFrom(verdict(sevenOfEightExhausted()));

  function select(overrides: Parameters<typeof config>[0] = {}, issueId = "withdrawal-replay") {
    return selectModel({
      ...base,
      descriptor: { issueId, labelNames: ["tier:T1"] },
      config: config({
        models: [metaCheap, metaTwin, elsewhere],
        pacingMode: "enforce",
        laneLedger: ledger,
        stickyWithinIssue: false,
        ...overrides,
      }),
    });
  }

  it("default off: without a ceiling the spent lane still wins on cost, exactly as before", () => {
    const decision = select({ laneAvoidConfig: avoid() });
    expect(decision.modelId).toBe("meta-cheap");
    expect(decision.rejections.some((r) => r.stage === "lane-withdrawn")).toBe(false);
    expect(decision.trace.some((line) => line.includes("withdrawn"))).toBe(false);
  });

  it("withdraws the lane's models through a lane-withdrawn rejection and picks the next lane", () => {
    const decision = select({ laneAvoidConfig: avoid({ [LANE]: 0.98 }) });
    expect(decision.modelId).toBe("elsewhere");
    const rejected = decision.rejections.filter((r) => r.stage === "lane-withdrawn");
    expect(rejected.map((r) => r.modelId).sort()).toEqual(["meta-cheap", "meta-twin"]);
    expect(rejected[0]!.operand).toEqual({ kind: "lane-withdrawn", laneId: LANE, utilization: 0.98125, ceiling: 0.98, accounts: 8 });
  });

  it("writes one trace line per withdrawn lane, naming the reading and the ceiling", () => {
    const lines = select({ laneAvoidConfig: avoid({ [LANE]: 0.98 }) }).trace.filter((line) => line.includes("withdrawn from new dispatch"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(LANE);
    expect(lines[0]).toContain("0.9812");
    expect(lines[0]).toContain("8 account(s)");
    expect(lines[0]).toContain("0.98 withdrawal ceiling");
  });

  it("holds below the ceiling", () => {
    expect(select({ laneAvoidConfig: avoid({ [LANE]: 0.99 }) }).modelId).toBe("meta-cheap");
  });

  it("does nothing when pacing is off", () => {
    expect(select({ pacingMode: "off", laneAvoidConfig: avoid({ [LANE]: 0.98 }) }).modelId).toBe("meta-cheap");
  });

  it("is not waived by an operator override, like the serviceability hard stop", () => {
    const decision = select({ laneAvoidConfig: avoid({ [LANE]: 0.98 }), operatorOverrideModelId: "meta-cheap" });
    expect(decision.modelId).toBe("elsewhere");
  });

  it("applies to new dispatch only: an issue already sticky to the lane keeps it", () => {
    const decision = select({
      laneAvoidConfig: avoid({ [LANE]: 0.98 }),
      stickyWithinIssue: true,
    });
    // Sticky needs a recorded incumbent; with none this is a fresh dispatch and withdraws.
    expect(decision.modelId).toBe("elsewhere");
    const sticky = selectModel({
      ...base,
      descriptor: { issueId: "withdrawal-replay-sticky", labelNames: ["tier:T1"], stickyModelId: "meta-cheap" },
      config: config({
        models: [metaCheap, metaTwin, elsewhere],
        pacingMode: "enforce",
        laneLedger: ledger,
        stickyWithinIssue: true,
        laneAvoidConfig: avoid({ [LANE]: 0.98 }),
      }),
    });
    expect(sticky.modelId).toBe("meta-cheap");
  });

  it("reports tier-exhausted, a capacity outage, when every candidate sits at its ceiling", () => {
    const decision = select({ models: [metaCheap, metaTwin], laneAvoidConfig: avoid({ [LANE]: 0.98 }) });
    expect(decision.outcome).toBe("tier-exhausted");
  });

  it("keeps the same lane open once its window has reset and the reading is void", () => {
    const afterReset = selectModel({
      ...base,
      now: Date.parse(RESET) + 1,
      descriptor: { issueId: "withdrawal-replay-reset", labelNames: ["tier:T1"] },
      config: config({
        models: [metaCheap, metaTwin, elsewhere],
        pacingMode: "enforce",
        laneLedger: ledger,
        stickyWithinIssue: false,
        laneAvoidConfig: avoid({ [LANE]: 0.98 }),
      }),
    });
    expect(afterReset.modelId).toBe("meta-cheap");
  });
});

describe("agent floor under a withdrawal ceiling", () => {
  // The floor check is a separate wired site from the candidate loop: a thin
  // volume profile holds at the agent floor, and a floor whose lane is dead is
  // the one exception (). A floor whose lane is withdrawn is the same
  // exception: holding there would write no pin and let the card dispatch to
  // the lane the ceiling just closed.
  const floor = { ...MODELS.find((entry) => entry.tier === "T3")!, id: "gpt-5.6-sol", laneId: LANE } satisfies ModelEntry;
  const thin = PROFILES.map((profile) => ({ ...profile, sampleCount: 1 }));
  const ledger = ledgerFrom(verdict(sevenOfEightExhausted()));

  function select(laneAvoidConfig: LaneAvoidConfig) {
    return selectModel({
      ...base,
      profiles: thin,
      descriptor: { issueId: "withdrawal-replay-floor", labelNames: ["tier:T1"], agentFloorModelId: "gpt-5.6-sol" },
      config: config({ models: [...MODELS, floor], pacingMode: "enforce", laneLedger: ledger, laneAvoidConfig }),
    });
  }

  it("declines to hold at a floor whose lane is withdrawn, and writes an explicit pin instead", () => {
    const decision = select(avoid({ [LANE]: 0.98 }));
    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).not.toBe("gpt-5.6-sol");
    expect(decision.trace.some((line) => line.includes("held-at-floor declined"))).toBe(true);
  });

  it("still holds at the floor when no ceiling is configured, unchanged", () => {
    const decision = select(avoid());
    expect(decision.outcome).toBe("held-at-floor");
  });

  it("still holds at the floor while the lane is below its ceiling", () => {
    expect(select(avoid({ [LANE]: 0.99 })).outcome).toBe("held-at-floor");
  });
});

describe("withdrawal in the sub-call and balance gates", () => {
  const t3 = MODELS.find((entry) => entry.tier === "T3")!;
  const withdrawn = { ...t3, id: "withdrawn-cheap", laneId: LANE, costPerMTokIn: 0.1, costPerMTokOut: 0.1 } satisfies ModelEntry;
  const open = { ...t3, id: "open-dearer", laneId: "cliproxy-codex", costPerMTokIn: 1, costPerMTokOut: 1 } satisfies ModelEntry;
  const ledger = ledgerFrom(verdict(sevenOfEightExhausted()));

  it("cheapestHealthyModelIdForTier skips a withdrawn lane", () => {
    const input = {
      models: [withdrawn, open],
      tier: "T3" as const,
      ledger,
      laneOutageOverride: null,
      nowIso: NOW_ISO,
      modelScores: {},
      pacingMode: "enforce" as const,
    };
    expect(cheapestHealthyModelIdForTier({ ...input, laneAvoidConfig: avoid() })).toBe("withdrawn-cheap");
    expect(cheapestHealthyModelIdForTier({ ...input, laneAvoidConfig: avoid({ [LANE]: 0.98 }) })).toBe("open-dearer");
  });

  it("overrideEnvOnExcludedLane reports a sub-call env frozen on a withdrawn lane", () => {
    const input = {
      existingOverrideEnv: { ANTHROPIC_SMALL_FAST_MODEL: { type: "plain", value: "withdrawn-cheap" } },
      models: [withdrawn, open],
      ledger,
      laneOutageOverride: null,
      nowIso: NOW_ISO,
      pacingMode: "enforce" as const,
    };
    expect(overrideEnvOnExcludedLane({ ...input, laneAvoidConfig: avoid() })).toBe(false);
    expect(overrideEnvOnExcludedLane({ ...input, laneAvoidConfig: avoid({ [LANE]: 0.98 }) })).toBe(true);
  });

  it("laneWithdrawnExcluded is false for a model with no lane", () => {
    expect(laneWithdrawnExcluded(ledger, { ...t3, laneId: null }, avoid({ [LANE]: 0 }))).toBe(false);
  });
});

describe("withdrawAtUtilization config", () => {
  const lane = (extra: Record<string, unknown> = {}) => ({
    laneId: LANE,
    statusUrl: "https://status.example/meta",
    windows: [{ name: "weekly", role: "allowance", utilizationFields: ["used"] }],
    ...extra,
  });
  const resolved = (extra?: Record<string, unknown>) => resolveConfig({ pacing: { mode: "shadow", lanes: [lane(extra)] } });

  it("is declared in the config schema as a 0-1 number", () => {
    const properties = (SELECTION_CONFIG_SCHEMA.properties.pacing.properties.lanes.items as { properties: Record<string, unknown> }).properties;
    expect(properties.withdrawAtUtilization).toMatchObject({ type: "number", minimum: 0, maximum: 1 });
  });

  it("resolves into pacing.avoid.withdrawAt, keyed by lane", () => {
    const config = resolved({ withdrawAtUtilization: 0.98 });
    expect(config.pacing.lanes[0]!.withdrawAtUtilization).toBe(0.98);
    expect(config.pacing.avoid.withdrawAt).toEqual({ [LANE]: 0.98 });
  });

  it("leaves every existing config resolving to the shape it always had", () => {
    const config = resolved();
    expect(config.pacing.lanes[0]).not.toHaveProperty("withdrawAtUtilization");
    expect(config.pacing.avoid).not.toHaveProperty("withdrawAt");
  });

  it("accepts a ceiling of 1 and rejects one that would withdraw always or never", () => {
    expect(validateConfig(resolved({ withdrawAtUtilization: 0.98 })).errors).toEqual([]);
    expect(validateConfig(resolved({ withdrawAtUtilization: 1 })).errors).toEqual([]);
    for (const bad of [0, -0.1, 1.5]) {
      const { errors } = validateConfig(resolved({ withdrawAtUtilization: bad }));
      expect(errors.some((error) => error.includes(`pacing.lanes.${LANE}.withdrawAtUtilization`))).toBe(true);
    }
  });
});
