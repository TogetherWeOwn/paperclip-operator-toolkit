#!/usr/bin/env python3
"""Offline toolchain-pin regression tests; no builds, no network, no hosts."""

import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from garm.validate_toolchain import InvalidToolchain, parse, validate

MANIFEST = Path(__file__).resolve().parent / "garm" / "toolchain-isolated-private.json"
CHECKER = Path(__file__).resolve().parent / "garm" / "validate_toolchain.py"


def load_manifest():
    with MANIFEST.open("rb") as stream:
        return parse(stream.read(1024 * 1024 + 1))


class ToolchainPinTest(unittest.TestCase):
    def test_manifest_validates(self):
        result = validate(load_manifest())
        self.assertEqual(result["result"], "toolchain_pins_valid")
        self.assertFalse(result["admission_authorized"])

    def test_every_pin_exact_and_no_latest(self):
        manifest = load_manifest()
        pins = manifest["pins"]
        seen = []

        def collect(value):
            if isinstance(value, dict):
                for key, item in value.items():
                    if key == "version":
                        seen.append(item)
                    else:
                        collect(item)
            elif isinstance(value, list):
                for item in value:
                    collect(item)

        collect(pins)
        self.assertGreaterEqual(len(seen), 8)
        for version in seen:
            self.assertRegex(version, r"^\d+\.\d+(\.\d+)?([.+-][A-Za-z0-9.-]+)?$")
            self.assertNotIn("latest", version.lower())
            self.assertNotIn("*", version)

    def test_isolated_role_shape(self):
        manifest = load_manifest()
        self.assertEqual(manifest["role"], "isolated-private")
        self.assertEqual(manifest["evidence_class"], "source-only")
        self.assertTrue(manifest["requirements"]["psql_on_path"])
        self.assertTrue(manifest["requirements"]["node24_runner_smoke"])
        self.assertTrue(manifest["requirements"]["no_floating_tags"])
        self.assertEqual(manifest["pins"]["php"]["version"], "8.5.11")
        self.assertEqual(manifest["pins"]["node"]["version"], "24.12.0")
        self.assertEqual(manifest["pins"]["composer"]["version"], "2.9.3")
        self.assertEqual(manifest["pins"]["psql"]["version"], "16.15")
        self.assertEqual(manifest["pins"]["runner"]["version"], "2.330.0")
        self.assertEqual(manifest["pins"]["extensions"]["pcov"]["version"], "1.0.12")
        for name in ("pdo_pgsql", "zip", "gd"):
            entry = manifest["pins"]["extensions"][name]
            self.assertTrue(entry["enabled"])
            self.assertEqual(entry["version"], "8.5.11")
        for key in ("image_build", "pool_cap_change", "migration_authorized"):
            self.assertFalse(manifest["forbidden_preparation_actions"][key])
        self.assertFalse(manifest["image_build_authorized"])
        self.assertFalse(manifest["migration_authorized"])
        self.assertFalse(manifest["admission_authorized"])
        for key in ("base_image_fingerprint", "output_image_fingerprint", "profile_sha256"):
            self.assertIsNone(manifest["output_hold"][key])

    def test_rejects_floating_tag(self):
        manifest = load_manifest()
        bad = copy.deepcopy(manifest)
        bad["pins"]["node"]["version"] = "24"
        with self.assertRaises(InvalidToolchain):
            validate(bad)
        bad = copy.deepcopy(manifest)
        bad["pins"]["php"]["version"] = "latest"
        with self.assertRaises(InvalidToolchain):
            validate(bad)

    def test_rejects_wrong_major(self):
        manifest = load_manifest()
        for path, value in ((("pins", "php", "version"), "8.4.26"),
                            (("pins", "node", "version"), "25.6.0"),
                            (("pins", "composer", "version"), "3.0.0"),
                            (("pins", "psql", "version"), "18.6")):
            bad = copy.deepcopy(manifest)
            node = bad
            for part in path[:-1]:
                node = node[part]
            node[path[-1]] = value
            with self.assertRaises(InvalidToolchain, msg=value):
                validate(bad)

    def test_rejects_disabled_extension(self):
        manifest = load_manifest()
        bad = copy.deepcopy(manifest)
        bad["pins"]["extensions"]["gd"]["enabled"] = False
        with self.assertRaises(InvalidToolchain):
            validate(bad)

    def test_rejects_build_authority(self):
        manifest = load_manifest()
        bad = copy.deepcopy(manifest)
        bad["forbidden_preparation_actions"]["image_build"] = True
        with self.assertRaises(InvalidToolchain):
            validate(bad)
        bad = copy.deepcopy(manifest)
        bad["migration_authorized"] = True
        with self.assertRaises(InvalidToolchain):
            validate(bad)

    def test_rejects_duplicate_keys_and_nonfinite(self):
        with self.assertRaises(InvalidToolchain):
            parse(b'{"a": 1, "a": 2}')
        with self.assertRaises(InvalidToolchain):
            parse(b'{"a": NaN}')

    def test_cli_accepts_manifest(self):
        proc = subprocess.run([sys.executable, "-B", str(CHECKER), str(MANIFEST)],
                              capture_output=True, text=True, timeout=10)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        body = json.loads(proc.stdout)
        self.assertEqual(body["result"], "toolchain_pins_valid")
        self.assertFalse(body["admission_authorized"])

    def test_cli_rejects_broken_manifest_without_echo(self):
        manifest = load_manifest()
        manifest["pins"]["node"]["version"] = "latest"
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tmp:
            tmp.write(json.dumps(manifest).encode())
            path = tmp.name
        try:
            proc = subprocess.run([sys.executable, "-B", str(CHECKER), path],
                                  capture_output=True, text=True, timeout=10)
        finally:
            Path(path).unlink(missing_ok=True)
        self.assertEqual(proc.returncode, 1)
        body = json.loads(proc.stdout)
        self.assertEqual(body["result"], "toolchain_pins_rejected")
        self.assertNotIn("latest", json.dumps(body.get("reason", "")) or "")
        self.assertFalse(body["admission_authorized"])


if __name__ == "__main__":
    unittest.main()
