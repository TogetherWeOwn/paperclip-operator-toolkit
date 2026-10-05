import { describe, expect, it } from "vitest";

import {
  CRIT_LAG_SECONDS,
  DECISION_LOG_LAG_SCHEMA,
  WARN_LAG_SECONDS,
} from "../src/decision-log-lag.js";
import {
  SWEEP_LAG_CRIT_SECONDS,
  SWEEP_LAG_WARN_SECONDS,
  readoutSweepLagFreshness,
  type SweepLagDecision,
} from "../src/watchdog-lag-readout.js";

/**
 * : watchdog lag-detector sweep wire-up — propose-only freshness
 * readout + threshold tests.
 *
 * Parent  under epic  ( watchdog). Consumes the
 * done  decision-log-lag pure module in the scheduled sweep path:
 * defaults warn 600s / crit 3600s, per-call overrides, always a proposal
 * shape; never routes alerts, never recovers anything, no credentials.
 *
 * NON-GOALS (owned elsewhere):  shadow-gap (blocked);
 *  proposal-delivery (in_progress);  run-stall (done).
 */

export const NOW_MS = Date.parse("2026-10-04T00:00:00.000Z");

function decision(
  issueId: string,
  emitMsAgo: number,
  writer: string = "plugin-shadow",
): SweepLagDecision {
  return { issueId, writer, ts: new Date(NOW_MS - emitMsAgo).toISOString() };
}

function input(
  decisions: readonly SweepLagDecision[],
  extra: { thresholds?: { warnSeconds: number; critSeconds: number }; now?: number } = {},
): { now: number; decisions: readonly SweepLagDecision[]; thresholds?: { warnSeconds: number; critSeconds: number } } {
  return { now: NOW_MS, decisions, ...extra };
}

describe(" watchdog lag readout", () => {
  it("defaults to warn 600s / crit 3600s", () => {
    expect(SWEEP_LAG_WARN_SECONDS).toBe(WARN_LAG_SECONDS);
    expect(SWEEP_LAG_CRIT_SECONDS).toBe(CRIT_LAG_SECONDS);
    expect(SWEEP_LAG_WARN_SECONDS).toBe(600);
    expect(SWEEP_LAG_CRIT_SECONDS).toBe(3600);
  });

  it("reads ok when every emit is inside the warn band", () => {
    const result = readoutSweepLagFreshness(
      input([decision("issue-1", 60_000), decision("issue-2", 120_000)]),
    );
    expect(result.schema).toBe(DECISION_LOG_LAG_SCHEMA);
    expect(result.mode).toBe("propose-only");
    expect(result.verdict).toBe("ok");
    expect(result.maxLagSeconds).toBe(120);
    expect(result.proposal).toMatchObject({
      action: "none",
      reason: "lag-within-band",
      thresholdSeconds: null,
      breachingRecordIds: [],
    });
  });

  it("reads warn at exactly the warn boundary, ok one millisecond under it", () => {
    const atWarn = readoutSweepLagFreshness(input([decision("issue-1", WARN_LAG_SECONDS * 1000)]));
    expect(atWarn.verdict).toBe("warn");
    expect(atWarn.maxLagSeconds).toBe(WARN_LAG_SECONDS);
    expect(atWarn.proposal).toMatchObject({
      action: "investigate",
      reason: "decision-log-lag-at-or-above-warn",
      thresholdSeconds: WARN_LAG_SECONDS,
    });

    const underWarn = readoutSweepLagFreshness(
      input([decision("issue-1", WARN_LAG_SECONDS * 1000 - 1)]),
    );
    expect(underWarn.verdict).toBe("ok");
    expect(underWarn.maxLagSeconds).toBe(WARN_LAG_SECONDS - 1);
  });

  it("reads crit at exactly the crit boundary, warn one millisecond under it", () => {
    const atCrit = readoutSweepLagFreshness(input([decision("issue-1", CRIT_LAG_SECONDS * 1000)]));
    expect(atCrit.verdict).toBe("crit");
    expect(atCrit.maxLagSeconds).toBe(CRIT_LAG_SECONDS);
    expect(atCrit.proposal).toMatchObject({
      action: "propose-escalation",
      reason: "decision-log-lag-at-or-above-crit",
      thresholdSeconds: CRIT_LAG_SECONDS,
    });

    const underCrit = readoutSweepLagFreshness(
      input([decision("issue-1", CRIT_LAG_SECONDS * 1000 - 1)]),
    );
    expect(underCrit.verdict).toBe("warn");
    expect(underCrit.maxLagSeconds).toBe(CRIT_LAG_SECONDS - 1);
  });

  it("keeps the host/shadow pair as two observations sharing one ts", () => {
    const ts = new Date(NOW_MS - 90_000).toISOString();
    const result = readoutSweepLagFreshness(
      input([
        { issueId: "issue-1", writer: "host", ts },
        { issueId: "issue-1", writer: "plugin-shadow", ts },
      ]),
    );
    expect(result.recordCount).toBe(2);
    expect(result.computableCount).toBe(2);
    expect(result.verdict).toBe("ok");
    expect(result.maxLagSeconds).toBe(90);
  });

  it("keeps successive decisions on one issue distinct through the ts", () => {
    const result = readoutSweepLagFreshness(
      input([decision("issue-1", 30_000), decision("issue-1", CRIT_LAG_SECONDS * 1000)]),
    );
    expect(result.recordCount).toBe(2);
    expect(result.verdict).toBe("crit");
    expect(result.maxLagSeconds).toBe(CRIT_LAG_SECONDS);
  });

  it("collapses byte-identical re-reads to one observation", () => {
    const same = decision("issue-1", 45_000);
    const result = readoutSweepLagFreshness(input([same, { ...same }, decision("issue-2", 45_000)]));
    expect(result.recordCount).toBe(2);
    expect(result.verdict).toBe("ok");
  });

  it("reads unknown for unparseable timestamps, never as fresh", () => {
    const result = readoutSweepLagFreshness(
      input([{ issueId: "issue-1", writer: "plugin-shadow", ts: "not-a-timestamp" }]),
    );
    expect(result.verdict).toBe("unknown");
    expect(result.maxLagSeconds).toBeNull();
    expect(result.proposal).toMatchObject({
      action: "none",
      reason: "no-computable-emit-timestamps",
    });
  });

  it("treats future-dated emits as skew, never as fresh", () => {
    const result = readoutSweepLagFreshness(
      input([
        { issueId: "issue-1", writer: "plugin-shadow", ts: new Date(NOW_MS + 60_000).toISOString() },
        decision("issue-2", 45_000),
      ]),
    );
    expect(result.verdict).toBe("ok");
    expect(result.maxLagSeconds).toBe(45);
  });

  it("is propose-only: never routes, never recovers", () => {
    const result = readoutSweepLagFreshness(
      input([decision("issue-1", CRIT_LAG_SECONDS * 1000 * 2)]),
    );
    expect(result.mode).toBe("propose-only");
    expect(result.routesAlerts).toBe(false);
    expect(result.autoRecovers).toBe(false);
    expect(result.proposal.routedAsAlert).toBe(false);
    expect(result.proposal.autoRecoveryAttempted).toBe(false);
    expect(result.rollbackNotes.join(" ")).toMatch(/discarding/i);
  });

  it("honors a valid per-call threshold override", () => {
    const result = readoutSweepLagFreshness(
      input([decision("issue-1", 90_000)], { thresholds: { warnSeconds: 60, critSeconds: 120 } }),
    );
    expect(result.verdict).toBe("warn");
    expect(result.proposal.thresholdSeconds).toBe(60);
  });

  it("rejects threshold bands that are not 0 < warn < crit", () => {
    expect(() =>
      readoutSweepLagFreshness(
        input([decision("issue-1", 1000)], { thresholds: { warnSeconds: 120, critSeconds: 120 } }),
      ),
    ).toThrow("lag-threshold-bands-must-separate");
    expect(() =>
      readoutSweepLagFreshness(
        input([decision("issue-1", 1000)], { thresholds: { warnSeconds: 300, critSeconds: 60 } }),
      ),
    ).toThrow("lag-threshold-bands-must-separate");
    expect(() =>
      readoutSweepLagFreshness(
        input([decision("issue-1", 1000)], { thresholds: { warnSeconds: 0, critSeconds: 60 } }),
      ),
    ).toThrow("invalid-lag-warn-threshold");
    expect(() =>
      readoutSweepLagFreshness(
        input([decision("issue-1", 1000)], { thresholds: { warnSeconds: 60, critSeconds: -1 } }),
      ),
    ).toThrow("invalid-lag-crit-threshold");
  });

  it("rejects malformed sweep observations", () => {
    expect(() =>
      readoutSweepLagFreshness(
        input([{ issueId: "", writer: "plugin-shadow", ts: new Date(NOW_MS).toISOString() }]),
      ),
    ).toThrow("invalid-sweep-lag-decision");
    expect(() =>
      readoutSweepLagFreshness(
        input([{ issueId: "issue-1", writer: "", ts: new Date(NOW_MS).toISOString() }]),
      ),
    ).toThrow("invalid-sweep-lag-decision");
    expect(() =>
      readoutSweepLagFreshness(input([{ issueId: "issue-1", writer: "plugin-shadow", ts: "" }])),
    ).toThrow("invalid-sweep-lag-decision");
  });

  it("caps at the detector's 256-record limit rather than silently dropping", () => {
    const decisions = Array.from({ length: 257 }, (_, i) =>
      decision(`issue-${i}`, 1000 + i),
    );
    expect(() => readoutSweepLagFreshness(input(decisions))).toThrow("too-many-lag-records");
  });
});
