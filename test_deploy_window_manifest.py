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


if __name__ == "__main__":
    unittest.main()
