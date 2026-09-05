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

  exit 0  READY    every entry present, hash-matched, and tree-pin current
  exit 1  DRIFT    an entry is missing, hash-mismatched, or pins a stale tree
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

    staged = sum(1 for row in rows if row.get("kind") != "built")
    built = len(rows) - staged
    print(f"deploy-window manifest -- {staged} staged card(s),"
          f" {built} built-at-install-time card(s)\n")
    for row in rows:
        mark = "ok  " if row["state"] in ("OK", "SUPERSEDED_OK", "BUILT_PIN_OK") else "FAIL"
        # A built card has no staged path; show the builder it is built with.
        where = row.get("path") or f"{row.get('builder')} @ {str(row.get('revision'))[:9]}"
        print(f"  [{mark}] {row['card']:<9} {row['state']:<18} {where}")
        if row["state"] == "BUILT_PIN_OK":
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
    print(f"\nVERDICT: {'READY' if code == 0 else 'DRIFT'}")
    return code


if __name__ == "__main__":
    sys.exit(main())
