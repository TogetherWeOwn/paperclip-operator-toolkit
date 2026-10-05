#!/usr/bin/env bash
# ===========================================================================
# Offline regression suite for op_approval_executor.sh (Part B3, source-only).
#
# NO NETWORK, NO CREDENTIALS, NO HOST MUTATION. Every case runs in a mktemp
# sandbox with fixed fixtures and a pinned clock (OP_EXEC_NOW), so the expiry
# and liveness checks are deterministic. Assertions pin EXIT CODES and the
# machine-readable stdout JSON fields (via jq) — never stderr prose, which
# drifts by design.
#
# Section map (each is a required boundary from the task):
#   1. happy paths: verify-only passes; execute runs the fixed script once,
#      writes one receipt + one log line, ignores the untrusted `command`.
#   2. approval re-verification: forged approver, declined, expired approval,
#      expired request, wrong action/args/card/hash, tampered request,
#      future-dated approval, superseded flag and supersede marker, missing
#      and malformed evidence.
#   3. allowlist boundary: unknown action, shell-metachar action, unlisted
#      arg, secret-shaped arg, pattern-breaking arg, missing required arg.
#   4. replay/concurrency: second execute is a replay; pre-claimed id is
#      busy; a failed script records its receipt and is NOT retried.
#   5. filesystem boundary: request outside the queue, symlink escape,
#      script outside the scripts dir, group-writable script, non-canonical
#      allowlist script path.
#   6. SHADOW: execute refuses without running; verify-only still verifies.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v jq >/dev/null || { echo "ERROR: jq required" >&2; exit 1; }

TOOL="${TOOL_UNDER_TEST:-$HERE/op_approval_executor.sh}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0

ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; [[ -n "${2:-}" ]] && printf '       %s\n' "$2"; }
section() { printf '\n== %s\n' "$1"; }

# ---- sandbox ---------------------------------------------------------------
Q="$TMP/queue"; P="$TMP/processed"; S="$TMP/scripts"
mkdir -p "$Q" "$P" "$S"
ALLOW="$TMP/allowlist.json"
APPROVERS="$TMP/approvers.txt"
SHADOW="$TMP/SHADOW"   # absent unless a case creates it
LOG="$TMP/execution.log"
export OP_EXEC_ALLOWLIST="$ALLOW" OP_EXEC_APPROVERS="$APPROVERS"
export OP_EXEC_QUEUE_DIR="$Q" OP_EXEC_PROCESSED_DIR="$P"
export OP_EXEC_SCRIPTS_DIR="$S" OP_EXEC_SHADOW_FILE="$SHADOW"
export OP_EXEC_LOG="$LOG" OP_EXEC_REQUIRE_ROOT_OWNERSHIP=0
export OP_EXEC_NOW="2026-10-05T19:00:00Z"

printf 'ceo\n' > "$APPROVERS"

# Fixed fixture scripts. worker records its argv; failer always fails;
# evil is the "attacker" binary that must NEVER run.
cat > "$S/worker.sh" <<EOF
#!/usr/bin/env bash
for a in "\$@"; do case "\$a" in --out=*) p="\${a#--out=}"; printf 'ran: %s\n' "\$*" > "\$p";; esac; done
exit 0
EOF
chmod 755 "$S/worker.sh"
printf '#!/usr/bin/env bash\nexit 3\n' > "$S/failer.sh"; chmod 755 "$S/failer.sh"
printf '#!/usr/bin/env bash\ntouch "%s/EVIL_RAN"\nexit 0\n' "$TMP" > "$S/evil.sh"; chmod 755 "$S/evil.sh"

cat > "$ALLOW" <<EOF
{"version":1,"actions":{
"restart-queue-worker":{"script":"$S/worker.sh",
  "args":{"queue":{"pattern":"^[a-z0-9_-]{1,32}\$","max_len":32,"required":true},
          "reason":{"pattern":"^[A-Za-z0-9 _.,:@+-]{1,128}\$","max_len":128},
          "out":{"pattern":"^/[A-Za-z0-9_./-]+$","max_len":256}},
  "rollback":"re-run the worker with the previous queue snapshot",
  "timeout_secs":30,"human_only":false,"spend":false},
"always-fails":{"script":"$S/failer.sh","args":{},"rollback":"read the receipt, fix by hand",
  "timeout_secs":30,"human_only":false,"spend":false},
"human-action":{"script":"$S/worker.sh","args":{},"rollback":"n/a",
  "timeout_secs":30,"human_only":true,"spend":false},
"spend-action":{"script":"$S/worker.sh","args":{},"rollback":"n/a",
  "timeout_secs":30,"human_only":false,"spend":true}}}
EOF
chmod 644 "$ALLOW"

# ---- fixture builders ---------------------------------------------------------
# mk_pair DIR REQID ACTION [extra-request-jq] [extra-approval-jq]
# Writes DIR/req.json + DIR/app.json with a CORRECT binding hash; prints DIR.
mk_pair() {
  local d="$1" rid="$2" action="$3" rxtra="${4:-}" axtra="${5:-}"
  local req="$d/req.json" app="$d/app.json" args='{"queue":"default"}'
  if [[ "$action" == "always-fails" || "$action" == "human-action" || "$action" == "spend-action" ]]; then
    args='{}'
  fi
  jq -n --arg r "$rid" --arg c "card-1" --arg a "$action" --argjson ag "$args" \
    '{request_id:$r,card_id:$c,action:$a,args:$ag,
      request_hash:"",created_at:"2026-10-05T18:00:00Z",expires_at:"2026-10-05T20:00:00Z"}' > "$req"
  [[ -n "$rxtra" ]] && jq "$rxtra" -- "$req" > "$req.tmp" && mv "$req.tmp" "$req"
  local hash
  hash="sha256:$(jq -S -c '{request_id,card_id,action,args}' -- "$req" | sha256sum | cut -d' ' -f1)"
  jq --arg h "$hash" '.request_hash = $h' -- "$req" > "$req.tmp" && mv "$req.tmp" "$req"
  jq -n --arg r "$rid" --arg c "card-1" --arg a "$action" --argjson ag "$args" --arg h "$hash" \
    '{request_id:$r,card_id:$c,action:$a,args:$ag,request_hash:$h,approver:"ceo",
      decision:"approved",approved_at:"2026-10-05T18:30:00Z",expires_at:"2026-10-05T20:00:00Z"}' > "$app"
  [[ -n "$axtra" ]] && jq "$axtra" -- "$app" > "$app.tmp" && mv "$app.tmp" "$app"
}

run_tool() { # args... -> sets RC, OUT (stdout json)
  OUT="$("$TOOL" "$@" 2>"$TMP/stderr.txt")"; RC=$?
}

expect() { # $1=label $2=want_rc $3=want_outcome $4=want_reason
  local label="$1" wrc="$2" wout="$3" wreason="$4" got_r got_o got_rr
  got_r="$RC"; got_o="$(jq -r '.outcome // "?"' <<<"$OUT" 2>/dev/null)"; got_rr="$(jq -r '.reason_code // "?"' <<<"$OUT" 2>/dev/null)"
  if [[ "$got_r" == "$wrc" && "$got_o" == "$wout" && "$got_rr" == "$wreason" ]]; then
    ok "$label (rc=$got_r $got_o/$got_rr)"
  else
    bad "$label (want rc=$wrc $wout/$wreason, got rc=$got_r $got_o/$got_rr)" "$OUT"
  fi
}

# ===========================================================================
section "1. happy paths"
D="$TMP/c1"; mkdir -p "$D"
mk_pair "$D" "req-happy" "restart-queue-worker"
# Fixtures here live OUTSIDE the queue dir, so point the jail at D for the
# verify-only call (section 5 proves the jail itself refuses escapes).
OP_EXEC_QUEUE_DIR="$D" run_tool verify-only --request "$D/req.json" --approval "$D/app.json"
expect "verify-only passes on a clean pair" 0 verified approval_ok
[ -e "$P/req-happy.receipt.json" ] && bad "verify-only must not write a receipt" || ok "verify-only writes no receipt"

C="$TMP/c1e"; mkdir -p "$C"; mk_pair "$C" "req-exec" "restart-queue-worker" \
  '.args.out = "'"$TMP/ran.txt"'"' '.args.out = "'"$TMP/ran.txt"'"'
cp "$C/req.json" "$Q/req-exec.json"; cp "$C/app.json" "$Q/app-exec.json"
run_tool execute --request "$Q/req-exec.json" --approval "$Q/app-exec.json"
expect "execute runs the fixed script" 0 executed ok
[ -f "$TMP/ran.txt" ] && grep -q -- '--queue=default' "$TMP/ran.txt" \
  && ok "script received the validated args" \
  || bad "script did not receive validated args" "$(cat "$TMP/ran.txt" 2>/dev/null)"
[ -f "$P/req-exec.receipt.json" ] \
  && jq -e '.outcome=="executed" and .rollback=="re-run the worker with the previous queue snapshot"' \
      -- "$P/req-exec.receipt.json" >/dev/null \
  && ok "receipt records outcome + rollback" \
  || bad "receipt missing or wrong" "$(cat "$P/req-exec.receipt.json" 2>/dev/null)"
[ -f "$LOG" ] && grep -q 'req-exec' "$LOG" && ok "one log line appended" \
  || bad "execution log missing the run"

section "1b. untrusted command field is ignored, never run"
E="$TMP/c1b"; mkdir -p "$E"
mk_pair "$E" "req-cmd" "restart-queue-worker" \
  '.command = "/bin/sh /tmp/evil.sh" | .args.out = "'"$TMP/ran2.txt"'"' \
  '.args.out = "'"$TMP/ran2.txt"'"'
# rehash AFTER adding .command would hide tampering; mk_pair hashes before
# extra fields, so recompute here the way a real requester would: the hash
# covers only {request_id,card_id,action,args}, and .command is outside it.
cp "$E/req.json" "$Q/req-cmd.json"; cp "$E/app.json" "$Q/app-cmd.json"
run_tool execute --request "$Q/req-cmd.json" --approval "$Q/app-cmd.json"
expect "request carrying command= still executes the allowlisted script" 0 executed ok
[ ! -e "$TMP/EVIL_RAN" ] && ok "attacker binary never ran" \
  || bad "attacker binary RAN — shell passthrough"
jq -e '.ignored_untrusted_command == true' -- "$P/req-cmd.receipt.json" >/dev/null \
  && ok "receipt marks the ignored command" \
  || bad "receipt does not mark ignored command"

# ===========================================================================
section "2. approval re-verification refuses"
t2() { # $1=label $2=req-jq $3=app-jq $4=want_reason [$5=request-id]
  local label="$1" rj="$2" aj="$3" wr="$4" rid="${5:-req-t2}"
  local d="$TMP/t2-$RANDOM"; mkdir -p "$d"; mk_pair "$d" "$rid" "restart-queue-worker" "$rj" "$aj"
  cp "$d/req.json" "$Q/$rid.json"; cp "$d/app.json" "$Q/$rid.app.json"
  run_tool execute --request "$Q/$rid.json" --approval "$Q/$rid.app.json"
  expect "$label" 3 refused "$wr"
  rm -f "$Q/$rid.json" "$Q/$rid.app.json"
}
t2 "forged approver refuses" "" '.approver = "mallory"' approver_not_authorized req-t2a
t2 "declined decision refuses" "" '.decision = "declined"' approval_not_approved req-t2b
t2 "expired approval refuses" "" '.expires_at = "2026-10-05T18:45:00Z"' approval_expired req-t2c
t2 "expired request refuses" '.expires_at = "2026-10-05T18:45:00Z"' "" request_expired req-t2d
t2 "wrong action in approval refuses" "" '.action = "always-fails"' approval_mismatch_action req-t2e
t2 "wrong card in approval refuses" "" '.card_id = "card-9"' approval_mismatch_card_id req-t2f
t2 "forged hash in approval refuses" "" '.request_hash = "sha256:deadbeef"' approval_mismatch_request_hash req-t2g
t2 "future-dated approval refuses" "" '.approved_at = "2026-10-05T21:00:00Z"' approval_from_future req-t2h
t2 "superseded flag refuses" "" '.superseded = true' approval_superseded req-t2i
t2 "declined+approved confusion refuses" "" '.decision = "APPROVED"' approval_not_approved req-t2j

# tampered request: args edited AFTER hashing (hash now stale).
d="$TMP/t2k"; mkdir -p "$d"; mk_pair "$d" "req-tamper" "restart-queue-worker"
jq '.args.queue = "other"' -- "$d/req.json" > "$d/req.json.tmp" && mv "$d/req.json.tmp" "$d/req.json"
cp "$d/req.json" "$Q/req-tamper.json"; cp "$d/app.json" "$Q/req-tamper.app.json"
run_tool execute --request "$Q/req-tamper.json" --approval "$Q/req-tamper.app.json"
expect "tampered request refuses (stale hash)" 3 refused request_tampered

# tampered args shape: approval args differ.
d="$TMP/t2l"; mkdir -p "$d"; mk_pair "$d" "req-argm" "restart-queue-worker"
jq '.args.queue = "other"' -- "$d/app.json" > "$d/app.json.tmp" && mv "$d/app.json.tmp" "$d/app.json"
cp "$d/req.json" "$Q/req-argm.json"; cp "$d/app.json" "$Q/req-argm.app.json"
run_tool execute --request "$Q/req-argm.json" --approval "$Q/req-argm.app.json"
expect "approval args mismatch refuses" 3 refused approval_args_mismatch

# supersede marker file on disk.
d="$TMP/t2m"; mkdir -p "$d"; mk_pair "$d" "req-supm" "restart-queue-worker"
cp "$d/req.json" "$Q/req-supm.json"; cp "$d/app.json" "$Q/req-supm.app.json"
: > "$P/req-supm.superseded"
run_tool execute --request "$Q/req-supm.json" --approval "$Q/req-supm.app.json"
expect "supersede marker refuses" 3 refused approval_superseded
rm -f "$P/req-supm.superseded"

# missing + malformed evidence.
run_tool execute --request "$Q/no-such-req.json" --approval "$Q/no-such.app.json"
expect "missing request refuses as unavailable" 3 refused request_unavailable
d="$TMP/t2n"; mkdir -p "$d"; mk_pair "$d" "req-mal" "restart-queue-worker"
cp "$d/req.json" "$Q/req-mal.json"; printf '{not json' > "$Q/req-mal.app.json"
run_tool execute --request "$Q/req-mal.json" --approval "$Q/req-mal.app.json"
expect "malformed approval refuses" 3 refused approval_unreadable

# ===========================================================================
section "3. allowlist boundary"
t3() { # $1=label $2=action $3=args-json $4=want_reason
  local label="$1" action="$2" args="$3" wr="$4" rid="req-t3-$RANDOM"
  local d="$TMP/$rid"; mkdir -p "$d"
  jq -n --arg r "$rid" --arg a "$action" --argjson ag "$args" \
    '{request_id:$r,card_id:"card-1",action:$a,args:$ag,
      request_hash:"",created_at:"2026-10-05T18:00:00Z",expires_at:"2026-10-05T20:00:00Z"}' > "$d/req.json"
  local hash
  hash="sha256:$(jq -S -c '{request_id,card_id,action,args}' -- "$d/req.json" | sha256sum | cut -d' ' -f1)"
  jq --arg h "$hash" '.request_hash = $h' -- "$d/req.json" > "$d/req.json.tmp" && mv "$d/req.json.tmp" "$d/req.json"
  jq --arg h "$hash" --arg r "$rid" --arg a "$action" --argjson ag "$args" -n \
    '{request_id:$r,card_id:"card-1",action:$a,args:$ag,request_hash:$h,approver:"ceo",
      decision:"approved",approved_at:"2026-10-05T18:30:00Z",expires_at:"2026-10-05T20:00:00Z"}' > "$d/app.json"
  cp "$d/req.json" "$Q/$rid.json"; cp "$d/app.json" "$Q/$rid.app.json"
  run_tool execute --request "$Q/$rid.json" --approval "$Q/$rid.app.json"
  expect "$label" 3 refused "$wr"
  rm -f "$Q/$rid.json" "$Q/$rid.app.json"
}
t3 "unknown action refuses" "do-anything" '{"queue":"default"}' action_not_allowlisted
t3 "shell metachars in action refuse" 'restart-queue-worker; touch x' '{"queue":"default"}' action_not_allowlisted
t3 "path as action refuses" '/bin/sh' '{"queue":"default"}' action_not_allowlisted
t3 "unlisted arg refuses" "restart-queue-worker" '{"queue":"default","extra":"x"}' arg_not_allowlisted
t3 "secret-shaped arg refuses" "restart-queue-worker" '{"queue":"default","api_token":"abc"}' secret_arg_rejected
t3 "pattern-breaking arg refuses" "restart-queue-worker" '{"queue":"$(touch evil)"}' arg_pattern_mismatch
t3 "non-string arg refuses" "restart-queue-worker" '{"queue":{"nested":"obj"}}' arg_not_string
t3 "human-only action refuses" "human-action" '{}' human_only_action
t3 "spend action refuses" "spend-action" '{}' spend_action

# missing required arg: queue is required for restart-queue-worker.
d="$TMP/t3r"; mkdir -p "$d"
jq -n '{request_id:"req-noreq",card_id:"card-1",action:"restart-queue-worker",args:{},
  request_hash:"",created_at:"2026-10-05T18:00:00Z",expires_at:"2026-10-05T20:00:00Z"}' > "$d/req.json"
hash="sha256:$(jq -S -c '{request_id,card_id,action,args}' -- "$d/req.json" | sha256sum | cut -d' ' -f1)"
jq --arg h "$hash" '.request_hash = $h' -- "$d/req.json" > "$d/req.json.tmp" && mv "$d/req.json.tmp" "$d/req.json"
jq --arg h "$hash" -n '{request_id:"req-noreq",card_id:"card-1",action:"restart-queue-worker",args:{},
  request_hash:$h,approver:"ceo",decision:"approved",
  approved_at:"2026-10-05T18:30:00Z",expires_at:"2026-10-05T20:00:00Z"}' > "$d/app.json"
cp "$d/req.json" "$Q/req-noreq.json"; cp "$d/app.json" "$Q/req-noreq.app.json"
run_tool execute --request "$Q/req-noreq.json" --approval "$Q/req-noreq.app.json"
expect "missing required arg refuses" 3 refused required_arg_missing

# ===========================================================================
section "4. replay, concurrency, no-retry"
run_tool execute --request "$Q/req-exec.json" --approval "$Q/app-exec.json"
expect "second execute is a replay" 6 refused replay_detected

d="$TMP/t4b"; mkdir -p "$d"; mk_pair "$d" "req-busy" "restart-queue-worker"
cp "$d/req.json" "$Q/req-busy.json"; cp "$d/app.json" "$Q/req-busy.app.json"
mkdir -p "$P/req-busy.claim"
run_tool execute --request "$Q/req-busy.json" --approval "$Q/req-busy.app.json"
expect "pre-claimed id is busy" 6 refused concurrent_claim
rmdir "$P/req-busy.claim"

d="$TMP/t4c"; mkdir -p "$d"; mk_pair "$d" "req-fail" "always-fails"
cp "$d/req.json" "$Q/req-fail.json"; cp "$d/app.json" "$Q/req-fail.app.json"
run_tool execute --request "$Q/req-fail.json" --approval "$Q/req-fail.app.json"
expect "failing script records, does not retry" 7 failed script_failed
jq -e '.outcome=="failed" and .reason_code=="script_failed"' -- "$P/req-fail.receipt.json" >/dev/null \
  && ok "failure receipt recorded" || bad "failure receipt missing"
run_tool execute --request "$Q/req-fail.json" --approval "$Q/req-fail.app.json"
expect "failed id replays instead of retrying" 6 refused replay_detected

# ===========================================================================
section "5. filesystem boundary"
OUTSIDE="$TMP/outside.json"; echo '{}' > "$OUTSIDE"
run_tool execute --request "$OUTSIDE" --approval "$Q/app-exec.json"
expect "request outside queue refuses" 5 refused request_outside_queue

ln -sf "$OUTSIDE" "$Q/link.json"
run_tool execute --request "$Q/link.json" --approval "$Q/app-exec.json"
expect "symlink escape refuses" 5 refused request_outside_queue
rm -f "$Q/link.json"

# script outside the scripts dir: point the allowlist at /tmp directly.
BAD_ALLOW="$TMP/allowlist-bad.json"
jq --arg s "$S/evil.sh" '.actions["restart-queue-worker"].script = "/bin/echo"' -- "$ALLOW" > "$BAD_ALLOW"
# Fresh id: req-exec already has a receipt and would replay-refuse instead.
d="$TMP/t5b"; mkdir -p "$d"; mk_pair "$d" "req-escape" "restart-queue-worker"
cp "$d/req.json" "$Q/req-escape.json"; cp "$d/app.json" "$Q/req-escape.app.json"
OP_EXEC_ALLOWLIST="$BAD_ALLOW" run_tool execute --request "$Q/req-escape.json" --approval "$Q/req-escape.app.json"
expect "script outside scripts dir refuses" 5 refused script_outside_scripts_dir

# group-writable script refuses even with ownership checks relaxed.
cp "$S/worker.sh" "$S/loose.sh"; chmod 775 "$S/loose.sh"
jq --arg s "$S/loose.sh" '.actions["restart-queue-worker"].script = $s' -- "$ALLOW" > "$BAD_ALLOW"
d="$TMP/t5c"; mkdir -p "$d"; mk_pair "$d" "req-loose" "restart-queue-worker"
cp "$d/req.json" "$Q/req-loose.json"; cp "$d/app.json" "$Q/req-loose.app.json"
OP_EXEC_ALLOWLIST="$BAD_ALLOW" run_tool execute --request "$Q/req-loose.json" --approval "$Q/req-loose.app.json"
expect "group-writable script refuses" 5 refused script_ownership

# non-root-owned allowlist refuses under production ownership rules.
# The fixture allowlist is user-owned, so this must refuse on ownership even
# though every other check would pass.
d="$TMP/t5d"; mkdir -p "$d"; mk_pair "$d" "req-own" "restart-queue-worker"
cp "$d/req.json" "$Q/req-own.json"; cp "$d/app.json" "$Q/req-own.app.json"
OP_EXEC_REQUIRE_ROOT_OWNERSHIP=1 run_tool execute --request "$Q/req-own.json" --approval "$Q/req-own.app.json"
expect "user-owned allowlist refuses when root ownership required" 5 refused allowlist_ownership

# ===========================================================================
section "6. SHADOW preserved"
: > "$SHADOW"
d="$TMP/t6"; mkdir -p "$d"; mk_pair "$d" "req-shadow" "restart-queue-worker"
cp "$d/req.json" "$Q/req-shadow.json"; cp "$d/app.json" "$Q/req-shadow.app.json"
BEFORE_MARKER="$TMP/ran-shadow.txt"; rm -f "$BEFORE_MARKER"
run_tool execute --request "$Q/req-shadow.json" --approval "$Q/req-shadow.app.json"
expect "execute under SHADOW refuses" 4 refused shadow_present
[ ! -e "$P/req-shadow.receipt.json" ] && ok "SHADOW run writes no receipt" \
  || bad "SHADOW run wrote a receipt"
run_tool verify-only --request "$Q/req-shadow.json" --approval "$Q/req-shadow.app.json"
if [[ "$RC" == "0" && "$(jq -r '.shadow' <<<"$OUT")" == "present" ]]; then
  ok "verify-only still verifies under SHADOW (shadow=present)"
else
  bad "verify-only under SHADOW" "$OUT"
fi
rm -f "$SHADOW"

# ===========================================================================
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" == "0" ]]
