#!/usr/bin/env bash
# Pr-hygiene mutation gate: prove test_pr_hygiene_fault_coverage.py is
# load-bearing. Each mutant breaks one claimed fault-visibility guard in a
# private staged copy and must fail the NAMED test. Completeness is policed
# at the bottom: every test in the coverage suite needs a mutant.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$HERE/.."
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
SUITE=test_pr_hygiene_fault_coverage.py
TOOL=pr_hygiene_sweep.py
reset_stage() { cp "$ROOT/$SUITE" "$ROOT/test_pr_hygiene_fault_visibility.py" "$ROOT/$TOOL" "$STAGE/"; }
run_suite() { (cd "$STAGE" && python3 -m unittest "$SUITE" 2>&1); }
ran_count() { printf '%s\n' "$1" | grep -oE 'Ran [0-9]+ tests' | grep -oE '[0-9]+' | tail -1 || true; }
reset_stage
baseline="$(run_suite)" || { printf 'FAIL: unmutated suite is already red\n%s\n' "$baseline" >&2; exit 1; }
baseline_count="$(ran_count "$baseline")"
[[ -n "$baseline_count" && "$baseline_count" -gt 0 ]] || { echo 'FAIL: baseline ran zero tests' >&2; exit 1; }
covered=()
assert_caught() {
  local name="$1" expected="$2" rc="$3" output="$4" count
  count="$(ran_count "$output")"
  if [[ "$rc" -eq 0 || "$count" != "$baseline_count" || "$output" != *"FAIL: $expected"* && "$output" != *"ERROR: $expected"* ]]; then
    printf 'FAIL: %s was not caught by %s\n%s\n' "$name" "$expected" "$output" >&2; exit 1
  fi
  covered+=("$expected"); printf 'PASS: %s\n' "$name"
}
mutate() {
  local name="$1" old="$2" new="$3" expected="$4"
  reset_stage
  OLD="$old" NEW="$new" FILE="$STAGE/$TOOL" python3 - <<'PY'
import os, pathlib, sys
path = pathlib.Path(os.environ["FILE"]); source = path.read_text(); old = os.environ["OLD"]
if source.count(old) != 1:
    print(f"mutation target appears {source.count(old)} times, expected exactly 1", file=sys.stderr); raise SystemExit(1)
path.write_text(source.replace(old, os.environ["NEW"]))
PY
  python3 -m py_compile "$STAGE/$TOOL"
  local output rc=0; output="$(run_suite 2>&1)" || rc=$?
  assert_caught "$name" "$expected" "$rc" "$output"
}

mutate org-404-silent 'fault(f"org repo list page {page} failed: HTTP 404")' 'log(f"org repo list page {page} failed: HTTP 404")' test_org_listing_404_is_a_fault
mutate org-empty-silent 'fault("org discovery returned no repositories")' 'log("org discovery returned no repositories")' test_org_listing_empty_is_a_fault
mutate org-nonlist-silent 'fault(f"org repo list page {page} failed: non-list body ({type(listing).__name__})")' 'log(f"org repo list page {page} failed: non-list body ({type(listing).__name__})")' test_org_listing_nonlist_body_is_a_fault
mutate pulls-nonlist-silent 'fault(f"{repo} list page {page} failed: non-list body ({type(chunk).__name__})")' 'log(f"{repo} list page {page} failed: non-list body ({type(chunk).__name__})")' test_pulls_listing_nonlist_body_is_a_fault
mutate pulls-404-becomes-fault 'if e.code == 404:' 'if e.code == 999:' test_pulls_listing_404_is_a_logged_miss
mutate api-breaker-dropped 'if r.returncode in (7, 28): RUN["api_down"] = True
        fault(f"board api failed: curl exit {r.returncode}: {method} {path}")' 'fault(f"board api failed: curl exit {r.returncode}: {method} {path}")' test_api_curl_refused_sets_breaker_and_faults
mutate api-non2xx-silent 'if not code.startswith("2"):' 'if False:' test_api_non2xx_is_a_fault
mutate api-trailer-accepted 'fault(f"board api failed: invalid HTTP status trailer: {method} {path}")' 'log(f"board api failed: invalid HTTP status trailer: {method} {path}")' test_api_invalid_trailer_is_a_fault
mutate api-get-5xx-silent 'if code in ("401", "403") or code.startswith("5"):' 'if False:' test_api_get_5xx_is_a_fault
mutate sql-timeout-breaker-dropped 'RUN["sql_down"] = True; fault(f"sql timed out after {SQL_TIMEOUT}s")' 'fault(f"sql timed out after {SQL_TIMEOUT}s")' test_sql_timeout_sets_breaker_and_faults
mutate sql-nonzero-silent 'if r.returncode: fault(f"sql failed:' 'if False: fault(f"sql failed:' test_sql_nonzero_is_a_fault
mutate gh-breaker-disabled 'if RUN["gh_streak"] >= GH_BREAKER:' 'if False:' test_gh_breaker_opens_after_three_faults
mutate live-guard-fails-open 'if getattr(result, "returncode", 0):' 'if False:' test_live_work_guard_fails_closed_on_psql_error
mutate live-guard-redaction-off 'safe = re.sub(r"(?:gh[pousr]|github_pat)_[A-Za-z0-9_]+", "[redacted]", str(reason))' 'safe = str(reason)' test_live_work_fault_redacts_token_shapes
mutate mint-failure-exits-zero 'log(f"token mint failed: {type(e).__name__}"); return 1' 'log(f"token mint failed: {type(e).__name__}"); return 0' test_mint_failure_exits_one
mutate failed-patch-cooldown-dropped 'state[key] = now' 'pass  # state[key] = now' test_cooldown_after_failed_patch
mutate max-nudges-dropped 'if attempts >= MAX_NUDGES: break' 'if False: break' test_max_nudges_caps_writes
mutate parked-guard-dropped 'if owner.get("parked"):' 'if False:' test_parked_blocked_card_is_not_nudged
mutate blocked-todo-dropped 'body["status"] = "todo"' 'body["status"] = "blocked"' test_blocked_card_moves_to_todo_on_nudge
mutate pause-ignored 'if os.path.exists(PAUSE): return 0' 'if False: return 0' test_pause_file_stops_the_run
mutate run-lock-ignored 'except BlockingIOError: stream.close(); return None' 'except BlockingIOError: return stream' test_run_lock_blocks_a_second_holder
mutate torn-state-silent 'fault(f"state unreadable ({type(e).__name__}), starting empty")' 'log(f"state unreadable ({type(e).__name__}), starting empty")' test_torn_state_is_a_fault
mutate state-write-silent 'fault(f"state write failed: {type(e).__name__}")' 'log(f"state write failed: {type(e).__name__}")' test_state_write_failure_is_a_fault
mutate dry-run-writes 'sent += 1; continue' 'sent += 1' test_dry_run_writes_nothing
mutate pipe-name-crashes 'head, has_edge = row.rsplit("|", 1)
                    iid, ident, status, agent = head.split("|", 3)' 'iid, ident, status, agent, has_edge = row.split("|")' test_agent_name_with_pipe_still_nudges
mutate malformed-row-silent 'fault(f"board row malformed for {repo}#{p['"'"'number'"'"']}: {_plain(row[:80])}")' 'log(f"board row malformed for {repo}#{p['"'"'number'"'"']}: {_plain(row[:80])}")' test_malformed_board_row_is_a_fault_not_a_crash
mutate draft-release-skipped-dropped 'if p["head"]["ref"].startswith("release-please") or p.get("draft"): continue' 'if False: continue' test_draft_and_release_please_are_skipped

mutate live-deferral-dropped 'if issue_has_live_work(iid, on_error=live_work_fault):' 'if False:' test_live_run_defers_nudge
mutate live-guard-t-dropped "return out == 't'" 'return False' test_live_work_guard_returns_live_only_on_t
mutate live-guard-uuid-dropped 'if not issue_id or not _UUID.fullmatch(str(issue_id)):' 'if False:' test_live_work_guard_rejects_invalid_issue_id
mutate sql-down-break-dropped 'if RUN["sql_down"]:
                log("  remaining nudges deferred: live-work lookup unavailable"); break' 'if RUN["sql_down"]:
                log("  remaining nudges deferred: live-work lookup unavailable")' test_sql_down_break_stops_remaining_nudges
mutate owner-fork-check-dropped 'if not same_repo_branch:' 'if False:' test_owner_fork_branch_card_is_rejected
mutate owner-registered-check-dropped 'elif repo in _registered_repos(card):' 'elif True:' test_owner_unregistered_branch_card_is_rejected
mutate owner-single-rule-dropped 'if len(trusted) == 1:' 'if trusted:' test_owner_two_trusted_cards_are_ambiguous
mutate owner-facts-check-dropped 'if unknown:' 'if False:' test_owner_facts_unavailable_is_refused
mutate owner-stale-filter-dropped 'if product.get("status") in _STALE_STATUSES:' 'if False:' test_owner_untrusted_products_are_rejected
mutate owner-mismatch-filter-dropped 'if external_key and url_key and external_key != url_key:' 'if False:' test_owner_untrusted_products_are_rejected
mutate owner-provider-filter-dropped 'if product.get("type") != "pull_request" or product.get("provider") != "github":' 'if False:' test_owner_untrusted_products_are_rejected
mutate owner-branch-boundary-dropped 'pattern = r"(?<![0-9A-Za-z])%s(?![0-9])" % re.escape(identifier)' 'pattern = r"%s" % re.escape(identifier)' test_owner_branch_name_boundary
mutate board-company-filter-changed "where i.company_id='{C}'" "where i.company_id='x'" test_board_query_filters_are_pinned
mutate board-status-filter-changed "i.status not in ('done','cancelled')" "i.status not in ('done')" test_board_query_filters_are_pinned
mutate board-assignee-filter-dropped 'and i.assignee_agent_id is not null' '' test_board_query_filters_are_pinned
mutate board-blocks-filter-changed "ir.type='blocks' and b.status not in ('done','cancelled')" "ir.type='blocks'" test_board_query_filters_are_pinned
mutate red-timed-out-dropped '("failure", "timed_out", "startup_failure")' '("failure", "startup_failure")' test_red_timed_out_check_is_a_red_nudge
mutate red-kind-disabled 'if failing: kind = "red"' 'if False: kind = "red"' test_red_timed_out_check_is_a_red_nudge
mutate dirty-behind-dropped 'behind = cmp.get("behind_by", "?") if isinstance(cmp, dict) else "?"' 'behind = "?"' test_dirty_pr_reports_compare_behind_count
mutate sanitize-ref-dropped 'ref=_plain(d["head"]["ref"])' 'ref=d["head"]["ref"]' test_comment_sanitizes_pr_controlled_text
mutate sanitize-failing-dropped '", ".join(_plain(name) for name in failing[:8])' '", ".join(failing[:8])' test_comment_sanitizes_pr_controlled_text
mutate mint-timeout-dropped ', timeout=MINT_TIMEOUT' '' test_mint_call_carries_a_timeout
mutate sql-timeout-dropped ', timeout=SQL_TIMEOUT' '' test_docker_calls_carry_timeouts
mutate guard-timeout-dropped ', timeout=30' '' test_docker_calls_carry_timeouts
mutate curl-api-timeout-dropped '"-d", json.dumps(body)], capture_output=True, text=True, timeout=API_TIMEOUT' '"-d", json.dumps(body)], capture_output=True, text=True' test_curl_calls_carry_timeouts
mutate curl-api-get-timeout-dropped 'f"http://127.0.0.1:3100/api/{path}"], capture_output=True, text=True, timeout=API_TIMEOUT' 'f"http://127.0.0.1:3100/api/{path}"], capture_output=True, text=True' test_curl_calls_carry_timeouts

mutate owner-archived-filter-dropped '_STALE_STATUSES = frozenset({"merged", "closed", "archived"})' '_STALE_STATUSES = frozenset({"merged", "closed"})' test_owner_untrusted_products_are_rejected
mutate owner-malformed-external-dropped 'if external_id is not None and external_key is None:' 'if False:' test_owner_untrusted_products_are_rejected
mutate owner-project-fallback-dropped 'else card["project_repos"]' 'else []' test_owner_project_repo_fallback_is_trusted
mutate owner-head-repo-none-crashes '(pr["head_repo"] or "").lower()' 'pr["head_repo"].lower()' test_owner_missing_head_repo_does_not_crash
mutate board-edge-direction-flipped 'where ir.related_issue_id=i.id' 'where ir.issue_id=i.id' test_board_query_filters_are_pinned
mutate red-startup-failure-dropped '("failure", "timed_out", "startup_failure")' '("failure", "timed_out")' test_red_startup_failure_check_is_a_red_nudge
mutate red-blocked-state-dropped 'elif ms in ("unstable", "blocked"):' 'elif ms in ("unstable",):' test_blocked_state_pr_with_failing_check_is_red
mutate red-kind-always-on 'if failing: kind = "red"' 'if True: kind = "red"' test_unstable_all_green_checks_are_not_nudged
mutate red-nameless-check-crashes ' and c.get("name")})' '})' test_red_nameless_failing_check_does_not_crash
mutate curl-api-maxtime-dropped '"-m", "90", "-X", method' '"-X", method' test_curl_calls_carry_timeouts
mutate curl-api-get-maxtime-dropped '"-m", "90", "-w"' '"-w"' test_curl_calls_carry_timeouts
mutate sql-timeout-value-raised 'timeout=SQL_TIMEOUT' 'timeout=999999' test_docker_calls_carry_timeouts
mutate guard-timeout-value-lowered 'timeout=30' 'timeout=1' test_docker_calls_carry_timeouts

reset_stage
UNCOVERED="$(COVERED="$(printf '%s\n' "${covered[@]}")" SUITE_PATH="$STAGE/$SUITE" python3 - <<'PY'
import os, pathlib, re
covered = set(os.environ["COVERED"].split())
names = re.findall(r"(?m)^    def (test_\w+)\(", pathlib.Path(os.environ["SUITE_PATH"]).read_text())
assert names, "found no test methods"
print("\n".join(sorted(set(names) - covered)))
PY
)"
if [[ -n "$UNCOVERED" ]]; then printf 'FAIL: assertions with no mutant:\n%s\n' "$UNCOVERED" >&2; exit 1; fi
printf 'PASS: %s pr-hygiene mutations detected, covering all %s assertions\n' "${#covered[@]}" "$baseline_count"
