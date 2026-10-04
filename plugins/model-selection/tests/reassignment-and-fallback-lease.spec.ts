import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FALLBACK_LEASE_EXAMINE_LIMIT,
  FALLBACK_LEASE_WRITE_LIMIT,
  FALLBACK_PIN_INDEX_MAX,
  OPERATOR_PIN_LABEL,
  PLUGIN_STATE_KEYS,
} from "../src/constants.js";
import { PIN_PROVENANCE_ENV_KEY, readPinProvenance, type PinProvenance } from "../src/engine/context.js";
import manifest from "../src/manifest.js";
import type { ModelEntry } from "../src/engine/types.js";
import { createPlugin } from "../src/worker.js";
import { MODELS, NO_ESCALATION, NOW, PROFILES } from "./fixtures.js";

// TOG-12234 (TOG-11780 §5, §7 items 3-4): an agent-to-agent reassignment
// re-homes the pin's env, and a pin on a fallback-only model is stamped,
// indexed and released once a regular model can take the card again.

const COMPANY = "co-1";
const ISSUE = "card-1";
const AGENT_A = "agent-a";
const AGENT_B = "agent-b";
const incumbent = "claude-opus-5";
const normal = "claude-sonnet-5";
const weak = "glm-5.3-flash";
const fallback = "devin/swe-2";

function roster(): ModelEntry[] {
  const base = MODELS.find((model) => model.id === incumbent)!;
  return [
    { ...base, laneId: "lane-dead", contextWindow: 200_000 },
    { ...base, id: normal, tier: "T1", laneId: "lane-normal", contextWindow: 200_000 },
    { ...base, id: weak, tier: "T3", laneId: "lane-weak", contextWindow: 200_000, costPerMTokIn: 0.1 },
    { ...base, id: fallback, tier: "T1", laneId: "lane-fallback", contextWindow: 200_000, fallbackOnly: true, costPerMTokIn: 0.01 },
  ];
}

const A_ENV = {
  A_ONLY_TOKEN: { type: "secret_ref", key: "a_only_secret" },
  SHARED: { type: "plain", value: "from-a" },
};
const B_ENV = {
  B_ONLY_TOKEN: { type: "secret_ref", key: "b_only_secret" },
  SHARED: { type: "plain", value: "from-b" },
};

function agent(id: string, env: Record<string, unknown>) {
  return { id, companyId: COMPANY, name: id, adapterType: "codex_local", adapterConfig: { model: weak, env } } as never;
}

function stampFor(decisionId: string, agentId: string = AGENT_A): PinProvenance {
  return { decisionId, agentId, fallback: true, decidedAt: new Date(NOW - 3_600_000).toISOString() };
}

function stampEnv(stamp: PinProvenance) {
  return { [PIN_PROVENANCE_ENV_KEY]: { type: "plain", value: JSON.stringify(stamp) } };
}

function card(id: string, overrides: Partial<Issue> = {}): Issue {
  return {
    id, identifier: id, companyId: COMPANY, title: "Engineering hotfix", priority: "high", status: "todo",
    assigneeAgentId: AGENT_B, assigneeUserId: null, checkoutRunId: null, executionRunId: null,
    labels: [], labelIds: [], assigneeAdapterOverrides: null,
    ...overrides,
  } as unknown as Issue;
}

const operatorLabel = { id: "lbl-op", companyId: COMPANY, name: OPERATOR_PIN_LABEL, color: "#000", createdAt: new Date(0), updatedAt: new Date(0) };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

interface Stubs {
  /** Rows the creation-pin live-runs read returns (`pinnableBeforeStart`). */
  liveRuns?: unknown[];
  /** Issue ids the repin pass's candidate scan returns. */
  repinCandidates?: string[];
}

async function boot(
  issues: Issue[],
  agents: unknown[] = [agent(AGENT_A, A_ENV), agent(AGENT_B, B_ENV)],
  stubs: Stubs = {},
  selectionOverride: Record<string, unknown> = {},
) {
  const config = {
    models: roster(),
    classification: { enabled: true },
    selection: { enabled: true, mode: "enforce", defaultTier: "T3", fleetContextCeilingTokens: 200_000, ...selectionOverride },
    pacing: { mode: "enforce" },
  };
  const harness = createTestHarness({ manifest, config });
  harness.seed({ issues, agents: agents as never, companies: [{ id: COMPANY, name: "Co" } as never] });
  const plugin = createPlugin();
  await plugin.definition.setup!(harness.ctx);
  await plugin.definition.onConfigChanged!(config, { companyId: COMPANY });
  await harness.ctx.state.set(
    { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.volumeProfiles },
    { profiles: PROFILES, signals: NO_ESCALATION },
  );
  harness.ctx.db.query = (async (query: string) => {
    if (query.includes("status in ('queued', 'running')")) return stubs.liveRuns ?? [];
    if (query.includes("join agents a") && query.includes("adapterConfig'->>'model' is not null")) {
      return (stubs.repinCandidates ?? []).map((id) => ({ id, identifier: id, status: "in_progress", updated_at: new Date(NOW).toISOString() }));
    }
    return [];
  }) as typeof harness.ctx.db.query;
  const writes: string[] = [];
  const update = harness.ctx.issues.update.bind(harness.ctx.issues);
  harness.ctx.issues.update = (async (...args: Parameters<typeof update>) => {
    writes.push(args[0]);
    return update(...args);
  }) as typeof update;
  return { harness, writes };
}

type Harness = Awaited<ReturnType<typeof boot>>["harness"];

async function override(harness: Harness, id = ISSUE) {
  const issue = await harness.ctx.issues.get(id, COMPANY);
  return (issue?.assigneeAdapterOverrides ?? null) as { adapterConfig?: { model?: string; env?: Record<string, unknown> } } | null;
}

async function index(harness: Harness): Promise<Record<string, { decisionId: string; checkedAt: string | null }>> {
  return ((await harness.ctx.state.get({ scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.fallbackPins })) ??
    {}) as Record<string, { decisionId: string; checkedAt: string | null }>;
}

async function seedIndex(harness: Harness, entries: Record<string, PinProvenance>) {
  await harness.ctx.state.set(
    { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.fallbackPins },
    Object.fromEntries(
      Object.entries(entries).map(([id, stamp]) => [id, { decisionId: stamp.decisionId, decidedAt: stamp.decidedAt, checkedAt: null }]),
    ),
  );
}

async function outage(harness: Harness, lanes: string[]) {
  await harness.ctx.state.set(
    { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.laneOutage },
    { lanes, models: [], until: new Date(NOW + 3_600_000).toISOString(), reason: "test outage" },
  );
}

async function reassign(harness: Harness, from: unknown, to: string, id = ISSUE) {
  await harness.emit(
    "issue.updated",
    { changes: { assigneeAgentId: { from, to } } },
    { entityId: id, companyId: COMPANY, entityType: "issue" },
  );
}

const QUEUED_UNSTARTED = [{ status: "queued", started_at: null }];
const STARTED = [{ status: "running", started_at: new Date(NOW + 1_000).toISOString() }];

/** The override A's agent-built pin leaves behind: A's whole env plus the pin keys. */
function aPin(model: string, extra: Record<string, unknown> = {}) {
  return {
    adapterConfig: {
      model,
      env: { ...A_ENV, PAPERCLIP_ASSIGNED_MODEL: { type: "plain", value: model }, ...extra },
    },
  };
}

function expectNoAOnlyBinding(value: unknown) {
  const serialized = JSON.stringify(value ?? null);
  expect(serialized).not.toContain("A_ONLY_TOKEN");
  expect(serialized).not.toContain("a_only_secret");
  expect(serialized).not.toContain("from-a");
}

/** A card the lease pass examines: pinned to the fallback, stamped, indexed. */
function leaseCard(id: string, stamp: PinProvenance | null, overrides: Partial<Issue> = {}) {
  return card(id, {
    status: "in_progress",
    assigneeAgentId: AGENT_A,
    assigneeAdapterOverrides: {
      adapterConfig: { model: stamp ? fallback : normal, env: { ...A_ENV, ...(stamp ? stampEnv(stamp) : {}) } },
    },
    ...overrides,
  });
}

describe("TOG-12234 reassignment re-homes the pin env", () => {
  it("rebuilds the pin from the new assignee's env before a queued run starts", async () => {
    const { harness } = await boot([card(ISSUE, { assigneeAdapterOverrides: aPin(normal) })], undefined, {
      liveRuns: QUEUED_UNSTARTED,
    });

    await reassign(harness, AGENT_A, AGENT_B);

    const after = await override(harness);
    expect(after?.adapterConfig?.model).toBe(normal);
    expect(after?.adapterConfig?.env).toMatchObject({
      B_ONLY_TOKEN: { type: "secret_ref", key: "b_only_secret" },
      SHARED: { type: "plain", value: "from-b" },
      PAPERCLIP_ASSIGNED_MODEL: { type: "plain", value: normal },
    });
    expectNoAOnlyBinding(after);
    expect(harness.activity.some((entry) => entry.metadata?.action === "rebuild-env")).toBe(true);
  });

  it("carries a fallback pin's stamp to the new home, so the lease still finds it", async () => {
    const stamp = stampFor("d-carry");
    const { harness } = await boot([card(ISSUE, { assigneeAdapterOverrides: aPin(fallback, stampEnv(stamp)) })], undefined, {
      liveRuns: QUEUED_UNSTARTED,
    });
    await seedIndex(harness, { [ISSUE]: stamp });

    await reassign(harness, AGENT_A, AGENT_B);

    const after = await override(harness);
    expect(after?.adapterConfig?.model).toBe(fallback);
    expect(readPinProvenance(after?.adapterConfig?.env)).toEqual(stamp);
    expect((await index(harness))[ISSUE]?.decisionId).toBe("d-carry");
    expectNoAOnlyBinding(after);
  });

  it("bounds the index, evicting the oldest decision, when a carried stamp joins a full one", async () => {
    const stamp = stampFor("d-carry");
    const { harness } = await boot([card(ISSUE, { assigneeAdapterOverrides: aPin(fallback, stampEnv(stamp)) })], undefined, {
      liveRuns: QUEUED_UNSTARTED,
    });
    const full = Object.fromEntries(
      Array.from({ length: FALLBACK_PIN_INDEX_MAX }, (_, i) => [
        `old-${i}`,
        { decisionId: `d-old-${i}`, agentId: AGENT_A, fallback: true as const, decidedAt: new Date(NOW - 7_200_000 - i * 1_000).toISOString() },
      ]),
    );
    await seedIndex(harness, full);

    await reassign(harness, AGENT_A, AGENT_B);

    const after = await index(harness);
    expect(Object.keys(after)).toHaveLength(FALLBACK_PIN_INDEX_MAX);
    expect(after[ISSUE]?.decisionId).toBe("d-carry");
    expect(after[`old-${FALLBACK_PIN_INDEX_MAX - 1}`]).toBeUndefined();
    expect(after["old-0"]?.decisionId).toBe("d-old-0");
  });

  it("clears the env, keeping the model, once a run has started", async () => {
    const { harness } = await boot([card(ISSUE, { assigneeAdapterOverrides: aPin(normal) })], undefined, { liveRuns: STARTED });

    await reassign(harness, AGENT_A, AGENT_B);

    const after = await override(harness);
    expect(after).toEqual({ adapterConfig: { model: normal } });
    expect(harness.activity.some((entry) => entry.metadata?.action === "clear-env")).toBe(true);
  });

  it("clears the env on an operator-pinned card instead of rebuilding it", async () => {
    const { harness } = await boot(
      [card(ISSUE, { assigneeAdapterOverrides: aPin(normal), labels: [operatorLabel], labelIds: ["lbl-op"] } as Partial<Issue>)],
      undefined,
      { liveRuns: QUEUED_UNSTARTED },
    );

    await reassign(harness, AGENT_A, AGENT_B);

    expect(await override(harness)).toEqual({ adapterConfig: { model: normal } });
  });

  it("clears the env when the new assignee's env cannot be read", async () => {
    const { harness } = await boot([card(ISSUE, { assigneeAdapterOverrides: aPin(normal) })], undefined, {
      liveRuns: QUEUED_UNSTARTED,
    });
    const get = harness.ctx.agents.get.bind(harness.ctx.agents);
    harness.ctx.agents.get = (async (id: string, companyId: string) => {
      if (id === AGENT_B) throw new Error("agent read refused");
      return get(id, companyId);
    }) as typeof get;

    await reassign(harness, AGENT_A, AGENT_B);

    expect(await override(harness)).toEqual({ adapterConfig: { model: normal } });
  });

  it("clears the env on a closed card instead of rebuilding it", async () => {
    const { harness } = await boot([card(ISSUE, { status: "done", assigneeAdapterOverrides: aPin(normal) })], undefined, {
      liveRuns: QUEUED_UNSTARTED,
    });

    await reassign(harness, AGENT_A, AGENT_B);

    expect(await override(harness)).toEqual({ adapterConfig: { model: normal } });
    expect(harness.activity.some((entry) => entry.metadata?.action === "rebuild-env")).toBe(false);
  });

  it("clears rather than rebuilds when the pin changes while the re-home runs", async () => {
    const { harness } = await boot([card(ISSUE, { assigneeAdapterOverrides: aPin(normal) })], undefined, {
      liveRuns: QUEUED_UNSTARTED,
    });
    let repinned = false;
    const getIssue = harness.ctx.issues.get.bind(harness.ctx.issues);
    harness.ctx.issues.get = (async (id: string, companyId: string) => {
      const issue = await getIssue(id, companyId);
      if (!repinned || !issue) return issue;
      return { ...issue, assigneeAdapterOverrides: aPin(incumbent) } as Issue;
    }) as typeof getIssue;
    const getAgent = harness.ctx.agents.get.bind(harness.ctx.agents);
    harness.ctx.agents.get = (async (id: string, companyId: string) => {
      repinned = true;
      return getAgent(id, companyId);
    }) as typeof getAgent;

    await reassign(harness, AGENT_A, AGENT_B);

    expect(harness.activity.some((entry) => entry.metadata?.action === "rebuild-env")).toBe(false);
    // Read the store past the wrapper: the clear wrote over the moved pin.
    expect((await getIssue(ISSUE, COMPANY))?.assigneeAdapterOverrides).toEqual({ adapterConfig: { model: incumbent } });
  });

  it("clears a stamped fallback's env and drops it from the index", async () => {
    const stamp = stampFor("d-clear");
    const { harness } = await boot([card(ISSUE, { assigneeAdapterOverrides: aPin(fallback, stampEnv(stamp)) })], undefined, {
      liveRuns: STARTED,
    });
    await seedIndex(harness, { [ISSUE]: stamp });

    await reassign(harness, AGENT_A, AGENT_B);

    expect(await override(harness)).toEqual({ adapterConfig: { model: fallback } });
    expect(await index(harness)).toEqual({});
  });

  it("clears an env-only override to null, leaving no override behind", async () => {
    const { harness } = await boot([card(ISSUE, { assigneeAdapterOverrides: { adapterConfig: { env: { ...A_ENV } } } })], undefined, {
      liveRuns: QUEUED_UNSTARTED,
    });

    await reassign(harness, AGENT_A, AGENT_B);

    expect(await override(harness)).toBeNull();
  });

  it("does not write a card whose override carries no env", async () => {
    const { harness, writes } = await boot([card(ISSUE, { assigneeAdapterOverrides: { adapterConfig: { model: normal } } })], undefined, {
      liveRuns: QUEUED_UNSTARTED,
    });

    await reassign(harness, AGENT_A, AGENT_B);

    expect(writes).toEqual([]);
  });

  it("leaves a card that has already moved on to the later assignee's own event", async () => {
    const { harness, writes } = await boot(
      [card(ISSUE, { assigneeAgentId: "agent-c", assigneeAdapterOverrides: aPin(normal) })],
      [agent(AGENT_A, A_ENV), agent(AGENT_B, B_ENV), agent("agent-c", {})],
      { liveRuns: QUEUED_UNSTARTED },
    );

    await reassign(harness, AGENT_A, AGENT_B);

    expect(writes).toEqual([]);
    expect((await override(harness))?.adapterConfig?.env).toMatchObject(A_ENV);
  });

  // A reassignment landing while the re-home runs: the final reads before
  // each write must see it. `after` names the read the flip follows.
  for (const after of ["first issue read", "assignee read"] as const) {
    it(`does not write when the card moves on after the ${after}`, async () => {
      const { harness, writes } = await boot(
        [card(ISSUE, { assigneeAdapterOverrides: aPin(normal) })],
        [agent(AGENT_A, A_ENV), agent(AGENT_B, B_ENV), agent("agent-c", {})],
        { liveRuns: QUEUED_UNSTARTED },
      );
      let moved = false;
      const getIssue = harness.ctx.issues.get.bind(harness.ctx.issues);
      harness.ctx.issues.get = (async (id: string, companyId: string) => {
        const issue = await getIssue(id, companyId);
        const seen = moved && issue ? ({ ...issue, assigneeAgentId: "agent-c" } as Issue) : issue;
        if (after === "first issue read") moved = true;
        return seen;
      }) as typeof getIssue;
      const getAgent = harness.ctx.agents.get.bind(harness.ctx.agents);
      harness.ctx.agents.get = (async (id: string, companyId: string) => {
        if (after === "assignee read") moved = true;
        return getAgent(id, companyId);
      }) as typeof getAgent;

      await reassign(harness, AGENT_A, AGENT_B);

      expect(writes).toEqual([]);
    });
  }

  it("treats a fresh assignment as the creation moment, not a re-home", async () => {
    const { harness } = await boot([card(ISSUE, { assigneeAdapterOverrides: aPin(normal) })], undefined, {
      liveRuns: QUEUED_UNSTARTED,
    });

    await reassign(harness, null, AGENT_B);

    expect(harness.activity.some((entry) => entry.metadata?.action === "rebuild-env" || entry.metadata?.action === "clear-env")).toBe(false);
  });
});

describe("TOG-12234 fallback lease", () => {
  it("stamps and indexes the fallback pin the repin pass writes", async () => {
    const { harness } = await boot([card(ISSUE, {
      status: "in_progress", assigneeAgentId: AGENT_A, assigneeAdapterOverrides: { adapterConfig: { model: incumbent } },
    })], undefined, { repinCandidates: [ISSUE] });
    await outage(harness, ["lane-dead", "lane-normal"]);

    await harness.runJob("repinPass");

    const fallbackPin = await override(harness);
    expect(fallbackPin?.adapterConfig?.model).toBe(fallback);
    const stamp = readPinProvenance(fallbackPin?.adapterConfig?.env);
    expect(stamp).toMatchObject({ agentId: AGENT_A, fallback: true });
    expect((await index(harness))[ISSUE]?.decisionId).toBe(stamp?.decisionId);
  });

  it("writes no stamp and no index entry for a regular pin", async () => {
    const { harness } = await boot([card(ISSUE, {
      status: "in_progress", assigneeAgentId: AGENT_A, assigneeAdapterOverrides: { adapterConfig: { model: incumbent } },
    })], undefined, { repinCandidates: [ISSUE] });
    await outage(harness, ["lane-dead"]);

    await harness.runJob("repinPass");

    const regularPin = await override(harness);
    expect(regularPin?.adapterConfig?.model).toBe(normal);
    expect(regularPin?.adapterConfig?.env?.[PIN_PROVENANCE_ENV_KEY]).toBeUndefined();
    expect(await index(harness)).toEqual({});
  });

  it("re-decides a stamped fallback once a primary is serviceable again", async () => {
    const stamp = stampFor("d-release");
    const { harness } = await boot([leaseCard(ISSUE, stamp)]);
    await seedIndex(harness, { [ISSUE]: stamp });

    await harness.runJob("repinPass");

    const after = await override(harness);
    expect([normal, incumbent]).toContain(after?.adapterConfig?.model);
    expect(readPinProvenance(after?.adapterConfig?.env)).toBeNull();
    expect(after?.adapterConfig?.env).toMatchObject(A_ENV);
    expect(await index(harness)).toEqual({});
    expect(harness.activity.some((entry) => entry.metadata?.reason === "fallback-lease" && entry.metadata?.decisionId === "d-release")).toBe(true);
  });

  it("holds the fallback while no primary can take the card, and records the visit", async () => {
    const stamp = stampFor("d-hold");
    const { harness, writes } = await boot([leaseCard(ISSUE, stamp)]);
    await seedIndex(harness, { [ISSUE]: stamp });
    await outage(harness, ["lane-dead", "lane-normal"]);

    await harness.runJob("repinPass");

    expect(writes).toEqual([]);
    expect((await override(harness))?.adapterConfig?.model).toBe(fallback);
    expect((await index(harness))[ISSUE]).toMatchObject({ decisionId: "d-hold", checkedAt: new Date(NOW).toISOString() });
    // Held without a re-decision: no primary qualified, so no selection ran.
    expect(harness.metrics.filter((metric) => metric.name.startsWith("model_selection.decision."))).toEqual([]);
  });

  it("never touches a non-fallback pin, even one a stale index entry points at", async () => {
    const { harness, writes } = await boot([leaseCard(ISSUE, null), leaseCard("card-2", null)]);
    await seedIndex(harness, { [ISSUE]: stampFor("d-stale") });

    await harness.runJob("repinPass");

    expect(writes).toEqual([]);
    expect((await override(harness))?.adapterConfig?.model).toBe(normal);
    expect((await override(harness, "card-2"))?.adapterConfig?.model).toBe(normal);
    expect(await index(harness)).toEqual({});
  });

  it("drops an entry whose stamp has been replaced by a later decision, without writing", async () => {
    const { harness, writes } = await boot([leaseCard(ISSUE, stampFor("d-new"))]);
    await seedIndex(harness, { [ISSUE]: stampFor("d-old") });

    await harness.runJob("repinPass");

    expect(writes).toEqual([]);
    expect((await override(harness))?.adapterConfig?.model).toBe(fallback);
    expect(await index(harness)).toEqual({});
  });

  it("drops entries on closed and operator-pinned cards without writing", async () => {
    const closed = stampFor("d-closed");
    const held = stampFor("d-held");
    const { harness, writes } = await boot([
      leaseCard(ISSUE, closed, { status: "done" }),
      leaseCard("card-2", held, { labels: [operatorLabel], labelIds: ["lbl-op"] } as Partial<Issue>),
    ]);
    await seedIndex(harness, { [ISSUE]: closed, "card-2": held });

    await harness.runJob("repinPass");

    expect(writes).toEqual([]);
    expect(await index(harness)).toEqual({});
  });

  it("caps the writes per firing", async () => {
    const ids = Array.from({ length: FALLBACK_LEASE_WRITE_LIMIT + 3 }, (_, i) => `card-${i}`);
    const stamps = Object.fromEntries(ids.map((id) => [id, stampFor(`d-${id}`)]));
    const { harness, writes } = await boot(ids.map((id) => leaseCard(id, stamps[id]!)));
    await seedIndex(harness, stamps);

    await harness.runJob("repinPass");

    expect(writes).toHaveLength(FALLBACK_LEASE_WRITE_LIMIT);
    expect(Object.keys(await index(harness))).toHaveLength(3);
  });

  it("caps the examined entries per firing and visits the unchecked ones next", async () => {
    const ids = Array.from({ length: FALLBACK_LEASE_EXAMINE_LIMIT + 4 }, (_, i) => `card-${String(i).padStart(2, "0")}`);
    const stamps = Object.fromEntries(ids.map((id) => [id, stampFor(`d-${id}`)]));
    const { harness } = await boot(ids.map((id) => leaseCard(id, stamps[id]!)));
    await seedIndex(harness, stamps);
    await outage(harness, ["lane-dead", "lane-normal"]);

    await harness.runJob("repinPass");
    const first = await index(harness);
    expect(Object.values(first).filter((entry) => entry.checkedAt !== null)).toHaveLength(FALLBACK_LEASE_EXAMINE_LIMIT);

    vi.setSystemTime(NOW + 60_000);
    await harness.runJob("repinPass");
    const second = await index(harness);
    expect(Object.values(second).every((entry) => entry.checkedAt !== null)).toBe(true);
  });
});

// TOG-12431 (review of the reviewer-rebased head): the three writers this
// feature adds — the re-home rebuild, the re-home clear, and the fallback
// lease release — take the same single gate as the five scheduled/event pin
// sites. Advisory installs walk their rows and log their decisions, but
// write no override: writing here reintroduced exactly the TOG-12427 defect
// #482 closed. Both non-enforcing postures are covered, because both
// conjuncts of the gate are load-bearing.
describe("TOG-12431 advisory installs gate the re-home and lease writers", () => {
  const ADVISORY_SELECTIONS: Array<{ name: string; selection: Record<string, unknown> }> = [
    { name: "advise", selection: { enabled: true, mode: "advise" } },
    // Disabled wins even when mode says enforce: both conjuncts are load-bearing.
    { name: "selection-disabled", selection: { enabled: false, mode: "enforce" } },
  ];

  for (const { name, selection } of ADVISORY_SELECTIONS) {
    it(`rebuilds no pin env on reassignment in ${name} mode but still logs the decision`, async () => {
      const { harness, writes } = await boot(
        [card(ISSUE, { assigneeAdapterOverrides: aPin(normal) })],
        undefined,
        { liveRuns: QUEUED_UNSTARTED },
        selection,
      );

      await reassign(harness, AGENT_A, AGENT_B);

      // The TOG-12427 defect: this update fired in advisory installs.
      expect(writes).toEqual([]);
      // Nothing was written, so the previous assignee's env is still there —
      // enforcement (or the TOG-12305 repair path, with its own advisory
      // check) is what re-homes it.
      const after = await override(harness);
      expect(after?.adapterConfig?.model).toBe(normal);
      expect(after?.adapterConfig?.env).toMatchObject(A_ENV);
      const entry = harness.activity.find((e) => e.metadata?.action === "rebuild-env");
      expect(entry?.message).toContain("advisory, nothing written");
      expect(entry?.metadata).toMatchObject({ advisory: true, written: false });
    });

    it(`clears no previous assignee env in ${name} mode but still logs the decision`, async () => {
      const { harness, writes } = await boot(
        [card(ISSUE, { assigneeAdapterOverrides: aPin(normal) })],
        undefined,
        { liveRuns: STARTED },
        selection,
      );

      await reassign(harness, AGENT_A, AGENT_B);

      expect(writes).toEqual([]);
      // The clear is a hygiene write, but #482 has deliberately no exception
      // for those: the stale env stays until enforcement clears it.
      const after = await override(harness);
      expect(after?.adapterConfig?.model).toBe(normal);
      expect(after?.adapterConfig?.env).toMatchObject(A_ENV);
      const entry = harness.activity.find((e) => e.metadata?.action === "clear-env");
      expect(entry?.message).toContain("advisory, nothing written");
      expect(entry?.metadata).toMatchObject({ advisory: true, written: false });
    });

    it(`releases no fallback lease in ${name} mode but still logs the decision`, async () => {
      const stamp = stampFor("d-advisory");
      const { harness, writes } = await boot([leaseCard(ISSUE, stamp)], undefined, {}, selection);
      await seedIndex(harness, { [ISSUE]: stamp });

      await harness.runJob("repinPass");

      expect(writes).toEqual([]);
      // The lease holds: the pin stays on the fallback, the index entry
      // survives (an unwritten release must not drop it), and the visit is
      // still recorded so the next firing re-examines it.
      expect((await override(harness))?.adapterConfig?.model).toBe(fallback);
      expect((await index(harness))[ISSUE]).toMatchObject({
        decisionId: "d-advisory",
        checkedAt: new Date(NOW).toISOString(),
      });
      const entry = harness.activity.find((e) => e.metadata?.reason === "fallback-lease");
      expect(entry?.message).toContain("advisory, nothing written");
      expect(entry?.metadata).toMatchObject({ advisory: true, written: false });
    });
  }
});
