import { describe, expect, it } from "vitest";

import {
  CARD_CENSOR_DAYS,
  SCORE_PRIOR_K,
  SCORE_PROVEN_N,
} from "../src/constants.js";
import {
  cohortKey,
  resolveServedEffort,
  resolveServedModel,
  resolveTaskClass,
  resolveTaskClassFromLabels,
  TASK_CLASS_LABEL_PREFIX,
  UNKNOWN_COHORT_VALUE,
} from "../src/accepted-work/cohort.js";
import {
  ACCEPTED_WORK_SPEC_VERSION,
  attributeAcceptedWorkCard,
  buildAcceptedWorkOverlay,
  normalizeAcceptedWorkOverlay,
  type AcceptedWorkCardInput,
  type AcceptedWorkModelView,
} from "../src/accepted-work/posterior.js";

/**
 * TOG-12972. First-party accepted-work posterior producer (shadow-only).
 *
 * Every behavioural test here is a PAIR where the guard matters: one shape
 * that must attribute and one that must stay unknown — because an
 * attribution that guesses unconditionally reads green while relabelling one
 * lane's outcomes as another model's evidence.
 *
 * Roster shape: opus = T1 on `lane-a` (S-tier `fallbackOnly`), sonnet = T2 on
 * `lane-a`, haiku = T3 on `lane-b`. `zai/glm-5.3` shares haiku's suffix to
 * prove the resolver never guesses by suffix.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-10T12:00:00.000Z");
const NOW_ISO = new Date(NOW).toISOString();

const ROSTER: AcceptedWorkModelView[] = [
  { id: "claude-opus-5", fallbackOnly: true },
  { id: "claude-sonnet-5", fallbackOnly: false },
  { id: "claude-haiku-4-5-20251001", fallbackOnly: false },
  { id: "zai/glm-5.3", fallbackOnly: false },
];

const PRIORS: Record<string, number> = {
  "claude-opus-5": 0.95,
  "claude-sonnet-5": 0.87,
  "claude-haiku-4-5-20251001": 0.7,
  "zai/glm-5.3": 0.8,
};

function card(overrides: Partial<AcceptedWorkCardInput> = {}): AcceptedWorkCardInput {
  return {
    issueId: "issue-1",
    rawServedModel: "claude-sonnet-5",
    pinAdapterConfig: { variant: "high" },
    labelNames: [`${TASK_CLASS_LABEL_PREFIX}review`],
    closedAtMs: NOW - (CARD_CENSOR_DAYS + 1) * DAY,
    rejected: false,
    ...overrides,
  };
}

function overlayOf(cards: AcceptedWorkCardInput[]) {
  return buildAcceptedWorkOverlay({
    cards,
    models: ROSTER,
    priorPByModel: PRIORS,
    unattributed: { closedCardsWithoutClosingRun: 0 },
    nowMs: NOW,
    nowIso: NOW_ISO,
  });
}

describe("resolveServedModel — exact identity or unknown, never a guess", () => {
  it("resolves an exact roster id and the legacy cliproxy/ wrapper", () => {
    expect(resolveServedModel("claude-sonnet-5", ROSTER)).toMatchObject({
      status: "known",
      servedModel: "claude-sonnet-5",
      reason: "exact-match",
    });
    expect(resolveServedModel("cliproxy/claude-opus-5", [{ id: "claude-opus-5", fallbackOnly: true } as AcceptedWorkModelView])).toMatchObject({
      status: "known",
      servedModel: "claude-opus-5",
      reason: "legacy-wrapper",
    });
  });

  it("leaves missing, bare-suffix, aliased, and cased identities unknown", () => {
    // The pair: an exact id attributes while a bare suffix shared by two
    // roster rows stays unknown — guessing would pick the wrong lane's model.
    expect(resolveServedModel(null, ROSTER).status).toBe("unknown");
    expect(resolveServedModel("unknown", ROSTER)).toMatchObject({ status: "unknown", reason: "missing-identity" });
    expect(resolveServedModel("glm-5.3", ROSTER)).toMatchObject({
      status: "unknown",
      servedModel: UNKNOWN_COHORT_VALUE,
      reason: "unmatched-identity",
    });
    expect(resolveServedModel("gpt-5.6", [{ id: "gpt-5.6-sol", fallbackOnly: false } as AcceptedWorkModelView]).status).toBe("unknown");
    expect(resolveServedModel("Claude-Sonnet-5", ROSTER).status).toBe("unknown");
    expect(resolveServedModel("cliproxy/not-in-roster", ROSTER).status).toBe("unknown");
  });

  it("never infers the served model from the requested (pinned) name", () => {
    // The card's pin says opus, but the closing run served sonnet: the cohort
    // is sonnet's. Requested/effective/served are three separate facts.
    const attributed = attributeAcceptedWorkCard(
      card({ rawServedModel: "claude-sonnet-5" }),
      ROSTER,
    );
    expect(attributed.cohort.servedModel).toBe("claude-sonnet-5");
  });

  it("never trusts a non-empty but unresolvable served identity", () => {
    // The positive control for the trust-raw mutant: a bare suffix shared by
    // two roster rows must stay unknown even though it is non-empty. Trusting
    // any non-empty string would attribute this card to a guessed cohort.
    const attributed = attributeAcceptedWorkCard(
      card({ rawServedModel: "glm-5.3" }),
      ROSTER,
    );
    expect(attributed.cohort.servedModel).toBe(UNKNOWN_COHORT_VALUE);
  });
});

describe("resolveServedEffort — recorded effort only, no clamp, no borrow", () => {
  it("resolves a single recorded effort key", () => {
    expect(resolveServedEffort({ variant: "high" })).toMatchObject({ status: "known", servedEffort: "high" });
    expect(resolveServedEffort({ effort: "medium" })).toMatchObject({ status: "known", servedEffort: "medium" });
    expect(resolveServedEffort({ modelReasoningEffort: "max" })).toMatchObject({ status: "known", servedEffort: "max" });
  });

  it("leaves missing, conflicting, and unmeasurable efforts unknown", () => {
    expect(resolveServedEffort(null)).toMatchObject({ status: "unknown", reason: "missing-effort" });
    expect(resolveServedEffort({})).toMatchObject({ status: "unknown", reason: "missing-effort" });
    // Two keys disagree: the adapter that won is unknowable post-hoc.
    expect(resolveServedEffort({ effort: "high", variant: "max" })).toMatchObject({
      status: "unknown",
      reason: "conflicting-effort",
    });
    // `default` is the provider-default control, not a measured effort.
    expect(resolveServedEffort({ effort: "default" })).toMatchObject({ status: "unknown", reason: "unmeasurable-effort" });
    expect(resolveServedEffort({ variant: "turbo" })).toMatchObject({ status: "unknown", reason: "unmeasurable-effort" });
  });

  it("never clamps: a max observation never lands in a high cell", () => {
    // The effort-control negative. Write-time clamping (`resolveEffortPin`
    // max→high) is a serving decision; evidence is looked up for the recorded
    // effort only, mirroring `AaEffortRegistry.lookup`'s exact-effort rule.
    const max = overlayOf([card({ pinAdapterConfig: { modelReasoningEffort: "max" } })]);
    expect(max.cohorts.map((c) => c.servedEffort)).toEqual(["max"]);
    expect(max.cohorts.some((c) => c.servedEffort === "high")).toBe(false);
  });
});

describe("task class — a recorded label, never an inference", () => {
  it("reads the first class: label verbatim", () => {
    expect(resolveTaskClassFromLabels(["tier:T2", "class:review"])).toBe("review");
    expect(resolveTaskClassFromLabels(["class:Research"])).toBe("Research");
    expect(resolveTaskClass("review")).toBe("review");
  });

  it("leaves missing, empty, and unknown labels in the unknown cell", () => {
    expect(resolveTaskClassFromLabels([])).toBe(UNKNOWN_COHORT_VALUE);
    expect(resolveTaskClassFromLabels(undefined)).toBe(UNKNOWN_COHORT_VALUE);
    expect(resolveTaskClassFromLabels(["tier:T2"])).toBe(UNKNOWN_COHORT_VALUE);
    expect(resolveTaskClassFromLabels(["class:unknown"])).toBe(UNKNOWN_COHORT_VALUE);
    expect(resolveTaskClassFromLabels(["class:  "])).toBe(UNKNOWN_COHORT_VALUE);
    expect(resolveTaskClass("unknown")).toBe(UNKNOWN_COHORT_VALUE);
  });
});

describe("buildAcceptedWorkOverlay — Beta-binomial posterior with legacy semantics", () => {
  it("folds accept/rework counts into a versioned overlay with weight-6 priors", () => {
    const overlay = overlayOf([
      card({ issueId: "a" }),
      card({ issueId: "b" }),
      card({ issueId: "c", rejected: true }),
    ]);
    expect(overlay.specVersion).toBe(ACCEPTED_WORK_SPEC_VERSION);
    expect(overlay.cohorts).toHaveLength(1);
    const cohort = overlay.cohorts[0]!;
    expect(cohort.servedModel).toBe("claude-sonnet-5");
    expect(cohort.resolved).toBe(3);
    expect(cohort.accepted).toBe(2);
    expect(cohort.rejected).toBe(1);
    expect(cohort.pending).toBe(0);
    expect(cohort.proven).toBe(false);
    expect(cohort.priorP).toBe(PRIORS["claude-sonnet-5"]);
    const expected = (2 + SCORE_PRIOR_K * PRIORS["claude-sonnet-5"]!) / (3 + SCORE_PRIOR_K);
    expect(cohort.p).toBeCloseTo(expected, 3);
  });

  it("marks a cohort proven at 8 resolved and censors young cards as pending", () => {
    const mature = Array.from({ length: SCORE_PROVEN_N }, (_, i) => card({ issueId: `m-${i}` }));
    const young = card({ issueId: "young", closedAtMs: NOW - DAY });
    const overlay = overlayOf([...mature, young]);
    const cohort = overlay.cohorts[0]!;
    expect(cohort.resolved).toBe(SCORE_PROVEN_N);
    expect(cohort.pending).toBe(1);
    expect(cohort.proven).toBe(true);
    // Pending cards are counted, never scored: the posterior sees 8, not 9.
    expect(cohort.p).toBeCloseTo(
      (SCORE_PROVEN_N + SCORE_PRIOR_K * PRIORS["claude-sonnet-5"]!) / (SCORE_PROVEN_N + SCORE_PRIOR_K),
      3,
    );
  });

  it("resolves rejects early but never scores a pending card as accepted", () => {
    const overlay = overlayOf([card({ issueId: "r", rejected: true, closedAtMs: NOW - DAY })]);
    const cohort = overlay.cohorts[0]!;
    expect(cohort.resolved).toBe(1);
    expect(cohort.rejected).toBe(1);
    expect(cohort.accepted).toBe(0);
    expect(cohort.pending).toBe(0);
  });

  it("keeps S-tier cohorts held and scores the unknown cell on the 0.8 prior", () => {
    const overlay = overlayOf([
      card({ issueId: "s", rawServedModel: "claude-opus-5" }),
      card({ issueId: "u", rawServedModel: null }),
    ]);
    const held = overlay.cohorts.find((c) => c.servedModel === "claude-opus-5")!;
    expect(held.held).toBe("fallback-only");
    const unknown = overlay.cohorts.find((c) => c.servedModel === UNKNOWN_COHORT_VALUE)!;
    expect(unknown.held).toBeNull();
    expect(unknown.priorP).toBe(0.8);
    // The unknown card is accepted (mature, no rework): p=(1+K*0.8)/(1+K).
    expect(unknown.accepted).toBe(1);
    expect(unknown.p).toBeCloseTo((1 + SCORE_PRIOR_K * 0.8) / (1 + SCORE_PRIOR_K), 3);
  });

  it("splits cells on every coordinate: same model, different effort or class", () => {
    const overlay = overlayOf([
      card({ issueId: "a" }),
      card({ issueId: "b", pinAdapterConfig: { variant: "low" } }),
      card({ issueId: "c", labelNames: [`${TASK_CLASS_LABEL_PREFIX}research`] }),
      card({ issueId: "d", rawServedModel: "claude-haiku-4-5-20251001" }),
    ]);
    expect(overlay.cohorts).toHaveLength(4);
    const triples = overlay.cohorts
      .map((c) => `${c.servedModel} x ${c.servedEffort} x ${c.taskClass}`)
      .sort();
    expect(triples).toEqual([
      "claude-haiku-4-5-20251001 x high x review",
      "claude-sonnet-5 x high x research",
      "claude-sonnet-5 x high x review",
      "claude-sonnet-5 x low x review",
    ]);
    // Each cell holds exactly its own card.
    for (const cohort of overlay.cohorts) expect(cohort.resolved).toBe(1);
  });
});

describe("normalizeAcceptedWorkOverlay — stored state fails open, never throws", () => {
  const good = overlayOf([card()]);

  it("round-trips a well-formed overlay", () => {
    expect(normalizeAcceptedWorkOverlay(JSON.parse(JSON.stringify(good)))).toEqual(good);
  });

  it("returns null on malformed, version-mismatched, or non-object state", () => {
    expect(normalizeAcceptedWorkOverlay(null)).toBeNull();
    expect(normalizeAcceptedWorkOverlay([])).toBeNull();
    expect(normalizeAcceptedWorkOverlay({ ...good, specVersion: "tog0000-v0" })).toBeNull();
    expect(normalizeAcceptedWorkOverlay({ ...good, cohorts: null })).toBeNull();
    expect(normalizeAcceptedWorkOverlay({ ...good, cohorts: [{ servedModel: "x" }] })).toBeNull();
    expect(normalizeAcceptedWorkOverlay({ ...good, cohorts: [{ ...good.cohorts[0], resolved: -1 }] })).toBeNull();
    expect(normalizeAcceptedWorkOverlay({ ...good, cohorts: [{ ...good.cohorts[0], held: "lifted" }] })).toBeNull();
  });
});
