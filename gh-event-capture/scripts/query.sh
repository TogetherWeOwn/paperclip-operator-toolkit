#!/usr/bin/env bash
# query.sh — read the event store from a terminal.
#
# "A store nobody can search is not a control". The Worker exposes
# the search; this is the thing an operator actually reaches for at 2am so they
# are not hand-rolling a bearer header under pressure.
#
#   GH_CAPTURE_URL    base URL of the deployed Worker, no trailing slash
#   GH_CAPTURE_TOKEN  the QUERY_TOKEN secret
#
# Both from the inherited environment, never argv — /proc/*/cmdline is
# world-readable by other processes on the host. The token is
# written into a curl --config file for the same reason.
#
# Usage:
#   ./query.sh stats
#   ./query.sh events [key=value ...]
#   ./query.sh get <delivery-id>
#   ./query.sh joins                 # repos added to / removed from the installation
#   ./query.sh bridged [issue_ref=PREFIX-n] [limit=N]   # the wake ledger
#   ./query.sh bridged-daily [issue_ref=PREFIX-n]       # bridged, grouped by UTC day
#
# Filters accepted by `events`: event, action, repository, sender, organization,
# delivery_id, since, until, limit, cursor, include_body. An unknown one is a
# 400 from the Worker, on purpose — a silently-dropped filter returns more rows
# than you asked for and reads like "nothing was excluded".
#
# Filters accepted by `bridged`: issue_ref, limit (max 500). `bridged-daily`
# fetches the same set at limit=500 and groups client-side in node — there is
# no server-side day grouping for this one low-traffic table, so this stays
# the query script's job rather than new Worker surface. Node, not jq: this
# repo assumes node (see check-subscription.sh), never jq, is on the box.
#
# Exit status is the gate: 0 on HTTP 2xx, 1 otherwise.

set -euo pipefail

die() { echo "query: $*" >&2; exit 2; }

[ -n "${GH_CAPTURE_URL:-}" ] || die "GH_CAPTURE_URL is not set"
[ -n "${GH_CAPTURE_TOKEN:-}" ] || die "GH_CAPTURE_TOKEN is not set"
command -v curl >/dev/null || die "curl is required"

work="$(mktemp -d)"; chmod 700 "$work"
trap 'rm -rf "$work"' EXIT INT TERM
umask 077
printf 'header = "Authorization: Bearer %s"\n' "$GH_CAPTURE_TOKEN" > "$work/curlrc"

# urlencode a query value without assuming python3/jq is present.
enc() {
  local s="$1" out="" c
  for (( i=0; i<${#s}; i++ )); do
    c="${s:i:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) out+="$c" ;;
      *) out+="$(printf '%%%02X' "'$c")" ;;
    esac
  done
  printf '%s' "$out"
}

# Fetches into $work/out and returns the gate status, without printing —
# `fetch` below is the normal (printing) entry point; `bridged-daily` uses this
# directly because it prints a computed summary instead of the raw body.
fetch_body() {
  local path="$1" status rc=0
  status="$(curl -sS --max-time 30 --config "$work/curlrc" -o "$work/out" -w '%{http_code}' "$GH_CAPTURE_URL$path")" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "query: transport failed (curl exit $rc, HTTP ${status:-unknown})" >&2
    return 1
  fi
  case "$status" in
    2*) return 0 ;;
    401) echo "query: 401 — GH_CAPTURE_TOKEN is wrong or unset on the Worker" >&2; return 1 ;;
    503) echo "query: 503 — the Worker has no QUERY_TOKEN secret set; it is failing closed" >&2; return 1 ;;
    *)   echo "query: HTTP $status" >&2; return 1 ;;
  esac
}

fetch() {
  local path="$1"
  fetch_body "$path" || return 1
  cat "$work/out"
  echo
}

cmd="${1:-}"; shift || true

case "$cmd" in
  stats)
    fetch "/stats"
    ;;
  events)
    qs=""
    for pair in "$@"; do
      case "$pair" in
        *=*) : ;;
        *) die "filters must be key=value, got: $pair" ;;
      esac
      qs+="${qs:+&}$(enc "${pair%%=*}")=$(enc "${pair#*=}")"
    done
    fetch "/events${qs:+?$qs}"
    ;;
  get)
    [ $# -eq 1 ] || die "usage: query.sh get <delivery-id>"
    fetch "/events/$(enc "$1")"
    ;;
  joins)
    # The question this store was built to answer: did a repository quietly join
    # the org-admin installation? That transition arrives on
    # installation_repositories, not on installation.
    fetch "/events?event=installation_repositories&include_body=1&limit=100"
    ;;
  bridged)
    qs=""
    for pair in "$@"; do
      case "$pair" in
        *=*) : ;;
        *) die "filters must be key=value, got: $pair" ;;
      esac
      qs+="${qs:+&}$(enc "${pair%%=*}")=$(enc "${pair#*=}")"
    done
    fetch "/bridge/claims${qs:+?$qs}"
    ;;
  bridged-daily)
    qs="limit=500"
    for pair in "$@"; do
      case "$pair" in
        issue_ref=*) : ;;
        *) die "bridged-daily accepts only issue_ref=..., got: $pair" ;;
      esac
      qs+="&$(enc "${pair%%=*}")=$(enc "${pair#*=}")"
    done
    fetch_body "/bridge/claims?$qs" || exit 1
    # Group by the UTC day in claimed_at. node, not jq — see the header note.
    node -e '
      const data = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
      const byDay = new Map()
      for (const c of data.claims ?? []) {
        const day = String(c.claimed_at ?? "").slice(0, 10) || "unknown"
        byDay.set(day, (byDay.get(day) ?? 0) + 1)
      }
      const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))
      for (const [day, count] of days) console.log(`${day}  ${count}`)
      if (days.length === 0) console.log("no claims in the fetched window")
    ' "$work/out"
    ;;
  ""|-h|--help|help)
    # Print usage and refuse. Never fall through to a request: the default for
    # an unrecognised input in this repo is refusal, not action.
    sed -n '2,34p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
  *)
    die "unknown command: $cmd"
    ;;
esac
