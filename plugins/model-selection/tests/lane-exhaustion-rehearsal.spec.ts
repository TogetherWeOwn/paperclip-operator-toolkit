import { describe, expect, it } from "vitest";

import { selectModel } from "../src/engine/select.js";
import type { LaneOutageOverride } from "../src/engine/pacing.js";
import type { ModelEntry } from "../src/engine/types.js";
import {
  autoQuarantineFor,
  laneExhaustionFromRunFailure,
  mergeLaneOutage,
} from "../src/lane-capacity/run-failure.js";
import { NO_ESCALATION, PROFILES, config } from "./fixtures.js";

/**
 * Rehearsal: replay the 2026-09-16 16:40Z Codex exhaustion through
 * the auto-quarantine path and assert that selection stops choosing the dead
 * lane.
 *
 * This is the deliverable's "simulate an exhausted lane and show zero runs
 * start on it", narrowed to the claim the plugin can actually support. A
 * plugin cannot gate a dispatch — `publishPluginDomainEvent` is
 * `void bus.emit(...)` in `activity-log.ts:47`, so every handler runs after
 * the fact. What it CAN do, and what is asserted here, is that from the first
 * rejection onward the router's answer for every card on that lane is a model
 * on a different lane. The exposure that remains is the in-flight runs already
 * dispatched, not a continuing stream of new ones.
 *
 * Every assertion is paired with a positive control on the SAME inputs minus
 * the quarantine. Without that control a green here would be unfalsifiable:
 * a selector that never picks Codex for any reason would pass the main
 * assertion trivially.
 */

/** The two lanes that mattered in the incident, on the real roster ids. */
const SOL = "gpt-5.6-sol";
const LUNA = "gpt-5.6-luna";
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

/**
 * A roster shaped like the live one at 16:40Z on the axis that decides this:
 * the Codex models are strictly cheaper than the Claude models in the same
 * tier, so cost ordering prefers them and ONLY a hard exclusion moves the
 * pick. That is what makes the positive control meaningful.
 */
const ROSTER: ModelEntry[] = [
  model({ id: SOL, tier: "T2", laneId: CODEX_LANE, costPerMTokIn: 0.4, costPerMTokOut: 1.6, costPerMTokCacheRead: 0.04 }),
  model({ id: LUNA, tier: "T3", laneId: CODEX_LANE, costPerMTokIn: 0.1, costPerMTokOut: 0.4, costPerMTokCacheRead: 0.01 }),
  model({ id: "claude-sonnet-5", tier: "T2", laneId: CLAUDE_LANE, costPerMTokIn: 3, costPerMTokOut: 15, costPerMTokCacheRead: 0.3 }),
  model({ id: "claude-opus-5", tier: "T1", laneId: CLAUDE_LANE, costPerMTokIn: 15, costPerMTokOut: 75, costPerMTokCacheRead: 1.5 }),
  model({ id: "claude-haiku-4-5-20251001", tier: "T3", laneId: CLAUDE_LANE, costPerMTokIn: 1, costPerMTokOut: 5, costPerMTokCacheRead: 0.1 }),
];

/** `heartbeat_runs.error` from a real failed run (7503efd7) on the exhausted lane. */
const LIVE_429 =
  "API Error: Request rejected (429) · All credentials for model gpt-5.6-sol are cooling down "
  + "(last error: usage_limit_reached: The usage limit has been reached)";

const INCIDENT_MS = Date.parse("2026-09-16T16:40:00.000Z");

/** The 14 cards the incident actually touched, by the tier each one carried. */
const AFFECTED_CARDS: { issueId: string; tier: "T1" | "T2" | "T3" }[] = [
  { issueId: "EX-2983", tier: "T1" },
  { issueId: "EX-2987", tier: "T1" },
  { issueId: "EX-2989", tier: "T1" },
  { issueId: "EX-2974", tier: "T2" },
  { issueId: "EX-2988", tier: "T2" },
  { issueId: "EX-2990", tier: "T2" },
  { issueId: "EX-2482", tier: "T2" },
  { issueId: "EX-2407", tier: "T2" },
  { issueId: "EX-3012", tier: "T1" },
  { issueId: "EX-3015", tier: "T2" },
  { issueId: "EX-2969", tier: "T3" },
  { issueId: "EX-1068", tier: "T3" },
  { issueId: "EX-1094", tier: "T3" },
  { issueId: "EX-2572", tier: "T3" },
];

function pickFor(issueId: string, tier: string, laneOutageOverride: LaneOutageOverride | null) {
  return selectModel({
    profiles: PROFILES,
    signals: NO_ESCALATION,
    now: INCIDENT_MS,
    descriptor: { issueId, labelNames: [`tier:${tier}`] },
    config: config({
      models: ROSTER,
      pacingMode: "enforce",
      holdOnUntrustedProfile: false,
      laneOutageOverride,
    }),
  });
}

function laneOf(modelId: string | null): string | null {
  return ROSTER.find((entry) => entry.id === modelId)?.laneId ?? null;
}

describe("Rehearsal: an exhausted lane is evacuated from the first rejection", () => {
  /** Step 1-3 of the handler, as pure functions: rejection -> quarantine record. */
  const verdict = laneExhaustionFromRunFailure({ error: LIVE_429, models: ROSTER });
  const quarantine = verdict ? mergeLaneOutage(null, autoQuarantineFor(verdict, INCIDENT_MS), new Date(INCIDENT_MS).toISOString()) : null;

  it("classifies the live rejection as a Codex-lane exhaustion", () => {
    expect(verdict).not.toBeNull();
    expect(verdict!.laneId).toBe(CODEX_LANE);
    expect(quarantine!.lanes).toContain(CODEX_LANE);
  });

  it("POSITIVE CONTROL: without the quarantine, the router keeps choosing the Codex lane", () => {
    const onCodex = AFFECTED_CARDS
      .map((card) => ({ card: card.issueId, modelId: pickFor(card.issueId, card.tier, null).modelId }))
      .filter((pick) => laneOf(pick.modelId) === CODEX_LANE);
    // If this is ever 0, the main assertion below proves nothing at all. The
    // exact count is pinned rather than `> 0` so that a roster or cost change
    // that quietly drains the control shows up as a failure here instead of
    // turning the real assertion vacuous: it is every T2 and T3 card in the
    // set, i.e. all 10 of the 14 that were not already on Claude by tier.
    expect(onCodex).toHaveLength(10);
  });

  it("with the quarantine in force, ZERO of the 14 affected cards select a Codex-lane model", () => {
    const picks = AFFECTED_CARDS.map((card) => ({
      card: card.issueId,
      modelId: pickFor(card.issueId, card.tier, quarantine).modelId,
    }));
    const stillOnCodex = picks.filter((pick) => laneOf(pick.modelId) === CODEX_LANE);
    expect(stillOnCodex).toEqual([]);
    // And every card still gets an answer — evacuating the lane must not strand
    // work. This is the half of the claim that the 16:40Z incident failed: the
    // 13 auto-blocked cards had no execution path, not merely a worse one.
    expect(picks.every((pick) => pick.modelId !== null)).toBe(true);
  });

  it("the quarantine expires on its own, restoring the cheap lane without an operator", () => {
    const afterExpiry = Date.parse(quarantine!.until) + 1_000;
    const stillActive = quarantine!.until > new Date(afterExpiry).toISOString();
    expect(stillActive).toBe(false);

    // Same selection, same inputs, clock past `until`: the Codex lane is back
    // in the running. This is the property that makes the auto-quarantine safe
    // to fire on a false positive — nobody has to clear it.
    const decision = selectModel({
      profiles: PROFILES,
      signals: NO_ESCALATION,
      now: afterExpiry,
      descriptor: { issueId: "EX-2974", labelNames: ["tier:T2"] },
      config: config({ models: ROSTER, pacingMode: "enforce", holdOnUntrustedProfile: false, laneOutageOverride: quarantine }),
    });
    expect(laneOf(decision.modelId)).toBe(CODEX_LANE);
  });
});
