#!/usr/bin/env bash
# Regression suite for gh_token.sh `api` — the request body must reach the
# request and only the request, and an HTTP refusal must not report success.
#
# THE BUG THIS EXISTS FOR (TOG-305). curl_authed's contract is
#
#     curl_authed <bearer> <method> <url> <json-body-or-empty> [extra curl args...]
#
# and the `api` subcommand called it with the body slot hardcoded empty:
#
#     curl_authed "$tok" "$method" "https://api.github.com${path}" "" "$@"
#
# After `shift 2`, "$@" is the caller's JSON body. So the body landed in the
# EXTRA CURL ARGS slot and curl parsed it as a URL, while the actual request
# went out with no body at all. Observed on a real guarded merge:
#
#     ./gh_token.sh api PUT /repos/.../pulls/12/merge \
#         '{"merge_method":"squash","sha":"3a9194a0..."}'
#     { "merged": true }                       <- the write happened
#     curl: (3) URL rejected: Port number ...  <- the body, parsed as a URL
#
# Three silent consequences, and this suite has a section for each:
#
#   1. The `sha` head guard was never sent. The caller asked for a guarded
#      merge and got an unguarded one. Same class as a silently-skipped auth
#      check: the protection you requested was not applied and nothing said so.
#   2. `merge_method` was dropped, so a squash silently became a merge commit.
#   3. The exit status came from the LAST curl URL, so a successful API write
#      reported failure — and, in the other direction, a failed write could be
#      masked by a stray argument that happened to parse.
#
# THE SECOND BUG THIS COVERS (TOG-455). Even after the request's transport status
# was propagated correctly, curl still exits 0 when GitHub reaches the request
# and refuses it with HTTP 4xx/5xx. That made `api ... && echo merged` print
# "merged" after a guarded merge returned 409. Section 10 requires the refusal
# body and a distinct non-zero exit together; section 11 pins the existing
# check/token/meta diagnostics, whose app_api calls must keep parsing error bodies.
#
# WHY THIS IS HARDER THAN IT LOOKS. Four traps, each of which a naive suite
# falls into and this one deliberately does not:
#
#   Asserting only "the body reached curl somehow" is passed by the BUG, which
#   did put the body on curl's command line. So every body assertion is against
#   the CONFIG FILE specifically, and is paired with the argv check below.
#
#   Asserting only "the body is absent from argv" is passed by a tool that
#   drops the body entirely — the exact pre-fix behaviour. So the two are
#   always asserted together, and the config-file check is byte-exact against
#   the body the caller passed rather than a substring probe.
#
#   Grepping gh_token.sh's source for the fixed call proves nothing about what
#   ran. So this suite asserts on the kernel's own record: a stub `curl` on
#   PATH reads its own /proc/<pid>/cmdline, byte for byte what a neighbouring
#   process would have read, plus the config file curl was actually handed.
#
#   The stub reads /proc/$$/cmdline, NOT /proc/self/cmdline. `< /proc/self/...`
#   is opened by a forked child about to exec `tr`, so `self` would resolve to
#   tr's argv and the absence assertion would pass for the wrong reason. $$ is
#   this shell's own pid, resolved before the fork.
#
# Offline by construction, like test_gh_token_argv.sh: a throwaway RSA key
# generated per run, a fabricated app id, a stub curl that never opens a
# socket. The tool runs under `env -i` so an operator's live credentials
# cannot leak in, and so a regression cannot mint a real token while the suite
# is running.
#
# Requires bash, openssl, jq, and /proc. No node, no network, no credentials.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${GH_TOKEN_SH:-$HERE/gh_token.sh}"
PASS=0; FAIL=0

ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); [[ -n "${2:-}" ]] && printf '        %s\n' "$2"; return 0; }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

for dep in openssl jq; do
  command -v "$dep" >/dev/null 2>&1 || { echo "test_gh_token_api_body: $dep is required" >&2; exit 2; }
done
[[ -r /proc/$$/cmdline ]] || { echo "test_gh_token_api_body: needs a Linux /proc" >&2; exit 2; }
[[ -x "$TOOL" ]] || { echo "test_gh_token_api_body: $TOOL is not executable" >&2; exit 2; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- the body under test ------------------------------------------------------
# Deliberately the shape from the bug report: a merge with a head-SHA guard.
# BODY_CANARY is the string a snooping neighbour would have seen on argv, and
# SHA_CANARY / METHOD_CANARY are the two fields whose loss was silent.
SHA_CANARY="b0dyca9a7ee0000000000000000000000000ffff"
METHOD_CANARY="squash"
BODY_CANARY="{\"merge_method\":\"${METHOD_CANARY}\",\"sha\":\"${SHA_CANARY}\"}"
# A second body with characters that the curl config parser treats as syntax,
# so "the body arrived" is not accidentally true only for the easy case. curl's
# config format quotes with " and escapes with \, and a body containing both is
# where a naive `printf '%s'` implementation corrupts the request silently.
TRICKY_BODY='{"title":"a \"quoted\" title","path":"C:\\tmp\\x","note":"tab\there, newline\nhere","q":"a=b&c=d #frag"}'

MINT_CANARY="gh""s_APIBODYSUITE0000000000000000000CC"

# --- fake credential environment ----------------------------------------------
openssl genrsa -out "$TMP/fake-key.pem" 2048 >/dev/null 2>&1 \
  || { echo "test_gh_token_api_body: could not generate a test key" >&2; exit 2; }
chmod 600 "$TMP/fake-key.pem"
cat > "$TMP/fake.env" <<'ENVF'
GITHUB_APP_ID=000000
GITHUB_APP_INSTALLATION_ID=99999999
GITHUB_ORG=stub-org
ENVF
chmod 600 "$TMP/fake.env"

# --- stub curl ----------------------------------------------------------------
# One directory of numbered per-call records, so an assertion can name WHICH
# call it means. `api` makes two: the mint, then the caller's request. A suite
# that merged them would let the mint's own `{}` body satisfy an assertion
# about the caller's body.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/curl" <<'STUBCURL'
#!/usr/bin/env bash
# $$ not self: see the header of test_gh_token_api_body.sh.
n=$(( $(cat "$STUB_DIR/seq" 2>/dev/null || echo 0) + 1 ))
printf '%s\n' "$n" > "$STUB_DIR/seq"

tr '\0' '\n' < "/proc/$$/cmdline" > "$STUB_DIR/call.$n.argv"

cfg=""; prev=""
for a in "$@"; do
  case "$prev" in --config|-K) cfg="$a" ;; esac
  prev="$a"
done

url=""
: > "$STUB_DIR/call.$n.body"
: > "$STUB_DIR/call.$n.headers"
: > "$STUB_DIR/call.$n.bearer"
if [ -n "$cfg" ]; then
  cp "$cfg" "$STUB_DIR/call.$n.cfg"
  url="$(sed -n 's/^url = "\(.*\)"$/\1/p' "$cfg")"
  # The raw config value, still in its JSON-string form. The suite decodes it
  # with jq and compares byte for byte against what the caller passed.
  sed -n 's/^data-binary = //p' "$cfg" > "$STUB_DIR/call.$n.body"
  sed -n 's/^header = "\(.*\)"$/\1/p' "$cfg" > "$STUB_DIR/call.$n.headers"
  sed -n 's/^header = "Authorization: Bearer \(.*\)"$/\1/p' "$cfg" > "$STUB_DIR/call.$n.bearer"
fi
printf '%s\n' "$url" > "$STUB_DIR/call.$n.url"

rc=0
http_status=200
case "$url" in
  */access_tokens)
    if [ -n "${STUB_MINT_FAILS:-}" ]; then
      printf '{"message":"stub refuses to mint"}\n'
    else
      printf '{"token":"%s","expires_at":"2099-01-01T00:00:00Z"}\n' "$STUB_MINT_CANARY"
    fi
    ;;
  */app)
    if [ -n "${STUB_APP_FAILS:-}" ]; then
      printf '{"message":"stub refuses app check"}\n'
    else
      printf '{"name":"stub","slug":"stub-app","id":1,"owner":{"login":"stub"}}\n'
    fi
    ;;
  *)
    printf '%s' "${STUB_API_BODY:-{\"ok\":true\}}"
    # The transport- and HTTP-failure seams apply only to the caller's request,
    # never to the mint, so the two cannot be confused.
    if [ -n "${STUB_API_RC:-}" ]; then rc="$STUB_API_RC"; fi
    if [ -n "${STUB_API_STATUS:-}" ]; then http_status="$STUB_API_STATUS"; fi
    ;;
esac

# curl's -D/--dump-header writes response headers to a file and leaves the body
# on stdout. Honour the last spelling, as real curl does when an option repeats.
dump=""; prev=""
for a in "$@"; do
  case "$prev" in --dump-header|-D) dump="$a" ;; esac
  prev="$a"
done
if [ -n "$dump" ]; then
  printf 'HTTP/1.1 %s Stub\r\nContent-Type: application/json\r\n\r\n' "$http_status" > "$dump"
fi

# Real curl treats every non-option argument as a URL, and exits with the
# status of the LAST one it processed. That is not stub colour -- it is the
# whole reported symptom: the guarded merge SUCCEEDED, curl then choked on the
# JSON it had been handed positionally, and rc came from the choke:
#
#     { "merged": true }
#     curl: (3) URL rejected: Port number was not a decimal number ...
#
# So a config-file request that succeeds still reports failure, and -- in the
# other direction -- a request that FAILED can be masked by a later argument
# that happens to parse. Modelling it here is what makes section 9 measure
# something; without it those assertions pass before and after the fix alike.
# Narrowed to JSON-shaped arguments so that legitimate option VALUES (the `7`
# in `--max-time 7`, which real curl consumes as an argument) are not
# misreported as URLs.
for a in "$@"; do
  case "$a" in
    '{'*|'['*)
      printf 'curl: (3) URL rejected: Port number was not a decimal number between 0 and 65535\n' >&2
      rc=3
      ;;
  esac
done
exit "$rc"
STUBCURL
chmod +x "$TMP/bin/curl"

# --- runner -------------------------------------------------------------------
# `env -i` is the safety property, not tidiness: with a real GITHUB_APP_PEM
# readable and an inherited environment, a regressed tool would mint a REAL
# token while this suite ran.
STUB_DIR="$TMP/calls"
RC=0; OUT=""; ERR=""
run_tool() {
  rm -rf "$STUB_DIR"; mkdir -p "$STUB_DIR"
  rm -rf "$TMP/tooltmp"; mkdir -p "$TMP/tooltmp"
  OUT="$(env -i \
    PATH="$TMP/bin:$PATH" \
    HOME="$TMP" \
    TMPDIR="$TMP/tooltmp" \
    GITHUB_APP_PEM="$TMP/fake-key.pem" \
    GITHUB_APP_ENV="$TMP/fake.env" \
    STUB_DIR="$STUB_DIR" \
    STUB_MINT_CANARY="$MINT_CANARY" \
    ${STUB_MINT_FAILS:+STUB_MINT_FAILS=1} \
    ${STUB_APP_FAILS:+STUB_APP_FAILS=1} \
    ${STUB_API_RC:+STUB_API_RC="$STUB_API_RC"} \
    ${STUB_API_STATUS:+STUB_API_STATUS="$STUB_API_STATUS"} \
    ${STUB_API_BODY:+STUB_API_BODY="$STUB_API_BODY"} \
    bash "$TOOL" "$@" 2>"$TMP/stderr")"
  RC=$?
  ERR="$(cat "$TMP/stderr")"
}
STUB_MINT_FAILS=""
STUB_APP_FAILS=""
STUB_API_RC=""
STUB_API_STATUS=""
STUB_API_BODY=""

ncalls() { cat "$STUB_DIR/seq" 2>/dev/null || echo 0; }
# The index of the call that is NOT the mint. Named rather than assumed to be
# call 2, so a future extra JWT call does not silently shift what is asserted.
api_call() {
  local n i
  n="$(ncalls)"
  for (( i=1; i<=n; i++ )); do
    case "$(cat "$STUB_DIR/call.$i.url" 2>/dev/null)" in
      */access_tokens) ;;
      "") ;;
      *) printf '%s' "$i"; return 0 ;;
    esac
  done
  return 1
}
# The body curl was actually given for that call, decoded back out of the
# config file's JSON-string encoding.
api_body() {
  local i raw
  i="$(api_call)" || return 1
  raw="$(cat "$STUB_DIR/call.$i.body" 2>/dev/null)"
  [[ -n "$raw" ]] || return 1
  jq -r . <<<"$raw" 2>/dev/null
}
# Everything the kernel saw, across every curl this run started.
all_argv() { cat "$STUB_DIR"/call.*.argv 2>/dev/null; }

# --- 0. positive controls -----------------------------------------------------
# This suite's two core assertions are a grep that must fire and a grep that
# must not. Prove the first one CAN fire, or "the body is not in argv" is
# indistinguishable from a blind detector.
hdr "0. Positive controls — the detectors must work at all"
rm -rf "$STUB_DIR"; mkdir -p "$STUB_DIR"
STUB_DIR="$STUB_DIR" STUB_MINT_CANARY="$MINT_CANARY" \
  "$TMP/bin/curl" -sS https://api.github.com/x "$BODY_CANARY" >/dev/null 2>&1
if grep -qF "$SHA_CANARY" "$STUB_DIR"/call.*.argv 2>/dev/null; then
  ok "a request body passed on argv IS detected in /proc/<curl>/cmdline"
else
  bad "detector is blind: a body on argv was not seen in /proc" \
      "every argv result below is meaningless — fix this first"
fi

# And prove the config-file reader can come up EMPTY, so "the body arrived"
# is a real measurement rather than a constant.
rm -rf "$STUB_DIR"; mkdir -p "$STUB_DIR"
printf 'url = "https://api.github.com/x"\n' > "$TMP/emptycfg"
STUB_DIR="$STUB_DIR" STUB_MINT_CANARY="$MINT_CANARY" \
  "$TMP/bin/curl" --config "$TMP/emptycfg" >/dev/null 2>&1
if [[ ! -s "$STUB_DIR/call.1.body" ]]; then
  ok "a config file with no data-binary line reads as no body"
else
  bad "the config-file body reader invents a body" "it would pass section 1 unconditionally"
fi

# --- 1. the body reaches the request, and only the request --------------------
hdr "1. 'api METHOD PATH BODY' — the body is the request body"
run_tool api PUT /repos/stub-org/repo/pulls/12/merge "$BODY_CANARY"

if [[ $RC -eq 0 ]]; then
  ok "api with a body exits 0 against the stub"
else
  bad "api with a body exited $RC" "stderr: ${ERR:0:200}"
fi

got_body="$(api_body)"
if [[ "$got_body" == "$BODY_CANARY" ]]; then
  ok "the body reached curl by config file, byte for byte"
else
  bad "the body did not reach the request as given" \
      "sent='${got_body:-<none>}' wanted='$BODY_CANARY'"
fi

# The other half. Without this, a tool that puts the body on argv — which is
# precisely what the bug did — would satisfy the assertion above.
if grep -qF "$SHA_CANARY" <(all_argv); then
  bad "the request body reached curl's argv" \
      "/proc/<curl>/cmdline is world-readable; bodies can carry secrets"
else
  ok "the body is absent from /proc/<curl>/cmdline"
fi

i="$(api_call)" && {
  if grep -qxF 'Content-Type: application/json' "$STUB_DIR/call.$i.headers"; then
    ok "Content-Type: application/json accompanies the body"
  else
    bad "no Content-Type header was sent with the body"
  fi
}

if [[ "$(ncalls)" == "2" ]]; then
  ok "exactly two curl invocations: the mint and the request"
else
  bad "expected 2 curl invocations, saw $(ncalls)" \
      "a stray argument parsed as an extra URL is how the exit status went wrong"
fi

# --- 2. the guard fields specifically -----------------------------------------
# Section 1 already covers these by byte-equality. They are asserted again by
# name because they are the harm: 'the guard you asked for was not applied'.
hdr "2. The fields whose loss was silent"
if [[ "$(jq -r '.sha // empty' <<<"${got_body:-null}" 2>/dev/null)" == "$SHA_CANARY" ]]; then
  ok "the 'sha' head guard was actually sent"
else
  bad "the 'sha' head guard never reached GitHub" \
      "a guarded write executed unguarded, with no warning — the TOG-305 harm"
fi
if [[ "$(jq -r '.merge_method // empty' <<<"${got_body:-null}" 2>/dev/null)" == "$METHOD_CANARY" ]]; then
  ok "'merge_method' was actually sent"
else
  bad "'merge_method' was dropped" "a requested squash silently becomes a merge commit"
fi

# --- 3. bodies the config format would otherwise corrupt ----------------------
hdr "3. A body containing quotes, backslashes and escapes survives intact"
run_tool api POST /repos/stub-org/repo/issues "$TRICKY_BODY"
got_tricky="$(api_body)"
if [[ "$got_tricky" == "$TRICKY_BODY" ]]; then
  ok "a body full of config-parser syntax arrived byte for byte"
else
  bad "the body was corrupted in transit to curl" \
      "sent='${got_tricky:-<none>}'"
fi
if grep -qF 'a=b&c=d' <(all_argv); then
  bad "the tricky body reached curl's argv"
else
  ok "the tricky body is absent from argv"
fi

# --- 4. no body means no body -------------------------------------------------
hdr "4. 'api GET PATH' with no body sends none"
run_tool api GET /orgs/stub-org/repos
[[ $RC -eq 0 ]] && ok "api with no body exits 0" || bad "api with no body exited $RC" "${ERR:0:200}"
i="$(api_call)" && {
  if [[ ! -s "$STUB_DIR/call.$i.body" ]]; then
    ok "no data-binary line is written when there is no body"
  else
    bad "a body was sent for a bodyless call" "value: $(cat "$STUB_DIR/call.$i.body")"
  fi
  if grep -qxF 'Content-Type: application/json' "$STUB_DIR/call.$i.headers"; then
    bad "Content-Type was sent for a bodyless call"
  else
    ok "no Content-Type header when there is no body"
  fi
  # Nothing but the config path may be on argv. This is the assertion that
  # would have caught the original bug at its root: a slot that accepts
  # arbitrary strings from the caller and hands them to curl positionally.
  # `bash` and the absolute path are the stub's own shebang expansion, not
  # anything gh_token.sh chose to pass.
  stray="$(grep -v -e '^curl$' -e '^bash$' -e '^--config$' -e '^--dump-header$' -e '^/' -e '^$' \
             "$STUB_DIR/call.$i.argv" || true)"
  if [[ -z "$stray" ]]; then
    ok "curl's argv is the config path and nothing else"
  else
    bad "unexpected arguments on curl's argv" "$(tr '\n' ' ' <<<"$stray")"
  fi
}

# --- 5. extra curl arguments still work, from a slot that cannot collide ------
hdr "5. Extra curl arguments come after '--'"
run_tool api GET /orgs/stub-org/repos -- --max-time 7
[[ $RC -eq 0 ]] && ok "api with '-- extra args' exits 0" || bad "exited $RC" "${ERR:0:200}"
if grep -qxF -- '--max-time' <(all_argv) && grep -qxF -- '7' <(all_argv); then
  ok "caller-supplied curl arguments still reach curl"
else
  bad "extra curl arguments after '--' were dropped"
fi
i="$(api_call)" && {
  if [[ ! -s "$STUB_DIR/call.$i.body" ]]; then
    ok "'--' arguments were not mistaken for a body"
  else
    bad "an extra curl argument became the request body" "$(cat "$STUB_DIR/call.$i.body")"
  fi
}

hdr "6. A body AND extra curl arguments together"
run_tool api POST /repos/stub-org/repo/issues "$BODY_CANARY" -- --max-time 7
[[ $RC -eq 0 ]] && ok "api with both exits 0" || bad "exited $RC" "${ERR:0:200}"
if [[ "$(api_body)" == "$BODY_CANARY" ]]; then
  ok "the body survived alongside extra arguments"
else
  bad "the body was lost when extra arguments were present" "got='$(api_body)'"
fi
if grep -qxF -- '--max-time' <(all_argv); then
  ok "the extra argument survived alongside the body"
else
  bad "the extra argument was lost when a body was present"
fi
if grep -qF "$SHA_CANARY" <(all_argv); then
  bad "the body reached argv when extra arguments were present"
else
  ok "the body stayed off argv alongside extra arguments"
fi

# --- 7. the two slots cannot collide ------------------------------------------
# The property the fix has to carry, not just the happy path. The old grammar
# read position 3 as 'extra curl args', the new one reads it as 'the body'.
# A caller using the OLD form must be REFUSED, not silently reinterpreted --
# `api GET /path --max-time 7` must never quietly become a request with the
# body '--max-time'. Refusing is the whole point: this bug class is 'the thing
# you asked for was not what happened, and nothing told you'.
hdr "7. An ambiguous invocation refuses instead of guessing"
run_tool api GET /orgs/stub-org/repos --max-time 7
if [[ $RC -eq 2 ]]; then
  ok "a bare curl flag in the body slot is a usage error (exit 2)"
else
  bad "expected exit 2 for an ambiguous invocation, got $RC" \
      "out='${OUT:0:80}' err='${ERR:0:160}'"
fi
if [[ "$(ncalls)" == "0" ]]; then
  ok "the ambiguous invocation made no network call at all"
else
  bad "a refused invocation still called out $(ncalls) time(s)" \
      "it minted a token and/or executed the write it could not parse"
fi
if grep -qi -e 'curl' -e '--' <<<"$ERR"; then
  ok "the refusal tells the caller how to pass extra curl arguments"
else
  bad "the refusal does not say what to do instead" "err='${ERR:0:160}'"
fi

hdr "8. A body that is not JSON refuses"
# The body slot is declared JSON and gets a Content-Type to match. A caller who
# fat-fingers it should hear about it here rather than from a 422 whose cause
# is three layers away -- and, in the guarded-write case, rather than having
# the guard field silently not exist.
run_tool api PUT /repos/stub-org/repo/pulls/12/merge 'sha=3a9194a0'
if [[ $RC -eq 2 ]]; then
  ok "a non-JSON body is a usage error (exit 2)"
else
  bad "expected exit 2 for a non-JSON body, got $RC" "err='${ERR:0:160}'"
fi
if [[ "$(ncalls)" == "0" ]]; then
  ok "a non-JSON body makes no network call"
else
  bad "the write went out with an unparseable body" "$(ncalls) call(s)"
fi

# --- 9. exit status reflects the API call -------------------------------------
hdr "9. The exit status is the request's, not a stray argument's"
STUB_API_RC=22
run_tool api PUT /repos/stub-org/repo/pulls/12/merge "$BODY_CANARY"
STUB_API_RC=""
if [[ $RC -eq 22 ]]; then
  ok "a failing request propagates curl's exit status"
else
  bad "a failing request exited $RC, expected 22" \
      "an unnoticed failure is how an unguarded write gets reported as success"
fi

# The mirror image, and the one the bug actually produced: a SUCCESSFUL write
# reported as a failure because rc came from a later stray URL.
run_tool api PUT /repos/stub-org/repo/pulls/12/merge "$BODY_CANARY"
if [[ $RC -eq 0 ]]; then
  ok "a succeeding request exits 0 even with a body present"
else
  bad "a successful write reported failure (exit $RC)" \
      "this is the TOG-305 symptom: rc came from something other than the request"
fi

# --- 10. HTTP refusal is failure, with the body intact ------------------------
hdr "10. An HTTP error is not success, and its body is not discarded"
HTTP_BODY='{"message":"Head branch was modified. Review and try the merge again.","status":"409"}'
STUB_API_STATUS=409
STUB_API_BODY="$HTTP_BODY"
run_tool api PUT /repos/stub-org/repo/pulls/12/merge "$BODY_CANARY"
STUB_API_STATUS=""
STUB_API_BODY=""
if [[ $RC -eq 22 ]]; then
  ok "HTTP 409 exits 22, distinct from a transport failure"
else
  bad "HTTP 409 exited $RC, expected 22" \
      "a refused write still looks successful, or is indistinguishable from transport failure"
fi
if [[ "$OUT" == "$HTTP_BODY" ]]; then
  ok "HTTP 409 response body is still printed in full"
else
  bad "HTTP 409 body was lost or changed" "got='${OUT:-<empty>}'"
fi

# Assert the pair in the literal caller pattern from the finding. Either half
# alone is passed by a bug: non-zero with no body destroys the diagnosis, while
# a body with exit 0 still takes && and claims the write landed.
used="$(env -i PATH="$TMP/bin:$PATH" HOME="$TMP" TMPDIR="$TMP/tooltmp" \
  GITHUB_APP_PEM="$TMP/fake-key.pem" GITHUB_APP_ENV="$TMP/fake.env" \
  STUB_DIR="$STUB_DIR" STUB_MINT_CANARY="$MINT_CANARY" \
  STUB_API_STATUS=409 STUB_API_BODY="$HTTP_BODY" \
  bash -c 'out="$("$0" api PUT /repos/stub-org/repo/pulls/12/merge "$1")"; rc=$?; printf "RC=%s\nBODY=%s\n" "$rc" "$out"; [[ $rc -eq 0 ]] && printf "MERGED\n"' \
  "$TOOL" "$BODY_CANARY" 2>"$TMP/caller-stderr")"
if [[ "$used" == "RC=22"$'\n'"BODY=$HTTP_BODY" ]]; then
  ok "the caller sees the refusal body and does not take the success branch"
else
  bad "the composed caller contract broke" "got='${used:0:240}'"
fi

# curl-level HTTP semantics belong only to the public api arm. app_api's three
# existing callers deliberately keep their body-parsing messages; routing them
# through the new wrapper would replace those messages with a generic failure.
hdr "11. check / token / meta keep their established error messages"
STUB_MINT_FAILS=1
run_tool token
STUB_MINT_FAILS=""
if grep -qF 'ERROR minting token:' <<<"$ERR" && grep -qF 'stub refuses to mint' <<<"$ERR"; then
  ok "token still prints GitHub's mint failure message"
else
  bad "token's mint failure message changed" "stderr='${ERR:0:240}'"
fi

STUB_APP_FAILS=1
run_tool check
STUB_APP_FAILS=""
if grep -qF 'ERROR: check: /app did not answer with an app: stub refuses app check' <<<"$ERR"; then
  ok "check still prints the response-body validation message"
else
  bad "check's API error message changed" "stderr='${ERR:0:240}'"
fi

STUB_MINT_FAILS=1
run_tool meta
STUB_MINT_FAILS=""
if grep -qF 'ERROR: meta: the installation returned no token: stub refuses to mint' <<<"$ERR"; then
  ok "meta still prints the response-body validation message"
else
  bad "meta's mint failure message changed" "stderr='${ERR:0:240}'"
fi

# --- 12. a failed mint must not produce an unauthenticated request ------------
# Adjacent to the same defect and on the same code path: `tok="$(mint_token)"`
# runs mint_token in a command substitution, so its `exit 1` kills only the
# subshell. Without a check, $tok is empty and the request goes out with an
# empty bearer -- another 'the safety step was skipped and nothing said so'.
hdr "12. A failed mint stops the request"
STUB_MINT_FAILS=1
run_tool api PUT /repos/stub-org/repo/pulls/12/merge "$BODY_CANARY"
STUB_MINT_FAILS=""
if [[ $RC -ne 0 ]]; then
  ok "a failed mint exits non-zero"
else
  bad "a failed mint exited 0" "the caller cannot tell the write did not happen"
fi
if [[ "$(ncalls)" == "1" ]]; then
  ok "no request was sent after the mint failed"
else
  # A bearer file holding a single blank line is the tell: the header went out
  # as `Authorization: Bearer ` with nothing after it.
  n_empty=0
  for f in "$STUB_DIR"/call.*.bearer; do
    [[ -e "$f" ]] || continue
    [[ -z "$(tr -d '[:space:]' < "$f")" ]] && n_empty=$((n_empty+1))
  done
  bad "the request went out anyway ($(ncalls) calls, $n_empty with an empty bearer)" \
      "an unauthenticated write attempt, from a mint the caller was never told failed"
fi

printf '\n\033[1mRESULT: %d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
