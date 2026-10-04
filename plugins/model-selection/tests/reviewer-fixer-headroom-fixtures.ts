import type { HeadroomAssignment, ReviewerFixerHeadroomInput } from "../src/reviewer-fixer-headroom.js";

/**
 * Fixtures: reviewer/fixer headroom readout inputs.
 *
 * Pure builders only; no live state, no secrets. Clock is fixed so the
 * evaluatedAt assertion is deterministic.
 */

export const NOW_MS = Date.parse("2026-10-04T00:00:00.000Z");

export function reviewer(agentId: string, overrides: Partial<HeadroomAssignment> = {}): HeadroomAssignment {
  return { agentId, maxConcurrent: 2, assigned: 0, ...overrides };
}

export function fixer(agentId: string, overrides: Partial<HeadroomAssignment> = {}): HeadroomAssignment {
  return { agentId, maxConcurrent: 2, assigned: 0, ...overrides };
}

export function baseInput(overrides: Partial<ReviewerFixerHeadroomInput> = {}): ReviewerFixerHeadroomInput {
  return {
    now: NOW_MS,
    reviewers: [reviewer("reviewer-1"), reviewer("reviewer-2")],
    fixers: [fixer("fixer-1"), fixer("fixer-2")],
    pendingUnassigned: { reviews: 0, fixes: 0 },
    ...overrides,
  };
}
