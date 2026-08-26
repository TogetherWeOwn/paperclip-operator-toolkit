/**
 * omniroute-broker — the only place the management credential is touched.
 *
 * Invariants, each with a test in test/broker.test.mjs:
 *
 *  - The credential is resolved from a secret ref INSIDE the host process, as
 *    late as possible, and is bound to nothing that outlives `callManagement`.
 *  - It is never returned, never logged, never written to plugin state, and
 *    never placed in an error message.
 *  - NOTHING IS SHELLED OUT. The request is issued through `ctx.http.fetch`, so
 *    the credential exists only as an in-process string and never lands in
 *    /proc/<pid>/cmdline. This is the TOG-200 class of bug, and it is also why
 *    TOG-151's shell CLI had to go to the trouble of a 0600 `curl --config`
 *    file — a plugin does not have that problem and must not reintroduce it.
 *  - The upstream response is returned to the CALLER of this module, which is
 *    responsible for scrubbing it (worker.js routes every read through
 *    redact.js). Nothing here forwards a response to an agent directly.
 */

export class OmniRouteError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "OmniRouteError";
    this.status = status;
  }
}

/**
 * Normalise the configured base URL.
 *
 * ⚠️ Two address traps, both measured, both of which fail like something else:
 *
 *  1. PORTS. :20128 is the MANAGEMENT port; :20129 is the INFERENCE port. They
 *     are not interchangeable and a swap does not look like a swap — TOG-151
 *     [RESOLVED-5] recorded `/api/combos` on :20129 returning
 *     404 {"error":"not_found","message":"API port only serves OpenAI-compatible
 *     routes."}. Confirmed again 2026-08-25.
 *
 *  2. HOST. The right host depends on where the caller runs, and the issue's
 *     guidance is written for the host, not for us. From the HOST, the published
 *     ports are on loopback and `omniroute` does not resolve. From a CONTAINER —
 *     which is where this plugin's worker runs — 127.0.0.1 is the worker itself
 *     and is refused; the podman network alias `omniroute` resolves and answers.
 *     Measured 2026-08-25 from an agent container: `http://omniroute:20128/api/keys`
 *     -> 403 AUTH_001 (reached, rejected on credential) while
 *     `http://127.0.0.1:20128/...` -> connection refused.
 *
 *     So the default here is the alias, and it is NOT a "fix" of TOG-151's
 *     loopback default — that tool runs on the host and is correct as written.
 *     Same service, two vantage points, two right answers.
 */
export function normalizeBaseUrl(raw) {
  const value = typeof raw === "string" ? raw.trim().replace(/\/+$/, "") : "";
  if (!value) throw new OmniRouteError("Broker is not configured: managementBaseUrl is required.", 503);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new OmniRouteError("Configured managementBaseUrl is not a valid URL.", 503);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new OmniRouteError("managementBaseUrl must be http or https.", 503);
  }
  if (parsed.search || parsed.hash) {
    throw new OmniRouteError("managementBaseUrl must not carry a query string or fragment.", 503);
  }
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
}

/**
 * Issue one management request.
 *
 * @param fetchImpl   `ctx.http.fetch`, injected so tests need no network.
 * @param resolveKey  async () => string. Called exactly once, here, at the last
 *                    possible moment. Injected so the test suite can assert the
 *                    credential never escapes without ever holding a real one.
 */
export async function callManagement(fetchImpl, { baseUrl, method, path, body, resolveKey, timeoutMs = 20_000 }) {
  const base = normalizeBaseUrl(baseUrl);
  if (typeof path !== "string" || !path.startsWith("/api/")) {
    // Every legitimate path comes from the verb table. Reaching here means a
    // caller found a way to influence it, so fail closed and loudly.
    throw new OmniRouteError("Refusing to call a path outside /api/.", 500);
  }

  const key = await resolveKey();
  if (typeof key !== "string" || key.length === 0) {
    throw new OmniRouteError(
      "Management credential could not be resolved from its secret reference.",
      503,
    );
  }

  const headers = {
    // The credential rides here and nowhere else. Not in the URL — a URL is
    // logged by proxies and shows up in error text.
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
  };
  const init = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
  if (body !== null && body !== undefined && method !== "GET") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetchImpl(`${base}${path}`, init);
  } catch (error) {
    // The caught error can quote `init`, which holds the Authorization header.
    // Only the name is propagated — never the message, never the object.
    throw new OmniRouteError(
      `Management request failed to complete (${error?.name ?? "network error"}).`,
      502,
    );
  }

  const text = await response.text().catch(() => "");
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    throw new OmniRouteError(
      `OmniRoute refused the operation: ${describeUpstreamError(response.status, payload)}`,
      mapUpstreamStatus(response.status),
    );
  }

  return payload ?? {};
}

/**
 * Describe an upstream failure without echoing the body.
 *
 * A management response body may embed credentials, so it is never quoted. Both
 * of OmniRoute's error envelopes are understood — TOG-151 [RESOLVED-5] found the
 * management port emits BOTH shapes: the auth middleware returns a nested
 * `{error:{code,message,correlation_id}}` while the route handlers return a flat
 * `{error: "..."}` on 400/500. Only the CODE and the correlation id are
 * surfaced, both of which are safe and are what an operator needs to grep.
 */
export function describeUpstreamError(status, payload) {
  const nested = payload?.error;
  if (nested && typeof nested === "object") {
    const code = typeof nested.code === "string" ? nested.code : "unknown";
    const correlation = typeof nested.correlation_id === "string" ? nested.correlation_id : null;
    return `HTTP ${status} ${code}${correlation ? ` (correlation_id ${correlation})` : ""}`;
  }
  return `HTTP ${status}`;
}

/**
 * Map an upstream status onto what the AGENT should see.
 *
 * A 401/403 from OmniRoute means the BROKER's credential is wrong — a
 * misconfiguration, not a caller error. Returning 403 to the agent would tell it
 * "you are not allowed", which is both false and the kind of misleading refusal
 * that costs a run. It becomes 503.
 */
export function mapUpstreamStatus(status) {
  if (status === 401 || status === 403) return 503;
  if (status === 404) return 404;
  if (status === 409) return 409;
  if (status >= 400 && status < 500) return 400;
  return 502;
}

export default { callManagement, normalizeBaseUrl };
