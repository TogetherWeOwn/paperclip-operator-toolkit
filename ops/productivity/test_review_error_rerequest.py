#!/usr/bin/env python3
import ast
import calendar
import contextlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest import mock

import review_error_rerequest as r

REPO = 'TogetherWeOwn/paperclip-ops-tooling'
SHA = '1234567890abcdef1234567890abcdef12345678'
CARD_ID = '5c1f0e2a-6d1b-4c8e-9a51-2f7b0d3e4a10'
OTHER_ID = '8e2d4b7a-1f3c-4a9e-b0d6-7c5f2e1a9b03'
OPEN = {'status': 'in_progress', 'descriptor': False, 'blockers': 0, 'recovery': 0, 'pending': 0, 'in_focus': True}


def facts(**changes):
    return {**OPEN, **changes}


def like(pattern, text):
    regex, i = '', 0
    while i < len(pattern):
        c = pattern[i]
        if c == '\\':
            i += 1
            regex += re.escape(pattern[i])
        else:
            regex += '.*' if c == '%' else '.' if c == '_' else re.escape(c)
        i += 1
    return re.fullmatch(regex, text, re.S) is not None


MERGE_CONDITIONS = re.compile(r'exact-head re-check|before you merge|not a merge order|cannot merge', re.I)
MERGE_WORD = re.compile(r'\bmerg(?:e|es|ed|ing)\b', re.I)
NOW = re.compile(r'\bnow\b', re.I)


def unconditional_merge_sentences(text):
    found = []
    for s in re.split(r'(?<=[.!?])\s+', text):
        if MERGE_WORD.search(re.sub(r'merge-ready', '', s, flags=re.I)) and (NOW.search(s) or not MERGE_CONDITIONS.search(s)):
            found.append(s)
    return found


def host_ok_stub(result=(True, 'ok')):
    stub = types.ModuleType('host_ok')
    stub.host_ok = lambda: result
    return stub


def untimed_runs(source):
    """Line numbers of subprocess.run calls without a timeout= keyword."""
    return [n.lineno for n in ast.walk(ast.parse(source)) if isinstance(n, ast.Call)
            and isinstance(n.func, ast.Attribute) and n.func.attr == 'run'
            and isinstance(n.func.value, ast.Name) and n.func.value.id == 'subprocess'
            and not any(k.arg == 'timeout' for k in n.keywords)]


def timed_out(*args, **kwargs):
    raise subprocess.TimeoutExpired(args[0] if args else kwargs.get('args'), kwargs.get('timeout'))


class HoldReason(unittest.TestCase):
    def test_eligible_card_is_not_held(self):
        self.assertIsNone(r.hold_reason(facts(), focus_on=True))

    def test_only_eligible_statuses_are_woken(self):
        for status in ('todo', 'in_progress', 'in_review'):
            self.assertIsNone(r.hold_reason(facts(status=status), focus_on=False), status)
        for status in ('blocked', 'backlog'):
            self.assertIsNotNone(r.hold_reason(facts(status=status), focus_on=False), status)

    def test_descriptor_recovery_and_blocker_hold_every_wake(self):
        for changes in ({'descriptor': True}, {'recovery': 1}, {'blockers': 1}):
            with self.subTest(changes=changes):
                self.assertIsNotNone(r.hold_reason(facts(**changes), focus_on=False))
                self.assertIsNotNone(r.hold_reason(facts(**changes), focus_on=False, merge=True))

    def test_pending_ask_holds_only_a_merge_notice(self):
        self.assertIsNone(r.hold_reason(facts(pending=1), focus_on=False))
        self.assertIsNotNone(r.hold_reason(facts(pending=1), focus_on=False, merge=True))

    def test_out_of_focus_holds_only_while_focus_gate_is_active(self):
        self.assertIsNotNone(r.hold_reason(facts(in_focus=False), focus_on=True))
        self.assertIsNone(r.hold_reason(facts(in_focus=False), focus_on=False))

    def test_missing_card_is_held(self):
        self.assertIsNotNone(r.hold_reason(None, focus_on=False))


class PsqlTextRows(unittest.TestCase):
    def fake_psql(self, row, focus='t'):
        def fake(sql):
            return [row] if 'unblock_descriptor' in sql else [[focus]]
        return fake

    def test_text_rows_become_flags_and_counts(self):
        with mock.patch.object(r, 'psql', side_effect=self.fake_psql(['in_review', 'f', '0', '0', '2'])):
            got = r.card_facts(CARD_ID, focus_on=True)
        self.assertEqual(got, {'status': 'in_review', 'descriptor': False, 'blockers': 0, 'recovery': 0,
                               'pending': 2, 'in_focus': True})
        self.assertIsNone(r.hold_reason(got, focus_on=True, merge=False))

    def test_escalated_recovery_is_an_open_recovery_in_the_sql(self):
        fake = mock.Mock(side_effect=self.fake_psql(['todo', 'f', '0', '0', '0']))
        with mock.patch.object(r, 'psql', fake):
            r.card_facts(CARD_ID, focus_on=False)
        self.assertIn("ra.status in ('active','escalated')", fake.call_args.args[0])

    def test_text_count_one_holds_on_a_blocking_edge(self):
        with mock.patch.object(r, 'psql', side_effect=self.fake_psql(['todo', 'f', '1', '0', '0'])):
            got = r.card_facts(CARD_ID, focus_on=True)
        self.assertEqual(r.hold_reason(got, focus_on=True), 'unresolved blocking edge')

    def test_text_zero_count_is_not_a_hold(self):
        with mock.patch.object(r, 'psql', side_effect=self.fake_psql(['todo', 'f', '0', '0', '0'])):
            got = r.card_facts(CARD_ID, focus_on=True)
        self.assertIsNone(r.hold_reason(got, focus_on=True))

    def test_text_t_descriptor_holds_the_card(self):
        with mock.patch.object(r, 'psql', side_effect=self.fake_psql(['todo', 't', '0', '0', '0'])):
            got = r.card_facts(CARD_ID, focus_on=True)
        self.assertTrue(got['descriptor'])
        self.assertEqual(r.hold_reason(got, focus_on=True), 'unblock descriptor')

    def test_text_f_focus_holds_an_out_of_focus_card(self):
        with mock.patch.object(r, 'psql', side_effect=self.fake_psql(['todo', 'f', '0', '0', '0'], focus='f')):
            got = r.card_facts(CARD_ID, focus_on=True)
        self.assertFalse(got['in_focus'])
        self.assertEqual(r.hold_reason(got, focus_on=True), 'out of focus')


class OwnerMatch(unittest.TestCase):
    def test_pr_seven_is_not_pr_seventy(self):
        patterns = r.pr_url_patterns(REPO, 7)

        def matches(url):
            return any(like(p, url.lower()) for p in patterns)

        self.assertTrue(matches(f'https://github.com/{REPO}/pull/7'))
        self.assertTrue(matches(f'https://github.com/{REPO}/pull/7/files'))
        self.assertTrue(matches(f'https://github.com/{REPO}/pull/7#issuecomment-1'))
        self.assertFalse(matches(f'https://github.com/{REPO}/pull/70'))
        self.assertFalse(matches(f'https://github.com/{REPO}/pull/17'))

    def test_underscore_in_a_repo_name_is_literal(self):
        patterns = r.pr_url_patterns('TogetherWeOwn/ops_tool', 7)
        self.assertTrue(any(like(p, 'https://github.com/togetherweown/ops_tool/pull/7') for p in patterns))
        self.assertFalse(any(like(p, 'https://github.com/togetherweown/opsxtool/pull/7') for p in patterns))

    def test_owner_query_uses_the_anchored_patterns(self):
        with mock.patch.object(r, 'psql', return_value=[]) as psql:
            r.owning_card(REPO, 7)
        sql = psql.call_args.args[0]
        for pattern in r.pr_url_patterns(REPO, 7):
            self.assertIn(f"lower(w.url) like '{pattern}'", sql)
        self.assertIn("order by (i.status in ('todo', 'in_progress', 'in_review')) desc, i.updated_at desc", sql)

    def test_owner_query_skips_chat_channel_origin_cards(self):
        with mock.patch.object(r, 'psql', return_value=[]) as psql:
            r.owning_card(REPO, 7)
        self.assertIn("i.origin_kind is distinct from 'chat_channel'", psql.call_args.args[0])


class LiveRunHelper(unittest.TestCase):
    def test_scheduled_retry_counts_as_live(self):
        run = mock.Mock(return_value=types.SimpleNamespace(stdout='t\n'))
        with mock.patch.object(r.live_run_guard.subprocess, 'run', run):
            self.assertTrue(r.live_run_guard.issue_has_live_work(CARD_ID))
        sql = run.call_args.args[0][-1]
        self.assertIn("'scheduled_retry'", sql)
        self.assertNotIn('scheduled_retry_at', sql)

    def test_due_scheduled_retry_still_counts_as_live(self):
        run = mock.Mock(return_value=types.SimpleNamespace(stdout='t\n'))
        with mock.patch.object(r.live_run_guard.subprocess, 'run', run):
            self.assertTrue(r.live_run_guard.issue_has_live_work(CARD_ID))
        self.assertNotIn('> now()', run.call_args.args[0][-1])

    def test_unreachable_database_counts_as_live(self):
        with mock.patch.object(r.live_run_guard.subprocess, 'run', side_effect=OSError('no docker')):
            self.assertTrue(r.live_run_guard.issue_has_live_work(CARD_ID))

    def test_any_error_counts_as_live(self):
        with mock.patch.object(r.live_run_guard.subprocess, 'run', side_effect=RuntimeError('boom')):
            self.assertTrue(r.live_run_guard.issue_has_live_work(CARD_ID))


class MergeNotice(unittest.TestCase):
    def test_notice_is_conditional_and_never_overrides_holds(self):
        text = r.merge_notice(REPO, 7, SHA)
        self.assertEqual(unconditional_merge_sentences(text), [])
        self.assertIsNone(re.search(r'\bnow\b', text))
        self.assertIn(SHA[:8], text)
        self.assertIn('never override a hold or a production approval', text)

    def test_order_detector_flags_merge_orders_the_old_exemptions_let_through(self):
        for order in ('Merge it now, and only the nit is left.',
                      'Squash-merge once CI is green, since CLEAN and review success never override a hold.',
                      'Squash and merging once CI is green.',
                      'Merge now, after an exact-head re-check.'):
            with self.subTest(order=order):
                self.assertEqual(unconditional_merge_sentences(order), [order])

    def test_order_detector_accepts_the_conditional_forms(self):
        for ok in ('Merge only after an exact-head re-check, and only with no open pending decision.',
                   'Re-check that exact head before you merge: CI is green on it.',
                   'It cannot merge without Paperclip Review 5/5.',
                   '**Merge-ready check, not a merge order:** the PR is CLEAN.'):
            with self.subTest(ok=ok):
                self.assertEqual(unconditional_merge_sentences(ok), [])


class Wiring(unittest.TestCase):
    def tick(self, *, stranded=(), merge=(), unreviewed=(), card=(CARD_ID, 'CARD-900'), cards=None,
             facts_now=None, facts_fn=None, live=False, focus=False, apply=True, state=None, parked_before=None,
             head=('OPEN', SHA), http='200', host=(True, 'ok'), broken_parked=False):
        comments = []
        owning = (lambda repo, n: cards[str(n)]) if cards else card if callable(card) else (lambda repo, n: card)
        facts_side = facts_fn or (lambda issue_id, focus_on: facts_now)
        stdout = io.StringIO()
        error = None
        with tempfile.TemporaryDirectory() as tmp:
            state_path, parked_path = Path(tmp, 'state.json'), Path(tmp, 'parked.txt')
            if state is not None:
                state_path.write_text(json.dumps(state))
            if parked_before is not None:
                parked_path.write_text(parked_before)
            if broken_parked:
                parked_path.mkdir()
            with mock.patch.dict(sys.modules, {'host_ok': host_ok_stub(host)}), \
                    mock.patch.object(r, 'APPLY', apply), \
                    mock.patch.object(r, 'STATE', state_path), \
                    mock.patch.object(r, 'LOG', Path(tmp, 'operator.log')), \
                    mock.patch.object(r, 'PARKED', parked_path), \
                    mock.patch.object(r, 'psql', side_effect=lambda sql: [list(row) for row in stranded]
                                      if 'chat_github_reviews' in sql else []), \
                    mock.patch.object(r, 'gh_env', return_value={}), \
                    mock.patch.object(r, 'merge_ready', return_value=list(merge)), \
                    mock.patch.object(r, 'unreviewed', return_value=list(unreviewed)), \
                    mock.patch.object(r, 'pr_head', **({'side_effect': head} if callable(head) else {'return_value': head})), \
                    mock.patch.object(r, 'owning_card', side_effect=owning), \
                    mock.patch.object(r, 'card_facts', side_effect=facts_side), \
                    mock.patch.object(r, 'focus_active', return_value=focus), \
                    mock.patch.object(r.live_run_guard, 'issue_has_live_work', return_value=live), \
                    mock.patch.object(r, 'comment', side_effect=lambda issue_id, body: comments.append((issue_id, body))
                                      or (http(issue_id, body) if callable(http) else http)), \
                    contextlib.redirect_stdout(stdout):
                try:
                    r.main()
                except Exception as e:
                    error = e
            return {'comments': [c[0] for c in comments], 'bodies': [c[1] for c in comments],
                    'state': json.loads(state_path.read_text()) if state_path.exists() else {},
                    'parked': parked_path.read_text() if parked_path.is_file() else '',
                    'stdout': stdout.getvalue(), 'error': error}

    def test_eligible_merge_ready_card_gets_one_conditional_notice(self):
        out = self.tick(merge=[(REPO.lower(), 7, SHA)], facts_now=facts())
        self.assertEqual(out['comments'], [CARD_ID])
        self.assertEqual(unconditional_merge_sentences(out['bodies'][0]), [])
        self.assertIsNone(re.search(r'\bnow\b', out['bodies'][0]))
        self.assertIn(f'{REPO.lower()}#7@{SHA}:mergeready', out['state'])

    def test_merge_ready_pr_on_held_card_gets_no_notice(self):
        held = [{'status': 'blocked'}, {'status': 'in_review', 'pending': 1}, {'descriptor': True},
                {'recovery': 1}, {'blockers': 1}]
        for changes in held:
            with self.subTest(changes=changes):
                out = self.tick(merge=[(REPO.lower(), 7, SHA)], facts_now=facts(**changes))
                self.assertEqual(out['comments'], [])
                self.assertEqual(out['state'], {})

    def test_clean_review_on_a_card_blocked_by_a_ciso_decision_gets_no_notice(self):
        out = self.tick(merge=[(REPO.lower(), 7, SHA)], facts_now=facts(blockers=1, pending=1))
        self.assertEqual(out['comments'], [])
        self.assertIn('no merge notice', out['stdout'])

    def test_merge_ready_pr_without_an_owning_card_is_reported_not_woken(self):
        out = self.tick(merge=[(REPO.lower(), 7, SHA)], card=None, facts_now=facts())
        self.assertEqual(out['comments'], [])
        self.assertIn('no open card owns this PR', out['stdout'])

    def test_live_or_scheduled_retry_card_gets_no_wake_or_notice(self):
        out = self.tick(merge=[(REPO.lower(), 7, SHA)], facts_now=facts(), live=True)
        self.assertEqual(out['comments'], [])
        self.assertIn('has a live run', out['stdout'])
        out = self.tick(stranded=[[REPO, '7', SHA]], facts_now=facts(), live=True)
        self.assertEqual(out['comments'], [])

    def test_backlog_card_gets_no_review_wake_after_a_review_error(self):
        out = self.tick(stranded=[[REPO, '7', SHA]], facts_now=facts(status='backlog'))
        self.assertEqual(out['comments'], [])

    def test_review_wakes_are_held_by_descriptor_recovery_and_blockers(self):
        for changes in ({'descriptor': True}, {'recovery': 1}, {'blockers': 1}):
            with self.subTest(changes=changes):
                out = self.tick(stranded=[[REPO, '7', SHA]], facts_now=facts(**changes))
                self.assertEqual(out['comments'], [])
                out = self.tick(unreviewed=[(REPO, 9, SHA)], facts_now=facts(**changes))
                self.assertEqual(out['comments'], [])

    def test_review_wake_still_goes_out_for_a_card_awaiting_approval(self):
        awaiting = facts(status='in_review', pending=1)
        out = self.tick(stranded=[[REPO, '7', SHA]], facts_now=awaiting)
        self.assertEqual(out['comments'], [CARD_ID])
        out = self.tick(unreviewed=[(REPO, 9, SHA)], facts_now=awaiting)
        self.assertEqual(out['comments'], [CARD_ID])

    def test_review_wake_never_orders_a_merge_without_a_condition(self):
        for stranded, unreviewed in (([[REPO, '7', SHA]], ()), ((), [(REPO, 9, SHA)])):
            with self.subTest(stranded=bool(stranded)):
                out = self.tick(stranded=stranded, unreviewed=unreviewed, facts_now=facts())
                self.assertEqual(len(out['bodies']), 1)
                self.assertEqual(unconditional_merge_sentences(out['bodies'][0]), [])
                self.assertIn('pending decision', out['bodies'][0])

    def test_eligible_card_still_gets_the_review_error_wake(self):
        out = self.tick(stranded=[[REPO, '7', SHA]], facts_now=facts())
        self.assertEqual(out['comments'], [CARD_ID])
        self.assertIn(f'{REPO}#7@{SHA}', out['state'])

    def test_eligible_unreviewed_card_still_gets_the_review_request(self):
        out = self.tick(unreviewed=[(REPO, 9, SHA)], facts_now=facts())
        self.assertEqual(out['comments'], [CARD_ID])
        self.assertIn(f'{REPO}#9@{SHA}:unreviewed', out['state'])

    def test_unreviewed_pr_on_held_card_is_parked_with_its_reason(self):
        out = self.tick(unreviewed=[(REPO, 9, SHA)], facts_now=facts(status='backlog'))
        self.assertEqual(out['comments'], [])
        self.assertIn('CARD-900: status backlog', out['parked'])

    def test_parked_list_is_rewritten_when_nothing_is_parked(self):
        out = self.tick(unreviewed=[(REPO, 9, SHA)], facts_now=facts(), parked_before='CARD-900: status backlog\n')
        self.assertEqual(out['parked'], '')

    def test_out_of_focus_card_gets_no_wake_while_focus_gate_is_active(self):
        out = self.tick(stranded=[[REPO, '7', SHA]], facts_now=facts(in_focus=False), focus=True)
        self.assertEqual(out['comments'], [])
        out = self.tick(stranded=[[REPO, '7', SHA]], facts_now=facts(in_focus=False), focus=False)
        self.assertEqual(out['comments'], [CARD_ID])

    def test_failed_eligibility_check_holds_only_that_card(self):
        cards = {'7': (CARD_ID, 'CARD-900'), '9': (OTHER_ID, 'CARD-901')}

        def facts_fn(issue_id, focus_on):
            if issue_id == CARD_ID:
                raise ValueError('unexpected count')
            return facts()

        out = self.tick(stranded=[[REPO, '7', SHA], [REPO, '9', SHA]], cards=cards, facts_fn=facts_fn)
        self.assertEqual(out['comments'], [OTHER_ID])
        self.assertEqual(list(out['state']), [f'{REPO}#9@{SHA}'])

    def test_failed_query_on_the_merge_path_sends_no_notice(self):
        def failing_query(issue_id, focus_on):
            raise subprocess.CalledProcessError(1, 'psql')

        out = self.tick(merge=[(REPO.lower(), 7, SHA)], facts_fn=failing_query)
        self.assertEqual(out['comments'], [])
        self.assertEqual(out['state'], {})

    def test_timed_out_eligibility_query_sends_no_wake_or_notice(self):
        def slow_query(issue_id, focus_on):
            raise subprocess.TimeoutExpired('psql', r.PSQL_TIMEOUT_S)

        for kind in ({'stranded': [[REPO, '7', SHA]]}, {'unreviewed': [(REPO, 9, SHA)]},
                     {'merge': [(REPO.lower(), 7, SHA)]}):
            with self.subTest(kind=list(kind)):
                out = self.tick(**kind, facts_fn=slow_query)
                self.assertIsNone(out['error'])
                self.assertEqual(out['comments'], [])
                self.assertEqual(out['state'], {})

    def test_timed_out_owner_lookup_is_retried_next_tick(self):
        def slow_owner(repo, n):
            raise subprocess.TimeoutExpired('psql', r.PSQL_TIMEOUT_S)

        for kind in ({'stranded': [[REPO, '7', SHA]]}, {'merge': [(REPO.lower(), 7, SHA)]}):
            with self.subTest(kind=list(kind)):
                out = self.tick(**kind, card=slow_owner, facts_now=facts())
                self.assertIsNone(out['error'])
                self.assertEqual(out['comments'], [])
                self.assertEqual(out['state'], {})
                self.assertIn('owner lookup failed (TimeoutExpired); retry next tick', out['stdout'])

    def test_timed_out_pr_lookup_holds_the_card_and_retries_next_tick(self):
        real_pr_head = r.pr_head
        for kind in ({'stranded': [[REPO, '7', SHA]]}, {'unreviewed': [(REPO, 9, SHA)]},
                     {'merge': [(REPO.lower(), 7, SHA)]}):
            with self.subTest(kind=list(kind)), mock.patch.object(r.subprocess, 'run', side_effect=timed_out):
                out = self.tick(**kind, facts_now=facts(), head=real_pr_head)
                self.assertIsNone(out['error'])
                self.assertEqual(out['comments'], [])
                self.assertEqual(out['state'], {})
                self.assertIn('gh pr timed out', out['stdout'])
                self.assertIn('PR lookup failed, retry next tick', out['stdout'])

    def test_timed_out_comment_post_is_a_failed_post_retried_next_tick(self):
        real_comment = r.comment
        for kind in ({'stranded': [[REPO, '7', SHA]]}, {'merge': [(REPO.lower(), 7, SHA)]}):
            with self.subTest(kind=list(kind)), mock.patch.object(r.subprocess, 'run', side_effect=timed_out):
                out = self.tick(**kind, facts_now=facts(), http=real_comment)
                self.assertIsNone(out['error'])
                self.assertEqual(out['comments'], [CARD_ID])
                self.assertEqual(out['state'], {})
                self.assertIn('comment failed (HTTP timeout); retry next tick', out['stdout'])

    def test_recorded_key_is_not_repeated(self):
        out = self.tick(stranded=[[REPO, '7', SHA]], facts_now=facts(),
                        state={f'{REPO}#7@{SHA}': 'CARD-900 200 2026-10-08T00:00:00Z'})
        self.assertEqual(out['comments'], [])

    def test_dry_run_never_comments_or_records_state(self):
        out = self.tick(merge=[(REPO.lower(), 7, SHA)], facts_now=facts(), apply=False)
        self.assertEqual(out['comments'], [])
        self.assertEqual(out['state'], {})

    def test_failed_pr_lookup_is_retried_not_marked_moot(self):
        out = self.tick(stranded=[[REPO, '7', SHA]], facts_now=facts(), head=(None, None))
        self.assertEqual(out['comments'], [])
        self.assertEqual(out['state'], {})
        self.assertIn('PR lookup failed', out['stdout'])

    def test_closed_pr_is_still_marked_moot(self):
        out = self.tick(stranded=[[REPO, '7', SHA]], facts_now=facts(), head=('CLOSED', SHA))
        self.assertEqual(out['comments'], [])
        self.assertEqual(out['state'], {f'{REPO}#7@{SHA}': 'moot'})

    def test_failed_review_wake_is_not_recorded_so_the_next_tick_retries(self):
        out = self.tick(stranded=[[REPO, '7', SHA]], facts_now=facts(), http='500')
        self.assertEqual(out['comments'], [CARD_ID])
        self.assertEqual(out['state'], {})

    def test_failed_merge_notice_is_not_recorded(self):
        out = self.tick(merge=[(REPO.lower(), 7, SHA)], facts_now=facts(), http='000')
        self.assertEqual(out['comments'], [CARD_ID])
        self.assertEqual(out['state'], {})

    def test_posts_made_before_a_later_failure_stay_recorded(self):
        out = self.tick(stranded=[[REPO, '7', SHA]], facts_now=facts(), broken_parked=True)
        self.assertIsInstance(out['error'], IsADirectoryError)
        self.assertEqual(out['comments'], [CARD_ID])
        self.assertEqual(list(out['state']), [f'{REPO}#7@{SHA}'])

    def test_merge_notices_posted_before_a_later_failure_stay_recorded(self):
        out = self.tick(merge=[(REPO.lower(), 7, SHA)], facts_now=facts(), broken_parked=True)
        self.assertIsInstance(out['error'], IsADirectoryError)
        self.assertEqual(list(out['state']), [f'{REPO.lower()}#7@{SHA}:mergeready'])

    def test_owner_lookup_failure_skips_only_that_pr(self):
        out = self.tick(stranded=[[REPO, '7', SHA], [REPO, '9', SHA]], cards={'9': (OTHER_ID, 'CARD-901')},
                        facts_now=facts())
        self.assertIsNone(out['error'])
        self.assertEqual(out['comments'], [OTHER_ID])
        self.assertIn('owner lookup failed', out['stdout'])

    def test_host_under_pressure_starts_no_wakes(self):
        out = self.tick(stranded=[[REPO, '7', SHA]], facts_now=facts(), host=(False, 'disk 97%'))
        self.assertEqual(out['comments'], [])
        self.assertEqual(out['state'], {})
        self.assertIn('host under pressure', out['stdout'])

    def test_failed_posts_count_toward_the_tick_cap(self):
        stranded = [[REPO, str(n), SHA] for n in range(1, r.MAX_PER_TICK + 6)]
        out = self.tick(stranded=stranded, facts_now=facts(), http='500')
        self.assertEqual(len(out['comments']), r.MAX_PER_TICK)
        self.assertEqual(out['state'], {})


class DedupGuard(unittest.TestCase):
    """Error-kind heads consult review_dedup over the head's rows.

    The stranded rows carry the head's recent server row states as a comma
    blob (4th column); legacy 3-tuples mean one known error (existing tests).
    """
    tick = Wiring.tick

    def test_second_error_suppresses_the_wake(self):
        out = self.tick(stranded=[[REPO, '7', SHA, 'error,error']], facts_now=facts())
        self.assertIsNone(out['error'])
        self.assertEqual(out['comments'], [])
        self.assertEqual(out['state'], {})
        self.assertIn('retry budget', out['stdout'])

    def test_error_on_an_already_completed_head_suppresses_the_wake(self):
        out = self.tick(stranded=[[REPO, '7', SHA, 'completed,error']], facts_now=facts())
        self.assertIsNone(out['error'])
        self.assertEqual(out['comments'], [])
        self.assertEqual(out['state'], {})

    def test_error_behind_a_live_attempt_suppresses_the_wake(self):
        out = self.tick(stranded=[[REPO, '7', SHA, 'running,error']], facts_now=facts())
        self.assertIsNone(out['error'])
        self.assertEqual(out['comments'], [])
        self.assertEqual(out['state'], {})

    def test_first_error_still_wakes(self):
        out = self.tick(stranded=[[REPO, '7', SHA, 'error']], facts_now=facts())
        self.assertIsNone(out['error'])
        self.assertEqual(out['comments'], [CARD_ID])

    def test_unrecognized_row_state_suppresses_the_wake(self):
        out = self.tick(stranded=[[REPO, '7', SHA, 'error,splines_reticulated']], facts_now=facts())
        self.assertIsNone(out['error'])
        self.assertEqual(out['comments'], [])
        self.assertEqual(out['state'], {})


class GhAndCurl(unittest.TestCase):
    def test_pr_head_is_none_when_gh_output_is_not_json(self):
        with mock.patch.object(r.subprocess, 'run', return_value=types.SimpleNamespace(stdout='HTTP 502')):
            self.assertEqual(r.pr_head(REPO, 7, {}), (None, None))

    def test_comment_returns_the_http_status(self):
        with mock.patch.object(r.subprocess, 'run', return_value=types.SimpleNamespace(stdout='503')):
            self.assertEqual(r.comment(CARD_ID, 'hello'), '503')

    def test_gh_outage_is_reported_not_read_as_zero_prs(self):
        out = io.StringIO()
        with mock.patch.object(r.subprocess, 'run', return_value=types.SimpleNamespace(stdout='')), \
                contextlib.redirect_stdout(out):
            self.assertEqual(r.merge_ready({}), [])
        self.assertIn('gave no JSON', out.getvalue())


class Timeouts(unittest.TestCase):
    def test_every_subprocess_run_is_bounded(self):
        source = Path(r.__file__).read_text()
        self.assertGreaterEqual(source.count('subprocess.run('), 3)
        self.assertEqual(untimed_runs(source), [])
        self.assertEqual(untimed_runs('import subprocess\nsubprocess.run(["gh"], timeout=5)\nsubprocess.run(["gh"])\n'), [3])

    def test_timeouts_are_the_named_constants(self):
        run = mock.Mock(return_value=types.SimpleNamespace(stdout=''))
        with mock.patch.object(r.subprocess, 'run', run), contextlib.redirect_stdout(io.StringIO()):
            r.psql('select 1')
            r.gh_env()
            r.pr_head(REPO, 7, {})
            r.merge_ready({})
            r.comment(CARD_ID, 'hello')
        timeouts = [c.kwargs['timeout'] for c in run.call_args_list]
        self.assertEqual(timeouts, [r.PSQL_TIMEOUT_S, r.GH_TIMEOUT_S, r.GH_TIMEOUT_S]
                         + [r.GH_TIMEOUT_S] * len(r.REPOS) + [r.CURL_TIMEOUT_S + 10])
        argv = run.call_args.args[0]
        self.assertEqual(argv[argv.index('--max-time') + 1], f'{r.CURL_TIMEOUT_S:g}')

    def test_env_overrides_a_default_and_bad_values_fail_loudly(self):
        with mock.patch.dict(os.environ, {'REVIEW_RERQ_GH_TIMEOUT_S': '7.5'}):
            self.assertEqual(r._seconds('REVIEW_RERQ_GH_TIMEOUT_S', 60), 7.5)
        with mock.patch.dict(os.environ, {}):
            os.environ.pop('REVIEW_RERQ_GH_TIMEOUT_S', None)
            self.assertEqual(r._seconds('REVIEW_RERQ_GH_TIMEOUT_S', 60), 60)
        for bad in ('0', '-5', 'nan', 'inf', '3601'):
            with self.subTest(bad=bad), mock.patch.dict(os.environ, {'REVIEW_RERQ_GH_TIMEOUT_S': bad}):
                with self.assertRaises(SystemExit):
                    r._seconds('REVIEW_RERQ_GH_TIMEOUT_S', 60)

    def test_timed_out_psql_raises_so_callers_take_their_failure_path(self):
        with mock.patch.object(r.subprocess, 'run', side_effect=timed_out):
            with self.assertRaises(subprocess.TimeoutExpired):
                r.psql('select 1')
            self.assertEqual(r.card_hold(CARD_ID), 'eligibility check failed (TimeoutExpired)')

    def test_timed_out_pr_view_is_a_failed_lookup(self):
        with mock.patch.object(r.subprocess, 'run', side_effect=timed_out), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(r.pr_head(REPO, 7, {}), (None, None))

    def test_timed_out_token_fetch_leaves_gh_unauthenticated(self):
        with mock.patch.object(r.subprocess, 'run', side_effect=timed_out), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(r.gh_env()['GH_TOKEN'], '')

    def test_timed_out_comment_post_is_not_a_2xx(self):
        with mock.patch.object(r.subprocess, 'run', side_effect=timed_out):
            code = r.comment(CARD_ID, 'hello')
        self.assertEqual(code, 'timeout')
        self.assertFalse(code.startswith('2'))

    def test_timed_out_pr_list_skips_the_repo_and_reads_no_prs(self):
        for fn in (r.merge_ready, r.unreviewed):
            out = io.StringIO()
            with self.subTest(fn=fn.__name__), mock.patch.object(r.subprocess, 'run', side_effect=timed_out), \
                    contextlib.redirect_stdout(out):
                self.assertEqual(fn({}), [])
            self.assertIn('gh pr timed out', out.getvalue())
            self.assertIn('gave no JSON; skipped this tick', out.getvalue())

    def test_timed_out_commit_date_skips_the_pr(self):
        prs = [{'number': 9, 'isDraft': False, 'mergeStateStatus': 'BLOCKED', 'headRefOid': SHA, 'statusCheckRollup': []}]

        def run(cmd, **kwargs):
            if cmd[1] == 'api':
                timed_out(cmd, **kwargs)
            return types.SimpleNamespace(stdout=json.dumps(prs))

        out = io.StringIO()
        with mock.patch.object(r.subprocess, 'run', side_effect=run), contextlib.redirect_stdout(out):
            self.assertEqual(r.unreviewed({}), [])
        self.assertIn('commit date unreadable; skipped this tick', out.getvalue())


class CommitAge(unittest.TestCase):
    def setUp(self):
        self.addCleanup(time.tzset)
        env = mock.patch.dict(os.environ, {'TZ': 'Europe/Berlin'})
        env.start()
        self.addCleanup(env.stop)
        time.tzset()

    def unreviewed_for(self, commit_date):
        now = calendar.timegm((2026, 7, 1, 12, 15, 0, 0, 0, 0))

        def run(cmd, **kwargs):
            if cmd[1] == 'pr':
                prs = [{'number': 9, 'isDraft': False, 'mergeStateStatus': 'BLOCKED', 'headRefOid': SHA,
                        'statusCheckRollup': []}]
                return types.SimpleNamespace(stdout=json.dumps(prs))
            return types.SimpleNamespace(stdout=f'{commit_date}\n')

        with mock.patch.object(r.subprocess, 'run', side_effect=run), \
                mock.patch.object(r.time, 'time', return_value=now):
            return r.unreviewed({})

    def test_commit_date_is_read_as_utc_during_daylight_time(self):
        self.assertEqual(self.unreviewed_for('2026-07-01T10:30:00Z'), [])
        self.assertEqual(len(self.unreviewed_for('2026-07-01T09:00:00Z')), len(r.REPOS))


if __name__ == '__main__':
    unittest.main()
