#!/usr/bin/env python3
"""Review-trigger decision gate.

Paperclip Review is the FINAL review and runs exactly once per ready head:
on `ci-ok` success, for a non-draft PR whose template checklist is complete,
request one review of that exact head. Drafts and already-reviewed heads are
never re-requested. Release-please PRs are auto-invoked (they stalled the TWO
bot release for hours when they waited on a manual trigger). Risky paths are
always reviewed (risk routing merged in: security boundary, flagged
risk, over N lines, plus a deterministic 10% audit sample).

No model call, no network, no credentials: pure stdlib decision logic so the
workflow step and the unit tests share one implementation. The design must not
depend on Claude or Codex (owner constraint 2026-10-09): deterministic checks
first, then Muse as the reviewer.

Usage from the workflow: build the JSON input (see `decide()`) and call
`review_trigger.py decide < input.json`, which prints `request|skip <reason>`.
Exit 0 on a well-formed decision, exit 2 on malformed input (fail closed).
"""

import hashlib
import json
import re
import sys

# One review per ready head is enforced by skipping any head that already
# carries a success/failure Paperclip Review verdict. Incomplete runs
# (action_required, cancelled, timed_out, stale, in-progress) never block a
# re-request: under gateway outages the reviewer submits complete=false as
# action_required, and gating that head permanently would need a new push to
# recover with no re-request path.
REVIEW_CHECK_NAME = "Paperclip Review"
REVIEWED_CONCLUSIONS = frozenset({"success", "failure"})

# Release-please PRs are authored by github-actions[bot] on release-please/*
# branches (measured on two-web-next: every bot release PR). Either signal
# auto-invokes; both are checked because forks/renames change one at a time.
RELEASE_AUTHOR = "github-actions[bot]"
RELEASE_BRANCH_PREFIX = "release-please"

# Initial N for the "over N changed lines" rule, borrowed from the
# Greptile evaluation selection bound (at most 600 changed lines,
# reviewer evaluation bounds). Tune from merged-PR data, not by feel.
LARGE_DIFF_LINES = 600

# Risky paths: security boundary, secrets, migrations, infra/workflows.
# Matched case-insensitively against changed file paths. Keep narrow: every
# entry must name a privilege, credential, migration or merge-blocking
# mechanism. Anything else is reviewed under the normal ready-head rule.
RISKY_PATH_PATTERNS = (
    r"auth",
    r"permis",
    r"secret",
    r"credential",
    r"token",
    r"migrat",
    r"sudoers",
    r"rbac",
    r"allowlist",
    r"\.github/workflows/",
    r"protection-rule/",
    r"host-ops/",
    r"systemd",
    r"provision",
    r"broker",
    r"deploy",
    r"runner",
    r"garm",
    r"coolify",
    r"backup",
    r"quota",
    r"billing",
    r"policy",
)

_RISKY = re.compile("|".join("(?:%s)" % p for p in RISKY_PATH_PATTERNS), re.I)

# Labels that flag Tier-0/Tier-1 risk (tier-flagged
# risk"). Matched case-insensitively against PR label names.
RISK_LABELS = re.compile(r"risk|secur|tier.?[01]", re.I)

# The six judgment boxes in .github/pull_request_template.md, keyed by short
# stable phrases (not line numbers: wording edits must not silently un-gate).
CHECKLIST_ITEMS = (
    "thinking path",
    "named the model",
    "duplicate or related prs",
    "ran the tests locally",
    "added or updated tests",
    "updated the documentation",
)

_COMMENT = re.compile(r"<!--.*?-->", re.S)
_BOX = re.compile(r"^\s*[-*]\s*\[\s*([ xX])\s*\]\s*(.+?)\s*$")


def strip_comments(text):
    return _COMMENT.sub("", text or "")


def checklist_status(body):
    """Return (complete: bool, missing: [str]) for the template checklist.

    Complete means every CHECKLIST_ITEMS phrase appears in a ticked box.
    Bodies on the older template (machine-verifiable boxes like "CI
    is green on the exact head") are reported incomplete with a migration
    note: those boxes are owned by the readiness handler now, never by hand.
    """
    boxes = []
    for line in strip_comments(body).splitlines():
        m = _BOX.match(line)
        if m:
            boxes.append((m.group(1).lower() == "x", m.group(2).lower()))
    if not boxes:
        return False, ["no checklist boxes found"]
    missing = []
    for item in CHECKLIST_ITEMS:
        if not any(ticked and item in text for ticked, text in boxes):
            missing.append(item)
    return (not missing), missing


def is_risky(changed_files, labels, additions=0, deletions=0):
    """Return (risky: bool, reasons: [str]) per the risk routing."""
    reasons = []
    hits = sorted({f for f in (changed_files or []) if _RISKY.search(f)})
    if hits:
        reasons.append("risky paths: %s" % ", ".join(hits[:5]))
    risky_labels = sorted({l for l in (labels or []) if RISK_LABELS.search(l)})
    if risky_labels:
        reasons.append("risk labels: %s" % ", ".join(risky_labels))
    total = (additions or 0) + (deletions or 0)
    if total > LARGE_DIFF_LINES:
        reasons.append("large diff: %d lines (> %d)" % (total, LARGE_DIFF_LINES))
    return (bool(reasons), reasons)


def is_release_please(author, head_ref):
    return author == RELEASE_AUTHOR or (head_ref or "").startswith(
        RELEASE_BRANCH_PREFIX
    )


def in_audit_sample(head_sha):
    """Deterministic 10% audit sample: sha256(head) mod 10 == 0.

    Hash-based, not random-per-run, so re-evaluating a head never flips the
    verdict and offline tests can pin both outcomes by SHA.
    """
    if not head_sha:
        return False
    digest = hashlib.sha256(head_sha.encode()).hexdigest()
    return int(digest[:8], 16) % 10 == 0


def already_reviewed_on_head(check_runs, head_sha):
    """True when a success/failure Paperclip Review verdict exists on this head."""
    for run in check_runs or []:
        if run.get("name") != REVIEW_CHECK_NAME:
            continue
        if head_sha and run.get("head_sha") and run["head_sha"] != head_sha:
            continue
        if run.get("status") == "completed" and run.get("conclusion") in REVIEWED_CONCLUSIONS:
            return True
    return False


def decide(payload):
    """Return (action, reason). Action is 'request' or 'skip', never empty.

    Precedence (first match wins):
      draft -> already-reviewed head -> ci-ok red -> release-please ->
      risky -> checklist -> audit sample -> ready head.
    Risky and release-please heads need ci-ok green but not the checklist:
    the review itself records the missing boxes as findings. Everything else
    waits for a complete checklist so the reviewer stays the final check.
    """
    is_draft = bool(payload.get("is_draft"))
    ci_ok_green = bool(payload.get("ci_ok_green"))
    head_sha = payload.get("head_sha") or ""
    short = head_sha[:12] or "unknown"

    if is_draft:
        return "skip", "draft PRs are never reviewed"

    if already_reviewed_on_head(payload.get("check_runs"), head_sha):
        return "skip", "head %s already has a completed Paperclip Review" % short

    if not ci_ok_green:
        return "skip", "ci-ok is not green on head %s" % short

    author = payload.get("author") or ""
    head_ref = payload.get("head_ref") or ""
    if is_release_please(author, head_ref):
        return "request", "release-please auto-invoke on head %s" % short

    risky, reasons = is_risky(
        payload.get("changed_files"),
        payload.get("labels"),
        payload.get("additions", 0),
        payload.get("deletions", 0),
    )
    if risky:
        return "request", "risky PR (%s) on head %s" % ("; ".join(reasons), short)

    complete, missing = checklist_status(payload.get("body") or "")
    if not complete:
        return "skip", "checklist incomplete (%s)" % "; ".join(missing)

    if in_audit_sample(head_sha):
        return "request", "10pct audit sample on head %s" % short

    return "request", "ready head %s: ci-ok green, checklist complete" % short


def main(argv):
    if len(argv) != 2 or argv[1] != "decide":
        print("usage: review_trigger.py decide < input.json", file=sys.stderr)
        return 2
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        print("refused: input is not JSON: %s" % e, file=sys.stderr)
        return 2
    if not isinstance(payload, dict):
        print("refused: input must be a JSON object", file=sys.stderr)
        return 2
    action, reason = decide(payload)
    print("%s %s" % (action, reason))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
