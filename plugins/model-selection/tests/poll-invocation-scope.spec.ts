import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import manifest from "../src/manifest.js";
import { JOB_KEYS, PLUGIN_STATE_KEYS } from "../src/constants.js";
import { createPlugin } from "../src/worker.js";

/**
 * invocation-scope regression for the `pollLaneCapacity` scheduled
 * job (follow-up to [](/TOG/issues/)).
 *
 * The defect: a scheduled job's `await ctx.companies.list()` is a wildcard
 * host call outside the per-company `proactiveCompanyScopes` authorization,
 * so the host denies it nondeterministically. The SAME denial surfaces as
 * two different texts (`scripts/discord_job_health.js` `classify()`): "the
 * worker referenced a missing, expired, or unknown invocation scope" when a
 * concurrent invocation is in flight, "company context is required" when the
 * job runs alone. The repair (worker.ts,  reopen) tracks the
 * configured set in `knownCompanyIds`, fed by `onConfigChanged` and
 * persisted to instance state, and every scheduled job iterates
 * `listKnownCompanies()` instead of calling `ctx.companies.list()`.
 *
 * These four tests pin that repair for the lane poll:
 *  1. the job never calls `ctx.companies.list()` (a throwing spy stands in
 *     for the host denial) yet still polls the fed companies;
 *  2./3. a per-company host denial, in EACH of the two texts, fails that
 *     company closed while the healthy company's poll still lands;
 *  4. a company the host knows but never delivered config for is never
 *     polled — enumeration comes from the fed set, not the host list.
 */
const COMPANY_A = "co-1";
const COMPANY_B = "co-2";

// The two texts of the one host denial (see header).
const DENIAL_RACING_INVOCATION = "the worker referenced a missing, expired, or unknown invocation scope";
const DENIAL_RUNNING_ALONE = "company context is required";

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    selection: { enabled: true, mode: "enforce" },
    models: [],
    tierLabelIds: {},
    pacing: {
      mode: "enforce",
      lanes: [
        {
          laneId: "lane-a",
          statusUrl: "https://status.example.com/lane-a",
          windows: [{ name: "primary", role: "serviceability", utilizationFields: ["utilization"] }],
        },
      ],
    },
    ...overrides,
  };
}

async function boot(config: Record<string, unknown>, seedIds: string[], fedIds: string[]) {
  const harness = createTestHarness({ manifest, config });
  harness.seed({ companies: seedIds.map((id) => ({ id, name: id }) as never) });
  // Stand-in for the host denial: if the repaired code ever regresses to
  // `await ctx.companies.list()`, every test below goes red.
  let listCalls = 0;
  harness.ctx.companies.list = async () => {
    listCalls++;
    throw new Error(DENIAL_RACING_INVOCATION);
  };
  harness.ctx.http.fetch = (async () =>
    new Response(
      JSON.stringify({ observedAt: new Date().toISOString(), records: [{ health: "ok", utilization: 0.1 }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as never;
  const plugin = createPlugin();
  const setup = plugin.definition.setup;
  if (!setup) throw new Error("plugin definition has no setup handler");
  await setup(harness.ctx);
  // Mirror the host's real startup config-delivery sequence
  // (plugin-loader.ts step 5b): only fed companies become known.
  const onConfigChanged = plugin.definition.onConfigChanged;
  if (!onConfigChanged) throw new Error("plugin definition has no onConfigChanged handler");
  for (const id of fedIds) await onConfigChanged(config, { companyId: id });
  return { harness, listCalls: () => listCalls };
}

/** Fail one company's company-scoped host read with a scope-denial text. */
function denyCompanyConfig(harness: ReturnType<typeof createTestHarness>, companyId: string, message: string) {
  const inner = harness.ctx.config.get.bind(harness.ctx.config);
  harness.ctx.config.get = async (id?: string) => {
    if (id === companyId) throw new Error(message);
    return inner(id);
  };
}

async function ledgerFor(harness: ReturnType<typeof createTestHarness>, companyId: string) {
  return harness.ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: PLUGIN_STATE_KEYS.laneLedger,
  }) as Promise<Record<string, { error: string | null }> | null>;
}

function pollFailureFor(harness: ReturnType<typeof createTestHarness>, companyId: string) {
  return harness.logs.some(
    (entry) =>
      entry.level === "error" &&
      entry.message.includes("lane capacity poll failed for a company") &&
      (entry.meta as Record<string, unknown> | undefined)?.companyId === companyId,
  );
}

/**
 * Assert the company was actually polled: the ledger and its lane entry
 * must exist with no error. `ledger?.["lane-a"]?.error ?? null` alone is
 * `null` both when the poll succeeded AND when the company was silently
 * skipped (missing ledger) — this checks presence first so a skip fails
 * loudly instead of reading as a pass.
 */
async function expectHealthyPoll(harness: ReturnType<typeof createTestHarness>, companyId: string) {
  const ledger = await ledgerFor(harness, companyId);
  expect(ledger).not.toBeNull();
  const lane = ledger?.["lane-a"];
  expect(lane).toBeDefined();
  expect(lane?.error).toBeNull();
}

describe("pollLaneCapacity invocation scope (, repairs )", () => {
  it("polls the onConfigChanged-fed companies without calling ctx.companies.list()", async () => {
    // Named mutant: "restore `await ctx.companies.list()` in the poll job".
    // The spy throws, so the pre-repair line rejects the whole job and no
    // ledger lands — this test goes red.
    const { harness, listCalls } = await boot(baseConfig(), [COMPANY_A], [COMPANY_A]);

    await harness.runJob(JOB_KEYS.pollLanes);

    expect(listCalls()).toBe(0);
    await expectHealthyPoll(harness, COMPANY_A);
  });

  it("fails a company closed on the racing-invocation denial while the healthy company's poll lands", async () => {
    const { harness, listCalls } = await boot(baseConfig(), [COMPANY_A, COMPANY_B], [COMPANY_A, COMPANY_B]);
    denyCompanyConfig(harness, COMPANY_B, DENIAL_RACING_INVOCATION);

    await harness.runJob(JOB_KEYS.pollLanes);

    expect(listCalls()).toBe(0);
    await expectHealthyPoll(harness, COMPANY_A);
    expect(await ledgerFor(harness, COMPANY_B)).toBeNull();
    expect(pollFailureFor(harness, COMPANY_B)).toBe(true);
  });

  it("fails a company closed on the running-alone denial while the healthy company's poll lands", async () => {
    const { harness, listCalls } = await boot(baseConfig(), [COMPANY_A, COMPANY_B], [COMPANY_A, COMPANY_B]);
    denyCompanyConfig(harness, COMPANY_B, DENIAL_RUNNING_ALONE);

    await harness.runJob(JOB_KEYS.pollLanes);

    expect(listCalls()).toBe(0);
    await expectHealthyPoll(harness, COMPANY_A);
    expect(await ledgerFor(harness, COMPANY_B)).toBeNull();
    expect(pollFailureFor(harness, COMPANY_B)).toBe(true);
  });

  it("never polls a company the host never delivered config for", async () => {
    // COMPANY_B is seeded (the host knows it) but never fed through
    // `onConfigChanged`, so the repaired enumeration must skip it. A
    // `ctx.companies.list()` enumeration would poll it instead — and with
    // the boot spy throwing, it would abort the whole job.
    const { harness, listCalls } = await boot(baseConfig(), [COMPANY_A, COMPANY_B], [COMPANY_A]);

    await harness.runJob(JOB_KEYS.pollLanes);

    expect(listCalls()).toBe(0);
    await expectHealthyPoll(harness, COMPANY_A);
    expect(await ledgerFor(harness, COMPANY_B)).toBeNull();
  });
});
