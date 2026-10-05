#!/usr/bin/env python3
"""
gate_harness.py —  pre-registered gate predicates for the 7-day cost shadow
and the 48-hour writer-agreement stream.

WHY THIS EXISTS BEFORE THE DATA
  The card's acceptance is "another agent can reproduce counts from cited
  queries/artifacts". If the counting predicates are chosen after the shadow stream
  exists, every disagreement can be explained away and the gate is unfalsifiable.
  This file fixes them now, in executable form, against the real baseline
  (the operator's original tier_dispatcher.py, read 2026-09-11).

  Two properties of the baseline force the design:
  (a) pick() sorts its 20% price band with a `_r.random()` tie-break  -> the host
      writer is nondeterministic by design among (lane-util, price, proven) ties;
  (b) 10% of T2/T3 picks go to an unproven candidate (EXPLORE slot).
  Both are approved baseline policy, so divergences caused by them are EXPLAINED
  classes (PI-5, PI-6), not defects. Without pre-registering them, the
  "zero unexplained over >=200 decisions" gate false-fails.

CONTRACT
  Every writer in the comparison (host tier_dispatcher.py, plugin shadow selector)
  emits one JSONL record per decision with schema paired-decision-v1 (see
  SCHEMA below). This harness correlates, classifies, and renders the verdict.
  Fail-closed rule: a rule whose inputs are absent from the record is NOT
  considered satisfied; absence of evidence classifies as unexplained.

Usage:
  gate_harness.py agreement  --host <host.jsonl> --shadow <shadow.jsonl> [--out report.json]
  gate_harness.py earn-in    --ledger <cohorts.json>
  gate_harness.py cost-shadow --diff <diff.json>
  gate_harness.py --schema      # print the record schema
Exit code 0 iff the requested gate passes.
"""
import json, sys, datetime as dt

# ---------------------------------------------------------------- schema ----
SCHEMA_VERSION = "paired-decision-v1"
SCHEMA = {
    "type": "object",
    "required": ["schema", "writer", "issueId", "ts", "tier", "stateFingerprint",
                 "pickedModel", "laneSnapshot"],
    "fields": {
        "schema": f"const {SCHEMA_VERSION}",
        "writer": "host | plugin-shadow",
        "issueId": "uuid",
        "issueIdentifier": "TOG-nnnn (display only)",
        "ts": "ISO-8601 UTC — decision commit time",
        "trigger": "new-card | repin | balance | label-only",
        "tier": "T1|T2|T3 — the tier the decision was made under",
        "pickedModel": "model id the writer chose (or kept: then == keptPin)",
        "keptPin": "previous pin if the writer deferred/kept, else null",
        "stateFingerprint": {
            "status": "issue status at decision",
            "hadOverride": "bool — issue carried assigneeAdapterOverrides pin",
            "hadRunningRun": "bool — running/queued heartbeat run existed",
            "pinOperator": "bool — issue carries label pin:operator",
        },
        "laneSnapshot": {
            "ageSeconds": "age of the freshest lane document used, seconds",
            "quality": "live | cached | unknown",
            "laneFetchErrors": ["lane keys whose document fetch failed"],
            "lanes": {"<lane>": {"weekly": "0..1", "fiveHour": "0..1",
                                  "state": "available|degraded|exhausted|unavailable",
                                  "paceDeviation": "weekly_util - elapsed_fraction; negative = behind pace",
                                  "accounts": [{"accountKey": "stable collector account label",
                                                "authKey": "opaque CLIProxy auth id or null",
                                                "plan": "reviewed plan id or null",
                                                "health": "healthy|degraded|exhausted|unavailable|unknown",
                                                "serviceable": "bool — included in provider pace blend",
                                                "weight": "reported plan weight or 1 in shadow",
                                                "weightSource": "reported|default",
                                                "bindingWindow": "most restrictive allowance window or null",
                                                "bindingResetAt": "binding reset ISO timestamp or null",
                                                "utilization": "binding utilization 0..1 or null",
                                                "elapsedTarget": "binding elapsed fraction or null",
                                                "paceDebt": "allowance-weighted debt or null",
                                                "clearRate": "allowance units/hour needed to clear or null",
                                                "state": "account pace state",
                                                "desiredPriority": "100 in final-24h push, else 0",
                                                "desiredWeight": "WRR share 0..1000000",
                                                "servedAuth": "actual served auth when observable, else null"}],
                                  "slotFactor": "current ahead-of-line slot factor, 0..1 (optional)"}},
        },
        "candidates": [{"model": "...", "lane": "...", "tier": "T?",
                        "capable": "bool per modelScores", "proven": "bool",
                        "usable": "bool at this snapshot", "blended": "$/M blended"}],
        "explanations": ["self-tagged class ids; the harness re-derives and must CONFIRM"],
        "operatorOverride": "null | {id, expiresAt} — expiring operator pin in force",
        "pickWhy": "verbatim pick() rationale from the emitting writer",
    },
}

# ------------------------------------------------- pre-registered constants --
MAX_SNAPSHOT_AGE_S      = 300   # 5 min: pollLanes cadence contract; older = stale
PACE_MARGIN             = 0.05  # |deviation difference| needed to claim PI-1
PRICE_BAND_TIE          = 1.20  # baseline's own 20% band -> tie-break is random
PRICE_BAND_UTIL_EPS     = 0.05  # lane-util difference treated as equal inside a band
CLEAN_WINDOW_HOURS      = 48
CLEAN_WINDOW_MIN_N      = 200
STALE_AGREEMENT_ESCALATE = 3    # stale-but-agreed picks before it becomes a defect
SLOT_FLOOR              = 0.25
FIVE_HOUR_BRAKE         = 0.80
EARN_IN_MAX_CARDS       = 8     # per model per rolling 7 days
EARN_IN_T1_ONLY_CLASSES = {"research", "review"}   # reversible T1 research/review only
EARN_IN_EXCLUDED        = {"credentials", "permissions", "approvals",
                           "operator-pin", "operator-exclusion", "running-card"}
COST_WINDOW_DAYS        = 7
COST_CHANGED_PICK_REASONS = {   # enumerated; anything else = unexplained -> fail
    "CP-1": "acceptance-rate reordering within tier",
    "CP-2": "censored-card exclusion changed the denominator",
    "CP-3": "missing-review neutrality (acceptance not imputed)",
    "CP-4": "lane-availability substitution within tier",
}

def _ts(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))

def _fmt(t):
    return t.isoformat(timespec="seconds").replace("+00:00", "Z")

# ------------------------------------------------------- record validation --
def validate(rec):
    """Return list of schema violations (empty = valid)."""
    errs = []
    for f in SCHEMA["required"]:
        if f not in rec:
            errs.append(f"missing field {f}")
    if rec.get("schema") != SCHEMA_VERSION:
        errs.append(f"schema {rec.get('schema')!r} != {SCHEMA_VERSION}")
    if rec.get("writer") not in ("host", "plugin-shadow"):
        errs.append(f"writer {rec.get('writer')!r} invalid")
    if rec.get("tier") not in ("T1", "T2", "T3"):
        errs.append(f"tier {rec.get('tier')!r} invalid")
    try:
        _ts(rec["ts"])
    except Exception:
        errs.append("ts not ISO-8601")
    fp = rec.get("stateFingerprint") or {}
    for f in ("status", "hadOverride", "hadRunningRun", "pinOperator"):
        if f not in fp:
            errs.append(f"stateFingerprint.{f} missing")
    sn = rec.get("laneSnapshot") or {}
    if "ageSeconds" not in sn or "quality" not in sn or "lanes" not in sn:
        errs.append("laneSnapshot incomplete (need ageSeconds, quality, lanes)")
    return errs

def fingerprint(rec):
    fp = rec["stateFingerprint"]
    return (fp["status"], bool(fp["hadOverride"]), bool(fp["hadRunningRun"]),
            bool(fp["pinOperator"]))

# ------------------------------------------------------------ correlation ----
def correlate(host_recs, shadow_recs, bucket_s=600):
    """Pair host/plugin-shadow records per issue.

    Comparable iff: same issue, same tier, identical stateFingerprint, and
    timestamps within the same `bucket_s` window (nearest-in-time if several).
    Returns (pairs, non_comparable) — every unpaired record is kept with a
    reason so denominators are auditable, never silently dropped.
    """
    pairs, used_h, used_s = [], set(), set()
    by_issue = {}
    for i, r in enumerate(shadow_recs):
        by_issue.setdefault((r["issueId"], r["tier"]), []).append(("s", i, r))
    for i, r in enumerate(host_recs):
        by_issue.setdefault((r["issueId"], r["tier"]), []).append(("h", i, r))
    for key, group in by_issue.items():
        hs = [g for g in group if g[0] == "h"]
        ss = [g for g in group if g[0] == "s"]
        for _, hi, h in hs:
            best, best_dt = None, None
            for _, si, s in ss:
                if si in used_s:
                    continue
                if fingerprint(h) != fingerprint(s):
                    continue
                d = abs((_ts(h["ts"]) - _ts(s["ts"])).total_seconds())
                if d > bucket_s:
                    continue
                if best_dt is None or d < best_dt:
                    best, best_dt = si, d
            if best is not None:
                used_s.add(best)
                used_h.add(hi)
                pairs.append((h, shadow_recs[best]))
    non_comparable = []
    for i, r in enumerate(host_recs):
        if i not in used_h:
            non_comparable.append({"writer": "host", "issueId": r["issueId"],
                                   "ts": r["ts"], "reason": "no fingerprint-matched shadow decision in bucket"})
    for i, r in enumerate(shadow_recs):
        if i not in used_s:
            non_comparable.append({"writer": "plugin-shadow", "issueId": r["issueId"],
                                   "ts": r["ts"], "reason": "no fingerprint-matched host decision in bucket"})
    pairs.sort(key=lambda p: _ts(p[0]["ts"]))
    return pairs, non_comparable

# ---------------------------------------------------------- classification --
def _lane(rec, model):
    for c in rec.get("candidates") or []:
        if c["model"] == model:
            return c.get("lane")
    sn = rec.get("laneSnapshot") or {}
    lm = (sn.get("lanes") or {}).get(model)
    return lm.get("lane") if isinstance(lm, dict) else None

def _cand(rec, model):
    for c in rec.get("candidates") or []:
        if c["model"] == model:
            return c
    return None

def _blended(rec, model):
    c = _cand(rec, model)
    return float(c["blended"]) if c and "blended" in c else None

def _deviation(rec, model):
    lane = _lane(rec, model)
    if not lane:
        return None
    ld = (rec.get("laneSnapshot", {}).get("lanes") or {}).get(lane)
    return ld.get("paceDeviation") if isinstance(ld, dict) else None

def classify_pair(h, s):
    """Return (verdict, class_id, note). verdict in
    agree | pace-intended | defect | unexplained | stale-agreement."""
    if h["pickedModel"] == s["pickedModel"]:
        age = s.get("laneSnapshot", {}).get("ageSeconds")
        if isinstance(age, (int, float)) and age > MAX_SNAPSHOT_AGE_S:
            return "stale-agreement", "DF-2*", "same pick but shadow snapshot older than contract"
        return "agree", None, ""

    # --- defect classes: policy violations, checked before explanations -----
    sc = _cand(s, s["pickedModel"])
    if sc is None:
        # fail-closed: a pick the record itself does not declare as a candidate cannot be
        # verified against ANY policy rule (tier, capability, price band) — judge it a defect,
        # not an explained divergence. Found by mutant B in the first self-test run.
        return "defect", "DF-8", f"shadow pick {s['pickedModel']} absent from its own declared candidate roster — unverifiable, fail-closed"
    if sc.get("tier") and sc["tier"] != s["tier"]:
        return "defect", "DF-1", f"shadow pick {s['pickedModel']} is {sc['tier']}, decision tier {s['tier']} — pace must never reorder across capability tiers"
    age = s.get("laneSnapshot", {}).get("ageSeconds")
    if isinstance(age, (int, float)) and age > MAX_SNAPSHOT_AGE_S:
        return "defect", "DF-2", f"shadow snapshot age {age:.0f}s > {MAX_SNAPSHOT_AGE_S}s"
    errs = s.get("laneSnapshot", {}).get("laneFetchErrors") or []
    if errs:
        dropped = [ln for ln in errs
                   if ((h.get("laneSnapshot", {}).get("lanes") or {}).get(ln) or {}).get("state") == "available"]
        if dropped:
            return "defect", "DF-3", f"failed lane document(s) {dropped} still available in host snapshot — one 404 must not abort other lanes"
    sf = ((s.get("laneSnapshot", {}).get("lanes") or {})
          .get(_lane(s, s["pickedModel"]) or "") or {}).get("slotFactor")
    if isinstance(sf, (int, float)) and sf < SLOT_FLOOR:
        return "defect", "DF-4", f"slot factor {sf:.2f} below {SLOT_FLOOR} floor while serviceable"
    if s["stateFingerprint"]["hadRunningRun"] and s["pickedModel"] != s.get("keptPin"):
        return "defect", "DF-5", "repinned an issue with a running/queued run"
    ov = s.get("operatorOverride")
    if isinstance(ov, dict) and ov.get("expiresAt") and _ts(ov["expiresAt"]) < _ts(s["ts"]):
        return "defect", "DF-6", "honored an operator override past its expiry"
    if s["stateFingerprint"]["pinOperator"] and s["pickedModel"] != s.get("keptPin"):
        return "defect", "DF-7", "changed a pin:operator pin (only a serviceability hard stop may, and the host made no such stop here)"

    # --- pace-intended classes: approved D1/ behaviour --------------
    d_h, d_s = _deviation(h, h["pickedModel"]), _deviation(s, s["pickedModel"])
    if (isinstance(d_h, (int, float)) and isinstance(d_s, (int, float))
            and d_s < d_h - PACE_MARGIN and sc and sc.get("capable")):
        return "pace-intended", "PI-1", f"within-tier pace reorder: shadow lane deviation {d_s:+.2f} further behind than host {d_h:+.2f}"
    h_lane, s_lane = _lane(h, h["pickedModel"]), _lane(s, s["pickedModel"])
    if h_lane and h_lane != s_lane:
        hf = ((s.get("laneSnapshot", {}).get("lanes") or {}).get(h_lane) or {}).get("slotFactor")
        if isinstance(hf, (int, float)) and hf <= SLOT_FLOOR:
            return "pace-intended", "PI-2", f"host pick's lane {h_lane} at slot floor {hf:.2f}; ahead-of-line throttle moved within tier"
    h5 = ((s.get("laneSnapshot", {}).get("lanes") or {}).get(h_lane or "") or {}).get("fiveHour")
    if (isinstance(h5, (int, float)) and h5 >= FIVE_HOUR_BRAKE
            and (s.get("laneSnapshot", {}).get("quality") == "live")
            and (s.get("laneSnapshot", {}).get("ageSeconds", 1e9)
                 <= h.get("laneSnapshot", {}).get("ageSeconds", 0))):
        return "pace-intended", "PI-3", f"dual-window brake: shadow's fresher live snapshot shows {h_lane} 5h at {h5:.2f}"
    if s.get("keptPin") and s["pickedModel"] == s["keptPin"] and h["pickedModel"] != s["keptPin"]:
        kp = _cand(s, s["keptPin"])
        if kp and kp.get("usable"):
            return "pace-intended", "PI-4", "hysteretic defer: shadow kept a usable current pin (idle-only repin policy)"
    b_h, b_s = _blended(h, h["pickedModel"]), _blended(s, s["pickedModel"])
    if isinstance(b_h, (int, float)) and isinstance(b_s, (int, float)):
        # baseline semantics (tier_dispatcher.py:226-228): the band is computed over the
        # ELIGIBLE set each writer saw, not the two picks pairwise — min blended among the
        # writer's own usable+capable+proven (or >=$0.10) candidates, picks within 20% of it tie.
        def band_lo(rec):
            elig = [c for c in rec.get("candidates") or []
                    if c.get("usable") and c.get("capable") and (c.get("proven") or c.get("blended", 1e9) >= 0.10)]
            return min((float(c["blended"]) for c in elig), default=None)
        lo_h, lo_s = band_lo(h), band_lo(s)
        if (isinstance(lo_h, (int, float)) and isinstance(lo_s, (int, float))
                and b_h <= lo_h * PRICE_BAND_TIE and b_s <= lo_s * PRICE_BAND_TIE
                and sc.get("proven")):
            return "pace-intended", "PI-5", f"price-band tie per each writer's own eligible set: host ${b_h:.2f} vs shadow ${b_s:.2f} (bands ${lo_h:.2f}/${lo_s:.2f}) — baseline's tie-break inside the 20% band is random"
    if "explore unproven" in (h.get("pickWhy") or ""):
        return "pace-intended", "PI-6", "host used its 10% unproven-candidate exploration slot (baseline policy)"

    return "unexplained", None, f"host {h['pickedModel']} vs shadow {s['pickedModel']}: no pre-registered rule matched"

# --------------------------------------------------------- clean-window walk -
def clean_window(pairs_results):
    """Walk decisions in ts order; any defect or unexplained resets the window.
    Pass iff the surviving window spans >=48h and >=200 decisions."""
    start_i, count, resets = 0, 0, []
    satisfied_from = None
    for i, (ts, verdict, cid, note) in enumerate(pairs_results):
        count += 1
        span_h = (_ts(ts) - _ts(pairs_results[start_i][0])).total_seconds() / 3600
        if span_h >= CLEAN_WINDOW_HOURS and count >= CLEAN_WINDOW_MIN_N and satisfied_from is None:
            satisfied_from = pairs_results[start_i][0]
        if verdict in ("defect", "unexplained"):
            resets.append({"at": ts, "verdict": verdict, "class": cid, "note": note})
            start_i, count = i + 1, 0
    final_span_h = (_ts(pairs_results[-1][0]) - _ts(pairs_results[start_i][0])).total_seconds() / 3600 \
        if pairs_results else 0
    passed = satisfied_from is not None or (pairs_results and final_span_h >= CLEAN_WINDOW_HOURS
                                            and count >= CLEAN_WINDOW_MIN_N)
    return {
        "passed": bool(passed),
        "cleanWindowStartedAt": _fmt(_ts(pairs_results[start_i][0])) if pairs_results else None,
        "cleanSpanHours": round(final_span_h, 2),
        "cleanDecisions": count,
        "required": {"hours": CLEAN_WINDOW_HOURS, "decisions": CLEAN_WINDOW_MIN_N},
        "resets": resets,
    }

# ------------------------------------------------------------- gate: writer --
def gate_agreement(host_path, shadow_path):
    def load(p):
        recs = []
        with open(p) as f:
            for ln, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    recs.append(json.loads(line))
                except Exception as e:
                    recs.append({"__malformed__": True, "line": ln, "err": str(e), "ts": "1970-01-01T00:00:00Z"})
        return recs
    host_recs, shadow_recs = load(host_path), load(shadow_path)
    malformed = {
        "host": sum(1 for r in host_recs if r.get("__malformed__") or validate(r)),
        "shadow": sum(1 for r in shadow_recs if r.get("__malformed__") or validate(r)),
    }
    host_v, shadow_v = [r for r in host_recs if not r.get("__malformed__") and not validate(r)], \
                       [r for r in shadow_recs if not r.get("__malformed__") and not validate(r)]
    pairs, non_comparable = correlate(host_v, shadow_v)
    results, table = [], {}
    for h, s in pairs:
        verdict, cid, note = classify_pair(h, s)
        results.append((s["ts"], verdict, cid, note))
        k = f"{verdict}/{cid or '-'}"
        table[k] = table.get(k, 0) + 1
    window = clean_window(results)
    n_dis = sum(1 for r in results if r[1] in ("pace-intended", "defect", "unexplained"))
    unexplained = [r for r in results if r[1] == "unexplained"]
    passed = window["passed"] and not unexplained and malformed == {"host": 0, "shadow": 0}
    return {
        "gate": "48h-writer-agreement",
        "passed": passed,
        "denominators": {
            "hostRecords": len(host_recs), "shadowRecords": len(shadow_recs),
            "comparablePairs": len(pairs), "nonComparable": len(non_comparable),
            "disagreements": n_dis, "malformed": malformed,
        },
        "agreementTable": dict(sorted(table.items())),
        "unexplained": [{"ts": r[0], "note": r[3]} for r in unexplained],
        "cleanWindow": window,
        "nonComparableSample": non_comparable[:10],
    }

# ------------------------------------------------------------- gate: earn-in -
def gate_earn_in(ledger_path):
    ledger = json.load(open(ledger_path))
    v = []
    def bad(rec, rule, msg):
        v.append({"issueId": rec.get("issueId"), "model": rec.get("model"), "rule": rule, "detail": msg})
    for rec in ledger["cohorts"]:
        if rec.get("cardClass") not in EARN_IN_T1_ONLY_CLASSES:
            bad(rec, "E-class", f"card class {rec.get('cardClass')!r} not in {sorted(EARN_IN_T1_ONLY_CLASSES)}")
        for ex in rec.get("exclusionFlags", []):
            if ex in EARN_IN_EXCLUDED:
                bad(rec, "E3-exclusion", f"excluded class {ex} present")
        if rec.get("laneAvailableAtAdmit") is not True:
            bad(rec, "E4-lane", "candidate lane not available at dispatch")
        if rec.get("claudeBehindAtAdmit") is not True:
            bad(rec, "E5-claude-behind", "Claude not behind pace at admission")
        if rec.get("safetyStop"):
            bad(rec, "E6-safety", "safety/authority violation recorded but cohort not stopped")
        if rec.get("failures", 0) >= 2 and rec.get("active"):
            bad(rec, "E6-two-failure", f"{rec['failures']} first-submission failures but still active")
    # E1: <=8 per model per rolling 7d; E2: one active per model, per lane
    by_model = {}
    for rec in ledger["cohorts"]:
        by_model.setdefault(rec["model"], []).append(rec)
    for model, recs in by_model.items():
        active = [r for r in recs if r.get("active")]
        if len(active) > 1:
            bad(active[0], "E2-one-active-model", f"{len(active)} active cards on one model")
        if len({r.get("lane") for r in active}) < len(active):
            bad(active[0], "E2-one-active-lane", "two active cohort cards share a lane")
        ts = sorted(_ts(r["admittedAt"]) for r in recs)   # already datetimes; don't re-parse
        for i, t in enumerate(ts):
            window = [x for x in ts if x <= t + dt.timedelta(days=7)]
            if len(window) > EARN_IN_MAX_CARDS:
                bad(recs[i], "E1-cap", f"{len(window)} admissions in a rolling 7 days (max {EARN_IN_MAX_CARDS})")
                break
    return {"gate": "earn-in-invariants", "passed": not v, "violations": v,
            "cohorts": len(ledger["cohorts"])}

# -------------------------------------------------------- gate: cost shadow --
def gate_cost_shadow(diff_path):
    d = json.load(open(diff_path))
    v = []
    span_days = (_ts(d["windowEnd"]) - _ts(d["windowStart"])).total_seconds() / 86400
    if span_days < COST_WINDOW_DAYS:
        v.append({"rule": "C1-window", "detail": f"window {span_days:.2f}d < {COST_WINDOW_DAYS}d"})
    for tier, t in (d.get("perTier") or {}).items():
        denom = t.get("cardsEntering", 0)
        if denom != t.get("censored", 0) + t.get("missingReview", 0) + t.get("scored", 0):
            v.append({"rule": "C2-denominator", "tier": tier,
                      "detail": "cardsEntering != censored + missingReview + scored"})
        if t.get("imputedMissingAcceptance"):
            v.append({"rule": "C5-impute", "tier": tier, "detail": "missing acceptance imputed (must stay unscored)"})
    for cp in d.get("changedPicks", []):
        if cp.get("reason") not in COST_CHANGED_PICK_REASONS:
            v.append({"rule": "C4-reason", "issueId": cp.get("issueId"),
                      "detail": f"reason {cp.get('reason')!r} not in enumerated set {sorted(COST_CHANGED_PICK_REASONS)}"})
    return {"gate": "7d-cost-shadow", "passed": not v, "violations": v,
            "windowDays": round(span_days, 2),
            "changedPicks": len(d.get("changedPicks", []))}

# -------------------------------------------------------------------- main ---
def main():
    if "--schema" in sys.argv:
        print(json.dumps(SCHEMA, indent=2)); return 0
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    def arg(name):
        return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else None
    if mode == "agreement":
        rep = gate_agreement(arg("--host"), arg("--shadow"))
    elif mode == "earn-in":
        rep = gate_earn_in(arg("--ledger"))
    elif mode == "cost-shadow":
        rep = gate_cost_shadow(arg("--diff"))
    else:
        print(__doc__); return 2
    out = arg("--out")
    text = json.dumps(rep, indent=2)
    if out:
        open(out, "w").write(text)
    print(text)
    return 0 if rep["passed"] else 1

if __name__ == "__main__":
    sys.exit(main())
