#!/usr/bin/env bash
# ===========================================================================
# test_breaker_cotenancy_probe.sh — offline suite for the TOG-833 breaker
# co-tenancy probe.
#
# No gateway: the catalogue arrives through CATALOGUE_SOURCE_CMD, the same way
# the surface rows arrive through MODEL_SURFACE_SOURCE_CMD in
# test_model_lane_probe.sh. That is what lets CI run this.
#
# THE FIXTURES ARE REAL. The shape and the finding below were measured against
# the live gateway on 2026-09-03, after the xai-disable mitigation:
#
#     1749 ids, 18 distinct lanes (aliases collapsed)
#     openrouter   975 ids,  23 metered, 113 claude
#     oc/opencode   94 ids,   3 metered,  43 claude   (one lane, two names)
#     tllm          26 ids,   1 metered,   6 claude
#     cliproxy      86 ids,   0 metered,  59 claude   <- mitigated, clean
#
# WHAT THIS SUITE IS BUILT TO CATCH, beyond the happy path:
#
#  * A MONITOR THAT READS GREEN WHILE BLIND. Section 3 asserts that an
#    unreadable source, empty output, unparseable JSON and a short read all
#    exit 5, never 0. Zero findings counted from a catalogue that never
#    answered is "never ran", not "no exposure". This is the assertion most
#    likely to be lost if someone rewrites the tool as a simple grep.
#
#  * THE ALIAS DOUBLE-COUNT. Section 2 pins that two prefixes advertising a
#    byte-identical id set are reported as ONE finding carrying both names.
#    A tool that counted prefixes would report the cliproxy lane twice and
#    inflate the exposure number the decision is made on.
#
#  * A FILTER READ AS FULL COVERAGE. Section 4 asserts an empty class list is
#    a REFUSAL (5), not a clean fleet — an empty substring list matches nothing
#    and every lane would look safe.
#
#  * THE MITIGATED LANE STAYING CLEAN. Section 1 pins that a lane with Claude
#    ids and no metered id produces no finding: that is the post-mitigation
#    cliproxy shape, and a regression there is the mitigation silently lapsing.
#
#  * ADJACENCY. Several inputs here would also be rejected by a neighbouring
#    guard, which is how an exit-code-only assertion goes green for the wrong
#    reason. Every assertion pins the REASON string as well as the exit status,
#    so a refusal from the wrong branch fails the test.
# ===========================================================================
set -uo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$HERE/breaker_cotenancy_probe.sh"
PASS=0; FAIL=0

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; }
sect() { printf '\n== %s\n' "$1"; }

# Build a catalogue fixture. Args: name, then `prefix:count:kind` triples where
# kind is claude|metered|other. `alias=` duplicates a prefix's exact id set.
mkcat() {
  local out="$WORK/$1.json"; shift
  python3 - "$out" "$@" <<'PY'
import json, sys
out, specs = sys.argv[1], sys.argv[2:]
ids, sets = [], {}
for spec in specs:
    if spec.startswith("alias="):
        new, src = spec[6:].split(":", 1)
        ids += [f"{new}/{s}" for s in sets[src]]
        continue
    prefix, count, kind = spec.split(":")
    names = []
    for i in range(int(count)):
        if kind == "claude":     names.append(f"claude-model-{i}")
        elif kind == "metered":  names.append(f"grok-{i}.6")
        else:                    names.append(f"gpt-thing-{i}")
    sets.setdefault(prefix, []).extend(names)
    ids += [f"{prefix}/{n}" for n in names]
json.dump({"data": [{"id": i} for i in ids]}, open(out, "w"))
PY
  echo "$out"
}

run() {  # run <fixture-or-cmd> [args...] -> sets RC / OUT / ERR
  local src="$1"; shift
  OUT="$(CATALOGUE_SOURCE_CMD="$src" MIN_MODELS_EXPECTED="${MIN:-10}" \
         bash "$TOOL" "$@" 2>"$WORK/err")"; RC=$?
  ERR="$(cat "$WORK/err")"
}

# ---------------------------------------------------------------------------
sect "1. exposure detection and the mitigated-lane baseline"

CLEAN="$(mkcat clean cliproxy:60:claude cliproxy:26:other)"
run "cat $CLEAN"
[ "$RC" = 0 ] && ok "a lane with Claude ids and no metered id exits 0" \
              || bad "clean lane exited $RC (want 0)"
case "$OUT" in *"no lane serves both"*) ok "clean run names why it is clean";;
                *) bad "clean run did not state the finding";; esac
case "$OUT" in *"under-approximation"*) ok "clean run discloses substring matching is not proof";;
                *) bad "clean run overstates its certainty";; esac

EXPOSED="$(mkcat exposed cliproxy:60:claude cliproxy:1:metered)"
run "cat $EXPOSED"
[ "$RC" = 3 ] && ok "one metered id beside Claude ids exits 3" \
              || bad "exposed lane exited $RC (want 3)"
case "$OUT" in *"grok-0.6"*) ok "the example 402 trigger is named";;
                *) bad "finding did not name a trigger id";; esac

# A metered id with NO protected id on the lane is not this defect: the 402
# still terminal-states the connection, but nothing valuable rides it.
ONLYMET="$(mkcat onlymet opencode-go:50:metered opencode-go:8:other)"
run "cat $ONLYMET"
[ "$RC" = 0 ] && ok "metered ids with no protected id on the lane exits 0" \
              || bad "metered-only lane exited $RC (want 0)"

# ---------------------------------------------------------------------------
sect "2. alias lanes collapse to one finding"

ALIAS="$(mkcat alias cliproxy:60:claude cliproxy:1:metered alias=openai-compatible-chat-1628780c:cliproxy)"
run "cat $ALIAS"
[ "$RC" = 3 ] && ok "aliased exposed lane still exits 3" \
              || bad "aliased lane exited $RC (want 3)"
case "$OUT" in *"1 lane(s) where"*) ok "two names for one connection count as ONE exposure";;
                *) bad "alias lane double-counted: $(printf '%s' "$OUT" | grep 'lane(s)')";; esac
case "$OUT" in *"also advertised as"*) ok "both alias names are reported";;
                *) bad "alias name withheld — a grep for it would read clean";; esac

# Two lanes with genuinely different id sets must NOT collapse.
TWO="$(mkcat two cliproxy:60:claude cliproxy:1:metered tllm:20:claude tllm:2:metered)"
run "cat $TWO"
case "$OUT" in *"2 lane(s) where"*) ok "distinct lanes are counted separately";;
                *) bad "distinct lanes wrongly collapsed";; esac

# ---------------------------------------------------------------------------
sect "3. a blind monitor is UNKNOWN, never green"

run "false"
[ "$RC" = 5 ] && ok "source command failing exits 5" || bad "failing source exited $RC (want 5)"
case "$ERR" in *"CATALOGUE_SOURCE_CMD failed"*) ok "failure names the source, not a lane verdict";;
                *) bad "wrong refusal reason: $ERR";; esac

run "true"
[ "$RC" = 5 ] && ok "empty source output exits 5" || bad "empty output exited $RC (want 5)"
case "$ERR" in *"no output"*) ok "empty read is reported as unmeasured";;
                *) bad "wrong refusal reason: $ERR";; esac

printf 'not json at all' > "$WORK/bad.json"
run "cat $WORK/bad.json"
[ "$RC" = 5 ] && ok "unparseable catalogue exits 5" || bad "bad JSON exited $RC (want 5)"
case "$ERR" in *"did not parse"*) ok "parse failure is distinguished from a clean fleet";;
                *) bad "wrong refusal reason: $ERR";; esac

# An empty data array parses fine and finds nothing. That is the fail-open.
printf '{"data":[]}' > "$WORK/empty.json"
run "cat $WORK/empty.json"
[ "$RC" = 5 ] && ok "zero ids exits 5, not 0" || bad "empty catalogue exited $RC (want 5)"
case "$ERR" in *"floor is"*) ok "the floor is named in the refusal";;
                *) bad "wrong refusal reason: $ERR";; esac

# A short read is the live-gateway version of the same fail-open: a partial
# catalogue can omit the very lane that is exposed.
MIN=500 run "cat $EXPOSED"
[ "$RC" = 5 ] && ok "a read below MIN_MODELS_EXPECTED exits 5 even though a finding exists" \
              || bad "short read exited $RC (want 5)"

# ---------------------------------------------------------------------------
sect "4. a filter matching nothing is a refusal, not a clean fleet"

run "cat $EXPOSED" --metered ""
[ "$RC" = 5 ] && ok "empty --metered list exits 5" || bad "empty metered exited $RC (want 5)"
case "$ERR" in *"would match no id"*) ok "the refusal explains the coverage gap";;
                *) bad "wrong refusal reason: $ERR";; esac

run "cat $EXPOSED" --protected ""
[ "$RC" = 5 ] && ok "empty --protected list exits 5" || bad "empty protected exited $RC (want 5)"

# Extending the class list must find a lane the default misses.
GLM="$(mkcat glm somelane:40:claude)"
python3 - "$GLM" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); d["data"].append({"id":"somelane/glm-4.6"})
json.dump(d, open(sys.argv[1],"w"))
PY
run "cat $GLM"
[ "$RC" = 0 ] && ok "an unlisted metered family is missed by default (documented limit)" \
              || bad "default class list unexpectedly matched glm"
run "cat $GLM" --metered grok,x-ai,glm
[ "$RC" = 3 ] && ok "--metered extends coverage without editing the tool" \
              || bad "--metered extension exited $RC (want 3)"

# ---------------------------------------------------------------------------
sect "5. --json carries the same verdict as the text form"

run "cat $ALIAS" --json
[ "$RC" = 3 ] && ok "--json preserves the exit code" || bad "--json exited $RC (want 3)"
printf '%s' "$OUT" | python3 -c "
import json,sys
d=json.load(sys.stdin)
f=d['exposed_lanes']
assert len(f)==1, f'want 1 exposed lane, got {len(f)}'
assert len(f[0]['aliases'])==2, 'aliases not carried into json'
assert f[0]['example_trigger'].startswith('cliproxy/grok'), f[0]['example_trigger']
assert d['catalogue_ids']==122, d['catalogue_ids']
" 2>"$WORK/jerr" && ok "--json body matches the text finding" \
                 || bad "--json body wrong: $(cat "$WORK/jerr")"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
