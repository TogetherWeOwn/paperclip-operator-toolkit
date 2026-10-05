#!/usr/bin/env bash
set -uo pipefail

# ===========================================================================
# GitHub App installation-token minter
#
#   SUPERSEDED BY: plugins/gh-token-broker
#
#   Still live, still supported, do not delete. The broker is not installed
#   yet, and eight agents currently reach GitHub through this path.
#
#   Why it is going away: this script only works because GH_APP_PRIVATE_KEY is
#   projected into the environment it runs in. That is the whole problem —
#   any same-uid process can read the PEM out of /proc, so the per-agent
#   binding list is not a boundary. The broker inverts the flow: the host holds
#   the key and hands back a short-lived, repo-scoped token, so the signing key
#   never enters an agent address space at all.
#
#   Removal is NOT a cleanup task to be done opportunistically. It is gated on
#   unbinding GH_APP_PRIVATE_KEY from those eight agents first. Deleting this
#   before then takes eight agents offline.
# ---------------------------------------------------------------------------
# A GitHub App has no static token. The flow is:
#
#   1. Sign a short-lived JWT (RS256) with the App private key.
#   2. Exchange it at POST /app/installations/{id}/access_tokens for an
#      installation access token, valid ONE HOUR.
#   3. Use that token as a bearer, or in an HTTPS git remote.
#
# The important property for this deployment: a token can be SCOPED DOWN at
# mint time to specific repositories and a subset of permissions, and it can
# never exceed what the App itself holds. That is what keeps the authority
# taper intact even though the App is broadly permissioned — an agent never
# receives the private key, only a narrow one-hour token.
#
#   ./gh_token.sh check
#   ./gh_token.sh token                                  # full installation token
#   ./gh_token.sh token --repos foo,bar                  # only those repos
#   ./gh_token.sh token --permissions contents=read      # narrowed rights
#   ./gh_token.sh token --repos foo --permissions contents=write,pull_requests=write
#   ./gh_token.sh api GET /orgs/TogetherWeOwn/repos      # authenticated call
#   ./gh_token.sh api PUT /repos/o/r/pulls/1/merge '{"sha":"abc","merge_method":"squash"}'
#   ./gh_token.sh api GET /orgs/TogetherWeOwn/repos -- --max-time 7
#   ./gh_token.sh help                                   # this text, exit 0
#
# The `api` grammar is:
#
#   api <METHOD> <PATH> [JSON-BODY] [-- extra curl args...]
#
# The third argument is the REQUEST BODY and nothing else; extra curl arguments
# are read only after a literal `--`. The two are separate slots on purpose —
# they used to be the same one, so a JSON body was handed to curl positionally,
# parsed as a URL, and the request went out with NO BODY. That silently dropped
# `sha` head guards and `merge_method` from real merges. An argument that could
# belong to either slot is REFUSED, never guessed.
#
# Anything else is a usage error: usage goes to STDERR and the exit status is 2.
#
# NO CREDENTIAL OF ANY KIND IS PLACED IN argv. Not the private key, not the
# App JWT, not the installation token — /proc/*/cmdline is world-readable and
# this host is shared. Enforced by ./test_gh_token_argv.sh, which reads the
# kernel's own record of what curl was invoked with.
#
# NO REQUEST BODY IS PLACED IN argv EITHER, for the same reason: bodies to this
# API carry review text, secret values and head SHAs. Enforced by
# ./test_gh_token_api_body.sh.
# ===========================================================================

# --- the dispatch contract ---------------------------------------------------
# Two properties, both about exit status rather than printed output, which is
# the antipattern README.md already names ("a validator that printed REFUSED
# and exited 0 shipped once").
#
#   1. An unrecognised subcommand REFUSES: usage on stderr, exit 2. It used to
#      print usage on stdout and exit 0, so
#
#          tok="$(gh_token.sh tokne)" && use_credential "$tok"
#
#      proceeded with usage text in $tok. The failure was silent where it
#      happened and surfaced somewhere unrelated. Same shape as an earlier bug
#      in gh-app-token.js, in the same tool family, from the same cause: the
#      catch-all arm doing something other than refusing. gh_token.sh at least
#      failed SAFE — it printed usage rather than minting — which is why this
#      was filed low rather than as a leak.
#
#   2. `help` is answered HERE, above the credential preamble, and exits 0.
#      The preamble exits 1 when the credential directory is absent, so on a fresh box
#      `gh_token.sh --help` used to answer "cannot read .../github-app.pem"
#      and never print usage at all. Asking a tool how to use it must not
#      require the credentials you are asking how to obtain.
#
# Exit 2, not 1: a usage error is not an attempted operation that failed. It
# matches mint_token's own `unknown argument` arm below.
#
# Pinned by ./test_gh_token_dispatch.sh, which asserts exit status and WHICH
# STREAM the usage went to, never the wording.
usage() {
  sed -n '/^#   \.\/gh_token/,/^# ====/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' | head -n -1
}

refuse_usage() {
  local what="${1:-}"
  if [[ -n "$what" ]]; then
    printf 'gh_token: unknown subcommand "%s"\n' "$what" >&2
  else
    printf 'gh_token: no subcommand given\n' >&2
  fi
  usage >&2
  exit 2
}

case "${1:-}" in
  help|--help|-h) usage; exit 0 ;;
esac

# Default credential location is overridable: point CRED_DIR (or GITHUB_APP_PEM /
# GITHUB_APP_ENV directly) at wherever this host keeps the App key material.
CRED_DIR="${CRED_DIR:-${PAPERCLIP_HOME:-$HOME/.paperclip}/credentials}"
PEM="${GITHUB_APP_PEM:-$CRED_DIR/github-app.pem}"
ENVF="${GITHUB_APP_ENV:-$CRED_DIR/github-app.env}"

[[ -r "$PEM"  ]] || { echo "ERROR: cannot read $PEM"  >&2; exit 1; }
[[ -r "$ENVF" ]] || { echo "ERROR: cannot read $ENVF" >&2; exit 1; }
# shellcheck disable=SC1090
set -a; . "$ENVF"; set +a
: "${GITHUB_APP_ID:?missing GITHUB_APP_ID}"
: "${GITHUB_APP_INSTALLATION_ID:?missing GITHUB_APP_INSTALLATION_ID}"
GITHUB_ORG="${GITHUB_ORG:-}"

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# --- signing failure is reported, not printed --------------------------------
# The third instance of this repo's recurring bug, after two earlier ones with
# the same shape in the dispatch and credential helpers: exit status not
# matching what happened. This function used to end
#
#   sig="$(... | openssl dgst -sha256 -sign "$PEM" -binary | b64url)"
#   printf '%s.%s' "$signing_input" "$sig"
#
# and the script sets `-uo pipefail` but NOT `-e`. So a PEM that is readable
# but unusable — wrong format, truncated, an OpenSSL that refuses the key —
# left $sig empty, and the function returned printf's status, which is 0. The
# caller idiom
#
#   jwt="$(gh_token.sh jwt)" && curl -H "Authorization: Bearer $jwt" ...
#
# took the `&&` and sent a JWT ending in a dot. GitHub answers 401, and the
# operator spends the afternoon on an authentication problem that is really a
# key problem. Nothing leaks — an unsigned JWT mints nothing — but the tool
# pointed at the wrong wall.
#
# Two guards, because a failing openssl and a silently-empty one are different
# events and only the first sets a status:
#   the pipeline's status   `openssl dgst` refusing the key, caught by pipefail
#   the emptiness of $sig   an openssl that exits 0 having written nothing
# Either way stdout stays EMPTY and the return is 1, so `$(...)` captures
# nothing usable and the `&&` is not taken. That is the property
# test_gh_token_dispatch.sh asserts; the wording below is not a contract.
app_jwt() {
  local now iat exp header payload signing_input sig
  now="$(date +%s)"
  iat=$((now - 60))     # clock-skew tolerance, per GitHub's guidance
  exp=$((now + 540))    # 9 min; GitHub rejects anything over 10
  header="$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)"
  payload="$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' "$iat" "$exp" "$GITHUB_APP_ID" | b64url)"
  [[ -n "$header" && -n "$payload" ]] \
    || { echo "ERROR: could not base64url-encode the JWT header/payload" >&2; return 1; }
  signing_input="${header}.${payload}"
  sig="$(printf '%s' "$signing_input" | openssl dgst -sha256 -sign "$PEM" -binary | b64url)" \
    || { echo "ERROR: could not sign the App JWT with $PEM" >&2; return 1; }
  [[ -n "$sig" ]] \
    || { echo "ERROR: signing with $PEM produced an empty signature" >&2; return 1; }
  printf '%s.%s' "$signing_input" "$sig"
}

# --- credentials never reach argv ------------------------------------------------
# `-H "Authorization: Bearer $tok"` puts the credential in the curl process's
# argv, and /proc/<pid>/cmdline is world-readable. Every company on this box
# shares the host, so for the lifetime of the call any local process can read
# the bearer by polling /proc. No exploit is needed and nothing is logged. It
# is a stated non-negotiable in README.md, and it was being violated here for
# both the App JWT and — worse — a full-ceiling installation token.
#
# The fix is the one omniroute_combo_cli.sh already uses: write the header
# into a 0600 `curl --config` file and pass curl the PATH. Only the path is in
# argv. The residual exposure is a same-uid process reading the temp file
# during the call, which is the same trust boundary the 0600 PEM in the
# credential directory already rests on — a strictly smaller set than "anyone".
#
# Cleanup is deliberately belt-and-braces, because the obvious single mechanism
# has a hole. mint_token calls app_api inside a COMMAND SUBSTITUTION, so
# curl_authed runs in a subshell — and a subshell resets trapped signals to
# their default disposition. A trap in the parent cannot clean up a file whose
# path only ever existed in a subshell variable. So every config file is
# created inside one 0700 per-process directory, made here at the top level
# before any subshell exists:
#
#   normal path   curl_authed removes its own file the moment curl returns
#   subshell dies the parent's EXIT trap removes the whole directory anyway
CFG_DIR="$(umask 077; mktemp -d "${TMPDIR:-/tmp}/gh_token.XXXXXXXX")" \
  || { echo "ERROR: could not create a private temp directory" >&2; exit 1; }
cleanup_cfg() { rm -rf "$CFG_DIR"; return 0; }
trap 'cleanup_cfg' EXIT
trap 'cleanup_cfg; exit 130' INT
trap 'cleanup_cfg; exit 143' TERM
trap 'cleanup_cfg; exit 129' HUP

# curl_authed <bearer> <method> <url> <json-body-or-empty> [extra curl args...]
curl_authed() {
  local bearer="$1" method="$2" url="$3" body="$4"; shift 4
  local cfg rc
  # umask, not just a post-hoc chmod: mktemp is already 0600 on Linux, but the
  # umask closes the window on any platform where it is not, and states the
  # intent where a reader will look for it.
  cfg="$(umask 077; mktemp "$CFG_DIR/curlcfg.XXXXXXXX")" \
    || { echo "ERROR: could not create a curl config file" >&2; exit 1; }
  chmod 0600 "$cfg"
  {
    printf 'url = "%s"\n' "$url"
    printf 'request = "%s"\n' "$method"
    printf 'header = "Authorization: Bearer %s"\n' "$bearer"
    printf 'header = "Accept: application/vnd.github+json"\n'
    printf 'header = "X-GitHub-Api-Version: 2022-11-28"\n'
    if [[ -n "$body" ]]; then
      printf 'header = "Content-Type: application/json"\n'
      # jq -Rn renders the body as a JSON string, whose escaping is a subset of
      # what curl's config parser accepts for a double-quoted value.
      printf 'data-binary = %s\n' "$(jq -Rn --arg b "$body" '$b')"
    fi
    printf 'silent\nshow-error\n'
  } > "$cfg"
  curl --config "$cfg" "$@"
  rc=$?
  rm -f "$cfg"
  return $rc
}

# curl_authed_http has the same call shape as curl_authed, but makes an HTTP
# refusal visible in the exit status while leaving curl's response body alone.
# This is deliberately a wrapper rather than curl_authed's default:
# app_api's check/token/meta callers parse GitHub's error body themselves, and
# changing their return status would replace those established messages with a
# generic "request failed". The public `api` arm is the caller that needs HTTP
# >= 400 to be a failed operation.
#
# Do not use curl --fail here. It can suppress the response body, which is the
# only useful explanation GitHub gives for a 4xx/5xx. A private header file lets
# the body continue to stdout byte-for-byte. The last HTTP status wins, covering
# 1xx responses, proxies and caller-requested redirects. Exit 22 follows curl's
# established HTTP-error code; transport failures retain curl's own distinct rc.
curl_authed_http() {
  local bearer="$1" method="$2" url="$3" body="$4"; shift 4
  local headers rc line http_status=""
  headers="$(umask 077; mktemp "$CFG_DIR/headers.XXXXXXXX")" \
    || { echo "ERROR: could not create a response-header file" >&2; exit 1; }
  chmod 0600 "$headers"

  # Appended after caller-supplied arguments so an extra -D/--dump-header cannot
  # divert the status record and make a refused write look successful again.
  curl_authed "$bearer" "$method" "$url" "$body" "$@" --dump-header "$headers"
  rc=$?
  if [[ $rc -ne 0 ]]; then
    rm -f "$headers"
    return $rc
  fi

  while IFS= read -r line; do
    line="${line%$'\r'}"
    if [[ "$line" =~ ^HTTP/[^[:space:]]+[[:space:]]+([0-9]{3})([[:space:]]|$) ]]; then
      http_status="${BASH_REMATCH[1]}"
    fi
  done < "$headers"
  rm -f "$headers"

  [[ -n "$http_status" ]] \
    || { echo "ERROR: curl completed without an HTTP response status" >&2; return 1; }
  if [[ "$http_status" -ge 400 ]]; then
    return 22
  fi
  return 0
}

# gh_api <method> <path> [json-body]  — authenticated as the APP (JWT)
app_api() {
  local method="$1" path="$2" body="${3:-}"
  # Return rather than calling curl with an empty bearer: an unsigned request
  # comes back 401, which reads as a permissions problem and sends the reader
  # to the App's install settings instead of to the key. app_jwt has already
  # said what actually went wrong, on stderr.
  local jwt; jwt="$(app_jwt)" || return 1
  curl_authed "$jwt" "$method" "https://api.github.com${path}" "$body"
}

mint_token() {
  local repos="" perms="" body="{}"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --repos)       repos="$2"; shift 2;;
      --permissions) perms="$2"; shift 2;;
      *) echo "unknown argument: $1" >&2; exit 2;;
    esac
  done
  local jq_args=(-n) filter='{}'
  if [[ -n "$repos" ]]; then
    body="$(jq -cn --arg r "$repos" '{repositories: ($r | split(","))}')"
  fi
  if [[ -n "$perms" ]]; then
    local pjson
    pjson="$(jq -cn --arg p "$perms" '
      [$p | split(",")[] | split("=") | {key: .[0], value: .[1]}] | from_entries')"
    body="$(jq -cn --argjson b "$body" --argjson p "$pjson" '$b + {permissions: $p}')"
  fi
  local resp
  resp="$(app_api POST "/app/installations/${GITHUB_APP_INSTALLATION_ID}/access_tokens" "$body")"
  if ! jq -e '.token' >/dev/null 2>&1 <<<"$resp"; then
    echo "ERROR minting token:" >&2
    jq -r '.message // .' <<<"$resp" >&2
    exit 1
  fi
  jq -r '.token' <<<"$resp"
}

# --- a report that could not answer must not read as a clean one ---
# `check` used to be three bare pipelines in the dispatch arm:
#
#   app_api GET /app | jq -r '"  app: \(.name) ..."'
#
# which exits 0 in three distinct failure modes. The request failing — the
# first two pipelines' statuses were discarded entirely, only the last one
# reached the arm's status. GitHub answering an error object such as
# {"message":"Bad credentials"} — a 200-shaped pipeline over a body with no
# .name in it. And jq interpolating a null, which is a perfectly good string.
# All three printed the heading, printed a blank or "null"-filled line under
# it, and returned success, so `gh_token.sh check && echo ok` said ok.
#
# Each response is now captured once and VALIDATED for the field its line is
# about before anything is formatted. Validation is separate from formatting
# on purpose: `jq -e -r '"...\(.name)..."'` looks like it checks, and does not
# — the interpolated string is truthy whatever .name was.
#
# It also drops a redundant third call: the installation body was being
# fetched twice, once for the identity line and once for the permissions.

# require_field <jq-predicate> <json> <what-was-expected>
# The validation half, factored out so there is ONE place that decides whether
# a response is usable — and so CI has a single line to mutate when it proves
# this suite still detects the defect.
#
# It must be a PREDICATE, not a formatted string. `jq -e -r '"...\(.name)..."'`
# reads like a check and is not one: the interpolated string is truthy whatever
# .name held, so a body with no .name in it renders "app: null" and exits 0.
# A non-JSON body (an HTML error page from a proxy) makes jq exit 2, which
# takes the same path.
require_field() {
  jq -e "$1" >/dev/null 2>&1 <<<"$2" && return 0
  printf 'ERROR: %s: %s\n' "$3" "$(jq -r '.message // .' <<<"$2" 2>/dev/null | head -1)" >&2
  return 1
}

app_check() {
  local app inst
  app="$(app_api GET /app)" \
    || { echo "ERROR: check: the /app request failed" >&2; return 1; }
  require_field '.id != null and .slug != null' "$app" \
    "check: /app did not answer with an app" || return 1

  inst="$(app_api GET "/app/installations/${GITHUB_APP_INSTALLATION_ID}")" \
    || { echo "ERROR: check: the installation request failed" >&2; return 1; }
  require_field '.account.login != null and .permissions != null' "$inst" \
    "check: installation ${GITHUB_APP_INSTALLATION_ID} did not answer with an installation" || return 1

  echo "=== App identity (JWT auth) ==="
  jq -r '"  app: \(.name)  slug=\(.slug)  id=\(.id)  owner=\(.owner.login)"' <<<"$app"
  echo "=== Installation ==="
  jq -r '"  account: \(.account.login)  repo_selection: \(.repository_selection)  events: \(.events|length)"' <<<"$inst"
  echo "=== Permissions the App actually holds ==="
  jq -r '.permissions | to_entries[] | "  \(.key): \(.value)"' <<<"$inst" | sort
}

# Third instance of this silent-success shape, found by the suite written for
# the first two: the response status was discarded, and `jq -c '{a,b,c}'` over
# an empty or error body prints an object of nulls — or, on no input at all,
# prints nothing and exits 0. `meta` therefore reported success having said
# nothing.
mint_meta() {
  local resp
  resp="$(app_api POST "/app/installations/${GITHUB_APP_INSTALLATION_ID}/access_tokens" "{}")" \
    || return 1
  require_field '.token != null' "$resp" "meta: the installation returned no token" || return 1
  jq -c '{expires_at, repository_selection, permissions}' <<<"$resp"
}

case "${1:-}" in
  # `|| exit $?` is the arm's whole point: `app_jwt; echo` returned
  # ECHO's status, which is 0 unconditionally, so even a function that failed
  # loudly would have been reported as success here. The trailing newline is
  # for humans and must not be able to speak for the signing step.
  jwt)   app_jwt || exit $?; echo ;;
  check) app_check ;;
  token) shift; mint_token "$@" ;;
  meta)  mint_meta ;;
  api)
    shift
    method="${1:?method}"; path="${2:?path}"; shift 2

    # --- body and extra curl args are DIFFERENT SLOTS ---------------------------
    # This used to be one slot:
    #
    #     curl_authed "$tok" "$method" "https://api.github.com${path}" "" "$@"
    #
    # The body position was hardcoded empty and "$@" — the caller's JSON —
    # went to the trailing extra-curl-args position instead. curl parsed the
    # JSON as a URL and sent the request with no body, so a guarded merge
    # became an unguarded one and a requested squash became a merge commit.
    # Nothing failed loudly; the write succeeded, just not the write asked for.
    #
    # Hence the parse below. Its one job is that no argument is ever read as
    # the other kind of thing. `--` is the separator, and anything ambiguous
    # is refused — the previous behaviour's defining property was guessing
    # wrong in silence, so guessing at all is what has to go.
    api_body=""
    api_extra=()
    if [[ $# -gt 0 ]]; then
      if [[ "$1" == "--" ]]; then
        shift; api_extra=("$@")
      elif [[ "$1" == -* ]]; then
        # The older spelling, `api GET /path --max-time 7`. Treating it
        # as a body would send "--max-time" as JSON; treating it as a curl arg
        # would re-open the collision this parse exists to close. Refuse.
        printf 'gh_token: api: "%s" cannot be the request body.\n' "$1" >&2
        printf '  Argument 3 is the JSON request body. Extra curl arguments follow "--":\n' >&2
        printf '    gh_token.sh api %s %s -- %s ...\n' "$method" "$path" "$1" >&2
        exit 2
      else
        api_body="$1"; shift
        if [[ $# -gt 0 ]]; then
          if [[ "$1" == "--" ]]; then
            shift; api_extra=("$@")
          else
            printf 'gh_token: api: unexpected argument "%s" after the request body.\n' "$1" >&2
            printf '  Extra curl arguments must follow "--".\n' >&2
            exit 2
          fi
        fi
      fi
    fi

    # A body slot that is declared JSON and sent with Content-Type:
    # application/json should not accept something that is not JSON. The
    # failure this prevents is the body-slot collision one layer up: a body the
    # caller believes carries a `sha` guard, which GitHub parses as absent.
    if [[ -n "$api_body" ]] && ! jq -e . >/dev/null 2>&1 <<<"$api_body"; then
      printf 'gh_token: api: the request body is not valid JSON; refusing to send it.\n' >&2
      printf '  body: %s\n' "${api_body:0:200}" >&2
      exit 2
    fi

    # NOTE: mint_token with no arguments mints at the App's full ceiling. That
    # is pre-existing behaviour and eight agents depend on this path, so it is
    # not narrowed here; that fix was scoped to keeping credentials out of argv. It is
    # also why the leak mattered: what used to sit in /proc was org-admin
    # capable, not a read-only token.
    #
    # `|| exit` is load-bearing. mint_token runs in a command substitution, so
    # its `exit 1` ends only the subshell; without this the script carried on
    # with an empty $tok and sent the request as `Authorization: Bearer ` —
    # an unauthenticated write attempt from a mint the caller was never told
    # had failed. Same family as the bug above: a skipped step, no warning.
    tok="$(mint_token)" || exit $?
    [[ -n "$tok" ]] || { echo "ERROR: minted an empty token; refusing to send the request" >&2; exit 1; }

    # The exit status is this call's, and only this call's. It used to be the
    # status of whichever stray argument curl parsed last, which reported
    # successful writes as failures and could mask failed ones.
    #
    # Kept on ONE line because CI mutates it by exact-line replacement to prove
    # test_gh_token_api_body.sh still detects the original defect. If you
    # reflow this, update the `before=` string in .github/workflows/ci.yml —
    # that step refuses (exit 2) rather than passing blind when it cannot find
    # its target, so it will tell you.
    curl_authed_http "$tok" "$method" "https://api.github.com${path}" "$api_body" ${api_extra[@]+"${api_extra[@]}"}
    exit $?
    ;;
  *) refuse_usage "${1:-}" ;;
esac
