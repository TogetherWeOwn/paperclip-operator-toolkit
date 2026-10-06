#!/usr/bin/env python3
"""Platform watchdog detectors (phase 1: read-only, propose-only).

Reads JSON snapshots, prints JSONL. No network, no credentials, no writes.
Findings (``type: finding``) route to owners and the owning hourly
routine. Proposals (``type: proposal``) use the recovery-writer schema;
phase 1 emits ``mutation: none`` diagnostics only, so the writer
decides nothing and applies nothing. Auto-actions enable one detector at a
time on follow-up cards.

Snapshot shape (all sections optional; missing required sections emit
``unknown`` findings instead of a silent pass)::

  {
    "now": "2026-10-03T14:00:00Z",
    "agents": [{"agentId": "...", "status": "error", "errorSince": "...",
                "subtype": "success", "terminalResultSeen": true,
                "owningLead": "cto"}],
    "hosts": [{"host": "203.0.113.23", "diskPct": 99, "load": 9.0,
               "vcpu": 4, "sustainedMin": 10}],
    "ciJobs": [{"repo": "two-web-next", "job": "test", "runtimeMin": 44,
                "baselineMin": 20}],
    "queueAge": [{"label": "self-hosted", "ageMin": 160}],
    "issues": [{"id": "uuid", "identifier": "TASK-1", "status": "backlog",
                "assigneeAgentId": null, "inFocus": true, "inBacklogMin": 90,
                "isReview": false, "prAuthorAgentId": null}],
    "runEvents": [{"issueId": "uuid", "identifier": "TASK-1",
                   "kind": "dispatch_stalled_issue",
                   "at": "2026-10-03T13:00:00Z"}],
    "parks": [{"issueId": "uuid", "identifier": "TASK-1",
               "missingDispositionCount": 3}],
    "redMains": [{"repo": "example-repo", "signature": "ci-fail:abc",
                  "since": "...", "incidentExists": false}],
    "secretHits": [{"source": "run-log:<id>", "patternName": "ghp_*",
                    "valueLen": 40, "at": "..."}],
    "pendingInteractions": [{"issueId": "uuid", "identifier": "TASK-1",
                    "interactionId": "uuid", "kind": "request_confirmation",
                    "createdAt": "2026-10-03T13:00:00Z",
                    "resolverAgentId": "agent-id",
                    "assigneeAgentId": "agent-id",
                    "mentionedAgentId": "agent-id"}],
    "supply": {"readyNow": 0, "target": 12, "belowMin": 35.0,
               "idleAgents": 2, "censusAt": "2026-10-03T14:00:00Z"},
    "autoscalerSlices": [{"sliceId": "uuid", "identifier": "TASK-13264",
                    "status": "backlog", "assigneeAgentId": null,
                    "unassignedSince": "2026-10-03T11:00:00Z"}]
  }
"""

from __future__ import annotations

import argparse
import datetime
import json
import re
import statistics
import sys

PHASE = "phase-1-read-only"
CEO_ROUTE = "ceo-hourly-routine"
CEO_DESK_ROUTE = "ceo-desk"  # Owning-desk route: decides or asks the operator.

# Must equal recovery_writer.ALLOWED_MUTATIONS plus "none".
# verification/platform-watchdog-gate.sh checks this against the tree copy.
WRITER_COMPATIBLE_MUTATIONS = frozenset({
    "none",
    "create_pause_hold",
    "assign_blocker_owner",
    "restore_blocked",
    "operator_decision",
    "clear_pin",
})

AGENT_ERROR_MIN = 10
DISK_PCT = 85
DISK_PCT_CRITICAL = 95
LOAD_X_VCPU = 1.5
LOAD_SUSTAINED_MIN = 5
CI_RUNTIME_X = 2.0
QUEUE_WARN_MIN = 60
QUEUE_HIGH_MIN = 150
BACKLOG_MIN = 60
REWOKE_COUNT = 3
REWOKE_WINDOW_H = 6
PARK_COUNT = 2
PENDING_MIN = 30
PENDING_ALERT_MIN = 120
SUPPLY_FAMINE_MIN = 30
AUTOSCALER_SLICE_UNASSIGNED_MIN = 120

# Assignment-detector violation slugs. The dedupe key is
# "watchdog/assignment:<violation>:<issueId>" — stable across polls (no
# timestamps or backlog minutes in the key) so the owning routine opens
# exactly one card per card+violation. Finding and proposal for the same
# violation share the key.
ASSIGNMENT_VIOLATION_UNASSIGNED = "unassigned-backlog"
ASSIGNMENT_VIOLATION_REVIEW_AUTHOR = "review-author"

# Threshold/owner/route table for the assignment detector. Resolver-less
# rows (missing snapshot, unreadable row) route to the owning hourly
# routine.
ASSIGNMENT_ROUTES = {
    ASSIGNMENT_VIOLATION_UNASSIGNED: {"owner": "director", "route": "coo"},
    ASSIGNMENT_VIOLATION_REVIEW_AUTHOR: {"owner": "director",
                                         "route": "director"},
}


def assignment_dedupe_key(violation, issue_id):
    return f"watchdog/assignment:{violation}:{issue_id}"


def parse_time(value):
    if not isinstance(value, str) or not value:
        return None
    try:
        text = value.strip()
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        moment = datetime.datetime.fromisoformat(text)
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=datetime.timezone.utc)
        return moment
    except ValueError:
        return None


def _finding(detector, reason, severity, owner, route, evidence,
             suggested, issue_id=None, identifier=None, dedupe_key=None):
    record = {
        "type": "finding",
        "detector": f"watchdog/{detector}",
        "reason": reason,
        "severity": severity,
        "owner": owner,
        "route": route,
        "evidence": evidence,
        "suggestedAction": suggested,
        "phase": PHASE,
    }
    if issue_id is not None:
        record["issueId"] = issue_id
    if identifier is not None:
        record["identifier"] = identifier
    if dedupe_key is not None:
        record["dedupeKey"] = dedupe_key
    return record


def _proposal(detector, reason, issue_id, identifier, note,
              before=None, after=None, dedupe_key=None):
    record = {
        "type": "proposal",
        "detector": f"watchdog/{detector}",
        "reason": reason,
        "mutation": "none",
        "issueId": issue_id,
        "identifier": identifier,
        "before": before or {},
        "after": after or {},
        "note": note,
        "phase": PHASE,
    }
    if dedupe_key is not None:
        record["dedupeKey"] = dedupe_key
    return record


def detect_agent_error(now, agents):
    out = []
    if agents is None:
        return [_finding("agent_error", "agents snapshot missing",
                         "unknown", "cto", CEO_ROUTE,
                         {"section": "agents"},
                         "supply the agents snapshot; no verdict without it")]
    for agent in agents:
        if not isinstance(agent, dict) or agent.get("status") != "error":
            continue
        since = parse_time(agent.get("errorSince"))
        if since is None:
            out.append(_finding(
                "agent_error", "agent in error with unreadable errorSince",
                "unknown", str(agent.get("owningLead") or "owning-lead"),
                CEO_ROUTE, {"agentId": agent.get("agentId")},
                "fix the errorSince timestamp; cannot age the error"))
            continue
        age_min = (now - since).total_seconds() / 60
        if age_min <= AGENT_ERROR_MIN:
            continue
        benign = (agent.get("subtype") == "success"
                  and agent.get("terminalResultSeen") is True)
        if benign:
            out.append(_finding(
                "agent_error", "benign error signature past 10m",
                "info", str(agent.get("owningLead") or "owning-lead"),
                CEO_ROUTE,
                {"agentId": agent.get("agentId"), "ageMin": round(age_min, 1),
                 "subtype": "success", "terminalResultSeen": True},
                "phase-2 candidate: auto-reset to idle; phase 1 takes no action"))
        else:
            out.append(_finding(
                "agent_error", "non-benign agent error past 10m",
                "high", str(agent.get("owningLead") or "owning-lead"),
                str(agent.get("owningLead") or "owning-lead"),
                {"agentId": agent.get("agentId"), "ageMin": round(age_min, 1),
                 "subtype": agent.get("subtype")},
                "owning lead triages; no auto-reset outside the benign signature"))
    return out


def detect_host_health(hosts):
    out = []
    if hosts is None:
        return [_finding("host_health", "hosts snapshot missing", "unknown",
                         "operator", CEO_ROUTE, {"section": "hosts"},
                         "supply the host snapshot; no verdict without it")]
    for host in hosts or []:
        if not isinstance(host, dict):
            continue
        name = str(host.get("host") or "?")
        try:
            disk = float(host.get("diskPct"))
        except (TypeError, ValueError):
            disk = None
        if disk is not None and disk >= DISK_PCT:
            out.append(_finding(
                "host_health", "disk at or above 85%",
                "critical" if disk >= DISK_PCT_CRITICAL else "high",
                "operator", "operator" if disk < DISK_PCT_CRITICAL else "page-operator",
                {"host": name, "diskPct": disk},
                "reclaim disk now"))
        try:
            load = float(host.get("load"))
            vcpu = float(host.get("vcpu"))
            sustained = float(host.get("sustainedMin", 0))
        except (TypeError, ValueError):
            load = vcpu = sustained = None
        if (load is not None and vcpu is not None and vcpu > 0
                and sustained is not None and sustained >= LOAD_SUSTAINED_MIN
                and load > LOAD_X_VCPU * vcpu):
            out.append(_finding(
                "host_health", "load above 1.5x vCPU sustained",
                "high", "operator", "operator",
                {"host": name, "load": load, "vcpu": vcpu,
                 "sustainedMin": sustained},
                "shed load or add capacity; check GARM queue depth"))
    return out


def detect_ci_health(jobs, queues):
    out = []
    if jobs is None and queues is None:
        return [_finding("ci_health", "CI snapshot missing", "unknown",
                         "devops", CEO_ROUTE,
                         {"section": "ciJobs/queueAge"},
                         "supply CI runtimes and queue ages; no verdict without them")]
    for job in jobs or []:
        if not isinstance(job, dict):
            continue
        try:
            runtime = float(job.get("runtimeMin"))
            baseline = float(job.get("baselineMin"))
        except (TypeError, ValueError):
            runtime = baseline = None
        label = f"{job.get('repo')}/{job.get('job')}"
        if runtime is None or baseline is None:
            out.append(_finding(
                "ci_health", "CI job with unreadable runtime or baseline",
                "unknown", "devops", CEO_ROUTE, {"job": label},
                "fix the baseline adapter; cannot ratio without it"))
        elif baseline <= 0:
            out.append(_finding(
                "ci_health", "CI job with non-positive baseline",
                "unknown", "devops", CEO_ROUTE,
                {"job": label, "baselineMin": baseline},
                "fix the baseline; a zero baseline makes every ratio infinite"))
        elif runtime > CI_RUNTIME_X * baseline:
            out.append(_finding(
                "ci_health", "CI job runtime above 2x baseline",
                "high", "devops", "devops",
                {"job": label, "runtimeMin": runtime,
                 "baselineMin": baseline,
                 "ratio": round(runtime / baseline, 2)},
                "inspect the runner and the job log tail; file an overflow request if queued"))
    for queue in queues or []:
        if not isinstance(queue, dict):
            continue
        try:
            age = float(queue.get("ageMin"))
        except (TypeError, ValueError):
            continue
        if age >= QUEUE_HIGH_MIN:
            sev, route = "high", "devops"
        elif age >= QUEUE_WARN_MIN:
            sev, route = "info", CEO_ROUTE
        else:
            continue
        out.append(_finding(
            "ci_health", "runner queue age elevated",
            sev, "devops", route,
            {"label": queue.get("label"), "ageMin": age},
            "file a CI overflow request per PROD_DELIVERY rules if saturation holds"))
    return out


def detect_assignment(issues):
    out = []
    if issues is None:
        return [_finding("assignment", "issues snapshot missing", "unknown",
                         "director", CEO_ROUTE, {"section": "issues"},
                         "supply the board snapshot; no verdict without it")]
    for issue in issues:
        if not isinstance(issue, dict) or not issue.get("inFocus"):
            continue
        issue_id = issue.get("id")
        identifier = issue.get("identifier") or issue.get("id") or "?"
        if not issue_id:
            continue
        if issue.get("isReview") and issue.get("assigneeAgentId") \
                and issue.get("assigneeAgentId") == issue.get("prAuthorAgentId"):
            review_key = assignment_dedupe_key(
                ASSIGNMENT_VIOLATION_REVIEW_AUTHOR, issue_id)
            review_route = ASSIGNMENT_ROUTES[
                ASSIGNMENT_VIOLATION_REVIEW_AUTHOR]
            out.append(_finding(
                "assignment", "review card assigned to the PR author",
                "high", review_route["owner"], review_route["route"],
                {"identifier": identifier},
                "reassign to an independent reviewer; author never reviews own PR",
                issue_id, identifier, review_key))
            out.append(_proposal(
                "assignment", "review assigned to PR author",
                issue_id, identifier,
                "Phase-2 candidate: assign_blocker_owner to an independent "
                "reviewer once an owner resolver exists; phase 1 writes nothing.",
                dedupe_key=review_key))
        backlog_min = issue.get("inBacklogMin")
        try:
            backlog_min = float(backlog_min) if backlog_min is not None else 0
        except (TypeError, ValueError):
            backlog_min = 0
        if not issue.get("assigneeAgentId") or backlog_min > BACKLOG_MIN:
            unassigned_key = assignment_dedupe_key(
                ASSIGNMENT_VIOLATION_UNASSIGNED, issue_id)
            unassigned_route = ASSIGNMENT_ROUTES[
                ASSIGNMENT_VIOLATION_UNASSIGNED]
            out.append(_finding(
                "assignment", "in-focus card unassigned or in backlog over 1h",
                "high", unassigned_route["owner"], unassigned_route["route"],
                {"identifier": identifier,
                 "assigneeAgentId": issue.get("assigneeAgentId"),
                 "inBacklogMin": backlog_min},
                "allocate ready work per owner priority order",
                issue_id, identifier, unassigned_key))
            out.append(_proposal(
                "assignment", "in-focus card needs an owner",
                issue_id, identifier,
                "Phase-2 candidate: assign_blocker_owner once the intended "
                "owner is first-class; phase 1 writes nothing.",
                dedupe_key=unassigned_key))
    return out


def detect_churn(now, events, parks):
    out = []
    if events is None and parks is None:
        return [_finding("churn", "churn snapshot missing", "unknown",
                         "ceo", CEO_ROUTE, {"section": "runEvents/parks"},
                         "supply run events and park counts; no verdict without them")]
    window_start = now - datetime.timedelta(hours=REWOKE_WINDOW_H)
    counts = {}
    for event in events or []:
        if not isinstance(event, dict):
            continue
        if event.get("kind") != "dispatch_stalled_issue":
            continue
        at = parse_time(event.get("at"))
        if at is None or at < window_start:
            continue
        key = (event.get("issueId"), event.get("identifier") or "?")
        counts[key] = counts.get(key, 0) + 1
    for (issue_id, identifier), count in counts.items():
        if count > REWOKE_COUNT and issue_id:
            out.append(_finding(
                "churn", "card re-woken more than 3 times in 6h",
                "high", "ceo", CEO_ROUTE,
                {"identifier": identifier, "rewokes": count},
                "fix the stall-sweep loop guard; stop re-waking parked cards",
                issue_id, identifier))
            out.append(_proposal(
                "churn", "repeated stall re-wake",
                issue_id, identifier,
                "Phase-2 candidate: restore_blocked where a live descriptor "
                "exists; phase 1 writes nothing."))
    for park in parks or []:
        if not isinstance(park, dict):
            continue
        try:
            n = int(park.get("missingDispositionCount", 0))
        except (TypeError, ValueError):
            continue
        if n > PARK_COUNT and park.get("issueId"):
            out.append(_finding(
                "churn", "card parked for missing disposition more than twice",
                "high", "ceo", CEO_ROUTE,
                {"identifier": park.get("identifier"),
                 "missingDispositionCount": n},
                "set a real disposition or monitor; repeated parks need a decision",
                park.get("issueId"), park.get("identifier")))
            out.append(_proposal(
                "churn", "repeated missing-disposition park",
                park["issueId"], park.get("identifier") or "?",
                "Phase-2 candidate: restore_blocked where a live descriptor "
                "exists; phase 1 writes nothing."))
    return out


def detect_pending_interactions(now, pending):
    out = []
    if pending is None:
        return [_finding("pending_interactions",
                         "pending-interactions snapshot missing",
                         "unknown", "ceo", CEO_ROUTE,
                         {"section": "pendingInteractions"},
                         "supply pending issue_thread_interactions; "
                         "no verdict without them")]
    ages = []
    for item in pending or []:
        if not isinstance(item, dict):
            continue
        created = parse_time(item.get("createdAt"))
        identifier = item.get("identifier") or item.get("issueId") or "?"
        if created is None:
            out.append(_finding(
                "pending_interactions",
                "pending interaction with unreadable createdAt",
                "unknown", "ceo", CEO_ROUTE,
                {"identifier": identifier,
                 "interactionId": item.get("interactionId")},
                "fix the createdAt timestamp; cannot age the interaction"))
            continue
        age_min = (now - created).total_seconds() / 60
        ages.append(age_min)
        if age_min <= PENDING_MIN:
            continue
        issue_id = item.get("issueId")
        resolver = (item.get("resolverAgentId")
                    or item.get("assigneeAgentId")
                    or item.get("mentionedAgentId"))
        alert = age_min >= PENDING_ALERT_MIN
        evidence = {"identifier": identifier,
                    "interactionId": item.get("interactionId"),
                    "kind": item.get("kind"),
                    "ageMin": round(age_min, 1)}
        if resolver:
            out.append(_finding(
                "pending_interactions",
                "pending interaction older than 30m with addressed resolver",
                "high" if alert else "info",
                str(resolver), str(resolver), evidence,
                "wake the addressed resolver; over 2h also alerts "
                "the CEO desk via the backlog metric",
                issue_id, identifier))
        else:
            out.append(_finding(
                "pending_interactions",
                "pending interaction older than 30m with no clear resolver",
                "high" if alert else "info",
                "ceo", CEO_DESK_ROUTE, evidence,
                "route to the owning desk card, which decides "
                "or asks the operator",
                issue_id, identifier))
        if issue_id:
            out.append(_proposal(
                "pending_interactions", "stale pending interaction",
                issue_id, identifier,
                "Phase-2 candidate: wake the addressed resolver once a "
                "wake mutation exists; phase 1 writes nothing."))
    if ages:
        over_alert = sum(1 for age in ages if age >= PENDING_ALERT_MIN)
        out.append(_finding(
            "pending_interactions", "pending-interaction backlog metric",
            "high" if over_alert else "info", "ceo",
            CEO_DESK_ROUTE if over_alert else CEO_ROUTE,
            {"count": len(ages),
             "medianAgeMin": round(statistics.median(ages), 1),
             "over2h": over_alert},
            "alert: a pending interaction is over 2h; the CEO desk "
            "decides or asks the operator"
            if over_alert else
            "count and median age of pending interactions for "
            "the CEO hourly routine"))
    return out


def detect_autoscaler_slices(now, slices):
    out = []
    if slices is None:
        return [_finding("autoscaler_slices",
                         "autoscaler-slices snapshot missing",
                         "unknown", "coo", CEO_ROUTE,
                         {"section": "autoscalerSlices"},
                         "supply the autoscaler slice assignment snapshot; "
                         "no verdict without it")]
    for item in slices or []:
        if not isinstance(item, dict):
            continue
        identifier = (item.get("identifier") or item.get("sliceId")
                      or "?")
        if item.get("assigneeAgentId"):
            continue
        since = parse_time(item.get("unassignedSince"))
        if since is None:
            out.append(_finding(
                "autoscaler_slices",
                "autoscaler slice with unreadable unassignedSince",
                "unknown", "coo", CEO_ROUTE,
                {"identifier": identifier,
                 "sliceId": item.get("sliceId")},
                "fix the unassignedSince timestamp; cannot age the slice"))
            continue
        age_min = (now - since).total_seconds() / 60
        if age_min <= AUTOSCALER_SLICE_UNASSIGNED_MIN:
            continue
        slice_id = item.get("sliceId")
        out.append(_finding(
            "autoscaler_slices",
            "autoscaler slice unassigned for over 2h",
            "high", "coo", CEO_ROUTE,
            {"identifier": identifier, "sliceId": slice_id,
             "status": item.get("status"),
             "ageMin": round(age_min, 1)},
            "COO allocates the slice per the joint-controller "
            "admission rules, or the owning hourly routine decides",
            slice_id, identifier))
        if slice_id:
            out.append(_proposal(
                "autoscaler_slices",
                "unassigned autoscaler slice past 2h",
                slice_id, identifier,
                "Phase-2 candidate: assign_blocker_owner to the resolved "
                "owner once an owner resolver exists; phase 1 writes nothing."))
    return out


def detect_red_main(reds):
    out = []
    if reds is None:
        return [_finding("red_main", "red-main snapshot missing", "unknown",
                         "ceo", CEO_ROUTE, {"section": "redMains"},
                         "supply branch status per repo; no verdict without it")]
    for red in reds or []:
        if not isinstance(red, dict):
            continue
        repo = red.get("repo") or "?"
        sig = red.get("signature") or "?"
        if red.get("incidentExists"):
            out.append(_finding(
                "red_main", "red main already tracked by an incident",
                "info", "repo-lead", CEO_ROUTE,
                {"repo": repo, "signature": sig},
                "no new incident; fix main first"))
        else:
            out.append(_finding(
                "red_main", "red main with no incident",
                "high", "repo-lead", "repo-lead",
                {"repo": repo, "signature": sig, "since": red.get("since")},
                "CEO routine opens exactly ONE incident card per repo and red "
                "signature; the writer has no issue-create mutation"))
    return out


def detect_secret_hit(hits):
    out = []
    if hits is None:
        return [_finding("secret_hit", "secret-scan snapshot missing",
                         "unknown", "ciso", CEO_ROUTE,
                         {"section": "secretHits"},
                         "supply the scan snapshot; no verdict without it")]
    for hit in hits or []:
        if not isinstance(hit, dict):
            continue
        # Never echo values: accept names and lengths only.
        out.append(_finding(
            "secret_hit", "secret pattern hit in run log or transcript",
            "critical", "ciso", "ciso",
            {"source": hit.get("source"),
             "patternName": hit.get("patternName"),
             "valueLen": hit.get("valueLen"),
             "at": hit.get("at")},
            "Hindsight scrub of the affected memory; this is not rotation"))
    return out


def detect_supply_famine(supply):
    out = []
    if supply is None:
        return [_finding("supply_famine", "supply snapshot missing",
                         "unknown", "coo", CEO_ROUTE, {"section": "supply"},
                         "supply the ready-now census; no verdict without it")]
    if not isinstance(supply, dict):
        return [_finding("supply_famine", "supply snapshot unreadable",
                         "unknown", "coo", CEO_ROUTE, {"section": "supply"},
                         "fix the supply adapter; cannot compare without it")]
    try:
        ready = int(supply.get("readyNow"))
        target = int(supply.get("target"))
        below = float(supply.get("belowMin"))
    except (TypeError, ValueError):
        return [_finding("supply_famine", "supply snapshot unreadable",
                         "unknown", "coo", CEO_ROUTE, {"section": "supply"},
                         "fix the supply adapter; cannot compare without it")]
    try:
        idle = int(supply.get("idleAgents", 0))
    except (TypeError, ValueError):
        idle = 0
    if ready >= target:
        return []
    evidence = {"readyNow": ready, "target": target,
                "belowMin": round(below, 1), "idleAgents": idle,
                "censusAt": supply.get("censusAt")}
    if below < SUPPLY_FAMINE_MIN:
        out.append(_finding(
            "supply_famine", "ready-now below target under 30m",
            "info", "coo", CEO_ROUTE, evidence,
            "watching: ready-now below target; page only if sustained 30m"))
        return out
    out.append(_finding(
        "supply_famine", "ready-now below target sustained 30m",
        "high", "ceo", CEO_ROUTE, evidence,
        "comment the famine on the owning desk card (state change only, <1200 chars, "
        "max 1 per 2h) with owner mention"))
    out.append(_proposal(
        "supply_famine", "sustained supply famine pages via CEO routine",
        None, "owning-desk",
        "Phase-2 candidate: cross-issue comment mutation does not exist; "
        "the page stays a CEO-routine action, same shape as red_main "
        "incident creation; phase 1 writes nothing."))
    return out


def detect(snapshot):
    now = parse_time(snapshot.get("now")) or datetime.datetime.now(
        datetime.timezone.utc)
    records = []
    records.extend(detect_agent_error(now, snapshot.get("agents")))
    records.extend(detect_host_health(snapshot.get("hosts")))
    records.extend(detect_ci_health(snapshot.get("ciJobs"),
                                    snapshot.get("queueAge")))
    records.extend(detect_assignment(snapshot.get("issues")))
    records.extend(detect_churn(now, snapshot.get("runEvents"),
                               snapshot.get("parks")))
    records.extend(detect_pending_interactions(
        now, snapshot.get("pendingInteractions")))
    records.extend(detect_autoscaler_slices(
        now, snapshot.get("autoscalerSlices")))
    records.extend(detect_red_main(snapshot.get("redMains")))
    records.extend(detect_secret_hit(snapshot.get("secretHits")))
    records.extend(detect_supply_famine(snapshot.get("supply")))
    for record in records:
        mutation = record.get("mutation")
        if mutation is not None and mutation not in WRITER_COMPATIBLE_MUTATIONS:
            raise ValueError(f"detector emitted outside-allowlist mutation {mutation!r}")
        if record.get("type") == "finding":
            evidence = json.dumps(record.get("evidence") or {})
            # Pattern names like "ghp_*" are fine; value-shaped strings
            # (prefix plus 8 or more alphanumerics) are never allowed out.
            if re.search(r"ghp_[A-Za-z0-9]{8,}", evidence) \
                    or re.search(r"github_pat_[A-Za-z0-9_]{8,}", evidence):
                raise ValueError(
                    "finding evidence carries a possible secret value")
    return records


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Platform watchdog detectors: read-only, propose-only.")
    parser.add_argument("--snapshot", required=True,
                        help="JSON file with agents/hosts/CI/issues/churn/"
                             "pendingInteractions/autoscalerSlices/"
                             "redMains/secretHits/supply")
    args = parser.parse_args(argv)
    try:
        with open(args.snapshot, encoding="utf-8") as handle:
            snapshot = json.load(handle)
    except (OSError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        print(f"watchdog: cannot read snapshot: {exc}", file=sys.stderr)
        return 2
    if not isinstance(snapshot, dict):
        print("watchdog: snapshot must be a JSON object", file=sys.stderr)
        return 2
    records = detect(snapshot)
    for record in records:
        print(json.dumps(record, sort_keys=True))
    summary = {"type": "summary", "detector": "watchdog/cycle",
               "records": len(records), "phase": PHASE}
    print(json.dumps(summary, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
