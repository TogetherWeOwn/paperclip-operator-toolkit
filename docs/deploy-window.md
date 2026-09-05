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
