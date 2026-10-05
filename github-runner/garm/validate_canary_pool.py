#!/usr/bin/env python3
"""Offline canary-pool spec checks only; never admission, authorization or host proof."""

import argparse
import json
import re
import sys
from pathlib import Path

SCHEMA = "garm-canary-pool-spec.v1"
MAX_BYTES = 1024 * 1024
ROLE = "isolated"
HOST = "garm-host-a"
RUNNER_PREFIX = "garm-iso"
TAG_SET = {"self-hosted", "garm-managed"}
FLAVOR_PROFILE = "garm-isolated-2x4x20"
REQUIRED_FORBIDDEN = {"two-ephemeral", "two-isolated", "two-selfhosted"}
GARM_VERSION = "0.2.1"
PROVIDER_VERSION = "0.1.3"
LXD_VERSION = "5.21"
MIN_IDLE = 0
MAX_RUNNERS = 1
OS_TYPE = "linux"
OS_ARCH = "amd64"
HOLD_SENTENCE = "HOLD; nulls are not pins and cannot be used to build or execute"
STATUS = "synthetic-preparation-only"


class InvalidCanarySpec(ValueError):
    pass


def require(condition, field):
    if not condition:
        raise InvalidCanarySpec(field)


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
    return value


def prose(value, field):
    require(type(value) is str and 0 < len(value) <= 500
            and value.isascii() and value.isprintable(), field)
    require(value.strip().upper() not in {"UNKNOWN", "TODO", "UNVERIFIED", "TBD"},
            field)
    return value


def validate(spec):
    """Validate a synthetic step-1 canary pool spec, without any I/O."""
    r = obj(spec, {"schema", "evidence_class", "role", "host", "provider",
                   "pool", "image_phases", "missing_input_disposition",
                   "admission_authorized", "host_verified",
                   "migration_complete", "installed", "status"}, "receipt")
    require(r["schema"] == SCHEMA, "schema")
    require(r["evidence_class"] == "synthetic", "evidence_class: synthetic only")
    require(r["role"] == ROLE, "role: isolated only")
    require(r["host"] == HOST, "host: step-1 canary is old-controller only")

    pv = obj(r["provider"], {"name", "garm_version", "provider_version",
                             "lxd_version"}, "provider")
    require(pv["name"] is None,
            "provider.name: HOLD; operator fills from installed pool list")
    require(pv["garm_version"] == GARM_VERSION, "provider.garm_version")
    require(pv["provider_version"] == PROVIDER_VERSION,
            "provider.provider_version: 0.1.3 stays pinned")
    require(pv["lxd_version"] == LXD_VERSION, "provider.lxd_version")

    pl = obj(r["pool"], {"runner_prefix", "tags", "forbidden_tags",
                         "image_alias", "image_digest", "flavor_profile",
                         "os_type", "os_arch", "min_idle_runners",
                         "max_runners"}, "pool")
    require(pl["runner_prefix"] == RUNNER_PREFIX,
            "pool.runner_prefix: distinct garm-iso prefix required")
    tags = pl["tags"]
    require(type(tags) is list and len(tags) == 2 and set(tags) == TAG_SET,
            "pool.tags: exactly {self-hosted, garm-managed}")
    for tag in tags:
        text(tag, "pool.tag")
    forbidden = pl["forbidden_tags"]
    require(type(forbidden) is list and 2 <= len(forbidden) <= 100,
            "pool.forbidden_tags")
    for tag in forbidden:
        text(tag, "pool.forbidden_tag")
    require(len(set(forbidden)) == len(forbidden),
            "pool.forbidden_tags: duplicate tag")
    require(REQUIRED_FORBIDDEN <= set(forbidden),
            "pool.forbidden_tags: missing trust-separation label")
    require(not (set(tags) & set(forbidden)), "pool: tag in both sets")
    require(pl["image_alias"] is None and pl["image_digest"] is None,
            "pool.image: live pins are HOLD, never source")
    require(pl["flavor_profile"] == FLAVOR_PROFILE,
            "pool.flavor_profile: operator creates the reviewed profile only")
    require(pl["os_type"] == OS_TYPE, "pool.os_type")
    require(pl["os_arch"] == OS_ARCH, "pool.os_arch")
    require(type(pl["min_idle_runners"]) is int
            and pl["min_idle_runners"] == MIN_IDLE,
            "pool.min_idle_runners: canary provisions nothing warm")
    require(type(pl["max_runners"]) is int and pl["max_runners"] == MAX_RUNNERS,
            "pool.max_runners: canary bound is one VM")

    phases = obj(r["image_phases"], {"phase_a_generic",
                                     "phase_b_pinned_isolated"}, "image_phases")
    for key in ("phase_a_generic", "phase_b_pinned_isolated"):
        prose(phases[key], "image_phases." + key)

    require(r["missing_input_disposition"] == HOLD_SENTENCE,
            "missing_input_disposition")
    for key in ("admission_authorized", "host_verified", "migration_complete",
                "installed"):
        flag(r[key], False, key)
    require(r["status"] == STATUS, "status")
    return {"schema": SCHEMA, "result": "offline_canary_spec_valid",
            "evidence_class": "synthetic", "image_pinned": False,
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
        raise InvalidCanarySpec("JSON: non-finite number")
    try:
        return json.loads(raw, object_pairs_hook=unique_object,
                          parse_constant=reject_constant)
    except InvalidCanarySpec:
        raise
    except (ValueError, UnicodeDecodeError, RecursionError):
        raise InvalidCanarySpec("JSON: malformed input") from None


def read_spec(path):
    with path.open("rb") as stream:
        return parse(stream.read(MAX_BYTES + 1))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("spec", type=Path,
                        help="nonsecret, fabricated canary pool spec JSON")
    args = parser.parse_args()
    try:
        result = validate(read_spec(args.spec))
    except (InvalidCanarySpec, OSError) as exc:
        reason = str(exc) if isinstance(exc, InvalidCanarySpec) else "input file unavailable"
        print(json.dumps({"result": "offline_canary_spec_rejected",
                          "reason": reason, "admission_authorized": False}))
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
