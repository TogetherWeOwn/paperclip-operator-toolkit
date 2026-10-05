import copy
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

from garm.validate_receipt import (
    FORBIDDEN_ACTIONS, InvalidReceipt, MAX_BYTES, ROLES, SCHEMA, parse, validate,
)
from garm.validate_canary_pool import (
    InvalidCanarySpec, parse as parse_canary_spec, validate as validate_canary_spec,
)

AT = "2026-10-03T03:30:00Z"


def fixture(role="privileged-private"):
    contract = ROLES[role]
    versions = {tool: "1.0.0" for tool in contract["tools"]}
    versions.update(runner="2.999.0", node="24.0.0", psql="16.0.0")
    if role == "privileged-private":
        versions.update(php="8.5.0", composer="2.0.0", docker="27.0.0")
    fingerprints = {
        "privileged-private": ("a", "d", "e"),
        "isolated-private": ("f", "1", "2"),
    }
    fingerprint, profile, inputs = (value * 64 for value in fingerprints[role])
    job = {
        "run": "fixture-run-1", "runner": "garm-fixture-1", "vm": "fixture-vm-1",
        "host": "fixture-host-a", "pool": "fixture-host-a-pool", "provider": "fixture-provider",
        "image_fingerprint": fingerprint, "mapping_verified": True,
        "completed_at": "2026-10-03T03:27:00Z", "conclusion": "success",
        "artifacts_complete": True,
    }
    cleanup = {key: job[key] for key in ("run", "runner", "vm", "host", "pool", "provider")}
    cleanup.update(observed_at="2026-10-03T03:28:00Z", vm_absent=True, registration_absent=True)
    return {
        "schema": SCHEMA, "evidence_class": "synthetic", "role": role,
        "source": {"revision": "b" * 40, "bundle_sha256": "c" * 64},
        "target": {
            "host": "fixture-host-a", "pool": "fixture-host-a-pool", "provider": "fixture-provider",
            "garm_version": "0.2.1", "provider_version": "0.1.3", "lxd_version": "5.21",
            "selector": "fixture-host-a-exclusive", "inventory_complete": True,
            "enabled_pools": [
                {"pool": "fixture-host-a-pool", "host": "fixture-host-a", "provider": "fixture-provider",
                 "selectors": ["example-ephemeral", "fixture-host-a-exclusive"]},
                {"pool": "fixture-host-b-pool", "host": "fixture-host-b", "provider": "fixture-secondary-provider",
                 "selectors": ["example-ephemeral"]},
            ],
        },
        "image": {
            "fingerprint": fingerprint, "profile_sha256": profile, "inputs_sha256": inputs,
            "sudo": contract["sudo"], "docker": contract["docker"], "tool_versions": versions,
            "node24_runner_smoke": True, "rebuild_receipt_present": True,
        },
        "trust": {
            "repository": "TogetherWeOwn/fixture-private", "visibility": "private",
            "runner_group_verified": True, "trusted_ref_policy_verified": True,
            "public_pr_excluded": True, "required_checks_verified": True,
            "blocking_gate_unchanged": True, "cancel_in_progress": False,
            "db_target": "disposable-ci-service",
        },
        "budget": {
            "observed_at": "2026-10-03T03:25:00Z", "all_reservations_accounted": True,
            "pressure_clear": True,
            "filesystems": [{"mount": "/", "used_percent": 50}, {"mount": "/home", "used_percent": 60}],
            "configured_max": 2, "safe_max": 1, "active_vms": 0, "reserved_vms": 0, "requested_vms": 1,
            "available_cpu": 4, "requested_cpu": 2,
            "available_ram_mib": 8192, "requested_ram_mib": 4096,
            "available_disk_gib": 40, "requested_disk_gib": 20,
        },
        "probes": {name: {"result": "pass", "positive_control_passed": True}
                   for name in contract["probes"]},
        "job": job, "cleanup": cleanup,
        "actions": {name: False for name in FORBIDDEN_ACTIONS},
    }


class ReceiptTest(unittest.TestCase):
    def reject_change(self, path, value, role="privileged-private"):
        receipt = fixture(role)
        target = receipt
        parts = path.split(".")
        for part in parts[:-1]:
            target = target[part]
        target[parts[-1]] = value
        with self.assertRaises(InvalidReceipt, msg=path):
            validate(receipt, AT)

    def test_both_positive_controls_never_authorize(self):
        for role in ROLES:
            with self.subTest(role=role):
                result = validate(fixture(role), AT)
                self.assertEqual(result["result"], "offline_contract_valid")
                for key in ("admission_authorized", "host_verified", "migration_complete"):
                    self.assertIs(result[key], False)

    def test_checked_in_fixture_pair_is_distinct_and_matches_generator(self):
        receipts = {}
        for role in ROLES:
            receipt = parse((Path(__file__).with_name("garm") / ("fixture-" + role + ".json")).read_bytes())
            self.assertEqual(receipt, fixture(role))
            self.assertEqual(validate(receipt, AT)["result"], "offline_contract_valid")
            receipts[role] = receipt
        privileged = receipts["privileged-private"]
        isolated = receipts["isolated-private"]
        for key in ("fingerprint", "profile_sha256", "inputs_sha256"):
            self.assertNotEqual(privileged["image"][key], isolated["image"][key])

    def test_role_contract_export_matches_checker_and_keeps_actual_inputs_unknown(self):
        contract = parse((Path(__file__).with_name("garm") / "role-contracts.json").read_bytes())
        self.assertEqual(set(contract["roles"]), set(ROLES))
        for name, role in ROLES.items():
            exported = contract["roles"][name]
            self.assertIs(exported["sudo"], role["sudo"])
            self.assertIs(exported["docker"], role["docker"])
            self.assertEqual(set(exported["required_tools"]), role["tools"])
            self.assertEqual(set(exported["required_probes_with_positive_controls"]), role["probes"])
        self.assertEqual(set(contract["forbidden_preparation_actions"]), FORBIDDEN_ACTIONS)
        self.assertIs(contract["installed"], False)
        self.assertIs(contract["admission_authorized"], False)
        self.assertIs(contract["source_baseline"]["verified_live"], False)
        self.assertTrue(contract["actual_build_inputs"])
        self.assertTrue(all(value is None for value in contract["actual_build_inputs"].values()))

    def test_cross_role_image_reuse_is_not_proved_by_a_single_receipt(self):
        receipt = fixture("isolated-private")
        privileged = fixture()
        for key in ("fingerprint", "profile_sha256", "inputs_sha256"):
            receipt["image"][key] = privileged["image"][key]
        receipt["job"]["image_fingerprint"] = receipt["image"]["fingerprint"]
        result = validate(receipt, AT)
        self.assertEqual(result["result"], "offline_contract_valid")
        self.assertIs(result["host_verified"], False)
        self.assertIs(result["admission_authorized"], False)

    def test_semantic_version_and_org_guards_without_masking(self):
        self.reject_change("image.tool_versions.composer", "1.0.0")
        self.reject_change("trust.repository", "OtherOrg/fixture-private")

    def test_denied_public_example_names_cannot_claim_private_visibility(self):
        for repo in ("example-public-web", "example-public-bot", "EXAMPLE-PUBLIC-WEB", "EXAMPLE-PUBLIC-BOT"):
            with self.subTest(repo=repo):
                self.reject_change("trust.repository", "TogetherWeOwn/" + repo)

    def test_duplicate_inventory_guards_without_masking(self):
        receipt = fixture()
        pools = receipt["target"]["enabled_pools"]
        pools.append(copy.deepcopy(pools[1]))
        # The duplicate is nonmatching; the exclusive-selector gate still passes.
        with self.assertRaisesRegex(InvalidReceipt, "duplicate pool identity"):
            validate(receipt, AT)
        receipt = fixture()
        filesystems = receipt["budget"]["filesystems"]
        filesystems.append(copy.deepcopy(filesystems[0]))
        with self.assertRaisesRegex(InvalidReceipt, "duplicate mount"):
            validate(receipt, AT)

    def test_job_identity_guards_without_cleanup_masking(self):
        changes = {"runner": "static-runner", "host": "fixture-host-b", "pool": "other-pool",
                   "provider": "other-provider"}
        for key, value in changes.items():
            receipt = fixture()
            receipt["job"][key] = receipt["cleanup"][key] = value
            reason = "job.runner" if key == "runner" else "job: target identity mismatch"
            with self.subTest(key=key), self.assertRaisesRegex(InvalidReceipt, reason):
                validate(receipt, AT)

    def test_ascii_clock_in_every_timestamp_position(self):
        # strptime accepts this mixed-digit year: rejection must come from our ASCII gate.
        mixed = "٢" + AT[1:]
        self.assertEqual(datetime.strptime(mixed, "%Y-%m-%dT%H:%M:%SZ").year, 2026)
        paths = ("evaluation time", "budget.observed_at", "job.completed_at", "cleanup.observed_at")
        for path in paths:
            receipt = fixture()
            if path == "evaluation time":
                value = AT
            else:
                section, key = path.split(".")
                value = receipt[section][key]
            for index, digit in enumerate(value):
                if digit not in "0123456789":
                    continue
                changed = value[:index] + chr(ord("٠") + int(digit)) + value[index + 1:]
                with self.subTest(path=path, index=index), self.assertRaises(InvalidReceipt):
                    if path == "evaluation time":
                        validate(receipt, changed)
                    else:
                        receipt[section][key] = changed
                        validate(receipt, AT)

    def test_json_value_error_is_structured_without_overriding_specific_rejections(self):
        with patch("garm.validate_receipt.json.loads", side_effect=ValueError("DO_NOT_ECHO")):
            with self.assertRaisesRegex(InvalidReceipt, "^JSON: malformed input$"):
                parse(b"{}")
        with self.assertRaisesRegex(InvalidReceipt, "^JSON: duplicate key$"):
            parse(b'{"a":1,"a":2}')
        with self.assertRaisesRegex(InvalidReceipt, "^JSON: non-finite number$"):
            parse(b'{"a":NaN}')

    def test_cli_large_integer_rejection_is_json_not_traceback(self):
        script = str(Path(__file__).with_name("garm") / "validate_receipt.py")
        scratch = os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR") or os.environ.get("PAPERCLIP_SCRATCH_DIR")
        with tempfile.TemporaryDirectory(dir=scratch) as directory:
            receipt = Path(directory) / "receipt.json"
            receipt.write_bytes(b'{"DO_NOT_ECHO":' + b"9" * 5000 + b"}")
            result = subprocess.run([sys.executable, script, str(receipt), "--at", AT],
                                    env={**os.environ, "PYTHONINTMAXSTRDIGITS": "4300"},
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stderr, "")
            self.assertEqual(json.loads(result.stdout), {
                "result": "offline_contract_rejected", "reason": "JSON: malformed input",
                "admission_authorized": False,
            })
            self.assertNotIn("DO_NOT_ECHO", result.stdout)

    def test_missing_or_extra_fields(self):
        for section, content in fixture().items():
            if type(content) is dict:
                for key in content:
                    with self.subTest(section=section, missing=key):
                        receipt = fixture()
                        del receipt[section][key]
                        with self.assertRaises(InvalidReceipt):
                            validate(receipt, AT)
                receipt = fixture()
                receipt[section]["unexpected"] = "ignored?"
                with self.assertRaises(InvalidReceipt):
                    validate(receipt, AT)
            receipt = fixture()
            del receipt[section]
            with self.assertRaises(InvalidReceipt):
                validate(receipt, AT)
        receipt = fixture()
        receipt["secret"] = "fixture-not-a-secret"
        with self.assertRaises(InvalidReceipt):
            validate(receipt, AT)

    def test_version_and_image_failures(self):
        for path, value in [
            ("schema", "other"), ("evidence_class", "operator-recorded"), ("role", "unknown"),
            ("role", []), ("source.revision", "main"), ("source.bundle_sha256", "UNKNOWN"),
            ("image.fingerprint", "alias"), ("image.inputs_sha256", "TBD"),
            ("image.profile_sha256", "floating"), ("image.node24_runner_smoke", False),
            ("image.rebuild_receipt_present", False), ("image.tool_versions.node", "20.0.0"),
            ("image.tool_versions.php", "8.4.0"), ("image.tool_versions.composer", "2"),
            ("image.tool_versions.runner", "latest"), ("target.provider_version", "0.1.5"),
            ("target.garm_version", "latest"), ("target.lxd_version", "unverified"),
        ]:
            with self.subTest(path=path):
                self.reject_change(path, value)

    def test_selector_and_target_failures(self):
        for path, value in [
            ("target.host", "fixture-unrelated-host"), ("target.pool", "wrong"), ("target.provider", "wrong"),
            ("target.selector", "example-ephemeral"), ("target.selector", "no-match"),
            ("target.inventory_complete", False), ("target.enabled_pools", []),
        ]:
            with self.subTest(path=path):
                self.reject_change(path, value)
        for change in ("duplicate_pool", "wrong_matching_host", "duplicate_selector"):
            receipt = fixture()
            pools = receipt["target"]["enabled_pools"]
            if change == "duplicate_pool":
                pools.append(copy.deepcopy(pools[0]))
            elif change == "wrong_matching_host":
                pools[0]["host"] = "fixture-host-b"
            else:
                pools[0]["selectors"].append("fixture-host-a-exclusive")
            with self.subTest(change=change), self.assertRaises(InvalidReceipt):
                validate(receipt, AT)

    def test_fixed_synthetic_host_guard_without_identity_masking(self):
        receipt = fixture()
        receipt["target"]["host"] = "fixture-host-b"
        receipt["target"]["enabled_pools"][0]["host"] = "fixture-host-b"
        receipt["job"]["host"] = receipt["cleanup"]["host"] = "fixture-host-b"
        # Inventory, job and cleanup still correlate; only the fixed subject differs.
        with self.assertRaisesRegex(InvalidReceipt, "^target.host:"):
            validate(receipt, AT)

    def test_budget_failures(self):
        for path, value in [
            ("budget.observed_at", "2026-10-03T02:00:00Z"),
            ("budget.observed_at", "2026-10-03T04:00:00Z"),
            ("budget.all_reservations_accounted", False), ("budget.pressure_clear", False),
            ("budget.configured_max", 3), ("budget.safe_max", 2), ("budget.safe_max", True),
            ("budget.active_vms", 1), ("budget.reserved_vms", 1), ("budget.requested_vms", 2),
            ("budget.requested_cpu", 5), ("budget.requested_ram_mib", 8193),
            ("budget.requested_disk_gib", 41), ("budget.available_cpu", True),
            ("budget.filesystems", []),
        ]:
            with self.subTest(path=path):
                self.reject_change(path, value)
        for used in (95, 96, -1, True, "50", float("nan"), float("inf")):
            receipt = fixture()
            receipt["budget"]["filesystems"][0]["used_percent"] = used
            with self.subTest(used=used), self.assertRaises(InvalidReceipt):
                validate(receipt, AT)
        receipt = fixture()
        receipt["budget"]["filesystems"] = [{"mount": "/home", "used_percent": 50}]
        with self.assertRaises(InvalidReceipt):
            validate(receipt, AT)

    def test_trust_and_actions_failures(self):
        for path, value in [
            ("trust.visibility", "public"), ("trust.runner_group_verified", False),
            ("trust.trusted_ref_policy_verified", False), ("trust.public_pr_excluded", False),
            ("trust.required_checks_verified", False), ("trust.blocking_gate_unchanged", False),
            ("trust.cancel_in_progress", True), ("trust.db_target", "production"),
        ]:
            with self.subTest(path=path):
                self.reject_change(path, value)
        for action in FORBIDDEN_ACTIONS:
            with self.subTest(action=action):
                self.reject_change("actions." + action, True)

    def test_isolated_role_and_positive_probe_failures(self):
        for path in ("image.sudo", "image.docker"):
            self.reject_change(path, True, role="isolated-private")
        for role in ROLES:
            for probe in ROLES[role]["probes"]:
                with self.subTest(role=role, probe=probe):
                    self.reject_change("probes." + probe + ".result", "unknown", role)
                    self.reject_change("probes." + probe + ".positive_control_passed", False, role)
                    self.reject_change("probes." + probe + ".positive_control_passed", 1, role)

    def test_job_and_cleanup_failures(self):
        for path, value in [
            ("job.runner", "static-runner"), ("job.host", "fixture-host-b"), ("job.pool", "wrong"),
            ("job.provider", "wrong"), ("job.image_fingerprint", "f" * 64),
            ("job.mapping_verified", False), ("job.artifacts_complete", False),
            ("job.conclusion", "cancelled"), ("job.completed_at", "2026-10-03T03:24:00Z"),
            ("job.completed_at", "2026-10-03T04:00:00Z"),
            ("cleanup.observed_at", "2026-10-03T03:26:00Z"),
            ("cleanup.observed_at", "2026-10-03T04:00:00Z"),
            ("cleanup.vm_absent", False), ("cleanup.registration_absent", False),
        ]:
            with self.subTest(path=path):
                self.reject_change(path, value)
        for key in ("run", "runner", "vm", "host", "pool", "provider"):
            self.reject_change("cleanup." + key, "other")

    def test_json_parser_fail_closed(self):
        for raw in (b'{"schema":1,"schema":2}', b'{"a":NaN}', b'{"a":Infinity}',
                    b"not json", b"[" * 2000, b"x" * (MAX_BYTES + 1), b"\xff"):
            with self.subTest(raw_size=len(raw)), self.assertRaises(InvalidReceipt):
                parse(raw)
        self.assertEqual(parse(json.dumps(fixture()).encode()), fixture())

    def test_invalid_evaluation_time(self):
        for at in ("2026-10-03T03:30:00+00:00", "2026-02-30T03:30:00Z", "now"):
            with self.subTest(at=at), self.assertRaises(InvalidReceipt):
                validate(fixture(), at)

    def test_cli_exit_status_and_no_raw_input_echo(self):
        script = str(Path(__file__).with_name("garm") / "validate_receipt.py")
        scratch = os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR") or os.environ.get("PAPERCLIP_SCRATCH_DIR")
        with tempfile.TemporaryDirectory(dir=scratch) as directory:
            receipt = Path(directory) / "receipt.json"
            receipt.write_text(json.dumps(fixture()))
            result = subprocess.run([sys.executable, script, str(receipt), "--at", AT],
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(json.loads(result.stdout)["admission_authorized"])
            r = fixture()
            r["unexpected"] = "SENTINEL_DO_NOT_ECHO"
            receipt.write_text(json.dumps(r))
            result = subprocess.run([sys.executable, script, str(receipt), "--at", AT],
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 1)
            self.assertNotIn("SENTINEL_DO_NOT_ECHO", result.stdout + result.stderr)


class CanarySpecTest(unittest.TestCase):
    def spec(self):
        path = Path(__file__).with_name("garm") / "canary-pool-spec.json"
        return parse_canary_spec(path.read_bytes())

    def test_checked_in_synthetic_spec_never_authorizes(self):
        spec = self.spec()
        self.assertEqual(spec["host"], "fixture-host-b")
        self.assertEqual(set(spec["pool"]["tags"]), {"self-hosted", "garm-managed"})
        self.assertEqual(set(spec["pool"]["forbidden_tags"]), {
            "example-ephemeral", "example-isolated", "example-selfhosted",
            "garm-fixture-host-b",
        })
        result = validate_canary_spec(spec)
        self.assertEqual(result["result"], "offline_canary_spec_valid")
        for key in ("image_pinned", "admission_authorized", "host_verified",
                    "migration_complete"):
            self.assertIs(result[key], False)

    def test_host_pin_requires_the_fixed_synthetic_subject(self):
        for host in ("fixture-host-a", "fixture-unrelated-host", None):
            spec = self.spec()
            spec["host"] = host
            with self.subTest(host=host), self.assertRaisesRegex(InvalidCanarySpec, "^host:"):
                validate_canary_spec(spec)

    def test_forbidden_labels_still_separate_trust_classes(self):
        for label in ("example-ephemeral", "example-isolated", "example-selfhosted"):
            spec = self.spec()
            spec["pool"]["forbidden_tags"].remove(label)
            with self.subTest(label=label), self.assertRaisesRegex(
                    InvalidCanarySpec, "missing trust-separation label"):
                validate_canary_spec(spec)
        for label, reason in (("example-isolated", "duplicate tag"),
                              ("garm-managed", "tag in both sets")):
            spec = self.spec()
            spec["pool"]["forbidden_tags"].append(label)
            with self.subTest(label=label), self.assertRaisesRegex(InvalidCanarySpec, reason):
                validate_canary_spec(spec)
        spec = self.spec()
        spec["pool"]["tags"] = ["self-hosted", "example-isolated"]
        with self.assertRaisesRegex(InvalidCanarySpec, "^pool.tags:"):
            validate_canary_spec(spec)

    def test_live_pins_bounds_and_authority_claims_stay_hold(self):
        for path, value in (
            ("provider.name", "fixture-provider"), ("provider.provider_version", "0.1.5"),
            ("pool.image_alias", "fixture-image"), ("pool.image_digest", "a" * 64),
            ("pool.runner_prefix", "static-runner"),
            ("pool.min_idle_runners", 1), ("pool.max_runners", 2),
            ("pool.max_runners", True), ("evidence_class", "operator-recorded"),
            ("admission_authorized", True), ("host_verified", True),
            ("migration_complete", True), ("installed", True),
            ("missing_input_disposition", "ready"), ("status", "live"),
        ):
            spec = self.spec()
            target = spec
            parts = path.split(".")
            for part in parts[:-1]:
                target = target[part]
            target[parts[-1]] = value
            with self.subTest(path=path), self.assertRaises(InvalidCanarySpec):
                validate_canary_spec(spec)

    def test_missing_extra_and_invalid_json_stay_refused(self):
        for key in self.spec():
            spec = self.spec()
            del spec[key]
            with self.subTest(missing=key), self.assertRaises(InvalidCanarySpec):
                validate_canary_spec(spec)
        spec = self.spec()
        spec["unexpected"] = "ignored?"
        with self.assertRaises(InvalidCanarySpec):
            validate_canary_spec(spec)
        for raw in (b'{"host":1,"host":2}', b'{"a":NaN}', b"not json",
                    b"x" * (MAX_BYTES + 1)):
            with self.subTest(size=len(raw)), self.assertRaises(InvalidCanarySpec):
                parse_canary_spec(raw)

    def test_cli_keeps_exit_status_and_never_echoes_rejected_host(self):
        script = str(Path(__file__).with_name("garm") / "validate_canary_pool.py")
        scratch = os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR") or os.environ.get("PAPERCLIP_SCRATCH_DIR")
        with tempfile.TemporaryDirectory(dir=scratch) as directory:
            path = Path(directory) / "spec.json"
            spec = self.spec()
            path.write_text(json.dumps(spec))
            result = subprocess.run([sys.executable, script, str(path)],
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(json.loads(result.stdout)["admission_authorized"])
            spec["host"] = "SENTINEL_DO_NOT_ECHO"
            path.write_text(json.dumps(spec))
            result = subprocess.run([sys.executable, script, str(path)],
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 1)
            self.assertFalse(json.loads(result.stdout)["admission_authorized"])
            self.assertNotIn("SENTINEL_DO_NOT_ECHO", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
