#!/usr/bin/env python3
"""Unit tests for review_dedup.py (same-head review idempotency). Stdlib only, offline.

The guard is pure decision logic over GitHub check-runs and server
chat_github_reviews row states: no network, no DB, no credentials.
"""

import unittest

import review_dedup as d

SHA = '1234567890abcdef1234567890abcdef12345678'
REPO = 'TogetherWeOwn/paperclip-ops-tooling'


class IdempotencyKey(unittest.TestCase):
    def test_key_format_is_repo_number_head(self):
        self.assertEqual(d.idempotency_key(REPO, 7, SHA), f'{REPO.lower()}#7@{SHA}')

    def test_repo_is_lowercased_so_case_variants_share_a_key(self):
        self.assertEqual(d.idempotency_key('TogetherWeOwn/Kofra', 7, SHA),
                         d.idempotency_key('togetherweown/kofra', 7, SHA))

    def test_different_heads_are_different_keys(self):
        self.assertNotEqual(d.idempotency_key(REPO, 7, SHA),
                            d.idempotency_key(REPO, 7, SHA + '00'))


class CheckRunSuppresses(unittest.TestCase):
    def test_live_review_suppresses_a_second_request(self):
        for status in ('queued', 'in_progress', 'waiting', 'requested', 'pending'):
            with self.subTest(status=status):
                self.assertTrue(d.check_run_suppresses('Paperclip Review', status, None))

    def test_completed_verdict_suppresses_a_second_request(self):
        for conclusion in ('success', 'failure'):
            with self.subTest(conclusion=conclusion):
                self.assertTrue(d.check_run_suppresses('Paperclip Review', 'completed', conclusion))

    def test_error_outcomes_stay_retryable(self):
        for conclusion in ('action_required', 'cancelled', 'timed_out', 'stale'):
            with self.subTest(conclusion=conclusion):
                self.assertFalse(d.check_run_suppresses('Paperclip Review', 'completed', conclusion))

    def test_non_review_checks_never_suppress(self):
        self.assertFalse(d.check_run_suppresses('ci-ok', 'in_progress', None))
        self.assertFalse(d.check_run_suppresses('ci-ok', 'completed', 'failure'))

    def test_unknown_status_fails_closed_toward_suppress(self):
        self.assertTrue(d.check_run_suppresses('Paperclip Review', 'mystery', None))
        self.assertTrue(d.check_run_suppresses('Paperclip Review', None, None))


class HeadDecision(unittest.TestCase):
    def test_bare_head_may_be_requested(self):
        action, _ = d.head_decision([])
        self.assertEqual(action, 'request')

    def test_completed_head_is_never_re_requested(self):
        action, reason = d.head_decision(['completed'])
        self.assertEqual(action, 'suppress')
        self.assertIn('completed', reason)

    def test_in_flight_head_is_never_re_requested(self):
        for state in ('queued', 'running'):
            with self.subTest(state=state):
                action, _ = d.head_decision([state])
                self.assertEqual(action, 'suppress')

    def test_first_error_allows_exactly_one_retry(self):
        action, _ = d.head_decision(['error'])
        self.assertEqual(action, 'request')
        action, _ = d.head_decision(['incomplete'])
        self.assertEqual(action, 'request')

    def test_second_error_exhausts_the_retry_budget(self):
        action, reason = d.head_decision(['error', 'error'])
        self.assertEqual(action, 'suppress')
        self.assertIn('retry', reason)

    def test_error_after_a_completed_review_is_not_re_requested(self):
        action, _ = d.head_decision(['completed', 'error'])
        self.assertEqual(action, 'suppress')

    def test_error_behind_a_live_attempt_is_left_to_the_live_attempt(self):
        action, _ = d.head_decision(['running', 'error'])
        self.assertEqual(action, 'suppress')

    def test_manual_required_head_may_be_requested(self):
        action, _ = d.head_decision(['manual_required'])
        self.assertEqual(action, 'request')

    def test_states_match_case_insensitively(self):
        action, _ = d.head_decision(['Completed'])
        self.assertEqual(action, 'suppress')
        action, _ = d.head_decision(['ERROR', 'ERROR'])
        self.assertEqual(action, 'suppress')

    def test_unrecognized_state_fails_closed_toward_suppress(self):
        action, reason = d.head_decision(['splines_reticulated'])
        self.assertEqual(action, 'suppress')
        self.assertIn('unrecognized', reason)

    def test_unrecognized_state_poison_even_beside_an_error(self):
        action, _ = d.head_decision(['error', 'splines_reticulated'])
        self.assertEqual(action, 'suppress')


class TwoDeliveriesOneRow(unittest.TestCase):
    """Acceptance cover: two deliveries for the same head -> one row.

    Delivery 1 finds a bare head and requests; once its row exists as a live
    review, delivery 2 for the same head must suppress instead of opening a
    second row.
    """

    def test_second_delivery_for_the_same_head_suppresses(self):
        first, _ = d.head_decision([])
        self.assertEqual(first, 'request')
        # delivery 1's row is now live on the server
        second, _ = d.head_decision(['queued'])
        self.assertEqual(second, 'suppress')

    def test_second_delivery_after_a_verdict_suppresses(self):
        self.assertEqual(d.head_decision([])[0], 'request')
        self.assertEqual(d.head_decision(['completed'])[0], 'suppress')

    def test_retry_then_second_failure_suppresses(self):
        self.assertEqual(d.head_decision(['error'])[0], 'request')
        self.assertEqual(d.head_decision(['error', 'error'])[0], 'suppress')

    def test_same_key_both_deliveries(self):
        self.assertEqual(d.idempotency_key(REPO, 7, SHA),
                         d.idempotency_key(REPO, 7, SHA))


if __name__ == '__main__':
    unittest.main()
