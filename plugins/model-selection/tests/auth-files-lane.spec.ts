import { describe, expect, it } from "vitest";

import { authFilesToLaneDocument } from "../src/lane-capacity/auth-files.js";
import { pollLanes, type LanePollHttpClient, type LaneSourceDefinition } from "../src/lane-capacity/poll.js";
import { evaluateLanePace, normalizeLaneDocument } from "../src/lane-capacity/pace.js";
import type { LanePaceDefinition } from "../src/lane-capacity/pace.js";

const NOW = Date.parse("2026-10-04T21:55:00Z");
const epoch = (iso: string): string => String(Date.parse(iso) / 1000);

function claudeAuth(index: string, five: string, week: string, extra: Record<string, unknown> = {}) {
  return {
    provider: "claude",
    auth_index: index,
    account: "someone@example.com",
    status: "active",
    disabled: false,
    quota: {
      observed_at: "2026-10-04T21:53:27.515177726Z",
      signals: {
        "Anthropic-Ratelimit-Unified-5h-Utilization": five,
        "Anthropic-Ratelimit-Unified-5h-Reset": epoch("2026-10-05T00:10:00Z"),
        "Anthropic-Ratelimit-Unified-7d-Utilization": week,
        "Anthropic-Ratelimit-Unified-7d-Reset": epoch("2026-10-09T19:00:00Z"),
        "Anthropic-Ratelimit-Unified-Status": "allowed",
      },
    },
    ...extra,
  };
}

function codexAuth(index: string, usedPercent: string, extra: Record<string, unknown> = {}) {
  return {
    provider: "codex",
    auth_index: index,
    status: "active",
    quota: {
      observed_at: "2026-10-04T21:53:38Z",
      signals: {
        "X-Codex-Plan-Type": "pro",
        "X-Codex-Primary-Used-Percent": usedPercent,
        "X-Codex-Primary-Window-Minutes": "10080",
        "X-Codex-Primary-Reset-At": epoch("2026-10-09T21:13:00Z"),
        "X-Codex-Secondary-Used-Percent": "0",
        "X-Codex-Secondary-Window-Minutes": "0",
      },
    },
    ...extra,
  };
}

describe("authFilesToLaneDocument", () => {
  it("maps Claude 5h/7d signals to the lane document fields, ordered by auth_index", () => {
    const doc = authFilesToLaneDocument({ files: [claudeAuth("bbb", "0.92", "0.66"), claudeAuth("aaa", "0.46", "0.62")] }, "claude", NOW);
    expect(doc.records.map((r) => r.account_key)).toEqual(["aaa", "bbb"]);
    expect(doc.records[0]).toMatchObject({
      lane: "claude-lane-1",
      five_hour_utilization: 0.46,
      seven_day_utilization: 0.62,
      seven_day_resets_at: "2026-10-09T19:00:00.000Z",
      governing_window: "seven_day",
      health: "healthy",
      observationQuality: "cliproxy-passive",
    });
    expect(JSON.stringify(doc)).not.toContain("someone@example.com");
  });

  it("maps a Codex 10080-minute primary window to weekly and marks a full window exhausted", () => {
    const doc = authFilesToLaneDocument({ files: [codexAuth("c1", "83"), codexAuth("c2", "100")] }, "codex", NOW);
    expect(doc.records[0]).toMatchObject({ weekly_utilization: 0.83, plan: "pro", health: "healthy" });
    expect(doc.records[0]).not.toHaveProperty("five_hour_utilization");
    expect(doc.records[1]).toMatchObject({ weekly_utilization: 1, health: "exhausted" });
  });

  it("treats a window whose reset has passed as empty instead of reusing the stale value", () => {
    const auth = claudeAuth("aaa", "1", "0.62");
    (auth.quota.signals as Record<string, string>)["Anthropic-Ratelimit-Unified-5h-Reset"] = epoch("2026-10-04T20:00:00Z");
    const [record] = authFilesToLaneDocument({ files: [auth] }, "claude", NOW).records;
    expect(record).toMatchObject({ five_hour_utilization: 0, five_hour_resets_at: null, seven_day_utilization: 0.62 });
  });

  it("omits disabled credentials and other providers, and never fabricates utilization", () => {
    const doc = authFilesToLaneDocument(
      {
        files: [
          claudeAuth("aaa", "0.1", "0.1", { disabled: true }),
          codexAuth("c1", "50"),
          { provider: "claude", auth_index: "zzz", status: "error", status_message: "usage limit reached", unavailable: true },
        ],
      },
      "claude",
      NOW,
    );
    expect(doc.records).toHaveLength(1);
    expect(doc.records[0]).toMatchObject({ account_key: "zzz", health: "exhausted", observationQuality: "absent" });
    expect(doc.records[0]).not.toHaveProperty("seven_day_utilization");
  });

  it("returns an empty record list for a malformed response", () => {
    expect(authFilesToLaneDocument(null, "claude", NOW).records).toEqual([]);
    expect(authFilesToLaneDocument({ files: "nope" }, "codex", NOW).records).toEqual([]);
  });
});

describe("pollLanes with a cliproxy-auth-files source", () => {
  const lane: LanePaceDefinition = {
    laneId: "cliproxy-claude",
    healthFields: ["health"],
    windows: [
      { name: "five-hour", role: "serviceability", utilizationFields: ["five_hour_utilization"], resetFields: ["five_hour_resets_at"], defaultWindowSeconds: null },
      { name: "seven_day", role: "allowance", utilizationFields: ["seven_day_utilization"], resetFields: ["seven_day_resets_at"], defaultWindowSeconds: 604800 },
    ],
  };

  it("sends the management key as a bearer token and evaluates the converted document", async () => {
    const seen: Record<string, string>[] = [];
    const http: LanePollHttpClient = {
      async fetch(_url, init) {
        seen.push(init.headers);
        return {
          status: 200,
          headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
          redirected: false,
          text: async () => JSON.stringify({ files: [claudeAuth("aaa", "0.46", "0.62"), claudeAuth("bbb", "0.92", "0.66")] }),
        };
      },
    };
    const source: LaneSourceDefinition = {
      laneId: "cliproxy-claude",
      statusUrl: "https://cliproxy-admin.example.net/v0/management/auth-files",
      requestTimeoutMs: 1000,
      maxResponseBytes: 262144,
      lane,
      apiKey: "mgmt-key",
      authFilesProvider: "claude",
    };
    const [result] = await pollLanes({ sources: [source], http, now: () => new Date(NOW).toISOString() });
    if (!result) throw new Error("no poll result");
    expect(seen[0]).toMatchObject({ Authorization: "Bearer mgmt-key" });
    expect(seen[0]).not.toHaveProperty("X-Api-Key");
    expect(result.error).toBeNull();
    expect(result.verdict).not.toBeNull();
    expect(result.rawRecords).toHaveLength(2);
  });

  it("keeps the X-Api-Key header for an ordinary lane document source", async () => {
    const seen: Record<string, string>[] = [];
    const http: LanePollHttpClient = {
      async fetch(_url, init) {
        seen.push(init.headers);
        return {
          status: 200,
          headers: { get: () => "application/json" },
          redirected: false,
          text: async () => JSON.stringify({ records: [] }),
        };
      },
    };
    await pollLanes({
      sources: [{ laneId: "x", statusUrl: "https://status.example.com/x", requestTimeoutMs: 1000, maxResponseBytes: 65536, lane, apiKey: "k" }],
      http,
      now: () => new Date(NOW).toISOString(),
    });
    expect(seen[0]).toMatchObject({ "X-Api-Key": "k" });
    expect(seen[0]).not.toHaveProperty("Authorization");
  });
});

describe("auth-files routing weight is scheduler state, not pace weight", () => {
  const weeklyLane: LanePaceDefinition = {
    laneId: "cliproxy-claude",
    healthFields: ["health"],
    windows: [
      { name: "seven_day", role: "allowance", utilizationFields: ["seven_day_utilization"], resetFields: ["seven_day_resets_at"], defaultWindowSeconds: 604800 },
    ],
  };

  function evaluateWeekly(response: unknown, planWeights?: Record<string, number>) {
    const observedAt = new Date(NOW).toISOString();
    return evaluateLanePace({
      observation: normalizeLaneDocument({
        document: authFilesToLaneDocument(response, "claude", NOW, planWeights),
        definition: weeklyLane,
      }),
      asOf: observedAt,
    });
  }

  it("omits a routing-weight-0 credential so one parked account cannot poison the lane", () => {
    const response = {
      files: [
        claudeAuth("aaa", "0.46", "0.62"),
        { ...claudeAuth("zzz", "0.10", "0.20"), weight: 0 },
      ],
    };
    const doc = authFilesToLaneDocument(response, "claude", NOW, { aaa: 20 });
    expect(doc.records).toHaveLength(1);
    expect(doc.records[0]).toMatchObject({ account_key: "aaa", plan_weight: 20 });
    const result = evaluateWeekly(response, { aaa: 20 });
    expect(result.state).not.toBe("unknown");
  });

  it("never emits the routing weight as the pace weight", () => {
    const doc = authFilesToLaneDocument(
      { files: [{ ...claudeAuth("aaa", "0.46", "0.62"), weight: 7 }] },
      "claude",
      NOW,
      { aaa: 20 },
    );
    expect(doc.records[0]).toMatchObject({ plan_weight: 20 });
    expect(doc.records[0]).not.toHaveProperty("weight");
    const unmapped = authFilesToLaneDocument({ files: [claudeAuth("aaa", "0.46", "0.62")] }, "claude", NOW);
    expect(unmapped.records[0]).not.toHaveProperty("weight");
    expect(unmapped.records[0]).not.toHaveProperty("plan_weight");
  });

  it("weights mixed plans by lane-config plan weight (0.26, not 0.50)", () => {
    const response = {
      files: [claudeAuth("max-20x", "0.10", "0.10"), claudeAuth("max-5x", "0.90", "0.90")],
    };
    const result = evaluateWeekly(response, { "max-20x": 20, "max-5x": 5 });
    expect(result.score?.utilization).toBe(0.26);
    expect(result.knownWeight).toBe(25);
  });
});
