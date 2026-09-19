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
# THE LANE UNDER TEST CHANGED ON 2026-09-16 (TOG-2927). The owner retired
# OmniRoute for everything but Hindsight (2026-09-13 rule; 07:36Z cutover,
# TOG-2880), so the fleet now reaches models at the direct CLIProxy endpoint and
# the probe's routing gates are about THAT lane. The combo/provider fixtures
# that used to live here described a gateway no fleet traffic transits; they are
# gone, and the assertions they carried are re-expressed against the direct lane
# rather than dropped. See §2.
#
# THE FIXTURES ARE REAL. Every model id, HTTP code and serving-lane fact below
# was measured against the live lane — the liveness codes on 2026-08-30 and
# 2026-09-05, and the direct-lane facts in-run on 2026-09-16:
#
#     claude-haiku-4-5-20251001               -> 200 from http://cliproxy:8317,
#                                                x-cpa-trace-id present
#     gpt-5.6-luna                            -> 200 from http://cliproxy:8317,
#                                                x-cpa-trace-id present
#     claude-sonnet-5                (BARE)   -> 200 from http://cliproxy:8317
#     cliproxy/claude-haiku-4-5      (undated)-> 400 unknown provider for model
#     cliproxy/claude-haiku-4-5-20251001-low  -> 400 unknown provider for model
#
# WHAT THIS SUITE IS BUILT TO CATCH, beyond the happy path:
#
#  * THE FAIL-OPEN, WHICH IS A LANE AND NOT A SPELLING. Section 2 pins that an
#    id answering 200 from an endpoint other than the fleet's own lane is an
#    ALARM, and — the part with teeth — that a run POINTED at the wrong endpoint
#    alarms even when its probe cannot complete at all. That one is the direct
#    heir of the dormant-failover-leg case: it is a property of configuration, so
#    no single successful request can clear it and no failed one can hide it.
#
#  * THE FALSE ALARM THIS SUITE ONCE ENFORCED. Section 2b pins the TOG-985
#    regression directly: a bare id served by the pinned lane is OK, exit 0. The
#    old suite asserted the opposite — it required an ALARM on any id lacking a
#    `cliproxy/` prefix — and that assertion is why the probe paged the fleet
#    over the owner's own chosen model ids. A monitor that fires on a correct
#    configuration destroys the signal exactly as thoroughly as one that stays
#    silent on a broken one, so both directions are pinned here.
#
#  * A MONITOR THAT READS GREEN WHILE BLIND. Section 4 asserts that an
#    unreadable source, ZERO surface rows, a short read, a probe that returns no
#    HTTP status, and a 200 whose serving lane was never identified all exit
#    non-zero — 5, never 0. Zero alarms counted from a source that never
#    answered is "never ran", not "clean".
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

# The lane the fixtures treat as the fleet's own. Pinned to the real endpoint so
# a fixture and the shipped default can never disagree silently.
PINNED_LANE='http://cliproxy:8317'
export PINNED_LANE_ENDPOINT="$PINNED_LANE"

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

# A probe that answers from a lookup table: "<model>=<code>:<body>" pairs, with
# an optional "@<servingLane>" suffix.
#
# An id absent from the table is a test-authoring bug and answers 000, which the
# tool reports as unmeasured rather than as a pass.
#
# The serving lane is the THIRD field the tool reads. It defaults to the pinned
# lane so that the many cases here that are about LIVENESS do not each have to
# restate the routing; a case that is ABOUT routing appends `@<endpoint>`, and
# `probe_table_nolane` below emits the two-field shape on purpose. The suffix is
# split at the LAST `@` — a JSON body may contain colons, which is why the lane
# cannot simply be the last colon-separated field.
probe_table() {
  local f; f="$(new_fixture probe.sh)"
  {
    echo '#!/usr/bin/env bash'
    echo 'case "$1" in'
    local pair model rest code body lane
    for pair in "$@"; do
      model="${pair%%=*}"; rest="${pair#*=}"
      lane="$PINNED_LANE"
      if [[ "$rest" == *@* ]]; then
        lane="${rest##*@}"; rest="${rest%@*}"
      fi
      code="${rest%%:*}"; body="${rest#*:}"
      printf '  %q) printf "%%s\\t%%s\\t%%s\\n" %q %q %q ;;\n' \
        "$model" "$code" "$body" "$lane"
    done
    echo '  *) printf "000\t(no response completed)\t\n" ;;'
    echo 'esac'
  } > "$f"
  chmod +x "$f"
  printf '%q' "$f"
}

# A probe stub emitting the two-field shape: code and body, no serving lane. The
# tool must read the missing measurement as unmeasured.
probe_table_nolane() {
  local f; f="$(new_fixture probe_nolane.sh)"
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

# The bare id at the centre of TOG-985. Correct, and the old prefix gate alarmed
# on it.
COMBO_OK='claude-sonnet-5'
# An endpoint that is not the fleet's lane.
OTHER_LANE='http://some-other-gateway:9999'

SF='adapterConfig.env.ANTHROPIC_SMALL_FAST_MODEL'
DH='adapterConfig.env.ANTHROPIC_DEFAULT_HAIKU_MODEL'
CH='runtimeConfig.modelProfiles.cheap'

# ===========================================================================
sect "1. the healthy fleet — every surface on the pinned lane and live"
# ===========================================================================
MODEL_SURFACE_SOURCE_CMD="$(surfaces \
  "a1	Agent One	$SF	$PINNED" \
  "a1	Agent One	$DH	$PINNED" \
  "a1	Agent One	$CH	$PINNED")" \
MODEL_PROBE_CMD="$(probe_table "$PINNED=200:{\"id\":\"msg_x\"}")" \
run 0 "all three surfaces on the pinned lane and 200 -> ok" "served by the pinned lane" check

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

# The healthy reason must name the lane and the evidence that identified it. A
# bare "ok" cannot be told apart from a status-only monitor's "ok".
MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$PINNED")" \
MODEL_PROBE_CMD="$(probe_table "$PINNED=200:ok")" \
run 0 "the ok reason names the lane it was served by" "$PINNED_LANE" check

MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$PINNED")" \
MODEL_PROBE_CMD="$(probe_table "$PINNED=200:ok")" \
run 0 "the ok reason names the header that identified the lane" "x-cpa-trace-id" check

# ===========================================================================
sect "2. THE FAIL-OPEN — a lane that is not the fleet's, at HTTP 200"
# ===========================================================================
# An id that answers 200 from an endpoint the fleet does not route through is
# live and is telling you nothing about the fleet. If this assertion is ever
# relaxed to "200 is fine", the tool stops detecting the harder of its two
# failures and becomes a curl in a loop.
MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$BARE")" \
MODEL_PROBE_CMD="$(probe_table "$BARE=200:{\"id\":\"msg_x\"}@$OTHER_LANE")" \
run 3 "an id served by another endpoint at HTTP 200 -> ALARM-unpinned" "ALARM-unpinned" check

MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$BARE")" \
MODEL_PROBE_CMD="$(probe_table "$BARE=200:{\"id\":\"msg_x\"}@$OTHER_LANE")" \
run 3 "the unpinned alarm names the lane it actually reached" "$OTHER_LANE" check

# THE CONFIGURATION CASE — the direct heir of the dormant-failover-leg test. The
# probe is POINTED at an endpoint that is not the fleet's lane. Every request it
# makes could succeed and it would still have measured the wrong thing, so this
# must alarm on configuration alone, BEFORE any network result, and it must
# alarm even when the probe cannot complete at all.
MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$BARE")" \
MODEL_PROBE_CMD="$(probe_table "$BARE=200:ok@$OTHER_LANE")" \
ANTHROPIC_BASE_URL="$OTHER_LANE" \
run 3 "a run pointed at a non-pinned endpoint -> ALARM-unpinned" "ALARM-unpinned" check

MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$BARE")" \
MODEL_PROBE_CMD="false" \
ANTHROPIC_BASE_URL="$OTHER_LANE" \
run 3 "the endpoint pin alarms even when the probe cannot run" "ALARM-unpinned" check

MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$BARE")" \
MODEL_PROBE_CMD="false" \
ANTHROPIC_BASE_URL="$OTHER_LANE" \
run 3 "the endpoint-pin alarm explains that it measured another endpoint" \
  "cannot clear the fleet's lane" check

# ...and a trailing slash is the same endpoint, not a different one. A monitor
# that pages on a URL's punctuation is a monitor that gets silenced.
MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$BARE")" \
MODEL_PROBE_CMD="$(probe_table "$BARE=200:ok")" \
ANTHROPIC_BASE_URL="$PINNED_LANE/" \
run 0 "a trailing slash on the base URL is still the pinned lane" "served by the pinned lane" check

# An alarm must name the agents to fix. A finding with no fix list is a page
# with no runbook.
MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$BARE")" \
MODEL_PROBE_CMD="$(probe_table "$BARE=200:ok@$OTHER_LANE")" \
run 3 "an alarm names the affected agent" "Agent One" check

# ===========================================================================
sect "2b. THE TOG-985 REGRESSION — a bare id on the pinned lane is NOT an alarm"
# ===========================================================================
# This is the assertion the old suite had INVERTED. It required an ALARM on any
# id without a `cliproxy/` prefix, so when the owner set the fleet's cheap
# profile to a bare id the probe paged on 24 agents that were configured exactly
# as intended. The prefix was never the property that mattered — the lane is.
MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$COMBO_OK")" \
MODEL_PROBE_CMD="$(probe_table "$COMBO_OK=200:{\"id\":\"msg_x\"}")" \
run 0 "a bare id served by the pinned lane -> ok, NOT an alarm" \
  "served by the pinned lane" check

# The whole fleet on the owner's bare id is a clean run, not a 24-agent page.
FLEET=(); for i in $(seq 1 24); do FLEET+=("a$i	Agent $i	$CH	$COMBO_OK"); done
MODEL_SURFACE_SOURCE_CMD="$(surfaces "${FLEET[@]}")" \
MODEL_PROBE_CMD="$(probe_table "$COMBO_OK=200:ok")" \
run 0 "24 agents on the owner's bare id -> 0 alarms" "0 alarm(s)" check

# The prefixed form is equally fine — this is NOT a rule that bans the prefix,
# only one that stops treating it as the measurement. Both spellings are ok when
# the pinned lane serves them, and neither is a "fix" for the other.
MODEL_SURFACE_SOURCE_CMD="$(surfaces \
  "a1	Agent One	$CH	$COMBO_OK" \
  "a2	Agent Two	$CH	cliproxy/claude-sonnet-5")" \
MODEL_PROBE_CMD="$(probe_table "$COMBO_OK=200:ok" "cliproxy/claude-sonnet-5=200:ok")" \
run 0 "bare and prefixed forms of the same model are both ok" "0 alarm(s)" check

# THE PREFIX MUST NOT BE THE TEST. A prefixed id served by another endpoint is
# an alarm despite the prefix — the mirror of the case above, and the reason the
# string test cannot be kept "as a cheap first check".
MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	cliproxy/claude-sonnet-5")" \
MODEL_PROBE_CMD="$(probe_table "cliproxy/claude-sonnet-5=200:ok@$OTHER_LANE")" \
run 3 "a PREFIXED id served by another endpoint is still ALARM-unpinned" \
  "$OTHER_LANE" check

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

# THE TOG-679/TOG-680 DISAGREEMENT, REPLAYED. adapterConfig is healthy;
# runtimeConfig.modelProfiles.cheap is undated and dead. A tool that collapsed
# the two surfaces would probe the first id it saw and exit 0.
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

# The floor. A source that answers with three rows when the fleet is 77 has
# half-failed, and half-failing must not read as a clean fleet.
MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$PINNED")" \
MODEL_PROBE_CMD="$(probe_table "$PINNED=200:ok")" \
MIN_SURFACES_EXPECTED=77 \
run 5 "a short read against the expected floor -> UNKNOWN" "not a clean fleet" check

# A probe that returns no HTTP status is neither a pass nor an alarm: reporting
# an unreachable endpoint as a dead lane pages the wrong on-call.
MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$PINNED")" \
MODEL_PROBE_CMD="false" \
run 5 "a probe command that fails -> UNKNOWN, not ALARM" "unmeasured" check

# HTTP 000 is curl's "no response completed" — it means the request never
# reached the lane. `is_int 000` is TRUE and `000 != 200` is TRUE, so the naive
# ordering scores it as a DEAD LANE and pages the model owner for what may be a
# network fault. It is unmeasured.
MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$PINNED")" \
MODEL_PROBE_CMD="$(probe_table "other/model=200:ok")" \
run 5 "an HTTP code of 000 -> UNKNOWN, not a dead lane" "no HTTP status" check

MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$PINNED")" \
MODEL_PROBE_CMD="$(probe_table "other/model=200:ok")" \
run 5 "an HTTP code of 000 is not reported as ALARM-dead" "unmeasured" check

# THE MISSING MEASUREMENT MUST NOT READ AS A PASS. A 200 whose serving lane was
# never identified is `unmeasured`: "alive" is not "on the pinned lane", and
# scoring it green is how a status-only monitor stays green while pointed at
# something else wearing the right address. This is the assertion that carried
# the whole exit-5 result of 2026-09-16 — it must keep its teeth on the lane the
# fleet actually uses, not be relaxed because the old gateway's header is gone.
MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$PINNED")" \
MODEL_PROBE_CMD="$(probe_table_nolane "$PINNED=200:ok")" \
run 5 "a probe that reports no serving lane -> UNKNOWN, not ok" \
  "was NOT identified" check

MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$PINNED")" \
MODEL_PROBE_CMD="$(probe_table_nolane "$PINNED=200:ok")" \
run 5 "the unidentified-lane reason says alive is not pinned" \
  "Alive is not the same as on the pinned lane" check

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
run 0 "--surface can prove the adapterConfig half alone" "served by the pinned lane" \
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
# 141 lines is invisible.
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
BIG_OFF=(); for i in $(seq 1 47); do BIG_OFF+=("a$i	Agent $i	$CH	$BARE"); done
MODEL_SURFACE_SOURCE_CMD="$(surfaces "${BIG_OFF[@]}")" \
MODEL_PROBE_CMD="$(probe_table "$BARE=200:ok@$OTHER_LANE")" \
run 3 "a capped alarm list says it was capped" "WITHHELD" check

MODEL_SURFACE_SOURCE_CMD="$DRIFT_SRC" MODEL_PROBE_CMD="$DRIFT_PROBE" \
run 3 "--json carries the dead verdict" '"verdict":"ALARM-dead"' check --json

MODEL_SURFACE_SOURCE_CMD="$DRIFT_SRC" MODEL_PROBE_CMD="$DRIFT_PROBE" \
run 3 "--json carries the healthy id alongside it" '"verdict":"ok"' check --json

MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$BARE")" \
MODEL_PROBE_CMD="$(probe_table "$BARE=200:ok@$OTHER_LANE")" \
run 3 "--json distinguishes unpinned from dead" '"verdict":"ALARM-unpinned"' check --json

# The JSON must carry the MEASUREMENT, not just the verdict. An alerting
# pipeline that cannot see which lane was reached cannot tell a real misroute
# from a monitor bug — which is the whole of TOG-985.
MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$BARE")" \
MODEL_PROBE_CMD="$(probe_table "$BARE=200:ok@$OTHER_LANE")" \
run 3 "--json carries the lane that served it" "\"servedBy\":\"$OTHER_LANE\"" check --json

MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$BARE")" \
MODEL_PROBE_CMD="$(probe_table "$BARE=200:ok@$OTHER_LANE")" \
run 3 "--json carries the lane it was compared against" \
  "\"pinnedLane\":\"$PINNED_LANE\"" check --json

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
sect "7. the REAL request — budget, and the header that identifies the lane"
# ===========================================================================
# WHAT BROKE (TOG-981). The probe asked for `max_tokens: 1`, reasoning as if the
# cheapest possible request were the safest one. On a REASONING model that
# budget is consumed before the first output token exists, so the gateway
# returns an EMPTY upstream body and renders it as 502 bad_gateway. Measured
# 2026-09-05, 4 attempts per cell, on an entirely healthy id:
#
#     max_tokens=1     non-stream   0/4 200   <-- the old probe. FALSE ALARM-dead.
#     max_tokens=1024  non-stream   4/4 200
#
# TOG-981 ran the scheduled check and got ALARM on a fleet that was serving
# every request. That is the exact failure this whole family of tools exists to
# prevent, inverted: not a monitor that reads green while blind, but one that
# pages while the system is fine. Both destroy the signal.
#
# These cases pin the REAL curl path, which the MODEL_PROBE_CMD seam bypasses —
# so they assert on the request the tool would actually send, and on how it
# reads the response. A stub `curl` on PATH captures the body; no network is
# touched.
#
# `emit_marker` decides whether the stub stamps CLIProxy's trace header on its
# response, which is the tool's only evidence of WHICH lane answered.
budget_probe() {
  local capture="$1" emit_marker="${2:-1}" bindir
  bindir="$(mktemp -d "$WORK/bin.XXXXXXXX")"
  {
    echo '#!/usr/bin/env bash'
    # curl is invoked with --data-binary @- : the payload arrives on stdin.
    printf 'cat > %q\n' "$capture"
    echo 'printf "200"'
    # -o <file> is where the tool expects the body and -D <file> the headers.
    echo 'while [[ $# -gt 0 ]]; do'
    echo '  [[ "$1" == "-o" ]] && printf "{}" > "$2"'
    if [[ "$emit_marker" == "1" ]]; then
      echo '  [[ "$1" == "-D" ]] && printf "HTTP/1.1 200 OK\r\nX-Cpa-Trace-Id: 20260916-abc\r\n" > "$2"'
    else
      echo '  [[ "$1" == "-D" ]] && printf "HTTP/1.1 200 OK\r\n" > "$2"'
    fi
    echo '  shift'
    echo 'done'
    echo 'exit 0'
  } > "$bindir/curl"
  chmod +x "$bindir/curl"
  printf '%s' "$bindir"
}

CAP="$WORK/sent-default.json"
BIN="$(budget_probe "$CAP")"
MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$PINNED")" \
MODEL_PROBE_CMD="" \
ANTHROPIC_BASE_URL="$PINNED_LANE" ANTHROPIC_AUTH_TOKEN="t" \
PATH="$BIN:$PATH" "$TOOL" check >/dev/null 2>&1
sent_mt="$(sed -n 's/.*"max_tokens":\([0-9]*\).*/\1/p' "$CAP" 2>/dev/null)"
if [[ -n "$sent_mt" ]] && (( sent_mt >= 512 )); then
  ok "the real request carries a reasoning-safe max_tokens ($sent_mt)"
else
  bad "the real request sent max_tokens=${sent_mt:-<none>}, wanted >= 512 (a 1-token budget false-alarms on reasoning models)"
fi

# The budget must stay overridable, so an operator can re-measure the boundary
# without editing the tool — but the DEFAULT is the thing that ships.
CAP2="$WORK/sent-override.json"
BIN2="$(budget_probe "$CAP2")"
MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$PINNED")" \
MODEL_PROBE_CMD="" PROBE_MAX_TOKENS=777 \
ANTHROPIC_BASE_URL="$PINNED_LANE" ANTHROPIC_AUTH_TOKEN="t" \
PATH="$BIN2:$PATH" "$TOOL" check >/dev/null 2>&1
if grep -q '"max_tokens":777' "$CAP2" 2>/dev/null; then
  ok "PROBE_MAX_TOKENS overrides the default"
else
  bad "PROBE_MAX_TOKENS did not reach the request body"
fi

# THE REAL PATH MUST READ THE HEADER, NOT ASSUME IT. These two cases differ in
# exactly one byte of the stubbed response — whether CLIProxy's trace header is
# present — and they must produce different verdicts. If the tool ever reports
# the URL it dialled as the lane that served the request, both go green and
# GATE B becomes decoration.
CAP3="$WORK/sent-marker.json"
BIN3="$(budget_probe "$CAP3" 1)"
rc=0
MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$PINNED")" \
MODEL_PROBE_CMD="" \
ANTHROPIC_BASE_URL="$PINNED_LANE" ANTHROPIC_AUTH_TOKEN="t" \
PATH="$BIN3:$PATH" "$TOOL" check >/dev/null 2>&1 || rc=$?
if [[ "$rc" == "0" ]]; then
  ok "the real path clears a 200 that carries CLIProxy's trace header"
else
  bad "the real path exited $rc on a 200 carrying the trace header, wanted 0"
fi

CAP4="$WORK/sent-nomarker.json"
BIN4="$(budget_probe "$CAP4" 0)"
out4=""; rc=0
out4="$(MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$PINNED")" \
  MODEL_PROBE_CMD="" \
  ANTHROPIC_BASE_URL="$PINNED_LANE" ANTHROPIC_AUTH_TOKEN="t" \
  PATH="$BIN4:$PATH" "$TOOL" check 2>&1)" || rc=$?
if [[ "$rc" == "5" && "$out4" == *"was NOT identified"* ]]; then
  ok "the real path reports a 200 WITHOUT the trace header as unmeasured"
else
  bad "the real path exited $rc on a 200 with no trace header, wanted 5 (unmeasured)"
fi

# THE BUDGET MUST NOT BUY SILENCE. A larger max_tokens changes only how much
# room a healthy model has to answer; it must not soften any verdict. A 400 on
# a bad id is decided at model RESOLUTION, before generation, so it still fires.
MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$UNDATED")" \
MODEL_PROBE_CMD="$(probe_table "$UNDATED=400:{\"error\":{\"message\":\"unknown provider for model claude-haiku-4-5\"}}")" \
run 3 "a resolution-time 400 still alarms at the larger budget" "ALARM-dead" check

MODEL_SURFACE_SOURCE_CMD="$(surfaces "a1	Agent One	$CH	$BARE")" \
MODEL_PROBE_CMD="$(probe_table "$BARE=200:ok@$OTHER_LANE")" \
run 3 "the off-lane fail-open still alarms at the larger budget" "ALARM-unpinned" check

# ===========================================================================
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
(( FAIL == 0 )) || exit 1
