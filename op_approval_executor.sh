#!/usr/bin/env bash
# ===========================================================================
# op_approval_executor.sh — approval-queue executor (source-only; SHADOW kept)
#
# WHAT THIS IS. The missing Part B step 3 of the operator-safety native flow:
# it turns an APPROVED queue request into exactly one bounded execution of a
# fixed root-owned runbook script. It is the ONLY path from "CEO approved on
# the request card" to "a root command ran". There is no shell passthrough,
# no arbitrary command, no eval, and no caller-selected executable anywhere
# in this file — grep for `eval`, `bash -c`, `$($`, and backticks returns
# nothing but this paragraph.
#
# WHAT THIS IS NOT. Not an installer, not a migration, not a credential
# minter, not a network client. It reads local JSON files, checks them, and
# execs one allowlisted script. It never reads ~/secure-drop, never mints or
# grants anything, and never places a secret in env or argv (see CUSTODY).
#
# SHADOW. If the shadow marker exists (default /etc/paperclip-operator/SHADOW,
# override OP_EXEC_SHADOW_FILE), `execute` REFUSES with exit 4 and runs
# nothing. `verify-only` still checks everything else and reports
# shadow=present, so a pre-flight can distinguish "would run" from "shadow
# blocks" without executing. Deleting or honouring the marker is host-operator
# work outside this file.
#
# LAYOUT (production paths; every one overridable by OP_EXEC_* env for tests
# and for private host maps, which stay private and are NOT in this repo):
#   OP_EXEC_ALLOWLIST      /etc/paperclip-operator/allowlist.json
#   OP_EXEC_APPROVERS      /etc/paperclip-operator/approvers.txt
#   OP_EXEC_QUEUE_DIR      /var/lib/paperclip-operator/queue      (drop dir)
#   OP_EXEC_PROCESSED_DIR  /var/lib/paperclip-operator/processed  (root-only)
#   OP_EXEC_SCRIPTS_DIR    /usr/local/lib/paperclip-operator/runbooks
#   OP_EXEC_SHADOW_FILE    /etc/paperclip-operator/SHADOW
#   OP_EXEC_LOG            /var/lib/paperclip-operator/execution.log (JSONL)
#   OP_EXEC_REQUIRE_ROOT_OWNERSHIP=1  (tests set 0; production stays 1)
#
# REQUEST FILE (JSON, lives under QUEUE_DIR):
#   {request_id, card_id, action, args, request_hash, created_at, expires_at,
#    human_only?, command?}
# request_hash = "sha256:" + hex(sha256(canonical action binding)) where the
# canonical binding is: jq -S -c '{request_id,card_id,action,args}'.
# `command`, when present, is UNTRUSTED DATA: it is never executed, never
# expanded, never passed on. A receipt records ignored_command=true when it
# was present so the attempt is visible.
#
# APPROVAL FILE (JSON, lives under QUEUE_DIR, copied from the board):
#   {request_id, card_id, action, args, request_hash, approver, decision,
#    approved_at, expires_at, superseded?}
# Execution requires ALL of: decision == "approved"; approver listed in
# OP_EXEC_APPROVERS; request_hash equals the request file's AND the
# recomputed binding; action/args/card_id byte-identical to the request;
# approved_at <= now < min(request.expires_at, approval.expires_at);
# superseded != true and no processed/<id>.superseded marker file.
# human_only or spend requests are ALWAYS refused (exit 3): a human approval
# cannot delegate humanness through this executor, and spend needs a human
# path that does not exist here yet. The refusal names human_only/spend.
#
# ALLOWLIST FILE (JSON, root-owned):
#   {"version":1,"actions":{"<action-id>":{
#      "script":"<abs path under SCRIPTS_DIR>",
#      "args":{"<name>":{"pattern":"^(...)$","max_len":64}},  # flat strings
#      "rollback":"human-readable undo line",
#      "timeout_secs":60, "human_only":false, "spend":false}}}
# Action ids match ^[a-z0-9][a-z0-9_-]{1,63}$. Anything else — including
# "reboot; rm -rf /", "/bin/sh", paths, spaces — is not in the map and
# refuses. Argument names match ^[a-z][a-z0-9_]{0,31}$ and MUST be listed
# for the action; names containing token/secret/password/api_key/private_key
# are refused outright (secrets never flow through argv). Values are strings,
# max_len bounded (default 256), and must match the per-arg pattern (default
# ^[A-Za-z0-9_./:@+-]+$). No objects, arrays, numbers, or booleans.
#
# CLAIM / REPLAY. processed/<id>.claim/ (mkdir, atomic) guards concurrency;
# processed/<id>.receipt.json marks done. <id> is the request_id gated to
# ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$ before any path is built, so no request
# can walk out of the processed dir. A second execute with the same id
# exits 6 having run nothing. Uncertain side effects are never retried: a
# failing or timing-out script records its receipt and exits 7, and the
# operator re-runs by hand after reading the rollback line.
#
# CUSTODY. The board-only key, if one is ever provisioned, lives root-only
# BEHIND this executor and is never exported to agent env or argv. This file
# takes no credential on argv, reads no credential file, and exports no
# credential variable. Logged args scrub secret-shaped values to [redacted].
#
# MACHINE OUTPUT. stdout carries exactly one JSON result object per run
# (outcome, reason_code, request_id, action, receipt, shadow, ...). Tests
# assert on exit codes and these fields, never on stderr prose. stderr is
# human text and may change.
#
# EXIT CODES (pinned by test_op_approval_executor.sh):
#   0  executed (or verify-only passed)
#   2  usage / malformed invocation and config (bad flags, bad allowlist)
#   3  evidence/approval refusal (missing, forged, declined, expired,
#      superseded, mismatch, tamper, human_only/spend, secret-shaped arg)
#   4  SHADOW refusal (execute only; nothing ran)
#   5  filesystem boundary / ownership refusal (escape, symlink, perms)
#   6  replay / concurrent claim (nothing ran)
#   7  transport-of-execution failure (script missing at run time, failed,
#      timed out; receipt recorded, no retry)
#   1  I/O failure (could not write claim, receipt, or log)
# ===========================================================================
set -uo pipefail

PROG="${0##*/}"

# ---- configuration (env-overridable; production defaults) -------------------
ALLOWLIST="${OP_EXEC_ALLOWLIST:-/etc/paperclip-operator/allowlist.json}"
APPROVERS_FILE="${OP_EXEC_APPROVERS:-/etc/paperclip-operator/approvers.txt}"
QUEUE_DIR="${OP_EXEC_QUEUE_DIR:-/var/lib/paperclip-operator/queue}"
PROCESSED_DIR="${OP_EXEC_PROCESSED_DIR:-/var/lib/paperclip-operator/processed}"
SCRIPTS_DIR="${OP_EXEC_SCRIPTS_DIR:-/usr/local/lib/paperclip-operator/runbooks}"
SHADOW_FILE="${OP_EXEC_SHADOW_FILE:-/etc/paperclip-operator/SHADOW}"
EXEC_LOG="${OP_EXEC_LOG:-/var/lib/paperclip-operator/execution.log}"
REQUIRE_ROOT_OWNERSHIP="${OP_EXEC_REQUIRE_ROOT_OWNERSHIP:-1}"
NOW_OVERRIDE="${OP_EXEC_NOW:-}"

command -v jq >/dev/null || { echo "$PROG: jq required" >&2; exit 2; }

log_human() { printf '%s\n' "$*" >&2; }

emit_result() { # $1 = json object (already built)
  printf '%s\n' "$1"
}

now_epoch() {
  if [[ -n "$NOW_OVERRIDE" ]]; then date -u -d "$NOW_OVERRIDE" +%s;
  else date -u +%s; fi
}

iso_now() {
  if [[ -n "$NOW_OVERRIDE" ]]; then date -u -d "$NOW_OVERRIDE" +%Y-%m-%dT%H:%M:%SZ;
  else date -u +%Y-%m-%dT%H:%M:%SZ; fi
}

to_epoch() { # $1 = ISO-8601Z; prints epoch or FAIL
  date -u -d "$1" +%s 2>/dev/null || echo "FAIL"
}

# ---- path boundary ----------------------------------------------------------
# realpath_inside BASE CANDIDATE: prints canonical path iff it stays inside.
within_dir() { # $1=base $2=candidate -> canonical path on stdout, rc 0/1
  local base="$1" cand="$2" real
  real="$(realpath -m -- "$cand" 2>/dev/null)" || return 1
  [[ "$real" == "$base" || "$real" == "$base"/* ]] || return 1
  printf '%s' "$real"
}

# Resolve symlinks too (no -m): the file must REALLY live inside.
within_dir_strict() { # $1=base $2=candidate
  local base="$1" cand="$2" real br
  [[ -e "$cand" ]] || return 1
  real="$(realpath -- "$cand" 2>/dev/null)" || return 1
  br="$(realpath -- "$base" 2>/dev/null)" || return 1
  [[ "$real" == "$br" || "$real" == "$br"/* ]] || return 1
  printf '%s' "$real"
}

# ---- ownership ---------------------------------------------------------------
# Root-owned, regular file, not writable by group/other.
check_root_owned_file() { # $1=file $2=label -> rc 0 ok
  local f="$1" label="$2" uid mode
  [[ -f "$f" && ! -L "$f" ]] || { log_human "$label: not a regular file: $f"; return 1; }
  if [[ "$REQUIRE_ROOT_OWNERSHIP" == "1" ]]; then
    uid="$(stat -c %u -- "$f")" || return 1
    [[ "$uid" == "0" ]] || { log_human "$label: must be root-owned (uid=$uid): $f"; return 1; }
  fi
  mode="$(stat -c %a -- "$f")" || return 1
  # group/other write bits: mode is octal string like 644; check numerically.
  if (( (8#$mode & 8#022) != 0 )); then
    log_human "$label: must not be group/other-writable (mode=$mode): $f"
    return 1
  fi
  return 0
}

check_root_owned_exec() { # $1=file: root-owned file + owner-executable
  check_root_owned_file "$1" "script" || return 1
  [[ -x "$1" ]] || { log_human "script: not executable: $1"; return 1; }
  return 0
}

# ---- canonical binding hash ---------------------------------------------------
binding_hash() { # $1=request file -> "sha256:..." on stdout
  # Hashes jq's exact stdout bytes (canonical line PLUS its trailing
  # newline). Hash writers must do the same: `jq -S -c '...' | sha256sum`,
  # never hash a command-substituted string, which strips the newline.
  local f="$1" h
  h="$(jq -S -c '{request_id,card_id,action,args}' -- "$f" 2>/dev/null | sha256sum | cut -d' ' -f1)" || return 1
  [[ -n "$h" ]] || return 1
  printf 'sha256:%s' "$h"
}

# ---- log scrub ----------------------------------------------------------------
# Secrets never flow through args (secret-shaped NAMES are refused), but free
# text may still carry a pasted token: scrub values, never the structure.
scrub_value() { # $1=string -> scrubbed string
  printf '%s' "$1" | sed -E 's/((token|secret|password|api[_-]?key|private[_-]?key)[^A-Za-z0-9]{0,5}[=:][[:space:]]*)[^[:space:],}"]+/\1[redacted]/gI'
}

# ===========================================================================
usage() {
  cat >&2 <<'EOF'
usage:
  op_approval_executor.sh execute --request <file> --approval <file>
  op_approval_executor.sh verify-only --request <file> --approval <file>
env overrides: OP_EXEC_ALLOWLIST OP_EXEC_APPROVERS OP_EXEC_QUEUE_DIR
  OP_EXEC_PROCESSED_DIR OP_EXEC_SCRIPTS_DIR OP_EXEC_SHADOW_FILE OP_EXEC_LOG
  OP_EXEC_REQUIRE_ROOT_OWNERSHIP OP_EXEC_NOW
EOF
}

MODE=""; REQUEST_FILE=""; APPROVAL_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    execute|verify-only) MODE="$1"; shift ;;
    --request) REQUEST_FILE="${2:-}"; shift 2 ;;
    --approval) APPROVAL_FILE="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) log_human "unknown argument: $1"; usage; exit 2 ;;
  esac
done
[[ -n "$MODE" && -n "$REQUEST_FILE" && -n "$APPROVAL_FILE" ]] || { usage; exit 2; }

# ---- step 0: files exist and stay inside the queue dir ------------------------
# Missing evidence is an evidence refusal (3); escaping the dir is a
# boundary refusal (5). The two must not share a code: one means "the board
# gave us nothing", the other means "someone aimed us outside the jail".
if [[ ! -e "$REQUEST_FILE" ]]; then
  emit_result "$(jq -n --arg r "unknown" '{outcome:"refused",reason_code:"request_unavailable",request_id:$r,action:"",receipt:"",shadow:"unknown"}')"
  log_human "request file missing"
  exit 3
fi
if [[ ! -e "$APPROVAL_FILE" ]]; then
  emit_result "$(jq -n --arg r "unknown" '{outcome:"refused",reason_code:"approval_unavailable",request_id:$r,action:"",receipt:"",shadow:"unknown"}')"
  log_human "approval file missing"
  exit 3
fi
REQ_REAL=""; APP_REAL=""
REQ_REAL="$(within_dir_strict "$QUEUE_DIR" "$REQUEST_FILE")" \
  || { emit_result "$(jq -n --arg r "none" '{outcome:"refused",reason_code:"request_outside_queue",request_id:$r,action:"",receipt:"",shadow:"unknown"}')"; log_human "request file escapes queue dir or is missing"; exit 5; }
APP_REAL="$(within_dir_strict "$QUEUE_DIR" "$APPROVAL_FILE")" \
  || { emit_result "$(jq -n --arg r "none" '{outcome:"refused",reason_code:"approval_outside_queue",request_id:$r,action:"",receipt:"",shadow:"unknown"}')"; log_human "approval file escapes queue dir or is missing"; exit 5; }

REQ_ID="$(jq -r '.request_id // empty' -- "$REQ_REAL" 2>/dev/null)" || REQ_ID=""
[[ -n "$REQ_ID" ]] || REQ_ID="unknown"
ACTION="$(jq -r '.action // empty' -- "$REQ_REAL" 2>/dev/null)" || ACTION=""

result() { # $1=outcome $2=reason $3=receipt $4=shadow
  jq -n --arg o "$1" --arg r "$2" --arg i "$REQ_ID" --arg a "$ACTION" \
        --arg rcpt "$3" --arg sh "$4" \
    '{outcome:$o,reason_code:$r,request_id:$i,action:$a,receipt:$rcpt,shadow:$sh}'
}

# ---- step 1: evidence parses ----------------------------------------------------
jq -e . -- "$REQ_REAL" >/dev/null 2>&1 \
  || { emit_result "$(result refused request_unreadable "" unknown)"; log_human "request file unreadable"; exit 3; }
jq -e . -- "$APP_REAL" >/dev/null 2>&1 \
  || { emit_result "$(result refused approval_unreadable "" unknown)"; log_human "approval file unreadable"; exit 3; }

for field in request_id card_id action request_hash created_at expires_at; do
  jq -e --arg f "$field" '.[$f] | strings | length > 0' -- "$REQ_REAL" >/dev/null 2>&1 \
    || { emit_result "$(result refused "request_missing_$field" "" unknown)"; log_human "request missing $field"; exit 3; }
done
jq -e '.args | objects' -- "$REQ_REAL" >/dev/null 2>&1 \
  || { emit_result "$(result refused request_args_not_object "" unknown)"; log_human "request args must be an object"; exit 3; }
for field in request_id card_id action request_hash approver decision approved_at expires_at; do
  jq -e --arg f "$field" '.[$f] | strings | length > 0' -- "$APP_REAL" >/dev/null 2>&1 \
    || { emit_result "$(result refused "approval_missing_$field" "" unknown)"; log_human "approval missing $field"; exit 3; }
done
jq -e '.args | objects' -- "$APP_REAL" >/dev/null 2>&1 \
  || { emit_result "$(result refused approval_args_not_object "" unknown)"; log_human "approval args must be an object"; exit 3; }

REQ_ID="$(jq -r '.request_id' -- "$REQ_REAL")"
ACTION="$(jq -r '.action' -- "$REQ_REAL")"
CARD="$(jq -r '.card_id' -- "$REQ_REAL")"

# request_id becomes a FILENAME under the processed dir (receipt, claim,
# supersede marker). Without a charset gate, `../escape` walks out of the
# jail — proven live in review. Gate it here, before any path is built.
if ! [[ "$REQ_ID" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$ ]]; then
  emit_result "$(result refused request_id_rejected "" unknown)"
  log_human "request_id charset rejected"
  exit 3
fi

# ---- step 2: config loads ---------------------------------------------------------
[[ -f "$ALLOWLIST" ]] || { emit_result "$(result refused allowlist_unavailable "" unknown)"; log_human "allowlist unavailable"; exit 2; }
jq -e '.version == 1 and (.actions | objects)' -- "$ALLOWLIST" >/dev/null 2>&1 \
  || { emit_result "$(result refused allowlist_malformed "" unknown)"; log_human "allowlist malformed"; exit 2; }
[[ -f "$APPROVERS_FILE" ]] || { emit_result "$(result refused approvers_unavailable "" unknown)"; log_human "approvers file unavailable"; exit 2; }

# ---- step 3: action resolves ONLY through the allowlist ------------------------------
# No shell characters can survive this: ids outside the map refuse, and the
# map yields a fixed script path, never a command line.
if ! [[ "$ACTION" =~ ^[a-z0-9][a-z0-9_-]{1,63}$ ]]; then
  emit_result "$(result refused action_not_allowlisted "" unknown)"
  log_human "action id not allowlisted"
  exit 3
fi
ENTRY="$(jq -c --arg a "$ACTION" '.actions[$a] // empty' -- "$ALLOWLIST")"
[[ -n "$ENTRY" && "$ENTRY" != '""' ]] \
  || { emit_result "$(result refused action_not_allowlisted "" unknown)"; log_human "action id not allowlisted"; exit 3; }

SCRIPT_REL="$(jq -r '.script // empty' <<<"$ENTRY")"
ROLLBACK="$(jq -r '.rollback // "no rollback recorded"' <<<"$ENTRY")"
TIMEOUT_SECS="$(jq -r '.timeout_secs // 60' <<<"$ENTRY")"
HUMAN_ONLY="$(jq -r '.human_only // false' <<<"$ENTRY")"
SPEND="$(jq -r '.spend // false' <<<"$ENTRY")"
[[ "$TIMEOUT_SECS" =~ ^[0-9]+$ ]] || TIMEOUT_SECS=60
(( TIMEOUT_SECS >= 5 && TIMEOUT_SECS <= 600 )) || TIMEOUT_SECS=60

# human-only and spend never execute here, whatever the approval says.
if [[ "$HUMAN_ONLY" == "true" ]]; then
  emit_result "$(result refused human_only_action "" unknown)"
  log_human "human-only action refuses: agent must not impersonate a human"
  exit 3
fi
if [[ "$SPEND" == "true" ]]; then
  emit_result "$(result refused spend_action "" unknown)"
  log_human "spend action refuses: needs a human path that does not exist here"
  exit 3
fi
REQ_HUMAN="$(jq -r '.human_only // false' -- "$REQ_REAL")"
if [[ "$REQ_HUMAN" == "true" ]]; then
  emit_result "$(result refused human_only_request "" unknown)"
  log_human "request marked human-only refuses"
  exit 3
fi

# ---- step 4: script path is fixed, inside the scripts dir, root-owned ------------------
# Config trust before script trust: a compromised allowlist redefines every
# script, so its ownership is checked first.
check_root_owned_file "$ALLOWLIST" "allowlist" \
  || { emit_result "$(result refused allowlist_ownership "" unknown)"; exit 5; }
# The approvers file decides WHOSE approval counts. A writable approvers
# file is a writable authorization decision, so it gets the same check.
check_root_owned_file "$APPROVERS_FILE" "approvers" \
  || { emit_result "$(result refused approvers_ownership "" unknown)"; exit 5; }
SCRIPT_REAL="$(within_dir_strict "$SCRIPTS_DIR" "$SCRIPT_REL")" \
  || { emit_result "$(result refused script_outside_scripts_dir "" unknown)"; log_human "script escapes scripts dir or is missing"; exit 5; }
# The allowlist must NAME the canonical location: no aliasing around the dir.
CANON="$(jq -r --arg a "$ACTION" '.actions[$a].script' -- "$ALLOWLIST")"
[[ "$CANON" == "$SCRIPT_REAL" ]] \
  || { emit_result "$(result refused script_not_canonical "" unknown)"; log_human "allowlist script is not canonical"; exit 5; }
check_root_owned_exec "$SCRIPT_REAL" \
  || { emit_result "$(result refused script_ownership "" unknown)"; exit 5; }

# ---- step 5: arguments validate against the per-action schema -------------------------
# Every name listed, every value a short string matching its pattern.
# Secret-shaped names refuse: credentials never travel in argv.
ALLOW_ARG_SPEC="$(jq -c '.args // {}' <<<"$ENTRY")"
mapfile -t ARG_NAMES < <(jq -r '.args // {} | keys[]' -- "$REQ_REAL")
declare -a EXEC_ARGV=()
for name in "${ARG_NAMES[@]}"; do
  if ! [[ "$name" =~ ^[a-z][a-z0-9_]{0,31}$ ]]; then
    emit_result "$(result refused arg_name_rejected "" unknown)"
    log_human "argument name rejected: $name"
    exit 3
  fi
  if [[ "$name" =~ (token|secret|password|api_key|apikey|private_key|privatekey) ]]; then
    emit_result "$(result refused secret_arg_rejected "" unknown)"
    log_human "secret-shaped argument refused: $name"
    exit 3
  fi
  spec="$(jq -c --arg n "$name" '.[$n] // empty' <<<"$ALLOW_ARG_SPEC")"
  [[ -n "$spec" ]] \
    || { emit_result "$(result refused arg_not_allowlisted "" unknown)"; log_human "argument not allowlisted: $name"; exit 3; }
  val="$(jq -r --arg n "$name" '.args[$n]' -- "$REQ_REAL")"
  vtype="$(jq -r --arg n "$name" '.args[$n] | type' -- "$REQ_REAL")"
  [[ "$vtype" == "string" ]] \
    || { emit_result "$(result refused arg_not_string "" unknown)"; log_human "argument not a string: $name"; exit 3; }
  pattern="$(jq -r '.pattern // "^[A-Za-z0-9_./:@+-]+$"' <<<"$spec")"
  max_len="$(jq -r '.max_len // 256' <<<"$spec")"
  [[ "$max_len" =~ ^[0-9]+$ ]] || max_len=256
  (( ${#val} <= max_len )) \
    || { emit_result "$(result refused arg_too_long "" unknown)"; log_human "argument too long: $name"; exit 3; }
  [[ "$val" =~ $pattern ]] \
    || { emit_result "$(result refused arg_pattern_mismatch "" unknown)"; log_human "argument fails pattern: $name"; exit 3; }
  EXEC_ARGV+=("--${name}=${val}")
done
# Required args present? Every spec entry with "required":true must exist.
mapfile -t REQUIRED_NAMES < <(jq -r '.args // {} | to_entries[] | select(.value.required == true) | .key' <<<"$ENTRY")
for name in "${REQUIRED_NAMES[@]}"; do
  jq -e --arg n "$name" '.args | has($n)' -- "$REQ_REAL" >/dev/null 2>&1 \
    || { emit_result "$(result refused required_arg_missing "" unknown)"; log_human "required argument missing: $name"; exit 3; }
done

# The optional `command` field is untrusted data, never authorization.
IGNORED_COMMAND=false
if jq -e 'has("command")' -- "$REQ_REAL" >/dev/null 2>&1; then
  IGNORED_COMMAND=true
fi

# ---- step 6: approval re-verified ------------------------------------------------------
APPROVER="$(jq -r '.approver' -- "$APP_REAL")"
DECISION="$(jq -r '.decision' -- "$APP_REAL")"
[[ "$DECISION" == "approved" ]] \
  || { emit_result "$(result refused approval_not_approved "" unknown)"; log_human "approval decision is not approved"; exit 3; }
grep -qxF -- "$APPROVER" "$APPROVERS_FILE" 2>/dev/null \
  || { emit_result "$(result refused approver_not_authorized "" unknown)"; log_human "approver not authorized"; exit 3; }

# Integrity first: the live request file must still hash to its stored
# binding (tampering breaks this before any cross-match is meaningful).
COMPUTED="$(binding_hash "$REQ_REAL")" || COMPUTED="uncomputable"
STORED="$(jq -r '.request_hash' -- "$REQ_REAL")"
[[ "$COMPUTED" == "$STORED" ]] \
  || { emit_result "$(result refused request_tampered "" unknown)"; log_human "request hash mismatch: file changed after hashing"; exit 3; }

# Cross-match: approval must describe THIS request byte-for-byte.
for field in request_id card_id action request_hash; do
  r="$(jq -r --arg f "$field" '.[$f]' -- "$REQ_REAL")"
  a="$(jq -r --arg f "$field" '.[$f]' -- "$APP_REAL")"
  [[ "$r" == "$a" ]] \
    || { emit_result "$(result refused "approval_mismatch_$field" "" unknown)"; log_human "approval mismatch: $field"; exit 3; }
done
# --argfile is gone from jq >= 1.7, so compare canonical bytes instead.
if ! cmp -s <(jq -S -c '.args' -- "$REQ_REAL") <(jq -S -c '.args' -- "$APP_REAL"); then
  emit_result "$(result refused approval_args_mismatch "" unknown)"
  log_human "approval args differ from request"
  exit 3
fi

APP_HASH="$(jq -r '.request_hash' -- "$APP_REAL")"
[[ "$APP_HASH" == "$STORED" ]] \
  || { emit_result "$(result refused approval_hash_mismatch "" unknown)"; log_human "approval hash differs from request"; exit 3; }

# Liveness: approved_at <= now < min(request, approval expiry).
NOW="$(now_epoch)"
APPROVED_AT="$(jq -r '.approved_at' -- "$APP_REAL")"
APPROVED_EPOCH="$(to_epoch "$APPROVED_AT")"
REQ_EXP="$(jq -r '.expires_at' -- "$REQ_REAL")"
APP_EXP="$(jq -r '.expires_at' -- "$APP_REAL")"
REQ_EXP_EPOCH="$(to_epoch "$REQ_EXP")"
APP_EXP_EPOCH="$(to_epoch "$APP_EXP")"
[[ "$APPROVED_EPOCH" != "FAIL" && "$REQ_EXP_EPOCH" != "FAIL" && "$APP_EXP_EPOCH" != "FAIL" ]] \
  || { emit_result "$(result refused bad_timestamp "" unknown)"; log_human "unparseable timestamp"; exit 3; }
(( APPROVED_EPOCH <= NOW )) \
  || { emit_result "$(result refused approval_from_future "" unknown)"; log_human "approval predates its own timestamp"; exit 3; }
(( NOW < REQ_EXP_EPOCH )) \
  || { emit_result "$(result refused request_expired "" unknown)"; log_human "request expired"; exit 3; }
(( NOW < APP_EXP_EPOCH )) \
  || { emit_result "$(result refused approval_expired "" unknown)"; log_human "approval expired"; exit 3; }

# Supersede: inline flag or a marker file the board path drops on withdraw.
SUPERSEDED="$(jq -r '.superseded // false' -- "$APP_REAL")"
[[ "$SUPERSEDED" != "true" ]] \
  || { emit_result "$(result refused approval_superseded "" unknown)"; log_human "approval superseded"; exit 3; }

# ---- step 7: replay + claim (atomic; nothing executes before this) -------------------------
RECEIPT="$PROCESSED_DIR/$REQ_ID.receipt.json"
CLAIM="$PROCESSED_DIR/$REQ_ID.claim"
SUPERSEDE_MARKER="$PROCESSED_DIR/$REQ_ID.superseded"
if [[ -e "$SUPERSEDE_MARKER" ]]; then
  emit_result "$(result refused approval_superseded "" unknown)"
  log_human "supersede marker present"
  exit 3
fi
if [[ -e "$RECEIPT" ]]; then
  emit_result "$(result refused replay_detected "$RECEIPT" unknown)"
  log_human "replay: receipt already exists; refusing"
  exit 6
fi

# Shadow state for the result line (both modes report it).
SHADOW_STATE="absent"
[[ -e "$SHADOW_FILE" ]] && SHADOW_STATE="present"

if [[ "$MODE" == "verify-only" ]]; then
  emit_result "$(result verified approval_ok "" "$SHADOW_STATE")"
  log_human "verify-only: approval chain holds; shadow=$SHADOW_STATE; nothing executed"
  exit 0
fi

# execute: SHADOW refuses first, before any claim or side effect.
if [[ -e "$SHADOW_FILE" ]]; then
  emit_result "$(result refused shadow_present "" present)"
  log_human "SHADOW present: report-only mode; refusing execution"
  exit 4
fi

mkdir -- "$PROCESSED_DIR" 2>/dev/null || true
if ! mkdir -- "$CLAIM" 2>/dev/null; then
  emit_result "$(result refused concurrent_claim "" "$SHADOW_STATE")"
  log_human "concurrent claim in progress; refusing"
  exit 6
fi
echo "$$" > "$CLAIM/pid" 2>/dev/null || true

# ---- step 8: run the fixed script, exactly once -------------------------------------------
TS="$(iso_now)"
SCRUBBED_ARGS="$(jq -c '.args | with_entries(.value |= (if type == "string" then . else "\(.)" end))' -- "$REQ_REAL")"
# shellcheck disable=SC2317  (unreachable-code warning is wrong: trap fires)
cleanup_claim() { rmdir -- "$CLAIM" 2>/dev/null || true; }
trap cleanup_claim EXIT

set +e
if command -v timeout >/dev/null 2>&1; then
  timeout -- "$TIMEOUT_SECS" "$SCRIPT_REAL" "${EXEC_ARGV[@]}" >"$CLAIM/stdout.log" 2>"$CLAIM/stderr.log"
  SCRIPT_RC=$?
  [[ $SCRIPT_RC -eq 124 ]] && TIMED_OUT=true || TIMED_OUT=false
else
  "$SCRIPT_REAL" "${EXEC_ARGV[@]}" >"$CLAIM/stdout.log" 2>"$CLAIM/stderr.log"
  SCRIPT_RC=$?
  TIMED_OUT=false
fi
set -e

OUTCOME="executed"; REASON="ok"; EXIT_CODE=0
if [[ "$TIMED_OUT" == "true" ]]; then
  OUTCOME="failed"; REASON="script_timeout"; EXIT_CODE=7
elif (( SCRIPT_RC != 0 )); then
  OUTCOME="failed"; REASON="script_failed"; EXIT_CODE=7
fi

# ---- step 9: one receipt + one log line, secrets scrubbed -----------------------------------
RECEIPT_TMP="$CLAIM/receipt.tmp"
jq -n --arg v 1 --arg ts "$TS" --arg rid "$REQ_ID" --arg card "$CARD" \
      --arg act "$ACTION" --arg args "$SCRUBBED_ARGS" \
      --arg appr "$APPROVER" --arg hash "$STORED" --arg script "$SCRIPT_REAL" \
      --arg out "$OUTCOME" --arg reason "$REASON" --argjson rc "$SCRIPT_RC" \
      --arg rb "$ROLLBACK" --argjson ign "$IGNORED_COMMAND" \
  '{v:($v|tonumber), ts:$ts, request_id:$rid, card_id:$card, action:$act,
    args:$args, approver:$appr, request_hash:$hash, script:$script,
    outcome:$out, reason_code:$reason, script_exit:$rc, rollback:$rb,
    ignored_untrusted_command:$ign}' > "$RECEIPT_TMP"
# Scrub secret-shaped values out of the serialized receipt (defence in depth;
# secret NAMES already refused above, so this covers pasted free text).
SCRUBBED="$(scrub_value "$(cat -- "$RECEIPT_TMP")")"
printf '%s\n' "$SCRUBBED" > "$RECEIPT_TMP"
mv -- "$RECEIPT_TMP" "$RECEIPT" || { emit_result "$(result failed receipt unwritten "$SHADOW_STATE")"; log_human "could not write receipt"; exit 1; }
# Append-only log: best effort — a full disk must not fake success, but the
# receipt is the record; the log is the trail.
{ printf '%s\n' "$SCRUBBED" >> "$EXEC_LOG"; } 2>/dev/null || log_human "warning: execution log append failed"

if [[ "$OUTCOME" == "executed" ]]; then
  emit_result "$(result executed ok "$RECEIPT" "$SHADOW_STATE")"
  log_human "executed $ACTION for $REQ_ID; receipt $RECEIPT; rollback: $ROLLBACK"
  exit 0
else
  emit_result "$(result failed "$REASON" "$RECEIPT" "$SHADOW_STATE")"
  log_human "script $REASON (exit $SCRIPT_RC); receipt $RECEIPT; NOT retried — rollback: $ROLLBACK"
  exit 7
fi
