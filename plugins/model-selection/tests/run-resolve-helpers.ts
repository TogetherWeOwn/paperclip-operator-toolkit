import type { LaneLedger } from "../src/engine/pacing.js";

export type { LaneLedger };
export type LanePaceVerdictLike = NonNullable<LaneLedger[string]["verdict"]>;

/** A lane the pace engine reads as unserviceable: `hardStopExcluded` is true for its models. */
export function stoppedLane(laneId: string): LaneLedger[string] {
  return {
    laneId,
    verdict: { serviceable: false, state: "exhausted", reason: "serviceability-window-exhausted" } as unknown as LanePaceVerdictLike,
    observation: null,
    fetchedAt: "2026-09-10T11:59:00.000Z",
    error: null,
  } as LaneLedger[string];
}
