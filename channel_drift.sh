#!/usr/bin/env bash
# ===========================================================================
# channel_drift.sh — is every runnable file in the operator handoff channel a
# mirror of something committed?
#
# WHY THIS EXISTS (TOG-356). `tool_drift.sh` answers the INBOUND question: the
# operator edits the running copy and the repo falls behind. Measured
# 2026-08-24 that had not yet happened. The OUTBOUND case had, and keeps
# happening: an agent writes a tool into /paperclip/operator-handoff/, the
# operator installs and runs it, and it never becomes a PR — so there is no
# review, no history and no rollback for code running on the VPS.
#
# Re-measured 2026-08-25 for this file: 11 of 14 runnable artifacts in that
# channel existed in no git repo at all, up from 9 of 11 the day before. The
# arrival rate beats hand cleanup, which is why the rule has to be mechanical.
#
# WHY NOT JUST `tool_drift.sh compare --strict`, which TOG-356 proposed. Two
# reasons, both measured before writing this:
#
#   1. `compare` matches on PATH. Channel drops are named for their issue —
#      `TOG-151-omniroute_combo_cli.sh` — so every single drop reports
#      UNVERSIONED, including the two that are byte-identical to a committed
#      blob. A detector that fires on the compliant files is noise.
#   2. `--strict` fails when the ref holds files the source does not. The
#      channel is a deliberate SUBSET of the repo — 14 artifacts against 86
#      tracked blobs — so `--strict` would report ~70 permanent NOT DEPLOYED
#      lines and never go green. tool_drift.sh's own header says why that is
#      fatal: "a drift detector that cries wolf gets muted — at which point it
#      is indistinguishable from a deleted one."
#
# So this matches on CONTENT, not path: a drop is compliant iff its git blob
# hash appears ANYWHERE in the ref's tree. That is exactly the rule the channel
# README should state — a drop is a mirror of a committed artifact — and it is
# free of both problems above. Renaming, re-prefixing and moving a file in the
# repo all keep it compliant; changing a byte does not.
#
# WHAT THIS CANNOT DO. CI cannot run the `check` subcommand: GitHub Actions has
# no view of /paperclip. CI runs test_channel_drift.sh, which proves the
# DETECTOR works. Green there means "channel_drift.sh would notice an
# unversioned drop", never "the channel is clean". The real check is this
# script run where the channel is mounted — any agent container, or the host.
# ===========================================================================
set -uo pipefail

ME="$(basename "${BASH_SOURCE[0]}")"

# Exit codes are the interface; callers gate on these, never on printed text.
#   0  every runnable artifact is a mirror of a committed blob (or exempt)
#   2  refused (bad usage, unreadable input, not a git checkout)
#   3  at least one artifact is unversioned or stale
EXIT_OK=0; EXIT_REFUSED=2; EXIT_DRIFT=3

DEFAULT_DIR=/paperclip/operator-handoff
DEFAULT_EXEMPT=channel_exempt.txt

c_red() { printf '\033[31m%s\033[0m\n' "$*"; }
c_grn() { printf '\033[32m%s\033[0m\n' "$*"; }
c_yel() { printf '\033[33m%s\033[0m\n' "$*"; }
die()   { c_red "$ME: $*" >&2; exit $EXIT_REFUSED; }

# --- what counts as runnable ------------------------------------------------
# A UNION of three independent tests, not one. Each alone has a hole the other
# two cover, and the failure direction that matters is missing an artifact, not
# flagging an extra one:
#
#   exec bit   — what actually lets the operator `./x`. Misses TOG-196's .mjs,
#                which is 0644 and still gets run by `node x.mjs`.
#   extension  — catches those. Misses anything named to look like evidence.
#   shebang    — catches THAT: a script named `notes.md` is still a script, and
#                `bash notes.md` runs it. Content beats naming.
#
# Not a denylist of "things that are just docs". A denylist rots the first time
# a new kind of runnable file appears, and the first surprise would be the one
# that mattered.
RUNNABLE_EXTENSIONS=(sh bash py mjs cjs js)

# --- required mirrors -------------------------------------------------------
# Runnable-ness is the right test for a DROP. An agent stages a tool and the
# question is whether anyone reviewed it, so the sweep below has to find files
# nobody declared. It is the WRONG test for the channel's own README, which is
# the one file in there whose entire content is the rule this script enforces,
# and which is not runnable by any of the three tests.
#
# TOG-373: that README is root-owned, so only the operator can install it, and
# until this table existed nothing verified that they had. The step that puts
# "a drop must be byte-for-byte" in front of agents was itself the one step in
# the channel with no receipt — it could be hand-retyped out of a fence in a
# doc, truncated, or never done at all, and a clean run would not have noticed.
#
# So: "<channel basename>=<path in the ref>". Unlike a drop, a required mirror
# is looked up by NAME, is a finding when ABSENT, and is checked whether or not
# it is runnable. Content still decides; the name only says which blob to want.
REQUIRED_MIRRORS=(
  "README.md=handoff-channel-README.md"
)

is_runnable() {
  local f="$1" base ext
  [ -x "$f" ] && return 0
  base="$(basename "$f")"
  for ext in "${RUNNABLE_EXTENSIONS[@]}"; do
    case "$base" in *".$ext") return 0 ;; esac
  done
  # Shebang test, read as bytes so a binary file cannot make this hang or spew.
  [ -r "$f" ] || return 1
  case "$(head -c 2 "$f" 2>/dev/null)" in '#!') return 0 ;; esac
  return 1
}

# git's blob hash from coreutils: sha1("blob <bytelen>\0" + data). Same function
# as tool_drift.sh, and test_channel_drift.sh pins it against `git hash-object`
# for the same reason that suite does — if the equality breaks, every artifact
# reports unversioned and the tool is worthless.
blob_hash() {
  local f="$1" len
  len=$(wc -c < "$f") || return 1
  { printf 'blob %d\0' "$len"; cat "$f"; } | sha1sum | cut -d' ' -f1
}

# Channel drops are named for their issue. Strip ONE leading marker so a drop
# can be matched to a tracked path by name when its content does not match —
# that distinction is what separates STALE (a mirror that stopped mirroring)
# from UNVERSIONED (never imported at all), and the two need different fixes.
strip_prefix() {
  printf '%s\n' "$1" | sed -E 's/^(TOG-[0-9]+|[A-Z][A-Z0-9]*)-//'
}

cmd_check() {
  local dir="$DEFAULT_DIR" ref="main" exempt="" strict=0 quiet=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir)    dir="${2:-}";    [ -n "$dir" ]    || die "--dir needs a value";    shift 2 ;;
      --ref)    ref="${2:-}";    [ -n "$ref" ]    || die "--ref needs a value";    shift 2 ;;
      --exempt) exempt="${2:-}"; [ -n "$exempt" ] || die "--exempt needs a value"; shift 2 ;;
      # --strict also fails on an exempt artifact, for a release check: an
      # exemption is a deliberate hole and a release should be able to refuse
      # to ship with one open.
      --strict) strict=1; shift ;;
      --quiet)  quiet=1; shift ;;
      -*)       die "unknown option: $1" ;;
      *)        die "check takes no positional argument: $1" ;;
    esac
  done

  [ -d "$dir" ] || die "not a directory: $dir"
  dir="$(cd "$dir" && pwd)" || die "cannot enter: $dir"

  git rev-parse --git-dir >/dev/null 2>&1 || die "check must run inside a git checkout"
  git rev-parse --verify --quiet "$ref^{tree}" >/dev/null || die "no such ref: $ref"

  # Default the exemption file to the one next to this script, but only if it
  # exists — an absent default is not a refusal, an absent EXPLICIT one is.
  local here; here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ -z "$exempt" ]; then
    [ -r "$here/$DEFAULT_EXEMPT" ] && exempt="$here/$DEFAULT_EXEMPT"
  else
    [ -r "$exempt" ] || die "cannot read exemption file: $exempt"
  fi

  # Exemptions: "<basename><TAB><reason>". A reason is MANDATORY — an exemption
  # with no stated reason is indistinguishable from someone silencing the check,
  # and this refuses rather than honouring it.
  declare -A EXEMPT_REASON=()
  if [ -n "$exempt" ]; then
    local ln lineno=0 name reason
    while IFS= read -r ln || [ -n "$ln" ]; do
      lineno=$((lineno+1))
      case "$ln" in '#'*|'') continue ;; esac
      name="${ln%%$'\t'*}"; reason="${ln#*$'\t'}"
      if [ "$reason" = "$ln" ] || [ -z "${reason//[[:space:]]/}" ]; then
        die "$exempt:$lineno: exemption for '$name' has no reason (want '<basename><TAB><reason>')"
      fi
      EXEMPT_REASON["$name"]="$reason"
    done < "$exempt"
  fi

  # The authoritative side, read from the ref itself. Nothing cached, nothing
  # committed to go stale: hash -> tracked path, and basename -> tracked path.
  declare -A BY_HASH=() BY_BASE=()
  local h p
  while IFS=$'\t' read -r h p; do
    [ -n "$p" ] || continue
    [ -z "${BY_HASH[$h]:-}" ] && BY_HASH["$h"]="$p"
    local b; b="$(basename "$p")"
    [ -z "${BY_BASE[$b]:-}" ] && BY_BASE["$b"]="$p"
  done < <(git ls-tree -r "$ref" | awk '$2=="blob"{ h=$3; sub(/^[^\t]*\t/,""); print h "\t" $0 }')

  local ok=0 stale=0 unver=0 exempted=0 skipped=0 missing=0 tampered=0
  local -a L_OK=() L_STALE=() L_UNVER=() L_EXEMPT=() L_MISSING=() L_TAMPERED=()

  # --- required mirrors, before the sweep -----------------------------------
  # Resolve each one against the ref FIRST. If the canonical blob is not there,
  # this check cannot answer the question it was asked, and the honest answer
  # is a refusal rather than a verdict — the TOG-357 rule: never report a
  # comparison that did not happen. Renaming the canonical file in the repo
  # without updating this table therefore breaks the run loudly instead of
  # silently condemning (or excusing) whatever is installed in the channel.
  declare -A REQUIRED_SRC=() REQUIRED_HASH=()
  local entry rbase rpath rhash
  for entry in "${REQUIRED_MIRRORS[@]}"; do
    rbase="${entry%%=*}"; rpath="${entry#*=}"
    rhash="$(git rev-parse --verify --quiet "$ref:$rpath" 2>/dev/null)" \
      || die "required mirror source is not on $ref: $rpath (the table in $ME names a file this ref does not have; fix the table, do not delete the entry)"
    REQUIRED_SRC["$rbase"]="$rpath"
    REQUIRED_HASH["$rbase"]="$rhash"
  done

  local rf rowner hash
  for rbase in "${!REQUIRED_SRC[@]}"; do
    rpath="${REQUIRED_SRC[$rbase]}"; rf="$dir/$rbase"
    if [ -n "${EXEMPT_REASON[$rbase]:-}" ]; then
      exempted=$((exempted+1)); L_EXEMPT+=("$rbase — ${EXEMPT_REASON[$rbase]}"); continue
    fi
    if [ ! -f "$rf" ] || [ ! -r "$rf" ]; then
      missing=$((missing+1)); L_MISSING+=("$rbase  (want the bytes of $rpath)")
      continue
    fi
    hash="$(blob_hash "$rf")" || { missing=$((missing+1)); L_MISSING+=("$rbase  (unhashable)"); continue; }
    rowner="$(stat -c %U "$rf" 2>/dev/null || echo '?')"
    if [ "$hash" = "${REQUIRED_HASH[$rbase]}" ]; then
      ok=$((ok+1)); L_OK+=("$rbase -> $rpath  (required)")
    else
      tampered=$((tampered+1)); L_TAMPERED+=("$rbase  ($rowner)  is not $rpath on $ref")
    fi
  done

  local f base owner stripped
  while IFS= read -r -d '' f; do
    base="$(basename "$f")"
    # Already accounted for above, by name and against one specific blob.
    [ -n "${REQUIRED_SRC[$base]:-}" ] && continue
    is_runnable "$f" || continue
    if [ ! -r "$f" ]; then
      # Unreadable is NOT a pass. It is a runnable file this check could not
      # account for, which is the same risk with less evidence.
      skipped=$((skipped+1)); L_UNVER+=("$base  (unreadable)"); unver=$((unver+1)); continue
    fi

    if [ -n "${EXEMPT_REASON[$base]:-}" ]; then
      exempted=$((exempted+1)); L_EXEMPT+=("$base — ${EXEMPT_REASON[$base]}"); continue
    fi

    hash="$(blob_hash "$f")" || { unver=$((unver+1)); L_UNVER+=("$base  (unhashable)"); continue; }
    owner="$(stat -c %U "$f" 2>/dev/null || echo '?')"

    if [ -n "${BY_HASH[$hash]:-}" ]; then
      ok=$((ok+1)); L_OK+=("$base -> ${BY_HASH[$hash]}")
      continue
    fi
    stripped="$(strip_prefix "$base")"
    if [ -n "${BY_BASE[$stripped]:-}" ]; then
      stale=$((stale+1)); L_STALE+=("$base  ($owner)  vs ${BY_BASE[$stripped]}")
    else
      unver=$((unver+1)); L_UNVER+=("$base  ($owner)")
    fi
  done < <(find "$dir" -maxdepth 1 -type f -print0 2>/dev/null | sort -z)

  local x
  if [ "$quiet" -eq 0 ]; then
    printf 'channel drift: %s vs %s (%s)\n\n' "$dir" "$ref" "$(git rev-parse --short "$ref")"

    if [ ${#L_MISSING[@]} -gt 0 ]; then
      c_red "MISSING — required in the channel and not there. The operator installs these; agents cannot:"
      for x in "${L_MISSING[@]}"; do printf '  %s\n' "$x"; done; echo
    fi
    if [ ${#L_TAMPERED[@]} -gt 0 ]; then
      c_red "NOT THE COMMITTED COPY — required, present, and its bytes are not the blob it must mirror:"
      for x in "${L_TAMPERED[@]}"; do printf '  %s\n' "$x"; done; echo
    fi
    if [ ${#L_UNVER[@]} -gt 0 ]; then
      c_red "UNVERSIONED — runnable, and its content is in no commit on $ref. No review, no history, no rollback:"
      for x in "${L_UNVER[@]}"; do printf '  %s\n' "$x"; done; echo
    fi
    if [ ${#L_STALE[@]} -gt 0 ]; then
      c_red "STALE — a tracked file of that name exists on $ref, but this copy is not it:"
      for x in "${L_STALE[@]}"; do printf '  %s\n' "$x"; done; echo
    fi
    if [ ${#L_EXEMPT[@]} -gt 0 ]; then
      c_yel "EXEMPT — allowed by the exemption file, with a stated reason:"
      for x in "${L_EXEMPT[@]}"; do printf '  %s\n' "$x"; done; echo
    fi
    if [ ${#L_OK[@]} -gt 0 ]; then
      c_grn "MIRRORED — byte-identical to a blob on $ref:"
      for x in "${L_OK[@]}"; do printf '  %s\n' "$x"; done; echo
    fi

    printf 'mirrored: %d   stale: %d   unversioned: %d   exempt: %d   missing: %d   not-the-committed-copy: %d\n' \
      "$ok" "$stale" "$unver" "$exempted" "$missing" "$tampered"
  fi

  if [ "$missing" -gt 0 ] || [ "$tampered" -gt 0 ]; then
    [ "$quiet" -eq 0 ] && c_red "channel drift detected"
    return $EXIT_DRIFT
  fi
  if [ "$unver" -gt 0 ] || [ "$stale" -gt 0 ]; then
    [ "$quiet" -eq 0 ] && c_red "channel drift detected"
    return $EXIT_DRIFT
  fi
  if [ "$strict" -eq 1 ] && [ "$exempted" -gt 0 ]; then
    [ "$quiet" -eq 0 ] && c_red "strict: $exempted exemption(s) still open"
    return $EXIT_DRIFT
  fi
  [ "$quiet" -eq 0 ] && c_grn "no channel drift"
  return $EXIT_OK
}

usage() {
  cat <<EOF
$ME — every runnable file staged for the operator must mirror a committed blob.

  $ME check [--dir D] [--ref R] [--exempt F] [--strict] [--quiet]

      --dir     channel directory       (default: $DEFAULT_DIR)
      --ref     git ref to match against (default: main)
      --exempt  exemption file          (default: ./$DEFAULT_EXEMPT if present)
      --strict  also fail while any exemption is open
      --quiet   exit status only, no report

A file counts as runnable if it has the exec bit, OR a script extension
(${RUNNABLE_EXTENSIONS[*]}), OR starts with a shebang. It is compliant if its
git blob hash appears anywhere in the ref — content, not path, so the
TOG-nnn- prefix on a drop does not matter and neither does a rename here.

Separately, a few files are REQUIRED to be in the channel and to mirror one
named path, runnable or not, because being absent is itself the failure:

$(for e in "${REQUIRED_MIRRORS[@]}"; do printf '  %s\n' "${e%%=*} -> ${e#*=}"; done)

Exit: 0 clean · 2 refused · 3 unversioned, stale, missing or tampered.

Run it where the channel is mounted (any agent container, or the host):
  ./$ME check
EOF
}

main() {
  local mode="${1:-}"
  case "$mode" in
    check) shift; cmd_check "$@" ;;
    -h|--help|help) usage; exit $EXIT_OK ;;
    # Default is refusal. An unrecognised subcommand must never fall through to
    # a success exit — that is the TOG-201 defect, and it is a repo-wide rule.
    '') usage >&2; die "no subcommand given" ;;
    *)  usage >&2; die "unrecognised subcommand: $mode" ;;
  esac
}

main "$@"
