import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import manifest from "../src/manifest.js";
import { JOB_KEYS, ROUTE_KEYS, TOOL_NAMES } from "../src/constants.js";
import { createPlugin } from "../src/worker.js";
import { SECRET_REF } from "./helpers.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const ENABLED = { pollingEnabled: true, laneApiKeySecretRef: SECRET_REF };

async function setup(config: Record<string, unknown> = ENABLED, deliver = true) {
  const harness = createTestHarness({ manifest, config });
  const { definition: plugin } = createPlugin();
  await plugin.setup!(harness.ctx);
  if (deliver) await plugin.onConfigChanged!(config, { companyId: A });
  const fetch = vi.fn(async () => new Response(JSON.stringify({
    schemaVersion: 1, observedAt: new Date().toISOString(), records: [],
  }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  return { harness, plugin, fetch };
}
afterEach(() => vi.unstubAllGlobals());

describe("single explicitly configured company", () => {
  it("does not turn bootstrap config into authorization or enumerate companies", async () => {
    const { harness, fetch } = await setup(ENABLED, false);
    const config = vi.spyOn(harness.ctx.config, "get");
    const companies = vi.spyOn(harness.ctx.companies, "list");
    await harness.runJob(JOB_KEYS.poll);
    expect(config).not.toHaveBeenCalled();
    expect(companies).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(harness.metrics.some((m) => m.name === "cliproxy_insight.poll_skipped_company_scope")).toBe(true);
    expect(manifest.capabilities).not.toContain("companies.read");
  });

  it("replays the same company without multiplying requests, reading current config every time", async () => {
    const { harness, plugin, fetch } = await setup();
    await plugin.onConfigChanged!(ENABLED, { companyId: A });
    const config = vi.spyOn(harness.ctx.config, "get");
    await harness.runJob(JOB_KEYS.poll);
    expect(config).toHaveBeenCalledTimes(1);
    expect(config).toHaveBeenCalledWith(A);
    expect(fetch).toHaveBeenCalledTimes(6);
    config.mockResolvedValue({ pollingEnabled: false });
    await harness.runJob(JOB_KEYS.poll);
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it.each([ENABLED, { ...ENABLED, staleAfterSeconds: 123 }])(
    "refuses a second company's config, even identical, and latches all polling off until restart",
    async (second) => {
      const { harness, plugin, fetch } = await setup();
      await expect(plugin.onConfigChanged!(second, { companyId: B })).rejects.toThrow("exactly one configured company");
      expect(harness.metrics.filter((m) => m.name === "cliproxy_insight.company_scope_refused"))
        .toEqual([expect.objectContaining({ value: 1, tags: { reason: "multiple_companies" } })]);
      const config = vi.spyOn(harness.ctx.config, "get");
      // A,A after refusing B must never clear the latch or read scoped services.
      for (let replay = 0; replay < 2; replay++) {
        await expect(plugin.onConfigChanged!(ENABLED, { companyId: A })).rejects.toThrow("exactly one configured company");
        await harness.runJob(JOB_KEYS.poll);
      }
      expect(harness.metrics.filter((m) => m.name === "cliproxy_insight.company_scope_refused")).toHaveLength(3);
      expect(config).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])("stays inert on missing identity, even with an existing binding: %s", async (bound) => {
    const { harness, plugin, fetch } = await setup(ENABLED, bound);
    const config = vi.spyOn(harness.ctx.config, "get");
    const secret = vi.spyOn(harness.ctx.secrets, "resolve");
    const state = vi.spyOn(harness.ctx.state, "get");
    await expect(plugin.onConfigChanged!(ENABLED, { companyId: null })).resolves.toBeUndefined();
    expect(harness.metrics.filter((m) => m.name === "cliproxy_insight.company_scope_refused"))
      .toEqual([expect.objectContaining({ value: 1, tags: { reason: "missing_company_id" } })]);
    await expect(harness.runJob(JOB_KEYS.poll)).resolves.toBeUndefined();
    await plugin.onConfigChanged!(ENABLED, { companyId: A });
    await expect(harness.runJob(JOB_KEYS.poll)).resolves.toBeUndefined();
    expect(await harness.executeTool(TOOL_NAMES.getProviderUsage, { companyId: A }))
      .toEqual({ error: "company is not configured" });
    expect(config).not.toHaveBeenCalled();
    expect(secret).not.toHaveBeenCalled();
    expect(state).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not leak arbitrary config-service errors when host scope is revoked", async () => {
    const { harness, fetch } = await setup();
    vi.spyOn(harness.ctx.config, "get").mockRejectedValue(new Error("sensitive-fixture-marker"));
    await expect(harness.runJob(JOB_KEYS.poll)).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(harness.logs.some((l) => l.message.includes("poll failed"))).toBe(true);
    expect(JSON.stringify(harness.logs)).not.toContain("sensitive-fixture-marker");
    expect(harness.metrics.some((m) => m.tags?.reason === "unhandled")).toBe(true);
  });

  it("does not log raw secret resolver failures (positive log control)", async () => {
    const { harness, fetch } = await setup();
    vi.spyOn(harness.ctx.secrets, "resolve").mockRejectedValue(new Error("sensitive-fixture-marker"));
    await harness.runJob(JOB_KEYS.poll);
    expect(fetch).not.toHaveBeenCalled();
    expect(harness.logs.some((l) => l.message.includes("could not resolve"))).toBe(true);
    expect(JSON.stringify(harness.logs)).not.toContain("sensitive-fixture-marker");
    expect(harness.metrics.some((m) => m.tags?.reason === "secret_resolve_failed")).toBe(true);
  });

  it("refuses cross-company tool and API reads before config or state services", async () => {
    const { harness, plugin } = await setup();
    const config = vi.spyOn(harness.ctx.config, "get");
    const state = vi.spyOn(harness.ctx.state, "get");
    expect(await harness.executeTool(TOOL_NAMES.getProviderUsage, { companyId: B }))
      .toEqual({ error: "company is not configured" });
    const response = await plugin.onApiRequest!({
      routeKey: ROUTE_KEYS.usageSummary, method: "GET", path: "/usage-summary",
      companyId: B, query: { companyId: B }, params: {}, headers: {}, body: null,
      actor: { actorType: "agent", actorId: "fixture" },
    });
    expect(response.status).toBe(403);
    expect(config).not.toHaveBeenCalled();
    expect(state).not.toHaveBeenCalled();
  });

  it("refuses a tool read invalidated during the scoped config await", async () => {
    const { harness, plugin } = await setup();
    const state = vi.spyOn(harness.ctx.state, "get");
    const config = vi.spyOn(harness.ctx.config, "get").mockImplementation(async () => {
      await expect(plugin.onConfigChanged!(ENABLED, { companyId: B })).rejects.toThrow("exactly one");
      return ENABLED;
    });
    expect(await harness.executeTool(TOOL_NAMES.getProviderUsage, { companyId: A }))
      .toEqual({ error: "company is not configured" });
    expect(config).toHaveBeenCalledTimes(1);
    expect(config).toHaveBeenCalledWith(A);
    expect(state).not.toHaveBeenCalled();
  });

  it("refuses an API read invalidated during the scoped config await", async () => {
    const { harness, plugin } = await setup();
    const state = vi.spyOn(harness.ctx.state, "get");
    const config = vi.spyOn(harness.ctx.config, "get").mockImplementation(async () => {
      await expect(plugin.onConfigChanged!(ENABLED, { companyId: B })).rejects.toThrow("exactly one");
      return ENABLED;
    });
    const response = await plugin.onApiRequest!({
      routeKey: ROUTE_KEYS.usageSummary, method: "GET", path: "/usage-summary",
      companyId: A, query: {}, params: {}, headers: {}, body: null,
      actor: { actorType: "agent", actorId: "fixture" },
    });
    expect(response).toEqual({ status: 403, body: { error: "company is not configured" } });
    expect(config).toHaveBeenCalledTimes(1);
    expect(config).toHaveBeenCalledWith(A);
    expect(state).not.toHaveBeenCalled();
  });

  it("stops before secrets if a second config arrives during the config read", async () => {
    const { harness, plugin, fetch } = await setup();
    const secret = vi.spyOn(harness.ctx.secrets, "resolve");
    vi.spyOn(harness.ctx.config, "get").mockImplementation(async () => {
      await expect(plugin.onConfigChanged!(ENABLED, { companyId: B })).rejects.toThrow("exactly one");
      return ENABLED;
    });
    await harness.runJob(JOB_KEYS.poll);
    expect(secret).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops before outbound calls if a second config arrives during secret resolution", async () => {
    const { harness, plugin, fetch } = await setup();
    vi.spyOn(harness.ctx.secrets, "resolve").mockImplementation(async () => {
      await expect(plugin.onConfigChanged!(ENABLED, { companyId: B })).rejects.toThrow("exactly one");
      return "fixture-not-a-real-secret";
    });
    await harness.runJob(JOB_KEYS.poll);
    expect(fetch).not.toHaveBeenCalled();
  });
});
