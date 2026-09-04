#!/usr/bin/env bash
# Regression suite for git_remote_credential_scan.sh — TOG-893.
#
# WHAT THIS PROTECTS. Three ways this scan can be wrong, in descending order of
# how badly it hurts:
#
#   1. It reports CLEAN when a credential is embedded. This is the dangerous
#      failure, because a clean sweep is what tells us the class is closed. The
#      motivating case is real: the detector as first drafted on TOG-893 used
#      `find -maxdepth 4`, which on this host saw 9 of 13 `.git/config` files
#      under the workspaces root and MISSED a credential-bearing config at
#      depth 9 (an Automation Engineer checkout at `<ws>/TOG-237-.../repo`).
#      The nesting case therefore has its own test, built from that shape.
#
#   2. It reports a finding that is not a credential. `https://x-access-token@`
#      — userinfo with no colon, hence no password — is what a CORRECT broker
#      setup looks like: the helper supplies the secret. The first sweep of
#      this host flagged one, so a third of the findings were noise aimed at a
#      repo already doing the right thing. Asserted both ways.
#
#   3. It prints the credential it found. A scanner whose output is pasted into
#      an issue must never be the thing that publishes the secret. Asserted
#      against a sentinel that appears nowhere in stdout or stderr.
#
# THE TRAP IN TESTING (1). A scan that matched nothing at all would pass "no
# credential in output" perfectly, and would also pass any test that only
# asserts CLEAN on a clean tree. So every negative assertion here is PAIRED
# with a positive one: the same fixture that must not flag the safe remote must
# still flag the unsafe one beside it. A suite that only checks for absence
# passes against a detector whose regex never matches, which is failure mode 1.
#
# Offline and credential-free by construction: every case builds throwaway
# `.git/config` files under a temp dir with fabricated token-shaped strings.
# No network, no real secret, no git invocation, no writes outside the temp dir.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${GIT_REMOTE_CREDENTIAL_SCAN_SH:-$HERE/git_remote_credential_scan.sh}"
PASS=0; FAIL=0

ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); [[ -n "${2:-}" ]] && printf '        %s\n' "$2"; }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

[[ -x "$TOOL" ]] || { echo "ERROR: $TOOL is not executable" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/test_git_remote_cred.XXXXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# ASSEMBLED AT RUNTIME, NEVER WRITTEN OUT WHOLE. The CI "Secret scan" step
# greps tracked files for /gh[pousr]_[A-Za-z0-9]{16,}/, and a literal
# token-shaped sentinel here matches it — this suite failed exactly that way on
# its first push. The scanner is right and the fixture was wrong: a repo that
# tolerates one committed token-shaped string has to decide, every time, which
# ones are pretend. Concatenating the prefix keeps the fixture realistic enough
# to exercise classify() while leaving no matchable literal in the file.
TOKEN_PREFIX="ghs"
SENTINEL="${TOKEN_PREFIX}_ZZTESTSENTINELDONOTPRINT0123456789abcdef"

# mkcfg <repo-dir> <url>
mkcfg() {
  mkdir -p "$1/.git"
  cat > "$1/.git/config" <<EOF
[core]
	repositoryformatversion = 0
[remote "origin"]
	url = $2
	fetch = +refs/heads/*:refs/remotes/origin/*
EOF
}

# --- fixtures --------------------------------------------------------------
ROOT="$WORK/roots"
# a) shallow, credential-bearing
mkcfg "$ROOT/ws/agent-a/two-bot" "https://x-access-token:${SENTINEL}@github.com/Org/two-bot.git"
# b) DEEPLY NESTED, credential-bearing -- the depth-4 miss, reproduced
mkcfg "$ROOT/ws/agent-b/TOG-237-model-router/repo" "https://x-access-token:${SENTINEL}@github.com/Org/router.git"
# c) username-only -- correct broker setup, must NOT be flagged
mkcfg "$ROOT/ws/agent-c/clean-userinfo" "https://x-access-token@github.com/Org/two-bot.git"
# d) plain https, no userinfo at all
mkcfg "$ROOT/ws/agent-d/plain" "https://github.com/Org/two-bot.git"
# e) ssh remote
mkcfg "$ROOT/ws/agent-e/ssh" "git@github.com:Org/two-bot.git"

hdr "1. Finds embedded credentials, including deeply nested ones"
OUT="$("$TOOL" --quiet "$ROOT" 2>&1)"; RC=$?
[[ $RC -eq 1 ]] && ok 'exit 1 when findings exist' || bad "expected exit 1, got $RC" "$OUT"
grep -q 'agent-a/two-bot' <<<"$OUT" \
  && ok 'flags the shallow credential-bearing remote' || bad 'missed shallow finding' "$OUT"
grep -q 'agent-b/TOG-237-model-router/repo' <<<"$OUT" \
  && ok 'flags the DEEPLY NESTED credential-bearing remote (the maxdepth-4 miss)' \
  || bad 'missed the nested finding -- this is the TOG-893 under-count bug' "$OUT"
grep -q 'kind=gh-app-installation-token' <<<"$OUT" \
  && ok 'classifies a ghs_ token' || bad 'did not classify ghs_' "$OUT"

hdr "2. Does not flag remotes that carry no secret"
grep -q 'agent-c/clean-userinfo' <<<"$OUT" \
  && bad 'flagged username-only userinfo -- that is a CORRECT broker remote' "$OUT" \
  || ok 'username-only https://x-access-token@ is not a finding'
grep -q 'agent-d/plain' <<<"$OUT" && bad 'flagged a plain https remote' "$OUT" \
  || ok 'plain https remote is not a finding'
grep -q 'agent-e/ssh' <<<"$OUT" && bad 'flagged an ssh remote' "$OUT" \
  || ok 'ssh remote is not a finding'
# Pairing guard for (2): the same run that stayed quiet on c/d/e must have
# found exactly the two real ones. Otherwise "no false positives" is vacuous.
n="$(grep -c '^FINDING' <<<"$OUT")"
[[ "$n" -eq 2 ]] && ok 'exactly 2 findings -- negatives are not vacuous' \
  || bad "expected exactly 2 findings, got $n" "$OUT"

hdr "3. Never prints the credential"
grep -qF "$SENTINEL" <<<"$OUT" \
  && bad 'THE SCANNER PRINTED THE SECRET' || ok 'sentinel token absent from output'
# also assert on a non-quiet run, both streams
OUT2="$("$TOOL" "$ROOT" 2>&1)"
grep -qF "$SENTINEL" <<<"$OUT2" \
  && bad 'secret printed on the default (non-quiet) path' || ok 'sentinel absent on default path too'

hdr "4. Clean tree reports clean"
CLEANROOT="$WORK/cleanroot"
mkcfg "$CLEANROOT/ws/agent-z/ok" "https://github.com/Org/x.git"
OUT3="$("$TOOL" "$CLEANROOT" 2>&1)"; RC3=$?
[[ $RC3 -eq 0 ]] && ok 'exit 0 on a clean tree' || bad "expected exit 0, got $RC3" "$OUT3"
grep -q '^CLEAN' <<<"$OUT3" && ok 'prints a CLEAN banner' || bad 'no CLEAN banner' "$OUT3"
grep -q 'scanned 1 ' <<<"$OUT3" \
  && ok 'reports how many configs it scanned (a CLEAN that looked nowhere is not clean)' \
  || bad 'did not report scan count' "$OUT3"

hdr "5. A CLEAN that looked nowhere is an error, not a pass"
OUT4="$("$TOOL" "$WORK/does-not-exist" 2>&1)"; RC4=$?
[[ $RC4 -eq 2 ]] && ok 'exit 2 when no requested root exists' || bad "expected exit 2, got $RC4" "$OUT4"

hdr "6. Bad usage is rejected"
"$TOOL" --max-depth notanumber "$ROOT" >/dev/null 2>&1
[[ $? -eq 2 ]] && ok 'non-numeric --max-depth exits 2' || bad 'accepted a non-numeric depth'
"$TOOL" --bogus-flag >/dev/null 2>&1
[[ $? -eq 2 ]] && ok 'unknown flag exits 2' || bad 'accepted an unknown flag'

hdr "7. MUTATION: the depth bug this detector was written to avoid"
# Reintroduce the original -maxdepth 4 via the supported flag and assert the
# suite would have caught it. This proves test 1 is load-bearing rather than
# passing for an unrelated reason.
OUT5="$("$TOOL" --quiet --max-depth 4 "$ROOT" 2>&1)"
if grep -q 'TOG-237-model-router/repo' <<<"$OUT5"; then
  bad 'depth-4 still found the nested config -- fixture is not deep enough to be a real guard'
else
  ok 'depth-4 provably misses the nested finding; unbounded default is load-bearing'
fi

hdr "8. This suite does not itself trip the CI Secret scan"
# The fixture sentinel must stay assembled at runtime. If someone inlines it
# again, CI's Secret scan fails the whole job for a pretend token — which is
# how this suite first went red. Asserted with CI's own regex against this
# file, so the guard tracks the real gate rather than a paraphrase of it.
if command grep -nIE '(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})' "${BASH_SOURCE[0]}" >/dev/null 2>&1; then
  bad 'this file contains a token-shaped literal; CI Secret scan will fail the job'
else
  ok 'no token-shaped literal committed in this suite'
fi
# Pairing guard: the regex must actually be capable of matching, or test 8 is
# vacuous and would pass against any file at all.
if printf 'url=https://x:%s@h/r.git\n' "$SENTINEL" \
     | command grep -qIE '(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})'; then
  ok 'control — that regex does match the assembled sentinel, so test 8 is not vacuous'
else
  bad 'the Secret-scan regex matched nothing even against the sentinel; test 8 proves nothing'
fi

hdr "Result"
printf '  %d passed, %d failed\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]] || exit 1
