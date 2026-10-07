import type { LaneLedger } from "./engine/pacing.js";
import { laneBurnDown } from "./lane-capacity/burn-down.js";
import {
  proposeFleetAdmission,
  type FleetAdmissionBackstop,
  type FleetAdmissionInventory,
  type FleetAdmissionLaneInput,
  type FleetAdmissionLevel,
  type FleetAdmissionProposal,
  type FleetLaneRate,
} from "./lane-capacity/fleet-admission.js";
import type { LanePaceVerdict } from "./lane-capacity/pace.js";

/**
 * Shadow-only fleet admission wiring. Pure: turns the already-polled lane
 * ledger into a `proposeFleetAdmission` call and folds the proposal into the
 * account admission shadow report. Nothing here selects, reserves, pins or
 * starts anything; an `unknown` proposal records nothing and changes nothing.
 */

export interface FleetShadowInput {
  lanes: FleetAdmissionLaneInput[];
  previousLevel?: FleetAdmissionLevel | null;
  asOf?: string | null;
}

export interface FleetAdmissionShadowProposal {
  level: FleetAdmissionLevel;
  admissionFraction: number | null;
  reason: FleetAdmissionProposal["reason"];
  projected: number | null;
  remainingFraction: number | null;
  soonestResetAt: string | null;
  spendOrder: string[];
  withheld: string[];
  backstop: FleetAdmissionBackstop;
  inventory: FleetAdmissionInventory;
  lanes: FleetLaneRate[];
  asOf: string | null;
  /** The carried level this proposal was evaluated against. */
  previousLevel: FleetAdmissionLevel | null;
}

export interface FleetHistoryEntry {
  asOf: string;
  level: Exclude<FleetAdmissionLevel, "unknown">;
  projected: number | null;
  lanes: Array<{ laneId: string; projected: number | null }>;
}

export const MAX_FLEET_HISTORY = 200;

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The governing allowance window length for one lane: the longest
 * `windowSeconds` across the governing windows of its computable (serviceable,
 * scored) accounts. Null when no account has one — the level and spend order
 * still compute, only the per-hour rate readouts report null.
 */
export function laneWindowSeconds(verdict: LanePaceVerdict): number | null {
  let best: number | null = null;
  for (const account of verdict.accounts ?? []) {
    if (account.serviceable !== true || account.score === null) continue;
    const governing = (account.windows ?? []).find((window) => window.name === account.governingWindow);
    const seconds = positive(governing?.windowSeconds);
    if (seconds !== null && (best === null || seconds > best)) best = seconds;
  }
  return best;
}

/**
 * Build the proposal inputs from the live pace ledger. Inventory (counts and
 * weights) comes from the verdicts themselves, so an added or cancelled
 * account reflows into the next proposal with no config edit.
 */
export function fleetLaneInputsForLedger(ledger: LaneLedger): FleetAdmissionLaneInput[] {
  return Object.values(ledger)
    .filter((entry) => entry.verdict !== null)
    .map((entry) => {
      const verdict = entry.verdict!;
      return {
        verdict,
        burndown: laneBurnDown(verdict),
        windowSeconds: laneWindowSeconds(verdict),
      };
    });
}

export function proposeShadowFleetAdmission(input: FleetShadowInput): FleetAdmissionProposal {
  return proposeFleetAdmission({
    lanes: input.lanes,
    asOf: input.asOf ?? null,
    previousLevel: input.previousLevel ?? null,
  });
}

/**
 * Fold a proposal into the shadow report shape. `unknown` returns null:
 * callers record nothing and keep the previously stored level.
 */
export function fleetProposalRecord(
  proposal: FleetAdmissionProposal | null | undefined,
  previousLevel: FleetAdmissionLevel | null,
): FleetAdmissionShadowProposal | null {
  if (!proposal || proposal.level === "unknown") return null;
  return {
    level: proposal.level,
    admissionFraction: proposal.admissionFraction,
    reason: proposal.reason,
    projected: proposal.projected,
    remainingFraction: proposal.remainingFraction,
    soonestResetAt: proposal.soonestResetAt,
    spendOrder: [...proposal.spendOrder],
    withheld: [...proposal.withheld],
    backstop: {
      trippedLanes: [...proposal.backstop.trippedLanes],
      trippedShare: proposal.backstop.trippedShare,
      holdShare: proposal.backstop.holdShare,
      capped: proposal.backstop.capped,
    },
    inventory: {
      knownAccountCount: proposal.inventory.knownAccountCount,
      knownWeight: proposal.inventory.knownWeight,
      serviceableAccountCount: proposal.inventory.serviceableAccountCount,
      computableAccountCount: proposal.inventory.computableAccountCount,
      lanes: proposal.inventory.lanes.map((lane) => ({ ...lane })),
    },
    lanes: proposal.lanes.map((lane) => ({ ...lane })),
    asOf: proposal.asOf,
    previousLevel,
  };
}

/**
 * Thread the upgrade-only hysteresis across cycles: a fresh known proposal
 * becomes the next cycle's previous level; `unknown` (or no proposal) keeps
 * the stored one, so one unreadable cycle cannot reset the deadband.
 */
export function nextFleetPreviousLevel(
  stored: FleetAdmissionLevel | null,
  proposal: FleetAdmissionShadowProposal | null | undefined,
): FleetAdmissionLevel | null {
  if (!proposal) return stored;
  return proposal.level;
}

function isLevel(value: unknown): value is FleetAdmissionLevel {
  return value === "boost" || value === "normal" || value === "hold" || value === "conserve" || value === "unknown";
}

/** Read the carried level back out of the stored shadow-report document. */
export function storedFleetPreviousLevel(stored: unknown): FleetAdmissionLevel | null {
  if (!stored || typeof stored !== "object") return null;
  const record = stored as Record<string, unknown>;
  const direct = record.fleetPreviousLevel;
  if (isLevel(direct) && direct !== "unknown") return direct;
  const report = record.report as { fleetProposal?: { level?: unknown } } | undefined;
  if (report && isLevel(report.fleetProposal?.level) && report.fleetProposal!.level !== "unknown") {
    return report.fleetProposal!.level as FleetAdmissionLevel;
  }
  return null;
}

export function storedFleetHistory(stored: unknown): FleetHistoryEntry[] {
  if (!stored || typeof stored !== "object") return [];
  const history = (stored as Record<string, unknown>).fleetHistory;
  return Array.isArray(history) ? (history as FleetHistoryEntry[]) : [];
}

/** Append one known proposal to the rolling history, bounded and oldest-first. */
export function appendFleetHistory(
  history: FleetHistoryEntry[],
  proposal: FleetAdmissionShadowProposal | null | undefined,
): FleetHistoryEntry[] {
  if (!proposal || proposal.asOf === null) return history;
  const next = [
    ...history,
    {
      asOf: proposal.asOf,
      level: proposal.level as Exclude<FleetAdmissionLevel, "unknown">,
      projected: proposal.projected,
      lanes: proposal.lanes.map((lane) => ({ laneId: lane.laneId, projected: lane.projected })),
    },
  ];
  return next.slice(-MAX_FLEET_HISTORY);
}
