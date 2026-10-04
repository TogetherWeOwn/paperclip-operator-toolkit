import { matchRosterRow, type PriceExclusionReason, type PriceMatchOutcome } from "./match.js";
import type { PriceCatalog, PriceRecord } from "./parse.js";

/** The three roster fields ADR-0001's cost term reads, in report order. */
export const PRICE_FIELDS = ["costPerMTokIn", "costPerMTokOut", "costPerMTokCacheRead"] as const;
export type PriceField = (typeof PRICE_FIELDS)[number];

const FEED_FIELD_OF: Readonly<Record<PriceField, keyof Pick<PriceRecord, "input" | "output" | "cacheRead">>> = {
  costPerMTokIn: "input",
  costPerMTokOut: "output",
  costPerMTokCacheRead: "cacheRead",
};

/**
 * Relative tolerance for "the same price". Prices arrive as JSON doubles on
 * both sides and round-trip through config storage, so an exact `!==` reports
 * a 1e-16 difference as industry price drift. Anything this close is the same
 * number written twice.
 */
const PRICE_EPSILON_RELATIVE = 1e-9;

function samePrice(a: number, b: number): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) <= PRICE_EPSILON_RELATIVE * scale;
}

export interface PriceFieldDrift {
  field: PriceField;
  /** What the roster row carries today. */
  roster: number;
  /** What models.dev publishes for the lane's provider. */
  feed: number;
  /**
   * `feed / roster` — how badly the roster understates (>1) or overstates
   * (<1) the real rate. `null` when the roster carries 0, where the ratio is
   * unbounded and `severity` carries the meaning instead.
   */
  ratio: number | null;
}

/**
 * Ordered worst-first. A zero-priced row is not a big drift, it is a
 * different failure: the cost term ADR-0001 sorts on is identically 0 for
 * that model at every volume, so the row wins every cost comparison it
 * enters regardless of what it actually costs. That is the class all five
 * `muse-spark-*` rows were in on 2026-09-22, and it outranks any finite
 * misprice.
 */
export type PriceDriftSeverity = "zero-priced" | "understated" | "overstated";

export interface PriceDriftRow {
  modelId: string;
  providerId: string;
  /** The bare id matched inside the provider, after prefix stripping. */
  bareId: string;
  /** Whether this row is live in the selector today. A disabled row's drift is real but not currently routing anything. */
  enabled: boolean;
  fields: PriceFieldDrift[];
  severity: PriceDriftSeverity;
  /**
   * How far off the worst field is, as a factor ≥ 1 in either direction
   * (`max(ratio, 1/ratio)`): a 3.3x understatement and a 3.3x overstatement
   * both read 3.3, because `severity` already carries the direction and this
   * field only has to order rows within a severity. `null` when no finite
   * factor exists (including a zero roster price or a zero feed price). The
   * severity distinguishes the direction; null ranks ahead of finite factors.
   */
  maxRatio: number | null;
  /**
   * The exact clause to append to the row's `note` IF an operator approves
   * the correction, in this roster's established ` | `-joined, dated-clause
   * style. Emitted with the report rather than written: this job reports,
   * an operator applies.
   */
  suggestedNote: string;
}

export interface PriceUnresolvedRow {
  modelId: string;
  kind: "no-lane" | "unmapped-lane" | "absent-from-feed" | "unpriced-in-feed";
  detail: string;
}

export interface PriceReconcileReport {
  /** ISO timestamp of the catalogue fetch these findings were derived from. */
  fetchedAt: string;
  /** Rows actually compared against a published price. */
  checked: number;
  /** Rows compared and found correct. */
  unchanged: number;
  drift: PriceDriftRow[];
  excluded: Array<{ modelId: string; reason: PriceExclusionReason }>;
  unresolved: PriceUnresolvedRow[];
}

export interface PriceRosterRow {
  id: string;
  laneId: string | null;
  enabled: boolean;
  costPerMTokIn: number;
  costPerMTokOut: number;
  costPerMTokCacheRead: number;
  note?: string | null;
}

function buildNote(row: PriceDriftRow, fetchDate: string): string {
  const parts = row.fields.map((f) => {
    const label =
      f.field === "costPerMTokIn" ? "in" : f.field === "costPerMTokOut" ? "out" : "cache read";
    return `${label} ${f.roster} → ${f.feed}`;
  });
  return (
    `${fetchDate} models.dev price reconciliation (source: https://models.dev/api.json, provider ${row.providerId}): ` +
    `${parts.join(", ")}. List price — correct for relative cost ordering, not what we actually pay on a flat plan.`
  );
}

function severityOf(fields: readonly PriceFieldDrift[]): PriceDriftSeverity {
  if (fields.some((f) => f.roster === 0)) return "zero-priced";
  // A roster that understates the price routes work to a model that is more
  // expensive than the sort believed. That is the direction that costs money,
  // so it outranks an overstatement, which only loses an opportunity.
  return fields.some((f) => f.ratio !== null && f.ratio > 1) ? "understated" : "overstated";
}

const SEVERITY_ORDER: Readonly<Record<PriceDriftSeverity, number>> = {
  "zero-priced": 0,
  understated: 1,
  overstated: 2,
};

/**
 * Pure reconciliation: compare every roster row's three cost fields against
 * the price models.dev publishes for that row's lane provider.
 *
 * Reports; never mutates. A price change reorders the entire fleet's routing,
 * so the output is a diff for an operator to approve — the same posture the
 * thirteen pricing-pending rows were shipped disabled under, for the same
 * reason: an estimated price silently winning cost-sort over a proven model
 * is worse than a stale one.
 *
 * Every row lands in exactly one bucket — `drift`, counted in `unchanged`,
 * `excluded`, or `unresolved`. A row that quietly matched nothing and was
 * never mentioned is the failure this shape is built to prevent.
 */
export function reconcilePrices(input: {
  rows: readonly PriceRosterRow[];
  catalog: PriceCatalog;
  fetchedAt: string;
}): PriceReconcileReport {
  const fetchDate = input.fetchedAt.slice(0, 10);
  const report: PriceReconcileReport = {
    fetchedAt: input.fetchedAt,
    checked: 0,
    unchanged: 0,
    drift: [],
    excluded: [],
    unresolved: [],
  };

  for (const row of input.rows) {
    const outcome: PriceMatchOutcome = matchRosterRow({ modelId: row.id, laneId: row.laneId, note: row.note }, input.catalog);
    if (outcome.kind === "excluded") {
      report.excluded.push({ modelId: row.id, reason: outcome.reason });
      continue;
    }
    if (outcome.kind === "no-lane") {
      report.unresolved.push({
        modelId: row.id,
        kind: "no-lane",
        detail: "row carries no laneId, so no provider can be resolved without guessing",
      });
      continue;
    }
    if (outcome.kind === "unmapped-lane") {
      report.unresolved.push({
        modelId: row.id,
        kind: "unmapped-lane",
        detail: `lane ${outcome.laneId} has no models.dev provider in LANE_PRICE_PROVIDERS`,
      });
      continue;
    }
    if (outcome.kind === "absent-from-feed") {
      report.unresolved.push({
        modelId: row.id,
        kind: "absent-from-feed",
        detail: `${outcome.providerId} publishes no model ${outcome.bareId}; absence is not evidence of a wrong price`,
      });
      continue;
    }

    const record = input.catalog.get(outcome.providerId)?.get(outcome.bareId);
    if (!record) {
      // Unreachable via `matchRosterRow`, which already proved the key is
      // present. Kept because the alternative is a non-null assertion that
      // would turn a future catalogue-shape change into a thrown job.
      report.unresolved.push({
        modelId: row.id,
        kind: "absent-from-feed",
        detail: `${outcome.providerId}/${outcome.bareId} vanished between match and read`,
      });
      continue;
    }

    const fields: PriceFieldDrift[] = [];
    let anyComparable = false;
    for (const field of PRICE_FIELDS) {
      const feed = record[FEED_FIELD_OF[field]];
      // A field the provider does not publish is not a zero. Skipping it
      // leaves the roster's own value untouched and unreported.
      if (feed === null) continue;
      anyComparable = true;
      const roster = row[field];
      if (samePrice(roster, feed)) continue;
      fields.push({ field, roster, feed, ratio: roster === 0 ? null : feed / roster });
    }

    if (!anyComparable) {
      report.unresolved.push({
        modelId: row.id,
        kind: "unpriced-in-feed",
        detail: `${outcome.providerId}/${outcome.bareId} is in the feed but publishes no cost block`,
      });
      continue;
    }

    report.checked += 1;
    if (fields.length === 0) {
      report.unchanged += 1;
      continue;
    }

    const severity = severityOf(fields);
    const ratios = fields.map((f) => f.ratio).filter((r): r is number => r !== null);
    const maxRatio = Math.max(...ratios.map((r) => Math.max(r, 1 / r)));
    const driftRow: PriceDriftRow = {
      modelId: row.id,
      providerId: outcome.providerId,
      bareId: outcome.bareId,
      enabled: row.enabled,
      fields,
      severity,
      maxRatio: severity === "zero-priced" || !Number.isFinite(maxRatio) ? null : maxRatio,
      suggestedNote: "",
    };
    driftRow.suggestedNote = buildNote(driftRow, fetchDate);
    report.drift.push(driftRow);
  }

  report.drift.sort((left, right) => {
    const bySeverity = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
    if (bySeverity !== 0) return bySeverity;
    // An enabled row is routing work right now; a disabled one is not.
    if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
    // null means unbounded in either direction. Compare explicitly so two
    // unbounded rows still reach the id tiebreak (Infinity - Infinity is NaN).
    if (left.maxRatio !== right.maxRatio) {
      if (left.maxRatio === null) return -1;
      if (right.maxRatio === null) return 1;
      return right.maxRatio - left.maxRatio;
    }
    return left.modelId.localeCompare(right.modelId);
  });

  return report;
}
