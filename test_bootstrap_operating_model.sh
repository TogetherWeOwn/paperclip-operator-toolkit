#!/usr/bin/env bash
# ===========================================================================
# test_bootstrap_operating_model.sh — the bootstrap script must REFUSE when its
# companion operating model document is missing. TOG-1106.
#
# WHY THIS EXISTS. Every agent the bootstrap creates gets the container path of
# `paperclipai_enterprise_org_operating_model.md` written into
# `metadata.operatingModelReport` and into its generated AGENTS.md, which says
# "The canonical org/permission design is documented in: <path>". The original
# code wrapped the staging step in `if [[ -f "$REPORT_SRC" ]]`, so a host
# lacking the file bootstrapped a COMPLETE company, exited 0, and printed
# nothing — while every agent it created cited a document that was never
# staged. A job that produces nothing must never report success.
#
# WHAT THIS TESTS, AND WHAT IT CANNOT. The full script needs podman, two live
# containers, the host's auth.json and a real server; none of that exists in CI
# or in an agent container, so this cannot run it end to end. What it CAN do is
# run the guard's OWN BYTES: the [DELTA 9] block is extracted from the script by
# its markers and executed in a harness. That means the test fails if someone
# deletes or weakens the guard, which is the regression that matters, and it
# cannot drift into testing a paraphrase of the guard kept in this file.
#
# The extraction is itself asserted: a marker that stops matching is a REFUSAL
# (exit 2), never a silent pass over zero lines. A test that greps for something
# absent and reports green is the same bug class this file exists to close.
#
#   ./test_bootstrap_operating_model.sh
#
# Exit 0 = the guard refuses when it must and passes when it must.
# Exit 2 = the test could not measure the guard (markers moved / file missing).
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/host-bootstrap/bootstrap_paperclip_enterprise_company.local.sh"
DOC="$HERE/host-bootstrap/paperclipai_enterprise_org_operating_model.md"

EXIT_OK=0; EXIT_FAIL=1; EXIT_REFUSED=2
fails=0
pass() { printf '\033[32mPASS\033[0m %s\n' "$*"; }
fail() { printf '\033[31mFAIL\033[0m %s\n' "$*"; fails=$((fails + 1)); }
die()  { printf '\033[31mREFUSED\033[0m %s\n' "$*" >&2; exit $EXIT_REFUSED; }

[[ -f "$SCRIPT" ]] || die "bootstrap script not found: $SCRIPT"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# --- extract the guard from the script's own bytes --------------------------
# Bounded by the DELTA 9 banner and the line that ends the block. Both ends are
# asserted present and in order before anything is run.
start="$(grep -n '^# \[DELTA 9\] Preflight: the companion operating model' "$SCRIPT" | head -1 | cut -d: -f1)"
end="$(grep -n '^echo "    \$REPORT_SRC (\$REPORT_SRC_BYTES bytes)"$' "$SCRIPT" | head -1 | cut -d: -f1)"
[[ -n "$start" ]] || die "DELTA 9 banner not found — the guard was renamed or deleted"
[[ -n "$end"   ]] || die "guard's closing echo not found — the block was restructured"
[[ "$end" -gt "$start" ]] || die "guard markers are out of order ($start..$end)"

sed -n "${start},${end}p" "$SCRIPT" > "$STAGE/guard.inc"
guard_lines="$(wc -l <"$STAGE/guard.inc")"
[[ "$guard_lines" -gt 5 ]] || die "extracted only $guard_lines lines; markers are not bounding the guard"

# The guard must actually contain a refusal. Extracting a block that cannot
# exit non-zero would make every case below pass for the wrong reason.
grep -q 'exit 1' "$STAGE/guard.inc" || die "extracted block contains no 'exit 1' — that is not a guard"
printf 'measuring %s lines of guard (%s:%s..%s)\n\n' \
  "$guard_lines" "$(basename "$SCRIPT")" "$start" "$end"

# --- harness ----------------------------------------------------------------
# BASH_SOURCE inside the guard resolves the doc next to the *running* script, so
# the harness is written into the fixture dir and the doc's presence there is
# what the guard sees.
build_harness() {
  local dir="$1"
  { echo '#!/usr/bin/env bash'
    echo 'set -euo pipefail'
    echo 'say() { echo "==> $*"; }'
    cat "$STAGE/guard.inc"
    echo 'echo "REACHED_END"'
  } > "$dir/harness.sh"
  chmod +x "$dir/harness.sh"
}

run_case() {
  local dir="$1"
  build_harness "$dir"
  ( cd "$dir" && ./harness.sh ) > "$dir/out.txt" 2>&1
  echo "$?" > "$dir/rc.txt"
}

# --- case 1: document present -> proceeds -----------------------------------
d1="$STAGE/present"; mkdir -p "$d1"
printf 'canonical org design\n' > "$d1/paperclipai_enterprise_org_operating_model.md"
run_case "$d1"
rc1="$(cat "$d1/rc.txt")"
if [[ "$rc1" == "0" ]] && grep -q REACHED_END "$d1/out.txt"; then
  pass "document present -> guard proceeds (rc=0)"
else
  fail "document present -> expected rc=0 and REACHED_END, got rc=$rc1"
  sed 's/^/      /' "$d1/out.txt"
fi

# The byte count the staging step later compares against must be exported by the
# guard, or the post-copy verification downstream compares against an empty
# string and passes on a failed copy.
if grep -q 'REPORT_SRC_BYTES=' "$STAGE/guard.inc"; then
  expected="$(wc -c <"$d1/paperclipai_enterprise_org_operating_model.md" | tr -d '[:space:]')"
  if grep -q "($expected bytes)" "$d1/out.txt"; then
    pass "guard reports the source size ($expected bytes) for the staging check"
  else
    fail "guard did not print the source byte count; staging comparison would be blind"
  fi
else
  fail "guard no longer sets REPORT_SRC_BYTES; the post-copy check cannot compare"
fi

# --- case 2: document absent -> refuses -------------------------------------
d2="$STAGE/absent"; mkdir -p "$d2"
run_case "$d2"
rc2="$(cat "$d2/rc.txt")"
# Refusing is necessary but not sufficient: the EXISTENCE branch has to be the
# one that fired. Deleting the `-f` test alone still reddens this case via the
# `-s` test below it, which would credit a limb that is no longer there. Assert
# the not-found wording so each branch is measured by its own case.
if [[ "$rc2" != "0" ]] && grep -qi 'not found' "$d2/out.txt"; then
  pass "document absent -> the existence check refuses (rc=$rc2)"
elif [[ "$rc2" != "0" ]]; then
  fail "document absent -> refused, but not via the existence check; that limb is gone"
  sed 's/^/      /' "$d2/out.txt"
else
  fail "document absent -> guard exited 0. This is the TOG-1106 silent success."
fi
if grep -q REACHED_END "$d2/out.txt"; then
  fail "document absent -> guard fell through; the script would go on to create agents"
else
  pass "document absent -> execution stops at the guard"
fi
# The message has to name the file and say why, or the operator gets a refusal
# they cannot act on.
if grep -qi 'operating model document not found' "$d2/out.txt" \
   && grep -q 'paperclipai_enterprise_org_operating_model.md' "$d2/out.txt"; then
  pass "refusal names the missing document"
else
  fail "refusal does not name the missing document"
  sed 's/^/      /' "$d2/out.txt"
fi
if grep -q 'host-bootstrap/' "$d2/out.txt"; then
  pass "refusal tells the operator where to get the file"
else
  fail "refusal gives no repair instruction"
fi

# --- case 3: document present but EMPTY -> refuses --------------------------
# A zero-byte file passes `-f`. Agents would be pointed at a real path holding
# no org design at all, which reads as "the canonical source says nothing".
d3="$STAGE/empty"; mkdir -p "$d3"
: > "$d3/paperclipai_enterprise_org_operating_model.md"
run_case "$d3"
rc3="$(cat "$d3/rc.txt")"
if [[ "$rc3" != "0" ]] && ! grep -q REACHED_END "$d3/out.txt"; then
  pass "empty document -> guard refuses (rc=$rc3)"
else
  fail "empty document -> guard accepted a zero-byte canonical source (rc=$rc3)"
fi

# --- case 4: the committed doc is real and non-trivial ----------------------
# The guard is worth nothing if the file it protects is a stub. This is the
# other half of TOG-1106: the doc had to actually land in git.
if [[ -f "$DOC" ]]; then
  bytes="$(wc -c <"$DOC" | tr -d '[:space:]')"
  if [[ "$bytes" -gt 10000 ]]; then
    pass "committed operating model is present and substantive ($bytes bytes)"
  else
    fail "committed operating model is only $bytes bytes — looks like a stub"
  fi
  if grep -q 'operatingModelReport\|permission profile\|Permission profile\|permission catalog' "$DOC"; then
    pass "committed operating model documents the permission design it is cited for"
  else
    fail "committed operating model does not mention the permission design"
  fi
else
  fail "operating model is NOT committed at host-bootstrap/ — the cited canonical source is still absent"
fi

# --- case 5: no tolerant `-f` guard survives at the staging site ------------
# The original bug. If someone re-introduces `if [[ -f "$REPORT_SRC" ]]` around
# the podman cp, absence becomes silent again even with the preflight in place.
#
# Comment lines are stripped first. The DELTA 8/9 banners QUOTE the old tolerant
# form to explain what was removed, and matching those made this case fail while
# the code was correct — a guard that convicts on its own documentation. Strip
# on a leading-# test only, so a real `if` line can never be excused as prose.
grep -v '^[[:space:]]*#' "$SCRIPT" > "$STAGE/code-only.sh"
[[ -s "$STAGE/code-only.sh" ]] || die "stripping comments left no code to scan"
if grep -qE 'if \[\[ +-f +"\$REPORT_SRC" +\]\]' "$STAGE/code-only.sh"; then
  fail "a tolerant [[ -f \$REPORT_SRC ]] guard is back in the script — absence can be silent again"
else
  pass "no tolerant [[ -f \$REPORT_SRC ]] guard remains"
fi

echo
if [[ "$fails" -eq 0 ]]; then
  printf '\033[32mall checks passed\033[0m\n'; exit $EXIT_OK
fi
printf '\033[31m%s check(s) failed\033[0m\n' "$fails"; exit $EXIT_FAIL
