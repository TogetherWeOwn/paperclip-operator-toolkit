import type { Tier } from "../constants.js";

/**
 * Originally ported VERBATIM from `tier_dispatcher.py` lines 316-322 (`RUBRIC`).
 * Every word here is an operator-reviewed classification policy, not engine
 * code — changing it is a policy change, not a refactor.
 *
 * TOG-3200 (2026-09-17) amends it for the first time. The three tier
 * DEFINITIONS are unchanged. What is added is a block of per-class anchors and
 * a bound on the closing tie-break, both from measurement rather than taste:
 *
 *  - Of the 44 classifications this rubric has ever produced, 34 (77.3%) were
 *    T1 and ZERO were T3. Confidence never fell below 0.82, so
 *    `applyConfidenceDemotion` never fired, and `exclusion` was never true, so
 *    `resolveClassifiedTiers` never forced a pick tier. The T1 skew is the
 *    closing "choose the higher" instruction — not the demotion ladder, and
 *    not the exclusion rule.
 *  - A one-by-one audit of 32 T1-labelled cards that actually ran on
 *    2026-09-17 found 9 false-T1 (28.1% by count, 26.4% of sampled spend) and
 *    23 (72%) that genuinely need T1. Each anchor below names one audited
 *    class. That 72% is why this is not a blanket downgrade: the standing
 *    owner rule is that moving work down that genuinely needs T1 is a failure,
 *    not a saving.
 *
 * Every false-T1 class the audit found was ALREADY described as T2 or T3 by
 * the unamended text — the labellers simply did not apply it there. So the
 * anchors restate existing policy at the boundaries that were misread; they do
 * not move a boundary.
 */
export const RUBRIC = `You classify a software-company work item into a model tier. Answer ONLY a JSON object:
{"tier":"T1"|"T2"|"T3","confidence":0.0-1.0,"exclusion":true|false,"reason":"<=20 words"}
T1 = judgement-heavy, consequential, trust-sensitive, or irreversible: architecture/design decisions; security or adversarial review; incident response; upstream/public actions; owner-facing decisions; factual analysis that feeds consequential decisions; credentials, permissions, access, production deploys, approvals, policy.
T2 = ordinary engineering and fact-producing knowledge work: implementation with tests, normal code review, CI, runbooks, debugging, data pipelines, bounded multi-app automation with deterministic checks, research or reports that must discover or reconcile facts.
T3 = mechanically checkable, low-stakes transformation of supplied evidence: formatting, renames, boilerplate, verbatim extraction, status restatement, label/triage hygiene, registering an existing test, deterministic reruns. A report or summary is T3 only when it creates no new factual premise.
Anchors. These resolve the boundaries that get misread most often. They do not move the definitions above; they say which side of them specific recurring work sits on:
- Reviewing a named PR, commit or SHA against criteria that are already written down is T2, even when the code under review is security-sensitive. Reviewing is not deciding. Choosing whether to ADOPT a security posture, or giving an approval that is itself the irreversible act, stays T1.
- Work that PRESENTS options for someone else to choose is T2. Only work that MAKES or COMMITS TO the decision is T1. "Owner-facing decisions" above means the deciding, not the informing.
- A coordinating or parent card whose own body says the work happens elsewhere ("do not build here", "track only", "the children do the work") is T3: its output is restated status, not engineering.
- Building or fixing a tool, plugin, CI harness or test rig against a stated failure is T2. Its acceptance test is a deterministic check, which is what makes it ordinary engineering rather than judgement.
- Entering, transcribing or reconciling roster, score or measurement data from a supplied source is T2, and re-running a measurement whose method is already fixed is T2.
exclusion=true when the task touches secrets, credentials, permissions, access reviews, provisioning, or owner approvals (these must stay on the assignee's default model regardless of tier).
Be conservative where conservatism buys safety, and only there. If you are unsure between T1 and T2, choose T1 only when a concrete T1 trigger is actually present in the item: an irreversible or externally-visible action, credentials/permissions/access, a production deploy, an approval, a security-posture decision, or an incident in progress. Otherwise choose T2. If you are unsure between T2 and T3, choose T2. Do not choose T1 because the subject matter sounds important, because the card is high priority, or because it names a sensitive system that it does not itself change.`;

/** Ported from `tier_dispatcher.py`'s `classify()` line 325 (the user-turn prompt body). */
export function buildClassificationPrompt(
  title: string,
  description: string | null,
  agentRole: string,
  descriptionChars: number,
): string {
  const truncated = (description ?? "").slice(0, descriptionChars);
  return `Assignee role: ${agentRole}\nTitle: ${title}\nDescription:\n${truncated}`;
}

export interface ClassificationJudgement {
  tier: Tier;
  confidence: number;
  exclusion: boolean;
  reason: string;
}

const TIER_VALUES: readonly string[] = ["T1", "T2", "T3"];

/**
 * Ported from `tier_dispatcher.py`'s `classify()` lines 331-337: extract the
 * first `{...}` blob from the model's text response and validate its shape.
 * Returns null on anything unparseable or a `tier` outside T1/T2/T3 — the
 * caller's job is to skip the issue (`log({"event":"skip", ...})`), never to
 * guess.
 */
export function parseClassificationResponse(text: string): ClassificationJudgement | null {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.tier !== "string" || !TIER_VALUES.includes(obj.tier)) return null;
  const confidence = typeof obj.confidence === "number" && Number.isFinite(obj.confidence) ? obj.confidence : 0;
  return {
    tier: obj.tier as Tier,
    confidence,
    exclusion: obj.exclusion === true,
    reason: typeof obj.reason === "string" ? obj.reason : "",
  };
}

/**
 * Ported from `tier_dispatcher.py` `main()` lines 385-387: a low-confidence
 * classification is demoted toward the more capable (T1) direction rather
 * than trusted at face value. `T3`+low-confidence becomes `T2`;
 * `T2`+low-confidence (INCLUDING a value just demoted from T3) becomes `T1` —
 * the two checks are sequential, not `else if`, in the original, so a T3 at
 * confidence 0.5 walks T3 -> T2 -> T1 in one call. Preserved here.
 */
export function applyConfidenceDemotion(
  tier: Tier,
  confidence: number,
  t3ConfidenceFloor: number,
  t2ConfidenceFloor: number,
): Tier {
  let next = tier;
  if (next === "T3" && confidence < t3ConfidenceFloor) next = "T2";
  if (next === "T2" && confidence < t2ConfidenceFloor) next = "T1";
  return next;
}

/**
 * Ported from `tier_dispatcher.py` `main()` lines 385-395. The `tier:*` LABEL
 * always records the confidence-demoted tier — exclusion never changes it.
 * Exclusion instead forces the separate MODEL-PICK bucket to `"T1"` (owner
 * rule, 2026-09-05 23:05Z: "spread the load across all accounts. Excluded
 * (trust-sensitive) work keeps T1-class quality but is balanced across lanes
 * like everything else instead of being nailed to the floor.") — the label and
 * the pick tier can therefore differ on an excluded T2/T3 card, exactly as in
 * the source: `tier` (label) stays demoted-but-unforced while `pick(tier, ...)`
 * is called with the literal string `"T1"` when `excl` is true.
 */
export function resolveClassifiedTiers(
  judgement: ClassificationJudgement,
  config: { t3ConfidenceFloor: number; t2ConfidenceFloor: number },
): { labelTier: Tier; pickTier: Tier } {
  const labelTier = applyConfidenceDemotion(
    judgement.tier,
    judgement.confidence,
    config.t3ConfidenceFloor,
    config.t2ConfidenceFloor,
  );
  return { labelTier, pickTier: judgement.exclusion ? "T1" : labelTier };
}
