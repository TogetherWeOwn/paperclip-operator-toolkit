import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TOOL_NAMES, PLUGIN_STATE_KEYS } from "../src/constants.js";
import type { ModelEntry } from "../src/engine/types.js";
import manifest from "../src/manifest.js";
import { createPlugin } from "../src/worker.js";
import { MODELS, NO_ESCALATION, NOW, PROFILES } from "./fixtures.js";

/**
 *  — Router guard: advisory-mode pin-writer audit (read-only
 * inventory, propose-only; no behavior change).
 *
 * Static inventory (origin/main @09c584389; line numbers are `~` where the
 * file shifts often — the gate comment `` marks each site):
 *
 * Gate (single): `selectionWritesAllowed` (`actuate/apply.ts:~206`) =
 * `selection.enabled && selection.mode === "enforce"`. The engine marks a
 * decision `advisory` exactly when `enforcementEnabled` is false
 * (`engine/select.ts:474`), and `planApply` refuses advisory decisions
 * (`actuate/apply.ts:157`). Every `advise()` call site plumbs
 * `enforcementEnabled: selectionWritesAllowed(config)` (`worker.ts:1321`).
 *
 * Pin-write sites (a "pin write" = an `issues.update` carrying
 * `assigneeAdapterOverrides`, or clearing it):
 *  1. apply tool — `worker.ts:~1570` (`planApply`), `~1603` (`!plan.write`
 *     return), `~1620`/`~1649` (patch + update). Gated twice: `planApply`
 *     refuses advisory AND `enforcementEnabled` forces `decision.advisory`.
 *     Covered: `apply.spec.ts` (unit) + `worker.spec.ts` "writes nothing in
 *     advise mode even from the apply tool" (harness).
 *  2. creation-time pin — `worker.ts:~2258` (`writesAllowed`) / `~2260`.
 *     Covered: `creation-pin.spec.ts`  suite (advise + disabled).
 *  3. labelOnlyPass — `worker.ts:~4840` / `~4998`. Covered:
 *     `scheduled-passes.spec.ts`  suite (label-only case).
 *  4. repinPass clear-on-blocked — `worker.ts:~5127` / `~5242`
 *     (`assigneeAdapterOverrides: null`). Covered: blocked-clear case.
 *  5. repinPass re-pin — `worker.ts:~5388`. Covered: demoted-pin case.
 *  6. repairPinEnvAfterConfigFailure — `worker.ts:~5511`
 *     (`result.decision.advisory` early return) / `~5535`. Unit-covered
 *     (`pin-env-repair.spec.ts` "writes nothing in advisory mode"), harness
 *     covered ONLY for `selection.mode: "shadow"` (ibid.:214 — not even a
 *     valid selection mode per `config/schema.ts:49`, enum is
 *     advise/enforce). NO harness proof for mode "advise" or for
 *     selection-disabled. **This spec closes that gap.**
 *  7. balancePass pinned branch — `worker.ts:~5709` / `~6066`. Covered:
 *     pinned-card case.
 *  8. balancePass unpinned branch — `worker.ts:~6188`. Covered: unpinned
 *     labelled-card case.
 *  9. runResolve handler — `worker.ts:~2010` (`runResolveActive` requires
 *     `selectionWritesAllowed`); the engine builds that path with
 *     `enforcementEnabled: true` (`engine/run-resolve.ts:187`) precisely
 *     because the handler is unreachable otherwise. Covered:
 *     `run-resolve-worker.spec.ts:163` ("answers keep on an advisory
 *     install even with the flag on") + `:581` (legacy paths NOT retired
 *     in advisory, so routing still answers `keep`).
 *
 * Non-pin writes verified out of scope (not `assigneeAdapterOverrides`):
 * classifyIssues / creation-classifier label writes (`worker.ts:~2158`,
 * `~4403` — `labelIds` only, labels are not pins by design);
 * tier-exhausted `Operator:` escalation `issues.create` (`worker.ts:~595` —
 * a separate triage issue, deliberately ungated by selection mode);
 * `pinPinnedAt` lifecycle-clock `ctx.state.set` (re-stamp on re-affirmed
 * expiry — plugin state, never an issue override); activity logs; shadow
 * JSONL. NOTE (propose-only observation, not a finding): the repinPass
 * same-model re-stamp (`~5330`) and fallback-sideways re-stamp run before
 * the `writesAllowed` branch — they write plugin state in advisory
 * installs, which is consistent with "walk rows, write no override", but a
 * future reader could mistake the state write for a pin write. No change
 * proposed here.
 *
 * Verdict: NO site writes (or clears) `assigneeAdapterOverrides` outside
 * an enforce-gated path. Static audit: PASS. The only missing behavioral
 * proof was site 6 in the two real non-enforcing postures — the five
 * tests below supply it (four advisory no-write proofs + one enforce
 * positive control so the gate is not vacuous).
 */

const ref = (secretId: string) => ({ type: "secret_ref", secretId, version: "latest" });

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

function card(overrideEnv: Record<string, unknown>): Issue {
  return {
    id: ISSUE, companyId: COMPANY, title: "Engineering hotfix", priority: "critical", status: "in_progress",
    assigneeAgentId: "agent-1", assigneeUserId: null, checkoutRunId: null, executionRunId: null,
    labels: [], labelIds: [], assigneeAdapterOverrides: { adapterConfig: { model: PIN, env: overrideEnv } },
  } as unknown as Issue;
}

async function boot(issue: Issue, selection: Record<string, unknown>) {
  const pluginConfig = {
    models: roster(),
    classification: { enabled: true },
    selection: { defaultTier: "T3", fleetContextCeilingTokens: 200_000, ...selection },
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

async function overrideEnv(harness: Awaited<ReturnType<typeof boot>>) {
  const issue = await harness.ctx.issues.get(ISSUE, COMPANY);
  return (issue?.assigneeAdapterOverrides as { adapterConfig: { model: string; env: Record<string, unknown> } }).adapterConfig;
}

const repairs = (harness: Awaited<ReturnType<typeof boot>>) =>
  harness.activity.filter((entry) => entry.message.includes("repaired the env") && entry.entityId === ISSUE);

const failConfig = (harness: Awaited<ReturnType<typeof boot>>) =>
  harness.emit("agent.run.failed", { issueId: ISSUE, runId: "run-9", errorCode: "configuration_incomplete", error: "missing binding" }, { companyId: COMPANY });

const poisoned = () => ({ STALE: ref("former-assignee-secret"), KEEP: ref("agent-secret") });

describe(" advisory pin-writer audit: the env-repair path writes no pin outside enforce", () => {
  it("positive control: enforce mode heals the poisoned pin after configuration_incomplete", async () => {
    const harness = await boot(card(poisoned()), { enabled: true, mode: "enforce" });
    await failConfig(harness);
    expect((await overrideEnv(harness)).env).not.toHaveProperty("STALE");
    expect(repairs(harness)).toHaveLength(1);
  });

  it("repair handler writes nothing in advise mode (pin preserved, no repair logged)", async () => {
    const harness = await boot(card(poisoned()), { enabled: true, mode: "advise" });
    await failConfig(harness);
    expect((await overrideEnv(harness)).env).toHaveProperty("STALE");
    expect(repairs(harness)).toHaveLength(0);
  });

  it("repair handler writes nothing when selection is disabled (pin preserved, no repair logged)", async () => {
    const harness = await boot(card(poisoned()), { enabled: false, mode: "enforce" });
    await failConfig(harness);
    expect((await overrideEnv(harness)).env).toHaveProperty("STALE");
    expect(repairs(harness)).toHaveLength(0);
  });

  it("apply tool performs no env repair in advise mode on a poisoned pin", async () => {
    const harness = await boot(card(poisoned()), { enabled: true, mode: "advise" });
    const result = (await harness.executeTool(TOOL_NAMES.apply, { issueId: ISSUE }, runCtx)) as {
      content: string; data: { plan: { write: boolean } };
    };
    expect(result.data.plan.write).toBe(false);
    expect(result.content).toContain("No write");
    expect((await overrideEnv(harness)).env).toHaveProperty("STALE");
    expect(repairs(harness)).toHaveLength(0);
  });

  it("apply tool performs no env repair when selection is disabled", async () => {
    const harness = await boot(card(poisoned()), { enabled: false, mode: "enforce" });
    const result = (await harness.executeTool(TOOL_NAMES.apply, { issueId: ISSUE }, runCtx)) as {
      content: string; data: { plan: { write: boolean } };
    };
    expect(result.data.plan.write).toBe(false);
    expect((await overrideEnv(harness)).env).toHaveProperty("STALE");
    expect(repairs(harness)).toHaveLength(0);
  });
});
