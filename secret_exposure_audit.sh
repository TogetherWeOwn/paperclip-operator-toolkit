#!/usr/bin/env bash
# ===========================================================================
# In-run platform-credential exposure audit.  TOG-392.
#
# THE THING BEING MEASURED. Every agent runs as uid 1000 (`node`, TOG-191).
# The harness projects a fixed set of platform credentials into that process's
# environment and filesystem. Some of them are not scoped to the run's own
# company, and some of them are not confidentiality secrets at all -- they are
# the *signing keys the server verifies against*. This script enumerates every
# such channel THIS run actually holds, classifies what each one grants, and
# fails when any high-severity channel is present.
#
# It is deliberately an ATTEMPT, not an inference. Several fields on this
# platform lie (a projected env var can be set-but-empty; a 0600 file owned by
# the agent uid is still readable by the agent). So every check here probes the
# concrete primitive -- `[ -n "$var" ]` for a projected value, `[ -r "$file" ]`
# for a readable key file -- rather than trusting a mode bit or an owner name.
#
# WHY THIS IS BROADER THAN THE ISSUE AS FILED. TOG-392 names two channels: the
# secrets master key and the full-multi-company DATABASE_URL. Together those
# decrypt every company's stored secrets (AES-256-GCM `local_encrypted_v1`,
# decrypt path server/dist/secrets/local-encrypted-provider.js:184). But the
# same run also holds:
#
#   * BETTER_AUTH_SECRET -- the agent-JWT verification secret. The server falls
#     back to it when PAPERCLIP_AGENT_JWT_SECRET is unset
#     (server/dist/agent-auth-jwt.js:18). Holding it lets a run forge a token
#     for ANY agent identity. This defeats authentication, not confidentiality.
#
#   * PAPERCLIP_TOOL_ACTION_SIGNING_SECRET -- the HMAC key the server uses to
#     issue and verify signed tool-action approvals
#     (server/dist/services/tool-content-guards.js:48). Holding it lets a run
#     mint an approval the gate will accept. This defeats authorization.
#
# So the exposure is not "one run can read some secrets"; it is "one run holds
# the keys that make the confidentiality, authentication, AND authorization
# layers forgeable." A write-up that stops at the master key hides two-thirds
# of the disclosure. (See the standing lesson: enumerate every channel first.)
#
# WHAT THIS SCRIPT WILL NOT DO. It never prints a secret value -- only the
# variable NAME, a present/absent boolean, non-secret file metadata (byte
# length, mode), and a static description of what the channel grants. It never
# decrypts anything, never queries the DB, and never forges a token. Proving
# the vector is a matter of reading the server's own consuming code (cited per
# channel), not of exercising the privilege. The one destructive thing an audit
# like this could do -- actually use a held key -- is exactly the thing it must
# not do.
#
# CONTAINMENT IS THE POINT OF THE EXIT CODE. The real fix for TOG-392 is
# platform + owner: stop projecting these into agent runs, move decryption
# behind a broker that hands back only the specific resolved values a run is
# entitled to, and scope any in-run DB connection to the run's own company.
# When that lands, THIS SCRIPT FLIPS TO EXIT 0 from inside a normal run -- which
# is the evidence the issue asks for before rotating anything that was broadly
# decryptable. Until then it exits 1.
#
# Exit codes:
#   0  CONTAINED    -- no high-severity channel is present in this environment.
#   1  EXPOSED      -- at least one high-severity channel is present.
#   2  usage / internal error.
#
# There is no "indeterminate" exit here on purpose: presence of an env var or a
# readable file is a boolean this process can always establish for itself. The
# thing it cannot establish -- whether the platform has scoped the value behind
# it -- is not this script's claim to make; a present channel is reported
# present regardless of any scoping the server might apply downstream, because
# the run holding the raw material is the finding.
# ===========================================================================

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORMAT="text"
QUIET=0

usage() {
  cat <<'EOF'
Usage: secret_exposure_audit.sh [--format text|json] [--quiet] [-h|--help]

Enumerates the platform credential channels the current run holds and what
each one grants. Reads only the current process environment and the master-key
file path it names; never prints a secret value.

  --format text|json   Output shape (default: text).
  --quiet              Suppress the per-channel report; exit code only.
  -h, --help           This help.

Exit: 0 contained (no high-severity channel present), 1 exposed, 2 error.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --format) FORMAT="${2:-}"; shift 2 || { echo "ERROR: --format needs a value" >&2; exit 2; } ;;
    --format=*) FORMAT="${1#*=}"; shift ;;
    --quiet|-q) QUIET=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done
case "$FORMAT" in text|json) ;; *) echo "ERROR: --format must be text or json, got '$FORMAT'" >&2; exit 2 ;; esac

# --- channel registry ------------------------------------------------------
# Each channel is: kind|severity|name|grant
#   kind      env  -> presence is "the named env var is set and non-empty"
#             file -> presence is "the file the named env var points at is
#                     readable"; if the env var is unset a literal default path
#                     is used (the value after ':' in the name column).
#   severity  high -> counts toward EXPOSED (exit 1)
#             med  -> reported, does not by itself flip the exit code
#   grant     one-line, non-secret description of what holding it enables,
#             with the server source that consumes it.
#
# Ordered most-severe first so the report reads as a severity ranking.
CHANNELS=(
  "file|high|PAPERCLIP_SECRETS_MASTER_KEY_FILE:/paperclip/instances/default/secrets/master.key|Decrypts EVERY company's local_encrypted_v1 secrets (aes-256-gcm; local-encrypted-provider.js:184). With DATABASE_URL this is a cross-company plaintext read."
  "env|high|DATABASE_URL|Full multi-company Paperclip DB incl. company_secret_versions.material; pairs with the master key for cross-company decrypt, and holds every companies' rows directly."
  "env|high|BETTER_AUTH_SECRET|Agent-JWT verification secret (agent-auth-jwt.js:18 fallback). Forges a token for ANY agent identity -- defeats authentication."
  "env|high|PAPERCLIP_AGENT_JWT_SECRET|Primary agent-JWT signing/verification secret (agent-auth-jwt.js:18). Same forge-any-identity power as BETTER_AUTH_SECRET; usually unset here, hence the fallback."
  "env|high|PAPERCLIP_TOOL_ACTION_SIGNING_SECRET|HMAC key for signed tool-action approvals (tool-content-guards.js:48). Mints an approval the gate accepts -- defeats authorization."
  "env|high|GH_APP_PRIVATE_KEY|GitHub App private signing key in env. Mints installation tokens for whatever the App can reach (project-scoped, but a raw private key in env)."
  "env|med|POSTGRES_PASSWORD|Same DB credential material as DATABASE_URL, split out; redundant channel to the multi-company DB."
  "env|med|ANTHROPIC_API_KEY|Model provider credential projected into the run."
)

# --- evaluate --------------------------------------------------------------
# Row shape: severity<TAB>present<TAB>channel<TAB>meta<TAB>grant
declare -a ROWS=()
EXPOSED_HIGH=0

for spec in "${CHANNELS[@]}"; do
  IFS='|' read -r kind sev namecol grant <<<"$spec"
  present="no"
  meta="-"
  case "$kind" in
    env)
      # Presence = set AND non-empty. A set-but-empty projection is not a
      # usable credential and must not read as exposed.
      if [[ -n "${!namecol:-}" ]]; then present="yes"; fi
      name="$namecol"
      ;;
    file)
      name="${namecol%%:*}"
      default="${namecol#*:}"
      path="${!name:-$default}"
      meta="path=$path"
      if [[ -r "$path" ]]; then
        present="yes"
        # Non-secret metadata only: byte length and mode. NEVER the contents.
        local_bytes="$(wc -c <"$path" 2>/dev/null | tr -d ' ')"
        local_mode="$(stat -c '%a' "$path" 2>/dev/null || echo '?')"
        meta="path=$path bytes=${local_bytes:-?} mode=${local_mode}"
      fi
      ;;
    *) echo "ERROR: bad channel kind '$kind' in registry" >&2; exit 2 ;;
  esac

  if [[ "$present" == "yes" && "$sev" == "high" ]]; then
    EXPOSED_HIGH=$((EXPOSED_HIGH + 1))
  fi
  ROWS+=("$sev	$present	$name	$meta	$grant")
done

# --- report ----------------------------------------------------------------
emit_text() {
  printf '%-4s  %-7s  %-38s  %s\n' "SEV" "PRESENT" "CHANNEL" "GRANT"
  printf '%-4s  %-7s  %-38s  %s\n' "---" "-------" "-------" "-----"
  local sev present name meta grant
  while IFS=$'\t' read -r sev present name meta grant; do
    printf '%-4s  %-7s  %-38s  %s\n' "$sev" "$present" "$name" "$grant"
    [[ "$meta" != "-" ]] && printf '%-4s  %-7s  %-38s  (%s)\n' "" "" "" "$meta"
  done < <(printf '%s\n' "${ROWS[@]}")
  echo
  if [[ "$EXPOSED_HIGH" -gt 0 ]]; then
    echo "VERDICT: EXPOSED -- $EXPOSED_HIGH high-severity channel(s) present in this run."
  else
    echo "VERDICT: CONTAINED -- no high-severity channel present in this run."
  fi
}

emit_json() {
  # Hand-rolled JSON so this has no jq dependency (the agent container ships no
  # `column`, and we do not assume jq either). Values here are booleans and
  # static strings only -- never a secret.
  local first=1 sev present name meta grant
  printf '{"exposedHigh":%d,"verdict":"%s","channels":[' \
    "$EXPOSED_HIGH" "$([[ $EXPOSED_HIGH -gt 0 ]] && echo EXPOSED || echo CONTAINED)"
  while IFS=$'\t' read -r sev present name meta grant; do
    [[ $first -eq 0 ]] && printf ','
    first=0
    # Escape backslashes and quotes in the free-text grant/meta.
    local g="${grant//\\/\\\\}"; g="${g//\"/\\\"}"
    local m="${meta//\\/\\\\}"; m="${m//\"/\\\"}"
    printf '{"severity":"%s","present":%s,"channel":"%s","meta":"%s","grant":"%s"}' \
      "$sev" "$([[ $present == yes ]] && echo true || echo false)" "$name" "$m" "$g"
  done < <(printf '%s\n' "${ROWS[@]}")
  printf ']}\n'
}

if [[ "$QUIET" -eq 0 ]]; then
  case "$FORMAT" in
    text) emit_text ;;
    json) emit_json ;;
  esac
fi

[[ "$EXPOSED_HIGH" -gt 0 ]] && exit 1
exit 0
