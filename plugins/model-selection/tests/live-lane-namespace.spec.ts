import { describe, expect, it } from "vitest";

import { resolveConfig } from "../src/config/resolve.js";
import { selectModel } from "../src/engine/select.js";
import { avoidThresholdFor, laneHasRoom, zaiWeeklyPaceOk, type LaneLedger } from "../src/engine/pacing.js";
import type { ModelEntry } from "../src/engine/types.js";
import type { LanePaceObservation, LanePaceVerdict } from "../src/lane-capacity/pace.js";
import { MODELS, NO_ESCALATION, NOW, PROFILES, config } from "./fixtures.js";

/**
 * TOG-2533: the live company config never sets `pacing.codexLaneId` /
 * `pacing.opencodeGoLaneId` / `pacing.avoid.perLane` / `pacing.laneCapPerAccount`
 * / `pacing.fiveHourWindowName` at all — every one of these rules must fire
 * correctly from CODE DEFAULTS ALONE under the real deployed lane ids
 * (`cliproxy-codex`, `cliproxy-opencode-go`, `cliproxy-zai`) and the real
 * hyphenated `five-hour` window name. This suite deliberately passes NO
 * operator overrides for any of those fields, mirroring the live additive
 * config, to prove `resolveConfig(undefined)`'s own defaults are what make
 * enforcement work on the real deployment rather than on a bare-string test
 * fixture that happens to match a stale default.
 */
describe("live lane/window vocabulary (2026-09-14 TOG-2533: cliproxy-* lane ids, five-hour window)", () => {
  const resolved = resolveConfig(undefined);

  it("resolves the canonical live lane ids and window name from defaults alone", () => {
    expect(resolved.pacing.codexLaneId).toBe("cliproxy-codex");
    expect(resolved.pacing.opencodeGoLaneId).toBe("cliproxy-opencode-go");
    expect(resolved.pacing.zai.laneId).toBe("cliproxy-zai");
    expect(resolved.pacing.fiveHourWindowName).toBe("five-hour");
  });

  it("Codex avoid threshold defaults to 0.99 under its live lane id, not the generic 0.8", () => {
    expect(resolved.pacing.avoid.perLane).toEqual({ "cliproxy-codex": 0.99 });
    expect(avoidThresholdFor(resolved.pacing.avoid, "cliproxy-codex")).toBe(0.99);
    expect(avoidThresholdFor(resolved.pacing.avoid, "cliproxy-opencode-go")).toBe(0.8);
  });

  it("Go cap defaults to 2 and Zai cap defaults to 3 under their live lane ids", () => {
    expect(resolved.pacing.laneCapPerAccount).toEqual({
      "cliproxy-opencode-go": 2,
      "cliproxy-zai": 3,
    });
  });

  it("Go/Zai 5h new-admission stop (>=0.5) applies under the live hyphenated 'five-hour' window name", () => {
    const ledger: LaneLedger = {
      "cliproxy-opencode-go": {
        laneId: "cliproxy-opencode-go",
        fetchedAt: "t",
        error: null,
        verdict: null,
        observation: {
          laneId: "cliproxy-opencode-go",
          free: false,
          observedAt: "2026-09-14T12:00:00.000Z",
          staleAfterSeconds: 900,
          accounts: [
            {
              accountKey: "a1",
              health: "healthy",
              weight: 1,
              weightSource: "reported",
              governingWindow: "five-hour",
              windows: [
                {
                  name: "five-hour",
                  role: "allowance",
                  utilization: 0.5,
                  resetsAt: "2026-09-14T17:00:00.000Z",
                  windowSeconds: 5 * 60 * 60,
                  sourcePath: null,
                },
              ],
            },
          ],
          error: null,
        } satisfies LanePaceObservation,
      },
    };
    const admitted = laneHasRoom({
      laneId: "cliproxy-opencode-go",
      activePinsWeight: 0,
      ledger,
      capPerAccount: resolved.pacing.laneCapPerAccount,
      fiveHourWindowName: resolved.pacing.fiveHourWindowName,
      zaiLaneId: resolved.pacing.zai.laneId,
      zaiWeeklyWindowName: resolved.pacing.zai.weeklyWindowName,
      zaiWeeklyDefaultMargin: resolved.pacing.zai.weeklyDefaultMargin,
      zaiPaceOverrideMargin: null,
      nowMs: Date.parse("2026-09-14T12:00:00.000Z"),
    });
    expect(admitted).toBe(false);
  });

  it("Z.ai weekly pace guard applies under the live 'cliproxy-zai' lane id and default 'weekly' window", () => {
    const ledger: LaneLedger = {
      "cliproxy-zai": {
        laneId: "cliproxy-zai",
        fetchedAt: "t",
        error: null,
        verdict: null,
        observation: {
          laneId: "cliproxy-zai",
          free: false,
          observedAt: "2026-09-14T12:00:00.000Z",
          staleAfterSeconds: 900,
          accounts: [
            {
              accountKey: "a1",
              health: "healthy",
              weight: 1,
              weightSource: "reported",
              governingWindow: "weekly",
              windows: [
                {
                  name: "weekly",
                  role: "allowance",
                  // Far ahead of elapsed-fraction-of-week + default 0.15 margin.
                  utilization: 0.95,
                  resetsAt: "2026-09-18T12:00:00.000Z",
                  windowSeconds: 7 * 24 * 60 * 60,
                  sourcePath: null,
                },
              ],
            },
          ],
          error: null,
        } satisfies LanePaceObservation,
      },
    };
    const ok = zaiWeeklyPaceOk({
      ledger,
      laneId: resolved.pacing.zai.laneId,
      weeklyWindowName: resolved.pacing.zai.weeklyWindowName,
      defaultMargin: resolved.pacing.zai.weeklyDefaultMargin,
      overrideMargin: null,
      nowMs: Date.parse("2026-09-14T12:00:00.000Z"),
    });
    expect(ok).toBe(false);
  });

  it("Z.ai peak-hour guard (Mon-Fri 06:00-10:00 UTC) tightens the live 'cliproxy-zai' cap to 1", () => {
    const admitted = laneHasRoom({
      laneId: "cliproxy-zai",
      activePinsWeight: 1,
      ledger: {},
      capPerAccount: resolved.pacing.laneCapPerAccount,
      fiveHourWindowName: resolved.pacing.fiveHourWindowName,
      zaiLaneId: resolved.pacing.zai.laneId,
      zaiWeeklyWindowName: resolved.pacing.zai.weeklyWindowName,
      zaiWeeklyDefaultMargin: resolved.pacing.zai.weeklyDefaultMargin,
      zaiPaceOverrideMargin: null,
      nowMs: Date.parse("2026-09-14T07:00:00.000Z"), // Monday, in peak window
    });
    expect(admitted).toBe(false);
  });

  const t1 = MODELS.find((entry) => entry.tier === "T1")!;
  const goModel: ModelEntry = { ...t1, id: "go-model-live", laneId: "cliproxy-opencode-go", costPerMTokIn: 0.5, costPerMTokOut: 0.5 };
  const codexModel: ModelEntry = { ...t1, id: "codex-model-live", laneId: "cliproxy-codex", costPerMTokIn: 10, costPerMTokOut: 10 };
  const zaiModel: ModelEntry = { ...t1, id: "zai-model-live", laneId: "cliproxy-zai", costPerMTokIn: 0.5, costPerMTokOut: 0.5 };

  function codexVerdict(utilization: number): LanePaceVerdict {
    return {
      laneId: "cliproxy-codex",
      observedAt: "2026-09-14T12:00:00.000Z",
      state: "on",
      serviceable: true,
      score: { utilization, elapsed: 0.5, deviation: 0 },
      accounts: [],
      knownAccountCount: 1,
      knownWeight: 1,
      serviceableAccountCount: 1,
      urgentResetAt: null,
      reason: "ok",
    };
  }

  function codexLedger(utilization: number): LaneLedger {
    return {
      "cliproxy-codex": {
        laneId: "cliproxy-codex",
        fetchedAt: "t",
        error: null,
        observation: null,
        verdict: codexVerdict(utilization),
      },
    };
  }

  it("T1 Go fallback: stays off cliproxy-opencode-go while cliproxy-codex still has room, using only code defaults", () => {
    const decision = selectModel({
      profiles: PROFILES,
      signals: NO_ESCALATION,
      now: NOW,
      descriptor: { issueId: "live-go-fallback-1", labelNames: ["tier:T1"] },
      config: config({
        models: [goModel, codexModel],
        pacingMode: "enforce",
        laneLedger: codexLedger(0.5),
        laneAvoidConfig: resolved.pacing.avoid,
        // Deliberately NOT passing codexLaneId/opencodeGoLaneId — proving the
        // gate fires from `select.ts`'s own `LANE_ID_CODEX`/`LANE_ID_OPENCODE_GO`
        // fallback constants, which are now canonicalized to the live ids.
      }),
    });
    expect(decision.modelId).toBe(codexModel.id);
    const rejection = decision.rejections.find((r) => r.modelId === goModel.id && r.stage === "lane-avoid");
    expect(rejection?.reason).toContain("Go fallback only");
  });

  it("long-run Z.ai exclusion: routes a named long-turn agent off cliproxy-zai onto cliproxy-codex, using only code defaults", () => {
    const decision = selectModel({
      profiles: PROFILES,
      signals: NO_ESCALATION,
      now: NOW,
      descriptor: { issueId: "live-zai-long-run-1", labelNames: ["tier:T1"], agentName: "Founding Engineer" },
      config: config({
        models: [zaiModel, codexModel],
        pacingMode: "enforce",
        laneLedger: codexLedger(0.3),
        laneAvoidConfig: resolved.pacing.avoid,
      }),
    });
    expect(decision.modelId).toBe(codexModel.id);
    const rejection = decision.rejections.find((r) => r.modelId === zaiModel.id && r.stage === "lane-avoid");
    expect(rejection?.reason).toContain("Founding Engineer");
    expect(rejection?.reason).toContain("1214");
  });

  it("Codex avoid 0.99 end-to-end: a 0.9-utilized codex lane is NOT avoided (below its own 0.99 threshold) while the generic 0.8 would have excluded it", () => {
    const decision = selectModel({
      profiles: PROFILES,
      signals: NO_ESCALATION,
      now: NOW,
      descriptor: { issueId: "live-codex-avoid-1", labelNames: ["tier:T1"] },
      config: config({
        models: [codexModel, goModel],
        pacingMode: "enforce",
        laneLedger: codexLedger(0.9),
        laneAvoidConfig: resolved.pacing.avoid,
      }),
    });
    expect(decision.rejections.some((r) => r.modelId === codexModel.id && r.stage === "lane-avoid")).toBe(false);
    expect(decision.modelId).toBe(codexModel.id);
  });
});
