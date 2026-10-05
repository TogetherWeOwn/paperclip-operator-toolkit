import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

import { selectModel } from "../src/engine/select.js";
import { mergeLedgerEntry, type LaneLedger, type LaneLedgerEntry } from "../src/engine/pacing.js";
import type { ModelEntry } from "../src/engine/types.js";
import type { LanePaceVerdict } from "../src/lane-capacity/pace.js";
import { MODELS, NO_ESCALATION, NOW, PROFILES, config } from "./fixtures.js";

/**
 *  (D1e dead-lane veto, spec [](/TOG/issues/)).
 *
 * The router must stop selecting lanes with zero successes: a lane whose last
 * 5 consecutive lane-capacity polls contain no success (success = a clean poll
 * whose verdict says `serviceable === true`) is rejected with stage
 * `lane-dead-veto`. Any success resets the streak (self-healing); unconfigured
 * lanes never veto; the veto is inert when `pacing.mode` is off; a missing
 * ledger fails open. CEO change on this card: when EVERY configured lane is
 * dead at once, fail open (admit as today) and raise the operator card as
 * "poller suspect" instead of `tier-exhausted`.
 *
 * Written failing first: pre-fix, a zero-success lane is admitted, so the
 * veto assertions below are red until the slice lands.
 */

const base = { profiles: PROFILES, signals: NO_ESCALATION, now: NOW };

// : freeze the wall clock at the fixture NOW so the seeded PROFILES
// stay inside the production freshness guard. Date-only: async timers run.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function model(baseModel: ModelEntry, overrides: Partial<ModelEntry>): ModelEntry {
  return { ...baseModel, ...overrides };
}

function verdict(laneId: string, overrides: Partial<LanePaceVerdict> = {}): LanePaceVerdict {
  return {
    laneId,
    observedAt: "2026-09-10T11:00:00.000Z",
    state: "on",
    serviceable: true,
    score: null,
    accounts: [],
    knownAccountCount: 1,
    knownWeight: 1,
    serviceableAccountCount: 1,
    urgentResetAt: null,
    reason: "ok",
    ...overrides,
  };
}

const serviceableVerdict = (laneId: string): LanePaceVerdict => verdict(laneId);

const exhaustedVerdict = (laneId: string): LanePaceVerdict =>
  verdict(laneId, { state: "exhausted", serviceable: false, reason: "all-accounts-unserviceable" });

const indeterminateVerdict = (laneId: string): LanePaceVerdict =>
  verdict(laneId, { state: "unknown", serviceable: null, reason: "snapshot-stale" });

/** One poll step folded into the ledger, in production merge order. */
interface PollStep {
  verdict: LanePaceVerdict | null;
  error: string | null;
}

const successStep = (laneId: string): PollStep => ({ verdict: serviceableVerdict(laneId), error: null });
const errorStep = (): PollStep => ({ verdict: null, error: "lane-request-failed" });
const exhaustedStep = (laneId: string): PollStep => ({ verdict: exhaustedVerdict(laneId), error: null });
const nullStep = (): PollStep => ({ verdict: null, error: null });
const indeterminateStep = (laneId: string): PollStep => ({ verdict: indeterminateVerdict(laneId), error: null });

function pollLedger(laneId: string, steps: PollStep[]): LaneLedger {
  let ledger: LaneLedger = {};
  steps.forEach((step, index) => {
    ledger = mergeLedgerEntry(ledger, {
      laneId,
      fetchedAt: `2026-09-10T12:${String(index).padStart(2, "0")}:00.000Z`,
      verdict: step.verdict,
      error: step.error,
    });
  });
  return ledger;
}

function mergeLedgers(...ledgers: LaneLedger[]): LaneLedger {
  return Object.assign({}, ...ledgers);
}

const t3 = MODELS.find((entry) => entry.tier === "T3")!;
const t2 = MODELS.find((entry) => entry.tier === "T2")!;
const t1 = MODELS.find((entry) => entry.tier === "T1")!;
const laned = [
  model(t3, { laneId: "lane-t3" }),
  model(t2, { laneId: "lane-t2" }),
  model(t1, { laneId: "lane-t1" }),
];
const LANES = ["lane-t3", "lane-t2", "lane-t1"];

describe("D1e dead-lane veto", () => {
  it("rejects a lane with 5 consecutive non-success polls with stage lane-dead-veto", () => {
    // Mixed non-success shapes: errors, serviceable:false, null verdicts,
    // indeterminate — every one counts against the lane, per the spec.
    const dead = pollLedger("lane-t3", [
      errorStep(),
      exhaustedStep("lane-t3"),
      nullStep(),
      indeterminateStep("lane-t3"),
      errorStep(),
    ]);
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T3"] },
      config: config({ models: laned, laneLedger: dead, pacingMode: "enforce", configuredLaneIds: LANES }),
    });
    const rejection = decision.rejections.find(
      (r) => r.modelId === t3.id && r.stage === "lane-dead-veto",
    );
    // Pre-fix this admits: no lane-dead-veto rejection exists and haiku wins.
    expect(rejection).toBeDefined();
    expect(rejection?.operand).toEqual({
      kind: "lane-dead-veto",
      laneId: "lane-t3",
      consecutiveNonSuccess: 5,
    });
    // Excluded, never merely deprioritized: the T3 pick escalates off the lane.
    expect(decision.modelId).toBe(t2.id);
  });

  it("still admits a lane with only 4 consecutive non-success polls", () => {
    // The threshold is 5, not 4: this kills a mutant that lowers it.
    const ledger = pollLedger("lane-t3", [errorStep(), errorStep(), errorStep(), errorStep()]);
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T3"] },
      config: config({ models: laned, laneLedger: ledger, pacingMode: "enforce", configuredLaneIds: LANES }),
    });
    expect(decision.modelId).toBe(t3.id);
    expect(decision.rejections.some((r) => r.stage === "lane-dead-veto")).toBe(false);
  });

  it("admits when a serviceable poll sits inside the streak (positive control)", () => {
    const ledger = pollLedger("lane-t3", [
      errorStep(),
      errorStep(),
      successStep("lane-t3"),
      errorStep(),
      errorStep(),
    ]);
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T3"] },
      config: config({ models: laned, laneLedger: ledger, pacingMode: "enforce", configuredLaneIds: LANES }),
    });
    expect(decision.modelId).toBe(t3.id);
    expect(decision.rejections.some((r) => r.stage === "lane-dead-veto")).toBe(false);
  });

  it("self-heals: a success after the veto clears it", () => {
    const vetoed = pollLedger("lane-t3", [errorStep(), errorStep(), errorStep(), errorStep(), errorStep()]);
    const vetoedDecision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T3"] },
      config: config({ models: laned, laneLedger: vetoed, pacingMode: "enforce", configuredLaneIds: LANES }),
    });
    expect(
      vetoedDecision.rejections.some((r) => r.modelId === t3.id && r.stage === "lane-dead-veto"),
    ).toBe(true);

    // One more poll, this time a success — merged the production way.
    let healed = vetoed;
    healed = mergeLedgerEntry(healed, {
      laneId: "lane-t3",
      fetchedAt: "2026-09-10T12:05:00.000Z",
      verdict: serviceableVerdict("lane-t3"),
      error: null,
    });
    const healedDecision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T3"] },
      config: config({ models: laned, laneLedger: healed, pacingMode: "enforce", configuredLaneIds: LANES }),
    });
    expect(healedDecision.modelId).toBe(t3.id);
  });

  it("never vetoes a lane that is not configured for the company", () => {
    const ledger = pollLedger("lane-ghost", [errorStep(), errorStep(), errorStep(), errorStep(), errorStep()]);
    const ghost = model(t3, { laneId: "lane-ghost" });
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T3"] },
      config: config({
        models: [ghost, model(t2, { laneId: "lane-t2" }), model(t1, { laneId: "lane-t1" })],
        laneLedger: ledger,
        pacingMode: "enforce",
        configuredLaneIds: LANES,
      }),
    });
    expect(decision.modelId).toBe(ghost.id);
  });

  it("is inert when pacing.mode is off", () => {
    const dead = pollLedger("lane-t3", [errorStep(), errorStep(), errorStep(), errorStep(), errorStep()]);
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T3"] },
      config: config({ models: laned, laneLedger: dead, pacingMode: "off", configuredLaneIds: LANES }),
    });
    expect(decision.modelId).toBe(t3.id);
  });

  it("fails open on a missing ledger entry", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T3"] },
      config: config({ models: laned, laneLedger: {}, pacingMode: "enforce", configuredLaneIds: LANES }),
    });
    expect(decision.modelId).toBe(t3.id);
  });

  it("fails open when every configured lane is dead at once (poller suspect)", () => {
    // CEO required change: a poller-side failure hits every lane together
    // ( API slowness; lane-secret-unavailable). Dead-vetoing all of
    // them would stop dispatch through tier-exhausted, so admit as today.
    const dead = mergeLedgers(
      pollLedger("lane-t3", [errorStep(), errorStep(), errorStep(), errorStep(), errorStep()]),
      pollLedger("lane-t2", [errorStep(), errorStep(), errorStep(), errorStep(), errorStep()]),
      pollLedger("lane-t1", [errorStep(), errorStep(), errorStep(), errorStep(), errorStep()]),
    );
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T3"] },
      config: config({ models: laned, laneLedger: dead, pacingMode: "enforce", configuredLaneIds: LANES }),
    });
    // Admitted as today: the cheapest candidate still wins.
    expect(decision.modelId).toBe(t3.id);
    expect(decision.outcome).toBe("selected");
    // But the bypass is said, so the worker can raise the poller-suspect card.
    expect(decision.deadVeto?.bypassedAllDead).toBe(true);
    expect(decision.trace.some((line) => line.includes("fail-open") || line.includes("poller"))).toBe(true);
  });

  it("yields tier-exhausted when every candidate lane is vetoed but a healthy configured lane exists outside the tier", () => {
    // The bypass only fires when ALL configured lanes are dead. Here lane-c
    // is healthy, so a wholly-vetoed T1 tier is a capacity dead end, not a
    // poller outage: tier-exhausted plus the operator card, never silent.
    const vetoedAB = mergeLedgers(
      pollLedger("lane-a", [errorStep(), errorStep(), errorStep(), errorStep(), errorStep()]),
      pollLedger("lane-b", [errorStep(), errorStep(), errorStep(), errorStep(), errorStep()]),
    );
    const roster = [
      model(t3, { laneId: "lane-c" }),
      model(t2, { laneId: "lane-c" }),
      model(t1, { id: "t1-a", laneId: "lane-a" }),
      model(t1, { id: "t1-b", laneId: "lane-b" }),
    ];
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T1"] },
      config: config({
        models: roster,
        laneLedger: vetoedAB,
        pacingMode: "enforce",
        configuredLaneIds: ["lane-a", "lane-b", "lane-c"],
      }),
    });
    expect(decision.outcome).toBe("tier-exhausted");
    expect(
      decision.rejections
        .filter((r) => r.modelId === "t1-a" || r.modelId === "t1-b")
        .every((r) => r.stage === "lane-dead-veto"),
    ).toBe(true);
  });

  it("declines a sticky model on a vetoed lane instead of wedging the issue there", () => {
    const dead = pollLedger("lane-t1", [errorStep(), errorStep(), errorStep(), errorStep(), errorStep()]);
    const healthy = model(t1, { id: "t1-healthy", laneId: "lane-t1-ok" });
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T1"], stickyModelId: t1.id },
      config: config({
        models: [model(t1, { laneId: "lane-t1" }), healthy],
        laneLedger: mergeLedgers(dead, pollLedger("lane-t1-ok", [successStep("lane-t1-ok")])),
        pacingMode: "enforce",
        configuredLaneIds: ["lane-t1", "lane-t1-ok"],
      }),
    });
    expect(decision.modelId).toBe("t1-healthy");
    expect(
      decision.rejections.some((r) => r.modelId === t1.id && r.stage === "lane-dead-veto"),
    ).toBe(true);
  });

  it("still honors a pin on a serviceable lane while another lane is vetoed (no change to pins)", () => {
    const dead = pollLedger("lane-t3", [errorStep(), errorStep(), errorStep(), errorStep(), errorStep()]);
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T3"], pinnedModelId: t1.id },
      config: config({ models: laned, laneLedger: dead, pacingMode: "enforce", configuredLaneIds: LANES }),
    });
    expect(decision.judgement.source).toBe("issue-override");
    expect(decision.modelId).toBe(t1.id);
  });

  it("falls through a pin whose every row sits on a vetoed lane", () => {
    const dead = pollLedger("lane-t1", [errorStep(), errorStep(), errorStep(), errorStep(), errorStep()]);
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T2"], pinnedModelId: t1.id },
      config: config({ models: laned, laneLedger: dead, pacingMode: "enforce", configuredLaneIds: LANES }),
    });
    // Same Defect-6 discipline as the serviceability hard stop: a pin is a
    // preference, not a suicide pact.
    expect(decision.judgement.source).toBe("issue-label");
    expect(decision.judgement.tier).toBe("T2");
    expect(decision.modelId).not.toBe(t1.id);
  });
});

describe("dead-lane veto streak accounting (mergeLedgerEntry)", () => {
  it("counts errors, serviceable:false, null verdicts and indeterminate polls as non-success", () => {
    let ledger: LaneLedger = {};
    const steps: PollStep[] = [
      errorStep(),
      exhaustedStep("lane-a"),
      nullStep(),
      indeterminateStep("lane-a"),
    ];
    steps.forEach((step, index) => {
      ledger = mergeLedgerEntry(ledger, {
        laneId: "lane-a",
        fetchedAt: `2026-09-10T12:0${index}:00.000Z`,
        verdict: step.verdict,
        error: step.error,
      });
    });
    const entry: LaneLedgerEntry | undefined = ledger["lane-a"];
    expect(entry?.consecutiveNonSuccess).toBe(4);
  });

  it("resets the streak on any success and starts a legacy entry at zero", () => {
    // Legacy entry: persisted before the streak field existed.
    const legacy: LaneLedger = {
      "lane-a": { laneId: "lane-a", verdict: null, observation: null, fetchedAt: "t", error: null },
    };
    const afterFailure = mergeLedgerEntry(legacy, {
      laneId: "lane-a",
      fetchedAt: "t2",
      verdict: null,
      error: "lane-request-failed",
    });
    expect(afterFailure["lane-a"]?.consecutiveNonSuccess).toBe(1);
    const afterSuccess = mergeLedgerEntry(afterFailure, {
      laneId: "lane-a",
      fetchedAt: "t3",
      verdict: serviceableVerdict("lane-a"),
      error: null,
    });
    expect(afterSuccess["lane-a"]?.consecutiveNonSuccess).toBe(0);
  });

  it("does not reset the streak on an error poll carrying a stale serviceable verdict", () => {
    // Mutant guard (dead-veto-error-with-stale-verdict-resets): a failed poll
    // that still carries a stale `serviceable: true` verdict must keep the
    // streak, or a flapping poller launders a dead lane back into rotation on
    // its error path.
    let ledger: LaneLedger = {};
    const steps: PollStep[] = [
      errorStep(),
      exhaustedStep("lane-a"),
      nullStep(),
      indeterminateStep("lane-a"),
    ];
    steps.forEach((step, index) => {
      ledger = mergeLedgerEntry(ledger, {
        laneId: "lane-a",
        fetchedAt: `2026-09-10T12:0${index}:00.000Z`,
        verdict: step.verdict,
        error: step.error,
      });
    });
    expect(ledger["lane-a"]?.consecutiveNonSuccess).toBe(4);
    const afterErrorWithStaleVerdict = mergeLedgerEntry(ledger, {
      laneId: "lane-a",
      fetchedAt: "2026-09-10T12:04:00.000Z",
      verdict: serviceableVerdict("lane-a"),
      error: "lane-request-failed",
    });
    expect(afterErrorWithStaleVerdict["lane-a"]?.consecutiveNonSuccess).toBe(5);
  });
});
