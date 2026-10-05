-- ===========================================================================
-- paperclip-upgrade/fence.sql -- READ-ONLY write fence for drain.sh
-- rollback --restore-db. :'since' = backup_at (DB clock).
--
-- Counts rows written after the backup in the tables that carry user or
-- agent work. Restoring the backup would hide every one of them, so the
-- restore refuses unless the total is 0 or exactly the --ack-fence count,
-- and the pre-rollback database is renamed, never dropped. activity_log is
-- left out: the drain itself writes there.
-- ===========================================================================
SELECT 'issues|' || count(*) FROM issues WHERE created_at > :'since'::timestamptz OR updated_at > :'since'::timestamptz
UNION ALL
SELECT 'issue_comments|' || count(*) FROM issue_comments WHERE created_at > :'since'::timestamptz OR updated_at > :'since'::timestamptz
UNION ALL
SELECT 'heartbeat_runs|' || count(*) FROM heartbeat_runs WHERE created_at > :'since'::timestamptz OR updated_at > :'since'::timestamptz
UNION ALL
SELECT 'agent_wakeup_requests|' || count(*) FROM agent_wakeup_requests WHERE created_at > :'since'::timestamptz OR updated_at > :'since'::timestamptz
UNION ALL
SELECT 'approvals|' || count(*) FROM approvals WHERE created_at > :'since'::timestamptz OR updated_at > :'since'::timestamptz
UNION ALL
SELECT 'cost_events|' || count(*) FROM cost_events WHERE created_at > :'since'::timestamptz
UNION ALL
SELECT 'company_secrets|' || count(*) FROM company_secrets WHERE created_at > :'since'::timestamptz OR updated_at > :'since'::timestamptz
UNION ALL
SELECT 'company_secret_versions|' || count(*) FROM company_secret_versions WHERE created_at > :'since'::timestamptz
UNION ALL
SELECT 'agents|' || count(*) FROM agents WHERE created_at > :'since'::timestamptz OR updated_at > :'since'::timestamptz
UNION ALL
SELECT 'routines|' || count(*) FROM routines WHERE created_at > :'since'::timestamptz OR updated_at > :'since'::timestamptz
UNION ALL
SELECT 'documents|' || count(*) FROM documents WHERE created_at > :'since'::timestamptz OR updated_at > :'since'::timestamptz
ORDER BY 1;
