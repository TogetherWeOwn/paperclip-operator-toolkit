import importlib.util
import json
from pathlib import Path
import re
import subprocess
import tempfile
import types
import unittest
from unittest import mock

import orphan_prs as op

REPO = 'TogetherWeOwn/two-web-next'
OTHER = 'TogetherWeOwn/two-bot-next'


def pr(repo=REPO, number=1):
    return {'number': number, 'title': 'fix: fixture', 'author': {'login': 'fixture'}, 'isDraft': False,
            'createdAt': '2020-01-01T00:00:00Z', 'url': f'https://github.com/{repo}/pull/{number}',
            'mergeStateStatus': 'CLEAN'}


class TimeoutPass(unittest.TestCase):
    def run_pass(self, fail=lambda args, kwargs: False, prs=None, apply=True,
                 referenced_numbers=None, cards=None, linked=None, any_linked=None,
                 curl_responder=None):
        calls = []
        prs = {REPO: [pr()]} if prs is None else prs
        repos = {repo: ('Fixture Engineer', 'Fixture Project') for repo in prs}
        cards = {} if cards is None else cards
        linked = set() if linked is None else set(linked)
        any_linked = set() if any_linked is None else set(any_linked)
        referenced_numbers = None if referenced_numbers is None else set(referenced_numbers)

        def pr_number(sql):
            m = re.search(r'pull/(\d+)', sql)
            return int(m.group(1)) if m else None

        def fake_run(args, **kwargs):
            calls.append((args, kwargs))
            if fail(args, kwargs):
                raise subprocess.TimeoutExpired(args, kwargs['timeout'], output=b'partial fixture output')
            if args[0].endswith('/gh_token.sh'):
                out = 'offline-fixture\n'
            elif args[0] == 'docker':
                sql = kwargs['input']
                if 'select name, id from agents' in sql:
                    out = 'Fixture Engineer\x1fagent-1\n'
                elif 'select name, id from projects' in sql:
                    out = 'Fixture Project\x1fproject-1\n'
                elif 'from issue_work_products where issue_id=' in sql:
                    out = '1\n' if pr_number(sql) in linked else ''
                elif 'select i.id, i.identifier' in sql:
                    num = pr_number(sql)
                    if num in any_linked:
                        out = ''
                    elif num in cards:
                        cid, ident = cards[num]
                        out = f'{cid}\x1f{ident}\n'
                    else:
                        out = ''
                elif 'select 1 from issues i where' in sql:
                    num = pr_number(sql)
                    out = ('1\n' if referenced_numbers is not None and num in referenced_numbers else '')
                else:
                    out = ''
            elif args[0] == 'gh':
                out = json.dumps(prs[args[args.index('-R') + 1]])
            elif args[0] == 'curl':
                resp = (curl_responder(list(args)) if curl_responder is not None
                        else {'id': 'card-1', 'identifier': 'CARD-900'})
                out = json.dumps(resp)
            else:
                self.fail(f'unexpected subprocess: {args[0]}')
            return types.SimpleNamespace(returncode=0, stdout=out, stderr='')

        with tempfile.TemporaryDirectory() as tmp:
            # Nested and non-existent: every run honestly exercises the
            # missing-parent creation in log_line.
            log_path = Path(tmp) / 'nested' / 'state' / 'orphan-prs-operator-actions.log'
            with mock.patch.object(op, 'ROOT', tmp), mock.patch.object(op, 'STATE_DIR', tmp), \
                    mock.patch.object(op, 'LOG_PATH', log_path), \
                    mock.patch.object(op, 'REPOS', repos), mock.patch.object(op, 'APPLY', apply), \
                    mock.patch.object(op.subprocess, 'run', side_effect=fake_run), \
                    mock.patch('builtins.print') as output:
                op.main()
            log = log_path.read_text() if log_path.exists() else ''
        return calls, output, log

    @staticmethod
    def writes(calls):
        return [args for args, _ in calls if args[0] == 'curl']

    @staticmethod
    def bodies(calls):
        return [json.loads(args[args.index('--data-binary') + 1]) for args in TimeoutPass.writes(calls)]

    def test_gh_timeout_writes_no_cards(self):
        calls, output, log = self.run_pass(lambda a, k: a[0] == 'gh')
        self.assertEqual(self.writes(calls), [])
        self.assertEqual(log, '')
        self.assertTrue(any('gh pr list timed out' in c.args[0] for c in output.call_args_list))

    def test_gh_timeout_skips_only_affected_repo(self):
        calls, _, _ = self.run_pass(lambda a, k: a[0] == 'gh' and REPO in a,
                                  prs={REPO: [pr()], OTHER: [pr(OTHER)]})
        bodies = self.bodies(calls)
        self.assertEqual(len(bodies), 2)
        self.assertEqual(bodies[0]['title'], 'Shepherd two-bot-next#1 to merge')
        self.assertEqual(bodies[1]['url'], f'https://github.com/{OTHER}/pull/1')

    def test_token_timeout_skips_all_repos_without_writes(self):
        calls, output, log = self.run_pass(lambda a, k: a[0].endswith('/gh_token.sh'))
        self.assertEqual(len(calls), 1)
        self.assertEqual(log, '')
        output.assert_called_once_with(f'gh_token.sh timed out after {op.TOKEN_TIMEOUT_SECONDS}s; all repos skipped',
                                       file=op.sys.stderr)

    def test_roster_psql_timeout_skips_all_repos_without_writes(self):
        for table in ('agents', 'projects'):
            with self.subTest(table=table):
                calls, output, log = self.run_pass(lambda a, k: a[0] == 'docker' and f'from {table}' in k['input'])
                self.assertFalse(any(a[0] == 'gh' for a, _ in calls))
                self.assertEqual(self.writes(calls), [])
                self.assertEqual(log, '')
                output.assert_called_once_with(f'psql roster read timed out after {op.PSQL_TIMEOUT_SECONDS}s; all repos skipped',
                                               file=op.sys.stderr)

    def test_reference_psql_timeout_discards_prior_candidates_in_repo(self):
        # The first PR was unreferenced; a timeout on the second invalidates the whole repo batch.
        calls, output, _ = self.run_pass(
            lambda a, k: a[0] == 'docker' and 'pull/2' in k['input'],
            prs={REPO: [pr(number=1), pr(number=2)], OTHER: [pr(OTHER)]})
        bodies = self.bodies(calls)
        self.assertEqual(len(bodies), 2)
        self.assertEqual(bodies[0]['title'], 'Shepherd two-bot-next#1 to merge')
        self.assertTrue(any('psql reference read timed out' in c.args[0] for c in output.call_args_list))

    def test_every_exercised_subprocess_uses_its_named_bound(self):
        calls, _, log = self.run_pass()
        self.assertEqual(len(calls), 7)
        for args, kwargs in calls:
            expected = (op.TOKEN_TIMEOUT_SECONDS if args[0].endswith('/gh_token.sh') else
                        {'docker': op.PSQL_TIMEOUT_SECONDS, 'gh': op.GH_TIMEOUT_SECONDS,
                         'curl': op.CURL_TIMEOUT_SECONDS}[args[0]])
            self.assertEqual(kwargs['timeout'], expected)
        bodies = self.bodies(calls)
        self.assertEqual(bodies[0]['assigneeAgentId'], 'agent-1')
        self.assertEqual(bodies[0]['projectId'], 'project-1')
        self.assertEqual(bodies[1]['type'], 'pull_request')
        self.assertIn('created CARD-900', log)

    def test_card_write_timeout_is_unknown_not_success_or_retried(self):
        calls, output, log = self.run_pass(lambda a, k: a[0] == 'curl')
        self.assertEqual(len(self.writes(calls)), 1)
        self.assertIn('attempting', log)
        self.assertNotIn('created CARD-900', log)
        self.assertFalse(any(c.args[0] == 'created' for c in output.call_args_list))
        self.assertTrue(any('outcome unknown, not retried' in c.args[0] for c in output.call_args_list))

    def test_card_create_error_json_logs_no_created_line(self):
        def responder(args):
            joined = ' '.join(args)
            if 'work-products' in joined:
                return {'id': 'wp-1', 'identifier': 'CARD-900'}
            if '/companies/' in joined:
                return {'error': 'forbidden'}
            return {'id': 'card-1', 'identifier': 'CARD-900'}

        calls, output, log = self.run_pass(curl_responder=responder)
        self.assertNotIn('created CARD-900', log)
        self.assertFalse(any(c.args[0] == 'created' for c in output.call_args_list))
        self.assertFalse(any('work-products' in ' '.join(a) for a, _ in calls))
        self.assertTrue(any('card POST failed' in c.args[0] for c in output.call_args_list))

    def test_attempting_line_precedes_card_post(self):
        calls, _, log = self.run_pass()
        self.assertIn('attempting', log)
        self.assertIn('created CARD-900', log)
        self.assertLess(log.index('attempting'), log.index('created CARD-900'))

    def test_apply_creates_missing_log_parents_on_a_clean_tree(self):
        calls, _, log = self.run_pass()
        self.assertIn('attempting', log)
        self.assertIn('created CARD-900', log)

    def test_api_base_comes_from_paperclip_api_env(self):
        # A hard-coded host regressing into api() must fail: drive api()
        # with a sentinel PAPERCLIP_API and require it in the curl argv.
        sentinel = 'https://sentinel-api.example/api'
        seen = {}

        def fake_run(args, **kwargs):
            seen['argv'] = list(args)
            return types.SimpleNamespace(returncode=0, stdout='{}', stderr='')

        with mock.patch.object(op, 'PAPERCLIP_API', sentinel), \
                mock.patch.object(op.subprocess, 'run', side_effect=fake_run):
            op.api('POST', 'issues/x/comments', {'body': 'probe'})
        self.assertTrue(any(sentinel in a for a in seen['argv']),
                        f'sentinel API base missing from curl argv: {seen["argv"]}')
        self.assertFalse(any('paperclip-cloud' in a for a in seen['argv']))

    def test_log_path_defaults_under_state_dir_not_the_checkout(self):
        self.assertTrue(hasattr(op, 'LOG_PATH'))
        self.assertNotIn('ops/worker-vps', str(op.LOG_PATH))

    def test_log_line_creates_missing_parents_and_never_aborts(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'nested' / 'dir' / 'operator-actions.log'
            with mock.patch.object(op, 'LOG_PATH', target):
                op.log_line('clean-tree probe')
            self.assertIn('clean-tree probe', target.read_text())

    def test_log_line_swallows_oserror_and_warns(self):
        # LOG_PATH under a regular file: the write must fail into a stderr
        # notice, never raise out of the write loop.
        with tempfile.TemporaryDirectory() as tmp:
            blocker = Path(tmp) / 'blocker'
            blocker.write_text('not a directory')
            with mock.patch.object(op, 'LOG_PATH', blocker / 'operator-actions.log'), \
                    mock.patch('builtins.print') as output:
                op.log_line('must not raise')
            self.assertTrue(any('log write failed' in c.args[0]
                                for c in output.call_args_list))

    def test_run_deadline_defers_remaining_cards(self):
        prs = {REPO: [pr(number=1), pr(number=2)]}
        with mock.patch.object(op.time, 'monotonic', side_effect=[0.0, 0.0, op.RUN_DEADLINE_SECONDS + 1.0]):
            calls, output, log = self.run_pass(prs=prs)
        bodies = self.bodies(calls)
        self.assertEqual(len(bodies), 2)
        self.assertTrue(any('run deadline' in c.args[0] and 'deferred' in c.args[0]
                            for c in output.call_args_list))

    def test_backfill_links_missing_work_product(self):
        calls, _, log = self.run_pass(referenced_numbers={1}, cards={1: ('card-id-1', 'CARD-901')})
        bodies = self.bodies(calls)
        self.assertEqual(len(bodies), 1)
        self.assertEqual(bodies[0]['title'], f'{REPO}#1')
        self.assertIn('backfilled work product for', log)
        self.assertIn('CARD-901', log)

    def test_backfill_skips_when_link_already_present(self):
        calls, _, log = self.run_pass(referenced_numbers={1}, cards={1: ('card-id-1', 'CARD-901')},
                                       linked={1})
        self.assertEqual(self.writes(calls), [])
        self.assertNotIn('backfilled', log)

    def test_backfill_defers_when_lookup_times_out(self):
        calls, output, _ = self.run_pass(
            lambda a, k: a[0] == 'docker' and 'select i.id, i.identifier' in k.get('input', ''),
            referenced_numbers={1}, cards={1: ('card-id-1', 'CARD-901')})
        self.assertEqual(self.writes(calls), [])
        self.assertTrue(any('backfill deferred' in c.args[0] for c in output.call_args_list))

    def test_backfill_makes_no_post_when_work_product_check_times_out(self):
        calls, output, _ = self.run_pass(
            lambda a, k: a[0] == 'docker' and 'from issue_work_products where issue_id=' in k.get('input', ''),
            referenced_numbers={1}, cards={1: ('card-id-1', 'CARD-901')})
        self.assertEqual(self.writes(calls), [])
        self.assertTrue(any('backfill deferred' in c.args[0] for c in output.call_args_list))

    def test_backfill_post_timeout_logs_no_backfilled_line(self):
        calls, output, log = self.run_pass(
            lambda a, k: a[0] == 'curl' and 'work-products' in ' '.join(a),
            referenced_numbers={1}, cards={1: ('card-id-1', 'CARD-901')})
        self.assertEqual(len(self.writes(calls)), 1)
        self.assertNotIn('backfilled', log)
        self.assertTrue(any('outcome unknown, not retried' in c.args[0] for c in output.call_args_list))

    def test_backfill_error_json_is_failure_not_success(self):
        calls, _, log = self.run_pass(
            referenced_numbers={1}, cards={1: ('card-id-1', 'CARD-901')},
            curl_responder=lambda a: {'error': 'forbidden'} if 'work-products' in ' '.join(a)
            else {'id': 'card-1', 'identifier': 'CARD-900'})
        self.assertEqual(len(self.writes(calls)), 1)
        self.assertNotIn('backfilled', log)

    def test_backfill_loop_honors_deadline(self):
        prs = {REPO: [pr(number=1), pr(number=2)]}
        cards = {1: ('card-id-1', 'CARD-901'), 2: ('card-id-2', 'CARD-902')}
        with mock.patch.object(op.time, 'monotonic',
                               side_effect=[0.0, 0.0, op.RUN_DEADLINE_SECONDS + 1.0]):
            calls, output, log = self.run_pass(prs=prs, referenced_numbers={1, 2}, cards=cards)
        self.assertEqual(len(self.writes(calls)), 1)
        self.assertIn('CARD-901', log)
        self.assertNotIn('CARD-902', log)
        self.assertTrue(any('run deadline' in c.args[0] and 'deferred' in c.args[0]
                            for c in output.call_args_list))

    def test_backfill_scans_past_max_new_healthy_cards(self):
        prs = {REPO: [pr(number=n) for n in range(1, 8)]}
        cards = {n: (f'card-id-{n}', f'CARD-90{n}') for n in range(1, 8)}
        calls, _, log = self.run_pass(prs=prs, referenced_numbers=set(range(1, 8)),
                                       cards=cards, linked={1, 2, 3, 4, 5, 6})
        bodies = self.bodies(calls)
        self.assertEqual(len(bodies), 1)
        self.assertEqual(bodies[0]['title'], f'{REPO}#7')
        self.assertIn('CARD-907', log)

    def test_backfill_caps_writes_at_max_new(self):
        prs = {REPO: [pr(number=n) for n in range(1, 8)]}
        cards = {n: (f'card-id-{n}', f'CARD-90{n}') for n in range(1, 8)}
        calls, _, _ = self.run_pass(prs=prs, referenced_numbers=set(range(1, 8)), cards=cards)
        self.assertEqual(len(self.writes(calls)), op.MAX_NEW)

    def test_backfill_skips_when_any_card_already_links_pr(self):
        calls, _, log = self.run_pass(referenced_numbers={1}, cards={1: ('card-id-1', 'CARD-901')},
                                       any_linked={1})
        self.assertEqual(self.writes(calls), [])
        self.assertNotIn('backfilled', log)

    def test_find_open_card_targets_sweeper_card_only(self):
        calls, _, _ = self.run_pass(referenced_numbers={1}, cards={1: ('card-id-1', 'CARD-901')})
        finds = [kwargs['input'] for args, kwargs in calls
                 if args[0] == 'docker' and 'select i.id, i.identifier' in kwargs.get('input', '')]
        self.assertEqual(len(finds), 1)
        sql = finds[0]
        self.assertIn('Shepherd two-web-next#1 to merge', sql)
        self.assertIn('Found by the orphan-PR sweeper', sql)
        self.assertIn('not exists', sql)
        self.assertIn('order by i.created_at', sql)

    def test_dry_run_remains_read_only(self):
        calls, output, log = self.run_pass(apply=False)
        self.assertEqual(self.writes(calls), [])
        self.assertEqual(log, '')
        output.assert_any_call('1 orphan PR(s)')

    def test_existing_release_draft_age_and_reference_filters_survive(self):
        prs = [dict(pr(number=1), title='chore(main): release 1.0'), dict(pr(number=2), isDraft=True),
               dict(pr(number=3), createdAt='2099-01-01T00:00:00Z'), pr(number=4)]
        with mock.patch.object(op, 'referenced', return_value=True):
            calls, _, _ = self.run_pass(prs={REPO: prs})
        self.assertEqual(self.writes(calls), [])


class TimeoutConfig(unittest.TestCase):
    def test_module_constants_use_environment_overrides(self):
        env = {'ORPHAN_PRS_PSQL_TIMEOUT_SECONDS': '11', 'ORPHAN_PRS_CURL_TIMEOUT_SECONDS': '12',
               'ORPHAN_PRS_TOKEN_TIMEOUT_SECONDS': '13', 'ORPHAN_PRS_GH_TIMEOUT_SECONDS': '14',
               'ORPHAN_PRS_RUN_DEADLINE_SECONDS': '15'}
        spec = importlib.util.spec_from_file_location('orphan_prs_config_fixture', op.__file__)
        module = importlib.util.module_from_spec(spec)
        with mock.patch.dict(op.os.environ, env):
            spec.loader.exec_module(module)
        self.assertEqual((module.PSQL_TIMEOUT_SECONDS, module.CURL_TIMEOUT_SECONDS,
                          module.TOKEN_TIMEOUT_SECONDS, module.GH_TIMEOUT_SECONDS,
                          module.RUN_DEADLINE_SECONDS), (11, 12, 13, 14, 15))

    def test_run_deadline_sits_below_parent_step_bound(self):
        self.assertLess(op.RUN_DEADLINE_SECONDS, op.PARENT_STEP_BOUND_SECONDS)

    def test_invalid_timeouts_fail_before_any_subprocess(self):
        for value in ('0', '-1', 'nan', 'inf', 'not-a-number'):
            with self.subTest(value=value), mock.patch.dict(op.os.environ, {'ORPHAN_PRS_GH_TIMEOUT_SECONDS': value}):
                spec = importlib.util.spec_from_file_location('orphan_prs_invalid_fixture', op.__file__)
                with mock.patch.object(op.subprocess, 'run') as run, self.assertRaises(ValueError):
                    spec.loader.exec_module(importlib.util.module_from_spec(spec))
                run.assert_not_called()


class ShepherdCardText(unittest.TestCase):
    def test_review_step_has_the_same_head_dedup_rule(self):
        text = op.card_description('https://github.com/TogetherWeOwn/two-web-next/pull/1')
        self.assertIn('at most once per head', text)
        self.assertIn('already in flight or done', text)
        self.assertIn('Paperclip Review', text)
