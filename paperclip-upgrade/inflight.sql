-- ===========================================================================
-- paperclip-upgrade/inflight.sql -- READ-ONLY "is anything executing right
-- now" gate for the zero-loss admission drain. One row per
-- metric: "<gate>|<count>".
--
-- Rows WITHOUT a prefix are hard gates: drain.sh wait/backup/restart and
-- pre-restart-check.sh require every one of them to be 0, measured on
-- consecutive polls. Rows prefixed "info_" are work that is PRESERVED across
-- the restart (queued runs, retries, deferred wakes, idle leases): they are
-- reported, never cancelled, and they do not block the restart.
--
-- What "executing" means here, from packages/db/src/schema/*.ts:
--   heartbeat_runs.status='running' covers execution_stage preparing too
--     (preparing is a stage of a running run, not a status);
--   a live legacy controller lease means a process still owns a run;
--   agent_wakeup_requests.status='claimed' is a wake mid-hand-off to a run;
--   native_run_finalizations with a live lease is "finalizing" in progress;
--   plugin_job_runs.status='running' is a plugin worker mid-job.
--
-- A SELECT only: no DDL, no DML, no temp objects. Callers run it with
-- PGOPTIONS='-c default_transaction_read_only=on'. Counts only, no row data.
-- ===========================================================================
SELECT 'runs_running|' || count(*) FROM heartbeat_runs WHERE status = 'running'
UNION ALL
SELECT 'runs_controller_lease_live|' || count(*) FROM heartbeat_runs
 WHERE controller_lease_expires_at > now()
UNION ALL
SELECT 'wakes_claimed|' || count(*) FROM agent_wakeup_requests WHERE status = 'claimed'
UNION ALL
SELECT 'native_finalizations_leased|' || count(*) FROM native_run_finalizations
 WHERE lease_owner IS NOT NULL AND lease_expires_at > now()
UNION ALL
SELECT 'plugin_job_runs_running|' || count(*) FROM plugin_job_runs WHERE status = 'running'
UNION ALL
SELECT 'info_runs_queued|' || count(*) FROM heartbeat_runs WHERE status = 'queued'
UNION ALL
SELECT 'info_runs_scheduled_retry|' || count(*) FROM heartbeat_runs WHERE status = 'scheduled_retry'
UNION ALL
SELECT 'info_wakes_queued|' || count(*) FROM agent_wakeup_requests WHERE status = 'queued'
UNION ALL
SELECT 'info_wakes_deferred|' || count(*) FROM agent_wakeup_requests
 WHERE status = 'deferred_issue_execution'
UNION ALL
SELECT 'info_native_finalizations_pending|' || count(*) FROM native_run_finalizations
 WHERE lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= now()
UNION ALL
SELECT 'info_plugin_job_runs_pending|' || count(*) FROM plugin_job_runs WHERE status IN ('pending', 'queued')
UNION ALL
SELECT 'info_environment_leases_active|' || count(*) FROM environment_leases WHERE status = 'active'
UNION ALL
SELECT 'info_runtime_leases_live_run_owned|' || count(*) FROM execution_workspace_runtime_leases
 WHERE expires_at > now() AND owner_run_id IS NOT NULL
UNION ALL
SELECT 'info_runtime_leases_live_other|' || count(*) FROM execution_workspace_runtime_leases
 WHERE expires_at > now() AND owner_run_id IS NULL
UNION ALL
SELECT 'info_recovery_active|' || count(*) FROM issue_recovery_actions WHERE status IN ('active', 'escalated')
ORDER BY 1;
