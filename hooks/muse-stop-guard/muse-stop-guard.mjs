#!/usr/bin/env node
// Claude Code `Stop` hook for Muse agents: refuse to let a run end on a sentence
// of intent.
//
// WHY THIS EXISTS. A Muse turn often ends as text with no tool call: "Running the
// focused tests now:", "Work product registered. Marking the card done." Claude
// Code treats a text-only `end_turn` as the end of the run, so the step that was
// announced never happens and Paperclip parks the card for a missing disposition.
// In one 24h window that was 352 missing-disposition notices and 225 parks over
// 5,662 runs. This is a model behaviour, not a harness bug, so the fix is to hand
// the turn back once or twice with a reason that names the problem.
//
// WHAT IT DOES. On `Stop`, when the run's model is `muse*` and the final assistant
// message is a statement of intent (or empty), it prints
// `{"decision":"block","reason":...}` and exits 0. Claude Code then continues the
// turn with the reason as the model's next input.
//
// WHAT IT NEVER DOES (each is pinned by a test):
//   - act on any model other than `muse*`. The settings file it is installed in is
//     shared by every agent on the box, so for every other agent this is a no-op.
//   - block more than MAX_NUDGES times per run. The counter lives outside the
//     transcript and is the real loop guard; `stop_hook_active` is honoured on top.
//   - block while background tasks or scheduled wakeups exist: the session is
//     paused on purpose, not finished.
//   - block on an error. Every failure path allows the stop and exits 0.
//   - write the model's text anywhere. The decision log holds lengths and reasons.
//
// SECOND GUARD, UNSAVED WORK. If MUSE_STOP_GUARD_UNSAVED=enforce, a stop with
// uncommitted files or unpushed commits in the working tree is also handed back.
// The default is `observe`: log the finding, never block.
//
// KILL SWITCH AND TUNING. A file named DISABLED next to this script allows every stop,
// including in runs that are already in flight. muse-stop-guard.config.json beside it
// ({"maxNudges": 2, "unsaved": "observe"}) retunes the guard; environment variables win over it.
// Neither needs a settings edit.

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const MAX_NUDGES_DEFAULT = 2;
/** A trailing colon is the strongest tell; longer text can still be an unfinished lead-in. */
export const COLON_MAX_CHARS = 1200;
/** Forward-looking wording is only trusted in short turns; long turns are reports. */
export const CUE_MAX_CHARS = 600;
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
const HARD_DEADLINE_MS = 8000;
// Claude Code writes the transcript asynchronously, so at Stop time a fresh session's first assistant
// record may not be on disk yet (seen in 2 of 3 smoke runs). Wait for it briefly when nothing else
// names the model.
const TRANSCRIPT_RETRIES = 3;
const TRANSCRIPT_RETRY_MS = 100;
const GIT_TIMEOUT_MS = 4000;
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

export function isMuseModel(model) {
  return typeof model === "string" && /^muse/i.test(model.trim());
}

/** The last sentence or line, with markdown decoration and trailing space removed. */
export function lastSentence(text) {
  const clean = String(text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .trim();
  if (!clean) return "";
  const lines = clean.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1] ?? "";
  const parts = lastLine.split(/(?<=[.!?])\s+/).filter(Boolean);
  return (parts[parts.length - 1] ?? lastLine).replace(/[*_`]+$/g, "").trim();
}

/** The part of a sentence after its last dash, semicolon or colon: "Format is clean — running the gates now." */
export function lastClause(sentence) {
  const parts = String(sentence ?? "").split(/\s[—–]\s|\s--\s|;\s|:\s/);
  return (parts[parts.length - 1] ?? "").trim();
}

// "Now writing the store module." "Let me run it." "I'll push." "Time to write the suite."
// "I need to check X." "I'm checking X." "Meanwhile, checking X." "..., then I write the selector."
// Not cues: "Let me know if you want more." and "I will not push without the owner's click."
// `next` and `then` alone are deliberately absent: "Next wake: re-check CI" and "then APPROVE" are
// how a finished card describes its monitor, and flagging them blocks genuine final reports.
const FORWARD_CUE =
  /^(now|meanwhile|need to|needs to)\b|\b(i'?ll(?! not\b)|i will(?! not\b)|i'm (?:going|about)|i am (?:going|about)|i need to|i'm [a-z]+ing|let me(?! know\b)|let's|going to|about to|time to|proceeding to|then i)\b/i;
// "Marking the card done." "Opening the PR via the API." "Re-running the failed jobs now."
const GERUND_START = /^(?:[a-z]+-)?[a-z]{2,}ing\b/i;
// Gerund-led phrases that report a state instead of announcing an act.
const GERUND_STATE =
  /^(standing|nothing|anything|everything|something|following|pending|remaining|existing|missing|passing|failing|ongoing|during|morning|evening|thing|string|staying|keeping|leaving|holding)\b/i;
const FINAL_STEP = /^final (step|cleanup)\b/i;
// A deliberate no-op wake ends "leaving it alone, posting nothing, exiting." That is a finished run.
const NOOP_END =
  /\b(no further action|nothing (?:left|more|further) to (?:do|post)|posting nothing|no new comment|no status write needed|exiting)\W*$/i;

function intentCue(segment) {
  if (!segment) return null;
  if (FORWARD_CUE.test(segment)) return "forward-looking wording";
  if (GERUND_START.test(segment) && !GERUND_STATE.test(segment)) return "action participle";
  if (FINAL_STEP.test(segment)) return "announced final step";
  return null;
}

/**
 * Is this turn a statement of intent with no action behind it?
 * Pure, so the whole decision is testable from fixtures.
 */
export function classifyLastTurn(text) {
  const raw = String(text ?? "");
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "empty", reason: "no text and no tool call" };

  const colon = /:\s*[*_`]*$/.test(trimmed);
  if (colon && trimmed.length <= COLON_MAX_CHARS) {
    return { kind: "announce", reason: "ends with a colon" };
  }
  if (trimmed.length > CUE_MAX_CHARS) return { kind: "final", reason: "long report" };

  const sentence = lastSentence(trimmed);
  const cue = intentCue(sentence) ?? intentCue(lastClause(sentence));
  if (cue && !NOOP_END.test(sentence)) return { kind: "announce", reason: cue };
  return { kind: "final", reason: cue ? "deliberate no-op" : "no intent cue" };
}

/** Read the end of a file without loading a multi-megabyte transcript. */
export function readTail(path, bytes = TRANSCRIPT_TAIL_BYTES) {
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    // A tail that starts mid-record has a broken first line; drop it.
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    closeSync(fd);
  }
}

/** Model and final text of the newest main-thread assistant records in a transcript tail. */
export function readTranscriptFacts(path, { tail = readTail } = {}) {
  const facts = { model: null, lastText: null };
  let body;
  try {
    body = tail(path);
  } catch {
    return facts;
  }
  const lines = body.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line || !line.includes('"assistant"')) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type !== "assistant" || record.isSidechain) continue;
    const message = record.message ?? {};
    if (facts.model === null && typeof message.model === "string") facts.model = message.model;
    if (facts.lastText === null && Array.isArray(message.content)) {
      facts.lastText = message.content
        .filter((block) => block?.type === "text")
        .map((block) => block.text ?? "")
        .join("\n");
    }
    if (facts.model !== null && facts.lastText !== null) break;
  }
  return facts;
}

/** Optional tuning file beside the script, so an operator can retune without editing settings. */
export function loadConfig(dir = HERE) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "muse-stop-guard.config.json"), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function nonEmpty(value) {
  return Array.isArray(value) && value.length > 0;
}

function stateFile(env, key) {
  const dir =
    env.MUSE_STOP_GUARD_STATE_DIR ||
    env.PAPERCLIP_RUN_SCRATCH_DIR ||
    join(tmpdir(), "muse-stop-guard");
  return { dir, file: join(dir, `${String(key).replace(/[^A-Za-z0-9_.-]/g, "_")}.json`) };
}

export function readNudges(env, key) {
  const { file } = stateFile(env, key);
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Number.isInteger(parsed?.nudges) && parsed.nudges >= 0 ? { ok: true, nudges: parsed.nudges } : { ok: false, nudges: 0 };
  } catch (error) {
    // A missing file is a fresh run. Anything else means the counter is unreliable.
    return error?.code === "ENOENT" ? { ok: true, nudges: 0 } : { ok: false, nudges: 0 };
  }
}

export function writeNudges(env, key, nudges) {
  const { dir, file } = stateFile(env, key);
  try {
    mkdirSync(dir, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ nudges, updatedAt: new Date().toISOString() })}\n`);
    renameSync(temporary, file);
    pruneOldState(dir);
    return true;
  } catch {
    return false;
  }
}

/** Only the shared fallback directory needs pruning; a run scratch dir is deleted with the run. */
function pruneOldState(dir) {
  if (!dir.endsWith("muse-stop-guard")) return;
  const cutoff = Date.now() - 48 * 3600 * 1000;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (removed >= 50) break;
    if (!name.endsWith(".json")) continue;
    try {
      const path = join(dir, name);
      if (statSync(path).mtimeMs < cutoff) {
        unlinkSync(path);
        removed += 1;
      }
    } catch {
      /* another stop is pruning too */
    }
  }
}

function git(args, cwd, runner = spawnSync) {
  const result = runner("git", args, {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout ?? "").trim();
}

/**
 * Work that exists only in this working tree: uncommitted files, or commits no
 * remote has. Local git only; it never talks to the network and never mutates.
 */
export function findUnsavedWork(cwd, runner = spawnSync) {
  if (!cwd || git(["rev-parse", "--is-inside-work-tree"], cwd, runner) !== "true") return null;
  const status = git(["status", "--porcelain=v1", "--untracked-files=normal"], cwd, runner);
  const dirty = (status ?? "")
    .split("\n")
    .filter(Boolean)
    // Harness and tool state is not work product.
    .filter((line) => !/^\?\? \.(claude|paperclip)(\/|$)/.test(line));
  let ahead = git(["rev-list", "--count", "@{upstream}..HEAD"], cwd, runner);
  if (ahead === null) ahead = git(["rev-list", "--count", "HEAD", "--not", "--remotes"], cwd, runner);
  const unpushed = Number.parseInt(ahead ?? "0", 10) || 0;
  if (dirty.length === 0 && unpushed === 0) return null;
  return { dirtyFiles: dirty.length, unpushedCommits: unpushed };
}

function excerpt(text) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
}

export function announceReason(text, env = {}) {
  const card = env.PAPERCLIP_TASK_ID ? ` Your card is ${env.PAPERCLIP_TASK_ID}.` : "";
  const said = excerpt(text);
  const lead = said
    ? `You ended your turn with a statement of intent ("${said}") and no tool call.`
    : "You ended your turn with no text and no tool call.";
  return (
    `${lead} Nothing was done, and a run that stops here is parked as missing its disposition. ` +
    "Do not end a turn by announcing a next step. Take the step now with a tool call. " +
    "If the work for this wake is already finished, record the card disposition instead " +
    '(status done, in_review or blocked with its path, or {"resume": true, "comment": "..."} to queue ' +
    `the next run), then give a short final summary.${card}`
  );
}

export function unsavedReason(unsaved, env = {}) {
  const card = env.PAPERCLIP_TASK_ID ? ` Your card is ${env.PAPERCLIP_TASK_ID}.` : "";
  return (
    `This working tree holds work no remote has: ${unsaved.dirtyFiles} uncommitted file(s) and ` +
    `${unsaved.unpushedCommits} unpushed commit(s). Work that lives only in a worker workspace is lost ` +
    "when the run ends. Commit it and push the branch to origin now, or, if it is scratch you do not " +
    `want, delete it, then give your final summary.${card}`
  );
}

/**
 * The whole decision, with every side effect injected. Returns
 * `{ action: "allow" | "block", why, reason?, model?, kind? }`.
 */
export function decide(input, env, deps = {}) {
  const readFacts = deps.readTranscriptFacts ?? readTranscriptFacts;
  const readCounter = deps.readNudges ?? readNudges;
  const writeCounter = deps.writeNudges ?? writeNudges;
  const findUnsaved = deps.findUnsavedWork ?? findUnsavedWork;
  const killSwitch = deps.killSwitchPresent ?? (() => existsSync(join(HERE, "DISABLED")));
  const config = deps.config ?? loadConfig();

  if (killSwitch()) return { action: "allow", why: "kill-switch" };
  if (!input || typeof input !== "object") return { action: "allow", why: "no-input" };
  if (input.hook_event_name && input.hook_event_name !== "Stop") return { action: "allow", why: "not-stop-event" };

  // Model gate. The transcript says what actually answered; the assigned-model env covers a
  // transcript with no assistant record yet; a short bounded wait covers a transcript that is
  // still being written and an env that names nothing.
  const sleep = deps.sleep ?? sleepSync;
  let facts = input.transcript_path ? readFacts(input.transcript_path) : { model: null, lastText: null };
  let model = facts.model ?? env.PAPERCLIP_ASSIGNED_MODEL ?? env.ANTHROPIC_MODEL ?? null;
  for (let attempt = 0; model === null && input.transcript_path && attempt < TRANSCRIPT_RETRIES; attempt += 1) {
    sleep(TRANSCRIPT_RETRY_MS);
    facts = readFacts(input.transcript_path);
    model = facts.model;
  }
  if (!isMuseModel(model)) return { action: "allow", why: "not-muse" };

  if (nonEmpty(input.background_tasks) || nonEmpty(input.session_crons)) {
    return { action: "allow", why: "background-work-pending", model };
  }

  // Precedence: environment, then the config file, then the default.
  const max = Number.parseInt(env.MUSE_STOP_GUARD_MAX_NUDGES ?? config.maxNudges ?? "", 10);
  const cap = Number.isInteger(max) && max >= 0 ? max : MAX_NUDGES_DEFAULT;
  const key = env.PAPERCLIP_RUN_ID || input.session_id || "unknown";
  const counter = readCounter(env, key);
  // stop_hook_active means a stop hook already continued this turn. The counter is
  // a stronger guard than the flag, but if the counter cannot be trusted the flag wins.
  if (input.stop_hook_active && !counter.ok) return { action: "allow", why: "active-and-counter-unreadable", model };
  if (counter.nudges >= cap) return { action: "allow", why: "nudge-cap-reached", model, nudges: counter.nudges };

  const text = typeof input.last_assistant_message === "string" ? input.last_assistant_message : facts.lastText;
  if (typeof text === "string") {
    const verdict = classifyLastTurn(text);
    if (verdict.kind !== "final") {
      if (!writeCounter(env, key, counter.nudges + 1)) {
        return { action: "allow", why: "counter-unwritable", model, kind: verdict.kind };
      }
      return {
        action: "block",
        why: verdict.reason,
        kind: verdict.kind,
        model,
        nudges: counter.nudges + 1,
        reason: announceReason(text, env),
      };
    }
  }

  const mode = String(env.MUSE_STOP_GUARD_UNSAVED ?? config.unsaved ?? "observe").toLowerCase();
  if (mode === "observe" || mode === "enforce") {
    const unsaved = findUnsaved(input.cwd);
    if (unsaved) {
      if (mode === "observe") return { action: "allow", why: "unsaved-work-observed", model, unsaved };
      if (!writeCounter(env, key, counter.nudges + 1)) return { action: "allow", why: "counter-unwritable", model };
      return {
        action: "block",
        why: "unsaved work",
        kind: "unsaved",
        model,
        unsaved,
        nudges: counter.nudges + 1,
        reason: unsavedReason(unsaved, env),
      };
    }
  }
  return { action: "allow", why: "final-turn", model };
}

function logDecision(env, decision, input) {
  if (decision.why === "not-muse" || decision.why === "kill-switch" || decision.why === "no-input") return;
  const path = env.MUSE_STOP_GUARD_LOG || join(HERE, "decisions.jsonl");
  try {
    try {
      if (statSync(path).size > LOG_ROTATE_BYTES) renameSync(path, `${path}.1`);
    } catch {
      /* no log yet */
    }
    const line = {
      ts: new Date().toISOString(),
      action: decision.action,
      why: decision.why,
      kind: decision.kind ?? null,
      model: decision.model ?? null,
      nudges: decision.nudges ?? null,
      unsaved: decision.unsaved ?? null,
      run: env.PAPERCLIP_RUN_ID ?? null,
      session: input?.session_id ?? null,
      stopHookActive: Boolean(input?.stop_hook_active),
    };
    appendFileSync(path, `${JSON.stringify(line)}\n`);
  } catch {
    /* a log that cannot be written must never change the decision */
  }
}

function readStdin(timeoutMs) {
  return new Promise((resolve) => {
    let raw = "";
    const timer = setTimeout(() => resolve(raw), timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      raw += chunk;
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(raw);
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      resolve(raw);
    });
  });
}

async function main() {
  setTimeout(() => process.exit(0), HARD_DEADLINE_MS).unref();
  let input = null;
  try {
    input = JSON.parse(await readStdin(2000));
  } catch {
    process.exit(0);
  }
  let decision;
  try {
    decision = decide(input, process.env);
  } catch {
    process.exit(0);
  }
  logDecision(process.env, decision, input);
  if (decision.action === "block") {
    process.stdout.write(`${JSON.stringify({ decision: "block", reason: decision.reason })}\n`);
  }
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
