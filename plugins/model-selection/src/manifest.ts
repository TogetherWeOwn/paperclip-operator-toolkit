import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

import { SELECTION_CONFIG_SCHEMA } from "./config/schema.js";
import { JOB_KEYS, LOCAL_FOLDER_KEYS, PLUGIN_API_VERSION, PLUGIN_ID, PLUGIN_VERSION, ROUTE_KEYS, TOOL_NAMES } from "./constants.js";
import { RUN_RESOLVE_ENV_KEYS } from "./engine/run-resolve.js";
import { TIER_POLICY_TOOL_DESCRIPTION, TIER_POLICY_TOOL_DISPLAY_NAME, TIER_POLICY_TOOL_PARAMETERS } from "./tier-policy-tool.js";

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
    admissionShadow: {
      type: "object",
      description: "Optional non-secret account/window snapshot. Only evaluated when accountAdmissionShadow.enabled is true; never changes the decision or applies admission.",
    },
  },
} as const;

const baseManifest: PaperclipPluginManifestV1 = {
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
    // Poll operator-configured lane-capacity status URLs.
    "http.outbound",
    // Resolve a lane's optional apiKeySecretRef before polling it.
    "secrets.read-ref",
    // Capture issue.updated (reopen) / issue.comment.created (rejection) signals
    // for the card-level acceptance ledger, since `activity_log` is not an
    // allowlisted table and cannot be queried directly.
    "events.subscribe",
    // Raise a `tier-exhausted` alarm when every tier from
    // the required floor through T1 is pace-exhausted — there is nowhere left
    // to escalate to, and this must reach an operator rather than fail
    // silently the way the reference dispatcher's `pick()` does. The alarm
    // reuses this instance's existing `Operator: <title>` + `operator`-label
    // issue-creation convention (confirmed against 20+ live examples), not a
    // same-issue interaction card — an `Operator:` issue is a real,
    // separately-triaged unit of work, and that is what a capacity dead end
    // actually is.
    "issues.create",
    // Absorption of the standalone `dispatch` plugin:
    // the stall-sweep reads blocker relations and the orchestration summary
    // (which mirrors the server's own budget-invocation-block verdict, see
    // dispatch-selection.ts's BUDGET_RAIL_MIRROR_SOURCE), and wakes a stalled
    // issue's existing run. Declared even though `dispatch.wakeEnabled`
    // defaults to false, matching the standalone plugin's own manifest.
    "issue.relations.read",
    "issues.orchestration.read",
    "issues.wakeup",
    // The sweep must not wake a card that has its own monitor
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
    // Append-only versioned shadow-decision JSONL, the
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
        "Append-only versioned paired-decision JSONL, one record per advise() call, for the 48h host/plugin-shadow agreement gate.",
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
    // table this plugin isn't allowlisted to read.
    // "agents" added for the classification job (join issues -> agents
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
        "Poll operator-configured lane-capacity status URLs and refresh the pace ledger. Runs every 2 minutes, inside the tightest publisher-declared freshness budget (180s live) — at 5 minutes, picks older than 180s read every lane UNKNOWN ~half the time. Pace's own freshness budget is on the order of minutes, so this runs far more often than the volume-profile refresh.",
      schedule: "*/2 * * * *",
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
        "Refresh the aa.ai leaderboard snapshot and log per-model index changes. A change that crosses a tier boundary is surfaced via the activity log as a prompt to re-evaluate — never applied automatically. A fetch/parse failure keeps the prior snapshot and records the failed attempt. Every-6h cadence matches refreshScores's family — aa.ai moves faster than a daily check surfaced.",
      schedule: "53 */6 * * *",
    },
    {
      jobKey: JOB_KEYS.reconcilePrices,
      displayName: "Reconcile roster prices against models.dev",
      description:
        "Fetch models.dev's catalogue and compare every roster row's $/Mtok against the list price its LANE's provider publishes. Reports drift to the activity log and stores the diff for an operator to approve — it never writes a price. A 2026-09-22 hand audit found 26 of 117 rows wrong, five of them priced 0/0/0, so this exists to make the next drift visible within a day instead of at the next audit. Daily, not 6-hourly: vendor list prices change on the order of months, and the feed is 4.8 MB.",
      schedule: "41 5 * * *",
    },
    {
      jobKey: JOB_KEYS.refreshAaFreeSync,
      displayName: "Refresh aa.ai free-list sync",
      description:
        "Fetch the official aa.ai FREE-tier legacy list (at most once a day; 429 honors Retry-After; 401/403 stops the source) and store the CAS snapshot plus a per-company reviewable diff of curated model x effort bindings. Report-only: it never writes a binding, pin, tier, or price. Off unless a company enables aaFreeSync.",
      schedule: "23 6 * * *",
    },
    {
      jobKey: JOB_KEYS.classifyIssues,
      displayName: "Classify unlabeled issues",
      description:
        "Ported from tier_dispatcher.py main(): classify open, unlabeled, agent-assigned issues with the RUBRIC and write a tier:* label. Off by default (classification.enabled=false) — the kill switch for this ported job.",
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
        "Absorption of the standalone dispatch plugin: finds stalled, wakeable issues and requests a wake, spread across distinct assignees. Report-only until dispatch.wakeEnabled is set — same cadence and same default as the plugin it replaces.",
      schedule: "*/30 * * * *",
    },
    {
      jobKey: JOB_KEYS.refreshRunResolve,
      displayName: "Warm the run-scoped decision snapshot",
      description:
        "Reload the hot caches (volume profiles, lane ledger, scores, availability, lane evidence, live lane weights) the run-scoped model decision reads, so the decision path never loads them inline. Reads only; a no-op for a company that has not enabled runResolve.",
      schedule: "* * * * *",
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
      name: TOOL_NAMES.priceDriftReport,
      displayName: "models.dev price drift report",
      description:
        "The latest roster-vs-models.dev price reconciliation: which rows are mispriced, by how much, and the exact note clause to record if the correction is approved. Read-only; writes nothing. List prices — correct for relative cost ordering, not what the company actually pays on a flat plan.",
      parametersSchema: { type: "object" } as unknown as Record<string, unknown>,
    },
    {
      name: TOOL_NAMES.reconcilePricesNow,
      displayName: "Reconcile roster prices against models.dev now",
      description:
        "Run the models.dev fetch + price reconciliation immediately instead of waiting for the daily tick. Same logic as the cron job, and just as report-only: it never writes a roster price.",
      parametersSchema: { type: "object" } as unknown as Record<string, unknown>,
    },
    {
      name: TOOL_NAMES.admissionShadowReport,
      displayName: "Account admission shadow report",
      description: "Read the last opt-in bounded account admission shadow snapshot. No reservations, host start coverage or served-account proof; never invokes selection or actuation.",
      parametersSchema: { type: "object", additionalProperties: false } as unknown as Record<string, unknown>,
    },
    {
      name: TOOL_NAMES.aaFreeSyncReport,
      displayName: "aa.ai free-list sync report",
      description:
        "The last free-list sync diff: which curated model x effort bindings verify against the snapshot, which break and why, which slugs are ambiguous, and which roster rows have no binding. Read-only; writes nothing.",
      parametersSchema: { type: "object" } as unknown as Record<string, unknown>,
    },
    {
      name: TOOL_NAMES.refreshAaFreeSyncNow,
      displayName: "Refresh aa.ai free-list sync now",
      description:
        "Run the free-list fetch + per-company diff immediately instead of waiting for the daily tick. Same logic as the cron job, and just as report-only: it never writes a binding, pin, tier, or price.",
      parametersSchema: { type: "object" } as unknown as Record<string, unknown>,
    },
    {
      name: TOOL_NAMES.tierOutcomes,
      displayName: "Tier poll outcomes",
      description:
        "Per-tier lane-poll success/fail counters: how many polls each tier's lanes served or missed. Read-only; writes nothing and never changes selection.",
      parametersSchema: { type: "object" } as unknown as Record<string, unknown>,
    },
    {
      name: TOOL_NAMES.acceptedWorkReport,
      displayName: "Accepted-work posterior report",
      description:
        "Per-cohort accepted-work posteriors: which served model x effort x task-class cohorts have mature accept/rework evidence, and what each cohort's posterior is. Read-only; writes nothing and never changes selection.",
      parametersSchema: { type: "object" } as unknown as Record<string, unknown>,
    },
    {
      name: TOOL_NAMES.setLaneOutage,
      displayName: "Declare or clear a lane outage",
      description:
        "Port of lane_outage.json: declare a telemetry-invisible outage on named lanes/models until an ISO timestamp, or clear it by omitting both lanes and models.",
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
        "Port of zai_pace_override.json: temporarily widen (or tighten) the margin zaiWeeklyPaceOk allows above elapsed-week fraction, e.g. during a Codex outage. Clear by omitting margin.",
      parametersSchema: {
        type: "object",
        required: ["until"],
        properties: {
          margin: { type: "number", minimum: 0, maximum: 1 },
          until: { type: "string" },
        },
      } as unknown as Record<string, unknown>,
    },
    {
      name: TOOL_NAMES.tierPolicy,
      displayName: TIER_POLICY_TOOL_DISPLAY_NAME,
      description: TIER_POLICY_TOOL_DESCRIPTION,
      parametersSchema: TIER_POLICY_TOOL_PARAMETERS as unknown as Record<string, unknown>,
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

/**
 * The capability the fork's run-model hook requires of
 * its one holder per company.
 */
export const RUN_MODEL_RESOLVE_CAPABILITY = "run.model.resolve";

declare const __MODEL_SELECTION_RUN_RESOLVE__: boolean | undefined;

/**
 * Whether this build declares `run.model.resolve` + `modelRouting`. Inlined by
 * `esbuild.config.mjs` from `MODEL_SELECTION_RUN_RESOLVE=1`, so the choice is
 * made when the artifact is built and cannot drift with the host's runtime
 * environment. Off by default: a host that predates the hook rejects an
 * unknown capability at install, so the default artifact installs everywhere
 * and the hook-enabled artifact is built deliberately for the fork.
 */
export const RUN_RESOLVE_IN_MANIFEST: boolean =
  typeof __MODEL_SELECTION_RUN_RESOLVE__ === "boolean"
    ? __MODEL_SELECTION_RUN_RESOLVE__
    : process.env.MODEL_SELECTION_RUN_RESOLVE === "1";

/**
 * The manifest, with or without the run-model hook declaration. The extra keys
 * are widened past the SDK's manifest type because the SDK this package builds
 * against predates them; the fork host's own validator is the authority.
 */
export function buildManifest(runResolve: boolean): PaperclipPluginManifestV1 {
  if (!runResolve) return baseManifest;
  return {
    ...baseManifest,
    capabilities: [...baseManifest.capabilities, RUN_MODEL_RESOLVE_CAPABILITY],
    modelRouting: { envKeys: [...RUN_RESOLVE_ENV_KEYS] },
  } as unknown as PaperclipPluginManifestV1;
}

const manifest: PaperclipPluginManifestV1 = buildManifest(RUN_RESOLVE_IN_MANIFEST);

export default manifest;
