/**
 * Worker-level tests driven through the SDK's own in-memory host harness
 * (router/model-selection precedent), so the plugin is exercised over the
 * real context surface (config, state, tools, jobs) rather than hand-written
 * doubles. `ctx.http.fetch` in the harness calls the real global `fetch`, so
 * these tests stub `globalThis.fetch` directly (vi.stubGlobal) rather than
 * mocking the SDK.
 *
 * The fixtures are shaped from the lane the operator measured on 2026-09-05
 * (TOG-811 comment, 02:50Z): providers `claude`, `codex`, `codex-spark`,
 * `kimi`, `opencode-go`, with Kimi 429-exhausted at the time of measurement.
 */

import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import manifest from "../src/manifest.js";
import { JOB_KEYS, LANE_PATHS, ROUTE_KEYS, STATE_KEYS, TOOL_NAMES } from "../src/constants.js";
import {
  cooldownReason,
  createPlugin,
  extractLaneDocument,
  extractProviderRecords,
  isStale,
  laneAccountId,
  laneCooldown,
} from "../src/worker.js";
import { SECRET_REF } from "./helpers.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Per-provider counters, in the shape the lane publishes them. */
function ratesBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    observedAt: new Date().toISOString(),
    providers: {
      claude: { success: 120, failed: 2 },
      codex: { success: 44, failed: 0 },
      "codex-spark": { success: 9, failed: 0 },
      kimi: { success: 0, failed: 31, exhausted: true },
      "opencode-go": { success: 17, failed: 1 },
      ...overrides,
    },
  };
}

function modelUsageBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    staleAfterSeconds: 300,
    telemetry: "available",
    reasonCode: null,
    models: {
      "oc/claude-opus-5": {
        serviceable: true,
        utilization: 0.24,
        state: "available",
        windows: [{ window: "five-hour", utilization: 0.24 }],
      },
      "oc/gpt-5.3-codex": { serviceable: true, utilization: 0.31, state: "available" },
    },
    ...overrides,
  };
}

/**
 * Routes each lane file to its own body, so a test that asserts on one file
 * cannot accidentally be satisfied by the other. `mockImplementation`, not
 * `mockResolvedValue`: a Response body reads once, so a shared instance would
 * silently starve every poll after the first.
 */
function laneFetch(files: { rates?: unknown; models?: unknown; status?: number }) {
  return vi.fn().mockImplementation(async (url: string) => {
    const status = files.status ?? 200;
    if (url.endsWith(LANE_PATHS.requestRates)) {
      return jsonResponse(status, files.rates ?? ratesBody());
    }
    if (url.endsWith(LANE_PATHS.modelUsage)) {
      return jsonResponse(status, files.models ?? modelUsageBody());
    }
    return jsonResponse(404, { error: "not found" });
  });
}

async function harnessFor(config: Record<string, unknown>) {
  const harness = createTestHarness({ manifest, config });
  harness.seed({ companies: [{ id: COMPANY, name: "Co" } as never] });
  const { definition } = createPlugin();
  if (!definition.setup) throw new Error("plugin definition has no setup handler");
  await definition.setup(harness.ctx);
  // Stock loader sends an empty initialize config, then scoped configChanged.
  if (!definition.onConfigChanged) throw new Error("missing company config handler");
  await definition.onConfigChanged(config, { companyId: COMPANY });
  return { harness, plugin: definition };
}

/**
 * The v0.2.0 aggregate-file path. From v0.3.0 it is opt-in and lane polling is
 * the default, so these tests must ask for it explicitly — and turn lane
 * polling off, so a lane fetch cannot satisfy an assertion about the
 * aggregates. The lane path has its own block at the end of this file.
 */
const ENABLED = {
  pollingEnabled: true,
  laneApiKeySecretRef: SECRET_REF,
  legacyAggregateFiles: true,
  laneFiles: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("scheduled poll: disabled/unconfigured paths", () => {
  it("skips every company and writes a heartbeat metric when pollingEnabled is false", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { harness } = await harnessFor({ pollingEnabled: false });

    await harness.runJob(JOB_KEYS.poll);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(harness.metrics.some((m) => m.name === "cliproxy_insight.poll_skipped_disabled")).toBe(true);
    expect(harness.metrics.some((m) => m.name === "cliproxy_insight.poll_ok")).toBe(false);
  });

  it("skips and writes a distinct metric when pollingEnabled is true but no secret is configured", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { harness } = await harnessFor({ pollingEnabled: true, laneApiKeySecretRef: null });

    await harness.runJob(JOB_KEYS.poll);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(harness.metrics.some((m) => m.name === "cliproxy_insight.poll_skipped_no_secret")).toBe(true);
  });
});

describe("lane request shape", () => {
  /**
   * The load-bearing correction in v0.2.0. Caddy gates the lane on
   * `x-api-key`; `Authorization: Bearer` (what v0.1.0 sent) is not read, so
   * every poll would have 401'd against a lane that was working fine.
   */
  it("authenticates with x-api-key, not Authorization", async () => {
    const fetchSpy = laneFetch({});
    vi.stubGlobal("fetch", fetchSpy);
    const { harness } = await harnessFor(ENABLED);

    await harness.runJob(JOB_KEYS.poll);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toMatch(/^resolved:/);
    expect(headers.Authorization).toBeUndefined();
  });

  /**
   * The filenames are a contract with the operator's collector, not an
   * internal detail — they are pinned as literals here on purpose. Every
   * other URL assertion in this file builds its expectation from
   * `LANE_PATHS`, so a rename would move both sides and pass silently.
   * v0.1.0 invented a `/usage-summary` aggregate that never existed.
   */
  it("pins the two lane filenames the operator's collector publishes", () => {
    expect(LANE_PATHS.requestRates).toBe("request-rates.json");
    expect(LANE_PATHS.modelUsage).toBe("model-usage-v1.json");
  });

  it("reads exactly the two lane files, by name, with GET", async () => {
    const fetchSpy = laneFetch({});
    vi.stubGlobal("fetch", fetchSpy);
    const { harness } = await harnessFor(ENABLED);

    await harness.runJob(JOB_KEYS.poll);

    const urls = fetchSpy.mock.calls.map(([url]) => url as string).sort();
    expect(urls).toEqual([
      `https://router.example.net/telemetry/cliproxy/${LANE_PATHS.modelUsage}`,
      `https://router.example.net/telemetry/cliproxy/${LANE_PATHS.requestRates}`,
    ]);
    for (const [, init] of fetchSpy.mock.calls as [string, RequestInit][]) {
      expect(init.method).toBe("GET");
    }
  });

  it("never requests a management route, whatever the payload says", async () => {
    const fetchSpy = laneFetch({});
    vi.stubGlobal("fetch", fetchSpy);
    const { harness } = await harnessFor(ENABLED);

    await harness.runJob(JOB_KEYS.poll);

    for (const [url] of fetchSpy.mock.calls as [string][]) {
      expect(url).not.toContain("/v0/management");
    }
  });

  it("does not double the slash when baseUrl carries a trailing one", async () => {
    const fetchSpy = laneFetch({});
    vi.stubGlobal("fetch", fetchSpy);
    const { harness } = await harnessFor({
      ...ENABLED,
      baseUrl: "https://router.example.net/telemetry/cliproxy/",
    });

    await harness.runJob(JOB_KEYS.poll);

    for (const [url] of fetchSpy.mock.calls as [string][]) {
      expect(url).not.toContain("cliproxy//");
    }
  });
});

describe("scheduled poll: never retry within a firing", () => {
  for (const status of [401, 403, 429]) {
    it(`does not retry when the lane returns ${status}, and records it as a bounded reason code`, async () => {
      const fetchSpy = laneFetch({ status });
      vi.stubGlobal("fetch", fetchSpy);
      const { harness } = await harnessFor(ENABLED);

      await harness.runJob(JOB_KEYS.poll);

      // Two calls: one per lane file, for the one configured company. A
      // poller that bans itself by retrying within a firing is the incident
      // this discipline exists to prevent (TOG-811 recon, measured twice).
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(
        harness.metrics.some(
          (m) => m.name === "cliproxy_insight.poll_errors" && m.tags?.reason === `http_${status}`,
        ),
      ).toBe(true);
      expect(harness.activity.some((a) => a.message.includes("Not retrying within this firing"))).toBe(
        true,
      );
      expect(harness.metrics.some((m) => m.name === "cliproxy_insight.poll_ok")).toBe(false);
    });
  }

  /**
   * A lane that accepts the connection and never answers must not hang the
   * poll. This is a real defect that shipped in v0.2.0 and was invisible here:
   * the worker passed `signal: controller.signal` to `ctx.http.fetch`, and the
   * SDK's *worker bridge* serializes only `method`/`headers`/`body`, so the
   * signal never reaches the request. The mock below deliberately does NOT
   * honour the signal, which is what the real bridge does; before the fix this
   * test times out instead of passing.
   *
   * Found by `deploy/worker_host_harness.mjs`, which drives the built worker as
   * a real child process over the real JSON-RPC protocol.
   */
  it("bounds a lane that accepts the connection and never responds", async () => {
    // Never resolves, never rejects, and ignores AbortSignal entirely.
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => new Promise<Response>(() => {})));
    const { harness } = await harnessFor({ ...ENABLED, requestTimeoutMs: 1000 });

    const startedAt = Date.now();
    await harness.runJob(JOB_KEYS.poll);
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(5000);
    expect(
      harness.metrics.some(
        (m) => m.name === "cliproxy_insight.poll_errors" && m.tags?.reason === "timeout",
      ),
    ).toBe(true);
    // A timed-out poll read nothing, so it must not claim success.
    expect(harness.metrics.some((m) => m.name === "cliproxy_insight.poll_ok")).toBe(false);
  }, 15000);

  it("records a network-error metric without persisting anything", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    const { harness } = await harnessFor(ENABLED);

    await harness.runJob(JOB_KEYS.poll);

    expect(
      harness.metrics.some(
        (m) => m.name === "cliproxy_insight.poll_errors" && m.tags?.reason === "network",
      ),
    ).toBe(true);
    expect(
      harness.getState({
        scopeKind: "company",
        scopeId: COMPANY,
        stateKey: STATE_KEYS.providerIndex,
      }) ?? null,
    ).toBeNull();
  });

  /**
   * The upstream error string is not propagated into state, activity, or
   * metrics: it routinely embeds URLs and connection IDs, and everything
   * here is persisted.
   */
  it("does not leak the upstream error text into activity or metrics", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 10.1.2.3:8317 sk-leaked-abc")),
    );
    const { harness } = await harnessFor(ENABLED);

    await harness.runJob(JOB_KEYS.poll);

    const written = JSON.stringify({ a: harness.activity, m: harness.metrics });
    expect(written).not.toContain("10.1.2.3");
    expect(written).not.toContain("sk-leaked-abc");
  });

  it("one company's failure never aborts the sweep over the rest", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    const { harness } = await harnessFor(ENABLED);
    harness.seed({
      companies: [
        { id: COMPANY, name: "Co" } as never,
        { id: "22222222-2222-4222-8222-222222222222", name: "Co2" } as never,
      ],
    });

    await expect(harness.runJob(JOB_KEYS.poll)).resolves.not.toThrow();
  });

  it("treats a 200 with a non-JSON body as a bounded failure, not as empty data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => new Response("<html>nope</html>", { status: 200 })),
    );
    const { harness } = await harnessFor(ENABLED);

    await harness.runJob(JOB_KEYS.poll);

    expect(
      harness.metrics.some(
        (m) => m.name === "cliproxy_insight.poll_errors" && m.tags?.reason === "malformed_json",
      ),
    ).toBe(true);
    expect(harness.metrics.some((m) => m.name === "cliproxy_insight.poll_ok")).toBe(false);
  });
});

describe("provider discovery comes from the payload", () => {
  /**
   * v0.1.0 filtered the payload through a hardcoded six-provider list
   * (`claude, openai, antigravity, opencode-go, xai, kimi`). The lane
   * actually publishes `codex` and `codex-spark`, which that list does not
   * contain — so both were dropped silently while the poll reported success.
   */
  it("persists every provider the lane publishes, including codex and codex-spark", async () => {
    vi.stubGlobal("fetch", laneFetch({}));
    const { harness } = await harnessFor(ENABLED);

    await harness.runJob(JOB_KEYS.poll);

    const index = harness.getState({
      scopeKind: "company",
      scopeId: COMPANY,
      stateKey: STATE_KEYS.providerIndex,
    }) as string[];
    expect(index).toContain("codex");
    expect(index).toContain("codex-spark");
    expect(index.sort()).toEqual(["claude", "codex", "codex-spark", "kimi", "opencode-go"].sort());
  });

  it("persists a provider whose name nobody anticipated", async () => {
    vi.stubGlobal("fetch", laneFetch({ rates: ratesBody({ "brand-new-lane": { success: 3, failed: 0 } }) }));
    const { harness } = await harnessFor(ENABLED);

    await harness.runJob(JOB_KEYS.poll);

    const record = harness.getState({
      scopeKind: "company",
      scopeId: COMPANY,
      stateKey: STATE_KEYS.provider("brand-new-lane"),
    }) as { success: number };
    expect(record.success).toBe(3);
  });

  it("keeps a provider in the index when one publish omits it", async () => {
    const fetchSpy = vi
      .fn()
      .mockImplementationOnce(async () => jsonResponse(200, ratesBody()))
      .mockImplementationOnce(async () => jsonResponse(200, modelUsageBody()))
      .mockImplementationOnce(async () =>
        jsonResponse(200, { observedAt: new Date().toISOString(), providers: { claude: { success: 1, failed: 0 } } }),
      )
      .mockImplementationOnce(async () => jsonResponse(200, modelUsageBody()));
    vi.stubGlobal("fetch", fetchSpy);
    const { harness } = await harnessFor(ENABLED);

    await harness.runJob(JOB_KEYS.poll);
    await harness.runJob(JOB_KEYS.poll);

    const index = harness.getState({
      scopeKind: "company",
      scopeId: COMPANY,
      stateKey: STATE_KEYS.providerIndex,
    }) as string[];
    // A provider absent from one publish is not evidence it stopped existing.
    expect(index).toContain("kimi");
  });

  it("counts observed providers and models as separate gauges", async () => {
    vi.stubGlobal("fetch", laneFetch({}));
    const { harness } = await harnessFor(ENABLED);

    await harness.runJob(JOB_KEYS.poll);

    expect(harness.metrics.find((m) => m.name === "cliproxy_insight.providers_observed")?.value).toBe(5);
    expect(harness.metrics.find((m) => m.name === "cliproxy_insight.models_observed")?.value).toBe(2);
  });
});

describe("persistence", () => {
  it("persists per-provider counters with the producer's observation time", async () => {
    const observedAt = "2026-09-05T02:50:00.000Z";
    vi.stubGlobal("fetch", laneFetch({ rates: { ...ratesBody(), observedAt } }));
    const { harness } = await harnessFor(ENABLED);

    await harness.runJob(JOB_KEYS.poll);

    const record = harness.getState({
      scopeKind: "company",
      scopeId: COMPANY,
      stateKey: STATE_KEYS.provider("claude"),
    }) as { success: number; failed: number; observedAt: string; schemaVersion: number };

    expect(record.schemaVersion).toBe(1);
    expect(record.success).toBe(120);
    expect(record.failed).toBe(2);
    // The producer's observation time, not our serialization time — a cached
    // snapshot must not be able to misreport its own freshness.
    expect(record.observedAt).toBe(observedAt);
  });

  it("persists the model-usage snapshot when schemaVersion matches", async () => {
    vi.stubGlobal("fetch", laneFetch({}));
    const { harness } = await harnessFor(ENABLED);

    await harness.runJob(JOB_KEYS.poll);

    const snapshot = harness.getState({
      scopeKind: "company",
      scopeId: COMPANY,
      stateKey: STATE_KEYS.modelUsage,
    }) as { models: Record<string, unknown>; telemetry: string };
    expect(Object.keys(snapshot.models)).toContain("oc/claude-opus-5");
    expect(snapshot.telemetry).toBe("available");
  });

  /**
   * model-usage-telemetry-v1 §3.1: a consumer MUST reject a version it does
   * not implement rather than best-effort parse it. Storing a v2 body under
   * v1 state would let a later reader apply v1 meaning to v2 fields.
   */
  it("refuses a model-usage body whose schemaVersion it does not implement", async () => {
    vi.stubGlobal("fetch", laneFetch({ models: modelUsageBody({ schemaVersion: 2 }) }));
    const { harness } = await harnessFor(ENABLED);

    await harness.runJob(JOB_KEYS.poll);

    expect(
      harness.getState({
        scopeKind: "company",
        scopeId: COMPANY,
        stateKey: STATE_KEYS.modelUsage,
      }) ?? null,
    ).toBeNull();
    expect(
      harness.metrics.some(
        (m) =>
          m.name === "cliproxy_insight.poll_errors" &&
          m.tags?.reason === "unsupported_schema_version",
      ),
    ).toBe(true);
  });

  it("still persists provider counters when the model-usage file is unavailable", async () => {
    const fetchSpy = vi.fn().mockImplementation(async (url: string) =>
      url.endsWith(LANE_PATHS.requestRates)
        ? jsonResponse(200, ratesBody())
        : jsonResponse(500, { error: "boom" }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { harness } = await harnessFor(ENABLED);

    await harness.runJob(JOB_KEYS.poll);

    // One file failing does not discard the other file's data.
    expect(
      harness.getState({
        scopeKind: "company",
        scopeId: COMPANY,
        stateKey: STATE_KEYS.provider("claude"),
      }),
    ).toBeTruthy();
    expect(harness.metrics.some((m) => m.name === "cliproxy_insight.poll_ok")).toBe(true);
  });

  it("logs a change only when a provider's counters actually move", async () => {
    const body = ratesBody();
    const fetchSpy = vi
      .fn()
      .mockImplementationOnce(async () => jsonResponse(200, body))
      .mockImplementationOnce(async () => jsonResponse(200, modelUsageBody()))
      .mockImplementationOnce(async () => jsonResponse(200, body))
      .mockImplementationOnce(async () => jsonResponse(200, modelUsageBody()));
    vi.stubGlobal("fetch", fetchSpy);
    const { harness } = await harnessFor(ENABLED);

    await harness.runJob(JOB_KEYS.poll); // first observation: changed vs. null
    await harness.runJob(JOB_KEYS.poll); // identical body: no change

    expect(harness.activity.filter((a) => a.message.includes("provider(s) changed"))).toHaveLength(1);
  });
});

describe("cooldown events", () => {
  it("records an event when a provider enters cooldown", async () => {
    vi.stubGlobal("fetch", laneFetch({}));
    const { harness } = await harnessFor(ENABLED);

    await harness.runJob(JOB_KEYS.poll);

    const events = harness.getState({
      scopeKind: "company",
      scopeId: COMPANY,
      stateKey: STATE_KEYS.cooldownEvents("kimi"),
    }) as { reason: string }[];
    expect(events).toHaveLength(1);
    expect(events[0]?.reason).toBe("exhausted_flag");
  });

  /**
   * Records the transition, not the condition. A provider that stays
   * exhausted for hours would otherwise append an event every firing and
   * evict every other provider's history from the capped log.
   */
  it("does not re-record an unchanged cooldown on every firing", async () => {
    vi.stubGlobal("fetch", laneFetch({}));
    const { harness } = await harnessFor(ENABLED);

    await harness.runJob(JOB_KEYS.poll);
    await harness.runJob(JOB_KEYS.poll);
    await harness.runJob(JOB_KEYS.poll);

    const events = harness.getState({
      scopeKind: "company",
      scopeId: COMPANY,
      stateKey: STATE_KEYS.cooldownEvents("kimi"),
    }) as unknown[];
    expect(events).toHaveLength(1);
  });

  it("caps the retained event log at the configured maximum", async () => {
    let flip = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        if (!url.endsWith(LANE_PATHS.requestRates)) return jsonResponse(200, modelUsageBody());
        // Alternate in and out of cooldown so every other firing is a real
        // transition, which is what the cap has to bound.
        flip += 1;
        return jsonResponse(
          200,
          ratesBody({
            kimi:
              flip % 2 === 1
                ? { success: 0, failed: 31, exhausted: true }
                : { success: 5, failed: 0 },
          }),
        );
      }),
    );
    const { harness } = await harnessFor({ ...ENABLED, maxCooldownEventsPerProvider: 2 });

    for (let i = 0; i < 8; i += 1) await harness.runJob(JOB_KEYS.poll);

    const events = harness.getState({
      scopeKind: "company",
      scopeId: COMPANY,
      stateKey: STATE_KEYS.cooldownEvents("kimi"),
    }) as unknown[];
    expect(events).toHaveLength(2);
  });
});

describe("get_provider_usage tool", () => {
  it("is read-only: reads persisted state and never calls fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { harness } = await harnessFor({ pollingEnabled: false });
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: STATE_KEYS.provider("claude") },
      {
        schemaVersion: 1,
        provider: "claude",
        polledAt: new Date().toISOString(),
        observedAt: new Date().toISOString(),
        success: 7,
        failed: 0,
        raw: { success: 7, failed: 0 },
      },
    );
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: STATE_KEYS.providerIndex },
      ["claude"],
    );

    const result = (await harness.executeTool(TOOL_NAMES.getProviderUsage, {
      companyId: COMPANY,
      provider: "claude",
    })) as { data: { snapshots: Record<string, { success: number; stale: boolean }> } };

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.data.snapshots.claude?.success).toBe(7);
    expect(result.data.snapshots.claude?.stale).toBe(false);
  });

  it("refuses a call with no companyId", async () => {
    const { harness } = await harnessFor({});
    const result = (await harness.executeTool(TOOL_NAMES.getProviderUsage, {})) as { error?: string };
    expect(result.error).toMatch(/companyId is required/);
  });

  /**
   * Freshness has to be reported, not assumed. The lane republishes every 2
   * minutes; a snapshot that stopped updating an hour ago looks identical to
   * a current one unless the age is carried through to the caller.
   */
  it("flags a snapshot older than the staleness budget as stale", async () => {
    const { harness } = await harnessFor({ staleAfterSeconds: 600 });
    const old = new Date(Date.now() - 3600_000).toISOString();
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: STATE_KEYS.provider("claude") },
      { schemaVersion: 1, provider: "claude", polledAt: old, observedAt: old, success: 7, failed: 0, raw: {} },
    );
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: STATE_KEYS.providerIndex },
      ["claude"],
    );

    const result = (await harness.executeTool(TOOL_NAMES.getProviderUsage, {
      companyId: COMPANY,
    })) as { data: { snapshots: Record<string, { stale: boolean }> } };

    expect(result.data.snapshots.claude?.stale).toBe(true);
  });

  it("returns an empty provider set before the first successful poll", async () => {
    const { harness } = await harnessFor({});
    const result = (await harness.executeTool(TOOL_NAMES.getProviderUsage, {
      companyId: COMPANY,
    })) as { data: { providers: string[]; modelUsage: unknown } };
    expect(result.data.providers).toEqual([]);
    expect(result.data.modelUsage).toBeNull();
  });

  it("returns every provider observed by a real poll", async () => {
    vi.stubGlobal("fetch", laneFetch({}));
    const { harness } = await harnessFor(ENABLED);
    await harness.runJob(JOB_KEYS.poll);

    const result = (await harness.executeTool(TOOL_NAMES.getProviderUsage, {
      companyId: COMPANY,
    })) as { data: { providers: string[]; modelUsage: { stale: boolean } } };

    expect(result.data.providers.sort()).toEqual(
      ["claude", "codex", "codex-spark", "kimi", "opencode-go"].sort(),
    );
    expect(result.data.modelUsage.stale).toBe(false);
  });
});

describe("onValidateConfig", () => {
  it("accepts the inert default", async () => {
    const { plugin } = await harnessFor({});
    expect((await plugin.onValidateConfig!({})).ok).toBe(true);
  });

  it("rejects pollingEnabled: true with no secret configured", async () => {
    const { plugin } = await harnessFor({});
    const result = await plugin.onValidateConfig!({ pollingEnabled: true });
    expect(result.ok).toBe(false);
    expect(result.errors?.join(" ")).toContain("laneApiKeySecretRef");
  });

  it("rejects a baseUrl pointed at loopback (TOG-352: unreachable, and the wrong endpoint anyway)", async () => {
    const { plugin } = await harnessFor({});
    const result = await plugin.onValidateConfig!({
      ...ENABLED,
      baseUrl: "http://127.0.0.1:8317",
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.join(" ")).toContain("loopback");
  });

  /**
   * The management API returns api-keys, config and id_tokens in clear. A
   * baseUrl pointed at it is refused by name rather than left to look
   * plausible — this plugin has no reason to ever read that surface.
   */
  it("rejects a baseUrl pointed at the CLIProxy management API", async () => {
    const { plugin } = await harnessFor({});
    const result = await plugin.onValidateConfig!({
      ...ENABLED,
      baseUrl: "https://cliproxy.example.net/v0/management",
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.join(" ")).toContain("management API");
  });

  it("rejects plaintext http, which would put the lane bearer on the wire in clear", async () => {
    const { plugin } = await harnessFor({});
    const result = await plugin.onValidateConfig!({
      ...ENABLED,
      baseUrl: "http://router.example.net/telemetry/cliproxy",
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.join(" ")).toContain("https");
  });

  it("rejects a malformed secret reference", async () => {
    const { plugin } = await harnessFor({});
    const result = await plugin.onValidateConfig!({ laneApiKeySecretRef: "sk-raw-key" });
    expect(result.ok).toBe(false);
  });
});

describe("scoped API route", () => {
  it("answers usage-summary with the persisted providers and model usage", async () => {
    vi.stubGlobal("fetch", laneFetch({}));
    const { harness, plugin } = await harnessFor(ENABLED);
    await harness.runJob(JOB_KEYS.poll);

    const response = await plugin.onApiRequest!({
      routeKey: ROUTE_KEYS.usageSummary,
      method: "GET",
      path: "/usage-summary",
      params: {},
      query: { companyId: COMPANY },
      body: null,
      actor: { actorType: "agent", actorId: "agent-1" },
      companyId: COMPANY,
      headers: {},
    });

    expect(response.status).toBe(200);
    const body = response.body as {
      providers: string[];
      snapshots: Record<string, { success: number }>;
      modelUsage: { models: Record<string, unknown> };
    };
    expect(body.providers).toContain("codex-spark");
    expect(body.snapshots.claude?.success).toBe(120);
    expect(Object.keys(body.modelUsage.models)).toContain("oc/claude-opus-5");
  });

  it("404s an unknown route key", async () => {
    const { plugin } = await harnessFor({});
    const response = await plugin.onApiRequest!({
      routeKey: "nope",
      method: "GET",
      path: "/nope",
      params: {},
      query: {},
      body: null,
      actor: { actorType: "agent", actorId: "agent-1" },
      companyId: COMPANY,
      headers: {},
    });
    expect(response.status).toBe(404);
  });
});

describe("pure helpers", () => {
  it("extractProviderRecords reads both a nested and a bare provider map", () => {
    const nested = extractProviderRecords(
      { providers: { claude: { success: 1, failed: 0 } } },
      "2026-09-05T00:00:00.000Z",
    );
    const bare = extractProviderRecords(
      { observedAt: "2026-09-05T00:00:00.000Z", claude: { success: 1, failed: 0 } },
      "2026-09-05T00:00:00.000Z",
    );
    expect(nested.records.map((r) => r.provider)).toEqual(["claude"]);
    expect(bare.records.map((r) => r.provider)).toEqual(["claude"]);
  });

  it("extractProviderRecords ignores scalar envelope fields sitting beside providers", () => {
    const { records } = extractProviderRecords(
      { observedAt: "2026-09-05T00:00:00.000Z", schemaVersion: 1, claude: { success: 1 } },
      "2026-09-05T00:00:00.000Z",
    );
    expect(records.map((r) => r.provider)).toEqual(["claude"]);
  });

  it("extractProviderRecords reports a missing counter as null, never as zero", () => {
    const { records } = extractProviderRecords(
      { providers: { claude: { requests: 5 } } },
      "2026-09-05T00:00:00.000Z",
    );
    // Zero traffic and an unreadable counter are different facts.
    expect(records[0]?.success).toBeNull();
    expect(records[0]?.failed).toBeNull();
  });

  it("cooldownReason returns bounded codes and null for a healthy provider", () => {
    expect(cooldownReason({ success: 1, failed: 0 })).toBeNull();
    expect(cooldownReason({ exhausted: true })).toBe("exhausted_flag");
    expect(cooldownReason({ state: "EXHAUSTED" })).toBe("state_exhausted");
    expect(cooldownReason({ serviceable: false })).toBe("not_serviceable");
  });

  it("isStale treats an absent or unparseable observedAt as stale", () => {
    const now = Date.parse("2026-09-05T03:00:00.000Z");
    expect(isStale(undefined, 600, now)).toBe(true);
    expect(isStale("not-a-date", 600, now)).toBe(true);
    expect(isStale("2026-09-05T02:59:00.000Z", 600, now)).toBe(false);
    expect(isStale("2026-09-05T02:30:00.000Z", 600, now)).toBe(true);
  });
});

/**
 * v0.3.0: the per-lane documents the telemetry lane actually serves.
 *
 * The bodies below are the real published shapes, copied from
 * `ops/tog-3120/collector-evidence/{claude,codex,zai}.json` captured live at
 * 2026-09-17T00:23:15Z — not invented fixtures. The cooldown fields are the
 * quota contract v4 additions (`cliproxy_quota_contract.py` @ `10864210`).
 */
describe("scheduled poll: per-lane documents", () => {
  const LANE_ENABLED = {
    pollingEnabled: true,
    laneApiKeySecretRef: SECRET_REF,
    laneFiles: ["claude.json", "zai.json"],
  };

  const OBSERVED = new Date().toISOString();

  function laneDoc(records: Record<string, unknown>[], overrides: Record<string, unknown> = {}) {
    return { schemaVersion: 1, observedAt: OBSERVED, staleAfterSeconds: 300, records, ...overrides };
  }

  const CLAUDE_RECORD = {
    lane: "claude-lane-1",
    health: "healthy",
    weight: 1,
    governing_window: "seven_day",
    window_seconds: { five_hour: 18000, seven_day: 604800 },
    five_hour_utilization: 0.05,
    seven_day_utilization: 0.85,
  };

  const ZAI_RECORD = {
    lane: "zai-lane-1",
    health: "healthy",
    plan: "pro",
    governing_window: "weekly",
    five_hour_utilization: 0.4911,
    weekly_utilization: 0.438,
  };

  /** Routes each lane file to its own document; anything else 404s, as the lane does. */
  function laneDocFetch(byFile: Record<string, unknown>, status = 200) {
    return vi.fn().mockImplementation(async (url: string) => {
      for (const [file, body] of Object.entries(byFile)) {
        if (url.endsWith(`/${file}`)) return jsonResponse(status, body);
      }
      return jsonResponse(404, { error: "not found" });
    });
  }

  async function laneState(harness: Awaited<ReturnType<typeof harnessFor>>["harness"], file: string) {
    return (await harness.ctx.state.get({
      scopeKind: "company",
      scopeId: COMPANY,
      stateKey: STATE_KEYS.lane(file),
    })) as { records: Record<string, unknown>[]; observedAt: string } | null;
  }

  it("persists one snapshot per lane document and indexes the lanes it read", async () => {
    vi.stubGlobal(
      "fetch",
      laneDocFetch({ "claude.json": laneDoc([CLAUDE_RECORD]), "zai.json": laneDoc([ZAI_RECORD]) }),
    );
    const { harness } = await harnessFor(LANE_ENABLED);

    await harness.runJob(JOB_KEYS.poll);

    expect((await laneState(harness, "claude.json"))?.records[0]?.lane).toBe("claude-lane-1");
    expect((await laneState(harness, "zai.json"))?.records[0]?.weekly_utilization).toBe(0.438);
    expect(
      await harness.ctx.state.get({
        scopeKind: "company",
        scopeId: COMPANY,
        stateKey: STATE_KEYS.laneIndex,
      }),
    ).toEqual(["claude.json", "zai.json"]);
    expect(harness.metrics.some((m) => m.name === "cliproxy_insight.poll_ok")).toBe(true);
  });

  /**
   * The owner's 2026-09-17 00:44Z case: Z.ai was in a subscription-pool cooldown
   * while the lane still read `health: "healthy"`, and seven runs failed. The
   * cooldown instant — not `health` — is what has to be visible.
   */
  it("records a cooldown event for an ACTIVE exhausted_until even when health says healthy", async () => {
    const until = new Date(Date.now() + 300_000).toISOString();
    vi.stubGlobal(
      "fetch",
      laneDocFetch({
        "claude.json": laneDoc([CLAUDE_RECORD]),
        "zai.json": laneDoc([
          { ...ZAI_RECORD, exhausted_until: until, exhausted_reason: "conservative rate-limit cooldown" },
        ]),
      }),
    );
    const { harness } = await harnessFor(LANE_ENABLED);

    await harness.runJob(JOB_KEYS.poll);

    const events = (await harness.ctx.state.get({
      scopeKind: "company",
      scopeId: COMPANY,
      stateKey: STATE_KEYS.cooldownEvents("zai-lane-1"),
    })) as { reason: string; raw: { until: string } }[];
    expect(events).toHaveLength(1);
    expect(events[0]?.reason).toBe("conservative rate-limit cooldown");
    expect(events[0]?.raw.until).toBe(until);
    expect(
      harness.metrics.filter((m) => m.name === "cliproxy_insight.lane_accounts_cooling").at(-1)?.value,
    ).toBe(1);
  });

  it("does not re-log an unchanged cooldown, but does log an extended one", async () => {
    const until = new Date(Date.now() + 300_000).toISOString();
    const extended = new Date(Date.now() + 900_000).toISOString();
    const withUntil = (u: string) => laneDoc([{ ...ZAI_RECORD, exhausted_until: u }]);

    vi.stubGlobal("fetch", laneDocFetch({ "zai.json": withUntil(until) }));
    const { harness } = await harnessFor({ ...LANE_ENABLED, laneFiles: ["zai.json"] });
    await harness.runJob(JOB_KEYS.poll);
    await harness.runJob(JOB_KEYS.poll);

    const key = { scopeKind: "company" as const, scopeId: COMPANY, stateKey: STATE_KEYS.cooldownEvents("zai-lane-1") };
    expect((await harness.ctx.state.get(key)) as unknown[]).toHaveLength(1);

    vi.stubGlobal("fetch", laneDocFetch({ "zai.json": withUntil(extended) }));
    await harness.runJob(JOB_KEYS.poll);
    expect((await harness.ctx.state.get(key)) as unknown[]).toHaveLength(2);
  });

  it("treats an EXPIRED cooldown instant as serving, not as cooling", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    vi.stubGlobal(
      "fetch",
      laneDocFetch({ "zai.json": laneDoc([{ ...ZAI_RECORD, exhausted_until: past }]) }),
    );
    const { harness } = await harnessFor({ ...LANE_ENABLED, laneFiles: ["zai.json"] });

    await harness.runJob(JOB_KEYS.poll);

    expect(
      await harness.ctx.state.get({
        scopeKind: "company",
        scopeId: COMPANY,
        stateKey: STATE_KEYS.cooldownEvents("zai-lane-1"),
      }),
    ).toBeNull();
    expect(
      harness.metrics.filter((m) => m.name === "cliproxy_insight.lane_accounts_cooling").at(-1)?.value,
    ).toBe(0);
  });

  it("keeps reading the other lanes when one lane file 404s", async () => {
    vi.stubGlobal("fetch", laneDocFetch({ "claude.json": laneDoc([CLAUDE_RECORD]) }));
    const { harness } = await harnessFor(LANE_ENABLED);

    await harness.runJob(JOB_KEYS.poll);

    expect((await laneState(harness, "claude.json"))?.records).toHaveLength(1);
    expect(await laneState(harness, "zai.json")).toBeNull();
    expect(
      harness.metrics.some(
        (m) => m.name === "cliproxy_insight.poll_errors" && m.tags?.reason === "http_404",
      ),
    ).toBe(true);
    // One unserved lane is not a failed poll: devin.json 404s today by design.
    expect(harness.metrics.some((m) => m.name === "cliproxy_insight.poll_ok")).toBe(true);
  });

  /**
   * The lane index is unioned, never clobbered: a lane absent from one publish
   * (or 404ing for one firing) is not evidence it stopped existing, and
   * dropping it from the index makes its stored snapshot unreachable, since
   * plugin state offers no scan.
   */
  it("keeps a previously-seen lane in the index when it 404s for one firing", async () => {
    vi.stubGlobal(
      "fetch",
      laneDocFetch({ "claude.json": laneDoc([CLAUDE_RECORD]), "zai.json": laneDoc([ZAI_RECORD]) }),
    );
    const { harness } = await harnessFor(LANE_ENABLED);
    await harness.runJob(JOB_KEYS.poll);

    vi.stubGlobal("fetch", laneDocFetch({ "claude.json": laneDoc([CLAUDE_RECORD]) }));
    await harness.runJob(JOB_KEYS.poll);

    expect(
      await harness.ctx.state.get({
        scopeKind: "company",
        scopeId: COMPANY,
        stateKey: STATE_KEYS.laneIndex,
      }),
    ).toEqual(["claude.json", "zai.json"]);
  });

  it("refuses an unimplemented schemaVersion instead of best-effort storing it", async () => {
    vi.stubGlobal(
      "fetch",
      laneDocFetch({ "zai.json": laneDoc([ZAI_RECORD], { schemaVersion: 2 }) }),
    );
    const { harness } = await harnessFor({ ...LANE_ENABLED, laneFiles: ["zai.json"] });

    await harness.runJob(JOB_KEYS.poll);

    expect(await laneState(harness, "zai.json")).toBeNull();
    expect(
      harness.metrics.some(
        (m) =>
          m.name === "cliproxy_insight.poll_errors" &&
          m.tags?.reason === "unsupported_schema_version",
      ),
    ).toBe(true);
  });

  it("does not touch the aggregate files unless legacyAggregateFiles is on", async () => {
    const fetchSpy = laneDocFetch({ "zai.json": laneDoc([ZAI_RECORD]) });
    vi.stubGlobal("fetch", fetchSpy);
    const { harness } = await harnessFor({ ...LANE_ENABLED, laneFiles: ["zai.json"] });

    await harness.runJob(JOB_KEYS.poll);

    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.endsWith(LANE_PATHS.requestRates))).toBe(false);
    expect(urls.some((u) => u.endsWith(LANE_PATHS.modelUsage))).toBe(false);
  });

  it("exposes lanes and per-account cooldown on both read surfaces", async () => {
    const until = new Date(Date.now() + 300_000).toISOString();
    vi.stubGlobal(
      "fetch",
      laneDocFetch({ "zai.json": laneDoc([{ ...ZAI_RECORD, exhausted_until: until }]) }),
    );
    const { harness, plugin } = await harnessFor({ ...LANE_ENABLED, laneFiles: ["zai.json"] });
    await harness.runJob(JOB_KEYS.poll);

    type LaneView = {
      lanes: string[];
      accountsCooling: number;
      laneSnapshots: Record<
        string,
        { stale: boolean; accounts: { account: string; cooldown: { until: string } | null }[] }
      >;
    };

    const tool = (await harness.executeTool(TOOL_NAMES.getProviderUsage, {
      companyId: COMPANY,
    })) as { data: LaneView };
    expect(tool.data.lanes).toEqual(["zai.json"]);
    expect(tool.data.accountsCooling).toBe(1);
    expect(tool.data.laneSnapshots["zai.json"]?.accounts[0]?.cooldown?.until).toBe(until);
    expect(tool.data.laneSnapshots["zai.json"]?.stale).toBe(false);

    const route = (await plugin.onApiRequest!({
      routeKey: ROUTE_KEYS.usageSummary,
      companyId: COMPANY,
    } as never)) as { status: number; body: LaneView };
    expect(route.status).toBe(200);
    expect(route.body.accountsCooling).toBe(1);
    expect(route.body.laneSnapshots["zai.json"]?.accounts[0]?.account).toBe("zai-lane-1");
  });

  /**
   * Cooldown is evaluated when the surface is read, not frozen at poll time:
   * a stored snapshot whose instant has since passed must stop reporting a
   * cooldown even if no poll has run since.
   */
  it("stops reporting a stored cooldown once its instant passes", async () => {
    const { harness } = await harnessFor({ ...LANE_ENABLED, laneFiles: ["zai.json"] });
    const past = new Date(Date.now() - 1000).toISOString();
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: STATE_KEYS.lane("zai.json") },
      {
        schemaVersion: 1,
        laneFile: "zai.json",
        polledAt: new Date().toISOString(),
        observedAt: new Date().toISOString(),
        staleAfterSeconds: 300,
        records: [{ ...ZAI_RECORD, exhausted_until: past }],
      },
    );
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: STATE_KEYS.laneIndex },
      ["zai.json"],
    );

    const tool = (await harness.executeTool(TOOL_NAMES.getProviderUsage, {
      companyId: COMPANY,
    })) as { data: { accountsCooling: number } };
    expect(tool.data.accountsCooling).toBe(0);
  });
});

describe("laneCooldown / extractLaneDocument (pure)", () => {
  const NOW = Date.parse("2026-09-17T01:00:00.000Z");
  const future = "2026-09-17T01:05:00.000Z";
  const past = "2026-09-17T00:55:00.000Z";

  it("reads the flat contract key and every accepted alias", () => {
    for (const field of [
      "exhausted_until",
      "exhaustedUntil",
      "cooldown_until",
      "cooldownUntil",
      "rate_limited_until",
      "rateLimitedUntil",
    ]) {
      expect(laneCooldown({ [field]: future }, NOW)?.until).toBe(future);
    }
  });

  /**
   * The defect this exists to prevent: `8a5b98de` published the cooldown ONLY
   * as a nested object, which a flat-key reader never sees — producer correct,
   * validator green, pacer still dispatching to a cooled-down credential.
   */
  it("reads a nested cooldown object when no flat key is present", () => {
    expect(laneCooldown({ cooldown: { until: future, reason: "rate-limit" } }, NOW)).toEqual({
      until: future,
      reason: "rate-limit",
    });
  });

  it("is null for an expired instant and for a healthy record", () => {
    expect(laneCooldown({ exhausted_until: past }, NOW)).toBeNull();
    expect(laneCooldown({ health: "healthy", weekly_utilization: 0.4 }, NOW)).toBeNull();
  });

  /**
   * `exhausted` is unserviceable; `cooldown` is NOT accepted as a health value
   * because the Router maps it to `degraded` → posture `avoid`, which still
   * selects the lane (measured on TOG-811, 2026-09-17).
   */
  it("accepts exhausted/unavailable health but not cooldown health", () => {
    expect(laneCooldown({ health: "exhausted" }, NOW)?.reason).toBe("health_exhausted");
    expect(laneCooldown({ health: "unavailable" }, NOW)?.reason).toBe("health_unavailable");
    expect(laneCooldown({ health: "cooldown" }, NOW)).toBeNull();
  });

  it("reports an unparseable instant rather than silently dropping it", () => {
    expect(laneCooldown({ exhausted_until: "soon" }, NOW)?.reason).toBe(
      "cooldown_unparseable_until",
    );
  });

  it("extractLaneDocument refuses a foreign schemaVersion and keeps records verbatim", () => {
    expect(extractLaneDocument({ schemaVersion: 2, records: [] }, "zai.json", past)).toBeNull();
    const doc = extractLaneDocument(
      { schemaVersion: 1, observedAt: past, records: [{ lane: "zai-lane-1", unknown_future: 7 }] },
      "zai.json",
      past,
    );
    expect(doc?.records[0]?.unknown_future).toBe(7);
    expect(doc?.observedAt).toBe(past);
  });

  it("laneAccountId falls back to the file stem when a record carries no lane id", () => {
    expect(laneAccountId({ lane: "zai-lane-1" }, "zai.json")).toBe("zai-lane-1");
    expect(laneAccountId({}, "opencode-go.json")).toBe("opencode-go");
  });
});
