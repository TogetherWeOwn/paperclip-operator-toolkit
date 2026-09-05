#!/usr/bin/env python3
"""Focused hostile checks for the vendored TOG-938 pacing guard."""
import datetime
import unittest

from pacing_verdict import UNKNOWN, read_verdict_rows


NOW = datetime.datetime(2026, 9, 4, 16, 0, tzinfo=datetime.timezone.utc)


def sample(**overrides):
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


class PacingVerdictHostileTest(unittest.TestCase):
    def assert_unknown(self, row, reason):
        verdict = read_verdict_rows([row], now=NOW, source="fixture")
        self.assertEqual(verdict.state, UNKNOWN)
        self.assertIn(reason, verdict.reason)

    def test_live_sample_is_ok(self):
        verdict = read_verdict_rows([sample()], now=NOW, source="fixture")
        self.assertTrue(verdict.ok)
        self.assertEqual(verdict.state, "AHEAD")

    def test_missing_reset_is_unknown(self):
        self.assert_unknown(sample(accounts=[{"name": "account-a"}]),
                            "weekly_reset_utc")

    def test_malformed_reset_is_unknown(self):
        self.assert_unknown(sample(accounts=[{
            "name": "account-a", "weekly_reset_utc": "tomorrow"
        }]), "weekly_reset_utc")

    def test_malformed_accounts_never_raises(self):
        self.assert_unknown(sample(accounts="oops"), "accounts")

    def test_non_object_account_never_raises(self):
        self.assert_unknown(sample(accounts=["oops"]), "non-object account")

    def test_newest_parseable_timestamp_wins(self):
        verdict = read_verdict_rows([
            sample(),
            sample(ts="zzzz", pool_verdict="BEHIND"),
        ], now=NOW, source="fixture")
        self.assertTrue(verdict.ok)
        self.assertEqual(verdict.state, "AHEAD")

    def test_unknown_pool_verdict_is_unknown(self):
        self.assert_unknown(sample(pool_verdict="BROKEN_SCHEMA"),
                            "unknown pool_verdict")


if __name__ == "__main__":
    unittest.main()
