import { describe, expect, it } from "vitest";

import { TIERS } from "../src/constants.js";
import {
  accumulateTierPollOutcomes,
  emptyTierPollOutcomes,
  normalizeTierPollOutcomes,
  tiersForLane,
  type TierPollOutcomes,
} from "../src/engine/tier-outcomes.js";
import type { ModelEntry } from "../src/engine/types.js";

/**
 * Per-tier lane-poll outcome counters: read-only telemetry, never
 * a routing input. Every behavioural test here is a PAIR where it matters —
 * one shape that must increment and one that must not — because a counter
 * that increments unconditionally reads green while measuring nothing.
 *
 * Roster shape: haiku = T3 alone on `zai`; sonnet = T2 and opus = T1 share
 * `claude` (same convention as `lane-evidence.spec.ts`).
 */

function model(id: string, tier: "T1" | "T2" | "T3", laneId: string | null, enabled = true): ModelEntry {
  return {
    id,
    tier,
    enabled,
    costPerMTokIn: 1,
    costPerMTokOut: 5,
    costPerMTokCacheRead: 0.1,
    capabilities: ["tools"],
    contextWindow: 1_000_000,
    aaIndex: null,
    releasedAt: "1970-01-01",
    fallbackOnly: false,
    note: "",
    earnIn: null,
    laneId,
  };
}

const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-5";
const OPUS = "claude-opus-5";

const ROSTER: ModelEntry[] = [
  model(HAIKU, "T3", "zai"),
  model(SONNET, "T2", "claude"),
  model(OPUS, "T1", "claude"),
];

const NOW = "2026-09-26T14:00:00.000Z";

function countersOf(outcomes: TierPollOutcomes, tier: "T1" | "T2" | "T3") {
  return outcomes.tiers[tier];
}

describe("tiersForLane — the roster map behind the counters", () => {
  it("maps a lane to the tiers it serves, deduplicated across shared-lane rows", () => {
    // The pair: `claude` serves TWO tiers (T1 + T2) from two rows, while
    // `zai` serves exactly one (T3).
    expect(tiersForLane(ROSTER, "claude").sort()).toEqual(["T1", "T2"]);
    expect(tiersForLane(ROSTER, "zai")).toEqual(["T3"]);
  });

  it("ignores disabled rows and lanless rows", () => {
    const withDisabled = [...ROSTER, model("dead-model", "T1", "zai", false)];
    expect(tiersForLane(withDisabled, "zai")).toEqual(["T3"]);
    const withLanless = [...ROSTER, model("floating-model", "T2", null)];
    expect(tiersForLane(withLanless, "nowhere")).toEqual([]);
    expect(tiersForLane(withLanless, "claude").sort()).toEqual(["T1", "T2"]);
  });
});

describe("accumulateTierPollOutcomes — the counting rule", () => {
  it("increments polls+succeeded on a clean serviceable poll for that lane's tiers only", () => {
    const next = accumulateTierPollOutcomes(
      emptyTierPollOutcomes(),
      [{ laneId: "zai", error: null, serviceable: true }],
      ROSTER,
      NOW,
    );
    expect(countersOf(next, "T3")).toEqual({ polls: 1, succeeded: 1, failed: 0, lastAt: NOW });
    // The pair: a zai poll must not touch the tiers zai does not serve.
    expect(countersOf(next, "T2")).toEqual({ polls: 0, succeeded: 0, failed: 0, lastAt: null });
    expect(countersOf(next, "T1")).toEqual({ polls: 0, succeeded: 0, failed: 0, lastAt: null });
    expect(next.updatedAt).toBe(NOW);
  });

  it("increments polls+failed on a poll error, and on an unserviceable verdict", () => {
    const next = accumulateTierPollOutcomes(
      emptyTierPollOutcomes(),
      [
        { laneId: "zai", error: "lane-request-failed", serviceable: null },
        { laneId: "claude", error: null, serviceable: false },
      ],
      ROSTER,
      NOW,
    );
    expect(countersOf(next, "T3")).toEqual({ polls: 1, succeeded: 0, failed: 1, lastAt: NOW });
    // `claude` maps to TWO tiers: both increment, once each.
    expect(countersOf(next, "T2")).toEqual({ polls: 1, succeeded: 0, failed: 1, lastAt: NOW });
    expect(countersOf(next, "T1")).toEqual({ polls: 1, succeeded: 0, failed: 1, lastAt: NOW });
  });

  it("increments polls only on an indeterminate poll (serviceable null, no error)", () => {
    // The tri-state discipline: unknown is absence of evidence, not evidence
    // either way — the same rule lane-evidence.ts follows for `unproven`.
    const next = accumulateTierPollOutcomes(
      emptyTierPollOutcomes(),
      [{ laneId: "zai", error: null, serviceable: null }],
      ROSTER,
      NOW,
    );
    expect(countersOf(next, "T3")).toEqual({ polls: 1, succeeded: 0, failed: 0, lastAt: NOW });
  });

  it("accumulates across firings and leaves unmapped tiers untouched", () => {
    const first = accumulateTierPollOutcomes(
      emptyTierPollOutcomes(),
      [{ laneId: "zai", error: null, serviceable: true }],
      ROSTER,
      NOW,
    );
    const second = accumulateTierPollOutcomes(
      first,
      [
        { laneId: "zai", error: null, serviceable: false },
        { laneId: "unknown-lane", error: null, serviceable: true },
      ],
      ROSTER,
      "2026-09-26T15:00:00.000Z",
    );
    // A lane no roster row names maps to no tier: the unknown lane is dropped,
    // not guessed — so T1/T2 stay zero and T3 accumulates 1 served + 1 missed.
    expect(countersOf(second, "T3")).toEqual({
      polls: 2,
      succeeded: 1,
      failed: 1,
      lastAt: "2026-09-26T15:00:00.000Z",
    });
    expect(countersOf(second, "T2").polls).toBe(0);
    expect(second.updatedAt).toBe("2026-09-26T15:00:00.000Z");
  });

  it("never mutates the previous snapshot", () => {
    const prev = emptyTierPollOutcomes();
    accumulateTierPollOutcomes(prev, [{ laneId: "zai", error: null, serviceable: true }], ROSTER, NOW);
    expect(countersOf(prev, "T3").polls).toBe(0);
    expect(prev.updatedAt).toBeNull();
  });
});

describe("normalizeTierPollOutcomes — the fail-open read", () => {
  it("round-trips a well-formed stored value", () => {
    const stored = accumulateTierPollOutcomes(
      emptyTierPollOutcomes(),
      [{ laneId: "zai", error: null, serviceable: true }],
      ROSTER,
      NOW,
    );
    expect(normalizeTierPollOutcomes(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
  });

  it("fails open to empty counters on every malformed shape", () => {
    for (const stored of [null, undefined, 42, "tiers", [], { tiers: null }, { tiers: { T3: null } }]) {
      const normalized = normalizeTierPollOutcomes(stored);
      for (const tier of TIERS) {
        expect(normalized.tiers[tier]).toEqual({ polls: 0, succeeded: 0, failed: 0, lastAt: null });
      }
      expect(normalized.updatedAt).toBeNull();
    }
  });

  it("keeps valid tiers and drops corrupt counts, never NaN-ing the counters", () => {
    const normalized = normalizeTierPollOutcomes({
      tiers: {
        T3: { polls: 5, succeeded: -1, failed: 2.5, lastAt: 42 },
        T2: { polls: "many", succeeded: 1, failed: 0, lastAt: NOW },
      },
      updatedAt: NOW,
    });
    expect(normalized.tiers.T3).toEqual({ polls: 5, succeeded: 0, failed: 0, lastAt: null });
    expect(normalized.tiers.T2).toEqual({ polls: 0, succeeded: 1, failed: 0, lastAt: NOW });
    expect(normalized.updatedAt).toBe(NOW);
  });
});
