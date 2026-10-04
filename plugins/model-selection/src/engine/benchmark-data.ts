import type { BenchmarkRow } from "./benchmark-prior.js";

/**
 * Frozen `tog2636-v1` benchmark vectors, keyed by roster model id.
 *
 * GENERATED, then committed — do not hand-edit. Source: Research A's
 * primary-source leaderboard captures (fetched 2026-09-15), joined to
 * the roster by the benchmark-table builder and frozen here by
 * Regenerate with that script and bump `BENCHMARK_SPEC_VERSION`
 * whenever the capture is refreshed.
 *
 * ## Why this is frozen rather than read live from the aa.ai snapshot
 *
 * Only two of the five benchmarks exist in the plugin's own aa.ai parser
 * (`terminalbenchV40`, `omniscience`); Mercor APEX 1.1, AutomationBench's
 * guardrail-adjusted partial, and DeepSWE v1.1 are not aa.ai columns at all and
 * have no live source here. Reading the two live and the other three frozen
 * would silently mix effort levels — aa.ai publishes one row per
 * (model × effort), and the live row matched for a model is frequently a
 * different effort than the one the capture joined (e.g. `claude-opus-5-xhigh`
 * carries `terminalbenchV40: null` while the capture's matched row has a value).
 * A prior blended across two effort levels is not reproducible, which is the
 * churn this design exists to end. So the vector is taken whole, from one
 * capture, under one version.
 *
 * The aa.ai composite index stays LIVE — that half of the blend is refreshed
 * every `refreshScores` run, which is the settled design.
 *
 * ## Absence
 *
 * A field is omitted when the model is not on that leaderboard. Omitted is not
 * zero: `benchmarkPrior` drops it from both numerator and available weight.
 * `deepSweV11Pass1` is absent for every model in this capture — DeepSWE v1.1
 * had published no overlapping rows at capture time — so `D` currently never
 * contributes and the maximum attainable weight is 0.85.
 */
export const FROZEN_BENCHMARK_ROWS: Readonly<Record<string, BenchmarkRow>> = {
  "claude-fable-5-1": { terminalBenchV4Pass1: 0.52020202020202, mercorApex11Pass1: 0.6859999999999999, automationBenchAaGuardrailAdjusted: 0.5937591715646424, aaOmniscienceSignedIndex: 43.45 },
  "claude-haiku-4-5-20251001": { aaOmniscienceSignedIndex: -7.56666666666667 },
  "claude-opus-5": { terminalBenchV4Pass1: 0.48989898989899, mercorApex11Pass1: 0.6579999999999999, automationBenchAaGuardrailAdjusted: 0.565735557649325, aaOmniscienceSignedIndex: 37.0666666666667 },
  "claude-sonnet-5": { terminalBenchV4Pass1: 0.141414141414141, aaOmniscienceSignedIndex: 16.45 },
  "deepseek-v4-flash": { terminalBenchV4Pass1: 0.121212121212121, aaOmniscienceSignedIndex: -14.2833333333333 },
  "deepseek-v4-flash-free": { terminalBenchV4Pass1: 0.121212121212121, aaOmniscienceSignedIndex: -14.2833333333333 },
  "deepseek-v4-flash-vision-exp": { terminalBenchV4Pass1: 0.121212121212121, aaOmniscienceSignedIndex: -17.6333333333333 },
  "deepseek-v4-pro": { terminalBenchV4Pass1: 0.141414141414141, automationBenchAaGuardrailAdjusted: 0.5671165546344002, aaOmniscienceSignedIndex: 0.833333333333333 },
  "deepseek-v4.1-flash": { terminalBenchV4Pass1: 0.267676767676768, automationBenchAaGuardrailAdjusted: 0.6889097769674057, aaOmniscienceSignedIndex: -5.3 },
  "gemini-3-flash": { aaOmniscienceSignedIndex: -4.31666666666667 },
  "gemini-3.6-flash-high": { terminalBenchV4Pass1: 0.0707070707070707, mercorApex11Pass1: 0.469, aaOmniscienceSignedIndex: 22.1333333333333 },
  "gemini-3.7-flash-high": { terminalBenchV4Pass1: 0.136363636363636, mercorApex11Pass1: 0.6779999999999999, aaOmniscienceSignedIndex: 26.4833333333333 },
  "gemini-3.8-flash-high": { terminalBenchV4Pass1: 0.196969696969697, mercorApex11Pass1: 0.643, automationBenchAaGuardrailAdjusted: 0.5993009432118243, aaOmniscienceSignedIndex: 29.55 },
  "glm-5": { aaOmniscienceSignedIndex: 0.266666666666667 },
  "glm-5.1": { terminalBenchV4Pass1: 0.0202020202020202, aaOmniscienceSignedIndex: 0.85 },
  "glm-5.2": { terminalBenchV4Pass1: 0.0101010101010101, aaOmniscienceSignedIndex: 4.43333333333333 },
  "glm-5.3": { terminalBenchV4Pass1: 0.419191919191919, mercorApex11Pass1: 0.5660000000000001, automationBenchAaGuardrailAdjusted: 0.622028649962642, aaOmniscienceSignedIndex: 14.3 },
  "glm-5.3-flash": { terminalBenchV4Pass1: 0.328282828282828, mercorApex11Pass1: 0.528, automationBenchAaGuardrailAdjusted: 0.6036862782167782, aaOmniscienceSignedIndex: 7.46666666666667 },
  "gpt-5.5": { terminalBenchV4Pass1: 0.146464646464646, mercorApex11Pass1: 0.551, aaOmniscienceSignedIndex: 20.5166666666667 },
  "gpt-5.6-luna": { terminalBenchV4Pass1: 0.116161616161616, automationBenchAaGuardrailAdjusted: 0.5020861763756194, aaOmniscienceSignedIndex: -10.2833333333333 },
  "gpt-5.6-sol": { terminalBenchV4Pass1: 0.398989898989899, mercorApex11Pass1: 0.514, automationBenchAaGuardrailAdjusted: 0.6008114996276329, aaOmniscienceSignedIndex: 21.9666666666667 },
  "gpt-5.6-terra": { terminalBenchV4Pass1: 0.353535353535354, mercorApex11Pass1: 0.5820000000000001, automationBenchAaGuardrailAdjusted: 0.5964995802534495, aaOmniscienceSignedIndex: 0.05 },
  "gpt-oss-120b-medium": { terminalBenchV4Pass1: 0, automationBenchAaGuardrailAdjusted: 0.0019906990691605595, aaOmniscienceSignedIndex: -49.25 },
  "mimo-v2-omni": { aaOmniscienceSignedIndex: -20.1333333333333 },
  "mimo-v2-pro": { aaOmniscienceSignedIndex: 4.61666666666667 },
  "mimo-v2.5-pro": { terminalBenchV4Pass1: 0, aaOmniscienceSignedIndex: 3.25 },
  "minimax-m2.5": { aaOmniscienceSignedIndex: -38.8666666666667 },
  "minimax-m3": { terminalBenchV4Pass1: 0.0202020202020202, automationBenchAaGuardrailAdjusted: 0.21251257600749407, aaOmniscienceSignedIndex: 1.35 },
  "qwen3.6-plus": { aaOmniscienceSignedIndex: 0.883333333333333 },
  "qwen3.7-max": { terminalBenchV4Pass1: 0.0151515151515152, aaOmniscienceSignedIndex: 13.4833333333333 },
  "qwen3.8-max": { terminalBenchV4Pass1: 0.186868686868687, aaOmniscienceSignedIndex: 3.4 },
  "zai-openai/glm-5.3": { terminalBenchV4Pass1: 0.419191919191919, mercorApex11Pass1: 0.5660000000000001, automationBenchAaGuardrailAdjusted: 0.622028649962642, aaOmniscienceSignedIndex: 14.3 },
  "zai-openai/glm-5.3-flash": { terminalBenchV4Pass1: 0.328282828282828, mercorApex11Pass1: 0.528, automationBenchAaGuardrailAdjusted: 0.6036862782167782, aaOmniscienceSignedIndex: 7.46666666666667 },
  "zai/glm-5.3": { terminalBenchV4Pass1: 0.419191919191919, mercorApex11Pass1: 0.5660000000000001, automationBenchAaGuardrailAdjusted: 0.622028649962642, aaOmniscienceSignedIndex: 14.3 },
  "zai/glm-5.3-flash": { terminalBenchV4Pass1: 0.328282828282828, mercorApex11Pass1: 0.528, automationBenchAaGuardrailAdjusted: 0.6036862782167782, aaOmniscienceSignedIndex: 7.46666666666667 },
};

/** The capture date every row above was fetched on. Informational. */
export const FROZEN_BENCHMARK_CAPTURED_AT = "2026-09-15";
