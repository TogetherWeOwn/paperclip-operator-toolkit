import type { SelectionConfig } from "../src/engine/select.js";
import type { ModelEntry, QualitySignal, VolumeProfile } from "../src/engine/types.js";

function model(entry: Partial<ModelEntry> & Pick<ModelEntry, "id" | "tier">): ModelEntry {
  return {
    enabled: true,
    costPerMTokIn: 0,
    costPerMTokOut: 0,
    costPerMTokCacheRead: 0,
    capabilities: ["tools"],
    contextWindow: 200_000,
    aaIndex: null,
    releasedAt: "1970-01-01",
    fallbackOnly: false,
    note: "",
    earnIn: null,
    ...entry,
  };
}

/** Small deterministic roster for unit tests. T1 is most capable. */
export const MODELS: ModelEntry[] = [
  model({
    id: "cliproxy/claude-haiku-4-5-20251001",
    tier: "T3",
    costPerMTokIn: 1,
    costPerMTokOut: 5,
    costPerMTokCacheRead: 0.1,
    aaIndex: 18,
    releasedAt: "2025-10-01",
  }),
  model({
    id: "claude-sonnet-5",
    tier: "T2",
    costPerMTokIn: 3,
    costPerMTokOut: 15,
    costPerMTokCacheRead: 0.3,
    capabilities: ["tools", "structured-output", "long-context"],
    aaIndex: 38,
    releasedAt: "2026-06-24",
  }),
  model({
    id: "claude-opus-5",
    tier: "T1",
    costPerMTokIn: 5,
    costPerMTokOut: 25,
    costPerMTokCacheRead: 0.5,
    capabilities: ["tools", "structured-output", "long-context", "vision"],
    aaIndex: 51,
    releasedAt: "2026-06-24",
  }),
];

export const NOW = Date.parse("2026-09-10T12:00:00.000Z");
export const FRESH = new Date(NOW - 60 * 60 * 1000).toISOString();

/** Measured-shape profiles; tier names now follow T1-most-capable semantics. */
export const PROFILES: VolumeProfile[] = [
  {
    tier: "T3",
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
    tier: "T1",
    sampleCount: 214,
    computedAt: FRESH,
    avgInputTokens: 510_327,
    avgCacheReadTokens: 6_081_872,
    avgOutputTokens: 55_532,
  },
];

export const NO_ESCALATION: QualitySignal[] = [
  { tier: "T3", escalationRate: 0, silentFailureCount: 0, sampleCount: 40, computedAt: FRESH },
  { tier: "T2", escalationRate: 0, silentFailureCount: 0, sampleCount: 103, computedAt: FRESH },
];

export function config(overrides: Partial<SelectionConfig> = {}): SelectionConfig {
  return {
    enforcementEnabled: false,
    defaultTier: "T1",
    models: MODELS,
    holdOnUntrustedProfile: true,
    stickyWithinIssue: true,
    ...overrides,
  };
}
