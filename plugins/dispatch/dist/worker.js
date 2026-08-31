/**
 * dispatch — worker (TOG-747, implementing the TOG-706 design).
 *
 * One scheduled sweep, every 30 minutes. Per company:
 *
 *   1. list the board                       (issues.read)
 *   2. read blockers + runs + budget blocks (issue.relations.read,
 *                                            issues.orchestration.read)
 *   3. decide                               (selection.js — no host calls)
 *   4. wake, one issue at a time            (issues.wakeup, ONLY if enabled)
 *   5. report                               (metrics every firing, activity on
 *                                            a state change)
 *
 * Step 4 is off by default and stays off until the evidence gate in
 * docs/tog-706-dispatch-plugin-design.md step 3 passes. Steps 1-3 and 5 run
 * identically either way — that is what makes the report-only week evidence for
 * the enabled behaviour rather than evidence for a different program.
 *
 * Two host facts shape the whole file:
 *
 *   - A PluginJobContext carries {jobKey, runId, trigger, scheduledAt} and NO
 *     companyId. A scheduled sweep is instance-scoped, so it enumerates
 *     companies itself. Every downstream call is then explicitly company-scoped
 *     and the host re-checks it (ensurePluginAvailableForCompany).
 *
 *   - requestWakeups() is a bare for-loop with no try/catch that throws on the
 *     first refusal AFTER having already woken every prior issue, discarding
 *     the whole result set (ADR 0004). So the batch call is never used, at any
 *     size, including one.
 */

import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { manifest } from "./manifest.js";
import { identifyRoutingOwners, selectDispatch, summariseRoutingGap } from "./selection.js";
import { emitMetrics, hasStateChanged, logStateChange, summariseFiring } from "./reporting.js";

/** Config defaults. Mirrors instanceConfigSchema — a company may set none. */
const DEFAULTS = {
  wakeEnabled: false,
  idleMinutes: 120,
  maxWakesPerFiring: 3,
  focusProjectIds: [],
};

/**
 * `issues.list` windows in the HOST process after the query returns
 * (plugin-host-services.js:1624 — `applyWindow(await issues.list(...), params)`),
 * so an unset limit is a full board read, not an unbounded page. We pass one
 * anyway and check for saturation: a sweep that silently sees only the first N
 * cards would report a clean board while the stalls sat on page two.
 */
const ISSUE_PAGE_LIMIT = 1000;

/**
 * Statuses worth reading detail for. Terminal cards are excluded before the
 * per-issue orchestration reads, which is the expensive part — one host call
 * per issue. The five counters are defined over the non-terminal board anyway
 * (docs/dispatch-plugin-facts.md §3, denominator 216).
 */
const TERMINAL = new Set(["done", "cancelled"]);

const readConfig = async (ctx, companyId) => {
  const raw = (await ctx.config.get(companyId)) ?? {};
  return {
    wakeEnabled: raw.wakeEnabled === true,
    idleMinutes: typeof raw.idleMinutes === "number" ? raw.idleMinutes : DEFAULTS.idleMinutes,
    maxWakesPerFiring:
      typeof raw.maxWakesPerFiring === "number" ? raw.maxWakesPerFiring : DEFAULTS.maxWakesPerFiring,
    focusProjectIds: Array.isArray(raw.focusProjectIds) ? raw.focusProjectIds : [],
  };
};

const stateKey = (companyId) => ({
  scopeKind: "company",
  scopeId: companyId,
  namespace: "dispatch",
  stateKey: "last-firing",
});

/**
 * Gather everything the policy needs for one issue.
 *
 * `getOrchestration` is one host call that answers three of the five rails at
 * once: `relations` (rail 3), `runs` (the ADR 0003 idle measurement, filtered
 * server-side on heartbeat_runs.context_snapshot->>'issueId'), and
 * `invocationBlocks` (rail 4, evaluated by the server's own budgets service).
 * Reading them from one snapshot also means they cannot disagree with each
 * other, which three separate calls could.
 *
 * A failure here is per-issue and non-fatal: one unreadable card must not turn
 * a whole company's sweep into a silence, because silence is what this plugin
 * exists to eliminate.
 */
async function gatherIssue(ctx, companyId, issue) {
  try {
    const summary = await ctx.issues.summaries.getOrchestration({ issueId: issue.id, companyId });
    return {
      issue,
      blockedBy: summary.relations?.[issue.id]?.blockedBy ?? [],
      runs: summary.runs ?? [],
      invocationBlock:
        (summary.invocationBlocks ?? []).find((block) => block.issueId === issue.id) ?? null,
    };
  } catch (error) {
    ctx.logger.warn("dispatch: orchestration read failed, issue excluded from selection", {
      companyId,
      issueId: issue.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Wake the picks, one call per issue, each in its own try/catch (ADR 0004).
 *
 * A refusal is DATA, not an error to be swallowed: it means our mirror of the
 * server's rails and the server's actual rails disagreed for that issue, which
 * is exactly what the evidence gate needs to see. So each outcome is recorded
 * with its reason and the loop continues.
 *
 * `idempotencyKey` is passed and is known NOT to dedupe: it is written 13 times
 * and read zero times inside heartbeat.wakeup(), and the only uniqueness index
 * is partial, scoped to keys prefixed `issue_review_path_lost:` (ADR 0001). It
 * is sent because it lands in the wakeup row and makes a firing traceable, not
 * because it prevents anything. The real overlap control is host coalescing,
 * which is keyed on the AGENT — which is why the policy spreads picks across
 * distinct assignees rather than relying on this key.
 */
async function wakePicks(ctx, companyId, picks, jobRunId) {
  const outcomes = [];

  for (const pick of picks) {
    const issue = pick.issue;
    try {
      const result = await ctx.issues.requestWakeup(issue.id, companyId, {
        reason: "dispatch_stalled_issue",
        contextSource: "plugin.dispatch.sweep",
        idempotencyKey: `dispatch:${jobRunId}:${issue.id}`,
      });
      outcomes.push({
        issueId: issue.id,
        queued: result?.queued === true,
        runId: result?.runId ?? null,
        idleMs: pick.idleMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Loud, because a refusal here is a defect in OUR selection: every rail
      // the server checks was mirrored before the pick was made.
      ctx.logger.error("dispatch: wake refused for a selected issue — mirror disagreed", {
        companyId,
        issueId: issue.id,
        error: message,
      });
      outcomes.push({ issueId: issue.id, queued: false, error: message, idleMs: pick.idleMs });
    }
  }

  return outcomes;
}

/** Sweep one company. Returns the firing summary, or null if nothing was read. */
async function sweepCompany(ctx, companyId, job) {
  const config = await readConfig(ctx, companyId);
  const notes = [];

  const issues = await ctx.issues.list({ companyId, limit: ISSUE_PAGE_LIMIT });
  if (issues.length >= ISSUE_PAGE_LIMIT) {
    // Never silently truncated. A capped read that reports as a full read is
    // the same class of defect as the 88% undercount this design was corrected
    // for: a number that looks like a measurement of the board but is a
    // measurement of the page size.
    notes.push(`issue list saturated at limit ${ISSUE_PAGE_LIMIT} — counters undercount the board`);
    ctx.logger.warn("dispatch: issue list hit the page limit; counters are an undercount", {
      companyId,
      limit: ISSUE_PAGE_LIMIT,
    });
  }

  const live = issues.filter((issue) => !TERMINAL.has(issue.status));

  // The routing gap needs only the list — an unassigned issue is refused on
  // rail 1 and never reaches the expensive per-issue reads.
  const routingGap = summariseRoutingGap(live.map((issue) => ({ issue })));

  // Who could close it. Only read when there is a gap to close: an agents.list
  // per company per firing to name owners of an empty problem is a host call
  // spent on nothing.
  if (routingGap.count > 0) {
    try {
      routingGap.owners = identifyRoutingOwners(await ctx.agents.list({ companyId }));
      if (!routingGap.owners.complete) {
        notes.push(
          `routing owners are a partial list: ${routingGap.owners.unreadableSources.join(", ")} ` +
            "are not readable from the plugin capability surface",
        );
      }
    } catch (error) {
      // Non-fatal. The gap COUNT is the reportable fact; the owner list is
      // help. Losing the help must not lose the count.
      ctx.logger.warn("dispatch: could not read agents to name routing owners", {
        companyId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Detail is read only for issues that could possibly be selected. An
  // unassigned card is already counted; paying a host call to confirm it has no
  // runs would multiply the sweep's cost by ~9 (38 of 216, facts §3) for a
  // number we already have.
  const candidates = live.filter((issue) => issue.assigneeAgentId);
  const gathered = [];
  for (const issue of candidates) {
    const entry = await gatherIssue(ctx, companyId, issue);
    if (entry) gathered.push(entry);
  }

  const unreadable = candidates.length - gathered.length;
  if (unreadable > 0) {
    notes.push(`${unreadable} assigned issues could not be read and are excluded from selection`);
  }

  // Unassigned issues are passed through un-gathered so the five counters
  // partition the whole non-terminal board, not just the part we read detail
  // for. classifyIssue stops them on rail 1 before it looks at runs.
  const population = [
    ...gathered,
    ...live.filter((issue) => !issue.assigneeAgentId).map((issue) => ({ issue })),
  ];

  const selection = selectDispatch(population, {
    idleMinutes: config.idleMinutes,
    maxWakesPerFiring: config.maxWakesPerFiring,
    focusProjectIds: config.focusProjectIds,
    now: Date.parse(job.scheduledAt) || Date.now(),
  });
  selection.routingGap = routingGap;

  const wakeOutcomes = config.wakeEnabled
    ? await wakePicks(ctx, companyId, selection.picks, job.runId)
    : [];

  if (!config.wakeEnabled && selection.picks.length > 0) {
    notes.push(
      `report-only: would have woken ${selection.picks.map((p) => p.issue.identifier ?? p.issue.id).join(", ")}`,
    );
  }

  const summary = summariseFiring(companyId, selection, wakeOutcomes);
  await emitMetrics(ctx, { companyId, summary, wakeEnabled: config.wakeEnabled });

  const previous = await ctx.state.get(stateKey(companyId));
  if (hasStateChanged(previous, summary)) {
    await logStateChange(ctx, { companyId, summary, wakeEnabled: config.wakeEnabled, notes });
    await ctx.state.set(stateKey(companyId), summary);
  }

  return { summary, notes };
}

export const plugin = definePlugin({
  async setup(ctx) {
    ctx.jobs.register("dispatch-sweep", async (job) => {
      const companies = await ctx.companies.list({});

      for (const company of companies) {
        try {
          await sweepCompany(ctx, company.id, job);
        } catch (error) {
          // One company's failure must not cancel the others. A sweep that
          // aborts on the first bad company would silently stop reporting for
          // every company after it in the list.
          ctx.logger.error("dispatch: company sweep failed", {
            companyId: company.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });
  },
});

export default plugin;

export { sweepCompany };

runWorker(plugin, import.meta.url);
