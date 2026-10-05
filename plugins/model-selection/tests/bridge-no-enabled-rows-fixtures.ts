import type { ModelEntry } from "../src/engine/types.js";

/**
 *  fixtures: minimal bridge-model roster snapshots.
 *
 * Pure builders only; no live state, no secrets, no config resolution, no
 * staging dependency. Each builder returns an in-memory `ModelEntry[]` the
 * advise-path helper reads directly.
 */

function row(id: string, enabled: boolean): ModelEntry {
  return {
    id,
    tier: "T3",
    enabled,
    costPerMTokIn: 0,
    costPerMTokOut: 0,
    costPerMTokCacheRead: 0,
    capabilities: ["tools"],
    contextWindow: 1_000_000,
    aaIndex: null,
    releasedAt: "1970-01-01",
    fallbackOnly: false,
    note: "",
    earnIn: null,
  };
}

/** Roster carrying exactly one ENABLED row for `modelId` (plus an unrelated row). */
export function rosterWithEnabledBridgeRow(modelId: string): ModelEntry[] {
  return [row(modelId, true), row("unrelated-model", true)];
}

/** Roster with NO row at all for `modelId` — zero-rows case. */
export function rosterWithoutBridgeRow(modelId: string): ModelEntry[] {
  void modelId;
  return [row("unrelated-model", true)];
}

/** Roster where every row for `modelId` exists but is disabled — disabled-only case. */
export function rosterWithDisabledOnlyBridgeRows(modelId: string): ModelEntry[] {
  return [row(modelId, false), row(modelId, false), row("unrelated-model", true)];
}
