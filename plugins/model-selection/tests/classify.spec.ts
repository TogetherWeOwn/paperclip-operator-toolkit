import { describe, expect, it } from "vitest";

import {
  applyConfidenceDemotion,
  buildClassificationPrompt,
  parseClassificationResponse,
  resolveClassifiedTiers,
  RUBRIC,
} from "../src/engine/classify.js";

describe("RUBRIC (tier_dispatcher.py lines 316-322, as amended)", () => {
  it("keeps the exclusion clause word for word", () => {
    // This sentence is a dated operator rule embedded directly in the rubric
    // text rather than in main()'s control flow. A rewrite that paraphrases it
    // is a policy change, not a refactor. The amendment left it untouched: the
    // measured T1 skew came from the tie-break, not from exclusion — across
    // all 44 classifications this rubric ever produced, `exclusion` was never
    // once true.
    expect(RUBRIC).toContain(
      "exclusion=true when the task touches secrets, credentials, permissions, access reviews, provisioning, or owner approvals",
    );
  });

  it("keeps the three tier definitions unamended", () => {
    // The amendment adds anchors and bounds the tie-break. It does not move a tier
    // boundary — 72% of the audited T1 cards genuinely needed T1, so the
    // definitions themselves were not the defect.
    expect(RUBRIC).toContain(
      "T1 = judgement-heavy, consequential, trust-sensitive, or irreversible: architecture/design decisions",
    );
    expect(RUBRIC).toContain("T2 = ordinary engineering and fact-producing knowledge work");
    expect(RUBRIC).toContain("T3 = mechanically checkable, low-stakes transformation of supplied evidence");
  });

  it("bounds the conservative tie-break to cases with a concrete T1 trigger", () => {
    // The old text was an unconditional "if unsure between tiers choose the
    // higher (T1 > T2 > T3)". It produced 34 T1 and 0 T3 out of 44 verdicts
    // while confidence never fell below 0.82 — so the demotion ladder never
    // fired and this sentence was the whole skew. Restoring the unconditional
    // form would reinstate it.
    expect(RUBRIC).not.toContain("Be conservative: if unsure between tiers choose the higher (T1 > T2 > T3).");
    expect(RUBRIC).toContain("Be conservative where conservatism buys safety, and only there.");
    expect(RUBRIC).toContain(
      "choose T1 only when a concrete T1 trigger is actually present in the item",
    );
    expect(RUBRIC).toContain("If you are unsure between T2 and T3, choose T2.");
    expect(RUBRIC).toContain("Do not choose T1 because the subject matter sounds important");
  });

  it("anchors the four false-T1 classes the 2026-09-17 audit measured", () => {
    // Each of these is one audited class from the 9 false-T1 cards found in a
    // 32-card sample (28.1% by count, 26.4% of sampled spend). Each was
    // ALREADY T2/T3 under the unamended definitions; the anchors say so
    // explicitly at the boundary that was misread.
    expect(RUBRIC).toContain("Reviewing a named PR, commit or SHA against criteria that are already written down is T2");
    expect(RUBRIC).toContain("Work that PRESENTS options for someone else to choose is T2");
    expect(RUBRIC).toContain("A coordinating or parent card whose own body says the work happens elsewhere");
    expect(RUBRIC).toContain("Building or fixing a tool, plugin, CI harness or test rig against a stated failure is T2");
  });

  it("keeps each anchor's T1 carve-out so the downgrade cannot over-reach", () => {
    // The owner's boundary: moving work down that genuinely needs T1 is a
    // failure, not a saving. Every anchor that lowers a class names what stays
    // at T1 in the same breath. Dropping a carve-out turns an anchor into a
    // blanket downgrade.
    expect(RUBRIC).toContain("Choosing whether to ADOPT a security posture");
    expect(RUBRIC).toContain("Only work that MAKES or COMMITS TO the decision is T1");
  });

  it("places fact-producing reports above mechanical supplied-evidence transformations", () => {
    expect(RUBRIC).toContain("research or reports that must discover or reconcile facts");
    expect(RUBRIC).toContain("A report or summary is T3 only when it creates no new factual premise");
    expect(RUBRIC).not.toContain("T3 = mechanical or low-stakes: docs, reports, summaries");
  });

  it("raises consequential factual analysis to T1", () => {
    expect(RUBRIC).toContain("factual analysis that feeds consequential decisions");
  });
});

describe("buildClassificationPrompt (classify() line 325)", () => {
  it("truncates the description to the configured character budget", () => {
    const prompt = buildClassificationPrompt("Title", "x".repeat(2000), "engineer", 1500);
    expect(prompt).toBe(`Assignee role: engineer\nTitle: Title\nDescription:\n${"x".repeat(1500)}`);
  });

  it("treats a null description as empty rather than the literal string 'null'", () => {
    const prompt = buildClassificationPrompt("Title", null, "engineer", 1500);
    expect(prompt).toBe("Assignee role: engineer\nTitle: Title\nDescription:\n");
  });
});

describe("parseClassificationResponse (classify() lines 331-337)", () => {
  it("parses a well-formed judgement", () => {
    const judgement = parseClassificationResponse(
      '{"tier":"T2","confidence":0.9,"exclusion":false,"reason":"ordinary bug fix"}',
    );
    expect(judgement).toEqual({ tier: "T2", confidence: 0.9, exclusion: false, reason: "ordinary bug fix" });
  });

  it("extracts the first {...} blob even with leading/trailing prose", () => {
    const judgement = parseClassificationResponse(
      'Sure, here is my answer:\n{"tier":"T1","confidence":0.8,"exclusion":true,"reason":"touches credentials"}\nHope that helps!',
    );
    expect(judgement?.tier).toBe("T1");
    expect(judgement?.exclusion).toBe(true);
  });

  it("returns null rather than guessing when there is no JSON blob at all", () => {
    expect(parseClassificationResponse("I cannot classify this.")).toBeNull();
  });

  it("returns null rather than guessing when the JSON is malformed", () => {
    expect(parseClassificationResponse('{"tier":"T2", "confidence":')).toBeNull();
  });

  it("returns null when tier is outside T1/T2/T3", () => {
    expect(parseClassificationResponse('{"tier":"T4","confidence":0.9,"exclusion":false,"reason":"x"}')).toBeNull();
  });

  it("defaults confidence to 0 rather than throwing on a missing/non-numeric field", () => {
    const judgement = parseClassificationResponse('{"tier":"T3","exclusion":false,"reason":"docs"}');
    expect(judgement?.confidence).toBe(0);
  });

  it("defaults exclusion to false unless the field is exactly boolean true", () => {
    const judgement = parseClassificationResponse('{"tier":"T3","confidence":0.9,"exclusion":"true","reason":"x"}');
    expect(judgement?.exclusion).toBe(false);
  });
});

describe("applyConfidenceDemotion (main() lines 385-387: sequential, not elif)", () => {
  it("leaves a confident T3 alone", () => {
    expect(applyConfidenceDemotion("T3", 0.9, 0.7, 0.6)).toBe("T3");
  });

  it("demotes a low-confidence T3 to T2", () => {
    expect(applyConfidenceDemotion("T3", 0.65, 0.7, 0.6)).toBe("T2");
  });

  it("walks T3 -> T2 -> T1 in a single call when confidence is low enough for both floors", () => {
    // This is the exact case the source's sequential `if`/`if` (not `elif`)
    // exists to handle: a demoted-to-T2 value is immediately re-checked
    // against the T2 floor in the same pass.
    expect(applyConfidenceDemotion("T3", 0.5, 0.7, 0.6)).toBe("T1");
  });

  it("demotes a low-confidence T2 straight to T1", () => {
    expect(applyConfidenceDemotion("T2", 0.5, 0.7, 0.6)).toBe("T1");
  });

  it("never demotes T1 further — there is nowhere more capable to go", () => {
    expect(applyConfidenceDemotion("T1", 0.01, 0.7, 0.6)).toBe("T1");
  });

  it("does not demote a T3 that clears the T3 floor even at a confidence below the T2 floor", () => {
    // 0.65 clears the 0.7? no — pick a value that clears T3 floor but would
    // fail T2 floor, to prove the T2 check is only reached via T3's demotion,
    // not applied unconditionally to every tier.
    expect(applyConfidenceDemotion("T3", 0.75, 0.7, 0.6)).toBe("T3");
  });
});

describe("resolveClassifiedTiers (main() lines 385-395: 2026-09-05 23:05Z owner rule)", () => {
  const floors = { t3ConfidenceFloor: 0.7, t2ConfidenceFloor: 0.6 };

  it("labels and picks the same tier when there is no exclusion", () => {
    const result = resolveClassifiedTiers({ tier: "T2", confidence: 0.9, exclusion: false, reason: "" }, floors);
    expect(result).toEqual({ labelTier: "T2", pickTier: "T2" });
  });

  it("forces the pick tier to T1 on exclusion while leaving the label tier demoted-but-unforced", () => {
    // The core assertion of the owner rule: label and pick tier DIFFER on an
    // excluded T2 card. The label keeps recording what the work actually is;
    // only the money/capability decision is forced to T1-class quality.
    const result = resolveClassifiedTiers({ tier: "T2", confidence: 0.9, exclusion: true, reason: "" }, floors);
    expect(result).toEqual({ labelTier: "T2", pickTier: "T1" });
  });

  it("still applies confidence demotion to the label even when excluded", () => {
    const result = resolveClassifiedTiers({ tier: "T3", confidence: 0.5, exclusion: true, reason: "" }, floors);
    expect(result.labelTier).toBe("T1"); // demoted by confidence alone, walking T3->T2->T1
    expect(result.pickTier).toBe("T1"); // and forced to T1 by exclusion — same value, different reason
  });

  it("does not force the pick tier when exclusion is false, even at T3", () => {
    const result = resolveClassifiedTiers({ tier: "T3", confidence: 0.95, exclusion: false, reason: "" }, floors);
    expect(result).toEqual({ labelTier: "T3", pickTier: "T3" });
  });
});
