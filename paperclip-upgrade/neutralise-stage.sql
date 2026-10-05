-- ===========================================================================
-- paperclip-upgrade/neutralise-stage.sql -- silence every run producer on a
-- STAGE COPY of the Paperclip database before the candidate image boots
--. NEVER apply this to a production database: rehearse-upgrade.sh
-- only feeds it to the throwaway stage postgres it created itself.
--
-- Applied with `psql -v ON_ERROR_STOP=1 -1` (one transaction). There are NO
-- existence guards on purpose: every table and column below exists in the
-- 0279 schema, so a missing or renamed producer is a schema drift that ABORTS
-- the whole neutralisation instead of being skipped. A skipped producer is
-- exactly how a rehearsal boot fires a real wake.
--
-- Table and status names come from packages/db/src/schema/*.ts and
-- packages/shared/src/constants.ts, not from guesses:
--   heartbeat_runs.status       queued|scheduled_retry|running|<terminal>
--   agent_wakeup_requests       queued|deferred_issue_execution|claimed|...
--   issue_recovery_actions      active|escalated|resolved|cancelled
--   routines.status             active|paused|archived; routine_triggers.enabled
--   plugin_jobs.status          active|paused|failed
--   plugin_job_runs.status      pending|queued|running|<terminal>
--   plugin_webhook_deliveries   pending|success|failed
--   environment_leases.status   active|released|expired|failed|retained|...
--   chat_endpoints.status       draft|verifying|active|paused|...
-- "preparing"/"finalizing" are NOT run statuses: preparing is
-- heartbeat_runs.execution_stage on a running run, finalizing is
-- native_run_finalizations (phase + lease). Both are covered below.
--
-- Scheduler clocks (next_*_at) are pushed to 'infinity' rather than nulled:
-- several reconcilers treat NULL as "due now".
--
-- Only counts are reported (RAISE NOTICE); no row data is selected.
-- ===========================================================================

-- 1. Agent heartbeats and wake-on-demand off, every company.
--    NOT jsonb_set(..., '{heartbeat,enabled}', ..., true): create_missing only
--    creates the LAST path element, so an agent with no "heartbeat" object
--    (the default) would be left armed. validate_sql.py seeds exactly that row.
UPDATE agents
   SET runtime_config =
         (CASE WHEN jsonb_typeof(runtime_config) = 'object' THEN runtime_config ELSE '{}'::jsonb END)
         || jsonb_build_object('heartbeat',
              (CASE WHEN jsonb_typeof(runtime_config -> 'heartbeat') = 'object'
                    THEN runtime_config -> 'heartbeat' ELSE '{}'::jsonb END)
              || '{"enabled": false, "wakeOnDemand": false}'::jsonb);

-- 2. Runs: nothing queued, retrying or running survives on the copy, and no
--    legacy controller lease stays live.
UPDATE heartbeat_runs SET status = 'cancelled'
 WHERE status IN ('queued', 'scheduled_retry', 'running');
UPDATE heartbeat_runs SET controller_lease_expires_at = now() - interval '1 second'
 WHERE controller_lease_expires_at > now();

-- 3. Wakeup backlog and claimed wakes.
UPDATE agent_wakeup_requests SET status = 'cancelled'
 WHERE status IN ('queued', 'deferred_issue_execution', 'claimed');

-- 4. Recovery loops (assignment recovery, continuation retries).
UPDATE issue_recovery_actions SET status = 'cancelled'
 WHERE status IN ('active', 'escalated');

-- 5. Routines and their triggers.
UPDATE routines SET status = 'paused' WHERE status = 'active';
UPDATE routine_triggers SET enabled = false, next_run_at = NULL WHERE enabled OR next_run_at IS NOT NULL;

-- 6. Plugins: jobs, job runs, webhook deliveries, and the plugin workers.
UPDATE plugin_jobs SET status = 'paused', next_run_at = NULL WHERE status = 'active' OR next_run_at IS NOT NULL;
UPDATE plugin_job_runs SET status = 'cancelled' WHERE status IN ('pending', 'queued', 'running');
UPDATE plugin_webhook_deliveries SET status = 'failed' WHERE status = 'pending';
UPDATE plugins SET status = 'disabled' WHERE status NOT IN ('disabled', 'uninstalled');

-- 7. Leases: environments, workspace runtimes, native finalization.
UPDATE environment_leases SET status = 'released', released_at = coalesce(released_at, now())
 WHERE status = 'active';
UPDATE execution_workspace_runtime_leases SET expires_at = now() - interval '1 second'
 WHERE expires_at > now();
UPDATE native_run_finalizations
   SET lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = 'infinity'
 WHERE lease_owner IS NOT NULL OR lease_expires_at IS NOT NULL
    OR next_attempt_at IS NULL OR next_attempt_at < 'infinity';

-- 8. Other scheduler clocks: issue monitors, status-card evals (inference),
--    chat deliveries (egress), connection intent deliveries, external object
--    refresh, status decision effects.
UPDATE issues SET monitor_next_check_at = 'infinity' WHERE monitor_next_check_at IS NOT NULL;
UPDATE status_cards SET next_eval_at = 'infinity' WHERE next_eval_at IS NOT NULL;
UPDATE chat_deliveries SET next_attempt_at = 'infinity' WHERE next_attempt_at IS NOT NULL;
UPDATE chat_endpoints SET status = 'paused' WHERE status IN ('verifying', 'active', 'attention');
UPDATE connection_intent_deliveries SET next_attempt_at = 'infinity' WHERE delivered_at IS NULL;
UPDATE external_objects SET next_refresh_at = 'infinity' WHERE next_refresh_at IS NOT NULL;
UPDATE status_decision_effects SET next_attempt_at = 'infinity' WHERE next_attempt_at IS NOT NULL;

-- 9. Verification inside the same transaction: any surviving producer raises,
--    which rolls the whole neutralisation back and aborts the rehearsal.
DO $$
DECLARE
  v record;
  bad int := 0;
BEGIN
  FOR v IN
    SELECT 'agents_heartbeat_on' AS gate, count(*) AS n FROM agents
     WHERE coalesce(runtime_config #>> '{heartbeat,enabled}', '') <> 'false'
        OR coalesce(runtime_config #>> '{heartbeat,wakeOnDemand}', '') <> 'false'
    UNION ALL SELECT 'runs_live', count(*) FROM heartbeat_runs
     WHERE status IN ('queued', 'scheduled_retry', 'running') OR controller_lease_expires_at > now()
    UNION ALL SELECT 'wakeups_pending', count(*) FROM agent_wakeup_requests
     WHERE status IN ('queued', 'deferred_issue_execution', 'claimed')
    UNION ALL SELECT 'recovery_active', count(*) FROM issue_recovery_actions
     WHERE status IN ('active', 'escalated')
    UNION ALL SELECT 'routines_active', count(*) FROM routines WHERE status = 'active'
    UNION ALL SELECT 'routine_triggers_armed', count(*) FROM routine_triggers WHERE enabled OR next_run_at IS NOT NULL
    UNION ALL SELECT 'plugin_jobs_armed', count(*) FROM plugin_jobs WHERE status = 'active' OR next_run_at IS NOT NULL
    UNION ALL SELECT 'plugin_job_runs_live', count(*) FROM plugin_job_runs WHERE status IN ('pending', 'queued', 'running')
    UNION ALL SELECT 'plugin_webhooks_pending', count(*) FROM plugin_webhook_deliveries WHERE status = 'pending'
    UNION ALL SELECT 'plugins_enabled', count(*) FROM plugins WHERE status NOT IN ('disabled', 'uninstalled')
    UNION ALL SELECT 'environment_leases_active', count(*) FROM environment_leases WHERE status = 'active'
    UNION ALL SELECT 'runtime_leases_live', count(*) FROM execution_workspace_runtime_leases WHERE expires_at > now()
    UNION ALL SELECT 'native_finalizations_due', count(*) FROM native_run_finalizations
     WHERE lease_owner IS NOT NULL OR next_attempt_at IS NULL OR next_attempt_at < 'infinity'
    UNION ALL SELECT 'issue_monitors_due', count(*) FROM issues
     WHERE monitor_next_check_at IS NOT NULL AND monitor_next_check_at < 'infinity'
    UNION ALL SELECT 'status_card_evals_due', count(*) FROM status_cards
     WHERE next_eval_at IS NOT NULL AND next_eval_at < 'infinity'
    UNION ALL SELECT 'chat_deliveries_due', count(*) FROM chat_deliveries
     WHERE next_attempt_at IS NOT NULL AND next_attempt_at < 'infinity'
    UNION ALL SELECT 'chat_endpoints_live', count(*) FROM chat_endpoints
     WHERE status IN ('verifying', 'active', 'attention')
    UNION ALL SELECT 'connection_intents_due', count(*) FROM connection_intent_deliveries
     WHERE delivered_at IS NULL AND next_attempt_at < 'infinity'
    UNION ALL SELECT 'external_refresh_due', count(*) FROM external_objects
     WHERE next_refresh_at IS NOT NULL AND next_refresh_at < 'infinity'
    UNION ALL SELECT 'decision_effects_due', count(*) FROM status_decision_effects
     WHERE next_attempt_at IS NOT NULL AND next_attempt_at < 'infinity'
  LOOP
    RAISE NOTICE 'neutralise verify % = %', v.gate, v.n;
    IF v.n > 0 THEN bad := bad + 1; END IF;
  END LOOP;
  IF bad > 0 THEN
    RAISE EXCEPTION 'neutralise-stage: % producer gate(s) still armed on the stage copy; refusing to boot', bad;
  END IF;
  RAISE NOTICE 'neutralise verify: all producer gates closed';
END $$;
