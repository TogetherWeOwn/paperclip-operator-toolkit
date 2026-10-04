#!/usr/bin/env python3
"""Materialize only exact reviewed immutable history-finding exceptions."""
import hashlib
import json
from pathlib import Path
import re
import sys


def fixture_exceptions(findings, registry):
    if not isinstance(registry, dict) or registry.get("version") != 1:
        raise ValueError("invalid fixture registry version")
    hashes = registry.get("fingerprintSha256")
    if not isinstance(hashes, list) or not hashes or any(
        not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value) for value in hashes
    ) or len(set(hashes)) != len(hashes):
        raise ValueError("invalid fixture registry hashes")
    if not isinstance(findings, list):
        raise ValueError("invalid scanner report")
    known = set(hashes)
    exceptions = set()
    for finding in findings:
        if not isinstance(finding, dict):
            raise ValueError("invalid scanner finding")
        commit = finding.get("Commit")
        fingerprint = finding.get("Fingerprint")
        if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40}", commit):
            raise ValueError("finding lacks an immutable commit")
        if not isinstance(fingerprint, str) or not fingerprint.startswith(commit + ":"):
            raise ValueError("finding fingerprint is not commit-bound")
        if "\n" in fingerprint or "\r" in fingerprint:
            raise ValueError("invalid fingerprint")
        if hashlib.sha256(fingerprint.encode()).hexdigest() in known:
            exceptions.add(fingerprint)
    return sorted(exceptions)


def main(args):
    if len(args) != 2:
        print("usage: gitleaks_fixtures.py REPORT REGISTRY", file=sys.stderr)
        return 2
    try:
        findings = json.loads(Path(args[0]).read_text())
        registry = json.loads(Path(args[1]).read_text())
        exceptions = fixture_exceptions(findings, registry)
        for fingerprint in exceptions:
            print(fingerprint)
        print(f"history fixtures: {len(exceptions)} exact exceptions; "
              f"{len(findings) - len(exceptions)} unsuppressed findings", file=sys.stderr)
        return 0
    except (OSError, ValueError) as error:
        print(f"secret scan: UNMEASURED — {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
