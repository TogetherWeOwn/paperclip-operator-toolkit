#!/usr/bin/env python3
"""Tests for the deploy-window manifest gate.

Every case builds a REAL git fixture tree and real staged scripts, then points
the gate's module-level STAGING/MANIFEST/SUPERSEDED_BY at them. Nothing here
mocks git: the gate's whole job is to reproduce assertions that operator
scripts make with git, and a mocked git would let the gate and the scripts
disagree exactly where it matters.

The shared staging tree is never touched. Fixtures are built from scratch in a
temp dir.

  python3 -m unittest -v test_deploy_window_manifest.py
"""

from __future__ import annotations

import importlib.util
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load_gate():
    """Import deploy_window_manifest.py from beside this file, by path.

    Loaded per-test-class so a test that repoints STAGING cannot leak that
    into another test.
    """
    spec = importlib.util.spec_from_file_location(
        "deploy_window_manifest", HERE / "deploy_window_manifest.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def git(tree: Path, *args: str, input_text: str | None = None) -> str:
    done = subprocess.run(
        ["git", "-C", str(tree), *args],
        capture_output=True, text=True, check=True, input=input_text,
    )
    return done.stdout.strip()


OPERATOR_TEMPLATE = """#!/usr/bin/env bash
set -euo pipefail
staging={staging}
expected_head={head}

step=verify-staging-tree
test "$(git -C "$staging" rev-parse HEAD)" = "$expected_head"
"""


class GateFixture(unittest.TestCase):
    """A staging dir with a real git tree and real pinned operator scripts."""

    def setUp(self) -> None:
        self.gate = load_gate()
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)

        self.staging = self.root / "staging"
        self.staging.mkdir()
        self.tree = self.staging / "tree"
        self.tree.mkdir()

        git(self.tree, "init", "-q")
        git(self.tree, "config", "user.email", "t@t.t")
        git(self.tree, "config", "user.name", "t")

        (self.tree / "f").write_text("payload\n")
        git(self.tree, "add", "-A")
        git(self.tree, "commit", "-qm", "payload commit")
        self.payload = git(self.tree, "rev-parse", "HEAD")

        (self.tree / "f").write_text("pin\n")
        git(self.tree, "commit", "-qam", "green pin")
        self.pin = git(self.tree, "rev-parse", "HEAD")

        # A feature branch descending from the pin -- the shape that actually
        # caused every measured red on the real tree.
        git(self.tree, "checkout", "-q", "-b", "feature")
        (self.tree / "f").write_text("feature\n")
        git(self.tree, "commit", "-qam", "feat: model catalogue picker")
        self.feature = git(self.tree, "rev-parse", "HEAD")
        git(self.tree, "checkout", "-q", self.pin)

        self.gate.STAGING = self.staging
        # The real BUILT table names a revision in the real source repo. These
        # cases are about staged scripts, so empty it -- otherwise every
        # single_card() assertion would also see the live TOG-586 row.
        self.gate.BUILT = {}
        # Same for ANCHORS (TOG-997): the live table names a ref in the real
        # governor tree, which STAGING no longer points at, so leaving it
        # populated would add an ANCHOR_TREE_UNREADABLE row to every fixture
        # and turn row()'s single-row assertion into a failure. Anchors are
        # tested directly in TestDeployLineAnchor.
        self.gate.ANCHORS = {}
        # Same isolation for the real WITHDRAWN table. These fixtures name
        # TOG-916 as a superseding runner, and in the live table TOG-916 is
        # withdrawn -- which would (correctly) trip withdrawal_invariant() and
        # turn every superseded fixture into exit 2. The invariant is tested
        # directly in TestOwnerWithdrawal instead, against a fixture that
        # actually models it.
        self.gate.WITHDRAWN = {}

    def stage_script(self, name: str, head: str | None) -> str:
        """Write an operator script pinning `head`; return its sha256."""
        body = (
            OPERATOR_TEMPLATE.format(staging=self.tree, head=head)
            if head is not None
            else "#!/usr/bin/env bash\nset -euo pipefail\necho no tree pin\n"
        )
        path = self.staging / name
        path.write_text(body)
        path.chmod(0o755)
        return self.gate.sha256_file(path)

    # Distinct from None, which means "stage a script that pins no tree".
    DEFAULT_PIN = object()

    def single_card(self, name: str = "OP.sh", head=DEFAULT_PIN,
                    superseded: tuple[str, str] | None = None) -> None:
        head = self.pin if head is self.DEFAULT_PIN else head
        digest = self.stage_script(name, head)
        self.gate.MANIFEST = {"TOG-TEST": (name, digest)}
        self.gate.SUPERSEDED_BY = (
            {"TOG-TEST": superseded} if superseded else {}
        )

    def row(self) -> dict:
        code, rows = self.gate.evaluate()
        self.assertEqual(len(rows), 1)
        return {"code": code, **rows[0]}


class TestStrayCheckoutVersusRecut(GateFixture):
    """The TOG-998 defect: re-cut advice given for a stray checkout."""

    def test_stray_checkout_of_a_descendant_is_not_a_recut(self) -> None:
        """The exact measured shape: HEAD moved to a DESCENDANT feature commit.

        7/7 real reds looked like this. A descendancy-based rule calls this
        "deploy line advanced, re-cut" -- which pins the script to a feature
        branch. The pin is still reachable, so the repair is a checkout.
        """
        self.single_card(head=self.pin)
        git(self.tree, "checkout", "-q", self.feature)
        row = self.row()
        self.assertEqual(row["state"], "TREE_STRAY_CHECKOUT")
        self.assertEqual(row["code"], 1)
        # Descendancy is TRUE here and must NOT have driven the verdict.
        self.assertIs(row["live_is_descendant_of_pin"], True)

    def test_stray_checkout_of_a_divergent_commit(self) -> None:
        """A divergent stray is the same repair: the pin is still there."""
        git(self.tree, "checkout", "-q", "-b", "other", self.payload)
        (self.tree / "f").write_text("divergent\n")
        git(self.tree, "commit", "-qam", "divergent work")
        divergent = git(self.tree, "rev-parse", "HEAD")
        self.single_card(head=self.pin)
        git(self.tree, "checkout", "-q", divergent)
        row = self.row()
        self.assertEqual(row["state"], "TREE_STRAY_CHECKOUT")
        self.assertIs(row["live_is_descendant_of_pin"], False)

    def test_unreachable_pin_is_the_only_recut(self) -> None:
        """A pin that is not an object here cannot be checked out."""
        self.single_card(head="0" * 40)
        row = self.row()
        self.assertEqual(row["state"], "TREE_PIN_GONE")
        self.assertEqual(row["code"], 1)

    def test_a_present_non_commit_object_is_not_a_checkout_target(self) -> None:
        """`cat-file -e <sha>` is true for blobs and trees, which cannot be
        checked out. Only a commit makes "check the pin back out" real advice,
        so presence must be asked about a COMMIT specifically.
        """
        blob = git(self.tree, "hash-object", "-w", "--stdin", input_text="not a commit\n")
        self.single_card(head=blob)
        row = self.row()
        # The object IS present, but it is not checkout-able.
        self.assertEqual(
            git(self.tree, "cat-file", "-t", blob), "blob",
            "fixture must really be a present non-commit object",
        )
        self.assertEqual(row["state"], "TREE_PIN_GONE")

    def test_checking_the_pin_back_out_restores_ready(self) -> None:
        """The advice the gate now prints must actually clear the gate."""
        self.single_card(head=self.pin)
        git(self.tree, "checkout", "-q", self.feature)
        self.assertEqual(self.row()["state"], "TREE_STRAY_CHECKOUT")
        git(self.tree, "checkout", "-q", self.pin)  # the printed repair
        row = self.row()
        self.assertEqual(row["state"], "OK")
        self.assertEqual(row["code"], 0)

    def test_stray_checkout_advice_never_says_recut(self) -> None:
        """Guard the operator-facing words, not just the state name."""
        self.single_card(head=self.pin)
        git(self.tree, "checkout", "-q", self.feature)
        import contextlib, io, sys
        buffer = io.StringIO()
        argv = sys.argv
        sys.argv = ["deploy_window_manifest.py"]  # not unittest's argv
        try:
            with contextlib.redirect_stdout(buffer):
                self.gate.main()
        finally:
            sys.argv = argv
        out = buffer.getvalue()
        self.assertIn("DO NOT RE-CUT", out)
        self.assertIn(f"checkout {self.pin}", out)
        self.assertNotIn("re-cut it", out)


class TestPreservedBehaviour(GateFixture):
    """The TOG-990/992 guarantees must survive this change."""

    def test_matching_pin_is_ok(self) -> None:
        self.single_card(head=self.pin)
        row = self.row()
        self.assertEqual(row["state"], "OK")
        self.assertEqual(row["code"], 0)

    def test_hash_mismatch_beats_any_tree_verdict(self) -> None:
        """A tampered script must never be greened by a tree verdict."""
        self.single_card(head=self.pin)
        self.gate.MANIFEST = {"TOG-TEST": ("OP.sh", "f" * 64)}
        row = self.row()
        self.assertEqual(row["state"], "HASH_MISMATCH")

    def test_tampered_superseded_script_stays_red(self) -> None:
        self.single_card(head=self.payload,
                         superseded=(self.payload, "TOG-916"))
        self.gate.MANIFEST = {"TOG-TEST": ("OP.sh", "f" * 64)}
        self.assertEqual(self.row()["state"], "HASH_MISMATCH")

    def test_superseded_card_carried_by_live_head(self) -> None:
        self.single_card(head=self.payload,
                         superseded=(self.payload, "TOG-916"))
        row = self.row()
        self.assertEqual(row["state"], "SUPERSEDED_OK")
        self.assertEqual(row["code"], 0)

    def test_superseded_payload_lost_is_red(self) -> None:
        self.single_card(head=self.payload,
                         superseded=("0" * 40, "TOG-916"))
        self.assertEqual(self.row()["state"], "PAYLOAD_LOST")

    def test_missing_script_is_red(self) -> None:
        self.single_card(head=self.pin)
        (self.staging / "OP.sh").unlink()
        self.assertEqual(self.row()["state"], "MISSING")

    def test_script_without_a_pin_is_tree_independent(self) -> None:
        self.single_card(name="NOPIN.sh", head=None)
        row = self.row()
        self.assertEqual(row["state"], "OK")
        self.assertIsNone(row["tree_pin"])

    def test_unreadable_tree_degrades_not_crashes(self) -> None:
        self.single_card(head=self.pin)
        shutil.rmtree(self.tree)
        self.assertEqual(self.row()["state"], "TREE_UNREADABLE")


class TestBuiltAtInstallTimeCards(GateFixture):
    """TOG-1002: a card whose artifact is BUILT on the host, not staged.

    TOG-586 has no file under STAGING, so the hash table could never carry it
    and the card sat blocked on a window that structurally excluded it. What is
    verifiable before the build is the revision, so that is what is checked.
    """

    def build_card(self, revision: str, repo=None) -> dict:
        """Enrol exactly one built card and return its row."""
        self.gate.MANIFEST = {}
        self.gate.SUPERSEDED_BY = {}
        self.gate.BUILT = {"TOG-BUILT": (revision, "build.sh")}
        self.gate.SOURCE_REPO = self.tree if repo is None else repo
        code, rows = self.gate.evaluate()
        self.assertEqual(len(rows), 1)
        return {"code": code, **rows[0]}

    def test_a_built_card_is_enrolled_at_all(self) -> None:
        """The TOG-1002 defect itself: the card must APPEAR in the window."""
        row = self.build_card(self.pin)
        self.assertEqual(row["card"], "TOG-BUILT")
        self.assertEqual(row["kind"], "built")
        self.assertEqual(row["state"], "BUILT_PIN_OK")
        self.assertEqual(row["code"], 0)

    def test_a_reachable_pinned_revision_is_green(self) -> None:
        self.assertEqual(self.build_card(self.pin)["state"], "BUILT_PIN_OK")

    def test_an_unreachable_pinned_revision_is_red(self) -> None:
        """The pin cannot be built, so the window must not claim to carry it."""
        row = self.build_card("0" * 40)
        self.assertEqual(row["state"], "BUILT_PIN_GONE")
        self.assertEqual(row["code"], 1)

    def test_a_built_card_can_turn_the_whole_window_red(self) -> None:
        """A green staged set must not mask a broken built pin."""
        digest = self.stage_script("OP.sh", self.pin)
        self.gate.MANIFEST = {"TOG-TEST": ("OP.sh", digest)}
        self.gate.SUPERSEDED_BY = {}
        self.gate.BUILT = {"TOG-BUILT": ("0" * 40, "build.sh")}
        self.gate.SOURCE_REPO = self.tree
        code, rows = self.gate.evaluate()
        self.assertEqual(code, 1)
        self.assertEqual([r["state"] for r in rows], ["OK", "BUILT_PIN_GONE"])

    def test_a_tree_object_that_is_not_a_commit_is_not_buildable(self) -> None:
        """A blob id is 40 hex and present, but you cannot build from it."""
        blob = git(self.tree, "rev-parse", f"{self.pin}:f")
        self.assertEqual(self.build_card(blob)["state"], "BUILT_PIN_GONE")

    def test_an_unreadable_source_repo_degrades_not_crashes(self) -> None:
        shutil.rmtree(self.tree)
        self.assertEqual(self.build_card(self.pin)["state"], "BUILT_UNREADABLE")

    def test_unreadable_is_red_not_silently_green(self) -> None:
        shutil.rmtree(self.tree)
        self.assertEqual(self.build_card(self.pin)["code"], 1)

    def test_the_real_table_pins_the_reviewed_commit_not_ee6a85be(self) -> None:
        """The live pin, not a fixture: two cards named two different commits.

        TOG-979 is `done` and its title says ee6a85be. That commit is not an
        ancestor of main and its preflight demands /usr/bin/runuser, which this
        host does not have. Guard the constant a human could 'helpfully' align
        with the other card's title.
        """
        gate = load_gate()
        revision, builder = gate.BUILT["TOG-586"]
        self.assertEqual(revision, "49374f556395126b24c1d9310c4d8728167ccd55")
        self.assertNotIn("ee6a85be", revision)
        self.assertEqual(builder, "systemd/build-liveness-reconciler-bundle.sh")

    def test_built_output_tells_the_operator_not_to_build_ee6a85be(self) -> None:
        """The warning is the point; a bare revision would not prevent the trap."""
        import contextlib
        import io
        import sys

        self.gate.MANIFEST = {}
        self.gate.SUPERSEDED_BY = {}
        self.gate.BUILT = {"TOG-586": (self.pin, "build.sh")}
        self.gate.SOURCE_REPO = self.tree
        buffer = io.StringIO()
        argv = sys.argv
        sys.argv = ["deploy_window_manifest.py"]
        try:
            with contextlib.redirect_stdout(buffer):
                self.gate.main()
        finally:
            sys.argv = argv
        out = buffer.getvalue()
        self.assertIn("ee6a85be", out)
        self.assertIn("Do NOT build", out)
        self.assertIn(self.pin, out)
        # It must not send the operator hunting for a staged script.
        self.assertIn("do not look for a staged script", out)

    def test_built_rows_do_not_crash_json_mode(self) -> None:
        """A built row has no 'path'/'executable' key; both modes must cope."""
        import contextlib
        import io
        import json as jsonlib
        import sys

        self.gate.MANIFEST = {}
        self.gate.SUPERSEDED_BY = {}
        self.gate.BUILT = {"TOG-BUILT": (self.pin, "build.sh")}
        self.gate.SOURCE_REPO = self.tree
        buffer = io.StringIO()
        argv = sys.argv
        sys.argv = ["deploy_window_manifest.py", "--json"]
        try:
            with contextlib.redirect_stdout(buffer):
                code = self.gate.main()
        finally:
            sys.argv = argv
        self.assertEqual(code, 0)
        payload = jsonlib.loads(buffer.getvalue())
        self.assertEqual(payload["verdict"], "READY")
        self.assertEqual(payload["entries"][0]["revision"], self.pin)


class TestOwnerWithdrawal(GateFixture):
    """Owner ruling 2026-09-05 05:07Z: no fork. Authorisation, not bytes.

    The hazard these cover is specific: a withdrawn card's hash is still
    PERFECT, so nothing in the hash path can notice it. The gate printed
    `[ok] TOG-916 OK` -- read by an operator as RUN THIS -- for a script that
    builds a forked vendor image.
    """

    def test_a_withdrawn_card_is_stopped_despite_a_perfect_hash(self) -> None:
        """The bytes match exactly; only the authorisation changed."""
        self.single_card(head=self.pin)
        self.gate.WITHDRAWN = {"TOG-TEST": ("vendor patch", "re-scope")}
        row = self.row()
        self.assertEqual(row["state"], "WITHDRAWN")
        # It must never be reported as runnable...
        self.assertNotIn(row["state"], ("OK", "SUPERSEDED_OK", "BUILT_PIN_OK"))
        # ...and it must not close the window for the cards that remain.
        self.assertEqual(row["code"], 0)

    def test_withdrawal_beats_a_hash_mismatch_too(self) -> None:
        """Withdrawn is checked FIRST, so it short-circuits even a tamper.

        Both verdicts mean "do not run"; the ruling is the more fundamental
        reason and must not be masked by a byte comparison.
        """
        self.single_card(head=self.pin)
        self.gate.MANIFEST = {"TOG-TEST": ("OP.sh", "f" * 64)}
        self.gate.WITHDRAWN = {"TOG-TEST": ("vendor patch", "re-scope")}
        self.assertEqual(self.row()["state"], "WITHDRAWN")

    def test_a_withdrawn_card_still_stops_when_its_script_is_gone(self) -> None:
        self.single_card(head=self.pin)
        (self.staging / "OP.sh").unlink()
        self.gate.WITHDRAWN = {"TOG-TEST": ("vendor patch", "re-scope")}
        row = self.row()
        self.assertEqual(row["state"], "WITHDRAWN")
        self.assertFalse(row["present"])

    def test_withdrawing_a_runner_but_not_its_superseded_card_is_exit_2(self) -> None:
        """The coupling fault: advice to run a forbidden script.

        Leaving a superseded card enrolled while withdrawing the script that
        carries its payload makes the gate print "superseded by X's script" at
        an operator forbidden to run X. That is a gate that can no longer
        answer its own question -- exit 2, not a green with a footnote.
        """
        self.single_card(head=self.payload,
                         superseded=(self.payload, "TOG-RUNNER"))
        self.gate.WITHDRAWN = {"TOG-RUNNER": ("vendor patch", "re-scope")}
        code, _ = self.gate.evaluate()
        self.assertEqual(code, 2)
        fault = self.gate.withdrawal_invariant()
        self.assertIsNotNone(fault)
        self.assertIn("TOG-RUNNER", fault)

    def test_withdrawing_both_is_consistent(self) -> None:
        """Withdrawing the runner AND the card it carries is not a fault."""
        self.single_card(head=self.payload,
                         superseded=(self.payload, "TOG-RUNNER"))
        self.gate.WITHDRAWN = {
            "TOG-RUNNER": ("vendor patch", "re-scope"),
            "TOG-TEST": ("vendor patch", "re-scope"),
        }
        self.assertIsNone(self.gate.withdrawal_invariant())
        self.assertEqual(self.row()["state"], "WITHDRAWN")

    def test_the_live_tables_are_self_consistent(self) -> None:
        """Guards the REAL tables, not a fixture -- this is the shipping check."""
        live = load_gate()
        self.assertIsNone(live.withdrawal_invariant())

    def test_the_live_window_authorises_only_what_the_owner_kept(self) -> None:
        """TOG-916 and the other vendor patches must not be runnable."""
        live = load_gate()
        for card in ("TOG-703", "TOG-749", "TOG-754", "TOG-916", "TOG-847"):
            self.assertIn(card, live.WITHDRAWN, f"{card} must be withdrawn")
        for card in ("TOG-881",):
            self.assertNotIn(card, live.WITHDRAWN, f"{card} must remain runnable")


class TestDeployLineAnchor(GateFixture):
    """TOG-997: the deploy line must be a NAME, not a checkout.

    The defect these cover: every other check in this gate reads
    `rev-parse HEAD` on a shared, mutable tree, so an unrelated run's
    `git checkout` invalidates the window. Measured on the real tree, 7
    such excursions in 26.15 h with ZERO commits. Worse, the reviewed
    commits themselves were held by nothing but an unrelated feature
    branch that happened to descend from them.
    """

    REF = "refs/deploy-line/test"

    def anchor(self, expected: str) -> dict:
        """Point the gate's ANCHORS at this fixture and return the one row."""
        self.gate.ANCHORS = {
            self.REF: ("tree", expected, "test line"),
        }
        rows = self.gate.evaluate_anchors()
        self.assertEqual(len(rows), 1)
        return rows[0]

    def test_an_existing_ref_at_the_reviewed_commit_is_green(self) -> None:
        git(self.tree, "update-ref", self.REF, self.pin)
        self.assertEqual(self.anchor(self.pin)["state"], "ANCHOR_OK")

    def test_a_line_with_no_ref_of_its_own_is_red(self) -> None:
        """The measured live state before this table existed.

        The commit is perfectly reachable -- HEAD is sitting on it -- and
        that is exactly the false green: reachability today via a branch
        that happens to descend from it is not an anchor.
        """
        row = self.anchor(self.pin)
        self.assertEqual(row["state"], "ANCHOR_MISSING")
        self.assertIsNone(row["actual"])

    def test_a_ref_pointing_somewhere_else_is_red_and_not_silently_accepted(self) -> None:
        """A re-pointed line must not pass as 'anchored'."""
        git(self.tree, "update-ref", self.REF, self.feature)
        row = self.anchor(self.pin)
        self.assertEqual(row["state"], "ANCHOR_MOVED")
        self.assertEqual(row["actual"], self.feature)

    def test_an_unreadable_tree_is_distinguished_from_a_missing_ref(self) -> None:
        """Different repairs: missing checkout vs missing ref.

        Collapsing these prints 'run update-ref' at an operator whose
        actual problem is that the tree is not there -- the TOG-998
        failure mode, the right red with the wrong instruction.
        """
        self.gate.ANCHORS = {self.REF: ("no-such-tree", self.pin, "test line")}
        rows = self.gate.evaluate_anchors()
        self.assertEqual(rows[0]["state"], "ANCHOR_TREE_UNREADABLE")

    def test_the_anchor_survives_a_stray_checkout(self) -> None:
        """The whole point: HEAD moves, the line does not.

        This is the 7/7 measured scenario. Under the old HEAD-only checks
        this state was red; the anchor is what makes it a non-event.
        """
        git(self.tree, "update-ref", self.REF, self.pin)
        git(self.tree, "checkout", "-q", self.feature)
        self.assertNotEqual(git(self.tree, "rev-parse", "HEAD"), self.pin)
        self.assertEqual(self.anchor(self.pin)["state"], "ANCHOR_OK")

    def test_a_tag_shaped_ref_is_peeled_to_a_commit(self) -> None:
        """`^{commit}` is load-bearing: an annotated tag must not pass as
        the commit's own object id, and must resolve to what it points at."""
        git(self.tree, "tag", "-a", "-m", "t", "annotated", self.pin)
        git(self.tree, "update-ref", self.REF, "refs/tags/annotated")
        self.assertEqual(self.anchor(self.pin)["state"], "ANCHOR_OK")

    def test_an_unanchored_line_closes_the_window(self) -> None:
        """A red anchor must reach the verdict, not just the row.

        An anchor row that reddens nothing is a comment, not a gate.
        """
        self.single_card(head=self.pin)
        self.gate.ANCHORS = {self.REF: ("tree", self.pin, "test line")}
        code, rows = self.gate.evaluate()
        self.assertEqual(code, 1)
        self.assertIn("ANCHOR_MISSING", [r["state"] for r in rows])

    def test_a_withdrawn_window_still_requires_its_anchor(self) -> None:
        """The line outlives the scripts that pinned it.

        Every card that pinned the real line is WITHDRAWN, but the commits
        are TOG-1010's re-test specification. Withdrawal must not be
        allowed to take the anchor down with it.
        """
        self.single_card(head=self.pin)
        self.gate.WITHDRAWN = {"TOG-TEST": ("vendor patch", "re-scope")}
        self.gate.ANCHORS = {self.REF: ("tree", self.pin, "test line")}
        code, _ = self.gate.evaluate()
        self.assertEqual(code, 1)

    def test_the_gate_never_creates_the_ref_it_asserts(self) -> None:
        """A gate that repairs itself can never report the fault.

        If evaluate_anchors() created a missing ref, the check would assert
        only that the gate can write, and a genuinely lost line would read
        green forever.
        """
        self.assertEqual(self.anchor(self.pin)["state"], "ANCHOR_MISSING")
        self.assertEqual(self.anchor(self.pin)["state"], "ANCHOR_MISSING")
        listed = git(self.tree, "for-each-ref", "--format=%(refname)",
                     "refs/deploy-line/")
        self.assertEqual(listed, "")

    def test_a_ref_is_a_gc_root_and_without_it_the_commit_dies(self) -> None:
        """The premise of the whole design, proved in two arms.

        Arm A alone would be vacuous -- a commit can survive gc for many
        reasons. The control arm is what makes it evidence.
        """
        git(self.tree, "checkout", "-q", "--detach", self.payload)
        # Nothing but the ref may reach self.pin: move every branch off it.
        for branch in ("feature",):
            git(self.tree, "branch", "-q", "-D", branch)
        head_branch = git(self.tree, "for-each-ref", "--format=%(refname)",
                          "refs/heads/")
        for ref in [r for r in head_branch.splitlines() if r]:
            git(self.tree, "update-ref", "-d", ref)

        def collect() -> None:
            git(self.tree, "reflog", "expire", "--expire=now",
                "--expire-unreachable=now", "--all")
            git(self.tree, "gc", "--prune=now", "-q")

        def alive(commit: str) -> bool:
            return subprocess.run(
                ["git", "-C", str(self.tree), "cat-file", "-e", f"{commit}^{{commit}}"],
                capture_output=True,
            ).returncode == 0

        # Arm A: with the ref, the reviewed commit survives collection.
        git(self.tree, "update-ref", self.REF, self.pin)
        collect()
        self.assertTrue(alive(self.pin), "a ref must be a gc root")
        self.assertEqual(self.anchor(self.pin)["state"], "ANCHOR_OK")

        # Arm B (control): drop the ref, collect again, and it is gone.
        git(self.tree, "update-ref", "-d", self.REF)
        collect()
        self.assertFalse(
            alive(self.pin),
            "control failed: gc did not prune, so arm A proved nothing",
        )

    def test_the_tog_516_governor_line_was_retired_not_forgotten(self) -> None:
        """Guards the REAL table against silent re-addition.

        TOG-2278 (2026-09-19): the checkout backing
        `refs/deploy-line/tog-516-governor` (tree
        `TOG-516-paperclip-v2026.817.0-governor`, commit
        `f471ef3c0eae0034b4cf394d6b4ffe0a46f9e07a`) is gone from this host and
        unrecoverable from any repo or backup path this container can reach.
        Re-adding it from an old card description would only put the gate
        back into a DRIFT no fix can clear -- there is no tree to check out.
        TOG-1010 (done) and TOG-1043 (done) show nothing outstanding depends
        on the tree itself; see deploy_window_manifest.py's ANCHORS comment
        for the full accounting, including where TOG-894's not-yet-extracted
        fix survives instead."""
        live = load_gate()
        self.assertNotIn("refs/deploy-line/tog-516-governor", live.ANCHORS)
        self.assertEqual(live.ANCHORS, {})


if __name__ == "__main__":
    unittest.main()
