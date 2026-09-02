import type { Tier } from "../constants.js";
import { TIERS } from "../constants.js";
import type { ModelEntry } from "../engine/types.js";

export interface ResolvedConfig {
  selection: {
    enabled: boolean;
    mode: "advise" | "enforce";
    defaultTier: Tier;
    stickyModelWithinIssue: boolean;
    holdOnUntrustedProfile: boolean;
  };
  models: ModelEntry[];
  /**
   * Operator-supplied label ids per tier. Partial by design: a tier with no id
   * simply gets no label written. See the schema for why these cannot be looked
   * up by name.
   */
  tierLabelIds: Partial<Record<Tier, string>>;
  profiles: { windowDays: number; minSamples: number; maxAgeDays: number };
  quality: { t1EscalationCeiling: number; t2EscalationCeiling: number; silentFailureWeight: number };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function tier(value: unknown, fallback: Tier): Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value)
    ? (value as Tier)
    : fallback;
}

/**
 * Defaults are chosen so that an unconfigured install is inert: advise mode,
 * T3 default tier, hold on an untrusted profile. Nothing about installing this
 * plugin changes a live selection variable until someone sets `mode: enforce`.
 */
export function resolveConfig(raw: Record<string, unknown> | null | undefined): ResolvedConfig {
  const root = record(raw);
  const selection = record(root.selection);
  const profiles = record(root.profiles);
  const quality = record(root.quality);

  const models: ModelEntry[] = Array.isArray(root.models)
    ? root.models.flatMap((entry) => {
        const model = record(entry);
        if (typeof model.id !== "string" || model.id.length === 0) return [];
        return [
          {
            id: model.id,
            tier: tier(model.tier, "T3"),
            enabled: bool(model.enabled, true),
            costPerMTokIn: num(model.costPerMTokIn, 0),
            costPerMTokOut: num(model.costPerMTokOut, 0),
            costPerMTokCacheRead: num(model.costPerMTokCacheRead, 0),
            capabilities: Array.isArray(model.capabilities)
              ? model.capabilities.filter((c): c is string => typeof c === "string")
              : [],
            contextWindow: num(model.contextWindow, 200_000),
          } satisfies ModelEntry,
        ];
      })
    : [];

  const rawLabelIds = record(root.tierLabelIds);
  const tierLabelIds: Partial<Record<Tier, string>> = {};
  for (const t of TIERS) {
    const id = rawLabelIds[t];
    if (typeof id === "string" && id.length > 0) tierLabelIds[t] = id;
  }

  return {
    selection: {
      enabled: bool(selection.enabled, true),
      mode: selection.mode === "enforce" ? "enforce" : "advise",
      defaultTier: tier(selection.defaultTier, "T3"),
      stickyModelWithinIssue: bool(selection.stickyModelWithinIssue, true),
      holdOnUntrustedProfile: bool(selection.holdOnUntrustedProfile, true),
    },
    models,
    tierLabelIds,
    profiles: {
      windowDays: num(profiles.windowDays, 7),
      minSamples: num(profiles.minSamples, 5),
      maxAgeDays: num(profiles.maxAgeDays, 14),
    },
    quality: {
      t1EscalationCeiling: num(quality.t1EscalationCeiling, 0.05),
      t2EscalationCeiling: num(quality.t2EscalationCeiling, 0.15),
      silentFailureWeight: num(quality.silentFailureWeight, 10),
    },
  };
}

/** Config problems worth refusing or warning about at install time. */
export function validateConfig(config: ResolvedConfig): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const seen = new Set<string>();
  for (const model of config.models) {
    if (seen.has(model.id)) errors.push(`duplicate model id: ${model.id}`);
    seen.add(model.id);
    if (model.costPerMTokCacheRead === 0 && model.costPerMTokIn > 0) {
      // A zero cache-read rate makes the largest cost line free and would order
      // candidates on the wrong term entirely (ADR-0002).
      warnings.push(
        `${model.id} has costPerMTokCacheRead 0 — cache read is the largest cost line; a zero rate hides it`,
      );
    }
  }

  if (config.selection.enabled && config.models.length === 0) {
    warnings.push("selection is enabled but no models are configured; every decision will be no-eligible-model");
  }
  for (const t of TIERS) {
    if (!config.models.some((model) => model.enabled && model.tier === t)) {
      warnings.push(`no enabled model at tier ${t}`);
    }
  }
  if (config.selection.mode === "enforce" && Object.keys(config.tierLabelIds).length === 0) {
    // Not an error: the label is additive (ADR-0008). But an operator who meant
    // to get tier labels on the board should hear that they will not appear.
    warnings.push(
      "no tierLabelIds configured; overrides will be written without a tier:* label, because the plugin cannot resolve a label id from its name",
    );
  }
  if (config.selection.mode === "enforce") {
    warnings.push(
      "mode is enforce: this plugin will write assigneeAdapterOverrides. Confirm Stage 2 is stable before running this alongside another live selection change.",
    );
  }
  return { errors, warnings };
}
