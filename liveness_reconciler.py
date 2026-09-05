#!/usr/bin/env python3
"""Dry-run-by-default Paperclip task-liveness reconciler (TOG-586)."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

TERMINAL_STATUSES = {"done", "cancelled"}
LIVE_RUN_STATUSES = {"queued", "running"}
OWNER_HOLD_RE = re.compile(
    r"\bowner(?:[- ](?:task[- ]specific|vendor[- ]channel|scope))?\s+hold\b"
    r"|\bhold\s+(?:external|vendor[- ]channel)"
    r"|\bdo\s+not\s+(?:start|wake|resume|proceed|deploy|contact|publish|release|merge|send)\b"
    r"|\bno\s+(?:external|vendor[- ]channel)\s+action\s+is\s+authorized\b",
    re.IGNORECASE,
)
OWNER_HOLD_COMMENT_RE = re.compile(
    r"\bowner(?:[- ](?:task[- ]specific|vendor[- ]channel|scope))?\s+hold\b"
    r"|\bhold\s+(?:external|vendor[- ]channel)"
    r"|\bdo\s+not\s+(?:contact|publish|release|deploy|send)\b",
    re.IGNORECASE,
)
OWNER_HOLD_RELEASE_RE = re.compile(
    r"\b(?:hold|prohibition|restriction)\b.{0,80}\b(?:is|was|has\s+been)\s+"
    r"(?:superseded|lifted|released|withdrawn|cancelled|ended)\b"
    r"|\b(?:work|external(?:\s+action)?|vendor(?:[- ]channel)?(?:\s+action)?)\b.{0,40}"
    r"\bmay\s+(?:resume|proceed|continue|start)\b",
    re.IGNORECASE,
)


class ReconcilerError(RuntimeError):
    pass


@dataclass(frozen=True)
class Proposal:
    issue_id: str
    identifier: str
    reason: str
    mutation: str
    target_agent_id: str | None
    source_id: str | None
    before: dict[str, Any]
    after: dict[str, Any]
    note: str

    @property
    def fingerprint(self) -> str:
        material = json.dumps(
            {
                "issueId": self.issue_id,
                "reason": self.reason,
                "mutation": self.mutation,
                "targetAgentId": self.target_agent_id,
                "sourceId": self.source_id,
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        return hashlib.sha256(material.encode()).hexdigest()[:24]

    def as_dict(self) -> dict[str, Any]:
        return {
            "issueId": self.issue_id,
            "identifier": self.identifier,
            "reason": self.reason,
            "mutation": self.mutation,
            "targetAgentId": self.target_agent_id,
            "sourceId": self.source_id,
            "fingerprint": self.fingerprint,
            "before": self.before,
            "after": self.after,
            "note": self.note,
        }


class ApiClient:
    def __init__(self, base_url: str, api_key: str, run_id: str | None = None):
        base = base_url.rstrip("/")
        if base.endswith("/api"):
            base = base[:-4]
        self.base_url = base
        self.api_key = api_key
        self.run_id = run_id

    def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        headers = {"Authorization": f"Bearer {self.api_key}"}
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body, separators=(",", ":")).encode()
        if self.run_id:
            headers["X-Paperclip-Run-Id"] = self.run_id
        request = urllib.request.Request(self.base_url + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                raw = response.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as error:
            raw = error.read().decode(errors="replace")
            raise ReconcilerError(f"{method} {path}: HTTP {error.code}: {raw[:500]}") from error
        except urllib.error.URLError as error:
            raise ReconcilerError(f"{method} {path}: {error.reason}") from error

    def get(self, path: str) -> Any:
        return self.request("GET", path)

    def patch(self, path: str, body: dict[str, Any]) -> Any:
        return self.request("PATCH", path, body)

    def post(self, path: str, body: dict[str, Any]) -> Any:
        return self.request("POST", path, body)


class HttpDataSource:
    def __init__(self, api: ApiClient, company_id: str, project_ids: set[str]):
        self.api = api
        self.company_id = company_id
        self.project_ids = project_ids

    def load(self) -> dict[str, Any]:
        raw = self.api.get(f"/api/companies/{self.company_id}/issues")
        issues = raw if isinstance(raw, list) else raw.get("issues", [])
        scoped = [issue for issue in issues if not self.project_ids or issue.get("projectId") in self.project_ids]
        for issue in scoped:
            issue_id = issue["id"]
            issue["interactions"] = self.api.get(f"/api/issues/{issue_id}/interactions")
            issue["runs"] = self.api.get(f"/api/issues/{issue_id}/runs")
            issue["comments"] = self.api.get(f"/api/issues/{issue_id}/comments?order=desc&limit=100")
            issue["activity"] = self.api.get(f"/api/issues/{issue_id}/activity")
            issue["recoveryActions"] = self.api.get(f"/api/issues/{issue_id}/recovery-actions")
            issue["treeControlState"] = self.api.get(f"/api/issues/{issue_id}/tree-control/state")
        return {"issues": scoped}


class FixtureDataSource:
    def __init__(self, path: str):
        self.path = path

    def load(self) -> dict[str, Any]:
        if self.path == "-":
            return json.load(sys.stdin)
        with open(self.path, encoding="utf-8") as handle:
            return json.load(handle)


class CommandDataSource:
    def __init__(self, command: str):
        self.command = command

    def load(self) -> dict[str, Any]:
        import subprocess

        completed = subprocess.run(
            ["bash", "-c", self.command],
            check=False,
            capture_output=True,
            text=True,
            timeout=60,
        )
        if completed.returncode != 0:
            raise ReconcilerError(
                f"source command exited {completed.returncode}: {completed.stderr.strip()[:500]}"
            )
        if not completed.stdout.strip():
            raise ReconcilerError("source command emitted no data")
        return json.loads(completed.stdout)


def rows(value: Any, key: str | None = None) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [row for row in value if isinstance(row, dict)]
    if isinstance(value, dict):
        if key and isinstance(value.get(key), list):
            return [row for row in value[key] if isinstance(row, dict)]
        for candidate in ("items", "actions", "events", "runs", "interactions", "comments"):
            if isinstance(value.get(candidate), list):
                return [row for row in value[candidate] if isinstance(row, dict)]
    return []


def parse_time(value: Any) -> dt.datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def active_pause_hold(issue: dict[str, Any]) -> dict[str, Any] | None:
    tree_state = issue.get("treeControlState")
    if not isinstance(tree_state, dict):
        return None
    hold = tree_state.get("activePauseHold")
    if not isinstance(hold, dict):
        return None
    if hold.get("mode") not in (None, "pause") or hold.get("status") not in (None, "active"):
        return None
    return hold


EPOCH = dt.datetime.min.replace(tzinfo=dt.timezone.utc)
CLAUSE_SPLIT_RE = re.compile(r"[.;\n]+|(?:\s+[-–—]\s+)")


def live_hold_clause(text: str, hold_re: re.Pattern[str]) -> str | None:
    """Return the first clause that states a hold and is not itself a release.

    A hold and its release routinely share one body: an owner lifts one
    prohibition while restating another. Judging the whole body lets the release
    phrase erase an unrelated, still-live hold, so each clause is judged alone.
    A clause that matches both (``the HOLD is superseded``) is the release of
    that hold, not a new one.
    """
    for clause in CLAUSE_SPLIT_RE.split(text):
        if hold_re.search(clause) and not OWNER_HOLD_RELEASE_RE.search(clause):
            return clause.strip()
    return None


def issue_has_owner_hold(
    issue: dict[str, Any], *, include_body: bool = True
) -> tuple[bool, str | None]:
    """Report whether a live owner HOLD covers this issue.

    ``include_body`` scans ``title``/``description``. Those fields are ordinary
    task prose, not an authenticated owner directive: measured over the 374 live
    issues in this project the body scan finds 8 holds, of which TOG-586 (this
    card, which *quotes* the failure mode) and TOG-713 ("I do not contact the
    owner directly") are false. That is acceptable for *refusing* a mutation and
    unacceptable for *initiating* containment, because ``create_pause_hold``
    cancels live runs. Callers that gate a refusal keep the default; the
    containment trigger passes ``include_body=False``.
    """
    # (timestamp, source, evidence) for every live hold statement. Owner-authored
    # text outside the comment thread carries no time of its own, so it sorts at
    # the epoch and any later owner release supersedes it.
    holds: list[tuple[dt.datetime, str, str]] = []

    descriptor = issue.get("unblockDescriptor")
    if isinstance(descriptor, dict):
        action = descriptor.get("action")
        if isinstance(action, str):
            clause = live_hold_clause(action, OWNER_HOLD_RE)
            if clause:
                holds.append((EPOCH, "unblockDescriptor", f"unblockDescriptor: {action[:200]}"))

    # The issue body is where operators most naturally write a hold, and --apply
    # mutates on the strength of this predicate. It is scanned with the stricter
    # comment pattern: measured over 200 live company issues the loose descriptor
    # pattern matches 6 scoped build instructions ("do not start from scratch",
    # "do not merge db8eee5") and would fabricate holds from ordinary task text.
    if include_body:
        for field in ("title", "description"):
            text = issue.get(field)
            if isinstance(text, str) and text:
                clause = live_hold_clause(text, OWNER_HOLD_COMMENT_RE)
                if clause:
                    holds.append((EPOCH, f"issue:{field}", f"issue {field}: {clause[:200]}"))

    owner_comments = [
        comment for comment in rows(issue.get("comments"))
        if comment.get("authorType") == "user" and not comment.get("authorAgentId")
    ]
    releases: list[tuple[dt.datetime, str]] = []
    for comment in owner_comments:
        body = comment.get("body")
        if not isinstance(body, str):
            continue
        created = parse_time(comment.get("createdAt")) or EPOCH
        source = f"comment:{comment.get('id', '?')}"
        clause = live_hold_clause(body, OWNER_HOLD_COMMENT_RE)
        if clause:
            holds.append((created, source, f"owner comment {comment.get('id', '?')}: {body[:200]}"))
        if OWNER_HOLD_RELEASE_RE.search(body):
            releases.append((created, source))

    # A release supersedes only holds stated strictly before it, and never a hold
    # from its own body: one comment that lifts hold A while restating hold B
    # leaves B live. live_hold_clause has already discarded any clause that is
    # itself the release of the hold it names.
    live = [
        (created, evidence) for created, source, evidence in holds
        if not any(
            release_at > created or (release_at == created and release_source != source)
            for release_at, release_source in releases
        )
    ]
    if not live:
        return False, None
    return True, max(live, key=lambda entry: entry[0])[1]


def orphan_retry_depth(runs: list[dict[str, Any]], source: dict[str, Any]) -> int:
    depth = 0
    seen: set[str] = set()
    current = source
    by_id = {
        str(run.get("runId") or run.get("id")): run
        for run in runs if run.get("runId") or run.get("id")
    }
    while current.get("retryOfRunId"):
        parent_id = str(current.get("retryOfRunId"))
        if parent_id in seen:
            return sys.maxsize
        seen.add(parent_id)
        parent = by_id.get(parent_id)
        if parent is None:
            break
        depth += 1
        current = parent
    return depth


def active_recovery_exists(issue: dict[str, Any], _source_run_id: str) -> bool:
    action_rows = rows(issue.get("recoveryActions"), "actions")
    active = issue.get("recoveryActions", {}).get("active") if isinstance(issue.get("recoveryActions"), dict) else None
    if isinstance(active, dict):
        action_rows.append(active)
    return any(action.get("status") in (None, "active", "escalated") for action in action_rows)


def replacement_exists(runs: list[dict[str, Any]], source: dict[str, Any]) -> bool:
    source_id = source.get("runId") or source.get("id")
    for run in runs:
        run_id = run.get("runId") or run.get("id")
        if run_id == source_id or run.get("agentId") != source.get("agentId"):
            continue
        if run.get("retryOfRunId") == source_id:
            return True
    return False


def prior_operator_decision_exists(issue: dict[str, Any], fingerprint: str) -> bool:
    marker = f"liveness-reconciler:{fingerprint}"
    for activity in rows(issue.get("activity")):
        if marker in json.dumps(activity, sort_keys=True):
            return True
    for comment in rows(issue.get("comments")):
        if marker in str(comment.get("body", "")):
            return True
    return False


def determine_unassigned_owner(issue: dict[str, Any]) -> tuple[str | None, str]:
    """Return only an owner represented by Paperclip's persisted issue schema.

    Paperclip has no ``intendedOwnerAgentId`` issue field. Treating an arbitrary
    fixture/property name as first-class task data would silently invent an
    authority the live API cannot store. A blocked issue's unblock descriptor is
    the one supported issue field that can name an agent responsible for the
    unblock action.
    """
    descriptor = issue.get("unblockDescriptor")
    owner = descriptor.get("owner") if isinstance(descriptor, dict) else None
    if isinstance(owner, dict):
        agent_id = owner.get("agentId")
        if isinstance(agent_id, str) and agent_id:
            return agent_id, "unblockDescriptor.owner.agentId"
    return None, "no first-class intended owner"


def proposals_for_issue(issue: dict[str, Any], retry_limit: int) -> list[Proposal]:
    issue_id = str(issue.get("id", ""))
    identifier = str(issue.get("identifier") or issue_id or "?")
    if not issue_id:
        raise ReconcilerError(f"fixture row {identifier} has no issue id")
    hold, hold_evidence = issue_has_owner_hold(issue)
    # Containment writes; refusal does not. Only an authenticated owner directive
    # (unblockDescriptor or an owner comment) may initiate a pause hold.
    authenticated_hold, authenticated_evidence = issue_has_owner_hold(issue, include_body=False)
    proposals: list[Proposal] = []
    interactions = rows(issue.get("interactions"))
    if issue.get("status") in TERMINAL_STATUSES:
        return []
    run_rows = rows(issue.get("runs"))
    pause_hold = active_pause_hold(issue)
    mutation_barrier = hold or pause_hold is not None
    mutation_barrier_evidence = hold_evidence or (
        f"active pause hold {pause_hold.get('id', '?')}" if pause_hold else None
    )

    if authenticated_hold and pause_hold is None:
        live_run_ids = sorted(
            str(run.get("runId") or run.get("id"))
            for run in run_rows
            if run.get("status") in LIVE_RUN_STATUSES and (run.get("runId") or run.get("id"))
        )
        proposals.append(Proposal(
            issue_id, identifier, "owner_hold_unenforced", "create_pause_hold", None, None,
            {"projectId": issue.get("projectId"), "status": issue.get("status"), "hold": authenticated_evidence, "activePauseHold": None, "liveRunIds": live_run_ids},
            {"projectId": issue.get("projectId"), "status": issue.get("status"), "activePauseHold": {"mode": "pause", "status": "active"}, "liveRunIds": []},
            "Persist one manual issue-tree pause hold. Paperclip then cancels active runs and unclaimed issue wakeups without writing or cancelling the held issue.",
        ))

    pending_addressees = {
        interaction.get("addresseeAgentId")
        for interaction in interactions
        if interaction.get("status") == "pending" and interaction.get("addresseeAgentId")
    }
    conflicting_pending_addressees = len(pending_addressees) > 1
    for interaction in interactions:
        addressee = interaction.get("addresseeAgentId")
        if interaction.get("status") != "pending" or not addressee:
            continue
        policy_ok = interaction.get("effectiveResolverPolicy") == "board_or_agents"
        review_ok = (interaction.get("isReviewVerdict") is True
                     and issue.get("status") == "in_review"
                     and issue.get("reviewPolicy") != "human_only")
        if not policy_ok and not review_ok:
            proposals.append(Proposal(
                issue_id, identifier, "interaction_not_agent_resolvable", "none", None, interaction.get("id"),
                {"projectId": issue.get("projectId"), "status": issue.get("status"), "effectiveResolverPolicy": interaction.get("effectiveResolverPolicy"), "isReviewVerdict": interaction.get("isReviewVerdict")},
                {"status": issue.get("status")},
                "ALARM: the addressed interaction is not agent-resolvable; assigning its addressee would not repair the card.",
            ))
            continue
        assignee = issue.get("assigneeAgentId")
        if assignee == addressee:
            continue
        if conflicting_pending_addressees:
            proposals.append(Proposal(
                issue_id, identifier, "interaction_addressee_conflict", "none", None, interaction.get("id"),
                {"projectId": issue.get("projectId"), "status": issue.get("status"), "assigneeAgentId": assignee, "pendingAddresseeAgentIds": sorted(pending_addressees)},
                {"projectId": issue.get("projectId"), "status": issue.get("status"), "assigneeAgentId": assignee},
                "ALARM: pending interactions name different reviewers. Do not alternate the issue assignee across timer cycles.",
            ))
        elif mutation_barrier:
            proposals.append(Proposal(
                issue_id, identifier, "owner_hold" if hold else "active_pause_hold", "none", None, interaction.get("id"),
                {"projectId": issue.get("projectId"), "status": issue.get("status"), "assigneeAgentId": assignee, "hold": mutation_barrier_evidence},
                {"projectId": issue.get("projectId"), "status": issue.get("status"), "assigneeAgentId": assignee},
                "Interaction routing mismatch detected, but every mutation is refused while a pause/HOLD barrier is live.",
            ))
        elif any(run.get("status") in LIVE_RUN_STATUSES for run in run_rows):
            proposals.append(Proposal(
                issue_id, identifier, "interaction_addressee_mismatch_active_run", "none", None, interaction.get("id"),
                {"projectId": issue.get("projectId"), "status": issue.get("status"), "assigneeAgentId": assignee, "addresseeAgentId": addressee},
                {"projectId": issue.get("projectId"), "status": issue.get("status"), "assigneeAgentId": assignee},
                "ALARM: an active implementer run makes reassignment unsafe. Emit evidence only; commenting would wake the current assignee and manufacture another continuation.",
            ))
        else:
            proposals.append(Proposal(
                issue_id, identifier, "interaction_addressee_mismatch", "none", str(addressee), interaction.get("id"),
                {"projectId": issue.get("projectId"), "status": issue.get("status"), "assigneeAgentId": assignee, "addresseeAgentId": addressee},
                {"projectId": issue.get("projectId"), "status": issue.get("status"), "assigneeAgentId": assignee, "addresseeAgentId": addressee},
                "ALARM: raw interaction and issue assignment disagree. Do not bounce the assignee; route independent review through a typed executionPolicy stage/currentParticipant.",
            ))

    orphan_runs = [
        run for run in run_rows
        if run.get("status") == "interrupted"
        and run.get("errorCode") == "orphaned_running_run"
        and not replacement_exists(run_rows, run)
        and orphan_retry_depth(run_rows, run) < retry_limit
    ]
    orphan_runs.sort(key=lambda run: str(run.get("finishedAt") or run.get("createdAt") or ""))
    for source in orphan_runs:
        source_id = str(source.get("runId") or source.get("id") or "")
        if not source_id or active_recovery_exists(issue, source_id):
            continue
        reason = "owner_hold" if hold else ("active_pause_hold" if pause_hold else "native_recovery_pending")
        note = (
            "Orphan continuation is refused while a pause/HOLD barrier is live."
            if mutation_barrier else
            "ALARM: Paperclip's native stranded-assigned-issue recovery owns continuation. "
            "Do not enqueue a parallel replacement from Ops Tooling."
        )
        proposals.append(Proposal(
            issue_id, identifier, reason, "none", source.get("agentId"), source_id,
            {"projectId": issue.get("projectId"), "status": issue.get("status"), "orphanedRunId": source_id, "hold": mutation_barrier_evidence},
            {"projectId": issue.get("projectId"), "status": issue.get("status"), "orphanedRunId": source_id},
            note,
        ))

    if issue.get("readyBlocker") is True and not issue.get("assigneeAgentId") and issue.get("status") not in TERMINAL_STATUSES:
        owner, owner_source = determine_unassigned_owner(issue)
        if mutation_barrier:
            proposals.append(Proposal(
                issue_id, identifier, "owner_hold" if hold else "active_pause_hold", "none", None, None,
                {"projectId": issue.get("projectId"), "status": issue.get("status"), "assigneeAgentId": None, "hold": mutation_barrier_evidence},
                {"projectId": issue.get("projectId"), "status": issue.get("status"), "assigneeAgentId": None},
                "Ready blocker routing is refused while a pause/HOLD barrier is live.",
            ))
        elif owner:
            proposals.append(Proposal(
                issue_id, identifier, "ready_unassigned_blocker_owned", "assign_blocker_owner", owner, None,
                {"projectId": issue.get("projectId"), "status": issue.get("status"), "assigneeAgentId": None, "ownerEvidence": owner_source},
                {"projectId": issue.get("projectId"), "status": issue.get("status"), "assigneeAgentId": owner},
                f"Assign the ready blocker once to its unique first-class intended owner from {owner_source}.",
            ))
        else:
            proposals.append(Proposal(
                issue_id, identifier, "ready_unassigned_blocker_ambiguous", "operator_decision", None, None,
                {"projectId": issue.get("projectId"), "status": issue.get("status"), "assigneeAgentId": None, "ownerEvidence": owner_source, "candidateOwnerAgentId": owner},
                {"projectId": issue.get("projectId"), "status": issue.get("status"), "assigneeAgentId": None},
                "No supported first-class intended owner exists. Create one concise operator decision item rather than accepting Paperclip's creator-provenance guess.",
            ))

    if (hold and pause_hold is not None and isinstance(issue.get("unblockDescriptor"), dict)
            and issue.get("status") not in TERMINAL_STATUSES and issue.get("status") != "blocked"):
        proposals.append(Proposal(
            issue_id, identifier, "owner_hold_status_drift", "restore_blocked", None, None,
            {"projectId": issue.get("projectId"), "status": issue.get("status"), "unblockDescriptor": issue.get("unblockDescriptor"), "hold": hold_evidence, "activePauseHold": pause_hold},
            {"projectId": issue.get("projectId"), "status": "blocked", "unblockDescriptor": issue.get("unblockDescriptor"), "activePauseHold": pause_hold},
            "Restore blocked only after the active pause hold is verified. Immediately re-read and cancel any mutation-triggered run without commenting on the held issue.",
        ))
    priority = {
        "owner_hold_unenforced": 0,
        "owner_hold": 1,
        "active_pause_hold": 1,
        "owner_hold_status_drift": 1,
        "terminal_issue": 0,
        "orphan_owner_ambiguous": 1,
        "native_recovery_pending": 1,
        "interaction_not_agent_resolvable": 2,
        "interaction_addressee_mismatch_active_run": 2,
        "interaction_addressee_conflict": 2,
        "interaction_addressee_mismatch": 3,
        "orphaned_running_run": 4,
        "ready_unassigned_blocker_owned": 5,
        "ready_unassigned_blocker_ambiguous": 5,
    }
    fresh = [proposal for proposal in proposals if not prior_operator_decision_exists(issue, proposal.fingerprint)]
    if not fresh:
        return []
    return [min(fresh, key=lambda proposal: priority.get(proposal.reason, 6))]


def plan(data: dict[str, Any], retry_limit: int, max_repairs: int) -> list[Proposal]:
    issues = rows(data.get("issues"))
    if not issues:
        raise ReconcilerError("source returned zero issues; refusing to report a clean cycle")
    proposals: list[Proposal] = []
    for issue in issues:
        proposals.extend(proposals_for_issue(issue, retry_limit))
    mutation_count = 0
    bounded: list[Proposal] = []
    for proposal in proposals:
        mutates = proposal.mutation != "none"
        if mutates and mutation_count >= max_repairs:
            bounded.append(Proposal(
                proposal.issue_id, proposal.identifier, "rate_limited", "none", proposal.target_agent_id, proposal.source_id,
                proposal.before, proposal.before,
                f"Repair cap {max_repairs} reached; leave this proposal for the next bounded cycle.",
            ))
            continue
        if mutates:
            mutation_count += 1
        bounded.append(proposal)
    return bounded


def live_blocker_is_ready(live: dict[str, Any]) -> bool:
    diagnostics = live.get("blockerDiagnostics")
    readiness = diagnostics.get("readiness") if isinstance(diagnostics, dict) else None
    return isinstance(readiness, dict) and readiness.get("isDependencyReady") is True


def reviewer_is_invokable(agent: Any, company_id: str | None) -> tuple[bool, str]:
    if not isinstance(agent, dict) or not agent.get("id"):
        return False, "reviewer does not exist"
    if company_id and agent.get("companyId") != company_id:
        return False, "reviewer belongs to another company"
    status = agent.get("status")
    if status not in {"active", "idle", "running", "error"}:
        return False, f"reviewer status is {status or 'unknown'}"
    org_health = agent.get("orgChainHealth")
    if not isinstance(org_health, dict) or org_health.get("status") != "healthy":
        return False, "reviewer org chain is not healthy"
    return True, "healthy"


def validate_live_preconditions(
    live: dict[str, Any], proposal: Proposal, reviewer: dict[str, Any] | None = None
) -> dict[str, Any]:
    hold, _ = issue_has_owner_hold(live)
    pause_hold = active_pause_hold(live)
    hold_maintenance = {"create_pause_hold", "restore_blocked"}
    if pause_hold is not None and proposal.mutation not in hold_maintenance:
        raise ReconcilerError(f"{proposal.identifier}: live active pause hold refuses {proposal.mutation}")
    if hold and proposal.mutation not in hold_maintenance:
        raise ReconcilerError(f"{proposal.identifier}: live owner HOLD refuses {proposal.mutation}")
    if live.get("status") in TERMINAL_STATUSES:
        raise ReconcilerError(f"{proposal.identifier}: live issue is terminal; refusing {proposal.mutation}")
    expected_project_id = proposal.before.get("projectId")
    if expected_project_id and live.get("projectId") != expected_project_id:
        raise ReconcilerError(f"{proposal.identifier}: issue moved outside the planned project")
    if proposal.mutation == "create_pause_hold":
        tree_state = live.get("treeControlState") if isinstance(live.get("treeControlState"), dict) else {}
        # Containment must still be justified by an authenticated owner directive
        # at apply time; unauthenticated body prose may refuse but never initiate.
        if not issue_has_owner_hold(live, include_body=False)[0] or isinstance(tree_state.get("activePauseHold"), dict):
            raise ReconcilerError(f"{proposal.identifier}: owner HOLD pause enforcement is no longer needed")
    if proposal.mutation == "assign_reviewer":
        raise ReconcilerError(
            f"{proposal.identifier}: reviewer assignment is native execution-policy work; "
            "the reduced reconciler is diagnostic-only for raw interaction mismatches"
        )
    if proposal.mutation == "assign_blocker_owner":
        invokable, invokable_reason = reviewer_is_invokable(reviewer, live.get("companyId"))
        if not invokable:
            raise ReconcilerError(f"{proposal.identifier}: blocker owner is not invokable: {invokable_reason}")
    if proposal.mutation == "wake_same_agent":
        raise ReconcilerError(
            f"{proposal.identifier}: orphan continuation is native recovery work; "
            "the reduced reconciler never dispatches it"
        )
    if proposal.mutation in {"assign_blocker_owner", "operator_decision"}:
        if live.get("status") != proposal.before.get("status") or live.get("assigneeAgentId") or not live_blocker_is_ready(live):
            raise ReconcilerError(f"{proposal.identifier}: blocker ownership repair is no longer needed")
        live_owner, live_owner_source = determine_unassigned_owner(live)
        if proposal.mutation == "assign_blocker_owner":
            if live_owner != proposal.target_agent_id or live_owner_source != proposal.before.get("ownerEvidence"):
                raise ReconcilerError(f"{proposal.identifier}: intended blocker owner changed before apply")
        elif live_owner is not None:
            raise ReconcilerError(f"{proposal.identifier}: blocker now has a unique intended owner")
    if proposal.mutation == "restore_blocked":
        if live.get("status") != proposal.before.get("status") or active_pause_hold(live) is None:
            raise ReconcilerError(f"{proposal.identifier}: owner-HOLD blocked restoration preconditions changed")
        if not isinstance(live.get("unblockDescriptor"), dict):
            raise ReconcilerError(f"{proposal.identifier}: owner-HOLD blocked restoration has no descriptor")
    return live


def apply_proposal(
    api: ApiClient, issue: dict[str, Any], proposal: Proposal
) -> dict[str, Any]:
    if proposal.mutation == "none":
        return {"fingerprint": proposal.fingerprint, "outcome": "no_mutation"}
    live = api.get(f"/api/issues/{proposal.issue_id}")
    live["comments"] = api.get(f"/api/issues/{proposal.issue_id}/comments?order=desc")
    live["interactions"] = api.get(f"/api/issues/{proposal.issue_id}/interactions")
    live["runs"] = api.get(f"/api/issues/{proposal.issue_id}/runs")
    live["activity"] = api.get(f"/api/issues/{proposal.issue_id}/activity")
    live["recoveryActions"] = api.get(f"/api/issues/{proposal.issue_id}/recovery-actions")
    live["treeControlState"] = api.get(f"/api/issues/{proposal.issue_id}/tree-control/state")
    live["blockerDiagnostics"] = api.get(f"/api/issues/{proposal.issue_id}/diagnostics/blockers")
    live["readyBlocker"] = live_blocker_is_ready(live)
    target_agent = (
        api.get(f"/api/agents/{proposal.target_agent_id}")
        if proposal.mutation in {"assign_reviewer", "assign_blocker_owner"} and proposal.target_agent_id
        else None
    )
    validate_live_preconditions(live, proposal, target_agent)
    if prior_operator_decision_exists(live, proposal.fingerprint):
        return {"fingerprint": proposal.fingerprint, "outcome": "deduplicated"}
    marker = f"liveness-reconciler:{proposal.fingerprint}"
    if proposal.mutation == "create_pause_hold":
        response = api.post(f"/api/issues/{proposal.issue_id}/tree-holds", {
            "mode": "pause",
            "reason": f"TOG-586 owner-HOLD containment ({marker})",
            "releasePolicy": {
                "strategy": "manual",
                "note": "Release only after the explicit owner HOLD is superseded.",
            },
            "metadata": {
                "source": "tog_586_liveness_reconciler",
                "fingerprint": proposal.fingerprint,
            },
        })
        hold_response = response.get("hold") if isinstance(response, dict) else None
        if not isinstance(hold_response, dict) or hold_response.get("mode") != "pause" or hold_response.get("status") != "active":
            raise ReconcilerError(f"{proposal.identifier}: tree-hold API returned no active pause hold")
        after_state = api.get(f"/api/issues/{proposal.issue_id}/tree-control/state")
        active_pause_hold = after_state.get("activePauseHold") if isinstance(after_state, dict) else None
        if not isinstance(active_pause_hold, dict):
            raise ReconcilerError(f"{proposal.identifier}: pause hold is not active after creation")
        remaining_runs = [
            run for run in rows(api.get(f"/api/issues/{proposal.issue_id}/runs"))
            if run.get("status") in LIVE_RUN_STATUSES
        ]
        for run in remaining_runs:
            run_id = run.get("runId") or run.get("id")
            if not run_id:
                raise ReconcilerError(f"{proposal.identifier}: pause hold left a live run with no id")
            cancellation = api.post(f"/api/heartbeat-runs/{run_id}/cancel", {})
            if not isinstance(cancellation, dict) or cancellation.get("status") != "cancelled":
                raise ReconcilerError(f"{proposal.identifier}: fallback cancellation did not cancel run {run_id}")
        surviving_runs = [
            run for run in rows(api.get(f"/api/issues/{proposal.issue_id}/runs"))
            if run.get("status") in LIVE_RUN_STATUSES
        ]
        if surviving_runs:
            raise ReconcilerError(f"{proposal.identifier}: pause hold containment left {len(surviving_runs)} queued/running issue run(s)")
    elif proposal.mutation in {"assign_reviewer", "assign_blocker_owner"}:
        response = api.patch(f"/api/issues/{proposal.issue_id}", {"assigneeAgentId": proposal.target_agent_id})
    elif proposal.mutation == "restore_blocked":
        descriptor = live["unblockDescriptor"]
        response = api.patch(f"/api/issues/{proposal.issue_id}", {
            "status": "blocked",
            "unblockDescriptor": descriptor,
        })
        restored = api.get(f"/api/issues/{proposal.issue_id}")
        if restored.get("status") != "blocked":
            raise ReconcilerError(f"{proposal.identifier}: owner-HOLD status did not restore to blocked")
        remaining_runs = [
            run for run in rows(api.get(f"/api/issues/{proposal.issue_id}/runs"))
            if run.get("status") in LIVE_RUN_STATUSES
        ]
        for run in remaining_runs:
            run_id = run.get("runId") or run.get("id")
            if not run_id:
                raise ReconcilerError(f"{proposal.identifier}: blocked restoration left a live run with no id")
            cancellation = api.post(f"/api/heartbeat-runs/{run_id}/cancel", {})
            if not isinstance(cancellation, dict) or cancellation.get("status") != "cancelled":
                raise ReconcilerError(f"{proposal.identifier}: blocked-restoration cancellation did not cancel run {run_id}")
        if any(run.get("status") in LIVE_RUN_STATUSES for run in rows(api.get(f"/api/issues/{proposal.issue_id}/runs"))):
            raise ReconcilerError(f"{proposal.identifier}: blocked restoration left a queued/running issue run")
    elif proposal.mutation == "wake_same_agent":
        raise ReconcilerError(
            f"{proposal.identifier}: orphan continuation is native recovery work; "
            "the reduced reconciler never dispatches it"
        )
    elif proposal.mutation == "operator_decision":
        response = api.post(f"/api/issues/{proposal.issue_id}/comments", {
            "body": f"Liveness decision `{marker}`.\n\n- Reason: `{proposal.reason}`\n- Proposed action: {proposal.note}",
        })
    else:
        return {"fingerprint": proposal.fingerprint, "outcome": "no_mutation"}
    return {"fingerprint": proposal.fingerprint, "outcome": "applied", "response": response}


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="perform proposed mutations; default is dry-run")
    parser.add_argument("--fixture", help="read one offline JSON fixture instead of the live API; '-' means stdin")
    parser.add_argument("--source-cmd", default=os.environ.get("LIVENESS_RECONCILER_SOURCE_CMD"), help="command that emits the source JSON document")
    parser.add_argument("--company-id", default=os.environ.get("PAPERCLIP_COMPANY_ID"))
    parser.add_argument("--project-id", action="append", default=[])
    parser.add_argument("--max-repairs", type=int, default=5)
    parser.add_argument("--retry-limit", type=int, default=1)
    parser.add_argument("--api-url", default=os.environ.get("PAPERCLIP_API_URL"))
    parser.add_argument("--api-key", default=os.environ.get("PAPERCLIP_API_KEY"))
    parser.add_argument("--run-id", default=os.environ.get("PAPERCLIP_RUN_ID"))
    parser.add_argument("--check-service-credential", action="store_true", help="refuse unless the API key is a board/service identity with the required safe capabilities")
    parser.add_argument("--preflight-issue-id", default=os.environ.get("PAPERCLIP_PREFLIGHT_ISSUE_ID"), help="controlled issue used for read-only scope checks")
    parser.add_argument("--preflight-agent-id", default=os.environ.get("PAPERCLIP_PREFLIGHT_AGENT_ID"), help="controlled agent used for the exact read-only agents:create authority check")
    args = parser.parse_args(argv)
    # --max-repairs 0 is a supported observe-only cycle: every trigger is still
    # measured and reported, but each is downgraded to a non-mutating
    # rate_limited record, so the run is provably incapable of a write. This is
    # the required setting for a first live cycle on a new host.
    if args.max_repairs < 0 or args.retry_limit < 1:
        parser.error("--max-repairs must be non-negative and --retry-limit must be positive")
    if args.fixture and args.source_cmd:
        parser.error("--fixture and --source-cmd are mutually exclusive")
    if args.apply and not args.fixture and not (args.api_url and args.api_key and args.company_id):
        parser.error("live --apply requires --api-url, --api-key and --company-id (or PAPERCLIP_* env)")
    if args.apply and not args.fixture and not args.source_cmd and not args.project_id:
        parser.error("live API --apply requires at least one --project-id")
    if not args.check_service_credential and not args.fixture and not args.source_cmd and not (args.company_id and args.api_url and args.api_key):
        parser.error("live API mode requires --company-id, --api-url and --api-key (or PAPERCLIP_* env)")
    if args.check_service_credential and not (args.api_url and args.api_key and args.company_id):
        parser.error("--check-service-credential requires --api-url, --api-key and --company-id (or PAPERCLIP_* env)")
    if args.check_service_credential and not args.preflight_issue_id:
        parser.error("--check-service-credential requires --preflight-issue-id (or PAPERCLIP_PREFLIGHT_ISSUE_ID)")
    if args.check_service_credential and not args.preflight_agent_id:
        parser.error("--check-service-credential requires --preflight-agent-id (or PAPERCLIP_PREFLIGHT_AGENT_ID)")
    return args


def check_service_credential(
    api: ApiClient, company_id: str, issue_id: str, agent_id: str
) -> int:
    """Validate the dedicated board identity and every non-mutating read seam.

    Paperclip has no side-effect-free permission-check endpoint for the write
    routes used by apply mode. Do not manufacture recurring audit rows merely
    to prove those writes. The installer therefore requires a non-viewer board
    membership and the first real repair remains fail-closed if a write grant
    was removed after installation.
    """
    identity = api.get("/api/cli-auth/me")
    if (not isinstance(identity, dict) or identity.get("source") != "board_key"
            or not identity.get("userId")):
        raise ReconcilerError("service timer requires a dedicated board API key")
    memberships = rows(identity.get("memberships"))
    company_member = any(
        membership.get("companyId") == company_id
        and membership.get("status", "active") == "active"
        and membership.get("role") != "viewer"
        for membership in memberships
    )
    if not identity.get("isInstanceAdmin") and not company_member:
        raise ReconcilerError("service board key lacks active write membership in the configured company")
    capability_probes = [
        ("company_issues", f"/api/companies/{company_id}/issues"),
        ("company_agents", f"/api/companies/{company_id}/agents"),
        ("issue", f"/api/issues/{issue_id}"),
        ("interactions", f"/api/issues/{issue_id}/interactions"),
        ("runs", f"/api/issues/{issue_id}/runs"),
        ("comments", f"/api/issues/{issue_id}/comments?order=desc&limit=1"),
        ("activity", f"/api/issues/{issue_id}/activity"),
        ("recovery_actions", f"/api/issues/{issue_id}/recovery-actions"),
        ("tree_control_state", f"/api/issues/{issue_id}/tree-control/state"),
        ("blocker_diagnostics", f"/api/issues/{issue_id}/diagnostics/blockers"),
        ("agent_manage_authority", f"/api/agents/{agent_id}/keys"),
    ]
    checked = []
    for name, path in capability_probes:
        result = api.get(path)
        if result is None:
            raise ReconcilerError(f"service credential capability {name} returned no payload")
        checked.append(name)
    print(json.dumps({
        "type": "credential_preflight",
        "identity": "board_key",
        "status": "accepted",
        "userId": identity.get("userId"),
        "controlledIssueId": issue_id,
        "controlledAgentId": agent_id,
        "capabilities": checked,
        "unprobedWriteAuthorities": [
            "tasks:assign", "issue:update", "issue:comment",
            "heartbeat:cancel", "tree_hold:create", "tree_hold:release",
        ],
    }, sort_keys=True))
    return 0


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    if args.check_service_credential:
        return check_service_credential(
            ApiClient(args.api_url, args.api_key, None), args.company_id,
            args.preflight_issue_id, args.preflight_agent_id,
        )
    using_offline_fixture = bool(args.fixture)
    api = ApiClient(args.api_url, args.api_key, args.run_id) if args.api_url and args.api_key and not using_offline_fixture else None
    if args.fixture:
        data = FixtureDataSource(args.fixture).load()
    elif args.source_cmd:
        data = CommandDataSource(args.source_cmd).load()
    else:
        if api is None:
            raise ReconcilerError("live API mode has no API client")
        data = HttpDataSource(api, args.company_id, set(args.project_id)).load()
    issue_by_id = {str(issue.get("id")): issue for issue in rows(data.get("issues"))}
    proposals = plan(data, args.retry_limit, args.max_repairs)
    mode = "apply" if args.apply else "dry-run"
    print(json.dumps({"type": "cycle", "mode": mode, "issuesMeasured": len(issue_by_id), "proposals": len(proposals)}, sort_keys=True))
    applied = 0
    failed = 0
    for proposal in proposals:
        record = {"type": "proposal", **proposal.as_dict(), "mode": mode}
        if args.apply:
            if api is None:
                record["apply"] = {"outcome": "fixture_simulated"}
            else:
                try:
                    result = apply_proposal(
                        api, issue_by_id[proposal.issue_id], proposal
                    )
                except ReconcilerError as error:
                    result = {"fingerprint": proposal.fingerprint, "outcome": "failed", "error": str(error)}
                    failed += 1
                record["apply"] = result
                applied += result.get("outcome") == "applied"
        print(json.dumps(record, sort_keys=True))
    print(json.dumps({"type": "summary", "mode": mode, "issuesMeasured": len(issue_by_id), "proposals": len(proposals), "applied": applied, "failed": failed}, sort_keys=True))
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, json.JSONDecodeError, ReconcilerError) as error:
        print(f"liveness_reconciler.py: {error}", file=sys.stderr)
        raise SystemExit(2)
