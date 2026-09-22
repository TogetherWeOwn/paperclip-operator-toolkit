#!/usr/bin/env python3
from __future__ import annotations

import datetime as dt
import hashlib
import importlib.util
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BROKER = ROOT / "host-ops" / "broker.py"
SPEC = importlib.util.spec_from_file_location("host_ops_broker", BROKER)
assert SPEC and SPEC.loader
broker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(broker)

AGENT = "7179efed-7baa-48e4-a7c9-06be4a9fbbab"
RUN = "534a1628-ea71-4beb-bdf2-50e29f40ab74"
ISSUE = "87d6469c-6cdb-4073-b47e-ea135515967d"
EXPECTED_READ_EXECUTORS = {
    "health.inspect": "health",
    "service.inspect": "service",
    "image.inspect": "image",
    "host.inspect": "host",
    "tooling.locate": "locate",
    "tooling.fingerprint": "fingerprint",
    "paperclip.stat-chain": "stat_chain",
}
EXPECTED_WRITE_VERBS = {
    "paperclip.deploy", "paperclip.restart",
    "plugin.install", "plugin.restart", "unit.install",
    "cliproxy.apply", "coolify.env.set", "script.run",
}
# TOG-3555 Phase-1 write verbs take names and SHAs only -- never host paths,
# commands, URLs, or secrets. Each entry here is the valid argument set used by
# the dry-run and refusal tests.
WRITE_ARGUMENTS = {
    "paperclip.deploy": {"commit": "1" * 40},
    "paperclip.restart": {},
    "plugin.install": {"package": "dispatch-src", "sha": "1" * 40},
    "plugin.restart": {"package": "dispatch-src"},
    "unit.install": {"name": "paperclip-host-ops-broker", "sha": "2" * 40},
    "cliproxy.apply": {"sha": "3" * 40},
    "coolify.env.set": {"app": "paperclip", "keys": "FOO,BAR"},
    "script.run": {"script": "quota_brake", "sha": "4" * 40},
}
PHASE1_WRITE_VERBS = {
    "plugin.install", "plugin.restart", "unit.install",
    "cliproxy.apply", "coolify.env.set", "script.run",
}
EXPECTED_RESULT_KEYS = {
    "health.inspect": {"status", "commit"},
    "service.inspect": {"ActiveState", "SubState", "MainPID", "ExecMainStartTimestampMonotonic"},
    "image.inspect": {"Id", "Digest", "RepoTags", "Created", "Size"},
    "host.inspect": {"hostname", "kernel", "uptimeSeconds", "loadAverage", "paperclipFilesystem"},
    "tooling.locate": {"candidates", "truncated"},
    "tooling.fingerprint": {"root", "files"},
    "paperclip.stat-chain": {"chain"},
}


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode()


class BrokerTest(unittest.TestCase):
    def setUp(self):
        self.temp = Path(tempfile.mkdtemp(prefix="host-ops-test."))
        self.spool = self.temp / "spool"
        self.state = self.temp / "state"
        self.audit = self.temp / "audit" / "audit.jsonl"
        self.facts = self.temp / "facts"
        self.facts.mkdir()
        self.tooling = self.temp / "tooling"
        self.tooling.mkdir()
        tool = self.tooling / "probe.sh"
        tool.write_text("#!/bin/sh\nprintf tested\\n")
        tool.chmod(0o755)
        self.private_key = self.temp / "response-signing.pem"
        self.public_key = self.temp / "response-signing.pub.pem"
        subprocess.run([
            "openssl", "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048",
            "-out", str(self.private_key),
        ], check=True, capture_output=True)
        subprocess.run(["openssl", "pkey", "-in", str(self.private_key), "-pubout", "-out", str(self.public_key)], check=True, capture_output=True)
        self.public_key_hash = hashlib.sha256(self.public_key.read_bytes()).hexdigest()
        self.config = {
            "version": 1,
            "spoolPath": str(self.spool),
            "statePath": str(self.state),
            "auditPath": str(self.audit),
            "privateKeyPath": str(self.private_key),
            "healthUrl": "http://127.0.0.1:3100/api/health",
            "paperclipHostUser": "ubuntu",
            "paperclipHostUid": 1000,
            "paperclipDataPath": str(self.temp),
            "paperclipImageRef": "localhost/paperclip-local:tog-516v2-51ee6c01b",
            "opsToolingPath": str(self.tooling),
            "toolingSearchRoots": [str(self.temp)],
            "toolingMarkers": ["probe.sh", "tool_drift.sh"],
            "pollSeconds": 2,
            "testMode": True,
            "writesEnabled": False,
        }
        self.config_path = self.temp / "config.json"
        self.config_path.write_text(json.dumps(self.config))
        fixtures = {
            "health": {"status": "ok", "commit": "1" * 40},
            "service": {"ActiveState": "active", "SubState": "running", "MainPID": "123", "ExecMainStartTimestampMonotonic": "456"},
            "image": {"Id": "sha256:" + "2" * 64, "Digest": None, "RepoTags": ["localhost/paperclip-local:latest"], "Created": None, "Size": None},
            "host": {"hostname": "host.example", "kernel": "6.8.0", "uptimeSeconds": 1234, "loadAverage": [0.1, 0.2, 0.3], "paperclipFilesystem": {"total": 1000, "used": 400, "free": 600}},
            "locate": {"candidates": [{"path": "/opt/paperclip-ops-tooling", "markers": ["probe.sh", "tool_drift.sh"]}], "truncated": False},
            "fingerprint": {"root": "/opt/paperclip-ops-tooling", "files": [{"path": "probe.sh", "sha256": "3" * 64, "size": 20}]},
            "stat_chain": {"chain": [{"path": "/home/ubuntu/.local/share/paperclip", "uid": 1000, "gid": 1000, "mode": "0755", "type": "directory"}]},
        }
        for name, payload in fixtures.items():
            (self.facts / f"{name}.json").write_text(json.dumps(payload))
        self.old_env = os.environ.copy()
        os.environ.update({"HOST_OPS_TEST_MODE": "1", "HOST_OPS_FAKE_FACTS_DIR": str(self.facts)})

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.old_env)
        shutil.rmtree(self.temp)

    def make_request(self, verb="health.inspect", request_id="HRQ-TEST001", ttl=300, age=0, arguments=None):
        requested = dt.datetime.now(dt.timezone.utc).replace(microsecond=0) - dt.timedelta(seconds=age)
        request = {
            "version": 1,
            "requestId": request_id,
            "requestedAt": broker.iso(requested),
            "expiresAt": broker.iso(requested + dt.timedelta(seconds=ttl)),
            "verb": verb,
            "arguments": {} if arguments is None else arguments,
            "requester": {"agentId": AGENT, "runId": RUN, "issueId": ISSUE},
        }
        request["canonicalHash"] = hashlib.sha256(canonical(request)).hexdigest()
        return request

    def enqueue(self, request, suffix="request"):
        directory = self.spool / "requests"
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"{request['requestId']}.{suffix}.json"
        path.write_bytes(canonical(request))
        return path

    def run_once(self):
        self.private_key.chmod(0o600)
        completed = subprocess.run(
            [sys.executable, str(BROKER), "run-once", "--config", str(self.config_path)],
            env=os.environ, text=True, capture_output=True,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return completed

    def outputs(self, kind):
        return sorted((self.spool / kind).glob("*.bundle/*.json"))

    def read_json(self, path):
        return json.loads(path.read_text())

    def verify_signed(self, path):
        sig = path.with_suffix(".sig")
        completed = subprocess.run([
            sys.executable, str(BROKER), "verify", "--public-key", str(self.public_key),
            "--expected-key-sha256", self.public_key_hash, "--response", str(path), "--signature", str(sig),
        ], text=True, capture_output=True)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout)

    def test_literal_authority_surface_is_pinned(self):
        self.assertEqual(set(broker.READ_VERBS), set(EXPECTED_READ_EXECUTORS))
        self.assertEqual(set(broker.WRITE_VERB_SPECS), EXPECTED_WRITE_VERBS)
        self.assertTrue(set(broker.READ_VERBS).isdisjoint(broker.WRITE_VERB_SPECS))
        self.assertEqual(
            {verb: spec["executor"] for verb, spec in broker.READ_VERBS.items()},
            EXPECTED_READ_EXECUTORS,
        )
        self.assertEqual(set(broker.EXECUTORS), set(EXPECTED_READ_EXECUTORS.values()))

    def test_every_literal_read_verb_requests_previews_executes_and_verifies(self):
        for index, verb in enumerate(EXPECTED_READ_EXECUTORS, 1):
            with self.subTest(verb=verb):
                self.enqueue(self.make_request(verb, f"HRQ-READ{index:03d}"), suffix=str(index))
        self.run_once()
        self.assertEqual(len(self.outputs("previews")), len(EXPECTED_READ_EXECUTORS))
        responses = self.outputs("responses")
        self.assertEqual(len(responses), len(EXPECTED_READ_EXECUTORS))
        by_verb = {}
        for response_path in responses:
            response = self.verify_signed(response_path)
            self.assertEqual(response["status"], "succeeded")
            self.assertEqual(response["code"], "ok")
            self.assertEqual(response["audit"]["entryHash"].__len__(), 64)
            by_verb[response["verb"]] = response
        self.assertEqual(set(by_verb), set(EXPECTED_READ_EXECUTORS))
        for verb, expected_keys in EXPECTED_RESULT_KEYS.items():
            with self.subTest(result=verb):
                self.assertEqual(set(by_verb[verb]["result"]), expected_keys)
        previews = [self.verify_signed(path) for path in self.outputs("previews")]
        self.assertEqual({item["verb"] for item in previews}, set(EXPECTED_READ_EXECUTORS))
        self.assertTrue(all(item["executorRendered"] for item in previews))
        self.assertTrue(all(item["writes"] == [] for item in previews))
        self.assertNotIn("must-not-escape", json.dumps([self.read_json(p) for p in responses]))

    def test_unknown_and_argument_bearing_requests_are_refused(self):
        self.enqueue(self.make_request("shell.run", "HRQ-UNKNOWN1"), "unknown")
        self.enqueue(self.make_request("health.inspect", "HRQ-ARGS001", arguments={"url": "http://evil"}), "args")
        self.run_once()
        codes = {self.read_json(path)["code"] for path in self.outputs("responses")}
        self.assertEqual(codes, {"unknown_verb", "invalid_arguments"})
        self.assertEqual(self.outputs("previews"), [])

    def test_expiry_and_long_ttl_are_refused(self):
        self.enqueue(self.make_request("health.inspect", "HRQ-EXPIRED", ttl=60, age=120), "expired")
        self.enqueue(self.make_request("health.inspect", "HRQ-LONGTTL", ttl=601), "long")
        self.run_once()
        codes = {self.read_json(path)["code"] for path in self.outputs("responses")}
        self.assertEqual(codes, {"expired", "ttl_too_long"})
        with sqlite3.connect(self.state / "state.sqlite3") as db:
            self.assertEqual(db.execute("select count(*) from used_requests where request_id='HRQ-EXPIRED'").fetchone()[0], 0)

    def test_replay_is_refused_even_after_success(self):
        request = self.make_request("health.inspect", "HRQ-REPLAY1")
        self.enqueue(request, "first")
        self.run_once()
        self.enqueue(request, "second")
        self.run_once()
        responses = [self.read_json(path) for path in self.outputs("responses")]
        self.assertEqual([item["status"] for item in responses].count("succeeded"), 1)
        self.assertEqual([item["code"] for item in responses].count("replay"), 1)
        with sqlite3.connect(self.state / "state.sqlite3") as db:
            self.assertEqual(db.execute("select count(*) from used_requests where request_id='HRQ-REPLAY1'").fetchone()[0], 1)

    def test_retained_claim_resumes_instead_of_becoming_replay(self):
        request = self.make_request("health.inspect", "HRQ-RESUME1")
        claimed = self.spool / "processing" / "retained-claim.json"
        claimed.parent.mkdir(parents=True)
        claimed.write_bytes(canonical(request))
        replay = broker.ReplayStore(self.state / "state.sqlite3")
        self.assertEqual(replay.reserve(request["requestId"], request["canonicalHash"], claimed.name), "new")
        replay.db.close()

        self.run_once()
        responses = [self.read_json(path) for path in self.outputs("responses")]
        self.assertEqual(len(responses), 1)
        self.assertEqual(responses[0]["status"], "succeeded")
        self.assertNotEqual(responses[0]["code"], "replay")
        self.assertFalse(claimed.exists())
        with sqlite3.connect(self.state / "state.sqlite3") as db:
            self.assertEqual(db.execute("select final_status from used_requests where request_id='HRQ-RESUME1'").fetchone()[0], "succeeded")

    def test_legacy_pending_reservation_is_adopted_by_retained_claim(self):
        request = self.make_request("health.inspect", "HRQ-LEGACY1")
        claimed = self.spool / "processing" / "legacy-claim.json"
        claimed.parent.mkdir(parents=True)
        claimed.write_bytes(canonical(request))
        replay = broker.ReplayStore(self.state / "state.sqlite3")
        with replay.db:
            replay.db.execute(
                "INSERT INTO used_requests(request_id, canonical_hash, claim_id, accepted_at) VALUES(?,?,NULL,?)",
                (request["requestId"], request["canonicalHash"], broker.iso(broker.now_utc())),
            )
        replay.db.close()

        self.run_once()
        response = self.read_json(self.outputs("responses")[0])
        self.assertEqual(response["status"], "succeeded")
        self.assertNotEqual(response["code"], "replay")
        with sqlite3.connect(self.state / "state.sqlite3") as db:
            claim_id, status = db.execute(
                "select claim_id, final_status from used_requests where request_id='HRQ-LEGACY1'"
            ).fetchone()
        self.assertEqual((claim_id, status), (claimed.name, "succeeded"))

    def test_completed_retained_claim_is_cleaned_without_second_terminal_response(self):
        request = self.make_request("health.inspect", "HRQ-COMPLETE1")
        claimed = self.spool / "processing" / "completed-claim.json"
        claimed.parent.mkdir(parents=True)
        claimed.write_bytes(canonical(request))
        replay = broker.ReplayStore(self.state / "state.sqlite3")
        self.assertEqual(replay.reserve(request["requestId"], request["canonicalHash"], claimed.name), "new")
        replay.finish(request["requestId"], "succeeded")
        replay.db.close()

        self.run_once()
        self.assertEqual(self.outputs("responses"), [])
        self.assertFalse(claimed.exists())

    def test_corrupt_existing_terminal_bundle_preserves_claim_and_fails_closed(self):
        request = self.make_request("health.inspect", "HRQ-CORRUPT1")
        claimed = self.spool / "processing" / "corrupt-terminal-claim.json"
        claimed.parent.mkdir(parents=True)
        claimed.write_bytes(canonical(request))
        replay = broker.ReplayStore(self.state / "state.sqlite3")
        self.assertEqual(replay.reserve(request["requestId"], request["canonicalHash"], claimed.name), "new")
        replay.db.close()
        basename = f"{request['requestId']}.{request['canonicalHash'][:12]}"
        response, _ = broker.persist_signed(self.spool / "responses", basename, {"corrupt": True}, self.private_key)
        response.write_bytes(b"tampered\n")

        with self.assertRaises(broker.FatalStateError):
            broker.Broker(self.config).run_once()
        self.assertTrue(claimed.exists())
        with sqlite3.connect(self.state / "state.sqlite3") as db:
            self.assertIsNone(db.execute("select final_status from used_requests where request_id='HRQ-CORRUPT1'").fetchone()[0])

    def test_post_response_crash_finishes_from_existing_signed_terminal_bundle(self):
        request = self.make_request("health.inspect", "HRQ-POSTRESP")
        claimed = self.spool / "processing" / "post-response-claim.json"
        claimed.parent.mkdir(parents=True)
        claimed.write_bytes(canonical(request))
        replay = broker.ReplayStore(self.state / "state.sqlite3")
        self.assertEqual(replay.reserve(request["requestId"], request["canonicalHash"], claimed.name), "new")
        replay.db.close()
        audit = broker.AuditLog(self.audit, self.state / "audit-head.json")
        result = {"status": "ok", "commit": "1" * 40}
        execution_audit = audit.append("execution.succeeded", {
            "requestId": request["requestId"], "canonicalHash": request["canonicalHash"],
            "verb": request["verb"], "resultHash": broker.sha256_bytes(canonical(result)),
            "writesPerformed": 0, "credentialEnteredRequesterProcess": False,
        })
        response = broker.Broker(self.config)._final_response(
            request, "succeeded", "ok", "fixed read-only verb completed", result, execution_audit,
        )
        basename = f"{request['requestId']}.{request['canonicalHash'][:12]}"
        broker.persist_signed(self.spool / "responses", basename, response, self.private_key)

        self.run_once()
        responses = [self.read_json(path) for path in self.outputs("responses")]
        self.assertEqual(len(responses), 1)
        self.assertEqual(responses[0]["status"], "succeeded")
        self.assertFalse(claimed.exists())
        with sqlite3.connect(self.state / "state.sqlite3") as db:
            self.assertEqual(db.execute("select final_status from used_requests where request_id='HRQ-POSTRESP'").fetchone()[0], "succeeded")

    def test_multiple_same_batch_replays_each_receive_signed_refusal(self):
        request = self.make_request("health.inspect", "HRQ-MULTIREPLAY")
        for index in range(4):
            self.enqueue(request, f"duplicate-{index}")
        self.run_once()
        responses = [self.read_json(path) for path in self.outputs("responses")]
        self.assertEqual(len(responses), 4)
        self.assertEqual([item["status"] for item in responses].count("succeeded"), 1)
        self.assertEqual([item["code"] for item in responses].count("replay"), 3)
        for path in self.outputs("responses"):
            self.verify_signed(path)

    def test_oversized_request_refuses_before_reading_payload(self):
        directory = self.spool / "requests"
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / "HRQ-HUGE001.json"
        with path.open("wb") as handle:
            handle.truncate(512 * 1024 * 1024)
        self.run_once()
        response = self.read_json(self.outputs("responses")[0])
        self.assertEqual(response["code"], "request_too_large")

    def test_bounded_reader_refuses_fifo_without_blocking(self):
        path = self.temp / "request.fifo"
        os.mkfifo(path)
        with self.assertRaises(broker.Refusal) as raised:
            broker.read_bounded_regular(path)
        self.assertEqual(raised.exception.code, "invalid_spool_entry")

    def test_bounded_reader_refuses_symlink_to_regular_file(self):
        target = self.temp / "request.json"
        target.write_text("{}")
        path = self.temp / "request-link.json"
        path.symlink_to(target)
        with self.assertRaises(broker.Refusal) as raised:
            broker.read_bounded_regular(path)
        self.assertEqual(raised.exception.code, "invalid_spool_entry")

    def test_bounded_reader_uses_open_descriptor_after_path_replacement(self):
        path = self.temp / "request.json"
        path.write_bytes(b"original")
        real_open = broker.os.open
        replacement = self.temp / "replacement.json"

        def swap_after_open(open_path, flags, *args):
            fd = real_open(open_path, flags, *args)
            if Path(open_path) == path:
                replacement.write_bytes(b"replacement")
                os.replace(replacement, path)
            return fd

        broker.os.open = swap_after_open
        try:
            self.assertEqual(broker.read_bounded_regular(path), b"original")
        finally:
            broker.os.open = real_open
        self.assertEqual(path.read_bytes(), b"replacement")

    def test_process_file_claims_before_read_and_preserves_replacement(self):
        first = self.make_request("health.inspect", "HRQ-CLAIM01")
        second = self.make_request("host.inspect", "HRQ-CLAIM02")
        path = self.enqueue(first, "claim")
        second_bytes = canonical(second)
        host_broker = broker.Broker(self.config)
        real_open = broker.os.open

        def publish_replacement_after_open(open_path, flags, *args):
            fd = real_open(open_path, flags, *args)
            if Path(open_path).parent == host_broker.processing:
                path.write_bytes(second_bytes)
            return fd

        broker.os.open = publish_replacement_after_open
        try:
            host_broker.process_file(path)
        finally:
            broker.os.open = real_open

        self.assertEqual(path.read_bytes(), second_bytes)
        self.assertEqual(list(host_broker.processing.glob("*.json")), [])
        self.assertEqual(len(self.outputs("responses")), 1)
        host_broker.run_once()
        responses = [self.read_json(output) for output in self.outputs("responses")]
        self.assertEqual({response["requestId"] for response in responses}, {"HRQ-CLAIM01", "HRQ-CLAIM02"})
        self.assertFalse(path.exists())

    def test_canonical_hash_tamper_is_refused(self):
        request = self.make_request("health.inspect", "HRQ-TAMPER1")
        request["verb"] = "host.inspect"
        self.enqueue(request, "tamper")
        self.run_once()
        response = self.read_json(self.outputs("responses")[0])
        self.assertEqual(response["code"], "canonical_hash_mismatch")

    def test_write_specs_are_typed_inverse_complete_and_not_executable(self):
        described = subprocess.run([sys.executable, str(BROKER), "describe-verbs"], check=True, text=True, capture_output=True)
        payload = json.loads(described.stdout)
        self.assertNotEqual(set(payload["readVerbs"]), set())
        for name, spec in payload["writeVerbSpecifications"].items():
            with self.subTest(name=name):
                self.assertFalse(spec["enabled"])
                self.assertFalse(spec["authorization"]["agentApprovalAllowed"])
                self.assertEqual(spec["authorization"]["technicalKey"], "board_or_human")
                self.assertTrue(spec["authorization"]["singleUse"])
                self.assertTrue(spec["rollback"]["automatic"])
                self.assertTrue(spec["rollback"]["operation"])
                self.assertTrue(spec["preImage"])
                self.assertTrue(spec["postconditions"])
                self.assertGreater(spec["timeoutSeconds"], 0)
        for name in PHASE1_WRITE_VERBS:
            with self.subTest(verb=name):
                spec = payload["writeVerbSpecifications"][name]
                self.assertIn("O4", spec["authorization"]["blockedBy"])
                self.assertTrue(spec["plannedWrites"])
                self.assertTrue(spec["allowList"])
                self.assertIn("summary", spec)
        # Phase-1 writes render a signed dry-run preview, then the O4 gate
        # refuses: no executor runs, no host write happens.
        for index, verb in enumerate(sorted(EXPECTED_WRITE_VERBS), 1):
            request = self.make_request(verb, f"HRQ-WRITE{index:02d}", arguments=WRITE_ARGUMENTS[verb])
            self.enqueue(request, f"write-{index}")
        self.run_once()
        responses = [self.verify_signed(path) for path in self.outputs("responses")]
        self.assertEqual({response["verb"] for response in responses}, EXPECTED_WRITE_VERBS)
        self.assertTrue(all(response["status"] == "refused" for response in responses))
        self.assertTrue(all(response["code"] == "write_execution_disabled" for response in responses))
        previews = [self.verify_signed(path) for path in self.outputs("previews")]
        self.assertEqual({item["verb"] for item in previews}, PHASE1_WRITE_VERBS)
        for item in previews:
            with self.subTest(preview=item["verb"]):
                self.assertEqual(item["effectClass"], "write_dry_run")
                self.assertTrue(item["executorRendered"])
                self.assertTrue(item["dryRun"])
                self.assertFalse(item["executed"])
                self.assertTrue(item["writes"])
                self.assertFalse(item["credentialsExposedToRequester"])

    def test_write_requests_with_bad_arguments_are_refused_before_preview(self):
        bad_shapes = [
            ("plugin.install", {}),
            ("plugin.install", {"package": "dispatch-src", "sha": "not-a-sha"}),
            ("plugin.install", {"package": "../escape", "sha": "1" * 40}),
            ("coolify.env.set", {"app": "paperclip", "keys": "FOO", "secret": "must-not-transit"}),
            ("script.run", {"script": "quota_brake", "sha": "1" * 40, "command": "rm -rf /"}),
        ]
        for index, (verb, arguments) in enumerate(bad_shapes, 1):
            self.enqueue(self.make_request(verb, f"HRQ-BADW{index:02d}", arguments=arguments), f"bad-{index}")
        self.run_once()
        responses = [self.read_json(path) for path in self.outputs("responses")]
        self.assertEqual({response["code"] for response in responses}, {"invalid_arguments"})
        self.assertEqual(self.outputs("previews"), [])

    def test_writes_enabled_defaults_false_and_must_be_boolean(self):
        config = dict(self.config)
        del config["writesEnabled"]
        minimal = self.temp / "minimal-config.json"
        minimal.write_text(json.dumps(config))
        loaded = broker.load_config(minimal)
        self.assertFalse(loaded["writesEnabled"])
        config["writesEnabled"] = "yes"
        minimal.write_text(json.dumps(config))
        with self.assertRaises(broker.Refusal) as raised:
            broker.load_config(minimal)
        self.assertEqual(raised.exception.code, "unsafe_config")

    def test_concurrent_run_once_processes_serialize_audit_and_process_each_request_once(self):
        total = 80
        for index in range(total):
            verb = tuple(EXPECTED_READ_EXECUTORS)[index % len(EXPECTED_READ_EXECUTORS)]
            self.enqueue(self.make_request(verb, f"HRQ-CONCURRENT{index:03d}"), str(index))

        processes = [
            subprocess.Popen(
                [sys.executable, str(BROKER), "run-once", "--config", str(self.config_path)],
                env=os.environ,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            for _ in range(4)
        ]
        results = [process.communicate(timeout=60) for process in processes]
        processed_counts = []
        for process, (stdout, stderr) in zip(processes, results):
            self.assertEqual(process.returncode, 0, stderr)
            processed_counts.append(json.loads(stdout)["processed"])
        self.assertEqual(sum(processed_counts), total)

        responses = [self.read_json(path) for path in self.outputs("responses")]
        previews = [self.read_json(path) for path in self.outputs("previews")]
        self.assertEqual(len(responses), total)
        self.assertEqual(len(previews), total)
        self.assertEqual({response["requestId"] for response in responses}, {f"HRQ-CONCURRENT{index:03d}" for index in range(total)})
        self.assertTrue(all(response["status"] == "succeeded" for response in responses))
        restarted = broker.Broker(self.config)
        with restarted._exclusive_run():
            audit, replay = restarted._require_state()
            self.assertEqual(audit.sequence, total * 3)
            self.assertEqual(replay.db.execute("select count(*) from used_requests").fetchone()[0], total)

    def test_audit_chain_detects_mutation(self):
        self.enqueue(self.make_request("health.inspect", "HRQ-AUDIT01"), "audit")
        self.run_once()
        log = broker.AuditLog(self.audit, self.state / "audit-head.json")
        self.assertGreaterEqual(log.sequence, 3)
        lines = self.audit.read_text().splitlines()
        row = json.loads(lines[0])
        row["details"]["verb"] = "tampered"
        lines[0] = json.dumps(row, sort_keys=True, separators=(",", ":"))
        self.audit.write_text("\n".join(lines) + "\n")
        with self.assertRaises(broker.Refusal) as raised:
            broker.AuditLog(self.audit, self.state / "audit-head.json")
        self.assertEqual(raised.exception.code, "audit_corrupt")

    def test_audit_chain_head_detects_complete_tail_truncation(self):
        self.enqueue(self.make_request("health.inspect", "HRQ-AUDIT02"), "audit-tail")
        self.run_once()
        checkpoint = self.state / "audit-head.json"
        chain_head = self.read_json(checkpoint)
        lines = self.audit.read_bytes().splitlines(keepends=True)
        self.assertEqual(chain_head["sequence"], len(lines))
        self.assertGreater(chain_head["sequence"], 1)
        self.audit.write_bytes(b"".join(lines[:-1]))

        with self.assertRaises(broker.Refusal) as raised:
            broker.Broker(self.config).run_once()
        self.assertEqual(raised.exception.code, "audit_corrupt")
        self.assertEqual(self.read_json(checkpoint), chain_head)

    def test_audit_pending_checkpoint_recovers_before_or_after_durable_append(self):
        checkpoint = self.state / "audit-head.json"
        log = broker.AuditLog(self.audit, checkpoint)
        record = {
            "version": 1,
            "sequence": 1,
            "at": broker.iso(broker.now_utc()),
            "event": "test.first",
            "previousHash": "0" * 64,
            "details": {},
        }
        record["entryHash"] = broker.sha256_bytes(broker.canonical_bytes(record))
        log._write_checkpoint(0, "0" * 64, record)

        restarted = broker.AuditLog(self.audit, checkpoint)
        self.assertEqual((restarted.sequence, restarted.previous_hash), (1, record["entryHash"]))
        self.assertEqual(self.audit.read_bytes(), broker.canonical_bytes(record))
        self.assertEqual(self.read_json(checkpoint)["state"], "committed")

        log._write_checkpoint(1, record["entryHash"], {
            **record,
            "sequence": 2,
            "previousHash": record["entryHash"],
            "event": "test.second",
        })
        pending = self.read_json(checkpoint)["record"]
        pending["entryHash"] = broker.sha256_bytes(broker.canonical_bytes({key: value for key, value in pending.items() if key != "entryHash"}))
        log._write_checkpoint(1, record["entryHash"], pending)
        with self.audit.open("ab") as handle:
            handle.write(broker.canonical_bytes(pending))
            handle.flush()
            os.fsync(handle.fileno())
        restarted = broker.AuditLog(self.audit, checkpoint)
        self.assertEqual((restarted.sequence, restarted.previous_hash), (2, pending["entryHash"]))

    def test_missing_or_reset_audit_checkpoint_refuses_nonempty_chain(self):
        checkpoint = self.state / "audit-head.json"
        log = broker.AuditLog(self.audit, checkpoint)
        first = log.append("test.first", {})
        checkpoint.unlink()
        with self.assertRaises(broker.Refusal) as raised:
            broker.AuditLog(self.audit, checkpoint)
        self.assertEqual(raised.exception.code, "audit_corrupt")

        broker.atomic_write(
            checkpoint,
            broker.canonical_bytes({"version": 1, "state": "committed", "sequence": 0, "entryHash": "0" * 64}),
            mode=0o600,
        )
        with self.assertRaises(broker.Refusal) as raised:
            broker.AuditLog(self.audit, checkpoint)
        self.assertEqual(raised.exception.code, "audit_corrupt")
        self.assertEqual(first["sequence"], 1)

    def test_checkpoint_publication_failure_does_not_reuse_sequence(self):
        checkpoint = self.state / "audit-head.json"
        log = broker.AuditLog(self.audit, checkpoint)
        real_write = log._write_checkpoint
        calls = 0

        def fail_commit(sequence, entry_hash, pending_record=None):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("injected committed-checkpoint failure")
            return real_write(sequence, entry_hash, pending_record)

        log._write_checkpoint = fail_commit
        with self.assertRaises(OSError):
            log.append("test.first", {})
        second = log.append("test.second", {})
        rows = [json.loads(line) for line in self.audit.read_text().splitlines()]
        self.assertEqual([row["sequence"] for row in rows], [1, 2])
        self.assertEqual(second["previousHash"], rows[0]["entryHash"])
        broker.AuditLog(self.audit, checkpoint)

    def test_malformed_audit_checkpoint_refuses_startup(self):
        checkpoint = self.state / "audit-head.json"
        checkpoint.parent.mkdir(parents=True, exist_ok=True)
        checkpoint.write_text('{"version":1,"sequence":true,"entryHash":"' + "0" * 64 + '"}\n')

        with self.assertRaises(broker.Refusal) as raised:
            broker.AuditLog(self.audit, checkpoint)
        self.assertEqual(raised.exception.code, "audit_corrupt")

    def test_signature_requires_independent_public_key_pin(self):
        self.enqueue(self.make_request("health.inspect", "HRQ-SIGNED01"), "signed")
        self.run_once()
        path = self.outputs("responses")[0]
        bad = subprocess.run([
            sys.executable, str(BROKER), "verify", "--public-key", str(self.public_key),
            "--expected-key-sha256", "0" * 64, "--response", str(path), "--signature", str(path.with_suffix('.sig')),
        ], text=True, capture_output=True)
        self.assertEqual(bad.returncode, 2)
        self.assertIn("independently pinned", bad.stderr)

    def test_verify_uses_captured_response_bytes_after_path_replacement(self):
        payload = {"signed": True}
        path, signature = broker.persist_signed(self.spool / "responses", "replacement", payload, self.private_key)
        real_read = broker.read_bounded_regular
        replacement = self.temp / "attacker.json"
        replacement.write_bytes(canonical({"attackerControlled": True}))

        def swap_after_response_read(read_path, maximum=65536, code="invalid_spool_entry"):
            captured = real_read(read_path, maximum, code)
            if Path(read_path) == path:
                os.replace(replacement, path)
            return captured

        broker.read_bounded_regular = swap_after_response_read
        try:
            args = type("Args", (), {
                "public_key": str(self.public_key), "expected_key_sha256": self.public_key_hash,
                "response": str(path), "signature": str(signature),
            })()
            output = tempfile.TemporaryFile(mode="w+")
            old_stdout = sys.stdout
            sys.stdout = output
            try:
                self.assertEqual(broker.command_verify(args), 0)
            finally:
                sys.stdout = old_stdout
            output.seek(0)
            self.assertEqual(json.load(output), payload)
            output.close()
        finally:
            broker.read_bounded_regular = real_read
        self.assertEqual(self.read_json(path), {"attackerControlled": True})

    def test_verify_refuses_fifo_and_symlink_inputs_without_blocking(self):
        fifo = self.temp / "response.fifo"
        os.mkfifo(fifo)
        symlink = self.temp / "public-link.pem"
        symlink.symlink_to(self.public_key)
        signature = self.temp / "response.sig"
        signature.write_bytes(b"not-a-signature")
        for public_key, response, expected in (
            (symlink, self.temp / "missing.json", "invalid_public_key"),
            (self.public_key, fifo, "invalid_response"),
        ):
            with self.subTest(expected=expected):
                args = type("Args", (), {
                    "public_key": str(public_key), "expected_key_sha256": self.public_key_hash,
                    "response": str(response), "signature": str(signature),
                })()
                with self.assertRaises(broker.Refusal) as raised:
                    broker.command_verify(args)
                self.assertEqual(raised.exception.code, expected)

    def test_signed_publication_keeps_staging_private_until_rename(self):
        directory = self.spool / "responses"
        directory.mkdir(parents=True)
        directory.chmod(0o2750)
        observed = {}
        real_publish = broker.publish_directory_noreplace

        def inspect_before_publish(staging, bundle, published_mode):
            observed["before"] = staging.stat().st_mode & 0o777
            observed["stagingParentMode"] = staging.parent.stat().st_mode & 0o777
            observed["separateParent"] = staging.parent != bundle.parent
            real_rename = broker.rename_noreplace

            def inspect_at_publication(source, target):
                observed["atPublication"] = Path(source).stat().st_mode & 0o777
                real_rename(source, target)

            broker.rename_noreplace = inspect_at_publication
            try:
                real_publish(staging, bundle, published_mode)
            finally:
                broker.rename_noreplace = real_rename
            observed["after"] = bundle.stat().st_mode & 0o777

        broker.publish_directory_noreplace = inspect_before_publish
        try:
            path, signature = broker.persist_signed(directory, "private-staging", {"payload": True}, self.private_key)
        finally:
            broker.publish_directory_noreplace = real_publish
        self.assertEqual(observed, {
            "before": 0o700, "stagingParentMode": 0o700, "separateParent": True,
            "atPublication": 0o750, "after": 0o750,
        })
        self.assertTrue(path.exists())
        self.assertTrue(signature.exists())

    def test_signed_publication_never_exposes_json_without_signature(self):
        directory = self.spool / "responses"
        real_sign = broker.sign_file

        def fail_signing(private_key, path, output):
            raise broker.Refusal("signing_failed", "injected")

        broker.sign_file = fail_signing
        try:
            with self.assertRaises(broker.Refusal):
                broker.persist_signed(directory, "sign-failure", {"payload": True}, self.private_key)
        finally:
            broker.sign_file = real_sign
        self.assertFalse((directory / "sign-failure.bundle").exists())
        self.assertEqual(list(directory.glob(".sign-failure.*")), [])

    def test_health_accepts_supported_optional_fields_and_rejects_unknowns(self):
        supported = {"status": "ok", "commit": "1" * 40, "version": "1.2.3", "uptime": 123.5}
        self.assertEqual(broker.validate_result("health.inspect", supported), supported)
        with self.assertRaises(broker.Refusal) as raised:
            broker.validate_result("health.inspect", {**supported, "secret": "must-not-escape"})
        self.assertEqual(raised.exception.code, "invalid_health")
        for field, value in (("version", 42), ("uptime", "123"), ("uptime", True), ("uptime", -1)):
            with self.subTest(field=field, value=value):
                malformed = {**supported, field: value}
                with self.assertRaises(broker.Refusal) as raised:
                    broker.validate_result("health.inspect", malformed)
                self.assertEqual(raised.exception.code, "invalid_health")

    def test_health_executor_preserves_malformed_known_optional_for_validation(self):
        (self.facts / "health.json").write_text(json.dumps({
            "status": "ok", "commit": "1" * 40, "version": 42, "secret": "must-not-escape",
        }))
        result = broker.execute_health(self.config)
        self.assertEqual(result, {"status": "ok", "commit": "1" * 40, "version": 42})
        with self.assertRaises(broker.Refusal) as raised:
            broker.validate_result("health.inspect", result)
        self.assertEqual(raised.exception.code, "invalid_health")

    def test_incomplete_executor_facts_are_signed_refusals_not_success(self):
        invalid = {
            "health": {},
            "service": {},
            "image": {"Id": None, "Digest": None, "RepoTags": None, "Created": None, "Size": None},
        }
        for index, (fact, payload) in enumerate(invalid.items(), 1):
            with self.subTest(fact=fact):
                (self.facts / f"{fact}.json").write_text(json.dumps(payload))
                verb = {"health": "health.inspect", "service": "service.inspect", "image": "image.inspect"}[fact]
                self.enqueue(self.make_request(verb, f"HRQ-INVALID{index:02d}"), fact)
        self.run_once()
        responses = [self.verify_signed(path) for path in self.outputs("responses")]
        self.assertTrue(all(response["status"] == "refused" for response in responses))
        self.assertEqual({response["code"] for response in responses}, {"invalid_health", "invalid_service", "invalid_image"})

    def test_claim_fsyncs_source_and_processing_directories(self):
        request = self.make_request("health.inspect", "HRQ-FSYNC01")
        path = self.enqueue(request, "fsync")
        synced = []
        real_fsync_directory = broker.fsync_directory

        def capture(directory):
            synced.append(Path(directory))
            real_fsync_directory(directory)

        broker.fsync_directory = capture
        try:
            broker.Broker(self.config).process_file(path)
        finally:
            broker.fsync_directory = real_fsync_directory
        self.assertIn(self.spool / "requests", synced)
        self.assertIn(self.spool / "processing", synced)

    def test_acceptance_validates_configured_signer_and_actual_signature_contract(self):
        args = type("Args", (), {"config": str(self.config_path)})()
        output = tempfile.TemporaryFile(mode="w+")
        old_stdout = sys.stdout
        sys.stdout = output
        try:
            self.assertEqual(broker.command_acceptance(args), 0)
        finally:
            sys.stdout = old_stdout
        output.seek(0)
        self.assertEqual(json.load(output)["signing"], "ok")
        output.close()

        unsupported = self.temp / "ed25519.pem"
        subprocess.run(["openssl", "genpkey", "-algorithm", "ED25519", "-out", str(unsupported)], check=True, capture_output=True)
        unsupported.chmod(0o600)
        self.config["privateKeyPath"] = str(unsupported)
        self.config_path.write_text(json.dumps(self.config))
        with self.assertRaises(broker.Refusal) as raised:
            broker.command_acceptance(args)
        self.assertEqual(raised.exception.code, "invalid_signing_key")

        unsupported_ec = self.temp / "ec.pem"
        subprocess.run([
            "openssl", "genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", str(unsupported_ec),
        ], check=True, capture_output=True)
        unsupported_ec.chmod(0o600)
        self.config["privateKeyPath"] = str(unsupported_ec)
        self.config_path.write_text(json.dumps(self.config))
        with self.assertRaises(broker.Refusal) as raised:
            broker.command_acceptance(args)
        self.assertEqual(raised.exception.code, "invalid_signing_key")

        self.config["privateKeyPath"] = str(self.temp / "missing.pem")
        self.config_path.write_text(json.dumps(self.config))
        with self.assertRaises(broker.Refusal) as raised:
            broker.command_acceptance(args)
        self.assertEqual(raised.exception.code, "invalid_signing_key")

    def test_signing_key_rejects_undersized_rsa(self):
        for bits in (512, 1024):
            with self.subTest(bits=bits):
                key = self.temp / f"rsa-{bits}.pem"
                subprocess.run([
                    "openssl", "genpkey", "-algorithm", "RSA", "-pkeyopt", f"rsa_keygen_bits:{bits}",
                    "-out", str(key),
                ], check=True, capture_output=True)
                key.chmod(0o600)
                with self.assertRaises(broker.Refusal) as raised:
                    broker.validate_signing_key(key)
                self.assertEqual(raised.exception.code, "invalid_signing_key")
                self.assertIn("at least 2048 bits", str(raised.exception))

    def test_image_ref_is_config_driven_and_pinned_to_the_deployed_sudoers(self):
        # TOG-757: the host's image reference is host state, not source state, so
        # image.inspect reads it from root-owned config. That alone would let a
        # config edit change which image the broker attests, so a non-test-mode
        # start re-derives the reference from the readable sudoers mirror and
        # refuses on disagreement. The unit separately binds that mirror to the
        # protected deployed grant before the unprivileged check runs.
        executed = []

        def capture_run_fixed(command, timeout=20):
            executed.append(command)
            return json.dumps({"Id": "sha256:" + "4" * 64, "Digest": None, "RepoTags": [], "Created": None, "Size": None})

        real_run_fixed = broker.run_fixed
        old_fake_dir = os.environ.pop("HOST_OPS_FAKE_FACTS_DIR", None)
        broker.run_fixed = capture_run_fixed
        try:
            config = dict(self.config, paperclipImageRef="ghcr.io/paperclipai/paperclip@sha256:" + "f" * 64)
            broker.execute_image(config)
            self.assertIn(config["paperclipImageRef"], executed[0])
            self.assertNotIn("paperclip-local", " ".join(executed[0]))

            for bad in ("paperclip-local --format {{json .}}, /bin/sh", "paperclip local", "", "-local"):
                with self.subTest(bad=bad):
                    with self.assertRaises(broker.Refusal) as raised:
                        broker.execute_image(dict(self.config, paperclipImageRef=bad))
                    self.assertEqual(raised.exception.code, "unsafe_config")
        finally:
            broker.run_fixed = real_run_fixed
            if old_fake_dir is not None:
                os.environ["HOST_OPS_FAKE_FACTS_DIR"] = old_fake_dir

        # TOG-1126: read the grant back the way the INSTALLER writes it. sudoers
        # reads a bare colon as the run-as separator, so install.sh escapes each
        # one as "\:" and sudo strips the escape before matching argv. Rendering
        # the placeholder raw here would assert a file the installer can never
        # produce -- visudo rejects it -- and would hide a broker that compared
        # the escaped bytes to the plain config value and refused every tag and
        # digest reference. Both forms are checked; both carry a colon.
        for granted in (
            "localhost/paperclip-local:tog-516v2-51ee6c01b",
            "ghcr.io/paperclipai/paperclip@sha256:" + "f" * 64,
            "paperclip-local",
        ):
            with self.subTest(granted=granted):
                installed = (ROOT / "host-ops" / "host-ops-broker.sudoers").read_text().replace(
                    "@@PAPERCLIP_IMAGE_REF@@", granted.replace(":", "\\:")
                )
                self.assertEqual(broker.sudoers_granted_image_ref(installed), granted)

        granted = "localhost/paperclip-local:tog-516v2-51ee6c01b"
        rendered = (ROOT / "host-ops" / "host-ops-broker.sudoers").read_text().replace(
            "@@PAPERCLIP_IMAGE_REF@@", granted.replace(":", "\\:")
        )
        self.assertEqual(broker.sudoers_granted_image_ref(rendered), granted)
        # A config naming any other image must not be startable against this grant.
        with self.assertRaises(broker.Refusal) as raised:
            if broker.sudoers_granted_image_ref(rendered) != "ghcr.io/paperclipai/paperclip:v1":
                raise broker.Refusal("unsafe_config", "drifted")
        self.assertEqual(raised.exception.code, "unsafe_config")
        # Zero or duplicate grants must refuse rather than let the broker choose.
        for text in (rendered.replace("podman image inspect", "podman image list"), rendered + rendered):
            with self.subTest(text=text[:40]):
                with self.assertRaises(broker.Refusal):
                    broker.sudoers_granted_image_ref(text)

    def test_unit_deliberately_omits_incompatible_namespace_filter(self):
        # TOG-1126: rootless Podman enters its pause user namespace with
        # setns(fd, 0). systemd's RestrictNamespaces seccomp filter rejects that
        # call unless every namespace type is allowed, which is no restriction.
        service_source = (ROOT / "host-ops" / "host-ops-broker.service").read_text()
        active_directives = [
            line for line in service_source.splitlines()
            if re.match(r"^\s*RestrictNamespaces\s*=", line)
        ]
        self.assertEqual(active_directives, [])
        self.assertIn("RestrictNamespaces is intentionally omitted", service_source)
        self.assertIn("setns(fd, 0)", service_source)

    def test_acceptance_requires_each_service_and_image_contract(self):
        args = type("Args", (), {"config": str(self.config_path)})()
        self.private_key.chmod(0o600)
        cases = (
            ("service", {}, "invalid_service"),
            ("image", {"Id": None, "Digest": None, "RepoTags": None, "Created": None, "Size": None}, "invalid_image"),
        )
        for fact, payload, code in cases:
            with self.subTest(fact=fact):
                original = (self.facts / f"{fact}.json").read_text()
                (self.facts / f"{fact}.json").write_text(json.dumps(payload))
                try:
                    with self.assertRaises(broker.Refusal) as raised:
                        broker.command_acceptance(args)
                    self.assertEqual(raised.exception.code, code)
                finally:
                    (self.facts / f"{fact}.json").write_text(original)

    def test_production_config_rejects_alternate_signing_path(self):
        self.config["testMode"] = False
        self.config["privateKeyPath"] = "/root/alternate-signing.pem"
        self.config_path.write_text(json.dumps(self.config))
        with self.assertRaises(broker.Refusal) as raised:
            broker.load_config(self.config_path)
        self.assertEqual(raised.exception.code, "unsafe_config")

    def test_fake_fact_seam_fails_closed_outside_test_mode(self):
        self.config["testMode"] = False
        self.config["privateKeyPath"] = "/var/lib/paperclip-host-ops/keys/response-signing.pem"
        self.config_path.write_text(json.dumps(self.config))
        old_fake_dir = os.environ.get("HOST_OPS_FAKE_FACTS_DIR")
        try:
            with self.assertRaises(broker.Refusal) as raised:
                broker.fake_fact(self.config, "health")
        finally:
            if old_fake_dir is not None:
                os.environ["HOST_OPS_FAKE_FACTS_DIR"] = old_fake_dir
        self.assertEqual(raised.exception.code, "test_seam_refused")

    def test_spool_directory_poison_is_refused_without_crashing(self):
        poison = self.spool / "requests" / "HRQ-POISON1.json"
        poison.mkdir(parents=True)
        completed = self.run_once()
        self.assertEqual(json.loads(completed.stdout)["processed"], 1)
        response = self.read_json(self.outputs("responses")[0])
        self.assertEqual(response["code"], "invalid_spool_entry")
        self.assertFalse(poison.exists())

    def test_request_cli_publishes_atomically_with_group_readable_mode(self):
        marker = self.temp / "request-ready-before-publish"
        environment = os.environ.copy()
        environment["HOST_OPS_TEST_BEFORE_PUBLISH_MARKER"] = str(marker)
        previous = os.umask(0o077)
        try:
            requester = subprocess.Popen([
                sys.executable, str(BROKER), "request", "--spool", str(self.spool),
                "--verb", "health.inspect", "--request-id", "HRQ-ATOMIC1",
                "--agent-id", AGENT, "--run-id", RUN, "--issue-id", ISSUE,
            ], env=environment, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        finally:
            os.umask(previous)

        deadline = dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=10)
        while not marker.exists() and dt.datetime.now(dt.timezone.utc) < deadline:
            import time
            time.sleep(0.01)
        self.assertTrue(marker.exists(), "request CLI did not reach the pre-publication pause")
        request_dir = self.spool / "requests"
        self.assertEqual(list(request_dir.glob("*.json")), [])
        temporary_paths = list(request_dir.glob(".*"))
        self.assertEqual(len(temporary_paths), 1)
        self.assertEqual(temporary_paths[0].stat().st_mode & 0o777, 0o640)

        concurrent = self.run_once()
        self.assertEqual(json.loads(concurrent.stdout), {"processed": 0})
        self.assertEqual(self.outputs("responses"), [])

        marker.with_name(f"{marker.name}.release").touch()
        stdout, stderr = requester.communicate(timeout=10)
        self.assertEqual(requester.returncode, 0, stderr)
        request_path = Path(json.loads(stdout)["requestPath"])
        self.assertEqual(request_path.stat().st_mode & 0o777, 0o640)

        completed = self.run_once()
        self.assertEqual(json.loads(completed.stdout), {"processed": 1})
        responses = self.outputs("responses")
        self.assertEqual(len(responses), 1)
        self.assertEqual(self.verify_signed(responses[0])["status"], "succeeded")
        self.assertEqual(list(request_dir.glob("*.json")), [])

        duplicate = subprocess.run([
            sys.executable, str(BROKER), "request", "--spool", str(self.spool),
            "--verb", "health.inspect", "--request-id", "HRQ-DUPLICATE",
            "--agent-id", AGENT, "--run-id", RUN, "--issue-id", ISSUE,
        ], text=True, capture_output=True)
        self.assertEqual(duplicate.returncode, 0, duplicate.stderr)
        duplicate_path = Path(json.loads(duplicate.stdout)["requestPath"])
        original = duplicate_path.read_bytes()
        with self.assertRaises(FileExistsError):
            broker.atomic_write(duplicate_path, b"replacement\n", mode=0o640, exclusive=True)
        self.assertEqual(duplicate_path.read_bytes(), original)

    def test_request_cli_accepts_no_path_shell_or_auth_arguments(self):
        help_text = subprocess.run([sys.executable, str(BROKER), "request", "--help"], check=True, text=True, capture_output=True).stdout
        for forbidden in ("--path", "--command", "--shell", "--token", "--approval", "--url", "--package", "--sha", "--script", "--unit", "--app", "--keys"):
            self.assertNotIn(forbidden, help_text)
        request_id = "HRQ-CLI0001"
        completed = subprocess.run([
            sys.executable, str(BROKER), "request", "--spool", str(self.spool), "--verb", "health.inspect",
            "--request-id", request_id, "--agent-id", AGENT, "--run-id", RUN, "--issue-id", ISSUE,
        ], text=True, capture_output=True)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        request_path = Path(json.loads(completed.stdout)["requestPath"])
        request = self.read_json(request_path)
        self.assertEqual(request["arguments"], {})
        self.assertEqual(broker.validate_request(request)[0]["requestId"], request_id)

    def test_request_cli_write_arguments_are_one_json_object(self):
        completed = subprocess.run([
            sys.executable, str(BROKER), "request", "--spool", str(self.spool), "--verb", "plugin.install",
            "--arguments-json", json.dumps(WRITE_ARGUMENTS["plugin.install"]),
            "--request-id", "HRQ-CLIW001", "--agent-id", AGENT, "--run-id", RUN, "--issue-id", ISSUE,
        ], text=True, capture_output=True)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        request = self.read_json(Path(json.loads(completed.stdout)["requestPath"]))
        self.assertEqual(request["arguments"], WRITE_ARGUMENTS["plugin.install"])
        refused = subprocess.run([
            sys.executable, str(BROKER), "request", "--spool", str(self.spool), "--verb", "plugin.install",
            "--arguments-json", json.dumps({"package": "dispatch-src"}),
            "--request-id", "HRQ-CLIW002", "--agent-id", AGENT, "--run-id", RUN, "--issue-id", ISSUE,
        ], text=True, capture_output=True)
        self.assertEqual(refused.returncode, 2)
        extra = subprocess.run([
            sys.executable, str(BROKER), "request", "--spool", str(self.spool), "--verb", "health.inspect",
            "--arguments-json", json.dumps({"url": "http://evil"}),
            "--request-id", "HRQ-CLIW003", "--agent-id", AGENT, "--run-id", RUN, "--issue-id", ISSUE,
        ], text=True, capture_output=True)
        self.assertEqual(extra.returncode, 2)

    def test_runbook_documents_atomic_bundle_paths(self):
        runbook = (ROOT / "host-ops" / "RUNBOOK.md").read_text()
        self.assertIn("bundle=/path/to/previews/HRQ-....bundle", runbook)
        self.assertIn('base=${base%.bundle}', runbook)
        self.assertIn('--response "$bundle/$base.json"', runbook)
        self.assertIn('--signature "$bundle/$base.sig"', runbook)
        self.assertIn("atomic publication unit", runbook)
        for stale in ("previews/*.json", "responses/*.json", "/previews/HRQ-....json"):
            self.assertNotIn(stale, runbook)

    def test_runbook_documents_phase1_dry_run_gate(self):
        runbook = (ROOT / "host-ops" / "RUNBOOK.md").read_text()
        self.assertIn("--arguments-json", runbook)
        self.assertIn("write_dry_run", runbook)
        self.assertIn("writesEnabled: false", runbook)
        self.assertIn("OWNER decision O4", runbook)
        self.assertIn("no executor runs and no host write happens", runbook)

    def test_runbook_requires_live_host_evidence_for_rootless_podman_compatibility(self):
        runbook = (ROOT / "host-ops" / "RUNBOOK.md").read_text()
        self.assertIn("`RestrictNamespaces=` is deliberately absent", runbook)
        self.assertIn("A green CI", runbook)
        self.assertIn("not installation evidence", runbook)
        self.assertIn("unprivileged acceptance check passed", runbook)
        self.assertIn("service remained active", runbook)

    def test_installer_export_ignores_git_replacement_objects(self):
        repository = self.temp / "replacement-repo"
        repository.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=repository, check=True)
        subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=repository, check=True)
        subprocess.run(["git", "config", "user.name", "Host Ops Test"], cwd=repository, check=True)
        host_ops = repository / "host-ops"
        host_ops.mkdir()
        marker = host_ops / "broker.py"
        marker.write_text("reviewed\n")
        subprocess.run(["git", "add", "host-ops/broker.py"], cwd=repository, check=True)
        subprocess.run(["git", "commit", "-qm", "reviewed"], cwd=repository, check=True)
        reviewed = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repository, check=True, text=True, capture_output=True).stdout.strip()
        marker.write_text("attacker\n")
        subprocess.run(["git", "commit", "-qam", "attacker"], cwd=repository, check=True)
        attacker = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repository, check=True, text=True, capture_output=True).stdout.strip()
        subprocess.run(["git", "replace", reviewed, attacker], cwd=repository, check=True)

        ordinary = subprocess.run(["git", "archive", reviewed, "host-ops"], cwd=repository, check=True, capture_output=True).stdout
        protected = subprocess.run(["git", "--no-replace-objects", "archive", reviewed, "host-ops"], cwd=repository, check=True, capture_output=True).stdout
        import io
        import tarfile
        with tarfile.open(fileobj=io.BytesIO(ordinary)) as archive:
            self.assertEqual(archive.extractfile("host-ops/broker.py").read(), b"attacker\n")
        with tarfile.open(fileobj=io.BytesIO(protected)) as archive:
            self.assertEqual(archive.extractfile("host-ops/broker.py").read(), b"reviewed\n")

    def test_installer_requires_source_ref_to_name_commit_object_directly(self):
        repository = self.temp / "tag-object-repo"
        repository.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=repository, check=True)
        subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=repository, check=True)
        subprocess.run(["git", "config", "user.name", "Host Ops Test"], cwd=repository, check=True)
        marker = repository / "marker"
        marker.write_text("reviewed\n")
        subprocess.run(["git", "add", "marker"], cwd=repository, check=True)
        subprocess.run(["git", "commit", "-qm", "reviewed"], cwd=repository, check=True)
        commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repository, check=True, text=True, capture_output=True).stdout.strip()
        subprocess.run(["git", "tag", "-a", "reviewed-tag", "-m", "reviewed"], cwd=repository, check=True)
        tag_object = subprocess.run(["git", "rev-parse", "reviewed-tag"], cwd=repository, check=True, text=True, capture_output=True).stdout.strip()
        self.assertEqual(len(commit), 40)
        self.assertEqual(len(tag_object), 40)
        self.assertEqual(subprocess.run(["git", "--no-replace-objects", "cat-file", "-t", commit], cwd=repository, check=True, text=True, capture_output=True).stdout.strip(), "commit")
        self.assertEqual(subprocess.run(["git", "--no-replace-objects", "cat-file", "-t", tag_object], cwd=repository, check=True, text=True, capture_output=True).stdout.strip(), "tag")

    def test_install_service_tmpfiles_and_sudoers_contracts_are_consistent(self):
        install_source = (ROOT / "host-ops" / "install.sh").read_text()
        service_source = (ROOT / "host-ops" / "host-ops-broker.service").read_text()
        tmpfiles_source = (ROOT / "host-ops" / "host-ops-broker.tmpfiles").read_text()
        sudoers_source = (ROOT / "host-ops" / "host-ops-broker.sudoers").read_text()
        example_config_path = ROOT / "host-ops" / "config.example.json"
        # The shipped example carries the same placeholder as the sudoers
        # template; install.sh renders both from one --paperclip-image-ref. Render
        # it here the way the installer does so the rest of this contract check
        # reads a config the broker would actually accept.
        rendered_example = json.loads(
            example_config_path.read_text().replace("@@PAPERCLIP_IMAGE_REF@@", self.config["paperclipImageRef"])
        )
        self.assertEqual(rendered_example["paperclipImageRef"], self.config["paperclipImageRef"])
        rendered_example_path = self.temp / "rendered-example-config.json"
        rendered_example["testMode"] = True
        rendered_example_path.write_text(json.dumps(rendered_example))
        example_config = broker.load_config(rendered_example_path)

        exec_start = re.search(r"^ExecStart=(\S+) run --config (\S+)$", service_source, re.MULTILINE)
        self.assertIsNotNone(exec_start)
        executable, config_path = exec_start.groups()
        unit_path = "/etc/systemd/system/paperclip-host-ops-broker.service"
        self.assertIn(f'"$SOURCE_DIR/broker.py" {executable}', install_source)
        self.assertIn(f'"$SOURCE_DIR/host-ops-broker.service" {unit_path}', install_source)
        # config.json is no longer copied straight from the reviewed example: the
        # installer renders --paperclip-image-ref into it (preserving an existing
        # operator config) and installs that. It must still land at the exact path
        # the unit reads, and must still be seeded from the reviewed example.
        self.assertIn(f'install -o root -g paperclip-host-reader -m 0640 "$CONFIG_TMP" {config_path}', install_source)
        self.assertIn('cp "$SOURCE_DIR/config.example.json" "$CONFIG_TMP"', install_source)
        self.assertIn('git --no-replace-objects archive --format=tar "$SOURCE_REF" host-ops', install_source)
        self.assertIn('source_type=$(git --no-replace-objects cat-file -t "$SOURCE_REF"', install_source)
        self.assertIn('[[ "$source_type" == commit ]]', install_source)
        self.assertIn('git --no-replace-objects cat-file -e "$SOURCE_REF:host-ops/broker.py"', install_source)
        self.assertNotIn("git diff --quiet -- host-ops", install_source)
        self.assertIn("systemctl enable paperclip-host-ops-broker.service", install_source)
        self.assertIn("systemctl restart paperclip-host-ops-broker.service", install_source)
        self.assertIn("systemctl is-active --quiet paperclip-host-ops-broker.service", install_source)

        service_user = re.search(r"^User=(\S+)$", service_source, re.MULTILINE).group(1)
        service_group = re.search(r"^Group=(\S+)$", service_source, re.MULTILINE).group(1)
        install_lib_source = (ROOT / "host-ops" / "install-lib.sh").read_text()
        self.assertIn(f"useradd --system --gid {service_group}", install_source)
        self.assertIn(f"--home-dir {example_config['statePath']} --shell /usr/sbin/nologin {service_user}", install_source)
        self.assertIn('identity_state=$(classify_service_identity)', install_source)
        for validation in (
            "must be a system account", "credentials must be locked", "primary group is incompatible",
            "home is incompatible", "shell is incompatible", "has unintended supplemental groups",
            "must contain only paperclip-host-reader", "private and public keys do not match",
            "RSA key must be at least 2048 bits",
        ):
            self.assertIn(validation, install_lib_source)
        self.assertIn('openssl pkey -in "$private_key" -check -noout', install_lib_source)
        self.assertIn('openssl pkey -in "$private_key" -pubout', install_lib_source)
        self.assertIn('openssl pkey -pubin -in "$public_key" -outform DER', install_lib_source)
        syntax_source = (ROOT / ".github" / "workflows" / "ci.yml").read_text()
        self.assertRegex(syntax_source, r'for f in [^\n]*host-ops/\*\.sh; do bash -n "\$f"')

        exec_start_pre = re.search(r"^ExecStartPre=(\S+) acceptance-check --config (\S+)$", service_source, re.MULTILINE)
        self.assertIsNotNone(exec_start_pre)
        self.assertEqual(exec_start_pre.groups(), (executable, config_path))
        # TOG-1126: sudo ignores a grant unless it remains root:root 0440, so the
        # service user cannot read that authority file directly. Bind a readable
        # mirror to it with one root-only cmp, but keep acceptance-check and the
        # long-running daemon unprefixed so both exercise the service user's real
        # exact-command sudo grant rather than root bypassing it.
        protected_sudoers = "/etc/sudoers.d/paperclip-host-ops-broker"
        sudoers_mirror = "/etc/paperclip-host-ops/sudoers.rendered"
        self.assertIn(
            f"ExecStartPre=+/usr/bin/cmp --silent {protected_sudoers} {sudoers_mirror}",
            service_source,
        )
        self.assertIn(
            f'install -o root -g root -m 0440 "$SUDOERS_TMP" {protected_sudoers}',
            install_source,
        )
        self.assertIn(
            f'install -o root -g {service_group} -m 0640 "$SUDOERS_TMP" {sudoers_mirror}',
            install_source,
        )
        self.assertEqual(broker.DEPLOYED_SUDOERS_MIRROR_PATH, sudoers_mirror)
        self.assertNotIn(f"ExecStartPre=+{executable} acceptance-check", service_source)
        self.assertNotIn(f"ExecStart=+{executable} run", service_source)
        tmpfiles_rows = {}
        for line in tmpfiles_source.splitlines():
            if line.startswith("d "):
                _, path, mode, owner, group, _ = line.split()
                tmpfiles_rows[path] = (mode, owner, group)
        for path in (
            example_config["statePath"],
            str(Path(example_config["statePath"]) / "keys"),
            str(Path(example_config["spoolPath"]) / ".staging"),
            str(Path(example_config["spoolPath"]) / "processing"),
            str(Path(example_config["spoolPath"]) / "quarantine"),
            str(Path(example_config["auditPath"]).parent),
        ):
            with self.subTest(tmpfiles_identity=path):
                self.assertEqual(tmpfiles_rows[path][1:], (service_user, service_group))
        self.assertIn(example_config["spoolPath"], tmpfiles_rows)
        self.assertIn(str(Path(example_config["spoolPath"]) / "requests"), tmpfiles_rows)

        # Rootless Podman mutates runtime and storage lock state even for image
        # inspect. Sudo changes identity but not this unit's mount namespace, so
        # pin the complete writable authority set while preserving both strict
        # filesystem protections. Iterating every directive is important: a
        # first-line-only check would miss an appended broad writable path.
        expected_hardening = {
            "NoNewPrivileges=no",
            "PrivateTmp=yes",
            "PrivateDevices=yes",
            "ProtectSystem=strict",
            "ProtectHome=read-only",
            "ProtectKernelTunables=yes",
            "ProtectKernelModules=yes",
            "ProtectKernelLogs=yes",
            "ProtectControlGroups=yes",
            "LockPersonality=yes",
            "MemoryDenyWriteExecute=yes",
            "MemoryMax=256M",
            "TasksMax=32",
            "RestrictSUIDSGID=yes",
            "RestrictRealtime=yes",
            "SystemCallArchitectures=native",
            "UMask=0027",
        }
        self.assertTrue(expected_hardening.issubset(set(service_source.splitlines())))
        self.assertNotRegex(service_source, r"(?m)^\s*RestrictNamespaces\s*=")
        self.assertNotRegex(service_source, r"(?m)^\s*(ReadWriteDirectories|BindPaths)\s*=")
        writable_paths = {
            path
            for line in service_source.splitlines()
            if line.startswith("ReadWritePaths=")
            for path in line.removeprefix("ReadWritePaths=").split()
        }
        self.assertEqual(
            writable_paths,
            {
                example_config["statePath"],
                str(Path(example_config["auditPath"]).parent),
                example_config["spoolPath"],
                "/run/user/1000",
                "/home/ubuntu/.local/share/containers",
            },
        )
        for broad_path in ("/", "/home", "/home/ubuntu", "/run/user"):
            self.assertNotIn(broad_path, writable_paths)
        readonly_paths = set(re.search(r"^ReadOnlyPaths=(.*)$", service_source, re.MULTILINE).group(1).split())
        self.assertIn(str(Path(config_path).parent), readonly_paths)
        self.assertIn(str(Path(executable).parent), readonly_paths)
        self.assertIn(example_config["paperclipDataPath"], readonly_paths)
        self.assertTrue(Path(example_config["privateKeyPath"]).is_relative_to(example_config["statePath"]))

        sudoers_binding = re.search(
            r"^(\S+) ALL=\((\S+)\) NOPASSWD: PAPERCLIP_HOST_READS$",
            sudoers_source,
            re.MULTILINE,
        )
        self.assertIsNotNone(sudoers_binding)
        sudoers_grantee, sudoers_run_as = sudoers_binding.groups()
        self.assertEqual(sudoers_grantee, service_user)
        self.assertEqual(sudoers_run_as, example_config["paperclipHostUser"])

        # The image reference is host state rendered by install.sh, so the shipped
        # template carries the placeholder rather than any one host's image. The
        # rendered-vs-config agreement is asserted separately below and in
        # test_host_ops_install.sh.
        expected_sudoers_commands = {
            "/usr/bin/env XDG_RUNTIME_DIR=/run/user/1000 /usr/bin/systemctl --user show paperclip.service --no-pager --property=ActiveState\\,SubState\\,MainPID\\,ExecMainStartTimestampMonotonic",
            "/usr/bin/env XDG_RUNTIME_DIR=/run/user/1000 /usr/bin/podman image inspect @@PAPERCLIP_IMAGE_REF@@ --format {{json .}}",
        }
        command_lines = re.search(r"Cmnd_Alias PAPERCLIP_HOST_READS = \\\n(.*?)\n\n", sudoers_source, re.DOTALL).group(1)
        actual_sudoers_commands = {
            line.strip().removesuffix(" \\").removesuffix(",")
            for line in command_lines.splitlines()
            if line.strip()
        }
        self.assertEqual(actual_sudoers_commands, expected_sudoers_commands)
        executed_commands = []
        real_run_fixed = broker.run_fixed

        def capture_run_fixed(command, timeout=20):
            executed_commands.append(command)
            if "/usr/bin/systemctl" in command:
                return "ActiveState=active\nSubState=running\nMainPID=123\nExecMainStartTimestampMonotonic=456\nSecret=must-not-escape\n"
            return json.dumps({
                "Id": "sha256:" + "2" * 64,
                "Digest": "sha256:" + "3" * 64,
                "RepoTags": ["localhost/paperclip-local:latest"],
                "Created": "2026-08-27T00:00:00Z",
                "Size": 123,
                "Secret": "must-not-escape",
            })

        broker.run_fixed = capture_run_fixed
        old_fake_dir = os.environ.pop("HOST_OPS_FAKE_FACTS_DIR", None)
        try:
            service_result = broker.execute_service(self.config)
            image_result = broker.execute_image(self.config)
        finally:
            broker.run_fixed = real_run_fixed
            if old_fake_dir is not None:
                os.environ["HOST_OPS_FAKE_FACTS_DIR"] = old_fake_dir
        self.assertEqual(set(service_result), {"ActiveState", "SubState", "MainPID", "ExecMainStartTimestampMonotonic"})
        self.assertEqual(set(image_result), EXPECTED_RESULT_KEYS["image.inspect"])
        self.assertTrue(all(command[:4] == ["/usr/bin/sudo", "-n", "-u", sudoers_run_as] for command in executed_commands))
        actual_executor_commands = {" ".join(command[4:]) for command in executed_commands}
        self.assertEqual(
            actual_executor_commands,
            {
                command.replace("\\,", ",").replace("@@PAPERCLIP_IMAGE_REF@@", self.config["paperclipImageRef"])
                for command in expected_sudoers_commands
            },
        )

        systemd_analyze = shutil.which("systemd-analyze")
        if systemd_analyze:
            # The committed unit names the production install path, which does not
            # exist on a CI runner. Verify the same unit grammar with only that
            # already-pinned executable path replaced by a real inert binary.
            # Otherwise systemd-analyze correctly fails on the missing install,
            # before it can certify the unit directives this test owns.
            self.assertEqual(service_source.count(executable), 2)
            validation_unit = self.temp / "host-ops-broker.validation.service"
            validation_source = service_source.replace(executable, shutil.which("true") or "/bin/true")
            validation_source = validation_source.replace("/usr/bin/cmp", shutil.which("true") or "/bin/true")
            validation_unit.write_text(validation_source)
            completed = subprocess.run(
                [systemd_analyze, "verify", str(validation_unit)],
                text=True,
                capture_output=True,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
        visudo = shutil.which("visudo")
        if visudo:
            completed = subprocess.run(
                [visudo, "-cf", str(ROOT / "host-ops" / "host-ops-broker.sudoers")],
                text=True,
                capture_output=True,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
