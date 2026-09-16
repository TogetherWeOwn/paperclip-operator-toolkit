import type { Tier } from "../constants.js";

/**
 * Ported VERBATIM from `tier_dispatcher.py` lines 316-322 (`RUBRIC`). Every
 * word here is an operator-reviewed classification policy, not engine code —
 * changing it is a policy change, not a refactor.
 */
export const RUBRIC = `You classify a software-company work item into a model tier. Answer ONLY a JSON object:
{"tier":"T1"|"T2"|"T3","confidence":0.0-1.0,"exclusion":true|false,"reason":"<=20 words"}
T1 = judgement-heavy, consequential, trust-sensitive, or irreversible: architecture/design decisions; security or adversarial review; incident response; upstream/public actions; owner-facing decisions; factual analysis that feeds consequential decisions; credentials, permissions, access, production deploys, approvals, policy.
T2 = ordinary engineering and fact-producing knowledge work: implementation with tests, normal code review, CI, runbooks, debugging, data pipelines, bounded multi-app automation with deterministic checks, research or reports that must discover or reconcile facts.
T3 = mechanically checkable, low-stakes transformation of supplied evidence: formatting, renames, boilerplate, verbatim extraction, status restatement, label/triage hygiene, registering an existing test, deterministic reruns. A report or summary is T3 only when it creates no new factual premise.
exclusion=true when the task touches secrets, credentials, permissions, access reviews, provisioning, or owner approvals (these must stay on the assignee's default model regardless of tier).
Be conservative: if unsure between tiers choose the higher (T1 > T2 > T3).`;

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
