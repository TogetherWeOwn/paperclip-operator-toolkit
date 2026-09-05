#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

function loadPg() {
  const roots = [process.env.PAPERCLIP_PG_MODULE, "/app/node_modules/pg"].filter(Boolean);
  for (const root of roots) {
    try { return require(root); } catch { /* keep looking */ }
  }
  const store = "/app/node_modules/.pnpm";
  let entries = [];
  try { entries = fs.readdirSync(store); } catch { /* no store */ }
  for (const entry of entries.filter((e) => /^pg@\d/.test(e)).sort().reverse()) {
    try { return require(path.join(store, entry, "node_modules", "pg")); } catch { /* keep looking */ }
  }
  return null;
}

const SQL = `
with scoped_issues as (
  select i.*, assignee.name as assignee_agent_name
    from issues i
    left join agents assignee on assignee.id = i.assignee_agent_id
   where i.company_id = $1
     and ($2::uuid is null or i.project_id = $2::uuid)
     and i.hidden_at is null
), interaction_rows as (
  select t.issue_id, coalesce(json_agg(json_build_object(
           'id', t.id,
           'status', t.status,
           'kind', t.kind,
           'addresseeAgentId', t.addressee_agent_id,
           'createdByAgentId', t.created_by_agent_id,
           'effectiveResolverPolicy', t.effective_resolver_policy,
           'isReviewVerdict', exists (
             select 1 from activity_log review_bind
              where review_bind.company_id = t.company_id
                and review_bind.entity_type = 'issue'
                and review_bind.entity_id = t.issue_id::text
                and review_bind.action = 'issue.updated'
                and review_bind.details->>'reviewInteractionId' = t.id::text
           ),
           'continuationPolicy', t.continuation_policy
         ) order by t.created_at), '[]'::json) as rows
    from issue_thread_interactions t
    join scoped_issues i on i.id = t.issue_id
   where t.status = 'pending'
   group by t.issue_id
), run_rows as (
  select x.issue_id, coalesce(json_agg(json_build_object(
           'runId', x.id,
           'status', x.status,
           'agentId', x.agent_id,
           'errorCode', x.error_code,
           'createdAt', x.created_at,
           'startedAt', x.started_at,
           'finishedAt', x.finished_at,
           'retryOfRunId', x.retry_of_run_id
         ) order by x.created_at), '[]'::json) as rows
    from (
      select r.*, coalesce(r.context_snapshot->>'issueId', r.context_snapshot->>'taskId')::uuid as issue_id
        from heartbeat_runs r
       where r.company_id = $1
         and (r.status in ('queued','running') or r.error_code = 'orphaned_running_run' or r.retry_of_run_id is not null)
    ) x
    join scoped_issues i on i.id = x.issue_id
   group by x.issue_id
), continuation_wakes as (
  select (w.payload->>'issueId')::uuid as issue_id,
         coalesce(json_agg(json_build_object(
           'runId', w.run_id,
           'status', w.status,
           'agentId', w.agent_id,
           'errorCode', null,
           'createdAt', w.requested_at,
           'startedAt', w.claimed_at,
           'finishedAt', w.finished_at,
           'retryOfRunId', w.payload->>'retryOfRunId'
         ) order by w.requested_at), '[]'::json) as rows
    from agent_wakeup_requests w
    join scoped_issues i on i.id::text = w.payload->>'issueId'
   where w.company_id = $1
     and w.payload->>'mutation' = 'tog_586_liveness_reconciler'
     and w.payload->>'retryOfRunId' is not null
     and w.status in ('queued','claimed','coalesced','deferred_issue_execution','completed')
   group by w.payload->>'issueId'
), comment_rows as (
  select c.issue_id, coalesce(json_agg(json_build_object(
           'id', c.id,
           'authorType', c.author_type,
           'authorUserId', c.author_user_id,
           'authorAgentId', c.author_agent_id,
           'body', c.body,
           'createdAt', c.created_at
         ) order by c.created_at desc), '[]'::json) as rows
    from issue_comments c
    join scoped_issues i on i.id = c.issue_id
   where c.deleted_at is null
     and c.author_type = 'user'
   group by c.issue_id
), activity_rows as (
  select x.entity_id::uuid as issue_id, coalesce(json_agg(json_build_object(
           'id', x.id,
           'action', x.action,
           'details', x.details,
           'createdAt', x.created_at
         ) order by x.created_at desc), '[]'::json) as rows
    from (
      select a.*, row_number() over (partition by a.entity_id order by a.created_at desc) as rn
        from activity_log a
        join scoped_issues i on i.id::text = a.entity_id
       where a.company_id = $1 and a.entity_type = 'issue'
    ) x
   where x.rn <= 100
   group by x.entity_id
), dedup_rows as (
  select c.issue_id, coalesce(json_agg(json_build_object(
           'id', c.id,
           'body', c.body,
           'createdAt', c.created_at
         ) order by c.created_at desc), '[]'::json) as rows
    from issue_comments c
    join scoped_issues i on i.id = c.issue_id
   where c.deleted_at is null
     and c.body like '%liveness-reconciler:%'
   group by c.issue_id
), recovery_rows as (
  select r.source_issue_id as issue_id, coalesce(json_agg(json_build_object(
           'id', r.id,
           'status', r.status,
           'kind', r.kind,
           'cause', r.cause,
           'evidence', r.evidence,
           'fingerprint', r.fingerprint
         ) order by r.created_at desc), '[]'::json) as rows
    from issue_recovery_actions r
    join scoped_issues i on i.id = r.source_issue_id
   where r.status in ('active','escalated')
   group by r.source_issue_id
), active_pause_holds as (
  select distinct on (m.issue_id)
         m.issue_id,
         h.id as hold_id,
         h.mode,
         h.status,
         h.reason,
         h.release_policy,
         h.created_at
    from issue_tree_holds h
    join issue_tree_hold_members m on m.hold_id = h.id and m.company_id = h.company_id
    join scoped_issues i on i.id = m.issue_id
   where h.company_id = $1
     and h.mode = 'pause'
     and h.status = 'active'
     and m.skipped = false
   order by m.issue_id, h.created_at desc, h.id desc
), ready_blockers as (
  select distinct r.issue_id
    from issue_relations r
    join scoped_issues blocker on blocker.id = r.issue_id
    join issues dependent on dependent.id = r.related_issue_id
   where r.type = 'blocks'
     and blocker.status = 'todo'
     and blocker.assignee_agent_id is null
     and blocker.assignee_user_id is null
     and dependent.status not in ('done','cancelled')
     and not exists (
       select 1
         from issue_relations blocker_dep
         join issues unresolved on unresolved.id = blocker_dep.issue_id
        where blocker_dep.related_issue_id = blocker.id
          and blocker_dep.type = 'blocks'
          and unresolved.status <> 'done'
     )
)
select coalesce(json_agg(json_build_object(
         'id', i.id,
         'identifier', i.identifier,
         'title', i.title,
         'description', i.description,
         'projectId', i.project_id,
         'status', i.status,
         'reviewPolicy', i.review_policy,
         'assigneeAgentId', i.assignee_agent_id,
         'assigneeAgentName', i.assignee_agent_name,
         'assigneeUserId', i.assignee_user_id,
         'createdByAgentId', i.created_by_agent_id,
         'unblockDescriptor', i.unblock_descriptor,
         'executionPolicy', i.execution_policy,
         'readyBlocker', (rb.issue_id is not null),
         'interactions', coalesce(ir.rows, '[]'::json),
         'runs', (coalesce(rr.rows, '[]'::json)::jsonb || coalesce(cw.rows, '[]'::json)::jsonb),
         'comments', (coalesce(cr.rows, '[]'::json)::jsonb || coalesce(dr.rows, '[]'::json)::jsonb),
         'activity', coalesce(ar.rows, '[]'::json),
         'recoveryActions', json_build_object('actions', coalesce(rec.rows, '[]'::json)),
         'treeControlState', json_build_object(
           'activePauseHold', case when aph.hold_id is null then null else json_build_object(
             'id', aph.hold_id,
             'mode', aph.mode,
             'status', aph.status,
             'reason', aph.reason,
             'releasePolicy', aph.release_policy,
             'createdAt', aph.created_at
           ) end
         )
       ) order by i.identifier), '[]'::json) as issues
  from scoped_issues i
  left join interaction_rows ir on ir.issue_id = i.id
  left join run_rows rr on rr.issue_id = i.id
  left join continuation_wakes cw on cw.issue_id = i.id
  left join comment_rows cr on cr.issue_id = i.id
  left join activity_rows ar on ar.issue_id = i.id
  left join dedup_rows dr on dr.issue_id = i.id
  left join recovery_rows rec on rec.issue_id = i.id
  left join active_pause_holds aph on aph.issue_id = i.id
  left join ready_blockers rb on rb.issue_id = i.id`;

function refuse(message) {
  process.stderr.write(`REFUSED: ${message}\n`);
  process.exit(2);
}

async function main() {
  let company = process.env.PAPERCLIP_COMPANY_ID || "";
  let project = process.env.PAPERCLIP_PROJECT_ID || null;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--company") { company = argv[++i] || ""; continue; }
    if (argv[i] === "--project") { project = argv[++i] || null; continue; }
    refuse(`unknown argument: ${argv[i]}`);
  }
  if (!company) refuse("no company; set PAPERCLIP_COMPANY_ID or pass --company");
  if (!project) refuse("no project; set PAPERCLIP_PROJECT_ID or pass --project — an empty project would widen the scan company-wide");
  if (!process.env.DATABASE_URL) refuse("DATABASE_URL is not set");
  const pg = loadPg();
  if (!pg) refuse("cannot load the pg module");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("SET default_transaction_read_only = on");
    const result = await client.query(SQL, [company, project]);
    const issues = result.rows[0]?.issues;
    if (!Array.isArray(issues)) refuse("query returned no issues array");
    process.stdout.write(JSON.stringify({ issues }) + "\n");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`ERROR: ${error && error.message ? error.message : error}\n`);
  process.exit(1);
});
