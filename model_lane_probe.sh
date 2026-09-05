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
# THE CENTRAL RULE: HTTP 200 IS NOT THE QUESTION. THE BILLING LEG IS.
#
# What must be true is that the request lands on the owner's SUBSCRIPTION
# connection and cannot land anywhere else. That is a fact about routing, and
# the only honest way to hold it is to MEASURE THE ROUTE.
#
# ---------------------------------------------------------------------------
# WHY THIS FILE NO LONGER TESTS FOR A `cliproxy/` PREFIX. (TOG-985.)
#
# It used to. Until 2026-09-05 the pin gate was `[[ $model == cliproxy/* ]]`,
# on the stated premise that "a BARE id fails OPEN onto a pay-as-you-go leg".
# THAT PREMISE WAS WRONG ON THIS GATEWAY, and the gate built on it fired a
# fleet-wide ALARM (TOG-985) against 24 agents carrying the ids the OWNER had
# chosen the same evening. A monitor that pages on the owner's own correct
# configuration is worse than no monitor: it is the signal-destroying kind.
#
# The correction, from the operator and then re-measured here independently on
# 2026-09-05: on this OmniRoute the bare ids are COMBOS, not unrouted strings.
#
#     GET /v1/combos  ->  claude-sonnet-5   strategy=priority, exactly ONE leg
#                         claude-opus-5     strategy=priority, exactly ONE leg
#     both legs: providerId openai-compatible-chat-1628780c-…  (= cliproxy-main,
#     the owner's subscription connection)
#
# And per-request, from the response headers of a live call:
#
#     model=claude-sonnet-5           -> x-omniroute-decision: strategy=priority;
#                                        provider=openai-compatible-chat-1628780c-…
#     model=cliproxy/claude-sonnet-5  -> x-omniroute-decision: strategy=single;
#                                        provider=openai-compatible-chat-1628780c-…
#
# SAME CONNECTION. The prefixed form resolves directly; the bare form resolves
# through a one-leg combo. Neither touches OpenRouter. There is no PAYG leg in
# either. The prefix was never the property that mattered — it only correlated
# with it on the day it was written.
#
# The property that DOES matter is now checked directly, and in two places:
#
#   GATE A — THE LEG SET (configuration, no inference request).
#     If the id names a combo, EVERY leg of that combo must sit on the pinned
#     connection. A one-leg cliproxy combo is PINNED. A combo with a second,
#     openrouter leg is a genuine fail-open — it bills the subscription today
#     and a PAYG account the first time the first leg errors — and no
#     single request would ever reveal it. This is the gate the prefix test was
#     reaching for, and it is strictly stronger: `hindsight/retain` is bare AND
#     off-subscription (providerId=openrouter, measured cost 0.0000130000), and
#     it is caught here while the prefix test would have caught it for the
#     wrong reason and cleared `claude-sonnet-5` for the wrong reason too.
#
#   GATE B — THE RESOLVED PROVIDER (measured, one request).
#     The gateway reports where the request actually went, in
#     `x-omniroute-provider`. It must be the pinned connection. This catches a
#     leg set that changed under us since the combo read, a prefixed id whose
#     catalogue entry was repointed, and any route we have not thought of.
#
# Prefixing is therefore NOT a fix and this tool must never again recommend one.
# `cliproxy/` is a provider NAMESPACE, not a string decoration: prefixing an id
# from another namespace produces an id nothing serves —
# `cliproxy/opencode-go/deepseek-v4-pro` -> 400 model_not_found, measured
# 2026-09-03. Whether to prefer the prefixed form over the bare combo is a real
# question (the prefixed form fails CLOSED if the combo is ever deleted) but it
# is a question for the OWNER, who chooses the fleet's model ids. It is not a
# defect for this probe to page on.
#
# STILL TRUE, AND STILL CHECKED, is the third trap: reasoning effort belongs in
# the request's `effort` field, never glued onto the model string. A caller who
# "fixes" a lane by suffixing the id turns a working lane into a 400 —
# `cliproxy/claude-haiku-4-5-20251001-low` -> 400, measured. That is GATE C, the
# plain liveness check, and it is unchanged.
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
#   0  ok       — every referenced id resolves onto the pinned connection AND answers 200
#   2  REFUSED  — bad usage or bad input
#   3  ALARM    — an id is dead (non-200) or UNPINNED (routes off the pinned connection)
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
#   MODEL_PROBE_CMD           argv: <modelId>; stdout: "<httpCode>\t<body>\t<resolvedProvider>"
#   COMBO_SOURCE_CMD          stdout: comboName\tlegProviderId  (one line per leg)
#
# Absent, all three default to the real thing: pg_source.js and curl.
#
# MODEL_PROBE_CMD GREW A THIRD FIELD (TOG-985) and old two-field stubs still
# work: an absent third field is read as "the route was not reported", which is
# UNMEASURED rather than pinned. A seam that silently scored a missing
# measurement as a pass would reintroduce the exact bug this rewrite removes.
MODEL_SURFACE_SOURCE_CMD="${MODEL_SURFACE_SOURCE_CMD:-}"
MODEL_PROBE_CMD="${MODEL_PROBE_CMD:-}"
COMBO_SOURCE_CMD="${COMBO_SOURCE_CMD:-}"

# THE CONNECTION THE OWNER'S SUBSCRIPTION LIVES ON. This is the pin: an id is
# pinned if and only if it routes here, whatever its name looks like.
#
# It is an opaque OmniRoute connection id, `openai-compatible-chat-<uuid>`,
# which is the cliproxy-main connection (account `cliproxy-main`; see
# omniroute/TOG-352-register-cliproxy.sh, which registers it and documents that
# the generated id is `openai-compatible-chat-<uuid>`, NOT
# `openai-compatible-<prefix>`). Verified live 2026-09-05 against
# GET /v1/combos and the `x-omniroute-provider` response header.
#
# IT IS DELIBERATELY NOT DEFAULTED TO A PREFIX MATCH like `openai-compatible*`.
# Any future OpenAI-compatible connection — including a PAYG one — would match
# such a pattern, and the monitor would clear the very leg it exists to catch.
PINNED_CONNECTION_ID="${PINNED_CONNECTION_ID:-openai-compatible-chat-1628780c-65a8-4743-82b6-afaa483f06a2}"

# The floor for "we actually read something". Today the fleet is 47 agents x 3
# surfaces = 141. Pinned at 1 rather than 141 because this tool must stay
# correct for a company of any size — a caller who wants the real floor sets it.
MIN_SURFACES_EXPECTED="${MIN_SURFACES_EXPECTED:-1}"

# Per-request ceiling. The gateway is a proxy in front of a proxy; a hung leg
# must not hold the probe open past its schedule interval.
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
# Measured 2026-09-05 against the live gateway, 4 attempts per cell, on
# `cliproxy/claude-sonnet-5` — an id that is prefix-pinned and completely
# healthy:
#
#     max_tokens=1     non-stream   0/4 200   <-- the old probe. FALSE ALARM-dead.
#     max_tokens=1     stream       4/4 200
#     max_tokens=1024  non-stream   4/4 200   <-- this setting
#     max_tokens=1024  stream       4/4 200
#
# So the old value reported a healthy lane as DEAD on every reasoning model,
# and would have paged an operator for a gateway that was serving fine. The
# floor must sit above the reasoning preamble, not at 1.
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
# (2 ids today, not 72 — see "WHY IT PROBES DISTINCT IDS" above), which is the
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

"pinned" means the request RESOLVES onto the owner's subscription connection —
measured from the gateway's own x-omniroute-provider header and from the combo's
leg set. It is NOT a test for a `cliproxy/` prefix; a bare id that names a
single-leg combo on that connection is pinned, and prefixing an id is not a fix.
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

# --- the combo leg set (GATE A) ---------------------------------------------
# `comboName\tlegProviderId`, one line per leg. Read ONCE per run, from the same
# gateway the probe talks to, with the same agent token — no management
# credential and no database is needed for this.
#
# AN UNREADABLE COMBO LIST IS NOT AN EMPTY ONE. If this read fails, every bare
# id becomes "not a known combo", which would score as a route we cannot vouch
# for. That is handled at the call site as UNMEASURED, never as pinned and never
# as an alarm — the combo table being unreachable says nothing about the fleet.
COMBO_LEGS=""
COMBO_LEGS_READ=0     # 0 = not attempted, 1 = read ok, 2 = read failed
read_combo_legs() {
  (( COMBO_LEGS_READ != 0 )) && return 0
  local raw rc=0
  if [[ -n "$COMBO_SOURCE_CMD" ]]; then
    raw="$(eval "$COMBO_SOURCE_CMD" 2>/dev/null)" || rc=$?
  else
    if [[ -z "$ANTHROPIC_BASE_URL" ]]; then
      rc=1
    else
      local token="${ANTHROPIC_AUTH_TOKEN:-${ANTHROPIC_API_KEY:-}}"
      if [[ -z "$token" ]]; then
        rc=1
      else
        # Same /proc discipline as probe_model: the token goes in a 0600 config
        # file, never on argv.
        _ensure_rundir || return 1
        raw="$(curl -sS --max-time "$PROBE_MAX_TIME" --config "$RUNDIR/auth.conf" \
                 "${ANTHROPIC_BASE_URL%/}/v1/combos" 2>/dev/null \
               | python3 -c '
import json,sys
try:
    doc = json.load(sys.stdin)
except Exception:
    sys.exit(1)
data = doc.get("data")
if not isinstance(data, list):
    sys.exit(1)
for combo in data:
    name = combo.get("name")
    legs = combo.get("models")
    if not name or not isinstance(legs, list) or not legs:
        # A combo with no readable legs must not read as "no off-leg legs".
        print("%s\t(unreadable)" % (name or "(unnamed)"))
        continue
    for leg in legs:
        print("%s\t%s" % (name, leg.get("providerId") or "(none)"))
')" || rc=$?
      fi
    fi
  fi
  if (( rc != 0 )) || [[ -z "$raw" ]]; then
    COMBO_LEGS_READ=2
    return 0
  fi
  COMBO_LEGS="$raw"
  COMBO_LEGS_READ=1
  return 0
}

# Echoes one of: pinned | offleg:<providerId> | notcombo | unknown
combo_verdict_for() {
  local want="$1"
  read_combo_legs
  (( COMBO_LEGS_READ == 2 )) && { printf 'unknown'; return 0; }
  local name provider found=0 bad=""
  while IFS=$'\t' read -r name provider; do
    [[ "$name" == "$want" ]] || continue
    found=1
    [[ "$provider" == "$PINNED_CONNECTION_ID" ]] || bad="$provider"
  done <<< "$COMBO_LEGS"
  if (( found == 0 )); then printf 'notcombo'; return 0; fi
  if [[ -n "$bad" ]]; then printf 'offleg:%s' "$bad"; return 0; fi
  printf 'pinned'
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
        "${ANTHROPIC_BASE_URL%/}/v1/messages" 2>/dev/null)"
  # A code of 000 means no response completed. There is by definition no body,
  # and printing the stale file as one is how TOG-485 reported four failures
  # that never happened. Same for the route: no response means no route was
  # reported, and an empty third field is UNMEASURED downstream, not pinned.
  if [[ "$code" == "000" || -z "$code" ]]; then
    printf '000\t(no response completed)\t\n'
    return 0
  fi
  # GATE B's measurement. `x-omniroute-provider` is the connection the gateway
  # actually dispatched to — the single most load-bearing value in this file,
  # because it is the billing leg stated by the thing that did the billing
  # rather than inferred from the id's spelling.
  local resolved
  resolved="$(tr -d '\r' < "$hdrs" \
              | sed -n 's/^[Xx]-[Oo]mniroute-[Pp]rovider:[[:space:]]*//p' \
              | tail -n1)"
  printf '%s\t%s\t%s\n' "$code" "$(tr -d '\n\r\t' < "$body" | cut -c1-200)" "$resolved"
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
  local model out code body resolved verdict reason legs

  if [[ -n "$SURFACE_FILTER" ]]; then
    echo "SCOPE: only surfaces containing \"$SURFACE_FILTER\". Other surfaces were NOT probed." >&2
  fi

  while IFS= read -r model; do
    [[ -z "$model" ]] && continue
    checked=$((checked + 1))

    # GATE A — the leg set. Configuration only, no inference request, so it is
    # answerable even when the gateway will not serve. A combo whose legs are
    # not ALL on the pinned connection is the real fail-open.
    legs="$(combo_verdict_for "$model")"

    # GATES B and C — where the request actually went, and whether it answered.
    local prc=0
    out="$(probe_model "$model" 2>/dev/null)" || prc=$?
    if (( prc != 0 )); then
      code=""; body="probe command exited $prc"; resolved=""
    else
      # Three tab-separated fields. A two-field stub (the pre-TOG-985 seam
      # shape) leaves `resolved` empty, which is unmeasured — never pinned.
      code="${out%%$'\t'*}"
      local rest="${out#*$'\t'}"
      if [[ "$rest" == "$out" ]]; then
        body=""; resolved=""
      else
        body="${rest%%$'\t'*}"
        resolved="${rest#*$'\t'}"
        [[ "$resolved" == "$rest" ]] && resolved=""
      fi
    fi

    # A code of 000 is curl's "no response completed" — no request reached the
    # gateway at all. `is_int 000` is TRUE and `000 != 200` is TRUE, so the
    # obvious ordering reports an unreachable GATEWAY as a dead LANE and pages
    # the wrong on-call for an outage that may be the network in between. It is
    # unmeasured, and it is the one non-integer-shaped value that still parses
    # as an integer.
    local measured=1
    if ! is_int "$code" || [[ "$code" == "000" ]]; then measured=0; fi

    if [[ "$legs" == offleg:* ]]; then
      # GATE A, ranked above BOTH network gates for the same reason the prefix
      # gate used to be: it is a property of the configuration, fully measured
      # even when the gateway is unreachable. A combo with an off-connection leg
      # serves the subscription today and bills elsewhere the moment the first
      # leg errors — and NO single request would reveal it, because the request
      # that reveals it is the one that fails over.
      verdict="ALARM-unpinned"
      reason="combo '$model' has a leg on '${legs#offleg:}', not the pinned connection '$PINNED_CONNECTION_ID'. It fails OVER onto that leg, so it bills the wrong account on exactly the requests nobody is watching."
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
    elif [[ -z "$resolved" ]]; then
      # HTTP 200 but the gateway did not say where it went. The lane is alive
      # and the BILLING LEG IS UNVERIFIED, which is the whole question — so this
      # is unmeasured, not ok. Scoring it green here is precisely how a
      # status-only monitor stays green through a fail-open.
      verdict="unmeasured"
      reason="HTTP 200 but no x-omniroute-provider header, so the billing leg was NOT verified. Alive is not the same as pinned."
      unmeasured=$((unmeasured + 1))
    elif [[ "$resolved" != "$PINNED_CONNECTION_ID" ]]; then
      # GATE B. The gateway itself says the request went somewhere else.
      verdict="ALARM-unpinned"
      reason="HTTP 200 but the gateway resolved it onto '$resolved', not the pinned connection '$PINNED_CONNECTION_ID'. Live, and billed to the wrong account."
      alarms=$((alarms + 1))
    elif [[ "$legs" == "unknown" ]]; then
      # The route was measured and is correct, but the combo table could not be
      # read, so a second failover leg cannot be ruled out. Half-measured.
      verdict="unmeasured"
      reason="HTTP 200 and resolved onto the pinned connection, but the combo list could not be read, so a dormant failover leg could not be ruled out."
      unmeasured=$((unmeasured + 1))
    else
      verdict="ok"
      # Say WHICH of the two shapes cleared it. "pinned" and "notcombo" are both
      # fine and they are fine for different reasons; collapsing them is how the
      # last reader concluded the prefix was the property that mattered.
      if [[ "$legs" == "pinned" ]]; then
        reason="HTTP 200, resolved onto the pinned connection; combo with every leg on it"
      else
        reason="HTTP 200, resolved onto the pinned connection; direct id, not a combo"
      fi
    fi

    if (( AS_JSON == 1 )); then
      printf '{"model":%s,"verdict":%s,"httpCode":%s,"resolvedProvider":%s,"pinnedConnection":%s,"comboLegs":%s,"reason":%s,"referencedBy":%d}\n' \
        "$(json_str "$model")" "$(json_str "$verdict")" "$(json_str "${code:-}")" \
        "$(json_str "${resolved:-}")" "$(json_str "$PINNED_CONNECTION_ID")" \
        "$(json_str "$legs")" \
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
