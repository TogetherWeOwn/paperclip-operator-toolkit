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

mutate fork-head-repo-hardcoded 'head_repo = (d["head"].get("repo") or {}).get("full_name")' 'head_repo = f"TogetherWeOwn/{repo}"' test_fork_pr_branch_card_is_not_nudged_end_to_end
mutate fork-head-repo-wrong-key '.get("full_name")' '.get("name")' test_same_repo_branch_card_is_nudged_end_to_end
mutate live-sql-scheduled-retry-dropped "h.status in ('queued','running','scheduled_retry')" "h.status in ('queued','running')" test_live_work_sql_predicate_is_pinned
mutate live-sql-taskid-dropped "h.context_snapshot->>'taskId'" "h.context_snapshot->>'issueId'" test_live_work_sql_predicate_is_pinned
mutate live-sql-issueid-dropped "h.context_snapshot->>'issueId'," "h.context_snapshot->>'taskId'," test_live_work_sql_predicate_is_pinned
mutate blocked-open-edge-flipped 'if status == "blocked" and has_edge == "f":' 'if status == "blocked":' test_blocked_with_open_edge_keeps_blocked_status
mutate parked-unblock-descriptor-dropped ' or issue.get("unblockDescriptor")' '' test_blocked_parked_via_unblock_descriptor_is_not_nudged
mutate parked-marker-search-dropped ' or PARK_MARKER.search(issue.get("description") or "")' '' test_blocked_parked_via_parked_until_line_is_not_nudged
mutate parked-do-not-mutate-dropped 'parked until|do not mutate' 'parked until' test_blocked_parked_via_do_not_mutate_line_is_not_nudged
mutate pr-detail-skip-dropped 'if not isinstance(d, dict) or "_err" in d or "head" not in d:' 'if False:' test_pr_detail_404_skips_that_pr_and_nudges_others
mutate no-refs-board-query 'if not refs: continue' 'if False: continue' test_pr_without_tracker_id_issues_no_board_query
mutate gh-incomplete-read-crashes 'except (OSError, http.client.HTTPException, ValueError) as e:' 'except (OSError, ValueError) as e:' test_incomplete_read_on_listing_is_a_counted_fault
mutate skipped-patch-cooldown-recorded 'if isinstance(r, dict) and r.get("_err") == "skipped":' 'if False:' test_skipped_patch_records_no_cooldown
mutate state-heal-dropped '        atomic_write_state(STATE, state)
    return 1 if RUN["faults"] else 0' '        pass
    return 1 if RUN["faults"] else 0' test_torn_state_heals_on_quiet_run
mutate nonobject-state-crashes 'if not isinstance(state, dict):' 'if False:' test_nonobject_state_is_a_fault_not_a_crash
mutate api-get-curl-breaker-dropped '        if r.returncode in (7, 28): RUN["api_down"] = True
        fault(f"board api failed: curl exit {r.returncode}: GET {path}")' '        fault(f"board api failed: curl exit {r.returncode}: GET {path}")' test_api_get_curl_hang_sets_breaker
mutate api-get-timeout-breaker-dropped 'RUN["api_down"] = True; fault(f"board api timed out after {API_TIMEOUT}s: GET {path}")' 'fault(f"board api timed out after {API_TIMEOUT}s: GET {path}")' test_api_get_timeout_sets_breaker
mutate api-get-oserror-breaker-dropped 'RUN["api_down"] = True; fault(f"board api could not run: {type(e).__name__}: GET {path}")' 'fault(f"board api could not run: {type(e).__name__}: GET {path}")' test_api_get_oserror_sets_breaker
mutate api-timeout-breaker-dropped 'RUN["api_down"] = True; fault(f"board api timed out after {API_TIMEOUT}s: {method} {path}")' 'fault(f"board api timed out after {API_TIMEOUT}s: {method} {path}")' test_api_timeout_and_oserror_set_breaker
mutate api-oserror-breaker-dropped 'RUN["api_down"] = True; fault(f"board api could not run: {type(e).__name__}: {method} {path}")' 'fault(f"board api could not run: {type(e).__name__}: {method} {path}")' test_api_timeout_and_oserror_set_breaker
mutate sql-oserror-breaker-dropped 'RUN["sql_down"] = True; fault(f"sql could not run: {type(e).__name__}")' 'fault(f"sql could not run: {type(e).__name__}")' test_sql_oserror_sets_breaker
mutate sql-breaker-not-honoured 'if RUN["sql_down"]: log("sql skipped: docker did not answer earlier in this run"); return None' 'if False: log("sql skipped: docker did not answer earlier in this run"); return None' test_sql_breaker_skips_next_call
mutate api-breaker-not-honoured 'if RUN.get("api_down"): log(f"board api skipped: board did not answer earlier in this run: {method} {path}"); return {"_err": "skipped"}' 'if False: log(f"board api skipped: board did not answer earlier in this run: {method} {path}"); return {"_err": "skipped"}' test_api_breaker_skips_next_call
mutate api-get-breaker-not-honoured 'if RUN.get("api_down"): log(f"board api skipped: board did not answer earlier in this run: GET {path}"); return None' 'if False: log(f"board api skipped: board did not answer earlier in this run: GET {path}"); return None' test_api_get_breaker_skips_next_call

mutate deleted-fork-treated-as-base '(pr["head_repo"] or "")' '(pr["head_repo"] or repo)' test_deleted_fork_pr_branch_card_is_not_nudged_end_to_end
mutate deleted-fork-crashes 'head_repo = (d["head"].get("repo") or {}).get("full_name")' 'head_repo = d["head"].get("repo").get("full_name")' test_deleted_fork_pr_branch_card_is_not_nudged_end_to_end
mutate board-issue-id-check-dropped 'if not isinstance(issue, dict) or issue.get("id") != iid or not isinstance(products, list):' 'if not isinstance(issue, dict) or not isinstance(products, list):' test_board_facts_issue_id_mismatch_is_a_fault
mutate board-workspace-id-check-dropped 'isinstance(workspace, dict) and workspace.get("id") == workspace_id' 'isinstance(workspace, dict)' test_board_facts_workspace_id_mismatch_is_a_fault
mutate board-project-id-check-dropped 'isinstance(project, dict) and project.get("id") == project_id' 'isinstance(project, dict)' test_board_facts_project_id_mismatch_is_a_fault
mutate branch-left-boundary-dropped 'pattern = r"(?<![0-9A-Za-z])%s(?![0-9])" % re.escape(identifier)' 'pattern = r"%s(?![0-9])" % re.escape(identifier)' test_owner_branch_left_boundary
mutate workspace-precedence-dropped 'urls = [card["workspace_repo"]] if card["workspace_repo"] else card["project_repos"]' 'urls = ([card["workspace_repo"]] if card["workspace_repo"] else []) + card["project_repos"]' test_owner_workspace_repo_takes_precedence_over_project
mutate token-redaction-narrowed 'safe = re.sub(r"(?:gh[pousr]|github_pat)_[A-Za-z0-9_]+", "[redacted]", str(reason))' 'safe = re.sub(r"(?:ghp)_[A-Za-z0-9_]+", "[redacted]", str(reason))' test_live_work_fault_redacts_token_shapes
mutate cooldown-window-shrunk 'if key in state and now - state[key] < 6 * 3600: continue' 'if key in state and now - state[key] < 6: continue' test_cooldown_five_hour_old_key_blocks_nudge
mutate cooldown-window-huge 'if key in state and now - state[key] < 6 * 3600: continue' 'if key in state and now - state[key] < 86400 * 365: continue' test_cooldown_seven_hour_old_key_allows_nudge
mutate state-prune-dropped 'now - v < 86400' 'now - v < 86400000' test_load_state_prunes_entries_older_than_24h
mutate api-curl-hang-breaker-dropped '        if r.returncode in (7, 28): RUN["api_down"] = True
        fault(f"board api failed: curl exit {r.returncode}: {method} {path}")' '        if r.returncode in (7,): RUN["api_down"] = True
        fault(f"board api failed: curl exit {r.returncode}: {method} {path}")' test_api_curl_hang_sets_breaker

mutate owner-key-equality-dropped 'if key in {_product_key(product) for product in card["products"]}:' 'if any(_product_key(product) for product in card["products"]):' test_owner_product_for_other_pr_or_repo_is_rejected
mutate owner-key-equality-dropped-e2e 'if key in {_product_key(product) for product in card["products"]}:' 'if any(_product_key(product) for product in card["products"]):' test_product_for_other_pr_is_not_nudged_end_to_end
mutate product-key-fullmatch-relaxed 'match = pattern.fullmatch(text) if isinstance(text, str) else None' 'match = pattern.search(text) if isinstance(text, str) else None' test_owner_product_key_strict_parsing_is_pinned
mutate product-url-rejection-dropped 'if url is not None and url_key is None:' 'if False:' test_owner_product_key_strict_parsing_is_pinned
mutate live-guard-exception-fails-open 'return fail_closed("psql lookup failed: %s: %s" % (type(error).__name__, str(error)[:200]))' 'return False' test_live_work_guard_exception_fails_closed
mutate live-guard-exception-fails-open-main 'return fail_closed("psql lookup failed: %s: %s" % (type(error).__name__, str(error)[:200]))' 'return False' test_live_work_guard_exception_in_main_fails_closed
mutate gh-bearer-header-dropped '"Authorization": "Bearer " + T, ' '' test_gh_sends_bearer_token_header
mutate archived-repo-filter-dropped ' and not r.get("archived")' '' test_archived_repo_is_not_scanned
mutate cancelled-check-treated-red '("failure", "timed_out", "startup_failure")' '("failure", "timed_out", "startup_failure", "cancelled")' test_cancelled_check_is_not_a_red_nudge
mutate title-ref-source-dropped ' + " " + d["title"]' '' test_title_only_reference_is_nudged
mutate dry-run-live-work-runs '        if not DRY:
            if RUN["sql_down"]:' '        if True:
            if RUN["sql_down"]:' test_dry_run_skips_live_work_and_log_file
mutate dry-run-log-writes '    if not DRY:
        try:
            os.makedirs(os.path.dirname(LOG) or ".", exist_ok=True)' '    if True:
        try:
            os.makedirs(os.path.dirname(LOG) or ".", exist_ok=True)' test_dry_run_skips_live_work_and_log_file
mutate log-oserror-not-swallowed '        except OSError:
            pass  # stdout already carries the row; a missing log must not crash the sweep' '        except ValueError:
            pass  # stdout already carries the row; a missing log must not crash the sweep' test_unwritable_log_does_not_crash_the_sweep
mutate state-nonnumeric-crashes 'isinstance(v, (int, float)) and now - v < 86400' 'now - v < 86400' test_non_numeric_state_value_is_dropped
mutate sent-count-any-dict 'and r.get("id"): sent += 1' 'and isinstance(r, dict): sent += 1' test_empty_patch_response_counts_as_not_sent
mutate held-lock-exits-one 'log("skip: another PR-hygiene sweep holds the run lock"); return 0' 'log("skip: another PR-hygiene sweep holds the run lock"); return 1' test_held_lock_exits_zero_with_skip_log

mutate refs-regex-widened 're.findall(r"[A-Z]{2,}-\d+"' 're.findall(r"[A-Z]{2,}-\S+"' test_board_query_inlist_is_exactly_quoted_tracker_ids
mutate inlist-join-unquoted "f\"'{r}'\"" "f\"{r}\"" test_board_query_inlist_is_exactly_quoted_tracker_ids
mutate live-uuid-fullmatch-to-search '_UUID.fullmatch' '_UUID.search' test_live_work_uuid_must_fullmatch
mutate mint-check-dropped 'check=True, capture_output=True' 'capture_output=True' test_mint_nonzero_exit_fails_without_echoing_output
mutate mint-capture-dropped 'check=True, capture_output=True' 'check=True' test_mint_nonzero_exit_fails_without_echoing_output
mutate mint-stderr-echoed 'log(f"token mint failed: {type(e).__name__}"); return 1' 'log(f"token mint failed: {type(e).__name__} {e.stderr}"); return 1' test_mint_nonzero_exit_fails_without_echoing_output
mutate api-error-body-echoed 'fault(f"board api failed: HTTP {code}: {method} {path}"); return {"_err": f"http-{code}"}' 'fault(f"board api failed: HTTP {code}: {method} {path} {body_text[:200]}"); return {"_err": f"http-{code}"}' test_board_error_bodies_are_not_echoed
mutate api-get-error-body-echoed 'fault(f"board api failed: HTTP {code}: GET {path}"); return None' 'fault(f"board api failed: HTTP {code}: GET {path} {body_text[:200]}"); return None' test_board_error_bodies_are_not_echoed
mutate gh-error-body-echoed 'fault(f"{where} failed: HTTP {e.code}"); return {"_err": e.code}' 'fault(f"{where} failed: HTTP {e.code} {e.read()[:200]}"); return {"_err": e.code}' test_gh_http_error_body_is_not_echoed
mutate blocked-only-flip-dropped 'if status == "blocked" and has_edge == "f":' 'if has_edge == "f":' test_nonblocked_cards_are_not_flipped_to_todo
mutate board-patch-method-changed 'api("PATCH", f"issues/{iid}", body)' 'api("PUT", f"issues/{iid}", body)' test_board_patch_request_shape_is_pinned
mutate board-patch-path-ident 'api("PATCH", f"issues/{iid}", body)' 'api("PATCH", f"issues/{ident}", body)' test_board_patch_request_shape_is_pinned
mutate board-patch-path-comments 'api("PATCH", f"issues/{iid}", body)' 'api("PATCH", f"issues/{iid}/comments", body)' test_board_patch_request_shape_is_pinned
mutate board-content-type-dropped '"-H", "content-type: application/json",' '' test_board_patch_request_shape_is_pinned
mutate board-api-curl-config-dropped '["curl", "-sS", "-K", CURL_CONFIG, "-m", "90", "-X", method,' '["curl", "-sS", "-m", "90", "-X", method,' test_board_patch_request_shape_is_pinned
mutate board-api-get-curl-config-dropped '["curl", "-sS", "-K", CURL_CONFIG, "-m", "90", "-w",' '["curl", "-sS", "-m", "90", "-w",' test_board_patch_request_shape_is_pinned
mutate token-strip-dropped 'T = f.read().strip()' 'T = f.read()' test_token_newline_is_stripped_before_github_calls
mutate psql-strip-dropped 'out = out.strip()' '' test_live_work_psql_newline_output_is_accepted
mutate board-split-partition '(stdout or "").rpartition("\n")' '(stdout or "").partition("\n")' test_board_multiline_json_body_is_parsed
mutate per-attempt-state-save-dropped '        atomic_write_state(STATE, state)
        if isinstance(r, dict) and r.get("id")' '        if isinstance(r, dict) and r.get("id")' test_state_is_saved_after_each_patch_attempt
mutate dry-run-state-written '    if not DRY:
        # Heal a torn state file' '    if True:
        # Heal a torn state file' test_dry_run_does_not_write_state_file
mutate state-temp-dir-default 'tempfile.mkstemp(prefix=".state.", suffix=".tmp", dir=directory)' 'tempfile.mkstemp(prefix=".state.", suffix=".tmp", dir=None)' test_atomic_write_temp_file_stays_in_state_dir
mutate sweep-log-write-dropped 'f.write(line + "\n")' 'f.write("")' test_sweep_log_file_receives_rows
mutate env-state-dir-renamed '"PR_HYGIENE_STATE_DIR"' '"PR_HYGIENE_STATE_DIRx"' test_env_vars_configure_module_paths
mutate env-company-renamed '"PAPERCLIP_COMPANY_ID"' '"PAPERCLIP_COMPANY_IDx"' test_env_vars_configure_module_paths
mutate env-token-file-renamed '"PR_HYGIENE_TOKEN_FILE"' '"PR_HYGIENE_TOKEN_FILEx"' test_env_vars_configure_module_paths
mutate env-mint-renamed '"PR_HYGIENE_MINT"' '"PR_HYGIENE_MINTx"' test_env_vars_configure_module_paths
mutate env-curl-config-renamed '"PR_HYGIENE_CURL_CONFIG"' '"PR_HYGIENE_CURL_CONFIGx"' test_env_vars_configure_module_paths
mutate gh-success-reset-dropped '    RUN["gh_streak"] = 0
    return out' '    return out' test_gh_breaker_resets_on_success
mutate gh-breaker-threshold-lowered 'GH_BREAKER = 3' 'GH_BREAKER = 2' test_gh_breaker_two_faults_leave_it_closed
mutate gh-404-reset-dropped 'RUN["gh_streak"] = 0; log(f"{where} failed: HTTP {e.code}")' 'log(f"{where} failed: HTTP {e.code}")' test_gh_breaker_resets_on_404
mutate gh-nonjson-counted 'RUN["gh_streak"] += kind != "non-json"' 'RUN["gh_streak"] += 1' test_gh_nonjson_bodies_do_not_trip_breaker
mutate project-workspaces-renamed 'project.get("workspaces")' 'project.get("workspace")' test_card_facts_project_repos_are_returned
mutate project-repo-url-renamed 'w.get("repoUrl") for w in project.get("workspaces")' 'w.get("repo_url") for w in project.get("workspaces")' test_card_facts_project_repos_are_returned
mutate project-path-renamed 'f"projects/{project_id}"' 'f"project/{project_id}"' test_card_facts_project_repos_are_returned
mutate project-path-renamed-e2e 'f"projects/{project_id}"' 'f"project/{project_id}"' test_project_only_branch_card_is_nudged_end_to_end
mutate repo-url-dotgit-dropped '(?:\.git)?/?' '/?' test_repo_url_forms_and_case_are_normalised
mutate repo-url-slash-dropped '(?:\.git)?/?' '(?:\.git)?' test_repo_url_forms_and_case_are_normalised
mutate repo-url-group-greedy '([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)(?:\.git)?/?' '([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)(?:\.git)?/?' test_repo_url_forms_and_case_are_normalised
mutate owner-key-lower-dropped '"%s#%d" % (repo.lower(), int(number))' '"%s#%d" % (repo, int(number))' test_repo_url_forms_and_case_are_normalised

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
