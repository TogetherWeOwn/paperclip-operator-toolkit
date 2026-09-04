#!/usr/bin/env bash
# ===========================================================================
# opencode_shared_budget_probe.sh — is the paid OpenCode budget SHARED across
# lanes, or throttled per lane? (TOG-894 ask 2.)
# ---------------------------------------------------------------------------
# THE QUESTION, AND WHY THE OBVIOUS PROBE CANNOT ANSWER IT.
#
# TOG-845 probed ONE opencode-go lane and watched `401 Missing API key` come
# and go on a credential that was demonstrably serving (6 consecutive failures,
# then 18 consecutive 200s from the same key over the next 255s). That is
# enough to prove the throttle is real and the string is a lie — which is
# TOG-894 ask 1, fixed in the platform classifier.
#
# It is NOT enough to answer ask 2. A single-lane trace cannot distinguish:
#
#   (a) a PER-LANE limit    — lane X throttles, lane Y is unaffected;
#   (b) a SHARED budget     — X and Y throttle together, drawing one pool.
#
# The two have opposite operational consequences, which is why the question is
# worth a tool rather than an opinion:
#
#   under (a)  a per-lane enable/disable flag is the correct control surface;
#   under (b)  that flag is actively HARMFUL — disabling a "broken" lane moves
#              the same demand onto a sibling drawing the same pool, and what
#              the fleet should observe is CAPACITY, not configuration.
#
# THE DISCRIMINATOR IS COINCIDENCE IN TIME, NOT FAILURE COUNT.
#
# So this samples several DISTINCT opencode-go model families in a tight round,
# over many rounds, and asks whether their failures land in the SAME rounds.
# A per-lane limit scatters failures across rounds; a shared pool clusters them.
# Counting total failures per lane — the intuitive thing — cannot separate the
# two hypotheses at all, because both produce failures on every lane eventually.
#
# Distinct FAMILIES, not aliases: two aliases of one model could share an
# upstream limit for reasons that say nothing about our budget.
#
# THE CONTROL IS CROSS-PROVIDER, AND THAT IS NOT OPTIONAL.
#
# An in-namespace control cannot separate "opencode budget exhausted" from
# "the gateway itself is unwell" — both make every opencode lane fail at once,
# which is EXACTLY the signature this tool tests for. So each round also probes
# a `cliproxy/*` lane on a different credential. A round whose control also
# failed is evidence about the gateway and is EXCLUDED from the coincidence
# arithmetic rather than counted as a shared-budget hit. Without that exclusion
# a gateway blip reads as proof of a shared budget.
#
# A QUIET WINDOW IS AN HONEST "INCONCLUSIVE", NOT A "NO".
#
# Measured 2026-09-03 23:38-23:46Z, 16 rounds x 4 lanes + control = 80 calls:
# ZERO throttles, control green throughout. That does not show the budget is
# unshared — it shows the window was quiet. The coincidence test needs
# throttles to exist before it can measure their clustering, so this exits 3
# (INCONCLUSIVE) rather than 0 in that case. An exit 0 here means the question
# was actually answered.
#
# EXIT CODES
#   0  answered — see VERDICT (SHARED or PER-LANE)
#   1  usage / environment error
#   2  MIXED — throttles seen but the pattern is neither clean shape
#   3  INCONCLUSIVE — no throttle observed in this window; run again later
# ===========================================================================
set -u

ROUNDS="${ROUNDS:-16}"
SLEEP_BETWEEN="${SLEEP_BETWEEN:-20}"
OUT="${OUT:-}"

# Distinct model FAMILIES on the same opencode-go credential.
LANES_DEFAULT="opencode-go/qwen3.6-plus opencode-go/glm-5.3 opencode-go/kimi-k2.6 opencode-go/deepseek-v4-flash"
read -r -a LANES <<< "${LANES:-$LANES_DEFAULT}"
CONTROL="${CONTROL:-cliproxy/claude-haiku-4-5-20251001}"

# Test seam, mirroring MODEL_PROBE_CMD in model_lane_probe.sh: when set, it is
# called as `$OPENCODE_PROBE_CMD <model>` and must print `<http><TAB><body>`.
# Defaults to `false` rather than to the live gateway ONLY in the suite; here
# an unset seam means "use curl", because that is this tool's real job.
PROBE_CMD="${OPENCODE_PROBE_CMD:-}"

usage() {
  cat >&2 <<'EOF'
usage: opencode_shared_budget_probe.sh [--rounds N] [--sleep S] [--out FILE]
  ROUNDS/SLEEP_BETWEEN/OUT/LANES/CONTROL are also read from the environment.
  Requires ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN unless
  OPENCODE_PROBE_CMD is set (test seam).
EOF
  exit 1
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --rounds) ROUNDS="${2:-}"; shift 2 ;;
    --sleep)  SLEEP_BETWEEN="${2:-}"; shift 2 ;;
    --out)    OUT="${2:-}"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

if [[ -z "$PROBE_CMD" ]]; then
  if [[ -z "${ANTHROPIC_BASE_URL:-}" || -z "${ANTHROPIC_AUTH_TOKEN:-}" ]]; then
    echo "ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN must be set (or set OPENCODE_PROBE_CMD)" >&2
    exit 1
  fi
fi
[[ -n "$OUT" ]] || OUT="${PAPERCLIP_RUN_SCRATCH_DIR:-/tmp}/opencode-shared-budget.tsv"

# --- one call -------------------------------------------------------------
# Prints "<http>\t<verdict>\t<detail>".
#
# The verdict uses the SAME discriminator the shipped platform classifier uses
# (GATEWAY_CAPACITY_THROTTLE_RE, TOG-894): the gateway's `[provider/model]
# [status]:` prefix, which is only present once the request was routed
# upstream — i.e. after our own credential was accepted. Matching on
# "missing api key" alone would fold a genuinely absent local key into the
# capacity count, which is the original defect wearing a different hat.
# Keeping the two in the same shape is deliberate: if the platform regex is
# ever changed, this probe should be changed with it.
probe() {
  local model="$1" raw http detail
  if [[ -n "$PROBE_CMD" ]]; then
    raw="$($PROBE_CMD "$model" 2>/dev/null)"
    http="${raw%%$'\t'*}"
    detail="${raw#*$'\t'}"
  else
    raw="$(curl -s -m 45 -w $'\n%{http_code}' \
      "${ANTHROPIC_BASE_URL%/}/v1/messages" \
      -H "Authorization: Bearer ${ANTHROPIC_AUTH_TOKEN}" \
      -H "content-type: application/json" \
      -H "X-Anthropic-Agent-Id: ${PAPERCLIP_AGENT_ID:-unknown}" \
      -d "{\"model\":\"${model}\",\"max_tokens\":1,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" 2>/dev/null)"
    http="$(printf '%s' "$raw" | tail -n1)"
    detail="$(printf '%s' "$raw" | head -n -1 | tr -d '\n' | tr -s ' ')"
  fi

  local verdict
  if [[ "$http" == "200" ]]; then
    verdict="OK"
  elif printf '%s' "$detail" | grep -qiE '\[[a-z0-9._-]+/[a-z0-9._-]+\] *\[(401|403|429)\]' \
       && printf '%s' "$detail" | grep -qiE 'missing api key|insufficient_quota|<!doctype html>|reset after [0-9]+ ?s'; then
    verdict="THROTTLE"
  else
    # A deterministic upstream fault (e.g. the gpt-5.6-luna 500) is NOT
    # capacity and must never inflate the coincidence count. TOG-845 filed
    # exactly that 500 as a missing-credential fault; keeping OTHER separate
    # from THROTTLE is how this tool avoids repeating it.
    verdict="OTHER"
  fi
  printf '%s\t%s\t%s' "$http" "$verdict" "${detail:0:200}"
}

printf 'round\tts\tmodel\trole\thttp\tverdict\tdetail\n' > "$OUT"
for ((r=1; r<=ROUNDS; r++)); do
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  for m in "${LANES[@]}"; do
    printf '%s\t%s\t%s\tlane\t%s\n' "$r" "$ts" "$m" "$(probe "$m")" >> "$OUT"
  done
  printf '%s\t%s\t%s\tcontrol\t%s\n' "$r" "$ts" "$CONTROL" "$(probe "$CONTROL")" >> "$OUT"
  printf 'round %s/%s done (%s)\n' "$r" "$ROUNDS" "$ts" >&2
  [[ $r -lt $ROUNDS ]] && sleep "$SLEEP_BETWEEN"
done

# --- coincidence arithmetic ------------------------------------------------
awk -F'\t' -v nlanes="${#LANES[@]}" '
NR==1 { next }
{
  key=$1
  if ($4=="control") { ctrl[key]=$6; next }
  seen[key]=1
  if ($6=="THROTTLE") { thr[key]++; perlane[$3]++; total++ }
  if ($6=="OTHER")    { other[$3"\t"$5]++ }
  lanes[$3]=1
}
END {
  usable=0; excluded=0
  for (k in seen) {
    if (k in ctrl && ctrl[k]!="OK") { excluded++; continue }
    usable++
    c = (k in thr) ? thr[k] : 0
    coin[c]++
    if (c>0) any++
    if (c==nlanes) allc++
    if (c==1) onec++
  }
  printf "\nrounds usable=%d  control-failed(excluded)=%d  lanes=%d\n", usable, excluded, nlanes
  print "\nthrottles per lane (usable rounds only):"
  for (l in lanes) printf "  %3d  %s\n", perlane[l]+0, l
  printf "\ntotal lane-throttle observations: %d\n", total+0
  print "rounds by number of lanes throttling simultaneously:"
  for (c=0; c<=nlanes; c++) if (c in coin) printf "  %d lane(s): %d round(s)\n", c, coin[c]
  if (length(other)>0) {
    print "\nnon-throttle failures (NOT counted as capacity):"
    for (o in other) { split(o,p,"\t"); printf "  %3d  %s  http=%s\n", other[o], p[1], p[2] }
  }
  print "\nVERDICT:"
  if (total+0 == 0) {
    print "  INCONCLUSIVE — zero throttles in this window. This does NOT show the"
    print "  budget is unshared; it shows the window was quiet. Re-run during a"
    print "  throttled period. Exit 3."
    exit 3
  } else if (allc+0 > 0 && onec+0 == 0) {
    print "  SHARED — throttles land on all lanes in the same rounds. A per-lane"
    print "  enable/disable flag is the WRONG control surface; observe capacity."
    exit 0
  } else if (onec+0 > 0 && allc+0 == 0) {
    print "  PER-LANE — throttles are scattered, one lane at a time."
    exit 0
  } else {
    print "  MIXED — see the coincidence table above. State it as measured."
    exit 2
  }
}' "$OUT"
rc=$?
echo "wrote $OUT" >&2
exit $rc
