#!/usr/bin/env python3
"""Focused offline red-main contracts. Every child gets a fresh environment.

No sockets or live services: executable CI/board/curl fakes read synthetic JSON.
RED_MAIN_TEST_TOOL selects a staged script for red controls/mutation tests only.
"""
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
TOOL = Path(os.environ.get("RED_MAIN_TEST_TOOL", ROOT / "red_main_poll.sh"))
REPO = "example/red"
SHA_A = "a" * 40
SHA_B = "b" * 40
GH_CANARY = "synthetic-ci-credential"
BOARD_CANARY = "synthetic-board-credential"


def check(name, conclusion="failure", sha=SHA_A, run_id=1, status="completed"):
    return {"id": run_id, "name": name, "status": status, "conclusion": conclusion,
            "head_sha": sha, "started_at": "2026-01-01T00:00:00Z",
            "completed_at": "2026-01-01T00:00:03Z" if status == "completed" else None}


def verdict(repo, kind="fail", reason="failed: synthetic test", **extra):
    rc = {"pass": 0, "fail": 1, "pending": 2, "unknown": 3, "non-started": 5}[kind]
    body = {"repo": repo, "ref": "main", "verdict": kind, "reason": reason,
            "exitCode": rc, "signalsObserved": 2 if kind != "unknown" else 0,
            "sources": {"checkRuns": "read", "commitStatuses": "denied", "workflowRuns": "denied"},
            "nonStarted": [], "nonStartedProbe": "clean"}
    body.update(extra)
    return {"exit": rc, "body": body}


def signature(names):
    # Independent v1 oracle: ASCII lowercasing, sorted set, no trailing newline.
    lower = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")
    material = "\n".join(sorted({name.translate(lower) for name in names}))
    return hashlib.sha1(material.encode("utf-8")).hexdigest()[:8]


FAKE = r'''#!/usr/bin/python3
import json, pathlib, stat, sys, urllib.parse
CONFIG, TRACE = CONFIG_PATH, TRACE_PATH
import os
assert all(k not in os.environ for k in ('GITHUB_TOKEN', 'PAPERCLIP_API_KEY', 'HTTPS_PROXY', 'PYTHONPATH', 'BASH_ENV')), 'inherited config/alternate credentials forbidden in transport'
config = json.loads(pathlib.Path(CONFIG).read_text())
def record(item):
    # Never record credentials, response bodies or headers, even synthetic ones.
    with open(TRACE, 'a') as f: f.write(json.dumps(item) + '\n')
def emit(spec):
    if 'raw' in spec: sys.stdout.write(spec['raw'])
    else: sys.stdout.write(json.dumps(spec.get('body', [])))
    raise SystemExit(spec.get('exit', 0))
mode = pathlib.Path(sys.argv[0]).name
if mode == 'ci-reader':
    assert sys.argv[1] == '--quiet' and sys.argv[3] == 'main'
    record({'kind': 'ci', 'repo': sys.argv[2], 'argv': sys.argv[1:]})
    emit(config['ci'][sys.argv[2]])
if mode == 'board-reader':
    record({'kind': 'board'})
    emit(config['board'])
assert mode == 'curl', mode
args = sys.argv[1:]
url = next((a for a in args if a.startswith(('https://', 'http://'))), '')
u = urllib.parse.urlsplit(url)
assert u.scheme == 'https' and u.hostname in ('ci.example.invalid', 'board.example.invalid'), 'offline fake rejects other hosts'
assert '-X' not in args and '--request' not in args and not any(a in args for a in ('-d', '--data', '--data-binary', '--upload-file')), 'writes forbidden'
header = args[args.index('-H') + 1]
assert header.startswith('@'), 'credential must use a header file'
p = pathlib.Path(header[1:])
assert stat.S_IMODE(p.stat().st_mode) == 0o600, 'private header mode required'
auth = p.read_text()
assert 'synthetic-ci-credential' not in '\0'.join(args) and 'synthetic-board-credential' not in '\0'.join(args)
record({'kind': 'http', 'url': url, 'argv': args, 'headerMode': '0600',
        'authenticated': 'Authorization: Bearer ' in auth, 'method': 'GET'})
if u.hostname == 'board.example.invalid':
    assert 'synthetic-board-credential' in auth
    rows = config['board'].get('body', [])
    if isinstance(rows, list) and config.get('boardFilter'):
        query = urllib.parse.parse_qs(u.query)
        needle = query.get('q', [''])[0].lower()
        rows = [r for r in rows if needle in (r['title'] + ' ' + r.get('description', '')).lower()]
        rows = rows[:min(int(query.get('limit', ['500'])[0]), 1000)]
        spec = dict(config['board'], body=rows)
    else: spec = config['board']
else:
    assert 'synthetic-ci-credential' in auth
    pieces = u.path.split('/')
    repo = '/'.join(pieces[2:4])
    if '/annotations' in u.path: spec = config.get('annotations', {}).get(pieces[-2], {'body': [{'annotation_level': 'failure', 'message': 'Process completed with exit code 1.'}]})
    elif u.path.endswith('/check-runs'): spec = config['checks'][repo]
    elif u.path.endswith('/status'): spec = config.get('statuses', {}).get(repo, {'http': 403, 'body': {'message': 'denied'}})
    elif u.path.endswith('/actions/runs'): spec = config.get('runs', {}).get(repo, {'http': 403, 'body': {'message': 'denied'}})
    else: raise AssertionError('unrecognised offline endpoint')
body = spec.get('raw', json.dumps(spec.get('body', [])))
if '-o' in args: pathlib.Path(args[args.index('-o') + 1]).write_text(body)
else: sys.stdout.write(body)
if '-w' in args: sys.stdout.write(str(spec.get('http', 200)))
raise SystemExit(spec.get('exit', 0))
'''


class OfflineWorld(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="red-main-offline-")
        self.addCleanup(self.tmp.cleanup)
        self.work = Path(self.tmp.name)
        self.bin = self.work / "bin"
        self.bin.mkdir()
        self.config_path = self.work / "world.json"
        self.trace_path = self.work / "trace.jsonl"
        self.trace_path.write_text("")
        fake = FAKE.replace("CONFIG_PATH", repr(str(self.config_path))).replace("TRACE_PATH", repr(str(self.trace_path)))
        for name in ("curl", "ci-reader", "board-reader"):
            path = self.bin / name
            path.write_text(fake)
            path.chmod(0o755)
        self.config = {"ci": {}, "checks": {}, "board": {"body": []}}
        self.add_repo(REPO)
        self.env = {"PATH": str(self.bin) + ":/usr/bin:/bin", "HOME": str(self.work),
                    "TMPDIR": str(self.work), "LC_ALL": "C", "PYTHONDONTWRITEBYTECODE": "1",
                    "GH_TOKEN": GH_CANARY, "RED_MAIN_API_KEY": BOARD_CANARY,
                    "GH_API_URL": "https://ci.example.invalid", "PAPERCLIP_API_URL": "https://board.example.invalid",
                    "PAPERCLIP_COMPANY_ID": "synthetic-company", "RED_MAIN_PROD_PATH_REPOS": "[]",
                    "GH_CI_STATUS_BIN": str(self.bin / "ci-reader"),
                    "INCIDENT_SOURCE_CMD": str(self.bin / "board-reader")}

    def add_repo(self, repo, kind="fail", names=None, sha=SHA_A, reason="failed: synthetic test", **extra):
        names = ["Broker Suite", "Offline Suites"] if names is None else names
        self.config["ci"][repo] = verdict(repo, kind, reason, **extra)
        rows = [check(n, sha=sha, run_id=i+1) for i, n in enumerate(names)]
        self.config["checks"][repo] = {"body": {"total_count": len(rows), "check_runs": rows}}

    def run_tool(self, mode="snapshot", repos=None, remove=(), update=None):
        self.config_path.write_text(json.dumps(self.config))
        env = self.env.copy()
        for name in remove: env.pop(name, None)
        env.update(update or {})
        # Deliberately do not inherit os.environ. No live credentials/startup hooks/proxies.
        return subprocess.run(["/bin/bash", str(TOOL), mode, *(repos if repos is not None else [REPO])],
                              cwd=self.work, env=env, text=True, capture_output=True, timeout=20)

    def events(self):
        return [json.loads(line) for line in self.trace_path.read_text().splitlines()]

    def entries(self, result):
        return json.loads(result.stdout)["redMains"]

    def assert_refused_before_transport(self, result):
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assertEqual(self.events(), [])

    def assert_unknown(self, result, blank=False):
        self.assertEqual(result.returncode, 3)
        if blank: self.assertEqual(result.stdout, "")
        else: self.assertEqual(self.entries(result), [])


class PolicyRefusalTests(OfflineWorld):
    def test_missing_policy_refuses_before_any_transport(self):
        self.add_repo(REPO, "pass")
        self.assert_refused_before_transport(self.run_tool(remove=("RED_MAIN_PROD_PATH_REPOS",)))

    def test_invalid_policy_refuses_before_any_transport(self):
        self.add_repo(REPO, "pass")
        invalid = ["", "not-json", "null", "{}", '"example/red"', '""', "false", "[1]",
                   '["example/red", null]', '["example/../red"]', '["example/red/extra"]',
                   '["example/red?query"]', '["example/red#fragment"]', '[" example/red"]',
                   '["example/red", "EXAMPLE/RED"]', '["example/red\\n"]', '["example/.hidden"]',
                   '["example//red"]', '["example/r..ed"]']
        for policy in invalid:
            with self.subTest(policy=policy):
                self.trace_path.write_text("")
                self.assert_refused_before_transport(self.run_tool(update={"RED_MAIN_PROD_PATH_REPOS": policy}))


class PollTests(OfflineWorld):
    def test_explicit_empty_policy_measures_green(self):
        self.add_repo(REPO, "pass")
        result = self.run_tool()
        self.assertEqual(result.returncode, 0)
        self.assertEqual(self.entries(result), [])
        self.assertEqual([e["kind"] for e in self.events()], ["board", "ci"])
        draft = self.run_tool("propose")
        self.assertEqual((draft.returncode, draft.stdout), (0, ""))

    def test_signature_is_failure_set_not_head_order_case_or_duplicates(self):
        variants = {REPO: (["Broker Suite", "Offline Suites"], SHA_A),
                    "example/newhead": (["Broker Suite", "Offline Suites"], SHA_B),
                    "example/reorder": (["offline suites", "broker suite"], SHA_A),
                    "example/repeat": (["Offline Suites", "Broker Suite", "Broker Suite"], SHA_A),
                    "example/different": (["unit"], SHA_A)}
        for repo, (names, sha) in variants.items(): self.add_repo(repo, names=names, sha=sha)
        result = self.run_tool(repos=list(variants))
        self.assertEqual(result.returncode, 1)
        entries = self.entries(result)
        expected = signature(["broker suite", "offline suites"])
        self.assertEqual([e["signature"] for e in entries[:4]], [expected] * 4)
        self.assertNotEqual(entries[4]["signature"], expected)
        self.assertEqual(entries[0]["failingJobs"], "broker suite\noffline suites")
        self.assertNotEqual(entries[0]["headSha"], entries[1]["headSha"])
        self.assertEqual(entries[0]["dedupeTag"], f"red-main:v1:{REPO}:{expected}")

    def test_ascii_punctuation_signature_is_locale_independent(self):
        names = ["lint_b", "Lint.c", "lint-a", "lint a", "HEAD_SHA=x"]
        self.add_repo(REPO, names=names)
        result = self.run_tool(update={"LC_ALL": "C.UTF-8"})
        entry = self.entries(result)[0]
        self.assertEqual(entry["signature"], signature(names))
        self.assertEqual(entry["headSha"], SHA_A)
        self.assertEqual(entry["failingJobs"], "head_sha=x\nlint a\nlint-a\nlint.c\nlint_b")

    def test_policy_controls_severity_and_remote_policy_cannot_override(self):
        self.config["ci"][REPO]["body"].update({"productionRepos": [], "suggestedSeverity": "S2"})
        self.config["checks"][REPO]["body"].update({"RED_MAIN_PROD_PATH_REPOS": [], "suggestedSeverity": "S2"})
        result = self.run_tool(update={"RED_MAIN_PROD_PATH_REPOS": '["EXAMPLE/RED"]'})
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.entries(result)[0]["suggestedSeverity"], "S1")
        self.config["ci"][REPO]["body"].update({"productionRepos": [REPO], "suggestedSeverity": "S1"})
        self.config["checks"][REPO]["body"].update({"RED_MAIN_PROD_PATH_REPOS": [REPO], "suggestedSeverity": "S1"})
        self.config["board"] = {"body": {"issues": [], "productionRepos": [REPO]}}
        result = self.run_tool()
        self.assertEqual(self.entries(result)[0]["suggestedSeverity"], "S2")
        self.assertEqual(self.events()[0]["kind"], "board")

    def test_exact_tag_matching_and_terminal_cards_do_not_coalesce(self):
        tag = f"red-main:v1:{REPO}:{signature(['broker suite', 'offline suites'])}"
        for title in (f"[{tag}0] extended", f"[prefix-{tag}] wrong", f"[{tag}/extra] wrong", f"[red-main:v1:example/other:{tag.rsplit(':',1)[1]}] wrong"):
            with self.subTest(title=title):
                self.config["board"] = {"body": [{"title": title}]}
                result = self.run_tool()
                self.assertFalse(self.entries(result)[0]["incidentExists"])
        self.config["board"] = {"body": [{"title": f"[{tag}] old", "status": "done"}]}
        self.assertFalse(self.entries(self.run_tool())[0]["incidentExists"])
        for title in (f"[{tag}] Red main", f"Incident {tag} needs triage", tag):
            with self.subTest(title=title):
                self.config["board"] = {"body": [{"title": title, "status": "backlog"}]}
                result = self.run_tool()
                self.assertTrue(self.entries(result)[0]["incidentExists"])
                self.assertEqual(result.returncode, 1)
                result = self.run_tool("propose")
                self.assertEqual((result.returncode, result.stdout), (0, ""))

    def test_propose_only_outputs_untracked_draft(self):
        result = self.run_tool("propose", update={"RED_MAIN_PROD_PATH_REPOS": json.dumps([REPO])})
        self.assertEqual(result.returncode, 1)
        self.assertIn(f"[red-main:v1:{REPO}:", result.stdout)
        self.assertIn("Suggested severity: S1", result.stdout)
        self.assertIn("propose-only", result.stdout)
        self.assertTrue(all(e.get("method", "GET") == "GET" for e in self.events()))
        for mode in ("apply", "--apply", "create", "delete", "snapshot --apply"):
            with self.subTest(mode=mode):
                self.trace_path.write_text("")
                self.assert_refused_before_transport(self.run_tool(mode))

    def test_denied_pending_no_signal_never_ran_not_green_or_incidents(self):
        cases = [("unknown", "denied"), ("pending", "not concluded"),
                 ("unknown", "no-signal"), ("non-started", "not started")]
        for kind, reason in cases:
            with self.subTest(kind=kind, reason=reason):
                self.add_repo(REPO, kind, reason=reason)
                self.assert_unknown(self.run_tool())
                self.assert_unknown(self.run_tool("propose"), blank=True)
                self.assertFalse(any(e["kind"] == "http" for e in self.events()))

    def test_incompleteness_dominates_observed_red_in_both_modes(self):
        blind = "example/blind"
        self.add_repo(blind, "unknown", reason="denied")
        result = self.run_tool(repos=[REPO, blind])
        self.assertEqual(result.returncode, 3)
        self.assertEqual(len(self.entries(result)), 1)
        self.assertIn(blind, result.stderr)
        result = self.run_tool("propose", repos=[REPO, blind])
        self.assertEqual(result.returncode, 3)
        self.assertIn(f"[red-main:v1:{REPO}:", result.stdout)
        self.assertIn(blind, result.stderr)

    def test_reader_contradictions_and_empty_malformed_output_are_unknown(self):
        variants = [{"exit": 0, "body": {"verdict": "fail"}}, {"exit": 1, "raw": ""},
                    {"exit": 1, "raw": "not-json"}, {"exit": 1, "body": []},
                    verdict(REPO, "pass", signalsObserved=0),
                    {"exit": 1, "body": {"repo": "example/wrong", "ref": "main", "verdict": "fail"}},
                    verdict(REPO, "fail", nonStarted=["unit"]),
                    verdict(REPO, "fail", nonStartedProbe="incomplete-403")]
        for spec in variants:
            with self.subTest(spec=spec):
                self.config["ci"][REPO] = spec
                self.assert_unknown(self.run_tool())

    def test_reason_fallback_only_for_confirmed_empty_checks(self):
        self.add_repo(REPO, names=[], reason="failed: external build")
        self.config["ci"][REPO]["body"]["sources"]["commitStatuses"] = "read"
        result = self.run_tool()
        self.assertEqual(result.returncode, 1)
        entry = self.entries(result)[0]
        self.assertEqual(entry["sigSource"], "reason")
        self.assertEqual(entry["signature"], hashlib.sha1(b"failed: external build").hexdigest()[:8])
        self.add_repo(REPO, names=[], reason="failed: another external build")
        self.config["ci"][REPO]["body"]["sources"]["commitStatuses"] = "read"
        self.assertNotEqual(self.entries(self.run_tool())[0]["signature"], entry["signature"])
        self.config["checks"][REPO] = {"http": 403, "body": {"message": "denied"}}
        self.assert_unknown(self.run_tool())

    def test_invalid_truncated_or_pending_checks_do_not_manufacture_incident(self):
        variants = [{"http": 500, "body": {"check_runs": []}}, {"raw": ""}, {"raw": "{"},
                    {"body": {"total_count": 2, "check_runs": [check("unit")]}},
                    {"body": {"total_count": 0, "check_runs": []}},
                    {"body": {"total_count": 1, "check_runs": [check(9)]}},
                    {"body": {"total_count": 1, "check_runs": [check("unit\nother")]}},
                    {"body": {"total_count": 1, "check_runs": [check(" ")]}},
                    {"body": {"total_count": 2, "check_runs": [check("unit"), check("pending", status="in_progress", conclusion=None)]}},
                    {"body": {"total_count": 2, "check_runs": [check("unit"), check("other", sha=SHA_B)]}}]
        for spec in variants:
            with self.subTest(spec=spec):
                self.config["checks"][REPO] = spec
                self.assert_unknown(self.run_tool())

    def test_board_unreadable_malformed_incomplete_never_means_absent(self):
        variants = [{"exit": 1, "body": []}, {"raw": ""}, {"raw": "{"},
                    {"body": {"error": "denied"}}, {"body": [{"title": None}]},
                    {"body": [{"missing": "title"}]}, {"body": [{"title": "x", "status": "surprise"}]},
                    {"body": {"issues": [], "hasMore": True}}, {"body": {"issues": [], "nextCursor": "page-2"}},
                    {"body": {"issues": [], "totalCount": 4}},
                    {"body": [{"title": "noise"}] * 1000}]
        for spec in variants:
            with self.subTest(spec=spec):
                self.config["board"] = spec
                for mode in ("snapshot", "propose"):
                    self.trace_path.write_text("")
                    self.assert_unknown(self.run_tool(mode), blank=True)
                    self.assertEqual([e["kind"] for e in self.events()], ["board"])

    def test_wrapped_board_complete_and_title_only_matching(self):
        tag = f"red-main:v1:{REPO}:{signature(['broker suite', 'offline suites'])}"
        for key in ("issues", "data"):
            self.config["board"] = {"body": {key: [{"title": "unrelated", "description": tag}], "hasMore": False, "totalCount": 1}}
            self.assertFalse(self.entries(self.run_tool())[0]["incidentExists"])

    def test_default_board_query_finds_quiet_card_beyond_default_window(self):
        tag = f"red-main:v1:{REPO}:{signature(['broker suite', 'offline suites'])}"
        rows = [{"title": f"noise {i}"} for i in range(1050)]
        rows[800] = {"title": f"[{tag}] incident", "status": "blocked"}
        self.assertFalse(any(tag in r["title"] for r in rows[:500]))
        self.config["board"] = {"body": rows}
        self.config["boardFilter"] = True
        result = self.run_tool(remove=("INCIDENT_SOURCE_CMD",))
        self.assertEqual(result.returncode, 1)
        self.assertTrue(self.entries(result)[0]["incidentExists"])
        board = self.events()[0]
        self.assertIn("q=red-main%3Av1", board["url"])
        self.assertIn("limit=1000", board["url"])
        for status in ("backlog", "todo", "in_progress", "in_review", "blocked"):
            self.assertIn(status, board["url"])
        self.assertTrue(board["authenticated"])
        self.assertEqual(board["headerMode"], "0600")

    def test_default_board_error_and_full_page_refuse(self):
        for spec in ({"http": 500, "body": []}, {"http": 401, "body": []},
                     {"body": [{"title": "red-main:v1 noise"}] * 1000}):
            with self.subTest(spec_kind=list(spec)):
                self.config["board"] = spec
                self.assert_unknown(self.run_tool(remove=("INCIDENT_SOURCE_CMD",)), blank=True)

    def test_credentials_absence_no_fallback_and_no_secret_argv_or_logs(self):
        for absent in ("GH_TOKEN", "RED_MAIN_API_KEY"):
            with self.subTest(absent=absent):
                self.trace_path.write_text("")
                self.assert_refused_before_transport(self.run_tool(remove=(absent,), update={
                    "GITHUB_TOKEN": "synthetic-alternate-ci", "PAPERCLIP_API_KEY": "synthetic-alternate-board"}))
        self.config["ci"][REPO]["body"]["reason"] = GH_CANARY + BOARD_CANARY
        self.add_repo(REPO, names=["unit " + GH_CANARY])
        result = self.run_tool(remove=("INCIDENT_SOURCE_CMD",))
        self.assertEqual(result.returncode, 1)
        self.assertNotIn(GH_CANARY, result.stdout + result.stderr + self.trace_path.read_text())
        self.assertNotIn(BOARD_CANARY, result.stdout + result.stderr + self.trace_path.read_text())
        # Transport error bodies do not get logged; no alternate identity retry.
        self.trace_path.write_text("")
        self.config["board"] = {"http": 401, "body": {"error": BOARD_CANARY}}
        result = self.run_tool(remove=("INCIDENT_SOURCE_CMD",), update={"PAPERCLIP_API_KEY": "synthetic-alternate-board"})
        self.assert_unknown(result, blank=True)
        self.assertEqual(len(self.events()), 1)
        self.assertNotIn(BOARD_CANARY, result.stdout + result.stderr)

    def test_credential_echo_redacted_before_json_escaping(self):
        key = GH_CANARY + chr(34) + chr(92) + "suffix"
        self.add_repo(REPO, names=["unit " + key])
        for mode in ("snapshot", "propose"):
            result = self.run_tool(mode, update={"GH_TOKEN": key})
            self.assertEqual(result.returncode, 1)
            self.assertNotIn(GH_CANARY, result.stdout + result.stderr)
            self.assertIn("[redacted]", result.stdout)

    def test_alternate_credentials_and_injection_env_not_forwarded(self):
        result = self.run_tool(remove=("INCIDENT_SOURCE_CMD",), update={
            "GITHUB_TOKEN": "synthetic-unused-ci", "PAPERCLIP_API_KEY": "synthetic-unused-board",
            "HTTPS_PROXY": "https://proxy.example.invalid", "PYTHONPATH": str(self.work)})
        self.assertEqual(result.returncode, 1)
        self.assertTrue(self.entries(result))
        self.assertTrue(all(e["kind"] in ("http", "ci") for e in self.events()))

    def test_all_local_inputs_validate_before_transport_and_help_is_offline(self):
        for bad in ("example/red?x", "example/red/extra", "example/../red", "example/.red", "example/red\n", "-example/red", "example//red"):
            with self.subTest(repo=bad):
                self.trace_path.write_text("")
                self.assert_refused_before_transport(self.run_tool(repos=[REPO, bad]))
        for update in ({"PAPERCLIP_API_URL": "http://board.example.invalid"},
                       {"PAPERCLIP_API_URL": "https://user:secret@board.example.invalid"},
                       {"PAPERCLIP_COMPANY_ID": "../elsewhere"}, {"GH_API_URL": "https://ci.example.invalid?x"},
                       {"GH_CI_STATUS_BIN": str(self.work / "absent")}):
            with self.subTest(update=update):
                self.trace_path.write_text("")
                self.assert_refused_before_transport(self.run_tool(update=update, remove=("INCIDENT_SOURCE_CMD",)))
        self.trace_path.write_text("")
        self.assert_refused_before_transport(self.run_tool(repos=[]))
        result = self.run_tool("--help", repos=[], remove=("RED_MAIN_PROD_PATH_REPOS", "GH_TOKEN", "RED_MAIN_API_KEY"))
        self.assertEqual(result.returncode, 0)
        self.assertIn("RED_MAIN_PROD_PATH_REPOS", result.stdout)
        self.assertEqual(self.events(), [])

    def test_existing_reader_runs_against_fake_curl_no_live_ci(self):
        reader = ROOT / "gh_ci_status.sh"
        self.assertTrue(reader.is_file())
        remove = ("INCIDENT_SOURCE_CMD",)
        for case in ("pass", "fail", "pending", "empty", "denied", "never-ran"):
            with self.subTest(case=case):
                self.trace_path.write_text("")
                checks = [check("unit", conclusion="success" if case == "pass" else "failure")]
                if case == "pending": checks = [check("unit", status="in_progress", conclusion=None)]
                if case in ("empty", "denied"): checks = []
                self.config["checks"][REPO] = {"http": 403 if case == "denied" else 200,
                    "body": {"total_count": len(checks), "check_runs": checks}}
                self.config["annotations"] = {"1": {"body": [{"annotation_level": "failure", "message": "The job was not started because the account is unavailable."}]}} if case == "never-ran" else {}
                result = self.run_tool(remove=remove, update={"GH_CI_STATUS_BIN": str(reader)})
                self.assertEqual(result.returncode, {"pass": 0, "fail": 1}.get(case, 3))
                self.assertEqual(len(self.entries(result)), 1 if case == "fail" else 0)
                self.assertTrue(all(e["kind"] == "http" and e["method"] == "GET" for e in self.events()))
                self.assertTrue(all(".example.invalid/" in e["url"] for e in self.events()))


class MutationTests(unittest.TestCase):
    def test_policy_and_severity_mutants_are_assertion_killed_and_restored(self):
        # Stage only our new pair. Never mutate the shared candidate/dependency.
        helper = ROOT / "red_main_poll.py"
        original = helper.read_bytes()
        source = original.decode("utf-8")
        mutations = [
            ("missing-policy-default", '        raise Refused("RED_MAIN_PROD_PATH_REPOS is required; supply an explicit JSON array (including [])")',
             '        return frozenset()', "PolicyRefusalTests.test_missing_policy_refuses_before_any_transport", "AssertionError: 0 != 2"),
            ("production-severity-discarded", '    return "S1" if repo.lower() in production else "S2"',
             '    return "S2"', "PollTests.test_policy_controls_severity_and_remote_policy_cannot_override", "AssertionError: 'S2' != 'S1'")]
        with tempfile.TemporaryDirectory(prefix="red-main-mutants-") as work:
            stage = Path(work)
            script = stage / "red_main_poll.sh"
            script.write_bytes((ROOT / "red_main_poll.sh").read_bytes())
            script.chmod(0o755)
            target = stage / helper.name
            target.write_bytes(original)
            target.chmod(0o644)
            env = {"PATH": "/usr/bin:/bin", "HOME": work, "TMPDIR": work,
                   "LC_ALL": "C", "PYTHONDONTWRITEBYTECODE": "1", "RED_MAIN_TEST_TOOL": str(script)}
            for name, old, new, case, expected in mutations:
                with self.subTest(mutant=name):
                    self.assertEqual(source.count(old), 1)
                    command = ["/usr/bin/python3", str(Path(__file__).resolve()), case]
                    baseline = subprocess.run(command, env=env, capture_output=True, text=True, timeout=120)
                    self.assertEqual(baseline.returncode, 0, baseline.stderr)
                    try:
                        target.write_text(source.replace(old, new, 1))
                        mutated = subprocess.run(command, env=env, capture_output=True, text=True, timeout=120)
                        self.assertEqual(mutated.returncode, 1)
                        self.assertIn(expected, mutated.stderr)
                        self.assertIn("FAILED (failures=1)", mutated.stderr)
                        self.assertNotIn("ERROR:", mutated.stderr)
                        self.assertNotIn("SyntaxError", mutated.stderr)
                        self.assertNotIn("ModuleNotFoundError", mutated.stderr)
                        print(f"mutation {name}: baseline=0 mutant=1 assertion-killed")
                    finally:
                        target.write_bytes(original)
                    self.assertEqual(target.read_bytes(), original)
                    restored = subprocess.run(command, env=env, capture_output=True, text=True, timeout=120)
                    self.assertEqual(restored.returncode, 0, restored.stderr)
                    print(f"mutation {name}: restored=0 sha256={hashlib.sha256(original).hexdigest()}")
        self.assertEqual(helper.read_bytes(), original)


if __name__ == "__main__":
    unittest.main(verbosity=2)
