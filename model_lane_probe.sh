#!/usr/bin/env bash
# ===========================================================================
# model_lane_probe.sh — say out loud when the cheap/small-fast lane has gone
# dead, or has quietly come UNPINNED. (TOG-682.)
# ---------------------------------------------------------------------------
# THE GAP THIS EXISTS FOR.
# TOG-679 was a dead cheap lane across all 47 agents. It was found BY HAND,
# about a day late, and by the time anyone executed the probe the upstream 503
# had already self-resolved — so the evidence of the outage was gone and a dead
# lane was indistinguishable from a recovered one. Nothing on this instance
# watched the lane then and nothing watched it after: a regex sweep of all 676
# board issues for `cheap.?lane|small_fast|DEFAULT_HAIKU|cliproxy/claude-haiku`
# matched only TOG-679, TOG-680 and TOG-615 (all done) and TOG-681, which
# explicitly DISCLAIMS this defect class in its own description. There was no
# open ticket anywhere that probed it.
#
# The cheap profile is also the RECOVERY profile. A dead value does not just
# make cheap work fail; it blocks status-recovery itself, which is the path that
# would otherwise notice.
#
# ---------------------------------------------------------------------------
# THE LANE THIS WATCHES IS THE DIRECT CLIPROXY ENDPOINT, AND ONLY THAT.
# (TOG-2927, 2026-09-16.)
#
# Until 2026-09-13 the fleet reached models through OmniRoute, and this file was
# built around that gateway's routing: a combo leg set from `GET /v1/combos` and
# an `x-omniroute-provider` response header, used together to prove a request
# landed on the owner's SUBSCRIPTION connection and could not fail over onto a
# pay-as-you-go one.
#
# THE OWNER RETIRED THAT LANE. Owner rule 2026-09-13: everything except
# Hindsight goes direct to CLIProxy, and the cutover completed 2026-09-16 07:36Z
# (TOG-2880). Every agent in this company now runs with
# `ANTHROPIC_BASE_URL=http://cliproxy:8317` — measured in-run 2026-09-16 — and no
# fleet traffic transits OmniRoute.
#
# So the OmniRoute gates were not merely unused, they were UNANSWERABLE: the
# direct endpoint serves neither `/v1/combos` nor `x-omniroute-provider`, and the
# probe returned exit 5 UNKNOWN against a completely healthy lane, run after run
# (TOG-2927, 2026-09-16 12:26Z — 77 surface rows, 2 ids, 0 alarms, 2 unmeasured;
# both ids in fact answering 200). An UNKNOWN that nobody can ever clear is a
# monitor being retired by attrition: it teaches its readers to skip it, which
# destroys the signal exactly as thoroughly as a false page does.
#
# DO NOT RESTORE THE COMBO / PROVIDER GATES without first re-measuring that fleet
# traffic transits OmniRoute again. Binding an OmniRoute credential so the old
# gates could answer was proposed and REJECTED (TOG-2936; TOG-2933 cancelled) —
# it would have measured, carefully, a lane nothing routes through.
#
# ---------------------------------------------------------------------------
# WHAT "PINNED" MEANS ON A DIRECT LANE — AND WHY IT IS STILL MEASURED.
#
# The old question, "which of this gateway's connections got billed?", was a
# question about FAN-OUT. A direct endpoint has none: no combo, no failover leg,
# no second provider to fail open onto. That removes GATE A's dormant-leg case
# as a fact about the world, not as an oversight.
#
# What it does NOT remove is the rule the whole file is built on: HTTP 200 IS NOT
# THE QUESTION. A probe that only asks "did something answer 200?" is precisely
# the status-only monitor the rest of this file argues against. On a direct lane
# the question becomes WHICH LANE ANSWERED, and it is measured, in two places:
#
#   GATE A — THE ENDPOINT PIN (configuration, no inference request).
#     The base URL this probe will call must BE the fleet's lane,
#     PINNED_LANE_ENDPOINT. A fleet quietly re-pointed at another endpoint —
#     a second proxy, a PAYG-capable gateway, a stale host — would otherwise
#     produce a green run against a lane nobody uses. Like the leg-set gate it
#     replaces, it is a property of the CONFIGURATION, so it is answerable even
#     when the gateway will not serve, and it therefore ranks above both network
#     gates.
#
#   GATE B — THE SERVING LANE (measured, one request).
#     CLIProxy stamps every response with its own trace header,
#     `X-Cpa-Trace-Id` — measured live 2026-09-16 against http://cliproxy:8317,
#     and advertised by that endpoint's own `Access-Control-Expose-Headers`
#     alongside the rest of the `X-CPA-*` (CLIProxyAPI) namespace. A 200 that
#     carries it was served BY CLIProxy. A 200 WITHOUT it was served by
#     something else answering at this address, and that is `unmeasured` —
#     alive is not the same as on the pinned lane — for exactly the reason a 200
#     with no `x-omniroute-provider` used to be.
#
#   GATE C — LIVENESS (the HTTP status). Unchanged.
#
# ---------------------------------------------------------------------------
# TWO RULES CARRIED OVER FROM THE OMNIROUTE ERA, BECAUSE THEY ARE STILL TRUE.
#
# 1. THE PREFIX IS NOT THE PIN, AND PREFIXING IS NOT A FIX. (TOG-985.) Until
#    2026-09-05 the pin gate here was `[[ $model == cliproxy/* ]]`, on the stated
#    premise that a BARE id fails open onto a pay-as-you-go leg. That premise was
#    wrong, and the gate built on it fired a fleet-wide ALARM against 24 agents
#    carrying the ids the OWNER had chosen the same evening. A monitor that pages
#    on the owner's own correct configuration is worse than no monitor. Decide by
#    MEASUREMENT, never by the spelling of an id — and never "fix" a lane by
#    decorating its id: `cliproxy/` is a provider NAMESPACE, so a wrong pairing
#    produces an id nothing serves (`cliproxy/opencode-go/deepseek-v4-pro` -> 400
#    model_not_found, measured 2026-09-03). Which spelling the fleet should carry
#    is a question for the OWNER, who chooses the fleet's model ids. It is not a
#    defect for this probe to page on.
#
# 2. REASONING EFFORT BELONGS IN THE REQUEST'S `effort` FIELD, NEVER GLUED ONTO
#    THE MODEL STRING. A caller who "fixes" a lane by suffixing the id turns a
#    working lane into a 400 — `cliproxy/claude-haiku-4-5-20251001-low` -> 400,
#    measured. That lands on GATE C, and it is unchanged.
#
# A BOUNDARY WORTH KNOWING BEFORE READING AN ALARM: Hindsight is the one service
# the owner exempted from the direct-CLIProxy rule. A Hindsight id is therefore
# not servable here and would read as ALARM-dead — correctly, because this probe
# reads the fleet's CHEAP/SMALL-FAST surfaces, and a lane that CLIProxy cannot
# serve does not belong on one.
#
# ---------------------------------------------------------------------------
# WHY IT READS TWO SURFACES AND REPORTS THEM SEPARATELY.
#
# A cheap-lane id lives in two places that drift independently:
#
#   adapterConfig.env.ANTHROPIC_SMALL_FAST_MODEL      console-only, 403 to agents
#   adapterConfig.env.ANTHROPIC_DEFAULT_HAIKU_MODEL   console-only, 403 to agents
#   runtimeConfig.modelProfiles.cheap                 agent-writable
#
# Fixing one leaves the other dead. That is not hypothetical — it is exactly how
# TOG-679 and TOG-680 came to disagree about whether the lane was fixed. So the
# probe never collapses the surfaces: every finding names the surface it came
# from, and a `--surface` filter exists to prove ONE of them without pretending
# the others were measured.
#
# ---------------------------------------------------------------------------
# WHY A ROW COUNT OF ZERO IS EXIT 5 AND NOT EXIT 0.
#
# "No id is broken" and "no id was read" are the same output if you only count
# failures. The source here is a database read that can fail for a dozen
# ordinary reasons (no DATABASE_URL in this container, no `pg` module, a company
# filter that matched nothing), and every one of them yields zero rows. Zero
# rows scored as green is a monitor that reports a healthy fleet it never looked
# at — the single failure mode this whole family of tools exists to end. So an
# empty read is UNKNOWN, loudly, and MIN_SURFACES_EXPECTED lets a caller pin the
# floor it expects rather than trusting whatever arrived.
#
# ---------------------------------------------------------------------------
# WHY IT PROBES DISTINCT IDS, NOT AGENTS.
#
# 47 agents x 3 surfaces = 141 rows and, today, two distinct ids. Probing per row
# would fire 141 inference requests to learn one fact, against a lane whose quota
# this company has already drained once (TOG-477: an 89-minute drain became a
# 5.5-hour outage). The probe is per DISTINCT id, and the report maps each
# verdict back to every surface that referenced it — same coverage, 2 requests.
#
# ---------------------------------------------------------------------------
# EXIT CODES — distinct so a caller can tell them apart.
#   0  ok       — every referenced id is served by the pinned lane AND answers 200
#   2  REFUSED  — bad usage or bad input
#   3  ALARM    — an id is dead (non-200), or the lane is not the pinned one
#   5  UNKNOWN  — could not measure. NOT green.
# ===========================================================================
set -uo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# --- the seams --------------------------------------------------------------
# Same convention as ROSTER_SOURCE_CMD in quota_brake.sh and PACE_WINDOW_CMD in
# cold_start_detector.sh: both impure edges are injectable, which is what lets
# the suite run in CI with no database and no gateway.
#
#   MODEL_SURFACE_SOURCE_CMD  stdout: agentId\tagentName\tsurface\tmodelId
#   MODEL_PROBE_CMD           argv: <modelId>; stdout: "<httpCode>\t<body>\t<servedByLane>"
#
# Absent, both default to the real thing: pg_source.js and curl.
#
# THE THIRD FIELD IS THE MEASUREMENT, and an old two-field stub still works: an
# absent third field is read as "the serving lane was not reported", which is
# UNMEASURED rather than pinned. A seam that silently scored a missing
# measurement as a pass would reintroduce the exact bug TOG-985 cost a fleet-wide
# false alarm to remove. (Before 2026-09-16 that field carried an OmniRoute
# connection id; it now carries the endpoint that served the request. Same
# contract, same failure-closed reading of an empty value.)
MODEL_SURFACE_SOURCE_CMD="${MODEL_SURFACE_SOURCE_CMD:-}"
MODEL_PROBE_CMD="${MODEL_PROBE_CMD:-}"

# THE LANE THE FLEET RUNS ON. This is the pin: an id is pinned if and only if the
# request is served here.
#
# It is the direct CLIProxy endpoint every agent in this company carries as
# ANTHROPIC_BASE_URL (measured in-run 2026-09-16), after the 2026-09-13 owner
# rule and the 2026-09-16 07:36Z cutover (TOG-2880) took OmniRoute out of the
# path for everything except Hindsight.
#
# IT IS DELIBERATELY AN EXACT URL AND NOT A PATTERN like `http://cliproxy:*`.
# Any future endpoint on that host — including one that fans out to a PAYG
# provider — would match such a pattern, and the monitor would clear the very
# drift it exists to catch.
PINNED_LANE_ENDPOINT="${PINNED_LANE_ENDPOINT:-http://cliproxy:8317}"
PINNED_LANE_ENDPOINT="${PINNED_LANE_ENDPOINT%/}"

# GATE B's marker. CLIProxy stamps its own trace id on every response; a 200
# without it was served by something that is not CLIProxy, whatever address it
# answered at. Overridable by NAME so a CLIProxy release that renames the header
# is a one-variable fix rather than a silent stream of UNKNOWNs — but it is never
# defaulted to empty, because an empty marker would clear every 200 that reached
# anything at all.
LANE_IDENTITY_HEADER="${LANE_IDENTITY_HEADER:-x-cpa-trace-id}"

# The floor for "we actually read something". Today the fleet is 26 agents and 77
# surface rows. Pinned at 1 rather than 77 because this tool must stay correct
# for a company of any size — a caller who wants the real floor sets it.
MIN_SURFACES_EXPECTED="${MIN_SURFACES_EXPECTED:-1}"

# Per-request ceiling. A hung lane must not hold the probe open past its
# schedule interval.
PROBE_MAX_TIME="${PROBE_MAX_TIME:-60}"

# TOG-981. The liveness budget, and it is NOT a "how little can we ask for"
# knob — it is the difference between measuring the lane and measuring this
# probe. `max_tokens: 1` on a REASONING model buys a response whose entire
# budget is consumed before a single output token exists, and the gateway
# renders that as an empty upstream body:
#
#     {"code":"bad_gateway","message":"upstream returned an empty response
#      without usable output"}
#
# Measured 2026-09-05, 4 attempts per cell, on an id that was completely
# healthy:
#
#     max_tokens=1     non-stream   0/4 200   <-- the old probe. FALSE ALARM-dead.
#     max_tokens=1     stream       4/4 200
#     max_tokens=1024  non-stream   4/4 200   <-- this setting
#     max_tokens=1024  stream       4/4 200
#
# So the old value reported a healthy lane as DEAD on every reasoning model, and
# would have paged an operator for a lane that was serving fine. The floor must
# sit above the reasoning preamble, not at 1.
#
# THIS DOES NOT WEAKEN DETECTION. The gates that catch a genuinely bad id are
# resolution-time, not generation-time, so they fire before any token budget is
# touched — re-verified at this setting on 2026-09-05:
#
#     cliproxy/claude-haiku-4-5              -> 400 model_not_found (undated)
#     cliproxy/claude-haiku-4-5-20251001-low -> 400 model_not_found (suffix trap)
#     cliproxy/opencode-go/deepseek-v4-pro   -> 400 model_not_found (foreign ns)
#     cliproxy/totally-not-a-model           -> 400 model_not_found
#     cliproxy/claude-haiku-4-5-20251001     -> 200 (control, still passes)
#
# The cost of the larger budget is one short completion per DISTINCT id per run
# (2 ids today, not 77 — see "WHY IT PROBES DISTINCT IDS" above), which is the
# quota this monitor was always meant to spend.
PROBE_MAX_TOKENS="${PROBE_MAX_TOKENS:-1024}"

ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-}"

usage() {
  cat <<'EOF'
usage: model_lane_probe.sh <command> [options]

commands:
  surfaces   List every (agent, surface, model id) the fleet references. No network.
  check      Probe each distinct referenced id and report. Exit 3 on any alarm.

options:
  --surface SUBSTR   Only consider surfaces whose name contains SUBSTR.
                     The report says so, so a filtered run is never read as full coverage.
  --long             surfaces: one row per agent instead of per-surface counts.
  --json             check: emit the findings as JSONL on stdout instead of a table.
  -h, --help         This text.

exit: 0 ok · 2 refused · 3 ALARM (dead or unpinned) · 5 UNKNOWN (not measured)

"pinned" means the request is SERVED BY the fleet's own lane — the direct CLIProxy
endpoint — measured from the endpoint the probe calls and from CLIProxy's own trace
header on the response. It is NOT a test for a `cliproxy/` prefix; that string test
was wrong and cost a fleet-wide false alarm (TOG-985), and prefixing an id is not a fix.
OmniRoute's combo and provider gates were removed on 2026-09-16 because the owner
retired that lane (TOG-2880/TOG-2927), not because the routing question stopped mattering.
EOF
}

die()     { echo "REFUSED: $*" >&2; exit 2; }
unknown() { echo "UNKNOWN: $*" >&2; exit 5; }

# An absence assertion needs three outcomes, and bash makes the two-outcome
# version silently wrong: `[[ "" -eq 0 ]]` is TRUE and `(( "" > 0 ))` is FALSE,
# so an unread count scores as a clean fleet. Every count is validated here
# before it reaches a comparison.
is_int() { [[ "${1:-}" =~ ^-?[0-9]+$ ]]; }

# --- the source -------------------------------------------------------------
read_surfaces() {
  if [[ -n "$MODEL_SURFACE_SOURCE_CMD" ]]; then
    eval "$MODEL_SURFACE_SOURCE_CMD"
    return $?
  fi
  [[ -x "$HERE/pg_source.js" ]] || {
    echo "no MODEL_SURFACE_SOURCE_CMD and $HERE/pg_source.js is not executable" >&2
    return 1
  }
  "$HERE/pg_source.js" model-surfaces
}

# --- GATE A: the endpoint pin -----------------------------------------------
# Configuration, not network. Echoes the endpoint this run will actually call,
# or the empty string when the caller drives the probe through MODEL_PROBE_CMD
# and has declared no endpoint — in which case the seam's own third field is the
# only lane evidence there is, and GATE B carries the whole weight.
lane_endpoint() { printf '%s' "${ANTHROPIC_BASE_URL%/}"; }

# --- the probe --------------------------------------------------------------
#
# THE CREDENTIAL NEVER REACHES argv. /proc exposes every process's cmdline on
# this host, and TOG-485 already had to learn this: the token goes into a 0600
# curl config file in a per-run scratch dir, and curl is handed only the path.
# The same reasoning applies to the fixed-path trap that file documents — a
# response written to a shared /tmp name outlives the run and the NEXT run reads
# it as its own answer. One mktemp -d per run, trapped clean.
RUNDIR=""
_ensure_rundir() {
  [[ -n "$RUNDIR" ]] && return 0
  local token="${ANTHROPIC_AUTH_TOKEN:-${ANTHROPIC_API_KEY:-}}"
  [[ -n "$token" ]] || {
    echo "neither ANTHROPIC_AUTH_TOKEN nor ANTHROPIC_API_KEY is set" >&2
    return 1
  }
  RUNDIR="$(umask 077; mktemp -d "${PAPERCLIP_RUN_SCRATCH_DIR:-${TMPDIR:-/tmp}}/model-lane.XXXXXXXX")" || {
    echo "could not create a private scratch dir" >&2; RUNDIR=""; return 1; }
  trap 'rm -rf "$RUNDIR"' EXIT
  umask 077
  {
    printf 'header = "authorization: Bearer %s"\n' "$token"
    printf 'header = "anthropic-version: 2023-06-01"\n'
    printf 'header = "content-type: application/json"\n'
  } > "$RUNDIR/auth.conf" || { echo "could not write curl auth config" >&2; return 1; }
  chmod 0600 "$RUNDIR/auth.conf"
  return 0
}

probe_model() {
  local model="$1"
  if [[ -n "$MODEL_PROBE_CMD" ]]; then
    eval "$MODEL_PROBE_CMD \"\$model\""
    return $?
  fi

  [[ -n "$ANTHROPIC_BASE_URL" ]] || {
    echo "ANTHROPIC_BASE_URL is not set" >&2
    return 1
  }
  local token="${ANTHROPIC_AUTH_TOKEN:-${ANTHROPIC_API_KEY:-}}"
  [[ -n "$token" ]] || {
    echo "neither ANTHROPIC_AUTH_TOKEN nor ANTHROPIC_API_KEY is set" >&2
    return 1
  }

  _ensure_rundir || return 1

  local base="${ANTHROPIC_BASE_URL%/}"
  local body="$RUNDIR/resp.body" hdrs="$RUNDIR/resp.hdrs" code
  : > "$body"; : > "$hdrs"
  # This asks the lane "are you there", not for content — but it must ask with
  # enough budget that a reasoning model can reach its first output token, or
  # the empty-body 502 that follows is this probe's own artifact rather than a
  # fact about the lane. See PROBE_MAX_TOKENS above for the measurement. The
  # payload goes over stdin, not argv, for the same /proc reason as the token.
  code="$(printf '%s' \
      "{\"model\":$(json_str "$model"),\"max_tokens\":${PROBE_MAX_TOKENS},\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" \
    | curl -sS -X POST --max-time "$PROBE_MAX_TIME" \
        --config "$RUNDIR/auth.conf" \
        --data-binary @- \
        -D "$hdrs" \
        -o "$body" -w '%{http_code}' \
        "$base/v1/messages" 2>/dev/null)"
  # A code of 000 means no response completed. There is by definition no body,
  # and printing the stale file as one is how TOG-485 reported four failures
  # that never happened. Same for the lane: no response means nothing served it,
  # and an empty third field is UNMEASURED downstream, not pinned.
  if [[ "$code" == "000" || -z "$code" ]]; then
    printf '000\t(no response completed)\t\n'
    return 0
  fi
  # GATE B's measurement. The serving lane is reported as the endpoint that
  # answered — and it is reported ONLY when CLIProxy's own trace header is on
  # the response. Without that header something else answered at this address,
  # and echoing the URL we dialled would be asserting the very thing the gate
  # exists to check.
  local marker served=""
  marker="$(tr -d '\r' < "$hdrs" \
            | sed -n "s/^[[:space:]]*$(printf '%s' "$LANE_IDENTITY_HEADER" | tr 'A-Z' 'a-z')[[:space:]]*:[[:space:]]*//Ip" \
            | tail -n1)"
  [[ -n "$marker" ]] && served="$base"
  printf '%s\t%s\t%s\n' "$code" "$(tr -d '\n\r\t' < "$body" | cut -c1-200)" "$served"
}

json_str() {
  # Quote a string for JSON without assuming jq is present on the probe path.
  local s="${1//\\/\\\\}"; s="${s//\"/\\\"}"
  printf '"%s"' "$s"
}

# --- surface collection -----------------------------------------------------
SURFACE_FILTER=""
AS_JSON=0

# Populated by collect(): parallel arrays, one entry per surface row.
declare -a S_AGENT=() S_NAME=() S_SURFACE=() S_MODEL=()

collect() {
  local raw rc=0
  raw="$(read_surfaces 2>/dev/null)" || rc=$?
  if (( rc != 0 )); then
    unknown "could not read the model surfaces (source exited $rc). Nothing was probed; this is not a clean lane."
  fi

  local agent name surface model kept=0 seen=0
  while IFS=$'\t' read -r agent name surface model; do
    # A wholly blank line is padding, not a row. A row missing FIELDS is
    # corruption and must not be silently treated as an absent model id.
    [[ -z "$agent$name$surface$model" ]] && continue
    seen=$((seen + 1))
    if [[ -z "$surface" || -z "$model" ]]; then
      unknown "surface row $seen is malformed (surface='$surface' model='$model'). A short row means the columns shifted; refusing to score a fleet from it."
    fi
    if [[ -n "$SURFACE_FILTER" && "$surface" != *"$SURFACE_FILTER"* ]]; then
      continue
    fi
    S_AGENT+=("$agent"); S_NAME+=("$name")
    S_SURFACE+=("$surface"); S_MODEL+=("$model")
    kept=$((kept + 1))
  done <<< "$raw"

  is_int "$MIN_SURFACES_EXPECTED" || die "MIN_SURFACES_EXPECTED must be an integer, got '$MIN_SURFACES_EXPECTED'"

  if (( seen == 0 )); then
    unknown "the source returned no surface rows at all. Zero rows is 'never looked', not 'nothing broken'."
  fi
  if [[ -n "$SURFACE_FILTER" ]] && (( kept == 0 )); then
    die "--surface '$SURFACE_FILTER' matched none of the $seen rows read. Refusing to report a fleet nobody measured."
  fi
  if (( kept < MIN_SURFACES_EXPECTED )); then
    unknown "read $kept surface rows, expected at least $MIN_SURFACES_EXPECTED. A short read is not a clean fleet."
  fi
}

distinct_models() {
  local i
  for i in "${!S_MODEL[@]}"; do printf '%s\n' "${S_MODEL[$i]}"; done | sort -u
}

# Every surface that referenced a given id, as "name [surface]" lines.
refs_for() {
  local want="$1" i
  for i in "${!S_MODEL[@]}"; do
    [[ "${S_MODEL[$i]}" == "$want" ]] && printf '%s [%s]\n' "${S_NAME[$i]}" "${S_SURFACE[$i]}"
  done
}

# The blast radius of one id, as "<count> <surface>" lines.
#
# WHY THE HEALTHY PATH NEVER ENUMERATES AGENTS. 47 agents x 3 surfaces is 141
# lines for a fleet that is entirely fine, printed on every scheduled run. A
# monitor whose quiet output is 141 lines is a monitor nobody reads, and an
# alarm buried in it is an alarm nobody sees. Per surface it is three lines.
surface_counts_for() {
  local want="$1" i
  for i in "${!S_MODEL[@]}"; do
    [[ "${S_MODEL[$i]}" == "$want" ]] && printf '%s\n' "${S_SURFACE[$i]}"
  done | sort | uniq -c | awk '{printf "%s agent(s) on %s\n", $1, $2}'
}

# On an ALARM the agent names DO matter — that is the fix list. It is capped,
# and a truncated list says so: a silently-cut list reads as full coverage.
ALARM_NAME_CAP="${ALARM_NAME_CAP:-12}"
alarm_names_for() {
  local want="$1" total
  total="$(refs_for "$want" | wc -l)"
  refs_for "$want" | sort | head -n "$ALARM_NAME_CAP"
  if (( total > ALARM_NAME_CAP )); then
    printf '... and %d more (WITHHELD by ALARM_NAME_CAP=%d, not the end of the list)\n' \
      "$(( total - ALARM_NAME_CAP ))" "$ALARM_NAME_CAP"
  fi
}

# --- commands ---------------------------------------------------------------
# `surfaces` is the inventory, not the monitor: --long is where the per-agent
# rows live, because that is the shape you want when you are chasing WHICH agent
# drifted, and it is exactly the shape you do not want on a schedule.
LONG=0
cmd_surfaces() {
  collect
  local i
  if (( LONG == 1 )); then
    printf 'agent\tsurface\tmodel\n'
    for i in "${!S_MODEL[@]}"; do
      printf '%s\t%s\t%s\n' "${S_NAME[$i]}" "${S_SURFACE[$i]}" "${S_MODEL[$i]}"
    done
  else
    printf 'count\tsurface\tmodel\n'
    for i in "${!S_MODEL[@]}"; do
      printf '%s\t%s\n' "${S_SURFACE[$i]}" "${S_MODEL[$i]}"
    done | sort | uniq -c | awk '{c=$1; $1=""; sub(/^ /,""); printf "%s\t%s\n", c, $0}'
  fi
  printf '\n%d surface rows, %d distinct model id(s).\n' \
    "${#S_MODEL[@]}" "$(distinct_models | wc -l)"
  [[ -n "$SURFACE_FILTER" ]] && printf 'FILTERED to surfaces containing "%s" — other surfaces were NOT read.\n' "$SURFACE_FILTER"
  return 0
}

cmd_check() {
  collect

  local alarms=0 checked=0 unmeasured=0
  local model out code body served verdict reason

  if [[ -n "$SURFACE_FILTER" ]]; then
    echo "SCOPE: only surfaces containing \"$SURFACE_FILTER\". Other surfaces were NOT probed." >&2
  fi

  # GATE A, evaluated once for the run: the endpoint this probe will call must
  # be the fleet's pinned lane. Empty means no endpoint was declared — the
  # caller is driving the probe through the seam — and an absent declaration is
  # not a mismatch.
  local endpoint offpin=0
  endpoint="$(lane_endpoint)"
  if [[ -n "$endpoint" && "$endpoint" != "$PINNED_LANE_ENDPOINT" ]]; then
    offpin=1
  fi

  while IFS= read -r model; do
    [[ -z "$model" ]] && continue
    checked=$((checked + 1))

    # GATES B and C — which lane served the request, and whether it answered.
    local prc=0
    out="$(probe_model "$model" 2>/dev/null)" || prc=$?
    if (( prc != 0 )); then
      code=""; body="probe command exited $prc"; served=""
    else
      # Three tab-separated fields. A two-field stub leaves `served` empty,
      # which is unmeasured — never pinned.
      code="${out%%$'\t'*}"
      local rest="${out#*$'\t'}"
      if [[ "$rest" == "$out" ]]; then
        body=""; served=""
      else
        body="${rest%%$'\t'*}"
        served="${rest#*$'\t'}"
        [[ "$served" == "$rest" ]] && served=""
      fi
    fi

    # A code of 000 is curl's "no response completed" — no request reached the
    # lane at all. `is_int 000` is TRUE and `000 != 200` is TRUE, so the
    # obvious ordering reports an unreachable ENDPOINT as a dead LANE and pages
    # the wrong on-call for an outage that may be the network in between. It is
    # unmeasured, and it is the one non-integer-shaped value that still parses
    # as an integer.
    local measured=1
    if ! is_int "$code" || [[ "$code" == "000" ]]; then measured=0; fi

    if (( offpin == 1 )); then
      # GATE A, ranked above BOTH network gates for the same reason the leg-set
      # gate used to be: it is a property of the configuration, fully measured
      # even when the endpoint is unreachable. A run against an endpoint that is
      # not the fleet's lane can only ever report on a lane nobody uses, and
      # reporting THAT as green is the failure this whole file exists to end.
      verdict="ALARM-unpinned"
      reason="this run probes '$endpoint', which is not the pinned lane '$PINNED_LANE_ENDPOINT'. Whatever it answers is a fact about some other endpoint, so it cannot clear the fleet's lane."
      alarms=$((alarms + 1))
    elif (( measured == 0 )); then
      # Could not tell. NOT a pass, and NOT an alarm either.
      verdict="unmeasured"
      reason="no HTTP status from the probe: ${body:-no detail}"
      unmeasured=$((unmeasured + 1))
    elif [[ "$code" != "200" ]]; then
      verdict="ALARM-dead"
      reason="HTTP $code: ${body:-no body}"
      alarms=$((alarms + 1))
    elif [[ -z "$served" ]]; then
      # HTTP 200 but nothing identified the lane that served it. The id is alive
      # and THE LANE IS UNVERIFIED, which is the whole question — so this is
      # unmeasured, not ok. Scoring it green here is precisely how a status-only
      # monitor stays green while pointed at the wrong thing.
      verdict="unmeasured"
      reason="HTTP 200 but no $LANE_IDENTITY_HEADER header, so the lane that served it was NOT identified. Alive is not the same as on the pinned lane."
      unmeasured=$((unmeasured + 1))
    elif [[ "${served%/}" != "$PINNED_LANE_ENDPOINT" ]]; then
      # GATE B. Something other than the fleet's lane answered.
      verdict="ALARM-unpinned"
      reason="HTTP 200 but it was served by '$served', not the pinned lane '$PINNED_LANE_ENDPOINT'. Live, on a lane the fleet does not route through."
      alarms=$((alarms + 1))
    else
      verdict="ok"
      reason="HTTP 200, served by the pinned lane $PINNED_LANE_ENDPOINT (identified by $LANE_IDENTITY_HEADER)"
    fi

    if (( AS_JSON == 1 )); then
      printf '{"model":%s,"verdict":%s,"httpCode":%s,"servedBy":%s,"pinnedLane":%s,"reason":%s,"referencedBy":%d}\n' \
        "$(json_str "$model")" "$(json_str "$verdict")" "$(json_str "${code:-}")" \
        "$(json_str "${served:-}")" "$(json_str "$PINNED_LANE_ENDPOINT")" \
        "$(json_str "$reason")" "$(refs_for "$model" | wc -l)"
    else
      printf '%-16s %s\n' "$verdict" "$model"
      printf '                 %s\n' "$reason"
      # Naming the surfaces is the point of the two-surface requirement: a
      # finding that cannot be traced back to a surface cannot be fixed on one.
      # Both surfaces are ALWAYS listed, healthy or not — that is the coverage
      # claim. Individual agent names are printed only on an alarm, where they
      # are the fix list rather than noise.
      surface_counts_for "$model" | sed 's/^/                 /'
      if [[ "$verdict" == ALARM-* ]]; then
        alarm_names_for "$model" | sed 's/^/                 -> /'
      fi
    fi
  done < <(distinct_models)

  if (( AS_JSON == 0 )); then
    printf '\n%d distinct id(s) across %d surface rows: %d alarm(s), %d unmeasured.\n' \
      "$checked" "${#S_MODEL[@]}" "$alarms" "$unmeasured"
  fi

  # Ordering matters. An alarm outranks an unmeasured id: a lane we KNOW is
  # dead is worth paging on even if a second one could not be reached.
  (( alarms > 0 )) && return 3
  if (( unmeasured > 0 )); then
    echo "UNKNOWN: $unmeasured id(s) could not be probed. Not green." >&2
    return 5
  fi
  return 0
}

# --- argv -------------------------------------------------------------------
CMD="${1:-}"
[[ $# -gt 0 ]] && shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --surface) SURFACE_FILTER="${2:?--surface needs a value}"; shift 2 ;;
    --json)    AS_JSON=1; shift ;;
    --long)    LONG=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

case "$CMD" in
  surfaces) cmd_surfaces ;;
  check)    cmd_check ;;
  -h|--help|"") usage; [[ -z "$CMD" ]] && exit 2 || exit 0 ;;
  *) die "unknown command: $CMD" ;;
esac
