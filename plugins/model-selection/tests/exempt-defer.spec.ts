import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveConfig } from "../src/config/resolve.js";
import {
  resolveRunDecision,
  type ResolveRunModelParams,
  type RunResolveInput,
  type RunResolveSnapshot,
} from "../src/engine/run-resolve.js";
import { LANED_MODELS, NOW, NO_ESCALATION, PROFILES, account, laneDoc } from "./fixtures.js";
import type { LaneOutageOverride } from "../src/engine/pacing.js";
import { stoppedLane, type LaneLedger } from "./run-resolve-helpers.js";

/**
 * An exempt agent is never repinned, so when its own configured model is known
 * unserviceable the run-scoped hook defers instead of keeping (which would
 * start the run into a 429). Every deferring case is paired with a healthy
 * control and a non-exempt control, so "defer" cannot be a vacuous pass.
 *
 * Roster (`LANED_MODELS`): haiku (T3) alone on lane `zai`; sonnet and opus on
 * `claude`. The exempt agent's configured model is haiku.
 */

const REVIEWER = "11111111-2222-4333-8444-555555555555";
const ENGINEER = "agent-1";
const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-5";
const MINUTE = 60_000;
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function fleet(zaiOverrides: Record<string, unknown> = {}) {
  return laneDoc([
    ...["claude-a", "claude-b"].map((key) => account("claude", key)),
    ...["zai-a", "zai-b"].map((key) => account("zai", key, zaiOverrides)),
  ]);
}

function input(
  agentId: string,
  options: { availabilityRaw?: unknown; ledger?: LaneLedger; exempt?: readonly string[]; defaultModel?: string; issueOverrideModel?: string | null; pacingMode?: string; laneOutageOverride?: LaneOutageOverride | null } = {},
): RunResolveInput {
  const snapshot: RunResolveSnapshot = {
    config: resolveConfig({
      selection: { enabled: true, mode: "enforce", holdOnUntrustedProfile: true, exemptAgentIds: options.exempt ?? [REVIEWER] },
      models: LANED_MODELS as unknown as Record<string, unknown>[],
      runResolve: { enabled: true },
      ...(options.pacingMode ? { pacing: { mode: options.pacingMode } } : {}),
    }),
    profiles: PROFILES,
    signals: NO_ESCALATION,
    laneLedger: options.ledger ?? {},
    operatorOverrides: {},
    cardLedger: {},
    modelScores: {},
    laneOutageOverride: options.laneOutageOverride ?? null,
    zaiPaceOverride: null,
    pinsWeightByLane: {},
    availabilityRaw: options.availabilityRaw ?? null,
    laneEvidence: { lanes: [], windowHours: 24, unreadableReason: null },
    loadedAtMs: NOW,
  };
  const params: ResolveRunModelParams = {
    runId: "run-1",
    companyId: "co-1",
    agentId,
    issueId: "issue-1",
    adapterType: "claude_local",
    invocationSource: "assignment",
    wakeReason: null,
    agentDefaultModel: options.defaultModel ?? HAIKU,
    previous: null,
    issueOverrideModel: options.issueOverrideModel ?? null,
    deadlineMs: 1500,
  };
  return {
    params,
    issue: { labelNames: ["tier:T3"], priority: null, title: "Review a PR", status: "todo" },
    agent: { name: "Reviewer", adapterConfig: {} },
    snapshot,
    prior: null,
    classifiedTier: null,
    lastRunPeakTokens: null,
    now: NOW,
    newDecisionId: () => "decision-fixed",
  };
}

const cooling = () => fleet({ cooldown: { until: at(10 * MINUTE), reason: "rate limit" } });

describe("exempt agent whose configured model is unserviceable: run-scoped hook", () => {
  it("defers on a published cooldown, naming the model, and never decides a replacement", () => {
    const resolution = resolveRunDecision(input(REVIEWER, { availabilityRaw: cooling() }));
    expect(resolution.kind).toBe("defer");
    if (resolution.kind !== "defer") return;
    expect(resolution.reason).toContain(HAIKU);
    expect(resolution.reason).toContain("cooldown");
  });

  it("defers on a pace-engine hard stop for the model's lane", () => {
    const resolution = resolveRunDecision(input(REVIEWER, { ledger: { zai: stoppedLane("zai") } }));
    expect(resolution.kind).toBe("defer");
  });

  it.each(["indeterminate-account-weight", "invalid-configured-governing-window"] as const)(
    "keeps on an indeterminate pace verdict (%s): a blind instrument defers nothing",
    (reason) => {
      const ledger: LaneLedger = {
        zai: {
          ...stoppedLane("zai"),
          verdict: { serviceable: null, state: "unknown", reason } as unknown as LaneLedger["zai"]["verdict"],
        },
      };
      expect(resolveRunDecision(input(REVIEWER, { ledger })).kind).toBe("keep");
    },
  );

  it("keeps when the ledger holds only a stale unserviceableSince with no current reading", () => {
    const ledger: LaneLedger = {
      zai: {
        ...stoppedLane("zai"),
        verdict: null,
        unserviceableSince: at(-5 * MINUTE),
        unserviceableReason: "serviceability-window-exhausted",
        error: "poll failed",
      },
    };
    expect(resolveRunDecision(input(REVIEWER, { ledger })).kind).toBe("keep");
  });

  it("defers on an active lane-outage override for the model's lane", () => {
    const laneOutageOverride: LaneOutageOverride = { lanes: ["zai"], models: [], until: at(10 * MINUTE) };
    const resolution = resolveRunDecision(input(REVIEWER, { laneOutageOverride }));
    expect(resolution.kind).toBe("defer");
  });

  it("keeps once the lane-outage override has expired", () => {
    const laneOutageOverride: LaneOutageOverride = { lanes: ["zai"], models: [], until: at(-MINUTE) };
    expect(resolveRunDecision(input(REVIEWER, { laneOutageOverride })).kind).toBe("keep");
  });

  it("keeps when pacing is off even with a pace-engine hard stop: the pace gate is inert", () => {
    const resolution = resolveRunDecision(input(REVIEWER, { ledger: { zai: stoppedLane("zai") }, pacingMode: "off" }));
    expect(resolution.kind).toBe("keep");
  });

  it("still defers on a published cooldown when pacing is off: availability reads ignore the mode", () => {
    const resolution = resolveRunDecision(input(REVIEWER, { availabilityRaw: cooling(), pacingMode: "off" }));
    expect(resolution.kind).toBe("defer");
  });

  it("keeps when the configured model is healthy (control)", () => {
    const resolution = resolveRunDecision(input(REVIEWER, { availabilityRaw: fleet() }));
    expect(resolution.kind).toBe("keep");
  });

  it("keeps once the cooldown has expired (control)", () => {
    const expired = fleet({ cooldown: { until: at(-MINUTE), reason: "expired" } });
    expect(resolveRunDecision(input(REVIEWER, { availabilityRaw: expired })).kind).toBe("keep");
  });

  it("keeps when another lane, not the configured model's, is cooling (control)", () => {
    const otherLane = laneDoc([
      ...["claude-a", "claude-b"].map((key) => account("claude", key, { cooldown: { until: at(10 * MINUTE), reason: "rate limit" } })),
      ...["zai-a", "zai-b"].map((key) => account("zai", key)),
    ]);
    expect(resolveRunDecision(input(REVIEWER, { availabilityRaw: otherLane })).kind).toBe("keep");
  });

  it("keeps when nothing is published: an unreadable instrument is not a cooldown", () => {
    expect(resolveRunDecision(input(REVIEWER, { availabilityRaw: null })).kind).toBe("keep");
  });

  it("keeps when the configured model is not in the roster: nothing to judge", () => {
    const resolution = resolveRunDecision(input(REVIEWER, { availabilityRaw: cooling(), defaultModel: "not-in-roster" }));
    expect(resolution.kind).toBe("keep");
  });

  it("leaves a live issue override authoritative: keep, not defer", () => {
    const resolution = resolveRunDecision(input(REVIEWER, { availabilityRaw: cooling(), issueOverrideModel: HAIKU }));
    expect(resolution.kind).toBe("keep");
  });

  it("does not change a non-exempt agent: same cooling document still decides, off the cooling lane", () => {
    const resolution = resolveRunDecision(input(ENGINEER, { availabilityRaw: cooling() }));
    expect(resolution.kind).toBe("decide");
    if (resolution.kind !== "decide") return;
    expect(resolution.result.model).toBe(SONNET);
  });

  it("does not exempt anyone when the list is empty: the cooling document decides", () => {
    const resolution = resolveRunDecision(input(REVIEWER, { availabilityRaw: cooling(), exempt: [] }));
    expect(resolution.kind).toBe("decide");
  });
});
