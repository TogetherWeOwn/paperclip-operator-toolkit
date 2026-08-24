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
# Extra NAME=VALUE pairs spliced into the `env -i` line. The scope variables have
# to be injected rather than exported, because `env -i` is the whole point of the
# runner: an inherited environment would let the operator's real settings decide
# what the suite is testing. Default empty, so every pre-existing test runs with
# no scope configured exactly as before.
EXTRA_ENV=()
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
    ${EXTRA_ENV[@]+"${EXTRA_ENV[@]}"} \
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

hdr "7. GH_APP_SCOPE_STRICT=1 must require a BOUNDED REPO SCOPE (TOG-238)"
# THE BUG (measured 2026-08-24, deployed copy line 92): strict mode was
# satisfied by `Object.keys(scope).length > 0` — an OR across the two halves. So
# GH_APP_PERMISSIONS alone passed the check while the minted token still carried
# repository_selection: "all", i.e. every repo in the installation. Strict mode
# reported least-privilege and delivered org-wide repo reach.
#
# This matters more than a missing permission set, and is easy to get backwards:
# the permissions half narrows WHAT the token may do, the repositories half
# narrows WHERE. Only the second one bounds blast radius across repos, and it is
# the one that was optional.
#
# WHY THESE TESTS ARE NOT VACUOUS. Every case below supplies a full fake
# credential environment (see the header) and asserts THREE things via
# must_not_mint: non-zero exit, nothing token-shaped emitted, and zero mint
# requests reaching the stub API. A regression that restores the OR would mint
# the ceiling token, trip TRAP 1 or TRAP 2, and fail here — a check on exit
# status alone would not distinguish "refused" from "died for another reason".
strict_env() { EXTRA_ENV=("GH_APP_SCOPE_STRICT=1" "$@"); }

# --- the acceptance criterion: permissions set, repos NOT set -----------------
strict_env "GH_APP_PERMISSIONS=contents=write,metadata=read"
must_not_mint "strict + GH_APP_REPOS unset (permissions alone must NOT satisfy strict)" nonzero token

# Set-but-empty and whitespace-only are the shapes this actually arrives in: the
# projection writes GH_APP_REPOS whether or not the project pinned a value, so
# "" is the common case in the field, not a contrived one. CI pins GH_APP_REPOS:''
# for the same reason.
strict_env "GH_APP_PERMISSIONS=contents=write" "GH_APP_REPOS="
must_not_mint "strict + GH_APP_REPOS='' (set but empty is not a scope)" nonzero token

strict_env "GH_APP_PERMISSIONS=contents=write" "GH_APP_REPOS=  ,   , "
must_not_mint "strict + GH_APP_REPOS whitespace/commas only" nonzero token

# --- the other half, and neither ----------------------------------------------
strict_env "GH_APP_REPOS=paperclip-ops-tooling"
must_not_mint "strict + GH_APP_PERMISSIONS unset (repos alone must NOT satisfy strict)" nonzero token

strict_env
must_not_mint "strict + neither half set" nonzero token

# The credential-helper path is how git actually reaches this tool, so strict
# mode must hold there too. A gap here would mean every `git push` bypassed the
# check that `token` enforces.
strict_env "GH_APP_PERMISSIONS=contents=write"
must_not_mint "strict + repos unset, via 'credential get' (git's real path)" nonzero \
  --stdin $'protocol=https\nhost=github.com\n\n' credential get

# --- the gate must key on the path taken, not on GH_APP_TOKEN_SOURCE ----------
# Found while merging TOG-226 (the broker) into this branch. The natural way to
# say "strict only gates the PEM, because the broker bounds scope server-side"
# is `&& SOURCE === 'pem'` — and it is wrong, because the DEFAULT is `auto`, and
# `auto` falls back to the raw signing key on any retryable broker failure. That
# spelling leaves strict mode switched off for the default setting, on exactly
# the path that mints a ceiling token: a broker outage would silently downgrade
# the control rather than fail. Each value is pinned explicitly so the
# distinction cannot be quietly collapsed again.
for src in auto pem; do
  strict_env "GH_APP_PERMISSIONS=contents=write" "GH_APP_TOKEN_SOURCE=$src"
  must_not_mint "strict + repos unset under GH_APP_TOKEN_SOURCE=$src (the PEM is reachable)" nonzero token
done

# ...and unset, which means `auto` but reaches it by a different code path (the
# `||` default rather than a bound value).
strict_env "GH_APP_PERMISSIONS=contents=write"
must_not_mint "strict + repos unset with GH_APP_TOKEN_SOURCE unset (defaults to auto)" nonzero token

# The corollary, stated so nobody "fixes" the above by gating every source: on
# the broker-only setting there is no PEM to reach and the scope is derived
# server-side from the issue the caller demonstrably holds, so a locally-empty
# GH_APP_REPOS is still bounded. Strict mode must not manufacture a refusal
# there — it would block the very path TOG-174 is trying to move everyone onto.
strict_env "GH_APP_PERMISSIONS=contents=write" "GH_APP_TOKEN_SOURCE=broker"
must_not_mint "strict + repos unset under SOURCE=broker still mints nothing here (no broker configured)" nonzero token
if grep -qi 'GH_APP_SCOPE_STRICT' <<<"$OUT"; then
  bad "SOURCE=broker refused on the LOCAL scope gate; the broker bounds scope server-side, so this is a false failure"
else
  ok "SOURCE=broker fails as a broker problem, not as a local scope refusal"
fi
EXTRA_ENV=()

hdr "8. Strict mode must still mint when BOTH halves are bounded"
# The negative controls above are only meaningful if the tool can still do its
# job. Without this, deleting currentScope() entirely would pass section 6.
strict_env "GH_APP_REPOS=paperclip-ops-tooling" "GH_APP_PERMISSIONS=contents=write,metadata=read"
run_tool token
if [[ $RC -eq 0 && "$OUT" == "$STUB_CANARY" && "$MINTS" -eq 1 ]]; then
  ok "strict + both halves bounded still mints (scoped, so it correctly misses the 'ceiling' cache entry)"
else
  bad "strict + both halves bounded did not mint: rc=$RC mints=$MINTS out='${OUT:0:24}...' err='${ERR:0:80}'"
fi

# Equivalent flags must satisfy strict mode identically, or the documented
# --repos/--permissions forms become a way to trip a check the env vars pass.
EXTRA_ENV=("GH_APP_SCOPE_STRICT=1")
run_tool token --repos paperclip-ops-tooling --permissions contents=write
if [[ $RC -eq 0 && "$MINTS" -eq 1 ]]; then
  ok "strict is satisfied by --repos/--permissions flags too"
else
  bad "strict rejected the flag form: rc=$RC mints=$MINTS err='${ERR:0:80}'"
fi

hdr "9. Strict mode OFF must keep working unchanged (no silent breakage)"
# The hardening must not change behaviour for anyone who has not opted in.
# Deploying this must be inert until GH_APP_SCOPE_STRICT=1 is set, which is what
# lets the rollout be sequenced behind the project-less set (TOG-226).
EXTRA_ENV=()
run_tool token
if [[ $RC -eq 0 && "$OUT" == "$CACHE_CANARY" ]]; then
  ok "strict unset + no scope still mints the ceiling token as before"
else
  bad "strict unset changed behaviour: rc=$RC out='${OUT:0:24}...' — this would break every unstrict caller"
fi

EXTRA_ENV=("GH_APP_SCOPE_STRICT=0")
run_tool token
if [[ $RC -eq 0 && "$OUT" == "$CACHE_CANARY" ]]; then
  ok "GH_APP_SCOPE_STRICT=0 is not strict (only the literal '1' enables it)"
else
  bad "GH_APP_SCOPE_STRICT=0 was treated as strict: rc=$RC out='${OUT:0:24}...'"
fi

hdr "10. 'scope-check' must answer without minting (the rollout preflight)"
# `scope` and `verify` mint in order to report, so neither can be swept across
# environments that are about to start failing. scope-check answers from config
# alone: no JWT, no network, no credential. If it ever mints, an operator
# sweeping every agent env would issue a token in each one.
EXTRA_ENV=("GH_APP_SCOPE_STRICT=1" "GH_APP_PERMISSIONS=contents=write")
must_not_mint "scope-check flags an unbounded repo scope, non-zero, without minting" nonzero scope-check
if grep -q '"repositoriesBounded": false' <<<"$OUT" && grep -q '"wouldMint": false' <<<"$OUT"; then
  ok "scope-check names the missing half in its report"
else
  bad "scope-check did not report the missing repo scope: '${OUT:0:120}'"
fi

EXTRA_ENV=("GH_APP_SCOPE_STRICT=1" "GH_APP_REPOS=paperclip-ops-tooling" "GH_APP_PERMISSIONS=contents=write")
must_not_mint "scope-check passes a fully bounded env, still without minting" 0 scope-check
if grep -q '"wouldMint": true' <<<"$OUT"; then
  ok "scope-check confirms a bounded env would mint"
else
  bad "scope-check did not confirm a bounded env: '${OUT:0:120}'"
fi

# Reported even when strict is off, so an environment can be fixed BEFORE strict
# is switched on rather than discovered by an outage afterwards.
EXTRA_ENV=("GH_APP_PERMISSIONS=contents=write")
must_not_mint "scope-check reports gaps with strict off, but exits 0" 0 scope-check
if grep -q '"repositoriesBounded": false' <<<"$OUT" && grep -q '"strictMode": false' <<<"$OUT"; then
  ok "scope-check surfaces the gap pre-emptively with strict off"
else
  bad "scope-check hid the gap when strict was off: '${OUT:0:120}'"
fi
EXTRA_ENV=()
printf '\n\033[1mRESULT: %d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
