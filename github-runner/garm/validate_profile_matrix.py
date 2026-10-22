#!/usr/bin/env python3
"""Offline cross-profile matrix lint; never admission, authorization or host proof.

Globs every ``*-image-profile.json`` next to this file (or in the directory
given on the command line) and checks the set as a whole, which no per-profile
checker can:

1. role labels (eligible minus ``self-hosted``) are pairwise disjoint;
2. each profile's ``labels.explicitly_ineligible`` holds every OTHER profile's
   role labels, and none of its own;
3. pool runner prefixes and flavor names are not claimed by two roles;
4. every profile still says ``admission_authorized: false`` and
   ``installed: false``.

A new ``*-image-profile.json`` is picked up by the glob with no code change.
Messages name the field and the profile file, never a value read from it.
"""

import argparse
import json
import sys
from pathlib import Path

PROFILE_GLOB = "*-image-profile.json"
POOL_SPEC_GLOB = "*-pool-spec.json"
SHARED_LABEL = "self-hosted"
POOL_KEYS = ("runner_prefix", "flavor_profile")
MIN_PROFILES = 2
MAX_BYTES = 1024 * 1024
RESULT = "profile_matrix_valid"
REJECTED = "profile_matrix_rejected"


class InvalidMatrix(ValueError):
    def __init__(self, violations):
        super().__init__("; ".join(violations))
        self.violations = list(violations)


class _Reject(ValueError):
    pass


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise _Reject("JSON: duplicate key")
        value[key] = item
    return value


def parse(raw):
    if len(raw) > MAX_BYTES:
        raise _Reject("JSON: input exceeds 1MiB")

    def reject_constant(_value):
        raise _Reject("JSON: non-finite number")
    try:
        return json.loads(raw, object_pairs_hook=unique_object,
                          parse_constant=reject_constant)
    except _Reject:
        raise
    except (ValueError, UnicodeDecodeError, RecursionError):
        raise _Reject("JSON: malformed input") from None


def read_documents(directory, pattern):
    """Return ({file name: document}, [violations]) for one glob."""
    documents, violations = {}, []
    for path in sorted(Path(directory).glob(pattern)):
        try:
            with path.open("rb") as stream:
                documents[path.name] = parse(stream.read(MAX_BYTES + 1))
        except _Reject as exc:
            violations.append("%s: %s" % (path.name, exc))
        except OSError:
            violations.append("%s: input file unavailable" % path.name)
    return documents, violations


def label_list(name, document, field, violations):
    """Return the labels at labels.<field> as a list, or None after reporting."""
    labels = document.get("labels") if type(document) is dict else None
    value = labels.get(field) if type(labels) is dict else None
    if type(value) is not list or any(type(item) is not str for item in value):
        violations.append("%s: labels.%s: list of strings required"
                          % (name, field))
        return None
    return value


def role_labels(name, document, violations):
    """Eligible labels minus the shared one, or None after reporting."""
    eligible = label_list(name, document, "eligible", violations)
    if eligible is None:
        return None
    roles = frozenset(eligible) - {SHARED_LABEL}
    if not roles:
        violations.append("%s: labels.eligible: no role label beyond the "
                          "shared one" % name)
        return None
    return roles


def check_labels(profiles, violations):
    roles = {}
    ineligible = {}
    for name, document in profiles.items():
        roles[name] = role_labels(name, document, violations)
        listed = label_list(name, document, "explicitly_ineligible", violations)
        ineligible[name] = None if listed is None else frozenset(listed)
    names = sorted(profiles)
    for first in names:
        if roles[first] is None or ineligible[first] is None:
            continue
        if roles[first] & ineligible[first]:
            violations.append("%s: labels.explicitly_ineligible: contains its "
                              "own role label" % first)
        for second in names:
            if second == first or roles[second] is None:
                continue
            if first < second and roles[first] & roles[second]:
                violations.append("%s and %s: labels.eligible: role label "
                                  "shared between profiles" % (first, second))
            if not roles[second] <= ineligible[first]:
                violations.append("%s: labels.explicitly_ineligible: missing "
                                  "role label of %s" % (first, second))


def check_authorization(profiles, violations):
    for name, document in profiles.items():
        for field in ("admission_authorized", "installed"):
            if type(document) is not dict or document.get(field) is not False:
                violations.append("%s: %s: must be false" % (name, field))


def pool_claims(profiles, pool_specs, violations):
    """Map (pool key, value) -> {role key: [file names]} from both carriers."""
    claims = {}
    carriers = [(name, document) for name, document in profiles.items()]
    carriers += [(name, document) for name, document in pool_specs.items()]
    for name, document in carriers:
        pool = document.get("pool") if type(document) is dict else None
        if pool is None:
            continue
        if type(pool) is not dict:
            violations.append("%s: pool: object required" % name)
            continue
        role = document.get("role")
        if type(role) is not str or not role:
            violations.append("%s: role: string required to attribute pool"
                              % name)
            continue
        for key in POOL_KEYS:
            if key not in pool:
                continue
            value = pool[key]
            if type(value) is not str or not value:
                violations.append("%s: pool.%s: non-empty string required"
                                  % (name, key))
                continue
            claims.setdefault((key, value), {}).setdefault(role, []).append(name)
    return claims


def check_pool_identifiers(profiles, pool_specs, violations):
    claims = pool_claims(profiles, pool_specs, violations)
    for (key, _value), by_role in sorted(claims.items()):
        if len(by_role) > 1:
            files = sorted(name for names in by_role.values() for name in names)
            violations.append("%s: pool.%s: claimed by more than one role"
                              % (" and ".join(files), key))
    return {key: sum(1 for (claim_key, _v) in claims if claim_key == key)
            for key in POOL_KEYS}


def validate(profiles, pool_specs=None):
    """Lint a parsed profile set ({file name: document}); no I/O."""
    pool_specs = pool_specs or {}
    violations = []
    if len(profiles) < MIN_PROFILES:
        violations.append("profiles: at least %d required, found %d"
                          % (MIN_PROFILES, len(profiles)))
    check_labels(profiles, violations)
    check_authorization(profiles, violations)
    pool_counts = check_pool_identifiers(profiles, pool_specs, violations)
    if violations:
        raise InvalidMatrix(violations)
    return {"result": RESULT, "evidence_class": "synthetic",
            "profiles": sorted(profiles), "pool_specs": sorted(pool_specs),
            "pool_identifiers": pool_counts,
            "admission_authorized": False, "host_verified": False,
            "migration_complete": False}


def validate_directory(directory):
    profiles, violations = read_documents(directory, PROFILE_GLOB)
    pool_specs, more = read_documents(directory, POOL_SPEC_GLOB)
    violations += more
    try:
        result = validate(profiles, pool_specs)
    except InvalidMatrix as exc:
        raise InvalidMatrix(violations + exc.violations) from None
    if violations:
        raise InvalidMatrix(violations)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path, nargs="?",
                        default=Path(__file__).resolve().parent,
                        help="directory holding the *-image-profile.json files")
    args = parser.parse_args()
    try:
        result = validate_directory(args.directory)
    except InvalidMatrix as exc:
        print(json.dumps({"result": REJECTED, "violations": exc.violations,
                          "admission_authorized": False}))
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
