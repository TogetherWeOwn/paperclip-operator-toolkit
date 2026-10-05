export interface T0ShadowViolation {
  issue: string | null;
  ts: string | null;
  tier: string | null;
  pickedModel: string | null;
  t0Candidates: string[];
}

export interface T0ShadowResult {
  decisions: number;
  malformed: number;
  optedInT0Decisions: number;
  ceilingMarkerDecisions: number;
  violations: T0ShadowViolation[];
  minDecisions: number;
  verdict: "verified" | "violations" | "insufficient-evidence";
}

export function evaluateT0Shadow(
  lines: readonly string[],
  options?: { t0Ids?: readonly string[]; minDecisions?: number },
): T0ShadowResult;
