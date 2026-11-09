#!/usr/bin/env bash
# Adversarial suite for the REQUEST RECORD ITSELF — the thing TOG-198 is about.
#
# Written by the CISO reviewing TOG-194 / TOG-198, and it is deliberately not a
# second copy of test_responsible_leader.sh. That suite asks "who may decide?"
# and answers it well. This one asks the question an audit actually asks:
#
#     six months later, can this record tell you WHAT was approved,
#     WHY it was approved, and that nobody nagged their way to a yes?
#
# Every assertion below is a property the design DOCUMENTS. They are here
# because the documented property and the implemented one are not yet the same
# thing, and each gap was reproduced before it was written down. NO DATABASE,
# NO CREDENTIALS, NO NETWORK — same two seams as the sibling suite:
#
#   ORG_SNAPSHOT  a TSV org fixture read instead of the live database
#   PROV          a stub provisioner
#
# Concurrent success is checked with both child exit statuses and exactly two
# distinct submissions. The allocation-read failure uses FIFO barriers to prove
# lock contention after a durable commit; it does not depend on scheduler luck.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v jq >/dev/null || { echo "ERROR: jq required" >&2; exit 1; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export COMPANY_ID="offline-fixture-not-a-real-company"
export QUEUE="$TMP/queue.jsonl"
export GRANT_LOG="$TMP/grant-log.jsonl"
export DISABLED_TEMPLATES="$TMP/disabled"
export ORG_SNAPSHOT="$TMP/org.tsv"
export PROV="$TMP/stub_provisioner.sh"
CREATE_ARGV="$TMP/create.argv"
Q="$HERE/org_request_queue.sh"

PASS=0; FAIL=0
ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }
note() { printf '        %s\n' "$1"; }

# --- the stub provisioner ---------------------------------------------------
# Same construction as test_responsible_leader.sh, and for the same reason: the
# ceiling is EXTRACTED from org_provisioner.sh, never copied, so a ceiling
# change cannot leave this suite green against a stale fixture.
build_stub() {
  {
    echo '#!/usr/bin/env bash'
    echo 'set -uo pipefail'
    sed -n "/^CEILING_JSON='{/,/^}'\$/p" "$HERE/org_provisioner.sh"
    # EXTRACTED, never copied — same rule as the ceiling above. The risk
    # classifier added in TOG-388 reads this catalog to decide whether an ask is
    # risky, and a stub holding its own copy would keep answering against
    # yesterday's permission keys.
    sed -n "/^TEMPLATES_JSON='{/,/^}'\$/p" "$HERE/org_provisioner.sh"
    cat <<'STUB'
[[ -n "${CEILING_JSON:-}" ]]   || { echo "stub: failed to extract CEILING_JSON" >&2; exit 90; }
[[ -n "${TEMPLATES_JSON:-}" ]] || { echo "stub: failed to extract TEMPLATES_JSON" >&2; exit 90; }
case "${1:-}" in
  ceiling) jq -r 'to_entries[] | "\(.key)\t\(.value|join(", "))"' <<<"$CEILING_JSON" ;;
  template-keys) jq -r 'to_entries[] | "\(.key)\t\(.value|map(.permissionKey)|join(","))"' <<<"$TEMPLATES_JSON" ;;
  create)
    shift
    caller=""; template=""; title=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --caller)   caller="$2";   shift 2;;
        --template) template="$2"; shift 2;;
        --title)    title="$2";    shift 2;;
        *) shift;;
      esac
    done
    printf '%s\t%s\t%s\n' "$caller" "$template" "$title" >> "$CREATE_ARGV"
    echo "PROVISIONED $template -> 00000000-0000-4000-8000-000000000009"
    ;;
  *) echo "stub: unsupported subcommand '${1:-}'" >&2; exit 91;;
esac
STUB
  } > "$PROV"
  chmod +x "$PROV"
  export CREATE_ARGV ORG_SNAPSHOT
}

base_org() {
  cat > "$ORG_SNAPSHOT" <<'ORG'
u-o1	O1	P1_PRESIDENT_COO	idle		President & COO
u-a0	A0	P4_PROVISIONING_STEWARD	idle	u-o1	Provisioning Steward
u-t0	T0	B2_TECH_CHIEF	running	u-o1	CTO & Chief AI Officer
u-dir	DIR	C1_DIRECTOR_BUILDER	idle	u-t0	Director of Engineering
u-mgr	MGR	D1_MANAGER	idle	u-dir	Engineering Manager
ORG
}
reset() { rm -f "$QUEUE" "$GRANT_LOG" "$DISABLED_TEMPLATES" "$CREATE_ARGV"; base_org; }
last_sub() { jq -r 'select(.event=="request.submitted")|.requestId' "$QUEUE" | tail -1; }
subs_for()  { jq -r --arg r "$1" 'select(.event=="request.submitted" and .requestId==$r)|.requestId' "$QUEUE" | wc -l; }

build_stub
reset

# ===========================================================================
hdr "1. A request id names exactly one request"
# The reviewer approves an ID. If an ID can name two submissions, the reviewer
# approved a row it read and the queue executes whichever record happens to be
# last in the file — including a DIFFERENT TEMPLATE. Both requests below are
# inside DIR's request ceiling, so nothing here is a ceiling violation; the
# violation is that the decision does not bind to what was decided.
reset
# Opt-in Actions diagnostics cover only these two synthetic submissions. Never
# trace an inherited environment: queue startup can otherwise expand credentials.
diagnostic_tracer=()
diagnostic_root="$TMP"
if [[ -n "${REQUEST_RECORD_DIAGNOSTICS_DIR:-}" ]]; then
  # Open child evidence in its retained destination before either launch. An
  # interrupted wait must not depend on reaching the post-oracle copy/controls.
  mkdir -p "$REQUEST_RECORD_DIAGNOSTICS_DIR" || exit 1
  diagnostic_root="$(cd "$REQUEST_RECORD_DIAGNOSTICS_DIR" && pwd)" || exit 1
  # Probe only a separate credential-free no-op before launching either child.
  # An installed tracer can lack ptrace permission; never retry a submission.
  tracer_rc=127
  if command -v strace >/dev/null; then
    diagnostic_tracer=(strace -f -ttt -T -s 256 -e trace=execve,mkdir,mkdirat,unlink,unlinkat,rmdir,exit_group,wait4,chdir)
    env -i PATH="$PATH" HOME="$TMP" timeout --kill-after=1 5 \
      "${diagnostic_tracer[@]}" -o "$diagnostic_root/tracer-probe.syscalls" /usr/bin/true \
      >"$diagnostic_root/tracer-probe.out" 2>&1; tracer_rc=$?
  fi
  printf 'probe_rc=%s\n' "$tracer_rc" >> "$diagnostic_root/tracer-probe.out"
  [[ "$tracer_rc" -eq 0 ]] || diagnostic_tracer=()
fi
diagnostic_submit() {
  local label="$1" script="$2"; shift 2
  local -a observer=()
  if [[ "${#diagnostic_tracer[@]}" -gt 0 ]]; then
    observer=("${diagnostic_tracer[@]}" -o "$diagnostic_root/$label.syscalls")
  else
    printf 'syscall_tracer=unavailable\nprobe_rc=%s\n' "$tracer_rc" > "$diagnostic_root/$label.syscalls"
  fi
  if [[ "$label" == lock-controls ]]; then
    observer=(timeout --kill-after=1 10 "${observer[@]}")
  fi
  env -i PATH="$PATH" HOME="$TMP" COMPANY_ID="$COMPANY_ID" \
    QUEUE="$QUEUE" GRANT_LOG="$GRANT_LOG" DISABLED_TEMPLATES="$DISABLED_TEMPLATES" \
    ORG_SNAPSHOT="$ORG_SNAPSHOT" PROV="$PROV" CREATE_ARGV="$CREATE_ARGV" \
    REQUEST_RECORD_DIAGNOSTIC_SCRIPT="$script" \
    REQUEST_RECORD_OBSERVER_PYTHON="$(command -v python3)" \
    REQUEST_RECORD_OBSERVER_METADATA="$HERE/test/request_record_provenance.py" \
    BASH_ENV="$HERE/test/request_record_provenance.sh" \
    BASH_XTRACEFD=9 PS4='+ ${EPOCHREALTIME} ${BASHPID} ${BASH_SOURCE}:${LINENO}: ' \
    "${observer[@]}" bash -x "$script" "$@" 8>"$diagnostic_root/$label.provenance" 9>"$diagnostic_root/$label.trace"
}
concurrent_submit() {
  local label="$1"; shift
  if [[ -n "${REQUEST_RECORD_DIAGNOSTICS_DIR:-}" ]]; then
    diagnostic_submit "$label" "$Q" "$@"
  else
    "$Q" "$@"
  fi
}
concurrent_submit submit-one submit --requester DIR --template E0_SPECIALIST --title "IRQ Junior web engineer" >"$diagnostic_root/submit-one.out" 2>&1 &
first_pid=$!
concurrent_submit submit-two submit --requester DIR --template D1_MANAGER --title "IRQ Engineering manager" >"$diagnostic_root/submit-two.out" 2>&1 &
second_pid=$!
wait "$first_pid"; first_rc=$?
wait "$second_pid"; second_rc=$?
total="$(jq -r 'select(.event=="request.submitted")|.requestId' "$QUEUE" | wc -l)"
uniq_n="$(jq -r 'select(.event=="request.submitted")|.requestId' "$QUEUE" | sort -u | wc -l)"
if [[ "$first_rc" -eq 0 && "$second_rc" -eq 0 && "$total" -eq 2 && "$uniq_n" -eq 2 ]]; then
  ok "both concurrent submissions succeeded with distinct request ids"
else
  bad "concurrent allocation failed (exits $first_rc/$second_rc, $total submitted, $uniq_n distinct)"
  cat "$diagnostic_root/submit-one.out" "$diagnostic_root/submit-two.out"
  jq -r 'select(.event=="request.submitted")|"        \(.requestId)  \(.template)  \(.title)"' "$QUEUE"
fi
if [[ -n "${REQUEST_RECORD_DIAGNOSTICS_DIR:-}" ]]; then
  # Keep evidence even on non-recurrence. Controls never touch the original queue
  # or serialize its submissions; they start only after its oracle is evaluated.
  control_root="$(mktemp -d "$TMP/lock-controls.XXXXXX")"
  diagnostic_submit lock-controls "$HERE/test/request_record_provenance.sh" "$control_root" \
    >"$diagnostic_root/lock-controls.out" 2>&1; controls_rc=$?
  [[ "$controls_rc" -eq 0 ]] || bad "isolated command/filesystem control failed (exit $controls_rc)"
  for contender in one two; do
    [[ ! -f "$control_root/$contender.out" ]] || \
      cp "$control_root/$contender.out" "$REQUEST_RECORD_DIAGNOSTICS_DIR/control-$contender.out"
  done
  [[ ! -f "$QUEUE" ]] || cp "$QUEUE" "$REQUEST_RECORD_DIAGNOSTICS_DIR/queue.snapshot"
  printf 'first_rc=%s\nsecond_rc=%s\nsubmitted=%s\ndistinct=%s\ncontrols_rc=%s\n' \
    "$first_rc" "$second_rc" "$total" "$uniq_n" "$controls_rc" > "$REQUEST_RECORD_DIAGNOSTICS_DIR/result.txt"
  note "isolated concurrency diagnostics retained in $REQUEST_RECORD_DIAGNOSTICS_DIR"
fi

# The locks serialize a successful count, but a failed count must not become
# zero. Hold A after its durable commit, make B contend for its queue lock, then
# fail only B's allocation read after A unlocks. Without explicit propagation,
# B appends a second REQ-001 even though both critical sections were locked.
reset
FAULT_BIN="$TMP/allocation-bin"; mkdir "$FAULT_BIN"
export ALLOCATION_SYNC="$TMP/allocation-sync"
mkdir "$ALLOCATION_SYNC"
mkfifo "$ALLOCATION_SYNC/committed" "$ALLOCATION_SYNC/contended" "$ALLOCATION_SYNC/release"
exec 6<>"$ALLOCATION_SYNC/committed" 7<>"$ALLOCATION_SYNC/contended" 8<>"$ALLOCATION_SYNC/release"
export ALLOCATION_REAL_JQ="$(command -v jq)" ALLOCATION_REAL_MKDIR="$(command -v mkdir)"
export ALLOCATION_REAL_WRITER="$HERE/lib/durable_queue.py"
cat > "$FAULT_BIN/writer" <<'WRITER'
#!/usr/bin/env bash
"$ALLOCATION_REAL_WRITER" "$@" || exit $?
if [[ "$1" == "append-batch" ]]; then
  printf 'committed\n' > "$ALLOCATION_SYNC/committed"
  IFS= read -r -t 10 release < "$ALLOCATION_SYNC/release" || exit 91
fi
WRITER
cat > "$FAULT_BIN/mkdir" <<'MKDIR'
#!/usr/bin/env bash
"$ALLOCATION_REAL_MKDIR" "$@"; rc=$?
if [[ "$*" == "${QUEUE}.lock" && $rc -ne 0 && ! -f "$ALLOCATION_SYNC/contended-once" ]]; then
  : > "$ALLOCATION_SYNC/contended-once"
  printf 'contended\n' > "$ALLOCATION_SYNC/contended"
fi
exit "$rc"
MKDIR
cat > "$FAULT_BIN/jq" <<'JQ'
#!/usr/bin/env bash
if [[ $# -eq 3 && "$1" == "-r" && "$2" == 'select(.event=="request.submitted")|.requestId' && "$3" == "$QUEUE" ]]; then
  : > "$ALLOCATION_SYNC/read-failed"
  printf 'injected allocation read failure\n' >&2
  exit 7
fi
exec "$ALLOCATION_REAL_JQ" "$@"
JQ
chmod +x "$FAULT_BIN/writer" "$FAULT_BIN/mkdir" "$FAULT_BIN/jq"
REQRECORD_DURABLE_WRITER="$FAULT_BIN/writer" "$Q" submit --requester DIR --template E0_SPECIALIST \
  --title "IRQ committed before read failure" >"$TMP/committed.out" 2>&1 &
first_pid=$!
committed=""; contended=""
IFS= read -r -t 10 -u 6 committed || bad "first submit did not reach its durable commit barrier"
jq -c 'select(.event=="request.submitted" or .event=="notify.queued")' "$QUEUE" > "$TMP/intent-before"
# Like the isolated PATH fixture below, ignore startup hooks only in this
# offline child so they cannot silently replace the recording fakes.
BASH_ENV=/dev/null PATH="$FAULT_BIN:$PATH" "$Q" submit --requester DIR --template D1_MANAGER \
  --title "IRQ allocation read failure" >"$TMP/read-failure.out" 2>&1 &
second_pid=$!
IFS= read -r -t 10 -u 7 contended || bad "second submit did not contend for the held queue lock"
printf 'release\n' >&8
wait "$first_pid"; first_rc=$?
wait "$second_pid"; second_rc=$?
exec 6>&- 7>&- 8>&-
if [[ "$committed" == committed && "$contended" == contended && -f "$ALLOCATION_SYNC/read-failed" && "$first_rc" -eq 0 ]]; then
  ok "allocation read fault was reached only after a competing durable commit"
else
  bad "allocation fault fixture did not exercise the intended interleaving"
  cat "$TMP/committed.out" "$TMP/read-failure.out"
fi
jq -c 'select(.event=="request.submitted" or .event=="notify.queued")' "$QUEUE" > "$TMP/intent-after"
if [[ "$second_rc" -eq 2 ]] && cmp -s "$TMP/intent-before" "$TMP/intent-after"; then
  ok "a failed allocation read refuses without publishing a request or notification intent"
else
  bad "a failed allocation read was treated as a usable request id (exit $second_rc)"
  cat "$TMP/read-failure.out"
  jq -c 'select(.event=="request.submitted")|{requestId,template}' "$QUEUE"
fi
if [[ ! -d "${QUEUE}.lock" && ! -d "${QUEUE}.notify-status.lock" ]] \
    && "$Q" submit --requester DIR --template D1_MANAGER --title "IRQ after allocation refusal" >"$TMP/after-refusal.out" 2>&1 \
    && [[ "$(last_sub)" == REQ-002 ]]; then
  ok "allocation refusal releases both locks and the next valid submission receives REQ-002"
else
  bad "allocation refusal leaked a lock or changed the next request id"
  cat "$TMP/after-refusal.out" 2>/dev/null || true
fi

# ===========================================================================
hdr "2. The resubmission cap counts amendments, not path depth"
# docs/responsible-leader.md: 'Supersede chains are capped at 5 ... the cap
# refuses the sixth and logs it, which forces the escalation that should have
# happened already.' A cap that only measures the LENGTH of one chain does not
# bound the number of times one denial may be re-argued: every amendment can
# point at the same original denial and each is depth 1 forever.
reset
"$Q" submit --requester MGR --template E0_SPECIALIST --title "IRQ nag root" >/dev/null 2>&1
ROOT="$(last_sub)"
"$Q" review --reviewer DIR --request "$ROOT" --reject --reason "no" --no-safer-alternative "fixture denial; alternatives are exercised in their own section" >/dev/null 2>&1
allowed=0; refused=0
for i in 1 2 3 4 5 6 7 8; do
  if "$Q" submit --requester MGR --template E0_SPECIALIST --title "IRQ fanout $i" \
       --supersedes "$ROOT" >/dev/null 2>&1; then
    allowed=$((allowed+1))
    "$Q" review --reviewer DIR --request "$(last_sub)" --reject --reason "still no" --no-safer-alternative "fixture denial; alternatives are exercised in their own section" >/dev/null 2>&1
  else
    refused=$((refused+1))
  fi
done
if [[ $refused -gt 0 ]]; then
  ok "re-arguing one denial is capped ($allowed allowed, $refused refused)"
else
  bad "one denial was re-argued $allowed times with no cap and no log entry"
  note "supersedeDepth = prev.depth + 1, so N siblings off one denial are all depth 1"
fi
if grep -q supersede_chain_exhausted "$GRANT_LOG" 2>/dev/null; then
  ok "the exhausted chain is logged, so the forced escalation is visible"
else
  bad "no supersede_chain_exhausted event was ever logged"
fi

# ===========================================================================
hdr "3. An expired request can be answered by the requester, unaided"
# The documented remedy for an expiry is 'resubmit it with --supersedes'. That
# only works if the request is ALREADY recorded as expired — and expiry is
# materialised as a side effect of somebody attempting a review. Nobody has to
# attempt one. A request that quietly ages out is then neither decidable nor
# supersedable: a dead end, on the issue about dead ends.
reset
REQUEST_TTL_DAYS=-1 "$Q" submit --requester MGR --template E0_SPECIALIST \
  --title "IRQ Aged out" >/dev/null 2>&1
REQ="$(last_sub)"
out="$("$Q" submit --requester MGR --template E0_SPECIALIST --title "IRQ Resubmitted" \
         --supersedes "$REQ" 2>&1)"
if [[ $? -eq 0 ]]; then
  ok "the requester superseded its own expired request without a reviewer's help"
else
  bad "an expired request cannot be superseded until someone attempts a review"
  note "$(head -1 <<<"$out")"
  note "request_state() reports 'pending' because request.expired was never written"
fi
# Asserted through `thread` rather than `list` on purpose: `list` has its own
# defect (section 5) and would hand this one a false PASS by printing nothing.
if grep -q EXPIRED <<<"$("$Q" thread --request "$REQ" 2>&1)"; then
  ok "the record shows the request aged out, without a reviewer having touched it"
else
  bad "an aged-out request still reads as pending; expiry is only written by a review attempt"
  note "nothing ages a request out on its own; expired() is consulted, never recorded"
fi

# ===========================================================================
hdr "4. An approval says why, not just who"
# TOG-198, verbatim: 'A log that records only outcomes cannot answer "why was
# this approved" six months later, which is the question an audit actually
# asks.' A denial without a reason is refused outright. An approval without one
# is not — and the approval is the decision an audit comes back for.
reset
"$Q" submit --requester MGR --template E0_SPECIALIST --title "IRQ Silent approval" >/dev/null 2>&1
REQ="$(last_sub)"
if "$Q" review --reviewer DIR --request "$REQ" --approve >/dev/null 2>&1; then
  bad "an approval with no reason was accepted"
  note "review --reject refuses without --reason; review --approve does not"
else
  ok "an approval without a reason is refused, exactly as a denial is"
fi
reset
"$Q" submit --requester MGR --template E0_SPECIALIST --title "IRQ Reasoned approval" >/dev/null 2>&1
REQ="$(last_sub)"
"$Q" review --reviewer DIR --request "$REQ" --approve --reason "headcount plan signed off" >/dev/null 2>&1
if grep -q "headcount plan signed off" <<<"$("$Q" thread --request "$REQ" 2>&1)"; then
  ok "thread renders the approval's reasoning, not only its verdict"
else
  bad "thread shows APPROVED without the reasoning behind it"
fi

# ===========================================================================
hdr "5. The queue view works where the queue runs"
# `list` is how a leader discovers that anything is waiting on them. It pipes
# through `column`, which is util-linux and is NOT present everywhere this
# tooling runs — the sibling suite's stub avoids `column` for exactly this
# reason while cmd_list still depends on it. Where it is missing, `list` prints
# NOTHING and the failure goes to stderr, so an empty inbox and an unusable one
# look identical.
reset
"$Q" submit --requester MGR --template E0_SPECIALIST --title "IRQ Visible" >/dev/null 2>&1
REQ="$(last_sub)"
STUBBIN="$TMP/nobin"; mkdir -p "$STUBBIN"
# Supply the queue's normal utilities, but deliberately omit column. Run away
# from the checkout and ignore shell startup hooks so missing tools cannot hide.
for b in bash dirname jq sed awk grep cut date cat wc sort head tail tr printf mktemp rm; do
  p="$(command -v "$b" 2>/dev/null)" && ln -sf "$p" "$STUBBIN/$b"
done
if grep -q "$REQ" <<<"$(cd "$TMP" && BASH_ENV=/dev/null PATH="$STUBBIN" "$Q" list --status pending 2>/dev/null)"; then
  ok "list renders the pending queue without util-linux \`column\`"
else
  bad "list prints nothing when \`column\` is absent — an unusable inbox looks like an empty one"
fi

# ===========================================================================
hdr "6. A duplicate id is REFUSED, not resolved — even when no race made it"
# Added by TOG-253 alongside the fix. Section 1 asserts the same invariant but
# is deliberately fail-closed: once ids are allocated under a lock the race
# stops firing, so section 1 passes trivially and stops exercising the refusal.
#
# The invariant has to hold for duplicates the lock never saw — a queue restored
# from a backup, a rotated file, a hand-edited one, a lock defeated on a
# filesystem where mkdir is not atomic. So this writes the duplicate directly
# and asserts the REVIEW refuses. Deterministic, and it is what makes the
# ambiguous-id mutation gate in CI meaningful.
reset
"$Q" submit --requester DIR --template E0_SPECIALIST --title "IRQ Original" >/dev/null 2>&1
REQ="$(last_sub)"
# Same id, different template: exactly the shape that provisioned a D1_MANAGER
# against a reviewer who had been shown an E0_SPECIALIST.
jq -c --arg r "$REQ" 'select(.requestId==$r and .event=="request.submitted")
  | .template="D1_MANAGER" | .title="IRQ Smuggled in behind it"' "$QUEUE" | head -1 >> "$QUEUE"
if [[ "$(jq -r --arg r "$REQ" 'select(.requestId==$r and .event=="request.submitted")|.requestId' "$QUEUE" | wc -l)" -eq 2 ]]; then
  ok "fixture built: one id now names two submissions"
else
  bad "fixture failed to build; the rest of this section proves nothing"
fi
if "$Q" review --reviewer T0 --request "$REQ" --approve --reason "looks fine to me" >/dev/null 2>&1; then
  bad "the review decided an id that names two different requests"
  note "request_submission() resolves the ambiguity with tail -1 — an arbitrary answer, not a correct one"
else
  ok "the review is refused outright; an ambiguous record is not decidable"
fi
if [[ ! -s "$CREATE_ARGV" ]]; then
  ok "nothing was provisioned off the ambiguous record"
else
  bad "the provisioner ran anyway: $(cat "$CREATE_ARGV")"
fi
if grep -q ambiguous_request_id "$GRANT_LOG" 2>/dev/null; then
  ok "the refusal is logged, so a corrupted queue is visible rather than merely inert"
else
  bad "nothing was logged; a corrupted queue refuses silently"
fi

printf '\n\033[1mRESULT: %d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
