#!/usr/bin/env python3
"""The nightly joiner is offline; failure must replace, not retain, a healthy line."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from test_quality_guardrail import fixture, ledger

SPEC = importlib.util.spec_from_file_location("dora_scoreboard", Path(__file__).with_name("dora_scoreboard.py"))
scoreboard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(scoreboard)


class Scoreboard(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "escapes.jsonl"
        self.out = self.root / "output"
        self.meta, self.merges, self.events = fixture()
        self.meta["type"] = "metadata"
        self.meta["tool_sha256"] = "b" * 64
        self.now = ledger.instant("2026-10-24T01:00:00Z")
        self.write()

    def tearDown(self):
        self.temp.cleanup()

    def write(self):
        self.meta.update(merges=len(self.merges), escapes=len(self.events))
        self.meta["quality"] = ledger.quality_summary(self.meta, self.merges, self.events)
        self.source.write_text("".join(json.dumps(r) + "\n" for r in [self.meta, *self.merges, *self.events]))

    def run_cli(self, *more):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            rc = scoreboard.main(["--ledger", str(self.source), "--output-dir", str(self.out),
                                  "--now", ledger.stamp(self.now), *more])
        return rc, json.loads(output.getvalue())

    def test_publishes_one_line_and_machine_snapshot_with_source_hash_and_n(self):
        rc, data = self.run_cli()
        self.assertEqual(rc, 0)
        self.assertEqual(data["quality"]["n"], 2)
        self.assertEqual(data["source"]["sha256"], hashlib.sha256(self.source.read_bytes()).hexdigest())
        self.assertEqual(data["source"]["run_id"], "fixture-run")
        self.assertEqual(json.loads((self.out / "quality-scoreboard.json").read_text()), data)
        text = (self.out / "owner-inbox-line.txt").read_text()
        self.assertEqual(len(text.splitlines()), 1)
        self.assertIn("50.00% (1/2; n=2)", text)
        self.assertIn("rework=50.00% (1/2; n=2)", text)
        self.assertIn("immature=1", text)
        self.assertNotIn("PASS", text)
        self.assertEqual((self.out / "owner-inbox-line.txt").stat().st_mode & 0o777, 0o600)

    def test_dry_run_does_not_create_output(self):
        rc, data = self.run_cli("--dry-run")
        self.assertEqual(rc, 0)
        self.assertFalse(self.out.exists())

    def test_partial_collection_keeps_observed_n_but_suppresses_rates(self):
        self.meta["status"] = "partial"
        self.write()
        rc, data = self.run_cli()
        self.assertEqual(rc, 2)
        self.assertEqual(data["quality"]["n"], 2)
        self.assertIsNone(data["quality"]["escape_rework_rate"])
        self.assertIn("N/A", (self.out / "owner-inbox-line.txt").read_text())

    def test_zero_n_is_not_zero_percent(self):
        self.merges = self.events = []
        self.meta["coverage"][0].update(merges=0, analyzed=0)
        self.write()
        rc, data = self.run_cli()
        self.assertEqual(rc, 0)
        self.assertEqual(data["quality"]["n"], 0)
        self.assertIn("N/A (0/0; n=0)", (self.out / "owner-inbox-line.txt").read_text())

    def test_stale_missing_and_malformed_replace_previous_healthy_line(self):
        self.run_cli()
        for mode, code in (("stale", "STALE_SNAPSHOT"), ("malformed", "INVALID_SNAPSHOT"),
                           ("missing", "SOURCE_UNAVAILABLE")):
            with self.subTest(mode=mode):
                self.write()
                if mode == "stale":
                    self.meta["generated_at"] = "2026-10-20T00:00:00Z"
                    self.write()
                elif mode == "malformed":
                    self.source.write_text('{"type":"metadata"}\nnot-json\n')
                else:
                    self.source.unlink()
                rc, data = self.run_cli()
                self.assertEqual(rc, 2)
                self.assertEqual(data["error"]["code"], code)
                self.assertIn("UNAVAILABLE", (self.out / "owner-inbox-line.txt").read_text())
                self.assertNotIn("50.00%", (self.out / "owner-inbox-line.txt").read_text())

    def test_future_and_truncated_and_version_mismatch_rejected(self):
        for change in ({"generated_at": "2026-10-25T00:00:00Z"}, {"schema_version": 4},
                       {"merges": 999}, {"tool_sha256": None}, {"run_id": "unsafe\nline"}):
            self.meta = dict(fixture()[0], type="metadata", tool_sha256="b" * 64)
            self.write()
            self.meta.update(change)
            self.source.write_text("".join(json.dumps(r) + "\n" for r in [self.meta, *self.merges, *self.events]))
            with self.subTest(change=change):
                rc, data = self.run_cli()
                self.assertEqual(rc, 2)
                self.assertEqual(data["error"]["code"], "INVALID_SNAPSHOT")

    def test_recomputed_summary_must_match_collector(self):
        self.meta["quality"]["n"] = 999
        self.source.write_text("".join(json.dumps(r) + "\n" for r in [self.meta, *self.merges, *self.events]))
        rc, data = self.run_cli()
        self.assertEqual(rc, 2)
        self.assertEqual(data["error"]["code"], "INVALID_SNAPSHOT")

    def test_systemd_rejects_another_invocation_even_if_snapshot_is_fresh(self):
        with patch.dict(os.environ, {"INVOCATION_ID": "new-run"}):
            rc, data = self.run_cli("--entry-point", "systemd")
        self.assertEqual(rc, 2)
        self.assertEqual(data["error"]["code"], "WRONG_INVOCATION")

    def test_systemd_requires_an_invocation_and_accepts_the_matching_one(self):
        with patch.dict(os.environ, {}, clear=True):
            rc, data = self.run_cli("--entry-point", "systemd")
        self.assertEqual(data["error"]["code"], "WRONG_INVOCATION")
        with patch.dict(os.environ, {"INVOCATION_ID": "fixture-run"}):
            self.assertEqual(self.run_cli("--entry-point", "systemd")[0], 0)

    def test_no_network_database_or_model_execution(self):
        with patch.object(ledger, "command", side_effect=AssertionError("no external commands")), \
                patch("subprocess.run", side_effect=AssertionError("no external commands")):
            self.assertEqual(self.run_cli()[0], 0)

    def test_failure_diagnostics_never_echo_raw_source(self):
        self.source.write_text("synthetic-sensitive-value\n")
        rc, data = self.run_cli()
        self.assertEqual(rc, 2)
        self.assertNotIn("synthetic-sensitive-value", json.dumps(data))
        self.assertFalse(data["error"]["retryable"])
        self.assertTrue(data["error"]["next_action"])

    def test_busy_writer_does_not_overwrite_the_winner(self):
        self.run_cli()
        before = (self.out / "quality-scoreboard.json").read_bytes()
        with ledger.lock(self.out / ".quality-scoreboard.lock", nonblocking=True):
            rc, data = self.run_cli()
        self.assertEqual(rc, 75)
        self.assertEqual(data["error"]["code"], "BUSY")
        self.assertEqual((self.out / "quality-scoreboard.json").read_bytes(), before)

    def test_duplicate_metadata_and_unknown_record_and_nan_are_rejected(self):
        for suffix in (json.dumps(self.meta), '{"type":"surprise"}', '{"type":"merge","number":NaN}'):
            self.write()
            with self.source.open("a") as handle:
                handle.write(suffix + "\n")
            with self.subTest(suffix=suffix[:30]):
                self.assertEqual(self.run_cli()[1]["error"]["code"], "INVALID_SNAPSHOT")

    def test_failure_between_file_renames_is_explicit_and_json_is_authoritative(self):
        original = scoreboard.ledger.atomic

        def fail_text(path, text):
            if path.name == "owner-inbox-line.txt":
                raise OSError("synthetic write failure")
            return original(path, text)

        with patch.object(scoreboard.ledger, "atomic", side_effect=fail_text):
            rc, data = self.run_cli()
        self.assertEqual(rc, 2)
        self.assertEqual(data["error"]["code"], "OUTPUT_UNAVAILABLE")
        saved = json.loads((self.out / "quality-scoreboard.json").read_text())
        self.assertIn("50.00% (1/2; n=2)", saved["owner_line"])
        self.assertFalse((self.out / "owner-inbox-line.txt").exists())

    def test_collector_to_scoreboard_contract_without_a_live_source(self):
        import argparse
        from unittest.mock import Mock
        merge = {"number": 1, "mergedAt": "2026-10-01T01:00:00Z",
                 "createdAt": "2026-10-01T00:00:00Z", "headRefOid": "1" * 40,
                 "mergeCommit": {"oid": "a" * 40}, "baseRefName": "main"}
        memory = self.root / "memory"
        memory.mkdir()
        args = argparse.Namespace(root=self.root, until="2026-10-24T00:00:00Z", days=30,
                                  org="Org", repo=None, token_helper=None, review_db_container=None,
                                  output_dir=self.root, mirror_root=self.root / "mirrors", memory_dir=memory)
        linker = Mock(prs={1: merge}, unresolved_revert_commits=0)
        linker.analyze.return_value = None
        linker.direct_reverts.return_value = []
        with patch.object(ledger, "GitHub") as gh, patch.object(ledger, "Linker", return_value=linker), \
                patch.object(ledger, "ensure_mirror"), patch.object(ledger, "ensure_commit"), \
                contextlib.redirect_stdout(io.StringIO()):
            gh.return_value.repos.return_value = ["Org/app"]
            gh.return_value.merged.return_value = [merge]
            gh.return_value.default_branches = {"Org/app": "main"}
            self.assertEqual(ledger.run(args), 0)
        # Freeze only the synthetic snapshot clock so this contract stays
        # deterministic on future test dates. No real measurement is published.
        rows = [json.loads(line) for line in self.source.read_text().splitlines()]
        rows[0]["generated_at"] = ledger.stamp(self.now)
        self.source.write_text("".join(json.dumps(r) + "\n" for r in rows))
        rc, data = self.run_cli()
        self.assertEqual(rc, 0)
        self.assertEqual(data["quality"]["n"], 1)
        self.assertEqual(data["quality"]["stage_waits"]["pr_open_to_merge"]["p50_seconds"], 3600)

    def test_runtime_spool_is_git_ignored(self):
        checkout = Path(__file__).resolve().parents[2]
        for name in ("quality-scoreboard.json", "owner-inbox-line.txt", ".quality-scoreboard.lock"):
            result = subprocess.run(["git", "check-ignore", "--quiet", "ops/kpi/" + name],
                                    cwd=checkout, capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, name)

    def test_snapshot_resource_bound(self):
        with patch.object(scoreboard, "MAX_BYTES", 10):
            rc, data = self.run_cli()
        self.assertEqual(data["error"]["code"], "INVALID_SNAPSHOT")
        self.assertEqual(rc, 2)

    def test_scheduler_runs_even_after_collector_failure_and_uses_isolated_imports(self):
        unit = Path(__file__).with_name("escape-ledger.service").read_text()
        self.assertIn("ExecStopPost=/usr/bin/python3 -I", unit)
        self.assertIn("/dora_scoreboard.py", unit)
        self.assertNotIn("SuccessExitStatus=", unit)
        self.assertNotIn("ExecStartPost=", unit)
        ambient = self.root / "ambient"
        ambient.mkdir()
        (ambient / "json.py").write_text("raise RuntimeError('ambient-import')")
        result = subprocess.run(["python3", "-I", str(Path(__file__).with_name("dora_scoreboard.py")),
                                 "--ledger", str(self.source), "--dry-run", "--now", ledger.stamp(self.now)],
                                cwd=ambient, env=dict(os.environ, PYTHONPATH=str(ambient)),
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["quality"]["n"], 2)


if __name__ == "__main__":
    unittest.main()
