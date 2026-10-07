#!/usr/bin/env bash
# Closeout-ledger mutation gate: prove test_pr_closeout_ledger.py is load-bearing.
#
# A green suite proves nothing on its own: it may be green because the
# evaluator works, or green because the tests do not look at the thing the
# evaluator changed. This gate breaks the evaluator on purpose, one guard at
# a time, and requires the suite to go red in the NAMED test for each.
#
# Every mutation runs against a private staged copy, never the shared
# checkout: in a reused worktree a dirty pr_closeout_ledger.py fails every
# sibling sharing the tree, and this gate's whole job is to dirty it.
#
# Completeness is policed at the bottom: every test method in the suite must
# be named by at least one mutant. An assertion added without a mutant is a
# red build, not a silent gap.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$HERE/.."
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

SUITE=test_pr_closeout_ledger.py
TOOL=pr_closeout_ledger.py

reset_stage() {
  cp "$ROOT/$SUITE" "$STAGE/"
  cp "$ROOT/$TOOL" "$STAGE/"
}

run_suite() {
  (cd "$STAGE" && python3 -m unittest "$SUITE" 2>&1)
}

ran_count() {
  printf '%s\n' "$1" | grep -oE 'Ran [0-9]+ tests' | grep -oE '[0-9]+' | tail -1 || true
}

reset_stage
baseline="$(run_suite)" || {
  printf 'FAIL: unmutated suite is already red\n%s\n' "$baseline" >&2
  exit 1
}
baseline_count="$(ran_count "$baseline")"
[[ -n "$baseline_count" && "$baseline_count" -gt 0 ]] || { echo 'FAIL: baseline ran zero tests' >&2; exit 1; }

covered=()

# Every mutation must keep the suite running the same number of tests (a
# mutant that collapses the suite proves nothing) and must fail in the NAMED
# test rather than some other one.
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
  local name="$1" old="$2" new="$3" expected="$4"
  reset_stage
  OLD="$old" NEW="$new" FILE="$STAGE/$TOOL" python3 - <<'PY'
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
  python3 -m py_compile "$STAGE/$TOOL"
  local output rc=0
  output="$(run_suite 2>&1)" || rc=$?
  assert_caught "$name" "$expected" "$rc" "$output"
}

# --- Exact-head check gates: mergeable_state is never proof. ---
mutate mergeable-clean-read-as-green \
  '    by_name: dict[str, list[dict[str, Any]]] = {}' \
  '    if snapshot.get("mergeableState") == "clean":
        return "GREEN", "mergeable_state is clean"
    by_name: dict[str, list[dict[str, Any]]] = {}' \
  test_clean_mergeable_with_failed_check_is_red
mutate absent-check-read-read-as-clean \
  '        return "UNKNOWN", "absent check read"' \
  '        return "GREEN", "no read needed"' \
  test_clean_mergeable_with_no_check_read_is_unknown
mutate missing-required-name-read-as-clean \
  '        if not exact_head:
            return "UNKNOWN", f"required check {name} has no attempt at exact head"' \
  '        if not exact_head:
            continue' \
  test_clean_mergeable_with_absent_required_name_is_unknown
mutate off-head-attempts-count-as-current \
  '        exact_head = [c for c in by_name.get(name, []) if c.get("sha") == head]' \
  '        exact_head = [c for c in by_name.get(name, [])]' \
  test_moved_head_voids_prior_checks
mutate short-sha-accepted-as-canonical \
  '    return isinstance(sha, str) and FULL_SHA_RE.match(sha) is not None' \
  '    return isinstance(sha, str) and len(sha) >= 7' \
  test_truncated_sha_is_unknown
mutate stale-verdict-reused-as-current \
  '    if not sha or sha != head:' \
  '    if False:' \
  test_moved_head_voids_prior_verdict
mutate neutral-conclusion-read-as-failure \
  'PASS_CONCLUSIONS = {"success", "skipped", "neutral"}' \
  'PASS_CONCLUSIONS = {"success", "skipped"}' \
  test_neutral_conclusion_counts_as_pass
mutate sha-less-verdict-counts-as-current \
  '    if not sha or sha != head:' \
  '    if sha != head:' \
  test_sha_less_verdict_is_history_during_read_gap
mutate empty-required-list-read-as-green \
  '    if not required:' \
  '    if False:' \
  test_empty_required_checks_is_unknown
mutate api-error-read-as-green \
  '    if snapshot.get("apiError"):' \
  '    if False:' \
  test_api_error_is_unknown

# --- Draft / release can never auto-merge. ---
mutate draft-kind-ignored \
  '    if kind in ("draft", "release")' \
  '    if kind in ("no-such-kind",)' \
  test_release_kind_only_never_automerges
mutate snapshot-draft-flag-ignored \
  'or snapshot.get("draft") is True' \
  'or snapshot.get("draft") is "yes-please"' \
  test_snapshot_draft_flag_never_automerges
mutate snapshot-release-flag-ignored \
  'or snapshot.get("releasePlease") is True' \
  'or snapshot.get("releasePlease") == "approved"' \
  test_release_snapshot_flag_never_automerges
mutate registry-draft-kind-ignored \
  '            "disposition": "OWNED_NO_AUTOMERGE",' \
  '            "disposition": "NEEDS_REVIEW",' \
  test_draft_never_automerges

# --- Admission and terminal proof. ---
mutate non-admitted-records-evaluated \
  '    if entry.get("admission") != "admitted":' \
  '    if False:' \
  test_decision_pending_is_excluded
mutate unknown-admission-accepted \
  '        if admission not in ("admitted", "decision_pending"):' \
  '        if False:' \
  test_registry_rejects_unknown_admission
mutate merge-proof-not-required \
  '        if sha_complete(merge_sha) and isinstance(merge_url, str) and merge_url:' \
  '        if True:' \
  test_merge_flag_without_sha_is_not_merged
mutate merge-flag-unread \
  '    if snapshot.get("merged") is True:' \
  '    if False:' \
  test_verified_merge_closes
mutate changes-verdict-unread \
  '    if verdict == "CHANGES":' \
  '    if False:' \
  test_executable_handback_closes
mutate changes-completeness-unchecked \
  '        if isinstance(findings, str) and findings and isinstance(action, str) and action and owner:' \
  '        if True:' \
  test_handback_without_findings_is_stranded
mutate changes-action-unchecked \
  'and isinstance(action, str) and action and owner:' \
  'and True and owner:' \
  test_handback_without_action_is_stranded
mutate changes-owner-unchecked \
  'and isinstance(action, str) and action and owner:' \
  'and isinstance(action, str) and action and True:' \
  test_handback_without_owner_is_stranded
mutate release-kind-read-as-standard \
  '    if kind in ("draft", "release")' \
  '    if kind in ("draft",)' \
  test_release_kind_only_never_automerges
mutate release-standing-owner-ignored \
  '            "nextActor": record.get("standingOwner") or record.get("successorCard") or "Director",' \
  '            "nextActor": record.get("successorCard") or "Director",' \
  test_release_never_automerges
mutate parked-evidence-unchecked \
  '        if isinstance(ceo_evidence, str) and ceo_evidence:' \
  '        if True:' \
  test_parked_without_ceo_evidence_stays_owned
mutate parked-state-unread \
  '    if prior_disp in ("PARKED", "SUPERSEDED"):' \
  '    if False:' \
  test_parked_with_ceo_evidence_holds

# --- Company gates: APPROVE is not closeout. ---
mutate approve-verdict-unread \
  '    if verdict == "APPROVE":' \
  '    if False:' \
  test_approve_open_pr_stays_owned_monitored
mutate reviewer-card-gate-dropped \
  '        if company_review_required and not record.get("reviewerCard"):' \
  '        if False:' \
  test_approve_without_reviewer_card_needs_review
mutate security-gate-dropped \
  '    security_ok = (not company_security_required)' \
  '    security_ok = True' \
  test_approve_with_open_security_gate_needs_review
mutate red-checks-do-not-need-fix \
  '    if check_state == "RED":' \
  '    if False:' \
  test_needs_fix_proposes_owned_repair
mutate approved-disposition-not-terminal-held \
  '                "disposition": "APPROVED_WAIT_CI",' \
  '                "disposition": "MERGED",' \
  test_approve_open_pr_stays_owned_monitored

# --- Bounded liveness barriers: every guard refuses mutation. ---
mutate live-run-barrier-dropped \
  '    if card_has_live_run(card):' \
  '    if False:' \
  test_live_run_blocks_mutation
mutate owner-hold-barrier-dropped \
  '        return "owner_hold"' \
  '        return "no_hold_here"' \
  test_hold_blocks_mutation
mutate pending-interaction-barrier-dropped \
  '        return "pending_interaction"' \
  '        return "no_interaction_here"' \
  test_pending_interaction_blocks_mutation
mutate terminal-card-barrier-dropped \
  '    if card.get("status") in ("done", "cancelled"):' \
  '    if False:' \
  test_terminal_card_blocks_mutation
mutate recovery-barrier-dropped \
  '        return "native_recovery_pending"' \
  '        return "no_recovery_here"' \
  test_native_recovery_blocks_mutation
mutate review-gate-barrier-dropped \
  '        return "review_gate"' \
  '        return "no_gate_here"' \
  test_review_gate_blocks_mutation
mutate interaction-flag-unread \
  '    if card.get("pendingInteraction") is True:' \
  '    if False:' \
  test_pending_interaction_blocks_mutation
mutate cancelled-edge-unread \
  '                return "cancelled_edge"' \
  '                return "live_edge"' \
  test_cancelled_edge_blocks_mutation

# --- Proposal routing: one diagnostic action per admitted card. ---
mutate terminal-records-wake \
  '        if record.get("disposition") in TERMINAL_DISPOSITIONS:' \
  '        if False:' \
  test_excluded_cohort_never_wakes
mutate one-action-cap-dropped \
  '    if card_id in acted_cards:
        return False' \
  '    if False:
        return False' \
  test_one_action_per_card_per_pass
mutate healthy-monitor-not-silent \
  '        if card_monitor_healthy(chosen, now):' \
  '        if False:' \
  test_healthy_monitor_stays_silent_on_healthy_card
mutate lapsed-monitor-unread \
  '        if card_monitor_exhausted(chosen, now):' \
  '        if False:' \
  test_lapsed_monitor_proposes_owned_recheck
mutate wait-ci-hold-proposal-dropped \
  '                reason="approved_wait_ci_owned",' \
  '                reason="missing_disposition",' \
  test_approved_wait_ci_healthy_card_proposes_hold
mutate missing-disposition-proposal-dropped \
  '                reason="missing_disposition",' \
  '                reason="approved_wait_ci_owned",' \
  test_missing_disposition_is_diagnostic_with_owner
mutate unmapped-owner-not-director \
  '                owner="Director",' \
  '                owner="nobody",' \
  test_unmapped_owner_routes_to_director
mutate successor-not-preferred \
  '    return (record.get("successorCard") or record.get("authorCard")' \
  '    return (record.get("authorCard") or record.get("successorCard")' \
  test_successor_preferred_over_author

# --- Recheck cadence is hourly, stall windows are not the cadence. ---
mutate recheck-cadence-uses-stall-deadline \
  '    record["nextCheckAt"] = (anchor + dt.timedelta(hours=RECHECK_HOURS)).isoformat().replace("+00:00", "Z")' \
  '    record["nextCheckAt"] = record["deadlineDirectorAt"]' \
  test_hourly_recheck_is_separate_from_stall_deadlines
mutate proposal-nextcheckat-dropped \
  '            "nextCheckAt": self.next_check_at,' \
  '            "nextCheckAt": None,' \
  test_proposal_carries_record_next_check_at

# --- Owned dependency paths: a wait, never missing, never a promotion. ---
mutate wait-search-skipped \
  '        for wait_candidate, wait_card in present:
            wait_edges = live_blocked_edges(wait_card)' \
  '        for wait_candidate, wait_card in []:
            wait_edges = live_blocked_edges(wait_card)' \
  test_blocked_dependency_is_diagnostic_with_owner
mutate hard-hold-read-as-wait \
  '    barrier = card_barrier(card)
    if barrier == "blocked_dependency":
        return None
    return barrier' \
  '    barrier = card_barrier(card)
    if barrier == "blocked_dependency":
        return None
    return None' \
  test_hard_guard_wins_over_dependency_on_same_card
mutate reviewer-fallback-dropped \
  '        for candidate in (owner, record.get("reviewerCard"),
                          record.get("standingOwner"), record.get("authorCard")):' \
  '        for candidate in (owner,):' \
  test_dependency_check_reaches_live_reviewer
mutate terminal-edge-read-as-live \
  '        if edge.get("status") in ("done", "cancelled"):' \
  '        if edge.get("status") in ("cancelled",):' \
  test_terminal_blocker_edge_is_not_a_dependency
mutate chain-walk-hard-hold-ignored \
  '            walk_hard = card_hard_barrier(walk_card)' \
  '            walk_hard = None' \
  test_hold_blocks_mutation
mutate chain-walk-stops-at-first-wait \
  '        held: tuple[str, dict[str, Any], str] | None = None
        for walk_candidate, walk_card in present:' \
  '        held: tuple[str, dict[str, Any], str] | None = None
        for walk_candidate, walk_card in present[:1]:' \
  test_second_chain_card_hold_wins_over_first_wait
mutate chain-walk-first-card-skipped \
  '        held: tuple[str, dict[str, Any], str] | None = None
        for walk_candidate, walk_card in present:' \
  '        held: tuple[str, dict[str, Any], str] | None = None
        for walk_candidate, walk_card in present[1:]:' \
  test_hold_blocks_mutation
mutate chain-walk-order-flattened \
  '        present = sorted(
            ((c, cards[c]) for c in chain if isinstance(cards.get(c), dict)),
            key=lambda pair: chain.index(pair[0]),
        )' \
  '        present = [(c, cards[c]) for c in cards
                   if isinstance(cards.get(c), dict)]' \
  test_successor_preferred_over_author
mutate wait-chain-single-hop \
  '            terminal, path = follow_wait_chain(cards, blocked_owner)' \
  '            terminal, path = blocked_owner, [blocked_owner]' \
  test_wait_chain_follows_reviewer_to_steward
mutate wait-chain-missing-target-skipped \
  '        target_row = cards.get(target)
        if not isinstance(target_row, dict):
            return None, path' \
  '        target_row = cards.get(target)
        if not isinstance(target_row, dict):
            return cursor, path' \
  test_blocked_dependency_is_diagnostic_with_owner
mutate offchain-target-wait-unowned \
  '            monitor_note = ""
            if card_monitor_exhausted(target_card, now):' \
  '            monitor_note = ""
            if False:' \
  test_exhausted_reviewer_monitor_is_named
mutate waited-target-ignored \
  '        target = edge_target(cursor_edges[0])' \
  '        target = None' \
  test_idle_reviewer_owns_the_wait
mutate reviewer-monitor-unchecked \
  '            if card_monitor_exhausted(target_card, now):' \
  '            if False:' \
  test_exhausted_reviewer_monitor_is_named
mutate follow-chain-terminal-unresolved \
  '            terminal_card = cards[terminal] if terminal is not None else None' \
  '            terminal_card = None' \
  test_steward_edge_resolves_to_steward
mutate soft-wait-stall-unraised \
  '            if stall is not None:
                # A soft wait past its stall window escalates for real: the' \
  '            if False:
                # A soft wait past its stall window escalates for real: the' \
  test_stall_overrides_soft_wait_with_ceo_row

# --- Stall escalation: diagnostic, owner-routed, no reset on read. ---
mutate stall-escalation-dropped \
  '        stall = record_stalled(record, now)' \
  '        stall = None' \
  test_stall_past_director_deadline_proposes_director
mutate ceo-escalation-routed-to-director \
  '    return "CEO" if stall == "stall_ceo" else "Director"' \
  '    return "Director"' \
  test_stall_past_ceo_deadline_proposes_ceo
mutate stall-window-label-flattened \
  '    return "24h" if stall == "stall_ceo" else "6h"' \
  '    return "6h"' \
  test_hard_hold_keeps_owner_with_stall_awareness
mutate stall-deadlines-restart-on-read \
  '    last_progress = (prior or {}).get("lastProgressAt", record["createdAt"])' \
  '    last_progress = now_iso' \
  test_stall_escalation_survives_reread_without_progress
mutate reread-advances-stall-deadlines \
  '    last_progress = (prior or {}).get("lastProgressAt", record["createdAt"])' \
  '    last_progress = now_iso' \
  test_reread_without_progress_keeps_stall_deadlines

# --- Canonical evidence: attempts, age, delivery promise. ---
mutate check-attempts-evidence-dropped \
  '    record["requiredCheckAttempts"] = latest_attempts(snapshot, required)' \
  '    record["requiredCheckAttempts"] = []' \
  test_record_preserves_required_check_attempts
mutate pending-rerun-read-as-green \
  '        newest = newest_attempt(exact_head)
        if newest.get("conclusion") is None:' \
  '        newest = newest_attempt(exact_head)
        if False:' \
  test_pending_rerun_after_success_is_unknown
mutate newest-attempt-unordered \
  '        newest = newest_attempt(exact_head)' \
  '        newest = exact_head[-1]' \
  test_reverse_api_order_picks_newest_result
mutate pending-evidence-hidden \
  '        exact = [
            c for c in per_name.get(name, [])
            if c.get("sha") == head
        ]' \
  '        exact = [
            c for c in per_name.get(name, [])
            if c.get("sha") == head and isinstance(c.get("conclusion"), str)
        ]' \
  test_pending_rerun_after_success_is_unknown
mutate changes-reread-renews-windows \
  '            prior_handback = (prior or {}).get("disposition") == "CHANGES_HANDBACK"' \
  '            prior_handback = False' \
  test_identical_changes_reread_keeps_windows
mutate changes-update-keeps-stale-windows \
  '                "lastProgressAt": last_progress if identical else now_iso,' \
  '                "lastProgressAt": last_progress,' \
  test_changed_changes_action_renews_windows
mutate admission-provenance-unmarked \
  '    record["admissionProvenance"] = provenance' \
  '    record["admissionProvenance"] = None' \
  test_admission_age_defaults_to_first_sight
mutate delivery-deadline-unvalidated \
  '        if isinstance(source, str) and source and parse_time(source) is not None:' \
  '        if isinstance(source, str) and source:' \
  test_invalid_delivery_deadline_is_none_not_raw
mutate off-head-attempts-hidden \
  '            rows_out.append({"name": name, "sha": None, "conclusion": "missing"})' \
  '            rows_out.append({"name": name, "sha": head, "conclusion": "success"})' \
  test_record_preserves_off_head_attempt_as_unknown
mutate admission-age-unstamped \
  '    carry_admission_age(record, entry, prior, now)' \
  '    pass' \
  test_admission_age_and_delivery_deadline_preserved
mutate corrupt-admission-age-invents-first-sight \
  '    if candidate is None and not claimed:' \
  '    if candidate is None:' \
  test_bad_optional_evidence_is_a_gap_not_a_refusal
mutate admission-age-ignores-first-sight \
  '        candidate = record.get("createdAt")' \
  '        candidate = None' \
  test_admission_age_defaults_to_first_sight

# --- Durability: deadlines, history, and refusal paths. ---
mutate director-deadline-shortened \
  'DIRECTOR_STALL_HOURS = 6' \
  'DIRECTOR_STALL_HOURS = 600' \
  test_six_and_twentyfour_hour_deadlines
mutate deadline-uses-ceo-window \
  '    record["deadlineDirectorAt"] = (moment + dt.timedelta(hours=DIRECTOR_STALL_HOURS)).isoformat().replace("+00:00", "Z")' \
  '    record["deadlineDirectorAt"] = (moment + dt.timedelta(hours=CEO_STALL_HOURS)).isoformat().replace("+00:00", "Z")' \
  test_stall_past_director_deadline
mutate empty-registry-accepted \
  '    if not isinstance(entries, list) or not entries:' \
  '    if False:' \
  test_empty_registry_refuses
mutate empty-snapshot-accepted \
  '        raise LedgerError("snapshot holds no PR snapshots or reviews; refusing to report a clean board")' \
  '        pass' \
  test_empty_snapshot_refuses_through_main
mutate cards-only-snapshot-accepted \
  '    if not snapshots and not reviews:' \
  '    if not snapshots and not reviews and not cards:' \
  test_cards_only_snapshot_refuses_through_main
mutate registry-read-failure-ignored \
  '        raise LedgerError(f"registry unreadable: {error}") from error' \
  '        return []' \
  test_unknown_inputs_refuse_clean

# --- Director handback 2026-10-02: six concrete counterexamples, one mutant
# each (plus chain plumbing). Each names its regression above; the gate
# below polices that every new test is load-bearing. ---
mutate hard-guard-suppressed-by-wait \
  '    barrier = card_barrier(card)
    if barrier == "blocked_dependency":
        return None
    return barrier' \
  '    if live_blocked_edges(card):
        return None
    return card_barrier(card)' \
  test_hard_guard_wins_over_dependency_on_same_card
mutate chain-stops-at-first-edge \
  '            terminal, path = follow_wait_chain(cards, blocked_owner)' \
  '            terminal, path = (edge_target(edges[0]), [blocked_owner])' \
  test_wait_chain_follows_reviewer_to_steward
mutate hard-guard-always-none \
  '    barrier = card_barrier(card)
    if barrier == "blocked_dependency":
        return None
    return barrier' \
  '    barrier = card_barrier(card)
    if barrier == "blocked_dependency":
        return None
    return None' \
  test_blocked_author_yields_to_live_reviewer
mutate chain-cycle-unbounded \
  '        if target in seen:
            return None, path + [target]' \
  '        if False:
            pass' \
  test_wait_cycle_strands_with_path_named
mutate chain-hop-budget-removed \
  '    for _ in range(MAX_WAIT_CHAIN_HOPS):' \
  '    while True:' \
  test_long_chain_strands_at_hop_budget
mutate stall-before-terminal-guard \
  '            terminal, path = follow_wait_chain(cards, blocked_owner)
            terminal_card = cards[terminal] if terminal is not None else None
            terminal_hard = (card_hard_barrier(terminal_card)
                             if terminal_card is not None else None)
            if terminal_hard is not None:' \
  '            terminal, path = follow_wait_chain(cards, blocked_owner)
            terminal_card = None
            terminal_hard = None
            if False:' \
  test_terminal_chain_end_is_moot_not_a_stall
mutate terminal-guard-falls-through-to-stall \
  '                ))
                continue
            if stall is not None:
                # A soft wait past its stall window escalates for real: the' \
  '                ))
                pass
            if stall is not None:
                # A soft wait past its stall window escalates for real: the' \
  test_terminal_chain_end_is_moot_not_a_stall
mutate verdict-evidence-row-split \
  '        newest = newest_attempt(exact_head)
        if newest.get("conclusion") is None:' \
  '        newest = newest_attempt(exact_head)
        if any(c.get("conclusion") is None for c in exact_head):' \
  test_older_pending_row_does_not_veto_newer_result
mutate pending-evidence-reads-any-pending \
  '        exact = [
            c for c in per_name.get(name, [])
            if c.get("sha") == head
        ]' \
  '        exact = [
            c for c in per_name.get(name, [])
            if c.get("sha") == head and c.get("conclusion") is not None
        ]' \
  test_pending_rerun_after_success_is_unknown
mutate first-sight-relabelled-as-prior \
  '                if origin == "prior" and (prior or {}).get("admissionProvenance") == "first_sight":
                    # A first-sight lower bound stays marked unproven across
                    # persisted rereads; relabeling it "prior" would present an
                    # unmeasured bound as a tracked admission date.
                    provenance = "first_sight"
                else:' \
  '                if False:
                    # A first-sight lower bound stays marked unproven across
                    # persisted rereads; relabeling it "prior" would present an
                    # unmeasured bound as a tracked admission date.
                    provenance = "first_sight"
                else:' \
  test_first_sight_provenance_survives_persisted_reread
mutate barrier-branch-cap-dropped \
  '            if not claim_proposal_card(acted_cards, str(held_owner)):
                continue' \
  '            pass' \
  test_per_card_cap_covers_barrier_branches
mutate wait-strand-cap-dropped \
  '            if terminal is None:
                if not claim_proposal_card(acted_cards, str(blocked_owner)):
                    continue' \
  '            if terminal is None:
                pass' \
  test_wait_cycle_strands_with_path_named

# --- Review CHANGES: three
# blocking evaluator defects plus the advisory next-action text, and the
# read-gap variants that would launder the progress clock. ---
mutate head-move-renewal-dropped \
  '    if prior_head and isinstance(head, str) and head and prior_head != head:' \
  '    if False:' \
  test_head_move_renews_progress_clock
mutate red-green-renewal-dropped \
  '    if prior.get("checkState") == "RED" and check_state == "GREEN":' \
  '    if False:' \
  test_red_to_green_renews_progress_clock
mutate unknown-green-counts-as-progress \
  '    if prior.get("checkState") == "RED" and check_state == "GREEN":' \
  '    if prior.get("checkState") != "GREEN" and check_state == "GREEN":' \
  test_failed_read_between_greens_does_not_launder_clock
mutate new-approve-renewal-dropped \
  '            and carried_approved_head(prior) != head):' \
  '            and False):' \
  test_new_approve_at_head_renews_progress_clock
mutate approve-flap-counts-as-new \
  '            and carried_approved_head(prior) != head):' \
  '            and prior.get("verdict") != "APPROVE"):' \
  test_approve_flap_at_same_head_does_not_launder_clock
mutate approved-baseline-not-persisted \
  '    record["lastApprovedHeadSha"] = approved' \
  '    record["lastApprovedHeadSha"] = None' \
  test_approve_flap_at_same_head_does_not_launder_clock
mutate every-reread-renews-clock \
  '    return False


def append_superseded_history' \
  '    return True


def append_superseded_history' \
  test_unchanged_reread_keeps_progress_clock
mutate known-head-ignores-carried-baseline \
  '    for key in ("headSha", "lastKnownHeadSha"):' \
  '    for key in ("headSha",):' \
  test_head_move_across_read_gap_still_renews
mutate known-head-not-persisted-across-gap \
  '    record["lastKnownHeadSha"] = head if isinstance(head, str) and head else known' \
  '    record["lastKnownHeadSha"] = head if isinstance(head, str) and head else None' \
  test_head_move_across_read_gap_still_renews
mutate approved-next-action-says-reread \
  '"nextAction": "approving reviewer squash-merges at this exact head; SHA change voids this approval",' \
  '"nextAction": "re-read checks at exact head; SHA change voids this approval",' \
  test_approved_wait_ci_next_action_names_the_merger
mutate merged-not-sticky-on-failed-read \
  '                and not read_measures_merge_state(snapshot)):' \
  '                and False):' \
  test_merged_survives_failed_read
mutate failed-read-counts-as-measurement \
  '    return not snapshot.get("apiError") and snapshot.get("merged") is False' \
  '    return snapshot.get("merged") is False' \
  test_merged_survives_failed_read
mutate absent-snapshot-counts-as-measurement \
  '    if not isinstance(snapshot, dict):
        return False
    if (snapshot.get("merged") is True' \
  '    if not isinstance(snapshot, dict):
        return True
    if (snapshot.get("merged") is True' \
  test_merged_survives_absent_snapshot
mutate merged-sticky-without-prior-proof \
  'sha_complete(prior_sha) and isinstance(prior_url, str) and prior_url' \
  'True' \
  test_merged_without_prior_proof_is_not_sticky
mutate measured-open-read-never-overrules \
  '    return not snapshot.get("apiError") and snapshot.get("merged") is False' \
  '    return False' \
  test_measured_open_read_overrules_prior_merged
mutate history-appended-on-every-read \
  '        if isinstance(prior_head, str) and prior_head and prior_head != current_head:' \
  '        if isinstance(prior_head, str) and prior_head:' \
  test_identical_rereads_do_not_grow_history
mutate head-move-history-row-dropped \
  '        if isinstance(prior_head, str) and prior_head and prior_head != current_head:' \
  '        if isinstance(prior_head, str) and prior_head and False:' \
  test_head_move_appends_exactly_one_history_row
mutate history-cap-dropped \
  '    record["history"] = history[-HISTORY_CAP:]' \
  '    record["history"] = history' \
  test_history_is_capped_keeping_the_newest_rows
mutate read-gap-history-row-dropped \
  '        if isinstance(prior_head, str) and prior_head and prior_head != current_head:' \
  '        if isinstance(prior_head, str) and prior_head and current_head and prior_head != current_head:' \
  test_read_gap_supersedes_prior_head_once
mutate read-gap-history-reason-mislabelled \
  '"head unread; prior read kept as history only"' \
  '"head moved; kept as history only"' \
  test_read_gap_supersedes_prior_head_once

# Completeness. Every test in the suite must be named by at least one mutant
# above. Without this, an assertion added with no mutant is indistinguishable
# from an assertion that cannot fail.
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
  printf 'FAIL: assertions with no mutant proving they are load-bearing:\n%s\n' "$UNCOVERED" >&2
  exit 1
fi

printf 'PASS: %s closeout mutations detected, covering all %s assertions\n' \
  "${#covered[@]}" "$baseline_count"
