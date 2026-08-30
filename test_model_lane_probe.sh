#!/usr/bin/env bash
# ===========================================================================
# test_model_lane_probe.sh — offline suite for the cheap/small-fast lane probe
# (TOG-682).
#
# No database and no gateway: the surface rows arrive through
# MODEL_SURFACE_SOURCE_CMD and the HTTP result through MODEL_PROBE_CMD, the
# same way the roster arrives through ROSTER_SOURCE_CMD in
# test_quota_brake.sh. That is what lets CI run this.
#
# THE FIXTURES ARE REAL. Every model id and every HTTP code below was measured
# against the live gateway on 2026-08-30 and re-confirmed while writing this
# file:
#
#     cliproxy/claude-haiku-4-5-20251001      -> 200
#     claude-haiku-4-5-20251001      (BARE)   -> 200
#     cliproxy/claude-haiku-4-5      (undated)-> 400 unknown provider for model
#     cliproxy/claude-haiku-4-5-20251001-low  -> 400 unknown provider for model
#     gpt-5.4-mini                            -> 200  (bare; 503 on 2026-08-29,
#                                                      NOT current — do not cite)
#
# WHAT THIS SUITE IS BUILT TO CATCH, beyond the happy path:
#
#  * THE FAIL-OPEN. Section 2 pins that a BARE id answering HTTP 200 is an
#    ALARM. This is the whole reason the tool checks a prefix at all, and it is
#    the assertion most likely to be "simplified" away by someone who reads the
#    probe as an uptime check. A bare id is live, bills a PAYG leg instead of
#    the owner's subscription, and is invisible to every status-only monitor.
#
#  * A MONITOR THAT READS GREEN WHILE BLIND. Section 4 asserts that an
#    unreadable source, ZERO surface rows, a short read and a probe that
#    returns no HTTP status all exit non-zero — 5, never 0. Zero alarms counted
#    from a source that never answered is "never ran", not "clean".
#
#  * ONE SURFACE FIXED, THE OTHER STILL DEAD. Section 3 is TOG-679/TOG-680's
#    actual disagreement replayed: adapterConfig pinned and healthy while
#    runtimeConfig.modelProfiles.cheap is undated and 400. A tool that
#    coalesced the surfaces would report the healthy one and exit 0.
#
#  * A FILTER READ AS FULL COVERAGE. Section 5 asserts --surface both narrows
#    the probe AND says so, and that a filter matching nothing is a REFUSAL
#    rather than a clean fleet.
#
#  * ADJACENCY. Several inputs here would also be rejected by a neighbouring
#    guard, which is how an exit-code-only assertion goes green for the wrong
#    reason. Every assertion below pins the REASON string as well as the exit
#    status, so a refusal from the wrong branch fails the test.
# ===========================================================================
set -uo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$HERE/model_lane_probe.sh"
PASS=0; FAIL=0

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; }
sect() { printf '\n== %s\n' "$1"; }

# The suite must never reach the real database or the real gateway. Both seams
# default to something that FAILS rather than something that succeeds quietly:
# a test that silently fell through to pg_source.js would pass here and fail in
# CI, which is the worst of both.
export MODEL_SURFACE_SOURCE_CMD="false"
export MODEL_PROBE_CMD="false"
unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY 2>/dev/null || true

# --- fixture helpers --------------------------------------------------------

# EVERY FIXTURE GETS ITS OWN PATH. The first version of these helpers named
# their file with `$$`, which is the SHELL's pid and is therefore constant for
# the whole suite — so every later fixture overwrote the earlier one, and
# `$DRIFT_SRC`, captured in section 3, silently became section 4's single-row
# fixture by the time section 5 ran it. Three tests failed on a fixture nobody
# had changed. This is the same shared-path bug TOG-485 hit with its response
# files; a counter is the fix.
# UNIQUENESS HAS TO LIVE ON DISK, NOT IN SHELL STATE. Every caller invokes
# these helpers as `SRC="$(surfaces ...)"` — a command-substitution SUBSHELL —
# so a counter variable is discarded the instant the helper returns, and every
# fixture would land on the same path no matter how carefully the counter was
# written. `mktemp` allocates atomically in the filesystem, which is the only
# thing here that outlives the subshell.
new_fixture() { mktemp "$WORK/$1.XXXXXXXX"; }

# A surface source emitting the given TSV rows.
surfaces() {
  local f; f="$(new_fixture surfaces.tsv)"
  printf '%s\n' "$@" > "$f"
  printf 'cat %q' "$f"
}

# A probe that answers from a lookup table: "<model>=<code>:<body>" pairs.
# An id absent from the table is a test-authoring bug and answers 000, which
# the tool reports as unmeasured rather than as a pass.
probe_table() {
  local f; f="$(new_fixture probe.sh)"
  {
    echo '#!/usr/bin/env bash'
    echo 'case "$1" in'
    local pair model rest
    for pair in "$@"; do
      model="${pair%%=*}"; rest="${pair#*=}"
      printf '  %q) printf "%%s\\t%%s\\n" %q %q ;;\n' \
        "$model" "${rest%%:*}" "${rest#*:}"
    done
    echo '  *) printf "000\t(no response completed)\n" ;;'
    echo 'esac'
  } > "$f"
  chmod +x "$f"
  printf '%q' "$f"
}

# run <expected_exit> <name> <expect_substr> -- runs $TOOL with the given args.
# Pins BOTH the exit status and a substring of the output, so a refusal that
# came from the wrong branch fails rather than passing on the status alone.
run() {
  local want="$1" name="$2" expect="$3"; shift 3
  local out rc=0
  out="$("$TOOL" "$@" 2>&1)" || rc=$?
  if [[ "$rc" != "$want" ]]; then
    bad "$name (exit $rc, wanted $want)"
    printf '%s\n' "$out" | sed 's/^/       | /' | head -12
    return
  fi
  if [[ -n "$expect" && "$out" != *"$expect"* ]]; then
    bad "$name (exit $want as wanted, but output lacks: $expect)"
    printf '%s\n' "$out" | sed 's/^/       | /' | head -12
    return
  fi
  ok "$name"
}

PINNED='cliproxy/claude-haiku-4-5-20251001'
BARE='claude-haiku-4-5-20251001'
UNDATED='cliproxy/claude-haiku-4-5'
LOW='cliproxy/claude-haiku-4-5-20251001-low'

SF='adapterConfig.env.ANTHROPIC_SMALL_FAST_MODEL'
DH='adapterConfig.env.ANTHROPIC_DEFAULT_HAIKU_MODEL'
CH='runtimeConfig.modelProfiles.cheap'

# ===========================================================================
sect "1. the healthy fleet — every surface pinned and live"
# ===========================================================================
MODEL_SURFACE_SOURCE_CMD="$(surfaces \
  "a1	Agent One	$SF	$PINNED" \
  "a1	Agent One	$DH	$PINNED" \
  "a1	Agent One	$CH	$PINNED")" \
MODEL_PROBE_CMD="$(probe_table "$PINNED=200:{\"id\":\"msg_x\"}")" \
run 0 "all three surfaces pinned and 200 -> ok" "HTTP 200, prefix-pinned" check

# The coverage claim is that BOTH surfaces were looked at. If the report does
# not name them, a reader cannot tell a two-surface probe from a one-surface
# one, and that ambiguity is how TOG-679 and TOG-680 disagreed for a day.
MODEL_SURFACE_SOURCE_CMD="$(surfaces \
  "a1	Agent One	$SF	$PINNED" \
  "a1	Agent One	$CH	$PINNED")" \
MODEL_PROBE_CMD="$(probe_table "$PINNED=200:ok")" \
run 0 "the healthy report names the adapterConfig surface" "$SF" check

MODEL_SURFACE_SOURCE_CMD="$(surfaces \
  "a1	Agent One	$SF	$PINNED" \
  "a1	Agent One	$CH	$PINNED")" \
MODEL_PROBE_CMD="$(probe_table "$PINNED=200:ok")" \
run 0 "the healthy report names the runtimeConfig surface" "$CH" check

# ===========================================================================
sect "2. THE FAIL-OPEN — a bare id answers 200 and is still an alarm"
# ===========================================================================
# Measured: `claude-haiku-4-5-20251001` with no prefix returns HTTP 200. It is
# a fully working lane on the wrong billing leg. If this assertion is ever
# relaxed to "200 is fine", the tool stops detecting the harder of the two
# failures it was built for.
MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$BARE")" \
MODEL_PROBE_CMD="$(probe_table "$BARE=200:{\"id\":\"msg_x\"}")" \
run 3 "bare id at HTTP 200 -> ALARM-unpinned" "ALARM-unpinned" check

MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$BARE")" \
MODEL_PROBE_CMD="$(probe_table "$BARE=200:{\"id\":\"msg_x\"}")" \
run 3 "the unpinned alarm explains the PAYG fail-open" "fails OPEN" check

# gpt-5.4-mini is bare and, as of 2026-08-30, live at 200. Same verdict: this
# is the shape the ticket named as harder to notice than a dead lane.
MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	gpt-5.4-mini")" \
MODEL_PROBE_CMD="$(probe_table "gpt-5.4-mini=200:{\"id\":\"resp_x\"}")" \
run 3 "live-but-bare gpt-5.4-mini -> ALARM-unpinned" "ALARM-unpinned" check

# An alarm must name the agents to fix. A finding with no fix list is a page
# with no runbook.
MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$BARE")" \
MODEL_PROBE_CMD="$(probe_table "$BARE=200:ok")" \
run 3 "an alarm names the affected agent" "Agent One" check

# ===========================================================================
sect "3. a dead lane, and ONE SURFACE FIXED WHILE THE OTHER IS NOT"
# ===========================================================================
MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$UNDATED")" \
MODEL_PROBE_CMD="$(probe_table "$UNDATED=400:{\"error\":{\"message\":\"unknown provider for model claude-haiku-4-5\"}}")" \
run 3 "undated id at HTTP 400 -> ALARM-dead" "ALARM-dead" check

MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$UNDATED")" \
MODEL_PROBE_CMD="$(probe_table "$UNDATED=400:{\"error\":{\"message\":\"unknown provider for model claude-haiku-4-5\"}}")" \
run 3 "the dead-lane alarm carries the upstream message" "unknown provider" check

# The `-low` trap: reasoning effort glued onto the model string is a 400. This
# is the shape a well-meaning "fix" produces.
MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$LOW")" \
MODEL_PROBE_CMD="$(probe_table "$LOW=400:{\"error\":{\"message\":\"unknown provider for model claude-haiku-4-5-20251001-low\"}}")" \
run 3 "-low suffixed id -> ALARM-dead" "ALARM-dead" check

# THE TOG-679/TOG-680 DISAGREEMENT, REPLAYED. adapterConfig is pinned and
# healthy; runtimeConfig.modelProfiles.cheap is undated and dead. A tool that
# collapsed the two surfaces would probe the first id it saw and exit 0.
DRIFT_SRC="$(surfaces \
  "a1	Agent One	$SF	$PINNED" \
  "a1	Agent One	$DH	$PINNED" \
  "a1	Agent One	$CH	$UNDATED")"
DRIFT_PROBE="$(probe_table "$PINNED=200:ok" "$UNDATED=400:{\"error\":\"unknown provider\"}")"

MODEL_SURFACE_SOURCE_CMD="$DRIFT_SRC" MODEL_PROBE_CMD="$DRIFT_PROBE" \
run 3 "adapterConfig healthy + runtimeConfig dead -> still an ALARM" "ALARM-dead" check

MODEL_SURFACE_SOURCE_CMD="$DRIFT_SRC" MODEL_PROBE_CMD="$DRIFT_PROBE" \
run 3 "the drift alarm names the runtimeConfig surface as the dead one" "$CH" check

# And the mirror image, because the drift runs both ways: the agent-writable
# surface fixed, the console-only one left behind.
MIRROR_SRC="$(surfaces \
  "a1	Agent One	$SF	$UNDATED" \
  "a1	Agent One	$CH	$PINNED")"
MODEL_SURFACE_SOURCE_CMD="$MIRROR_SRC" MODEL_PROBE_CMD="$DRIFT_PROBE" \
run 3 "runtimeConfig healthy + adapterConfig dead -> still an ALARM" "$SF" check

# An alarm outranks an unmeasured id: a lane we KNOW is dead is worth paging on
# even when a second one could not be reached. Exit 3, not 5.
MODEL_SURFACE_SOURCE_CMD="$(surfaces \
  "a1	Agent One	$SF	$UNDATED" \
  "a1	Agent One	$CH	unreachable/model")" \
MODEL_PROBE_CMD="$(probe_table "$UNDATED=400:{\"error\":\"unknown provider\"}")" \
run 3 "a known-dead id outranks an unmeasured one" "ALARM-dead" check

# ===========================================================================
sect "4. A MONITOR THAT READS GREEN WHILE BLIND — every blind path is exit 5"
# ===========================================================================
# Zero alarms counted from a source that never answered is "never ran".
MODEL_SURFACE_SOURCE_CMD="false" \
run 5 "an unreadable surface source -> UNKNOWN, never 0" "could not read the model surfaces" check

MODEL_SURFACE_SOURCE_CMD="true" \
run 5 "ZERO surface rows -> UNKNOWN, never 0" "Zero rows is 'never looked'" check

# The floor. A source that answers with three rows when the fleet is 141 has
# half-failed, and half-failing must not read as a clean fleet.
MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$PINNED")" \
MODEL_PROBE_CMD="$(probe_table "$PINNED=200:ok")" \
MIN_SURFACES_EXPECTED=141 \
run 5 "a short read against the expected floor -> UNKNOWN" "not a clean fleet" check

# A probe that returns no HTTP status is neither a pass nor an alarm: reporting
# an unreachable gateway as a dead lane pages the wrong on-call.
MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$PINNED")" \
MODEL_PROBE_CMD="false" \
run 5 "a probe command that fails -> UNKNOWN, not ALARM" "unmeasured" check

# HTTP 000 is curl's "no response completed" — it means the request never
# reached the gateway. `is_int 000` is TRUE and `000 != 200` is TRUE, so the
# naive ordering scores it as a DEAD LANE and pages the model owner for what
# may be a network fault. It is unmeasured.
MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$PINNED")" \
MODEL_PROBE_CMD="$(probe_table "other/model=200:ok")" \
run 5 "an HTTP code of 000 -> UNKNOWN, not a dead lane" "no HTTP status" check

MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$PINNED")" \
MODEL_PROBE_CMD="$(probe_table "other/model=200:ok")" \
run 5 "an HTTP code of 000 is not reported as ALARM-dead" "unmeasured" check

# The prefix gate reads the CONFIGURED STRING, so it is fully measured even
# when the gateway is unreachable. An unpinned id must alarm regardless — the
# billing leg is wrong whether or not we can reach it today.
MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$BARE")" \
MODEL_PROBE_CMD="false" \
run 3 "an unpinned id alarms even when the gateway is unreachable" "ALARM-unpinned" check

# A row that lost a column is corruption, not an absent model id. `IFS=$'\t'
# read` shifts every field left on a short row, so the model id would silently
# become the empty string and the fleet would score clean.
MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH")" \
run 5 "a short/malformed row -> UNKNOWN, not an absent id" "malformed" check

# MIN_SURFACES_EXPECTED is compared numerically. A non-integer must be refused
# rather than reaching `(( ))`, where an empty string compares as zero and every
# floor check silently passes.
MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$PINNED")" \
MODEL_PROBE_CMD="$(probe_table "$PINNED=200:ok")" \
MIN_SURFACES_EXPECTED="lots" \
run 2 "a non-integer floor is REFUSED, not silently zero" "must be an integer" check

# ===========================================================================
sect "5. a filtered run must never read as full coverage"
# ===========================================================================
MODEL_SURFACE_SOURCE_CMD="$DRIFT_SRC" MODEL_PROBE_CMD="$DRIFT_PROBE" \
run 0 "--surface can prove the adapterConfig half alone" "HTTP 200, prefix-pinned" \
  check --surface adapterConfig

MODEL_SURFACE_SOURCE_CMD="$DRIFT_SRC" MODEL_PROBE_CMD="$DRIFT_PROBE" \
run 0 "a filtered run SAYS the other surfaces were not probed" "were NOT probed" \
  check --surface adapterConfig

MODEL_SURFACE_SOURCE_CMD="$DRIFT_SRC" MODEL_PROBE_CMD="$DRIFT_PROBE" \
run 3 "--surface runtimeConfig still finds the dead half" "ALARM-dead" \
  check --surface runtimeConfig

# A filter that matches nothing measured nothing. Reporting that as a clean
# fleet is the same silent-green bug one level down.
MODEL_SURFACE_SOURCE_CMD="$DRIFT_SRC" MODEL_PROBE_CMD="$DRIFT_PROBE" \
run 2 "--surface matching no rows is REFUSED, not clean" "matched none of the" \
  check --surface nosuchsurface

# ===========================================================================
sect "6. usage, inventory and the JSON shape"
# ===========================================================================
run 2 "no command is a refusal, not a silent success" "usage:"
run 2 "an unknown command is refused" "unknown command"  bogus
run 2 "an unknown option is refused" "unknown argument" check --nope

MODEL_SURFACE_SOURCE_CMD="$DRIFT_SRC" \
run 0 "surfaces lists the inventory without touching the network" "$CH" surfaces

# The quiet path must stay small enough to read. 47 agents x 3 surfaces is 141
# lines of "everything is fine" on every scheduled run, and an alarm buried in
# 141 lines is an alarm nobody sees.
BIG=(); for i in $(seq 1 47); do
  BIG+=("a$i	Agent $i	$SF	$PINNED" "a$i	Agent $i	$DH	$PINNED" "a$i	Agent $i	$CH	$PINNED")
done
BIG_SRC="$(surfaces "${BIG[@]}")"
lines="$(MODEL_SURFACE_SOURCE_CMD="$BIG_SRC" MODEL_PROBE_CMD="$(probe_table "$PINNED=200:ok")" \
  "$TOOL" check 2>&1 | wc -l)"
if (( lines <= 12 )); then
  ok "a healthy 141-row fleet reports in $lines lines, not 141"
else
  bad "a healthy 141-row fleet printed $lines lines — too noisy to read as a monitor"
fi

# ...but the counts must still be the real ones, or the collapse hid the fleet.
MODEL_SURFACE_SOURCE_CMD="$BIG_SRC" MODEL_PROBE_CMD="$(probe_table "$PINNED=200:ok")" \
run 0 "the collapsed report still counts all 47 per surface" "47 agent(s) on $CH" check

MODEL_SURFACE_SOURCE_CMD="$BIG_SRC" MODEL_PROBE_CMD="$(probe_table "$PINNED=200:ok")" \
run 0 "the collapsed report still totals 141 surface rows" "across 141 surface rows" check

# A capped alarm list must say it was capped. A silently truncated list reads
# as the whole fix list.
BIG_BARE=(); for i in $(seq 1 47); do BIG_BARE+=("a$i	Agent $i	$CH	$BARE"); done
MODEL_SURFACE_SOURCE_CMD="$(surfaces "${BIG_BARE[@]}")" \
MODEL_PROBE_CMD="$(probe_table "$BARE=200:ok")" \
run 3 "a capped alarm list says it was capped" "WITHHELD" check

MODEL_SURFACE_SOURCE_CMD="$DRIFT_SRC" MODEL_PROBE_CMD="$DRIFT_PROBE" \
run 3 "--json carries the dead verdict" '"verdict":"ALARM-dead"' check --json

MODEL_SURFACE_SOURCE_CMD="$DRIFT_SRC" MODEL_PROBE_CMD="$DRIFT_PROBE" \
run 3 "--json carries the healthy id alongside it" '"verdict":"ok"' check --json

MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$BARE")" \
MODEL_PROBE_CMD="$(probe_table "$BARE=200:ok")" \
run 3 "--json distinguishes unpinned from dead" '"verdict":"ALARM-unpinned"' check --json

# One JSON object per DISTINCT id — not per surface row. 141 rows referencing
# one id is one line, which is what makes the JSONL usable as an alert payload.
json_lines="$(MODEL_SURFACE_SOURCE_CMD="$BIG_SRC" MODEL_PROBE_CMD="$(probe_table "$PINNED=200:ok")" \
  "$TOOL" check --json 2>/dev/null | wc -l)"
if [[ "$json_lines" == "1" ]]; then
  ok "141 rows on one id emit exactly 1 JSON object"
else
  bad "141 rows on one id emitted $json_lines JSON objects, wanted 1"
fi

# An unmeasured id must be visible in the JSON too, or an alerting pipeline
# reading only this stream cannot tell a probed fleet from an unprobed one.
MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$PINNED")" \
MODEL_PROBE_CMD="$(probe_table "other/model=200:ok")" \
run 5 "--json carries the unmeasured verdict" '"verdict":"unmeasured"' check --json

# ===========================================================================
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
(( FAIL == 0 )) || exit 1
