#!/usr/bin/env bash
# Regression suite for gh_token.sh — the dispatch contract. (TOG-201)
#
# THE BUG THIS EXISTS FOR. The catch-all arm of the dispatch case was
#
#   *) sed -n '...' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' | head -n -1 ;;
#
# so an unrecognised subcommand printed usage ON STDOUT and EXITED 0. A caller
# written the ordinary way —
#
#   tok="$(gh_token.sh tokne)" && use_credential "$tok"
#
# took the `&&`, with eleven lines of usage text in $tok. The failure was
# silent at the point it happened and surfaced somewhere unrelated. It is the
# antipattern README.md already names ("assert on exit status, not printed
# output"), and the near neighbour of TOG-193 in gh-app-token.js: same tool
# family, same cause — a catch-all arm doing something other than refusing.
#
# WHY THIS SUITE LOOKS OVERBUILT FOR AN EXIT CODE. Run gh_token.sh with no
# credentials and it dies in the preamble — "cannot read .../github-app.pem",
# exit 1 — BEFORE dispatch is reached. A suite that only checked "non-zero"
# under a bare environment would pass against the very bug it is named after,
# because it would never execute the arm under test. So this suite hands the
# tool a complete, entirely fake credential environment, and proves that
# environment is live with positive controls (section 1): if `token` does not
# mint the canary here, every refusal assertion below is worthless and the
# suite says so.
#
# WHAT IS ASSERTED, per case:
#   exit status   the contract callers actually gate on
#   which stream  usage on stdout is the bug; usage on stderr is the fix. The
#                 caller's `$(...)` captures stdout, so "stdout is empty on a
#                 refusal" IS the user-visible property, asserted directly.
#   no mint       a future "fix" that makes the catch-all fall through to
#                 `token` would satisfy an exit-status check and be far worse
#                 than the bug. The stub curl logs every call.
#   no credential nothing token-shaped or JWT-shaped on either stream.
# Never the wording of the usage text. Message text is not a contract and
# pinning it makes ordinary edits red.
#
# Offline by construction, like test_gh_token_argv.sh and test_gh_app_token.sh:
# a throwaway RSA key generated per run, a fabricated app id, a stub curl that
# never opens a socket, and a token-shaped canary that is not a token. The tool
# runs under `env -i` so an operator's live credentials cannot leak in.
#
# Requires bash, openssl, jq. No node, no network, no /proc.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Same override name as test_gh_token_argv.sh, so the CI mutation guard can
# point either suite at a staged copy the same way.
TOOL="${GH_TOKEN_SH:-$HERE/gh_token.sh}"
PASS=0; FAIL=0

ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

for dep in openssl jq; do
  command -v "$dep" >/dev/null 2>&1 || { echo "test_gh_token_dispatch: $dep is required" >&2; exit 2; }
done
[[ -r "$TOOL" ]] || { echo "test_gh_token_dispatch: cannot read $TOOL" >&2; exit 2; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- what a credential looks like ---------------------------------------------
# Assembled from fragments so the literal canary never appears in this file as
# a whole string: CI greps tracked files for exactly this shape, and a suite
# that trips the repo's own secret scan is a suite people disable.
TOK_PRE="gh""s_"
MINT_CANARY="${TOK_PRE}DISPATCHCANARY00000000000000000DD"
TOKEN_MATCHER='(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})'
JWT_MATCHER='eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{20,}'

# --- fake credential environment ----------------------------------------------
openssl genrsa -out "$TMP/fake-key.pem" 2048 >/dev/null 2>&1 \
  || { echo "test_gh_token_dispatch: could not generate a test key" >&2; exit 2; }
chmod 600 "$TMP/fake-key.pem"
cat > "$TMP/fake.env" <<'ENVF'
GITHUB_APP_ID=000000
GITHUB_APP_INSTALLATION_ID=99999999
GITHUB_ORG=stub-org
ENVF
chmod 600 "$TMP/fake.env"

# An empty directory, used for the "help must not need credentials" case. Not
# a missing path: a missing $HOME/secure-drop and an empty one reach the same
# preamble failure, and the empty one cannot be confused with a typo.
mkdir -p "$TMP/no-creds"

# --- stub curl ----------------------------------------------------------------
# Logs every call and answers plausibly enough that gh_token.sh runs to
# completion. Deliberately permissive: a regressed tool must SUCCEED in minting
# here so the suite catches it, rather than erroring out and looking like the
# refusal we are trying to prove.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/curl" <<'STUBCURL'
#!/usr/bin/env bash
cfg=""; prev=""
for a in "$@"; do
  case "$prev" in --config|-K) cfg="$a" ;; esac
  prev="$a"
done
url=""
if [ -n "$cfg" ]; then
  url="$(sed -n 's/^url = "\(.*\)"$/\1/p' "$cfg")"
else
  for a in "$@"; do case "$a" in http://*|https://*) url="$a" ;; esac; done
fi
case "$url" in
  */access_tokens) printf 'ACCESS_TOKENS\t%s\n' "$url" >> "$STUB_REQLOG" ;;
  *)               printf 'OTHER\t%s\n' "$url" >> "$STUB_REQLOG" ;;
esac
# GitHub answers a rejected request with HTTP 200-shaped JSON as far as curl is
# concerned — curl succeeds, the body is an error object. That is the `check`
# failure mode of TOG-331: no pipeline in the chain returns non-zero.
if [ -n "${STUB_ERROR_BODY:-}" ]; then
  printf '{"message":"Bad credentials","documentation_url":"https://docs.github.com/rest"}\n'
  exit 0
fi
case "$url" in
  */access_tokens)
    printf '{"token":"%s","expires_at":"2099-01-01T00:00:00Z","permissions":{"contents":"write","organization_administration":"write"},"repository_selection":"all"}\n' "$STUB_MINT_CANARY"
    ;;
  */app)                 printf '{"name":"stub","slug":"stub-app","id":1,"owner":{"login":"stub"}}\n' ;;
  */app/installations/*) printf '{"account":{"login":"stub"},"repository_selection":"all","events":[],"permissions":{"contents":"write"}}\n' ;;
  *)                     printf '{"ok":true}\n' ;;
esac
STUBCURL
chmod +x "$TMP/bin/curl"

REQLOG="$TMP/requests.log"
: > "$REQLOG"
mint_count() { grep -c '^ACCESS_TOKENS' "$REQLOG" 2>/dev/null || true; }

# When set, the stub answers every call with an error object instead of a
# plausible body. Section 6 uses it for the `check` arm. Empty by default.
STUB_ERROR_BODY=""

# --- stub openssl: signing fails, everything else does not (TOG-331) ----------
# The reported bug is a PEM that is READABLE but unusable — truncated, in the
# wrong format, or a key this OpenSSL build will not load. In that state
# `openssl base64` keeps working and only `dgst -sign` fails, which is exactly
# what makes the bug reachable: the header and payload encode cleanly, the
# signature comes back empty, and the JWT is emitted with a trailing dot.
#
# So these stubs delegate to the REAL openssl for everything and intercept only
# `-sign`. A stub that failed unconditionally would break b64url too, the tool
# would die at the header/payload guard, and the suite would go green having
# tested a different line. Section 6 asserts that specificity before using them.
#
# Two variants, because they fail differently and only one is caught by status:
#   bin-badsign     -sign exits non-zero        pipefail sees it
#   bin-silentsign  -sign exits 0, writes nothing   pipefail sees 0 all the way
# The second is why `[[ -n "$sig" ]]` exists alongside the `||` in app_jwt.
REAL_OPENSSL="$(command -v openssl)"
export REAL_OPENSSL
mkdir -p "$TMP/bin-badsign" "$TMP/bin-silentsign"
cat > "$TMP/bin-badsign/openssl" <<'STUBSSL'
#!/usr/bin/env bash
for a in "$@"; do
  if [ "$a" = "-sign" ]; then
    echo "openssl: unable to load key (test stub)" >&2
    exit 1
  fi
done
exec "$REAL_OPENSSL" "$@"
STUBSSL
cat > "$TMP/bin-silentsign/openssl" <<'STUBSSL'
#!/usr/bin/env bash
for a in "$@"; do
  if [ "$a" = "-sign" ]; then exit 0; fi
done
exec "$REAL_OPENSSL" "$@"
STUBSSL
chmod +x "$TMP/bin-badsign/openssl" "$TMP/bin-silentsign/openssl"

# --- runner -------------------------------------------------------------------
# `env -i` is the safety property, not tidiness. With a real GITHUB_APP_PEM
# readable and an inherited environment, a regressed tool would mint a REAL
# token while the suite ran.
RC=0; OUT=""; ERR=""; MINTS=0
run_tool() { # run_tool [--no-creds] [--bin <dir>] <args...>
  local creds="$TMP" prefix=""
  while :; do
    case "${1:-}" in
      --no-creds) creds="$TMP/no-creds"; shift ;;
      --bin)      prefix="$2:"; shift 2 ;;
      *)          break ;;
    esac
  done
  local before after
  before="$(mint_count)"
  OUT="$(env -i \
    PATH="$prefix$TMP/bin:$PATH" \
    HOME="$TMP" \
    TMPDIR="$TMP" \
    GITHUB_APP_PEM="$creds/fake-key.pem" \
    GITHUB_APP_ENV="$creds/fake.env" \
    STUB_REQLOG="$REQLOG" \
    STUB_MINT_CANARY="$MINT_CANARY" \
    STUB_ERROR_BODY="$STUB_ERROR_BODY" \
    REAL_OPENSSL="$REAL_OPENSSL" \
    bash "$TOOL" "$@" 2>"$TMP/stderr")"
  RC=$?
  ERR="$(cat "$TMP/stderr")"
  after="$(mint_count)"
  MINTS=$(( ${after:-0} - ${before:-0} ))
}

no_credential_emitted() { # no_credential_emitted <desc>
  local desc="$1"
  if grep -qE "$TOKEN_MATCHER" <<<"$OUT$ERR"; then
    bad "$desc: emitted something token-shaped"
  elif grep -qE "$JWT_MATCHER" <<<"$OUT$ERR"; then
    bad "$desc: emitted something JWT-shaped"
  else
    ok "$desc: no credential on either stream"
  fi
}

# must_refuse <desc> <args...>
# The four assertions of a refusal. Each catches a different regression, and
# the stdout one is the bug this suite is named for.
must_refuse() {
  local desc="$1"; shift
  run_tool "$@"
  [[ $RC -ne 0 ]] \
    && ok "$desc: non-zero exit ($RC)" \
    || bad "$desc: EXITED 0 — this is the TOG-201 regression; a caller's \`&&\` would proceed"
  [[ -z "$OUT" ]] \
    && ok "$desc: stdout empty, so \$(...) captures nothing usable" \
    || bad "$desc: WROTE $(wc -l <<<"$OUT") lines to stdout — a caller would use them as a credential"
  [[ -n "$ERR" ]] \
    && ok "$desc: said why, on stderr" \
    || bad "$desc: refused silently — nothing on stderr"
  [[ "$MINTS" -eq 0 ]] \
    && ok "$desc: did not ask GitHub for a token" \
    || bad "$desc: MINTED — an unrecognised argument reached the token path"
  no_credential_emitted "$desc"
}

# must_help <desc> [--no-creds] <args...>
must_help() {
  local desc="$1"; shift
  run_tool "$@"
  [[ $RC -eq 0 ]] \
    && ok "$desc: exit 0" \
    || bad "$desc: expected exit 0, got $RC"
  [[ -n "$OUT" ]] \
    && ok "$desc: usage on stdout" \
    || bad "$desc: nothing on stdout — asking for help must answer on stdout"
  [[ "$MINTS" -eq 0 ]] \
    && ok "$desc: did not ask GitHub for a token" \
    || bad "$desc: MINTED while printing help — this is exactly TOG-193"
  no_credential_emitted "$desc"
}

printf '\033[1mgh_token.sh dispatch contract (TOG-201)\033[0m\n'
printf 'tool: %s\n' "$TOOL"

# ------------------------------------------------------------------------------
hdr "1. Positive controls: the fake credential environment is LIVE"
# Without these, every refusal below could be passing because the tool died in
# the preamble having never reached the dispatch case at all. This is the
# section that makes the rest of the suite mean something.
run_tool token
if [[ $RC -eq 0 ]] && [[ "$OUT" == "$MINT_CANARY" ]] && [[ "$MINTS" -eq 1 ]]; then
  ok "\`token\` mints through the stub: the credential environment is real"
else
  bad "\`token\` did not mint (rc=$RC mints=$MINTS) — the fixture is broken, every refusal below is unattributable"
  printf '        stderr: %s\n' "$(head -2 <<<"$ERR")"
fi

run_tool meta
[[ $RC -eq 0 && "$MINTS" -eq 1 ]] \
  && ok "\`meta\` still reaches the API and exits 0" \
  || bad "\`meta\` regressed (rc=$RC mints=$MINTS)"

run_tool jwt
if [[ $RC -eq 0 ]] && grep -qE "$JWT_MATCHER" <<<"$OUT"; then
  ok "\`jwt\` still signs and exits 0"
else
  bad "\`jwt\` regressed (rc=$RC)"
fi

run_tool check
[[ $RC -eq 0 ]] \
  && ok "\`check\` still exits 0" \
  || bad "\`check\` regressed (rc=$RC)"

# ------------------------------------------------------------------------------
hdr "2. An unrecognised subcommand must REFUSE, not print usage and succeed"
must_refuse "near-miss 'tokne'"                 tokne
must_refuse "near-miss 'chek'"                  chek
must_refuse "wrong case 'TOKEN'"                TOKEN
must_refuse "plural 'tokens'"                   tokens
must_refuse "no subcommand at all"
# A flag in the subcommand slot is the plausible operator mistake, not a
# strawman: every other tool in this repo takes --repos/--permissions.
must_refuse "--repos in the subcommand slot"    --repos foo
must_refuse "--permissions in the slot"         --permissions contents=read
must_refuse "--version"                         --version
# `api` with a recognised name but a missing operand is a different arm and is
# NOT asserted here: it exits non-zero already, via ${1:?method}.

hdr "3. Fuzz: subcommands nobody thought to allowlist"
for i in 1 2 3 4 5; do
  arg="$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  must_refuse "random subcommand '$arg' (#$i)" "$arg"
done

# ------------------------------------------------------------------------------
hdr "4. Explicit help still succeeds, on stdout, matching gh-app-token.js"
must_help "help"     help
must_help "--help"   --help
must_help "-h"       -h
# The other half of the fix: help is answered ABOVE the credential preamble.
# Before TOG-201 this printed "cannot read .../github-app.pem" and exited 1 —
# a fresh box could not find out how to use the tool that sets it up.
must_help "help with NO credentials present"   --no-creds help
must_help "--help with NO credentials present" --no-creds --help

# ------------------------------------------------------------------------------
hdr "5. The caller pattern from the bug report, run literally"
# Not a restatement of section 2: this asserts the composed behaviour a caller
# actually writes, so a regression that satisfies each assertion separately but
# breaks the idiom still goes red.
used="$(env -i PATH="$TMP/bin:$PATH" HOME="$TMP" TMPDIR="$TMP" \
  GITHUB_APP_PEM="$TMP/fake-key.pem" GITHUB_APP_ENV="$TMP/fake.env" \
  STUB_REQLOG="$REQLOG" STUB_MINT_CANARY="$MINT_CANARY" \
  bash -c 'tok="$("$0" tokne 2>/dev/null)" && printf "USED[%s]" "$tok"' "$TOOL")"
[[ -z "$used" ]] \
  && ok 'tok="$(gh_token.sh tokne)" && use "$tok" — the && is not taken' \
  || bad "the caller proceeded with: $(head -c 120 <<<"$used")"

# The same idiom against the REAL subcommand must still work, or the fix has
# broken every caller instead of just the mistaken ones.
used="$(env -i PATH="$TMP/bin:$PATH" HOME="$TMP" TMPDIR="$TMP" \
  GITHUB_APP_PEM="$TMP/fake-key.pem" GITHUB_APP_ENV="$TMP/fake.env" \
  STUB_REQLOG="$REQLOG" STUB_MINT_CANARY="$MINT_CANARY" \
  bash -c 'tok="$("$0" token 2>/dev/null)" && printf "USED[%s]" "$tok"' "$TOOL")"
[[ "$used" == "USED[$MINT_CANARY]" ]] \
  && ok 'tok="$(gh_token.sh token)" && use "$tok" — still works' \
  || bad "the real minting idiom broke: got [$(head -c 60 <<<"$used")]"

# ------------------------------------------------------------------------------
hdr "6. A PARTIAL failure must not exit 0 either (TOG-331)"
# Sections 2-5 cover the total failure: the wrong subcommand. This section
# covers the one TOG-201 explicitly left open — the RIGHT subcommand, reached,
# doing its work badly. `jwt) app_jwt; echo ;;` returned echo's status, which
# is 0 whatever happened above it, and app_jwt could not report a failed
# signature anyway. So a readable-but-unusable PEM produced a JWT with an empty
# signature, exit 0, and an operator debugging GitHub's 401 as a permissions
# problem. Low severity — an unsigned JWT mints nothing — but it aimed the
# reader at the wrong subsystem, which is the same cost as TOG-193 and TOG-201.

# The fixture, before anything depends on it. "openssl fails" could mean "there
# is no openssl at all", which breaks b64url too — the tool would then die at
# the header/payload guard and every assertion below would pass while testing a
# line other than the reported one. Assert the stub is specific to signing.
if printf 'x' | "$TMP/bin-badsign/openssl" base64 -A >/dev/null 2>&1 \
   && ! printf 'x' | "$TMP/bin-badsign/openssl" dgst -sha256 -sign "$TMP/fake-key.pem" -binary >/dev/null 2>&1; then
  ok "fixture: the stub openssl still encodes, and refuses only to sign"
else
  bad "fixture: the failing-openssl stub is not specific to signing — section 6 is testing the wrong guard"
fi
# And the paired control: the same stub must leave a real signature alone, or
# "signing failed" below could just be "this key never worked".
if printf 'x' | openssl dgst -sha256 -sign "$TMP/fake-key.pem" -binary >/dev/null 2>&1; then
  ok "fixture: the throwaway key does sign under an unstubbed openssl"
else
  bad "fixture: the throwaway key cannot sign at all — section 6 proves nothing"
fi

# must_fail_signing <desc> <bin-dir> <args...>
must_fail_signing() {
  local desc="$1" bin="$2"; shift 2
  run_tool --bin "$bin" "$@"
  [[ $RC -ne 0 ]] \
    && ok "$desc: non-zero exit ($RC)" \
    || bad "$desc: EXITED 0 with signing broken — this is the TOG-331 regression; a caller's \`&&\` would proceed"
  [[ -z "$OUT" ]] \
    && ok "$desc: stdout empty, so \$(...) captures no half-signed JWT" \
    || bad "$desc: WROTE to stdout: [$(head -c 90 <<<"$OUT")]"
  [[ -n "$ERR" ]] \
    && ok "$desc: said why, on stderr" \
    || bad "$desc: failed silently — nothing on stderr, so there is nothing to debug from"
  [[ "$MINTS" -eq 0 ]] \
    && ok "$desc: did not ask GitHub for a token" \
    || bad "$desc: MINTED — an unsigned JWT was sent to GitHub anyway"
  no_credential_emitted "$desc"
}

must_fail_signing "jwt, openssl -sign fails"           "$TMP/bin-badsign"    jwt
# The variant a status check alone cannot catch: -sign exits 0 and writes
# nothing, so pipefail sees success down the whole pipeline and $sig is empty.
must_fail_signing "jwt, openssl -sign silently empty"  "$TMP/bin-silentsign" jwt
# Everything authenticated goes through app_jwt. If the failure stops at the
# function boundary, these arms send an empty bearer and GitHub's 401 sends the
# reader to the App's install settings instead of to the key.
must_fail_signing "check, signing broken"              "$TMP/bin-badsign"    check
must_fail_signing "token, signing broken"              "$TMP/bin-badsign"    token
must_fail_signing "meta, signing broken"               "$TMP/bin-badsign"    meta
# `api` is the one where the guard is least visible in the source: mint_token's
# failure path is `exit 1`, but it runs inside `tok="$(mint_token)"`, so that
# exit ends the SUBSHELL. Without a check on the assignment the arm proceeds
# with an empty bearer.
must_fail_signing "api, signing broken"                "$TMP/bin-badsign"    api GET /app

# The literal idiom from the bug report.
used="$(env -i PATH="$TMP/bin-badsign:$TMP/bin:$PATH" HOME="$TMP" TMPDIR="$TMP" \
  GITHUB_APP_PEM="$TMP/fake-key.pem" GITHUB_APP_ENV="$TMP/fake.env" \
  STUB_REQLOG="$REQLOG" STUB_MINT_CANARY="$MINT_CANARY" REAL_OPENSSL="$REAL_OPENSSL" \
  bash -c 'jwt="$("$0" jwt 2>/dev/null)" && printf "USED[%s]" "$jwt"' "$TOOL")"
[[ -z "$used" ]] \
  && ok 'jwt="$(gh_token.sh jwt)" && curl -H "Bearer $jwt" — the && is not taken' \
  || bad "the caller proceeded with an unsigned JWT: $(head -c 120 <<<"$used")"

# The `check` half. Nothing here fails at the process level: curl succeeds and
# GitHub answers an error OBJECT, so `app_api ... | jq -r '...'` exited 0 and
# printed a heading with an empty line under it. `gh_token.sh check && echo ok`
# said ok while the report had answered nothing.
STUB_ERROR_BODY=1
run_tool check
STUB_ERROR_BODY=""
[[ $RC -ne 0 ]] \
  && ok "check: an API error body exits non-zero ($RC)" \
  || bad 'check: EXITED 0 on {"message":"Bad credentials"} — a report that answered nothing looked clean'
[[ -z "$OUT" ]] \
  && ok "check: printed no report it could not stand behind" \
  || bad "check: printed a report anyway: [$(head -c 90 <<<"$OUT")]"
[[ -n "$ERR" ]] \
  && ok "check: said why, on stderr" \
  || bad "check: reported the failure nowhere"

printf '\n\033[1mRESULT: %d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
