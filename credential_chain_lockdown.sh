#!/usr/bin/env bash
# Close the agent-writable git credential-helper chain.
#
# PROPOSAL, not a deployment.  Review before running, as root, from the git
# checkout that holds this file:
#   <path-to-this-checkout>/credential_chain_lockdown.sh
#
#   --dry-run   print the plan and the current state, change nothing (default)
#   --apply     make the changes
#   --apply --i-have-verified-this-copy   skip the provenance refusal below
#   --verify    re-run the audit as the agent uid and report
#
# HOST-EXECUTION-ONLY.  Every path below defaults under the agent HOME and the
# probes run as the agent uid (CREDENTIAL_AUDIT_USER, default: node).
# --apply and --verify refuse unless run as root; --dry-run changes nothing.
# Outside the intended host, re-point the CREDENTIAL_* paths and
# CREDENTIAL_AUDIT_USER at the local layout first -- or do not run this.
#
# ---------------------------------------------------------------------------
# RUN THIS FROM THE GIT CHECKOUT, NOT FROM A STAGED COPY
#
# The first draft of this script was staged at an agent-writable handoff path
# and the operator was asked to run THAT as root.  That was a mistake, and a
# worse one than the finding this script fixes.  Measured 2026-08-24 as an
# ordinary agent uid:
#
#   <handoff dir>        root:root   1777   (world-writable, sticky)
#   <handoff>/apply.sh   agent:agent 0755   -- agent-OWNED
#   test -w <handoff>/apply.sh      -> true
#
# Sticky stops you deleting someone else's file; it does not stop you deleting
# your own, and every agent runs as the same uid.  So any agent could have
# rewritten that file at any point between staging and execution -- and it
# executes as ROOT.  A substitutable helper is an agent -> agent escalation;
# asking the operator to root-run an agent-writable script is agent -> root,
# which is strictly worse than the bug.
#
# So this file is canonical HERE, in git, where a change needs a reviewed PR.
# Any copy staged outside git is a convenience mirror and is not trusted.
# `credential_chain_audit.sh --staged` compares the two and reports DRIFT.
#
# Refusing to trust its own location is not paranoia for its own sake: the whole
# premise of this hardening is that agent-writable paths in a privileged
# execution path are the vulnerability.  This script is in a privileged
# execution path.
#
# ---------------------------------------------------------------------------
# WHY THIS IS LONGER THAN THE FOUR COMMANDS IN THE ORIGINAL REPORT
#
# The original report asked for chown/chmod on the helper file and its
# directory.  That is correct and necessary, and it is not sufficient: it
# closes one of four ways to get code into the chain.  git runs a helper named
# by ANY config file it reads, so a writable config is worth exactly as much
# to an attacker as a writable helper.  Measured on the original host
# 2026-08-24 as the agent uid (paths shown as their CREDENTIAL_* defaults):
#
#   1. $HOME/.local/bin/gh-app-token.js   agent-owned   -- the filed finding
#   2. $HOME/.local/bin                   agent-owned   -- the filed finding
#   3. $HOME/.gitconfig                   agent-owned   -- NOT in the report
#   4. $HOME/.config/git/config           creatable     -- NOT in the report
#
# Link 3 alone reduces the whole fix to theatre.  With the helper locked down,
# any agent still runs one command:
#
#   git config --global credential."https://github.com".helper '!/tmp/mine.js'
#
# and every agent's next git call executes /tmp/mine.js and hands it a token.
# Link 4 is the same move via git's other global config, which does not exist
# yet -- `mkdir -p` creates it, and "the file isn't there" is not a boundary.
#
# THE PART THAT IS EASY TO GET WRONG:
#
# chown-ing a file inside an agent-owned directory does not protect it.  Unlink
# and rename are governed by the *directory's* write bit, not the file's, so
# the agent uid can rename a root-owned $HOME/.gitconfig aside and drop in its
# own.  The agent HOME was drwxrwxr-x agent-owned, so the obvious
# `chown root:root $HOME/.gitconfig` on its own accomplishes nothing.
#
# The directory has to hold too.  Rather than take write access to HOME away
# from every tool that legitimately creates dotfiles there, this uses the
# /tmp-semantics model: root-owned + sticky + world-writable (drwxrwxrwt).
# New entries can still be created by anyone; root-owned entries cannot be
# removed or renamed by anyone but root.  That keeps the blast radius of this
# change to "agents can no longer delete root's dotfiles", which is the intent.
#
# If you would rather not have a world-writable HOME, the stricter alternative
# is `chmod 1755` on HOME -- but that stops agents creating any new entry
# directly in HOME, which will break tools that expect to write ~/.something.
# Sticky alone is not an option: the agent uid currently OWNS HOME, and owning
# the directory overrides the sticky restriction.
#
# THE GRANDPARENT DIRECTORY, LINK 5
#
# Fixing links 1-2 above (helper + its immediate directory) is not the end of
# the chain either: it just moves the same "directory has to hold too" problem
# up one level, onto the *grandparent*. Re-measured 2026-08-31: after links 1-2
# were applied, the helper and its directory were both root:root -- but their
# parent ~/.local itself was still agent-owned 0755.  Renaming bin aside and
# dropping in a substitute needs only write+execute on ~/.local, which the
# agent uid had.  Demonstrated live against a copy of the affected host, then
# restored -- not theorised.
#
# The instinctive fix -- `chmod +t` on the parent -- was tried live and DOES
# NOT WORK, for the same reason chmod +t was never proposed for HOME in
# step 4: the agent uid OWNS that parent, and a sticky bit never restricts the
# directory's own owner, only other principals.  Every agent runs as that uid,
# so "restricts everyone except the owner" restricts nobody.  Tested:
# `mv bin bin.evil` still succeeded under 1755 agent-owned exactly as it did
# under 0755.  Only a change of OWNER closes it, matching the audit script's
# own `dir_allows_replace`: `[[ "$o" == "$AS_UID" ]] && return 0  # dir owner
# ignores sticky`.
#
# Unlike HOME (step 4), ~/.local does not need to stay writable for new
# top-level entries by convention -- `bin`, `share` and `state` are the fixed,
# known set (package-manager, tooling and font state live under share/state
# and are unaffected by an ownership change on the parent; they keep their own
# agent ownership and stay writable).  So this uses the plain chown, not the
# /tmp-semantics 1777 model:
#
#   chown root:root ~/.local   (mode stays 0755)
#
# This does not take away the agent's ability to write INSIDE share/ or
# state/ -- only the ability to rename/replace THEIR OWN NAMES or bin's name
# within .local.  If a future tool needs to create a new top-level directory
# under .local at runtime (not observed as of this fix), that will start
# failing and is the signal to revisit -- not a reason to leave the
# grandparent open now.
#
# WHAT THIS DELIBERATELY DOES NOT FIX
#
# Per-repository .git/config is agent-owned by necessity -- agents have to
# configure their own checkouts.  It is a hole only between agents sharing one
# checkout, which is the same trust boundary as the shared working tree itself,
# and it cannot be closed by ownership without breaking normal work.  Recorded
# as residual risk rather than silently dropped.
#
# ORDER OF OPERATIONS
#
# Every change here is chown/chmod on an existing inode.  Nothing is deleted and
# nothing is rewritten, so unlike the 03:31 incident there is no window in which
# git has no helper.  The script is idempotent; re-running it is a no-op.
# ---------------------------------------------------------------------------

set -uo pipefail

MODE="dry-run"
VERIFIED_COPY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)   MODE="apply";   shift ;;
    --verify)  MODE="verify";  shift ;;
    --dry-run) MODE="dry-run"; shift ;;
    --i-have-verified-this-copy) VERIFIED_COPY=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Every host path is overridable for a host that lays them out differently.
# Defaults describe the agent container this was written for ($HOME is the
# agent HOME there).  Point CREDENTIAL_BACKUP_DIR outside any agent-writable
# tree: the backup exists to survive exactly the substitution this closes.
# Placed before the provenance gate below, which already needs AUDIT_USER.
HOME_DIR="${CREDENTIAL_HOME_DIR:-${HOME:-}}"
HELPER="${CREDENTIAL_HELPER:-$HOME_DIR/.local/bin/gh-app-token.js}"
HELPER_DIR="${CREDENTIAL_HELPER_DIR:-$HOME_DIR/.local/bin}"
LOCAL_DIR="${CREDENTIAL_LOCAL_DIR:-$HOME_DIR/.local}"
GITCONFIG="${CREDENTIAL_GITCONFIG:-$HOME_DIR/.gitconfig}"
XDG_DIR="${CREDENTIAL_XDG_DIR:-$HOME_DIR/.config}"
XDG_GIT="${CREDENTIAL_XDG_GIT_DIR:-$HOME_DIR/.config/git}"
BACKUP_DIR="${CREDENTIAL_BACKUP_DIR:-$HOME_DIR/credential-chain-backups}"
AUDIT_USER="${CREDENTIAL_AUDIT_USER:-node}"
[[ -n "$HOME_DIR" ]] || { echo "ERROR: cannot resolve a home directory: set HOME or CREDENTIAL_HOME_DIR" >&2; exit 2; }

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
SELF_SHA="$(sha256sum "$SELF" 2>/dev/null | awk '{print $1}')"

# Refuse to root-execute a copy of ourselves that an agent uid could have
# rewritten -- see the RUN THIS FROM THE GIT CHECKOUT header.
#
# Note honestly what this can and cannot do.  EVERY copy of this file inside the
# container is owned by the agent uid, including the git checkout, because
# agents own their own checkouts.  So this gate fires essentially always and cannot be
# satisfied by moving the file somewhere "safe" -- there is no such place on
# this filesystem.  That is the point.  The integrity anchor is not the
# filesystem, it is git: a blob that matches a reviewed commit on origin/main
# has been through a PR, and a working-tree file that matches that blob is that
# reviewed script.  The gate exists to make the operator perform that check
# rather than to pretend a mode bit performed it for them.
self_is_agent_writable() {
  local st o m
  st="$(stat -L -c '%u %a' "$SELF" 2>/dev/null)" || return 0   # cannot tell => refuse
  read -r o m <<<"$st"
  local agent_uid; agent_uid="$(id -u "$AUDIT_USER" 2>/dev/null || echo -1)"
  [[ "$o" == "$agent_uid" ]] && return 0
  m="$(printf '%03d' "$((10#$m % 1000))")"
  [[ "${m:2:1}" =~ [2367] ]] && return 0
  return 1
}

if [[ "$MODE" == "apply" && $VERIFIED_COPY -eq 0 ]] && self_is_agent_writable; then
  cat >&2 <<EOF

REFUSING TO APPLY: this script is writable by the agent uid, and --apply runs as root.

  script : $SELF
  owner  : $(stat -L -c '%U:%G %a' "$SELF" 2>/dev/null)
  sha256 : ${SELF_SHA:-<unreadable>}

Any agent could have rewritten it since it was staged. Verify it against git --
that is the only tamper-evident record here -- then re-run:

  git -C "$(dirname "$SELF")" fetch origin
  git -C "$(dirname "$SELF")" diff --stat origin/main -- credential_chain_lockdown.sh   # expect: empty
  git -C "$(dirname "$SELF")" log --oneline -1 origin/main -- credential_chain_lockdown.sh

If the diff is empty, the file is the reviewed version on origin/main. Then:

  $SELF --apply --i-have-verified-this-copy

EOF
  exit 2
fi

# (Host paths are defined up top, before the provenance gate.)
say()  { printf '  %s\n' "$*"; }
hdr()  { printf '\n\033[1m%s\033[0m\n' "$*"; }

show_state() {
  hdr "Current state"
  for p in "$HOME_DIR" "$GITCONFIG" "$XDG_DIR" "$XDG_GIT" "$XDG_GIT/config" "$LOCAL_DIR" "$HELPER_DIR" "$HELPER"; do
    if [[ -e "$p" ]]; then
      printf '  %-40s %s\n' "$p" "$(stat -c '%A %U:%G' "$p")"
    else
      printf '  %-40s %s\n' "$p" "(absent)"
    fi
  done
}

verify_as_node() {
  hdr "Verification (as $AUDIT_USER, which is what every agent is)"
  local rc_w=0
  # Fail closed outside the intended host: without the agent uid or a way to
  # become it, every probe below would fail and read as "refused".
  id -u "$AUDIT_USER" >/dev/null 2>&1 \
    || { say "REFUSING: no such user $AUDIT_USER (set CREDENTIAL_AUDIT_USER)"; return 2; }
  command -v runuser >/dev/null 2>&1 \
    || { say "REFUSING: runuser not found; cannot probe as $AUDIT_USER"; return 2; }
  # The direct question: can an unprivileged agent still substitute any link?
  for p in "$HELPER" "$GITCONFIG"; do
    if runuser -u "$AUDIT_USER" -- test -w "$p" 2>/dev/null; then
      say "STILL WRITABLE: $p"; rc_w=1
    else
      say "ok, not writable by $AUDIT_USER: $p"
    fi
  done
  # Rename/replace, which the write test above does not cover.
  for d in "$HELPER_DIR" "$HOME_DIR" "$XDG_GIT"; do
    [[ -d "$d" ]] || continue
    if runuser -u "$AUDIT_USER" -- sh -c "touch '$d/.chain-probe' 2>/dev/null" ; then
      say "STILL ACCEPTS NEW FILES: $d"
      rm -f "$d/.chain-probe"
      # For HOME this is intended (sticky), so only flag the ones that matter.
      case "$d" in "$HELPER_DIR"|"$XDG_GIT") rc_w=1 ;; esac
    else
      say "ok, refuses new files: $d"
    fi
  done
  if runuser -u "$AUDIT_USER" -- sh -c "mv '$GITCONFIG' '$GITCONFIG.probe' 2>/dev/null"; then
    say "STILL RENAMEABLE: $GITCONFIG -- restoring"
    mv "$GITCONFIG.probe" "$GITCONFIG"; rc_w=1
  else
    say "ok, $AUDIT_USER cannot rename $GITCONFIG out of the way"
  fi

  # The grandparent attack -- can the agent uid rename the root-owned helper
  # dir aside within its (formerly agent-owned) parent? A touch-new-file probe
  # on LOCAL_DIR would not catch this: LOCAL_DIR staying non-writable to new
  # files is necessary but not sufficient, because rename of an EXISTING entry
  # the agent does not own is governed by the same write bit, not a separate
  # one.
  if [[ -d "$HELPER_DIR" ]]; then
    if runuser -u "$AUDIT_USER" -- sh -c "mv '$HELPER_DIR' '$HELPER_DIR.chain-probe' 2>/dev/null"; then
      say "STILL RENAMEABLE: $HELPER_DIR out of $LOCAL_DIR -- restoring"
      mv "$HELPER_DIR.chain-probe" "$HELPER_DIR"; rc_w=1
    else
      say "ok, $AUDIT_USER cannot rename $HELPER_DIR out of $LOCAL_DIR"
    fi
  fi

  # And the full chain audit.  Only the copy sitting next to this script is
  # used.  The first version searched an agent-writable checkout tree for
  # credential_chain_audit.sh and ran the first match, which picks an arbitrary
  # agent's checkout out of a directory tree that agents write to -- i.e. it
  # chose the program to execute by the same mechanism this whole hardening is
  # about.  It ran as the agent uid rather than root so it was not an
  # escalation, but "pick an executable out of an agent-writable tree" is not
  # a habit to keep in the script whose job is to stamp that habit out.
  local audit="$(dirname "$SELF")/credential_chain_audit.sh"
  if [[ -x "$audit" ]]; then
    hdr "Full chain audit (standing check)"
    runuser -u "$AUDIT_USER" -- "$audit"
    local arc=$?
    say "audit exit: $arc  (0 = clean, 1 = hole remains, 3 = indeterminate)"
    # Fold it in.  The first version printed this number and returned $rc_w
    # regardless, so --verify could print "All probes refused" as its verdict
    # while the audit immediately above it reported a hole.  The handful of
    # probes in this function cover the two helper links the original report filed;
    # covers all four plus PATH.  Letting the narrow check overrule the broad
    # one is how a clean report gets issued for a chain that is still open.
    [[ $arc -ne 0 ]] && rc_w=1
  else
    say "credential_chain_audit.sh not found next to this script -- chain NOT fully verified"
    rc_w=1
  fi
  return $rc_w
}

if [[ "$MODE" == "verify" ]]; then
  [[ "$(id -u)" == "0" ]] || { echo "must run as root" >&2; exit 2; }
  show_state; verify_as_node; exit $?
fi

show_state

hdr "Plan"
cat <<PLAN
  1. back up the live helper OUTSIDE the agent-writable directory
       -> $BACKUP_DIR/gh-app-token.js.<sha>
     (the .bak-20260823 copy was lost with the file it existed to protect,
      because it lived in the directory that got cleared)

  2. root-own the helper and its directory        [the filed finding]
       chown root:root $HELPER $HELPER_DIR
       chmod 0755      $HELPER $HELPER_DIR

  2a. root-own the helper's PARENT directory      [grandparent, not in the original report]
       chown root:root $LOCAL_DIR
       chmod 0755      $LOCAL_DIR
      (share/ and state/ under it keep their own agent ownership and stay
       writable; only the ability to rename bin/, share/, state/ out of
       LOCAL_DIR is removed)

  3. root-own the global config                   [not in the report]
       chown root:root $GITCONFIG
       chmod 0644      $GITCONFIG

  4. make HOME hold that file against rename      [not in the report]
       chown root:root $HOME_DIR
       chmod 1777      $HOME_DIR      # drwxrwxrwt, /tmp semantics

  5. deny the second global config path           [not in the report]
       chown root:root $XDG_DIR ; chmod 1777 $XDG_DIR
       install -d -o root -g root -m 0755 $XDG_GIT
       install    -o root -g root -m 0644 /dev/null $XDG_GIT/config

  6. verify as the agent uid -- expected: every probe refused
PLAN

if [[ "$MODE" == "dry-run" ]]; then
  printf '\n  Dry run. Re-run with --apply to make these changes.\n\n'
  exit 0
fi

[[ "$(id -u)" == "0" ]] || { echo "ERROR: --apply must run as root" >&2; exit 2; }

hdr "Applying"

# 1 -- backup first, before anything else can go wrong
if [[ -f "$HELPER" ]]; then
  install -d -o root -g root -m 0755 "$BACKUP_DIR"
  sha="$(sha256sum "$HELPER" | cut -c1-12)"
  dest="$BACKUP_DIR/gh-app-token.js.$sha"
  if [[ -e "$dest" ]]; then
    say "backup already present: $dest"
  else
    install -o root -g root -m 0644 "$HELPER" "$dest"
    say "backed up live helper -> $dest"
  fi
else
  say "WARNING: $HELPER does not exist right now -- nothing to back up."
  say "         That is the empty-helper failure mode. Restore the helper"
  say "         from its reviewed source in git before continuing."
fi

# 2 -- the filed finding
if [[ -e "$HELPER" ]]; then
  chown root:root "$HELPER"    && chmod 0755 "$HELPER"     && say "locked $HELPER"
fi
chown root:root "$HELPER_DIR"  && chmod 0755 "$HELPER_DIR" && say "locked $HELPER_DIR"

# 2a -- the grandparent. Root-owning HELPER and HELPER_DIR is not sufficient
# while their PARENT stays agent-owned -- the agent uid can still rename
# HELPER_DIR aside within an agent-owned LOCAL_DIR and substitute its own.
# chmod +t alone does not fix this: the agent OWNS LOCAL_DIR, and a
# directory's owner is never restricted by its own sticky bit (see header).
# Plain chown
# is used, not the 1777 /tmp-semantics model from step 4, because LOCAL_DIR's
# top-level entries (bin, share, state) are a fixed set, not an
# every-tool-creates-its-own-dotfile location the way HOME is.
if [[ -e "$LOCAL_DIR" ]]; then
  chown root:root "$LOCAL_DIR" && chmod 0755 "$LOCAL_DIR" && say "locked $LOCAL_DIR (root-owned; share/ and state/ beneath it keep their own ownership)"
else
  say "WARNING: $LOCAL_DIR does not exist -- nothing to lock, but re-check HELPER_DIR's actual parent"
fi

# 3 -- the global config that selects the helper
if [[ -e "$GITCONFIG" ]]; then
  chown root:root "$GITCONFIG" && chmod 0644 "$GITCONFIG"  && say "locked $GITCONFIG"
else
  say "WARNING: $GITCONFIG absent -- git has no credential helper configured."
fi

# 4 -- HOME, so that link 3 cannot simply be renamed aside
chown root:root "$HOME_DIR"    && chmod 1777 "$HOME_DIR"   && say "locked $HOME_DIR (root-owned, sticky, still writable for new entries)"

# 5 -- git's other global config location
chown root:root "$XDG_DIR"     && chmod 1777 "$XDG_DIR"    && say "locked $XDG_DIR"
install -d -o root -g root -m 0755 "$XDG_GIT"              && say "created root-owned $XDG_GIT"
[[ -e "$XDG_GIT/config" ]] || install -o root -g root -m 0644 /dev/null "$XDG_GIT/config"
chown root:root "$XDG_GIT/config" && chmod 0644 "$XDG_GIT/config" && say "placeholder $XDG_GIT/config is root-owned"

# 6
show_state
verify_as_node
rc=$?

hdr "Result"
if [[ $rc -eq 0 ]]; then
  say "All probes refused. The credential chain is no longer agent-substitutable."
  say "Residual, by design: per-repo .git/config in shared checkouts (see header)."
else
  say "At least one probe still succeeded -- see STILL_* lines above. Do not consider the chain closed."
fi
exit $rc
