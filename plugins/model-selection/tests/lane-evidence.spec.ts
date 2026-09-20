import { describe, expect, it } from "vitest";

import {
  EVIDENCE_DEAD_THRESHOLD,
  buildLaneEvidence,
  costDownWouldAbandonProvenLane,
  evaluateLaneEvidence,
  evidenceStateFor,
  wilsonInterval,
} from "../src/engine/lane-evidence.js";
import { selectModel } from "../src/engine/select.js";
import { LANED_MODELS, NOW, NO_ESCALATION, PROFILES, config } from "./fixtures.js";

/**
 * TOG-3132, second failure shape. Every behavioural test here is a PAIR: one
 * lane state that must be excluded and one that must not. A gate with only the
 * failing half passes just as well when it excludes the entire roster, which is
 * how a term that has silently become "reject everything" still reads green.
 *
 * Roster (fixtures): haiku = T3 alone on the `zai` lane; sonnet = T2 and
 * opus = T1 share the `claude` lane. A `tier:T3` card picks haiku when `zai`
 * carries evidence, and falls to sonnet when it does not.
 *
 * The counts used below are the REAL ones, measured over 24h on 2026-09-17 by
 * `ops/tog-3132/lane_evidence2.js`. If the thresholds are ever retuned, these
 * numbers say out loud which live lane changes state.
 */

const base = { profiles: PROFILES, signals: NO_ESCALATION, now: NOW };
const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-5";

/** `devin/*`: 0 of 74, every one a provider-level `auth_unavailable`. */
const DEVIN_SHAPE = { succeeded: 0, failed: 74 };
/** `claude-haiku-4-5-20251001`: 34 of 42 in the same window. */
const HEALTHY_SHAPE = { succeeded: 34, failed: 8 };
/**
 * `glm-5.3-flash`: 0 of 4 — one observation short of the zero-success rule, so
 * still genuinely unproven. This is the shape the cost-down tests below need:
 * a destination that is not proven good and not condemned either.
 */
const THIN_SHAPE = { succeeded: 0, failed: 4 };
/**
 * `deepseek-v4-flash`: 0 of 5, measured 2026-09-17 09:22Z. The zero-success
 * rule's headline row — dead on a sample the Wilson bound alone calls
 * inconclusive until 16.
 */
const ZERO_SUCCESS_SHAPE = { succeeded: 0, failed: 5 };
/** A lane that DOES serve, just rarely — `wilson-upper`, not `zero-success`. */
const RARE_SHAPE = { succeeded: 1, failed: 29 };

function evidence(zai: { succeeded: number; failed: number }, claude = HEALTHY_SHAPE) {
  return buildLaneEvidence(
    [
      { laneId: "zai", ...zai },
      { laneId: "claude", ...claude },
    ],
    24,
  );
}

function select(
  laneEvidence: ReturnType<typeof buildLaneEvidence> | undefined,
  descriptor: Record<string, unknown> = {},
  configOverrides: Record<string, unknown> = {},
) {
  return selectModel({
    ...base,
    descriptor: { issueId: "i1", labelNames: ["tier:T3"], ...descriptor } as never,
    config: config({ models: LANED_MODELS, ...(configOverrides as object) }),
    laneEvidence,
  });
}

describe("wilsonInterval — the bound the tri-state is drawn from", () => {
  it("separates a conclusive zero from a thin zero", () => {
    // The whole point of the interval: both are 0%, only one is proof.
    expect(wilsonInterval(0, 74).upper).toBeLessThan(0.06);
    expect(wilsonInterval(0, 5).upper).toBeGreaterThan(0.4);
  });

  it("gives a lane with no history the widest possible interval", () => {
    expect(wilsonInterval(0, 0)).toEqual({ lower: 0, upper: 1 });
  });

  it("reproduces the measured 2026-09-17 verdicts", () => {
    const rows: Array<[string, number, number, string]> = [
      ["devin/*", 0, 74, "proven-dead"],
      ["qwen3.8-max", 0, 42, "proven-dead"],
      // 0/5 and 0/4 are the zero-success rule's boundary, both measured live.
      ["deepseek-v4-flash", 0, 5, "proven-dead"],
      ["glm-5.3-flash", 0, 4, "unproven"],
      ["gpt-5.6-luna", 6, 48, "unproven"],
      ["claude-haiku-4-5-20251001", 34, 42, "proven-good"],
      ["claude-opus-5", 546, 582, "proven-good"],
      ["claude-sonnet-5", 114, 140, "proven-good"],
      ["gpt-5.6-sol", 150, 285, "unproven"],
    ];
    for (const [laneId, ok, total, expected] of rows) {
      const verdict = evaluateLaneEvidence({ laneId, succeeded: ok, failed: total - ok });
      expect(`${laneId}: ${verdict.state}`).toBe(`${laneId}: ${expected}`);
    }
  });
});

describe("evaluateLaneEvidence — the three states", () => {
  it("EXCLUDES a conclusively dead lane and does NOT exclude a healthy one", () => {
    expect(evaluateLaneEvidence({ laneId: "zai", ...DEVIN_SHAPE }).state).toBe("proven-dead");
    expect(evaluateLaneEvidence({ laneId: "zai", ...HEALTHY_SHAPE }).state).toBe("proven-good");
  });

  it("calls a lane with no recorded runs unproven, never good", () => {
    // `devin/gpt-6-astra` took cards at ~0 runs. A term keyed on an observed
    // failure RATE sees no failures here and re-selects it forever.
    const verdict = evaluateLaneEvidence({ laneId: "new", succeeded: 0, failed: 0 });
    expect(verdict.state).toBe("unproven");
    expect(verdict.reason).toContain("no recorded runs");
  });

  it("refuses to call a single success proven-good", () => {
    expect(evaluateLaneEvidence({ laneId: "new", succeeded: 1, failed: 0 }).state).toBe("unproven");
    expect(evaluateLaneEvidence({ laneId: "new", ...HEALTHY_SHAPE }).state).toBe("proven-good");
  });

  it("names the term and the arithmetic in the reason (AC-6)", () => {
    const zero = evaluateLaneEvidence({ laneId: "zai", ...DEVIN_SHAPE });
    expect(zero.reason).toContain("0/74");
    expect(zero.reason).toContain("no lane success");
    // Positive control for the OTHER dead rule: a lane that does serve, rarely,
    // is condemned by the bound and says so in the bound's own language.
    const rare = evaluateLaneEvidence({ laneId: "zai", ...RARE_SHAPE });
    expect(rare.state).toBe("proven-dead");
    expect(rare.reason).toContain("upper bound");
  });
});

/**
 * The zero-success rule (President's 2026-09-17 09:22Z ask on TOG-3132).
 *
 * Every case is a PAIR across the boundary the rule draws, because the rule is
 * only worth anything if it separates: one observation fewer, or one success
 * more, and the same lane must survive.
 */
describe("evaluateLaneEvidence — zero successes is its own dead rule", () => {
  it("exists because the bound alone would wait for 16 observations", () => {
    // The number the whole rule is justified by, asserted rather than asserted
    // in prose: if this ever stops being 16, the doc comment is wrong.
    let firstDeadUnderBoundAlone = null;
    for (let n = 1; n <= 200; n += 1) {
      if (wilsonInterval(0, n).upper <= EVIDENCE_DEAD_THRESHOLD) {
        firstDeadUnderBoundAlone = n;
        break;
      }
    }
    expect(firstDeadUnderBoundAlone).toBe(16);
  });

  it("condemns 0/5, and does NOT condemn 0/4", () => {
    // The Wilson bound calls both inconclusive (upper 0.434 and 0.490); only
    // the zero-success rule separates them, so this pair cannot pass by
    // accident on the old code.
    const dead = evaluateLaneEvidence({ laneId: "zai", ...ZERO_SUCCESS_SHAPE });
    expect(dead.state).toBe("proven-dead");
    expect(dead.rule).toBe("zero-success");
    expect(wilsonInterval(0, 5).upper).toBeGreaterThan(EVIDENCE_DEAD_THRESHOLD);

    const alive = evaluateLaneEvidence({ laneId: "zai", ...THIN_SHAPE });
    expect(alive.state).toBe("unproven");
  });

  it("one success is enough to escape the rule — 1/5 survives where 0/5 dies", () => {
    expect(evaluateLaneEvidence({ laneId: "zai", succeeded: 0, failed: 5 }).state).toBe("proven-dead");
    expect(evaluateLaneEvidence({ laneId: "zai", succeeded: 1, failed: 4 }).state).toBe("unproven");
  });

  it("attributes each dead lane to the rule that actually fired (AC-6)", () => {
    // 0/74 would ALSO fail the bound; the earlier rule must be the one reported.
    expect(evaluateLaneEvidence({ laneId: "zai", ...DEVIN_SHAPE }).rule).toBe("zero-success");
    expect(evaluateLaneEvidence({ laneId: "zai", ...RARE_SHAPE }).rule).toBe("wilson-upper");
    expect(evaluateLaneEvidence({ laneId: "zai", ...HEALTHY_SHAPE }).rule).toBe("wilson-lower");
    expect(evaluateLaneEvidence({ laneId: "zai", succeeded: 0, failed: 0 }).rule).toBe("no-runs");
    expect(evaluateLaneEvidence({ laneId: "zai", ...THIN_SHAPE }).rule).toBe("inconclusive");
  });

  it("is tunable apart from the proven-good sample floor", () => {
    const at8 = { zeroSuccessSamples: 8 };
    expect(evaluateLaneEvidence({ laneId: "zai", ...ZERO_SUCCESS_SHAPE }, at8).state).toBe("unproven");
    expect(evaluateLaneEvidence({ laneId: "zai", succeeded: 0, failed: 8 }, at8).state).toBe("proven-dead");
  });

  it("excludes the measured deepseek-v4-flash lane from the candidate set", () => {
    // The end-to-end claim: a T3 card that would have gone to the dead lane
    // escalates instead, and the trace names the rule.
    const decision = select(evidence(ZERO_SUCCESS_SHAPE));
    expect(decision.modelId).toBe(SONNET);
    const rejection = decision.rejections?.find((entry) => entry.modelId === HAIKU);
    expect(rejection?.stage).toBe("lane-evidence");
    expect(rejection?.reason).toContain("zero-success");
    // Positive control: the identical card on a serving lane still takes haiku.
    expect(select(evidence(HEALTHY_SHAPE)).modelId).toBe(HAIKU);
  });
});

describe("selectModel — a proven-dead lane is excluded, not down-ranked", () => {
  it("escalates off the dead lane, and stays on the live one", () => {
    expect(select(evidence(DEVIN_SHAPE)).modelId).toBe(SONNET);
    // Positive control: same roster, same card, healthy lane -> haiku still wins.
    expect(select(evidence(HEALTHY_SHAPE)).modelId).toBe(HAIKU);
  });

  it("records the excluding term on the decision (AC-6)", () => {
    const decision = select(evidence(DEVIN_SHAPE));
    const note = decision.availability.evidenceExcluded.find((entry) => entry.modelId === HAIKU);
    expect(note?.term).toBe("evidence");
    expect(note?.reason).toContain("0/74");
    expect(
      decision.rejections.find((r) => r.modelId === HAIKU && r.stage === "lane-evidence")?.reason,
    ).toContain("proven-dead");
  });

  it("declines a sticky incumbent parked on the dead lane, and names the term that declined it", () => {
    // The candidate loop excludes haiku either way, so the SELECTION alone
    // cannot tell whether the sticky branch consulted the term — only the trace
    // can, and AC-6 is the reason it has to.
    const sticky = select(evidence(DEVIN_SHAPE), { stickyModelId: HAIKU }, { stickyWithinIssue: true });
    expect(sticky.modelId).toBe(SONNET);
    expect(
      sticky.trace.some(
        (line) => line.startsWith(`sticky ${HAIKU} declined:`) && line.includes("evidence"),
      ),
    ).toBe(true);
    // Positive control: the same warm incumbent is KEPT while its lane holds
    // up, so the branch declines on the evidence and not on stickiness itself.
    const kept = select(evidence(HEALTHY_SHAPE), { stickyModelId: HAIKU }, { stickyWithinIssue: true });
    expect(kept.modelId).toBe(HAIKU);
    expect(kept.trace.some((line) => line.startsWith(`sticky ${HAIKU} declined:`))).toBe(false);
  });

  it("says what the term did even when it excluded nothing", () => {
    const quiet = select(evidence(HEALTHY_SHAPE));
    expect(quiet.trace.some((line) => line.includes("lane evidence over 24h"))).toBe(true);
    const unconfigured = select(undefined);
    expect(unconfigured.trace.some((line) => line.includes("not configured"))).toBe(true);
    expect(unconfigured.modelId).toBe(HAIKU);
  });
});

describe("selectModel — an unproven lane is not a dead lane", () => {
  it("still selects a thin-evidence lane when the card is not leaving a proven one", () => {
    // 0/5 is the `deepseek-v4-flash` row. It is NOT excluded: five failures do
    // not prove a lane dead, and excluding on them would take out every lane
    // the fleet has only just started using.
    expect(evaluateLaneEvidence({ laneId: "zai", ...THIN_SHAPE }).state).toBe("unproven");
    expect(select(evidence(THIN_SHAPE), {}, { stickyWithinIssue: false }).modelId).toBe(HAIKU);
    // Control: push the same lane to conclusive and it goes.
    expect(select(evidence(DEVIN_SHAPE), {}, { stickyWithinIssue: false }).modelId).toBe(SONNET);
  });
});

describe("selectModel — the cost-down guard (the 2026-09-17 08:10Z shape)", () => {
  // TOG-3088 was moved off `claude-haiku-4-5-20251001` (12/12 at the time) onto
  // `deepseek-v4-flash` (0/3) for `cost-down`. `balance_pass` runs with sticky
  // OFF, so the incumbent pin reaches the engine as `stickyModelId` while the
  // sticky branch is skipped — that is the path under test.
  const incumbentOnProvenLane = { stickyModelId: SONNET };
  const balancePass = { stickyWithinIssue: false };

  it("refuses to move a card off a proven-good lane onto an unproven one", () => {
    const decision = select(evidence(THIN_SHAPE), incumbentOnProvenLane, balancePass);
    expect(decision.availability.incumbentEvidence).toBe("proven-good");
    expect(decision.modelId).toBe(SONNET);
    expect(
      decision.rejections.find((r) => r.modelId === HAIKU && r.stage === "lane-evidence")?.reason,
    ).toContain("incumbent lane is proven-good");
  });

  it("allows the very same move once the destination is proven", () => {
    // The positive control that matters most: the guard must not be a blanket
    // freeze on cost-down. Same incumbent, same card, destination now proven.
    const decision = select(evidence(HEALTHY_SHAPE), incumbentOnProvenLane, balancePass);
    expect(decision.modelId).toBe(HAIKU);
    expect(decision.rejections.some((r) => r.stage === "lane-evidence")).toBe(false);
  });

  it("blocks a zero-history destination — the `devin/gpt-6-astra` shape", () => {
    const decision = select(
      evidence({ succeeded: 0, failed: 0 }),
      incumbentOnProvenLane,
      balancePass,
    );
    expect(decision.modelId).toBe(SONNET);
  });

  it("does not block exploration from a lane that is not proven-good", () => {
    // Incumbent on an unproven lane may still move to another unproven lane:
    // `balance_pass`'s exploration slot has to survive this gate.
    const laneEvidence = buildLaneEvidence(
      [
        { laneId: "zai", ...THIN_SHAPE },
        { laneId: "claude", succeeded: 0, failed: 0 },
      ],
      24,
    );
    const decision = select(laneEvidence, { stickyModelId: SONNET }, balancePass);
    expect(decision.availability.incumbentEvidence).toBe("unproven");
    expect(decision.modelId).toBe(HAIKU);
  });
});

describe("unreadable evidence is UNKNOWN, and it is said (AC-4)", () => {
  const unreadable = { lanes: [], windowHours: 24, unreadableReason: "heartbeat_runs read failed" };

  it("excludes nothing but still blocks a cost-down move, and says so", () => {
    const decision = select(unreadable, { stickyModelId: SONNET }, { stickyWithinIssue: false });
    expect(decision.rejections.some((r) => r.stage === "lane-evidence" && r.reason.includes("proven-dead"))).toBe(
      false,
    );
    expect(decision.trace.some((line) => line.includes("UNREADABLE"))).toBe(true);
  });

  it("treats every lane as unproven rather than available", () => {
    expect(evidenceStateFor(unreadable, "zai")).toBe("unproven");
    expect(evidenceStateFor(undefined, "zai")).toBe("unproven");
    // A lane absent from a readable snapshot is unproven too — not a pass.
    expect(evidenceStateFor(evidence(HEALTHY_SHAPE), "a-lane-nobody-measured")).toBe("unproven");
    // Control: a lane that IS in the snapshot reads its real state.
    expect(evidenceStateFor(evidence(HEALTHY_SHAPE), "zai")).toBe("proven-good");
  });
});

describe("costDownWouldAbandonProvenLane — direction", () => {
  it("only fires leaving a proven-good lane", () => {
    expect(costDownWouldAbandonProvenLane("proven-good", "unproven")).toBe(true);
    expect(costDownWouldAbandonProvenLane("proven-good", "proven-dead")).toBe(true);
    expect(costDownWouldAbandonProvenLane("proven-good", "proven-good")).toBe(false);
    expect(costDownWouldAbandonProvenLane("unproven", "unproven")).toBe(false);
    expect(costDownWouldAbandonProvenLane("proven-dead", "unproven")).toBe(false);
  });
});
