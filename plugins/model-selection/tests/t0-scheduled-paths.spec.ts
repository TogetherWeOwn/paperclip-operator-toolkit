import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import manifest from "../src/manifest.js";
import { PLUGIN_STATE_KEYS } from "../src/constants.js";
import { createPlugin } from "../src/worker.js";
import type { ModelEntry, VolumeProfile } from "../src/engine/types.js";
import { FRESH, MODELS, NO_ESCALATION, NOW, PROFILES } from "./fixtures.js";

/**
 * The scheduled passes and the wake-time tools share `selectModel`'s
 * T0 boundary, but each builds its own descriptor first. These pin that no pass
 * hands a card a T0 opt-in it did not carry, and that none drops one it did.
 */

const COMPANY = "co-1";
const AGENT = "agent-1";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

const T0_PROFILE: VolumeProfile = {
  tier: "T0",
  sampleCount: 40,
  computedAt: FRESH,
  avgInputTokens: 510_327,
  avgCacheReadTokens: 6_081_872,
  avgOutputTokens: 55_532,
};

const T0_MODEL: ModelEntry = {
  ...MODELS.find((entry) => entry.id === "claude-opus-5")!,
  id: "claude-opus-5-5",
  tier: "T0",
  // Dearer than every T1 row, as the real S-tier rows are: the cost race alone
  // would never pick it, so a pick can only come from admission.
  costPerMTokIn: 10,
  costPerMTokOut: 50,
};

const ROSTER: ModelEntry[] = [...MODELS, T0_MODEL];

function agentRow() {
  return {
    id: AGENT,
    companyId: COMPANY,
    name: "Founding Engineer",
    urlKey: "founding-engineer",
    role: "general",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: { model: "claude-haiku-4-5-20251001" },
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: {},
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as never;
}

function tierLabel(tier: "T0" | "T1" | "T2" | "T3") {
  return { id: `lbl-${tier}`, companyId: COMPANY, name: `tier:${tier}`, color: "#000", createdAt: new Date(0), updatedAt: new Date(0) };
}

function issue(id: string, overrides: Partial<Issue> = {}): Issue {
  return {
    id,
    companyId: COMPANY,
    title: "A card",
    status: "in_progress",
    assigneeAgentId: AGENT,
    assigneeAdapterOverrides: null,
    checkoutRunId: null,
    executionRunId: null,
    labels: [],
    labelIds: [],
    ...overrides,
  } as unknown as Issue;
}

function baseConfig() {
  return {
    selection: { enabled: true, mode: "enforce", holdOnUntrustedProfile: true },
    models: ROSTER,
    tierLabelIds: { T0: "lbl-T0", T1: "lbl-T1", T2: "lbl-T2", T3: "lbl-T3" },
    classification: { enabled: true },
  };
}

async function boot(config: Record<string, unknown>, seedIssues: Issue[]) {
  const harness = createTestHarness({ manifest, config });
  harness.seed({ issues: seedIssues, agents: [agentRow()], companies: [{ id: COMPANY, name: "Co" } as never] });
  const plugin = createPlugin();
  const setup = plugin.definition.setup;
  if (!setup) throw new Error("plugin definition has no setup handler");
  await setup(harness.ctx);
  const onConfigChanged = plugin.definition.onConfigChanged;
  if (!onConfigChanged) throw new Error("plugin definition has no onConfigChanged handler");
  await onConfigChanged(config, { companyId: COMPANY });
  await harness.ctx.state.set(
    { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.volumeProfiles },
    { profiles: [...PROFILES, T0_PROFILE], signals: NO_ESCALATION },
  );
  return harness;
}

function idleRow(id: string) {
  return { id, identifier: id, status: "in_progress" };
}

describe("balancePass and the T0 boundary", () => {
  it("pins an unpinned tier:T0 card at T0 — the pass never pins a T0 opt-in DOWN to T1", async () => {
    const card = issue("i1", { labels: [tierLabel("T0")], labelIds: ["lbl-T0"] });
    const harness = await boot(baseConfig(), [card]);
    harness.ctx.db.query = async () => [idleRow("i1")] as never;

    await harness.runJob("balancePass");

    const after = await harness.ctx.issues.get("i1", COMPANY);
    const model = (after?.assigneeAdapterOverrides as { adapterConfig?: { model?: string } } | null)?.adapterConfig?.model;
    expect(model).toBe(T0_MODEL.id);
    expect(harness.activity[0]?.metadata?.tier).toBe("T0");
  });

  it("pins an unpinned tier:T1 card at T1 even though a T0 row exists (positive control)", async () => {
    const card = issue("i1", { labels: [tierLabel("T1")], labelIds: ["lbl-T1"] });
    const harness = await boot(baseConfig(), [card]);
    harness.ctx.db.query = async () => [idleRow("i1")] as never;

    await harness.runJob("balancePass");

    const after = await harness.ctx.issues.get("i1", COMPANY);
    const model = (after?.assigneeAdapterOverrides as { adapterConfig?: { model?: string } } | null)?.adapterConfig?.model;
    expect(model).toBe("claude-opus-5");
    expect(model).not.toBe(T0_MODEL.id);
    expect(harness.activity[0]?.metadata?.tier).toBe("T1");
  });

  it("never hands a T3 card a T0 pin", async () => {
    const card = issue("i1", { labels: [tierLabel("T3")], labelIds: ["lbl-T3"] });
    const harness = await boot(baseConfig(), [card]);
    harness.ctx.db.query = async () => [idleRow("i1")] as never;

    await harness.runJob("balancePass");

    const after = await harness.ctx.issues.get("i1", COMPANY);
    const model = (after?.assigneeAdapterOverrides as { adapterConfig?: { model?: string } } | null)?.adapterConfig?.model;
    expect(model).not.toBe(T0_MODEL.id);
  });
});

function pinnedTo(modelId: string) {
  return { adapterConfig: { model: modelId } };
}

function pinOf(after: Issue | null | undefined): string | null {
  const model = (after?.assigneeAdapterOverrides as { adapterConfig?: { model?: string } } | null)?.adapterConfig?.model;
  return model ?? null;
}

describe("pinned T0 cards in the passes", () => {
  it("keeps an idle card that carries tier:T0 on its T0 pin", async () => {
    const card = issue("i1", {
      labels: [tierLabel("T0")],
      labelIds: ["lbl-T0"],
      assigneeAdapterOverrides: pinnedTo(T0_MODEL.id) as never,
    });
    const harness = await boot(baseConfig(), [card]);
    harness.ctx.db.query = async () => [idleRow("i1")] as never;

    await harness.runJob("balancePass");

    expect(pinOf(await harness.ctx.issues.get("i1", COMPANY))).toBe(T0_MODEL.id);
  });

  it("does not count a T0 pin on a tier:T1 card as an opt-in — selection stays at T1", async () => {
    const card = issue("i1", {
      labels: [tierLabel("T1")],
      labelIds: ["lbl-T1"],
      assigneeAdapterOverrides: pinnedTo(T0_MODEL.id) as never,
    });
    const harness = await boot(baseConfig(), [card]);
    harness.ctx.db.query = async () => [idleRow("i1")] as never;

    await harness.runJob("balancePass");

    // Cost-down to T1: the pin on a T0 row is history, not an opt-in. An
    // operator who wants a card held on a T0 row labels it `tier:T0` (kept
    // above) or `pin:operator`; this is the consequence the migration handoff
    // names for cards hand-pinned to a migrated row.
    expect(pinOf(await harness.ctx.issues.get("i1", COMPANY))).toBe("claude-opus-5");
    expect(harness.activity[0]?.message).toContain("cost-down");
  });
});

describe("labelOnlyPass and the T0 boundary", () => {
  it("pins an unpinned tier:T0 card at T0", async () => {
    const card = issue("i1", { labels: [tierLabel("T0")], labelIds: ["lbl-T0"] });
    const harness = await boot(baseConfig(), [card]);
    harness.ctx.db.query = async () => [idleRow("i1")] as never;

    await harness.runJob("labelOnlyPass");

    expect(pinOf(await harness.ctx.issues.get("i1", COMPANY))).toBe(T0_MODEL.id);
    expect(harness.activity[0]?.message).toContain("label-only pinned");
  });

  it("never pins an unlabelled card at T0 — the default and the floor are not an opt-in", async () => {
    const card = issue("i1", {});
    const harness = await boot(baseConfig(), [card]);
    harness.ctx.db.query = async () => [idleRow("i1")] as never;

    await harness.runJob("labelOnlyPass");

    expect(pinOf(await harness.ctx.issues.get("i1", COMPANY))).not.toBe(T0_MODEL.id);
  });
});
