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
  parseMutationShard,
  runSequentially,
  selectMutationShard,
  stageRepoFixtures,
} from "./mutation-gate-runtime.mjs";

if (!mutationGateAllowed()) {
  process.stderr.write(`${MUTATION_GATE_CI_MESSAGE}\n`);
  process.exit(2);
}

const root = resolve(new URL("..", import.meta.url).pathname);
const repoRoot = resolve(root, "../..");

const mutants = [
  {
    name: "lane-avoid-restores-raw-utilization-only",
    file: "src/engine/pacing.ts",
    from: "  return score.utilization >= avoidThresholdFor(config, model.laneId) && score.deviation > DEFAULT_MARGIN;",
    to: "  return score.utilization >= avoidThresholdFor(config, model.laneId);",
  },
  {
    name: "lane-avoid-inclusive-margin-boundary",
    file: "src/engine/pacing.ts",
    from: "score.deviation > DEFAULT_MARGIN;",
    to: "score.deviation >= DEFAULT_MARGIN;",
  },
  // lane withdrawal ceiling. The rule withdraws a lane from NEW
  // dispatch once its combined utilization reaches a configured ceiling; each
  // mutant breaks one property the replay and unit specs pin.
  {
    // A reading exactly at the ceiling must withdraw (the bridge's rule is
    // "at or above"). Killed by the boundary test through float drift.
    name: "lane-withdrawal-ceiling-exclusive-boundary",
    file: "src/engine/pacing.ts",
    from: "  return Math.round(value * 1_000_000) >= Math.round(ceiling * 1_000_000);",
    to: "  return Math.round(value * 1_000_000) > Math.round(ceiling * 1_000_000);",
  },
  {
    // An unserviceable account counted at its 0.99 trip reading instead of as
    // fully spent: the plain mean of the 21:48Z lane is 0.9725 and never
    // reaches 0.98. Killed by the combined-utilization spec and the replay.
    name: "lane-withdrawal-unserviceable-account-not-counted-spent",
    file: "src/engine/pacing.ts",
    from: "      utilization: account.serviceable ? Math.min(1, Math.max(0, utilization)) : 1,",
    to: "      utilization: Math.min(1, Math.max(0, utilization)),",
  },
  {
    // A reading outlives the window it measured, so a lane stays withdrawn
    // through its own reset. Killed by the reset-boundary specs.
    name: "lane-withdrawal-reading-ignores-window-reset",
    file: "src/engine/pacing.ts",
    from: "  if (reading.resetsAt !== null && Date.parse(reading.resetsAt) <= nowMs) return null;",
    to: "",
  },
  {
    // A failed poll erases the reading, so a flapping poll readmits a
    // withdrawn lane (the  failure shape). Killed by the failed-poll
    // retention specs.
    name: "lane-withdrawal-reading-dropped-on-failed-poll",
    file: "src/engine/pacing.ts",
    from: "    previous?.combinedUtilization ??\n",
    to: "",
  },
  {
    // A ceiling of 0 (or below) withdraws every lane on every reading.
    name: "lane-withdrawal-nonpositive-ceiling-withdraws-everything",
    file: "src/engine/pacing.ts",
    from: "!Number.isFinite(ceiling) || ceiling <= 0) return null;",
    to: "!Number.isFinite(ceiling)) return null;",
  },
  {
    // The selector never consults the withdrawal: the 0% agreement the card
    // was filed for. Killed by the select specs and the replay.
    name: "lane-withdrawal-select-ignores-withdrawal",
    file: "src/engine/select.ts",
    from: "    if (withdrawal) {",
    to: "    if (false && withdrawal) {",
  },
  {
    // A tier whose every lane sits at its ceiling reads as a config gap, not
    // a capacity outage, so nobody is told. Killed by the tier-exhausted spec.
    name: "lane-withdrawal-not-a-capacity-stage",
    file: "src/engine/select.ts",
    from: '"lane-evidence", "lane-withdrawn"]);',
    to: '"lane-evidence"]);',
  },
  {
    // The sub-call env evacuation ignores a withdrawn lane, so a card keeps
    // its env on a lane no longer sent new work. Killed by the context spec
    // and the worker balancePass spec.
    name: "lane-withdrawal-env-evacuation-ignores-withdrawal",
    file: "src/engine/context.ts",
    from: "    if (laneWithdrawnExcluded(input.ledger, model, input.laneAvoidConfig, Date.parse(input.nowIso))) return true;\n",
    to: "",
  },
  {
    name: "lane-withdrawal-cheapest-healthy-ignores-withdrawal",
    file: "src/engine/context.ts",
    from: "    if (laneWithdrawnExcluded(input.ledger, model, input.laneAvoidConfig, Date.parse(input.nowIso))) return false;\n",
    to: "",
  },
  {
    // The agent-floor exit ignores a withdrawn floor lane, so a thin-profile
    // card holds at a floor on the lane the ceiling just closed and writes no
    // pin (the  shape, for withdrawal). Killed by the floor spec.
    name: "lane-withdrawal-floor-hold-ignores-withdrawal",
    file: "src/engine/select.ts",
    from: "          (!!config.laneAvoidConfig && laneWithdrawnExcluded(ledger, floorModel, config.laneAvoidConfig, now)) ||\n",
    to: "",
  },
  {
    // The repin pass's usability gate ignores a withdrawn lane, so a fresh pin
    // on it rides the early return and an idle card never leaves the lane.
    // Killed by the repinPass withdrawal spec.
    name: "lane-withdrawal-repin-usability-ignores-withdrawal",
    file: "src/worker.ts",
    from: "        if (laneWithdrawnExcluded(laneLedger, model, config.pacing.avoid, Date.parse(nowIso))) return false;\n",
    to: "",
  },
  // counts-only is a validated producer schema, and cooldowns are
  // exact-model evidence whose expiry is checked at selection time.
  {
    name: "counts-only-inferred-without-tag",
    file: "src/lane-capacity/counts-only.ts",
    from: '  if (raw.observationQuality !== "counts-only") return null;',
    to: '  if (false && raw.observationQuality !== "counts-only") return null;',
  },
  {
    name: "model-cooldown-widens-to-siblings",
    file: "src/lane-capacity/counts-only.ts",
    from: '(entry.model === null || entry.model === modelId)',
    to: '(entry.model === null || typeof entry.model === "string")',
  },
  {
    name: "model-cooldown-expiry-equality-still-blocks",
    file: "src/lane-capacity/counts-only.ts",
    from: 'Date.parse(entry.retry_at) > nowMs',
    to: 'Date.parse(entry.retry_at) >= nowMs',
  },
  {
    name: "transient-error-cooldown-excludes",
    file: "src/lane-capacity/counts-only.ts",
    from: 'entry.reason !== "transient_error" &&',
    to: 'true &&',
  },
  //  / : the serviceability stop is count-gated — the lane is
  // condemned only when a trip exists AND no account can still serve. A healthy
  // peer carries the lane, but an indeterminate peer must not mask the trip,
  // and the tripped account itself stays excluded (account verdicts agree).
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
    // restores the pre-fix defect — ANY trip condemns the lane even
    // with a healthy sibling serving. Killed by the healthy-peer-carries test
    // (lane level) and the  dispatch-level regression.
    name: "serviceability-any-trip-poisons-lane",
    file: "src/lane-capacity/pace.ts",
    from: "  if (internal.some((entry) => entry.tripped) && serviceableAccountCount === 0) {",
    to: "  if (internal.some((entry) => entry.tripped)) {",
  },
  {
    // off-by-one on the count — condemns while one account can still
    // serve. Killed by the same sibling-serve tests; the all-tripped tests
    // still pass under it (count 0 condemns either way), so its killer set is
    // disjoint from the remove-lane-hard-stop mutant below.
    name: "serviceability-count-off-by-one-condemns-with-a-healthy-peer",
    file: "src/lane-capacity/pace.ts",
    from: "  if (internal.some((entry) => entry.tripped) && serviceableAccountCount === 0) {",
    to: "  if (internal.some((entry) => entry.tripped) && serviceableAccountCount <= 1) {",
  },
  {
    // an indeterminate peer must not mask the trip via the count.
    // Counting every account as serviceable re-opens the lane whenever the
    // peer is merely unknown. Killed by the indeterminate-peer tests.
    name: "serviceability-indeterminate-account-counts-as-serviceable",
    file: "src/lane-capacity/pace.ts",
    from: "  const serviceableAccountCount = internal.filter((entry) => entry.verdict.serviceable).length;",
    to: "  const serviceableAccountCount = internal.length;",
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
    // removes the count-gated hard stop entirely. The all-tripped
    // lane then falls through to `all-accounts-unserviceable` (no reset), so
    // the all-tripped and opencode-go-monthly tests (reason + earliest reset)
    // kill it.
    name: "serviceability-remove-lane-hard-stop",
    file: "src/lane-capacity/pace.ts",
    from: "  if (internal.some((entry) => entry.tripped) && serviceableAccountCount === 0) {",
    to: "  if (false) {",
  },
  {
    name: "old-inverted-tier-order",
    file: "src/constants.ts",
    from: 'export const TIER_ORDER: readonly Tier[] = ["T3", "T2", "T1", "T0"];',
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
  // ---  acceptance-criteria named mutants -------------------------
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
    // "halve the recency-decay window" —  code review (PR277): the
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
    //  QA finding (PR #278 review): disabling the worker.ts
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
  // ---  named mutants: wasted dispatch-sweep wakes -----------------
  {
    // "remove monitor-armed check" — : a card with its own future
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
    // "remove human-ask park check" — /2455/1677: a pending
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
    // a one-sided stream must not pass merely because the existing
    // plugin-shadow emitter still writes a schema-valid record. Removing the
    // host projection must fail the worker-level paired-stream assertion.
    name: "drop-host-projection-from-decision-pair",
    file: "src/worker.ts",
    from: "          await emitDecisionPair(companyId, [buildHostRecord(recordInput), buildShadowRecord(recordInput)]);",
    to: "          await emitDecisionPair(companyId, [buildShadowRecord(recordInput)]);",
  },
  // ---  named mutants: five-benchmark prior and derived tiers ------
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
    // advise() and reads the chosen model can kill this. Same gap 
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
    // the legacy policy is pinned to the SERVING build, whose T1
    // capability bar is 0.8 (the operator's t1baseline carry-forward), not to the
    // 0.85 tier cut. Reverting it re-introduces the source/serving split the
    // zero-diff replay exists to catch.
    name: "t1-capability-bar-reverts-to-tier-cut",
    file: "src/engine/tier-policy.ts",
    from: '    legacyTier("T1", "T1", 2, T1_CAPABILITY_THRESHOLD),',
    to: '    legacyTier("T1", "T1", 2, SCORE_THRESHOLDS.T1),',
  },
  {
    // The veto margin is an evaluator constant, not policy data. Widening it
    // lets a proven-bad model keep its capable verdict.
    name: "legacy-veto-margin-widened",
    file: "src/engine/tier-policy.ts",
    from: "  vetoMargin: 0.1,",
    to: "  vetoMargin: 0.15,",
  },
  {
    // A numeric rule over the free list has no published index version, so it
    // is never enforced as written. Reporting it "enforced" would show an
    // operator a raw index cut that the router does not apply.
    name: "version-unknown-rule-reported-enforced",
    file: "src/engine/tier-policy.ts",
    from: '  return "not-enforced-version-unknown";',
    to: '  return "enforced";',
  },
  {
    // An edit may not strip an S-tier's flag. Relaxing an S-tier needs a
    // recorded CEO decision, never a quiet policy edit.
    name: "s-tier-flag-drop-allowed",
    file: "src/engine/tier-policy.ts",
    from: "    if (!after.sTier) push(",
    to: "    if (false && !after.sTier) push(",
  },
  {
    // No unversioned cross-index comparisons: "latest" and "unknown" are not
    // versions.
    name: "unversioned-metric-accepted",
    file: "src/engine/tier-policy.ts",
    from: 'const UNVERSIONED = new Set(["", "latest", "unknown"]);',
    to: 'const UNVERSIONED = new Set([""]);',
  },
  {
    // Two tiers with the same cut overlap: the upper one can never be labelled.
    name: "legacy-ladder-allows-equal-cuts",
    file: "src/engine/tier-policy.ts",
    from: "    if (!(upper.legacy?.scoreThreshold > lower.legacy?.scoreThreshold)) {",
    to: "    if (!(upper.legacy?.scoreThreshold >= lower.legacy?.scoreThreshold)) {",
  },
  // the `model_selection_tier_policy` edit path. Each guard below is
  // one  D3/D4/D6 refusal; killed by tests/tier-policy/tier-policy-edit.spec.ts
  // (and, for the worker log, tests/tool-error-shape-part2.spec.ts).
  {
    // D4 compare-and-set: a proposal against a stale revision is a lost update.
    name: "tier-policy-edit-skips-revision-cas",
    file: "src/engine/tier-policy-edit.ts",
    from: "  if (request.expectedRevision !== undefined && baseRevision !== null && request.expectedRevision !== baseRevision) {",
    to: "  if (false) {",
  },
  {
    // A mutating action with no expectedRevision cannot be compare-and-set at all.
    name: "tier-policy-edit-expected-revision-optional",
    file: "src/engine/tier-policy-edit.ts",
    from: "    if (request.expectedRevision === undefined) {",
    to: "    if (false) {",
  },
  {
    // D3: every mutation carries a reason for the audit record.
    name: "tier-policy-edit-reason-optional",
    file: "src/engine/tier-policy-edit.ts",
    from: "    if (reason === null) issues.push(",
    to: "    if (false) issues.push(",
  },
  {
    // Removing the default tier leaves the router with no tier to fall back to.
    name: "tier-policy-edit-removes-default-tier",
    file: "src/engine/tier-policy-edit.ts",
    from: "  if (base.defaultTierId === tierId) {",
    to: "  if (false) {",
  },
  {
    // Removing a tier a task class still names leaves a dangling reference.
    name: "tier-policy-edit-removes-referenced-tier",
    file: "src/engine/tier-policy-edit.ts",
    from: "  if (referencing.length > 0) {",
    to: "  if (false) {",
  },
  {
    // A tier id is the key every label, pin and ref uses; an edit may only rename.
    name: "tier-policy-edit-allows-id-change",
    file: "src/engine/tier-policy-edit.ts",
    from: '    if (key === "id") {\n      issues.push({ path: "patch.id", code: "immutable-id", message: "a tier id never changes; rename with patch.name" });\n    } else if (!(EDITABLE_TIER_FIELDS as readonly string[]).includes(key)) {',
    to: '    if (false) {\n      issues.push({ path: "patch.id", code: "immutable-id", message: "a tier id never changes; rename with patch.name" });\n    } else if (key !== "id" && !(EDITABLE_TIER_FIELDS as readonly string[]).includes(key)) {',
  },
  {
    // A partial legacy patch must merge; replacing it wholesale silently drops
    // the capability bar the caller did not mention.
    name: "tier-policy-edit-replaces-legacy-wholesale",
    file: "src/engine/tier-policy-edit.ts",
    from: "    next[key] = MERGED_TIER_FIELDS.has(key) && isPlainObject(value)",
    to: "    next[key] = false && isPlainObject(value)",
  },
  {
    // Without `previous`, an edit could drop an S-tier flag or lower its bar.
    name: "tier-policy-edit-validates-without-previous",
    file: "src/engine/tier-policy-edit.ts",
    from: "  const issues = validateTierPolicy(proposed, { previous: base });",
    to: "  const issues = validateTierPolicy(proposed);",
  },
  {
    // A supplied base that already cleared an S-tier flag launders the
    // relaxation unless the built-in active policy is checked too.
    name: "tier-policy-edit-trusts-supplied-base-s-tier",
    file: "src/engine/tier-policy-edit.ts",
    from: "  if (!baseIsActive) {",
    to: "  if (false) {",
  },
  {
    // D4: with no proven CAS persistence path the outcome is never "accepted".
    name: "tier-policy-edit-reports-accepted",
    file: "src/engine/tier-policy-edit.ts",
    from: '    outcome: ok ? "proposalOnly" : "rejected",',
    to: '    outcome: ok ? "accepted" : "rejected",',
  },
  {
    name: "tier-policy-edit-reports-persisted",
    file: "src/engine/tier-policy-edit.ts",
    from: "    persisted: false,",
    to: "    persisted: ok,",
  },
  {
    // The reason is free text from the caller; it belongs in `data`, not the plugin log.
    name: "tier-policy-tool-logs-reason",
    file: "src/worker.ts",
    from: "            changedPaths: result.diff.length,",
    to: "            changedPaths: result.diff.length,\n            reason: result.reason,",
  },
  {
    // The no-stats branch is the capability GATE, not the tier cut. Reading the
    // cut here moves T1 from 0.8 to 0.85 for every model with no T1 history.
    name: "no-stats-capability-reads-tier-cut",
    file: "src/engine/scores.ts",
    from: "          capable: pp >= capabilityThresholds[tier],",
    to: "          capable: pp >= scoreThresholds[tier],",
  },
  {
    // Same split on the stats branch.
    name: "summarize-capability-reads-tier-cut",
    file: "src/engine/scores.ts",
    from: "      ? summarize(stats, tier, pp, capability.priorK, capability.provenN, capabilityThresholds, capability.vetoMargin)",
    to: "      ? summarize(stats, tier, pp, capability.priorK, capability.provenN, scoreThresholds, capability.vetoMargin)",
  },
  {
    // an exhausted account with utilization 1 must not dilute a
    // serviceable account at 0.02 into a fake lane utilization of 0.51.
    name: "blend-exhausted-accounts-into-lane-pace",
    file: "src/lane-capacity/pace.ts",
    from:
      "    entry.verdict.serviceable &&\n" +
      "    entry.utilizationMilli !== null &&\n",
    to: "    entry.utilizationMilli !== null &&\n",
  },
  {
    // the paired decision stream must retain account-level posture;
    // lane-only rows cannot explain which accounts were excluded from pace.
    name: "drop-account-rows-from-decision-log",
    file: "src/shadow-emit.ts",
    from: "      accounts: accountSnapshots(verdict),\n",
    to: "      accounts: [],\n",
  },
  {
    // `explanations` must name the gate that rejected each
    // candidate — this failure is silent in production (the job still
    // reports `succeeded`), so only the suite can distinguish an empty
    // explanations array from a populated one.
    name: "empty-the-explanations-array",
    file: "src/shadow-emit.ts",
    from: "    explanations: decision.rejections.slice(0, SHADOW_EXPLANATIONS_CAP).map((rejection) => ({\n      modelId: rejection.modelId,\n      gate: rejection.stage,\n      operand: rejection.operand,\n    })),\n",
    to: "    explanations: [],\n",
  },
  {
    // a Go account at 0.99 monthly must bind on monthly even when its
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
    // the per-lane `weekly`/`fiveHour` columns must each read their
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
    // an unobserved window must report `null`, never `0`. Reusing
    // pacing.ts's fail-neutral-to-0 gate helper here would render "the 5-hour
    // window is untouched" for a window nobody measured.
    name: "fail-neutral-lane-window-columns-to-zero",
    file: "src/shadow-emit.ts",
    from: "  return utilizations.length > 0 ? Math.max(...utilizations) : null;\n",
    to: "  return utilizations.length > 0 ? Math.max(...utilizations) : 0;\n",
  },
  {
    // final-24h accounts must enter the hard priority tier; leaving
    // them at priority zero loses the explicit reset-clearing behavior.
    name: "remove-final-24h-account-priority",
    file: "src/shadow-emit.ts",
    from: '  return account.state === "push" ? 100 : 0;\n',
    to: "  return 0;\n",
  },
  {
    // a weekly-only governor would reproduce the current defect on
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
    // production collector rows report plan_weight. Dropping it from
    // the default turns Max 20x and Max 5x into equal-capacity accounts.
    name: "drop-plan-weight-from-default-fields",
    file: "src/constants.ts",
    from: 'export const DEFAULT_PACE_WEIGHT_FIELDS = ["plan_weight", "weight"] as const;\n',
    to: 'export const DEFAULT_PACE_WEIGHT_FIELDS = ["weight"] as const;\n',
  },
  {
    // unknown production capacity is indeterminate, never an
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
    // a window with no account or allowance weight must remain
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
    //  review round 2 (P1-2): a window that REPORTS `allowance_weight`
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
    // equal logical-account round-robin strands allowance at the
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
    // stable logical-account identity is part of the collector
    // contract. Missing ids must invalidate the document, never use position.
    name: "synthesize-missing-account-id-from-position",
    file: "src/lane-capacity/pace.ts",
    from: "  const accountKeys = validRecords.map((record) => accountKey(record, accountKeyFields));\n",
    to: "  const accountKeys = validRecords.map((record, index) => accountKey(record, accountKeyFields) ?? `record-${index + 1}`);\n",
  },
  {
    // subscription-pool owns the Go account decision. Replacing its
    // reported target with a locally recomputed window rate must fail.
    name: "ignore-reported-account-target-rate",
    file: "src/lane-capacity/pace.ts",
    from: "    const effectiveTargetBurnRate = reportedTargetBurnRate ?? governing.clearRate;\n",
    to: "    const effectiveTargetBurnRate = governing.clearRate;\n",
  },
  {
    //  review round 2 (P1-3): a reported decision is only about the
    // window the account DECLARED. Once a tighter allowance governs, honouring
    // the stale `target_burn_rate`/`deficit`/`recommended_share`/
    // `governing_reset_at` paces the account off the window it is no longer on.
    name: "honour-a-stale-reported-decision-under-a-tighter-governor",
    file: "src/lane-capacity/pace.ts",
    from: "    const declaredGoverns = account.governingWindow !== null && governing.name === account.governingWindow;\n",
    to: "    const declaredGoverns = account.governingWindow !== null;\n",
  },
  {
    // reported subscription-pool share is authoritative. Falling
    // through to locally recomputed deficits restores a competing selector.
    name: "ignore-reported-account-share",
    file: "src/lane-capacity/pace.ts",
    from:
      "  const useReportedShares = shareCandidates.length > 0 &&\n" +
      "    shareCandidates.every((entry) => entry.verdict.recommendedShare != null);\n",
    to: "  const useReportedShares = false;\n",
  },
  {
    //  review P1: reported shares are a distribution over the pool and
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
    //  review P1: a share basis chosen per-account rather than per-lane
    // starves every account that does not report a share.
    name: "mix-reported-and-fallback-share-bases",
    file: "src/lane-capacity/pace.ts",
    from: "    shareCandidates.every((entry) => entry.verdict.recommendedShare != null);\n",
    to: "    shareCandidates.some((entry) => entry.verdict.recommendedShare != null);\n",
  },
  {
    //  review P1: a declared governing window is authoritative.
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
    //  review round 2 (P1-3): the other direction of the same rule. A
    // declared governor is never stood in for, AND never WIDENS the
    // constraint: a stale `governing_window: "weekly"` must not mask a monthly
    // allowance at 0.99 that resets inside the day.
    name: "honour-a-stale-declared-governor-over-a-tighter-window",
    file: "src/lane-capacity/pace.ts",
    from: "  return tightest !== null && tightest.clearRate! < declared.clearRate! ? tightest : declared;\n",
    to: "  return declared;\n",
  },
  {
    //  review P1: nor may the widest serviceability window stand in for
    // an unresolvable declared governor.
    name: "substitute-serviceability-window-for-a-named-governor",
    file: "src/lane-capacity/pace.ts",
    from: "  if (account.governingWindow !== null) return null;\n",
    to: "",
  },
  {
    //  review P1: an account whose declared governor cannot be resolved
    // has no computable allowance and must not be dispatched to.
    name: "dispatch-to-an-account-with-an-unresolved-governor",
    file: "src/lane-capacity/pace.ts",
    from: "          serviceable: accountServiceable && !indeterminateGovernor,\n",
    to: "          serviceable: accountServiceable,\n",
  },
  {
    //  review P1: an unresolved declared governor is indeterminate at
    // the lane too, not an exhausted lane and not a paced one.
    name: "swallow-an-unresolved-governor-at-the-lane",
    file: "src/lane-capacity/pace.ts",
    from: "  if (internal.some((entry) => entry.indeterminateGovernor)) {\n",
    to: "  if (false && internal.some((entry) => entry.indeterminateGovernor)) {\n",
  },
  {
    //  review P1: a live binding that puts a bare GLM row on the Go
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
    //  review P1: the same rule on the live-only path, which no
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
    // provider capacity is additive across serviceable subscription
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
    // one serviceable account in its final 24 hours elevates the
    // provider even when a larger account leaves the weighted aggregate ahead.
    name: "mask-final-24h-push-with-ahead-aggregate",
    file: "src/lane-capacity/pace.ts",
    from: '  if (urgent) state = "behind-urgent";\n',
    to: '  if ((state === "behind" || state === "on") && urgent) state = "behind-urgent";\n',
  },
  {
    // bare GLM models are the Z.ai subscription route, never Go.
    name: "route-bare-glm-to-go",
    file: "scripts/assemble-additive-config.mjs",
    from: '    [/^glm-/, "cliproxy-zai"],\n',
    to: '    [/^glm-/, "cliproxy-opencode-go"],\n',
  },
  // ---  review round 2 (af17915c) named mutants -------------------
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
    // zero-cost Zen traffic does not debit the Go subscription. The
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
    // /2893: the two index-matching UNION branches only reproduce the
    // `coalesce(issueId, taskId)` predicate they replaced while the task
    // branch is guarded. Without it a run stamped with BOTH keys is attributed
    // to two cards, and a card inherits another card's context estimate.
    name: "drop-issueid-precedence-guard",
    file: "src/sql.ts",
    // the creation pin's live-runs lookup reuses this exact
    // guarded shape, so the bare guard line now matches twice. Anchor on the
    // trailing `finished_at is not null`, which only the context-lookup query
    // has after it — the mutant still drops exactly the precedence guard.
    from:
      "\n            and context_snapshot->>'issueId' is null\n" +
      "            and finished_at is not null",
    to: "\n            and finished_at is not null",
  },
  {
    // `repinPass` reads the context estimate in `describeIssue` and
    // again inside the `advise()` call it then makes. Dropping the shared
    // per-pass cache restores two unindexed heartbeat_runs reads per
    // re-pinnable candidate — the shape that hit the host's 300 s RPC wall.
    //
    // Keep the effective-tier argument intact: this mutant only removes
    // the context cache, not the repin tier-safety guard. : the
    // converted repin row body carries 16-space indentation (was 14 on the
    // #457 base); dropping the cache argument still restores the double-read
    // shape, killed by the "reads the heartbeat context at most once per
    // re-pinnable candidate" test in tests/scheduled-passes.spec.ts.
    name: "drop-repin-context-cache",
    file: "src/worker.ts",
    from: "\n                const result = await advise(company.id, { issueId }, false, tier, true, contextUsageCache);",
    to: "\n                const result = await advise(company.id, { issueId }, false, tier, true);",
  },
  {
    // a dead pin must not lose its recorded tier during selection.
    // the repin body is a row callback, one indent deeper.
    name: "repin-drops-effective-tier",
    file: "src/worker.ts",
    from: "\n                const result = await advise(company.id, { issueId }, false, tier, true, contextUsageCache);",
    to: "\n                const result = await advise(company.id, { issueId }, false, undefined, true, contextUsageCache);",
  },
  {
    // a regular candidate at a stronger rung preempts fallback.
    name: "fallback-preempts-stronger-regular",
    file: "src/engine/select.ts",
    from: "const selectionPool = regularModels.length > 0 ? regularModels : qualified;",
    to: "const selectionPool = qualified;",
  },
  {
    // fresh pins still have to satisfy the effective requirement.
    // 8-space indentation on the #457 base is unchanged here.
    name: "repin-keeps-fresh-weaker-pin",
    file: "src/worker.ts",
    from: "if (!model || tierIndex(model.tier) < tierIndex(tier)) return false;",
    to: "if (!model) return false;"
  },
  {
    // the recovery opener is dropped, so a fresh fallback pin
    // rides the usability `continue` forever after its normal lane heals.
    // Killed by the recovery test in tests/repin-fallback-recovery.spec.ts
    // (verified by hand: 2 failures with the opener removed).
    name: "repin-holds-recovered-fallback",
    file: "src/worker.ts",
    from: "                !hasRecoveredNormal &&\n",
    to: "",
  },
  {
    // recovery may move sideways to another fallback-only row —
    // churn that buys no recovery. Killed by the never-sideways test in
    // tests/repin-fallback-recovery.spec.ts (verified by hand: 2 failures
    // with the guard removed).
    name: "repin-moves-fallback-sideways",
    file: "src/worker.ts",
    from:
      "                // recovery moves back to a normal lane, never\n" +
      "                // sideways to another fallback-only row — that churn buys no\n" +
      "                // recovery. Re-stamp an expired pin so the sideways case does\n" +
      "                // not re-pay advise on every pass, mirroring the same-model\n" +
      "                // branch above.\n" +
      "                if (pinnedIsFallbackOnly && selectedModel.fallbackOnly) {\n" +
      "                  if (pinExpired) {\n" +
      "                    if (repinDeadlineAt !== null && Date.now() >= repinDeadlineAt) return \"unsettled\";\n" +
      "                    await recordPinTimestamp(company.id, issueId, nowIso);\n" +
      "                  }\n" +
      "                  return \"settled\";\n" +
      "                }\n",
    to: "",
  },
  // ---  named mutants: pin lifecycle in the repin pass -------------
  // One per lifecycle behavior. Each is the natural wrong implementation, and
  // each is killed by the  tests in tests/scheduled-passes.spec.ts
  // (worker half) or tests/context.spec.ts (env-rewrite half) — verified
  // locally by applying each mutant and watching the named test fail.
  {
    // (a) clear-on-blocked removed: a blocked card's healthy pin survives via
    // the usability `continue`, re-pinning a card that cannot run and burning
    // one of the 6 writes/run on a lane reservation nobody needs.
    name: "repin-keeps-blocked-pin",
    file: "src/worker.ts",
    from: '              if (described.status === "blocked") {',
    to: '              if (false) { // MUTANT repin-keeps-blocked-pin',
  },
  {
    // (a) clears bypass the write budget: with no increment the limit break
    // never fires and one pass can clear the whole board.
    // the clear block is a row callback — it returns "stop" at
    // the write cap instead of `continue`-ing past it. Re-anchored
    //  to the gated increment: in advisory mode the clear itself is
    // skipped, so the budget counts actual writes. The anchor removes only
    // the write-budget increment.
    name: "pin-clear-bypasses-write-limit",
    file: "src/worker.ts",
    from:
      "                  if (writesAllowed) repinned += 1;\n" +
      '                  return repinned >= REPIN_PASS_WRITE_LIMIT ? "stop" : "settled";\n' +
      "                }",
    to:
      '                  return repinned >= REPIN_PASS_WRITE_LIMIT ? "stop" : "settled";\n' +
      "                }",
  },
  {
    // (b) expiry never fires: stale pins ride the usability `continue`
    // forever, and the 73/92 stale pins from the 2026-09-27 census stay put.
    name: "pin-expiry-never-fires",
    file: "src/worker.ts",
    from: "              const pinExpired = isPinExpired(pinPinnedAt, issueId, nowMs);",
    to: "              const pinExpired = false;",
  },
  {
    // (b) the reverse: every pin re-validates every pass, so a healthy fresh
    // pin churns through advise (and moves whenever a cheaper candidate
    // exists) instead of holding still.
    name: "pin-expiry-always-fires",
    file: "src/worker.ts",
    from: "              const pinExpired = isPinExpired(pinPinnedAt, issueId, nowMs);",
    to: "              const pinExpired = true;",
  },
  {
    // (b) missing entry treated as fresh: pins from before the lifecycle
    // clock (or with a lost stamp) are kept on trust instead of re-validated.
    name: "pin-missing-timestamp-treated-as-fresh",
    file: "src/worker.ts",
    from: '        if (typeof raw !== "string") return true;',
    to: '        if (typeof raw !== "string") return false;',
  },
  {
    // (c) unknown-assignee branch reverts to wholesale preserve: a repin off
    // a dead lane leaves the sub-call surfaces resolving to it.
    // Re-anchored  to the merged cheap-key loop (cheapId target);
    // still matches once. Re-anchored  to the agent-secret veto
    // guard; still matches once. Killed by the unknown-assignee re-derive
    // test in tests/context.spec.ts, which expects the snapshot's cheap keys
    // to follow the NEW model even when the agent env was never read.
    name: "unknown-assignee-skips-env-rederive",
    file: "src/engine/context.ts",
    from:
      "    for (const key of ANCILLARY_MODEL_ENV_KEYS) {\n" +
      "      if (!agentEnvKnown && !(key in overrideEnv)) continue;\n" +
      "      if (isSecretBinding(env[key]) || agentSecretBound(key)) continue;\n" +
      "      env[key] = { type: \"plain\", value: cheapId };\n" +
      "    }",
    to:
      "  if (agentEnvKnown) {\n" +
      "    for (const key of ANCILLARY_MODEL_ENV_KEYS) {\n" +
      "      if (isSecretBinding(env[key])) continue;\n" +
      "      env[key] = { type: \"plain\", value: cheapId };\n" +
      "    }\n" +
      "  }",
  },
  // ---  acceptance-criteria named mutants -------------------------
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
    // "cooldown" is degraded -> `avoid` -> still selectable ().
    name: "cooldown-health-merely-down-ranked",
    file: "src/engine/availability.ts",
    from: '  if (health !== "healthy" && !(countsOnly && health === "unknown")) {',
    to: '  if (health !== "healthy" && !(countsOnly && health === "unknown") && health !== "cooldown" && health !== "cooling_down") {',
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
    // AC-1: sticky returning before the gate — the pre- behaviour.
    name: "sticky-skips-the-availability-gate",
    file: "src/engine/select.ts",
    from: "    } else if (incumbent && !clearsLane(incumbent)) {",
    to: "    } else if (false) {",
  },
  {
    // Integration with : a wholly-unserviceable tier reported as
    // `no-eligible-model` sends a capacity outage to the wrong owner.
    name: "availability-exclusion-not-counted-as-capacity",
    file: "src/engine/select.ts",
    from:
      'const CAPACITY_STAGES = new Set(["lane-unserviceable", "lane-availability", "lane-evidence", "lane-withdrawn"]);',
    to: 'const CAPACITY_STAGES = new Set(["lane-unserviceable", "lane-withdrawn"]);',
  },
  {
    // AC-3, after the  merge. 's floor exit tests the floor's
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
  // ---  AC-2: the WRITER --------------------------------------------
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
  // ---  named mutants ---------------------------------------------
  // Each of these three restores one shape that made `classifyIssues` write
  // zero classifications in 36 consecutive runs on 2026-09-17 while 53% of runs
  // and 93.8% of spend sat on T1. All three fail SILENTLY — the job still
  // reports "succeeded" with empty logs — so the suite is the only thing that
  // can tell the difference.
  {
    // The original defect, exactly: skip any card carrying a tier:* label. 120
    // of 126 eligible open cards carried one and 97.1% of those labels were not
    // this plugin's, so this single skip starved the job completely.
    // the classify body is a row callback returning "settled".
    name: "skip-any-tier-label-unconditionally",
    file: "src/worker.ts",
    from: "                if (existingLabelTier !== null) {\n                  if (!config.classification.reclassifyForeignLabels) return \"settled\";\n                  if (!isForeignLabel) return \"settled\";\n                }",
    to: "                if (existingLabelTier !== null) return \"settled\";",
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
  // ---  named mutants: creation-time pin + unpinnable visibility ----
  // NOTE: the write-path idleness/pin guards are deliberately NOT here. Each
  // is enforced twice — once at the `advise` result (`!result.isIdle`,
  // `result.pinnedModelId !== null`) and again inside
  // `balanceWriteStillSafe`'s fresh re-read — so any single-line mutant of
  // either copy survives the suite. That's defense in depth working as
  // designed, not a coverage gap: what IS mutably load-bearing below is the
  // event wiring, the guards no later re-read duplicates, and the AC3
  // throttle.
  //  exception to the above: the creation path no longer gates on
  // `!result.isIdle` at all — the assignment wake's queued run would veto its
  // own pin — so its two queued-vs-started checks inside `pinnableBeforeStart`
  // ARE singly load-bearing and get their own mutants below.
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
    // assignee ( §3), so only this arm pins it.
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
      // the check now lives in `pinAtTier`; the same-pick guard
      // above it keeps this anchor clear of the balance/repin passes' deeper-
      // indented floor reads.
      "        if (result.decision.modelId === expectedPinnedModelId) return null;\n" +
      "        const floorModelId = resolveConfiguredModelId(result.agentFloorModelId, config.models);\n" +
      "        if (result.decision.modelId === floorModelId) {",
    to:
      "        if (result.decision.modelId === expectedPinnedModelId) return null;\n" +
      "        const floorModelId = resolveConfiguredModelId(result.agentFloorModelId, config.models);\n" +
      "        if (false) {",
  },
  // --- : first pin at event time, classifier off the critical path --
  // 0 of 130 first runs matched a pin because the creation pin awaited the
  // classifier (15 s timeout) while the run was claimed in ~2 s. Each mutant
  // below is the natural regression back to that shape.
  {
    // The regression itself: classify before the first write. Killed by the
    // in-flight timing test (the pin must land while the classifier is held)
    // and the before-classifier ordering test.
    name: "creation-pin-awaits-classifier-first",
    file: "src/worker.ts",
    from: "        const firstPinnedModelId = await pinAtTier(",
    to:
      "        if (!described.hasTierLabel) await classifyForPin(companyId, issueId, described, config, source);\n" +
      "        const firstPinnedModelId = await pinAtTier(",
  },
  {
    // The first pin is sticky, so a classified DOWN-tier re-pin must suppress
    // stickiness or `advise` just returns the first pin. Killed by the
    // down-tier re-pin test.
    name: "creation-repin-keeps-sticky",
    file: "src/worker.ts",
    from: "        const result = await advise(companyId, { issueId }, false, tier, isRepin);",
    to: "        const result = await advise(companyId, { issueId }, false, tier, false);",
  },
  {
    // A re-pin must stop once the run starts; the change then applies at the
    // next boundary. Killed by the started-during-classification test and the
    //  landed-after-start test.
    name: "creation-repin-skips-started-check",
    file: "src/worker.ts",
    from: "        if (!(await pinnableBeforeStart(companyId, issueId))) {\n          if (isRepin) {",
    to: "        if (false) {\n          if (isRepin) {",
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
  // ---  named mutants: pinnableBeforeStart's queued-vs-started ----
  // The creation path's whole point is pinning THROUGH the wake's queued run,
  // so each of these two checks is the line between "the fix works" and
  // "pins onto live work". Each is killed by its named  test in
  // tests/creation-pin.spec.ts — verified by hand-applying each mutant and
  // watching that test fail.
  {
    // Dropping the per-run check pins onto a STARTED run — exactly the
    // warm-session reset the old strict-idle gate existed to prevent.
    name: "creation-pin-drops-queued-check",
    file: "src/worker.ts",
    from: '          return run.status === "queued" && run.started_at == null;\n        });\n      };',
    to: '          return true;\n        });\n      };',
  },
  {
    // Dropping the status half lets a `running` row whose started_at is not
    // yet populated through — only the status test refuses it.
    name: "creation-pin-ignores-running-status",
    file: "src/worker.ts",
    from: '          return run.status === "queued" && run.started_at == null;\n        });\n      };',
    to: '          return run.started_at == null;\n        });\n      };',
  },

  // ---  second failure shape: the LANE-EVIDENCE term ----------------
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
    // while `deepseek-v4-flash` at 0/3 still takes  off haiku, because
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
  // --- : a lost pace verdict must not erase an earned exclusion -----
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
  // ---  sub-call surface pins -------------------------------------
  {
    // The whole point of the card: a repin that evacuates the main model off an
    // exhausted lane and leaves the haiku-class sub-calls pointed at it. That
    // is not a degradation — run 6d0c6de7 on  died `acpx_turn_failed`.
    // Under  this anchor pins the PIN-LANE loop's write (the only
    // place `input.model.id` is written to env); the cheap-key loop has its
    // own drop mutant below. /main re-shaped the loop bodies (unknown-
    // assignee carry rule, blocked-model gate) but the two anchor lines are
    // unchanged, still matching once. Re-anchored  to the
    // agent-secret veto guard; still matches once.
    name: "drop-subcall-surface-pins",
    file: "src/engine/context.ts",
    from:
      "      if (isSecretBinding(env[key]) || agentSecretBound(key)) continue;\n" +
      "      env[key] = { type: \"plain\", value: input.model.id };\n",
    to: "    void key;\n",
  },
  {
    //  (inverted by the fix). The pin carries ONLY plugin-owned
    // keys; the agent's env reaches the run through the base env under the
    // deployed per-key merge (). Re-adding the spread re-snapshots
    // the agent's secret_refs into every pin — the exact 155-of-155 defect
    // this card removes. Killed by the  allowlist test ("writes no
    // key outside the allowlist"), which feeds an agent env full of
    // secret_refs and arbitrary keys and asserts none leak into the pin.
    name: "pin-copies-agent-env-into-pin",
    file: "src/engine/context.ts",
    from: "  const env: AdapterEnv = { ...carriedOverrideEnv };",
    to: "  const env: AdapterEnv = { ...agentEnv, ...carriedOverrideEnv };",
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
    // refuses to call a secret-bound surface "drifted". One mutant covers BOTH
    // guarded loops ('s pin-lane loop and the cheap-key loop):
    // removing either guard alone would be a weaker mutant than the code now
    // contains, and a shared anchor would match twice.
    // Re-anchored  to the merged write block (unknown-assignee carry
    // rule + blocked-model gate + cheapPick fallback); still matches once.
    // Re-anchored  to the agent-secret veto guards; still matches once.
    name: "overwrite-a-secret-bound-subcall-surface",
    file: "src/engine/context.ts",
    from:
      "    for (const key of PIN_LANE_MODEL_ENV_KEYS) {\n" +
      "      if (!agentEnvKnown && !(key in overrideEnv)) continue;\n" +
      "      // A secret-bound snapshot value is never overwritten (we cannot\n" +
      "      // reconstruct it); a secret-bound AGENT value vetoes the plain pin so\n" +
      "      // the pin does not shadow the agent's live binding under per-key merge.\n" +
      "      if (isSecretBinding(env[key]) || agentSecretBound(key)) continue;\n" +
      "      env[key] = { type: \"plain\", value: input.model.id };\n" +
      "    }\n" +
      "    const cheapPick = input.cheapModelId || input.model.id;\n" +
      "    const cheapId = isAdapterBlockedModel(cheapPick, input.agentAdapterType)\n" +
      "      ? input.model.id\n" +
      "      : cheapPick;\n" +
      "    for (const key of ANCILLARY_MODEL_ENV_KEYS) {\n" +
      "      if (!agentEnvKnown && !(key in overrideEnv)) continue;\n" +
      "      if (isSecretBinding(env[key]) || agentSecretBound(key)) continue;\n" +
      "      env[key] = { type: \"plain\", value: cheapId };\n" +
      "    }\n",
    to:
      "    for (const key of PIN_LANE_MODEL_ENV_KEYS) {\n" +
      "      if (!agentEnvKnown && !(key in overrideEnv)) continue;\n" +
      "      env[key] = { type: \"plain\", value: input.model.id };\n" +
      "    }\n" +
      "    const cheapPick = input.cheapModelId || input.model.id;\n" +
      "    const cheapId = isAdapterBlockedModel(cheapPick, input.agentAdapterType)\n" +
      "      ? input.model.id\n" +
      "      : cheapPick;\n" +
      "    for (const key of ANCILLARY_MODEL_ENV_KEYS) {\n" +
      "      if (!agentEnvKnown && !(key in overrideEnv)) continue;\n" +
      "      env[key] = { type: \"plain\", value: cheapId };\n" +
      "    }\n",
  },
  // ---  six-surface evacuation -------------------------------------
  {
    // The cheap half of the write: dropping only the ANCILLARY loop's write
    // leaves the two haiku-class keys wherever the frozen override env had
    // them — the exact 118-card residue the 00:0xZ board sweep measured.
    // Re-anchored  to the agent-secret veto guard; still matches once.
    name: "drop-the-cheap-surface-pins",
    file: "src/engine/context.ts",
    from:
      "      if (isSecretBinding(env[key]) || agentSecretBound(key)) continue;\n" +
      "      env[key] = { type: \"plain\", value: cheapId };\n",
    to: "      void key; void cheapId;\n",
  },
  {
    // The cheap keys are not the main pin: collapsing the cheap pick onto the
    // pin prices every background haiku-class call at the pin's tier —
    //  scope 3 exists to keep that from being the default behavior.
    // Re-anchored  (`cheapPick` + blocked-model fallback); still
    // matches once.
    name: "point-the-cheap-keys-at-the-main-pin",
    file: "src/engine/context.ts",
    from: "    const cheapPick = input.cheapModelId || input.model.id;",
    to: "    const cheapPick = input.model.id;",
  },
  {
    // `cheapestHealthyModelIdForTier` must consult the lane-outage record: on
    // the rehearsed incident, luna undercuts haiku on blended list price, so a
    // resolver that skips the outage check resolves the cheap keys straight
    // back onto the exhausted Codex lane.
    name: "ignore-the-lane-outage-in-cheap-resolution",
    file: "src/engine/context.ts",
    from: "    if (laneOutageExcluded(input.laneOutageOverride, input.nowIso, model)) return false;\n",
    to: "",
  },
  {
    // remediation half. The balance pass short-circuits on
    // "the pin is already what we would pick". Restoring that short-circuit
    // without the envDrifted escape makes the drain unreachable for the exact
    // 149-card population it exists for — pin healthy, sub-call env frozen —
    // while every other test stays green. This is the regression that would
    // ship the fix inert, so it gets its own mutant.
    // the balance body is a row callback returning "settled".
    name: "short-circuit-a-healthy-pin-before-the-env-drift-check",
    file: "src/worker.ts",
    from: "if (result.decision.modelId === pinnedModelId && !envDrifted) return \"settled\";",
    to: "if (result.decision.modelId === pinnedModelId) return \"settled\";",
  },
  {
    // The drain must stop once the board is clean. A predicate hardwired true
    // rewrites every overridden card on every pass — an infinite write loop
    // that also resets warm sessions fleet-wide.
    name: "treat-every-override-env-as-drifted",
    file: "src/engine/context.ts",
    from: "  const env = input.existingOverrideEnv;\n  if (!env) return false;",
    to: "  const env = input.existingOverrideEnv;\n  if (!env) return false;\n  return true;",
  },
  {
    // Secret-bound surfaces cannot be read or rewritten. Flagging one schedules
    // a write that provably cannot fix what it was scheduled for.
    name: "flag-secret-bound-surfaces-as-drifted",
    file: "src/engine/context.ts",
    from: "    if (entry === undefined || isSecretBinding(entry)) continue;",
    to: "    if (entry === undefined) continue;",
  },
  // ---  agent-env cap split + stamped floor -----------------------
  {
    // Collapsing the split reintroduces the defect: with the fleet ceiling
    // held at 200k for glm-5.3, the pin stamps against 200k instead of the
    // 1M agent-env cap — Muse's 1,048,576 window gets a 150k stamp instead
    // of inheriting the agent env. Killed by the config.spec split-
    // resolution test (fleet 200k + agentEnv 1M must resolve to 1M).
    name: "collapse-agent-env-cap-onto-fleet-ceiling",
    file: "src/config/resolve.ts",
    from:
      "      agentEnvContextTokens: num(\n" +
      "        selection.agentEnvContextTokens,\n" +
      "        num(selection.fleetContextCeilingTokens, 1_000_000),\n" +
      "      ),",
    to:
      "      agentEnvContextTokens: num(\n" +
      "        selection.fleetContextCeilingTokens,\n" +
      "        1_000_000,\n" +
      "      ),",
  },
  {
    // Removing the 250k floor restores the thrash-incident stamp: glm-5.3's
    // 200k window stamps 150000, which thrashed autocompact and killed ~1 in
    // 4 runs on 09-19/20. Killed by the  floor tests (200k window
    // stamps 200000, Sol 272k stamps 250000).
    name: "remove-stamped-context-floor",
    file: "src/engine/context.ts",
    from:
      "      value: String(\n" +
      "        Math.max(\n" +
      "          Math.floor(modelWindow * ratio),\n" +
      "          Math.min(modelWindow, MIN_STAMPED_CONTEXT_TOKENS),\n" +
      "        ),\n" +
      "      ),",
    to:
      "      value: String(\n" +
      "        Math.max(1, Math.floor(modelWindow * ratio)),\n" +
      "      ),",
  },
  // price-reconciliation invariants whose failure mode is
  // a confidently-wrong number rather than an error. Each one, broken, still
  // produces a plausible-looking report.
  {
    // The provider must come from the lane. `kimi-k2.6`, `glm-5.x` and the
    // `muse-spark-*-contributor` rows all sit under two providers at two
    // prices, so a first-match-wins search returns the wrong one about as
    // often as the right one — and never says so.
    name: "price-provider-by-id-search-instead-of-lane",
    file: "src/price-sync/match.ts",
    from: "  const providerId = LANE_PRICE_PROVIDERS[row.laneId];",
    to: "  const providerId = LANE_PRICE_PROVIDERS[row.laneId] ?? [...catalog.keys()].find((p) => catalog.get(p)?.has(bareModelId(row.modelId)));",
  },
  {
    // Exclusions are checked before any feed lookup. Checking after lets a
    // feed id that merely looks like an excluded row produce a finding
    // against a row the audit already settled by hand.
    name: "price-exclusions-checked-after-the-feed-lookup",
    file: "src/price-sync/match.ts",
    from: "  const excluded = priceExclusionReason(row.modelId, row.note);\n  if (excluded) return { kind: \"excluded\", reason: excluded };\n\n  if (!row.laneId) return { kind: \"no-lane\" };",
    to: "  if (!row.laneId) return { kind: \"no-lane\" };",
  },
  {
    // A field the provider does not publish is not a zero. Reading it as 0
    // manufactures a drift row against every correctly-priced roster row
    // whose provider has no cache rate (`zhipuai/glm-4.5v` today).
    name: "price-unpublished-cache-read-as-zero",
    file: "src/price-sync/parse.ts",
    from: "        cacheRead: finiteNumber(cost.cache_read),",
    to: "        cacheRead: finiteNumber(cost.cache_read) ?? 0,",
  },

  // the card-accept-rate exclusion. Both halves have to hold — the
  // gate has to FIRE on a proven-bad row, and it has to stay silent on every
  // row we cannot read as proven-bad. The costly mistake is the second one: a
  // wrong exclusion cuts off ordinary traffic; maturity and bounded expiry
  // must protect the candidate even when the ledger cache stops refreshing.
  {
    // Neutralize the gate entirely. The cheap zero-accept row then wins on
    // list price, which is the state the card was filed against.
    name: "card-accept-gate-never-fires",
    file: "src/engine/select.ts",
    from: "    const zeroAccept = zeroAcceptEvidence(model.id, requiredTier, cardLedger, now);",
    to: "    const zeroAccept = null;",
  },
  {
    // Threshold `cardsClosed` instead of `cardsResolved` — the defect as
    // originally specified. `cardsClosed` counts the right-censored cards, so
    // astra's 25-closed/1-resolved row would ban T1 on a single rejection.
    name: "card-accept-gate-counts-closed-not-resolved",
    file: "src/engine/scores.ts",
    from: "  if (cohort.cardsResolved < CARD_ZERO_ACCEPT_MIN_RESOLVED) return null;",
    to: "  if (entry.cardsClosed < CARD_ZERO_ACCEPT_MIN_RESOLVED) return null;",
  },
  {
    // Move the floor by one. `N` is the whole argument of this change, so the
    // boundary has to be pinned on the exact card, not approximately.
    name: "card-accept-gate-floor-off-by-one",
    file: "src/engine/scores.ts",
    from: "  if (cohort.cardsResolved < CARD_ZERO_ACCEPT_MIN_RESOLVED) return null;",
    to: "  if (cohort.cardsResolved <= CARD_ZERO_ACCEPT_MIN_RESOLVED) return null;",
  },
  {
    // Let a `pending` row through. A pending row's acceptRate is a prior, not
    // a measurement; it needs MORE traffic, which is the opposite of this.
    name: "card-accept-gate-fires-on-a-pending-row",
    file: "src/engine/scores.ts",
    from: "  if (entry.pending !== false) return null;\n",
    to: "",
  },
  {
    // Drop the shape check and a pre- row — `cardsResolved`
    // undefined — excludes, because `undefined < 8` is false.
    name: "card-accept-gate-excludes-a-legacy-row",
    file: "src/engine/scores.ts",
    from: "  if (![entry.cardsClosed, entry.cardsResolved, entry.cardsAccepted].every(validCount)) return null;\n",
    to: "",
  },
  {
    name: "card-accept-gate-trusts-wrong-identity",
    file: "src/engine/scores.ts",
    from: "  if (entry.modelId !== modelId || entry.tier !== tier) return null;\n",
    to: "",
  },
  {
    name: "card-accept-gate-trusts-inconsistent-counts",
    file: "src/engine/scores.ts",
    from: "  if (entry.cardsResolved > entry.cardsClosed || entry.cardsAccepted > entry.cardsResolved) return null;\n",
    to: "",
  },
  {
    name: "card-accept-gate-trusts-contradictory-rate",
    file: "src/engine/scores.ts",
    from: "  if (entry.cardsAccepted !== 0 || entry.acceptRate !== 0) return null;",
    to: "  if (entry.cardsAccepted !== 0) return null;",
  },
  {
    name: "card-accept-gate-resolves-rejects-early",
    file: "src/engine/scores.ts",
    from: "      return age >= censorMs && age < censorMs + qualityWindowMs;",
    to: "      return r.rejected || (age >= censorMs && age < censorMs + qualityWindowMs);",
  },
  {
    name: "card-accept-gate-never-expires-cache",
    file: "src/engine/scores.ts",
    from: "  if (nowMs >= expiresAtMs) return null;\n",
    to: "",
  },
  {
    name: "card-accept-gate-expires-from-newest-card",
    file: "src/engine/scores.ts",
    from: "  const expiresAtMs = cohort.oldestClosedAtMs + censorMs + windowMs;",
    to: "  const expiresAtMs = cohort.newestClosedAtMs + censorMs + windowMs;",
  },
  {
    name: "card-accept-gate-refresh-restarts-ban",
    file: "src/engine/scores.ts",
    from: "  const expiresAtMs = cohort.oldestClosedAtMs + censorMs + windowMs;",
    to: "  const expiresAtMs = cohort.observedAtMs + windowMs;",
  },
  {
    name: "card-accept-gate-trusts-immature-cache",
    file: "src/engine/scores.ts",
    from: "  if (cohort.newestClosedAtMs > cohort.observedAtMs - censorMs) return null;\n",
    to: "",
  },
  {
    // Classify the quality exclusion as capacity. A tier where every row is a
    // proven reject is `no-eligible-model`; calling it `tier-exhausted` sends
    // an operator to buy capacity that is already there.
    name: "card-accept-gate-counted-as-capacity",
    file: "src/engine/select.ts",
    from: '    const CAPACITY_STAGES = new Set(["lane-unserviceable", "lane-availability", "lane-evidence", "lane-withdrawn"]);',
    to: '    const CAPACITY_STAGES = new Set(["lane-unserviceable", "lane-availability", "lane-evidence", "lane-withdrawn", "card-accept-rate"]);',
  },
  {
    // Sort a null costPerAcceptedCard FIRST — the card's stated defect, made
    // real. A missing denominator is absence of evidence, not cheapness.
    name: "null-cost-per-accepted-card-sorts-first",
    file: "src/engine/objective.ts",
    from: "      if (a.cost === null) return 1;\n      if (b.cost === null) return -1;",
    to: "      if (a.cost === null) return -1;\n      if (b.cost === null) return 1;",
  },
  {
    // Order the raw candidate set instead of the costable subset. Now that
    // nulls rank last rather than being dropped, that ordering always has a
    // head, so the diff names a winner against a cost nobody measured.
    name: "shadow-diff-names-an-uncostable-winner",
    file: "src/engine/objective.ts",
    from: "  const byCard = orderByCostPerAcceptedCard(costable, ledger);",
    to: "  const byCard = orderByCostPerAcceptedCard(candidates, ledger);",
  },

  // the effort half of a pin. Each of these is a way to emit a
  // model/effort pair the model cannot honour — the 2026-09-22 failure — and
  // each must be visibly fatal, or `effort.ts` is decoration.
  {
    // Trust the roster and skip the model's own vocabulary.
    name: "effort-roster-bypasses-vocabulary",
    file: "src/engine/effort.ts",
    from: "    if (legal.has(rosterEffort)) {",
    to: "    if (rosterEffort) {",
  },
  {
    // Clamp to the hottest legal level regardless of what was asked for. Looks
    // right for a down-clamp and is wrong for every request below the floor.
    name: "effort-clamp-ignores-the-request",
    file: "src/engine/effort.ts",
    from: "    if (index <= requestedIndex && index > bestIndex) {",
    to: "    if (index > bestIndex) {",
  },
  {
    // Treat any inherited value as acceptable. This is the exact pre-
    // behaviour: the key is omitted, and the host's per-key merge then carries
    // the agent's illegal effort onto the new model.
    name: "effort-inherited-illegal-passes-through",
    file: "src/engine/effort.ts",
    from: "  if (legal.has(inherited)) {",
    to: "  if (inherited) {",
  },
  {
    // Read the vocabulary off something other than the adapter. `claude_local`
    // must not inherit a vocabulary that reaches xhigh/max.
    name: "effort-vocabulary-ignores-the-adapter",
    file: "src/engine/effort.ts",
    from: '    case "claude_local":\n      return CLAUDE_LOCAL_EFFORTS;',
    to: '    case "claude_local":\n      return OPENCODE_LOCAL_EFFORTS;',
  },
  {
    // codex's legacy fallback key. Ignoring it leaves the clamp blind to a
    // value `codex-args.ts` will still honour.
    name: "effort-codex-legacy-key-ignored",
    file: "src/engine/effort.ts",
    from: "    const legacy = adapterConfig.reasoningEffort;",
    to: "    const legacy = undefined;",
  },
  {
    //  finding 1. Normalize MORE than the adapter does, and every
    // namespaced roster id (`cliproxy/gpt-6-astra`) reads as astra here while
    // the CLI still caps it at xhigh — over-authorizing max/ultra on a pair the
    // adapter cannot honour.
    name: "effort-codex-namespace-stripped",
    file: "src/engine/effort.ts",
    from: "  return CODEX_LOCAL_MODEL_ALIASES[trimmed] ?? trimmed;",
    to: '  const bare = trimmed.slice(trimmed.lastIndexOf("/") + 1);\n  return CODEX_LOCAL_MODEL_ALIASES[bare] ?? bare;',
  },
  {
    // The same over-authorization by case instead of by namespace.
    name: "effort-codex-model-lowercased",
    file: "src/engine/effort.ts",
    from: '  const trimmed = typeof modelId === "string" ? modelId.trim() : "";',
    to: '  const trimmed = typeof modelId === "string" ? modelId.trim().toLowerCase() : "";',
  },
  {
    //  finding 2. Clear only the modern key. codex resolves
    // `asString(modelReasoningEffort, asString(reasoningEffort, ""))` and
    // `asString` reads "" as absent, so this silently restores the illegal
    // inherited value it claims to have cleared.
    name: "effort-codex-clear-misses-legacy-key",
    file: "src/engine/effort.ts",
    from: '  if (adapterType === "codex_local") writes.reasoningEffort = "";',
    to: '  if (adapterType === "no_such_adapter") writes.reasoningEffort = "";',
  },
  {
    // Sever the plumbing rather than the policy: the decision stays correct and
    // the pin stops seeing what it is overriding.
    name: "effort-pin-blind-to-inherited-value",
    file: "src/engine/context.ts",
    from: "    inheritedEffort: inheritedEffortFrom(input.agentAdapterType, input.agentAdapterConfig),",
    to: "    inheritedEffort: null,",
  },

  // the cost-attribution guard has two ways to fail silently, and
  // both of them end at routing order rather than at a red test. Either it
  // stops rejecting (and `costPerAcceptedCard` goes back to averaging an
  // Anthropic-priced cost for a Meta model), or it over-rejects (and it
  // discards real evidence from the adapters that price correctly). One
  // mutant per direction, plus the substring trap in the id predicate.
  {
    name: "attribute-every-anthropic-priced-run",
    file: "src/engine/cost-attribution.ts",
    from: "  if (isAnthropicModelId(modelId)) {",
    to: "  if (true) {",
  },
  {
    // The whole point of keying on the recorded provider is that codex, zai,
    // openrouter and opencode-go price with their own tables. Dropping the
    // passthrough throws away every cost we actually trust.
    name: "reject-costs-from-correctly-pricing-providers",
    file: "src/engine/cost-attribution.ts",
    from: "  if (provider !== ANTHROPIC_PROVIDER) {",
    to: "  if (false) {",
  },
  {
    // Absence of a provider is not evidence of misattribution. Treating it as
    // one silently invalidates the history recorded before provider capture.
    name: "treat-a-missing-provider-as-misattributed",
    file: "src/engine/cost-attribution.ts",
    from: '    return { attributable: true, reason: "no provider recorded on the run" };',
    to: '    return { attributable: false, reason: "no provider recorded on the run" };',
  },
  {
    // A model named `muse-spark-claude-compat` must not be read as Anthropic's
    // just for containing "claude" — that reopens the misattribution.
    name: "match-anthropic-model-ids-by-substring",
    file: "src/engine/cost-attribution.ts",
    from: "const ANTHROPIC_MODEL_ID_RE = /^(?:anthropic\\/)?claude(?:[-.][a-z0-9.-]*)?$/i;",
    to: "const ANTHROPIC_MODEL_ID_RE = /claude/i;",
  },
  {
    // A zero cost is a measurement (a free lane), not an unknown. Collapsing
    // it would let a free model fall out of the cost ordering entirely.
    name: "collapse-a-zero-cost-into-unknown",
    file: "src/engine/cost-attribution.ts",
    from: "  if (costUsd === null) return null;\n  return classifyCostAttribution",
    to: "  if (!costUsd) return null;\n  return classifyCostAttribution",
  },
  {
    // The predicate is inert unless the closing-run mapping actually calls it:
    // `buildCardLedger` averages `costUsd` from THESE rows into `costPerCard`,
    // which is what `orderByCostPerAcceptedCard` ranks on.
    name: "bypass-the-cost-guard-on-closing-runs",
    file: "src/worker.ts",
    from: "                costUsd: attributableCost(modelId, r.provider, toNumber(r.cost_usd)),\n              }];",
    to: "                costUsd: toNumber(r.cost_usd),\n              }];",
  },
  {
    // A correctly-free big-pickle row has no -free suffix.
    name: "price-ignore-free-offer-note",
    file: "src/price-sync/match.ts",
    from: '  const excluded = priceExclusionReason(row.modelId, row.note);',
    to: '  const excluded = priceExclusionReason(row.modelId);',
  },
  {
    // Pure matcher tests alone cannot catch the worker dropping the note.
    name: "price-worker-drops-free-offer-note",
    file: "src/worker.ts",
    from: "              note: model.note,\n",
    to: "",
  },
  // --- : per-tier poll-outcome counters are read-only telemetry ----
  // The failure this gate exists to catch is a counter that increments
  // unconditionally (or never) while reading green: tier rosters audited by
  // lane means rather than outcomes. Each mutant below breaks one half of a
  // behavioural pair in tests/tier-outcomes.spec.ts or the worker wiring.
  {
    // Served polls must increment `succeeded`, not `failed`: counting a
    // healthy lane as missed inverts the outcome the tool reports.
    name: "tier-outcomes-success-counted-as-failure",
    file: "src/engine/tier-outcomes.ts",
    from: "      if (result.error === null && result.serviceable === true) counter.succeeded += 1;",
    to: "      if (result.error === null && result.serviceable === true) counter.failed += 1;",
  },
  {
    // An indeterminate poll (no error, serviceable null) is absence of
    // evidence and must increment `polls` only — the same tri-state
    // discipline lane-evidence.ts follows for `unproven`.
    name: "tier-outcomes-indeterminate-counted-as-failure",
    file: "src/engine/tier-outcomes.ts",
    from: "      else if (result.error !== null || result.serviceable === false) counter.failed += 1;",
    to: "      else counter.failed += 1;",
  },
  {
    // A disabled roster row is not selectable, so its tier must not earn poll
    // evidence from its lane — the same rule scores.ts applies to top rungs.
    name: "tier-outcomes-disabled-rows-earn-evidence",
    file: "src/engine/tier-outcomes.ts",
    from: "    if (model.enabled === false) continue;",
    to: "",
  },
  {
    // The tool must actually be registered under its own name: a handler
    // wired to the wrong name leaves `model_selection_tier_outcomes`
    // unregistered, and the harness throws on an unregistered tool.
    name: "tier-outcomes-tool-never-registered",
    file: "src/worker.ts",
    from: "        TOOL_NAMES.tierOutcomes,",
    to: "        TOOL_NAMES.priceDriftReport,",
  },

  // ---  user-assigned skip + per-issue isolation --------------------
  // A user-assigned card (Operator:* cards carry assignee_user_id) rejects
  // issues.update with an agent override ("Issue can only have one
  // assignee"). Each mutant is the natural wrong implementation: dropping a
  // guard the live incident proved load-bearing, not a nonsense edit.
  {
    // Without the backstop, labelOnlyPass attempts the pin on a card the
    // host will reject. The skip test seeds assigneeUserId and asserts no
    // write happens.
    // the label-only body is a row callback returning "settled".
    name: "label-only-pins-user-assigned-cards",
    file: "src/worker.ts",
    from:
      "                if (described.hasOperatorPin) return \"settled\";\n" +
      "                // backstop for the `assignee_user_id is null`\n" +
      "                // predicate above — a user-assigned card rejects issues.update\n" +
      "                // with an agent override (\"Issue can only have one assignee\").\n" +
      "                if (described.assigneeUserId) return \"settled\";\n" +
      "                const labelTier = tierFromLabels(described.descriptor.labelNames);",
    to:
      "                if (described.hasOperatorPin) return \"settled\";\n" +
      "                const labelTier = tierFromLabels(described.descriptor.labelNames);",
  },
  {
    // Same hole in balancePass: without the backstop the pass attempts the
    // write on a user-assigned card instead of skipping it.
    // the balance body is a row callback returning "settled".
    name: "balance-pins-user-assigned-cards",
    file: "src/worker.ts",
    from:
      "                if (described.hasOperatorPin) return \"settled\";\n" +
      "                // backstop for the `assignee_user_id is null`\n" +
      "                // predicate above — a user-assigned card rejects issues.update\n" +
      "                // with an agent override (\"Issue can only have one assignee\").\n" +
      "                if (described.assigneeUserId) return \"settled\";\n" +
      "                const status = described.status;",
    to:
      "                if (described.hasOperatorPin) return \"settled\";\n" +
      "                const status = described.status;",
  },
  {
    // The shipped defect itself: one card's pin rejection propagates out of
    // the row loop, aborting the pass for the whole company and skipping the
    // scan-mark advance. The isolation test throws the exact live error for
    // i1 and requires i2 to pin plus the watermark to advance.
    name: "label-only-pin-failure-aborts-pass",
    file: "src/worker.ts",
    from: '                ctx.logger.warn("label-only pass skipped a card it could not pin", {',
    to: '                throw cause; // eslint-disable-line no-throw-literal\n                ctx.logger.warn("label-only pass skipped a card it could not pin", {',
  },
  {
    // Same abort shape on the balance pinned-branch write site. The pinned
    // and unpinned branches share the warn line character-for-character, so
    // the anchor runs through the branch-distinctive advisory-else logger
    // line  added ("would balance" vs "would pin unpinned card")
    // to land exactly once.
    // Re-anchored ,  (row callback: the catch returns
    // "settled"; a throw still aborts the pass because it propagates out of
    // the walk into the pass-level catch, skipping the scan-mark advance),
    // then ; still matches once. Killed by the 
    // pinned-branch isolation test in tests/scheduled-passes.spec.ts.
    name: "balance-pin-failure-aborts-pass",
    file: "src/worker.ts",
    from:
      "                    } catch (cause) {\n" +
      '                      ctx.logger.warn("balance pass skipped a card it could not pin", {\n' +
      "                        companyId: company.id,\n" +
      "                        issue: identifier,\n" +
      "                        error: cause instanceof Error ? cause.message : String(cause),\n" +
      "                      });\n" +
      '                      return "settled";\n' +
      "                    }\n" +
      "                  } else {\n" +
      '                    ctx.logger.info("balance pass advisory: would balance, nothing written", {\n',
    to:
      "                    } catch (cause) {\n" +
      '                      ctx.logger.warn("balance pass skipped a card it could not pin", {\n' +
      "                        companyId: company.id,\n" +
      "                        issue: identifier,\n" +
      "                        error: cause instanceof Error ? cause.message : String(cause),\n" +
      "                      });\n" +
      "                      throw cause;\n" +
      "                    }\n" +
      "                  } else {\n" +
      '                    ctx.logger.info("balance pass advisory: would balance, nothing written", {\n',
  },
  {
    // Same abort shape on the balance unpinned-branch write site, anchored
    // through its own advisory-else logger line ("would pin unpinned card").
    // Re-anchored ; still matches once.
    name: "balance-unpinned-pin-failure-aborts-pass",
    file: "src/worker.ts",
    from:
      "                  } catch (cause) {\n" +
      '                    ctx.logger.warn("balance pass skipped a card it could not pin", {\n' +
      "                      companyId: company.id,\n" +
      "                      issue: identifier,\n" +
      "                      error: cause instanceof Error ? cause.message : String(cause),\n" +
      "                    });\n" +
      '                    return "settled";\n' +
      "                  }\n" +
      "                } else {\n" +
      '                  ctx.logger.info("balance pass advisory: would pin unpinned card, nothing written", {\n',
    to:
      "                  } catch (cause) {\n" +
      '                    ctx.logger.warn("balance pass skipped a card it could not pin", {\n' +
      "                      companyId: company.id,\n" +
      "                      issue: identifier,\n" +
      "                      error: cause instanceof Error ? cause.message : String(cause),\n" +
      "                    });\n" +
      "                    throw cause;\n" +
      "                  }\n" +
      "                } else {\n" +
      '                  ctx.logger.info("balance pass advisory: would pin unpinned card, nothing written", {\n',
  },

  // --- : selection gate on every router-owned pin write ---------
  // Each mutant drops one conjunct of the central gate or removes one site's
  // check — the natural regressions back to the  defect (advisory
  // installs writing pins). Each is killed by its named  test in
  // tests/scheduled-passes.spec.ts, tests/creation-pin.spec.ts or
  // tests/apply.spec.ts — verified locally by applying each mutant and
  // watching that test fail.
  {
    // Advise mode writes: the mode conjunct is dropped, so an advisory
    // install pins exactly like enforce. Killed by every advise-shape
    //  test.
    name: "selection-gate-ignores-mode",
    file: "src/actuate/apply.ts",
    from: '  return config.selection.enabled && config.selection.mode === "enforce";',
    to: "  return config.selection.enabled;",
  },
  {
    // Selection-disabled writes: the enabled conjunct is dropped, so a
    // company that switched selection off still pins in enforce mode.
    // Killed by every selection-disabled  test.
    name: "selection-gate-ignores-enabled",
    file: "src/actuate/apply.ts",
    from: '  return config.selection.enabled && config.selection.mode === "enforce";',
    to: '  return config.selection.mode === "enforce";',
  },
  {
    // The creation/assignment pin ignores the gate. Killed by the
    // issue.created advisory tests in tests/creation-pin.spec.ts.
    name: "creation-pin-ignores-selection-gate",
    file: "src/worker.ts",
    from:
      "        const writesAllowed = selectionWritesAllowed(config);\n" +
      "        if (writesAllowed) {\n" +
      "          const creationPatch = modelOverrideForContext({\n",
    to:
      "        const writesAllowed = true;\n" +
      "        if (writesAllowed) {\n" +
      "          const creationPatch = modelOverrideForContext({\n",
  },
  {
    // labelOnlyPass ignores the gate: the parent card's headline defect.
    // Killed by the labelOnlyPass advisory tests.
    name: "label-only-ignores-selection-gate",
    file: "src/worker.ts",
    from:
      "                if (writesAllowed) {\n" +
      "                  try {\n" +
      "                    const labelOnlyPatch = modelOverrideForContext({\n",
    to:
      "                if (true) {\n" +
      "                  try {\n" +
      "                    const labelOnlyPatch = modelOverrideForContext({\n",
  },
  {
    // The repin clear-on-blocked ignores the gate: advisory clears the pin
    // instead of just reporting it. Killed by the blocked-card advisory test.
    name: "repin-clear-ignores-selection-gate",
    file: "src/worker.ts",
    from:
      "                  // clearing a pin mutates a selection variable like\n" +
      "                  // any other write — advisory reports it without doing it.\n" +
      "                  if (writesAllowed) {\n" +
      "                    await ctx.issues.update(\n" +
      "                      issueId,\n" +
      "                      { assigneeAdapterOverrides: null } as Parameters<typeof ctx.issues.update>[1],\n" +
      "                      company.id,\n",
    to:
      "                  // clearing a pin mutates a selection variable like\n" +
      "                  // any other write — advisory reports it without doing it.\n" +
      "                  if (true) {\n" +
      "                    await ctx.issues.update(\n" +
      "                      issueId,\n" +
      "                      { assigneeAdapterOverrides: null } as Parameters<typeof ctx.issues.update>[1],\n" +
      "                      company.id,\n",
  },
  {
    // repinPass ignores the gate on the re-pin write. Killed by the demoted-pin
    // advisory tests. Anchored through the  comment so the
    // creation-pin's identical `if (writesAllowed) {` + update shape does not
    // collide: that site has no such comment.
    name: "repin-ignores-selection-gate",
    file: "src/worker.ts",
    from:
      "                // the write needs enforcement; the decision and its\n" +
      "                // log do not.\n" +
      "                if (writesAllowed) {\n",
    to:
      "                // the write needs enforcement; the decision and its\n" +
      "                // log do not.\n" +
      "                if (true) {\n",
  },
  {
    // balancePass ignores the gate on the pinned branch (including the
    // env-evacuation, which mutates the override like any repin). Killed by
    // the pinned-card advisory tests. Anchored through the env-evacuation
    // comment, which no other gate site carries.
    name: "balance-pinned-ignores-selection-gate",
    file: "src/worker.ts",
    from:
      "                  // the write needs enforcement — including the\n" +
      "                  // env-evacuation, which mutates the override like any repin.\n" +
      "                  // The decision and its log do not.\n" +
      "                  if (writesAllowed) {\n",
    to:
      "                  // the write needs enforcement — including the\n" +
      "                  // env-evacuation, which mutates the override like any repin.\n" +
      "                  // The decision and its log do not.\n" +
      "                  if (true) {\n",
  },
  {
    // balancePass ignores the gate on the unpinned branch. Killed by the
    // unpinned-card advisory tests. Anchored through that branch's own
    // comment.
    name: "balance-unpinned-ignores-selection-gate",
    file: "src/worker.ts",
    from:
      "                // same per-issue isolation as the pinned branch.\n" +
      "                // this branch's write is gated like the pinned one.\n" +
      "                if (writesAllowed) {\n",
    to:
      "                // same per-issue isolation as the pinned branch.\n" +
      "                // this branch's write is gated like the pinned one.\n" +
      "                if (true) {\n",
  },

  // ---  P2: opt-in free-list sync/discovery/shadow ------------------
  // Each mutant is the natural wrong implementation of a P2 guarantee: the
  // default-off posture, the shadow-only evidence, the quota, and the
  // candidate carry. Killed by tests/aa-free/aa-free-sync.spec.ts and the
  // aaFreeSync block in tests/config.spec.ts.
  {
    // Without the gate, every decision carries the evidence key (null when
    // v2 is off) and the legacy shape is gone. Killed by the byte-for-byte
    // legacy test (`"aaEffortEvidence" in decision` is false).
    name: "aa-free-evidence-attached-when-off",
    file: "src/worker.ts",
    from: "        if (v2Evidence) decision.aaEffortEvidence = v2Evidence;",
    to: "        decision.aaEffortEvidence = v2Evidence;",
  },
  {
    // Stale snapshots must yield ineligible, never a match on old data.
    // Killed by the stale-snapshot advise test (pure and worker level).
    name: "aa-free-stale-snapshot-still-evidences",
    file: "src/aa-free/sync.ts",
    from:
      "  const held = input.model.fallbackOnly ? (\"fallback-only\" as const) : null;\n" +
      "  if (input.stale) {\n" +
      '    return { ...base, status: "ineligible", candidateId: null, reason: "snapshot-stale", aaIndex: null, held };\n' +
      "  }",
    to: "  const held = input.model.fallbackOnly ? (\"fallback-only\" as const) : null;",
  },
  {
    // S-tier stays held even as evidence: sync never lifts a fallback-only
    // pick. Killed by the held-evidence test (matched and stale legs).
    name: "aa-free-stier-evidence-unheld",
    file: "src/aa-free/sync.ts",
    from: "  const held = input.model.fallbackOnly ? (\"fallback-only\" as const) : null;",
    to: "  const held = null;",
  },
  {
    // Two bindings claiming one slug means neither may serve as evidence.
    // Killed by the ambiguous-slug advise test (pure and worker level).
    name: "aa-free-ambiguous-slug-admitted",
    file: "src/aa-free/sync.ts",
    from:
      "    const claimants = input.bindings.filter((b) => b.aaSlug === looked.binding.aaSlug).length;\n" +
      "    if (claimants > 1) {\n" +
      '      return { ...base, status: "ineligible", candidateId: looked.candidateId, reason: "slug-ambiguous", aaIndex: null, held };\n' +
      "    }",
    to: "",
  },
  {
    // The D1 quota: a denied source stays stopped for the day. Without the
    // gate every firing re-fetches. Killed by the 403 test's second firing
    // (calls stays 1).
    name: "aa-free-quota-gate-ignored",
    file: "src/worker.ts",
    from: "        if (shouldFetchFreeSync({ nextEligibleAt: previous.nextEligibleAt }, nowMs)) {",
    to: "        if (true) {",
  },
  {
    // 401/403 stops the source: no substitution, no retry. A retryable
    // back-off would re-fetch in an hour. Killed by the 403 test's
    // nextEligibleAt assertion (>23h, not ~1h).
    name: "aa-free-access-denied-retried",
    file: "src/worker.ts",
    from:
      "                const outcome: FreeFetchOutcome =\n" +
      '                  result.error === "aa-access-denied"\n' +
      '                    ? "fatal"',
    to:
      "                const outcome: FreeFetchOutcome =\n" +
      '                  result.error === "aa-access-denied"\n' +
      '                    ? "retryable"',
  },
  {
    // The carry, never a re-derivation: substituting the model id for the
    // evidenced candidate silently points at a different candidate. Killed
    // by the recoverSelectedCandidate carry test.
    name: "aa-free-candidate-id-substituted",
    file: "src/aa-free/sync.ts",
    from: "  return { ...found, candidateId: decision.aaEffortEvidence?.candidateId ?? null };",
    to: "  return { ...found, candidateId: decision.modelId };",
  },
  {
    // Duplicate binding keys must yield no evidence rather than wrong
    // evidence (the breakage surfaces in the per-company diff instead).
    // Without the guard the constructor throw propagates out of advise.
    // Killed by the duplicate-keys test (expects null).
    name: "aa-free-duplicate-keys-throw-through-advise",
    file: "src/aa-free/sync.ts",
    from:
      "  let registry: AaEffortRegistry;\n" +
      "  try {\n" +
      "    registry = new AaEffortRegistry(input.bindings);\n" +
      "  } catch {\n" +
      "    // Duplicate keys in unverified input: no evidence rather than wrong\n" +
      "    // evidence. The breakage itself surfaces in the per-company diff.\n" +
      "    return null;\n" +
      "  }",
    to: "  const registry = new AaEffortRegistry(input.bindings);",
  },
  {
    // The report tool must actually be registered under its own name (same
    // shape as the tier-outcomes precedent above). Killed by the registry
    // test, which executes every TOOL_NAMES entry.
    name: "aa-free-report-tool-never-registered",
    file: "src/worker.ts",
    from: "        TOOL_NAMES.aaFreeSyncReport,",
    to: "        TOOL_NAMES.priceDriftReport,",
  },
  {
    // Same for the manual refresh tool. Killed by the same registry test.
    name: "aa-free-refresh-tool-never-registered",
    file: "src/worker.ts",
    from: "        TOOL_NAMES.refreshAaFreeSyncNow,",
    to: "        TOOL_NAMES.reconcilePricesNow,",
  },
  {
    // Default-off: an absent section leaves dispatch identical to today.
    // Killed by the default-off config test.
    name: "aa-free-sync-enabled-by-default",
    file: "src/config/resolve.ts",
    from: "      enabled: bool(aaFreeSync.enabled, false),",
    to: "      enabled: bool(aaFreeSync.enabled, true),",
  },
  // --- : first-party accepted-work posterior producer ------------
  // Each guard below is one card-requirement refusal; killed by
  // tests/accepted-work.spec.ts (pure) or tests/accepted-work-worker.spec.ts
  // (worker), verified by hand-applying each mutant.
  {
    // Default-off: an absent section builds no overlay. Killed by the
    // default-off config test and the disabled-builds-nothing worker test.
    name: "accepted-work-enabled-by-default",
    file: "src/config/resolve.ts",
    from: "    acceptedWork: {\n      enabled: bool(acceptedWork.enabled, false),\n    },",
    to: "    acceptedWork: {\n      enabled: bool(acceptedWork.enabled, true),\n    },",
  },
  {
    // The overlay must be gated: without the flag the job must not build or
    // store it. Killed by the disabled-builds-nothing worker test.
    name: "accepted-work-built-when-disabled",
    file: "src/worker.ts",
    from: "            if (config.acceptedWork.enabled) {",
    to: "            if (true) {",
  },
  {
    // The effort-control rule: a max observation must never score a high
    // cell. Killed by the max-never-lands-in-high pure test.
    name: "accepted-work-effort-borrows-high-for-max",
    file: "src/accepted-work/cohort.ts",
    from: "  if (!MEASURABLE_EFFORTS.has(effort)) {",
    to: "  if (effort === \"max\") return { status: \"known\", servedEffort: \"high\", reason: \"pinned-effort\" };\n  if (!MEASURABLE_EFFORTS.has(effort)) {",
  },
  {
    // Unknown served identity stays unassigned: it is never inferred from
    // the requested model name. Killed by the served-not-requested test.
    name: "accepted-work-infers-served-from-pin",
    file: "src/accepted-work/posterior.ts",
    from: "  const model = resolveServedModel(card.rawServedModel, models);",
    to: "  const model = card.rawServedModel ? { status: \"known\", servedModel: card.rawServedModel, reason: \"exact-match\" } : resolveServedModel(card.rawServedModel, models);",
  },
  {
    // Alias-ambiguous identities are rejected, never suffix-matched. Killed
    // by the bare-suffix-stays-unknown pure test.
    name: "accepted-work-suffix-matches-ambiguous-id",
    file: "src/accepted-work/cohort.ts",
    from: "  // Fail closed: no suffix match, no alias expansion, no case folding. A bare",
    to: "  const suffix = models.find((model) => trimmed.endsWith(model.id) || model.id.endsWith(trimmed));\n  if (suffix) {\n    return { status: \"known\", servedModel: suffix.id, reason: \"exact-match\" };\n  }\n  // Fail closed: no suffix match, no alias expansion, no case folding. A bare",
  },
  {
    // S-tier cohorts stay held: the overlay never lifts a fallbackOnly row.
    // Killed by the held S-tier tests (pure and worker level).
    name: "accepted-work-stier-evidence-unheld",
    file: "src/accepted-work/posterior.ts",
    from: "  const held = served?.fallbackOnly === true ? (\"fallback-only\" as const) : null;",
    to: "  const held = null;",
  },
  {
    // The 14-day censor: young cards are pending, never scored. Killed by the
    // censor-as-pending pure test.
    name: "accepted-work-omits-14-day-censor",
    file: "src/accepted-work/posterior.ts",
    from: "    const resolved = rows.filter((r) => r.rejected || input.nowMs - r.closedAtMs >= censorMs);",
    to: "    const resolved = rows.filter((r) => true);",
  },
  {
    // The false-positive control: deleting the no-stats capability guard
    // must fail. Killed by the existing "keeps tier and per-tier capable
    // independent" test in tests/benchmark-prior.spec.ts (verified by hand:
    // a low-prior no-stats model reads capable:false, true under the mutant).
    name: "accepted-work-capability-guard-removed",
    file: "src/engine/scores.ts",
    from: "          capable: pp >= capabilityThresholds[tier],",
    to: "          capable: true,",
  },
  {
    // The report tool must actually be registered under its own name (same
    // shape as the aa-free precedent). Killed by the registry test, which
    // executes every TOOL_NAMES entry.
    name: "accepted-work-report-tool-never-registered",
    file: "src/worker.ts",
    from: "        TOOL_NAMES.acceptedWorkReport,",
    to: "        TOOL_NAMES.tierOutcomes,",
  },
  // --- : same-model env repair of a poisoned pin -----------------
  // Each is killed by tests/pin-env-repair.spec.ts (verified by hand).
  {
    // The repair pre-empts a writing pin path, so a fresh pin or an allowed
    // pace repin lands on the OLD model instead of the decision's.
    name: "env-repair-preempts-pin-path",
    file: "src/actuate/apply.ts",
    from: "  if (plan.write || decision.advisory || !context.hasExistingOverride || !context.envRepair) return plan;",
    to: "  if (decision.advisory || !context.hasExistingOverride || !context.envRepair) return plan;",
  },
  {
    // Enforcement off must still mean this plugin writes nothing at all.
    name: "env-repair-writes-in-advisory",
    file: "src/actuate/apply.ts",
    from: "  if (plan.write || decision.advisory || !context.hasExistingOverride || !context.envRepair) return plan;",
    to: "  if (plan.write || !context.hasExistingOverride || !context.envRepair) return plan;",
  },
  {
    // A stale-ref verdict without the assignee env is a guess ().
    name: "stale-refs-read-unknown-agent-env",
    file: "src/engine/context.ts",
    from: "  if (!existingOverrideEnv || agentEnv === null || agentEnv === undefined) return [];",
    to: "  if (!existingOverrideEnv) return [];\n  agentEnv = agentEnv ?? {};",
  },
  {
    // The host keys a binding on secret + path, not version.
    name: "stale-refs-compare-version",
    file: "src/engine/context.ts",
    from: "  return typeof ref === \"string\" && ref.length > 0 ? `${String(record.type)}:${ref}` : null;",
    to: "  return typeof ref === \"string\" && ref.length > 0 ? `${String(record.type)}:${ref}:${String(record.version)}` : null;",
  },
  {
    // An optional user secret never blocks a run, so it is never stale.
    name: "stale-refs-enforce-optional-user-refs",
    file: "src/engine/context.ts",
    from: "    if (record.type === \"user_secret_ref\" && (record.required === false || record.allowMissingOverride === true)) {",
    to: "    if (false) {",
  },
  {
    name: "run-failure-repair-ignores-advisory",
    file: "src/worker.ts",
    from: "        if (!result || !result.hasOverride || result.decision.advisory) return;",
    to: "        if (!result || !result.hasOverride) return;",
  },
  {
    name: "run-failure-repair-any-error-code",
    file: "src/worker.ts",
    from: "        if (payload.errorCode === \"configuration_incomplete\") {",
    to: "        if (typeof payload.errorCode === \"string\") {",
  },
  {
    // The apply-path repair must not start the pace-repin hysteresis clock.
    name: "apply-env-repair-logs-as-a-pin",
    file: "src/worker.ts",
    from: "          if (plan.envRepairOnly) {\n            await ctx.activity.log({",
    to: "          if (false) {\n            await ctx.activity.log({",
  },
  // ---  named mutants: run-scoped model decision -------------------
  // Tests: tests/run-resolve.spec.ts, tests/run-resolve-worker.spec.ts,
  // tests/hot-cache.spec.ts. The creation-path `runScoped` early return in
  // `pinAtDecisionTime` is deliberately NOT mutated: `pinAtTier` repeats the
  // same guard, so removing either copy alone is equivalent (defense in depth).
  {
    // The tier-change switch: without it a raised tier is declined by the
    // engine's own floor gate (reported as `unserviceable`) and a LOWERED tier
    // keeps the pricier incumbent forever. Killed by both tier-change tests.
    name: "run-resolve-sticky-ignores-tier-change",
    file: "src/engine/run-resolve.ts",
    from: "    if (prior.tier !== null && prior.tier !== currentTier) {",
    to: "    if (false && prior.tier !== null && prior.tier !== currentTier) {",
  },
  {
    // The unserviceable switch: a model on a stopped lane would be kept
    // because it is "sticky". Killed by the stopped-lane test.
    name: "run-resolve-sticky-never-leaves-unserviceable",
    file: "src/engine/run-resolve.ts",
    from: "    } else if (!probeKeeps) {",
    to: "    } else if (false && !probeKeeps) {",
  },
  {
    // The fallback-recovery switch: a card that landed on a fallback during an
    // outage would ride it for ever. Killed by the primary-recovered test.
    name: "run-resolve-never-revisits-fallback",
    file: "src/engine/run-resolve.ts",
    from: "    } else if (prior.fallback && !out) {",
    to: "    } else if (false && prior.fallback && !out) {",
  },
  {
    // A kept fallback must stay a fallback, or the NEXT run cannot see that it
    // is still sitting on one. Killed by the primary-still-down test.
    name: "run-resolve-fallback-flag-lost-on-keep",
    file: "src/engine/run-resolve.ts",
    from: "  const fallback = keptPrior ? prior.fallback : isFallbackDecision(chosen, roster);",
    to: "  const fallback = isFallbackDecision(chosen, roster);",
  },
  {
    // Returning the agent's env alongside the decision's: the exact secret-copy
    // class this design exists to remove. Killed by the env-allowlist tests.
    name: "run-resolve-returns-agent-env",
    file: "src/engine/run-resolve.ts",
    from: "      ...(Object.keys(env).length > 0 ? { env } : {}),",
    to: "      env: { ...(agentEnv as Record<string, string>), ...env },",
  },
  {
    // Writing a declared key the agent binds to a secret makes the host refuse
    // the whole decision. Killed by the secret-bound-key test.
    name: "run-resolve-writes-secret-bound-key",
    file: "src/engine/run-resolve.ts",
    from: "    if (!RUN_RESOLVE_ENV_KEYS.includes(key) || secretBound(key)) return;",
    to: "    if (!RUN_RESOLVE_ENV_KEYS.includes(key)) return;",
  },
  {
    // Nothing serviceable must park the run, never read as "use the default".
    // Killed by the pure and worker defer tests.
    name: "run-resolve-no-eligible-model-keeps-default",
    file: "src/engine/run-resolve.ts",
    from: '    return defer("no serviceable model", decision);',
    to: '    return { kind: "keep", reason: "no serviceable model" };',
  },
  {
    // The 1 s cap on waiting for a classification. Killed by the give-up test.
    name: "run-resolve-classifier-wait-uncapped",
    file: "src/worker.ts",
    from: "              Math.min(config.runResolve.classifierWaitMs, Math.max(0, remaining() - 50)),",
    to: "              Math.max(0, remaining() - 50),",
  },
  {
    // An unexpected failure must defer, never fall through to the default.
    // Killed by the unreadable-agent and cold-snapshot tests.
    name: "run-resolve-error-keeps-default",
    file: "src/worker.ts",
    from: '          return finish({ kind: "defer", retryAfterMs: deferRetryMs, reason }, "defer");',
    to: '          return finish({ kind: "keep" }, "keep.error");',
  },
  {
    // The flag/enforce gate on the handler. Killed by the flag-off and
    // advisory tests.
    name: "run-resolve-routes-while-inactive",
    file: "src/worker.ts",
    from: '          if (!runResolveActive(config)) return finish({ kind: "keep" }, "keep.inactive");',
    to: '          if (false && !runResolveActive(config)) return finish({ kind: "keep" }, "keep.inactive");',
  },
  // ---  named mutants: the quota document through the sticky rule ---
  // Tests: tests/run-resolve.spec.ts ("sticky rule against the published quota
  // document") and tests/run-resolve-worker.spec.ts ("quota document on the
  // worker"). Every earlier run-resolve case built its snapshot with
  // `availabilityRaw: null`, so none of these changed a single prior verdict.
  {
    // The resolver reads no quota document: an incumbent on an exhausted or
    // cooling lane is kept because it is "sticky", and with
    // `holdOnUnknownAvailability` on a healthy document reads as UNKNOWN.
    // Killed by the exhausted-window, live-cooldown and every unknown-state
    // pair in the pure matrix.
    name: "run-resolve-ignores-published-quota-document",
    file: "src/engine/run-resolve.ts",
    from: "  const availability = normalizeAvailability(snapshot.availabilityRaw, now);",
    to: "  const availability = normalizeAvailability(null, now);",
  },
  {
    // The document is judged at the snapshot's load time, not the decision's:
    // a document that aged past the cutoff inside the cached snapshot keeps
    // reading as fresh. Killed by the aged-inside-a-cached-snapshot test.
    name: "run-resolve-reads-quota-document-at-load-time",
    file: "src/engine/run-resolve.ts",
    from: "  const availability = normalizeAvailability(snapshot.availabilityRaw, now);",
    to: "  const availability = normalizeAvailability(snapshot.availabilityRaw, snapshot.loadedAtMs);",
  },
  {
    // The worker never loads the published document into the run snapshot, so
    // the lane poller's exhaustion never reaches an enforced run. Killed by the
    // worker-level switch test.
    name: "run-resolve-snapshot-drops-quota-document",
    file: "src/worker.ts",
    from: "          ctx.state.get(laneAvailabilityKey(companyId)),\n          readLaneEvidence(companyId, config.models, loadedAtMs),",
    to: "          Promise.resolve(null),\n          readLaneEvidence(companyId, config.models, loadedAtMs),",
  },
  {
    // The pin retirements: each writer keeps pinning once decisions are live.
    // Killed by the paired off/on tests.
    name: "retire-label-only-pass-not-applied",
    file: "src/worker.ts",
    from: "            if (runResolveActive(config)) {\n              ctx.logger.info(\"label-only pass skipped",
    to: "            if (false && runResolveActive(config)) {\n              ctx.logger.info(\"label-only pass skipped",
  },
  {
    name: "retire-balance-pass-not-applied",
    file: "src/worker.ts",
    from: "            if (runResolveActive(config)) {\n              ctx.logger.info(\"balance pass skipped",
    to: "            if (false && runResolveActive(config)) {\n              ctx.logger.info(\"balance pass skipped",
  },
  {
    name: "retire-repin-pass-not-applied",
    file: "src/worker.ts",
    from: "            if (runResolveActive(config)) return { repinned: 0, budgetExhausted: false, slowestRowMs: repinSlowestRowMs };",
    to: "            if (false && runResolveActive(config)) return { repinned: 0, budgetExhausted: false, slowestRowMs: repinSlowestRowMs };",
  },
  {
    name: "retire-creation-pin-not-applied",
    file: "src/worker.ts",
    from: "        if (runResolveActive(config)) return null;\n        const { tier, expectedPinnedModelId, receivedAtMs } = attempt;",
    to: "        if (false && runResolveActive(config)) return null;\n        const { tier, expectedPinnedModelId, receivedAtMs } = attempt;",
  },
  {
    // A stale entry must be served, not re-awaited: dropping the fresh-hit
    // return makes every warm read refresh. Killed by the zero-host-reads test.
    name: "hot-cache-fresh-hit-refreshes",
    file: "src/hot-cache.ts",
    from: "      if (cached.ageMs < this.options.ttlMs) return { ...cached, stale: false };",
    to: "      if (false) return { ...cached, stale: false };",
  },
  {
    // Single flight: concurrent cold callers must share one load.
    name: "hot-cache-loses-single-flight",
    file: "src/hot-cache.ts",
    from: "    if (running) return running;",
    to: "    if (false) return running as Promise<V>;",
  },
  {
    // The cold-load budget: without it a cold snapshot holds the run past the
    // host deadline. Killed by the budget test.
    name: "hot-cache-cold-load-unbounded",
    file: "src/hot-cache.ts",
    from: "      const value = await Promise.race([pending, budget]);",
    to: "      const value = await pending;",
  },
  // --- : tier capability is monotone, promotions stop at it ------
  // Killed by tests/scores.spec.ts, tests/benchmark-prior.spec.ts and
  // tests/pick-order.spec.ts respectively (verified by hand).
  {
    // A glm-5.3 shape (T2 measured-fail, T1 prior-only) reads T1-capable again.
    name: "capability-not-monotone-at-build",
    file: "src/engine/scores.ts",
    from: "  const monotoneTierScores = enforceMonotoneCapability(tierScores);",
    to: "  const monotoneTierScores = tierScores;",
  },
  {
    // A derived tier promotes past the hardest tier the model is capable at.
    name: "promotion-ignores-capability-ceiling",
    file: "src/engine/scores.ts",
    from: "      if (tierIndex(target) > tierIndex(ceiling)) return { ...model, tier: ceiling };",
    to: "",
  },
  {
    // Selection reads a score stored before the rule existed without it.
    name: "selection-reads-raw-tier-verdict",
    file: "src/engine/select.ts",
    from: "    const score = tierScoreFor(modelScore, requiredTier);",
    to: "    const score = modelScore?.tiers?.[requiredTier];",
  },
  // the lane quota snapshot -> shadow observation adapter. Utilization-only
  // observations are advisory attainment; identity is the committed table only.
  {
    name: "obs-cached-observation-not-stale",
    file: "src/admission-observation.ts",
    from: "      if (record && observationQuality === 'cached') raise('stale', 'cached-observation');",
    to: "      if (false && record && observationQuality === 'cached') raise('stale', 'cached-observation');",
  },
  {
    name: "obs-max-age-boundary-exclusive",
    file: "src/admission-observation.ts",
    from: "observedAt !== null && input.now - observedAt > input.maxAgeMs;",
    to: "observedAt !== null && input.now - observedAt >= input.maxAgeMs;",
  },
  {
    name: "obs-too-old-never-stale",
    file: "src/admission-observation.ts",
    from: "      if (tooOld) raise('stale', 'older-than-max-age');",
    to: "      if (false) raise('stale', 'older-than-max-age');",
  },
  {
    name: "obs-missing-reset-only-unknown",
    file: "src/admission-observation.ts",
    from: "raise('invalid', 'missing-reset')",
    to: "raise('unknown', 'missing-reset')",
  },
  {
    name: "obs-reset-jitter-not-snapped",
    file: "src/admission-observation.ts",
    from: "        : Math.round(reportedResetMs / RESET_IDENTITY_GRID_MS) * RESET_IDENTITY_GRID_MS;",
    to: "        : reportedResetMs;",
  },
  {
    name: "obs-missing-utilization-becomes-zero",
    file: "src/admission-observation.ts",
    from: "        quota: utilization !== null && !countsOnly ? 1 : null,\n        consumed: countsOnly ? null : utilization,",
    to: "        quota: 1,\n        consumed: countsOnly ? null : (utilization ?? 0),",
  },
  {
    name: "obs-counts-only-keeps-utilization",
    file: "src/admission-observation.ts",
    from: "      const countsOnly = observationQuality === 'counts-only';",
    to: "      const countsOnly = false;",
  },
  {
    name: "obs-unlabelled-observation-accepted",
    file: "src/admission-observation.ts",
    from: "        else if (observationQuality === null) raise('unknown', 'observation-quality-missing-or-unrecognized');",
    to: "        else if (false) raise('unknown', 'observation-quality-missing-or-unrecognized');",
  },
  {
    name: "obs-reset-at-observation-accepted",
    file: "src/admission-observation.ts",
    from: "resetAt !== null && resetAt <= observedAt",
    to: "resetAt !== null && resetAt < observedAt",
  },
  {
    name: "obs-reset-beyond-window-accepted",
    file: "src/admission-observation.ts",
    from: "resetAt - observedAt > WINDOW_MS[window.kind]",
    to: "resetAt - observedAt > WINDOW_MS[window.kind] * 100",
  },
  {
    // numeric epochs above 8.64e15 must be rejected, not thrown on.
    name: "obs-epoch-above-max-accepted",
    file: "src/admission-observation.ts",
    from: "  if (finiteObserved(value)) return value >= 0 && value <= MAX_EPOCH_MS ? value : null;",
    to: "  if (finiteObserved(value)) return value >= 0 ? value : null;",
  },
  {
    name: "obs-weekly-window-length-wrong",
    file: "src/admission-observation.ts",
    from: "  weekly: 7 * 24 * 60 * 60 * 1000,",
    to: "  weekly: 6 * 24 * 60 * 60 * 1000,",
  },
  {
    name: "obs-five-hour-window-length-wrong",
    file: "src/admission-observation.ts",
    from: "  'five-hour': 5 * 60 * 60 * 1000,",
    to: "  'five-hour': 4 * 60 * 60 * 1000,",
  },
  {
    name: "obs-shared-pool-double-counted",
    file: "src/admission-observation.ts",
    from: "      if (!seen.has(print)) {",
    to: "      if (true) {",
  },
  {
    name: "obs-shared-pool-conflict-not-detected",
    file: "src/admission-observation.ts",
    from: "filter(([, group]) => group.size > 1)",
    to: "filter(([, group]) => group.size > 99)",
  },
  {
    name: "obs-duplicate-lane-binding-allowed",
    file: "src/admission-observation.ts",
    from: "    if (lanes.has(entry.laneId)) throw new Error('duplicate-lane-binding');",
    to: "    if (false && lanes.has(entry.laneId)) throw new Error('duplicate-lane-binding');",
  },
  {
    name: "obs-record-n-lane-binding-allowed",
    file: "src/admission-observation.ts",
    from: "if (![entry.laneId, entry.accountId, entry.poolId, entry.providerId].every(stableBudgetId)) {",
    to: "if (![entry.accountId, entry.poolId, entry.providerId].every(stableBudgetId)) {",
  },
  {
    name: "obs-shared-pool-mixed-provider-allowed",
    file: "src/admission-observation.ts",
    from: "    if (pool && (pool.providerId !== entry.providerId || pool.kinds !== key)) throw",
    to: "    if (pool && false) throw",
  },
  {
    name: "obs-unstable-lane-echoed",
    file: "src/admission-observation.ts",
    from: "    if (!stableBudgetId(lane)) { unstableLaneCount += 1; continue; }",
    to: "    if (false) { unstableLaneCount += 1; continue; }",
  },
  {
    name: "obs-duplicate-lane-record-picks-first",
    file: "src/admission-observation.ts",
    from: "    const record = records.length === 1 ? records[0]! : null;",
    to: "    const record = records[0] ?? null;",
  },
  {
    name: "obs-utilization-only-computes-budget",
    file: "src/admission-budget.ts",
    from: "  if (utilizationOnly) {\n    return {",
    to: "  if (false && utilizationOnly) {\n    return {",
  },
  {
    name: "obs-utilization-only-requires-plan-weight",
    file: "src/admission-budget.ts",
    from: "if (!(utilizationOnly && (field",
    to: "if (!(false && (field",
  },
  {
    name: "obs-source-invalid-downgraded-to-unknown",
    file: "src/admission-budget.ts",
    from: "if (invalid.length || raw.dataState === 'invalid') result.dataState = 'invalid';",
    to: "if (invalid.length) result.dataState = 'invalid';",
  },
  {
    name: "obs-utilization-only-binding-admittable",
    file: "src/admission-budget.ts",
    from: "w.dataState !== 'known' || w.raw.unit === UTILIZATION_ONLY_UNIT)) {",
    to: "w.dataState !== 'known')) {",
  },
  {
    name: "obs-utilization-only-counts-as-known-allowance",
    file: "src/admission-shadow.ts",
    from: "\n          && w.safeBudget !== null))) {",
    to: "\n          ))) {",
  },
  {
    name: "obs-snapshot-accepts-explicit-accounts",
    file: "src/admission-shadow.ts",
    from: "fields(rawInput, ['enabled', 'cohortId', 'maxAgeMs', 'laneQuotaSnapshot', 'holds', 'bindings']);",
    to: "fields(rawInput, ['enabled', 'cohortId', 'maxAgeMs', 'laneQuotaSnapshot', 'holds', 'bindings', 'accounts', 'windows']);",
  },
  {
    name: "obs-adapter-provenance-dropped",
    file: "src/admission-shadow.ts",
    from: "      report.observationAdapter = { schema, evidenceKind",
    to: "      void { schema, evidenceKind",
  },
  {
    // the committed Meta lanes come from live-document evidence.
    // Dropping one must surface as unmapped, never as a silent pass.
    name: "obs-meta-binding-dropped",
    file: "src/admission-lane-bindings.ts",
    from: "  { laneId: 'meta-lane-4', accountId: 'meta-acct-4', poolId: 'meta-pool-4', providerId: 'meta', windows: [FIVE_HOUR, WEEKLY] },\n",
    to: "",
  },
  // ---  named mutants: reassignment re-home and the fallback lease --
  // Each guard is removed, weakened or rescoped once; every mutant below was
  // hand-applied and watched failing the named test in
  // tests/reassignment-and-fallback-lease.spec.ts (or tests/context.spec.ts).
  // Two guards are deliberately absent: the re-home's first moved-on check
  // and its described-assignee check are each masked by the final fresh read
  // and the clear path's own assignee check, so removing either alone changes
  // no write (defense in depth, documented on the PR).
  {
    // Killed by: rebuilds the pin from the new assignee's env.
    name: "reassign-arm-removed",
    file: "src/worker.ts",
    from: "        } else if (issueId && assignedTo && assignedFrom && assignedFrom !== assignedTo) {",
    to: "        } else if (false) {",
  },
  {
    // Killed by: does not write a card whose override carries no env.
    name: "rehome-writes-envless-override",
    file: "src/worker.ts",
    from: "        if (adapterConfig.env == null) return;\n        const rawPinnedModelId",
    to: "        const rawPinnedModelId",
  },
  {
    // Killed by: rebuilds the pin from the new assignee's env (no A-only binding).
    name: "rehome-rebuilds-from-old-env",
    file: "src/worker.ts",
    from: "            agentEnv: described.agentEnv,\n            agentAdapterType: described.agentAdapterType,\n            agentAdapterConfig: described.agentAdapterConfig,\n            existingOverrideEnv: described.existingOverrideEnv,\n            cheapModelId: cheapestHealthyModelIdForTier({",
    to: "            agentEnv: described.existingOverrideEnv ?? described.agentEnv,\n            agentAdapterType: described.agentAdapterType,\n            agentAdapterConfig: described.agentAdapterConfig,\n            existingOverrideEnv: described.existingOverrideEnv,\n            cheapModelId: cheapestHealthyModelIdForTier({",
  },
  {
    // Killed by: clears the env when the new assignee's env cannot be read.
    name: "rehome-rebuilds-over-unknown-env",
    file: "src/worker.ts",
    from: "          described.assigneeAgentId === toAgentId &&\n          described.agentEnv !== null &&\n",
    to: "          described.assigneeAgentId === toAgentId &&\n",
  },
  {
    // Killed by: clears the env on a closed card.
    name: "rehome-rebuilds-closed-card",
    file: "src/worker.ts",
    from: "          described.agentEnv !== null &&\n          balanceOpenStatuses.has(described.status) &&\n          !described.hasOperatorPin\n",
    to: "          described.agentEnv !== null &&\n          !described.hasOperatorPin\n",
  },
  {
    // Killed by: clears the env on an operator-pinned card.
    name: "rehome-rebuilds-operator-pin",
    file: "src/worker.ts",
    from: "          balanceOpenStatuses.has(described.status) &&\n          !described.hasOperatorPin\n        ) {\n          const patch = modelOverrideForContext({",
    to: "          balanceOpenStatuses.has(described.status)\n        ) {\n          const patch = modelOverrideForContext({",
  },
  {
    // Killed by: carries a fallback pin's stamp to the new home.
    name: "rehome-drops-stamp",
    file: "src/worker.ts",
    from: "            provenance: readPinProvenance(described.existingOverrideEnv),\n",
    to: "            provenance: null,\n",
  },
  {
    // Killed by: does not write when the card moves on after the assignee read.
    name: "rehome-skips-fresh-assignee-check",
    file: "src/worker.ts",
    from: "            fresh?.assigneeAgentId === toAgentId &&\n            freshModel === adapterConfig.model &&",
    to: "            freshModel === adapterConfig.model &&",
  },
  {
    // Killed by: rebuilds the pin from the new assignee's env.
    name: "rehome-fresh-check-rescoped-to-old-assignee",
    file: "src/worker.ts",
    from: "            fresh?.assigneeAgentId === toAgentId &&\n            freshModel === adapterConfig.model &&",
    to: "            fresh?.assigneeAgentId === fromAgentId &&\n            freshModel === adapterConfig.model &&",
  },
  {
    // Killed by: clears rather than rebuilds when the pin changes.
    name: "rehome-skips-fresh-model-check",
    file: "src/worker.ts",
    from: "            fresh?.assigneeAgentId === toAgentId &&\n            freshModel === adapterConfig.model &&\n            (await pinnableBeforeStart(companyId, issueId))",
    to: "            fresh?.assigneeAgentId === toAgentId &&\n            (await pinnableBeforeStart(companyId, issueId))",
  },
  {
    // Killed by: clears the env, keeping the model, once a run has started.
    name: "rehome-rebuilds-under-started-run",
    file: "src/worker.ts",
    from: "            freshModel === adapterConfig.model &&\n            (await pinnableBeforeStart(companyId, issueId))\n",
    to: "            freshModel === adapterConfig.model &&\n            true\n",
  },
  {
    // Killed by: does not write when the card moves on after the first issue read.
    name: "clear-ignores-moved-on",
    file: "src/worker.ts",
    from: "        const current = await ctx.issues.get(issueId, companyId);\n        if (!current || current.assigneeAgentId !== toAgentId) return;",
    to: "        const current = await ctx.issues.get(issueId, companyId);\n        if (!current) return;",
  },
  {
    // Killed by: clears the env, keeping the model, once a run has started.
    name: "clear-keeps-old-env",
    file: "src/worker.ts",
    from: "        delete keptAdapterConfig.env;\n        delete overrides.adapterConfig;",
    to: "        delete overrides.adapterConfig;",
  },
  {
    // Killed by: stamps and indexes the fallback pin the repin pass writes.
    name: "provenance-never-stamps",
    file: "src/worker.ts",
    from: "        model.fallbackOnly === true\n          ? { decisionId: randomUUID(), agentId, fallback: true, decidedAt: new Date().toISOString() }",
    to: "        false\n          ? { decisionId: randomUUID(), agentId, fallback: true, decidedAt: new Date().toISOString() }",
  },
  {
    // Killed by: writes no stamp and no index entry for a regular pin.
    name: "provenance-stamps-every-pin",
    file: "src/worker.ts",
    from: "        model.fallbackOnly === true\n          ? { decisionId: randomUUID(), agentId, fallback: true, decidedAt: new Date().toISOString() }",
    to: "        true\n          ? { decisionId: randomUUID(), agentId, fallback: true, decidedAt: new Date().toISOString() }",
  },
  {
    // Killed by: bounds the index, evicting the oldest decision.
    name: "index-never-evicts",
    file: "src/worker.ts",
    from: "            if (entries.length > FALLBACK_PIN_INDEX_MAX) {",
    to: "            if (false) {",
  },
  {
    // Killed by: context.spec: drops an earlier pin's stamp when this pin carries none.
    name: "stamp-survives-unstamped-rewrite",
    file: "src/engine/context.ts",
    from: "  delete env[PIN_PROVENANCE_ENV_KEY];\n  if (input.provenance",
    to: "  if (input.provenance",
  },
  {
    // Killed by: context.spec: never writes a stamp-only env over an unknown assignee's env.
    name: "stamp-written-over-unknown-env",
    file: "src/engine/context.ts",
    from: "  if (input.provenance && (agentEnvKnown || Object.keys(env).length > 0)) {",
    to: "  if (input.provenance) {",
  },
  {
    // Killed by: re-decides a stamped fallback once a primary is serviceable again.
    name: "lease-pass-not-scheduled",
    file: "src/worker.ts",
    from: "          await runFallbackLeasePass(company.id);",
    to: "          void 0;",
  },
  {
    // Killed by: never touches a non-fallback pin.
    name: "lease-ignores-stamp",
    file: "src/worker.ts",
    from: "              !described ||\n              stamp?.decisionId !== entry.decisionId ||\n",
    to: "              !described ||\n",
  },
  {
    // Killed by: drops an entry whose stamp has been replaced by a later decision.
    name: "lease-stamp-presence-only",
    file: "src/worker.ts",
    from: "              !described ||\n              stamp?.decisionId !== entry.decisionId ||\n",
    to: "              !described ||\n              !stamp ||\n",
  },
  {
    // Killed by: drops entries on closed and operator-pinned cards.
    name: "lease-releases-operator-pin",
    file: "src/worker.ts",
    from: "              !pinnedModelId ||\n              described.hasOperatorPin ||\n",
    to: "              !pinnedModelId ||\n",
  },
  {
    // Killed by: drops entries on closed and operator-pinned cards.
    name: "lease-keeps-closed-entries",
    file: "src/worker.ts",
    from: "              described.hasOperatorPin ||\n              !balanceOpenStatuses.has(described.status)\n            ) {\n              dropped.set(issueId, entry.decisionId);",
    to: "              described.hasOperatorPin\n            ) {\n              dropped.set(issueId, entry.decisionId);",
  },
  {
    // Killed by: holds the fallback while no primary can take the card (no decision metric).
    name: "lease-primaries-include-fallbacks",
    file: "src/worker.ts",
    from: "            (model) => model.enabled && !model.fallbackOnly,\n          );\n\n          const dropped",
    to: "            (model) => model.enabled,\n          );\n\n          const dropped",
  },
  {
    // Killed by: holds the fallback while no primary can take the card (no decision metric).
    name: "lease-skips-primary-precheck",
    file: "src/worker.ts",
    from: "            if (!primaries.some((model) => usable(model.id))) continue;",
    to: "",
  },
  {
    // Killed by: caps the writes per firing.
    name: "lease-uncapped-writes",
    file: "src/worker.ts",
    from: "            if (released >= FALLBACK_LEASE_WRITE_LIMIT) break;",
    to: "",
  },
  {
    // Killed by: caps the examined entries per firing.
    name: "lease-uncapped-examine",
    file: "src/worker.ts",
    from: "          for (const [issueId, entry] of indexed.slice(0, FALLBACK_LEASE_EXAMINE_LIMIT)) {",
    to: "          for (const [issueId, entry] of indexed) {",
  },
  {
    // Killed by: caps the examined entries per firing and visits the unchecked ones next.
    name: "lease-no-rotation",
    file: "src/worker.ts",
    from: "              (a.checkedAt ?? \"\").localeCompare(b.checkedAt ?? \"\") || a.decidedAt.localeCompare(b.decidedAt),",
    to: "              a.decidedAt.localeCompare(b.decidedAt),",
  },
  {
    //  (review of the reviewer-rebased head): the three writers this
    // feature adds take the same single gate as the five scheduled/event pin
    // sites. Killed by the advisory re-home/lease tests, which run in BOTH
    // non-enforcing postures (advise mode and selection-disabled), so each
    // conjunct of selectionWritesAllowed is proven load-bearing.
    //
    // Killed by: advisory reassignment writes no rebuild patch.
    name: "rehome-rebuild-ignores-selection-gate",
    file: "src/worker.ts",
    from:
      "            if (writesAllowed) {\n" +
      "              await ctx.issues.update(issueId, patch as Parameters<typeof ctx.issues.update>[1], companyId);\n" +
      "              await recordFallbackPin(companyId, issueId, patch);",
    to:
      "            if (true) {\n" +
      "              await ctx.issues.update(issueId, patch as Parameters<typeof ctx.issues.update>[1], companyId);\n" +
      "              await recordFallbackPin(companyId, issueId, patch);",
  },
  {
    // Killed by: advisory reassignment clears no env either — #482 has no
    // hygiene exception.
    name: "rehome-clear-ignores-selection-gate",
    file: "src/worker.ts",
    from:
      "        if (writesAllowed) {\n" +
      "          await ctx.issues.update(\n" +
      "            issueId,\n" +
      "            { assigneeAdapterOverrides: Object.keys(overrides).length > 0 ? overrides : null } as Parameters<",
    to:
      "        if (true) {\n" +
      "          await ctx.issues.update(\n" +
      "            issueId,\n" +
      "            { assigneeAdapterOverrides: Object.keys(overrides).length > 0 ? overrides : null } as Parameters<",
  },
  {
    // Killed by: advisory lease release writes no patch AND must not drop the
    // index entry — an unwritten release keeps the lease findable.
    name: "lease-release-ignores-selection-gate",
    file: "src/worker.ts",
    from:
      "            if (writesAllowed) {\n" +
      "              await ctx.issues.update(issueId, patch as Parameters<typeof ctx.issues.update>[1], companyId);\n" +
      "              dropped.set(issueId, entry.decisionId);",
    to:
      "            if (true) {\n" +
      "              await ctx.issues.update(issueId, patch as Parameters<typeof ctx.issues.update>[1], companyId);\n" +
      "              dropped.set(issueId, entry.decisionId);",
  },
  {
    // the pre-write quarantine re-check is the only thing between
    // a stale-snapshot decision and a pin onto a quarantined lane. Inverting
    // it restores the 15:21:14Z defect exactly: every pass writes into the
    // dead lane and skips every healthy one.
    name: "pre-write-quarantine-check-inverted",
    file: "src/worker.ts",
    from: "        return !laneOutageExcluded(freshOutage, new Date().toISOString(), selectedModel);\n",
    to: "        return laneOutageExcluded(freshOutage, new Date().toISOString(), selectedModel);\n",
  },
  // T0 is an explicit-only rung. Each mutant removes one of the
  // admission boundaries, so a regression that lets implicit dispatch, derivation,
  // explore, earn-in or the router's own writes reach T0 goes red.
  {
    name: "t0-ceiling-defaults-to-top",
    file: "src/engine/tier.ts",
    from: "  return judgement.admittedCeiling ?? IMPLICIT_TIER_CEILING;",
    to: "  return judgement.admittedCeiling ?? \"T0\";",
  },
  {
    name: "t0-implicit-clamp-removed",
    file: "src/engine/tier.ts",
    from: "  if (tierRank(raw.tier) > tierRank(IMPLICIT_TIER_CEILING)) {",
    to: "  if (false) {",
  },
  {
    name: "t0-pin-provenance-ignored",
    file: "src/engine/tier.ts",
    from: "      (raw.source === \"issue-override\" && descriptor.pinProvenance === \"explicit\"));",
    to: "      raw.source === \"issue-override\");",
  },
  {
    name: "t0-label-no-longer-admits",
    file: "src/engine/tier.ts",
    from: "    (tierFromLabels(descriptor.labelNames) === \"T0\" ||",
    to: "    (false ||",
  },
  {
    name: "t0-exclusion-admits-t0",
    file: "src/engine/tier.ts",
    from: "  if (raw.source === \"capability-exclusion\") return { ...raw, admittedCeiling: IMPLICIT_TIER_CEILING };",
    to: "  if (raw.source === \"capability-exclusion\") return { ...raw, admittedCeiling: \"T0\" };",
  },
  {
    name: "t0-router-mints-tier-label",
    file: "src/engine/tier.ts",
    from: "  return tierRank(tier) <= tierRank(IMPLICIT_TIER_CEILING);",
    to: "  return true;",
  },
  {
    name: "t0-fallback-label-beats-exclusion",
    file: "src/engine/tier.ts",
    from: "  if (judgement.source === \"capability-exclusion\") return judgement.tier;\n",
    to: "",
  },
  {
    name: "t0-pool-includes-barred-rows",
    file: "src/engine/select.ts",
    from: "  const poolModels = config.models.filter((model) => tierIndex(model.tier) <= tierIndex(admittedCeiling));",
    to: "  const poolModels = config.models;",
  },
  {
    name: "t0-sticky-reads-full-roster",
    file: "src/engine/select.ts",
    from: "    const incumbent = poolModels.find(",
    to: "    const incumbent = config.models.find(",
  },
  {
    name: "t0-escalation-risk-ignores-ceiling",
    file: "src/engine/cost.ts",
    from: "  if (!above || tierIndex(above) > tierIndex(ceiling)) return 0;",
    to: "  if (!above) return 0;",
  },
  {
    name: "t0-derived-promotion-unclamped",
    file: "src/engine/scores.ts",
    from: "      const target = tierIndex(derived) > tierIndex(IMPLICIT_TIER_CEILING) ? IMPLICIT_TIER_CEILING : derived;",
    to: "      const target = derived;",
  },
  {
    name: "t0-explore-candidate-ceiling-dropped",
    file: "src/engine/pick-order.ts",
    from: "    (candidate) => !provenOf(candidate) && TIER_ORDER.indexOf(candidate.tier) <= ceilingRank,",
    to: "    (candidate) => !provenOf(candidate),",
  },
  {
    name: "t0-explore-required-tier-guard-widened",
    file: "src/engine/pick-order.ts",
    from: "    TIER_ORDER.indexOf(requiredTier) < ceilingRank &&",
    to: "    TIER_ORDER.indexOf(requiredTier) <= ceilingRank &&",
  },
  {
    name: "t0-free-earn-in-picks-t0",
    file: "src/engine/free-lane-earn-in.ts",
    from: "    if (TIER_ORDER.indexOf(candidate.tier) > TIER_ORDER.indexOf(IMPLICIT_TIER_CEILING)) continue;\n",
    to: "",
  },
  {
    name: "t0-apply-writes-t0-label",
    file: "src/actuate/apply.ts",
    from: " || !routerMayWriteTierLabel(tier)",
    to: "",
  },
  {
    name: "t0-score-threshold-equals-t1",
    file: "src/constants.ts",
    from: "{ T0: 0.9, T1: 0.85,",
    to: "{ T0: 0.85, T1: 0.85,",
  },
  {
    name: "t0-derivation-demotes-recorded-t0",
    file: "src/engine/scores.ts",
    from: "    if (tierIndex(model.tier) > tierIndex(IMPLICIT_TIER_CEILING)) return model;\n",
    to: "",
  },
  {
    name: "t0-balance-pass-pins-optin-down-to-t1",
    file: "src/worker.ts",
    from: '                const balancedTier: Tier = labelTier === "T0" ? "T0" : "T1";',
    to: '                const balancedTier: Tier = "T1";',
  },
  {
    name: "t0-empty-rung-fails-enforce",
    file: "src/config/resolve.ts",
    from: "      if (isImplicitlyAdmittedTier(t)) {",
    to: "      if (true) {",
  },
  // the guarded live migration moves three exact ids and nothing
  // else. Each mutant removes one of its refusals.
  {
    name: "t0-migration-leaves-fallback-only",
    file: "scripts/migrate-t0-roster.mjs",
    from: "    model.fallbackOnly = MIGRATED.fallbackOnly;\n",
    to: "",
  },
  {
    name: "t0-migration-skips-drift-check",
    file: "scripts/migrate-t0-roster.mjs",
    from: "    if (drift.length > 0) {\n      refusals.push(",
    to: "    if (false) {\n      refusals.push(",
  },
  {
    name: "t0-migration-substring-id-match",
    file: "scripts/migrate-t0-roster.mjs",
    from: "    if (isRecord(model) && model.id === id) hits.push({ model, ordinal });",
    to: "    if (isRecord(model) && String(model.id).includes(id)) hits.push({ model, ordinal });",
  },
  {
    name: "t0-migration-invents-missing-lane",
    file: "scripts/migrate-t0-roster.mjs",
    from: "    if (typeof model.laneId !== \"string\" || model.laneId.length === 0) {",
    to: "    if (false) {",
  },
  {
    name: "t0-migration-accepts-unattested-opus55",
    file: "scripts/migrate-t0-roster.mjs",
    from: "  if (receipt.opus55Attestation?.distinctRosterRowExists !== true) {",
    to: "  if (false) {",
  },
  {
    name: "t0-verify-ignores-fallback-only",
    file: "scripts/migrate-t0-roster.mjs",
    from: "    if (row.model.fallbackOnly !== MIGRATED.fallbackOnly) {",
    to: "    if (false) {",
  },
  {
    name: "t0-verify-ignores-unplanned-rows",
    file: "scripts/migrate-t0-roster.mjs",
    from: "    if (targets.includes(id)) continue;\n",
    to: "    continue;\n",
  },
  {
    name: "t0-migration-accepts-wrong-state",
    file: "scripts/migrate-t0-roster.mjs",
    from: "    if (model.tier !== INTERIM.tier || model.fallbackOnly !== INTERIM.fallbackOnly) {",
    to: "    if (false) {",
  },
  // the shadow verifier must not pass vacuously.
  {
    name: "t0-shadow-counts-optin-as-violation",
    file: "scripts/verify-t0-shadow.mjs",
    from: "    if (optedIn) continue;\n",
    to: "",
  },
  {
    name: "t0-shadow-ignores-costed-candidates",
    file: "scripts/verify-t0-shadow.mjs",
    from: "    if (picked || costed.length > 0) {",
    to: "    if (picked) {",
  },
  {
    name: "t0-shadow-passes-without-ceiling-marker",
    file: "scripts/verify-t0-shadow.mjs",
    from: "  else if (summary.ceilingMarkerDecisions === 0) verdict = \"insufficient-evidence\";\n",
    to: "",
  },
  {
    name: "t0-shadow-ignores-sample-minimum",
    file: "scripts/verify-t0-shadow.mjs",
    from: "  else if (summary.decisions < minDecisions) verdict = \"insufficient-evidence\";\n",
    to: "",
  },
  // spawnSync's default 1 MiB output cap SIGKILLs a mutant the suite
  // catches loudly and reports it as a host kill (BROKEN GATE). Each mutant is
  // killed by tests/mutation-gate-runtime.spec.ts.
  {
    name: "run-output-budget-back-to-default",
    file: "scripts/mutation-gate-runtime.mjs",
    from: "export const MUTATION_GATE_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;",
    to: "export const MUTATION_GATE_OUTPUT_LIMIT_BYTES = 1024 * 1024;",
  },
  {
    name: "run-output-budget-left-out-of-the-invocation",
    file: "scripts/mutation-gate-runtime.mjs",
    from: "    maxBuffer: MUTATION_GATE_OUTPUT_LIMIT_BYTES,\n",
    to: "",
  },
  {
    name: "run-output-budget-not-forwarded-to-spawnsync",
    file: "scripts/mutation-gate.mjs",
    from: "    maxBuffer,\n  });\n}\n",
    to: "  });\n}\n",
  },
  // the shard split and the impact gate decide what the sweep covers
  // and whether it may be skipped, so each is killed by a named spec in
  // tests/mutation-gate-runtime.spec.ts or tests/mutation-impact.spec.ts.
  {
    name: "shard-selection-slices-overlap",
    file: "scripts/mutation-gate-runtime.mjs",
    from: "position % shard.total === shard.index - 1",
    to: "position % shard.total <= shard.index - 1",
  },
  {
    name: "shard-empty-spec-means-unsharded",
    file: "scripts/mutation-gate-runtime.mjs",
    from: "if (spec === undefined || spec === null) return null;",
    to: "if (spec === undefined || spec === null || `${spec}`.trim() === \"\") return null;",
  },
  {
    name: "impact-plugin-prefix-loses-trailing-slash",
    file: "scripts/mutation-impact.mjs",
    from: "Object.freeze([\"plugins/model-selection/\"])",
    to: "Object.freeze([\"plugins/model-selection\"])",
  },
  {
    name: "impact-unusable-base-reads-clean",
    file: "scripts/mutation-impact.mjs",
    from: "if (resolved.base === undefined) return { impacted: true, reason: resolved.reason, matched: [] };",
    to: "if (resolved.base === undefined) return { impacted: false, reason: resolved.reason, matched: [] };",
  },
  {
    name: "impact-missing-base-reads-clean",
    file: "scripts/mutation-impact.mjs",
    from: "return { impacted: true, reason: `base ${base} is unavailable (force-push or fetch failure)`, matched: [] };",
    to: "return { impacted: false, reason: `base ${base} is unavailable (force-push or fetch failure)`, matched: [] };",
  },
  {
    name: "impact-failed-diff-reads-clean",
    file: "scripts/mutation-impact.mjs",
    from: "return { impacted: true, reason: `git diff ${base}..HEAD failed`, matched: [] };",
    to: "return { impacted: false, reason: `git diff ${base}..HEAD failed`, matched: [] };",
  },
  {
    name: "impact-diff-loses-nul-separation",
    file: "scripts/mutation-impact.mjs",
    from: "[\"diff\", \"--name-only\", \"-z\", \"--no-renames\", base, \"HEAD\", \"--\"]",
    to: "[\"diff\", \"--name-only\", \"--no-renames\", base, \"HEAD\", \"--\"]",
  },
  {
    name: "impact-diff-collapses-renames",
    file: "scripts/mutation-impact.mjs",
    from: "[\"diff\", \"--name-only\", \"-z\", \"--no-renames\", base, \"HEAD\", \"--\"]",
    to: "[\"diff\", \"--name-only\", \"-z\", base, \"HEAD\", \"--\"]",
  },
];

// `--maxWorkers=2` is load-bearing, not tuning. At vitest's default worker
// count this suite is OOM-killed (rc=137) whenever the host is busy, and the
// gate reports that as "baseline suite is red" / a KILLED mutant — a verdict
// that depends on machine load rather than on the code. Observed 2026-09-17:
// the same tree passed 27/27 and then failed its own baseline minutes later
// while a second run shared the host.

/**
 * Optional comma-separated name filter, e.g.
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

/**
 * `MUTATION_SHARD=i/N` runs the i-th of N round-robin slices of the
 * list, so CI can spread the ~300-mutant sweep over N jobs instead of one
 * serial ~3h step. Everything else stays per shard — both baselines, the
 * per-mutant deadline, the fork cap, every assertion — and a shard is never
 * reported as the full pass: its summary names the slice and the total, and
 * "all shards green" is the only thing that means the sweep passed. A set but
 * malformed value, an empty slice, or sharding combined with `MUTANTS` is a
 * BROKEN GATE, never a silent run of everything or of nothing.
 */
let shard = null;
try {
  shard = parseMutationShard(process.env.MUTATION_SHARD);
} catch (error) {
  process.stderr.write(`BROKEN GATE: ${error.message}\n`);
  process.exit(1);
}
if (shard !== null && mutantFilter.length > 0) {
  process.stderr.write("BROKEN GATE: MUTATION_SHARD and MUTANTS are mutually exclusive — a shard of a filtered list is not a slice of the sweep\n");
  process.exit(1);
}
const selected = shard !== null
  ? selectMutationShard(mutants, shard)
  : mutantFilter.length > 0
    ? mutants.filter((mutant) => mutantFilter.includes(mutant.name))
    : mutants;
if (shard !== null && selected.length === 0) {
  process.stderr.write(`BROKEN GATE: shard ${shard.index}/${shard.total} selects no mutants (of ${mutants.length}) — a shard that runs nothing would report green\n`);
  process.exit(1);
}
if (mutantFilter.length > 0) {
  const unknown = mutantFilter.filter((name) => !mutants.some((mutant) => mutant.name === name));
  if (unknown.length > 0) {
    process.stderr.write(`BROKEN GATE: unknown mutant name(s): ${unknown.join(", ")}\n`);
    process.exit(1);
  }
}

function runTests(cwd = root) {
  const { args, env, timeout, killSignal, maxBuffer } = mutationGateVitestInvocation();
  return spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    env,
    // bound each run individually. Without this one wedged mutant
    // spends the job's whole `timeout-minutes` and the job dies with no mutant
    // name; `completed()` below turns the timeout kill into a BROKEN GATE that
    // says which one.
    timeout,
    killSignal,
    // spawnSync's 1 MiB default turns a mutant that fails loudly into
    // a SIGKILL that looks like a host kill; see the constant's note.
    maxBuffer,
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
  // rc=137 is SIGKILL — almost always the OOM killer, not a failing assertion.
  // Saying so inline stops the next reader from debugging a test that is fine.
  const oom = baseline.status === 137 || baseline.signal === "SIGKILL";
  process.stderr.write(
    oom
      ? "BROKEN GATE: baseline suite was OOM-killed (rc=137), not red. Re-run with less concurrent load.\n"
      : "BROKEN GATE: baseline suite is red\n",
  );
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

  // Positive control (). The loop below scores EVERY nonzero exit as a
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
if (shard !== null) {
  console.log(`mutation gate shard ${shard.index}/${shard.total}: ${selected.length}/${selected.length} killed (of ${mutants.length})`);
  process.exit(0);
}
if (selected.length !== mutants.length) {
  console.log(`mutation gate PARTIAL: ${selected.length}/${mutants.length} mutants run, all killed — NOT a passing gate`);
  process.exit(0);
}
console.log(`mutation gate: ${mutants.length}/${mutants.length} killed`);
