import { describe, expect, it } from "vitest";
import { buildAcceptedWorkOverlay, normalizeAcceptedWorkOverlay, ACCEPTED_WORK_SPEC_VERSION } from "../src/accepted-work/posterior.js";
import { resolveConfig } from "../src/config/resolve.js";
import { TIERS } from "../src/constants.js";
import { BENCHMARK_SPEC_VERSION } from "../src/engine/benchmark-prior.js";
import { applyDerivedTiers, buildModelScore } from "../src/engine/scores.js";
import {
  decodePersistedFormat,
  encodePersistedFormat,
  PUBLIC_FORMAT_IDENTIFIERS,
  resolveFormatCompatibility,
} from "../src/format-compatibility.js";
import { REVIEWER_FIXER_HEADROOM_SCHEMA } from "../src/reviewer-fixer-headroom.js";
import { SHADOW_SCHEMA_VERSION } from "../src/shadow-emit.js";

const aliases = resolveFormatCompatibility({
  tierSpecVersion: "legacy-benchmark-v1",
  acceptedWorkSpecVersion: "legacy-posterior-v1",
  shadowSchemaVersion: "legacy-paired-decision-v1",
});

const overlay = () => buildAcceptedWorkOverlay({
  cards: [], models: [], priorPByModel: {},
  unattributed: { closedCardsWithoutClosingRun: 0 },
  nowMs: Date.parse("2026-10-04T00:00:00Z"), nowIso: "2026-10-04T00:00:00Z",
});

describe("format identity compatibility", () => {
  it("uses generic canonical identities without changing algorithm versions", () => {
    expect(BENCHMARK_SPEC_VERSION).toBe(PUBLIC_FORMAT_IDENTIFIERS.tierSpecVersion);
    expect(ACCEPTED_WORK_SPEC_VERSION).toBe(PUBLIC_FORMAT_IDENTIFIERS.acceptedWorkSpecVersion);
    expect(SHADOW_SCHEMA_VERSION).toBe(PUBLIC_FORMAT_IDENTIFIERS.shadowSchemaVersion);
    expect(REVIEWER_FIXER_HEADROOM_SCHEMA).toBe("reviewer-fixer-headroom-v1");
  });

  it("defaults to canonical-only and resolves only explicit private aliases", () => {
    expect(resolveConfig({ models: [] }).formatCompatibility).toEqual(resolveFormatCompatibility(undefined));
    expect(resolveConfig({ models: [], formatCompatibility: aliases }).formatCompatibility).toEqual(aliases);
  });

  it.each([[], "legacy-v1", { unknown: "legacy-v1" }, { tierSpecVersion: "legacy-v0" },
    { tierSpecVersion: " legacy-v1" }, { shadowSchemaVersion: 1 },
    { acceptedWorkSpecVersion: "x".repeat(80) + "-v1" }])("refuses an invalid compatibility profile: %o", (value) => {
    expect(() => resolveFormatCompatibility(value)).toThrow();
    expect(() => resolveConfig({ models: [], formatCompatibility: value })).toThrow();
  });

  it("lets the strict tier consumer read an explicitly mapped stored score", () => {
    const canonical = { ...buildModelScore("m", 60, {}, TIERS), derivedTier: "T3" as const };
    const stored = encodePersistedFormat("tierSpecVersion", canonical, aliases);
    const roster = [{ id: "m", tier: "T1" as const }];
    expect(stored.tierSpecVersion).toBe(aliases.tierSpecVersion);
    expect(applyDerivedTiers(roster, { m: stored })[0]?.tier).toBe("T1");
    const decoded = decodePersistedFormat("tierSpecVersion", stored, aliases);
    expect(decoded).toEqual(canonical);
    expect(applyDerivedTiers(roster, { m: decoded })[0]?.tier).toBe("T3");
    expect(canonical.tierSpecVersion).toBe(BENCHMARK_SPEC_VERSION);
    expect(stored.tierSpecVersion).toBe(aliases.tierSpecVersion);
  });

  it("leaves unknown stored score versions inadmissible", () => {
    const stored = { ...buildModelScore("m", 60, {}, TIERS), derivedTier: "T3" as const, tierSpecVersion: "other-benchmark-v1" };
    const decoded = decodePersistedFormat("tierSpecVersion", stored, aliases);
    expect(decoded).toBe(stored);
    expect(applyDerivedTiers([{ id: "m", tier: "T1" }], { m: decoded })[0]?.tier).toBe("T1");
  });

  it("round-trips posterior payloads through the existing strict normalizer", () => {
    const canonical = overlay();
    const stored = encodePersistedFormat("acceptedWorkSpecVersion", canonical, aliases);
    expect(normalizeAcceptedWorkOverlay(stored)).toBeNull();
    const decoded = decodePersistedFormat("acceptedWorkSpecVersion", stored, aliases);
    expect(normalizeAcceptedWorkOverlay(decoded)).toEqual(canonical);
    expect(canonical.specVersion).toBe(ACCEPTED_WORK_SPEC_VERSION);
    expect(stored.specVersion).toBe(aliases.acceptedWorkSpecVersion);
    expect(normalizeAcceptedWorkOverlay(decodePersistedFormat("acceptedWorkSpecVersion", { ...stored, cohorts: "not-an-array" }, aliases))).toBeNull();
    expect(normalizeAcceptedWorkOverlay(decodePersistedFormat("acceptedWorkSpecVersion", { ...stored, specVersion: "unknown-posterior-v1" }, aliases))).toBeNull();
  });

  it.each(["shadowSchemaVersion"] as const)("translates only the %s metadata field on a cloned outbound record", (format) => {
    const canonical = { schema: PUBLIC_FORMAT_IDENTIFIERS[format], payload: { held: true } };
    const serialized = encodePersistedFormat(format, canonical, aliases);
    expect(serialized).toEqual({ ...canonical, schema: aliases[format] });
    expect(serialized).not.toBe(canonical);
    expect(decodePersistedFormat(format, serialized, aliases)).toEqual(canonical);
    expect(canonical.schema).toBe(PUBLIC_FORMAT_IDENTIFIERS[format]);
  });

  it("does not rewrite unknown versions, arrays, nulls or primitives", () => {
    const values = [{ schema: "unconfigured-v1" }, null, [], "legacy-paired-decision-v1", 1];
    for (const value of values) {
      expect(decodePersistedFormat("shadowSchemaVersion", value, aliases)).toBe(value);
      expect(encodePersistedFormat("shadowSchemaVersion", value, aliases)).toBe(value);
    }
    const value = { schema: PUBLIC_FORMAT_IDENTIFIERS.shadowSchemaVersion };
    expect(encodePersistedFormat("shadowSchemaVersion", value)).toBe(value);
  });
});
