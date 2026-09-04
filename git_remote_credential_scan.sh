#!/usr/bin/env bash
# ===========================================================================
# git_remote_credential_scan.sh — credentials embedded in git remote URLs.
# TOG-893.
#
# THE THING BEING MEASURED. A broker token is supposed to live for exactly one
# push, inside a credential-helper invocation. Writing it into the remote URL
# instead —
#
#     git remote set-url origin https://x-access-token:$TOK@github.com/o/r.git
#
# — puts it in `.git/config`, which is a file on disk that nobody rewrites when
# the run ends. Every agent on this host runs as the same uid (TOG-191) and
# these configs are mode 644, so the credential is readable by every subsequent
# run, and is printed in cleartext by anything that enumerates remotes.
#
# THIS IS NOT THE SAME CHECK AS credential_chain_audit.sh. That one asks who can
# SUBSTITUTE the credential helper; credential_chain_lockdown.sh explicitly
# records per-repo `.git/config` as residual-by-design for that question,
# because agents must be able to configure their own checkouts. The residue it
# waves through is config a repo legitimately owns. What it does not ask, and
# what this asks, is whether that config contains a SECRET. Those are different
# properties of the same file and the first does not imply the second.
#
# WHY THE EMBEDDED TOKEN ALSO BREAKS THE BROKER — measured, not reasoned.
# git consults a credential helper only when the request it builds has no
# password. A URL of the form `https://user:token@host` supplies one, so the
# helper is never run. Verified 2026-09-03 with a logging helper:
#
#     request carries password=DEAD_TOKEN  -> helper NOT consulted, dead token used
#     request carries no password          -> helper consulted, fresh token returned
#
# So an expired embedded token is not merely stale residue that fails closed —
# it actively suppresses the working broker path and makes pushes fail with a
# credential that cannot be refreshed. Scrubbing the URL is a repair, not just
# hygiene. That is the argument for fixing these rather than waiting them out.
#
# TWO WAYS THE OBVIOUS ONE-LINER GETS THIS WRONG. Both were measured against
# this host on 2026-09-03, and both are asserted in test_git_remote_credential_scan.sh:
#
#   1. DEPTH. `find -maxdepth 4` reads naturally but is wrong. Checkouts nest:
#      an issue-scoped subdirectory, a `repo/` wrapper, a git worktree. On this
#      host that flag saw 9 of 13 `.git/config` files under the workspaces root
#      and missed a real credential-bearing one at depth 9. This scan is
#      unbounded by default. A sweep that silently under-counts is worse than
#      no sweep, because it reports CLEAN.
#
#   2. USERINFO WITHOUT A PASSWORD. `https://x-access-token@github.com/...` is
#      a username-only remote. It carries NO secret — it is what a correct
#      broker setup looks like, since the helper supplies the password. A regex
#      of `https://[^/@]+@` flags it anyway. One of the three hits on the first
#      sweep of this host was exactly that, i.e. a third of the findings were
#      noise pointing at a repo that was already doing the right thing. A
#      credential requires a COLON inside the userinfo, and that is what this
#      matches.
#
# NOTE ALSO, for anyone auditing this class by hand: on this host `grep` is a
# shell function that injects `--exclude-dir=.git`. `grep -r <tok> repo/.git`
# therefore returns nothing while `grep <tok> repo/.git/config` matches — a
# silent false CLEAN on precisely this search. This script never recurses with
# grep; it enumerates with `find` and reads each config directly.
#
# WHAT THIS WILL NOT DO. It never prints a credential, and never writes. Output
# is repo path, line number, credential kind, and file mode — the metadata you
# need to route the fix, none of the secret. Findings are reported by shape;
# whether a given token is still live is a separate question answered by
# attempting it, deliberately not automated here (a scanner that authenticates
# with every secret it finds is its own incident).
#
# Exit codes:
#   0  CLEAN     -- no remote URL carries a credential.
#   1  FINDINGS  -- at least one does.
#   2  usage / internal error.
# ===========================================================================
set -uo pipefail

DEFAULT_ROOTS=(
  /paperclip/instances/default/workspaces
  /paperclip/instances/default/projects
)

MAXDEPTH=""
QUIET=0
declare -a ROOTS=()

usage() {
  cat <<'USAGE'
Usage: git_remote_credential_scan.sh [--max-depth N] [--quiet] [ROOT ...]

Scans every .git/config under ROOT for remote URLs that embed a credential.
Defaults to the workspaces and projects roots. Never prints the credential.

  --max-depth N   limit find depth (default: unlimited -- see header, a bounded
                  depth missed a real finding on this host)
  --quiet         findings only, no CLEAN banner
Exit: 0 clean, 1 findings, 2 usage/internal error.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --max-depth) [[ $# -ge 2 ]] || { echo "ERROR: --max-depth needs a value" >&2; exit 2; }
                 [[ "$2" =~ ^[0-9]+$ ]] || { echo "ERROR: --max-depth must be a number" >&2; exit 2; }
                 MAXDEPTH="$2"; shift 2 ;;
    --quiet)     QUIET=1; shift ;;
    -h|--help)   usage; exit 0 ;;
    --)          shift; while [[ $# -gt 0 ]]; do ROOTS+=("$1"); shift; done ;;
    -*)          echo "ERROR: unknown option $1" >&2; usage >&2; exit 2 ;;
    *)           ROOTS+=("$1"); shift ;;
  esac
done

[[ ${#ROOTS[@]} -eq 0 ]] && ROOTS=("${DEFAULT_ROOTS[@]}")

# Keep only roots that exist; a missing root is not an error (the projects root
# is absent in some containers) but ALL roots missing is, because then a CLEAN
# result would mean "looked nowhere".
declare -a LIVE_ROOTS=()
for r in "${ROOTS[@]}"; do
  [[ -d "$r" ]] && LIVE_ROOTS+=("$r")
done
if [[ ${#LIVE_ROOTS[@]} -eq 0 ]]; then
  echo "ERROR: none of the requested roots exist: ${ROOTS[*]}" >&2
  exit 2
fi

# Classify by token shape. Kept deliberately coarse: the point is to route the
# fix, and a finding is a finding whatever the prefix.
classify() {
  case "$1" in
    *ghs_*)         echo "gh-app-installation-token" ;;
    *ghp_*)         echo "classic-PAT" ;;
    *github_pat_*)  echo "fine-grained-PAT" ;;
    *gho_*)         echo "oauth-token" ;;
    *ghu_*)         echo "user-to-server-token" ;;
    *)              echo "unknown-secret" ;;
  esac
}

declare -a FIND_ARGS=("${LIVE_ROOTS[@]}")
[[ -n "$MAXDEPTH" ]] && FIND_ARGS+=(-maxdepth "$MAXDEPTH")
# -path matches the ordinary repo layout; a linked worktree has .git as a FILE
# pointing at the parent's .git/worktrees/<name>, and its remotes live in the
# parent config, which this already enumerates on its own.
FIND_ARGS+=(-type f -path '*/.git/config')

FOUND=0
SCANNED=0

while IFS= read -r cfg; do
  SCANNED=$((SCANNED + 1))
  repo="$(dirname "$(dirname "$cfg")")"
  [[ -r "$cfg" ]] || { echo "INDET repo=$repo reason=config-unreadable"; continue; }

  # The COLON is the whole point: userinfo without one is a username, not a
  # secret. Anchored to a url= key so a comment or an unrelated value cannot
  # trip it.
  while IFS= read -r hit; do
    [[ -z "$hit" ]] && continue
    lineno="${hit%%:*}"
    body="${hit#*:}"
    kind="$(classify "$body")"
    perms="$(stat -c '%U:%G %a' "$cfg" 2>/dev/null || echo 'unknown')"
    host="$(printf '%s' "$body" | sed -nE 's#.*@([^/[:space:]]+)/.*#\1#p')"
    printf 'FINDING repo=%s config_line=%s kind=%s host=%s perms=%s\n' \
      "$repo" "$lineno" "$kind" "${host:-unknown}" "$perms"
    FOUND=1
  done < <(command grep -nE \
      '^[[:space:]]*url[[:space:]]*=[[:space:]]*[a-zA-Z+.-]+://[^:/@[:space:]]+:[^@[:space:]]+@' \
      "$cfg" 2>/dev/null)
done < <(find "${FIND_ARGS[@]}" 2>/dev/null | sort)

if [[ $FOUND -eq 0 ]]; then
  [[ $QUIET -eq 1 ]] || echo "CLEAN: scanned $SCANNED git config(s); no remote URL embeds a credential"
  exit 0
fi
echo "-- scanned $SCANNED git config(s); remediate with: git remote set-url <name> <url-without-credential>"
exit 1
