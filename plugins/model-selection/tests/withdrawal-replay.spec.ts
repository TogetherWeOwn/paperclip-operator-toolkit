import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  laneWithdrawal,
  mergeLedgerEntry,
  type LaneAvoidConfig,
  type LaneLedger,
} from "../src/engine/pacing.js";
import { selectModel } from "../src/engine/select.js";
import type { ModelEntry } from "../src/engine/types.js";
import { evaluateLanePace, type LanePaceObservation } from "../src/lane-capacity/pace.js";
import { MODELS, NO_ESCALATION, PROFILES, config } from "./fixtures.js";

/**
 *  replay. 23 T1 decisions cut from the 579 `plugin-shadow` records
 * that overlap the live bridge's log (shadow-agreement report v2),
 * spread over the four bridge regimes the stream saw:
 *
 *   muse_headroom_expires_first  bridge picks MUSE   (its MUSE ceiling was 0.95)
 *   muse_collective_95           bridge withdraws MUSE at 0.95 -> gpt-6.1-sol
 *   meta_weekly_below_98         bridge picks MUSE   (ceiling now 0.98)
 *   claude_5h_below_98           bridge withdraws MUSE at 0.98 -> claude-sonnet-5-5
 *
 * Each record carries the Meta lane's 8 recorded accounts and the selector's
 * usable candidates. The replay rebuilds the lane verdict with the real pace
 * engine (`evaluateLanePace`), merges it into the ledger the way the poller
 * does, and runs the real `selectModel` with the ceiling the bridge was using
 * at that moment. Acceptance, from the card: no MUSE pick anywhere the bridge
 * withdraws, and no change anywhere it does not.
 *
 * Scope, stated plainly: this isolates the MUSE withdrawal. What the selector
 * picks INSTEAD (cost order puts gpt-6.1-sol ahead of claude-sonnet-5-5) is a
 * separate parity question and is not asserted here.
 */

interface ReplayAccount {
  accountKey: string;
  health: "healthy" | "degraded" | "exhausted" | "unavailable" | "unknown";
  serviceable: boolean;
  weight: number;
  governingWindow: string;
  governingResetAt: string;
  utilization: number;
}
interface ReplayRecord {
  ts: string;
  regime: string;
  bridgeCeiling: number;
  bridge: { model: string; reason: string; meta_combined: number | null };
  selectorPick: string;
  ageSeconds: number;
  metaAccounts: ReplayAccount[];
  candidates: Array<{ model: string; lane: string; tier: "T1"; blended: number }>;
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/withdrawal-replay/t1-records.json", import.meta.url), "utf8"),
) as { population: Record<string, { t1RecordsOverlappingBridgeLog: number }>; records: ReplayRecord[] };

const META = "cliproxy-meta";
const isMuse = (modelId: string) => modelId.startsWith("muse-spark");
const bridgeWithdrawsMuse = (record: ReplayRecord) => !isMuse(record.bridge.model);

function ledgerFor(record: ReplayRecord): LaneLedger {
  const observedAt = new Date(Date.parse(record.ts) - record.ageSeconds * 1000).toISOString();
  const observation: LanePaceObservation = {
    laneId: META,
    free: false,
    observedAt,
    staleAfterSeconds: 900,
    error: null,
    accounts: record.metaAccounts.map((entry) => ({
      accountKey: entry.accountKey,
      health: entry.health,
      weight: entry.weight,
      weightSource: "reported" as const,
      governingWindow: entry.governingWindow,
      windows: [
        {
          name: entry.governingWindow,
          role: "allowance" as const,
          utilization: entry.utilization,
          resetsAt: entry.governingResetAt,
          windowSeconds: 7 * 24 * 60 * 60,
          allowanceWeight: entry.weight,
          allowanceWeightSource: "reported" as const,
          sourcePath: null,
        },
      ],
    })),
  };
  const verdict = evaluateLanePace({ observation, asOf: record.ts });
  return mergeLedgerEntry({}, { laneId: META, fetchedAt: record.ts, verdict, observation, error: null });
}

function rosterFor(record: ReplayRecord): ModelEntry[] {
  const template = MODELS.find((entry) => entry.tier === "T1")!;
  // Rates proportional to the recorded blended price keep the engine's cost
  // order identical to the recorded one whatever the volume profile weights.
  return record.candidates.map((entry) => ({
    ...template,
    id: entry.model,
    tier: entry.tier,
    laneId: entry.lane,
    costPerMTokIn: entry.blended,
    costPerMTokOut: entry.blended,
    costPerMTokCacheRead: entry.blended * 0.1,
    // The two Muse rows tie on price; the newer release wins the tie, which is
    // how the recorded stream landed on 1.3 rather than 1.2.
    releasedAt: entry.model.startsWith("muse-spark-1.3") ? "2026-09-01" : "2026-01-01",
  }));
}

function pick(record: ReplayRecord, withdrawAt?: Record<string, number>): string | null {
  const avoid: LaneAvoidConfig = { defaultThreshold: 0.8, perLane: {}, ...(withdrawAt ? { withdrawAt } : {}) };
  const decision = selectModel({
    // The shared profiles are dated to the unit-test clock; re-date them so the
    // volume term is as fresh and trusted as it was when the record was written.
    profiles: PROFILES.map((profile) => ({ ...profile, computedAt: new Date(Date.parse(record.ts) - 60 * 60 * 1000).toISOString() })),
    signals: NO_ESCALATION,
    now: Date.parse(record.ts),
    descriptor: { issueId: `replay-${record.ts}`, labelNames: ["tier:T1"] },
    config: config({
      models: rosterFor(record),
      pacingMode: "enforce",
      laneLedger: ledgerFor(record),
      laneAvoidConfig: avoid,
      stickyWithinIssue: false,
    }),
  });
  return decision.modelId;
}

describe(" replay of recorded T1 decisions", () => {
  it("covers all four bridge regimes, with both a withdrawing and a non-withdrawing side", () => {
    const regimes = new Set(fixture.records.map((record) => record.regime));
    expect([...regimes].sort()).toEqual([
      "claude_5h_below_98",
      "meta_weekly_below_98",
      "muse_collective_95",
      "muse_headroom_expires_first",
    ]);
    expect(fixture.records.some(bridgeWithdrawsMuse)).toBe(true);
    expect(fixture.records.some((record) => !bridgeWithdrawsMuse(record))).toBe(true);
    // The cut is a sample of a recorded population, and says which.
    expect(fixture.population.claude_5h_below_98!.t1RecordsOverlappingBridgeLog).toBeGreaterThan(200);
  });

  it("rebuilds the recorded lane read through the real pace engine before any new rule is applied", () => {
    for (const record of fixture.records) {
      const ledgered = ledgerFor(record)[META]!.verdict!;
      expect(ledgered.accounts.map((entry) => [entry.accountKey, entry.serviceable])).toEqual(
        record.metaAccounts.map((entry) => [entry.accountKey, entry.serviceable]),
      );
    }
  });

  it("baseline: with no ceiling the replay picks exactly what the recorded stream picked, MUSE on every record", () => {
    for (const record of fixture.records) {
      expect(pick(record), `${record.ts} ${record.regime}`).toBe(record.selectorPick);
      expect(isMuse(record.selectorPick), record.ts).toBe(true);
    }
  });

  it("with the bridge's own ceiling, withdraws the lane exactly where the bridge does", () => {
    for (const record of fixture.records) {
      const ledger = ledgerFor(record);
      const withdrawal = laneWithdrawal(
        ledger,
        META,
        { defaultThreshold: 0.8, perLane: {}, withdrawAt: { [META]: record.bridgeCeiling } },
        Date.parse(record.ts),
      );
      expect(
        withdrawal !== null,
        `${record.ts} ${record.regime}: ceiling ${record.bridgeCeiling}, combined ${ledger[META]!.combinedUtilization?.utilization}`,
      ).toBe(bridgeWithdrawsMuse(record));
    }
  });

  it("withdrawal regimes: zero MUSE picks", () => {
    const withdrawn = fixture.records.filter(bridgeWithdrawsMuse);
    expect(withdrawn.length).toBeGreaterThan(0);
    for (const record of withdrawn) {
      const picked = pick(record, { [META]: record.bridgeCeiling });
      expect(picked, record.ts).not.toBeNull();
      expect(isMuse(picked!), `${record.ts} ${record.regime} still picked ${picked}`).toBe(false);
    }
  });

  it("MUSE regimes: every pick unchanged from the no-ceiling baseline", () => {
    const kept = fixture.records.filter((record) => !bridgeWithdrawsMuse(record));
    expect(kept.length).toBeGreaterThan(0);
    for (const record of kept) {
      expect(pick(record, { [META]: record.bridgeCeiling }), record.ts).toBe(pick(record));
    }
  });

  it("one ceiling does not fit both regimes: 0.95 would withdraw MUSE while the bridge still picks it at 0.98", () => {
    // Why the threshold is config and not a constant: the host moved 0.95 -> 0.98
    // inside a day, and the records that were right at one are wrong at the other.
    const wronglyWithdrawn = fixture.records.filter(
      (record) => record.regime === "meta_weekly_below_98" && pick(record, { [META]: 0.95 }) !== pick(record),
    );
    expect(wronglyWithdrawn.length).toBeGreaterThan(0);
  });
});
