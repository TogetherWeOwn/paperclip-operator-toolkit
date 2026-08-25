#!/usr/bin/env python3
# ===========================================================================
# quota_burn_derive.py — derive weekly-quota burn from the ACCOUNT-REPORTED
# `weekly` series, and replay the brake ladder over it. (TOG-440, from the
# unversioned TOG-419-burn-derivation.py in the operator handoff channel.)
# ---------------------------------------------------------------------------
# WHY THIS EXISTS, AND WHY IT IS NOT THE PRODUCTION PATH.
#
# `quota_brake.sh` picks a brake level from `ratio = burn / sustainable`.
# Until TOG-440 `burn` was the producer-side `burn_per_day` field in
# quota-pacing.jsonl. That field is not a rate over a window. Measured across a
# 219-sample snapshot of that file, 2026-08-23T18:51:04Z -> 2026-08-25T17:18:13Z
# — the same snapshot every figure in docs/quota-brake.md and in
# quota_brake.sh's own header is taken from, so the three can be reconciled:
#
#   * 2026-08-25 11:59Z -> 14:30Z: `weekly` is FLAT at 0.86 — the account
#     burned NOTHING for two and a half hours — while `burn_per_day` decays
#     0.9568, 0.6383, 0.4788, 0.3827, 0.3190, 0.2733, 0.2392, 0.2126, 0.1914,
#     0.1741, 0.1595. That is a fixed numerator divided by a growing elapsed
#     time, i.e. cumulative-since-an-anchor, not a rate. Ten consecutive
#     samples of pure zero burn were reported as ratios 34.1x down to 5.5x —
#     every one of them LEVEL3 or LEVEL2 on the shipped ladder.
#   * It is also unstable sample to sample: 0.6381 at 09:29Z, 3.8355 at
#     09:44Z, a 6x jump on a `weekly` delta of +0.04.
#   * And it goes NULL under exactly the condition the brake most needs a
#     reading: null on 203 of 438 account-samples (46%), and on 75 of the 219
#     rows NO account had a value at all — the whole 14:45Z-17:00Z tail among
#     others. `pace_ratio` returned empty on every one of those and the brake
#     exited 5 UNKNOWN, so a third of the time it was not braking, it was
#     blind. A brake that cannot read its own input is not braking.
#
# `weekly` is what the account itself reports and what the cap is enforced
# against, so a difference of two `weekly` readings over a known interval IS
# the burn, with no producer logic in between.
#
# This file is the OFFLINE tool: it replays history, sweeps windows and shows
# what the ladder would have selected. `quota_brake.sh` carries its own
# implementation of the same formula in jq because it must run with only bash
# + jq + awk at the point of the write. Two implementations of one formula is
# a drift risk, so `test_quota_burn_derive.sh` §5 runs BOTH over the same
# fixture and fails if they disagree past 1e-6. Drift is a red test, not a
# discovery made during the next incident.
#
# ---------------------------------------------------------------------------
# THE QUANTIZATION FLOOR — the reason the window is 24h and not 12h.
#
# `weekly` is emitted rounded to 0.01. A derived rate over `dt` days therefore
# cannot resolve better than 0.01/dt per day, and each endpoint carries its own
# +/-0.005, so the worst-case error on the rate is 0.01/dt:
#
# Against the snapshot's own last sample (sustainable 0.0270/day), which is
# where `--sweep` reads its irregular real cadence rather than round numbers:
#
#     window   resolution      x sustainable (0.0270/day)      level flips
#      2h      0.1195/day        4.42x   <- coarser than the whole ladder    26
#      6h      0.0399/day        1.48x   <- wider than the LEVEL1 band       15
#     12h      0.0199/day        0.74x                                       17
#     24h      0.0100/day        0.37x   <- resolves the ladder's rung 1     13
#     48h      0.0052/day        0.19x                                       13
#
# The ladder's tightest decision is RELEASE|LEVEL1 at ratio 1.0. Below a 24h
# window the quantization error alone can move a sample across that boundary,
# so a shorter window does not measure faster — it measures noise faster. The
# flip count is the second half of the argument: each level change is a PATCH
# against every brakeable agent, and 2h chatters twice as often as 24h for a
# reading it cannot resolve. `--sweep` prints this table against current data,
# so the numbers above are reproducible rather than quoted.
#
# ---------------------------------------------------------------------------
# RESETS. `weekly` returns to ~0 at `weekly_reset_utc`, so a window spanning a
# reset yields a large NEGATIVE delta and would read as "burning nothing" at
# exactly the moment a fresh week starts. Any drop greater than RESET_DROP
# (default 0.2 — well above the 0.01 rounding jitter that shows up as a -0.01
# step in the real file at 10:44Z) truncates the window at that point. Samples
# before a reset are never mixed with samples after it.
#
# Deterministic: same input file -> same output. No network, no writes, no
# credentials, no clock read. Every "now" is a timestamp from the data.
# ===========================================================================
"""Derive quota burn from the `weekly` series in quota-pacing.jsonl.

    quota_burn_derive.py                      # latest sample per account
    quota_burn_derive.py --series             # replay every sample + ladder
    quota_burn_derive.py --sweep              # window-size / resolution table
    quota_burn_derive.py --json               # machine-readable latest sample
"""
import argparse
import datetime
import json
import sys

JSONL = "/paperclip/operator-handoff/quota-pacing.jsonl"

# `weekly` is emitted rounded to this. Drives the resolution arithmetic; it is
# a property of the producer's output, not a tuning knob.
WEEKLY_QUANTUM = 0.01

# A `weekly` drop larger than this is a week reset, not rounding jitter.
RESET_DROP = 0.2

# The ladder in quota_brake.sh verdict_for(). Kept here so `--series` can show
# what the brake WOULD have done; test_quota_burn_derive.sh §6 pins these
# against the thresholds actually compiled into the shell tool — matching
# numbers with swapped labels would be a silent lie, so the names are pinned in
# order too.
LADDER = ((1.0, "RELEASE"), (2.0, "LEVEL1"), (5.0, "LEVEL2"))
LADDER_TOP = "LEVEL3"

DEFAULT_WINDOW_HOURS = 24.0

# Must track quota_brake.sh's PACE_TARGET default. This tool exists to show what
# the brake WOULD have done, so a default that disagrees with the brake's makes
# every bare `--series` a replay of a ladder nobody runs. Pinned in both
# directions by test_quota_burn_derive.sh §10. 0.90 is a RESERVE of 0.10 sized
# against the brake's reaction lag — TOG-490, derivation in docs/quota-brake.md.
DEFAULT_TARGET = 0.90

# `sustainable` goes non-positive once `weekly` passes the target. That is not
# an error and not a release: quota_brake.sh:435 pins `ratio` to 999 in exactly
# this case, which lands on LEVEL3. Every path here that computes a ratio must
# do the same, or the offline tool goes quiet precisely when the brake is hard
# on. With TARGET=0.90 this is a routine condition late in a hot week, not a
# corner case — on 2026-08-25 it was already true of both accounts.
TARGET_PASSED_RATIO = 999.0


def verdict_for(ratio):
    for bound, name in LADDER:
        if ratio <= bound:
            return name
    return LADDER_TOP


def ratio_for(rate, need):
    """burn / sustainable, with the shell's non-positive guard.

    `quota_brake.sh` pace_ratio(): `ratio: (if $need <= 0 then 999 else ...)`.
    Anything here that divides by `need` must apply the same pin, because a
    passed target is the state the brake reacts to MOST strongly and dropping
    or NaN-ing it reads as "nothing to report". Callers handle `need is None`
    (no days_left, genuinely unmeasurable) before calling this.
    """
    return TARGET_PASSED_RATIO if need <= 0 else rate / need


def parse_ts(s):
    return datetime.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(
        tzinfo=datetime.timezone.utc
    )


def parse_reset(s):
    return datetime.datetime.strptime(s, "%Y-%m-%d %H:%M UTC").replace(
        tzinfo=datetime.timezone.utc
    )


def load(path):
    """Return {account_name: [sample, ...]} ordered by ts, plus the raw rows."""
    rows = []
    for line in open(path):
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue  # a partially-flushed tail line is normal; skip it
    series = {}
    for r in rows:
        ts = parse_ts(r["ts"])
        for a in r.get("accounts", []):
            if a.get("weekly") is None:
                continue
            series.setdefault(a["name"], []).append(
                {
                    "ts": ts,
                    "weekly": a["weekly"],
                    "days_left": a.get("days_left"),
                    "reported_burn": a.get("burn_per_day"),
                    "reported_ratio": a.get("burn_ratio_vs_needed"),
                    "reported_dte": a.get("days_to_exhaustion"),
                    "need": a.get("need_per_day_to_hit_target"),
                    "sustainable": a.get("sustainable_burn_per_day"),
                    "is_current": a.get("is_current"),
                    "reset": a.get("weekly_reset_utc"),
                    "verdict": a.get("verdict"),
                }
            )
    for s in series.values():
        s.sort(key=lambda x: x["ts"])
    return series, rows


def sustainable_for(sample, target):
    """(TARGET - weekly) / days_left — recomputed, never read from the file.

    The producer emits `need_per_day_to_hit_target` and
    `sustainable_burn_per_day`, but both bake in the producer's own TARGET.
    quota_brake.sh recomputes from PACE_TARGET so the two can be compared at
    the same target; this does the same. Returns None when days_left is
    missing, and clamps a non-positive denominator the way the shell does.
    """
    dl = sample.get("days_left")
    if dl is None:
        return None
    return (target - sample["weekly"]) / (dl if dl > 0 else 0.0001)


def derived_burn(samples, idx, window_hours):
    """Burn/day over the `window_hours` ending at samples[idx].

    Returns a dict, or None when no usable earlier sample exists.

    Two rules the naive version gets wrong:
      * RESET TRUNCATION — never pair across a week reset (see header).
      * NEGATIVE CLAMP — `weekly` is rounded, so a flat account can step
        -0.01. A negative burn is not a real thing; it is reported as 0.0 with
        the raw delta preserved so the clamp is visible rather than silent.
    """
    end = samples[idx]
    cutoff = end["ts"] - datetime.timedelta(hours=window_hours)

    # Walk back from idx, stopping at a reset. floor is the oldest sample that
    # is still in the same week as `end`.
    floor = 0
    for i in range(idx, 0, -1):
        if samples[i]["weekly"] < samples[i - 1]["weekly"] - RESET_DROP:
            floor = i
            break

    prior = [s for s in samples[floor: idx + 1] if s["ts"] <= cutoff]
    start = prior[-1] if prior else (samples[floor] if floor < idx else None)
    if start is None:
        return None
    dt_days = (end["ts"] - start["ts"]).total_seconds() / 86400.0
    if dt_days <= 0:
        return None
    delta = end["weekly"] - start["weekly"]
    rate = delta / dt_days
    return {
        "rate": max(0.0, rate),
        "raw_rate": rate,
        "clamped": rate < 0.0,
        "dt_hours": dt_days * 24.0,
        "delta": delta,
        "full_window": bool(prior),
        "resolution": WEEKLY_QUANTUM / dt_days,
        "n_samples": idx - floor + 1,
    }


# ---------------------------------------------------------------------------
def report(series, window_hours, target, at=None):
    for name, samples in series.items():
        idx = len(samples) - 1
        if at:
            tgt = parse_ts(at)
            cand = [i for i, s in enumerate(samples) if s["ts"] <= tgt]
            if not cand:
                print(f"\n{name}: no sample at or before {at}")
                continue
            idx = cand[-1]
        s = samples[idx]
        print("=" * 78)
        print(f"{name}   sample @ {s['ts']:%Y-%m-%dT%H:%M:%SZ}   is_current={s['is_current']}")
        print(f"  weekly={s['weekly']:.3f}  remaining={1.0 - s['weekly']:.3f}  "
              f"reset={s['reset']}  verdict={s['verdict']}")

        d = derived_burn(samples, idx, window_hours)
        if d is None:
            print(f"  no earlier sample in this week -- cannot derive")
            continue
        rep = s["reported_burn"]
        short = "" if d["full_window"] else "  (SHORT: whole week is younger than the window)"
        print(f"  DERIVED  burn={d['rate']:+.4f}/day   (dweekly={d['delta']:+.4f} "
              f"over {d['dt_hours']:.1f}h, n={d['n_samples']}){short}")
        if d["clamped"]:
            print(f"           raw {d['raw_rate']:+.4f}/day clamped to 0 "
                  f"(rounding jitter on a flat account)")
        print(f"           resolution +/-{d['resolution']:.4f}/day at this window")
        if rep is None:
            print("  REPORTED burn_per_day=null  (producer emitted nothing — the brake "
                  "would exit 5 UNKNOWN on this sample)")
        else:
            factor = (rep / d["rate"]) if d["rate"] > 1e-9 else float("inf")
            print(f"  REPORTED burn_per_day={rep:+.4f}/day   -> reported is {factor:.2f}x derived")

        need = sustainable_for(s, target)
        if need is None:
            print("  no days_left on this sample -- sustainable cannot be recomputed")
        else:
            print(f"  sustainable (recomputed @ TARGET={target}): {need:.4f}/day")
            if need <= 0:
                print(f"           TARGET ALREADY PASSED -- ratio pinned to "
                      f"{TARGET_PASSED_RATIO:.0f}, exactly as quota_brake.sh does. "
                      f"This is LEVEL3, not a release.")
            dr = ratio_for(d["rate"], need)
            print(f"  ratio vs sustainable:  DERIVED {dr:.1f}x -> {verdict_for(dr)}", end="")
            if rep is not None:
                rr = ratio_for(rep, need)
                print(f"     REPORTED {rr:.1f}x -> {verdict_for(rr)}")
            else:
                print("     REPORTED null -> UNKNOWN")

        rem = 1.0 - s["weekly"]
        if d["rate"] > 1e-9:
            exh = rem / d["rate"]
            print(f"  days_to_exhaustion:    DERIVED {exh:.2f}d   "
                  f"REPORTED {s['reported_dte'] if s['reported_dte'] is not None else 'null'}d")
            if s["reset"]:
                d_reset = (parse_reset(s["reset"]) - s["ts"]).total_seconds() / 86400.0
                print(f"  reset in {d_reset:.2f}d  ->  DARK WINDOW {max(0.0, d_reset - exh):.2f}d")
        else:
            print("  burn is zero over this window -- account is idle, no exhaustion")


# ---------------------------------------------------------------------------
def series_replay(series, window_hours, target):
    """Replay every sample: what the brake would pick from derived vs reported.

    This is the verification TOG-440 asks for. Two things it shows that a
    single-sample report cannot:
      * how often the two inputs disagree on the LEVEL, not just the number;
      * whether the derived series reconstructs `weekly` — the integral check
        below. Deriving a rate and never checking it integrates back to the
        thing it was derived from is how a plausible-but-wrong series survives.
    """
    for name, samples in series.items():
        print("=" * 108)
        print(f"{name}   {len(samples)} samples   window={window_hours}h   TARGET={target}")
        print(f"{'ts':21} {'weekly':>7} {'dBURN':>9} {'dRATIO':>8} {'dLEVEL':>8}   "
              f"{'rBURN':>9} {'rRATIO':>8} {'rLEVEL':>8}   {'agree':>6}")
        agree = disagree = unknown_rep = 0
        target_passed = no_window = 0
        dlevels, rlevels = {}, {}
        for idx, s in enumerate(samples):
            d = derived_burn(samples, idx, window_hours)
            need = sustainable_for(s, target)
            # A passed target is REPLAYED, not skipped: ratio_for pins it to 999
            # the way the brake does. Dropping those rows silently shortened the
            # replay at exactly the samples the brake treats most severely — at
            # TARGET=0.90 that was 36 of 448 account-samples, every one LEVEL3,
            # and the tally underneath still printed as though it had seen them.
            if d is None or need is None:
                no_window += 1
                continue
            if need <= 0:
                target_passed += 1
            dr = ratio_for(d["rate"], need)
            dlev = verdict_for(dr)
            dlevels[dlev] = dlevels.get(dlev, 0) + 1
            rep = s["reported_burn"]
            if rep is None:
                rlev, rr_s, rr_txt = "UNKNOWN", "null", "null"
                unknown_rep += 1
                rlevels["UNKNOWN"] = rlevels.get("UNKNOWN", 0) + 1
                same = "-"
            else:
                rr = ratio_for(rep, need)
                rlev = verdict_for(rr)
                rlevels[rlev] = rlevels.get(rlev, 0) + 1
                rr_s, rr_txt = f"{rep:+.4f}", f"{rr:.1f}"
                if rlev == dlev:
                    agree += 1
                    same = "yes"
                else:
                    disagree += 1
                    same = "NO"
            print(f"{s['ts']:%Y-%m-%dT%H:%M:%SZ} {s['weekly']:7.2f} "
                  f"{d['rate']:+9.4f} {dr:8.1f} {dlev:>8}   "
                  f"{rr_s:>9} {rr_txt:>8} {rlev:>8}   {same:>6}")
        total_cmp = agree + disagree
        print("-" * 108)
        print(f"  derived levels : " + "  ".join(
            f"{k}={dlevels.get(k, 0)}" for k in ("RELEASE", "LEVEL1", "LEVEL2", "LEVEL3")))
        print(f"  reported levels: " + "  ".join(
            f"{k}={rlevels.get(k, 0)}" for k in ("RELEASE", "LEVEL1", "LEVEL2", "LEVEL3", "UNKNOWN")))
        if total_cmp:
            print(f"  level agreement: {agree}/{total_cmp} "
                  f"({100.0 * agree / total_cmp:.1f}%)   disagree={disagree}")
        print(f"  samples where REPORTED is null (brake would exit 5): {unknown_rep}")
        print(f"  samples where the TARGET was already passed "
              f"(ratio pinned {TARGET_PASSED_RATIO:.0f} -> {LADDER_TOP}): {target_passed}")
        print(f"  samples with no derivable window or no days_left (not replayed): {no_window}")
        integral_check(samples, window_hours)


def integral_check(samples, window_hours):
    """Does the derived rate series reconstruct `weekly`?

    Sum rate_i * dt_i over consecutive samples and compare with the observed
    end-to-start `weekly` delta of the same span. A derived series that does
    not integrate back to its own source is not a measurement of it.

    Tolerance is not a taste call: it is the quantization floor. Each of the N
    sample-to-sample steps carries at most WEEKLY_QUANTUM of rounding error in
    the reconstruction, but the telescoping sum of a trailing-window rate
    cannot drift further than the window's own resolution times the span.
    """
    # Restrict to the current week — an integral across a reset is meaningless.
    floor = 0
    for i in range(len(samples) - 1, 0, -1):
        if samples[i]["weekly"] < samples[i - 1]["weekly"] - RESET_DROP:
            floor = i
            break
    week = samples[floor:]
    if len(week) < 3:
        print("  integral check: fewer than 3 samples this week — skipped")
        return
    # Step-wise rate (window = the gap itself) is the finest series available;
    # its integral must equal the observed delta to within rounding.
    total = 0.0
    for i in range(1, len(week)):
        dt = (week[i]["ts"] - week[i - 1]["ts"]).total_seconds() / 86400.0
        if dt <= 0:
            continue
        total += ((week[i]["weekly"] - week[i - 1]["weekly"]) / dt) * dt
    observed = week[-1]["weekly"] - week[0]["weekly"]
    span_h = (week[-1]["ts"] - week[0]["ts"]).total_seconds() / 3600.0
    err = abs(total - observed)
    verdict = "OK" if err <= WEEKLY_QUANTUM else "DRIFT"
    print(f"  integral check : sum(rate*dt)={total:+.4f} vs observed dweekly="
          f"{observed:+.4f} over {span_h:.1f}h  err={err:.6f}  [{verdict}]")


# ---------------------------------------------------------------------------
def sweep(series, target):
    """Window-size table: resolution, and how stable the selected level is.

    The point is not that a bigger window is better in the abstract. It is that
    below some width the quantization error alone exceeds the distance between
    two rungs of the ladder, so the extra responsiveness buys noise.
    """
    windows = (2.0, 6.0, 12.0, 24.0, 48.0)
    for name, samples in series.items():
        last = samples[-1]
        need = sustainable_for(last, target)
        print("=" * 92)
        if need is None:
            print(f"{name}   no days_left on the last sample -- cannot sweep")
            continue
        passed = (f"   (TARGET PASSED: every ratio pinned to "
                  f"{TARGET_PASSED_RATIO:.0f})") if need <= 0 else ""
        print(f"{name}   sustainable={need:.4f}/day @ TARGET={target}   "
              f"({len(samples)} samples){passed}")
        print(f"{'window':>8} {'resolution/day':>15} {'x sustainable':>14} "
              f"{'burn@last':>10} {'ratio':>8} {'level':>8} {'flips':>7}")
        for w in windows:
            d = derived_burn(samples, len(samples) - 1, w)
            if d is None:
                print(f"{w:7.0f}h {'--':>15} {'--':>14} {'no data':>10}")
                continue
            res = d["resolution"]
            ratio = ratio_for(d["rate"], need)
            # `flips`: how many times the selected level CHANGES across the
            # whole series at this window. A window that flips on every sample
            # is chattering the roster, which costs a PATCH per agent per flip.
            prev, flips = None, 0
            for idx in range(len(samples)):
                dd = derived_burn(samples, idx, w)
                nn = sustainable_for(samples[idx], target)
                if dd is None or nn is None:
                    continue
                lev = verdict_for(ratio_for(dd["rate"], nn))
                if prev is not None and lev != prev:
                    flips += 1
                prev = lev
            # `res / need` is the resolution expressed in rungs-of-the-ladder.
            # It is meaningless once `need` is non-positive, so it says so
            # rather than printing a negative multiple that reads as a number.
            xsus = f"{res / need:13.2f}x" if need > 0 else f"{'n/a':>13} "
            print(f"{w:7.0f}h {res:15.4f} {xsus} {d['rate']:10.4f} "
                  f"{ratio:8.1f} {verdict_for(ratio):>8} {flips:7d}")


# ---------------------------------------------------------------------------
def emit_json(series, window_hours, target):
    """The shape test_quota_burn_derive.sh compares against quota_brake.sh.

    Only the fields both implementations compute: name, burn, need, ratio,
    source. Keeping it minimal is deliberate — a cross-check that compares
    presentation rather than arithmetic passes while the arithmetic drifts.
    """
    out = []
    for name, samples in series.items():
        idx = len(samples) - 1
        s = samples[idx]
        d = derived_burn(samples, idx, window_hours)
        need = sustainable_for(s, target)
        if need is None:
            continue
        if d is not None:
            burn, source = d["rate"], "derived"
        elif s["reported_burn"] is not None:
            burn, source = s["reported_burn"], "reported"
        else:
            continue
        # `need` is emitted RAW, negative and all, because that is what
        # quota_brake.sh emits (measured: need=-0.009933 at PACE_TARGET=0.90 on
        # 2026-08-25) and this shape exists to be diffed against it. Clamping it
        # here would put a silent disagreement inside the one cross-check that
        # is supposed to catch disagreements — and TARGET=0.90 makes a negative
        # `need` a routine reading rather than a corner case.
        out.append({
            "name": name,
            "burn": round(burn, 6),
            "need": round(need, 6),
            "ratio": round(ratio_for(burn, need), 6),
            "source": source,
        })
    out.sort(key=lambda x: -x["ratio"])
    print(json.dumps(out, indent=2))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--jsonl", default=JSONL)
    ap.add_argument("--window-hours", type=float, default=DEFAULT_WINDOW_HOURS,
                    help=f"trailing window for the derived rate (default {DEFAULT_WINDOW_HOURS})")
    ap.add_argument("--target", type=float, default=DEFAULT_TARGET,
                    help=f"fraction of weekly quota to aim at (default {DEFAULT_TARGET})")
    ap.add_argument("--at", help="report as of this ts, e.g. 2026-08-25T08:43:52Z")
    ap.add_argument("--series", action="store_true",
                    help="replay every sample and show the level each input selects")
    ap.add_argument("--sweep", action="store_true",
                    help="window-size vs resolution vs level-stability table")
    ap.add_argument("--json", action="store_true",
                    help="machine-readable latest-sample derivation (cross-check shape)")
    args = ap.parse_args()

    try:
        series, rows = load(args.jsonl)
    except FileNotFoundError:
        print(f"no such file: {args.jsonl}", file=sys.stderr)
        return 2
    if not series:
        print("no usable samples", file=sys.stderr)
        return 2

    if args.json:
        emit_json(series, args.window_hours, args.target)
        return 0

    print(f"samples={len(rows)}  span {rows[0]['ts']} -> {rows[-1]['ts']}")
    print(f"derivation window: {args.window_hours}h trailing   TARGET={args.target}\n")
    if args.sweep:
        sweep(series, args.target)
    elif args.series:
        series_replay(series, args.window_hours, args.target)
    else:
        report(series, args.window_hours, args.target, args.at)
    return 0


if __name__ == "__main__":
    sys.exit(main())
