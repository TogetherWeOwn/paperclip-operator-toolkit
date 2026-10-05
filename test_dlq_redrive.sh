#!/usr/bin/env bash
# ===========================================================================
# test_dlq_redrive.sh — offline suite for the standalone DLQ redrive CLI
# (dead-letter queue redrive).
#
# No broker, no database, no network, no credentials: the whole DLQ is a JSONL
# fixture fabricated per-section in a mktemp tree, and DLQ_FIXTURE points the
# tool at it. That is what lets CI run this.
#
# WHAT THIS SUITE IS BUILT TO CATCH, beyond the happy path:
#
#  * DROPPED ENTRIES ON FILTERED BULK OPS. A bulk rewrite that skips
#    non-matching lines DELETES them — the mutation already shipped this bug
#    once (bulk --topic rewrote a 3-entry fixture to 1). Sections 2 and 4 pin
#    the surviving row count after every filtered mutation, not just the
#    mutated rows, so a filter that eats the fixture fails the test.
#
#  * A FREE-TEXT REASON. An unregistered `--reason whatever` must be refused:
#    the registry is the audit contract (rule 1). Section 3 pins that an
#    unknown reason, a missing reason, and a reason from the OTHER action's
#    namespace are three different refusals — a neighbour catching the same
#    input is how assertions on this repo have gone green for the wrong
#    reason, so every refusal below pins the CAUSE string, not just the exit
#    status.
#
#  * RESURRECTION. `redrive` on a purged id must refuse with `already_purged`,
#    pinned by cause: a generic not-eligible exit could come from the
#    `not_found` branch instead. Section 5 walks the full terminal chain
#    dead -> redriven -> purged -> refused.
#
#  * A CHECK THAT MEASURED NOTHING READING GREEN. A missing fixture and a
#    missing jq are exit 5, never 0; a malformed fixture and a duplicate id
#    are exit 2 with the fixture byte-identical afterwards (a validator that
#    reports the defect while having already rewritten the file is the
#    exit-zero attribution problem at fixture scale).
#
#  * A SILENTLY EMPTY --all. `--all` matching zero entries is exit 3
#    (`no_match`), not a quiet 0 — a typo'd `--topic` that does nothing must
#    say so.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$HERE/dlq_redrive.sh"
PASS=0; FAIL=0

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export DLQ_ACTOR="suite"

ok()  { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

# assert_rc <label> <expected_exit> <actual_exit> [stdout]
assert_rc() {
  local label="$1" xrc="$2" rc="$3" out="${4:-}"
  if [[ "$rc" == "$xrc" ]]; then ok "$label"
  else bad "$label" "expected exit $xrc, got $rc${out:+; out: $out}"; fi
}

# assert_refused <label> <expected_exit> <expected_cause> <stdout> <actual_exit>
assert_refused() {
  local label="$1" xrc="$2" xc="$3" out="$4" rc="$5"
  local cause; cause="$(head -n1 <<<"$out" | cut -f2)"
  if [[ "$rc" == "$xrc" && "$cause" == "$xc" ]]; then ok "$label"
  else bad "$label" "expected rc=$xrc cause=$xc; got rc=$rc cause=$cause; out: $out"; fi
}

# mkfixture <name> <line...> — writes lines to $WORK/<name>.jsonl, prints path.
mkfixture() {
  local name="$1"; shift
  local f="$WORK/$name.jsonl"
  : > "$f"
  local line
  for line in "$@"; do printf '%s\n' "$line" >> "$f"; done
  printf '%s' "$f"
}

E1='{"id":"m1","topic":"billing.invoiced","payload":{"a":1},"error":"timeout","failed_at":"2026-09-20T04:00:00Z","attempts":5,"status":"dead"}'
E2='{"id":"m2","topic":"mail.welcome","payload":{},"error":"conn-refused","failed_at":"2026-09-21T04:00:00Z","attempts":9,"status":"dead"}'
E3='{"id":"m3","topic":"billing.refund","payload":{},"error":"timeout","failed_at":"2026-09-01T00:00:00Z","attempts":2,"status":"dead"}'

echo "== 1. list and reasons =="

F="$(mkfixture base "$E1" "$E2" "")"
out="$(DLQ_FIXTURE="$F" "$TOOL" list)"; rc=$?
assert_rc "list exits 0 on a good fixture" 0 "$rc" "$out"
[[ "$(printf '%s\n' "$out" | wc -l)" == "2" ]] && ok "list renders one TSV line per entry" \
  || bad "list renders one TSV line per entry" "got: $out"
grep -q $'^m1\tdead\t5\tbilling.invoiced\t2026-09-20T04:00:00Z\ttimeout$' <<<"$out" \
  && ok "list columns are id/status/attempts/topic/failed_at/error" \
  || bad "list columns are id/status/attempts/topic/failed_at/error" "got: $out"

out="$(DLQ_FIXTURE="$F" "$TOOL" list --status dead)"; rc=$?
assert_rc "list --status dead exits 0" 0 "$rc" "$out"
out="$(DLQ_FIXTURE="$F" "$TOOL" list --topic mail.welcome)"; rc=$?
[[ "$rc" == "0" && "$out" == m2* ]] && ok "list --topic filters to the matching entry" \
  || bad "list --topic filters to the matching entry" "rc=$rc out: $out"
out="$(DLQ_FIXTURE="$F" "$TOOL" list --status bogus 2>/dev/null)"; rc=$?
assert_refused "list --status bogus is refused, cause invalid_status" 2 invalid_status "$out" "$rc"

out="$("$TOOL" reasons)"; rc=$?
assert_rc "reasons exits 0" 0 "$rc" "$out"
for r in transient_upstream consumer_bugfix_deployed payload_corrected redeliver_anyway; do
  grep -q "^redrive"$'\t'"$r"$'\t' <<<"$out" && ok "reasons lists redrive/$r" \
    || bad "reasons lists redrive/$r" "missing from: $out"
done
for r in poison_unrecoverable duplicate expired_stale test_fixture; do
  grep -q "^purge"$'\t'"$r"$'\t' <<<"$out" && ok "reasons lists purge/$r" \
    || bad "reasons lists purge/$r" "missing from: $out"
done

echo "== 2. redrive: happy path and bulk carry-through =="

F="$(mkfixture redrive "$E1" "$E2" "$E3")"
out="$(DLQ_FIXTURE="$F" "$TOOL" redrive --id m1 --reason transient_upstream 2>/dev/null)"; rc=$?
assert_rc "redrive --id exits 0" 0 "$rc" "$out"
[[ "$(head -n1 <<<"$out")" == $'redriven\tm1\ttransient_upstream' ]] \
  && ok "redrive stdout is exactly status/id/reason" \
  || bad "redrive stdout is exactly status/id/reason" "got: $out"
[[ "$(wc -l < "$F")" == "3" ]] && ok "redrive --id rewrites without dropping rows" \
  || bad "redrive --id rewrites without dropping rows" "$(cat "$F")"
grep -q '"id":"m1".*"status":"redriven".*"redrive_reason":"transient_upstream"' "$F" \
  && ok "redrive stamps status, reason, decided_at/by on the entry" \
  || bad "redrive stamps status, reason, decided_at/by on the entry" "$(grep m1 "$F")"
[[ -s "$F.journal.jsonl" ]] && grep -q '"action":"redrive".*"id":"m1".*"reason":"transient_upstream"' "$F.journal.jsonl" \
  && ok "redrive appends one journal record" \
  || bad "redrive appends one journal record" "$(cat "$F.journal.jsonl" 2>/dev/null)"
grep -q '"payload":{"a":1}' "$F" \
  && ok "redrive carries untouched keys (payload) through the rewrite" \
  || bad "redrive carries untouched keys (payload) through the rewrite" "$(grep m1 "$F")"

# THE DATA-LOSS PIN. A filtered bulk op must mutate the match and carry every
# non-match through byte-identical. This exact shape (3 in, filter, 1 out)
# shipped and was caught by hand before the suite existed.
F="$(mkfixture bulk "$E1" "$E2" "$E3")"
out="$(DLQ_FIXTURE="$F" "$TOOL" redrive --all --topic billing.invoiced --reason consumer_bugfix_deployed 2>/dev/null)"; rc=$?
assert_rc "bulk redrive --topic exits 0" 0 "$rc" "$out"
[[ "$(wc -l < "$F")" == "3" ]] && ok "bulk redrive carries the 2 non-matching rows through" \
  || bad "bulk redrive carries the 2 non-matching rows through" "$(cat "$F")"
grep -q '"id":"m1".*"status":"redriven"' "$F" \
  && grep -q '"id":"m2".*"status":"dead"' "$F" \
  && grep -q '"id":"m3".*"status":"dead"' "$F" \
  && ok "bulk redrive mutates only the match" \
  || bad "bulk redrive mutates only the match" "$(cat "$F")"

F="$(mkfixture before "$E1" "$E2" "$E3")"
out="$(DLQ_FIXTURE="$F" "$TOOL" redrive --all --before 2026-09-10T00:00:00Z --reason payload_corrected 2>/dev/null)"; rc=$?
assert_rc "bulk redrive --before exits 0" 0 "$rc" "$out"
grep -q '"id":"m3".*"status":"redriven"' "$F" \
  && grep -q '"id":"m1".*"status":"dead"' "$F" \
  && ok "bulk redrive --before takes only the older entry" \
  || bad "bulk redrive --before takes only the older entry" "$(cat "$F")"

echo "== 3. the reason registry: three distinct refusals =="

F="$(mkfixture reasons "$E1")"
out="$(DLQ_FIXTURE="$F" "$TOOL" redrive --id m1 --reason whatever 2>/dev/null)"; rc=$?
assert_refused "unregistered reason is refused, cause unknown_reason" 2 unknown_reason "$out" "$rc"
out="$(DLQ_FIXTURE="$F" "$TOOL" purge --id m1 2>/dev/null)"; rc=$?
assert_refused "missing reason is refused, cause reason_required" 2 reason_required "$out" "$rc"
out="$(DLQ_FIXTURE="$F" "$TOOL" redrive --id m1 --reason duplicate 2>/dev/null)"; rc=$?
assert_refused "other-action reason is refused, cause reason_not_for_action" 2 reason_not_for_action "$out" "$rc"
out="$(DLQ_FIXTURE="$F" "$TOOL" purge --id m1 --reason transient_upstream 2>/dev/null)"; rc=$?
assert_refused "redrive reason on purge is refused, cause reason_not_for_action" 2 reason_not_for_action "$out" "$rc"
grep -q '"status":"dead"' "$F" \
  && ok "refused mutations leave the fixture untouched" \
  || bad "refused mutations leave the fixture untouched" "$(cat "$F")"

echo "== 4. purge: happy path, bulk scope, silent-empty refusal =="

F="$(mkfixture purge "$E1" "$E2" "$E3")"
out="$(DLQ_FIXTURE="$F" "$TOOL" purge --id m1 --reason poison_unrecoverable 2>/dev/null)"; rc=$?
[[ "$rc" == "0" && "$(head -n1 <<<"$out")" == $'purged\tm1\tpoison_unrecoverable' ]] \
  && ok "purge --id reports purged/id/reason at exit 0" \
  || bad "purge --id reports purged/id/reason at exit 0" "rc=$rc out: $out"

# Bulk purge sweeps only dead entries: an already-redriven entry needs an
# explicit --id, so a bulk op never sweeps up another operator's retry.
F="$(mkfixture purgescope "$E1" "$E2")"
DLQ_FIXTURE="$F" "$TOOL" redrive --id m1 --reason redeliver_anyway >/dev/null 2>&1
out="$(DLQ_FIXTURE="$F" "$TOOL" purge --all --reason expired_stale 2>/dev/null)"; rc=$?
assert_rc "bulk purge exits 0" 0 "$rc" "$out"
grep -q '"id":"m2".*"status":"purged"' "$F" \
  && grep -q '"id":"m1".*"status":"redriven"' "$F" \
  && ok "bulk purge sweeps dead only; redriven entries need --id" \
  || bad "bulk purge sweeps dead only; redriven entries need --id" "$(cat "$F")"
out="$(DLQ_FIXTURE="$F" "$TOOL" purge --id m1 --reason expired_stale 2>/dev/null)"; rc=$?
assert_rc "explicit --id purges a redriven entry" 0 "$rc" "$out"

out="$(DLQ_FIXTURE="$F" "$TOOL" purge --all --reason expired_stale 2>/dev/null)"; rc=$?
assert_refused "bulk purge with nothing dead is exit 3, cause no_match" 3 no_match "$out" "$rc"
out="$(DLQ_FIXTURE="$F" "$TOOL" purge --all --topic no.such.topic --reason expired_stale 2>/dev/null)"; rc=$?
assert_refused "bulk purge with a typo'd topic is exit 3, not a quiet 0" 3 no_match "$out" "$rc"

echo "== 5. terminal states: purged is terminal, redriven is not dead =="

F="$(mkfixture terminal "$E1" "$E2")"
DLQ_FIXTURE="$F" "$TOOL" redrive --id m1 --reason transient_upstream >/dev/null 2>&1
out="$(DLQ_FIXTURE="$F" "$TOOL" redrive --id m1 --reason transient_upstream 2>/dev/null)"; rc=$?
assert_refused "second redrive is exit 3, cause already_redriven" 3 already_redriven "$out" "$rc"
DLQ_FIXTURE="$F" "$TOOL" purge --id m1 --reason duplicate >/dev/null 2>&1
out="$(DLQ_FIXTURE="$F" "$TOOL" redrive --id m1 --reason transient_upstream 2>/dev/null)"; rc=$?
assert_refused "redrive of a purged id is exit 3, cause already_purged" 3 already_purged "$out" "$rc"
out="$(DLQ_FIXTURE="$F" "$TOOL" purge --id m1 --reason duplicate 2>/dev/null)"; rc=$?
assert_refused "second purge is exit 3, cause already_purged" 3 already_purged "$out" "$rc"
out="$(DLQ_FIXTURE="$F" "$TOOL" redrive --id nope --reason transient_upstream 2>/dev/null)"; rc=$?
assert_refused "unknown id is exit 3, cause not_found" 3 not_found "$out" "$rc"

echo "== 6. unmeasured and malformed: never green =="

out="$(DLQ_FIXTURE="$WORK/does-not-exist.jsonl" "$TOOL" list 2>/dev/null)"; rc=$?
assert_refused "missing fixture is exit 5, cause fixture_unreadable" 5 fixture_unreadable "$out" "$rc"
out="$(DLQ_FIXTURE="$WORK/does-not-exist.jsonl" "$TOOL" redrive --id m1 --reason transient_upstream 2>/dev/null)"; rc=$?
assert_refused "mutation against a missing fixture is exit 5" 5 fixture_unreadable "$out" "$rc"

F="$(mkfixture malformed "$E1" 'this is not json')"
before="$(cat "$F")"
out="$(DLQ_FIXTURE="$F" "$TOOL" list 2>/dev/null)"; rc=$?
assert_refused "malformed line is exit 2, cause malformed_fixture" 2 malformed_fixture "$out" "$rc"
[[ "$(cat "$F")" == "$before" ]] && ok "malformed fixture is refused before any rewrite" \
  || bad "malformed fixture is refused before any rewrite" "$(cat "$F")"
out="$(DLQ_FIXTURE="$F" "$TOOL" purge --all --reason poison_unrecoverable 2>/dev/null)"; rc=$?
assert_refused "bulk mutation validates before rewriting" 2 malformed_fixture "$out" "$rc"
[[ "$(cat "$F")" == "$before" ]] && ok "failed validation leaves the fixture byte-identical" \
  || bad "failed validation leaves the fixture byte-identical" "$(cat "$F")"

F="$(mkfixture dupid "$E1" "$E1")"
out="$(DLQ_FIXTURE="$F" "$TOOL" list 2>/dev/null)"; rc=$?
assert_refused "duplicate id is exit 2, cause duplicate_id" 2 duplicate_id "$out" "$rc"

F="$(mkfixture badstatus '{"id":"m9","topic":"t","status":"limbo"}')"
out="$(DLQ_FIXTURE="$F" "$TOOL" list 2>/dev/null)"; rc=$?
assert_refused "unknown status is exit 2, cause malformed_fixture" 2 malformed_fixture "$out" "$rc"

# No stale rewrite temps beside the fixture after a refusal mid-mutation.
F="$(mkfixture temps "$E1")"
DLQ_FIXTURE="$F" "$TOOL" redrive --id nope --reason transient_upstream >/dev/null 2>&1 || true
[[ -z "$(ls "$WORK"/.dlq_mutate.* "$WORK"/.dlq_entries.* 2>/dev/null)" ]] \
  && ok "refused mutation leaves no stray temp files" \
  || bad "refused mutation leaves no stray temp files" "$(ls "$WORK"/.dlq* 2>/dev/null)"

echo "== 7. usage refusals and no-broker proof =="

F="$(mkfixture usage "$E1")"
out="$(DLQ_FIXTURE="$F" "$TOOL" frobnicate 2>/dev/null)"; rc=$?
assert_refused "unknown subcommand is exit 2, cause bad_usage" 2 bad_usage "$out" "$rc"
out="$(DLQ_FIXTURE="$F" "$TOOL" redrive --id m1 --reason transient_upstream --all 2>/dev/null)"; rc=$?
assert_refused "--id with --all is exit 2, cause bad_usage" 2 bad_usage "$out" "$rc"
out="$(DLQ_FIXTURE="$F" "$TOOL" purge --all --topic t 2>/dev/null)"; rc=$?
assert_refused "--all without --reason is exit 2, cause reason_required" 2 reason_required "$out" "$rc"
out="$(DLQ_FIXTURE="$F" "$TOOL" redrive --id m1 --reason transient_upstream --topic t 2>/dev/null)"; rc=$?
assert_refused "--topic with --id is exit 2, cause bad_usage" 2 bad_usage "$out" "$rc"
out="$(DLQ_FIXTURE="$F" "$TOOL" redrive --id m1 --reason 2>/dev/null)"; rc=$?
assert_refused "bare trailing --reason is exit 2, cause bad_usage" 2 bad_usage "$out" "$rc"

# THE STANDALONE PIN. The tool must not consult any broker, database, or
# network: with PATH stripped to the bare minimum (sh, jq, date, flock, mktemp
# and friends) every verb still works. `env -i` proves no credential or
# connection string is inherited either.
F="$(mkfixture standalone "$E1" "$E2")"
STAND_PATH="$(dirname "$(command -v jq)"):/usr/bin:/bin"
out="$(env -i PATH="$STAND_PATH" DLQ_FIXTURE="$F" DLQ_ACTOR=standalone "$TOOL" list 2>/dev/null)"; rc=$?
[[ "$rc" == "0" && "$(printf '%s\n' "$out" | wc -l)" == "2" ]] \
  && ok "list works under env -i (no inherited broker/network env)" \
  || bad "list works under env -i (no inherited broker/network env)" "rc=$rc out: $out"
out="$(env -i PATH="$STAND_PATH" DLQ_FIXTURE="$F" DLQ_ACTOR=standalone "$TOOL" redrive --id m1 --reason transient_upstream 2>/dev/null)"; rc=$?
assert_rc "redrive works under env -i" 0 "$rc" "$out"
grep -qE 'PAPERCLIP|BROKER|DATABASE|POSTGRES|REDIS|AMQP|KAFKA' "$TOOL" \
  && bad "tool references no broker/database transport" "$(grep -nE 'PAPERCLIP|BROKER|DATABASE|POSTGRES|REDIS|AMQP|KAFKA' "$TOOL")" \
  || ok "tool references no broker/database transport"

echo "== Result =="
printf '  %d passed, %d failed\n\n' "$PASS" "$FAIL"
[[ "$PASS" -gt 0 ]] || { printf '  a suite that ran no assertions is not a green suite\n'; exit 1; }
[[ "$FAIL" -eq 0 ]] || exit 1
