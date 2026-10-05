import { describe, expect, it } from "vitest";

import { resolveConfig, validateConfig } from "../src/config/resolve.js";

/**
 * : enforce preflight refuses enforce when an ENABLED lane has no
 * pacing.lanes entry — fail closed between the roster and the enforce flip.
 *
 * Each test pins EVERY conjunct explicitly (mode, tier coverage, row
 * enablement, lane wiring), or it passes vacuously: an omitted key inherits
 * the default and the test then proves the default, not the gate.
 *
 * Non-goals (owned elsewhere, never asserted here): empty-tier refusal is
 * ; stale-shadow refusal is done in ; repin-drop is
 * ; live lanes wiring is . Fixtures only: no live flip,
 * no config write.
 */

const lane = (laneId: string) => ({
  laneId,
  statusUrl: "https://example.test/status",
  windows: [
    {
      name: "primary",
      role: "serviceability",
      utilizationFields: ["utilization"],
    },
  ],
});

const row = (id: string, tier: string, laneId: string, enabled = true) => ({
  id,
  tier,
  releasedAt: "2026-06-01",
  costPerMTokIn: 15,
  costPerMTokOut: 75,
  costPerMTokCacheRead: 1.5,
  laneId,
  enabled,
});

/** Every tier served, every row enabled, every lane wired. */
function wiredInput() {
  return {
    selection: { mode: "enforce" },
    pacing: { mode: "shadow", lanes: [lane("lane-t1"), lane("lane-t2"), lane("lane-t3")] },
    models: [
      row("m-t1a", "T1", "lane-t1"),
      row("m-t1b", "T1", "lane-t1"),
      row("m-t2", "T2", "lane-t2"),
      row("m-t3", "T3", "lane-t3"),
    ],
  };
}

describe(" enforce preflight: wired enabled lane passes", () => {
  it("resolves clean in enforce mode with every tier served and every lane wired", () => {
    const { errors } = validateConfig(resolveConfig(wiredInput()));
    expect(errors).toEqual([]);
  });
});

describe(" enforce preflight: unwired enabled lane refuses", () => {
  it("refuses naming the lane id and the missing pacing.lanes key", () => {
    // pacing.mode=off keeps the  Defect 6 gate silent (it only fires
    // when pacing is on), so the single error below is the  gate
    // alone — the isolation proves the new predicate is load-bearing.
    const input = wiredInput();
    input.pacing = { mode: "off", lanes: [lane("lane-t2"), lane("lane-t3")] };
    const { errors } = validateConfig(resolveConfig(input));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("lane-t1");
    expect(errors[0]).toContain("pacing.lanes");
    expect(errors[0]).toContain("enforce");
  });

  it("positive control: the same input with the lane wired resolves clean", () => {
    const input = wiredInput();
    input.pacing = {
      mode: "off",
      lanes: [lane("lane-t1"), lane("lane-t2"), lane("lane-t3")],
    };
    const { errors } = validateConfig(resolveConfig(input));
    expect(errors).toEqual([]);
  });
});

describe(" enforce preflight: disabled lane without entry passes", () => {
  it("passes when only a disabled row references the missing lane", () => {
    // Mode pinned to enforce (not the advise default), every tier still
    // served (m-t1b covers T1), pacing on (so Defect 6 would fire for an
    // enabled row) — the ONLY reason lane-retired is tolerated is that its
    // sole referencing row is disabled.
    const input = wiredInput();
    input.models = [
      row("m-t1a", "T1", "lane-retired", false),
      row("m-t1b", "T1", "lane-t1"),
      row("m-t2", "T2", "lane-t2"),
      row("m-t3", "T3", "lane-t3"),
    ];
    const { errors } = validateConfig(resolveConfig(input));
    expect(errors.some((e) => e.includes("lane-retired"))).toBe(false);
    expect(errors).toEqual([]);
  });

  it("positive control: enabling that row brings the refusal back", () => {
    const input = wiredInput();
    input.models = [
      row("m-t1a", "T1", "lane-retired", true),
      row("m-t1b", "T1", "lane-t1"),
      row("m-t2", "T2", "lane-t2"),
      row("m-t3", "T3", "lane-t3"),
    ];
    const { errors } = validateConfig(resolveConfig(input));
    expect(errors.some((e) => e.includes("lane-retired") && e.includes("pacing.lanes"))).toBe(true);
  });
});
