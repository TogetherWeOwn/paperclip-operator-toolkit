#!/usr/bin/env bash
# =====================================================================================
# tog-999-drift-pin-mutation-gate.sh — does the handoff-drift check actually catch drift?
#
# WHY THIS EXISTS
# ---------------
# verification/tog-990-handoff-copy-drift.sh was shipped having been shown to go red
# exactly ONE way: mutate the host copy, get exit 1. Measured 2026-09-05, that was not
# enough. The reviewed side was resolved from the WORKING TREE, so mutating BOTH copies
# identically returned exit 0 — undetected. In a shared workspace with concurrent
# sibling runs, a rebase or a stray `git checkout` moves both sides at once, which is
# precisely the scenario the check exists to catch. "Goes red one way" is not evidence
# that a guard works.
#
# So this gate does two things, and the second is the one that matters:
#
#   1. SCENARIOS — drive the real check through seven states, asserting the exact exit
#      code of each, including the correlated both-copies case (TOG-999 defect 1).
#   2. MUTANTS — damage the check itself and assert the scenarios NOTICE. A scenario
#      suite nothing can break is a suite that asserts nothing.
#
# Every fixture is built from scratch in a temp dir: a real git object store, a real
# working tree, a real handoff copy. Nothing here touches the shared workspace or
# /paperclip/operator-handoff — this gate must be safe to run while an operator is
# mid-window.
#
#   exit 0  every scenario behaved, and every mutant was killed
#   exit 1  a scenario misbehaved, or a mutant survived
#   exit 2  could not evaluate (missing anchor, broken fixture)
# =====================================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK_SRC="$HERE/verification/tog-990-handoff-copy-drift.sh"
GATE_TMP="$(mktemp -d)"
trap 'rm -rf "$GATE_TMP"' EXIT

[ -f "$CHECK_SRC" ] || { echo "cannot evaluate: check missing: $CHECK_SRC" >&2; exit 2; }

# The reviewed bytes, taken from the check's own pin so this gate cannot drift from it.
PINNED_BLOB="$(sed -n 's/^PINNED_BLOB="\([0-9a-f]\{40\}\)"$/\1/p' "$CHECK_SRC" | head -1)"
PINNED_SHA256="$(sed -n 's/^PINNED_SHA256="\([0-9a-f]\{64\}\)"$/\1/p' "$CHECK_SRC" | head -1)"
[ -n "$PINNED_BLOB" ] && [ -n "$PINNED_SHA256" ] || {
  echo "cannot evaluate: could not parse PINNED_BLOB/PINNED_SHA256 out of $CHECK_SRC" >&2
  echo "  (the pin was renamed or reformatted — this gate reads it by name)" >&2
  exit 2; }

REVIEWED="$GATE_TMP/reviewed.py"
git -C "$HERE" cat-file blob "$PINNED_BLOB" > "$REVIEWED" 2>/dev/null || {
  echo "cannot evaluate: pinned blob ${PINNED_BLOB:0:12} absent from this checkout" >&2
  echo "  run: git -C '$HERE' fetch --all --tags" >&2
  exit 2; }
[ -s "$REVIEWED" ] || { echo "cannot evaluate: pinned blob extracted empty" >&2; exit 2; }

EMPTY_SHA256="$(sha256sum < /dev/null | cut -d' ' -f1)"

# --- fixture ---------------------------------------------------------------------------
# A self-contained checkout: real object store holding the pinned blob, a working-tree
# copy beside it, and a handoff copy standing in for the host file.
build_fixture() { # dir [script-source]
  local d="$1" src="${2:-$CHECK_SRC}"
  rm -rf "$d"; mkdir -p "$d/repo/verification"
  git -C "$d/repo" init -q 2>/dev/null || return 2
  # Content-addressed: hashing the reviewed bytes reproduces the SAME blob id the check
  # pins, which is the whole reason a blob id is a safe reference.
  local got; got="$(git -C "$d/repo" hash-object -w "$REVIEWED")" || return 2
  [ "$got" = "$PINNED_BLOB" ] || { echo "fixture: blob id $got != pinned $PINNED_BLOB" >&2; return 2; }
  cp "$REVIEWED" "$d/repo/deploy_window_manifest.py"
  # cp -p: the check asserts the handoff copy is executable, and a mode lost in staging
  # would make every scenario fail for the wrong reason.
  cp -p "$src" "$d/repo/verification/tog-990-handoff-copy-drift.sh"
  chmod 755 "$d/repo/verification/tog-990-handoff-copy-drift.sh"
  cp "$REVIEWED" "$d/host.py"; chmod 755 "$d/host.py"
}

run_check() { # dir -> exit code of the staged check
  local d="$1"
  REPO_ROOT="$d/repo" HOST_COPY="$d/host.py" \
    "$d/repo/verification/tog-990-handoff-copy-drift.sh" >"$d/out" 2>&1
}

# --- scenarios -------------------------------------------------------------------------
# Each returns the check's exit code from a freshly built fixture. The expected code is
# asserted by name so a wrong-reason red is not mistaken for coverage.
scenario() { # name script-source -> prints actual exit code
  local name="$1" src="$2" d="$GATE_TMP/sc"
  build_fixture "$d" "$src" || return 2
  case "$name" in
    baseline)      : ;;                                        # untouched
    host-only)     printf '# drift\n' >> "$d/host.py" ;;
    correlated)    printf '# drift\n' >> "$d/host.py"          # <-- THE TOG-999 CASE
                   printf '# drift\n' >> "$d/repo/deploy_window_manifest.py" ;;
    tree-only)     printf '# drift\n' >> "$d/repo/deploy_window_manifest.py" ;;
    absent-blob)   rm -rf "$d/repo/.git/objects" ;;            # shallow/unfetched clone
    empty-pin)     # The shallow-clone trap made self-consistent: the pin resolves to a
                   # real but EMPTY object whose recorded sha256 legitimately matches.
                   git -C "$d/repo" hash-object -w /dev/null >/dev/null || return 2
                   local eblob; eblob="$(git -C "$d/repo" hash-object /dev/null)"
                   sed -i "s/^PINNED_BLOB=.*/PINNED_BLOB=\"$eblob\"/; \
                           s/^PINNED_SHA256=.*/PINNED_SHA256=\"$EMPTY_SHA256\"/" \
                     "$d/repo/verification/tog-990-handoff-copy-drift.sh"
                   : > "$d/host.py"; chmod 755 "$d/host.py" ;;
    decoy-pin)     # Right shape, wrong bytes: pin points at an object that is not the
                   # reviewed content, while PINNED_SHA256 still records the real one.
                   cp "$REVIEWED" "$d/decoy.py"; printf '# decoy\n' >> "$d/decoy.py"
                   local dblob; dblob="$(git -C "$d/repo" hash-object -w "$d/decoy.py")" || return 2
                   sed -i "s/^PINNED_BLOB=.*/PINNED_BLOB=\"$dblob\"/" \
                     "$d/repo/verification/tog-990-handoff-copy-drift.sh" ;;
    not-executable) chmod 644 "$d/host.py" ;;
    *) echo "unknown scenario $name" >&2; return 2 ;;
  esac
  run_check "$d"; echo $?
}

# name:expected-exit
SCENARIOS=(
  "baseline:0"        # reviewed == handoff
  "host-only:1"       # the one case the original check covered
  "correlated:1"      # TOG-999 defect 1 — was 0 before the pin
  "tree-only:0"       # the working tree is NOT the reference
  "absent-blob:2"     # unfetched object must not read as a verdict
  "empty-pin:2"       # empty reference + empty host must not read as agreement
  "decoy-pin:2"       # pinned object must hash to the recorded constant
  "not-executable:1"  # the operator invokes it directly
)

run_scenarios() { # script-source -> 0 if all behaved; prints "FAIL: <name> ..." if not
  local src="$1" spec name want got bad=0
  for spec in "${SCENARIOS[@]}"; do
    name="${spec%%:*}"; want="${spec##*:}"
    got="$(scenario "$name" "$src")" || { echo "FAIL: $name could not evaluate"; bad=1; continue; }
    [ "$got" = "$want" ] || { echo "FAIL: $name expected exit $want, got $got"; bad=1; }
  done
  return "$bad"
}

# --- mutants ---------------------------------------------------------------------------
# Each damages the check and must make run_scenarios go red ON A NAMED SCENARIO. A mutant
# that reds the wrong scenario is reported as such, not counted as a kill.
mutant() { # label anchor replacement expected-failing-scenario
  local label="$1" anchor="$2" repl="$3" want="$4"
  local src="$GATE_TMP/mutant-$label.sh"
  python3 - "$CHECK_SRC" "$src" "$anchor" "$repl" <<'PY' || return 2
import sys
src, dst, anchor, repl = sys.argv[1:5]
s = open(src).read()
if s.count(anchor) != 1:
    sys.stderr.write("mutation anchor not unique (%d matches): %r\n" % (s.count(anchor), anchor))
    sys.exit(2)
open(dst, "w").write(s.replace(anchor, repl))
PY
  chmod 755 "$src"
  bash -n "$src" || { echo "$label: mutant does not parse" >&2; return 2; }
  local out; out="$(run_scenarios "$src")"
  if [ -z "$out" ]; then
    echo "SURVIVED: $label — every scenario still passed. The check is not load-bearing here." >&2
    return 1
  fi
  if ! grep -qF "FAIL: $want" <<<"$out"; then
    echo "WRONG-REASON: $label went red, but not on '$want':" >&2; sed 's/^/    /' <<<"$out" >&2
    return 1
  fi
  echo "ok: $label -> killed by '$want'"
}

# --- run --------------------------------------------------------------------------------
echo "== scenarios against the real check"
if out="$(run_scenarios "$CHECK_SRC")"; then
  for spec in "${SCENARIOS[@]}"; do echo "ok: ${spec%%:*} -> exit ${spec##*:}"; done
else
  echo "$out" | sed 's/^/  /'
  echo; echo "GATE RED: the check itself does not behave. Fix that before reading mutants." >&2
  exit 1
fi

echo; echo "== mutants (each must make a NAMED scenario fail)"
rc=0

# The TOG-999 defect, reintroduced verbatim: reference resolved from the mutable tree.
mutant reference-from-worktree \
  'if ! git -C "$REPO_ROOT" cat-file blob "$PINNED_BLOB" > "$REF_COPY" 2>/dev/null; then' \
  'if ! cp "$REPO_ROOT/deploy_window_manifest.py" "$REF_COPY" 2>/dev/null; then' \
  correlated || rc=1

# Drop the non-empty guard: an empty reference vs an empty host reads as agreement.
mutant drop-nonempty-guard \
  '[ -s "$REF_COPY" ] || fail "pinned reviewed blob' \
  'true || fail "pinned reviewed blob' \
  empty-pin || rc=1

# Drop the recorded-constant assertion: whatever git returns becomes "reviewed".
mutant drop-sha-constant \
  'if [ "$ref_sha" != "$PINNED_SHA256" ]; then' \
  'if false; then' \
  decoy-pin || rc=1

# Drop the drift comparison entirely — the check's whole reason to exist.
mutant drop-drift-comparison \
  'if [ "$ref_sha" != "$host_sha" ]; then' \
  'if false; then' \
  host-only || rc=1

# Drop the executable-bit assertion: the operator invokes the handoff copy directly.
mutant drop-exec-check \
  '[ -x "$HOST_COPY" ] || fail "handoff copy is not executable' \
  'true || fail "handoff copy is not executable' \
  not-executable || rc=1

echo
if [ "$rc" -eq 0 ]; then
  echo "GATE GREEN: ${#SCENARIOS[@]} scenarios behaved and 5 mutants were killed."
  echo "            The correlated both-copies case (TOG-999) is covered and shown red."
else
  echo "GATE RED: a mutant survived or reddened the wrong scenario (see above)." >&2
fi
exit "$rc"
