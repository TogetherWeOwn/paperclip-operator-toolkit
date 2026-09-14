import { isReservedLiteralHost } from "../lane-capacity/url-policy.js";
import type { ClassificationProtocol } from "../config/resolve.js";

/**
 * Same shape as `LanePollHttpClient` (`lane-capacity/poll.ts`) — a plain
 * `fetch`-compatible signature, kept local so this module has no dependency
 * on the SDK's types beyond what it actually calls.
 */
export interface ClassificationHttpClient {
  fetch(
    url: string,
    init: { method: "POST"; headers: Record<string, string>; body: string; redirect: "manual" },
  ): Promise<{
    status: number;
    headers: { get(name: string): string | null };
    redirected: boolean;
    text(): Promise<string>;
  }>;
}

export interface ClassificationCallInput {
  baseUrl: string;
  protocol: ClassificationProtocol;
  modelId: string;
  apiKey: string | null;
  system: string;
  userPrompt: string;
  maxOutputTokens: number;
  requestTimeoutMs: number;
  maxResponseBytes: number;
}

export interface ClassificationCallResult {
  /** Concatenated text content of the response. Null on any guard/transport/parse failure. */
  text: string | null;
  /** Set whenever `text` is null — never thrown, mirroring `pollOne`'s fail-neutral style. */
  error: string | null;
}

function upstreamUrl(baseUrl: string, protocol: ClassificationProtocol): string {
  const parsed = new URL(baseUrl);
  const suffix = protocol === "openai-chat-completions" ? "/v1/chat/completions" : "/v1/messages";
  let path = parsed.pathname.replace(/\/+$/, "");
  if (path.endsWith(suffix)) path = path.slice(0, -suffix.length);
  parsed.pathname = `${path}${suffix}`.replace(/\/{2,}/g, "/");
  return parsed.toString();
}

function buildBody(input: ClassificationCallInput): string {
  if (input.protocol === "openai-chat-completions") {
    return JSON.stringify({
      model: input.modelId,
      max_tokens: input.maxOutputTokens,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.userPrompt },
      ],
    });
  }
  return JSON.stringify({
    model: input.modelId,
    max_tokens: input.maxOutputTokens,
    system: input.system,
    messages: [{ role: "user", content: input.userPrompt }],
  });
}

function buildHeaders(input: ClassificationCallInput): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "Accept-Encoding": "identity",
  };
  if (!input.apiKey) return headers;
  if (input.protocol === "openai-chat-completions") {
    headers.Authorization = `Bearer ${input.apiKey}`;
  } else {
    headers["x-api-key"] = input.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  }
  return headers;
}

function extractText(protocol: ClassificationProtocol, parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const body = parsed as Record<string, unknown>;
  if (protocol === "openai-chat-completions") {
    const choices = Array.isArray(body.choices) ? body.choices : [];
    const first = choices[0] as Record<string, unknown> | undefined;
    const message = first && typeof first.message === "object" ? (first.message as Record<string, unknown>) : null;
    return typeof message?.content === "string" ? message.content : null;
  }
  const content = Array.isArray(body.content) ? body.content : [];
  const text = content
    .filter((block): block is Record<string, unknown> => !!block && typeof block === "object")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("");
  return text.length > 0 ? text : null;
}

/**
 * Call the configured classification provider directly. Same guard chain as
 * `lane-capacity/poll.ts`'s `pollOne()` (https-only, no embedded credentials,
 * no query/hash, reserved-literal-host block, timeout via `Promise.race`,
 * redirect refusal, 401/403 distinguished from other non-2xx, media-type
 * check, response-size cap, JSON parse) applied to a single POST rather than
 * N lane GETs. This is a direct provider call — never a same-host hop into
 * `togetherweown.paperclip-model-router`'s own `/invoke` route, which is
 * unreachable from a plugin sandbox (`isPrivateIP()` blocks it unconditionally;
 * see TOG-2481 architecture note).
 */
export async function callClassifier(
  input: ClassificationCallInput,
  http: ClassificationHttpClient,
): Promise<ClassificationCallResult> {
  const fail = (error: string): ClassificationCallResult => ({ text: null, error });

  let target: string;
  let parsedUrl: URL;
  try {
    target = upstreamUrl(input.baseUrl, input.protocol);
    parsedUrl = new URL(target);
  } catch {
    return fail("classification-url-rejected");
  }
  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.search ||
    parsedUrl.hash ||
    isReservedLiteralHost(parsedUrl.hostname)
  ) {
    return fail("classification-url-rejected");
  }

  let response: Awaited<ReturnType<ClassificationHttpClient["fetch"]>>;
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    response = await Promise.race([
      http.fetch(target, {
        method: "POST",
        headers: buildHeaders(input),
        body: buildBody(input),
        redirect: "manual",
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("classification-request-timeout")), input.requestTimeoutMs);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  } catch {
    return fail("classification-request-failed");
  }

  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    return fail("classification-redirect-refused");
  }
  if (response.status === 401 || response.status === 403) {
    return fail("classification-authentication-failed");
  }
  if (response.status < 200 || response.status >= 300) {
    return fail("classification-http-failed");
  }
  const mediaType = response.headers.get("content-type")?.toLowerCase().split(";", 1)[0]?.trim();
  if (!mediaType?.endsWith("/json") && !mediaType?.endsWith("+json")) {
    return fail("classification-unexpected-media-type");
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    return fail("classification-request-failed");
  }
  if (new TextEncoder().encode(text).byteLength > input.maxResponseBytes) {
    return fail("classification-response-too-large");
  }

  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return fail("classification-invalid-json");
  }

  const extracted = extractText(input.protocol, document);
  if (extracted === null) return fail("classification-empty-response");
  return { text: extracted, error: null };
}
