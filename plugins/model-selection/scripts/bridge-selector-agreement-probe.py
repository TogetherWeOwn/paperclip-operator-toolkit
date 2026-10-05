#!/usr/bin/env python3
"""Bridge-vs-selector agreement probe. OFFLINE ONLY.

Feeds fixture snapshots (bridge picks + selector picks for
muse-spark-1.3-contributor(xhigh), claude-sonnet-5-5, gpt-6.1-sol) through the
pre-registered agreement predicate in ops/gate_harness.py and emits a
per-minute agreement report.

Reads nothing live, adds no roster rows, wires nothing. The fixture matrix is
the only input; the gate harness is the only judge.

Usage:
  bridge-selector-agreement-probe.py [--matrix <path>] [--out <report.json>]
      [--gate-harness <gate_harness.py>]

Exit 0 iff every fixture minute produced a report row and the report was
written. Exit non-zero on malformed input, schema violations, or I/O errors.
(This is a per-minute comparison report, NOT the 48h/200-decision clean-window
gate — that gate still owns pass/fail for enforce/retirement.)
"""
import argparse
import copy
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve()
REPO_ROOT = HERE.parent.parent.parent.parent
DEFAULT_MATRIX = (
    REPO_ROOT
    / "plugins"
    / "model-selection"
    / "tests"
    / "fixtures"
    / "bridge-selector-agreement-matrix.json"
)
DEFAULT_GATE = REPO_ROOT / "ops" / "gate_harness.py"


def fail(message):
    print(f"bridge-selector-agreement-probe: ERROR: {message}", file=sys.stderr)
    sys.exit(1)


def load_gate_harness(gate_path):
    sys.path.insert(0, str(Path(gate_path).resolve().parent))
    try:
        import gate_harness
    except Exception as exc:
        fail(f"could not import gate harness {gate_path}: {exc}")
    for fn in ("validate", "correlate", "classify_pair"):
        if not callable(getattr(gate_harness, fn, None)):
            fail(f"gate harness {gate_path} has no callable {fn}()")
    if getattr(gate_harness, "SCHEMA_VERSION", "") != "paired-decision-v1":
        fail("gate harness schema mismatch: expected paired-decision-v1")
    return gate_harness


def build_lane_snapshot(minute, defaults, age_seconds):
    lanes_cfg = defaults.get("lanes", [])
    deviations = minute.get("deviations", {}) or {}
    default_dev = defaults.get("deviation", -0.1)
    lanes = {}
    for lane in lanes_cfg:
        lanes[lane] = {
            "weekly": defaults.get("weekly", 0.2),
            "fiveHour": defaults.get("fiveHour", 0.2),
            "state": "available",
            "paceDeviation": deviations.get(lane, default_dev),
        }
    return {
        "ageSeconds": age_seconds,
        "quality": defaults.get("quality", "live"),
        "laneFetchErrors": [],
        "lanes": lanes,
    }


def build_record(*, writer, issue_id, ts, tier, picked_model, fingerprint,
                 lane_snapshot, candidates, pick_why, issue_label):
    return {
        "schema": "paired-decision-v1",
        "writer": writer,
        "issueId": issue_id,
        "issueIdentifier": issue_label,
        "ts": ts,
        "trigger": "new-card",
        "tier": tier,
        "pickedModel": picked_model,
        "keptPin": None,
        "stateFingerprint": copy.deepcopy(fingerprint),
        "laneSnapshot": lane_snapshot,
        "candidates": copy.deepcopy(candidates),
        "explanations": [],
        "operatorOverride": None,
        "pickWhy": pick_why,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--matrix", default=str(DEFAULT_MATRIX))
    parser.add_argument("--out", default=None)
    parser.add_argument("--gate-harness", default=str(DEFAULT_GATE))
    args = parser.parse_args()

    gate = load_gate_harness(args.gate_harness)

    try:
        matrix = json.loads(Path(args.matrix).read_text())
    except Exception as exc:
        fail(f"could not read matrix {args.matrix}: {exc}")

    try:
        bridge_map = matrix["bridgeModelMap"]
        defaults = matrix["defaults"]
        minutes = matrix["minutes"]
        base_fp = defaults["fingerprint"]
        candidates = defaults["candidates"]
        pick_why = defaults.get("pickWhy", "fixture probe selection")
    except KeyError as exc:
        fail(f"matrix missing required key: {exc}")
    if not isinstance(minutes, list) or not minutes:
        fail("matrix.minutes must be a non-empty list")

    host_recs, shadow_recs = [], []
    for index, minute in enumerate(minutes, start=1):
        try:
            bridge = minute["bridge"]
            tier = minute["tier"]
            ts = minute["ts"]
            selector = minute["selector"]
            bridge_model = bridge_map[bridge]["model"]
        except KeyError as exc:
            fail(f"minute {index}: missing key {exc}")
        issue_id = f"14134134-0000-4000-8000-0000000000{index:02d}"
        label = f"-M{index}"
        shadow_fp = minute.get("shadowFingerprint", base_fp)
        host_recs.append(build_record(
            writer="host", issue_id=issue_id, ts=ts, tier=tier,
            picked_model=bridge_model, fingerprint=base_fp,
            lane_snapshot=build_lane_snapshot(
                minute, defaults,
                minute.get("hostAgeSeconds", defaults.get("hostAgeSeconds", 60))),
            candidates=candidates, pick_why=pick_why, issue_label=label))
        shadow_recs.append(build_record(
            writer="plugin-shadow", issue_id=issue_id, ts=ts, tier=tier,
            picked_model=selector, fingerprint=shadow_fp,
            lane_snapshot=build_lane_snapshot(
                minute, defaults,
                minute.get("shadowAgeSeconds", defaults.get("shadowAgeSeconds", 60))),
            candidates=candidates, pick_why=pick_why, issue_label=label))

    problems = []
    for rec in host_recs + shadow_recs:
        errs = gate.validate(rec)
        if errs:
            problems.append({"issueId": rec["issueId"], "errors": errs})
    if problems:
        fail(f"{len(problems)} record(s) violate paired-decision-v1: "
             f"{json.dumps(problems[:3])}")

    pairs, non_comparable = gate.correlate(host_recs, shadow_recs)
    by_issue = {}
    table = {}
    for host, shadow in pairs:
        verdict, class_id, note = gate.classify_pair(host, shadow)
        by_issue[host["issueId"]] = (verdict, class_id, note)
        key = f"{verdict}/{class_id or '-'}"
        table[key] = table.get(key, 0) + 1

    rows = []
    for index, minute in enumerate(minutes, start=1):
        issue_id = f"14134134-0000-4000-8000-0000000000{index:02d}"
        bridge = minute["bridge"]
        verdict, class_id, note = by_issue.get(issue_id, ("non-comparable", None,
            "no fingerprint-matched counterpart in bucket"))
        rows.append({
            "minute": minute["ts"],
            "bridge": bridge,
            "bridgeModel": bridge_map[bridge]["model"],
            "selector": minute["selector"],
            "tier": minute["tier"],
            "verdict": verdict,
            "class": class_id,
            "note": note,
        })

    report = {
        "schema": "bridge-selector-report-v1",
        "matrix": Path(args.matrix).name,
        "offline": True,
        "denominators": {
            "minutes": len(minutes),
            "hostRecords": len(host_recs),
            "shadowRecords": len(shadow_recs),
            "comparablePairs": len(pairs),
            "nonComparable": len(non_comparable),
        },
        "agreementTable": dict(sorted(table.items())),
        "minutes": rows,
        "nonComparableSample": non_comparable[:10],
        "note": ("Per-minute fixture comparison through the  agreement "
                 "predicate. Not the 48h/200-decision clean-window gate."),
    }

    text = json.dumps(report, indent=2) + "\n"
    if args.out:
        try:
            Path(args.out).write_text(text)
        except Exception as exc:
            fail(f"could not write {args.out}: {exc}")
    print(f"minutes={len(minutes)} pairs={len(pairs)} "
          f"nonComparable={len(non_comparable)}")
    for key in sorted(table):
        print(f"  {key}: {table[key]}")
    for row in rows:
        cls = row["class"] or "-"
        print(f"  {row['minute']} bridge={row['bridge']} "
              f"selector={row['selector']} -> {row['verdict']}/{cls}")
    if args.out:
        print(f"report: {args.out}")
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
