/**
 * The availability term (TOG-3132).
 *
 * WHY THIS FILE EXISTS, MEASURED
 *
 * Twice on 2026-09-16/17 the selector picked a model whose lane would not
 * serve, because nothing in `SelectInput` could see serviceability at all:
 *
 *   * 22:29Z — the Claude 5-hour window stood at 1.0 and 52 runs were refused.
 *     A router that owned the floor would still have picked `claude-opus-5`,
 *     the cheapest capable T1, because `ModelEntry.enabled` is a human-edited
 *     config boolean and nothing else in the input describes a live lane.
 *   * 00:39Z — Z.ai published `health: "healthy"` at weekly 0.46 / 5h 0.60 and
 *     refused 7 runs with `500 no healthy managed Z.ai capacity remains`. The
 *     binding state was the `subscription-pool` plugin's own rate-limit
 *     cooldown, which no quota fraction encodes, on a lane whose limiter is
 *     requests-per-window PER ACCOUNT — and ~25 agents arrived on one
 *     credential at once.
 *
 * So a percentage is not sufficient, and the published `health` field is not
 * sufficient either. Three independent terms decide whether a lane will serve:
 * its quota windows, its cooldown, and how many accounts stand behind it.
 *
 * THE SERVICEABILITY TEST IS NOT RE-INVENTED HERE
 *
 * `cliproxy_quota_controller.py:140-145` already defines it, and that
 * definition is what actually disables an auth file on the host:
 *
 *     serviceable = health == "healthy"
 *                   and not window_exhausted        # any window utilization >= 1.0
 *                   and binding.remaining_allowance > 0
 *
 * This module mirrors those three conditions exactly. Two consumers computing
 * "serviceable" from the same document by two different rules is how a lane
 * gets disabled on the host and still selected by the router.
 *
 * COOLDOWN EXCLUDES HERE — IT DOES NOT MERELY DOWN-RANK
 *
 * Measured on TOG-811 against the real `router/src/capacity/normalize.ts`:
 * `health: "cooldown"` lands in that module's *degraded* bucket, `postureFor`
 * turns degraded into `avoid`, and an avoided lane stays selectable. A lane
 * publishing a cooldown would look handled and keep taking traffic. This
 * consumer takes the opposite discipline, which is the one `types.ts:23-27`
 * already applies to capabilities: anything that is not positively `healthy`
 * is EXCLUDED, never scored down. That means every non-`healthy` string —
 * `exhausted`, `unavailable`, `cooldown`, `cooling_down`, or a value the
 * contract has not heard of yet — takes the lane out.
 *
 * The second half of that same result: a record carrying a cooldown and no
 * utilization window yields zero evidence in the router's normalizer, and a
 * consumer with zero evidence FAILS OPEN (TOG-1040). So the cooldown here is
 * evaluated on the record directly and independently of the windows. A record
 * with a live `cooldown` is unavailable whether or not it carries a single
 * usable window, and whether or not `health` reads `healthy`.
 *
 * STALENESS IS TRI-STATE, FOLLOWING `pacing_verdict.py`
 *
 * `pacing_verdict.py:75` fixes the shared cutoff at 120 minutes and the rule
 * that an old sample is UNKNOWN — "not stale-but-usable, not the last known
 * verdict". 120 is a floor for everyone and a ceiling for nobody, so a record
 * that declares a tighter `stale_after_seconds` gets the tighter one. UNKNOWN
 * is not "available": it is a third state, and `select.ts` is required to say
 * it rather than pass quietly.
 */

/** Shared with `pacing_verdict.py:75`. A consumer may be tighter, never looser. */
export const MAX_AGE_MINUTES = 120;

/** An observation dated more than this far ahead of `now` is not a clock skew. */
const FUTURE_TOLERANCE_MS = 60_000;

export type LaneState = "available" | "unavailable" | "unknown";

/**
 * Which term produced the verdict. This is the field that lets
 * `decisions.jsonl` answer "why did this card not get opus" after the fact,
 * so it is a closed vocabulary rather than free prose.
 */
export type AvailabilityTerm =
  | "health"
  | "cooldown"
  | "quota"
  | "accounts"
  | "staleness"
  | "unmapped"
  /**
   * Not produced by this module. `lane-evidence.ts` reports through the same
   * closed vocabulary so one `decision.availability` record answers "why did
   * this card not get opus" whichever term took the lane out.
   */
  | "evidence";

export interface LaneAvailability {
  /** Lane id, matched against `ModelEntry.laneId`. The contract's `provider`. */
  laneId: string;
  state: LaneState;
  /** Null only when the lane is plainly available. */
  term: AvailabilityTerm | null;
  reason: string;
  /** Accounts observed on this lane, whatever their state. */
  accountCount: number;
  /** Accounts that passed the full serviceability test. The AC-3 term. */
  serviceableAccountCount: number;
  ageMinutes: number | null;
}

export interface AvailabilitySnapshot {
  lanes: readonly LaneAvailability[];
  /**
   * Set when the whole document could not be read. Every lane is then UNKNOWN,
   * which `select.ts` must say — an unreadable instrument is not a pass.
   */
  unreadableReason: string | null;
}

interface RecordVerdict {
  state: LaneState;
  term: AvailabilityTerm | null;
  reason: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseTs(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The binding allowance, by the controller's own rule: of the `allowance`-role
 * windows, the one with the lowest clear rate. A lane with no allowance window
 * is malformed, and malformed is UNKNOWN rather than available.
 */
function bindingAllowance(
  windows: readonly Record<string, unknown>[],
  nowMs: number,
): { remaining: number; name: string } | null {
  let binding: { remaining: number; name: string; clearRate: number; reset: number } | null = null;
  for (const window of windows) {
    if (window.role !== "allowance") continue;
    const utilization = finite(window.utilization);
    const weight = finite(window.allowance_weight);
    const reset = parseTs(window.resets_at);
    if (utilization === null || weight === null || reset === null) continue;
    const hoursToReset = Math.max((reset - nowMs) / 3_600_000, 1);
    const remaining = Math.max(0, 1 - utilization) * weight;
    const clearRate = remaining / hoursToReset;
    const name = typeof window.name === "string" ? window.name : "(unnamed)";
    if (
      !binding ||
      clearRate < binding.clearRate ||
      (clearRate === binding.clearRate && reset < binding.reset)
    ) {
      binding = { remaining, name, clearRate, reset };
    }
  }
  return binding ? { remaining: binding.remaining, name: binding.name } : null;
}

/**
 * One account record -> one verdict. Ordered so the reported term is the one an
 * operator would act on first: a cooldown is a four-minute wait, an exhausted
 * window is a five-hour one, and reporting the wrong one sends someone to the
 * wrong dashboard.
 */
function evaluateRecord(
  raw: Record<string, unknown>,
  observedAtMs: number,
  nowMs: number,
): RecordVerdict {
  const key = typeof raw.account_key === "string" ? raw.account_key : "(unkeyed)";
  const ageMs = nowMs - observedAtMs;

  if (ageMs < -FUTURE_TOLERANCE_MS) {
    return { state: "unknown", term: "staleness", reason: `${key}: observation is in the future` };
  }
  const declared = finite(raw.stale_after_seconds);
  const cutoffMs = Math.min(
    MAX_AGE_MINUTES * 60_000,
    declared !== null && declared > 0 ? declared * 1000 : Number.POSITIVE_INFINITY,
  );
  if (ageMs > cutoffMs) {
    return {
      state: "unknown",
      term: "staleness",
      reason: `${key}: sample age ${Math.round(ageMs / 60_000)}min exceeds the ${Math.round(cutoffMs / 60_000)}min cutoff`,
    };
  }

  // Evaluated BEFORE health, and without reference to the windows. On 09-17 at
  // 00:39Z the refusing lane published `health: "healthy"` with real quota
  // headroom; the cooldown was the only true thing about it.
  const cooldown = asRecord(raw.cooldown);
  if (cooldown) {
    const until = parseTs(cooldown.until);
    const why = typeof cooldown.reason === "string" ? `: ${cooldown.reason}` : "";
    if (until === null) {
      return {
        state: "unavailable",
        term: "cooldown",
        reason: `${key}: cooldown present with no readable \`until\`${why}`,
      };
    }
    if (until > nowMs) {
      return {
        state: "unavailable",
        term: "cooldown",
        reason: `${key}: in cooldown until ${new Date(until).toISOString()}${why}`,
      };
    }
  }

  // Anything not positively `healthy` is out. `cooldown` / `cooling_down` are
  // named explicitly because the router's normalizer buckets them as degraded,
  // which down-ranks and keeps them selectable — see the header.
  const health = typeof raw.health === "string" ? raw.health : null;
  if (health === null) {
    return { state: "unknown", term: "staleness", reason: `${key}: no health field` };
  }
  if (health !== "healthy") {
    const term: AvailabilityTerm =
      health === "cooldown" || health === "cooling_down" ? "cooldown" : "health";
    return { state: "unavailable", term, reason: `${key}: health ${health}` };
  }

  const windows = Array.isArray(raw.windows)
    ? raw.windows.flatMap((w) => {
        const rec = asRecord(w);
        return rec ? [rec] : [];
      })
    : [];
  if (windows.length === 0) {
    return { state: "unknown", term: "staleness", reason: `${key}: no windows published` };
  }
  for (const window of windows) {
    const utilization = finite(window.utilization);
    if (utilization !== null && utilization >= 1) {
      const name = typeof window.name === "string" ? window.name : "(unnamed)";
      return {
        state: "unavailable",
        term: "quota",
        reason: `${key}: window ${name} at utilization ${utilization.toFixed(2)}`,
      };
    }
  }
  const binding = bindingAllowance(windows, nowMs);
  if (!binding) {
    return { state: "unknown", term: "staleness", reason: `${key}: no readable allowance window` };
  }
  if (binding.remaining <= 0) {
    return {
      state: "unavailable",
      term: "quota",
      reason: `${key}: binding allowance ${binding.name} has no remaining allowance`,
    };
  }
  return { state: "available", term: null, reason: `${key}: serviceable` };
}

/**
 * Roll per-account verdicts up to a lane. One serviceable account makes the
 * lane serviceable — but `serviceableAccountCount` is carried forward, because
 * "one account left" and "six accounts left" are different lanes to a fleet,
 * and 09-17 00:39Z is what the difference costs.
 */
function rollUp(
  laneId: string,
  verdicts: readonly RecordVerdict[],
  ageMinutes: number | null,
): LaneAvailability {
  const serviceable = verdicts.filter((v) => v.state === "available");
  const unavailable = verdicts.filter((v) => v.state === "unavailable");
  const unknown = verdicts.filter((v) => v.state === "unknown");
  const base = {
    laneId,
    accountCount: verdicts.length,
    serviceableAccountCount: serviceable.length,
    ageMinutes,
  };

  if (serviceable.length > 0) {
    return {
      ...base,
      state: "available",
      term: null,
      reason: `${serviceable.length}/${verdicts.length} accounts serviceable`,
    };
  }
  if (unavailable.length > 0) {
    // Report the term that took the last account out, preferring cooldown over
    // quota over health for the reason in the comment on `evaluateRecord`.
    const order: AvailabilityTerm[] = ["cooldown", "quota", "health"];
    const term =
      order.find((t) => unavailable.some((v) => v.term === t)) ?? unavailable[0]!.term ?? "health";
    const reasons = unavailable.map((v) => v.reason).join("; ");
    return { ...base, state: "unavailable", term, reason: `no serviceable account — ${reasons}` };
  }
  return {
    ...base,
    state: "unknown",
    term: "staleness",
    reason: unknown.length > 0 ? unknown.map((v) => v.reason).join("; ") : "no records for this lane",
  };
}

export interface NormalizeOptions {
  /** Override the lane key. Defaults to the contract's `provider`. */
  laneIdOf?: (record: Record<string, unknown>) => string | null;
}

/**
 * Normalize a published quota-contract document into per-lane availability.
 *
 * Pure: no clock, no filesystem, no network. `nowMs` is supplied so the
 * staleness branch is testable, which is the branch that decides whether an
 * UNKNOWN is produced at all.
 */
export function normalizeAvailability(
  raw: unknown,
  nowMs: number,
  options: NormalizeOptions = {},
): AvailabilitySnapshot {
  const document = asRecord(raw);
  if (!document) {
    return { lanes: [], unreadableReason: "availability document is not an object" };
  }
  const observedAtMs = parseTs(document.observedAt);
  if (observedAtMs === null) {
    return { lanes: [], unreadableReason: "availability document has no readable observedAt" };
  }
  const records = Array.isArray(document.records)
    ? document.records.flatMap((r) => {
        const rec = asRecord(r);
        return rec ? [rec] : [];
      })
    : [];
  if (records.length === 0) {
    return { lanes: [], unreadableReason: "availability document carried no records" };
  }

  const ageMinutes = (nowMs - observedAtMs) / 60_000;
  const laneIdOf = options.laneIdOf ?? ((rec) => (typeof rec.provider === "string" ? rec.provider : null));

  const byLane = new Map<string, RecordVerdict[]>();
  for (const record of records) {
    const laneId = laneIdOf(record);
    if (!laneId) continue;
    const verdicts = byLane.get(laneId) ?? [];
    verdicts.push(evaluateRecord(record, observedAtMs, nowMs));
    byLane.set(laneId, verdicts);
  }

  const lanes = [...byLane.entries()]
    .map(([laneId, verdicts]) => rollUp(laneId, verdicts, ageMinutes))
    .sort((left, right) => left.laneId.localeCompare(right.laneId));

  return { lanes, unreadableReason: null };
}
