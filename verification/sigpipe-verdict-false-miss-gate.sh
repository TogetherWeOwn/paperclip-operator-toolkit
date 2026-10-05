#!/usr/bin/env bash
# =====================================================================================
# sigpipe-verdict-false-miss-gate.sh — a matched pattern must never read as a miss
#
# THE DEFECT (observed red on PR #304 head 348f354f, job 104785240882, step 75):
#
#     set -o pipefail
#     if printf '%s' "$out" | grep -qF "FAIL  $case_name"; then ... else FAIL; fi
#
# `grep -q` exits the instant it matches, WITHOUT draining stdin. That closes the read
# end of the pipe while `printf` is still writing, so `printf` takes EPIPE/SIGPIPE and
# exits non-zero. Under `pipefail` the pipeline inherits THAT status, not grep's — so a
# pattern that WAS found is reported as not found, and the gate emits a false verdict.
#
# The broken pipe is itself proof the match happened: `grep -q` only stops reading early
# when it matches. A miss makes grep read to EOF, which can never strand the producer.
#
# It is a race, so it is rare on an idle box and shows up under CI load. Above the pipe
# capacity the producer MUST block mid-write, which makes it deterministic — that is the
# positive control below. Without that control a green here would be unfalsifiable.
#
# THE FIX: drop the pipeline. `grep -qF PAT <<<"$var"` has no producer to strand and no
# pipeline status for pipefail to poison.
#
#   ./verification/sigpipe-verdict-false-miss-gate.sh
#
# Exit 0 = the mechanism is demonstrated, the fixed form is immune, and no verdict site
#          in the tree still routes a variable into an early-exiting grep through a pipe.
# =====================================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT" || exit 4

pass=0; fail=0
red() { printf '\033[31m%s\033[0m\n' "$*"; }
grn() { printf '\033[32m%s\033[0m\n' "$*"; }
ok()  { grn "  PASS  $1"; pass=$((pass+1)); }
no()  { red "  FAIL  $1"; shift; for l in "$@"; do red "        $l"; done; fail=$((fail+1)); }

NEEDLE='FAIL  URL with userinfo is a credential in a URL'
# Needle on line 1, then enough filler to exceed any pipe capacity, so the producer is
# guaranteed to still be writing when an early-exiting consumer walks away.
PAYLOAD="$NEEDLE"$'\n'"$(yes '  PASS  filler ..................................................' \
                        | head -n 60000)"
ITERS=20

echo "=== the mechanism: under pipefail, an early-exiting consumer poisons the status ==="
printf 'payload %d bytes across %d lines; needle on line 1\n\n' \
  "${#PAYLOAD}" "$(($(grep -c '' <<<"$PAYLOAD")))"

# --- POSITIVE CONTROL 1. Consumer-agnostic: `head -c 1` provably stops after one byte.
# If this does not fire, this box cannot exhibit the defect and every green below is
# meaningless — so it is a FAIL, never a skip.
printf '%s' "$PAYLOAD" | head -c 1 >/dev/null
ctl=("${PIPESTATUS[@]}")
if [ "${ctl[0]}" != "0" ]; then
  ok "control: producer stranded by an early-exiting consumer (printf rc=${ctl[0]})"
else
  no "control did NOT fire: printf completed despite the consumer exiting after 1 byte." \
     "This environment cannot exhibit the defect, so this gate proves nothing here." \
     "Do not read a green from this run as evidence."
fi

# --- POSITIVE CONTROL 2. The real construct: grep -q matched, yet the pipeline is red.
lost=0; matched_but_red=0
for ((i = 0; i < ITERS; i++)); do
  printf '%s' "$PAYLOAD" | grep -qF "$NEEDLE"
  # PIPESTATUS must be copied by the VERY next command: any other command, including
  # a plain `st=$?` assignment, overwrites it with its own one-element status.
  ps=("${PIPESTATUS[@]}")
  redp=0; for s in "${ps[@]}"; do [ "$s" = "0" ] || redp=1; done   # what pipefail yields
  # grep itself matched; only the producer's EPIPE can have made the pipeline red.
  [ "${ps[1]}" = "0" ] && [ "$redp" = "1" ] && matched_but_red=$((matched_but_red+1))
  [ "${ps[0]}" = "0" ] || lost=$((lost+1))
done
if [ "$matched_but_red" -gt 0 ]; then
  ok "old form: grep MATCHED but the pipeline read red in $matched_but_red/$ITERS runs"
else
  # Some greps (e.g. ugrep) drain stdin instead of exiting on match. Say so loudly:
  # a green from an environment that cannot lose the race is not evidence of a fix.
  no "the grep here never stranded the producer ($lost/$ITERS) — control 2 is inert." \
     "grep: $(grep --version 2>&1 | head -1)" \
     "GNU grep -q exits on match and DOES strand it; that is what CI runs."
fi

echo
echo "=== the fix: a herestring has no producer to strand ==="
bad=0
for ((i = 0; i < ITERS; i++)); do
  grep -qF "$NEEDLE" <<<"$PAYLOAD" || bad=$((bad+1))
done
if [ "$bad" = "0" ]; then
  ok "fixed form: the match is reported $ITERS/$ITERS times"
else
  no "fixed form lost the match in $bad/$ITERS runs"
fi

# ...and it must still be capable of reporting a genuine miss, or it is vacuous.
if grep -qF "a string that is definitely not in the payload" <<<"$PAYLOAD"; then
  no "fixed form reported a match for a pattern that is not present"
else
  ok "fixed form still reports a genuine miss as a miss"
fi

echo
echo "=== no verdict site in the tree still pipes a variable into an early-exiting grep ==="

scan() { # scan <dir> [self] — prints one "file:line: text" per offending site, rc=1 if any
  SCANDIR="$1" SCANSELF="${2:-}" python3 - <<'PY'
import os, re, subprocess, pathlib, sys

root = pathlib.Path(os.environ["SCANDIR"])
# This gate's own file is the one place the construct must survive: the header
# quotes the defective line, the positive control above deliberately RUNS it, and
# the scanner control below plants it in a heredoc. Skipping it is not a carve-out
# for production code — the planted-violation control proves the scanner still
# fires, and it fires on a file that is not exempt.
selfpath = os.environ.get("SCANSELF") or None

try:
    files = subprocess.run(["git", "ls-files", "*.sh"], cwd=root,
                           capture_output=True, text=True, check=True).stdout.split()
except Exception:
    files = [str(p.relative_to(root)) for p in root.rglob("*.sh")]
if selfpath:
    if selfpath not in files:
        print(f"SELF-EXCLUSION STALE: {selfpath} is not in the scanned file list")
        sys.exit(2)
    files = [f for f in files if f != selfpath]

# Only grep -q / --quiet / --silent / -m N stop reading before EOF; every other grep
# drains stdin and so can never strand the producer.
early = r"grep\s+(?=(?:-[A-Za-z]*(?:q|m\b|m[0-9])|--quiet|--silent|--max-count))"
pat = re.compile(r'printf\s+(?:\'[^\']*\'|"[^"]*")\s+"\$\{?[A-Za-z_]\w*\}?"\s*\|\s*'
                 + early)

hits = 0
for f in files:
    p = root / f
    try:
        txt = p.read_text()
    except Exception:
        continue
    if not re.search(r"^\s*set\s+.*pipefail", txt, re.M):
        continue          # without pipefail the producer's EPIPE cannot win the status
    for i, line in enumerate(txt.splitlines(), 1):
        if pat.search(line):
            print(f"{f}:{i}: {line.strip()[:100]}")
            hits += 1
sys.exit(1 if hits else 0)
PY
}

SELF_REL="${BASH_SOURCE[0]#./}"; SELF_REL="verification/$(basename "$SELF_REL")"
hits="$(scan "$ROOT" "$SELF_REL")"; scan_rc=$?
if [ "$scan_rc" = "2" ]; then
  no "the self-exclusion no longer matches a tracked file — the scan is not covering" \
     "what it thinks it is: $hits"
elif [ "$scan_rc" = "0" ]; then
  ok "zero pipefail-poisoned verdict sites in the tree (excluding this file)"
else
  n=$(grep -c '' <<<"$hits")
  no "$n site(s) still pipe a variable into an early-exiting grep under pipefail:"
  while IFS= read -r l; do red "        $l"; done <<<"$hits"
fi

# --- The scanner must be able to FAIL. A scan that cannot go red has measured nothing.
probe="$(mktemp -d)"; trap 'rm -rf "$probe"' EXIT
( cd "$probe" && git init -q . && git config user.email a@b && git config user.name a )
cat > "$probe/planted.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if printf '%s' "$out" | grep -qF "needle"; then :; fi
EOF
( cd "$probe" && git add -A && git commit -qm p )
if scan "$probe" >/dev/null; then
  no "the scanner stayed GREEN on a deliberately planted violation — it is vacuous"
else
  ok "scanner control: a planted violation is detected"
fi
# ...and it must not fire on the same line without pipefail (that shape is safe).
sed -i 's/^set -euo pipefail$/set -eu/' "$probe/planted.sh"
( cd "$probe" && git add -A && git commit -qm p2 )
if scan "$probe" >/dev/null; then
  ok "scanner control: the same line without pipefail is correctly NOT flagged"
else
  no "scanner flagged a shape that pipefail cannot poison — it would force noise edits"
fi

echo
if [ "$fail" = "0" ]; then
  grn "sigpipe verdict gate: $pass passed, 0 failed"
else
  red "sigpipe verdict gate: $pass passed, $fail FAILED"
fi
exit $((fail > 0 ? 1 : 0))
