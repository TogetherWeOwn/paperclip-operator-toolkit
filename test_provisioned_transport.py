#!/usr/bin/env python3
"""Offline transport birth regressions; exercise the real provisioner entry point."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
COMPANY = "11111111-1111-4111-8111-111111111111"
SECRET = "22222222-2222-4222-8222-222222222222"
AGENT = "33333333-3333-4333-8333-333333333333"
CONFIG = {
    "companyId": COMPANY,
    "baseUrl": "http://cliproxy:8317",
    "secretId": SECRET,
    "assignedModel": "test-assigned-model",
    "smallFastModel": "test-small-model",
    "apiTimeoutMs": "600000",
    "maxContextTokens": "200000",
}

CLI_STUB = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
with open(os.environ["CALL_LOG"], "a") as f:
    f.write(json.dumps(args) + "\n")
if args[:2] == ["agent", "create"]:
    payload = json.loads(args[args.index("--payload-json") + 1])
    Path(os.environ["PAYLOAD"]).write_text(json.dumps(payload))
    if os.environ.get("REJECT_LEGACY") == "1" and "modelProfiles" in payload["runtimeConfig"]:
        print('{"error":"Unrecognized key: modelProfiles"}')
    else:
        print(json.dumps({"id": os.environ["TEST_AGENT"]}))
elif args[:2] == ["agent", "get"]:
    mode = os.environ.get("READBACK", "ok")
    if mode == "error":
        print("poison-not-a-credential", file=sys.stderr)
        sys.exit(1)
    if mode == "invalid_json":
        print("poison-not-a-credential")
        sys.exit(0)
    payload = json.loads(Path(os.environ["PAYLOAD"]).read_text())
    result = dict(payload, id=os.environ["TEST_AGENT"], companyId=os.environ["COMPANY_ID"])
    env = result["adapterConfig"]["env"]
    if mode == "wrong_agent": result["id"] = os.environ["COMPANY_ID"]
    if mode == "wrong_company": result["companyId"] = os.environ["TEST_AGENT"]
    if mode == "wrong_adapter": result["adapterType"] = "codex_local"
    if mode == "missing_env": result["adapterConfig"] = {}
    if mode == "wrong_endpoint": env["ANTHROPIC_BASE_URL"] = "https://attacker.invalid"
    if mode == "plaintext_token": env["ANTHROPIC_AUTH_TOKEN"] = "poison-not-a-credential"
    if mode == "redacted_token": env["ANTHROPIC_AUTH_TOKEN"] = "[REDACTED]"
    if mode == "wrong_secret": env["ANTHROPIC_AUTH_TOKEN"]["secretId"] = os.environ["TEST_AGENT"]
    if mode == "wrong_version": env["ANTHROPIC_AUTH_TOKEN"]["version"] = "1"
    if mode == "missing_alias": del env["ANTHROPIC_SMALL_FAST_MODEL"]
    if mode == "unrelated_env": env["UNRELATED_SETTING"] = "preserved"
    print(json.dumps(result))
else:
    print('{}')
'''

SQL_STUB = r'''#!/usr/bin/env python3
import os, sys
sql = sys.stdin.read()
with open(os.environ["SQL_LOG"], "a") as f:
    f.write(sql + "\n")
if "FROM heartbeat_runs" in sql:
    if os.environ.get("SMOKE_EXISTS") == "error": sys.exit(1)
    if os.environ.get("SMOKE_EXISTS") == "empty": sys.exit(0)
    print("t" if os.environ.get("SMOKE_EXISTS", "1") == "1" else "f")
elif "company_secret_bindings" in sql:
    if os.environ.get("BINDING_EXISTS") == "error":
        print("poison-not-a-credential", file=sys.stderr)
        sys.exit(1)
    if os.environ.get("BINDING_EXISTS") == "empty": sys.exit(0)
    print("t" if os.environ.get("BINDING_EXISTS", "1") == "1" else "f")
elif "company_secrets" in sql:
    if os.environ.get("SECRET_EXISTS") == "error":
        sys.exit(1)
    if os.environ.get("SECRET_EXISTS") == "empty":
        sys.exit(0)
    print("t" if os.environ.get("SECRET_EXISTS", "1") == "1" else "f")
elif "permissionProfile" in sql:
    print(os.environ["TEST_AGENT"] + "\tP1_PRESIDENT_COO\tTest parent")
elif "adapter_config" in sql:
    # Any mutable-agent discovery is poisoned, never a valid transport source.
    print('{"ANTHROPIC_BASE_URL":"https://attacker.invalid","ANTHROPIC_AUTH_TOKEN":"poison"}')
'''


class ProvisionedTransport(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR"))
        self.addCleanup(self.tmp.cleanup)
        self.work = Path(self.tmp.name)
        for name, text in (("paperclipai", CLI_STUB), ("psql", SQL_STUB)):
            path = self.work / name
            path.write_text(text)
            path.chmod(0o700)
        self.env = os.environ.copy()
        # The runtime BASH_ENV rewrites PATH, hiding our offline executables.
        self.env.pop("BASH_ENV", None)
        self.env.update({
            "PATH": str(self.work) + ":" + os.environ["PATH"],
            "PAPERCLIP_CLI": str(self.work / "paperclipai"),
            "PAPERCLIP_SQL_BACKEND": "psql", "PGHOST": "offline-stub",
            "COMPANY_ID": COMPANY, "TEST_AGENT": AGENT,
            "PROVISIONER_OPERATOR_USER_ID": "test-operator",
            "PROVISIONER_DISABLED": "0", "ADAPTER_TYPE": "claude_local",
            "GRANT_LOG": str(self.work / "grants.jsonl"),
            "CALL_LOG": str(self.work / "calls.jsonl"),
            "SQL_LOG": str(self.work / "sql.txt"),
            "PAYLOAD": str(self.work / "payload.json"),
            "PROVISIONER_CLAUDE_TRANSPORT_JSON": json.dumps(CONFIG),
            "ANTHROPIC_BASE_URL": "https://attacker.invalid",
            "ANTHROPIC_AUTH_TOKEN": "poison-not-a-credential",
            "SECRET_EXISTS": "1", "REJECT_LEGACY": "0",
            "READBACK": "ok", "BINDING_EXISTS": "1", "SMOKE_EXISTS": "1",
        })
        self.env.pop("DATABASE_URL", None)

    def run_create(self, config=CONFIG, **env):
        if config is None:
            self.env.pop("PROVISIONER_CLAUDE_TRANSPORT_JSON", None)
        else:
            self.env["PROVISIONER_CLAUDE_TRANSPORT_JSON"] = json.dumps(config)
        self.env.update(env)
        return subprocess.run(
            ["bash", str(ROOT / "org_provisioner.sh"), "create", "--caller", AGENT,
             "--template", "E0_SPECIALIST", "--title", "Offline transport test"],
            env=self.env, capture_output=True, text=True, check=False,
        )

    def payload(self):
        return json.loads((self.work / "payload.json").read_text())

    def assert_refused_before_create(self, result):
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("REFUSED:", result.stderr)
        self.assertFalse((self.work / "payload.json").exists(), result.stderr)
        self.assertNotIn("poison-not-a-credential", result.stderr)

    def test_complete_env_at_birth(self):
        result = self.run_create()
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = self.payload()
        env = payload["adapterConfig"]["env"]
        self.assertEqual(env, {
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
        })
        self.assertNotIn("model", payload["adapterConfig"])
        self.assertTrue(payload["permissions"]["canAssignTasks"])
        self.assertFalse(payload["runtimeConfig"]["heartbeat"]["enabled"])

    def test_missing_config_cannot_inherit_process_or_neighbor_transport(self):
        self.assert_refused_before_create(self.run_create(None))

    def test_poisoned_neighbor_is_never_consulted(self):
        result = self.run_create()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.payload()["adapterConfig"].get("env", {}).get("ANTHROPIC_BASE_URL"), CONFIG["baseUrl"])
        self.assertNotIn("adapter_config", (self.work / "sql.txt").read_text())

    def test_only_exact_cliproxy_origin(self):
        for url in ("http://omniroute:20129", "https://attacker.invalid", "http://cliproxy:8317@attacker.invalid", "http://cliproxy:8317/redirect", "http://cliproxy:8317/", "https://cliproxy:8317"):
            with self.subTest(url=url):
                self.assert_refused_before_create(self.run_create(dict(CONFIG, baseUrl=url)))

    def test_wrong_company(self):
        self.assert_refused_before_create(self.run_create(dict(CONFIG, companyId=AGENT)))

    def test_invalid_secret_id(self):
        self.assert_refused_before_create(self.run_create(dict(CONFIG, secretId="not-a-uuid")))

    def test_missing_or_cross_company_secret(self):
        self.assert_refused_before_create(self.run_create(SECRET_EXISTS="0"))

    def test_secret_lookup_failure_is_not_a_valid_reference(self):
        for result in ("empty", "error"):
            with self.subTest(result=result):
                self.assert_refused_before_create(self.run_create(SECRET_EXISTS=result))

    def test_secret_lookup_is_active_company_key_scoped(self):
        result = self.run_create()
        self.assertEqual(result.returncode, 0, result.stderr)
        sql = (self.work / "sql.txt").read_text()
        for clause in ("company_id = :'company_id'::uuid", "id = :'text'::uuid", "key = 'cliproxy_agent_api_key'", "status = 'active'"):
            self.assertIn(clause, sql)

    def test_incomplete_config(self):
        for key in CONFIG:
            config = dict(CONFIG)
            del config[key]
            with self.subTest(key=key):
                self.assert_refused_before_create(self.run_create(config))

    def test_unknown_fields_and_plaintext_token(self):
        self.assert_refused_before_create(self.run_create(dict(CONFIG, token="poison-not-a-credential")))

    def test_invalid_scalar_values(self):
        for key, value in (("assignedModel", ""), ("smallFastModel", {}), ("apiTimeoutMs", "0"), ("apiTimeoutMs", "1e6"), ("maxContextTokens", -1)):
            with self.subTest(key=key, value=value):
                self.assert_refused_before_create(self.run_create(dict(CONFIG, **{key: value})))

    def assert_retained_not_provisioned(self, result):
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("REFUSED:", result.stderr)
        self.assertIn(AGENT, result.stderr)
        self.assertIn("do not repeat create", result.stderr)
        self.assertNotIn("PROVISIONED", result.stdout)
        self.assertNotIn("poison-not-a-credential", result.stdout + result.stderr)
        calls = [json.loads(line) for line in (self.work / "calls.jsonl").read_text().splitlines()]
        self.assertEqual(sum(call[:2] == ["agent", "create"] for call in calls), 1)
        self.assertFalse(any(call[:2] == ["agent", "terminate"] for call in calls))

    def test_readback_failure_retains_agent_without_success_claim(self):
        for mode in ("error", "invalid_json", "wrong_agent", "wrong_company", "wrong_adapter",
                     "missing_env", "wrong_endpoint", "plaintext_token", "redacted_token",
                     "wrong_secret", "wrong_version", "missing_alias"):
            with self.subTest(mode=mode):
                (self.work / "calls.jsonl").unlink(missing_ok=True)
                self.assert_retained_not_provisioned(self.run_create(READBACK=mode))

    def test_unrelated_readback_env_is_allowed(self):
        result = self.run_create(READBACK="unrelated_env")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_missing_or_unreadable_binding_is_not_success(self):
        for mode in ("0", "empty", "error"):
            with self.subTest(mode=mode):
                (self.work / "calls.jsonl").unlink(missing_ok=True)
                self.assert_retained_not_provisioned(self.run_create(BINDING_EXISTS=mode))

    def test_binding_lookup_is_exact_and_required(self):
        result = self.run_create()
        self.assertEqual(result.returncode, 0, result.stderr)
        sql = (self.work / "sql.txt").read_text()
        for clause in ("FROM company_secret_bindings", "company_id = :'company_id'::uuid",
                       "target_type = 'agent'", "target_id = :'agent_id'",
                       "secret_id = :'text'::uuid", "config_path = 'env.ANTHROPIC_AUTH_TOKEN'",
                       "version_selector = 'latest'", "required = true"):
            self.assertIn(clause, sql)

    def test_configuration_is_not_smoke_readiness(self):
        result = self.run_create()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("NOT READY: successful nonzero-usage smoke still required", result.stdout)
        calls = [json.loads(line) for line in (self.work / "calls.jsonl").read_text().splitlines()]
        self.assertEqual(sum(call[:2] == ["agent", "get"] for call in calls), 1)
        self.assertFalse(any(call[:2] == ["agent", "heartbeat:invoke"] for call in calls))

    def run_verify(self, run_id="44444444-4444-4444-8444-444444444444", **env):
        self.env.update(env)
        return subprocess.run(
            ["bash", str(ROOT / "org_provisioner.sh"), "verify-transport", "--target", AGENT,
             "--smoke-run", run_id], env=self.env, capture_output=True, text=True, check=False,
        )

    def test_smoke_verification_is_explicit_read_only_and_successful(self):
        self.assertEqual(self.run_create().returncode, 0)
        (self.work / "calls.jsonl").unlink()
        result = self.run_verify()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("TRANSPORT_READY " + AGENT, result.stdout)
        calls = [json.loads(line) for line in (self.work / "calls.jsonl").read_text().splitlines()]
        self.assertTrue(calls)
        self.assertTrue(all(call[:2] == ["agent", "get"] for call in calls))

    def test_smoke_missing_or_unreadable_evidence_is_not_ready(self):
        self.assertEqual(self.run_create().returncode, 0)
        for mode in ("0", "empty", "error"):
            with self.subTest(mode=mode):
                result = self.run_verify(SMOKE_EXISTS=mode)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("TRANSPORT_READY", result.stdout)
                self.assertIn("REFUSED:", result.stderr)

    def test_smoke_requires_valid_run_id_and_current_transport(self):
        self.assertEqual(self.run_create().returncode, 0)
        for run_id in ("", "not-a-uuid"):
            result = self.run_verify(run_id)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("TRANSPORT_READY", result.stdout)
        result = self.run_verify(READBACK="wrong_endpoint")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("TRANSPORT_READY", result.stdout)

    def test_smoke_query_is_scoped_fresh_and_nonzero(self):
        self.assertEqual(self.run_create().returncode, 0)
        result = self.run_verify()
        self.assertEqual(result.returncode, 0, result.stderr)
        sql = (self.work / "sql.txt").read_text()
        for clause in ("FROM heartbeat_runs", "h.id = :'text'::uuid",
                       "h.company_id = :'company_id'::uuid", "h.agent_id = :'agent_id'::uuid",
                       "h.status = 'succeeded'", "h.error_code IS NULL", "h.error IS NULL",
                       "h.created_at >", "h.started_at >", "h.finished_at >= h.started_at",
                       "agent_config_revisions", "b.updated_at", "s.updated_at",
                       "inputTokens", "outputTokens", "jsonb_typeof", "::numeric",
                       "a.adapter_config->'env' @> :'a'::jsonb"):
            self.assertIn(clause, sql)
        self.assertNotIn("a.updated_at", sql)

    def test_non_claude_adapter_unaffected(self):
        result = self.run_create(None, ADAPTER_TYPE="codex_local")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.payload()["adapterConfig"], {})

    def test_legacy_retry_preserves_transport(self):
        result = self.run_create(REJECT_LEGACY="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = [json.loads(line) for line in (self.work / "calls.jsonl").read_text().splitlines()]
        creates = [json.loads(call[call.index("--payload-json") + 1]) for call in calls if call[:2] == ["agent", "create"]]
        self.assertEqual(len(creates), 2)
        self.assertIn("env", creates[0]["adapterConfig"])
        self.assertEqual(creates[0]["adapterConfig"], creates[1]["adapterConfig"])
        self.assertNotIn("modelProfiles", creates[1]["runtimeConfig"])


if __name__ == "__main__":
    unittest.main()
