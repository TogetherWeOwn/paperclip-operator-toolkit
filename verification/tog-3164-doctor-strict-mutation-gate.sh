#!/usr/bin/env bash
# TOG-3164 — mutation gate for section 11 of test_gh_app_token.sh.
#
# Section 11 went green the moment it was written, which on its own is worth
# nothing: a spec that passes against the BROKEN code is the failure mode this
# company keeps paying for. This gate reintroduces the defect three ways and
# requires the suite to go RED each time. If any mutant survives, the assertion
# it was supposed to trip is decorative and this gate fails loudly.
#
# The three mutants are deliberately independent — each maps to one clause of
# the fix, so a partial revert cannot hide behind the other two:
#
#   M1  token()  ->  token({})       the original line 787. `{}` is truthy, so
#                                    token() skips currentScope() and strict
#                                    reports gaps in a hardcoded empty scope.
#   M2  remove the bestEffort throw  `die()` exits again, so doctor's catch is
#                                    inert and the report dies with the lookup.
#   M3  drop the reason from the     the caller is told the lookup failed but
#       gitIdentity.error message    not that a SCOPE refusal caused it.
#
# Offline: test_gh_app_token.sh stubs the GitHub API on 127.0.0.1 and runs the
# tool under `env -i`. No credential, no network, no mint.
#
# A mutant is only KILLED by a non-zero suite exit. A suite that CRASHES also
# exits non-zero, so each mutant additionally has to leave the baseline
# recoverable — checked by re-running the clean suite at the end.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOL="$HERE/gh-app-token.js"
SUITE="$HERE/test_gh_app_token.sh"
BACKUP="$(mktemp)"
FAILED=0

[[ -f "$TOOL" && -x "$SUITE" ]] || { echo "tog-3164 gate: $TOOL or $SUITE missing" >&2; exit 2; }
cp "$TOOL" "$BACKUP"

# An interrupted gate must never leave its mutant applied: the NEXT run then
# reports a broken baseline naming a file the caller's branch never touched.
restore() { cp "$BACKUP" "$TOOL"; }
trap 'restore; rm -f "$BACKUP"' EXIT
trap 'restore; rm -f "$BACKUP"; exit 130' INT TERM

# Anchors are asserted UNIQUE before use. A mutation applied to 0 sites is a
# no-op that the suite passes for the right reason — indistinguishable from a
# surviving mutant unless it is caught here.
count_anchor() { # count_anchor <literal>
  perl -0ne 'BEGIN{$n=shift @ARGV} $c=()=/\Q$n\E/g; print "$c\n"' "$1" "$TOOL"
}

mutate() { # mutate <name> <literal-from> <literal-to>
  local name="$1" from="$2" to="$3" n
  n="$(count_anchor "$from")"
  if [[ "$n" != "1" ]]; then
    echo "  BROKEN GATE: $name anchor matched $n sites (expected exactly 1)" >&2
    echo "    anchor: $from" >&2
    FAILED=1
    return 1
  fi
  perl -0pi -e 'BEGIN{($f,$t)=(shift @ARGV, shift @ARGV)} s/\Q$f\E/$t/' "$from" "$to" "$TOOL"
}

run_mutant() { # run_mutant <name> <from> <to>
  local name="$1"
  printf '\n\033[1m%s\033[0m\n' "$name"
  restore
  mutate "$@" || { restore; return; }
  if "$SUITE" >/dev/null 2>&1; then
    printf '  \033[31mSURVIVED\033[0m  suite stayed green with the defect reintroduced — section 11 does not cover this\n'
    FAILED=1
  else
    printf '  \033[32mKILLED\033[0m    suite went red, as it must\n'
  fi
  restore
}

printf '\033[1mTOG-3164 mutation gate — doctor under GH_APP_SCOPE_STRICT=1\033[0m\n'

# Baseline first. A gate whose baseline is red kills every mutant for the wrong
# reason and reports a clean sweep.
printf '\n\033[1mbaseline (unmutated)\033[0m\n'
if "$SUITE" >/dev/null 2>&1; then
  printf '  \033[32mGREEN\033[0m     baseline suite passes\n'
else
  printf '  \033[31mBROKEN GATE\033[0m  baseline suite is RED before any mutant was applied\n'
  "$SUITE" 2>&1 | grep -E 'FAIL|RESULT' | head -20
  FAILED=1
fi

run_mutant "M1  token() -> token({})  (the original defect)" \
  'const u = await gh(`/users/${encodeURIComponent(login)}`, { token: await token() })' \
  'const u = await gh(`/users/${encodeURIComponent(login)}`, { token: await token({}) })'

run_mutant "M2  die() exits again, so doctor's catch is inert" \
  '  if (bestEffortDepth > 0) throw new Error(msg)' \
  '  if (false) throw new Error(msg)'

run_mutant "M3  gitIdentity.error drops the reason" \
  'gitIdentity = { error: `could not resolve bot user id; set user.email manually — ${why}` }' \
  'gitIdentity = { error: `could not resolve bot user id; set user.email manually` }'

# The mutants are only trustworthy if the file came back intact.
printf '\n\033[1mbaseline recovered\033[0m\n'
if cmp -s "$BACKUP" "$TOOL" && "$SUITE" >/dev/null 2>&1; then
  printf '  \033[32mGREEN\033[0m     gh-app-token.js restored byte-for-byte and the suite is green again\n'
else
  printf '  \033[31mBROKEN GATE\033[0m  gh-app-token.js was not restored cleanly\n'
  FAILED=1
fi

if [[ "$FAILED" -eq 0 ]]; then
  printf '\n\033[1mRESULT: all 3 mutants killed\033[0m\n'
else
  printf '\n\033[1mRESULT: gate FAILED\033[0m\n'
fi
exit "$FAILED"
