#!/usr/bin/env python3
# ===========================================================================
# test_pacing_verdict.py — hostile tests for the staleness guard (TOG-937/938)
#
# These are written to FAIL a plausible-but-wrong implementation, not to
# confirm the one that exists. A suite that only feeds well-formed input
# validates the author's own dialect and nothing else -- so every case below
# is either a shape the real feed actually produced, or the specific shortcut
# a reimplementation would take.
#
# WHY THIS FILE WAS REWRITTEN — TOG-1030
#
# The first vendored version of this file was seven tests, all driven through
# `read_verdict_rows`, and NOT ONE of them constrained the 120-minute cutoff.
# Measured: changing `if age > max_age_minutes:` to `if age > 1000000000:` in
# `pacing_verdict.py` left all five quota suites green — 282 declared checks,
# zero of which could see the guard the card was about. It passed only because
# its one "stale" case was the acceptance fixture, whose already-expired
# `weekly_reset_utc` values (08-28, 08-29) trip a SECOND, INDEPENDENT guard.
# So the fixture proved "the dead feed is refused", never "a stale sample is
# refused". §2 below is the difference: every age case carries a FUTURE reset,
# so the staleness cutoff is the only guard that can be answering.
#
# The three §2 boundary checks are ported from the canonical suite that has
# always lived beside the deployed copy at /paperclip/quota-pacer/. That suite
# also anchors §1 at `fixtures/dead-feed-...`, which in THIS repo lives at
# `tests/` — adopting it verbatim would have let §1 take its "skip (archive
# absent)" branch and drop five checks while still printing PASS. §1 here
# fails loudly if the fixture is missing rather than skipping, because a
# regression suite that quietly stops testing its headline case is the same
# false green in a different costume.
#
# The headline case is §1: the literal nine-day-dead file, which made
# `quota_rotation_watch.py` print "DEFECT" and `quota_brake.sh` return its
# maximum throttle rung. If that case ever goes green as a live verdict, the
# guard is gone.
#
# Deterministic: every case pins `now` explicitly. No network, no clock read,
# no write outside a temp dir.
# ===========================================================================
import datetime
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pacing_verdict import UNKNOWN, read_verdict, read_verdict_rows  # noqa: E402

UTC = datetime.timezone.utc
# §1-§11 clock. Chosen so the fixture below is nine days dead, matching the
# incident, and so every synthetic reset date is comfortably in the future.
NOW = datetime.datetime(2026, 9, 4, 2, 0, 0, tzinfo=UTC)
# The rows-API cases use their own clock, one minute after their sample.
ROWS_NOW = datetime.datetime(2026, 9, 4, 16, 0, tzinfo=UTC)

HERE = os.path.dirname(os.path.abspath(__file__))
DEAD_FEED = os.path.join(HERE, "tests", "dead-feed-2026-08-26.jsonl")


def sample(ts, pool="BEHIND", reset="2026-09-06 10:00 UTC", accounts=None, **kw):
    """One feed row. `reset` defaults to the FUTURE so that a case about age
    is only ever answered by the age guard."""
    row = {
        "ts": ts,
        "pool_verdict": pool,
        "runs_in_flight": 3,
        "unused_weekly_remaining": 0.4,
        "accounts": accounts if accounts is not None else [
            {"name": "a@example", "weekly": 0.5, "five_hour": 0.1,
             "verdict": "BEHIND", "weekly_reset_utc": reset,
             "burn_per_day": None, "is_current": True},
        ],
    }
    row.update(kw)
    return row


class FeedFileTest(unittest.TestCase):
    """Cases that go through `read_verdict`, i.e. a real file on disk."""

    def setUp(self):
        self._paths = []

    def tearDown(self):
        for p in self._paths:
            try:
                os.unlink(p)
            except OSError:
                pass

    def write(self, lines):
        fd, path = tempfile.mkstemp(suffix=".jsonl")
        with os.fdopen(fd, "w") as fh:
            for ln in lines:
                fh.write((ln if isinstance(ln, str) else json.dumps(ln)) + "\n")
        self._paths.append(path)
        return path

    def state(self, lines, now=NOW):
        return read_verdict(self.write(lines), now=now).state

    # -- §1  the real nine-day-dead feed — the whole reason this exists ------
    # A FROZEN FIXTURE, not the live feed. The first draft of the canonical
    # suite pointed this at /paperclip/operator-handoff/quota-pacing.jsonl and
    # passed -- then went red the moment the pacer was repaired and the file
    # stopped being stale. A regression test whose subject is "the dead file"
    # cannot read the file that is supposed to stop being dead; it would go
    # green again on the next outage, which is exactly backwards. These are the
    # real last three samples of the 2026-08-26 era, copied verbatim, including
    # the already-expired weekly_reset_utc values that made it so convincing.
    def test_01_dead_feed_fixture_is_present(self):
        # Not a skip. See the header: the canonical suite's absent-archive
        # branch is how five checks can vanish under a printed PASS.
        self.assertTrue(os.path.exists(DEAD_FEED),
                        "the acceptance fixture %s is missing -- §1 is the "
                        "headline case and must never silently skip" % DEAD_FEED)

    def test_01_dead_feed_is_unknown(self):
        v = read_verdict(DEAD_FEED, now=NOW)
        self.assertEqual(v.state, UNKNOWN)
        self.assertIs(v.ok, False)
        self.assertIn("old", v.reason)
        self.assertIn("no headroom", v.reason.lower())
        # The dead file's own content read AHEAD/THROTTLE. The guard must not
        # leak that through as the state.
        self.assertNotIn(v.state,
                         ("AHEAD", "THROTTLE", "ON_PACE", "BEHIND", "HOLD_5H"))

    # -- §2  freshness boundary ---------------------------------------------
    # THE CASES THAT KILL THE MUTANT. Every reset here is in the future, so a
    # disabled age cutoff has nothing else to fail on and these go red alone.
    def test_02_60m_old_is_live(self):
        self.assertEqual(self.state([sample("2026-09-04T01:00:00Z")]), "BEHIND")

    def test_02_119m_old_is_live(self):
        self.assertEqual(self.state([sample("2026-09-04T00:01:00Z")]), "BEHIND")

    def test_02_exactly_120m_is_live_limit_is_inclusive(self):
        # The exact boundary. `>` and `>=` here are indistinguishable to every
        # other case in this file, so without this the cutoff is only
        # approximately specified. The limit is INCLUSIVE -- a sample exactly
        # at the limit is still live -- and that has to be pinned rather than
        # left to whichever comparison someone types next.
        self.assertEqual(self.state([sample("2026-09-04T00:00:00Z")]), "BEHIND")

    def test_02_121m_is_unknown(self):
        self.assertEqual(self.state([sample("2026-09-03T23:59:00Z")]), UNKNOWN)

    def test_02_130m_is_unknown(self):
        self.assertEqual(self.state([sample("2026-09-03T23:50:00Z")]), UNKNOWN)

    def test_02_stale_reason_names_the_age_and_the_limit(self):
        # Attribution: a stale refusal that does not say it was stale is
        # indistinguishable at a call site from the expired-window refusal,
        # which is exactly how the two guards got confused in the first place.
        v = read_verdict(self.write([sample("2026-09-03T20:00:00Z")]), now=NOW)
        self.assertEqual(v.state, UNKNOWN)
        self.assertIn("360m old", v.reason)
        self.assertIn("limit 120m", v.reason)

    # -- §3  a sample from the FUTURE is not freshness ----------------------
    def test_03_future_sample_is_unknown(self):
        v = read_verdict(self.write([sample("2026-09-04T09:00:00Z")]), now=NOW)
        self.assertEqual(v.state, UNKNOWN)
        self.assertIn("FUTURE", v.reason)

    # -- §4  newest is by TIMESTAMP, not by file position -------------------
    def test_04_out_of_order_tail_picks_the_newest(self):
        # A producer restart can append an OLDER sample last. Taking `tail -1`
        # would read the stale one and here would wrongly report UNKNOWN.
        self.assertEqual(self.state([sample("2026-09-04T01:30:00Z", pool="AHEAD"),
                                     sample("2026-09-01T00:00:00Z", pool="BEHIND")]),
                         "AHEAD")

    # -- §5  a partial final line must not blank the feed -------------------
    def test_05_partial_tail_line_is_skipped(self):
        # The producer appends; a reader can catch a half-flushed line. That is
        # a ~20ms window and must not become a company-wide UNKNOWN.
        self.assertEqual(self.state([sample("2026-09-04T01:30:00Z", pool="ON_PACE"),
                                     '{"ts":"2026-09-04T01:4']),
                         "ON_PACE")

    # -- §6  fresh but not actually a measurement ---------------------------
    def test_06_fresh_with_null_pool_verdict_is_unknown(self):
        self.assertEqual(self.state([sample("2026-09-04T01:30:00Z", pool=None)]),
                         UNKNOWN)

    def test_06_fresh_with_empty_pool_verdict_is_unknown(self):
        self.assertEqual(self.state([sample("2026-09-04T01:30:00Z", pool="")]),
                         UNKNOWN)

    # -- §7  fresh sample measured against an EXPIRED weekly window ---------
    def test_07_passed_weekly_reset_is_unknown(self):
        # The dead file's real shape: numbers that describe a window that is
        # over. A producer that kept ticking while reading a stale upstream
        # would look fresh and still be meaningless.
        v = read_verdict(self.write([sample("2026-09-04T01:30:00Z",
                                            reset="2026-08-29 10:00 UTC")]), now=NOW)
        self.assertEqual(v.state, UNKNOWN)
        self.assertIn("window", v.reason)

    def test_07_future_weekly_reset_is_live(self):
        self.assertEqual(self.state([sample("2026-09-04T01:30:00Z",
                                            reset="2026-09-06 10:00 UTC")]),
                         "BEHIND")

    def test_07_the_two_guards_are_independent(self):
        # The defect this card exists for, stated directly: the acceptance
        # fixture satisfies BOTH guards at once, so either alone could have
        # been absent and the fixture would still refuse. These two cases hold
        # one variable each -- stale with a live window, fresh with a dead one
        # -- and both must refuse.
        stale_live_window = read_verdict(
            self.write([sample("2026-09-03T20:00:00Z", reset="2026-09-06 10:00 UTC")]),
            now=NOW)
        self.assertEqual(stale_live_window.state, UNKNOWN)
        self.assertIn("old", stale_live_window.reason)
        self.assertNotIn("window", stale_live_window.reason)

        fresh_dead_window = read_verdict(
            self.write([sample("2026-09-04T01:30:00Z", reset="2026-08-29 10:00 UTC")]),
            now=NOW)
        self.assertEqual(fresh_dead_window.state, UNKNOWN)
        self.assertIn("window", fresh_dead_window.reason)
        self.assertNotIn("old (limit", fresh_dead_window.reason)

    # -- §8  unreadable / empty / absent ------------------------------------
    def test_08_absent_file_is_unknown(self):
        self.assertEqual(read_verdict("/nonexistent/nope.jsonl", now=NOW).state,
                         UNKNOWN)

    def test_08_empty_file_is_unknown(self):
        self.assertEqual(self.state([]), UNKNOWN)

    def test_08_all_garbage_file_is_unknown(self):
        self.assertEqual(self.state(["not json at all", "{oops"]), UNKNOWN)

    def test_08_sample_with_no_ts_is_unknown(self):
        self.assertEqual(self.state([{"pool_verdict": "BEHIND", "accounts": []}]),
                         UNKNOWN)

    def test_08_non_object_json_line_is_unknown(self):
        self.assertEqual(self.state(['["a","list","not","an","object"]']), UNKNOWN)

    # -- §9  UNKNOWN must not be falsey-passable ----------------------------
    def test_09_verdict_has_no_bool_trapdoor(self):
        v = read_verdict("/nonexistent/nope.jsonl", now=NOW)
        self.assertFalse(hasattr(v, "__bool__"))
        self.assertIs(v.ok, False)

    # -- §10 the verdict never comes from burn_per_day ----------------------
    def test_10_absurd_burn_fields_do_not_move_the_verdict(self):
        # burn_per_day overstated by 2.28x at the incident. A sample whose burn
        # fields scream emergency must still report the pool_verdict it
        # carries, not an inference.
        self.assertEqual(self.state([sample("2026-09-04T01:30:00Z", pool="BEHIND", accounts=[
            {"name": "a@example", "weekly": 0.5, "five_hour": 0.1, "verdict": "BEHIND",
             "weekly_reset_utc": "2026-09-06 10:00 UTC", "burn_per_day": 99.0,
             "days_to_exhaustion": 0.001, "burn_ratio_vs_needed": 500.0,
             "is_current": True},
        ])]), "BEHIND")

    # -- §11 a null five_hour is not headroom (bash-empty-string trap) ------
    def test_11_null_five_hour_passes_through_untouched(self):
        v = read_verdict(self.write([sample("2026-09-04T01:30:00Z", pool="HOLD_5H", accounts=[
            {"name": "a@example", "weekly": 0.9, "five_hour": None,
             "verdict": "HOLD_5H", "weekly_reset_utc": "2026-09-06 10:00 UTC",
             "is_current": True},
        ])]), now=NOW)
        self.assertEqual(v.state, "HOLD_5H")
        self.assertIsNone(v.sample["accounts"][0]["five_hour"])


class VerdictRowsTest(unittest.TestCase):
    """Cases that go through `read_verdict_rows`, the already-read-rows entry
    point the brake and rotation watch use. Same guards, different door: a fix
    applied to one path and not the other is the shape TOG-1030's sibling
    finding warns about."""

    def rows_sample(self, **overrides):
        row = {
            "ts": "2026-09-04T15:59:00Z",
            "pool_verdict": "AHEAD",
            "accounts": [{
                "name": "account-a",
                "weekly": 0.4,
                "five_hour": 0.2,
                "weekly_reset_utc": "2026-09-11 00:00 UTC",
            }],
        }
        row.update(overrides)
        return row

    def assert_unknown(self, row, reason):
        verdict = read_verdict_rows([row], now=ROWS_NOW, source="fixture")
        self.assertEqual(verdict.state, UNKNOWN)
        self.assertIn(reason, verdict.reason)

    def test_live_sample_is_ok(self):
        verdict = read_verdict_rows([self.rows_sample()], now=ROWS_NOW, source="fixture")
        self.assertTrue(verdict.ok)
        self.assertEqual(verdict.state, "AHEAD")

    def test_stale_row_is_unknown(self):
        # The rows path needs the age cutoff pinned too, and for the same
        # reason: its reset is in the future, so nothing else can refuse this.
        verdict = read_verdict_rows([self.rows_sample(ts="2026-09-04T13:00:00Z")],
                                    now=ROWS_NOW, source="fixture")
        self.assertEqual(verdict.state, UNKNOWN)
        self.assertIn("limit 120m", verdict.reason)

    def test_exactly_120m_row_is_live(self):
        verdict = read_verdict_rows([self.rows_sample(ts="2026-09-04T14:00:00Z")],
                                    now=ROWS_NOW, source="fixture")
        self.assertTrue(verdict.ok)
        self.assertEqual(verdict.state, "AHEAD")

    def test_missing_reset_is_unknown(self):
        self.assert_unknown(self.rows_sample(accounts=[{"name": "account-a"}]),
                            "weekly_reset_utc")

    def test_malformed_reset_is_unknown(self):
        self.assert_unknown(self.rows_sample(accounts=[{
            "name": "account-a", "weekly_reset_utc": "tomorrow"
        }]), "weekly_reset_utc")

    def test_malformed_accounts_never_raises(self):
        self.assert_unknown(self.rows_sample(accounts="oops"), "accounts")

    def test_non_object_account_never_raises(self):
        self.assert_unknown(self.rows_sample(accounts=["oops"]), "non-object account")

    def test_newest_parseable_timestamp_wins(self):
        verdict = read_verdict_rows([
            self.rows_sample(),
            self.rows_sample(ts="zzzz", pool_verdict="BEHIND"),
        ], now=ROWS_NOW, source="fixture")
        self.assertTrue(verdict.ok)
        self.assertEqual(verdict.state, "AHEAD")

    def test_unknown_pool_verdict_is_unknown(self):
        self.assert_unknown(self.rows_sample(pool_verdict="BROKEN_SCHEMA"),
                            "unknown pool_verdict")


if __name__ == "__main__":
    unittest.main(verbosity=2)
