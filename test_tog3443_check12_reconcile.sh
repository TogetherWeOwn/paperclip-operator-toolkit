#!/usr/bin/env bash
# ===========================================================================
# test_tog3443_check12_reconcile.sh — check 12 measures the EFFECTIVE two-layer
# boundary, and reconciles nothing it did not verify on the same run.
#
# THE BUG THIS PINS (TOG-3443). Check 12 (merged PR #352) diffed each live
# agent's GitHub tool-gateway ceiling against tool_grant_expectations.json and
# emitted 18 standing OVER-GRANT findings — every granted agent holds the same
# uniform 45-entry native bundle including delete_file. But the gateway tier is
# only layer 1. Layer 2 — the per-project GitHub App installation-token scope
# (GH_APP_SCOPE_STRICT=1 + fixed GH_APP_REPOS + capped GH_APP_PERMISSIONS) —
# is the real capability boundary: it is what keeps a destructive-tier gateway
# grant to recoverable file deletes. A check that measures layer 1 and reports
# the uniform bundle as 18 independent over-grants is a check nobody reads, so
# a REAL exposure — an unpinned project, a widened permission, an unverifiable
# boundary — would arrive as line 19 and be skipped.
#
# THE RECONCILIATION. Layer-1 over-grants covered by accepted-risk record
# 40405f9b-5f44-4925-8589-51e9f1b32302 rev 1 read as ACCEPTED-RISK only while
# layer 2 re-verifies intact on the SAME run (every non-fleet project pinned,
# Fleet exception by id in its recorded 409-denying shape). Anything
# unverifiable fails closed: the raw over-grant findings return. UNDER-GRANTs
# are never reconciled — a missing grant is not accepted risk.
#
# WHY TWO HALVES. §2 asserts TEXT properties of the block (fail-closed shape,
# no credential on argv, exact scope.js mirror, narrow Fleet exception). §4
# runs the block for real against canned fixtures with a stubbed sql() — the
# layer-2 path is pure bash+jq behind a CHECK12_PROJECTS_JSON override, so
# unlike check 9 this half executes offline with no database. §3 is the
# load-bearing part, as in the TOG-994 suite: it applies the exact weakening
# the wake forbade (unconditional ACCEPTED-RISK) and requires the guard to go
# RED on it, so a grep that matches nothing cannot pass.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REVIEW="${ORG_ACCESS_REVIEW_SH:-$HERE/org_access_review.sh}"
MAP="${TOOL_GRANT_MAP:-$HERE/tool_grant_expectations.json}"
PASS=0; FAIL=0
ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

[[ -r "$REVIEW" ]] || { echo "no readable org_access_review.sh at $REVIEW" >&2; exit 2; }
[[ -r "$MAP" ]] || { echo "no readable tool_grant_expectations.json at $MAP" >&2; exit 2; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

# The check-12 block, sliced out of the tool by its own delimiters so this
# suite reads the SAME text the tool runs rather than a copy that rots. The
# closing `fi` is matched at column 0 only — the block's inner ifs are all
# indented — so the slice ends at check 12's own close.
extract_check12() {
  awk '/^TOOL_MAP=/{f=1} f{print} f&&/^fi$/{exit}' "$1"
}

BLOCK="$(extract_check12 "$REVIEW")"

hdr "1. The check-12 block is still locatable and two-layer"
if [[ -z "$BLOCK" ]]; then
  bad "could not slice the check-12 block out of $REVIEW"
  printf '\n\033[1m%d passed, %d failed\033[0m\n' "$PASS" "$((FAIL+1))"
  exit 1
fi
ok "sliced the check-12 block ($(wc -l <<<"$BLOCK") lines)"
grep -q 'RECONCILE' <<<"$BLOCK" \
  && ok "the slice contains the layer-2 reconciliation logic" \
  || bad "the slice has no RECONCILE logic — it is not the reconciled check"
grep -q 'TOOL-GATEWAY OVER-GRANT' <<<"$BLOCK" \
  && ok "the slice retains the raw layer-1 over-grant finding" \
  || bad "the raw over-grant finding is gone — the check was weakened, not reconciled"

hdr "2. Fail-closed shape (static)"
grep -q '^  RECONCILE=0$' <<<"$BLOCK" \
  && ok "reconciliation starts REFUSED (RECONCILE=0) and must be earned" \
  || bad "RECONCILE is not initialized to 0 — fail-closed is not the default"
grep -q '"$RECONCILE" == "1"' <<<"$BLOCK" \
  && ok "the ACCEPTED-RISK verdict is conditioned on the live RECONCILE variable" \
  || bad "no live RECONCILE gate on the verdict — accepted risk may be unconditional"
grep -q 'accepted-risk record drifted' <<<"$BLOCK" \
  && ok "script/map drift on the accepted-risk record refuses reconciliation" \
  || bad "no drift refusal: the map could widen coverage without the script noticing"
stands="$(grep -c 'all layer-1 over-grants stand' <<<"$BLOCK")"
[[ "$stands" -ge 3 ]] \
  && ok "every unverifiable path says the raw findings return ($stands fail-closed notes)" \
  || bad "only $stands fail-closed note(s) — some unverifiable path may go quiet"
grep -q 'TOOL-GATEWAY UNDER-GRANT' <<<"$BLOCK" \
  && ok "the under-grant finding still exists" \
  || bad "the under-grant finding is gone"
if grep "UNDER-GRANT" <<<"$BLOCK" | grep -q 'ACCEPTED-RISK'; then
  bad "an under-grant can read as ACCEPTED-RISK — a missing grant is never accepted risk"
else
  ok "no under-grant line mentions ACCEPTED-RISK"
fi

hdr "2b. No credential on argv; exact scope.js mirror; narrow exceptions"
grep -q 'curl --config' <<<"$BLOCK" \
  && ok "the project list is fetched via a --config file (secret by inherited env)" \
  || bad "no curl --config fetch — the API key may be headed for argv"
if grep -q 'curl -H' <<<"$BLOCK"; then
  bad "curl -H in the block puts a credential on argv (ps/history leak)"
else
  ok "no curl -H in the block — nothing credential-bearing on argv"
fi
grep -q 'type == "plain"' <<<"$BLOCK" \
  && ok "lit() accepts the tagged plain form scope.js accepts" \
  || bad "lit() lost the plain-form branch — every tagged project reads unpinned"
if grep -q 'type == null' <<<"$BLOCK" || grep -q 'map(tostring)' <<<"$BLOCK"; then
  bad "lit() accepts bare objects/arrays that scope.js treats as ABSENT — projects the broker 409-refuses would read as pinned"
else
  ok "lit() mirrors scope.js literal() exactly (bare string or plain only)"
fi
grep -q 'isfleet.*-z "\$pstrict".*-z "\$prepos".*-z "\$pperms".*-z "\$prepo"' <<<"$BLOCK" \
  && ok "the Fleet exception matches ONLY the recorded shape (no pins, no repo)" \
  || bad "the Fleet exception widened — some other Fleet shape could slip through"
grep -q 'pperms.*=~' <<<"$BLOCK" \
  && ok "the =admin cap check is a value-anchored match, not a substring" \
  || bad "the =admin check is a substring match — a value merely containing it misfires"
grep -q 'CHECK12_PROJECTS_JSON' <<<"$BLOCK" \
  && ok "a fixture override exists for offline/CI use" \
  || bad "no CHECK12_PROJECTS_JSON override — the layer is untestable offline"
# The emitted rows are read with IFS='|' (see below); tab is IFS whitespace,
# so @tsv would collapse the empty middle fields — the EXPOSED signal — into
# the wrong columns. This guard pins the delimiter choice.
if grep -q '@tsv' <<<"$BLOCK"; then
  bad "layer-2 rows use @tsv — empty unpinned fields collapse under IFS read; use join(\"|\")"
else
  ok "no @tsv in the block — empty fields cannot collapse"
fi
grep -q 'join("|")' <<<"$BLOCK" \
  && ok "layer-2 rows are pipe-joined, matching the IFS='|' read" \
  || bad "layer-2 rows are not pipe-joined — the read loop misaligns columns"
grep -q "IFS='|' read -r pid pstrict prepos pperms prepo isfleet" <<<"$BLOCK" \
  && ok "the layer-2 read loop splits on pipe" \
  || bad "the layer-2 read loop does not split on pipe"

hdr "2c. Script and map agree on the accepted-risk record"
doc_sh="$(sed -n 's/^  ACCEPTED_RISK_DOC="\(.*\)"/\1/p' <<<"$BLOCK")"
rev_sh="$(sed -n 's/^  ACCEPTED_RISK_REV="\(.*\)"/\1/p' <<<"$BLOCK")"
doc_map="$(jq -r '._acceptedRiskTOG3443.docId // empty' "$MAP")"
rev_map="$(jq -r '._acceptedRiskTOG3443.rev // empty' "$MAP")"
fleet_map="$(jq -r '._acceptedRiskTOG3443.fleetProjectId // empty' "$MAP")"
if [[ -n "$doc_sh" && "$doc_sh" == "$doc_map" && -n "$rev_sh" && "$rev_sh" == "$rev_map" && -n "$fleet_map" ]]; then
  ok "script constants match the map (doc $doc_sh rev $rev_sh, fleet exception by id)"
else
  bad "script/map drift: script wants doc '${doc_sh:-?}' rev '${rev_sh:-?}', map holds doc '${doc_map:-?}' rev '${rev_map:-?}' fleet '${fleet_map:-?}'"
fi

# --- §4's harness: run the REAL block with a stubbed sql() ------------------
# Canned verdict-loop rows are role|template|title|actual, the shape of the
# layer-1 SQL output. Templates resolve against a minimal map written per run.
STANDARD_MAP='{"templateDefaults":{"B2_TECH_CHIEF":"write","P3_AUDIT_RISK":"read","C1_DIRECTOR_BUILDER":"write"},"titleOverrides":{"Web Engineer":"write"},"_acceptedRiskTOG3443":{"docId":"40405f9b-5f44-4925-8589-51e9f1b32302","rev":1,"owner":"P4_PROVISIONING_STEWARD","fleetProjectId":"fleet-proj-1"}}'
DRIFTED_MAP='{"templateDefaults":{"B2_TECH_CHIEF":"write"},"_acceptedRiskTOG3443":{"docId":"00000000-0000-0000-0000-000000000000","rev":99,"owner":"P4_PROVISIONING_STEWARD","fleetProjectId":"fleet-proj-1"}}'
ALL_ROWS='|B2_TECH_CHIEF|CTO Platform|destructive
|P3_AUDIT_RISK|Staff Auditor|none
|C1_DIRECTOR_BUILDER|Web Engineer|write
||cron-sidecar|read'

run_check12() { # $1 = projects fixture (empty = none), $2 = sql rows, $3 = map json
  local fix="$1" rows="$2" mapjson="${3:-$STANDARD_MAP}"
  local tdir; tdir="$(mktemp -d)"
  local tmap="$tdir/map.json"
  printf '%s\n' "$mapjson" > "$tmap"
  local harness="$tdir/h.sh"
  {
    printf 'set -uo pipefail\n'
    # Isolate from any inherited control-plane env: a leaked API key would
    # turn the "unverifiable" case into a live network call.
    printf 'unset PAPERCLIP_API_KEY PAPERCLIP_API_URL\n'
    printf 'TOOL_MAP=%q\n' "$tmap"
    printf 'COMPANY_ID=00000000-0000-0000-0000-000000000000\n'
    printf 'SQL_ROWS=%q\n' "$rows"
    printf 'CHECK12_PROJECTS_JSON=%q\n' "$fix"
    printf 'LAYER2_JSON="$(mktemp)"; LAYER2_LINES="$(mktemp)"\n'
    printf 'note() { printf "FINDING: %%s\\n" "$1"; }\n'
    printf 'good() { printf "OK: %%s\\n" "$1"; }\n'
    printf 'hdr()  { printf "HDR: %%s\\n" "$1"; }\n'
    printf 'sql()  { printf "%%s\\n" "$SQL_ROWS"; }\n'
    extract_check12 "$REVIEW"
    printf 'rm -f "$LAYER2_JSON" "$LAYER2_LINES"\n'
  } > "$harness"
  bash "$harness"
  rm -rf "$tdir"
}

cat > "$WORK/intact.json" <<'EOF'
[{"id":"p1","env":{"GH_APP_SCOPE_STRICT":"1","GH_APP_REPOS":"TogetherWeOwn/paperclip-ops-tooling","GH_APP_PERMISSIONS":"contents=write"},"repoUrl":"https://github.com/TogetherWeOwn/paperclip-ops-tooling"},
 {"id":"p2","env":{"GH_APP_SCOPE_STRICT":{"type":"plain","value":"1"},"GH_APP_REPOS":{"type":"plain","value":"o/r"},"GH_APP_PERMISSIONS":{"type":"plain","value":"contents=write"}},"repoUrl":"https://github.com/o/r"},
 {"id":"fleet-proj-1","env":{},"repoUrl":""}]
EOF
cat > "$WORK/exposed.json" <<'EOF'
[{"id":"p1","env":{"GH_APP_SCOPE_STRICT":{"type":"secret_ref","secretId":"00000000-0000-0000-0000-000000000000"},"GH_APP_REPOS":"o/r","GH_APP_PERMISSIONS":"contents=write"},"repoUrl":"https://github.com/o/r"}]
EOF
cat > "$WORK/admin.json" <<'EOF'
[{"id":"p1","env":{"GH_APP_SCOPE_STRICT":"1","GH_APP_REPOS":"o/r","GH_APP_PERMISSIONS":"contents=write, administration=admin"},"repoUrl":"https://github.com/o/r"}]
EOF

hdr "4a. Intact layer 2 reconciles the over-grant, keeps the rest"
OUT_A="$(run_check12 "$WORK/intact.json" "$ALL_ROWS")"
grep -q 'ACCEPTED-RISK' <<<"$OUT_A" \
  && ok "over-grant reads as ACCEPTED-RISK while the token layer verifies intact" \
  || bad "intact layer 2 did not reconcile the over-grant — output was: $OUT_A"
if grep -q 'TOOL-GATEWAY OVER-GRANT' <<<"$OUT_A"; then
  bad "raw OVER-GRANT finding survived reconciliation"
else
  ok "no raw OVER-GRANT finding remains after reconciliation"
fi
grep -q 'TOOL-GATEWAY UNDER-GRANT' <<<"$OUT_A" \
  && ok "the under-grant still stands (never accepted risk)" \
  || bad "reconciliation swallowed the under-grant"
grep -q 'token-scope layer intact: 2 non-fleet' <<<"$OUT_A" \
  && ok "both pin spellings (bare string, tagged plain) counted as pinned" \
  || bad "pin spellings undercounted — output was: $OUT_A"
grep -q 'matches expectation' <<<"$OUT_A" \
  && ok "matching ceilings still report clean" \
  || bad "matching ceiling lost its clean verdict"
grep -q 'server built-in' <<<"$OUT_A" \
  && ok "built-in agents still report clean" \
  || bad "built-in row lost its clean verdict"
grep -q 'Fleet Intelligence' <<<"$OUT_A" \
  && ok "the Fleet residual is still flagged (exception, not a pass)" \
  || bad "the Fleet residual went silent"

hdr "4b. Exposed layer 2 returns the raw findings"
OUT_B="$(run_check12 "$WORK/exposed.json" "$ALL_ROWS")"
grep -q 'TOOL-GATEWAY OVER-GRANT' <<<"$OUT_B" \
  && ok "a secret_ref-scoped project breaks the layer and the over-grant stands" \
  || bad "exposed layer 2 still reconciled — output was: $OUT_B"
if grep -q 'ACCEPTED-RISK' <<<"$OUT_B"; then
  bad "ACCEPTED-RISK printed with a broken token layer"
else
  ok "no ACCEPTED-RISK with a broken token layer"
fi
OUT_B2="$(run_check12 "$WORK/admin.json" "$ALL_ROWS")"
grep -q 'TOOL-GATEWAY OVER-GRANT' <<<"$OUT_B2" \
  && ok "=admin permissions break the write cap and the over-grant stands" \
  || bad "=admin permissions still reconciled — output was: $OUT_B2"

hdr "4c. Unverifiable layer 2 fails closed"
OUT_C="$(run_check12 "" "$ALL_ROWS")"
grep -q 'UNVERIFIABLE' <<<"$OUT_C" \
  && ok "a missing fixture with no API env says UNVERIFIABLE, not clean" \
  || bad "unverifiable layer went quiet — output was: $OUT_C"
grep -q 'TOOL-GATEWAY OVER-GRANT' <<<"$OUT_C" \
  && ok "the over-grant stands when the layer cannot be verified" \
  || bad "unverifiable layer still reconciled"

hdr "4d. Drifted map refuses reconciliation"
OUT_D="$(run_check12 "$WORK/intact.json" "$ALL_ROWS" "$DRIFTED_MAP")"
grep -q 'accepted-risk record drifted' <<<"$OUT_D" \
  && ok "a drifted map refuses reconciliation even with an intact layer" \
  || bad "drifted map still reconciled — output was: $OUT_D"
grep -q 'TOOL-GATEWAY OVER-GRANT' <<<"$OUT_D" \
  && ok "the over-grant stands under a drifted map" \
  || bad "drifted map swallowed the finding"

hdr "3. Positive control — the guard goes RED on the forbidden weakening"
# The exact edit the wake forbade: make reconciliation unconditional by
# constant-folding the RECONCILE gate. The §2 live-variable guard must reject
# the mutant, and the mutant must still parse (else the red is meaningless).
MUTANT="$WORK/mutant.sh"
sed 's/\[\[ "\$RECONCILE" == "1" \]\]/[[ "1" == "1" ]]/' "$REVIEW" > "$MUTANT"
mutant_block="$(extract_check12 "$MUTANT")"
if grep -q '"\$RECONCILE" == "1"' <<<"$mutant_block"; then
  bad "the mutation did not actually constant-fold the RECONCILE gate"
else
  ok "the mutation removes the live gate as intended"
  if grep -q '"$RECONCILE" == "1"' <<<"$mutant_block"; then
    bad "the guard ACCEPTS the always-reconcile text — §2 asserts nothing"
  else
    ok "the guard REJECTS the always-reconcile text — it would have caught the weakening"
  fi
fi
bash -n "$MUTANT" 2>/dev/null \
  && ok "the weakened reconstruction parses — §3's red is about the gate, not garbage" \
  || bad "the weakened reconstruction does not parse; §3's result is meaningless"

hdr "5. The tool and the map still parse"
bash -n "$REVIEW" 2>/dev/null && ok "org_access_review.sh parses" || bad "org_access_review.sh does not parse"
jq -e . "$MAP" >/dev/null 2>&1 && ok "tool_grant_expectations.json parses" || bad "tool_grant_expectations.json does not parse"

printf '\n\033[1m%d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
