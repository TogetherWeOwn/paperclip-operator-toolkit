CREATE TABLE plugin_gh_token_broker_c304a73ea6.external_disclosure_receipts (
  grant_id text PRIMARY KEY,
  company_id text NOT NULL,
  issue_id text NOT NULL,
  issue_identifier text NOT NULL,
  run_id text NOT NULL,
  approval_id text NOT NULL,
  status text NOT NULL,
  receipt_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
