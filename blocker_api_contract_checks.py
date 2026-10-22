#!/usr/bin/env python3
"""Deterministic API-contract checks (blocker-ledger class 5).

Flags breaking wire changes: removed endpoints, newly-required request
fields, and removed required response fields. Additive changes pass.

Schemas are plain dicts: endpoint key ("METHOD /path") -> mapping with
"req_required" and "resp_required" field lists. No OpenAPI parser needed.

Stdlib only, pure functions, no network/clock/filesystem.
"""


def extract_endpoints(schema):
    """The endpoint keys of a schema."""
    return set(schema.keys())


def _entry(schema, endpoint):
    entry = schema.get(endpoint) or {}
    return entry


def _req_fields(entry):
    return list(entry.get("req_required") or [])


def _resp_fields(entry):
    return list(entry.get("resp_required") or [])


def check_removed_endpoints(old, new):
    """One finding per endpoint key present in old but missing in new.
    A path rename surfaces as a remove (plus an add) by design."""
    return sorted(
        "%s: endpoint removed" % endpoint
        for endpoint in old
        if endpoint not in new
    )


def check_required_request_fields_added(old, new):
    """One finding per newly-required request field on a surviving
    endpoint. Findings name the endpoint and the field."""
    findings = []
    for endpoint in old:
        if endpoint not in new:
            continue
        before = set(_req_fields(_entry(old, endpoint)))
        after = set(_req_fields(_entry(new, endpoint)))
        for field in sorted(after - before):
            findings.append(
                "%s: newly-required request field %r" % (endpoint, field)
            )
    return findings


def check_response_fields_removed(old, new):
    """One finding per removed required response field on a surviving
    endpoint. Findings name the endpoint and the field."""
    findings = []
    for endpoint in old:
        if endpoint not in new:
            continue
        before = set(_resp_fields(_entry(old, endpoint)))
        after = set(_resp_fields(_entry(new, endpoint)))
        for field in sorted(before - after):
            findings.append(
                "%s: required response field removed: %r" % (endpoint, field)
            )
    return findings
