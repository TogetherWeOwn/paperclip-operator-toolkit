import { describe, expect, it } from "vitest";

import {
  ANCILLARY_MODEL_ENV_KEYS,
  modelOverrideForContext,
} from "../src/engine/context.js";
import {
  earnInGuardFor,
  freeEarnInCandidates,
  freeEarnInWinner,
} from "../src/engine/free-lane-earn-in.js";
import { isAdapterBlockedModel, isDevinModelId } from "../src/engine/model-id.js";
import { selectModel } from "../src/engine/select.js";
import { normalizeAvailability } from "../src/engine/availability.js";
import type { Candidate, ModelEntry, ModelScore } from "../src/engine/types.js";
import { JOB_KEYS, type Tier } from "../src/constants.js";
import type { LaneLedger } from "../src/engine/pacing.js";
import type { LanePaceVerdict } from "../src/lane-capacity/pace.js";
import manifest from "../src/manifest.js";
import { LANED_MODELS, MODELS, NO_ESCALATION, NOW, PROFILES, account, config, laneDoc } from "./fixtures.js";

const base = { profiles: PROFILES, signals: NO_ESCALATION, now: NOW };

function model(baseModel: ModelEntry, overrides: Partial<ModelEntry>): ModelEntry {
  return { ...baseModel, ...overrides };
}

const opus = MODELS.find((entry) => entry.id === "claude-opus-5")!;

/** A Devin-subscription row on its own lane, shaped like the live `devin/swe-2` rows. */
function devinModel(id = "devin/swe-2"): ModelEntry {
  return model(opus, { id, laneId: "lane-devin", releasedAt: "2026-09-01" });
}

function paidModel(id: string, laneId = "lane-paid"): ModelEntry {
  return model(opus, { id, laneId, releasedAt: "2026-01-01" });
}

type TierKey = "T1" | "T2" | "T3";

function tierScore(overrides: Partial<ModelScore["tiers"]["T1"]> = {}): ModelScore["tiers"]["T1"] {
  return {
    n: 0,
    ok: 0,
    failInfra: 0,
    failModel: 0,
    tmo: 0,
    nEff: 0,
    pObs: null,
    p: 0.8,
    capable: null,
    proven: false,
    costPerSuccessUsd: null,
    medMin: null,
    rework: 0,
    ...overrides,
  };
}

function score(
  modelId: string,
  tiers: Partial<Record<TierKey, Partial<ModelScore["tiers"]["T1"]>>>,
): ModelScore {
  return {
    modelId,
    aaIndex: null,
    priorP: 0.8,
    tiers: {
      T1: tierScore(tiers.T1),
      T2: tierScore(tiers.T2),
      T3: tierScore(tiers.T3),
    },
    overall: tierScore(),
  };
}

function candidate(modelId: string, expectedCostUsd: number): Candidate {
  return {
    modelId,
    tier: "T1",
    releasedAt: "2026-01-01",
    fallbackOnly: false,
    runCostUsd: expectedCostUsd,
    inputCostUsd: expectedCostUsd,
    cacheReadCostUsd: 0,
    outputCostUsd: 0,
    escalationRiskUsd: 0,
    expectedCostUsd,
    profileTier: "T1",
    profileTrusted: true,
  };
}

/** A $0/MTok T1 row on a serviceable free lane, unjudged by default. */
function freeModel(id: string): ModelEntry {
  return model(opus, {
    id,
    laneId: "lane-free",
    costPerMTokIn: 0,
    costPerMTokOut: 0,
    costPerMTokCacheRead: 0,
    releasedAt: "2026-09-01",
  });
}

function freeVerdict(laneId: string): LanePaceVerdict {
  return {
    laneId,
    observedAt: "2026-09-10T11:00:00.000Z",
    state: "free",
    serviceable: true,
    score: null,
    accounts: [],
    knownAccountCount: 0,
    knownWeight: 0,
    serviceableAccountCount: 0,
    urgentResetAt: null,
    reason: "free-lane",
  };
}

function ledgerWith(verdicts: LanePaceVerdict[]): LaneLedger {
  const ledger: LaneLedger = {};
  for (const verdict of verdicts) {
    ledger[verdict.laneId] = {
      laneId: verdict.laneId,
      verdict,
      fetchedAt: NOW.toString(),
      error: null,
      observation: null,
    };
  }
  return ledger;
}

describe("Defect 1: devin/* is ineligible on claude_local", () => {
  it("identifies Devin rows by prefix only, never by suffix", () => {
    expect(isDevinModelId("devin/swe-2")).toBe(true);
    expect(isDevinModelId("devin/gpt-6-astra")).toBe(true);
    expect(isDevinModelId("claude-opus-5")).toBe(false);
    expect(isDevinModelId("swe-2-devin")).toBe(false);
    expect(isDevinModelId(null)).toBe(false);
    expect(isDevinModelId(undefined)).toBe(false);
  });

  it("blocks only the devin x claude_local pair", () => {
    expect(isAdapterBlockedModel("devin/swe-2", "claude_local")).toBe(true);
    // Devin works via opencode/codex adapters — only this pair is excluded.
    expect(isAdapterBlockedModel("devin/swe-2", "codex_local")).toBe(false);
    expect(isAdapterBlockedModel("devin/swe-2", "opencode_local")).toBe(false);
    expect(isAdapterBlockedModel("claude-opus-5", "claude_local")).toBe(false);
    // An unknown adapter never excludes.
    expect(isAdapterBlockedModel("devin/swe-2", null)).toBe(false);
    expect(isAdapterBlockedModel("devin/swe-2", undefined)).toBe(false);
  });

  it("rejects the devin candidate with an adapter-stage rejection naming claude_local", () => {
    const decision = selectModel({
      ...base,
      descriptor: {
        issueId: "adapter-gate",
        labelNames: ["tier:T1"],
        agentAdapterType: "claude_local",
      },
      config: config({ models: [devinModel(), paidModel("opus-paid")] }),
    });
    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe("opus-paid");
    const adapterRejections = decision.rejections.filter((r) => r.stage === "adapter");
    expect(adapterRejections.map((r) => r.modelId)).toEqual(["devin/swe-2"]);
    expect(adapterRejections[0]!.reason).toContain("claude_local");
    expect(decision.trace.some((line) => line.includes("devin/swe-2") && line.includes("[adapter]"))).toBe(true);
  });

  it("declines a sticky devin incumbent on claude_local instead of wedging the issue", () => {
    const decision = selectModel({
      ...base,
      descriptor: {
        issueId: "adapter-sticky",
        labelNames: ["tier:T1"],
        agentAdapterType: "claude_local",
        stickyModelId: "devin/swe-2",
        pinnedModelId: "devin/swe-2",
      },
      config: config({ models: [devinModel(), paidModel("opus-paid")] }),
    });
    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe("opus-paid");
    expect(
      decision.rejections.some((r) => r.stage === "adapter" && r.modelId === "devin/swe-2"),
    ).toBe(true);
    expect(decision.trace.some((line) => line.includes("sticky devin/swe-2 declined"))).toBe(true);
  });

  it("admits devin for a codex assignee and for an unknown adapter", () => {
    for (const agentAdapterType of ["codex_local", null, undefined]) {
      const decision = selectModel({
        ...base,
        descriptor: {
          issueId: "adapter-allow",
          labelNames: ["tier:T1"],
          agentAdapterType,
        },
        config: config({ models: [devinModel(), paidModel("opus-paid")] }),
      });
      expect(
        decision.rejections.some((r) => r.stage === "adapter"),
        `adapter ${String(agentAdapterType)}`,
      ).toBe(false);
    }
  });

  it("never writes a devin value to the ancillary sub-call surfaces for a claude_local assignee", () => {
    const blocked = modelOverrideForContext({
      model: { id: "devin/swe-2", contextWindow: 400_000 },
      agentEnvContextTokens: 1_000_000,
      compactionRatio: 0.75,
      agentAdapterType: "claude_local",
      agentEnv: {},
    });
    const env = blocked.assigneeAdapterOverrides.adapterConfig.env ?? {};
    for (const key of ANCILLARY_MODEL_ENV_KEYS) {
      expect(env[key], key).not.toEqual({ type: "plain", value: "devin/swe-2" });
    }
    // The main-model pin still lands — only the side door is shut.
    expect(blocked.assigneeAdapterOverrides.adapterConfig.model).toBe("devin/swe-2");
  });

  it("still writes the ancillary surfaces for a codex assignee and an unknown adapter", () => {
    for (const agentAdapterType of ["codex_local", null, undefined] as const) {
      const patch = modelOverrideForContext({
        model: { id: "devin/swe-2", contextWindow: 400_000 },
        agentEnvContextTokens: 1_000_000,
        compactionRatio: 0.75,
        agentAdapterType,
        agentEnv: {},
      });
      const env = patch.assigneeAdapterOverrides.adapterConfig.env ?? {};
      for (const key of ANCILLARY_MODEL_ENV_KEYS) {
        expect(env[key], `${key} @ ${String(agentAdapterType)}`).toEqual({
          type: "plain",
          value: "devin/swe-2",
        });
      }
    }
  });
});

describe("Defect 2: earn-in never fires on protected cards", () => {
  const models: ModelEntry[] = [freeModel("meta-free"), paidModel("opus-paid")];
  const candidates = [candidate("opus-paid", 2), candidate("meta-free", 0)];
  const unjudged: Record<string, ModelScore> = {
    "meta-free": score("meta-free", { T1: { proven: false, capable: null, n: 2 } }),
    "opus-paid": score("opus-paid", { T1: { proven: true, capable: true, n: 416 } }),
  };

  it("protects critical/high/urgent priorities, not medium/low or unknown", () => {
    for (const priority of ["critical", "high", "urgent", "Critical", " HIGH "]) {
      expect(earnInGuardFor({ priority, title: "A card" }).protected, priority).toBe(true);
    }
    for (const priority of ["medium", "low", "", null, undefined]) {
      expect(
        earnInGuardFor({ priority, title: "A card" }).protected,
        String(priority),
      ).toBe(false);
    }
    expect(earnInGuardFor(null).protected).toBe(false);
    expect(earnInGuardFor(undefined).protected).toBe(false);
  });

  it("protects review/gate cards by title word, not by substring", () => {
    for (const title of [
      "Review the router fix",
      "GATE: approve the release",
      "Final review gating EX-1234",
    ]) {
      expect(earnInGuardFor({ priority: "low", title }).protected, title).toBe(true);
    }
    // "aggregate" carries "gate" as a substring of an unrelated word.
    expect(earnInGuardFor({ priority: "low", title: "Aggregate the lane stats" }).protected).toBe(false);
  });

  it("returns no picks and no winner for a protected card", () => {
    const ledger = ledgerWith([freeVerdict("lane-free")]);
    const descriptor = { priority: "critical", title: "Review the release" };
    expect(freeEarnInCandidates(candidates, models, ledger, unjudged, "T1", descriptor)).toEqual([]);
    expect(freeEarnInWinner(candidates, models, ledger, unjudged, "T1", descriptor)).toBeNull();
  });

  it("still earns in on an ordinary card", () => {
    const ledger = ledgerWith([freeVerdict("lane-free")]);
    const descriptor = { priority: "low", title: "A card" };
    expect(
      freeEarnInWinner(candidates, models, ledger, unjudged, "T1", descriptor)?.candidate.modelId,
    ).toBe("meta-free");
  });

  it("says the skip in the trace on a protected card", () => {
    const decision = selectModel({
      ...base,
      descriptor: {
        issueId: "earn-in-guarded",
        labelNames: ["tier:T1"],
        priority: "critical",
        title: "Review the release",
      },
      config: config({
        models,
        laneLedger: ledgerWith([freeVerdict("lane-free")]),
        modelScores: unjudged,
      }),
    });
    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe("opus-paid");
    expect(decision.trace.some((line) => line.includes("free-lane earn-in skipped"))).toBe(true);
    expect(decision.trace.some((line) => line.includes("free-lane earn-in: routing to unproven"))).toBe(
      false,
    );
  });
});

describe("Adapter x earn-in: earn-in never promotes a gated-out model", () => {
  it("a devin row that the adapter gate rejected cannot win earn-in on claude_local", () => {
    // A devin subscription row on a serviceable free lane is exactly the shape
    // the free-lane reorder promotes — unless the adapter gate removed it
    // upstream. `selectModel` is the integration point: the gate loop runs
    // before the reorder, so the reorder only ever sees survivors.
    const devinFree = model(opus, {
      id: "devin/swe-2",
      laneId: "lane-free",
      costPerMTokIn: 0,
      costPerMTokOut: 0,
      costPerMTokCacheRead: 0,
      releasedAt: "2026-09-01",
    });
    const decision = selectModel({
      ...base,
      descriptor: {
        issueId: "adapter-earn-in",
        labelNames: ["tier:T1"],
        agentAdapterType: "claude_local",
        priority: "low",
        title: "A card",
      },
      config: config({
        models: [devinFree, paidModel("opus-paid")],
        laneLedger: ledgerWith([freeVerdict("lane-free")]),
        modelScores: {
          "devin/swe-2": score("devin/swe-2", { T1: { proven: false, capable: null, n: 0 } }),
          "opus-paid": score("opus-paid", { T1: { proven: true, capable: true, n: 416 } }),
        },
      }),
    });
    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe("opus-paid");
    expect(
      decision.rejections.some((r) => r.stage === "adapter" && r.modelId === "devin/swe-2"),
    ).toBe(true);
    expect(decision.trace.some((line) => line.includes("free-lane earn-in: routing to unproven devin"))).toBe(
      false,
    );
  });
});

describe("Defect 3: the lane-capacity collector runs inside the freshness window", () => {
  it("schedules pollLanes at 2 minutes, inside the tightest live freshness budget (180s)", () => {
    // The operator measured live publishers declaring stale_after_seconds=180
    // while the collector ran every 300s, so picks older than 180s read every
    // lane UNKNOWN ~half the time. This pins the collector cadence that closes
    // that gap: a 120s interval keeps every pick inside the 180s budget with
    // margin for poll latency and jitter.
    const poll = (manifest.jobs ?? []).find((job) => job.jobKey === JOB_KEYS.pollLanes);
    expect(poll).toBeDefined();
    expect(poll!.schedule).toBe("*/2 * * * *");
  });

  it("a pick 4 minutes after the last poll reads UNKNOWN under the live 180s budget", () => {
    // The negative half of the pair: this is the shape the 5-minute cadence
    // produced ~half the time — a document that is healthy but older than the
    // publisher's declared budget. It must read UNKNOWN (said, not silent),
    // never available.
    const records = [
      account("claude", "claude-a", { stale_after_seconds: 180 }),
      account("claude", "claude-b", { stale_after_seconds: 180 }),
      account("zai", "zai-a", { stale_after_seconds: 180 }),
      account("zai", "zai-b", { stale_after_seconds: 180 }),
    ];
    const stale = normalizeAvailability(
      laneDoc(records, new Date(NOW - 4 * 60_000).toISOString()),
      NOW,
    );
    expect(stale.lanes.every((lane) => lane.state === "unknown")).toBe(true);
    expect(stale.lanes[0]?.term).toBe("staleness");
  });

  it("a pick inside the 2-minute cadence reads the same document as available", () => {
    // The positive control: the same publishers, the same budgets, observed
    // 119s after the poll — the oldest a pick can ever be under the new
    // schedule plus jitter. Healthy lanes must read available, and the
    // decision must land without an UNKNOWN flag.
    const records = [
      account("claude", "claude-a", { stale_after_seconds: 180 }),
      account("claude", "claude-b", { stale_after_seconds: 180 }),
      account("zai", "zai-a", { stale_after_seconds: 180 }),
      account("zai", "zai-b", { stale_after_seconds: 180 }),
    ];
    const fresh = normalizeAvailability(
      laneDoc(records, new Date(NOW - 119_000).toISOString()),
      NOW,
    );
    expect(fresh.lanes.map((lane) => lane.state)).toEqual(["available", "available"]);
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "stale-cadence", labelNames: ["tier:T3"] },
      config: config({ models: LANED_MODELS }),
      availability: fresh,
    });
    expect(decision.outcome).toBe("selected");
    expect(decision.availability.selectedOnUnknownLane).toBe(false);
  });
});
