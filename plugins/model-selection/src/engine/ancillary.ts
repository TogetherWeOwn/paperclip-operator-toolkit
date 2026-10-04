import { resolveConfiguredModelId } from "./model-id.js";
import type { SelectionConfig } from "./select.js";
import { selectModel } from "./select.js";
import type { QualitySignal, SelectionDecision, VolumeProfile } from "./types.js";

/**
 * Fixed-name ancillary env surfaces. `ANTHROPIC_DEFAULT_*`
 * is deliberately NOT enumerated here — the CTO directive lists it separately
 * from `ANTHROPIC_DEFAULT_HAIKU_MODEL`, naming it as a family, not a single
 * key (an install may also carry e.g. `ANTHROPIC_DEFAULT_OPUS_MODEL`). See
 * `ANTHROPIC_DEFAULT_PREFIX` below for how that family is matched.
 *
 * All of these are console-only: `adapterConfig` is 403 to every agent,
 * structurally (confirmed against the plugin SDK's actual client surface —
 * `ctx.agents` has no write method at all, and `ctx.http.fetch` is
 * SSRF-blocked from reaching the host's own internal API even as a
 * workaround).
 *
 * `runtimeConfig.modelProfiles.cheap` was a fifth ancillary surface
 * here until Paperclip migration 0236 (v2026.916.0) deleted the column with
 * no replacement — there is no longer a distinct "cheap/recovery model"
 * concept on the host at all, so there is nothing left to read or report
 * drift against. Removed rather than snapshotted: a frozen copy of a value
 * the host no longer has any concept of would just be reporting drift
 * against a fiction.
 */
export const ANCILLARY_ENV_KEYS = ["ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"] as const;
export type AncillaryEnvKey = (typeof ANCILLARY_ENV_KEYS)[number];

/** Any env key in this family is an ancillary surface, not just `ANTHROPIC_DEFAULT_HAIKU_MODEL`. */
export const ANTHROPIC_DEFAULT_PREFIX = "ANTHROPIC_DEFAULT_";

export type AncillarySurfaceKey = string;

/** Why this plugin cannot write the surface itself. */
export function remediationFor(_surface: AncillarySurfaceKey): string {
  return "console only — adapterConfig is 403 to every agent, structurally; this plugin has no write path to it either";
}

export interface AncillarySurfaceReading {
  surface: AncillarySurfaceKey;
  currentModelId: string | null;
  /** True when the surface is bound to a secret and its value cannot be read or compared. */
  unresolvable: boolean;
}

export interface AncillarySurfaceDrift extends AncillarySurfaceReading {
  agentId: string;
  agentName: string;
  recommendedModelId: string;
  remediation: string;
}

/**
 * The lane-aware T3 recommendation, computed through the SAME engine as
 * main-model dispatch — tier ladder, serviceability hard stop, pace ordering,
 * slot throttle, all of it — rather than a constant baked in at agent hire
 * time. Reusing `selectModel` with a synthetic T3-labelled descriptor is
 * deliberate: it is the only way to guarantee this recommendation can never
 * drift from what an ordinary T3 issue would actually be routed to.
 */
export function recommendAncillaryModel(input: {
  config: Pick<
    SelectionConfig,
    "models" | "holdOnUntrustedProfile" | "pacingMode" | "laneLedger" | "slotFloorFraction"
  >;
  profiles: readonly VolumeProfile[];
  signals: readonly QualitySignal[];
  now: number;
}): SelectionDecision {
  return selectModel({
    descriptor: { issueId: "__ancillary_t3__", labelNames: ["tier:T3"] },
    config: {
      ...input.config,
      // Always advisory: a company-wide ancillary recommendation is never
      // something this tool writes, regardless of `selection.mode`.
      enforcementEnabled: false,
      defaultTier: "T3",
      stickyWithinIssue: false,
      operatorOverrideModelId: null,
    },
    profiles: input.profiles,
    signals: input.signals,
    now: input.now,
  });
}

function envBindingModelId(binding: unknown): { modelId: string | null; unresolvable: boolean } {
  if (typeof binding === "string") return { modelId: binding, unresolvable: false };
  if (binding && typeof binding === "object") {
    const record = binding as Record<string, unknown>;
    if (record.type === "plain" && typeof record.value === "string") {
      return { modelId: record.value, unresolvable: false };
    }
    if (record.type === "secret_ref" || record.type === "user_secret_ref") {
      return { modelId: null, unresolvable: true };
    }
  }
  return { modelId: null, unresolvable: false };
}

export interface AncillaryAgentLike {
  id: string;
  name: string;
  adapterConfig: Record<string, unknown> | null | undefined;
}

/** Read the ancillary env surfaces off one agent. Read-only, same as everywhere else `ctx.agents` is used in this plugin. */
export function readAncillarySurfaces(agent: AncillaryAgentLike): AncillarySurfaceReading[] {
  const readings: AncillarySurfaceReading[] = [];

  const env =
    agent.adapterConfig && typeof agent.adapterConfig === "object"
      ? ((agent.adapterConfig as Record<string, unknown>).env as Record<string, unknown> | undefined)
      : undefined;
  if (env && typeof env === "object") {
    const ancillaryKeys = new Set<string>(ANCILLARY_ENV_KEYS);
    for (const key of Object.keys(env)) {
      if (!ancillaryKeys.has(key) && !key.startsWith(ANTHROPIC_DEFAULT_PREFIX)) continue;
      const { modelId, unresolvable } = envBindingModelId(env[key]);
      readings.push({ surface: key, currentModelId: modelId, unresolvable });
    }
  }

  return readings;
}

/**
 * Which of this agent's ancillary surfaces disagree with the lane-aware T3
 * recommendation. A secret-bound surface is never reported: its value cannot
 * be read, so agreement or drift is genuinely unknown, not "not drifted".
 */
export function ancillaryDriftForAgent(
  agent: AncillaryAgentLike,
  recommendedModelId: string | null,
  models: SelectionConfig["models"] = [],
): AncillarySurfaceDrift[] {
  if (!recommendedModelId) return [];
  return readAncillarySurfaces(agent)
    .filter((reading) => {
      if (reading.unresolvable || reading.currentModelId === null) return false;
      const configuredModelId = resolveConfiguredModelId(reading.currentModelId, models);
      return (configuredModelId ?? reading.currentModelId) !== recommendedModelId;
    })
    .map((reading) => ({
      ...reading,
      agentId: agent.id,
      agentName: agent.name,
      recommendedModelId,
      remediation: remediationFor(reading.surface),
    }));
}
