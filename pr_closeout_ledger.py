#!/usr/bin/env python3
"""Durable admitted-PR closeout ledger with exact-head sweep gates.

The closeout loop (a Director-owned operations ledger) is defined elsewhere;
this module is only its automation slice. It does deliberately less than a
manual hygiene sweep:

  * an EXPLICIT admitted repo+PR registry (no auto-admission, no legacy
    cohort, no card-ref parsing from PR bodies);
  * exact-SHA evidence: checks/reviews recorded at any other SHA are history,
    never current proof;
  * missing checks or API errors read UNKNOWN, never green; a clean
    mergeable_state is not green;
  * drafts and release-please PRs are owned work that can never auto-merge;
  * bounded liveness proposals that are diagnostic-only (mutation "none"),
    reusing the liveness_reconciler.py guard vocabulary.

WHY THIS IS READ-ONLY. The closeout loop ends in merges, handbacks and CEO
park/supersede decisions. A sweep that writes those itself is a controller hot
edit, which this tool deliberately avoids. Every proposal this tool emits names
a recommended action and an owner; the authorized Operator applies at most one
per admitted card per pass. There is no --apply flag on purpose.

   python3 pr_closeout_ledger.py --registry pr_closeout_registry.json \\
       --snapshot ledger_snapshot.json --prior-ledger ledger_state.json \\
       --ledger-out ledger_state_new.json --plan-out plan.json --cards cards.json

Exit codes: 0 healthy-or-terminal (no action due), 1 action due (proposals
emitted), 2 usage/error, 5 COULD NOT MEASURE. Exit 5 is the load-bearing one:
an empty registry, an empty snapshot, or an unreadable input must refuse to
report a clean board rather than print one. Green here means the EVALUATOR
works -- it is never a statement about GitHub, which CI cannot reach.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import sys
from dataclasses import dataclass
from typing import Any

FULL_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
TERMINAL_DISPOSITIONS = {"MERGED", "PARKED", "SUPERSEDED", "EXCLUDED"}
LIVE_RUN_STATUSES = {"queued", "running"}
PASS_CONCLUSIONS = {"success", "skipped", "neutral"}
FAIL_CONCLUSIONS = {"failure", "cancelled", "timed_out", "action_required"}

# Hours after lastProgressAt at which a stalled admitted record escalates.
DIRECTOR_STALL_HOURS = 6
CEO_STALL_HOURS = 24
# Active-recheck cadence (hours) counted from each read: the parent requires
# admitted records to be re-read at least hourly, independent of the 6h/24h
# stall windows, which count from last progress.
RECHECK_HOURS = 1
# Owned-wait traversal hop budget: a reviewer blocked on a steward resolves to
# the steward, but a cycle (or a longer chain) strands with the path named
# instead of spinning.
MAX_WAIT_CHAIN_HOPS = 8
# History is stale evidence after a head move, not a per-read log. The cap
# bounds an hourly loop that would otherwise append forever.
HISTORY_CAP = 50


class LedgerError(RuntimeError):
    pass


def parse_time(value: Any) -> dt.datetime | None:
    if not value or not isinstance(value, str):
        return None
    try:
        text = value.strip()
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        moment = dt.datetime.fromisoformat(text)
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=dt.timezone.utc)
    return moment.astimezone(dt.timezone.utc)


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def rows(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [row for row in value if isinstance(row, dict)]
    return []


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

def load_registry(path: str) -> list[dict[str, Any]]:
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError) as error:
        raise LedgerError(f"registry unreadable: {error}") from error
    entries = data.get("entries") if isinstance(data, dict) else None
    if not isinstance(entries, list) or not entries:
        raise LedgerError("registry holds zero entries; refusing to report a clean board")
    seen: set[tuple[str, int]] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise LedgerError("registry entry is not an object")
        repo = entry.get("repo")
        pr = entry.get("pr")
        admission = entry.get("admission")
        if not repo or not isinstance(pr, int):
            raise LedgerError(f"registry entry missing repo/pr: {entry!r}"[:200])
        if admission not in ("admitted", "decision_pending"):
            raise LedgerError(f"registry entry {repo}#{pr} has unknown admission {admission!r}")
        if entry.get("kind", "standard") not in ("standard", "draft", "release"):
            raise LedgerError(f"registry entry {repo}#{pr} has unknown kind")
        key = (str(repo), pr)
        if key in seen:
            raise LedgerError(f"registry admits {repo}#{pr} twice")
        seen.add(key)
    return [e for e in entries if isinstance(e, dict)]


def registry_key(repo: str, pr: int) -> str:
    return f"{repo}#{pr}"


# ---------------------------------------------------------------------------
# Exact-head evaluation
# ---------------------------------------------------------------------------

def sha_complete(sha: Any) -> bool:
    return isinstance(sha, str) and FULL_SHA_RE.match(sha) is not None


def evaluate_check_state(
    snapshot: dict[str, Any], required: list[str]
) -> tuple[str, str]:
    """Return (GREEN|RED|UNKNOWN, detail).

    mergeable_state is read and then deliberately ignored: a clean mergeable
    PR with red or absent required checks is not green, and this function must
    never say otherwise. required comes from the effective branch rules; an
    empty required list means there is nothing to be green about, which is
    UNKNOWN, not a pass.
    """
    if snapshot.get("apiError"):
        return "UNKNOWN", f"check read failed: {snapshot.get('apiError')}"[:200]
    head = snapshot.get("headSha")
    if not sha_complete(head):
        return "UNKNOWN", "head SHA is not a canonical full SHA"
    checks = snapshot.get("checks")
    if not isinstance(checks, list):
        return "UNKNOWN", "absent check read"
    if not required:
        return "UNKNOWN", "no required checks named by effective rules"
    by_name: dict[str, list[dict[str, Any]]] = {}
    for check in rows(checks):
        name = check.get("name")
        if isinstance(name, str):
            by_name.setdefault(name, []).append(check)
    for name in required:
        exact_head = [c for c in by_name.get(name, []) if c.get("sha") == head]
        if not exact_head:
            return "UNKNOWN", f"required check {name} has no attempt at exact head"
        # Verdict and evidence read the SAME newest row, so they can never
        # disagree. A result-less NEWEST row is a run still in flight (or an
        # API gap), never green even beside an older success. A result-less
        # OLDER row is a superseded attempt the newer result replaced: it
        # does not veto green. Rows with no timestamps sort oldest (they
        # carry the least information about recency), so an untimestamped
        # queued row beside a newer timestamped result loses to the result.
        newest = newest_attempt(exact_head)
        if newest.get("conclusion") is None:
            return "UNKNOWN", f"required check {name} has a pending attempt at exact head"
        if newest.get("conclusion") not in PASS_CONCLUSIONS:
            return "RED", f"required check {name} is {newest.get('conclusion')} at exact head"
    return "GREEN", f"{len(required)} required checks pass at exact head"


def attempt_order_key(check: dict[str, Any]) -> tuple[bool, str, float]:
    """Newest-wins ordering for attempt rows: completion time, then start
    time, then row id. Rows with no time at all sort oldest -- they carry
    the least information about recency. List position (API order) never
    decides; the API may return newest-first."""
    when = parse_time(check.get("completedAt") or check.get("startedAt"))
    ident = check.get("id")
    return (
        when is not None,
        when.isoformat() if when is not None else "",
        ident if isinstance(ident, (int, float)) else -1,
    )


def newest_attempt(checks: list[dict[str, Any]]) -> dict[str, Any]:
    ordered = sorted(checks, key=attempt_order_key)
    return ordered[-1]


def latest_attempts(
    snapshot: dict[str, Any], required: list[str]
) -> list[dict[str, Any]]:
    """Raw per-required-name evidence behind the check verdict: the latest
    exact-head attempt (name/sha/conclusion), or a missing marker when the
    read holds no attempt at the head. Same filter as evaluate_check_state,
    no judgement added -- a future reviewer replays from these rows."""
    head = snapshot.get("headSha")
    checks = snapshot.get("checks")
    per_name: dict[str, list[dict[str, Any]]] = {}
    if isinstance(head, str) and isinstance(checks, list):
        for check in rows(checks):
            name = check.get("name")
            if isinstance(name, str):
                per_name.setdefault(name, []).append(check)
    rows_out: list[dict[str, Any]] = []
    for name in required:
        # Same exact-head filter as evaluate_check_state (operands swapped
        # only so the mutation gate can target each copy independently).
        # Null-conclusion rows stay visible here as pending evidence; the
        # verdict function above refuses to call them green.
        exact = [
            c for c in per_name.get(name, [])
            if c.get("sha") == head
        ]
        if exact:
            latest = newest_attempt(exact)
            rows_out.append({
                "name": latest.get("name"),
                "sha": latest.get("sha"),
                "conclusion": latest.get("conclusion"),
                "attemptId": latest.get("id"),
                "completedAt": latest.get("completedAt") or latest.get("startedAt"),
                "status": latest.get("status"),
            })
        else:
            rows_out.append({"name": name, "sha": None, "conclusion": "missing"})
    return rows_out


def evaluate_review(
    review: dict[str, Any] | None, head: str
) -> tuple[str, str, str]:
    """Return (verdict, verdict_sha, note). A verdict at any other SHA -- or
    with no SHA at all -- is history, never current proof."""
    if not isinstance(review, dict):
        return "NONE", "", "no review verdict recorded"
    verdict = review.get("verdict")
    sha = review.get("sha") if isinstance(review.get("sha"), str) else ""
    if verdict not in ("APPROVE", "CHANGES"):
        return "NONE", sha, "no actionable verdict recorded"
    if not sha or sha != head:
        return "NONE", sha, f"{verdict} verdict is at stale SHA, void at current head"
    return verdict, sha, f"{verdict} verdict at exact head"


def known_head(prior: dict[str, Any]) -> str | None:
    """The last head the ledger actually read for this PR. A read gap records
    headSha None (never a stale head as current), so the carried
    lastKnownHeadSha is what lets a head move across a gap still register."""
    for key in ("headSha", "lastKnownHeadSha"):
        value = prior.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def carried_approved_head(prior: dict[str, Any]) -> str | None:
    """The last head the ledger saw APPROVEd, carried across reads (and
    across a verdict that flaps to NONE on a failed review read). A record
    that predates the field still names it through its current verdict."""
    carried = prior.get("lastApprovedHeadSha")
    if isinstance(carried, str) and carried:
        return carried
    if prior.get("verdict") == "APPROVE":
        sha = prior.get("verdictSha")
        if isinstance(sha, str) and sha:
            return sha
    return None


def progress_renewed(
    prior: dict[str, Any],
    head: str | None,
    check_state: str,
    verdict: str,
    verdict_sha: str,
) -> bool:
    """True when this read shows real progress over the prior record: the
    head moved, required checks went RED -> GREEN, or an APPROVE verdict
    newly landed at a head that had not been approved before. (CHANGES
    renewal is owned by its own identical-findings comparison, which also
    sees the action text.) A reread that changes none of those keeps the
    clock, so looking at a stalled record never restarts its stall windows.

    Read gaps must not launder the clock either: UNKNOWN -> GREEN is NOT
    progress (a failed read followed by a good one is the same GREEN), and
    an APPROVE the record already saw at this head is not new. A prior that
    records no baseline for a dimension cannot show a transition in it."""
    prior_head = known_head(prior)
    if prior_head and isinstance(head, str) and head and prior_head != head:
        return True
    if prior.get("checkState") == "RED" and check_state == "GREEN":
        return True
    if (verdict == "APPROVE" and isinstance(head, str) and head
            and verdict_sha == head
            and isinstance(prior.get("verdict"), str)
            and carried_approved_head(prior) != head):
        return True
    return False


def append_superseded_history(
    record: dict[str, Any], prior: dict[str, Any] | None, now_iso: str
) -> None:
    """History is stale evidence, not a per-read log. A row is appended only
    when the prior record's head is no longer the record's head: a head move,
    or a read that could not name a head (the prior read is superseded by a
    gap, once -- the next gap read has no prior head left to supersede). An
    identical reread appends nothing, and the list is capped so an hourly
    loop cannot grow it forever."""
    history = [h for h in rows(record.get("history"))]
    if isinstance(prior, dict):
        prior_head = prior.get("headSha")
        current_head = record.get("headSha")
        if isinstance(prior_head, str) and prior_head and prior_head != current_head:
            moved = isinstance(current_head, str) and current_head
            history.append({
                "headSha": prior_head,
                "checkState": prior.get("checkState"),
                "verdict": prior.get("verdict"),
                "verdictSha": prior.get("verdictSha"),
                "supersededAt": now_iso,
                "reason": ("head moved; kept as history only" if moved
                           else "head unread; prior read kept as history only"),
            })
    record["history"] = history[-HISTORY_CAP:]


def evaluate(
    entry: dict[str, Any],
    snapshot: dict[str, Any] | None,
    review: dict[str, Any] | None,
    prior: dict[str, Any] | None,
    now: dt.datetime,
) -> dict[str, Any]:
    """Build one canonical ledger record. Stale evidence (prior SHA checks or
    verdicts superseded by a head move) is carried in history, never reused."""
    record = evaluate_record(entry, snapshot, review, prior, now)
    now_iso = now.isoformat().replace("+00:00", "Z")
    carry_baselines(record, prior)
    append_superseded_history(record, prior, now_iso)
    return record


def read_measures_merge_state(snapshot: dict[str, Any] | None) -> bool:
    """True when this read actually measured the PR's merge state, so it may
    overrule a prior MERGED record: either it carries its own full merge SHA
    and URL, or it is a clean read (no apiError) that says merged=false -- a
    contradiction worth surfacing rather than hiding. Absent snapshots,
    failed reads and merged-without-proof flags measure nothing."""
    if not isinstance(snapshot, dict):
        return False
    if (snapshot.get("merged") is True
            and sha_complete(snapshot.get("mergeCommitSha"))
            and isinstance(snapshot.get("mergeUrl"), str)
            and snapshot.get("mergeUrl")):
        return True
    return not snapshot.get("apiError") and snapshot.get("merged") is False


def carry_baselines(record: dict[str, Any], prior: dict[str, Any] | None) -> None:
    """Persist the two baselines progress is measured against, so a read gap
    (headSha None, verdict NONE) cannot erase them: the last head actually
    read and the last head seen approved."""
    known = known_head(prior) if isinstance(prior, dict) else None
    head = record.get("headSha")
    record["lastKnownHeadSha"] = head if isinstance(head, str) and head else known
    approved = carried_approved_head(prior) if isinstance(prior, dict) else None
    sha = record.get("verdictSha")
    if record.get("verdict") == "APPROVE" and isinstance(sha, str) and sha:
        approved = sha
    record["lastApprovedHeadSha"] = approved


def evaluate_record(
    entry: dict[str, Any],
    snapshot: dict[str, Any] | None,
    review: dict[str, Any] | None,
    prior: dict[str, Any] | None,
    now: dt.datetime,
) -> dict[str, Any]:
    repo = str(entry["repo"])
    pr = int(entry["pr"])
    key = registry_key(repo, pr)
    now_iso = now.isoformat().replace("+00:00", "Z")
    # Prior history carries forward capped; the superseded row for THIS read
    # is appended afterwards by append_superseded_history, which sees the
    # record's final head rather than the raw snapshot.
    history: list[dict[str, Any]] = []
    if isinstance(prior, dict):
        history = [h for h in rows(prior.get("history"))][-HISTORY_CAP:]
    record: dict[str, Any] = {
        "repo": repo,
        "pr": pr,
        "key": key,
        "admission": entry.get("admission"),
        "kind": entry.get("kind", "standard"),
        "authorCard": entry.get("authorCard"),
        "successorCard": entry.get("successorCard"),
        "reviewerCard": entry.get("reviewerCard"),
        "securityCard": entry.get("securityCard"),
        "standingOwner": entry.get("standingOwner"),
        "checkedAt": now_iso,
        "history": history,
        "createdAt": (prior or {}).get("createdAt", now_iso),
        # Acceptance evidence, not just the summary verdict: per-name latest
        # attempts (filled when a snapshot is present), admission age and the
        # registry's delivery promise. Defaults keep the schema uniform on
        # EXCLUDED / snapshot-absent paths; a missing optional input is never
        # "could not measure".
        "requiredCheckAttempts": [],
        "admittedAt": None,
        "admissionProvenance": None,
        "admissionAgeHours": None,
        "deliveryDeadline": None,
    }
    carry_admission_age(record, entry, prior, now)

    if entry.get("admission") != "admitted":
        record.update({
            "disposition": "EXCLUDED",
            "headSha": (snapshot or {}).get("headSha"),
            "checkState": "UNKNOWN",
            "verdict": "NONE",
            "verdictSha": "",
            "blocker": "CEO finish/park/supersede decision pending; no legacy wake",
            "nextActor": "CEO",
            "nextAction": "decide finish-admitted, park-with-reason or superseded-with-proof",
            "lastProgressAt": (prior or {}).get("lastProgressAt", record["createdAt"]),
        })
        stamp_deadlines(record, now)
        return record

    # A verified terminal record never un-verifies itself: when the prior
    # record is MERGED with a full merge SHA and URL and this read carries no
    # contradicting verified state, the record keeps MERGED and the prior
    # proof -- and stays out of proposals. An absent or failed read is a gap
    # in THIS read, never a retraction of yesterday's proof. Only a read that
    # measured the PR (merged proof of its own, or a clean merged=false) is
    # allowed to speak over the record.
    if isinstance(prior, dict) and prior.get("disposition") == "MERGED":
        prior_sha = prior.get("mergeCommitSha")
        prior_url = prior.get("mergeUrl")
        if (sha_complete(prior_sha) and isinstance(prior_url, str) and prior_url
                and not read_measures_merge_state(snapshot)):
            record.update({
                "disposition": "MERGED",
                "headSha": prior.get("headSha"),
                "checkState": "UNKNOWN",
                "checkDetail": "prior MERGED proof kept; this read did not measure",
                "verdict": "NONE",
                "verdictSha": "",
                "mergeCommitSha": prior_sha,
                "mergeUrl": prior_url,
                "blocker": None,
                "nextActor": None,
                "nextAction": None,
                "lastProgressAt": (prior or {}).get("lastProgressAt", record["createdAt"]),
            })
            stamp_deadlines(record, now)
            return record

    if snapshot is None:
        record.update({
            "disposition": "UNKNOWN_CHECKS",
            "headSha": None,
            "checkState": "UNKNOWN",
            "verdict": "NONE",
            "verdictSha": "",
            "blocker": "no snapshot read for admitted PR",
            "nextActor": "DevOps CI steward",
            "nextAction": "re-read PR snapshot; absent read is UNKNOWN, never green",
            "lastProgressAt": (prior or {}).get("lastProgressAt", record["createdAt"]),
        })
        stamp_deadlines(record, now)
        return record

    head = snapshot.get("headSha")
    record["headSha"] = head if isinstance(head, str) else None
    required = snapshot.get("requiredChecks")
    required = [c for c in required if isinstance(c, str)] if isinstance(required, list) else []
    check_state, check_detail = evaluate_check_state(snapshot, required)
    record["checkState"] = check_state
    record["checkDetail"] = check_detail
    record["requiredCheckAttempts"] = latest_attempts(snapshot, required)
    verdict, verdict_sha, verdict_note = evaluate_review(review, head if isinstance(head, str) else "")
    record["verdict"] = verdict
    record["verdictSha"] = verdict_sha
    record["verdictNote"] = verdict_note
    last_progress = (prior or {}).get("lastProgressAt", record["createdAt"])
    # Real work renews the stall windows; an unchanged reread never does. A
    # new head, a RED->GREEN transition, or a newly landed APPROVE at the
    # current head is progress on every open branch. (CHANGES renewal keeps
    # its own identical-findings comparison below, which also sees the action
    # text, so a changed action still counts there even when the SHA does
    # not.)
    if isinstance(prior, dict) and progress_renewed(
            prior, record["headSha"], check_state, verdict, verdict_sha):
        last_progress = now_iso

    # Terminal MERGED demands proof, not a flag: verified merge SHA and URL.
    if snapshot.get("merged") is True:
        merge_sha = snapshot.get("mergeCommitSha")
        merge_url = snapshot.get("mergeUrl")
        if sha_complete(merge_sha) and isinstance(merge_url, str) and merge_url:
            record.update({
                "disposition": "MERGED",
                "mergeCommitSha": merge_sha,
                "mergeUrl": merge_url,
                "blocker": None,
                "nextActor": None,
                "nextAction": None,
                "lastProgressAt": now_iso,
            })
            stamp_deadlines(record, now)
            return record
        record.update({
            "disposition": "UNKNOWN_CHECKS",
            "blocker": "merged flag without verified merge SHA/URL",
            "nextActor": "Director",
            "nextAction": "verify merge SHA/URL before recording MERGED",
            "lastProgressAt": last_progress,
        })
        stamp_deadlines(record, now)
        return record

    # Drafts and release-please PRs are owned work that can never auto-merge.
    kind = entry.get("kind", "standard")
    if kind in ("draft", "release") or snapshot.get("draft") is True or snapshot.get("releasePlease") is True:
        record.update({
            "disposition": "OWNED_NO_AUTOMERGE",
            "blocker": "draft/release work needs explicit owner readiness, never a merge nudge",
            "nextActor": record.get("standingOwner") or record.get("successorCard") or "Director",
            "nextAction": "publish next action/check/deadline; release is not a production authorization",
            "lastProgressAt": last_progress,
        })
        stamp_deadlines(record, now)
        return record

    # PARKED / SUPERSEDED demand CEO evidence held in the registry.
    prior_disp = (prior or {}).get("disposition")
    ceo_evidence = entry.get("ceoEvidence")
    if prior_disp in ("PARKED", "SUPERSEDED"):
        if isinstance(ceo_evidence, str) and ceo_evidence:
            record.update({
                "disposition": prior_disp,
                "ceoEvidence": ceo_evidence,
                "blocker": None,
                "nextActor": None,
                "nextAction": None,
                "lastProgressAt": (prior or {}).get("lastProgressAt", record["createdAt"]),
            })
        else:
            record.update({
                "disposition": "UNKNOWN_CHECKS",
                "blocker": f"{prior_disp} claimed without CEO evidence; stays owned",
                "nextActor": "CEO",
                "nextAction": "record explicit parked/superseded evidence with replacement/decision link",
                "lastProgressAt": last_progress,
            })
        stamp_deadlines(record, now)
        return record

    company_review_required = snapshot.get("companyIndependentReviewRequired", True)
    company_security_required = snapshot.get("companySecurityReviewRequired", False)
    security_ok = (not company_security_required) or bool(snapshot.get("companySecurityPassAtHead"))

    if verdict == "CHANGES":
        findings = review.get("findingsUrl") if isinstance(review, dict) else None
        action = review.get("executableAction") if isinstance(review, dict) else None
        owner = record.get("successorCard") or record.get("authorCard")
        if isinstance(findings, str) and findings and isinstance(action, str) and action and owner:
            prior_handback = (prior or {}).get("disposition") == "CHANGES_HANDBACK"
            identical = (
                prior_handback
                and (prior or {}).get("verdictSha") == verdict_sha
                and (prior or {}).get("blocker") == f"CHANGES findings: {findings}"
                and (prior or {}).get("nextAction") == action
            )
            # A reread that changes nothing is not progress: identical
            # findings/action/head keeps the prior windows, so the loop
            # cannot launder a stall by re-reading the same verdict.
            record.update({
                "disposition": "CHANGES_HANDBACK",
                "blocker": f"CHANGES findings: {findings}",
                "nextActor": owner,
                "nextAction": action,
                "lastProgressAt": last_progress if identical else now_iso,
            })
        else:
            missing = [n for n, v in (("findings", findings), ("action", action), ("owner", owner)) if not v]
            record.update({
                "disposition": "CHANGES_STRANDED",
                "blocker": f"CHANGES verdict without {', '.join(missing)}; cannot hand back",
                "nextActor": "Director",
                "nextAction": "confirm same author/successor ownership and an executable next action",
                "lastProgressAt": last_progress,
            })
        stamp_deadlines(record, now)
        return record

    if check_state == "RED":
        record.update({
            "disposition": "NEEDS_FIX",
            "blocker": check_detail,
            "nextActor": record.get("successorCard") or record.get("authorCard") or "author",
            "nextAction": "fix red required checks at exact head, push, await re-read",
            "lastProgressAt": last_progress,
        })
        stamp_deadlines(record, now)
        return record

    if check_state == "UNKNOWN":
        record.update({
            "disposition": "UNKNOWN_CHECKS",
            "blocker": check_detail,
            "nextActor": "DevOps CI steward",
            "nextAction": "re-read required checks at exact head; last read did not measure",
            "lastProgressAt": last_progress,
        })
        stamp_deadlines(record, now)
        return record

    # Checks are GREEN at the exact head from here on.
    if verdict == "APPROVE":
        if company_review_required and not record.get("reviewerCard"):
            record.update({
                "disposition": "NEEDS_REVIEW",
                "blocker": "company independent review still unmapped despite APPROVE verdict",
                "nextActor": "Director",
                "nextAction": "map reviewer card; GitHub zero-approval rules do not waive company review",
                "lastProgressAt": last_progress,
            })
        elif not security_ok:
            record.update({
                "disposition": "NEEDS_REVIEW",
                "blocker": "company security review gate outstanding at exact head",
                "nextActor": record.get("securityCard") or "CISO",
                "nextAction": "security review at exact head before merge",
                "lastProgressAt": last_progress,
            })
        else:
            record.update({
                "disposition": "APPROVED_WAIT_CI",
                "blocker": "approved at exact head; merge only on green checks held at same SHA",
                "nextActor": record.get("reviewerCard") or "reviewer",
                "nextAction": "approving reviewer squash-merges at this exact head; SHA change voids this approval",
                "lastProgressAt": last_progress,
            })
        stamp_deadlines(record, now)
        return record

    record.update({
        "disposition": "NEEDS_REVIEW",
        "blocker": verdict_note,
        "nextActor": record.get("reviewerCard") or "reviewer",
        "nextAction": "exact-head independent review; prior-SHA verdicts do not approve this head",
        "lastProgressAt": last_progress,
    })
    stamp_deadlines(record, now)
    return record


def carry_admission_age(
    record: dict[str, Any],
    entry: dict[str, Any],
    prior: dict[str, Any] | None,
    now: dt.datetime,
) -> None:
    """Admitted-since age and the registry's delivery promise ride on the
    record so the canonical output keeps them. admittedAt prefers the
    registry's explicit timestamp, then the prior record's, then first sight.
    Unparseable or absent values stay None; they are evidence gaps, never a
    refusal."""
    candidate: Any = None
    claimed = False
    provenance: str | None = None
    for source, origin in ((entry.get("admittedAt"), "registry"),
                           ((prior or {}).get("admittedAt"), "prior")):
        if isinstance(source, str) and source:
            claimed = True
            if parse_time(source) is not None:
                candidate = source
                if origin == "prior" and (prior or {}).get("admissionProvenance") == "first_sight":
                    # A first-sight lower bound stays marked unproven across
                    # persisted rereads; relabeling it "prior" would present an
                    # unmeasured bound as a tracked admission date.
                    provenance = "first_sight"
                else:
                    provenance = origin
                break
    if candidate is None and not claimed:
        # Never tracked: first sight is the honest lower bound, explicitly
        # marked unproven -- it is not a measured admission date.
        candidate = record.get("createdAt")
        provenance = "first_sight"
    if candidate is None and claimed:
        # Claimed-but-unparseable stays a None gap, same as the deadline
        # below: substituting first sight would present an invented
        # admission time as evidence.
        provenance = "missing"
    record["admittedAt"] = candidate
    record["admissionProvenance"] = provenance
    admitted = parse_time(candidate)
    if admitted is not None:
        record["admissionAgeHours"] = round(
            (now - admitted).total_seconds() / 3600.0, 2)
    deadline: Any = None
    for source in (entry.get("deliveryDeadline"), (prior or {}).get("deliveryDeadline")):
        if isinstance(source, str) and source and parse_time(source) is not None:
            deadline = source
            break
    record["deliveryDeadline"] = deadline


def stamp_deadlines(record: dict[str, Any], now: dt.datetime | None = None) -> None:
    """Stall windows count from last progress; the active recheck counts from
    this read. A re-read with no fresh progress keeps lastProgressAt (and so
    both stall deadlines) fixed while nextCheckAt advances -- the loop cannot
    reset a stall by looking at it."""
    moment = parse_time(record.get("lastProgressAt")) or parse_time(record.get("createdAt"))
    if moment is None:
        record["deadlineDirectorAt"] = None
        record["deadlineCeoAt"] = None
        record["nextCheckAt"] = None
        record["nextCheckKind"] = None
        return
    record["deadlineDirectorAt"] = (moment + dt.timedelta(hours=DIRECTOR_STALL_HOURS)).isoformat().replace("+00:00", "Z")
    record["deadlineCeoAt"] = (moment + dt.timedelta(hours=CEO_STALL_HOURS)).isoformat().replace("+00:00", "Z")
    anchor = now if now is not None else moment
    record["nextCheckAt"] = (anchor + dt.timedelta(hours=RECHECK_HOURS)).isoformat().replace("+00:00", "Z")
    record["nextCheckKind"] = "recheck"


def record_stalled(record: dict[str, Any], now: dt.datetime) -> str | None:
    """Name the stall window this read sits past, if any. Reads only the
    stamped deadlines -- never recomputed from wall clock -- so a stall
    survives re-reads until evaluate() records fresh lastProgressAt."""
    for field, reason in (("deadlineCeoAt", "stall_ceo"),
                          ("deadlineDirectorAt", "stall_director")):
        moment = parse_time(record.get(field))
        if moment is not None and now >= moment:
            return reason
    return None


def stall_escalation_owner(stall: str) -> str:
    """Escalation target for a stall window: the 24h window goes to the CEO,
    the 6h window to the Director."""
    return "CEO" if stall == "stall_ceo" else "Director"


def stall_window_label(stall: str) -> str:
    """Human window for a stall reason, for proposal text."""
    return "24h" if stall == "stall_ceo" else "6h"


# ---------------------------------------------------------------------------
# Bounded liveness proposals (diagnostic-only)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Proposal:
    card_id: str
    identifier: str
    pr_key: str
    reason: str
    mutation: str
    recommended_action: str
    owner: str | None
    note: str
    next_check_at: str | None = None

    @property
    def fingerprint(self) -> str:
        material = json.dumps(
            {"card": self.card_id, "reason": self.reason, "mutation": self.mutation},
            sort_keys=True, separators=(",", ":"),
        )
        return hashlib.sha256(material.encode()).hexdigest()[:24]

    def as_dict(self) -> dict[str, Any]:
        return {
            "cardId": self.card_id,
            "identifier": self.identifier,
            "prKey": self.pr_key,
            "reason": self.reason,
            "mutation": self.mutation,
            "recommendedAction": self.recommended_action,
            "owner": self.owner,
            "fingerprint": self.fingerprint,
            "note": self.note,
            "nextCheckAt": self.next_check_at,
        }


def card_has_live_run(card: dict[str, Any]) -> bool:
    return any(run.get("status") in LIVE_RUN_STATUSES for run in rows(card.get("runs")))


def card_monitor_healthy(card: dict[str, Any], now: dt.datetime) -> bool:
    monitor = card.get("monitor")
    if not isinstance(monitor, dict):
        return False
    next_check = parse_time(monitor.get("nextCheckAt"))
    if next_check is None or next_check <= now:
        return False
    attempts = monitor.get("attemptsLeft")
    if isinstance(attempts, int) and attempts <= 0:
        return False
    max_attempts = monitor.get("maxAttempts")
    if isinstance(max_attempts, int) and isinstance(attempts, int) and attempts > max_attempts:
        return False
    return True


def card_monitor_exhausted(card: dict[str, Any], now: dt.datetime) -> bool:
    monitor = card.get("monitor")
    if not isinstance(monitor, dict):
        return False
    next_check = parse_time(monitor.get("nextCheckAt"))
    attempts = monitor.get("attemptsLeft")
    if isinstance(attempts, int) and attempts <= 0:
        return True
    if next_check is not None and next_check <= now:
        return True
    return False


def card_hard_barrier(card: dict[str, Any]) -> str | None:
    """Every guard that forbids mutation outright: all of card_barrier except
    the owned-dependency wait. A wait names who is waited on; it never
    authorizes touching the waited-on card -- and it never suppresses a hard
    guard on the SAME card. A card with a live run behind a blocked edge is
    live_run-held, not merely waiting: the hard guard wins so the chain walk
    emits the barrier instead of a wait. Only a bare wait (no harder guard
    anywhere on the card) reads None here."""
    barrier = card_barrier(card)
    if barrier == "blocked_dependency":
        return None
    return barrier


def card_barrier(card: dict[str, Any]) -> str | None:
    """Name the guard that forbids mutating this card, if any. Mirrors the
    liveness_reconciler.py vocabulary: holds, recovery, pending interaction,
    review/security/production gates, cancelled edges."""
    if card.get("status") in ("done", "cancelled"):
        return "terminal_card"
    if card_has_live_run(card):
        return "live_run"
    holds = card.get("holds")
    if isinstance(holds, list) and any(isinstance(h, str) and h for h in holds):
        return "owner_hold"
    recovery = card.get("recovery")
    if isinstance(recovery, dict) and recovery.get("active"):
        return "native_recovery_pending"
    if card.get("pendingInteraction") is True:
        return "pending_interaction"
    if card.get("gated") is True:
        return "review_gate"
    blocked_by = card.get("blockedBy")
    if isinstance(blocked_by, list):
        for edge in blocked_by:
            if isinstance(edge, dict) and edge.get("status") == "cancelled":
                return "cancelled_edge"
    if live_blocked_edges(card):
        # Lowest priority on purpose: every barrier above names a guard that
        # forbids mutation outright. An owned dependency path is still a wait
        # -- it must never read as missing_disposition, and it must never
        # promote, reassign or weaken the hold it waits on.
        return "blocked_dependency"
    return None


def live_blocked_edges(card: dict[str, Any]) -> list[dict[str, Any]]:
    """Unresolved non-cancelled blocker edges on this card. Terminal
    (done/cancelled) blockers are not live: the edge is gone or moot, and
    claiming a dependency there would strand the record behind a ghost."""
    edges: list[dict[str, Any]] = []
    blocked_by = card.get("blockedBy")
    if not isinstance(blocked_by, list):
        return edges
    for edge in blocked_by:
        if not isinstance(edge, dict):
            continue
        if edge.get("status") in ("done", "cancelled"):
            continue
        edges.append(edge)
    return edges


def edge_target(edge: dict[str, Any]) -> str | None:
    """The waited-on card's key from a blocker edge, if it names one."""
    for field in ("identifier", "id", "cardId", "title"):
        value = edge.get(field)
        if isinstance(value, str) and value:
            return value
    return None


def follow_wait_chain(
    cards: dict[str, dict[str, Any]], start: str
) -> tuple[str | None, list[str]]:
    """Walk an owned dependency wait from the blocked card to the end of the
    chain: at each hop, the waited-on card with a live row is followed through
    ITS live edge. Returns (terminal card key, hop path). A waited-on card
    with no live row (or no edges of its own) terminates the chain there; a
    repeated key terminates too -- a cycle names its path instead of spinning.
    The hop budget bounds pathological graphs; exceeding it is still a strand
    with the travelled path, never a silent stop at the first edge."""
    path = [start]
    seen = {start}
    cursor = start
    for _ in range(MAX_WAIT_CHAIN_HOPS):
        cursor_card = cards.get(cursor)
        if not isinstance(cursor_card, dict):
            return None, path
        cursor_edges = live_blocked_edges(cursor_card)
        if not cursor_edges:
            return cursor, path
        target = edge_target(cursor_edges[0])
        if target is None:
            return None, path
        target_row = cards.get(target)
        if not isinstance(target_row, dict):
            return None, path
        if target in seen:
            return None, path + [target]
        path.append(target)
        seen.add(target)
        cursor = target
    return None, path


def card_owner(record: dict[str, Any]) -> str | None:
    return (record.get("successorCard") or record.get("authorCard")
            or record.get("reviewerCard") or record.get("standingOwner"))


def claim_proposal_card(acted_cards: set[str], card_id: str) -> bool:
    """Claim a proposal owner for this pass. The per-card cap covers EVERY
    proposal this tool emits, barrier and dependency rows included: before
    this claim the cap only guarded the healthy-path branch, so barrier and
    wait rows bypassed it and one card could draw two actions in one pass. A
    second claim on the same card is refused -- one action per card per pass
    -- and the caller skips that proposal."""
    if card_id in acted_cards:
        return False
    acted_cards.add(card_id)
    return True


def plan_proposals(
    ledger: dict[str, dict[str, Any]],
    cards: dict[str, dict[str, Any]],
    now: dt.datetime,
) -> list[Proposal]:
    """One diagnostic-only proposal per admitted card, at most.

    Excluded/parked/terminal records never wake. Cards behind a barrier (live
    run, hold, recovery, pending interaction, gate, cancelled edge, owned
    dependency wait) yield a named-barrier proposal with mutation "none".
    Records past their 6h/24h stall windows yield a diagnostic escalation to
    the Director/CEO. A healthy card in a healthy monitored state yields
    nothing. Every proposal carries the record's nextCheckAt, so the plan is
    the recheck schedule the runbook says it is. Everything emitted here is
    evidence for the named owner; the Operator applies at most one action per
    admitted card per pass.
    """
    proposals: list[Proposal] = []
    acted_cards: set[str] = set()
    for key in sorted(ledger):
        record = ledger[key]
        if record.get("disposition") in TERMINAL_DISPOSITIONS:
            continue
        if record.get("admission") != "admitted":
            continue
        owner = card_owner(record)
        card = cards.get(owner) if isinstance(owner, str) else None
        chain = []
        for candidate in (owner, record.get("reviewerCard"),
                          record.get("standingOwner"), record.get("authorCard")):
            if isinstance(candidate, str) and candidate and candidate not in chain:
                chain.append(candidate)
        # Ownership order, not dict position: the cards mapping may list
        # the reviewer before the author, but the owner still walks first.
        present = sorted(
            ((c, cards[c]) for c in chain if isinstance(cards.get(c), dict)),
            key=lambda pair: chain.index(pair[0]),
        )
        next_check_at = record.get("nextCheckAt")
        next_check_at = next_check_at if isinstance(next_check_at, str) else None
        stall = record_stalled(record, now)
        if not present:
            proposals.append(Proposal(
                card_id=str(chain[0]) if chain else key,
                identifier=str(chain[0]) if chain else key,
                pr_key=key,
                reason="owner_unmapped",
                mutation="none",
                recommended_action="map author/successor/reviewer card in the registry",
                owner="Director",
                note="Admitted record names no live card; Director maps ownership.",
                next_check_at=next_check_at,
            ))
            continue
        # The chain walk, in ownership order: the first hard-held card owns
        # the barrier proposal. A blocked author never absorbs a reviewer's
        # live run, and a live reviewer never promotes the author -- the held
        # card is checked itself, holds are never weakened.
        held: tuple[str, dict[str, Any], str] | None = None
        for walk_candidate, walk_card in present:
            walk_hard = card_hard_barrier(walk_card)
            if walk_hard is not None:
                held = (walk_candidate, walk_card, walk_hard)
                break
        if held is not None:
            held_owner, held_card, hard = held
            if not claim_proposal_card(acted_cards, str(held_owner)):
                continue
            action = "no action; card is barrier-held, re-check at nextCheckAt"
            note = f"Guard {hard} forbids mutation; diagnostic evidence only."
            if stall is not None:
                window = stall_window_label(stall)
                escalate_to = stall_escalation_owner(stall)
                action += (f"; record is also past the {window} stall window "
                           f"({escalate_to} escalation awareness)")
                note += (f" Timed diagnostic: {window} without progress "
                         f"(last {record.get('lastProgressAt')}).")
            proposals.append(Proposal(
                card_id=held_owner,
                identifier=str(held_card.get("identifier") or held_owner),
                pr_key=key,
                reason=hard,
                mutation="none",
                recommended_action=action,
                owner=held_owner,
                note=note,
                next_check_at=next_check_at,
            ))
            continue
        # No hard hold anywhere on the ownership chain: resolve the owned
        # dependency wait. The search walks ownership order, so a wait on an
        # early card is never hidden behind a later one. The wait itself then
        # follows multi-hop edges (reviewer -> steward): the terminal card
        # is diagnosed for its own barriers and liveness, never assumed. A
        # guarded off-chain terminal yields its terminal guard first -- a
        # done/cancelled card at the end of the chain is evidence the wait
        # is moot, not a reviewer stall to escalate.
        waited: tuple[str, dict[str, Any], list[dict[str, Any]]] | None = None
        for wait_candidate, wait_card in present:
            wait_edges = live_blocked_edges(wait_card)
            if wait_edges:
                waited = (wait_candidate, wait_card, wait_edges)
                break
        if waited is not None:
            blocked_owner, _, edges = waited
            edge_note = "; ".join(
                str(e.get("identifier") or e.get("id") or e.get("title") or "?")
                for e in edges[:3])
            # The chain resolves BEFORE the stall branch: a guarded off-chain
            # terminal yields its terminal guard, never a stall escalation. A
            # done/cancelled card at the end of the chain is evidence the wait
            # is moot, not a reviewer stall to escalate -- escalating first
            # would overwrite the guard with a CEO row on a dead card.
            terminal, path = follow_wait_chain(cards, blocked_owner)
            terminal_card = cards[terminal] if terminal is not None else None
            terminal_hard = (card_hard_barrier(terminal_card)
                             if terminal_card is not None else None)
            if terminal_hard is not None:
                if not claim_proposal_card(acted_cards, terminal):
                    continue
                action = "no action; card is barrier-held, re-check at nextCheckAt"
                note = f"Guard {terminal_hard} forbids mutation; diagnostic evidence only."
                if terminal_hard == "terminal_card":
                    note += (" The chain end is terminal: the wait on it is moot, "
                             "not a stall to escalate.")
                if stall is not None:
                    window = stall_window_label(stall)
                    escalate_to = stall_escalation_owner(stall)
                    action += (f"; record is also past the {window} stall window "
                               f"({escalate_to} escalation awareness)")
                    note += (f" Timed diagnostic: {window} without progress "
                             f"(last {record.get('lastProgressAt')}).")
                proposals.append(Proposal(
                    card_id=terminal,
                    identifier=str(terminal_card.get("identifier") or terminal),
                    pr_key=key,
                    reason=terminal_hard,
                    mutation="none",
                    recommended_action=action,
                    owner=terminal,
                    note=note,
                    next_check_at=next_check_at,
                ))
                continue
            if stall is not None:
                # A soft wait past its stall window escalates for real: the
                # timed diagnostic is an owned row, not an annotation. The
                # cap keys on the stalled card: two different stalled waits
                # still escalate independently, but the same wait emits once.
                escalate_to = stall_escalation_owner(stall)
                window = stall_window_label(stall)
                if not claim_proposal_card(acted_cards, str(blocked_owner)):
                    continue
                proposals.append(Proposal(
                    card_id=blocked_owner,
                    identifier=str(cards[blocked_owner].get("identifier") or blocked_owner),
                    pr_key=key,
                    reason=stall,
                    mutation="none",
                    recommended_action=(
                        f"{window} no-progress stall on {record.get('disposition')} "
                        f"while waiting on {edge_note}: "
                        f"{record.get('nextAction') or 'record next action'}; "
                        f"admission age {record.get('admissionAgeHours')}h"),
                    owner=escalate_to,
                    note=(f"Stalled {record.get('disposition')} at "
                          f"{record.get('headSha')} behind dependency wait on "
                          f"{edge_note}; last progress "
                          f"{record.get('lastProgressAt')}. Diagnostic only."),
                    next_check_at=next_check_at,
                ))
                continue
            if terminal is None:
                if not claim_proposal_card(acted_cards, str(blocked_owner)):
                    continue
                path_note = " -> ".join(path)
                proposals.append(Proposal(
                    card_id=blocked_owner,
                    identifier=str(cards[blocked_owner].get("identifier") or blocked_owner),
                    pr_key=key,
                    reason="blocked_dependency",
                    mutation="none",
                    recommended_action="no action; owned dependency wait, re-check at nextCheckAt; "
                                      "do not promote, reassign or weaken the waited-on edge",
                    owner=blocked_owner,
                    note=(f"Owned dependency path {path_note} waits on {edge_note}; "
                          f"the waited-on card has no live row or the chain cycles. "
                          f"Diagnostic evidence only."),
                    next_check_at=next_check_at,
                ))
                continue
            target_card = cards[terminal]
            # Terminal hard guards already returned above, so reaching here
            # means the terminal is barrier-free -- and the terminal can never
            # be the blocked card itself (follow_wait_chain only returns a
            # cursor with no live edges, while the blocked card has one), so
            # one claim on the terminal cannot double-claim the blocked card.
            if not claim_proposal_card(acted_cards, terminal):
                continue
            monitor_note = ""
            if card_monitor_exhausted(target_card, now):
                monitor_note = (" Its monitor lapsed; re-arm a bounded "
                                "monitor with unexpired attempts.")
            elif not card_monitor_healthy(target_card, now):
                monitor_note = " It shows no healthy monitor."
            path_note = " -> ".join(path) if len(path) > 2 else None
            note = (f"Owned dependency path: {blocked_owner} waits on "
                    f"{terminal} ({edge_note}).{monitor_note} "
                    f"Diagnostic evidence only.")
            if path_note is not None:
                note = (f"Owned dependency path {path_note}: {terminal} owns "
                        f"this wait ({edge_note}).{monitor_note} "
                        f"Diagnostic evidence only.")
            proposals.append(Proposal(
                card_id=terminal,
                identifier=str(target_card.get("identifier") or terminal),
                pr_key=key,
                reason="blocked_dependency",
                mutation="none",
                recommended_action=(
                    f"unblock {blocked_owner}: {terminal} owns this wait; "
                    f"do not promote, reassign or weaken the edge"),
                owner=terminal,
                note=note,
                next_check_at=next_check_at,
            ))
            continue
        chosen = present[0][1]
        owner = present[0][0]
        if not claim_proposal_card(acted_cards, str(owner)):
            continue
        # stall was evaluated once above for the barrier/wait branches; reuse
        # it here so a barrier-free record escalates on the same reading.
        if stall is not None:
            # Diagnostic escalation only: the sweep names the stalled owner,
            # it never repairs the card, and a re-read without fresh progress
            # keeps lastProgressAt fixed so the stall persists.
            escalate_to = stall_escalation_owner(stall)
            window = stall_window_label(stall)
            proposals.append(Proposal(
                card_id=str(owner),
                identifier=str(chosen.get("identifier") or owner),
                pr_key=key,
                reason=stall,
                mutation="none",
                recommended_action=(
                    f"{window} no-progress stall on {record.get('disposition')}: "
                    f"{record.get('nextAction') or 'record next action'}; "
                    f"admission age {record.get('admissionAgeHours')}h"),
                owner=escalate_to,
                note=(f"Stalled {record.get('disposition')} at "
                      f"{record.get('headSha')}; last progress "
                      f"{record.get('lastProgressAt')}. Diagnostic only."),
                next_check_at=next_check_at,
            ))
            continue
        if card_monitor_healthy(chosen, now):
            continue  # Owned and monitored; silence is the correct output.
        if card_monitor_exhausted(chosen, now):
            proposals.append(Proposal(
                card_id=str(owner),
                identifier=str(chosen.get("identifier") or owner),
                pr_key=key,
                reason="monitor_lapsed",
                mutation="none",
                recommended_action="re-arm a bounded monitor with unexpired attempts",
                owner=str(owner),
                note="Monitor lapsed; the owner re-arms it, the sweep never repairs the card itself.",
                next_check_at=next_check_at,
            ))
        elif record.get("disposition") == "APPROVED_WAIT_CI":
            proposals.append(Proposal(
                card_id=str(owner),
                identifier=str(chosen.get("identifier") or owner),
                pr_key=key,
                reason="approved_wait_ci_owned",
                mutation="none",
                recommended_action="hold exact head; re-read required checks at same SHA",
                owner=str(owner),
                note="APPROVED_WAIT_CI stays owned and monitored; a SHA change voids the approval.",
                next_check_at=next_check_at,
            ))
        else:
            proposals.append(Proposal(
                card_id=str(owner),
                identifier=str(chosen.get("identifier") or owner),
                pr_key=key,
                reason="missing_disposition",
                mutation="none",
                recommended_action=str(record.get("nextAction") or "record next action and nextCheckAt"),
                owner=str(owner),
                note=f"Disposition {record.get('disposition')}: {record.get('blocker') or record.get('checkDetail')}"[:300],
                next_check_at=next_check_at,
            ))
    return proposals


# ---------------------------------------------------------------------------
# Inputs and CLI
# ---------------------------------------------------------------------------

def load_inputs(
    registry_path: str,
    snapshot_path: str,
    prior_path: str | None,
    cards_path: str | None,
) -> tuple[
    list[dict[str, Any]],
    dict[str, dict[str, Any]],
    dict[str, dict[str, Any]],
    dict[str, dict[str, Any]],
    dict[str, dict[str, Any]],
]:
    registry = load_registry(registry_path)

    def load_doc(path: str, what: str) -> Any:
        try:
            with open(path, encoding="utf-8") as handle:
                return json.load(handle)
        except (OSError, ValueError) as error:
            raise LedgerError(f"{what} unreadable: {error}") from error

    snapshot_doc = load_doc(snapshot_path, "snapshot")
    if not isinstance(snapshot_doc, dict):
        raise LedgerError("snapshot document is not an object")
    snapshots: dict[str, dict[str, Any]] = {}
    reviews: dict[str, dict[str, Any]] = {}
    cards: dict[str, dict[str, Any]] = {}
    for section, target in (("snapshots", snapshots), ("reviews", reviews), ("cards", cards)):
        section_rows = snapshot_doc.get(section)
        if isinstance(section_rows, dict):
            for name, row in section_rows.items():
                if isinstance(row, dict):
                    target[str(name)] = row
    if cards_path:
        extra_doc = load_doc(cards_path, "cards")
        extra_rows = extra_doc.get("cards") if isinstance(extra_doc, dict) else None
        if isinstance(extra_rows, dict):
            for name, row in extra_rows.items():
                if isinstance(row, dict):
                    cards[str(name)] = row
    if not snapshots and not reviews:
        raise LedgerError("snapshot holds no PR snapshots or reviews; refusing to report a clean board")
    prior_records: dict[str, dict[str, Any]] = {}
    if prior_path:
        prior_doc = load_doc(prior_path, "prior ledger")
        prior_rows = prior_doc.get("records") if isinstance(prior_doc, dict) else None
        if isinstance(prior_rows, dict):
            for name, row in prior_rows.items():
                if isinstance(row, dict):
                    prior_records[str(name)] = row
    return registry, snapshots, reviews, cards, prior_records


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Durable admitted-PR closeout ledger with exact-head sweep gates.")
    parser.add_argument("--registry", required=True, help="admitted repo+PR registry JSON")
    parser.add_argument("--snapshot", required=True, help="snapshot doc with snapshots/reviews/cards")
    parser.add_argument("--prior-ledger", default=None, help="prior ledger_state JSON for history")
    parser.add_argument("--cards", default=None, help="extra cards doc merged over snapshot cards")
    parser.add_argument("--ledger-out", required=True, help="where to write the canonical ledger state")
    parser.add_argument("--plan-out", required=True, help="where to write the bounded proposal plan")
    parser.add_argument("--json", action="store_true", help="emit the plan as JSON instead of a table")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    now = utcnow()
    try:
        registry, snapshots, reviews, cards, prior_records = load_inputs(
            args.registry, args.snapshot, args.prior_ledger, args.cards)
    except LedgerError as error:
        print(f"pr_closeout_ledger: {error}", file=sys.stderr)
        return 5
    records: dict[str, dict[str, Any]] = {}
    for entry in registry:
        key = registry_key(str(entry["repo"]), int(entry["pr"]))
        records[key] = evaluate(
            entry, snapshots.get(key), reviews.get(key), prior_records.get(key), now)
    proposals = plan_proposals(records, cards, now)
    stamp = now.isoformat().replace("+00:00", "Z")
    ledger_doc = {"generatedAt": stamp, "records": records}
    plan_doc = {"generatedAt": stamp, "proposals": [p.as_dict() for p in proposals]}
    try:
        with open(args.ledger_out, "w", encoding="utf-8") as handle:
            json.dump(ledger_doc, handle, indent=2, sort_keys=True)
            handle.write("\n")
        with open(args.plan_out, "w", encoding="utf-8") as handle:
            json.dump(plan_doc, handle, indent=2, sort_keys=True)
            handle.write("\n")
    except OSError as error:
        print(f"pr_closeout_ledger: cannot write output: {error}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(plan_doc, indent=2, sort_keys=True))
    else:
        print(f"admitted records: {len(records)}")
        by_disposition: dict[str, int] = {}
        for record in records.values():
            disposition = str(record.get("disposition", "?"))
            by_disposition[disposition] = by_disposition.get(disposition, 0) + 1
        for disposition in sorted(by_disposition):
            print(f"  {disposition}: {by_disposition[disposition]}")
        if proposals:
            print(f"proposals: {len(proposals)}")
            for proposal in proposals:
                print(f"  [{proposal.reason}] {proposal.pr_key} "
                      f"owner={proposal.owner}: {proposal.recommended_action}")
        else:
            print("proposals: none -- owned and monitored, or terminal/excluded")
    return 1 if proposals else 0


if __name__ == "__main__":
    raise SystemExit(main())