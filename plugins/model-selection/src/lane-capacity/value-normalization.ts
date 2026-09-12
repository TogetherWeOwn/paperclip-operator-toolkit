// Vendored from @togetherweown/lane-capacity (paperclip-model-router,
// packages/lane-capacity/src/value-normalization.ts), byte-faithful, because
// that package is workspace-internal to a different git repo and is not
// published to any npm registry (`npm view` returns E404) — there is no
// dependency mechanism between the two repos. Do not hand-edit divergently
// from the source; if the accepted pace engine changes, re-vendor from there.
import type { CapacityHealth } from "./types.js";

export function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function firstValue(
  record: Record<string, unknown>,
  fields: string[],
): { value: unknown; field: string } | null {
  for (const field of fields) {
    if (field in record) return { value: record[field], field };
  }
  return null;
}

export function fraction(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

export function timestamp(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export function normalizeHealth(value: unknown): CapacityHealth | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["healthy", "available", "allowed", "ready", "ok", "active"].includes(normalized)) return "healthy";
  if (["degraded", "limited", "warning", "cooldown", "cooling_down"].includes(normalized)) return "degraded";
  if (["exhausted", "quota_exhausted", "rate_limited"].includes(normalized)) return "exhausted";
  if (["unavailable", "disabled", "offline", "error", "blocked"].includes(normalized)) return "unavailable";
  if (["unknown", "stale"].includes(normalized)) return "unknown";
  return null;
}
