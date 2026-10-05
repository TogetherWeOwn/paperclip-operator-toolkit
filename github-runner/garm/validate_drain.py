#!/usr/bin/env python3
"""Offline structural checks for the graceful-drain proposal; never authorization.

Reads one nonsecret fabricated drain-contracts JSON (bounded to 1 MiB) and
checks it agrees with GRACEFUL-DRAIN.md: the drain-signal sets, the grace
floor and poll/bootstrap values, the exact graceful/force transition edge
sets against the upstream GARM v0.2.1 legal map, the exact reaper rule
lists, and the timeout disposition. Any disagreement exits 1 with a
non-echoing structured rejection. A pass returns admission_authorized False,
host_verified False, installed False: validation is structural agreement
with the proposal, never permission to scale, drain, or delete.

It never builds, pulls, or runs an image, never touches the network, and
never needs a credential. The CLI reads only its explicitly supplied
nonsecret contract file. Do not feed credentials/private configs to the
checker. It is not a general-purpose secret scanner.
"""

import argparse
import json
import sys
from pathlib import Path

SCHEMA = "garm-drain-contracts.v1"
MAX_BYTES = 1024 * 1024

DRAIN_GRACE_MIN = 150
POLL_INTERVAL_MIN = 5
RUNNER_BOOTSTRAP_TIMEOUT_MIN = 20

ALLOWED_SIGNALS = {"pool_disabled", "max_runners_lowered", "min_idle_lowered"}
FORBIDDEN_SIGNALS = {"job_cancel", "label_change_as_drain",
                     "queue_depth_auto", "vm_delete_without_signal"}
SIGNAL_REQUIRES = {"reviewed_operator_action", "recorded_action_ref",
                   "no_new_admissions_after_signal"}

GRACEFUL_TRANSITIONS = {
    ("running", "pending_delete"),
    ("pending_delete", "deleting"),
    ("deleting", "deleted"),
}
FORCE_TRANSITIONS = {
    ("running", "pending_force_delete"),
    ("pending_delete", "pending_force_delete"),
    ("pending_force_delete", "deleting"),
    ("error", "deleting"),
}

DRAINED_REQUIRES = {
    "signal_recorded_before_first_pending_delete",
    "legal_transitions_only",
    "job_completed_naturally_before_deleting",
    "artifacts_complete",
    "vm_absent_and_registration_absent_correlated",
}
ORPHANED_RULES = {
    "provider_error_or_runner_failed",
    "stopped_or_unknown_terminal",
    "force_delete_inside_grace_or_without_action_ref",
    "deleting_or_deleted_while_job_in_progress",
    "vm_absent_xor_registration_absent",
}

TIMEOUT_DISPOSITION = {
    "new_admissions": "stopped_at_signal",
    "running_job": "continues_to_natural_completion",
    "force_delete": "separate_reviewed_operator_action_only",
}

FORBIDDEN_ACTIONS = {
    "workflow_edit", "routing_change", "pool_change", "cap_change",
    "static_service_change", "active_work_aborted", "credential_change",
    "provider_restart", "running_vm_profile_change", "cache_removal",
}


class InvalidDrain(ValueError):
    pass


def require(condition, field):
    if not condition:
        raise InvalidDrain(field)


def obj(value, keys, field):
    require(type(value) is dict, field + ": object required")
    require(set(value) == set(keys), field + ": missing or unexpected fields")
    return value


def flag(value, expected, field):
    require(type(value) is bool and value is expected, field)


def names(value, expected, field):
    require(type(value) is list, field + ": list required")
    require(len(value) == len(expected), field + ": unexpected entry count")
    require(set(value) == expected, field + ": unexpected entries")
    require(len(set(value)) == len(value), field + ": duplicate entries")
    for entry in value:
        require(type(entry) is str and 0 < len(entry) <= 120, field)


def edges(value, expected, field):
    require(type(value) is list, field + ": list required")
    seen = set()
    for edge in value:
        obj(edge, {"from", "to"}, field + " edge")
        for key in ("from", "to"):
            require(type(edge[key]) is str and 0 < len(edge[key]) <= 40,
                    field + " edge." + key)
        pair = (edge["from"], edge["to"])
        require(pair not in seen, field + ": duplicate edge")
        seen.add(pair)
    require(seen == expected, field + ": unexpected edge set")


def rules(value, expected, field):
    require(type(value) is list, field + ": list required")
    require(len(value) == len(expected), field + ": unexpected rule count")
    require(set(value) == expected, field + ": unexpected rules")
    require(len(set(value)) == len(value), field + ": duplicate rules")
    for rule in value:
        require(type(rule) is str and 0 < len(rule) <= 120, field)


def validate(contract):
    """Validate a synthetic drain-contracts proposal, without any I/O."""
    c = obj(contract, {"schema", "evidence_class", "status", "source_baseline",
                       "drain_signal", "grace", "timeout_disposition",
                       "reaper", "forbidden_preparation_actions",
                       "admission_authorized", "host_verified", "installed",
                       "missing_input_disposition"}, "contract")
    require(c["schema"] == SCHEMA, "schema")
    require(c["evidence_class"] == "synthetic", "evidence_class: synthetic only")
    require(c["status"] == "synthetic-proposal-only", "status")

    base = obj(c["source_baseline"], {"garm", "provider", "lxd",
                                      "verified_live"}, "source_baseline")
    require(base["garm"] == "0.2.1", "source_baseline.garm")
    require(base["provider"] == "0.1.3", "source_baseline.provider")
    require(base["lxd"] == "5.21", "source_baseline.lxd")
    flag(base["verified_live"], False, "source_baseline.verified_live")

    signal = obj(c["drain_signal"], {"allowed", "forbidden", "requires"},
                 "drain_signal")
    names(signal["allowed"], ALLOWED_SIGNALS, "drain_signal.allowed")
    names(signal["forbidden"], FORBIDDEN_SIGNALS, "drain_signal.forbidden")
    names(signal["requires"], SIGNAL_REQUIRES, "drain_signal.requires")

    grace = obj(c["grace"], {"drain_grace_min", "poll_interval_min",
                             "runner_bootstrap_timeout_min",
                             "grace_floor_rationale", "poll_rationale",
                             "bootstrap_rationale"}, "grace")
    # MUTATION-ANCHOR-START: grace gate (the suite deletes this block to prove
    # the gate is load-bearing: the mutant must accept a lowered grace).
    require(type(grace["drain_grace_min"]) is int
            and grace["drain_grace_min"] == DRAIN_GRACE_MIN,
            "grace.drain_grace_min: proposed floor 150 only")
    require(type(grace["poll_interval_min"]) is int
            and grace["poll_interval_min"] == POLL_INTERVAL_MIN,
            "grace.poll_interval_min")
    require(type(grace["runner_bootstrap_timeout_min"]) is int
            and grace["runner_bootstrap_timeout_min"]
            == RUNNER_BOOTSTRAP_TIMEOUT_MIN,
            "grace.runner_bootstrap_timeout_min")
    # MUTATION-ANCHOR-END
    for key in ("grace_floor_rationale", "poll_rationale",
                "bootstrap_rationale"):
        require(type(grace[key]) is str and 0 < len(grace[key]) <= 400, "grace." + key)
        require("proposed only" in grace[key], "grace." + key)

    timeout = obj(c["timeout_disposition"], {"new_admissions", "running_job",
                                             "force_delete"},
                  "timeout_disposition")
    for key, expected in TIMEOUT_DISPOSITION.items():
        require(timeout[key] == expected, "timeout_disposition." + key)

    reaper = obj(c["reaper"], {"drained_requires_all", "orphaned_if_any",
                               "graceful_transitions", "force_transitions"},
                 "reaper")
    rules(reaper["drained_requires_all"], DRAINED_REQUIRES,
          "reaper.drained_requires_all")
    rules(reaper["orphaned_if_any"], ORPHANED_RULES, "reaper.orphaned_if_any")
    # MUTATION-ANCHOR-START: edge gate (the suite deletes this block to prove
    # the gate is load-bearing: the mutant must accept a shortcut edge).
    edges(reaper["graceful_transitions"], GRACEFUL_TRANSITIONS,
          "reaper.graceful_transitions")
    edges(reaper["force_transitions"], FORCE_TRANSITIONS,
          "reaper.force_transitions")
    # MUTATION-ANCHOR-END

    actions = c["forbidden_preparation_actions"]
    require(type(actions) is list and set(actions) == FORBIDDEN_ACTIONS,
            "forbidden_preparation_actions")
    flag(c["admission_authorized"], False, "admission_authorized")
    flag(c["host_verified"], False, "host_verified")
    flag(c["installed"], False, "installed")
    require(type(c["missing_input_disposition"]) is str
            and 0 < len(c["missing_input_disposition"]) <= 200,
            "missing_input_disposition")
    return {"schema": SCHEMA, "result": "offline_drain_valid",
            "evidence_class": "synthetic", "admission_authorized": False,
            "host_verified": False, "installed": False}


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value, "JSON: duplicate key")
        value[key] = item
    return value


def parse(raw):
    require(len(raw) <= MAX_BYTES, "JSON: input exceeds 1MiB")

    def reject_constant(_value):
        raise InvalidDrain("JSON: non-finite number")
    try:
        return json.loads(raw, object_pairs_hook=unique_object,
                          parse_constant=reject_constant)
    except InvalidDrain:
        raise
    except (ValueError, UnicodeDecodeError, RecursionError):
        raise InvalidDrain("JSON: malformed input") from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("contract", type=Path,
                        help="nonsecret, fabricated drain-contracts JSON")
    args = parser.parse_args()
    try:
        with args.contract.open("rb") as stream:
            raw = stream.read(MAX_BYTES + 1)
        result = validate(parse(raw))
    except (InvalidDrain, OSError) as exc:
        # Never echo raw input, paths, credentials or arbitrary field values.
        reason = str(exc) if isinstance(exc, InvalidDrain) else "input file unavailable"
        print(json.dumps({"result": "offline_drain_rejected", "reason": reason,
                          "admission_authorized": False}))
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
