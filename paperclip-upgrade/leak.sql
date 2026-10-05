-- ===========================================================================
-- paperclip-upgrade/leak.sql -- READ-ONLY admission-leak probe for drain.sh
-- wait. psql variable :'sa' is the task drain's startedAt exactly
-- as GET /api/instance/task-drain reported it (ISO 8601, server clock).
--
-- A leak is work ADMITTED after the drain took effect:
--   leak_runs   a heartbeat run created after startedAt that is not a retry.
--               A run that was already executing when the drain started may
--               legitimately schedule its own retry (heartbeat.ts inserts a
--               scheduled_retry run with retry_of_run_id plus a queued wake);
--               that is preserved work, reported as info_retries_since.
--   leak_wakes  a wake created after startedAt that the suppression gate did
--               not skip (skipped/cancelled are the drain working) and that is
--               not the wake row of such a retry.
-- Counts only. No DDL, no DML.
-- ===========================================================================
SELECT 'leak_runs|' || count(*) FROM heartbeat_runs
 WHERE created_at > :'sa'::timestamptz AND retry_of_run_id IS NULL
UNION ALL
SELECT 'leak_wakes|' || count(*) FROM agent_wakeup_requests w
 WHERE w.created_at > :'sa'::timestamptz
   AND w.status NOT IN ('skipped', 'cancelled')
   AND NOT EXISTS (SELECT 1 FROM heartbeat_runs r
                    WHERE r.wakeup_request_id = w.id AND r.retry_of_run_id IS NOT NULL)
UNION ALL
SELECT 'info_retries_since|' || count(*) FROM heartbeat_runs
 WHERE created_at > :'sa'::timestamptz AND retry_of_run_id IS NOT NULL
UNION ALL
SELECT 'info_wakes_skipped_since|' || count(*) FROM agent_wakeup_requests
 WHERE created_at > :'sa'::timestamptz AND status = 'skipped'
ORDER BY 1;
