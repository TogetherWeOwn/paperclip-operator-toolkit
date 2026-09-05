#!/usr/bin/env python3
# ===========================================================================
# quota_rotation_watch.py — does teamclaude actually stop sending traffic to a
# quota-spent Claude account, and does a second account absorb it? (TOG-425)
#
# WHY THIS IS A SCRIPT AND NOT A PAIR OF EYES
#
# TOG-425 was written as "watch a number until it crosses a threshold, then see
# if the other account moves". Done by hand that is three judgement calls deep
# (which threshold, which field, over what interval) and no two runs would
# answer it the same way. The question has exactly one right method, so it is
# code, and the same jsonl always yields the same verdict.
#
# THE MEASUREMENT, AND WHY IT IS NOT `is_current`
#
# TOG-425 step 2 says to watch `is_current`. MEASURED: that field does not
# track which account is serving. Between 2026-08-24T15:07Z and 16:10Z
# `1856877+Rick7C2@users.noreply.github.com` burned its weekly 0.28 -> 0.38 with `is_current:
# false` the entire time, while `pisnrzrs@two.gg` sat at `is_current: true`
# and burned nothing. A watcher keyed on `is_current` would have reported the
# exact opposite of what happened.
#
# So rotation is measured by BURN DELTA, which cannot lie about where the
# traffic went: across an episode where account A is pinned at or above the
# switch threshold, did A's weekly stop moving, and did some other account's
# start? That is the definition used below.
#
# THE THRESHOLD IS 0.98, NOT 0.95
#
# 0.95 is OUR gate's pause threshold (teamclaude-quota.mjs:136). teamclaude's
# own rotation threshold is `switchThreshold = 0.98`
# (account-manager.js:111,131) and it is what `_isNearQuota` compares against
# (account-manager.js:920,928). Watching 0.95 measures our brake, not their
# rotation. Default here is 0.98; --threshold overrides it.
#
# BOTH BUCKETS COUNT
#
# `_isNearQuota` fires on EITHER the shared 5-hour bucket (line 920) or the
# governing weekly bucket (line 928), through one `>=` against the same
# threshold, feeding one `_isAvailable` gate (line 563). The 5h bucket
# saturates far more often than the weekly one, so it supplies natural
# experiments on a timescale of hours instead of weeks. Default is `both`.
#
# A RUN THAT MEASURED NOTHING MUST NOT READ GREEN
#
# Zero episodes is "never observed", not "rotation works". It exits 4. An
# episode in which the whole fleet was idle proves nothing either -- there was
# no traffic to route -- so it is INCONCLUSIVE_IDLE and never counts as a
# pass. Only an episode with real traffic can confirm or refute.
#
# EXIT CODES
#   0  ROTATED             at least one conclusive episode, all of them rotated
#   2  usage / unreadable input
#   3  NO_ROTATION         a spent account kept taking traffic -- a live defect
#   4  NOT_OBSERVED        no conclusive episode yet; window still open
#   5  EXPIRED             --window-close has passed with nothing conclusive
#   6  UNKNOWN             live feed is stale or invalid; no rotation verdict
#
# Read-only: opens one jsonl. No network, no credential, no mutation.
# ===========================================================================
import argparse
import datetime
import json
import sys

from pacing_verdict import read_verdict_rows

JSONL = "/paperclip/operator-handoff/quota-pacing.jsonl"
UNKNOWN_EXIT = 6

# teamclaude's own account-rotation threshold (account-manager.js:111).
SWITCH_THRESHOLD = 0.98
# Weekly moves in steps of 0.01 in this feed, so anything at or below half a
# step is noise rather than burn.
DEFAULT_EPSILON = 0.005


def parse_ts(s):
    return datetime.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(
        tzinfo=datetime.timezone.utc
    )


def load(path):
    """Return (samples, skipped, raw_rows) from one immutable file read."""
    samples, raw_rows, skipped = [], [], 0
    with open(path) as fh:
        lines = fh.readlines()
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            skipped += 1
            continue
        if not isinstance(r, dict):
            skipped += 1
            continue
        try:
            ts = parse_ts(r["ts"])
        except (KeyError, TypeError, ValueError):
            skipped += 1
            continue
        # Keep every timestamped object in raw_rows so freshness validates the
        # actual newest record before consumer-specific shape filtering.
        raw_rows.append(r)
        accounts = r.get("accounts")
        if not isinstance(accounts, list) or any(
            not isinstance(a, dict) or "name" not in a for a in accounts
        ):
            skipped += 1
            continue
        samples.append(
            {
                "ts": ts,
                "runs": r.get("runs_in_flight"),
                "accounts": {a["name"]: a for a in accounts},
            }
        )
    samples.sort(key=lambda s: s["ts"])
    return samples, skipped, raw_rows


def newest_contiguous_segment(samples, max_gap_minutes=120):
    """Drop pre-outage history from live monitoring, preserving replay mode."""
    if not samples:
        return samples
    floor = 0
    for i in range(len(samples) - 1, 0, -1):
        gap = (samples[i]["ts"] - samples[i - 1]["ts"]).total_seconds() / 60.0
        if gap > max_gap_minutes:
            floor = i
            break
    return samples[floor:]


def episodes_for(samples, name, bucket, threshold):
    """Maximal contiguous index ranges where `name` reads >= threshold on `bucket`.

    A null reading is NEUTRAL: it neither opens nor closes an episode. The feed
    emits `five_hour: null` for a sample or two while a bucket rolls over, and
    treating that as "below threshold" would split one episode into two halves
    that each look too short to judge.
    """
    out, start, last = [], None, None
    for i, s in enumerate(samples):
        row = s["accounts"].get(name)
        val = row.get(bucket) if row else None
        if val is None:
            continue
        if val >= threshold:
            if start is None:
                start = i
            last = i
        elif start is not None:
            out.append((start, last))
            start = None
    if start is not None:
        out.append((start, last))
    return out


def weekly_delta(samples, lo, hi, name):
    a = samples[lo]["accounts"].get(name)
    b = samples[hi]["accounts"].get(name)
    if not a or not b or a.get("weekly") is None or b.get("weekly") is None:
        return None
    return b["weekly"] - a["weekly"]


def judge(samples, lo, hi, spent, epsilon):
    """Classify one exhaustion episode."""
    others = sorted({n for i in range(lo, hi + 1) for n in samples[i]["accounts"]} - {spent})
    spent_d = weekly_delta(samples, lo, hi, spent) or 0.0
    other_ds = {n: (weekly_delta(samples, lo, hi, n) or 0.0) for n in others}
    best = max(other_ds.values()) if other_ds else 0.0

    saw_runs = any(
        (samples[i]["runs"] or 0) > 0 for i in range(lo, hi + 1)
    )
    any_burn = spent_d > epsilon or best > epsilon

    if not saw_runs and not any_burn:
        verdict = "INCONCLUSIVE_IDLE"
    elif spent_d > epsilon:
        verdict = "NO_ROTATION"
    elif best > epsilon:
        verdict = "ROTATED"
    else:
        verdict = "INCONCLUSIVE_NO_TRAFFIC"

    return {
        "spent_account": spent,
        "from": samples[lo]["ts"],
        "to": samples[hi]["ts"],
        "samples": hi - lo + 1,
        "hours": (samples[hi]["ts"] - samples[lo]["ts"]).total_seconds() / 3600.0,
        "spent_weekly_delta": spent_d,
        "other_weekly_delta": other_ds,
        "best_other_delta": best,
        "runs_seen": saw_runs,
        "verdict": verdict,
    }


def main():
    ap = argparse.ArgumentParser(
        description="Did teamclaude rotate away from a quota-spent account? (TOG-425)"
    )
    ap.add_argument("--jsonl", default=JSONL)
    ap.add_argument("--threshold", type=float, default=SWITCH_THRESHOLD,
                    help="teamclaude switchThreshold (default 0.98 -- NOT our 0.95 gate)")
    ap.add_argument("--bucket", choices=("five_hour", "weekly", "both"), default="both")
    ap.add_argument("--min-samples", type=int, default=2,
                    help="ignore episodes shorter than this many samples (default 2)")
    ap.add_argument("--epsilon", type=float, default=DEFAULT_EPSILON,
                    help="burn below this is noise (default 0.005)")
    ap.add_argument("--window-close",
                    help="ISO ts, e.g. 2026-08-29T10:00:00Z; past it, unobserved becomes EXPIRED")
    ap.add_argument("--now", help="override current UTC time (testing)")
    ap.add_argument("--allow-stale", action="store_true",
                    help="offline replay only: bypass the live-feed freshness gate")
    ap.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    args = ap.parse_args()

    try:
        now = parse_ts(args.now) if args.now else datetime.datetime.now(datetime.timezone.utc)
    except ValueError:
        ap.error("--now must be UTC in YYYY-MM-DDTHH:MM:SSZ form")

    try:
        samples, skipped, raw_rows = load(args.jsonl)
    except OSError as e:
        print(f"FATAL: cannot read {args.jsonl}: {e}", file=sys.stderr)
        return 2

    if not args.allow_stale:
        freshness = read_verdict_rows(raw_rows, now=now, source=args.jsonl)
        if not freshness.ok:
            if args.json:
                print(json.dumps({
                    "overall": "UNKNOWN", "exit": UNKNOWN_EXIT,
                    "reason": freshness.reason,
                }, indent=2, sort_keys=True))
            else:
                print("OVERALL: UNKNOWN")
                print(f"  {freshness.reason}")
                print("  No rotation verdict was emitted from an unavailable feed.")
            return UNKNOWN_EXIT
        samples = newest_contiguous_segment(samples)

    if not samples:
        print(f"FATAL: no usable samples in {args.jsonl} "
              f"({skipped} unparseable line(s)) -- this is NOT a pass", file=sys.stderr)
        return 2

    buckets = ("five_hour", "weekly") if args.bucket == "both" else (args.bucket,)
    names = sorted({n for s in samples for n in s["accounts"]})

    found = []
    for bucket in buckets:
        for name in names:
            for lo, hi in episodes_for(samples, name, bucket, args.threshold):
                if hi - lo + 1 < args.min_samples:
                    continue
                ep = judge(samples, lo, hi, name, args.epsilon)
                ep["bucket"] = bucket
                found.append(ep)
    found.sort(key=lambda e: e["from"])

    conclusive = [e for e in found if e["verdict"] in ("ROTATED", "NO_ROTATION")]
    broken = [e for e in conclusive if e["verdict"] == "NO_ROTATION"]

    if broken:
        overall, code = "NO_ROTATION", 3
    elif conclusive:
        overall, code = "ROTATED", 0
    else:
        overall, code = "NOT_OBSERVED", 4
        if args.window_close:
            if now > parse_ts(args.window_close):
                overall, code = "EXPIRED", 5

    if args.json:
        print(json.dumps({
            "overall": overall, "exit": code,
            "samples": len(samples), "skipped_lines": skipped,
            "span": [samples[0]["ts"].strftime("%Y-%m-%dT%H:%M:%SZ"),
                     samples[-1]["ts"].strftime("%Y-%m-%dT%H:%M:%SZ")],
            "threshold": args.threshold, "accounts": names,
            "episodes": [
                {**e,
                 "from": e["from"].strftime("%Y-%m-%dT%H:%M:%SZ"),
                 "to": e["to"].strftime("%Y-%m-%dT%H:%M:%SZ")}
                for e in found
            ],
        }, indent=2, sort_keys=True))
        return code

    print(f"samples={len(samples)}  span {samples[0]['ts']:%Y-%m-%dT%H:%M:%SZ}"
          f" -> {samples[-1]['ts']:%Y-%m-%dT%H:%M:%SZ}"
          + (f"  ({skipped} unparseable line(s) skipped)" if skipped else ""))
    print(f"accounts: {', '.join(names)}")
    print(f"threshold={args.threshold} (teamclaude switchThreshold)  buckets={'+'.join(buckets)}\n")

    if not found:
        print("No account reached the switch threshold in this feed.")
        print("Nothing was measured. This is NOT evidence that rotation works.")
    for e in found:
        print("=" * 78)
        print(f"{e['verdict']}  --  {e['spent_account']} spent on {e['bucket']}")
        print(f"  {e['from']:%Y-%m-%dT%H:%M:%SZ} -> {e['to']:%Y-%m-%dT%H:%M:%SZ}"
              f"   ({e['hours']:.2f}h, {e['samples']} samples, runs_seen={e['runs_seen']})")
        print(f"  spent account weekly delta : {e['spent_weekly_delta']:+.3f}"
              "   (should be ~0 if rotation worked)")
        for n, d in sorted(e["other_weekly_delta"].items()):
            print(f"  other  {n:<24} : {d:+.3f}")

    print("=" * 78)
    print(f"OVERALL: {overall}")
    if overall == "ROTATED":
        print("  A spent account stopped taking traffic and another absorbed it.")
    elif overall == "NO_ROTATION":
        print("  DEFECT: a spent account kept burning. Report with the timestamps above.")
    elif overall == "NOT_OBSERVED":
        print("  No conclusive episode yet. The window is still open -- not a pass.")
    else:
        print("  Window closed with nothing conclusive. Expired, NOT done.")
    return code


if __name__ == "__main__":
    sys.exit(main())
