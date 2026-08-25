#!/usr/bin/env bash
# ===========================================================================
# test_gh_permission_pin_audit.sh — TOG-346.
#
# gh_permission_pin_audit.sh is a drift detector for a value that no project
# reads any more.  A detector is worth exactly what its failure modes are worth,
# and there are only two that matter:
#
#   fail-open   it reports clean on a state that is not clean.  Every check
#               below that ends in "exit 1" is guarding this direction: a pin
#               that lost a permission, a project nobody registered, a registry
#               line whose project is gone, a `secret_ref` where a literal is
#               required, a baseline that no longer matches the code.
#
#   cry-wolf    it reports drift on a correct state, gets muted, and then the
#               fail-open cases stop being read at all.  The live pins are
#               hand-written and their key order differs between projects, so
#               "key order is not drift" is a first-class assertion here rather
#               than an implementation detail.  tool_drift.sh's header states
#               the same rule; the credential-chain pin file learned it by
#               crying wolf on the correct state after TOG-238.
#
# And one that is worse than either: a run that establishes NOTHING and exits 0.
# An unreachable board, a scope.js whose export was renamed, and a project list
# that parsed to zero rows must all be INDETERMINATE (exit 3), because
# `[[ "$n" -eq 0 ]]` is true for a variable that was never assigned, and a
# zero-findings report is indistinguishable from a zero-projects report unless
# the exit code says so.
#
# Entirely offline: every case builds its own registry, its own scope module and
# its own project list.  No socket is opened, no credential is read, and the
# real permission_pins.txt is exercised only through the fixture that mirrors
# the values measured on the live board 2026-08-25.
#
# Exit: 0 all assertions held | 1 at least one did not | 2 setup error
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE" || exit 2

AUDIT="$HERE/gh_permission_pin_audit.sh"
REAL_REGISTRY="$HERE/permission_pins.txt"
REAL_SCOPE="$HERE/plugins/gh-token-broker/dist/scope.js"

for f in "$AUDIT" "$REAL_REGISTRY" "$REAL_SCOPE"; do
  [[ -r "$f" ]] || { echo "ERROR: missing $f" >&2; exit 2; }
done
command -v jq   >/dev/null 2>&1 || { echo "ERROR: jq is required" >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo "ERROR: node is required" >&2; exit 2; }

TMP="$(mktemp -d "${PAPERCLIP_RUN_SCRATCH_DIR:-${TMPDIR:-/tmp}}/tog346-XXXXXX")" || exit 2
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

PASS=0; FAIL=0
ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); shift; [[ $# -gt 0 ]] && sed 's/^/        /' <<<"$*"; }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

DEFAULT_SPEC='contents=write,pull_requests=write,issues=write,metadata=read,checks=read,statuses=read'
OPS=f2dc52a4-256f-4766-aec5-52a94ca387e2
ONB=88f949ff-b719-4aa3-a80f-f3c6e9321906

# write_scope <file> <name=level ...>
# A stand-in for the broker's scope module.  Only the export this audit reads is
# needed, and building it here rather than editing the real one keeps the suite
# from depending on the current value of the default.
write_scope() {
  local out="$1"; shift
  { printf 'export const DEFAULT_PERMISSION_PROFILE = Object.freeze({\n'
    local kv
    for kv in "$@"; do printf '  %s: "%s",\n' "${kv%%=*}" "${kv#*=}"; done
    printf '});\n'
  } > "$out"
}

# write_registry <file> <baseline-spec> <body-lines...>
write_registry() {
  local out="$1" base="$2"; shift 2
  { printf '# fixture\n'
    printf 'baseline  -  -  %s  fixture baseline\n' "$base"
    local l
    for l in "$@"; do printf '%s\n' "$l"; done
  } > "$out"
}

# projects_json <file> <id:name:permsjson ...> where permsjson is raw JSON or `-`
projects_json() {
  local out="$1"; shift
  local first=1
  { printf '['
    local spec id name perms
    for spec in "$@"; do
      id="${spec%%:*}"; spec="${spec#*:}"
      name="${spec%%:*}"; perms="${spec#*:}"
      [[ $first -eq 1 ]] || printf ','
      first=0
      if [[ "$perms" == "-" ]]; then
        printf '{"id":"%s","name":"%s","env":{"GH_APP_REPOS":{"type":"plain","value":"r"}}}' "$id" "$name"
      else
        printf '{"id":"%s","name":"%s","env":{"GH_APP_REPOS":{"type":"plain","value":"r"},"GH_APP_PERMISSIONS":%s}}' \
          "$id" "$name" "$perms"
      fi
    done
    printf ']\n'
  } > "$out"
}

plain() { printf '{"type":"plain","value":"%s"}' "$1"; }

# run_audit <registry> <scope> <projects-json> [extra args...] -> sets OUT / RC
run_audit() {
  local reg="$1" scope="$2" proj="$3"; shift 3
  OUT="$(PERMISSION_PIN_PROJECTS_JSON="$proj" \
         "$AUDIT" --registry "$reg" --scope-file "$scope" "$@" 2>&1)"
  RC=$?
}

# expect <desc> <want-rc> <must-contain> <registry> <scope> <projects> [args...]
expect() {
  local desc="$1" want="$2" needle="$3"; shift 3
  run_audit "$@"
  if [[ "$RC" != "$want" ]]; then
    bad "$desc (want exit $want, got $RC)" "$OUT"; return
  fi
  if [[ -n "$needle" ]] && ! grep -q -- "$needle" <<<"$OUT"; then
    bad "$desc (exit $RC as expected, but output lacks '$needle')" "$OUT"; return
  fi
  ok "$desc"
}

# --- the standard world ----------------------------------------------------
SCOPE="$TMP/scope.js"
write_scope "$SCOPE" contents=write pull_requests=write issues=write \
  metadata=read checks=read statuses=read

REG="$TMP/registry.txt"
write_registry "$REG" "$DEFAULT_SPEC" \
  "verbatim  $ONB  onboarding  -  pinned to the verbatim default" \
  "delta     $OPS  ops-tooling  +workflows=write  GitHub refuses a merge touching .github/workflows/** without it"

CLEAN="$TMP/clean.json"
projects_json "$CLEAN" \
  "$ONB:Onboarding:$(plain "$DEFAULT_SPEC")" \
  "$OPS:Ops Tooling:$(plain "$DEFAULT_SPEC,workflows=write")"

# ---------------------------------------------------------------------------
hdr "1. The clean state is clean, and says what it checked"

expect "a matching board and registry exits 0" 0 "0 finding(s)" "$REG" "$SCOPE" "$CLEAN"
expect "the baseline row reports the comparison it made" 0 \
  "registry baseline == DEFAULT_PERMISSION_PROFILE" "$REG" "$SCOPE" "$CLEAN"

# The cry-wolf direction, and the reason comparison is over sets.  Ops Tooling
# writes workflows in the middle of its list and Community Platform at the end;
# both are correct and a string compare calls both wrong.
SHUFFLED="$TMP/shuffled.json"
projects_json "$SHUFFLED" \
  "$ONB:Onboarding:$(plain 'statuses=read,metadata=read,issues=write,checks=read,pull_requests=write,contents=write')" \
  "$OPS:Ops Tooling:$(plain 'contents=write,pull_requests=write,issues=write,metadata=read,workflows=write,checks=read,statuses=read')"
expect "a different key ORDER is not drift" 0 "0 finding(s)" "$REG" "$SCOPE" "$SHUFFLED"

# ---------------------------------------------------------------------------
hdr "2. Fail-open: a pin that no longer matches its registry line"

NARROWED="$TMP/narrowed.json"
projects_json "$NARROWED" \
  "$ONB:Onboarding:$(plain 'contents=write,pull_requests=write,issues=write,metadata=read')" \
  "$OPS:Ops Tooling:$(plain "$DEFAULT_SPEC,workflows=write")"
expect "a pin that lost two permissions is DRIFT" 1 "DRIFT" "$REG" "$SCOPE" "$NARROWED"

WIDENED="$TMP/widened.json"
projects_json "$WIDENED" \
  "$ONB:Onboarding:$(plain "$DEFAULT_SPEC,workflows=write")" \
  "$OPS:Ops Tooling:$(plain "$DEFAULT_SPEC,workflows=write")"
expect "a pin that gained workflows:write without a registry line is DRIFT" 1 \
  "DRIFT" "$REG" "$SCOPE" "$WIDENED"

RAISED="$TMP/raised.json"
projects_json "$RAISED" \
  "$ONB:Onboarding:$(plain 'contents=write,pull_requests=write,issues=write,metadata=read,checks=write,statuses=read')" \
  "$OPS:Ops Tooling:$(plain "$DEFAULT_SPEC,workflows=write")"
expect "a LEVEL raised from read to write is DRIFT, not just a key change" 1 \
  "DRIFT" "$REG" "$SCOPE" "$RAISED"

# ---------------------------------------------------------------------------
hdr "3. Fail-open: a project the registry does not describe"

ABSENT="$TMP/absent.json"
projects_json "$ABSENT" \
  "$ONB:Onboarding:-" \
  "$OPS:Ops Tooling:$(plain "$DEFAULT_SPEC,workflows=write")"
expect "a project with no pin, where one is registered, is UNPINNED" 1 \
  "UNPINNED" "$REG" "$SCOPE" "$ABSENT"

# scope.js treats a secret_ref as ABSENT rather than stringifying it, so a pin
# bound that way grants nothing and the project silently takes the default.
# An audit that read the binding as "a pin is present" would report OK on it.
SECRET="$TMP/secretref.json"
projects_json "$SECRET" \
  "$ONB:Onboarding:{\"type\":\"secret_ref\",\"secretId\":\"deadbeef\",\"version\":\"latest\"}" \
  "$OPS:Ops Tooling:$(plain "$DEFAULT_SPEC,workflows=write")"
expect "a secret_ref pin is treated as ABSENT, exactly as the broker treats it" 1 \
  "UNPINNED" "$REG" "$SCOPE" "$SECRET"

EXTRA="$TMP/extra.json"
projects_json "$EXTRA" \
  "$ONB:Onboarding:$(plain "$DEFAULT_SPEC")" \
  "$OPS:Ops Tooling:$(plain "$DEFAULT_SPEC,workflows=write")" \
  "aaaaaaaa-1111-2222-3333-444444444444:Newly Created:$(plain "$DEFAULT_SPEC")"
expect "a project nobody registered is UNREGISTERED, not ignored" 1 \
  "UNREGISTERED" "$REG" "$SCOPE" "$EXTRA"

GONE="$TMP/gone.json"
projects_json "$GONE" "$ONB:Onboarding:$(plain "$DEFAULT_SPEC")"
expect "a registered project the board does not return is MISSING" 1 \
  "MISSING" "$REG" "$SCOPE" "$GONE"

BROKEN="$TMP/broken.json"
projects_json "$BROKEN" \
  "$ONB:Onboarding:$(plain 'contents,pull_requests=write')" \
  "$OPS:Ops Tooling:$(plain "$DEFAULT_SPEC,workflows=write")"
expect "a pin that is not name=level is INVALID, not silently empty" 1 \
  "INVALID" "$REG" "$SCOPE" "$BROKEN"

# ---------------------------------------------------------------------------
hdr "4. The headline check: the registry baseline against the live default"
# This is the half that makes a change to DEFAULT_PERMISSION_PROFILE visible.
# Every project row below a drifted baseline is comparing pins to a profile that
# no longer exists, so the verdict has to be reported on the baseline itself and
# not inferred from seven green project rows.

MOVED="$TMP/scope-moved.js"
write_scope "$MOVED" contents=write pull_requests=write issues=write \
  metadata=read checks=read statuses=read actions=read
expect "a permission ADDED to the default without a re-audit is BASELINE-DRIFT" 1 \
  "BASELINE-DRIFT" "$REG" "$MOVED" "$CLEAN"

NARROW="$TMP/scope-narrow.js"
write_scope "$NARROW" contents=write pull_requests=write issues=write metadata=read
expect "a permission REMOVED from the default is BASELINE-DRIFT — the case that matters" 1 \
  "BASELINE-DRIFT" "$REG" "$NARROW" "$CLEAN"

RENAMED="$TMP/scope-renamed.js"
printf 'export const PERMISSION_PROFILE = Object.freeze({ contents: "write" });\n' > "$RENAMED"
expect "a RENAMED export is INDETERMINATE, never a silent pass" 3 \
  "INDETERMINATE" "$REG" "$RENAMED" "$CLEAN"

expect "an unreadable scope module is INDETERMINATE" 3 \
  "INDETERMINATE" "$REG" "$TMP/no-such-scope.js" "$CLEAN"

# ---------------------------------------------------------------------------
hdr "5. Nothing measured must never read as a pass"

EMPTY="$TMP/empty.json"
printf '[]\n' > "$EMPTY"
expect "an empty project list is INDETERMINATE, not zero findings" 3 \
  "not a pass" "$REG" "$SCOPE" "$EMPTY"

GARBAGE="$TMP/garbage.json"
printf 'not json at all\n' > "$GARBAGE"
expect "an unparseable board response is INDETERMINATE" 3 \
  "INDETERMINATE" "$REG" "$SCOPE" "$GARBAGE"

# A confirmed drift is still a drift when another row could not be established.
# The opposite ordering would let one unreadable row downgrade a real finding to
# "inconclusive", which is how a finding gets deferred forever.
run_audit "$REG" "$RENAMED" "$NARROWED"
if [[ "$RC" == 1 ]] && grep -q DRIFT <<<"$OUT" && grep -q INDETERMINATE <<<"$OUT"; then
  ok "a finding outranks an indeterminate row (exit 1, both reported)"
else
  bad "a finding outranks an indeterminate row (got exit $RC)" "$OUT"
fi

# ---------------------------------------------------------------------------
hdr "6. The registry parser refuses what it cannot read"
# A skipped registry line turns "this project is audited" into "this project is
# not audited" with no change in the output.  Each of these must exit 2 AND name
# the line, so the refusal is actionable rather than just loud.

expect_reg() {
  local desc="$1" needle="$2"; shift 2
  local reg="$TMP/badreg.txt"
  write_registry "$reg" "$DEFAULT_SPEC" "$@"
  run_audit "$reg" "$SCOPE" "$CLEAN"
  if [[ "$RC" == 2 ]] && grep -q -- "$needle" <<<"$OUT"; then ok "$desc"
  else bad "$desc (want exit 2 containing '$needle', got $RC)" "$OUT"; fi
}

expect_reg "an unknown state is refused" "unknown state" \
  "nonsense  $ONB  onboarding  -  x"
expect_reg "a delta with no delta is refused" "is just 'verbatim'" \
  "delta  $ONB  onboarding  -  a reason"
expect_reg "a divergence with no reason is refused" "requires a note" \
  "delta  $ONB  onboarding  +workflows=write  -"
expect_reg "a delta that resolves to the baseline is refused" "resolves to the baseline" \
  "delta  $ONB  onboarding  +contents=write  a reason that is not one"
expect_reg "a duplicate project id is refused" "listed twice" \
  "verbatim  $ONB  onboarding  -  x" "verbatim  $ONB  again  -  x"
expect_reg "a delta removing a permission the baseline lacks is refused" "not in the baseline" \
  "delta  $ONB  onboarding  -packages  a reason"
expect_reg "a delta that empties the profile is refused" "no permissions" \
  "delta  $ONB  onboarding  -contents,-pull_requests,-issues,-metadata,-checks,-statuses  a reason"

BAD_BASE="$TMP/badbase.txt"
printf '# fixture\nverbatim  %s  onboarding  -  x\n' "$ONB" > "$BAD_BASE"
run_audit "$BAD_BASE" "$SCOPE" "$CLEAN"
if [[ "$RC" == 2 ]] && grep -q "no baseline line" <<<"$OUT"; then
  ok "a registry with no baseline is refused"
else
  bad "a registry with no baseline is refused (got exit $RC)" "$OUT"
fi

TWO_BASE="$TMP/twobase.txt"
{ printf 'baseline  -  -  %s  one\n' "$DEFAULT_SPEC"
  printf 'baseline  -  -  contents=write  two\n'
  printf 'verbatim  %s  onboarding  -  x\n' "$ONB"; } > "$TWO_BASE"
run_audit "$TWO_BASE" "$SCOPE" "$CLEAN"
if [[ "$RC" == 2 ]] && grep -q "second baseline" <<<"$OUT"; then
  ok "a second baseline line is refused rather than last-one-wins"
else
  bad "a second baseline line is refused (got exit $RC)" "$OUT"
fi

# ---------------------------------------------------------------------------
hdr "7. The 'inherit' state, which is how ask 2 gets reversed if it ever should"

REG_INH="$TMP/registry-inherit.txt"
write_registry "$REG_INH" "$DEFAULT_SPEC" \
  "inherit   $ONB  onboarding  -  deliberately takes the broker default" \
  "delta     $OPS  ops-tooling  +workflows=write  GitHub refuses a merge touching .github/workflows/**"

INH_OK="$TMP/inherit-ok.json"
projects_json "$INH_OK" \
  "$ONB:Onboarding:-" \
  "$OPS:Ops Tooling:$(plain "$DEFAULT_SPEC,workflows=write")"
expect "a registered inherit with no pin is OK" 0 "no pin, as registered" \
  "$REG_INH" "$SCOPE" "$INH_OK"

expect "a pin appearing on an inherit project is DRIFT" 1 "registered as inheriting" \
  "$REG_INH" "$SCOPE" "$CLEAN"

# ---------------------------------------------------------------------------
hdr "8. The fan-out plan is the fix, so it has to be right"

run_audit "$REG" "$SCOPE" "$CLEAN" --fanout-plan
want_ops="checks=read,contents=write,issues=write,metadata=read,pull_requests=write,statuses=read,workflows=write"
want_onb="checks=read,contents=write,issues=write,metadata=read,pull_requests=write,statuses=read"
if [[ "$RC" == 0 ]] && grep -qx -- "$want_ops" <<<"$OUT" && grep -qx -- "$want_onb" <<<"$OUT"; then
  ok "the plan emits each project's expected spec verbatim"
else
  bad "the plan emits each project's expected spec verbatim (exit $RC)" "$OUT"
fi

# The plan is derived from the REGISTRY baseline.  If that baseline no longer
# matches the code, the plan would quietly fan out the old profile to every
# project -- so it has to say so before it prints anything.
run_audit "$REG" "$MOVED" "$CLEAN" --fanout-plan
if grep -q "does not match" <<<"$OUT"; then
  ok "the plan warns when the baseline it derives from is stale"
else
  bad "the plan warns when the baseline it derives from is stale" "$OUT"
fi

# ---------------------------------------------------------------------------
hdr "9. No credential reaches the output, and none is needed offline"

OUT="$(PERMISSION_PIN_PROJECTS_JSON="$CLEAN" PAPERCLIP_API_KEY='SENTINEL-KEY-DO-NOT-PRINT' \
       "$AUDIT" --registry "$REG" --scope-file "$SCOPE" --json 2>&1)"
RC=$?
if [[ "$RC" == 0 ]] && ! grep -q 'SENTINEL-KEY' <<<"$OUT"; then
  ok "the API key never reaches stdout or stderr"
else
  bad "the API key never reaches stdout or stderr (exit $RC)" "$OUT"
fi

if jq -e '.rows | length > 0 and (map(.verdict) | all(. == "OK"))' <<<"$OUT" >/dev/null 2>&1; then
  ok "--json emits per-row verdicts a caller can act on"
else
  bad "--json emits per-row verdicts a caller can act on" "$OUT"
fi

# With no fixture and no credential the audit must report INDETERMINATE rather
# than "no drift found".  `env -i` so an ambient PAPERCLIP_API_KEY in an agent
# container cannot make this case open a socket.
OUT="$(env -i PATH="$PATH" HOME="$HOME" "$AUDIT" --registry "$REG" --scope-file "$SCOPE" 2>&1)"
RC=$?
if [[ "$RC" == 3 ]]; then
  ok "no credential and no fixture is INDETERMINATE, not a pass"
else
  bad "no credential and no fixture is INDETERMINATE (got exit $RC)" "$OUT"
fi

# ---------------------------------------------------------------------------
hdr "10. The real registry in this repo is self-consistent"
# The suite above proves the tool.  This proves the file the tool is pointed at
# in production, against the broker module in this same checkout -- so a PR that
# edits DEFAULT_PERMISSION_PROFILE and not permission_pins.txt goes red HERE as
# well as in the broker suite.  Two independent readers of the same invariant:
# CI runs them in different jobs, on different runtimes, and a change that
# satisfies one by accident does not satisfy both.

# Deliberately run against an EMPTY board rather than a fabricated one.  A
# fixture built from the registry could only ever agree with the registry, so
# the project rows would be vacuous; worse, building it from a hardcoded copy of
# today's default would make this suite cry wolf the day the default legitimately
# changes.  The two things worth asserting here need no board at all: that the
# real file parses, and that its baseline is this checkout's real default.  The
# empty board is therefore expected to come back INDETERMINATE (exit 3), and the
# baseline row is read out of that run.
EMPTY_BOARD="$TMP/real-empty.json"
printf '[]\n' > "$EMPTY_BOARD"

run_audit "$REAL_REGISTRY" "$REAL_SCOPE" "$EMPTY_BOARD"
if [[ "$RC" == 3 ]] \
   && grep -q "registry baseline == DEFAULT_PERMISSION_PROFILE" <<<"$OUT" \
   && ! grep -q "BASELINE-DRIFT" <<<"$OUT"; then
  ok "permission_pins.txt parses, and its baseline is this checkout's default profile"
else
  bad "permission_pins.txt parses, and its baseline is this checkout's default profile (exit $RC)" "$OUT"
fi

# The control for the assertion above.  Without it, "no BASELINE-DRIFT in the
# output" would also pass on a run that produced no baseline row at all — which
# is how the check would decay into asserting that a grep found nothing.
MUTATED_REAL="$TMP/real-scope-mutated.js"
write_scope "$MUTATED_REAL" contents=read
run_audit "$REAL_REGISTRY" "$MUTATED_REAL" "$EMPTY_BOARD"
if grep -q "BASELINE-DRIFT" <<<"$OUT"; then
  ok "control — the real registry DOES report drift against a different default"
else
  bad "control — the real registry DOES report drift against a different default" "$OUT"
fi

# The registry is only worth anything if it covers the whole company.  Seven
# projects were measured on the live board 2026-08-25; a registry that covers
# five of them would pass every check above and still leave two grants
# unaudited.
registered_count="$(grep -Ec '^[[:space:]]*(verbatim|delta|inherit)[[:space:]]' "$REAL_REGISTRY")"
if [[ "$registered_count" -eq 7 ]]; then
  ok "the registry covers all 7 projects in the company"
else
  bad "the registry covers all 7 projects in the company (found $registered_count)" \
      "If a project was created or deleted, update permission_pins.txt and this count together."
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]] || exit 1
exit 0
