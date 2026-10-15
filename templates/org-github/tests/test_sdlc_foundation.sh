#!/usr/bin/env bash
# test_sdlc_foundation.sh — structural contract for the staged SDLC 1.0
# shared CI/policy foundation (TOG-24386). Hermetic: bash + python3 stdlib
# only, no network, no credentials, no Docker.
#
# It pins the properties that make the foundation safe to adopt: the org
# baseline ruleset twins differ only in enforcement, require the stable
# check names, target all repos with an injectable exclude list, and carry
# no merge queue and no approval-count gate; discovery subtracts exactly the
# one exclude list and fails closed on empty input; the repo template pins
# every org `uses:`, keeps merge_group, never path-filters, and ships a
# disabled-by-construction policy-bot stub; the README destination map names
# every staged file.
set -euo pipefail
cd "$(dirname "$0")/../.."
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

BASE=templates/org-github
FOUND=$BASE/sdlc-foundation
PASS=0; FAIL=0
ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

STAGED=(
  "$FOUND/DECISION-central-repo.md"
  "$FOUND/repo-exclude-list.txt"
  "$FOUND/discover-repos.sh"
  "$FOUND/BOOTSTRAP-new-repo.md"
  "$FOUND/repo-template/ci.yml"
  "$FOUND/repo-template/pr-lint.yml"
  "$FOUND/repo-template/CODEOWNERS"
  "$FOUND/repo-template/policy-bot.yml.disabled"
  "$FOUND/repo-template/STAGING-MIGRATE-CONTRACT.md"
  "$BASE/rulesets/sdlc-baseline-evaluate.json"
  "$BASE/rulesets/sdlc-baseline-active.json"
  "$BASE/rulesets/SDLC-BASELINE-RUNBOOK.md"
)

hdr "staged files exist"
for f in "${STAGED[@]}"; do
  if [[ -f "$f" ]]; then ok "staged: $f"; else bad "staged: $f missing"; fi
done

TMPD="$(mktemp -d "${PAPERCLIP_RUN_SCRATCH_DIR:-/tmp}/sdlc-red.XXXXXX")"
trap 'rm -rf "$TMPD"' EXIT

hdr "ruleset twins (python3 stdlib)"
TWIN_PY=$(cat <<'PY'
import json, sys
base = sys.argv[1]
ev = json.load(open(f"{base}/rulesets/sdlc-baseline-evaluate.json"))
ac = json.load(open(f"{base}/rulesets/sdlc-baseline-active.json"))
out = []
def check(cond, msg):
    out.append(("PASS" if cond else "FAIL") + ": " + msg)
ev_s = {k: v for k, v in ev.items() if k != "_comment"}
ac_s = {k: v for k, v in ac.items() if k != "_comment"}
ev_no_enf = {k: v for k, v in ev_s.items() if k != "enforcement"}
ac_no_enf = {k: v for k, v in ac_s.items() if k != "enforcement"}
check(ev_no_enf == ac_no_enf, "twins differ only in enforcement (+_comment)")
check(ev_s["enforcement"] == "evaluate", "evaluate twin enforces evaluate")
check(ac_s["enforcement"] == "active", "active twin enforces active")
check(ev_s["name"] == "sdlc-baseline" and ev_s["target"] == "branch",
      "ruleset named sdlc-baseline, branch target")
check(ev_s["conditions"]["ref_name"]["include"] == ["refs/heads/main"],
      "ruleset targets main")
check(ev_s["conditions"]["repository_name"]["include"] == ["*"],
      "ruleset targets all repos (include *)")
checks = [r for r in ev_s["rules"] if r["type"] == "required_status_checks"][0]
ctxs = {c["context"]: c.get("integration_id") for c in
        checks["parameters"]["required_status_checks"]}
check(ctxs.get("ci-ok") == 15368 and ctxs.get("pr-lint") == 15368,
      "required checks are ci-ok + pr-lint pinned to Actions")
check(checks["parameters"].get("strict_required_status_checks_policy") is False,
      "no strict-push-policy on required checks")
types = {r["type"] for r in ev_s["rules"]}
check("merge_queue" not in types, "no merge queue in baseline (stage 3)")
pr = [r for r in ev_s["rules"] if r["type"] == "pull_request"][0]["parameters"]
check(pr.get("required_approving_review_count") == 0,
      "no approval-count gate (review routes via Paperclip)")
check(pr.get("required_review_thread_resolution") is True,
      "PR thread resolution required")
print("\n".join(out))
sys.exit(0 if all(l.startswith("PASS") for l in out) else 1)
PY
)
# Capture the status WITHOUT tripping set -e: a failing twin assertion must
# still render its FAIL line and let every later section run, not kill the
# suite right after the heading.
TWIN_RC=0
python3 -c "$TWIN_PY" "$BASE" > "$TMPD/twins.out" 2>&1 || TWIN_RC=$?
TWIN_LINES=0
while IFS= read -r line; do
  case "$line" in
    PASS:*) ok "${line#PASS: }"; TWIN_LINES=$((TWIN_LINES+1)) ;;
    FAIL:*) bad "${line#FAIL: }"; TWIN_LINES=$((TWIN_LINES+1)) ;;
  esac
done < "$TMPD/twins.out"
if [[ "$TWIN_LINES" == 0 ]]; then
  bad "ruleset twin check crashed (rc=$TWIN_RC, no PASS/FAIL lines)"; cat "$TMPD/twins.out"
fi

hdr "red control: tampered twin must fail the twin-diff"
python3 - "$BASE/rulesets/sdlc-baseline-evaluate.json" "$TMPD/tampered.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d["rules"][1]["parameters"]["required_approving_review_count"] = 1
json.dump(d, open(sys.argv[2], "w"))
PY
cp "$BASE/rulesets/sdlc-baseline-evaluate.json" "$TMPD/a.json"
if python3 - "$TMPD/a.json" "$TMPD/tampered.json" <<'PY'
import json, sys
a = json.load(open(sys.argv[1])); b = json.load(open(sys.argv[2]))
a = {k: v for k, v in a.items() if k not in ("_comment",)}
b = {k: v for k, v in b.items() if k not in ("_comment",)}
sys.exit(0 if a == b else 1)
PY
then bad "tampered twin passed twin-diff (control broken)"
else ok "tampered twin fails twin-diff"; fi
mkdir -p "$TMPD/twinbase/rulesets"
cp "$BASE/rulesets/sdlc-baseline-evaluate.json" "$TMPD/twinbase/rulesets/"
python3 - "$BASE/rulesets/sdlc-baseline-active.json" "$TMPD/twinbase/rulesets/sdlc-baseline-active.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
pr = [r for r in d["rules"] if r["type"] == "pull_request"][0]
pr["parameters"]["required_approving_review_count"] = 1
json.dump(d, open(sys.argv[2], "w"))
PY
CTL_RC=0
python3 -c "$TWIN_PY" "$TMPD/twinbase" > "$TMPD/twin-ctl.out" 2>&1 || CTL_RC=$?
if [[ "$CTL_RC" != 0 ]] && grep -q '^FAIL: ' "$TMPD/twin-ctl.out"; then
  ok "tampered twin FAIL line is rendered (suite survives to report it)"
else bad "tampered twin FAIL line not rendered (rc=$CTL_RC)"; cat "$TMPD/twin-ctl.out"; fi

hdr "exclude list + discovery (offline fixture)"
if grep -Eq '^[A-Za-z0-9_.-]+\*?$' <(grep -vE '^\s*(#|$)' "$FOUND/repo-exclude-list.txt"); then
  ok "exclude list lines are names or prefix globs"
else bad "exclude list has a malformed line"; fi
cat > "$TMPD/repos.txt" <<'EOF'
TogetherWeOwn/two-bot-next
TogetherWeOwn/replay-two-bot
TogetherWeOwn/.github
TogetherWeOwn/nntunev2
EOF
DISC_OUT=$(GH_REPO_LIST_FIXTURE="$TMPD/repos.txt" "$FOUND/discover-repos.sh")
if [[ "$DISC_OUT" == $'TogetherWeOwn/two-bot-next\nTogetherWeOwn/nntunev2' ]]; then
  ok "discovery keeps live repos, drops replay-* and .github"
else bad "discovery output wrong: [$DISC_OUT]"; fi
if GH_REPO_LIST_FIXTURE="$TMPD/repos.txt" "$FOUND/discover-repos.sh" --json \
  | python3 -c 'import json,sys; assert json.load(sys.stdin)==["TogetherWeOwn/two-bot-next","TogetherWeOwn/nntunev2"]'; then
  ok "discovery --json renders the kept set"
else bad "discovery --json wrong"; fi
: > "$TMPD/empty.txt"
if GH_REPO_LIST_FIXTURE="$TMPD/empty.txt" "$FOUND/discover-repos.sh" >/dev/null 2>&1; then
  bad "empty repo list reported success (must fail closed)"
else ok "empty repo list fails closed (exit $?)"; fi
if GH_REPO_LIST_FIXTURE="$TMPD/nope.txt" "$FOUND/discover-repos.sh" >/dev/null 2>&1; then
  bad "missing fixture reported success"; else ok "missing fixture fails"; fi
if "$FOUND/discover-repos.sh" --exclude-file "$TMPD/nope.txt" >/dev/null 2>&1; then
  bad "missing exclude file reported success"; else ok "missing exclude file fails"; fi
if grep -Eq 'TogetherWeOwn/[A-Za-z0-9_.-]+' "$FOUND/discover-repos.sh"; then
  bad "discovery hardcodes a repo (must read gh + excludes)"
else ok "discovery hardcodes no repo"; fi

hdr "repo template contract"
TEMPL="$FOUND/repo-template/ci.yml"
if grep -Eq 'uses:[[:space:]]+TogetherWeOwn/[^@]+@(main|master|latest)"? *$' "$TEMPL"; then
  bad "template floats an org uses: on a branch"
else ok "no floating org uses: in template"; fi
if grep -Eq 'uses:[[:space:]]+TogetherWeOwn/[^@]+@(<PINNED_[A-Z_]+>|[0-9a-f]{40})' "$TEMPL"; then
  ok "org uses: pinned or fill-marked"
else bad "org uses: pin pattern missing"; fi
if grep -q 'merge_group: {}' "$TEMPL"; then ok "template keeps merge_group"; else bad "template lost merge_group"; fi
trig_out="$(grep -E '^  (pull_request|push|merge_group):' -A3 "$TEMPL" || true)"
if grep -q 'paths' <<<"$trig_out"; then
  bad "template path-filters a trigger (would suppress ci-ok)"
else ok "template never path-filters triggers"; fi
if grep -q 'if: always()' "$TEMPL" && grep -q 'name: ci-ok' "$TEMPL"; then
  ok "template ci-ok aggregates with if: always()"
else bad "template ci-ok aggregator malformed"; fi
live_lines="$(grep -Ev '^\s*(#|$)' "$FOUND/repo-template/policy-bot.yml.disabled" || true)"
if grep -q . <<<"$live_lines"; then
  bad "policy-bot stub has live lines (must be disabled by construction)"
else ok "policy-bot stub disabled by construction"; fi
if grep -q '<OWNING-TEAM>' "$FOUND/repo-template/CODEOWNERS"; then
  ok "CODEOWNERS carries an owning-team placeholder"
else bad "CODEOWNERS has no owning-team placeholder"; fi
if grep -q 'policy-bot.yml.disabled' "$FOUND/BOOTSTRAP-new-repo.md" \
  && grep -q '<PINNED_CHANGES_SHA>' "$FOUND/BOOTSTRAP-new-repo.md" \
  && grep -q '<PINNED_GATE_SHA>' "$FOUND/BOOTSTRAP-new-repo.md"; then
  ok "bootstrap documents pin fill + stub rename"
else bad "bootstrap misses pin fill or stub rename"; fi
PR_LINT="$FOUND/repo-template/pr-lint.yml"
if grep -q 'name: pr-lint' "$PR_LINT" && grep -q 'merge_group:' "$PR_LINT"; then
  ok "template ships the required pr-lint producer (with merge_group)"
else bad "template pr-lint producer missing or lacks merge_group"; fi
if grep -Eq '^[[:space:]]+uses:' "$PR_LINT"; then
  bad "pr-lint template must stay self-contained (an org uses: would need a pin)"
else ok "pr-lint template is self-contained (no uses:)"; fi
if grep -A6 '^  tier-0:' "$TEMPL" | grep -q 'if: false'; then
  ok "tier-0 ships disabled until its gate is on org main (no startup failure)"
else bad "tier-0 not disabled (an unfilled pin would suppress ci-ok)"; fi
if grep -A8 '^  lint:' "$TEMPL" | grep -q 'needs.changes.outputs'; then
  ok "docs-only PRs skip lint via the changes outputs"
else bad "lint not gated on changes outputs (docs-only claim false)"; fi

hdr "red control: floating uses: must fail the pin check"
sed 's/@<PINNED_CHANGES_SHA>/@main/' "$TEMPL" > "$TMPD/float.yml"
if grep -Eq 'uses:[[:space:]]+TogetherWeOwn/[^@]+@(main|master|latest)"? *$' "$TMPD/float.yml"; then
  ok "floating uses: detected (control holds)"
else bad "floating uses: NOT detected (control broken)"; fi

hdr "pre-flip audit control: manifest mode sees a missing producer"
# The runbook's pre-flip audit must measure the evaluate payload, which the
# live branch-rules endpoint omits. Prove the manifest rendering from the
# real payload flags a repo whose workflows lack a pr-lint producer, and
# that the day-1 file set itself produces every baseline-required check.
python3 - "$BASE/rulesets/sdlc-baseline-evaluate.json" "$TMPD/required.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
req = [c for r in d["rules"] if r["type"] == "required_status_checks"
       for c in r["parameters"]["required_status_checks"]]
assert {c["context"] for c in req} == {"ci-ok", "pr-lint"}, req
json.dump({"branch": "main", "required": req}, open(sys.argv[2], "w"))
PY
mkdir -p "$TMPD/wf-day1" "$TMPD/wf-no-prlint"
cp "$FOUND/repo-template/ci.yml" "$FOUND/repo-template/pr-lint.yml" "$TMPD/wf-day1/"
cp "$FOUND/repo-template/ci.yml" "$TMPD/wf-no-prlint/"
if python3 ci_required_checks_audit.py --manifest "$TMPD/required.json" \
    --workflows "$TMPD/wf-day1" > "$TMPD/audit-ok.out" 2>&1; then
  ok "day-1 template produces every baseline-required check"
else bad "day-1 template fails its own baseline audit"; cat "$TMPD/audit-ok.out"; fi
if python3 ci_required_checks_audit.py --manifest "$TMPD/required.json" \
    --workflows "$TMPD/wf-no-prlint" > "$TMPD/audit-miss.out" 2>&1; then
  bad "audit passed a workflows dir with no pr-lint producer (control broken)"
elif grep -Eq 'FAIL.*NO_PRODUCER.*"pr-lint"' "$TMPD/audit-miss.out"; then
  ok "manifest audit flags a missing pr-lint producer (evaluate payload is auditable)"
else bad "audit failed without naming pr-lint"; cat "$TMPD/audit-miss.out"; fi

hdr "destination map + runbook wiring"
MISSING=0
for f in "${STAGED[@]}"; do
  rel="${f#templates/org-github/}"
  if grep -qF "$rel" "$BASE/README.md"; then ok "map: $rel"; else bad "map: $rel unmapped"; MISSING=1; fi
done
if grep -q 'repo-exclude-list.txt' "$BASE/rulesets/SDLC-BASELINE-RUNBOOK.md" \
  && grep -q 'discover-repos.sh' "$BASE/rulesets/SDLC-BASELINE-RUNBOOK.md"; then
  ok "runbook wires exclude list + discovery"
else bad "runbook misses exclude/discovery wiring"; fi
# wired_in_ci <file> — true only when a NON-COMMENT line executes the staged
# suite. A bare mention (e.g. a header comment naming the file) must not
# count: that passed vacuously with the CI step deleted.
wired_in_ci() {
  grep -Ev '^[[:space:]]*#' "$1" > "$TMPD/noncomments.txt" 2>/dev/null || true
  grep -Eq '(^|[[:space:]])\./templates/org-github/tests/test_sdlc_foundation\.sh([[:space:]]|$)' "$TMPD/noncomments.txt"
}
if [[ -f scripts/verify-fast.sh ]] \
  && grep -Eq '^[[:space:]]*[^#].*test_sdlc_foundation\.sh' scripts/verify-fast.sh; then
  ok "suite wired into verify-fast"
elif wired_in_ci .github/workflows/ci.yml; then
  # This public mirror has no scripts/verify-fast.sh; its fast tier is
  # .github/workflows/ci.yml. Accept either wiring so the same staged
  # contract holds in both repos.
  ok "suite wired into ci.yml"
else bad "suite NOT wired into verify-fast or ci.yml"; fi
if [[ -f .github/workflows/ci.yml ]]; then
  grep -Ev '^[[:space:]]*\./templates/org-github/tests/test_sdlc_foundation\.sh[[:space:]]*$' \
    .github/workflows/ci.yml > "$TMPD/unwired.yml"
  if grep -q 'test_sdlc_foundation' "$TMPD/unwired.yml" && ! wired_in_ci "$TMPD/unwired.yml"; then
    ok "wiring check fails when the CI step is deleted (mentions kept)"
  else bad "wiring check passes with the CI step deleted (control broken)"; fi
fi

echo
echo "sdlc-foundation: $PASS passed, $FAIL failed"
[[ "$FAIL" == 0 ]]
