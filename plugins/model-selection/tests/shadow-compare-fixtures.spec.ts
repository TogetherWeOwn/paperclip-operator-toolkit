import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { hashUnitInterval, slotAllowed, slotFactorFor, type LaneLedger } from "../src/engine/pacing.js";
import { selectModel } from "../src/engine/select.js";
import type { ModelEntry } from "../src/engine/types.js";
import type { LanePaceVerdict } from "../src/lane-capacity/pace.js";
import { NO_ESCALATION, NOW, PROFILES, config } from "./fixtures.js";

/**
 * Advise-vs-enforce shadow-compare fixture pack: one pinned
 * input + expected-delta pair per router lane, covering the pace mechanisms
 * that ONLY take effect in `enforce` (pace-state reorder, preferred-near-reset
 * boost). The hard stop, lane-avoid, lane-outage and lane-room gates fire
 * identically in both modes by design, so none of them can produce an
 * advise/enforce delta and none appears here.
 *
 * The ahead-of-line slot throttle is deliberately NOT an end-to-end fixture:
 * no input isolates it. An ahead lane ranks below every non-ahead lane in
 * pace order, so any input where the throttle would defer the cost leader
 * already reorders by pace rank first; and when every lane is ahead they all
 * share one issue hash under one global floor, so they stand or fall
 * together. The throttle math is pinned directly instead (see the supporting
 * pin below), so a future harness does not mistake "no throttle fixture" for
 * "throttle untested".
 *
 * Fixtures only: this spec calls the pure `selectModel()` engine twice per
 * fixture (`shadow` vs `enforce`) and asserts the pinned delta. It changes
 * no enforcement default and edits no roster row.
 */

interface FixtureModel {
  id: string;
  tier: "T1" | "T2" | "T3";
  laneId: string;
  costPerMTokIn: number;
  costPerMTokOut: number;
}

interface FixtureLane {
  state: LanePaceVerdict["state"];
  serviceable: boolean;
  score: { utilization: number; elapsed: number; deviation: number };
}

interface ShadowCompareFixture {
  name: string;
  laneUnderTest: string;
  mechanism: string;
  description: string;
  issueId: string;
  tier: "T1" | "T2" | "T3";
  models: FixtureModel[];
  lanes: Record<string, FixtureLane>;
  expected: {
    adviseWinner: string;
    enforceWinner: string;
    advisePacingApplied: boolean;
    enforcePacingApplied: boolean;
    adviseTraceContains: string[];
    adviseTraceOmits: string[];
    enforceTraceContains: string[];
    enforceTraceOmits: string[];
  };
}

const FIXTURE_FILES = [
  "codex-behind-reorder.json",
  "zai-behind-reorder.json",
  "opencode-go-preferred-near-reset.json",
];

function loadFixture(file: string): ShadowCompareFixture {
  const raw = readFileSync(new URL(`./fixtures/shadow-compare/${file}`, import.meta.url), "utf8");
  return JSON.parse(raw) as ShadowCompareFixture;
}

function toModelEntry(model: FixtureModel): ModelEntry {
  return {
    id: model.id,
    tier: model.tier,
    enabled: true,
    costPerMTokIn: model.costPerMTokIn,
    costPerMTokOut: model.costPerMTokOut,
    costPerMTokCacheRead: model.costPerMTokIn,
    capabilities: ["tools"],
    contextWindow: 200_000,
    aaIndex: null,
    releasedAt: "2026-01-01",
    fallbackOnly: false,
    note: "",
    earnIn: null,
    laneId: model.laneId,
  };
}

function toLedger(fixture: ShadowCompareFixture): LaneLedger {
  const nowIso = new Date(NOW).toISOString();
  const ledger: LaneLedger = {};
  for (const [laneId, lane] of Object.entries(fixture.lanes)) {
    ledger[laneId] = {
      laneId,
      fetchedAt: nowIso,
      error: null,
      observation: null,
      verdict: {
        laneId,
        observedAt: nowIso,
        state: lane.state,
        serviceable: lane.serviceable,
        score: { ...lane.score },
        accounts: [],
        knownAccountCount: 1,
        knownWeight: 1,
        serviceableAccountCount: lane.serviceable ? 1 : 0,
        urgentResetAt: null,
        reason: "ok",
      },
    };
  }
  return ledger;
}

describe("shadow-compare fixtures: advise vs enforce diff per lane", () => {
  it("packs exactly one fixture per router lane", () => {
    const fixtures = FIXTURE_FILES.map(loadFixture);
    expect(fixtures.map((f) => f.laneUnderTest).sort()).toEqual(
      ["cliproxy-codex", "cliproxy-opencode-go", "cliproxy-zai"].sort(),
    );
  });

  for (const file of FIXTURE_FILES) {
    const fixture = loadFixture(file);
    describe(`${fixture.name} (${fixture.mechanism} on ${fixture.laneUnderTest})`, () => {
      function decide(pacingMode: "shadow" | "enforce") {
        return selectModel({
          profiles: PROFILES,
          signals: NO_ESCALATION,
          now: NOW,
          descriptor: { issueId: fixture.issueId, labelNames: [`tier:${fixture.tier}`] },
          config: config({
            models: fixture.models.map(toModelEntry),
            pacingMode,
            laneLedger: toLedger(fixture),
            holdOnUntrustedProfile: false,
            allowExplore: false,
            stickyWithinIssue: false,
          }),
        });
      }

      it("advise stays on cost while enforce moves, exactly as pinned", () => {
        const advise = decide("shadow");
        const enforce = decide("enforce");

        expect(advise.outcome).toBe("selected");
        expect(enforce.outcome).toBe("selected");
        // Non-vacuity guard: a fixture both modes agree on proves nothing.
        expect(fixture.expected.enforceWinner).not.toBe(fixture.expected.adviseWinner);

        expect(advise.modelId).toBe(fixture.expected.adviseWinner);
        expect(enforce.modelId).toBe(fixture.expected.enforceWinner);
        expect(advise.pacingApplied).toBe(fixture.expected.advisePacingApplied);
        expect(enforce.pacingApplied).toBe(fixture.expected.enforcePacingApplied);

        const adviseTrace = advise.trace.join("\n");
        for (const snippet of fixture.expected.adviseTraceContains) expect(adviseTrace).toContain(snippet);
        for (const snippet of fixture.expected.adviseTraceOmits) expect(adviseTrace).not.toContain(snippet);

        const enforceTrace = enforce.trace.join("\n");
        for (const snippet of fixture.expected.enforceTraceContains) expect(enforceTrace).toContain(snippet);
        for (const snippet of fixture.expected.enforceTraceOmits) expect(enforceTrace).not.toContain(snippet);
      });
    });
  }
});

describe("supporting pin (not a diff): ahead-of-line slot throttle on cliproxy-zai", () => {
  it("defers the ahead lane for a dispatch hash above the floor and passes the on-pace lane", () => {
    // See the header: no end-to-end input isolates the throttle, so pin the
    // math directly. Issue hash 0.2888 clears the default 0.25 floor.
    const issueId = "shadow-compare-zai-throttle-10";
    expect(hashUnitInterval(issueId)).toBeGreaterThanOrEqual(0.25);
    const nowIso = new Date(NOW).toISOString();
    const ledger: LaneLedger = {
      "cliproxy-zai": {
        laneId: "cliproxy-zai",
        fetchedAt: nowIso,
        error: null,
        observation: null,
        verdict: {
          laneId: "cliproxy-zai",
          observedAt: nowIso,
          state: "ahead",
          serviceable: true,
          score: { utilization: 0.7, elapsed: 0.5, deviation: 0.2 },
          accounts: [],
          knownAccountCount: 1,
          knownWeight: 1,
          serviceableAccountCount: 1,
          urgentResetAt: null,
          reason: "ok",
        },
      },
      "cliproxy-codex": {
        laneId: "cliproxy-codex",
        fetchedAt: nowIso,
        error: null,
        observation: null,
        verdict: {
          laneId: "cliproxy-codex",
          observedAt: nowIso,
          state: "on",
          serviceable: true,
          score: { utilization: 0.5, elapsed: 0.5, deviation: 0 },
          accounts: [],
          knownAccountCount: 1,
          knownWeight: 1,
          serviceableAccountCount: 1,
          urgentResetAt: null,
          reason: "ok",
        },
      },
    };
    const zaiModel = toModelEntry({
      id: "zai-t1-cheap",
      tier: "T1",
      laneId: "cliproxy-zai",
      costPerMTokIn: 0.4,
      costPerMTokOut: 1.6,
    });
    const codexModel = toModelEntry({
      id: "codex-t1-cover",
      tier: "T1",
      laneId: "cliproxy-codex",
      costPerMTokIn: 3,
      costPerMTokOut: 15,
    });
    expect(slotFactorFor(ledger, zaiModel, 0.25)).toBe(0.25);
    expect(slotFactorFor(ledger, codexModel, 0.25)).toBe(1);
    expect(slotAllowed(issueId, ledger, zaiModel, 0.25)).toBe(false);
    expect(slotAllowed(issueId, ledger, codexModel, 0.25)).toBe(true);
  });
});
