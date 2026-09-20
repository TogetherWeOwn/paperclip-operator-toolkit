/**
 * TOG-3132 AC-2/AC-5: the availability term's WRITER.
 *
 * `availability.spec.ts` proves the reader excludes correctly given a document.
 * Every test here proves a document actually gets produced, and produced with
 * the field the reader needs — because the defect this file exists for is that
 * `PLUGIN_STATE_KEYS.laneAvailability` had a `state.get` and no `state.set`, so
 * every one of those reader tests was green against a key nothing ever wrote.
 *
 * Each case is PAIRED: a lane state that must be excluded, and one that must
 * not. A writer that emitted an empty document would pass the first half of
 * every pair and fail the second, and a writer that emitted "everything is
 * fine" would do the reverse. Neither half alone is a gate.
 *
 * The pipeline under test is the real one end to end — a published document is
 * run through `normalizeLaneDocument` (the lane's own field mapping), then the
 * writer, then `normalizeAvailability` (the reader). Asserting on the writer's
 * output shape alone would let the two sides drift on field names, which is
 * the specific way this term would go quietly inert a second time.
 */
import { describe, expect, it } from "vitest";

import { normalizeAvailability, type LaneAvailability } from "../src/engine/availability.js";
import { normalizeLaneDocument, type LanePaceDefinition } from "../src/lane-capacity/pace.js";
import { availabilityDocumentFrom } from "../src/lane-capacity/availability-source.js";
import type { LanePollResult } from "../src/lane-capacity/poll.js";

const NOW = Date.parse("2026-09-17T06:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

/** The zai lane as the live config declares it: a 5-hour and a weekly window. */
const DEFINITION: LanePaceDefinition = {
  laneId: "zai",
  healthFields: ["health"],
  accountKeyFields: ["account_key"],
  weightFields: ["plan_weight"],
  windows: [
    { name: "weekly", role: "allowance", utilizationFields: [], resetFields: [] },
    { name: "five_hour", role: "serviceability", utilizationFields: [], resetFields: [] },
  ],
};

/** A serviceable account: the control that must NOT be excluded. */
function account(accountKey: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    account_key: accountKey,
    provider: "zai",
    plan: "max",
    plan_weight: 1,
    health: "healthy",
    stale_after_seconds: 3600,
    windows: [
      {
        name: "weekly",
        role: "allowance",
        utilization: 0.46,
        resets_at: iso(NOW + 48 * 3600 * 1000),
        window_seconds: 604_800,
        allowance_weight: 1,
      },
      {
        name: "five_hour",
        role: "serviceability",
        utilization: 0.6,
        resets_at: iso(NOW + 2 * 3600 * 1000),
        window_seconds: 18_000,
        allowance_weight: 1,
      },
    ],
    ...overrides,
  };
}

/** One poll of one lane, through the real document normalizer. */
function poll(
  records: Array<Record<string, unknown>>,
  options: { observedAt?: string; laneId?: string } = {},
): LanePollResult {
  const observedAt = options.observedAt ?? iso(NOW - 60_000);
  const document = { observedAt, records };
  return {
    laneId: options.laneId ?? DEFINITION.laneId,
    fetchedAt: iso(NOW),
    verdict: null,
    observation: normalizeLaneDocument({
      document,
      definition: { ...DEFINITION, laneId: options.laneId ?? DEFINITION.laneId },
    }),
    rawRecords: records,
    error: null,
  };
}

/** Writer -> reader, at the poll stamp, for the lane under test. */
function laneAfterWrite(
  results: LanePollResult[],
  options: { readAtMs?: number; laneId?: string } = {},
): LaneAvailability | undefined {
  const document = availabilityDocumentFrom({ results, observedAt: iso(NOW) });
  const snapshot = normalizeAvailability(document, options.readAtMs ?? NOW);
  expect(snapshot.unreadableReason).toBeNull();
  return snapshot.lanes.find((lane) => lane.laneId === (options.laneId ?? DEFINITION.laneId));
}

describe("the writer produces a document the reader can exclude on", () => {
  it("does not exclude a lane with headroom (positive control)", () => {
    const lane = laneAfterWrite([poll([account("zai-a"), account("zai-b")])]);

    expect(lane).toMatchObject({ state: "available", term: null, serviceableAccountCount: 2 });
  });

  it("carries a spent window through as a quota exclusion", () => {
    const spent = { windows: account("x").windows as Array<Record<string, unknown>> };
    const exhausted = (key: string) =>
      account(key, {
        windows: spent.windows.map((window) =>
          window.name === "five_hour" ? { ...window, utilization: 1 } : window,
        ),
      });

    const lane = laneAfterWrite([poll([exhausted("zai-a"), exhausted("zai-b")])]);

    expect(lane).toMatchObject({ state: "unavailable", term: "quota" });
    expect(lane?.reason).toContain("five_hour");
  });

  it("carries the account count through, so AC-3 has something to count", () => {
    // 09-17 00:39Z: 54% of the weekly allowance left and still refusing,
    // because one credential behind a per-account limiter cannot carry fleet
    // arrival. The count is the whole finding, so the writer must publish
    // every account, not just the lane's roll-up.
    const one = laneAfterWrite([poll([account("zai-a"), account("zai-b", { health: "exhausted" })])]);
    expect(one).toMatchObject({ state: "available", accountCount: 2, serviceableAccountCount: 1 });

    const two = laneAfterWrite([poll([account("zai-a"), account("zai-b")])]);
    expect(two).toMatchObject({ accountCount: 2, serviceableAccountCount: 2 });
  });

  it("keeps a published cooldown distinguishable from a spent window", () => {
    // `normalizeHealth` buckets `cooldown` with `degraded`; both exclude, but
    // only the raw spelling tells `decisions.jsonl` which dashboard to open.
    const cooling = (key: string) =>
      account(key, { cooldown: { until: iso(NOW + 4 * 60_000), reason: "conservative rate-limit cooldown" } });

    const lane = laneAfterWrite([poll([cooling("zai-a"), cooling("zai-b")])]);
    expect(lane).toMatchObject({ state: "unavailable", term: "cooldown" });

    // Positive control: the same lane once the cooldown has expired.
    const expired = (key: string) => account(key, { cooldown: { until: iso(NOW - 60_000) } });
    expect(laneAfterWrite([poll([expired("zai-a"), expired("zai-b")])])).toMatchObject({
      state: "available",
      term: null,
    });
  });

  it("attributes a `health: cooldown` string to the cooldown term, not to health", () => {
    const lane = laneAfterWrite([poll([account("zai-a", { health: "cooldown" })])]);

    expect(lane).toMatchObject({ state: "unavailable", term: "cooldown" });
    expect(lane?.reason).toContain("cooldown");
  });
});

describe("staleness survives the single-stamp document (AC-4)", () => {
  it("drops a lane whose own sample is already past the cutoff, rather than restamping it", () => {
    // The document carries ONE `observedAt` and the reader ages every record
    // from it. Stamping the poll time without adjusting the records would hand
    // a three-hour-old lane the poll's freshness — the precise fail-open this
    // term exists to remove.
    const stale = poll([account("zai-a")], { observedAt: iso(NOW - 3 * 3600 * 1000) });
    const document = availabilityDocumentFrom({ results: [stale], observedAt: iso(NOW) });

    expect(document.records).toHaveLength(0);
    const snapshot = normalizeAvailability(document, NOW);
    expect(snapshot.unreadableReason).toBe("availability document carried no records");
    expect(snapshot.lanes.find((lane) => lane.laneId === "zai")).toBeUndefined();
  });

  it("keeps a fresh lane and spends its declared budget, not the poll's (positive control)", () => {
    // Declared 3600s, sampled 600s before the poll: 3000s of life left. Read
    // 2000s after the poll it is still usable; read 3100s after it is not.
    const fresh = poll([account("zai-a"), account("zai-b")], { observedAt: iso(NOW - 600_000) });
    const document = availabilityDocumentFrom({ results: [fresh], observedAt: iso(NOW) });

    expect(document.records).toHaveLength(2);
    expect(document.records[0]).toMatchObject({ stale_after_seconds: 3000 });

    expect(laneAfterWrite([fresh], { readAtMs: NOW + 2_000_000 })).toMatchObject({ state: "available" });
    expect(laneAfterWrite([fresh], { readAtMs: NOW + 3_100_000 })).toMatchObject({
      state: "unknown",
      term: "staleness",
    });
  });

  it("gives a lane that failed to poll no record at all, so it reads UNKNOWN not available", () => {
    const failed: LanePollResult = {
      laneId: "claude",
      fetchedAt: iso(NOW),
      verdict: null,
      observation: null,
      error: "lane-request-failed",
    };
    const document = availabilityDocumentFrom({
      results: [failed, poll([account("zai-a"), account("zai-b")])],
      observedAt: iso(NOW),
    });

    const snapshot = normalizeAvailability(document, NOW);
    // Absent, not available: `select.ts` reports an absent lane as `unmapped`.
    expect(snapshot.lanes.map((lane) => lane.laneId)).toEqual(["zai"]);
  });
});

describe("the writer keys records by lane id, not by the publisher's provider string", () => {
  it("publishes under the configured lane id so ModelEntry.laneId matches", () => {
    // The fixture records all say `provider: "zai"`; the lane is configured as
    // `cliproxy-claude`. `ModelEntry.laneId` is the match key, so a writer that
    // passed `provider` through would publish a lane no model can be matched
    // against — an exclusion that silently applies to nothing.
    const lane = laneAfterWrite([poll([account("a"), account("b")], { laneId: "cliproxy-claude" })], {
      laneId: "cliproxy-claude",
    });

    expect(lane).toMatchObject({ laneId: "cliproxy-claude", state: "available" });
  });
});
