-- ===========================================================================
-- paperclip-upgrade/drain-marker.sql -- READ-ONLY proof that the task drain
-- drain.sh just started is the drain of THIS database.
--
-- POST /api/instance/task-drain writes, in one transaction and before it
-- applies the in-memory drain, one activity_log row per company:
-- action 'instance.task_drain.started', entity instance_settings/default,
-- details.startedAt = the same Date the response returns (both serialised
-- with toISOString). Matching the startedAt TEXT exactly (no cast, so no
-- cast error on unrelated rows) ties the API we talked to to the database we
-- are about to back up. :'sa' = startedAt, :'req' = DB time recorded just
-- before the POST.
--
-- Output: "<marker rows>|<companies>". drain.sh requires both equal and > 0.
-- ===========================================================================
SELECT (SELECT count(*) FROM activity_log
         WHERE action = 'instance.task_drain.started'
           AND entity_type = 'instance_settings'
           AND entity_id = 'default'
           AND details ->> 'startedAt' = :'sa'
           AND created_at >= :'req'::timestamptz - interval '5 minutes')
       || '|' || (SELECT count(*) FROM companies);
