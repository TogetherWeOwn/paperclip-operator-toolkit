-- TOG-480 CI fixture schema.
--
-- Extracted from /app/packages/db/src/migrations/meta/0211_snapshot.json on
-- 2026-08-25. These are the six platform tables the operator suites read or
-- write. Foreign keys to tables outside this six-table fixture are deliberately
-- omitted: this is a query-compatible fixture, not a second Paperclip schema.
-- schema_drift.sh compares every column, type, nullability and default against
-- the running database so this snapshot cannot silently rot.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  company_id uuid NOT NULL,
  name text NOT NULL,
  role text DEFAULT 'general' NOT NULL,
  title text,
  icon text,
  status text DEFAULT 'idle' NOT NULL,
  reports_to uuid,
  capabilities text,
  adapter_type text DEFAULT 'process' NOT NULL,
  adapter_config jsonb DEFAULT '{}'::jsonb NOT NULL,
  runtime_config jsonb DEFAULT '{}'::jsonb NOT NULL,
  default_environment_id uuid,
  budget_monthly_cents integer DEFAULT 0 NOT NULL,
  spent_monthly_cents integer DEFAULT 0 NOT NULL,
  pause_reason text,
  paused_at timestamp with time zone,
  error_reason text,
  permissions jsonb DEFAULT '{}'::jsonb NOT NULL,
  last_heartbeat_at timestamp with time zone,
  metadata jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX agents_company_status_idx ON agents (company_id, status);
CREATE INDEX agents_company_reports_to_idx ON agents (company_id, reports_to);

CREATE TABLE principal_permission_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  company_id uuid NOT NULL,
  principal_type text NOT NULL,
  principal_id text NOT NULL,
  permission_key text NOT NULL,
  scope jsonb,
  granted_by_user_id text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX principal_permission_grants_unique_idx
  ON principal_permission_grants (company_id, principal_type, principal_id, permission_key);

CREATE TABLE company_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  company_id uuid NOT NULL,
  principal_type text NOT NULL,
  principal_id text NOT NULL,
  status text DEFAULT 'active' NOT NULL,
  membership_role text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX company_memberships_company_principal_unique_idx
  ON company_memberships (company_id, principal_type, principal_id);

CREATE TABLE company_secret_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  company_id uuid NOT NULL,
  secret_id uuid NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  config_path text NOT NULL,
  version_selector text DEFAULT 'latest' NOT NULL,
  required boolean DEFAULT true NOT NULL,
  label text,
  projection_class text DEFAULT 'unclassified' NOT NULL,
  projection_allowlist_key text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX company_secret_bindings_target_path_uq
  ON company_secret_bindings (company_id, target_type, target_id, config_path);

CREATE TABLE budget_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  company_id uuid NOT NULL,
  scope_type text NOT NULL,
  scope_id uuid NOT NULL,
  metric text DEFAULT 'billed_cents' NOT NULL,
  window_kind text NOT NULL,
  amount integer DEFAULT 0 NOT NULL,
  warn_percent integer DEFAULT 80 NOT NULL,
  hard_stop_enabled boolean DEFAULT true NOT NULL,
  notify_enabled boolean DEFAULT true NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  created_by_user_id text,
  updated_by_user_id text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX budget_policies_company_scope_metric_unique_idx
  ON budget_policies (company_id, scope_type, scope_id, metric, window_kind);

CREATE TABLE heartbeat_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  company_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  invocation_source text DEFAULT 'on_demand' NOT NULL,
  trigger_detail text,
  status text DEFAULT 'queued' NOT NULL,
  responsible_user_id text,
  started_at timestamp with time zone,
  finished_at timestamp with time zone,
  error text,
  wakeup_request_id uuid,
  exit_code integer,
  signal text,
  usage_json jsonb,
  result_json jsonb,
  session_id_before text,
  session_id_after text,
  log_store text,
  log_ref text,
  log_bytes bigint,
  log_sha256 text,
  log_compressed boolean DEFAULT false NOT NULL,
  stdout_excerpt text,
  stderr_excerpt text,
  error_code text,
  external_run_id text,
  process_pid integer,
  process_group_id integer,
  process_started_at timestamp with time zone,
  last_output_at timestamp with time zone,
  last_output_seq integer DEFAULT 0 NOT NULL,
  last_output_stream text,
  last_output_bytes bigint,
  retry_of_run_id uuid,
  process_loss_retry_count integer DEFAULT 0 NOT NULL,
  scheduled_retry_at timestamp with time zone,
  scheduled_retry_attempt integer DEFAULT 0 NOT NULL,
  scheduled_retry_reason text,
  issue_comment_status text DEFAULT 'not_applicable' NOT NULL,
  issue_comment_satisfied_by_comment_id uuid,
  issue_comment_retry_queued_at timestamp with time zone,
  liveness_state text,
  liveness_reason text,
  continuation_attempt integer DEFAULT 0 NOT NULL,
  last_useful_action_at timestamp with time zone,
  next_action text,
  context_snapshot jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
