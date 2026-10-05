#!/usr/bin/env python3
"""Hermetic synthetic consistency tests. No fixture is a live approval or pin.

All repositories, record links, UUIDs, hashes, PR numbers, times, scan claims and
review claims below are explicitly synthetic. No operational evidence producer,
credential, network request, database or deployed service is used. Full-audit
integration replaces both git and curl with local refusing/recording fakes.
"""
from copy import deepcopy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

import public_fork_provenance as gate

ROOT = Path(__file__).resolve().parent
RANGE_FIXTURE = Path("test/fixtures/provenance/synthetic_release_ranges.json")
POLICY_DATA = {"version": 1, "repository": "fixture-owner/synthetic-project",
               "recordNamespace": "synthetic-fixture", "cardPrefix": "ISSUE",
               "releaseRefs": ["refs/heads/master"],
               "releasePrefixes": ["refs/heads/release/", "refs/heads/maintenance/"]}
POLICY = gate.parse_policy(POLICY_DATA)
REPOSITORY = POLICY.repository
AUTHOR = "00000000-0000-4000-8000-000000000001"
REVIEWER = "00000000-0000-4000-8000-000000000002"
LINK = "/synthetic-fixture/issues/ISSUE-1#comment-synthetic-offline-fixture"
NOW = datetime(2000, 1, 2, 12, tzinfo=timezone.utc)
BEFORE = "2000-01-02T10:00:00Z"
AFTER = "2000-01-02T11:00:00Z"
CAPTURE = "2000-01-02T12:00:00Z"
FUTURE = "2000-01-03T00:00:00Z"


def sha(n):
    return f"{n:040x}"


def review(head, base, merge):
    return {"agentId": REVIEWER, "headSha": head, "baseSha": base,
            "mergeSha": merge, "verdict": "APPROVE", "observedAt": BEFORE,
            "record": LINK, "superseded": False}


def transition(parent, merge, head, ref="refs/heads/master", number=1):
    pubs = [{"sha": s, "addedLinesDigest": "a" * 64, "messageDigest": "b" * 64,
             "firstPublicAt": AFTER} for s in dict.fromkeys([head, merge])]
    return {"kind": "squash", "destinationRef": ref,
            "pr": {"number": number, "headRepo": REPOSITORY, "headRef": "refs/heads/fix/synthetic",
                   "headSha": head, "baseRepo": REPOSITORY, "baseRef": ref,
                   "baseSha": parent, "authorAgentId": AUTHOR, "mergedAt": AFTER},
            "mergeSha": merge, "mergeParents": [parent], "publications": pubs,
            "authorScan": {"agentId": AUTHOR, "observedAt": BEFORE, "record": LINK,
                           "publications": [{k: p[k] for k in ("sha", "addedLinesDigest", "messageDigest")} for p in pubs]},
            "codeReview": review(head, parent, merge),
            "disclosureReview": review(head, parent, merge), "integrationReview": None,
            "weakness": {"applicable": "no", "agentId": REVIEWER, "observedAt": BEFORE,
                         "record": LINK, "alternative": None}, "holds": [], "findings": []}


def fixture(timing="POSTHOC"):
    r = {"repository": REPOSITORY, "ref": "refs/heads/master", "tipSha": sha(3),
         "capturedAt": CAPTURE,
         "checkpoint": {"sha": sha(1), "timingClass": timing, "decisionAt": BEFORE,
                        "agentId": REVIEWER, "record": LINK, "firstPublicAt": "unknown"},
         "history": {"state": "complete", "checkpointSha": sha(1), "tipSha": sha(3),
                     "commits": [{"sha": sha(3), "parents": [sha(1)]}]},
         "transitions": [transition(sha(1), sha(3), sha(2))]}
    pin = {"sha": sha(1), "timingClass": timing, "decisionAt": BEFORE,
           "card": "ISSUE-1", "firstPublicAt": "unknown"}
    return r, pin


def assess(r, pin, policy=POLICY):
    gate.validate_record(r, policy)
    return gate.evaluate([r], r["repository"], r["ref"], r["tipSha"], pin, NOW, policy)


def offline_env(directory):
    # Do not inherit BASH_ENV, credential wrappers, credentials or proxy settings.
    return {"PATH": "/usr/bin:/bin", "HOME": str(directory), "TMPDIR": str(directory),
            "PYTHONDONTWRITEBYTECODE": "1", "LC_ALL": "C"}


def shell_inputs(directory, r):
    """Write synthetic operator-owned policy/pin separately from the snapshot."""
    directory = Path(directory)
    policy = directory / "synthetic-policy.json"
    policy.write_text(json.dumps(POLICY_DATA))
    pins = directory / "synthetic-posthoc.txt"
    c = r["checkpoint"]
    pins.write_text(f"synthetic-project|{r['ref']}|{c['sha']}|ISSUE-1|unknown|{c['decisionAt']}|synthetic offline pin, not approval\n")
    declared = directory / "synthetic-declared.txt"
    declared.write_text("")
    config = {"version": 1, "organization": "fixture-owner",
              "authorDomains": ["fixture.invalid"], "botLogins": ["fixture-publisher[bot]"],
              "trackerPrefixes": ["ISSUE", "fixture"], "privateProbe": "fixture-private/probe",
              "declaredFile": str(declared), "posthocFile": str(pins),
              "provenancePolicyFile": str(policy), "parentCacheFile": str(directory / "cache")}
    config_path = directory / "synthetic-audit-config.json"
    config_path.write_text(json.dumps(config))
    env = offline_env(directory)
    env["DISCLOSURE_AUDIT_CONFIG_FILE"] = str(config_path)
    return env


class Consistency(unittest.TestCase):
    def test_reviewed_successor_preserves_posthoc(self):
        r, pin = fixture()
        out = assess(r, pin)
        self.assertEqual(out["status"], "consistent-snapshot")
        self.assertEqual(out["candidateTimingClass"], "POSTHOC")
        self.assertIs(out["acceptanceEnabled"], False)

    def test_declared_checkpoint_and_all_prepush_closures(self):
        r, pin = fixture("DECLARED")
        out = assess(r, pin)
        self.assertEqual(out["status"], "consistent-snapshot")
        self.assertEqual(out["candidateTimingClass"], "DECLARED")
        self.assertIs(out["acceptanceEnabled"], False)

    def test_unknown_or_postpush_never_declared(self):
        for first in ("unknown", BEFORE):
            with self.subTest(first=first):
                r, pin = fixture("DECLARED")
                r["transitions"][0]["publications"][0]["firstPublicAt"] = first
                out = assess(r, pin)
                self.assertEqual(out["status"], "consistent-snapshot")
                self.assertEqual(out["candidateTimingClass"], "POSTHOC")

    def test_earlier_leaf_cannot_be_hidden_by_final_approval(self):
        r, pin = fixture()
        r["tipSha"] = r["history"]["tipSha"] = sha(5)
        r["history"]["commits"].append({"sha": sha(5), "parents": [sha(3)]})
        r["transitions"].append(transition(sha(3), sha(5), sha(4), number=2))
        self.assertEqual(assess(r, pin)["status"], "consistent-snapshot")
        for surface in ("message", "added-lines"):
            r["transitions"][0]["findings"] = [{"sha": sha(3), "surface": surface, "code": "operational-disclosure"}]
            self.assertEqual(assess(r, pin)["status"], "finding")
            self.assertIn("range-disclosure-finding", assess(r, pin)["codes"])

    def test_evaluated_missing_evidence_and_moved_head(self):
        r, pin = fixture()
        self.assertEqual(gate.evaluate([], REPOSITORY, r["ref"], r["tipSha"], pin, NOW, POLICY)["status"], "finding")
        self.assertIn("moved-head", gate.evaluate([r], REPOSITORY, r["ref"], sha(9), pin, NOW, POLICY)["codes"])
        self.assertIn("missing-ref-evidence", gate.evaluate([r], "elsewhere/synthetic-project", r["ref"], r["tipSha"], pin, NOW, POLICY)["codes"])

    def test_fail_closed_negative_controls(self):
        # Each mutation starts from the same valid control: no unrelated conjunct can kill it.
        mutations = [
            ("moved-checkpoint", lambda r: r["checkpoint"].update(sha=sha(8)), "unaccepted-or-moved-checkpoint"),
            ("backdated-decision", lambda r: r["checkpoint"].update(decisionAt=AFTER), "unaccepted-or-moved-checkpoint"),
            ("relabel-checkpoint", lambda r: r["checkpoint"].update(firstPublicAt=AFTER), "checkpoint-timing-relabelled"),
            ("direct", lambda r: r["transitions"][0].update(kind="direct"), "unsupported-transition-exact-pin-only"),
            ("cherry-pick", lambda r: r["transitions"][0].update(kind="cherry-pick"), "unsupported-transition-exact-pin-only"),
            ("rewrite", lambda r: r["history"]["commits"][0].update(parents=[sha(8)]), "nonlinear-or-rewritten-history-exact-pin-only"),
            ("extra-parent", lambda r: r["history"]["commits"][0]["parents"].append(sha(8)), "nonlinear-or-rewritten-history-exact-pin-only"),
            ("no-pr", lambda r: r["transitions"][0].update(pr=None), "missing-pr-provenance-exact-pin-only"),
            ("no-code", lambda r: r["transitions"][0].update(codeReview=None), "missing-codeReview"),
            ("no-disclosure", lambda r: r["transitions"][0].update(disclosureReview=None), "missing-disclosureReview"),
            ("adverse", lambda r: r["transitions"][0]["codeReview"].update(verdict="CHANGES"), "adverse-or-superseded-codeReview"),
            ("superseded", lambda r: r["transitions"][0]["codeReview"].update(superseded=True), "adverse-or-superseded-codeReview"),
            ("shared-bot", lambda r: r["transitions"][0]["codeReview"].update(agentId=AUTHOR), "nonindependent-codeReview"),
            ("wrong-head-review", lambda r: r["transitions"][0]["disclosureReview"].update(headSha=sha(8)), "wrong-tuple-disclosureReview"),
            ("private-candidate-pass", lambda r: r["transitions"][0]["disclosureReview"].update(headSha=sha(8)), "wrong-tuple-disclosureReview"),
            ("public-pass-held", lambda r: r["transitions"][0]["holds"].append(LINK), "publication-hold"),
            ("wrong-head-repo", lambda r: r["transitions"][0]["pr"].update(headRepo="elsewhere/synthetic-project"), "wrong-repo-or-pr-target"),
            ("upstream-base", lambda r: r["transitions"][0]["pr"].update(baseRepo="fixture-vendor/synthetic-project"), "wrong-repo-or-pr-target"),
            ("cut-target", lambda r: r["transitions"][0]["pr"].update(baseRef="refs/heads/cut/build"), "wrong-repo-or-pr-target"),
            ("wrong-ref", lambda r: r["transitions"][0].update(destinationRef="refs/heads/maintenance/other"), "wrong-destination-ref"),
            ("wrong-merge", lambda r: r["transitions"][0].update(mergeSha=sha(8)), "merge-object-binding"),
            ("wrong-base-without-carry", lambda r: r["transitions"][0]["pr"].update(baseSha=sha(8)), "missing-integrationReview"),
            ("no-message-scope", lambda r: r["transitions"][0]["authorScan"]["publications"].pop(), "incomplete-added-lines-or-message-scan"),
            ("wrong-digest", lambda r: r["transitions"][0]["authorScan"]["publications"][0].update(messageDigest="c" * 64), "incomplete-added-lines-or-message-scan"),
            ("unknown-weakness", lambda r: r["transitions"][0]["weakness"].update(applicable="unknown"), "unknown-weakness-applicability"),
            ("missing-notification", lambda r: r["transitions"][0]["weakness"].update(applicable="yes"), "missing-or-unbound-private-alternative"),
            ("future-scan", lambda r: r["transitions"][0]["authorScan"].update(observedAt=FUTURE), "future-scan"),
        ]
        for name, mutate, code in mutations:
            with self.subTest(name=name):
                r, pin = fixture()
                self.assertEqual(assess(r, pin)["status"], "consistent-snapshot")
                mutate(r)
                out = assess(r, pin)
                self.assertEqual(out["status"], "finding")
                self.assertIn(code, out["codes"])
                self.assertIs(out["acceptanceEnabled"], False)

    def test_every_review_rejects_adverse_superseded_self_and_wrong_tuples(self):
        for key in ("codeReview", "disclosureReview", "integrationReview"):
            for field, value, code in (("verdict", "CHANGES", "adverse-or-superseded-"),
                                       ("verdict", "DEFER", "adverse-or-superseded-"),
                                       ("verdict", "MISSING", "adverse-or-superseded-"),
                                       ("superseded", True, "adverse-or-superseded-"),
                                       ("agentId", AUTHOR, "nonindependent-"),
                                       ("headSha", sha(9), "wrong-tuple-"),
                                       ("baseSha", sha(9), "wrong-tuple-"),
                                       ("mergeSha", sha(9), "wrong-tuple-")):
                with self.subTest(review=key, field=field, value=value):
                    r, pin = fixture()
                    r["transitions"][0]["integrationReview"] = review(sha(2), sha(1), sha(3))
                    self.assertEqual(assess(r, pin)["status"], "consistent-snapshot")
                    r["transitions"][0][key][field] = value
                    out = assess(r, pin)
                    self.assertEqual(out["status"], "finding")
                    self.assertIn(code + key, out["codes"])
                    self.assertIs(out["acceptanceEnabled"], False)

    def test_recorded_base_may_differ_with_explicit_integration(self):
        r, pin = fixture()
        t = r["transitions"][0]
        t["pr"]["baseSha"] = sha(8)
        for key in ("codeReview", "disclosureReview"):
            t[key]["baseSha"] = sha(8)
        self.assertIn("missing-integrationReview", assess(r, pin)["codes"])
        t["integrationReview"] = review(sha(2), sha(8), sha(3))
        self.assertEqual(assess(r, pin)["status"], "consistent-snapshot")

    def test_pr_head_and_renamed_alias(self):
        r, pin = fixture()
        ref = "refs/heads/fix/synthetic"
        r["ref"] = ref
        r["tipSha"] = r["history"]["tipSha"] = sha(2)
        r["history"]["commits"][0]["sha"] = sha(2)
        t = transition(sha(1), sha(2), sha(2))
        t.update(kind="pr-head", destinationRef=ref)
        t["pr"]["mergedAt"] = "unknown"
        r["transitions"] = [t]
        self.assertEqual(assess(r, pin)["status"], "consistent-snapshot")
        t["pr"]["headRef"] = "refs/heads/fix/old-name"
        self.assertIn("renamed-or-unbound-pr-head", assess(r, pin)["codes"])

    def test_out_of_class(self):
        for repo, ref in (("fixture-owner/another-project", "refs/heads/master"),
                          (REPOSITORY, "refs/heads/cut/build")):
            r, pin = fixture()
            r.update(repository=repo, ref=ref)
            self.assertEqual(assess(r, pin)["codes"], ["out-of-class-exact-pin-only"])

    def test_private_notification_and_private_build_controls(self):
        r, pin = fixture()
        w = r["transitions"][0]["weakness"]
        w.update(applicable="yes", alternative={"kind": "private-notification", "candidateSha": sha(2),
                 "sourceVisibility": "private", "observedAt": BEFORE, "record": LINK, "verified": True,
                 "recipient": LINK, "channel": "private-security-contact", "deliveryRecord": LINK})
        self.assertEqual(assess(r, pin)["status"], "consistent-snapshot")
        for field, value in (("verified", False), ("sourceVisibility", "public"), ("candidateSha", sha(9))):
            bad = deepcopy(r)
            bad["transitions"][0]["weakness"]["alternative"][field] = value
            self.assertIn("missing-or-unbound-private-alternative", assess(bad, pin)["codes"])
        w["alternative"] = {"kind": "private-build", "candidateSha": sha(2), "sourceVisibility": "private",
                            "observedAt": BEFORE, "record": LINK, "verified": True,
                            "sourceRepo": "fixture-private/synthetic-project", "sourceSha": sha(2)}
        self.assertEqual(assess(r, pin)["status"], "consistent-snapshot")
        for field, value in (("sourceSha", sha(9)), ("sourceRepo", REPOSITORY)):
            bad = deepcopy(r)
            bad["transitions"][0]["weakness"]["alternative"][field] = value
            self.assertIn("private-build-not-exact-private-source", assess(bad, pin)["codes"])
        # An alternative must not clear an independent transition HOLD.
        r["transitions"][0]["holds"].append(LINK)
        self.assertIn("publication-hold", assess(r, pin)["codes"])

    def test_cannot_evaluate_incomplete_unavailable_stale(self):
        for mutate in (lambda r: r["history"].update(state="unavailable"),
                       lambda r: r["history"].update(state="truncated"),
                       lambda r: r["history"]["commits"].clear(),
                       lambda r: r.update(capturedAt="1999-12-30T12:00:00Z"),
                       lambda r: r.update(capturedAt=FUTURE)):
            r, pin = fixture()
            mutate(r)
            self.assertEqual(assess(r, pin)["status"], "cannot-evaluate")

    def test_history_scan_and_timing_bindings(self):
        mutations = [
            (lambda r: r["history"].update(checkpointSha=sha(9)), "history-bound-to-other-range"),
            (lambda r: r["history"].update(tipSha=sha(9)), "history-bound-to-other-range"),
            (lambda r: r["transitions"][0]["authorScan"].update(agentId=REVIEWER), "unbound-author-scan"),
            (lambda r: r["transitions"][0]["disclosureReview"].update(observedAt="2000-01-02T09:00:00Z"), "invalid-review-time"),
            (lambda r: r["transitions"][0]["codeReview"].update(observedAt=FUTURE), "invalid-review-time"),
            (lambda r: r["transitions"][0]["weakness"].update(agentId=AUTHOR), "unbound-applicability-decision"),
            (lambda r: r["transitions"][0]["weakness"].update(observedAt=FUTURE), "unbound-applicability-decision"),
            (lambda r: r["transitions"][0]["pr"].update(mergedAt="unknown"), "unverified-merge-time"),
            (lambda r: r["transitions"][0]["publications"][0].update(firstPublicAt=FUTURE), "future-publication-time"),
            (lambda r: r["transitions"][0]["pr"].update(baseRef="refs/heads/release/other"), "wrong-release-integration"),
        ]
        for mutate, code in mutations:
            with self.subTest(code=code):
                r, pin = fixture()
                self.assertEqual(assess(r, pin)["status"], "consistent-snapshot")
                mutate(r)
                out = assess(r, pin)
                self.assertEqual(out["status"], "finding")
                self.assertIn(code, out["codes"])
        r, pin = fixture()
        self.assertIn("unaccepted-or-moved-checkpoint", assess(r, None)["codes"])
        for field, value in (("timingClass", "DECLARED"), ("card", "ISSUE-2")):
            bad_pin = {**pin, field: value}
            self.assertIn("unaccepted-or-moved-checkpoint", assess(r, bad_pin)["codes"])

    def test_synthetic_release_ranges_stay_negative(self):
        # Invented six-transition/two-transition topology, NOT real release tuples.
        data = json.loads((ROOT.parent / RANGE_FIXTURE).read_text())
        self.assertEqual(data["fixtureKind"], "synthetic-offline-not-approval")
        for captured in data["ranges"]:
            with self.subTest(ref=captured["ref"]):
                r, pin = fixture()
                r["ref"] = captured["ref"]
                r["checkpoint"]["sha"] = pin["sha"] = captured["checkpoint"]
                r["history"]["checkpointSha"] = captured["checkpoint"]
                r["transitions"] = []
                r["history"]["commits"] = []
                parent = captured["checkpoint"]
                for row in captured["transitions"]:
                    t = transition(parent, row["merge"], row["head"], captured["ref"], row["pr"])
                    t["pr"]["baseSha"] = row["base"]
                    if row["base"] != parent:
                        for key in ("codeReview", "disclosureReview"):
                            t[key]["baseSha"] = row["base"]
                        t["integrationReview"] = review(row["head"], row["base"], row["merge"])
                    if row.get("findingSurface"):
                        t["findings"] = [{"sha": row["merge"], "surface": row["findingSurface"], "code": "operational-disclosure"}]
                    r["transitions"].append(t)
                    r["history"]["commits"].append({"sha": row["merge"], "parents": [parent]})
                    parent = row["merge"]
                r["tipSha"] = r["history"]["tipSha"] = parent
                out = assess(r, pin)
                self.assertEqual(out["status"], "finding")
                self.assertIn("range-disclosure-finding", out["codes"])
                self.assertIs(out["acceptanceEnabled"], False)
                for t in r["transitions"]:
                    t["findings"] = []
                self.assertEqual(assess(r, pin)["status"], "consistent-snapshot")


class Boundary(unittest.TestCase):
    def test_parser_rejects_malformed_unknown_duplicate_and_oversized(self):
        r, _ = fixture()
        data = {"version": 1, "records": [r]}
        bad = deepcopy(data)
        bad["records"][0]["transitions"][0]["codeReview"]["agentId"] = "synthetic-shared[bot]"
        cases = ["{", '{"version":1,"version":1,"records":[]}', json.dumps(bad),
                 json.dumps({**data, "execute": "do not execute this"}),
                 json.dumps({**data, "policy": POLICY_DATA}),
                 json.dumps({"version": 1, "records": [r, r]}), " " * (gate.MAX_BYTES + 1)]
        with tempfile.TemporaryDirectory(prefix="provenance-test-") as d:
            path = Path(d) / "evidence.json"
            path.write_text(json.dumps(data))
            self.assertEqual(len(gate.load(path, POLICY)), 1)
            for raw in cases:
                with self.subTest(size=len(raw)):
                    path.write_text(raw)
                    with self.assertRaises(gate.CannotEvaluate):
                        gate.load(path, POLICY)
            with self.assertRaises(gate.CannotEvaluate):
                gate.load(Path(d) / "missing.json", POLICY)

    def test_nonregular_input_is_refused_without_waiting(self):
        with tempfile.TemporaryDirectory(prefix="provenance-fifo-") as d:
            path = Path(d) / "pipe"
            os.mkfifo(path)
            with self.assertRaisesRegex(gate.CannotEvaluate, "nonregular-evidence"):
                gate.load(path, POLICY)
            with self.assertRaises(gate.CannotEvaluate):
                gate.load(d, POLICY)

    def test_pin_precedence(self):
        raw = (f"POSTHOC|synthetic-project|refs/heads/master|{sha(1)}|ISSUE-1|unknown|{BEFORE}|synthetic\n"
               f"DECLARED|synthetic-project|refs/heads/master|{sha(2)}|ISSUE-2|{BEFORE}|synthetic\n")
        pin = gate.read_pin(raw, REPOSITORY, "refs/heads/master")
        self.assertEqual(pin["timingClass"], "POSTHOC")
        self.assertEqual(pin["sha"], sha(1))
        self.assertIsNone(gate.read_pin(raw, REPOSITORY, "refs/heads/other"))
        self.assertIsNone(gate.read_pin(raw, "fixture-owner/project", "refs/heads/master"))

    def test_policy_is_explicit_bounded_and_separate_from_evidence(self):
        r, pin = fixture()
        with self.assertRaisesRegex(gate.CannotEvaluate, "missing-provenance-policy"):
            gate.evaluate([r], REPOSITORY, r["ref"], r["tipSha"], pin, NOW, None)
        with self.assertRaisesRegex(gate.CannotEvaluate, "missing-provenance-policy"):
            gate.load_policy(None)
        bad_policies = [
            {**POLICY_DATA, "version": True}, {**POLICY_DATA, "extra": "ignored?"},
            {**POLICY_DATA, "repository": ""}, {**POLICY_DATA, "recordNamespace": ".*"},
            {**POLICY_DATA, "cardPrefix": "ISSUE|anything"},
            {**POLICY_DATA, "releaseRefs": [], "releasePrefixes": []},
            {**POLICY_DATA, "releasePrefixes": ["refs/heads/"]},
            {**POLICY_DATA, "releaseRefs": ["refs/heads/cut/build"]},
            {**POLICY_DATA, "releasePrefixes": ["refs/heads/release"]},
            {**POLICY_DATA, "releaseRefs": ["refs/heads/master"] * 2},
            {**POLICY_DATA, "releaseRefs": ["refs/heads/master"] * 17},
        ]
        for data in bad_policies:
            with self.subTest(data=data):
                with self.assertRaises(gate.CannotEvaluate):
                    gate.parse_policy(data)
        other = gate.parse_policy({**POLICY_DATA, "repository": "fixture-owner/other"})
        self.assertEqual(assess(r, pin, other)["codes"], ["out-of-class-exact-pin-only"])
        r["checkpoint"]["record"] = "/elsewhere/issues/ISSUE-1"
        with self.assertRaises(gate.CannotEvaluate):
            gate.validate_record(r, POLICY)
        with tempfile.TemporaryDirectory(prefix="provenance-policy-") as d:
            path = Path(d) / "policy.json"
            for raw in ("{", '{"version":1,"version":1}', " " * (gate.MAX_BYTES + 1)):
                path.write_text(raw)
                with self.assertRaises(gate.CannotEvaluate):
                    gate.load_policy(path)
            os.mkfifo(Path(d) / "pipe")
            with self.assertRaisesRegex(gate.CannotEvaluate, "nonregular-evidence"):
                gate.load_policy(Path(d) / "pipe")

    def test_evidence_limits_and_strict_nested_shapes(self):
        mutations = [
            lambda r: r["checkpoint"].update(execute="never"),
            lambda r: r["checkpoint"].update(sha="abbreviated"),
            lambda r: r["checkpoint"].update(agentId="synthetic-login"),
            lambda r: r["checkpoint"].update(decisionAt="not-time"),
            lambda r: r["history"]["commits"][0].update(parents=[sha(1)] * 9),
            lambda r: r["history"].update(commits=[r["history"]["commits"][0]] * (gate.MAX_TRANSITIONS + 1)),
            lambda r: r.update(transitions=r["transitions"] * (gate.MAX_TRANSITIONS + 1)),
            lambda r: r["transitions"][0]["publications"][0].update(messageDigest="abbreviated"),
            lambda r: r["transitions"][0].update(holds=[LINK] * 33),
            lambda r: r["transitions"][0]["codeReview"].update(superseded="false"),
            lambda r: r["transitions"][0]["pr"].update(number=True),
            lambda r: r["transitions"][0]["weakness"].update(alternative={"kind": "public-notification"}),
        ]
        for mutate in mutations:
            r, _ = fixture()
            mutate(r)
            with self.assertRaises(gate.CannotEvaluate):
                gate.validate_record(r, POLICY)
        r, _ = fixture()
        r["transitions"][0]["publications"] *= gate.MAX_PUBLICATIONS // 2
        r["transitions"].append(deepcopy(r["transitions"][0]))
        with self.assertRaisesRegex(gate.CannotEvaluate, "oversized-evidence"):
            gate.validate_record(r, POLICY)
        with tempfile.TemporaryDirectory(prefix="provenance-limit-") as d:
            path = Path(d) / "evidence.json"
            for version, records in ((True, []), (2, []), (1, [fixture()[0]] * (gate.MAX_RECORDS + 1))):
                path.write_text(json.dumps({"version": version, "records": records}))
                with self.assertRaises(gate.CannotEvaluate):
                    gate.load(path, POLICY)

    def test_cli_exit_codes_and_explicit_synthetic_pin(self):
        # This pin is invented test input, not an operational approval anchor.
        r, _ = fixture()
        r["capturedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        with tempfile.TemporaryDirectory(prefix="provenance-cli-") as d:
            path = Path(d) / "evidence.json"
            command = ["/bin/bash", str(ROOT / "public-fork-disclosure-audit.sh"),
                       "--provenance-diagnostics", str(path), "synthetic-project", r["ref"], r["tipSha"]]
            env = shell_inputs(d, r)
            path.write_text(json.dumps({"version": 1, "records": [r]}))
            out = subprocess.run(command, env=env, capture_output=True, text=True, timeout=30)
            self.assertEqual(out.returncode, 0, out.stderr)
            self.assertIs(json.loads(out.stdout)["acceptanceEnabled"], False)
            r["transitions"][0]["codeReview"]["verdict"] = "CHANGES"
            path.write_text(json.dumps({"version": 1, "records": [r]}))
            self.assertEqual(subprocess.run(command, env=env, capture_output=True, timeout=30).returncode, 1)
            path.write_text("{")
            self.assertEqual(subprocess.run(command, env=env, capture_output=True, timeout=30).returncode, 2)

    def test_shell_diagnostics_refuse_missing_policy_and_missing_pin(self):
        r, _ = fixture()
        r["capturedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        with tempfile.TemporaryDirectory(prefix="provenance-no-policy-") as d:
            path = Path(d) / "evidence.json"
            path.write_text(json.dumps({"version": 1, "records": [r]}))
            command = ["/bin/bash", str(ROOT / "public-fork-disclosure-audit.sh"),
                       "--provenance-diagnostics", str(path), "synthetic-project", r["ref"], r["tipSha"]]
            env = shell_inputs(d, r)
            config_path = Path(env["DISCLOSURE_AUDIT_CONFIG_FILE"])
            config = json.loads(config_path.read_text())
            config["provenancePolicyFile"] = None
            config_path.write_text(json.dumps(config))
            out = subprocess.run(command, env=env, capture_output=True, text=True, timeout=30)
            self.assertEqual(out.returncode, 2, out.stderr)
            self.assertEqual(json.loads(out.stdout)["codes"], ["missing-provenance-policy"])
            self.assertIs(json.loads(out.stdout)["acceptanceEnabled"], False)
            env = shell_inputs(d, r)
            config = json.loads(config_path.read_text())
            Path(config["posthocFile"]).write_text("")
            out = subprocess.run(command, env=env, capture_output=True, text=True, timeout=30)
            self.assertEqual(out.returncode, 1, out.stderr)
            self.assertEqual(json.loads(out.stdout)["codes"], ["unaccepted-or-moved-checkpoint"])
            config["provenancePolicyFile"] = str(Path(d) / "missing-policy.json")
            config_path.write_text(json.dumps(config))
            self.assertEqual(subprocess.run(command, env=env, capture_output=True, timeout=30).returncode, 2)

    def test_trusted_shell_config_refuses_before_git_or_network(self):
        r, _ = fixture()
        with tempfile.TemporaryDirectory(prefix="provenance-config-refusal-") as d:
            directory = Path(d)
            env = shell_inputs(d, r)
            config_path = Path(env["DISCLOSURE_AUDIT_CONFIG_FILE"])
            valid = json.loads(config_path.read_text())
            marker = directory / "unexpected-transport.log"
            marker.write_text("")
            for executable in ("git", "curl"):
                path = directory / executable
                path.write_text('#!/bin/sh\nprintf "transport invoked\\n" >> "$FIXTURE_UNEXPECTED"\nexit 99\n')
                path.chmod(0o755)
            env.update(PATH=d + ":/usr/bin:/bin", FIXTURE_UNEXPECTED=str(marker))
            command = ["/bin/bash", str(ROOT / "public-fork-disclosure-audit.sh")]
            missing = {k: v for k, v in env.items() if k != "DISCLOSURE_AUDIT_CONFIG_FILE"}
            # Evidence and old environment fields are not a substitute for config.
            evidence = directory / "evidence.json"
            evidence.write_text(json.dumps({"version": 1, "records": [r], "configuration": valid}))
            missing.update(DISCLOSURE_AUDIT_ORG="fixture-owner", DISCLOSURE_AUDIT_AUTHOR_RE=".*",
                           DISCLOSURE_AUDIT_PRIVATE_PROBE="fixture-private/probe",
                           DISCLOSURE_AUDIT_PROVENANCE_EVIDENCE=str(evidence))
            for args in ([], ["--provenance-diagnostics", str(evidence), "synthetic-project", r["ref"], r["tipSha"]]):
                out = subprocess.run(command + args, env=missing, capture_output=True, text=True, timeout=30)
                self.assertEqual(out.returncode, 2, out.stderr + out.stdout)
                self.assertNotIn("PASS", out.stdout)
            bad = [
                {**valid, "version": True}, {**valid, "execute": "never"},
                {**valid, "organization": ""}, {**valid, "authorDomains": [], "botLogins": []},
                {**valid, "authorDomains": [".*"]},
                {**valid, "authorDomains": ["users.noreply.github.com"]},
                {**valid, "botLogins": [".*"]}, {**valid, "trackerPrefixes": []},
                {**valid, "trackerPrefixes": ["ISSUE|anything"]}, {**valid, "privateProbe": None},
                {**valid, "declaredFile": None}, {**valid, "posthocFile": str(directory / "missing")},
                {**valid, "declaredFile": str(directory)},
                {**valid, "parentCacheFile": "relative-path"},
                {k: v for k, v in valid.items() if k != "privateProbe"},
            ]
            raw_cases = [json.dumps(c) for c in bad] + ["{", '{"version":1,"version":1}', " " * (gate.MAX_BYTES + 1)]
            for raw in raw_cases:
                with self.subTest(size=len(raw)):
                    config_path.write_text(raw)
                    out = subprocess.run(command, env=env, capture_output=True, text=True, timeout=30)
                    self.assertEqual(out.returncode, 2, out.stderr + out.stdout)
                    self.assertNotIn("PASS", out.stdout)
            config_path.unlink()
            os.mkfifo(config_path)
            out = subprocess.run(command, env=env, capture_output=True, text=True, timeout=30)
            self.assertEqual(out.returncode, 2, out.stderr + out.stdout)
            self.assertEqual(marker.read_text(), "")

    def test_live_audit_never_accepts_a_consistent_snapshot(self):
        # Run the production path ONLY through synthetic local git/curl fakes.
        r, _ = fixture()
        r["capturedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        with tempfile.TemporaryDirectory(prefix="provenance-audit-stub-") as d:
            directory = Path(d)
            evidence = directory / "evidence.json"
            evidence.write_text(json.dumps({"version": 1, "records": [r]}))
            curl = directory / "curl"
            curl.write_text('''#!/bin/sh
for arg do url="$arg"; done
if [ "$url" != 'https://api.github.com/orgs/fixture-owner/repos?per_page=100&type=public' ]; then
  printf 'unexpected curl call\n' >> "$FIXTURE_UNEXPECTED"
  exit 99
fi
printf '%s\n' '[{"name":"synthetic-project","fork":true,"visibility":"public","parent":{"full_name":"fixture-vendor/synthetic-project"}}]'
''')
            git = directory / "git"
            git.write_text('''#!/bin/sh
case "$*" in
  *fixture-private/probe.git*) exit 128;;
  *ls-remote*fixture-owner/synthetic-project.git*) printf '%s\t%s\n' "$FIXTURE_TIP" "$FIXTURE_REF";;
  *ls-remote*fixture-vendor/synthetic-project.git*) printf '%s\t%s\n' 'ffffffffffffffffffffffffffffffffffffffff' 'refs/heads/master';;
  *log*%ae*) printf '%s\n' "$FIXTURE_AUTHOR";;
  *log*%s*) printf '%s\n' 'synthetic offline subject';;
  *init*|*fetch*) exit 0;;
  *) printf 'unexpected git call\n' >> "$FIXTURE_UNEXPECTED"; exit 99;;
esac
''')
            curl.chmod(0o755)
            git.chmod(0o755)
            unexpected = directory / "unexpected.log"
            unexpected.write_text("")
            env = shell_inputs(d, r)
            forged_pins = directory / "untrusted-pins.txt"
            forged_pins.write_text(f"synthetic-project|{r['ref']}|{r['tipSha']}|ISSUE-9|unknown|{BEFORE}|not operator configuration\n")
            env.update(PATH=d + ":/usr/bin:/bin",
                       # Legacy ambient overrides cannot replace trusted local authority.
                       DISCLOSURE_AUDIT_ORG="untrusted-org",
                       DISCLOSURE_AUDIT_AUTHOR_RE=".*",
                       DISCLOSURE_AUDIT_CARD_REF_RE="never-match",
                       DISCLOSURE_AUDIT_PRIVATE_PROBE="untrusted/probe",
                       DISCLOSURE_AUDIT_POSTHOC_FILE=str(forged_pins),
                       DISCLOSURE_AUDIT_PROVENANCE_POLICY=str(directory / "untrusted-policy.json"),
                       DISCLOSURE_AUDIT_STRICT_UNRESOLVED="0",
                       DISCLOSURE_AUDIT_PROVENANCE_EVIDENCE=str(evidence),
                       FIXTURE_TIP=r["tipSha"], FIXTURE_REF=r["ref"],
                       FIXTURE_AUTHOR="synthetic-author@fixture.invalid",
                       FIXTURE_UNEXPECTED=str(unexpected))
            command = ["/bin/bash", str(ROOT / "public-fork-disclosure-audit.sh")]
            out = subprocess.run(command, env=env, capture_output=True, text=True, timeout=30)
            self.assertEqual(out.returncode, 1, out.stderr + out.stdout)
            self.assertIn('"status": "consistent-snapshot"', out.stdout)
            self.assertIn('"acceptanceEnabled": false', out.stdout)
            self.assertIn("0 declared/clean, 0 post-hoc adjudicated, 1 undeclared publication(s), 0 unresolved", out.stdout)
            evidence.write_text("{")
            out = subprocess.run(command, env=env, capture_output=True, text=True, timeout=30)
            self.assertEqual(out.returncode, 2, out.stderr + out.stdout)
            self.assertIn("1 undeclared publication(s)", out.stdout)
            # Unresolved authorship must short-circuit BEFORE any evidence lookup.
            env.update(FIXTURE_REF="refs/heads/fixture-999-synthetic", FIXTURE_AUTHOR="external@external-fixture.invalid")
            out = subprocess.run(command, env=env, capture_output=True, text=True, timeout=30)
            self.assertEqual(out.returncode, 1, out.stderr + out.stdout)
            self.assertIn("0 undeclared publication(s), 1 unresolved", out.stdout)
            self.assertNotIn('"mode": "diagnostic-only"', out.stdout)
            # A plain unknown ref is not automatically trusted as upstream either.
            env.update(FIXTURE_REF="refs/heads/unclassified-synthetic")
            out = subprocess.run(command, env=env, capture_output=True, text=True, timeout=30)
            self.assertEqual(out.returncode, 1, out.stderr + out.stdout)
            self.assertIn("0 undeclared publication(s), 1 unresolved", out.stdout)
            self.assertNotIn('"mode": "diagnostic-only"', out.stdout)
            self.assertEqual(unexpected.read_text(), "")

    def test_assertion_killed_mutants(self):
        mutations = [
            ('if t["findings"]:', 'if False:', "Consistency.test_synthetic_release_ranges_stay_negative"),
            ('if t["holds"]:', 'if False:', "Consistency.test_fail_closed_negative_controls"),
            ('if v["agentId"] == p["authorAgentId"]:', 'if False:', "Consistency.test_fail_closed_negative_controls"),
            ('if v["verdict"] != "APPROVE" or v["superseded"]:', 'if False:', "Consistency.test_fail_closed_negative_controls"),
            ('timing = "POSTHOC"', 'timing = "DECLARED"', "Consistency.test_unknown_or_postpush_never_declared"),
            ('codes, timing, previous = [], c["timingClass"], c["sha"]',
             'codes, timing, previous = [], "DECLARED", c["sha"]', "Consistency.test_reviewed_successor_preserves_posthoc"),
            ('"acceptanceEnabled": False', '"acceptanceEnabled": True', "Consistency.test_reviewed_successor_preserves_posthoc"),
        ]
        source = (ROOT / "public_fork_provenance.py").read_text()
        with tempfile.TemporaryDirectory(prefix="provenance-mutants-") as d:
            directory = Path(d)
            verification = directory / "verification"
            verification.mkdir()
            fixture_dir = directory / RANGE_FIXTURE.parent
            fixture_dir.mkdir(parents=True)
            shutil.copy(ROOT.parent / RANGE_FIXTURE, fixture_dir)
            shutil.copy(Path(__file__), verification)
            module = verification / "public_fork_provenance.py"
            for anchor, replacement, target in mutations:
                with self.subTest(anchor=anchor):
                    self.assertEqual(source.count(anchor), 1)
                    module.write_text(source)
                    command = [sys.executable, "-B", "-m", "unittest", "test_public_fork_provenance." + target]
                    clean = subprocess.run(command, cwd=verification, env=offline_env(directory), capture_output=True, text=True, timeout=30)
                    self.assertEqual(clean.returncode, 0, clean.stderr)
                    module.write_text(source.replace(anchor, replacement))
                    killed = subprocess.run(command, cwd=verification, env=offline_env(directory), capture_output=True, text=True, timeout=30)
                    self.assertNotEqual(killed.returncode, 0)
                    self.assertIn("FAIL:", killed.stderr)
                    self.assertNotIn("ERROR:", killed.stderr)
                    self.assertIn("AssertionError", killed.stderr)


if __name__ == "__main__":
    unittest.main()
