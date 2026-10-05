import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

import { PLUGIN_STATE_KEYS, type Tier } from "../src/constants.js";
import type { ModelScore } from "../src/engine/types.js";
import manifest from "../src/manifest.js";
import { createPlugin } from "../src/worker.js";
import type { ModelEntry } from "../src/engine/types.js";
import { MODELS, NO_ESCALATION, NOW, PROFILES } from "./fixtures.js";

const COMPANY = "co-1";
const ISSUE = "fallback-card";
const OTHER = "other-card";
const incumbent = "claude-opus-5";
const normal = "claude-sonnet-5";
const weak = "glm-5.3-flash";
const fallback = "devin/swe-2";
const fallback2 = "devin/swe-2-cheap";

function roster(): ModelEntry[] {
  const base = MODELS.find((model) => model.id === incumbent)!;
  return [
    { ...base, laneId: "lane-dead", contextWindow: 200_000 },
    { ...base, id: normal, tier: "T1" as const, laneId: "lane-normal", contextWindow: 200_000 },
    { ...base, id: weak, tier: "T3" as const, laneId: "lane-weak", contextWindow: 200_000, costPerMTokIn: 0.1 },
    { ...base, id: fallback, tier: "T1" as const, laneId: "lane-fallback", contextWindow: 200_000, fallbackOnly: true, costPerMTokIn: 0.01 },
  ];
}

function twoFallbackRoster(): ModelEntry[] {
  const base = MODELS.find((model) => model.id === incumbent)!;
  return [
    ...roster(),
    { ...base, id: fallback2, tier: "T1" as const, laneId: "lane-fallback2", contextWindow: 200_000, fallbackOnly: true, costPerMTokIn: 0.001 },
  ];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

function card(id: string, pinnedModel: string, cardOverrides: Partial<Issue> = {}): Issue {
  return {
    id, companyId: COMPANY, title: "Engineering hotfix", priority: "critical", status: "in_progress",
    assigneeAgentId: "agent-1", assigneeUserId: null, checkoutRunId: null, executionRunId: null,
    labels: [], labelIds: [], assigneeAdapterOverrides: { adapterConfig: { model: pinnedModel } },
    ...cardOverrides,
  } as unknown as Issue;
}

async function boot(
  models: ModelEntry[],
  cards: Issue[],
  adapterType = "codex_local",
  pacingMode = "enforce",
) {
  const config = {
    models,
    classification: { enabled: true },
    selection: { enabled: true, mode: "enforce", defaultTier: "T3", fleetContextCeilingTokens: 200_000 },
    pacing: { mode: pacingMode },
  };
  const harness = createTestHarness({ manifest, config });
  harness.seed({
    issues: cards, companies: [{ id: COMPANY, name: "Co" } as never],
    agents: [{ id: "agent-1", companyId: COMPANY, name: "Engineer", adapterType, adapterConfig: { model: weak, env: { KEEP: "binding" } } } as never],
  });
  const plugin = createPlugin();
  await plugin.definition.setup!(harness.ctx);
  await plugin.definition.onConfigChanged!(config, { companyId: COMPANY });
  await harness.ctx.state.set(
    { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.volumeProfiles },
    { profiles: PROFILES, signals: NO_ESCALATION },
  );
  const ids = new Set(cards.map((entry) => entry.id));
  harness.ctx.db.query = (async (query: string) => {
    if (query.includes("join agents a") && query.includes("adapterConfig'->>'model' is not null")) {
      return [...ids].map((id) => {
        const seeded = cards.find((entry) => entry.id === id)!;
        return { id, identifier: id, status: String(seeded.status ?? "in_progress"), updated_at: new Date(NOW).toISOString() };
      });
    }
    return [];
  }) as typeof harness.ctx.db.query;
  return harness;
}

/** A fresh (non-expired) pin stamp, so the run exercises the recovery branch rather than the expiry path. */
async function freshPin(harness: Awaited<ReturnType<typeof boot>>, id: string) {
  await harness.ctx.state.set(
    { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.pinPinnedAt },
    { [id]: new Date(NOW).toISOString() },
  );
}

async function deadLane(harness: Awaited<ReturnType<typeof boot>>, laneId = "lane-dead") {
  await harness.ctx.state.set(
    { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.laneLedger },
    { [laneId]: { laneId, verdict: {
      laneId, state: "exhausted", serviceable: false,
      serviceableAccountCount: 0, accounts: [], knownAccountCount: 1, knownWeight: 1,
    } } },
  );
}

async function outage(harness: Awaited<ReturnType<typeof boot>>, lanes: string[]) {
  await harness.ctx.state.set(
    { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.laneOutage },
    { lanes, models: [], until: new Date(NOW + 3_600_000).toISOString(), reason: "test outage" },
  );
}

function incapableScores(modelId: string, tier: Tier): ModelScore {
  const dead = {
    n: 40, ok: 5, failInfra: 5, failModel: 30, tmo: 0, nEff: 20, pObs: 0.1, p: 0.1,
    capable: false, proven: true, costPerSuccessUsd: 99, medMin: 60, rework: 30,
  };
  const live = { ...dead, ok: 35, failModel: 0, pObs: 0.9, p: 0.9, capable: true as const, proven: false };
  return {
    modelId, aaIndex: null, priorP: 0.5,
    tiers: { T1: { ...live }, T2: { ...live }, T3: { ...live }, [tier]: { ...dead } } as ModelScore["tiers"],
    overall: { ...live },
  };
}

async function pinned(harness: Awaited<ReturnType<typeof boot>>, id: string) {
  const entry = await harness.ctx.issues.get(id, COMPANY);
  return (entry?.assigneeAdapterOverrides as { adapterConfig?: { model?: string } } | null)?.adapterConfig?.model;
}

function repinsOf(harness: Awaited<ReturnType<typeof boot>>, id: string) {
  return harness.activity.filter(
    (entry) => entry.message.includes("re-pinned") && entry.entityId === id,
  );
}

for (const path of ["scheduled", "reactive"] as const) {
  describe(`${path} fallback recovery`, () => {
    async function run(harness: Awaited<ReturnType<typeof boot>>, emitFor = ISSUE) {
      if (path === "scheduled") {
        await deadLane(harness);
        await harness.runJob("repinPass");
      } else {
        // OTHER rides the incumbent's dead lane: its rejection quarantines
        // lane-dead and triggers the full-sweep caller, which must then move
        // the fallback-pinned card back through the same repin rule.
        await deadLane(harness);
        await harness.emit("agent.run.failed", { issueId: emitFor, errorCode: "usage_limit_reached" }, { companyId: COMPANY });
      }
    }

    it("moves a fresh fallback pin back to a recovered normal lane", async () => {
      const harness = await boot(roster(), [card(ISSUE, fallback), card(OTHER, incumbent)]);
      await freshPin(harness, ISSUE);
      await run(harness, OTHER);
      expect(await pinned(harness, ISSUE)).toBe(normal);
      const repins = repinsOf(harness, ISSUE);
      expect(repins).toHaveLength(1);
      expect(repins[0]?.message).toContain("serviceable again");
      const after = await harness.ctx.issues.get(ISSUE, COMPANY);
      // the pin carries only plugin-owned keys. KEEP stays on the
      // agent record — the run resolves it from the base env under the
      // per-key merge — so it must NOT appear in the pin.
      expect((after?.assigneeAdapterOverrides as { adapterConfig: { env?: Record<string, unknown> } })?.adapterConfig.env)
        .not.toHaveProperty("KEEP");
    });

    it("holds the fallback while every normal lane is still down", async () => {
      const harness = await boot(roster(), [card(ISSUE, fallback), card(OTHER, incumbent)]);
      await freshPin(harness, ISSUE);
      await outage(harness, ["lane-normal"]);
      if (path === "scheduled") {
        await deadLane(harness);
        await harness.runJob("repinPass");
      } else {
        // OTHER's rejection quarantines lane-dead (unioned with the
        // lane-normal outage), so the sweep genuinely runs against a board
        // with no serviceable normal — and must still hold the fallback.
        await harness.emit("agent.run.failed", { issueId: OTHER, errorCode: "usage_limit_reached" }, { companyId: COMPANY });
      }
      expect(await pinned(harness, ISSUE)).toBe(fallback);
      expect(repinsOf(harness, ISSUE)).toHaveLength(0);
    });

    it("never moves sideways to another fallback-only row", async () => {
      const harness = await boot(twoFallbackRoster(), [card(ISSUE, fallback), card(OTHER, incumbent)]);
      // No fresh stamp: an EXPIRED pin always pays for advise, so advise
      // genuinely returns the cheaper fallback-only row here — the exact
      // shape the sideways guard must refuse. (With a fresh stamp the
      // usability `continue` holds before advise ever runs, which the
      // holds-the-fallback test above already covers.)
      await outage(harness, ["lane-normal"]);
      if (path === "scheduled") {
        await deadLane(harness);
        await harness.runJob("repinPass");
      } else {
        await harness.emit("agent.run.failed", { issueId: OTHER, errorCode: "usage_limit_reached" }, { companyId: COMPANY });
      }
      // A cheaper fallback-only row qualifies, but recovery means a normal
      // lane — the pin must not churn to it.
      expect(await pinned(harness, ISSUE)).toBe(fallback);
      expect(repinsOf(harness, ISSUE)).toHaveLength(0);
    });

    it("refuses the move when telemetry marks the normal incapable", async () => {
      const harness = await boot(roster(), [card(ISSUE, fallback), card(OTHER, incumbent)]);
      await freshPin(harness, ISSUE);
      await harness.ctx.state.set(
        { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.modelScores },
        { modelScores: [incapableScores(normal, "T1")], cardLedger: {}, computedAt: new Date(NOW).toISOString() },
      );
      await run(harness, OTHER);
      expect(await pinned(harness, ISSUE)).toBe(fallback);
      expect(repinsOf(harness, ISSUE)).toHaveLength(0);
    });

    it("refuses the move when only a weaker-tier normal survives", async () => {
      const models = roster().map((model) => model.id === normal ? { ...model, tier: "T2" as const } : model);
      const harness = await boot(models, [card(ISSUE, fallback), card(OTHER, incumbent)]);
      await freshPin(harness, ISSUE);
      await run(harness, OTHER);
      expect(await pinned(harness, ISSUE)).toBe(fallback);
      expect(repinsOf(harness, ISSUE)).toHaveLength(0);
    });

    it("re-validates an expired fallback pin through the same guarded path", async () => {
      const harness = await boot(roster(), [card(ISSUE, fallback), card(OTHER, incumbent)]);
      await run(harness, OTHER);
      expect(await pinned(harness, ISSUE)).toBe(normal);
      expect(repinsOf(harness, ISSUE)[0]?.message).toContain("pin expired, re-validated");
    });

    it.each([
      { checkoutRunId: "live-run" },
      { executionRunId: "queued-run" },
      { labels: [{ id: "label-pin", companyId: COMPANY, name: "pin:operator", color: "#000", createdAt: new Date(0), updatedAt: new Date(0) }] },
    ])("does not touch active or manually pinned fallback work: %j", async (protectedFields) => {
      const harness = await boot(roster(), [card(ISSUE, fallback, protectedFields)]);
      await freshPin(harness, ISSUE);
      if (path === "scheduled") {
        await deadLane(harness);
        await harness.runJob("repinPass");
      } else {
        await harness.emit("agent.run.failed", { issueId: ISSUE, errorCode: "usage_limit_reached" }, { companyId: COMPANY });
      }
      expect(await pinned(harness, ISSUE)).toBe(fallback);
      expect(repinsOf(harness, ISSUE)).toHaveLength(0);
    });
  });
}
