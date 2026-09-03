#!/usr/bin/env bash
# ===========================================================================
# breaker_cotenancy_probe.sh — name every OmniRoute lane where a single
# credit-metered model can take the whole connection down. (TOG-833.)
# ---------------------------------------------------------------------------
# WHAT THIS IS FOR.
#
# TOG-833: OmniRoute's `resolveTerminalConnectionStatus()`
# (`src/sse/services/auth.ts:396`) maps ANY HTTP 402 to a CONNECTION-wide
# terminal state. The per-model-quota lockout branch in `markAccountUnavailable()`
# (`auth.ts:2019-2027`) — which exists precisely to keep a multi-model
# connection alive when one model fails — fires only for
# `404 || 429 || >= 500`. **402 is not in that list.** So on a lane serving both
# a pay-per-token model and Claude, one out-of-credits model kills every model
# on that lane.
#
# It happened twice in production, both times a grok invoke reaching
# `cliproxy-main`, which carries all fleet Claude traffic:
#
#     2026-09-02 20:32-20:55Z    28 failed runs
#     2026-09-03 07:24-07:56Z    45 failed runs
#
# The mitigation applied 2026-09-03 was to set the credit-less xai auth file
# `disabled: true` inside CLIProxy, so `grok*` ids leave that ONE lane's
# catalogue. That mitigation is LANE-SCOPED. The defect is not. Any other lane
# advertising both classes is still one 402 away from the same outage, and
# nothing was watching for that.
#
# ---------------------------------------------------------------------------
# WHY IT READS THE CATALOGUE AND NOT THE CONNECTION STATE.
#
# The connection table is not reachable from an agent. Measured 2026-09-03: the
# OmniRoute API port serves OpenAI-compatible routes only —
# `/api/provider-connections`, `/api/connections`, `/api/providers` and
# `/health` all return HTTP 404 `API port only serves OpenAI-compatible
# routes.` The aggregate `GET /v1/models` IS reachable, and it is sufficient,
# because co-tenancy is a property of which ids a lane advertises.
#
# ---------------------------------------------------------------------------
# WHY IT DOES NOT TRY TO REPRODUCE THE 402. THIS IS THE POINT.
#
# Reproducing this defect means invoking an out-of-credits model through
# OmniRoute on a live lane — which trips the breaker and takes the fleet down.
# That is what the two incidents WERE. The standing operator guardrail is that
# suspect lanes are probed direct-to-cliproxy, never through OmniRoute. A probe
# that reproduced this bug would be the third incident. Exposure is measured
# statically or it is not measured.
#
# ---------------------------------------------------------------------------
# WHY ALIAS LANES ARE COLLAPSED.
#
# `cliproxy` and `openai-compatible-chat-1628780c-…` advertise byte-identical
# id sets — two names for one connection. Counting them separately would
# double-report a single exposure, inflating the number that is supposed to
# drive a decision. Lanes are grouped by served set and reported under all
# their names, so nobody greps for the wrong one and concludes it is clean.
#
# ---------------------------------------------------------------------------
# WHY `metered` IS A SUBSTRING LIST AND NOT A CAPABILITY LOOKUP.
#
# Only a model whose upstream bills per token can answer 402 "out of credits";
# a subscription/OAuth-backed model answers 401/429, which the lockout branch
# ALREADY handles per-model. The catalogue exposes no billing field, so the
# class is matched by id substring. That is a deliberate under-approximation:
# it can miss a metered family nobody has named yet, so a clean result means
# "no KNOWN trigger", never "no trigger". `--metered` extends the list without
# editing this file when a new one appears.
#
# ---------------------------------------------------------------------------
# EXIT CODES.  Zero findings is NOT the only green.
#
#   0  no co-tenant lane found, and the catalogue was actually read
#   3  at least one co-tenant lane — the TOG-833 blast radius is still live
#   5  UNKNOWN: catalogue unreadable, unparseable, or implausibly small
#
# Exit 5 exists because "no lane is exposed" and "no lane was examined" produce
# the same finding count of zero. An empty read scored green is a monitor
# reporting a safe fleet it never looked at — the exact failure this family of
# tools exists to end. MIN_MODELS_EXPECTED pins the floor.
#
# ---------------------------------------------------------------------------
# USAGE
#
#   ./breaker_cotenancy_probe.sh                      # live gateway
#   ./breaker_cotenancy_probe.sh --json               # machine-readable
#   ./breaker_cotenancy_probe.sh --metered grok,x-ai,glm
#   CATALOGUE_SOURCE_CMD='cat fixture.json' ./breaker_cotenancy_probe.sh
#
# CATALOGUE_SOURCE_CMD is how the suite runs this offline, the same way
# model_lane_probe.sh takes MODEL_SURFACE_SOURCE_CMD. A non-zero exit or empty
# stdout from that command is UNKNOWN, not clean.
# ===========================================================================
set -uo pipefail

BASE="${ANTHROPIC_BASE_URL:-http://omniroute:20129}"
KEY="${OMNIROUTE_API_KEY:-}"
MIN_MODELS_EXPECTED="${MIN_MODELS_EXPECTED:-200}"
METERED_TOKENS="${METERED_TOKENS:-grok,x-ai}"
PROTECTED_TOKENS="${PROTECTED_TOKENS:-claude}"
JSON_OUT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --json)    JSON_OUT=1; shift ;;
    --metered) METERED_TOKENS="${2:-}"; shift 2 ;;
    --protected) PROTECTED_TOKENS="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,90p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$METERED_TOKENS" ] || [ -z "$PROTECTED_TOKENS" ]; then
  # An empty class list matches nothing, so every lane would look clean. That
  # is a filter read as full coverage — refuse rather than report green.
  echo "UNKNOWN: empty --metered/--protected class list would match no id; refusing" >&2
  exit 5
fi

tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT

if [ -n "${CATALOGUE_SOURCE_CMD:-}" ]; then
  if ! eval "$CATALOGUE_SOURCE_CMD" >"$tmp" 2>/dev/null; then
    echo "UNKNOWN: CATALOGUE_SOURCE_CMD failed; exposure not measured" >&2
    exit 5
  fi
  if [ ! -s "$tmp" ]; then
    echo "UNKNOWN: CATALOGUE_SOURCE_CMD produced no output; exposure not measured" >&2
    exit 5
  fi
else
  code="$(curl -s -m 30 -o "$tmp" -w '%{http_code}' \
    -H "Authorization: Bearer ${KEY}" "${BASE%/}/v1/models" 2>/dev/null)"
  if [ "$code" != "200" ]; then
    echo "UNKNOWN: GET ${BASE%/}/v1/models -> HTTP ${code:-000}; exposure not measured" >&2
    exit 5
  fi
fi

MIN_MODELS_EXPECTED="$MIN_MODELS_EXPECTED" \
JSON_OUT="$JSON_OUT" \
METERED_TOKENS="$METERED_TOKENS" \
PROTECTED_TOKENS="$PROTECTED_TOKENS" \
python3 - "$tmp" <<'PY'
import json, os, sys, collections

MIN = int(os.environ["MIN_MODELS_EXPECTED"])
AS_JSON = os.environ["JSON_OUT"] == "1"
METERED = tuple(t.strip().lower() for t in os.environ["METERED_TOKENS"].split(",") if t.strip())
PROTECTED = tuple(t.strip().lower() for t in os.environ["PROTECTED_TOKENS"].split(",") if t.strip())

try:
    doc = json.load(open(sys.argv[1]))
    ids = [m["id"] for m in doc.get("data", []) if isinstance(m, dict) and m.get("id")]
except Exception as exc:
    print(f"UNKNOWN: catalogue did not parse: {exc}", file=sys.stderr)
    sys.exit(5)

if len(ids) < MIN:
    print(f"UNKNOWN: catalogue returned {len(ids)} ids, floor is {MIN}; "
          "a short read is not a safe fleet", file=sys.stderr)
    sys.exit(5)

lanes = collections.defaultdict(list)
for i in ids:
    lanes[i.split("/", 1)[0] if "/" in i else "(bare)"].append(i)

# Collapse alias lanes: identical served sets are one connection, one exposure.
by_set = collections.defaultdict(list)
for lane, members in lanes.items():
    served = frozenset(m.split("/", 1)[1] for m in members if "/" in m)
    by_set[served].append(lane)

findings = []
for served, names in by_set.items():
    members = lanes[names[0]]
    metered = sorted(m for m in members if any(t in m.lower() for t in METERED))
    protected = sorted(m for m in members if any(t in m.lower() for t in PROTECTED))
    if metered and protected:
        findings.append({
            "lane": sorted(names)[0],
            "aliases": sorted(names),
            "total_ids": len(members),
            "metered_ids": len(metered),
            "protected_ids": len(protected),
            "example_trigger": metered[0],
        })

findings.sort(key=lambda f: -f["protected_ids"])

if AS_JSON:
    print(json.dumps({
        "catalogue_ids": len(ids),
        "lanes_examined": len(by_set),
        "metered_classes": list(METERED),
        "exposed_lanes": findings,
    }, indent=2))
else:
    print(f"TOG-833 breaker co-tenancy probe — {len(ids)} ids, "
          f"{len(by_set)} distinct lanes (aliases collapsed)\n")
    if not findings:
        print(f"  no lane serves both a credit-metered ({', '.join(METERED)}) "
              f"and a protected ({', '.join(PROTECTED)}) id.")
        print("  NOTE: metered class is matched by id substring; this is an "
              "under-approximation, not a proof of zero triggers.")
    else:
        print(f"  {'lane':14} {'total':>6} {'metered':>8} {'prot':>7}  example 402 trigger")
        for f in findings:
            print(f"  {f['lane']:14} {f['total_ids']:6} {f['metered_ids']:8} "
                  f"{f['protected_ids']:7}  {f['example_trigger']}")
        print(f"\n  {len(findings)} lane(s) where one out-of-credits model can "
              "terminal-state every protected id on the same connection.")
        for f in findings:
            if len(f["aliases"]) > 1:
                print(f"    {f['lane']} also advertised as: "
                      f"{', '.join(a for a in f['aliases'] if a != f['lane'])}")

sys.exit(3 if findings else 0)
PY
