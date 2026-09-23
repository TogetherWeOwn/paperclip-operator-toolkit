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

/** True when this candidate has a real ledger-derived cost per accepted card. */
export function hasCostPerAcceptedCard(
  candidate: Candidate,
  ledger: Readonly<Record<string, CardLedgerEntry>>,
): boolean {
  return costPerAcceptedCardFor(candidate.modelId, candidate.tier, ledger) !== null;
}

/**
 * Sorts a copy of `candidates` by `costPerAcceptedCard` (ledger-derived, never
 * list price), cheapest first, with every candidate that HAS NO such cost
 * placed after every candidate that has one.
 *
 * TOG-3997 §2. A null `costPerAcceptedCard` is the absence of evidence, not
 * evidence of cheapness, and the two failure modes are not symmetric: ranking
 * a null first hands every card to the one model we know least about, while
 * ranking it last only delays a model that some other gate
 * (`free-lane-earn-in`) exists to give traffic to. So nulls go last.
 *
 * They are no longer DROPPED, which is what this function used to do. Dropping
 * looks equivalent — a dropped row also never wins — but it is not, because
 * `orderByObjective` falls back to the untouched list-price order when the
 * result comes back empty. Under the old shape a field of candidates that were
 * ALL null collapsed to that fallback, and a null-cost model won after all.
 * Keeping the rows in a defined last-place order removes the fallback's only
 * reachable path to a null winner.
 *
 * Null-vs-null compares equal, so `Array.prototype.sort`'s stability preserves
 * the caller's incoming (list-price) order among them.
 */
export function orderByCostPerAcceptedCard(
  candidates: readonly Candidate[],
  ledger: Readonly<Record<string, CardLedgerEntry>>,
): Candidate[] {
  return candidates
    .map((candidate) => ({ candidate, cost: costPerAcceptedCardFor(candidate.modelId, candidate.tier, ledger) }))
    .sort((a, b) => {
      if (a.cost === null && b.cost === null) return 0;
      if (a.cost === null) return 1;
      if (b.cost === null) return -1;
      return a.cost - b.cost || a.candidate.modelId.localeCompare(b.candidate.modelId);
    })
    .map((row) => row.candidate);
}

/**
 * Computes the shadow-diff record for one decision's candidate set. Returns
 * null when there is nothing to compare (no list-price winner, or no
 * ledger-costable candidate) — a missing comparison is not a disagreement.
 *
 * The costable filter is this function's own (TOG-3997). It used to be
 * `orderByCostPerAcceptedCard`'s, which dropped uncostable rows; that function
 * now ranks them last instead, so ordering the raw candidate set here would
 * always produce a head, and this would publish a disagreement between list
 * price and a cost nobody measured. Filtering first keeps the empty case
 * empty, which is what the `?? null` below reads.
 */
export function computeShadowDiff(
  issueId: string,
  tier: Tier,
  candidates: readonly Candidate[],
  listPriceWinnerId: string | null,
  ledger: Readonly<Record<string, CardLedgerEntry>>,
): ShadowDiffRecord | null {
  if (listPriceWinnerId === null) return null;
  const costable = candidates.filter((candidate) => hasCostPerAcceptedCard(candidate, ledger));
  const byCard = orderByCostPerAcceptedCard(costable, ledger);
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
 *
 * The ordering now always returns every candidate it was given, so the
 * length-zero fallback that used to guard an all-null field is gone: a field
 * with no ledger costs at all sorts null-vs-null, which compares equal, so the
 * incoming list-price order survives unchanged. Same observable result, minus
 * the branch that could promote a null-cost row to first place.
 */
export function orderByObjective(
  candidates: readonly Candidate[],
  objective: SelectionObjective,
  ledger: Readonly<Record<string, CardLedgerEntry>>,
): Candidate[] {
  if (objective === "list-price") return [...candidates];
  return orderByCostPerAcceptedCard(candidates, ledger);
}
