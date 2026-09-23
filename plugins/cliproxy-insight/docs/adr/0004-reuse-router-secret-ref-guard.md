# ADR-0004 (plugin): Reuse the router's `secret-ref` shape guard verbatim

- **Status:** accepted
- **Date:** 2026-09-02
- **Card:** TOG-811 design Q5
- **Precedent:** `paperclip-model-router/src/config/secret-ref.ts` (router ADR-0004)

## Context

The host's `format: "secret-ref"` JSON Schema keyword is not a real check: the
plugin-config validator registers it as `ajv.addFormat("secret-ref", {
validate: () => true })`, and `format` is string-only in JSON Schema regardless
— inert on an object-typed field either way. The host's secret extractor then
only recognizes a value shaped exactly like `{ type: "secret_ref", secretId,
... }`; anything else is treated as an ordinary config value and stored in the
company's config row verbatim.

Concretely, without an application-level guard, both of these would be
accepted and persisted in clear by the host:

- a raw pasted key (`"sk-..."`) submitted where a secret ref belongs;
- `{ type: "secret_ref", secretId: "...", value: "sk-..." }` — a smuggled
  credential riding alongside an otherwise-valid reference.

This plugin's entire reason to exist is a management key that can expose
provider account credentials (TOG-811's own framing). Accepting either shape
above would mean the plugin itself is the leak, at config-write time, before
polling ever runs.

The router already solved exactly this problem, independently, for its own
`managementApiKeySecretRef`-shaped field, and documented it in its own
ADR-0004: `validateSecretRefShape()`, called from `onValidateConfig`, checking
type discriminator, UUID-shaped `secretId`, an allowlisted key set (rejecting
any extra field), and an optional `version`.

## Decision

Copy `secret-ref.ts` from the router into this plugin verbatim — same
function name, same `ALLOWED_KEYS`, same UUID regex, same error strings — and
call `validateSecretRefShape(config.managementApiKeySecretRef,
"managementApiKeySecretRef")` from this plugin's `onValidateConfig`, exactly
as the router calls it from its own.

No adaptation, because the gap being defended against (`format: "secret-ref"`
being inert, the extractor silently accepting any other shape) is a property
of the host's plugin-config validator, not of the router. Any plugin with a
secret-ref-shaped config field has the identical exposure.

## Consequences

- A raw string or a credential-carrying object is rejected at config-write
  time with an explicit error naming the field, rather than silently stored.
- If the host's own `secret-ref` format validator is ever fixed upstream, this
  guard becomes redundant defense-in-depth, not a bug — no reason to remove it
  proactively.
- Two independent plugins now carry a byte-identical copy of this file rather
  than sharing a dependency. Accepted as the cost of not creating a shared
  internal package for a single ~90-line function; if a third plugin needs the
  same guard, that is the point to reconsider extracting it.
- Covered by `tests/config.spec.ts`'s six `validateSecretRefShape` cases,
  copied from the router's own test cases for the same function.
