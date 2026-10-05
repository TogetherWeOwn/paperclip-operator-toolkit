#!/usr/bin/env python3
# ===========================================================================
# process_lost_probe.py — passive, recorded-run process_lost burst evidence.
# Two recorded incidents (a pipe-break crash and a spawner memory exhaustion)
# both reaped in-flight runs as `process_lost` when the server restarted
# without a drain.
#
# The errorCode identifies a crash reaping, never the cause: both crash shapes
# present identically here. A burst is coincidence in reap time, not a
# diagnosis of which crash recurred. No verdict authorizes a credential,
# model-pin, deployment or recovery change; recovery stays with the owning
# recovery routine. Phase 1 is read-only and propose-only.
#
# Exits: 0 clean (silent), 1 invalid input, 2 RECURRENCE, 3 INSUFFICIENT.
# No gateway requests; the optional API path only GETs heartbeat history.
# ===========================================================================

import argparse
import json
import math
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

BURST_GAP_MINUTES = 15

EXIT_SILENT = 0
EXIT_USAGE = 1
EXIT_RECURRENCE = 2
EXIT_INSUFFICIENT = 3

PROCESS_LOST_CODE = "process_lost"

# Corroboration only: the code is authoritative. The canonical message
# reads "Process lost -- server may have restarted".
CANONICAL_MESSAGE_SIG = "process lost"


def parse_ts(value):
    """Parse an API timestamp to an aware UTC datetime, or None."""
    if not value:
        return None
    text = str(value).strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def observed_at(run):
    """Place reap outcomes at finishedAt, falling back to createdAt."""
    return parse_ts(run.get("finishedAt")) or parse_ts(run.get("createdAt"))


def error_text(run):
    value = run.get("error")
    return value.lower() if isinstance(value, str) else ""


def is_process_lost(run):
    """The errorCode is the signal; the message only corroborates.

    A row carrying the canonical message under a different errorCode is a
    different phenomenon and stays out of scope.
    """
    return run.get("errorCode") == PROCESS_LOST_CODE


def run_issue(run):
    snap = run.get("contextSnapshot")
    if isinstance(snap, dict):
        issue = snap.get("issueId") or snap.get("taskId")
        if isinstance(issue, str) and issue:
            return issue
    return None


def group_bursts(lost, gap_minutes):
    """Split time-ordered process_lost rows into bursts on reap time."""
    gap = timedelta(minutes=gap_minutes)
    bursts = []
    for run in lost:
        stamp = observed_at(run)
        if bursts and stamp - observed_at(bursts[-1][-1]) < gap:
            bursts[-1].append(run)
        else:
            bursts.append([run])
    return bursts


def describe(burst):
    first = observed_at(burst[0])
    last = observed_at(burst[-1])
    statuses = {}
    for run in burst:
        statuses[run.get("status") or "-"] = \
            statuses.get(run.get("status") or "-", 0) + 1
    return {
        "size": len(burst),
        "first_reaped": first.isoformat().replace("+00:00", "Z"),
        "last_reaped": last.isoformat().replace("+00:00", "Z"),
        "duration_minutes": round((last - first).total_seconds() / 60.0, 1),
        "agents": sorted({r.get("agentId") for r in burst if r.get("agentId")}),
        "issues": sorted({i for r in burst
                          for i in [run_issue(r)] if i}),
        "statuses": statuses,
        "canonical_message_rows": sum(
            1 for r in burst if CANONICAL_MESSAGE_SIG in error_text(r)),
    }


def probe(runs, since=None, gap_minutes=BURST_GAP_MINUTES):
    if gap_minutes <= 0:
        raise ValueError("gap must be positive")
    # Dateless rows can be neither placed in the window nor excluded from
    # it, so they are counted separately and can never silently pass.
    dateless_lost = [r for r in runs
                     if observed_at(r) is None and is_process_lost(r)]
    usable = [r for r in runs if observed_at(r) is not None]
    if since is not None:
        usable = [r for r in usable if observed_at(r) >= since]
    usable.sort(key=observed_at)
    dated_lost = [r for r in usable if is_process_lost(r)]
    bursts = [describe(b) for b in group_bursts(dated_lost, gap_minutes)]
    bursts.sort(key=lambda b: b["first_reaped"])
    if bursts:
        verdict = "RECURRENCE"
    elif dateless_lost:
        # process_lost rows exist but none carries a readable timestamp:
        # unknown, never a silent pass.
        verdict = "INSUFFICIENT"
    else:
        verdict = "SILENT"
    return {
        "verdict": verdict,
        "bursts": bursts,
        "runs_considered": len(usable),
        "process_lost_rows": len(dated_lost) + len(dateless_lost),
        "dateless_process_lost_rows": len(dateless_lost),
    }


def worst_exit(result):
    return {"SILENT": EXIT_SILENT,
            "RECURRENCE": EXIT_RECURRENCE,
            "INSUFFICIENT": EXIT_INSUFFICIENT}[result["verdict"]]


def unpack_runs(payload):
    if isinstance(payload, dict):
        payload = payload.get("runs", payload.get("items"))
    if not isinstance(payload, list) or \
            any(not isinstance(r, dict) for r in payload):
        raise ValueError("expected a run list or an object with runs/items")
    return payload


def fetch_runs(api_url, api_key, company_id, limit):
    base = api_url.rstrip("/")
    if base.endswith("/api"):
        base = base[:-4]
    # NOTE: the endpoint caps at the newest-1000 rows and ignores
    # offset/cursor/filter params, so live history older than ~2h is not
    # reachable here. Deep history comes from recorded incident evidence
    # (both recorded crash shapes), not from raising this limit.
    url = f"{base}/api/companies/{company_id}/heartbeat-runs?limit={limit}"
    req = urllib.request.Request(url,
                                 headers={"Authorization": f"Bearer {api_key}"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return unpack_runs(json.load(resp))


def render(result, stream):
    if result["verdict"] == "SILENT":
        print(f"no process_lost rows among {result['runs_considered']} "
              f"runs considered", file=stream)
        return
    for b in result["bursts"]:
        print(f"RECURRENCE: {b['size']} process_lost run(s) reaped "
              f"{b['first_reaped']} -> {b['last_reaped']} "
              f"({b['duration_minutes']}m) across {len(b['agents'])} "
              f"agent(s)", file=stream)
        print(f"  statuses: {json.dumps(b['statuses'], sort_keys=True)}; "
              f"canonical-message rows: "
              f"{b['canonical_message_rows']}/{b['size']}", file=stream)
    print("  -> a reap burst means the server restarted without a drain. "
          "Attribute the crash from host evidence, not from these rows.",
          file=stream)
    print("  -> propose-only: no recovery, reset or redeploy is authorized "
          "by this output. Recovery stays with the owning recovery routine.",
          file=stream)
    if result.get("dateless_process_lost_rows"):
        print(f"  -> {result['dateless_process_lost_rows']} process_lost "
              f"row(s) carry no readable timestamp; they are unknown, "
              f"not evidence for or against a burst.", file=stream)


def main():
    p = argparse.ArgumentParser(description="Classify recorded-run "
                                "process_lost bursts using passive "
                                "heartbeat-run evidence only.")
    p.add_argument("--input", help="JSON file, or - for stdin; else read API")
    p.add_argument("--api-url", default=None)
    p.add_argument("--company-id", default=None)
    p.add_argument("--limit", type=int, default=200)
    p.add_argument("--since", help="only consider runs at/after this time")
    p.add_argument("--window-hours", type=float, default=None)
    p.add_argument("--now", help="override current UTC time (testing)")
    p.add_argument("--gap-minutes", type=int, default=BURST_GAP_MINUTES)
    p.add_argument("--json", action="store_true")
    args = p.parse_args()

    try:
        if args.gap_minutes <= 0 or args.limit <= 0:
            raise ValueError("gap and limit must be positive")
        since = parse_ts(args.since) if args.since else None
        now = parse_ts(args.now) if args.now else datetime.now(timezone.utc)
        if (args.since and since is None) or now is None:
            raise ValueError("invalid timestamp")
        if args.window_hours is not None:
            if not math.isfinite(args.window_hours) or args.window_hours <= 0:
                raise ValueError("window hours must be finite and positive")
            edge = now - timedelta(hours=args.window_hours)
            since = max(since, edge) if since else edge

        if args.input == "-":
            runs = unpack_runs(json.load(sys.stdin))
        elif args.input:
            with open(args.input) as fh:
                runs = unpack_runs(json.load(fh))
        else:
            api_url = args.api_url or os.environ.get("PAPERCLIP_API_URL")
            # Credentials only from inherited environment, never argv.
            api_key = os.environ.get("PAPERCLIP_API_KEY")
            company_id = args.company_id or os.environ.get("PAPERCLIP_COMPANY_ID")
            if not (api_url and api_key and company_id):
                raise ValueError(
                    "need --input, or PAPERCLIP_API_URL/API_KEY/COMPANY_ID")
            runs = fetch_runs(api_url, api_key, company_id, args.limit)
        result = probe(runs, since, args.gap_minutes)
    except (ValueError, OSError, urllib.error.URLError, OverflowError):
        # Raw API errors/URLs and input can contain credentials; do not echo.
        print("invalid input or unavailable history; no verdict",
              file=sys.stderr)
        return EXIT_USAGE

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        render(result, sys.stdout)
    return worst_exit(result)


if __name__ == "__main__":
    sys.exit(main())
