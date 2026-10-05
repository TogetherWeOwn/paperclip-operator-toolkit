-- ===========================================================================
-- paperclip-upgrade/rewake.sql -- READ-ONLY list of wakes the drain window
-- suppressed that are still owed, for drain.sh rewake.
-- :'since' = DB time just before the drain POST; :'until' = DB time of the
-- undrain (or abort).
--
-- While suppression is on, heartbeat.ts enqueueWakeup writes the wake as
-- status 'skipped', reason 'heartbeat.scheduling_suppressed',
-- payload.heartbeatSkip.reason = task_drain (API drain) or
-- database_restore_in_progress (the restart hold), and the card id in
-- payload.issueId or payload.taskId. Wakes carrying an execution wait were
-- not skipped (the deferred row was updated in place) and are not listed.
--
-- A skipped wake is owed exactly once per (agent, card): the latest one,
-- and only when
--   the card is still actionable (todo / in_progress / in_review) and still
--     assigned to that agent - a card that was blocked, parked or reassigned
--     meanwhile is NOT unparked by a rewake;
--   the agent is not paused, terminated or pending approval;
--   no newer non-skipped wake for that agent and card exists (this is also
--     what makes a second rewake pass a no-op: the rewake itself is newer);
--   no queued, retrying or running run for that agent and card exists.
-- Card ids are compared as text after a UUID shape check, so a malformed
-- payload cannot raise a cast error. Lines:
--   wake|<wake id>|<agent id>|<issue id>|<comment id or ->
--   unattributable|<n>   suppressed wakes with no card id (reported only)
--   ineligible|<n>       latest per (agent, card) that fail the rules above
-- ===========================================================================
WITH skipped AS (
  SELECT w.id, w.agent_id, w.created_at,
         lower(coalesce(w.payload ->> 'issueId', w.payload ->> 'taskId')) AS issue_txt,
         lower(w.payload ->> 'commentId') AS comment_txt
    FROM agent_wakeup_requests w
   WHERE w.status = 'skipped'
     AND w.reason = 'heartbeat.scheduling_suppressed'
     AND w.payload #>> '{heartbeatSkip,reason}' IN ('task_drain', 'database_restore_in_progress')
     AND w.created_at >= :'since'::timestamptz
     AND w.created_at <= :'until'::timestamptz
),
attributable AS (
  SELECT * FROM skipped
   WHERE issue_txt ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
),
latest AS (
  SELECT DISTINCT ON (agent_id, issue_txt) *
    FROM attributable
   ORDER BY agent_id, issue_txt, created_at DESC, id DESC
),
eligible AS (
  SELECT l.* FROM latest l
    JOIN issues i ON i.id::text = l.issue_txt
    JOIN agents a ON a.id = l.agent_id
   WHERE i.status IN ('todo', 'in_progress', 'in_review')
     AND i.assignee_agent_id = l.agent_id
     AND a.status NOT IN ('paused', 'terminated', 'pending_approval')
     AND NOT EXISTS (
       SELECT 1 FROM agent_wakeup_requests n
        WHERE n.agent_id = l.agent_id
          AND n.created_at > l.created_at
          AND n.status <> 'skipped'
          AND lower(coalesce(n.payload ->> 'issueId', n.payload ->> 'taskId')) = l.issue_txt)
     AND NOT EXISTS (
       SELECT 1 FROM heartbeat_runs r
        WHERE r.agent_id = l.agent_id
          AND r.status IN ('queued', 'scheduled_retry', 'running')
          AND lower(r.context_snapshot ->> 'issueId') = l.issue_txt)
)
SELECT 'wake|' || e.id || '|' || e.agent_id || '|' || e.issue_txt || '|'
       || (CASE WHEN e.comment_txt ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN e.comment_txt ELSE '-' END)
  FROM eligible e
UNION ALL
SELECT 'unattributable|' || ((SELECT count(*) FROM skipped) - (SELECT count(*) FROM attributable))
UNION ALL
SELECT 'ineligible|' || ((SELECT count(*) FROM latest) - (SELECT count(*) FROM eligible))
ORDER BY 1;
