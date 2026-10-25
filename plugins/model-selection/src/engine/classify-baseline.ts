/**
 * Deterministic rules baseline for tier classification, compiled from the
 * RUBRIC anchors in `classify.ts` — not from taste. Each rule below restates
 * one anchor (or one T3 definition clause) as a high-precision text pattern.
 * The RUBRIC text remains the policy source of truth; this file is its
 * mechanically-checkable shadow, and any anchor edit must revisit both.
 *
 * Safety shape, by construction:
 * - The baseline NEVER emits T1. It returns T2/T3 on an anchor match and
 *   abstains (`null`) otherwise. T1 stays classifier/recorded territory, so
 *   the dangerous direction (down-tiering genuine T1 work) can only ever be
 *   proposed in shadow telemetry, never applied — there is no enforce path.
 * - Any T1-veto marker present anywhere in the match text abstains the whole
 *   card, even when an anchor pattern also matches. `security` alone is
 *   deliberately NOT a veto: reviewing security-sensitive code against
 *   written criteria is T2 per the anchor.
 * - Overlap resolves upward: a T2 match wins over any T3 match.
 * - The match text is truncated exactly like the classifier call's prompt
 *   input, so shadow agreement compares both verdicts on the same evidence.
 */
export interface BaselineVerdict {
  tier: "T2" | "T3";
  rule: string;
}

/**
 * T1-veto markers (case-insensitive substrings). Presence of any one abstains
 * the card: the baseline stays out of trust-sensitive territory entirely and
 * the classifier decides, as it does today. Over-vetoing only costs shadow
 * decisiveness, never correctness.
 */
const VETO_MARKERS: readonly string[] = [
  "credential",
  "secret",
  "permission",
  "provision",
  "production",
  "incident",
  "approv",
  "deploy",
  "upstream",
  "irreversib",
  "access",
];

interface BaselineRule {
  id: string;
  tier: "T2" | "T3";
  fires: (text: string) => boolean;
}

const REVIEW_WORD = /\breview(s|ing|ed)?\b/;
const REVIEW_TARGET = /#\d+|\bpr\b|commit|\bsha\b|[0-9a-f]{7,40}/;

const T2_RULES: readonly BaselineRule[] = [
  {
    // Anchor: "Reviewing a named PR, commit or SHA against criteria that are
    // already written down is T2, even when the code under review is
    // security-sensitive."
    id: "named-review",
    tier: "T2",
    fires: (text) => REVIEW_WORD.test(text) && REVIEW_TARGET.test(text),
  },
  {
    // Anchor: "Work that PRESENTS options for someone else to choose is T2.
    // Only work that MAKES or COMMITS TO the decision is T1."
    id: "presents-options",
    tier: "T2",
    fires: (text) => /\brfc\b|\bproposal\b|presents? options|options for/.test(text),
  },
  {
    // Anchor: "Building or fixing a tool, plugin, CI harness or test rig
    // against a stated failure is T2."
    id: "tool-fix",
    tier: "T2",
    fires: (text) =>
      /\b(build|fix|repair)(ing|ed|es|s)?\b.{0,60}\b(tool|plugin|harness|test rig|flaky|ci)\b/.test(text),
  },
  {
    // Anchor: "Entering, transcribing or reconciling roster, score or
    // measurement data from a supplied source is T2, and re-running a
    // measurement whose method is already fixed is T2."
    id: "roster-reconcile",
    tier: "T2",
    fires: (text) =>
      /reconcil|transcrib|\broster\b|re-?run.{0,30}measurement|measurement.{0,30}re-?run/.test(text),
  },
];

const T3_RULES: readonly BaselineRule[] = [
  {
    // Anchor: "A coordinating or parent card whose own body says the work
    // happens elsewhere ("do not build here", "track only", "the children do
    // the work") is T3."
    id: "track-only-parent",
    tier: "T3",
    fires: (text) => /do not build here|track only|children do the work|no work (?:here|on this card)/.test(text),
  },
  {
    // T3 definition: "formatting, renames, boilerplate, verbatim extraction,
    // status restatement, label/triage hygiene, registering an existing test,
    // deterministic reruns."
    id: "mechanical",
    tier: "T3",
    fires: (text) =>
      /\bformat(ting|ed)?\b|\breformat(ting|ed)?\b|\brename[sd]?\b|\bboilerplate\b|\bverbatim\b|\brestat\w*\b|label hygiene|triage hygiene|register(ing)? (the |an? )?existing test|deterministic re-?run/.test(
        text,
      ),
  },
];

export function baselineTierForIssue(
  title: string,
  description: string | null,
  descriptionChars: number,
): BaselineVerdict | null {
  const text = `${title}\n${(description ?? "").slice(0, descriptionChars)}`.toLowerCase();
  if (VETO_MARKERS.some((marker) => text.includes(marker))) return null;
  for (const rule of T2_RULES) {
    if (rule.fires(text)) return { tier: rule.tier, rule: rule.id };
  }
  for (const rule of T3_RULES) {
    if (rule.fires(text)) return { tier: rule.tier, rule: rule.id };
  }
  return null;
}
