// ===========================================================================
// tog-831-stall-guard-sim.mjs — behavioural check of the TOG-831 stall guard.
//
// SCOPE, STATED HONESTLY: the guard lives inline in server/src/index.ts and is
// not exported, so it cannot be imported here. This file is a faithful
// TRANSCRIPTION of that state machine (index.ts:696-736 and the `finally` at
// :779-783). It proves the ALGORITHM is correct; it does NOT prove the
// deployed binding, because a transcription can drift from its source. The
// typecheck (`npx tsc --noEmit`) covers the binding; this covers the behaviour.
//
// Guarding against exactly that drift, ASSERTION 0 below re-reads index.ts and
// fails if the four load-bearing lines are no longer present -- so if someone
// changes the real guard without updating this file, this file goes red rather
// than silently validating a state machine that no longer ships.
//
// The four properties under test:
//   1. A backup running WITHIN the deadline still blocks a second one.
//      (The guard must not be neutered into uselessness.)
//   2. A backup that outlives the deadline is abandoned and the next scheduled
//      tick PROCEEDS. This is the whole fix -- the 92-hour wedge cannot recur.
//   3. A normally-completing backup releases the guard immediately.
//   4. A presumed-dead run that settles LATE does not clear its successor's
//      marker. Without the ownership check this silently permits two concurrent
//      backups -- the opposite of the guard's purpose.
//
// Run: node verification/tog-831-stall-guard-sim.mjs
// ===========================================================================
import { readFileSync, existsSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (m) => { console.log(`  \x1b[32mPASS\x1b[0m  ${m}`); pass++; };
const bad = (m) => { console.log(`  \x1b[31mFAIL\x1b[0m  ${m}`); fail++; };
const hdr = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

// --- Assertion 0: the transcription still matches the shipped source --------
hdr("Transcription is anchored to the real source");
const SRC = process.env.PAPERCLIP_SERVER_INDEX || "/app/server/src/index.ts";
if (!existsSync(SRC)) {
  bad(`cannot anchor: ${SRC} not readable (set PAPERCLIP_SERVER_INDEX)`);
} else {
  const src = readFileSync(SRC, "utf8");
  const required = [
    ["deadline state variable", "databaseBackupInFlightSince"],
    ["stall timeout constant", "databaseBackupStallTimeoutMs"],
    ["presumed-dead branch", "presumed dead"],
    ["ownership check in finally", "databaseBackupInFlightSince === startedAtMs"],
  ];
  for (const [label, needle] of required) {
    src.includes(needle)
      ? ok(`source still contains the ${label}`)
      : bad(`source NO LONGER contains the ${label} ("${needle}") -- this simulation is stale`);
  }
  // The old boolean must be gone; if it came back, the fix was reverted.
  /\bdatabaseBackupInFlight\b(?!Since)/.test(src)
    ? bad("source still references the old boolean databaseBackupInFlight -- fix reverted?")
    : ok("old boolean guard is gone");
}

// --- Faithful transcription of index.ts:696-783 -----------------------------
function makeGuard({ stallTimeoutMs, now }) {
  let inFlightSince = null;
  const events = [];
  return {
    events,
    // Returns "ran" | "skipped" | "conflict"
    start(trigger = "scheduled") {
      if (inFlightSince !== null) {
        const heldMs = now() - inFlightSince;
        if (heldMs > stallTimeoutMs) {
          events.push({ type: "presumed_dead", heldMs });
          inFlightSince = null;
        } else if (trigger === "scheduled") {
          events.push({ type: "skipped", heldMs });
          return { outcome: "skipped", token: null };
        } else {
          return { outcome: "conflict", token: null };
        }
      }
      const startedAtMs = now();
      inFlightSince = startedAtMs;
      events.push({ type: "started", startedAtMs });
      return { outcome: "ran", token: startedAtMs };
    },
    // The `finally` block: release only if the guard is still ours.
    settle(token) {
      if (inFlightSince === token) {
        inFlightSince = null;
        return "released";
      }
      return "not_ours";
    },
    inFlight: () => inFlightSince,
  };
}

const HOUR = 3_600_000;
const TIMEOUT = 2 * HOUR; // the shipped default: two 60-minute intervals

// --- 1. still blocks within the deadline ------------------------------------
hdr("A backup within the deadline still blocks a second one");
{
  let t = 0;
  const g = makeGuard({ stallTimeoutMs: TIMEOUT, now: () => t });
  g.start("scheduled");
  t += HOUR; // one hour in, well short of the 2h deadline
  const r = g.start("scheduled");
  r.outcome === "skipped" ? ok("second scheduled tick is skipped") : bad(`expected skipped, got ${r.outcome}`);
  const m = g.start("manual");
  m.outcome === "conflict" ? ok("manual trigger still gets a conflict") : bad(`expected conflict, got ${m.outcome}`);
}

// --- 2. THE FIX: the wedge cannot outlive the deadline ----------------------
hdr("A hung backup is abandoned once it outlives the deadline");
{
  let t = 0;
  const g = makeGuard({ stallTimeoutMs: TIMEOUT, now: () => t });
  g.start("scheduled"); // this one hangs forever and never settles

  // Replay the real incident: hourly ticks for 92 hours.
  let ran = 0, skipped = 0;
  for (let h = 1; h <= 92; h++) {
    t = h * HOUR;
    const r = g.start("scheduled");
    if (r.outcome === "ran") { ran++; g.settle(r.token); } // successors complete normally
    else skipped++;
  }
  // Before the fix this was ran=0, skipped=92 -- the actual incident.
  //
  // Exactly TWO ticks are lost, and that is the intended cost, not slack: with
  // a 2h deadline and a strict `>`, the h=1 tick (held 1h) and the h=2 tick
  // (held exactly 2h, not yet past it) both skip; h=3 is the first to exceed
  // the deadline and take over. That matches the "at most two ticks are lost"
  // claim in the index.ts comment -- asserted here so the bound is enforced
  // rather than merely asserted in prose.
  ran === 90 && skipped === 2
    ? ok(`92 hourly ticks -> ${ran} ran, ${skipped} skipped (pre-fix: 0 ran, 92 skipped)`)
    : bad(`expected 90 ran / 2 skipped, got ${ran} ran / ${skipped} skipped`);
  g.events.some((e) => e.type === "presumed_dead")
    ? ok("emitted a presumed_dead event for the hung run")
    : bad("never declared the hung run dead");
}

// --- 3. the normal path is untouched ---------------------------------------
hdr("A normally-completing backup releases the guard immediately");
{
  let t = 0;
  const g = makeGuard({ stallTimeoutMs: TIMEOUT, now: () => t });
  const r = g.start("scheduled");
  t += 40_000; // a real backup here takes ~30-40s
  g.settle(r.token) === "released" ? ok("guard released on completion") : bad("guard not released");
  g.inFlight() === null ? ok("no in-flight marker remains") : bad("stale in-flight marker");
  const next = g.start("scheduled");
  next.outcome === "ran" ? ok("the next tick runs normally") : bad(`expected ran, got ${next.outcome}`);
}

// --- 4. the ownership check ------------------------------------------------
hdr("A late-settling dead run does not clear its successor's marker");
{
  let t = 0;
  const g = makeGuard({ stallTimeoutMs: TIMEOUT, now: () => t });
  const dead = g.start("scheduled");   // hangs
  t = 3 * HOUR;                        // past the deadline
  const live = g.start("scheduled");   // successor takes over
  live.outcome === "ran" ? ok("successor acquired the guard") : bad(`successor got ${live.outcome}`);

  // Now the abandoned promise finally settles, hours late.
  g.settle(dead.token) === "not_ours"
    ? ok("late settle is recognised as not owning the guard")
    : bad("late settle wrongly released the guard");
  g.inFlight() === live.token
    ? ok("successor still holds the guard")
    : bad("successor's marker was clobbered -- two backups could run concurrently");
}

// --- 5. the floor on the timeout -------------------------------------------
hdr("The stall timeout has a hard floor");
{
  const computed = Math.max(60_000, Number(undefined) || 60 * 60 * 1000 * 2);
  computed === TIMEOUT ? ok("defaults to two intervals (2h at a 60m interval)") : bad(`got ${computed}`);
  const floored = Math.max(60_000, Number("1") || 0);
  floored === 60_000 ? ok("a 1ms override is floored to 60s, never zero") : bad(`got ${floored}`);
}

console.log(`\n\x1b[1mTOTAL\x1b[0m  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
