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
import type { LanePaceVerdict, PaceAccountVerdict, PaceWindowVerdict } from "./lane-capacity/pace.js";

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

export interface FleetHistoryLane {
  laneId: string;
  projected: number | null;
  /** Optional only for old history, which cannot validate a reset. */
  utilization?: number | null;
  resetAt?: string | null;
  observedAt?: string | null;
}

export interface FleetHistoryEntry {
  asOf: string;
  level: Exclude<FleetAdmissionLevel, "unknown">;
  projected: number | null;
  lanes: FleetHistoryLane[];
}

export const MAX_FLEET_HISTORY = 200;

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export const WEEK_SECONDS = 7 * 24 * 60 * 60;

/** Serviceability windows are a backstop, never a substitute for weekly allowance. */
export function weeklyAllowanceWindow(account: PaceAccountVerdict): PaceWindowVerdict | null {
  return (account.windows ?? []).find(window =>
    window.name === account.governingWindow && window.role === "allowance" && window.windowSeconds === WEEK_SECONDS,
  ) ?? null;
}

export function laneWindowSeconds(verdict: LanePaceVerdict): number | null {
  return verdict.serviceable === true && verdict.accounts.some(account =>
    account.serviceable === true && account.score !== null && weeklyAllowanceWindow(account) !== null,
  ) ? WEEK_SECONDS : null;
}

/** Adapt the plugin's per-window weights without diverging from the vendored proposer. */
function weeklyFleetVerdict(verdict: LanePaceVerdict): LanePaceVerdict {
  return {
    ...verdict,
    accounts: verdict.accounts.map(account => {
      const weekly = weeklyAllowanceWindow(account);
      const weight = positive(weekly?.allowanceWeight ?? account.weight);
      const computable = verdict.serviceable === true && weekly !== null && weight !== null;
      return {
        ...account,
        weight,
        score: computable ? account.score : null,
        governingResetAt: weekly?.resetsAt ?? null,
      };
    }),
  };
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
      const verdict = weeklyFleetVerdict(entry.verdict!);
      return {
        verdict,
        burndown: laneBurnDown(verdict),
        windowSeconds: laneWindowSeconds(verdict),
      };
    });
}

/** Weekly measurements retain their source clock and reset, including temporarily tripped accounts. */
export function weeklyLaneReadingsForLedger(ledger: LaneLedger): FleetHistoryLane[] {
  const readings: FleetHistoryLane[] = [];
  for (const entry of Object.values(ledger)) {
    const verdict = entry.verdict;
    if (!verdict || verdict.serviceable === null || !verdict.observedAt) continue;
    const observedMs = Date.parse(verdict.observedAt);
    if (!Number.isFinite(observedMs)) continue;
    const groups = new Map<string, { weight: number; utilized: number }>();
    for (const account of verdict.accounts) {
      const weekly = weeklyAllowanceWindow(account);
      const weight = positive(weekly?.allowanceWeight ?? account.weight);
      const resetAt = weekly?.resetsAt;
      const utilization = weekly?.utilization;
      if (!resetAt || weight === null || typeof utilization !== "number" || !Number.isFinite(utilization)) continue;
      const resetMs = Date.parse(resetAt);
      if (!Number.isFinite(resetMs) || observedMs > resetMs || observedMs <= resetMs - WEEK_SECONDS * 1000) continue;
      const group = groups.get(resetAt) ?? { weight: 0, utilized: 0 };
      group.weight += weight;
      group.utilized += utilization * weight;
      groups.set(resetAt, group);
    }
    for (const [resetAt, group] of groups) {
      const utilization = group.utilized / group.weight;
      const elapsed = 1 - (Date.parse(resetAt) - observedMs) / (WEEK_SECONDS * 1000);
      readings.push({ laneId: verdict.laneId, projected: utilization / elapsed,
        utilization, resetAt, observedAt: verdict.observedAt });
    }
  }
  return readings.sort((a, b) => a.laneId.localeCompare(b.laneId) || a.resetAt!.localeCompare(b.resetAt!));
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
  ledger?: LaneLedger,
): FleetHistoryEntry[] {
  if (!proposal || proposal.asOf === null) return history;
  const next = [
    ...history,
    {
      asOf: proposal.asOf,
      level: proposal.level as Exclude<FleetAdmissionLevel, "unknown">,
      projected: proposal.projected,
      lanes: ledger ? weeklyLaneReadingsForLedger(ledger)
        : proposal.lanes.map((lane) => ({ laneId: lane.laneId, projected: lane.projected })),
    },
  ];
  return next.slice(-MAX_FLEET_HISTORY);
}
