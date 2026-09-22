#!/usr/bin/env python3
# ===========================================================================
# tog3846_acceptance.py — TOG-3846 post-deploy acceptance measurement
# ---------------------------------------------------------------------------
# Quantitative seven-day acceptance for TOG-3585 (deployed 2026-09-22 03:25Z).
# Window: 2026-09-22T03:25:00Z through 2026-09-29T03:25:00Z.
#
# Uses ONLY agent-authorized read paths (all verified 200 this run; every
# plugin-runtime path returns 403 "Board access required" for this agent):
#   A. GET /companies/{id}/activity          — plugin-authored Dispatch sweep
#      summaries (per-firing counters, wakeFailureDetails with code+message,
#      idleAssigneePickedIssueIds, laneDownSkippedIssueIds), wake requests
#      (issue.assignment_wakeup_requested), repin/balance/label writes.
#   B. GET /companies/{id}/heartbeat-runs    — sweep-woken runs, joined on
#      contextSnapshot.wakeReason == "dispatch_stalled_issue".
#   C. GET /heartbeat-runs/{id}/issues +
#      GET /issues/{iid}/comments             — comment-only determination via
#      comment.createdByRunId (join is WIRED: fetch_all calls fetch_join;
#      partial-join failures are reported as missing with coverage, never as
#      empty evidence).
#   D. GET /companies/{id}/issues?q=         — tier-exhausted operator cards
#      (persistent; full-window coverage). Cards are a PROXY for
#      exhausted-lane wakes, never the wakes themselves.
#   E. GET /companies/{id}/dashboard         — daily runActivity (context only).
#
# PROXY / ACTUAL SEPARATION (TOG-3856): anything that can be measured from
# currently authorized telemetry WITHOUT an independent evidence population
# is reported under an explicitly named `*_proxy` metric and NEVER decides a
# pass/fail or kill-rule outcome. The acceptance metric it stands in for
# reports status "missing" (with numerator/denominator or explicit unknown)
# unless the caller supplies the authorized evidence population.
#   - wake-request createdAt -> run startedAt is a PROXY for the acceptance
#     metric eligible idle-assignee -> wake. The actual metric is missing
#     unless eligibility_by_issue (issue -> eligible-since timestamp from an
#     authorized population) is supplied.
#   - succeeded-run-with-comment is a CANDIDATE for comment-only, never a
#     confirmed event, unless state-change exclusion ran against complete
#     activity coverage. Only confirmed events feed the >15/day kill rule;
#     candidates can neither trigger it nor prove a non-breach.
#   - tier-exhausted operator cards are a PROXY for exhausted-lane wakes.
#     Card presence alone is not a breach; empty search is not a verified
#     zero wakes. The actual wake count is missing unless independently
#     evidenced (exhausted_wake_evidence).
#
# HARD CONSTRAINTS (measured 2026-09-22, encoded in coverage reporting):
#   - activity ignores every cursor param (offset/before/after/since/until/
#     page/order — all measured 2026-09-22: identical newest-500 returned) and
#     caps at the newest 500 rows (~52min at current ~10 rows/min volume).
#     A retrospective seven-day pull is impossible; the method therefore
#     snapshots (see --snapshot-out) and reports the actually-covered span
#     per source. Missing data is status "missing", never zero.
#   - heartbeat-runs ignores cursor params the same way and caps at the newest
#     1000 rows (~34hr measured 2026-09-20 17:52Z → 2026-09-22 04:13Z).
#   - Dispatch sweep activity rows are change-gated (hasStateChanged): an
#     unchanged firing writes NO row. Absence of a row is NOT absence of a
#     firing — reported as coverage, not as zero.
#   - NO pass durations (repin/balance/labelOnly/dispatch-sweep seconds) and
#     NO RPC-timeout counts exist on any authorized path. Those three metrics
#     report "missing" with the escalation pointer (CTO child of TOG-3846).
#     Proxy reported alongside: wakeFailureDetails entries coded "timeout"
#     (wake-transport timeouts — a different thing, labelled as such).
#   - Capped snapshots can never support an overall seven-day pass:
#     report["overall"]["seven_day_pass"] is always False from this method.
#     The observation window end never drifts past WINDOW_END
#     (2026-09-29T03:25:00Z); requested/default ends are capped.
#   - Primary source envelopes are validated and fail loudly: a malformed
#     activity/runs/issues payload raises ValueError, it is never coerced to
#     an empty list (an empty list would read as measured zero).
#
# Credential-free testable: every computation is a pure function over plain
# dicts; only fetch_* / main touch the network. Unit tests import the pure
# functions and never need PAPERCLIP_API_KEY. See test_tog3846_acceptance.py.
# ===========================================================================
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import urllib.request
from collections import defaultdict

PLUGIN_ID = "191a4e31-e618-4e76-921a-7511bcc1c12f"
WINDOW_START = "2026-09-22T03:25:00Z"
WINDOW_END = "2026-09-29T03:25:00Z"
SWEEP_WAKE_REASON = "dispatch_stalled_issue"
SWEEP_ACTION_PREFIX = "Dispatch sweep"
KILL_RULE_PER_DAY = 15
RPC_WALL_S = 300
ELIGIBILITY_BREACH_S = 30 * 60

MISSING_SWEEP_P50 = (
    "no pass durations on any authorized path: activity rows carry counters "
    "but no durationMs; /plugins/{id}/jobs, /logs, /health, /dashboard, "
    "/config and /data/{key} all return 403 Board access required. "
    "Escalated as narrow telemetry need on CTO child of TOG-3846."
)
MISSING_RPC_TIMEOUTS = (
    "RPC timeout counts live in plugin logs (403 for this agent). "
    "Proxy reported: wakeFailureDetails coded 'timeout' (wake-transport, "
    "not pass RPC)."
)
MISSING_BALANCE = (
    "balancePass durations live in plugin logs (403 for this agent). "
    "Only operator-verified sample exists: 255s vs 300s wall on the first "
    "post-deploy firing (TOG-3639)."
)

ACTIVITY_LIMITS = (
    "activity: newest-500 rows (~52min at current ~10 rows/min volume); "
    "cursor params ignored; change-gated rows (absence of a row is NOT "
    "absence of a firing)"
)
RUNS_LIMITS = (
    "heartbeat-runs: newest-1000 rows (~34hr measured 2026-09-20 17:52Z to "
    "2026-09-22 04:13Z); cursor params ignored"
)
ISSUES_COVERAGE_NOTE = (
    "issues search: persistent rows, full-window coverage (no retention cap)"
)
OVERALL_NOTE = (
    "capped snapshots (activity newest-500, heartbeat-runs newest-1000, "
    "change-gated sweep rows) cannot support an overall seven-day pass; "
    "seven_day_pass is always False from this method. Final seven-day "
    "report owned by parent; final review date 2026-09-29."
)
JOIN_WIRED_NOTE = (
    "comment/touched join is wired: fetch_all calls fetch_join. "
    "Partial-join failures are reported as missing with coverage, never "
    "as empty evidence."
)
PROXY_LATENCY_NOTE = (
    "PROXY ONLY: wake-request createdAt to run startedAt. This is NOT the "
    "acceptance metric (eligible idle-assignee to wake). A small proxy "
    "latency with a late wake is a false pass unless the eligibility "
    "timestamp proves otherwise. Never decides pass/fail."
)
ACTUAL_LATENCY_MISSING_NOTE = (
    "actual acceptance metric (eligible idle-assignee to wake) is missing: "
    "no authorized eligibility timestamp/population supplied. "
    "See eligibility_by_issue."
)
CANDIDATE_NOTE = (
    "comment_only_candidate = succeeded run with run-attributed comments "
    "but WITHOUT verified state-change exclusion. Candidates can NEITHER "
    "trigger the >15/day kill rule NOR prove a non-breach. Only "
    "comment_only_confirmed events (complete coverage + no state-change "
    "co-occurrence) feed the kill rule."
)
EXHAUSTED_PROXY_NOTE = (
    "tier-exhausted operator cards are a PROXY, not exhausted-lane wakes. "
    "Card presence alone is not a breach; empty search is not a verified "
    "zero wakes. Actual wake count is missing unless independently "
    "evidenced (exhausted_wake_evidence)."
)

STATE_CHANGE_ACTIONS = frozenset({
    "issue.updated",
    "issue.status_updated",
    "issue.status_changed",
    "issue.state_changed",
})

ENVELOPE_LIST_KEYS = ("data", "items", "issues", "activity", "runs", "results")


# --- time helpers -----------------------------------------------------------
def parse_iso(s):
    if not s:
        return None
    try:
        v = s.replace("Z", "+00:00")
        d = dt.datetime.fromisoformat(v)
        if d.tzinfo is None:
            d = d.replace(tzinfo=dt.timezone.utc)
        return d
    except (ValueError, TypeError):
        return None


def in_window(ts, start, end):
    d = parse_iso(ts)
    return d is not None and parse_iso(start) <= d < parse_iso(end)


def percentile(sorted_vals, q):
    """Nearest-rank percentile over an already-sorted list; None when empty."""
    if not sorted_vals:
        return None
    import math

    rank = max(1, int(math.ceil(q / 100.0 * len(sorted_vals))))
    return sorted_vals[rank - 1]


def span_of(ts_list):
    """Observed span over parseable timestamps; explicit Nones when empty."""
    pts = [(parse_iso(t), t) for t in (ts_list or []) if t]
    pts = [(d, t) for d, t in pts if d is not None]
    if not pts:
        return {"start": None, "end": None}
    lo = min(pts, key=lambda p: p[0])[1]
    hi = max(pts, key=lambda p: p[0])[1]
    return {"start": lo, "end": hi}


def normalize_api_base(url):
    """Normalize PAPERCLIP_API_URL whether or not it already ends in /api."""
    b = (url or "").strip().rstrip("/")
    if not b:
        return ""
    if b.lower().endswith("/api"):
        return b
    return b + "/api"


def cap_window_end(requested=None, now_iso=None):
    """Cap the observation end so it never drifts beyond WINDOW_END."""
    cap = parse_iso(WINDOW_END)
    if requested:
        d = parse_iso(requested)
        if d is None:
            return WINDOW_END
        return requested if d <= cap else WINDOW_END
    now = parse_iso(now_iso) if now_iso else dt.datetime.now(dt.timezone.utc)
    if now is None:
        return WINDOW_END
    if now <= cap:
        return now.strftime("%Y-%m-%dT%H:%M:%SZ")
    return WINDOW_END


# --- source A: activity -----------------------------------------------------
def is_sweep_row(a):
    return (
        (a.get("action") or "").startswith(SWEEP_ACTION_PREFIX)
        and a.get("actorId") == PLUGIN_ID
    )


def sweep_rows(activity):
    return [a for a in activity if is_sweep_row(a)]


def wake_requests(activity):
    return [
        a
        for a in activity
        if a.get("action") == "issue.assignment_wakeup_requested"
        and a.get("actorId") == PLUGIN_ID
    ]


def wake_error_coverage(sweeps):
    """Coded-failure coverage over sweep rows.

    Returns numerator/denominator/ratio plus the sweep population the ratio
    was computed over. Absent wakeFailureDetails (key missing) or malformed
    (non-list) details count the sweep as NOT covered: absent/truncated
    failure details are never equated with complete coverage. 0/0 carries
    ratio None, never 100%.
    """
    total = 0
    coded = 0
    with_details = 0
    for s in sweeps:
        det = (s.get("details") or {}).get("wakeFailureDetails")
        if det is None or not isinstance(det, list):
            continue
        with_details += 1
        for f in det:
            if not isinstance(f, dict):
                total += 1
                continue
            total += 1
            if f.get("code") and f.get("message"):
                coded += 1
    ratio = (coded / total) if total else None
    return {
        "numerator": coded,
        "denominator": total,
        "ratio": ratio,
        "sweeps_observed": len(sweeps),
        "sweeps_with_details": with_details,
    }


def lane_down_skips(sweeps):
    n = 0
    for s in sweeps:
        det = (s.get("details") or {}).get("laneDownSkippedIssueIds") or []
        n += len(det)
    return n


def idle_assignee_picks(sweeps):
    ids = set()
    for s in sweeps:
        for i in (s.get("details") or {}).get("idleAssigneePickedIssueIds") or []:
            ids.add(i)
    return ids


def state_changed_issues(activity, window_start, window_end):
    """Issue ids with state-change activity rows in the window (heuristic).

    Activity issue.updated-style rows carry no run id, so exclusion of a
    run is time-boxed co-occurrence on a touched issue, reported as such.
    """
    ids = set()
    for a in activity or []:
        if not isinstance(a, dict):
            continue
        if a.get("action") not in STATE_CHANGE_ACTIONS:
            continue
        if not in_window(a.get("createdAt"), window_start, window_end):
            continue
        det = a.get("details") or {}
        iid = (det.get("issueId") or det.get("issue_id")
               or a.get("issueId") or a.get("issue_id"))
        if iid:
            ids.add(iid)
    return ids


# --- source B/C: heartbeat-runs + comments ----------------------------------
def sweep_woken_runs(runs):
    return [
        r
        for r in runs
        if (r.get("contextSnapshot") or {}).get("wakeReason") == SWEEP_WAKE_REASON
    ]


def wake_latency_seconds(wake_req, run_by_id):
    """PROXY (not acceptance): wake-request createdAt -> run startedAt.

    (latency_s | None, kind, reason). kind is one of
    ok | never_queued | missing | bad_clock | clock_skew.
    """
    run_id = (wake_req.get("details") or {}).get("runId")
    if not run_id:
        return None, "never_queued", "no runId on wake request (wake never queued)"
    run = run_by_id.get(run_id)
    if run is None:
        return None, "missing", "run id not in fetched heartbeat-runs span (missing data)"
    t0 = parse_iso(wake_req.get("createdAt"))
    t1 = parse_iso(run.get("startedAt"))
    if t0 is None or t1 is None:
        return None, "bad_clock", "unparseable timestamp"
    s = (t1 - t0).total_seconds()
    if s < 0:
        # Write-lag artifact: the run row commits before its wake-request
        # activity row. Negative latency is impossible; report separately.
        return None, "clock_skew", "run.startedAt precedes wake createdAt (write lag)"
    return s, "ok", "ok"


def eligible_idle_to_wake_seconds(eligible_since_ts, wake_created_ts):
    """ACTUAL acceptance latency: eligible-since -> wake-request createdAt.

    (seconds | None, kind, reason). kind is one of ok | bad_clock |
    clock_skew. Requires an authorized eligibility timestamp/population;
    without it the acceptance metric is missing (never the proxy value).
    """
    t0 = parse_iso(eligible_since_ts)
    t1 = parse_iso(wake_created_ts)
    if t0 is None or t1 is None:
        return None, "bad_clock", "unparseable eligibility or wake timestamp"
    s = (t1 - t0).total_seconds()
    if s < 0:
        return None, "clock_skew", "wake createdAt precedes eligibility timestamp"
    return s, "ok", "ok"


def classify_run(run, comments_by_issue, touched_issues,
                 state_changed_issue_ids=None, coverage_complete=False):
    """One of comment_only_confirmed | comment_only_candidate | active |
    failed | unknown.

    comment_only_confirmed: run succeeded AND posted >=1 comment
    (createdByRunId) on a touched issue AND activity coverage is complete
    AND no touched issue shows a state-change row in the window.
    comment_only_candidate: succeeded with run-attributed comments but
    state-change exclusion is unverified (coverage incomplete or no
    state-change evidence supplied). Candidates NEVER feed the kill rule.
    active: succeeded run whose touched issue co-occurs with a state change
    (productive work — excluded from comment-only).
    unknown: no run-attributed comments on touched issues (missing join or
    silent run).
    """
    if run.get("status") not in ("succeeded",):
        if run.get("status") in ("failed", "cancelled"):
            return "failed", "run did not succeed"
        return "unknown", "run status %s" % (run.get("status"),)
    own_comments = 0
    for iid in touched_issues or []:
        for c in (comments_by_issue or {}).get(iid, []):
            if isinstance(c, dict) and c.get("createdByRunId") == run.get("id"):
                own_comments += 1
    if own_comments == 0:
        return "unknown", "no run-attributed comments on touched issues"
    if not coverage_complete:
        return ("comment_only_candidate",
                "run-attributed comments=%d; state-change exclusion "
                "unverified (activity coverage incomplete)" % own_comments)
    changed = set(touched_issues or []) & set(state_changed_issue_ids or set())
    if changed:
        return ("active",
                "state-change co-occurrence on %d touched issue(s); "
                "productive, excluded from comment-only" % len(changed))
    return ("comment_only_confirmed",
            "run-attributed comments=%d with complete coverage and no "
            "state-change co-occurrence" % own_comments)


def per_day_counts(items, ts_of):
    days = defaultdict(int)
    for it in items:
        d = parse_iso(ts_of(it))
        if d is not None:
            days[d.date().isoformat()] += 1
    return dict(sorted(days.items()))


def kill_breach(per_day, limit=KILL_RULE_PER_DAY):
    bad = {day: n for day, n in per_day.items() if n > limit}
    return (len(bad) > 0), bad


# --- report -----------------------------------------------------------------
def build_report(window_start, window_end, activity, runs, exhausted_cards,
                 comments_by_issue=None, touched_by_run=None,
                 eligibility_by_issue=None, exhausted_wake_evidence=None,
                 activity_coverage_complete=False, join_report=None):
    comments_by_issue = comments_by_issue or {}
    touched_by_run = touched_by_run or {}
    join_report = join_report or {}
    sweeps = [s for s in sweep_rows(activity)
              if in_window(s.get("createdAt"), window_start, window_end)]
    wakes = [w for w in wake_requests(activity)
             if in_window(w.get("createdAt"), window_start, window_end)]
    wruns = [r for r in sweep_woken_runs(runs)
             if in_window(r.get("startedAt"), window_start, window_end)]

    # --- wake error coverage: ratio/verdict follows numerator/denominator ---
    cov = wake_error_coverage(sweeps)
    if cov["denominator"] == 0:
        cov_status = "missing"
        cov_note = ("no coded-failure population in covered span "
                    "(%d/%d sweeps carry failure details; 0/0 carries no "
                    "ratio — missing, not zero)"
                    % (cov["sweeps_with_details"], cov["sweeps_observed"]))
    elif cov["sweeps_with_details"] < cov["sweeps_observed"]:
        cov_status = "missing"
        cov_note = ("failure details absent/truncated on %d of %d sweeps; "
                    "coverage incomplete, never a complete-coverage verdict"
                    % (cov["sweeps_observed"] - cov["sweeps_with_details"],
                       cov["sweeps_observed"]))
    elif cov["numerator"] < cov["denominator"]:
        cov_status = "incomplete"
        cov_note = ("%d of %d observed failures carry code+message "
                    "(ratio %.2f); uncoded failures remain"
                    % (cov["numerator"], cov["denominator"], cov["ratio"]))
    else:
        cov_status = "ok"
        cov_note = ("all observed failures carry code+message "
                    "(%d/%d over %d in-window sweeps)"
                    % (cov["numerator"], cov["denominator"],
                       cov["sweeps_observed"]))

    # --- proxy latency: wake-request -> run-start (never acceptance) ---
    run_by_id = {r.get("id"): r for r in runs}
    lat, unjoined, proxy_breaches = [], 0, 0
    join_kinds = {"never_queued": 0, "missing": 0, "bad_clock": 0,
                  "clock_skew": 0}
    idle_ids = idle_assignee_picks(sweeps)
    for w in wakes:
        s, kind, reason = wake_latency_seconds(w, run_by_id)
        if s is None:
            unjoined += 1
            join_kinds[kind] = join_kinds.get(kind, 0) + 1
        else:
            lat.append(s)
            if s > ELIGIBILITY_BREACH_S:
                proxy_breaches += 1
    # A wake sample with zero successful joins is missing data (clock skew,
    # unqueued wakes), never a measured zero-latency pass.
    proxy_status = "ok" if lat else "missing"

    # --- actual latency: eligible idle-assignee -> wake (missing by default) ---
    actual, actual_unknown, actual_breaches = [], 0, 0
    actual_kinds = {"no_eligibility": 0, "bad_clock": 0, "clock_skew": 0}
    if eligibility_by_issue is None:
        actual_unknown = len(wakes)
        actual_note = ACTUAL_LATENCY_MISSING_NOTE
    else:
        for w in wakes:
            det = w.get("details") or {}
            iid = det.get("issueId") or det.get("issue_id")
            elig = eligibility_by_issue.get(iid) if iid else None
            if not elig:
                actual_unknown += 1
                actual_kinds["no_eligibility"] += 1
                continue
            s, kind, _reason = eligible_idle_to_wake_seconds(
                elig, w.get("createdAt"))
            if s is None:
                actual_unknown += 1
                actual_kinds[kind] = actual_kinds.get(kind, 0) + 1
            else:
                actual.append(s)
                if s > ELIGIBILITY_BREACH_S:
                    actual_breaches += 1
        actual_note = None
    actual_status = "ok" if actual else "missing"

    # --- comment-only: only CONFIRMED events feed the kill rule ---
    changed_ids = state_changed_issues(activity, window_start, window_end)
    classes = {}
    confirmed = []
    candidates = []
    unknowns = 0
    for r in wruns:
        cls, why = classify_run(r, comments_by_issue,
                                touched_by_run.get(r.get("id"), []),
                                changed_ids, activity_coverage_complete)
        classes[r.get("id")] = {"class": cls, "why": why}
        if cls == "comment_only_confirmed":
            confirmed.append(r)
        elif cls == "comment_only_candidate":
            candidates.append(r)
        elif cls == "unknown":
            unknowns += 1
    per_day = per_day_counts(confirmed, lambda r: r.get("startedAt"))
    breached, bad_days = kill_breach(per_day)
    # Candidates can neither trigger the kill rule nor prove a non-breach;
    # anything less than complete coverage with zero unknowns is missing.
    if not wruns:
        comment_only_status = "missing"
        comment_only_note = ("no sweep-woken runs in covered span: missing, "
                             "not zero. " + CANDIDATE_NOTE)
    elif not activity_coverage_complete or unknowns > 0:
        comment_only_status = "missing"
        comment_only_note = (
            "observation incomplete (coverage_complete=%s, unknowns=%d of "
            "%d runs, candidates=%d): join is %s; %s"
            % (activity_coverage_complete, unknowns, len(wruns),
               len(candidates), JOIN_WIRED_NOTE, CANDIDATE_NOTE))
    else:
        comment_only_status = "ok"
        comment_only_note = ("complete coverage: %d confirmed, %d candidates, "
                             "%d productive(active), %d unknowns. %s"
                             % (len(confirmed), len(candidates),
                                sum(1 for v in classes.values()
                                    if v["class"] == "active"),
                                unknowns, CANDIDATE_NOTE))

    # --- exhausted lane: cards are a proxy; actual wakes missing by default ---
    if exhausted_wake_evidence is None:
        ex_status = "missing"
        ex_actual = None
        ex_breach = False
        ex_note = (EXHAUSTED_PROXY_NOTE + " lane_down_skips_refused=%d "
                   "(refused wakes = gate-held evidence, not a breach)."
                   % lane_down_skips(sweeps))
    else:
        ex_status = "ok"
        ex_actual = exhausted_wake_evidence
        ex_breach = exhausted_wake_evidence > 0
        ex_note = ("independently evidenced exhausted-lane wakes=%d; "
                   "card proxy count reported alongside, never the verdict."
                   % exhausted_wake_evidence)

    act_ts = [a.get("createdAt") for a in activity if a.get("createdAt")]
    run_ts = [r.get("startedAt") for r in runs if r.get("startedAt")]
    act_span = span_of(act_ts)
    run_span = span_of(run_ts)
    metrics = {
        "wake_error_coverage": {
            "status": cov_status,
            "numerator": cov["numerator"],
            "denominator": cov["denominator"],
            "ratio": cov["ratio"],
            "sweep_rows": len(sweeps),
            "sweeps_with_details": cov["sweeps_with_details"],
            "observed_span": act_span,
            "coverage_limits": ACTIVITY_LIMITS,
            "note": cov_note,
        },
        "wake_request_to_run_start_proxy": {
            "status": proxy_status,
            "is_proxy": True,
            "numerator": len(lat),
            "denominator": len(wakes),
            "n": len(lat),
            "unjoined": unjoined,
            "unjoined_kinds": join_kinds,
            "max_s": max(lat) if lat else None,
            "breaches_over_30min": proxy_breaches,
            "idle_assignee_picks_in_sweeps": len(idle_ids),
            "observed_span": act_span,
            "coverage_limits": ACTIVITY_LIMITS + "; " + RUNS_LIMITS,
            "note_proxy": PROXY_LATENCY_NOTE,
            "note_missing": ("no wake joined to a run start: clock_skew = "
                             "write-lag artifact, never_queued = wake never "
                             "queued; join is missing, not zero latency") if
            proxy_status == "missing" else None,
        },
        "idle_assignee_wake_latency": {
            "status": actual_status,
            "is_proxy": False,
            "numerator": len(actual),
            "denominator": len(wakes),
            "n_actual": len(actual),
            "unknown": actual_unknown,
            "unknown_kinds": actual_kinds,
            "max_s": max(actual) if actual else None,
            "breaches_over_30min": actual_breaches,
            "observed_span": act_span,
            "coverage_limits": ACTIVITY_LIMITS,
            "note_missing": actual_note if
            actual_status == "missing" else None,
        },
        "dispatch_sweep_p50": {"status": "missing", "reason": MISSING_SWEEP_P50,
                               "unknown": "no authorized duration population",
                               "observed_span": act_span,
                               "coverage_limits": ACTIVITY_LIMITS},
        "rpc_timeouts": {
            "status": "missing",
            "reason": MISSING_RPC_TIMEOUTS,
            "unknown": "no authorized RPC-timeout population",
            "observed_span": act_span,
            "coverage_limits": ACTIVITY_LIMITS,
            "proxy_wake_timeout_codes": sum(
                1 for s in sweeps
                for f in ((s.get("details") or {}).get("wakeFailureDetails") or [])
                if isinstance(f, dict) and f.get("code") == "timeout"),
        },
        "comment_only_runs_per_day": {
            "status": comment_only_status,
            "numerator": len(confirmed),
            "denominator": len(wruns),
            "confirmed": len(confirmed),
            "candidates": len(candidates),
            "unclassified_unknown": unknowns,
            "observed_span": run_span,
            "coverage_limits": RUNS_LIMITS + "; " + JOIN_WIRED_NOTE,
            "note": comment_only_note,
            "days": per_day,
            "kill_breach_over_15": breached,
            "breach_days": bad_days,
            "sweep_woken_runs": len(wruns),
            "classes": classes,
        },
        "exhausted_lane": {
            "status": ex_status,
            "cards_proxy_count": len(exhausted_cards),
            "tier_exhausted_cards_created_in_window": len(exhausted_cards),
            "actual_wake_count": ex_actual,
            "unknown": ("actual exhausted-lane wake count missing: no "
                        "independent wake evidence") if ex_actual is None
            else None,
            "lane_down_skips_refused": lane_down_skips(sweeps),
            "breach": ex_breach,
            "observed_span": span_of(
                [c.get("createdAt") or c.get("created_at")
                 for c in exhausted_cards]),
            "coverage_limits": ISSUES_COVERAGE_NOTE,
            "note": ex_note,
        },
        "balance_pass": {"status": "missing", "reason": MISSING_BALANCE,
                         "unknown": "no authorized balancePass population",
                         "observed_span": act_span,
                         "coverage_limits": ACTIVITY_LIMITS},
    }
    report = {
        "window": {"start": window_start, "end": window_end},
        "metrics": metrics,
        "coverage": {
            "activity": {
                "rows_fetched": len(activity),
                "oldest": act_span["start"],
                "newest": act_span["end"],
                "limits": ACTIVITY_LIMITS,
            },
            "heartbeat_runs": {
                "rows_fetched": len(runs),
                "oldest": run_span["start"],
                "newest": run_span["end"],
                "limits": RUNS_LIMITS,
            },
            "issues_search": "full (persistent rows, no retention cap)",
            "activity_coverage_complete": activity_coverage_complete,
            "join": dict(join_report) if join_report else {
                "note": "no join attempted in this build (pass join_report "
                        "from fetch_join for partial-failure coverage)"},
        },
        "kill_rule": {"breached": breached, "detail": bad_days,
                      "note": "confirmed comment-only events only; "
                              "candidates never feed the kill rule"},
        "overall": {"seven_day_pass": False, "status": "missing",
                    "note": OVERALL_NOTE},
    }
    return report


# --- network (thin wrappers; never imported by tests) -----------------------
def _get(base, key, path):
    req = urllib.request.Request(base + path,
                                 headers={"Authorization": "Bearer " + key})
    with urllib.request.urlopen(req, timeout=60) as fh:
        return json.load(fh)


def sanitize_fetch_error(exc):
    """One-line failure description with NO secrets (no URL, key, or body).

    Only the exception type name and HTTP status code are recorded — never
    the message, reason, URL, or response body, any of which may carry
    credentials or tokens.
    """
    code = getattr(exc, "code", None)
    if code is not None:
        return "HTTP %s (%s)" % (code, type(exc).__name__)
    return "%s (details withheld; no URL, key, or body recorded)" % (
        type(exc).__name__,)


def require_row_list(name, value):
    """Validate a primary-source envelope; raise loudly, never coerce to [].

    Accepts a bare list or an object wrapping one under a known key
    (data/items/issues/activity/runs/results). Anything else raises
    ValueError so malformed sources fail instead of reading as zero.
    """
    if isinstance(value, dict):
        for k in ENVELOPE_LIST_KEYS:
            v = value.get(k)
            if isinstance(v, list):
                value = v
                break
        else:
            raise ValueError(
                "invalid %s envelope: object without row list (keys=%s)"
                % (name, sorted([str(k) for k in value.keys()])[:8]))
    if not isinstance(value, list):
        raise ValueError("invalid %s envelope: expected list, got %s"
                         % (name, type(value).__name__))
    for r in value:
        if not isinstance(r, dict):
            raise ValueError("invalid %s envelope: row is %s, not object"
                             % (name, type(r).__name__))
    return value


def fetch_join(base, key, run_ids):
    """Comment-only join over authorized paths (thin network wrapper).

    Returns (touched_by_run, comments_by_issue, join_report). A run/issue
    fetch that fails is recorded in join_report["failures"] (sanitized, no
    secrets) and left OUT of the maps — missing join data, never treated as
    empty evidence. Never imported by unit tests.
    """
    touched_by_run = {}
    comments_by_issue = {}
    failures = []
    runs_ok = 0
    comment_ok = 0
    comment_attempted = 0
    for rid in run_ids:
        try:
            issues = _get(base, key, "/heartbeat-runs/%s/issues" % rid)
        except Exception as exc:  # noqa: BLE001 — recorded, sanitized
            failures.append({"kind": "run_issues", "id": rid,
                             "error": sanitize_fetch_error(exc)})
            continue
        if not isinstance(issues, list):
            failures.append({"kind": "run_issues", "id": rid,
                             "error": "malformed issues payload, not a list"})
            continue
        runs_ok += 1
        iids = [i.get("issueId") or i.get("id") for i in issues
                if isinstance(i, dict)]
        iids = [x for x in iids if x]
        touched_by_run[rid] = iids
        for iid in iids:
            if iid in comments_by_issue:
                continue
            comment_attempted += 1
            try:
                comments = _get(base, key, "/issues/%s/comments" % iid)
            except Exception as exc:  # noqa: BLE001 — recorded, sanitized
                failures.append({"kind": "issue_comments", "id": iid,
                                 "error": sanitize_fetch_error(exc)})
                continue
            if not isinstance(comments, list):
                failures.append({"kind": "issue_comments", "id": iid,
                                 "error": "malformed comments payload, "
                                          "not a list"})
                continue
            comment_ok += 1
            comments_by_issue[iid] = comments
    join_report = {
        "failures": failures,
        "runs_attempted": len(list(run_ids)),
        "runs_ok": runs_ok,
        "comment_issues_attempted": comment_attempted,
        "comment_issues_ok": comment_ok,
    }
    return touched_by_run, comments_by_issue, join_report


def fetch_all(base, key, company, window_start=WINDOW_START,
              window_end=WINDOW_END, with_join=True):
    activity = require_row_list(
        "activity",
        _get(base, key, "/companies/%s/activity?limit=500" % company))
    runs = require_row_list(
        "heartbeat-runs",
        _get(base, key, "/companies/%s/heartbeat-runs?limit=2000" % company))
    exhausted = require_row_list(
        "issues",
        _get(base, key,
             "/companies/%s/issues?q=model+tier+exhausted" % company))
    cards = [i for i in exhausted
             if in_window(i.get("createdAt") or i.get("created_at"),
                          window_start, window_end)]
    touched_by_run, comments_by_issue, join_report = {}, {}, {}
    if with_join:
        wrun_ids = [r.get("id") for r in sweep_woken_runs(runs)
                    if in_window(r.get("startedAt"), window_start, window_end)
                    and r.get("id")]
        touched_by_run, comments_by_issue, join_report = fetch_join(
            base, key, wrun_ids)
    return activity, runs, cards, touched_by_run, comments_by_issue, join_report


def main(argv=None):
    ap = argparse.ArgumentParser(description="TOG-3846 acceptance measurement")
    ap.add_argument("--snapshot-out", default=None)
    ap.add_argument("--window-start", default=WINDOW_START)
    ap.add_argument("--window-end", default=None)
    args = ap.parse_args(argv)
    base = normalize_api_base(os.environ.get("PAPERCLIP_API_URL", ""))
    key = os.environ.get("PAPERCLIP_API_KEY", "")
    company = os.environ.get("PAPERCLIP_COMPANY_ID", "")
    if not (base and key and company):
        print("need PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID",
              file=sys.stderr)
        return 2
    window_end = cap_window_end(args.window_end)
    activity, runs, cards, touched, comments, join_report = fetch_all(
        base, key, company, args.window_start, window_end)
    if args.snapshot_out:
        with open(args.snapshot_out, "w") as fh:
            json.dump({"activity": activity, "runs": runs,
                       "exhausted_cards": cards,
                       "touched_by_run": touched,
                       "comments_by_issue": comments,
                       "join_report": join_report}, fh)
        print("snapshot: activity=%d runs=%d exhausted_cards=%d "
              "touched_runs=%d comment_issues=%d join_failures=%d -> %s"
              % (len(activity), len(runs), len(cards), len(touched),
                 len(comments), len(join_report.get("failures", [])),
                 args.snapshot_out))
        return 0
    print(json.dumps(build_report(args.window_start, window_end, activity,
                                  runs, cards, comments, touched,
                                  join_report=join_report), indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
