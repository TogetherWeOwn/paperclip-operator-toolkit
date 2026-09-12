import type { LanePaceDefinition, LanePaceVerdict, PacePolicy } from "./pace.js";
import { evaluateLanePace, normalizeLaneDocument } from "./pace.js";
import { isReservedLiteralHost } from "./url-policy.js";

/**
 * Same shape as `@paperclipai/plugin-sdk`'s `PluginHttpClient.fetch` (a plain
 * `fetch`-compatible signature), kept local so this module has no dependency
 * on the SDK's types beyond what it actually calls.
 */
export interface LanePollHttpClient {
  fetch(
    url: string,
    init: { method: "GET"; headers: Record<string, string>; redirect: "manual" },
  ): Promise<{
    status: number;
    headers: { get(name: string): string | null };
    redirected: boolean;
    text(): Promise<string>;
  }>;
}

export interface LaneSourceDefinition {
  laneId: string;
  statusUrl: string;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  lane: LanePaceDefinition;
  policy?: PacePolicy;
}

export interface LanePollResult {
  laneId: string;
  fetchedAt: string;
  verdict: LanePaceVerdict | null;
  /** Null on a clean poll. Fail-neutral: an error here never throws upstream. */
  error: string | null;
}

/**
 * Evaluate pace from the fetched document. Never throws — a malformed lane
 * document degrades to a null verdict, exactly like `read.ts`'s
 * `paceVerdict()` in the accepted lane-capacity package (the "one fetch, one
 * guard chain, fail-neutral pace" precedent this module follows).
 */
function verdictFor(
  document: unknown,
  lane: LanePaceDefinition,
  policy: PacePolicy | undefined,
  asOf: string,
): LanePaceVerdict | null {
  try {
    return evaluateLanePace({
      observation: normalizeLaneDocument({ document, definition: lane }),
      asOf,
      policy,
    });
  } catch {
    return null;
  }
}

async function pollOne(
  source: LaneSourceDefinition,
  http: LanePollHttpClient,
  now: () => string,
): Promise<LanePollResult> {
  const fetchedAt = now();
  const fail = (error: string): LanePollResult => ({ laneId: source.laneId, fetchedAt, verdict: null, error });

  let parsed: URL;
  try {
    parsed = new URL(source.statusUrl);
  } catch {
    return fail("lane-url-rejected");
  }
  // Same URL guard chain as readCapacitySource: https-only, no embedded
  // credentials, no query/hash, no reserved-literal host.
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    isReservedLiteralHost(parsed.hostname)
  ) {
    return fail("lane-url-rejected");
  }

  let response: Awaited<ReturnType<LanePollHttpClient["fetch"]>>;
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    response = await Promise.race([
      http.fetch(source.statusUrl, {
        method: "GET",
        headers: { Accept: "application/json", "Accept-Encoding": "identity" },
        redirect: "manual",
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("lane-request-timeout")), source.requestTimeoutMs);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  } catch {
    return fail("lane-request-failed");
  }

  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    return fail("lane-redirect-refused");
  }
  if (response.status === 401 || response.status === 403) {
    return fail("lane-authentication-failed");
  }
  if (response.status < 200 || response.status >= 300) {
    return fail("lane-http-failed");
  }
  const mediaType = response.headers.get("content-type")?.toLowerCase().split(";", 1)[0]?.trim();
  if (!mediaType?.endsWith("/json") && !mediaType?.endsWith("+json")) {
    return fail("lane-unexpected-media-type");
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    return fail("lane-request-failed");
  }
  if (new TextEncoder().encode(text).byteLength > source.maxResponseBytes) {
    return fail("lane-response-too-large");
  }

  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return fail("lane-invalid-json");
  }
  if (document === null || typeof document !== "object") {
    return fail("lane-invalid-json");
  }

  return {
    laneId: source.laneId,
    fetchedAt,
    verdict: verdictFor(document, source.lane, source.policy, fetchedAt),
    error: null,
  };
}

/**
 * Poll every configured lane independently. This is the scope requirement
 * that one failed document must not abort other lanes: each source is
 * isolated behind its own try/catch (belt-and-braces on top of `pollOne`,
 * which itself never throws), and the sources are fetched concurrently via
 * `Promise.all` over settled-shaped results rather than a bare `Promise.all`
 * over rejecting promises, so a single 404/timeout/malformed document cannot
 * take down the batch.
 */
export async function pollLanes(input: {
  sources: readonly LaneSourceDefinition[];
  http: LanePollHttpClient;
  now: () => string;
}): Promise<LanePollResult[]> {
  return Promise.all(
    input.sources.map((source) =>
      pollOne(source, input.http, input.now).catch(
        (): LanePollResult => ({ laneId: source.laneId, fetchedAt: input.now(), verdict: null, error: "lane-poll-failed" }),
      ),
    ),
  );
}
