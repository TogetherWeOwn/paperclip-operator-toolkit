#!/usr/bin/env python3
"""Workflow glue for review-trigger.yml. Stdlib only.

Reads the CI head SHA from HEAD_SHA and the repo from REPO, gathers PR,
check-run and file state through the GitHub REST API (GH_TOKEN), feeds one
JSON payload to review_trigger.decide(), and on `request` posts exactly one
`@togetherweown-reviewer review <sha>` comment plus the `review-ready` label.

Exit 0 with a notice for every documented skip (no open PR on this head,
decision is `skip`, trigger already posted, a live or completed review run
already covers the head). Exit 1 for anything else that stops us from
reaching a decision: API errors, missing env, malformed responses, or the
missing same-head guard. A workflow that cannot see the head state must fail
loudly, never silently skip a review (fail closed).
"""

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

import review_trigger

try:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    import review_dedup
except ImportError:
    review_dedup = None

TRIGGER_PREFIX = "@togetherweown-reviewer review"
TRIGGER_BOT = "github-actions[bot]"
READY_LABEL = "review-ready"
REVIEW_CHECK = "Paperclip Review"
CI_OK_CHECK = "ci-ok"
PAGE_SIZE = 100
MAX_PAGES = 30


def api(path, method="GET", body=None):
    token = os.environ["GH_TOKEN"]
    repo = os.environ["REPO"]
    url = "https://api.github.com/repos/%s%s" % (repo, path)
    data = None
    headers = {
        "Authorization": "Bearer %s" % token,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:500]
        raise SystemExit("::error::GitHub API %s %s -> HTTP %s: %s"
                         % (method, path, e.code, detail))


def paginate(path, key=None):
    """Return every item of a list endpoint, following page=N to a short page.

    `key` names the list inside an object response (check-runs). Past
    MAX_PAGES it exits 1: a head we cannot fully see must not be decided on,
    because a missed ci-ok skips the review and a missed marker double-posts.
    """
    sep = "&" if "?" in path else "?"
    items = []
    for page in range(1, MAX_PAGES + 1):
        data = api("%s%sper_page=%d&page=%d" % (path, sep, PAGE_SIZE, page))
        batch = ((data or {}).get(key) if key else data) or []
        items.extend(batch)
        if len(batch) < PAGE_SIZE:
            return items
    raise SystemExit("::error::%s has more than %d items; refusing to decide "
                     "on a partial view" % (path, MAX_PAGES * PAGE_SIZE))


def notice(msg):
    print("review-trigger: %s" % msg)


def is_own_trigger_comment(comment, marker):
    """True when a comment is this workflow's own trigger post for the head.

    Only the workflow actor's posts count: on a public repo any account can
    post the marker text (the head SHA is public), and a manual mention
    through another identity must never suppress the automatic trigger. The
    workflow posts as github-actions[bot], so only that login counts.
    """
    if marker not in ((comment or {}).get("body") or ""):
        return False
    user = (comment or {}).get("user") or {}
    if user.get("login") != TRIGGER_BOT:
        return False
    ctype = user.get("type")
    return ctype in (None, "", "Bot")


def has_error_outcome(runs):
    """True when the head carries a completed non-verdict Paperclip Review run."""
    for r in runs or []:
        if r.get("name") != REVIEW_CHECK:
            continue
        if r.get("status") != "completed":
            continue
        if r.get("conclusion") not in ("success", "failure"):
            return True
    return False


def ready_pr(pr, head_sha):
    """Require affirmative current PR facts, not merely an earlier association."""
    return (pr.get("state") == "open" and pr.get("draft") is False
            and (pr.get("head") or {}).get("sha") == head_sha)


def ci_ok_green(runs, head_sha):
    """Require the newest ci-ok attempt per app; ambiguous history fails closed."""
    latest = {}
    for run in runs:
        if run.get("name") != CI_OK_CHECK:
            continue
        if run.get("head_sha") != head_sha:
            return False
        app_id = (run.get("app") or {}).get("id")
        previous = latest.get(app_id)
        if previous is not None:
            # GitHub check-run IDs increase across reruns. Do not guess from
            # response order or timestamps when multiple attempts lack IDs.
            ids = (previous.get("id"), run.get("id"))
            if any(type(i) is not int for i in ids) or ids[0] == ids[1]:
                return False
            if ids[0] > ids[1]:
                continue
        latest[app_id] = run
    return bool(latest) and all(
        r.get("status") == "completed" and r.get("conclusion") == "success"
        for r in latest.values())


def head_decision(full, head_sha, check_runs, changed):
    """Re-evaluate readiness from the supplied PR and check snapshots."""
    if not ready_pr(full, head_sha):
        return "skip", "PR is no longer open, non-draft and on the requested head"
    return review_trigger.decide({
        "is_draft": full["draft"],
        "ci_ok_green": ci_ok_green(check_runs, head_sha),
        "head_sha": head_sha,
        "head_ref": (full.get("head") or {}).get("ref", ""),
        "author": ((full.get("user") or {}).get("login") or ""),
        "body": full.get("body") or "",
        "changed_files": changed,
        "labels": [l.get("name", "") for l in (full.get("labels") or [])],
        "additions": full.get("additions", 0),
        "deletions": full.get("deletions", 0),
        "check_runs": check_runs,
    })


def main():
    head_sha = os.environ.get("HEAD_SHA", "")
    if not head_sha or not os.environ.get("REPO") or not os.environ.get("GH_TOKEN"):
        raise SystemExit("::error::HEAD_SHA, REPO and GH_TOKEN are all required")

    prs = api("/commits/%s/pulls" % head_sha) or []
    prs = [p for p in prs if p.get("state") == "open"
           and (p.get("head") or {}).get("sha") == head_sha]
    if not prs:
        notice("no open PR on head %s; nothing to do" % head_sha[:12])
        return 0
    pr = prs[0]
    number = pr["number"]

    full = api("/pulls/%d" % number)
    if not ready_pr(full, head_sha):
        notice("PR #%d is not open and non-draft on the requested head" % number)
        return 0

    check_runs = paginate("/commits/%s/check-runs?filter=latest" % head_sha,
                          key="check_runs")
    if not ci_ok_green(check_runs, head_sha):
        notice("ci-ok is not green on head %s; waiting for CI" % head_sha[:12])
        return 0

    files = api("/pulls/%d/files?per_page=100" % number) or []
    changed = [f.get("filename", "") for f in files]
    truncated = len(files) >= 100
    if truncated:
        # Fail toward one extra review, not toward skipping a risky path we
        # could not see: append a path that matches RISKY_PATH_PATTERNS so
        # is_risky() routes to review even when the risky file is past page 1.
        changed.append(".github/workflows/TRUNCATED-FILE-LIST-unknown")

    action, reason = head_decision(full, head_sha, check_runs, changed)
    if action != "request":
        notice("decision=skip (%s)" % reason)
        return 0

    comments = paginate("/issues/%d/comments" % number)
    marker = "%s %s" % (TRIGGER_PREFIX, head_sha)
    own_markers = [c for c in comments if is_own_trigger_comment(c, marker)]

    if review_dedup is None:
        raise SystemExit("::error::review_dedup.py is missing from this checkout; "
                         "refusing to post a review trigger without the same-head guard")
    # Same-head idempotency: re-read the head's check-runs just
    # before posting. The decision above fires on verdicts (success/failure),
    # but a review requested through another path (manual mention, gate
    # listing, an overlapping delivery) shows as a live run with no verdict
    # and no marker comment yet; posting on top of it opens a second
    # same-head review row.
    # GitHub defaults to the latest run per name, hiding spent attempts and
    # older verdicts. The shared budget requires the complete head history.
    fresh_runs = paginate("/commits/%s/check-runs?filter=all" % head_sha, key="check_runs")
    if any(review_dedup.check_run_suppresses(r.get("name"), r.get("status"), r.get("conclusion"))
           for r in fresh_runs):
        notice("a Paperclip Review run already covers head %s; one review per head"
               % head_sha[:12])
        return 0

    # One error retry max, shared across every trigger path (this workflow,
    # the reconciler, manual mentions): each completed non-verdict Paperclip
    # Review run on this head is one spent error attempt, and the shared
    # guard decides whether any retry is left. The live/verdict guard above
    # already handled live and verdict runs, so the non-verdict completed
    # runs counted here are exactly the error attempts.
    error_attempts = sum(
        1 for r in fresh_runs
        if r.get("name") == REVIEW_CHECK
        and r.get("status") == "completed"
        and r.get("conclusion") not in ("success", "failure"))
    budget_action, budget_why = review_dedup.head_decision(["error"] * error_attempts)
    if budget_action != "request":
        notice("head %s already used its error retry budget (%s); no new trigger"
               % (head_sha[:12], budget_why))
        return 0

    if own_markers:
        # The marker is the audit trail of this workflow's own post, not of
        # any manual mention: is_own_trigger_comment already restricts it to
        # github-actions[bot]. The shared error budget above already capped
        # cross-path retries, so one marker plus an error outcome means this
        # workflow's first post errored and its single retry is still
        # available; anything else with our marker already posted stays
        # suppressed, and further recovery after the retry belongs to the
        # reconciler.
        if len(own_markers) >= 2 or not has_error_outcome(fresh_runs):
            notice("trigger already posted for head %s; one review per head"
                   % head_sha[:12])
            return 0
        notice("retrying errored head %s after one errored review (one retry max)"
               % head_sha[:12])

    # Use the same final check snapshot for CI readiness and retry history.
    # ci_ok_green selects the newest CI attempts without discarding reviews.
    current = api("/pulls/%d" % number)
    action, reason = head_decision(current, head_sha, fresh_runs, changed)
    if action != "request":
        notice("readiness changed before publication (%s)" % reason)
        return 0

    api("/issues/%d/comments" % number, method="POST",
        body={"body": "%s\n\n%s" % (marker, reason)})
    try:
        api("/issues/%d/labels" % number, method="POST",
            body={"labels": [READY_LABEL]})
    except SystemExit as e:
        # The label may not exist yet on first use; create it once, then tag.
        if "HTTP 404" not in str(e):
            raise
        api("/labels", method="POST",
            body={"name": READY_LABEL, "color": "0e8a16",
                  "description": "ci-ok green + checklist complete; bot review requested"})
        api("/issues/%d/labels" % number, method="POST",
            body={"labels": [READY_LABEL]})
    notice("decision=request (%s); trigger posted" % reason)
    return 0


if __name__ == "__main__":
    sys.exit(main())
