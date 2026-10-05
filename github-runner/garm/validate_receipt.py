#!/usr/bin/env python3
"""Offline contract checks only; never admission, authorization or host proof."""

import argparse
import json
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

SCHEMA = "garm-rehearsal-receipt.v1"
MAX_BYTES = 1024 * 1024
ROLES = {
    "privileged-private": {
        "sudo": True, "docker": True,
        "tools": {"runner", "node", "php", "composer", "psql", "docker"},
        "probes": {"native_build", "ci_postgres", "service_loopback",
                   "metadata_denied", "host_services_denied"},
    },
    "isolated-private": {
        "sudo": False, "docker": False,
        "tools": {"runner", "node", "cc", "psql"},
        "probes": {"native_build", "native_postgres", "sudo_denied",
                   "docker_unix_denied", "docker_tcp_denied", "sibling_data_denied",
                   "metadata_denied", "host_services_denied"},
    },
}
FORBIDDEN_ACTIONS = {
    "workflow_edit", "routing_change", "pool_change", "cap_change",
    "static_service_change", "active_work_aborted", "credential_change",
    "provider_restart", "running_vm_profile_change", "cache_removal",
}


class InvalidReceipt(ValueError):
    pass


def require(condition, field):
    if not condition:
        raise InvalidReceipt(field)


def obj(value, keys, field):
    require(type(value) is dict, field + ": object required")
    require(set(value) == set(keys), field + ": missing or unexpected fields")
    return value


def flag(value, expected, field):
    require(type(value) is bool and value is expected, field)


def integer(value, minimum, field):
    require(type(value) is int and value >= minimum, field)
    return value


def text(value, field):
    require(type(value) is str and 0 < len(value) <= 200
            and re.fullmatch(r"[A-Za-z0-9._:/@+-]+", value) is not None, field)
    require(value.upper() not in {"UNKNOWN", "TODO", "UNVERIFIED", "TBD"}, field)
    return value


def digest(value, length, field):
    require(type(value) is str and re.fullmatch(r"[0-9a-f]{%d}" % length, value)
            is not None, field)


def instant(value, field):
    require(type(value) is str and re.fullmatch(
        r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z", value) is not None, field)
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        raise InvalidReceipt(field) from None


def validate(receipt, at):
    """Validate a synthetic receipt at an explicit UTC instant, without any I/O."""
    now = instant(at, "evaluation time")
    r = obj(receipt, {"schema", "evidence_class", "role", "source", "target",
                      "image", "trust", "budget", "probes", "job", "cleanup",
                      "actions"}, "receipt")
    require(r["schema"] == SCHEMA, "schema")
    require(r["evidence_class"] == "synthetic", "evidence_class: synthetic only")
    require(type(r["role"]) is str and r["role"] in ROLES, "role")
    role = ROLES[r["role"]]

    s = obj(r["source"], {"revision", "bundle_sha256"}, "source")
    digest(s["revision"], 40, "source.revision")
    digest(s["bundle_sha256"], 64, "source.bundle_sha256")

    t = obj(r["target"], {"host", "pool", "provider", "garm_version",
                          "provider_version", "lxd_version", "selector",
                          "inventory_complete", "enabled_pools"}, "target")
    require(t["host"] == "fixture-host-a", "target.host: synthetic contract is fixture-host-a only")
    for key in ("pool", "provider", "selector"):
        text(t[key], "target." + key)
    require(t["garm_version"] == "0.2.1", "target.garm_version")
    require(t["provider_version"] == "0.1.3", "target.provider_version")
    require(t["lxd_version"] == "5.21", "target.lxd_version")
    flag(t["inventory_complete"], True, "target.inventory_complete")
    pools = t["enabled_pools"]
    require(type(pools) is list and 0 < len(pools) <= 100, "target.enabled_pools")
    identities, matching = set(), []
    for p in pools:
        obj(p, {"pool", "host", "provider", "selectors"}, "enabled_pool")
        for key in ("pool", "host", "provider"):
            text(p[key], "enabled_pool." + key)
        require(p["pool"] not in identities, "enabled_pool: duplicate pool identity")
        identities.add(p["pool"])
        selectors = p["selectors"]
        require(type(selectors) is list and 0 < len(selectors) <= 100,
                "enabled_pool.selectors")
        for selector in selectors:
            text(selector, "enabled_pool.selector")
        require(len(set(selectors)) == len(selectors), "enabled_pool: duplicate selector")
        if t["selector"] in selectors:
            matching.append(p)
    require(len(matching) == 1, "selector: must match exactly one enabled pool")
    for key in ("pool", "host", "provider"):
        require(matching[0][key] == t[key], "selector: target identity mismatch")

    im = obj(r["image"], {"fingerprint", "profile_sha256", "inputs_sha256",
                         "sudo", "docker", "tool_versions", "node24_runner_smoke",
                         "rebuild_receipt_present"}, "image")
    for key in ("fingerprint", "profile_sha256", "inputs_sha256"):
        digest(im[key], 64, "image." + key)
    flag(im["sudo"], role["sudo"], "image.sudo")
    flag(im["docker"], role["docker"], "image.docker")
    flag(im["node24_runner_smoke"], True, "image.node24_runner_smoke")
    flag(im["rebuild_receipt_present"], True, "image.rebuild_receipt_present")
    versions = obj(im["tool_versions"], role["tools"], "image.tool_versions")
    for name, version in versions.items():
        text(version, "tool_version." + name)
        require(re.fullmatch(r"\d+\.\d+\.\d+(?:[.+-][A-Za-z0-9.-]+)?", version)
                is not None, "tool_version." + name + ": exact version required")
    require(versions["node"].startswith("24."), "tool_version.node: Node24 required")
    if r["role"] == "privileged-private":
        require(versions["php"].startswith("8.5."), "tool_version.php: PHP8.5 required")
        require(versions["composer"].startswith("2."), "tool_version.composer")

    tr = obj(r["trust"], {"repository", "visibility", "runner_group_verified",
                          "trusted_ref_policy_verified", "public_pr_excluded",
                          "required_checks_verified", "blocking_gate_unchanged",
                          "cancel_in_progress", "db_target"}, "trust")
    text(tr["repository"], "trust.repository")
    require(re.fullmatch(r"TogetherWeOwn/[A-Za-z0-9_.-]+", tr["repository"])
            is not None, "trust.repository")
    require(tr["repository"].lower() not in {
        "togetherweown/example-public-web", "togetherweown/example-public-bot",
    }, "trust.repository: denied public example repositories stay hosted")
    require(tr["visibility"] == "private", "trust.visibility")
    for key in ("runner_group_verified", "trusted_ref_policy_verified", "public_pr_excluded",
                "required_checks_verified", "blocking_gate_unchanged"):
        flag(tr[key], True, "trust." + key)
    flag(tr["cancel_in_progress"], False, "trust.cancel_in_progress")
    require(tr["db_target"] == "disposable-ci-service", "trust.db_target")

    b = obj(r["budget"], {"observed_at", "all_reservations_accounted",
                           "pressure_clear", "filesystems", "configured_max",
                           "safe_max", "active_vms", "reserved_vms", "requested_vms",
                           "available_cpu", "requested_cpu", "available_ram_mib",
                           "requested_ram_mib", "available_disk_gib", "requested_disk_gib"},
            "budget")
    observed = instant(b["observed_at"], "budget.observed_at")
    require(timedelta(0) <= now - observed <= timedelta(minutes=15),
            "budget: stale or future sample (draft fixture horizon 15m)")
    for key in ("all_reservations_accounted", "pressure_clear"):
        flag(b[key], True, "budget." + key)
    fs = b["filesystems"]
    require(type(fs) is list and 0 < len(fs) <= 20, "budget.filesystems")
    mounts = set()
    for f in fs:
        obj(f, {"mount", "used_percent"}, "filesystem")
        text(f["mount"], "filesystem.mount")
        require(f["mount"] not in mounts, "filesystem: duplicate mount")
        mounts.add(f["mount"])
        used = f["used_percent"]
        require(type(used) in (int, float) and 0 <= used < 95,
                "filesystem: >=95 percent or invalid sample")
    require({"/", "/home"} <= mounts, "filesystem: root/home inventory missing")
    integer(b["configured_max"], 1, "budget.configured_max")
    require(b["configured_max"] == 2, "budget.configured_max: source baseline only")
    require(type(b["safe_max"]) is int and b["safe_max"] == 1,
            "budget.safe_max: preserve historical <=1 ceiling")
    for key in ("active_vms", "reserved_vms"):
        integer(b[key], 0, "budget." + key)
    require(type(b["requested_vms"]) is int and b["requested_vms"] == 1,
            "budget.requested_vms: one disposable VM")
    require(b["active_vms"] + b["reserved_vms"] + b["requested_vms"] <= b["safe_max"],
            "budget: active and pending/reserved VM count exceeds ceiling")
    for resource in ("cpu", "ram_mib", "disk_gib"):
        available = integer(b["available_" + resource], 0, "budget.available_" + resource)
        requested = integer(b["requested_" + resource], 1, "budget.requested_" + resource)
        require(requested <= available, "budget: insufficient " + resource)

    probes = obj(r["probes"], role["probes"], "probes")
    for name, probe in probes.items():
        obj(probe, {"result", "positive_control_passed"}, "probe." + name)
        require(probe["result"] == "pass", "probe." + name + ": not pass")
        flag(probe["positive_control_passed"], True, "probe." + name + ": no positive control")

    job = obj(r["job"], {"run", "runner", "vm", "host", "pool", "provider",
                         "image_fingerprint", "mapping_verified", "completed_at",
                         "conclusion", "artifacts_complete"}, "job")
    for key in ("run", "runner", "vm"):
        text(job[key], "job." + key)
    require(job["runner"].startswith("garm-"), "job.runner")
    for key in ("host", "pool", "provider"):
        require(job[key] == t[key], "job: target identity mismatch")
    require(job["image_fingerprint"] == im["fingerprint"], "job: wrong image")
    flag(job["mapping_verified"], True, "job.mapping_verified")
    require(job["conclusion"] == "success", "job.conclusion")
    flag(job["artifacts_complete"], True, "job.artifacts_complete")
    completed = instant(job["completed_at"], "job.completed_at")
    require(observed <= completed <= now, "job: invalid completion sequence")

    cl = obj(r["cleanup"], {"run", "runner", "vm", "host", "pool", "provider",
                           "observed_at", "vm_absent", "registration_absent"}, "cleanup")
    for key in ("run", "runner", "vm", "host", "pool", "provider"):
        require(cl[key] == job[key], "cleanup: uncorrelated " + key)
    cleaned = instant(cl["observed_at"], "cleanup.observed_at")
    require(completed <= cleaned <= now, "cleanup: invalid timestamp sequence")
    for key in ("vm_absent", "registration_absent"):
        flag(cl[key], True, "cleanup." + key)
    actions = obj(r["actions"], FORBIDDEN_ACTIONS, "actions")
    for key, value in actions.items():
        flag(value, False, "actions." + key + ": prohibited in preparation")
    return {"schema": SCHEMA, "result": "offline_contract_valid",
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
        raise InvalidReceipt("JSON: non-finite number")
    try:
        return json.loads(raw, object_pairs_hook=unique_object, parse_constant=reject_constant)
    except InvalidReceipt:
        raise
    except (ValueError, UnicodeDecodeError, RecursionError):
        raise InvalidReceipt("JSON: malformed input") from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("receipt", type=Path, help="nonsecret, fabricated receipt JSON")
    parser.add_argument("--at", required=True, help="explicit UTC evaluation time, YYYY-MM-DDTHH:MM:SSZ")
    args = parser.parse_args()
    try:
        with args.receipt.open("rb") as stream:
            raw = stream.read(MAX_BYTES + 1)
        result = validate(parse(raw), args.at)
    except (InvalidReceipt, OSError) as exc:
        # Never echo raw input, paths, credentials or arbitrary field values.
        reason = str(exc) if isinstance(exc, InvalidReceipt) else "input file unavailable"
        print(json.dumps({"result": "offline_contract_rejected", "reason": reason,
                          "admission_authorized": False}))
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
