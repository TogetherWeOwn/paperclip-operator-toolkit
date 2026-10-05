import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { assembleAdditiveConfig } from "../scripts/assemble-additive-config.mjs";

/**
 * assembled-snapshot freshness, regenerate-and-diff (read-only).
 *
 * Leaf of  under epic. The committed assembled-roster
 * snapshot is tests/fixtures/bridge/bridge-assembled-rows.json (repo
 * root, owned by ): the 3 bridge rows with the lane bindings the
 * assembly infers. A roster edit, a lane-rule change in
 * assemble-additive-config.mjs, or a hand-edit to the snapshot that is not
 * regenerated turns the §1 freshness test red instead of letting the
 * snapshot lie.
 *
 * Method: read the bridge rows from the committed reviewed-roster.json,
 * re-run the REAL assembleAdditiveConfig against a synthetic live config
 * carrying the snapshot's lanes, project (id, tier, enabled, laneId), and
 * diff against the committed snapshot. Fail visibly: every drift names the
 * model id. Fixtures only; no live account reads, no pacing change, no
 * enforce change.
 *
 * Non-goals (owned elsewhere, do not duplicate): tiers.yaml-vs-roster drift
 * (); per-model enabled-row inventory (); gap unit tests
 * (); live wiring ().
 */

const PLUGIN_DIR = resolve(__dirname, "..");
const REVIEWED_ROSTER_PATH = resolve(PLUGIN_DIR, "config", "reviewed-roster.json");
// Literal `../../../` so the mutation-gate fixture scan (which matchAlls `../`
// string literals) sees this repo-root read and stages it in the isolated
// baseline via MUTATION_TREE_REPO_FIXTURES.
const SNAPSHOT_PATH = resolve(__dirname, "../../../tests/fixtures/bridge/bridge-assembled-rows.json");

const BRIDGE_IDS = [
  "muse-spark-1.3-contributor",
  "claude-sonnet-5-5",
  "gpt-6.1-sol",
] as const;

type SnapshotRow = {
  id: string;
  tier: string;
  enabled: boolean;
  laneId?: string;
};

type Drift =
  | { kind: "missing"; modelId: string }
  | { kind: "extra"; modelId: string }
  | { kind: "stale-tier"; modelId: string; expectedTier: string; actualTier: string }
  | { kind: "disabled"; modelId: string }
  | {
      kind: "drifted-lane";
      modelId: string;
      expectedLane: string | null;
      actualLane: string | null;
    };

function projectRow(row: Record<string, unknown>): SnapshotRow {
  return {
    id: String(row.id),
    tier: String(row.tier),
    enabled: row.enabled === true,
    ...(typeof row.laneId === "string" && row.laneId.length > 0
      ? { laneId: row.laneId }
      : {}),
  };
}

/**
 * Pure diff of regenerated rows vs the committed snapshot. Both sides are
 * plain row arrays; order-insensitive, keyed on canonical id. Returns the
 * drift list (empty = fresh). Throws on malformed input instead of
 * reporting it as in-sync.
 */
function diffAssembledSnapshot(
  regenerated: Record<string, unknown>[],
  snapshot: Record<string, unknown>[],
): Drift[] {
  for (const [label, rows] of [
    ["regenerated", regenerated],
    ["snapshot", snapshot],
  ] as const) {
    const seen = new Set<string>();
    for (const row of rows) {
      if (!row || typeof row !== "object" || typeof row.id !== "string" || row.id === "") {
        throw new Error(`invalid-freshness-row: ${label} has a row without a string id`);
      }
      if (seen.has(row.id)) {
        throw new Error(`duplicate-freshness-row: ${label} has two rows for ${row.id}`);
      }
      seen.add(row.id);
    }
  }
  const fresh = new Map(regenerated.map((row) => [String(row.id), projectRow(row)]));
  const snap = new Map(snapshot.map((row) => [String(row.id), projectRow(row)]));
  const drifts: Drift[] = [];
  for (const [id, want] of snap) {
    const got = fresh.get(id);
    if (!got) {
      drifts.push({ kind: "missing", modelId: id });
      continue;
    }
    if (got.tier !== want.tier) {
      drifts.push({
        kind: "stale-tier",
        modelId: id,
        expectedTier: want.tier,
        actualTier: got.tier,
      });
    }
    if (want.enabled && !got.enabled) {
      drifts.push({ kind: "disabled", modelId: id });
    }
    if ((got.laneId ?? null) !== (want.laneId ?? null)) {
      drifts.push({
        kind: "drifted-lane",
        modelId: id,
        expectedLane: want.laneId ?? null,
        actualLane: got.laneId ?? null,
      });
    }
  }
  for (const id of fresh.keys()) {
    if (!snap.has(id)) drifts.push({ kind: "extra", modelId: id });
  }
  return drifts;
}

/** Visible failure: names every drifted model id. */
function assertSnapshotFresh(drifts: Drift[]): void {
  if (drifts.length === 0) return;
  const lines = drifts.map((drift) => {
    switch (drift.kind) {
      case "missing":
        return `missing: ${drift.modelId} in snapshot, absent from regenerated assembly`;
      case "extra":
        return `extra: ${drift.modelId} in regenerated assembly, absent from snapshot`;
      case "stale-tier":
        return `stale-tier: ${drift.modelId} snapshot ${drift.expectedTier}, regenerated ${drift.actualTier}`;
      case "disabled":
        return `disabled: ${drift.modelId} enabled in snapshot, not enabled after regeneration`;
      case "drifted-lane":
        return `drifted-lane: ${drift.modelId} snapshot ${drift.expectedLane ?? "unlaned"}, regenerated ${drift.actualLane ?? "unlaned"}`;
    }
  });
  throw new Error(`assembled-snapshot-drift: stale committed snapshot\n${lines.join("\n")}`);
}

function syntheticLive(laneIds: string[]) {
  return {
    models: [],
    pacing: {
      mode: "shadow",
      lanes: laneIds.map((laneId) => ({
        laneId,
        statusUrl: `https://status.example/${laneId}`,
        apiKeySecretRef: { type: "secret_ref", secretId: `secret-${laneId}` },
        windows: [{ name: "primary", role: "serviceability", utilizationFields: ["used"] }],
      })),
    },
  };
}

/** Re-run the real assembler over the committed roster bridge rows. */
function regenerateBridgeRows(): Record<string, unknown>[] {
  const roster = JSON.parse(readFileSync(REVIEWED_ROSTER_PATH, "utf8")) as {
    models: Record<string, unknown>[];
  };
  const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as {
    models: Record<string, unknown>[];
    lanes: { lane: string }[];
  };
  const bridgeRows = roster.models.filter(
    (row) => typeof row.id === "string" && (BRIDGE_IDS as readonly string[]).includes(row.id),
  );
  expect(bridgeRows.map((row) => row.id).sort()).toEqual([...BRIDGE_IDS].sort());
  const laneIds = snapshot.lanes.map((lane) => lane.lane);
  const result = assembleAdditiveConfig(
    { models: bridgeRows },
    syntheticLive(laneIds),
    { minimumLaneBoundModels: bridgeRows.length },
  );
  expect(result.counts.enabledWithoutLane).toEqual([]);
  return result.config.models as Record<string, unknown>[];
}

describe(" assembled-snapshot freshness", () => {
  it("regenerated assembly matches the committed snapshot (fail visibly on drift)", () => {
    const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as {
      models: Record<string, unknown>[];
    };
    const drifts = diffAssembledSnapshot(regenerateBridgeRows(), snapshot.models);
    expect(drifts).toEqual([]);
    expect(() => assertSnapshotFresh(drifts)).not.toThrow();
  });

  it("unit: fresh fixtures diff clean", () => {
    const rows = [
      { id: "a-model", tier: "T1", enabled: true, laneId: "cliproxy-codex" },
      { id: "b-model", tier: "T2", enabled: true, laneId: "cliproxy-claude" },
    ];
    expect(diffAssembledSnapshot(rows, structuredClone(rows))).toEqual([]);
  });

  it("unit: order-insensitive, disabled snapshot rows stay silent", () => {
    const regenerated = [
      { id: "a-model", tier: "T1", enabled: true, laneId: "cliproxy-codex" },
      { id: "b-model", tier: "T2", enabled: false },
    ];
    const snapshot = [...regenerated].reverse();
    expect(diffAssembledSnapshot(regenerated, snapshot)).toEqual([]);
  });

  it("positive control: stale-tier snapshot fails naming the model", () => {
    const regenerated = [{ id: "drift-probe-tier-1", tier: "T1", enabled: true }];
    const snapshot = [{ id: "drift-probe-tier-1", tier: "T2", enabled: true }];
    const drifts = diffAssembledSnapshot(regenerated, snapshot);
    expect(drifts).toEqual([
      { kind: "stale-tier", modelId: "drift-probe-tier-1", expectedTier: "T2", actualTier: "T1" },
    ]);
    let message = "";
    try {
      assertSnapshotFresh(drifts);
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("drift-probe-tier-1");
  });

  it("positive control: missing row fails naming the model", () => {
    const drifts = diffAssembledSnapshot([], [
      { id: "drift-probe-missing-1", tier: "T3", enabled: true, laneId: "cliproxy-meta" },
    ]);
    expect(drifts).toEqual([{ kind: "missing", modelId: "drift-probe-missing-1" }]);
    let message = "";
    try {
      assertSnapshotFresh(drifts);
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("drift-probe-missing-1");
  });

  it("positive control: extra regenerated row fails naming the model", () => {
    const drifts = diffAssembledSnapshot(
      [{ id: "drift-probe-extra-1", tier: "T3", enabled: true }],
      [],
    );
    expect(drifts).toEqual([{ kind: "extra", modelId: "drift-probe-extra-1" }]);
    let message = "";
    try {
      assertSnapshotFresh(drifts);
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("drift-probe-extra-1");
  });

  it("positive control: disabled-where-snapshot-enabled fails naming the model", () => {
    const regenerated = [
      { id: "drift-probe-disabled-1", tier: "T2", enabled: false, laneId: "cliproxy-claude" },
    ];
    const snapshot = [
      { id: "drift-probe-disabled-1", tier: "T2", enabled: true, laneId: "cliproxy-claude" },
    ];
    const drifts = diffAssembledSnapshot(regenerated, snapshot);
    expect(drifts).toEqual([{ kind: "disabled", modelId: "drift-probe-disabled-1" }]);
    let message = "";
    try {
      assertSnapshotFresh(drifts);
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("drift-probe-disabled-1");
  });

  it("positive control: drifted lane fails naming the model", () => {
    const regenerated = [
      { id: "drift-probe-lane-1", tier: "T3", enabled: true, laneId: "cliproxy-zen" },
    ];
    const snapshot = [
      { id: "drift-probe-lane-1", tier: "T3", enabled: true, laneId: "cliproxy-meta" },
    ];
    const drifts = diffAssembledSnapshot(regenerated, snapshot);
    expect(drifts).toEqual([
      {
        kind: "drifted-lane",
        modelId: "drift-probe-lane-1",
        expectedLane: "cliproxy-meta",
        actualLane: "cliproxy-zen",
      },
    ]);
    let message = "";
    try {
      assertSnapshotFresh(drifts);
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("drift-probe-lane-1");
  });

  it("refuses malformed input instead of reporting it as fresh", () => {
    const row = { id: "m", tier: "T1", enabled: true };
    const good = [row];
    expect(() => diffAssembledSnapshot([{ tier: "T1" } as never], good)).toThrow(
      "invalid-freshness-row",
    );
    expect(() => diffAssembledSnapshot(good, [row, row])).toThrow(
      "duplicate-freshness-row",
    );
  });
});
