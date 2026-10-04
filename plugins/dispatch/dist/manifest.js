/**
 * dispatch — manifest.
 *
 * Replaces `dispatcher.py` / `paperclip-dispatcher.timer`: a host-side script,
 * outside any repo, unreadable from any agent container, whose stdout went
 * nowhere durable. This runs as a `jobs.schedule` sweep on the same 30-minute
 * cadence, writes its counters to `metrics.write` every firing, and — once the
 * evidence gate passes — wakes stalled work through the host's own rails.
 *
 * Two things about this manifest are load-bearing and easy to "tidy" wrongly:
 *
 *   1. `wakeEnabled` DEFAULTS TO FALSE. The design (Q1) buys the wake action
 *      with a week of report-only evidence, not with an argument. A default of
 *      true would make installing the plugin the thing that enables it, which
 *      is exactly the step the retirement plan puts behind the gate.
 *
 *   2. There is NO `database` declaration, and that is a capability decision.
 *      ADR 0003 requires idle measured against
 *      `heartbeat_runs.context_snapshot->>'issueId'`. The obvious route is
 *      `ctx.db.query` against the whitelisted `heartbeat_runs` core table —
 *      but `manifest.database` requires `database.namespace.migrate`
 *      (server/dist/services/plugin-capability-validator.js:165, the
 *      FEATURE_CAPABILITIES map), so a read-only reporter would have to hold a
 *      DDL capability to do a SELECT. `issues.summaries.getOrchestration`
 *      reaches the same rows through `getIssueRunSummaries`
 *      (plugin-host-services.js:864), which filters on exactly that JSON
 *      expression. Same measurement, read-only capability. See selection.js.
 */

export const manifest = {
  id: "dispatch",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Dispatch",
  description:
    "Reports, and once evidence-gated wakes, stalled assigned work that no state change would otherwise wake. Native replacement for the host-side paperclip-dispatcher timer.",
  author: "Director of Engineering (Paperclip)",
  categories: ["automation"],

  capabilities: [
    // The substrate (Q3). Every firing runs from here.
    "jobs.schedule",

    // Selection input: the candidate population and its unblockDescriptor,
    // which issues.list projects (server/dist/services/issues.js:2287).
    "issues.read",
    // The server's blocker rail, mirrored so a refusal is COUNTED rather than
    // discovered by calling requestWakeup and catching.
    "issue.relations.read",
    // Idle measurement against heartbeat_runs — see the note above.
    "issues.orchestration.read",
    // Which company's board to sweep. A job context carries no companyId.
    "companies.read",
    // Report the routing gap to a principal who can actually close it (Q2):
    // waking is never assignment, so we need to name who holds tasks:assign.
    "agents.read",

    // The action, gated behind config.wakeEnabled. Declared here because
    // capabilities are static and a later "upgrade" that adds one puts the
    // plugin into upgrade_pending (PLUGIN_SPEC.md §15.3) — so the report-only
    // week must run with the eventual capability set already installed, or
    // the evidence is not evidence for the thing we ship.
    "issues.wakeup",

    // Reporting contract (Q5): counters every firing, activity only on a
    // state change.
    "metrics.write",
    "activity.log.write",

    // The real overlap control. ADR 0001: idempotencyKey is written and never
    // read, so at-most-once comes from host coalescing plus our own record of
    // what we last dispatched.
    "plugin.state.read",
    "plugin.state.write",
  ],

  entrypoints: { worker: "./dist/worker.js" },

  jobs: [
    {
      jobKey: "dispatch-sweep",
      displayName: "Dispatch sweep",
      description:
        "Selects stalled assigned issues by the ADR 0003 policy and reports them. Wakes them only when wakeEnabled is true. Silent unless state changes.",
      // Every 30 minutes, matching the retired timer's cadence so the two are
      // diffable during the parallel week (retirement plan step 2).
      schedule: "*/30 * * * *",
    },
  ],

  instanceConfigSchema: {
    type: "object",
    required: [],
    additionalProperties: false,
    properties: {
      wakeEnabled: {
        type: "boolean",
        title: "Enable the wake action",
        description:
          "OFF until the evidence gate in docs/tog-706-dispatch-plugin-design.md step 3 passes. While off, the sweep runs the real selection policy and reports what it WOULD have woken, and calls requestWakeup zero times.",
        default: false,
      },
      idleMinutes: {
        type: "number",
        title: "Idle threshold (minutes)",
        description:
          "How long since the last heartbeat run scoped to that issue before it counts as stalled. Measured against heartbeat_runs.context_snapshot->>'issueId', not updated_at, which any comment refreshes (ADR 0003).",
        default: 120,
        minimum: 5,
        maximum: 10080,
      },
      maxWakesPerFiring: {
        type: "number",
        title: "Maximum wakes per firing",
        description:
          "Cap on selected issues per sweep. The retired script used 2; ADR 0003 measured the genuinely actionable set at 3. Picks are spread across distinct assignees, because host coalescing is per-agent (ADR 0001) and two picks for one agent collapse into one run.",
        default: 3,
        minimum: 1,
        maximum: 25,
      },
      focusProjectIds: {
        type: "array",
        title: "Focus project IDs",
        description:
          "Optional. When set, only issues in these projects are selectable — the retired script's `scope: FOCUS ONLY` hard filter. Empty means the whole company, which is WIDER than the script was.",
        default: [],
        items: { type: "string" },
      },
    },
  },
};

export default manifest;
