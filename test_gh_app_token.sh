#!/usr/bin/env bash
# Regression suite for gh-app-token.js — the credential minter.
#
# THE BUG THIS EXISTS FOR (2026-08-23). The last statement of main() was an
# unconditional `process.stdout.write((await token()) + '\n')`, so ANY argument
# that fell past the recognised modes minted a live org-admin-capable
# installation token. `gh-app-token.js --help` printed a real credential. It was
# revoked; the helper now refuses unrecognised arguments. Nothing else stops that
# from coming back, so this suite does.
#
# WHY THIS IS HARDER THAN IT LOOKS. Run the tool with no credentials and a
# regressed build dies on "GH_APP_ID is not set" — non-zero exit, no token. A
# suite that only checks the exit code would pass against the very bug it is
# named after. The bug only shows itself when credentials ARE present, which is
# the operator's real shell. So this suite gives the tool a complete, entirely
# fake credential environment and two independent traps:
#
#   TRAP 1 (cache)   A pre-seeded token cache holding a token-shaped canary.
#                    Any code path reaching token() emits it, with no network.
#   TRAP 2 (network) GH_API_URL points at a stub HTTP server on 127.0.0.1 that
#                    mints a second canary and LOGS every request. Any path
#                    reaching mint() is caught even if its output never reaches
#                    stdout — "the tool contacted the API at all" is the real
#                    security property, and it is asserted directly.
#
# Both canaries are token-shaped but fabricated. The RSA key is generated fresh
# per run into a temp dir. Nothing here is real, nothing leaves 127.0.0.1, and
# the tool is invoked under `env -i` so an operator's live GH_APP_PRIVATE_KEY
# cannot leak into a run even if it is exported in the calling shell.
#
# Offline by construction, like test_privilege_ceilings.sh, test_request_queue.sh
# and `omniroute_combo_cli.sh selftest`. Requires node and nothing else.
#
# NO CHANGES TO gh-app-token.js WERE NEEDED. The two seams this suite drives —
# GH_API_URL and GH_APP_TOKEN_CACHE — already existed. They are now load-bearing
# for testing as well as for operation; removing either breaks this suite.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$HERE/gh-app-token.js"
PASS=0; FAIL=0

ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

command -v node >/dev/null 2>&1 || { echo "test_gh_app_token: node is required" >&2; exit 2; }
[[ -x "$TOOL" ]] || { echo "test_gh_app_token: $TOOL is not executable" >&2; exit 2; }

TMP="$(mktemp -d)"
STUB_PID=""
cleanup() {
  [[ -n "$STUB_PID" ]] && kill "$STUB_PID" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

# --- what "token-shaped" means ------------------------------------------------
# Assembled from fragments so the literal canaries never appear in this file as
# whole strings. The CI secret scan greps tracked files for exactly this shape;
# a test suite that trips the repo's own secret scan is a test suite people
# disable. (omniroute_combo_cli.sh splits its own grep pattern for the same
# reason.) The MATCHER below does not match itself, so it needs no splitting.
TOK_PRE="gh""s_"
CACHE_CANARY="${TOK_PRE}CACHECANARY0000000000000000000000AA"
STUB_CANARY="${TOK_PRE}STUBMINTCANARY0000000000000000000BB"
# Every GitHub credential prefix, not just the installation-token one: a
# regression that changed which kind of credential leaks is still a leak.
TOKEN_MATCHER='(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})'

# --- fake credential environment ----------------------------------------------
node -e '
  const c = require("crypto")
  const { privateKey } = c.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  })
  process.stdout.write(privateKey)
' > "$TMP/fake-key.pem" || { echo "test_gh_app_token: could not generate a test key" >&2; exit 2; }
chmod 600 "$TMP/fake-key.pem"
FAKE_PEM="$(cat "$TMP/fake-key.pem")"

# --- stub GitHub API ----------------------------------------------------------
# Records every request, and mints STUB_CANARY for any access_tokens POST. It is
# deliberately permissive: the point is that a regressed tool SUCCEEDS in minting
# so the suite can catch it, rather than erroring out and looking like a refusal.
REQLOG="$TMP/requests.log"
: > "$REQLOG"
cat > "$TMP/stub-api.js" <<'STUB'
const http = require('http')
const fs = require('fs')
const REQLOG = process.env.STUB_REQLOG
const CANARY = process.env.STUB_CANARY
const log = (line) => fs.appendFileSync(REQLOG, line + '\n')
const srv = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    const isMint = req.method === 'POST' && /\/access_tokens$/.test(req.url)
    log(`${isMint ? 'ACCESS_TOKENS' : 'OTHER'} ${req.method} ${req.url} ${JSON.stringify(body)}`)
    res.setHeader('Content-Type', 'application/json')
    if (isMint) {
      res.end(JSON.stringify({
        token: CANARY,
        expires_at: new Date(Date.now() + 3600e3).toISOString(),
        permissions: { metadata: 'read', contents: 'write', organization_administration: 'write' },
        repository_selection: 'all',
      }))
    } else if (/\/app\/installations$/.test(req.url)) {
      res.end(JSON.stringify([{ id: 99999999 }]))
    } else if (/\/installation$/.test(req.url) || /\/app\/installations\/\d+$/.test(req.url)) {
      res.end(JSON.stringify({ id: 99999999, permissions: {}, account: { login: 'stub' } }))
    } else {
      res.end(JSON.stringify({ id: 1, slug: 'stub-app', login: 'stub' }))
    }
  })
})
srv.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(process.env.STUB_PORT_FILE, String(srv.address().port))
})
STUB

STUB_REQLOG="$REQLOG" STUB_CANARY="$STUB_CANARY" STUB_PORT_FILE="$TMP/port" \
  node "$TMP/stub-api.js" & STUB_PID=$!
for _ in $(seq 1 100); do [[ -s "$TMP/port" ]] && break; sleep 0.05; done
PORT="$(cat "$TMP/port" 2>/dev/null)"
[[ -n "$PORT" ]] || { echo "test_gh_app_token: stub API did not start" >&2; exit 2; }
API_URL="http://127.0.0.1:$PORT"

# --- seeded cache -------------------------------------------------------------
# scopeId 'ceiling' and appId must match what the tool computes for an unscoped
# request, or cached() correctly rejects the entry and TRAP 1 never arms. The
# positive controls at the end prove it did.
#
# Since TOG-222 a cache entry is also attributed to the credential that minted
# it (`cred`), and an entry that cannot be attributed to a credential we still
# hold is refused — that is the fix for "unbinding the PEM is not revocation".
# So the fixture has to ask the tool which credential identity it will present
# for THIS fake key rather than hardcoding one. If that ever returns the wrong
# value the entry stops matching, trap 1 fails to arm, and section 0 says so
# loudly instead of the suite quietly losing its leak detector.
CACHE="$TMP/cache.json"
tool_cred() {
  env -i PATH="$PATH" HOME="$TMP" \
    GH_APP_ID="000000" \
    GH_APP_PRIVATE_KEY="$FAKE_PEM" \
    GH_APP_TOKEN_SOURCE="pem" \
    "$TOOL" source 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try { process.stdout.write(JSON.parse(s).credentials[0] || "") } catch { process.stdout.write("") }
    })'
}
CACHE_CRED="$(tool_cred)"
# Deliberately NOT a hard exit. If `source` cannot answer, the fixture is wrong
# and trap 1 will not arm — which section 0 already reports as a FAIL, in the
# suite's own output, where both a human and CI's mutation guard can see it.
# Bailing out with exit 2 here instead would produce a non-zero status and no
# FAIL lines at all, which is precisely the shape the mutation guard cannot
# distinguish from a healthy refusal.
if [[ -z "$CACHE_CRED" ]]; then
  echo "test_gh_app_token: WARNING: 'gh-app-token.js source' reported no credential" >&2
  echo "  fingerprint, so the seeded cache cannot be attributed. Trap 1 will not arm." >&2
  CACHE_CRED="pem:0000000000000000"
fi
seed_cache() { # seed_cache [cred-override]
  node -e '
    const fs = require("fs")
    fs.writeFileSync(process.argv[1], JSON.stringify({
      token: process.argv[2],
      expires_at: new Date(Date.now() + 3600e3).toISOString(),
      cred: process.argv[3] || undefined,
      appId: "000000",
      scopeId: "ceiling",
      scope: {},
      granted: null,
    }), { mode: 0o600 })
  ' "$CACHE" "$CACHE_CANARY" "${1-$CACHE_CRED}"
}
seed_cache
mkdir -p "$TMP/scratch"

# --- runner -------------------------------------------------------------------
# `env -i` is the safety property, not tidiness: with a real GH_APP_PRIVATE_KEY
# exported, an inherited environment plus a regressed build would mint a REAL
# token while running the suite. Nothing is inherited but PATH.
mint_count() { local n; n="$(grep -c 'ACCESS_TOKENS' "$REQLOG" 2>/dev/null)"; echo "${n:-0}"; }

RC=0; OUT=""; ERR=""; MINTS=0
run_tool() { # run_tool [--stdin <text>] <args...>
  local stdin_text=""
  if [[ "${1:-}" == "--stdin" ]]; then stdin_text="$2"; shift 2; fi
  local before after
  before="$(mint_count)"
  OUT="$(printf '%s' "$stdin_text" | env -i \
    PATH="$PATH" \
    HOME="$TMP" \
    GH_API_URL="$API_URL" \
    GH_APP_ID="000000" \
    GH_APP_INSTALL_ID="99999999" \
    GH_APP_PRIVATE_KEY="$FAKE_PEM" \
    GH_APP_TOKEN_CACHE="$CACHE" \
    PAPERCLIP_RUN_SCRATCH_DIR="$TMP/scratch" \
    "$TOOL" "$@" 2>"$TMP/stderr")"
  RC=$?
  ERR="$(cat "$TMP/stderr")"
  after="$(mint_count)"
  MINTS=$(( after - before ))
}

# must_not_mint <desc> <expect_rc: 0|nonzero> [--stdin <text>] <args...>
# Three independent assertions, because each catches a different regression:
#   exit status  - the contract callers gate on
#   no token     - the leak itself, matched by SHAPE not by message text
#   no mint      - the tool must not even ASK GitHub for a credential, which
#                  holds regardless of where a regression sends its output
must_not_mint() {
  local desc="$1" expect="$2"; shift 2
  run_tool "$@"
  if [[ "$expect" == "0" ]]; then
    [[ $RC -eq 0 ]] && ok "$desc: exit 0" || bad "$desc: expected exit 0, got $RC"
  else
    [[ $RC -ne 0 ]] && ok "$desc: non-zero exit" || bad "$desc: expected non-zero exit, got $RC"
  fi

  if grep -qE "$TOKEN_MATCHER" <<<"$OUT$ERR"; then
    bad "$desc: EMITTED SOMETHING TOKEN-SHAPED — this is the TOG-193 regression"
    sed 's/^/        /' <<<"$OUT$ERR" | head -3
  else
    ok "$desc: nothing token-shaped on stdout or stderr"
  fi

  [[ "$MINTS" -eq 0 ]] \
    && ok "$desc: no mint request reached the API" \
    || bad "$desc: issued $MINTS mint request(s) to the API"
}

hdr "0. The traps must be armed (if these fail, nothing below means anything)"
run_tool token
if [[ $RC -eq 0 && "$OUT" == "$CACHE_CANARY" ]]; then
  ok "'token' returns the seeded cache canary — TRAP 1 (cache) is armed"
else
  bad "TRAP 1 NOT ARMED: 'token' returned rc=$RC out='${OUT:0:24}...' — the rest of this suite cannot detect a leak"
fi
run_tool
if [[ $RC -eq 0 && "$OUT" == "$CACHE_CANARY" ]]; then
  ok "no-args mints (documented behaviour) and is caught by TRAP 1"
else
  bad "no-args returned rc=$RC out='${OUT:0:24}...'"
fi
rm -f "$CACHE"
run_tool token
if [[ $RC -eq 0 && "$OUT" == "$STUB_CANARY" && "$MINTS" -eq 1 ]]; then
  ok "with no cache, 'token' mints via the stub API — TRAP 2 (network) is armed"
else
  bad "TRAP 2 NOT ARMED: rc=$RC mints=$MINTS out='${OUT:0:24}...'"
fi
seed_cache
if grep -qE "$TOKEN_MATCHER" <<<"$CACHE_CANARY$STUB_CANARY"; then
  ok "both canaries match the token matcher the assertions use"
else
  bad "canaries do not match TOKEN_MATCHER — every 'no token' assertion is vacuous"
fi

hdr "1. Help must print help, not a credential (the exact 2026-08-23 bug)"
must_not_mint "--help" 0 --help
must_not_mint "-h"     0 -h
must_not_mint "help"   0 help

hdr "2. Unrecognised arguments must be refused, never minted"
must_not_mint "typo 'tokne'"        nonzero tokne
must_not_mint "empty argument"      nonzero ""
must_not_mint "whitespace argument" nonzero " "
must_not_mint "lone --"             nonzero --
must_not_mint "lone -"              nonzero -
must_not_mint "--version"           nonzero --version
must_not_mint "-v"                  nonzero -v
must_not_mint "--token (dashed form of the real command)" nonzero --token
must_not_mint "TOKEN (wrong case)"  nonzero TOKEN
must_not_mint "near-miss 'toke'"    nonzero toke
must_not_mint "near-miss 'doctorr'" nonzero doctorr
must_not_mint "near-miss 'verifyy'" nonzero verifyy
# A scope flag in the subcommand slot. Flags are read from anywhere in argv, so
# `gh-app-token.js --repos x` is a plausible operator mistake that must not mint.
must_not_mint "--repos in the subcommand slot"       nonzero --repos foo
must_not_mint "--permissions in the subcommand slot" nonzero --permissions contents=read
must_not_mint "--profile in the subcommand slot"     nonzero --profile agent

hdr "3. Fuzz: arguments nobody thought to allowlist"
for i in 1 2 3 4 5; do
  arg="$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  must_not_mint "random argument '$arg' (#$i)" nonzero "$arg"
done

hdr "4. The credential-helper path must not mint outside git's 'get' verb"
must_not_mint "credential with no verb"       0 credential
must_not_mint "credential store"              0 credential store
must_not_mint "credential erase"              0 credential erase
must_not_mint "credential GET (wrong case)"   0 credential GET
must_not_mint "credential get for a non-GitHub host" 0 \
  --stdin $'protocol=https\nhost=evil.example\n\n' credential get
must_not_mint "credential get for a github.com lookalike host" 0 \
  --stdin $'protocol=https\nhost=github.com.evil.example\n\n' credential get
# Not asserted here: `credential get` with no host= line. The helper treats an
# absent host as "no constraints" and mints, which is deliberate — git does not
# always send one. It is not an escalation (anyone who can run this can run
# `token`), so pinning it either way would just freeze an implementation detail.

hdr "5. Sanity: the recognised minting command still works"
run_tool credential get < /dev/null
# Fed a github.com host, the helper MUST answer, or the operator's git breaks.
run_tool --stdin $'protocol=https\nhost=github.com\n\n' credential get
if [[ $RC -eq 0 ]] && grep -q "password=$CACHE_CANARY" <<<"$OUT" && grep -q 'username=x-access-token' <<<"$OUT"; then
  ok "credential get for github.com still answers with the token"
else
  bad "credential get for github.com did not answer (rc=$RC) — this would break git"
fi

# --- TOG-222 ------------------------------------------------------------------
# Two defects, both of which this suite could previously have watched sail past:
# the cache admitted a token on GH_APP_ID alone (so unbinding the PEM revoked
# nothing), and a failed lookup fell through to git's own prompt (so the final
# visible line was git's opaque "could not read Username" rather than anything
# naming this tool).
#
# Broker-vs-PEM source selection is covered by test/gh-app-token.test.mjs, which
# can stand up a stub broker. What belongs HERE is the part that shares this
# suite's fixtures: cache attribution, and the shape of a refusal.

hdr "6. A cache entry is only valid for a credential we still hold (TOG-222)"

# The exact reproduction from the issue: GH_APP_ID still bound, PEM unbound, a
# live token sitting in the cache. This used to exit 0 and print the password.
OUT="$(printf '%s' $'protocol=https\nhost=github.com\n\n' | env -i \
  PATH="$PATH" HOME="$TMP" \
  GH_API_URL="$API_URL" \
  GH_APP_ID="000000" \
  GH_APP_TOKEN_CACHE="$CACHE" \
  GH_APP_TOKEN_SOURCE="pem" \
  "$TOOL" credential get 2>"$TMP/stderr")"; RC=$?
ERR="$(cat "$TMP/stderr")"
if [[ $RC -ne 0 ]] && ! grep -qE "$TOKEN_MATCHER" <<<"$OUT$ERR"; then
  ok "PEM unbound but GH_APP_ID still set: the cached token is refused"
else
  bad "the orphaned cache entry was still served (rc=$RC) — unbinding the PEM is not revocation"
fi
if grep -qx 'quit=1' <<<"$OUT"; then
  ok "the refusal emits quit=1, so git dies naming this helper instead of prompting"
else
  bad "no quit=1: git will discard our exit status, prompt, and report an unattributable failure"
fi

# A cache the tool cannot attribute to any credential — every entry written
# before TOG-222 — must not be readable either. There is no safe default to
# assume for a record whose origin is unknown.
seed_cache ""   # no cred field at all
run_tool --stdin $'protocol=https\nhost=github.com\n\n' credential get
if [[ $RC -eq 0 ]] && grep -q "password=$CACHE_CANARY" <<<"$OUT"; then
  bad "an unattributed (pre-TOG-222) cache entry was served"
else
  ok "an unattributed (pre-TOG-222) cache entry is refused"
fi

# ...and one attributed to a DIFFERENT credential. Same file, same appId, same
# scope: only `cred` differs, which is the whole point of the field.
seed_cache "pem:ffffffffffffffff"
run_tool --stdin $'protocol=https\nhost=github.com\n\n' credential get
if [[ $RC -eq 0 ]] && grep -q "password=$CACHE_CANARY" <<<"$OUT"; then
  bad "a cache entry minted by a different credential was served"
else
  ok "a cache entry minted by a different credential is refused"
fi

seed_cache   # restore the armed fixture for anything added after this point

# A token file must never be written where it outlives the run or is readable by
# another agent: every agent on the box shares uid `node` (TOG-191), so 0600 in a
# shared tmpdir separates nothing.
TMPDIR_PROBE="$TMP/tmpprobe"; mkdir -p "$TMPDIR_PROBE"
OUT="$(printf '%s' $'protocol=https\nhost=github.com\n\n' | env -i \
  PATH="$PATH" HOME="$TMP" TMPDIR="$TMPDIR_PROBE" \
  GH_API_URL="$API_URL" \
  GH_APP_ID="000000" \
  GH_APP_INSTALL_ID="99999999" \
  GH_APP_PRIVATE_KEY="$FAKE_PEM" \
  GH_APP_TOKEN_SOURCE="pem" \
  "$TOOL" credential get 2>/dev/null)"; RC=$?
if [[ $RC -eq 0 ]] && grep -q 'username=x-access-token' <<<"$OUT"; then
  ok "with no run scratch dir the helper still answers (losing the cache must not break git)"
else
  bad "the helper stopped answering when it had nowhere to cache (rc=$RC)"
fi
if [[ -z "$(find "$TMPDIR_PROBE" -name '.gh-app-token*' -print -quit)" ]]; then
  ok "...and wrote no token file into TMPDIR"
else
  bad "a token file was written into TMPDIR, where it outlives the run and other agents can read it"
fi

printf '\n\033[1mRESULT: %d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
