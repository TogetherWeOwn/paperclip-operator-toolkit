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
unversioned tool arrived (`TOG-352-register-cliproxy.sh`), and the original count had also missed
`TOG-196-identity-probe.mjs`, which is `0644` and so was never an "executable" by the `-x` test, but
is still run: `node TOG-196-identity-probe.mjs`.

That delta is the argument for a mechanical rule rather than a cleanup. **Hand cleanup loses to the
arrival rate.** Anything that has to be remembered, here, is not a control.

The one root-owned file, `REFERENCE-org_provisioner.sh`, is reported `STALE` — *behind* `main`, not
ahead. Where we have genuine inbound evidence, the import took and the repo then improved on it.
Ownership still tells you the direction: root-owned is the operator's, `node`-owned is an agent's.

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

## The channel's own README

`/paperclip/operator-handoff/README.md` is root-owned and only the operator can replace it. The
canonical text is below; the operator should install it from `origin/main` rather than from a copy
staged in the channel — the channel is `1777`, so a staged copy is agent-writable and cannot be its
own integrity anchor (TOG-310, TOG-349).

```markdown
# Operator handoff drop

Agents cannot write to the operator project root (~/paperclip-enterprise-company on the host). The
paperclip container mounts exactly one host path: ~/.local/share/paperclip -> /paperclip.

This directory IS on that mount. Anything written to /paperclip/operator-handoff/ appears on the
host at ~/.local/share/paperclip/operator-handoff/ where the operator can review, install and run it.

Rules:
- One file per deliverable, named for its issue: TOG-151-omniroute_combo_cli.sh
- NEVER write a secret here. Not 0600, and visible to every agent on this instance.
- Writing here is a proposal, not a deployment. The operator reviews before installing.
- A RUNNABLE file must be a MIRROR of something already committed to paperclip-ops-tooling `main`,
  byte for byte. Land the PR first, then drop the mirror, and quote the commit sha in the issue.
  Runnable means: the exec bit, OR a .sh/.py/.mjs/.js extension, OR a shebang on line 1.
  Evidence documents are not runnable and are not covered by this rule.
  Check yourself before you drop: `./channel_drift.sh check` in a paperclip-ops-tooling clone.
  Exit 3 means something here was never reviewed. TOG-356.
- This directory is 1777. Any agent can overwrite another agent's staged file between the drop and
  the install, so the staged copy is never the integrity anchor — git is.
```

## What this does not fix

Detection, not prevention. An agent that can write the channel can also edit `channel_exempt.txt`,
and nothing here stops a drop from being installed before anyone runs the check. What the rule buys
is that the swap has to be **loud**: a file that was never reviewed now has a name for that state,
a command that finds it, and a suite that stops the command from being quietly defanged.
