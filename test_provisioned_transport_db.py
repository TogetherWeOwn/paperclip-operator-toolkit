#!/usr/bin/env python3
"""Real transport SQL in an explicitly disposable database; the agent API is fake.

Use --init once on an empty fixture database. Tests own a random schema and never
reset public application tables. Database guards and writes share a transaction.
"""
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import uuid

from test_provisioned_transport import AGENT, CLI_STUB, COMPANY, CONFIG, ROOT, SECRET

DATABASE = "toolkit_transport_fixture"
MARKER = "operator-toolkit:transport-fixture:v1"
RUN = "44444444-4444-4444-8444-444444444444"
ENV = {
    "ANTHROPIC_BASE_URL": CONFIG["baseUrl"],
    "ANTHROPIC_AUTH_TOKEN": {"type": "secret_ref", "secretId": SECRET, "version": "latest"},
    "PAPERCLIP_ASSIGNED_MODEL": CONFIG["assignedModel"],
    "CLAUDE_CODE_SUBAGENT_MODEL": CONFIG["assignedModel"],
    "ANTHROPIC_DEFAULT_OPUS_MODEL": CONFIG["assignedModel"],
    "ANTHROPIC_DEFAULT_SONNET_MODEL": CONFIG["assignedModel"],
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": CONFIG["smallFastModel"],
    "ANTHROPIC_SMALL_FAST_MODEL": CONFIG["smallFastModel"],
    "API_TIMEOUT_MS": CONFIG["apiTimeoutMs"],
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": CONFIG["maxContextTokens"],
}
GUARD = f"""
DO $guard$
DECLARE marker_value text;
BEGIN
  IF current_database() <> '{DATABASE}' THEN
    RAISE EXCEPTION 'transport tests require the disposable fixture database';
  END IF;
  SELECT marker INTO STRICT marker_value FROM public.toolkit_transport_fixture_sentinel;
  IF marker_value IS DISTINCT FROM '{MARKER}' THEN
    RAISE EXCEPTION 'transport tests require the fixture sentinel';
  END IF;
END
$guard$;
"""


def fixture_environment(env):
    expected = {"PGDATABASE": DATABASE, "PGPORT": "5432", "PGUSER": "agent_test"}
    if any(env.get(key) != value for key, value in expected.items()):
        raise RuntimeError("REFUSED: explicitly select the disposable database, port and test role")
    if env.get("PGHOST") not in ("localhost", "127.0.0.1", "agent-testdb"):
        raise RuntimeError("REFUSED: transport proofs require a local CI or agent test database")
    if env.get("PGPASSWORD", "") != "":
        raise RuntimeError("REFUSED: transport fixtures use only the empty-password test role")
    # Do not inherit provider credentials, startup files, service selectors,
    # host-address overrides, proxy settings or a caller's search_path.
    return {"PATH": env.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8",
            **expected, "PGHOST": env["PGHOST"], "PGPASSWORD": "",
            "PGPASSFILE": "/dev/null", "PGCONNECT_TIMEOUT": "5"}


def sql_script(body):
    return "BEGIN;\n" + GUARD + body + "\nCOMMIT;"


def run_sql(env, script):
    clean = fixture_environment(env)
    if env.get("PGOPTIONS"):
        if not re.fullmatch(r"-c search_path=transport_test_[0-9a-f]{32}", env["PGOPTIONS"]):
            raise RuntimeError("REFUSED: fixture schema must be a generated isolated test schema")
        clean["PGOPTIONS"] = env["PGOPTIONS"]
    result = subprocess.run(["psql", "-X", "-w", "-Atq", "-v", "ON_ERROR_STOP=1"],
                            input=script, env=clean, timeout=30,
                            capture_output=True, text=True)
    if result.returncode:
        raise AssertionError("fixture SQL failed: " + result.stderr)
    return result.stdout


def fixture_sql(env, body):
    return run_sql(env, sql_script(body))


def initialization_script():
    return f"""BEGIN;
DO $init_guard$
DECLARE marker_value text; table_count bigint;
BEGIN
  IF current_database() <> '{DATABASE}' THEN
    RAISE EXCEPTION 'initialization requires the disposable fixture database';
  END IF;
  IF to_regclass('public.toolkit_transport_fixture_sentinel') IS NOT NULL THEN
    SELECT marker INTO STRICT marker_value FROM public.toolkit_transport_fixture_sentinel;
    IF marker_value IS DISTINCT FROM '{MARKER}' THEN
      RAISE EXCEPTION 'fixture sentinel has an unexpected value';
    END IF;
    RETURN;
  END IF;
  SELECT count(*) INTO table_count FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'f', 'v', 'm');
  IF table_count <> 0 THEN
    RAISE EXCEPTION 'refusing to initialize over existing public relations';
  END IF;
  CREATE TABLE public.toolkit_transport_fixture_sentinel (marker text PRIMARY KEY);
  INSERT INTO public.toolkit_transport_fixture_sentinel VALUES ('{MARKER}');
END
$init_guard$;
COMMIT;
"""


def initialize_fixture(env):
    return run_sql(fixture_environment(env), initialization_script())


class TransportDatabase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.env = fixture_environment(os.environ)
        cls.schema = "transport_test_" + uuid.uuid4().hex
        cls.env["PGOPTIONS"] = "-c search_path=" + cls.schema
        cls.sql("CREATE SCHEMA " + cls.schema + ";")
        cls.addClassCleanup(lambda: cls.sql("DROP SCHEMA " + cls.schema + " CASCADE;"))
        # Minimal projections with application types; not schema-drift coverage.
        cls.sql("""
CREATE TABLE agents (id uuid, company_id uuid, status text, adapter_type text,
  adapter_config jsonb, created_at timestamptz, updated_at timestamptz);
CREATE TABLE company_secrets (id uuid, company_id uuid, key text, status text, updated_at timestamptz);
CREATE TABLE company_secret_bindings (company_id uuid, secret_id uuid, target_type text,
  target_id text, config_path text, version_selector text, required boolean,
  created_at timestamptz, updated_at timestamptz);
CREATE TABLE agent_config_revisions (company_id uuid, agent_id uuid, created_at timestamptz);
CREATE TABLE heartbeat_runs (id uuid, company_id uuid, agent_id uuid, status text,
  created_at timestamptz, started_at timestamptz, finished_at timestamptz,
  usage_json jsonb, error text, error_code text, exit_code integer);
""")

    @classmethod
    def sql(cls, body):
        return fixture_sql(cls.env, body)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.work = Path(self.tmp.name)
        cli = self.work / "paperclipai"
        cli.write_text(CLI_STUB)
        cli.chmod(0o700)
        payload = {"adapterType": "claude_local", "adapterConfig": {"env": ENV}}
        (self.work / "payload.json").write_text(json.dumps(payload))
        self.run_env = dict(self.env, PAPERCLIP_CLI=str(cli), PAPERCLIP_SQL_BACKEND="psql",
                            PAPERCLIP_API_URL="http://api.invalid", COMPANY_ID=COMPANY,
                            TEST_AGENT=AGENT, PROVISIONER_CLAUDE_TRANSPORT_JSON=json.dumps(CONFIG),
                            CALL_LOG=str(self.work / "calls.jsonl"), PAYLOAD=str(self.work / "payload.json"),
                            READBACK="ok", HOME=str(self.work))
        self.seed()

    def seed(self):
        config = json.dumps({"env": ENV}).replace("'", "''")
        self.sql(f"""
TRUNCATE agents, company_secrets, company_secret_bindings, agent_config_revisions, heartbeat_runs;
INSERT INTO agents VALUES ('{AGENT}', '{COMPANY}', 'idle', 'claude_local', '{config}',
  now() - interval '10 minutes', now());
INSERT INTO company_secrets VALUES ('{SECRET}', '{COMPANY}', 'cliproxy_agent_api_key', 'active',
  now() - interval '10 minutes');
INSERT INTO company_secret_bindings VALUES ('{COMPANY}', '{SECRET}', 'agent', '{AGENT}',
  'env.ANTHROPIC_AUTH_TOKEN', 'latest', true, now() - interval '10 minutes', now() - interval '10 minutes');
INSERT INTO agent_config_revisions VALUES ('{COMPANY}', '{AGENT}', now() - interval '8 minutes');
INSERT INTO heartbeat_runs VALUES ('{RUN}', '{COMPANY}', '{AGENT}', 'succeeded',
  now() - interval '3 minutes', now() - interval '2 minutes', now() - interval '1 minute',
  '{{"inputTokens":12,"outputTokens":3}}', null, null, 0);
""")

    def verify(self):
        return subprocess.run(["bash", str(ROOT / "org_provisioner.sh"), "verify-transport",
                               "--target", AGENT, "--smoke-run", RUN],
                              env=self.run_env, capture_output=True, text=True)

    def assert_ready(self):
        result = self.verify()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("TRANSPORT_READY " + AGENT, result.stdout)

    def test_real_sql_positive_control_and_birth_without_revision(self):
        self.assert_ready()
        self.sql("DELETE FROM agent_config_revisions;")
        self.assert_ready()
        self.sql("UPDATE agents SET updated_at = now() + interval '1 minute';")
        self.assert_ready()

    def test_real_sql_rejects_each_bad_run_or_stale_configuration(self):
        changes = {
            "zero usage": "UPDATE heartbeat_runs SET usage_json = '{\"inputTokens\":0,\"outputTokens\":0}';",
            "missing usage": "UPDATE heartbeat_runs SET usage_json = null;",
            "string usage": "UPDATE heartbeat_runs SET usage_json = '{\"inputTokens\":\"12\",\"outputTokens\":3}';",
            "invalid numeric": "UPDATE heartbeat_runs SET usage_json = '{\"inputTokens\":\"oops\",\"outputTokens\":3}';",
            "negative usage": "UPDATE heartbeat_runs SET usage_json = '{\"inputTokens\":-1,\"outputTokens\":3}';",
            "queued": "UPDATE heartbeat_runs SET status = 'queued';",
            "failed": "UPDATE heartbeat_runs SET status = 'failed';",
            "error code": "UPDATE heartbeat_runs SET error_code = 'connection_refused';",
            "error text": "UPDATE heartbeat_runs SET error = 'connection refused';",
            "bad exit": "UPDATE heartbeat_runs SET exit_code = 1;",
            "wrong company": f"UPDATE heartbeat_runs SET company_id = '{AGENT}';",
            "wrong agent": f"UPDATE heartbeat_runs SET agent_id = '{COMPANY}';",
            "wrong run": f"UPDATE heartbeat_runs SET id = '{SECRET}';",
            "missing start": "UPDATE heartbeat_runs SET started_at = null;",
            "missing finish": "UPDATE heartbeat_runs SET finished_at = null;",
            "future finish": "UPDATE heartbeat_runs SET finished_at = now() + interval '1 minute';",
            "queued before config": "UPDATE heartbeat_runs SET created_at = now() - interval '9 minutes';",
            "started before config": "UPDATE heartbeat_runs SET started_at = now() - interval '9 minutes';",
            "new revision": "UPDATE agent_config_revisions SET created_at = now();",
            "new binding": "UPDATE company_secret_bindings SET updated_at = now();",
            "secret rotation": "UPDATE company_secrets SET updated_at = now();",
            "missing binding": "DELETE FROM company_secret_bindings;",
            "optional binding": "UPDATE company_secret_bindings SET required = false;",
            "disabled secret": "UPDATE company_secrets SET status = 'disabled';",
            "wrong binding company": f"UPDATE company_secret_bindings SET company_id = '{AGENT}';",
            "wrong binding secret": f"UPDATE company_secret_bindings SET secret_id = '{AGENT}';",
            "wrong binding path": "UPDATE company_secret_bindings SET config_path = 'env.OTHER';",
            "wrong binding version": "UPDATE company_secret_bindings SET version_selector = '1';",
            "terminated": "UPDATE agents SET status = 'terminated';",
            "stored env changed after API": "UPDATE agents SET adapter_config = '{\"env\":{}}';",
        }
        for label, sql in changes.items():
            with self.subTest(case=label):
                self.seed()
                self.assert_ready()
                self.sql(sql)
                result = self.verify()
                self.assertNotEqual(result.returncode, 0, label)
                self.assertNotIn("TRANSPORT_READY", result.stdout)
                self.assertIn("REFUSED:", result.stderr)


if __name__ == "__main__":
    if sys.argv[1:] == ["--init"]:
        initialize_fixture(os.environ)
        print("disposable transport fixture initialized; no application tables reset")
    else:
        unittest.main()
