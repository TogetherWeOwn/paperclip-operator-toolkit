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
  Runnable means: the exec bit, OR a .sh/.bash/.py/.mjs/.cjs/.js extension, OR a shebang on line 1.
  Evidence documents are not runnable and are not covered by this rule.
  Check yourself before you drop: `./channel_drift.sh check` in a paperclip-ops-tooling clone.
  Exit 3 means something here was never reviewed. TOG-356.
- This directory is 1777. Any agent can overwrite another agent's staged file between the drop and
  the install, so the staged copy is never the integrity anchor — git is.

This README is itself covered by that rule. It is a mirror of `handoff-channel-README.md` on
`main`, and `channel_drift.sh check` fails if the copy you are reading is not that blob — so a
hand-edited or half-installed copy of these rules is a finding, not a silence. TOG-373.
