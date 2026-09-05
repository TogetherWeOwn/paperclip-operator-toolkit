#!/usr/bin/env node
// TOG-302 evidence: does a wake source carry an issue id into context_snapshot,
// and does that predict whether the run could write to the board?
// Read-only. Same shape as the table in the card, re-measured on live data.
//
// Column names checked against information_schema, not assumed:
//   heartbeat_runs.invocation_source (not "source")
//   issue_comments.created_by_run_id (not "run_id")
//
// pnpm store path — `pg` is not hoisted to a resolvable bare specifier here.
import pg from "/app/node_modules/.pnpm/pg@8.18.0/node_modules/pg/lib/index.js";

const SCOPED = `coalesce(nullif(trim(context_snapshot->>'issueId'),''),
                         nullif(trim(context_snapshot->>'taskId'),''))`;

const bySource = `
WITH r AS (
  SELECT id, invocation_source AS source, ${SCOPED} AS issue_id
  FROM heartbeat_runs
),
c AS (
  SELECT created_by_run_id AS run_id, count(*) AS n
  FROM issue_comments
  WHERE created_by_run_id IS NOT NULL AND deleted_at IS NULL
  GROUP BY 1
)
SELECT r.source,
       count(*)::int                                       AS runs,
       count(*) FILTER (WHERE r.issue_id IS NOT NULL)::int  AS with_issue,
       round(100.0 * count(*) FILTER (WHERE r.issue_id IS NOT NULL) / count(*), 1) AS pct_scoped,
       round(sum(coalesce(c.n,0))::numeric / count(*), 2)   AS comments_per_run
FROM r LEFT JOIN c ON c.run_id = r.id
GROUP BY r.source
ORDER BY runs DESC;
`;

const timerByCompany = `
SELECT co.name AS company, count(*)::int AS timer_runs,
       count(*) FILTER (WHERE ${SCOPED} IS NOT NULL)::int AS with_issue,
       min(r.started_at)::date AS first, max(r.started_at)::date AS last
FROM heartbeat_runs r JOIN companies co ON co.id = r.company_id
WHERE r.invocation_source = 'timer'
GROUP BY 1 ORDER BY timer_runs DESC;
`;

// Are heartbeats even armed anywhere? The defect only bites when one fires.
const armed = `
SELECT co.name AS company,
       count(*)::int AS agents,
       count(*) FILTER (WHERE (a.runtime_config->'heartbeat'->>'enabled')::boolean IS TRUE)::int AS hb_enabled
FROM agents a JOIN companies co ON co.id = a.company_id
GROUP BY 1 ORDER BY agents DESC;
`;

const denials = `
SELECT action, count(*)::int AS n
FROM activity_log
WHERE action LIKE 'issue.cross_issue_influence%'
GROUP BY 1 ORDER BY n DESC;
`;

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
await client.query("SET default_transaction_read_only = on");
for (const [label, q] of [
  ["issueId coverage + recorded output, by wake source", bySource],
  ["timer runs by company", timerByCompany],
  ["heartbeat.enabled by company", armed],
  ["cross-issue influence activity rows", denials],
]) {
  const { rows } = await client.query(q);
  console.log(`\n== ${label}`);
  console.table(rows);
}
await client.end();
