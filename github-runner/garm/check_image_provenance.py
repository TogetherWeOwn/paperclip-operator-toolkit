#!/usr/bin/env python3
"""Offline GARM image digest-pin + provenance-attestation check; never admission.

Reads a digest-pin manifest and one or more profile/receipt JSON docs, all
offline from explicitly supplied files. Fails (exit 1) on any mutable image
tag (``name:tag`` without ``@sha256:<digest>``), any image digest that is
missing or not in the manifest pin set, any live provenance-attestation
claim, or any malformed manifest. Pass (exit 0) authorizes nothing: the
result always carries ``admission_authorized:false``.

No network, no credentials, no host access. Python standard library only.
Safe diagnostics: rejections name the field, never the value.
"""

import argparse
import json
import re
import sys
from pathlib import Path

SCHEMA = "garm-image-digest-pins.v1"
MAX_BYTES = 1024 * 1024
REF_POLICY = "digest-only"

# OCI repository components allow double underscores and repeated hyphens.
# Registry ports are not tags; a tag may accompany an immutable digest.
COMPONENT = r"[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*"
REF_NAME = (r"(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]+)?/)?"
            + COMPONENT + r"(?:/" + COMPONENT + r")*")
TAG = r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}"
MUTABLE_TAG = re.compile(
    r"(?<![A-Za-z0-9_./:@-])(?=[a-z0-9./_-]*[a-z])"
    + REF_NAME + r":" + TAG, re.IGNORECASE)
PINNED_REF = re.compile(REF_NAME + r"(?::" + TAG + r")?@sha256:[0-9a-f]{64}")
HEX64 = re.compile(r"[0-9a-f]{64}")
TIMESTAMP = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z")

IMAGE_DIGEST_KEYS = {"fingerprint", "base_image_fingerprint",
                     "output_image_fingerprint", "image_fingerprint", "digest"}
HASH_KEYS = {"profile_sha256", "inputs_sha256"}
IMAGE_REF_KEYS = {"image", "base_image", "output_image", "image_ref",
                  "container_image", "runner_image", "pinned_ref"}
ATTESTATION_KEYS = {"provenance_attested", "attestation_verified",
                    "provenance_verified", "attested"}

# Only preparation profiles explicitly declaring synthetic HOLD may carry
# nulls at these exact paths. Receipt identities and job digests never may.
PREPARATION_NULLS = {
    "garm-image-role-contracts.v1": {
        ("actual_build_inputs", "base_image_fingerprint"),
        ("actual_build_inputs", "output_image_fingerprint"),
        ("actual_build_inputs", "profile_sha256"),
    },
    "garm-isolated-image-profile.v1": {
        ("base", "base_image_fingerprint"),
        ("output", "output_image_fingerprint"),
        ("output", "profile_sha256"), ("output", "inputs_sha256"),
    },
}
RECEIPT_SCHEMAS = {"garm-rehearsal-receipt.v1",
                   "garm-isolated-profile-receipt.v1"}


class InvalidProvenance(ValueError):
    pass


def require(condition, field):
    if not condition:
        raise InvalidProvenance(field)


def text(value, field):
    require(type(value) is str and 0 < len(value) <= 200
            and re.fullmatch(r"[A-Za-z0-9._:/@+-]+", value) is not None, field)
    require(value.upper() not in {"UNKNOWN", "TODO", "UNVERIFIED", "TBD"}, field)
    return value


def digest(value, field):
    require(type(value) is str and HEX64.fullmatch(value) is not None, field)


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value, "JSON: duplicate key")
        value[key] = item
    return value


def parse(raw):
    require(len(raw) <= MAX_BYTES, "JSON: input exceeds 1MiB")

    def reject_constant(_value):
        raise InvalidProvenance("JSON: non-finite number")
    try:
        return json.loads(raw, object_pairs_hook=unique_object,
                          parse_constant=reject_constant)
    except InvalidProvenance:
        raise
    except (ValueError, UnicodeDecodeError, RecursionError):
        raise InvalidProvenance("JSON: malformed input") from None


def read_json(path):
    with path.open("rb") as stream:
        return parse(stream.read(MAX_BYTES + 1))


def provenance(value, field):
    require(type(value) is dict and set(value) == {"attested", "predicate",
            "disposition"}, field + ": attestation shape required")
    require(value["attested"] is False,
            field + ".attested: live attestation claim refused")
    require(value["predicate"] is None,
            field + ".predicate: live predicate refused")
    require(type(value["disposition"]) is str
            and re.match(r"HOLD(?:$|[; :])", value["disposition"]) is not None,
            field + ".disposition: HOLD reason required")


def validate_manifest(manifest):
    """Validate the pin manifest; keep image identities and other hashes apart."""
    require(type(manifest) is dict, "manifest: object required")
    require(manifest.get("schema") == SCHEMA, "manifest.schema")
    require(manifest.get("evidence_class") == "synthetic",
            "manifest.evidence_class: synthetic only")
    require(manifest.get("ref_policy") == REF_POLICY,
            "manifest.ref_policy: digest-only required")
    require(manifest.get("admission_authorized") is False,
            "manifest.admission_authorized: must be false")
    covers = manifest.get("covers")
    require(type(covers) is dict and len(covers) > 0,
            "manifest.covers: profile coverage required")
    for name, target in covers.items():
        text(target, "manifest.covers." + str(name))
    images = manifest.get("images")
    require(type(images) is dict and len(images) > 0,
            "manifest.images: at least one pin required")
    pins = {"images": set(), "profile_sha256": set(), "inputs_sha256": set()}
    fingerprints = set()
    for name, pin in images.items():
        field = "manifest.images." + str(name)
        require(type(pin) is dict, field + ": object required")
        digest(pin.get("digest"), field + ".digest")
        ref = pin.get("pinned_ref")
        require(type(ref) is str and PINNED_REF.fullmatch(ref) is not None,
                field + ".pinned_ref: name@sha256 digest required")
        require(ref.endswith("@" + "sha256:" + pin["digest"]),
                field + ".pinned_ref: digest mismatch")
        for trio_key in ("profile_sha256", "inputs_sha256"):
            if trio_key in pin:
                digest(pin[trio_key], field + "." + trio_key)
                pins[trio_key].add(pin[trio_key])
        text(pin.get("role", "role"), field + ".role")
        provenance(pin.get("provenance"), field + ".provenance")
        pins["images"].add(pin["digest"])
        require(pin["digest"] not in fingerprints,
                field + ".digest: duplicate pin")
        fingerprints.add(pin["digest"])
    require(len(fingerprints) == len(images),
            "manifest.images: image fingerprints must be distinct")
    return pins, [Path(target.split(":")[0]).name for target in covers.values()]


def scan_strings(value, found):
    """Collect (path, string) pairs for every string in a JSON doc."""
    if isinstance(value, str):
        found.append(value)
    elif isinstance(value, dict):
        for item in value.values():
            scan_strings(item, found)
    elif isinstance(value, list):
        for item in value:
            scan_strings(item, found)


def check_value_string(string, field):
    """Refuse mutable tags; validate pinned refs. Returns digest hex or None."""
    if "://" in string or TIMESTAMP.fullmatch(string):
        return None
    at = string.find("@sha256:")
    if at >= 0:
        require(PINNED_REF.fullmatch(string) is not None,
                field + ": malformed pinned ref")
        return string[at + len("@sha256:"):]
    match = MUTABLE_TAG.search(string)
    require(match is None, field + ": mutable image tag refused")
    return None


def check_doc(doc, pins, field):
    """Enforce typed digest coverage and synthetic provenance on one doc."""
    require(type(doc) is dict, field + ": object required")
    schema = doc.get("schema")
    require(schema is None or type(schema) is str, field + ".schema")
    nullable = PREPARATION_NULLS.get(schema, set())
    preparation_hold = (doc.get("status") == "synthetic-preparation-only"
                        and doc.get("admission_authorized") is False
                        and doc.get("installed") is False
                        and doc.get("evidence_class", "synthetic") == "synthetic"
                        and doc.get("host_verified", False) is False
                        and doc.get("migration_complete", False) is False
                        and type(doc.get("missing_input_disposition")) is str
                        and doc["missing_input_disposition"].startswith("HOLD;"))

    required = set(nullable)
    if schema in RECEIPT_SCHEMAS:
        required.add(("image", "fingerprint"))
    if schema == "garm-rehearsal-receipt.v1":
        required.add(("job", "image_fingerprint"))
    for path in required:
        value = doc
        for key in path:
            require(type(value) is dict and key in value,
                    field + "." + ".".join(path) + ": missing digest field")
            value = value[key]

    strings = []
    scan_strings(doc, strings)
    for string in strings:
        found = check_value_string(string, field)
        if found is not None:
            require(found in pins["images"], field + ": digest not in image pins")

    def walk(value, path):
        if isinstance(value, dict):
            for key, item in value.items():
                location = path + (key,)
                label = field + "." + ".".join(location)
                if key in IMAGE_REF_KEYS:
                    if key == "image" and type(item) is dict:
                        digest(item.get("fingerprint"), label + ".fingerprint")
                    else:
                        require(type(item) is str and PINNED_REF.fullmatch(item)
                                is not None, label + ": immutable image ref required")
                        require(item.rsplit("@sha256:", 1)[1] in pins["images"],
                                label + ": digest not in image pins")
                if key in IMAGE_DIGEST_KEYS or key in HASH_KEYS:
                    if item is None and location in nullable:
                        require(preparation_hold, label + ": synthetic HOLD required")
                    else:
                        digest(item, label + ": digest required")
                        category = "images" if key in IMAGE_DIGEST_KEYS else key
                        require(item in pins[category], label + ": digest not pinned")
                if key == "provenance":
                    provenance(item, label)
                if key in ATTESTATION_KEYS:
                    require(item is False, label + ": live attestation claim refused")
                walk(item, location)
        elif isinstance(value, list):
            for index, item in enumerate(value):
                walk(item, path + (str(index),))

    walk(doc, ())
    return True


def check(manifest, docs):
    """Validate manifest + docs without any I/O. Returns the pass result."""
    pins, covered = validate_manifest(manifest)
    require(len(docs) > 0, "docs: at least one profile doc required")
    scanned = set()
    for name, doc in docs:
        check_doc(doc, pins, "doc." + name)
        scanned.add(Path(name).name)
    for target in covered:
        require(target in scanned,
                "docs: manifest-covered profile missing: " + target)
    return {"schema": SCHEMA, "result": "provenance_check_pass",
            "evidence_class": "synthetic", "admission_authorized": False,
            "host_verified": False, "migration_complete": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path,
                        help="digest-pin manifest JSON (nonsecret)")
    parser.add_argument("docs", type=Path, nargs="+",
                        help="profile/receipt JSON docs to check (nonsecret)")
    args = parser.parse_args()
    try:
        manifest = read_json(args.manifest)
        docs = [(path.name, read_json(path)) for path in args.docs]
        result = check(manifest, docs)
    except (InvalidProvenance, OSError) as exc:
        reason = str(exc) if isinstance(exc, InvalidProvenance) \
            else "input file unavailable"
        print(json.dumps({"result": "provenance_check_rejected",
                          "reason": reason, "admission_authorized": False}))
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
