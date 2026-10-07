/**
 * Lane documents straight from CLIProxy (owner 2026-10-04: "pull the usage data directly from CLIProxy, not
 * some middleman").
 *
 * CLIProxy's `GET /v0/management/auth-files` carries, per credential, `quota.signals`: the provider's own
 * rate-limit response headers, recorded passively from every real request. Reading them costs no call to the
 * provider, so it can never trip the provider usage endpoints' poll throttling (Anthropic `oauth/usage` 429s
 * at roughly one call per two minutes per account).
 *
 * This module converts that response into the same lane document the pace engine already reads (records
 * with `five_hour_utilization`, `seven_day_utilization` / `weekly_utilization` and `*_resets_at`), so lane
 * window definitions stay unchanged. Pure: no I/O, no clock other than the `now` argument.
 */

export type AuthFilesProvider = "claude" | "codex";

export const AUTH_FILES_PROVIDERS: readonly AuthFilesProvider[] = ["claude", "codex"];

/** A lane document is stale past this, matching the snapshot files' published `staleAfterSeconds`. */
const STALE_AFTER_SECONDS = 300;

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function epochIso(value: unknown): string | null {
  const seconds = num(value);
  return seconds === null || seconds <= 0 ? null : new Date(seconds * 1000).toISOString();
}

function clampFraction(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * An idle account's signals are the last values its provider reported. Usage only rises inside a window, so
 * the last value stays a correct lower bound until the window's reset; after the reset the window is empty.
 */
function windowFields(
  name: string,
  utilization: number | null,
  resetsAt: string | null,
  nowMs: number,
): Json {
  if (utilization === null) return {};
  if (resetsAt !== null && Date.parse(resetsAt) <= nowMs) {
    return { [`${name}_utilization`]: 0, [`${name}_resets_at`]: null };
  }
  return { [`${name}_utilization`]: clampFraction(utilization), [`${name}_resets_at`]: resetsAt };
}

/**
 * CLIProxy's scheduler routing weight for one credential. Credentials default
 * to 1; a value <= 0 normalizes to 0, meaning the credential is excluded from
 * routing and takes no traffic. It says nothing about plan size, so it must
 * never be emitted as the pace allowance weight. Absent/unparseable means the
 * default: the credential routes normally.
 */
function routingWeight(auth: Json): number | null {
  if (auth.weight === null || auth.weight === undefined) return null;
  return num(auth.weight);
}

/** A lane-config plan weight is usable only as a strictly positive number. */
function planWeightFor(accountKey: string, planWeights: Readonly<Record<string, number>> | undefined): number | null {
  if (!planWeights) return null;
  const raw = planWeights[accountKey];
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;
}

function health(auth: Json): string {
  if (auth.unavailable === true) return "exhausted";
  const status = typeof auth.status === "string" ? auth.status : "";
  if (status === "error") {
    const message = typeof auth.status_message === "string" ? auth.status_message : "";
    return /limit|quota|exhaust/i.test(message) ? "exhausted" : "unknown";
  }
  return "healthy";
}

function claudeWindows(signals: Json, nowMs: number): Json | null {
  const week = num(signals["Anthropic-Ratelimit-Unified-7d-Utilization"]);
  const five = num(signals["Anthropic-Ratelimit-Unified-5h-Utilization"]);
  if (week === null && five === null) return null;
  return {
    governing_window: "seven_day",
    window_seconds: { five_hour: 18_000, seven_day: 604_800 },
    ...windowFields("five_hour", five, epochIso(signals["Anthropic-Ratelimit-Unified-5h-Reset"]), nowMs),
    ...windowFields("seven_day", week, epochIso(signals["Anthropic-Ratelimit-Unified-7d-Reset"]), nowMs),
  };
}

function codexWindows(signals: Json, nowMs: number): Json | null {
  const out: Json = { governing_window: "weekly", window_seconds: {} as Json };
  let any = false;
  for (const side of ["Primary", "Secondary"]) {
    const minutes = num(signals[`X-Codex-${side}-Window-Minutes`]);
    const used = num(signals[`X-Codex-${side}-Used-Percent`]);
    if (!minutes || minutes <= 0 || used === null) continue;
    const seconds = minutes * 60;
    const name = seconds <= 18_000 ? "five_hour" : seconds <= 604_800 ? "weekly" : "monthly";
    (out.window_seconds as Json)[name] = seconds;
    Object.assign(out, windowFields(name, used / 100, epochIso(signals[`X-Codex-${side}-Reset-At`]), nowMs));
    any = true;
  }
  if (typeof signals["X-Codex-Plan-Type"] === "string") out.plan = signals["X-Codex-Plan-Type"];
  return any ? out : null;
}

/**
 * Build a lane document for one provider from a CLIProxy auth-files response. Disabled credentials, and
 * credentials with a routing weight <= 0 (parked: they take no traffic), are not part of the serving pool
 * and are omitted — emitting a zero pace weight would make the whole lane indeterminate. A credential with
 * no recorded signals yet is emitted with health only, so the pace engine sees the account but no
 * fabricated utilization. The pace allowance weight comes only from `planWeights` (lane config, keyed by
 * account key): the routing weight is scheduler state and is never emitted.
 */
export function authFilesToLaneDocument(
  response: unknown,
  provider: AuthFilesProvider,
  nowMs: number,
  planWeights?: Readonly<Record<string, number>>,
): { observedAt: string; staleAfterSeconds: number; source: string; records: Json[] } {
  const files = Array.isArray(asRecord(response).files) ? (asRecord(response).files as unknown[]) : [];
  const auths = files
    .map(asRecord)
    .filter((auth) => {
      if (auth.provider !== provider || auth.disabled === true || auth.status === "disabled") return false;
      const weight = routingWeight(auth);
      return weight === null || weight > 0;
    })
    .sort((a, b) => String(a.auth_index ?? "").localeCompare(String(b.auth_index ?? "")));
  const records = auths.map((auth, i) => {
    const quota = asRecord(auth.quota);
    const signals = asRecord(quota.signals);
    const windows = provider === "claude" ? claudeWindows(signals, nowMs) : codexWindows(signals, nowMs);
    const accountKey = typeof auth.auth_index === "string" ? auth.auth_index : `${provider}-lane-${i + 1}`;
    const planWeight = planWeightFor(accountKey, planWeights);
    const record: Json = {
      lane: `${provider}-lane-${i + 1}`,
      account_key: accountKey,
      health: health(auth),
      ...(planWeight !== null ? { plan_weight: planWeight } : {}),
      observationQuality: windows ? "cliproxy-passive" : "absent",
      observedAt: typeof quota.observed_at === "string" ? quota.observed_at : null,
      ...(windows ?? {}),
    };
    if (provider === "codex" && num(record.weekly_utilization) !== null && (record.weekly_utilization as number) >= 1) {
      record.health = "exhausted";
    }
    return record;
  });
  return {
    observedAt: new Date(nowMs).toISOString(),
    staleAfterSeconds: STALE_AFTER_SECONDS,
    source: "cliproxy:/v0/management/auth-files quota.signals",
    records,
  };
}
