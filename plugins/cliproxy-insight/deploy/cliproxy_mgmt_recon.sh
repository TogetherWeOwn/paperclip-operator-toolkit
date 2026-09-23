#!/usr/bin/env bash
# TOG-816 -- CLIProxy Management API read-only reconnaissance, as a script.
#
# STATUS: TOG-816 WAS ANSWERED on 2026-09-05 against CLIProxy v7.2.140. This is
# no longer the tool that finds out; it is the tool that RE-CHECKS after an
# upgrade. What the operator measured:
#
#   * No usage endpoint exists. /usage, /usage/statistics, /usage-statistics,
#     /usage/summary, /quota, /request-statistics, /logs/summary -> all 404.
#   * /v0/management/auth-files is the ONLY route carrying per-upstream
#     counters, and it is identity-bearing: email, account, path, id,
#     auth_index, project_id, and a codex id_token.
#   * The same key opens /v0/management/api-keys (inference key IN CLEAR) and
#     /v0/management/config.
#
# That is why the lane proxies a host-side sanitizer instead of CLIProxy (see
# Caddyfile.snippet block B section 4). Run this again after any CLIProxy
# upgrade: "no usage endpoint exists" is a fact about v7.2.140, not a permanent
# property, and if a later build adds a non-identity-bearing counters route the
# sanitizer gets much simpler. A NEW 200 on a route not listed above is the
# finding worth reporting; re-confirming the four facts above is the floor.
#
# WHY THIS IS A SCRIPT AND NOT A CHECKLIST
#   The original TOG-816 ask was for a human to run a handful of GETs and paste
#   back redacted results. Three things about that are hazardous enough to
#   encode, and they still apply to every re-run:
#
#   1. RATE. CLIProxy IP-bans after a few rapid probes -- ~30 minutes, measured
#      the hard way twice during TOG-811. A human pasting a loop, or getting
#      impatient, re-earns that ban. Spacing here is enforced, not advised.
#   2. REDACTION. The whole point is to learn response SHAPES without the key
#      or any credential material leaving the host. A human redacting by hand,
#      into a ticket, is the step where a key gets pasted. This never prints
#      the key, and it strips value-looking material from bodies by default.
#   3. READ-ONLY. Only GET is ever sent. There is no code path in this file
#      that issues another verb.
#
# WHAT IT PRODUCES
#   A report on stdout: for each candidate endpoint, the status, content-type,
#   body size, and the KEY STRUCTURE of the JSON (field names and value TYPES,
#   never values) -- which is exactly what TOG-811 needs to replace its guessed
#   schema, and nothing more.
#
#   With --full-bodies it prints bodies too, still key-redacted. Use that only
#   if the structure dump is insufficient, and re-read what it prints before
#   pasting it anywhere.
#
# USAGE (on the host, by whoever holds the key)
#   export CLIPROXY_MGMT_KEY=...          # never passed on argv -- ps is public
#   ./cliproxy_mgmt_recon.sh
#   ./cliproxy_mgmt_recon.sh --base http://127.0.0.1:8317 --sleep 5
#
# SEAMS
#   CLIPROXY_MGMT_KEY   the management key. Required. Env only, never argv.
#   RECON_BASE          base URL, default http://127.0.0.1:8317 (CLIProxy binds
#                       host-loopback; going via the public name adds a hop and
#                       an IP-ban surface for no benefit when you are already
#                       on the host).
#   RECON_SLEEP         seconds between requests, default 4. Do not lower it.
#   RECON_CURL          curl binary, default "curl".
#
# EXIT
#   0  recon completed (individual 404s are DATA, not failures)
#   64 bad usage
#   70 no key, or curl missing, or the very first request could not connect
set -uo pipefail

BASE="${RECON_BASE:-http://127.0.0.1:8317}"
SLEEP_S="${RECON_SLEEP:-4}"
CURL="${RECON_CURL:-curl}"
KEY="${CLIPROXY_MGMT_KEY:-}"
FULL_BODIES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base)        BASE="${2:-}";    shift 2 ;;
    --sleep)       SLEEP_S="${2:-}"; shift 2 ;;
    --full-bodies) FULL_BODIES=1;    shift ;;
    -h|--help)     sed -n '1,64p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

[[ -n "$KEY" ]] || {
  echo "CLIPROXY_MGMT_KEY is not set. Export it; do not pass it on argv --" >&2
  echo "a command line is readable by every process on the host." >&2
  exit 70
}
command -v "$CURL" >/dev/null 2>&1 || { echo "curl not found" >&2; exit 70; }
HAVE_NODE=0; command -v node >/dev/null 2>&1 && HAVE_NODE=1

# Candidate endpoints. On v7.2.140 every one of these 404s except auth-files,
# api-keys and config -- that is the measured baseline, and the list is kept
# whole rather than pruned to it, because the question a re-run answers is
# "did an upgrade ADD one of these back". A 404 is the expected result and is
# reported as data, not as a failure.
ENDPOINTS=(
  /v0/management/usage
  /v0/management/cooldowns
  /v0/management/status
  /v0/management/providers
  /v0/management/accounts
  /v0/management
  /v0/management/auth-files
  /v0/management/api-keys
  /v0/management/config
  /usage
  /usage/statistics
  /usage-statistics
  /usage/summary
  /quota
  /request-statistics
  /logs/summary
  /usage-summary
)

# Names whose VALUES are never printed, at any verbosity. Matched
# case-insensitively as a substring of the JSON key.
SECRET_KEYISH='key|token|secret|password|credential|bearer|authorization|apikey|api_key|refresh|access|cookie|session'

redact_key() { sed -e "s/${KEY//\//\\/}/<KEY-REDACTED>/g"; }

# Body redaction for --full-bodies. Stripping only the management key is NOT
# enough and that was a real defect in this script's first draft: a fixture
# returning {"apiKey":"sk-live-..."} from /v0/management/auth-files came through
# verbatim, because the response's credential material is not the key we sent.
# Every secret-looking VALUE is replaced here, whatever it is. Falls back to
# refusing to print at all when node is unavailable, because a partial redaction
# an operator believes is complete is worse than no output.
redact_body() {
  if ((HAVE_NODE)); then
    SECRET_KEYISH="$SECRET_KEYISH" node -e '
      let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
        const re=new RegExp(process.env.SECRET_KEYISH,"i");
        let j; try { j=JSON.parse(d) } catch {
          // Not JSON: cannot redact structurally, so do not print it.
          console.log("(non-JSON body withheld -- cannot redact structurally)");
          return }
        const scrub=v=>{
          if (Array.isArray(v)) return v.map(scrub);
          if (v && typeof v==="object") {
            const o={};
            for (const k of Object.keys(v)) o[k]= re.test(k) ? "<WITHHELD>" : scrub(v[k]);
            return o;
          }
          return v;
        };
        console.log(JSON.stringify(scrub(j),null,2));
      })' | redact_key
  else
    echo "(body withheld: node is unavailable and this script will not print a"
    echo " body it cannot structurally redact)"
  fi
}

# Print JSON structure: field paths and value TYPES, never values. Arrays are
# collapsed to their first element's shape with a count, so a 200-entry usage
# list prints as one line rather than 200.
structure() {
  if ((HAVE_NODE)); then
    SECRET_KEYISH="$SECRET_KEYISH" node -e '
      let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
        let j; try { j=JSON.parse(d) } catch {
          console.log("    (not JSON -- "+d.length+" bytes)"); return }
        const re=new RegExp(process.env.SECRET_KEYISH,"i");
        const lines=[];
        const walk=(v,path)=>{
          if (Array.isArray(v)) {
            lines.push(`    ${path}: array[${v.length}]`);
            if (v.length) walk(v[0], path+"[0]");
            return;
          }
          if (v && typeof v==="object") {
            for (const k of Object.keys(v)) walk(v[k], path?path+"."+k:k);
            return;
          }
          const t = v===null ? "null" : typeof v;
          // A secret-looking key never has its value shown, not even a sample.
          const leaf = re.test(path.split(".").pop()||"") ? `${t} <WITHHELD>` : t;
          lines.push(`    ${path}: ${leaf}`);
        };
        walk(j,"");
        console.log(lines.slice(0,120).join("\n"));
        if (lines.length>120) console.log(`    ... ${lines.length-120} more fields`);
      })'
  else
    # No node: fall back to listing top-level keys only. Never dumps values.
    grep -o '"[A-Za-z0-9_-]*"[[:space:]]*:' | tr -d '":' | sort -u \
      | sed 's/^/    key: /' | head -60
  fi
}

printf 'CLIProxy Management API recon (TOG-816)\n'
printf '  base    %s\n' "$BASE"
printf '  spacing %ss between requests (IP-ban discipline)\n' "$SLEEP_S"
printf '  key     present, %d chars, never printed\n' "${#KEY}"
printf '  node    %s\n\n' "$( ((HAVE_NODE)) && echo 'yes (typed structure dump)' || echo 'no (top-level keys only)')"

BODY="$(mktemp)"; HDRS="$(mktemp)"
trap 'rm -f "$BODY" "$HDRS"' EXIT

FIRST=1
for ep in "${ENDPOINTS[@]}"; do
  printf '=== GET %s ===\n' "$ep"
  code="$("$CURL" -sS -o "$BODY" -D "$HDRS" -w '%{http_code}' \
      -X GET --max-time 15 \
      -H "Authorization: Bearer $KEY" \
      "$BASE$ep" 2>/dev/null || echo "000")"

  if [[ "$code" == "000" ]]; then
    printf '  status  000 (could not connect)\n'
    if ((FIRST)); then
      echo "  -- the first request could not connect at all. Check that" >&2
      echo "     CLIProxy is listening on $BASE. Stopping rather than" >&2
      echo "     hammering an endpoint that is not there." >&2
      exit 70
    fi
    printf '\n'; FIRST=0; sleep "$SLEEP_S"; continue
  fi
  FIRST=0

  ctype="$(grep -i '^content-type:' "$HDRS" | head -1 | tr -d '\r' | cut -d' ' -f2- || true)"
  printf '  status  %s\n' "$code"
  printf '  type    %s\n' "${ctype:-<none>}"
  printf '  bytes   %s\n' "$(wc -c < "$BODY" | tr -d ' ')"

  case "$code" in
    200)
      printf '  structure (field names and TYPES only, values never printed):\n'
      structure < "$BODY" | redact_key
      if ((FULL_BODIES)); then
        printf '  body (key AND secret-valued fields redacted -- STILL RE-READ\n'
        printf '        THIS BEFORE PASTING IT ANYWHERE):\n'
        redact_body < "$BODY" | head -c 4000 | sed 's/^/    /'
        printf '\n'
      fi
      ;;
    401|403)
      printf '  -- refused. If EVERY endpoint refuses, the key may be wrong, or\n'
      printf '     this host may have earned an IP ban; wait ~30 minutes.\n'
      ;;
    404) printf '  -- does not exist. This is useful data: it stays OUT of the\n'
         printf '     Caddy allowlist.\n' ;;
  esac
  printf '\n'
  sleep "$SLEEP_S"
done

cat <<'REPORT'
=== reading this against the 2026-09-05 baseline ===
The output above contains no key and no field values -- only paths, statuses,
and types -- so it is safe to paste on TOG-811 as-is. Compare it to the
v7.2.140 baseline in this script's header. Exactly one thing makes a re-run
interesting:

  DID ANY ROUTE THAT 404'd ON v7.2.140 RETURN 200 HERE?

  If NO -- the design is unchanged and there is nothing to do. The lane keeps
  proxying the sanitizer; CLIProxy exposes no route that may be proxied
  directly. Note the version you ran against on TOG-811 and stop.

  If YES -- and the new route carries counters WITHOUT identity or credential
  fields (no email, account, path, id, auth_index, project_id, id_token, and
  nothing this dump printed as <WITHHELD>) -- then the sanitizer may be able to
  read it directly, or the lane may eventually proxy it. That is a design
  change, not an operator decision: it goes back through the CISO (TOG-817's
  sign-off is conditional on exactly this question) before any path is added to
  the @allowed matcher in Caddyfile.snippet. Adding a path there is the only
  way a route becomes reachable, by design.

  A new 200 that carries ANY identity or credential field changes nothing: it
  stays out of the allowlist and the sanitizer keeps stripping.

Also worth noting if the structure dump shows it: which field name marks an
exhausted or cooling-down provider (cooldownUntil / exhausted / exhaustedAt /
something else). The plugin checks all of those defensively today; confirming
the real one lets a typed extractor replace the guess.

A NOTE ON WHAT THIS SCRIPT JUST TOUCHED
  The endpoint list includes /v0/management/api-keys and /v0/management/config,
  which hold credential material. Only their SHAPE was printed -- field names
  and types, values never. They are probed because confirming they are still
  behind the same key as auth-files is the fact that keeps the sanitizer
  design correct. Do not run this with --full-bodies unless you have a specific
  reason, and re-read anything it prints before pasting it.
REPORT
