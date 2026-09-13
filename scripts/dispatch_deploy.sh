#!/usr/bin/env bash
set -Eeuo pipefail

readonly DEFAULT_TARGET=/paperclip/plugin-packages-root/dispatch-src
readonly REF_CURRENT=refs/dispatch-deploy/current
readonly REF_ROLLBACK=refs/dispatch-deploy/rollback
readonly SCHEMA_VERSION=2

usage() {
  cat <<'USAGE'
Usage:
  dispatch_deploy.sh deploy   --commit <40-hex-commit> --smoke-cmd <cmd> [--reason <text>]
  dispatch_deploy.sh rollback --smoke-cmd <cmd> [--commit <40-hex-commit>] [--reason <text>]
  dispatch_deploy.sh status

Manages the live in-place checkout at /paperclip/plugin-packages-root/dispatch-src.

deploy:
  Accepts only an explicit 40-hex commit already present in the target's object
  store (it never fetches). Refuses unless the working tree is clean and the
  ref names a real commit object. Stages the commit into a throwaway worktree
  and runs --smoke-cmd there BEFORE moving live HEAD; a nonzero smoke exit
  refuses the deploy and live HEAD is provably untouched. On success it anchors
  both the new and previous SHA against `git gc` via refs/dispatch-deploy/*,
  moves live HEAD, verifies the result, and atomically records deployedSha/
  previousSha in <target>.deployment.json.

rollback:
  Same staged-smoke-then-move flow, defaulting the target commit to the
  anchored refs/dispatch-deploy/rollback SHA (override with --commit).

status:
  Read-only. Refuses (exit 2) if the deployment record is absent or corrupt,
  or if a recorded SHA is no longer a reachable commit object. Exits 1 if live
  HEAD or the anchor refs have drifted from the record, 0 if not.
USAGE
}

refuse() {
  printf 'REFUSED: %s\n' "$1" >&2
  exit 2
}

log() {
  printf '%s\n' "$1"
}

TEST_MODE="${DISPATCH_DEPLOY_TEST_MODE:-0}"
case "$TEST_MODE" in
  0)
    [[ -z "${DISPATCH_DEPLOY_TARGET:-}" ]] || refuse "DISPATCH_DEPLOY_TARGET is test-only"
    TARGET="$DEFAULT_TARGET"
    ;;
  1)
    TARGET="${DISPATCH_DEPLOY_TARGET:?set DISPATCH_DEPLOY_TARGET in test mode}"
    ;;
  *) refuse "DISPATCH_DEPLOY_TEST_MODE must be 0 or 1";;
esac
RECORD="$TARGET.deployment.json"

for command in git python3 mktemp mv date; do
  command -v "$command" >/dev/null || refuse "required command missing: $command"
done

[[ -d "$TARGET/.git" || -f "$TARGET/.git" ]] || refuse "target is not a git checkout: $TARGET"

is_forty_hex() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]]
}

require_clean_tree() {
  [[ -z "$(git -C "$TARGET" status --porcelain 2>&1)" ]] || refuse "target working tree is not clean: $TARGET"
}

require_commit_object() {
  local sha="$1" type
  type=$(git -C "$TARGET" cat-file -t "$sha" 2>/dev/null) || refuse "commit is not an available object in the target's store: $sha"
  [[ "$type" == commit ]] || refuse "ref does not name a commit object directly: $sha"
}

atomic_write() {
  local destination="$1" content="$2" tmp
  tmp=$(mktemp "$(dirname "$destination")/.tmp.XXXXXXXX")
  printf '%s' "$content" > "$tmp"
  mv -T -- "$tmp" "$destination"
}

# Stage $1 into a throwaway worktree, run --smoke-cmd there with that worktree
# as cwd, and always clean up the worktree registration on the way out
# (leaked `git worktree add` registrations outlive their directory).
run_smoke() {
  local sha="$1" smoke_cmd="$2" smoke_dir rc output
  smoke_dir=$(mktemp -d)
  rmdir "$smoke_dir"
  git -C "$TARGET" worktree add --detach --quiet "$smoke_dir" "$sha" \
    || refuse "could not stage $sha into a throwaway worktree for smoke checks"
  set +e
  output=$(cd "$smoke_dir" && bash -c "$smoke_cmd" 2>&1)
  rc=$?
  set -e
  git -C "$TARGET" worktree remove --force "$smoke_dir" 2>/dev/null || rm -rf -- "$smoke_dir"
  git -C "$TARGET" worktree prune
  SMOKE_OUTPUT="$output"
  SMOKE_RC="$rc"
}

do_deploy() {
  local target_sha="$1" smoke_cmd="$2" reason="$3"
  is_forty_hex "$target_sha" || refuse "commit must be a 40-hex commit"
  [[ -n "$smoke_cmd" ]] || refuse "--smoke-cmd is required"
  require_clean_tree
  require_commit_object "$target_sha"

  local previous_sha
  previous_sha=$(git -C "$TARGET" rev-parse HEAD)

  if [[ "$previous_sha" == "$target_sha" ]]; then
    refuse "target commit is already deployed: $target_sha"
  fi

  run_smoke "$target_sha" "$smoke_cmd"
  if [[ "$SMOKE_RC" -ne 0 ]]; then
    printf '%s\n' "$SMOKE_OUTPUT" >&2
    refuse "smoke check failed (exit $SMOKE_RC); live HEAD is unchanged at $previous_sha"
  fi

  # Anchor both endpoints against gc BEFORE moving live HEAD, so a crash
  # between here and the checkout below can never leave the new commit
  # collectible.
  git -C "$TARGET" update-ref "$REF_ROLLBACK" "$previous_sha"
  git -C "$TARGET" update-ref "$REF_CURRENT" "$target_sha"

  git -C "$TARGET" checkout --quiet --detach "$target_sha"

  local resulting_head
  resulting_head=$(git -C "$TARGET" rev-parse HEAD)
  [[ "$resulting_head" == "$target_sha" ]] || refuse "post-deploy HEAD verification failed: expected $target_sha, got $resulting_head"
  require_clean_tree

  local deployed_at smoke_tail
  deployed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  smoke_tail=$(printf '%s' "$SMOKE_OUTPUT" | tail -c 2000)

  local record
  record=$(python3 - "$SCHEMA_VERSION" "$TARGET" "$target_sha" "$previous_sha" "$deployed_at" "$reason" "$smoke_cmd" "$SMOKE_RC" "$smoke_tail" <<'PY'
import json
import sys

(schema_version, path, deployed_sha, previous_sha, deployed_at, reason,
 smoke_cmd, smoke_rc, smoke_tail) = sys.argv[1:10]
print(json.dumps({
    "schemaVersion": int(schema_version),
    "path": path,
    "deployedSha": deployed_sha,
    "previousSha": previous_sha,
    "deployedAt": deployed_at,
    "reason": reason,
    "rollbackCommand": f"scripts/dispatch_deploy.sh rollback --smoke-cmd '{smoke_cmd}'",
    "smoke": {"cmd": smoke_cmd, "exitCode": int(smoke_rc), "outputTail": smoke_tail},
}, indent=2, sort_keys=True) + "\n")
PY
  )
  atomic_write "$RECORD" "$record"

  log "DEPLOYED dispatch-src to $target_sha"
  log "previous: $previous_sha"
  log "record:   $RECORD"
}

do_rollback() {
  local override_sha="$1" smoke_cmd="$2" reason="$3" rollback_sha
  if [[ -n "$override_sha" ]]; then
    rollback_sha="$override_sha"
  else
    rollback_sha=$(git -C "$TARGET" for-each-ref --format='%(objectname)' "$REF_ROLLBACK")
    [[ -n "$rollback_sha" ]] || refuse "no anchored rollback SHA and no --commit given ($REF_ROLLBACK is unset)"
  fi
  do_deploy "$rollback_sha" "$smoke_cmd" "$reason"
}

read_record() {
  [[ -f "$RECORD" ]] || refuse "no deployment record at $RECORD"
  python3 - "$RECORD" <<'PY' 2>/dev/null || refuse "deployment record is corrupt or missing required fields: $RECORD"
import json
import sys

path = sys.argv[1]
with open(path, encoding="utf-8") as handle:
    data = json.load(handle)
for field in ("schemaVersion", "deployedSha", "previousSha", "deployedAt"):
    if field not in data:
        raise SystemExit(1)
for field in ("deployedSha", "previousSha"):
    value = data[field]
    if not isinstance(value, str) or len(value) != 40:
        raise SystemExit(1)
print(data["deployedSha"])
print(data["previousSha"])
PY
}

do_status() {
  local record_output recorded_current recorded_rollback
  record_output=$(read_record) || exit $?
  recorded_current=$(printf '%s' "$record_output" | sed -n '1p')
  recorded_rollback=$(printf '%s' "$record_output" | sed -n '2p')

  local drift=0

  local live_head
  live_head=$(git -C "$TARGET" rev-parse HEAD 2>/dev/null) || refuse "target HEAD is not resolvable: $TARGET"

  local current_type rollback_type
  current_type=$(git -C "$TARGET" cat-file -t "$recorded_current" 2>/dev/null || true)
  rollback_type=$(git -C "$TARGET" cat-file -t "$recorded_rollback" 2>/dev/null || true)
  [[ "$current_type" == commit ]] || refuse "recorded deployedSha is no longer a reachable commit object (pin gone): $recorded_current"
  [[ "$rollback_type" == commit ]] || refuse "recorded previousSha is no longer a reachable commit object (pin gone): $recorded_rollback"

  local anchor_current anchor_rollback
  anchor_current=$(git -C "$TARGET" for-each-ref --format='%(objectname)' "$REF_CURRENT")
  anchor_rollback=$(git -C "$TARGET" for-each-ref --format='%(objectname)' "$REF_ROLLBACK")

  log "record:          $RECORD"
  log "recorded current: $recorded_current"
  log "recorded rollback: $recorded_rollback"
  log "live HEAD:        $live_head"
  log "anchor current:   ${anchor_current:-<unset>}"
  log "anchor rollback:  ${anchor_rollback:-<unset>}"

  if [[ "$live_head" != "$recorded_current" ]]; then
    log "DRIFT: live HEAD does not match the recorded deployedSha (stray checkout, pin itself is still reachable)"
    drift=1
  fi
  if [[ "$anchor_current" != "$recorded_current" ]]; then
    log "DRIFT: $REF_CURRENT does not match the recorded deployedSha"
    drift=1
  fi
  if [[ "$anchor_rollback" != "$recorded_rollback" ]]; then
    log "DRIFT: $REF_ROLLBACK does not match the recorded previousSha"
    drift=1
  fi

  if [[ "$drift" -eq 0 ]]; then
    log "OK: live HEAD, recorded state, and anchor refs agree"
  fi
  exit "$drift"
}

SUBCOMMAND="${1:-}"
[[ -n "$SUBCOMMAND" ]] || { usage; exit 2; }
shift || true

COMMIT=""
SMOKE_CMD=""
REASON="dispatch_deploy.sh $SUBCOMMAND"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --commit) COMMIT="${2:-}"; shift 2;;
    --smoke-cmd) SMOKE_CMD="${2:-}"; shift 2;;
    --reason) REASON="${2:-}"; shift 2;;
    --help|-h) usage; exit 0;;
    *) refuse "unknown argument: $1";;
  esac
done

case "$SUBCOMMAND" in
  deploy)
    [[ -n "$COMMIT" ]] || refuse "deploy requires --commit"
    do_deploy "$COMMIT" "$SMOKE_CMD" "$REASON"
    ;;
  rollback)
    do_rollback "$COMMIT" "$SMOKE_CMD" "$REASON"
    ;;
  status)
    do_status
    ;;
  --help|-h)
    usage
    ;;
  *)
    refuse "unknown subcommand: $SUBCOMMAND"
    ;;
esac
