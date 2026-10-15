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
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "ops" / "productivity"))
    import review_dedup
except ImportError:
    review_dedup = None

TRIGGER_PREFIX = "@togetherweown-reviewer review"
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
    if full.get("draft"):
        notice("PR #%d is a draft; drafts are never reviewed" % number)
        return 0

    check_runs = [
        {
            "name": r.get("name"),
            "status": r.get("status"),
            "conclusion": r.get("conclusion"),
            "head_sha": head_sha,
        }
        for r in paginate("/commits/%s/check-runs" % head_sha, key="check_runs")
    ]
    ci_ok = [r for r in check_runs
             if r["name"] == CI_OK_CHECK and r["status"] == "completed"]
    if not any(r["conclusion"] == "success" for r in ci_ok):
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

    payload = {
        "is_draft": bool(full.get("draft")),
        "ci_ok_green": True,
        "head_sha": head_sha,
        "head_ref": (full.get("head") or {}).get("ref", ""),
        "author": ((full.get("user") or {}).get("login") or ""),
        "body": full.get("body") or "",
        "changed_files": changed,
        "labels": [l.get("name", "") for l in (full.get("labels") or [])],
        "additions": full.get("additions", 0),
        "deletions": full.get("deletions", 0),
        "check_runs": check_runs,
    }
    action, reason = review_trigger.decide(payload)
    if action != "request":
        notice("decision=skip (%s)" % reason)
        return 0

    comments = paginate("/issues/%d/comments" % number)
    marker = "%s %s" % (TRIGGER_PREFIX, head_sha)
    if any(marker in (c.get("body") or "") for c in comments):
        notice("trigger already posted for head %s; one review per head"
               % head_sha[:12])
        return 0

    if review_dedup is None:
        raise SystemExit("::error::ops/productivity/review_dedup.py is missing from this checkout; "
                         "refusing to post a review trigger without the same-head guard")
    # Same-head idempotency: re-read the head's check-runs just
    # before posting. The decision above fires on verdicts (success/failure),
    # but a review requested through another path (manual mention, gate
    # listing, an overlapping delivery) shows as a live run with no verdict
    # and no marker comment yet; posting on top of it opens a second
    # same-head review row. Error outcomes stay retryable: the reconciler owns
    # the one-retry path for those heads.
    fresh_runs = paginate("/commits/%s/check-runs" % head_sha, key="check_runs")
    if any(review_dedup.check_run_suppresses(r.get("name"), r.get("status"), r.get("conclusion"))
           for r in fresh_runs):
        notice("a Paperclip Review run already covers head %s; one review per head"
               % head_sha[:12])
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
