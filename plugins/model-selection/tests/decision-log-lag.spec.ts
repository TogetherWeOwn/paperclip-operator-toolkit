import { describe, expect, it } from "vitest";

import {
  CRIT_LAG_SECONDS,
  DECISION_LOG_LAG_SCHEMA,
  detectDecisionLogLag,
  MAX_BREACH_IDS,
  WARN_LAG_SECONDS,
} from "../src/decision-log-lag.js";
import { baseInput, emit, NOW_MS } from "./decision-log-lag-fixtures.js";

/**
 * : watchdog decision-log lag detector — emit vs observed (propose-only).
 *
 * Parent  (complements in_progress  run-stall and 
 * exit-143 probe). Pure lag function + threshold tests + proposal shape only:
 * no alert-routing change, no auto-recovery, no host access.
 *
 * NON-GOALS (owned elsewhere):  shadow-emit gap (completeness, not
 * lag);  quota-expiry;  stale-review; /
 * proposal-delivery;  host-disk;  red-main triage;
 *  supply-famine.
 */

describe(" decision-log lag detector", () => {
  it("reads ok when every lag is inside the warn band", () => {
    const result = detectDecisionLogLag(baseInput());
    expect(result.schema).toBe(DECISION_LOG_LAG_SCHEMA);
    expect(result.verdict).toBe("ok");
    expect(result.maxLagSeconds).toBe(120);
    expect(result.computableCount).toBe(2);
    expect(result.proposal).toMatchObject({
      action: "none",
      reason: "lag-within-band",
      thresholdSeconds: null,
      breachingRecordIds: [],
    });
  });

  it("reads warn at exactly the warn boundary, ok one millisecond under it", () => {
    const atWarn = detectDecisionLogLag(
      baseInput({ emits: [emit("rec-warn", WARN_LAG_SECONDS * 1000)] }),
    );
    expect(atWarn.verdict).toBe("warn");
    expect(atWarn.maxLagSeconds).toBe(WARN_LAG_SECONDS);
    expect(atWarn.proposal).toMatchObject({
      action: "investigate",
      reason: "decision-log-lag-at-or-above-warn",
      thresholdSeconds: WARN_LAG_SECONDS,
      breachingRecordIds: ["rec-warn"],
    });

    const underWarn = detectDecisionLogLag(
      baseInput({ emits: [emit("rec-ok", WARN_LAG_SECONDS * 1000 - 1)] }),
    );
    expect(underWarn.verdict).toBe("ok");
    expect(underWarn.maxLagSeconds).toBe(WARN_LAG_SECONDS - 1);
  });

  it("reads crit at exactly the crit boundary, warn one millisecond under it", () => {
    const atCrit = detectDecisionLogLag(
      baseInput({ emits: [emit("rec-crit", CRIT_LAG_SECONDS * 1000)] }),
    );
    expect(atCrit.verdict).toBe("crit");
    expect(atCrit.maxLagSeconds).toBe(CRIT_LAG_SECONDS);
    expect(atCrit.proposal).toMatchObject({
      action: "propose-escalation",
      reason: "decision-log-lag-at-or-above-crit",
      thresholdSeconds: CRIT_LAG_SECONDS,
      breachingRecordIds: ["rec-crit"],
    });

    const underCrit = detectDecisionLogLag(
      baseInput({ emits: [emit("rec-warn", CRIT_LAG_SECONDS * 1000 - 1)] }),
    );
    expect(underCrit.verdict).toBe("warn");
    expect(underCrit.maxLagSeconds).toBe(CRIT_LAG_SECONDS - 1);
  });

  it("lets the max lag govern a mixed set", () => {
    const result = detectDecisionLogLag(
      baseInput({
        emits: [emit("rec-fresh", 30_000), emit("rec-stale", CRIT_LAG_SECONDS * 1000)],
      }),
    );
    expect(result.verdict).toBe("crit");
    expect(result.maxLagSeconds).toBe(CRIT_LAG_SECONDS);
    expect(result.proposal.breachingRecordIds).toEqual(["rec-stale"]);
    expect(result.lags.find((l) => l.recordId === "rec-fresh")?.status).toBe("ok");
    expect(result.lags.find((l) => l.recordId === "rec-stale")?.status).toBe("crit");
  });

  it("sorts and caps breaching ids", () => {
    const emits = Array.from({ length: MAX_BREACH_IDS + 8 }, (_, i) => ({
      recordId: `rec-${String(MAX_BREACH_IDS + 8 - i).padStart(3, "0")}`,
      emitAt: NOW_MS - CRIT_LAG_SECONDS * 1000,
    }));
    const result = detectDecisionLogLag(baseInput({ emits }));
    expect(result.verdict).toBe("crit");
    expect(result.proposal.breachingRecordIds).toHaveLength(MAX_BREACH_IDS);
    expect(result.proposal.breachingRecordIds).toEqual(
      [...result.proposal.breachingRecordIds].sort(),
    );
  });

  it("reads unknown when no emit timestamp is computable", () => {
    const result = detectDecisionLogLag(
      baseInput({ emits: [emit("rec-a", null), { recordId: "rec-b" }] }),
    );
    expect(result.verdict).toBe("unknown");
    expect(result.maxLagSeconds).toBeNull();
    expect(result.computableCount).toBe(0);
    expect(result.proposal).toMatchObject({
      action: "none",
      reason: "no-computable-emit-timestamps",
    });
    for (const lag of result.lags) expect(lag.status).toBe("unknown");
  });

  it("treats a future-dated emit as skew, never as fresh", () => {
    const skewOnly = detectDecisionLogLag(
      baseInput({ emits: [{ recordId: "rec-skew", emitAt: NOW_MS + 60_000 }] }),
    );
    expect(skewOnly.verdict).toBe("unknown");
    expect(skewOnly.maxLagSeconds).toBeNull();
    expect(skewOnly.lags[0]?.status).toBe("unknown");

    const skewPlusFresh = detectDecisionLogLag(
      baseInput({
        emits: [{ recordId: "rec-skew", emitAt: NOW_MS + 60_000 }, emit("rec-fresh", 45_000)],
      }),
    );
    // Skew is excluded from the max: the fresh record alone governs.
    expect(skewPlusFresh.verdict).toBe("ok");
    expect(skewPlusFresh.maxLagSeconds).toBe(45);
  });

  it("is propose-only: never routes, never recovers", () => {
    const result = detectDecisionLogLag(
      baseInput({ emits: [emit("rec-crit", CRIT_LAG_SECONDS * 1000 * 2)] }),
    );
    expect(result.mode).toBe("propose-only");
    expect(result.routesAlerts).toBe(false);
    expect(result.autoRecovers).toBe(false);
    expect(result.proposal.routedAsAlert).toBe(false);
    expect(result.proposal.autoRecoveryAttempted).toBe(false);
    expect(result.rollbackNotes.join(" ")).toMatch(/discarding/i);
  });

  it("honors a valid per-call threshold override", () => {
    const result = detectDecisionLogLag(
      baseInput({
        emits: [emit("rec-1", 90_000)],
        thresholds: { warnSeconds: 60, critSeconds: 120 },
      }),
    );
    expect(result.verdict).toBe("warn");
    expect(result.proposal.thresholdSeconds).toBe(60);
  });

  it("rejects blended threshold bands that would flap", () => {
    expect(() =>
      detectDecisionLogLag(baseInput({ thresholds: { warnSeconds: 120, critSeconds: 120 } })),
    ).toThrow("lag-threshold-bands-must-separate");
    expect(() =>
      detectDecisionLogLag(baseInput({ thresholds: { warnSeconds: 300, critSeconds: 60 } })),
    ).toThrow("lag-threshold-bands-must-separate");
    expect(() =>
      detectDecisionLogLag(baseInput({ thresholds: { warnSeconds: 0, critSeconds: 60 } })),
    ).toThrow("invalid-lag-warn-threshold");
  });

  it("rejects malformed input", () => {
    expect(() => detectDecisionLogLag(baseInput({ now: NaN }))).toThrow("invalid-lag-clock");
    expect(() => detectDecisionLogLag(baseInput({ now: -1 }))).toThrow("invalid-lag-clock");
    expect(() =>
      detectDecisionLogLag(baseInput({ emits: [emit("dup", 1000), emit("dup", 2000)] })),
    ).toThrow("invalid-lag-record-identity");
    expect(() =>
      detectDecisionLogLag(
        baseInput({ emits: [{ recordId: "rec-neg", emitAt: -5 }] }),
      ),
    ).toThrow("invalid-lag-emit-at");
    expect(() =>
      detectDecisionLogLag(
        baseInput({ emits: Array.from({ length: 257 }, (_, i) => emit(`rec-${i}`, 1000)) }),
      ),
    ).toThrow("too-many-lag-records");
  });
});
