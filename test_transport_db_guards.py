#!/usr/bin/env python3
"""Offline refusal controls for the disposable transport SQL proof."""
import unittest
from unittest.mock import patch
from types import SimpleNamespace

import test_provisioned_transport_db as fixture


class FixtureGuards(unittest.TestCase):
    def environment(self):
        return {"PATH": "/usr/bin:/bin", "PGHOST": "localhost", "PGPORT": "5432",
                "PGUSER": "agent_test", "PGPASSWORD": "", "PGDATABASE": fixture.DATABASE}

    def test_valid_disposable_target(self):
        actual = fixture.fixture_environment(self.environment())
        self.assertEqual(actual["PGDATABASE"], fixture.DATABASE)
        self.assertEqual(actual["PGHOST"], "localhost")

    def test_missing_target_fields_refuse_before_transport(self):
        for key in ("PGHOST", "PGPORT", "PGUSER", "PGDATABASE"):
            with self.subTest(field=key), patch.object(fixture.subprocess, "run") as call:
                env = self.environment()
                del env[key]
                with self.assertRaisesRegex(RuntimeError, "REFUSED:"):
                    fixture.fixture_environment(env)
                call.assert_not_called()

    def test_wrong_target_or_credential_refuses(self):
        for key, value in (("PGHOST", "live.invalid"), ("PGHOST", "/tmp"),
                           ("PGHOST", "localhost,live.invalid"), ("PGPORT", "6432"),
                           ("PGUSER", "administrator"), ("PGDATABASE", "application"),
                           ("PGPASSWORD", "not-a-real-secret")):
            with self.subTest(field=key, value=value):
                env = self.environment()
                env[key] = value
                with self.assertRaisesRegex(RuntimeError, "REFUSED:") as caught:
                    fixture.fixture_environment(env)
                self.assertNotIn("not-a-real-secret", str(caught.exception))

    def test_ambient_settings_and_credentials_do_not_enter_children(self):
        env = self.environment()
        for key in ("DATABASE_URL", "PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE", "PGOPTIONS",
                    "BASH_ENV", "ENV", "LD_PRELOAD", "PYTHONPATH", "PYTHONSTARTUP",
                    "PAPERCLIP_API_KEY", "GH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "HTTPS_PROXY"):
            env[key] = "not-a-real-secret"
        actual = fixture.fixture_environment(env)
        self.assertNotIn("not-a-real-secret", actual.values())
        self.assertEqual(actual["PGPASSFILE"], "/dev/null")
        self.assertEqual(actual["PGPASSWORD"], "")

    def test_every_write_has_database_and_exact_single_sentinel_guard(self):
        body = "CREATE SCHEMA transport_test_0123456789abcdef0123456789abcdef;"
        sql = fixture.sql_script(body)
        self.assertTrue(sql.startswith("BEGIN;\n"))
        self.assertTrue(sql.endswith("\nCOMMIT;"))
        self.assertIn("current_database()", sql)
        self.assertIn("INTO STRICT marker_value", sql)
        self.assertLess(sql.index("current_database()"), sql.index(body))
        self.assertLess(sql.index("INTO STRICT marker_value"), sql.index(body))
        self.assertIn(fixture.DATABASE, sql)
        self.assertIn(fixture.MARKER, sql)
        self.assertIn("IS DISTINCT FROM", sql)

    def test_initializer_cannot_reset_or_bypass_existing_relation_guard(self):
        sql = fixture.initialization_script()
        self.assertTrue(sql.startswith("BEGIN;"))
        self.assertTrue(sql.endswith("COMMIT;\n"))
        self.assertLess(sql.index("current_database()"), sql.index("CREATE TABLE"))
        self.assertLess(sql.index("table_count <> 0"), sql.index("CREATE TABLE"))
        self.assertLess(sql.index("INTO STRICT marker_value"), sql.index("CREATE TABLE"))
        self.assertIn(fixture.DATABASE, sql)
        self.assertIn(fixture.MARKER, sql)
        for command in ("DROP ", "TRUNCATE ", "DELETE ", "UPDATE "):
            self.assertNotIn(command, sql)

    def test_non_generated_schema_refuses_before_sql(self):
        for value in ("-c search_path=public", "-c search_path=transport_test_bad", "-c role=administrator"):
            with self.subTest(options=value), patch.object(fixture.subprocess, "run") as call:
                env = fixture.fixture_environment(self.environment())
                env["PGOPTIONS"] = value
                with self.assertRaisesRegex(RuntimeError, "REFUSED:"):
                    fixture.fixture_sql(env, "SELECT 1;")
                call.assert_not_called()

    def test_sql_failure_is_not_empty_success(self):
        with patch.object(fixture.subprocess, "run", return_value=SimpleNamespace(
                returncode=2, stdout="", stderr="fixture refused")) as call:
            with self.assertRaisesRegex(AssertionError, "fixture SQL failed"):
                fixture.fixture_sql(fixture.fixture_environment(self.environment()), "SELECT 1;")
            invocation = call.call_args
            self.assertIn("-X", invocation.args[0])
            self.assertIn("-w", invocation.args[0])
            self.assertIn("ON_ERROR_STOP=1", invocation.args[0])
            self.assertEqual(invocation.kwargs["input"], fixture.sql_script("SELECT 1;"))


if __name__ == "__main__":
    unittest.main()
