/**
 * Reasoning effort, paired with the model that makes it legal.
 *
 * `effort` is not one field with one vocabulary. It is one *concept*
 * that each adapter spells differently and admits a different set of values
 * for, and the legal set depends on the model — which only the selector knows.
 * So the selector is the only component that can write the pair coherently.
 *
 * Measured in `/app` at v2026.916.0, not inferred:
 *
 * - key, per adapter `ui/build-config.ts`:
 *   `claude_local` -> `effort` (`claude-local/src/ui/build-config.ts:40`),
 *   `codex_local` -> `modelReasoningEffort` (`codex-local/…:36`),
 *   `opencode_local` -> `variant` (`opencode-local/…:15`).
 *   Those three are also exactly `ISSUE_OVERRIDE_ADAPTER_TYPES`
 *   (`ui/src/lib/issue-assignee-overrides.ts:1-5`) — the only adapters whose
 *   `adapterConfig` an issue-level override is allowed to reach at all.
 * - vocabulary:
 *   `claude_local` low|medium|high (`ui/src/components/issue-properties/helpers.ts:57-62`,
 *   and `claude-local/src/index.ts:52` documents the same three for `--effort`),
 *   `opencode_local` minimal|low|medium|high|xhigh|max (`helpers.ts:63-71`),
 *   `codex_local` minimal|low|medium|high|xhigh, except `gpt-6-astra` which is
 *   low|medium|high|xhigh|max|ultra (`codex-local/src/index.ts:36-67`).
 *
 * The vocabulary keys on the ADAPTER first and the model only to refine codex.
 * That ordering is load-bearing on this fleet: most agents run `claude_local`
 * against a proxy lane, so a `gpt-6-astra` pin on a `claude_local` agent is
 * still driven by `claude` CLI `--effort` and still caps at `high`.
 *
 * Nothing downstream validates. `claude-local/src/server/execute.ts:436,899`
 * reads `config.effort` and pushes `--effort <value>` verbatim, so an illegal
 * value reaches the CLI as-is — which is the 2026-09-22 failure this file
 * exists to make impossible.
 */

/**
 * The union of every adapter vocabulary, ordered least to most reasoning.
 *
 * Used only to clamp: "the highest level this model actually supports that is
 * no hotter than what was asked for". Rungs a given adapter does not offer are
 * simply skipped, so the ladder never implies a model supports a level.
 */
export const EFFORT_LADDER = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type EffortLevel = (typeof EFFORT_LADDER)[number];

/** Adapters whose `adapterConfig` an issue-level override can reach. */
const CLAUDE_LOCAL_EFFORTS: readonly EffortLevel[] = ["low", "medium", "high"];
const OPENCODE_LOCAL_EFFORTS: readonly EffortLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const CODEX_LOCAL_DEFAULT_EFFORTS: readonly EffortLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];
/** `codex-local/src/index.ts:44-51`. Astra, and only Astra, reaches max/ultra. */
const CODEX_LOCAL_ASTRA_EFFORTS: readonly EffortLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];
const CODEX_LOCAL_ASTRA_MODEL = "gpt-6-astra";

/**
 * Which `adapterConfig` key carries effort for this adapter, or `null` when
 * this plugin must not write one.
 *
 * `null` is the safe answer for every other adapter, deliberately. grok's
 * `reasoningEffort`, hermes's `--reasoning-effort` and pi's `thinking` are real
 * surfaces, but an issue-level override never reaches them
 * (`ISSUE_OVERRIDE_ADAPTER_TYPES`), so writing the key would be inert at best
 * and a silently-ignored pin at worst.
 */
export function effortConfigKeyFor(adapterType: string | null | undefined): string | null {
  switch (adapterType) {
    case "claude_local":
      return "effort";
    case "codex_local":
      return "modelReasoningEffort";
    case "opencode_local":
      return "variant";
    default:
      return null;
  }
}

/**
 * Read the effort an agent's `adapterConfig` already carries, under whichever
 * key this adapter spells it with.
 *
 * `codex_local` needs both names. `codex-args.ts:44-47` resolves
 * `modelReasoningEffort` and falls back to `reasoningEffort`, so a value parked
 * under the legacy key is just as live as one under the modern key. Writing
 * only `modelReasoningEffort` therefore does not reliably neutralize an illegal
 * inherited value — but it does WIN, because the fallback is only consulted when
 * the primary is empty, so the pin still decides. Reading both is what makes the
 * clamp see the value it is actually overriding.
 */
export function inheritedEffortFrom(
  adapterType: string | null | undefined,
  adapterConfig: Record<string, unknown> | null | undefined,
): string | null {
  if (!adapterConfig) return null;
  const key = effortConfigKeyFor(adapterType);
  if (key === null) return null;
  const primary = adapterConfig[key];
  if (typeof primary === "string" && primary.trim().length > 0) return primary;
  if (adapterType === "codex_local") {
    const legacy = adapterConfig.reasoningEffort;
    if (typeof legacy === "string" && legacy.trim().length > 0) return legacy;
  }
  return null;
}

/**
 * The legal effort values for this adapter running this model, or `null` when
 * the adapter has no reachable effort surface.
 */
export function effortVocabularyFor(
  adapterType: string | null | undefined,
  modelId: string | null | undefined,
): readonly EffortLevel[] | null {
  switch (adapterType) {
    case "claude_local":
      return CLAUDE_LOCAL_EFFORTS;
    case "opencode_local":
      return OPENCODE_LOCAL_EFFORTS;
    case "codex_local":
      return normalizeCodexModel(modelId) === CODEX_LOCAL_ASTRA_MODEL
        ? CODEX_LOCAL_ASTRA_EFFORTS
        : CODEX_LOCAL_DEFAULT_EFFORTS;
    default:
      return null;
  }
}

/**
 * codex's own model normalizer, mirrored exactly.
 *
 * `normalizeModelId` is `trim()` and nothing else — no lowercase, no namespace
 * strip (`codex-local/src/index.ts:24-26`) — and `normalizeCodexModel` then
 * applies one alias map (`:58-59`). The astra test is an exact string equality
 * on that result (`:65`).
 *
 * Mirroring it EXACTLY is the entire correctness argument, and normalizing more
 * eagerly is a bug, not a kindness. Roster ids on this fleet really are
 * namespaced — `cliproxy/gpt-6-astra` (`tests/fixtures/tier_roster.snapshot.json`),
 * `devin/gpt-6-astra` (`engine/lane-evidence.ts`) — and `modelOverrideForContext`
 * writes `model` verbatim. Strip the namespace here and those ids read as astra
 * (`max`/`ultra` legal) while the CLI reads them as DEFAULT and caps at `xhigh`:
 * the unhonourable pair this file exists to prevent, reintroduced one layer up.
 *
 * The rule the mirror encodes: judge the EXACT string we are about to write,
 * under the EXACT transformation the adapter will apply to it. Then the
 * vocabulary that authorized the value and the vocabulary that will honour it
 * cannot disagree.
 *
 * The alias map is vocabulary-neutral today — `gpt-5.6` and `gpt-5.6-sol` are
 * both DEFAULT — and is carried anyway so the mirror stays faithful the day an
 * alias does target astra. It is deliberately not mutation-gated: it has no
 * behaviour to kill yet.
 */
const CODEX_LOCAL_MODEL_ALIASES: Readonly<Record<string, string>> = {
  "gpt-5.6": "gpt-5.6-sol",
};

function normalizeCodexModel(modelId: string | null | undefined): string {
  const trimmed = typeof modelId === "string" ? modelId.trim() : "";
  return CODEX_LOCAL_MODEL_ALIASES[trimmed] ?? trimmed;
}

function ladderIndex(value: string): number {
  return (EFFORT_LADDER as readonly string[]).indexOf(value);
}

function normalizeEffort(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * The highest legal level no hotter than `requested`; when every legal level is
 * hotter (the request sits below the whole vocabulary), the coolest legal one.
 *
 * Both directions move toward the vocabulary rather than away from intent, and
 * both are reported as `clamped` so the change is never silent.
 */
function clampToVocabulary(
  requestedIndex: number,
  vocabulary: readonly EffortLevel[],
): EffortLevel | null {
  let best: EffortLevel | null = null;
  let bestIndex = -1;
  let coolest: EffortLevel | null = null;
  let coolestIndex = Number.POSITIVE_INFINITY;
  for (const candidate of vocabulary) {
    const index = ladderIndex(candidate);
    if (index < 0) continue;
    if (index < coolestIndex) {
      coolestIndex = index;
      coolest = candidate;
    }
    if (index <= requestedIndex && index > bestIndex) {
      bestIndex = index;
      best = candidate;
    }
  }
  return best ?? coolest;
}

export type EffortOutcome =
  /** Adapter has no issue-reachable effort surface. Write nothing. */
  | "adapter-unsupported"
  /** No roster effort and nothing illegal inherited. Write nothing. */
  | "none"
  /** Roster effort is legal for this model. Written verbatim. */
  | "pinned"
  /** Roster effort is a real level this model does not offer. Written clamped. */
  | "clamped"
  /** Roster effort is not a recognised level at all. Refused; nothing written. */
  | "rejected"
  /** No roster effort; the agent-level value is already legal. Left alone. */
  | "inherited-ok"
  /** No roster effort; the inherited value is illegal here. Written clamped. */
  | "neutralized-clamped"
  /** No roster effort; the inherited value is unrecognisable. Written empty. */
  | "neutralized-cleared";

export interface EffortPinInput {
  /** The assignee agent's adapter type, or `null`/absent when unknown. */
  adapterType: string | null | undefined;
  /** The model this pass selected. */
  modelId: string;
  /** The chosen roster row's `effort`, if the operator curated one. */
  rosterEffort?: string | null;
  /**
   * The effort the agent row already carries under this adapter's key, or
   * `null`/absent when the agent record could not be read.
   *
   * Load-bearing, and the mechanism behind the 2026-09-22 failure. The host
   * merges `{...agentAdapterConfig, ...issueAdapterConfig}`
   * (`heartbeat.ts:20838-20841`) — a shallow spread, per key. So an issue
   * override that OMITS effort does not mean "adapter default": it means
   * "whatever the agent row says", which is how a hand-set fleet-level `max`
   * survived a repin onto a `claude_local` model that caps at `high`. The only
   * way an issue pin can guarantee a coherent pair is to write the key when the
   * inherited value would be illegal.
   */
  inheritedEffort?: string | null;
}

export interface EffortPin {
  /**
   * The `adapterConfig` keys this pin writes, with their values. Empty when the
   * pin writes nothing at all.
   *
   * A MAP rather than one key/value pair, because clearing effort on
   * `codex_local` takes two writes. `asString` returns its fallback for an empty
   * string — `value.length > 0 ? value : fallback`,
   * `adapter-utils/src/server-utils.ts:437` — and codex's fallback is not `""`
   * but another key: `asString(modelReasoningEffort, asString(reasoningEffort, ""))`
   * (`codex-local/src/server/codex-args.ts:44-47`). So `modelReasoningEffort: ""`
   * alone does not clear anything; it hands the decision to the legacy key and
   * resurrects the very inherited value we were neutralizing. claude
   * (`asString(config.effort, "")`) and opencode (`asString(config.variant, "")`)
   * do have `""` as their fallback, so one write suffices there.
   */
  writes: Readonly<Record<string, string>>;
  outcome: EffortOutcome;
  /** Human-readable, always populated, safe for a decision trace. */
  reason: string;
}

/**
 * Every key that has to be emptied for this adapter to actually fall back to its
 * own default — see `EffortPin.writes` for why codex needs two.
 */
function clearWritesFor(
  adapterType: string | null | undefined,
  key: string,
): Record<string, string> {
  const writes: Record<string, string> = { [key]: "" };
  if (adapterType === "codex_local") writes.reasoningEffort = "";
  return writes;
}

/**
 * Decide the effort half of a model pin.
 *
 * Pure. The whole vocabulary policy is testable without a host, the same
 * property `planApply` has for the write policy.
 */
export function resolveEffortPin(input: EffortPinInput): EffortPin {
  const key = effortConfigKeyFor(input.adapterType);
  const vocabulary = effortVocabularyFor(input.adapterType, input.modelId);
  const nothing = (outcome: EffortOutcome, reason: string): EffortPin => ({
    writes: {},
    outcome,
    reason,
  });

  if (key === null || vocabulary === null) {
    return nothing(
      "adapter-unsupported",
      `adapter ${input.adapterType ?? "unknown"} has no issue-level effort surface; leaving effort untouched`,
    );
  }

  const legal = new Set<string>(vocabulary);
  const rosterEffort = normalizeEffort(input.rosterEffort);

  if (rosterEffort) {
    if (legal.has(rosterEffort)) {
      return {
        writes: { [key]: rosterEffort },
        outcome: "pinned",
        reason: `roster effort ${rosterEffort} is legal for ${input.modelId} on ${input.adapterType}`,
      };
    }
    const requestedIndex = ladderIndex(rosterEffort);
    if (requestedIndex < 0) {
      // Not a level we recognise, so there is no defensible clamp target. The
      // config schema's enum should have refused it upstream; this is the
      // belt-and-braces half of the same rule.
      return nothing(
        "rejected",
        `roster effort "${rosterEffort}" is not a recognised level; refusing to write an unverifiable pair for ${input.modelId}`,
      );
    }
    const clamped = clampToVocabulary(requestedIndex, vocabulary);
    if (clamped === null) {
      return nothing(
        "rejected",
        `no legal effort level for ${input.modelId} on ${input.adapterType}; refusing to write`,
      );
    }
    return {
      writes: { [key]: clamped },
      outcome: "clamped",
      reason: `roster effort ${rosterEffort} is not offered by ${input.modelId} on ${input.adapterType} (${vocabulary.join("|")}); clamped to ${clamped}`,
    };
  }

  // No curated effort for this row. The pin is still responsible for the PAIR,
  // so an inherited value that this model cannot honour has to be corrected
  // here — omission would let it through unchanged.
  const inherited = normalizeEffort(input.inheritedEffort);
  if (!inherited) {
    return nothing(
      "none",
      `no roster effort for ${input.modelId} and nothing inherited; leaving effort unset`,
    );
  }
  if (legal.has(inherited)) {
    return nothing(
      "inherited-ok",
      `no roster effort for ${input.modelId}; inherited ${inherited} is legal on ${input.adapterType}; left alone`,
    );
  }
  const inheritedIndex = ladderIndex(inherited);
  const clamped = inheritedIndex < 0 ? null : clampToVocabulary(inheritedIndex, vocabulary);
  if (clamped === null) {
    return {
      writes: clearWritesFor(input.adapterType, key),
      outcome: "neutralized-cleared",
      reason: `inherited effort "${inherited}" is illegal for ${input.modelId} on ${input.adapterType} and has no clamp target; emptying ${Object.keys(clearWritesFor(input.adapterType, key)).join(" and ")} so the adapter falls back to its own default`,
    };
  }
  return {
    writes: { [key]: clamped },
    outcome: "neutralized-clamped",
    reason: `inherited effort ${inherited} is illegal for ${input.modelId} on ${input.adapterType} (${vocabulary.join("|")}); clamped to ${clamped}`,
  };
}
