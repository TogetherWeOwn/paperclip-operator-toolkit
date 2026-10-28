import { TIERS, type Tier } from "../constants.js";

/**
 * One shadow pair: what the classifier decided (`t`), what the deterministic
 * baseline said (`b`, null when it abstained), and whether they agreed (`a`,
 * null on abstention). Stored per company under
 * `PLUGIN_STATE_KEYS.classifierShadow` as a bounded rolling window — the
 * evidence feed the entry-gate enforcement bar (agreement over live decisive
 * pairs) and the drift exit (classifier T1 share) both read.
 */
export interface ShadowOutcome {
  t: Tier;
  b: "T2" | "T3" | null;
  a: boolean | null;
}

export interface ShadowWindow {
  outcomes: ShadowOutcome[];
}

/** Rolling window cap: the state value never grows past 50 small records. */
export const SHADOW_WINDOW_MAX = 50;

export function emptyShadowWindow(): ShadowWindow {
  return { outcomes: [] };
}

function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

function isOutcome(value: unknown): value is ShadowOutcome {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    isTier(o.t) &&
    (o.b === null || o.b === "T2" || o.b === "T3") &&
    (o.a === null || typeof o.a === "boolean")
  );
}

/**
 * Parse a stored window fail-open: anything missing, corrupt, or over-long
 * degrades to an empty (or trimmed) window. The classify path must never
 * throw on state it did not write.
 */
export function parseShadowWindow(stored: unknown): ShadowWindow {
  if (!stored || typeof stored !== "object") return emptyShadowWindow();
  const outcomes = (stored as Record<string, unknown>).outcomes;
  if (!Array.isArray(outcomes)) return emptyShadowWindow();
  return { outcomes: outcomes.filter(isOutcome).slice(-SHADOW_WINDOW_MAX) };
}

/** Immutable append; drops the oldest outcomes past the cap. */
export function recordShadowOutcome(window: ShadowWindow, outcome: ShadowOutcome): ShadowWindow {
  return { outcomes: [...window.outcomes, outcome].slice(-SHADOW_WINDOW_MAX) };
}

export interface ShadowStats {
  /** Outcomes in the window. */
  n: number;
  /** Outcomes where the baseline was decisive (non-abstention). */
  decisive: number;
  /** Decisive outcomes where baseline and classifier agreed. */
  agreed: number;
  /** Outcomes where the classifier chose T1. */
  t1: number;
}

export function shadowStats(window: ShadowWindow): ShadowStats {
  let decisive = 0;
  let agreed = 0;
  let t1 = 0;
  for (const o of window.outcomes) {
    if (o.b !== null) {
      decisive += 1;
      if (o.a === true) agreed += 1;
    }
    if (o.t === "T1") t1 += 1;
  }
  return { n: window.outcomes.length, decisive, agreed, t1 };
}

/**
 * Drift exit (report-only): true once the window holds at least `minN`
 * outcomes and the classifier's T1 share reaches `t1Share`. The default bar
 * (50 outcomes, 0.85) sits above the measured 0.77 historical skew, so normal
 * operation stays clear of it.
 */
export function driftActive(window: ShadowWindow, minN: number, t1Share: number): boolean {
  const stats = shadowStats(window);
  return stats.n >= minN && stats.t1 / stats.n >= t1Share;
}
