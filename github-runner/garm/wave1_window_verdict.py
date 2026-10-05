#!/usr/bin/env python3
"""Offline Wave-1 window verdict: HOLD and NO-GO triggers as code.

`docs/runbooks/garm-wave1-cutover-dryrun.md` section 2 defines two-tier
rollback triggers and trial adequacy as prose. This evaluator turns ONE
operator-recorded observation file into one verdict so the window records a
machine verdict instead of a hand-judged table. Offline only: it reads the
file on argv, never contacts GARM, GitHub, or any host, and reads no clock.

Observation schema ``garm-wave1-window.v1`` (every field below is optional
on the wire; a null or missing field is UNKNOWN, never a pass):

    {"schema": "garm-wave1-window.v1",
     "pickup_observed": true,            # a GARM-labelled job started
     "pickup_wait_s": 191,               # queued -> started, or elapsed so far
     "tests_required": 16, "tests_passed": 16, "tests_skipped": 0,
     "budget_evidence_age_s": 120,       # age of the budget read at window
     "fs_max_use_pct": 61.5,             # highest relevant filesystem use
     "pressure_incident_unresolved": false,
     "static_fallback_available": true,
     "interrupted_active_job": false, "production_db_contact": false,
     "unauthorized_access_or_routing": false,
     "unexplained_lifecycle_leak": false,
     "cap_or_admission_increase": false, "host_pressure_stop_breach": false,
     "trial_hours": 26, "comparable_attempts_garm": 11,
     "comparable_attempts_static": 12}

Verdicts: NO-GO outranks HOLD outranks UNKNOWN outranks PROCEED. PROCEED
only when every field is present and inside its threshold. A trial shorter
than the adequacy floor is INCONCLUSIVE per the runbook (T7) and is emitted
as UNKNOWN, never PROCEED.

Exit 0 PROCEED, 2 HOLD, 3 UNKNOWN, 4 NO-GO, 1 usage/validation error
(unknown key, wrong type, oversize or malformed input). A verdict licenses no
cap, label, routing or pool change: every result carries
``admission_authorized:false``, ``host_verified:false`` and
``migration_complete:false``.

Python standard library only. Safe diagnostics: rejections name the field,
never the value.
"""

import argparse
import json
import math
import sys
from pathlib import Path

SCHEMA = "garm-wave1-window.v1"
RESULT_SCHEMA = "garm-wave1-window-verdict.v1"
MAX_BYTES = 1024 * 1024

# ---- thresholds: the ONLY place the numbers live ---------------------------
# Runbook section 2 carries PICKUP_SLO_S, FILESYSTEM_STOP_PCT, TRIAL_MIN_HOURS
# and TRIAL_MIN_ATTEMPTS_PER_ARM; the doc-drift test fails when they disagree.
# BUDGET_EVIDENCE_MAX_AGE_S is a code-side bound (the runbook says only
# "stale"); it mirrors the 15-minute freshness of the promotion checklist and
# is stated in the runbook's machine-verdict note for the window to ratify.
PICKUP_SLO_S = 15 * 60
BUDGET_EVIDENCE_MAX_AGE_S = 15 * 60
FILESYSTEM_STOP_PCT = 95
TRIAL_MIN_HOURS = 24
TRIAL_MIN_ATTEMPTS_PER_ARM = 10
THRESHOLDS = {
    "pickup_slo_s": PICKUP_SLO_S,
    "budget_evidence_max_age_s": BUDGET_EVIDENCE_MAX_AGE_S,
    "filesystem_stop_pct": FILESYSTEM_STOP_PCT,
    "trial_min_hours": TRIAL_MIN_HOURS,
    "trial_min_attempts_per_arm": TRIAL_MIN_ATTEMPTS_PER_ARM,
}

# Sanity bounds: a larger value is a clock/unit error, not a slow window.
MAX_SECONDS = 7 * 24 * 60 * 60
MAX_HOURS = 24 * 366
MAX_COUNT = 1_000_000

NOGO_FIELDS = (
    "interrupted_active_job",
    "production_db_contact",
    "unauthorized_access_or_routing",
    "unexplained_lifecycle_leak",
    "cap_or_admission_increase",
    "host_pressure_stop_breach",
)
FIELDS = {
    "pickup_observed": "bool",
    "pickup_wait_s": "seconds",
    "tests_required": "count",
    "tests_passed": "count",
    "tests_skipped": "count",
    "budget_evidence_age_s": "seconds",
    "fs_max_use_pct": "pct",
    "pressure_incident_unresolved": "bool",
    "static_fallback_available": "bool",
    "trial_hours": "hours",
    "comparable_attempts_garm": "count",
    "comparable_attempts_static": "count",
}
FIELDS.update({name: "bool" for name in NOGO_FIELDS})

NOGO, HOLD, UNKNOWN = "NO-GO", "HOLD", "UNKNOWN"
EXIT_CODES = {"PROCEED": 0, "HOLD": 2, "UNKNOWN": 3, "NO-GO": 4}


class InvalidObservation(ValueError):
    pass


def require(condition, field):
    if not condition:
        raise InvalidObservation(field)


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value, "JSON: duplicate key")
        value[key] = item
    return value


def parse(raw):
    require(len(raw) <= MAX_BYTES, "JSON: input exceeds 1MiB")
    require("\x00" not in raw, "JSON: NUL byte")
    try:
        doc = json.loads(raw, object_pairs_hook=unique_object,
                         parse_constant=lambda v: (_ for _ in ()).throw(
                             InvalidObservation("JSON: non-finite number")))
    except json.JSONDecodeError as exc:
        raise InvalidObservation(f"JSON: {exc.msg}") from exc
    except RecursionError as exc:
        raise InvalidObservation("JSON: nesting too deep") from exc
    except ValueError as exc:  # e.g. integer digit-limit; never echo the value
        if isinstance(exc, InvalidObservation):
            raise
        raise InvalidObservation("JSON: unreadable number") from exc
    require(type(doc) is dict, "top-level object")
    return doc


def load_observation(path):
    raw = Path(path).read_bytes()
    require(len(raw) <= MAX_BYTES, "JSON: input exceeds 1MiB")
    return parse(raw.decode("utf-8"))


def read_field(doc, name):
    """Return the validated value, or None when null or missing."""
    value = doc.get(name)
    if value is None:
        return None
    kind = FIELDS[name]
    if kind == "bool":
        require(type(value) is bool, name)
    elif kind in ("seconds", "count"):
        limit = MAX_COUNT if kind == "count" else MAX_SECONDS
        require(type(value) is int and 0 <= value <= limit, name)
    else:
        limit = 100 if kind == "pct" else MAX_HOURS
        require(type(value) in (int, float) and math.isfinite(value)
                and 0 <= value <= limit, name)
    return value


def read_observation(doc):
    require(type(doc) is dict, "top-level object")
    require(doc.get("schema") == SCHEMA, "schema")
    require(set(doc) <= set(FIELDS) | {"schema"}, "unknown key")
    return {name: read_field(doc, name) for name in FIELDS}


def collect_reasons(obs):
    """Return [(tier, code), ...] in deterministic order. Each field is
    judged independently: a known adverse fact fires even when another
    field is null."""
    reasons = []

    def add(tier, code):
        reasons.append((tier, code))

    for name in NOGO_FIELDS:
        if obs[name] is True:
            add(NOGO, "NOGO_" + name.upper())

    wait = obs["pickup_wait_s"]
    if wait is not None and wait > PICKUP_SLO_S:
        add(HOLD, "HOLD_PICKUP_SLO")
    required, passed, skipped = (obs["tests_required"], obs["tests_passed"],
                                 obs["tests_skipped"])
    if skipped is not None and skipped > 0:
        add(HOLD, "HOLD_TESTS_SKIPPED")
    if (required is not None and passed is not None
            and (required < 1 or passed < required)):
        add(HOLD, "HOLD_TESTS_MISSING")
    age = obs["budget_evidence_age_s"]
    if age is not None and age > BUDGET_EVIDENCE_MAX_AGE_S:
        add(HOLD, "HOLD_BUDGET_EVIDENCE_STALE")
    fs = obs["fs_max_use_pct"]
    if fs is not None and fs >= FILESYSTEM_STOP_PCT:
        add(HOLD, "HOLD_FILESYSTEM_PRESSURE")
    if obs["pressure_incident_unresolved"] is True:
        add(HOLD, "HOLD_PRESSURE_INCIDENT_UNRESOLVED")
    if obs["static_fallback_available"] is False:
        add(HOLD, "HOLD_STATIC_FALLBACK_UNAVAILABLE")

    for name in FIELDS:
        if obs[name] is None and name not in NOGO_FIELDS:
            add(UNKNOWN, "UNKNOWN_" + name.upper())
    for name in NOGO_FIELDS:
        if obs[name] is None:
            add(UNKNOWN, "UNKNOWN_" + name.upper())
    if wait is not None and wait <= PICKUP_SLO_S \
            and obs["pickup_observed"] is False:
        add(UNKNOWN, "UNKNOWN_PICKUP_NOT_OBSERVED")
    hours = obs["trial_hours"]
    if hours is not None and hours < TRIAL_MIN_HOURS:
        add(UNKNOWN, "UNKNOWN_TRIAL_TOO_SHORT")
    for arm in ("garm", "static"):
        attempts = obs["comparable_attempts_" + arm]
        if attempts is not None and attempts < TRIAL_MIN_ATTEMPTS_PER_ARM:
            add(UNKNOWN, "UNKNOWN_ATTEMPTS_" + arm.upper() + "_BELOW_FLOOR")
    return reasons


def resolve(reasons):
    tiers = {tier for tier, _ in reasons}
    if NOGO in tiers:
        return "NO-GO"
    if HOLD in tiers:
        return "HOLD"
    if UNKNOWN in tiers:
        return "UNKNOWN"
    return "PROCEED"


def evaluate(doc):
    """Return the verdict document for one parsed observation. Raises
    InvalidObservation on malformed input."""
    reasons = collect_reasons(read_observation(doc))
    return {"schema": RESULT_SCHEMA,
            "verdict": resolve(reasons),
            "reasons": [code for _, code in reasons],
            "thresholds": dict(THRESHOLDS),
            "admission_authorized": False,
            "host_verified": False,
            "migration_complete": False}


class Parser(argparse.ArgumentParser):
    def error(self, message):
        # argparse exits 2 by default, which here would read as HOLD.
        self.print_usage(sys.stderr)
        print(f"error: {message}", file=sys.stderr)
        sys.exit(1)


def main(argv=None):
    parser = Parser(
        description="Offline Wave-1 window verdict (PROCEED / HOLD / NO-GO / "
                    "UNKNOWN) from one garm-wave1-window.v1 observation.")
    parser.add_argument("observation", help="observation JSON file")
    args = parser.parse_args(argv)
    try:
        result = evaluate(load_observation(args.observation))
    except (InvalidObservation, OSError, UnicodeDecodeError) as exc:
        print(f"ERROR {args.observation}: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return EXIT_CODES[result["verdict"]]


if __name__ == "__main__":
    sys.exit(main())
