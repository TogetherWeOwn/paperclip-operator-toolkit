/**
 * aa.ai's public leaderboard page (`/leaderboards/models`) embeds a full
 * per-model metrics array inside a Next.js RSC `self.__next_f.push([1,
 * "..."])` script tag, as an escaped JSON string within a JS string literal.
 * There is no documented API (`/api`, `/docs` 404; `/api/v2/data/llms/models`
 * 401s), so this scrape is the only viable data source. It is inherently
 * fragile to aa.ai changing their page bundling — every function here fails
 * closed (returns `null`) rather than throwing, so a structural change never
 * wedges the caller; it only ever fails to produce a fresh snapshot.
 *
 * Scope expansion: aa.ai publishes one record per (model × effort
 * level) — `gpt-5-6-sol`, `gpt-5-6-sol-low`, `-medium`, `-high`, `-xhigh`,
 * `-non-reasoning`. Each is a distinct slug with its own price/speed
 * trade-off, so this parser keeps every row as its own record — it never
 * dedupes or flattens effort variants together.
 */

/** String-valued identity fields. Absent/non-string -> null, never fabricated. */
const STRING_FIELDS = ["name", "shortName", "modelCreatorName", "paramClass", "priceClass"] as const;

/** Boolean-valued fields. Absent/non-boolean -> null. */
const BOOLEAN_FIELDS = ["deprecated", "isReasoning", "isOpenWeights", "intelligenceIndexIsEstimated"] as const;

/**
 * Every numeric field this parser extracts, beyond `intelligenceIndex`
 * itself. Exported so `diff.ts` can drive an all-field drift report off the
 * same list rather than a second hand-maintained copy.
 *
 * The four output-speed percentile field names (`outputTokensPerSecondP5`
 * /`P25`/`P75`/`P95`) are a best-effort guess at aa.ai's naming convention —
 * unverified against a live payload capture. A wrong guess is safe by
 * construction (the generic extractor below just reads `undefined` and
 * records `null`, same as any other absent field); it does not corrupt or
 * fabricate anything, it only leaves that one field unpopulated until a real
 * capture confirms the name.
 */
export const AA_NUMERIC_FIELDS = [
  "intelligenceIndex",
  "intelligenceIndexCostPerTask",
  "price1mInputTokens",
  "price1mOutputTokens",
  "cacheHitPrice",
  "cacheWritePrice",
  "medianOutputTokensPerSecond",
  "outputTokensPerSecondP5",
  "outputTokensPerSecondP25",
  "outputTokensPerSecondP75",
  "outputTokensPerSecondP95",
  "medianTimeToFirstTokenSeconds",
  "medianTimeToFirstAnswerTokenSeconds",
  "medianEndToEndResponseTimeSeconds",
  "medianReasoningTimeSeconds",
  "contextWindowTokens",
  "gpqa",
  "hle",
  "critpt",
  "lcr",
  "ifbench",
  "tau2",
  "terminalbenchHard",
  "mmmuPro",
  "gdpvalNormalized",
  "terminalbenchV21",
  "tauBanking",
  "scicode",
  "terminalbenchV40",
  "itbenchSre",
  "analystAgent",
  "apexAgents",
  "omniscience",
  "omniscienceAccuracy",
  "omniscienceNonHallucination",
] as const;

export type AaNumericField = (typeof AA_NUMERIC_FIELDS)[number];

/**
 * One aa.ai leaderboard row — a single (model × effort-level) slug — with
 * every field this parser recognizes. Every field beyond `slug` is nullable:
 * aa.ai itself has null gaps for many models (e.g. only 136/633 rows carry
 * `intelligenceIndexCostPerTask`), and this type must represent that
 * faithfully rather than substituting a fabricated default.
 */
export interface AaModelRecord {
  slug: string;
  name: string | null;
  shortName: string | null;
  modelCreatorName: string | null;
  deprecated: boolean | null;
  isReasoning: boolean | null;
  isOpenWeights: boolean | null;
  paramClass: string | null;
  priceClass: string | null;
  intelligenceIndex: number | null;
  intelligenceIndexIsEstimated: boolean | null;
  intelligenceIndexCostPerTask: number | null;
  price1mInputTokens: number | null;
  price1mOutputTokens: number | null;
  cacheHitPrice: number | null;
  cacheWritePrice: number | null;
  medianOutputTokensPerSecond: number | null;
  outputTokensPerSecondP5: number | null;
  outputTokensPerSecondP25: number | null;
  outputTokensPerSecondP75: number | null;
  outputTokensPerSecondP95: number | null;
  medianTimeToFirstTokenSeconds: number | null;
  medianTimeToFirstAnswerTokenSeconds: number | null;
  medianEndToEndResponseTimeSeconds: number | null;
  medianReasoningTimeSeconds: number | null;
  contextWindowTokens: number | null;
  gpqa: number | null;
  hle: number | null;
  critpt: number | null;
  lcr: number | null;
  ifbench: number | null;
  tau2: number | null;
  terminalbenchHard: number | null;
  mmmuPro: number | null;
  gdpvalNormalized: number | null;
  terminalbenchV21: number | null;
  tauBanking: number | null;
  scicode: number | null;
  terminalbenchV40: number | null;
  itbenchSre: number | null;
  analystAgent: number | null;
  apexAgents: number | null;
  omniscience: number | null;
  omniscienceAccuracy: number | null;
  omniscienceNonHallucination: number | null;
}

/** Back-compat alias: the minimal shape callers that only need the index still use. */
export type AaModelRow = AaModelRecord;

/**
 * The metrics-bearing array starts with this model's row (found by manual
 * inspection of the live page). Anchoring on a specific slug rather than a
 * generic `"models":[` key avoids matching the lighter catalog array that
 * also appears elsewhere on the same page.
 */
const ANCHOR = '{\\"models\\":[{\\"slug\\":\\"glm-4-5v\\"';
/** Offset of the array-opening `[` within `ANCHOR` itself — the array starts inside the anchor, not before it. */
const ANCHOR_BRACKET_OFFSET = ANCHOR.indexOf("[");

function findAnchorIndex(html: string): number {
  return html.indexOf(ANCHOR);
}

/**
 * Extract the balanced `[...]` substring starting at `arrayStart`, counting
 * bracket depth while respecting string spans so a `]`/`[` inside a JSON
 * string value never miscounts. Returns `null` if the brackets never balance
 * before the input ends (truncated/malformed payload).
 *
 * The text being scanned here is the RAW, still-escaped RSC payload — every
 * actual JSON quote character appears as the literal two-character sequence
 * `\"` (backslash + quote), because the JSON payload is itself embedded as a
 * JS string literal. There is no bare, unescaped `"` marking a string
 * boundary in this text at all. So this scanner treats `\"` as the atomic
 * string-delimiter token (both opening and closing), and a doubled `\\` as
 * an escaped-backslash pair to skip over — NOT ordinary single-layer JSON
 * escaping, where a lone `\` before a string's closing quote would (wrongly)
 * consume that quote as an escaped character and never see the string end.
 */
function extractBalancedArray(html: string, arrayStart: number): string | null {
  let depth = 0;
  let inString = false;
  let i = arrayStart;
  for (; i < html.length; ) {
    const ch = html[i];
    const next = html[i + 1];
    if (ch === "\\" && next === '"') {
      inString = !inString;
      i += 2;
      continue;
    }
    if (ch === "\\" && next === "\\") {
      i += 2;
      continue;
    }
    if (inString) {
      i += 1;
      continue;
    }
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return html.slice(arrayStart, i + 1);
    }
    i += 1;
  }
  return null;
}

/**
 * Undo the one extra layer of escaping the RSC payload adds on top of
 * ordinary JSON (it is a JSON string embedded inside a JS string literal):
 * `\"` -> `"`, `\\` -> `\`. Order matters — unescaping `\\` first would turn
 * `\\"` into `\"` and then the `\"` pass would eat a quote that was meant to
 * stay literal.
 */
function unescapeOuterLayer(raw: string): string {
  return raw.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function stringField(rec: Record<string, unknown>, key: string): string | null {
  const value = rec[key];
  return typeof value === "string" ? value : null;
}

function booleanField(rec: Record<string, unknown>, key: string): boolean | null {
  const value = rec[key];
  return typeof value === "boolean" ? value : null;
}

function numberField(rec: Record<string, unknown>, key: string): number | null {
  const value = rec[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Build one `AaModelRecord` from a raw parsed object. Only `slug` is
 * required — every other field is independently nullable, matching aa.ai's
 * own null gaps (e.g. `intelligenceIndexCostPerTask` is populated for only
 * 136 of 633 records). A row with no numeric `intelligenceIndex` is still
 * kept (its price/speed/context fields are still real data), unlike the
 * pre-expansion parser which dropped it.
 */
function buildRecord(rec: Record<string, unknown>): AaModelRecord | null {
  const slug = rec.slug;
  if (typeof slug !== "string" || slug.length === 0) return null;

  const record: Partial<AaModelRecord> = { slug };
  for (const key of STRING_FIELDS) record[key] = stringField(rec, key);
  for (const key of BOOLEAN_FIELDS) record[key] = booleanField(rec, key);
  for (const key of AA_NUMERIC_FIELDS) record[key] = numberField(rec, key);
  return record as AaModelRecord;
}

/**
 * Parse aa.ai's public leaderboard HTML into full `AaModelRecord` rows, one
 * per (model × effort-level) slug. Never throws: any structural mismatch
 * (anchor not found, unbalanced brackets, non-JSON content, no row with a
 * usable slug) yields `null`, which the caller treats identically to a fetch
 * failure (AC4: stale-but-labelled beats a hard failure).
 */
export function parseAaLeaderboardHtml(html: string): AaModelRecord[] | null {
  const anchorIndex = findAnchorIndex(html);
  if (anchorIndex < 0) return null;

  // The array-opening `[` is a fixed offset INSIDE the anchor string itself
  // (`{\"models\":[...`), not something to search backward for — a backward
  // scan can land on an unrelated bracket earlier in the page.
  const arrayStart = anchorIndex + ANCHOR_BRACKET_OFFSET;

  const balanced = extractBalancedArray(html, arrayStart);
  if (balanced === null) return null;

  const unescaped = unescapeOuterLayer(balanced);

  let parsed: unknown;
  try {
    parsed = JSON.parse(unescaped);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const rows: AaModelRecord[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const record = buildRecord(entry as Record<string, unknown>);
    if (record) rows.push(record);
  }
  return rows.length > 0 ? rows : null;
}
