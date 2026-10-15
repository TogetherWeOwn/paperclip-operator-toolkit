#!/usr/bin/env bash
# Repo-placement acceptance test for Land #940: the org SSRF/redirect +
# extended-secrets security packs.
#
# THE RISK THIS EXISTS FOR. The security packs (four WARN-first
# SSRF/open-redirect rules, six ERROR provider-shaped secret rules, the
# shared CodeQL security-extended config, the post-pin additions manifest,
# the staged security-rules contract, and the two zero-FP shapes in the
# always-run local secret scan) were authored for the private ops repo,
# and the repo-placement gate answers that every one of those files is
# public-able and belongs in THIS public repo. Until the staged files are
# mirrored here, the landing is not complete: the private repo carries
# public code the gate refuses, and no repo cut from the org gets the
# deterministic SSRF/redirect/secrets coverage.
#
# What this pins, hermetically (no network, no credential):
#   1. the staged rule packs exist at templates/org-github/ at the same
#      relative paths the rollout consumes;
#   2. the port-additions manifest exists and lists exactly the post-pin
#      rule files in the machine-list shape the drift gate parses;
#   3. the staged security-rules contract suite is mirrored with them;
#   4. the tree README maps every staged file to its destination, so a
#      file added to the stage cannot silently lack an apply path;
#   5. the always-run local secret scan covers the two zero-FP shapes
#      (long-id webhooks, live Stripe keys);
#   6. this repo's CI actually runs a security-rules suite, so the
#      contract cannot rot unwired. Any step in .github/workflows/ci.yml
#      naming security_rules, security-rules, security_packs or
#      security-packs satisfies this; the Builder picks the wording.
#
# RED (before the fix): assertions fail -- the staged tree is absent,
# which IS the placement risk reproduced. GREEN (after): all pass. The
# Builder mirrors the staged files on this branch without touching test
# files. The behavioral contract lives in
# test_security_packs_acceptance.py.
# Exit 0 all green, 1 anything red. Requires bash.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="$HERE/templates/org-github"
RULES="$BASE/tier-0/semgrep-rules"
PASS=0; FAIL=0

ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# assert <status> <label> [diagnostic]
# ONE label per assertion, printed identically whether it passes or fails.
assert() {
  local status="$1" label="$2" diag="${3:-}"
  if [[ "$status" -eq 0 ]]; then ok "$label"; else
    bad "$label"
    [[ -n "$diag" ]] && printf '        %s\n' "$diag"
  fi
  return 0
}

STAGED=(
  "tier-0/semgrep-rules/security-ssrf-redirect.yaml"
  "tier-0/semgrep-rules/security-secrets-extended.yaml"
  "codeql/codeql-config.yml"
  "tier-0/PORT-ADDITIONS.md"
  "tests/test_security_rules.sh"
  "README.md"
)

hdr "Repo-placement: the public security packs live in the public repo"

for rel in "${STAGED[@]}"; do
  [[ -f "$BASE/$rel" ]]
  assert $? "staged file mirrored at templates/org-github/$rel" \
    "absent -- placement risk reproduced (private repo carries public code)"
done

hdr "Manifest: post-pin additions listed in the machine shape"

MANIFEST="$BASE/tier-0/PORT-ADDITIONS.md"
if [[ -f "$MANIFEST" ]]; then
  for rule in security-ssrf-redirect.yaml security-secrets-extended.yaml; do
    grep -qE "^- \`semgrep-rules/$rule\`" "$MANIFEST"
    assert $? "PORT-ADDITIONS.md machine-lists semgrep-rules/$rule" \
      "the drift gate exempts by this exact bullet shape; any other shape is not an exemption"
  done
fi

hdr "Destination map: every staged file has an apply path"

if [[ -f "$BASE/README.md" ]]; then
  for rel in "${STAGED[@]}"; do
    [[ "$rel" == "README.md" ]] && continue
    grep -qF "$rel" "$BASE/README.md"
    assert $? "README destination map names $rel" \
      "an unmapped staged file has no documented destination or applier"
  done
fi

hdr "Local rollout: the always-run scan covers the zero-FP shapes"

SCAN="$HERE/verification/secret-scan.sh"
if [[ -f "$SCAN" ]]; then
  grep -q "api/webhooks" "$SCAN"
  assert $? "secret-scan.sh covers the long-id webhook shape" \
    "real-shape webhooks would commit silently"
  grep -q "sk_live_" "$SCAN"
  assert $? "secret-scan.sh covers the live Stripe key shape" \
    "live keys would commit silently"
fi

hdr "Wiring: CI runs a security-rules suite"

grep -qsE "security[_-]rules|security[_-]packs" "$HERE/.github/workflows/ci.yml"
assert $? "a security-rules suite is wired into ci.yml" \
  "an unwired contract rots: the staged packs could drift with no red check"

hdr "Result"
printf '  %d passed, %d failed\n\n' "$PASS" "$FAIL"
[[ $((PASS + FAIL)) -gt 0 ]] || { printf '  a suite that ran no assertions is not a green suite\n'; exit 1; }
[[ "$FAIL" -eq 0 ]] || exit 1
