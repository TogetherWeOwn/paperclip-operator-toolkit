import copy
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from garm.validate_isolated_profile import (
    ELIGIBLE_LABELS,
    FORBIDDEN_ACTIONS,
    INELIGIBLE_REQUIRED,
    MAX_BYTES,
    NETWORK_DENIES,
    PROBES,
    RESOURCES,
    SCHEMA,
    TOOLS,
    InvalidProfile,
    parse,
    validate,
    validate_pair,
)


def profile_fixture():
    versions = {tool: "1.0.0" for tool in TOOLS}
    versions.update(runner="2.999.0", node="24.0.0", psql="16.0.0")
    return {
        "schema": SCHEMA, "evidence_class": "synthetic", "role": "isolated-private",
        "source": {"revision": "d" * 40, "bundle_sha256": "e" * 64},
        "image": {
            "fingerprint": "9" * 64, "profile_sha256": "8" * 64,
            "inputs_sha256": "7" * 64, "sudo": False, "docker": False,
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
        "labels": {"eligible": ["self-hosted", "example-isolated"],
                   "ineligible": ["example-ephemeral", "example-selfhosted"]},
        "resources": dict(RESOURCES),
        "toolchain": {"psql_on_path": True, "php_provides": False,
                      "composer_provides": False, "extensions_provided": [],
                      "node_series": "24", "runner_smoke": True},
        "actions": {name: False for name in FORBIDDEN_ACTIONS},
    }


class IsolatedProfileTest(unittest.TestCase):
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
        path = Path(__file__).with_name("garm") / "fixture-isolated-profile.json"
        receipt = parse(path.read_bytes())
        self.assertEqual(receipt, profile_fixture())
        self.assertEqual(validate(receipt)["result"], "offline_profile_valid")

    def test_profile_definition_matches_checker(self):
        path = Path(__file__).with_name("garm") / "isolated-image-profile.json"
        definition = parse(path.read_bytes())
        self.assertEqual(definition["role"], "isolated-private")
        self.assertEqual(definition["schema"], "garm-isolated-image-profile.v1")
        self.assertFalse(definition["installed"])
        self.assertFalse(definition["admission_authorized"])
        self.assertFalse(definition["host_verified"])
        self.assertFalse(definition["migration_complete"])
        self.assertEqual(definition["runtime_user"]["sudo"], False)
        self.assertEqual(definition["runtime_user"]["root"], False)
        for key in ("client_installed", "daemon_reachable", "socket_present",
                    "tcp_relay_reachable", "docker_host_set"):
            self.assertIs(definition["docker"][key], False)
        self.assertEqual(set(definition["labels"]["eligible"]), ELIGIBLE_LABELS)
        self.assertTrue(INELIGIBLE_REQUIRED <= set(definition["labels"]["explicitly_ineligible"]))
        for key, expected in RESOURCES.items():
            self.assertEqual(definition["resources"][key], expected,
                             "resources." + key)
        toolchain = definition["toolchain"]
        self.assertTrue(toolchain["psql"]["required"])
        self.assertTrue(toolchain["psql"]["on_path"])
        self.assertEqual(toolchain["node"]["series"], "24")
        self.assertTrue(toolchain["node"]["required"])
        self.assertFalse(toolchain["php"]["required"])
        self.assertFalse(toolchain["composer"]["required"])
        self.assertFalse(toolchain["php_extensions"]["required"])
        self.assertTrue(all(definition["base"][key] is None
                            for key in ("base_image_fingerprint",
                                        "packages_snapshot_sha256",
                                        "builder_revision", "cloud_init_sha256")))
        self.assertTrue(all(definition["output"][key] is None
                            for key in ("output_image_fingerprint",
                                        "profile_sha256", "inputs_sha256")))

    def test_three_role_digests_are_pairwise_distinct(self):
        garm = Path(__file__).with_name("garm")
        trios = {}
        for name in ("fixture-privileged-private.json",
                     "fixture-isolated-private.json",
                     "fixture-isolated-profile.json"):
            receipt = parse((garm / name).read_bytes())
            trios[name] = tuple(receipt["image"][key] for key in
                                ("fingerprint", "profile_sha256", "inputs_sha256"))
        names = list(trios)
        for i in range(len(names)):
            for j in range(i + 1, len(names)):
                for key, digest_a, digest_b in zip(
                        ("fingerprint", "profile_sha256", "inputs_sha256"),
                        trios[names[i]], trios[names[j]]):
                    self.assertNotEqual(digest_a, digest_b,
                                        names[i] + " vs " + names[j] + " " + key)

    def test_pair_checker_closes_single_receipt_gap(self):
        garm = Path(__file__).with_name("garm")
        rehearsal = parse((garm / "fixture-isolated-private.json").read_bytes())
        profile = profile_fixture()
        result = validate_pair(profile, rehearsal)
        self.assertEqual(result["result"], "pair_distinct_valid")
        self.assertIs(result["admission_authorized"], False)
        self.assertIs(result["host_verified"], False)
        for key in ("fingerprint", "profile_sha256", "inputs_sha256"):
            shared = copy.deepcopy(profile)
            shared["image"][key] = rehearsal["image"][key]
            with self.subTest(key=key), self.assertRaisesRegex(
                    InvalidProfile, "pair: shared " + key):
                validate_pair(shared, rehearsal)

    def test_pair_rejects_nonsynthetic_and_unknown_schema(self):
        first, second = profile_fixture(), profile_fixture()
        first["evidence_class"] = "operator-recorded"
        with self.assertRaises(InvalidProfile):
            validate_pair(first, second)
        first, second = profile_fixture(), profile_fixture()
        second["schema"] = "other"
        with self.assertRaises(InvalidProfile):
            validate_pair(first, second)

    def test_privilege_surface_failures(self):
        for path, value in [
            ("image.sudo", True), ("image.docker", True),
            ("runtime.root", True), ("runtime.sudo", True),
            ("runtime.login_shell", True), ("runtime.user", "root"),
            ("docker.client_installed", True), ("docker.daemon_reachable", True),
            ("docker.socket_present", True), ("docker.tcp_relay_reachable", True),
            ("docker.docker_host_set", True),
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
            (["self-hosted", "example-ephemeral"], ["example-ephemeral", "example-selfhosted"]),
            (["self-hosted", "example-isolated"], ["example-ephemeral"]),
            (["self-hosted", "example-isolated"], ["example-ephemeral", "example-isolated"]),
            (["self-hosted", "example-isolated"],
             ["example-ephemeral", "example-ephemeral", "example-selfhosted"]),
        ]:
            receipt = profile_fixture()
            receipt["labels"] = {"eligible": eligible, "ineligible": ineligible}
            with self.subTest(labels=receipt["labels"]):
                with self.assertRaises(InvalidProfile):
                    validate(receipt)

    def test_resource_ceiling_and_toolchain_failures(self):
        for path, value in [
            ("resources.safe_max", 2), ("resources.configured_max", 3),
            ("resources.cpu", 4), ("resources.ram_mib", 8192),
            ("resources.disk_gib", 40),
            ("toolchain.psql_on_path", False), ("toolchain.php_provides", True),
            ("toolchain.composer_provides", True),
            ("toolchain.extensions_provided", ["pdo_pgsql"]),
            ("toolchain.node_series", "20"), ("toolchain.runner_smoke", False),
            ("image.tool_versions.node", "20.0.0"),
            ("image.tool_versions.runner", "latest"),
            ("image.node24_runner_smoke", False),
            ("image.rebuild_receipt_present", False),
            ("role", "privileged-private"), ("evidence_class", "operator-recorded"),
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
        script = str(Path(__file__).with_name("garm") / "validate_isolated_profile.py")
        garm = Path(__file__).with_name("garm")
        scratch = os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR") or os.environ.get(
            "PAPERCLIP_SCRATCH_DIR")
        with tempfile.TemporaryDirectory(dir=scratch) as directory:
            receipt = Path(directory) / "receipt.json"
            receipt.write_text(json.dumps(profile_fixture()))
            result = subprocess.run([sys.executable, script, str(receipt)],
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(json.loads(result.stdout)["admission_authorized"])
            pair = subprocess.run(
                [sys.executable, script, str(receipt),
                 str(garm / "fixture-isolated-private.json")],
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
