#!/usr/bin/env bash
set -uo pipefail

# ===========================================================================
# Regression suite for cliproxy_release_preflight.sh  (TOG-4054)
#
# A refusing gate proves nothing on its own: a script that refuses everything
# refuses correctly too. So every RED case below is paired with a GREEN
# positive control that differs from it in exactly one input, and the GREEN
# control is asserted to exit 0. If a future edit makes the gate vacuous, the
# GREEN case keeps passing and every RED case flips — which is the failure
# this file exists to catch.
#
# Two GREEN controls exist:
#   * rollback mode, which exercises checks 0-7 and 9 end to end;
#   * apply mode, which additionally exercises check 8 (the ancestor rule).
#
# The apply-mode GREEN needs the reviewed controller commit to be present as
# an object in this checkout. On a shallow CI clone it may not be, because the
# fetch depth can exclude it even though PR #404 landed it on main. That case
# is reported as SKIPPED with its reason, and the apply path is then asserted
# to refuse with the missing-object message instead — still fail-closed, just
# for the other reason. Nothing here fetches from the network.
# ===========================================================================

cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1

readonly GATE="./cliproxy_release_preflight.sh"
readonly REF="f4f478342dbf62136729e151f55871e4cb9c8da8"
readonly HANDOFF="docs/runbooks/cliproxy-quota-controller-release.md"

[[ -x "$GATE" ]] || { printf 'FATAL: %s is missing or not executable\n' "$GATE" >&2; exit 1; }
[[ -f "$HANDOFF" ]] || { printf 'FATAL: %s is missing\n' "$HANDOFF" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
SKIP=0

# Every invocation starts from the known-good argument set; each case mutates
# exactly one thing. STATE_PRESENT/STATE_ABSENT are real paths so that check 9
# is exercised without touching /var.
STATE_PRESENT="$TMP/rollback.json"
STATE_ABSENT="$TMP/no-such-rollback.json"
printf '{"claude-a":{"priority":1,"weight":100,"disabled":false}}\n' >"$STATE_PRESENT"

# Allow local Git helpers time to resolve ancestry; argument parsing below has
# its own short bound because it must refuse before any external command.
GATE_TIMEOUT=30s

# run_gate <extra args...> -> sets RC and OUT
run_gate() {
  OUT=""
  RC=0
  # A parser regression must fail this suite, not hang the CI worker.
  OUT="$(timeout "$GATE_TIMEOUT" "$GATE" "$@" 2>&1)" || RC=$?
}

# green <name> <args...>
green() {
  local name="$1"; shift
  run_gate "$@"
  if [[ $RC -eq 0 ]]; then
    printf 'PASS  green  %s\n' "$name"
    PASS=$((PASS + 1))
  else
    printf 'FAIL  green  %s -- expected exit 0, got %s: %s\n' "$name" "$RC" "$OUT"
    FAIL=$((FAIL + 1))
  fi
}

# red <name> <expected-substring> <args...>
red() {
  local name="$1" expect="$2"; shift 2
  run_gate "$@"
  if [[ $RC -eq 0 ]]; then
    printf 'FAIL  red    %s -- gate PASSED when it had to refuse\n' "$name"
    FAIL=$((FAIL + 1))
  elif [[ $RC -ne 2 || "$OUT" != REFUSED:* ]]; then
    printf 'FAIL  red    %s -- expected a prompt REFUSED exit 2, got %s: %s\n' "$name" "$RC" "$OUT"
    FAIL=$((FAIL + 1))
  elif [[ "$OUT" != *"$expect"* ]]; then
    printf 'FAIL  red    %s -- refused for the wrong reason (want %q): %s\n' "$name" "$expect" "$OUT"
    FAIL=$((FAIL + 1))
  else
    printf 'PASS  red    %s\n' "$name"
    PASS=$((PASS + 1))
  fi
}

skip() {
  printf 'SKIP         %s -- %s\n' "$1" "$2"
  SKIP=$((SKIP + 1))
}

# The measured values the owner directed, as the operator would pass them.
OK_VALUES=(--cliproxy-version v7.3.9 --affinity-ttl 15m --request-retry 3 --max-retry-credentials 0)

# ---------------------------------------------------------------------------
# GREEN 1 -- rollback mode, everything correct. Covers checks 0-7 and 9.
# ---------------------------------------------------------------------------
green "rollback with correct measured values and captured state" \
  --mode rollback "${OK_VALUES[@]}" --rollback-state "$STATE_PRESENT"

# ---------------------------------------------------------------------------
# GREEN 2 -- apply mode. Covers check 8 by naming the reviewed commit as its
# own trusted line: a commit is an ancestor of itself, so the ancestor rule is
# satisfied without pretending the bundle has landed on main.
# ---------------------------------------------------------------------------
HAVE_REF=0
[[ "$(git --no-replace-objects cat-file -t "$REF" 2>/dev/null)" == commit ]] && HAVE_REF=1

if [[ $HAVE_REF -eq 1 ]]; then
  green "apply with the reviewed commit on the trusted line" \
    --mode apply "${OK_VALUES[@]}" --trusted-line "$REF" --rollback-state "$STATE_ABSENT"

  # Keep ancestry fixtures independent of checkout depth. Copy only the reviewed
  # commit object and mark it shallow; its parent is deliberately unavailable.
  # An unrelated root is a resolvable non-ancestor, unlike $REF~1 in shallow CI.
  ANCESTRY_GIT="$TMP/ancestry.git"
  git init --bare -q "$ANCESTRY_GIT" || exit 1
  COPIED_REF="$(git --no-replace-objects cat-file commit "$REF" |
    git --git-dir="$ANCESTRY_GIT" hash-object -t commit -w --stdin)" || exit 1
  [[ "$COPIED_REF" == "$REF" ]] || exit 1
  printf '%s\n' "$REF" >"$ANCESTRY_GIT/shallow"
  EMPTY_TREE="$(git --git-dir="$ANCESTRY_GIT" mktree </dev/null)" || exit 1
  NON_ANCESTOR="$(git --git-dir="$ANCESTRY_GIT" \
    -c user.name='Preflight fixture' -c user.email='fixture@example.invalid' \
    commit-tree "$EMPTY_TREE" -m 'Unrelated ancestry fixture')" || exit 1
  if git --git-dir="$ANCESTRY_GIT" rev-parse -q --verify "$REF~1^{commit}" >/dev/null 2>&1; then
    printf 'FATAL: ancestry fixture unexpectedly contains the reviewed parent\n' >&2
    exit 1
  fi
  GIT_DIR="$ANCESTRY_GIT" green "apply with the reviewed commit but no parent history" \
    --mode apply "${OK_VALUES[@]}" --trusted-line "$REF" --rollback-state "$STATE_ABSENT"
  GIT_DIR="$ANCESTRY_GIT" red "apply refuses when the ref is not an ancestor of the trusted line" \
    "is not an ancestor of" \
    --mode apply "${OK_VALUES[@]}" --trusted-line "$NON_ANCESTOR" --rollback-state "$STATE_ABSENT"

  red "apply refuses when an earlier rollback state was never cleared" \
    "rollback state already exists" \
    --mode apply "${OK_VALUES[@]}" --trusted-line "$REF" --rollback-state "$STATE_PRESENT"

  # Reachable only once the object check has passed, so it lives in this branch.
  red "apply refuses when the trusted line does not resolve" \
    "does not resolve" \
    --mode apply "${OK_VALUES[@]}" --trusted-line no/such/ref --rollback-state "$STATE_ABSENT"
else
  skip "apply-mode positive control" \
    "reviewed commit $REF is not an object in this checkout (it may be outside the shallow history); apply is asserted to fail closed instead"
  red "apply refuses when the reviewed commit is not fetched" \
    "is not an available commit object" \
    --mode apply "${OK_VALUES[@]}" --rollback-state "$STATE_ABSENT"
fi

red "rollback refuses when there is no captured state to restore" \
  "is missing; the controller has no captured fields" \
  --mode rollback "${OK_VALUES[@]}" --rollback-state "$STATE_ABSENT"

# ---------------------------------------------------------------------------
# Check 0 -- a missing measurement is a refusal, never a default.
# ---------------------------------------------------------------------------
red "no mode" "--mode must be apply or rollback" \
  "${OK_VALUES[@]}" --rollback-state "$STATE_PRESENT"
red "bogus mode" "--mode must be apply or rollback" \
  --mode dry-run "${OK_VALUES[@]}" --rollback-state "$STATE_PRESENT"
red "no version" "--cliproxy-version is required" \
  --mode rollback --affinity-ttl 15m --request-retry 3 --max-retry-credentials 0 \
  --rollback-state "$STATE_PRESENT"
red "no affinity ttl" "--affinity-ttl is required" \
  --mode rollback --cliproxy-version v7.3.9 --request-retry 3 --max-retry-credentials 0 \
  --rollback-state "$STATE_PRESENT"
red "no request-retry" "--request-retry is required" \
  --mode rollback --cliproxy-version v7.3.9 --affinity-ttl 15m --max-retry-credentials 0 \
  --rollback-state "$STATE_PRESENT"
red "no max-retry-credentials" "--max-retry-credentials is required" \
  --mode rollback --cliproxy-version v7.3.9 --affinity-ttl 15m --request-retry 3 \
  --rollback-state "$STATE_PRESENT"
red "unknown argument" "unknown argument" \
  --mode rollback "${OK_VALUES[@]}" --rollback-state "$STATE_PRESENT" --force

# All value-taking options must reject a trailing flag, an empty value, and
# another option in place of a value. A timeout (124) is never a RED pass.
GATE_TIMEOUT=3s
VALUE_ARGS=(--mode rollback "${OK_VALUES[@]}" --source-ref "$REF"
  --handoff "$HANDOFF" --trusted-line "$REF" --rollback-state "$STATE_PRESENT")
for ((i = 0; i < ${#VALUE_ARGS[@]}; i += 2)); do
  flag="${VALUE_ARGS[i]}"
  value="${VALUE_ARGS[i + 1]}"
  green "argument value present: $flag" "${VALUE_ARGS[@]}" "$flag" "$value"
  red "argument value absent: $flag" "$flag requires a value" "${VALUE_ARGS[@]}" "$flag"
  red "argument value empty: $flag" "$flag requires a value" "${VALUE_ARGS[@]}" "$flag" ""
  red "argument value is another flag: $flag" "$flag requires a value" \
    "${VALUE_ARGS[@]}" "$flag" --mode rollback
done
GATE_TIMEOUT=30s

# ---------------------------------------------------------------------------
# Check 5 -- the owner's failover settings. These are the numbers the whole
# card is about, so each one gets its own case in both directions.
# ---------------------------------------------------------------------------
red "live TTL still on the superseded 6h" "owner direction is 15m" \
  --mode rollback --cliproxy-version v7.3.9 --affinity-ttl 6h --request-retry 3 \
  --max-retry-credentials 0 --rollback-state "$STATE_PRESENT"
red "live TTL back on the original 24h" "owner direction is 15m" \
  --mode rollback --cliproxy-version v7.3.9 --affinity-ttl 24h --request-retry 3 \
  --max-retry-credentials 0 --rollback-state "$STATE_PRESENT"
red "live TTL drifted to a near miss" "owner direction is 15m" \
  --mode rollback --cliproxy-version v7.3.9 --affinity-ttl 15h --request-retry 3 \
  --max-retry-credentials 0 --rollback-state "$STATE_PRESENT"
red "request-retry reverted to 1" "live request-retry reads '1'" \
  --mode rollback --cliproxy-version v7.3.9 --affinity-ttl 15m --request-retry 1 \
  --max-retry-credentials 0 --rollback-state "$STATE_PRESENT"
red "max-retry-credentials reverted to 1" "live max-retry-credentials reads '1'" \
  --mode rollback --cliproxy-version v7.3.9 --affinity-ttl 15m --request-retry 3 \
  --max-retry-credentials 1 --rollback-state "$STATE_PRESENT"

# ---------------------------------------------------------------------------
# Check 6 -- version. v7.3.13 is the live trap: it is real, assessed, and
# still on hold, so it must refuse rather than look newer-and-therefore-fine.
# ---------------------------------------------------------------------------
red "unsupported v7.3.13" "is not a version this bundle has been verified against" \
  --mode rollback --cliproxy-version v7.3.13 --affinity-ttl 15m --request-retry 3 \
  --max-retry-credentials 0 --rollback-state "$STATE_PRESENT"
red "the v7.3.5 build the owner's note was written against" "is not a version this bundle has been verified against" \
  --mode rollback --cliproxy-version v7.3.5 --affinity-ttl 15m --request-retry 3 \
  --max-retry-credentials 0 --rollback-state "$STATE_PRESENT"
red "version prefix is not a match" "is not a version this bundle has been verified against" \
  --mode rollback --cliproxy-version v7.3 --affinity-ttl 15m --request-retry 3 \
  --max-retry-credentials 0 --rollback-state "$STATE_PRESENT"

# ---------------------------------------------------------------------------
# Check 7 -- the reviewed commit.
# ---------------------------------------------------------------------------
red "short source ref" "--source-ref must be a 40-hex commit" \
  --mode rollback "${OK_VALUES[@]}" --source-ref f4f4783 --rollback-state "$STATE_PRESENT"
red "uppercase source ref" "--source-ref must be a 40-hex commit" \
  --mode rollback "${OK_VALUES[@]}" --source-ref "${REF^^}" --rollback-state "$STATE_PRESENT"
red "a different 40-hex commit" "is not the reviewed controller commit" \
  --mode rollback "${OK_VALUES[@]}" \
  --source-ref 0123456789abcdef0123456789abcdef01234567 --rollback-state "$STATE_PRESENT"

# ---------------------------------------------------------------------------
# Checks 1-4 -- the handoff document. Each case starts from the real document
# and mutates it, so a change to the shipped runbook that breaks the contract
# shows up here rather than at deploy time.
# ---------------------------------------------------------------------------
BEGIN_MARK='<!-- STALE-EVIDENCE-BEGIN -->'
END_MARK='<!-- STALE-EVIDENCE-END -->'

# mutate <name> <python-expression-file> -> writes $TMP/<name>.md
doc_case() {
  local name="$1" expect="$2"
  local path="$TMP/$name.md"
  red "handoff: $name" "$expect" \
    --mode rollback "${OK_VALUES[@]}" --handoff "$path" --rollback-state "$STATE_PRESENT"
}

red "handoff: file does not exist" "handoff document not found" \
  --mode rollback "${OK_VALUES[@]}" --handoff "$TMP/absent.md" --rollback-state "$STATE_PRESENT"

# The real document, unmutated, under a different path: proves these cases
# fail because of the mutation and not because of the copy.
cp "$HANDOFF" "$TMP/verbatim-copy.md"
green "handoff: verbatim copy at another path" \
  --mode rollback "${OK_VALUES[@]}" --handoff "$TMP/verbatim-copy.md" --rollback-state "$STATE_PRESENT"

# fence removed entirely: the quoted history becomes live instruction
grep -v -e "$BEGIN_MARK" -e "$END_MARK" "$HANDOFF" >"$TMP/fence-removed.md"
doc_case "fence-removed" "stale-evidence fence is missing"

# only the closing marker removed
grep -v -e "$END_MARK" "$HANDOFF" >"$TMP/fence-unbalanced.md"
doc_case "fence-unbalanced" "stale-evidence fence is unbalanced"

# a second BEGIN immediately after the first, and a matching extra END, so the
# counts balance and only the nesting rule can catch it
awk -v b="$BEGIN_MARK" -v e="$END_MARK" '
  { print }
  index($0, b) && !seenb { print b; seenb = 1 }
  index($0, e) && !seene { print e; seene = 1 }
' "$HANDOFF" >"$TMP/fence-nested.md"
doc_case "fence-nested" "stale-evidence fence is nested"

# an END before any BEGIN, balanced by an extra BEGIN at the end of the file
{ printf '%s\n' "$END_MARK"; cat "$HANDOFF"; printf '%s\n' "$BEGIN_MARK"; } >"$TMP/fence-inverted.md"
doc_case "fence-inverted" "stale-evidence fence closes before it opens"

# a runnable code block inside the quarantine: the one way quoted history
# turns back into something an operator can paste
awk -v b="$BEGIN_MARK" '
  { print }
  index($0, b) && !done { print "```"; print "cliproxy config set session-affinity-ttl 6h"; print "```"; done = 1 }
' "$HANDOFF" >"$TMP/fence-carries-code.md"
doc_case "fence-carries-code" "carries a runnable code fence"

# a live instruction, outside the fence, in each word order
{ cat "$HANDOFF"; printf '\nSet the session-affinity TTL to 6h before enabling the timer.\n'; } \
  >"$TMP/live-affinity-then-ttl.md"
doc_case "live-affinity-then-ttl" "pairs session affinity with a superseded TTL"

{ cat "$HANDOFF"; printf '\nRestore 24h on the affinity binding during rollback.\n'; } \
  >"$TMP/live-ttl-then-affinity.md"
doc_case "live-ttl-then-affinity" "pairs session affinity with a superseded TTL"

# Formatting must not turn a live superseded instruction into a GREEN. Each
# fixture has two controls: only its TTL changed to 15m, or the exact unsafe
# text moved into quoted history. Exercise apply and rollback independently.
python3 - "$HANDOFF" "$TMP" <<'PY' || exit 1
from pathlib import Path
import sys

base = Path(sys.argv[1]).read_text(encoding="utf-8")
root = Path(sys.argv[2])
cases = [
    ("same-line", "Set affinity TTL to {ttl} before apply.", "6h"),
    ("table-cell", "| session-affinity TTL | {ttl} |", "24h"),
    ("apply-period", "Set the session-affinity TTL to {ttl}.", "6h"),
    ("rollback-period", "Restore affinity TTL {ttl}.", "24h"),
    ("wrapped", "Set the session-affinity TTL to\n{ttl}.", "6h"),
    ("wrapped-reverse", "Restore {ttl}\non the affinity binding.", "24h"),
    ("blank-line", "Restore affinity TTL\n\n{ttl}.", "24h"),
    ("minutes-apply", "Set affinity TTL to {ttl}.", "360m"),
    ("minutes-rollback", "Restore affinity TTL {ttl}.", "1440m"),
    ("seconds-apply", "Set affinity TTL to {ttl}.", "21600s"),
    ("seconds-rollback", "Restore affinity TTL {ttl}.", "86400s"),
    ("spaced-apply", "Set affinity TTL to {ttl}.", "6 h"),
    ("spaced-rollback", "Restore affinity TTL {ttl}.", "24 h"),
    ("tab-unit", "Set affinity TTL to {ttl}.", "6\th"),
    ("wrapped-unit", "Restore affinity TTL {ttl}.", "24\nh"),
    ("nbsp-unit", "Set affinity TTL to {ttl}.", "360 m"),
    ("decimal-hours", "Set affinity TTL to {ttl}.", "6.0 hours"),
    ("day-rollback", "Restore affinity TTL {ttl}.", "1 day"),
    ("fractional-day", "Set affinity TTL to {ttl}.", "0.25d"),
    ("punctuated-uppercase", "Restore **AFFINITY** TTL (`{ttl}`).", "24 H"),
]
for name, template, ttl in cases:
    unsafe = template.format(ttl=ttl)
    safe = template.format(ttl="15m")
    quoted = "\n".join("> " + line for line in unsafe.splitlines())
    (root / f"format-{name}-red.md").write_text(base + "\n" + unsafe + "\n", encoding="utf-8")
    (root / f"format-{name}-green.md").write_text(base + "\n" + safe + "\n", encoding="utf-8")
    (root / f"format-{name}-history.md").write_text(
        base.replace("<!-- STALE-EVIDENCE-END -->", quoted + "\n<!-- STALE-EVIDENCE-END -->"),
        encoding="utf-8",
    )
(root / "format-cases").write_text("\n".join(name for name, _, _ in cases) + "\n", encoding="utf-8")
PY

for mode in rollback apply; do
  if [[ "$mode" == apply && $HAVE_REF -eq 0 ]]; then
    skip "apply-mode formatting pairs" "reviewed controller object is unavailable"
    continue
  fi
  state="$STATE_PRESENT"
  [[ "$mode" == apply ]] && state="$STATE_ABSENT"
  while IFS= read -r name; do
    green "$mode formatting: $name with 15m" \
      --mode "$mode" "${OK_VALUES[@]}" --trusted-line "$REF" \
      --rollback-state "$state" --handoff "$TMP/format-$name-green.md"
    green "$mode formatting: $name in quoted history" \
      --mode "$mode" "${OK_VALUES[@]}" --trusted-line "$REF" \
      --rollback-state "$state" --handoff "$TMP/format-$name-history.md"
    red "$mode formatting: $name live" "pairs session affinity with a superseded TTL" \
      --mode "$mode" "${OK_VALUES[@]}" --trusted-line "$REF" \
      --rollback-state "$state" --handoff "$TMP/format-$name-red.md"
  done <"$TMP/format-cases"
done

# the three required statements, each deleted in turn
sed 's/15m/fifteen minutes/g' "$HANDOFF" >"$TMP/no-15m.md"
doc_case "no-15m" "never states the required 15m"

sed 's/request-retry/retry-count/g' "$HANDOFF" >"$TMP/no-request-retry.md"
doc_case "no-request-retry" "never states the required request-retry 3"

sed 's/max-retry-credentials/max-credentials/g' "$HANDOFF" >"$TMP/no-max-retry-credentials.md"
doc_case "no-max-retry-credentials" "never states the required max-retry-credentials 0"

# ---------------------------------------------------------------------------
printf '\n%s: %d passed, %d failed, %d skipped\n' \
  "test_cliproxy_release_preflight" "$PASS" "$FAIL" "$SKIP"
[[ $FAIL -eq 0 ]] || exit 1
exit 0
