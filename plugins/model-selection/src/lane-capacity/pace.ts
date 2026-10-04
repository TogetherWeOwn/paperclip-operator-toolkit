// Derived from @togetherweown/lane-capacity (paperclip-model-router,
// packages/lane-capacity/src/pace.ts) and extended for the plugin's reviewed
// per-account pacing contract. See value-normalization.ts for why this remains
// local rather than imported.
import { DEFAULT_PACE_ACCOUNT_KEY_FIELDS, DEFAULT_PACE_WEIGHT_FIELDS } from "../constants.js";
import type { CapacityHealth } from "./types.js";
import { countsOnlyEvidence, modelCooldowns, type CountsOnlyEvidence, type ModelCooldown } from "./counts-only.js";
import { firstValue, fraction, normalizeHealth, recordOf, timestamp } from "./value-normalization.js";

export type PaceState = "behind-urgent" | "behind" | "on" | "ahead" | "unknown" | "exhausted" | "free";
export type PaceWindowRole = "serviceability" | "allowance";

export interface PaceWindowDefinition {
  name: string;
  role: PaceWindowRole;
  utilizationFields: string[];
  resetFields: string[];
  defaultWindowSeconds?: number | null;
}

export interface LanePaceDefinition {
  laneId: string;
  free?: boolean;
  healthFields: string[];
  accountKeyFields?: string[];
  weightFields?: string[];
  governingWindowField?: string;
  windowSecondsField?: string;
  staleAfterSecondsField?: string;
  windows: PaceWindowDefinition[];
}

export interface PaceWindowObservation {
  name: string;
  role: PaceWindowRole;
  utilization: number | null;
  resetsAt: string | null;
  windowSeconds: number | null;
  allowanceWeight?: number | null;
  allowanceWeightSource?: "reported" | "account" | "unknown";
  sourcePath: string | null;
}

export interface PaceAccountObservation {
  accountKey: string;
  authKey?: string | null;
  plan?: string | null;
  health: CapacityHealth;
  weight: number | null;
  weightSource: "reported" | "unknown";
  governingWindow: string | null;
  governingResetAt?: string | null;
  normalizedRemaining?: number | null;
  targetBurnRate?: number | null;
  observedBurnRate?: number | null;
  deficit?: number | null;
  recommendedShare?: number | null;
  recentBurnUnitsPerHour?: number | null;
  staleAfterSeconds?: number | null;
  windows: PaceWindowObservation[];
  countsOnly?: CountsOnlyEvidence;
  modelCooldowns?: ModelCooldown[];
}

export interface LanePaceObservation {
  laneId: string;
  free: boolean;
  observedAt: string | null;
  staleAfterSeconds: number | null;
  accounts: PaceAccountObservation[];
  error: "invalid-document" | "invalid-account-identity" | "no-records" | null;
}

export interface PaceScore {
  utilization: number;
  elapsed: number;
  deviation: number;
}

export interface PaceWindowVerdict extends PaceWindowObservation {
  elapsed: number | null;
  normalizedRemaining: number | null;
  paceDebt: number | null;
  clearRate: number | null;
  serviceable: boolean;
}

export interface PaceAccountVerdict {
  accountKey: string;
  authKey?: string | null;
  plan?: string | null;
  health: CapacityHealth;
  weight: number | null;
  weightSource: "reported" | "unknown";
  governingWindow: string | null;
  governingResetAt: string | null;
  bindingWindow?: string | null;
  bindingResetAt?: string | null;
  /** Soonest reset driving a `push`, across every allowance window. */
  urgentResetAt?: string | null;
  recentBurnUnitsPerHour?: number | null;
  staleAfterSeconds?: number | null;
  serviceable: boolean;
  state: Exclude<PaceState, "free"> | "push";
  score: PaceScore | null;
  normalizedRemaining?: number | null;
  targetBurnRate?: number | null;
  observedBurnRate?: number | null;
  deficit?: number | null;
  recommendedShare?: number | null;
  paceDebt?: number | null;
  clearRate?: number | null;
  windows?: PaceWindowVerdict[];
}

export interface LanePaceVerdict {
  laneId: string;
  observedAt: string | null;
  state: PaceState;
  serviceable: boolean | null;
  score: PaceScore | null;
  targetBurnRate?: number | null;
  observedBurnRate?: number | null;
  deficit?: number | null;
  accounts: PaceAccountVerdict[];
  knownAccountCount: number;
  knownWeight: number;
  serviceableAccountCount: number;
  urgentResetAt: string | null;
  reason: "ok" | "free-lane" | "document-unavailable" | "invalid-account-identity" | "snapshot-stale" | "no-records" | "indeterminate-account-weight" | "invalid-configured-governing-window" | "no-computable-governing-window" | "all-accounts-unserviceable" | "serviceability-window-exhausted";
}

export interface PacePolicy {
  margin?: number;
  urgentResetSeconds?: number;
  maxSnapshotAgeSeconds?: number;
}

const SCALE = 1_000;
export const DEFAULT_MARGIN = 0.1;
const DEFAULT_URGENT_RESET_SECONDS = 24 * 60 * 60;
const DEFAULT_MAX_SNAPSHOT_AGE_SECONDS = 15 * 60;

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function firstNumber(record: Record<string, unknown>, fields: string[], mode: "finite" | "non-negative" = "finite"): number | null {
  const value = firstValue(record, fields)?.value;
  return mode === "non-negative" ? nonNegativeNumber(value) : finiteNumber(value);
}

function text(record: Record<string, unknown>, fields: string[]): string | null {
  const value = firstValue(record, fields)?.value;
  return typeof value === "string" && value.trim() ? value : null;
}

function windowSeconds(record: Record<string, unknown>, field: string, window: PaceWindowDefinition): number | null {
  const raw = record[field];
  if (typeof raw === "number") return positiveNumber(raw);
  const mapped = recordOf(raw);
  if (mapped) {
    return positiveNumber(mapped[window.name]) ??
      positiveNumber(mapped[window.name.replace(/-/g, "_")]);
  }
  return positiveNumber(window.defaultWindowSeconds);
}

function normalizedWeight(record: Record<string, unknown>, fields: string[]): { weight: number | null; source: "reported" | "unknown" } {
  const reported = positiveNumber(firstValue(record, fields)?.value);
  return reported === null
    ? { weight: null, source: "unknown" }
    : { weight: reported, source: "reported" };
}

function accountKey(record: Record<string, unknown>, fields: string[]): string | null {
  return text(record, fields)?.trim() ?? null;
}

function hasReportedAccountDecision(account: PaceAccountObservation): boolean {
  return account.governingWindow !== null && (
    account.targetBurnRate !== null ||
    account.deficit !== null ||
    account.recommendedShare !== null
  );
}

function recordWindows(record: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(record.windows)
    ? record.windows.map(recordOf).filter((window): window is Record<string, unknown> => window !== null)
    : [];
}

function matchingWindowRecord(record: Record<string, unknown>, window: PaceWindowDefinition): Record<string, unknown> | null {
  return recordWindows(record).find((candidate) => candidate.name === window.name) ?? null;
}

function nestedOrFlatValue(
  record: Record<string, unknown>,
  nested: Record<string, unknown> | null,
  nestedField: string,
  flatFields: string[],
): { field: string; value: unknown } | null {
  if (nested && nestedField in nested) return { field: `windows.${nestedField}`, value: nested[nestedField] };
  return firstValue(record, flatFields) ?? null;
}

export function normalizeLaneDocument(input: {
  document: unknown;
  definition: LanePaceDefinition;
}): LanePaceObservation {
  const document = recordOf(input.document);
  if (!document) {
    return { laneId: input.definition.laneId, free: Boolean(input.definition.free), observedAt: null, staleAfterSeconds: null, accounts: [], error: "invalid-document" };
  }
  const records = Array.isArray(document.records) ? document.records : [];
  const observedAt = timestamp(document.observedAt);
  const staleAfterSeconds = positiveNumber(document[input.definition.staleAfterSecondsField ?? "staleAfterSeconds"]);
  const empty = (error: LanePaceObservation["error"]): LanePaceObservation => ({
    laneId: input.definition.laneId,
    free: Boolean(input.definition.free),
    observedAt,
    staleAfterSeconds,
    accounts: [],
    error,
  });
  if (records.length === 0) return empty("no-records");
  const parsedRecords = records.map(recordOf);
  if (parsedRecords.some((record) => record === null)) return empty("invalid-document");
  const validRecords = parsedRecords as Record<string, unknown>[];
  const utilizationFields = input.definition.windows.flatMap((window) => window.utilizationFields);
  const counts = validRecords.map((record) => countsOnlyEvidence(record, utilizationFields));
  const cooldowns = validRecords.map(modelCooldowns);
  if (validRecords.some((record, index) =>
    (record.observationQuality === "counts-only" && counts[index] === null) || cooldowns[index] === null)) {
    return empty("invalid-document");
  }
  const accountKeyFields = [...(input.definition.accountKeyFields ?? DEFAULT_PACE_ACCOUNT_KEY_FIELDS)];
  const accountKeys = validRecords.map((record) => accountKey(record, accountKeyFields));
  if (accountKeys.some((key) => key === null) || new Set(accountKeys).size !== accountKeys.length) {
    return empty("invalid-account-identity");
  }
  const governingWindowField = input.definition.governingWindowField ?? "governing_window";
  const windowSecondsField = input.definition.windowSecondsField ?? "window_seconds";
  const weightFields = [...(input.definition.weightFields ?? DEFAULT_PACE_WEIGHT_FIELDS)];
  const accounts = validRecords.map((record, index): PaceAccountObservation => {
    const weight = normalizedWeight(record, weightFields);
    const reportedGoverningWindow = typeof record[governingWindowField] === "string" ? record[governingWindowField] as string : null;
    const countsOnly = counts[index];
    const reportedHealth = firstValue(record, input.definition.healthFields)?.value;
    const health = normalizeHealth(reportedHealth);
    return {
      accountKey: accountKeys[index]!,
      authKey: text(record, ["auth_key", "authKey"]),
      plan: text(record, ["plan"]),
      health: countsOnly
        ? record.exhausted === true ? "exhausted" : reportedHealth === "unknown" ? "unknown" : health === "unknown" ? "unavailable" : health ?? "unavailable"
        : health ?? "unknown",
      ...(countsOnly ? { countsOnly } : {}),
      ...(cooldowns[index]!.length > 0 ? { modelCooldowns: cooldowns[index]! } : {}),
      weight: weight.weight,
      weightSource: weight.source,
      governingWindow: reportedGoverningWindow,
      governingResetAt: timestamp(firstValue(record, ["governing_reset_at", "governing_resets_at", "governingResetAt", "binding_reset_at", "bindingResetAt"])?.value),
      normalizedRemaining: firstNumber(record, ["normalized_remaining", "normalizedRemaining"], "non-negative"),
      targetBurnRate: firstNumber(record, ["target_burn_rate", "targetBurnRate", "clear_rate", "clearRate"], "non-negative"),
      observedBurnRate: firstNumber(record, ["observed_burn_rate", "observedBurnRate", "recent_burn_units_per_hour"], "non-negative"),
      deficit: firstNumber(record, ["deficit"]),
      recommendedShare: firstNumber(record, ["recommended_share", "recommendedShare"], "non-negative"),
      recentBurnUnitsPerHour: firstNumber(record, ["recent_burn_units_per_hour"], "non-negative"),
      staleAfterSeconds: positiveNumber(record.stale_after_seconds),
      windows: countsOnly ? [] : input.definition.windows.map((window) => {
        const nested = matchingWindowRecord(record, window);
        const utilization = nestedOrFlatValue(record, nested, "utilization", window.utilizationFields);
        const reset = nestedOrFlatValue(record, nested, "resets_at", window.resetFields);
        const reportedAllowanceWeight = positiveNumber(nested?.allowance_weight);
        // A window that REPORTS `allowance_weight` and reports something that is
        // not a positive number (0, negative, a string, NaN) has stated a weight
        // and stated a broken one. Falling back to the account's plan weight
        // there silently substitutes a different number for the one the snapshot
        // asserted and reports `reason: "ok"` off it. That is indeterminate
        // capacity, not a default. `undefined`/`null` mean "not reported" in the
        // JSON these documents are serialized from, and keep the plan-weight
        // fallback.
        const invalidReportedAllowanceWeight = nested !== null &&
          "allowance_weight" in nested &&
          nested.allowance_weight !== null &&
          nested.allowance_weight !== undefined &&
          reportedAllowanceWeight === null;
        return {
          name: window.name,
          role: window.role,
          utilization: fraction(utilization?.value),
          resetsAt: timestamp(reset?.value),
          windowSeconds: positiveNumber(nested?.window_seconds) ?? windowSeconds(record, windowSecondsField, window),
          allowanceWeight: invalidReportedAllowanceWeight
            ? null
            : reportedAllowanceWeight ?? (window.role === "allowance" ? weight.weight : null),
          allowanceWeightSource: invalidReportedAllowanceWeight
            ? "unknown"
            : reportedAllowanceWeight !== null
              ? "reported"
              : weight.source === "reported"
                ? "account"
                : "unknown",
          sourcePath: utilization?.field ?? null,
        };
      }),
    };
  });
  return {
    laneId: input.definition.laneId,
    free: Boolean(input.definition.free),
    observedAt,
    staleAfterSeconds,
    accounts,
    error: null,
  };
}

function roundHalfEven(value: number): number {
  const lower = Math.floor(value);
  const fraction = value - lower;
  if (Math.abs(fraction - 0.5) <= 1e-12) return lower % 2 === 0 ? lower : lower + 1;
  return Math.round(value);
}

function toMilli(value: number): number {
  return roundHalfEven(Math.min(1, Math.max(0, value)) * SCALE);
}

function score(utilizationMilli: number, elapsedMilli: number): PaceScore {
  return {
    utilization: utilizationMilli / SCALE,
    elapsed: elapsedMilli / SCALE,
    deviation: (utilizationMilli - elapsedMilli) / SCALE,
  };
}

function weightedMilli(values: Array<{ value: number; weight: number }>): number {
  const weight = values.reduce((sum, entry) => sum + entry.weight, 0);
  return roundHalfEven(values.reduce((sum, entry) => sum + entry.value * entry.weight, 0) / weight);
}

function scoredWindow(window: PaceWindowObservation, observedAtMs: number): PaceWindowVerdict {
  if (window.utilization === null || window.resetsAt === null || window.windowSeconds === null) {
    return {
      ...window,
      elapsed: null,
      normalizedRemaining: null,
      paceDebt: null,
      clearRate: null,
      serviceable: window.utilization === null || window.utilization < 1,
    };
  }
  const remainingSeconds = (Date.parse(window.resetsAt) - observedAtMs) / 1_000;
  const elapsed = Math.min(1, Math.max(0, 1 - remainingSeconds / window.windowSeconds));
  const allowanceWeight = window.allowanceWeight ?? null;
  const normalizedRemaining = allowanceWeight === null
    ? null
    : allowanceWeight * Math.max(0, 1 - window.utilization);
  const remainingHours = Math.max(1, remainingSeconds / 3_600);
  return {
    ...window,
    elapsed,
    normalizedRemaining,
    paceDebt: allowanceWeight === null ? null : allowanceWeight * (elapsed - window.utilization),
    clearRate: normalizedRemaining === null ? null : normalizedRemaining / remainingHours,
    serviceable: window.utilization < 1,
  };
}

/**
 * The binding allowance window — the one whose sustainable clear rate is the
 * real constraint on this account.
 *
 * A configured `governing_window` constrains this in two directions, and both
 * matter:
 *
 * 1. It is never STOOD IN FOR. When the named governor is missing or not
 *    computable, the answer is nothing — falling back to another allowance
 *    reads capacity off (say) the weekly window while still labelling the
 *    decision monthly, and admits traffic the named governor does not have room
 *    for. An unresolvable configured governor is indeterminate.
 * 2. It never WIDENS the constraint. A declared governor can go stale — the
 *    account names `weekly` while its monthly allowance has run down to 1%
 *    remaining. Honouring the declaration there paces off the loose window and
 *    overruns the tight one, which is the same hazard as (1) pointing the other
 *    way. So a declared governor competes on clear rate like any other
 *    allowance; if a different window clears more slowly, that window binds and
 *    is REPORTED as the binding window (see `bindingWindow` on the verdict) —
 *    the decision is never relabelled with a window it was not computed from.
 */
function bindingWindow(windows: PaceWindowVerdict[], configured: string | null): PaceWindowVerdict | null {
  const allowances = windows.filter((window) =>
    window.role === "allowance" &&
    window.utilization !== null &&
    window.resetsAt !== null &&
    window.windowSeconds !== null &&
    window.clearRate !== null
  );
  const tightest = [...allowances].sort((left, right) =>
    left.clearRate! - right.clearRate! || left.name.localeCompare(right.name)
  )[0] ?? null;
  if (configured === null) return tightest;
  const declared = allowances.find((window) => window.name === configured) ?? null;
  if (declared === null) return null;
  return tightest !== null && tightest.clearRate! < declared.clearRate! ? tightest : declared;
}

/**
 * The soonest reset among this account's allowance windows that are BEHIND pace
 * and reset inside the urgent horizon — the final-24h push.
 *
 * This deliberately scans every allowance window rather than only the binding
 * one. The binding window is the window with the least room per hour; the push
 * exists for the opposite case — a window with plenty of allowance left whose
 * reset is about to destroy it. Those are rarely the same window (a window
 * resetting soon with room to spare has a HIGH clear rate, so it never binds),
 * so keying the push on the binding window's reset makes it unreachable exactly
 * when it is needed.
 */
function urgentPushResetAt(
  windows: PaceWindowVerdict[],
  asOfMs: number,
  marginMilli: number,
  urgentResetSeconds: number,
): string | null {
  return windows
    .filter((window) =>
      window.role === "allowance" &&
      window.serviceable &&
      window.utilization !== null &&
      window.elapsed !== null &&
      window.resetsAt !== null &&
      stateFor(toMilli(window.utilization) - toMilli(window.elapsed), marginMilli) === "behind")
    .map((window) => ({ resetsAt: window.resetsAt!, resetSeconds: (Date.parse(window.resetsAt!) - asOfMs) / 1_000 }))
    .filter((entry) => entry.resetSeconds >= 0 && entry.resetSeconds < urgentResetSeconds)
    .sort((left, right) => left.resetSeconds - right.resetSeconds)[0]?.resetsAt ?? null;
}

function governingWindow(account: PaceAccountObservation, windows: PaceWindowVerdict[]): PaceWindowVerdict | null {
  const binding = bindingWindow(windows, account.governingWindow);
  if (binding) return binding;
  // Same rule as `bindingWindow`: a declared governor is never stood in for,
  // not even by the widest serviceability window.
  if (account.governingWindow !== null) return null;
  return windows
    .filter((window) => window.role === "serviceability" && window.utilization !== null)
    .sort((left, right) => right.windowSeconds! - left.windowSeconds! || left.name.localeCompare(right.name))[0] ?? null;
}

function serviceable(account: PaceAccountObservation, windows: PaceWindowVerdict[], tripCeilingMilli: number): boolean {
  if (account.health === "exhausted" || account.health === "unavailable") return false;
  if (account.countsOnly && account.health !== "healthy" && account.health !== "unknown") return false;
  if (trippedServiceabilityWindows(windows, tripCeilingMilli).length > 0) return false;
  return windows.every((window) => window.utilization === null || window.utilization < 1);
}

/**
 * The serviceability windows this account holds at (or within the
 * pace margin of) 1.0 — i.e. the windows whose `resetsAt` is the earliest
 * relief this account can offer.
 *
 * Measured 2026-09-16 22:29-22:52Z: a Claude lane document with one account at
 * five_hour 1.0 and a healthy second account at 0.05 still served 429s for 52
 * runs, because cliproxy does not fail over within a lane — it kept routing to
 * the blown account for the whole storm. An any-account-serviceable roll-up
 * therefore overstates a lane whose provider behaves that way, so a tripped
 * serviceability window exhausts its own account (see `evaluateLanePace`)
 * (the lane itself is condemned only when no account can still serve), and
 * the account reads `exhausted` until reset.
 *
 * Note this is strictly wider than the per-window `serviceable` flag set in
 * `scoredWindow`, which trips only at a hard `utilization >= 1`: the margin
 * makes a window at 0.9 (default margin 0.1) trip too, because the storm
 * showed 429s arriving before the reported utilization reached exactly 1.
 */
function trippedServiceabilityWindows(windows: PaceWindowVerdict[], tripCeilingMilli: number): PaceWindowVerdict[] {
  return windows.filter(
    (window) =>
      window.role === "serviceability" &&
      window.utilization !== null &&
      toMilli(window.utilization) >= tripCeilingMilli,
  );
}

function stateFor(deviationMilli: number, marginMilli: number): "ahead" | "behind" | "on" {
  if (deviationMilli > marginMilli) return "ahead";
  if (deviationMilli < -marginMilli) return "behind";
  return "on";
}

export function evaluateLanePace(input: {
  observation: LanePaceObservation;
  asOf?: string;
  policy?: PacePolicy;
}): LanePaceVerdict {
  const marginMilli = toMilli(input.policy?.margin ?? DEFAULT_MARGIN);
  // A serviceability window at (or within the margin of) 1.0 trips.
  // Default margin 0.1 → trip at >= 0.9; a lane-configured margin widens it.
  const tripCeilingMilli = SCALE - marginMilli;
  const urgentResetSeconds = input.policy?.urgentResetSeconds ?? DEFAULT_URGENT_RESET_SECONDS;
  const maxSnapshotAgeSeconds = input.policy?.maxSnapshotAgeSeconds ?? DEFAULT_MAX_SNAPSHOT_AGE_SECONDS;
  const asOf = timestamp(input.asOf ?? input.observation.observedAt);

  if (input.observation.free) {
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "free", serviceable: true, score: null, targetBurnRate: null, observedBurnRate: null, deficit: null, accounts: [], knownAccountCount: 0, knownWeight: 0, serviceableAccountCount: 0, urgentResetAt: null, reason: "free-lane" };
  }
  if (input.observation.error === "invalid-document" || input.observation.observedAt === null || asOf === null) {
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "unknown", serviceable: null, score: null, targetBurnRate: null, observedBurnRate: null, deficit: null, accounts: [], knownAccountCount: 0, knownWeight: 0, serviceableAccountCount: 0, urgentResetAt: null, reason: "document-unavailable" };
  }
  if (input.observation.error === "invalid-account-identity") {
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "unknown", serviceable: null, score: null, targetBurnRate: null, observedBurnRate: null, deficit: null, accounts: [], knownAccountCount: 0, knownWeight: 0, serviceableAccountCount: 0, urgentResetAt: null, reason: "invalid-account-identity" };
  }
  if (input.observation.error === "no-records") {
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "unknown", serviceable: null, score: null, targetBurnRate: null, observedBurnRate: null, deficit: null, accounts: [], knownAccountCount: 0, knownWeight: 0, serviceableAccountCount: 0, urgentResetAt: null, reason: "no-records" };
  }
  const observedAtMs = Date.parse(input.observation.observedAt);
  const asOfMs = Date.parse(asOf);
  const freshnessBudget = Math.min(input.observation.staleAfterSeconds ?? maxSnapshotAgeSeconds, maxSnapshotAgeSeconds);
  if ((asOfMs - observedAtMs) / 1_000 > freshnessBudget ||
    (input.observation.accounts.some((account) => account.countsOnly) && observedAtMs - asOfMs > 60_000)) {
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "unknown", serviceable: null, score: null, targetBurnRate: null, observedBurnRate: null, deficit: null, accounts: [], knownAccountCount: 0, knownWeight: 0, serviceableAccountCount: 0, urgentResetAt: null, reason: "snapshot-stale" };
  }

  const internal = input.observation.accounts.map((account) => {
    const windows = account.windows.map((window) => scoredWindow(window, observedAtMs));
    const binding = bindingWindow(windows, account.governingWindow);
    const governing = governingWindow(account, windows);
    const accountStale = account.staleAfterSeconds != null &&
      (asOfMs - observedAtMs) / 1_000 > account.staleAfterSeconds;
    const accountServiceable = !accountStale && serviceable(account, windows, tripCeilingMilli);
    // Collected per account so the lane roll-up below can both detect
    // the trip and name the earliest relief it can offer.
    const tripped = trippedServiceabilityWindows(windows, tripCeilingMilli);
    const trippedResetsAt = tripped
      .flatMap((window) => (window.resetsAt === null ? [] : [{ ms: Date.parse(window.resetsAt), resetsAt: window.resetsAt }]))
      .filter((entry) => !Number.isNaN(entry.ms));
    const unknownAllowanceWeight = windows.some((window) =>
      window.role === "allowance" &&
      window.utilization !== null &&
      window.resetsAt !== null &&
      window.windowSeconds !== null &&
      window.allowanceWeight === null
    );
    if (!governing) {
      // A tripped serviceability window reads `exhausted` here too,
      // so the per-account output agrees with the lane roll-up below.
      const exhausted = account.health === "exhausted" || account.health === "unavailable" || tripped.length > 0;
      // The account declared a governing window that this snapshot cannot
      // resolve (absent, wrong role, or missing utilization/reset/weight). It
      // has no computable allowance, so it must not be dispatched to on some
      // other window's capacity.
      const indeterminateGovernor = accountServiceable && !account.countsOnly && account.governingWindow !== null;
      return {
        verdict: {
          accountKey: account.accountKey,
          authKey: account.authKey,
          plan: account.plan,
          health: account.health,
          weight: account.weight,
          weightSource: account.weightSource,
          governingWindow: null,
          governingResetAt: null,
          bindingWindow: null,
          bindingResetAt: null,
          recentBurnUnitsPerHour: account.recentBurnUnitsPerHour,
          staleAfterSeconds: account.staleAfterSeconds,
          serviceable: accountServiceable && !indeterminateGovernor,
          state: exhausted ? "exhausted" as const : "unknown" as const,
          score: null,
          normalizedRemaining: null,
          targetBurnRate: null,
          observedBurnRate: account.countsOnly ? null : account.recentBurnUnitsPerHour ?? null,
          deficit: null,
          recommendedShare: 0,
          paceDebt: null,
          clearRate: null,
          windows,
        },
        utilizationMilli: null,
        elapsedMilli: null,
        resetAtMs: null,
        aggregateWeight: null,
        indeterminateWeight: accountServiceable && unknownAllowanceWeight,
        indeterminateGovernor,
        tripped: tripped.length > 0,
        trippedResetsAt,
      };
    }
    const utilizationMilli = toMilli(governing.utilization!);
    const elapsedMilli = toMilli(governing.elapsed!);
    const accountScore = score(utilizationMilli, elapsedMilli);
    const exhausted = !accountServiceable;
    // A reported per-account decision (`governing_reset_at`, `target_burn_rate`,
    // `deficit`, `recommended_share`, `normalized_remaining`) is a statement
    // ABOUT the window the record declared. When a different allowance actually
    // binds — because the declaration went stale — those numbers describe some
    // other window's capacity, and reusing them paces the account off the loose
    // window while the tight one is the real constraint. Worse, a far-off
    // reported `governing_reset_at` suppresses the final-24h push on a window
    // that really is about to reset.
    const declaredGoverns = account.governingWindow !== null && governing.name === account.governingWindow;
    const reportedTargetBurnRate = declaredGoverns ? account.targetBurnRate : null;
    const reportedDeficit = declaredGoverns ? account.deficit : null;
    const effectiveTargetBurnRate = reportedTargetBurnRate ?? governing.clearRate;
    const reportedDecision = declaredGoverns && hasReportedAccountDecision(account);
    const effectiveDeficit = reportedDeficit ?? (
      (account.observedBurnRate ?? account.recentBurnUnitsPerHour) == null || effectiveTargetBurnRate == null
        ? effectiveTargetBurnRate
        : effectiveTargetBurnRate - (account.observedBurnRate ?? account.recentBurnUnitsPerHour)!
    );
    let state: PaceAccountVerdict["state"] = exhausted
      ? "exhausted"
      : reportedDecision && effectiveDeficit !== null
        ? effectiveDeficit > 0 ? "behind" : effectiveDeficit < 0 ? "ahead" : "on"
        : stateFor(utilizationMilli - elapsedMilli, marginMilli);
    const resetAt = (declaredGoverns ? account.governingResetAt : null) ?? governing.resetsAt;
    const resetSeconds = (Date.parse(resetAt!) - asOfMs) / 1_000;
    const governingUrgent = state === "behind" && resetSeconds >= 0 && resetSeconds < urgentResetSeconds;
    const windowUrgentResetAt = exhausted
      ? null
      : urgentPushResetAt(windows, asOfMs, marginMilli, urgentResetSeconds);
    const urgentResetAt = governingUrgent
      ? (windowUrgentResetAt !== null && Date.parse(windowUrgentResetAt) < Date.parse(resetAt!)
        ? windowUrgentResetAt
        : resetAt)
      : windowUrgentResetAt;
    if (!exhausted && urgentResetAt !== null) state = "push";
    return {
      verdict: {
        accountKey: account.accountKey,
        authKey: account.authKey,
        plan: account.plan,
        health: account.health,
        weight: account.weight,
        weightSource: account.weightSource,
        governingWindow: governing.name,
        governingResetAt: resetAt,
        bindingWindow: binding?.name ?? null,
        bindingResetAt: binding?.resetsAt ?? null,
        urgentResetAt,
        recentBurnUnitsPerHour: account.recentBurnUnitsPerHour,
        staleAfterSeconds: account.staleAfterSeconds,
        serviceable: accountServiceable,
        state,
        score: accountScore,
        normalizedRemaining: (declaredGoverns ? account.normalizedRemaining : null) ?? governing.normalizedRemaining,
        targetBurnRate: effectiveTargetBurnRate,
        observedBurnRate: account.observedBurnRate ?? account.recentBurnUnitsPerHour ?? null,
        deficit: effectiveDeficit,
        recommendedShare: declaredGoverns ? account.recommendedShare : null,
        paceDebt: governing.paceDebt,
        clearRate: governing.clearRate,
        windows,
      },
      utilizationMilli,
      elapsedMilli,
      resetAtMs: Date.parse(urgentResetAt ?? resetAt!),
      aggregateWeight: governing.allowanceWeight ?? account.weight,
      indeterminateWeight: accountServiceable && (governing.allowanceWeight ?? account.weight) === null,
      indeterminateGovernor: false,
      tripped: tripped.length > 0,
      trippedResetsAt,
    };
  });

  const serviceableAccountCount = internal.filter((entry) => entry.verdict.serviceable).length;
  // Every account's share must come off ONE basis. Reported shares are already
  // a distribution over the pool; the deficit fallback is a burn rate in
  // units/hour. Normalizing each basis against its own total and then summing
  // the two lets the lane hand out more than 100% — one reported 1.0 plus one
  // deficit-derived 1.0 is 200% of the lane. So reported shares are only used
  // when EVERY share-bearing account reports one; otherwise the whole lane
  // falls back to the deficit basis and the totals stay a partition of 1.
  const shareCandidates = internal.filter((entry) =>
    entry.verdict.serviceable && entry.verdict.targetBurnRate != null);
  const useReportedShares = shareCandidates.length > 0 &&
    shareCandidates.every((entry) => entry.verdict.recommendedShare != null);
  const rawShare = (entry: typeof internal[number]): number => useReportedShares
    ? Math.max(0, entry.verdict.recommendedShare!)
    : Math.max(0, entry.verdict.deficit ?? entry.verdict.targetBurnRate!);
  const shareDenominator = shareCandidates.reduce((sum, entry) => sum + rawShare(entry), 0);
  const accounts = internal.map((entry) => ({
    ...entry.verdict,
    recommendedShare: !entry.verdict.serviceable || entry.verdict.targetBurnRate == null || shareDenominator <= 0
      ? 0
      : rawShare(entry) / shareDenominator,
  }));
  // A tripped serviceability window condemns the lane only when no
  // account can still serve (serviceableAccountCount == 0). A healthy sibling
  // keeps the lane open; the tripped account itself stays excluded —
  // serviceable:false, state:exhausted, recommendedShare 0 — so dispatch never
  // rides it. The no-failover evidence is preserved at the account
  // level, where the provider actually routes; the lane roll-up no longer
  // repeats it. With nothing serviceable left the lane is still poisoned, and
  // the tripped reset stays ahead of every other exit: it is the earliest
  // possible relief, not a reopen time.
  if (internal.some((entry) => entry.tripped) && serviceableAccountCount === 0) {
    const trippedResets = internal.flatMap((entry) => entry.trippedResetsAt)
      .sort((left, right) => left.ms - right.ms);
    const known = internal.filter((entry) => entry.utilizationMilli !== null);
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "exhausted", serviceable: false, score: null, targetBurnRate: 0, observedBurnRate: 0, deficit: 0, accounts, knownAccountCount: known.length, knownWeight: known.reduce((sum, entry) => sum + (entry.aggregateWeight ?? 0), 0), serviceableAccountCount, urgentResetAt: trippedResets[0]?.resetsAt ?? null, reason: "serviceability-window-exhausted" };
  }
  if (internal.some((entry) => entry.indeterminateWeight)) {
    const weighted = internal.filter((entry) => entry.verdict.serviceable && entry.aggregateWeight !== null);
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "unknown", serviceable: null, score: null, targetBurnRate: null, observedBurnRate: null, deficit: null, accounts, knownAccountCount: weighted.length, knownWeight: weighted.reduce((sum, entry) => sum + entry.aggregateWeight!, 0), serviceableAccountCount, urgentResetAt: null, reason: "indeterminate-account-weight" };
  }
  if (internal.some((entry) => entry.indeterminateGovernor)) {
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "unknown", serviceable: null, score: null, targetBurnRate: null, observedBurnRate: null, deficit: null, accounts, knownAccountCount: 0, knownWeight: 0, serviceableAccountCount, urgentResetAt: null, reason: "invalid-configured-governing-window" };
  }
  if (serviceableAccountCount === 0) {
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "exhausted", serviceable: false, score: null, targetBurnRate: 0, observedBurnRate: 0, deficit: 0, accounts, knownAccountCount: internal.filter((entry) => entry.utilizationMilli !== null).length, knownWeight: internal.filter((entry) => entry.utilizationMilli !== null).reduce((sum, entry) => sum + (entry.aggregateWeight ?? 0), 0), serviceableAccountCount, urgentResetAt: null, reason: "all-accounts-unserviceable" };
  }

  const known = internal.filter((entry): entry is typeof entry & { utilizationMilli: number; elapsedMilli: number; resetAtMs: number; aggregateWeight: number } =>
    entry.verdict.serviceable &&
    entry.utilizationMilli !== null &&
    entry.elapsedMilli !== null &&
    entry.resetAtMs !== null &&
    entry.aggregateWeight !== null
  );
  if (known.length === 0) {
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "unknown", serviceable: true, score: null, targetBurnRate: null, observedBurnRate: null, deficit: null, accounts, knownAccountCount: 0, knownWeight: 0, serviceableAccountCount, urgentResetAt: null, reason: "no-computable-governing-window" };
  }

  const utilizationMilli = weightedMilli(known.map((entry) => ({ value: entry.utilizationMilli, weight: entry.aggregateWeight })));
  const elapsedMilli = weightedMilli(known.map((entry) => ({ value: entry.elapsedMilli, weight: entry.aggregateWeight })));
  const laneScore = score(utilizationMilli, elapsedMilli);
  const targetBurnRate = accounts.reduce((sum, account) =>
    account.serviceable && account.targetBurnRate != null ? sum + account.targetBurnRate : sum,
  0);
  const observedBurnRate = accounts.reduce((sum, account) =>
    account.serviceable && account.observedBurnRate != null ? sum + account.observedBurnRate : sum,
  0);
  const deficit = accounts.reduce((sum, account) =>
    account.serviceable && account.deficit != null ? sum + account.deficit : sum,
  0);
  let state: LanePaceVerdict["state"] = stateFor(utilizationMilli - elapsedMilli, marginMilli);
  const urgent = known
    .filter((entry) => entry.verdict.state === "push")
    .sort((left, right) => left.resetAtMs - right.resetAtMs)[0];
  if (urgent) state = "behind-urgent";
  return {
    laneId: input.observation.laneId,
    observedAt: input.observation.observedAt,
    state,
    serviceable: true,
    score: laneScore,
    targetBurnRate,
    observedBurnRate,
    deficit,
    accounts,
    knownAccountCount: known.length,
    knownWeight: known.reduce((sum, entry) => sum + entry.aggregateWeight, 0),
    serviceableAccountCount,
    urgentResetAt: urgent?.verdict.urgentResetAt ?? urgent?.verdict.governingResetAt ?? null,
    reason: "ok",
  };
}
