#!/usr/bin/env bash
# =====================================================================================
# tog-385-mutation-gate.sh — proof that the TOG-385 regression cases are not vacuous
#
# The TOG-385 fix NARROWS a credential-detection rule. The danger with narrowing such a
# rule is not that the new tests fail; it is that they pass for free — a negative case
# that would go green with the fix reverted has measured nothing, and a positive case
# satisfied by a NEIGHBOURING rule proves nothing about this one.
#
# So each mutation below removes exactly ONE limb of the fix from a staged copy and
# asserts that the NAMED cases go red while a control case stays green. The unmutated
# copy is asserted green FIRST, in the same staging directory: "the mutated suite
# failed" is unattributable without it — a staging error produces the same red.
#
#   ./verification/tog-385-mutation-gate.sh
#
# Exit 0 = every mutation was detected by the case that claims to cover it.
# =====================================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/../dropchannel_scan.sh"
[ -f "$SRC" ] || { echo "FATAL: cannot find dropchannel_scan.sh next to $HERE" >&2; exit 4; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp "$SRC" "$STAGE/dropchannel_scan.sh"
chmod +x "$STAGE/dropchannel_scan.sh"

pass=0; fail=0
red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }

# --- BASELINE. Without this, every "the mutated suite went red" below is unattributable.
echo "=== baseline: the UNMUTATED copy passes in this same staging directory ==="
base_out="$("$STAGE/dropchannel_scan.sh" selftest 2>&1)" && base_rc=0 || base_rc=$?
if [ "$base_rc" = "0" ]; then
  grn "  PASS  unmutated copy: selftest green in $STAGE"; pass=$((pass+1))
else
  red "  FAIL  unmutated copy is ALREADY RED (rc=$base_rc) — every mutation below would"
  red "        go red for that reason instead of the mutation. Staging is broken."
  printf '%s\n' "$base_out" | grep -E '^\s+FAIL' || true
  exit 1
fi
# A mutation that removes a test rather than breaking it must not read as a detection.
if printf '%s' "$base_out" | grep -qE '  SKIP '; then
  red "  FAIL  baseline contains a SKIP — a skipped case cannot detect anything"; fail=$((fail+1))
else
  grn "  PASS  baseline has zero skipped cases"; pass=$((pass+1))
fi
echo

# mutate <name> <old-literal> <new-literal> <must-go-red-case> [<more cases>...]
# The last argument list is the set of case NAMES that must flip to FAIL. A mutation
# that merely makes the suite red somewhere is not evidence for the case under test.
mutate() {
  local name="$1" old="$2" new="$3"; shift 3
  local f="$STAGE/dropchannel_scan.sh"
  cp "$SRC" "$f"
  OLD="$old" NEW="$new" F="$f" python3 - <<'PY' || { red "  FAIL  $name: mutation did not apply"; fail=$((fail+1)); return; }
import os, sys
f = os.environ["F"]; old = os.environ["OLD"]; new = os.environ["NEW"]
s = open(f).read()
if s.count(old) != 1:
    print(f"mutation target appears {s.count(old)} times, expected exactly 1", file=sys.stderr)
    sys.exit(1)
open(f, "w").write(s.replace(old, new))
PY
  local out rc=0
  out="$("$f" selftest 2>&1)" || rc=$?
  if [ "$rc" = "0" ]; then
    red "  FAIL  $name: suite stayed GREEN with this limb removed — nothing covers it"
    fail=$((fail+1)); return
  fi
  local case_name ok=1
  for case_name in "$@"; do
    if printf '%s' "$out" | grep -qF "FAIL  $case_name"; then :; else
      red "  FAIL  $name: suite went red, but NOT on the case that claims to cover it:"
      red "        expected a red on: $case_name"
      ok=0
    fi
  done
  if [ "$ok" = "1" ]; then
    grn "  PASS  $name  -> red on: $*"; pass=$((pass+1))
  else
    fail=$((fail+1))
  fi
}

echo "=== each limb of the fix, removed one at a time ==="

# M1 — the k=v compound case. This is the limb that quiets the reported line.
mutate "k=v exemption removed" \
  'INNER_KV_RE = re.compile(r"^([A-Za-z][A-Za-z0-9_.\-]{0,31})=(.+)$")' \
  'INNER_KV_RE = re.compile(r"^(?!)$")' \
  "probe result table: x-api-key : http=200" \
  "k=v value with a word payload"

# M2 — the guard that stops a nested CREDENTIAL-NAMED key from being exempted.
mutate "credential-named inner-key guard removed" \
  '        if CRED_KEY_RE.match(inner_key):' \
  '        if False:' \
  "inner key is credential-named too"

# M3 — the one way the k=v shape could have opened a hole: an EMPTY payload, which is
# what base64 padding parses as.
mutate "k=v payload allowed to be empty" \
  '{0,31})=(.+)$")' \
  '{0,31})=(.*)$")' \
  "base64 padding is not an empty k=v"

# M4 — the URL exemption itself. Must be load-bearing, or it is dead code.
mutate "URL exemption removed" \
  'URL_RE      = re.compile(r"(?i)^(?:https?|ftp|ftps|git|ssh|file|wss?)://(.+)$")' \
  'URL_RE      = re.compile(r"^(?!)$")' \
  "URL value with a port" \
  "URL value with a benign query"

# M5 — userinfo. `https://user:<token>@host` is a credential wearing a URL.
mutate "URL userinfo guard removed" \
  '        if "@" in re.split(r"[/?#]", rest, maxsplit=1)[0]:' \
  '        if False:' \
  "URL with userinfo is a credential in a URL"

# M6 — a credential-named query parameter inside an exempted URL. The outer match has
# already swallowed it, so this guard is the only thing that can see it.
mutate "URL credential-query guard removed" \
  '        if CRED_ASSIGN_RE.search(rest):' \
  '        if False:' \
  "URL carrying a token query parameter"

# M7 — per-segment recursion inside the URL. Without it, any opaque blob in a URL is
# exempt purely for being in a URL.
mutate "URL segment recursion removed" \
  '        return all(noncredential_value(seg, depth + 1)
                   for seg in URL_SEG_RE.split(rest) if seg)' \
  '        return True' \
  "URL carrying an opaque query parameter"

# M8 — the recursion depth cap fails CLOSED. Flipping it to fail-open is the classic
# inversion, and it must not be silent.
mutate "depth cap flipped to fail-OPEN" \
  '        # Fail closed. Nesting this deep is not a shape we are prepared to vouch for,
        # and an unbounded recursion is its own denial-of-service.
        return False' \
  '        return True' \
  "nesting past the depth cap fails CLOSED"

# M9 — the shared key alternation. Two copies would drift; prove there is only one, by
# breaking it and watching BOTH the rule and the guard lose the same key.
mutate "credential-key alternation narrowed" \
  '|id[_\-]?token|session[_\-]?token|credential)s?")' \
  '|id[_\-]?token|session[_\-]?token)s?")' \
  "inner key is credential-named too"

echo
if [ "$fail" -eq 0 ]; then
  grn "mutation gate: $pass passed, 0 failed — every limb is covered by a named case."
  exit 0
else
  red "mutation gate: $pass passed, $fail FAILED"
  exit 1
fi
