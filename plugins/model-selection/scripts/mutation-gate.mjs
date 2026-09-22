#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  MUTATION_GATE_CI_MESSAGE,
  copyMutationTree,
  mutationGateAllowed,
  mutationGateVitestInvocation,
  runSequentially,
  stageRepoFixtures,
} from "./mutation-gate-runtime.mjs";

if (!mutationGateAllowed()) {
  process.stderr.write(`${MUTATION_GATE_CI_MESSAGE}\n`);
  process.exit(2);
}

const root = resolve(new URL("..", import.meta.url).pathname);
const repoRoot = resolve(root, "../..");

const mutants = [
  // TOG-3930: the re-landed serviceability stop must survive neither a healthy
  // peer nor an indeterminate roll-up, and account verdicts must agree with it.
  {
    name: "serviceability-ignore-margin",
    file: "src/lane-capacity/pace.ts",
    from: "  const tripCeilingMilli = SCALE - marginMilli;",
    to: "  const tripCeilingMilli = SCALE;",
  },
  {
    name: "serviceability-exclusive-trip-ceiling",
    file: "src/lane-capacity/pace.ts",
    from: "      toMilli(window.utilization) >= tripCeilingMilli,",
    to: "      toMilli(window.utilization) > tripCeilingMilli,",
  },
  {
    name: "serviceability-account-ignores-margin-trip",
    file: "src/lane-capacity/pace.ts",
    from: "  if (trippedServiceabilityWindows(windows, tripCeilingMilli).length > 0) return false;\n",
    to: "",
  },
  {
    name: "serviceability-uncomputable-account-ignores-trip",
    file: "src/lane-capacity/pace.ts",
    from: '      const exhausted = account.health === "exhausted" || account.health === "unavailable" || tripped.length > 0;',
    to: '      const exhausted = account.health === "exhausted" || account.health === "unavailable";',
  },
  {
    name: "serviceability-healthy-peer-rescues-lane",
    file: "src/lane-capacity/pace.ts",
    from: "  if (internal.some((entry) => entry.tripped)) {",
    to: "  if (internal.every((entry) => entry.tripped)) {",
  },
  {
    name: "serviceability-indeterminate-peer-masks-trip",
    file: "src/lane-capacity/pace.ts",
    from: "  if (internal.some((entry) => entry.tripped)) {",
    to: "  if (internal.some((entry) => entry.tripped) && !internal.some((entry) => entry.indeterminateWeight || entry.indeterminateGovernor)) {",
  },
  {
    name: "serviceability-latest-reset-instead-of-earliest",
    file: "src/lane-capacity/pace.ts",
    from: "      .sort((left, right) => left.ms - right.ms);",
    to: "      .sort((left, right) => right.ms - left.ms);",
  },
  {
    name: "serviceability-drop-tripped-reset",
    file: "src/lane-capacity/pace.ts",
    from: "urgentResetAt: trippedResets[0]?.resetsAt ?? null",
    to: "urgentResetAt: null",
  },
  {
    name: "serviceability-remove-lane-hard-stop",
    file: "src/lane-capacity/pace.ts",
    from: "  if (internal.some((entry) => entry.tripped)) {",
    to: "  if (false) {",
  },
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
  // --- TOG-2572 named mutants: wasted dispatch-sweep wakes -----------------
  {
    // "remove monitor-armed check" — TOG-2426: a card with its own future
    // monitor wake scheduled must never be woken again by the sweep.
    name: "remove-monitor-armed-check",
    file: "src/engine/dispatch-selection.ts",
    from:
      '  if (isMonitorArmed(issue, nowMs)) {\n' +
      '    return { outcome: "refused_monitor_armed", wakeable: true };\n' +
      "  }\n",
    to: "",
  },
  {
    // "remove human-ask park check" — TOG-2319/2455/1677: a pending
    // human_only (or wrong-addressee) interaction means no agent run can
    // advance the card.
    name: "remove-human-ask-park-check",
    file: "src/engine/dispatch-selection.ts",
    from:
      '  if (isParkedOnHumanAsk(pendingInteractions, issue.assigneeAgentId)) {\n' +
      '    return { outcome: "parked_on_human_ask", wakeable: true };\n' +
      "  }\n",
    to: "",
  },
  {
    // "remove in_review reviewer check" — an in_review card must only wake
    // when the assignee is the reviewer actually named on a pending
    // interaction, mirroring the retired dispatcher.py's treatment.
    name: "remove-in-review-reviewer-check",
    file: "src/engine/dispatch-selection.ts",
    from:
      '  if (issue.status === "in_review" && !isReviewerNamedAssignee(pendingInteractions, issue.assigneeAgentId)) {\n' +
      '    return { outcome: "refused_in_review", wakeable: true };\n' +
      "  }\n",
    to: "",
  },
  {
    // TOG-2504: a one-sided stream must not pass merely because the existing
    // plugin-shadow emitter still writes a schema-valid record. Removing the
    // host projection must fail the worker-level paired-stream assertion.
    name: "drop-host-projection-from-decision-pair",
    file: "src/worker.ts",
    from: "          await emitDecisionPair(companyId, [buildHostRecord(recordInput), buildShadowRecord(recordInput)]);",
    to: "          await emitDecisionPair(companyId, [buildShadowRecord(recordInput)]);",
  },
  // --- TOG-2988 named mutants: five-benchmark prior and derived tiers ------
  // No mutant for MIN_POPULATED_BENCHMARKS: under the v1 weights no two
  // benchmarks reach 0.75, so the count gate is unreachable on its own and any
  // mutant of it would be unkillable by construction. The assumption is pinned
  // by a test instead ("cannot reach the weight gate with two benchmarks").
  {
    // Trap 1, the headline failure mode: `priorP(null)` is 0.8, which is
    // exactly SCORE_THRESHOLDS.T2. Reusing that default for tiering promotes
    // every unscored model to T2 on no evidence. Tiering must fail closed.
    name: "unscored-model-defaults-to-0.8-prior",
    file: "src/engine/benchmark-prior.ts",
    from: "  if (typeof aaIndex !== \"number\" || !Number.isFinite(aaIndex)) return null;",
    to: "  if (typeof aaIndex !== \"number\" || !Number.isFinite(aaIndex)) return 0.8;",
  },
  {
    // The weight half of the coverage gate. Three LIGHT benchmarks (0.60
    // weight) must not stand in for the basket.
    name: "drop-available-weight-gate",
    file: "src/engine/benchmark-prior.ts",
    from: "  if (availableWeight < MIN_AVAILABLE_WEIGHT) return null;\n",
    to: "",
  },
  {
    // Trap 2: an absent benchmark is not a zero. Coercing it moves the prior
    // and lets a publisher's coverage gap read as a measured failure.
    name: "treat-absent-benchmark-as-zero",
    file: "src/engine/benchmark-prior.ts",
    from:
      "    const raw = row[key];\n" +
      "    if (typeof raw !== \"number\" || !Number.isFinite(raw)) continue;\n" +
      "    weighted += weight * clip(raw / anchor);",
    to:
      "    const raw = row[key];\n" +
      "    const safe = typeof raw === \"number\" && Number.isFinite(raw) ? raw : 0;\n" +
      "    weighted += weight * clip(safe / anchor);",
  },
  {
    // Trap 2, inverse: Omniscience is a SIGNED index and legitimately negative.
    // Skipping negatives would let a model dodge its own worst result and score
    // as though it had never been measured on that benchmark.
    name: "skip-negative-omniscience-index",
    file: "src/engine/benchmark-prior.ts",
    from: "    if (typeof raw !== \"number\" || !Number.isFinite(raw)) continue;",
    to: "    if (typeof raw !== \"number\" || !Number.isFinite(raw) || raw < 0) continue;",
  },
  {
    // Re-normalising by the full 1.0 rather than the available weight penalises
    // a model for a benchmark nobody published for it.
    name: "normalise-basket-by-full-weight",
    file: "src/engine/benchmark-prior.ts",
    from: "  return weighted / availableWeight;",
    to: "  return weighted;",
  },
  {
    // The basket must be mapped onto the index prior's 0.55..1.0 range before
    // blending; blending a raw 0..1 basket drags every measured model down.
    name: "blend-raw-basket-without-range-map",
    file: "src/engine/benchmark-prior.ts",
    from: "    value: (1 - BENCHMARK_BLEND) * index + BENCHMARK_BLEND * (0.55 + 0.45 * basket),",
    to: "    value: (1 - BENCHMARK_BLEND) * index + BENCHMARK_BLEND * basket,",
  },
  {
    // Trap 3 on identity: `U` is aa.ai AutomationBench's guardrail-adjusted
    // partial score, never Zapier's strictScore. A relabelling here reads as a
    // harmless rename and silently changes what the tier means.
    name: "relabel-automationbench-as-strict-score",
    file: "src/engine/benchmark-prior.ts",
    from: '  { key: "automationBenchAaGuardrailAdjusted", anchor: 0.7, weight: 0.2 },',
    to: '  { key: "automationBenchStrictScore", anchor: 0.7, weight: 0.2 },',
  },
  {
    // TIER_ORDER is ASCENDING capability (["T3","T2","T1"]) because select.ts
    // compares tiers by index. Walking it as-written matches T3's 0.75 before
    // T1's 0.85 and labels EVERY model T3.
    name: "cut-tiers-in-ascending-capability-order",
    file: "src/engine/scores.ts",
    from: "const TIER_ORDER_BY_CAPABILITY_DESC: readonly Tier[] = [...TIER_ORDER].reverse();",
    to: "const TIER_ORDER_BY_CAPABILITY_DESC: readonly Tier[] = TIER_ORDER;",
  },
  {
    // Trap 3: below the T3 floor means labelled T3 WITH A FLAG, not dropped and
    // not quietly indistinguishable from a model that earned T3.
    name: "never-flag-below-t3-floor",
    file: "src/engine/scores.ts",
    from: '  return { tier: "T3", belowT3Floor: true };',
    to: '  return { tier: "T3", belowT3Floor: false };',
  },
  {
    // Versioning requirement: a tier written under a superseded spec describes
    // a rule this build no longer implements. It must be ignored until
    // refreshScores rewrites it, never reinterpreted under the new spec.
    name: "ignore-spec-version-when-overlaying-tier",
    file: "src/engine/scores.ts",
    from: "    if (score.tierSpecVersion !== specVersion) return model;\n",
    to: "",
  },
  {
    // An unscored model must retain its configured tier, not be overlaid with
    // a null tier that no downstream tier comparison can handle.
    name: "overlay-null-derived-tier",
    file: "src/engine/scores.ts",
    from: "    if (!score || !score.derivedTier) return model;",
    to: "    if (!score) return model;",
  },
  {
    // The wiring mutant. Every unit test above passes against a stored score
    // that never reaches selectModel; only a worker-level test that drives
    // advise() and reads the chosen model can kill this. Same gap TOG-2373
    // found for the shadow emitter.
    name: "bypass-derived-tier-overlay-in-selection",
    file: "src/worker.ts",
    from: "            models: applyDerivedTiers(config.models, modelScores),",
    to: "            models: config.models,",
  },
  {
    // The duplicate-id defect this gate exists to keep fixed. A score is one
    // verdict per model id; the roster lists some ids twice. Rewriting every
    // matching row flips `gpt-5.6-sol`'s deliberate T2 placement to T1 and
    // vacates the T2 rung entirely.
    name: "retier-every-row-sharing-a-model-id",
    file: "src/engine/scores.ts",
    from: "      if (model.tier !== topRung(model.id)) return model;",
    to: "      // mutant: promote every row, not just the model's top rung",
  },
  {
    // Promotion on the aa.ai composite alone, with no admissible agentic
    // basket behind it.
    name: "promote-on-an-index-only-basis",
    file: "src/engine/scores.ts",
    from: '      if (score.priorBasis === "index-only") return model;',
    to: "      // mutant: allow a promotion with no benchmark basket",
  },
  {
    // A disabled row is not a rung the fleet can select from. Counting one
    // suppresses a live promotion — `glm-5.3` holds a disabled T1 row beside
    // its enabled T2 one, so this pins its top rung at T1 and it never moves.
    name: "count-disabled-rows-as-the-top-rung",
    file: "src/engine/scores.ts",
    from: "    if (model.enabled !== false) raise(enabledTop, model.id, model.tier);",
    to: "    raise(enabledTop, model.id, model.tier);",
  },
  {
    // TOG-2674: an exhausted account with utilization 1 must not dilute a
    // serviceable account at 0.02 into a fake lane utilization of 0.51.
    name: "blend-exhausted-accounts-into-lane-pace",
    file: "src/lane-capacity/pace.ts",
    from:
      "    entry.verdict.serviceable &&\n" +
      "    entry.utilizationMilli !== null &&\n",
    to: "    entry.utilizationMilli !== null &&\n",
  },
  {
    // TOG-2674: the paired decision stream must retain account-level posture;
    // lane-only rows cannot explain which accounts were excluded from pace.
    name: "drop-account-rows-from-decision-log",
    file: "src/shadow-emit.ts",
    from: "      accounts: accountSnapshots(verdict),\n",
    to: "      accounts: [],\n",
  },
  {
    // TOG-3211: `explanations` must name the gate that rejected each
    // candidate — this failure is silent in production (the job still
    // reports `succeeded`), so only the suite can distinguish an empty
    // explanations array from a populated one.
    name: "empty-the-explanations-array",
    file: "src/shadow-emit.ts",
    from: "    explanations: decision.rejections.slice(0, SHADOW_EXPLANATIONS_CAP).map((rejection) => ({\n      modelId: rejection.modelId,\n      gate: rejection.stage,\n      operand: rejection.operand,\n    })),\n",
    to: "    explanations: [],\n",
  },
  {
    // TOG-2692: a Go account at 0.99 monthly must bind on monthly even when its
    // weekly allowance reads empty. Choosing the largest window resurrects the
    // exact weekly-low/monthly-full routing defect.
    name: "bind-on-longest-window-instead-of-clear-rate",
    file: "src/lane-capacity/pace.ts",
    from:
      "  const tightest = [...allowances].sort((left, right) =>\n" +
      "    left.clearRate! - right.clearRate! || left.name.localeCompare(right.name)\n" +
      "  )[0] ?? null;",
    to:
      "  const tightest = [...allowances].sort((left, right) =>\n" +
      "    right.windowSeconds! - left.windowSeconds! || left.name.localeCompare(right.name)\n" +
      "  )[0] ?? null;",
  },
  {
    // TOG-2692: the per-lane `weekly`/`fiveHour` columns must each read their
    // OWN named window. Copying one governing-window score into both is the
    // defect measured at 32aa30b9 — identical in 25,000/25,000 lane
    // observations — and it put a governing number on the quota page under a
    // `fiveHour` label, which reads as a measurement rather than a data gap.
    name: "copy-governing-score-into-both-lane-columns",
    file: "src/shadow-emit.ts",
    from:
      "      weekly: namedWindowUtilization(verdict, windowNames.weekly),\n" +
      "      fiveHour: namedWindowUtilization(verdict, windowNames.fiveHour),\n",
    to:
      "      weekly: verdict?.score?.utilization ?? null,\n" +
      "      fiveHour: verdict?.score?.utilization ?? null,\n",
  },
  {
    // TOG-2692: an unobserved window must report `null`, never `0`. Reusing
    // pacing.ts's fail-neutral-to-0 gate helper here would render "the 5-hour
    // window is untouched" for a window nobody measured.
    name: "fail-neutral-lane-window-columns-to-zero",
    file: "src/shadow-emit.ts",
    from: "  return utilizations.length > 0 ? Math.max(...utilizations) : null;\n",
    to: "  return utilizations.length > 0 ? Math.max(...utilizations) : 0;\n",
  },
  {
    // TOG-2692: final-24h accounts must enter the hard priority tier; leaving
    // them at priority zero loses the explicit reset-clearing behavior.
    name: "remove-final-24h-account-priority",
    file: "src/shadow-emit.ts",
    from: '  return account.state === "push" ? 100 : 0;\n',
    to: "  return 0;\n",
  },
  {
    // TOG-2692: a weekly-only governor would reproduce the current defect on
    // D02/D03/D04 by ignoring their staggered monthly hard limits entirely.
    name: "go-weekly-only-governor",
    file: "src/lane-capacity/pace.ts",
    from:
      "  const allowances = windows.filter((window) =>\n" +
      "    window.role === \"allowance\" &&\n",
    to:
      "  const allowances = windows.filter((window) =>\n" +
      "    window.name === \"weekly\" &&\n" +
      "    window.role === \"allowance\" &&\n",
  },
  {
    // TOG-2692: production collector rows report plan_weight. Dropping it from
    // the default turns Max 20x and Max 5x into equal-capacity accounts.
    name: "drop-plan-weight-from-default-fields",
    file: "src/constants.ts",
    from: 'export const DEFAULT_PACE_WEIGHT_FIELDS = ["plan_weight", "weight"] as const;\n',
    to: 'export const DEFAULT_PACE_WEIGHT_FIELDS = ["weight"] as const;\n',
  },
  {
    // TOG-2692: unknown production capacity is indeterminate, never an
    // implicit one-unit subscription.
    name: "default-unknown-account-weight-to-one",
    file: "src/lane-capacity/pace.ts",
    from:
      '  return reported === null\n' +
      '    ? { weight: null, source: "unknown" }\n' +
      '    : { weight: reported, source: "reported" };',
    to:
      '  return reported === null\n' +
      '    ? { weight: 1, source: "reported" }\n' +
      '    : { weight: reported, source: "reported" };',
  },
  {
    // TOG-2692: a window with no account or allowance weight must remain
    // unknown at normalization rather than regaining an implicit unit weight.
    name: "default-unknown-allowance-weight-to-one",
    file: "src/lane-capacity/pace.ts",
    from:
      "          allowanceWeight: invalidReportedAllowanceWeight\n" +
      "            ? null\n" +
      '            : reportedAllowanceWeight ?? (window.role === "allowance" ? weight.weight : null),\n',
    to:
      "          allowanceWeight: invalidReportedAllowanceWeight\n" +
      "            ? null\n" +
      '            : reportedAllowanceWeight ?? (window.role === "allowance" ? (weight.weight ?? 1) : null),\n',
  },
  {
    // TOG-2692 review round 2 (P1-2): a window that REPORTS `allowance_weight`
    // and reports a non-positive/non-numeric one has stated a broken weight.
    // Silently substituting the account's plan weight publishes `reason: "ok"`
    // and a `knownWeight` the snapshot never asserted.
    name: "default-a-broken-reported-allowance-weight-to-plan-weight",
    file: "src/lane-capacity/pace.ts",
    from:
      "        const invalidReportedAllowanceWeight = nested !== null &&\n" +
      '          "allowance_weight" in nested &&\n',
    to:
      "        const invalidReportedAllowanceWeight = false && nested !== null &&\n" +
      '          "allowance_weight" in nested &&\n',
  },
  {
    // TOG-2692: equal logical-account round-robin strands allowance at the
    // earliest deadline; the Go fixture's 87.35/4.38/8.27 split must kill it.
    name: "equal-logical-account-round-robin",
    file: "src/lane-capacity/pace.ts",
    from:
      "      ? 0\n" +
      "      : rawShare(entry) / shareDenominator,\n",
    to:
      "      ? 0\n" +
      "      : 1 / serviceableAccountCount,\n",
  },
  {
    // TOG-2692: stable logical-account identity is part of the collector
    // contract. Missing ids must invalidate the document, never use position.
    name: "synthesize-missing-account-id-from-position",
    file: "src/lane-capacity/pace.ts",
    from: "  const accountKeys = validRecords.map((record) => accountKey(record, accountKeyFields));\n",
    to: "  const accountKeys = validRecords.map((record, index) => accountKey(record, accountKeyFields) ?? `record-${index + 1}`);\n",
  },
  {
    // TOG-2692: subscription-pool owns the Go account decision. Replacing its
    // reported target with a locally recomputed window rate must fail.
    name: "ignore-reported-account-target-rate",
    file: "src/lane-capacity/pace.ts",
    from: "    const effectiveTargetBurnRate = reportedTargetBurnRate ?? governing.clearRate;\n",
    to: "    const effectiveTargetBurnRate = governing.clearRate;\n",
  },
  {
    // TOG-2692 review round 2 (P1-3): a reported decision is only about the
    // window the account DECLARED. Once a tighter allowance governs, honouring
    // the stale `target_burn_rate`/`deficit`/`recommended_share`/
    // `governing_reset_at` paces the account off the window it is no longer on.
    name: "honour-a-stale-reported-decision-under-a-tighter-governor",
    file: "src/lane-capacity/pace.ts",
    from: "    const declaredGoverns = account.governingWindow !== null && governing.name === account.governingWindow;\n",
    to: "    const declaredGoverns = account.governingWindow !== null;\n",
  },
  {
    // TOG-2692: reported subscription-pool share is authoritative. Falling
    // through to locally recomputed deficits restores a competing selector.
    name: "ignore-reported-account-share",
    file: "src/lane-capacity/pace.ts",
    from:
      "  const useReportedShares = shareCandidates.length > 0 &&\n" +
      "    shareCandidates.every((entry) => entry.verdict.recommendedShare != null);\n",
    to: "  const useReportedShares = false;\n",
  },
  {
    // TOG-2692 review P1: reported shares are a distribution over the pool and
    // deficits are burn rates. Normalizing each basis against its own total and
    // summing lets the lane hand out 200% — a mixed fixture must kill it.
    name: "normalize-reported-and-fallback-shares-separately",
    file: "src/lane-capacity/pace.ts",
    from:
      "  const shareDenominator = shareCandidates.reduce((sum, entry) => sum + rawShare(entry), 0);\n" +
      "  const accounts = internal.map((entry) => ({\n" +
      "    ...entry.verdict,\n" +
      "    recommendedShare: !entry.verdict.serviceable || entry.verdict.targetBurnRate == null || shareDenominator <= 0\n" +
      "      ? 0\n" +
      "      : rawShare(entry) / shareDenominator,\n" +
      "  }));\n",
    to:
      "  const reportedShareTotal = shareCandidates.reduce((sum, entry) =>\n" +
      "    entry.verdict.recommendedShare != null ? sum + Math.max(0, entry.verdict.recommendedShare) : sum, 0);\n" +
      "  const fallbackShareDenominator = shareCandidates.reduce((sum, entry) =>\n" +
      "    entry.verdict.recommendedShare != null ? sum : sum + Math.max(0, entry.verdict.deficit ?? entry.verdict.targetBurnRate!), 0);\n" +
      "  const accounts = internal.map((entry) => ({\n" +
      "    ...entry.verdict,\n" +
      "    recommendedShare: !entry.verdict.serviceable || entry.verdict.targetBurnRate == null\n" +
      "      ? 0\n" +
      "      : entry.verdict.recommendedShare != null && reportedShareTotal > 0\n" +
      "        ? Math.max(0, entry.verdict.recommendedShare) / reportedShareTotal\n" +
      "        : fallbackShareDenominator > 0\n" +
      "          ? Math.max(0, entry.verdict.deficit ?? entry.verdict.targetBurnRate!) / fallbackShareDenominator\n" +
      "          : 0,\n" +
      "  }));\n",
  },
  {
    // TOG-2692 review P1: a share basis chosen per-account rather than per-lane
    // starves every account that does not report a share.
    name: "mix-reported-and-fallback-share-bases",
    file: "src/lane-capacity/pace.ts",
    from: "    shareCandidates.every((entry) => entry.verdict.recommendedShare != null);\n",
    to: "    shareCandidates.some((entry) => entry.verdict.recommendedShare != null);\n",
  },
  {
    // TOG-2692 review P1: a declared governing window is authoritative.
    // Substituting the smallest-clear-rate allowance paces the account off a
    // different subscription allowance than the one it named.
    name: "substitute-another-allowance-for-a-named-governor",
    file: "src/lane-capacity/pace.ts",
    from: "  const declared = allowances.find((window) => window.name === configured) ?? null;\n" +
      "  if (declared === null) return null;\n",
    to: "  const declared = allowances.find((window) => window.name === configured) ?? null;\n" +
      "  if (declared === null) return tightest;\n",
  },
  {
    // TOG-2692 review round 2 (P1-3): the other direction of the same rule. A
    // declared governor is never stood in for, AND never WIDENS the
    // constraint: a stale `governing_window: "weekly"` must not mask a monthly
    // allowance at 0.99 that resets inside the day.
    name: "honour-a-stale-declared-governor-over-a-tighter-window",
    file: "src/lane-capacity/pace.ts",
    from: "  return tightest !== null && tightest.clearRate! < declared.clearRate! ? tightest : declared;\n",
    to: "  return declared;\n",
  },
  {
    // TOG-2692 review P1: nor may the widest serviceability window stand in for
    // an unresolvable declared governor.
    name: "substitute-serviceability-window-for-a-named-governor",
    file: "src/lane-capacity/pace.ts",
    from: "  if (account.governingWindow !== null) return null;\n",
    to: "",
  },
  {
    // TOG-2692 review P1: an account whose declared governor cannot be resolved
    // has no computable allowance and must not be dispatched to.
    name: "dispatch-to-an-account-with-an-unresolved-governor",
    file: "src/lane-capacity/pace.ts",
    from: "          serviceable: accountServiceable && !indeterminateGovernor,\n",
    to: "          serviceable: accountServiceable,\n",
  },
  {
    // TOG-2692 review P1: an unresolved declared governor is indeterminate at
    // the lane too, not an exhausted lane and not a paced one.
    name: "swallow-an-unresolved-governor-at-the-lane",
    file: "src/lane-capacity/pace.ts",
    from: "  if (internal.some((entry) => entry.indeterminateGovernor)) {\n",
    to: "  if (false && internal.some((entry) => entry.indeterminateGovernor)) {\n",
  },
  {
    // TOG-2692 review P1: a live binding that puts a bare GLM row on the Go
    // quota lane bills Z.ai traffic to Go. The subscription lane wins.
    name: "preserve-a-mis-bound-glm-lane",
    file: "scripts/assemble-additive-config.mjs",
    from:
      "    const laneId = isSubscriptionExclusive(rosterModel)\n" +
      "      ? inferredLaneId\n" +
      "      : (migrateZenFromGo ? null : preservedLaneId) ?? rosterLaneId ?? inferredLaneId;\n",
    to: "    const laneId = (migrateZenFromGo ? null : preservedLaneId) ?? rosterLaneId ?? inferredLaneId;\n",
  },
  {
    // TOG-2692 review P1: the same rule on the live-only path, which no
    // reviewed roster row passes through.
    name: "preserve-a-mis-bound-glm-lane-on-live-only-rows",
    file: "scripts/assemble-additive-config.mjs",
    from:
      "    if (isSubscriptionExclusive(merged)) {\n" +
      "      const exclusiveLaneId = laneForNewModel(merged, availableLaneIds);\n" +
      "      if (exclusiveLaneId) merged.laneId = exclusiveLaneId;\n" +
      "      else delete merged.laneId;\n" +
      "    }\n",
    to: "",
  },
  {
    // TOG-2692: provider capacity is additive across serviceable subscription
    // accounts. Averaging account rates understates the pool target.
    name: "average-account-target-rates",
    file: "src/lane-capacity/pace.ts",
    from:
      "  const targetBurnRate = accounts.reduce((sum, account) =>\n" +
      "    account.serviceable && account.targetBurnRate != null ? sum + account.targetBurnRate : sum,\n" +
      "  0);\n",
    to:
      "  const targetBurnRate = accounts.reduce((sum, account) =>\n" +
      "    account.serviceable && account.targetBurnRate != null ? sum + account.targetBurnRate : sum,\n" +
      "  0) / accounts.length;\n",
  },
  {
    // TOG-2692: one serviceable account in its final 24 hours elevates the
    // provider even when a larger account leaves the weighted aggregate ahead.
    name: "mask-final-24h-push-with-ahead-aggregate",
    file: "src/lane-capacity/pace.ts",
    from: '  if (urgent) state = "behind-urgent";\n',
    to: '  if ((state === "behind" || state === "on") && urgent) state = "behind-urgent";\n',
  },
  {
    // TOG-2692: bare GLM models are the Z.ai subscription route, never Go.
    name: "route-bare-glm-to-go",
    file: "scripts/assemble-additive-config.mjs",
    from: '    [/^glm-/, "cliproxy-zai"],\n',
    to: '    [/^glm-/, "cliproxy-opencode-go"],\n',
  },
  // --- TOG-2692 review round 2 (af17915c) named mutants -------------------
  {
    // P1-1: `indeterminate-account-weight` and
    // `invalid-configured-governing-window` publish `serviceable: null` because
    // the lane's capacity could not be COMPUTED, not because no data arrived.
    // Excluding only `serviceable === false` lets a cheaper indeterminate lane
    // outrank a known-capacity fallback and dispatch off an unknown allowance.
    name: "let-an-indeterminate-lane-dispatch",
    file: "src/engine/pacing.ts",
    from:
      "  if (verdict.serviceable === false) return true;\n" +
      "  return verdict.serviceable === null && INDETERMINATE_CAPACITY_REASONS.has(verdict.reason);\n",
    to: "  return verdict.serviceable === false;\n",
  },
  {
    // P1-1 inverse: the no-data reasons (`document-unavailable`,
    // `snapshot-stale`, `no-records`, `invalid-account-identity`) stay
    // fail-NEUTRAL. Hard-stopping every indeterminate lane takes the fleet off
    // the air the moment a collector snapshot goes missing.
    name: "hard-stop-every-lane-with-no-pace-data",
    file: "src/engine/pacing.ts",
    from: "  return verdict.serviceable === null && INDETERMINATE_CAPACITY_REASONS.has(verdict.reason);\n",
    to: "  return verdict.serviceable === null;\n",
  },
  {
    // P1-3: the final-24h push must scan EVERY allowance window. A window
    // resetting soon with room to spare has a high clear rate, so it is never
    // the binding/governing window — keying the push on the governing window's
    // reset alone makes it unreachable exactly when it is needed.
    name: "key-the-final-24h-push-on-the-governing-window-only",
    file: "src/lane-capacity/pace.ts",
    from:
      "    const windowUrgentResetAt = exhausted\n" +
      "      ? null\n" +
      "      : urgentPushResetAt(windows, asOfMs, marginMilli, urgentResetSeconds);\n",
    to: "    const windowUrgentResetAt = null;\n",
  },
  {
    // P1-3: the published `bindingWindow` must name the window that actually
    // binds. Relabelling it with the account's declared governor hides the
    // substitution from every consumer of the paired decision rows.
    name: "relabel-the-binding-window-with-the-declared-one",
    file: "src/lane-capacity/pace.ts",
    from: "        bindingWindow: binding?.name ?? null,\n",
    to: "        bindingWindow: account.governingWindow ?? binding?.name ?? null,\n",
  },
  {
    // P1-4: `{...live, ...roster}` replaces whole live sections wholesale. A
    // live `selection: {mode, fleetContextCeilingTokens, compactionRatio}` plus
    // a reviewed roster's `selection: {mode: "advise"}` assembles to just
    // `{mode: "advise"}`, and `resolveConfig` silently restores its defaults.
    name: "replace-the-live-selection-object-wholesale",
    file: "scripts/assemble-additive-config.mjs",
    from:
      "  for (const [key, liveSection] of Object.entries(live)) {\n" +
      "    if (EXPLICIT_SECTIONS.has(key)) continue;\n" +
      "    if (!isPlainObject(liveSection) || !isPlainObject(roster[key])) continue;\n" +
      "    assembled[key] = { ...liveSection, ...roster[key] };\n" +
      "  }\n",
    to: "",
  },
  {
    // P1-4 non-vacuity: the section merge is the only thing standing between a
    // roster refresh and a reset live setting, so the assembly must ASSERT the
    // outcome rather than trust the spread order.
    name: "drop-the-dropped-live-settings-assertion",
    file: "scripts/assemble-additive-config.mjs",
    from: "  if (droppedLiveSettings.length > 0) {\n",
    to: "  if (false && droppedLiveSettings.length > 0) {\n",
  },
  {
    // TOG-2692: zero-cost Zen traffic does not debit the Go subscription. The
    // additive assembler must keep those rows on their free lane.
    name: "charge-zen-to-go-lane",
    file: "scripts/assemble-additive-config.mjs",
    from:
      "  if (isZeroCostZenModel(model)) {\n" +
      "    return availableLaneIds.has(\"cliproxy-zen\") ? \"cliproxy-zen\" : null;\n" +
      "  }\n",
    to: "",
  },
  {
    // TOG-2862/2893: the two index-matching UNION branches only reproduce the
    // `coalesce(issueId, taskId)` predicate they replaced while the task
    // branch is guarded. Without it a run stamped with BOTH keys is attributed
    // to two cards, and a card inherits another card's context estimate.
    name: "drop-issueid-precedence-guard",
    file: "src/sql.ts",
    from: "\n            and context_snapshot->>'issueId' is null",
    to: "",
  },
  {
    // TOG-2862: `repinPass` reads the context estimate in `describeIssue` and
    // again inside the `advise()` call it then makes. Dropping the shared
    // per-pass cache restores two unindexed heartbeat_runs reads per
    // re-pinnable candidate — the shape that hit the host's 300 s RPC wall.
    //
    // `balancePass` makes a character-identical call two levels deeper, so the
    // anchor is newline-prefixed: it pins the indentation exactly, and the
    // occurrence check above turns a reindent into BROKEN GATE rather than a
    // mutant that silently moves to the wrong pass.
    name: "drop-repin-context-cache",
    file: "src/worker.ts",
    from: "\n              const result = await advise(company.id, { issueId }, false, undefined, true, contextUsageCache);",
    to: "\n              const result = await advise(company.id, { issueId }, false, undefined, true);",
  },
  // --- TOG-3132 acceptance-criteria named mutants -------------------------
  // One per failure shape the availability term exists to catch. Each is the
  // natural wrong implementation, not a syntactic nonsense edit: every one of
  // them is something a reasonable person would write.
  {
    // AC-1 "down-rank instead of exclude" in its purest form: the gate is
    // computed, recorded, traced — and then not acted on.
    name: "availability-gate-never-consulted",
    file: "src/engine/select.ts",
    from: "    if (!clearsLane(model)) continue;\n",
    to: "",
  },
  {
    // AC-1, measured: this IS the router's `normalizeHealth` bucketing, where
    // "cooldown" is degraded -> `avoid` -> still selectable (TOG-811).
    name: "cooldown-health-merely-down-ranked",
    file: "src/engine/availability.ts",
    from: '  if (health !== "healthy") {',
    to: '  if (health !== "healthy" && health !== "cooldown" && health !== "cooling_down") {',
  },
  {
    // AC-2: the cooldown must be read off the RECORD. Gating it on the
    // presence of windows reproduces the fail-open path exactly — a pure
    // cooldown record carries no utilization, so it yields no evidence.
    name: "cooldown-read-off-windows-not-record",
    file: "src/engine/availability.ts",
    from: "  const cooldown = asRecord(raw.cooldown);",
    to: "  const cooldown = Array.isArray(raw.windows) && raw.windows.length > 0 ? asRecord(raw.cooldown) : null;",
  },
  {
    // AC-3 off-by-one: "a lane with no accounts is ineligible" is trivially
    // true and enforces nothing. The rule is about the LAST account.
    name: "fleet-default-allows-a-single-account",
    file: "src/engine/select.ts",
    from: "lane.serviceableAccountCount <= 1",
    to: "lane.serviceableAccountCount <= 0",
  },
  {
    // AC-3: counting rows rather than serviceable rows. Subtle, and it
    // survives every assertion that does not put a dead account on a live lane.
    name: "count-all-accounts-not-serviceable-ones",
    file: "src/engine/availability.ts",
    from: "    serviceableAccountCount: serviceable.length,",
    to: "    serviceableAccountCount: verdicts.length,",
  },
  {
    // AC-4: 120 minutes is a floor for every consumer, not a number to relax
    // locally when a feed is lagging.
    name: "relax-the-120-minute-staleness-cutoff",
    file: "src/engine/availability.ts",
    from: "  if (ageMs > cutoffMs) {",
    to: "  if (ageMs > cutoffMs * 100) {",
  },
  {
    // AC-4, the quiet pass: UNKNOWN proceeds (correct, by default) but is no
    // longer recorded or said. This is the one `pacing_verdict.py` forbids.
    name: "unknown-passes-silently",
    file: "src/engine/select.ts",
    from: '    if (read.state === "available") return true;',
    to: '    if (read.state !== "unavailable") return true;',
  },
  {
    // AC-1: a model with no laneId read as healthy. The gate then enforces on
    // nothing and looks perfectly green while doing it.
    name: "unmapped-model-read-as-available",
    file: "src/engine/select.ts",
    from: '      return { state: "unknown", term: "unmapped", reason: `${model.id} declares no laneId` };',
    to: '      return { state: "available" };',
  },
  {
    // AC-1: sticky returning before the gate — the pre-TOG-3132 behaviour.
    name: "sticky-skips-the-availability-gate",
    file: "src/engine/select.ts",
    from: "    } else if (incumbent && !clearsLane(incumbent)) {",
    to: "    } else if (false) {",
  },
  {
    // Integration with TOG-2137: a wholly-unserviceable tier reported as
    // `no-eligible-model` sends a capacity outage to the wrong owner.
    name: "availability-exclusion-not-counted-as-capacity",
    file: "src/engine/select.ts",
    from:
      'const CAPACITY_STAGES = new Set(["lane-unserviceable", "lane-availability", "lane-evidence"]);',
    to: 'const CAPACITY_STAGES = new Set(["lane-unserviceable"]);',
  },
  {
    // AC-3, after the TOG-3037 merge. TOG-3037's floor exit tests the floor's
    // lane against the PACE predicates, every one of them gated on
    // `paceActive`. Dropping the availability half restores exactly that
    // pre-merge behaviour: with `pacingMode` unset the floor check then fires
    // on nothing, and a floor whose lane a published contract calls
    // unavailable takes the run anyway.
    name: "floor-exit-ignores-the-availability-term",
    file: "src/engine/select.ts",
    from:
      "          laneOutageExcluded(config.laneOutageOverride ?? null, nowIso, floorModel))) ||\n" +
      "        floorLaneUnavailable);",
    to: "          laneOutageExcluded(config.laneOutageOverride ?? null, nowIso, floorModel))));",
  },
  // --- TOG-3132 AC-2: the WRITER --------------------------------------------
  // Every mutant above this block was green for a week against a state key that
  // nothing wrote. These five are the ones that would have caught that.
  {
    // The defect itself: a producer that emits no records. `select.ts` reads the
    // empty document as unreadable, which with `holdOnUnknownAvailability` off
    // is a quiet pass for every candidate — the gate present and inert.
    name: "availability-writer-emits-nothing",
    file: "src/lane-capacity/availability-source.ts",
    from: "      if (remaining === null) continue;",
    to: "      if (remaining === null) continue;\n      if (true) continue;",
  },
  {
    // AC-4. The document carries one `observedAt` and the reader ages every
    // record from it, so dropping the per-lane lag hands a dead publisher the
    // poll's freshness.
    name: "availability-writer-ignores-lane-lag",
    file: "src/lane-capacity/availability-source.ts",
    from: "  const lagSeconds = Math.max(0, (stampMs - laneObservedAtMs) / 1000);",
    to: "  const lagSeconds = 0;",
  },
  {
    // AC-6. `normalizeHealth` folds `cooldown` into `degraded`; publishing the
    // normalized value still excludes, but `decisions.jsonl` can no longer say
    // a four-minute cooldown apart from a spent five-hour window.
    name: "availability-writer-publishes-normalized-health",
    file: "src/lane-capacity/availability-source.ts",
    from: '  if (published && typeof published.health === "string" && published.health.trim()) {',
    to: "  if (false) {",
  },
  {
    // `ModelEntry.laneId` is the reader's match key. Keying on the publisher's
    // own `provider` string publishes lanes no model matches — an exclusion
    // that applies to nothing, which looks identical to a healthy fleet.
    name: "availability-writer-keys-by-provider",
    file: "src/lane-capacity/availability-source.ts",
    from: "        provider: result.laneId,",
    to: "        provider: (published?.provider as string) ?? result.laneId,",
  },
  {
    // AC-2's cooldown term. The 00:39Z lane published `health: healthy` with
    // real quota headroom; the cooldown was the only true thing about it.
    name: "availability-writer-drops-cooldown",
    file: "src/lane-capacity/availability-source.ts",
    from: "  const cooldown = published?.cooldown;",
    to: "  const cooldown = undefined;",
  },
  // --- TOG-3200 named mutants ---------------------------------------------
  // Each of these three restores one shape that made `classifyIssues` write
  // zero classifications in 36 consecutive runs on 2026-09-17 while 53% of runs
  // and 93.8% of spend sat on T1. All three fail SILENTLY — the job still
  // reports "succeeded" with empty logs — so the suite is the only thing that
  // can tell the difference.
  {
    // The original defect, exactly: skip any card carrying a tier:* label. 120
    // of 126 eligible open cards carried one and 97.1% of those labels were not
    // this plugin's, so this single `continue` starved the job completely.
    name: "skip-any-tier-label-unconditionally",
    file: "src/worker.ts",
    from: "              if (existingLabelTier !== null) {\n                if (!config.classification.reclassifyForeignLabels) continue;\n                if (!isForeignLabel) continue;\n              }",
    to: "              if (existingLabelTier !== null) continue;",
  },
  {
    // Write the new tier label ADDITIVELY instead of replacing the foreign one.
    // The card then carries two tier labels, and `tierFromLabels` resolves that
    // by taking the most capable — so every corrected T1 stays T1 and the whole
    // change is inert while still looking like it ran.
    name: "add-tier-label-without-dropping-foreign",
    file: "src/worker.ts",
    from: "                  ...new Set([...existingLabelIds.filter((id) => !tierLabelIdsOnIssue.has(id)), labelId]),",
    to: "                  ...new Set([...existingLabelIds, labelId]),",
  },
  {
    // Collapse the candidate fetch back onto the write cap. Every label-based
    // skip happens after the row query, so the same top-N rows return every run
    // and row N+1 is never reached — the job goes permanently quiet once the
    // head of the queue is classified.
    name: "fetch-limit-equals-batch-size",
    file: "src/worker.ts",
    from: "            const classifyFetchLimit = Math.min(\n              config.classification.batchSize * CLASSIFY_FETCH_MULTIPLIER,\n              CLASSIFY_FETCH_LIMIT_MAX,\n            );",
    to: "            const classifyFetchLimit = config.classification.batchSize;",
  },
  // --- TOG-3111 named mutants: creation-time pin + unpinnable visibility ----
  // NOTE: the write-path idleness/pin guards are deliberately NOT here. Each
  // is enforced twice — once at the `advise` result (`!result.isIdle`,
  // `result.pinnedModelId !== null`) and again inside
  // `balanceWriteStillSafe`'s fresh re-read — so any single-line mutant of
  // either copy survives the suite. That's defense in depth working as
  // designed, not a coverage gap: what IS mutably load-bearing below is the
  // event wiring, the guards no later re-read duplicates, and the AC3
  // throttle.
  {
    // AC2 exposure-window wiring: driving `pinAtDecisionTime` only from
    // tests (or only from the scheduled passes) left the event path
    // untested. Re-pointing the registration at an event that never fires
    // must fail the issue.created happy path.
    name: "disable-creation-pin-wiring",
    file: "src/worker.ts",
    from: '      ctx.events.on("issue.created", async (event) => {',
    to: '      ctx.events.on("issue.never", async (event) => {',
  },
  {
    // Same wiring exposure for the OTHER creation moment: a card created
    // unassigned then assigned by PATCH never sees issue.created with an
    // assignee (TOG-3008 §3), so only this arm pins it.
    name: "disable-assignment-arm-wiring",
    file: "src/worker.ts",
    from: '            await pinAtDecisionTime(event.companyId, issueId, "issue.updated:assignment");',
    to: "            ;",
  },
  {
    // Agent-to-agent reassignment must stay repinPass territory: a card that
    // already had its creation moment under the previous assignee must not be
    // re-pinned by the event path.
    name: "assignment-arm-fires-on-reassignment",
    file: "src/worker.ts",
    from: "        if (issueId && assignedTo && assignment.from == null) {",
    to: "        if (issueId && assignedTo) {",
  },
  {
    // `issue.created` carries no assignee; classifying (and later pinning)
    // an unassigned card would spend a classifier call per board edit and
    // pin at the wrong moment. The unassigned test observes the classifier
    // call count directly.
    name: "classify-unassigned-card-at-creation",
    file: "src/worker.ts",
    from: "        if (!described.assigneeAgentId) return;",
    to: "        if (false) return;",
  },
  {
    // AC4 residual class: when the router's pick IS the floor model, the
    // creation pin must write nothing (labelOnlyPass/balancePass convention)
    // — only the core-side dispatch gate closes that gap by construction.
    // No later re-read duplicates this check, so the floor-equal test is the
    // sole killer.
    name: "creation-pin-ignores-floor-equal",
    file: "src/worker.ts",
    from:
      "        if (result.pinnedModelId !== null) return;\n" +
      "        const floorModelId = resolveConfiguredModelId(result.agentFloorModelId, config.models);\n" +
      "        if (result.decision.modelId === floorModelId) {",
    to:
      "        if (result.pinnedModelId !== null) return;\n" +
      "        const floorModelId = resolveConfiguredModelId(result.agentFloorModelId, config.models);\n" +
      "        if (false) {",
  },
  {
    // AC3: the notice must fire once per throttle window, not once per
    // 10-minute pass firing — a sustained outage must stay visible without
    // flooding the card's activity feed.
    name: "unpinnable-notice-unthrottled",
    file: "src/worker.ts",
    from: "          if (!Number.isNaN(lastAtMs) && Date.now() - lastAtMs < NO_ELIGIBLE_NOTICE_THROTTLE_MS) return;",
    to: "          if (false) return;",
  },

  // --- TOG-3132 second failure shape: the LANE-EVIDENCE term ----------------
  // The availability term above reads a published quota contract. `devin/*`
  // publishes none and still refused 74 of 74 dispatches, so every mutant in
  // this block is a way the run-outcome term can look present and catch
  // nothing. Each is the natural wrong implementation, not a nonsense edit.
  {
    // The purest inert form: the verdict is computed, recorded, traced — and
    // then not acted on. This is exactly the shape the availability term
    // shipped in for a week against a state key with no writer.
    name: "evidence-gate-never-consulted",
    file: "src/engine/select.ts",
    from: "    if (!clearsEvidence(model)) continue;\n",
    to: "",
  },
  {
    // "Down-rank, don't exclude" applied to a proven-dead lane. AC-1 forbids
    // it: a lane at 0/74 that is merely sorted last is still selected the
    // moment it is the cheapest thing left, which is how it got the traffic.
    name: "proven-dead-does-not-exclude",
    file: "src/engine/lane-evidence.ts",
    from: "  if (upper <= dead) {",
    to: "  if (false) {",
  },
  {
    // The point estimate instead of the confidence bound — the veto the
    // President measured as re-selecting every newly-added lane. Kills
    // `devin/gpt-6-astra` at 0 runs (rate 0 => "dead") and, worse, calls a
    // 1/1 lane proven-good.
    name: "evidence-uses-rate-not-bound",
    file: "src/engine/lane-evidence.ts",
    from: "  if (upper <= dead) {",
    to: "  if ((successRate ?? 0) <= dead) {",
  },
  {
    // A lane with no history reads as available. This is the specific defect:
    // zero runs means zero observed failures, so any rate-shaped test passes it.
    name: "zero-history-lane-treated-as-good",
    file: "src/engine/lane-evidence.ts",
    from: '  if (!snapshot || snapshot.unreadableReason) return "unproven";',
    to: '  if (!snapshot || snapshot.unreadableReason) return "proven-good";',
  },
  {
    // A lane absent from the snapshot fails OPEN. Same class as the
    // `unmapped` hole the availability term has, now on this instrument.
    name: "unmapped-lane-fails-open-on-evidence",
    file: "src/engine/lane-evidence.ts",
    from: '  return snapshot.lanes.find((lane) => lane.laneId === laneId)?.state ?? "unproven";',
    to: '  return snapshot.lanes.find((lane) => lane.laneId === laneId)?.state ?? "proven-good";',
  },
  {
    // The cost-down guard inverted to a no-op: every mutant above can be green
    // while `deepseek-v4-flash` at 0/3 still takes TOG-3088 off haiku, because
    // 0/3 is unproven, not dead. This is the 08:10:14Z move itself.
    name: "cost-down-guard-is-a-no-op",
    file: "src/engine/lane-evidence.ts",
    from: '  return fromState === "proven-good" && toState !== "proven-good";',
    to: "  return false;",
  },
  {
    // The guard over-applied: blocking every cost-down move, not just the ones
    // leaving a proven lane. The positive control that stops this gate from
    // being "freeze all routing" and still reading green.
    name: "cost-down-guard-blocks-everything",
    file: "src/engine/lane-evidence.ts",
    from: '  return fromState === "proven-good" && toState !== "proven-good";',
    to: "  return true;",
  },
  {
    // Sticky returning before the evidence gate — a card wedged on a lane that
    // has never once returned a run, for the sake of a worthless prompt cache.
    name: "sticky-skips-the-evidence-gate",
    file: "src/engine/select.ts",
    from: "    } else if (incumbent && !clearsEvidence(incumbent)) {",
    to: "    } else if (false) {",
  },
  {
    // AC-2, the WRITER. Every mutant above this one stays green when the
    // worker never supplies the term at all — which is a shipped no-op, and
    // the exact defect this card was reopened for.
    name: "lane-evidence-never-supplied-to-select",
    file: "src/worker.ts",
    from: "          laneEvidence: await readLaneEvidence(companyId, config.models, now),\n",
    to: "",
  },
  {
    // The balance-pass half of the writer. `selectModel` excluding a dead lane
    // does NOT stop a cost-down move onto an *unproven* one — that move is
    // made in the worker, and this is the line that refuses it.
    name: "balance-pass-cost-down-guard-removed",
    file: "src/worker.ts",
    from: "                if (cheaper && !incapable && !busier) {",
    to: "                if (false) {",
  },
  {
    // `succeeded` is the success value. `completed` does not exist on this
    // table, so this mutant makes every lane read 0 successes — and every lane
    // proven-dead, which is a fleet-wide outage that reads as a working gate.
    name: "evidence-sql-wrong-success-status",
    file: "src/sql.ts",
    from: "count(*) filter (where status = 'succeeded')::int as succeeded",
    to: "count(*) filter (where status = 'completed')::int as succeeded",
  },
  // --- TOG-3012: a lost pace verdict must not erase an earned exclusion -----
  {
    // The 09-16 incident shape. `hardStopExcluded` read serviceability solely
    // off `verdict`, which `mergeLedgerEntry` degrades to null on every FAILED
    // poll — so a lane measured exhausted became admissible again the moment
    // its poll flapped, and 21 runs launched onto a hard-429ing lane. This
    // mutant restores that fail-open read.
    name: "failed-poll-readmits-exhausted-lane",
    file: "src/engine/pacing.ts",
    from: "  return (entry.unserviceableSince ?? null) !== null;",
    to: "  return false;",
  },
  {
    // The upgrade trap. The lane ledger is persisted opaquely — `readLaneLedger`
    // casts `ctx.state.get(...)` with no schema — so entries written before this
    // field existed survive the upgrade WITHOUT the key, and `undefined !== null`
    // is true. Without the `?? null` narrowing, the first post-deploy poll
    // failure excludes EVERY lane at once and no tier has a candidate anywhere.
    // Shares an anchor with the mutant above; the gate applies each to a
    // freshly-read pristine file, so the exactly-once check still holds.
    name: "undefined-unserviceable-counts-as-observed",
    file: "src/engine/pacing.ts",
    from: "  return (entry.unserviceableSince ?? null) !== null;",
    to: "  return entry.unserviceableSince !== null;",
  },
  {
    // `unserviceableSince` is the ONSET of an outage, not the last time it was
    // re-confirmed. Refreshing it every poll reports every outage as seconds
    // old, which is the number an operator reads to decide whether to act.
    name: "unserviceable-onset-overwritten",
    file: "src/engine/pacing.ts",
    from: "    unserviceableSince = priorSince ?? result.fetchedAt;",
    to: "    unserviceableSince = result.fetchedAt;",
  },
  {
    // The other side of the invariant: stickiness must not OVER-apply. A poll
    // that returned no verdict is evidence of nothing and must not manufacture
    // an unserviceable observation — that would exclude a lane whose polls have
    // merely been failing, which is the original fail-neutral case the
    // "unobserved lane is not evidence of exhaustion" rule exists to protect.
    name: "failed-poll-invents-unserviceable-observation",
    file: "src/engine/pacing.ts",
    from: "  if (observed === null) {\n    unserviceableSince = priorSince;",
    to: "  if (observed === null) {\n    unserviceableSince = priorSince ?? result.fetchedAt;",
  },
  // --- TOG-3045 sub-call surface pins -------------------------------------
  {
    // The whole point of the card: a repin that evacuates the main model off an
    // exhausted lane and leaves the haiku-class sub-calls pointed at it. That
    // is not a degradation — run 6d0c6de7 on TOG-3002 died `acpx_turn_failed`.
    name: "drop-subcall-surface-pins",
    file: "src/engine/context.ts",
    from:
      "      if (isSecretBinding(env[key])) continue;\n" +
      "      env[key] = { type: \"plain\", value: input.model.id };\n",
    to: "      void key;\n",
  },
  {
    // The dangerous half. `assigneeAdapterOverrides.adapterConfig` merges into
    // the run config by SHALLOW top-level spread (mergeModelProfileAdapterConfig,
    // heartbeat.ts:3705-3714), so an issue-level `env` REPLACES the agent's
    // whole env object. Writing only the keys we care about therefore wipes
    // every GH token and secret binding the agent carries, for that run.
    name: "write-only-the-subcall-keys",
    file: "src/engine/context.ts",
    from: "  const env: AdapterEnv = { ...agentEnv, ...carriedOverrideEnv };",
    to: "  const env: AdapterEnv = {};",
  },
  {
    // `agentEnv: null` means the agent row was NOT read (no assignee, or the
    // read threw) — distinct from an agent with no env. Splicing into an
    // unknown base commits exactly the wipe above, because the base we merged
    // was empty for want of knowledge rather than for want of bindings.
    name: "splice-subcalls-into-an-unknown-agent-env",
    file: "src/engine/context.ts",
    from: "  let carriedOverrideEnv: AdapterEnv;\n  if (agentEnvKnown) {",
    to: "  let carriedOverrideEnv: AdapterEnv;\n  if (agentEnvKnown || true) {",
  },
  {
    // A secret-bound surface cannot be read back or reconstructed, so we never
    // clobber one — the same rule `ancillaryDriftForAgent` applies when it
    // refuses to call a secret-bound surface "drifted".
    name: "overwrite-a-secret-bound-subcall-surface",
    file: "src/engine/context.ts",
    from: "      if (isSecretBinding(env[key])) continue;\n",
    to: "",
  },
];

/**
 * TOG-3200. Optional comma-separated name filter, e.g.
 * `MUTANTS=skip-any-tier-label-unconditionally node scripts/mutation-gate.mjs`.
 *
 * The full sweep takes ~25 minutes, and the same sibling sweeper described
 * under `completed()` below kills the RUNNER as readily as it kills one vitest
 * child — when it does, every mutant after the kill point goes unrun. Without a
 * way to resume, the only recovery is another 25-minute roll of the same dice.
 *
 * A filtered run is NOT a passing gate and must never be reported as one, so
 * the summary line below prints the filtered count against the total and says
 * PARTIAL. An unset `MUTANTS` runs everything, exactly as before.
 */
const mutantFilter = (process.env.MUTANTS ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter((name) => name.length > 0);
const selected = mutantFilter.length > 0
  ? mutants.filter((mutant) => mutantFilter.includes(mutant.name))
  : mutants;
if (mutantFilter.length > 0) {
  const unknown = mutantFilter.filter((name) => !mutants.some((mutant) => mutant.name === name));
  if (unknown.length > 0) {
    process.stderr.write(`BROKEN GATE: unknown mutant name(s): ${unknown.join(", ")}\n`);
    process.exit(1);
  }
}

function runTests(cwd = root) {
  const { args, env, timeout, killSignal } = mutationGateVitestInvocation();
  return spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    env,
    // TOG-3129: bound each run individually. Without this one wedged mutant
    // spends the job's whole `timeout-minutes` and the job dies with no mutant
    // name; `completed()` below turns the timeout kill into a BROKEN GATE that
    // says which one.
    timeout,
    killSignal,
  });
}

/**
 * A vitest run that never reached its summary decided nothing. This host runs
 * several agent worktrees at once and a sibling run sweeping stray `vitest`
 * processes SIGKILLs ours mid-flight: `spawnSync` then reports `status: null`,
 * which is `!== 0`, which the loop below would otherwise read as "the mutant
 * was caught". That is a false green on the one gate whose whole job is to
 * prove the suite can catch things, so a run only counts when it printed a
 * summary and exited on its own.
 */
function completed(result) {
  return result.signal === null &&
    result.status !== null &&
    `${result.stdout}`.includes("Test Files");
}

const baseline = runTests();
if (!completed(baseline)) {
  process.stderr.write(`BROKEN GATE: baseline run did not complete (status ${baseline.status}, signal ${baseline.signal})\n`);
  process.stderr.write(baseline.stdout ?? "");
  process.stderr.write(baseline.stderr ?? "");
  process.exit(1);
}
if (baseline.status !== 0) {
  process.stderr.write("BROKEN GATE: baseline suite is red\n");
  process.stderr.write(baseline.stdout);
  process.stderr.write(baseline.stderr);
  process.exit(1);
}

const scratch = await mkdtemp(join(tmpdir(), "model-selection-mutants-"));
const mutationRoot = join(scratch, "plugins", "model-selection");
let failures = 0;
let brokenGate = false;
try {
  await copyMutationTree(root, mutationRoot);
  await stageRepoFixtures(repoRoot, scratch);

  // Positive control (TOG-2980). The loop below scores EVERY nonzero exit as a
  // kill, so a suite that cannot run from the copy at all reports a clean sweep
  // while proving nothing — which is exactly what shipped: a spec reading
  // ../../../.github/workflows/ci.yml threw ENOENT here, and `18/18 killed`
  // was measuring that, not the mutations. The green baseline above ran in the
  // SOURCE tree and could not see it.
  //
  // Re-run the UNMUTATED suite from mutationRoot, after the fixtures are staged
  // and before the first mutant is applied. Every kill below is only meaningful
  // relative to this being green. Keep it permanently: it is what turns a new
  // out-of-copy dependency into a failure instead of a false sweep.
  const isolatedBaseline = runTests(mutationRoot);
  if (isolatedBaseline.status !== 0) {
    process.stderr.write(
      "BROKEN GATE: the unmutated suite is red from the mutation copy, so every mutant would score as killed.\n" +
        "A spec most likely reads a repo file outside the plugin; stage it in MUTATION_TREE_REPO_FIXTURES.\n",
    );
    process.stderr.write(isolatedBaseline.stdout ?? "");
    process.stderr.write(isolatedBaseline.stderr ?? "");
    brokenGate = true;
  }

  if (!brokenGate) {
    await runSequentially(selected, async (mutant) => {
      const path = join(mutationRoot, mutant.file);
      const original = await readFile(path, "utf8");
      const occurrences = original.split(mutant.from).length - 1;
      if (occurrences !== 1) {
        console.error(`BROKEN GATE: ${mutant.name} matched ${occurrences} times in ${mutant.file}`);
        failures += 1;
        return;
      }

      let result;
      try {
        await writeFile(path, original.replace(mutant.from, mutant.to));
        result = runTests(mutationRoot);
      } finally {
        await writeFile(path, original);
      }

      if (!completed(result)) {
        console.error(`BROKEN GATE: ${mutant.name} run did not complete (status ${result.status}, signal ${result.signal})`);
        failures += 1;
      } else if (result.status === 0) {
        console.error(`SURVIVED: ${mutant.name}`);
        failures += 1;
      } else {
        console.log(`KILLED: ${mutant.name}`);
      }
    });
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

if (brokenGate || failures > 0) process.exit(1);
if (selected.length !== mutants.length) {
  console.log(`mutation gate PARTIAL: ${selected.length}/${mutants.length} mutants run, all killed — NOT a passing gate`);
  process.exit(0);
}
console.log(`mutation gate: ${mutants.length}/${mutants.length} killed`);
