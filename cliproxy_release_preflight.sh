#!/usr/bin/env bash
set -uo pipefail

# ===========================================================================
# Fail-closed preflight for the CLIProxy quota-controller release  (TOG-4054)
#
# WHAT THIS GATES. TOG-2694 is the operator card that applies the per-account
# CLIProxy pacing controller built on TOG-2693. Its original handoff told the
# operator to move CLIProxy's session-affinity TTL from 24h to 6h on apply,
# and to restore 24h on rollback. On 2026-09-17 the owner set that TTL to 15m
# (with request-retry 3 and max-retry-credentials 0) to unblock failover after
# 52 runs were refused 429 on a capped account while a second account sat at
# 4% of its window. Either of the old numbers silently reverts that.
#
# This script is the check that runs BEFORE the operator touches the host. It
# refuses — exit 2, no output that looks like a go — when any of these hold:
#
#   1. the handoff document is missing, or its stale-evidence fence is broken
#   2. the handoff carries a live instruction pairing affinity with 6h or 24h
#   3. the quarantined stale-evidence block contains a runnable code fence
#   4. the handoff does not state all three owner-directed failover values
#   5. a measured live failover value is not exactly 15m / 3 / 0
#   6. the measured CLIProxy version is not on the supported list
#   7. --source-ref is not the reviewed controller commit, in 40-hex
#   8. --source-ref is not an ancestor of the trusted line, which is what
#      the quota-controller bundle builder itself requires
#   9. the rollback-state prerequisite for the requested mode is not met
#
# WHY THE MEASURED VALUES ARE ARGUMENTS AND NOT PROBES. Agents have no host
# access here, and this repository has never held a proven read path for
# CLIProxy's routing scalars. The owner's own note records that the
# config-management PUT/PATCH surface answered 404 on v7.3.5 and that routing
# scalars needed a restart, so inventing a read endpoint would be guessing.
# The operator reads the live values and passes them in; this gate is the
# thing that refuses when they are not what the owner directed. It converts a
# human eyeball check into a non-zero exit, which is the part that was missing.
#
# WHAT IT DOES NOT DO. It does not connect to CLIProxy, does not read or write
# any credential, does not mutate configuration, and does not install anything.
# It is read-only over this checkout plus the values you hand it.
# ===========================================================================

readonly REVIEWED_SOURCE_REF="f4f478342dbf62136729e151f55871e4cb9c8da8"

# Measured live on 2026-09-22 and recorded on TOG-3790: v7.3.9, commit
# 61fdfc3, pinned by digest. v7.3.13 was assessed at source level only and is
# explicitly still on hold, so it is NOT on this list. Adding a version here
# means someone re-verified the bundle's commands against that build.
readonly SUPPORTED_CLIPROXY_VERSIONS="v7.3.9"

# The owner's 2026-09-17 00:45Z direction on TOG-2694. These are invariants of
# the release, not tunables of this script.
readonly REQUIRED_AFFINITY_TTL="15m"
readonly REQUIRED_REQUEST_RETRY="3"
readonly REQUIRED_MAX_RETRY_CREDENTIALS="0"

readonly DEFAULT_HANDOFF="docs/runbooks/cliproxy-quota-controller-release.md"

refuse() {
  printf 'REFUSED: %s\n' "$1" >&2
  exit 2
}

usage() {
  cat >&2 <<'USAGE'
usage: cliproxy_release_preflight.sh --mode {apply|rollback} \
         --cliproxy-version <measured> \
         --affinity-ttl <measured> --request-retry <measured> \
         --max-retry-credentials <measured> \
         [--source-ref <40-hex>] [--handoff <path>] \
         [--trusted-line <ref>] [--rollback-state <path>]

Exit 0 only when every check passes. Exit 2 on any refusal.
USAGE
  exit 2
}

require_value() {
  [[ $# -ge 2 && -n "${2:-}" && "${2:-}" != -* ]] \
    || refuse "$1 requires a value"
}

MODE=""
CLIPROXY_VERSION=""
AFFINITY_TTL=""
REQUEST_RETRY=""
MAX_RETRY_CREDENTIALS=""
SOURCE_REF="$REVIEWED_SOURCE_REF"
HANDOFF="$DEFAULT_HANDOFF"
TRUSTED_LINE="origin/main"
ROLLBACK_STATE="/var/lib/paperclip/cliproxy-quota-controller/rollback.json"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) require_value "$@"; MODE="$2"; shift 2;;
    --cliproxy-version) require_value "$@"; CLIPROXY_VERSION="$2"; shift 2;;
    --affinity-ttl) require_value "$@"; AFFINITY_TTL="$2"; shift 2;;
    --request-retry) require_value "$@"; REQUEST_RETRY="$2"; shift 2;;
    --max-retry-credentials) require_value "$@"; MAX_RETRY_CREDENTIALS="$2"; shift 2;;
    --source-ref) require_value "$@"; SOURCE_REF="$2"; shift 2;;
    --handoff) require_value "$@"; HANDOFF="$2"; shift 2;;
    --trusted-line) require_value "$@"; TRUSTED_LINE="$2"; shift 2;;
    --rollback-state) require_value "$@"; ROLLBACK_STATE="$2"; shift 2;;
    -h|--help) usage;;
    *) refuse "unknown argument: $1";;
  esac
done

# --- 0. missing prerequisites are refusals, not defaults -------------------
[[ "$MODE" == "apply" || "$MODE" == "rollback" ]] \
  || refuse "--mode must be apply or rollback"
[[ -n "$CLIPROXY_VERSION" ]] || refuse "--cliproxy-version is required; measure it, do not assume it"
[[ -n "$AFFINITY_TTL" ]] || refuse "--affinity-ttl is required; measure the live value"
[[ -n "$REQUEST_RETRY" ]] || refuse "--request-retry is required; measure the live value"
[[ -n "$MAX_RETRY_CREDENTIALS" ]] || refuse "--max-retry-credentials is required; measure the live value"

# --- 1-4. the handoff document itself --------------------------------------
[[ -f "$HANDOFF" ]] || refuse "handoff document not found: $HANDOFF"

HANDOFF_RC=0
HANDOFF_VERDICT=$(python3 - "$HANDOFF" <<'PY'
from decimal import Decimal
import re
import sys

path = sys.argv[1]
text = open(path, encoding="utf-8").read()
lines = text.splitlines()

BEGIN = "<!-- STALE-EVIDENCE-BEGIN -->"
END = "<!-- STALE-EVIDENCE-END -->"

# The document has to quote the superseded 6h/24h instructions to explain what
# was wrong with them. A gate that simply greps for "24h" would therefore fire
# on the explanation and never on a real regression. So the quoted text lives
# inside one explicit fence, everything outside the fence is treated as live
# instruction, and the fence itself is checked: it must be balanced, and it
# must not contain a runnable code block that could be copy-pasted back out.
begins = [i for i, line in enumerate(lines) if line.strip() == BEGIN]
ends = [i for i, line in enumerate(lines) if line.strip() == END]
if not begins:
    print("stale-evidence fence is missing; live prose cannot be told from quoted history")
    raise SystemExit(1)
if len(begins) != len(ends):
    print(f"stale-evidence fence is unbalanced: {len(begins)} begin, {len(ends)} end")
    raise SystemExit(1)

fenced = []
live = []
depth = 0
for i, line in enumerate(lines):
    stripped = line.strip()
    if stripped == BEGIN:
        if depth:
            print(f"stale-evidence fence is nested at line {i + 1}")
            raise SystemExit(1)
        depth += 1
        continue
    if stripped == END:
        if not depth:
            print(f"stale-evidence fence closes before it opens at line {i + 1}")
            raise SystemExit(1)
        depth -= 1
        continue
    (fenced if depth else live).append((i + 1, line))
if depth:
    print("stale-evidence fence never closes")
    raise SystemExit(1)

for number, line in fenced:
    if line.lstrip().startswith("```"):
        print(f"quarantined stale evidence carries a runnable code fence at line {number}")
        raise SystemExit(1)

# Treat live instructions as one surface: wrapping, blank lines and table
# cells cannot hide a duration from its affinity label. Superseded durations
# belong only in the validated history fence, not elsewhere in this handoff.
# Parse equivalent units rather than matching just '6h'/'24h'; a sentence's
# trailing period is punctuation, while the decimal in '6.0 hours' is numeric.
live_text = "\n".join(line for _, line in live)
duration = re.compile(
    r"(?<![\w.])(?P<amount>\d+(?:\.\d+)?|\.\d+)\s*"
    r"(?P<unit>days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?!\w)",
    re.IGNORECASE,
)
seconds_per_unit = {"d": 86400, "h": 3600, "m": 60, "s": 1}
if re.search(r"affinit\w*", live_text, re.IGNORECASE):
    for match in duration.finditer(live_text):
        seconds = Decimal(match["amount"]) * seconds_per_unit[match["unit"][0].lower()]
        if seconds in (21600, 86400):
            number, line = live[live_text.count("\n", 0, match.start())]
            print(f"live instruction pairs session affinity with a superseded TTL at line {number}: {line.strip()[:120]}")
            raise SystemExit(1)

if not re.search(r"(?<![\w.])15m(?![\w.])", live_text):
    print("handoff never states the required 15m session-affinity TTL")
    raise SystemExit(1)
if not re.search(r"request-retry[^\n]*?(?<![\w.])3(?![\w.])", live_text, re.IGNORECASE):
    print("handoff never states the required request-retry 3")
    raise SystemExit(1)
if not re.search(r"max-retry-credentials[^\n]*?(?<![\w.])0(?![\w.])", live_text, re.IGNORECASE):
    print("handoff never states the required max-retry-credentials 0")
    raise SystemExit(1)

print("ok")
PY
) || HANDOFF_RC=$?
# `rc=$?` on the line after an assignment reads the assignment, so the failure
# is captured on the assignment itself — see the pipefail note in the header.
[[ $HANDOFF_RC -eq 0 ]] || refuse "handoff document: ${HANDOFF_VERDICT:-lint failed with no verdict}"
[[ "$HANDOFF_VERDICT" == "ok" ]] || refuse "handoff document: unexpected lint output: ${HANDOFF_VERDICT:-<empty>}"

# --- 5. the measured live failover values ----------------------------------
[[ "$AFFINITY_TTL" == "$REQUIRED_AFFINITY_TTL" ]] \
  || refuse "live session-affinity TTL reads '$AFFINITY_TTL', owner direction is $REQUIRED_AFFINITY_TTL; stop and reconcile before any release step"
[[ "$REQUEST_RETRY" == "$REQUIRED_REQUEST_RETRY" ]] \
  || refuse "live request-retry reads '$REQUEST_RETRY', owner direction is $REQUIRED_REQUEST_RETRY"
[[ "$MAX_RETRY_CREDENTIALS" == "$REQUIRED_MAX_RETRY_CREDENTIALS" ]] \
  || refuse "live max-retry-credentials reads '$MAX_RETRY_CREDENTIALS', owner direction is $REQUIRED_MAX_RETRY_CREDENTIALS"

# --- 6. the measured CLIProxy version --------------------------------------
version_supported=1
for supported in $SUPPORTED_CLIPROXY_VERSIONS; do
  [[ "$CLIPROXY_VERSION" == "$supported" ]] && version_supported=0
done
[[ $version_supported -eq 0 ]] \
  || refuse "CLIProxy '$CLIPROXY_VERSION' is not a version this bundle has been verified against (supported: $SUPPORTED_CLIPROXY_VERSIONS); re-verify the commands first"

# --- 7-8. the reviewed commit, and whether it can actually be built --------
[[ "$SOURCE_REF" =~ ^[0-9a-f]{40}$ ]] || refuse "--source-ref must be a 40-hex commit"
[[ "$SOURCE_REF" == "$REVIEWED_SOURCE_REF" ]] \
  || refuse "--source-ref $SOURCE_REF is not the reviewed controller commit $REVIEWED_SOURCE_REF"

if [[ "$MODE" == "apply" ]]; then
  # The quota-controller bundle builder refuses to build a tar
  # from a ref that is not an ancestor of its trusted line. Discovering that at
  # build time on the host is a wasted deploy window; discover it here.
  [[ "$(git --no-replace-objects cat-file -t "$SOURCE_REF" 2>/dev/null)" == commit ]] \
    || refuse "$SOURCE_REF is not an available commit object in this checkout; fetch the controller branch first"
  git --no-replace-objects rev-parse -q --verify "$TRUSTED_LINE^{commit}" >/dev/null 2>&1 \
    || refuse "--trusted-line $TRUSTED_LINE does not resolve; fetch it first"
  git --no-replace-objects merge-base --is-ancestor "$SOURCE_REF" "$TRUSTED_LINE" 2>/dev/null \
    || refuse "$SOURCE_REF is not an ancestor of $TRUSTED_LINE, so the reviewed bundle cannot be built; land the controller on the trusted line first"
fi

# --- 9. the rollback-state prerequisite for this mode ----------------------
# cliproxy_quota_controller.py writes its captured priority/weight/disabled
# fields to the rollback state on apply and refuses to overwrite a state that
# covers different auth keys; rollback reads that same file and fails without
# it. Each mode therefore has an opposite prerequisite.
if [[ "$MODE" == "apply" ]]; then
  [[ ! -e "$ROLLBACK_STATE" ]] \
    || refuse "rollback state already exists at $ROLLBACK_STATE; an earlier apply was never rolled back or archived"
else
  [[ -f "$ROLLBACK_STATE" ]] \
    || refuse "rollback state $ROLLBACK_STATE is missing; the controller has no captured fields to restore"
fi

cat <<EOF
PASS cliproxy_release_preflight ($MODE)
  handoff            $HANDOFF
  cliproxy version   $CLIPROXY_VERSION (supported)
  session-affinity   $AFFINITY_TTL
  request-retry      $REQUEST_RETRY
  max-retry-creds    $MAX_RETRY_CREDENTIALS
  source ref         $SOURCE_REF
  rollback state     $ROLLBACK_STATE
EOF
exit 0
