#!/usr/bin/env bash
# ===========================================================================
# tool_drift.sh — is the copy that RUNS the same as the copy that is REVIEWED?
#
# WHY THIS EXISTS (TOG-212). This tooling lived unversioned in one directory on
# one VPS until 2026-08-23. The import into git was a snapshot, and a snapshot
# is only the source of truth until somebody edits the other copy. TOG-212 found
# the first instance: the omniroute selftest reported 114 assertions in the repo
# and 156 on the VPS. Same tool, two behaviours, and the reviewed one was not
# the one containing Claude routing.
#
# The discrepancy was found BY EYE, from a number a human happened to quote in
# a different issue. That is not a detection mechanism. This is.
#
# WHAT IT DOES NOT DO, deliberately: it does not compare test counts. A count is
# a terrible fingerprint — it collides (two different files can both report 114)
# and it drifts for legitimate reasons. CONTRIBUTING.md forbids gating on one,
# for the same reason. This compares CONTENT, via the git blob hash.
#
# THE TWO SIDES ARE SPLIT ON PURPOSE.
#   fingerprint  runs where the tools RUN (the VPS). Needs bash + coreutils.
#                No git, no network, no credential, no clone.
#   compare      runs where the tools are REVIEWED (a clone). Reads the ref
#                directly, so there is no committed manifest to go stale.
#
# That split is the whole design. A committed list of expected hashes would be
# wrong the first time anyone landed a PR, and a drift detector that cries wolf
# gets muted — at which point it is indistinguishable from a deleted one.
# ===========================================================================
set -uo pipefail

ME="$(basename "${BASH_SOURCE[0]}")"

# Exit codes are the interface; callers gate on these, never on printed text.
#   0  compared, no drift
#   2  refused (bad usage, unreadable input, not a git checkout)
#   3  drift detected
EXIT_OK=0; EXIT_REFUSED=2; EXIT_DRIFT=3

# Set by cmd_compare so a refusal partway through still cleans up. Not a RETURN
# trap — see the note in cmd_compare.
DRIFT_TMP=""
trap '[ -n "$DRIFT_TMP" ] && rm -f "$DRIFT_TMP"' EXIT

c_red() { printf '\033[31m%s\033[0m\n' "$*"; }
c_grn() { printf '\033[32m%s\033[0m\n' "$*"; }
c_yel() { printf '\033[33m%s\033[0m\n' "$*"; }
die()   { c_red "$ME: $*" >&2; exit $EXIT_REFUSED; }

# --- what gets fingerprinted -----------------------------------------------
# An ALLOWLIST of extensions, not a denylist of junk. A denylist silently starts
# hashing whatever new kind of file appears in the directory, and the first
# surprise would be a secret.
FP_EXTENSIONS=(sh js mjs cjs yml yaml md json)

# Never read these, whatever their extension says. Hashing a secret does not
# print it, but it does publish an oracle for it into an issue comment, and
# there is no reason to read one at all. Mirrors .gitignore's secret patterns.
FP_NEVER=(.env .pem .key .jsonl .gh-app-token.json)

# Directories that are never anybody's source of truth.
FP_PRUNE_DIRS=(.git node_modules .venv __pycache__)

# git's blob hash, computed with coreutils only: sha1("blob <bytelen>\0" + data).
# This is what makes the far side dependency-free — the VPS copy of a tool can
# be fingerprinted on a box with no git and no clone, and the hash is directly
# comparable to `git hash-object` / `git ls-tree` output here.
blob_hash() {
  local f="$1" len
  len=$(wc -c < "$f") || return 1
  { printf 'blob %d\0' "$len"; cat "$f"; } | sha1sum | cut -d' ' -f1
}

is_secretish() {
  local base="$1" pat
  for pat in "${FP_NEVER[@]}"; do
    case "$base" in *"$pat") return 0 ;; esac
  done
  return 1
}

cmd_fingerprint() {
  local dir="${1:-.}"
  [ -d "$dir" ] || die "not a directory: $dir"
  dir="$(cd "$dir" && pwd)" || die "cannot enter: $dir"

  # Build the find expression: prune the dead directories, then match extensions.
  local prune=() first=1 d
  for d in "${FP_PRUNE_DIRS[@]}"; do
    [ $first -eq 1 ] && { prune+=( '(' -name "$d" ); first=0; } || prune+=( -o -name "$d" )
  done
  prune+=( ')' -prune -o )

  local match=() ext
  first=1
  for ext in "${FP_EXTENSIONS[@]}"; do
    [ $first -eq 1 ] && { match+=( '(' -name "*.$ext" ); first=0; } || match+=( -o -name "*.$ext" )
  done
  match+=( ')' )

  # Header is comments so the whole thing pastes into an issue as-is and still
  # parses on the way back in.
  printf '# tool_drift fingerprint v1\n'
  printf '# dir: %s\n' "$dir"
  printf '# host: %s\n' "$(hostname 2>/dev/null || echo unknown)"
  printf '# generated: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)"

  local rel h skipped=0
  while IFS= read -r -d '' f; do
    rel="${f#"$dir"/}"
    if is_secretish "$(basename "$f")"; then skipped=$((skipped+1)); continue; fi
    [ -r "$f" ] || { skipped=$((skipped+1)); continue; }
    h="$(blob_hash "$f")" || { skipped=$((skipped+1)); continue; }
    printf '%s\t%s\n' "$h" "$rel"
  done < <(find "$dir" "${prune[@]}" -type f "${match[@]}" -print0 2>/dev/null | sort -z)

  printf '# skipped (unreadable or secret-shaped): %d\n' "$skipped"
}

cmd_compare() {
  local fp="" ref="main" strict=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --ref)    ref="${2:-}"; [ -n "$ref" ] || die "--ref needs a value"; shift 2 ;;
      --strict) strict=1; shift ;;
      # A bare '-' is the stdin sentinel and must be matched BEFORE the -* option
      # branch, which would otherwise reject the documented usage as an unknown
      # option. Ordering here is load-bearing, not cosmetic.
      -)        [ -z "$fp" ] || die "compare takes one fingerprint file"; fp="-"; shift ;;
      -*)       die "unknown option: $1" ;;
      *)        [ -z "$fp" ] || die "compare takes one fingerprint file"; fp="$1"; shift ;;
    esac
  done
  [ -n "$fp" ] || die "compare needs a fingerprint file (or - for stdin)"

  # Deliberately NOT a `trap ... RETURN` with a `local` path. That combination
  # runs the trap after the local has gone out of scope, which under `set -u`
  # aborts the function with status 1 — silently replacing this command's
  # documented exit code (3 = drift) with a generic failure. Found while
  # writing this file; the suite pins the code so it cannot come back.
  local input; input="$(mktemp)" || die "mktemp failed"
  DRIFT_TMP="$input"
  if [ "$fp" = "-" ]; then cat > "$input"
  else [ -r "$fp" ] || { rm -f "$input"; die "cannot read fingerprint file: $fp"; }; cat "$fp" > "$input"; fi

  git rev-parse --git-dir >/dev/null 2>&1 || die "compare must run inside a git checkout"
  git rev-parse --verify --quiet "$ref^{tree}" >/dev/null || die "no such ref: $ref"

  # The authoritative side, read from the ref itself. Nothing is cached and
  # nothing is committed, so this cannot disagree with the branch it is run on.
  # Restricted to the SAME extension allowlist the fingerprint side uses, so the
  # two sides compare like for like. Without this, every tracked file that
  # fingerprint never looks at (.gitignore, LICENSE, anything extensionless)
  # reports as NOT DEPLOYED on every single run — permanent noise in a report
  # whose only value is that a line in it means something.
  local repo; repo="$(mktemp)" || die "mktemp failed"
  local ext_re; ext_re="$(IFS='|'; printf '\\.(%s)$' "${FP_EXTENSIONS[*]}")"
  git ls-tree -r "$ref" \
    | awk '$2=="blob"{ h=$3; sub(/^[^\t]*\t/,""); print h "\t" $0 }' \
    | grep -E "$ext_re" > "$repo"

  local drift=0 only_src=0 only_repo=0 same=0
  local -a L_DRIFT=() L_SRC=() L_REPO=()

  # Walk the fingerprint side.
  local h rel rh
  while IFS=$'\t' read -r h rel; do
    case "$h" in '#'*|'') continue ;; esac
    [ -n "$rel" ] || continue
    rh="$(awk -F'\t' -v p="$rel" '$2==p{print $1; exit}' "$repo")"
    if [ -z "$rh" ]; then
      only_src=$((only_src+1)); L_SRC+=("$rel")
    elif [ "$rh" != "$h" ]; then
      drift=$((drift+1)); L_DRIFT+=("$rel")
    else
      same=$((same+1))
    fi
  done < "$input"

  # And the repo side, for things that exist here and were not fingerprinted.
  while IFS=$'\t' read -r h rel; do
    [ -n "$rel" ] || continue
    if ! awk -F'\t' -v p="$rel" '$2==p{found=1; exit} END{exit !found}' "$input"; then
      only_repo=$((only_repo+1)); L_REPO+=("$rel")
    fi
  done < "$repo"
  rm -f "$repo" "$input"

  local p
  printf 'tool drift vs %s (%s)\n\n' "$ref" "$(git rev-parse --short "$ref")"

  if [ ${#L_DRIFT[@]} -gt 0 ]; then
    c_red "DRIFT — same path, different content. The reviewed copy is not the running copy:"
    for p in "${L_DRIFT[@]}"; do printf '  %s\n' "$p"; done; echo
  fi
  if [ ${#L_SRC[@]} -gt 0 ]; then
    c_red "UNVERSIONED — present at the source, absent from $ref. Never imported:"
    for p in "${L_SRC[@]}"; do printf '  %s\n' "$p"; done; echo
  fi
  if [ ${#L_REPO[@]} -gt 0 ]; then
    c_yel "NOT DEPLOYED — in $ref, not at the source. Usually fine (tests, docs):"
    for p in "${L_REPO[@]}"; do printf '  %s\n' "$p"; done; echo
  fi

  printf 'identical: %d   drifted: %d   unversioned: %d   not-deployed: %d\n' \
    "$same" "$drift" "$only_src" "$only_repo"

  # NOT-DEPLOYED is informational by default: the VPS legitimately does not hold
  # every test file. --strict makes it count, for a release check.
  if [ "$drift" -gt 0 ] || [ "$only_src" -gt 0 ]; then
    c_red "drift detected"; return $EXIT_DRIFT
  fi
  if [ "$strict" -eq 1 ] && [ "$only_repo" -gt 0 ]; then
    c_red "strict: $ref holds files the source does not"; return $EXIT_DRIFT
  fi
  c_grn "no drift"; return $EXIT_OK
}

usage() {
  cat <<EOF
$ME — compare the tools that RUN against the tools that are REVIEWED.

  $ME fingerprint [dir]        emit content fingerprints. Run this where the
                               tools run. Needs bash + coreutils; no git, no
                               network, no credential.

  $ME compare FILE [--ref R]   compare a fingerprint against a git ref
                               (default: main). Run inside a clone.
                               FILE may be '-' to read stdin.
                               --strict also fails when the ref holds files
                               the fingerprinted source does not.

Exit: 0 no drift · 2 refused · 3 drift detected.

Typical use, from the VPS tooling directory:
  ./$ME fingerprint > /tmp/vps.fp     # then bring that file to a clone
  ./$ME compare /tmp/vps.fp
EOF
}

main() {
  local mode="${1:-}"
  case "$mode" in
    fingerprint) shift; cmd_fingerprint "$@" ;;
    compare)     shift; cmd_compare "$@" ;;
    -h|--help|help) usage; exit $EXIT_OK ;;
    # Default is refusal. An unrecognised subcommand must never fall through to
    # a success exit — that is the TOG-201 defect, and it is a repo-wide rule.
    '') usage >&2; die "no subcommand given" ;;
    *)  usage >&2; die "unrecognised subcommand: $mode" ;;
  esac
}

main "$@"
