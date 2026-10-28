import { describe, expect, it } from "vitest";

import { baselineTierForIssue } from "../src/engine/classify-baseline.js";

const CHARS = 1500;

describe("baselineTierForIssue (rules compiled from the RUBRIC anchors)", () => {
  it("fires named-review for a named PR review against written criteria", () => {
    expect(
      baselineTierForIssue(
        "Review PR #1234 against the security checklist",
        "Criteria are already written down in the repo.",
        CHARS,
      ),
    ).toEqual({ tier: "T2", rule: "named-review" });
  });

  it("fires named-review for a commit SHA review", () => {
    expect(
      baselineTierForIssue("Review commit deadbeef0321 for the release", null, CHARS),
    ).toEqual({ tier: "T2", rule: "named-review" });
  });

  it("does not veto on security alone: reviewing security-sensitive code is T2", () => {
    expect(
      baselineTierForIssue(
        "Review PR #42 touching the security-sensitive auth path",
        "Check it against the written criteria.",
        CHARS,
      ),
    ).toEqual({ tier: "T2", rule: "named-review" });
  });

  it("fires presents-options for work that informs rather than decides", () => {
    expect(baselineTierForIssue("RFC: cache layout options for review", null, CHARS)).toEqual({
      tier: "T2",
      rule: "presents-options",
    });
    expect(
      baselineTierForIssue("Proposal: present options for the owner to choose", null, CHARS),
    ).toEqual({ tier: "T2", rule: "presents-options" });
  });

  it("fires tool-fix for building or fixing tooling against a stated failure", () => {
    expect(baselineTierForIssue("Fix the flaky CI harness gate", "It times out on main.", CHARS)).toEqual({
      tier: "T2",
      rule: "tool-fix",
    });
    expect(baselineTierForIssue("Build a test rig for the quota probe", null, CHARS)).toEqual({
      tier: "T2",
      rule: "tool-fix",
    });
  });

  it("fires roster-reconcile for supplied-source data entry and fixed-method reruns", () => {
    expect(
      baselineTierForIssue("Reconcile roster scores from the supplied sheet", null, CHARS),
    ).toEqual({ tier: "T2", rule: "roster-reconcile" });
    expect(
      baselineTierForIssue("Re-run the latency measurement with the fixed method", null, CHARS),
    ).toEqual({ tier: "T2", rule: "roster-reconcile" });
  });

  it("fires track-only-parent for coordinating cards whose body says the work is elsewhere", () => {
    expect(
      baselineTierForIssue("Wave 2 tracker", "Do not build here — the children do the work.", CHARS),
    ).toEqual({ tier: "T3", rule: "track-only-parent" });
  });

  it("fires mechanical for low-stakes transformations of supplied evidence", () => {
    expect(baselineTierForIssue("Rename foo to bar across the repo", null, CHARS)).toEqual({
      tier: "T3",
      rule: "mechanical",
    });
    expect(baselineTierForIssue("Register the existing test in CI", null, CHARS)).toEqual({
      tier: "T3",
      rule: "mechanical",
    });
    expect(baselineTierForIssue("Verbatim extraction of the error log", "Copy it exactly.", CHARS)).toEqual({
      tier: "T3",
      rule: "mechanical",
    });
  });

  it.each([
    ["Review the production deploy checklist for PR #9", "production + approval veto a review marker"],
    ["Rotate the runner credentials", "credential veto"],
    ["Approve the upstream release", "approval + upstream veto"],
    ["Incident: worker crash loop", "incident veto"],
    ["Provision the new staging host", "provisioning veto"],
    ["Change the access policy irreversibly", "permission + irreversible veto"],
    ["Read the secret from the vault", "secret veto"],
  ])("abstains on T1-veto text: %s (%s)", (title) => {
    expect(baselineTierForIssue(title, "Some description.", CHARS)).toBeNull();
  });

  it("resolves overlap upward: a T2 rule beats a T3 rule", () => {
    expect(baselineTierForIssue("RFC proposal to rename the export", null, CHARS)).toEqual({
      tier: "T2",
      rule: "presents-options",
    });
  });

  it("abstains on empty input", () => {
    expect(baselineTierForIssue("", null, CHARS)).toBeNull();
    expect(baselineTierForIssue("Weekly sync", "", CHARS)).toBeNull();
  });

  it("truncates the description like the classifier call does", () => {
    const marker = "do not build here";
    const description = `${"x".repeat(2000)} ${marker}`;
    expect(baselineTierForIssue("Weekly sync", description, 1500)).toBeNull();
    expect(baselineTierForIssue("Weekly sync", description, 5000)).toEqual({
      tier: "T3",
      rule: "track-only-parent",
    });
  });

  it("never emits T1", () => {
    const fixtures: Array<[string, string | null]> = [
      ["Review PR #1234 against the checklist", null],
      ["RFC: options", null],
      ["Fix the plugin harness", null],
      ["Reconcile the roster", null],
      ["Tracker", "do not build here"],
      ["Rename foo", null],
      ["Review the production deploy checklist for PR #9", null],
      ["", null],
    ];
    for (const [title, description] of fixtures) {
      const verdict = baselineTierForIssue(title, description, CHARS);
      expect(verdict?.tier === undefined || verdict.tier === "T2" || verdict.tier === "T3").toBe(true);
    }
  });
});
