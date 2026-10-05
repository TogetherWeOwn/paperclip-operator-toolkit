import { describe, expect, it } from "vitest";

import { planApply } from "../src/actuate/apply.js";
import { selectModel } from "../src/engine/select.js";
import type { LaneLedger } from "../src/engine/pacing.js";
import type { ModelEntry } from "../src/engine/types.js";
import { evaluateLanePace, normalizeLaneDocument, type LanePaceDefinition, type LanePaceVerdict } from "../src/lane-capacity/pace.js";
import { MODELS, NO_ESCALATION, NOW, PROFILES, config } from "./fixtures.js";

const base = { profiles: PROFILES, signals: NO_ESCALATION, now: NOW };

function model(baseModel: ModelEntry, overrides: Partial<ModelEntry>): ModelEntry {
  return { ...baseModel, ...overrides };
}

/**
 * . The 2026-09-16 22:29-22:52Z storm: cliproxy-claude served 52
 * 429'd runs while its lane verdict read `state:"on", serviceable:true` —
 * claude-lane-1's five_hour SERVICEABILITY window sat at 1.0 behind a
 * seven_day allowance at 0.84, and the pace engine only hard-stopped a lane
 * when every account was unserviceable. cliproxy does not fail over within a
 * lane (it kept routing to the blown account through the whole storm), so
 * the any-serviceable-account roll-up overstated the lane.
 *
 * The withdrawn engine fix, re-derived locally in  (no upstream
 * write or deployment): a serviceability window at, or within
 * the pace margin of, 1.0 poisons the lane — `state:"exhausted"`,
 * `serviceable:false`, `reason:"serviceability-window-exhausted"`,
 * `urgentResetAt` = the earliest tripped window's resetsAt.
 *
 *  revision (owner-directed, operator update 22:40Z on ): the
 * lane-level condemnation above fires ONLY when no account can still serve
 * (`serviceableAccountCount == 0`). The 52-run evidence stands, but it is a
 * claim about where the provider routes — cliproxy kept hitting the BLOWN
 * account — so it is enforced at the account level, where the provider
 * actually routes: the tripped account still reads `serviceable:false`,
 * `state:"exhausted"`, `recommendedShare: 0`, and the host controller
 * disables its auth. A healthy sibling keeps the lane open. The tests below
 * that asserted any-trip poisoning now assert the count-gated predicate;
 * every assertion that still holds (single tripped account, all-tripped
 * lanes, margin boundaries) is unchanged.
 *
 * Every document below is live telemetry fetched 2026-09-16T23:13:12Z,
 * mid-incident, from the configured lane status URLs (fetch evidence on the
 *  card). Definitions and margins mirror the live pacing config.
 */
const LIVE_OBSERVED_AT = "2026-09-16T23:13:12.071592Z";

const CLAUDE: LanePaceDefinition = {
  laneId: "cliproxy-claude",
  healthFields: ["health"],
  // The captured CLIProxy documents identify an account by `lane`; the default
  // key fields (account_key/accountKey/name/id) do not appear in them.
  accountKeyFields: ["lane"],
  windows: [
    { name: "five-hour", role: "serviceability", utilizationFields: ["five_hour_utilization"], resetFields: ["five_hour_resets_at"] },
    { name: "seven_day", role: "allowance", utilizationFields: ["seven_day_utilization"], resetFields: ["seven_day_resets_at"] },
  ],
};

const CODEX: LanePaceDefinition = {
  laneId: "cliproxy-codex",
  healthFields: ["health"],
  // The captured CLIProxy documents identify an account by `lane`; the default
  // key fields (account_key/accountKey/name/id) do not appear in them.
  accountKeyFields: ["lane"],
  windows: [
    { name: "five-hour", role: "serviceability", utilizationFields: ["five_hour_utilization"], resetFields: ["five_hour_resets_at"] },
    { name: "weekly", role: "allowance", utilizationFields: ["weekly_utilization"], resetFields: ["weekly_resets_at"] },
    { name: "monthly", role: "serviceability", utilizationFields: ["monthly_utilization"], resetFields: ["monthly_resets_at"] },
  ],
};

const OPENCODE_GO: LanePaceDefinition = {
  laneId: "cliproxy-opencode-go",
  healthFields: ["health"],
  // The captured CLIProxy documents identify an account by `lane`; the default
  // key fields (account_key/accountKey/name/id) do not appear in them.
  accountKeyFields: ["lane"],
  windows: [
    { name: "five-hour", role: "serviceability", utilizationFields: ["five_hour_utilization"], resetFields: ["five_hour_resets_at"] },
    { name: "weekly", role: "allowance", utilizationFields: ["weekly_utilization"], resetFields: ["weekly_resets_at"] },
    { name: "monthly", role: "serviceability", utilizationFields: ["monthly_utilization"], resetFields: ["monthly_resets_at"] },
  ],
};

const ZAI: LanePaceDefinition = {
  laneId: "cliproxy-zai",
  healthFields: ["health"],
  // The captured CLIProxy documents identify an account by `lane`; the default
  // key fields (account_key/accountKey/name/id) do not appear in them.
  accountKeyFields: ["lane"],
  windows: [
    { name: "five-hour", role: "serviceability", utilizationFields: ["five_hour_utilization"], resetFields: ["five_hour_resets_at"] },
    { name: "weekly", role: "allowance", utilizationFields: ["weekly_utilization"], resetFields: ["weekly_resets_at"] },
  ],
};

const CLAUDE_LIVE = {
  schemaVersion: 1, observedAt: LIVE_OBSERVED_AT, staleAfterSeconds: 300,
  records: [
    { lane: "claude-lane-1", health: "degraded", weight: 1, governing_window: "seven_day", window_seconds: { five_hour: 18000, seven_day: 604800 }, five_hour_utilization: 1.0, five_hour_resets_at: "2026-09-16T23:20:00.443210Z", seven_day_utilization: 0.84, seven_day_resets_at: "2026-09-18T19:00:00.443239Z" },
    { lane: "claude-lane-2", health: "healthy", weight: 1, governing_window: "seven_day", window_seconds: { five_hour: 18000, seven_day: 604800 }, five_hour_utilization: 0.05, five_hour_resets_at: "2026-09-17T03:30:00.666229Z", seven_day_utilization: 0.71, seven_day_resets_at: "2026-09-19T09:59:59.666254Z" },
  ],
};

/**
 *  fixtures: every account blown, so `serviceableAccountCount == 0`
 * and the count-gated trip still fires. The live storm documents above keep a
 * healthy sibling and now SERVE — that is the fix, not a fixture rot.
 */
const CLAUDE_ALL_TRIPPED = {
  ...CLAUDE_LIVE,
  records: [CLAUDE_LIVE.records[0], { ...CLAUDE_LIVE.records[1], five_hour_utilization: 1.0 }],
};

const CODEX_LIVE = {
  schemaVersion: 1, observedAt: LIVE_OBSERVED_AT, staleAfterSeconds: 300,
  records: [
    { lane: "codex-lane-1", health: "exhausted", weight: 1, governing_window: "weekly", window_seconds: { weekly: 604800 }, weekly_utilization: 1.0, weekly_resets_at: "2026-09-19T11:12:45Z" },
    { lane: "codex-lane-2", health: "exhausted", weight: 1, governing_window: "weekly", window_seconds: { weekly: 604800 }, weekly_utilization: 1.0, weekly_resets_at: "2026-09-19T11:14:09Z" },
    { lane: "codex-lane-3", health: "exhausted", weight: 1, governing_window: "weekly", window_seconds: { weekly: 604800 }, weekly_utilization: 1.0, weekly_resets_at: "2026-09-19T11:12:50Z" },
  ],
};

const OPENCODE_GO_LIVE = {
  schemaVersion: 1, observedAt: LIVE_OBSERVED_AT, staleAfterSeconds: 300,
  records: [
    { lane: "opencode-go-lane-1", health: "healthy", weight: 1, governing_window: "monthly", window_seconds: { five_hour: 18000, weekly: 604800, monthly: 2592000 }, five_hour_utilization: 0.81, five_hour_resets_at: "2026-09-14T10:40:11.157000Z", monthly_utilization: 0.33, monthly_resets_at: "2026-10-12T07:01:00.157000Z", weekly_utilization: 0.61, weekly_resets_at: "2026-09-21T00:00:00.157000Z" },
    { lane: "opencode-go-lane-2", health: "healthy", weight: 1, governing_window: "monthly", window_seconds: { five_hour: 18000, weekly: 604800, monthly: 2592000 }, five_hour_utilization: 0.0, five_hour_resets_at: "2026-09-17T04:13:14.988000Z", monthly_utilization: 0.99, monthly_resets_at: "2026-09-23T12:57:28.988000Z", weekly_utilization: 0.0, weekly_resets_at: "2026-09-21T00:00:00.988000Z" },
    { lane: "opencode-go-lane-3", health: "healthy", weight: 1, governing_window: "monthly", window_seconds: { five_hour: 18000, weekly: 604800, monthly: 2592000 }, five_hour_utilization: 0.0, five_hour_resets_at: "2026-09-17T04:13:14.985000Z", monthly_utilization: 0.95, monthly_resets_at: "2026-10-06T15:20:39.985000Z", weekly_utilization: 0.08, weekly_resets_at: "2026-09-21T00:00:00.985000Z" },
  ],
};

const ZAI_LIVE = {
  schemaVersion: 1, observedAt: LIVE_OBSERVED_AT, staleAfterSeconds: 300,
  records: [
    { lane: "zai-lane-1", health: "healthy", weight: 1, governing_window: "weekly", window_seconds: { five_hour: 18000, weekly: 604800 }, five_hour_utilization: 0.129, five_hour_resets_at: "2026-09-17T03:51:12Z", weekly_utilization: 0.3656, weekly_resets_at: "2026-09-22T04:09:05Z" },
  ],
};

function liveVerdict(definition: LanePaceDefinition, document: unknown, margin?: number): LanePaceVerdict {
  return evaluateLanePace({
    observation: normalizeLaneDocument({ document, definition }),
    asOf: LIVE_OBSERVED_AT,
    policy: margin === undefined ? undefined : { margin },
  });
}

function ledgerOf(entries: Array<[string, LanePaceVerdict]>): LaneLedger {
  const ledger: LaneLedger = {};
  for (const [laneId, verdict] of entries) {
    ledger[laneId] = { laneId, verdict, fetchedAt: LIVE_OBSERVED_AT, error: null, observation: null };
  }
  return ledger;
}

/**
 * The T1 roster as actually ENABLED on the live config
 * (`ops/model-selection/deploy-20260916T173055Z--final/model-selection-before.json`,
 * re-measured 2026-09-17): T1 exists on exactly two lanes.
 *
 *   T1 cliproxy-claude : claude-opus-5, claude-fable-5-1
 *   T1 cliproxy-codex  : gpt-5.6-sol, gpt-6-astra
 *
 * zai and opencode-go carry T2/T3 rows only — zero enabled T1.  (the
 * 173055Z payload) adds T1 on zai/opencode-go/antigravity and was still `todo`
 * when this was written, so `stormModels()` below describes the POST-2990
 * board, not today's.
 */
function liveT1Models(): ModelEntry[] {
  const t1 = MODELS.find((entry) => entry.tier === "T1")!;
  const lane = (id: string, laneId: string, costPerMTokIn: number): ModelEntry =>
    model(t1, { id, laneId, costPerMTokIn, costPerMTokOut: costPerMTokIn * 5, costPerMTokCacheRead: costPerMTokIn / 10 });
  return [
    lane("claude-opus-5", "cliproxy-claude", 1),
    lane("claude-fable-5-1", "cliproxy-claude", 2),
    lane("gpt-5.6-sol", "cliproxy-codex", 3),
    lane("gpt-6-astra", "cliproxy-codex", 4),
  ];
}

/** The storm board: one T1 model per live lane, cheapest first. */
function stormModels(): ModelEntry[] {
  const t1 = MODELS.find((entry) => entry.tier === "T1")!;
  const lane = (id: string, laneId: string, costPerMTokIn: number): ModelEntry =>
    model(t1, { id, laneId, costPerMTokIn, costPerMTokOut: costPerMTokIn * 5, costPerMTokCacheRead: costPerMTokIn / 10 });
  return [
    lane("storm-claude", "cliproxy-claude", 1),
    lane("storm-opencode-go", "cliproxy-opencode-go", 2),
    lane("storm-codex", "cliproxy-codex", 3),
    lane("storm-zai", "cliproxy-zai", 5),
  ];
}

describe(": hard-stop boundaries and precedence", () => {
  it.each([
    [0.899, 0.1, true],
    [0.9, 0.1, false],
    [0.799, 0.2, true],
    [0.8, 0.2, false],
    [0.999, 0, true],
    [1, 0, false],
  ])("utilization %s with margin %s is serviceable=%s", (utilization, margin, serviceable) => {
    const verdict = liveVerdict(CLAUDE, {
      ...CLAUDE_LIVE,
      records: [{ ...CLAUDE_LIVE.records[1], five_hour_utilization: utilization }],
    }, margin);
    expect(verdict.serviceable).toBe(serviceable);
    expect(verdict.accounts[0]).toMatchObject({ serviceable });
    if (!serviceable) {
      expect(verdict.reason).toBe("serviceability-window-exhausted");
      expect(verdict.accounts[0]).toMatchObject({ state: "exhausted" });
    }
  });

  it.each([
    { weight: null },
    { governing_window: "missing" },
  ])("a healthy peer's indeterminate capacity cannot mask a trip: %j", (override) => {
    const peer = { ...CLAUDE_LIVE.records[1], ...override };
    const control = liveVerdict(CLAUDE, { ...CLAUDE_LIVE, records: [peer] });
    expect(control.state).toBe("unknown");
    expect(control.serviceable).toBeNull();
    const verdict = liveVerdict(CLAUDE, { ...CLAUDE_LIVE, records: [peer, CLAUDE_LIVE.records[0]] });
    expect(verdict).toMatchObject({
      state: "exhausted", serviceable: false, reason: "serviceability-window-exhausted",
      urgentResetAt: "2026-09-16T23:20:00.443Z", targetBurnRate: 0, observedBurnRate: 0, deficit: 0,
    });
  });

  it("trips without a reset or computable governor and does not invent relief", () => {
    const verdict = liveVerdict(CLAUDE, {
      ...CLAUDE_LIVE,
      records: [{ ...CLAUDE_LIVE.records[0], five_hour_resets_at: null, governing_window: "missing" }],
    });
    expect(verdict).toMatchObject({
      state: "exhausted", serviceable: false, urgentResetAt: null, reason: "serviceability-window-exhausted",
    });
    expect(verdict.accounts[0]).toMatchObject({ state: "exhausted", serviceable: false });
  });

  it("reports the earliest tripped reset regardless of account order", () => {
    const verdict = liveVerdict(OPENCODE_GO, {
      ...OPENCODE_GO_LIVE, records: [...OPENCODE_GO_LIVE.records].reverse(),
    });
    expect(verdict.reason).toBe("serviceability-window-exhausted");
    expect(verdict.urgentResetAt).toBe("2026-09-23T12:57:28.988Z");
  });
});

describe(": a tripped serviceability window is a hard stop", () => {
  it("reads the exact storm document (7d 0.84 + 5h 1.0) as not serviceable", () => {
    const verdict = liveVerdict(CLAUDE, { ...CLAUDE_LIVE, records: [CLAUDE_LIVE.records[0]] });
    expect(verdict.serviceable).toBe(false);
    expect(verdict.state).toBe("exhausted");
    expect(verdict.reason).toBe("serviceability-window-exhausted");
    expect(verdict.urgentResetAt).toBe("2026-09-16T23:20:00.443Z");
    expect(verdict.accounts[0]).toMatchObject({ serviceable: false, state: "exhausted" });
  });

  it("lets the healthy peer account carry the lane while the tripped account stays excluded", () => {
    // : the count-gated predicate. The lane serves through the
    // healthy sibling, and the tripped account is excluded at the account
    // level — serviceable:false, state:"exhausted", recommendedShare 0 — so
    // dispatch never rides it. That per-account exclusion is what carries
    // 's no-failover evidence now.
    const verdict = liveVerdict(CLAUDE, CLAUDE_LIVE);
    expect(verdict.serviceable).toBe(true);
    expect(verdict.state).toBe("on");
    expect(verdict.reason).toBe("ok");
    expect(verdict.serviceableAccountCount).toBe(1);
    expect(verdict.accounts[0]).toMatchObject({ serviceable: false, state: "exhausted", recommendedShare: 0 });
    expect(verdict.accounts[1]).toMatchObject({ serviceable: true, state: "on", recommendedShare: 1 });
  });

  it("still hard-stops when every account is tripped (serviceableAccountCount == 0)", () => {
    // The preserved half of the old assertion: with nothing left to serve,
    // the count-gated trip fires exactly as  specified.
    const verdict = liveVerdict(CLAUDE, CLAUDE_ALL_TRIPPED);
    expect(verdict.serviceable).toBe(false);
    expect(verdict.state).toBe("exhausted");
    expect(verdict.reason).toBe("serviceability-window-exhausted");
    expect(verdict.serviceableAccountCount).toBe(0);
    expect(verdict.urgentResetAt).toBe("2026-09-16T23:20:00.443Z");
  });

  it("measures the opencode-go monthly windows (0.99 / 0.95) as tripped too", () => {
    const verdict = liveVerdict(OPENCODE_GO, OPENCODE_GO_LIVE);
    expect(verdict.serviceable).toBe(false);
    expect(verdict.serviceableAccountCount).toBe(0);

    // This lane would ALSO be caught by the pre-existing
    // `all-accounts-unserviceable` exit, so the reason is the load-bearing
    // assertion: the trip check runs FIRST, and only that path reports the
    // reset. `all-accounts-unserviceable` returns `urgentResetAt: null`, which
    // would leave a caller with no idea when the lane comes back.
    expect(verdict.reason).toBe("serviceability-window-exhausted");
    // Earliest relief among the tripped monthly windows: go-2, 2026-09-23.
    expect(verdict.urgentResetAt).toBe("2026-09-23T12:57:28.988Z");
  });

  it("fallback proof: claude condemned + codex exhausted selects a live lane, never a 429 lane", () => {
    // : "condemned" now means every account blown
    // (serviceableAccountCount == 0), so this board uses CLAUDE_ALL_TRIPPED.
    // The count-gated trip fires exactly as  specified; the pick
    // lands on a live lane, never a 429 lane.
    const ledger = ledgerOf([
      ["cliproxy-claude", liveVerdict(CLAUDE, CLAUDE_ALL_TRIPPED)],
      ["cliproxy-codex", liveVerdict(CODEX, CODEX_LIVE, 0.2)],
      ["cliproxy-opencode-go", liveVerdict(OPENCODE_GO, OPENCODE_GO_LIVE)],
      ["cliproxy-zai", liveVerdict(ZAI, ZAI_LIVE)],
    ]);
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "ex-3107", labelNames: ["tier:T1"] },
      config: config({ models: stormModels(), laneLedger: ledger }),
    });
    expect(decision.outcome).toBe("selected");
    // Z.ai is the only serviceable lane left on this board — the pick
    // must land there, not on the claude/codex/opencode-go 429 lanes.
    expect(decision.modelId).toBe("storm-zai");
    for (const dead of ["storm-claude", "storm-codex", "storm-opencode-go"]) {
      expect(decision.rejections.some((r) => r.stage === "lane-unserviceable" && r.modelId === dead)).toBe(true);
    }
  });

  it(" regression: one tripped account + healthy sibling serves at dispatch level", () => {
    // The card's acceptance test, measured at the selectModel level: the
    // live storm board — claude-lane-1 at 5h 1.0, claude-lane-2 healthy —
    // now serves through the sibling, so the cheapest model storm-claude
    // wins. codex/opencode-go stay rejected lane-unserviceable. The blown
    // account itself carries share 0 (proven in the lane-level test above),
    // so dispatch never rides it.
    const ledger = ledgerOf([
      ["cliproxy-claude", liveVerdict(CLAUDE, CLAUDE_LIVE)],
      ["cliproxy-codex", liveVerdict(CODEX, CODEX_LIVE, 0.2)],
      ["cliproxy-opencode-go", liveVerdict(OPENCODE_GO, OPENCODE_GO_LIVE)],
      ["cliproxy-zai", liveVerdict(ZAI, ZAI_LIVE)],
    ]);
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "ex-7648", labelNames: ["tier:T1"] },
      config: config({ models: stormModels(), laneLedger: ledger }),
    });
    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe("storm-claude");
    for (const dead of ["storm-codex", "storm-opencode-go"]) {
      expect(decision.rejections.some((r) => r.stage === "lane-unserviceable" && r.modelId === dead)).toBe(true);
    }
  });

  it("counter-proof: drop the tripped claude account and the cheap claude lane wins again", () => {
    // Isolates the single variable. Same board, same ledger, same tier — the
    // ONLY change is that claude-lane-1 (5h 1.0) is removed, leaving the
    // healthy peer claude-lane-2 (5h 0.05, 7d 0.71). The lane comes back and
    // storm-claude, the cheapest model on the board, wins the pick again. So
    // claude's exclusion in the fallback proof above is attributable to the
    // tripped window and nothing else.
    const healthyClaude = { ...CLAUDE_LIVE, records: [CLAUDE_LIVE.records[1]] };
    const ledger = ledgerOf([
      ["cliproxy-claude", liveVerdict(CLAUDE, healthyClaude)],
      ["cliproxy-codex", liveVerdict(CODEX, CODEX_LIVE, 0.2)],
      ["cliproxy-opencode-go", liveVerdict(OPENCODE_GO, OPENCODE_GO_LIVE)],
      ["cliproxy-zai", liveVerdict(ZAI, ZAI_LIVE)],
    ]);
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "ex-3107", labelNames: ["tier:T1"] },
      config: config({ models: stormModels(), laneLedger: ledger }),
    });
    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe("storm-claude");
  });

  it("control: with no claude verdict at all (fail-neutral), the cheap claude model wins", () => {
    // Positive control for the two proofs above: the storm-claude model is
    // the cheapest on the board, so its exclusion in those proofs is the
    // lane verdict doing the work — not price or tier ordering.
    const ledger = ledgerOf([
      ["cliproxy-zai", liveVerdict(ZAI, ZAI_LIVE)],
    ]);
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "ex-3107", labelNames: ["tier:T1"] },
      config: config({ models: stormModels(), laneLedger: ledger }),
    });
    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe("storm-claude");
  });
});

/**
 *  requirement 3, measured on the roster that is actually deployed.
 *
 * 's review raised this: with T1 enabled only on cliproxy-claude and
 * cliproxy-codex, tripping both leaves T1 with no candidate at all, so the
 * `stormModels()` proofs above are green over a candidate set that cannot
 * exist until  lands (still `todo` as of 2026-09-17).
 *
 * The roster half of that is correct and re-measured here. The consequence is
 * not. The empty set is neither a 429 nor a silent dead end: every survivor
 * was rejected `lane-unserviceable`, so `selectModel` returns the 
 * `tier-exhausted` outcome (`src/engine/select.ts:467`) rather than the
 * generic `no-eligible-model` — and that outcome is the one `worker.ts`
 * escalates to an `Operator:` card. `planApply` then refuses to write on any
 * non-`selected` outcome (`src/actuate/apply.ts:80`), so no
 * `assigneeAdapterOverrides` pin is produced and the run starts on the agent
 * floor.
 *
 * So requirement 3 — "never a 429" — holds today through the FLOOR plus an
 * operator escalation, not through the pin. That makes it contingent on where
 * the floor points: Z.ai `glm-5.3` per the  operator stopgap
 * (verified in-run: `PAPERCLIP_ASSIGNED_MODEL=glm-5.3`). If the floor is
 * returned to claude-opus-5 before  is applied, this fail-through
 * lands back on the 429 lane and requirement 3 breaks — no test here can
 * catch that, because the floor is not this plugin's to read. That is the
 * standing risk these cases exist to pin.
 *
 * NOTE: enforcement is ON in every case below. The fixture default is
 * `enforcementEnabled: false`, and `planApply` short-circuits on `advisory`
 * BEFORE it reaches the outcome gate — so a no-write assertion under the
 * default would pass without the gate under test ever running.
 */
describe(" requirement 3 on the pre-2990 live roster", () => {
  // : "both T1 lanes tripped" now means every account blown
  // (serviceableAccountCount == 0), so the claude entry uses
  // CLAUDE_ALL_TRIPPED. A single tripped account beside a healthy sibling
  // SERVES under the count-gated predicate — that is the fix, proven in the
  // regression test above — and would turn the tier-exhausted assertions
  // below into selections.
  const stormLedger = (): LaneLedger =>
    ledgerOf([
      ["cliproxy-claude", liveVerdict(CLAUDE, CLAUDE_ALL_TRIPPED)],
      ["cliproxy-codex", liveVerdict(CODEX, CODEX_LIVE, 0.2)],
      ["cliproxy-opencode-go", liveVerdict(OPENCODE_GO, OPENCODE_GO_LIVE)],
      ["cliproxy-zai", liveVerdict(ZAI, ZAI_LIVE)],
    ]);

  const liveDecision = () =>
    selectModel({
      ...base,
      descriptor: { issueId: "ex-3107", labelNames: ["tier:T1"] },
      config: config({ models: liveT1Models(), laneLedger: stormLedger(), enforcementEnabled: true }),
    });

  it("is tier-exhausted, not a 429 and not a generic config gap", () => {
    const decision = liveDecision();

    // `tier-exhausted` specifically: it is reached only when EVERY candidate
    // at or above the required tier was excluded by the serviceability hard
    // stop. A single disabled/capability/context rejection in the mix would
    // downgrade it to `no-eligible-model`, so this also proves the emptiness
    // is capacity, not a misconfigured roster.
    expect(decision.outcome).toBe("tier-exhausted");
    expect(decision.modelId).toBeNull();
    for (const dead of ["claude-opus-5", "claude-fable-5-1", "gpt-5.6-sol", "gpt-6-astra"]) {
      expect(decision.rejections.some((r) => r.stage === "lane-unserviceable" && r.modelId === dead)).toBe(true);
    }
    // No survivor was rejected for any non-capacity reason.
    expect(decision.rejections.every((r) => r.stage === "lane-unserviceable")).toBe(true);
  });

  it("writes no pin on that outcome, so the run falls through to the agent floor", () => {
    const decision = liveDecision();
    // Guard: enforcement must really be on, or the assertion below passes via
    // the advisory short-circuit and never exercises the outcome gate.
    expect(decision.advisory).toBe(false);

    const plan = planApply(
      decision,
      { hasExistingOverride: false, hasExistingTierLabel: false, status: "todo" },
      "ex-3107",
    );

    expect(plan.write).toBe(false);
    expect(plan.modelId).toBeNull();
    expect(plan.reason).toBe("no model selected (outcome tier-exhausted)");
  });

  it("control: the same roster and a healthy claude lane DOES pin — the lane verdict is what empties the set", () => {
    // Positive control. Without it, `no-eligible-model` above could equally be
    // a broken fixture (bad tier, uncostable profile) rather than the hard
    // stop doing its job. Same models, same tier, only the claude verdict
    // swapped for its healthy peer account alone.
    const healthyClaude = { ...CLAUDE_LIVE, records: [CLAUDE_LIVE.records[1]] };
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "ex-3107", labelNames: ["tier:T1"] },
      config: config({
        models: liveT1Models(),
        enforcementEnabled: true,
        laneLedger: ledgerOf([
          ["cliproxy-claude", liveVerdict(CLAUDE, healthyClaude)],
          ["cliproxy-codex", liveVerdict(CODEX, CODEX_LIVE, 0.2)],
        ]),
      }),
    });

    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe("claude-opus-5");
  });
});

