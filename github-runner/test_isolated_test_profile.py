import copy
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from garm.validate_test_profile import (
    ELIGIBLE_LABELS,
    EXTENSIONS,
    FORBIDDEN_ACTIONS,
    INELIGIBLE_REQUIRED,
    MAX_BYTES,
    NETWORK_DENIES,
    PROBES,
    RESOURCES,
    SCHEMA,
    SIZE_CAPS,
    TOOLS,
    InvalidProfile,
    parse,
    validate,
    validate_pair,
)


def profile_fixture():
    versions = {tool: "1.0.0" for tool in TOOLS}
    versions.update(runner="2.999.0", node="24.0.0", php="8.5.0",
                    composer="2.0.0", psql="16.0.0")
    return {
        "schema": SCHEMA, "evidence_class": "synthetic", "role": "test-private",
        "source": {"revision": "0" * 40, "bundle_sha256": "1" * 64},
        "image": {
            "fingerprint": "b" * 64, "profile_sha256": "c" * 64,
            "inputs_sha256": "0" * 64, "sudo": False, "docker": False,
            "tool_versions": versions, "node24_runner_smoke": True,
            "rebuild_receipt_present": True,
        },
        "runtime": {"user": "runner", "root": False, "sudo": False,
                    "login_shell": False},
        "docker": {"client_installed": False, "daemon_reachable": False,
                   "socket_present": False, "tcp_relay_reachable": False,
                   "docker_host_set": False},
        "network_deny": {name: {"result": "pass", "positive_control_passed": True}
                         for name in NETWORK_DENIES},
        "probes": {name: {"result": "pass", "positive_control_passed": True}
                   for name in PROBES},
        "labels": {"eligible": ["self-hosted", "two-test"],
                   "ineligible": ["two-ephemeral", "two-selfhosted",
                                  "two-isolated"]},
        "resources": dict(RESOURCES),
        "ephemeral": {"runner_ephemeral": True, "one_job_then_deregister": True,
                      "vm_absent_after_job": True,
                      "registration_absent_after_job": True},
        "size_caps": dict(SIZE_CAPS),
        "toolchain": {"psql_on_path": True, "php_provides": True,
                      "composer_provides": True,
                      "extensions_provided": sorted(EXTENSIONS),
                      "node_series": "24", "runner_smoke": True},
        "actions": {name: False for name in FORBIDDEN_ACTIONS},
    }


class TestProfileTest(unittest.TestCase):
    def reject_change(self, path, value):
        receipt = profile_fixture()
        target = receipt
        parts = path.split(".")
        for part in parts[:-1]:
            target = target[part]
        target[parts[-1]] = value
        with self.assertRaises(InvalidProfile, msg=path):
            validate(receipt)

    def test_positive_control_never_authorizes(self):
        result = validate(profile_fixture())
        self.assertEqual(result["result"], "offline_profile_valid")
        for key in ("admission_authorized", "host_verified", "migration_complete"):
            self.assertIs(result[key], False)

    def test_checked_in_fixture_matches_generator(self):
        path = Path(__file__).with_name("garm") / "fixture-test-profile.json"
        receipt = parse(path.read_bytes())
        fixture = profile_fixture()
        fixture["toolchain"]["extensions_provided"] = list(EXTENSIONS)
        # Fixture stores extensions unordered-set-equal; generator sorts them.
        self.assertEqual(set(receipt["toolchain"]["extensions_provided"]),
                         set(fixture["toolchain"]["extensions_provided"]))
        receipt["toolchain"]["extensions_provided"] = fixture["toolchain"]["extensions_provided"]
        self.assertEqual(receipt, fixture)
        self.assertEqual(validate(receipt)["result"], "offline_profile_valid")

    def test_profile_definition_matches_checker(self):
        path = Path(__file__).with_name("garm") / "test-class-image-profile.json"
        definition = parse(path.read_bytes())
        self.assertEqual(definition["role"], "test-private")
        self.assertEqual(definition["schema"], "garm-test-image-profile.v1")
        self.assertFalse(definition["installed"])
        self.assertFalse(definition["admission_authorized"])
        self.assertFalse(definition["host_verified"])
        self.assertFalse(definition["migration_complete"])
        self.assertEqual(definition["runtime_user"]["sudo"], False)
        self.assertEqual(definition["runtime_user"]["root"], False)
        self.assertFalse(definition["docker"]["client_installed"])
        self.assertFalse(definition["docker"]["daemon_reachable"])
        self.assertFalse(definition["docker"]["socket_present"])
        self.assertFalse(definition["docker"]["tcp_relay_reachable"])
        self.assertFalse(definition["docker"]["docker_host_set"])
        self.assertEqual(set(definition["labels"]["eligible"]), ELIGIBLE_LABELS)
        self.assertTrue(INELIGIBLE_REQUIRED <= set(definition["labels"]["explicitly_ineligible"]))
        for key, expected in RESOURCES.items():
            self.assertEqual(definition["resources"][key], expected,
                             "resources." + key)
        for key, expected in SIZE_CAPS.items():
            self.assertEqual(definition["size_caps"][key], expected,
                             "size_caps." + key)
        self.assertTrue(definition["ephemeral_lifecycle"]["runner_ephemeral"])
        self.assertTrue(definition["ephemeral_lifecycle"]["one_job_then_deregister"])
        constraints = definition["constraints"]
        self.assertFalse(constraints["lxd_privileged_required"])
        self.assertTrue(constraints["no_sudo_no_docker_surface"])
        self.assertTrue(constraints["org_group_refuses_public_repos"])
        self.assertEqual(constraints["public_pr_routing"],
                         "standard-github-hosted-only")
        toolchain = definition["toolchain"]
        self.assertTrue(toolchain["psql"]["required"])
        self.assertTrue(toolchain["psql"]["on_path"])
        self.assertEqual(toolchain["node"]["series"], "24")
        self.assertTrue(toolchain["node"]["required"])
        self.assertTrue(toolchain["php"]["required"])
        self.assertEqual(toolchain["php"]["series"], "8.5")
        self.assertTrue(toolchain["composer"]["required"])
        self.assertEqual(toolchain["composer"]["series"], "2")
        self.assertTrue(toolchain["php_extensions"]["required"])
        self.assertEqual(set(toolchain["php_extensions"]["extensions"]), EXTENSIONS)
        self.assertFalse(toolchain["docker"]["required"])
        self.assertTrue(all(definition["base"][key] is None
                            for key in ("base_image_fingerprint",
                                        "packages_snapshot_sha256",
                                        "builder_revision", "cloud_init_sha256")))
        self.assertTrue(all(definition["output"][key] is None
                            for key in ("output_image_fingerprint",
                                        "profile_sha256", "inputs_sha256")))

    def test_test_digest_differs_from_other_roles(self):
        garm = Path(__file__).with_name("garm")
        test = parse((garm / "fixture-test-profile.json").read_bytes())
        others = ["fixture-privileged-private.json",
                  "fixture-isolated-private.json",
                  "fixture-isolated-profile.json"]
        for name in others:
            other = parse((garm / name).read_bytes())
            for key in ("fingerprint", "profile_sha256", "inputs_sha256"):
                self.assertNotEqual(test["image"][key], other["image"][key],
                                    "test reuses " + name + " " + key)

    def test_pair_checker_closes_single_receipt_gap(self):
        garm = Path(__file__).with_name("garm")
        canary = parse((garm / "fixture-privileged-private.json").read_bytes())
        profile = profile_fixture()
        result = validate_pair(profile, canary)
        self.assertEqual(result["result"], "pair_distinct_valid")
        self.assertIs(result["admission_authorized"], False)
        self.assertIs(result["host_verified"], False)
        for key in ("fingerprint", "profile_sha256", "inputs_sha256"):
            shared = copy.deepcopy(profile)
            shared["image"][key] = canary["image"][key]
            with self.subTest(key=key), self.assertRaisesRegex(
                    InvalidProfile, "pair: shared " + key):
                validate_pair(shared, canary)

    def test_pair_rejects_nonsynthetic_and_unknown_schema(self):
        first, second = profile_fixture(), profile_fixture()
        first["evidence_class"] = "operator-recorded"
        with self.assertRaises(InvalidProfile):
            validate_pair(first, second)
        first, second = profile_fixture(), profile_fixture()
        second["schema"] = "other"
        with self.assertRaises(InvalidProfile):
            validate_pair(first, second)

    def test_capability_surface_failures(self):
        # Test class is non-privileged: any sudo or Docker surface fails.
        for path, value in [
            ("image.sudo", True), ("image.docker", True),
            ("runtime.root", True), ("runtime.sudo", True),
            ("runtime.login_shell", True), ("runtime.user", "root"),
            ("docker.client_installed", True), ("docker.daemon_reachable", True),
            ("docker.socket_present", True),
            ("docker.tcp_relay_reachable", True), ("docker.docker_host_set", True),
        ]:
            with self.subTest(path=path):
                self.reject_change(path, value)

    def test_network_and_probe_positive_controls(self):
        receipt = profile_fixture()
        del receipt["network_deny"]["production_denied"]
        with self.assertRaises(InvalidProfile):
            validate(receipt)
        for section in ("network_deny", "probes"):
            names = NETWORK_DENIES if section == "network_deny" else PROBES
            for name in names:
                for value in ("unknown", False, 1):
                    receipt = profile_fixture()
                    key = "positive_control_passed" if value != "unknown" else "result"
                    receipt[section][name][key] = value
                    with self.subTest(section=section, name=name, value=value):
                        with self.assertRaises(InvalidProfile):
                            validate(receipt)

    def test_label_containment_failures(self):
        for eligible, ineligible in [
            (["self-hosted", "example-isolated"],
             ["example-ephemeral", "example-selfhosted", "example-isolated"]),
            (["self-hosted", "example-test"], ["example-ephemeral", "example-selfhosted"]),
            (["self-hosted", "example-test"], ["example-ephemeral"]),
            (["self-hosted", "example-test"],
             ["example-ephemeral", "example-selfhosted", "example-test"]),
            (["self-hosted", "example-test"],
             ["example-ephemeral", "example-ephemeral", "example-selfhosted", "example-isolated"]),
        ]:
            receipt = profile_fixture()
            receipt["labels"] = {"eligible": eligible, "ineligible": ineligible}
            with self.subTest(labels=receipt["labels"]):
                with self.assertRaises(InvalidProfile):
                    validate(receipt)

    def test_resource_size_ephemeral_and_toolchain_failures(self):
        for path, value in [
            ("resources.safe_max", 2), ("resources.configured_max", 3),
            ("resources.cpu", 4), ("resources.ram_mib", 8192),
            ("resources.disk_gib", 40),
            ("size_caps.image_gib", 30), ("size_caps.workspace_gib", 100),
            ("size_caps.log_retention_days", 90),
            ("ephemeral.runner_ephemeral", False),
            ("ephemeral.one_job_then_deregister", False),
            ("ephemeral.vm_absent_after_job", False),
            ("ephemeral.registration_absent_after_job", False),
            ("toolchain.psql_on_path", False), ("toolchain.php_provides", False),
            ("toolchain.composer_provides", False),
            ("toolchain.extensions_provided", []),
            ("toolchain.extensions_provided", ["pdo_pgsql"]),
            ("toolchain.node_series", "20"), ("toolchain.runner_smoke", False),
            ("image.tool_versions.node", "20.0.0"),
            ("image.tool_versions.php", "8.4.0"),
            ("image.tool_versions.composer", "1.0.0"),
            ("image.tool_versions.runner", "latest"),
            ("image.node24_runner_smoke", False),
            ("image.rebuild_receipt_present", False),
            ("role", "isolated-private"), ("evidence_class", "operator-recorded"),
            ("source.revision", "main"), ("source.bundle_sha256", "UNKNOWN"),
        ]:
            with self.subTest(path=path):
                self.reject_change(path, value)

    def test_forbidden_preparation_actions(self):
        for action in FORBIDDEN_ACTIONS:
            with self.subTest(action=action):
                self.reject_change("actions." + action, True)

    def test_missing_or_extra_fields(self):
        for section, content in profile_fixture().items():
            if type(content) is dict:
                for key in content:
                    with self.subTest(section=section, missing=key):
                        receipt = profile_fixture()
                        del receipt[section][key]
                        with self.assertRaises(InvalidProfile):
                            validate(receipt)
                receipt = profile_fixture()
                receipt[section]["unexpected"] = "ignored?"
                with self.assertRaises(InvalidProfile):
                    validate(receipt)
            receipt = profile_fixture()
            del receipt[section]
            with self.assertRaises(InvalidProfile):
                validate(receipt)

    def test_json_parser_fail_closed(self):
        for raw in (b'{"schema":1,"schema":2}', b'{"a":NaN}', b'{"a":Infinity}',
                    b"not json", b"[" * 2000, b"x" * (MAX_BYTES + 1), b"\xff"):
            with self.subTest(raw_size=len(raw)), self.assertRaises(InvalidProfile):
                parse(raw)
        self.assertEqual(parse(json.dumps(profile_fixture()).encode()),
                         profile_fixture())

    def test_cli_exit_status_pair_mode_and_no_raw_input_echo(self):
        script = str(Path(__file__).with_name("garm") / "validate_test_profile.py")
        garm = Path(__file__).with_name("garm")
        scratch = os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR") or os.environ.get(
            "PAPERCLIP_SCRATCH_DIR")
        with tempfile.TemporaryDirectory(dir=scratch) as directory:
            receipt = Path(directory) / "receipt.json"
            fixture = profile_fixture()
            fixture["toolchain"]["extensions_provided"] = sorted(EXTENSIONS)
            receipt.write_text(json.dumps(fixture))
            result = subprocess.run([sys.executable, script, str(receipt)],
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(json.loads(result.stdout)["admission_authorized"])
            pair = subprocess.run(
                [sys.executable, script, str(receipt),
                 str(garm / "fixture-privileged-private.json")],
                capture_output=True, text=True, timeout=10)
            self.assertEqual(pair.returncode, 0, pair.stderr)
            self.assertEqual(json.loads(pair.stdout)["result"], "pair_distinct_valid")
            r = profile_fixture()
            r["unexpected"] = "SENTINEL_DO_NOT_ECHO"
            receipt.write_text(json.dumps(r))
            result = subprocess.run([sys.executable, script, str(receipt)],
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 1)
            self.assertNotIn("SENTINEL_DO_NOT_ECHO", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
