import { recordOf } from "./value-normalization.js";

/** Operator-observed producer contract, 2026-10-01; see . */
export interface CountsOnlyEvidence {
  requestsToday: number;
  requestsLifetime: number;
  dayResetsAt: string;
  dailySeconds: number;
}

export interface ModelCooldown {
  model: string | null;
  scope: string;
  reason: string;
  retry_at: string;
}

function utcTimestamp(value: unknown): value is string {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Missing utilization is NOT the discriminator; even tagged contradictions are invalid. */
export function countsOnlyEvidence(
  raw: Record<string, unknown>,
  utilizationFields: readonly string[] = [],
): CountsOnlyEvidence | null {
  if (raw.observationQuality !== "counts-only") return null;
  if (Object.keys(raw).some((key) => /utilization|allowance/i.test(key) || utilizationFields.includes(key))) return null;
  if ("windows" in raw || !count(raw.requests_today) || !count(raw.requests_lifetime)) return null;
  const seconds = recordOf(raw.window_seconds)?.daily;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (raw.governing_window !== "daily" || !utcTimestamp(raw.day_resets_at)) return null;
  if (typeof raw.health !== "string" || !raw.health.trim()) return null;
  return {
    requestsToday: raw.requests_today,
    requestsLifetime: raw.requests_lifetime,
    dayResetsAt: raw.day_resets_at,
    dailySeconds: seconds,
  };
}

/** Absence is valid. A malformed present array must not silently become an empty one. */
export function modelCooldowns(raw: Record<string, unknown>): ModelCooldown[] | null {
  if (!("model_cooldowns" in raw)) return [];
  if (!Array.isArray(raw.model_cooldowns)) return null;
  const entries: ModelCooldown[] = [];
  for (const value of raw.model_cooldowns) {
    const entry = recordOf(value);
    if (!entry || !(entry.model === null || (typeof entry.model === "string" && entry.model.trim()))) return null;
    if (typeof entry.scope !== "string" || !entry.scope.trim() || typeof entry.reason !== "string" || !entry.reason.trim()) return null;
    if (!utcTimestamp(entry.retry_at)) return null;
    entries.push({ model: entry.model, scope: entry.scope, reason: entry.reason, retry_at: entry.retry_at });
  }
  return entries;
}

/** The producer already intersects live credentials. Do not intersect or widen by scope again. */
export function activeModelCooldown(
  entries: readonly ModelCooldown[],
  modelId: string | undefined,
  nowMs: number,
): boolean {
  return entries.some((entry) => entry.reason !== "transient_error" &&
    (entry.model === null || entry.model === modelId) && Date.parse(entry.retry_at) > nowMs);
}
