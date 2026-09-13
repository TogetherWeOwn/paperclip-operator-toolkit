#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);

const mutants = [
  {
    name: "old-inverted-tier-order",
    file: "src/constants.ts",
    from: 'export const TIER_ORDER: readonly Tier[] = ["T3", "T2", "T1"];',
    to: "export const TIER_ORDER: readonly Tier[] = TIERS;",
  },
  {
    name: "re-enable-disabled-fallback-row",
    file: "src/engine/select.ts",
    from: "    if (!model.enabled) {",
    to: "    if (!model.enabled && !model.fallbackOnly) {",
  },
  {
    name: "remove-released-at-tie-break",
    file: "src/engine/select.ts",
    from:
      "    const releaseOrder = Date.parse(right.releasedAt) - Date.parse(left.releasedAt);\n" +
      "    if (releaseOrder !== 0) return releaseOrder;\n",
    to: "",
  },
  // --- TOG-2136 acceptance-criteria named mutants -------------------------
  {
    // "count rework as n" — rework must inflate wBad/failModel (soft evidence
    // feeding the Bayesian blend), never the raw observation count `n`.
    name: "count-rework-as-n",
    file: "src/engine/scores.ts",
    from:
      "    modelBucket[event.tier] = {\n" +
      "      ...tierStats,\n" +
      "      failModel: tierStats.failModel + weight,\n" +
      "      wBad: tierStats.wBad + weight,\n" +
      "      rework: tierStats.rework + 1,\n" +
      "    };",
    to:
      "    modelBucket[event.tier] = {\n" +
      "      ...tierStats,\n" +
      "      n: tierStats.n + 1,\n" +
      "      failModel: tierStats.failModel + weight,\n" +
      "      wBad: tierStats.wBad + weight,\n" +
      "      rework: tierStats.rework + 1,\n" +
      "    };",
  },
  {
    // "omit 14-day censor" — a card closed <CARD_CENSOR_DAYS ago must be
    // excluded from accepted/rejected, never assumed resolved.
    name: "omit-14-day-censor",
    file: "src/engine/scores.ts",
    from: "const resolved = rows.filter((r) => r.rejected || nowMs - r.closedAtMs >= censorMs);",
    to: "const resolved = rows.filter((r) => true);",
  },
  {
    // "treat missing acceptance as 1.0" — an unmeasured (model, tier) with zero
    // resolved cards must fall back to the model's prior, never optimistic 1.0.
    name: "treat-missing-acceptance-as-1.0",
    file: "src/engine/scores.ts",
    from: "const acceptRate = measured ? accepted.length / resolved.length : priorPByModel[modelId] ?? 0.8;",
    to: "const acceptRate = measured ? accepted.length / resolved.length : 1.0;",
  },
  {
    // "randomize cohort" — earn-in dispatch is a deterministic modular
    // counter, never Math.random(); this mutant swaps in randomness at the
    // one gate that exists specifically to keep this reproducible.
    name: "randomize-cohort",
    file: "src/actuate/earnIn.ts",
    from: "  if (counter % SELECTION_COUNTER_MODULUS !== 0) {",
    to: "  if (Math.random() > 0.5) {",
  },
  {
    // "count runs instead of cards" — perModelPerWeek/active caps and the
    // stop-circuit-breaker all operate on CARD-level state, not per-run.
    // `activePerModel` counting a raw increment-per-outcome rather than
    // reflecting active cards is the corresponding failure mode: this mutant
    // makes the per-model active cap compare against firstEightOutcomes
    // length (a per-RUN counter) instead of the per-CARD activePerModel map.
    name: "count-runs-instead-of-cards",
    file: "src/actuate/earnIn.ts",
    from: "  if ((state.activePerModel[card.modelId] ?? 0) >= config.maxActivePerModel) {",
    to: "  if ((state.firstEightOutcomes[card.modelId]?.length ?? 0) >= config.maxActivePerModel) {",
  },
  {
    // "exceed 8 with injected clock" — the rolling perModelPerWeek window must
    // be recomputed from `nowMs` on every call, never trust a pre-filtered
    // caller-supplied list as if it were already window-bounded.
    name: "exceed-8-with-injected-clock",
    file: "src/actuate/earnIn.ts",
    from:
      "  const windowStartMs = nowMs - ROLLING_WEEK_MS;\n" +
      '  const dispatchedThisWeek = (state.dispatchedThisWeek[card.modelId] ?? []).filter((ts) => ts > windowStartMs).length;',
    to: "  const dispatchedThisWeek = (state.dispatchedThisWeek[card.modelId] ?? []).length;",
  },
  {
    // "dispatch when lane posture is not available" — the lane-availability
    // gate must actually block a saturated lane.
    name: "dispatch-when-lane-posture-not-available",
    file: "src/actuate/earnIn.ts",
    from: '  if (lanePosture !== "available") {',
    to: "  if (false) {",
  },
  {
    // "global-lane-check-passes-while-target-tier-starved" — lane posture
    // MUST be looked up per the CARD'S OWN tier. Collapsing to any single
    // tier's posture (here, always T3 — the tier most likely to look
    // available, e.g. a zen-free lane) must fail a test that starves T1
    // specifically while T3 stays open.
    name: "global-lane-check-passes-while-target-tier-starved",
    file: "src/actuate/earnIn.ts",
    from: "  const lanePosture = lanePostureByTier[card.tier];",
    to: '  const lanePosture = lanePostureByTier.T3;',
  },
  {
    // "read disallowed activity_log" — reopen/rejection signals must be
    // sourced from captured ctx.events state, never a live join against
    // activity_log (absent from coreReadTables). Reintroducing a query
    // against it here stands in for that regression.
    name: "read-disallowed-activity_log",
    file: "src/worker.ts",
    from: "            const reworkSignals = await readReworkSignals(company.id);",
    to:
      "            await ctx.db.query(\"select 1 from activity_log where company_id = $1\", [company.id]);\n" +
      "            const reworkSignals = await readReworkSignals(company.id);",
  },
  {
    // "halve the recency-decay window" — TOG-2136 code review (PR277): the
    // frozen-27-rows spot check derived wOk/wBad algebraically from each row's
    // target p, so it never actually drove a raw run through this constant and
    // this mutation (/10.0 -> /5.0) survived undetected. Killed now by
    // tests/scores.spec.ts's raw-row replay, which drives real RunOutcomeRow[]
    // (explicit ageDays) through accumulateRunStats itself.
    name: "halve-recency-decay-window",
    file: "src/engine/scores.ts",
    from: "    const w = Math.exp(-row.ageDays / 10.0);",
    to: "    const w = Math.exp(-row.ageDays / 5.0);",
  },
  {
    // TOG-2373 QA finding (PR #278 review): disabling the worker.ts
    // integration block that CALLS buildShadowRecord/emitShadowRecord left
    // 200/200 tests green, because every prior shadow-emit test drove
    // buildShadowRecord() directly (tests/shadow-emit.spec.ts) rather than
    // through advise()/apply(). This mutant disables the wiring itself — not
    // the `shadowEmit.enabled` config default, which is a separate, already
    // -covered branch — so only a worker-level test that reads
    // ctx.localFolders after calling advise()/apply() can kill it.
    name: "disable-shadow-emit-wiring-in-worker",
    file: "src/worker.ts",
    from: "        if (config.shadowEmit.enabled) {",
    to: "        if (false) {",
  },
];

function runTests() {
  return spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run"], {
    cwd: root,
    encoding: "utf8",
  });
}

const baseline = runTests();
if (baseline.status !== 0) {
  process.stderr.write("BROKEN GATE: baseline suite is red\n");
  process.stderr.write(baseline.stdout);
  process.stderr.write(baseline.stderr);
  process.exit(1);
}

const scratch = await mkdtemp(join(tmpdir(), "model-selection-mutants-"));
let failures = 0;
try {
  for (const mutant of mutants) {
    const path = join(root, mutant.file);
    const original = await readFile(path, "utf8");
    const occurrences = original.split(mutant.from).length - 1;
    if (occurrences !== 1) {
      console.error(`BROKEN GATE: ${mutant.name} matched ${occurrences} times in ${mutant.file}`);
      failures += 1;
      continue;
    }

    await writeFile(join(scratch, mutant.name), original);
    await writeFile(path, original.replace(mutant.from, mutant.to));
    const result = runTests();
    await writeFile(path, original);

    if (result.status === 0) {
      console.error(`SURVIVED: ${mutant.name}`);
      failures += 1;
    } else {
      console.log(`KILLED: ${mutant.name}`);
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

if (failures > 0) process.exit(1);
console.log(`mutation gate: ${mutants.length}/${mutants.length} killed`);
