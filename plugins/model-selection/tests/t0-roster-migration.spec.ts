import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  T0_MIGRATION_TARGETS,
  assertOnlyExpectedChanges,
  planT0Migration,
  verifyT0Roster,
} from "../scripts/migrate-t0-roster.mjs";

/**
 *  step 2: the guarded live migration. The fixtures reproduce the
 * SHAPE of the 2026-10-03 sanitized receipt (124 rows, three interim rows, two
 * unnamed `devin/` fallback duplicates, a distinct claude-opus-5-5 row) at a
 * smaller size; no value here is the live config.
 */

const caps = ["tools", "structured-output", "vision", "long-context"];

function liveRow(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    tier: "T1",
    fallbackOnly: true,
    laneId: "cliproxy-claude",
    capabilities: caps,
    contextWindow: 1_000_000,
    aaIndex: 51,
    aaIndexUpdatedAt: "2026-10-01",
    enabled: true,
    costPerMTokIn: 5,
    costPerMTokOut: 25,
    note: "kept verbatim",
    ...extra,
  };
}

function liveConfig() {
  return {
    selection: { enabled: true, mode: "shadow" },
    pacing: { mode: "shadow" },
    models: [
      liveRow("claude-opus-5", { fallbackOnly: false, aaIndex: 54 }),
      liveRow("claude-fable-5-1"),
      liveRow("gpt-6-astra", { laneId: "cliproxy-codex", contextWindow: 1_050_000 }),
      liveRow("gpt-5.6-sol", { fallbackOnly: false, laneId: "cliproxy-codex" }),
      liveRow("devin/claude-fable-5-1", { laneId: "cliproxy-devin", aaIndex: 57 }),
      liveRow("devin/gpt-6-astra", { laneId: "cliproxy-devin", aaIndex: 55 }),
      liveRow("claude-opus-5-5", { aaIndex: 54 }),
    ],
  };
}

function receiptFor(config: ReturnType<typeof liveConfig>) {
  const pick = (id: string) => {
    const ordinal = config.models.findIndex((row) => row.id === id);
    const row = config.models[ordinal]!;
    return {
      ordinalZeroBased: ordinal,
      matchedTargets: [id],
      fields: {
        id: row.id,
        tier: row.tier,
        fallbackOnly: row.fallbackOnly,
        laneId: row.laneId,
        capabilities: row.capabilities,
        contextWindow: row.contextWindow,
        aaIndex: row.aaIndex,
        aaIndexUpdatedAt: row.aaIndexUpdatedAt,
      },
    };
  };
  return {
    schema: "sanitized-roster-receipt-v1",
    totalRosterCount: config.models.length,
    rows: [
      "claude-opus-5",
      "claude-fable-5-1",
      "gpt-6-astra",
      "devin/claude-fable-5-1",
      "devin/gpt-6-astra",
      "claude-opus-5-5",
    ].map(pick),
    opus55Attestation: { distinctRosterRowExists: true, distinctServingIdentity: "unverified" },
  };
}

describe("planT0Migration", () => {
  it("moves exactly the three approved ids to regular T0 and changes nothing else", () => {
    const live = liveConfig();
    const plan = planT0Migration(live, receiptFor(live));

    expect(plan.changes.map((change) => change.id).sort()).toEqual([...T0_MIGRATION_TARGETS].sort());
    for (const id of T0_MIGRATION_TARGETS) {
      const row = plan.config.models.find((model) => model.id === id)!;
      expect(row.tier).toBe("T0");
      expect(row.fallbackOnly).toBe(false);
    }
    // Everything else is byte-identical: lanes, caps, scores, notes, order.
    const strip = (rows: Array<Record<string, unknown>>) =>
      rows.map(({ tier: _tier, fallbackOnly: _fallbackOnly, ...rest }) => rest);
    expect(strip(plan.config.models)).toEqual(strip(live.models));
    expect(plan.config.selection).toEqual(live.selection);
    expect(plan.config.pacing).toEqual(live.pacing);
  });

  it("leaves the unnamed devin/ duplicates, claude-opus-5 and sol exactly as they were", () => {
    const live = liveConfig();
    const plan = planT0Migration(live, receiptFor(live));
    for (const id of ["devin/claude-fable-5-1", "devin/gpt-6-astra", "claude-opus-5", "gpt-5.6-sol"]) {
      expect(plan.config.models.find((row) => row.id === id)).toEqual(live.models.find((row) => row.id === id));
    }
  });

  it("does not mutate its input", () => {
    const live = liveConfig();
    const snapshot = JSON.stringify(live);
    planT0Migration(live, receiptFor(live));
    expect(JSON.stringify(live)).toBe(snapshot);
  });

  it("is idempotent: a second run on the migrated config plans nothing", () => {
    const live = liveConfig();
    const receipt = receiptFor(live);
    const first = planT0Migration(live, receipt);
    const second = planT0Migration(first.config, receipt);
    expect(second.changes).toEqual([]);
    expect([...second.alreadyMigrated].sort()).toEqual([...T0_MIGRATION_TARGETS].sort());
    expect(second.config).toEqual(first.config);
  });

  it("emits a rollback patch that restores the interim encoding exactly", () => {
    const live = liveConfig();
    const plan = planT0Migration(live, receiptFor(live));
    const restored = structuredClone(plan.config);
    for (const patch of plan.rollback) {
      Object.assign(restored.models[patch.ordinal]!, patch.set);
    }
    expect(restored).toEqual(live);
  });

  it("refuses a row that drifted from the receipt (a changed lane)", () => {
    const live = liveConfig();
    const receipt = receiptFor(live);
    live.models.find((row) => row.id === "gpt-6-astra")!.laneId = "cliproxy-elsewhere";
    expect(() => planT0Migration(live, receipt)).toThrow(/gpt-6-astra.*drifted.*laneId/);
  });

  it("refuses a row that drifted from the receipt (a changed capability set)", () => {
    const live = liveConfig();
    const receipt = receiptFor(live);
    live.models.find((row) => row.id === "claude-fable-5-1")!.capabilities = ["tools"];
    expect(() => planT0Migration(live, receipt)).toThrow(/claude-fable-5-1.*capabilities/);
  });

  it("refuses when claude-opus-5-5 is absent from the live roster — it never guesses the identity", () => {
    const live = liveConfig();
    const receipt = receiptFor(live);
    live.models = live.models.filter((row) => row.id !== "claude-opus-5-5");
    expect(() => planT0Migration(live, receipt)).toThrow(/0 rows with exact id claude-opus-5-5/);
  });

  it("refuses a duplicate exact id rather than choosing between rows", () => {
    const live = liveConfig();
    const receipt = receiptFor(live);
    live.models.push(liveRow("gpt-6-astra", { laneId: "cliproxy-codex" }));
    expect(() => planT0Migration(live, receipt)).toThrow(/2 rows with exact id gpt-6-astra/);
  });

  it("refuses a receipt that does not attest a distinct opus-5-5 row", () => {
    const live = liveConfig();
    const receipt = receiptFor(live);
    receipt.opus55Attestation.distinctRosterRowExists = false;
    expect(() => planT0Migration(live, receipt)).toThrow(/distinct claude-opus-5-5/);
  });

  it("refuses a receipt of the wrong schema", () => {
    const live = liveConfig();
    const receipt = { ...receiptFor(live), schema: "something-else" };
    expect(() => planT0Migration(live, receipt)).toThrow(/not a sanitized-roster/);
  });

  it("accepts a namespaced historical schema variant and migrates identically to the canonical one", () => {
    // Pre-scrub receipts namespace the same contract (e.g. "<archive>-sanitized-roster-receipt-v1").
    // The fixture prefix is generic; the mechanism accepts any such variant.
    const live = liveConfig();
    const canonical = receiptFor(live);
    const historical = { ...canonical, schema: "example-archive-sanitized-roster-receipt-v1" };
    const viaCanonical = planT0Migration(structuredClone(live), canonical);
    const viaHistorical = planT0Migration(structuredClone(live), historical);
    expect(viaHistorical.config).toEqual(viaCanonical.config);
    expect(viaHistorical.changes).toEqual(viaCanonical.changes);
    expect(viaHistorical.rollback).toEqual(viaCanonical.rollback);
    expect(verifyT0Roster(viaHistorical.config, historical)).toEqual([]);
  });

  it("refuses a schema suffix with an empty namespace", () => {
    const live = liveConfig();
    const receipt = { ...receiptFor(live), schema: "-sanitized-roster-receipt-v1" };
    expect(() => planT0Migration(live, receipt)).toThrow(/not a sanitized-roster/);
  });

  it("refuses a non-string schema and a non-lowercase namespace", () => {
    const live = liveConfig();
    expect(() => planT0Migration(live, { ...receiptFor(live), schema: 42 })).toThrow(/not a sanitized-roster/);
    expect(() => planT0Migration(live, { ...receiptFor(live), schema: "Legacy_sanitized-roster-receipt-v1" })).toThrow(
      /not a sanitized-roster/,
    );
  });

  it("refuses a target that is neither interim nor migrated (tier T2)", () => {
    const live = liveConfig();
    const receipt = receiptFor(live);
    live.models.find((row) => row.id === "gpt-6-astra")!.tier = "T2";
    receipt.rows.find((row) => row.fields.id === "gpt-6-astra")!.fields.tier = "T2";
    expect(() => planT0Migration(live, receipt)).toThrow(/gpt-6-astra.*not the interim T1/);
  });

  it("refuses a regular T1 target (fallbackOnly false) — that is not the interim encoding", () => {
    const live = liveConfig();
    const receipt = receiptFor(live);
    live.models.find((row) => row.id === "gpt-6-astra")!.fallbackOnly = false;
    receipt.rows.find((row) => row.fields.id === "gpt-6-astra")!.fields.fallbackOnly = false;
    expect(() => planT0Migration(live, receipt)).toThrow(/gpt-6-astra.*not the interim/);
  });

  it("refuses a target with no lane binding — it will not invent one", () => {
    const live = liveConfig();
    const receipt = receiptFor(live);
    delete (live.models.find((row) => row.id === "gpt-6-astra") as Record<string, unknown>).laneId;
    delete (receipt.rows.find((row) => row.fields.id === "gpt-6-astra")!.fields as Record<string, unknown>).laneId;
    expect(() => planT0Migration(live, receipt)).toThrow(/gpt-6-astra: no laneId/);
  });

  it("matches ids exactly: devin/gpt-6-astra alone never satisfies the gpt-6-astra target", () => {
    const live = liveConfig();
    const receipt = receiptFor(live);
    live.models = live.models.filter((row) => row.id !== "gpt-6-astra");
    expect(() => planT0Migration(live, receipt)).toThrow(/0 rows with exact id gpt-6-astra/);
  });
});

describe("assertOnlyExpectedChanges", () => {
  const changes = [{ id: "gpt-6-astra", ordinal: 2 }];

  it("accepts the planned tier/fallbackOnly edit", () => {
    const before = liveConfig();
    const after = structuredClone(before);
    Object.assign(after.models[2]!, { tier: "T0", fallbackOnly: false });
    expect(() => assertOnlyExpectedChanges(before, after, changes)).not.toThrow();
  });

  it("rejects a third field changing on a planned row", () => {
    const before = liveConfig();
    const after = structuredClone(before);
    Object.assign(after.models[2]!, { tier: "T0", fallbackOnly: false, laneId: "other" });
    expect(() => assertOnlyExpectedChanges(before, after, changes)).toThrow(/gpt-6-astra\.laneId/);
  });

  it("rejects any change to an unplanned row", () => {
    const before = liveConfig();
    const after = structuredClone(before);
    Object.assign(after.models[2]!, { tier: "T0", fallbackOnly: false });
    after.models[3]!.tier = "T0";
    expect(() => assertOnlyExpectedChanges(before, after, changes)).toThrow(/unplanned row 3/);
  });

  it("rejects a change outside the roster and a changed roster length", () => {
    const before = liveConfig();
    const alteredKey = structuredClone(before);
    alteredKey.selection.mode = "enforce";
    expect(() => assertOnlyExpectedChanges(before, alteredKey, [])).toThrow(/non-roster key selection/);
    const shorter = structuredClone(before);
    shorter.models.pop();
    expect(() => assertOnlyExpectedChanges(before, shorter, [])).toThrow(/roster length/);
  });
});

describe("verifyT0Roster (the parent's final live three-row check)", () => {
  it("fails on the interim roster and names every row", () => {
    const live = liveConfig();
    const problems = verifyT0Roster(live, receiptFor(live));
    expect(problems.filter((line) => line.includes("expected T0"))).toHaveLength(3);
    expect(problems.filter((line) => line.includes("expected false"))).toHaveLength(3);
  });

  it("passes on the migrated roster", () => {
    const live = liveConfig();
    const receipt = receiptFor(live);
    const { config } = planT0Migration(live, receipt);
    expect(verifyT0Roster(config, receipt)).toEqual([]);
  });

  it("fails when an unnamed devin/ duplicate was moved too", () => {
    const live = liveConfig();
    const receipt = receiptFor(live);
    const { config } = planT0Migration(live, receipt);
    Object.assign(config.models.find((row) => row.id === "devin/gpt-6-astra")!, { tier: "T0", fallbackOnly: false });
    expect(verifyT0Roster(config, receipt).join("\n")).toMatch(/devin\/gpt-6-astra: unplanned change to tier/);
  });

  it("fails when a migrated row lost its lane binding", () => {
    const live = liveConfig();
    const receipt = receiptFor(live);
    const { config } = planT0Migration(live, receipt);
    config.models.find((row) => row.id === "claude-opus-5-5")!.laneId = null as never;
    expect(verifyT0Roster(config, receipt).join("\n")).toMatch(/claude-opus-5-5.*laneId/);
  });
});

describe("migrate-t0-roster CLI", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  function workspace() {
    const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? process.cwd();
    const dir = mkdtempSync(join(root, "t0-migrate-test-"));
    directories.push(dir);
    const live = liveConfig();
    const receipt = receiptFor(live);
    const livePath = join(dir, "live.json");
    const receiptPath = join(dir, "receipt.json");
    writeFileSync(livePath, JSON.stringify(live));
    writeFileSync(receiptPath, JSON.stringify(receipt));
    return { dir, livePath, receiptPath, receiptSha: createHash("sha256").update(readFileSync(receiptPath)).digest("hex") };
  }

  function run(args: string[]) {
    return spawnSync(process.execPath, [new URL("../scripts/migrate-t0-roster.mjs", import.meta.url).pathname, ...args], {
      encoding: "utf8",
      timeout: 10_000,
    });
  }

  it("writes the migrated config and the rollback patch, then --verify accepts the artifact", () => {
    const { dir, livePath, receiptPath, receiptSha } = workspace();
    const out = join(dir, "migrated.json");
    const rollback = join(dir, "rollback.json");
    const result = run(["--live", livePath, "--receipt", receiptPath, "--receipt-sha256", receiptSha, "--out", out, "--rollback", rollback]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("planned 3 change(s)");
    expect(JSON.parse(readFileSync(rollback, "utf8"))).toHaveLength(3);

    const verified = run(["--verify", "--live", out, "--receipt", receiptPath]);
    expect(verified.status, verified.stderr).toBe(0);
    expect(verified.stdout).toContain("T0 roster verified");
  });

  it("--verify exits 1 on the unmigrated roster", () => {
    const { livePath, receiptPath } = workspace();
    const result = run(["--verify", "--live", livePath, "--receipt", receiptPath]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("NOT verified");
  });

  it("refuses to overwrite the live config", () => {
    const { livePath, receiptPath } = workspace();
    const before = readFileSync(livePath, "utf8");
    const result = run(["--live", livePath, "--receipt", receiptPath, "--out", livePath]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must not overwrite --live");
    expect(readFileSync(livePath, "utf8")).toBe(before);
  });

  it("refuses a receipt whose sha256 does not match the pinned one, and writes nothing", () => {
    const { dir, livePath, receiptPath } = workspace();
    const out = join(dir, "migrated.json");
    const result = run(["--live", livePath, "--receipt", receiptPath, "--receipt-sha256", "0".repeat(16), "--out", out]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not match");
    expect(() => readFileSync(out)).toThrow();
  });

  it("refuses a too-short sha256 prefix", () => {
    const { dir, livePath, receiptPath, receiptSha } = workspace();
    const result = run(["--live", livePath, "--receipt", receiptPath, "--receipt-sha256", receiptSha.slice(0, 6), "--out", join(dir, "o.json")]);
    expect(result.status).toBe(1);
  });

  it("writes no artifact when a guard fails", () => {
    const { dir, livePath, receiptPath } = workspace();
    const live = JSON.parse(readFileSync(livePath, "utf8"));
    live.models = live.models.filter((row: { id: string }) => row.id !== "claude-opus-5-5");
    writeFileSync(livePath, JSON.stringify(live));
    const out = join(dir, "migrated.json");
    const result = run(["--live", livePath, "--receipt", receiptPath, "--out", out]);
    expect(result.status).toBe(1);
    expect(() => readFileSync(out)).toThrow();
  });
});
