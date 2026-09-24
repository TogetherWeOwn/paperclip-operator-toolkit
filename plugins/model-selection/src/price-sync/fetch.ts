/**
 * Same shape as `@paperclipai/plugin-sdk`'s `PluginHttpClient.fetch`, kept
 * local so this module has no dependency on the SDK's types beyond what it
 * actually calls — mirrors `aa-index/fetch.ts`'s `AaHttpClient`.
 */
export interface PriceHttpClient {
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

export interface PriceCatalogFetchResult {
  ok: boolean;
  json: string | null;
  error: string | null;
}

/**
 * Fetch models.dev's public `api.json` catalogue. Fail-neutral, same guard
 * chain as `aa-index/fetch.ts`'s `fetchAaSnapshot`: https-only literal URL,
 * no redirect follow, a `Promise.race`-based timeout (`ctx.http.fetch`
 * silently drops `AbortSignal` on the real host per the plugin-sdk wire
 * shim, so a timeout MUST be built this way), a byte-size cap, and never
 * throws.
 *
 * The one addition over the aa.ai fetch is a real `User-Agent`. models.dev
 * is behind Cloudflare, which 403s default library agents (`Python-urllib`
 * was the one the 2026-09-22 manual audit tripped over) at the edge before
 * the request reaches an origin. A 403 here is indistinguishable from a
 * withdrawn feed, so the header is load-bearing, not cosmetic.
 */
export async function fetchPriceCatalog(input: {
  url: string;
  userAgent: string;
  http: PriceHttpClient;
  timeoutMs: number;
  maxResponseBytes: number;
}): Promise<PriceCatalogFetchResult> {
  const fail = (error: string): PriceCatalogFetchResult => ({ ok: false, json: null, error });

  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return fail("price-url-rejected");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    return fail("price-url-rejected");
  }

  let response: Awaited<ReturnType<PriceHttpClient["fetch"]>>;
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    response = await Promise.race([
      input.http.fetch(input.url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "identity",
          "User-Agent": input.userAgent,
        },
        redirect: "manual",
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("price-request-timeout")), input.timeoutMs);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  } catch {
    return fail("price-request-failed");
  }

  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    return fail("price-redirect-refused");
  }
  // A Cloudflare edge block is a 403, and it is the single most likely
  // failure here. Name it separately so an operator reading the log knows to
  // check the User-Agent rather than hunt for a withdrawn feed.
  if (response.status === 403) {
    return fail("price-http-forbidden");
  }
  if (response.status < 200 || response.status >= 300) {
    return fail("price-http-failed");
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    return fail("price-request-failed");
  }
  if (new TextEncoder().encode(text).byteLength > input.maxResponseBytes) {
    return fail("price-response-too-large");
  }

  return { ok: true, json: text, error: null };
}
