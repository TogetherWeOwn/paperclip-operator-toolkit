-- ===========================================================================
-- paperclip-upgrade/inventory.sql -- READ-ONLY schema and data inventory of a
-- Paperclip database. One row per metric: "<metric>|<count>".
--
-- Used three ways, always with the same file so the numbers are comparable:
--   * rehearse-upgrade.sh on the stage copy (restored / neutralised /
--     post-boot / rollback restore);
--   * drain.sh backup on production, as the read-only inventory recorded next
--     to the checksummed backup (it is a SELECT: no DDL, no DML, no temp
--     objects, nothing created);
--   * validate_sql.py against an isolated agent-testdb schema build.
--
-- Counts only: no row data, no names of secrets, no config values. Tables
-- that a given schema version may not have are counted through
-- query_to_xml() behind a to_regclass() guard, so the same file runs on the
-- 0279 schema and on 0280+ without errors and without creating anything.
--
-- ops_guard: neither the 0279 image nor fork migrations 0280-0284 ship an
-- object called ops_guard or any role DDL (checked 2026-10-02: no CREATE
-- ROLE / GRANT / REVOKE / event trigger in those files). The ops_guard_* and
-- role metrics below make an operator-applied guard visible either way.
-- ===========================================================================
WITH opt(metric, rel) AS (
  VALUES
    ('ledger_rows',                'drizzle.__drizzle_migrations'),
    ('ledger_rows_public',         'public.__drizzle_migrations'),
    ('companies',                  'public.companies'),
    ('agents',                     'public.agents'),
    ('issues',                     'public.issues'),
    ('issue_comments',             'public.issue_comments'),
    ('heartbeat_runs',             'public.heartbeat_runs'),
    ('agent_wakeup_requests',      'public.agent_wakeup_requests'),
    ('routines',                   'public.routines'),
    ('routine_triggers',           'public.routine_triggers'),
    ('plugins',                    'public.plugins'),
    ('plugin_config',              'public.plugin_config'),
    ('plugin_jobs',                'public.plugin_jobs'),
    ('company_secrets',            'public.company_secrets'),
    ('company_secret_bindings',    'public.company_secret_bindings'),
    ('company_secret_versions',    'public.company_secret_versions'),
    ('agent_api_keys',             'public.agent_api_keys'),
    ('board_api_keys',             'public.board_api_keys'),
    ('company_skills',             'public.company_skills'),
    ('tool_profile_bindings',      'public.tool_profile_bindings'),
    ('environment_leases',         'public.environment_leases'),
    ('execution_workspace_runtime_leases', 'public.execution_workspace_runtime_leases'),
    ('native_run_finalizations',   'public.native_run_finalizations')
),
counted AS (
  SELECT metric,
         CASE
           WHEN rel IS NULL THEN NULL
           WHEN to_regclass(rel) IS NULL THEN -1
           ELSE (xpath('/row/n/text()',
                       query_to_xml('SELECT count(*) AS n FROM ' || rel, false, true, '')))[1]::text::bigint
         END AS n
    FROM opt
)
SELECT metric || '|' || n FROM counted WHERE n IS NOT NULL
UNION ALL
SELECT 'schema_tables_public|' || count(*) FROM pg_tables WHERE schemaname = 'public'
UNION ALL
SELECT 'schema_tables_nonsystem|' || count(*) FROM pg_tables
 WHERE schemaname NOT IN ('pg_catalog', 'information_schema') AND schemaname !~ '^pg_'
UNION ALL
SELECT 'schemas_nonsystem|' || count(*) FROM pg_namespace
 WHERE nspname NOT IN ('information_schema') AND nspname !~ '^pg_'
UNION ALL
SELECT 'indexes_public|' || count(*) FROM pg_indexes WHERE schemaname = 'public'
UNION ALL
SELECT 'constraints_public|' || count(*) FROM pg_constraint c
  JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public'
UNION ALL
SELECT 'functions_public|' || count(*) FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
UNION ALL
SELECT 'triggers_public|' || count(*) FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND NOT t.tgisinternal
UNION ALL
SELECT 'event_triggers|' || count(*) FROM pg_event_trigger
UNION ALL
SELECT 'ops_guard_functions|' || count(*) FROM pg_proc WHERE proname ILIKE '%ops_guard%'
UNION ALL
SELECT 'ops_guard_event_triggers|' || count(*) FROM pg_event_trigger WHERE evtname ILIKE '%ops_guard%'
UNION ALL
SELECT 'roles_nonsystem|' || count(*) FROM pg_roles WHERE rolname !~ '^pg_'
UNION ALL
SELECT 'roles_superuser|' || count(*) FROM pg_roles WHERE rolsuper
UNION ALL
SELECT 'roles_login|' || count(*) FROM pg_roles WHERE rolcanlogin AND rolname !~ '^pg_'
UNION ALL
SELECT 'current_user_is_superuser|' || (CASE WHEN (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN 1 ELSE 0 END)
ORDER BY 1;
