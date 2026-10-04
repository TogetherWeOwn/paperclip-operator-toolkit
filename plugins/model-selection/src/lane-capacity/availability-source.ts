/**
 * The writer for the availability term.
 *
 * WHY THIS FILE EXISTS
 *
 * `engine/availability.ts` reads a published quota-contract document out of
 * `PLUGIN_STATE_KEYS.laneAvailability`. Nothing wrote that key. A `state.get`
 * with no `state.set` behind it makes the whole gate inert: every lane reads
 * UNKNOWN-because-unreadable, and with `holdOnUnknownAvailability` off that is
 * a quiet pass for every candidate — the exact fail-open shape the term was
 * built to remove. This module is the missing producer.
 *
 * IT IS BUILT FROM THE NORMALIZED OBSERVATION, NOT THE RAW DOCUMENT
 *
 * `LanePaceObservation` has already applied each lane's own field mapping
 * (`healthFields`, `utilizationFields`, `resetFields`, …). Passing the raw
 * document through instead would publish whatever field names that lane
 * happens to use, and `normalizeAvailability` only understands the canonical
 * contract names — so a lane with a non-canonical schema would silently read
 * as "no windows published", i.e. UNKNOWN, i.e. nothing excluded. Building
 * from the observation means one field mapping, applied once, for both
 * consumers.
 *
 * Counts-only evidence and per-model cooldowns are validated in the observation
 * and carried without deriving allowance windows or freezing cooldown expiry.
 * The legacy singular account cooldown is passed through from the raw record
 * when present (matched on `account_key`).
 *
 * PER-LANE AGE IS PRESERVED THROUGH A SINGLE-STAMP DOCUMENT
 *
 * The contract has one `observedAt` for the whole document, but lanes are
 * polled from different publishers and go stale independently. The reader
 * measures every record's age from that single stamp, so stamping the poll
 * time would erase each lane's own staleness — a lane whose publisher died
 * three hours ago would read as freshly observed. Instead the document is
 * stamped at the poll, and each record's `stale_after_seconds` is reduced by
 * how far behind the poll that lane's own sample was. A lane already past its
 * cutoff at emit time gets no record at all, which `select.ts` reads as
 * `unmapped` → UNKNOWN and says in the trace. That keeps AC-4 tri-state:
 * unreadable and stale are never rewritten into "available".
 */
import { MAX_AGE_MINUTES } from "../engine/availability.js";
import type { LanePaceObservation, PaceAccountObservation } from "./pace.js";
import type { LanePollResult } from "./poll.js";

export interface AvailabilityDocument {
  observedAt: string;
  records: Record<string, unknown>[];
}

/** Mirrors `availability.ts`'s own ceiling; a record may be tighter, never looser. */
const MAX_AGE_SECONDS = MAX_AGE_MINUTES * 60;

function parseMs(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * How long this sample may still be trusted, measured forward from the poll
 * stamp. Null means "already untrustworthy" — the caller drops the record so
 * the lane reads UNKNOWN rather than inheriting the poll's freshness.
 */
function remainingFreshnessSeconds(
  account: PaceAccountObservation,
  observation: LanePaceObservation,
  laneObservedAtMs: number,
  stampMs: number,
): number | null {
  const declared = account.staleAfterSeconds ?? observation.staleAfterSeconds;
  const cutoff =
    typeof declared === "number" && Number.isFinite(declared) && declared > 0
      ? Math.min(declared, MAX_AGE_SECONDS)
      : MAX_AGE_SECONDS;
  // Clamp: a publisher stamping the future must not buy itself extra life.
  const lagSeconds = Math.max(0, (stampMs - laneObservedAtMs) / 1000);
  const remaining = Math.floor(cutoff - lagSeconds);
  return remaining > 0 ? remaining : null;
}

function windowsOf(account: PaceAccountObservation): Record<string, unknown>[] {
  return account.windows.map((window) => ({
    name: window.name,
    role: window.role,
    utilization: window.utilization,
    // `bindingAllowance` needs a weight on the allowance window; the account's
    // own weight is the contract's fallback when the window does not report one.
    allowance_weight: window.allowanceWeight ?? account.weight,
    resets_at: window.resetsAt,
  }));
}

/**
 * The published record behind an account, matched on the contract's own
 * `account_key` (`cliproxy_quota_contract.py:106`). A lane whose documents key
 * accounts under some other field simply yields null, and every passthrough
 * below falls back to the normalized observation — nothing is fabricated.
 */
function publishedRecordFor(
  rawRecords: readonly unknown[] | undefined,
  accountKey: string,
): Record<string, unknown> | null {
  if (!rawRecords) return null;
  for (const raw of rawRecords) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    if (record.account_key === accountKey) return record;
  }
  return null;
}

/**
 * Health is passed through verbatim when the contract published it, because
 * `normalizeHealth` (`value-normalization.ts:41`) folds `cooldown` and
 * `cooling_down` into `degraded` along with `limited` and `warning`. Both
 * strings exclude either way, so the outage behaviour is identical — but
 * `availability.ts` attributes term `cooldown` only to the raw spellings, and
 * AC-6 is the requirement that `decisions.jsonl` can say WHICH term took a
 * candidate out. Collapsing a four-minute cooldown and a spent five-hour
 * window into one word sends an operator to the wrong dashboard.
 *
 * `unknown` is dropped rather than published: the reader excludes anything not
 * positively `healthy`, so emitting the literal `"unknown"` would convert an
 * unreadable health into a hard exclusion. Omitting the field lands it on the
 * reader's `no health field` branch, which is UNKNOWN — tri-state, per AC-4.
 */
function healthOf(
  published: Record<string, unknown> | null,
  account: PaceAccountObservation,
): string | null {
  if (published && typeof published.health === "string" && published.health.trim()) {
    return published.health;
  }
  return account.health === "unknown" ? null : account.health;
}

/**
 * Turn one round of lane polls into the document `normalizeAvailability` reads.
 *
 * Pure: the caller supplies the stamp, so the staleness arithmetic — the branch
 * that decides whether an UNKNOWN is produced at all — is testable without a
 * clock. A lane that failed to poll, published no records, or is already past
 * its cutoff contributes nothing and is therefore absent from the snapshot,
 * which `select.ts` reports as UNKNOWN rather than as available.
 */
export function availabilityDocumentFrom(input: {
  results: readonly LanePollResult[];
  observedAt: string;
}): AvailabilityDocument {
  const stampMs = parseMs(input.observedAt);
  const records: Record<string, unknown>[] = [];
  if (stampMs === null) return { observedAt: input.observedAt, records };

  for (const result of input.results) {
    const observation = result.observation;
    if (!observation || observation.error !== null) continue;
    const laneObservedAtMs = parseMs(observation.observedAt);
    if (laneObservedAtMs === null) continue;
    if (observation.accounts.some((account) => account.countsOnly) && laneObservedAtMs - stampMs > 60_000) continue;

    for (const account of observation.accounts) {
      const remaining = remainingFreshnessSeconds(account, observation, laneObservedAtMs, stampMs);
      if (remaining === null) continue;
      const published = publishedRecordFor(result.rawRecords, account.accountKey);
      const cooldown = published?.cooldown;
      const health = healthOf(published, account);
      records.push({
        // The lane id, not the document's own `provider`: `ModelEntry.laneId`
        // is what the reader matches on, and a lane may poll a publisher whose
        // provider string differs from the lane it is configured as.
        provider: result.laneId,
        account_key: account.accountKey,
        stale_after_seconds: remaining,
        ...(account.countsOnly ? {
          observationQuality: "counts-only",
          requests_today: account.countsOnly.requestsToday,
          requests_lifetime: account.countsOnly.requestsLifetime,
          governing_window: "daily",
          window_seconds: { daily: account.countsOnly.dailySeconds },
          day_resets_at: account.countsOnly.dayResetsAt,
          health: account.health,
        } : {
          windows: windowsOf(account),
          ...(health === null ? {} : { health }),
        }),
        ...(account.modelCooldowns ? { model_cooldowns: account.modelCooldowns } : {}),
        ...(cooldown && typeof cooldown === "object" && !Array.isArray(cooldown) ? { cooldown } : {}),
      });
    }
  }

  return { observedAt: input.observedAt, records };
}
