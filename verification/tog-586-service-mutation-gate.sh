#!/usr/bin/env bash
# Prove the TOG-586 scheduled-service deployment assertions are load-bearing.
#
# Every test in test_liveness_reconciler_deployment.py must have at least one
# mutant here that it catches. That completeness check is not decoration: this
# gate went red in CI because ef33d9a2 changed the ExecStart repair cap from a
# literal `--max-repairs 3` to `${PAPERCLIP_RECONCILER_MAX_REPAIRS}` and left
# the mutant pointing at bytes that no longer exist, while adding two new
# assertions with no mutant at all. `mutate` fails closed on a target it cannot
# find, so the stale mutant was caught -- but the two uncovered assertions were
# invisible, and would have stayed invisible. The gate now polices its own
# coverage, so an assertion added without a mutant is a red, not a silent gap.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$HERE/.."
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

SUITE=test_liveness_reconciler_deployment.py

mkdir -p "$STAGE/systemd" "$STAGE/docs"
reset_stage() {
  # -p on purpose: one mutation below is a file MODE, and a plain `cp` over an
  # existing destination keeps the destination's mode, so the 0644 would be
  # sticky and silently mutate every later case too.
  cp -p "$ROOT/$SUITE" "$STAGE/"
  cp -p "$ROOT/systemd/paperclip-liveness-reconciler.service" "$STAGE/systemd/"
  cp -p "$ROOT/systemd/paperclip-liveness-reconciler.timer" "$STAGE/systemd/"
  cp -p "$ROOT/systemd/install-liveness-reconciler.sh" "$STAGE/systemd/"
  cp -p "$ROOT/systemd/build-liveness-reconciler-bundle.sh" "$STAGE/systemd/"
  cp -p "$ROOT/docs/liveness-reconciler.md" "$STAGE/docs/"
}
reset_stage

run_suite() {
  (cd "$STAGE" && python3 -m unittest -v "$SUITE")
}

ran_count() {
  printf '%s\n' "$1" | grep -oE 'Ran [0-9]+ tests' | grep -oE '[0-9]+' | tail -1 || true
}

baseline="$(run_suite 2>&1)" || {
  printf 'FAIL: unmutated deployment suite is already red\n%s\n' "$baseline" >&2
  exit 1
}
baseline_count="$(ran_count "$baseline")"
[[ -n "$baseline_count" && "$baseline_count" -gt 0 ]] || { echo 'FAIL: baseline ran zero tests' >&2; exit 1; }

covered=()

# Shared verdict for every mutation style: the suite must go red, must still
# run the same number of tests (a mutant that makes the suite collapse or skip
# proves nothing), and must fail in the NAMED test rather than some other one.
assert_caught() {
  local name="$1" expected="$2" rc="$3" output="$4"
  local count
  count="$(ran_count "$output")"
  if [[ "$rc" -eq 0 || "$count" != "$baseline_count" || "$output" != *"FAIL: $expected"* ]]; then
    printf 'FAIL: %s was not caught by %s\n%s\n' "$name" "$expected" "$output" >&2
    exit 1
  fi
  covered+=("$expected")
  printf 'PASS: %s\n' "$name"
}

mutate() {
  local name="$1" file="$2" old="$3" new="$4" expected="$5"
  reset_stage
  OLD="$old" NEW="$new" FILE="$STAGE/$file" python3 - <<'PY'
import os, pathlib, sys
path = pathlib.Path(os.environ["FILE"])
source = path.read_text()
old = os.environ["OLD"]
count = source.count(old)
if count != 1:
    print(f"mutation target appears {count} times, expected exactly 1", file=sys.stderr)
    raise SystemExit(1)
path.write_text(source.replace(old, os.environ["NEW"]))
PY
  bash -n "$STAGE/systemd/install-liveness-reconciler.sh"
  bash -n "$STAGE/systemd/build-liveness-reconciler-bundle.sh"
  local output rc=0
  output="$(run_suite 2>&1)" || rc=$?
  assert_caught "$name" "$expected" "$rc" "$output"
}

# A mode-only mutation. `mutate` rewrites bytes and cannot express this one.
mutate_mode() {
  local name="$1" file="$2" mode="$3" expected="$4"
  reset_stage
  chmod "$mode" "$STAGE/$file"
  local output rc=0
  output="$(run_suite 2>&1)" || rc=$?
  assert_caught "$name" "$expected" "$rc" "$output"
}

mutate checkout-path systemd/paperclip-liveness-reconciler.service \
  'WorkingDirectory=/usr/local/libexec/paperclip-liveness-reconciler/@SOURCE_REF@' \
  'WorkingDirectory=${PAPERCLIP_TOOLING_DIR}' \
  test_unit_executes_versioned_installed_release_not_checkout
mutate checksum systemd/paperclip-liveness-reconciler.service \
  'ExecStartPre=/usr/bin/sha256sum --check --strict /usr/local/libexec/paperclip-liveness-reconciler/@SOURCE_REF@/SHA256SUMS' \
  'ExecStartPre=/usr/bin/true' \
  test_unit_verifies_release_hashes_before_credential_preflight
mutate timeout systemd/paperclip-liveness-reconciler.service \
  'TimeoutStartSec=5m' 'TimeoutStartSec=infinity' \
  test_timeout_start_sec_covers_preflight_and_oneshot
# Was '--max-repairs 3 --retry-limit 1' until ef33d9a2 made the cap an operator
# variable. The bound that still lives as a literal in ExecStart is the retry
# limit, so that is what this mutant loosens.
mutate bounds systemd/paperclip-liveness-reconciler.service \
  '--retry-limit 1' '--retry-limit 99' \
  test_execstart_retains_bounded_native_first_apply
mutate timer-target systemd/paperclip-liveness-reconciler.timer \
  'Unit=paperclip-liveness-reconciler.service' 'Unit=paperclip-liveness-wrong.service' \
  test_timer_targets_exact_reconciler_service
mutate timer-jitter systemd/paperclip-liveness-reconciler.timer \
  'RandomizedDelaySec=90s' 'RandomizedDelaySec=0s' \
  test_timer_retains_interval_jitter_and_persistence
mutate credential-preflight systemd/paperclip-liveness-reconciler.service \
  'ExecStartPre=/usr/bin/python3 /usr/local/libexec/paperclip-liveness-reconciler/@SOURCE_REF@/liveness_reconciler.py --check-service-credential --preflight-issue-id ${PAPERCLIP_PREFLIGHT_ISSUE_ID} --preflight-agent-id ${PAPERCLIP_PREFLIGHT_AGENT_ID}' \
  'ExecStartPre=/usr/bin/true # --check-service-credential' \
  test_unit_runs_exact_read_only_credential_preflight
mutate runtime-path-precheck systemd/paperclip-liveness-reconciler.service \
  'ExecStartPre=/usr/bin/test -x /usr/local/bin/node' \
  'ExecStartPre=/usr/bin/test -e /usr/local/bin/node' \
  test_unit_prechecks_node_and_timeout_paths
mutate writable-home systemd/paperclip-liveness-reconciler.service \
  'UMask=0077' \
  'ReadWritePaths=%h/.local/state/paperclip
UMask=0077' \
  test_no_writable_home_path_contradicts_protect_home

# TOG-979 added the operator-settable repair cap. Both halves of that contract
# need a mutant: the cap must not be re-baked into the root-owned unit, and the
# unit's own safe default must stay above EnvironmentFile= so an unset variable
# cannot expand to nothing and hand --retry-limit's value to --max-repairs.
mutate repair-cap-relitteralised systemd/paperclip-liveness-reconciler.service \
  '--max-repairs ${PAPERCLIP_RECONCILER_MAX_REPAIRS}' '--max-repairs 3' \
  test_repair_cap_is_operator_settable_without_editing_a_root_unit
mutate repair-cap-default-dropped systemd/paperclip-liveness-reconciler.service \
  'Environment=PAPERCLIP_RECONCILER_MAX_REPAIRS=0
' '' \
  test_unset_repair_cap_defaults_to_zero_not_an_empty_argument
mutate repair-cap-default-after-envfile systemd/paperclip-liveness-reconciler.service \
  'Environment=PAPERCLIP_RECONCILER_MAX_REPAIRS=0
EnvironmentFile=%h/.config/paperclip/liveness-reconciler.env' \
  'EnvironmentFile=%h/.config/paperclip/liveness-reconciler.env
Environment=PAPERCLIP_RECONCILER_MAX_REPAIRS=0' \
  test_unset_repair_cap_defaults_to_zero_not_an_empty_argument

mutate immutable-bundle systemd/build-liveness-reconciler-bundle.sh \
  'git --no-replace-objects archive --format=tar "$SOURCE_REF"' 'git archive --format=tar HEAD' \
  test_unprivileged_builder_archives_installer_and_payload_from_reviewed_commit
# TOG-586: reachable is not reviewed. Dropping the ancestry check lets an
# operator build ee6a85be -- reachable from four branches, diverged from main,
# and carrying the pre-fix installer that refuses a good host.
mutate builder-accepts-any-reachable-commit systemd/build-liveness-reconciler-bundle.sh \
  'git --no-replace-objects merge-base --is-ancestor "$SOURCE_REF" "$TRUSTED_LINE"' 'true' \
  test_builder_refuses_a_commit_not_merged_into_the_trusted_line
# Defaulting the trusted line to HEAD would diff the tree against itself and
# pass whatever happens to be checked out, including a defective branch.
mutate builder-trusts-head-not-the-merged-line systemd/build-liveness-reconciler-bundle.sh \
  'TRUSTED_LINE="origin/main"' 'TRUSTED_LINE="HEAD"' \
  test_builder_refuses_a_commit_not_merged_into_the_trusted_line
# TOG-586 (COO): the two mutants above swap the exact strings the text
# assertion greps for, so they only prove the text is PRESENT. This one leaves
# every asserted string intact and makes the check non-fatal -- the gate must
# be caught by a mutant that RUNS the builder, not one that reads it.
mutate builder-ancestry-check-present-but-toothless systemd/build-liveness-reconciler-bundle.sh \
  '  || refuse "$SOURCE_REF is not an ancestor of $TRUSTED_LINE; it was never merged by review. Build a commit that is on that line, or pass --trusted-line if the reviewed line is elsewhere."' '  || true' \
  test_builder_actually_refuses_to_write_a_bundle_for_an_unmerged_commit
mutate root-checkout systemd/install-liveness-reconciler.sh \
  '/usr/bin/tar --extract --file "$BUNDLE" --directory "$WORK_DIR" --no-same-owner --no-same-permissions' \
  'git archive HEAD | /usr/bin/tar -x --directory "$WORK_DIR"' \
  test_installer_never_reads_git_or_mutable_checkout_as_root
mutate installer-literal-commit systemd/install-liveness-reconciler.sh \
  '[[ "$SOURCE_REF" =~ ^[0-9a-f]{40}$ ]]' '[[ -n "$SOURCE_REF" ]]' \
  test_installer_requires_literal_commit_and_reviewed_bundle
mutate installer-root-user-manager systemd/install-liveness-reconciler.sh \
  "printf 'INSTALLED paperclip-liveness-reconciler from %s for user %s (uid %s)\\n'" \
  "systemctl --user daemon-reload
printf 'INSTALLED paperclip-liveness-reconciler from %s for user %s (uid %s)\\n'" \
  test_installer_never_targets_root_user_manager
mutate installer-existence-not-executable systemd/install-liveness-reconciler.sh \
  '[[ -x "$executable" ]]' '[[ -e "$executable" ]]' \
  test_installer_checks_every_hardcoded_runtime_executable
# TOG-586: an installer preflight that refuses on a binary nothing ever invokes
# turns a cosmetic path difference into a failed install.
mutate installer-requires-uninvoked-binary systemd/install-liveness-reconciler.sh \
  'for executable in /usr/bin/install ' 'for executable in /usr/sbin/runuser /usr/bin/install ' \
  test_installer_only_requires_executables_it_actually_runs

mutate rollback docs/liveness-reconciler.md \
  'systemctl --user stop paperclip-liveness-reconciler.service' ':' \
  test_rollback_stops_timer_and_active_service_before_removal

mutate_mode build-script-not-executable systemd/build-liveness-reconciler-bundle.sh 0644 \
  test_build_script_is_executable_as_the_docs_invoke_it

# Completeness. Every test in the suite must be named by at least one mutant
# above. Without this, an assertion added with no mutant is indistinguishable
# from an assertion that cannot fail -- which is how this gate rotted.
reset_stage
UNCOVERED="$(COVERED="$(printf '%s\n' "${covered[@]}")" SUITE_PATH="$STAGE/$SUITE" python3 - <<'PY'
import os, pathlib, re
covered = set(os.environ["COVERED"].split())
names = re.findall(r"(?m)^    def (test_\w+)\(", pathlib.Path(os.environ["SUITE_PATH"]).read_text())
assert names, "found no test methods to check coverage against"
print("\n".join(sorted(set(names) - covered)))
PY
)"
if [[ -n "$UNCOVERED" ]]; then
  printf 'FAIL: deployment assertions with no mutant proving they are load-bearing:\n%s\n' "$UNCOVERED" >&2
  exit 1
fi

printf 'PASS: %s deployment mutations detected, covering all %s assertions\n' \
  "${#covered[@]}" "$baseline_count"
