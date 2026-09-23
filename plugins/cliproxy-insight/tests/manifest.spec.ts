/**
 * The install gate. `pluginManifestV1Schema` is the host's real Zod schema
 * (`@paperclipai/shared/validators/plugin`) — the same one TOG-809 validated
 * model-selection's manifest against. A manifest that fails this never
 * reaches an operator's install screen.
 */

import { pluginManifestV1Schema } from "@paperclipai/shared/validators/plugin";
import { describe, expect, it } from "vitest";

import manifest from "../src/manifest.js";

describe("manifest", () => {
  it("satisfies the host's pluginManifestV1Schema", () => {
    const result = pluginManifestV1Schema.safeParse(manifest);
    expect(result.success, JSON.stringify(!result.success && result.error.format())).toBe(true);
  });

  it("declares activity.log.write, which the worker actually calls", () => {
    // Caught once already this build: worker.ts calls ctx.activity.log() on
    // every poll failure/refusal/change path, but the capability was missing
    // from this list. The in-memory test harness throws on exactly this gap,
    // which is the whole point of validateManifestCapabilities existing.
    expect(manifest.capabilities).toContain("activity.log.write");
  });

  it("only uses the four allowed plugin categories", () => {
    for (const category of manifest.categories ?? []) {
      expect(["connector", "workspace", "automation", "ui"]).toContain(category);
    }
  });

  it("ships inert: pollingEnabled and laneApiKeySecretRef default to off/absent", () => {
    const schema = manifest.instanceConfigSchema as {
      properties: Record<string, { default?: unknown }>;
    };
    expect(schema.properties.pollingEnabled?.default).toBe(false);
    expect(schema.properties).toHaveProperty("laneApiKeySecretRef");
    expect(schema.properties.laneApiKeySecretRef?.default ?? null).toBeNull();
  });

  /**
   * The CLIProxy management key is not placed in Paperclip at all — the host
   * collector holds it and publishes sanitized JSON. Asserting the field's
   * absence keeps that from being quietly re-introduced: `?? null` makes an
   * absent-field assertion pass vacuously, so this checks the key is gone.
   */
  it("offers no config field for the CLIProxy management key", () => {
    const schema = manifest.instanceConfigSchema as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).not.toContain("managementApiKeySecretRef");
  });

  it("polls the sanitized lane, never the management origin", () => {
    const schema = manifest.instanceConfigSchema as {
      properties: Record<string, { default?: unknown }>;
    };
    const baseUrl = String(schema.properties.baseUrl?.default ?? "");
    expect(baseUrl).toBe("https://router.example.net/telemetry/cliproxy");
    expect(baseUrl).not.toContain("/v0/management");
  });
});
