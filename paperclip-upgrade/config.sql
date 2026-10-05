-- ===========================================================================
-- paperclip-upgrade/config.sql -- READ-ONLY fingerprint of every setting the
-- upgrade must not change: agent adapter/runtime config (model
-- pins, heartbeat/admission flags), per-issue manual model pins, company
-- budgets/status, plugin bindings and config, instance settings.
--
-- Values are md5 fingerprints, never the config itself: the output is safe
-- to keep in the state dir and diff. drain.sh records it after the drain
-- (config-backup) and again before undrain (config-verify); any line that
-- disappeared or changed refuses the undrain unless the operator acks the
-- exact count. agents.status idle/running both mean "active" here so a run
-- finishing between snapshots is not drift.
-- ===========================================================================
SELECT 'agent|' || id || '|' || company_id || '|'
       || (CASE WHEN status IN ('idle', 'running') THEN 'active' ELSE status END) || '|'
       || md5(coalesce(adapter_config::text, '')) || '|' || md5(coalesce(runtime_config::text, ''))
  FROM agents
UNION ALL
SELECT 'company|' || id || '|' || coalesce(budget_monthly_cents::text, '') || '|' || status
  FROM companies
UNION ALL
SELECT 'issue_pin|' || id || '|' || md5(assignee_adapter_overrides::text)
  FROM issues
 WHERE assignee_adapter_overrides IS NOT NULL AND status NOT IN ('done', 'cancelled')
UNION ALL
SELECT 'plugin|' || plugin_key || '|' || status || '|' || coalesce(version, '') || '|' || coalesce(package_path, '')
  FROM plugins
UNION ALL
SELECT 'plugin_config|' || id || '|' || plugin_id || '|' || coalesce(company_id::text, '') || '|' || md5(coalesce(config_json::text, ''))
  FROM plugin_config
UNION ALL
SELECT 'instance_settings|' || singleton_key || '|' || md5(coalesce(general::text, '')) || '|'
       || md5(coalesce(experimental::text, '')) || '|' || coalesce(default_environment_id::text, '')
  FROM instance_settings
ORDER BY 1;
