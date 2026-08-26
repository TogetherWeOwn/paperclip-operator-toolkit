/**
 * omniroute-broker — response scrubbing (TOG-391).
 *
 * Pure. No I/O.
 *
 * ## Why this file exists, and why gh-token-broker has no equivalent
 *
 * In gh-token-broker a secret crossing back to the caller IS the product: the
 * whole point is to hand over a narrow installation token. Here the opposite
 * holds. NOTHING secret may cross. The broker's value is that the caller gets
 * an *effect* (a provider was registered) and a *receipt*, never a credential.
 *
 * That matters because OmniRoute's management plane embeds live upstream
 * credentials in ordinary responses. A provider record carries the API key for
 * the upstream it fronts, in the clear, and those upstreams are billed. So
 * `GET /api/providers` — a verb the owner's policy calls "ungated read" — is a
 * credential disclosure unless it is scrubbed. The issue's own warning is
 * blunt about it: "Never log, cache, comment or forward a management response."
 *
 * ## Deny-by-default, like TOG-151's gate_allowlist
 *
 * A denylist of secret-looking field names is the obvious approach and it is
 * wrong, for the reason TOG-151 already paid for: the thing you are filtering
 * has more spellings than you can enumerate, and a miss is silent. OmniRoute
 * alone spells upstream credentials `apiKey`, `api_key`, `key`, `token`,
 * `secret`, `password`, `credential`, `bearer`, `authorization`, `cookie`,
 * `refreshToken`, `clientSecret` — and a new provider type can add one at any
 * release with no signal to us.
 *
 * So: an ALLOWLIST of field names per resource, matched by exact equality.
 * Anything not named is dropped. A field OmniRoute adds tomorrow is invisible
 * to the caller until someone adds it here on purpose — which is the correct
 * failure direction, and the opposite of what a denylist does.
 *
 * `assertNoResidualSecret` then re-checks the OUTPUT. That is not redundant: it
 * is the control that catches an allowlisted field whose *value* turns out to
 * carry a credential (a `baseUrl` with a key in the query string is the real
 * case). If it ever fires, the response is refused wholesale rather than
 * trimmed — a scrubber that half-works is worse than one that stops.
 */

export class RedactionError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "RedactionError";
    this.status = status;
  }
}

/**
 * Per-resource allowlists. Exact field names, no patterns.
 *
 * Chosen so the caller can do the job the broker exists for — confirm a
 * provider registered, see what is configured, diff before/after — and nothing
 * else. Notably absent from `provider`: every `*Key`, `*Secret`, `*Token`,
 * `headers`, `customHeaders` and `connections`, because upstream credentials
 * live in those.
 */
export const FIELD_ALLOWLIST = Object.freeze({
  provider: Object.freeze([
    "id",
    "name",
    "type",
    "provider",
    "apiType",
    "enabled",
    "priority",
    "status",
    "health",
    "modelCount",
    "createdAt",
    "updatedAt",
  ]),
  combo: Object.freeze([
    "id",
    "name",
    "description",
    "strategy",
    "members",
    "enabled",
    "computed_context_length",
    "createdAt",
    "updatedAt",
  ]),
  model: Object.freeze([
    "id",
    "object",
    "owned_by",
    "created",
    "context_length",
    "max_input_tokens",
    "max_output_tokens",
  ]),
  /**
   * A mapping record carries no credential of its own — it is a pattern, a combo
   * id and an ordering. It still gets an allowlist rather than a pass-through,
   * because the reason for the allowlist is that we do not control what OmniRoute
   * adds to this shape at the next release.
   *
   * Both spellings of the id and the timestamps are listed on purpose: OmniRoute
   * is not consistent about camel vs snake case across routes, and an exact-match
   * allowlist that guesses wrong drops the field silently.
   */
  mapping: Object.freeze([
    "id",
    "pattern",
    "comboId",
    "combo_id",
    "comboName",
    "combo_name",
    "priority",
    "enabled",
    "description",
    "createdAt",
    "created_at",
    "updatedAt",
    "updated_at",
  ]),
});

/**
 * Envelope keys that may carry a list of resources. OmniRoute is not uniform:
 * `/api/combos` returns `{combos,total}` (TOG-151 [RESOLVED-3]), `/v1/models`
 * returns `{object,data}`, and some routes return a bare array.
 */
const LIST_KEYS = Object.freeze(["data", "providers", "combos", "models", "mappings", "items", "results"]);

/**
 * Value-level credential signatures, used only by the residual check.
 *
 * These are the credential prefixes actually in play on this box — OmniRoute
 * inference keys (`sk-`), OmniRoute CLI access tokens (`oma_`), GitHub App
 * installation tokens (`ghs_`), and the CLIProxy key class (`tc-`) — plus a
 * generic high-entropy bearer shape. Broad on purpose: like TOG-151's Claude
 * tripwire it can only ever REFUSE MORE, never allow more.
 */
const SECRET_VALUE_PATTERNS = Object.freeze([
  /\bsk-[A-Za-z0-9_-]{12,}/,
  /\boma_(live_)?[A-Za-z0-9_-]{12,}/,
  /\bghs_[A-Za-z0-9]{20,}/,
  /\btc-[A-Za-z0-9_-]{12,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bBearer\s+[A-Za-z0-9._-]{12,}/i,
  /-----BEGIN[A-Z ]*PRIVATE KEY-----/,
]);

/** Field names whose presence in OUTPUT is always a scrubber bug. */
const SECRET_FIELD_NAMES = Object.freeze([
  "apikey",
  "api_key",
  "key",
  "token",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "secret",
  "clientsecret",
  "client_secret",
  "password",
  "credential",
  "credentials",
  "authorization",
  "cookie",
  "bearer",
  "privatekey",
  "private_key",
  "headers",
  "customheaders",
]);

/** Keep only allowlisted, scalar-safe fields of one record. */
function pickAllowed(record, allowed) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return null;
  const out = {};
  for (const field of allowed) {
    if (!Object.hasOwn(record, field)) continue;
    const value = record[field];
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
      out[field] = value;
      continue;
    }
    // `members` on a combo is a legitimate array of ids. Keep only its scalar
    // entries; an object member could smuggle a nested credential.
    if (Array.isArray(value)) {
      out[field] = value.filter((item) =>
        ["string", "number", "boolean"].includes(typeof item),
      );
    }
    // Objects are dropped entirely. There is no allowlisted field whose object
    // form is needed, and descending into one is how a scrubber grows a hole.
  }
  return out;
}

/**
 * Scrub an upstream management response down to the allowlist for `resource`.
 * Returns `{ records, count }` — always a list shape, so callers do not branch
 * on which envelope OmniRoute happened to use.
 */
export function redactResponse(payload, resource) {
  const allowed = FIELD_ALLOWLIST[resource];
  if (!allowed) {
    // An unknown resource means someone added a verb without adding its
    // allowlist. Refuse rather than pass the payload through unscrubbed.
    throw new RedactionError(
      `No field allowlist is defined for resource "${resource}"; refusing to return an unscrubbed response.`,
      500,
    );
  }

  let records;
  if (Array.isArray(payload)) {
    records = payload;
  } else if (payload && typeof payload === "object") {
    const listKey = LIST_KEYS.find((key) => Array.isArray(payload[key]));
    records = listKey ? payload[listKey] : [payload];
  } else {
    records = [];
  }

  const scrubbed = records
    .map((record) => pickAllowed(record, allowed))
    .filter((record) => record !== null);

  assertNoResidualSecret(scrubbed);
  return { records: scrubbed, count: scrubbed.length };
}

/**
 * Final gate. Walks the OUTPUT and throws if anything credential-shaped
 * survived. Fails the whole response — never trims and continues, because a
 * value that got this far means the allowlist above is wrong and the rest of
 * the payload can no longer be trusted either.
 */
export function assertNoResidualSecret(value, path = "$", depth = 0) {
  if (depth > 12) return;

  if (typeof value === "string") {
    for (const pattern of SECRET_VALUE_PATTERNS) {
      if (pattern.test(value)) {
        // The offending value is deliberately NOT included in the message —
        // that message goes into a log and an HTTP response.
        throw new RedactionError(
          `Refusing to return a response: a credential-shaped value survived scrubbing at ${path}. ` +
            `This is a bug in the field allowlist, not a caller error.`,
          500,
        );
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoResidualSecret(item, `${path}[${index}]`, depth + 1));
    return;
  }

  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (SECRET_FIELD_NAMES.includes(key.toLowerCase())) {
        throw new RedactionError(
          `Refusing to return a response: secret-named field "${key}" survived scrubbing at ${path}. ` +
            `This is a bug in the field allowlist, not a caller error.`,
          500,
        );
      }
      assertNoResidualSecret(nested, `${path}.${key}`, depth + 1);
    }
  }
}

/**
 * Scrub a value destined for an audit record or a log line.
 *
 * Audit metadata is caller-influenced (it echoes the request body), so it needs
 * the same treatment as a response — otherwise the broker's own audit trail
 * becomes the disclosure channel. Unlike `redactResponse` this MASKS rather than
 * refusing, because an audit record must still be written: losing the record of
 * a mutation that already happened is the TOG-151 [RESOLVED-8] failure.
 */
export function maskForAudit(value, depth = 0) {
  if (depth > 8) return "[truncated]";
  if (value === null || ["number", "boolean"].includes(typeof value)) return value;

  if (typeof value === "string") {
    return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value)) ? "[redacted]" : value;
  }

  if (Array.isArray(value)) return value.map((item) => maskForAudit(item, depth + 1));

  if (typeof value === "object") {
    const out = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = SECRET_FIELD_NAMES.includes(key.toLowerCase())
        ? "[redacted]"
        : maskForAudit(nested, depth + 1);
    }
    return out;
  }

  return undefined;
}

export default { redactResponse, assertNoResidualSecret, maskForAudit, FIELD_ALLOWLIST };
