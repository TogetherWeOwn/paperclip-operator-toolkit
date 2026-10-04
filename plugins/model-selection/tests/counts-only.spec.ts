import { describe, expect, it } from "vitest";

import { normalizeAvailability } from "../src/engine/availability.js";
import { hardStopExcluded, mergeLedgerEntry } from "../src/engine/pacing.js";
import { selectModel } from "../src/engine/select.js";
import { availabilityDocumentFrom } from "../src/lane-capacity/availability-source.js";
import { evaluateLanePace, normalizeLaneDocument, type LanePaceDefinition } from "../src/lane-capacity/pace.js";
import type { LanePollResult } from "../src/lane-capacity/poll.js";
import { MODELS, NO_ESCALATION, NOW, PROFILES, config } from "./fixtures.js";

const iso = (ms: number) => new Date(ms).toISOString();

// Identity-redacted operator projections, observed 2026-10-01 15:47Z.
// The test clock/envelope is synthetic; envelope timestamp spelling was not supplied.
function record(provider: "devin" | "xai", overrides: Record<string, unknown> = {}) {
  return {
    lane: "redacted",
    account_key: "redacted",
    health: "unknown",
    weight: 1,
    plan: provider === "devin" ? "Pro" : "SuperGrok",
    governing_window: "daily",
    window_seconds: { daily: 86400 },
    requests_today: provider === "devin" ? 804 : 0,
    requests_lifetime: provider === "devin" ? 804 : 0,
    day_resets_at: "2026-10-02T00:00:00Z",
    observationQuality: "counts-only",
    note: "no vendor quota published; pace on model_cooldowns, not utilization",
    health_floor_reason: "no utilization observed for this lane",
    ...overrides,
  };
}

// Synthetic cooldowns: neither current operator sample had an active array.
function cooldown(model: string | null, overrides: Record<string, unknown> = {}) {
  return { model, scope: "model", reason: "quota", retry_at: iso(NOW + 120_000), ...overrides };
}

describe.each(["devin", "xai"] as const)("counts-only pipeline: %s", (provider) => {
  const laneId = `cliproxy-${provider}`;
  const definition: LanePaceDefinition = {
    laneId,
    healthFields: ["health"],
    accountKeyFields: ["account_key"],
    weightFields: ["weight"],
    windows: [{
      name: "daily", role: "allowance", utilizationFields: ["day_utilization"],
      resetFields: ["day_resets_at"], defaultWindowSeconds: 86400,
    }],
  };
  const baseline = MODELS.find((model) => model.tier === "T1")!;
  const cheap = {
    ...baseline, id: provider === "devin" ? "devin/swe-1-6-slow" : "xai/grok-4", laneId,
    costPerMTokIn: 0.1, costPerMTokOut: 0.1, costPerMTokCacheRead: 0.1,
  };
  const sibling = { ...cheap, id: `${cheap.id}-sibling`, costPerMTokIn: 0.2, costPerMTokOut: 0.2, costPerMTokCacheRead: 0.2 };
  const otherLane = "healthy-other";
  const backup = { ...baseline, id: "healthy-backup", laneId: otherLane };

  function pipeline(records = [record(provider)], observedAt = iso(NOW)) {
    const observation = normalizeLaneDocument({ document: { observedAt, staleAfterSeconds: 600, records }, definition });
    const verdict = evaluateLanePace({ observation, asOf: iso(NOW) });
    const result: LanePollResult = { laneId, fetchedAt: iso(NOW), observation, verdict, rawRecords: records, error: null };
    const document = availabilityDocumentFrom({ results: [result], observedAt: iso(NOW) });
    const availability = normalizeAvailability(document, NOW);
    const ledger = mergeLedgerEntry({}, result);
    return { observation, verdict, result, document, availability, ledger };
  }

  function select(result: ReturnType<typeof pipeline>, overrides: { now?: number; mode?: "off" | "shadow" | "enforce"; sticky?: boolean; ledgerOnly?: boolean } = {}) {
    return selectModel({
      profiles: PROFILES, signals: NO_ESCALATION, now: overrides.now ?? NOW,
      descriptor: {
        issueId: "counts-only", labelNames: ["tier:T1"],
        ...(overrides.sticky ? { stickyModelId: cheap.id } : {}),
      },
      config: config({ models: [cheap, sibling, backup], laneLedger: result.ledger, pacingMode: overrides.mode ?? "enforce" }),
      ...(overrides.ledgerOnly ? {} : { availability: {
        ...result.availability,
        lanes: [...result.availability.lanes, { laneId: otherLane, state: "available" as const, term: null, reason: "positive control", accountCount: 2, serviceableAccountCount: 2, ageMinutes: 0 }],
      } }),
    });
  }

  it("serves fresh explicitly tagged evidence while every allowance/pace field stays unknown", () => {
    const result = pipeline();
    expect(result.observation.error).toBeNull();
    expect(result.observation.accounts[0]).toMatchObject({ governingWindow: "daily", windows: [], health: "unknown" });
    expect(result.verdict).toMatchObject({
      serviceable: true, state: "unknown", score: null, targetBurnRate: null,
      observedBurnRate: null, deficit: null, reason: "no-computable-governing-window",
      knownAccountCount: 0, knownWeight: 0, serviceableAccountCount: 1,
    });
    expect(result.verdict.accounts[0]).toMatchObject({ governingWindow: null, bindingWindow: null, score: null, clearRate: null });
    expect(result.document.records[0]).not.toHaveProperty("windows");
    expect(result.availability.lanes[0]).toMatchObject({ state: "available", serviceableAccountCount: 1 });
    expect(hardStopExcluded(result.ledger, cheap, NOW)).toBe(false);
    expect(select(result).modelId).toBe(cheap.id);
  });

  it("does not infer counts-only from the lane name or absent utilization", () => {
    const result = pipeline([record(provider, { observationQuality: undefined })]);
    expect(result.observation.accounts[0]).not.toHaveProperty("countsOnly");
    expect(result.verdict).toMatchObject({ serviceable: null, reason: "invalid-configured-governing-window" });
    expect(hardStopExcluded(result.ledger, cheap, NOW)).toBe(true);
    expect(select(result).modelId).toBe(backup.id);
  });

  it.each(["quota", "payment_required"])("blocks only an exact matching active %s cooldown", (reason) => {
    const result = pipeline([record(provider, { model_cooldowns: [cooldown(cheap.id, { reason, scope: "credential" })] })]);
    expect(result.verdict.serviceable).toBe(true);
    expect(hardStopExcluded(result.ledger, cheap, NOW)).toBe(true);
    expect(hardStopExcluded(result.ledger, sibling, NOW)).toBe(false);
    expect(select(result).modelId).toBe(sibling.id);
    expect(select(result, { sticky: true }).modelId).toBe(sibling.id);
    // Availability remains effective with pacing switched off.
    const decision = select(result, { mode: "off" });
    expect(decision.modelId).toBe(sibling.id);
    expect(decision.availability.excluded).toContainEqual(expect.objectContaining({ modelId: cheap.id, term: "cooldown" }));
    expect(select(result, { mode: "off", ledgerOnly: true }).modelId).toBe(sibling.id);
  });

  it("does not match prefixes, suffixes or a different provider spelling", () => {
    for (const model of [`${cheap.id}-extra`, cheap.id.split("/")[1]!, `other/${cheap.id.split("/")[1]}`]) {
      const result = pipeline([record(provider, { model_cooldowns: [cooldown(model)] })]);
      expect(hardStopExcluded(result.ledger, cheap, NOW)).toBe(false);
      expect(select(result).modelId).toBe(cheap.id);
    }
  });

  it("restores serviceability at expiry equality and later without another poll/read", () => {
    const result = pipeline([record(provider, { model_cooldowns: [cooldown(cheap.id)] })]);
    expect(select(result).modelId).toBe(sibling.id);
    for (const now of [NOW + 120_000, NOW + 121_000]) {
      expect(hardStopExcluded(result.ledger, cheap, now)).toBe(false);
      expect(select(result, { now }).modelId).toBe(cheap.id);
      expect(select(result, { now, mode: "off" }).modelId).toBe(cheap.id);
    }
  });

  it("treats explicit null model as a credential cooldown, regardless of scope", () => {
    const result = pipeline([record(provider, { model_cooldowns: [cooldown(null)] })]);
    expect(hardStopExcluded(result.ledger, cheap, NOW)).toBe(true);
    expect(hardStopExcluded(result.ledger, sibling, NOW)).toBe(true);
    expect(select(result).modelId).toBe(backup.id);
    expect(select(result, { now: NOW + 120_000 }).modelId).toBe(cheap.id);
  });

  it("does not exclude a model or credential for transient_error", () => {
    const result = pipeline([record(provider, { model_cooldowns: [cooldown(cheap.id, { reason: "transient_error" }), cooldown(null, { reason: "transient_error" })] })]);
    expect(hardStopExcluded(result.ledger, cheap, NOW)).toBe(false);
    expect(select(result).modelId).toBe(cheap.id);
  });

  it("honors aggregate cooldown evidence without intersecting again or subtracting account counts", () => {
    const result = pipeline([
      record(provider, { account_key: "aggregate-a", model_cooldowns: [cooldown(cheap.id)] }),
      record(provider, { account_key: "aggregate-b" }),
    ]);
    expect(result.availability.lanes[0]).toMatchObject({ state: "available", accountCount: 2, serviceableAccountCount: 2 });
    expect(select(result).modelId).toBe(sibling.id);
  });

  it("retains still-fresh active cooldowns across fetch failure, but not past expiry", () => {
    const result = pipeline([record(provider, { model_cooldowns: [cooldown(cheap.id)] })]);
    const ledger = mergeLedgerEntry(result.ledger, { laneId, fetchedAt: iso(NOW + 60_000), verdict: null, observation: null, error: "lane-request-failed" });
    expect(hardStopExcluded(ledger, cheap, NOW + 60_000)).toBe(true);
    expect(hardStopExcluded(ledger, sibling, NOW + 60_000)).toBe(false);
    expect(hardStopExcluded(ledger, cheap, NOW + 120_000)).toBe(false);
  });

  it.each(["exhausted", "unavailable", "disabled", "error", "cooldown", "stale"])("never rehabilitates hard health %s", (health) => {
    const result = pipeline([record(provider, { health })]);
    expect(result.verdict.serviceable).toBe(false);
    expect(select(result).modelId).toBe(backup.id);
  });

  it("keeps an explicit exhausted flag a lane-wide hard stop even with transient cooldowns", () => {
    const result = pipeline([record(provider, { exhausted: true, model_cooldowns: [cooldown(null, { reason: "transient_error" })] })]);
    expect(result.verdict.serviceable).toBe(false);
    expect(result.availability.lanes[0]?.state).toBe("unavailable");
    expect(select(result).modelId).toBe(backup.id);
  });

  it.each([-601_000, 61_000])("does not restamp stale/future source evidence (%s ms) as healthy", (offset) => {
    const result = pipeline([record(provider, { model_cooldowns: [cooldown(cheap.id)] })], iso(NOW + offset));
    expect(result.verdict.serviceable).toBeNull();
    expect(result.document.records).toHaveLength(0);
    expect(result.availability.unreadableReason).not.toBeNull();
    expect(hardStopExcluded(result.ledger, cheap, NOW)).toBe(false);
  });

  it.each([
    { requests_today: -1 }, { requests_lifetime: NaN }, { requests_today: Infinity },
    { requests_today: 0.5 }, { requests_lifetime: Number.MAX_SAFE_INTEGER + 1 },
    { requests_today: undefined }, { window_seconds: { daily: 0 } },
    { window_seconds: { daily: Infinity } }, { day_resets_at: "not-a-date" },
    { day_resets_at: "2026-10-02" }, { day_utilization: 0 }, { day_utilization: NaN },
    { day_utilization: undefined }, { utilization: null }, { windows: [] },
    { windows: [{ role: "allowance", utilization: 1 }] },
    { health: undefined }, { model_cooldowns: null }, { model_cooldowns: {} },
    { model_cooldowns: [null] }, { model_cooldowns: [cooldown(undefined as never)] },
    { model_cooldowns: [cooldown("")] }, { model_cooldowns: [cooldown(cheap.id, { retry_at: "invalid" })] },
    { model_cooldowns: [cooldown(cheap.id, { scope: "" })] }, { model_cooldowns: [cooldown(cheap.id, { reason: "" })] },
  ])("keeps malformed or contradictory tagged telemetry unknown (%j)", (overrides) => {
    const result = pipeline([record(provider, overrides)]);
    expect(result.observation.error).toBe("invalid-document");
    expect(result.verdict).toMatchObject({ serviceable: null, score: null, reason: "document-unavailable" });
    expect(result.document.records).toHaveLength(0);
    const direct = normalizeAvailability({ observedAt: iso(NOW), records: [{ provider: laneId, ...record(provider, overrides) }] }, NOW);
    expect(direct.lanes[0]?.state).toBe("unknown");
  });
});
