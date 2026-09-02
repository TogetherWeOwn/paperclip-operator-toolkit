import type { ModelEntry, QualitySignal, VolumeProfile } from "../src/engine/types.js";
import type { SelectionConfig } from "../src/engine/select.js";

/**
 * Rates are $/Mtok recovered from this company's own `heartbeat_runs` by
 * solving `usage_json.costUsd` against the token counts — verified live
 * 2026-08-31 (opus ratio 1.0253, sonnet 0.6346 against the opus rate card).
 */
export const MODELS: ModelEntry[] = [
  {
    id: "cliproxy/claude-haiku-4-5-20251001",
    tier: "T1",
    enabled: true,
    costPerMTokIn: 1,
    costPerMTokOut: 5,
    costPerMTokCacheRead: 0.1,
    capabilities: ["tools"],
    contextWindow: 200_000,
  },
  {
    id: "claude-sonnet-5",
    tier: "T2",
    enabled: true,
    costPerMTokIn: 3,
    costPerMTokOut: 15,
    costPerMTokCacheRead: 0.3,
    capabilities: ["tools", "structured-output", "long-context"],
    contextWindow: 200_000,
  },
  {
    id: "claude-opus-5",
    tier: "T3",
    enabled: true,
    costPerMTokIn: 5,
    costPerMTokOut: 25,
    costPerMTokCacheRead: 0.5,
    capabilities: ["tools", "structured-output", "long-context", "vision"],
    contextWindow: 200_000,
  },
];

export const NOW = Date.parse("2026-08-31T12:00:00.000Z");
export const FRESH = new Date(NOW - 60 * 60 * 1000).toISOString();

/**
 * Measured 7d averages, re-derived 2026-08-31 with
 * `npm run profiles:refresh` (haiku n=13, sonnet n=103, opus n=214).
 *
 * These are a ROLLING 7d window, so re-running that script on a later date will
 * not reproduce them exactly — the ratios are the durable part, not the digits.
 * The shape that matters: cache-read volume dwarfs input volume (opus 6.08M vs
 * 510k, ~12x), which is why it is a separate term rather than folded into input.
 */
export const PROFILES: VolumeProfile[] = [
  {
    tier: "T1",
    sampleCount: 13,
    computedAt: FRESH,
    avgInputTokens: 81_085,
    avgCacheReadTokens: 819_445,
    avgOutputTokens: 5_112,
  },
  {
    tier: "T2",
    sampleCount: 103,
    computedAt: FRESH,
    avgInputTokens: 320_286,
    avgCacheReadTokens: 4_336_432,
    avgOutputTokens: 44_712,
  },
  {
    tier: "T3",
    sampleCount: 214,
    computedAt: FRESH,
    avgInputTokens: 510_327,
    avgCacheReadTokens: 6_081_872,
    avgOutputTokens: 55_532,
  },
];

/** Pre-flip reality: a true 0.0% escalation rate (ADR-0005, self-test 3/3). */
export const NO_ESCALATION: QualitySignal[] = [
  { tier: "T1", escalationRate: 0, silentFailureCount: 0, sampleCount: 40, computedAt: FRESH },
  { tier: "T2", escalationRate: 0, silentFailureCount: 0, sampleCount: 103, computedAt: FRESH },
];

export function config(overrides: Partial<SelectionConfig> = {}): SelectionConfig {
  return {
    enforcementEnabled: false,
    defaultTier: "T3",
    models: MODELS,
    holdOnUntrustedProfile: true,
    stickyWithinIssue: true,
    ...overrides,
  };
}
