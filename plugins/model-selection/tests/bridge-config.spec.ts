import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assembleBridgeConfig, validateBridgeConfig } from "../scripts/assemble-additive-config.mjs";
import { bridgeLiveShape, missingZen, reviewedRoster } from "./fixtures/bridge-live-shape.js";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

function runCli(live: any, bridgeOnly: boolean) {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? process.cwd();
  const dir = mkdtempSync(join(root, "bridge-config-test-"));
  directories.push(dir);
  const rosterPath = join(dir, "roster.json");
  const livePath = join(dir, "before.json");
  const output = join(dir, "artifact.json");
  const counts = join(dir, "counts.json");
  writeFileSync(rosterPath, JSON.stringify(reviewedRoster));
  writeFileSync(livePath, JSON.stringify(live));
  const result = spawnSync(process.execPath, [
    new URL("../scripts/assemble-additive-config.mjs", import.meta.url).pathname,
    "--roster", rosterPath, "--live", livePath, "--out", output, "--counts", counts,
    ...(bridgeOnly ? ["--bridge-only"] : []),
  ], { encoding: "utf8", timeout: 10000 });
  return { result, output, counts };
}

describe("bridge-only packet v3", () => {
  it("assembles 124→126 end-to-end while keeping all existing rows, selection and pacing verbatim", () => {
    const live = bridgeLiveShape();
    const { result, output, counts } = runCli(live, true);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const artifact = JSON.parse(readFileSync(output, "utf8"));
    expect(artifact.models.slice(0, 124)).toEqual(live.models);
    expect({ ...artifact, models: [] }).toEqual({ ...live, models: [] });
    expect(artifact.models.slice(124).map((row: any) => [row.id, row.tier, row.enabled, row.laneId])).toEqual([
      ["muse-spark-1.3-contributor", "T3", true, "cliproxy-meta"],
      ["claude-sonnet-5-5", "T2", true, "cliproxy-claude"],
    ]);
    expect(artifact.models.some((row: any) => missingZen.includes(row.id))).toBe(false);
    expect(JSON.parse(readFileSync(counts, "utf8"))).toMatchObject({
      liveBefore: { models: 124, enabled: 16, withLaneId: 106 },
      artifactAfter: { models: 126, enabled: 18, withLaneId: 108 },
      enabledWithoutLane: [], preservedLaneBindings: 106, inferredLaneBindings: 2,
    });
  });

  it.each(["missing-meta", "unlaned-live", "undeclared-live", "disabled-sol"])("refuses %s without writing either output", (reason) => {
    const live = bridgeLiveShape();
    if (reason === "missing-meta") live.pacing.lanes = live.pacing.lanes.filter((lane: any) => lane.laneId !== "cliproxy-meta");
    if (reason === "unlaned-live") delete live.models.find((row: any) => row.enabled && row.id !== "gpt-6.1-sol").laneId;
    if (reason === "undeclared-live") live.models.find((row: any) => row.enabled && row.id !== "gpt-6.1-sol").laneId = "cliproxy-not-configured";
    if (reason === "disabled-sol") live.models.find((row: any) => row.id === "gpt-6.1-sol").enabled = false;
    const { result, output, counts } = runCli(live, true);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(existsSync(output)).toBe(false);
    expect(existsSync(counts)).toBe(false);
  });

  it("does not rewrite legacy live ids, disabled rows, or fields from the roster", () => {
    const live = bridgeLiveShape();
    const disabled = live.models.find((row: any) => !row.enabled && reviewedRoster.models.some((r: any) => r.id === row.id && r.enabled));
    expect(disabled).toBeDefined();
    disabled.id = `cliproxy/${disabled.id}`;
    disabled.liveOnlyField = "preserve";
    const snapshot = JSON.stringify(live);
    const { config } = assembleBridgeConfig(reviewedRoster, live);
    expect(config.models.slice(0, 124)).toEqual(live.models);
    expect(JSON.stringify(live)).toBe(snapshot);
    expect(config.selection.mode).toBe("advise");
  });

  it("stops on a changed missing-row set instead of broadening or replaying the +2 packet", () => {
    const live = bridgeLiveShape();
    const { config } = assembleBridgeConfig(reviewedRoster, live);
    expect(() => assembleBridgeConfig(reviewedRoster, config)).toThrow("duplicate canonical");
    const roster = structuredClone(reviewedRoster);
    roster.models.find((row: any) => row.id === "claude-sonnet-5-5" && row.tier === "T2").enabled = false;
    expect(() => assembleBridgeConfig(roster, live)).toThrow("lacks enabled bridge row");
  });

  it.each(["cost-in", "cost-out", "capabilities", "fallback-only"])("preflight pins addition %s to the reviewed roster", (field) => {
    const live = bridgeLiveShape();
    const artifact = structuredClone(assembleBridgeConfig(reviewedRoster, live).config);
    if (field === "cost-in") artifact.models[124]!.costPerMTokIn = 999;
    if (field === "cost-out") artifact.models[125]!.costPerMTokOut = 999;
    if (field === "capabilities") artifact.models[124]!.capabilities = ["tools"];
    if (field === "fallback-only") artifact.models[125]!.fallbackOnly = true;
    expect(() => validateBridgeConfig(live, artifact)).toThrow();
  });

  it("assembly fails closed when the roster drifts off the pinned cost/capability/fallbackOnly", () => {
    const live = bridgeLiveShape();
    const roster = structuredClone(reviewedRoster);
    roster.models.find((row: any) => row.id === "claude-sonnet-5-5" && row.tier === "T2").costPerMTokIn = 999;
    expect(() => assembleBridgeConfig(roster, live)).toThrow("costPerMTokIn");
    const roster2 = structuredClone(reviewedRoster);
    roster2.models.find((row: any) => row.id === "muse-spark-1.3-contributor").fallbackOnly = true;
    expect(() => assembleBridgeConfig(roster2, live)).toThrow("fallbackOnly");
  });

  it.each(["swap-live-order", "additions-first", "swap-additions"])("preflight enforces live-row order and addition position (%s)", (field) => {
    const live = bridgeLiveShape();
    const artifact = structuredClone(assembleBridgeConfig(reviewedRoster, live).config);
    if (field === "swap-live-order") {
      const first = artifact.models[0]!;
      const rest = artifact.models.slice(1);
      artifact.models = [...rest.slice(0, 10), first, ...rest.slice(10)];
    }
    if (field === "additions-first") {
      artifact.models = [...artifact.models.slice(124), ...artifact.models.slice(0, 124)];
    }
    if (field === "swap-additions") {
      const tail = artifact.models.slice(124).reverse();
      artifact.models = [...artifact.models.slice(0, 124), ...tail];
    }
    expect(() => validateBridgeConfig(live, artifact)).toThrow();
  });

  it.each(["live-only-section", "shadow-emit", "new-top-level-key"])("preflight pins top-level-key drift beyond selection+pacing (%s)", (field) => {
    const live = bridgeLiveShape();
    const artifact = structuredClone(assembleBridgeConfig(reviewedRoster, live).config);
    if (field === "live-only-section") artifact.liveOnlySection.keep = ["changed"];
    if (field === "shadow-emit") artifact.shadowEmit.enabled = false;
    if (field === "new-top-level-key") artifact.brandNewSection = { invented: true };
    expect(() => validateBridgeConfig(live, artifact)).toThrow();
  });

  it("rejects duplicate CLI flags instead of first-wins", () => {
    const live = bridgeLiveShape();
    const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? process.cwd();
    const dir = mkdtempSync(join(root, "bridge-config-test-"));
    directories.push(dir);
    const rosterPath = join(dir, "roster.json");
    const livePath = join(dir, "before.json");
    const output = join(dir, "artifact.json");
    const counts = join(dir, "counts.json");
    writeFileSync(rosterPath, JSON.stringify(reviewedRoster));
    writeFileSync(livePath, JSON.stringify(live));
    const script = new URL("../scripts/assemble-additive-config.mjs", import.meta.url).pathname;
    const dup = spawnSync(process.execPath, [
      script, "--roster", rosterPath, "--live", livePath, "--live", livePath,
      "--out", output, "--counts", counts, "--bridge-only",
    ], { encoding: "utf8", timeout: 10000 });
    expect(dup.status).toBe(1);
    expect(dup.stderr).toContain("duplicate --live");
    expect(existsSync(output)).toBe(false);
    expect(existsSync(counts)).toBe(false);
    const { result, output: goodOutput } = runCli(live, true);
    expect(result.status).toBe(0);
    const verifyScript = new URL("../scripts/verify-bridge-config.mjs", import.meta.url).pathname;
    const verifyDup = spawnSync(process.execPath, [
      verifyScript, "--live", livePath, "--live", livePath, "--artifact", goodOutput,
    ], { encoding: "utf8", timeout: 10000 });
    expect(verifyDup.status).toBe(1);
    expect(verifyDup.stderr).toContain("duplicate --live");
  });

  it.each(["selection", "pacing", "row-enabled", "row-lane", "extra-row", "addition-lane"])("preflight independently catches %s drift", (field) => {
    const live = bridgeLiveShape();
    const artifact = structuredClone(assembleBridgeConfig(reviewedRoster, live).config);
    if (field === "selection") artifact.selection.mode = "enforce";
    if (field === "pacing") artifact.pacing.lanes[0].apiKeySecretRef.secretId = "changed-reference";
    if (field === "row-enabled") artifact.models[0]!.enabled = !artifact.models[0]!.enabled;
    if (field === "row-lane") artifact.models[0]!.laneId = "cliproxy-codex";
    if (field === "extra-row") artifact.models.push({ id: "extra", tier: "T3", enabled: false });
    if (field === "addition-lane") artifact.models[124]!.laneId = "cliproxy-opencode-go";
    expect(() => validateBridgeConfig(live, artifact)).toThrow();
  });

  it("runs independent preflight and AFTER readback, refusing artifact/readback mismatch", () => {
    const live = bridgeLiveShape();
    const { result, output } = runCli(live, true);
    expect(result.status).toBe(0);
    const dir = directories[directories.length - 1]!;
    const before = join(dir, "before.json");
    const after = join(dir, "after.json");
    const script = new URL("../scripts/verify-bridge-config.mjs", import.meta.url).pathname;
    const args = [script, "--live", before, "--artifact", output];
    const preflight = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 10000 });
    expect(preflight.status, preflight.stderr).toBe(0);
    expect(JSON.parse(preflight.stdout)).toMatchObject({ phase: "preflight", liveModels: 124, artifactModels: 126, selectionPreserved: true });
    const artifact = JSON.parse(readFileSync(output, "utf8"));
    writeFileSync(after, JSON.stringify(artifact));
    const readback = () => spawnSync(process.execPath, [...args, "--readback", after], { encoding: "utf8", timeout: 10000 });
    expect(JSON.parse(readback().stdout)).toMatchObject({ phase: "readback", liveEnabled: 16, artifactEnabled: 18 });
    artifact.models[124]!.costPerMTokIn = 123;
    writeFileSync(after, JSON.stringify(artifact));
    const drift = readback();
    expect(drift.status).toBe(1);
    expect(drift.stdout).toBe("");
    // (a): the pinned cost guard now fails closed before the
    // readback deep-equality check; either refusal proves the drift is caught.
    expect(drift.stderr).toMatch(/readback differs|changed costPerMTokIn/);
    artifact.selection.mode = "enforce";
    writeFileSync(after, JSON.stringify(artifact));
    expect(readback().status).toBe(1);
  });

  it("positive control: the unchanged full-roster CLI refuses the exact six Zen rows before output", () => {
    const live = bridgeLiveShape();
    expect(live.models).toHaveLength(124);
    expect(live.models.filter((row: any) => row.enabled)).toHaveLength(16);
    expect(live.models.filter((row: any) => row.laneId)).toHaveLength(106);
    const { result, output, counts } = runCli(live, false);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`enabled models outside pacing lanes: ${missingZen.map((id) => `${id}:T3`).join(", ")}`);
    expect(existsSync(output)).toBe(false);
    expect(existsSync(counts)).toBe(false);
  });
});
