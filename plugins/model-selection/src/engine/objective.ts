import type { Tier } from "../constants.js";
import type { SelectionObjective } from "../config/resolve.js";
import type { Candidate, CardLedgerEntry, ShadowDiffRecord } from "./types.js";

export type { ShadowDiffRecord };

export function costPerAcceptedCardFor(
  modelId: string,
  tier: Tier,
  ledger: Readonly<Record<string, CardLedgerEntry>>,
): number | null {
  return ledger[`${modelId}:${tier}`]?.costPerAcceptedCard ?? null;
}

/**
 * Sorts a copy of `candidates` by `costPerAcceptedCard` (ledger-derived, never
 * list price). A candidate absent from the ledger — no cards closed, no prior
 * fallback recorded — is dropped from this ordering entirely rather than
 * silently ranked as free or infinite; the caller then only ever consults the
 * winner when the returned array is non-empty.
 */
export function orderByCostPerAcceptedCard(
  candidates: readonly Candidate[],
  ledger: Readonly<Record<string, CardLedgerEntry>>,
): Candidate[] {
  return candidates
    .map((candidate) => ({ candidate, cost: costPerAcceptedCardFor(candidate.modelId, candidate.tier, ledger) }))
    .filter((row): row is { candidate: Candidate; cost: number } => row.cost !== null)
    .sort((a, b) => a.cost - b.cost || a.candidate.modelId.localeCompare(b.candidate.modelId))
    .map((row) => row.candidate);
}

/**
 * Computes the shadow-diff record for one decision's candidate set. Returns
 * null when there is nothing to compare (no list-price winner, or no
 * ledger-costable candidate) — a missing comparison is not a disagreement.
 */
export function computeShadowDiff(
  issueId: string,
  tier: Tier,
  candidates: readonly Candidate[],
  listPriceWinnerId: string | null,
  ledger: Readonly<Record<string, CardLedgerEntry>>,
): ShadowDiffRecord | null {
  if (listPriceWinnerId === null) return null;
  const byCard = orderByCostPerAcceptedCard(candidates, ledger);
  const costPerAcceptedCardWinner = byCard[0]?.modelId ?? null;
  if (costPerAcceptedCardWinner === null) return null;
  return {
    issueId,
    tier,
    listPriceWinner: listPriceWinnerId,
    costPerAcceptedCardWinner,
    agree: costPerAcceptedCardWinner === listPriceWinnerId,
  };
}

/**
 * Applies `selection.objective` to reorder candidates already gated/costed by
 * `selectModel`. `list-price` is a no-op — the existing `expectedCostUsd` sort
 * from `select.ts` is left byte-for-byte alone. This is called ONLY when
 * `objective === "cost-per-accepted-card"`, which the shipped config never
 * sets (TOG-2136 hard constraint).
 */
export function orderByObjective(
  candidates: readonly Candidate[],
  objective: SelectionObjective,
  ledger: Readonly<Record<string, CardLedgerEntry>>,
): Candidate[] {
  if (objective === "list-price") return [...candidates];
  const reordered = orderByCostPerAcceptedCard(candidates, ledger);
  return reordered.length > 0 ? reordered : [...candidates];
}
