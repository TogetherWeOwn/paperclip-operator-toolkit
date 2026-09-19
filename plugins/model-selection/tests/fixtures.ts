import type { SelectionConfig } from "../src/engine/select.js";
import type {
  CardLedgerEntry,
  EarnInState,
  ModelEntry,
  ModelScore,
  QualitySignal,
  VolumeProfile,
} from "../src/engine/types.js";

function model(entry: Partial<ModelEntry> & Pick<ModelEntry, "id" | "tier">): ModelEntry {
  return {
    enabled: true,
    costPerMTokIn: 0,
    costPerMTokOut: 0,
    costPerMTokCacheRead: 0,
    capabilities: ["tools"],
    contextWindow: 1_000_000,
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
    id: "claude-haiku-4-5-20251001",
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

function tierScore(overrides: Partial<ModelScore["overall"]> = {}): ModelScore["overall"] {
  return {
    n: 0,
    ok: 0,
    failInfra: 0,
    failModel: 0,
    tmo: 0,
    nEff: 0,
    pObs: null,
    p: 0.8,
    capable: null,
    proven: false,
    costPerSuccessUsd: null,
    medMin: null,
    rework: 0,
    ...overrides,
  };
}

/** Mirrors `claude-opus-5`/T1's frozen host-evidence.json row (proven, capable, cheap-ish). */
export const MODEL_SCORES: ModelScore[] = [
  {
    modelId: "claude-opus-5",
    aaIndex: 51,
    priorP: 0.933,
    tiers: {
      T1: tierScore({
        n: 416,
        ok: 321,
        failInfra: 89,
        failModel: 6,
        tmo: 3,
        nEff: 198,
        pObs: 0.966,
        p: 0.965,
        capable: true,
        proven: true,
        costPerSuccessUsd: 3.49,
        medMin: 9.9,
        rework: 7,
      }),
      T2: tierScore({ p: 0.907, capable: true, proven: false }),
      T3: tierScore({ p: 0.992, capable: true, proven: false }),
    },
    overall: tierScore({ n: 416, p: 0.965, capable: true, proven: true }),
  },
  {
    modelId: "gpt-5.6-luna",
    aaIndex: 43,
    priorP: 0.873,
    tiers: {
      T1: tierScore({ n: 22, ok: 11, p: 0.852, capable: true, proven: true }),
      T2: tierScore({
        n: 17,
        ok: 7,
        p: 0.729,
        capable: false,
        proven: true,
      }),
      T3: tierScore({ n: 52, ok: 44, p: 0.981, capable: true, proven: true }),
    },
    overall: tierScore({ n: 91, p: 0.9, capable: true, proven: true }),
  },
];

export const CARD_LEDGER: Record<string, CardLedgerEntry> = {
  "claude-opus-5:T1": {
    modelId: "claude-opus-5",
    tier: "T1",
    cardsClosed: 40,
    acceptRate: 0.9,
    costPerCard: 3.49,
    runsPerCard: 1.2,
    foreignRunShare: 0.05,
    costPerAcceptedCard: 3.49 / 0.9,
    pending: false,
  },
  "gpt-5.6-luna:T1": {
    modelId: "gpt-5.6-luna",
    tier: "T1",
    cardsClosed: 0,
    acceptRate: 0.873,
    costPerCard: 0.35,
    runsPerCard: null,
    foreignRunShare: null,
    costPerAcceptedCard: 0.35 / 0.873,
    pending: true,
  },
};

export function earnInState(overrides: Partial<EarnInState> = {}): EarnInState {
  return {
    counter: {},
    dispatchedThisWeek: {},
    activePerModel: {},
    activePerLane: {},
    firstEightOutcomes: {},
    stopped: {},
    dispatchedKeys: [],
    ...overrides,
  };
}

export const EARN_IN_STATE: EarnInState = earnInState();

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

/**
 * TOG-3045. The sub-call surface pins every override write now carries, pointed
 * at the model that write pinned.
 *
 * The key names are spelled out LITERALLY on purpose. Deriving them from
 * `ANCILLARY_MODEL_ENV_KEYS` would make every expectation here self-fulfilling:
 * dropping a key from the production constant would shrink the expected object
 * to match, and the suite would stay green through the regression.
 */
export function subCallPins(modelId: string): Record<string, unknown> {
  return {
    ANTHROPIC_SMALL_FAST_MODEL: { type: "plain", value: modelId },
    ANTHROPIC_DEFAULT_HAIKU_MODEL: { type: "plain", value: modelId },
  };
}
