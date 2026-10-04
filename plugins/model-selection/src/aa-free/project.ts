import type { AaFreeRow } from "./parse.js";

/**
 * The ONLY view of an AA row the decision path may consume (design D1,
 * decision invariance). It reads `aaIndex` and nothing else: prices, medians,
 * individual evaluations and `optionalRich` have zero decision weight, so a
 * source that does or does not carry them yields identical decisions.
 */
export interface AaDecisionInput {
  aaIndex: number | null;
}

export function projectDecisionInput(row: Pick<AaFreeRow, "aaIndex">): AaDecisionInput {
  return { aaIndex: row.aaIndex };
}
