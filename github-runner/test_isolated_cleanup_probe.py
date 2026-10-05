"""Offline tests for garm/post_job_cleanup.py.

Source-only: all fixtures live under tempfile job dirs carrying a
.garm-job-fixture marker. No host paths, no VMs, no network. Run from the
repo root:

python3 -B -m unittest discover -s github-runner -p 'test_isolated_cleanup_probe.py' -v
"""
import contextlib
import importlib.util
import io
import json
import os
import pathlib
import tempfile
import unittest

_HERE = pathlib.Path(__file__).resolve().parent
_SPEC = importlib.util.spec_from_file_location(
    "post_job_cleanup", str(_HERE / "garm" / "post_job_cleanup.py"))
mod = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(mod)


def make_jobdir(files=(), dirs=()):
    tmp = tempfile.mkdtemp(prefix="garm-cleanup-fixture-")
    (pathlib.Path(tmp) / mod.MARKER).write_text("synthetic-fixture\n")
    for name in dirs:
        (pathlib.Path(tmp) / name).mkdir(parents=True, exist_ok=True)
    for name in files:
        target = pathlib.Path(tmp) / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("residue\n")
    return tmp


def run_main(args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        code = mod.main(list(args))
    return code, buf.getvalue()


def healthy_doc(role="isolated-private"):
    denials = [{"name": n, "denied": True, "control_ok": True,
                "via_timeout": False}
               for n in mod.B_REQUIRED + mod.C_REQUIRED]
    return {
        "schema": mod.SCHEMA,
        "role": role,
        "job": "run-1001",
        "finish": "natural",
        "reclamation_window_elapsed": True,
        "vm": {"id": "vm-abc", "created_at": "2026-10-04T02:00:00Z",
                "dispatched_at": "2026-10-04T01:59:00Z",
                "reclaimed": True, "reclaimed_at": "2026-10-04T02:10:00Z"},
        "registration": {"deregistered": True,
                         "deregistered_at": "2026-10-04T02:05:00Z"},
        "logs": {"ref": "external-logs://run-1001"},
        "denials": denials,
        "smoke": {tool: True for tool in mod.SMOKE_REQUIRED},
    }


def write_context(doc):
    tmp = tempfile.NamedTemporaryFile(
        prefix="garm-probe-ctx-", suffix=".json",
        mode="w", delete=False, encoding="utf-8")
    json.dump(doc, tmp)
    tmp.close()
    return tmp.name


class CleanupTests(unittest.TestCase):
    def test_removes_temp_and_container_residue_keeps_logs(self):
        jobdir = make_jobdir(
            files=("tmp-scratch", "job-tmp-cache", "container-9.layer",
                   "net.sock-stub", "stale.residue", "run.log",
                   "receipt.json", "nested/deep.tmp", "nested/keep.log"))
        try:
            code, out = run_main(["cleanup", jobdir, "--job", "run-1001"])
        finally:
            pass
        self.assertEqual(code, 0)
        self.assertIn("PASS step=cleanup", out)
        remaining = [p for p in pathlib.Path(jobdir).rglob("*")
                     if p.is_file() and p.name != mod.MARKER]
        names = sorted(p.name for p in remaining)
        self.assertEqual(names, ["keep.log", "receipt.json", "run.log"])
        import shutil
        shutil.rmtree(jobdir, ignore_errors=True)

    def test_refuses_unmarked_directory(self):
        tmp = tempfile.mkdtemp(prefix="garm-unmarked-")
        try:
            code, out = run_main(["cleanup", tmp, "--job", "run-1"])
        finally:
            os.rmdir(tmp)
        self.assertEqual(code, 2)
        self.assertIn("REFUSED", out)

    def test_symlink_left_behind_is_fail(self):
        jobdir = make_jobdir(files=("run.log", "evil.tmp"))
        link = os.path.join(jobdir, "tmp-link")
        try:
            os.symlink("/etc/hostname", link)
            code, out = run_main(["cleanup", jobdir, "--job", "run-2"])
        finally:
            if os.path.islink(link):
                os.unlink(link)
        self.assertEqual(code, 1)
        self.assertIn("reason=residue-remaining", out)
        import shutil
        shutil.rmtree(jobdir, ignore_errors=True)

    def test_empty_sweep_is_logs_missing_fail(self):
        jobdir = make_jobdir()
        try:
            code, out = run_main(["cleanup", jobdir, "--job", "run-3"])
        finally:
            import shutil
            shutil.rmtree(jobdir, ignore_errors=True)
        self.assertEqual(code, 1)
        self.assertIn("reason=logs-missing", out)


class ProbeTests(unittest.TestCase):
    def probe(self, doc):
        path = write_context(doc)
        try:
            return run_main(["probe", path])
        finally:
            os.unlink(path)

    def test_healthy_isolated_passes_all_checks(self):
        code, out = self.probe(healthy_doc())
        self.assertEqual(code, 0)
        for check in ("check=A", "check=B", "check=C"):
            self.assertIn("PASS %s" % check, out)
        # Spec verdict tokens are hyphenated (review finding on be1ede6).
        self.assertIn("denied=sudo,docker-unix,docker-tcp,sibling-data", out)
        self.assertIn("denied=metadata,host-services,production", out)

    def test_allowed_denial_uses_per_check_reason(self):
        # Spec B FAIL wants reason=allowed; spec C FAIL wants reason=reachable.
        doc_b = healthy_doc()
        doc_b["denials"] = [d for d in doc_b["denials"]
                            if d["name"] != "sudo_denied"]
        code_b, out_b = self.probe(doc_b)
        self.assertEqual(code_b, 1)
        self.assertIn("check=B", out_b)
        self.assertIn("reason=allowed", out_b)
        doc_c = healthy_doc()
        doc_c["denials"] = [d for d in doc_c["denials"]
                            if d["name"] != "metadata_denied"]
        code_c, out_c = self.probe(doc_c)
        self.assertEqual(code_c, 1)
        self.assertIn("check=C", out_c)
        self.assertIn("reason=reachable", out_c)

    def test_privileged_skips_b_not_certifies_isolation(self):
        code, out = self.probe(healthy_doc(role="privileged-private"))
        self.assertEqual(code, 0)
        self.assertIn("SKIP check=B", out)
        self.assertIn("PASS check=A", out)
        self.assertIn("PASS check=C", out)

    def test_stale_vm_reused_fails_a(self):
        doc = healthy_doc()
        doc["vm"]["created_at"] = "2026-10-04T01:00:00Z"  # before dispatch
        code, out = self.probe(doc)
        self.assertEqual(code, 1)
        self.assertIn("reason=stale-vm-reused", out)

    def test_registration_present_without_reclamation_is_fail(self):
        doc = healthy_doc()
        doc["registration"]["deregistered"] = False
        code, out = self.probe(doc)
        self.assertEqual(code, 1)
        self.assertIn("reason=registration-still-present", out)

    def test_reclamation_pending_is_inconclusive_not_pass(self):
        doc = healthy_doc()
        doc["vm"]["reclaimed"] = False
        doc["reclamation_window_elapsed"] = False
        code, out = self.probe(doc)
        self.assertEqual(code, 2)
        self.assertIn("INCONCLUSIVE check=A", out)

    def test_reclaimed_absent_but_registered_is_fail(self):
        doc = healthy_doc()
        doc["vm"]["reclaimed"] = False
        doc["reclamation_window_elapsed"] = True
        code, out = self.probe(doc)
        self.assertEqual(code, 1)
        self.assertIn("reason=vm-still-present", out)

    def test_missing_control_fails(self):
        doc = healthy_doc()
        doc["denials"][0] = dict(doc["denials"][0], control_ok=False)
        code, out = self.probe(doc)
        self.assertEqual(code, 1)
        self.assertIn("reason=control-missing", out)

    def test_timeout_counted_as_deny_fails_conduct(self):
        doc = healthy_doc()
        target = [d for d in doc["denials"] if d["name"] == "metadata_denied"]
        target[0]["via_timeout"] = True
        code, out = self.probe(doc)
        self.assertEqual(code, 1)
        self.assertIn("reason=timeout-counted-as-deny", out)

    def test_broken_smoke_fails_b(self):
        doc = healthy_doc()
        doc["smoke"]["cc"] = False
        code, out = self.probe(doc)
        self.assertEqual(code, 1)
        self.assertIn("reason=smoke-broken", out)

    def test_cancelled_job_is_inconclusive(self):
        doc = healthy_doc()
        doc["finish"] = "cancelled"
        code, out = self.probe(doc)
        self.assertEqual(code, 2)
        self.assertIn("reason=non-natural-finish", out)

    def test_unknown_role_refused(self):
        doc = healthy_doc()
        doc["role"] = "some-new-role"
        code, out = self.probe(doc)
        self.assertEqual(code, 2)
        self.assertIn("REFUSED", out)

    def test_malformed_input_refused(self):
        path = tempfile.NamedTemporaryFile(
            prefix="garm-probe-bad-", suffix=".json",
            mode="w", delete=False, encoding="utf-8")
        path.write("{not json")
        path.close()
        try:
            code, out = run_main(["probe", path.name])
        finally:
            os.unlink(path.name)
        self.assertEqual(code, 2)
        self.assertIn("REFUSED", out)


if __name__ == "__main__":
    unittest.main()
