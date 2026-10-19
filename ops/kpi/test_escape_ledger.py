#!/usr/bin/env python3
"""Offline linkage and failure contracts; no credentials, network, or database."""
import argparse
import contextlib
import io
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import shlex
import shutil
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("escape_ledger", Path(__file__).with_name("escape_ledger.py"))
ledger = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ledger)


def pr(number=1, at="2026-10-01T10:00:00Z", title="feat: add behavior", sha=None, body="", branch="feature"):
    return {"number": number, "mergedAt": at, "updatedAt": at, "title": title,
            "body": body, "headRefName": branch, "headRefOid": str(number) * 40,
            "mergeCommit": {"oid": sha or "a" * 40}, "baseRefName": "main"}


def git_environment(**overrides):
    location_variables = ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE",
                          "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
                          "GIT_COMMON_DIR")
    env = {key: value for key, value in os.environ.items() if key not in location_variables}
    env.update(overrides)
    return env


class Parsing(unittest.TestCase):
    def test_hunk_old_coordinates_and_additions(self):
        self.assertEqual(ledger.old_ranges("@@ -1 +1 @@\n-a\n+b\n@@ -4,0 +5,2 @@\n+x\n+y\n@@ -8,3 +10,0 @@\n"), [(1, 1), (8, 3)])

    def test_reference_identity_and_boundaries(self):
        text = ("fix #7 not #70; foreign/repo#8 or other#9 "
                "https://github.com/foreign/repo/pull/10; "
                "Org/repo#11 and repo#12 https://github.com/Org/repo/pull/13")
        self.assertEqual(ledger.referenced_prs(text, "Org/repo"), {7, 70, 11, 12, 13})

    def test_commit_message_only_owns_subject(self):
        self.assertEqual(ledger.message_pr("fix: behavior (#12)\n\nRefs #15"), 12)
        self.assertEqual(ledger.message_pr("Merge pull request #18 from org/branch\n\ntext"), 18)
        self.assertIsNone(ledger.message_pr("fix behavior\n\nRefs (#15)"))

    def test_seven_days_inclusive_and_strict_prior(self):
        original = pr()
        self.assertTrue(ledger.recent_introducer(original, pr(2, "2026-10-08T10:00:00Z")))
        self.assertFalse(ledger.recent_introducer(original, pr(2, "2026-10-08T10:00:01Z")))
        self.assertFalse(ledger.recent_introducer(original, pr(2)))
        self.assertFalse(ledger.recent_introducer(original, pr(1, "2026-10-02T10:00:00Z")))

    def test_fix_word_not_prefix(self):
        for value in ("fix: safety", "hotfix/auth", "bugfix-fix-thing", "fixes bug"):
            self.assertIsNotNone(ledger.FIX.search(value))
        self.assertIsNone(ledger.FIX.search("feat: prefix fixtures"))

    def test_timezone_required(self):
        with self.assertRaises(ValueError):
            ledger.instant("2026-10-01")


class GitLinkage(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.work = self.root / "work"
        self.work.mkdir()
        self.g("init", "-b", "main")
        self.g("config", "user.email", "test@example.invalid")
        self.g("config", "user.name", "Fixture")
        self.path = self.work / "space ü file.txt"
        self.path.write_text("original\nunchanged\n")
        self.g("add", ".")
        self.g("commit", "-m", "feat: introduction (#1)")
        self.intro_sha = self.g("rev-parse", "HEAD").strip()
        self.intro = pr(1, sha=self.intro_sha)

    def tearDown(self):
        self.temp.cleanup()

    def g(self, *args):
        return subprocess.run(["git", "-C", str(self.work), *args], check=True,
                              env=git_environment(GIT_AUTHOR_DATE="2026-10-02T10:00:00Z",
                                                  GIT_COMMITTER_DATE="2026-10-02T10:00:00Z"),
                              capture_output=True, text=True).stdout

    def analyze(self, title="fix: regression", body="", at="2026-10-02T10:00:00Z", branch="feature"):
        sha = self.g("rev-parse", "HEAD").strip()
        fix = pr(2, at, title, sha=sha, body=body, branch=branch)
        mirror = self.root / "mirror.git"
        subprocess.run(["git", "clone", "--mirror", str(self.work), str(mirror)],
                       check=True, env=git_environment(), capture_output=True)
        return ledger.Linker("Org/repo", mirror, [self.intro, fix]).analyze(fix)

    def test_blame_modification_real_git_and_space_unicode_path(self):
        self.path.write_text("corrected\nunchanged\n")
        self.g("commit", "-am", "fix: regression (#2)")
        result = self.analyze()
        self.assertTrue(result["eligible"])
        self.assertEqual(set(result["links"]), {1})
        evidence = result["links"][1][0]
        self.assertEqual(evidence["commit"], self.intro_sha)
        self.assertEqual(evidence["base"], self.intro_sha)
        self.assertEqual(evidence["lines"], [1])
        self.assertEqual(evidence["path"], "space ü file.txt")

    def test_blame_deletion(self):
        self.path.unlink()
        self.g("add", "-u")
        self.g("commit", "-m", "fix: remove broken file (#2)")
        result = self.analyze()
        self.assertEqual(result["blame"]["blamed_lines"], 2)
        self.assertEqual(set(result["links"]), {1})

    def test_first_parent_attributes_feature_branch_to_merge_pr(self):
        self.g("checkout", "-b", "side")
        self.path.write_text("feature branch addition\nunchanged\n")
        self.g("commit", "-am", "no PR number in feature commit")
        self.g("checkout", "main")
        self.g("merge", "--no-ff", "side", "-m", "Merge pull request #1 from Org/side")
        self.intro_sha = self.g("rev-parse", "HEAD").strip()
        self.intro["mergeCommit"]["oid"] = self.intro_sha
        self.path.write_text("fixed merge\nunchanged\n")
        self.g("commit", "-am", "fix: merged behavior (#2)")
        result = self.analyze()
        self.assertEqual(result["links"][1][0]["commit"], self.intro_sha)

    def test_old_origin_not_counted(self):
        self.path.write_text("fixed\nunchanged\n")
        self.g("commit", "-am", "fix: regression (#2)")
        result = self.analyze(at="2026-10-09T00:00:00Z")
        self.assertFalse(result["eligible"])
        self.assertEqual(result["blame"]["outside_seven_day_lines"], 1)

    def test_pure_addition_no_fabricated_blame(self):
        self.path.write_text(self.path.read_text() + "additional\n")
        self.g("commit", "-am", "fix: extra guard (#2)")
        result = self.analyze()
        self.assertFalse(result["eligible"])
        self.assertEqual(result["blame"]["blamed_lines"], 0)

    def test_explicit_reference_counts_add_only_and_branch_fix(self):
        (self.work / "guard.py").write_text("guard = True\n")
        self.g("add", ".")
        self.g("commit", "-m", "chore: extra guard (#2)")
        result = self.analyze(title="chore: guard", body="Regression from #1", branch="hotfix/auth")
        self.assertTrue(result["eligible"])
        self.assertEqual(result["links"][1], [{"method": "explicit_pr_reference"}])

    def test_git_revert_body_without_revert_title(self):
        self.path.write_text("second\nunchanged\n")
        self.g("commit", "-am", "unrelated intermediate")
        self.g("revert", "--no-edit", "HEAD")
        # Point the revert at a merged PR, independent of its title and older than 7d.
        reverted = self.g("rev-parse", "HEAD^").strip()
        self.intro["mergeCommit"]["oid"] = reverted
        result = self.analyze(title="chore: restore", at="2026-10-15T00:00:00Z")
        self.assertEqual(result["kind"], "revert")
        self.assertEqual(result["links"][1][0]["method"], "reverted_commit")

    def test_unmerged_feature_branch_revert_is_not_an_escape(self):
        self.path.write_text("temporary experiment\nunchanged\n")
        self.g("commit", "-am", "unmerged experimental change")
        self.g("revert", "--no-edit", "HEAD")
        self.assertIsNone(self.analyze(title="feat: ship unrelated additive feature"))

    def test_missing_squash_revert_target_is_unresolved_not_a_collection_failure(self):
        missing = "f" * 40
        self.g("commit", "--allow-empty", "-m", "feat: unrelated change (#2)",
               "-m", f"This reverts commit {missing}.")
        fix_sha = self.g("rev-parse", "HEAD").strip()
        fix = pr(2, "2026-10-02T10:00:00Z", sha=fix_sha)
        mirror = self.root / "missing-target.git"
        subprocess.run(["git", "clone", "--mirror", str(self.work), str(mirror)],
                       check=True, env=git_environment(), capture_output=True)
        linker = ledger.Linker("Org/repo", mirror, [self.intro, fix])
        analysis = linker.analyze(fix)
        self.assertIsNone(analysis)
        self.assertEqual(linker.unresolved_revert_commits, 1)

    def test_title_only_revert_gets_blame_linkage_without_seven_day_limit(self):
        self.path.unlink()
        self.g("add", "-u")
        self.g("commit", "-m", "revert: remove experiment (#2)")
        result = self.analyze(title="revert: remove experiment", at="2026-10-15T00:00:00Z")
        self.assertEqual(result["kind"], "revert")
        self.assertEqual(set(result["links"]), {1})
        self.assertEqual(result["links"][1][0]["method"], "revert_first_parent_blame")
        self.assertEqual(result["blame"]["blamed_lines"], 2)

    def test_revert_title_not_also_hotfix(self):
        self.path.write_text("modified\nunchanged\n")
        self.g("commit", "-am", "Revert fix (#2)")
        result = self.analyze(title="Revert fix: bad rollout", body="Reverts #1")
        self.assertEqual(result["kind"], "revert")
        self.assertEqual(result["blame"]["blamed_lines"], 0)

    def test_direct_revert_on_base_branch_is_linked_once(self):
        self.g("revert", "--no-edit", "HEAD")
        mirror = self.root / "direct.git"
        subprocess.run(["git", "clone", "--mirror", str(self.work), str(mirror)],
                       check=True, env=git_environment(), capture_output=True)
        linker = ledger.Linker("Org/repo", mirror, [self.intro])
        events = linker.direct_reverts(["main", "main", "deleted-historical-base"],
            ledger.instant("2020-01-01T00:00:00Z"), ledger.instant("9999-12-31T23:59:59Z"))
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["introducers"][0]["number"], 1)
        self.assertEqual(events[0]["introducers"][0]["evidence"][0]["method"], "direct_git_revert")
        linker.by_sha[self.g("rev-parse", "HEAD").strip()] = 2
        self.assertEqual(linker.direct_reverts(["main"],
            ledger.instant("2020-01-01T00:00:00Z"), ledger.instant("2030-01-01T00:00:00Z")), [])

    def test_direct_revert_with_missing_target_is_counted_as_unresolved(self):
        missing = "d" * 40
        self.path.write_text("restored behavior\n")
        self.g("commit", "-am", f"revert: unavailable target\n\nThis reverts commit {missing}.\n")
        mirror = self.root / "missing-direct-target.git"
        subprocess.run(["git", "clone", "--mirror", str(self.work), str(mirror)],
                       check=True, env=git_environment(), capture_output=True)
        linker = ledger.Linker("Org/repo", mirror, [self.intro])
        events = linker.direct_reverts(["main"], ledger.instant("2020-01-01T00:00:00Z"),
                                        ledger.instant("9999-12-31T23:59:59Z"))
        self.assertEqual(events, [])
        self.assertEqual(linker.unresolved_revert_commits, 1)

    def test_old_revert_target_resolved_beyond_lookup_window(self):
        mirror = self.root / "old.git"
        subprocess.run(["git", "clone", "--mirror", str(self.work), str(mirror)],
                       check=True, env=git_environment(), capture_output=True)
        resolver = unittest.mock.Mock(return_value=self.intro)
        linker = ledger.Linker("Org/repo", mirror, [], resolver=resolver)
        self.assertEqual(linker.introducing_pr(self.intro_sha, resolve=True), 1)
        self.assertEqual(linker.resolve(1), self.intro)
        linker.resolve(1)
        resolver.assert_called_once_with("Org/repo", 1)

    def test_cherry_picked_subject_number_without_sha_identity_is_not_linked(self):
        mirror = self.root / "ambiguous.git"
        subprocess.run(["git", "clone", "--mirror", str(self.work), str(mirror)],
                       check=True, env=git_environment(), capture_output=True)
        unrelated = pr(1, sha="b" * 40)
        linker = ledger.Linker("Org/repo", mirror, [unrelated])
        self.assertIsNone(linker.introducing_pr(self.intro_sha))

    def test_git_failure_not_reported_as_clean(self):
        self.path.write_text("modified\nunchanged\n")
        self.g("commit", "-am", "fix: regression (#2)")
        with patch.object(ledger, "git", side_effect=ledger.CollectionError("failure")):
            with self.assertRaises(ledger.CollectionError):
                self.analyze()


class ReviewProvenance(unittest.TestCase):
    def row(self, **changes):
        return dict({"id": "r1", "head_sha": "1" * 40, "model": "claude-opus-test",
                     "score": "5", "conclusion": "success", "completed_at": "2026-10-01T09:00:00Z"}, **changes)

    def test_exact_head_model_and_premerge_required(self):
        self.assertTrue(ledger.review_status(pr(), [self.row()])["claude_5_of_5"])
        for change in ({"head_sha": "2" * 40}, {"completed_at": "2026-10-01T11:00:00Z"}):
            self.assertIsNone(ledger.review_status(pr(), [self.row(**change)])["claude_5_of_5"])

    def test_unknown_model_never_assumed_claude(self):
        self.assertIsNone(ledger.review_status(pr(), [self.row(model=None)])["claude_5_of_5"])
        self.assertFalse(ledger.review_status(pr(), [self.row(model="other-reviewer")])["claude_5_of_5"])

    def test_latest_review_is_chronological_across_offsets(self):
        older = self.row(id="older", completed_at="2026-10-01T10:00:00+02:00")
        newer = self.row(id="newer", completed_at="2026-10-01T09:00:00Z", score="4", conclusion="failure")
        result = ledger.review_status(pr(), [older, newer])
        self.assertEqual(result["review_id"], "newer")
        self.assertFalse(result["claude_5_of_5"])

    def test_latest_same_head_failure_supersedes_pass(self):
        records = [self.row(), self.row(id="r2", score="4", conclusion="failure", completed_at="2026-10-01T09:30:00Z")]
        self.assertFalse(ledger.review_status(pr(), records)["claude_5_of_5"])


class Collection(unittest.TestCase):
    def test_review_collection_uses_configured_container_runtime(self):
        with patch.object(ledger, "command", return_value="") as command:
            ledger.collect_reviews("paperclip-db", runtime="podman")
        self.assertEqual(command.call_args.args[0][0:3], ["podman", "exec", "paperclip-db"])

    def test_collector_mints_only_read_permissions(self):
        gh = ledger.GitHub(Path("/no-token-needed"))
        gh.env["GH_TOKEN"] = "ambient-token-must-not-be-reused"
        with patch.object(ledger.time, "monotonic", return_value=1), \
                patch.object(ledger, "command", return_value="synthetic-canary\n") as command:
            environment = gh.environment()
        command.assert_called_once_with(["/no-token-needed", "token", "--permissions",
                                         "contents=read,pull_requests=read"], timeout=60)
        self.assertEqual(environment["GH_TOKEN"], "synthetic-canary")

    def test_absent_local_pull_in_fork_history_is_a_negative_lookup(self):
        gh = ledger.GitHub(Path("/no-token-needed"))
        response = {"data": {"repository": {"pullRequest": None}},
                    "errors": [{"type": "NOT_FOUND", "path": ["repository", "pullRequest"]}]}
        with patch.object(gh, "environment", return_value={}), \
                patch.object(ledger, "command", return_value=json.dumps(response)) as command:
            self.assertIsNone(gh.pull("Org/repo", 4506))
        self.assertEqual(command.call_count, 1)
        self.assertEqual(command.call_args.kwargs["allowed_returncodes"], (0, 1))

    def test_inaccessible_repository_and_other_graphql_errors_stay_failures(self):
        gh = ledger.GitHub(Path("/no-token-needed"))
        responses = [
            {"data": {"repository": None}, "errors": [{"type": "NOT_FOUND", "path": ["repository"]}]},
            {"data": {"repository": {"pullRequest": None}},
             "errors": [{"type": "FORBIDDEN", "path": ["repository", "pullRequest"]}]},
            {"data": {"repository": {"pullRequest": None}}, "errors": [
                {"type": "NOT_FOUND", "path": ["repository", "pullRequest"]},
                {"type": "RATE_LIMITED", "path": ["repository", "pullRequest"]}]},
        ]
        responses.append({"message": "Bad credentials"})
        for response in responses:
            with self.subTest(response=response), patch.object(gh, "environment", return_value={}), \
                    patch.object(ledger, "command", return_value=json.dumps(response)), \
                    patch.object(ledger.time, "sleep"):
                with self.assertRaises(ledger.CollectionError):
                    gh.pull("Org/repo", 4506)

    def test_graphql_pagination_and_old_updated_stop(self):
        gh = ledger.GitHub(Path("/no-token-needed"))
        pages = [
            {"data": {"repository": {"pullRequests": {"nodes": [pr(1)], "pageInfo": {"hasNextPage": True, "endCursor": "next"}}}}},
            {"data": {"repository": {"pullRequests": {"nodes": [pr(2)], "pageInfo": {"hasNextPage": False, "endCursor": None}}}}},
        ]
        with patch.object(gh, "api", side_effect=pages) as api:
            result = gh.merged("Org/repo", ledger.instant("2026-09-01T00:00:00Z"))
        self.assertEqual([p["number"] for p in result], [1, 2])
        self.assertEqual(api.call_args_list[1].args[1]["variables"]["cursor"], "next")

    def test_repository_page_two_included(self):
        gh = ledger.GitHub(Path("/no-token-needed"))
        with patch.object(gh, "api", side_effect=[[{"full_name": f"Org/repo{i}"} for i in range(100)], [{"full_name": "Org/last"}]]) as api:
            result = gh.repos("Org")
        self.assertEqual(len(result), 101)
        self.assertIn("Org/last", result)
        self.assertEqual(api.call_count, 2)

    def test_missing_immutable_merge_commit_is_fetched_without_secret_argv(self):
        with tempfile.TemporaryDirectory() as root:
            gh = unittest.mock.Mock()
            gh.environment.return_value = {"GH_TOKEN": "synthetic-canary"}
            with patch.object(ledger, "git", side_effect=[ledger.CollectionError("missing"), ""]), \
                    patch.object(ledger, "command", return_value="") as run:
                ledger.ensure_commit(Path(root) / "repo.git", "Org/repo", "a" * 40, gh)
            argv = run.call_args.args[0]
            self.assertEqual(argv[-1], "a" * 40)
            self.assertNotIn("synthetic-canary", " ".join(argv))
            self.assertEqual(run.call_args.kwargs["env"]["GH_TOKEN"], "synthetic-canary")

    def test_invalid_merge_commit_never_reaches_git(self):
        with patch.object(ledger, "command") as run:
            with self.assertRaises(ledger.CollectionError):
                ledger.ensure_commit(Path("/unused"), "Org/repo", "--evil", unittest.mock.Mock())
            run.assert_not_called()

    def test_bad_cache_returns_none(self):
        with tempfile.TemporaryDirectory() as root:
            p = Path(root) / "cache.json"
            p.write_text("bad")
            self.assertIsNone(ledger.load_json(p))

    def test_atomic_no_partial_write(self):
        with tempfile.TemporaryDirectory() as root:
            p = Path(root) / "result.json"
            ledger.save_json(p, {"complete": True})
            self.assertEqual(json.loads(p.read_text()), {"complete": True})
            self.assertEqual(len(list(Path(root).iterdir())), 1)

    def test_command_error_does_not_echo_secret_stderr(self):
        with self.assertRaises(ledger.CollectionError) as result:
            ledger.command(["python3", "-c", "import sys; print('sensitive',file=sys.stderr); sys.exit(7)"])
        self.assertNotIn("sensitive", str(result.exception))


class EndToEnd(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        log = self.root / "ops/worker-vps/operator-actions.log"
        log.parent.mkdir(parents=True)
        log.write_text("")
        self.args = argparse.Namespace(root=self.root, until="2026-10-17T00:00:00Z", days=30,
            org="Org", repo=None, token_helper=None, review_db_container=None,
            container_runtime="docker", output_dir=self.root / "ops/kpi",
            mirror_root=self.root / "mirrors", memory_dir=None)

    def tearDown(self):
        self.temp.cleanup()

    def run_without_candidates(self):
        merge = pr()
        with patch.object(ledger, "GitHub") as gh, patch.object(ledger, "Linker") as linker, \
                patch.object(ledger, "ensure_mirror"), patch.object(ledger, "ensure_commit"), \
                contextlib.redirect_stdout(io.StringIO()):
            gh.return_value.repos.return_value = ["Org/repo"]
            gh.return_value.merged.return_value = [merge]
            gh.return_value.default_branches = {"Org/repo": "main"}
            linker.return_value.prs = {merge["number"]: merge}
            linker.return_value.unresolved_revert_commits = 0
            linker.return_value.analyze.return_value = None
            linker.return_value.direct_reverts.return_value = []
            return ledger.run(self.args)

    def test_successful_collection_publishes_parseable_snapshot_and_exact_window(self):
        prs = [pr(), pr(2, at="2026-10-02T10:00:00Z", title="fix: regression")]
        with patch.object(ledger, "GitHub") as gh, patch.object(ledger, "Linker") as linker, \
                patch.object(ledger, "ensure_mirror"), patch.object(ledger, "ensure_commit"), \
                contextlib.redirect_stdout(io.StringIO()):
            gh.return_value.repos.return_value = ["Org/repo"]
            gh.return_value.merged.return_value = prs
            gh.return_value.default_branches = {"Org/repo": "main"}
            instance = linker.return_value
            instance.unresolved_revert_commits = 0
            instance.prs = {p["number"]: p for p in prs}
            instance.resolve.side_effect = instance.prs.get
            instance.direct_reverts.return_value = []
            instance.analyze.side_effect = [None, {"eligible": True, "kind": "hotfix", "links": {
                1: [{"method": "first_parent_blame", "lines": [1]}]}, "blame": {"blamed_lines": 1}}]
            self.assertEqual(ledger.run(self.args), 0)
        records = [json.loads(l) for l in (self.root / "ops/kpi/escapes.jsonl").read_text().splitlines()]
        meta = records[0]
        self.assertEqual(meta["merges"], 2)
        self.assertEqual(meta["escapes"], 1)
        self.assertEqual(meta["escapes_per_100_merges"], 50)
        self.assertEqual(meta["start"], "2026-09-17T00:00:00Z")
        self.assertEqual(len([r for r in records if r.get("period") == "day" and r["repo"] == "ALL"]), 30)
        self.assertIn("Shadow escape ledger", (self.root / "ops/kpi/ESCAPES.md").read_text())
        self.assertEqual((self.root / "ops/kpi/escape-history/2026-10-17.jsonl").read_bytes(),
                         (self.root / "ops/kpi/escapes.jsonl").read_bytes())
        self.assertEqual(len(meta["tool_sha256"]), 64)

    def test_cached_analysis_preserves_unresolved_revert_count(self):
        merge = pr()
        first, second = unittest.mock.Mock(), unittest.mock.Mock()
        for linker in (first, second):
            linker.prs = {1: merge}
            linker.unresolved_revert_commits = 0
            linker.direct_reverts.return_value = []

        def analyze(_):
            first.unresolved_revert_commits += 1
            return None

        first.analyze.side_effect = analyze
        with patch.object(ledger, "GitHub") as gh, patch.object(ledger, "Linker", side_effect=[first, second]), \
                patch.object(ledger, "ensure_mirror"), patch.object(ledger, "ensure_commit"), \
                contextlib.redirect_stdout(io.StringIO()):
            gh.return_value.repos.return_value = ["Org/repo"]
            gh.return_value.merged.return_value = [merge]
            gh.return_value.default_branches = {"Org/repo": "main"}
            self.assertEqual(ledger.run(self.args), 0)
            self.assertEqual(ledger.run(self.args), 0)

        records = [json.loads(line) for line in (self.root / "ops/kpi/escapes.jsonl").read_text().splitlines()]
        self.assertEqual(records[0]["coverage"][0]["unresolved_revert_commits"], 1)
        first.analyze.assert_called_once_with(merge)
        second.analyze.assert_not_called()

    def test_direct_revert_without_window_merges_resolves_older_pr(self):
        work = self.root / "work"
        work.mkdir()
        env = git_environment()

        def git(*args):
            return subprocess.run(["git", "-C", str(work), *args], env=env,
                                  check=True, capture_output=True, text=True).stdout.strip()

        git("init", "-b", "trunk")
        git("config", "user.email", "test@example.invalid")
        git("config", "user.name", "Fixture")
        (work / "behavior.txt").write_text("older merged behavior\n")
        git("add", ".")
        git("commit", "-m", "feat: old behavior (#1)")
        original = pr(1, at="2026-08-01T10:00:00Z", sha=git("rev-parse", "HEAD"))
        git("revert", "--no-edit", "HEAD")
        reverted = git("rev-parse", "HEAD")
        original_git = ledger.git

        def fixed_log_time(mirror_path, *args, **kwargs):
            if args and args[0] == "log":
                return (f"{reverted}\0" "2026-10-16T10:00:00Z\0"
                        f'Revert "feat: old behavior (#1)"\n\n'
                        f"This reverts commit {original['mergeCommit']['oid']}.\n\0\0\n")
            return original_git(mirror_path, *args, **kwargs)

        with patch.object(ledger, "GitHub") as gh, \
                patch.object(ledger, "ensure_mirror", return_value=work / ".git") as mirror, \
                patch.object(ledger, "git", side_effect=fixed_log_time), \
                contextlib.redirect_stdout(io.StringIO()):
            gh.return_value.repos.return_value = ["Org/repo"]
            gh.return_value.merged.return_value = []
            gh.return_value.default_branches = {"Org/repo": "trunk"}
            gh.return_value.pull.return_value = original
            self.assertEqual(ledger.run(self.args), 0)
            mirror.assert_called_once()
            gh.return_value.pull.assert_called_once_with("Org/repo", 1)
        records = [json.loads(l) for l in (self.root / "ops/kpi/escapes.jsonl").read_text().splitlines()]
        self.assertEqual(records[0]["merges"], 0)
        self.assertEqual(records[0]["escapes"], 1)
        self.assertEqual(records[0]["coverage"][0]["status"], "complete")
        event = next(r for r in records if r["type"] == "escape")
        self.assertEqual(event["commit"], reverted)
        self.assertEqual(event["introducers"][0]["number"], 1)
        self.assertEqual(event["introducers"][0]["evidence"], [
            {"method": "direct_git_revert", "commit": original["mergeCommit"]["oid"]}])
        for repo in ("Org/repo", "ALL"):
            for period in ("day", "week"):
                rows = [r for r in records if r.get("period") == period and r["repo"] == repo]
                self.assertEqual(sum(r["reverts"] for r in rows), 1)
                self.assertTrue(all(r["escapes_per_100_merges"] is None for r in rows))

    def test_missing_optional_legacy_log_uses_configured_incident_sources(self):
        (self.root / "ops/worker-vps/operator-actions.log").unlink()
        self.args.memory_dir = self.root / "memory"
        self.args.memory_dir.mkdir()
        (self.args.memory_dir / "incident-20261002.md").write_text("Incident Org/repo#1 regression\n")
        with patch.object(ledger, "GitHub") as gh, patch.object(ledger, "Linker") as linker, \
                patch.object(ledger, "ensure_mirror"), patch.object(ledger, "ensure_commit"), \
                contextlib.redirect_stdout(io.StringIO()):
            gh.return_value.repos.return_value = ["Org/repo"]
            gh.return_value.merged.return_value = [pr()]
            gh.return_value.default_branches = {"Org/repo": "main"}
            linker.return_value.prs = {1: pr()}
            linker.return_value.unresolved_revert_commits = 0
            linker.return_value.analyze.return_value = None
            linker.return_value.direct_reverts.return_value = []
            self.assertEqual(ledger.run(self.args), 0)
        records = [json.loads(line) for line in (self.root / "ops/kpi/escapes.jsonl").read_text().splitlines()]
        self.assertEqual(records[0]["status"], "complete")
        self.assertEqual(records[0]["escapes"], 1)
        self.assertTrue((self.root / "ops/kpi/escape-history/2026-10-17.jsonl").exists())

    def test_run_uses_memory_directory_derived_from_checkout(self):
        checkout = self.root / "my_repo.v1"
        legacy = checkout / "ops/worker-vps/operator-actions.log"
        legacy.parent.mkdir(parents=True)
        legacy.write_text("")
        self.args.root = checkout
        self.args.memory_dir = None
        self.args.memory_dir_from_root = True
        with tempfile.TemporaryDirectory() as home:
            project = (str(checkout.resolve()).lstrip(os.sep).replace(os.sep, "-")
                       .replace("_", "-").replace(".", "-"))
            memory = Path(home) / ".claude/projects" / ("-" + project) / "memory"
            memory.mkdir(parents=True)
            note = memory / "incident-20261002.md"
            note.write_text("Incident Org/repo#1 regression\n")
            with patch.object(Path, "home", return_value=Path(home)):
                self.assertEqual(self.run_without_candidates(), 0)
        records = [json.loads(line) for line in (self.root / "ops/kpi/escapes.jsonl").read_text().splitlines()]
        incidents = [row for row in records if row.get("type") == "escape" and row.get("kind") == "incident"]
        self.assertEqual(records[0]["status"], "complete")
        self.assertEqual(len(incidents), 1)
        self.assertEqual(incidents[0]["source"], str(note))

    def test_empty_xdg_state_home_uses_absolute_home_state_dir(self):
        self.args.output_dir = None
        original_cwd = Path.cwd()
        with tempfile.TemporaryDirectory() as sandbox:
            home = Path(sandbox) / "home"
            home.mkdir()
            os.chdir(self.root)
            try:
                for state_home in (None, "", "relative/dir", " ", "~/state"):
                    with self.subTest(xdg_state_home=state_home), patch.dict(os.environ, {}, clear=False):
                        if state_home is None:
                            os.environ.pop("XDG_STATE_HOME", None)
                        else:
                            os.environ["XDG_STATE_HOME"] = state_home
                        with patch.object(Path, "home", return_value=home):
                            self.assertEqual(self.run_without_candidates(), 0)
                        output = home / ".local/state/togetherweown/escape-ledger"
                        self.assertTrue((output / "escapes.jsonl").is_file())
                        cwd_output = self.root / Path(state_home or "") / "togetherweown/escape-ledger"
                        self.assertFalse(cwd_output.exists())
            finally:
                os.chdir(original_cwd)

    def test_missing_configured_memory_directory_is_partial(self):
        self.args.memory_dir = self.root / "missing-memory"
        self.assert_incident_partial(expected_incidents=0)

    def test_unreadable_incident_source_publishes_partial_counts(self):
        source = self.root / "ops/worker-vps/operator-actions.log"
        original_open = Path.open

        def failing_open(path, *args, **kwargs):
            if path == source:
                raise PermissionError("synthetic unreadable source")
            return original_open(path, *args, **kwargs)

        with patch.object(Path, "open", failing_open):
            self.assert_incident_partial(expected_incidents=0, expected_error="incident source unreadable:")

    def test_malformed_incident_date_preserves_later_valid_events(self):
        source = self.root / "ops/worker-vps/operator-actions.log"
        source.write_text("2026-10-99T10:00:00Z INCIDENT Org/repo#1 sensitive-value\n"
                          "2026-10-02T10:00:00Z INCIDENT Org/repo#1 observed\n")
        self.assert_incident_partial(expected_incidents=1, expected_error=f"incident date invalid: {source}:1")

    def test_malformed_incident_filename_date_publishes_partial(self):
        self.args.memory_dir = self.root / "memory"
        self.args.memory_dir.mkdir()
        source = self.args.memory_dir / "incident-20261099.md"
        source.write_text("Incident Org/repo#1 sensitive-value\n")
        self.assert_incident_partial(expected_incidents=0, expected_error=f"incident date invalid: {source}:1")

    def assert_incident_partial(self, expected_incidents, expected_error=None):
        repos = ["Org/repo", "Org/other"]
        with patch.object(ledger, "GitHub") as gh, patch.object(ledger, "Linker") as linker, \
                patch.object(ledger, "ensure_mirror"), patch.object(ledger, "ensure_commit"), \
                contextlib.redirect_stdout(io.StringIO()):
            gh.return_value.repos.return_value = repos
            gh.return_value.merged.return_value = [pr()]
            gh.return_value.default_branches = dict.fromkeys(repos, "main")
            linker.return_value.prs = {1: pr()}
            linker.return_value.unresolved_revert_commits = 0
            linker.return_value.analyze.return_value = None
            linker.return_value.direct_reverts.return_value = []
            self.assertEqual(ledger.run(self.args), 2)
        records = [json.loads(l) for l in (self.root / "ops/kpi/escapes.jsonl").read_text().splitlines()]
        meta = records[0]
        self.assertEqual(meta["status"], "partial")
        if expected_error:
            self.assertTrue(any(expected_error in message for message in meta["errors"]), meta["errors"])
        self.assertNotIn("sensitive-value", json.dumps(records))
        self.assertEqual(meta["merges"], 2)
        self.assertEqual(meta["escapes"], expected_incidents)
        self.assertIsNone(meta["escapes_per_100_merges"])
        self.assertTrue(all(r["status"] == "partial" for r in meta["coverage"]))
        rows = [r for r in records if r["type"] == "aggregate"]
        self.assertEqual({r["period"] for r in rows}, {"day", "week"})
        self.assertTrue(all(r["coverage_status"] == "partial" for r in rows))
        self.assertTrue(all(r["escapes_per_100_merges"] is None for r in rows))
        for period in ("day", "week"):
            org_rows = [r for r in rows if r["period"] == period and r["repo"] == "ALL"]
            self.assertEqual(sum(r["merges"] for r in org_rows), 2)
            self.assertEqual(sum(r["incidents"] for r in org_rows), expected_incidents)
        markdown = (self.root / "ops/kpi/ESCAPES.md").read_text()
        for repo in [*repos, "ALL"]:
            row = next(l for l in markdown.splitlines() if l.startswith(f"| {repo} (PARTIAL;"))
            self.assertTrue(row.endswith("| N/A |"), row)
        self.assertFalse((self.root / "ops/kpi/escape-history/2026-10-17.jsonl").exists())

    def test_collection_failure_emits_partial_not_zero_percent(self):
        with patch.object(ledger, "GitHub") as gh, contextlib.redirect_stdout(io.StringIO()):
            gh.return_value.repos.return_value = ["Org/repo"]
            gh.return_value.merged.side_effect = ledger.CollectionError("API unavailable")
            self.assertEqual(ledger.run(self.args), 2)
        records = [json.loads(l) for l in (self.root / "ops/kpi/escapes.jsonl").read_text().splitlines()]
        self.assertEqual(records[0]["status"], "partial")
        self.assertIsNone(records[0]["escapes_per_100_merges"])
        self.assertTrue(all(r["escapes_per_100_merges"] is None for r in records if r["type"] == "aggregate"))
        self.assertIn("PARTIAL; observed counts only", (self.root / "ops/kpi/ESCAPES.md").read_text())
        self.assertFalse((self.root / "ops/kpi/escape-history/2026-10-17.jsonl").exists())


class EntryPointIsolation(unittest.TestCase):
    def test_service_ignores_ambient_and_script_directory_imports(self):
        unit = Path(__file__).with_name("escape-ledger.service").read_text()
        command = shlex.split(next(l.removeprefix("ExecStart=") for l in unit.splitlines()
                                   if l.startswith("ExecStart=")))
        script_index = next(i for i, arg in enumerate(command) if arg.endswith("/escape_ledger.py"))
        self.assertIn("--container-runtime", command)
        self.assertIn("docker", command)
        self.assertIn("--memory-dir-from-root", command)
        output_index = command.index("--output-dir") + 1
        self.assertNotIn("paperclip-enterprise-company", command[output_index])
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            script_dir, ambient, cwd = (root / name for name in ("script", "ambient", "cwd"))
            for directory in (script_dir, ambient, cwd):
                directory.mkdir()
            script = script_dir / "escape_ledger.py"
            shutil.copyfile(Path(__file__).with_name("escape_ledger.py"), script)
            for directory in (script_dir, ambient, cwd):
                with self.subTest(shadow_directory=directory.name):
                    canary = directory / "json.py"
                    canary.write_text("raise RuntimeError('import-shadow-canary')\n")
                    result = subprocess.run([*command[:script_index], str(script), "--help"],
                        cwd=cwd, env=dict(os.environ, PYTHONPATH=str(ambient)),
                        capture_output=True, text=True, timeout=30)
                    canary.unlink()
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn("--mirror-root", result.stdout)
                    self.assertNotIn("import-shadow-canary", result.stderr)

    def test_memory_directory_is_derived_from_project_root(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "paperclip" / "my_repo.v1"
            project = (str(root.resolve()).lstrip(os.sep).replace(os.sep, "-")
                       .replace("_", "-").replace(".", "-"))
            self.assertEqual(ledger.memory_dir_for_root(root),
                             Path.home() / ".claude/projects" / ("-" + project) / "memory")
        # A root whose first component starts with a non-alphanumeric
        # keeps every leading dash: "/.paperclip/repo" is
        # "--paperclip-repo", not "-paperclip-repo". Stripping
        # (lstrip("-")) resolves a directory Claude Code never wrote to
        # and every repo stays partial.
        self.assertEqual(
            ledger.memory_dir_for_root(Path("/.paperclip/repo")),
            Path.home() / ".claude/projects" / "--paperclip-repo" / "memory")

    def test_escape_ledger_runtime_state_is_git_ignored(self):
        checkout = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            shutil.copyfile(checkout / ".gitignore", root / ".gitignore")
            subprocess.run(["git", "init", "-q"], cwd=root, env=git_environment(), check=True)
            paths = (
                "ops/kpi/escapes.jsonl",
                "ops/kpi/ESCAPES.md",
                "ops/kpi/.escape-cache/Org/repo.json",
                "ops/kpi/escape-history/2026-10-17.jsonl",
                "ops/kpi/.escape-ledger.lock",
            )
            for path in paths:
                with self.subTest(path=path):
                    result = subprocess.run(["git", "check-ignore", "--quiet", path], cwd=root,
                                            env=git_environment(), capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0, path)

    def test_ci_command_ignores_ambient_and_working_directory_imports(self):
        workflow = Path(__file__).resolve().parents[2] / ".github/workflows/ci.yml"
        lines = workflow.read_text().splitlines()
        index = lines.index("      - name: escape ledger linkage suite")
        command = shlex.split(lines[index + 1].strip().removeprefix("run: "))
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            suite_dir = root / "ops/kpi"
            suite_dir.mkdir(parents=True)
            # Run the delivered CI invocation against a tiny suite, not recursively
            # against this suite. unittest discovery intentionally adds ops/kpi.
            (suite_dir / "test_escape_ledger.py").write_text(
                "import json, unittest\nclass Startup(unittest.TestCase):\n"
                "    def test_stdlib(self):\n        self.assertEqual(json.loads('1'), 1)\n")
            ambient = root / "ambient"
            ambient.mkdir()
            for directory in (ambient, root):
                with self.subTest(shadow_directory=directory.name):
                    canary = directory / "json.py"
                    canary.write_text("raise RuntimeError('import-shadow-canary')\n")
                    result = subprocess.run(command, cwd=root,
                        env=dict(os.environ, PYTHONPATH=str(ambient)),
                        capture_output=True, text=True, timeout=30)
                    canary.unlink()
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn("Ran 1 test", result.stderr)


class Metrics(unittest.TestCase):
    def test_event_not_link_count_and_zero_denominator(self):
        start, end = map(ledger.instant, ["2026-10-01T00:00:00Z", "2026-10-02T12:00:00Z"])
        merges = [dict(pr(), repo="Org/repo")]
        events = [{"repo": "Org/repo", "at": "2026-10-02T10:00:00Z", "kind": "hotfix", "introducers": [1, 2]}]
        rows = ledger.aggregate(merges, events, ["Org/repo"], start, end)
        daily = [r for r in rows if r["repo"] == "ALL" and r["period"] == "day"]
        self.assertEqual(daily[1]["escapes"], 1)
        self.assertIsNone(daily[1]["escapes_per_100_merges"])
        weekly = [r for r in rows if r["repo"] == "ALL" and r["period"] == "week"][0]
        self.assertEqual(weekly["merges_per_day"], 0.5)
        self.assertEqual(weekly["escapes_per_100_merges"], 100)

    def test_incidents_require_link_and_no_raw_log_leak(self):
        with tempfile.TemporaryDirectory() as root:
            p = Path(root) / "operator-actions.log"
            p.write_text("2026-10-02T10:00:00Z INCIDENT Org/repo#1 sensitive-value\n"
                         "2026-10-02T11:00:00Z INCIDENT no link sensitive-value\n")
            events, unlinked, errors = ledger.collect_incidents([p], ["Org/repo"], {"Org/repo": {1: pr()}},
                ledger.instant("2026-10-01T00:00:00Z"), ledger.instant("2026-10-03T00:00:00Z"))
            self.assertEqual(len(events), 1)
            self.assertEqual(len(unlinked), 1)
            self.assertEqual(events[0]["introducers"][0]["number"], 1)
            self.assertNotIn("sensitive-value", json.dumps(events + unlinked))

    def test_incident_commit_prefix_linkage_and_ambiguity(self):
        with tempfile.TemporaryDirectory() as root:
            p = Path(root) / "operator-actions.log"
            p.write_text("2026-10-02T10:00:00Z INCIDENT redeploy same sha abcdef12\n")
            record = pr(sha="abcdef12" + "a" * 32)
            index = {"Org/repo": {1: record}}
            start, end = map(ledger.instant, ["2026-10-01T00:00:00Z", "2026-10-03T00:00:00Z"])
            events, unlinked, errors = ledger.collect_incidents([p], list(index), index, start, end)
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]["introducers"][0]["evidence"][0]["method"], "incident_commit_reference")
            index["Org/fork"] = {1: record}
            events, unlinked, errors = ledger.collect_incidents([p], list(index), index, start, end)
            self.assertEqual(events, [])
            self.assertEqual(len(unlinked), 1)

    def test_memory_same_day_merge_uses_day_precision(self):
        with tempfile.TemporaryDirectory() as root:
            p = Path(root) / "note-20261001.md"
            p.write_text("Incident Org/repo#1 regression\n")
            events, unlinked, errors = ledger.collect_incidents([p], ["Org/repo"], {"Org/repo": {1: pr()}},
                ledger.instant("2026-10-01T00:00:00Z"), ledger.instant("2026-10-03T00:00:00Z"))
            self.assertEqual(events[0]["time_precision"], "day")
            self.assertEqual(unlinked, [])

    def test_inline_dated_incident_copies_are_deduplicated_across_sources(self):
        with tempfile.TemporaryDirectory() as root:
            first = Path(root) / "operator-actions.log"
            second = Path(root) / "incident-copy.md"
            line = "2026-10-02T10:00:00Z INCIDENT Org/repo#1 repeated rollout\n"
            first.write_text(line + line)
            second.write_text(line)
            events, unlinked, errors = ledger.collect_incidents([first, second], ["Org/repo"],
                {"Org/repo": {1: pr()}}, ledger.instant("2026-10-01T00:00:00Z"),
                ledger.instant("2026-10-03T00:00:00Z"))
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]["introducers"][0]["number"], 1)
            self.assertEqual(unlinked, [])
            self.assertEqual(errors, [])

    def test_same_note_on_different_dates_is_not_deduplicated(self):
        with tempfile.TemporaryDirectory() as root:
            paths = [Path(root) / name for name in (
                "incident-20261002.md", "incident-20261003.md", "copy-20261003.md")]
            for path in paths:
                path.write_text("Incident Org/repo#1 recurring regression\n")
            events, unlinked, errors = ledger.collect_incidents(paths, ["Org/repo"], {"Org/repo": {1: pr()}},
                ledger.instant("2026-10-01T00:00:00Z"), ledger.instant("2026-10-04T00:00:00Z"))
            self.assertEqual(len(events), 3)
            self.assertEqual(len({e["id"] for e in events}), 3)
            self.assertEqual({e["at"] for e in events}, {"2026-10-02T00:00:00Z", "2026-10-03T00:00:00Z"})
            self.assertEqual(unlinked, [])
            self.assertEqual(errors, [])

    def test_timezone_free_timestamp_uses_day_precision_for_link_cutoff(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "incident.md"
            path.write_text("2026-10-01T10:00:00 INCIDENT Org/repo#1 regression\n")
            events, unlinked, errors = ledger.collect_incidents([path], ["Org/repo"],
                {"Org/repo": {1: pr(at="2026-10-01T10:00:00Z")}},
                ledger.instant("2026-10-01T00:00:00Z"), ledger.instant("2026-10-02T00:00:00Z"))
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]["time_precision"], "day")
            self.assertEqual(unlinked, [])
            self.assertEqual(errors, [])

    def test_memory_note_date_and_cross_repo_exclusion(self):
        with tempfile.TemporaryDirectory() as root:
            p = Path(root) / "incident-20261002.md"
            p.write_text("Incident Org/other#1; repo unrelated\n")
            events, unlinked, errors = ledger.collect_incidents([p], ["Org/repo"], {"Org/repo": {1: pr()}},
                ledger.instant("2026-10-01T00:00:00Z"), ledger.instant("2026-10-03T00:00:00Z"))
            self.assertEqual(events, [])
            self.assertEqual(len(unlinked), 1)


if __name__ == "__main__":
    unittest.main()
