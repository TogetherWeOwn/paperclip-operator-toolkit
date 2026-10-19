#!/usr/bin/env python3
"""Release-lag + DORA check for every deployed app.

THE GAP THIS EXISTS FOR. Production once drifted 647 commits / 9 days behind
the default branch and nobody noticed until asked. CI watches each repo's own
main; nothing compares the commit actually serving production against the
newest staging-green candidate, and nothing publishes deploy-health numbers.
This script is the measuring half. A scheduled workflow runs it; the workflow
owns alerting (one deduped issue per app) and the weekly DORA post.

WHAT IT MEASURES, FROM PUBLIC GITHUB DATA ONLY. No Coolify credential, no
private host, no secret of any kind. Per app:

  * live production commit = head SHA of the newest SUCCESSFUL run of the
    app's production-deploy workflow (assumption: that workflow going green
    means the commit is live; each app's deploy workflow is the authority).
  * newest staging-green candidate = head SHA of the newest SUCCESSFUL run
    of the app's staging-signal workflow (staging deploy, or staging E2E).
  * lag alert = candidate exists on a different SHA than production AND the
    candidate has been green longer than `lag_hours` (default 24).
  * stale alert = no successful production deploy in `stale_prod_days`
    (default 7), even with no candidate waiting.

DORA (trailing `dora_window_days`, default 28) from the production-deploy
workflow runs in the window: deploy frequency, median lead time
(commit -> deploy start), change-failure rate, median time to restore.

FAIL-CLOSED RULES, EACH BECAUSE THE SILENT VERSION HIDES A DRIFT:

  1. AN UNREADABLE REPO IS NOT "IN SYNC". A failed fetch marks the app
     `unknown` (measured=false), never `ok`. Exit 2 when nothing was
     measured at all.
  2. EQUAL SHAS ARE OK, NOT LAGGING. A slow clock alone is not drift; the
     alert needs a greener candidate on a different SHA (or a stale prod).
  3. DISCOVERY NEVER SHRINKS THE EXPLICIT LIST. `apps.json` entries always
     survive; org discovery only ADDS repos that ship an enabled
     `deploy-production` workflow, so a discovery outage cannot silence an
     app that was explicitly configured.

Exit status is the verdict, never prose (prose goes to --out / stdout):
  0 every measured app ok, 1 at least one alert fires, 2 nothing measured.

Stdlib only, offline-testable: every verdict function takes plain dicts, and
the test suite drives them from fixtures under test/fixtures/release-lag/.
"""

import argparse
import json
import subprocess
import sys
from datetime import datetime, timedelta, timezone

DEFAULT_LAG_HOURS = 24
DEFAULT_STALE_PROD_DAYS = 7
DEFAULT_DORA_WINDOW_DAYS = 28
PROD_WORKFLOW_BASENAME = "deploy-production"


# --------------------------------------------------------------------------
# timestamps + statistics (pure)
# --------------------------------------------------------------------------

def parse_ts(value):
    """Parse an ISO-8601 timestamp; '' / None / garbage -> None, never raise."""
    if not value or not isinstance(value, str):
        return None
    text = value.strip().replace("Z", "+00:00")
    try:
        moment = datetime.fromisoformat(text)
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment


def median(values):
    """Median of a non-empty list of numbers; None when empty."""
    ordered = sorted(values)
    count = len(ordered)
    if count == 0:
        return None
    middle = count // 2
    if count % 2 == 1:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2.0


def fmt_duration(seconds):
    """Compact human duration: 90 -> '1m', 90000 -> '1d 1h'. None -> 'n/a'."""
    if seconds is None:
        return "n/a"
    total = int(seconds)
    days, total = divmod(total, 86400)
    hours, total = divmod(total, 3600)
    minutes, _ = divmod(total, 60)
    if days:
        return "%dd %dh" % (days, hours)
    if hours:
        return "%dh %dm" % (hours, minutes)
    return "%dm" % minutes


# --------------------------------------------------------------------------
# run-list helpers (pure; runs are plain dicts, see normalize_run)
# --------------------------------------------------------------------------

def normalize_run(raw):
    """Project one GitHub workflow-run object onto the fields we score."""
    head = raw.get("head_commit") or {}
    return {
        "sha": raw.get("head_sha"),
        "head_ts": head.get("timestamp"),
        "created_at": raw.get("created_at"),
        "updated_at": raw.get("updated_at"),
        "status": raw.get("status"),
        "conclusion": raw.get("conclusion"),
        "number": raw.get("id"),
        "url": raw.get("html_url"),
    }


def completed(runs):
    return [r for r in runs if r.get("status") == "completed" and r.get("conclusion")]


def successful(runs):
    return [r for r in runs if r.get("status") == "completed"
            and r.get("conclusion") == "success" and r.get("sha")]


def latest(runs):
    """Newest run by updated_at; runs with unparsable stamps sort last."""
    def key(run):
        moment = parse_ts(run.get("updated_at"))
        return moment if moment is not None else datetime.min.replace(tzinfo=timezone.utc)
    ordered = sorted(runs, key=key)
    return ordered[-1] if ordered else None


# --------------------------------------------------------------------------
# lag verdict (pure)
# --------------------------------------------------------------------------

def evaluate_app(prod_runs, staging_runs, now, lag_hours=DEFAULT_LAG_HOURS,
                 stale_days=DEFAULT_STALE_PROD_DAYS):
    """Score one app. Returns a verdict dict; alert=true means page the board.

    prod_runs / staging_runs are normalized run lists (possibly empty).
    `now` is an aware datetime. Thresholds come from apps.json.
    """
    verdict = {
        "status": "unknown",
        "alert": False,
        "measured": False,
        "prod_sha": None,
        "prod_deployed_at": None,
        "staging_sha": None,
        "staging_green_at": None,
        "lag_hours": None,
        "reason": "no data",
    }
    prod = latest(successful(prod_runs))
    staging = latest(successful(staging_runs))
    if prod is None and not prod_runs and not staging_runs:
        return verdict
    verdict["measured"] = True
    if prod is not None:
        verdict["prod_sha"] = prod.get("sha")
        verdict["prod_deployed_at"] = prod.get("updated_at")
    if staging is not None:
        verdict["staging_sha"] = staging.get("sha")
        verdict["staging_green_at"] = staging.get("updated_at")

    deployed_at = parse_ts(verdict["prod_deployed_at"])
    if prod is None or deployed_at is None or now - deployed_at > timedelta(days=stale_days):
        verdict["status"] = "stale-prod"
        verdict["alert"] = True
        verdict["reason"] = ("no successful production deploy in %d days"
                             % stale_days)
        if staging is not None and staging.get("sha") != verdict["prod_sha"]:
            verdict["reason"] += ("; newer staging-green candidate %s waiting"
                                  % staging.get("sha")[:7])
        return verdict

    green_at = parse_ts(verdict["staging_green_at"])
    if (staging is not None and prod is not None
            and staging.get("sha") != prod.get("sha")
            and green_at is not None
            and now - green_at > timedelta(hours=lag_hours)):
        lag = (now - green_at).total_seconds() / 3600.0
        verdict["status"] = "lagging"
        verdict["alert"] = True
        verdict["lag_hours"] = round(lag, 1)
        verdict["reason"] = ("staging-green %s is %.1fh old, production still on %s"
                             % (staging.get("sha")[:7], lag, prod.get("sha")[:7]))
        return verdict

    verdict["status"] = "ok"
    verdict["reason"] = "production matches newest staging-green candidate"
    return verdict


# --------------------------------------------------------------------------
# DORA (pure)
# --------------------------------------------------------------------------

def compute_dora(prod_runs, now, window_days=DEFAULT_DORA_WINDOW_DAYS):
    """Weekly-deploy-health numbers over the trailing window.

    deploy frequency  = successful prod deploys per week in the window.
    lead time         = median(head commit -> run created) over successes.
    change-fail rate  = non-success / completed in the window.
    time to restore   = median(failed run -> next successful run).
    """
    since = now - timedelta(days=window_days)
    window = [r for r in completed(prod_runs)
              if (parse_ts(r.get("created_at")) or datetime.min.replace(tzinfo=timezone.utc)) >= since]
    successes = [r for r in window if r.get("conclusion") == "success"]
    failures = [r for r in window if r.get("conclusion") != "success"]

    leads = []
    for run in successes:
        made = parse_ts(run.get("head_ts"))
        started = parse_ts(run.get("created_at"))
        if made is not None and started is not None and started >= made:
            leads.append((started - made).total_seconds())

    by_time = sorted(window, key=lambda r: parse_ts(r.get("updated_at"))
                     or datetime.min.replace(tzinfo=timezone.utc))
    success_times = sorted(parse_ts(r.get("updated_at")) for r in successes
                           if parse_ts(r.get("updated_at")) is not None)
    gaps = []
    for run in by_time:
        if run.get("conclusion") == "success":
            continue
        failed_at = parse_ts(run.get("updated_at"))
        if failed_at is None:
            continue
        restores = [t for t in success_times if t > failed_at]
        if restores:
            gaps.append((restores[0] - failed_at).total_seconds())

    med_lead = median(leads)
    med_restore = median(gaps)
    return {
        "window_days": window_days,
        "deploys": len(successes),
        "deploys_per_week": round(len(successes) / (window_days / 7.0), 2),
        "completed": len(window),
        "failed": len(failures),
        "change_fail_rate": round(len(failures) / len(window), 4) if window else None,
        "median_lead_seconds": med_lead,
        "median_restore_seconds": med_restore,
        "incidents": len(gaps),
    }


# --------------------------------------------------------------------------
# discovery merge (pure)
# --------------------------------------------------------------------------

def merge_apps(explicit, discovered):
    """Union explicit config with org discovery; explicit entries always win.

    explicit: list of {"repo", "prod_workflow", "staging_workflow"}.
    discovered: list of {"repo"} repos advertising deploy-production.
    Returns the merged app list; discovery never removes or rewrites config.
    """
    merged = {app["repo"]: dict(app) for app in explicit}
    for found in discovered:
        repo = found.get("repo")
        if not repo or repo in merged:
            continue
        merged[repo] = {
            "repo": repo,
            "prod_workflow": PROD_WORKFLOW_BASENAME,
            "staging_workflow": None,
        }
    return [merged[repo] for repo in sorted(merged)]


def dedupe_key(repo):
    """Board dedupe key for a lag alert; owned here, matched on issue titles."""
    return "release-lag:v1:%s" % repo


# --------------------------------------------------------------------------
# rendering (pure)
# --------------------------------------------------------------------------

def render_check_markdown(results):
    lines = ["# Release-lag check", "",
             "| app | status | production | candidate | detail |",
             "| --- | --- | --- | --- | --- |"]
    for repo in sorted(results):
        verdict = results[repo]
        prod = (verdict["prod_sha"] or "?")[:7]
        cand = (verdict["staging_sha"] or "?")[:7]
        lines.append("| %s | %s | %s | %s | %s |"
                     % (repo, verdict["status"], prod, cand, verdict["reason"]))
    return "\n".join(lines) + "\n"


def render_dora_markdown(results, window_days):
    lines = ["# DORA weekly digest (trailing %d days)" % window_days, "",
             "| app | deploys/wk | median lead | change-fail | median restore |",
             "| --- | --- | --- | --- | --- |"]
    for repo in sorted(results):
        dora = results[repo]
        cfr = ("%.1f%%" % (dora["change_fail_rate"] * 100)
               if dora["change_fail_rate"] is not None else "n/a")
        lines.append("| %s | %s (%d) | %s | %s | %s |"
                     % (repo, dora["deploys_per_week"], dora["deploys"],
                        fmt_duration(dora["median_lead_seconds"]), cfr,
                        fmt_duration(dora["median_restore_seconds"])))
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------
# live GitHub layer (thin; everything above stays offline-testable)
# --------------------------------------------------------------------------

def gh_api(path, per_page=50):
    """GET one GitHub REST path via gh; raises RuntimeError with stderr.

    NOTE: per_page travels in the query string, never via `-f`. gh turns
    `-f` fields into something the list endpoints reject (measured 404 on
    actions/workflows, 2026-10-19); the query-string form paginates cleanly.
    """
    separator = "&" if "?" in path else "?"
    url = "%s%sper_page=%d" % (path, separator, per_page)
    try:
        # No --paginate: it prints one JSON body per page, which is not a
        # single JSON document. One page (max 100 rows) covers every call
        # here: workflow lists, recent runs, and this org's repo inventory.
        proc = subprocess.run(
            ["gh", "api", url],
            capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError("gh api failed: %s" % exc)
    if proc.returncode != 0:
        raise RuntimeError("gh api %s: %s" % (path, proc.stderr.strip()[-500:]))
    try:
        payload = json.loads(proc.stdout or "null")
    except ValueError:
        raise RuntimeError("gh api %s returned non-JSON" % path)
    if isinstance(payload, list):
        return payload
    for key in ("workflow_runs", "workflows", "repositories"):
        if isinstance(payload.get(key), list):
            return payload[key]
    return []


def workflow_id_for(repo, name):
    """Resolve a workflow name or file to its numeric id; None when absent."""
    for workflow in gh_api("repos/%s/actions/workflows" % repo):
        candidates = {str(workflow.get("name", "")).lower(),
                      str(workflow.get("path", "")).split("/")[-1].lower()}
        wanted = str(name or "").lower()
        if wanted in candidates or wanted == str(workflow.get("id")):
            if str(workflow.get("state", "")).lower() != "active":
                return None
            return workflow.get("id")
    return None


def fetch_runs(repo, workflow, limit=50):
    """Newest-first normalized runs for one workflow; [] when unresolvable."""
    if not workflow:
        return []
    wid = workflow_id_for(repo, workflow)
    if wid is None:
        return []
    raw = gh_api("repos/%s/actions/workflows/%s/runs" % (repo, wid),
                 per_page=limit)
    return [normalize_run(run) for run in raw[:limit]]


def discover_repos(org):
    """Org repos advertising an enabled deploy-production workflow."""
    found = []
    for repo in gh_api("orgs/%s/repos" % org, per_page=100):
        full = repo.get("full_name")
        if not full or repo.get("archived"):
            continue
        try:
            if workflow_id_for(full, PROD_WORKFLOW_BASENAME) is not None:
                found.append({"repo": full})
        except RuntimeError:
            continue
    return found


def compare_ahead_by(repo, base_sha, head_sha):
    """Commits head is ahead of base; None when the compare cannot be read."""
    if not base_sha or not head_sha or base_sha == head_sha:
        return 0
    try:
        proc = subprocess.run(
            ["gh", "api", "repos/%s/compare/%s...%s" % (repo, base_sha, head_sha)],
            capture_output=True, text=True, timeout=60)
        if proc.returncode != 0:
            return None
        return json.loads(proc.stdout).get("ahead_by")
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return None


def load_config(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def cmd_check(args):
    now = parse_ts(args.now) or datetime.now(timezone.utc)
    try:
        config = load_config(args.apps)
    except (OSError, ValueError) as exc:
        print("ERROR: cannot read apps config: %s" % exc, file=sys.stderr)
        return 2
    org = config.get("org")
    explicit = config.get("apps", [])
    lag_hours = config.get("lag_hours", DEFAULT_LAG_HOURS)
    stale_days = config.get("stale_prod_days", DEFAULT_STALE_PROD_DAYS)
    try:
        discovered = discover_repos(org) if org and not args.no_discover else []
    except RuntimeError as exc:
        print("ERROR: discovery failed: %s" % exc, file=sys.stderr)
        return 2
    apps = merge_apps(explicit, discovered)
    excluded = set(config.get("exclude", []))
    apps = [a for a in apps if a["repo"] not in excluded]

    results = {}
    measured = 0
    alerted = 0
    for app in apps:
        repo = app["repo"]
        try:
            prod_runs = fetch_runs(repo, app.get("prod_workflow"))
            staging_runs = fetch_runs(repo, app.get("staging_workflow"), limit=10)
        except RuntimeError as exc:
            print("WARN: %s unmeasured: %s" % (repo, exc), file=sys.stderr)
            results[repo] = evaluate_app([], [], now, lag_hours, stale_days)
            continue
        verdict = evaluate_app(prod_runs, staging_runs, now, lag_hours, stale_days)
        if verdict["status"] == "lagging":
            verdict["commits_behind"] = compare_ahead_by(
                repo, verdict["prod_sha"], verdict["staging_sha"])
        verdict["key"] = dedupe_key(repo)
        results[repo] = verdict
        if verdict["measured"]:
            measured += 1
        if verdict["alert"]:
            alerted += 1

    payload = {"now": now.isoformat(), "results": results}
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
    if args.markdown:
        with open(args.markdown, "w", encoding="utf-8") as handle:
            handle.write(render_check_markdown(results))
    print(render_check_markdown(results))
    if measured == 0:
        return 2
    return 1 if alerted else 0


def cmd_dora(args):
    now = parse_ts(args.now) or datetime.now(timezone.utc)
    try:
        config = load_config(args.apps)
    except (OSError, ValueError) as exc:
        print("ERROR: cannot read apps config: %s" % exc, file=sys.stderr)
        return 2
    window = args.window_days or config.get("dora_window_days", DEFAULT_DORA_WINDOW_DAYS)
    results = {}
    for app in config.get("apps", []):
        repo = app["repo"]
        try:
            prod_runs = fetch_runs(repo, app.get("prod_workflow"), limit=100)
        except RuntimeError as exc:
            print("WARN: %s unmeasured: %s" % (repo, exc), file=sys.stderr)
            continue
        results[repo] = compute_dora(prod_runs, now, window)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            json.dump({"now": now.isoformat(), "results": results}, handle, indent=2)
    print(render_dora_markdown(results, window))
    return 0 if results else 2


def main(argv=None):
    parser = argparse.ArgumentParser(description="release-lag + DORA per deployed app")
    parser.add_argument("--apps", default="ops/release-lag/apps.json")
    parser.add_argument("--now", default=None, help="override clock (ISO-8601)")
    parser.add_argument("--no-discover", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)
    check = sub.add_parser("check", help="lag verdict per app")
    check.add_argument("--out", default=None)
    check.add_argument("--markdown", default=None)
    dora = sub.add_parser("dora", help="weekly DORA numbers per app")
    dora.add_argument("--out", default=None)
    dora.add_argument("--window-days", type=int, default=None)
    args = parser.parse_args(argv)
    if args.command == "check":
        return cmd_check(args)
    return cmd_dora(args)


if __name__ == "__main__":
    sys.exit(main())
