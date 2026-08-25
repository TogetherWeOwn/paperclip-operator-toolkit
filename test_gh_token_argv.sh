#!/usr/bin/env bash
# Regression suite for gh_token.sh — credentials must never reach argv.
#
# THE BUG THIS EXISTS FOR (TOG-200). gh_token.sh invoked curl as
# `curl -sS -X GET url -H "Authorization: Bearer $tok" ...` in two places:
# app_api() with the App JWT, and the `api` subcommand with a live
# installation token minted at the App's full ceiling. /proc/<pid>/cmdline is
# world-readable and every company on this box shares the host, so any local
# process could read either credential for the lifetime of the curl call by
# polling /proc. No exploit, no log entry. README.md already forbade exactly
# this. gh_token.sh now writes the header into a 0600 `curl --config` file.
#
# WHY THIS IS HARDER THAN IT LOOKS. Two traps a naive suite falls into:
#
#   Deleting the Authorization header entirely would pass "no token in argv"
#   with full marks. So every no-leak assertion is paired with a positive
#   assertion that the credential DID reach curl, by the config file.
#
#   Grepping the source for `-H "Authorization` proves nothing about what the
#   process actually executed — a helper, an array, an eval, or a future
#   rewrite all defeat it. So this suite asserts on the kernel's own record:
#   a stub `curl` on PATH reads its own /proc/<pid>/cmdline, which is byte for
#   byte what a snooping neighbour would have read.
#
# The stub reads /proc/$$/cmdline, not /proc/self/cmdline. `< /proc/self/...`
# inside the stub is opened by a forked child that is about to exec `tr`, so
# self would resolve to tr's argv, not the stub's, and the suite would pass
# for the wrong reason. $$ is this shell's own pid, resolved before the fork.
#
# Offline by construction, like test_gh_app_token.sh. Nothing here is real: a
# throwaway RSA key generated per run, a fabricated app id, a stub curl that
# never opens a socket, and token-shaped canaries that are not tokens. The
# tool runs under `env -i` so an operator's live credentials cannot leak in.
#
# Requires bash, openssl, jq, and /proc. No node, no network.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${GH_TOKEN_SH:-$HERE/gh_token.sh}"
PASS=0; FAIL=0

ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

for dep in openssl jq; do
  command -v "$dep" >/dev/null 2>&1 || { echo "test_gh_token_argv: $dep is required" >&2; exit 2; }
done
[[ -r /proc/$$/cmdline ]] || { echo "test_gh_token_argv: needs a Linux /proc" >&2; exit 2; }
[[ -x "$TOOL" ]] || { echo "test_gh_token_argv: $TOOL is not executable" >&2; exit 2; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- what "a credential" looks like -------------------------------------------
# Assembled from fragments so the literal canary never appears in this file as
# a whole string: CI greps tracked files for exactly this shape, and a suite
# that trips the repo's own secret scan is a suite people disable.
TOK_PRE="gh""s_"
MINT_CANARY="${TOK_PRE}ARGVLEAKCANARY00000000000000000CC"
# Two matchers, because this script handles two different credentials and a
# fix that covered only the installation token would still expose the App JWT
# — which is worse, since a JWT mints tokens.
TOKEN_MATCHER='(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})'
JWT_MATCHER='eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{20,}'

# --- fake credential environment ----------------------------------------------
openssl genrsa -out "$TMP/fake-key.pem" 2048 >/dev/null 2>&1 \
  || { echo "test_gh_token_argv: could not generate a test key" >&2; exit 2; }
chmod 600 "$TMP/fake-key.pem"
cat > "$TMP/fake.env" <<'ENVF'
GITHUB_APP_ID=000000
GITHUB_APP_INSTALLATION_ID=99999999
GITHUB_ORG=stub-org
ENVF
chmod 600 "$TMP/fake.env"

# --- stub curl ----------------------------------------------------------------
# Three jobs: record the argv the kernel sees, record what arrived by config
# file instead, and answer plausibly enough that gh_token.sh runs to completion.
# It is deliberately permissive — a regressed tool must SUCCEED here so the
# suite catches the leak, rather than erroring out and looking like a refusal.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/curl" <<'STUBCURL'
#!/usr/bin/env bash
# $$ not self: see the header of test_gh_token_argv.sh.
{ tr '\0' '\n' < "/proc/$$/cmdline"; printf -- '--END-ARGV--\n'; } >> "$STUB_CMDLOG"

cfg=""; prev=""
for a in "$@"; do
  case "$prev" in --config|-K) cfg="$a" ;; esac
  prev="$a"
done

url=""
if [ -n "$cfg" ]; then
  printf '%s\t%s\n' "$(stat -c '%a' "$cfg")" "$cfg" >> "$STUB_CFGLOG"
  # How many config files exist RIGHT NOW. A subcommand making several calls
  # must never have more than the in-flight one on disk: the file's lifetime
  # is the call, not the process.
  printf 'CFGCOUNT\t%s\n' \
    "$(find "$(dirname "$cfg")" -maxdepth 1 -name 'curlcfg.*' | wc -l)" >> "$STUB_CFGLOG"
  grep -q '^header = "Authorization: Bearer .' "$cfg" && printf 'AUTHED\n' >> "$STUB_CFGLOG"
  # The credential the tool believes it is sending, so the suite can prove the
  # config path carries the real thing and not a placeholder.
  sed -n 's/^header = "Authorization: Bearer \(.*\)"$/BEARER\t\1/p' "$cfg" >> "$STUB_CFGLOG"
  url="$(sed -n 's/^url = "\(.*\)"$/\1/p' "$cfg")"
  sed -n 's/^data-binary = "\(.*\)"$/BODY\t\1/p' "$cfg" >> "$STUB_CFGLOG"
else
  for a in "$@"; do case "$a" in http://*|https://*) url="$a" ;; esac; done
fi
printf 'URL\t%s\n' "$url" >> "$STUB_CFGLOG"

# STUB_MINT_FAILS drives the failure-path cleanup test: an error body makes
# mint_token exit 1 in the middle of the call, config file still on disk.
#
# STUB_KILL_PARENT drives the harsher one. $PPID here is the command
# substitution subshell running curl_authed — the frame whose traps are reset
# to their defaults and whose local $cfg no other frame can see. SIGTERM to it
# is what ^C during a mint looks like from the config file's point of view.
case "$url" in
  */access_tokens)
    if [ -n "${STUB_KILL_PARENT:-}" ]; then
      kill -TERM "$PPID" 2>/dev/null
      sleep 0.5
      exit 1
    fi
    if [ -n "${STUB_MINT_FAILS:-}" ]; then
      printf '{"message":"stub refuses to mint"}\n'
    else
      printf '{"token":"%s","expires_at":"2099-01-01T00:00:00Z","permissions":{"contents":"write","organization_administration":"write"},"repository_selection":"all"}\n' "$STUB_MINT_CANARY"
    fi
    ;;
  */app)                  printf '{"name":"stub","slug":"stub-app","id":1,"owner":{"login":"stub"}}\n' ;;
  */app/installations/*)  printf '{"account":{"login":"stub"},"repository_selection":"all","events":[],"permissions":{"contents":"write"}}\n' ;;
  *)                      printf '{"ok":true}\n' ;;
esac
STUBCURL
chmod +x "$TMP/bin/curl"

CMDLOG="$TMP/cmdline.log"
CFGLOG="$TMP/config.log"

# --- runner -------------------------------------------------------------------
# `env -i` is the safety property, not tidiness. With a real GITHUB_APP_PEM
# readable and an inherited environment, a regressed tool would mint a REAL
# token while the suite ran, and then leak it into $CMDLOG on disk.
#
# TOOLTMP is the tool's TMPDIR and nothing else's, so "did it leave anything
# behind" is a plain `is this directory empty` with no allow-list to keep in
# sync — and it catches a leftover under ANY name, including one from a future
# rewrite that stops using the current gh_token.curlcfg.* convention.
TOOLTMP="$TMP/tooltmp"
leftovers() { find "$TOOLTMP" -mindepth 1 2>/dev/null; }

RC=0; OUT=""; ERR=""
run_tool() {
  : > "$CMDLOG"; : > "$CFGLOG"
  rm -rf "$TOOLTMP"; mkdir -p "$TOOLTMP"
  OUT="$(env -i \
    PATH="$TMP/bin:$PATH" \
    HOME="$TMP" \
    TMPDIR="$TOOLTMP" \
    GITHUB_APP_PEM="$TMP/fake-key.pem" \
    GITHUB_APP_ENV="$TMP/fake.env" \
    STUB_CMDLOG="$CMDLOG" \
    STUB_CFGLOG="$CFGLOG" \
    STUB_MINT_CANARY="$MINT_CANARY" \
    ${STUB_MINT_FAILS:+STUB_MINT_FAILS=1} \
    ${STUB_KILL_PARENT:+STUB_KILL_PARENT=1} \
    bash "$TOOL" "$@" 2>"$TMP/stderr")"
  RC=$?
  ERR="$(cat "$TMP/stderr")"
}
STUB_MINT_FAILS=""
STUB_KILL_PARENT=""

# no_creds_in_argv <desc> — the core assertion, run against $CMDLOG.
no_creds_in_argv() {
  local desc="$1" hits=0
  if grep -qE "$TOKEN_MATCHER" "$CMDLOG"; then
    bad "$desc: an installation-token-shaped string reached curl's argv"
    grep -oE "$TOKEN_MATCHER" "$CMDLOG" | sed 's/^/        leaked: /' | sort -u | head -3
    hits=1
  fi
  if grep -qE "$JWT_MATCHER" "$CMDLOG"; then
    bad "$desc: an App JWT reached curl's argv"
    hits=1
  fi
  # The PEM itself has never been on argv here, but assert it anyway: the
  # cheapest way to regress this whole class is to start passing key material
  # to a helper "just for a moment".
  if grep -q 'PRIVATE KEY' "$CMDLOG"; then
    bad "$desc: private key material reached curl's argv"
    hits=1
  fi
  [[ $hits -eq 0 ]] && ok "$desc: no credential in /proc/<curl>/cmdline"
}

# credential_did_arrive <desc> — the paired assertion. Without this, deleting
# the Authorization header would score a perfect no-leak result.
credential_did_arrive() {
  local desc="$1" want="$2"
  if ! grep -q '^AUTHED$' "$CFGLOG"; then
    if grep -q '^Authorization: Bearer' "$CMDLOG"; then
      bad "$desc: the credential reached curl on argv instead of by config file"
    else
      bad "$desc: no Authorization header reached curl at all — the tool is now unauthenticated, not fixed"
    fi
    return
  fi
  case "$want" in
    jwt)
      if grep -E "^BEARER\s" "$CFGLOG" | grep -qE "$JWT_MATCHER"; then
        ok "$desc: the App JWT reached curl by config file"
      else
        bad "$desc: the bearer in the config file is not a JWT — is the tool sending a placeholder?"
      fi ;;
    token)
      if grep -qF "$MINT_CANARY" "$CFGLOG"; then
        ok "$desc: the installation token reached curl by config file"
      else
        bad "$desc: the minted token never reached curl"
      fi ;;
  esac
}

# --- 0. positive controls: prove the detector can fail -------------------------
# A suite whose only tool is `grep -q` on a log needs to demonstrate that the
# grep fires. Both canaries are pushed through the real stub, on argv, exactly
# as the pre-fix gh_token.sh did it.
hdr "0. Positive controls — the detector must catch a real argv leak"
: > "$CMDLOG"; : > "$CFGLOG"
STUB_CMDLOG="$CMDLOG" STUB_CFGLOG="$CFGLOG" STUB_MINT_CANARY="$MINT_CANARY" \
  "$TMP/bin/curl" -sS -X GET https://api.github.com/x \
  -H "Authorization: Bearer $MINT_CANARY" >/dev/null 2>&1
if grep -qE "$TOKEN_MATCHER" "$CMDLOG"; then
  ok "an argv-borne installation token IS detected"
else
  bad "detector is blind: a token on argv was not seen in /proc — every other result in this run is meaningless"
fi

: > "$CMDLOG"; : > "$CFGLOG"
FAKE_JWT="eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpYXQiOjEsImV4cCI6Mn0.$(head -c 48 /dev/zero | tr '\0' 'A')"
STUB_CMDLOG="$CMDLOG" STUB_CFGLOG="$CFGLOG" STUB_MINT_CANARY="$MINT_CANARY" \
  "$TMP/bin/curl" -sS https://api.github.com/x -H "Authorization: Bearer $FAKE_JWT" >/dev/null 2>&1
if grep -qE "$JWT_MATCHER" "$CMDLOG"; then
  ok "an argv-borne App JWT IS detected"
else
  bad "detector is blind to JWTs: the app_api() half of TOG-200 is untested"
fi

# --- 1..4: every subcommand that touches the network --------------------------
hdr "1. 'check' — three JWT-authenticated calls"
run_tool check
[[ $RC -eq 0 ]] && ok "check exits 0 against the stub" || bad "check exited $RC: ${ERR:0:120}"
no_creds_in_argv "check"
credential_did_arrive "check" jwt

hdr "2. 'token' — mints at the ceiling (JWT out, token back)"
run_tool token
if [[ $RC -eq 0 && "$OUT" == "$MINT_CANARY" ]]; then
  ok "token returns the minted canary"
else
  bad "token: rc=$RC out='${OUT:0:24}' err='${ERR:0:120}'"
fi
no_creds_in_argv "token"
credential_did_arrive "token" jwt

hdr "3. 'token --repos/--permissions' — the scoped form, body now in the config"
run_tool token --repos paperclip-ops-tooling --permissions contents=read
if [[ $RC -eq 0 && "$OUT" == "$MINT_CANARY" ]]; then
  ok "scoped token returns the minted canary"
else
  bad "scoped token: rc=$RC out='${OUT:0:24}' err='${ERR:0:120}'"
fi
no_creds_in_argv "token --repos --permissions"
# The request body moved into the config file along with the header. If it were
# dropped or mangled, the scoping flags would silently become no-ops and every
# caller asking for a narrow token would get a ceiling one.
if grep -q 'repositories' "$CFGLOG" && grep -q 'contents' "$CFGLOG"; then
  ok "the scoping body survived the move into the config file"
else
  bad "the --repos/--permissions body did not reach curl — scoping flags are now silent no-ops"
fi

hdr "4. 'api' — the worst case: a live ceiling token on the wire"
run_tool api GET /orgs/stub-org/repos
[[ $RC -eq 0 ]] && ok "api exits 0 against the stub" || bad "api exited $RC: ${ERR:0:120}"
no_creds_in_argv "api"
credential_did_arrive "api" token
# The `api` subcommand forwards the caller's extra curl arguments. Those are
# not credentials and must keep working, or the fix breaks real usage.
#
# They moved behind a literal `--` in TOG-305: argument 3 is now the request
# body, because it used to be read as an extra curl argument and so the body
# never reached the request. See test_gh_token_api_body.sh for that contract;
# what this suite still owns is only that forwarding them leaks no credential.
run_tool api GET /orgs/stub-org/repos -- --max-time 7
if grep -q '^--max-time$' "$CMDLOG" && grep -q '^7$' "$CMDLOG"; then
  ok "caller-supplied curl arguments still reach curl"
else
  bad "api dropped the caller's extra curl arguments"
fi
no_creds_in_argv "api with extra args"

# A request body is not a credential, but it can carry one — a secret value
# being written, a token being rotated. TOG-200's rule is about argv, so the
# body belongs under it too, and this is the suite that reads /proc.
run_tool api PUT /repos/stub-org/repo/pulls/1/merge '{"sha":"deadbeefdeadbeefdeadbeefdeadbeef0000ffff"}'
if grep -q 'deadbeefdeadbeef' "$CMDLOG"; then
  bad "api: the request body reached curl's argv"
else
  ok "api: the request body did not reach curl's argv"
fi
no_creds_in_argv "api with a body"

hdr "5. 'meta'"
run_tool meta
[[ $RC -eq 0 ]] && ok "meta exits 0 against the stub" || bad "meta exited $RC: ${ERR:0:120}"
no_creds_in_argv "meta"
credential_did_arrive "meta" jwt

hdr "6. 'jwt' and usage make no network call at all"
run_tool jwt
if [[ $RC -eq 0 && ! -s "$CMDLOG" ]]; then
  ok "jwt prints locally and never invokes curl"
else
  bad "jwt invoked curl (rc=$RC) — a local-only subcommand is reaching the network"
fi
run_tool --help
[[ ! -s "$CMDLOG" ]] && ok "usage never invokes curl" || bad "usage invoked curl"

# --- 7. the config file itself ------------------------------------------------
hdr "7. The config file is 0600 and does not outlive the call"
run_tool check
modes="$(cut -f1 "$CFGLOG" | grep -E '^[0-7]{3,4}$' | sort -u)"
if [[ -n "$modes" && "$modes" == "600" ]]; then
  ok "every config file was mode 600 while curl held it"
else
  bad "config file modes were '${modes:-none observed}', expected exactly 600"
fi

# `check` makes several authenticated calls. If the config file were only
# removed by the exit trap, the JWT from call one would sit on disk for the
# whole run, so the property is that the MAXIMUM number of config files alive
# at once is 1 — never that some particular number of calls happened.
#
# The `-ge` is only a vacuity guard: with a single call, "max concurrent is 1"
# is true by construction and proves nothing. Two calls is the smallest number
# that can distinguish "removed between calls" from "removed at exit", so two
# is the threshold. It was 3 until TOG-331, when `check` stopped fetching the
# installation body twice — the count is an artefact of how many endpoints
# `check` happens to consult, and pinning the artefact turned a saved API call
# into a red test in a suite about argv.
counts="$(grep '^CFGCOUNT' "$CFGLOG" | cut -f2 | sort -u | tr '\n' ',')"
calls="$(grep -c '^CFGCOUNT' "$CFGLOG")"
if [[ "$calls" -ge 2 && "$counts" == "1," ]]; then
  ok "across $calls calls, only the in-flight config file ever existed"
else
  bad "config files accumulated during the run: $calls calls, concurrent counts seen: ${counts:-none}"
fi

leftover="$(leftovers)"
if [[ -z "$leftover" ]]; then
  ok "no config file or temp directory survived a successful run"
else
  bad "the tool left files in TMPDIR: $(tr '\n' ' ' <<<"$leftover")"
  # A leftover holding a live bearer is the same leak, just slower and on disk.
  grep -rlE "$JWT_MATCHER|$TOKEN_MATCHER" $leftover 2>/dev/null \
    | sed 's/^/        still holds a credential: /'
fi

# The trap, not the happy path. mint_token calls `exit 1` from inside a command
# substitution nested two frames below curl_authed, which is exactly the shape
# where a rm-after-the-call cleanup gets skipped.
STUB_MINT_FAILS=1
run_tool token
STUB_MINT_FAILS=""
if [[ $RC -ne 0 ]]; then
  ok "a failed mint still exits non-zero"
else
  bad "a failed mint exited 0 — unrelated to TOG-200, but it would mask this test"
fi
leftover="$(leftovers)"
if [[ -z "$leftover" ]]; then
  ok "no config file survived a FAILED run"
else
  bad "a failed run left credentials on disk: $(tr '\n' ' ' <<<"$leftover")"
fi

# The subshell case, which is the one a single trap does not cover. mint_token
# calls app_api inside a command substitution, so curl_authed's config file
# path exists only in a subshell — and a subshell resets trapped signals to
# their defaults. Killing curl mid-flight from inside that subshell is the
# closest reproduction of an operator hitting ^C during a mint.
STUB_KILL_PARENT=1
run_tool token
STUB_KILL_PARENT=""
leftover="$(leftovers)"
if [[ -z "$leftover" ]]; then
  ok "nothing survived curl dying inside the mint subshell"
else
  bad "a killed subshell left credentials on disk: $(tr '\n' ' ' <<<"$leftover")"
  grep -rlE "$JWT_MATCHER|$TOKEN_MATCHER" $leftover 2>/dev/null \
    | sed 's/^/        still holds a credential: /'
fi

printf '\n\033[1mRESULT: %d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
