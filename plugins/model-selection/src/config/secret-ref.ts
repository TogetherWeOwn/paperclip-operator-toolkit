/**
 * Shape check for `format: "secret-ref"` config fields.
 *
 * The host does NOT do this. `plugin-config-validator.ts` registers the format
 * as `ajv.addFormat("secret-ref", { validate: () => true })` — a picker hint
 * with nothing behind it — and JSON Schema `format` is a string-only keyword in
 * any case, so it would be inert on this object-typed field even if it did
 * something. The host's secret-ref *extractor* then ignores any value that is
 * not literally `{ type: "secret_ref", ... }`, so an object of any other shape
 * is not treated as a secret at all: it is stored in the company's config row
 * exactly as submitted.
 *
 * Ported from paperclip-model-router's `src/config/secret-ref.ts` (same
 * validator, same accepted shape — TOG-2379).
 */

/** Fields the Paperclip secret picker may legitimately submit. */
const ALLOWED_KEYS = new Set([
  "type",
  "secretId",
  "version",
  "projectionClass",
  "projectionAllowlistKey",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param value the raw value stored at a `secret-ref` config path
 * @param path  dotted config path, used in the error message
 * @returns an error string, or null when the value is absent or a valid reference
 */
export function validateSecretRefShape(value: unknown, path: string): string | null {
  if (value === null || value === undefined) return null;

  if (typeof value === "string") {
    return `${path} must be a Paperclip secret reference object, not a string. A pasted credential is never stored — use the secret picker, which submits { type: "secret_ref", secretId }.`;
  }
  if (!isRecord(value)) {
    return `${path} must be an object of the form { type: "secret_ref", secretId } or null`;
  }
  if (value.type !== "secret_ref") {
    return `${path} is not a secret reference: it must be { type: "secret_ref", secretId, version? }. An object holding a credential value would be stored in this company's config in clear.`;
  }
  if (typeof value.secretId !== "string" || !UUID.test(value.secretId)) {
    return `${path}.secretId must be the UUID of a Paperclip secret`;
  }
  if (
    value.projectionClass !== undefined &&
    value.projectionClass !== "unclassified" &&
    value.projectionClass !== "class_3_static_lease"
  ) {
    return `${path}.projectionClass must be "unclassified" or "class_3_static_lease"`;
  }
  if (
    value.version !== undefined &&
    value.version !== "latest" &&
    !(typeof value.version === "number" && Number.isInteger(value.version) && value.version > 0)
  ) {
    return `${path}.version must be "latest" or a positive integer`;
  }

  // Any extra key is refused rather than ignored. A credential smuggled in
  // alongside a valid reference — `{ type: "secret_ref", secretId, value: "sk-..." }`
  // — would otherwise ride along into storage untouched.
  const extra = Object.keys(value).filter((key) => !ALLOWED_KEYS.has(key));
  if (extra.length > 0) {
    return `${path} carries unexpected field(s): ${extra.sort().join(", ")}. A secret reference holds no value, only a pointer.`;
  }

  return null;
}
