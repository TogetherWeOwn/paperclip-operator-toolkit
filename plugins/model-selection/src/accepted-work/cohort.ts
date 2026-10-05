import { EFFORT_LADDER } from "../engine/effort.js";

/**
 * First-party accepted-work cohort attribution.
 *
 * The strongest quality signal we own is our own accepted work: independent
 * review verdicts, rework and accepted deliverables attributed to the
 * actually-served model x effective effort x task class. This module is the attribution half of that producer: raw
 * post-hoc observations in, exact cohort keys out.
 *
 * Three coordinates, each with a real `unknown` state. Unknown is never
 * inferred away:
 *
 * - served model: the closing run's recorded model, resolved to an exact
 *   roster id. A missing/unresolvable/ambiguous identity stays `unknown` —
 *   it is never inferred from the requested (pinned) model name.
 * - served effort: the effort the invocation actually ran, read off the
 *   issue's pin keys. No clamp, no borrow, no suffix parse: a `max`
 *   observation never lands in a `high` cell (the effort-control rule).
 * - task class: a recorded class string, verbatim. Nothing is inferred from
 *   titles or text (ADR-0007: there is no task-type field to key on), so an
 *   unrecorded class stays `unknown`.
 *
 * Everything here is pure — no `ctx`, no IO — so there is no write path to
 * audit. Shadow-only by construction: no selection module imports this.
 */

/** The unattributable marker. Mirrors the `usage_json->>'model'` exclusion in `sql.ts`. */
export const UNKNOWN_COHORT_VALUE = "unknown";

/** Effort levels an observation may claim. `default`/`unknown` are not measured efforts. */
const MEASURABLE_EFFORTS: ReadonlySet<string> = new Set([...EFFORT_LADDER, "none"]);

/** Legacy OmniRoute wrapper, same prefix `resolveConfiguredModelId` strips. */
const OMNIROUTE_PROVIDER_PREFIX = "cliproxy/";

/**
 * The `adapterConfig` keys that can carry a pinned effort, across every
 * adapter with an issue-reachable effort surface (`engine/effort.ts`).
 * `reasoningEffort` is codex's legacy key (`codex-args.ts:44-47`).
 */
const EFFORT_PIN_KEYS = ["effort", "modelReasoningEffort", "variant", "reasoningEffort"] as const;

export type ServedModelStatus = "known" | "unknown";

export interface ServedModelResolution {
  status: ServedModelStatus;
  /** Exact roster id, or `unknown` when unattributable. */
  servedModel: string;
  reason: "exact-match" | "legacy-wrapper" | "missing-identity" | "unmatched-identity";
}

/**
 * Resolve the actually-served model to an exact roster id.
 *
 * Exact match wins outright, even when other rows share the id's suffix. The
 * legacy `cliproxy/` wrapper is stripped only when it identifies an exact
 * configured id. Everything else — bare ids, case variants, codex aliases
 * (`gpt-5.6` is NOT `gpt-5.6-sol` for attribution), suffix guesses — is
 * `unknown`. Guessing here would attribute one lane's outcomes to another
 * model's cohort, which is precisely the relabelling the aa-free registry
 * refuses for slugs.
 */
export function resolveServedModel(
  observed: string | null | undefined,
  models: readonly { id: string }[],
): ServedModelResolution {
  const trimmed = typeof observed === "string" ? observed.trim() : "";
  if (!trimmed || trimmed === UNKNOWN_COHORT_VALUE) {
    return { status: "unknown", servedModel: UNKNOWN_COHORT_VALUE, reason: "missing-identity" };
  }
  const exact = models.find((model) => model.id === trimmed);
  if (exact) {
    return { status: "known", servedModel: exact.id, reason: "exact-match" };
  }
  if (trimmed.startsWith(OMNIROUTE_PROVIDER_PREFIX)) {
    const stripped = trimmed.slice(OMNIROUTE_PROVIDER_PREFIX.length);
    const target = models.find((model) => model.id === stripped);
    if (target) {
      return { status: "known", servedModel: target.id, reason: "legacy-wrapper" };
    }
  }
  // Fail closed: no suffix match, no alias expansion, no case folding. A bare
  // `glm-5.3` beside roster rows `cliproxy/glm-5.3` and `zai/glm-5.3` names no
  // cohort, rather than the wrong one.
  return { status: "unknown", servedModel: UNKNOWN_COHORT_VALUE, reason: "unmatched-identity" };
}

export interface ServedEffortResolution {
  status: "known" | "unknown";
  /** Measured effort level, or `unknown` when unattributable. */
  servedEffort: string;
  reason: "pinned-effort" | "missing-effort" | "conflicting-effort" | "unmeasurable-effort";
}

/**
 * Resolve the effort the invocation actually ran, from the issue pin's effort
 * keys.
 *
 * The pin was written for one adapter under that adapter's own key, so a
 * healthy record sets exactly one key. Agreement is required: zero keys is
 * `missing-effort`, two keys disagreeing is `conflicting-effort` (the adapter
 * that won is unknowable post-hoc — never guess), and a single value outside
 * the measurable vocabulary (`default`, `unknown`, typos) is
 * `unmeasurable-effort`. There is deliberately no clamp and no borrow: the
 * write-time `resolveEffortPin` may clamp `max` to `high` for an adapter that
 * cannot express it, but evidence is looked up for the recorded effort only,
 * mirroring `AaEffortRegistry.lookup`'s fail-closed exact-effort rule.
 */
export function resolveServedEffort(
  effortKeys: Record<string, unknown> | null | undefined,
): ServedEffortResolution {
  const values = new Set<string>();
  if (effortKeys && typeof effortKeys === "object") {
    for (const key of EFFORT_PIN_KEYS) {
      const raw = effortKeys[key];
      if (typeof raw === "string" && raw.trim().length > 0) values.add(raw.trim());
    }
  }
  if (values.size === 0) {
    return { status: "unknown", servedEffort: UNKNOWN_COHORT_VALUE, reason: "missing-effort" };
  }
  if (values.size > 1) {
    return { status: "unknown", servedEffort: UNKNOWN_COHORT_VALUE, reason: "conflicting-effort" };
  }
  const [sole] = [...values] as [string];
  const effort = sole.toLowerCase();
  if (!MEASURABLE_EFFORTS.has(effort)) {
    return { status: "unknown", servedEffort: UNKNOWN_COHORT_VALUE, reason: "unmeasurable-effort" };
  }
  return { status: "known", servedEffort: effort, reason: "pinned-effort" };
}

/**
 * Resolve the recorded task class, verbatim.
 *
 * Verbatim is the fail-closed choice: `Research` and `research` are different
 * cells rather than a normalizer's guess at one. A recorded literal
 * `unknown` is the unknown cell, not a class named unknown — otherwise
 * unattributed mass could launder itself into a scored-looking cohort.
 * Curation vocabulary (mirroring the aa-free bindings) is a future slice;
 * until then every recorded string forms its own cell.
 */
export function resolveTaskClass(recorded: unknown): string {
  if (typeof recorded !== "string") return UNKNOWN_COHORT_VALUE;
  const trimmed = recorded.trim();
  if (trimmed.length === 0 || trimmed === UNKNOWN_COHORT_VALUE) return UNKNOWN_COHORT_VALUE;
  return trimmed;
}

/**
 * The `class:` label prefix — the recorded task-class vocabulary. Mirrors
 * `TIER_LABEL_PREFIX` (`tier:`): the cohort reads what an operator or agent
 * already recorded, it never infers from titles or text (ADR-0007). No card
 * carries such a label today, so every cohort currently lands in `unknown` —
 * an honest "no task-class evidence yet", not a scored guess.
 */
export const TASK_CLASS_LABEL_PREFIX = "class:";

/**
 * Read the recorded task class off the issue's label names. First `class:*`
 * label wins; the `unknown` literal, an empty suffix, or no label at all all
 * resolve to the unknown cell. `Research` and `research` are different cells
 * rather than a normalizer's guess at one — see `resolveTaskClass`.
 */
export function resolveTaskClassFromLabels(labelNames: readonly string[] | undefined): string {
  if (!labelNames) return UNKNOWN_COHORT_VALUE;
  for (const name of labelNames) {
    if (!name.startsWith(TASK_CLASS_LABEL_PREFIX)) continue;
    return resolveTaskClass(name.slice(TASK_CLASS_LABEL_PREFIX.length));
  }
  return UNKNOWN_COHORT_VALUE;
}

export interface AcceptedWorkCohort {
  servedModel: string;
  servedEffort: string;
  taskClass: string;
}

/** Serialize a cohort to its map key. `\0` cannot appear in a trimmed id. */
export function cohortKey(cohort: AcceptedWorkCohort): string {
  return [cohort.servedModel, cohort.servedEffort, cohort.taskClass].join("\u0000");
}
