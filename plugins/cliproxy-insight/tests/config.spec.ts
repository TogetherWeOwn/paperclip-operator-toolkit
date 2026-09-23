/**
 * The host validates a company's submitted config with Ajv against the
 * manifest's `instanceConfigSchema`, registering `secret-ref` as a permissive
 * format (ADR-0004: JSON Schema `format` cannot itself gate an object-typed
 * field). These tests run the same Ajv setup as the host's
 * `plugin-config-validator.ts`, so a schema mistake fails here rather than at
 * the moment an operator tries to configure a company. Router precedent:
 * `paperclip-model-router/tests/config.spec.ts`.
 */

import AjvImport from "ajv";
import addFormatsImport from "ajv-formats";
import { describe, expect, it } from "vitest";

import { CLIPROXY_INSIGHT_CONFIG_SCHEMA } from "../src/config/schema.js";
import { validateSecretRefShape } from "../src/config/secret-ref.js";
import { SECRET_REF } from "./helpers.js";

type ValidateFn = ((data: unknown) => boolean) & { errors?: unknown[] | null };
type AjvInstance = {
  addFormat(name: string, definition: { validate: () => boolean }): void;
  compile(schema: object): ValidateFn;
};
type AjvConstructor = new (options: Record<string, unknown>) => AjvInstance;

const Ajv = ((AjvImport as unknown as { default?: unknown }).default ??
  AjvImport) as unknown as AjvConstructor;
const addFormats = ((addFormatsImport as unknown as { default?: unknown }).default ??
  addFormatsImport) as unknown as (ajv: AjvInstance) => void;

function hostValidator(): ValidateFn {
  const ajv = new Ajv({ allErrors: true, logger: false });
  addFormats(ajv);
  ajv.addFormat("secret-ref", { validate: () => true });
  return ajv.compile(CLIPROXY_INSIGHT_CONFIG_SCHEMA as unknown as object);
}

describe("instanceConfigSchema", () => {
  it("compiles under the host's Ajv configuration", () => {
    expect(() => hostValidator()).not.toThrow();
  });

  it("accepts an empty config, so a company can be configured incrementally", () => {
    expect(hostValidator()({})).toBe(true);
  });

  it("accepts a fully-populated, polling-enabled config", () => {
    const validate = hostValidator();
    const valid = validate({
      pollingEnabled: true,
      baseUrl: "https://router.example.net/telemetry/cliproxy",
      laneApiKeySecretRef: SECRET_REF,
      requestTimeoutMs: 5000,
      maxCooldownEventsPerProvider: 50,
      staleAfterSeconds: 600,
    });
    expect(validate.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
  });

  it("rejects an unknown top-level field (additionalProperties: false)", () => {
    const validate = hostValidator();
    expect(validate({ managementApiKey: "sk-raw-key-smuggled-in" })).toBe(false);
  });

  it("rejects a raw string in place of a secret reference (host Ajv is a no-op here, but the type check is not)", () => {
    const validate = hostValidator();
    expect(validate({ laneApiKeySecretRef: "sk-live-abc123" })).toBe(false);
  });

  /**
   * v0.1.0's field was `managementApiKeySecretRef`, and it meant a key that
   * could read `/v0/management/auth-files`. v0.2.0 holds a lane bearer that
   * can read two static files. `additionalProperties: false` makes the old
   * name a hard config error rather than a silently ignored field, so an
   * operator cannot carry a v0.1.0 config forward and quietly get an inert
   * plugin — or, worse, place the management key against a name this plugin
   * no longer reads.
   */
  it("rejects the v0.1.0 management-key field name outright", () => {
    const validate = hostValidator();
    expect(validate({ managementApiKeySecretRef: SECRET_REF })).toBe(false);
  });

  it("no longer accepts a providers allowlist — the provider set comes from the payload", () => {
    const validate = hostValidator();
    expect(validate({ providers: ["claude", "openai"] })).toBe(false);
  });

  it("bounds staleAfterSeconds", () => {
    const validate = hostValidator();
    expect(validate({ staleAfterSeconds: 30 })).toBe(false);
    expect(validate({ staleAfterSeconds: 60 })).toBe(true);
  });
});

describe("validateSecretRefShape", () => {
  it("accepts null and undefined — the unconfigured, inert default", () => {
    expect(validateSecretRefShape(null, "laneApiKeySecretRef")).toBeNull();
    expect(validateSecretRefShape(undefined, "laneApiKeySecretRef")).toBeNull();
  });

  it("accepts a well-formed secret reference", () => {
    expect(validateSecretRefShape(SECRET_REF, "laneApiKeySecretRef")).toBeNull();
  });

  it("refuses a raw pasted key string", () => {
    const error = validateSecretRefShape("sk-live-abc123", "laneApiKeySecretRef");
    expect(error).toMatch(/must be a Paperclip secret reference object/);
  });

  it("refuses an object with the wrong type discriminator", () => {
    const error = validateSecretRefShape({ apiKey: "sk-live-abc123" }, "laneApiKeySecretRef");
    expect(error).toMatch(/is not a secret reference/);
  });

  it("refuses a secretId that is not a UUID", () => {
    const error = validateSecretRefShape(
      { type: "secret_ref", secretId: "not-a-uuid" },
      "managementApiKeySecretRef",
    );
    expect(error).toMatch(/must be the UUID/);
  });

  it("refuses a credential smuggled in alongside a valid reference", () => {
    const error = validateSecretRefShape(
      { ...SECRET_REF, value: "sk-live-abc123" },
      "managementApiKeySecretRef",
    );
    expect(error).toMatch(/unexpected field/);
  });
});
