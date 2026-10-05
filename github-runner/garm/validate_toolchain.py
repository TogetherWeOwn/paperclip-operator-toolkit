#!/usr/bin/env python3
"""Offline toolchain-pin checks only; never a build, admission or host proof."""

import argparse
import json
import re
import sys
from pathlib import Path

SCHEMA = "garm-isolated-toolchain.v1"
MAX_BYTES = 1024 * 1024
ROLE = "isolated"

VERSION_RE = re.compile(r"\d+\.\d+(?:\.\d+)?(?:[.+-][A-Za-z0-9.-]+)?")
FORBIDDEN_TOKENS = ("latest", "*", "main", "master", "stable", "tbd", "todo", "unknown", "unverified")


class InvalidToolchain(ValueError):
    pass


def require(condition, field):
    if not condition:
        raise InvalidToolchain(field)


def obj(value, keys, field):
    require(type(value) is dict, field + ": object required")
    require(set(value) == set(keys), field + ": missing or unexpected fields")
    return value


def flag(value, expected, field):
    require(type(value) is bool and value is expected, field)


def text(value, field):
    require(type(value) is str and 0 < len(value) <= 300, field)
    return value


def version(value, field):
    text(value, field)
    lowered = value.lower()
    for token in FORBIDDEN_TOKENS:
        require(token not in lowered, field + ": floating or placeholder token")
    require(VERSION_RE.fullmatch(value) is not None, field + ": exact version required")
    return value


def nullable_digest(value, length, field):
    require(value is None, field + ": output fingerprints stay HOLD (null)")


def validate(manifest):
    """Validate a source-only toolchain manifest without any I/O."""
    m = obj(manifest, {"schema", "role", "evidence_class", "status", "pins",
                       "requirements", "forbidden_preparation_actions",
                       "image_build_authorized", "migration_authorized",
                       "admission_authorized", "output_hold", "notes"},
            "manifest")
    require(m["schema"] == SCHEMA, "schema")
    require(m["role"] == ROLE, "role: isolated only")
    require(m["evidence_class"] == "source-only", "evidence_class: source-only only")
    require(m["status"] == "synthetic-preparation-only", "status")
    text(m["notes"], "notes")

    pins = obj(m["pins"], {"psql", "php", "composer", "extensions", "node", "runner"}, "pins")

    psql = obj(pins["psql"], {"version", "on_path", "source"}, "pins.psql")
    version(psql["version"], "pins.psql.version")
    require(psql["version"].startswith("16."), "pins.psql.version: PostgreSQL 16 required")
    flag(psql["on_path"], True, "pins.psql.on_path")
    text(psql["source"], "pins.psql.source")

    php = obj(pins["php"], {"version", "source"}, "pins.php")
    version(php["version"], "pins.php.version")
    require(php["version"].startswith("8.5."), "pins.php.version: PHP 8.5 required")
    text(php["source"], "pins.php.source")

    composer = obj(pins["composer"], {"version", "source"}, "pins.composer")
    version(composer["version"], "pins.composer.version")
    require(composer["version"].startswith("2."), "pins.composer.version: Composer v2 required")
    text(composer["source"], "pins.composer.source")

    ext = obj(pins["extensions"], {"pdo_pgsql", "zip", "gd", "pcov"}, "pins.extensions")
    for name in ("pdo_pgsql", "zip", "gd"):
        entry = obj(ext[name], {"version", "enabled", "notes"}, "pins.extensions." + name)
        version(entry["version"], "pins.extensions." + name + ".version")
        flag(entry["enabled"], True, "pins.extensions." + name + ".enabled")
        text(entry["notes"], "pins.extensions." + name + ".notes")
        require(entry["version"] == php["version"],
                "pins.extensions." + name + ".version: bundled with pinned PHP")
    pcov = obj(ext["pcov"], {"version", "source"}, "pins.extensions.pcov")
    version(pcov["version"], "pins.extensions.pcov.version")
    require(pcov["version"].startswith("1."), "pins.extensions.pcov.version: pcov 1.x required")
    text(pcov["source"], "pins.extensions.pcov.source")

    node = obj(pins["node"], {"version", "source"}, "pins.node")
    version(node["version"], "pins.node.version")
    require(node["version"].startswith("24."), "pins.node.version: Node 24 required")
    text(node["source"], "pins.node.source")

    runner = obj(pins["runner"], {"version", "source"}, "pins.runner")
    version(runner["version"], "pins.runner.version")
    require(runner["version"].startswith("2."), "pins.runner.version: runner 2.x required")
    text(runner["source"], "pins.runner.source")

    req = obj(m["requirements"], {"psql_on_path", "node24_runner_smoke",
                                  "no_floating_tags"}, "requirements")
    for key in ("psql_on_path", "node24_runner_smoke", "no_floating_tags"):
        flag(req[key], True, "requirements." + key)

    acts = obj(m["forbidden_preparation_actions"],
               {"image_build", "pool_cap_change", "migration_authorized"},
               "forbidden_preparation_actions")
    for key, value in acts.items():
        flag(value, False, "forbidden_preparation_actions." + key + ": prohibited in preparation")
    flag(m["image_build_authorized"], False, "image_build_authorized")
    flag(m["migration_authorized"], False, "migration_authorized")
    flag(m["admission_authorized"], False, "admission_authorized")

    hold = obj(m["output_hold"], {"base_image_fingerprint",
                                  "output_image_fingerprint", "profile_sha256"},
               "output_hold")
    for key in ("base_image_fingerprint", "output_image_fingerprint", "profile_sha256"):
        nullable_digest(hold[key], 64, "output_hold." + key)

    return {"schema": SCHEMA, "result": "toolchain_pins_valid",
            "evidence_class": "source-only", "admission_authorized": False,
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
        raise InvalidToolchain("JSON: non-finite number")

    try:
        return json.loads(raw, object_pairs_hook=unique_object,
                          parse_constant=reject_constant)
    except InvalidToolchain:
        raise
    except (ValueError, UnicodeDecodeError, RecursionError):
        raise InvalidToolchain("JSON: malformed input") from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path, help="nonsecret toolchain manifest JSON")
    args = parser.parse_args()
    try:
        with args.manifest.open("rb") as stream:
            raw = stream.read(MAX_BYTES + 1)
        result = validate(parse(raw))
    except (InvalidToolchain, OSError) as exc:
        reason = str(exc) if isinstance(exc, InvalidToolchain) else "input file unavailable"
        print(json.dumps({"result": "toolchain_pins_rejected", "reason": reason,
                          "admission_authorized": False}))
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
