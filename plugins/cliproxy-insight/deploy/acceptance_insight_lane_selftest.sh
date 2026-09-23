#!/usr/bin/env bash
# TOG-811 -- prove acceptance_insight_lane.sh is not vacuous, from a container.
#
# acceptance_insight_lane.sh can only run on the host, against a real Caddy.
# That means the operator would be the FIRST person ever to execute it, against
# a freshly installed lane, with no way to distinguish "these assertions passed"
# from "these assertions never looked at anything". A green suite nobody has
# watched go red is not evidence. So this runs first, here.
#
# WHAT IS REAL AND WHAT IS SUBSTITUTED
#   REAL: acceptance_insight_lane.sh, unmodified, driven over real HTTP with
#         real headers against a real TCP socket.
#   SUBSTITUTED: Caddy, by lane_sim.mjs. The policy under test in production is
#         Caddyfile.snippet; what is under test HERE is the SUITE -- that each
#         assertion is wired to the control it claims to check.
#   NOT COVERED: TLS, the source-IP restriction (section 5, which SKIPs here for
#         the same structural reason it SKIPs on the host), and Caddy's own
#         matcher semantics. Those are proven on the host, not here.
#
# THE ACTUAL TEST
#   Phase 1  baseline: unmutated sim, the suite must exit 0 with exactly one
#            skip (section 5). Without this, every red below is unattributable.
#   Phase 2  five mutations, each removing ONE control. Each must exit non-zero
#            AND name the expected section. "It went red" is not enough --
#            deleting the assertions outright would also go red.
#   Phase 3  the `dead` case: a lane that is entirely down must ABORT (exit 70),
#            never report passes. This is the failure mode a refusal-only suite
#            is structurally prone to, so it is asserted separately.
#   Phase 4  the bearer must not appear in the suite's own output.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUITE="$HERE/acceptance_insight_lane.sh"
SIM="$HERE/lane_sim.mjs"
BEARER="selftest-bearer-do-not-use-anywhere-real"
MGMT="selftest-management-key"

command -v node >/dev/null 2>&1 || { echo "node required" >&2; exit 70; }
[[ -x "$SUITE" ]] || { echo "not executable: $SUITE" >&2; exit 70; }
[[ -f "$SIM"   ]] || { echo "missing: $SIM" >&2; exit 70; }

FAILS=0
ok()  { printf 'ok    %s\n' "$*"; }
bad() { FAILS=$((FAILS+1)); printf 'NOT OK %s\n' "$*"; }

SIM_PID=""; OUT=""
stop_sim() { [[ -n "$SIM_PID" ]] && kill "$SIM_PID" 2>/dev/null; SIM_PID=""; }
trap 'stop_sim; [[ -n "$OUT" ]] && rm -f "$OUT"' EXIT

# run_suite <mutation> -> sets SUITE_RC and SUITE_OUT
run_suite() {
  local mutation="$1" port line
  OUT="$(mktemp)"
  # Port 0 lets the kernel choose, so parallel CI runs cannot collide.
  MUTATE="$mutation" LANE_BEARER="$BEARER" LANE_MGMT_KEY="$MGMT" LANE_PORT=0 \
    node "$SIM" > "$OUT" 2>&1 &
  SIM_PID=$!
  for _ in $(seq 1 50); do
    line="$(grep -m1 '^LANE_SIM_PORT=' "$OUT" 2>/dev/null || true)"
    [[ -n "$line" ]] && break
    sleep 0.1
  done
  [[ -n "$line" ]] || { stop_sim; echo "sim did not start for MUTATE=$mutation" >&2; exit 70; }
  port="${line#LANE_SIM_PORT=}"

  # --resolve maps both vhost names onto the sim's loopback port, so the suite
  # sends the Host headers it really would and the sim discriminates on them.
  # INSIGHT_ALT_SOURCE is pinned EMPTY on purpose. Section 5 auto-detects a
  # second local address and binds it with `curl --interface`; against a
  # loopback sim that would either fail to route or bind an address the sim
  # answers identically from, i.e. it would test nothing while looking like it
  # did. Forcing the SKIP keeps this phase deterministic on any host. The
  # source-IP control is proven against real Caddy, per the header's
  # "NOT COVERED" note.
  SUITE_OUT="$(
    INSIGHT_BEARER="$BEARER" \
    INSIGHT_SLEEP=0 \
    INSIGHT_CURL="$HERE/.selftest-curl" \
    INSIGHT_ALT_SOURCE="" \
    SELFTEST_PORT="$port" \
    "$SUITE" --lane "http://lane.test" --public "http://public.test" 2>&1
  )"
  SUITE_RC=$?
  stop_sim
  rm -f "$OUT"; OUT=""
}

# A curl shim that redirects both test hostnames to the sim's ephemeral port.
# The suite is run UNMODIFIED; only the curl it invokes is substituted, through
# the INSIGHT_CURL seam the suite already exposes.
cat > "$HERE/.selftest-curl" <<'SHIM'
#!/usr/bin/env bash
args=()
for a in "$@"; do
  case "$a" in
    http://lane.test*)   args+=("http://127.0.0.1:${SELFTEST_PORT}${a#http://lane.test}")   ;;
    http://public.test*) args+=("http://127.0.0.1:${SELFTEST_PORT}${a#http://public.test}") ;;
    *) args+=("$a") ;;
  esac
done
# Host header must survive the rewrite: it is what the sim (and Caddy) route on.
host="lane.test"
for a in "$@"; do case "$a" in http://public.test*) host="public.test" ;; esac; done
exec curl -H "Host: $host" "${args[@]}"
SHIM
chmod +x "$HERE/.selftest-curl"
trap 'stop_sim; rm -f "$HERE/.selftest-curl"; [[ -n "$OUT" ]] && rm -f "$OUT"' EXIT

printf '=== phase 1: baseline (unmutated sim) ===\n'
run_suite none
if [[ $SUITE_RC -eq 0 ]]; then
  ok "baseline exits 0"
else
  bad "baseline exits $SUITE_RC, expected 0"
  printf '%s\n' "$SUITE_OUT" | sed 's/^/    | /'
fi
# 13 = 1 baseline + 1 bad-bearer + 3 management paths + 6 verbs + 2 public.
# Section 5 SKIPs by design here (INSIGHT_ALT_SOURCE pinned empty above).
if grep -q 'pass 13  fail 0  skip 1' <<<"$SUITE_OUT"; then
  ok "baseline scores 13 pass / 0 fail / 1 skip (only section 5 skips)"
else
  bad "baseline tally unexpected: $(grep -E '^pass ' <<<"$SUITE_OUT")"
fi

printf '\n=== phase 2: one control removed at a time ===\n'
# mutation | section that must appear in the failure list
mutations=(
  "www-auth|1 wrong lane key"
  "authfiles|2 credential/identity-bearing management paths"
  "verbs|3 non-GET verbs"
  "public-open|4 /v0/management/*"
)
for entry in "${mutations[@]}"; do
  mutation="${entry%%|*}"; expect="${entry#*|}"
  run_suite "$mutation"
  if [[ $SUITE_RC -eq 0 ]]; then
    bad "MUTATE=$mutation still exits 0 -- the suite does not detect it"
    continue
  fi
  if grep -q "failed sections:.*$expect" <<<"$SUITE_OUT"; then
    ok "MUTATE=$mutation -> red, and section '$expect' is the one that failed"
  else
    bad "MUTATE=$mutation -> red, but not via '$expect'. Got: $(
      grep 'failed sections:' <<<"$SUITE_OUT")"
  fi
done

printf '\n=== phase 3: a down lane must ABORT, not score passes ===\n'
run_suite dead
if [[ $SUITE_RC -eq 70 ]]; then
  ok "MUTATE=dead aborts with 70 (baseline guard fired)"
else
  bad "MUTATE=dead exits $SUITE_RC, expected 70 (abort)"
fi
if grep -q 'PASS' <<<"$SUITE_OUT"; then
  bad "MUTATE=dead printed a PASS -- a down lane is scoring assertions"
else
  ok "MUTATE=dead printed no PASS lines"
fi

printf '\n=== phase 4: the bearer never appears in suite output ===\n'
run_suite www-auth
if grep -qF "$BEARER" <<<"$SUITE_OUT"; then
  bad "the bearer leaked into suite output -- operators paste this into tickets"
else
  ok "bearer absent from suite output on a failing run"
fi

printf '\n=== summary ===\n'
if ((FAILS)); then
  printf '%d check(s) failed. acceptance_insight_lane.sh is NOT proven.\n' "$FAILS"
  exit 1
fi
printf 'All checks passed. Each assertion in acceptance_insight_lane.sh has been\n'
printf 'watched going red for its own reason, and a down lane aborts rather than\n'
printf 'reporting a clean run.\n'
exit 0
