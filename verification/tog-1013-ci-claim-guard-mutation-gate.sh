#!/usr/bin/env bash
# =====================================================================================
# tog-1013-ci-claim-guard-mutation-gate.sh — is the CI-claim guard actually a guard?
#
# WHY THIS EXISTS
# ---------------
# TOG-1013 cleared an upstream comment draft for PR #9977. The required edit was to
# remove an unqualified "CI is green" claim, because at head 7bd3ea4 one of the 30
# checks is SKIPPED, not passed. The draft made that claim twice; `-v3` fixed one,
# `-v4` fixed the second and added a regex guard asserting no unqualified claim
# survives.
#
# The pointer doc README-WHICH-DRAFT-IS-CURRENT.md then said that guard "was
# mutation-tested ... so it is not a check that cannot fail." Measured 2026-09-05,
# that mutation test only neutered the replacement — i.e. it re-inserted the exact
# string the regex greps for. A mutant that swaps in the very literal the guard
# matches proves nothing about the guard's reach.
#
# Re-run properly, the guard kills 2 of 7 realistic mutants and lets 5 through,
# INCLUDING "CI already passes" — the phrasing make_v4.py itself wrote. The guard is
# pinned to the phrasings being REMOVED, so it cannot catch a regression written in
# the wording the fix introduced.
#
# WHAT THIS GATE ASSERTS, AND WHAT IT DELIBERATELY DOES NOT
# ---------------------------------------------------------
# It asserts the MEASURED reach of the guard, so that the number stops being prose in
# a README and starts being a thing that breaks when someone changes it. It does NOT
# assert the guard is good — it is not. Two separate verdicts, kept separate:
#
#   * the GUARD is weak            -> this gate pins how weak, so a future "I improved
#                                     it" claim has to move a number.
#   * the ARTIFACT is accurate     -> checked independently below by reading every
#                                     CI-mentioning line, not by trusting the guard.
#
# A weak guard is not evidence of a bad artifact. `-v4` ships accurate: 29 success,
# 1 skipped, 0 failed, and "CI already passes" is true of that.
#
# EXIT 0 = measured reality matches what the record claims. EXIT 1 = something moved.
# =====================================================================================
set -uo pipefail

STAGING="/paperclip/instances/default/projects/00000000-0000-4000-8000-000000000000/176a1793-80a6-4eb7-8dd0-3878c7359c33/_default/pr-staging"
V4="$STAGING/draft-comment-9977-v4.md"
GEN="$STAGING/make_v4.py"
V4_SHA="7b45b5b26a1eb93079bb0c780f6b4f4e379799a664b092d8a1913c84ffd58815"

fail=0
note() { printf '%s\n' "$*"; }
bad()  { printf 'FAIL: %s\n' "$*"; fail=1; }

note "== 0. artifact present and matches the cleared hash =="
for f in "$V4" "$GEN"; do
  [ -r "$f" ] || { bad "missing/unreadable: $f"; }
done
[ $fail -eq 0 ] || { note "cannot continue"; exit 1; }

got=$(sha256sum "$V4" | cut -d' ' -f1)
if [ "$got" = "$V4_SHA" ]; then
  note "  ok   -v4 sha256 $got"
else
  bad "-v4 moved: expected $V4_SHA got $got (re-run TOG-1013 review; clearance binds to a hash)"
fi

note ""
note "== 1. mutation-test the guard's REACH =="
# The guard lives inside make_v4.py. Extract its regex and permitted-string rather than
# restating them here, so this gate rots loudly if the guard is rewritten instead of
# silently testing a copy that no longer exists.
python3 - "$V4" "$GEN" <<'PY'
import pathlib, re, sys
v4_path, gen_path = sys.argv[1], sys.argv[2]
text = pathlib.Path(v4_path).read_text()
gen  = pathlib.Path(gen_path).read_text()

m_re  = re.search(r'bad\s*=\s*re\.findall\(\s*r"([^"]+)"', gen)
m_per = re.search(r'PERMITTED\s*=\s*"([^"]+)"', gen)
if not m_re or not m_per:
    print("FAIL: could not extract guard regex/PERMITTED from make_v4.py -- guard was rewritten;"
          " re-derive this gate against the new one.")
    sys.exit(1)
RE, PERMITTED = m_re.group(1), m_per.group(1)
print(f"  guard regex : {RE}")
print(f"  permitted   : {PERMITTED}")

def caught(t):
    return bool(re.findall(RE, t.replace(PERMITTED, ""), re.I))

SHIPPED = "for a PR whose CI already passes."
if SHIPPED not in text:
    print(f"FAIL: -v4 no longer contains {SHIPPED!r}; artifact changed shape")
    sys.exit(1)

# Control: the real artifact must pass its own guard. If this goes red the guard is
# broken outright, not merely narrow.
if caught(text):
    print("FAIL: control -- unmutated -v4 trips its own guard")
    sys.exit(1)
print("  control     : unmutated -v4 is clean (expected)")

MUTANTS = [
    ("for a PR that is already CI-green.",   True,  "phrasing -v3 removed"),
    ("for a PR whose CI is green.",          True,  "phrasing -v3 removed"),
    ("for a PR whose CI already passes.",    False, "the phrasing make_v4.py ITSELF wrote"),
    ("for a PR whose CI passes.",            False, "paraphrase"),
    ("for a PR where all checks pass.",      False, "paraphrase"),
    ("for a PR whose CI is fully green.",    False, "paraphrase"),
    ("for a PR with a clean build.",         False, "paraphrase"),
]
killed = survived = 0
drift = []
for phrase, expect_killed, why in MUTANTS:
    mutated = text.replace(SHIPPED, phrase)
    hit = caught(mutated)
    tag = "KILLED  " if hit else "SURVIVED"
    print(f"  {tag} {phrase!r}  ({why})")
    if hit: killed += 1
    else:   survived += 1
    if hit != expect_killed:
        drift.append((phrase, expect_killed, hit))

print(f"\n  measured: {killed} killed / {survived} survived of {len(MUTANTS)}")
if drift:
    print("FAIL: guard reach CHANGED from the recorded measurement:")
    for p, exp, got in drift:
        print(f"   {p!r}: recorded {'KILLED' if exp else 'SURVIVED'}, now {'KILLED' if got else 'SURVIVED'}")
    print("  If the guard was genuinely improved, update this gate AND the README claim.")
    sys.exit(1)
if killed != 2 or survived != 5:
    print(f"FAIL: expected the recorded 2 killed / 5 survived, got {killed}/{survived}")
    sys.exit(1)
print("  ok   reach matches the recorded 2 killed / 5 survived")
PY
[ $? -eq 0 ] || fail=1

note ""
note "== 2. the ARTIFACT is accurate, checked independently of the guard =="
# Every line mentioning CI/checks/green, read on its own merits. The guard being narrow
# must not be allowed to imply the text is wrong -- and vice versa.
ci_lines=$(grep -nEi '\bCI\b|checks|green|passes' "$V4" || true)
printf '%s\n' "$ci_lines" | sed 's/^/    /'

if grep -qF "(29 of 30 checks green, one visual-regression check skipped)" "$V4"; then
  note "  ok   the quantified parenthetical is present"
else
  bad "the quantified CI sentence is gone from -v4"
fi

# The one unquantified survivor is "CI already passes". That is TRUE iff 0 checks failed.
# Assert nothing in the file claims all 30 PASSED, which would be false.
if grep -qEi '30 of 30|all 30 checks (pass|green)|CI is green|CI-green' "$V4"; then
  bad "-v4 contains an unqualified/false all-checks-passed claim"
else
  note "  ok   no all-30-passed claim; 'CI already passes' is true of 29 success + 1 skipped + 0 failed"
fi

note ""
if [ $fail -eq 0 ]; then
  note "PASS — guard reach is as recorded (weak, pinned at 2/7), artifact is accurate."
  exit 0
fi
note "FAIL — see above."
exit 1
