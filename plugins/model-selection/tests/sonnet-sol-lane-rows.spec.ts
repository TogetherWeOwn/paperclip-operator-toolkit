import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { assembleAdditiveConfig } from "../scripts/assemble-additive-config.mjs";
import type { LaneLedger } from "../src/engine/pacing.js";
import { selectModel } from "../src/engine/select.js";
import type { ModelEntry } from "../src/engine/types.js";
import type { LanePaceVerdict } from "../src/lane-capacity/pace.js";
import { MODELS, NO_ESCALATION, NOW, PROFILES, config } from "./fixtures.js";

/**
 * : lane-bound rows for the two bridge models plus the bare-prefix
 * lane-inference matrix (fixtures only).
 *
 * Slice of , decomposed from . The rows already live in
 * `config/reviewed-roster.json` (`claude-sonnet-5-5` T2 enabled, `gpt-6.1-sol`
 * T1 enabled); this spec pins that shape field-for-field, proves
 * `assembleAdditiveConfig` binds each row to its lane with nothing unlaned,
 * pins `laneForNewModel` inference for every bare `claude-*`/`gpt-*`/
 * `codex-*`/`kimi-*` id onto `cliproxy-claude`/`cliproxy-codex`/
 * `cliproxy-kimi` (today only bare `glm-*` inference is tested, in
 * `additive-config.spec.ts`), and proves binding and the serviceability hard
 * stop AGREE row by row — the lane the assembly binds is the lane whose
 * verdict admits/excludes that row.
 *
 * WHAT THIS PROVES (fixtures + unit checks only, no live mutation):
 * - each new fixture mirrors its reviewed row field-for-field (identity,
 *   tier, enabled, capabilities, context window, list price, aaIndex,
 *   release date, fallbackOnly);
 * - assembly binds `claude-sonnet-5-5` to `cliproxy-claude` and
 *   `gpt-6.1-sol` to `cliproxy-codex`, leaves `enabledWithoutLane` empty,
 *   and fails closed when the row's lane is missing (positive controls);
 * - the bare-prefix matrix infers `claude-x` -> claude, `gpt-x`/`codex-x`
 *   -> codex, `kimi-x` -> kimi, and fails closed (null lane) when the
 *   target pacing lane is absent;
 * - with the row's lane healthy the lane-bound new row is selected; with
 *   that lane exhausted the hard stop excludes it on the SAME lane the
 *   assembly bound, naming that lane in the rejection.
 *
 * NON-GOALS (owned elsewhere, do not duplicate): Muse row (,
 * blocked, PR #602 in review ); sonnet+sol rows 
 * (cancelled — this leaf supersedes that row scope with added
 * inference-matrix coverage); bridge-vs-selector harness (,
 * blocked — this card is row-level only); pacing.lanes wiring (,
 * in_progress — rows must assemble laned without it); enforce path
 * (, blocked). No roster writes, no pin changes, no enforce flip:
 * `selection.mode` is untouched and every decision here runs without a
 * ledger pace mode, i.e. hard-stop-only admission.
 */

// Field values read off plugins/model-selection/config/reviewed-roster.json
// (verified 2026-10-04): sonnet-5-5 T2 on the Claude lane at sonnet-5 list
// price (3/15/0.3), unscored so tier is retained; 6.1-sol T1 on the Codex lane
// at 5.6-sol list price (4/20/0.4), regular T1 row, NOT fallbackOnly.
const SONNET_ROW = {
  id: "claude-sonnet-5-5",
  tier: "T2",
  enabled: true,
  capabilities: ["tools", "structured-output", "vision", "long-context"],
  contextWindow: 1_000_000,
  costPerMTokIn: 3,
  costPerMTokOut: 15,
  costPerMTokCacheRead: 0.3,
  aaIndex: null,
  releasedAt: "2026-06-24",
  fallbackOnly: false,
} as const;

const SOL_ROW = {
  id: "gpt-6.1-sol",
  tier: "T1",
  enabled: true,
  capabilities: ["tools", "structured-output", "vision", "long-context"],
  contextWindow: 400_000,
  costPerMTokIn: 4,
  costPerMTokOut: 20,
  costPerMTokCacheRead: 0.4,
  aaIndex: null,
  releasedAt: "2026-06-01",
  fallbackOnly: false,
} as const;

const reviewed = JSON.parse(
  readFileSync(new URL("../config/reviewed-roster.json", import.meta.url), "utf8"),
) as { models: Array<Record<string, unknown>> };

function reviewedRow(id: string) {
  const row = reviewed.models.find((model) => model.id === id);
  expect(row, `${id} present in reviewed-roster.json`).toBeDefined();
  return row!;
}

function pacingLane(laneId: string) {
  return {
    laneId,
    statusUrl: `https://status.example/${laneId}`,
    apiKeySecretRef: { type: "secret_ref", secretId: `secret-${laneId}` },
    windows: [{ name: "weekly", role: "allowance", utilizationFields: ["used"] }],
  };
}

function assemble(models: Array<Record<string, unknown>>, laneIds: string[]) {
  return assembleAdditiveConfig(
    { models },
    { models: [], pacing: { mode: "shadow", lanes: laneIds.map(pacingLane) } },
    { minimumLaneBoundModels: models.filter((model) => model.enabled === true).length },
  );
}

function verdict(
  laneId: string,
  state: LanePaceVerdict["state"],
  serviceable: boolean,
  reason: LanePaceVerdict["reason"],
): LanePaceVerdict {
  return {
    laneId,
    observedAt: new Date(NOW).toISOString(),
    state,
    serviceable,
    score: null,
    accounts: [],
    knownAccountCount: 1,
    knownWeight: 1,
    serviceableAccountCount: serviceable ? 1 : 0,
    urgentResetAt: null,
    reason,
  };
}

function ledgerOf(entries: Array<[string, LanePaceVerdict]>): LaneLedger {
  const ledger: LaneLedger = {};
  for (const [laneId, laneVerdict] of entries) {
    ledger[laneId] = { laneId, verdict: laneVerdict, fetchedAt: NOW.toString(), error: null, observation: null };
  }
  return ledger;
}

/**
 * Row-level agreement board for one new row: the new row plus one rival on a
 * DIFFERENT lane, so the exhausted-lane case has a deterministic winner. The
 * new row is the cheaper of the pair, so a healthy lane board selects it on
 * list price. Rival ids are synthetic on purpose — they stand in for
 * "any healthy same-tier rival on another lane", never for a real row.
 */
function agreementBoard(
  row: { id: string; tier: "T1" | "T2" },
  rowLane: string,
  rivalLane: string,
): ModelEntry[] {
  const base = MODELS.find((entry) => entry.tier === row.tier)!;
  const lane = (id: string, laneId: string, costPerMTokIn: number): ModelEntry => ({
    ...base,
    id,
    laneId,
    costPerMTokIn,
    costPerMTokOut: costPerMTokIn * 5,
    costPerMTokCacheRead: costPerMTokIn / 10,
  });
  return [
    lane(row.id, rowLane, row.id === SOL_ROW.id ? 4 : 3),
    lane(`rival-${row.tier.toLowerCase()}-other-lane`, rivalLane, row.id === SOL_ROW.id ? 15 : 10),
  ];
}

function decide(models: ModelEntry[], laneLedger: LaneLedger, tier: "T1" | "T2") {
  return selectModel({
    profiles: PROFILES,
    signals: NO_ESCALATION,
    now: NOW,
    descriptor: { issueId: `-${tier.toLowerCase()}`, labelNames: [`tier:${tier}`] },
    config: config({ models, laneLedger }),
  });
}

describe(" sonnet-5-5 + 6.1-sol lane-bound rows", () => {
  it("reviewed roster carries both rows enabled with the pinned shape", () => {
    expect(reviewedRow("claude-sonnet-5-5")).toMatchObject({ ...SONNET_ROW });
    expect(reviewedRow("gpt-6.1-sol")).toMatchObject({ ...SOL_ROW });
  });

  it.each([
    ["claude-sonnet-5-5", "cliproxy-claude", SONNET_ROW],
    ["gpt-6.1-sol", "cliproxy-codex", SOL_ROW],
  ] as const)(
    "assembly binds %s to %s with its reviewed shape intact, none unlaned",
    (id, laneId, row) => {
      const result = assemble([{ ...row }], ["cliproxy-claude", "cliproxy-codex"]);

      expect(result.config.models).toEqual([
        expect.objectContaining({
          id,
          tier: row.tier,
          enabled: true,
          laneId,
          capabilities: [...row.capabilities],
          contextWindow: row.contextWindow,
          costPerMTokIn: row.costPerMTokIn,
          costPerMTokOut: row.costPerMTokOut,
          costPerMTokCacheRead: row.costPerMTokCacheRead,
          aaIndex: row.aaIndex,
          releasedAt: row.releasedAt,
          fallbackOnly: row.fallbackOnly,
        }),
      ]);
      expect(result.counts.enabledWithoutLane).toEqual([]);
      expect(result.counts).toMatchObject({ preservedLaneBindings: 0, inferredLaneBindings: 1 });
    },
  );

  it.each([
    ["claude-sonnet-5-5", SONNET_ROW, "cliproxy-codex"],
    ["gpt-6.1-sol", SOL_ROW, "cliproxy-claude"],
  ] as const)(
    "positive control: %s without its lane fails closed naming the row",
    (id, row, otherLane) => {
      // Minimum 0 so the count guard cannot fire first: the throw below must
      // come from the unlaned-enabled check, proving the check itself works.
      expect(() =>
        assembleAdditiveConfig(
          { models: [{ ...row }] },
          { models: [], pacing: { mode: "shadow", lanes: [otherLane].map(pacingLane) } },
          { minimumLaneBoundModels: 0 },
        ),
      ).toThrow(`enabled models outside pacing lanes: ${id}:${row.tier}`);
    },
  );
});

describe(" bare-prefix lane-inference matrix", () => {
  it.each([
    ["claude-sonnet-9", "cliproxy-claude"],
    ["gpt-7-turbo", "cliproxy-codex"],
    ["codex-mini-next", "cliproxy-codex"],
    ["kimi-k4-go", "cliproxy-kimi"],
  ] as const)("infers bare %s onto %s", (id, laneId) => {
    const result = assemble(
      [{ id, tier: "T2", enabled: true }],
      ["cliproxy-claude", "cliproxy-codex", "cliproxy-kimi"],
    );

    expect(result.config.models).toEqual([
      expect.objectContaining({ id, tier: "T2", enabled: true, laneId }),
    ]);
    expect(result.counts.enabledWithoutLane).toEqual([]);
  });

  it.each([
    ["claude-sonnet-9", "cliproxy-claude"],
    ["gpt-7-turbo", "cliproxy-codex"],
    ["codex-mini-next", "cliproxy-codex"],
    ["kimi-k4-go", "cliproxy-kimi"],
  ] as const)("fails closed for bare %s when %s is absent", (id, laneId) => {
    const lanes = ["cliproxy-claude", "cliproxy-codex", "cliproxy-kimi"].filter(
      (lane) => lane !== laneId,
    );
    expect(() =>
      assembleAdditiveConfig(
        { models: [{ id, tier: "T2", enabled: true }] },
        { models: [], pacing: { mode: "shadow", lanes: lanes.map(pacingLane) } },
        { minimumLaneBoundModels: 0 },
      ),
    ).toThrow(`enabled models outside pacing lanes: ${id}:T2`);
  });
});

describe(" row-level select agreement", () => {
  it.each([
    ["claude-sonnet-5-5", "T2", "cliproxy-claude", "cliproxy-codex"],
    ["gpt-6.1-sol", "T1", "cliproxy-codex", "cliproxy-claude"],
  ] as const)(
    "healthy lanes: %s is selected on list price with no lane rejection",
    (id, tier, rowLane, rivalLane) => {
      const decision = decide(
        agreementBoard({ id, tier }, rowLane, rivalLane),
        ledgerOf([
          [rowLane, verdict(rowLane, "on", true, "ok")],
          [rivalLane, verdict(rivalLane, "on", true, "ok")],
        ]),
        tier,
      );

      expect(decision.outcome).toBe("selected");
      expect(decision.modelId).toBe(id);
      expect(
        decision.rejections.some(
          (rejection) => rejection.modelId === id && rejection.stage === "lane-unserviceable",
        ),
      ).toBe(false);
    },
  );

  it.each([
    ["claude-sonnet-5-5", "T2", "cliproxy-claude", "cliproxy-codex"],
    ["gpt-6.1-sol", "T1", "cliproxy-codex", "cliproxy-claude"],
  ] as const)(
    "exhausted lane: the hard stop excludes %s on the SAME lane the assembly bound",
    (id, tier, rowLane, rivalLane) => {
      const assembledLaneId = assemble(
        [{ id, tier, enabled: true }],
        ["cliproxy-claude", "cliproxy-codex"],
      ).config.models.find((model) => model.id === id)?.laneId;

      const decision = decide(
        agreementBoard({ id, tier }, rowLane, rivalLane),
        ledgerOf([
          [rowLane, verdict(rowLane, "exhausted", false, "all-accounts-unserviceable")],
          [rivalLane, verdict(rivalLane, "on", true, "ok")],
        ]),
        tier,
      );

      expect(decision.modelId).toBe(`rival-${tier.toLowerCase()}-other-lane`);
      const rowRejection = decision.rejections.find((rejection) => rejection.modelId === id);
      expect(rowRejection).toMatchObject({ stage: "lane-unserviceable" });
      // The agreement: the lane named by the exclusion is the lane the
      // assembly bound — binding and enforcement cannot drift apart.
      expect((rowRejection?.operand as { laneId?: string } | undefined)?.laneId).toBe(
        assembledLaneId,
      );
      expect(assembledLaneId).toBe(rowLane);
    },
  );
});
