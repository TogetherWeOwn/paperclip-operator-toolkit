-- ===========================================================================
-- paperclip-upgrade/orphans.sql -- READ-ONLY orphan lease and recovery-cycle
-- report for pre-restart-check.sh. Nothing is released or
-- cancelled: an orphan found here is reported and blocks the restart until
-- the operator either resolves it through the product or acks the exact
-- total (--ack-orphans N).
-- ===========================================================================
SELECT 'native_lease_expired|' || count(*) FROM native_run_finalizations
 WHERE lease_owner IS NOT NULL AND lease_expires_at <= now()
UNION ALL
SELECT 'env_lease_on_terminal_run|' || count(*) FROM environment_leases l
  JOIN heartbeat_runs r ON r.id = l.heartbeat_run_id
 WHERE l.status = 'active' AND r.status NOT IN ('queued', 'scheduled_retry', 'running')
UNION ALL
SELECT 'runtime_lease_on_terminal_run|' || count(*) FROM execution_workspace_runtime_leases l
  JOIN heartbeat_runs r ON r.id = l.owner_run_id
 WHERE l.expires_at > now() AND r.status NOT IN ('queued', 'scheduled_retry', 'running')
UNION ALL
SELECT 'recovery_stale_over_2h|' || count(*) FROM issue_recovery_actions
 WHERE status IN ('active', 'escalated') AND updated_at < now() - interval '2 hours'
UNION ALL
SELECT 'recovery_timed_out|' || count(*) FROM issue_recovery_actions
 WHERE status IN ('active', 'escalated') AND timeout_at IS NOT NULL AND timeout_at < now()
UNION ALL
SELECT 'recovery_cycle_sources_24h|' || count(*) FROM (
  SELECT source_issue_id FROM issue_recovery_actions
   WHERE created_at > now() - interval '24 hours'
   GROUP BY source_issue_id HAVING count(*) >= 3) c
ORDER BY 1;
