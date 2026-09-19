import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

import { SELECTION_CONFIG_SCHEMA } from "./config/schema.js";
import { JOB_KEYS, LOCAL_FOLDER_KEYS, PLUGIN_API_VERSION, PLUGIN_ID, PLUGIN_VERSION, ROUTE_KEYS, TOOL_NAMES } from "./constants.js";

const DESCRIPTOR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["issueId"],
  properties: {
    issueId: { type: "string", minLength: 1 },
    /**
     * The capability-exclusion answer is SUPPLIED, never inferred. ADR-0004's
     * boundary is capability, not difficulty, and no text classifier can read
     * "does this touch money, credentials, fleet config, or an irreversible
     * action" off an issue title.
     */
    exclusion: {
      type: "object",
      additionalProperties: false,
      required: ["excluded"],
      properties: {
        excluded: { type: "boolean" },
        reasons: { type: "array", items: { type: "string" } },
      },
    },
    requiredCapabilities: {
      type: "array",
      items: { type: "string", enum: ["tools", "structured-output", "vision", "long-context", "computer-use"] },
    },
    requiredContextTokens: { type: "integer", minimum: 1 },
  },
} as const;

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: PLUGIN_API_VERSION,
  version: PLUGIN_VERSION,
  displayName: "Model Selection",
  description:
    "Chooses the cheapest fully-capable model for each harness run, keyed on a recorded tier judgement and ordered by a volume-aware cost term measured from this company's own runs.",
  author: "TogetherWeOwn",
  categories: ["automation"],
  capabilities: [
    // Read the issue, its labels, and the assignee's tier floor.
    "issues.read",
    "agents.read",
    // Write the per-issue override and the tier label. This is System 1 in
    // ADR-0010's taxonomy, reached through `issues.update` — the task-level
    // override — and deliberately NOT through `agents.managed`, which would
    // write agent rows verbatim and unvalidated. This plugin never changes an
    // agent's floor; it only decides one issue at a time, reversibly.
    "issues.update",
    // The decision record. Every selection is auditable after the fact.
    "activity.log.write",
    "metrics.write",
    "plugin.state.read",
    "plugin.state.write",
    "agent.tools.register",
    "api.routes.register",
    "jobs.schedule",
    "companies.read",
    // TOG-2137: poll operator-configured lane-capacity status URLs.
    "http.outbound",
    // TOG-2379: resolve a lane's optional apiKeySecretRef before polling it.
    "secrets.read-ref",
    // Capture issue.updated (reopen) / issue.comment.created (rejection) signals
    // for the card-level acceptance ledger, since `activity_log` is not an
    // allowlisted table and cannot be queried directly (TOG-1917 §2.2).
    "events.subscribe",
    // TOG-2137, Defect 2: raise a `tier-exhausted` alarm when every tier from
    // the required floor through T1 is pace-exhausted — there is nowhere left
    // to escalate to, and this must reach an operator rather than fail
    // silently the way the reference dispatcher's `pick()` does. The alarm
    // reuses this instance's existing `Operator: <title>` + `operator`-label
    // issue-creation convention (confirmed against 20+ live examples, e.g.
    // TOG-2318/TOG-2324/TOG-2333), not a same-issue interaction card — an
    // `Operator:` issue is a real, separately-triaged unit of work, and that
    // is what a capacity dead end actually is.
    "issues.create",
    // TOG-2481 absorption of the standalone `dispatch` plugin (TOG-747/TOG-706):
    // the stall-sweep reads blocker relations and the orchestration summary
    // (which mirrors the server's own budget-invocation-block verdict, see
    // dispatch-selection.ts's BUDGET_RAIL_MIRROR_SOURCE), and wakes a stalled
    // issue's existing run. Declared even though `dispatch.wakeEnabled`
    // defaults to false, matching the standalone plugin's own manifest.
    "issue.relations.read",
    "issues.orchestration.read",
    "issues.wakeup",
    // TOG-2572: the sweep must not wake a card that has its own monitor
    // wake scheduled (`monitorNextCheckAt`, read straight off the `Issue`
    // rows `issues.list` already returns) or a pending human-only ask —
    // neither of those is on `PluginIssueOrchestrationSummary`, so a
    // separate per-issue interaction read is required.
    "issue.interactions.read",
    // Recompute volume profiles and success scores from heartbeat_runs/issues/issue_comments.
    "database.namespace.read",
    // Required by `pluginManifestV1Schema` for ANY manifest declaring
    // `database`, even one that owns no tables: the validator pairs
    // `namespace.migrate` with `namespace.read` unconditionally. Our migrations
    // directory is deliberately empty (see migrations/README.md), so this
    // capability is declared and never exercised. It is NOT
    // `database.namespace.write` — this plugin never writes a row of its own.
    "database.namespace.migrate",
    // TOG-2137. Append-only `tog2138-decision-v1` shadow-decision JSONL, the
    // plugin-shadow half of the 48h host/plugin agreement stream. `ctx.db` is
    // scoped to `heartbeat_runs` reads only (above) and cannot hold an
    // append-only audit log a company operator can point external tooling at
    // directly — a local folder is the SDK's plain-file surface for exactly
    // that.
    "local.folders",
  ],
  entrypoints: { worker: "./dist/worker.js" },
  instanceConfigSchema: SELECTION_CONFIG_SCHEMA as unknown as Record<string, unknown>,
  localFolders: [
    {
      folderKey: LOCAL_FOLDER_KEYS.shadowDecisions,
      displayName: "Shadow decision log",
      description:
        "Append-only tog2138-decision-v1 JSONL, one record per advise() call, for the TOG-2138 48h host/plugin-shadow agreement gate.",
      access: "readWrite",
    },
  ],
  /**
   * `ctx.db` is only wired once the plugin has an ACTIVE namespace, and
   * `ensureNamespace` returns null unless `manifest.database` is present
   * (`plugin-database.ts:469-471`, `413-419`). Declaring the namespace is
   * therefore a precondition for reading `heartbeat_runs` at all, even though
   * this plugin owns no tables of its own — hence an empty migrations dir.
   *
   * `coreReadTables` is the read allowlist enforced per query by
   * `assertAllowedPublicRead` (`plugin-database.ts:157-168`): a `public.` table
   * absent from this list is rejected, and only in a FROM/JOIN/REFERENCES
   * position. We ask for exactly the one table the volume profile is measured
   * from, and nothing else.
   */
  database: {
    namespaceSlug: "model_selection",
    migrationsDir: "./migrations",
    // NOT `issue_work_products`, `activity_log`, or `labels` — reopen/rejection
    // signals are sourced from captured `ctx.events`, not a live join against a
    // table this plugin isn't allowlisted to read (TOG-1917 §2.2 / TOG-2136).
    // "agents" added for TOG-2481's classification job (join issues -> agents
    // to read the assignee's role/name for the classification prompt).
    coreReadTables: ["heartbeat_runs", "issues", "issue_comments", "issue_relations", "agents"],
  },
  jobs: [
    {
      jobKey: JOB_KEYS.refreshProfiles,
      displayName: "Refresh volume profiles",
      description:
        "Recompute per-tier token volume from this company's own runs. Without this the cost term goes stale and the engine holds at the agent floor rather than guess.",
      schedule: "17 */6 * * *",
    },
    {
      jobKey: JOB_KEYS.pollLanes,
      displayName: "Poll lane capacity",
      description:
        "Poll operator-configured lane-capacity status URLs and refresh the pace ledger. Pace's own freshness budget is on the order of minutes, so this runs far more often than the volume-profile refresh.",
      schedule: "*/5 * * * *",
    },
    {
      jobKey: JOB_KEYS.refreshScores,
      displayName: "Refresh model scores",
      description:
        "Recompute per-model, per-tier Bayesian success scores and the card-level acceptance ledger from this company's own runs and captured rework signals.",
      schedule: "37 */6 * * *",
    },
    {
      jobKey: JOB_KEYS.refreshAaIndex,
      displayName: "Refresh aa.ai Intelligence Index",
      description:
        "Refresh the aa.ai leaderboard snapshot and log per-model index changes. A change that crosses a tier boundary is surfaced via the activity log as a prompt to re-evaluate — never applied automatically. A fetch/parse failure keeps the prior snapshot and records the failed attempt (TOG-2438). Every-6h cadence matches refreshScores's family (TOG-2438 reopen AC4) — aa.ai moves faster than a daily check surfaced.",
      schedule: "53 */6 * * *",
    },
    {
      jobKey: JOB_KEYS.classifyIssues,
      displayName: "Classify unlabeled issues",
      description:
        "Ported from tier_dispatcher.py main(): classify open, unlabeled, agent-assigned issues with the RUBRIC and write a tier:* label. Off by default (classification.enabled=false) — the AC3 kill switch for TOG-2481.",
      schedule: "*/10 * * * *",
    },
    {
      jobKey: JOB_KEYS.labelOnlyPass,
      displayName: "Pin from an existing tier label",
      description:
        "Ported from tier_dispatcher.py label_only_pass(): pin issues that already carry a tier:* label (e.g. inherited from a cloned card) but no override, without re-classifying.",
      schedule: "*/10 * * * *",
    },
    {
      jobKey: JOB_KEYS.repinPass,
      displayName: "Re-pin off an unusable or demoted model",
      description:
        "Ported from tier_dispatcher.py repin_pass(): idle issues pinned to a model whose lane is now unusable, or that has been measurably demoted for their tier, get re-pinned within the same tier.",
      schedule: "*/10 * * * *",
    },
    {
      jobKey: JOB_KEYS.balancePass,
      displayName: "Balance pinned and formerly-excluded issues",
      description:
        "Ported from tier_dispatcher.py balance_pass(): give unpinned+labelled cards a balanced T1-class pin, and re-pin cards whose pinned model has gone cost-down-eligible, incapable/on-probation/over-cap, or whose lane is far busier than another usable lane.",
      schedule: "*/10 * * * *",
    },
    {
      jobKey: JOB_KEYS.dispatchSweep,
      displayName: "Stall-sweep dispatch",
      description:
        "TOG-2481 absorption of the standalone dispatch plugin (TOG-747/TOG-706): finds stalled, wakeable issues and requests a wake, spread across distinct assignees. Report-only until dispatch.wakeEnabled is set — same cadence and same default as the plugin it replaces.",
      schedule: "*/30 * * * *",
    },
  ],
  tools: [
    {
      name: TOOL_NAMES.advise,
      displayName: "Advise a model for an issue",
      description:
        "Return the tier judgement, the costed candidates, and the recommended model for one issue. Read-only; writes nothing.",
      parametersSchema: DESCRIPTOR_SCHEMA as unknown as Record<string, unknown>,
    },
    {
      name: TOOL_NAMES.apply,
      displayName: "Apply a model selection to an issue",
      description:
        "Advise, then write the per-issue override and tier label if enforcement is enabled for this company. No-ops on an issue that already has an override.",
      parametersSchema: DESCRIPTOR_SCHEMA as unknown as Record<string, unknown>,
    },
    {
      name: TOOL_NAMES.setOperatorOverride,
      displayName: "Set an operator override for an issue",
      description:
        "Record a time-boxed override: route this issue to the named model ahead of pace ordering and slot throttling, until it expires. Never bypasses a capability gate, tier floor/ceiling, the untrusted-profile hold, or a serviceability hard stop.",
      parametersSchema: {
        type: "object",
        required: ["issueId", "modelId"],
        properties: {
          issueId: { type: "string", minLength: 1 },
          modelId: { type: "string", minLength: 1 },
          ttlSeconds: { type: "integer", minimum: 1 },
        },
      } as unknown as Record<string, unknown>,
    },
    {
      name: TOOL_NAMES.ancillaryDrift,
      displayName: "Report ancillary model pin drift",
      description:
        "Report which agents' ancillary model pins (ANTHROPIC_SMALL_FAST_MODEL, CLAUDE_CODE_SUBAGENT_MODEL, every " +
        "ANTHROPIC_DEFAULT_* env var) disagree with the lane-aware T3 " +
        "recommendation, and who must act on each surface. Read-only; there is no write path from this " +
        "plugin to any of these surfaces.",
      parametersSchema: { type: "object", additionalProperties: false, properties: {} } as unknown as Record<
        string,
        unknown
      >,
    },
    {
      name: TOOL_NAMES.aaDriftReport,
      displayName: "aa.ai drift report",
      description:
        "Per-model aa.ai Intelligence Index: the roster's configured value and snapshot date, alongside the latest fetched live value and whether it now implies a different tier. Read-only; writes nothing.",
      parametersSchema: { type: "object" } as unknown as Record<string, unknown>,
    },
    {
      name: TOOL_NAMES.refreshAaIndexNow,
      displayName: "Refresh aa.ai Intelligence Index now",
      description:
        "Manually run the aa.ai leaderboard fetch + drift-surfacing sweep instead of waiting for the next scheduled tick. Same logic as the cron job: never writes tier/enabled, only updates the snapshot and logs drift.",
      parametersSchema: { type: "object" } as unknown as Record<string, unknown>,
    },
    {
      name: TOOL_NAMES.setLaneOutage,
      displayName: "Declare or clear a lane outage",
      description:
        "TOG-2481 port of lane_outage.json: declare a telemetry-invisible outage on named lanes/models until an ISO timestamp, or clear it by omitting both lanes and models.",
      parametersSchema: {
        type: "object",
        required: ["until"],
        properties: {
          lanes: { type: "array", items: { type: "string" } },
          models: { type: "array", items: { type: "string" } },
          until: { type: "string", minLength: 1 },
          reason: { type: "string" },
        },
      } as unknown as Record<string, unknown>,
    },
    {
      name: TOOL_NAMES.setZaiPaceOverride,
      displayName: "Set or clear the Z.ai weekly-pace margin override",
      description:
        "TOG-2481 port of zai_pace_override.json: temporarily widen (or tighten) the margin zaiWeeklyPaceOk allows above elapsed-week fraction, e.g. during a Codex outage. Clear by omitting margin.",
      parametersSchema: {
        type: "object",
        required: ["until"],
        properties: {
          margin: { type: "number", minimum: 0, maximum: 1 },
          until: { type: "string" },
        },
      } as unknown as Record<string, unknown>,
    },
  ],
  apiRoutes: [
    {
      routeKey: ROUTE_KEYS.advise,
      method: "POST",
      path: "/advise",
      auth: "board-or-agent",
      capability: "api.routes.register",
      checkoutPolicy: "none",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: ROUTE_KEYS.applyIssue,
      method: "POST",
      path: "/issues/:issueId/apply",
      auth: "board-or-agent",
      capability: "api.routes.register",
      checkoutPolicy: "none",
      companyResolution: { from: "issue", param: "issueId" },
    },
  ],
};

export default manifest;
