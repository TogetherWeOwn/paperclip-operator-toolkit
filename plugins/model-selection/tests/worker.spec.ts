import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { pluginManifestV1Schema } from "@paperclipai/shared/validators/plugin";
import type { Issue } from "@paperclipai/shared";
import { beforeEach, describe, expect, it } from "vitest";

import manifest from "../src/manifest.js";
import { PLUGIN_STATE_KEYS, TOOL_NAMES } from "../src/constants.js";
import { createPlugin } from "../src/worker.js";
import { MODELS, NO_ESCALATION, PROFILES } from "./fixtures.js";

const COMPANY = "co-1";
const ISSUE = "issue-1";
const AGENT = "agent-1";
const TIER_LABEL_ID = "lbl-t1";
const OTHER_LABEL_ID = "lbl-other";

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: ISSUE,
    companyId: COMPANY,
    title: "Rename a constant",
    status: "in_progress",
    assigneeAgentId: null,
    assigneeAdapterOverrides: null,
    labels: [
      { id: TIER_LABEL_ID, companyId: COMPANY, name: "tier:T1" },
      { id: OTHER_LABEL_ID, companyId: COMPANY, name: "area:platform" },
    ],
    labelIds: [TIER_LABEL_ID, OTHER_LABEL_ID],
    ...overrides,
  } as unknown as Issue;
}

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    selection: { enabled: true, mode: "advise", holdOnUntrustedProfile: true },
    models: MODELS,
    tierLabelIds: { T1: TIER_LABEL_ID },
    ...overrides,
  };
}

async function boot(
  config: Record<string, unknown>,
  seedIssue = issue(),
  agents: Parameters<ReturnType<typeof createTestHarness>["seed"]>[0]["agents"] = [],
) {
  const harness = createTestHarness({ manifest, config });
  harness.seed({ issues: [seedIssue], agents });
  // `definePlugin` returns a sealed wrapper; the lifecycle handlers live on
  // `.definition`. No optional chaining here — a missing setup must fail loudly
  // rather than leave every tool unregistered and the assertions vacuous.
  const setup = createPlugin().definition.setup;
  if (!setup) throw new Error("plugin definition has no setup handler");
  await setup(harness.ctx);
  // Seed the volume profiles the engine refuses to act without.
  await harness.ctx.state.set(
    { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.volumeProfiles },
    { profiles: PROFILES, signals: NO_ESCALATION },
  );
  return harness;
}

const runCtx = { companyId: COMPANY, agentId: "agent-1", runId: "run-1" };

describe("worker", () => {
  let harness: Awaited<ReturnType<typeof boot>>;

  beforeEach(async () => {
    harness = await boot(baseConfig());
  });

  it("ships a manifest the host's own validator accepts", () => {
    // This is the install gate. It caught a camelCase routeKey and a missing
    // database.namespace.migrate capability that unit tests could not see.
    const result = pluginManifestV1Schema.safeParse(manifest);
    expect(result.success).toBe(true);
  });

  it("advises a model without writing anything", async () => {
    const result = await harness.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);
    const decision = (result as { data: { modelId: string; advisory: boolean } }).data;
    expect(decision.modelId).toBe("claude-opus-5");
    expect(decision.advisory).toBe(true);
    expect(harness.activity).toHaveLength(0);
  });

  it("writes nothing in advise mode even from the apply tool", async () => {
    const result = await harness.executeTool(TOOL_NAMES.apply, { issueId: ISSUE }, runCtx);
    expect((result as { content: string }).content).toContain("No write");
    expect(harness.activity).toHaveLength(0);
    const after = await harness.ctx.issues.get(ISSUE, COMPANY);
    expect(after?.assigneeAdapterOverrides ?? null).toBeNull();
  });

  it("pins the model and preserves unrelated labels when enforcing", async () => {
    // The issue already carries tier:T1, so no label is added — but the write
    // must still not disturb the labels that are there.
    const enforcing = await boot(baseConfig({ selection: { enabled: true, mode: "enforce" } }));
    await enforcing.executeTool(TOOL_NAMES.apply, { issueId: ISSUE }, runCtx);

    const after = await enforcing.ctx.issues.get(ISSUE, COMPANY);
    expect(after?.assigneeAdapterOverrides).toEqual({
      adapterConfig: { model: "claude-opus-5" },
    });
    expect(enforcing.activity).toHaveLength(1);
    expect(enforcing.activity[0]?.metadata?.tierSource).toBe("issue-label");
  });

  it("pins excluded work to T1 even when the assignee floor is T3", async () => {
    const excluded = issue({
      assigneeAgentId: AGENT,
      labels: [{ id: OTHER_LABEL_ID, companyId: COMPANY, name: "area:platform" }],
      labelIds: [OTHER_LABEL_ID],
    } as unknown as Partial<Issue>);
    const enforcing = await boot(
      baseConfig({ selection: { enabled: true, mode: "enforce" } }),
      excluded,
      [
        {
          id: AGENT,
          companyId: COMPANY,
          name: "Mechanical worker",
          urlKey: "mechanical-worker",
          role: "general",
          title: null,
          icon: null,
          status: "active",
          reportsTo: null,
          capabilities: null,
          adapterType: "claude_local",
          adapterConfig: { model: "cliproxy/claude-haiku-4-5-20251001" },
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
        } as never,
      ],
    );

    await enforcing.executeTool(
      TOOL_NAMES.apply,
      { issueId: ISSUE, exclusion: { excluded: true, reasons: ["credential access"] } },
      runCtx,
    );

    const after = await enforcing.ctx.issues.get(ISSUE, COMPANY);
    expect(after?.assigneeAdapterOverrides).toEqual({
      adapterConfig: { model: "claude-opus-5" },
    });
    expect(new Set(after?.labelIds ?? [])).toEqual(new Set([OTHER_LABEL_ID, TIER_LABEL_ID]));
    expect(enforcing.activity[0]?.metadata?.tierSource).toBe("capability-exclusion");
  });

  it("unions the tier label with the labels already on the issue", async () => {
    // `issues.update` REPLACES the label set (issues.ts:4835-4852). An issue
    // with no tier label yet must come out with BOTH labels, not just the new
    // one — this is the regression that would silently strip board metadata.
    const unlabelled = issue({
      labels: [{ id: OTHER_LABEL_ID, companyId: COMPANY, name: "area:platform" }],
      labelIds: [OTHER_LABEL_ID],
    } as unknown as Partial<Issue>);
    const enforcing = await boot(
      baseConfig({
        selection: { enabled: true, mode: "enforce", defaultTier: "T1" },
      }),
      unlabelled,
    );

    await enforcing.executeTool(TOOL_NAMES.apply, { issueId: ISSUE }, runCtx);
    const after = await enforcing.ctx.issues.get(ISSUE, COMPANY);
    expect(new Set(after?.labelIds ?? [])).toEqual(new Set([OTHER_LABEL_ID, TIER_LABEL_ID]));
  });

  it("never re-pins an issue that already carries an override", async () => {
    // A mid-flight model change resets the session and discards the warm prompt
    // cache — the single largest cost line we have.
    const pinned = issue({
      assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
    } as unknown as Partial<Issue>);
    const enforcing = await boot(
      baseConfig({ selection: { enabled: true, mode: "enforce" } }),
      pinned,
    );

    const result = await enforcing.executeTool(TOOL_NAMES.apply, { issueId: ISSUE }, runCtx);
    expect((result as { content: string }).content).toContain("already carries");
    const after = await enforcing.ctx.issues.get(ISSUE, COMPANY);
    expect(after?.assigneeAdapterOverrides).toEqual({ adapterConfig: { model: "claude-opus-5" } });
    expect(enforcing.activity).toHaveLength(0);
  });

  it("writes the override without a label when no label id is configured", async () => {
    const unlabelled = issue({
      labels: [{ id: OTHER_LABEL_ID, companyId: COMPANY, name: "area:platform" }],
      labelIds: [OTHER_LABEL_ID],
    } as unknown as Partial<Issue>);
    const enforcing = await boot(
      {
        selection: { enabled: true, mode: "enforce", defaultTier: "T1" },
        models: MODELS,
      },
      unlabelled,
    );

    const result = await enforcing.executeTool(TOOL_NAMES.apply, { issueId: ISSUE }, runCtx);
    expect((result as { content: string }).content).toContain("no configured label id");
    const after = await enforcing.ctx.issues.get(ISSUE, COMPANY);
    expect(after?.assigneeAdapterOverrides).not.toBeNull();
  });

  it("reports a missing issue rather than throwing", async () => {
    const result = await harness.executeTool(TOOL_NAMES.advise, { issueId: "nope" }, runCtx);
    expect((result as { content: string }).content).toContain("not found");
  });

  it("queries only the allowlisted table when refreshing volume profiles", async () => {
    harness.seed({ companies: [{ id: COMPANY, name: "Co" } as never] });
    await harness.runJob("refreshVolumeProfiles");
    for (const q of harness.dbQueries) {
      expect(q.sql).toContain("heartbeat_runs");
      // `labels` is absent from PLUGIN_DATABASE_CORE_READ_TABLES; a query
      // against it would be rejected by assertAllowedPublicRead at runtime.
      expect(q.sql).not.toMatch(/\bfrom\s+labels\b/i);
    }
  });
});
