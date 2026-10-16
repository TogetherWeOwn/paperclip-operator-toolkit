#!/usr/bin/env python3
"""Offline structural checks for the idle-VM TTL/reaper proposal; never authorization.

Reads one nonsecret fabricated idle-ttl-contracts JSON (bounded to 1 MiB)
and checks it agrees with IDLE-TTL-REAPER-POLICY.md: the per-pool TTL
table (ephemeral propose, canary observe-only, static out-of-scope), the
oldest-first reap order, the canary/static protections, the dry-run
report shape, the stuck thresholds, and the timeout disposition. Any
disagreement exits 1 with a non-echoing structured rejection. A pass
returns admission_authorized False, host_verified False, installed
False: validation is structural agreement with the proposal, never
permission to reap, delete, or execute.

It never builds, pulls, or runs an image, never touches the network, and
never needs a credential. The CLI reads only its explicitly supplied
nonsecret contract file. Do not feed credentials/private configs to the
checker. It is not a general-purpose secret scanner.
"""

import argparse
import json
import sys
from pathlib import Path

SCHEMA = "garm-idle-ttl-contracts.v1"
MAX_BYTES = 1024 * 1024

TTL_MIN = 240
ORPHAN_MULT = 2
ORPHAN_MIN = 480
PROV_STUCK_MIN = 30
DRAIN_STUCK_MIN = 60

REAP_ORDER = ["idle-excess", "stale", "busy"]
WITHIN_BUCKET = "oldest-first"

EPHEMERAL_ROLES = {"isolated-private", "privileged-private"}
CANARY_ROLES = {"canary"}
STATIC_LABELS = {"two-selfhosted", "two-isolated"}

REPORT_TOP_LEVEL = {"breachReasons", "candidates", "errors", "now",
                    "orphanMin", "pools", "tool", "ttlMin", "verdict"}
CANDIDATE_FIELDS = {"ageMin", "bucket", "createdAt", "name", "pool",
                    "runnerStatus", "status"}
VERDICTS = {"BREACH", "OK", "PROPOSE"}


def reject(reason):
    print(json.dumps({"status": "invalid_idle_ttl", "reason": reason}))
    return 1


def main(argv=None):
    ap = argparse.ArgumentParser(description="validate idle-ttl contracts")
    ap.add_argument("contract", help="path to idle-ttl-contracts.json")
    args = ap.parse_args(argv)

    p = Path(args.contract)
    try:
        raw = p.read_bytes()
    except OSError:
        return reject("unreadable_contract")
    if len(raw) > MAX_BYTES or len(raw) == 0:
        return reject("contract_size")
    try:
        doc = json.loads(raw)
    except json.JSONDecodeError:
        return reject("contract_not_json")
    if not isinstance(doc, dict):
        return reject("contract_shape")

    if doc.get("schema") != SCHEMA:
        return reject("schema")
    if doc.get("evidence_class") != "synthetic":
        return reject("evidence_class")
    if doc.get("status") != "synthetic-proposal-only":
        return reject("status")
    base = doc.get("source_baseline")
    if not isinstance(base, dict) or base.get("garm") != "0.2.1" \
            or base.get("provider") != "0.1.3" or base.get("lxd") != "5.21" \
            or base.get("verified_live") is not False:
        return reject("source_baseline")

    dflt = doc.get("reaper_defaults")
    if not isinstance(dflt, dict) or dflt.get("ttl_min") != TTL_MIN \
            or dflt.get("orphan_mult") != ORPHAN_MULT \
            or dflt.get("orphan_min") != ORPHAN_MIN \
            or dflt.get("prov_stuck_min") != PROV_STUCK_MIN \
            or dflt.get("drain_stuck_min") != DRAIN_STUCK_MIN:
        return reject("reaper_defaults")

    pools = doc.get("pools")
    if not isinstance(pools, dict):
        return reject("pools_shape")
    eph = pools.get("ephemeral-default")
    if not isinstance(eph, dict) or eph.get("mode") != "propose" \
            or eph.get("never_candidate") is not False \
            or eph.get("ttl_min") != TTL_MIN \
            or eph.get("orphan_min") != ORPHAN_MIN \
            or set(eph.get("roles", [])) != EPHEMERAL_ROLES:
        return reject("ephemeral_pool")
    can = pools.get("canary")
    if not isinstance(can, dict) or can.get("mode") != "observe-only" \
            or can.get("never_candidate") is not True \
            or can.get("stuck_still_breaches") is not True \
            or can.get("ttl_min") != TTL_MIN \
            or can.get("orphan_min") != ORPHAN_MIN \
            or set(can.get("roles", [])) != CANARY_ROLES:
        return reject("canary_pool")
    st = pools.get("static")
    if not isinstance(st, dict) or st.get("mode") != "out-of-scope" \
            or st.get("never_candidate") is not True \
            or st.get("never_in_report") is not True \
            or set(st.get("labels", [])) != STATIC_LABELS \
            or "ttl_min" in st or "orphan_min" in st:
        return reject("static_pool")

    if list(doc.get("reap_order", [])) != REAP_ORDER:
        return reject("reap_order")
    if doc.get("within_bucket") != WITHIN_BUCKET:
        return reject("within_bucket")
    if doc.get("breach_heads_report_but_is_not_delete_order") is not True:
        return reject("breach_not_delete_order")

    rep = doc.get("dry_run_report")
    if not isinstance(rep, dict) \
            or set(rep.get("required_top_level", [])) != REPORT_TOP_LEVEL \
            or set(rep.get("candidate_fields", [])) != CANDIDATE_FIELDS \
            or set(rep.get("verdicts", [])) != VERDICTS:
        return reject("dry_run_report")

    tmo = doc.get("timeout_disposition")
    if not isinstance(tmo, dict) \
            or tmo.get("running_job") != "continues_to_natural_completion" \
            or tmo.get("force_delete") != "separate_reviewed_operator_action_only" \
            or tmo.get("new_admissions") != "stopped_at_signal":
        return reject("timeout_disposition")

    if doc.get("admission_authorized") is not False \
            or doc.get("host_verified") is not False \
            or doc.get("installed") is not False:
        return reject("live_status")

    print(json.dumps({"status": "offline_idle_ttl_valid",
                      "authorizes": "nothing"}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
