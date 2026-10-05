#!/usr/bin/env node
/**
 * Offline mutation suite for scripts/mapping-guard-calibration.mjs.
 *
 * Each case stages the committed catalogue and mapping plan, changes exactly one
 * input, and requires the checker to distinguish a guard failure (1) from a
 * harness failure (2). No credential, network or management endpoint is used.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  cpSync,
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
const SCRIPT = join(REPO, "scripts", "mapping-guard-calibration.mjs");
const FIXTURES = join(REPO, "tests", "fixtures", "combo-mapping");
const BROKER = join(REPO, "plugins", "omniroute-broker");
const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stage() {
  const dir = mkdtempSync(join(tmpdir(), "mapping-guard-"));
  dirs.push(dir);
  copyFileSync(join(FIXTURES, "catalogue.json"), join(dir, "catalogue.json"));
  copyFileSync(
    join(FIXTURES, "mapping-plan.json"),
    join(dir, "mapping-plan.json"),
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

function run(dir, overrides = {}) {
  const result = spawnSync("node", [SCRIPT], {
    cwd: REPO,
    encoding: "utf8",
    env: {
      ...process.env,
      MAPPING_GUARD_CATALOGUE_FIXTURE: join(dir, "catalogue.json"),
      MAPPING_GUARD_BROKER_DIR: BROKER,
      COMBO_MAP_DIR: dir,
      OMNIROUTE_API_KEY: "",
      ...overrides,
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
  assert.match(result.out, /all 352 Claude-bearing ids are blocked/);
  assert.match(result.out, /all 52 planned combo mappings pass/);
  assert.match(result.out, /52 of 52 mapping creates classify as TWO-KEY/);
});

// The circular-oracle case. THE POINT OF THE WHOLE SUITE, so it is asserted rather than assumed.
//
// Every other case here changes the CATALOGUE and asks whether the checker notices.
// This one changes the GUARD and asks the same question, which is the only version
// that can detect a circular oracle — and the oracle WAS circular until this commit.
//
// Measured on 63ac24ef, before the fixture carried `name`: deleting `prism` from
// MAPPING_PROTECTED_FAMILY left the calibration script reporting
// "all 350 Claude-bearing ids are blocked (0 escaped)" and exiting 0, while
// `mappings.create` would then have accepted `aug/prism-a` — "Prism (Claude + Gemini)",
// live Claude capacity. The script's own wide net counts a family-name match AS
// Claude-bearing, so with bare {id} records the guard was scoring its own exam: remove
// a token and the ids it used to match simply stop being counted.
//
// The fixture's `aug/prism-a` entry — specifically its catalogue `name`, "Prism (Claude +
// Gemini)" — is what breaks the loop, and it is the ONLY thing that does. Strip that one
// field and this test goes green again while the bypass is real, which is exactly the
// pre-fix state. Do not delete this test to make a guard change pass; a guard that
// fails here is a guard with a live bypass.
test("deleting a token from the guard is caught — the fixture is not scored by the guard", () => {
  const dir = stage();
  const brokerDir = join(dir, "broker");
  cpSync(BROKER, brokerDir, { recursive: true });
  const verbsPath = join(brokerDir, "dist", "verbs.js");
  const before = readFileSync(verbsPath, "utf8");
  const after = before.replace("|mythos|prism)/i", "|mythos)/i");
  assert.notEqual(after, before, "could not find MAPPING_PROTECTED_FAMILY to mutate");
  writeFileSync(verbsPath, after);

  const result = run(dir, { MAPPING_GUARD_BROKER_DIR: brokerDir });
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /NOT blocked by the family regex/);
  assert.match(result.out, /aug\/prism-a/);
});

// The test above is only as good as the one field it rests on, so pin that field directly.
// Without this, someone "tidying" the fixture into uniform {id} records would silently
// restore the circular oracle and every test here would still pass.
test("the committed fixture still carries the evidence the guard cannot manufacture", () => {
  const catalogue = readJson(join(FIXTURES, "catalogue.json"));
  const prismA = models(catalogue).find((m) => m.id === "aug/prism-a");
  assert.ok(prismA, "aug/prism-a is missing from the fixture");
  assert.match(
    prismA.name ?? "",
    /claude/i,
    "aug/prism-a lost its catalogue name — the calibration oracle is circular again",
  );
  // The mirror case: matched by the family regex, genuinely NOT Claude. It is why the
  // answer to prism-a is real catalogue data, not another token bolted onto the regex.
  const prismB = models(catalogue).find((m) => m.id === "aug/prism-b");
  assert.ok(prismB, "aug/prism-b is missing from the fixture");
  assert.doesNotMatch(prismB.name ?? "", /claude/i);
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
  const path = join(dir, "mapping-plan.json");
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
  const path = join(dir, "mapping-plan.json");
  const plan = readJson(path);
  delete mappings(plan)[0].priority;
  writeJson(path, plan);
  const result = run(dir);
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /REFUSED by the guard/);
});

test("a planned Claude-family mapping is refused", () => {
  const dir = stage();
  const path = join(dir, "mapping-plan.json");
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
