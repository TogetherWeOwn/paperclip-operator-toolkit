#!/usr/bin/env bash
# ===========================================================================
# Public-comment hygiene gate.
#
# THE FAILURE THIS STOPS. Review automation posted issue comments carrying
# internal card IDs onto PUBLIC repos (several comments in two different
# threads), violating the organisation's GitHub standard: no internal tracker
# IDs in any public title, body, comment or branch name. The in-repo `pr-lint`
# check enforces that rule for PR titles and bodies only -- comment text goes
# through no gate at all, which is the hole those comments fell through.
#
# WHAT THIS IS. An offline pre-post check: hand it the exact text you are
# about to post (and, for PR work, the branch name) plus the repo visibility,
# and it fails when a public post would carry an internal ID. Private repos
# always pass -- IDs belong there (for example a `Refs:` line citing a card).
# Run it before every `gh api .../comments` POST/PATCH, every review-submit
# body, and every push of a branch destined for a public repo. It never
# touches the network and never needs a credential, so there is no reason to
# skip it.
#
# WHAT THIS IS NOT. It cannot scrub what is already posted (that needs a
# GitHub-admin write), and it does not scan live threads -- re-scanning
# posted threads is a `gh api ... | grep` one-liner, not this script's job.
#
# Prefix set matches `pr-lint` (`INTERNAL_ID_PREFIXES`, default TOG|PAP|PAPA)
# so the two gates never disagree about what an "internal ID" is.
#
# Exit codes:
#   0  PASS     -- safe to post (private repo, or public with no internal IDs).
#   1  VIOLATION-- public text carries at least one internal ID. Do not post.
#   2  usage / internal error (missing file, bad visibility, unreadable or
#        non-regular input, or a scanner failure). Never report PASS after a
#        scan failure: grep exit 1 (no match) is the only clean signal.
# ===========================================================================

set -uo pipefail

VISIBILITY=""
BODY_FILE=""
BRANCH=""
CONTEXT="comment"

usage() {
  cat <<'EOF'
Usage: public_comment_hygiene_gate.sh --visibility public|private --body-file FILE [--branch NAME] [--context LABEL]

  Fails when text destined for a PUBLIC repo carries an internal card ID
  (a configured prefix, a dash and digits). Private repos always pass.

  --visibility   public|private (required)
  --body-file    file holding the exact text to be posted (required)
  --branch       branch the work will ship on; checked too when public
  --context      label used in failure lines (default: comment)

Exit: 0 pass, 1 violation, 2 usage/internal error.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --visibility) VISIBILITY="${2:-}"; shift 2 || { echo "ERROR: --visibility needs a value" >&2; exit 2; } ;;
    --visibility=*) VISIBILITY="${1#*=}"; shift ;;
    --body-file) BODY_FILE="${2:-}"; shift 2 || { echo "ERROR: --body-file needs a value" >&2; exit 2; } ;;
    --body-file=*) BODY_FILE="${1#*=}"; shift ;;
    --branch) BRANCH="${2:-}"; shift 2 || { echo "ERROR: --branch needs a value" >&2; exit 2; } ;;
    --branch=*) BRANCH="${1#*=}"; shift ;;
    --context) CONTEXT="${2:-}"; shift 2 || { echo "ERROR: --context needs a value" >&2; exit 2; } ;;
    --context=*) CONTEXT="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$VISIBILITY" in
  public|private) ;;
  *) echo "ERROR: --visibility must be public|private, got '${VISIBILITY:-}'" >&2; exit 2 ;;
esac
if [[ -z "$BODY_FILE" ]]; then echo "ERROR: --body-file is required" >&2; exit 2; fi
if [[ ! -r "$BODY_FILE" ]]; then echo "ERROR: body file not readable: $BODY_FILE" >&2; exit 2; fi
if [[ ! -f "$BODY_FILE" ]]; then echo "ERROR: body file is not a regular file: $BODY_FILE" >&2; exit 2; fi

# Private repos carry IDs by policy. Nothing to check; the file read above is
# the only validation a private post needs.
if [[ "$VISIBILITY" == "private" ]]; then exit 0; fi

PREFIXES="${INTERNAL_ID_PREFIXES:-TOG|PAP|PAPA}"
# \b keeps TOGETHER / PAPER trails out of the match; the suite pins both sides.
PATTERN="\b(${PREFIXES})-[0-9]+\b"

VIOLATIONS=0

# grep exit 0 = match, 1 = no match, >1 = execution error. An error must
# never read as "no matches" (the old `|| true` did exactly that), so each
# scan below branches on the exit code explicitly and exits 2 on error.
BODY_HITS=""; body_rc=0
BODY_HITS="$(grep -nE -o "$PATTERN" "$BODY_FILE" 2>/dev/null)" || body_rc=$?
if (( body_rc > 1 )); then
  echo "ERROR: body scan failed (exit $body_rc); refusing to report PASS: $BODY_FILE" >&2
  exit 2
fi
if (( body_rc == 0 )); then
  VIOLATIONS=1
  while IFS= read -r hit; do
    echo "VIOLATION [$CONTEXT body line ${hit%%:*}]: carries internal ID ${hit#*:}" >&2
  done <<<"$BODY_HITS"
fi

if [[ -n "$BRANCH" ]]; then
  BRANCH_HIT=""; branch_rc=0
  BRANCH_HIT="$(printf '%s' "$BRANCH" | grep -E -o "$PATTERN" 2>/dev/null)" || branch_rc=$?
  if (( branch_rc > 1 )); then
    echo "ERROR: branch scan failed (exit $branch_rc); refusing to report PASS" >&2
    exit 2
  fi
  if (( branch_rc == 0 )); then
    VIOLATIONS=1
    echo "VIOLATION [$CONTEXT branch '$BRANCH']: carries internal ID $BRANCH_HIT" >&2
  fi
fi

if [[ "$VIOLATIONS" -ne 0 ]]; then
  echo "VERDICT: VIOLATION -- public $CONTEXT carries internal ID(s); do not post. Link the Paperclip card in the private board thread/work-product instead." >&2
  exit 1
fi
exit 0
