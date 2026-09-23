#!/usr/bin/env bash
# TOG-811 -- acceptance suite for the cliproxy-insight Caddy lane.
# CISO review TOG-817, REQUIRED CHANGE 5: "One right way => code, not a
# checklist an operator re-improvises."
#
# Run this ON THE HOST, after installing deploy/Caddyfile.snippet and before
# telling anyone the lane is up. It asserts the containment controls the review
# required, against the running edge.
#
# WHAT IT ASSERTS (the review's minimum list, plus a baseline)
#   0  baseline    allowlisted GET + valid lane key -> 200
#   1  bad key     same path, wrong lane key -> 401 AND NO WWW-Authenticate header
#   2  management  /v0/management/{auth-files,api-keys,config} via the lane,
#                  each WITH a valid bearer -> 404. The TOG-816 recon measured
#                  all three as credential- or identity-bearing.
#   3  verbs       POST/PUT/DELETE/PATCH/OPTIONS/HEAD on the allowlisted
#                  path -> 404 (the full TOG-952 criterion-4 list)
#   4  public      /v0/management/usage on the GENERAL public route -> 404
#                  (this is the required-change-3 regression check)
#   5  source ip   request from a non-allowlisted source -> 403, and 403 even
#                  with a wrong bearer (proves the IP check runs FIRST).
#                  Runs for real when this host has a second local address;
#                  SKIPs only when it genuinely has none.
#
# WHY SECTION 0 IS NOT OPTIONAL
#   Every assertion below is a refusal. A lane that is simply DOWN refuses
#   everything and would score a perfect run. If section 0 is not green this
#   script ABORTS rather than reporting passes, because a refusal that would
#   have happened anyway proves nothing.
#
# ASSERTS ON CONTENT, NOT ON EXIT CODES
#   Every check reads the status line and, where it matters, the response
#   headers. `curl` exiting 0 is never treated as a pass -- a connection
#   failure and a correct 404 are different facts.
#
# RATE DISCIPLINE  (TOG-811 design, and a self-inflicted ban during it)
#   CLIProxy IP-bans after a handful of rapid unauthenticated probes -- ~30
#   minutes, measured the hard way. Requests here are sequential and spaced by
#   INSIGHT_SLEEP seconds. Do not parallelise this script. Sections 1 and 3
#   deliberately send wrong credentials, which is exactly the traffic that
#   triggered the ban, so the spacing is load-bearing rather than polite.
#
# USAGE
#   export CLIPROXY_INSIGHT_BEARER=...        # the Paperclip-minted lane key
#                                             # (sent to the lane as x-api-key)
#   ./acceptance_insight_lane.sh \
#       --lane   https://cliproxy-insight.example.net \
#       --public https://cliproxy.example.net
#
# SEAMS (defaults are the real install; the self-test overrides them)
#   INSIGHT_LANE_URL      lane base URL, same as --lane
#   INSIGHT_PUBLIC_URL    public CLIProxy base URL, same as --public
#   INSIGHT_PATH          allowlisted path, default /claude.json (a lane file)
#   INSIGHT_BEARER        the lane key; falls back to CLIPROXY_INSIGHT_BEARER
#   INSIGHT_SLEEP         seconds between requests, default 3
#   INSIGHT_CURL          curl binary, default "curl"
#   INSIGHT_ALT_SOURCE    source address for section 5; auto-detected from this
#                         host's non-loopback addresses when unset
#
# EXIT
#   0  every section passed. Section 5 may SKIP if this host has no second
#      source address to test the IP restriction from; the summary says so
#      explicitly rather than reporting an unqualified pass.
#   1  at least one FAIL
#  64  bad usage
#  70  aborted: baseline red, or a prerequisite missing
set -uo pipefail

LANE="${INSIGHT_LANE_URL:-}"
PUBLIC="${INSIGHT_PUBLIC_URL:-}"
LANE_PATH="${INSIGHT_PATH:-/claude.json}"
BEARER="${INSIGHT_BEARER:-${CLIPROXY_INSIGHT_BEARER:-}}"
SLEEP_S="${INSIGHT_SLEEP:-3}"
CURL="${INSIGHT_CURL:-curl}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --lane)   LANE="${2:-}";      shift 2 ;;
    --public) PUBLIC="${2:-}";    shift 2 ;;
    --path)   LANE_PATH="${2:-}"; shift 2 ;;
    -h|--help) sed -n '1,58p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

PASSES=0; FAILS=0; SKIPS=0
declare -a FAILED_SECTIONS=() SKIPPED_SECTIONS=()
CURRENT="(none)"
pass() { PASSES=$((PASSES+1)); printf 'PASS  %s\n' "$*"; }
fail() { FAILS=$((FAILS+1)); FAILED_SECTIONS+=("$CURRENT"); printf 'FAIL  %s\n' "$*"; }
skip() { SKIPS=$((SKIPS+1)); SKIPPED_SECTIONS+=("$CURRENT"); printf 'SKIP  %s\n' "$*"; }
section() { CURRENT="$1"; printf '\n=== %s ===\n' "$1"; }
die() { printf '\nABORT: %s\n' "$*" >&2; exit 70; }

[[ -n "$LANE"   ]] || { echo "no --lane URL" >&2; exit 64; }
[[ -n "$PUBLIC" ]] || { echo "no --public URL" >&2; exit 64; }
[[ -n "$BEARER" ]] || die "no bearer. export CLIPROXY_INSIGHT_BEARER=... first."
command -v "$CURL" >/dev/null 2>&1 || die "curl not found (INSIGHT_CURL=$CURL)"

# The bearer must never appear in this script's own output, including on an
# abort path -- an operator pastes acceptance output into tickets.
redact() { sed -e "s/${BEARER//\//\\/}/<BEARER-REDACTED>/g"; }

# Allocated ONCE, here, and never reassigned inside probe(). probe() is always
# called in a command substitution -- a subshell -- so an assignment made inside
# it cannot reach this scope. An earlier draft did exactly that and has_header()
# silently read a stale (empty) file, which made section 1's WWW-Authenticate
# check pass no matter what the server sent. The self-test's `www-auth` mutation
# is what caught it; keep this path fixed and that check honest.
HDR_FILE="$(mktemp)"
trap 'rm -f "$HDR_FILE"' EXIT

# probe <method> <url> [auth-header-value]
# Prints the numeric status to stdout; response headers are written to the
# single shared $HDR_FILE, readable by has_header() in the caller's scope.
# A transport failure prints 000, which never equals an expected status, so a
# down endpoint fails loudly instead of passing as "refused".
probe() {
  local method="$1" url="$2" auth="${3:-}"
  : > "$HDR_FILE"
  local args=(-sS -o /dev/null -D "$HDR_FILE" -w '%{http_code}'
              -X "$method" --max-time 15)
  [[ -n "$auth" ]] && args+=(-H "X-Api-Key: $auth")
  "$CURL" "${args[@]}" "$url" 2>/dev/null || echo "000"
  sleep "$SLEEP_S"
}

# probe_head <url> [auth-header-value]
# HEAD needs its own spelling. `curl -X HEAD` sends the verb but then waits for
# a response body that HEAD never returns, so it blocks until --max-time and
# reports a timeout rather than the status the server actually sent. `-I` is
# the correct form: curl then knows not to expect a body. Measured 2026-09-05.
probe_head() {
  local url="$1" auth="${2:-}"
  : > "$HDR_FILE"
  local args=(-sS -o /dev/null -D "$HDR_FILE" -w '%{http_code}' -I --max-time 15)
  [[ -n "$auth" ]] && args+=(-H "X-Api-Key: $auth")
  "$CURL" "${args[@]}" "$url" 2>/dev/null || echo "000"
  sleep "$SLEEP_S"
}

# Header presence, case-insensitively, on the response we just made.
has_header() { grep -qi "^$1:" "$HDR_FILE"; }

printf 'cliproxy-insight lane acceptance\n'
printf '  lane   %s%s\n' "$LANE" "$LANE_PATH"
printf '  public %s\n' "$PUBLIC"
printf '  spacing %ss between requests (CLIProxy IP-bans rapid probing)\n' "$SLEEP_S"

# --- 0. Baseline. Everything below is unattributable without this. ----------
section "0 baseline: allowlisted GET with valid lane key -> 200"
code="$(probe GET "$LANE$LANE_PATH" "$BEARER")"
if [[ "$code" == "200" ]]; then
  pass "GET $LANE_PATH with valid lane key -> 200"
else
  printf 'FAIL  GET %s with valid lane key -> %s (expected 200)\n' "$LANE_PATH" "$code"
  die "baseline is red (got $code). Every other assertion here is a refusal,
     and a lane that is down refuses everything -- so the rest of this run
     would report passes that prove nothing. Fix the lane first.
     000 = could not connect at all (DNS, TLS, or Caddy not listening).
     401 = the lane key in your environment is not the one in Caddy's
           (sent as x-api-key; remember: systemctl RESTART, not reload).
     403 = this host is not the allowlisted source IP -- expected if you are
           running from somewhere other than the Paperclip container's egress.
     404 = the path allowlist does not contain $LANE_PATH."
fi

# --- 1. Wrong bearer -> 401, and no WWW-Authenticate. -----------------------
section "1 wrong lane key -> 401 with no WWW-Authenticate"
code="$(probe GET "$LANE$LANE_PATH" "definitely-not-the-key")"
if [[ "$code" == "401" ]]; then
  # The header check is the half that actually matters: a plain 401 is easy,
  # and a WWW-Authenticate on it sends the Paperclip gateway off doing OAuth
  # discovery against us, burying "wrong lane key" under a protocol error.
  if has_header "WWW-Authenticate"; then
    fail "401 correct, but a WWW-Authenticate header is present -- remove it"
  else
    pass "wrong lane key -> 401, no WWW-Authenticate"
  fi
else
  fail "wrong lane key -> $code (expected 401)"
fi

# --- 2. No CLIProxy management route is reachable through the lane. ---------
# The most important section in this file: it is the reason the lane exists.
# Each is sent WITH the valid bearer on purpose -- refusing them without one
# would prove nothing about containment.
#
# All three paths come from the TOG-816 recon (2026-09-05, CLIProxy v7.2.140),
# which measured what each returns to a holder of the management key:
#   auth-files  identity fields -- email, account, path, id, auth_index,
#               project_id, and a codex id_token
#   api-keys    an inference key, in clear
#   config      the full config including the hashed management key
# The lane proxies a sanitizer, not CLIProxy, so every one of these must 404
# regardless of credential.
section "2 credential/identity-bearing management paths via the lane -> 404"
for p in /v0/management/auth-files /v0/management/api-keys /v0/management/config; do
  code="$(probe GET "$LANE$p" "$BEARER")"
  if [[ "$code" == "404" ]]; then
    pass "$p via lane -> 404 (with a VALID bearer -- containment holds)"
  else
    fail "$p via lane -> $code (expected 404). CONTAINMENT BREACH: the
        credential Paperclip holds can reach account/identity material.
        Do not enable the plugin. Report on TOG-811."
  fi
done

# --- 3. Non-GET verbs on the allowlisted path -> 404. -----------------------
# The full verb list from TOG-952 acceptance criterion 4. HEAD and OPTIONS were
# missing from an earlier draft even though the Caddyfile's own section 1
# comment claims "HEAD and OPTIONS are refused too" -- the config asserted a
# property this suite never checked. Both measured 404 on caddy v2.11.4.
section "3 non-GET verbs on the allowlisted path -> 404"
for verb in POST PUT DELETE PATCH OPTIONS; do
  code="$(probe "$verb" "$LANE$LANE_PATH" "$BEARER")"
  if [[ "$code" == "404" ]]; then
    pass "$verb $LANE_PATH -> 404"
  else
    fail "$verb $LANE_PATH -> $code (expected 404) -- read-only is not enforced
        at the edge; the plugin's own discipline is the only thing left"
  fi
done
code="$(probe_head "$LANE$LANE_PATH" "$BEARER")"
if [[ "$code" == "404" ]]; then
  pass "HEAD $LANE_PATH -> 404"
else
  fail "HEAD $LANE_PATH -> $code (expected 404) -- a HEAD that is not refused
      leaks path existence by status code alone"
fi

# --- 4. Required change 3 regression: public management route is closed. ----
# Measured 2026-09-03 by the CISO as OPEN (CLIProxy's own 401 came back through
# it). This section is the standing check that it stayed closed. A 401 here is
# a FAIL, not a near-miss: it means CLIProxy is answering, which means the
# route is still proxied and only the key stands between the internet and
# auth-files.
section "4 /v0/management/* on the general public route -> 404"
for p in /v0/management/usage /v0/management/auth-files; do
  code="$(probe GET "$PUBLIC$p" "")"
  case "$code" in
    404) pass "public $p -> 404 (closed)" ;;
    401) fail "public $p -> 401 -- CLIProxy is still answering on the public
        route. The management surface remains publicly proxied behind only the
        management key. This is required change 3 and it is NOT done." ;;
    *)   fail "public $p -> $code (expected 404)" ;;
  esac
done

# --- 5. Source restriction.  [REQUIRED CHANGE 1] ----------------------------
# This section used to SKIP unconditionally, on the reasoning that a 403 cannot
# be produced from an allowlisted source. That reasoning was too strong: it is
# only true if the host has exactly ONE usable source address. A host with a
# second local address can bind it with `curl --interface` and reach the lane
# from a source the allowlist does not name. Demonstrated 2026-09-05 against a
# real caddy v2.11.4 -- from 127.0.0.1 the lane returned 200, from a second
# local address 10.89.x.x the same request returned 403.
#
# So: try to prove it, and SKIP only if this host genuinely offers no second
# address. INSIGHT_ALT_SOURCE overrides the auto-detection.
#
# The wrong-bearer sub-check is the one that proves ORDERING: a non-allowlisted
# source must get 403 even with a bad bearer. If it returns 401 instead, the
# bearer check is running first, which tells an off-network scanner that its
# source address was acceptable -- and leaks bearer-validity as an oracle.
section "5 non-allowlisted source IP -> 403"
alt_source() {
  # Note `+` not `:-`: SET-BUT-EMPTY is meaningful and means "do not test this,
  # I know this host has no usable second source." Auto-detection happens only
  # when the variable is entirely unset. The self-test relies on this to force
  # a deterministic SKIP against its loopback sim.
  if [[ -n "${INSIGHT_ALT_SOURCE+set}" ]]; then
    printf '%s' "$INSIGHT_ALT_SOURCE"; return
  fi
  # Any local IPv4 that is neither loopback nor a link-local autoconf address.
  ip -o -4 addr show 2>/dev/null \
    | awk '{split($4,a,"/"); print a[1]}' \
    | grep -Ev '^(127\.|169\.254\.)' \
    | head -1
}
ALT="$(alt_source)"
if [[ -z "$ALT" ]]; then
  skip "this host offers no second source address to test from, and from the
     allowlisted one a 403 cannot be produced. Verify by hand from any other
     box:
       curl -sS -o /dev/null -w '%{http_code}\\n' \\
            -H 'X-Api-Key: <the lane key>' $LANE$LANE_PATH
     Expect 403. If it returns 200 or 401, required change 1 is missing and a
     leaked bearer is usable from the open internet."
else
  code="$("$CURL" -sS -o /dev/null -w '%{http_code}' --max-time 15 \
          --interface "$ALT" -H "X-Api-Key: $BEARER" \
          "$LANE$LANE_PATH" 2>/dev/null || echo "000")"
  sleep "$SLEEP_S"
  case "$code" in
    403) pass "GET from non-allowlisted source $ALT -> 403" ;;
    000) skip "could not bind source $ALT (no route to the lane from it).
     Verify by hand from another box; expect 403." ;;
    *)   fail "GET from non-allowlisted source $ALT -> $code (expected 403).
        Required change 1 is missing or ineffective: a leaked bearer is usable
        from any source that can reach this lane." ;;
  esac

  if [[ "$code" == "403" ]]; then
    code="$("$CURL" -sS -o /dev/null -w '%{http_code}' --max-time 15 \
            --interface "$ALT" -H "X-Api-Key: definitely-not-the-key" \
            "$LANE$LANE_PATH" 2>/dev/null || echo "000")"
    sleep "$SLEEP_S"
    if [[ "$code" == "403" ]]; then
      pass "non-allowlisted source + wrong bearer -> 403 (IP check precedes bearer)"
    else
      fail "non-allowlisted source + wrong bearer -> $code (expected 403). The
        bearer check is running BEFORE the source check, which turns this lane
        into a bearer-validity oracle for an off-network scanner."
    fi
  fi
fi

# --- Summary ----------------------------------------------------------------
printf '\n=== summary ===\n'
printf 'pass %d  fail %d  skip %d\n' "$PASSES" "$FAILS" "$SKIPS"
if ((FAILS)); then
  printf 'failed sections: %s\n' "${FAILED_SECTIONS[*]}" | redact
  printf '\nLANE NOT ACCEPTED. Do not set pollingEnabled or place the bearer.\n'
  exit 1
fi
if ((SKIPS > 1)); then
  printf 'unexpected skips: %s\n' "${SKIPPED_SECTIONS[*]}"
  printf '\nOnly section 5 may skip. Something else did not run.\n'
  exit 1
fi
if ((SKIPS == 1)); then
  printf '\nLANE ACCEPTED, WITH ONE CONTROL UNPROVEN.\n'
  printf 'Section 5 (source-IP restriction) could not run on this host. It is the\n'
  printf 'control that keeps a leaked bearer from being usable from the open\n'
  printf 'internet, so verify it by hand from another box before enabling the\n'
  printf 'plugin -- the command is printed above.\n'
else
  printf '\nLANE ACCEPTED. All six controls proven on this host, including the\n'
  printf 'source-IP restriction.\n'
fi
printf '\nNote what this does and does not prove: the edge controls hold. It says\n'
printf 'nothing about what the SANITIZER behind them emits. Section 0 only checks\n'
printf 'that a lane file (%s) answers 200 -- proving its body carries no\n' "$LANE_PATH"
printf 'identity field is TOG-975s own acceptance, and it is a separate gate.\n'
exit 0
