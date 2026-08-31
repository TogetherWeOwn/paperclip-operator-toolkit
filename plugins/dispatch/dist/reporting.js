/**
 * dispatch — the reporting contract (TOG-706 Q5).
 *
 * The thing being replaced wrote its counters to stdout on a host nobody can
 * read. So "report" here is the actual product of the plugin, not decoration
 * around the wake: during the report-only week it is the ONLY product.
 *
 * Two channels, deliberately different:
 *
 *   metrics.write — EVERY firing, unconditionally. A gauge that stops being
 *       written is indistinguishable from a gauge reading zero, so silence is
 *       never used to mean "nothing happened". `check-escalation-timeouts` on
 *       this box had 463 runs and 6 successes when the fact base was written
 *       (facts §7, 2026-08-30) and 680 runs with still 6 successes a day later:
 *       a job can fire reliably for months and do nothing, the gap widens
 *       silently, and only a per-firing metric distinguishes that from a job
 *       that stopped firing.
 *
 *   activity.log — ONLY on a state change. The board is a human surface. A
 *       line every 30 minutes saying "nothing changed" trains people to stop
 *       reading the line that says something did.
 *
 * `deadlocked_agents` is written as null, never 0. See emitMetrics.
 */

import { LEGACY_COUNTERS, SELECTION_COUNTERS } from "./selection.js";

/** Prefix for every metric this plugin writes, so a dashboard can glob them. */
export const METRIC_PREFIX = "dispatch";

/**
 * Reduce a firing to the value the state-change comparison is made against.
 *
 * Only the fields whose CHANGE is worth telling a human about. Idle
 * milliseconds are excluded on purpose: they change every single firing by
 * construction, so including them would make every firing a "state change" and
 * collapse the two channels back into one.
 */
export function summariseFiring(companyId, selection, wakeOutcomes) {
  return {
    companyId,
    counters: { ...selection.counters, woken: wakeOutcomes.filter((o) => o.queued).length },
    legacy: { ...selection.legacy },
    pickedIssueIds: selection.picks.map((pick) => pick.issue.id).sort(),
    parkedIssueIds: selection.parked.map((entry) => entry.issue.id).sort(),
    budgetBlockedIssueIds: selection.budgetBlocked.map((entry) => entry.issue.id).sort(),
    routingGapCount: selection.routingGap?.count ?? 0,
    // Who could close the routing gap, and whether that list is complete. Both
    // travel with the summary: a list of names with no completeness flag reads
    // as exhaustive, and this one is not (see identifyRoutingOwners).
    routingOwnerIds: (selection.routingGap?.owners?.owners ?? []).map((o) => o.agentId).sort(),
    routingOwnersComplete: selection.routingGap?.owners?.complete ?? false,
    wakeFailures: wakeOutcomes.filter((o) => !o.queued).map((o) => o.issueId).sort(),
  };
}

/**
 * True when this firing differs from the last one in a way a human should see.
 *
 * A missing previous summary counts as a change: the first firing after an
 * install has told nobody anything yet.
 */
export function hasStateChanged(previous, current) {
  if (!previous) return true;
  return JSON.stringify(canonicalise(previous)) !== JSON.stringify(canonicalise(current));
}

/** Key order is not guaranteed across a JSON round-trip through plugin state. */
function canonicalise(summary) {
  const sortKeys = (obj) =>
    Object.fromEntries(Object.entries(obj ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  return {
    companyId: summary.companyId ?? null,
    counters: sortKeys(summary.counters),
    legacy: sortKeys(summary.legacy),
    pickedIssueIds: [...(summary.pickedIssueIds ?? [])].sort(),
    parkedIssueIds: [...(summary.parkedIssueIds ?? [])].sort(),
    budgetBlockedIssueIds: [...(summary.budgetBlockedIssueIds ?? [])].sort(),
    routingGapCount: summary.routingGapCount ?? 0,
    routingOwnerIds: [...(summary.routingOwnerIds ?? [])].sort(),
    routingOwnersComplete: summary.routingOwnersComplete ?? false,
    wakeFailures: [...(summary.wakeFailures ?? [])].sort(),
  };
}

/**
 * Write every counter for one company's firing.
 *
 * The `wakeEnabled` tag is on EVERY metric, not just the wake ones. Without it
 * a `dispatch.woken = 0` series is ambiguous between "nothing needed waking"
 * and "the waker is switched off", and the evidence gate at the end of the
 * report-only week is precisely a comparison across that boundary.
 */
export async function emitMetrics(ctx, { companyId, summary, wakeEnabled }) {
  const tags = { companyId, wakeEnabled: String(wakeEnabled) };

  for (const name of SELECTION_COUNTERS) {
    await ctx.metrics.write(`${METRIC_PREFIX}.${name}`, summary.counters[name] ?? 0, tags);
  }

  for (const name of LEGACY_COUNTERS) {
    const value = summary.legacy[name];
    // deadlocked_agents is null by construction (Q5: no native equivalent).
    // metrics.write takes a number, so there is no way to write "unknown" —
    // and writing 0 would assert a measurement we did not make. So the series
    // is NOT WRITTEN AT ALL. An absent series reads as absent on a dashboard;
    // a zero series reads as a healthy zero. Only one of those is honest.
    if (typeof value !== "number") continue;
    await ctx.metrics.write(`${METRIC_PREFIX}.${name}`, value, tags);
  }

  // The routing gap (Q2) — work the server refuses outright for want of an
  // assignee. Net new against the retired script, which never reported it.
  await ctx.metrics.write(`${METRIC_PREFIX}.routing_gap`, summary.routingGapCount, tags);

  // A wake the server refused after we selected it. Non-zero here means our
  // mirror of the rails and the server's own rails disagreed — the single most
  // important number for the evidence gate, because it measures the mirror.
  await ctx.metrics.write(`${METRIC_PREFIX}.wake_failures`, summary.wakeFailures.length, tags);
}

/** One line, only when something changed. Metadata carries the full shape. */
export async function logStateChange(ctx, { companyId, summary, wakeEnabled, notes }) {
  const c = summary.counters;
  const mode = wakeEnabled ? "wake-enabled" : "report-only";
  const action = wakeEnabled
    ? `woke ${c.woken}`
    : `would have woken ${summary.pickedIssueIds.length}`;

  // The routing gap is the one number on this line a human has to ACT on — the
  // plugin cannot wake its owners on this server build (see selection.js), so
  // the sentence names them and says the list is partial.
  const routing =
    summary.routingGapCount > 0
      ? ` Unassigned (routing gap): ${summary.routingGapCount} — ${summary.routingOwnerIds.length} ` +
        `known assigner(s)${summary.routingOwnersComplete ? "" : ", partial list"}; no wake path, needs a human.`
      : " Unassigned (routing gap): 0.";

  await ctx.activity.log({
    companyId,
    message:
      `Dispatch sweep (${mode}): ${action} of ${summary.legacy.candidates_ready} candidates ` +
      `from a wakeable surface of ${summary.legacy.runnable_queue}. ` +
      `Parked on a named owner: ${c.parked_on_named_owner}.${routing}`,
    entityType: "plugin",
    entityId: "dispatch",
    metadata: { ...summary, wakeEnabled, notes: notes ?? [] },
  });
}
