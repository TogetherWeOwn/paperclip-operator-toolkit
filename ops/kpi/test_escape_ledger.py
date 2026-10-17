#!/usr/bin/env python3
"""Offline linkage and failure contracts; no credentials, network, or database."""
import argparse
import contextlib
import datetime as dt
import io
import importlib.util
import json
import os
from pathlib import Path
import subprocess
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
                              env=dict(os.environ, GIT_AUTHOR_DATE="2026-10-02T10:00:00Z",
                                       GIT_COMMITTER_DATE="2026-10-02T10:00:00Z"),
                              capture_output=True, text=True).stdout

    def analyze(self, title="fix: regression", body="", at="2026-10-02T10:00:00Z", branch="feature"):
        sha = self.g("rev-parse", "HEAD").strip()
        fix = pr(2, at, title, sha=sha, body=body, branch=branch)
        mirror = self.root / "mirror.git"
        subprocess.run(["git", "clone", "--mirror", str(self.work), str(mirror)],
                       check=True, capture_output=True)
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
                       check=True, capture_output=True)
        linker = ledger.Linker("Org/repo", mirror, [self.intro])
        events = linker.direct_reverts(["main", "main", "deleted-historical-base"],
            ledger.instant("2020-01-01T00:00:00Z"), ledger.instant("2030-01-01T00:00:00Z"))
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["introducers"][0]["number"], 1)
        self.assertEqual(events[0]["introducers"][0]["evidence"][0]["method"], "direct_git_revert")
        linker.by_sha[self.g("rev-parse", "HEAD").strip()] = 2
        self.assertEqual(linker.direct_reverts(["main"],
            ledger.instant("2020-01-01T00:00:00Z"), ledger.instant("2030-01-01T00:00:00Z")), [])

    def test_old_revert_target_resolved_beyond_lookup_window(self):
        mirror = self.root / "old.git"
        subprocess.run(["git", "clone", "--mirror", str(self.work), str(mirror)],
                       check=True, capture_output=True)
        resolver = unittest.mock.Mock(return_value=self.intro)
        linker = ledger.Linker("Org/repo", mirror, [], resolver=resolver)
        self.assertEqual(linker.introducing_pr(self.intro_sha), 1)
        self.assertEqual(linker.resolve(1), self.intro)
        linker.resolve(1)
        resolver.assert_called_once_with("Org/repo", 1)

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

    def test_latest_same_head_failure_supersedes_pass(self):
        records = [self.row(), self.row(id="r2", score="4", conclusion="failure", completed_at="2026-10-01T09:30:00Z")]
        self.assertFalse(ledger.review_status(pr(), records)["claude_5_of_5"])


class Collection(unittest.TestCase):
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
            mirror_root=self.root / "mirrors", memory_dir=None)

    def tearDown(self):
        self.temp.cleanup()

    def test_successful_collection_publishes_parseable_snapshot_and_exact_window(self):
        prs = [pr(), pr(2, at="2026-10-02T10:00:00Z", title="fix: regression")]
        with patch.object(ledger, "GitHub") as gh, patch.object(ledger, "Linker") as linker, \
                patch.object(ledger, "ensure_mirror"), patch.object(ledger, "ensure_commit"), \
                contextlib.redirect_stdout(io.StringIO()):
            gh.return_value.repos.return_value = ["Org/repo"]
            gh.return_value.merged.return_value = prs
            gh.return_value.default_branches = {"Org/repo": "main"}
            instance = linker.return_value
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
            events, unlinked = ledger.collect_incidents([p], ["Org/repo"], {"Org/repo": {1: pr()}},
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
            events, unlinked = ledger.collect_incidents([p], list(index), index, start, end)
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]["introducers"][0]["evidence"][0]["method"], "incident_commit_reference")
            index["Org/fork"] = {1: record}
            events, unlinked = ledger.collect_incidents([p], list(index), index, start, end)
            self.assertEqual(events, [])
            self.assertEqual(len(unlinked), 1)

    def test_memory_same_day_merge_uses_day_precision(self):
        with tempfile.TemporaryDirectory() as root:
            p = Path(root) / "note-20261001.md"
            p.write_text("Incident Org/repo#1 regression\n")
            events, unlinked = ledger.collect_incidents([p], ["Org/repo"], {"Org/repo": {1: pr()}},
                ledger.instant("2026-10-01T00:00:00Z"), ledger.instant("2026-10-03T00:00:00Z"))
            self.assertEqual(events[0]["time_precision"], "day")
            self.assertEqual(unlinked, [])

    def test_memory_note_date_and_cross_repo_exclusion(self):
        with tempfile.TemporaryDirectory() as root:
            p = Path(root) / "incident-20261002.md"
            p.write_text("Incident Org/other#1; repo unrelated\n")
            events, unlinked = ledger.collect_incidents([p], ["Org/repo"], {"Org/repo": {1: pr()}},
                ledger.instant("2026-10-01T00:00:00Z"), ledger.instant("2026-10-03T00:00:00Z"))
            self.assertEqual(events, [])
            self.assertEqual(len(unlinked), 1)


if __name__ == "__main__":
    unittest.main()
