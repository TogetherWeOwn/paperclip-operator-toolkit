#!/usr/bin/env python3
"""Offline isolated-image build-manifest checks only; never admission, authorization or host proof."""

import argparse
import json
import re
import sys
from pathlib import Path

SCHEMA = "garm-isolated-build-manifest.v1"
MAX_BYTES = 1024 * 1024
ROLE = "isolated-private"
DISTRIBUTION = "ubuntu-24.04"
NODE_SERIES = "24"
POSTGRES_FLAVOR = "16"
POSTGRES_PACKAGES = ["postgresql-16", "postgresql-client-16"]
RUNNER_ENV_KEYS = ("RUNNER_VERSION", "RUNNER_ARCHIVE", "RUNNER_URL", "RUNNER_SHA256")
RESOURCES = {"cpu": 2, "ram_mib": 4096, "disk_gib": 20,
             "safe_max": 1, "configured_max": 2}
HOLD_SENTENCE = "HOLD; nulls are not pins and cannot be used to build or execute"
STATUS = "synthetic-preparation-only"


class InvalidManifest(ValueError):
    pass


def require(condition, field):
    if not condition:
        raise InvalidManifest(field)


def obj(value, keys, field):
    require(type(value) is dict, field + ": object required")
    require(set(value) == set(keys), field + ": missing or unexpected fields")
    return value


def flag(value, expected, field):
    require(type(value) is bool and value is expected, field)


def text(value, field):
    require(type(value) is str and 0 < len(value) <= 500
            and re.fullmatch(r"[A-Za-z0-9._:/@+-]+", value) is not None, field)
    require(value.upper() not in {"UNKNOWN", "TODO", "UNVERIFIED", "TBD"}, field)
    return value


def digest(value, length, field):
    require(type(value) is str and re.fullmatch(r"[0-9a-f]{%d}" % length, value)
            is not None, field)


def load_runner_env(path):
    """Read KEY=VALUE pins from github-runner/actions-runner.env."""
    pairs = {}
    with open(path, "r", encoding="utf-8") as stream:
        for line in stream:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            pairs[key.strip()] = value.strip()
    for key in RUNNER_ENV_KEYS:
        require(key in pairs and len(pairs[key]) > 0,
                "runner env: missing " + key)
    return pairs


def validate(manifest, runner_env):
    """Validate a synthetic build manifest against pinned runner-env pins, without any other I/O."""
    r = obj(manifest, {"schema", "evidence_class", "role", "base",
                       "toolchain", "runtime", "docker", "resources",
                       "cloud_init_sha256", "output",
                       "missing_input_disposition", "admission_authorized",
                       "host_verified", "migration_complete", "installed",
                       "status"}, "receipt")
    require(r["schema"] == SCHEMA, "schema")
    require(r["evidence_class"] == "synthetic", "evidence_class: synthetic only")
    require(r["role"] == ROLE, "role: isolated-private only")

    base = obj(r["base"], {"distribution", "image_alias",
                           "base_image_fingerprint",
                           "packages_snapshot_sha256"}, "base")
    require(base["distribution"] == DISTRIBUTION, "base.distribution")
    for key in ("image_alias", "base_image_fingerprint",
                "packages_snapshot_sha256"):
        require(base[key] is None, "base." + key + ": HOLD; operator pins at build")

    tc = obj(r["toolchain"], {"node_series", "node_version", "postgres",
                              "cc_present", "runner_version",
                              "runner_archive", "runner_url",
                              "runner_sha256"}, "toolchain")
    require(tc["node_series"] == NODE_SERIES, "toolchain.node_series")
    require(tc["node_version"] is None,
            "toolchain.node_version: HOLD; operator pins exact at build")
    pg = obj(tc["postgres"], {"flavor", "packages", "versions"}, "postgres")
    require(pg["flavor"] == POSTGRES_FLAVOR, "postgres.flavor")
    require(pg["packages"] == POSTGRES_PACKAGES, "postgres.packages")
    require(pg["versions"] is None,
            "postgres.versions: HOLD; operator pins exact at build")
    flag(tc["cc_present"], True, "toolchain.cc_present")
    text(tc["runner_version"], "toolchain.runner_version")
    text(tc["runner_archive"], "toolchain.runner_archive")
    require(tc["runner_archive"].endswith(".tar.gz"), "toolchain.runner_archive")
    text(tc["runner_url"], "toolchain.runner_url")
    require(tc["runner_url"].startswith(
        "https://github.com/actions/runner/releases/download/"),
        "toolchain.runner_url")
    digest(tc["runner_sha256"], 64, "toolchain.runner_sha256")
    for key, field in (("RUNNER_VERSION", "runner_version"),
                       ("RUNNER_ARCHIVE", "runner_archive"),
                       ("RUNNER_URL", "runner_url"),
                       ("RUNNER_SHA256", "runner_sha256")):
        require(tc[field] == runner_env[key],
                "toolchain." + field + ": drift from actions-runner.env")

    rt = obj(r["runtime"], {"user", "root", "sudo", "login_shell"}, "runtime")
    require(type(rt["user"]) is str and re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}",
            rt["user"]) is not None, "runtime.user: non-root account name required")
    require(rt["user"] not in {"root", "0", "admin", "administrator"},
            "runtime.user: privileged account refused")
    flag(rt["root"], False, "runtime.root")
    flag(rt["sudo"], False, "runtime.sudo")
    flag(rt["login_shell"], False, "runtime.login_shell")

    dk = obj(r["docker"], {"client_installed", "daemon_reachable",
                           "socket_present", "tcp_relay_reachable",
                           "docker_host_set"}, "docker")
    for key in ("client_installed", "daemon_reachable", "socket_present",
                "tcp_relay_reachable", "docker_host_set"):
        flag(dk[key], False, "docker." + key + ": no Docker surface on isolated")

    rs = obj(r["resources"], {"cpu", "ram_mib", "disk_gib",
                              "safe_max", "configured_max"}, "resources")
    for key, expected in RESOURCES.items():
        require(type(rs[key]) is int and rs[key] == expected,
                "resources." + key + ": bounded profile ceiling only")

    require(r["cloud_init_sha256"] is None,
            "cloud_init_sha256: HOLD; generated at build from pinned flags")
    out = obj(r["output"], {"output_image_fingerprint", "profile_sha256",
                            "inputs_sha256", "rebuild_receipt_present"},
              "output")
    for key in ("output_image_fingerprint", "profile_sha256", "inputs_sha256"):
        require(out[key] is None, "output." + key + ": HOLD; nothing built yet")
    flag(out["rebuild_receipt_present"], False, "output.rebuild_receipt_present")

    require(r["missing_input_disposition"] == HOLD_SENTENCE,
            "missing_input_disposition")
    for key in ("admission_authorized", "host_verified", "migration_complete",
                "installed"):
        flag(r[key], False, key)
    require(r["status"] == STATUS, "status")
    return {"schema": SCHEMA, "result": "offline_build_manifest_valid",
            "evidence_class": "synthetic", "image_built": False,
            "admission_authorized": False, "host_verified": False,
            "migration_complete": False}


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value, "JSON: duplicate key")
        value[key] = item
    return value


def parse(raw):
    require(len(raw) <= MAX_BYTES, "JSON: input exceeds 1MiB")

    def reject_constant(_value):
        raise InvalidManifest("JSON: non-finite number")
    try:
        return json.loads(raw, object_pairs_hook=unique_object,
                          parse_constant=reject_constant)
    except InvalidManifest:
        raise
    except (ValueError, UnicodeDecodeError, RecursionError):
        raise InvalidManifest("JSON: malformed input") from None


def read_json(path):
    with path.open("rb") as stream:
        return parse(stream.read(MAX_BYTES + 1))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path,
                        help="nonsecret, fabricated build manifest JSON")
    parser.add_argument("--runner-env", type=Path, default=None,
                        help="pinned runner env file (default: github-runner/actions-runner.env)")
    args = parser.parse_args()
    try:
        env_path = args.runner_env
        if env_path is None:
            env_path = Path(__file__).resolve().parent.parent / "actions-runner.env"
        result = validate(read_json(args.manifest), load_runner_env(env_path))
    except (InvalidManifest, OSError) as exc:
        reason = str(exc) if isinstance(exc, InvalidManifest) else "input file unavailable"
        print(json.dumps({"result": "offline_build_manifest_rejected",
                          "reason": reason, "admission_authorized": False}))
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
