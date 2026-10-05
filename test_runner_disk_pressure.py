#!/usr/bin/env python3
"""Synthetic offline regression/control suite; never measures the real host.

Every subprocess gets a credential-free environment and absolute fake df/du.
Config, paths, dedupe snapshots, and binary logs live in disposable fixtures.
Run with python3 -B /absolute/toolkit/test_runner_disk_pressure.py -v.
--mutation-check kills a severity mutant, restoring the owned helper in finally.
"""
import copy
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
TOOL = ROOT / "runner_disk_pressure.sh"
CORE = ROOT / "lib" / "runner_disk_pressure.py"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class DiskPressureTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="disk-pressure-offline-")
        self.addCleanup(self.tmp.cleanup)
        self.work = Path(self.tmp.name)
        self.target = str(self.work / "volume-a")
        self.cfg = {"schema_version": 1, "scope": "example-site",
                    "targets": [{"id": "volume-a", "path": self.target, "warn_pct": 80, "crit_pct": 90}],
                    "runner_roots": []}
        self.state = {self.target: {"pct": 46}}
        self.policy_file = self.work / "policy.json"
        self.state_file = self.work / "df-state.json"
        self.calls = self.work / "df-calls.jsonl"
        self.du_calls = self.work / "du-calls.jsonl"
        self.du_state = self.work / "du-state.json"
        self.dedupe = self.work / "dedupe.json"
        self.put(self.du_state, {})
        self.put(self.dedupe, {"schema_version": 1, "existing_keys": []})
        self.df = self.work / "fake-df"
        self.df.write_text('''#!/usr/bin/python3
import json, os, pathlib, sys
args=sys.argv[1:]
with open(CALLS, "a") as out:
 out.write(json.dumps({"args":args,"env_keys":sorted(os.environ)})+"\\n")
if len(args)!=3 or args[:2]!=["-Pk","--"]:
 sys.exit(97)
state=json.loads(pathlib.Path(STATE).read_text())
row=state.get(args[2])
if row is None:
 sys.exit(96)
if "out" in row:
 sys.stdout.write(row["out"])
else:
 print("Filesystem 1024-blocks Used Available Capacity Mounted on")
 print("fixture-device",row.get("total",100),row.get("used",46),row.get("avail",54),str(row.get("pct",46))+"%",row.get("mount","/fixture-volume"))
if row.get("stderr"):
 sys.stderr.write(row["stderr"])
sys.exit(row.get("rc",0))
'''.replace("CALLS", repr(str(self.calls))).replace("STATE", repr(str(self.state_file))))
        self.du = self.work / "fake-du"
        self.du.write_text('''#!/usr/bin/python3
import json, os, pathlib, sys
args=sys.argv[1:]
with open(CALLS,"a") as out:
 out.write(json.dumps({"args":args,"env_keys":sorted(os.environ)})+"\\n")
if args[:3]!=["-kx","-s","--"]:
 sys.exit(97)
state=json.loads(pathlib.Path(STATE).read_text())
if "out" in state:
 sys.stdout.write(state["out"])
else:
 for i,p in enumerate(args[3:]):
  print(str((i+1)*10)+"\\t"+p)
sys.exit(state.get("rc",0))
'''.replace("CALLS", repr(str(self.du_calls))).replace("STATE", repr(str(self.du_state))))
        self.df.chmod(0o700)
        self.du.chmod(0o700)
        # Do not copy os.environ: no inherited credential, endpoint, shell hook,
        # user configuration, Python injection, or real service can reach tests.
        self.env = {"PATH": "/usr/bin:/bin", "LC_ALL": "C", "LANG": "C",
                    "HOME": str(self.work), "DF_BIN": str(self.df), "DU_BIN": str(self.du),
                    "PYTHONDONTWRITEBYTECODE": "1"}

    def put(self, path, value):
        path.write_text(json.dumps(value))
        path.chmod(0o600)

    def run_tool(self, *extra, write_policy=True, json_output=True):
        if write_policy:
            self.put(self.policy_file, self.cfg)
        self.put(self.state_file, self.state)
        args = ["/bin/bash", str(TOOL), "--config", str(self.policy_file)]
        if json_output:
            args.append("--json")
        return subprocess.run(args + list(extra), text=True, capture_output=True,
                              env=self.env, timeout=20)

    def report(self, *extra, **kwargs):
        run = self.run_tool(*extra, **kwargs)
        self.assertEqual(run.stderr, "", "structured runs must not crash or leak raw child errors")
        return run.returncode, json.loads(run.stdout)

    def records(self, path):
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def assert_no_probe(self):
        self.assertEqual(self.records(self.calls), [], "policy/dedupe refusal must precede df")
        self.assertEqual(self.records(self.du_calls), [], "policy/dedupe refusal must precede du")

    def assert_refused(self, *extra, **kwargs):
        rc, data = self.report(*extra, **kwargs)
        self.assertEqual(rc, 2, "invalid or incomplete evidence must be inconclusive, never health")
        self.assertEqual(data["status"], "inconclusive")
        self.assertEqual(data["targets"], [])
        self.assertEqual(data["proposals"], [])
        return data

    # Source core severity and negative controls, retained rather than removed.
    def test_critical_severity_and_exit_at_99_percent(self):
        self.state[self.target]["pct"] = 99
        rc, data = self.report()
        self.assertEqual(rc, 1, "99% must alarm")
        self.assertEqual(data["status"], "critical", "99% must be CRITICAL, not just WARNING")
        self.assertEqual(data["targets"][0]["status"], "critical")
        run = self.run_tool(json_output=False)
        self.assertEqual(run.returncode, 1)
        self.assertIn("CRITICAL", run.stdout)

    def test_exact_warning_and_critical_boundaries(self):
        for pct, expected in ((79, "ok"), (80, "pressure"), (85, "pressure"),
                              (89, "pressure"), (90, "critical"), (100, "critical")):
            with self.subTest(pct=pct):
                self.state[self.target]["pct"] = pct
                rc, data = self.report()
                self.assertEqual(data["status"], expected)
                self.assertEqual(rc, 0 if expected == "ok" else 1)

    def test_healthy_negative_control(self):
        rc, data = self.report()
        self.assertEqual(rc, 0, "46% must stay quiet; an always-on alarm is incorrect")
        self.assertEqual(data["status"], "ok")
        self.assertTrue(data["read_only"])
        self.assertEqual(data["targets"][0]["use_pct"], 46)
        self.assertEqual(data["targets"][0]["warn_pct"], 80)
        self.assertEqual(data["targets"][0]["crit_pct"], 90)
        self.assertEqual(data["proposals"], [])
        run = self.run_tool(json_output=False)
        self.assertEqual(run.returncode, 0)
        self.assertTrue(run.stdout.startswith("OK:"))

    def test_df_failure_is_inconclusive(self):
        self.state[self.target] = {"rc": 1, "stderr": "synthetic failure"}
        self.assert_refused()

    def test_missing_target_data_is_inconclusive(self):
        self.state = {}
        self.assert_refused()

    def test_malformed_measurements_are_inconclusive(self):
        header = "Filesystem 1024-blocks Used Available Capacity Mounted on\n"
        rows = ["", "unexpected output\n", header, header + "\n",
                header + "fixture 100 40 60 40% /fixture\nfixture 100 40 60 40% /fixture\n",
                header + "fixture 100 40 60 NaN% /fixture\n",
                header + "fixture 100 40 60 -1% /fixture\n",
                header + "fixture 100 bad 60 40% /fixture\n",
                header + "fixture 100 40 NaN 40% /fixture\n",
                header + "fixture 100 40 60 40%\n",
                header + "fixture 100 40 60 40% relative\n",
                header + "fixture 100 40 60 40% /fixture\tunsafe\n",
                "wrong header\nfixture 100 40 60 40% /fixture\n"]
        for out in rows:
            with self.subTest(out=out):
                self.state[self.target] = {"out": out}
                self.assert_refused()

    def test_out_of_range_usage_is_inconclusive(self):
        for pct in (101, 999):
            with self.subTest(pct=pct):
                self.state[self.target]["pct"] = pct
                self.assert_refused()

    def test_impossible_block_counts_are_inconclusive(self):
        for change in ({"total": 0}, {"used": 101}, {"avail": 101},
                       {"used": 80, "avail": 30}, {"total": 2**63}):
            with self.subTest(change=change):
                self.state[self.target] = {**{"pct": 46}, **change}
                self.assert_refused()

    def test_successful_df_with_stderr_is_not_clean(self):
        self.state[self.target]["stderr"] = "synthetic warning"
        self.assert_refused()

    def second_target(self, pct=46):
        path = str(self.work / "volume-b")
        self.cfg["targets"].append({"id": "volume-b", "path": path, "warn_pct": 70, "crit_pct": 95})
        self.state[path] = {"pct": pct}
        return path

    def test_partial_target_coverage_is_inconclusive(self):
        second = self.second_target()
        self.state[second] = {"rc": 1}
        self.assert_refused()
        self.assertEqual([r["args"][-1] for r in self.records(self.calls)], [self.target, second])

    def test_partial_coverage_never_emits_proposals(self):
        second = self.second_target()
        self.state[self.target]["pct"] = 99
        self.state[second] = {"out": "bad measurement\n"}
        self.assert_refused("--propose", "--dedupe-file", str(self.dedupe))

    def test_multiple_targets_require_all_and_use_worst_severity(self):
        second = self.second_target(70)
        rc, data = self.report()
        self.assertEqual(rc, 1)
        self.assertEqual(data["status"], "pressure")
        self.assertEqual(len(data["targets"]), 2)
        self.assertEqual(data["targets"][1]["warn_pct"], 70)
        self.assertEqual([r["args"] for r in self.records(self.calls)],
                         [["-Pk", "--", self.target], ["-Pk", "--", second]])
        self.state[second]["pct"] = 95
        rc, data = self.report()
        self.assertEqual(rc, 1)
        self.assertEqual(data["status"], "critical")

    def test_all_targets_healthy_is_clean(self):
        self.second_target(69)
        rc, data = self.report()
        self.assertEqual(rc, 0)
        self.assertEqual(len(data["targets"]), 2)
        self.assertTrue(all(row["status"] == "ok" for row in data["targets"]))

    def test_invalid_policy_is_refused_before_probing(self):
        base = copy.deepcopy(self.cfg)
        cases = []
        for key in base:
            value = copy.deepcopy(base)
            del value[key]
            cases.append(value)
        for targets in ([], None, "all", [None]):
            value = copy.deepcopy(base)
            value["targets"] = targets
            cases.append(value)
        for key, val in (("warn_pct", True), ("crit_pct", 90.0), ("warn_pct", "80"),
                         ("warn_pct", 0), ("crit_pct", 100), ("warn_pct", 90),
                         ("path", "relative"), ("path", self.target+"/../other"),
                         ("path", self.target+"\n"), ("id", "")):
            value = copy.deepcopy(base)
            value["targets"][0][key] = val
            cases.append(value)
        for value in cases:
            with self.subTest(value=value):
                self.cfg = value
                self.assert_refused()
                self.assert_no_probe()

    def test_no_unknown_policy_fields_or_implicit_authority(self):
        for key in ("runner_labels", "required_checks", "authority", "ephemeral", "fallback"):
            with self.subTest(key=key):
                self.cfg[key] = "synthetic"
                self.assert_refused()
                self.assert_no_probe()
                del self.cfg[key]

    def test_duplicate_target_policy_is_not_coverage(self):
        base = copy.deepcopy(self.cfg)
        for duplicate in ({**base["targets"][0], "path": str(self.work/"volume-b")},
                          {**base["targets"][0], "id": "another"}):
            with self.subTest(duplicate=duplicate):
                self.cfg = copy.deepcopy(base)
                self.cfg["targets"].append(duplicate)
                self.assert_refused()
                self.assert_no_probe()

    def test_roots_and_schema_and_scope_are_validated_before_probe(self):
        base = copy.deepcopy(self.cfg)
        for key, value in (("schema_version", True), ("schema_version", 2), ("scope", ""),
                           ("runner_roots", None), ("runner_roots", ["relative"]),
                           ("runner_roots", [self.target, self.target])):
            with self.subTest(key=key, value=value):
                self.cfg = {**base, key: value}
                self.assert_refused()
                self.assert_no_probe()

    def test_duplicate_json_keys_refused_before_probe(self):
        raw = json.dumps(self.cfg).replace('"warn_pct": 80', '"warn_pct": 60, "warn_pct": 80')
        self.policy_file.write_text(raw)
        self.policy_file.chmod(0o600)
        self.assert_refused(write_policy=False)
        self.assert_no_probe()

    def test_malformed_or_missing_local_config_is_refused_before_probe(self):
        self.assert_refused(write_policy=False)
        self.assert_no_probe()
        for raw in ("{", "[]", "null", "{\"schema_version\":NaN}"):
            with self.subTest(raw=raw):
                self.policy_file.write_text(raw)
                self.policy_file.chmod(0o600)
                self.assert_refused(write_policy=False)
                self.assert_no_probe()

    def test_untrusted_write_modes_and_symlink_config_are_refused(self):
        self.put(self.policy_file, self.cfg)
        for mode in (0o620, 0o602):
            with self.subTest(mode=mode):
                self.policy_file.chmod(mode)
                self.assert_refused(write_policy=False)
                self.assert_no_probe()
        saved = self.work / "saved-policy.json"
        self.put(saved, self.cfg)
        self.policy_file.unlink()
        self.policy_file.symlink_to(saved)
        self.assert_refused(write_policy=False)
        self.assert_no_probe()

    def test_oversized_json_integer_is_refused_before_probe(self):
        # A valid JSON token can exceed Python's integer-decoder safety limit.
        # It must take the same refusal path as malformed local policy.
        self.policy_file.write_text('{"schema_version":' + '9' * 5000 + '}')
        self.policy_file.chmod(0o600)
        run = self.run_tool(write_policy=False)
        self.assertEqual(run.returncode, 2, "decoder limits must return inconclusive, not crash")
        self.assertEqual(run.stderr, "")
        self.assertEqual(json.loads(run.stdout)["status"], "inconclusive")
        self.assert_no_probe()

    def test_nonregular_config_is_refused_without_blocking(self):
        os.mkfifo(self.policy_file, 0o600)
        self.assert_refused(write_policy=False)
        self.assert_no_probe()

    def test_no_config_or_write_intent_never_probes(self):
        for extra in ([], ["--apply"], ["--delete"], ["--path", self.target]):
            with self.subTest(extra=extra):
                run = subprocess.run(["/bin/bash", str(TOOL), *extra], env=self.env,
                                     capture_output=True, text=True, timeout=20)
                self.assertEqual(run.returncode, 2)
                self.assert_no_probe()
        run = self.run_tool("--apply")
        self.assertEqual(run.returncode, 2)
        self.assert_no_probe()

    def test_no_policy_inference_from_telemetry_or_runner_name(self):
        self.env["RUNNER_NAME"] = "example-ephemeral-worker"
        self.env["WARN_PCT"] = "100"
        self.state[self.target]["pct"] = 85
        self.state[self.target]["mount"] = "/fixture-ephemeral"
        rc, data = self.report()
        self.assertEqual(rc, 1, "telemetry and runner name cannot supply an advisory fallback")
        self.assertEqual(data["status"], "pressure")
        self.assertEqual(data["targets"][0]["warn_pct"], 80)

    def roots(self, count=2):
        root = self.work / "runner roots with spaces"
        root.mkdir()
        for i in range(count):
            (root / f"consumer-{i:02d}").mkdir()
        self.cfg["runner_roots"] = [str(root)]
        return root

    def test_breakdown_lists_top_consumers_and_never_changes_verdict(self):
        self.roots(12)
        self.state[self.target]["pct"] = 85
        rc, data = self.report()
        self.assertEqual(rc, 1)
        self.assertEqual(data["status"], "pressure")
        self.assertEqual(len(data["top_consumers"]), 10)
        self.assertEqual([x["kb"] for x in data["top_consumers"]], list(range(120, 20, -10)))
        self.assertTrue(all("consumer-" in x["path"] for x in data["top_consumers"]))

    def test_failing_or_malformed_breakdown_is_only_a_note(self):
        self.roots()
        for du in ({"rc": 1}, {"out": "NaN\t/fixture\n"}, {"out": ""}):
            for pct, expected, rc_expected in ((46, "ok", 0), (99, "critical", 1)):
                with self.subTest(du=du, pct=pct):
                    self.put(self.du_state, du)
                    self.state[self.target]["pct"] = pct
                    rc, data = self.report()
                    self.assertEqual(rc, rc_expected)
                    self.assertEqual(data["status"], expected)
                    self.assertEqual(data["top_consumers"], [])
                    self.assertEqual(len(data["notes"]), 1)
                    self.assertIn("df alone", data["notes"][0])

    def test_missing_breakdown_binary_does_not_mask_critical(self):
        self.roots()
        self.env["DU_BIN"] = str(self.work / "missing-du")
        self.state[self.target]["pct"] = 99
        rc, data = self.report()
        self.assertEqual(rc, 1)
        self.assertEqual(data["status"], "critical")
        self.assertEqual(len(data["notes"]), 1)

    def test_missing_root_spaced_note_stays_one_json_string(self):
        self.cfg["runner_roots"] = [str(self.work / "missing root")]
        rc, data = self.report()
        self.assertEqual(rc, 0)
        self.assertEqual(len(data["notes"]), 1)
        self.assertIn("runner root", data["notes"][0])
        self.assertIn("missing root", data["notes"][0])
        self.assertEqual(self.records(self.du_calls), [])

    def test_json_escapes_quotes_and_backslashes(self):
        self.target = str(self.work / 'volume-"quoted\\path')
        self.cfg["targets"][0]["path"] = self.target
        self.state = {self.target: {"pct": 46, "mount": '/fixture-"mount\\path'}}
        rc, data = self.report()
        self.assertEqual(rc, 0)
        self.assertEqual(data["targets"][0]["path"], self.target)
        self.assertEqual(data["targets"][0]["mount"], '/fixture-"mount\\path')

    def test_probe_children_scrub_even_synthetic_credentials(self):
        self.roots()
        self.env.update({"GH_TOKEN": "synthetic-no-credential", "PAPERCLIP_API_KEY": "synthetic-no-credential",
                         "AWS_SECRET_ACCESS_KEY": "synthetic-no-credential"})
        rc, _ = self.report()
        self.assertEqual(rc, 0)
        for row in self.records(self.calls) + self.records(self.du_calls):
            self.assertTrue(set(row["env_keys"]) <= {"PATH", "LC_ALL", "LANG", "LC_CTYPE"},
                            "probe child must have only the locale/path allowlist")

    def test_missing_or_relative_df_binary_refused(self):
        for name in (str(self.work / "missing-df"), "df", ""):
            with self.subTest(name=name):
                self.env["DF_BIN"] = name
                self.assert_refused()
                self.assert_no_probe()

    def proposal(self):
        return self.report("--propose", "--dedupe-file", str(self.dedupe))

    def test_proposals_are_stdout_only_and_dedupe_does_not_silence_alarm(self):
        self.state[self.target]["pct"] = 85
        before = digest(self.dedupe)
        rc, data = self.proposal()
        self.assertEqual(rc, 1)
        self.assertEqual(len(data["proposals"]), 1)
        item = data["proposals"][0]
        self.assertTrue(item["read_only"])
        self.assertEqual(item["action"], "inspect-and-plan")
        self.assertEqual(item["severity"], "pressure")
        self.assertEqual(digest(self.dedupe), before, "proposing must not persist dedupe state")
        self.put(self.dedupe, {"schema_version": 1, "existing_keys": [item["key"]]})
        before = digest(self.dedupe)
        self.state[self.target]["pct"] = 99
        rc, data = self.proposal()
        self.assertEqual(rc, 1, "an existing proposal must not convert pressure to healthy")
        self.assertEqual(data["status"], "critical")
        self.assertEqual(data["proposals"], [])
        self.assertEqual(data["deduped"], 1)
        self.assertEqual(digest(self.dedupe), before)

    def test_proposal_keys_follow_trusted_target_identity_not_telemetry(self):
        self.state[self.target]["pct"] = 85
        _, data = self.proposal()
        key = data["proposals"][0]["key"]
        self.state[self.target].update(pct=99, mount="/changed-telemetry")
        _, data = self.proposal()
        self.assertEqual(data["proposals"][0]["key"], key)
        self.cfg["scope"] = "another-example"
        _, data = self.proposal()
        self.assertNotEqual(data["proposals"][0]["key"], key)

    def test_propose_healthy_emits_nothing(self):
        rc, data = self.proposal()
        self.assertEqual(rc, 0)
        self.assertEqual(data["proposals"], [])
        self.assertEqual(data["deduped"], 0)

    def test_dedupe_is_target_specific_and_order_independent(self):
        second = self.second_target(99)
        self.state[self.target]["pct"] = 85
        _, data = self.proposal()
        first_key = data["proposals"][0]["key"]
        other_key = data["proposals"][1]["key"]
        self.assertNotEqual(first_key, other_key)
        self.put(self.dedupe, {"schema_version": 1, "existing_keys": [first_key]})
        self.cfg["targets"].reverse()
        rc, data = self.proposal()
        self.assertEqual(rc, 1)
        self.assertEqual(data["deduped"], 1)
        self.assertEqual([item["key"] for item in data["proposals"]], [other_key])
        self.assertEqual(data["proposals"][0]["path"], second)

    def test_bad_dedupe_snapshot_refused_before_probe(self):
        for data in ({}, [], {"schema_version": True, "existing_keys": []},
                     {"schema_version": 1, "existing_keys": None},
                     {"schema_version": 1, "existing_keys": [False]},
                     {"schema_version": 1, "existing_keys": ["bad-key"]},
                     {"schema_version": 1, "existing_keys": ["0"*64, "0"*64]}):
            with self.subTest(data=data):
                self.put(self.dedupe, data)
                self.assert_refused("--propose", "--dedupe-file", str(self.dedupe))
                self.assert_no_probe()
        self.dedupe.unlink()
        self.assert_refused("--propose", "--dedupe-file", str(self.dedupe))
        self.assert_no_probe()

    def test_untrusted_or_duplicate_key_dedupe_refused_before_probe(self):
        self.put(self.dedupe, {"schema_version": 1, "existing_keys": []})
        self.dedupe.chmod(0o622)
        self.assert_refused("--propose", "--dedupe-file", str(self.dedupe))
        self.assert_no_probe()
        self.dedupe.write_text('{"schema_version":1,"existing_keys":[],"existing_keys":[]}')
        self.dedupe.chmod(0o600)
        self.assert_refused("--propose", "--dedupe-file", str(self.dedupe))
        self.assert_no_probe()

    def test_propose_requires_explicit_dedupe_and_no_unused_dedupe(self):
        for extra in (("--propose",), ("--dedupe-file", str(self.dedupe))):
            with self.subTest(extra=extra):
                run = self.run_tool(*extra)
                self.assertEqual(run.returncode, 2)
                self.assert_no_probe()

    def test_bash_errexit_capture_reaches_generic_annotation(self):
        self.put(self.policy_file, self.cfg)
        self.state[self.target]["pct"] = 99
        self.put(self.state_file, self.state)
        # Synthetic caller proof only: no workflow extraction or site labels.
        body = '''set -uo pipefail
set +e
out="$(/bin/bash "$1" --config "$2")"; rc=$?
set -e
printf '%s\\n' "$out"
if [[ "$rc" -ne 0 ]]; then printf 'disk-pressure annotation rc=%s\\n' "$rc"; fi
exit "$rc"
'''
        args = ["/bin/bash", "-e", "-c", body, "fixture-caller", str(TOOL), str(self.policy_file)]
        run = subprocess.run(args, env=self.env, text=True, capture_output=True, timeout=20)
        self.assertEqual(run.returncode, 1)
        self.assertIn("disk-pressure annotation rc=1", run.stdout)
        args[3] = body.replace("set +e\n", "").replace("set -e\n", "")
        mutant = subprocess.run(args, env=self.env, text=True, capture_output=True, timeout=20)
        self.assertEqual(mutant.returncode, 1)
        self.assertNotIn("disk-pressure annotation", mutant.stdout,
                         "unbracketed capture control must die before annotation")


def mutation_check():
    original = CORE.read_bytes()
    before = hashlib.sha256(original).hexdigest()
    mode = stat.S_IMODE(CORE.stat().st_mode)
    old = b'    if percent >= target["crit_pct"]:\n'
    new = b'    if False:  # offline severity mutant\n'
    if original.count(old) != 1:
        raise AssertionError("severity mutation anchor must be unique")
    env = {"PATH": "/usr/bin:/bin", "LC_ALL": "C", "LANG": "C", "PYTHONDONTWRITEBYTECODE": "1"}
    args = [sys.executable, "-B", str(Path(__file__).resolve()),
            "DiskPressureTests.test_critical_severity_and_exit_at_99_percent", "-v"]
    try:
        mutated = original.replace(old, new)
        compile(mutated, str(CORE), "exec")
        CORE.write_bytes(mutated)
        print("MUTANT_SHA256=" + digest(CORE), flush=True)
        run = subprocess.run(args, env=env, text=True, capture_output=True, timeout=30)
        print(run.stdout + run.stderr, end="")
        assert run.returncode == 1, "severity mutant must be killed by test failure"
        assert "AssertionError" in run.stderr and "99% must be CRITICAL" in run.stderr, \
            "mutant must die at the named severity assertion, not an import/parser/runtime error"
        print("MUTANT_KILLED exit=1 assertion=99% must be CRITICAL", flush=True)
    finally:
        CORE.write_bytes(original)
        CORE.chmod(mode)
        assert digest(CORE) == before, "finally must restore exact original bytes"
        print("RESTORED_SHA256=" + before, flush=True)
    run = subprocess.run(args, env=env, text=True, capture_output=True, timeout=30)
    print(run.stdout + run.stderr, end="")
    assert run.returncode == 0, "restored severity control must pass"
    print("RESTORED_CONTROL exit=0 count=1", flush=True)
    return 0


if __name__ == "__main__":
    if sys.argv[1:] == ["--mutation-check"]:
        sys.exit(mutation_check())
    unittest.main()
