import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { planApply, planEnvRepair } from "../src/actuate/apply.js";
import { PLUGIN_STATE_KEYS, TOOL_NAMES } from "../src/constants.js";
import { staleOverrideSecretRefKeys } from "../src/engine/context.js";
import { selectModel } from "../src/engine/select.js";
import type { ModelEntry } from "../src/engine/types.js";
import manifest from "../src/manifest.js";
import { createPlugin } from "../src/worker.js";
import { MODELS, NO_ESCALATION, NOW, PROFILES, config } from "./fixtures.js";

/**
 * /  Class B. An override env replaces the assignee env
 * wholesale, and the host refuses a run whose merged env names a secret ref the
 * run's agent holds no binding for. A pin that snapshotted such a ref failed
 * every wake as `configuration_incomplete` until a human cleared it.
 */

const ref = (secretId: string, version: unknown = "latest") => ({ type: "secret_ref", secretId, version });
const userRef = (key: string, extra: Record<string, unknown> = {}) => ({ type: "user_secret_ref", key, version: "latest", ...extra });

describe("staleOverrideSecretRefKeys", () => {
  it("reports nothing when the assignee env is UNKNOWN", () => {
    expect(staleOverrideSecretRefKeys({ GH: ref("old") }, null)).toEqual([]);
    expect(staleOverrideSecretRefKeys({ GH: ref("old") }, undefined)).toEqual([]);
  });

  it("reports a ref the agent binds to a different secret, or not at all", () => {
    expect(
      staleOverrideSecretRefKeys({ B: ref("gone"), A: ref("old") }, { A: ref("new") }),
    ).toEqual(["A", "B"]);
  });

  it("does not report a ref the agent binds to the same secret at another version", () => {
    expect(staleOverrideSecretRefKeys({ A: ref("s1", 3) }, { A: ref("s1", "latest") })).toEqual([]);
  });

  it("ignores plain values: they need no binding", () => {
    expect(staleOverrideSecretRefKeys({ P: { type: "plain", value: "x" }, Q: "raw" }, {})).toEqual([]);
  });

  it("compares user_secret_ref by key, and skips refs the host never enforces", () => {
    expect(staleOverrideSecretRefKeys({ U: userRef("k1") }, { U: userRef("k1", { version: 2 }) })).toEqual([]);
    expect(staleOverrideSecretRefKeys({ U: userRef("k1") }, { U: userRef("k2") })).toEqual(["U"]);
    expect(staleOverrideSecretRefKeys({ U: userRef("k1", { required: false }) }, {})).toEqual([]);
    expect(staleOverrideSecretRefKeys({ U: userRef("k1", { allowMissingOverride: true }) }, {})).toEqual([]);
  });

  it("skips a malformed ref: the host's schema parse never checks it", () => {
    expect(staleOverrideSecretRefKeys({ M: { type: "secret_ref" } }, {})).toEqual([]);
    expect(staleOverrideSecretRefKeys({ M: { type: "secret_ref", secretId: "" } }, {})).toEqual([]);
  });

  it("does not confuse the two ref types that share an id string", () => {
    expect(staleOverrideSecretRefKeys({ X: ref("same") }, { X: userRef("same") })).toEqual(["X"]);
  });
});

describe("planApply env repair", () => {
  const base = { profiles: PROFILES, signals: NO_ESCALATION, now: NOW };
  const decide = (enforce = true) =>
    selectModel({ ...base, descriptor: { issueId: "i1", labelNames: ["tier:T1"] }, config: config({ enforcementEnabled: enforce }) });
  const pinned = { hasExistingOverride: true, hasExistingTierLabel: true, status: "in_progress" };
  const repair = { pinnedModelId: "claude-sonnet-5", staleSecretRefKeys: ["GH_TOKEN_REF"] };

  it("rewrites the env on the PINNED model, never the decision's", () => {
    const decision = decide();
    expect(decision.modelId).toBe("claude-opus-5");
    const plan = planApply(decision, { ...pinned, envRepair: repair }, "i1");
    expect(plan).toMatchObject({ write: true, envRepairOnly: true, modelId: "claude-sonnet-5", labelName: null });
    expect(plan.reason).toContain("GH_TOKEN_REF");
    expect(plan.reason).toContain("prompt cache");
  });

  it("still refuses a model-changing repin while an override exists", () => {
    for (const envRepair of [undefined, { ...repair, staleSecretRefKeys: [] }, { ...repair, pinnedModelId: null }]) {
      const plan = planApply(decide(), { ...pinned, ...(envRepair ? { envRepair } : {}) }, "i1");
      expect(plan.write).toBe(false);
      expect(plan.envRepairOnly).toBe(false);
      expect(plan.reason).toContain("prompt cache");
    }
  });

  it("writes nothing in advisory mode", () => {
    const plan = planApply(decide(false), { ...pinned, envRepair: repair }, "i1");
    expect(plan.write).toBe(false);
    expect(plan.reason).toContain("advisory");
  });

  it("repairs finished work: comments still wake a done card", () => {
    for (const status of ["done", "cancelled"]) {
      const plan = planApply(decide(), { ...pinned, status, envRepair: repair }, "i1");
      expect(plan).toMatchObject({ write: true, envRepairOnly: true, modelId: "claude-sonnet-5" });
    }
  });

  it("is a fallback: a writing pin path wins and rebuilds the env itself", () => {
    const fresh = planApply(decide(), { ...pinned, hasExistingOverride: false, envRepair: repair }, "i1");
    expect(fresh).toMatchObject({ write: true, envRepairOnly: false, modelId: "claude-opus-5" });
    const paceRepin = planApply(
      decide(),
      {
        ...pinned,
        envRepair: repair,
        paceRepin: {
          hasOperatorPin: false, isIdle: true, lastRepinAt: null, now: new Date(NOW).toISOString(),
          idleRepinHysteresisSeconds: 900, isServiceabilityHardStop: false,
        },
      },
      "i1",
    );
    expect(paceRepin).toMatchObject({ write: true, envRepairOnly: false, modelId: "claude-opus-5" });
  });

  it("planEnvRepair plans nothing without a pin or a stale key", () => {
    expect(planEnvRepair({ pinnedModelId: null, staleSecretRefKeys: ["A"] }, "i1")).toBeNull();
    expect(planEnvRepair({ pinnedModelId: "claude-sonnet-5", staleSecretRefKeys: [] }, "i1")).toBeNull();
  });
});

const COMPANY = "co-1";
const ISSUE = "poisoned-card";
const PIN = "claude-sonnet-5";
const AGENT_ENV = { KEEP: ref("agent-secret"), PLAIN: { type: "plain", value: "1" } };
const runCtx = { companyId: COMPANY, agentId: "agent-1", runId: "run-1" };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

function roster(): ModelEntry[] {
  const base = MODELS.find((model) => model.id === "claude-opus-5")!;
  return [
    { ...base, laneId: "lane-a", contextWindow: 200_000 },
    { ...base, id: PIN, tier: "T1" as const, laneId: "lane-b", contextWindow: 200_000 },
  ];
}

function card(overrideEnv: Record<string, unknown>, fields: Partial<Issue> = {}): Issue {
  return {
    id: ISSUE, companyId: COMPANY, title: "Engineering hotfix", priority: "critical", status: "in_progress",
    assigneeAgentId: "agent-1", assigneeUserId: null, checkoutRunId: null, executionRunId: null,
    labels: [], labelIds: [], assigneeAdapterOverrides: { adapterConfig: { model: PIN, env: overrideEnv } },
    ...fields,
  } as unknown as Issue;
}

async function boot(issue: Issue, mode = "enforce") {
  const pluginConfig = {
    models: roster(),
    classification: { enabled: true },
    selection: { enabled: true, mode, defaultTier: "T3", fleetContextCeilingTokens: 200_000 },
    pacing: { mode: "off" },
  };
  const harness = createTestHarness({ manifest, config: pluginConfig });
  harness.seed({
    issues: [issue], companies: [{ id: COMPANY, name: "Co" } as never],
    agents: [{ id: "agent-1", companyId: COMPANY, name: "Engineer", adapterType: "codex_local", adapterConfig: { model: PIN, env: AGENT_ENV } } as never],
  });
  const plugin = createPlugin();
  await plugin.definition.setup!(harness.ctx);
  await plugin.definition.onConfigChanged!(pluginConfig, { companyId: COMPANY });
  await harness.ctx.state.set(
    { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.volumeProfiles },
    { profiles: PROFILES, signals: NO_ESCALATION },
  );
  harness.ctx.db.query = (async () => []) as typeof harness.ctx.db.query;
  return harness;
}

async function override(harness: Awaited<ReturnType<typeof boot>>) {
  const issue = await harness.ctx.issues.get(ISSUE, COMPANY);
  return (issue?.assigneeAdapterOverrides as { adapterConfig: { model: string; env: Record<string, unknown> } }).adapterConfig;
}

const repairs = (harness: Awaited<ReturnType<typeof boot>>) =>
  harness.activity.filter((entry) => entry.message.includes("repaired the env") && entry.entityId === ISSUE);

const failConfig = (harness: Awaited<ReturnType<typeof boot>>, errorCode = "configuration_incomplete") =>
  harness.emit("agent.run.failed", { issueId: ISSUE, runId: "run-9", errorCode, error: "missing binding" }, { companyId: COMPANY });

describe("a configuration_incomplete run failure heals a poisoned pin", () => {
  const poisoned = { STALE: ref("former-assignee-secret"), KEEP: ref("agent-secret") };

  it("rebuilds the env from the assignee on the same model", async () => {
    const harness = await boot(card(poisoned));
    await failConfig(harness);
    const after = await override(harness);
    expect(after.model).toBe(PIN);
    expect(after.env).not.toHaveProperty("STALE");
    expect(after.env).toMatchObject(AGENT_ENV);
    expect(staleOverrideSecretRefKeys(after.env, AGENT_ENV)).toEqual([]);
    expect(repairs(harness)).toHaveLength(1);
    expect(repairs(harness)[0]?.metadata).toMatchObject({ modelId: PIN, staleSecretRefKeys: ["STALE"], runId: "run-9" });
  });

  it("is idempotent: a second failure writes nothing", async () => {
    const harness = await boot(card(poisoned));
    await failConfig(harness);
    await failConfig(harness);
    expect(repairs(harness)).toHaveLength(1);
  });

  it("heals a done card too", async () => {
    const harness = await boot(card(poisoned, { status: "done" }));
    await failConfig(harness);
    expect((await override(harness)).env).not.toHaveProperty("STALE");
  });

  it("writes nothing in shadow mode", async () => {
    const harness = await boot(card(poisoned), "shadow");
    await failConfig(harness);
    expect((await override(harness)).env).toHaveProperty("STALE");
    expect(repairs(harness)).toHaveLength(0);
  });

  it("writes nothing when every override ref is one the assignee carries", async () => {
    const harness = await boot(card({ KEEP: ref("agent-secret") }));
    await failConfig(harness);
    expect(repairs(harness)).toHaveLength(0);
  });

  it("ignores other failure codes", async () => {
    const harness = await boot(card(poisoned));
    await failConfig(harness, "adapter_failed");
    expect((await override(harness)).env).toHaveProperty("STALE");
    expect(repairs(harness)).toHaveLength(0);
  });
});

describe("the apply tool repairs instead of refusing", () => {
  it("repairs a poisoned pin through apply and keeps the model", async () => {
    const harness = await boot(card({ STALE: ref("former-assignee-secret") }));
    const result = (await harness.executeTool(TOOL_NAMES.apply, { issueId: ISSUE }, runCtx)) as {
      data: { plan: { write: boolean; envRepairOnly: boolean; modelId: string } };
    };
    expect(result.data.plan).toMatchObject({ write: true, envRepairOnly: true, modelId: PIN });
    const after = await override(harness);
    expect(after.model).toBe(PIN);
    expect(after.env).not.toHaveProperty("STALE");
    expect(repairs(harness)).toHaveLength(1);
    expect(harness.activity.filter((entry) => entry.message.includes("pinned"))).toHaveLength(0);
  });

  it("still refuses a healthy pin", async () => {
    const harness = await boot(card({ KEEP: ref("agent-secret") }));
    const result = (await harness.executeTool(TOOL_NAMES.apply, { issueId: ISSUE }, runCtx)) as {
      data: { plan: { write: boolean } };
    };
    expect(result.data.plan.write).toBe(false);
    expect(repairs(harness)).toHaveLength(0);
  });
});
