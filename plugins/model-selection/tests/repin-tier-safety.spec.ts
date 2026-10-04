import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

import { PLUGIN_STATE_KEYS, type Tier } from "../src/constants.js";
import manifest from "../src/manifest.js";
import { createPlugin } from "../src/worker.js";
import type { ModelEntry } from "../src/engine/types.js";
import { MODELS, NO_ESCALATION, NOW, PROFILES } from "./fixtures.js";

const COMPANY = "co-1";
const ISSUE = "repin-card";
const incumbent = "claude-opus-5";
const normal = "claude-sonnet-5";
const weak = "glm-5.3-flash";
const fallback = "devin/swe-2";

function roster(normalTier: Tier = "T1", fallbackTier: Tier = "T1"): ModelEntry[] {
  const base = MODELS.find((model) => model.id === incumbent)!;
  return [
    { ...base, laneId: "lane-dead", contextWindow: 200_000 },
    { ...base, id: normal, tier: normalTier, laneId: "lane-normal", contextWindow: 200_000 },
    { ...base, id: weak, tier: "T3", laneId: "lane-weak", contextWindow: 200_000, costPerMTokIn: 0.1 },
    { ...base, id: fallback, tier: fallbackTier, laneId: "lane-fallback", contextWindow: 200_000, fallbackOnly: true, costPerMTokIn: 0.01 },
  ];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

async function boot(models: ModelEntry[], cardOverrides: Partial<Issue> = {}, adapterType = "codex_local", pacingMode = "enforce") {
  const card = {
    id: ISSUE, companyId: COMPANY, title: "Engineering hotfix", priority: "critical", status: "in_progress",
    assigneeAgentId: "agent-1", assigneeUserId: null, checkoutRunId: null, executionRunId: null,
    labels: [], labelIds: [], assigneeAdapterOverrides: { adapterConfig: { model: incumbent } },
    ...cardOverrides,
  } as unknown as Issue;
  const config = {
    models,
    classification: { enabled: true },
    selection: { enabled: true, mode: "enforce", defaultTier: "T3", fleetContextCeilingTokens: 200_000 },
    pacing: { mode: pacingMode },
  };
  const harness = createTestHarness({ manifest, config });
  harness.seed({
    issues: [card], companies: [{ id: COMPANY, name: "Co" } as never],
    agents: [{ id: "agent-1", companyId: COMPANY, name: "Engineer", adapterType, adapterConfig: { model: weak, env: { KEEP: "binding" } } } as never],
  });
  const plugin = createPlugin();
  await plugin.definition.setup!(harness.ctx);
  await plugin.definition.onConfigChanged!(config, { companyId: COMPANY });
  await harness.ctx.state.set(
    { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.volumeProfiles },
    { profiles: PROFILES, signals: NO_ESCALATION },
  );
  harness.ctx.db.query = (async (query: string) => {
    if (query.includes("join agents a") && query.includes("adapterConfig'->>'model' is not null")) {
      return [{ id: ISSUE, identifier: ISSUE, status: "in_progress", updated_at: new Date(NOW).toISOString() }];
    }
    return [];
  }) as typeof harness.ctx.db.query;
  return harness;
}

async function outage(harness: Awaited<ReturnType<typeof boot>>, lanes: string[]) {
  await harness.ctx.state.set(
    { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.laneOutage },
    { lanes, models: [], until: new Date(NOW + 3_600_000).toISOString(), reason: "test outage" },
  );
}

function tierLabel(tier: Tier) {
  return { id: `label-${tier}`, companyId: COMPANY, name: `tier:${tier}`, color: "#000", createdAt: new Date(0), updatedAt: new Date(0) };
}

async function pinned(harness: Awaited<ReturnType<typeof boot>>) {
  const card = await harness.ctx.issues.get(ISSUE, COMPANY);
  return (card?.assigneeAdapterOverrides as { adapterConfig?: { model?: string } } | null)?.adapterConfig?.model;
}

for (const path of ["scheduled", "reactive"] as const) {
  describe(`${path} tier-safe repin`, () => {
    async function run(harness: Awaited<ReturnType<typeof boot>>) {
      if (path === "scheduled") {
        await harness.ctx.state.set(
          { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.laneLedger },
          { "lane-dead": { laneId: "lane-dead", verdict: {
            laneId: "lane-dead", state: "exhausted", serviceable: false,
            serviceableAccountCount: 0, accounts: [], knownAccountCount: 1, knownWeight: 1,
          } } },
        );
        await harness.runJob("repinPass");
      } else {
        // Error-code-only rejection exercises the handler's lazy fallbackModelId attribution.
        await harness.emit("agent.run.failed", { issueId: ISSUE, errorCode: "usage_limit_reached" }, { companyId: COMPANY });
      }
    }

    it("retains the pinned T1 requirement despite a T3 assignee and a dead incumbent lane", async () => {
      const harness = await boot(roster("T1", "T2"));
      await run(harness);
      expect(await pinned(harness)).toBe(normal);
      expect(harness.activity.some((entry) => entry.message.includes("re-pinned"))).toBe(true);
      const after = await harness.ctx.issues.get(ISSUE, COMPANY);
      expect(after?.assigneeAdapterOverrides).toMatchObject({ adapterConfig: { env: { KEEP: "binding" } } });
    });

    it("does not select weaker glm or fallback-only swe when no T1 replacement qualifies", async () => {
      const harness = await boot(roster("T2", "T2"));
      await run(harness);
      expect(await pinned(harness)).toBe(incumbent);
      expect(harness.activity.filter((entry) => entry.message.includes("re-pinned"))).toHaveLength(0);
    });

    it("prefers qualified normal over a cheaper qualified fallback", async () => {
      const harness = await boot(roster());
      await run(harness);
      expect(await pinned(harness)).toBe(normal);
    });

    it("permits a qualified fallback when normal is out; weaker normal does not suppress it", async () => {
      const harness = await boot(roster());
      await outage(harness, ["lane-normal"]);
      if (path === "scheduled") await outage(harness, ["lane-normal", "lane-dead"]);
      if (path === "scheduled") await harness.runJob("repinPass");
      else await run(harness);
      expect(await pinned(harness)).toBe(fallback);
    });

    it("walks the qualified normal ladder before considering fallback-only at the required rung", async () => {
      const models = roster().map((model) => model.id === incumbent || model.id === fallback ? { ...model, tier: "T2" as const } : model);
      const harness = await boot(models, { labels: [tierLabel("T2")] });
      await run(harness);
      expect(await pinned(harness)).toBe(normal);
    });

    it("retains harness compatibility when only Devin could satisfy T1", async () => {
      const harness = await boot(roster("T2"), {}, "claude_local");
      await run(harness);
      expect(await pinned(harness)).toBe(incumbent);
    });

    it.each([
      { checkoutRunId: "live-run" },
      { executionRunId: "queued-run" },
      { labels: [{ ...tierLabel("T1"), name: "pin:operator" }] },
    ])("does not touch active or manually pinned work: %j", async (protectedFields) => {
      const harness = await boot(roster(), protectedFields);
      await run(harness);
      expect(await pinned(harness)).toBe(incumbent);
    });
  });
}

describe("scheduled effective-tier backstops", () => {
  it("repairs a fresh weaker pin after a T1 label, even with pacing off", async () => {
    const harness = await boot(roster().filter((model) => model.id !== incumbent), {
      labels: [tierLabel("T1")], assigneeAdapterOverrides: { adapterConfig: { model: weak } },
    }, "codex_local", "off");
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.pinPinnedAt },
      { [ISSUE]: new Date(NOW).toISOString() },
    );
    await harness.runJob("repinPass");
    expect(await pinned(harness)).toBe(normal);
  });
});
