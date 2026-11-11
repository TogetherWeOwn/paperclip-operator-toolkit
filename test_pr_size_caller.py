#!/usr/bin/env python3
# ===========================================================================
# test_pr_size_caller.py -- wiring guard for the pr-size caller workflow
#
# The labeller is advisory only: these pins keep it that way. The advisory
# jobs must never join the required set; `pr-size-gate` is the one deliberate
# required exception and must name the gate reusable. Each caller job grants
# only what the reusable it calls requests (GitHub checks a reusable
# workflow's nested-job permissions against the caller job's grant).
# All labelling logic lives once in the org `.github` repository and runs
# from there at a pinned SHA, so this repo keeps no script copy a pull
# request could modify or delete to silence its own label; behaviour is
# tested centrally next to the script.
# ===========================================================================
import os
import unittest

try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None

HERE = os.path.dirname(os.path.abspath(__file__))
WORKFLOW = os.path.join(HERE, ".github", "workflows", "pr-size.yml")
CENTRAL = "TogetherWeOwn/.github/.github/workflows"
# Reviewed org main at caller adoption. Repinning the caller requires
# updating this constant in the same PR.
REVIEWED_CENTRAL_SHA = "86aec407d4fccc8b30ed9f9e484661f5d258239d"


def load():
    with open(WORKFLOW) as f:
        return yaml.safe_load(f)


class PrSizeCallerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if yaml is None:
            raise unittest.SkipTest("PyYAML not installed")
        cls.doc = load()
        cls.jobs = cls.doc["jobs"]

    def test_pins(self):
        self.assertEqual(
            set(self.jobs), {"pr-size", "pr-size-gate", "pr-size-weekly"}
        )
        pins = {}
        for job_id in ("pr-size", "pr-size-gate", "pr-size-weekly"):
            job = self.jobs[job_id]
            uses = job["uses"]
            prefix = f"{CENTRAL}/{job_id}.yml@" if job_id != "pr-size-weekly" else f"{CENTRAL}/pr-size-weekly.yml@"
            self.assertTrue(uses.startswith(prefix), uses)
            sha = uses[len(prefix):]
            self.assertEqual(len(sha), 40, sha)
            self.assertTrue(all(c in "0123456789abcdef" for c in sha), sha)
            pins[job_id] = sha
        # All three reusables pinned to the same reviewed SHA.
        self.assertEqual(pins, {j: REVIEWED_CENTRAL_SHA for j in pins})
        # No floating refs, no secrets passthrough: the caller token stays
        # capped by the job grants below.
        with open(WORKFLOW) as f:
            raw = f.read()
        self.assertEqual(raw.count("\n    uses: "), 3)
        self.assertNotIn("secrets:", raw)

    def test_permissions(self):
        self.assertEqual(self.doc["permissions"], {"contents": "read"})
        for job_id in ("pr-size", "pr-size-gate"):
            self.assertEqual(
                self.jobs[job_id]["permissions"],
                {"contents": "read", "issues": "write", "pull-requests": "write"},
            )
        weekly = self.jobs["pr-size-weekly"]["permissions"]
        self.assertEqual(
            weekly,
            {"contents": "read", "issues": "read", "pull-requests": "read"},
        )

    def test_triggers(self):
        on = self.doc[True] if True in self.doc else self.doc["on"]
        pr = on["pull_request"]
        self.assertEqual(
            sorted(pr["types"]),
            ["edited", "labeled", "opened", "ready_for_review", "reopened", "synchronize", "unlabeled"],
        )
        self.assertEqual(sorted(on["pull_request_review"]["types"]), ["dismissed", "submitted"])
        self.assertEqual(on["schedule"], [{"cron": "17 7 * * 1"}])
        self.assertIn("pr_number", on["workflow_dispatch"]["inputs"])
        # The gate re-evaluates when an exception is granted or revoked.
        self.assertIn("labeled", pr["types"])
        self.assertIn("unlabeled", pr["types"])

    def test_gate_event_condition(self):
        self.assertEqual(
            self.jobs["pr-size-gate"]["if"],
            "github.event_name == 'pull_request' || "
            "github.event_name == 'pull_request_review' || inputs.pr_number != ''",
        )

    def test_dispatch_concurrency_is_separate(self):
        group = self.doc["concurrency"]["group"]
        self.assertIn("github.event_name == 'workflow_dispatch' && '-dispatch'", group)
        self.assertEqual(
            self.doc["concurrency"]["cancel-in-progress"],
            "${{ github.event_name == 'pull_request' }}",
        )

    def test_exclude_extra(self):
        # This repo has no generated paths beyond the script defaults
        # (dist/**, *.map, *.lock, package-lock.json, **/fixtures/**),
        # so both jobs stay empty. See the caller comment.
        for job_id in ("pr-size", "pr-size-gate"):
            self.assertEqual(self.jobs[job_id]["with"]["exclude-extra"], "")


if __name__ == "__main__":
    unittest.main()
