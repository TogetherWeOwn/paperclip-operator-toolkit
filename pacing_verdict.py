#!/usr/bin/env python3
# ===========================================================================
# pacing_verdict.py — the ONE way to read quota-pacing.jsonl safely (TOG-937)
#
# THE FAILURE THIS PREVENTS, MEASURED
#
# On 2026-09-04 the pacer feed had been dead for nine days. Its last sample
# still read `weekly` 0.99/1.00 against `weekly_reset_utc` values of 08-28 and
# 08-29 -- both long past. Two things then happened, and neither was a wrong
# number, they were a CONFIDENT number:
#
#   * `quota_rotation_watch.py` on the dead file printed
#     "OVERALL: NO_ROTATION / DEFECT: a spent account kept burning" and exited
#     3. That is its live-defect exit code, produced entirely by nine-day-old
#     data. Someone would have gone and investigated teamclaude.
#
#   * `quota_brake.sh pace` on the dead file returned
#     `{"ratio":999,"verdict":"LEVEL3"}` -- its maximum throttle rung, off a
#     feed with no living producer. That verdict throttles the roster.
#
# Both are silent failures in the exact sense that matters: a job that produced
# nothing reported success, and a dead instrument read as a live measurement.
# TOG-235 branches on this verdict, where BEHIND means push throughput and
# THROTTLE means triage only, so a false reading costs either a quota blowout
# or days of idle company time.
#
# THE RULE, AND WHY IT IS CODE AND NOT A SENTENCE IN A RUNBOOK
#
# A sample older than MAX_AGE_MINUTES is UNKNOWN. Not stale-but-usable, not
# "the last known verdict", not a fallback to the previous sample -- UNKNOWN,
# which is a third state that is neither headroom nor its absence. Every
# consumer needs the identical cutoff and the identical tri-state, and a model
# re-improvising that from prose gets it subtly different every time. So it is
# one function, with one number in it, that everything calls.
#
# The cutoff is 120 minutes. The producer ticks every ~15 minutes, so 120
# tolerates seven consecutive missed ticks before it complains -- deliberately
# loose, because a false UNKNOWN is a nuisance and a false verdict is an
# outage. `cold_start_detector.sh` keeps its own tighter 30-minute limit for
# its own question; this is a floor for everyone, not a ceiling for anyone.
#
# WHAT "UNKNOWN" MUST MEAN AT THE CALL SITE
#
# UNKNOWN is not permission to proceed and it is not a reason to stop. It means
# the instrument is down, so the decision has to be made on something else and
# SAID to have been made on something else. The one thing it must never become
# is a quiet pass.
#
# TRUST `weekly`, NEVER `burn_per_day`
#
# Preserved from TOG-235's standing warning and independently re-measured:
# `burn_per_day` emitted an identical figure for both accounts across its first
# four samples (a pooled number rendered twice) and overstated by 2.28x at the
# 08-25 incident, making `days_to_exhaustion` understate runway by more than
# half. `weekly` is account-reported. This module refuses to return a verdict
# derived from the burn fields at all -- `--json` re-exports them untouched so
# a caller that insists can still see them, but nothing here branches on one.
#
# EXIT CODES (cli)
#   0  a live, fresh verdict was read
#   3  UNKNOWN -- feed stale, unreadable, empty, or unparseable
#   2  usage
#
# Read-only. Opens one jsonl. No network, no credential, no mutation.
# ===========================================================================
import argparse
import datetime
import json
import os
import sys

JSONL = "/paperclip/operator-handoff/quota-pacing.jsonl"

# The floor every consumer shares. See the header for why it is this loose.
MAX_AGE_MINUTES = 120

# Only ever read the tail: the file is append-only and grows without bound,
# and a verdict never depends on ancient history.
TAIL_BYTES = 256 * 1024

UNKNOWN = "UNKNOWN"
# Producer vocabulary observed in the feed and existing consumer fixtures.
# Anything else is schema drift, not a verdict a consumer may reinterpret.
POOL_VERDICTS = frozenset(("AHEAD", "BEHIND", "HOLD_5H", "OK", "ON_PACE", "THROTTLE"))


class Verdict:
    """The tri-state. `ok` is False for UNKNOWN, and there is deliberately no
    __bool__ that would let `if verdict:` silently score UNKNOWN as falsey and
    therefore as "no problem"."""

    __slots__ = ("state", "reason", "sample", "age_minutes")

    def __init__(self, state, reason, sample=None, age_minutes=None):
        self.state = state
        self.reason = reason
        self.sample = sample
        self.age_minutes = age_minutes

    @property
    def ok(self):
        return self.state != UNKNOWN

    def as_dict(self):
        return {
            "state": self.state,
            "reason": self.reason,
            "age_minutes": self.age_minutes,
            "ts": (self.sample or {}).get("ts"),
            "accounts": (self.sample or {}).get("accounts"),
            "runs_in_flight": (self.sample or {}).get("runs_in_flight"),
            "unused_weekly_remaining": (self.sample or {}).get("unused_weekly_remaining"),
        }

    def __repr__(self):
        return "<Verdict %s %s>" % (self.state, self.reason)


def parse_ts(s):
    if not isinstance(s, str):
        return None
    try:
        return datetime.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=datetime.timezone.utc
        )
    except ValueError:
        return None


def newest_sample(path, tail_bytes=TAIL_BYTES):
    """Return the newest PARSEABLE sample, or None.

    Deliberately not `tail -1`: the producer appends, so the final line can be
    a partial flush. A partial last line must not make the whole feed read as
    unreadable -- that would turn a 20ms write window into a company-wide
    UNKNOWN. It also must not be silently skipped past a genuinely corrupt
    feed, so a file whose lines NONE parse still returns None.
    """
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as fh:
            if size > tail_bytes:
                fh.seek(size - tail_bytes)
                fh.readline()  # discard the partial first line after seeking
            blob = fh.read().decode("utf-8", "replace")
    except OSError:
        return None

    best = None
    best_ts = None
    for ln in blob.splitlines():
        ln = ln.strip()
        if not ln:
            continue
        try:
            r = json.loads(ln)
        except json.JSONDecodeError:
            continue
        if not isinstance(r, dict):
            continue
        ts = parse_ts(r.get("ts"))
        if ts is None:
            continue
        # Newest by TIMESTAMP, not by file position. A producer restart can
        # append a sample older than the one before it.
        if best_ts is None or ts > best_ts:
            best, best_ts = r, ts
    return best


def read_verdict_sample(sample, max_age_minutes=MAX_AGE_MINUTES, now=None,
                        source=JSONL):
    """Validate one selected sample. Never raises; always returns a Verdict."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    if not isinstance(sample, dict):
        return Verdict(UNKNOWN, "pacing feed %s has no parseable timestamped sample" % source)

    ts = parse_ts(sample.get("ts"))
    if ts is None:
        return Verdict(UNKNOWN, "pacing feed %s has no parseable timestamped sample" % source)
    age = (now - ts).total_seconds() / 60.0

    # A sample from the future is a broken clock somewhere, not freshness.
    # Tolerate a couple of minutes of skew, then refuse.
    if age < -5:
        return Verdict(UNKNOWN,
                       "newest sample %s is %.0fm in the FUTURE -- clock skew, "
                       "not freshness" % (sample.get("ts"), -age),
                       sample, round(age, 1))

    if age > max_age_minutes:
        return Verdict(UNKNOWN,
                       "newest sample %s is %.0fm old (limit %dm) -- the pacer "
                       "has stopped. This is NOT a verdict, and it is NOT "
                       "'no headroom'." % (sample.get("ts"), age, max_age_minutes),
                       sample, round(age, 1))

    # Fresh, but freshness alone is not a verdict: the sample still has to
    # carry one. A record with no pool_verdict is unmeasured, not healthy.
    pv = sample.get("pool_verdict")
    if not isinstance(pv, str) or not pv:
        return Verdict(UNKNOWN,
                       "newest sample %s is fresh but carries no pool_verdict"
                       % sample.get("ts"), sample, round(age, 1))
    if pv not in POOL_VERDICTS:
        return Verdict(UNKNOWN,
                       "newest sample %s carries unknown pool_verdict %r"
                       % (sample.get("ts"), pv), sample, round(age, 1))

    # The accounts container and every reset must be measurable. Silently
    # skipping malformed reset metadata turns producer schema drift into a live
    # verdict, which is the same false-confidence failure as a stale sample.
    accounts = sample.get("accounts")
    if not isinstance(accounts, list) or not accounts:
        return Verdict(UNKNOWN,
                       "newest sample %s is fresh but accounts is not a non-empty array"
                       % sample.get("ts"), sample, round(age, 1))
    stale_resets = []
    for index, account in enumerate(accounts):
        if not isinstance(account, dict):
            return Verdict(UNKNOWN,
                           "newest sample %s has a non-object account at index %d"
                           % (sample.get("ts"), index), sample, round(age, 1))
        raw = account.get("weekly_reset_utc")
        if not isinstance(raw, str):
            return Verdict(UNKNOWN,
                           "newest sample %s has no parseable weekly_reset_utc for %s"
                           % (sample.get("ts"), account.get("name") or index),
                           sample, round(age, 1))
        try:
            rdt = datetime.datetime.strptime(
                raw, "%Y-%m-%d %H:%M UTC").replace(tzinfo=datetime.timezone.utc)
        except ValueError:
            return Verdict(UNKNOWN,
                           "newest sample %s has no parseable weekly_reset_utc for %s"
                           % (sample.get("ts"), account.get("name") or index),
                           sample, round(age, 1))
        if rdt < now:
            stale_resets.append("%s=%s" % (account.get("name"), raw))
    if stale_resets:
        return Verdict(UNKNOWN,
                       "newest sample %s is fresh but its weekly_reset_utc has "
                       "already passed (%s) -- the numbers describe a window "
                       "that is over" % (sample.get("ts"), ", ".join(stale_resets)),
                       sample, round(age, 1))

    return Verdict(pv, "live sample, %.0fm old" % age, sample, round(age, 1))


def read_verdict_rows(rows, max_age_minutes=MAX_AGE_MINUTES, now=None,
                      source=JSONL):
    """Validate the newest timestamped object from an already-read row set."""
    best = None
    best_ts = None
    for row in rows:
        if not isinstance(row, dict):
            continue
        ts = parse_ts(row.get("ts"))
        if ts is None:
            continue
        if best_ts is None or ts > best_ts:
            best, best_ts = row, ts
    return read_verdict_sample(best, max_age_minutes, now, source)


def read_verdict(path=JSONL, max_age_minutes=MAX_AGE_MINUTES, now=None):
    """The whole point of this module. Never raises; always returns a Verdict."""
    if not os.path.exists(path):
        return Verdict(UNKNOWN, "pacing feed %s does not exist" % path)
    sample = newest_sample(path)
    return read_verdict_sample(sample, max_age_minutes, now, path)


def main():
    p = argparse.ArgumentParser(
        description="Read the quota pacing verdict, or UNKNOWN if the feed is stale.")
    p.add_argument("--file", default=JSONL)
    p.add_argument("--max-age-minutes", type=int, default=MAX_AGE_MINUTES)
    p.add_argument("--now", help="override current UTC time (testing), e.g. 2026-09-04T12:00:00Z")
    p.add_argument("--json", action="store_true")
    p.add_argument("--quiet", action="store_true")
    a = p.parse_args()

    if a.now:
        now = parse_ts(a.now)
        if now is None:
            p.error("--now must be UTC in YYYY-MM-DDTHH:MM:SSZ form")
    else:
        now = None
    v = read_verdict(a.file, a.max_age_minutes, now=now)
    if a.json:
        print(json.dumps(v.as_dict(), sort_keys=True))
    elif not a.quiet:
        print("%s  --  %s" % (v.state, v.reason))
        if v.ok:
            for acct in (v.sample.get("accounts") or []):
                print("    %-24s weekly=%-6s five_hour=%-6s verdict=%s reset=%s"
                      % (acct.get("name"), acct.get("weekly"),
                         acct.get("five_hour"), acct.get("verdict"),
                         acct.get("weekly_reset_utc")))
    return 0 if v.ok else 3


if __name__ == "__main__":
    sys.exit(main())
