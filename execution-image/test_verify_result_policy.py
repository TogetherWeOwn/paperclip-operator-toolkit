#!/usr/bin/env python3
import contextlib
import copy
import json
import os
import pathlib
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

import verify_result_policy as vrp

HERE = pathlib.Path(__file__).resolve().parent
DELETE = object()
REPO_URL = "https://github.com/paperclipai/paperclip"
RUN_URL = REPO_URL + "/actions/runs/" + vrp.EXPECTED["run_id"]
STMT = [0, "verificationResult", "statement"]
SUBJ = STMT + ["subject", 0]
CERT = [0, "verificationResult", "signature", "certificate"]
SUBJECT_ENTRY = {
    "name": vrp.EXPECTED["subject_name"],
    "digest": {"sha256": vrp.EXPECTED["subject_sha256"]},
}
STUB = """
import json, os, subprocess, sys, time
mode, args = sys.argv[1], sys.argv[2:]
if mode == "echo":
    sys.stdout.write(json.dumps(args))
elif mode == "stdin":
    sys.stdout.write(json.dumps({"stdin": sys.stdin.read()}))
elif mode == "size":
    sys.stdout.write("a" * int(args[0]))
elif mode == "stderr":
    sys.stderr.write("noise\\n")
    sys.stdout.write("ok\\n")
elif mode == "fail":
    sys.exit(3)
elif mode == "emit-fail":
    sys.stdout.write(args[0])
    sys.exit(1)
elif mode == "auth-fail":
    sys.stderr.write("HTTP 401: Bad credentials\\n")
    sys.exit(4)
elif mode == "nonce":
    sys.stdout.write(os.urandom(16).hex())
elif mode == "sleep":
    time.sleep(30)
elif mode == "short-sleep":
    time.sleep(2)
elif mode == "spawn":
    subprocess.Popen([sys.executable, "-c", "import sys, time; open(sys.argv[1], 'w').close(); time.sleep(float(sys.argv[3])); open(sys.argv[2], 'w').close()", args[0], args[1], args[2]])
    time.sleep(30)
"""

NEGATIVE_CASES = [
    ("media_type", [0, "verificationResult", "mediaType"], "application/json"),
    ("media_type", [0, "verificationResult", "mediaType"], "application/vnd.dev.sigstore.bundle.v0.3+json"),
    ("media_type", [0, "verificationResult", "mediaType"], "application/vnd.dev.sigstore.verificationresult+json;version=0.2"),
    ("media_type", [0, "verificationResult", "mediaType"], DELETE),
    ("result_shape", [0, "verificationResult"], DELETE),
    ("result_shape", [0], "not-an-object"),
    ("statement_shape", [0, "verificationResult", "statement"], DELETE),
    ("statement_type", STMT + ["_type"], "https://in-toto.io/Statement/v0.1"),
    ("statement_type", STMT + ["_type"], DELETE),
    ("predicate_type", STMT + ["predicateType"], "https://slsa.dev/provenance/v0.2"),
    ("predicate_type", STMT + ["predicateType"], DELETE),
    ("subject_shape", STMT + ["subject"], DELETE),
    ("subject_shape", STMT + ["subject"], vrp.EXPECTED["subject_name"]),
    ("subject_count", STMT + ["subject"], []),
    ("subject_count", STMT + ["subject"], [SUBJECT_ENTRY, SUBJECT_ENTRY]),
    ("subject_shape", SUBJ, vrp.EXPECTED["subject_name"]),
    ("subject_name", SUBJ + ["name"], "ghcr.io/paperclipai/paperclip-fork"),
    ("subject_name", SUBJ + ["name"], DELETE),
    ("subject_shape", SUBJ + ["digest"], DELETE),
    ("subject_digest", SUBJ + ["digest", "sha256"], "0" * 64),
    ("subject_digest", SUBJ + ["digest", "sha256"], DELETE),
    ("certificate_shape", [0, "verificationResult", "signature"], DELETE),
    ("certificate_shape", CERT, DELETE),
    ("issuer", CERT + ["issuer"], "https://example.invalid"),
    ("issuer", CERT + ["issuer"], DELETE),
    ("signer_identity", CERT + ["subjectAlternativeName"], REPO_URL + "/.github/workflows/docker.yml@refs/heads/feature"),
    ("signer_identity", CERT + ["subjectAlternativeName"], DELETE),
    ("build_signer", CERT + ["buildSignerURI"], REPO_URL + "/.github/workflows/other.yml@refs/heads/master"),
    ("build_signer", CERT + ["buildSignerURI"], DELETE),
    ("source_uri", CERT + ["sourceRepositoryURI"], REPO_URL + "-fork"),
    ("source_uri", CERT + ["sourceRepositoryURI"], DELETE),
    ("source_ref", CERT + ["sourceRepositoryRef"], "refs/heads/feature"),
    ("source_ref", CERT + ["sourceRepositoryRef"], DELETE),
    ("source_digest", CERT + ["sourceRepositoryDigest"], "f" * 40),
    ("source_digest", CERT + ["sourceRepositoryDigest"], DELETE),
    ("run_invocation", CERT + ["runInvocationURI"], DELETE),
    ("run_invocation", CERT + ["runInvocationURI"], RUN_URL + "/attempts/0"),
    ("run_invocation", CERT + ["runInvocationURI"], RUN_URL + "/attempts/1234567890"),
    ("run_invocation", CERT + ["runInvocationURI"], RUN_URL + "/attempts/1/extra"),
    ("run_invocation", CERT + ["runInvocationURI"], REPO_URL + "/actions/runs/1/attempts/1"),
    ("run_invocation", CERT + ["runInvocationURI"], "https://github.com/evil/paperclip/actions/runs/" + vrp.EXPECTED["run_id"] + "/attempts/1"),
    ("run_invocation", CERT + ["runInvocationURI"], 37717359076),
    ("timestamps", [0, "verificationResult", "verifiedTimestamps"], []),
    ("timestamps", [0, "verificationResult", "verifiedTimestamps"], DELETE),
    ("timestamps", [0, "verificationResult", "verifiedTimestamps"], {"type": "Tlog"}),
    ("timestamps", [0, "verificationResult", "verifiedTimestamps", 0], "Tlog"),
    ("timestamps", [0, "verificationResult", "verifiedTimestamps", 0, "uri"], DELETE),
    ("timestamps", [0, "verificationResult", "verifiedTimestamps", 0, "timestamp"], 1700000000),
    ("timestamps", [0, "verificationResult", "verifiedTimestamps", 0, "type"], ""),
    ("timestamps", [0, "verificationResult", "verifiedTimestamps", 0, "type"], DELETE),
]


def _valid_doc():
    return [
        {
            "attestation": {"bundle": {}},
            "verificationResult": {
                "mediaType": "application/vnd.dev.sigstore.verificationresult+json;version=0.1",
                "signature": {
                    "certificate": {
                        "issuer": vrp.EXPECTED["issuer"],
                        "subjectAlternativeName": vrp.EXPECTED["signer_identity"],
                        "buildSignerURI": vrp.EXPECTED["signer_identity"],
                        "sourceRepositoryURI": vrp.EXPECTED["source_uri"],
                        "sourceRepositoryRef": vrp.EXPECTED["source_ref"],
                        "sourceRepositoryDigest": vrp.EXPECTED["source_digest"],
                        "runInvocationURI": RUN_URL + "/attempts/1",
                    }
                },
                "statement": {
                    "_type": vrp.EXPECTED["statement_type"],
                    "predicateType": vrp.EXPECTED["predicate_type"],
                    "subject": [copy.deepcopy(SUBJECT_ENTRY)],
                    "predicate": {"buildDefinition": {}},
                },
                "verifiedTimestamps": [
                    {"type": "Tlog", "uri": "https://rekor.sigstore.dev", "timestamp": "2026-01-01T00:00:00Z"}
                ],
            },
        }
    ]


def _mutate(doc, path, value):
    out = copy.deepcopy(doc)
    node = out
    for key in path[:-1]:
        node = node[key]
    if value is DELETE:
        del node[path[-1]]
    else:
        node[path[-1]] = value
    return out


def _encode(doc):
    return json.dumps(doc).encode("utf-8")


class ProbeHung(Exception):
    pass


@contextlib.contextmanager
def _fails_instead_of_hanging(seconds):
    def interrupt(_signum, _frame):
        raise ProbeHung(f"no return within {seconds} s")

    previous = signal.signal(signal.SIGALRM, interrupt)
    signal.alarm(seconds)
    try:
        yield
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous)


class PolicyTests(unittest.TestCase):
    def _assert_refused(self, doc, code):
        verdict = vrp.check_bytes(_encode(doc))
        self.assertEqual(verdict["policy"], "refused")
        self.assertEqual(verdict["refusal_code"], code)
        self.assertEqual(verdict["authenticity"], "not_established")
        self.assertIs(verdict["hold_cleared"], False)

    def test_pinned_result_is_satisfied_without_authenticity(self):
        verdict = vrp.check_bytes(_encode(_valid_doc()))
        self.assertEqual(verdict["policy"], "satisfied")
        self.assertIsNone(verdict["refusal_code"])
        self.assertEqual(verdict["authenticity"], "not_established")
        self.assertIs(verdict["hold_cleared"], False)

    def test_each_field_mutation_is_refused(self):
        for code, path, value in NEGATIVE_CASES:
            with self.subTest(code=code, path=path):
                self._assert_refused(_mutate(_valid_doc(), path, value), code)

    def test_result_count_refuses_empty_multiple_and_object(self):
        result = _valid_doc()[0]
        for label, doc in (
            ("empty", []),
            ("two", [result, result]),
            ("object", result),
            ("error body", {"message": "Bad credentials"}),
        ):
            with self.subTest(label=label):
                self._assert_refused(doc, "result_count")

    def test_identity_fields_spliced_across_results_are_refused(self):
        bad_subject = _mutate(_valid_doc(), SUBJ + ["name"], "ghcr.io/paperclipai/paperclip-fork")
        bad_signer = _mutate(
            _valid_doc(), CERT + ["subjectAlternativeName"], REPO_URL + "/.github/workflows/other.yml@refs/heads/master"
        )
        self._assert_refused(bad_subject, "subject_name")
        self._assert_refused(bad_signer, "signer_identity")
        self._assert_refused(bad_subject + bad_signer, "result_count")
        self._assert_refused(bad_signer + bad_subject, "result_count")

    def test_depth_beyond_limit_is_refused(self):
        nested = []
        for _ in range(vrp.MAX_DEPTH):
            nested = [nested]
        self._assert_refused(_mutate(_valid_doc(), STMT + ["predicate"], {"deep": nested}), "too_deep")

    def test_moderate_depth_is_accepted(self):
        nested = []
        for _ in range(10):
            nested = [nested]
        verdict = vrp.check_bytes(_encode(_mutate(_valid_doc(), STMT + ["predicate"], {"deep": nested})))
        self.assertEqual(verdict["policy"], "satisfied")

    def test_node_budget_is_enforced(self):
        doc = _mutate(_valid_doc(), STMT + ["predicate"], {"items": [0] * vrp.MAX_NODES})
        self._assert_refused(doc, "too_many_nodes")

    def test_parse_refusals(self):
        valid = _encode(_valid_doc())
        cases = [
            ("duplicate_key", b'[{"verificationResult": {}, "verificationResult": {}}]'),
            ("non_finite_number", b'[{"x": NaN}]'),
            ("non_finite_number", b"[Infinity]"),
            ("non_finite_number", b"[-Infinity]"),
            ("non_finite_number", b"[1e999]"),
            ("non_finite_number", b"[-1e999]"),
            ("invalid_json", b""),
            ("invalid_json", valid[:-1]),
            ("invalid_json", valid + b" x"),
            ("invalid_json", b"\xef\xbb\xbf" + valid),
            ("invalid_encoding", b'[{"x": "\xff"}]'),
            ("input_too_large", b" " * (vrp.MAX_BYTES + 1)),
            ("too_deep", b"[" * 5000 + b"]" * 5000),
            ("invalid_json", b"401 Unauthorized"),
            ("invalid_json", b"<html>502 Bad Gateway</html>"),
        ]
        for code, raw in cases:
            with self.subTest(code=code, raw=raw[:24]):
                self.assertEqual(vrp.check_bytes(raw)["refusal_code"], code)

    def test_input_at_exact_cap_is_accepted(self):
        valid = _encode(_valid_doc())
        padded = valid + b" " * (vrp.MAX_BYTES - len(valid))
        self.assertEqual(len(padded), vrp.MAX_BYTES)
        self.assertEqual(vrp.check_bytes(padded)["policy"], "satisfied")


class ManifestBindingTests(unittest.TestCase):
    def test_expected_values_match_manifest_base(self):
        base = json.loads((HERE / "manifest.json").read_text(encoding="utf-8"))["base"]
        image_name, _, image_digest = base["image_ref"].partition("@sha256:")
        source_url = "https://github.com/" + base["source_repository"]
        self.assertEqual(image_name, vrp.EXPECTED["subject_name"])
        self.assertEqual(image_digest, vrp.EXPECTED["subject_sha256"])
        self.assertEqual(source_url, vrp.EXPECTED["source_uri"])
        self.assertEqual(base["source_ref"], vrp.EXPECTED["source_ref"])
        self.assertEqual(base["source_revision"], vrp.EXPECTED["source_digest"])
        self.assertEqual("https://github.com/" + base["signer_workflow"], vrp.EXPECTED["signer_identity"])
        self.assertEqual(base["producer_run_url"], source_url + "/actions/runs/" + vrp.EXPECTED["run_id"])


class CaptureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.python_sha256 = vrp._sha256_file(sys.executable, float("inf"))

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        cwd = os.getcwd()
        self.addCleanup(os.chdir, cwd)
        os.chdir(self.tmp)
        self.stub = os.path.join(self.tmp, "stub.py")
        with open(self.stub, "w", encoding="utf-8") as handle:
            handle.write(STUB)

    def _argv(self, *args):
        return [sys.executable, "-B", self.stub, *args]

    def _assert_capture_refused(self, argv, sha256, code, **kwargs):
        with self.assertRaises(vrp.Refusal) as caught:
            vrp.capture(argv, sha256, **kwargs)
        self.assertEqual(caught.exception.code, code)

    def test_arguments_are_passed_literally(self):
        hostile = "$(touch PWNED)"
        out = vrp.capture(self._argv("echo", "a b", hostile, "*", ";"), self.python_sha256)
        self.assertEqual(json.loads(out), ["a b", hostile, "*", ";"])
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "PWNED")))

    def test_stdin_is_empty(self):
        out = vrp.capture(self._argv("stdin"), self.python_sha256)
        self.assertEqual(json.loads(out), {"stdin": ""})

    def test_stderr_does_not_reach_stdout(self):
        self.assertEqual(vrp.capture(self._argv("stderr"), self.python_sha256), b"ok\n")

    def test_output_at_cap_is_accepted(self):
        out = vrp.capture(self._argv("size", str(vrp.MAX_BYTES)), self.python_sha256)
        self.assertEqual(len(out), vrp.MAX_BYTES)

    def test_output_over_cap_is_refused(self):
        self._assert_capture_refused(self._argv("size", str(vrp.MAX_BYTES + 1)), self.python_sha256, "output_limit")

    def test_nonzero_exit_is_refused(self):
        self._assert_capture_refused(self._argv("fail"), self.python_sha256, "exit_status")

    def test_nonzero_exit_with_valid_output_is_refused(self):
        self._assert_capture_refused(self._argv("emit-fail", json.dumps(_valid_doc())), self.python_sha256, "exit_status")

    def test_authentication_failure_is_refused(self):
        self._assert_capture_refused(self._argv("auth-fail"), self.python_sha256, "exit_status")

    def test_each_capture_is_fresh(self):
        first = vrp.capture(self._argv("nonce"), self.python_sha256)
        self.assertNotEqual(first, vrp.capture(self._argv("nonce"), self.python_sha256))

    def test_timeout_is_refused(self):
        started = time.monotonic()
        self._assert_capture_refused(self._argv("sleep"), self.python_sha256, "timeout", timeout_s=1)
        self.assertLess(time.monotonic() - started, 30)

    def test_timeout_at_cap_is_accepted(self):
        out = vrp.capture(self._argv("echo", "x"), self.python_sha256, timeout_s=vrp.CAPTURE_TIMEOUT_S)
        self.assertEqual(json.loads(out), ["x"])

    def test_timeout_kills_same_group_descendant_holding_stdout(self):
        started = os.path.join(self.tmp, "started")
        late = os.path.join(self.tmp, "late")
        self._assert_capture_refused(self._argv("spawn", started, late, "6"), self.python_sha256, "timeout", timeout_s=3)
        self.assertTrue(os.path.exists(started))
        time.sleep(5)
        self.assertFalse(os.path.exists(late))

    def test_unreadable_executable_is_refused(self):
        with mock.patch.object(vrp, "_sha256_file", side_effect=PermissionError(13, "denied")):
            self._assert_capture_refused(self._argv("echo"), self.python_sha256, "executable_path")

    def test_relative_executable_is_refused(self):
        argv = [os.path.basename(sys.executable), "-B", self.stub, "echo"]
        self._assert_capture_refused(argv, self.python_sha256, "executable_path")

    def test_missing_executable_is_refused(self):
        self._assert_capture_refused([os.path.join(self.tmp, "absent")], self.python_sha256, "executable_path")

    def test_wrong_hash_is_refused(self):
        self._assert_capture_refused(self._argv("echo"), "0" * 64, "executable_sha256")

    def test_spawn_failure_is_refused(self):
        with mock.patch.object(vrp.subprocess, "Popen", side_effect=OSError(8, "Exec format error")):
            self._assert_capture_refused(self._argv("echo"), self.python_sha256, "spawn")

    def test_fifo_at_executable_path_is_refused_without_blocking(self):
        path = os.path.join(self.tmp, "fifo-as-program")
        os.mkfifo(path, 0o700)
        with mock.patch.object(vrp.os.path, "isfile", return_value=True), _fails_instead_of_hanging(10):
            self._assert_capture_refused([path], self.python_sha256, "executable_path")

    def test_hashing_past_the_deadline_is_refused(self):
        self._assert_capture_refused(self._argv("echo"), self.python_sha256, "timeout", timeout_s=1e-6)

    def test_executable_check_counts_against_the_deadline(self):
        clock = [1000.0]

        def slow_isfile(_path):
            clock[0] += 10
            return True

        with mock.patch.object(vrp.time, "monotonic", side_effect=lambda: clock[0]), mock.patch.object(
            vrp.os.path, "isfile", side_effect=slow_isfile
        ), mock.patch.object(vrp.subprocess, "Popen", side_effect=AssertionError("spawned")):
            self._assert_capture_refused(self._argv("echo"), self.python_sha256, "timeout", timeout_s=5)

    def test_refused_kill_is_reported_as_kill_refused(self):
        with mock.patch.object(vrp.os, "killpg", side_effect=PermissionError(1, "denied")):
            self._assert_capture_refused(self._argv("short-sleep"), self.python_sha256, "kill_refused", timeout_s=1)

    def test_leader_that_survives_the_reap_bound_is_refused(self):
        spawned = []
        real_popen = subprocess.Popen

        def record(*args, **kwargs):
            proc = real_popen(*args, **kwargs)
            spawned.append(proc)
            return proc

        def reap():
            for proc in spawned:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                proc.wait()

        self.addCleanup(reap)
        with mock.patch.object(vrp, "CAPTURE_REAP_S", 0.2), mock.patch.object(
            vrp.subprocess, "Popen", side_effect=record
        ), mock.patch.object(vrp.os, "killpg", side_effect=PermissionError(1, "denied")):
            started = time.monotonic()
            self._assert_capture_refused(self._argv("sleep"), self.python_sha256, "kill_refused", timeout_s=1)
            self.assertLess(time.monotonic() - started, 10)

    def test_malformed_argv_is_refused(self):
        for argv in ("python3 -B stub.py", [], [1, 2]):
            with self.subTest(argv=argv):
                self._assert_capture_refused(argv, self.python_sha256, "argv")

    def test_environment_is_not_mutated(self):
        before = dict(os.environ)
        vrp.capture(self._argv("echo", "x"), self.python_sha256)
        self.assertEqual(dict(os.environ), before)

    def test_unencodable_argument_is_refused(self):
        for bad in ("a\0b", "\ud800"):
            with self.subTest(arg=bad):
                self._assert_capture_refused(self._argv("echo", bad), self.python_sha256, "argv")

    def test_nul_in_executable_path_is_refused(self):
        self._assert_capture_refused([sys.executable + "\0"], self.python_sha256, "executable_path")

    def test_out_of_range_timeout_is_refused_before_spawn(self):
        for bad in (0, -1, float("nan"), float("inf"), 1e300, vrp.CAPTURE_TIMEOUT_S + 1):
            with self.subTest(timeout_s=bad):
                with mock.patch.object(vrp.subprocess, "Popen", side_effect=AssertionError("spawned")):
                    self._assert_capture_refused(self._argv("echo"), self.python_sha256, "timeout", timeout_s=bad)


class IntegerLimitTests(unittest.TestCase):
    def setUp(self):
        if not hasattr(sys, "get_int_max_str_digits"):
            self.skipTest("interpreter has no integer string conversion limit")
        self.addCleanup(sys.set_int_max_str_digits, sys.get_int_max_str_digits())

    def _raw(self, digits):
        return b'[{"n": ' + b"9" * digits + b", " + _encode(_valid_doc())[2:]

    def test_4300_digit_limit_refuses_one_digit_past_it(self):
        sys.set_int_max_str_digits(4300)
        self.assertEqual(vrp.check_bytes(self._raw(4301))["refusal_code"], "invalid_json")
        self.assertIsNone(vrp.check_bytes(self._raw(4300))["refusal_code"])

    def test_lifted_limit_parses_the_same_literal(self):
        sys.set_int_max_str_digits(0)
        self.assertIsNone(vrp.check_bytes(self._raw(4301))["refusal_code"])


class CliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def _input(self, raw):
        path = os.path.join(self.tmp, "input.json")
        with open(path, "wb") as handle:
            handle.write(raw)
        return path

    def _run(self, *args):
        before = sorted(os.listdir(self.tmp))
        proc = subprocess.run(
            [sys.executable, "-B", str(HERE / "verify_result_policy.py"), *args],
            cwd=self.tmp,
            capture_output=True,
            timeout=60,
            check=False,
        )
        self.assertEqual(sorted(os.listdir(self.tmp)), before)
        return proc

    def test_satisfied_exits_zero(self):
        proc = self._run(self._input(_encode(_valid_doc())))
        self.assertEqual(proc.returncode, 0)
        report = json.loads(proc.stdout)
        self.assertEqual(report["policy"], "satisfied")
        self.assertEqual(report["authenticity"], "not_established")

    def test_refused_exits_one(self):
        doc = _mutate(_valid_doc(), [0, "verificationResult", "mediaType"], "application/json")
        proc = self._run(self._input(_encode(doc)))
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(json.loads(proc.stdout)["refusal_code"], "media_type")

    def test_usage_and_io_errors_exit_two(self):
        self.assertEqual(self._run().returncode, 2)
        self.assertEqual(self._run(os.path.join(self.tmp, "absent.json")).returncode, 2)

    def test_fifo_and_directory_inputs_exit_two_without_blocking(self):
        fifo = os.path.join(self.tmp, "fifo")
        os.mkfifo(fifo)
        self.assertEqual(self._run(fifo).returncode, 2)
        self.assertEqual(self._run(self.tmp).returncode, 2)


if __name__ == "__main__":
    unittest.main()
