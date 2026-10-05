#!/usr/bin/env node
// Real-harness smoke test for the Muse Stop guard. Run it by hand before an install and after a
// Claude Code upgrade:  node hooks/muse-stop-guard/smoke/run-smoke.mjs
//
// It runs the real `claude` CLI against a local stub of the Messages API (stub-anthropic.mjs) with
// the hook configured through --settings, in a throwaway HOME. Nothing leaves loopback, no
// credential is used, and nothing under the real ~/.claude is read or written.
//
// What it proves that the unit tests cannot: that this Claude Code version really passes
// last_assistant_message and stop_hook_active to a Stop hook, really honours
// {"decision":"block"}, really feeds the reason back to the model, and really stops once the
// guard's own cap is reached.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "..", "muse-stop-guard.mjs");
const STUB = join(HERE, "stub-anthropic.mjs");

function startStub(env) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [STUB], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const match = /PORT (\d+)/.exec(out);
      if (match) resolve({ child, port: Number(match[1]) });
    });
    child.on("error", reject);
    setTimeout(() => reject(new Error("stub did not start")), 5000).unref();
  });
}

async function runScenario({ name, scenario, model, expect }) {
  const dir = mkdtempSync(join(tmpdir(), "muse-stop-smoke-"));
  const stubLog = join(dir, "stub.jsonl");
  const guardLog = join(dir, "decisions.jsonl");
  const home = join(dir, "home");
  const cwd = join(dir, "cwd");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const settings = join(dir, "settings.json");
  writeFileSync(settings, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `node ${HOOK}`, timeout: 15 }] }] } }));
  const { child, port } = await startStub({ STUB_SCENARIO: scenario, STUB_MODEL: model, STUB_LOG: stubLog });
  try {
    const run = spawnSync(
      "claude",
      ["-p", "Run the focused tests.", "--settings", settings, "--output-format", "json"],
      {
        cwd,
        encoding: "utf8",
        timeout: 120000,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          CLAUDE_CONFIG_DIR: join(home, ".claude"),
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
          ANTHROPIC_API_KEY: "stub-key-not-a-credential",
          DISABLE_TELEMETRY: "1",
          DISABLE_AUTOUPDATER: "1",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          PAPERCLIP_RUN_ID: `smoke-${name}`,
          MUSE_STOP_GUARD_STATE_DIR: join(dir, "state"),
          MUSE_STOP_GUARD_LOG: guardLog,
          MUSE_STOP_GUARD_UNSAVED: "off",
        },
      },
    );
    const stubLines = existsSync(stubLog) ? readFileSync(stubLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    const mainCalls = stubLines.filter((l) => l.main);
    const guardLines = existsSync(guardLog) ? readFileSync(guardLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    const result = { name, exit: run.status, mainCalls: mainCalls.length, guard: guardLines.map((l) => `${l.action}:${l.why}`), secondRequestLastUser: mainCalls[1]?.lastUser ?? null };
    try {
      expect({ run, mainCalls, guardLines, stubLines });
      return { ...result, ok: true };
    } catch (error) {
      return { ...result, ok: false, error: error.message, stderr: String(run.stderr).slice(0, 600), stdout: String(run.stdout).slice(0, 600) };
    }
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

const scenarios = [
  {
    name: "muse-announce-then-final",
    scenario: "announce-then-final",
    model: "muse-spark-1.3-contributor",
    expect: ({ run, mainCalls, guardLines }) => {
      assert.equal(run.status, 0);
      assert.equal(mainCalls.length, 2, "one nudge costs exactly one extra model call");
      assert.match(mainCalls[1].lastUser, /statement of intent/, "the hook's reason reached the model");
      assert.deepEqual(guardLines.map((l) => l.action), ["block", "allow"]);
      assert.equal(guardLines[0].stopHookActive, false);
      assert.equal(guardLines[1].stopHookActive, true, "Claude Code reports the continuation as stop_hook_active");
    },
  },
  {
    name: "muse-announce-forever",
    scenario: "announce-forever",
    model: "muse-spark-1.3-contributor",
    expect: ({ run, mainCalls, guardLines }) => {
      assert.equal(run.status, 0, "the run still ends");
      assert.equal(mainCalls.length, 3, "initial call plus exactly two nudges");
      assert.deepEqual(guardLines.map((l) => `${l.action}:${l.why}`), [
        "block:ends with a colon",
        "block:ends with a colon",
        "allow:nudge-cap-reached",
      ]);
    },
  },
  {
    name: "muse-genuine-final",
    scenario: "genuine",
    model: "muse-spark-1.3-contributor",
    expect: ({ run, mainCalls, guardLines }) => {
      assert.equal(run.status, 0);
      assert.equal(mainCalls.length, 1, "a genuine final is never handed back");
      assert.deepEqual(guardLines.map((l) => l.action), ["allow"]);
    },
  },
  {
    name: "non-muse-announce-is-untouched",
    scenario: "announce-forever",
    model: "claude-sonnet-5-5",
    expect: ({ run, mainCalls, guardLines }) => {
      assert.equal(run.status, 0);
      assert.equal(mainCalls.length, 1, "the hook does nothing for any other model");
      assert.equal(guardLines.length, 0, "and does not even log");
    },
  },
];

const results = [];
for (const scenario of scenarios) results.push(await runScenario(scenario));
for (const r of results) process.stdout.write(`${r.ok ? "PASS" : "FAIL"} ${r.name} ${JSON.stringify({ exit: r.exit, mainCalls: r.mainCalls, guard: r.guard })}\n`);
for (const r of results.filter((x) => !x.ok)) process.stderr.write(`\n${r.name}: ${r.error}\nstdout: ${r.stdout}\nstderr: ${r.stderr}\n`);
const second = results.find((r) => r.secondRequestLastUser);
if (second) process.stdout.write(`\nwhat the model saw after the block:\n${second.secondRequestLastUser}\n`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
