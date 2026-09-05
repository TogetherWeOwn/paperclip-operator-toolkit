#!/usr/bin/env python3
"""Deploy-window manifest gate.

One human host window, several staged deploys. Every card below is blocked ONLY
on host hands: the artifact is merged, reviewed, and staged, and the agent
container cannot execute it (uid 1000, no sudo/systemctl/podman socket).

This script is the single source of truth for what that window covers. It
re-verifies, at run time, that each staged script still hashes to the value its
card's unblockDescriptor pins. A drifted script is a REFUSAL, not a warning --
an operator must never run bytes that no reviewer saw.

It ALSO re-verifies the staging tree each script pins. Hash-matching the script
is not sufficient: every operator script here asserts
`git rev-parse HEAD == expected_head` against the shared staging tree and aborts
at step=verify-staging-tree when it does not match. That tree is mutable and
shared, so it moves independently of the scripts' bytes. Checking only the bytes
reports READY for a window in which every script would refuse on the host --
a green that costs a human trip. Measured 2026-09-05: the tree had advanced to
b5b66ceda ("feat: add provider-grouped model catalogue picker"), one commit past
v5's pin f471ef3c0, and all five tree-pinned scripts would have refused while
this gate still printed READY.

A tree that is off its pin is reported by CAUSE, because the two causes need
opposite repairs. If the pinned commit is still an object in the tree, HEAD was
merely moved (TREE_STRAY_CHECKOUT) and the repair is to check the pin back out
-- re-cutting would pin the script to whatever HEAD happens to sit on. Only an
unreachable pin (TREE_PIN_GONE) justifies a re-cut. Measured 2026-09-05: across
26.15 h and 7 red excursions on this tree, commit events were ZERO and every red
was a stray checkout of a feature branch, so the re-cut advice was wrong 7/7.

Not every card in this window is a staged script. A BUILT card (TOG-586) ships a
bundle produced at install time from a reviewed commit in the source repo, so
there is nothing under STAGING to hash. Such a card is still enrolled, and what
gets verified is the thing that can actually be wrong: that its pinned revision
is a real commit on the trusted line. See the BUILT table for why the builder's
own ancestry check is not a substitute for this pin.

TOG-997: a deploy line must be a NAME, not a checkout. Every check above reads
`rev-parse HEAD` on a shared, mutable tree, so a stray `git checkout` by an
unrelated run invalidates the whole window at once. The durable question is
whether the reviewed commit still EXISTS and is still ANCHORED -- which is what
ANCHORS below asserts, against a ref no checkout can move. See that table.

  exit 0  READY    every entry present, hash-matched, tree-pin current, anchored
  exit 1  DRIFT    an entry is missing, hash-mismatched, stale, or unanchored
  exit 2  ERROR    could not evaluate

Usage:  python3 deploy-window-manifest.py [--json]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

STAGING = Path("/paperclip/instances/default/data/deployment-staging")

# The scripts address the host path; /paperclip is a bind mount of that same
# directory (verified via /proc/self/mountinfo: /home/ubuntu/.local/share/
# paperclip -> /paperclip, same device), so the tree read here is the tree the
# operator's `git rev-parse` will read.
HOST_PREFIX = "/home/ubuntu/.local/share/paperclip"
CONTAINER_PREFIX = "/paperclip"

# Parsed, never hardcoded: a re-cut script must not be able to drift from the
# value this gate checks.
STAGING_RE = re.compile(r"^staging=(\S+)", re.MULTILINE)
HEAD_RE = re.compile(r"^expected_head=([0-9a-f]{7,40})", re.MULTILINE)


def tree_pin(script: Path) -> tuple[Path, str] | None:
    """Return (tree, expected_head) the script asserts, or None if it pins none.

    A script with no `expected_head` (TOG-881 deploys a package and never
    touches the staging tree) is legitimately tree-independent, not a failure.
    """
    text = script.read_text(errors="replace")
    head = HEAD_RE.search(text)
    tree = STAGING_RE.search(text)
    if not head or not tree:
        return None
    path = tree.group(1)
    if path.startswith(HOST_PREFIX):
        path = CONTAINER_PREFIX + path[len(HOST_PREFIX):]
    return Path(path), head.group(1)


def git_head(tree: Path) -> str | None:
    try:
        done = subprocess.run(
            ["git", "-C", str(tree), "rev-parse", "HEAD"],
            capture_output=True, text=True, timeout=30, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return done.stdout.strip() if done.returncode == 0 else None

# card -> (path relative to STAGING, full sha256 pinned by the card)
# Hashes measured 2026-09-05 against each card's live unblockDescriptor.
MANIFEST: dict[str, tuple[str, str]] = {
    "TOG-703": (
        "TOG-703-operator.sh",
        "49a31d522c666599e6c0ea95a83ca6f0a862fe9dea917fd5589a434a88a5422d",
    ),
    "TOG-749": (
        "TOG-749-operator.sh",
        "9a1685f440f25f8874322317394fa563ece8039d472553396f625b7d0cba70b6",
    ),
    "TOG-754": (
        "TOG-754-operator.sh",
        "2510b7b0c7b7b9d0509a3c73b1293cb4a5d3c603bd2931531294c7783c85b8bc",
    ),
    "TOG-916": (
        "TOG-916-operator-v5.sh",
        "4450a0504c4d408eb0041a46",  # card pins a prefix only; compared as a prefix
    ),
    "TOG-847": (
        "TOG-516-operator-v2.sh",
        "9c54ecdd",  # card pins a prefix only; compared as a prefix
    ),
    "TOG-881": (
        "TOG-881-gh-token-broker/TOG-881-operator.sh",
        "06fb9ca7a9c0f0289d0b7bb4",  # card pins a prefix only; compared as a prefix
    ),
}

# THE FIVE TREE-PINNED SCRIPTS ARE ONE SUPERSESSION CHAIN, NOT FIVE DEPLOYS.
#
# Each card's own unblockDescriptor says so ("do not also run the older
# TOG-703/749-operator.sh afterward, they would only rebuild an already-
# superseded commit"), and every older pin is an ancestor of v5's pin. The
# operator runs ONE script -- TOG-916-operator-v5.sh -- and that single build
# lands all five payloads.
#
# Requiring each superseded script's expected_head to equal the live tree HEAD
# is therefore not just wrong, it is UNSATISFIABLE: the five scripts pin five
# distinct commits and a tree has one HEAD, so at most one of the five could
# ever be OK. A gate that can never print READY cannot gate a window.
#
# What actually protects the operator for a superseded card is not "does this
# stale script still run" -- it must NOT be run -- but "does the script we DO
# run still carry this card's payload". That is an ancestry question, so it is
# the ancestry we check: payload commit must be an ancestor of the live HEAD.
#
# card -> (payload commit that must still be carried, card whose script runs it)
SUPERSEDED_BY: dict[str, tuple[str, str]] = {
    "TOG-703": ("55ed0e8a6fb53f156f62daaf94f7fd88e43ab2d9", "TOG-916"),
    "TOG-749": ("f7191360e302b99cc0b6e9f2506f58a9b5d43b1e", "TOG-916"),
    "TOG-754": ("c06dd0bc09557b8292803909d1e71790ad8c4447", "TOG-916"),
    "TOG-847": ("51ee6c01b472dfe839ca4ac38c6a58a11e9dc65f", "TOG-916"),
}

# CARDS THE OWNER WITHDREW FROM THIS WINDOW -- 2026-09-05 05:07Z.
#
# A HASH GATE ANSWERS "ARE THESE THE REVIEWED BYTES", NEVER "MAY THIS BE RUN".
#
# The owner ruled: no fork of Paperclip -- no /app patches, no governor image.
# The approved path is an upstream upgrade to v2026.831.1, re-testing each
# patched concern there, and sending upstream whatever remains.
#
# Every hash in MANIFEST above was still correct when that ruling landed, so the
# gate went on printing `[ok] TOG-916 OK` -- which an operator reads as RUN THIS.
# Measured 2026-09-05 05:11Z, after the ruling: VERDICT READY, exit 0, over six
# staged cards of which five are now forbidden. TOG-916-operator-v5.sh:217 runs
# `podman build --build-arg PAPERCLIP_BUILD_VERSION=2026.817.0` against the
# staging tree and :236 rewrites the quadlet `Image=` to that tag: it BUILDS THE
# FORK, pinned to the version being upgraded away from tonight. The four
# SUPERSEDED_OK rows compound it -- each names TOG-916's script as the thing that
# carries its payload, so the whole chain points at the forbidden build.
#
# This is the failure mode a gate is supposed to prevent, arriving through the
# one door it did not watch: the bytes never drifted, the AUTHORIZATION did. So
# withdrawal is checked FIRST, ahead of any hash, and no verdict can promote a
# withdrawn card back to runnable.
#
# Kept here rather than deleted from MANIFEST on purpose. Deleting the rows would
# make a forbidden card indistinguishable from one that was never enrolled, and
# the next reader would re-add it from the card's own unblockDescriptor, which
# still says "staged, reviewed, ready". The refusal has to be louder than the
# artifact, and it has to state its own expiry condition.
#
# card -> (disposition, what has to happen before it could return)
WITHDRAWN: dict[str, tuple[str, str]] = {
    "TOG-703": (
        "vendor patch - excluded, no fork",
        "re-scope to: verify on v2026.831.1; if still needed, prepare an upstream PR",
    ),
    "TOG-749": (
        "vendor patch - excluded, no fork",
        "re-scope to: verify on v2026.831.1; if still needed, prepare an upstream PR",
    ),
    "TOG-754": (
        "vendor patch - excluded, no fork",
        "re-scope to: verify on v2026.831.1; if still needed, prepare an upstream PR",
    ),
    "TOG-916": (
        "vendor patch - excluded, no fork",
        "re-scope to: verify on v2026.831.1; if still needed, prepare an upstream PR",
    ),
    "TOG-847": (
        "CANCELLED - governor image is a hard fork",
        "nothing; the card is cancelled and its script must never run",
    ),
}


def withdrawal_invariant() -> str | None:
    """Return a fault string if the tables could still advise a forbidden run.

    A superseded card is only safe because some OTHER card's script carries its
    payload. Withdraw that runner while leaving the superseded card enrolled and
    the gate would print `DO NOT RUN - superseded by TOG-916's script` at an
    operator who must not run TOG-916 either: advice to execute a forbidden
    artifact, produced by a green gate. The four/one split here is one editing
    slip away from exactly that, so the coupling is asserted rather than trusted.
    """
    for card, (_payload, runner) in sorted(SUPERSEDED_BY.items()):
        if runner in WITHDRAWN and card not in WITHDRAWN:
            return (
                f"{card} is superseded by {runner}, but {runner} is WITHDRAWN and"
                f" {card} is not. The gate would name a forbidden script as"
                f" {card}'s payload carrier. Withdraw {card} too, or give it a"
                f" runner that is still in the window."
            )
    return None


# THE DEPLOY LINE IS A NAME, NOT A CHECKOUT (TOG-997).
#
# Everything above asks `rev-parse HEAD`. HEAD is the single most volatile thing
# in a shared tree: one `git checkout` by an unrelated run moves it, and measured
# 2026-09-05 that happened 7 times in 26.15 h with ZERO commits. A window whose
# validity is a property of HEAD is invalid 27.8% of the time by accident.
#
# The durable question is not "where is HEAD" but "does the reviewed line still
# EXIST, under a name that a checkout cannot move". That is a ref. Measured
# 2026-09-05, before this table existed, the answer was NO:
#
#   f471ef3c0 (the deploy pin, tip of the 10-commit fork line) was held by
#   exactly ONE ref -- refs/heads/tog-942-agent-model-picker, an unrelated
#   feature branch that merely happened to be cut from it. No tag, no remote,
#   no ref of its own. Delete or rebase that branch and all 10 commits become
#   unreachable; `git gc` then deletes them.
#
# That line is not disposable. TOG-1010 (the owner-approved successor to the
# cancelled fork track) says in terms: "Do NOT delete this tree -- it is the
# specification for the re-test", and names 5 of these commits as the worklist
# mapping each forked concern to the defect it fixes. Losing it does not cost a
# deploy -- the deploys are withdrawn -- it costs the SPECIFICATION for the
# upstream work that replaced them.
#
# So each line gets a ref in its own namespace, and this gate asserts the ref
# still exists AND still resolves to the reviewed commit. A ref is a gc root:
# proved on a throwaway fixture in verification/tog-997-deploy-line-anchor-gate.sh
# with a two-arm test -- with the ref, the commit survives
# `git gc --prune=now` after `reflog expire --expire-unreachable=now`; with the
# ref deleted and nothing else pointing at it, the same gc DELETES it.
#
# WHY THE REF IS ASSERTED AND NOT SILENTLY CREATED. Creating it on the fly would
# make the gate green by construction and it would never report a lost line --
# the check would assert only that the gate can write. The ref is created once,
# deliberately, by an operator or by the card that establishes the line; this
# gate only ever READS. An absent ref is a red with a one-command repair.
#
# line name -> (tree, commit the ref must resolve to, what the line is for)
ANCHORS: dict[str, tuple[str, str, str]] = {
    "refs/deploy-line/tog-516-governor": (
        "TOG-516-paperclip-v2026.817.0-governor",
        "f471ef3c0eae0034b4cf394d6b4ffe0a46f9e07a",
        "TOG-1010 re-test specification: the 10-commit fork line over v2026.817.0",
    ),
}


def ref_target(tree: Path, ref: str) -> str | None:
    """Commit a ref resolves to, or None if the ref does not exist.

    `rev-parse --verify <ref>^{commit}` rather than plain rev-parse: a bare
    rev-parse of a nonexistent ref can echo the argument back and exit non-zero,
    and peeling to ^{commit} means a tag or a stale symbolic ref cannot pass as
    a commit. Distinguishing "ref missing" from "tree unreadable" is the
    caller's job -- it asks git_head() first, exactly as evaluate_built() does.
    """
    try:
        done = subprocess.run(
            ["git", "-C", str(tree), "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"],
            capture_output=True, text=True, timeout=30, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return done.stdout.strip() if done.returncode == 0 else None


def evaluate_anchors() -> list[dict[str, object]]:
    """Rows asserting each deploy line is still held by its own ref.

    Deliberately independent of HEAD, of the MANIFEST, and of WITHDRAWN: the
    line outlives every script that pinned it. TOG-916's script is forbidden;
    the commits it pinned are still the re-test specification, and a withdrawn
    script must not take its line's anchor down with it.
    """
    rows: list[dict[str, object]] = []
    for ref, (relative, expected, purpose) in sorted(ANCHORS.items()):
        tree = STAGING / relative
        row: dict[str, object] = {
            "card": "deploy-line",
            "kind": "anchor",
            "ref": ref,
            "tree": str(tree),
            "expected": expected,
            "purpose": purpose,
        }
        if git_head(tree) is None:
            # Same discrimination as evaluate_built(): a missing checkout is a
            # different repair from a missing ref, and ref_target() alone
            # returns None for both.
            row["state"] = "ANCHOR_TREE_UNREADABLE"
        else:
            actual = ref_target(tree, ref)
            row["actual"] = actual
            if actual is None:
                row["state"] = "ANCHOR_MISSING"
            elif actual == expected:
                row["state"] = "ANCHOR_OK"
            else:
                row["state"] = "ANCHOR_MOVED"
        rows.append(row)
    return rows


def commit_exists(tree: Path, rev: str) -> bool | None:
    """True if `rev` resolves to a commit object present in this tree.

    None only when the question could not be asked (git absent, tree gone).
    """
    try:
        done = subprocess.run(
            ["git", "-C", str(tree), "cat-file", "-e", f"{rev}^{{commit}}"],
            capture_output=True, text=True, timeout=30, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return done.returncode == 0


# WHY PIN-PRESENCE, AND NOT DESCENDANCY, DECIDES THE ADVICE.
#
# A tree whose HEAD is not at the pin has two causes needing OPPOSITE advice,
# and the obvious discriminator -- "is live HEAD a descendant of the pin?" --
# gets BOTH of this tree's observed cases wrong.
#
# Measured on this staging tree over the 26.15 h since the pin f471ef3c0 was
# established: 7 red excursions, 0 commit events. Every red was a stray
# checkout of b5b66ceda ("feat: add provider-grouped model catalogue picker"),
# which lives only on branch tog-942-agent-model-picker. b5b66ceda IS a
# descendant of f471ef3c0, so a descendancy test routes all 7/7 strays to
# "the deploy line advanced, re-cut it" -- the same wrong advice, on a worse
# pin: re-cutting would pin the operator script to an unrelated feature branch.
# That is the failure mode that expired v4 and v5.
#
# The operator's actual question is not how HEAD got here, it is which repair
# is available. The script asserts `rev-parse HEAD == expected_head`, so the
# cheap repair is to put HEAD back on the pin -- and that repair works exactly
# when the pinned commit is still an object in this tree. Re-cutting is the
# LAST resort, correct only when the pin is genuinely unreachable (history
# rewritten, commit gc'd) and so cannot be checked out at all.
#
# Descendancy is still reported, as diagnosis of how the tree got here. It is
# never the discriminator.
def classify_drift(tree: Path, expected: str, live: str) -> str:
    """State for a tree-pinned script whose tree HEAD is not at its pin."""
    present = commit_exists(tree, expected)
    if present is None:
        return "TREE_UNREADABLE"
    return "TREE_STRAY_CHECKOUT" if present else "TREE_PIN_GONE"


def is_ancestor(tree: Path, ancestor: str, descendant: str) -> bool | None:
    """True/False, or None when the question could not be asked at all.

    A missing object is False (the payload is not carried), not None: that is a
    real answer to a real question and must fail the gate rather than degrade.
    """
    try:
        done = subprocess.run(
            ["git", "-C", str(tree), "merge-base", "--is-ancestor", ancestor, descendant],
            capture_output=True, text=True, timeout=30, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if done.returncode in (0, 1):
        return done.returncode == 0
    return False

# BUILT-AT-INSTALL-TIME CARDS. IN THE WINDOW, BUT NOTHING UNDER STAGING TO HASH.
#
# TOG-586 installs a systemd user timer from a bundle the operator BUILDS on the
# host, from a commit in the source repo, via
# systemd/build-liveness-reconciler-bundle.sh. There is no staged script, so the
# hardcoded MANIFEST table above never picked it up and the card sat blocked on
# a window that structurally could not carry it. Measured 2026-09-05: the gate
# printed READY over six cards and TOG-586 was not one of them.
#
# WHAT IS VERIFIED HERE, AND WHY IT IS THE REVISION.
#
# For a staged card the risk is "the bytes changed since review", so the check
# is a sha256. A built card has no bytes yet; its risk is that the operator
# builds the WRONG COMMIT. That was live, not theoretical: TOG-979 is `done` and
# its title says "Install ... at ee6a85be". Measured 2026-09-05, ee6a85be is
# NOT an ancestor of main (diverged, ahead 23 / behind 1), its installer
# preflight requires /usr/bin/runuser -- absent on this host, which ships it at
# /usr/sbin/runuser, and the bundle never invokes it -- and it ships the builder
# non-executable (100644). It would refuse a host that installs cleanly from
# main. Two cards named two different commits, and only prose distinguished them.
#
# WHY THE BUILDER'S OWN ANCESTRY CHECK DOES NOT REPLACE THIS PIN.
#
# PR #222 makes the builder refuse any --source-ref that is not an ancestor of
# origin/main, which does contain ee6a85be. But an ancestry test is a CLASS
# check ("not off a fork"), not a revision pin ("this exact reviewed commit").
# Measured on tog-586-builder-ancestry-gate @ 49e27eb6 by advancing origin/main
# one commit past the pin: the builder accepted BOTH the pinned 49374f55 and the
# newer commit at exit 0. Every future commit on main is also an ancestor of
# main, so the builder alone cannot say WHICH revision was reviewed. That is
# what this table records, and why it is worth having in addition to #222.
#
# card -> (revision that was reviewed, what the operator builds it with)
BUILT: dict[str, tuple[str, str]] = {
    "TOG-586": (
        "49374f556395126b24c1d9310c4d8728167ccd55",
        "systemd/build-liveness-reconciler-bundle.sh",
    ),
}

# The repo the BUILT revisions must be commits in. This is the source checkout,
# NOT the deployment-staging tree the operator scripts pin -- a built card never
# touches that tree.
SOURCE_REPO = Path(
    "/paperclip/instances/default/projects/00000000-0000-4000-8000-000000000000"
    "/f2dc52a4-256f-4766-aec5-52a94ca387e2/paperclip-ops-tooling"
)

# Blocked-and-deploy-shaped, but NOT in this window and why. Recorded so the
# next reader does not have to re-derive the exclusion.
EXCLUDED: dict[str, str] = {
    "TOG-521": "explicit owner do-not-flip HOLD",
    "TOG-567": "owner exact-scope approval is the sole gate",
    "TOG-570": "owner vendor-channel HOLD",
    "TOG-316": "tracks TOG-567; owner rejected the interaction",
    "TOG-757": "installs the host-ops broker itself - sequencing decision, not a payload",
    "TOG-756": "no staged script; needs /app write authority first",
    "TOG-608": "first-class dependency on TOG-756",
    "TOG-974": "no unblock descriptor and no staged artifact",
    "TOG-13": "needs a host that does not exist yet, not a deploy step",
    "TOG-892": "blocked on TOG-13",
    "TOG-848": "needs a DNS credential from TOG-59",
    "TOG-85": "empty unblock descriptor",
    "TOG-780": "unfreeze test, not a staged deploy",
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def evaluate_built() -> list[dict[str, object]]:
    """Rows for cards whose artifact is built on the host, not staged.

    The only question a gate can honestly answer before the build is whether
    the pinned revision is a real commit here.

    THE REPO MUST BE PROVED READABLE FIRST, AND NOT BY `commit_exists`.
    `git cat-file -e` exits 128 BOTH for "this repo does not have that commit"
    and for "there is no repo here at all" -- measured, both 128 -- so
    commit_exists() answers False in both cases and cannot tell them apart. The
    staged path never hit this because it calls git_head() first and handles
    None. Collapsing the two here would print BUILT_PIN_GONE ("fetch the
    commit") at an operator whose actual problem is a missing checkout: the
    right red with the wrong repair, which is the TOG-998 failure mode. So ask
    the repo-level question separately, with git_head, before the commit-level
    one.
    """
    rows: list[dict[str, object]] = []
    for card, (revision, builder) in sorted(BUILT.items()):
        row: dict[str, object] = {
            "card": card,
            "kind": "built",
            "revision": revision,
            "builder": builder,
            "repo": str(SOURCE_REPO),
        }
        if git_head(SOURCE_REPO) is None:
            row["state"] = "BUILT_UNREADABLE"
        else:
            present = commit_exists(SOURCE_REPO, revision)
            if present is None:
                row["state"] = "BUILT_UNREADABLE"
            elif present:
                row["state"] = "BUILT_PIN_OK"
            else:
                row["state"] = "BUILT_PIN_GONE"
        rows.append(row)
    return rows


def evaluate() -> tuple[int, list[dict[str, object]]]:
    rows: list[dict[str, object]] = []
    drift = False
    for card, (relative, pinned) in sorted(MANIFEST.items()):
        target = STAGING / relative

        # AUTHORISATION IS CHECKED BEFORE BYTES, AND SHORT-CIRCUITS.
        #
        # A withdrawn card's hash is typically still perfect -- that is the whole
        # problem -- so letting it reach the hash comparison would produce `OK`
        # and the operator would run it. Nothing below may run for these.
        if card in WITHDRAWN:
            disposition, restore = WITHDRAWN[card]
            rows.append({
                "card": card,
                "path": str(target),
                "state": "WITHDRAWN",
                "disposition": disposition,
                "restore": restore,
                "present": target.is_file(),
            })
            continue

        if not target.is_file():
            rows.append({"card": card, "path": str(target), "state": "MISSING"})
            drift = True
            continue
        actual = sha256_file(target)
        # A card that pins a prefix is honoured as a prefix; a card that pins a
        # full digest is compared in full. Never the other way round.
        ok = actual.startswith(pinned) if len(pinned) < 64 else actual == pinned
        row: dict[str, object] = {
            "card": card,
            "path": str(target),
            "state": "OK" if ok else "HASH_MISMATCH",
            "pinned": pinned,
            "actual": actual,
            "executable": target.stat().st_mode & 0o111 != 0,
        }

        # The script's bytes can be pristine while the tree it will refuse over
        # has moved. Reproduce the script's OWN assertion rather than trusting
        # that the two stay in step.
        pin = tree_pin(target)
        if pin is None:
            row["tree_pin"] = None  # tree-independent by construction
        else:
            tree, expected = pin
            live = git_head(tree)
            row["tree"] = str(tree)
            row["tree_pinned"] = expected
            row["tree_actual"] = live
            superseded = SUPERSEDED_BY.get(card)
            if not ok:
                # The bytes already failed. A tree verdict must never overwrite
                # a hash verdict -- SUPERSEDED_OK in particular would turn a
                # tampered script green, which is the exact failure this gate
                # exists to prevent.
                pass
            elif live is None:
                row["state"] = "TREE_UNREADABLE"
            elif superseded is not None:
                # This script is superseded and must never be run. Its own pin
                # is expected to be stale; what matters is that the script the
                # operator DOES run still carries this card's payload.
                payload, runner = superseded
                row["superseded_by"] = runner
                row["payload_commit"] = payload
                carried = is_ancestor(tree, payload, live)
                if carried is None:
                    row["state"] = "TREE_UNREADABLE"
                elif carried:
                    row["state"] = "SUPERSEDED_OK"
                else:
                    row["state"] = "PAYLOAD_LOST"
            elif not live.startswith(expected):
                row["state"] = classify_drift(tree, expected, live)
                # Diagnosis only -- never the discriminator. See classify_drift.
                row["live_is_descendant_of_pin"] = is_ancestor(tree, expected, live)

        rows.append(row)
        if row["state"] not in ("OK", "SUPERSEDED_OK"):
            drift = True

    for row in evaluate_built():
        rows.append(row)
        if row["state"] != "BUILT_PIN_OK":
            drift = True

    # An unanchored line is drift even when every card is withdrawn: the commits
    # are TOG-1010's re-test specification and nothing else holds them.
    for row in evaluate_anchors():
        rows.append(row)
        if row["state"] != "ANCHOR_OK":
            drift = True

    # A WITHDRAWN row is a correct, expected state, not drift: the two cards the
    # owner left in the window (TOG-881, TOG-586) must still be able to run, so
    # withdrawal cannot be allowed to close the window. It is excluded from the
    # drift test above by the short-circuit, deliberately.
    #
    # But a table that could advise running a forbidden script is a REAL fault,
    # and it must not be reported as a policy note -- it is exit 2, because the
    # gate can no longer be trusted to answer the question it was asked.
    if withdrawal_invariant() is not None:
        return 2, rows
    return (1 if drift else 0), rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="emit machine-readable output")
    args = parser.parse_args()

    try:
        code, rows = evaluate()
    except OSError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps({"verdict": "READY" if code == 0 else "DRIFT", "entries": rows}, indent=2))
        return code

    withdrawn = sum(1 for row in rows if row["state"] == "WITHDRAWN")
    built = sum(1 for row in rows if row.get("kind") == "built")
    anchors = sum(1 for row in rows if row.get("kind") == "anchor")
    staged = len(rows) - built - anchors - withdrawn
    print(f"deploy-window manifest -- {staged} runnable staged card(s),"
          f" {built} built-at-install-time card(s),"
          f" {withdrawn} withdrawn by the owner,"
          f" {anchors} anchored deploy line(s)\n")
    for row in rows:
        if row["state"] == "WITHDRAWN":
            mark = "STOP"
        elif row["state"] in ("OK", "SUPERSEDED_OK", "BUILT_PIN_OK", "ANCHOR_OK"):
            mark = "ok  "
        else:
            mark = "FAIL"
        # A built card has no staged path; show the builder it is built with.
        # An anchor row has neither; show the ref, which is the whole point.
        where = (row.get("path")
                 or (f"{row['ref']} -> {str(row.get('actual'))[:9]}"
                     if row.get("kind") == "anchor" else None)
                 or f"{row.get('builder')} @ {str(row.get('revision'))[:9]}")
        print(f"  [{mark}] {row['card']:<9} {row['state']:<18} {where}")
        if row["state"] == "WITHDRAWN":
            print(f"          DO NOT RUN — {row['disposition']}")
            print("          Owner ruling 2026-09-05 05:07Z: no fork of Paperclip.")
            print(f"          To return to a window: {row['restore']}")
            if not row["present"]:
                print("          (the staged script is already gone from this host)")
        elif row["state"] == "BUILT_PIN_OK":
            print(f"          BUILD, do not look for a staged script. Reviewed revision:")
            print(f"            {row['revision']}")
            print(f"          Build it with {row['builder']} --source-ref <that revision>.")
            print("          Do NOT build ee6a85be (TOG-979's title): not an ancestor of")
            print("          main, and its preflight demands /usr/bin/runuser, absent here.")
        elif row["state"] == "BUILT_PIN_GONE":
            print(f"          pinned revision {str(row['revision'])[:9]} is NOT a commit in")
            print(f"          {row['repo']}")
            print("          Fetch it, or the operator cannot build this card at all.")
        elif row["state"] == "BUILT_UNREADABLE":
            print(f"          source repo {row['repo']} could not be read")
        elif row["state"] == "ANCHOR_OK":
            print(f"          line is NAMED, so no checkout can invalidate it:")
            print(f"            {row['expected']}")
            print(f"          {row['purpose']}")
        elif row["state"] == "ANCHOR_MISSING":
            print(f"          the deploy line has NO ref of its own in {row['tree']}")
            print(f"          {row['purpose']}")
            print("          Nothing durable holds these commits: they survive only as")
            print("          long as some unrelated branch happens to descend from them,")
            print("          and `git gc` deletes them once it does not. Anchor it:")
            print(f"            git -C \"{row['tree']}\" update-ref {row['ref']} {row['expected']}")
            print("          This moves no branch and touches no working tree.")
        elif row["state"] == "ANCHOR_MOVED":
            print(f"          {row['ref']} exists but names the WRONG commit")
            print(f"            expected {row['expected']}")
            print(f"            actual   {row['actual']}")
            print("          Someone re-pointed the line. Do NOT assume the new target is")
            print("          equivalent: establish which commit was reviewed, then either")
            print("          restore the ref or update this table in a reviewed commit.")
        elif row["state"] == "ANCHOR_TREE_UNREADABLE":
            print(f"          tree {row['tree']} could not be read at all")
            print("          You are missing the checkout, not the ref.")
        elif row["state"] == "SUPERSEDED_OK":
            print(f"          DO NOT RUN — superseded by {row['superseded_by']}'s script")
            print(f"          payload {row['payload_commit'][:9]} is carried by live HEAD"
                  f" {str(row['tree_actual'])[:9]}")
        elif row["state"] == "PAYLOAD_LOST":
            print(f"          superseded by {row['superseded_by']}, but its payload commit")
            print(f"          {row['payload_commit'][:9]} is NOT an ancestor of live HEAD"
                  f" {str(row['tree_actual'])[:9]}")
            print("          the tree was rewritten; this card would ship nothing")
        elif row["state"] == "HASH_MISMATCH":
            print(f"          pinned {row['pinned']}")
            print(f"          actual {row['actual']}")
        elif row["state"] in ("TREE_STRAY_CHECKOUT", "TREE_PIN_GONE"):
            print(f"          staging tree {row['tree']}")
            print(f"          script pins  {row['tree_pinned']}")
            print(f"          tree is now  {row['tree_actual']}")
            print("          this script would abort at step=verify-staging-tree")
            descendant = row.get("live_is_descendant_of_pin")
            if row["state"] == "TREE_STRAY_CHECKOUT":
                # The pin is still an object here, so the repair is a checkout.
                # This holds whether or not live HEAD descends from the pin --
                # descendancy is printed as diagnosis, never as the instruction.
                print("          the pinned commit is STILL PRESENT in this tree:"
                      " HEAD was moved,")
                print("          not advanced past. DO NOT RE-CUT. Restore it with:")
                print(f"            git -C \"{row['tree']}\" checkout {row['tree_pinned']}")
                print("          then re-run this gate. Re-cutting here would pin the")
                print("          operator script to whatever HEAD happens to sit on.")
                if descendant is True:
                    print("          (diagnosis: live HEAD descends from the pin — a"
                          " descendant is")
                    print("           still a stray checkout when the pin is reachable.)")
                elif descendant is False:
                    print("          (diagnosis: live HEAD is divergent from the pin.)")
            else:
                print("          the pinned commit is ABSENT from this tree — it cannot be")
                print("          checked out, so history was rewritten or the commit was")
                print("          collected. This is the only case where a RE-CUT is correct.")
        elif row["state"] == "TREE_UNREADABLE":
            print(f"          staging tree {row['tree']} could not be read")
        elif row["state"] == "OK" and not row["executable"]:
            print("          note: not executable; operator must invoke via an interpreter")
    print(f"\n  excluded from this window: {len(EXCLUDED)} card(s)")
    for card, why in sorted(EXCLUDED.items()):
        print(f"    {card:<9} {why}")

    fault = withdrawal_invariant()
    if fault is not None:
        print(f"\nVERDICT: ERROR — the manifest tables are inconsistent.\n\n  {fault}\n")
        print("  Refusing to advise a window until this is repaired: a green here")
        print("  could name a forbidden script as a payload carrier.")
        return code

    if code == 0:
        runnable = [r["card"] for r in rows if r["state"] in ("OK", "BUILT_PIN_OK")]
        print(f"\nVERDICT: READY — {len(runnable)} card(s) may be run:"
              f" {', '.join(runnable) if runnable else 'none'}")
        if withdrawn:
            print(f"         {withdrawn} card(s) marked STOP above are NOT authorised."
                  " READY never means them.")
    else:
        print("\nVERDICT: DRIFT")
    return code


if __name__ == "__main__":
    sys.exit(main())
