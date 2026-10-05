#!/usr/bin/env python3
"""model_pin_cleanup.py — provenance-checked, backed-up, no-wake cleanup of
stale router auto-pins.

WHY THIS SCRIPT EXISTS.

The model-selection plugin's labelOnlyPass wrote `assigneeAdapterOverrides`
model pins while the plugin was in advisory mode, bypassing the quota guard.
Measured: hundreds of open cards carry a pin, almost all plugin-authored and
one manual (an explicit high-tier pin). The pins must be removed — but ONLY
the plugin's own stale writes, never a human's pin, and never while the old
writer is still live.

WHY EACH SAFETY PROPERTY IS STRUCTURAL, NOT PROSE.

- Provenance is joined against the per-issue activity log, not guessed from
  the pin value. A plugin pin write lands as TWO row shapes on the card's
  `/activity` feed: a decision row (`Model Selection ... pinned ...`, details
  carry `modelId` and, for re-pins, `from`) and an `issue.updated` row whose
  `details.patch.assigneeAdapterOverrides.adapterConfig.model` is the written
  value. A card is `auto` only if the latest such plugin row exists, no later
  non-plugin override write exists, and the current pin equals the plugin's
  recorded model (or the from-model of a re-pin). Anything else — including
  advisory-only rows (`advisory: true, written: false`, which recorded a
  decision but wrote nothing) and unknown shapes — classifies `manual` and is
  never touched. An allowlist of pin VALUES would rot the day a new model
  ships; the activity join cannot.
- Dry-run is the default. NOTHING mutates unless `--apply` is passed WITH the
  backup file the dry-run wrote, so the exact original overrides always exist
  before the first clear.
- `--apply` refuses unless the plugin writer is quiescent: no plugin pin write
  on ANY card in the last N minutes (default 20). The apply step must not run
  while the old writer is live; the gate deploy card verifies two clean job
  cycles first and the operator runs apply after that.
- The first clear doubles as the no-wake probe: the script snapshots the
  card's wake diagnostics, clears, re-reads, and aborts if a new wake was
  queued for the assignee. A bare field PATCH (no comment, no @-mention)
  creates no wake; this check proves it on the live server instead of
  asserting it.
- Consecutive-failure abort (2) turns a systemic problem (auth, schema,
  server fault) into a stop, not a 260-card blast radius.
- `--restore` re-applies the exact original override from a backup/restore
  file, so every clear is reversible.

MODES.

  python3 scripts/model_pin_cleanup.py
      Dry-run (default): page all open cards, classify pins, write a backup
      JSON of the full `assigneeAdapterOverrides` for each auto candidate,
      print the plan table and counts. Exit 0. No mutation.

  python3 scripts/model_pin_cleanup.py --apply --backup <backup.json>
      Clear overrides one card at a time per the rules above. Requires the
      backup file, the quiescence gate, the no-wake probe on one idle blocked
      card, rate limiting, and writes a restore file. Operator only, after the
      gate deploy card verifies two clean job cycles.

  python3 scripts/model_pin_cleanup.py --restore <backup-or-restore.json>
      Re-apply the exact original overrides. Rate-limited, aborts after 2
      consecutive failures.

Exit codes: 0 success (dry-run report written / apply complete / restore
complete), 1 safety refusal or abort (quiescence, no-wake detected, failure
budget spent — LOUD on stderr), 2 usage or API error (fail loudly, never
silent).

No secrets in output: stdout carries only identifiers, statuses, model ids
and classifications. The backup file holds the full override structure —
`secret_ref` entries are opaque handles, never values — but treat backup
files as sensitive and do not paste them into comments.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import copy
import datetime
import json
import os
import sys
import time
import urllib.error
import urllib.request

PLUGIN_ACTOR_ID = "191a4e31-e618-4e76-921a-7511bcc1c12f"
PLUGIN_KEY = "togetherweown.model-selection"
OPEN_STATUSES = ("todo", "in_progress", "in_review", "blocked")
LIVE_RUN_STATUSES = ("running", "queued")
FAILURE_BUDGET = 2
BACKUP_VERSION = 1
NO_WAKE_SETTLE_SECONDS = 3
FETCH_WORKERS_DEFAULT = 8


class CleanupError(RuntimeError):
    """Loud, fatal, non-safety failure: API error, usage error, I/O error."""


class SafetyRefusal(RuntimeError):
    """Loud safety refusal: quiescence gate, no-wake probe, failure budget."""


# ---------------------------------------------------------------------------
# PURE CORE. No network, no clock reads, no environment — the offline suite
# drives all of this through fixture JSON, and every branch below has a test
# that kills its mutant (e.g. advisory rows must NOT confer provenance).
# ---------------------------------------------------------------------------

def parse_time(value):
    """Parse an ISO-8601 timestamp; return None when unparseable (unknown)."""
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
    except (ValueError, OverflowError):
        return None


def is_plugin_row(row, plugin_actor_id=PLUGIN_ACTOR_ID):
    """A row is the plugin's iff the actor id matches. Actor TYPE is not
    consulted: type labels are display metadata, the actor id is identity."""
    return isinstance(row, dict) and row.get("actorId") == plugin_actor_id


def parse_pin_decision(row):
    """Extract the plugin's recorded model from a pin-decision activity row.

    Returns {"at", "model", "from", "advisory"} or None when the row is not a
    pin decision. `details.modelId`/`details.from` are authoritative; the
    message text is never parsed (one message hardcoded the wrong
    card, so prose is evidence of nothing).
    """
    if not isinstance(row, dict):
        return None
    details = row.get("details")
    if not isinstance(details, dict):
        return None
    action = row.get("action") or ""
    if not isinstance(action, str):
        return None
    if "Model Selection" not in action:
        return None
    lowered = action.lower()
    # "pinned" alone subsumes "re-pinned": the longer form contains the
    # shorter as a substring, so a single check covers all pin word forms.
    is_pin = "pinned" in lowered
    if not is_pin:
        return None
    # Classification rows ("Model Selection classified ...") contain neither
    # "pinned" word form above... guard anyway: no modelId, no provenance.
    model = details.get("modelId")
    if not isinstance(model, str) or not model:
        return None
    from_model = details.get("from")
    if not isinstance(from_model, str) or not from_model:
        from_model = None
    advisory = details.get("advisory") is True and details.get("written") is False
    return {
        "at": parse_time(row.get("createdAt")),
        "model": model,
        "from": from_model,
        "advisory": advisory,
    }


def plugin_write_model(row, plugin_actor_id=PLUGIN_ACTOR_ID):
    """Model value of a plugin `issue.updated` row that wrote overrides, else
    None. The actor check lives INSIDE this function (not just at call sites)
    so a caller can never mistake another agent's override-shaped patch for
    plugin provenance. Secret material never appears here: env entries are
    opaque handles."""
    if not isinstance(row, dict):
        return None
    if not is_plugin_row(row, plugin_actor_id):
        return None
    if row.get("action") != "issue.updated":
        return None
    details = row.get("details")
    if not isinstance(details, dict):
        return None
    patch = details.get("patch")
    if not isinstance(patch, dict):
        return None
    overrides = patch.get("assigneeAdapterOverrides")
    if not isinstance(overrides, dict):
        return None
    config = overrides.get("adapterConfig")
    if not isinstance(config, dict):
        return None
    model = config.get("model")
    return model if isinstance(model, str) and model else None


def touches_overrides(details):
    """Whether an `issue.updated` details blob writes assigneeAdapterOverrides,
    in either the plugin `patch` shape or the agent `changes` shape."""
    if not isinstance(details, dict):
        return False
    patch = details.get("patch")
    if isinstance(patch, dict) and "assigneeAdapterOverrides" in patch:
        return True
    changes = details.get("changes")
    if isinstance(changes, dict) and "assigneeAdapterOverrides" in changes:
        return True
    return False


def current_pin_model(issue):
    """Current pinned model on the card, or None when the card has no pin."""
    if not isinstance(issue, dict):
        return None
    overrides = issue.get("assigneeAdapterOverrides")
    if not isinstance(overrides, dict):
        return None
    config = overrides.get("adapterConfig")
    if not isinstance(config, dict):
        return None
    model = config.get("model")
    return model if isinstance(model, str) and model else None


def classify_pin(issue, activity_rows, plugin_actor_id=PLUGIN_ACTOR_ID):
    """Classify one card's pin. Returns (class, reason, recorded).

    `auto` requires ALL of: a latest non-advisory plugin pin row exists, no
    later non-plugin override write exists, and the current pin equals the
    plugin's recorded model or the from-model of a re-pin. Everything else —
    manual, unknown, unparseable — is `manual` and never touched.
    """
    if not isinstance(activity_rows, list):
        return ("manual", "activity-unavailable", None)
    current = current_pin_model(issue)
    if current is None:
        return ("manual", "no-pin", None)

    decisions = []
    writes = []
    non_plugin_override_at = None
    non_plugin_override_unknown = False
    for row in activity_rows:
        if not isinstance(row, dict):
            continue
        at = parse_time(row.get("createdAt"))
        if is_plugin_row(row, plugin_actor_id):
            decision = parse_pin_decision(row)
            if decision is not None and not decision["advisory"]:
                # Advisory rows recorded a decision but wrote NOTHING; they
                # must never confer provenance (killed by test).
                decisions.append(decision)
            written = plugin_write_model(row, plugin_actor_id)
            if written is not None:
                writes.append({"at": at, "model": written})
        else:
            if row.get("action") == "issue.updated" and touches_overrides(
                row.get("details")
            ):
                # An unparseable timestamp cannot be ordered against the plugin
                # rows, so it fails closed: unknown ordering
                # is manual, even when the model matches the plugin's pin.
                if at is None:
                    non_plugin_override_unknown = True
                elif non_plugin_override_at is None or at > non_plugin_override_at:
                    non_plugin_override_at = at

    candidates = []  # (at, model, source)
    for decision in decisions:
        if decision["at"] is not None:
            candidates.append((decision["at"], decision["model"], "decision"))
    for write in writes:
        if write["at"] is not None:
            candidates.append((write["at"], write["model"], "write"))
    if not candidates:
        return ("manual", "no-plugin-pin-row", None)
    candidates.sort(key=lambda entry: entry[0])
    latest_at, latest_model, _ = candidates[-1]

    # Unknown ordering fails closed: a non-plugin override write whose
    # timestamp cannot be parsed cannot be ordered against the plugin rows,
    # so it is manual regardless of the model it carries.
    if non_plugin_override_unknown:
        return ("manual", "non-plugin-override-write-unknown-order", latest_model)
    # Ties fail closed: a non-plugin override write stamped at the SAME instant
    # as the latest plugin row cannot be ordered after it, so it is manual.
    if (
        non_plugin_override_at is not None
        and non_plugin_override_at >= latest_at
    ):
        return ("manual", "later-non-plugin-override-write", latest_model)

    recorded = {latest_model}
    latest_from = None
    for decision in decisions:
        if decision["at"] == latest_at and decision["from"]:
            latest_from = decision["from"]
            recorded.add(decision["from"])
    if current not in recorded:
        return ("manual", "pin-model-mismatch", latest_model)
    return ("auto", "plugin-provenance", latest_model)


def card_live_reason(issue, runs):
    """Why a card must be skipped, or None when it may proceed. A card with
    `executionRunId` set has a live run now; an in_progress card with a
    running/queued run in its run list is skipped too (the run list is the
    implementable proxy for 'the assignee has a running run': agent
    runtime-state is not readable from this principal, and the card's own runs
    are the ones a pin clear could disturb)."""
    if not isinstance(issue, dict):
        return "unknown-issue-shape"
    if issue.get("executionRunId"):
        return "live-execution-run"
    if issue.get("status") == "in_progress" and isinstance(runs, list):
        for run in runs:
            if isinstance(run, dict) and run.get("status") in LIVE_RUN_STATUSES:
                return "assignee-running-run"
    return None


def build_plan_row(issue, activity_rows, runs_rows,
                     plugin_actor_id=PLUGIN_ACTOR_ID):
    """One plan row for a single card, or None when it carries no pin. Pure;
    shared by build_plan and the progressive dry-run so the class on a
    progress line is byte-identical to the class in the final table."""
    if not isinstance(issue, dict):
        return None
    identifier = issue.get("identifier") or issue.get("id")
    status = issue.get("status")
    current = current_pin_model(issue)
    if current is None:
        return None
    klass, reason, recorded = classify_pin(
        issue, activity_rows, plugin_actor_id
    )
    skip = card_live_reason(issue, runs_rows)
    return {
        "id": issue.get("id"),
        "identifier": identifier,
        "status": status,
        "model": current,
        "class": klass,
        "reason": reason,
        "recordedModel": recorded,
        "skip": skip,
        "candidate": klass == "auto" and skip is None,
    }


def build_plan(cards, activity_by_id, runs_by_id, plugin_actor_id=PLUGIN_ACTOR_ID):
    """Pure plan builder: every open pinned card -> row with class + skip."""
    plan = []
    for issue in cards:
        if not isinstance(issue, dict):
            continue
        row = build_plan_row(
            issue,
            activity_by_id.get(issue.get("id"), []),
            runs_by_id.get(issue.get("id"), []),
            plugin_actor_id,
        )
        if row is not None:
            plan.append(row)
    return plan


def plan_counts(plan):
    """Aggregate counts for the dry-run report."""
    counts = {
        "pinned": len(plan),
        "auto": 0,
        "manual": 0,
        "candidates": 0,
        "skipped_live": 0,
        "by_model": {},
        "by_reason": {},
    }
    for row in plan:
        counts["auto" if row["class"] == "auto" else "manual"] += 1
        if row["candidate"]:
            counts["candidates"] += 1
        if row["skip"] is not None:
            counts["skipped_live"] += 1
        counts["by_model"][row["model"]] = counts["by_model"].get(row["model"], 0) + 1
        key = row["class"] + ":" + str(row["reason"])
        counts["by_reason"][key] = counts["by_reason"].get(key, 0) + 1
    return counts


def build_backup(plan, cards, generated_at):
    """Backup every candidate's FULL original overrides. Secret entries stay
    opaque handles (the API never returns values); the file is still
    sensitive — it can re-pin a fleet — and must not go into comments."""
    by_id = {c.get("id"): c for c in cards if isinstance(c, dict)}
    entries = []
    for row in plan:
        if not row["candidate"]:
            continue
        card = by_id.get(row["id"], {})
        entries.append(
            {
                "id": row["id"],
                "identifier": row["identifier"],
                "status": row["status"],
                "model": row["model"],
                "class": row["class"],
                "overrides": copy.deepcopy(
                    card.get("assigneeAdapterOverrides")
                ),
            }
        )
    return {
        "version": BACKUP_VERSION,
        "generatedAt": generated_at,
        "tool": "scripts/model_pin_cleanup.py",
        "entries": entries,
    }


def recent_plugin_pin_writes(activity_rows, since, plugin_actor_id=PLUGIN_ACTOR_ID):
    """Plugin pin WRITES (actual override writes, not advisory decisions) at
    or after `since`, across cards. Newest-first feed order is NOT assumed;
    every row carries its own timestamp and the window comparison is explicit,
    so a reordered page can only add rows, never hide a recent write inside
    the scanned set."""
    recent = []
    for row in activity_rows:
        if not isinstance(row, dict):
            continue
        if not is_plugin_row(row, plugin_actor_id):
            continue
        if plugin_write_model(row, plugin_actor_id) is None:
            continue
        at = parse_time(row.get("createdAt"))
        if at is not None and at >= since:
            recent.append(row)
    return recent


def unknown_plugin_pin_writes(activity_rows, plugin_actor_id=PLUGIN_ACTOR_ID):
    """Plugin pin-write rows whose timestamp cannot be parsed. These can be
    neither placed inside nor outside the quiescence window, so the gate must
    refuse rather than ignore them (unknown ordering fails
    closed). Separated from `recent_plugin_pin_writes` on purpose: a single
    function that both windows AND refuses would let a caller read the empty
    list as 'quiet'."""
    unknown = []
    if not isinstance(activity_rows, list):
        return unknown
    for row in activity_rows:
        if not isinstance(row, dict):
            continue
        if not is_plugin_row(row, plugin_actor_id):
            continue
        if plugin_write_model(row, plugin_actor_id) is None:
            continue
        if parse_time(row.get("createdAt")) is None:
            unknown.append(row)
    return unknown


def render_plan_table(plan):
    """Human table: identifiers, statuses, models, classes only. Env values
    and override blobs never reach stdout."""
    lines = []
    header = f"{'identifier':<14}{'status':<12}{'model':<42}{'class':<8}skip/reason"
    lines.append(header)
    for row in sorted(plan, key=lambda r: str(r["identifier"])):
        skip = row["skip"] or ""
        lines.append(
            f"{str(row['identifier']):<14}{str(row['status']):<12}"
            f"{str(row['model'])[:41]:<42}{row['class']:<8}"
            f"{skip or row['reason']}"
        )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# LIVE CLIENT. Thin urllib wrapper; every failure raises CleanupError with a
# truncated, secret-free message. No token is ever printed, logged or stored.
# ---------------------------------------------------------------------------

class PaperclipClient:
    def __init__(self, base_url, api_key, company_id, run_id=None):
        base = (base_url or "").rstrip("/")
        if base.endswith("/api"):
            base = base[: -len("/api")]
        if not base or not api_key or not company_id:
            raise CleanupError(
                "PAPERCLIP_API_URL, PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID "
                "must all be set for live modes."
            )
        self.base = base
        self.key = api_key
        self.company = company_id
        self.run_id = run_id

    def _request(self, method, path, body=None, extra_headers=None):
        data = None
        headers = {"Authorization": "Bearer " + self.key}
        if self.run_id:
            headers["X-Paperclip-Run-Id"] = self.run_id
        if extra_headers:
            headers.update(extra_headers)
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            self.base + path, data=data, headers=headers, method=method
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                payload = response.read().decode("utf-8")
                return json.loads(payload) if payload else {}
        except urllib.error.HTTPError as exc:
            try:
                detail = exc.read().decode("utf-8")[:500]
            except Exception:
                detail = "<unreadable>"
            raise CleanupError(
                f"API {method} {path} failed: HTTP {exc.code}: {detail}"
            ) from exc
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise CleanupError(f"API {method} {path} failed: {exc}") from exc

    def get(self, path):
        result = self._request("GET", path)
        return result

    def patch(self, path, body):
        return self._request("PATCH", path, body)

    def list_all_issues(self, page_size=200, max_pages=10000):
        """Page the whole board (the list endpoint caps rows per call, so a
        single call undercounts) and return open cards. Filtered client-side
        by status so a server filter change can only add work, never silently
        drop cards from the plan."""
        issues = []
        offset = 0
        for _ in range(max_pages):
            page = self.get(
                f"/api/companies/{self.company}/issues"
                f"?limit={page_size}&offset={offset}"
            )
            rows = page if isinstance(page, list) else page.get("issues", [])
            if not rows:
                break
            issues.extend(rows)
            if len(rows) < page_size:
                break
            offset += len(rows)
        else:
            raise CleanupError("issue pagination exceeded max_pages; refusing")
        return [i for i in issues if isinstance(i, dict) and i.get("status") in OPEN_STATUSES]

    def issue_activity(self, issue_id):
        rows = self.get(f"/api/issues/{issue_id}/activity")
        if not isinstance(rows, list):
            raise CleanupError(
                f"GET /api/issues/{issue_id}/activity returned non-list; refusing"
            )
        return rows

    def issue_runs(self, issue_id):
        rows = self.get(f"/api/issues/{issue_id}/runs")
        if not isinstance(rows, list):
            raise CleanupError(
                f"GET /api/issues/{issue_id}/runs returned non-list; refusing"
            )
        return rows

    def wake_diagnostics(self, issue_id):
        return self.get(f"/api/issues/{issue_id}/diagnostics/wakes")

    def scan_company_activity(self, limit=200, max_pages=50):
        """Newest-first company activity scan. Stops early once rows are older
        than the caller's window is the CALLER's job (it owns `since`); this
        just yields bounded pages so an unbounded feed cannot hang the gate."""
        for page_index in range(max_pages):
            rows = self.get(
                f"/api/companies/{self.company}/activity"
                f"?limit={limit}&offset={page_index * limit}"
            )
            if not isinstance(rows, list) or not rows:
                return
            yield rows
            if len(rows) < limit:
                return


def wake_ids(diagnostics):
    """Stable identity set of wake rows for before/after comparison."""
    if not isinstance(diagnostics, dict):
        return set()
    events = diagnostics.get("events")
    if not isinstance(events, list):
        return set()
    ids = set()
    for event in events:
        if not isinstance(event, dict):
            continue
        key = event.get("runId") or event.get("requestedAt")
        if key is not None:
            ids.add((str(event.get("kind")), str(key)))
    return ids


def detect_new_wakes(before, after):
    """Pure before/after wake comparison for the no-wake probe. Returns the
    set of wake identities present after the clear but not before. Keyed on
    stable identities (not counts) so a re-reported row is not a finding."""
    return set(after or set()) - set(before or set())


class FailureBudget:
    """Consecutive-failure abort: 2 systemic failures in a row stop the run.
    A success resets the streak (isolated card faults do not abort a fleet
    run); reaching the budget trips exactly once."""

    def __init__(self, budget=FAILURE_BUDGET):
        if budget < 1:
            raise ValueError("failure budget must be >= 1")
        self.budget = budget
        self.consecutive = 0

    def record_success(self):
        self.consecutive = 0
        return False

    def record_failure(self):
        self.consecutive += 1
        return self.consecutive >= self.budget


def run_budgeted(entries, attempt, label):
    """Run `attempt(entry)` over entries under one FailureBudget. A success
    resets the streak; FAILURE_BUDGET consecutive failures raise
    SafetyRefusal with the partial results attached. Shared by --apply and
    --restore so the reset lives in exactly one place (a second copy is how
    a dropped reset survives untested)."""
    budget = FailureBudget(FAILURE_BUDGET)
    results = []
    for entry in entries:
        try:
            attempt(entry)
            results.append({"id": entry.get("id"),
                            "identifier": entry.get("identifier"),
                            "cleared": True})
            budget.record_success()
        except CleanupError as exc:
            results.append({"id": entry.get("id"),
                            "identifier": entry.get("identifier"),
                            "cleared": False,
                            "error": str(exc)[:300]})
            print(f"{label} FAILED {entry.get('identifier')}: {exc}", file=sys.stderr)
            if budget.record_failure():
                refusal = SafetyRefusal(
                    f"{FAILURE_BUDGET} consecutive {label.lower()} failures; "
                    f"aborting ({len(results)}/{len(entries)} attempted)"
                )
                refusal.partial_results = results
                raise refusal from exc
    return results


def select_probe_card(ordered, live_candidates):
    """Pick the no-wake probe card: the first idle blocked candidate. Fails
    closed (SafetyRefusal) when no blocked candidate exists, so the apply
    never proceeds without the empirical probe."""
    for entry in ordered:
        row = live_candidates.get(entry.get("id"))
        if row is not None and row.get("status") == "blocked":
            return row
    raise SafetyRefusal(
        "no idle blocked candidate exists for the no-wake probe; "
        "refusing --apply (fail closed)"
    )


def clear_pin(client, issue_id):
    """Clear one card's overrides. The response is authoritative: the write
    counts only when the returned row carries null overrides."""
    result = client.patch(
        f"/api/issues/{issue_id}", {"assigneeAdapterOverrides": None}
    )
    if not isinstance(result, dict):
        raise CleanupError(f"PATCH issue {issue_id} returned non-object")
    if result.get("assigneeAdapterOverrides") is not None:
        raise CleanupError(
            f"PATCH issue {issue_id} did not clear overrides "
            f"(response still carries them); refusing to count it"
        )
    return result


def restore_pin(client, issue_id, overrides):
    """Re-apply the exact original override blob, then confirm by re-read."""
    if not isinstance(overrides, dict):
        raise CleanupError(f"restore for issue {issue_id}: backup entry has no overrides object")
    result = client.patch(
        f"/api/issues/{issue_id}",
        {"assigneeAdapterOverrides": copy.deepcopy(overrides)},
    )
    if not isinstance(result, dict):
        raise CleanupError(f"PATCH issue {issue_id} returned non-object")
    current = current_pin_model(result)
    wanted = current_pin_model({"assigneeAdapterOverrides": overrides})
    if current != wanted:
        raise CleanupError(
            f"restore for issue {issue_id}: post-write pin {current!r} "
            f"!= backup pin {wanted!r}"
        )
    return result


def check_quiescence(client, window_minutes, plugin_actor_id, now):
    """Fail loudly unless no plugin pin write landed on any card in the
    window. Scans newest-first and stops at the first page whose OLDEST row
    predates the window — but only trusts that stop when the page actually
    reached the window boundary (a short first page means 'measured nothing',
    which refuses, never passes)."""
    since = now - datetime.timedelta(minutes=window_minutes)
    scanned = 0
    oldest_seen = None
    for page in client.scan_company_activity():
        if not page:
            break
        scanned += len(page)
        for row in page:
            at = parse_time(row.get("createdAt") if isinstance(row, dict) else None)
            if at is not None and (oldest_seen is None or at < oldest_seen):
                oldest_seen = at
        recent = recent_plugin_pin_writes(page, since, plugin_actor_id)
        if recent:
            first = recent[0] if isinstance(recent[0], dict) else {}
            details = first.get("details") if isinstance(first, dict) else None
            identifier = details.get("identifier") if isinstance(details, dict) else None
            raise SafetyRefusal(
                f"plugin pin write detected inside the {window_minutes}-minute "
                f"quiescence window ({len(recent)} on this page"
                f"{', e.g. ' + str(identifier) if identifier else ''}); "
                f"the old writer is still live — refusing --apply"
            )
        # A plugin pin-write row with an unparseable timestamp can be neither
        # placed inside nor outside the window — fail closed (same principle
        # as the classifier's unknown-order rule).
        unknown = unknown_plugin_pin_writes(page, plugin_actor_id)
        if unknown:
            raise SafetyRefusal(
                f"{len(unknown)} plugin pin-write row(s) with unparseable "
                f"timestamps on this page; the writer's recency cannot be "
                f"established — refusing --apply"
            )
        if oldest_seen is not None and oldest_seen < since:
            break
    if scanned == 0:
        raise CleanupError("quiescence gate measured ZERO activity rows; refusing")
    if oldest_seen is None or oldest_seen >= since:
        raise CleanupError(
            "quiescence gate never reached the window boundary "
            f"(scanned {scanned} rows); refusing"
        )
    return scanned


def verify_no_wake(client, card):
    """Empirical no-wake probe on ONE idle blocked card: snapshot wake
    diagnostics, clear the pin, re-read, compare. Returns a record dict.
    Any new wake row, or an unreadable diagnostic, aborts the apply."""
    issue_id = card["id"]
    try:
        before_diag = client.wake_diagnostics(issue_id)
        before = wake_ids(before_diag)
    except CleanupError as exc:
        raise SafetyRefusal(
            f"no-wake probe on {card['identifier']}: cannot read wake "
            f"diagnostics before the clear ({exc}); refusing --apply"
        ) from exc
    clear_pin(client, issue_id)
    time.sleep(NO_WAKE_SETTLE_SECONDS)
    try:
        after_diag = client.wake_diagnostics(issue_id)
        after = wake_ids(after_diag)
    except CleanupError as exc:
        raise SafetyRefusal(
            f"no-wake probe on {card['identifier']}: cannot re-read wake "
            f"diagnostics after the clear ({exc}); refusing --apply"
        ) from exc
    new = detect_new_wakes(before, after)
    record = {
        "card": card["identifier"],
        "id": issue_id,
        "result": "no-new-wake" if not new else "WAKE-DETECTED",
        "wakesBefore": len(before),
        "wakesAfter": len(after),
    }
    if new:
        raise SafetyRefusal(
            f"no-wake probe on {card['identifier']}: {len(new)} new wake "
            f"row(s) after the clear — refusing --apply"
        )
    return record


def fetch_card_feeds(client, pinned, plugin_actor_id=PLUGIN_ACTOR_ID,
                      workers=FETCH_WORKERS_DEFAULT, progress=None):
    """Fetch per-card /activity + /runs with bounded concurrency.

    READ-ONLY path: no rate-limit sleep (that gate applies to MUTATING calls
    only); each call keeps its own timeout inside the client. A per-card
    failure raises CleanupError immediately — a card whose feed cannot be
    read cannot be classified, and guessing would silently change the
    candidate set.

    Returns (activity_by_id, runs_by_id). `progress` is an optional
    callable(done, total, row) invoked after EACH card completes (in
    completion order) with its eagerly-classified plan row. The default
    prints one stderr line per card so a slow run is distinguishable from
    a dead one without polluting --json stdout.
    """
    total = len(pinned)
    if workers < 1:
        raise CleanupError(f"fetch workers must be >= 1 (got {workers})")
    if progress is None:
        print(f"fetching per-card feeds for {total} pinned card(s) "
              f"({min(workers, total or 1)} workers)...",
              file=sys.stderr, flush=True)

        def progress(done, total_count, row):
            if row is None:
                return
            print(f"[{done}/{total_count}] {row['identifier']} "
                  f"class={row['class']} "
                  f"{row['skip'] or row['reason']}",
                  file=sys.stderr, flush=True)

    by_id = {issue["id"]: issue for issue in pinned if isinstance(issue, dict)}
    activity_by_id = {}
    runs_by_id = {}

    def fetch_one(issue):
        return (issue["id"],
                client.issue_activity(issue["id"]),
                client.issue_runs(issue["id"]))

    with concurrent.futures.ThreadPoolExecutor(
            max_workers=min(workers, total or 1)) as pool:
        future_map = {pool.submit(fetch_one, issue): issue for issue in pinned}
        done = 0
        try:
            for future in concurrent.futures.as_completed(future_map):
                issue_id, activity, runs = future.result()
                activity_by_id[issue_id] = activity
                runs_by_id[issue_id] = runs
                done += 1
                progress(done, total,
                         build_plan_row(by_id.get(issue_id), activity, runs,
                                        plugin_actor_id))
        except BaseException:
            for future in future_map:
                future.cancel()
            raise
    return activity_by_id, runs_by_id


def run_dry_run(client, plugin_actor_id, workers=FETCH_WORKERS_DEFAULT,
                progress=None):
    issues = client.list_all_issues()
    pinned = [i for i in issues if current_pin_model(i) is not None]
    activity_by_id, runs_by_id = fetch_card_feeds(
        client, pinned, plugin_actor_id, workers=workers, progress=progress
    )
    plan = build_plan(pinned, activity_by_id, runs_by_id, plugin_actor_id)
    return issues, plan


def utcnow():
    return datetime.datetime.now(datetime.timezone.utc)


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true",
                        help="clear overrides (operator only, after gate deploy verifies two clean cycles)")
    parser.add_argument("--backup", default=None,
                        help="backup JSON required by --apply, or the file --restore re-applies")
    parser.add_argument("--restore", default=None,
                        help="re-apply exact original overrides from a backup/restore file")
    parser.add_argument("--backup-out", default=None,
                        help="where the dry-run writes its backup JSON (default: ./model-pin-cleanup-backup-<ts>.json)")
    parser.add_argument("--restore-out", default=None,
                        help="where --apply writes its restore file (default: ./model-pin-cleanup-restore-<ts>.json)")
    parser.add_argument("--quiet-minutes", type=int, default=20,
                        help="quiescence window for --apply (default 20)")
    parser.add_argument("--rate-limit-seconds", type=float, default=1.0,
                        help="sleep between mutating calls (default 1.0)")
    parser.add_argument("--fetch-workers", type=int, default=FETCH_WORKERS_DEFAULT,
                        help="bounded thread pool for per-card read fetches "
                        f"(default {FETCH_WORKERS_DEFAULT}; reads are not rate-limited)")
    parser.add_argument("--page-size", type=int, default=200)
    parser.add_argument("--plugin-actor-id", default=PLUGIN_ACTOR_ID,
                        help="plugin actor id (override if the plugin was reinstalled)")
    parser.add_argument("--json", action="store_true",
                        help="dry-run: print the machine-readable plan instead of the table")
    args = parser.parse_args(argv)

    if args.restore and args.apply:
        print("error: --restore and --apply are mutually exclusive", file=sys.stderr)
        return 2
    if args.apply and not args.backup:
        print("error: --apply requires --backup <backup.json> from a dry-run", file=sys.stderr)
        return 2
    if args.rate_limit_seconds < 0:
        print("error: --rate-limit-seconds must be >= 0", file=sys.stderr)
        return 2
    if args.fetch_workers < 1:
        print("error: --fetch-workers must be >= 1", file=sys.stderr)
        return 2

    if args.restore:
        return do_restore(args)

    client = PaperclipClient(
        os.environ.get("PAPERCLIP_API_URL"),
        os.environ.get("PAPERCLIP_API_KEY"),
        os.environ.get("PAPERCLIP_COMPANY_ID"),
        os.environ.get("PAPERCLIP_RUN_ID"),
    )

    if not args.apply:
        return do_dry_run(client, args)

    return do_apply(client, args)


def do_dry_run(client, args):
    issues, plan = run_dry_run(client, args.plugin_actor_id,
                               workers=args.fetch_workers)
    counts = plan_counts(plan)
    stamp = utcnow().strftime("%Y%m%dT%H%M%SZ")
    backup_path = args.backup_out or f"model-pin-cleanup-backup-{stamp}.json"
    backup = build_backup(plan, [i for i in issues if current_pin_model(i)], stamp)
    try:
        with open(backup_path, "w", encoding="utf-8") as handle:
            json.dump(backup, handle, indent=2, sort_keys=True)
            handle.write("\n")
    except OSError as exc:
        raise CleanupError(f"cannot write backup {backup_path}: {exc}") from exc

    if args.json:
        print(json.dumps({"counts": counts, "plan": plan, "backup": backup_path}, indent=2, sort_keys=True))
    else:
        print(f"open issues paged: {len(issues)}")
        print(f"open cards carrying a pin: {counts['pinned']}")
        print(f"  auto (plugin-provenance): {counts['auto']}")
        print(f"  manual/unknown (never touched): {counts['manual']}")
        print(f"  clear candidates (auto, no live run): {counts['candidates']}")
        print(f"  skipped (live run): {counts['skipped_live']}")
        print("by model:")
        for model in sorted(counts["by_model"]):
            print(f"  {model}: {counts['by_model'][model]}")
        print("by class:reason:")
        for key in sorted(counts["by_reason"]):
            print(f"  {key}: {counts['by_reason'][key]}")
        print()
        print(render_plan_table(plan))
        print()
        print(f"backup of {len(backup['entries'])} candidate override(s) -> {backup_path}")
        print("dry-run only: nothing was mutated. --apply requires this backup file.")
    return 0


def load_backup_file(path):
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise CleanupError(f"cannot read backup {path}: {exc}") from exc
    if not isinstance(data, dict) or data.get("version") != BACKUP_VERSION:
        raise CleanupError(
            f"backup {path}: unsupported version "
            f"(want {BACKUP_VERSION}); refusing"
        )
    entries = data.get("entries")
    if not isinstance(entries, list):
        raise CleanupError(f"backup {path}: no entries list; refusing")
    return data


def do_apply(client, args):
    backup = load_backup_file(args.backup)
    if not backup["entries"]:
        print("backup holds zero candidates; nothing to do.")
        return 0

    scanned = check_quiescence(client, args.quiet_minutes, args.plugin_actor_id, utcnow())
    print(f"quiescence gate passed: {scanned} activity rows scanned, "
          f"no plugin pin write in the last {args.quiet_minutes} minutes.")

    # Re-derive the live plan so a card that gained a live run (or a human
    # edit) between dry-run and apply is skipped, not cleared.
    _, live_plan = run_dry_run(client, args.plugin_actor_id,
                                workers=args.fetch_workers)
    live_candidates = {row["id"]: row for row in live_plan if row["candidate"]}
    ordered = [e for e in backup["entries"] if e.get("id") in live_candidates]
    dropped = len(backup["entries"]) - len(ordered)
    if dropped:
        print(f"{dropped} backup entr(y/ies) no longer clearable (live run, "
              f"manual re-pin, or pin changed); skipping them.")
    if not ordered:
        print("no candidates remain clearable; nothing to do.")
        return 0

    probe_card = select_probe_card(ordered, live_candidates)
    probe_record = verify_no_wake(client, probe_card)
    print(f"no-wake probe: {probe_record['card']} cleared, "
          f"wakes {probe_record['wakesBefore']} -> {probe_record['wakesAfter']}: "
          f"{probe_record['result']}")

    probe_result = {
        "id": probe_card["id"],
        "identifier": probe_card["identifier"],
        "cleared": True,
        "via": "no-wake-probe",
    }
    rest = [e for e in ordered if e["id"] != probe_card["id"]]

    def attempt(entry):
        time.sleep(args.rate_limit_seconds)
        clear_pin(client, entry["id"])

    try:
        results = [probe_result] + run_budgeted(rest, attempt, "CLEAR")
    except SafetyRefusal as exc:
        results = [probe_result] + list(getattr(exc, "partial_results", []))
        write_restore_file(args, backup, results, probe_record)
        raise
    write_restore_file(args, backup, results, probe_record)
    cleared = sum(1 for r in results if r["cleared"])
    failed = [r for r in results if not r["cleared"]]
    print(f"apply complete: {cleared}/{len(ordered)} cleared.")
    if failed:
        print(f"{len(failed)} failed (see restore file for detail).", file=sys.stderr)
        return 1
    return 0


def write_restore_file(args, backup, results, probe_record):
    stamp = utcnow().strftime("%Y%m%dT%H%M%SZ")
    path = args.restore_out or f"model-pin-cleanup-restore-{stamp}.json"
    payload = {
        "version": BACKUP_VERSION,
        "generatedAt": stamp,
        "tool": "scripts/model_pin_cleanup.py",
        "probe": probe_record,
        "results": results,
        "entries": backup["entries"],
    }
    try:
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.write("\n")
    except OSError as exc:
        raise CleanupError(f"cannot write restore file {path}: {exc}") from exc
    print(f"restore file -> {path}")
    return path


def do_restore(args):
    backup = load_backup_file(args.restore)
    client = PaperclipClient(
        os.environ.get("PAPERCLIP_API_URL"),
        os.environ.get("PAPERCLIP_API_KEY"),
        os.environ.get("PAPERCLIP_COMPANY_ID"),
        os.environ.get("PAPERCLIP_RUN_ID"),
    )
    def attempt(entry):
        time.sleep(args.rate_limit_seconds)
        restore_pin(client, entry["id"], entry.get("overrides"))

    results = run_budgeted(backup["entries"], attempt, "RESTORE")
    restored = sum(1 for r in results if r["cleared"])
    failed = [r["identifier"] or r["id"] for r in results if not r["cleared"]]
    print(f"restore complete: {restored}/{len(backup['entries'])} re-applied.")
    if failed:
        print(f"failed: {', '.join(str(f) for f in failed)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except SafetyRefusal as exc:
        print(f"REFUSED: {exc}", file=sys.stderr)
        raise SystemExit(1)
    except CleanupError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(2)
