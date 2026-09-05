# Opening the deploy window: run the wrapper, never the gate

**The single entry point is `./deploy_window_open.sh`.**

```bash
cd <this repo>
./deploy_window_open.sh [--json]
```

```
exit 0  the gate on this host is the reviewed one AND all staged cards verified
exit 1  drift in the gate itself, or the window did not verify
exit 2  could not evaluate
```

Everything else on this page explains why that is the only supported invocation.

## Do not run the gate directly

You will find this command in older comments and it still appears to work:

```bash
python3 /paperclip/operator-handoff/deploy-window-manifest.py    # ← BYPASSES a check
```

It runs the manifest gate, prints `VERDICT: READY`, and exits 0. What it does **not** do
is check that the file it just ran is the file that was reviewed. That check lives in
`verification/tog-990-handoff-copy-drift.sh`, and `deploy_window_open.sh` is its only
caller. Invoking the gate directly skips it silently — there is no warning, because the
bypassed check is the thing that would have warned you.

Measured 2026-09-05, this was not a theoretical gap: 11 of 17 comments on TOG-990 cited
the bare command, 4 cited the wrapper, the card description documented the bare gate,
and no markdown file mentioned `deploy_window_open` at all. An operator following the
written instructions never ran the drift check. Its reachability was a property of the
repo, not of the procedure. This page is the fix for that.

## What the wrapper adds, and why the order matters

`deploy_window_open.sh` does two things in a fixed order:

1. **Is the gate on this host the gate that was reviewed?** The operator runs
   `/paperclip/operator-handoff/deploy-window-manifest.py`, which is a *separate file*
   from the reviewed `deploy_window_manifest.py` in this repo. Nothing links them.
   On drift the wrapper refuses to invoke the gate at all.
2. **Does the window itself verify?** Only then is the gate run, re-checking every staged
   script against the sha256 its card's `unblockDescriptor` pins.

Check first, then run. Running first would mean taking advice from unreviewed bytes
before learning they were unreviewed.

### Why drift is worth refusing over

Measured 2026-09-05, the handoff copy sat one commit behind the reviewed one and **both
printed `VERDICT: READY`**. The drift was invisible on a green. It diverged only on a
red — and there the stale copy printed the "re-cut it" repair instruction that TOG-998
measured wrong 7 times out of 7 on this tree, where re-cutting would pin the operator
script to an unrelated feature branch.

A wrong repair instruction, on the one day the gate goes red, is worse than no gate at
all, because the operator trusts it. That is why the drift check is a byte comparison
and not a "does it still work" test: the failure mode is a gate that works correctly
while giving superseded advice, which no behavioural assertion on a green tree can see.

### Why the check is not inside the gate

The obvious design — have the gate hash itself against the reviewed copy — was built and
then rejected on evidence. Restoring the genuine stale bytes (`ad324225`) as the handoff
copy and re-running produced `exit 0 READY`: the stale revision does not *contain* the
self-check. A self-hosted guard is structurally blind to the exact case it exists for.
It kills a one-byte tamper and survives real staleness, which is the mutant that matters.

So the comparison must be made by something the stale copy cannot disable — this wrapper.

## If the drift check fails

The wrapper prints the sync command and refuses to open the window. Sync from the
**pinned git object**, which is what the failure message gives you — not from the working
tree, which may itself have moved:

```bash
git -C <repo> cat-file blob <PINNED_BLOB> > /paperclip/operator-handoff/deploy-window-manifest.py
```

Write the *bytes* (`>`), rather than replacing the file, so the handoff copy keeps its
mode — the operator invokes it directly and a lost executable bit is a real breakage.
Then re-run `./deploy_window_open.sh`.

## Owner ruling 2026-09-05 05:07Z: no fork — five cards are WITHDRAWN

The owner ruled that Paperclip will **not** be forked: no `/app` patches, no governor
image. The approved path is upgrading to upstream **v2026.831.1**, re-testing each
patched concern there, and sending upstream whatever still matters.

Five cards this window used to carry are therefore no longer runnable:

| Card | Disposition |
|---|---|
| TOG-703, TOG-749, TOG-754, TOG-916 | vendor patches — excluded; re-scope to *verify on v2026.831.1, then prepare an upstream PR* |
| TOG-847 | **cancelled** — the governor image is a hard fork |

**A green gate never meant these.** Their hashes were still perfect when the ruling
landed, because a hash gate answers *"are these the reviewed bytes"*, never *"may this
be run"* — the bytes did not drift, the authorisation did. Measured 2026-09-05 05:11Z,
after the ruling, the gate printed `VERDICT: READY` and `[ok] TOG-916 OK`, which an
operator reads as RUN THIS. `TOG-916-operator-v5.sh:217` runs
`podman build --build-arg PAPERCLIP_BUILD_VERSION=2026.817.0` and `:236` rewrites the
quadlet `Image=`: it builds the fork, pinned to the very version the upgrade moves away
from.

The gate now checks withdrawal **before** any hash and prints those cards as `[STOP]`,
and `VERDICT: READY` now names the cards it authorises rather than implying all of them:

```
VERDICT: READY — 2 card(s) may be run: TOG-881, TOG-586
         5 card(s) marked STOP above are NOT authorised. READY never means them.
```

Only **TOG-881** (gh-token-broker to `/opt`) and **TOG-586** (reconciler timer) remain.
Both are company-owned packages, not vendor patches. Per the ruling these do not need a
recurring human cadence — the operator runs them at the next tick.

Guarded by `verification/tog-990-withdrawal-mutation-gate.sh` (9 checks): deleting the
withdrawal short-circuit restores the pre-ruling green over TOG-916, and that is shown
red. Do not "tidy away" the `WITHDRAWN` table — the rows are kept deliberately, because
deleting them would make a forbidden card indistinguishable from one that was never
enrolled, and each card's own `unblockDescriptor` still says *staged, reviewed, ready*.

## Two kinds of card: staged, and built-at-install-time (TOG-1002)

Most cards in this window are **staged**: a script already sitting under
`deployment-staging`, which the gate re-hashes against the sha256 its card pins.

**TOG-586 is not.** Its artifact is a bundle the operator *builds on the host* from a
reviewed commit, so there is nothing staged to hash. Do not go looking for a
`TOG-586-operator.sh` — there isn't one, and its absence is not drift. Before this was
enrolled the card was blocked pointing at a window that structurally could not carry it.

The gate prints it with the revision to build:

```
[ok  ] TOG-586   BUILT_PIN_OK   systemd/build-liveness-reconciler-bundle.sh @ 49374f556
```

Follow `docs/liveness-reconciler.md`, build **`49374f55…`**, and leave
`PAPERCLIP_RECONCILER_MAX_REPAIRS=0` for the first live cycle.

`BUILT_PIN_GONE` means that revision is not a commit in the source repo — fetch it.
`BUILT_UNREADABLE` means the source repo itself could not be read, which is a different
repair: you are missing the checkout, not the commit.

### Do not build `ee6a85be`

TOG-979 is `done` and its title says *"Install … at ee6a85be"*. That pin is wrong.
Measured 2026-09-05: `ee6a85be` is **not an ancestor of `main`** (diverged, ahead 23 /
behind 1); its installer preflight requires `/usr/bin/runuser`, which this host does not
have (it ships `runuser` at `/usr/sbin`, and the bundle never invokes it); and it ships
the builder non-executable. It would refuse a host that installs cleanly from `main`.

### Why the manifest pins a revision when the builder already checks ancestry

PR #222 makes the builder refuse any `--source-ref` that is not an ancestor of
`origin/main` — which `ee6a85be` is not, so it fails closed. Keep it; but it is not this
pin. Measured on `49e27eb6` by advancing `origin/main` one commit past the pin, the
builder accepted **both** the pinned `49374f55` and the newer commit at exit 0. Ancestry
is a *class* check ("not off a fork"); it cannot say *which* revision was reviewed,
because every future commit on `main` is also an ancestor of `main`. The manifest is
what records that.

## The deploy line is a name, not a HEAD (TOG-997)

Every other row in this gate is a property of a checkout. The staging trees are **shared
and mutable**, and `HEAD` is the most volatile thing in them: one `git checkout` by an
unrelated run moves it. Measured 2026-09-05 on the governor staging tree, over the
26.15 h since pin `f471ef3c0` was set — **7 checkout excursions, zero commits, tree
gate-red 27.8% of the time**. A window whose validity is a property of `HEAD` is invalid
a quarter of the time by pure accident.

The deeper finding, measured the same day: the reviewed line was held by **nothing of its
own**. `f471ef3c0` and the 10-commit fork line beneath it were reachable from exactly one
ref — `refs/heads/tog-942-agent-model-picker`, an unrelated feature branch that merely
happened to be cut from the pin. No tag, no remote (that branch is unpushed), no ref of
its own. Delete or rebase that branch and `git gc` deletes the line.

That is **not** a lost deploy: the five scripts pinning that tree are all WITHDRAWN by the
no-fork ruling above. It is a lost **specification**. TOG-1010, the approved successor,
says in terms *"Do NOT delete this tree — it is the specification for the re-test"* and
maps 5 of those commits to the forked concerns to re-test on v2026.831.1. And the loss
would be permanent: this tree is a shallow `blob:none` partial clone whose promisor
remote never held the fork commits, so there is nowhere to re-fetch them from.

So the line is now a **name** that no checkout can move:

```bash
git -C <tree> update-ref refs/deploy-line/tog-516-governor f471ef3c0eae0034b4cf394d6b4ffe0a46f9e07a
```

A ref is a gc root; a branch someone else owns is not. The gate now prints the anchor as
its own row, decoupled from `HEAD`, from `MANIFEST`, and from `WITHDRAWN`:

```
[ok  ] deploy-line ANCHOR_OK   refs/deploy-line/tog-516-governor -> f471ef3c0
```

**The gate asserts the ref; it never creates it.** Self-healing would reduce the check to
*"can I write?"* and a genuinely lost line would read green forever — the same defect
class rejected for the drift guard in TOG-999.

| state | what it means | repair |
|---|---|---|
| `ANCHOR_MISSING` | no ref holds the line; a `gc` may already have taken it | run the `update-ref` the gate prints — it moves no branch and touches no working tree |
| `ANCHOR_MOVED` | the name survives, pointing at a *different* commit | do **not** assume equivalence; establish which commit is the reviewed line first |
| `ANCHOR_TREE_UNREADABLE` | the checkout itself could not be read | you are missing the **checkout**, not the ref — `update-ref` has nowhere to run |

A withdrawn window still requires its anchor. Every card that pinned this line is
withdrawn and the line still matters; coupling the two would delete the one case the
check exists for.

`verification/tog-997-deploy-line-anchor-gate.sh` holds the evidence: a two-arm premise
proof that a ref really is a gc root (arm A survives `gc --prune=now`; the **control**
arm, with the ref dropped, is deleted by the same collection — without it, "the commit
survived" is consistent with gc simply not having run), then 6 mutants of the check, each
required to be killed by its *named* test. It builds its own throwaway fixture and never
touches a staging tree, so it is safe to run mid-window.

## The reference is a git object, not a file (TOG-999)

The drift check originally resolved the reviewed side from the working tree, which made
both operands editable. It proved *these two copies agree*, not *the operator runs the
reviewed bytes*. Measured 2026-09-05:

| state | exit | caught? |
|---|---|---|
| host copy alone mutated | 1 | yes |
| **both copies mutated identically** | **0** | **no** |

This checkout is a shared workspace with concurrent sibling runs. A rebase, a stray
`git checkout`, or another card's run moves both sides at once and the guard stayed
green — the exact scenario it exists to catch. The original mutation test only ever
moved one side, so that mutant was never exercised.

The reviewed side is now read from a pinned, content-addressed blob that no edit to any
working tree can move, with both resulting false-green traps guarded explicitly: an
absent object writes zero bytes on its way to a non-zero exit (an empty reference hashes
to `e3b0c442…` and would otherwise compare as ordinary drift), and the extracted content
is asserted against a recorded sha256 constant.

`verification/tog-999-drift-pin-mutation-gate.sh` holds the evidence: 8 scenarios with
asserted exit codes, and 5 mutants of the check itself — including the original defect
reintroduced verbatim, which is killed by the correlated both-copies scenario.

### Updating the pin

When `deploy_window_manifest.py` is legitimately revised and re-reviewed, update
`PINNED_REV`, `PINNED_BLOB` and `PINNED_SHA256` in the drift check **together, in the
same commit as the revision**, then re-sync the handoff copy and re-run the mutation
gate. Updating the pin is a review action — it is the one edit that redefines what
these bytes are held to.
