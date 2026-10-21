#!/usr/bin/env python3
"""Release-lag + DORA check for every deployed app.

THE GAP THIS EXISTS FOR. Production once drifted 647 commits / 9 days behind
the default branch and nobody noticed until asked. CI watches each repo's own
main; nothing compares the commit actually serving production against the
oldest staging-green candidate still waiting, and nothing publishes
deploy-health numbers.
This script is the measuring half. A scheduled workflow runs it; the workflow
owns alerting (one deduped issue per app) and the weekly DORA post.

PUBLIC EVIDENCE, NOT WORKFLOW HEADS. Promotion workflows select targets
independently of their trigger commit. For configured deploy jobs, the first
pinned checkout's executed git-log result proves the target; the SAME job's
completed_at is its verified deployment completion time. Skipped jobs are not
deployments. Latest production target must also match public serving identity.
Web staging uses its exercised-SHA title plus executed E2E/quality gates; bot
staging uses its target checkout, including pinned workflow dispatches.

Lag requires a staging-green descendant of production waiting >24h. An old
candidate already contained in production is not lag. Stale production means
no successful actual deployment in 7d. Unknown evidence never closes an alert.
As-of semantics: runs completing after the check clock are not-yet-completed,
not unknown, so one mid-check completion cannot poison a decided verdict.

DORA (trailing 28d): actual deployment-job successes/week; median resolved-target
PR merge -> job completion (n/a without merge evidence); failed deployment-job
attempts / all attempts; median failure -> next verified successful deployment.
These are deployment-job proxies, not independently observed service incidents.
Skipped/cancelled/neutral jobs are excluded. Lead sample coverage is reported.

Discovery unions public org repos with explicit inventory for BOTH reports.
An inherited app needs an explicit job/SHA/serving-identity contract before it
can be measured; an unknown contract is visible and red, NEVER silently ok.
Inventory and production histories paginate with bounds that fail closed;
staging pages newest-first successes and stops once the lag boundary is
decided, so high-volume staging histories cannot exhaust the fetch bound.

Exit status: 0 all apps measured ok; 1 measured drift; 2 ANY unknown or discovery
failure (measured drift still syncs its alert). A discovery outage does not stop
checking explicit apps. No secret or private host is required.

Stdlib only, offline-testable: every verdict function takes plain dicts, and
the test suite drives them from fixtures under test/fixtures/release-lag/.
"""

import argparse
import json
import re
import subprocess
import sys
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from datetime import datetime, timedelta, timezone

DEFAULT_LAG_HOURS = 24
DEFAULT_STALE_PROD_DAYS = 7
DEFAULT_DORA_WINDOW_DAYS = 28
PROD_WORKFLOW_BASENAME = "deploy-production"
# Both apps' edges reject the default Python-urllib User-Agent with HTTP 403,
# which would pin every app at unknown. Identify the monitor explicitly.
IDENTITY_USER_AGENT = ("release-lag/1.0 "
                       "(+https://github.com/TogetherWeOwn/paperclip-operator-toolkit)")


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
    """Workflow head is trigger metadata, NEVER a promoted/deployed target."""
    return {
        "sha": None,
        "head_ts": None,
        "created_at": raw.get("created_at"),
        "updated_at": raw.get("updated_at"),
        "status": raw.get("status"),
        "conclusion": raw.get("conclusion"),
        "number": raw.get("id"),
        "attempt": raw.get("run_attempt", 1),
        "event": raw.get("event"),
        "title": raw.get("display_title", ""),
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


def asof_runs(runs, now):
    """Runs completed as of the check clock; future completions are excluded.

    A run whose verified completion lands after `now` finished mid-check (the
    clock was captured before its history fetch). It is treated as
    not-yet-completed, not as an unknown measurement, so one mid-check
    completion cannot poison an otherwise decided verdict. Runs with
    unreadable stamps are kept for the fail-closed paths below.
    """
    kept = []
    for run in runs:
        moment = parse_ts(run.get("updated_at"))
        if moment is not None and moment > now:
            continue
        kept.append(run)
    return kept


# --------------------------------------------------------------------------
# lag verdict (pure)
# --------------------------------------------------------------------------

def evaluate_app(prod_runs, staging_runs, now, lag_hours=DEFAULT_LAG_HOURS,
                 stale_days=DEFAULT_STALE_PROD_DAYS, candidate_ahead="by-time",
                 waiting_since=None, waiting_sha=None):
    """Score one app. Returns a verdict dict; alert=true means page the board.

    prod_runs / staging_runs are normalized run lists (possibly empty).
    `now` is an aware datetime. Thresholds come from apps.json.
    waiting_since/waiting_sha describe the oldest verified staging-green
    candidate ahead of production (collector-supplied); the lag clock starts
    there, not at the newest candidate. A missing or unusable waiting_since
    falls back to the newest candidate's verification time. Runs completing
    after `now` are excluded as not-yet-completed (as-of semantics); only
    genuinely unreadable stamps stay fail-closed unknown.
    """
    prod_runs = asof_runs(prod_runs, now)
    staging_runs = asof_runs(staging_runs, now)
    verdict = {
        "status": "unknown",
        "alert": False,
        "measured": False,
        "prod_sha": None,
        "prod_deployed_at": None,
        "staging_sha": None,
        "staging_green_at": None,
        "waiting_since": None,
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

    # A successful run whose target could not be resolved may supersede the
    # older known deployment. Never score that older SHA as if it were live.
    unresolved = [r for r in completed(prod_runs) if r.get("conclusion") == "success"
                  and not r.get("sha")]
    if unresolved and (prod is None or latest(unresolved + [prod]) in unresolved):
        verdict.update(measured=False, reason="newest production target is unmeasured")
        return verdict

    deployed_at = parse_ts(verdict["prod_deployed_at"])
    # As-of filtering above already excluded future completions; the > now
    # arm stays as defense-in-depth so a clock race still fails closed.
    if prod is not None and (deployed_at is None or deployed_at > now):
        verdict.update(measured=False, reason="invalid production deployment timestamp")
        return verdict
    if prod is None or now - deployed_at > timedelta(days=stale_days):
        verdict.update(status="stale-prod", alert=True,
                       reason="no successful production deploy in %d days" % stale_days)
        return verdict

    green_at = parse_ts(verdict["staging_green_at"])
    # Future greens were excluded as not-yet-completed; only a missing or
    # unreadable as-of candidate stays unknown here.
    if staging is None or green_at is None or green_at > now:
        verdict.update(measured=False, reason="no measured staging-green candidate")
        return verdict

    verdict["status"] = "ok"
    if staging.get("sha") == prod.get("sha") and waiting_sha is None:
        # Newest equality proves nothing when the walk found an older
        # waiting candidate: a pinned dispatch can re-verify the
        # production SHA after that candidate already waited past the
        # threshold. The waiting clock below then drives the verdict.
        verdict["reason"] = "production matches newest staging-green candidate"
        return verdict
    # The pure API supports chronological fixtures; live checks always pass
    # an ancestry result (including None for an unreadable comparison).
    if candidate_ahead == "by-time":
        candidate_ahead = green_at > deployed_at
    if candidate_ahead is None:
        verdict.update(status="unknown", measured=False,
                       reason="candidate ancestry is unmeasured")
        return verdict
    if not candidate_ahead:
        verdict["reason"] = "production contains or is ahead of the staging candidate"
        return verdict
    # The lag clock starts at the oldest undeployed verified candidate: daily
    # staging greens would otherwise keep the newest candidate forever young
    # while production sits on an older commit.
    wait_at = parse_ts(waiting_since) if waiting_since else None
    if wait_at is None or wait_at > now or wait_at > green_at:
        wait_at, waiting_sha = green_at, None
    verdict["waiting_since"] = wait_at.isoformat()
    if now - wait_at > timedelta(hours=lag_hours):
        lag = (now - wait_at).total_seconds() / 3600.0
        if waiting_sha:
            reason = ("oldest undeployed staging-green %s is %.1fh old "
                      "(newest %s), production still on %s"
                      % (waiting_sha[:7], lag, staging.get("sha")[:7], prod.get("sha")[:7]))
        else:
            reason = ("staging-green %s is %.1fh old, production still on %s"
                      % (staging.get("sha")[:7], lag, prod.get("sha")[:7]))
        verdict.update(status="lagging", alert=True, lag_hours=round(lag, 1), reason=reason)
        return verdict
    verdict["reason"] = "newer staging-green candidate is within the lag threshold"
    return verdict


# --------------------------------------------------------------------------
# DORA (pure)
# --------------------------------------------------------------------------

def compute_dora(prod_runs, now, window_days=DEFAULT_DORA_WINDOW_DAYS):
    """Weekly-deploy-health numbers over the trailing window.

    deploy frequency  = successful prod deploys per week in the window.
    lead time         = median(target merge -> verified completion).
    change-fail rate  = failed deployment attempts / all deployment attempts.
    time to restore   = median(failed attempt -> next successful deployment).
    Explicit legacy head_ts fixtures retain their commit -> start proxy.
    Post-now completions are outside the window (as-of, not failures).
    """
    since = now - timedelta(days=window_days)
    attempts = {"success", "failure", "timed_out", "startup_failure"}
    window = [r for r in completed(prod_runs)
              if r.get("conclusion") in attempts
              and since <= (parse_ts(r.get("updated_at"))
                            or datetime.min.replace(tzinfo=timezone.utc)) <= now]
    successes = [r for r in window if r.get("conclusion") == "success"]
    failures = [r for r in window if r.get("conclusion") in attempts - {"success"}]

    leads = []
    for run in successes:
        # Live collectors set merged_at only for an associated merged PR whose
        # merge commit is the resolved target. Legacy normalized fixtures can
        # still supply the older head_ts -> created_at proxy explicitly.
        made = parse_ts(run.get("merged_at") or run.get("head_ts"))
        landed = parse_ts(run.get("updated_at") if run.get("merged_at")
                          else run.get("created_at"))
        if made is not None and landed is not None and landed >= made:
            leads.append((landed - made).total_seconds())

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
        "lead_samples": len(leads),
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
            "prod_workflow": found.get("prod_workflow", PROD_WORKFLOW_BASENAME),
            "staging_workflow": found.get("staging_workflow"),
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
             "Deployment-job proxies, not independently observed service incidents.",
             "Lead is target PR merge to verified completion; n/a means no merge evidence.", "",
             "| app | deploys/wk | median lead | lead samples | change-fail | median restore |",
             "| --- | --- | --- | --- | --- | --- |"]
    for repo in sorted(results):
        dora = results[repo]
        if dora is None:
            lines.append("| %s | unknown | n/a | n/a | n/a | n/a |" % repo)
            continue
        cfr = ("%.1f%%" % (dora["change_fail_rate"] * 100)
               if dora["change_fail_rate"] is not None else "n/a")
        lines.append("| %s | %s (%d) | %s | %d/%d | %s | %s |"
                     % (repo, dora["deploys_per_week"], dora["deploys"],
                        fmt_duration(dora["median_lead_seconds"]), dora["lead_samples"],
                        dora["deploys"], cfr, fmt_duration(dora["median_restore_seconds"])))
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------
# live GitHub layer (thin; everything above stays offline-testable)
# --------------------------------------------------------------------------

def gh_command(*args):
    try:
        proc = subprocess.run(["gh", *args], capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError("gh failed: %s" % exc) from exc
    if proc.returncode:
        raise RuntimeError("gh failed: %s" % proc.stderr.strip()[-500:])
    return proc.stdout


def gh_json(path):
    try:
        return json.loads(gh_command("api", path))
    except ValueError as exc:
        raise RuntimeError("gh api %s returned non-JSON" % path) from exc


def gh_api(path, per_page=100, max_pages=20):
    """Read complete lists, or refuse at the bound; never score a partial page."""
    separator = "&" if "?" in path else "?"
    rows = []
    for page in range(1, max_pages + 1):
        payload = gh_json("%s%sper_page=%d&page=%d" % (path, separator, per_page, page))
        batch = payload if isinstance(payload, list) else None
        if isinstance(payload, dict):
            for key in ("workflow_runs", "workflows", "repositories", "jobs"):
                if isinstance(payload.get(key), list):
                    batch = payload[key]
                    break
        if batch is None:
            raise RuntimeError("gh api %s returned an unexpected list shape" % path)
        rows.extend(batch)
        if len(batch) < per_page:
            return rows
    raise RuntimeError("gh api %s exceeds the %d-page measurement bound" % (path, max_pages))


def workflow_id_for(repo, name):
    """Resolve a workflow name or file to its numeric id; None when absent."""
    for workflow in gh_api("repos/%s/actions/workflows" % repo):
        filename = str(workflow.get("path", "")).split("/")[-1].lower()
        candidates = {str(workflow.get("name", "")).lower(), filename,
                      re.sub(r"\.ya?ml$", "", filename)}
        wanted = str(name or "").lower()
        if wanted in candidates or wanted == str(workflow.get("id")):
            if str(workflow.get("state", "")).lower() != "active":
                return None
            return workflow.get("id")
    return None


def resolve_workflow_id(repo, workflow):
    """Numeric id for a configured workflow; raise when unmeasurable."""
    if not workflow:
        raise RuntimeError("no workflow measurement contract configured")
    wid = workflow_id_for(repo, workflow)
    if wid is None:
        raise RuntimeError("configured workflow %s is absent or disabled" % workflow)
    return wid


def fetch_runs(repo, workflow, since=None, max_pages=10):
    """Complete bounded time window, including successes hidden behind failures."""
    wid = resolve_workflow_id(repo, workflow)
    query = {"branch": "main"}
    if since is not None:
        query["created"] = ">=" + since.isoformat()
    raw = gh_api("repos/%s/actions/workflows/%s/runs?%s"
                 % (repo, wid, urlencode(query)), max_pages=max_pages)
    return [normalize_run(run) for run in raw]


def iter_success_runs(repo, workflow, since=None, per_page=100, max_pages=10):
    """Yield successful runs newest-first, one page at a time.

    The runs API accepts conclusions in its `status` filter, so the server
    (not the client) skips failures. Consumers stop paging once their verdict
    is decided; exhausting max_pages with a full last page raises instead of
    silently truncating, so an undecided walk reports unknown.
    """
    wid = resolve_workflow_id(repo, workflow)
    query = {"branch": "main", "status": "success"}
    if since is not None:
        query["created"] = ">=" + since.isoformat()
    base = "repos/%s/actions/workflows/%s/runs?%s" % (repo, wid, urlencode(query))
    for page in range(1, max_pages + 1):
        payload = gh_json("%s&per_page=%d&page=%d" % (base, per_page, page))
        batch = payload.get("workflow_runs") if isinstance(payload, dict) else None
        if not isinstance(batch, list):
            raise RuntimeError("gh api %s returned an unexpected list shape" % base)
        for raw in batch:
            yield normalize_run(raw)
        if len(batch) < per_page:
            return
    raise RuntimeError("gh api %s exceeds the %d-page measurement bound" % (base, max_pages))


def checkout_sha(log):
    """Resolved ref of the FIRST checkout in our allowlisted deploy jobs.

    Bot jobs check out current tooling a second time. Taking the last hash
    would measure that tooling instead of the deployed target. Require both
    the pinned ref and checkout's executed git-log result to agree. Raw logs
    are never printed or persisted by this detector.
    """
    lines = [re.sub(r"^\d{4}-\d\d-\d\dT[\d:.]+Z ", "", line)
             for line in log.splitlines()]
    in_checkout = False
    ref = None
    for index, line in enumerate(lines):
        if "##[group]Run actions/checkout@" in line:
            if in_checkout:
                break
            in_checkout = True
        if not in_checkout:
            continue
        match = re.fullmatch(r"\s+ref: ([0-9a-f]{40})", line)
        if match:
            ref = match.group(1)
        if re.fullmatch(r"\[command\].*/git log -1 --format=%H", line):
            sha = lines[index + 1] if index + 1 < len(lines) else ""
            if re.fullmatch(r"[0-9a-f]{40}", sha) and sha == ref:
                return sha
            break
        if line.startswith("##[group]Run ") and "actions/checkout@" not in line:
            break
    raise RuntimeError("first deployment checkout has no verified pinned SHA")


def run_jobs(repo, run):
    return gh_api("repos/%s/actions/runs/%s/attempts/%s/jobs"
                  % (repo, run["number"], run["attempt"]))


def resolve_job_run(repo, run, pattern):
    jobs = [job for job in run_jobs(repo, run)
            if re.fullmatch(pattern, job.get("name", ""))]
    if not jobs and run.get("conclusion") in ("startup_failure", "cancelled", "skipped", "neutral"):
        # No job executed, so nothing was deployed; keep the run-level outcome
        # instead of failing the whole app on one non-deployment run.
        return dict(run, sha=None)
    if len(jobs) != 1:
        raise RuntimeError("deployment job contract missing or ambiguous in run %s" % run["number"])
    job = jobs[0]
    measured = dict(run, status=job.get("status"), conclusion=job.get("conclusion"),
                    updated_at=job.get("completed_at"), job_id=job["id"])
    if measured["conclusion"] == "success":
        log = gh_command("api", "--allow-escape-sequences",
                         "repos/%s/actions/jobs/%s/logs" % (repo, job["id"]))
        measured["sha"] = checkout_sha(log)
    return measured


def measure_production(app, runs):
    pattern = app.get("prod_job")
    if not pattern:
        raise RuntimeError("production deployment-job contract is not configured")
    return [resolve_job_run(app["repo"], run, pattern) for run in completed(runs)]


def verify_staging_candidate(app, run, is_first):
    """Verify one successful run against the staging contract.

    Returns the run with its resolved SHA, or None when the run proves no
    green candidate (missing gates, non-success job). Raises only on contract
    breaks: no staging contract, a retitled newest run, or a successful run
    whose deployment job is missing or ambiguous.
    """
    if app.get("staging_source") == "web-e2e-title":
        match = re.fullmatch(r"e2e-staging deploy ([0-9a-f]{40})", run["title"])
        if not match:
            if is_first:
                raise RuntimeError("staging E2E title has no exercised SHA")
            return None
        jobs = run_jobs(app["repo"], run)
        journeys = [j for j in jobs if j.get("name") == "staging-journeys"]
        quality = [j for j in jobs if j.get("name") == "staging-quality / quality"]
        steps = {s.get("name"): s.get("conclusion")
                 for j in quality for s in j.get("steps", [])}
        required = ("Lighthouse performance budgets (mobile, ci/lighthouserc.cjs)",
                    "Lighthouse quality scores (desktop, categories vs ci/quality-budget.json)")
        if (len(journeys) == len(quality) == 1
                and all(j.get("conclusion") == "success" for j in journeys + quality)
                and all(steps.get(name) == "success" for name in required)):
            return dict(run, sha=match.group(1))
        return None
    if app.get("staging_job"):
        measured = resolve_job_run(app["repo"], run, app["staging_job"])
        return measured if measured["conclusion"] == "success" else None
    raise RuntimeError("staging SHA measurement contract is not configured")


def measure_staging(app, runs):
    """Every verified green candidate, newest-first (offline over a list)."""
    if not app.get("staging_source") and not app.get("staging_job"):
        raise RuntimeError("staging SHA measurement contract is not configured")
    candidates = sorted((r for r in completed(runs) if r["conclusion"] == "success"),
                        key=lambda r: parse_ts(r.get("updated_at"))
                        or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    verified = []
    for index, run in enumerate(candidates):
        proven = verify_staging_candidate(app, run, index == 0)
        if proven is not None:
            verified.append(proven)
    return verified


def collect_staging(app, since, now, lag_hours, prod_sha):
    """Lazy staging measurement: page successes newest-first and stop once the
    lag boundary is decided. Returns (candidates, waiting_since, waiting_sha,
    newest_ahead, unknown): candidates are verified newest-first, waiting_*
    describe the oldest verified green ahead of production, newest_ahead is
    the compare result for the newest candidate, and unknown is true when
    ancestry cannot be read. A contained non-dispatch candidate ends the
    walk with an exact boundary; pinned dispatches are verified as
    candidates but never end it, because rollback drills intentionally
    re-verify old targets out of ancestry order. An ahead candidate
    older than the threshold ends the walk with lag proven (reported
    hours are then a lower bound); an unreadable compare, a missing
    contract, or an exhausted paging bound reports unknown, never ok.
    Runs completing after `now` are skipped as not-yet-completed, so a
    mid-check completion never moves the boundary or the newest compare.
    """
    if not app.get("staging_source") and not app.get("staging_job"):
        raise RuntimeError("staging SHA measurement contract is not configured")
    repo = app["repo"]
    candidates, waiting, newest_ahead = [], None, None
    compared = {}
    examined = 0
    for run in iter_success_runs(repo, app.get("staging_workflow"), since):
        if run.get("status") != "completed" or run.get("conclusion") != "success":
            continue
        raw_at = parse_ts(run.get("updated_at"))
        if raw_at is not None and raw_at > now:
            continue
        verified = verify_staging_candidate(app, run, examined == 0)
        examined += 1
        if verified is None:
            continue
        green_at = parse_ts(verified.get("updated_at"))
        if green_at is not None and green_at > now:
            continue
        candidates.append(verified)
        sha = verified.get("sha")
        if (prod_sha, sha) not in compared:
            compared[(prod_sha, sha)] = compare_ahead_by(repo, prod_sha, sha)
        ahead = compared[(prod_sha, sha)]
        if ahead is None:
            return candidates, None, None, None, True
        if len(candidates) == 1:
            newest_ahead = ahead
        if ahead == 0:
            if verified.get("event") == "workflow_dispatch":
                # A pinned dispatch can re-verify the production SHA
                # after an older candidate waited, so it never ends
                # the walk; the scan continues to a non-dispatch
                # boundary or a proven wait.
                continue
            break
        waiting = verified
        green = parse_ts(verified.get("updated_at"))
        if green is not None and now - green > timedelta(hours=lag_hours):
            break
    if waiting is None:
        return candidates, None, None, newest_ahead, False
    return candidates, waiting.get("updated_at"), waiting.get("sha"), newest_ahead, False


def read_live_sha(app):
    url = app.get("prod_url")
    path = app.get("prod_sha_path")
    if not isinstance(url, str) or not url.startswith("https://"):
        raise RuntimeError("public production identity endpoint is not configured")
    if not isinstance(path, str) or not path or any(not key for key in path.split(".")):
        raise RuntimeError("public production identity SHA path is not configured")
    try:
        request = Request(url, headers={"User-Agent": IDENTITY_USER_AGENT})
        with urlopen(request, timeout=20) as response:
            body = response.read(65537)
        if len(body) > 65536:
            raise ValueError("oversized response")
        payload = json.loads(body)
        for key in path.split("."):
            payload = payload[key]
        if not isinstance(payload, str) or not re.fullmatch(r"[0-9a-f]{40}", payload):
            raise ValueError("identity is not a full SHA")
        return payload
    except (OSError, ValueError, KeyError, TypeError) as exc:
        code = getattr(exc, "code", None)
        detail = " (HTTP %s)" % code if code is not None else ""
        raise RuntimeError("public production identity is unmeasured" + detail) from exc


def add_merge_times(repo, runs):
    cache = {}
    for run in successful(runs):
        sha = run["sha"]
        if sha not in cache:
            try:
                prs = gh_api("repos/%s/commits/%s/pulls" % (repo, sha))
                times = [pr.get("merged_at") for pr in prs
                         if pr.get("merge_commit_sha") == sha and pr.get("merged_at")]
                cache[sha] = min(times) if times else None
            except RuntimeError:
                cache[sha] = None
        run["merged_at"] = cache[sha]


def discover_repos(org):
    """Org repos advertising an enabled deploy-production workflow."""
    found = []
    for repo in gh_api("orgs/%s/repos" % org, per_page=100):
        full = repo.get("full_name")
        if not full or repo.get("archived") or repo.get("private"):
            continue
        try:
            if workflow_id_for(full, PROD_WORKFLOW_BASENAME) is not None:
                staging = next((name for name in ("e2e-staging", "deploy-staging")
                                if workflow_id_for(full, name) is not None), None)
                found.append({"repo": full, "staging_workflow": staging})
        except RuntimeError:
            # Preserve an unreadable discovered repo as unknown rather than
            # silently shrinking the inventory during a partial outage.
            found.append({"repo": full})
    return found


def compare_ahead_by(repo, base_sha, head_sha):
    """Commits head is ahead of base; None when the compare cannot be read."""
    if not base_sha or not head_sha:
        return None
    if base_sha == head_sha:
        return 0
    try:
        result = gh_json("repos/%s/compare/%s...%s" % (repo, base_sha, head_sha))
        if result.get("status") in ("behind", "identical"):
            return 0
        ahead = result.get("ahead_by")
        if (result.get("status") == "ahead" and result.get("behind_by") == 0
                and isinstance(ahead, int) and ahead > 0):
            return ahead
    except (RuntimeError, AttributeError):
        pass
    return None


def load_config(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def configured_apps(args, config):
    errors = []
    discovered = []
    if config.get("org") and not args.no_discover:
        try:
            discovered = discover_repos(config["org"])
        except RuntimeError:
            errors.append("org discovery unavailable; explicit apps still checked")
    excluded = set(config.get("exclude", []))
    apps = [app for app in merge_apps(config.get("apps", []), discovered)
            if app["repo"] not in excluded]
    return apps, errors


def collect(args, config, now, window):
    apps, errors = configured_apps(args, config)
    results, dora = {}, {}
    lag_hours = config.get("lag_hours", DEFAULT_LAG_HOURS)
    stale_days = config.get("stale_prod_days", DEFAULT_STALE_PROD_DAYS)
    since = now - timedelta(days=max(window, stale_days, lag_hours / 24) + 1)
    for app in apps:
        repo = app["repo"]
        verdict = evaluate_app([], [], now)
        verdict["key"] = dedupe_key(repo)
        results[repo], dora[repo] = verdict, None
        try:
            prod_runs = asof_runs(
                measure_production(app, fetch_runs(repo, app.get("prod_workflow"), since)), now)
            add_merge_times(repo, prod_runs)
            dora[repo] = compute_dora(prod_runs, now, window)
            prod = latest(successful(prod_runs))
            if prod is None:
                # A stale verdict needs no staging evidence, and the serving
                # check needs a verified target to compare against.
                staging_runs, wait_iso, wait_sha, ahead = [], None, None, None
            else:
                if read_live_sha(app) != prod["sha"]:
                    raise RuntimeError("serving SHA differs from latest verified production target")
                staging_runs, wait_iso, wait_sha, ahead, walk_unknown = collect_staging(
                    app, since, now, lag_hours, prod["sha"])
                if walk_unknown:
                    ahead = None
            # The verdict follows any ahead candidate the scan found, not
            # just the newest one: a contained newest can hide an older
            # waiting candidate behind a pinned dispatch.
            candidate_ahead = (None if ahead is None
                               else (ahead > 0 or wait_sha is not None))
            verdict = evaluate_app(prod_runs, staging_runs, now, lag_hours, stale_days,
                                   candidate_ahead=candidate_ahead,
                                   waiting_since=wait_iso, waiting_sha=wait_sha)
            # A successfully read empty as-of window proves staleness,
            # unlike a failed read (which reaches the exception path).
            if not prod_runs and not staging_runs:
                verdict.update(status="stale-prod", measured=True, alert=True,
                               reason="no successful production deploy in %d days" % stale_days)
            verdict["key"] = dedupe_key(repo)
            behind = ahead
            if wait_sha is not None and behind == 0:
                # The newest compare says contained while an older
                # candidate waits ahead; resolve its distance so the
                # payload stays coherent with a lagging verdict.
                behind = compare_ahead_by(repo, prod["sha"], wait_sha)
            verdict["commits_behind"] = behind
            results[repo] = verdict
        except RuntimeError as exc:
            verdict["reason"] = str(exc)
            print("WARN: %s unmeasured: %s" % (repo, exc), file=sys.stderr)
    return {"now": now.isoformat(), "results": results, "dora": dora,
            "dora_window_days": window, "errors": errors}


def check_exit(payload):
    results = payload["results"]
    if payload.get("errors") or not results or any(not v["measured"] for v in results.values()):
        return 2
    return 1 if any(v["alert"] for v in results.values()) else 0


def write_json(path, payload):
    if path:
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)


def cmd_check(args):
    now = parse_ts(args.now) or datetime.now(timezone.utc)
    config = load_config(args.apps)
    window = config.get("dora_window_days", DEFAULT_DORA_WINDOW_DAYS)
    payload = collect(args, config, now, window)
    write_json(args.out, payload)
    text = render_check_markdown(payload["results"])
    if args.markdown:
        with open(args.markdown, "w", encoding="utf-8") as handle:
            handle.write(text)
    print(text)
    for error in payload["errors"]:
        print("WARN: " + error, file=sys.stderr)
    return check_exit(payload)


def cmd_dora(args):
    if args.from_check:
        payload = load_config(args.from_check)
    else:
        config = load_config(args.apps)
        window = args.window_days or config.get("dora_window_days", DEFAULT_DORA_WINDOW_DAYS)
        payload = collect(args, config, parse_ts(args.now) or datetime.now(timezone.utc), window)
    results = payload["dora"]
    write_json(args.out, {"now": payload["now"], "results": results, "errors": payload["errors"]})
    print(render_dora_markdown(results, payload["dora_window_days"]))
    return 2 if (not results or payload["errors"] or any(v is None for v in results.values())) else 0


def find_open_issue(repo, title_prefix):
    issues = json.loads(gh_command("issue", "list", "--repo", repo, "--state", "open",
                                  "--search", '"%s" in:title' % title_prefix,
                                  "--limit", "100", "--json", "number,title,body"))
    matches = [issue for issue in issues if issue["title"].startswith(title_prefix)]
    if len(matches) > 1:
        raise RuntimeError("multiple open issues match " + title_prefix)
    return matches[0] if matches else None


def sync_alerts(repo, verdicts):
    for app, verdict in sorted(verdicts.items()):
        if not verdict.get("measured") or verdict.get("status") == "unknown":
            continue  # Unknown NEVER closes an existing alert.
        key = dedupe_key(app)
        issue = find_open_issue(repo, "[%s]" % key)
        if verdict.get("alert"):
            state = "key: %s\nprod: %s\ncandidate: %s\nstatus: %s" % (
                key, verdict.get("prod_sha"), verdict.get("staging_sha"), verdict["status"])
            body = ("Production for `%s` is drifting.\n\n%s\n\n```\n%s\n```\n"
                    % (app, verdict["reason"], state))
            if issue is None:
                gh_command("issue", "create", "--repo", repo, "--title",
                           "[%s] Production is behind (%s)" % (key, verdict["status"]), "--body", body)
            elif not all(line in (issue.get("body") or "") for line in state.splitlines()):
                gh_command("issue", "comment", "--repo", repo, str(issue["number"]), "--body", body)
                gh_command("issue", "edit", "--repo", repo, str(issue["number"]), "--body", body)
        elif verdict.get("status") == "ok" and issue is not None:
            gh_command("issue", "close", "--repo", repo, str(issue["number"]),
                       "--reason", "completed", "--comment", "Recovered: " + verdict["reason"])


def publish_digest(repo, text):
    prefix = "[dora-weekly]"
    issue = find_open_issue(repo, prefix)
    if issue is None:
        url = gh_command("issue", "create", "--repo", repo, "--title", prefix + " Deploy health digest",
                         "--body", "Weekly trailing-window deployment metrics from release_lag.py.").strip()
        number = url.rsplit("/", 1)[-1]
        if not number.isdigit():
            raise RuntimeError("issue create did not return an issue URL")
    else:
        number = str(issue["number"])
    gh_command("issue", "comment", "--repo", repo, number, "--body", text)


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
    dora.add_argument("--from-check", default=None, help="reuse the check's inventory and measured histories")
    sync = sub.add_parser("sync", help="sync measured alert verdicts to GitHub issues")
    sync.add_argument("--repo", required=True)
    sync.add_argument("--input", required=True)
    digest = sub.add_parser("publish-digest", help="post an already-rendered weekly digest")
    digest.add_argument("--repo", required=True)
    digest.add_argument("--markdown", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "check":
            return cmd_check(args)
        if args.command == "dora":
            return cmd_dora(args)
        if args.command == "sync":
            sync_alerts(args.repo, load_config(args.input)["results"])
        else:
            with open(args.markdown, encoding="utf-8") as handle:
                publish_digest(args.repo, handle.read())
        return 0
    except (OSError, ValueError, KeyError, RuntimeError) as exc:
        print("ERROR: %s" % exc, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
