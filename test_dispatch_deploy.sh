#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DEPLOY="$ROOT/scripts/dispatch_deploy.sh"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/dispatch-deploy-test.XXXXXXXX")
trap 'rm -rf "$WORK"' EXIT
failures=0

ok() { printf '  ok: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; failures=$((failures + 1)); }

make_target() {
  local target="$1"
  mkdir -p "$target"
  git -C "$target" init -q
  git -C "$target" config user.name test
  git -C "$target" config user.email test@example.invalid
  echo one > "$target/f"
  git -C "$target" add f
  git -C "$target" commit -qm one
  SHA1=$(git -C "$target" rev-parse HEAD)
  echo two > "$target/f"
  git -C "$target" add f
  git -C "$target" commit -qm two
  SHA2=$(git -C "$target" rev-parse HEAD)
  git -C "$target" checkout -q --detach "$SHA1"
  git -C "$target" update-ref refs/dispatch-deploy/current "$SHA1"
  git -C "$target" update-ref refs/dispatch-deploy/rollback "$SHA1"
}

run() {
  local target="$1"
  shift
  DISPATCH_DEPLOY_TEST_MODE=1 DISPATCH_DEPLOY_TARGET="$target" "$DEPLOY" "$@"
}

expect_refusal() {
  local label="$1" expected="$2" target="$3"
  shift 3
  local output rc
  set +e
  output=$(run "$target" "$@" 2>&1)
  rc=$?
  set -e
  if [[ $rc -eq 2 && "$output" == *"$expected"* ]]; then
    ok "$label"
  else
    fail "$label (rc=$rc output=$output)"
  fi
}

# --- deploy: happy path -----------------------------------------------------
target="$WORK/happy"
make_target "$target"
if run "$target" deploy --commit "$SHA2" --smoke-cmd "true" >/dev/null; then
  ok "deploy with passing smoke succeeds"
else
  fail "deploy with passing smoke succeeds"
fi
[[ "$(git -C "$target" rev-parse HEAD)" == "$SHA2" ]] && ok "live HEAD moved to the deployed commit" || fail "live HEAD did not move"
[[ -f "$target.deployment.json" ]] && ok "deployment record was written" || fail "deployment record missing"
recorded=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['deployedSha'])" "$target.deployment.json")
[[ "$recorded" == "$SHA2" ]] && ok "record deployedSha matches" || fail "record deployedSha mismatch: $recorded"
recorded_prev=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['previousSha'])" "$target.deployment.json")
[[ "$recorded_prev" == "$SHA1" ]] && ok "record previousSha matches prior HEAD" || fail "record previousSha mismatch: $recorded_prev"
anchor_current=$(git -C "$target" for-each-ref --format='%(objectname)' refs/dispatch-deploy/current)
anchor_rollback=$(git -C "$target" for-each-ref --format='%(objectname)' refs/dispatch-deploy/rollback)
[[ "$anchor_current" == "$SHA2" ]] && ok "anchor ref current advanced" || fail "anchor ref current wrong: $anchor_current"
[[ "$anchor_rollback" == "$SHA1" ]] && ok "anchor ref rollback holds the prior commit" || fail "anchor ref rollback wrong: $anchor_rollback"
[[ -z "$(git -C "$target" worktree list --porcelain | grep -v "^worktree $target$" | grep '^worktree')" ]] \
  && ok "no leaked smoke worktree registrations" || fail "leaked worktree registration after deploy"

# --- deploy: failing smoke never touches live HEAD --------------------------
target="$WORK/failing-smoke"
make_target "$target"
before=$(git -C "$target" rev-parse HEAD)
expect_refusal "failing smoke check is refused" "smoke check failed" "$target" deploy --commit "$SHA2" --smoke-cmd "false"
after=$(git -C "$target" rev-parse HEAD)
[[ "$before" == "$after" ]] && ok "failed smoke leaves live HEAD unchanged" || fail "failed smoke moved live HEAD: $before -> $after"
[[ ! -e "$target.deployment.json" ]] && ok "failed smoke publishes no deployment record" || fail "failed smoke left a deployment record"
anchor_current=$(git -C "$target" for-each-ref --format='%(objectname)' refs/dispatch-deploy/current)
[[ "$anchor_current" == "$before" ]] && ok "failed smoke leaves the current anchor unchanged" || fail "failed smoke moved the current anchor"
[[ -z "$(git -C "$target" worktree list --porcelain | grep -v "^worktree $target$" | grep '^worktree')" ]] \
  && ok "no leaked smoke worktree registration after a smoke failure" || fail "leaked worktree registration after smoke failure"

# --- deploy: negative controls ----------------------------------------------
target="$WORK/branch-ref"
make_target "$target"
expect_refusal "branch names are refused" "must be a 40-hex commit" "$target" deploy --commit master --smoke-cmd "true"

target="$WORK/short-sha"
make_target "$target"
expect_refusal "short SHAs are refused" "must be a 40-hex commit" "$target" deploy --commit "${SHA2:0:10}" --smoke-cmd "true"

target="$WORK/unknown-object"
make_target "$target"
fake_sha=$(printf '%040d' 1)
expect_refusal "unknown object is refused" "not an available object" "$target" deploy --commit "$fake_sha" --smoke-cmd "true"

target="$WORK/dirty-tree"
make_target "$target"
echo dirty >> "$target/f"
expect_refusal "dirty working tree is refused" "working tree is not clean" "$target" deploy --commit "$SHA2" --smoke-cmd "true"

target="$WORK/already-deployed"
make_target "$target"
expect_refusal "redeploying the current commit is refused" "already deployed" "$target" deploy --commit "$SHA1" --smoke-cmd "true"

target="$WORK/no-smoke-cmd"
make_target "$target"
expect_refusal "missing --smoke-cmd is refused" "--smoke-cmd is required" "$target" deploy --commit "$SHA2"

target="$WORK/not-a-repo"
mkdir -p "$target"
expect_refusal "a non-git target is refused" "is not a git checkout" "$target" deploy --commit "$fake_sha" --smoke-cmd "true"

# --- rollback ----------------------------------------------------------------
target="$WORK/rollback"
make_target "$target"
run "$target" deploy --commit "$SHA2" --smoke-cmd "true" >/dev/null
if run "$target" rollback --smoke-cmd "true" >/dev/null; then
  ok "rollback with no --commit succeeds"
else
  fail "rollback with no --commit succeeds"
fi
[[ "$(git -C "$target" rev-parse HEAD)" == "$SHA1" ]] && ok "rollback restores the anchored rollback SHA" || fail "rollback did not restore SHA1"

target="$WORK/rollback-no-anchor"
mkdir -p "$target"
git -C "$target" init -q
git -C "$target" config user.name test
git -C "$target" config user.email test@example.invalid
echo one > "$target/f"; git -C "$target" add f; git -C "$target" commit -qm one
expect_refusal "rollback with no anchored ref and no --commit is refused" "no anchored rollback SHA" "$target" rollback --smoke-cmd "true"

# --- status: absent / corrupt record ----------------------------------------
target="$WORK/status-absent"
make_target "$target"
set +e
output=$(run "$target" status 2>&1)
rc=$?
set -e
[[ $rc -eq 2 && "$output" == *"no deployment record"* ]] && ok "status refuses an absent record" || fail "status on absent record (rc=$rc output=$output)"

target="$WORK/status-corrupt"
make_target "$target"
run "$target" deploy --commit "$SHA2" --smoke-cmd "true" >/dev/null
printf 'not json' > "$target.deployment.json"
set +e
output=$(run "$target" status 2>&1)
rc=$?
set -e
[[ $rc -eq 2 && "$output" == *"corrupt"* ]] && ok "status refuses a corrupt record" || fail "status on corrupt record (rc=$rc output=$output)"

target="$WORK/status-missing-field"
make_target "$target"
run "$target" deploy --commit "$SHA2" --smoke-cmd "true" >/dev/null
python3 -c "
import json
p = '$target.deployment.json'
d = json.load(open(p))
del d['previousSha']
json.dump(d, open(p, 'w'))
"
set +e
output=$(run "$target" status 2>&1)
rc=$?
set -e
[[ $rc -eq 2 && "$output" == *"corrupt"* ]] && ok "status refuses a record missing a required field" || fail "status on missing-field record (rc=$rc output=$output)"

target="$WORK/status-pin-gone"
make_target "$target"
run "$target" deploy --commit "$SHA2" --smoke-cmd "true" >/dev/null
python3 -c "
import json
p = '$target.deployment.json'
d = json.load(open(p))
d['deployedSha'] = 'a' * 40
json.dump(d, open(p, 'w'))
"
set +e
output=$(run "$target" status 2>&1)
rc=$?
set -e
[[ $rc -eq 2 && "$output" == *"pin gone"* ]] && ok "status refuses when the recorded SHA is no longer a reachable commit" || fail "status on pin-gone record (rc=$rc output=$output)"

# --- status: drift ------------------------------------------------------------
target="$WORK/status-drift-stray"
make_target "$target"
run "$target" deploy --commit "$SHA2" --smoke-cmd "true" >/dev/null
git -C "$target" checkout -q --detach "$SHA1"
set +e
output=$(run "$target" status 2>&1)
rc=$?
set -e
[[ $rc -eq 1 && "$output" == *"stray checkout"* ]] && ok "status flags a stray checkout as drift (rc 1)" || fail "status on stray checkout (rc=$rc output=$output)"

target="$WORK/status-drift-anchor"
make_target "$target"
run "$target" deploy --commit "$SHA2" --smoke-cmd "true" >/dev/null
git -C "$target" update-ref refs/dispatch-deploy/current "$SHA1"
set +e
output=$(run "$target" status 2>&1)
rc=$?
set -e
[[ $rc -eq 1 && "$output" == *"does not match the recorded deployedSha"* ]] && ok "status flags a moved anchor ref as drift (rc 1)" || fail "status on moved anchor (rc=$rc output=$output)"

target="$WORK/status-no-drift"
make_target "$target"
run "$target" deploy --commit "$SHA2" --smoke-cmd "true" >/dev/null
set +e
output=$(run "$target" status 2>&1)
rc=$?
set -e
[[ $rc -eq 0 && "$output" == *"OK:"* ]] && ok "status reports no drift when everything agrees (rc 0)" || fail "status false positive (rc=$rc output=$output)"

if (( failures != 0 )); then
  printf '%s dispatch_deploy.sh tests failed\n' "$failures" >&2
  exit 1
fi
printf 'dispatch_deploy.sh tests passed\n'
