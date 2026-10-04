import { describe, expect, it } from "vitest";

import {
  cheapestHealthyModelIdForTier,
  overrideEnvOnExcludedLane,
  modelOverrideForContext,
} from "../src/engine/context.js";
import type { LaneOutageOverride } from "../src/engine/pacing.js";
import { selectModel } from "../src/engine/select.js";
import type { ModelEntry } from "../src/engine/types.js";
import {
  autoQuarantineFor,
  laneExhaustionFromRunFailure,
  mergeLaneOutage,
} from "../src/lane-capacity/run-failure.js";
import { NO_ESCALATION, PROFILES, config } from "./fixtures.js";

/**
 * TOG-3116 rehearsal: replay the 2026-09-16 16:40Z Codex exhaustion through
 * the repin WRITE and assert that all seven surfaces — the main `model` plus
 * the six model-valued env keys — leave the exhausted lane.
 *
 * The sibling spec (`lane-exhaustion-rehearsal.spec.ts`) proves the router
 * stops CHOOSING the dead lane. This one proves the write that lands after
 * that choice does not leave the card's sub-call env frozen on it, which is
 * the surface the 00:0xZ board sweep found on 118 of 130 overridden open
 * cards: `assigneeAdapterOverrides.adapterConfig.env` is per-card state,
 * written wholesale (measured on TOG-3117: an issues PATCH replaces the whole
 * `adapterConfig`, and `env` within it, with no per-key merge), so a repin
 * that writes only `model` both strands the six keys on the dead lane AND —
 * under the measured replace semantics — strips every secret binding off the
 * card.
 *
 * The env under rehearsal is the one TOG-3012's run actually read, plus the
 * secret_ref entries the fix must carry through byte-for-byte.
 */

const SOL = "gpt-5.6-sol";
const LUNA = "gpt-5.6-luna";
const HAIKU = "claude-haiku-4-5-20251001";
const OPUS = "claude-opus-5";
const CODEX_LANE = "cliproxy-codex";
const CLAUDE_LANE = "cliproxy-claude";

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

const ROSTER: ModelEntry[] = [
  model({ id: SOL, tier: "T2", laneId: CODEX_LANE, costPerMTokIn: 0.4, costPerMTokOut: 1.6, costPerMTokCacheRead: 0.04 }),
  model({ id: LUNA, tier: "T3", laneId: CODEX_LANE, costPerMTokIn: 0.1, costPerMTokOut: 0.4, costPerMTokCacheRead: 0.01 }),
  model({ id: "claude-sonnet-5", tier: "T2", laneId: CLAUDE_LANE, costPerMTokIn: 3, costPerMTokOut: 15, costPerMTokCacheRead: 0.3 }),
  model({ id: OPUS, tier: "T1", laneId: CLAUDE_LANE, costPerMTokIn: 15, costPerMTokOut: 75, costPerMTokCacheRead: 1.5 }),
  model({ id: HAIKU, tier: "T3", laneId: CLAUDE_LANE, costPerMTokIn: 1, costPerMTokOut: 5, costPerMTokCacheRead: 0.1 }),
];

const LIVE_429 =
  "API Error: Request rejected (429) · All credentials for model gpt-5.6-sol are cooling down "
  + "(last error: usage_limit_reached: The usage limit has been reached)";

const INCIDENT_MS = Date.parse("2026-09-16T16:40:00.000Z");
const NOW_ISO = new Date(INCIDENT_MS).toISOString();

/** The agent-row env of a card whose override predates the exhaustion. */
const AGENT_ENV = {
  ANTHROPIC_AUTH_TOKEN: { type: "secret_ref", secretKey: "ANTHROPIC_AUTH_TOKEN" },
  CLIPROXY_USAGE_LANE_KEY: { type: "secret_ref", secretKey: "CLIPROXY_USAGE_LANE_KEY" },
  DISCORD_STAGING_BOT_TOKEN: { type: "secret_ref", secretKey: "DISCORD_STAGING_BOT_TOKEN" },
  GH_APP_REPOS: { type: "plain", value: "paperclip-ops-tooling" },
  TWO_STAGING_DATABASE_URL: { type: "secret_ref", secretKey: "TWO_STAGING_DATABASE_URL" },
};

/** The frozen override env the sweep measured on 118 open cards. */
const FROZEN_OVERRIDE_ENV = {
  PAPERCLIP_ASSIGNED_MODEL: { type: "plain", value: SOL },
  CLAUDE_CODE_SUBAGENT_MODEL: { type: "plain", value: SOL },
  ANTHROPIC_DEFAULT_OPUS_MODEL: { type: "plain", value: SOL },
  ANTHROPIC_DEFAULT_SONNET_MODEL: { type: "plain", value: SOL },
  ANTHROPIC_DEFAULT_HAIKU_MODEL: { type: "plain", value: LUNA },
  ANTHROPIC_SMALL_FAST_MODEL: { type: "plain", value: LUNA },
};

const SEVEN_MODEL_KEYS = [
  "PAPERCLIP_ASSIGNED_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
] as const;

function laneOf(modelId: string | null): string | null {
  return ROSTER.find((entry) => entry.id === modelId)?.laneId ?? null;
}

/** The repin write this card's fix produces, end to end. */
function repinWrite(quarantine: LaneOutageOverride | null) {
  const decision = selectModel({
    profiles: PROFILES,
    signals: NO_ESCALATION,
    now: INCIDENT_MS,
    descriptor: { issueId: "TOG-3012", labelNames: ["tier:T1"] },
    config: config({
      models: ROSTER,
      pacingMode: "enforce",
      holdOnUntrustedProfile: false,
      laneOutageOverride: quarantine,
    }),
  });
  if (!decision.modelId) return null;
  const selected = ROSTER.find((entry) => entry.id === decision.modelId)!;
  const cheapModelId = cheapestHealthyModelIdForTier({
    models: ROSTER,
    tier: "T3",
    ledger: {},
    laneOutageOverride: quarantine,
    nowIso: NOW_ISO,
    modelScores: {},
    laneAvoidConfig: { defaultThreshold: 0.8, perLane: {} },
    pacingMode: "enforce",
  });
  const patch = modelOverrideForContext({
    model: selected,
    agentEnvContextTokens: 1_000_000,
    compactionRatio: 0.75,
    agentEnv: AGENT_ENV,
    existingOverrideEnv: FROZEN_OVERRIDE_ENV,
    cheapModelId,
  });
  return { decision, cheapModelId, patch };
}

/** All seven surfaces of a written override, as {surface -> lane}. */
function surfaceLanes(patch: { adapterConfig: { model: string; env?: Record<string, unknown> } }) {
  const env = patch.adapterConfig.env ?? {};
  const surfaces: Record<string, string | null> = {
    model: laneOf(patch.adapterConfig.model),
  };
  for (const key of SEVEN_MODEL_KEYS) {
    const value = env[key] as { type?: string; value?: string } | undefined;
    surfaces[key] = value?.type === "plain" ? laneOf(String(value.value)) : "(not a plain pin)";
  }
  return surfaces;
}

describe("TOG-3116 rehearsal: the repin write evacuates every model surface, not just `model`", () => {
  const verdict = laneExhaustionFromRunFailure({ error: LIVE_429, models: ROSTER });
  const quarantine = verdict
    ? mergeLaneOutage(null, autoQuarantineFor(verdict, INCIDENT_MS), NOW_ISO)
    : null;

  it("classifies the live rejection and quarantines the Codex lane (setup control)", () => {
    expect(verdict?.laneId).toBe(CODEX_LANE);
    expect(quarantine?.lanes).toContain(CODEX_LANE);
  });

  it("POSITIVE CONTROL: the main-shape model-only write leaves six surfaces on the dead lane", () => {
    // Exactly what `apply.ts:98` writes on current main: model only. Run the
    // SAME seven-surface predicate over it. If this ever passes, the main
    // assertion below proves nothing — it would mean the bug fixed itself.
    const decision = selectModel({
      profiles: PROFILES,
      signals: NO_ESCALATION,
      now: INCIDENT_MS,
      descriptor: { issueId: "TOG-3012", labelNames: ["tier:T1"] },
      config: config({
        models: ROSTER,
        pacingMode: "enforce",
        holdOnUntrustedProfile: false,
        laneOutageOverride: quarantine,
      }),
    });
    expect(decision.modelId).toBe(OPUS);
    const mainShapeWrite = { adapterConfig: { model: decision.modelId! } };
    const surfaces = surfaceLanes(mainShapeWrite);
    // Under the measured REPLACE semantics this write also strips the env —
    // and every secret binding with it — which is itself part of the defect.
    const onCodexOrGone = SEVEN_MODEL_KEYS.filter((key) => surfaces[key] !== CLAUDE_LANE);
    expect(onCodexOrGone).toHaveLength(SEVEN_MODEL_KEYS.length);
    expect(surfaces.model).toBe(CLAUDE_LANE);
  });

  it("with the quarantine in force, ALL SEVEN surfaces of the repin write land on a healthy lane", () => {
    const write = repinWrite(quarantine);
    expect(write).not.toBeNull();
    const surfaces = surfaceLanes(write!.patch.assigneeAdapterOverrides);
    for (const [surface, lane] of Object.entries(surfaces)) {
      expect(lane, `surface ${surface}`).toBe(CLAUDE_LANE);
    }
    expect(write!.patch.assigneeAdapterOverrides.adapterConfig.model).toBe(OPUS);
  });

  it("the four main-lane keys follow the pin and the two cheap keys follow the cheapest healthy T3", () => {
    const write = repinWrite(quarantine);
    const env = write!.patch.assigneeAdapterOverrides.adapterConfig.env!;
    // T3 candidates: luna (Codex, outage-excluded) and haiku (Claude) -> haiku.
    expect(write!.cheapModelId).toBe(HAIKU);
    for (const key of [
      "PAPERCLIP_ASSIGNED_MODEL",
      "CLAUDE_CODE_SUBAGENT_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
    ]) {
      expect(env[key]).toEqual({ type: "plain", value: OPUS });
    }
    for (const key of ["ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL"]) {
      expect(env[key]).toEqual({ type: "plain", value: HAIKU });
    }
  });

  it("every secret_ref and unrelated binding survives the write byte-for-byte", () => {
    const write = repinWrite(quarantine);
    const env = write!.patch.assigneeAdapterOverrides.adapterConfig.env!;
    for (const [key, value] of Object.entries(AGENT_ENV)) {
      expect(env[key]).toEqual(value);
    }
  });

  it("falls back to the pin for the cheap keys when every T3 lane is exhausted too", () => {
    const everythingDead: LaneOutageOverride = {
      lanes: [CODEX_LANE, CLAUDE_LANE],
      models: [],
      until: new Date(INCIDENT_MS + 60_000).toISOString(),
    };
    const cheapModelId = cheapestHealthyModelIdForTier({
      models: ROSTER,
      tier: "T3",
      ledger: {},
      laneOutageOverride: everythingDead,
      nowIso: NOW_ISO,
      modelScores: {},
      laneAvoidConfig: { defaultThreshold: 0.8, perLane: {} },
      pacingMode: "enforce",
    });
    expect(cheapModelId).toBeNull();
    const patch = modelOverrideForContext({
      model: ROSTER.find((entry) => entry.id === OPUS)!,
      agentEnvContextTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: AGENT_ENV,
      existingOverrideEnv: FROZEN_OVERRIDE_ENV,
      cheapModelId,
    });
    // A sub-call on the pin's lane beats a cheap one left on a dead lane.
    expect(patch.assigneeAdapterOverrides.adapterConfig.env?.ANTHROPIC_SMALL_FAST_MODEL).toEqual({
      type: "plain",
      value: OPUS,
    });
  });

  /**
   * The remediation half. Writing the env correctly on the next write fixes
   * nothing for a card that will never GET a next write — and the 2026-09-17
   * sweep found 149 of 175 overridden open cards in exactly that state: pin
   * already healthy (`claude-opus-5`), all six env keys frozen on the dead
   * Codex lane, only 3 cards with a dead pin. `overrideEnvOnExcludedLane` is
   * the predicate that makes those rows writable.
   */
  describe("overrideEnvOnExcludedLane (the 149-card drain predicate)", () => {
    const avoid = { defaultThreshold: 0.8, perLane: {} };
    const scan = (env: Record<string, unknown> | null, pacingMode: "enforce" | "off" = "enforce") =>
      overrideEnvOnExcludedLane({
        existingOverrideEnv: env,
        models: ROSTER,
        ledger: {},
        laneOutageOverride: quarantine,
        nowIso: NOW_ISO,
        laneAvoidConfig: avoid,
        pacingMode,
      });

    it("flags the exact frozen env the sweep measured on the live board", () => {
      expect(scan(FROZEN_OVERRIDE_ENV)).toBe(true);
    });

    it("flags a card with only ONE frozen key (TOG-3037's shape on the live board)", () => {
      // 150 cards had PAPERCLIP_ASSIGNED_MODEL dead but only 148 had the
      // ANTHROPIC_DEFAULT_* pair — so partially-frozen rows are real and must
      // not need all six keys dead to qualify.
      expect(scan({ PAPERCLIP_ASSIGNED_MODEL: { type: "plain", value: SOL } })).toBe(true);
    });

    it("does NOT flag an env already evacuated onto the healthy lane (no churn)", () => {
      const healthy = Object.fromEntries(
        SEVEN_MODEL_KEYS.map((key) => [key, { type: "plain", value: key.includes("HAIKU") || key.includes("SMALL_FAST") ? HAIKU : OPUS }]),
      );
      expect(scan(healthy)).toBe(false);
    });

    it("does NOT flag secret-bound or absent surfaces", () => {
      // We cannot read what a secret_ref resolves to, and the write path
      // refuses to overwrite one — flagging it would schedule a write that
      // provably cannot fix the thing it was scheduled for.
      expect(scan({ PAPERCLIP_ASSIGNED_MODEL: { type: "secret_ref", secretKey: "X" } })).toBe(false);
      expect(scan({})).toBe(false);
      expect(scan(null)).toBe(false);
    });

    it("does NOT flag a secret_ref carrying a residual plain `value`", () => {
      // This is the case the explicit `isSecretBinding` check actually earns.
      // A well-formed secret_ref has no `value`, so the "is it a string?" guard
      // below it already rejects one; a binding that still carries a stale
      // value from a plain->secret conversion would otherwise read as a live
      // pin on the dead lane and schedule a write over a secret we cannot
      // reconstruct. Dropping the isSecretBinding check must fail HERE.
      expect(
        scan({ PAPERCLIP_ASSIGNED_MODEL: { type: "secret_ref", secretKey: "X", value: SOL } }),
      ).toBe(false);
    });

    it("does NOT flag an env naming a model that is not in the roster", () => {
      expect(scan({ PAPERCLIP_ASSIGNED_MODEL: { type: "plain", value: "retired-model-9" } })).toBe(false);
    });

    it("is inert when pacing is off", () => {
      expect(scan(FROZEN_OVERRIDE_ENV, "off")).toBe(false);
    });
  });
});
