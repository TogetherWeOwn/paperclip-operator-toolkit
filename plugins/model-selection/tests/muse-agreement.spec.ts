import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { assembleAdditiveConfig } from "../scripts/assemble-additive-config.mjs";
import { resolveConfig } from "../src/config/resolve.js";
import type { LaneLedger } from "../src/engine/pacing.js";
import { selectModel } from "../src/engine/select.js";
import type { QualitySignal, VolumeProfile } from "../src/engine/types.js";
import type { LanePaceVerdict } from "../src/lane-capacity/pace.js";

/**
 * TOG-14066 (MUSE slice of TOG-13513): the fleet-quota-balancer's MUSE choice
 * (`muse-spark-1.3-contributor`, xhigh pinned at the agent row, not in the
 * roster) had no enabled roster row, so no bridge minute could be expressed
 * by the selector. This spec is the agreement proof for the single added row:
 * the row exists and is enabled, the assembler binds it to the subscription
 * Meta lane, and `selectModel` picks it under the bridge's own MUSE
 * conditions (serviceable subscription lane, unproven row) through the
 * free-lane earn-in owner rule — pace orders quota lanes, never list price.
 */

const MUSE = "muse-spark-1.3-contributor";
const META_LANE = "cliproxy-meta";
const NOW_MS = Date.parse("2026-10-03T22:00:00.000Z");
const COMPUTED_AT = new Date(NOW_MS - 60 * 60 * 1000).toISOString();

const raw = JSON.parse(
  readFileSync(new URL("../config/reviewed-roster.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
const resolved = resolveConfig(raw);

const profiles: VolumeProfile[] = ["T1", "T2", "T3"].map((tier) => ({
  tier: tier as "T1" | "T2" | "T3",
  sampleCount: 100,
  computedAt: COMPUTED_AT,
  avgInputTokens: 320_286,
  avgCacheReadTokens: 4_336_432,
  avgOutputTokens: 44_712,
}));
const signals: QualitySignal[] = [];

/** A serviceable subscription-lane reading: unmetered, no quota signal, cost ~$0. */
function freeVerdict(laneId: string): LanePaceVerdict {
  return {
    laneId,
    observedAt: new Date(NOW_MS).toISOString(),
    state: "free",
    serviceable: true,
    score: null,
    accounts: [],
    knownAccountCount: 0,
    knownWeight: 0,
    serviceableAccountCount: 0,
    urgentResetAt: null,
    reason: "free-lane",
  };
}

describe("TOG-14066 bridge MUSE agreement", () => {
  it("carries an enabled T3 row for the bridge MUSE model", () => {
    const row = resolved.models.find((m) => m.id === MUSE);
    expect(row).toBeDefined();
    expect(row).toMatchObject({ enabled: true, tier: "T3", fallbackOnly: false });
    expect(row!.capabilities).toEqual(
      expect.arrayContaining(["tools", "structured-output", "long-context"]),
    );
    // Lane binding is deferred to assemble-additive-config.mjs at merge time:
    // the reviewed roster carries no laneId (roster-consolidation.spec.ts).
    expect(row!.laneId ?? null).toBeNull();
  });

  it("assembles the MUSE row onto the subscription Meta lane", () => {
    const metaLane = {
      laneId: META_LANE,
      statusUrl: "https://status.example/meta",
      windows: [{ name: "primary", role: "serviceability", utilizationFields: ["used"] }],
    };
    const result = assembleAdditiveConfig(
      {
        selection: { mode: "advise" },
        models: [{ id: MUSE, tier: "T3", enabled: true }],
      },
      {
        selection: { mode: "shadow" },
        models: [],
        pacing: { mode: "shadow", lanes: [metaLane] },
      },
      { minimumLaneBoundModels: 1 },
    );
    const assembled = result.config.models.find((m) => m.id === MUSE);
    expect(assembled).toMatchObject({ enabled: true, laneId: META_LANE });
    expect(result.counts.enabledWithoutLane).toEqual([]);
  });

  it("selectModel picks the MUSE row while its lane is serviceable and unproven", () => {
    // Mirror the assembled config: the reviewed row plus the Meta lane binding
    // the assembler infers. No modelScores: the row is unjudged, exactly the
    // state a new subscription route starts in.
    const models = resolved.models.map((m) =>
      m.id === MUSE ? { ...m, laneId: META_LANE } : m,
    );
    const laneLedger: LaneLedger = {
      [META_LANE]: {
        laneId: META_LANE,
        verdict: freeVerdict(META_LANE),
        fetchedAt: new Date(NOW_MS).toISOString(),
        error: null,
        observation: null,
      },
    };
    const decision = selectModel({
      descriptor: { issueId: "tog-14066-muse", labelNames: ["tier:T3"] },
      config: {
        enforcementEnabled: false,
        defaultTier: resolved.selection.defaultTier,
        models,
        holdOnUntrustedProfile: true,
        stickyWithinIssue: false,
        pacingMode: "enforce",
        laneLedger,
      },
      profiles,
      signals,
      now: NOW_MS,
    });
    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe(MUSE);
    expect(decision.effectiveTier).toBe("T3");
    expect(decision.trace.some((line) => line.includes("free-lane earn-in"))).toBe(true);
  });
});
