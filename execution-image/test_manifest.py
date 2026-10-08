#!/usr/bin/env python3
"""Offline source/fixture tests; no container, package manager, or compiler is used."""
import copy
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import validate as carrier

ROOT = Path(__file__).resolve().parent


class SourcePacketTests(unittest.TestCase):
    def setUp(self):
        self.manifest, self.files = carrier.read_packet(ROOT / "manifest.json")

    def refuse(self, manifest=None, files=None, reason=None):
        with self.assertRaises(carrier.InvalidPacket) as caught:
            carrier.validate(manifest if manifest is not None else self.manifest,
                             files if files is not None else self.files)
        if reason:
            self.assertIn(reason, str(caught.exception))

    def rebind(self, name, content):
        self.files[name] = content
        self.manifest["files"][name] = hashlib.sha256(content).hexdigest()

    def test_checked_in_packet_is_source_only(self):
        result = carrier.validate(self.manifest, self.files)
        self.assertEqual(result["result"], "source_packet_consistent")
        self.assertEqual(result["state"], "unbuilt_recipe")
        self.assertIsNone(result["image_digest"])
        self.assertEqual(result["base_signature_verification"], "UNESTABLISHED")
        self.assertEqual(result["runtime_acceptance"], "UNESTABLISHED")
        self.assertIs(result["image_creation_authorized"], False)

    def test_mutable_base_wrong_repository_or_malformed_digest(self):
        for ref in ["ghcr.io/paperclipai/paperclip:latest",
                    "ghcr.io/paperclipai/paperclip:sha-" + "a" * 40,
                    "ghcr.io/other/paperclip@sha256:" + "a" * 64,
                    "ghcr.io/paperclipai/paperclip@sha256:" + "a" * 63]:
            with self.subTest(ref=ref):
                m = copy.deepcopy(self.manifest)
                m["base"]["image_ref"] = ref
                self.refuse(m, reason="base.image_ref")

    def test_wrong_provenance_identity(self):
        for field, value in [("source_repository", "other/paperclip"),
                             ("source_ref", "refs/heads/feature"),
                             ("source_revision", "short"),
                             ("signer_workflow", "untrusted/workflow"),
                             ("independent_signature_verification", "VERIFIED")]:
            with self.subTest(field=field):
                m = copy.deepcopy(self.manifest)
                m["base"][field] = value
                self.refuse(m)

    def test_missing_and_unknown_fields_fail_closed(self):
        for path in [(), ("base",), ("wrapper",), ("files",), ("output",), ("authorization",)]:
            for operation in ["missing", "extra"]:
                with self.subTest(path=path, operation=operation):
                    m = copy.deepcopy(self.manifest)
                    node = m
                    for part in path:
                        node = node[part]
                    if operation == "missing":
                        del node[next(iter(node))]
                    else:
                        node["unexpected"] = None
                    self.refuse(m)

    def test_source_wrapper_and_config_pins_required(self):
        for section, key in [(None, "carrier_base_revision"),
                             ("wrapper", "source_revision"), ("wrapper", "sha256"),
                             ("wrapper", "toolchain_file_sha256"), ("files", "runtime-contract.json")]:
            for value in [None, "", "UNKNOWN", "a" * 7, 123]:
                with self.subTest(section=section, key=key, value=value):
                    m = copy.deepcopy(self.manifest)
                    node = m[section] if section else m
                    node[key] = value
                    self.refuse(m)

    def test_every_bound_file_detects_drift(self):
        for name in carrier.FILES:
            with self.subTest(name=name):
                files = dict(self.files)
                files[name] += b"\n"
                self.refuse(files=files, reason="source hash drift")

    def test_claims_cannot_be_promoted(self):
        for key in self.manifest["output"]:
            m = copy.deepcopy(self.manifest)
            m["output"][key] = "sha256:" + "a" * 64
            self.refuse(m, reason="nothing produced or accepted")
        for key in self.manifest["authorization"]:
            for value in [True, 0, "false", None]:
                m = copy.deepcopy(self.manifest)
                m["authorization"][key] = value
                self.refuse(m, reason="no action authorized")
        m = copy.deepcopy(self.manifest)
        m["state"] = "produced_image"
        self.refuse(m, reason="source only")

    def test_rebound_recipe_cannot_add_runtime_or_live_hooks(self):
        for suffix in [b"RUN cargo build\n", b"ENV CC=/other/cc\n", b"ARG BASE_IMAGE\n",
                       b"COPY app /app\n", b"USER 0:0\n", b"VOLUME /pool\n",
                       b"ENTRYPOINT [\"install-on-start\"]\n"]:
            with self.subTest(suffix=suffix):
                m = copy.deepcopy(self.manifest)
                f = dict(self.files)
                f["Dockerfile"] += suffix
                m["files"]["Dockerfile"] = hashlib.sha256(f["Dockerfile"]).hexdigest()
                self.refuse(m, f, "recipe drift")

    def test_rebound_recipe_cannot_bypass_root_startup_initialization(self):
        for user in [b"1000:1000", b"node"]:
            with self.subTest(user=user):
                m = copy.deepcopy(self.manifest)
                f = dict(self.files)
                f["Dockerfile"] += b"USER " + user + b"\n"
                m["files"]["Dockerfile"] = hashlib.sha256(f["Dockerfile"]).hexdigest()
                self.refuse(m, f, "recipe drift")

    def test_rebound_recipe_cannot_check_compiler_as_root(self):
        for replacement in [b"gosu 0:0 sh -eu -c", b"sh -eu -c"]:
            with self.subTest(replacement=replacement):
                m = copy.deepcopy(self.manifest)
                f = dict(self.files)
                f["Dockerfile"] = f["Dockerfile"].replace(b"gosu 1000:1000 sh -eu -c", replacement)
                m["files"]["Dockerfile"] = hashlib.sha256(f["Dockerfile"]).hexdigest()
                self.refuse(m, f, "recipe drift")

    def test_unpinned_or_injected_native_versions(self):
        for value in [None, "latest", "14.*", "14;curl", "14\nRUN evil", 14, "14 15"]:
            n = carrier.parse(self.files["native-packages.json"])
            n["packages"]["gcc"] = value
            raw = json.dumps(n).encode()
            m = copy.deepcopy(self.manifest)
            f = dict(self.files)
            f["native-packages.json"] = raw
            m["files"]["native-packages.json"] = hashlib.sha256(raw).hexdigest()
            self.refuse(m, f, "native.packages.gcc")

    def test_rebound_config_cannot_weaken_boundary(self):
        for key, value in [("execution_user", "0:0"), ("startup_user", "1000:1000"),
                           ("wrapper", "direct_cargo"),
                           ("pool", "new_pool"), ("compiler_paths", ["/host/gcc"]),
                           ("runtime_policy", "writable_app"), ("adoption", "accepted")]:
            with self.subTest(key=key):
                r = carrier.parse(self.files["runtime-contract.json"])
                r[key] = value
                m = copy.deepcopy(self.manifest)
                f = dict(self.files)
                f["runtime-contract.json"] = json.dumps(r).encode()
                m["files"]["runtime-contract.json"] = hashlib.sha256(f["runtime-contract.json"]).hexdigest()
                self.refuse(m, f, "runtime contract drift")

    def test_apt_trust_and_snapshot_drift_refused_even_if_rebound(self):
        self.rebind("native.sources", self.files["native.sources"].replace(
            b"Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg", b"Trusted: yes"))
        self.refuse(reason="APT sources drift")

    def test_recipe_independent_instruction_assertions(self):
        recipe = self.files["Dockerfile"].decode()
        instructions = [line.split()[0] for line in recipe.splitlines()
                        if line and not line.startswith(("#", " "))]
        self.assertEqual(instructions, ["FROM", "USER", "COPY", "RUN", "RUN"])
        self.assertEqual([line for line in recipe.splitlines() if line.startswith("USER ")], ["USER 0:0"])
        self.assertIn("RUN gosu 1000:1000 sh -eu -c 'test \"$(id -u):$(id -g)\" = 1000:1000", recipe)
        self.assertIn("--no-install-recommends", recipe)
        self.assertIn("-o Dir::Etc::sourceparts=-", recipe)
        for name, version in carrier.parse(self.files["native-packages.json"])["packages"].items():
            self.assertIn(name + "=" + version, recipe)
            self.assertIn(f"dpkg-query -W -f='${{Version}}' {name}", recipe)
        for forbidden in ["--allow-unauthenticated", "--allow-downgrades", "sudo", "cargo ", "curl "]:
            self.assertNotIn(forbidden, recipe)

    def test_validation_does_not_call_network_or_process_tools(self):
        with patch.object(socket, "socket", side_effect=AssertionError("network called")), \
             patch.object(subprocess, "run", side_effect=AssertionError("process called")), \
             patch.object(subprocess, "Popen", side_effect=AssertionError("process called")):
            carrier.validate(self.manifest, self.files)
            carrier.read_packet(ROOT / "manifest.json")

    def test_json_duplicate_nonfinite_malformed_oversize(self):
        for raw in [b'{"schema":1,"schema":2}', b'{"x":NaN}', b'{"x":Infinity}',
                    b'\xff', b'{', b'[' * 2000, b' ' * (carrier.MAX_BYTES + 1)]:
            with self.subTest(raw=raw[:40]):
                with self.assertRaises(carrier.InvalidPacket):
                    carrier.parse(raw)

    def test_cli_rejects_tamper_and_missing_input(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            for name, content in self.files.items():
                (p / name).write_bytes(content)
            (p / "manifest.json").write_text(json.dumps(self.manifest))
            command = [sys.executable, "-B", str(ROOT / "validate.py"), str(p / "manifest.json")]
            good = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(good.returncode, 0, good.stdout + good.stderr)
            (p / "Dockerfile").write_text("FROM mutable:latest\n")
            bad = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(bad.returncode, 1)
            self.assertEqual(json.loads(bad.stdout)["result"], "source_packet_rejected")
            (p / "runtime-contract.json").unlink()
            missing = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(missing.returncode, 1)
            self.assertIn("source input unavailable", missing.stdout)

    def test_source_symlink_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            (p / "manifest.json").write_text(json.dumps(self.manifest))
            (p / "Dockerfile").symlink_to(ROOT / "Dockerfile")
            with self.assertRaisesRegex(carrier.InvalidPacket, "non-regular source refused"):
                carrier.read_packet(p / "manifest.json")

    def test_fifo_manifest_and_source_refused_without_blocking(self):
        for name in ["manifest.json", "Dockerfile"]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                p = Path(tmp)
                if name != "manifest.json":
                    (p / "manifest.json").write_text(json.dumps(self.manifest))
                os.mkfifo(p / name)
                result = subprocess.run([sys.executable, "-B", str(ROOT / "validate.py"),
                                         str(p / "manifest.json")],
                                        capture_output=True, text=True, timeout=3)
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn("non-regular source refused", result.stdout)

    def test_fifo_swapped_after_path_check_refused_on_descriptor(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "input"
            os.mkfifo(path)
            with patch.object(Path, "lstat", return_value=(ROOT / "Dockerfile").stat()):
                with self.assertRaisesRegex(carrier.InvalidPacket, "non-regular source refused"):
                    carrier.read_regular(path)


if __name__ == "__main__":
    unittest.main()
