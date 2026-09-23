/**
 * TOG-4022: refuse a run's `usage_json.costUsd` as cost evidence when the
 * harness priced that run against the wrong provider's table.
 *
 * ## The defect, at its source
 *
 * `heartbeat_runs.usage_json.costUsd` is not computed by Paperclip. The
 * Claude CLI lane copies the figure the CLI itself reports:
 *
 *   packages/adapters/claude-local/src/server/parse.ts:117
 *     const costUsd = typeof costRaw === "number" && ... ? costRaw : null;
 *       // costRaw = finalResult.total_cost_usd, priced by the CLI
 *   packages/adapters/claude-local/src/server/execute.ts:1235-1236
 *     provider: "anthropic",
 *     biller: isBedrockAuth(effectiveEnv) ? "aws_bedrock" : "anthropic",
 *   packages/adapters/claude-local/src/server/acp.ts:187-188  (same literals)
 *
 * The `provider`/`biller` literals are unconditional. That is correct while
 * the CLI talks to Anthropic, and wrong the moment `ANTHROPIC_BASE_URL` points
 * the same CLI at a CLIProxy lane serving somebody else's model: the run is
 * stamped `anthropic` and the cost is the CLI's *Anthropic* price table
 * applied to a Meta/Devin/etc. model's token counts.
 *
 * Measured on this company, 7d to 2026-09-22 (`/costs/by-provider`, 200):
 * every `muse-spark-*` and `devin/*` row carries `provider: "anthropic",
 * biller: "anthropic"`. The genuinely separate adapters are fine —
 * `gpt-5.6-sol` records `openai`/`codex`, `glm-5.3` records `zai`/`zai` — so
 * this is specifically the Claude-CLI transport, not every adapter.
 *
 * ## Why this module exists rather than a fix at the source
 *
 * The source fix lives in `paperclipai/paperclip`, which this company cannot
 * file against. What we *can* do is stop consuming the bad values: TOG-4022
 * asked for "backfill or explicitly invalidate", and invalidate is the only
 * one available to a downstream consumer. Invalidating is also the honest
 * option — we do not know Meta's real price for our token mix, and inventing
 * one here would be a second confidently-wrong number.
 *
 * ## The predicate
 *
 * Deliberately narrow. We do NOT introduce a model -> provider table (that is
 * a second price-table-shaped thing to drift, and ADR-0001 already says we
 * have no trustworthy external price signal). We assert one invariant:
 *
 *   A run recorded as `provider: anthropic` is cost evidence only for a model
 *   that is actually an Anthropic model.
 *
 * Every other recorded provider is left alone, because every other provider
 * string in our data comes from an adapter that priced with that provider's
 * own table. A run with no recorded provider is also left alone: absence is
 * not evidence of misattribution, and rejecting it would silently discard the
 * pre-TOG-3132 history.
 */

/** The provider string the Claude CLI lane stamps unconditionally. */
const ANTHROPIC_PROVIDER = "anthropic";

/**
 * Legacy OmniRoute wrapper, same prefix `resolveConfiguredModelId` strips.
 * Repeated here rather than imported because this predicate runs on the *raw*
 * observed id as well as the resolved one.
 */
const OMNIROUTE_PROVIDER_PREFIX = "cliproxy/";

/**
 * Anthropic's own model ids as they appear in our roster and in
 * `usage_json.model`: `claude-opus-5`, `claude-sonnet-5`,
 * `claude-haiku-4-5-20251001`, `claude-fable-5-1`, optionally `cliproxy/`
 * wrapped, plus the explicit `anthropic/` vendor namespace.
 *
 * Anchored, and matching on the id's *namespace*, never a substring: a model
 * named `muse-spark-claude-compat` must not pass by containing "claude".
 */
const ANTHROPIC_MODEL_ID_RE = /^(?:anthropic\/)?claude(?:[-.][a-z0-9.-]*)?$/i;

/** True when `modelId` names a model Anthropic actually serves and prices. */
export function isAnthropicModelId(modelId: string): boolean {
  const trimmed = modelId.trim();
  const bare = trimmed.toLowerCase().startsWith(OMNIROUTE_PROVIDER_PREFIX)
    ? trimmed.slice(OMNIROUTE_PROVIDER_PREFIX.length)
    : trimmed;
  return ANTHROPIC_MODEL_ID_RE.test(bare);
}

export interface CostAttributionVerdict {
  /** False when `costUsd` was priced against a table that is not this model's. */
  attributable: boolean;
  /** Human-readable cause, for the refresh log and the ledger's own audit. */
  reason: string;
}

/**
 * Decide whether a run's recorded cost may be used as evidence about
 * `modelId`. `recordedProvider` is `usage_json.provider` verbatim (null/empty
 * when the run predates provider capture).
 */
export function classifyCostAttribution(
  modelId: string,
  recordedProvider: string | null | undefined,
): CostAttributionVerdict {
  const provider = (recordedProvider ?? "").trim().toLowerCase();
  if (!provider) {
    return { attributable: true, reason: "no provider recorded on the run" };
  }
  if (provider !== ANTHROPIC_PROVIDER) {
    return { attributable: true, reason: `run priced by ${provider}` };
  }
  if (isAnthropicModelId(modelId)) {
    return { attributable: true, reason: "anthropic-priced run on an anthropic model" };
  }
  return {
    attributable: false,
    reason: `run recorded provider=anthropic for non-anthropic model ${modelId}; cost priced against the wrong table (TOG-4022)`,
  };
}

/**
 * `costUsd` when the run may be used as cost evidence for `modelId`, null when
 * it may not. Null is the ledger's existing "unknown cost" value: a candidate
 * with no `costPerAcceptedCard` is *dropped* from `orderByCostPerAcceptedCard`
 * rather than ranked, so invalidation degrades to the list-price ordering
 * instead of ranking a misattributed model as cheap or expensive.
 */
export function attributableCostUsd(
  modelId: string,
  recordedProvider: string | null | undefined,
  costUsd: number | null,
): number | null {
  if (costUsd === null) return null;
  return classifyCostAttribution(modelId, recordedProvider).attributable ? costUsd : null;
}
