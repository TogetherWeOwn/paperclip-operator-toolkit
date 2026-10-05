import type { PacingMode, Tier } from "../constants.js";
import {
  blendedListPrice,
  hardStopExcluded,
  laneAvoidExcluded,
  laneOutageExcluded,
  type LaneAvoidConfig,
  type LaneLedger,
  type LaneOutageOverride,
} from "./pacing.js";
import { inheritedEffortFrom, resolveEffortPin, type EffortPin } from "./effort.js";
import { isAdapterBlockedModel } from "./model-id.js";
import { tierScoreFor } from "./scores.js";
import type { ModelEntry, ModelScore } from "./types.js";

export const CONTEXT_LIMIT_ENV_KEY = "CLAUDE_CODE_MAX_CONTEXT_TOKENS";

/**
 * (thrash incident 2026-09-19/20). Floor for the per-pin stamped
 * cap: Claude Code starts every run with ~45k fixed context, so a 128k stamp
 * thrashed autocompact and killed ~1 in 4 runs. Never stamp below 250k when
 * the window allows; a window under 250k gets its full window.
 */
export const MIN_STAMPED_CONTEXT_TOKENS = 250_000;

/**
 * Plugin-owned override env key that marks a pin on a
 * `fallbackOnly` model. A fallback pin outlives the
 * capacity gap that justified it: `stickyModelId = pinnedModelId` keeps it,
 * and nothing revisited it until the 24 h expiry. The stamp lets the fallback
 * lease pass find exactly these pins, through the index in plugin state,
 * without walking every open issue.
 *
 * It lives in the override env because that is the only per-issue place the
 * plugin writes; the value is a plain JSON string, never a secret.
 */
export const PIN_PROVENANCE_ENV_KEY = "MODEL_SELECTION_PIN_PROVENANCE";

/** What {@link PIN_PROVENANCE_ENV_KEY} carries. */
export interface PinProvenance {
  /** Minted per pin write; the index entry must match it to stay live. */
  decisionId: string;
  /** The assignee the fallback was decided for, or null when unknown. */
  agentId: string | null;
  fallback: true;
  decidedAt: string;
}

/**
 * The provenance stamp in an override env, or null when there is none or it
 * does not parse. A malformed stamp reads as absent: the lease pass then
 * leaves the pin to the ordinary 24 h expiry rather than act on a guess.
 */
export function readPinProvenance(env: AdapterEnv | null | undefined): PinProvenance | null {
  const entry = env?.[PIN_PROVENANCE_ENV_KEY];
  const raw =
    typeof entry === "string"
      ? entry
      : entry && typeof entry === "object" && (entry as Record<string, unknown>).type === "plain"
        ? (entry as Record<string, unknown>).value
        : undefined;
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.decisionId !== "string" || !record.decisionId) return null;
  if (record.fallback !== true) return null;
  if (typeof record.decidedAt !== "string" || !Number.isFinite(Date.parse(record.decidedAt))) return null;
  const agentId = typeof record.agentId === "string" ? record.agentId : null;
  return { decisionId: record.decisionId, agentId, fallback: true, decidedAt: record.decidedAt };
}

export interface ContextEstimate {
  tokens: number | null;
  source: "explicit" | "last-run-peak" | "fleet-ceiling-fallback" | "none";
}

export interface ContextEstimateInput {
  explicitTokens?: number;
  /** Maximum complete single-turn prompt, never cumulative run billing usage. */
  lastRunPeakTokens?: number | null;
  history?: "run-found" | "no-history" | "unavailable";
  fleetCeilingTokens: number;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

/**
 * Explicit requirements and observed single-turn peaks are never capped: a
 * compaction setting is not evidence that a larger prompt did not occur.
 * Run/tier billing totals are deliberately not accepted by this interface.
 * For an existing run without usable peak evidence (or a failed history read),
 * fall back conservatively to the configured fleet ceiling, labelled as such.
 * A verified first run has no historical estimate.
 */
export function estimateIssueContext(input: ContextEstimateInput): ContextEstimate {
  const explicit = positiveInteger(input.explicitTokens);
  if (explicit !== null) return { tokens: explicit, source: "explicit" };

  const peak = positiveInteger(input.lastRunPeakTokens);
  if (peak !== null) return { tokens: peak, source: "last-run-peak" };

  if (input.history === "run-found" || input.history === "unavailable") {
    return {
      tokens: positiveInteger(input.fleetCeilingTokens),
      source: "fleet-ceiling-fallback",
    };
  }
  return { tokens: null, source: "none" };
}

export type AdapterEnv = Record<string, unknown>;

/**
 * The sub-call model surfaces a pin must carry alongside the main
 * model, or the evacuation is partial.
 *
 * measured the fleet (`docs/routing/-lane-exhaustion-autoheal.md`
 * §#1b): 24 of 26 agents point both of these at the CLIProxy Codex lane. Repin
 * the main model away from an exhausted lane and leave these behind, and the
 * card's haiku-class sub-calls still resolve to the dead lane — a run that reads
 * as successfully evacuated and then fails on a sub-call.
 *
 * Deliberately NOT in any list here:
 *
 * - `runtimeConfig.modelProfiles.cheap` — genuinely unreachable from here. It is
 *   read off the agent row only (`readAgentRuntimeModelProfile`,
 *   `heartbeat.ts:~1246`) and `assigneeAdapterOverrides` never touches it, so
 *   covering it needs an agent-row write. Forbidden per the owner rule and
 *   ADR-0010; it is on the doc's core-blocked list.
 */
export const ANCILLARY_MODEL_ENV_KEYS = [
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
] as const;

/**
 * The main-lane sub-call surfaces: env keys whose value should track
 * the model the pin itself selected, not a cheaper pick.
 *
 * Measured 2026-09-17 on the 16:40Z Codex exhaustion: 118 open cards
 * carried a live main-model pin plus all six sub-call keys still frozen on the
 * exhausted lane.  moved the two haiku-class keys and deferred these
 * four; the 00:0xZ board sweep showed the deferred four are the bulk of the
 * dead surface. They resolve to the pin's own model: `PAPERCLIP_ASSIGNED_MODEL`
 * and `CLAUDE_CODE_SUBAGENT_MODEL` are the run/subagent main models in all but
 * name, and `ANTHROPIC_DEFAULT_OPUS_MODEL`/`ANTHROPIC_DEFAULT_SONNET_MODEL` are
 * the harness's fallbacks for exactly the class of work the pin was chosen for.
 * A sub-call on the pin's healthy lane beats a cheap one on a dead lane.
 */
export const PIN_LANE_MODEL_ENV_KEYS = [
  "PAPERCLIP_ASSIGNED_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
] as const;

/**
 * The target for the cheap (haiku-class) sub-call keys: the cheapest model of
 * `tier` that every health gate currently passes, or null when none qualifies.
 *
 * Health mirrors `isUsableAndCapable` minus the context-window term (a sub-call
 * does not carry the issue's prompt): hard-stop, lane-avoid, lane-outage, and
 * the measured capability score for the tier. Ordering is `blendedListPrice`
 * ascending with roster order as the stable tiebreak — the same list-price
 * term the "list-price" objective orders candidates by, without the
 * profile-dependent `costOf` terms a sub-call surface has no profile for.
 * `fallbackOnly` rows are excluded for the same reason `selectModel` excludes
 * them: they exist to catch escalation, not to serve requests.
 */
export function cheapestHealthyModelIdForTier(input: {
  models: readonly ModelEntry[];
  tier: Tier;
  ledger: LaneLedger;
  laneOutageOverride: LaneOutageOverride | null;
  nowIso: string;
  modelScores: Readonly<Record<string, ModelScore>>;
  laneAvoidConfig: LaneAvoidConfig;
  pacingMode: PacingMode;
}): string | null {
  const candidates = input.models.filter(
    (model) => model.enabled && !model.fallbackOnly && model.tier === input.tier,
  );
  const healthy = candidates.filter((model) => {
    if (input.pacingMode === "off") return true;
    if (hardStopExcluded(input.ledger, model)) return false;
    if (laneAvoidExcluded(input.ledger, model, input.laneAvoidConfig)) return false;
    if (laneOutageExcluded(input.laneOutageOverride, input.nowIso, model)) return false;
    const score = tierScoreFor(input.modelScores[model.id], input.tier);
    if (score?.capable === false) return false;
    return true;
  });
  healthy.sort((left, right) => blendedListPrice(left) - blendedListPrice(right));
  return healthy[0]?.id ?? null;
}

/** All six model-valued sub-call env surfaces, in one list for drift scanning. */
export const ALL_MODEL_ENV_KEYS = [
  ...PIN_LANE_MODEL_ENV_KEYS,
  ...ANCILLARY_MODEL_ENV_KEYS,
] as const;

/**
 * , remediation half. True when any model-valued sub-call env key on an
 * existing override points at a model that is currently excluded — the "pin
 * healthy, sub-calls dead" state.
 *
 * This exists because every other balance-pass write reason (`cheaper`,
 * `incapable`, `busier`) reads off the PIN. A card whose pin is correct and
 * whose env is frozen on a dead lane satisfies none of them, and the pass
 * short-circuits on `decision.modelId === pinnedModelId` before it would reach
 * them anyway. Measured 2026-09-17: 149 of 175 overridden open cards were in
 * exactly this state, and only 3 had a dead pin — so without this predicate the
 * evacuation fix is inert for the entire already-frozen board.
 *
 * Exclusion is the same set of gates `cheapestHealthyModelIdForTier` applies,
 * so "dead" means one thing in this plugin. Deliberately NOT drift-vs-desired:
 * an env key merely differing from what we would write today is not a defect
 * and must not trigger churn. Only a key on an excluded lane does.
 *
 * Secret-bound and unparseable values are never "dead" — we cannot read what
 * they resolve to, and `modelOverrideForContext` refuses to overwrite them, so
 * reporting them would produce a write that cannot fix them.
 */
export function overrideEnvOnExcludedLane(input: {
  existingOverrideEnv: AdapterEnv | null | undefined;
  models: readonly ModelEntry[];
  ledger: LaneLedger;
  laneOutageOverride: LaneOutageOverride | null;
  nowIso: string;
  laneAvoidConfig: LaneAvoidConfig;
  pacingMode: PacingMode;
}): boolean {
  if (input.pacingMode === "off") return false;
  const env = input.existingOverrideEnv;
  if (!env) return false;
  for (const key of ALL_MODEL_ENV_KEYS) {
    const entry = env[key];
    if (entry === undefined || isSecretBinding(entry)) continue;
    const raw =
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object"
          ? (entry as Record<string, unknown>).value
          : undefined;
    if (typeof raw !== "string" || !raw) continue;
    const model = input.models.find((candidate) => candidate.id === raw);
    // An env value naming no configured model is stale in a way this pass
    // cannot reason about (a retired id, a hand edit). Leave it alone rather
    // than guess; the agent-surface sweep reports those separately.
    if (!model) continue;
    if (hardStopExcluded(input.ledger, model)) return true;
    if (laneAvoidExcluded(input.ledger, model, input.laneAvoidConfig)) return true;
    if (laneOutageExcluded(input.laneOutageOverride, input.nowIso, model)) return true;
  }
  return false;
}

/**
 * A secret-bound env value. We can neither read what it resolves to nor
 * reconstruct it, so we never overwrite one — the same rule
 * `ancillaryDriftForAgent` applies when it refuses to call a secret-bound
 * surface "drifted".
 */
function isSecretBinding(binding: unknown): boolean {
  if (!binding || typeof binding !== "object") return false;
  const type = (binding as Record<string, unknown>).type;
  return type === "secret_ref" || type === "user_secret_ref";
}

/**
 * The secret a binding resolves through: `secret_ref` names a
 * company secret by `secretId`, `user_secret_ref` a user secret by `key`.
 * `version` is deliberately not part of it — the host's binding row is keyed
 * on the secret and the config path only (`secrets.ts` `getBinding`).
 */
function secretBindingIdentity(binding: unknown): string | null {
  if (!isSecretBinding(binding)) return null;
  const record = binding as Record<string, unknown>;
  const ref = record.type === "secret_ref" ? record.secretId : record.key;
  return typeof ref === "string" && ref.length > 0 ? `${String(record.type)}:${ref}` : null;
}

/**
 * Keys of an existing override env that bind a secret the
 * assignee's own env does not carry under the same key — sorted, so the
 * result is stable in a trace.
 *
 * This mirrors the host's pre-dispatch check. Saving an agent's env replaces
 * every `env.*` binding/declaration row for that agent with exactly the refs
 * in it, and the check looks each merged-env ref up by (secret, agent,
 * `env.<KEY>`) — so a ref the agent env does not carry at that key has no row,
 * and the run fails `configuration_incomplete` before a session starts
 *. That happens to a pin snapshotted under an earlier
 * assignee, or one whose secret was since unbound from the agent.
 *
 * Only refs the host would refuse are reported: a malformed ref fails the
 * host's schema parse and is never checked, and a `user_secret_ref` that is
 * not required, or allows a missing override, never blocks a run. When the
 * assignee env is UNKNOWN nothing is reported, because we cannot tell a stale
 * ref from a live one.
 */
export function staleOverrideSecretRefKeys(
  existingOverrideEnv: AdapterEnv | null | undefined,
  agentEnv: AdapterEnv | null | undefined,
): string[] {
  if (!existingOverrideEnv || agentEnv === null || agentEnv === undefined) return [];
  const stale: string[] = [];
  for (const [key, binding] of Object.entries(existingOverrideEnv)) {
    const identity = secretBindingIdentity(binding);
    if (identity === null) continue;
    const record = binding as Record<string, unknown>;
    if (record.type === "user_secret_ref" && (record.required === false || record.allowMissingOverride === true)) {
      continue;
    }
    if (identity !== secretBindingIdentity(agentEnv[key])) stale.push(key);
  }
  return stale.sort();
}

export interface ModelOverrideInput {
  model: Pick<ModelEntry, "id" | "contextWindow"> & Partial<Pick<ModelEntry, "effort">>;
  /**
   * The agent-level context cap the per-pin
   * `CLAUDE_CODE_MAX_CONTEXT_TOKENS` stamp compares against — split from the
   * admission ceiling (`fleetContextCeilingTokens`, held at 200k for glm-5.3),
   * which `estimateIssueContext` still takes separately. Stamp
   * `max(floor(window*ratio), min(window, MIN_STAMPED_CONTEXT_TOKENS))` when
   * the pin's window is below THIS cap; remove the key (inherit the agent
   * env) when at or above it. Unset in config resolves to the fleet ceiling,
   * so behaviour is unchanged until the operator sets it. A missing
   * `contextWindow` keeps today's semantics: no stamp.
   */
  agentEnvContextTokens: number;
  compactionRatio: number;
  /**
   * The assignee agent's `adapterType`, or `null`/absent when UNKNOWN.
   *
   * Decides both which `adapterConfig` key carries effort and which values are
   * legal, so without it we write no effort at all — the same
   * unknown-suppresses-the-write rule `agentEnv` follows below.
   */
  agentAdapterType?: string | null;
  /**
   * The assignee agent's whole `adapterConfig`, or `null`/absent when
   * UNKNOWN. Only its effort key is read, under whichever name this adapter
   * uses; the pin needs it because the host merges per key, so an effort we do
   * not overwrite is an effort we have silently endorsed.
   */
  agentAdapterConfig?: AdapterEnv | null;
  /**
   * The assignee agent's `adapterConfig.env`, or `null`/absent when it is
   * UNKNOWN — no assignee, or the agent read failed.
   *
   * The distinction is load-bearing, not cosmetic. Because the host replaces the
   * whole `env` object (see below), writing an env map we built from an unknown
   * base would delete every binding the agent actually carries — GH tokens and
   * all. So an unknown agent env suppresses the ancillary writes entirely: the
   * main model pin still lands, and the run keeps the agent's env untouched.
   * A known-but-empty env (`{}`) is a different fact and does get them.
   */
  agentEnv?: AdapterEnv | null;
  existingOverrideEnv?: AdapterEnv;
  /**
   * Target for the two haiku-class sub-call keys: the cheapest
   * healthy T3 model, resolved by `cheapestHealthyModelIdForTier` at the call
   * site. NOT the main pin — pinning `ANTHROPIC_SMALL_FAST_MODEL` to a T1
   * model would price every background haiku-class call at T1 rates.
   *
   * Null/absent (no healthy T3 model, or a caller that could not resolve one)
   * falls back to the main pin: a sub-call on the pin's healthy lane beats a
   * cheap one left on a dead lane. The empty-string case is treated the same
   * as null so a malformed resolution can never blank the keys.
   */
  cheapModelId?: string | null;
  /**
   * The fallback stamp to write under {@link PIN_PROVENANCE_ENV_KEY},
   * or null/absent for a pin that is not a fallback. Absent never carries an
   * old stamp forward: a stamp describes one decision, and a new pin is a new
   * decision. A caller that keeps the decision (the reassignment rebuild)
   * passes the existing stamp explicitly.
   */
  provenance?: PinProvenance | null;
}

/**
 * Env keys this plugin writes, and is therefore entitled to carry forward from
 * a previous pin. Everything else in an existing override is a value some other
 * writer owns, which this plugin can neither re-derive nor re-validate.
 */
const PLUGIN_OWNED_ENV_KEYS: readonly string[] = [CONTEXT_LIMIT_ENV_KEY];

/**
 * Build the complete issue-level adapter override.
 *
 * The host shallow-spreads `issueOverrides.adapterConfig` over the agent
 * adapter config — `{...baseConfig, ...modelProfile.adapterConfig, ...issueAdapterConfig}`,
 * `mergeModelProfileAdapterConfig`, `heartbeat.ts:3705-3714` — so an issue-level
 * `env` object replaces the agent's `env` object wholesale, per key it does not
 * carry included. Merge the maps here before writing; otherwise adding the
 * compaction ceiling or a sub-call pin silently deletes every unrelated agent
 * env binding.
 *
 * The agent side of that merge (`agentEnv`) is re-read from the agent record on
 * every pass (`worker.ts` describeIssue), so it always describes the assignee as
 * of now. The existing override is not: it is a snapshot written by an earlier
 * repin, under whatever assignment held at the time. Spreading it wholesale
 * ratchets that snapshot onto every later pin — so reassigning a card injects
 * the previous assignee's secret refs, and unbinding a secret never
 * takes effect because the pin keeps re-supplying the dead ref. So when the
 * assignee env is KNOWN we rebuild from it and carry forward only the keys this
 * plugin owns; the assignee's own bindings come back from `agentEnv`, the source
 * of truth, and never needed the snapshot. When the assignee env is UNKNOWN we
 * cannot rebuild, so we fall back to preserving the existing override rather than
 * clobber bindings we cannot see — except the model-owned surfaces
 * (`CONTEXT_LIMIT_ENV_KEY`, `PIN_LANE_MODEL_ENV_KEYS`,
 * `ANCILLARY_MODEL_ENV_KEYS`, ), which are re-derived against the new
 * model below so a repin never leaves them pointing at the model it just
 * moved off.
 *
 * the same per-key merge is why effort is decided HERE rather than at
 * the six call sites. `model` and its effort have to leave as one patch, or the
 * steady state is a pinned model paired with an effort it never offered.
 * `effortPinForOverride` exposes the decision for a trace; the value itself is
 * already in the patch.
 */
export function modelOverrideForContext(input: ModelOverrideInput): {
  assigneeAdapterOverrides: {
    adapterConfig: {
      model: string;
      env?: AdapterEnv;
      /** `claude_local`. Present only when this pass decided an effort. */
      effort?: string;
      /** `codex_local`. */
      modelReasoningEffort?: string;
      /**
       * `codex_local`'s legacy effort key. Written ONLY to empty it alongside
       * `modelReasoningEffort`, because codex resolves one from the other and
       * `asString` treats `""` as absent — see `EffortPin.writes`.
       */
      reasoningEffort?: string;
      /** `opencode_local`. */
      variant?: string;
    };
  };
} {
  const agentEnvKnown = input.agentEnv !== null && input.agentEnv !== undefined;
  const agentEnv = input.agentEnv ?? {};
  const overrideEnv = input.existingOverrideEnv ?? {};
  // Known assignee: rebuild from `agentEnv` and carry forward only plugin-owned
  // keys from the old pin. Unknown assignee: we have no current base to rebuild
  // from, so preserve the existing override instead of clobbering unseen bindings.
  let carriedOverrideEnv: AdapterEnv;
  if (agentEnvKnown) {
    carriedOverrideEnv = {};
    for (const key of PLUGIN_OWNED_ENV_KEYS) {
      if (key in overrideEnv) carriedOverrideEnv[key] = overrideEnv[key];
    }
  } else {
    carriedOverrideEnv = overrideEnv;
  }
  const env: AdapterEnv = { ...agentEnv, ...carriedOverrideEnv };
  const agentEnvCap = positiveInteger(input.agentEnvContextTokens);
  const modelWindow = positiveInteger(input.model.contextWindow);
  const ratio =
    Number.isFinite(input.compactionRatio) && input.compactionRatio > 0 && input.compactionRatio < 1
      ? input.compactionRatio
      : 0.75;

  if (agentEnvCap !== null && modelWindow !== null && modelWindow < agentEnvCap) {
    env[CONTEXT_LIMIT_ENV_KEY] = {
      type: "plain",
      value: String(
        Math.max(
          Math.floor(modelWindow * ratio),
          Math.min(modelWindow, MIN_STAMPED_CONTEXT_TOKENS),
        ),
      ),
    };
  } else {
    delete env[CONTEXT_LIMIT_ENV_KEY];
  }

  // move every model-valued sub-call key off the lane the override
  // was frozen on. The main-lane keys follow the pin; the two haiku-class keys
  // follow the cheapest healthy T3 pick when one exists (a sub-call on a live
  // lane beats a cheap one on a dead lane, but a T1-priced background call is
  // its own defect), falling back to the pin when none does. Secret-bound
  // values are never touched — we cannot reconstruct what they resolve to.
  //
  // never write a `devin/*` value for a `claude_local` assignee.
  // Devin's content filter rejects the Claude Code / Agent SDK system banner
  // (Cognition ticket 71806) — the main-model gate in `select.ts` excludes
  // this pair, so these writes must not reintroduce it through the side door.
  // The whole block is suppressed when the pin itself is blocked, and the
  // cheap pick falls back to the pin when IT is blocked (the pin cleared the
  // gate to be chosen at all). An unknown adapter still gets the write:
  // unknown never excludes.
  // the unknown-assignee rule matches what main already did for the
  // haiku-class keys — re-derive only keys the snapshot already carries, never
  // introduce new keys into a base we cannot see. Otherwise a repin off a dead
  // lane leaves the sub-calls resolving to it.
  const ancillaryBlocked = isAdapterBlockedModel(input.model.id, input.agentAdapterType);
  if (!ancillaryBlocked) {
    for (const key of PIN_LANE_MODEL_ENV_KEYS) {
      if (!agentEnvKnown && !(key in overrideEnv)) continue;
      if (isSecretBinding(env[key])) continue;
      env[key] = { type: "plain", value: input.model.id };
    }
    const cheapPick = input.cheapModelId || input.model.id;
    const cheapId = isAdapterBlockedModel(cheapPick, input.agentAdapterType)
      ? input.model.id
      : cheapPick;
    for (const key of ANCILLARY_MODEL_ENV_KEYS) {
      if (!agentEnvKnown && !(key in overrideEnv)) continue;
      if (isSecretBinding(env[key])) continue;
      env[key] = { type: "plain", value: cheapId };
    }
  }

  // the stamp follows this decision only. Dropped first so an
  // unknown-assignee carry cannot keep a stamp from an earlier pin. Written
  // only into an env that is being written anyway: with an unknown assignee
  // and no override env, a stamp-only env would replace the agent's whole
  // env, bindings included, for the run.
  delete env[PIN_PROVENANCE_ENV_KEY];
  if (input.provenance && (agentEnvKnown || Object.keys(env).length > 0)) {
    env[PIN_PROVENANCE_ENV_KEY] = { type: "plain", value: JSON.stringify(input.provenance) };
  }

  const mustWriteEnv =
    Object.keys(env).length > 0 ||
    CONTEXT_LIMIT_ENV_KEY in agentEnv ||
    CONTEXT_LIMIT_ENV_KEY in overrideEnv;

  const effortPin = effortPinForOverride(input);

  return {
    assigneeAdapterOverrides: {
      adapterConfig: {
        model: input.model.id,
        ...effortPin.writes,
        ...(mustWriteEnv ? { env } : {}),
      },
    },
  };
}

/**
 * The effort half of the pin `modelOverrideForContext` is about to write.
 *
 * Exported so a caller can put the outcome in a decision trace without
 * rebuilding the inputs, and so the eval that judges a model change can tell a
 * clamp from a request. Calling it twice is free — it is pure, and it reads the
 * same `input`, so it cannot disagree with the patch.
 */
export function effortPinForOverride(input: ModelOverrideInput): EffortPin {
  return resolveEffortPin({
    adapterType: input.agentAdapterType,
    modelId: input.model.id,
    rosterEffort: input.model.effort,
    inheritedEffort: inheritedEffortFrom(input.agentAdapterType, input.agentAdapterConfig),
  });
}
