# The operator handoff channel: a drop is a mirror, not a source

`/paperclip/operator-handoff/` is how an agent hands a deliverable to the operator. Agents cannot
write to the operator's project root; the paperclip container mounts exactly one host path, and that
directory is on it. Anything written there appears on the host where the operator can review,
install and run it.

That is the whole value of the channel, and also the problem TOG-356 is about.

## What was measured

TOG-212 was filed as "the VPS copy drifted ahead of the repo". It had not. Measured 2026-08-24, the
drift was **outbound**: agents write tools into the channel, the operator installs from there, and
they never become a PR — so there is no review, no history and no rollback for code running on the
VPS. 9 of the 11 executables in the channel existed in no git repo at all.

Re-measured 2026-08-25 with `channel_drift.sh`, against `origin/main` at `205635c`:

```
mirrored: 2   stale: 1   unversioned: 11   exempt: 0
```

**11 of 14**, not 9 of 11. The channel got worse in the intervening day, not better — one new
unversioned registration tool arrived, and the original count had also missed
`TOG-196-identity-probe.mjs`, which is `0644` and so was never an "executable" by the `-x` test, but
is still run: `node TOG-196-identity-probe.mjs`.

That delta is the argument for a mechanical rule rather than a cleanup. **Hand cleanup loses to the
arrival rate.** Anything that has to be remembered, here, is not a control.

The one root-owned file, `REFERENCE-org_provisioner.sh`, is reported `STALE` — *behind* `main`, not
ahead. Where we have genuine inbound evidence, the import took and the repo then improved on it.
Ownership still tells you the direction: root-owned is the operator's, `node`-owned is an agent's.

### Re-measured 2026-08-25, later the same day (TOG-373)

Against `origin/main` at `24f0d30`:

```
mirrored: 6   stale: 1   unversioned: 3   exempt: 0
```

Eight of the eleven violations closed inside a day, because TOG-371 landed the OmniRoute operator
tools as PRs and the drops then matched committed blobs without anyone touching the channel. That is
the rule working in the direction it was meant to: the fix for an unversioned drop is a merge, not a
deletion, and content-addressing means the drop goes green the moment the review lands.

The three that remain — `TOG-151-dropchannel_scan.sh`, `TOG-178-apply.sh`,
`TOG-196-identity-probe.mjs` — are still unreviewed code an operator can run, and `STALE` is still
`REFERENCE-org_provisioner.sh`. **These counts move; do not quote them as current.** Run the check.

### The last three (TOG-372)

Those three were the CISO's own, and TOG-372 resolved them: two landed, one was deleted. The split
used TOG-371's two questions — *is there a live consumer*, and *does a byte-identical copy survive
anywhere else* — and the interesting result is that **not one byte was written to the channel.**

- `dropchannel_scan.sh` **landed unchanged.** It is the channel's other control (see below).
- `omniroute/TOG-178-apply.sh` **landed unchanged**, deliberately — its SHA-256 manifest is published
  in the TOG-178 thread and gates the operator's run. `omniroute/README.md` has the full argument.
- `TOG-196-identity-probe.mjs` **was deleted.** It could not do its job here: registering it fails at
  `422 remote_http_private_endpoint` before it observes anything, so it was staged code that had
  never run and never could. Its question was answered from the other direction, in-process against
  the real gateway, as a regression test rather than a one-off — and `docs/transport-identity.md`
  had already recommended deleting it "along with `whoami_spoof`", the argument-supplied identity
  control that must never exist outside a probe. Nothing unique was lost; the design carried into
  `mcp/org-request-mcp.mjs`, and the runbook stays in the channel as evidence.

Both landings were compliant the moment the PR merged, because compliance is content-addressed and
the committed blob *is* the staged file. That is the cheapest possible version of this rule, and it
is only available if you resist editing the file on its way in.

## The channel's second control: is anything staged here a *credential*?

`channel_drift.sh` asks whether a staged file was ever reviewed. `dropchannel_scan.sh` (TOG-151) asks
whether it is a secret. The channel is world-readable to every agent on the box, so a credential
written here is disclosed instance-wide the moment it lands — and the sticky bit does not help,
because 47 of 55 files are owned by uid 1000 and *every agent is uid 1000*.

```bash
./dropchannel_scan.sh scan --root /paperclip/operator-handoff
./dropchannel_scan.sh selftest        # what CI runs
```

Exit `0` clean · `1` a hit · `2` refused. It never prints a matched value — findings carry a rule id,
a length and a fingerprint prefix, because a scanner that echoes the secret it found turns a cron
mail into a second copy of the leak. It never follows a symlink, and it fails **closed**: an
unreadable or oversized file is a `FAIL`, never a silent skip.

Measured 2026-08-25: **1 FAIL, 8 REVIEW** across 55 files. The `FAIL` is a false positive — the
`secret-assignment` rule firing on `x-api-key : http=200`, a row in a probe *result* table — filed as
its own issue rather than tuned inline, because loosening a credential rule to quiet one line is how
these controls stop working. The channel-level `REVIEW` is not a false positive and cannot be fixed
from inside the channel: the only integrity control for a file here is comparing its SHA-256 against
a value published in a Paperclip thread before trusting it. That is exactly what TOG-178's manifest
is for, and why it was worth protecting.

As with `channel_drift.sh`, **CI green never means the channel is clean** — Actions has no view of
`/paperclip`. Green means the detector works. Run the scan where the channel is mounted.

## The rule

> **A runnable file in the handoff channel must be byte-identical to a blob committed on `main`.**

Runnable is a union of three tests, because each alone has a hole:

| test | catches | misses |
|---|---|---|
| exec bit | anything the operator can `./x` | `TOG-196-identity-probe.mjs`, which is `0644` |
| script extension | that | anything named to look like evidence |
| shebang on the first line | that — `bash TOG-nnn-findings.md` still runs it | nothing that matters |

Compliance is judged on **content, not path**. A drop named `TOG-151-omniroute_combo_cli.sh` whose
bytes are the committed `omniroute_combo_cli.sh` is compliant. The repo may rename or move its own
files without breaking it; changing one byte breaks it immediately.

Evidence documents — findings, runbooks, JSON captures — are *not* runnable and are not covered.
The channel is still the right place for them.

## Checking it

```bash
./channel_drift.sh check                 # against main, the default channel path
./channel_drift.sh check --ref origin/main
./channel_drift.sh check --strict        # also fails while any exemption is open
```

Exit `0` clean · `2` refused · `3` unversioned or stale artifacts found.

Unlike `tool_drift.sh`, this needs no operator and no split: the channel and a clone are both
visible from any agent container, so any agent can run it on itself before dropping a file.

### What CI does and does not prove

CI runs `test_channel_drift.sh`, which proves the **detector** works — including four mutation gates
that each require a *named* assertion to go red, so the suite cannot be quietly gutted. CI cannot run
`channel_drift.sh check`: GitHub Actions has no view of `/paperclip`. **A green build never means the
channel is clean.** Run the check where the channel is mounted.

### Why not `tool_drift.sh compare --strict`

TOG-356 proposed pointing the existing tool at the channel. Measured before writing the new one, it
does not work, in both directions at once:

1. `compare` matches on **path**. Channel drops are named for their issue, so every drop reports
   `UNVERSIONED` — including the two that are byte-identical to a committed blob. A detector that
   fires on the compliant files is noise.
2. `--strict` fails when the ref holds files the source does not. The channel is a deliberate
   **subset** of the repo — 14 artifacts against 86 tracked blobs — so it would emit ~70 permanent
   `NOT DEPLOYED` lines and never go green. `tool_drift.sh`'s own header says why that is fatal:
   *"a drift detector that cries wolf gets muted — at which point it is indistinguishable from a
   deleted one."*

The two tools answer different questions and both are worth having. `tool_drift.sh` is inbound: did
the running copy move? `channel_drift.sh` is outbound: was the staged copy ever reviewed?

## Exemptions

`channel_exempt.txt` lists basenames the check may pass without a matching blob. **A reason is
mandatory** — an entry without one is refused (exit 2), not honoured, because an unreasoned
exemption is indistinguishable from someone silencing the detector. `--strict` fails while any entry
is open, so a release can refuse to ship with a hole in the rule.

The file ships empty on purpose. Pre-populating it with the 11 current violations would convert the
finding into paperwork.

## The channel's own README (TOG-373)

The rule above is only worth what it changes about behaviour, and an agent about to drop a file is
not reading this document — they are reading `/paperclip/operator-handoff/README.md`, which is
root-owned `0644` in a `1777` directory. Measured: an agent cannot write it, cannot unlink it and
cannot rename it (the sticky bit), so installing it is the operator's step and nobody else's.

**The canonical text is a committed file, `handoff-channel-README.md` — not a fenced block in this
document.** It used to be a fence here, which made "install it from `origin/main`" mean "hand-extract
twenty lines out of a code fence", and left two copies of the same text to drift apart. Both are the
failure this whole document is about, in miniature.

### Installing it

Two commands, from a clone, as the operator. Neither reads anything staged in the channel — the
channel is `1777`, so a copy staged there is agent-writable and cannot be its own integrity anchor
(TOG-310, TOG-349). `git show` reads the blob out of the object store, so what lands is the reviewed
bytes or nothing:

```bash
git -C <clone> fetch origin
git -C <clone> show origin/main:handoff-channel-README.md \
  | sudo tee /paperclip/operator-handoff/README.md >/dev/null

# and the one genuinely inbound artifact, which channel_drift.sh reports STALE:
git -C <clone> show origin/main:org_provisioner.sh \
  | sudo tee /paperclip/operator-handoff/REFERENCE-org_provisioner.sh >/dev/null
```

### Why it has a receipt now

The README is not runnable by any of the three tests, so the sweep would never have looked at it —
the one artifact in the channel whose entire content is the byte-for-byte rule was the one artifact
with nothing checking it. A hand-retyped, truncated or simply never-installed copy read as clean.

`channel_drift.sh` now carries a short `REQUIRED_MIRRORS` table: files that must be **present** in
the channel and **byte-identical** to one named path, runnable or not. Absence is a finding, because
for this file absence is the whole failure mode. `./channel_drift.sh check` reports `MISSING` until
the install happens and `NOT THE COMMITTED COPY` if what is installed is not that blob — so running
the check is the receipt for the install, and there is no step here that rests on trust.

If the repo ever renames `handoff-channel-README.md` without updating the table, the check
**refuses** (exit 2) rather than rendering a verdict. That is TOG-357's rule applied here: a
comparison that did not happen must never read as an answer.

## The MCP install runbook (TOG-369)

The second entry in that table, and the case that shows the runnable test has a blind spot the
README's does not.

`TOG-196-mcp-install-runbook.md` was a `.md` file with no shebang and no exec bit, so it was not
runnable by any of the three tests and the sweep never saw it. It was also the only copy in
existence — the *instructions* for a root install, telling the operator which files to trust, which
assertions count as a pass, and when to stop. Rewriting it is a cheaper attack than rewriting any
script it names, and it had already been silently wrong once: an early revision told the operator
to write the bearer to `/etc/caddy/org-request-mcp.bearer`, which nothing read (corrected under
TOG-341). Step 9 also carried an assertion that could not catch the bug it targeted (TOG-365).

So the runbook moved into the repo, at `mcp/deploy/install-runbook.md`, and the channel keeps a
**pointer** — `mcp/deploy/install-runbook-handoff-pointer.md`, listed in `REQUIRED_MIRRORS`. That
choice matters: with the pointer required, replacing it with *anything*, including a plausible full
copy of the runbook, reports as `NOT THE COMMITTED COPY`. Had the channel kept a full mirror
instead, a subtly edited copy would still be caught, but only by reading a 400-line diff rather
than by noticing that a signpost had turned into a document.

The general rule this generalises to: **a document that tells the operator what to trust needs a
tamper-evident home at least as much as the artifacts it names.** The runnable-file sweep will not
find those documents. They have to be named.

## What this does not fix

Detection, not prevention. An agent that can write the channel can also edit `channel_exempt.txt`,
and nothing here stops a drop from being installed before anyone runs the check. What the rule buys
is that the swap has to be **loud**: a file that was never reviewed now has a name for that state,
a command that finds it, and a suite that stops the command from being quietly defanged.
