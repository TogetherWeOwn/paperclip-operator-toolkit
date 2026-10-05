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
# A note on the concurrency tests. `&` plus `wait` is a weak scheduler and a
# race that reproduces every time here could hide on a faster host. So they are
# written to fail CLOSED: each asserts an invariant that must hold whether or
# not the race is won this run. A run that never collides still passes, and a
# run that does collide fails for a reason, never flakily.
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
( "$Q" submit --requester DIR --template E0_SPECIALIST --title "IRQ Junior web engineer"   >/dev/null 2>&1 ) &
( "$Q" submit --requester DIR --template D1_MANAGER    --title "IRQ Engineering manager"   >/dev/null 2>&1 ) &
wait
total="$(jq -r 'select(.event=="request.submitted")|.requestId' "$QUEUE" | wc -l)"
uniq_n="$(jq -r 'select(.event=="request.submitted")|.requestId' "$QUEUE" | sort -u | wc -l)"
if [[ "$total" -eq "$uniq_n" ]]; then
  ok "concurrent submissions received distinct request ids ($total submitted, $uniq_n distinct)"
else
  bad "two concurrent submissions collided on one request id ($total submitted, $uniq_n distinct)"
  jq -r 'select(.event=="request.submitted")|"        \(.requestId)  \(.template)  \(.title)"' "$QUEUE"
  note "next_id() counts existing rows and appends; nothing serialises the read"
fi

# Fails closed: if the race did not fire this run, there is no duplicate to
# approve and the invariant below holds trivially.
dup="$(jq -r 'select(.event=="request.submitted")|.requestId' "$QUEUE" | sort | uniq -d | head -1)"
if [[ -z "$dup" ]]; then
  ok "no duplicate id to decide (race did not fire this run)"
else
  want="$(jq -r --arg r "$dup" 'select(.event=="request.submitted" and .requestId==$r)|.template' "$QUEUE" | head -1)"
  "$Q" review --reviewer T0 --request "$dup" --approve --reason "approving the row I read" >/dev/null 2>&1
  got="$(cut -f2 "$CREATE_ARGV" 2>/dev/null | tail -1)"
  if [[ -z "$got" || "$got" == "$want" ]]; then
    ok "the approval provisioned the template the reviewer was shown ($want)"
  else
    bad "the reviewer was shown '$want' and the queue provisioned '$got'"
    note "review binds to the request ID; request_submission() takes tail -1"
  fi
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
for b in bash jq sed awk grep cut date cat wc sort head tail tr printf mktemp rm; do
  p="$(command -v "$b" 2>/dev/null)" && ln -sf "$p" "$STUBBIN/$b"
done
if grep -q "$REQ" <<<"$(PATH="$STUBBIN" "$Q" list --status pending 2>/dev/null)"; then
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
