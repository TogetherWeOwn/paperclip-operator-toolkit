/**
 * TOG-5007 (TOG-4713 D1d). cliproxy-insight is the one plugin beyond
 * model-selection's TOG-4763 fix that registers agent tools. The Paperclip
 * tool gateway maps a plugin result to
 * `structuredContent: result?.data ?? null`, and the Claude client rejects a
 * null `structuredContent` — every tool call that returned only `{error}`
 * (or no `data` at all) failed schema validation in Claude Code.
 *
 * `get_provider_usage` is that plugin's only tool, and its two rejection
 * paths (missing `companyId`, unconfigured company) returned `{error}`
 * with no `data`. Every path — success and rejection alike — must therefore
 * return a plain-object `data`, mirroring the `tool-result-data.spec.ts`
 * contract TOG-4763 established for model-selection.
 */

import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import manifest from "../src/manifest.js";
import { STATE_KEYS, TOOL_NAMES } from "../src/constants.js";
import { createPlugin } from "../src/worker.js";
import { SECRET_REF } from "./helpers.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";

async function harnessFor(config: Record<string, unknown>) {
  const harness = createTestHarness({ manifest, config });
  harness.seed({ companies: [{ id: COMPANY, name: "Co" } as never] });
  const { definition } = createPlugin();
  if (!definition.setup) throw new Error("plugin definition has no setup handler");
  await definition.setup(harness.ctx);
  if (!definition.onConfigChanged) throw new Error("missing company config handler");
  await definition.onConfigChanged(config, { companyId: COMPANY });
  return harness;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

describe("TOG-5007: get_provider_usage carries plain-object data on every path", () => {
  it("registers exactly the TOOL_NAMES registry (this test covers every tool by construction)", async () => {
    const harness = await harnessFor({ pollingEnabled: false });
    for (const name of Object.values(TOOL_NAMES)) {
      await expect(
        harness.executeTool(name, {}, {}).catch((err: unknown) => {
          throw new Error(`tool ${name} threw instead of returning: ${String(err)}`);
        }),
        `tool ${name} is registered`,
      ).resolves.toBeDefined();
    }
  });

  it("missing companyId rejection carries plain-object data (gateway null-structuredContent case)", async () => {
    const harness = await harnessFor({ pollingEnabled: false });
    const result = (await harness.executeTool(TOOL_NAMES.getProviderUsage, {})) as {
      content: unknown;
      data: unknown;
      error: unknown;
    };
    expect(isPlainObject(result.data), "missing-companyId rejection must carry plain-object data").toBe(true);
  });

  it("unconfigured-company rejection carries plain-object data (gateway null-structuredContent case)", async () => {
    const harness = await harnessFor({ pollingEnabled: false });
    const result = (await harness.executeTool(TOOL_NAMES.getProviderUsage, {
      companyId: "00000000-0000-4000-8000-000000000000",
    })) as { content: unknown; data: unknown; error: unknown };
    expect(isPlainObject(result.data), "unconfigured-company rejection must carry plain-object data").toBe(true);
  });

  it("success path still carries plain-object data", async () => {
    const harness = await harnessFor({ staleAfterSeconds: 600 });
    const now = new Date().toISOString();
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: STATE_KEYS.provider("claude") },
      { schemaVersion: 1, provider: "claude", polledAt: now, observedAt: now, success: 7, failed: 0, raw: {} },
    );
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: STATE_KEYS.providerIndex },
      ["claude"],
    );

    const result = (await harness.executeTool(TOOL_NAMES.getProviderUsage, {
      companyId: COMPANY,
    })) as { content: unknown; data: unknown };
    expect(isPlainObject(result.data), "success path must carry plain-object data").toBe(true);
    expect((result.data as { snapshots: Record<string, { success: number }> }).snapshots.claude?.success).toBe(7);
  });

  it("empty provider set before the first poll still carries plain-object data", async () => {
    const harness = await harnessFor({});
    const result = (await harness.executeTool(TOOL_NAMES.getProviderUsage, {
      companyId: COMPANY,
    })) as { content: unknown; data: unknown };
    expect(isPlainObject(result.data)).toBe(true);
    expect((result.data as { providers: string[] }).providers).toEqual([]);
  });

  it("SECRET_REF-shaped config keeps the tool path green (no secret-shape regression)", async () => {
    const harness = await harnessFor({
      pollingEnabled: false,
      laneApiKeySecretRef: SECRET_REF,
    });
    const result = (await harness.executeTool(TOOL_NAMES.getProviderUsage, {
      companyId: COMPANY,
    })) as { content: unknown; data: unknown };
    expect(isPlainObject(result.data)).toBe(true);
  });
});
