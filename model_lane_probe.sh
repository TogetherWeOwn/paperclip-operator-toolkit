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
# THE CENTRAL RULE: HTTP 200 IS NOT THE QUESTION. THE PREFIX IS.
#
# This is the finding that shapes the whole file, and it is measured, not
# reasoned. Probed against the live gateway on 2026-08-30:
#
#     cliproxy/claude-haiku-4-5-20251001      -> 200
#     claude-haiku-4-5-20251001   (BARE)      -> 200      <-- both are 200
#     cliproxy/claude-haiku-4-5   (undated)   -> 400 unknown provider for model
#     cliproxy/claude-haiku-4-5-20251001-low  -> 400 unknown provider for model
#
# A BARE id answers 200. It fails OPEN onto a pay-as-you-go leg; the `cliproxy/`
# prefix fails CLOSED onto the owner's subscription. So an unpinned lane is
# fully healthy by every HTTP measure, spends real money on the wrong account,
# and is HARDER to notice than a dead one — a dead lane at least breaks. A probe
# that only asserted status would be green through exactly that failure.
#
# Hence two independent gates per id, and a `bare` verdict is an ALARM with the
# same exit code as a dead one. They are different failures with the same
# urgency.
#
# The `-low` line above is the third trap: reasoning effort belongs in the
# request's `effort` field, never glued onto the model string. A caller who
# "fixes" a lane by suffixing the id turns a working lane into a 400.
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
# 47 agents x 3 surfaces = 141 rows and, today, ONE distinct id. Probing per row
# would fire 141 inference requests to learn one fact, against a gateway whose
# quota this company has already drained once (TOG-477: an 89-minute drain became
# a 5.5-hour outage). The probe is per DISTINCT id, and the report maps each
# verdict back to every surface that referenced it — same coverage, 1 request.
#
# ---------------------------------------------------------------------------
# EXIT CODES — distinct so a caller can tell them apart.
#   0  ok       — every referenced id is prefix-pinned AND answers 200
#   2  REFUSED  — bad usage or bad input
#   3  ALARM    — an id is dead (non-200) or UNPINNED (no cliproxy/ prefix)
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
#   MODEL_PROBE_CMD           argv: <modelId>; stdout: "<httpCode>\t<body>"
#
# Absent, both default to the real thing: pg_source.js and curl.
MODEL_SURFACE_SOURCE_CMD="${MODEL_SURFACE_SOURCE_CMD:-}"
MODEL_PROBE_CMD="${MODEL_PROBE_CMD:-}"

# The prefix that pins a model onto the owner's subscription leg. A bare id
# answers 200 and bills elsewhere; see the central rule above.
REQUIRED_MODEL_PREFIX="${REQUIRED_MODEL_PREFIX:-cliproxy/}"

# The floor for "we actually read something". Today the fleet is 47 agents x 3
# surfaces = 141. Pinned at 1 rather than 141 because this tool must stay
# correct for a company of any size — a caller who wants the real floor sets it.
MIN_SURFACES_EXPECTED="${MIN_SURFACES_EXPECTED:-1}"

# Per-request ceiling. The gateway is a proxy in front of a proxy; a hung leg
# must not hold the probe open past its schedule interval.
PROBE_MAX_TIME="${PROBE_MAX_TIME:-60}"

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

# --- the probe --------------------------------------------------------------
#
# THE CREDENTIAL NEVER REACHES argv. /proc exposes every process's cmdline on
# this host, and TOG-485 already had to learn this: the token goes into a 0600
# curl config file in a per-run scratch dir, and curl is handed only the path.
# The same reasoning applies to the fixed-path trap that file documents — a
# response written to a shared /tmp name outlives the run and the NEXT run reads
# it as its own answer. One mktemp -d per run, trapped clean.
RUNDIR=""
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

  if [[ -z "$RUNDIR" ]]; then
    RUNDIR="$(umask 077; mktemp -d "${PAPERCLIP_RUN_SCRATCH_DIR:-${TMPDIR:-/tmp}}/model-lane.XXXXXXXX")" || {
      echo "could not create a private scratch dir" >&2; return 1; }
    trap 'rm -rf "$RUNDIR"' EXIT
    umask 077
    {
      printf 'header = "authorization: Bearer %s"\n' "$token"
      printf 'header = "anthropic-version: 2023-06-01"\n'
      printf 'header = "content-type: application/json"\n'
    } > "$RUNDIR/auth.conf" || { echo "could not write curl auth config" >&2; return 1; }
    chmod 0600 "$RUNDIR/auth.conf"
  fi

  local body="$RUNDIR/resp.body" code
  : > "$body"
  # max_tokens is 1: this asks the lane "are you there", not for content. The
  # payload goes over stdin, not argv, for the same /proc reason as the token.
  code="$(printf '%s' \
      "{\"model\":$(json_str "$model"),\"max_tokens\":1,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" \
    | curl -sS -X POST --max-time "$PROBE_MAX_TIME" \
        --config "$RUNDIR/auth.conf" \
        --data-binary @- \
        -o "$body" -w '%{http_code}' \
        "${ANTHROPIC_BASE_URL%/}/v1/messages" 2>/dev/null)"
  # A code of 000 means no response completed. There is by definition no body,
  # and printing the stale file as one is how TOG-485 reported four failures
  # that never happened.
  if [[ "$code" == "000" || -z "$code" ]]; then
    printf '000\t(no response completed)\n'
    return 0
  fi
  printf '%s\t%s\n' "$code" "$(tr -d '\n\r\t' < "$body" | cut -c1-200)"
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
  local model out code body verdict reason

  if [[ -n "$SURFACE_FILTER" ]]; then
    echo "SCOPE: only surfaces containing \"$SURFACE_FILTER\". Other surfaces were NOT probed." >&2
  fi

  while IFS= read -r model; do
    [[ -z "$model" ]] && continue
    checked=$((checked + 1))

    # GATE 1 — the prefix. Checked BEFORE the network, because it is the gate a
    # 200 cannot answer: a bare id is live, is billed to the wrong leg, and is
    # the harder of the two failures to see.
    local pinned=1
    [[ "$model" == "$REQUIRED_MODEL_PREFIX"* ]] || pinned=0

    # GATE 2 — the lane answers.
    local prc=0
    out="$(probe_model "$model" 2>/dev/null)" || prc=$?
    if (( prc != 0 )); then
      code=""; body="probe command exited $prc"
    else
      code="${out%%$'\t'*}"; body="${out#*$'\t'}"
      [[ "$body" == "$out" ]] && body=""
    fi

    # A code of 000 is curl's "no response completed" — no request reached the
    # gateway at all. `is_int 000` is TRUE and `000 != 200` is TRUE, so the
    # obvious ordering reports an unreachable GATEWAY as a dead LANE and pages
    # the wrong on-call for an outage that may be the network in between. It is
    # unmeasured, and it is the one non-integer-shaped value that still parses
    # as an integer.
    local measured=1
    if ! is_int "$code" || [[ "$code" == "000" ]]; then measured=0; fi

    if (( pinned == 0 )); then
      # Deliberately ranked above BOTH network gates. The prefix is a property
      # of the configured string, so it is fully measured even when the gateway
      # is unreachable — and a bare id answering 200 is the fail-open case that
      # must never be reported as healthy.
      verdict="ALARM-unpinned"
      reason="missing the '$REQUIRED_MODEL_PREFIX' prefix (HTTP ${code:-none}). A bare id answers 200 and fails OPEN onto a PAYG leg."
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
    else
      verdict="ok"
      reason="HTTP 200, prefix-pinned"
    fi

    if (( AS_JSON == 1 )); then
      printf '{"model":%s,"verdict":%s,"httpCode":%s,"reason":%s,"referencedBy":%d}\n' \
        "$(json_str "$model")" "$(json_str "$verdict")" "$(json_str "${code:-}")" \
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
