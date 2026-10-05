#!/usr/bin/env bash
# secret-scan.sh -- the repo's "no secrets, ever" assertion as a standalone
# script. It always runs, even when every other suite is skipped by path
# gating, because a committed secret can land in any file.
# Scans TRACKED files only: anything .gitignore covers is by definition not in
# the repo, and scanning the working tree would fail on an operator's local
# scratch files. test_gh_app_token.sh assembles its canaries from fragments at
# runtime precisely so this scan does not trip on the suite.
# Exit 0 clean, 1 finding. Offline, git + grep only.
set -uo pipefail

rc=0
# git grep searches tracked files only, which is the scope we want.
# Live GitHub credentials of every prefix, and private key material.
if git grep -nIE '(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})'; then
  echo "::error::a GitHub-token-shaped string is committed"; rc=1
fi
if git grep -nIE 'BEGIN (RSA |EC |OPENSSH |PGP |ENCRYPTED |DSA )?PRIVATE KEY'; then
  echo "::error::private key material is committed"; rc=1
fi
# The .gitignore entries other steps and the tools depend on. Losing
# one is silent until the day something lands in a commit.
# __pycache__/ and *.pyc are on this list because the Offline job COMPILES
# this repo's Python on every run, so a runner reliably has untracked .pyc
# on disk. A .pyc carries its source, and this repo's Python reads a
# management key.
for pat in '*.env' '*.pem' '*.key' '*.jsonl' '.gh-app-token.json' '__pycache__/' '*.pyc'; do
  grep -qxF "$pat" .gitignore || { echo "::error::.gitignore no longer covers $pat"; rc=1; }
done
[ $rc -eq 0 ] && echo "secret scan: clean"
exit $rc
