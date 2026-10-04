import { describe, expect, it } from "vitest";

import { assembleAdditiveConfig } from "../scripts/assemble-additive-config.mjs";
import {
  evaluateLanePace,
  normalizeLaneDocument,
  type LanePaceDefinition,
} from "../src/lane-capacity/pace.js";

/**
 * Codex + Claude account lane-row validation.
 *
 * The operator read (2026-10-03) reports the
 * non-bridge subscription accounts as Codex 3 accounts at 14%/14%/0% weekly
 * utilization and Claude 2 accounts at 17%/2%, with weekly resets 10-09/10-10.
 *
 * WHAT THIS PROVES (fixtures + unit checks only):
 *
 * - each of the 5 operator-read accounts evaluates serviceable on its lane
 *   (cliproxy-codex / cliproxy-claude), with account identity, utilization
 *   and reset multisets matching the operator read — including the 0% Codex
 *   account, which is empty, not exhausted;
 * - `assembleAdditiveConfig` binds every enabled non-bridge roster row to
 *   exactly one lane (Claude ids to cliproxy-claude, GPT and Codex ids to
 *   cliproxy-codex), leaves `enabledWithoutLane` empty, and maps each lane
 *   to exactly its expected row set;
 * - the check is non-vacuous: the same roster against a live config missing
 *   the Claude lane fails closed instead of shipping unlaned rows.
 *
 * NON-GOALS (owned elsewhere): bridge-model rows (muse-spark-1.3-contributor,
 * claude-sonnet-5-5, gpt-6.1-sol) and the agreement re-run;
 * weekly-vs-5h pacing; capacity fan-out; shadow
 * compare; the enforce path. No enforce change, no
 * retirement: the disabled control row below stays disabled.
 */

const OBSERVED_AT = "2026-10-03T21:00:00.000Z";

function laneDefinition(laneId: string): LanePaceDefinition {
  return {
    laneId,
    healthFields: ["health"],
    accountKeyFields: ["account_key"],
    weightFields: ["plan_weight"],
    windows: [
      {
        name: "weekly",
        role: "allowance",
        utilizationFields: ["seven_day_utilization"],
        resetFields: ["seven_day_resets_at"],
        defaultWindowSeconds: 604_800,
      },
    ],
  };
}

function accountRecord(accountKey: string, utilization: number, resetsAt: string) {
  return {
    account_key: accountKey,
    health: "healthy",
    plan_weight: 1,
    seven_day_utilization: utilization,
    seven_day_resets_at: resetsAt,
  };
}

// Pairing of each utilization to its reset is the fixture's choice — the card
// gives utilizations and resets without pairing them. The assertions pin the
// lane-level multisets, never the pairing.
const CODEX_RECORDS = [
  accountRecord("codex-acct-1", 0.14, "2026-10-09T00:00:00.000Z"),
  accountRecord("codex-acct-2", 0.14, "2026-10-10T00:00:00.000Z"),
  accountRecord("codex-acct-3", 0.0, "2026-10-10T00:00:00.000Z"),
];
const CLAUDE_RECORDS = [
  accountRecord("claude-acct-1", 0.17, "2026-10-09T00:00:00.000Z"),
  accountRecord("claude-acct-2", 0.02, "2026-10-10T00:00:00.000Z"),
];

function observe(laneId: string, records: Record<string, unknown>[]) {
  const observation = normalizeLaneDocument({
    document: { observedAt: OBSERVED_AT, records },
    definition: laneDefinition(laneId),
  });
  expect(observation.error).toBeNull();
  return observation;
}

function windowMultisets(observation: ReturnType<typeof observe>) {
  const utilization = observation.accounts
    .map((account) => account.windows[0]?.utilization)
    .sort();
  const resets = observation.accounts
    .map((account) => account.windows[0]?.resetsAt)
    .sort();
  return { utilization, resets };
}

function row(id: string, tier: "T1" | "T2" | "T3", enabled = true) {
  return { id, tier, enabled };
}

// Enabled non-bridge rows only. Bridge ids (muse-spark-1.3-contributor,
// claude-sonnet-5-5, gpt-6.1-sol) are covered elsewhere and stay out of this slice.
const NON_BRIDGE_ROSTER = [
  row("claude-opus-5", "T1"),
  row("claude-fable-5-1", "T1"),
  row("gpt-5.6-sol", "T1"),
  row("gpt-5.6-sol", "T2"),
  row("gpt-6-astra", "T1"),
  row("gpt-5.6-luna", "T3"),
];

const EXPECTED_LANE: Record<string, string> = {
  "claude-opus-5": "cliproxy-claude",
  "claude-fable-5-1": "cliproxy-claude",
  "gpt-5.6-sol": "cliproxy-codex",
  "gpt-6-astra": "cliproxy-codex",
  "gpt-5.6-luna": "cliproxy-codex",
};

function pacingLane(laneId: string) {
  return {
    laneId,
    statusUrl: `https://status.example/${laneId}`,
    apiKeySecretRef: { type: "secret_ref", secretId: `secret-${laneId}` },
    windows: [{ name: "weekly", role: "allowance", utilizationFields: ["used"] }],
  };
}

function liveWithLanes(laneIds: string[]) {
  return {
    models: [],
    pacing: { mode: "shadow", lanes: laneIds.map(pacingLane) },
  };
}

function assemble(
  models: ReturnType<typeof row>[],
  laneIds: string[],
  minimumLaneBoundModels = models.filter((model) => model.enabled).length,
) {
  return assembleAdditiveConfig({ models }, liveWithLanes(laneIds), {
    minimumLaneBoundModels,
  });
}

describe("Codex/Claude account lane rows", () => {
  it("serves all three operator-read Codex accounts on cliproxy-codex", () => {
    const observation = observe("cliproxy-codex", CODEX_RECORDS);
    const verdict = evaluateLanePace({ observation, asOf: OBSERVED_AT });

    expect(verdict.serviceable).toBe(true);
    expect(verdict.knownAccountCount).toBe(3);
    expect(verdict.serviceableAccountCount).toBe(3);
    expect(verdict.accounts.map((account) => account.accountKey).sort()).toEqual([
      "codex-acct-1",
      "codex-acct-2",
      "codex-acct-3",
    ]);
    expect(windowMultisets(observation)).toEqual({
      utilization: [0, 0.14, 0.14],
      resets: [
        "2026-10-09T00:00:00.000Z",
        "2026-10-10T00:00:00.000Z",
        "2026-10-10T00:00:00.000Z",
      ],
    });
  });

  it("serves both operator-read Claude accounts on cliproxy-claude", () => {
    const observation = observe("cliproxy-claude", CLAUDE_RECORDS);
    const verdict = evaluateLanePace({ observation, asOf: OBSERVED_AT });

    expect(verdict.serviceable).toBe(true);
    expect(verdict.knownAccountCount).toBe(2);
    expect(verdict.serviceableAccountCount).toBe(2);
    expect(verdict.accounts.map((account) => account.accountKey).sort()).toEqual([
      "claude-acct-1",
      "claude-acct-2",
    ]);
    expect(windowMultisets(observation)).toEqual({
      utilization: [0.02, 0.17],
      resets: ["2026-10-09T00:00:00.000Z", "2026-10-10T00:00:00.000Z"],
    });
  });

  it("keeps the 0%-utilization Codex account serviceable — empty is not exhausted", () => {
    const observation = observe("cliproxy-codex", CODEX_RECORDS);
    const verdict = evaluateLanePace({ observation, asOf: OBSERVED_AT });

    const empty = verdict.accounts.find((account) => account.accountKey === "codex-acct-3");
    expect(empty?.serviceable).toBe(true);
    expect(empty?.health).toBe("healthy");
    expect(empty?.state).not.toBe("exhausted");
  });

  it("binds every enabled non-bridge row to exactly one expected lane, none unlaned", () => {
    const result = assemble(NON_BRIDGE_ROSTER, ["cliproxy-codex", "cliproxy-claude"]);

    for (const model of result.config.models) {
      expect(model.laneId).toBe(EXPECTED_LANE[model.id]);
    }
    expect(result.counts.enabledWithoutLane).toEqual([]);
  });

  it("maps each lane to exactly its expected enabled row set", () => {
    const result = assemble(NON_BRIDGE_ROSTER, ["cliproxy-codex", "cliproxy-claude"]);

    const byLane = new Map<string, string[]>();
    for (const model of result.config.models) {
      const key = `${model.id}:${model.tier}`;
      byLane.set(model.laneId, [...(byLane.get(model.laneId) ?? []), key]);
    }
    for (const rows of byLane.values()) rows.sort();
    expect(Object.fromEntries(byLane)).toEqual({
      "cliproxy-claude": ["claude-fable-5-1:T1", "claude-opus-5:T1"],
      "cliproxy-codex": [
        "gpt-5.6-luna:T3",
        "gpt-5.6-sol:T1",
        "gpt-5.6-sol:T2",
        "gpt-6-astra:T1",
      ],
    });
  });

  it("leaves a disabled row disabled without tripping the unlaned guard — no retirement", () => {
    const result = assemble(
      [...NON_BRIDGE_ROSTER, row("claude-sonnet-5", "T2", false)],
      ["cliproxy-codex", "cliproxy-claude"],
    );

    const control = result.config.models.find((model) => model.id === "claude-sonnet-5");
    expect(control).toMatchObject({ tier: "T2", enabled: false });
    expect(result.counts.enabledWithoutLane).toEqual([]);
  });

  it("positive control: the same roster without the Claude lane fails closed", () => {
    // Minimum 0 so the count guard cannot fire first: the throw below must
    // come from the unlaned-enabled check, proving the check itself works.
    expect(() => assemble(NON_BRIDGE_ROSTER, ["cliproxy-codex"], 0)).toThrow(
      "enabled models outside pacing lanes: claude-opus-5:T1, claude-fable-5-1:T1",
    );
  });
});
