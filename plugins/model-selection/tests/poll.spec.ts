import { describe, expect, it } from "vitest";

import { pollLanes, type LanePollHttpClient, type LaneSourceDefinition } from "../src/lane-capacity/poll.js";
import type { LanePaceDefinition } from "../src/lane-capacity/pace.js";

function lane(overrides: Partial<LanePaceDefinition> = {}): LanePaceDefinition {
  return {
    laneId: "lane-a",
    healthFields: ["health"],
    windows: [
      {
        name: "primary",
        role: "serviceability",
        utilizationFields: ["utilization"],
        resetFields: ["resetsAt"],
        defaultWindowSeconds: 3600,
      },
    ],
    ...overrides,
  };
}

function source(overrides: Partial<LaneSourceDefinition> = {}): LaneSourceDefinition {
  return {
    laneId: "lane-a",
    statusUrl: "https://status.example.com/lane-a",
    requestTimeoutMs: 1000,
    maxResponseBytes: 65536,
    lane: lane(),
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Awaited<ReturnType<LanePollHttpClient["fetch"]>> {
  return {
    status,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
    redirected: false,
    text: async () => JSON.stringify(body),
  };
}

describe("pollLanes", () => {
  it("never lets one lane's failure abort another lane's result", async () => {
    // Named mutant: "one 404 aborts all". Two lanes are polled together; one
    // 404s, the other succeeds. Both results must come back — the failing
    // lane records an error, the healthy lane keeps its verdict.
    const sources: LaneSourceDefinition[] = [
      source({ laneId: "lane-bad", statusUrl: "https://status.example.com/lane-bad" }),
      source({ laneId: "lane-good", statusUrl: "https://status.example.com/lane-good", lane: lane({ laneId: "lane-good" }) }),
    ];
    const http: LanePollHttpClient = {
      fetch: async (url) => {
        if (url.includes("lane-bad")) return jsonResponse(404, { error: "not found" });
        return jsonResponse(200, { observedAt: "2026-09-12T00:00:00.000Z", records: [{ health: "ok", utilization: 0.1, resetsAt: "2026-09-12T01:00:00.000Z" }] });
      },
    };
    const results = await pollLanes({ sources, http, now: () => "2026-09-12T00:00:00.000Z" });
    expect(results).toHaveLength(2);
    const bad = results.find((r) => r.laneId === "lane-bad")!;
    const good = results.find((r) => r.laneId === "lane-good")!;
    expect(bad.error).toBe("lane-http-failed");
    expect(bad.verdict).toBeNull();
    expect(good.error).toBeNull();
  });

  it("returns explicit unknown verdicts for semantic identity and weight gaps", async () => {
    const cases = [
      {
        source: source({ lane: lane({ accountKeyFields: ["account_key"] }) }),
        record: { health: "ok", utilization: 0.1, resetsAt: "2026-09-12T01:00:00.000Z" },
        reason: "invalid-account-identity",
      },
      {
        source: source({
          lane: lane({
            accountKeyFields: ["account_key"],
            weightFields: ["plan_weight"],
            windows: [{
              name: "primary",
              role: "allowance",
              utilizationFields: ["utilization"],
              resetFields: ["resetsAt"],
              defaultWindowSeconds: 3600,
            }],
          }),
        }),
        record: { account_key: "account-a", health: "ok", utilization: 0.1, resetsAt: "2026-09-12T01:00:00.000Z" },
        reason: "indeterminate-account-weight",
      },
    ];

    for (const testCase of cases) {
      const http: LanePollHttpClient = {
        fetch: async () => jsonResponse(200, {
          observedAt: "2026-09-12T00:00:00.000Z",
          records: [testCase.record],
        }),
      };
      const [result] = await pollLanes({
        sources: [testCase.source],
        http,
        now: () => "2026-09-12T00:00:00.000Z",
      });

      expect(result!.error).toBeNull();
      expect(result!.verdict).toMatchObject({
        state: "unknown",
        serviceable: null,
        score: null,
        reason: testCase.reason,
      });
    }
  });

  it("survives a lane whose fetch throws outright, without dropping other lanes", async () => {
    // Belt-and-braces on top of pollOne's own guard chain: even if the http
    // client itself throws synchronously/rejects unexpectedly (not just a
    // non-2xx status), pollLanes must not let that reject the whole batch.
    const sources: LaneSourceDefinition[] = [
      source({ laneId: "lane-throws", statusUrl: "https://status.example.com/lane-throws" }),
      source({ laneId: "lane-good", statusUrl: "https://status.example.com/lane-good", lane: lane({ laneId: "lane-good" }) }),
    ];
    const http: LanePollHttpClient = {
      fetch: async (url) => {
        if (url.includes("lane-throws")) throw new Error("socket hang up");
        return jsonResponse(200, { observedAt: "2026-09-12T00:00:00.000Z", records: [{ health: "ok", utilization: 0.1, resetsAt: "2026-09-12T01:00:00.000Z" }] });
      },
    };
    const results = await pollLanes({ sources, http, now: () => "2026-09-12T00:00:00.000Z" });
    expect(results).toHaveLength(2);
    const bad = results.find((r) => r.laneId === "lane-throws")!;
    const good = results.find((r) => r.laneId === "lane-good")!;
    expect(bad.error).toBeTruthy();
    expect(bad.verdict).toBeNull();
    expect(good.error).toBeNull();
  });

  it("sends the resolved apiKey as an X-Api-Key header when present", async () => {
    let seenHeaders: Record<string, string> | null = null;
    const sources: LaneSourceDefinition[] = [source({ apiKey: "secret-value-123" })];
    const http: LanePollHttpClient = {
      fetch: async (_url, init) => {
        seenHeaders = init.headers;
        return jsonResponse(200, { observedAt: "2026-09-12T00:00:00.000Z", records: [{ health: "ok", utilization: 0.1, resetsAt: "2026-09-12T01:00:00.000Z" }] });
      },
    };
    const results = await pollLanes({ sources, http, now: () => "2026-09-12T00:00:00.000Z" });
    expect(results[0]!.error).toBeNull();
    expect(seenHeaders).toMatchObject({ "X-Api-Key": "secret-value-123" });
  });

  it("omits the X-Api-Key header entirely when no apiKey is resolved", async () => {
    let seenHeaders: Record<string, string> | null = null;
    const sources: LaneSourceDefinition[] = [source({ apiKey: null })];
    const http: LanePollHttpClient = {
      fetch: async (_url, init) => {
        seenHeaders = init.headers;
        return jsonResponse(200, { observedAt: "2026-09-12T00:00:00.000Z", records: [{ health: "ok", utilization: 0.1, resetsAt: "2026-09-12T01:00:00.000Z" }] });
      },
    };
    await pollLanes({ sources, http, now: () => "2026-09-12T00:00:00.000Z" });
    expect(seenHeaders).not.toHaveProperty("X-Api-Key");
  });

  it("rejects a reserved-literal-host status URL rather than polling it", async () => {
    const sources: LaneSourceDefinition[] = [source({ statusUrl: "https://127.0.0.1/lane-a" })];
    const http: LanePollHttpClient = {
      fetch: async () => jsonResponse(200, { observedAt: "2026-09-12T00:00:00.000Z", records: [{ health: "ok", utilization: 0.1, resetsAt: "2026-09-12T01:00:00.000Z" }] }),
    };
    const results = await pollLanes({ sources, http, now: () => "2026-09-12T00:00:00.000Z" });
    expect(results[0]!.error).toBe("lane-url-rejected");
  });
});
