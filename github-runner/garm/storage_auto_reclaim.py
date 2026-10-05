#!/usr/bin/env python3
"""Offline GARM ephemeral LXD storage auto-reclaim planner (source-only).

Implements the GARM storage auto-reclaim runbook spec as repository source
ONLY: given ONE explicitly supplied synthetic storage observation, it
emits a dry-run reclaim plan as ``garm-storage-reclaim:`` verdict lines plus
a JSON plan. It deletes nothing, touches no host, queries no API, and mints
no credential. Standard library only; fixture input bounded to 1 MiB. Every
output carries host_mutation_authorized:false and delete_authorized:false.

Dedup: this is automated reclaim PLANNING, not alerting, not the headroom
audit, and not per-job residue cleanup (post_job_cleanup.py works inside
one job dir; this plans at LXD storage-volume level). Host rollout of any
plan goes via a separate reviewed Operator task; this tool authorizes no
rollout.

Two commands, both offline:

- ``plan <observation.json>``: dry-run plan for one synthetic observation.
- Any write-intent flag (``--apply`` and kin) is REFUSED with exit 2: the
  plan is evidence for the Operator card, never an execution trigger.

Candidate volume classes (spec section 3):

- ``finished-job-volume``: leftover of a finished ephemeral job whose VM was
  reclaimed and whose registration deregistered. Eligible only past the R2
  reclamation window (30m); within the window it is window_pending HOLD.
- ``orphan-volume``: no registration, no active job. Past R4 (24h) it is
  planned as orphan hygiene even without pool pressure; between R3 and R4 it
  is a flag-to-operator HOLD.
- ``dangling-snapshot``: snapshot of an already-reclaimed VM. Planned once
  the parent reclamation is confirmed in the same observation.

Refusals (fail closed, exit 2): unmarked dir targets, live-host fixtures
(``source: live-host`` — synthetic only), unknown volume kinds, protected
volumes are never planned (HOLD, not refusal). Non-natural finish and stale
reads (>5m, R5) make the affected scope INCONCLUSIVE, never a plan.
"""

import argparse
import json
import sys

SCHEMA = "garm-storage-reclaim.plan.v1"
MAX_BYTES = 1024 * 1024

# Carried from the reclamation spec (R1-R5); not
# re-decided here. Tests pin these values so a drift fails loudly.
THRESHOLDS = {
    "R2_reclaim_window_min": 30,
    "R3_stale_flag_min": 60,
    "R4_orphan_candidate_min": 1440,
    "R5_read_freshness_min": 5,
    # PROPOSED pool-pressure trigger: plan stale finished-job volumes only
    # when the pool reads at/above this usage. Orphan hygiene (R4) is
    # unconditional. Pending live measurement + operator rollout review.
    "reclaim_trigger_used_pct": 75,
}

VOLUME_KINDS = ("finished-job-volume", "orphan-volume", "dangling-snapshot")
DECISIONS = ("reclaim_plan", "hold", "inconclusive")
FINISHES = ("natural", "killed", "cancelled", "timeout")


class InvalidInput(ValueError):
    pass


def _require(condition, field):
    if not condition:
        raise InvalidInput(field)


def _check_number(value, field):
    _require(type(value) in (int, float), "%s: number required" % field)
    _require(value == value and abs(value) != float("inf"),
             "%s: non-finite" % field)
    _require(value >= 0, "%s: negative" % field)


def validate_observation(obs):
    _require(type(obs) is dict, "observation: object required")
    _require(set(obs) == {"schema", "source", "pool", "volumes"},
             "observation: missing or unexpected fields")
    _require(obs.get("schema") == SCHEMA, "observation: schema mismatch")
    _require(obs.get("source") == "synthetic-fixture",
             "observation: source must be synthetic-fixture")
    pool = obs["pool"]
    _require(type(pool) is dict, "pool: object required")
    _require(set(pool) == {"used_pct", "read_age_min"},
             "pool: missing or unexpected fields")
    _check_number(pool["used_pct"], "pool.used_pct")
    _require(pool["used_pct"] <= 100, "pool.used_pct: over 100")
    _check_number(pool["read_age_min"], "pool.read_age_min")
    volumes = obs["volumes"]
    _require(type(volumes) is list, "volumes: list required")
    for index, vol in enumerate(volumes):
        where = "volumes[%d]" % index
        _require(type(vol) is dict, "%s: object required" % where)
        _require(set(vol) == {"name", "kind", "finish",
                              "minutes_since_finish", "vm_present",
                              "has_registration", "has_active_job",
                              "protected", "parent_reclaimed"},
                 "%s: missing or unexpected fields" % where)
        _require(type(vol["name"]) is str and vol["name"],
                 "%s.name: non-empty string required" % where)
        _require(vol["kind"] in VOLUME_KINDS,
                 "%s.kind: unknown kind" % where)
        _require(vol["finish"] in FINISHES,
                 "%s.finish: unknown value" % where)
        _check_number(vol["minutes_since_finish"],
                      "%s.minutes_since_finish" % where)
        for flag in ("vm_present", "has_registration", "has_active_job",
                     "protected", "parent_reclaimed"):
            _require(type(vol[flag]) is bool,
                     "%s.%s: bool required" % (where, flag))
    names = [vol["name"] for vol in volumes]
    _require(len(set(names)) == len(names), "volumes: duplicate names")
    return obs


def classify_volume(vol, pool_used_pct):
    """One candidate -> (decision, reasons, next_action). Never deletes."""
    r2 = THRESHOLDS["R2_reclaim_window_min"]
    r3 = THRESHOLDS["R3_stale_flag_min"]
    r4 = THRESHOLDS["R4_orphan_candidate_min"]
    age = vol["minutes_since_finish"]

    def out(decision, reasons, next_action):
        return {"name": vol["name"], "kind": vol["kind"],
                "decision": decision, "reasons": reasons,
                "next_action": next_action,
                "host_mutation_authorized": False,
                "delete_authorized": False}

    if vol["protected"]:
        return out("hold", ["protected volume (image/base): never planned"],
                   "exclude from automation scope")
    if vol["finish"] != "natural":
        return out("inconclusive",
                   ["non-natural finish is not reclamation evidence"],
                   "re-observe after natural finish")
    if vol["has_active_job"]:
        return out("hold", ["active job attached: never touch live work"],
                   "re-observe after job finishes naturally")
    if vol["has_registration"]:
        return out("hold", ["registration still present"],
                   "re-observe after deregistration")
    if vol["kind"] == "finished-job-volume" and vol["vm_present"]:
        if age <= r2:
            return out("hold",
                       ["within R2 reclamation window (%dm)" % r2],
                       "re-observe after provider window")
        return out("hold", ["vm still present past R2 window"],
                   "flag to operator; enforce via reaper path")
    if vol["kind"] == "dangling-snapshot" and not vol["parent_reclaimed"]:
        return out("hold", ["parent VM reclamation unconfirmed"],
                   "re-observe with parent status")
    if vol["kind"] == "orphan-volume" and age > r4:
        return out("reclaim_plan",
                   ["orphan past R4 (24h): no job, no registration"],
                   "hand plan to Operator card for reviewed execution")
    if age <= r2 and vol["kind"] != "orphan-volume":
        return out("hold",
                   ["within R2 reclamation window (%dm)" % r2],
                   "re-observe after provider window")
    if age <= r3:
        return out("hold", ["below R3 stale threshold (%dm)" % r3],
                   "re-observe")
    if vol["kind"] == "orphan-volume":
        return out("hold",
                   ["stale orphan below R4: flag to operator, do not delete"],
                   "flag to operator")
    # Stale finished-job volume or confirmed dangling snapshot past R3:
    # planned only under pool pressure, else flagged.
    if pool_used_pct >= THRESHOLDS["reclaim_trigger_used_pct"]:
        return out("reclaim_plan",
                   ["stale past R3 with pool at %d%% (>= %d%% trigger)"
                    % (pool_used_pct,
                       THRESHOLDS["reclaim_trigger_used_pct"])],
                   "hand plan to Operator card for reviewed execution")
    return out("hold",
               ["stale past R3 but pool below trigger: flag, do not delete"],
               "flag to operator")


def plan_observation(obs):
    obs = validate_observation(obs)
    pool = obs["pool"]
    if pool["read_age_min"] > THRESHOLDS["R5_read_freshness_min"]:
        return {"schema": SCHEMA,
                "result": "inconclusive",
                "evidence_class": "synthetic",
                "host_mutation_authorized": False,
                "delete_authorized": False,
                "reasons": ["pool read older than R5 (%dm); re-observe"
                            % THRESHOLDS["R5_read_freshness_min"]],
                "volumes": []}
    items = [classify_volume(vol, pool["used_pct"])
             for vol in obs["volumes"]]
    planned = [item["name"] for item in items
               if item["decision"] == "reclaim_plan"]
    return {"schema": SCHEMA,
            "result": "plan_ready" if planned else "nothing_to_reclaim",
            "evidence_class": "synthetic",
            "host_mutation_authorized": False,
            "delete_authorized": False,
            "thresholds": dict(THRESHOLDS),
            "pool_used_pct": pool["used_pct"],
            "planned": planned,
            "volumes": items}


def _load_json(path):
    with open(path, "rb") as handle:
        raw = handle.read(MAX_BYTES + 1)
    _require(len(raw) <= MAX_BYTES, "input: file over 1 MiB bound")
    try:
        return json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise InvalidInput("input: unparseable (%s)" % type(exc).__name__)


def _refuse_write_intent(argv):
    """Exit 2 on any write-intent flag: plans never execute from here."""
    for arg in argv:
        lowered = arg.lower()
        if lowered in ("--apply", "--delete", "--prune",
                       "--purge", "--wipe", "--exec", "--force",
                       "--yes", "-y", "apply", "clean", "delete",
                       "prune", "fix", "purge", "wipe", "reclaim") or \
                lowered.startswith(("--apply", "--delete", "--prune",
                                    "--purge", "--wipe", "--exec",
                                    "--reclaim", "--remove", "--rm")):
            print("garm-storage-reclaim: REFUSED reason=write-intent "
                  "flag=%s (plans are Operator-card evidence only)"
                  % arg, file=sys.stderr)
            return True
    return False


def build_parser():
    parser = argparse.ArgumentParser(
        prog="storage_auto_reclaim",
        description="Offline GARM LXD storage auto-reclaim planner "
                    "(source-only dry-run).")
    parser.add_argument("observation",
                        help="synthetic storage observation JSON (%s)"
                        % SCHEMA)
    # Write-intent flags are PARSED (suppressed) so that refusal rests
    # solely on the _refuse_write_intent gate above: with the gate deleted,
    # --apply must parse and plan (the mutant control proves the gate is
    # load-bearing rather than argparse doing the refusing). When the gate
    # is present these flags never reach parsing.
    for flag in ("--apply", "--delete", "--prune", "--purge", "--wipe",
                 "--exec", "--force", "--remove", "--reclaim"):
        parser.add_argument(flag, action="store_true",
                            help=argparse.SUPPRESS)
    parser.add_argument("--yes", "-y", action="store_true",
                        help=argparse.SUPPRESS)
    return parser


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    # MUTATION-ANCHOR-START: write-intent refusal (the offline suite deletes
    # this block to prove the gate is load-bearing: the mutant must plan
    # under --apply).
    if _refuse_write_intent(argv):
        return 2
    # MUTATION-ANCHOR-END
    args = build_parser().parse_args(argv)
    try:
        result = plan_observation(_load_json(args.observation))
    except InvalidInput as exc:
        print("garm-storage-reclaim: REFUSED reason=%s" % exc,
              file=sys.stderr)
        return 2
    for item in result.get("volumes", []):
        print("garm-storage-reclaim: %s kind=%s name=%s action=%s" %
              ("PLAN" if item["decision"] == "reclaim_plan"
               else item["decision"].upper(),
               item["kind"], item["name"], item["next_action"]))
    if not result.get("volumes", []):
        print("garm-storage-reclaim: %s reason=%s"
              % (result["result"], "; ".join(result["reasons"])))
    else:
        print("garm-storage-reclaim: RESULT %s planned=%d "
              "host_mutation_authorized=false delete_authorized=false"
              % (result["result"],
                 len(result.get("planned", []))))
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
