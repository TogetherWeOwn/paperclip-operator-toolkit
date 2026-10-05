// node --test hooks/muse-stop-guard/muse-stop-guard.test.mjs
//
// Pins exit status, JSON shape and decisions. It does not pin the wording of the reason text.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  MAX_NUDGES_DEFAULT,
  classifyLastTurn,
  decide,
  findUnsavedWork,
  isMuseModel,
  lastClause,
  lastSentence,
  loadConfig,
  readTranscriptFacts,
} from "./muse-stop-guard.mjs";
import {
  ACK_FLAG,
  agentContextRefusal,
  checkApply,
  isAgentOwnedPath,
  isAgentRunContext,
  isInstalled,
  isUserScope,
  mergeInstall,
  removeInstall,
} from "./install-muse-stop-guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "muse-stop-guard.mjs");
const INSTALLER = join(HERE, "install-muse-stop-guard.mjs");
const fixtures = JSON.parse(readFileSync(join(HERE, "fixtures", "final-turns.json"), "utf8"));

const scratch = () => mkdtempSync(join(tmpdir(), "muse-stop-guard-test-"));
const museLine = (text, extra = {}) =>
  JSON.stringify({
    type: "assistant",
    isSidechain: false,
    message: { role: "assistant", model: "muse-spark-1.3-contributor", stop_reason: "end_turn", content: [{ type: "text", text }] },
    ...extra,
  });

/** An env that cannot reach the shared decision log or the real run state. */
function isolatedEnv(dir, extra = {}) {
  return {
    PAPERCLIP_RUN_ID: "run-under-test",
    MUSE_STOP_GUARD_STATE_DIR: join(dir, "state"),
    MUSE_STOP_GUARD_LOG: join(dir, "decisions.jsonl"),
    MUSE_STOP_GUARD_UNSAVED: "off",
    ...extra,
  };
}

function transcriptFor(dir, model, text) {
  const path = join(dir, "t.jsonl");
  const message = { role: "assistant", model, stop_reason: "end_turn", content: [{ type: "text", text }] };
  writeFileSync(path, `${JSON.stringify({ type: "assistant", isSidechain: false, message })}\n`);
  return path;
}

test("only muse models are in scope", () => {
  for (const model of ["muse-spark-1.3-contributor", "muse-spark-1.1", "Muse-Spark-2"]) assert.equal(isMuseModel(model), true, model);
  for (const model of ["claude-sonnet-5-5", "claude-opus-5-5", "gpt-5.6-sol", "", null, undefined, "amuse-1"]) {
    assert.equal(isMuseModel(model), false, String(model));
  }
});

test("every hand-labelled announce-and-stop ending is handed back", () => {
  for (const text of fixtures.announce) assert.notEqual(classifyLastTurn(text).kind, "final", text);
});

test("no hand-labelled genuine final report is handed back", () => {
  for (const text of fixtures.genuine) assert.equal(classifyLastTurn(text).kind, "final", text);
});

test("empty text is its own kind, and a long report is never an announcement", () => {
  assert.equal(classifyLastTurn("").kind, "empty");
  assert.equal(classifyLastTurn("   \n").kind, "empty");
  const report = `${"The review is complete and recorded. ".repeat(30)}Now closing out.`;
  assert.equal(classifyLastTurn(report).kind, "final");
});

test("`next` and `then` alone describe a monitor, so they must not flag a finished card", () => {
  // A positive control: the same words with a first-person intent DO flag, so this is not vacuous.
  assert.equal(classifyLastTurn("Next wake: re-check CI at 09:05Z, then APPROVE and squash-merge.").kind, "final");
  assert.notEqual(classifyLastTurn("Disposition recorded. I'll push the branch next.").kind, "final");
});

test("sentence helpers ignore code fences and split on dashes", () => {
  assert.equal(lastSentence("Done.\n\n```\nnow running\n```"), "Done.");
  assert.equal(lastClause("Format is clean — running the gates now."), "running the gates now.");
});

test("a non-muse model is a no-op: no counter, no log, no block", () => {
  const dir = scratch();
  try {
    const env = isolatedEnv(dir);
    const input = {
      hook_event_name: "Stop",
      session_id: "s",
      transcript_path: transcriptFor(dir, "claude-sonnet-5-5", "Running the tests now:"),
      last_assistant_message: "Running the tests now:",
    };
    assert.equal(decide(input, env).action, "allow");
    const run = spawnSync("node", [HOOK], { input: JSON.stringify(input), env: { ...process.env, ...env }, encoding: "utf8" });
    assert.equal(run.status, 0);
    assert.equal(run.stdout, "");
    assert.equal(existsSync(join(dir, "state")), false);
    assert.equal(existsSync(join(dir, "decisions.jsonl")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the transcript decides the model; a sidechain record cannot make a run look like muse", () => {
  const dir = scratch();
  try {
    const path = join(dir, "t.jsonl");
    const sonnet = { role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: "ok" }] };
    writeFileSync(
      path,
      [JSON.stringify({ type: "assistant", message: sonnet }), museLine("sub-agent text", { isSidechain: true })].join("\n") + "\n",
    );
    assert.equal(readTranscriptFacts(path).model, "claude-sonnet-5-5");
    // With no assistant record yet, the assigned-model env is the only signal.
    const empty = join(dir, "empty.jsonl");
    writeFileSync(empty, "");
    const env = isolatedEnv(dir, { PAPERCLIP_ASSIGNED_MODEL: "muse-spark-1.3-contributor" });
    const verdict = decide({ hook_event_name: "Stop", transcript_path: empty, last_assistant_message: "Running it now:" }, env);
    assert.equal(verdict.action, "block");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a transcript that lags the Stop event is waited for, briefly, when nothing else names the model", () => {
  const dir = scratch();
  try {
    const env = isolatedEnv(dir);
    const input = { hook_event_name: "Stop", transcript_path: "/unused", last_assistant_message: "Now running the suite:" };
    let reads = 0;
    let sleeps = 0;
    const lagging = {
      readTranscriptFacts: () => {
        reads += 1;
        return reads < 3 ? { model: null, lastText: null } : { model: "muse-spark-1.3-contributor", lastText: null };
      },
      sleep: () => {
        sleeps += 1;
      },
    };
    assert.equal(decide(input, env, lagging).action, "block");
    assert.equal(sleeps, 2);

    // A transcript that never gains a record costs a bounded wait, then the stop is allowed.
    let neverSleeps = 0;
    const never = { readTranscriptFacts: () => ({ model: null, lastText: null }), sleep: () => (neverSleeps += 1) };
    assert.equal(decide(input, env, never).why, "not-muse");
    assert.equal(neverSleeps, 3);

    // The assigned-model env names the model, so there is no wait at all.
    let envSleeps = 0;
    const named = { readTranscriptFacts: () => ({ model: null, lastText: null }), sleep: () => (envSleeps += 1) };
    assert.equal(decide(input, isolatedEnv(dir, { PAPERCLIP_ASSIGNED_MODEL: "claude-sonnet-5-5" }), named).why, "not-muse");
    assert.equal(envSleeps, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a muse announce-and-stop is blocked, once per stop, and the run is capped", () => {
  const dir = scratch();
  try {
    const env = isolatedEnv(dir);
    const input = {
      hook_event_name: "Stop",
      session_id: "s",
      transcript_path: transcriptFor(dir, "muse-spark-1.3-contributor", "Running the tests now:"),
      last_assistant_message: "Running the tests now:",
    };
    const verdicts = Array.from({ length: 6 }, () => decide(input, env));
    // Each block is what a real run would see: the same announce, stop after stop.
    const blocks = verdicts.filter((v) => v.action === "block").length;
    assert.equal(blocks, MAX_NUDGES_DEFAULT);
    assert.deepEqual(
      verdicts.map((v) => v.action),
      ["block", "block", "allow", "allow", "allow", "allow"],
    );
    assert.equal(verdicts[2].why, "nudge-cap-reached");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the cap is per run, so a second run starts with a fresh budget", () => {
  const dir = scratch();
  try {
    const input = { hook_event_name: "Stop", session_id: "s", last_assistant_message: "Now writing the module:", transcript_path: transcriptFor(dir, "muse-spark-1.3-contributor", "x") };
    const first = isolatedEnv(dir, { PAPERCLIP_RUN_ID: "run-a" });
    const second = isolatedEnv(dir, { PAPERCLIP_RUN_ID: "run-b" });
    for (let i = 0; i < 3; i += 1) decide(input, first);
    assert.equal(decide(input, first).action, "allow");
    assert.equal(decide(input, second).action, "block");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MUSE_STOP_GUARD_MAX_NUDGES=0 turns blocking off without touching settings", () => {
  const dir = scratch();
  try {
    const env = isolatedEnv(dir, { MUSE_STOP_GUARD_MAX_NUDGES: "0" });
    const input = { hook_event_name: "Stop", last_assistant_message: "Now writing the module:", transcript_path: transcriptFor(dir, "muse-spark-1.3-contributor", "x") };
    assert.equal(decide(input, env).action, "allow");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the config file retunes the guard and the environment wins over it", () => {
  const dir = scratch();
  try {
    const input = { hook_event_name: "Stop", last_assistant_message: "Now writing the module:", transcript_path: transcriptFor(dir, "muse-spark-1.3-contributor", "x") };
    assert.equal(decide(input, isolatedEnv(dir), { config: { maxNudges: 0 } }).action, "allow");
    assert.equal(decide(input, isolatedEnv(dir, { MUSE_STOP_GUARD_MAX_NUDGES: "1" }), { config: { maxNudges: 0 } }).action, "block");
    const finalTurn = { hook_event_name: "Stop", last_assistant_message: "Done.", cwd: dir, transcript_path: transcriptFor(dir, "muse-spark-1.3-contributor", "Done.") };
    const deps = { findUnsavedWork: () => ({ dirtyFiles: 1, unpushedCommits: 0 }) };
    assert.equal(decide(finalTurn, isolatedEnv(dir, { MUSE_STOP_GUARD_UNSAVED: "" }), { ...deps, config: { unsaved: "enforce" } }).action, "allow", "an empty env value is not a mode");
    const noEnv = { ...isolatedEnv(dir) };
    delete noEnv.MUSE_STOP_GUARD_UNSAVED;
    assert.equal(decide(finalTurn, noEnv, { ...deps, config: { unsaved: "enforce" } }).action, "block");
    assert.equal(loadConfig(join(dir, "missing")).maxNudges, undefined, "a missing config is the defaults");
    writeFileSync(join(dir, "muse-stop-guard.config.json"), "{ broken");
    assert.deepEqual(loadConfig(dir), {}, "a broken config is the defaults, never an error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pending background work or a scheduled wakeup is a pause, not a stop", () => {
  const dir = scratch();
  try {
    const env = isolatedEnv(dir);
    const base = { hook_event_name: "Stop", last_assistant_message: "Waiting for CI, then merging.", transcript_path: transcriptFor(dir, "muse-spark-1.3-contributor", "x") };
    assert.equal(decide({ ...base, background_tasks: [{ id: "t", type: "shell", status: "running" }] }, env).why, "background-work-pending");
    assert.equal(decide({ ...base, session_crons: [{ id: "c", schedule: "*/5 * * * *" }] }, env).why, "background-work-pending");
    assert.equal(decide({ ...base, background_tasks: [], session_crons: [] }, env).action, "block");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stop_hook_active is honoured when the counter cannot be trusted", () => {
  const dir = scratch();
  try {
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(join(dir, "state", "run-under-test.json"), "{not json");
    const env = isolatedEnv(dir);
    const input = {
      hook_event_name: "Stop",
      stop_hook_active: true,
      last_assistant_message: "Now writing the module:",
      transcript_path: transcriptFor(dir, "muse-spark-1.3-contributor", "x"),
    };
    assert.equal(decide(input, env).why, "active-and-counter-unreadable");
    // Without the flag, the same unreadable counter is not a reason to nudge forever either.
    assert.equal(decide({ ...input, stop_hook_active: false }, env).action, "block");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a counter that cannot be written means no block, because the loop could not be bounded", () => {
  const dir = scratch();
  try {
    const blocked = join(dir, "not-a-dir");
    writeFileSync(blocked, "a file where the state directory should be");
    const env = isolatedEnv(dir, { MUSE_STOP_GUARD_STATE_DIR: join(blocked, "state") });
    const input = { hook_event_name: "Stop", last_assistant_message: "Now writing the module:", transcript_path: transcriptFor(dir, "muse-spark-1.3-contributor", "x") };
    const verdict = decide(input, env);
    assert.equal(verdict.action, "allow");
    assert.equal(verdict.why, "counter-unwritable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a DISABLED file beside the script allows every stop", () => {
  const dir = scratch();
  try {
    const env = isolatedEnv(dir);
    const input = { hook_event_name: "Stop", last_assistant_message: "Now writing the module:", transcript_path: transcriptFor(dir, "muse-spark-1.3-contributor", "x") };
    assert.equal(decide(input, env, { killSwitchPresent: () => true }).why, "kill-switch");
    assert.equal(decide(input, env, { killSwitchPresent: () => false }).action, "block");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unsaved work: observe logs and allows, enforce blocks, off ignores", () => {
  const dir = scratch();
  try {
    const finalTurn = "Done. Card marked `done`.";
    const base = { hook_event_name: "Stop", last_assistant_message: finalTurn, cwd: dir, transcript_path: transcriptFor(dir, "muse-spark-1.3-contributor", finalTurn) };
    const deps = { findUnsavedWork: () => ({ dirtyFiles: 2, unpushedCommits: 1 }) };
    assert.equal(decide(base, isolatedEnv(dir, { MUSE_STOP_GUARD_UNSAVED: "off" }), deps).why, "final-turn");
    const observed = decide(base, isolatedEnv(dir, { MUSE_STOP_GUARD_UNSAVED: "observe" }), deps);
    assert.equal(observed.action, "allow");
    assert.equal(observed.why, "unsaved-work-observed");
    const enforced = decide(base, isolatedEnv(dir, { MUSE_STOP_GUARD_UNSAVED: "enforce" }), deps);
    assert.equal(enforced.action, "block");
    assert.equal(enforced.kind, "unsaved");
    // Clean tree: nothing to hand back even when enforcing.
    assert.equal(decide(base, isolatedEnv(dir, { MUSE_STOP_GUARD_UNSAVED: "enforce", PAPERCLIP_RUN_ID: "other" }), { findUnsavedWork: () => null }).action, "allow");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findUnsavedWork reads a real repository: clean, dirty, and unpushed", () => {
  const dir = scratch();
  const run = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  try {
    const bare = join(dir, "remote.git");
    const work = join(dir, "work");
    assert.equal(spawnSync("git", ["init", "--bare", "-q", bare]).status, 0);
    assert.equal(spawnSync("git", ["clone", "-q", bare, work]).status, 0);
    const wgit = (...args) => spawnSync("git", ["-C", work, "-c", "user.email=t@example.test", "-c", "user.name=t", ...args], { encoding: "utf8" });
    writeFileSync(join(work, "a.txt"), "1\n");
    wgit("add", "a.txt");
    wgit("commit", "-q", "-m", "base");
    assert.equal(wgit("push", "-q", "origin", "HEAD").status, 0);
    wgit("branch", "--set-upstream-to=origin/" + wgit("rev-parse", "--abbrev-ref", "HEAD").stdout.trim());
    assert.equal(findUnsavedWork(work), null);
    writeFileSync(join(work, "b.txt"), "new\n");
    assert.deepEqual(findUnsavedWork(work), { dirtyFiles: 1, unpushedCommits: 0 });
    mkdirSync(join(work, ".claude"), { recursive: true });
    writeFileSync(join(work, ".claude", "settings.local.json"), "{}");
    assert.equal(findUnsavedWork(work).dirtyFiles, 1, "harness state is not work product");
    wgit("add", "b.txt");
    wgit("commit", "-q", "-m", "local only");
    assert.deepEqual(findUnsavedWork(work), { dirtyFiles: 0, unpushedCommits: 1 });
    assert.equal(findUnsavedWork(dir), null, "outside a work tree is not an error");
    assert.equal(run("status").status !== undefined, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: block prints exactly one JSON object and exits 0; garbage input fails open", () => {
  const dir = scratch();
  try {
    const env = { ...process.env, ...isolatedEnv(dir) };
    const input = {
      hook_event_name: "Stop",
      session_id: "s",
      transcript_path: transcriptFor(dir, "muse-spark-1.3-contributor", "Now running the suite:"),
      last_assistant_message: "Now running the suite:",
    };
    const blocked = spawnSync("node", [HOOK], { input: JSON.stringify(input), env, encoding: "utf8" });
    assert.equal(blocked.status, 0);
    const out = JSON.parse(blocked.stdout);
    assert.equal(out.decision, "block");
    assert.equal(typeof out.reason, "string");
    assert.equal(blocked.stdout.trim().split("\n").length, 1);
    const log = readFileSync(join(dir, "decisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(log[0].action, "block");
    assert.equal("text" in log[0], false, "the model's text is never logged");
    for (const garbage of ["", "not json", "[]", "null", "{}"]) {
      const run = spawnSync("node", [HOOK], { input: garbage, env, encoding: "utf8" });
      assert.equal(run.status, 0, `exit status for ${JSON.stringify(garbage)}`);
      assert.equal(run.stdout, "", `no output for ${JSON.stringify(garbage)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI is fast on a multi-megabyte transcript because it reads only the tail", () => {
  const dir = scratch();
  try {
    const path = join(dir, "big.jsonl");
    const filler = museLine("x".repeat(2000));
    const lines = Array.from({ length: 3000 }, () => filler);
    lines.push(museLine("Now running the suite:"));
    writeFileSync(path, `${lines.join("\n")}\n`);
    const env = { ...process.env, ...isolatedEnv(dir) };
    const started = Date.now();
    const run = spawnSync("node", [HOOK], {
      input: JSON.stringify({ hook_event_name: "Stop", session_id: "s", transcript_path: path }),
      env,
      encoding: "utf8",
    });
    const elapsed = Date.now() - started;
    assert.equal(run.status, 0);
    assert.equal(JSON.parse(run.stdout).decision, "block", "falls back to the transcript when last_assistant_message is absent");
    assert.ok(elapsed < 2000, `took ${elapsed} ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- installer

const FOREIGN = {
  theme: "dark",
  hooks: {
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "bash /shared/quota-pacer/pacer_tick.sh", timeout: 5 }] }],
    PreToolUse: [{ matcher: "Bash|Terminal", hooks: [{ type: "command", command: "node /shared/model-guard/model-guard-hook.mjs", timeout: 5 }] }],
    Stop: [{ hooks: [{ type: "command", command: "node /somewhere/other-stop-hook.mjs" }] }],
  },
};

test("install adds one Stop entry and leaves every other hook byte-identical", () => {
  const next = mergeInstall(FOREIGN, "node /shared/muse-stop-guard/muse-stop-guard.mjs");
  assert.deepEqual(next.hooks.UserPromptSubmit, FOREIGN.hooks.UserPromptSubmit);
  assert.deepEqual(next.hooks.PreToolUse, FOREIGN.hooks.PreToolUse);
  assert.equal(next.theme, "dark");
  assert.equal(next.hooks.Stop.length, 2);
  assert.deepEqual(next.hooks.Stop[0], FOREIGN.hooks.Stop[0]);
  assert.equal(isInstalled(next), true);
  assert.equal(isInstalled(FOREIGN), false);
});

test("install is idempotent and uninstall restores the original exactly", () => {
  const command = "node /shared/muse-stop-guard/muse-stop-guard.mjs";
  const once = mergeInstall(FOREIGN, command);
  const twice = mergeInstall(once, command);
  assert.deepEqual(twice, once);
  assert.deepEqual(removeInstall(once), FOREIGN);
  const bare = { theme: "dark" };
  assert.equal(JSON.stringify(removeInstall(mergeInstall(bare, command))), JSON.stringify(bare));
});

test("apply refuses user scope without the acknowledgement, agent-owned paths and a missing script", () => {
  const home = "/home/agent";
  const userFile = join(home, ".claude", "settings.json");
  const script = "/shared/muse-stop-guard/muse-stop-guard.mjs";
  assert.equal(checkApply({ settingsFile: userFile, scriptPath: script, acknowledged: false, scriptExists: true, home }).ok, false);
  assert.equal(checkApply({ settingsFile: userFile, scriptPath: script, acknowledged: true, scriptExists: true, home }).ok, true);
  assert.equal(checkApply({ settingsFile: "/work/.claude/settings.json", scriptPath: script, acknowledged: false, scriptExists: true, home }).ok, true);
  const owned = "/srv/agents/instances/default/workspaces/abc/muse-stop-guard.mjs";
  assert.equal(isAgentOwnedPath(owned), true);
  assert.equal(isAgentOwnedPath("/srv/agents/instances/default/worktrees/f/b/hooks/muse-stop-guard.mjs"), true);
  assert.equal(checkApply({ settingsFile: userFile, scriptPath: owned, acknowledged: true, scriptExists: true, home }).ok, false);
  assert.equal(checkApply({ settingsFile: userFile, scriptPath: script, acknowledged: true, scriptExists: false, home }).ok, false);
});

test("apply refuses user scope from an agent-run context even with the acknowledgement", () => {
  const home = "/home/agent";
  const userFile = join(home, ".claude", "settings.json");
  const script = "/shared/muse-stop-guard/muse-stop-guard.mjs";
  // Positive control: the host shell with the flag still passes, so the refusal is not vacuous.
  assert.equal(checkApply({ settingsFile: userFile, scriptPath: script, acknowledged: true, scriptExists: true, home, agentRun: false }).ok, true);
  // Agent-run context refuses the same call even with the acknowledgement flag.
  const verdict = checkApply({ settingsFile: userFile, scriptPath: script, acknowledged: true, scriptExists: true, home, agentRun: true });
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems.join(" "), /agent run/);
  // Project/pilot scope still works from an agent run — dry runs and pilots are unaffected.
  assert.equal(checkApply({ settingsFile: "/work/.claude/settings.json", scriptPath: script, acknowledged: false, scriptExists: true, home, agentRun: true }).ok, true);
  // Env detection: PAPERCLIP_RUN_ID or PAPERCLIP_AGENT_ID marks an agent run.
  assert.equal(isAgentRunContext({ PAPERCLIP_RUN_ID: "r1" }), true);
  assert.equal(isAgentRunContext({ PAPERCLIP_AGENT_ID: "a1" }), true);
  assert.equal(isAgentRunContext({}), false);
  // Refusal helper only fires for the user-scope file in an agent run.
  assert.equal(agentContextRefusal({ settingsFile: userFile, home, agentRun: true }) === null, false);
  assert.equal(agentContextRefusal({ settingsFile: userFile, home, agentRun: false }), null);
  assert.equal(agentContextRefusal({ settingsFile: "/work/.claude/settings.json", home, agentRun: true }), null);
  assert.equal(isUserScope(userFile, home), true);
});

test("installer CLI: dry run writes nothing; apply backs up, writes, and uninstall round-trips", () => {
  const dir = scratch();
  try {
    const settings = join(dir, ".claude", "settings.json");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const original = `${JSON.stringify(FOREIGN, null, 2)}\n`;
    writeFileSync(settings, original);
    const script = join(dir, "muse-stop-guard.mjs");
    writeFileSync(script, "// stand-in\n");
    const cli = (...args) => spawnSync("node", [INSTALLER, ...args, "--settings", settings, "--script", script], { encoding: "utf8", env: { ...process.env, HOME: join(dir, "fake-home") } });

    assert.equal(cli("install").status, 0);
    assert.equal(readFileSync(settings, "utf8"), original, "dry run must not write");
    assert.equal(cli("status").status, 0);
    assert.equal(JSON.parse(cli("status").stdout).installed, false);

    const applied = cli("install", "--apply");
    assert.equal(applied.status, 0, applied.stderr);
    const report = JSON.parse(applied.stdout);
    assert.equal(readFileSync(report.backup, "utf8"), original, "backup is the pre-install file");
    assert.equal(JSON.parse(cli("status").stdout).installed, true);

    const removed = cli("uninstall", "--apply");
    assert.equal(removed.status, 0, removed.stderr);
    assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), FOREIGN);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installer CLI refuses an invalid settings file instead of overwriting it", () => {
  const dir = scratch();
  try {
    const settings = join(dir, "settings.json");
    writeFileSync(settings, "{ hand edited, not json");
    const script = join(dir, "muse-stop-guard.mjs");
    writeFileSync(script, "// stand-in\n");
    const run = spawnSync("node", [INSTALLER, "install", "--apply", "--settings", settings, "--script", script], { encoding: "utf8", env: { ...process.env, HOME: join(dir, "h") } });
    assert.notEqual(run.status, 0);
    assert.equal(readFileSync(settings, "utf8"), "{ hand edited, not json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installer CLI refuses user scope without the acknowledgement flag", () => {
  const dir = scratch();
  try {
    const home = join(dir, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const settings = join(home, ".claude", "settings.json");
    writeFileSync(settings, "{}\n");
    const script = join(dir, "muse-stop-guard.mjs");
    writeFileSync(script, "// stand-in\n");
    // Host-shell simulation: strip agent-run markers, which the suite
    // runner inherits when tests run inside an agent run.
    const env = { ...process.env, HOME: home, PAPERCLIP_RUN_ID: "", PAPERCLIP_AGENT_ID: "" };
    const refused = spawnSync("node", [INSTALLER, "install", "--apply", "--settings", settings, "--script", script], { encoding: "utf8", env });
    assert.equal(refused.status, 1);
    assert.equal(readFileSync(settings, "utf8"), "{}\n");
    const accepted = spawnSync("node", [INSTALLER, "install", "--apply", `--${ACK_FLAG}`, "--settings", settings, "--script", script], { encoding: "utf8", env });
    assert.equal(accepted.status, 0, accepted.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installer CLI refuses user-scope --apply from an agent-run context", () => {
  const dir = scratch();
  try {
    const home = join(dir, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const settings = join(home, ".claude", "settings.json");
    writeFileSync(settings, "{}\n");
    const script = join(dir, "muse-stop-guard.mjs");
    writeFileSync(script, "// stand-in\n");
    // Agent-run simulation: even WITH the acknowledgement flag, the
    // user-scope write refuses. The flag authorises the operator's host
    // shell, not an agent run.
    const env = { ...process.env, HOME: home, PAPERCLIP_RUN_ID: "run-under-test" };
    const refused = spawnSync("node", [INSTALLER, "install", "--apply", `--${ACK_FLAG}`, "--settings", settings, "--script", script], { encoding: "utf8", env });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /agent run/);
    assert.equal(readFileSync(settings, "utf8"), "{}\n", "refused apply must not write");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
