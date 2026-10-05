#!/usr/bin/env bash
# Audits every link in git's credential-helper resolution chain for
# substitutability by an ordinary agent uid.
#
# The thing being defended: the agent HOME's global gitconfig makes every
# agent's git call execute a helper program, and that program is handed a live
# GitHub token by design.  Anyone who can choose or rewrite that program has
# arbitrary code execution inside every other agent's git path.  Every agent
# shares one uid, so "another agent" and "this agent" are the same principal
# to the kernel.
#
# The original report covered one link -- the helper file and its directory.
# That is not the whole chain.  git will run a helper named by ANY config file it
# reads, so a writable *config* is worth exactly as much to an attacker as a
# writable *helper*, and a config file that does not exist yet but can be
# created is worth the same again.  This script enumerates all of them.
#
# Two rules drive every verdict, and both are easy to get wrong:
#
#   1. Owning a file is equivalent to having write permission on it, because the
#      owner can chmod at will.  `chmod 0444` on a node-owned file is not a fix
#      and this script does not score it as one.
#
#   2. Unlink and rename are governed by the *parent directory's* write bit, not
#      the file's.  A root-owned file inside an agent-writable directory can be
#      renamed aside and replaced.  So root-owning a file is only a fix if its
#      directory is also out of reach.  The sticky bit narrows this to
#      "you may only remove what you own" -- which is no help when the attacker
#      owns the file, as they do in an agent-owned helper directory today.
#
# Exit codes:
#   0  no substitutable link found, and every helper is the expected build
#   1  at least one HOLE -- the audited uid can get code into the chain
#   2  usage or internal error
#   3  INDETERMINATE or partial -- something could not be established
#
# 3 exists so that this never fails open.  An audit that cannot read a config
# file has not proven that file safe, and must not exit 0 alongside the clean
# ones.  (A prior gate learned this the hard way: it printed "no residue"
# and exited 0 after dying on an oversized board.)

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# All three resolve from the environment first so this runs on hosts that lay
# the chain out differently.  The pin file is intentionally NOT shipped: it
# names reviewed helper builds.  Point CREDENTIAL_CHAIN_PINS at a reviewed
# copy; without one every helper hashes INDETERMINATE (fail-closed), never OK.
AS_USER="${CREDENTIAL_CHAIN_AS_USER:-node}"
PINS="${CREDENTIAL_CHAIN_PINS:-$HERE/credential_chain_pins.txt}"
HOME_DIR="${CREDENTIAL_CHAIN_HOME:-${HOME:-}}"
if [[ -z "$HOME_DIR" ]]; then
  echo "ERROR: cannot resolve a home directory: set HOME, CREDENTIAL_CHAIN_HOME, or --home" >&2
  exit 2
fi
SYSTEM_CFG="${GIT_CONFIG_SYSTEM:-/etc/gitconfig}"
REPO_DIR=""
FORMAT="text"
QUIET=0

HOLES=0
INDET=0
declare -a ROWS=()   # verdict<TAB>scope<TAB>path<TAB>detail

usage() {
  cat <<'EOF'
Usage: credential_chain_audit.sh [options]

  --as-uid NAME     principal whose substitution power is measured (default: $CREDENTIAL_CHAIN_AS_USER or node)
  --home DIR        HOME to resolve the global configs under (default: $CREDENTIAL_CHAIN_HOME or $HOME)
  --system FILE     system gitconfig path (default: /etc/gitconfig)
  --repo DIR        also audit this repository's local config (default: none)
  --pins FILE       expected/reviewed helper hashes (default: $CREDENTIAL_CHAIN_PINS or ./credential_chain_pins.txt)
  --staged          also check staged root-run scripts against their repo source
  --staged-manifest FILE  manifest for --staged (default: ./staged_root_scripts.txt)
  --check-path P    audit substitutability of one path and exit; no chain walk
  --json            machine-readable output
  --quiet           suppress the table; exit code only
  -h, --help        this text

Exit: 0 clean | 1 hole found | 2 error | 3 indeterminate/partial
EOF
}

CHECK_PATH=""
STAGED=0
STAGED_MANIFEST="$HERE/staged_root_scripts.txt"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --as-uid)     AS_USER="${2:?}"; shift 2 ;;
    --home)       HOME_DIR="${2:?}"; shift 2 ;;
    --system)     SYSTEM_CFG="${2:?}"; shift 2 ;;
    --repo)       REPO_DIR="${2:?}"; shift 2 ;;
    --pins)       PINS="${2:?}"; shift 2 ;;
    --staged)     STAGED=1; shift ;;
    --staged-manifest) STAGED_MANIFEST="${2:?}"; STAGED=1; shift 2 ;;
    --check-path) CHECK_PATH="${2:?}"; shift 2 ;;
    --json)       FORMAT="json"; shift ;;
    --quiet)      QUIET=1; shift ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# Principal being measured
# ---------------------------------------------------------------------------
if ! AS_UID="$(id -u "$AS_USER" 2>/dev/null)"; then
  echo "ERROR: no such user: $AS_USER" >&2; exit 2
fi
# Refused rather than answered: every verdict here is computed from mode bits,
# and uid 0 ignores mode bits.  Audited as root this would score the whole chain
# OK -- a clean report for the one principal that can rewrite all of it.  That
# is the worst possible fail-open, so it is an error instead.
if [[ "$AS_UID" == "0" ]]; then
  echo "ERROR: --as-uid root is meaningless: root bypasses the permission bits" >&2
  echo "       this audit reasons about. Audit the unprivileged agent uid." >&2
  exit 2
fi
AS_GIDS=" $(id -G "$AS_USER" 2>/dev/null) "
[[ "$AS_GIDS" == "  " ]] && { echo "ERROR: cannot resolve groups for $AS_USER" >&2; exit 2; }

# ---------------------------------------------------------------------------
# Substitutability analysis
# ---------------------------------------------------------------------------

# writable_by <path> -- can AS_UID change this file's bytes in place?
# Ownership counts as write: the owner may chmod +w whenever it likes.
# Every stat below dereferences (-L).  A symlink's own mode is always 0777 on
# Linux and means nothing; what decides access is the target.  Reading the link
# instead of the target reports /bin and /sbin -- which are symlinks into
# /usr -- as world-writable holes.  Verified against a live write probe: both
# refuse.  A check that cries wolf on /bin is a check nobody reads.
writable_by() {
  local p="$1" st
  st="$(stat -L -c '%u %g %a' "$p" 2>/dev/null)" || return 2
  local o g m; read -r o g m <<<"$st"
  [[ "$o" == "$AS_UID" ]] && return 0                       # owner => chmod at will
  m="$(printf '%03d' "$((10#$m % 1000))")"
  [[ "${m:2:1}" =~ [2367] ]] && return 0                    # other-write
  [[ "$AS_GIDS" == *" $g "* && "${m:1:1}" =~ [2367] ]] && return 0
  return 1
}

# dir_allows_replace <dir> [victim] -- can AS_UID unlink/rename inside dir?
# Needs write+execute on the dir.  If the dir is sticky, removal additionally
# requires owning the dir or owning the victim file.
dir_allows_replace() {
  local d="$1" victim="${2:-}" st
  st="$(stat -L -c '%u %g %a' "$d" 2>/dev/null)" || return 2
  local o g m; read -r o g m <<<"$st"
  m="$(printf '%04d' "$((10#$m % 10000))")"
  local sticky="${m:0:1}" ow="${m:1:1}" gw="${m:2:1}" tw="${m:3:1}"

  # Owning the directory counts as write for the same reason owning a file
  # does: the owner can chmod it back open at any time.  $ow is therefore only
  # consulted for the record, not for the decision.
  local can_write=1
  if   [[ "$o" == "$AS_UID" ]]; then can_write=0
  elif [[ "$AS_GIDS" == *" $g "* && "$gw" =~ [2367] ]]; then can_write=0
  elif [[ "$tw" =~ [2367] ]]; then can_write=0
  fi
  [[ $can_write -ne 0 ]] && return 1

  if [[ "$sticky" =~ [1357] ]]; then
    [[ "$o" == "$AS_UID" ]] && return 0                     # dir owner ignores sticky
    if [[ -n "$victim" && -e "$victim" ]]; then
      local vo; vo="$(stat -c '%u' "$victim" 2>/dev/null)" || return 2
      [[ "$vo" == "$AS_UID" ]] && return 0                  # own the victim
      return 1
    fi
    return 0   # creating a NEW name in a sticky dir is always allowed
  fi
  return 0
}

# substitutable <path> -- can AS_UID cause a different file to be read at this
# path?  True if the bytes are writable, or the name can be replaced.
# Echoes the reason.  rc 0 = yes, 1 = no, 2 = indeterminate.
substitutable() {
  local p="$1" parent; parent="$(dirname "$p")"

  # Directory components first.  stat -L answers "what does this resolve to
  # right now", which is the wrong question if any component along the way is a
  # symlink the agent can repoint: /a/link/helper resolves into root-owned
  # /usr/bin today and into an agent-owned directory the moment `ln -sfn` runs.
  # Every component's own name has to hold, not just the final target.
  local walk="" comp lparent
  local -a comps=()
  IFS='/' read -r -a comps <<<"${p#/}"
  for comp in "${comps[@]}"; do
    [[ -z "$comp" ]] && continue
    walk="$walk/$comp"
    [[ "$walk" == "$p" ]] && break          # the leaf is judged below, not here
    if [[ -L "$walk" ]]; then
      lparent="$(dirname "$walk")"
      if dir_allows_replace "$lparent" "$walk"; then
        echo "symlink component $walk can be repointed by $AS_USER"
        return 0
      fi
    fi
  done

  if [[ -e "$p" ]]; then
    local w; writable_by "$p"; w=$?
    [[ $w -eq 2 ]] && { echo "cannot stat"; return 2; }
    if [[ $w -eq 0 ]]; then
      local own; own="$(stat -c '%U' "$p" 2>/dev/null)"
      if [[ "$own" == "$AS_USER" ]]; then echo "owned by $AS_USER (may chmod +w)"
      else echo "write bit grants $AS_USER"; fi
      return 0
    fi
    local d; dir_allows_replace "$parent" "$p"; d=$?
    [[ $d -eq 2 ]] && { echo "cannot stat parent"; return 2; }
    [[ $d -eq 0 ]] && { echo "parent dir $parent permits rename/unlink"; return 0; }
    echo "not writable, parent dir holds"
    return 1
  else
    # The path does not exist -- but "does not exist" is not "safe".  git will
    # happily read a config that appears later, so the question is whether the
    # audited uid can put one there.  Walk up to the nearest ancestor that does
    # exist: if it can create there, it can mkdir -p the rest of the way down.
    #
    # Checking only the immediate parent gets this wrong and reports OK.  That
    # is how ~/.config/git/config first scored clean on the original host, when
    # in fact ~/.config was agent-owned and `mkdir -p` succeeds -- verified by
    # doing it.  A missing intermediate directory is not a boundary.
    local anc="$parent"
    while [[ ! -e "$anc" && "$anc" != "/" && "$anc" != "." ]]; do
      anc="$(dirname "$anc")"
    done
    local d; dir_allows_replace "$anc"; d=$?
    [[ $d -eq 2 ]] && { echo "cannot stat nearest existing ancestor $anc"; return 2; }
    if [[ $d -eq 0 ]]; then
      if [[ "$anc" == "$parent" ]]; then echo "absent but creatable in $parent"
      else echo "absent, and creatable via mkdir -p under $anc"; fi
      return 0
    fi
    echo "absent, and $anc holds against creation"
    return 1
  fi
}

row() { ROWS+=("$1"$'\t'"$2"$'\t'"$3"$'\t'"$4"); }

# verdict_for <scope> <path> <kind>
verdict_for() {
  local scope="$1" p="$2" kind="$3" why rc
  why="$(substitutable "$p")"; rc=$?
  case $rc in
    0) row "HOLE" "$scope" "$p" "$kind: $why"; HOLES=$((HOLES+1)) ;;
    1) row "OK"   "$scope" "$p" "$kind: $why" ;;
    *) row "INDET" "$scope" "$p" "$kind: $why"; INDET=$((INDET+1)) ;;
  esac
  return 0
}

# ---------------------------------------------------------------------------
# --check-path: single-path mode, used by the regression suite
# ---------------------------------------------------------------------------
if [[ -n "$CHECK_PATH" ]]; then
  why="$(substitutable "$CHECK_PATH")"; rc=$?
  case $rc in
    0) v=HOLE ;; 1) v=OK ;; *) v=INDET ;;
  esac
  [[ $QUIET -eq 0 ]] && printf '%s\t%s\t%s\n' "$v" "$CHECK_PATH" "$why"
  case $v in HOLE) exit 1 ;; OK) exit 0 ;; *) exit 3 ;; esac
fi

# ---------------------------------------------------------------------------
# Pinned helper hashes
# ---------------------------------------------------------------------------
#
# The pin file distinguishes the build that is SUPPOSED to be running
# (`expected`, exactly one) from builds that merely passed review at some point
# (`reviewed`).  That distinction is the control: a downgrade attack is a live
# helper that WAS once reviewed -- revert to a build predating a fix and the fix
# is gone with every hash still checking out.  The 2026-08-24 03:32 swap was
# exactly this shape, and a flat known-good list scores it clean.
#
# Every parse failure below lands on INDETERMINATE rather than on a verdict.  A
# pin file this script cannot make sense of has told it nothing about the live
# helper, and "nothing" must not be spelled the same way as "fine".
declare -a PIN_REVIEWED=()
PIN_EXPECTED=""
PINS_STATE="missing"          # missing | malformed | no-expected | ok
PINS_WHY=""
if [[ -r "$PINS" ]]; then
  PINS_STATE="ok"
  _lineno=0
  while read -r state h _rest; do
    _lineno=$((_lineno+1))
    [[ -z "$state" || "$state" == \#* ]] && continue
    if [[ ! "$h" =~ ^[0-9a-f]{64}$ ]]; then
      PINS_STATE="malformed"; PINS_WHY="line $_lineno: not a sha256"; break
    fi
    case "$state" in
      expected)
        if [[ -n "$PIN_EXPECTED" ]]; then
          # Two candidates for "what should be running" is not a question this
          # script gets to answer by picking one.
          PINS_STATE="malformed"; PINS_WHY="line $_lineno: a second expected build"; break
        fi
        PIN_EXPECTED="$h" ;;
      reviewed) PIN_REVIEWED+=("$h") ;;
      *) PINS_STATE="malformed"; PINS_WHY="line $_lineno: unknown state '$state'"; break ;;
    esac
  done < "$PINS"
  [[ "$PINS_STATE" == "ok" && -z "$PIN_EXPECTED" ]] && PINS_STATE="no-expected"
fi

# Asks "is this the build that is supposed to be running", not "have we ever
# reviewed this build".  Widening it to the second question is how this control
# dies; the mutation gate in CI reintroduces exactly that.
pin_is_expected() { [[ -n "$PIN_EXPECTED" && "$1" == "$PIN_EXPECTED" ]]; }
pin_was_reviewed() { [[ " ${PIN_REVIEWED[*]-} " == *" $1 "* ]]; }

# ---------------------------------------------------------------------------
# Walk the chain
# ---------------------------------------------------------------------------
# Every config git reads.  Order is git's read order, but note that
# credential.helper is multi-valued: git runs each helper it finds until one
# supplies credentials.  So an attacker does not need to WIN precedence, only to
# appear anywhere in the list.  That is why every scope below is equal-severity
# and why absent-but-creatable counts.
XDG_BASE="${XDG_CONFIG_HOME:-$HOME_DIR/.config}"
declare -a CFG_SCOPES=(
  "system:$SYSTEM_CFG"
  "global-xdg:$XDG_BASE/git/config"
  "global:${GIT_CONFIG_GLOBAL:-$HOME_DIR/.gitconfig}"
)
[[ -n "$REPO_DIR" ]] && CFG_SCOPES+=("local:$REPO_DIR/.git/config")

declare -a HELPER_CMDS=()

for entry in "${CFG_SCOPES[@]}"; do
  scope="${entry%%:*}"; cfg="${entry#*:}"
  verdict_for "$scope" "$cfg" "config"

  [[ -e "$cfg" ]] || continue
  if [[ ! -r "$cfg" ]]; then
    row "INDET" "$scope" "$cfg" "config: exists but unreadable; helpers unknown"
    INDET=$((INDET+1)); continue
  fi
  # Read helper values out of this file alone.
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    HELPER_CMDS+=("$scope"$'\t'"$cfg"$'\t'"$line")
  done < <(git config --file "$cfg" --get-regexp '^credential\..*helper$' 2>/dev/null \
             | sed 's/^[^ ]* *//')
done

# ---------------------------------------------------------------------------
# Every helper program the chain names
# ---------------------------------------------------------------------------
declare -A SEEN_PROG=()
for hc in "${HELPER_CMDS[@]}"; do
  IFS=$'\t' read -r scope cfg cmd <<<"$hc"
  [[ -z "${cmd// }" ]] && continue          # empty value = "reset the list", not a program

  prog=""
  if [[ "$cmd" == !* ]]; then
    # shell form: first word is the program
    body="${cmd#!}"
    prog="$(awk '{print $1}' <<<"$body")"
  else
    first="$(awk '{print $1}' <<<"$cmd")"
    if [[ "$first" == /* ]]; then prog="$first"
    else
      # git resolves this as `git credential-<name>` off PATH
      prog="$(command -v "git-credential-$first" 2>/dev/null || true)"
      if [[ -z "$prog" ]]; then
        row "INDET" "$scope" "credential-$first" "helper: named but not found on PATH"
        INDET=$((INDET+1)); continue
      fi
    fi
  fi

  [[ -n "${SEEN_PROG[$prog]:-}" ]] && continue
  SEEN_PROG[$prog]=1

  verdict_for "$scope" "$prog" "helper program"

  # The containing directory, called out separately.  This is the link the
  # original report correctly identified, and it is scored on a different
  # question than the file: not "can you edit it" but "can you put a different
  # file at that name",
  # which is what the directory's write bit decides.
  progdir="$(dirname "$prog")"
  if [[ -n "${SEEN_PROG[$progdir]:-}" ]]; then :; else
    SEEN_PROG[$progdir]=1
    dir_allows_replace "$progdir" "$prog"; drc=$?
    case $drc in
      0) row "HOLE" "$scope" "$progdir" "helper dir: $AS_USER can replace the helper's name here"
         HOLES=$((HOLES+1)) ;;
      1) row "OK"    "$scope" "$progdir" "helper dir: holds against $AS_USER" ;;
      *) row "INDET" "$scope" "$progdir" "helper dir: cannot stat"
         INDET=$((INDET+1)) ;;
    esac
  fi

  # THE GRANDPARENT.  The check above asks "can $AS_USER replace the
  # NAME 'gh-app-token.js' inside progdir" -- it does not ask "can $AS_USER
  # replace the NAME 'progdir' (e.g. 'bin') inside progdir's OWN parent".
  # Those are different questions with different answers: measured on the
  # original host, the helper dir was 0755 root:root (holds, per the check
  # above) while its parent ~/.local was 0755 agent-owned -- letting the
  # audited uid `mv bin bin.evil` and drop in a
  # substitute directory, without ever touching progdir's own bits. A root-
  # owned directory inside an agent-owned directory is exactly as substitutable
  # as a root-owned file inside one (dir_allows_replace's own doc comment says
  # this about files; it is equally true one level up). This walks upward
  # rather than checking just the immediate grandparent, for the same reason
  # `substitutable()` walks the whole path for symlink components: an
  # attacker only needs ONE ancestor to give way.
  gp="$progdir"
  while [[ "$gp" != "/" && "$gp" != "." ]]; do
    parent_gp="$(dirname "$gp")"
    dir_allows_replace "$parent_gp" "$gp"; grc=$?
    case $grc in
      0) row "HOLE" "$scope" "$gp" "ancestor dir: $AS_USER can replace '$(basename "$gp")' within $parent_gp"
         HOLES=$((HOLES+1)) ;;
      1) : ;;  # holds -- do not add a row for every clean ancestor, only report failures and stop there
      *) row "INDET" "$scope" "$gp" "ancestor dir: cannot stat $parent_gp"
         INDET=$((INDET+1)) ;;
    esac
    [[ $grc -eq 1 ]] || break   # hole or indeterminate: nothing further up changes the verdict for this leaf
    gp="$parent_gp"
  done

  # hash pin
  if [[ -r "$prog" ]]; then
    live="$(sha256sum "$prog" 2>/dev/null | awk '{print $1}')"
    if [[ "$PINS_STATE" == "missing" ]]; then
      row "INDET" "$scope" "$prog" "pin: no pin file at $PINS (set --pins or CREDENTIAL_CHAIN_PINS to the reviewed pin file)"
      INDET=$((INDET+1))
    elif [[ "$PINS_STATE" == "malformed" ]]; then
      row "INDET" "$scope" "$prog" "pin: pin file unusable ($PINS_WHY)"
      INDET=$((INDET+1))
    elif [[ "$PINS_STATE" == "no-expected" ]]; then
      row "INDET" "$scope" "$prog" "pin: no expected build declared in $PINS"
      INDET=$((INDET+1))
    elif pin_is_expected "$live"; then
      row "OK" "$scope" "$prog" "pin: matches the expected build ${live:0:12}"
    elif pin_was_reviewed "$live"; then
      # Not "unknown file" and not "fine": a build we shipped once, running
      # where a different one should be.  Named separately because the remedy
      # differs -- this one is usually a rollback or a lagging deploy, and it
      # is the shape the 03:32 helper swap took.
      row "HOLE" "$scope" "$prog" "pin: STALE, live ${live:0:12} is a previously reviewed build, not the expected ${PIN_EXPECTED:0:12}"
      HOLES=$((HOLES+1))
    else
      row "HOLE" "$scope" "$prog" "pin: DRIFT, live ${live:0:12} matches no reviewed build (expected ${PIN_EXPECTED:0:12})"
      HOLES=$((HOLES+1))
    fi
  else
    row "INDET" "$scope" "$prog" "pin: unreadable, cannot hash"
    INDET=$((INDET+1))
  fi
done

# PATH hijack: a helper named without a path is resolved off PATH, and so is
# every plain executable git itself shells out to.  Measured on the original
# host, the helper directory was NOT on PATH, so this vector was closed
# there -- but it is one PATH edit away from being open, which is worth
# watching.
IFS=':' read -r -a PATH_DIRS <<<"$PATH"
for d in "${PATH_DIRS[@]}"; do
  [[ -d "$d" ]] || continue
  if dir_allows_replace "$d"; then
    row "HOLE" "PATH" "$d" "PATH dir: $AS_USER can add or replace executables"
    HOLES=$((HOLES+1))
  fi
done

# ---------------------------------------------------------------------------
# Staged root-run scripts  (--staged)
# ---------------------------------------------------------------------------
# Scripts staged outside the repo for an operator to run as root.  Scored on
# whether the staged mirror still matches its reviewed source in git.
#
# This is a different and worse exposure than the rest of the chain: the chain
# runs as the agent uid, these run as root.  It is in this audit rather than a
# separate tool because it is the same defect -- an agent-writable file in a
# privileged execution path -- and this chain's own remediation script was an
# instance of it.
#
# Deliberately NOT scored as a hole merely for being agent-writable.  Every path
# in this container is, including the checkout, so that verdict would be
# unconditional and would say nothing.  What carries information is DRIFT: the
# mirror no longer matches the source that went through review.
if [[ $STAGED -eq 1 ]]; then
  if [[ ! -r "$STAGED_MANIFEST" ]]; then
    row "INDET" "staged" "$STAGED_MANIFEST" "staged: manifest unreadable, nothing checked"
    INDET=$((INDET+1))
  else
    while IFS=$'\t' read -r staged src; do
      [[ -z "${staged// }" || "$staged" == \#* ]] && continue
      src="${src// }"
      if [[ -z "$src" ]]; then
        row "INDET" "staged" "$staged" "staged: manifest line names no source"
        INDET=$((INDET+1)); continue
      fi
      # Sources are repo-relative by convention -- that is the whole point, the
      # canonical copy lives in git next to this script.  An absolute path is
      # accepted so the regression suite can point at a fixture; joining it onto
      # $HERE unconditionally yields /repo//tmp/... and every such entry reads
      # INDET, which looks like a manifest bug rather than a path bug.
      if [[ "$src" == /* ]]; then srcpath="$src"; else srcpath="$HERE/$src"; fi
      if [[ ! -r "$srcpath" ]]; then
        row "INDET" "staged" "$staged" "staged: canonical source $src missing from the checkout"
        INDET=$((INDET+1)); continue
      fi
      if [[ ! -e "$staged" ]]; then
        # Not staged at all -- nobody can be talked into root-running a file
        # that is not there.  This is the state the manifest wants to reach.
        row "OK" "staged" "$staged" "staged: not present; nothing root-runnable here"
        continue
      fi
      if [[ ! -r "$staged" ]]; then
        row "INDET" "staged" "$staged" "staged: present but unreadable, cannot compare"
        INDET=$((INDET+1)); continue
      fi
      live_sha="$(sha256sum "$staged" 2>/dev/null | awk '{print $1}')"
      src_sha="$(sha256sum "$srcpath" 2>/dev/null | awk '{print $1}')"
      if [[ -z "$live_sha" || -z "$src_sha" ]]; then
        row "INDET" "staged" "$staged" "staged: could not hash both copies"
        INDET=$((INDET+1)); continue
      fi
      if [[ "$live_sha" == "$src_sha" ]]; then
        row "OK" "staged" "$staged" "staged: matches $src (${live_sha:0:12})"
      else
        row "HOLE" "staged" "$staged" "staged: DRIFT from $src -- mirror ${live_sha:0:12}, source ${src_sha:0:12}; do NOT root-run it"
        HOLES=$((HOLES+1))
      fi
    done < "$STAGED_MANIFEST"
  fi
fi

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
if [[ $QUIET -eq 0 ]]; then
  if [[ "$FORMAT" == "json" ]]; then
    printf '{"principal":"%s","holes":%d,"indeterminate":%d,"links":[' "$AS_USER" "$HOLES" "$INDET"
    sep=""
    for r in "${ROWS[@]}"; do
      IFS=$'\t' read -r v s p d <<<"$r"
      printf '%s{"verdict":"%s","scope":"%s","path":"%s","detail":"%s"}' \
        "$sep" "$v" "$s" "$p" "${d//\"/\\\"}"; sep=","
    done
    printf ']}\n'
  else
    printf '\n\033[1mgit credential-helper chain, as seen by uid %s(%s)\033[0m\n\n' "$AS_USER" "$AS_UID"
    for r in "${ROWS[@]}"; do
      IFS=$'\t' read -r v s p d <<<"$r"
      case "$v" in
        HOLE)  c=$'\033[31m' ;;
        OK)    c=$'\033[32m' ;;
        *)     c=$'\033[33m' ;;
      esac
      printf '  %b%-5s\033[0m  %-10s %-46s %s\n' "$c" "$v" "$s" "$p" "$d"
    done
    printf '\n  %d hole(s), %d indeterminate\n\n' "$HOLES" "$INDET"
  fi
fi

# A hole outranks an indeterminate: we found something real either way.
[[ $HOLES -gt 0 ]] && exit 1
[[ $INDET -gt 0 ]] && exit 3
exit 0
