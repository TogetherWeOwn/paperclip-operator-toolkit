/** Sanitized, synthetic rows in the official legacy-list shape (no live data, no credential). */
const EVAL_KEYS = [
  "artificial_analysis_intelligence_index","artificial_analysis_coding_index","artificial_analysis_math_index",
  "mmlu_pro","gpqa","hle","livecodebench","scicode","math_500","aime","aime_25","ifbench","lcr",
  "terminalbench_hard","terminalbench_v2_1","terminalbench_v4_0","tau2","tau_banking",
];

export function legacyRow(slug: string, index: number | null, extra: Record<string, unknown> = {}) {
  const evaluations: Record<string, number | null> = Object.fromEntries(EVAL_KEYS.map((k) => [k, null]));
  evaluations.artificial_analysis_intelligence_index = index;
  evaluations.gpqa = 0.8;
  return {
    id: `id-${slug}`,
    name: slug,
    slug,
    release_date: "2026-01-01",
    model_creator: { id: "c1", name: "Acme", slug: "acme" },
    pricing: { price_1m_blended_3_to_1: 2, price_1m_input_tokens: 1, price_1m_output_tokens: 4 },
    median_output_tokens_per_second: 100,
    median_time_to_first_token_seconds: 0.5,
    median_time_to_first_answer_token: 3,
    evaluations,
    ...extra,
  };
}

export function legacyBody(rows: unknown[]): string {
  return JSON.stringify({ status: 200, prompt_options: { parallel_queries: 1, prompt_length: 1000 }, data: rows });
}
