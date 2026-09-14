/**
 * Same shape as `@paperclipai/plugin-sdk`'s `PluginHttpClient.fetch`, kept
 * local so this module has no dependency on the SDK's types beyond what it
 * actually calls — mirrors `lane-capacity/poll.ts`'s `LanePollHttpClient`.
 */
export interface AaHttpClient {
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

export interface AaSnapshotResult {
  ok: boolean;
  html: string | null;
  error: string | null;
}

/**
 * Fetch aa.ai's public leaderboard page. Fail-neutral, same guard chain as
 * `lane-capacity/poll.ts`'s `pollOne`: https-only literal URL, no redirect
 * follow, a `Promise.race`-based timeout (`ctx.http.fetch` silently drops
 * `AbortSignal` on the real host per the plugin-sdk wire shim — the
 * `signal` option has no wire representation, so a timeout MUST be built
 * this way, not with `AbortController`), a byte-size cap sized for a full
 * HTML page rather than a small JSON blob, and never throws.
 */
export async function fetchAaSnapshot(input: {
  url: string;
  http: AaHttpClient;
  timeoutMs: number;
  maxResponseBytes: number;
}): Promise<AaSnapshotResult> {
  const fail = (error: string): AaSnapshotResult => ({ ok: false, html: null, error });

  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return fail("aa-url-rejected");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    return fail("aa-url-rejected");
  }

  let response: Awaited<ReturnType<AaHttpClient["fetch"]>>;
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    response = await Promise.race([
      input.http.fetch(input.url, {
        method: "GET",
        headers: { Accept: "text/html", "Accept-Encoding": "identity" },
        redirect: "manual",
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("aa-request-timeout")), input.timeoutMs);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  } catch {
    return fail("aa-request-failed");
  }

  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    return fail("aa-redirect-refused");
  }
  if (response.status < 200 || response.status >= 300) {
    return fail("aa-http-failed");
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    return fail("aa-request-failed");
  }
  if (new TextEncoder().encode(text).byteLength > input.maxResponseBytes) {
    return fail("aa-response-too-large");
  }

  return { ok: true, html: text, error: null };
}
