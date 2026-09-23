#!/usr/bin/env python3
# ===========================================================================
# auth_denial_discriminator.py — passive, recorded-model auth-burst evidence.
# TOG-4062: the original incident reconstruction mixed models. Its 11 interior
# successes were NOT claude-opus-5, including the claimed same-agent recovery.
# With recovered usage metadata the historical fixture is INSUFFICIENT, not
# INTERMITTENT. See tests/auth-denial-incident-2026-09-22.provenance.md.
#
# Error MESSAGE identifies a denial, never errorCode: adapter_failed also
# covers pre-inference worktree aborts, while auth_unavailable arrived under
# claude_transient_upstream. A terminal status alone proves no lane attempt.
# Controls require a known matching usageJson.model and positive token usage;
# known pre-inference aborts are excluded even if stale usage is attached.
#
# These are bounded observations of outcomes, NOT diagnoses of upstream
# account entitlements. Model metadata cannot identify the serving account,
# credential, fallback route or cause of a failure. No verdict authorizes a
# credential, model-pin or deployment change. ENTITLEMENT is retained as the
# CLI label for a zero-success window with enough controls, not causal proof.
#
# Exits: 0 clean (silent), 1 invalid input, 2 INTERMITTENT, 3 ENTITLEMENT,
# 4 INSUFFICIENT. Severity ranks 3 above 4 above 2, not numeric exit order.
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
MIN_CONTROL_RUNS = 2

EXIT_SILENT = 0
EXIT_USAGE = 1
EXIT_INTERMITTENT = 2
EXIT_ENTITLEMENT = 3
EXIT_INSUFFICIENT = 4

AUTH_DENIAL_SIGNATURES = (
    "auth_unavailable",
    "oauth authentication is currently not allowed",
    "disabled claude subscription access",
    "organization has disabled claude",
)

TERMINAL_STATUSES = ("succeeded", "failed")
PRE_INFERENCE_SIGNATURES = (
    "could not verify worktree",
    "resume was aborted",
    "configuration incomplete",
)


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
    """Place outcomes at finishedAt, falling back to createdAt if absent."""
    return parse_ts(run.get("finishedAt")) or parse_ts(run.get("createdAt"))


def error_text(run):
    value = run.get("error")
    return value.lower() if isinstance(value, str) else ""


def is_auth_denial(run):
    if run.get("status") != "failed":
        return False
    text = error_text(run)
    return any(sig in text for sig in AUTH_DENIAL_SIGNATURES)


def recorded_model(run):
    """Use observed metadata, never current agent configuration or error prose."""
    usage = run.get("usageJson")
    model = usage.get("model") if isinstance(usage, dict) else None
    return model.strip() if isinstance(model, str) and model.strip() else None


def attempted_model(run, model):
    """Positive evidence, not inference from a terminal status or model name.

    Usage is per-run recorded evidence; it is not a request trace. In particular,
    a failed run with usage may have produced tokens BEFORE its terminal error.
    """
    if model is None or recorded_model(run) != model:
        return False
    if any(sig in error_text(run) for sig in PRE_INFERENCE_SIGNATURES):
        return False
    usage = run.get("usageJson") or {}
    return any(
        type(usage.get(key)) in (int, float)
        and math.isfinite(usage[key]) and usage[key] > 0
        for key in ("inputTokens", "outputTokens", "cachedInputTokens")
    )


def group_bursts(denials, gap_minutes):
    """Split time-ordered denials into bursts separated by >= gap_minutes."""
    gap = timedelta(minutes=gap_minutes)
    bursts = []
    for run in denials:
        stamp = observed_at(run)
        if bursts and stamp - observed_at(bursts[-1][-1]) < gap:
            bursts[-1].append(run)
        else:
            bursts.append([run])
    return bursts


def judge(burst, runs, min_control_runs):
    """Judge only strictly interior, same-recorded-model attempted outcomes."""
    first = observed_at(burst[0])
    last = observed_at(burst[-1])
    model = recorded_model(burst[0])
    denial_ids = {id(r) for r in burst}
    denied_agents = {r.get("agentId") for r in burst if r.get("agentId")}

    interior = [
        r
        for r in runs
        if id(r) not in denial_ids
        and r.get("status") in TERMINAL_STATUSES
        and attempted_model(r, model)
        and (observed_at(r) is not None)
        and first < observed_at(r) < last
    ]
    successes = [r for r in interior if r.get("status") == "succeeded"]
    # "Recovery" requires an earlier denial by this agent, not just membership
    # in the burst. It is still a run-level observation, not account identity.
    recovered_agents = sorted({
        r.get("agentId") for r in successes
        if r.get("agentId") in denied_agents
        and any(d.get("agentId") == r.get("agentId")
                and observed_at(d) < observed_at(r) for d in burst)
    })

    if successes:
        verdict = "INTERMITTENT"
    elif len(interior) >= min_control_runs:
        verdict = "ENTITLEMENT"
    else:
        verdict = "INSUFFICIENT"

    return {
        "verdict": verdict,
        "model": model,
        "first_denial": first.isoformat().replace("+00:00", "Z"),
        "last_denial": last.isoformat().replace("+00:00", "Z"),
        "duration_minutes": round((last - first).total_seconds() / 60.0, 1),
        "denials": len(burst),
        "denied_agents": sorted(denied_agents),
        "interleaved_successes": len(successes),
        "control_runs": len(interior),
        "recovered_same_agents": recovered_agents,
        "signatures": sorted({
            sig for r in burst for sig in AUTH_DENIAL_SIGNATURES
            if sig in error_text(r)
        }),
    }


def discriminate(runs, since=None, gap_minutes=BURST_GAP_MINUTES,
                 min_control_runs=MIN_CONTROL_RUNS):
    if min_control_runs < 2 or gap_minutes <= 0:
        raise ValueError("controls must be >=2 and gap must be positive")
    usable = [r for r in runs if observed_at(r) is not None]
    if since is not None:
        usable = [r for r in usable if observed_at(r) >= since]
    usable.sort(key=observed_at)
    # Independent model timelines: a denial on another model must not extend
    # this model's window. Unknown-model denials remain findings but can never
    # acquire controls, even from other unknown-model records.
    by_model = {}
    for r in usable:
        if is_auth_denial(r):
            by_model.setdefault(recorded_model(r), []).append(r)
    bursts = [judge(b, usable, min_control_runs)
              for denials in by_model.values()
              for b in group_bursts(denials, gap_minutes)]
    bursts.sort(key=lambda b: (b["first_denial"], b["model"] or ""))
    return {"bursts": bursts, "runs_considered": len(usable)}


def worst_exit(bursts):
    """ENTITLEMENT outranks INSUFFICIENT outranks INTERMITTENT, not raw exits."""
    exit_for = {
        "ENTITLEMENT": EXIT_ENTITLEMENT,
        "INSUFFICIENT": EXIT_INSUFFICIENT,
        "INTERMITTENT": EXIT_INTERMITTENT,
    }
    severity = {"INTERMITTENT": 0, "INSUFFICIENT": 1, "ENTITLEMENT": 2}
    if not bursts:
        return EXIT_SILENT
    worst = max(bursts, key=lambda b: severity[b["verdict"]])
    return exit_for[worst["verdict"]]


def unpack_runs(payload):
    if isinstance(payload, dict):
        payload = payload.get("runs", payload.get("items"))
    if not isinstance(payload, list) or any(not isinstance(r, dict) for r in payload):
        raise ValueError("expected a run list or an object containing runs/items")
    return payload


def fetch_runs(api_url, api_key, company_id, limit):
    base = api_url.rstrip("/")
    if base.endswith("/api"):
        base = base[:-4]
    url = f"{base}/api/companies/{company_id}/heartbeat-runs?limit={limit}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {api_key}"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return unpack_runs(json.load(resp))


def render(result, stream):
    for b in result["bursts"]:
        print(
            f"{b['verdict']}: {b['denials']} auth denials across "
            f"{len(b['denied_agents'])} agent(s), model={b['model'] or 'unknown'}, "
            f"{b['first_denial']} -> {b['last_denial']} ({b['duration_minutes']}m)",
            file=stream,
        )
        print(
            f"  same-model interleaved successes: {b['interleaved_successes']}"
            f"  (demonstrated control attempts: {b['control_runs']})",
            file=stream,
        )
        if b["recovered_same_agents"]:
            print("  same agent denied then served on the recorded model: "
                  + ", ".join(a[:8] for a in b["recovered_same_agents"]), file=stream)
        if b["verdict"] == "INTERMITTENT":
            print("  -> observed interleaving. Do NOT rotate, re-pin or redeploy; "
                  "record and wait.", file=stream)
        elif b["verdict"] == "ENTITLEMENT":
            print("  -> zero-success window with controls. Investigate; this "
                  "does NOT prove withdrawn access or authorize changes.", file=stream)
        else:
            print("  -> insufficient same-model attempt evidence. Do not "
                  "upgrade to a causal verdict.", file=stream)
        print("  Recorded model is not upstream account/entitlement identity.", file=stream)


def main():
    p = argparse.ArgumentParser(description="Classify recorded-model auth bursts "
                                "using passive heartbeat-run evidence only.")
    p.add_argument("--input", help="JSON file, or - for stdin; otherwise read API")
    p.add_argument("--api-url", default=None)
    p.add_argument("--company-id", default=None)
    p.add_argument("--limit", type=int, default=200)
    p.add_argument("--since", help="only consider runs at/after this UTC time")
    p.add_argument("--window-hours", type=float, default=None)
    p.add_argument("--now", help="override current UTC time (testing)")
    p.add_argument("--gap-minutes", type=int, default=BURST_GAP_MINUTES)
    p.add_argument("--min-control-runs", type=int, default=MIN_CONTROL_RUNS)
    p.add_argument("--json", action="store_true")
    args = p.parse_args()

    try:
        if args.min_control_runs < 2 or args.gap_minutes <= 0 or args.limit <= 0:
            raise ValueError("controls must be >=2; gap and limit must be positive")
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
                raise ValueError("need --input, or PAPERCLIP_API_URL/API_KEY/COMPANY_ID")
            runs = fetch_runs(api_url, api_key, company_id, args.limit)
        result = discriminate(runs, since, args.gap_minutes, args.min_control_runs)
    except (ValueError, OSError, urllib.error.URLError, OverflowError):
        # Raw API errors/URLs and input can contain credentials; do not echo them.
        print("invalid input or unavailable history; no verdict", file=sys.stderr)
        return EXIT_USAGE

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        render(result, sys.stdout)
    return worst_exit(result["bursts"])


if __name__ == "__main__":
    sys.exit(main())
