#!/usr/bin/env python3
"""Offline test-class profile checks only; never admission, authorization or host proof."""

import argparse
import json
import re
import sys
from pathlib import Path

SCHEMA = "garm-test-profile-receipt.v1"
PAIR_SCHEMAS = {"garm-test-profile-receipt.v1", "garm-rehearsal-receipt.v1"}
MAX_BYTES = 1024 * 1024
ROLE = "test-private"
TOOLS = {"runner", "node", "php", "composer", "psql", "cc"}
PROBES = {"native_build", "native_postgres", "sudo_denied",
          "docker_unix_denied", "docker_tcp_denied", "sibling_data_denied",
          "metadata_denied", "host_services_denied"}
NETWORK_DENIES = {"metadata_denied", "host_services_denied", "production_denied"}
ELIGIBLE_LABELS = {"self-hosted", "example-test"}
INELIGIBLE_REQUIRED = {"example-ephemeral", "example-selfhosted", "example-isolated"}
RESOURCES = {"cpu": 2, "ram_mib": 4096, "disk_gib": 20,
             "safe_max": 1, "configured_max": 2}
SIZE_CAPS = {"image_gib": 20, "workspace_gib": 20, "log_retention_days": 30}
NODE_SERIES = "24"
PHP_SERIES = "8.5"
COMPOSER_SERIES = "2"
EXTENSIONS = {"pdo_pgsql", "zip", "gd", "pcov"}
FORBIDDEN_ACTIONS = {
    "workflow_edit", "routing_change", "pool_change", "cap_change",
    "static_service_change", "active_work_aborted", "credential_change",
    "provider_restart", "running_vm_profile_change", "cache_removal",
}


class InvalidProfile(ValueError):
    pass


def require(condition, field):
    if not condition:
        raise InvalidProfile(field)


def obj(value, keys, field):
    require(type(value) is dict, field + ": object required")
    require(set(value) == set(keys), field + ": missing or unexpected fields")
    return value


def flag(value, expected, field):
    require(type(value) is bool and value is expected, field)


def text(value, field):
    require(type(value) is str and 0 < len(value) <= 200
            and re.fullmatch(r"[A-Za-z0-9._:/@+-]+", value) is not None, field)
    require(value.upper() not in {"UNKNOWN", "TODO", "UNVERIFIED", "TBD"}, field)


def digest(value, length, field):
    require(type(value) is str and re.fullmatch(r"[0-9a-f]{%d}" % length, value)
            is not None, field)


def image_trio(receipt, field="image"):
    im = receipt.get(field)
    require(type(im) is dict, field + ": object required")
    for key in ("fingerprint", "profile_sha256", "inputs_sha256"):
        require(key in im, field + ": missing " + key)
        digest(im[key], 64, field + "." + key)
    return (im["fingerprint"], im["profile_sha256"], im["inputs_sha256"])


def validate(receipt):
    """Validate a synthetic test-class profile receipt, without any I/O."""
    r = obj(receipt, {"schema", "evidence_class", "role", "source",
                      "image", "runtime", "docker", "network_deny", "probes",
                      "labels", "resources", "ephemeral", "size_caps",
                      "toolchain", "actions"}, "receipt")
    require(r["schema"] == SCHEMA, "schema")
    require(r["evidence_class"] == "synthetic", "evidence_class: synthetic only")
    require(r["role"] == ROLE, "role: test-private only")

    s = obj(r["source"], {"revision", "bundle_sha256"}, "source")
    digest(s["revision"], 40, "source.revision")
    digest(s["bundle_sha256"], 64, "source.bundle_sha256")

    im = obj(r["image"], {"fingerprint", "profile_sha256", "inputs_sha256",
                          "sudo", "docker", "tool_versions",
                          "node24_runner_smoke", "rebuild_receipt_present"},
             "image")
    for key in ("fingerprint", "profile_sha256", "inputs_sha256"):
        digest(im[key], 64, "image." + key)
    flag(im["sudo"], False, "image.sudo: test jobs never run with sudo")
    flag(im["docker"], False, "image.docker: test jobs never get Docker")
    flag(im["node24_runner_smoke"], True, "image.node24_runner_smoke")
    flag(im["rebuild_receipt_present"], True, "image.rebuild_receipt_present")
    versions = obj(im["tool_versions"], TOOLS, "image.tool_versions")
    for name, version in versions.items():
        text(version, "tool_version." + name)
        require(re.fullmatch(r"\d+\.\d+\.\d+(?:[.+-][A-Za-z0-9.-]+)?", version)
                is not None, "tool_version." + name + ": exact version required")
    require(versions["node"].startswith(NODE_SERIES + "."),
            "tool_version.node: Node24 required")
    require(versions["php"].startswith(PHP_SERIES + "."),
            "tool_version.php: PHP8.5 required")
    require(versions["composer"].startswith(COMPOSER_SERIES + "."),
            "tool_version.composer: Composer2 required")

    rt = obj(r["runtime"], {"user", "root", "sudo", "login_shell"}, "runtime")
    require(type(rt["user"]) is str and re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}",
            rt["user"]) is not None, "runtime.user: non-root account name required")
    require(rt["user"] not in {"root", "0", "admin", "administrator"},
            "runtime.user: privileged account refused")
    flag(rt["root"], False, "runtime.root: jobs never run as root")
    flag(rt["sudo"], False, "runtime.sudo: test role has no sudo")
    flag(rt["login_shell"], False, "runtime.login_shell")

    dk = obj(r["docker"], {"client_installed", "daemon_reachable",
                           "socket_present", "tcp_relay_reachable",
                           "docker_host_set"}, "docker")
    for key in ("client_installed", "daemon_reachable", "socket_present",
                "tcp_relay_reachable", "docker_host_set"):
        flag(dk[key], False, "docker." + key + ": no Docker surface on test")

    net = obj(r["network_deny"], NETWORK_DENIES, "network_deny")
    for name, probe in net.items():
        obj(probe, {"result", "positive_control_passed"}, "network." + name)
        require(probe["result"] == "pass", "network." + name + ": not pass")
        flag(probe["positive_control_passed"], True,
             "network." + name + ": no positive control")

    probes = obj(r["probes"], PROBES, "probes")
    for name, probe in probes.items():
        obj(probe, {"result", "positive_control_passed"}, "probe." + name)
        require(probe["result"] == "pass", "probe." + name + ": not pass")
        flag(probe["positive_control_passed"], True,
             "probe." + name + ": no positive control")

    lb = obj(r["labels"], {"eligible", "ineligible"}, "labels")
    eligible = lb["eligible"]
    require(type(eligible) is list and len(eligible) == 2
            and set(eligible) == ELIGIBLE_LABELS, "labels.eligible")
    for label in eligible:
        text(label, "labels.eligible")
    ineligible = lb["ineligible"]
    require(type(ineligible) is list and 2 <= len(ineligible) <= 100,
            "labels.ineligible")
    for label in ineligible:
        text(label, "labels.ineligible")
    require(len(set(ineligible)) == len(ineligible), "labels: duplicate label")
    require(INELIGIBLE_REQUIRED <= set(ineligible), "labels: missing ineligible")
    require(not (set(eligible) & set(ineligible)), "labels: eligible overlap")

    rs = obj(r["resources"], {"cpu", "ram_mib", "disk_gib",
                              "safe_max", "configured_max"}, "resources")
    for key, expected in RESOURCES.items():
        require(type(rs[key]) is int and rs[key] == expected,
                "resources." + key + ": bounded profile ceiling only")

    ep = obj(r["ephemeral"], {"runner_ephemeral", "one_job_then_deregister",
                              "vm_absent_after_job",
                              "registration_absent_after_job"}, "ephemeral")
    for key in ("runner_ephemeral", "one_job_then_deregister",
                "vm_absent_after_job", "registration_absent_after_job"):
        flag(ep[key], True, "ephemeral." + key + ": one job per fresh VM")

    sc = obj(r["size_caps"], {"image_gib", "workspace_gib",
                              "log_retention_days"}, "size_caps")
    for key, expected in SIZE_CAPS.items():
        require(type(sc[key]) is int and sc[key] == expected,
                "size_caps." + key + ": bounded cap only")

    tc = obj(r["toolchain"], {"psql_on_path", "php_provides",
                              "composer_provides", "extensions_provided",
                              "node_series", "runner_smoke"}, "toolchain")
    flag(tc["psql_on_path"], True, "toolchain.psql_on_path")
    flag(tc["php_provides"], True, "toolchain: PHP lives on test role")
    flag(tc["composer_provides"], True, "toolchain: Composer lives on test role")
    require(type(tc["extensions_provided"]) is list
            and set(tc["extensions_provided"]) == EXTENSIONS,
            "toolchain: test provides the pinned PHP extension set")
    require(tc["node_series"] == NODE_SERIES, "toolchain.node_series")
    flag(tc["runner_smoke"], True, "toolchain.runner_smoke")

    actions = obj(r["actions"], FORBIDDEN_ACTIONS, "actions")
    for key, value in actions.items():
        flag(value, False, "actions." + key + ": prohibited in preparation")
    return {"schema": SCHEMA, "result": "offline_profile_valid",
            "evidence_class": "synthetic", "admission_authorized": False,
            "host_verified": False, "migration_complete": False}


def validate_pair(first, second):
    """Enforce image/profile/inputs distinctness across two synthetic receipts.

    A test image must never reuse another role's image: one receipt cannot
    prove its digests differ from another role's. Accepts either this profile
    schema or the rehearsal receipt schema on each side; both must be
    synthetic, and all three digests must differ pairwise.
    """
    for name, receipt in (("first", first), ("second", second)):
        require(type(receipt) is dict, name + ": object required")
        require(receipt.get("schema") in PAIR_SCHEMAS, name + ": unknown schema")
        require(receipt.get("evidence_class") == "synthetic",
                name + ": synthetic only")
    trio_a = image_trio(first, "image")
    trio_b = image_trio(second, "image")
    for key, digest_a, digest_b in zip(
            ("fingerprint", "profile_sha256", "inputs_sha256"), trio_a, trio_b):
        require(digest_a != digest_b, "pair: shared " + key)
    return {"schema": SCHEMA, "result": "pair_distinct_valid",
            "evidence_class": "synthetic", "admission_authorized": False,
            "host_verified": False, "migration_complete": False}


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value, "JSON: duplicate key")
        value[key] = item
    return value


def parse(raw):
    require(len(raw) <= MAX_BYTES, "JSON: input exceeds 1MiB")

    def reject_constant(_value):
        raise InvalidProfile("JSON: non-finite number")
    try:
        return json.loads(raw, object_pairs_hook=unique_object,
                          parse_constant=reject_constant)
    except InvalidProfile:
        raise
    except (ValueError, UnicodeDecodeError, RecursionError):
        raise InvalidProfile("JSON: malformed input") from None


def read_receipt(path):
    with path.open("rb") as stream:
        return parse(stream.read(MAX_BYTES + 1))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("receipt", type=Path,
                        help="nonsecret, fabricated test profile JSON")
    parser.add_argument("other", type=Path, nargs="?",
                        help="optional second receipt for pair-distinctness check")
    args = parser.parse_args()
    try:
        if args.other is None:
            result = validate(read_receipt(args.receipt))
        else:
            result = validate_pair(read_receipt(args.receipt),
                                   read_receipt(args.other))
    except (InvalidProfile, OSError) as exc:
        reason = str(exc) if isinstance(exc, InvalidProfile) else "input file unavailable"
        rejected = "pair_rejected" if args.other is not None else "offline_profile_rejected"
        print(json.dumps({"result": rejected, "reason": reason,
                          "admission_authorized": False}))
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
