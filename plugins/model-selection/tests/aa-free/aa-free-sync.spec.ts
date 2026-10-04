import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import manifest from "../../src/manifest.js";
import { JOB_KEYS, PLUGIN_STATE_KEYS, TOOL_NAMES } from "../../src/constants.js";
import { createPlugin } from "../../src/worker.js";
import {
  buildAdviseEvidence,
  buildSyncDiff,
  freeSnapshotDigest,
  isSnapshotFresh,
  nextEligibleAfter,
  recoverSelectedCandidate,
  shouldFetchFreeSync,
  verifyBindings,
  discoverUnbound,
  type SyncModelView,
} from "../../src/aa-free/sync.js";
import { parseAaFreeList } from "../../src/aa-free/parse.js";
import type { AaBinding } from "../../src/aa-free/registry.js";
import { MODELS, NO_ESCALATION, NOW, PROFILES } from "../fixtures.js";
import { legacyBody, legacyRow } from "./fixture.js";

const COMPANY = "co-1";
const ISSUE = "issue-1";
const TIER_LABEL_ID = "lbl-t1";
const OTHER_LABEL_ID = "lbl-other";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

// --- pure-level fixtures -----------------------------------------------------

const SNAP_AT = "2026-10-01T14:50:03Z";
const snap = (rows: unknown[]) => parseAaFreeList(legacyBody(rows), SNAP_AT)!;

const MODELS_VIEW: SyncModelView[] = [
  { id: "gpt-5.6-sol", laneId: "lane-codex", fallbackOnly: false, enabled: true },
  { id: "claude-opus-5-5", laneId: "lane-claude", fallbackOnly: false, enabled: true },
  { id: "held-model", laneId: "lane-claude", fallbackOnly: true, enabled: true },
  { id: "off-model", laneId: "lane-claude", fallbackOnly: false, enabled: false },
];

const BINDINGS: AaBinding[] = [
  { candidateId: "sol-high", modelId: "gpt-5.6-sol", laneId: "lane-codex", evaluatedEffort: "high", aaSlug: "gpt-5-6-sol-high" },
  { candidateId: "opus-high", modelId: "claude-opus-5-5", laneId: "lane-claude", evaluatedEffort: "high", aaSlug: "opus-high" },
  { candidateId: "held-high", modelId: "held-model", laneId: "lane-claude", evaluatedEffort: "high", aaSlug: "held-high" },
  { candidateId: "off-high", modelId: "off-model", laneId: "lane-claude", evaluatedEffort: "high", aaSlug: "off-high" },
];

const ROWS = [
  legacyRow("gpt-5-6-sol-high", 51),
  legacyRow("opus-high", 48),
  legacyRow("held-high", 44),
  legacyRow("off-high", 40),
];

describe("verifyBindings: exact lane/effort conformance only", () => {
  it("verifies conforming bindings and holds S-tier/disabled rows", () => {
    const s = snap(ROWS);
    const { verified, broken, ambiguous } = verifyBindings({ bindings: BINDINGS, models: MODELS_VIEW, snapshot: s });
    expect(broken).toEqual([]);
    expect(ambiguous).toEqual([]);
    expect(verified.map((v) => [v.binding.candidateId, v.aaIndex, v.held])).toEqual([
      ["sol-high", 51, null],
      ["opus-high", 48, null],
      ["held-high", 44, "fallback-only"],
      ["off-high", 40, "model-disabled"],
    ]);
  });

  it("breaks unknown models, lane mismatches, inexpressible efforts, absent slugs", () => {
    const s = snap(ROWS);
    const bad: AaBinding[] = [
      { candidateId: "ghost", modelId: "nope", laneId: "lane-claude", evaluatedEffort: "high", aaSlug: "opus-high" },
      { candidateId: "lane-x", modelId: "claude-opus-5-5", laneId: "lane-zai", evaluatedEffort: "high", aaSlug: "opus-high" },
      { candidateId: "eff-x", modelId: "claude-opus-5-5", laneId: "lane-claude", evaluatedEffort: "default", aaSlug: "opus-high" },
      { candidateId: "slug-x", modelId: "claude-opus-5-5", laneId: "lane-claude", evaluatedEffort: "high", aaSlug: "missing" },
    ];
    const { verified, broken } = verifyBindings({ bindings: bad, models: MODELS_VIEW, snapshot: s });
    expect(verified).toEqual([]);
    expect(broken.map((b) => b.reason)).toEqual(["model-unknown", "lane-mismatch", "effort-inexpressible", "slug-absent"]);
  });

  it("breaks duplicate keys and snapshot-duplicated slugs, never first-wins", () => {
    const dup = snap([legacyRow("opus-high", 40), legacyRow("opus-high", 51)]);
    const dupeKey: AaBinding[] = [
      { candidateId: "a", modelId: "claude-opus-5-5", laneId: "lane-claude", evaluatedEffort: "high", aaSlug: "opus-high" },
      { candidateId: "b", modelId: "claude-opus-5-5", laneId: "lane-claude", evaluatedEffort: "high", aaSlug: "opus-high" },
    ];
    const r1 = verifyBindings({ bindings: dupeKey, models: MODELS_VIEW, snapshot: snap(ROWS) });
    expect(r1.verified).toEqual([]);
    expect(r1.broken.map((b) => b.reason)).toEqual(["duplicate-binding", "duplicate-binding"]);

    const r2 = verifyBindings({
      bindings: [BINDINGS[1]!],
      models: MODELS_VIEW,
      snapshot: dup,
    });
    expect(r2.verified).toEqual([]);
    expect(r2.broken.map((b) => b.reason)).toEqual(["slug-ambiguous"]);
  });

  it("reports one slug claimed by two bindings as ambiguous, verifying neither", () => {
    const shared: AaBinding[] = [
      { candidateId: "a", modelId: "gpt-5.6-sol", laneId: "lane-codex", evaluatedEffort: "high", aaSlug: "shared" },
      { candidateId: "b", modelId: "claude-opus-5-5", laneId: "lane-claude", evaluatedEffort: "high", aaSlug: "shared" },
    ];
    const s = snap([...ROWS, legacyRow("shared", 60)]);
    const { verified, broken, ambiguous } = verifyBindings({ bindings: shared, models: MODELS_VIEW, snapshot: s });
    expect(verified).toEqual([]);
    expect(broken).toEqual([]);
    expect(ambiguous).toEqual([{ aaSlug: "shared", candidateIds: ["a", "b"] }]);
  });
});

describe("discoverUnbound: proposals are curation input, never bindings", () => {
  it("proposes exact slug matches, lists family hints, skips disabled/laneless rows", () => {
    const s = snap([...ROWS, legacyRow("gpt-5-6-sol", 50), legacyRow("gpt-5-6-sol-ultra", 57), legacyRow("stray", 10)]);
    const models: SyncModelView[] = [
      { id: "gpt-5.6-sol", laneId: "lane-codex", fallbackOnly: false, enabled: true },
      { id: "off-model", laneId: "lane-claude", fallbackOnly: false, enabled: false },
      { id: "lane-less", laneId: null, fallbackOnly: false, enabled: true },
    ];
    const { verified } = verifyBindings({ bindings: [], models, snapshot: s });
    const { unbound, unmatchedSlugs } = discoverUnbound({ models, verified, snapshot: s });
    expect(unbound).toEqual([
      {
        modelId: "gpt-5.6-sol",
        laneId: "lane-codex",
        suggestedSlug: "gpt-5-6-sol",
        familySlugs: ["gpt-5-6-sol-high", "gpt-5-6-sol-ultra"],
      },
    ]);
    expect(unmatchedSlugs).toContain("stray");
    expect(unmatchedSlugs).not.toContain("gpt-5-6-sol");
  });
});

describe("buildSyncDiff: the reviewable artifact", () => {
  it("carries digest, counts, and every section", () => {
    const s = snap(ROWS);
    const digest = freeSnapshotDigest(s);
    const diff = buildSyncDiff({ bindings: BINDINGS, models: MODELS_VIEW, snapshot: s, digest });
    expect(diff.digest).toBe(digest);
    expect(diff.fetchedAt).toBe(SNAP_AT);
    expect(diff.rowCount).toBe(ROWS.length);
    expect(diff.verified).toHaveLength(4);
    expect(diff.broken).toEqual([]);
    expect(diff.ambiguous).toEqual([]);
  });
});

describe("CAS digest + quota + freshness", () => {
  it("is reorder-insensitive but value-sensitive", () => {
    const a = snap(ROWS);
    const b = snap([...ROWS].reverse());
    expect(freeSnapshotDigest(a)).toBe(freeSnapshotDigest(b));
    const c = snap(ROWS.map((r, i) => (i === 0 ? legacyRow("gpt-5-6-sol-high", 52) : r)));
    expect(freeSnapshotDigest(c)).not.toBe(freeSnapshotDigest(a));
  });

  it("shouldFetchFreeSync gates on nextEligibleAt; outcomes map to the D1 quota", () => {
    const now = Date.parse(SNAP_AT);
    expect(shouldFetchFreeSync({ nextEligibleAt: null }, now)).toBe(true);
    expect(shouldFetchFreeSync({ nextEligibleAt: "bogus" }, now)).toBe(true);
    expect(shouldFetchFreeSync({ nextEligibleAt: new Date(now - 1).toISOString() }, now)).toBe(true);
    expect(shouldFetchFreeSync({ nextEligibleAt: new Date(now + 1).toISOString() }, now)).toBe(false);
    // ok/fatal back off a day; retryable an hour; 429 honors Retry-After.
    expect(Date.parse(nextEligibleAfter("ok", now, null)) - now).toBe(24 * 60 * 60 * 1000);
    expect(Date.parse(nextEligibleAfter("fatal", now, null)) - now).toBe(24 * 60 * 60 * 1000);
    expect(Date.parse(nextEligibleAfter("retryable", now, null)) - now).toBe(60 * 60 * 1000);
    expect(Date.parse(nextEligibleAfter("rate-limited", now, 120)) - now).toBe(120_000);
    expect(Date.parse(nextEligibleAfter("rate-limited", now, null)) - now).toBe(60 * 60 * 1000);
  });

  it("isSnapshotFresh bounds both ends", () => {
    const now = Date.parse(SNAP_AT);
    const hour = 60 * 60 * 1000;
    expect(isSnapshotFresh(SNAP_AT, now, 49 * hour)).toBe(true);
    expect(isSnapshotFresh(new Date(now - 50 * hour).toISOString(), now, 49 * hour)).toBe(false);
    expect(isSnapshotFresh(new Date(now + hour).toISOString(), now, 49 * hour)).toBe(false);
    expect(isSnapshotFresh(null, now, 49 * hour)).toBe(false);
    expect(isSnapshotFresh("bogus", now, 49 * hour)).toBe(false);
  });
});

describe("buildAdviseEvidence: shadow-only, never a gate", () => {
  const s = snap(ROWS);
  const digest = freeSnapshotDigest(s);
  const model = MODELS_VIEW[0]!;
  const base = {
    bindings: BINDINGS,
    snapshot: s,
    digest,
    stale: false,
    model,
    adapterType: "codex_local",
    requestedEffort: "high",
  };

  it("returns null with no bindings — the legacy path", () => {
    expect(buildAdviseEvidence({ ...base, bindings: [] })).toBeNull();
  });

  it("matches the effective effort the invocation will run", () => {
    const ev = buildAdviseEvidence(base)!;
    expect(ev).toMatchObject({ status: "matched", candidateId: "sol-high", reason: null, aaIndex: 51, held: null });
    expect(ev.requestedEffort).toBe("high");
    expect(ev.effectiveEffort).toBe("high");
    expect(ev.observedServedEffort).toBeNull();
    expect(ev.snapshotDigest).toBe(digest);
    expect(ev.stale).toBe(false);
  });

  it("stale snapshots yield ineligible/snapshot-stale with no candidate", () => {
    const ev = buildAdviseEvidence({ ...base, stale: true })!;
    expect(ev).toMatchObject({ status: "ineligible", candidateId: null, reason: "snapshot-stale", aaIndex: null, stale: true });
  });

  it("S-tier picks stay held even as evidence", () => {
    const held = MODELS_VIEW[2]!;
    const ev = buildAdviseEvidence({
      ...base,
      model: held,
      requestedEffort: "high",
    })!;
    expect(ev).toMatchObject({ status: "matched", candidateId: "held-high", held: "fallback-only" });
    const staleEv = buildAdviseEvidence({ ...base, model: held, stale: true })!;
    expect(staleEv.held).toBe("fallback-only");
  });

  it("ambiguous slugs are ineligible at advise time too", () => {
    const shared: AaBinding[] = [
      { candidateId: "a", modelId: "gpt-5.6-sol", laneId: "lane-codex", evaluatedEffort: "high", aaSlug: "shared" },
      { candidateId: "b", modelId: "claude-opus-5-5", laneId: "lane-claude", evaluatedEffort: "high", aaSlug: "shared" },
    ];
    const withShared = snap([...ROWS, legacyRow("shared", 60)]);
    const ev = buildAdviseEvidence({
      bindings: shared,
      snapshot: withShared,
      digest: freeSnapshotDigest(withShared),
      stale: false,
      model,
      adapterType: "codex_local",
      requestedEffort: "high",
    })!;
    expect(ev).toMatchObject({ status: "ineligible", candidateId: "a", reason: "slug-ambiguous", aaIndex: null });
  });

  it("duplicate keys yield no evidence rather than wrong evidence", () => {
    const dupe: AaBinding[] = [BINDINGS[0]!, BINDINGS[0]!];
    expect(buildAdviseEvidence({ ...base, bindings: dupe })).toBeNull();
  });

  it("unavailable slugs are ineligible, never fallback", () => {
    const ev = buildAdviseEvidence({ ...base, snapshot: snap([legacyRow("other", 1)]) })!;
    expect(ev).toMatchObject({ status: "ineligible", reason: "slug-absent-from-snapshot", aaIndex: null });
  });
});

describe("recoverSelectedCandidate: carry, never re-derive", () => {
  it("returns the row with the evidenced candidateId", () => {
    const got = recoverSelectedCandidate(MODELS_VIEW, { modelId: "gpt-5.6-sol", aaEffortEvidence: { candidateId: "sol-high" } as never });
    expect(got).toMatchObject({ id: "gpt-5.6-sol", laneId: "lane-codex", candidateId: "sol-high" });
  });

  it("carries null evidence as null, and nulls on missing ids", () => {
    expect(recoverSelectedCandidate(MODELS_VIEW, { modelId: "gpt-5.6-sol", aaEffortEvidence: null })?.candidateId).toBeNull();
    expect(recoverSelectedCandidate(MODELS_VIEW, { modelId: "gpt-5.6-sol" })?.candidateId).toBeNull();
    expect(recoverSelectedCandidate(MODELS_VIEW, { modelId: null, aaEffortEvidence: null })).toBeNull();
    expect(recoverSelectedCandidate(MODELS_VIEW, { modelId: "ghost", aaEffortEvidence: null })).toBeNull();
  });
});

// --- worker-level: off/on/stale/legacy-restore --------------------------------

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

/** Roster row the T1 card will select: opus on lane-claude with a curated high effort. */
const V2_MODELS = MODELS.map((model) =>
  model.id === "claude-opus-5" ? { ...model, laneId: "lane-claude", effort: "high" } : model,
);

const V2_BINDINGS = [
  { candidateId: "opus-high", modelId: "claude-opus-5", laneId: "lane-claude", evaluatedEffort: "high", aaSlug: "opus-high" },
];

function v2Config(overrides: Record<string, unknown> = {}) {
  return {
    selection: { enabled: true, mode: "advise", holdOnUntrustedProfile: true },
    models: V2_MODELS,
    tierLabelIds: { T1: TIER_LABEL_ID },
    aaFreeSync: { enabled: true, bindings: V2_BINDINGS },
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
  const plugin = createPlugin();
  const setup = plugin.definition.setup;
  if (!setup) throw new Error("plugin definition has no setup handler");
  await setup(harness.ctx);
  const onConfigChanged = plugin.definition.onConfigChanged;
  if (!onConfigChanged) throw new Error("plugin definition has no onConfigChanged handler");
  await onConfigChanged(config, { companyId: COMPANY });
  await harness.ctx.state.set(
    { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.volumeProfiles },
    { profiles: PROFILES, signals: NO_ESCALATION },
  );
  return harness;
}

const runCtx = { companyId: COMPANY, agentId: "agent-1", runId: "run-1" };

/** Seed a fresh instance-scope free-list snapshot holding the opus-high row. */
async function seedSnapshot(harness: Awaited<ReturnType<typeof boot>>, fetchedAt: string) {
  const snapshot = parseAaFreeList(legacyBody([legacyRow("opus-high", 48)]), fetchedAt)!;
  await harness.ctx.state.set(
    { scopeKind: "instance", stateKey: PLUGIN_STATE_KEYS.aaFreeSyncSnapshot },
    {
      fetchedAt,
      digest: freeSnapshotDigest(snapshot),
      snapshot,
      lastAttemptAt: fetchedAt,
      lastError: null,
      nextEligibleAt: null,
    },
  );
}

const CLAUD_AGENT = {
  id: "agent-1",
  companyId: COMPANY,
  name: "Claude worker",
  status: "active",
  adapterType: "claude_local",
  adapterConfig: { model: "claude-opus-5", effort: "high" },
} as never;

describe("worker: v2 evidence attach + legacy restore", () => {
  it("leaves the decision shape byte-for-byte legacy when v2 is off", async () => {
    const harness = await boot({
      selection: { enabled: true, mode: "advise", holdOnUntrustedProfile: true },
      models: MODELS,
      tierLabelIds: { T1: TIER_LABEL_ID },
    });
    const result = await harness.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);
    const decision = (result as { data: Record<string, unknown> }).data;
    expect(decision.modelId).toBe("claude-opus-5");
    expect("aaEffortEvidence" in decision).toBe(false);
  });

  it("leaves the key absent when enabled but snapshot-less", async () => {
    const harness = await boot(v2Config(), issue({ assigneeAgentId: "agent-1" }), [CLAUD_AGENT]);
    const result = await harness.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);
    const decision = (result as { data: Record<string, unknown> }).data;
    expect(decision.modelId).toBe("claude-opus-5");
    expect("aaEffortEvidence" in decision).toBe(false);
  });

  it("attaches matched evidence when enabled with a fresh snapshot", async () => {
    const harness = await boot(v2Config(), issue({ assigneeAgentId: "agent-1" }), [CLAUD_AGENT]);
    await seedSnapshot(harness, new Date().toISOString());
    const result = await harness.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);
    const decision = (result as { data: Record<string, unknown> }).data;
    expect(decision.modelId).toBe("claude-opus-5");
    expect(decision.aaEffortEvidence).toMatchObject({
      status: "matched",
      candidateId: "opus-high",
      reason: null,
      effectiveEffort: "high",
      aaIndex: 48,
      stale: false,
      held: null,
    });
  });

  it("marks evidence ineligible when the snapshot is stale", async () => {
    const harness = await boot(v2Config(), issue({ assigneeAgentId: "agent-1" }), [CLAUD_AGENT]);
    await seedSnapshot(harness, new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString());
    const result = await harness.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);
    const decision = (result as { data: Record<string, unknown> }).data;
    expect(decision.aaEffortEvidence).toMatchObject({
      status: "ineligible",
      candidateId: null,
      reason: "snapshot-stale",
      stale: true,
    });
  });

  it("marks ambiguous bindings ineligible at advise time", async () => {
    const harness = await boot(
      v2Config({
        aaFreeSync: {
          enabled: true,
          bindings: [
            ...V2_BINDINGS,
            { candidateId: "opus-high-2", modelId: "claude-sonnet-5", laneId: "lane-x", evaluatedEffort: "high", aaSlug: "opus-high" },
          ],
        },
      }),
      issue({ assigneeAgentId: "agent-1" }),
      [CLAUD_AGENT],
    );
    await seedSnapshot(harness, new Date().toISOString());
    const result = await harness.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);
    const decision = (result as { data: Record<string, unknown> }).data;
    expect(decision.aaEffortEvidence).toMatchObject({
      status: "ineligible",
      candidateId: "opus-high",
      reason: "slug-ambiguous",
    });
  });
});

describe("worker: sync job + report/refresh tools", () => {
  it("declares the daily job and both tools in the manifest", () => {
    expect(manifest.jobs?.some((j) => j.jobKey === JOB_KEYS.refreshAaFreeSync)).toBe(true);
    const names = (manifest.tools ?? []).map((t) => t.name);
    expect(names).toContain(TOOL_NAMES.aaFreeSyncReport);
    expect(names).toContain(TOOL_NAMES.refreshAaFreeSyncNow);
  });

  it("does no fetch when nobody enables v2, and reports nothing to fetch", async () => {
    const harness = await boot({
      selection: { enabled: true, mode: "advise", holdOnUntrustedProfile: true },
      models: MODELS,
      tierLabelIds: { T1: TIER_LABEL_ID },
    });
    let fetched = 0;
    harness.ctx.http.fetch = (async () => {
      fetched += 1;
      throw new Error("must not fetch");
    }) as never;
    await harness.runJob(JOB_KEYS.refreshAaFreeSync);
    expect(fetched).toBe(0);
    const report = await harness.executeTool(TOOL_NAMES.aaFreeSyncReport, {}, runCtx);
    expect((report as { data: Record<string, unknown> }).data).toMatchObject({ ok: false, error: "no-report-yet" });
    const refresh = await harness.executeTool(TOOL_NAMES.refreshAaFreeSyncNow, {}, runCtx);
    const refreshData = (refresh as { data: Record<string, unknown> }).data as { companies: unknown[] };
    expect(refreshData.companies).toEqual([]);
  });

  it("fetches once with the company credential and stores the diff", async () => {
    const harness = await boot(
      v2Config({
        aaFreeSync: {
          enabled: true,
          apiKeySecretRef: { type: "secret_ref", secretId: "5ec2e700-0000-4000-8000-000000000001" },
          bindings: V2_BINDINGS,
        },
      }),
    );
    harness.seed({ companies: [{ id: COMPANY, name: "Co" } as never] });
    let seenHeaders: Record<string, string> | undefined;
    harness.ctx.secrets.resolve = (async () => "free-key") as never;
    harness.ctx.http.fetch = (async (_url: unknown, init?: unknown) => {
      seenHeaders = (init as { headers?: Record<string, string> } | undefined)?.headers;
      return new Response(legacyBody([legacyRow("opus-high", 48)]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }) as never;
    }) as never;
    await harness.runJob(JOB_KEYS.refreshAaFreeSync);
    expect(seenHeaders).toMatchObject({ "x-api-key": "free-key" });

    const stored = (await harness.ctx.state.get({
      scopeKind: "company",
      scopeId: COMPANY,
      stateKey: PLUGIN_STATE_KEYS.aaFreeSyncDiff,
    })) as unknown as { ranAt: string; digest: string; error: null; diff: { verified: unknown[]; broken: unknown[] } };
    expect(stored.error).toBeNull();
    expect(stored.diff.verified).toHaveLength(1);
    expect(stored.diff.broken).toEqual([]);

    const report = await harness.executeTool(TOOL_NAMES.aaFreeSyncReport, {}, runCtx);
    expect((report as { content: string }).content).toContain("1 verified");
  });

  it("a 403 stops the source for the day with no substitution, keeping last-good", async () => {
    const harness = await boot(
      v2Config({
        aaFreeSync: {
          enabled: true,
          apiKeySecretRef: { type: "secret_ref", secretId: "5ec2e700-0000-4000-8000-000000000001" },
          bindings: V2_BINDINGS,
        },
      }),
    );
    harness.seed({ companies: [{ id: COMPANY, name: "Co" } as never] });
    const freshAt = new Date().toISOString();
    await seedSnapshot(harness, freshAt);
    let calls = 0;
    harness.ctx.secrets.resolve = (async () => "free-key") as never;
    harness.ctx.http.fetch = (async () => {
      calls += 1;
      return new Response("denied", { status: 403 }) as never;
    }) as never;
    await harness.runJob(JOB_KEYS.refreshAaFreeSync);
    // One fetch, one credential: the denial stops the source, no second try.
    expect(calls).toBe(1);
    const snap = (await harness.ctx.state.get({
      scopeKind: "instance",
      stateKey: PLUGIN_STATE_KEYS.aaFreeSyncSnapshot,
    })) as unknown as { fetchedAt: string; lastError: string; nextEligibleAt: string };
    expect(snap.fetchedAt).toBe(freshAt);
    expect(snap.lastError).toBe("aa-access-denied");
    expect(Date.parse(snap.nextEligibleAt) - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);
    // The quota gate holds: a second firing performs no second fetch.
    await harness.runJob(JOB_KEYS.refreshAaFreeSync);
    expect(calls).toBe(1);
  });

  it("records no-report-yet and missing scope with stable codes", async () => {
    const harness = await boot(v2Config());
    const noReport = await harness.executeTool(TOOL_NAMES.aaFreeSyncReport, { bogus: 1 }, runCtx);
    expect((noReport as { data: unknown }).data).toMatchObject({ ok: false, error: "no-report-yet" });
    const noScope = await harness.executeTool(TOOL_NAMES.aaFreeSyncReport, {}, { ...runCtx, companyId: "" as never });
    expect((noScope as { data: unknown }).data).toMatchObject({ ok: false, error: "missing-company-scope" });
  });
});
