#!/usr/bin/env python3
# ===========================================================================
# pacer_concurrency.py — per-agent concurrency target reconciler (the slow
# path of the focused Capacity Orchestrator design)
#
# SCOPE: the slow-timescale half of the pacer. Reads a lane-quota snapshot
# (weekly + 5h headroom per account, same record-shape family as the
# countdown readouts and the admission-observation adapter) plus the agent
# roster with lane mapping, and emits one concurrency target per agent:
# scale UP when the accounts serving that agent's lanes are behind weekly
# pace with 5h headroom, DOWN when ahead or near cap, HOLD in between.
#
# WHAT THIS DOES NOT DO (deliberately, per the host dependency):
#   * No per-run admit/hold enforcement. The live host image lacks the
#     run-model/admission hook, so admission stays an in-output ADVISORY
#     (admit/hold + retryAfter per lane, shadow only) recorded alongside the
#     targets. Enforcement of admission waits on the fork release.
#   * No board writes. This tool never touches the network, a credential, or
#     the roster: it emits targets and PATCH intents. The operator (or the
#     host timer) applies them through the board API with quota_brake.sh's
#     read-modify-write contract. An agent run PATCHing another agent gets
#     403 deny_no_grant (measured), so a self-applying agent tool
#     would be a lie in exactly the dangerous direction.
#   * No model choice. Lane weights, pins, and the fleet-quota-balancer's
#     model selection are untouched — see docs/pacer-concurrency.md.
#
# DECISION RULES (all visible in --json output, per agent, with reasons):
#   * Pace ratio per governing window = consumed / elapsed, where elapsed is
#     the fraction of the window already gone (weekly = 7d, five-hour = 5h).
#     Under 5% elapsed the ratio is noise and the window votes UNKNOWN for
#     pace (its headroom still counts). Worst serving account wins; an idle
#     account never averages a hot one down (same worst-first rule as
#     quota_brake.sh pace_ratio).
#   * UP one step iff ratio <= 0.85 AND every governing 5h window keeps >=
#     0.30 headroom. DOWN one step iff ratio >= 1.15 OR any governing 5h
#     window drops below 0.15. Between is HOLD — the hysteresis dead band.
#   * Steps are +-1 per decision (no jumps). Floor is 1 everywhere (the
#     platform clamps at HEARTBEAT_MAX_CONCURRENT_RUNS_MIN=1 anyway).
#     Ceiling is the operator cap for that agent when present, else the
#     agent's own baseline (scale-up without a cap only restores toward
#     normal; raising normal is an operator edit to the caps file, not an
#     inference). Caps above 32 are refused as insane, not clamped silently.
#     An agent already ABOVE its ceiling never scales up: behind pace it
#     steps down one toward the ceiling (still +-1), and the reason says so.
#   * Dwell/cooldown: a computed move away from the last recorded target
#     within --cooldown-min (default 30) is held at the last target with
#     reason cooldown-hold. Both directions wait; flapping is the failure
#     being prevented, and a faster down-ramp would just re-flap upward.
#     --state is read-only here. Its shape is {"agents": {"<agentId>":
#     {"target": N, "decidedAt": "<UTC Z>"}}}, keyed by the roster id (or the
#     name when the roster row has no id). Every up/down record in the plan
#     carries target and decidedAt so the applier (host timer or operator)
#     can persist exactly the moves it applied; see docs/pacer-concurrency.md.
#   * Frozen lanes (--frozen-lanes, the per-lane kill switch) force nochange
#     for every agent they serve, in both modes. Unknown/stale lane data
#     forces nochange/unknown, never a scaled guess (rule 4 of quota_brake).
#   * Statuses other than idle/running/error consume nothing and are skipped.
#     Critical-path agents keep floor 1 like everyone else and are recorded
#     as critical:true so the applier can order them last; the card asks for
#     a floor, not an exemption, and quota_brake's critical exemption stays
#     where it is (the brake), not duplicated here.
#   * Never cancels running work: the output vocabulary is target/nochange
#     plus PATCH intents for maxConcurrentRuns. There is no cancel, kill,
#     terminate, or disable key anywhere in the schema, pinned by test.
#
# MODES:
#   shadow (default)  — targets carry effect:"none". Safe to run anywhere.
#   enforce --yes     — targets carry effect:"directive" plus a PATCH intent
#                       per moved agent. enforce without --yes is refused
#                       (exit 2): directives must be asked for out loud.
#   --rollback --yes  — restore-to-baseline intents for every agent with a
#                       recorded baseline. Same refusal without --yes.
#
# EXIT CODES
#   0  plan emitted (all modes, including enforce-plan and rollback-plan)
#   2  usage / validation (bad fixture, insane cap, enforce without --yes,
#      frozen lane naming nothing, negative cooldown)
#   5  unmeasured: no usable lane data, so nothing was decided. Zero moves
#      out of zero measurements is "never ran", not "all clear".
#
# Offline: three JSON fixture files in, one JSON plan out. No network, no
# credential, no clock read except --now override (tests pin --now).
# ===========================================================================
from __future__ import annotations

import argparse
import datetime
import json
import math
import os
import sys

UTC = datetime.timezone.utc

WEEKLY_LEN_S = 7 * 24 * 3600
FIVE_HOUR_LEN_S = 5 * 3600

UP_RATIO = 0.85
DOWN_RATIO = 1.15
FIVE_HOUR_UP_HEADROOM = 0.30
FIVE_HOUR_DOWN_HEADROOM = 0.15
ADMIT_WEEKLY_FLOOR = 0.10
EARLY_WINDOW_ELAPSED = 0.05
MAX_SANE_CAP = 32

VALID_STATUSES = ("idle", "running", "error")

_TS_FORMATS = ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S.%fZ")


class PacerError(ValueError):
    """Refused input or an unmeasurable world. Never emits a partial plan."""


def parse_ts(value):
    if not isinstance(value, str) or not value:
        return None
    for fmt in _TS_FORMATS:
        try:
            return datetime.datetime.strptime(value, fmt).replace(tzinfo=UTC)
        except ValueError:
            continue
    return None


def fmt_ts(dt):
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _finite_unit(raw, what):
    if isinstance(raw, bool) or not isinstance(raw, (int, float)) \
            or not math.isfinite(raw):
        raise PacerError("%s is not a finite number: %r" % (what, raw))
    if raw < 0 or raw > 1:
        raise PacerError("%s %r outside [0, 1]" % (what, raw))
    return float(raw)


def classify_window(util, reset_raw, window_len_s, now, lane, kind):
    """One governing window -> {state, headroom, ratio, ...}.

    states: known (live, paced) | early (live but <5% elapsed: headroom
    counts, pace ratio withheld) | unknown (missing utilization) | stale
    (non-live quality) | invalid (bad/past reset). Unknown/stale/invalid
    windows never vote a ratio; callers must treat them as no-measurement.
    """
    if util is None:
        return {"state": "unknown", "reason": "%s utilization missing" % kind}
    util = _finite_unit(util, "%s utilization" % kind)
    headroom = 1.0 - util
    reset = parse_ts(reset_raw)
    if reset is None:
        return {"state": "invalid", "headroom": headroom,
                "reason": "%s reset %r unparseable" % (kind, reset_raw)}
    if reset <= now:
        return {"state": "invalid", "headroom": headroom,
                "reason": "%s window already reset at %r" % (kind, reset_raw)}
    elapsed = 1.0 - (reset - now).total_seconds() / window_len_s
    if elapsed < 0:
        return {"state": "invalid", "headroom": headroom,
                "reason": "%s reset %r beyond one window out" % (kind, reset_raw)}
    if elapsed < EARLY_WINDOW_ELAPSED:
        return {"state": "early", "headroom": headroom,
                "elapsed": elapsed, "resetInS": int((reset - now).total_seconds()),
                "reason": "only %.1f%% elapsed, ratio withheld" % (elapsed * 100)}
    ratio = util / elapsed if elapsed > 0 else None
    return {"state": "known", "headroom": headroom, "ratio": ratio,
            "elapsed": elapsed,
            "resetInS": int((reset - now).total_seconds())}


def classify_lane(row, now):
    """One lane snapshot row -> verdict with worst-window pace + admission."""
    if not isinstance(row, dict):
        raise PacerError("lane row is not an object: %r" % (row,))
    lane = row.get("lane")
    if not isinstance(lane, str) or not lane.strip():
        raise PacerError("lane row has no lane name: %r" % (row,))
    lane = lane.strip()
    quality = row.get("observationQuality", "live")
    live = (quality == "live")
    weekly = classify_window(row.get("weeklyUtilization"),
                             row.get("weeklyResetUtc"), WEEKLY_LEN_S,
                             now, lane, "weekly")
    fh = classify_window(row.get("fiveHourUtilization"),
                         row.get("fiveHourResetUtc"), FIVE_HOUR_LEN_S,
                         now, lane, "five-hour")
    if not live:
        for w in (weekly, fh):
            if w["state"] in ("known", "early"):
                w["state"] = "stale"
                w["reason"] = "observationQuality %r is not live" % (quality,)
    windows = {"weekly": weekly, "five_hour": fh}
    # Pace: worst known ratio across governing windows that HAVE data.
    # A window key absent from the row (None util AND None reset, e.g. a
    # weekly-only Codex lane's five-hour side) does not govern and is not
    # "unknown" — it simply does not vote. Only a half-present window
    # (one side given, the other missing) is unknown.
    ratios = []
    unknowns = []
    for key, w in windows.items():
        util_key = "weeklyUtilization" if key == "weekly" else "fiveHourUtilization"
        reset_key = "weeklyResetUtc" if key == "weekly" else "fiveHourResetUtc"
        present = row.get(util_key) is not None or row.get(reset_key) is not None
        if not present:
            continue
        if w["state"] == "known":
            ratios.append(w["ratio"])
        elif w["state"] != "early":
            unknowns.append("%s:%s" % (key, w.get("reason", w["state"])))
    pace = (max(ratios) if ratios else None)
    # 5h headroom governing value: worst known/early headroom, else None.
    fh_heads = [w["headroom"] for w in (fh,)
                if w.get("headroom") is not None
                and w["state"] in ("known", "early")
                and row.get("fiveHourUtilization") is not None]
    fh_head = min(fh_heads) if fh_heads else None
    # Admission advisory (shadow): hold when any governing window is thin,
    # unknown, stale or invalid; admit only on all-known with margin.
    hold_reasons = list(unknowns)
    # A thin window holds until THAT window rolls: weekly days out, five-hour
    # hours out. Several thin windows hold until the last of them rolls.
    thin_resets = []
    weekly_head = weekly.get("headroom")
    if row.get("weeklyUtilization") is not None and weekly_head is not None \
            and weekly["state"] == "known" and weekly_head < ADMIT_WEEKLY_FLOOR:
        hold_reasons.append("weekly headroom %.2f under %.2f"
                           % (weekly_head, ADMIT_WEEKLY_FLOOR))
        thin_resets.append(weekly["resetInS"])
    if row.get("fiveHourUtilization") is not None and fh_head is not None \
            and fh["state"] in ("known", "early") \
            and fh_head < FIVE_HOUR_DOWN_HEADROOM:
        hold_reasons.append("five-hour headroom %.2f under %.2f"
                           % (fh_head, FIVE_HOUR_DOWN_HEADROOM))
        thin_resets.append(fh["resetInS"])
    if hold_reasons:
        if thin_resets:
            retry_after = max(thin_resets)
        else:
            # Unknown/stale/invalid only: no window to wait for, so re-ask at
            # the soonest reset seen, else after a short default.
            resets = [w["resetInS"] for w in windows.values()
                      if isinstance(w.get("resetInS"), int)]
            retry_after = min(resets) if resets else 300
        admission = {"verdict": "hold", "reasons": hold_reasons,
                     "retryAfterS": retry_after}
    else:
        admission = {"verdict": "admit", "reasons": ["headroom within margin"],
                     "retryAfterS": 0}
    return {"lane": lane, "quality": quality, "windows": windows,
            "paceRatio": pace, "unknowns": unknowns,
            "fiveHourHeadroom": fh_head, "admission": admission}


def decide_agent(agent, lane_by_id, now, caps, state, frozen, cooldown_min,
                 mode):
    """One roster agent -> target decision. Pure; writes nothing."""
    aid = agent.get("id") or agent.get("name") or "?"
    name = agent.get("name") or aid
    status = agent.get("status")
    if status not in VALID_STATUSES:
        return {"agentId": aid, "name": name, "action": "skip",
                "reason": "status %r consumes no quota" % (status,),
                "target": agent.get("maxConcurrentRuns"), "effect": "none",
                "critical": bool(agent.get("critical"))}
    lanes = agent.get("lanes")
    if not isinstance(lanes, list) or not lanes:
        return {"agentId": aid, "name": name, "action": "nochange",
                "reason": "no lane mapping: refusing to scale blind",
                "target": agent.get("maxConcurrentRuns"), "measured": False,
                "effect": "none",
                "critical": bool(agent.get("critical"))}
    if any(isinstance(l, str) and l in frozen for l in lanes):
        return {"agentId": aid, "name": name, "action": "nochange",
                "reason": "frozen lane kill switch",
                "target": agent.get("maxConcurrentRuns"), "measured": True,
                "effect": "none",
                "critical": bool(agent.get("critical"))}
    missing = [l for l in lanes if l not in lane_by_id]
    if missing:
        return {"agentId": aid, "name": name, "action": "nochange",
                "reason": "lane(s) %s absent from snapshot" % ",".join(missing),
                "target": agent.get("maxConcurrentRuns"), "measured": False,
                "effect": "none",
                "critical": bool(agent.get("critical"))}
    verdicts = [lane_by_id[l] for l in lanes]
    if any(v["unknowns"] for v in verdicts):
        why = "; ".join(sorted({u for v in verdicts for u in v["unknowns"]}))
        return {"agentId": aid, "name": name, "action": "nochange",
                "reason": "unmeasured lane window(s): %s" % why,
                "target": agent.get("maxConcurrentRuns"), "measured": False,
                "effect": "none",
                "critical": bool(agent.get("critical"))}
    ratios = [v["paceRatio"] for v in verdicts if v["paceRatio"] is not None]
    if not ratios:
        return {"agentId": aid, "name": name, "action": "nochange",
                "reason": "no paced window yet (early/reset edge)",
                "target": agent.get("maxConcurrentRuns"), "measured": True,
                "effect": "none",
                "critical": bool(agent.get("critical"))}
    ratio = max(ratios)
    fh_heads = [v["fiveHourHeadroom"] for v in verdicts
                if v["fiveHourHeadroom"] is not None]
    fh_head = min(fh_heads) if fh_heads else None
    cur = agent.get("maxConcurrentRuns")
    if not isinstance(cur, int) or isinstance(cur, bool) or cur < 1:
        raise PacerError("agent %s: maxConcurrentRuns %r is not a positive int"
                         % (name, cur))
    baseline = agent.get("baseline")
    if baseline is not None and (
            not isinstance(baseline, int) or isinstance(baseline, bool)
            or baseline < 1):
        raise PacerError("agent %s: baseline %r is not a positive int"
                         % (name, baseline))
    cap = caps.get(name, caps.get(aid))
    if cap is not None:
        if not isinstance(cap, int) or isinstance(cap, bool) or cap < 1 \
                or cap > MAX_SANE_CAP:
            raise PacerError("cap for %s %r not an int in [1, %d]"
                             % (name, cap, MAX_SANE_CAP))
        ceiling = cap
    else:
        ceiling = baseline if baseline is not None else cur
    want = cur
    why = "ratio %.2f inside hysteresis [%.2f, %.2f]" % (ratio, UP_RATIO, DOWN_RATIO)
    if ratio <= UP_RATIO and (fh_head is None or fh_head >= FIVE_HOUR_UP_HEADROOM):
        head_txt = ("%.2f" % fh_head) if fh_head is not None else "n/a"
        if cur > ceiling:
            # Above the ceiling there is no room to scale up. Walk back toward
            # it one step at a time instead of jumping (the +-1 rule).
            want = cur - 1
            why = ("ratio %.2f behind pace with 5h headroom %s, but %d is "
                   "above ceiling %d: step down toward the ceiling"
                   % (ratio, head_txt, cur, ceiling))
        else:
            want = min(cur + 1, ceiling)
            why = ("ratio %.2f behind pace with 5h headroom %s: scale up"
                   % (ratio, head_txt))
            if want == cur:
                why += " (already at ceiling %d)" % ceiling
    elif ratio >= DOWN_RATIO or (fh_head is not None
                                 and fh_head < FIVE_HOUR_DOWN_HEADROOM):
        want = max(cur - 1, 1)
        why = ("ratio %.2f ahead of pace or 5h headroom %s thin: scale down"
               % (ratio, ("%.2f" % fh_head) if fh_head is not None else "n/a"))
        if want == cur:
            why += " (already at floor 1)"
    action = "nochange" if want == cur else ("up" if want > cur else "down")
    # Dwell: hold a move that revisits the decision inside the cooldown.
    if action != "nochange" and aid in state:
        prev = state[aid]
        try:
            prev_at = parse_ts(prev.get("decidedAt"))
        except Exception:
            prev_at = None
        if prev_at is not None and (now - prev_at).total_seconds() < cooldown_min * 60 \
                and prev.get("target") != want:
            return {"agentId": aid, "name": name, "action": "nochange",
                    "reason": "cooldown-hold: last target %r at %s inside %dm"
                              % (prev.get("target"), prev.get("decidedAt"),
                                 cooldown_min),
                    "target": prev.get("target", cur), "measured": True,
                    "effect": "none",
                    "critical": bool(agent.get("critical")),
                    "paceRatio": round(ratio, 4)}
    rec = {"agentId": aid, "name": name, "action": action, "reason": why,
           "target": want, "from": cur, "measured": True,
           "critical": bool(agent.get("critical")),
           "paceRatio": round(ratio, 4)}
    if action != "nochange":
        # Persisted by the applier into --state so the cooldown can see it.
        rec["decidedAt"] = fmt_ts(now)
    if fh_head is not None:
        rec["fiveHourHeadroom"] = round(fh_head, 4)
    if mode == "enforce" and action != "nochange":
        # Intent, not a byte-exact body: the applier MUST read the agent's
        # full runtimeConfig and write it back whole (quota_brake.sh rule 1:
        # PATCH replaces runtimeConfig wholesale). This intent carries only
        # the two keys that change.
        rec["effect"] = "directive"
        rec["patchIntent"] = {"runtimeConfig": {"heartbeat": {
            "maxConcurrentRuns": want}}}
    else:
        rec["effect"] = "none"
    return rec


def build_plan(lanes_doc, agents_doc, now, caps, state, frozen, cooldown_min,
               mode):
    if not isinstance(lanes_doc, dict) or not isinstance(lanes_doc.get("lanes"), list):
        raise PacerError("lanes doc has no lanes array")
    if not isinstance(agents_doc, dict) or not isinstance(agents_doc.get("agents"), list):
        raise PacerError("agents doc has no agents array")
    lane_rows = lanes_doc["lanes"]
    if not lane_rows:
        raise PacerError("lanes array is empty: nothing measured")
    verdicts = [classify_lane(r, now) for r in lane_rows]
    seen = set()
    for v in verdicts:
        if v["lane"] in seen:
            raise PacerError("duplicate lane row: %s" % v["lane"])
        seen.add(v["lane"])
    for f in frozen:
        if f not in seen:
            raise PacerError("frozen lane %r names no lane in the snapshot" % f)
    lane_by_id = {v["lane"]: v for v in verdicts}
    decisions = [decide_agent(a, lane_by_id, now, caps, state, frozen,
                              cooldown_min, mode)
                 for a in agents_doc["agents"]]
    measured = [d for d in decisions if d.get("measured")]
    if not measured:
        raise PacerError("no agent had measurable lane data")
    moves = [d for d in decisions if d["action"] in ("up", "down")]
    return {"mode": mode, "now": fmt_ts(now),
            "effect": "none" if mode == "shadow" else "directive",
            "lanes": [{"lane": v["lane"], "paceRatio": v["paceRatio"],
                       "admission": v["admission"],
                       "unknowns": v["unknowns"]} for v in verdicts],
            "agents": decisions,
            "summary": {"agents": len(decisions), "measured": len(measured),
                        "up": len([d for d in moves if d["action"] == "up"]),
                        "down": len([d for d in moves if d["action"] == "down"])}}


def build_rollback(agents_doc, mode):
    if mode != "enforce":
        raise PacerError("rollback is an enforce-mode act: pass --mode enforce --yes")
    out = []
    for a in (agents_doc.get("agents") or []):
        baseline = a.get("baseline")
        cur = a.get("maxConcurrentRuns")
        if not isinstance(baseline, int) or isinstance(baseline, bool):
            continue
        out.append({"agentId": a.get("id") or a.get("name"),
                    "name": a.get("name"),
                    "action": "restore" if cur != baseline else "nochange",
                    "target": baseline, "from": cur,
                    "effect": "directive",
                    "patchIntent": {"runtimeConfig": {"heartbeat": {
                        "maxConcurrentRuns": baseline}}},
                    "reason": "rollback to recorded baseline"})
    return {"mode": "rollback", "effect": "directive", "agents": out,
            "summary": {"restores": len([r for r in out
                                         if r["action"] == "restore"]) }}


def agreement_report(audit_path, events_doc, lookback_min):
    """Shadow agreement: for each 429/exhaustion event, was the lane already
    held (deny) inside the lookback? Reads pacer_admission_audit.py JSONL."""
    try:
        with open(audit_path, "r", encoding="utf-8") as fh:
            blob = fh.read()
    except OSError as exc:
        raise PacerError("cannot read audit log: %s" % exc)
    denies = []
    for ln in blob.splitlines():
        ln = ln.strip()
        if not ln:
            continue
        try:
            r = json.loads(ln)
        except json.JSONDecodeError:
            continue
        if isinstance(r, dict) and r.get("v") == 1 and r.get("decision") == "deny":
            ts = parse_ts(r.get("ts"))
            if ts is not None and r.get("lane"):
                denies.append((ts, r["lane"]))
    if not isinstance(events_doc, dict) or not isinstance(events_doc.get("events"), list):
        raise PacerError("events doc has no events array")
    events = events_doc["events"]
    covered, uncovered = [], []
    for e in events:
        ets = parse_ts(e.get("ts"))
        lane = e.get("lane")
        if ets is None or not lane:
            raise PacerError("event has bad ts/lane: %r" % (e,))
        hit = any(dlane == lane and 0 <= (ets - dts).total_seconds() <= lookback_min * 60
                  for dts, dlane in denies)
        (covered if hit else uncovered).append(e)
    noisy = [ {"ts": fmt_ts(dts), "lane": dlane} for dts, dlane in denies
              if not any(e.get("lane") == dlane and 0 <= (parse_ts(e["ts"]) - dts).total_seconds() <= lookback_min * 60
                         for e in events if parse_ts(e.get("ts")) is not None)]
    return {"events": len(events), "covered": len(covered),
            "uncovered": len(uncovered),
            "coverage": (len(covered) / len(events) if events else None),
            "uncoveredEvents": uncovered,
            "deniesWithoutEvent": len(noisy),
            "lookbackMin": lookback_min}


def load_json(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def main(argv=None):
    p = argparse.ArgumentParser(
        description="Per-agent concurrency target reconciler. "
                    "Shadow by default; emits board PATCH intents, never writes.")
    p.add_argument("--lanes", help="lane snapshot JSON fixture")
    p.add_argument("--agents", help="agent roster JSON fixture")
    p.add_argument("--caps", default=None, help="operator overload caps JSON")
    p.add_argument("--state", default=None, help="last-decision state JSON")
    p.add_argument("--now", default=None)
    p.add_argument("--mode", choices=("shadow", "enforce"), default="shadow")
    p.add_argument("--yes", action="store_true",
                   help="required for enforce directives to be emitted")
    p.add_argument("--rollback", action="store_true",
                   help="emit restore-to-baseline intents (needs --mode enforce --yes)")
    p.add_argument("--frozen-lanes", default="",
                   help="comma-separated per-lane kill switch")
    p.add_argument("--cooldown-min", type=int, default=30)
    p.add_argument("--max-age-note", default=None, help=argparse.SUPPRESS)
    p.add_argument("--audit", default=None,
                   help="pacer audit JSONL for the agreement report")
    p.add_argument("--events", default=None,
                   help="429/exhaustion events JSON (with --audit)")
    p.add_argument("--lookback-min", type=int, default=30)
    p.add_argument("--out", default=None, help="write plan JSON here")
    a = p.parse_args(argv)

    if a.cooldown_min is None or a.cooldown_min < 0:
        print("pacer_concurrency: --cooldown-min refuses negatives",
              file=sys.stderr)
        return 2
    now = parse_ts(a.now) if a.now is not None else \
        datetime.datetime.now(UTC).replace(microsecond=0)
    if now is None:
        print("pacer_concurrency: --now must be UTC YYYY-MM-DDTHH:MM:SSZ",
              file=sys.stderr)
        return 2
    frozen = [s for s in (x.strip() for x in a.frozen_lanes.split(",")) if s]

    try:
        if a.audit is not None or a.events is not None:
            if a.audit is None or a.events is None:
                raise PacerError("--audit and --events go together")
            report = agreement_report(a.audit, load_json(a.events), a.lookback_min)
            text = json.dumps(report, indent=2, sort_keys=True)
        else:
            if not a.lanes or not a.agents:
                raise PacerError("--lanes and --agents are required (or --audit/--events)")
            lanes_doc = load_json(a.lanes)
            agents_doc = load_json(a.agents)
            caps_doc = load_json(a.caps) if a.caps else {}
            caps = caps_doc.get("caps", {}) if isinstance(caps_doc, dict) else {}
            if not isinstance(caps, dict):
                raise PacerError("caps doc: 'caps' is not an object")
            state_doc = load_json(a.state) if a.state else {}
            state = state_doc.get("agents", state_doc) if isinstance(state_doc, dict) else {}
            if not isinstance(state, dict):
                raise PacerError("state doc is not an object")
            if a.rollback:
                if a.mode != "enforce" or not a.yes:
                    raise PacerError("rollback needs --mode enforce --yes")
                plan = build_rollback(agents_doc, a.mode)
            else:
                if a.mode == "enforce" and not a.yes:
                    raise PacerError("enforce mode needs --yes: directives must be asked for out loud")
                plan = build_plan(lanes_doc, agents_doc, now, caps, state,
                                  frozen, a.cooldown_min, a.mode)
            text = json.dumps(plan, indent=2, sort_keys=True)
    except PacerError as exc:
        print("pacer_concurrency: refused: %s" % exc, file=sys.stderr)
        # Unmeasured world vs bad input share the refusal; exit 5 only when
        # the complaint is that nothing could be measured.
        msg = str(exc)
        if "nothing measured" in msg or "no agent had measurable" in msg \
                or "lanes array is empty" in msg:
            return 5
        return 2
    except (OSError, json.JSONDecodeError) as exc:
        print("pacer_concurrency: cannot read input: %s" % exc, file=sys.stderr)
        return 2

    if a.out:
        try:
            tmp = "%s.tmp-%d" % (a.out, os.getpid())
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write(text + "\n")
            os.replace(tmp, a.out)
        except OSError as exc:
            print("pacer_concurrency: cannot write --out: %s" % exc, file=sys.stderr)
            return 2
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
