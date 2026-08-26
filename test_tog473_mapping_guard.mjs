#!/usr/bin/env node
/**
 * Offline mutation suite for scripts/tog473-mapping-guard-calibration.mjs.
 *
 * Each case stages the committed catalogue and mapping plan, changes exactly one
 * input, and requires the checker to distinguish a guard failure (1) from a
 * harness failure (2). No credential, network or management endpoint is used.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(REPO, "scripts", "tog473-mapping-guard-calibration.mjs");
const FIXTURES = join(REPO, "tests", "fixtures", "tog178");
const BROKER = join(REPO, "plugins", "omniroute-broker");
const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stage() {
  const dir = mkdtempSync(join(tmpdir(), "tog473-"));
  dirs.push(dir);
  copyFileSync(join(FIXTURES, "catalogue.json"), join(dir, "catalogue.json"));
  copyFileSync(
    join(FIXTURES, "TOG-178-mapping-plan.json"),
    join(dir, "TOG-178-mapping-plan.json"),
  );
  return dir;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value));
}

function models(catalogue) {
  return Array.isArray(catalogue) ? catalogue : (catalogue.data ?? []);
}

function mappings(plan) {
  return Array.isArray(plan) ? plan : (plan.mappings ?? plan.plan ?? []);
}

function run(dir) {
  const result = spawnSync("node", [SCRIPT], {
    cwd: REPO,
    encoding: "utf8",
    env: {
      ...process.env,
      TOG473_CATALOGUE_FIXTURE: join(dir, "catalogue.json"),
      TOG473_BROKER_DIR: BROKER,
      TOG178_DIR: dir,
      OMNIROUTE_API_KEY: "",
    },
  });
  return {
    code: result.status ?? -1,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

test("the committed corpus passes as an explicitly non-live check", () => {
  const result = run(stage());
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /NOT A LIVE CHECK/);
  assert.match(result.out, /all 350 Claude-bearing ids are blocked/);
  assert.match(result.out, /all 52 planned TOG-178 mappings pass/);
  assert.match(result.out, /52 of 52 mapping creates classify as TWO-KEY/);
});

test("an Anthropic-served id with no protected family token is a bypass", () => {
  const dir = stage();
  const path = join(dir, "catalogue.json");
  const catalogue = readJson(path);
  models(catalogue).push({ id: "aug/atlas-v3-preview", owned_by: "anthropic" });
  writeJson(path, catalogue);
  const result = run(dir);
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /NOT blocked by the family regex/);
  assert.match(result.out, /aug\/atlas-v3-preview/);
});

test("a catalogue id containing a wildcard is refused", () => {
  const dir = stage();
  const path = join(dir, "catalogue.json");
  const catalogue = readJson(path);
  models(catalogue).push({ id: "vendor/weird?name", owned_by: "vendor" });
  writeJson(path, catalogue);
  const result = run(dir);
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /unaddressable under the ban/);
});

test("a planned wildcard mapping is refused rather than accommodated", () => {
  const dir = stage();
  const path = join(dir, "TOG-178-mapping-plan.json");
  const plan = readJson(path);
  mappings(plan)[0].pattern += "*";
  writeJson(path, plan);
  const result = run(dir);
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /REFUSED by the guard/);
  assert.match(result.out, /Widening the guard to fit a plan defeats its purpose/);
});

test("a planned mapping without explicit priority is refused", () => {
  const dir = stage();
  const path = join(dir, "TOG-178-mapping-plan.json");
  const plan = readJson(path);
  delete mappings(plan)[0].priority;
  writeJson(path, plan);
  const result = run(dir);
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /REFUSED by the guard/);
});

test("a planned Claude-family mapping is refused", () => {
  const dir = stage();
  const path = join(dir, "TOG-178-mapping-plan.json");
  const plan = readJson(path);
  mappings(plan)[0].pattern = "claude-sonnet-4-5";
  writeJson(path, plan);
  const result = run(dir);
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /REFUSED by the guard/);
});

test("malformed and empty catalogues are harness failures, never verdicts", () => {
  const malformed = stage();
  writeFileSync(join(malformed, "catalogue.json"), "{not json");
  let result = run(malformed);
  assert.equal(result.code, 2, result.out);
  assert.match(result.out, /This is not a pass/);

  const empty = stage();
  writeJson(join(empty, "catalogue.json"), []);
  result = run(empty);
  assert.equal(result.code, 2, result.out);
  assert.match(result.out, /contained no models/);
});
