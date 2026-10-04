import type { AaHttpClient } from "../aa-index/fetch.js";

export const AA_FREE_LIST_URL = "https://artificialanalysis.ai/api/v2/data/llms/models";

export type AaFreeFetchResult =
  | { ok: true; text: string }
  | { ok: false; error: "aa-url-rejected" | "aa-request-failed" | "aa-redirect-refused" | "aa-response-too-large" | "aa-http-failed"; retryable: boolean }
  | { ok: false; error: "aa-access-denied"; status: 401 | 403; retryable: false }
  | { ok: false; error: "aa-rate-limited"; retryable: true; retryAfterSeconds: number | null };

/** Headers carry the credential; they are built here and never logged or returned. */
export async function fetchAaFreeList(input: {
  http: AaHttpClient;
  apiKey: string;
  timeoutMs: number;
  maxResponseBytes: number;
  url?: string;
}): Promise<AaFreeFetchResult> {
  const url = input.url ?? AA_FREE_LIST_URL;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "aa-url-rejected", retryable: false };
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    return { ok: false, error: "aa-url-rejected", retryable: false };
  }
  if (!input.apiKey) return { ok: false, error: "aa-access-denied", status: 401, retryable: false };

  let response: Awaited<ReturnType<AaHttpClient["fetch"]>>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    response = await Promise.race([
      input.http.fetch(url, {
        method: "GET",
        headers: { Accept: "application/json", "Accept-Encoding": "identity", "x-api-key": input.apiKey },
        redirect: "manual",
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("aa-request-timeout")), input.timeoutMs);
      }),
    ]);
  } catch {
    return { ok: false, error: "aa-request-failed", retryable: true };
  } finally {
    if (timer) clearTimeout(timer);
  }

  // 401/403 stop this source: no substitution, no retry.
  if (response.status === 401 || response.status === 403) {
    return { ok: false, error: "aa-access-denied", status: response.status, retryable: false };
  }
  if (response.status === 429) {
    const header = response.headers.get("retry-after");
    const raw = header === null || header.trim() === "" ? NaN : Number(header);
    return {
      ok: false,
      error: "aa-rate-limited",
      retryable: true,
      retryAfterSeconds: Number.isFinite(raw) && raw >= 0 ? raw : null,
    };
  }
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    return { ok: false, error: "aa-redirect-refused", retryable: false };
  }
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, error: "aa-http-failed", retryable: response.status >= 500 };
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    return { ok: false, error: "aa-request-failed", retryable: true };
  }
  if (new TextEncoder().encode(text).byteLength > input.maxResponseBytes) {
    return { ok: false, error: "aa-response-too-large", retryable: false };
  }
  return { ok: true, text };
}
