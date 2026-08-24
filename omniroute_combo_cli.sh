#!/usr/bin/env bash
# =====================================================================================
# omniroute_combo_cli.sh — operator-run, constrained OmniRoute combo/mapping manager
#
# TOG-151 (Phase 1b). Proposal for operator review — NOT a deployment.
# Author: Chief Security & Trust Officer / CISO agent, 2026-08-23.
#
# WHY THIS EXISTS
#   OmniRoute is the inference path for every company on this box and holds the
#   provider credentials. An agent holding the management password could redirect all
#   traffic or read those credentials. The owner chose a constrained CLI over granting
#   that credential. This script is that constraint expressed in code: it can touch
#   combos and model_combo_mappings and nothing else, and it refuses to place a
#   Claude-family model anywhere but teamclaude.
#
#   Agents propose a combo spec (JSON) through org_request_queue.sh. The operator
#   reviews it and applies it with this tool. The agent never holds the credential.
#
# ------------------------------------------------------------------------------------
# RESOLVED — operator answers, 2026-08-23. Kept as a record of what the code now
# depends on, so a future reader knows which lines are load-bearing and why.
# ------------------------------------------------------------------------------------
#   [RESOLVED-1] Mutation log now matches provisioner-grant-log.jsonl field-for-field,
#            against the schema the operator supplied (722 records; rows correctly
#            withheld — they name real agents and grants). The shared spine is
#            'event' (on 100% of provisioner records), 'callerAgentId' (74%) and
#            'reason' (65%); before/after state follows the previousGrants/newGrants
#            pattern as previousCombo/newCombo. 'by' (the operator identity) is the
#            provisioner's own field name, not an invention. See audit().
#
#   [RESOLVED-8] The audit log is now PROVEN WRITABLE BEFORE the first mutation, not
#            discovered unwritable after it. audit() must run after the API write (it
#            records the server-assigned id), so every audit failure was landing on a
#            combo change that had already happened. Measured on v0.2.4: an unwritable
#            log directory produced exit 1 and a bare "Permission denied" AFTER the
#            PUT, with no record written and nothing on screen saying the combo had
#            been written; a COMBO_LOG_FILE that was a symlink was followed, so the
#            record went into the target and a 0644 file was chmod'd to 0600.
#            Now: preflight_mutate writes a 'run_start' record (proving the path by
#            using it, not by testing a permission bit); symlinks are refused;
#            the record is BUILT before the file is touched; and a failure after a
#            mutation prints "THE MUTATION WAS APPLIED AND IS NOT IN THE LOG", the
#            backup path, and the exact JSON line to append by hand. Exit code 6.
#            DO NOT make the chmod or the append best-effort again — "|| true" on
#            those lines is what let an unrecorded mutation look like a normal error.
#
#   [RESOLVED-2] Management auth is a **Bearer API key carrying 'manage' or 'admin'
#            scope** — requireManagementAuth.ts credential type #4. There is no login
#            call, no password read and no cookie anywhere in this tool now; the
#            OMNIROUTE_MANAGEMENT_PASSWORD path is gone entirely rather than left as
#            a fallback, because a second way to touch auth is a second way to get it
#            wrong. The token is passed via a 0600 curl --config file, never argv:
#            /proc/*/cmdline is world-readable and every company shares this host.
#            FUTURE (do not adopt blind): credential type #3, the 'oma_'-prefixed
#            scoped access token, is narrower than a manage-scope key and is built for
#            exactly this remote-CLI shape. It rides the same Authorization: Bearer
#            header, so this tool will send it unchanged and records which credential
#            class was used in the log — but nobody has read evaluateAccessTokenAuth
#            yet, so it is UNVERIFIED here. Read what it grants before switching.
#
#   [RESOLVED-3] GET /api/combos returns {combos, total}; each element is the combo
#            plus a computed 'computed_context_length'. Errors are {error} with
#            400/500. {combos,total} is now the expected shape; the other shapes are
#            still tolerated and anything else fails closed. Read-back compares named
#            fields only, so the server's computed field cannot cause a false
#            mismatch.
#
#   [RESOLVED-4] NOT redundant — the opposite. POST /api/combos calls
#            validateComboDAG(), which checks cycles and max depth and NOTHING ELSE.
#            Nested combos are a supported first-class feature: OmniRoute will accept
#            a combo whose member is another combo, and the auto/* family is already
#            38 such server-side combos this tool's key cannot even enumerate. So a
#            member of auto/claude-opus reaches Claude, the membership lives
#            server-side, and it can be repointed AFTER any review. Refusing
#            combo-backed members rather than following them is LOAD-BEARING: it
#            compensates for a server-side permission we do not hold, it does not
#            duplicate a server-side restriction. There is deliberately no override
#            flag. Do not add one.
#
# ------------------------------------------------------------------------------------
# [RESOLVED-5] Endpoints and the read credential — probed, not assumed
# ------------------------------------------------------------------------------------
#   Probed unauthenticated against the live instance on 2026-08-23. The two ports are
#   NOT interchangeable, and the defaults below are now confirmed correct by port:
#
#       /api/combos on :20128  -> 401  {error:{code:"AUTH_001",...}}  <- management
#       /api/combos on :20129  -> 404  {error:"not_found", message:"API port only
#                                       serves OpenAI-compatible routes."}
#       /v1/models  on :20129  -> 401  {error:{code:"AUTH_002",message,
#                                       correlation_id}}              <- catalogue
#
#   NOTE the management port emits BOTH envelope shapes, which corrects what this
#   file previously recorded. {error: string} is what the ROUTE HANDLERS return on
#   400/500; the 401 comes from the auth middleware ahead of them and is nested, with
#   its own code (AUTH_001 vs the catalogue port's AUTH_002). Neither port is
#   uniform, so api_error_text parses both shapes on both ports rather than keying on
#   which URL was called. A swapped URL fails as a 404 whose body names the mistake.
#   'check-endpoints' reports all of this and sends NO credential while doing it.
#
#   On the HOST default of 127.0.0.1: kept deliberately. From inside a container
#   127.0.0.1 is refused and the network alias 'omniroute' answers, but this tool runs
#   on the host, where the published ports are on loopback and that alias does not
#   resolve. Do not "fix" the default to the alias by testing it from a container.
#
#   The credential itself is unchanged and still a READ key in $OMNIROUTE_API_KEY:
#   /v1/models is read-only under an API key, the same boundary that makes this whole
#   tool necessary. The operator holds it while running this on the host; no agent
#   ever sees it, so it does not widen any agent's authority. If a read key is
#   unavailable, COMBO_CATALOGUE_FILE takes an operator-captured snapshot instead —
#   audited, and warned about on every use, because a snapshot is exactly the
#   staleness TOG-150/TOG-176 warned about. There is no third path and no bundled
#   fallback list: with neither, the tool refuses.
#
# ------------------------------------------------------------------------------------
# STILL OPEN — one item, and it needs the operator, not more agent-side work
# ------------------------------------------------------------------------------------
#   [RESOLVED-6] The operator ran an authenticated 'list' on the host with a
#            manage-scoped key: three combos returned, exit 0. The auth path and the
#            READ path are proven live.
#
#   [STILL OPEN] No MUTATION path has ever run against a live server. apply, delete,
#            map-apply and map-delete are exercised only against fixtures in the
#            selftest. As of v0.2.3 the backup that guards them IS exercised for real
#            (a live WAL database is built, backed up and verified in-suite), but the
#            writes themselves are not. The TOG-152 bake-off is the first live
#            exercise. Until it lands, treat every write as unproven.
#
# ------------------------------------------------------------------------------------
# THE CLAUDE CONTAINMENT CONTROL — read this before changing it
# ------------------------------------------------------------------------------------
# Per TOG-176, Claude is reachable via 6 providers and 351 model ids, and 14 of those
# ids contain neither "claude" nor "anthropic":
#     aug/opus4.8 ("Opus 4.8"), aug/sonnet5-high, aug/fable-5, aug/prism-a
#     ("Prism (Claude + Gemini)"), aug/opus4.7-500k, aug/haiku4.5, aug/sonnet4.6, ...
# Multipliers, all live today: oc/ and opencode/ alias the same models; a no-think/
# namespace duplicates essentially everything; auto/* combos reach Claude through
# server-side membership that can be repointed AFTER any review. claude-opus-5 alone
# resolves via 6 distinct ids.
#
# Therefore:
#   * PRIMARY GATE (gate_allowlist): deny-by-default allowlist of EXACT model ids,
#     compared with string equality. No substrings, no regex, no normalisation, no
#     provider-name matching. A missing or empty allowlist denies everything.
#     This is the control. It is the only thing standing between us and the 14.
#
#   * RESOLUTION FIRST (resolve_members): combo-backed members are resolved to their
#     leaf model ids BEFORE the gate runs. Unresolvable => refuse.
#
#   * SECONDARY TRIPWIRE (gate_claude_tripwire): a deliberately broad Claude-suspicion
#     matcher. It can only ever REFUSE MORE, never allow more. Its false negatives are
#     covered by the primary gate; its false positives are cleared by the operator
#     typing an explicit !nonclaude marker in the allowlist, which is logged on use.
#     A denylist is not safe as a primary control. As a second layer that fails
#     closed, it is free defence in depth — which is what the task asked for.
#
#   * LIVE CATALOGUE (gate_catalogue, gate_blended): two facts an allowlist cannot
#     hold, because they change after the review that produced it.
#       - EXISTENCE. An id withdrawn or renamed upstream is refused. Six ids in the
#         2026-08-23 capture are already deprecated. The catalogue is READ AT RUNTIME
#         and is never bundled with this script — that staleness is the thing TOG-150
#         and TOG-176 both warned about.
#       - BLENDING. aug/prism-a is "Prism (Claude + Gemini)". Partial Claude exposure
#         is still Claude exposure, and traffic through a blend cannot be attributed
#         to one model afterwards, so the containment claim becomes unverifiable.
#         Blended routes are REFUSED OUTRIGHT and !nonclaude does not clear them.
#         aug/prism-b ("Prism (GPT + Kimi)") is refused on the same ground even
#         though it carries no Claude: unattributable is unattributable.
#     Blend status lives in the catalogue's NAME field, not in the id, and upstream
#     can change what an id blends without renaming it. That is exactly why this is
#     re-read on every apply instead of recorded once in the allowlist.
#
#   * NO NORMALISATION, ANYWHERE. Comparison is whole-string equality on the id.
#     no-think/ is the single largest Claude bucket (124 of the 351) and it namespaces
#     essentially the whole catalogue; oc/ and opencode/ alias each other. Any code
#     that strips or canonicalises a prefix before matching collapses a third of the
#     surface into ids that were reviewed under different assumptions. There is a
#     selftest asserting this stays true — do not "helpfully" add normalisation.
#
# DO NOT "simplify" this by deleting the allowlist and keeping the tripwire. That
# inverts it into the exact broken design TOG-176 documented.
# =====================================================================================

set -euo pipefail

readonly VERSION="0.2.5-proposal"
readonly PROG="${0##*/}"

# ---------------------------------------------------------------------------- config
: "${OMNIROUTE_BASE_URL:=http://127.0.0.1:20128}"
: "${OMNIROUTE_ENV_FILE:=./omniroute.env}"
# Operator-confirmed host path (2026-08-23). In-container it is /app/data/storage.sqlite,
# but this tool runs on the HOST, so the host path is the default.
: "${OMNIROUTE_SQLITE:=$HOME/.local/share/containers/storage/volumes/systemd-omniroute/_data/storage.sqlite}"
: "${COMBO_ALLOWLIST_FILE:=./omniroute_combo_allowlist.txt}"
: "${COMBO_BACKUP_DIR:=./backups/omniroute}"
: "${COMBO_LOG_FILE:=./omniroute-combo-log.jsonl}"      # sibling of provisioner-grant-log.jsonl
: "${COMBO_OWNED_PREFIX:=two/}"                         # only combos under this prefix are mutable
: "${CURL_TIMEOUT:=20}"

# [RESOLVED-2] Management credential: a Bearer API key with 'manage' or 'admin' scope.
# Read from the environment, or from OMNIROUTE_ENV_FILE as OMNIROUTE_MANAGEMENT_KEY /
# MANAGEMENT_API_KEY. Never from argv, never logged, never echoed.
: "${OMNIROUTE_MANAGEMENT_KEY:=}"

# Provenance of the request this invocation is applying. The operator runs the tool,
# but the AGENT that proposed the combo is the caller of record — that is what makes
# the log answer "who asked for this", which is the question the provisioner's
# callerAgentId exists to answer. COMBO_REASON is required for every mutation.
: "${COMBO_REQUEST_AGENT:=}"                            # -> callerAgentId
: "${COMBO_REQUEST_TEMPLATE:=}"                         # -> callerTemplate
: "${COMBO_REASON:=}"                                   # -> reason  (--reason overrides)

# Set by --allow-rebind. Permits an update that drops or changes an existing leg's
# connectionId. Deliberately NOT a containment override (the Claude tripwire and the
# nested-member refusal have no override and must not gain one) — this guards against
# silent DATA LOSS on a field the operator may not know exists, and rebinding a leg to
# a different connection is a legitimate operation that must simply be stated out loud.
: "${COMBO_ALLOW_REBIND:=0}"

# Set by --allow-reorder. The read-back asserts member ORDER as well as membership,
# because for priority / fill-first / context-relay / pipeline the list order is the
# routing order. It is not yet known whether OmniRoute persists members in the order
# they were sent; if it does not, the first apply will fail closed on the order check
# rather than report a match it cannot back up. This flag is how the operator records
# "I have seen that this server reorders, and I accept it" — deliberately a conscious
# statement rather than a tolerance baked into the comparison, which is exactly how the
# order blindness got in.
: "${COMBO_ALLOW_REORDER:=0}"

# The model catalogue is resolved LIVE and is deliberately NOT bundled with this
# script. TOG-150 and TOG-176 both established that the routing surface must be read
# at runtime: six ids in the 2026-08-23 capture are already deprecated, and a baked-in
# list would reintroduce exactly that staleness. COMBO_CATALOGUE_FILE is an escape
# hatch for an operator-captured snapshot when the live read is unavailable; it is
# never a default, it is never shipped populated, and every use of it is audited.
: "${OMNIROUTE_MODELS_URL:=http://127.0.0.1:20129/v1/models}"
: "${COMBO_CATALOGUE_FILE:=}"

# Combos this tool must NEVER mutate or delete, regardless of any flag or config.
# 19 agent bindings across OTHER companies on this instance route through these.
readonly -a PROTECTED_COMBO_GLOBS=( 'hindsight/*' 'auto/*' 'qtSd/*' )

# The 19 selectable routing strategies, verbatim from OmniRoute's
# ROUTING_STRATEGY_VALUES (/app/src/shared/constants/routingStrategies.ts), confirmed
# by the operator on TOG-152. 'quota-share' is INTERNAL-only and deliberately absent.
readonly -a VALID_STRATEGIES=(
  priority weighted round-robin context-relay fill-first
  p2c random least-used cost-optimized reset-aware
  reset-window headroom strict-random auto lkgp
  context-optimized cache-optimized fusion pipeline
)

# Aliases that normalizeRoutingStrategy() rewrites on purpose. We REJECT these rather
# than expanding them: expanding silently would make this CLI commit the same
# silent-coercion sin it exists to catch. We name the canonical form in the error.
readonly -a STRATEGY_ALIASES=(
  'usage=least-used'
  'context=context-optimized'
  'weekly-reset=reset-window'
  'reset-window-order=reset-window'
)

# ------------------------------------------------------------------------------ util
c_red()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }
c_grn()  { printf '\033[32m%s\033[0m\n' "$*" >&2; }
c_ylw()  { printf '\033[33m%s\033[0m\n' "$*" >&2; }
log()    { printf '%s\n' "$*" >&2; }
die()    { c_red "FATAL: $*"; exit 1; }
refuse() { c_red "REFUSED: $*"; exit 3; }   # exit 3 == policy refusal, distinct from error

need() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }
# Tiered on purpose: the offline commands (selftest/validate/dry-run) must be runnable
# by a reviewer on any box, including one without sqlite3 or network access.
preflight_offline() { need jq; need mktemp; need sed; need awk; }
preflight_online()  { preflight_offline; need curl; }
# A mutating run must prove three capabilities before it changes anything: that it can
# UNDO (sqlite engine), that it can VERIFY the undo (sha256), and that it can ACCOUNT
# for what it did (audit log). The third was missing — the log was only discovered
# unwritable after the write had already landed.
preflight_mutate()  { preflight_online; need_sqlite_engine; need_sha256; assert_audit_log_writable "${PREFLIGHT_SUBCOMMAND:-}"; }

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# [RESOLVED-3] Single-object envelope. Expected shape is the bare combo object;
# {data:{..}} and {combo:{..}} are still tolerated. Elements carry a server-computed
# 'computed_context_length' — harmless, because every comparison in this tool names
# the fields it checks rather than diffing whole objects.
json_unwrap() { jq -c 'if type=="object" and (has("data")) then .data elif type=="object" and (has("combo")) then .combo else . end'; }

# [RESOLVED-3] List envelope. GET /api/combos returns {combos, total}; that is now the
# EXPECTED shape and is tried first. {data:[..]}, {mappings:[..]} and a bare array are
# tolerated. Anything else yields nothing and the caller fails closed — a list read
# that silently returns empty must never be mistaken for "no such combo", so callers
# that act on absence use json_list_strict instead.
json_list() {
  jq -c 'if type=="array" then .
         elif type=="object" and ((.combos|type)=="array")  then .combos
         elif type=="object" and ((.data|type)=="array")    then .data
         elif type=="object" and ((.mappings|type)=="array") then .mappings
         else null end'
}

# Same, but fails closed when the envelope is unrecognised.
#
# Reads $API_BODY DIRECTLY rather than stdin. It is always used immediately after an
# api() call, and taking stdin meant every call site had to remember to feed it — the
# first version of this function did take stdin, no call site fed it, and the selftest
# missed it because the test piped input that production never supplies. A helper whose
# tests are more generous than its callers is a helper that fails in production only.
#
# NOTE THE RETURN, NOT refuse(). This function is always called inside $( ), and
# refuse() exits — which inside a command substitution kills only the SUBSHELL. That
# is the bug found in the first revision of this script: it printed REFUSED and the
# caller sailed on with an empty string and exit 0. Every caller must therefore be
# written `x="$(json_list_strict ...)" || exit 3` so the status crosses the boundary.
json_list_strict() {
  local what="${1:-response}" out
  out="$(json_list <<<"${API_BODY:-}")" || out="null"
  if [ -z "$out" ] || [ "$out" = "null" ]; then
    c_red "REFUSED: unrecognised ${what} envelope from OmniRoute. Expected {combos,total}; got: $(printf '%s' "${API_BODY:-<empty>}" | head -c 200). Failing closed rather than treating an unreadable list as empty."
    return 3
  fi
  printf '%s' "$out"
}

glob_match() { case "$2" in $1) return 0 ;; *) return 1 ;; esac; }

# ---------------------------------------------------------------- audit log [RESOLVED-1]
# Append-only, 0600, one JSON object per line — the same discipline as the
# provisioner's log_event(): a bare append plus a chmod, no rewrite path, ever.
#
# FIELD NAMES ARE DELIBERATELY THE PROVISIONER'S, not new ones. From the operator's
# schema of provisioner-grant-log.jsonl (722 records):
#     event         722/722  — always present, the action discriminator
#     callerAgentId 535/722  — WHO ASKED. Here that is the agent that proposed the
#                              combo through org_request_queue.sh, not the operator
#                              who ran the tool. Recording the operator here would
#                              lose the only fact worth having.
#     reason        468/722  — free text; required for mutations in this tool
#     callerTemplate 430/722 — the caller's role template
#     previousGrants/newGrants 115/220 — before/after state. The combo analogue is
#                              previousCombo/newCombo, same position, same meaning.
#     requestId      85/722  — the queue request being applied
#     by             34/722  — the identity that performed it: the operator.
# 'outcome', 'ts', 'tool' and 'version' are additions, not renames: the provisioner
# gets timestamps and identity from elsewhere, this tool is run by hand and needs to
# carry its own. A refusal is logged as loudly as a success — a log that only records
# what succeeded cannot tell you what was attempted.
# [RESOLVED-8] audit() runs AFTER the API write on every mutation path — it has to,
# because it records the id the server assigned. That ordering means an audit failure
# is not a logging inconvenience: it is a routing change sitting on the server with
# nothing recording who asked for it or why. Three rules follow, and all three are
# tested:
#   1. The path is proven usable in preflight_mutate, BEFORE the backup and the write.
#   2. The record is BUILT before the file is touched, so a malformed field is caught
#      while it is still harmless, and so we have the exact line to hand back.
#   3. A failure after the mutation says "THE MUTATION WAS APPLIED AND IS NOT LOGGED"
#      and prints the line for manual entry. It must never surface as a bare
#      "Permission denied", which is what it did before: the operator's last message
#      was 'updating existing combo id=...' followed by a path error, with nothing
#      saying the combo had in fact been written.
#
# Set by the mutation commands immediately after the API call lands. Read only by
# audit_failed, to decide whether a failure means "nothing happened" or "something
# happened and is unrecorded". Those two need different words.
MUTATION_APPLIED=0

audit_log_path_ok() {   # pure; 0 usable, 2 empty, 3 symlink
  if [ -z "${COMBO_LOG_FILE:-}" ]; then return 2; fi
  # -e follows symlinks, so the old code would happily append the audit record to,
  # and chmod 0600, whatever the link pointed at. Demonstrated: a 0644 victim.txt
  # became 0600 and gained a combo_apply record.
  if [ -L "$COMBO_LOG_FILE" ]; then return 3; fi
  return 0
}

audit_failed() {
  local event="$1" why="$2" line="${3:-}"
  c_red "AUDIT WRITE FAILED for event '$event': $why"
  if [ "${MUTATION_APPLIED:-0}" = "1" ]; then
    c_red "THE MUTATION WAS APPLIED AND IS NOT IN THE LOG."
    c_red "  backup: ${BACKUP_PATH:-<none>}"
    c_red "  Append this line to $COMBO_LOG_FILE by hand, then fix the log path:"
  else
    c_red "  No mutation had been applied at this point; nothing is unrecorded."
  fi
  if [ -n "$line" ]; then printf '%s\n' "$line" >&2; fi
  exit 6
}

# Proves the log is writable before the first mutation, by writing a real record
# rather than testing a permission bit — the same reason backup verification checks
# the artifact instead of the exit status. An aborted run then also leaves a trace.
assert_audit_log_writable() {
  local rc=0; audit_log_path_ok || rc=$?
  case "$rc" in
    2) die "COMBO_LOG_FILE is empty. Every mutation must be logged; set it to a real path." ;;
    3) refuse "COMBO_LOG_FILE '$COMBO_LOG_FILE' is a symlink. This tool appends to that
path and chmods it 0600, so following the link would write the audit record into — and
change the permissions of — a different file. Point it at a real file." ;;
  esac
  audit "run_start" "ok" "$(jq -cn --arg s "${1:-}" '{subcommand:$s}')"
}

audit() {
  local event="$1" outcome="$2" detail_json="$3"
  local prev_json="${4:-null}" next_json="${5:-null}"
  local prc=0; audit_log_path_ok || prc=$?
  [ "$prc" -eq 0 ] || audit_failed "$event" "log path unusable (rc=$prc): ${COMBO_LOG_FILE:-<empty>}"
  local dir; dir="$(dirname "$COMBO_LOG_FILE")"
  if [ ! -d "$dir" ]; then
    mkdir -p "$dir" || audit_failed "$event" "cannot create log directory '$dir'"
  fi
  # Build the record BEFORE touching the file (rule 2). jq failing here used to abort
  # the script with a raw jq usage dump and no indication a combo had just been written.
  local line jrc=0
  line="$(jq -cn \
    --arg ts "$(now_iso)" \
    --arg tool "$PROG" \
    --arg ver "$VERSION" \
    --arg event "$event" \
    --arg callerAgentId "${COMBO_REQUEST_AGENT:-}" \
    --arg callerTemplate "${COMBO_REQUEST_TEMPLATE:-}" \
    --arg reason "${COMBO_REASON:-}" \
    --arg by "${SUDO_USER:-${USER:-unknown}}" \
    --arg outcome "$outcome" \
    --arg issue "${COMBO_REQUEST_ISSUE:-}" \
    --arg requestId "${COMBO_REQUEST_ID:-}" \
    --arg credential "${MGMT_CRED_CLASS:-none}" \
    --argjson detail "$detail_json" \
    --argjson previousCombo "$prev_json" \
    --argjson newCombo "$next_json" \
    '{ts:$ts,tool:$tool,version:$ver,event:$event,callerAgentId:$callerAgentId,
      callerTemplate:$callerTemplate,reason:$reason,by:$by,outcome:$outcome,
      requestId:$requestId,requestIssue:$issue,credentialClass:$credential,
      previousCombo:$previousCombo,newCombo:$newCombo,detail:$detail}')" || jrc=$?
  [ "$jrc" -eq 0 ] || audit_failed "$event" "could not build the record (jq rc=$jrc); a field was not valid JSON"

  # Create at 0600 rather than creating then narrowing, so the record is never briefly
  # world-readable. mkdir/creat and the append are each checked: an append that fails
  # is the case that leaves a mutation unrecorded, so it may not be best-effort.
  if [ ! -e "$COMBO_LOG_FILE" ]; then
    ( umask 077; : > "$COMBO_LOG_FILE" ) \
      || audit_failed "$event" "cannot create '$COMBO_LOG_FILE'" "$line"
  fi
  printf '%s\n' "$line" >> "$COMBO_LOG_FILE" \
    || audit_failed "$event" "append to '$COMBO_LOG_FILE' failed" "$line"
  # Append-only intent: the real guarantee is filesystem/backup policy, not this line.
  # The mode, however, is not advisory — this file names agents and routing changes.
  chmod 0600 "$COMBO_LOG_FILE" \
    || audit_failed "$event" "cannot chmod 0600 '$COMBO_LOG_FILE'" "$line"
}

# Mutations must carry a reason. An unexplained routing change in the log is a row
# that cannot be reviewed later, which defeats the point of keeping the log.
require_reason() {
  [ -n "${COMBO_REASON:-}" ] \
    || die "every mutation must carry a reason: pass --reason '<why>' or set COMBO_REASON. This lands in the 'reason' field of $COMBO_LOG_FILE, matching provisioner-grant-log.jsonl."
  [ -n "${COMBO_REQUEST_AGENT:-}" ] \
    || c_ylw "warning: COMBO_REQUEST_AGENT unset — 'callerAgentId' will be empty and the log will not record which agent proposed this change."
}

# ============================================================================== ALLOWLIST
# Format, one entry per line:
#     <exact-model-id>[ !nonclaude][ # free-text note]
# Blank lines and lines starting with # are ignored. Comparison is EXACT STRING
# EQUALITY against the whole id. There is no normalisation and there must never be.
allowlist_ids() {
  [ -f "$COMBO_ALLOWLIST_FILE" ] || return 0
  sed -e 's/[[:space:]]*#.*$//' -e 's/[[:space:]]*!nonclaude[[:space:]]*/ /' "$COMBO_ALLOWLIST_FILE" \
    | awk 'NF {print $1}'
}

allowlist_has() {
  local want="$1" id
  while IFS= read -r id; do [ "$id" = "$want" ] && return 0; done < <(allowlist_ids)
  return 1
}

allowlist_nonclaude_ack() {
  local want="$1"
  [ -f "$COMBO_ALLOWLIST_FILE" ] || return 1
  grep -E "^[[:space:]]*$(sed 's/[][\.*^$/]/\\&/g' <<<"$want")[[:space:]]+!nonclaude([[:space:]]|#|$)" \
    "$COMBO_ALLOWLIST_FILE" >/dev/null 2>&1
}

# ------------------------------------------------------- PRIMARY GATE: deny by default
gate_allowlist() {
  local id="$1"
  if ! [ -s "$COMBO_ALLOWLIST_FILE" ]; then
    refuse "allowlist '$COMBO_ALLOWLIST_FILE' is missing or empty. Deny-by-default: nothing may be routed until the operator populates and reviews it. See '$PROG allowlist-scaffold'."
  fi
  allowlist_has "$id" || refuse "model id '$id' is not in the allowlist ($COMBO_ALLOWLIST_FILE). Deny-by-default: add it deliberately after confirming it is not a Claude route, or drop it from the combo."
}

# ------------------------------------------- SECONDARY TRIPWIRE: may only refuse more
# Deliberately broad. False positives are expected and are cleared by an explicit,
# logged !nonclaude marker in the allowlist (e.g. aug/prism-b == "Prism (GPT + Kimi)").
claude_suspicion_reason() {
  local id="$1" lower
  lower="$(printf '%s' "$id" | tr '[:upper:]' '[:lower:]')"
  case "$lower" in
    *claude*)                      echo "id contains 'claude'"; return 0 ;;
    *anthropic*)                   echo "id contains 'anthropic'"; return 0 ;;
    *opus*)                        echo "id contains 'opus' (Claude family name)"; return 0 ;;
    *sonnet*)                      echo "id contains 'sonnet' (Claude family name)"; return 0 ;;
    *haiku*)                       echo "id contains 'haiku' (Claude family name)"; return 0 ;;
    *fable*)                       echo "id contains 'fable' (Claude family name)"; return 0 ;;
    *prism*)                       echo "id contains 'prism' (auggie blended route; prism-a includes Claude)"; return 0 ;;
    aug/*|*/aug/*)                 echo "auggie provider names Claude models by family only (TOG-176)"; return 0 ;;
  esac
  return 1
}

gate_claude_tripwire() {
  local id="$1" reason
  if reason="$(claude_suspicion_reason "$id")"; then
    case "$id" in
      teamclaude/*) return 0 ;;   # Claude on teamclaude is the sanctioned path
    esac
    if allowlist_nonclaude_ack "$id"; then
      c_ylw "  tripwire override: '$id' flagged ($reason) but carries operator !nonclaude acknowledgement — permitted and logged."
      audit "tripwire_override" "allowed" "$(jq -cn --arg id "$id" --arg r "$reason" '{model:$id,reason:$r}')"
      return 0
    fi
    refuse "Claude containment: '$id' looks like a Claude-family route ($reason) on a provider other than teamclaude. Claude may only be routed via teamclaude/*. If this id genuinely carries no Claude AND is not a blended route, mark it '!nonclaude' in $COMBO_ALLOWLIST_FILE with a note saying why."
  fi
  return 0
}

# ====================================================== LIVE CATALOGUE (/v1/models)
# The catalogue is READ AT RUNTIME, never bundled. Two things depend on it that a
# static allowlist cannot express:
#
#   1. EXISTENCE. An allowlist entry is a statement about an id that existed when the
#      operator reviewed it. Six ids in the 2026-08-23 capture are already deprecated.
#      An id that has been renamed or withdrawn upstream must not be silently written
#      into a combo — gate_catalogue refuses it.
#
#   2. BLENDING. aug/prism-a is "Prism (Claude + Gemini)" and aug/prism-b is
#      "Prism (GPT + Kimi)". Neither id says what it carries; only the catalogue name
#      does, and that mapping can change upstream without the id changing. Blend
#      status therefore has to be re-read, not remembered.
#
# Source precedence: an explicit operator snapshot (COMBO_CATALOGUE_FILE) if set,
# otherwise the live read. There is no third option and no built-in fallback list.
CATALOGUE_TSV=""       # path to a "<id>\t<name>" file for this process
CATALOGUE_SOURCE=""    # live:<url> | file:<path>
CATALOGUE_MODE="off"   # off (offline commands) | advisory (dry-run) | required (apply)

# Accepts either the raw /v1/models JSON or an already-flattened id<TAB>name file, so
# an operator capture taken with any tool can be fed in without reshaping it.
#
# It insists on the shape rather than extracting what it can. An earlier revision used
# a permissive `(.data // .models // .)[]`, which happily iterated the VALUES of an
# arbitrary object and produced a handful of id-less rows. That still failed closed —
# every member was then reported "withdrawn upstream" — but the diagnostic pointed at
# the model ids instead of at the operator's mis-specified file, which is the kind of
# wrong error message that costs an hour at the wrong end of an incident.
catalogue_parse_to_tsv() {   # stdin: JSON or TSV -> stdout: id<TAB>name
  local raw; raw="$(cat)"
  if jq -e . >/dev/null 2>&1 <<<"$raw"; then
    jq -r '
      def catalogue: if type=="object" then (.data // .models // empty) else . end;
      (catalogue // error("not a model catalogue: expected a top-level array, or .data[] / .models[]"))
      | if type != "array" then error("not a model catalogue: .data/.models is not an array") else . end
      | .[]
      | select(type=="object")
      | select((.id? // "") | type=="string" and length > 0)
      | [.id, ((.name // .display_name // "") | tostring)]
      | @tsv' <<<"$raw"
  else
    printf '%s\n' "$raw" | awk -F'\t' 'NF && $1 !~ /^#/ {print $1 "\t" $2}'
  fi
}

catalogue_load() {
  [ -z "$CATALOGUE_TSV" ] || return 0
  local dest; dest="$(mktemp)"; chmod 0600 "$dest"

  if [ -n "$COMBO_CATALOGUE_FILE" ]; then
    [ -f "$COMBO_CATALOGUE_FILE" ] || die "COMBO_CATALOGUE_FILE='$COMBO_CATALOGUE_FILE' does not exist"
    catalogue_parse_to_tsv < "$COMBO_CATALOGUE_FILE" > "$dest" \
      || die "could not parse COMBO_CATALOGUE_FILE='$COMBO_CATALOGUE_FILE'"
    CATALOGUE_SOURCE="file:$COMBO_CATALOGUE_FILE"
    c_ylw "  catalogue: using operator snapshot $COMBO_CATALOGUE_FILE — NOT a live read. If this snapshot is stale, a withdrawn or re-pointed id will pass. Prefer the live read."
  else
    need curl
    local key="${OMNIROUTE_API_KEY:-}"
    [ -n "$key" ] || die "no model catalogue available: set OMNIROUTE_API_KEY (a READ key is sufficient) so the live catalogue at $OMNIROUTE_MODELS_URL can be resolved, or point COMBO_CATALOGUE_FILE at a snapshot you captured. This tool fails closed rather than validating members against nothing."
    local cfg; cfg="$(mktemp)"; chmod 0600 "$cfg"
    printf 'url = "%s"\nheader = "Authorization: Bearer %s"\nsilent\nshow-error\nmax-time = %s\nwrite-out = "\\n%%{http_code}"\n' \
      "$OMNIROUTE_MODELS_URL" "$key" "$CURL_TIMEOUT" > "$cfg"
    local resp code body
    resp="$(curl --config "$cfg" 2>&1)" || { rm -f "$cfg" "$dest"; die "live catalogue read failed for $OMNIROUTE_MODELS_URL"; }
    rm -f "$cfg"
    code="${resp##*$'\n'}"; body="${resp%$'\n'*}"
    case "$code" in 2*) ;; *) rm -f "$dest"; die "live catalogue read returned $code from $OMNIROUTE_MODELS_URL: ${body:0:300}" ;; esac
    catalogue_parse_to_tsv <<<"$body" > "$dest" || { rm -f "$dest"; die "could not parse the /v1/models response"; }
    CATALOGUE_SOURCE="live:$OMNIROUTE_MODELS_URL"
  fi

  local n; n="$(wc -l < "$dest" | tr -d ' ')"
  [ "${n:-0}" -gt 0 ] || { rm -f "$dest"; die "model catalogue resolved to 0 entries from $CATALOGUE_SOURCE — refusing to validate against an empty catalogue"; }
  CATALOGUE_TSV="$dest"
  log "  catalogue: $n entries from $CATALOGUE_SOURCE"
  audit "catalogue_load" "ok" "$(jq -cn --arg s "$CATALOGUE_SOURCE" --argjson n "$n" '{source:$s,entries:$n}')"
}

catalogue_name_of() {   # id -> name on stdout; exit 1 if the id is not in the catalogue
  local want="$1"
  awk -F'\t' -v w="$want" '$1==w {print $2; found=1; exit} END{exit found?0:1}' "$CATALOGUE_TSV"
}

# ------------------------------------------------- BLENDED ROUTES: refused outright
# A blended route serves more than one underlying model behind a single id. Partial
# Claude exposure is still Claude exposure, and after the fact you cannot attribute
# which leg served a given request — so "is this Claude?" has no answer for it and the
# containment claim becomes unverifiable. Both known blends are refused: aug/prism-a
# because it carries Claude, aug/prism-b because unattributable traffic is not
# something this tool should be certifying either way.
#
# THIS GATE IS NOT OVERRIDABLE. !nonclaude clears a family-word false positive on a
# single-model route; it does not clear a blend. If a specific blended route ever
# needs to be permitted, that is a deliberate policy change with the owner, not a
# marker an operator can type on one line at 2am.
blend_reason() {   # name -> reason on stdout, exit 0 if it looks blended
  local lower; lower="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "$lower" in
    *blend*)    echo "catalogue name says 'blend'"; return 0 ;;
    *hybrid*)   echo "catalogue name says 'hybrid'"; return 0 ;;
    *ensemble*) echo "catalogue name says 'ensemble'"; return 0 ;;
    *mixture*)  echo "catalogue name says 'mixture'"; return 0 ;;
  esac
  # "X + Y" — the marker auggie uses: "Prism (Claude + Gemini)", "Prism (GPT + Kimi)".
  if printf '%s' "$lower" | grep -qE '[[:alnum:]][[:space:]]*\+[[:space:]]*[[:alnum:]]'; then
    echo "catalogue name '$1' names two models joined by '+'"; return 0
  fi
  return 1
}

gate_blended() {
  local id="$1" name reason
  name="$(catalogue_name_of "$id")" || return 0   # existence is gate_catalogue's job
  if reason="$(blend_reason "$name")"; then
    refuse "blended route: '$id' is \"$name\" ($reason). Blended routes are refused outright — traffic through them cannot be attributed to a single model afterwards, so the Claude containment claim cannot be verified. This refusal is NOT clearable with !nonclaude."
  fi
  return 0
}

# ------------------------------------------- EXISTENCE: an unknown id is a refusal
gate_catalogue() {
  local id="$1"
  catalogue_name_of "$id" >/dev/null \
    || refuse "model id '$id' is in the allowlist but is NOT in the live catalogue ($CATALOGUE_SOURCE). It has been withdrawn or renamed upstream. Writing it into a combo would create a member that resolves to nothing — or, after an upstream re-use of the name, to something nobody reviewed. Re-check the id and update $COMBO_ALLOWLIST_FILE."
}

# Runs the catalogue-dependent gates for one leaf id, honouring CATALOGUE_MODE.
gate_live() {
  local id="$1"
  case "$CATALOGUE_MODE" in
    off) return 0 ;;
    advisory|required) ;;
  esac
  gate_catalogue "$id"
  gate_blended  "$id"
}

# =============================================================== SCOPE-CONFINED HTTP
# Every request in this tool goes through api(). It refuses any path that is not a
# combo or model-combo-mapping route. This is the "and nothing else in OmniRoute"
# requirement enforced in one auditable place rather than by discipline.
readonly API_PATH_ALLOW='^/api/(combos|model-combo-mappings)(/[A-Za-z0-9._:-]+)?/?$'

# --------------------------------------------------------------- credential [RESOLVED-2]
# requireManagementAuth.ts accepts four credential types. This tool uses exactly one:
# #4, an API key carrying 'manage' or 'admin' scope, sent as Authorization: Bearer.
#
# There is no login call, no password read, and no cookie in this tool. The earlier
# revision guessed at a dashboard-session login and failed loudly rather than proceed;
# that guess was wrong and is deleted rather than kept as a fallback. Two ways to
# acquire management authority is two ways to get it wrong, and the one we would be
# keeping reads OMNIROUTE_MANAGEMENT_PASSWORD off disk — the exact credential this
# whole design exists to avoid handling.
MGMT_TOKEN=""
MGMT_CRED_CLASS=""

mgmt_auth() {
  MGMT_TOKEN="${OMNIROUTE_MANAGEMENT_KEY:-}"
  if [ -z "$MGMT_TOKEN" ] && [ -f "$OMNIROUTE_ENV_FILE" ]; then
    MGMT_TOKEN="$(grep -E '^[[:space:]]*(OMNIROUTE_MANAGEMENT_KEY|MANAGEMENT_API_KEY)=' "$OMNIROUTE_ENV_FILE" \
      | head -n1 | cut -d= -f2- | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
                                     -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//")" || true
  fi
  [ -n "$MGMT_TOKEN" ] || die "no management credential. Export OMNIROUTE_MANAGEMENT_KEY='<api key with manage or admin scope>', or put OMNIROUTE_MANAGEMENT_KEY=... in $OMNIROUTE_ENV_FILE. This tool uses requireManagementAuth credential type #4 (Authorization: Bearer) and deliberately supports no other."

  # Record the credential CLASS — never the value — so the log shows what authority
  # was used. An 'oma_' prefix is the scoped access token (type #3), which is narrower
  # than a manage-scope key and rides the same Bearer header. This tool will send it
  # unchanged, but nobody has read evaluateAccessTokenAuth yet: treat a run logged as
  # 'scoped-access-token' as UNVERIFIED rather than as an endorsement of that path.
  case "$MGMT_TOKEN" in
    oma_*) MGMT_CRED_CLASS="scoped-access-token"
           c_ylw "note: credential is an 'oma_' scoped access token (requireManagementAuth #3), not a manage-scope API key. That path is UNVERIFIED here — confirm what it grants before relying on it." ;;
    *)     MGMT_CRED_CLASS="manage-api-key" ;;
  esac
}

api() {
  local method="$1" path="$2" payload="${3:-}"
  [[ "$path" =~ $API_PATH_ALLOW ]] \
    || refuse "out-of-scope API path '$path'. This tool may only touch /api/combos and /api/model-combo-mappings."
  case "$method" in GET|POST|PUT|PATCH|DELETE) ;; *) refuse "out-of-scope HTTP method '$method'" ;; esac
  [ -n "$MGMT_TOKEN" ] || mgmt_auth

  # The credential is written to a 0600 temp file and fed to curl --config, NOT passed
  # on argv. /proc/*/cmdline is world-readable and every company on this box shares
  # this host, so an argv-borne key is readable by anything running here.
  local cfg resp code
  cfg="$(mktemp)"; chmod 0600 "$cfg"
  {
    printf 'url = "%s"\n' "${OMNIROUTE_BASE_URL}${path}"
    printf 'request = "%s"\n' "$method"
    printf 'header = "Authorization: Bearer %s"\n' "$MGMT_TOKEN"
    printf 'header = "Content-Type: application/json"\n'
    [ -n "$payload" ] && printf 'data = %s\n' "$(jq -Rn --arg b "$payload" '$b')"
    printf 'silent\nshow-error\nmax-time = %s\nwrite-out = "\\n%%{http_code}"\n' "$CURL_TIMEOUT"
  } > "$cfg"
  # The effective base URL is named IN the failure text, not left to be inferred.
  # A transport failure here is almost always a wrong OMNIROUTE_BASE_URL, and the
  # value in play is usually one an env file set several steps earlier — sourcing
  # a container-context env file on the host is the known way to land here, since
  # the 'omniroute' alias does not resolve off the container network and the API
  # port serves no management routes. Printing it turns a two-step diagnosis into
  # a zero-step one; check-endpoints cannot do it for you because it may have been
  # run BEFORE the env file was sourced.
  resp="$(curl --config "$cfg" 2>&1)" || { rm -f "$cfg"; die "curl failed for $method $path
  OMNIROUTE_BASE_URL is currently '${OMNIROUTE_BASE_URL}'
  If that is not what you expected, an env file has overridden it. This tool runs on
  the HOST: loopback (127.0.0.1) is correct here and container aliases are not.
  Re-run '$PROG check-endpoints' NOW — after whatever env you have sourced — to confirm."; }
  rm -f "$cfg"

  code="${resp##*$'\n'}"
  API_BODY="${resp%$'\n'*}"
  API_CODE="$code"

  # [RESOLVED-3] Route handlers return {error: string} with 400/500.
  # [RESOLVED-5] But that is not the only shape: probing the live instance on
  # 2026-08-23 showed the auth middleware on BOTH ports returns a nested
  # {error:{code,message,correlation_id}} on 401. Neither port is uniform, so both
  # shapes are parsed regardless of which URL was called.
  # correlation_id is the operator's handle into OmniRoute's own logs, so it is
  # surfaced rather than dropped: a failure you cannot look up is a failure twice.
  local err
  err="$(api_error_text <<<"$API_BODY")"

  # Every failure below names the base URL in play, for the same reason the transport
  # failure does: the value is usually inherited from an env file sourced earlier, and
  # a wrong one produces an error that looks like a credential or route problem.
  local at="  (OMNIROUTE_BASE_URL is currently '${OMNIROUTE_BASE_URL}')"
  case "$code" in
    2*) return 0 ;;
    404) die "OmniRoute returned 404 for $method $path.
${at}
  If the body below says 'API port only serves OpenAI-compatible routes', that URL is
  the OpenAI port and management routes live on the other one — run '$PROG check-endpoints'.
  Server said: ${err}" ;;
    401|403) die "management auth rejected ($code) for $method $path.
${at}
  The credential is not accepted by requireManagementAuth, or it lacks 'manage'/'admin'
  scope. If the URL above is unexpected, fix that before suspecting the key.
  Server said: ${err}" ;;
    *) die "OmniRoute returned $code for $method $path.
${at}
  Server said: ${err}" ;;
  esac
}

# Extract a human-usable error string from EITHER OmniRoute error envelope without
# assuming which port answered. Falls back to the raw body, so an unrecognised shape
# is still shown rather than swallowed into an empty message.
api_error_text() {
  local body err
  body="$(cat)"
  err="$(jq -r '
      if type=="object" then
        if (.error|type)=="string" then
          # The wrong-port 404 is {error:"not_found", message:"API port only serves
          # OpenAI-compatible routes."} — the diagnostic worth reading is in .message,
          # so dropping it in favour of the terse .error loses the whole point.
          .error + (if (.message // "") != "" then ": " + .message else "" end)
        elif (.error|type)=="object" then
          ([(.error.code // empty), (.error.message // empty)]
             | map(select(. != "")) | join(": "))
          + (if (.error.correlation_id // "") != ""
             then " [correlation_id=" + .error.correlation_id + "]" else "" end)
        else empty end
      else empty end' <<<"$body" 2>/dev/null || true)"
  [ -n "$err" ] && [ "$err" != "null" ] || err="${body:0:400}"
  printf '%s' "$err"
}

# ================================================================ BACKUP AND VERIFY
# A SQLite .backup(), NOT cp: OmniRoute is live and in WAL mode, and a cp of the main
# database file alone silently omits everything still in the -wal. Demonstrated, not
# assumed — 5 committed rows, cp taken while the WAL was hot:
#     cp of main file only  -> 4 rows
#     integrity_check on it -> ok          <-- says the truncated copy is FINE
#     live truth            -> 5 rows
# A restore from that backup loses a committed row and nothing warns you. Same
# silent-success class as the two holes below. Never cp; always .backup().
#
# v0.2.3 — THERE IS NO sqlite3 BINARY on the operator's host or inside the omniroute
# container (operator-verified 2026-08-23). Every call below used to shell out to it,
# so backup_and_verify could not run at all on the only box it was ever meant to run
# on — and it failed at the exact moment before a mutation. Python's stdlib sqlite3 is
# present on both, so the engine is now pluggable and prefers Python. If NEITHER engine
# exists the tool refuses to mutate: a missing engine must never degrade into
# "proceed without a backup", because this is the tool's only undo (ROLLBACK.md).
#
# v0.2.2 — this verification could PASS ON AN EMPTY BACKUP. Two independent holes:
#   1. PRAGMA integrity_check returns 'ok' for a ZERO-BYTE file, because a zero-byte
#      file is a valid empty SQLite database. integrity_check therefore proves the
#      backup is not corrupt; it proves nothing about whether it captured any data.
#   2. the row-count comparison read both sides with `2>/dev/null || echo NA`, so when
#      the counts could not be read the check compared the string NA against the string
#      NA, found them equal, and reported 'row-counts match'. Two error markers were
#      being compared to each other. The table names were an unchecked assumption at
#      the time, which made that the likely path. They have since been confirmed
#      correct — but the hole was real regardless of which way that fact landed.
# Together they printed 'backup verified' over a backup holding none of the data it
# exists to protect, and then mutated. This is the tool's only undo, and the failure is
# invisible until a restore is attempted — i.e. during an incident.
# The three helpers below are pure so the offline selftest can reach them: this code
# runs only on the operator's box behind sqlite3, and an untested guard is the one that
# will not work.

# [RESOLVED-7] Operator-confirmed against the real storage.sqlite (2026-08-23): both
# names exist exactly as spelled, in a schema of 118 tables. Live counts at that time
# were combos=3, model_combo_mappings=0. Still overridable, but no longer an assumption.
#
# ⚠ Four neighbours are close enough to catch by accident and are NOT the combo tables:
#     compression_combos  compression_combo_assignments
#     combo_adaptation_state  agent_bridge_mappings
# Every name comparison in this tool is exact (grep -Fxq / SQL on a literal name). Do
# not "improve" any of it into a glob or a LIKE — a glob here selects the wrong table
# and the row-count check would then verify a table nobody is mutating.
: "${COMBO_DB_TABLES:=combos model_combo_mappings}"

# ------------------------------------------------------- portable sqlite engine
# Preference order is deliberate: python3 FIRST, because the operator's box has the
# stdlib module and no binary. The binary branch is a fallback for a box with the
# reverse, not the primary path.
SQLITE_ENGINE=""
detect_sqlite_engine() {
  [ -n "$SQLITE_ENGINE" ] && return 0
  if command -v python3 >/dev/null 2>&1 && python3 -c 'import sqlite3' >/dev/null 2>&1; then
    SQLITE_ENGINE=python; return 0
  fi
  if command -v sqlite3 >/dev/null 2>&1; then SQLITE_ENGINE=binary; return 0; fi
  return 1
}
need_sqlite_engine() {
  detect_sqlite_engine || die "no usable SQLite engine on this box.
Need EITHER python3 with the stdlib sqlite3 module, OR the sqlite3 binary. Neither found.
The backup step cannot be skipped: it is this tool's only undo (ROLLBACK.md), so a
missing engine is a refusal to mutate, not a warning. Install python3 and re-run."
}

# Paths travel as argv, never interpolated into SQL or a dot-command, so a path
# containing a quote is a non-event on the python engine.
readonly PY_SQLITE_HELPER='
import os, sqlite3, sys
from urllib.request import pathname2url
def ro(p):
    return sqlite3.connect("file:" + pathname2url(os.path.abspath(p)) + "?mode=ro", uri=True)
op = sys.argv[1]
if op == "tables":
    c = ro(sys.argv[2])
    for (n,) in c.execute(
        "SELECT name FROM sqlite_master WHERE type=(?) ORDER BY name", ("table",)):
        print(n)
elif op == "count":
    # Identifier cannot be bound; quote it and double any embedded quote.
    t = sys.argv[3].replace(chr(34), chr(34) * 2)
    print(ro(sys.argv[2]).execute("SELECT COUNT(*) FROM " + chr(34) + t + chr(34)).fetchone()[0])
elif op == "integrity":
    print(ro(sys.argv[2]).execute("PRAGMA integrity_check").fetchone()[0])
elif op == "backup":
    src, dest = ro(sys.argv[2]), sqlite3.connect(sys.argv[3])
    src.backup(dest)          # atomic and WAL-safe; does not lock the live database
    dest.close(); src.close()
else:
    sys.exit("unknown op " + op)
'

db_tables() {   # <db>
  case "$SQLITE_ENGINE" in
    python) python3 -c "$PY_SQLITE_HELPER" tables "$1" ;;
    binary) sqlite3 "$1" "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;" ;;
    *) die "db_tables called before detect_sqlite_engine" ;;
  esac
}
db_count() {    # <db> <table>
  case "$SQLITE_ENGINE" in
    python) python3 -c "$PY_SQLITE_HELPER" count "$1" "$2" ;;
    binary) sqlite3 "$1" "SELECT COUNT(*) FROM \"${2//\"/\"\"}\";" ;;
    *) die "db_count called before detect_sqlite_engine" ;;
  esac
}
db_integrity() { # <db>
  case "$SQLITE_ENGINE" in
    python) python3 -c "$PY_SQLITE_HELPER" integrity "$1" ;;
    binary) sqlite3 "$1" 'PRAGMA integrity_check;' ;;
    *) die "db_integrity called before detect_sqlite_engine" ;;
  esac
}
db_backup() {   # <src> <dest>
  case "$SQLITE_ENGINE" in
    python) python3 -c "$PY_SQLITE_HELPER" backup "$1" "$2" ;;
    binary)
      # Only the dot-command interpolates the path, so only this branch needs the check.
      case "$2" in *"'"*)
        die "backup path contains a single quote, which would break the sqlite3 .backup dot-command: $2" ;;
      esac
      sqlite3 "$1" ".backup '${2}'" ;;
    *) die "db_backup called before detect_sqlite_engine" ;;
  esac
}

# sha256sum is coreutils and normally present, but it is a hard dependency at exactly
# the same moment as the engine, so it gets the same fail-closed treatment.
need_sha256() {
  command -v sha256sum >/dev/null 2>&1 && return 0
  detect_sqlite_engine && [ "$SQLITE_ENGINE" = python ] && return 0
  die "no way to checksum the backup: need sha256sum or python3. Refusing to mutate."
}
file_sha256() { # <file>
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$1"
  fi
}

# Verifies the ARTIFACT, not the exit status. rc 2 = missing/empty, rc 3 = not SQLite.
# Deliberately does not shell out to sqlite3 so the selftest can run it anywhere.
sqlite_file_ok() {
  local f="$1" sz hdr
  [ -f "$f" ] || return 2
  sz="$(wc -c < "$f" 2>/dev/null || echo 0)"
  [ "$sz" -gt 0 ] 2>/dev/null || return 2
  hdr="$(head -c 15 "$f" 2>/dev/null || true)"
  [ "$hdr" = "SQLite format 3" ] || return 3
  return 0
}

# rc 2 = a side was unreadable (the old NA), rc 3 = a genuine mismatch. An unreadable
# count is never equal to anything, including another unreadable count.
assert_row_count() {
  local src="$1" dst="$2" n
  for n in "$src" "$dst"; do
    case "$n" in ''|*[!0-9]*) return 2 ;; esac
  done
  [ "$src" = "$dst" ] || return 3
  return 0
}

# Pure: takes the newline-separated table list already read from sqlite_master.
tables_missing_from() {
  local have="$1"; shift
  local want miss=""
  for want in "$@"; do
    printf '%s\n' "$have" | grep -Fxq -- "$want" || miss="${miss}${miss:+ }${want}"
  done
  printf '%s' "$miss"
}

backup_and_verify() {
  local label="$1"
  need_sqlite_engine
  [ -f "$OMNIROUTE_SQLITE" ] || die "storage.sqlite not found at $OMNIROUTE_SQLITE (set OMNIROUTE_SQLITE)"
  mkdir -p "$COMBO_BACKUP_DIR" || die "cannot create backup dir $COMBO_BACKUP_DIR"
  # This backup is a byte-for-byte copy of the database holding OmniRoute's PROVIDER
  # CREDENTIALS. Its directory permissions are not a best-effort concern.
  chmod 0700 "$COMBO_BACKUP_DIR" \
    || die "cannot chmod 0700 $COMBO_BACKUP_DIR; refusing to write a credential-bearing backup into a directory I cannot restrict"

  # Confirm the tables we are about to count actually exist under the names we assume.
  # This is what turns hole 2 above from a silent no-op into a precise question.
  local src_tables miss
  src_tables="$(db_tables "$OMNIROUTE_SQLITE" 2>&1)" \
    || die "cannot read the table list from $OMNIROUTE_SQLITE (engine=$SQLITE_ENGINE): $src_tables"
  miss="$(tables_missing_from "$src_tables" $COMBO_DB_TABLES)"
  [ -z "$miss" ] || die "table(s) not present in $OMNIROUTE_SQLITE: $miss
This tool assumed those names and has never run against a real storage.sqlite.
Tables actually present:
$(printf '%s\n' "$src_tables" | sed 's/^/  /')
Set COMBO_DB_TABLES to the correct names and re-run. Refusing to mutate: a backup
whose row counts cannot be checked is not a verified backup."

  local stamp dest
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  dest="${COMBO_BACKUP_DIR}/storage.${stamp}.${label}.sqlite"
  local berr
  berr="$(db_backup "$OMNIROUTE_SQLITE" "$dest" 2>&1)" \
    || die "sqlite backup failed (engine=$SQLITE_ENGINE): ${berr:-no output}; refusing to mutate"
  chmod 0600 "$dest" \
    || die "cannot chmod 0600 $dest; refusing to leave a credential-bearing backup readable"

  # Artifact before exit status: do not trust that sqlite3 returning 0 wrote anything.
  local frc=0; sqlite_file_ok "$dest" || frc=$?
  case "$frc" in
    2) die "backup at $dest is missing or empty even though the $SQLITE_ENGINE engine reported success; refusing to mutate" ;;
    3) die "backup at $dest is not a SQLite database (bad header); refusing to mutate" ;;
  esac

  local ic; ic="$(db_integrity "$dest" 2>&1 || true)"
  [ "$ic" = "ok" ] || die "backup integrity_check failed ($ic); refusing to mutate"

  local t src_n dst_n rc
  for t in $COMBO_DB_TABLES; do
    # stderr is CAPTURED, not discarded: the sqlite error text is the diagnosis.
    src_n="$(db_count "$OMNIROUTE_SQLITE" "$t" 2>&1 || true)"
    dst_n="$(db_count "$dest"             "$t" 2>&1 || true)"
    rc=0; assert_row_count "$src_n" "$dst_n" || rc=$?
    case "$rc" in
      2) die "could not read a row count for ${t} (source=[${src_n}] backup=[${dst_n}]); refusing to mutate — an unverifiable backup is not a backup" ;;
      3) die "backup row-count mismatch on ${t} (source=${src_n} backup=${dst_n}); refusing to mutate" ;;
    esac
    log "  ${t}: ${src_n} rows in source and backup"
  done

  local sum; sum="$(file_sha256 "$dest")"
  BACKUP_PATH="$dest"; BACKUP_SHA="$sum"
  c_grn "backup verified: $dest"
  log   "  sha256=$sum  integrity_check=ok  row-counts match  engine=$SQLITE_ENGINE"
  audit "backup" "verified" "$(jq -cn --arg p "$dest" --arg s "$sum" '{path:$p,sha256:$s}')"
}

# ================================================================= SPEC VALIDATION
validate_strategy() {
  local s="$1" v a
  for a in "${STRATEGY_ALIASES[@]}"; do
    if [ "${a%%=*}" = "$s" ]; then
      refuse "strategy '$s' is an alias that OmniRoute rewrites to '${a##*=}'. Write the canonical name '${a##*=}' so that what you asked for and what is stored are the same string."
    fi
  done
  [ "$s" = "quota-share" ] && refuse "strategy 'quota-share' is INTERNAL-only (auto-minted qtSd/ combos). It cannot be selected."
  for v in "${VALID_STRATEGIES[@]}"; do [ "$v" = "$s" ] && return 0; done
  refuse "unknown routing strategy '$s'. OmniRoute's normalizeRoutingStrategy() would SILENTLY coerce this to 'priority' and report success — this CLI rejects it instead. Valid: ${VALID_STRATEGIES[*]}"
}

assert_mutable_combo_name() {
  local name="$1" g
  for g in "${PROTECTED_COMBO_GLOBS[@]}"; do
    if glob_match "$g" "$name"; then
      refuse "combo '$name' matches protected pattern '$g'. 19 agent bindings across other companies on this instance route through these; this tool must never mutate them. There is no override flag and there should not be one."
    fi
  done
  case "$name" in
    "${COMBO_OWNED_PREFIX}"*) : ;;
    *) refuse "combo '$name' is outside our owned namespace '${COMBO_OWNED_PREFIX}'. Deny-by-default applies to combo names too: name it '${COMBO_OWNED_PREFIX}<something>' or change COMBO_OWNED_PREFIX deliberately." ;;
  esac
}

# ---------------------------------------------------------------- combo resolution
# [RESOLVED-4] LOAD-BEARING. This is not a belt-and-braces duplicate of a server check
# and it must not be removed as one.
#
# OmniRoute SUPPORTS nested combos as a first-class feature. POST /api/combos runs
# validateComboDAG(), which checks circular references and max depth — and nothing
# else. It will happily accept a combo whose member is another combo. The auto/*
# family is already 38 such server-side combos, which this tool's management
# credential cannot even enumerate.
#
# So a nested member is an indirection we cannot see the far end of: a member of
# auto/claude-opus reaches Claude, the membership lives server-side, and it can be
# repointed AFTER any review this tool performs. Refusing nested members rather than
# following them is the only thing holding that door shut, and it compensates for a
# server-side permission we do not hold rather than duplicating a server-side
# restriction that does not exist.
#
# There is deliberately NO override flag. Do not add one. Name leaf model ids.
resolve_members() {   # stdin: JSON array of member ids -> stdout: leaf ids, one per line
  local ids id
  ids="$(jq -r '.[]')"
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    case "$id" in
      auto/*|combo/*|qtSd/*|hindsight/*)
        refuse "member '$id' is combo-backed. OmniRoute permits nested combos (validateComboDAG only checks cycles and depth), so this would be accepted server-side — but its membership lives server-side, cannot be enumerated with this credential, and can be repointed onto Claude after any review this tool performs. Name the concrete leaf model ids instead. There is no override for this." ;;
    esac
    printf '%s\n' "$id"
  done <<< "$ids"
}

# spec schema (agent proposal, produced via org_request_queue.sh):
# { "name":"two/go-rotation", "strategy":"fill-first", "description":"...",
#   "models":[ {"kind":"model","model":"ocgo/glm-5","providerId":"opencode-go",
#               "connectionId":"<uuid>"        # OPTIONAL, see below
#              }, ... ] }
#
# connectionId is optional and pins a leg to one specific provider connection. Supply
# it when providerId is ambiguous — there are now two 'opencode-go' connections, so
# providerId alone does not say which upstream serves the leg. Omit it and the server
# chooses; 'apply' will report what it chose rather than assert on it.
#
# NOT SETTABLE HERE — context_cache_protection. The column exists on the combos table
# and the feature exists in OmniRoute's code, but the field is absent from the
# management API payload entirely (confirmed 2026-08-23 with a master key: a combo
# object returns computed_context_length, config, createdAt, description, id,
# isHidden, models, name, sortOrder, strategy, updatedAt, version — and nothing else).
# It is therefore unreachable through the only surface this tool is permitted to use.
# If it ever needs to be set, that is a direct-database change under ROLLBACK.md, by
# the operator, and deliberately outside this tool's scope.
validate_spec() {
  local spec="$1"
  jq -e . >/dev/null 2>&1 <<<"$spec" || die "spec is not valid JSON"

  local unknown
  unknown="$(jq -r 'keys[] | select(. as $k | ["name","strategy","description","models","capabilities"] | index($k) | not)' <<<"$spec")"
  [ -z "$unknown" ] || refuse "spec has unrecognised top-level keys: $(tr '\n' ' ' <<<"$unknown"). This tool applies only what it validates."

  local name strategy nmodels
  name="$(jq -r '.name // empty' <<<"$spec")"
  strategy="$(jq -r '.strategy // empty' <<<"$spec")"
  nmodels="$(jq -r '.models | length' <<<"$spec" 2>/dev/null || echo 0)"

  [ -n "$name" ] || refuse "spec.name is required"
  [[ "$name" =~ ^[A-Za-z0-9._/-]{1,120}$ ]] || refuse "spec.name '$name' has characters outside [A-Za-z0-9._/-] or is too long"
  [ -n "$strategy" ] || refuse "spec.strategy is required (no default — an implicit default here becomes a silent 'priority')"
  [ "$nmodels" -ge 1 ] || refuse "spec.models must have at least one member"

  assert_mutable_combo_name "$name"
  validate_strategy "$strategy"

  local badstep
  badstep="$(jq -r '.models[] | select((.model // "") == "" or (.providerId // "") == "") | @json' <<<"$spec")"
  [ -z "$badstep" ] || refuse "every member needs a non-empty .model and .providerId; offending: $badstep"

  # connectionId — CORRECTED 2026-08-23, and the correction matters for what this
  # tool can express.
  #
  # This previously refused any member carrying 'connectionId', citing TOG-176. That
  # citation was wrong in scope: TOG-176 observed connectionId's absence from the
  # READ surface (/v1/combos). The operator has since queried the MANAGEMENT API with
  # a master key and connectionId IS present on every leg (e.g. the hindsight combos
  # each carry "connectionId":"85535839-..."). So it is a real field of the step
  # object, not a foreign one, and blanket-refusing it created two problems:
  #
  #   1. Round-trip trap. An operator who copies a live combo's models array out of
  #      'list' and feeds it back to 'apply' was REFUSED for carrying a field the
  #      server itself emitted.
  #   2. It made a legitimate binding inexpressible. providerId alone no longer
  #      identifies a connection: there are now TWO 'opencode-go' connections on this
  #      instance. If connectionId is what distinguishes them, a tool that forbids it
  #      cannot pin a leg to a specific one — which is exactly what TOG-152's
  #      rotation bake-off needs.
  #
  # So it is now ACCEPTED and VALIDATED rather than refused. It is still not passed
  # through unchecked: it must be UUID-shaped, because it goes onto the wire.
  local badconn
  badconn="$(jq -r '.models[] | select(has("connectionId")) | select((.connectionId|type) != "string" or ((.connectionId|test("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")) | not)) | @json' <<<"$spec")"
  [ -z "$badconn" ] || refuse "member .connectionId must be a UUID string; offending: $badconn"

  # NOT VERIFIED, and the operator should know which way the uncertainty runs: no
  # mutation path of this tool has ever run against a live server, so whether PUT
  # /api/combos accepts connectionId, and what the server does with a leg that omits
  # it, are both unconfirmed. The drop-guard in cmd_apply is written to fail closed
  # on that uncertainty rather than to assume either answer.

  # --- containment: resolve first, then gate every leaf ---------------------------
  # NOTE: resolution is captured with an EXPLICIT status check rather than piped from
  # a process substitution. A `refuse` inside `< <(...)` only kills the subshell; the
  # parent loop then sees empty input and reports success. That is the same
  # silent-success failure this tool exists to prevent, so it is checked, not assumed.
  local leaf leaves rc=0
  log "containment check (${nmodels} declared members):"
  leaves="$(jq -c '[.models[].model]' <<<"$spec" | resolve_members)" || rc=$?
  [ "$rc" -eq 0 ] || exit "$rc"
  [ -n "$leaves" ] || refuse "member resolution produced no model ids; refusing to treat an empty member set as valid"

  # The catalogue is resolved ONCE per run, and only for the modes that need it.
  # 'validate' stays fully offline on purpose so any reviewer can run it anywhere.
  [ "$CATALOGUE_MODE" = "off" ] || catalogue_load

  while IFS= read -r leaf; do
    [ -n "$leaf" ] || continue
    gate_allowlist "$leaf"
    gate_claude_tripwire "$leaf"
    gate_live "$leaf"
    log "  ok  $leaf"
  done <<< "$leaves"
  if [ "$CATALOGUE_MODE" = "off" ]; then
    c_grn "containment: all members allowlisted and clear of the Claude tripwire"
    c_ylw "  NOT CHECKED offline: whether each id still exists upstream, and whether any is a blended route. 'dry-run' and 'apply' check both against the live catalogue."
  else
    c_grn "containment: all members allowlisted, clear of the Claude tripwire, present in the live catalogue and not blended"
  fi
}

# ---------------------------------------------------------- connection bindings
# One definition of "what connection is this leg pinned to", used by the drop-guard,
# by apply's requested-binding capture and by the read-back comparison. Kept as a
# single function on purpose: three copies of this jq expression would be three
# chances for the guard and the assertion to disagree about what a binding is, and a
# guard that disagrees with its own verifier is worse than neither.
# Input: a combo or spec object on stdin/arg. Output: sorted [{model,connectionId}].
bindings_of() {
  jq -c '[(.models // [])[]? | select((.connectionId // "") != "") | {model,connectionId}] | sort' <<<"$1"
}

# The same bindings, but keeping the leg's position in the members array.
#
# bindings_of() SORTS, which makes it blind to a change in *which leg* holds a binding
# whenever two legs carry the same model id — and that is not a corner case here: the
# bake-off spec is two legs of 'ocgo/glm-5' across the two live opencode-go connections.
# Under bindings_of, [legA=connA, legB=connB] and [legA=connB, legB=connA] compare EQUAL.
# For priority / fill-first / context-relay / pipeline the list order IS the routing
# order, so that swap changes which upstream serves first while the guard sees no change.
# A normalisation in the comparison had quietly discarded the field carrying the meaning.
# 'leg' is the index in the ORIGINAL models array, not in the filtered list, so an
# unbound leg between two bound ones does not shift the positions of the others.
# The member-comparison verdict, as a pure function, so the offline selftest exercises
# the SAME code the live read-back does. Inline in read_back_assert it could only be
# reached through a live server, and a re-implementation in the test would be a test of
# the copy rather than of the thing that runs.
# Echoes exactly one of: match | order | accepted | members
member_verdict() {
  local sent="$1" stored="$2" allow="${3:-0}"
  if [ "$(jq -c 'sort' <<<"$sent")" != "$(jq -c 'sort' <<<"$stored")" ]; then echo members; return; fi
  if [ "$sent" = "$stored" ]; then echo match; return; fi
  if [ "$allow" = "1" ]; then echo accepted; else echo order; fi
}

bindings_ordered() {
  jq -c '[(.models // []) | to_entries[]?
          | select((.value.connectionId // "") != "")
          | {leg: .key, model: .value.model, connectionId: .value.connectionId}]' <<<"$1"
}

# Refuses an update that would change or drop an existing leg's connection binding.
# Extracted from cmd_apply so the selftest can exercise it directly — inline in the
# apply path it would only ever run against a live server, which is precisely how an
# untested safety check ends up being the one that does not work.
# Returns 0 to proceed, exits 3 (refuse) to stop. $3 = allow-rebind flag.
connection_rebind_check() {
  local previous="$1" spec="$2" allow="${3:-0}"
  local prev_bound spec_bound
  prev_bound="$(bindings_of "$previous")"
  spec_bound="$(bindings_of "$spec")"
  [ "$prev_bound" = "[]" ] && return 0
  if [ "$prev_bound" = "$spec_bound" ]; then
    # Same SET of bindings. Same positions? Only bindings_ordered can answer that, and
    # this is the branch where the old code returned 0 unconditionally.
    local prev_ord spec_ord
    prev_ord="$(bindings_ordered "$previous")"
    spec_ord="$(bindings_ordered "$spec")"
    [ "$prev_ord" = "$spec_ord" ] && return 0
    if [ "$allow" != "1" ]; then
      c_red "The stored combo binds the same connections, but this spec moves them to different legs."
      c_red "  currently stored: $prev_ord"
      c_red "  this spec sends : $spec_ord"
      refuse "refusing to silently reorder connection bindings. Leg order is the routing order for priority/fill-first/context-relay/pipeline, so this changes which connection serves first. Re-run with --allow-rebind if the reorder IS the intent. Nothing has been written."
    fi
    c_ylw "--allow-rebind: proceeding with a connection-binding REORDER (was: $prev_ord)"
    return 0
  fi
  if [ "$allow" != "1" ]; then
    c_red "The stored combo has explicit connection bindings that this spec would change or drop."
    c_red "  currently stored: $prev_bound"
    c_red "  this spec sends : $spec_bound"
    refuse "refusing to silently rebind. Either copy the connectionId values above into the matching spec members to preserve them, or re-run with --allow-rebind if changing the connection IS the intent. Nothing has been written."
  fi
  c_ylw "--allow-rebind: proceeding with a connection-binding change (was: $prev_bound)"
  return 0
}

# One definition of "what this mapping IS", for the same reason bindings_of exists:
# the pre-write duplicate check, the request capture and the read-back must not be
# three separately-drifting opinions. Everything is compared as a string because the
# API has returned priority as both a number and a numeric string.
mapping_fields_of() {
  jq -cS '{pattern: (.pattern // ""),
           comboId: ((.comboId // "") | tostring),
           priority: ((.priority // 0) | tostring),
           enabled: (.enabled != false)}' <<<"$1"
}

# Which mapping row did this write actually create?
#
# The previous implementation asked "does a mapping with this pattern exist?" after the
# POST. That question cannot distinguish a successful create from a mapping that was
# already there before we ran — and duplicate patterns are entirely possible, since a
# glob may legitimately appear at more than one priority. So a POST that returned 200
# and persisted nothing would read back as verified.
#
# Identify by the id the server returned; if it returned none, by set difference
# against the ids seen before the write. Ambiguity is reported, never guessed at.
# Pure function, no network: $3 is the post-write mapping array.
identify_new_mapping() {
  local mid="$1" before_ids="$2" after="$3" row n
  if [ -n "$mid" ]; then
    row="$(jq -c --arg i "$mid" 'map(select((.id|tostring)==$i))[0] // null' <<<"$after")"
    [ "$row" != "null" ] || return 2
    printf '%s\n' "$row"; return 0
  fi
  local new_ids
  new_ids="$(jq -c --argjson b "$before_ids" '[.[] | .id | tostring] - $b' <<<"$after")"
  n="$(jq -r 'length' <<<"$new_ids")"
  case "$n" in
    1) jq -c --argjson v "$new_ids" 'map(select((.id|tostring)==$v[0]))[0]' <<<"$after"; return 0 ;;
    0) return 2 ;;
    *) printf '%s\n' "$new_ids"; return 3 ;;
  esac
}

validate_mapping_spec() {
  local spec="$1"
  jq -e . >/dev/null 2>&1 <<<"$spec" || die "mapping spec is not valid JSON"
  local pattern comboId priority
  pattern="$(jq -r '.pattern // empty' <<<"$spec")"
  comboId="$(jq -r '.comboId  // empty' <<<"$spec")"
  priority="$(jq -r '.priority // empty' <<<"$spec")"

  [ -n "$pattern" ] || refuse "mapping.pattern is required"
  [ "${#pattern}" -le 500 ] || refuse "mapping.pattern exceeds 500 chars"
  [ -n "$comboId" ] || refuse "mapping.comboId is required"
  [ -n "$priority" ] || refuse "mapping.priority is required. The schema defaults it to 0, but ties break on creation order — which is invisible and silently reorders if mappings are ever recreated (TOG-152). Set it explicitly."
  [[ "$priority" =~ ^-?[0-9]+$ ]] || refuse "mapping.priority must be an integer"

  # Mapping breadth is a Claude-containment control, not a routing convenience:
  # resolution is first-match-wins over globs, so one over-broad high-priority pattern
  # captures everything including Claude ids.
  case "$pattern" in
    '*'|'**'|'*/*') refuse "mapping.pattern '$pattern' is a catch-all. First-match-wins means it would capture Claude model ids too and reroute them off teamclaude. Narrow it." ;;
  esac
  local r
  if r="$(claude_suspicion_reason "$pattern")"; then
    refuse "mapping.pattern '$pattern' targets what looks like Claude traffic ($r). Claude routing is set on teamclaude, not remapped here."
  fi
  c_grn "mapping spec valid: pattern='$pattern' -> combo=$comboId priority=$priority"
}

# ============================================================== READ-BACK ASSERTION
# The whole point: normalizeRoutingStrategy() coerces silently, so "the write returned
# 200" proves nothing. We re-read and compare what was actually persisted.
read_back_assert() {
  local combo_id="$1" want_name="$2" want_strategy="$3" want_models_json="$4"
  local want_bindings="${5:-[]}" want_bindings_ord="${6:-[]}"
  api GET "/api/combos/${combo_id}"
  local got got_name got_strategy got_models got_bindings
  got="$(json_unwrap <<<"$API_BODY")" || die "could not parse read-back response [OPEN-3]"
  got_name="$(jq -r '.name // empty' <<<"$got")"
  got_strategy="$(jq -r '.strategy // empty' <<<"$got")"
  # NOT sorted: order is asserted separately below. Sorting here was the bug.
  got_models="$(jq -c '[.models[]? | .model]' <<<"$got")"
  got_bindings="$(bindings_of "$got")"

  local ok=1
  [ "$got_name" = "$want_name" ] || { c_red "  read-back MISMATCH name: wanted '$want_name' got '$got_name'"; ok=0; }
  if [ "$got_strategy" != "$want_strategy" ]; then
    c_red "  read-back MISMATCH strategy: wanted '$want_strategy' but OmniRoute persisted '$got_strategy'"
    [ "$got_strategy" = "priority" ] && c_red "  -> this is normalizeRoutingStrategy() silently coercing an unrecognised strategy. The combo is NOT what was requested."
    ok=0
  fi
  # Membership and ORDER are two separate claims and get two separate verdicts. Folding
  # them together by sorting both sides meant an order change could only ever report as
  # a match: the comparison normalised away the thing it was meant to detect.
  case "$(member_verdict "$want_models_json" "$got_models" "$COMBO_ALLOW_REORDER")" in
    match) ;;
    accepted)
      c_ylw "  --allow-reorder: same members, stored in a different order than sent"
      c_ylw "     sent:   $want_models_json"
      c_ylw "     stored: $got_models" ;;
    order)
      c_red "  read-back MISMATCH member ORDER: sent $want_models_json but stored $got_models"
      c_red "  -> the same members in a different order. For priority/fill-first/context-relay/"
      c_red "     pipeline the list order IS the routing order, so this is a live traffic"
      c_red "     difference, not a cosmetic one."
      c_red "  -> Nothing is corrupt and the combo does exist. If OmniRoute simply does not"
      c_red "     preserve member order, re-run with --allow-reorder to accept it knowingly."
      ok=0 ;;
    members)
      c_red "  read-back MISMATCH members: wanted $(jq -c 'sort' <<<"$want_models_json") got $(jq -c 'sort' <<<"$got_models")"
      ok=0 ;;
  esac

  # Connection bindings. Asserted only where the spec actually asked for one — the
  # server may legitimately assign a connectionId we did not request, and failing on
  # that would be asserting a claim we never made. Where we DID ask, a divergence is
  # a real mismatch: it means the leg is bound to a different connection than the one
  # that was reviewed. This is the check whose absence would have let a dropped
  # binding read as success.
  if [ "$want_bindings" != "[]" ]; then
    if [ "$got_bindings" != "$want_bindings" ]; then
      c_red "  read-back MISMATCH connection bindings: wanted $want_bindings got $got_bindings"
      c_red "  -> a leg is bound to a different connection than the spec specified. With more than"
      c_red "     one connection per providerId, this changes which upstream actually serves traffic."
      ok=0
    elif [ "$want_bindings_ord" != "[]" ] && [ "$(bindings_ordered "$got")" != "$want_bindings_ord" ]; then
      # Same connections, different legs. Invisible to the sorted comparison above
      # whenever two legs share a model id — which is the shape of the bake-off spec.
      c_red "  read-back MISMATCH connection binding ORDER:"
      c_red "     sent:   $want_bindings_ord"
      c_red "     stored: $(bindings_ordered "$got")"
      c_red "  -> the right connections are bound, but to different legs than the spec asked for,"
      c_red "     which changes which one serves first under an order-sensitive strategy."
      ok=0
    fi
  elif [ "$got_bindings" != "[]" ]; then
    c_ylw "  note: the server assigned connection bindings this spec did not request: $got_bindings"
    c_ylw "  Not an error. Copy them into the spec if you want future updates to preserve them."
  fi

  if [ "$ok" -eq 0 ]; then
    audit "read_back" "mismatch" "$(jq -cn --arg id "$combo_id" --arg w "$want_strategy" --arg g "$got_strategy" '{combo:$id,wanted_strategy:$w,persisted_strategy:$g}')"
    c_red "The write was accepted but the stored combo differs from what was requested."
    c_red "Backup for rollback: ${BACKUP_PATH:-<none taken>}"
    exit 4
  fi
  c_grn "read-back verified: name, strategy and members match what was requested"
  audit "read_back" "verified" "$(jq -cn --arg id "$combo_id" --arg s "$want_strategy" '{combo:$id,strategy:$s}')"
}

# Read-back for a created mapping. The combo path has had this since the beginning;
# the mapping path asserted only that *a* row with the pattern existed, which is not
# the same claim. Priority is the field that most needs asserting: resolution is
# priority DESC, created_at ASC, first-match-wins, so a coerced or defaulted priority
# silently reorders routing while the pattern still looks exactly as reviewed.
map_read_back_assert() {
  local mid="$1" before_ids="$2" want_payload="$3"
  api GET "/api/model-combo-mappings"
  local after; after="$(json_list_strict "mappings")" || exit 3

  local row rc=0
  row="$(identify_new_mapping "$mid" "$before_ids" "$after")" || rc=$?
  case "$rc" in
    0) ;;
    2) die "POST returned 200 but the mapping is not present on read-back${mid:+ (server said id '$mid')}.
  The write was accepted and did not persist. Nothing to roll back, but do not assume
  the mapping exists. Backup: ${BACKUP_PATH:-<none>}" ;;
    3) die "POST returned 200 but more than one new mapping appeared: ${row}
  This write cannot be attributed to a single row. Inspect with '$PROG map-list' before
  doing anything else. Backup: ${BACKUP_PATH:-<none>}" ;;
  esac

  local want got
  want="$(mapping_fields_of "$want_payload")"
  got="$(mapping_fields_of "$row")"
  if [ "$want" != "$got" ]; then
    c_red "  read-back MISMATCH mapping fields:"
    c_red "    wanted $want"
    c_red "    got    $got"
    c_red "  -> the row was created but is not the mapping that was requested. If priority"
    c_red "     differs, resolution ORDER differs: first-match-wins means this can capture"
    c_red "     traffic the reviewed spec never described, or be shadowed and never fire."
    audit "map_read_back" "mismatch" \
      "$(jq -cn --arg id "$mid" --argjson w "$want" --argjson g "$got" '{mapping:$id,wanted:$w,persisted:$g}')"
    c_red "Backup for rollback: ${BACKUP_PATH:-<none taken>}"
    exit 4
  fi
  c_grn "mapping created and read-back verified: pattern, comboId, priority and enabled all match"
  audit "map_read_back" "verified" "$(jq -cn --arg id "$mid" --argjson w "$want" '{mapping:$id,fields:$w}')"
}

# ===================================================================== SUBCOMMANDS
cmd_validate() {   # offline: no auth, no network, no DB. Safe for anyone to run.
  CATALOGUE_MODE="off"
  local spec; spec="$(cat "${1:--}")"
  validate_spec "$spec"
  c_grn "spec is valid and passes offline containment (nothing applied, catalogue not consulted)"
}

cmd_dry_run() {
  # Dry-run is the review step, so it resolves the live catalogue like apply does.
  # It is 'advisory' only in that a missing catalogue is a hard error here too — the
  # difference is that dry-run never touches the database.
  CATALOGUE_MODE="advisory"
  local spec; spec="$(cat "${1:--}")"
  validate_spec "$spec"
  echo
  c_grn "=== DRY RUN — resulting combo, NOT applied ==="
  # Identical jq expression to the one cmd_apply sends, so what you review here is
  # byte-for-byte what would be written. Do not let these two drift apart.
  jq -S '{name,strategy,description:(.description // ""),models,capabilities:(.capabilities // {})}' <<<"$spec"
  echo
  log "catalogue consulted: ${CATALOGUE_SOURCE:-none}"
  log "would POST/PUT to ${OMNIROUTE_BASE_URL}/api/combos"
  detect_sqlite_engine || true
  log "would back up ${OMNIROUTE_SQLITE} to ${COMBO_BACKUP_DIR} and verify before mutating"
  log "  sqlite engine: ${SQLITE_ENGINE:-NONE FOUND — apply would refuse to mutate}"
  log "would then re-read the combo and assert strategy=='$(jq -r .strategy <<<"$spec")'"
  audit "dry_run" "ok" "$(jq -c '{name,strategy,members:[.models[].model]}' <<<"$spec")"
}

cmd_apply() {
  require_reason
  # Mandatory. There is no flag to skip it: writing a member that no longer exists
  # upstream, or one that turned into a blend since review, is precisely the staleness
  # TOG-150/TOG-176 warned about.
  CATALOGUE_MODE="required"
  local spec; spec="$(cat "${1:--}")"
  validate_spec "$spec"

  local name strategy models_json spec_bindings spec_bindings_ord
  name="$(jq -r .name <<<"$spec")"
  strategy="$(jq -r .strategy <<<"$spec")"
  models_json="$(jq -c '[.models[].model]' <<<"$spec")"
  # Bindings this spec explicitly ASKED for. Empty is meaningful and different from
  # "no bindings exist": it means we made no claim, so read-back reports what the
  # server chose instead of asserting on it.
  spec_bindings="$(bindings_of "$spec")"
  spec_bindings_ord="$(bindings_ordered "$spec")"

  c_ylw "About to apply combo '$name' (strategy=$strategy, ${#models_json} bytes of members)."
  jq -S '{name,strategy,models}' <<<"$spec" >&2
  read -r -p "Type the combo name to confirm: " confirm
  [ "$confirm" = "$name" ] || die "confirmation did not match; nothing applied"

  backup_and_verify "pre-combo-apply"

  # Does it already exist? Fail closed on an unreadable list: treating it as "absent"
  # would turn an intended UPDATE into a duplicate CREATE.
  api GET "/api/combos"
  local combos existing_id previous
  combos="$(json_list_strict "combos")" || exit 3
  existing_id="$(jq -r --arg n "$name" '.[] | select(.name==$n) | .id' <<<"$combos" | head -n1)"
  # Before-state for the log, in the position provisioner-grant-log uses for
  # previousGrants. computed_context_length is dropped: it is server-derived, so
  # keeping it would make every diff look like a change.
  previous="$(jq -c --arg n "$name" 'map(select(.name==$n))[0] | if . == null then null else {id,name,strategy,models} end' <<<"$combos")"

  local payload
  payload="$(jq -c '{name,strategy,description:(.description // ""),models,capabilities:(.capabilities // {})}' <<<"$spec")"

  if [ -n "$existing_id" ] && [ "$existing_id" != "null" ]; then
    # ---------------------------------------------------- connectionId drop-guard
    # This update is a FULL REPLACE: whatever 'models' we send becomes the whole
    # member list. The management API returns a connectionId on existing legs, so a
    # spec that omits it would silently discard a binding the operator never saw and
    # did not decide to change. With two 'opencode-go' connections now live on this
    # instance, providerId alone does not say which one a leg meant — so the discard
    # is not cosmetic, it can move traffic to a different connection.
    #
    # The old read-back could not catch this: it compared member ids only, so it
    # would have printed "read-back verified" over exactly this loss. That is the
    # silent-success failure this tool exists to prevent, sitting in the assertion
    # meant to prevent it.
    local prev_bound; prev_bound="$(bindings_of "$previous")"
    # Explicit status check, not a bare call: `refuse` inside this must stop the
    # apply, and a swallowed non-zero here would let the write proceed.
    local grc=0
    connection_rebind_check "$previous" "$spec" "$COMBO_ALLOW_REBIND" || grc=$?
    [ "$grc" -eq 0 ] || exit "$grc"
    if [ "$prev_bound" != "[]" ] && [ "$prev_bound" != "$spec_bindings" ]; then
      audit "combo_rebind" "acknowledged" \
        "$(jq -cn --arg id "$existing_id" --argjson p "$prev_bound" --argjson s "$spec_bindings" '{combo:$id,previous_bindings:$p,new_bindings:$s}')"
    fi

    log "updating existing combo id=$existing_id"
    api PUT "/api/combos/${existing_id}" "$payload"
    MUTATION_APPLIED=1
  else
    log "creating new combo"
    api POST "/api/combos" "$payload"
    MUTATION_APPLIED=1
    existing_id="$(json_unwrap <<<"$API_BODY" | jq -r '.id // empty')"
    [ -n "$existing_id" ] || die "create returned no id; expected the combo object or {combo:{...}}. Body: ${API_BODY:0:300}"
  fi

  audit "combo_apply" "written" \
    "$(jq -cn --arg id "$existing_id" --arg b "${BACKUP_PATH:-}" '{combo:$id,backup:$b}')" \
    "$previous" \
    "$(jq -cn --arg id "$existing_id" --arg n "$name" --arg s "$strategy" --argjson m "$models_json" '{id:$id,name:$n,strategy:$s,members:$m}')"
  read_back_assert "$existing_id" "$name" "$strategy" "$models_json" "$spec_bindings" "$spec_bindings_ord"
  c_grn "combo '$name' applied and verified (id=$existing_id)"
}

cmd_list() {
  api GET "/api/combos"
  local combos; combos="$(json_list_strict "combos")" || exit 3
  jq -r '.[] | [.id, .name, .strategy, ((.models // []) | length | tostring)] | @tsv' <<<"$combos" \
    | awk 'BEGIN{printf "%-38s %-28s %-18s %s\n","ID","NAME","STRATEGY","MEMBERS"} {printf "%-38s %-28s %-18s %s\n",$1,$2,$3,$4}'
  log ""
  log "This lists only what the management credential can enumerate. Server-side combos"
  log "it cannot see — the auto/* family among them — are NOT shown and are NOT absent."
}

cmd_delete() {
  local name="$1"
  require_reason
  assert_mutable_combo_name "$name"
  api GET "/api/combos"
  local combos id previous
  combos="$(json_list_strict "combos")" || exit 3
  id="$(jq -r --arg n "$name" '.[] | select(.name==$n) | .id' <<<"$combos" | head -n1)"
  [ -n "$id" ] && [ "$id" != "null" ] || die "no combo named '$name'"
  previous="$(jq -c --arg n "$name" 'map(select(.name==$n))[0] | if . == null then null else {id,name,strategy,models} end' <<<"$combos")"

  c_ylw "About to DELETE combo '$name' (id=$id)."
  read -r -p "Type the combo name to confirm: " confirm
  [ "$confirm" = "$name" ] || die "confirmation did not match; nothing deleted"

  backup_and_verify "pre-combo-delete"
  api DELETE "/api/combos/${id}"
  MUTATION_APPLIED=1
  audit "combo_delete" "deleted" \
    "$(jq -cn --arg id "$id" --arg n "$name" --arg b "${BACKUP_PATH:-}" '{combo:$id,name:$n,backup:$b}')" \
    "$previous" "null"

  api GET "/api/combos"
  local after; after="$(json_list_strict "combos")" || exit 3
  if jq -e --arg n "$name" '[.[] | select(.name==$n)] | length > 0' >/dev/null <<<"$after"; then
    die "delete returned success but '$name' is still present. Backup: ${BACKUP_PATH:-<none>}"
  fi
  c_grn "combo '$name' deleted and absence verified"
}

cmd_map_list() {
  api GET "/api/model-combo-mappings"
  local maps; maps="$(json_list_strict "mappings")" || exit 3
  jq -r '.[] | [(.priority|tostring), .pattern, .comboId, (.enabled|tostring)] | @tsv' <<<"$maps" \
    | sort -rn \
    | awk 'BEGIN{printf "%-9s %-34s %-38s %s\n","PRIORITY","PATTERN","COMBO","ENABLED"} {printf "%-9s %-34s %-38s %s\n",$1,$2,$3,$4}'
  log ""
  log "Resolution order is priority DESC, created_at ASC — FIRST MATCH WINS. Read this list top-down."
}

cmd_map_apply() {
  require_reason
  local spec; spec="$(cat "${1:--}")"
  validate_mapping_spec "$spec"
  local pattern; pattern="$(jq -r .pattern <<<"$spec")"

  # Snapshot BEFORE the write. The read-back needs to prove that THIS invocation
  # created a row, and it cannot do that from the post-write state alone.
  api GET "/api/model-combo-mappings"
  local before before_ids
  before="$(json_list_strict "mappings")" || exit 3
  before_ids="$(jq -c '[.[] | .id | tostring] | sort' <<<"$before")"

  if jq -e --arg p "$pattern" '[.[] | select(.pattern==$p)] | length > 0' >/dev/null <<<"$before"; then
    c_ylw "WARNING: a mapping with pattern '$pattern' already exists:"
    jq -S --arg p "$pattern" '[.[] | select(.pattern==$p)]' <<<"$before" >&2
    c_ylw "Resolution is priority DESC, created_at ASC, FIRST MATCH WINS. Adding a second row"
    c_ylw "for the same pattern means one of them can never fire. Confirm only if you mean it."
  fi

  c_ylw "About to create mapping '$pattern' -> $(jq -r .comboId <<<"$spec") at priority $(jq -r .priority <<<"$spec")."
  read -r -p "Type the pattern to confirm: " confirm
  [ "$confirm" = "$pattern" ] || die "confirmation did not match; nothing applied"

  backup_and_verify "pre-mapping-apply"
  local payload
  payload="$(jq -c '{pattern,comboId,priority,enabled:(.enabled // true),description:(.description // "")}' <<<"$spec")"
  api POST "/api/model-combo-mappings" "$payload"
  MUTATION_APPLIED=1
  local mid; mid="$(json_unwrap <<<"$API_BODY" | jq -r '.id // empty')"
  audit "mapping_apply" "written" \
    "$(jq -cn --arg id "$mid" --arg b "${BACKUP_PATH:-}" '{mapping:$id,backup:$b}')" \
    "null" "$(jq -cn --argjson s "$spec" --arg id "$mid" '{id:$id,spec:$s}')"

  map_read_back_assert "$mid" "$before_ids" "$payload"
}

cmd_map_delete() {
  local id="$1"
  require_reason
  # Capture the before-state while it still exists, so the log can answer what was
  # removed. A delete row with no previousCombo is a row nobody can review.
  api GET "/api/model-combo-mappings"
  local maps previous
  maps="$(json_list_strict "mappings")" || exit 3
  previous="$(jq -c --arg i "$id" 'map(select((.id|tostring)==$i))[0] // null' <<<"$maps")"
  [ "$previous" != "null" ] || die "no mapping with id '$id'"

  c_ylw "About to DELETE mapping id=$id."
  jq -S . <<<"$previous" >&2
  read -r -p "Type the id to confirm: " confirm
  [ "$confirm" = "$id" ] || die "confirmation did not match; nothing deleted"
  backup_and_verify "pre-mapping-delete"
  api DELETE "/api/model-combo-mappings/${id}"
  MUTATION_APPLIED=1
  audit "mapping_delete" "deleted" \
    "$(jq -cn --arg id "$id" --arg b "${BACKUP_PATH:-}" '{mapping:$id,backup:$b}')" \
    "$previous" "null"

  # Verify absence. Without this, map-delete was the only mutation in the tool that
  # reported success on the strength of an HTTP status alone — the exact inference
  # this tool exists to refuse to make. Ids are compared as strings because the API
  # has returned both numeric and string ids, and a route that resolves the id
  # differently from the way we sent it can return 200 having deleted nothing.
  api GET "/api/model-combo-mappings"
  local after; after="$(json_list_strict "mappings")" || exit 3
  if jq -e --arg i "$id" '[.[] | select((.id|tostring)==$i)] | length > 0' >/dev/null <<<"$after"; then
    die "delete returned success but mapping '$id' is still present on read-back.
  The routing rule you believe you removed is still live. Backup: ${BACKUP_PATH:-<none>}"
  fi
  c_grn "mapping $id deleted and absence verified"
}

cmd_allowlist_scaffold() {
  # Produces a CANDIDATE file for human review. The exclusion heuristic below is NOT
  # the security control — the reviewed allowlist is. The heuristic is deliberately
  # over-broad: over-exclusion costs a line of typing, under-exclusion costs Claude
  # traffic on a reseller.
  catalogue_load

  echo "# OmniRoute combo allowlist — DENY BY DEFAULT."
  echo "# Generated $(now_iso) by $PROG $VERSION as a CANDIDATE for human review."
  echo "# Catalogue source: $CATALOGUE_SOURCE"
  echo "#"
  echo "# Every line is an EXACT model id permitted as a combo member. Comparison is"
  echo "# string equality. Anything not listed here is refused. There is no"
  echo "# normalisation: 'oc/glm-5' on this list does NOT permit 'no-think/oc/glm-5'."
  echo "#"
  echo "# The generator stripped anything matching claude|anthropic|opus|sonnet|haiku|"
  echo "# fable|prism|^aug/ and the no-think/ namespace. That filter is a convenience to"
  echo "# shrink your review, NOT the control. REVIEW EVERY LINE BEFORE USE."
  echo "#"
  echo "# Append ' !nonclaude # <why>' to clear a family-word false positive on a"
  echo "# SINGLE-MODEL route. It does NOT clear a blended route: blends such as"
  echo "# aug/prism-a ('Prism (Claude + Gemini)') and aug/prism-b ('Prism (GPT + Kimi)')"
  echo "# are refused outright and no allowlist marker overrides that. Overrides are"
  echo "# logged on every use."
  echo "#"
  echo "# This file is a REVIEW ARTEFACT, not a cache. Ids go stale: run"
  echo "#   $PROG allowlist-audit"
  echo "# to re-check every line against the live catalogue."
  echo "#"
  cut -f1 "$CATALOGUE_TSV" \
    | grep -v -E -i 'claude|anthropic|opus|sonnet|haiku|fable|prism' \
    | grep -v -E '^(aug|auto|combo|qtSd|hindsight)/' \
    | grep -v -E '^no-think/' \
    | sort -u
}

# Re-checks a reviewed allowlist against the live catalogue. The allowlist records a
# judgement made on a particular day; the catalogue moves underneath it. This is the
# maintenance view of the same facts gate_catalogue/gate_blended enforce at apply
# time — it is read-only and safe to run on a schedule.
cmd_allowlist_audit() {
  [ -s "$COMBO_ALLOWLIST_FILE" ] || die "allowlist '$COMBO_ALLOWLIST_FILE' is missing or empty"
  catalogue_load
  local id name reason total=0 gone=0 blended=0 flagged=0
  echo
  printf '%-52s %s\n' "MODEL ID" "FINDING"
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    total=$((total+1))
    if ! name="$(catalogue_name_of "$id")"; then
      gone=$((gone+1)); printf '%-52s %s\n' "$id" "WITHDRAWN — not in $CATALOGUE_SOURCE"; continue
    fi
    if reason="$(blend_reason "$name")"; then
      blended=$((blended+1)); printf '%-52s %s\n' "$id" "BLENDED — \"$name\"; refused at apply, remove it"; continue
    fi
    if reason="$(claude_suspicion_reason "$id")"; then
      if allowlist_nonclaude_ack "$id"; then
        flagged=$((flagged+1)); printf '%-52s %s\n' "$id" "!nonclaude override active ($reason) — \"$name\""
      else
        flagged=$((flagged+1)); printf '%-52s %s\n' "$id" "TRIPWIRE — $reason; refused at apply"
      fi
    fi
  done < <(allowlist_ids)
  echo
  log "$total allowlist entries: $gone withdrawn, $blended blended, $flagged tripwire-flagged."
  audit "allowlist_audit" "ok" "$(jq -cn --arg s "$CATALOGUE_SOURCE" --argjson t "$total" --argjson g "$gone" --argjson b "$blended" --argjson f "$flagged" \
    '{source:$s,entries:$t,withdrawn:$g,blended:$b,tripwire_flagged:$f}')"
  if [ "$gone" -gt 0 ] || [ "$blended" -gt 0 ]; then
    c_ylw "Allowlist is stale. Those entries will be refused at apply time — fail-closed, but fix the file."
    return 5
  fi
  c_grn "allowlist is consistent with the live catalogue"
}

cmd_selftest() {
  # Offline. Proves the containment logic on the exact cases TOG-176 documented.
  local tmp; tmp="$(mktemp -d)"
  # 'local' here is deliberate: bash locals are dynamically scoped, so the gate
  # functions called below see these overrides and the caller's config is untouched.
  local COMBO_ALLOWLIST_FILE="$tmp/allow.txt"
  local COMBO_LOG_FILE="$tmp/log.jsonl"
  cat > "$COMBO_ALLOWLIST_FILE" <<'EOF'
ocgo/glm-5
ocgo/kimi-k2.5
openrouter/openai/gpt-5
teamclaude/claude-opus-5
ocgo/glm-5-deprecated
aug/gpt-5 !nonclaude # auggie provider, single-model non-Claude route — TOG-176
aug/prism-b !nonclaude # operator TRIES to clear a blend; the blend gate must win
EOF
  # A FIXTURE catalogue, not a bundled one. It stands in for the live /v1/models read
  # so the gates that depend on it can be tested with no network and no credential.
  # Nothing outside this function ever reads it.
  local CATALOGUE_TSV="$tmp/catalogue.tsv"
  local CATALOGUE_SOURCE="fixture:selftest"
  local CATALOGUE_MODE="required"
  printf '%s\n' \
    "ocgo/glm-5	GLM-5" \
    "ocgo/kimi-k2.5	Kimi K2.5" \
    "openrouter/openai/gpt-5	GPT-5" \
    "teamclaude/claude-opus-5	Claude Opus 5" \
    "aug/gpt-5	GPT-5" \
    "aug/prism-a	Prism (Claude + Gemini)" \
    "aug/prism-b	Prism (GPT + Kimi)" \
    "no-think/ocgo/glm-5	GLM-5 (no think)" \
    > "$CATALOGUE_TSV"
  local pass=0 fail=0
  _case() { # name expect(allow|refuse) id
    local nm="$1" expect="$2" id="$3" rc=0
    ( gate_allowlist "$id"; gate_claude_tripwire "$id" ) >/dev/null 2>&1 || rc=$?
    local got=allow; [ "$rc" -ne 0 ] && got=refuse
    if [ "$got" = "$expect" ]; then pass=$((pass+1)); printf '  PASS  %-46s %s\n' "$nm" "$got"
    else fail=$((fail+1)); c_red "  FAIL  $nm  expected=$expect got=$got"; fi
  }
  echo "containment self-test (offline):"
  _case "allowlisted non-Claude"                allow  "ocgo/glm-5"
  _case "Claude on teamclaude (sanctioned)"     allow  "teamclaude/claude-opus-5"
  _case "operator !nonclaude override"          allow  "aug/gpt-5"
  _case "TOG-176: aug/opus4.8 (no 'claude')"    refuse "aug/opus4.8"
  _case "TOG-176: aug/sonnet5-high"             refuse "aug/sonnet5-high"
  _case "TOG-176: aug/fable-5"                  refuse "aug/fable-5"
  _case "TOG-176: aug/prism-a (blended)"        refuse "aug/prism-a"
  _case "TOG-176: aug/haiku4.5"                 refuse "aug/haiku4.5"
  _case "alias oc/ prefix"                      refuse "oc/claude-opus-5"
  _case "alias opencode/ prefix"                refuse "opencode/claude-opus-5"
  _case "no-think/ namespace"                   refuse "no-think/oc/claude-opus-5"
  _case "no-think/ + openrouter"                refuse "no-think/openrouter/anthropic/claude-opus-5"
  _case "theoldllm uppercase id"                refuse "tllm/CLAUDE_4_6_OPUS"
  _case "duckduckgo Claude"                     refuse "ddgw/claude-haiku-4-5"
  _case "non-Claude but not allowlisted"        refuse "openrouter/meta/llama-4"

  # ---- the catalogue-dependent gates, driven by the fixture catalogue above -------
  # These are the checks a static allowlist cannot make: does the id still exist, and
  # is it a blend? Both are re-read at apply time rather than remembered.
  echo "live-catalogue gates (existence + blending):"
  _lcase() { # name expect(allow|refuse) id  — full chain incl. gate_live
    local nm="$1" expect="$2" id="$3" rc=0
    ( gate_allowlist "$id"; gate_claude_tripwire "$id"; gate_live "$id" ) >/dev/null 2>&1 || rc=$?
    local got=allow; [ "$rc" -ne 0 ] && got=refuse
    if [ "$got" = "$expect" ]; then pass=$((pass+1)); printf '  PASS  %-46s %s\n' "$nm" "$got"
    else fail=$((fail+1)); c_red "  FAIL  $nm  expected=$expect got=$got"; fi
  }
  _lcase "live id, allowlisted"                 allow  "ocgo/glm-5"
  _lcase "allowlisted but WITHDRAWN upstream"   refuse "ocgo/glm-5-deprecated"
  _lcase "!nonclaude on single-model route"     allow  "aug/gpt-5"
  _lcase "blend: prism-a (Claude + Gemini)"     refuse "aug/prism-a"
  _lcase "blend: prism-b, !nonclaude MUST NOT clear it" refuse "aug/prism-b"

  # Point 1 from the operator's 2026-08-23 08:21Z note: no-think/ is the single
  # largest Claude bucket (124 of 351). Any prefix normalisation would collapse it
  # into its parent id. These two assert that no such normalisation exists: the
  # namespaced id is a DIFFERENT id, allowlisted separately or not at all — even
  # though the fixture catalogue says it exists and is not blended.
  echo "namespace non-collapse (no normalisation anywhere):"
  _lcase "no-think/ of an allowlisted id is NOT allowlisted" refuse "no-think/ocgo/glm-5"
  _bare_prefix_case() {
    local nm="$1" rc=0
    allowlist_has "no-think/ocgo/glm-5" || rc=1
    if [ "$rc" -ne 0 ]; then pass=$((pass+1)); printf '  PASS  %-46s %s\n' "$nm" "not-matched"
    else fail=$((fail+1)); c_red "  FAIL  $nm  allowlist matched a namespaced variant"; fi
  }
  _bare_prefix_case "allowlist_has does not strip a namespace"

  echo "catalogue parsing (shape is insisted on, not guessed):"
  _capcase() { # name expect(parse|reject) json-or-tsv
    local nm="$1" expect="$2" in="$3" rc=0 out
    out="$(catalogue_parse_to_tsv <<<"$in" 2>/dev/null)" || rc=$?
    local got=parse; { [ "$rc" -ne 0 ] || [ -z "$out" ]; } && got=reject
    if [ "$got" = "$expect" ]; then pass=$((pass+1)); printf '  PASS  %-46s %s\n' "$nm" "$got"
    else fail=$((fail+1)); c_red "  FAIL  $nm expected=$expect got=$got"; fi; }
  _capcase "/v1/models {data:[...]}"            parse  '{"data":[{"id":"a/b","name":"AB"}]}'
  _capcase "bare array"                         parse  '[{"id":"a/b","name":"AB"}]'
  _capcase "flattened id<TAB>name"              parse  "$(printf 'a/b\tAB')"
  _capcase "arbitrary object (not a catalogue)" reject '{"total":3,"note":"analysis","by_provider":{"aug":14}}'
  _capcase ".data present but not an array"     reject '{"data":{"a/b":"AB"}}'
  _capcase "entries with no id are dropped"     reject '{"data":[{"name":"AB"},{"name":"CD"}]}'

  echo "blend detection (catalogue name, not id):"
  _blcase() { local nm="$1" expect="$2" n="$3" rc=0
    ( blend_reason "$n" ) >/dev/null 2>&1 || rc=$?
    local got=blend; [ "$rc" -ne 0 ] && got=single
    if [ "$got" = "$expect" ]; then pass=$((pass+1)); printf '  PASS  %-46s %s\n' "$nm" "$got"
    else fail=$((fail+1)); c_red "  FAIL  $nm expected=$expect got=$got"; fi; }
  _blcase "Prism (Claude + Gemini)"             blend  "Prism (Claude + Gemini)"
  _blcase "Prism (GPT + Kimi)"                  blend  "Prism (GPT + Kimi)"
  _blcase "plain single model"                  single "Claude Opus 5"
  _blcase "plain single model, no parens"       single "GLM-5"
  _blcase "'blend' in the name"                 blend  "Router Blend v2"

  echo "strategy validation:"
  _scase() { local nm="$1" expect="$2" s="$3" rc=0
    ( validate_strategy "$s" ) >/dev/null 2>&1 || rc=$?
    local got=allow; [ "$rc" -ne 0 ] && got=refuse
    if [ "$got" = "$expect" ]; then pass=$((pass+1)); printf '  PASS  %-46s %s\n' "$nm" "$got"
    else fail=$((fail+1)); c_red "  FAIL  $nm expected=$expect got=$got"; fi; }
  _scase "canonical fill-first"                 allow  "fill-first"
  _scase "canonical headroom"                   allow  "headroom"
  _scase "internal quota-share"                 refuse "quota-share"
  _scase "alias 'usage'"                        refuse "usage"
  _scase "alias 'weekly-reset'"                 refuse "weekly-reset"
  _scase "typo 'fillfirst' (would coerce!)"     refuse "fillfirst"
  _scase "typo 'least_used' (would coerce!)"    refuse "least_used"

  echo "combo-name protection:"
  _ncase() { local nm="$1" expect="$2" n="$3" rc=0
    ( assert_mutable_combo_name "$n" ) >/dev/null 2>&1 || rc=$?
    local got=allow; [ "$rc" -ne 0 ] && got=refuse
    if [ "$got" = "$expect" ]; then pass=$((pass+1)); printf '  PASS  %-46s %s\n' "$nm" "$got"
    else fail=$((fail+1)); c_red "  FAIL  $nm expected=$expect got=$got"; fi; }
  _ncase "our namespace"                        allow  "two/go-rotation"
  _ncase "protected hindsight/*"                refuse "hindsight/retain"
  _ncase "protected auto/*"                     refuse "auto/claude-opus"
  _ncase "internal qtSd/*"                      refuse "qtSd/abc123"
  _ncase "foreign namespace"                    refuse "someoneelse/thing"

  echo "scope confinement:"
  _pcase() { local nm="$1" expect="$2" p="$3"; local got=refuse
    [[ "$p" =~ $API_PATH_ALLOW ]] && got=allow
    if [ "$got" = "$expect" ]; then pass=$((pass+1)); printf '  PASS  %-46s %s\n' "$nm" "$got"
    else fail=$((fail+1)); c_red "  FAIL  $nm expected=$expect got=$got"; fi; }
  _pcase "/api/combos"                          allow  "/api/combos"
  _pcase "/api/combos/{id}"                     allow  "/api/combos/abc-123"
  _pcase "/api/model-combo-mappings"            allow  "/api/model-combo-mappings"
  _pcase "/api/keys (out of scope)"             refuse "/api/keys"
  _pcase "/api/providers (out of scope)"        refuse "/api/providers"
  _pcase "/api/connections (out of scope)"      refuse "/api/connections"
  _pcase "traversal escape"                     refuse "/api/combos/../keys"

  # Full-spec regression tests. These exist because an earlier revision printed
  # "REFUSED" and then exited 0 with "spec is valid": the refusal happened inside a
  # process substitution and never reached the parent shell. End-to-end exit status
  # is the only thing that actually proves a refusal refused.
  echo "full-spec validation (exit status is the assertion):"
  _vcase() { local nm="$1" expect="$2" json="$3" rc=0
    ( validate_spec "$json" ) >/dev/null 2>&1 || rc=$?
    local got=allow; [ "$rc" -ne 0 ] && got=refuse
    if [ "$got" = "$expect" ]; then pass=$((pass+1)); printf '  PASS  %-46s %s\n' "$nm" "$got"
    else fail=$((fail+1)); c_red "  FAIL  $nm expected=$expect got=$got (rc=$rc)"; fi; }
  _vcase "well-formed spec"  allow \
    '{"name":"two/ok","strategy":"fill-first","models":[{"kind":"model","model":"ocgo/glm-5","providerId":"opencode-go"}]}'
  _vcase "nested auto/ combo member"            refuse \
    '{"name":"two/x","strategy":"priority","models":[{"kind":"model","model":"auto/claude-opus","providerId":"combo"}]}'
  _vcase "nested hindsight/ combo member"       refuse \
    '{"name":"two/x","strategy":"priority","models":[{"kind":"model","model":"hindsight/retain","providerId":"combo"}]}'
  _vcase "hidden Claude member (aug/opus4.8)"   refuse \
    '{"name":"two/x","strategy":"priority","models":[{"kind":"model","model":"ocgo/glm-5","providerId":"opencode-go"},{"kind":"model","model":"aug/opus4.8","providerId":"auggie"}]}'
  # connectionId: accepted when UUID-shaped (it is a real field of the management
  # API's step object), refused when malformed. 'c1' is the value the OLD test
  # asserted must be refused — it still is, but now for the right reason.
  _vcase "connectionId, valid UUID, accepted"   allow \
    '{"name":"two/x","strategy":"priority","models":[{"kind":"model","model":"ocgo/glm-5","providerId":"opencode-go","connectionId":"aaaaaaaa-1111-4222-8333-444455556666"}]}'
  _vcase "connectionId, not UUID-shaped"        refuse \
    '{"name":"two/x","strategy":"priority","models":[{"kind":"model","model":"ocgo/glm-5","providerId":"opencode-go","connectionId":"c1"}]}'
  _vcase "connectionId, wrong JSON type"        refuse \
    '{"name":"two/x","strategy":"priority","models":[{"kind":"model","model":"ocgo/glm-5","providerId":"opencode-go","connectionId":123}]}'
  # A connectionId must not become a way to smuggle a member past containment: the
  # gates key off .model, so a Claude leg stays refused regardless.
  _vcase "connectionId does not bypass tripwire" refuse \
    '{"name":"two/x","strategy":"priority","models":[{"kind":"model","model":"aug/opus4.8","providerId":"auggie","connectionId":"aaaaaaaa-1111-4222-8333-444455556666"}]}'
  _vcase "empty models array"                   refuse \
    '{"name":"two/x","strategy":"priority","models":[]}'
  _vcase "missing strategy (no silent default)" refuse \
    '{"name":"two/x","models":[{"kind":"model","model":"ocgo/glm-5","providerId":"opencode-go"}]}'
  _vcase "unrecognised top-level key"           refuse \
    '{"name":"two/x","strategy":"priority","evil":1,"models":[{"kind":"model","model":"ocgo/glm-5","providerId":"opencode-go"}]}'
  _vcase "protected combo name"                 refuse \
    '{"name":"hindsight/retain","strategy":"priority","models":[{"kind":"model","model":"ocgo/glm-5","providerId":"opencode-go"}]}'
  # These two prove the catalogue gates are reached through validate_spec, not only
  # when called directly. A gate that is unit-tested but unwired is worse than none.
  _vcase "spec with a WITHDRAWN member"         refuse \
    '{"name":"two/x","strategy":"priority","models":[{"kind":"model","model":"ocgo/glm-5","providerId":"opencode-go"},{"kind":"model","model":"ocgo/glm-5-deprecated","providerId":"opencode-go"}]}'
  _vcase "spec with a BLENDED member (prism-b)" refuse \
    '{"name":"two/x","strategy":"priority","models":[{"kind":"model","model":"ocgo/glm-5","providerId":"opencode-go"},{"kind":"model","model":"aug/prism-b","providerId":"auggie"}]}'

  # ------------------------------------------- connection-binding drop-guard
  # The guard that stops an update from silently rebinding a leg. Tested through
  # the same function cmd_apply calls, with the same argument order, because the
  # only alternative is testing it against a live server — which no run has done.
  echo "connection-binding drop-guard:"
  local UUID_A='aaaaaaaa-1111-4222-8333-444455556666'
  local UUID_B='99999999-2222-4333-8444-555566667777'
  _bcase() { local nm="$1" expect="$2" prev="$3" spec="$4" allow="${5:-0}" rc=0
    ( connection_rebind_check "$prev" "$spec" "$allow" ) >/dev/null 2>&1 || rc=$?
    local got=allow; [ "$rc" -ne 0 ] && got=refuse
    if [ "$got" = "$expect" ]; then pass=$((pass+1)); printf '  PASS  %-46s %s\n' "$nm" "$got"
    else fail=$((fail+1)); c_red "  FAIL  $nm expected=$expect got=$got (rc=$rc)"; fi; }

  local PREV_BOUND="{\"models\":[{\"model\":\"ocgo/glm-5\",\"connectionId\":\"$UUID_A\"}]}"
  local SPEC_SAME="{\"models\":[{\"model\":\"ocgo/glm-5\",\"providerId\":\"opencode-go\",\"connectionId\":\"$UUID_A\"}]}"
  local SPEC_OTHER="{\"models\":[{\"model\":\"ocgo/glm-5\",\"providerId\":\"opencode-go\",\"connectionId\":\"$UUID_B\"}]}"
  local SPEC_NONE='{"models":[{"model":"ocgo/glm-5","providerId":"opencode-go"}]}'

  # The core regression: stored binding + spec that omits it = silent data loss.
  _bcase "drops an existing binding"            refuse "$PREV_BOUND" "$SPEC_NONE"
  _bcase "rebinds to a different connection"    refuse "$PREV_BOUND" "$SPEC_OTHER"
  _bcase "preserves the existing binding"       allow  "$PREV_BOUND" "$SPEC_SAME"
  _bcase "no prior binding, nothing to lose"    allow  '{"models":[{"model":"ocgo/glm-5"}]}' "$SPEC_NONE"
  _bcase "previous is null (create, not update)" allow 'null' "$SPEC_NONE"
  # The override is explicit and must work, or operators will route around the guard.
  _bcase "--allow-rebind permits the change"    allow  "$PREV_BOUND" "$SPEC_OTHER" 1
  # Guard and verifier must agree on what a binding IS. If bindings_of ever diverges
  # between the two call sites, the guard passes something the read-back then flags.
  if [ "$(bindings_of "$PREV_BOUND")" = "$(bindings_of "$SPEC_SAME")" ]; then
    pass=$((pass+1)); printf '  PASS  %-46s %s\n' "guard and read-back share one definition" "ok"
  else
    fail=$((fail+1)); c_red "  FAIL  bindings_of disagrees across call sites"
  fi

  # ---- leg-order blindness. Two legs, SAME model id, connections swapped between
  # them. bindings_of sorts, so both sides are byte-identical and the pre-fix guard
  # returned 0. This is the bake-off spec's exact shape: two 'ocgo/glm-5' legs across
  # the two live opencode-go connections, where leg 0 is the one fill-first drains.
  local SWAP_AB="{\"models\":[{\"model\":\"m\",\"connectionId\":\"$UUID_A\"},{\"model\":\"m\",\"connectionId\":\"$UUID_B\"}]}"
  local SWAP_BA="{\"models\":[{\"model\":\"m\",\"connectionId\":\"$UUID_B\"},{\"model\":\"m\",\"connectionId\":\"$UUID_A\"}]}"
  _bcase "same-model legs, connections SWAPPED"  refuse "$SWAP_AB" "$SWAP_BA"
  _bcase "  ...permitted by --allow-rebind"      allow  "$SWAP_AB" "$SWAP_BA" 1
  _bcase "identical order is still a no-op"      allow  "$SWAP_AB" "$SWAP_AB"
  # The property that makes the above possible, asserted directly so a regression in
  # bindings_of shows up as its own failure rather than only through the guard.
  if [ "$(bindings_of "$SWAP_AB")" = "$(bindings_of "$SWAP_BA")" ] \
  && [ "$(bindings_ordered "$SWAP_AB")" != "$(bindings_ordered "$SWAP_BA")" ]; then
    pass=$((pass+1)); printf '  PASS  %-46s %s\n' "sorted view blind, ordered view sees it" "ok"
  else
    fail=$((fail+1)); c_red "  FAIL  bindings_ordered does not distinguish a leg swap"
  fi
  # 'leg' must index the ORIGINAL members array: an unbound leg in front of a bound one
  # must not renumber it, or the positional comparison drifts against its own spec.
  local GAP='{"models":[{"model":"m"},{"model":"m","connectionId":"'"$UUID_A"'"}]}'
  if [ "$(jq -r '.[0].leg' <<<"$(bindings_ordered "$GAP")")" = "1" ]; then
    pass=$((pass+1)); printf '  PASS  %-46s %s\n' "leg index is position in models, not filtered" "ok"
  else
    fail=$((fail+1)); c_red "  FAIL  bindings_ordered renumbers legs when one is unbound"
  fi

  # ---- read-back member ORDER. Same members, different order: the pre-fix assertion
  # sorted both sides, so it could only ever report a match.
  echo "read-back member order:"
  _ocase() { local nm="$1" expect="$2" sent="$3" stored="$4" allow="${5:-0}" got
    got="$(member_verdict "$sent" "$stored" "$allow")"
    if [ "$got" = "$expect" ]; then pass=$((pass+1)); printf '  PASS  %-46s %s\n' "$nm" "$got"
    else fail=$((fail+1)); c_red "  FAIL  $nm expected=$expect got=$got"; fi; }
  _ocase "identical order verifies"              match    '["a","b"]' '["a","b"]'
  _ocase "reordered members are a MISMATCH"      order    '["a","b"]' '["b","a"]'
  _ocase "  ...accepted under --allow-reorder"   accepted '["a","b"]' '["b","a"]' 1
  _ocase "a genuinely different member set"      members  '["a","b"]' '["a","c"]'
  _ocase "membership beats order in the verdict" members  '["a","b"]' '["c","a"]'
  # Guard against the assertion being re-fused into one sorted comparison: if it were,
  # sent and stored below would compare equal and 'order' could never be reported.
  if [ "$(jq -c 'sort' <<<'["a","b"]')" = "$(jq -c 'sort' <<<'["b","a"]')" ]; then
    pass=$((pass+1)); printf '  PASS  %-46s %s\n' "sorting alone cannot see a reorder" "ok"
  else
    fail=$((fail+1)); c_red "  FAIL  premise wrong: sort distinguishes these"
  fi

  echo "mapping validation:"
  _mcase() { local nm="$1" expect="$2" json="$3" rc=0
    ( validate_mapping_spec "$json" ) >/dev/null 2>&1 || rc=$?
    local got=allow; [ "$rc" -ne 0 ] && got=refuse
    if [ "$got" = "$expect" ]; then pass=$((pass+1)); printf '  PASS  %-46s %s\n' "$nm" "$got"
    else fail=$((fail+1)); c_red "  FAIL  $nm expected=$expect got=$got (rc=$rc)"; fi; }
  _mcase "narrow mapping"        allow  '{"pattern":"gpt-5*","comboId":"c1","priority":100}'
  _mcase "catch-all '*'"         refuse '{"pattern":"*","comboId":"c1","priority":100}'
  _mcase "Claude-targeting glob" refuse '{"pattern":"claude-*","comboId":"c1","priority":100}'
  _mcase "hidden Claude glob"    refuse '{"pattern":"opus*","comboId":"c1","priority":100}'
  _mcase "omitted priority"      refuse '{"pattern":"gpt-5*","comboId":"c1"}'

  # --------------------------------------------------- mapping write verification
  # The bug these exist to keep out: map-apply used to read back "does a mapping with
  # this pattern exist?", which a PRE-EXISTING row satisfies. A POST that returned 200
  # and persisted nothing printed "mapping created and verified" and exited 0.
  # Asserted on exit status, not printed text — same rule as the envelope suite.
  echo "mapping write identification (silent-success class):"
  local M_OLD='{"id":"m1","pattern":"gpt-5*","comboId":"c1","priority":100,"enabled":true}'
  local M_NEW='{"id":"m2","pattern":"gpt-5*","comboId":"c2","priority":50,"enabled":true}'
  _icase() { # name expect(found|absent|ambiguous) mid before_ids after
    local nm="$1" expect="$2" mid="$3" bids="$4" after="$5" rc=0 out=""
    out="$(identify_new_mapping "$mid" "$bids" "$after" 2>/dev/null)" || rc=$?
    local got=found
    [ "$rc" -eq 2 ] && got=absent
    [ "$rc" -eq 3 ] && got=ambiguous
    if [ "$got" = "$expect" ]; then pass=$((pass+1)); printf '  PASS  %-46s %s\n' "$nm" "$got"
    else fail=$((fail+1)); c_red "  FAIL  $nm expected=$expect got=$got (rc=$rc out=$out)"; fi; }

  # THE regression. Pattern already present, POST persisted nothing, server gave no id.
  _icase "pre-existing pattern is not our write"  absent    "" '["m1"]' "[$M_OLD]"
  _icase "server id present and persisted"        found     "m2" '["m1"]' "[$M_OLD,$M_NEW]"
  _icase "server id returned but row absent"      absent    "m2" '["m1"]' "[$M_OLD]"
  _icase "no id, one new row, identified"         found     "" '["m1"]' "[$M_OLD,$M_NEW]"
  _icase "no id, two new rows, ambiguous"         ambiguous "" '["m1"]' \
    "[$M_OLD,$M_NEW,{\"id\":\"m3\",\"pattern\":\"o3*\",\"comboId\":\"c3\",\"priority\":10}]"
  _icase "numeric ids compare as strings"         found     "2" '["1"]' \
    '[{"id":1,"pattern":"a*","comboId":"c1","priority":1},{"id":2,"pattern":"b*","comboId":"c2","priority":2}]'

  echo "mapping field assertion (coercion class):"
  _mfcase() { # name expect(match|mismatch) want got
    local nm="$1" expect="$2" w="$3" g="$4"
    local got=mismatch
    [ "$(mapping_fields_of "$w")" = "$(mapping_fields_of "$g")" ] && got=match
    if [ "$got" = "$expect" ]; then pass=$((pass+1)); printf '  PASS  %-46s %s\n' "$nm" "$got"
    else fail=$((fail+1)); c_red "  FAIL  $nm expected=$expect got=$got"; fi; }
  local M_WANT='{"pattern":"gpt-5*","comboId":"c1","priority":100,"enabled":true}'
  _mfcase "identical fields verify"        match    "$M_WANT" "$M_WANT"
  # Priority is the routing-order field: first-match-wins makes a coerced priority a
  # silent reroute, which is the mapping analogue of normalizeRoutingStrategy().
  _mfcase "priority defaulted to 0 by server" mismatch "$M_WANT" '{"pattern":"gpt-5*","comboId":"c1","priority":0,"enabled":true}'
  _mfcase "priority as string is not a diff" match    "$M_WANT" '{"pattern":"gpt-5*","comboId":"c1","priority":"100","enabled":true}'
  _mfcase "comboId silently changed"       mismatch "$M_WANT" '{"pattern":"gpt-5*","comboId":"c2","priority":100,"enabled":true}'
  _mfcase "enabled dropped by server"      mismatch "$M_WANT" '{"pattern":"gpt-5*","comboId":"c1","priority":100,"enabled":false}'
  _mfcase "enabled absent means enabled"   match    "$M_WANT" '{"pattern":"gpt-5*","comboId":"c1","priority":100}'
  # description is deliberately NOT compared: it is free prose the server may normalise,
  # and asserting on it would produce failures that mean nothing about routing.
  _mfcase "description is not asserted on" match    "$M_WANT" '{"pattern":"gpt-5*","comboId":"c1","priority":100,"description":"server added this"}'

  # ---- backup verification (silent-success class) ---------------------------------
  # backup_and_verify runs only on the operator's box, behind sqlite3. Its checks were
  # extracted into pure functions precisely so this suite can reach them with no
  # sqlite3, no database and no credential. Asserted on exit status, never on text.
  echo "backup verification (silent-success class):"
  local BK="$tmp/bk"; mkdir -p "$BK"
  : > "$BK/zero.sqlite"
  printf 'not a database at all'                > "$BK/garbage.sqlite"
  printf 'SQLite format 3\000rest-of-the-header' > "$BK/good.sqlite"
  _fcase() { # name expect(ok|empty|badhdr) path
    local nm="$1" expect="$2" f="$3" rc=0
    sqlite_file_ok "$f" || rc=$?
    local got=ok
    [ "$rc" -eq 2 ] && got=empty
    [ "$rc" -eq 3 ] && got=badhdr
    if [ "$got" = "$expect" ]; then pass=$((pass+1)); printf '  PASS  %-46s %s\n' "$nm" "$got"
    else fail=$((fail+1)); c_red "  FAIL  $nm expected=$expect got=$got (rc=$rc)"; fi; }
  # THE regression: a zero-byte file is a VALID empty SQLite database, so PRAGMA
  # integrity_check answers 'ok' on it. Only the size/header check catches an empty
  # backup, and without it "backup verified" could print over nothing at all.
  _fcase "zero-byte backup is not a backup"       empty  "$BK/zero.sqlite"
  _fcase "backup file never created"              empty  "$BK/none.sqlite"
  _fcase "non-sqlite content rejected"            badhdr "$BK/garbage.sqlite"
  _fcase "valid sqlite header accepted"           ok     "$BK/good.sqlite"

  _rcase() { # name expect(match|unreadable|mismatch) src dst
    local nm="$1" expect="$2" s="$3" d="$4" rc=0
    assert_row_count "$s" "$d" || rc=$?
    local got=match
    [ "$rc" -eq 2 ] && got=unreadable
    [ "$rc" -eq 3 ] && got=mismatch
    if [ "$got" = "$expect" ]; then pass=$((pass+1)); printf '  PASS  %-46s %s\n' "$nm" "$got"
    else fail=$((fail+1)); c_red "  FAIL  $nm expected=$expect got=$got (rc=$rc)"; fi; }
  # THE regression: the old code read both counts with `|| echo NA`, so two FAILURES
  # compared equal and were reported as 'row-counts match'.
  _rcase "NA vs NA must not count as a match"     unreadable "NA" "NA"
  _rcase "empty vs empty is not a match"          unreadable "" ""
  _rcase "sqlite error text is not a count"       unreadable \
    "Error: no such table: combos" "Error: no such table: combos"
  _rcase "one side unreadable"                    unreadable "12" "NA"
  _rcase "equal counts verify"                    match      "12" "12"
  _rcase "zero rows on both sides verify"         match      "0"  "0"
  _rcase "real mismatch still caught"             mismatch   "12" "11"

  _tcase() { # name expect-missing have wanted...
    local nm="$1" expect="$2" have="$3"; shift 3
    local got; got="$(tables_missing_from "$have" "$@")"
    if [ "$got" = "$expect" ]; then pass=$((pass+1)); printf '  PASS  %-46s %s\n' "$nm" "${got:-none missing}"
    else fail=$((fail+1)); c_red "  FAIL  $nm expected=[$expect] got=[$got]"; fi; }
  local HAVE_T='combos
model_combo_mappings
users'
  _tcase "assumed tables present"                 "" "$HAVE_T" combos model_combo_mappings
  _tcase "assumed table name absent is named"     "model_combo_mappings" \
    'combos
users' combos model_combo_mappings
  _tcase "both absent are named"                  "combos model_combo_mappings" \
    'Combo
ModelComboMapping' combos model_combo_mappings
  # Substring/prefix must not satisfy the check, or a differently-named table would
  # pass and the row-count check would be counting the wrong rows.
  _tcase "substring is not a match"               "combo" "$HAVE_T" combo
  # The four real neighbours in OmniRoute's 118-table schema. Named individually
  # because each is one careless glob away from being counted instead of the real table.
  _tcase "compression_combos is not combos"       "combos" \
    'compression_combos
compression_combo_assignments
combo_adaptation_state
agent_bridge_mappings
model_combo_mappings' combos model_combo_mappings

  # ---- sqlite engine + REAL backup (v0.2.3) ---------------------------------------
  # Until v0.2.3 backup_and_verify shelled out to a sqlite3 binary that does not exist
  # on the operator's box, so this suite could only ever reach its pure helpers. The
  # python engine is present on any box that can run these tests, so the tool's only
  # undo is now exercised end to end for real: build a live WAL database, back it up,
  # verify the artifact. If python3 is unavailable this block is skipped, not failed.
  echo "sqlite engine and real backup:"
  if command -v python3 >/dev/null 2>&1 && python3 -c 'import sqlite3' >/dev/null 2>&1; then
    SQLITE_ENGINE=""; detect_sqlite_engine || true
    _eq() { local nm="$1" want="$2" got="$3"
      if [ "$want" = "$got" ]; then pass=$((pass+1)); printf '  PASS  %-46s %s\n' "$nm" "$got"
      else fail=$((fail+1)); c_red "  FAIL  $nm expected=[$want] got=[$got]"; fi; }
    _eq "engine prefers python over absent binary" "python" "$SQLITE_ENGINE"

    local DB="$tmp/live.sqlite"
    python3 - "$DB" <<'PYFIX' >/dev/null
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
c.execute("PRAGMA journal_mode=WAL")
c.execute("CREATE TABLE combos(id INTEGER PRIMARY KEY, name TEXT)")
c.execute("CREATE TABLE model_combo_mappings(id INTEGER PRIMARY KEY, pattern TEXT)")
c.execute("CREATE TABLE compression_combos(id INTEGER PRIMARY KEY)")
c.executemany("INSERT INTO combos(name) VALUES(?)", [("a",),("b",),("c",)])
c.commit()   # left in the -wal, exactly like a live OmniRoute
PYFIX
    _eq "db_tables lists real tables"     "combos compression_combos model_combo_mappings" \
        "$(db_tables "$DB" | tr '\n' ' ' | sed 's/ $//')"
    _eq "db_count reads a real count"     "3" "$(db_count "$DB" combos)"
    _eq "db_count on empty table"         "0" "$(db_count "$DB" model_combo_mappings)"
    # An absent table must be UNREADABLE, never a number — this is the NA/NA class.
    local mrc=0; db_count "$DB" no_such_table >/dev/null 2>&1 || mrc=$?
    _eq "db_count on missing table fails"  "fails" "$([ "$mrc" -ne 0 ] && echo fails || echo silent)"

    # THE regression the operator's guidance exists to prevent: rows committed to the
    # -wal are invisible to a cp of the main file. .backup() must capture all three.
    local BKD="$tmp/realbk"; mkdir -p "$BKD"
    db_backup "$DB" "$BKD/out.sqlite" >/dev/null 2>&1
    local brc=0; sqlite_file_ok "$BKD/out.sqlite" || brc=$?
    _eq "real backup is a valid sqlite file" "0" "$brc"
    _eq "backup captured the WAL rows"       "3" "$(db_count "$BKD/out.sqlite" combos)"
    _eq "backup integrity_check"             "ok" "$(db_integrity "$BKD/out.sqlite")"
    # Paths go via argv on this engine, so a quote is a non-event rather than a refusal.
    db_backup "$DB" "$BKD/it's.sqlite" >/dev/null 2>&1
    local qrc=0; sqlite_file_ok "$BKD/it's.sqlite" || qrc=$?
    _eq "quoted backup path is safe on python" "0" "$qrc"
    _eq "file_sha256 is 64 hex chars" "64" "$(file_sha256 "$BKD/out.sqlite" | tr -d '\n' | wc -c)"

    # Full backup_and_verify, the whole guard, against the live WAL database.
    local BP_OLD="$COMBO_BACKUP_DIR"
    COMBO_BACKUP_DIR="$tmp/bv"
    local vrc=0
    ( OMNIROUTE_SQLITE="$DB" backup_and_verify "selftest" ) >/dev/null 2>&1 || vrc=$?
    _eq "backup_and_verify passes on a good db" "0" "$vrc"
    _eq "backup written 0600" "600" \
        "$(stat -c '%a' "$COMBO_BACKUP_DIR"/storage.*.selftest.sqlite 2>/dev/null | head -1)"
    # And it must REFUSE when the assumed tables are absent, rather than counting nothing.
    local trc=0
    ( OMNIROUTE_SQLITE="$DB" COMBO_DB_TABLES="Combo ModelComboMapping" \
        backup_and_verify "selftest" ) >/dev/null 2>&1 || trc=$?
    _eq "backup_and_verify refuses wrong tables" "fails" \
        "$([ "$trc" -ne 0 ] && echo fails || echo silent)"
    COMBO_BACKUP_DIR="$BP_OLD"
  else
    log "  SKIP  python3 unavailable; engine tests not run"
  fi

  echo "empty allowlist denies everything:"
  : > "$COMBO_ALLOWLIST_FILE"
  _case  "empty allowlist, previously-ok id"    refuse "ocgo/glm-5"
  _vcase "empty allowlist, previously-ok spec"  refuse \
    '{"name":"two/ok","strategy":"fill-first","models":[{"kind":"model","model":"ocgo/glm-5","providerId":"opencode-go"}]}'

  # ---------------------------------------------------------------- [RESOLVED-3]
  # Envelope handling. Asserted on EXIT STATUS, never on printed text: json_list_strict
  # runs inside $( ), where a refusal that only prints is a refusal that does not stop
  # anything. That distinction is the bug this suite exists to keep out.
  echo "response envelope (RESOLVED-3):"
  # Invoked EXACTLY as production does: set API_BODY, call with no stdin. Do not
  # "helpfully" pipe the body in — that is what hid the stdin bug the first time.
  _ecase() { local nm="$1" expect="$2" body="$3" want="${4:-}" rc=0 out=""
    out="$(API_BODY="$body" json_list_strict "combos" 2>/dev/null </dev/null)" || rc=$?
    local got=parse; [ "$rc" -ne 0 ] && got=refuse
    if [ "$got" != "$expect" ]; then
      fail=$((fail+1)); c_red "  FAIL  $nm expected=$expect got=$got (rc=$rc)"; return
    fi
    if [ "$expect" = "parse" ] && [ -n "$want" ] && [ "$(jq -c 'map(.name)' <<<"$out")" != "$want" ]; then
      fail=$((fail+1)); c_red "  FAIL  $nm parsed wrong: $(jq -c 'map(.name)' <<<"$out") != $want"; return
    fi
    pass=$((pass+1)); printf '  PASS  %-46s %s\n' "$nm" "$got"; }
  _ecase "expected {combos,total}"       parse  '{"combos":[{"name":"two/a"}],"total":1}' '["two/a"]'
  _ecase "combos + computed field"       parse  '{"combos":[{"name":"two/a","computed_context_length":128000}],"total":1}' '["two/a"]'
  _ecase "tolerated {data:[...]}"        parse  '{"data":[{"name":"two/b"}]}'             '["two/b"]'
  _ecase "tolerated bare array"          parse  '[{"name":"two/c"}]'                      '["two/c"]'
  _ecase "empty combos is a real answer" parse  '{"combos":[],"total":0}'                 '[]'
  _ecase "error envelope {error}"        refuse '{"error":"nope"}'
  _ecase "unknown object envelope"       refuse '{"items":[{"name":"two/d"}]}'
  _ecase "combos present but not array"  refuse '{"combos":"two/a","total":1}'
  _ecase "scalar body"                   refuse '"hello"'

  # ---------------------------------------------------------------- [RESOLVED-1]
  # Log shape. The provisioner's field names are the contract; assert them by name so
  # a future rename has to be deliberate.
  echo "mutation log shape (RESOLVED-1):"
  ( COMBO_REASON="test reason" COMBO_REQUEST_AGENT="agent-123" \
    COMBO_REQUEST_TEMPLATE="ciso" COMBO_REQUEST_ID="req-9" MGMT_CRED_CLASS="manage-api-key" \
    audit "combo_apply" "written" '{"combo":"c1"}' '{"id":"c1","strategy":"priority"}' '{"id":"c1","strategy":"fill-first"}' )
  local logline; logline="$(tail -n1 "$COMBO_LOG_FILE")"
  _fcase() { local nm="$1" filter="$2"
    if jq -e "$filter" >/dev/null 2>&1 <<<"$logline"; then
      pass=$((pass+1)); printf '  PASS  %-46s %s\n' "$nm" "ok"
    else fail=$((fail+1)); c_red "  FAIL  $nm — filter '$filter' false on: $logline"; fi; }
  _fcase "one JSON object per line"       'type=="object"'
  _fcase "event (provisioner 722/722)"    '.event=="combo_apply"'
  _fcase "callerAgentId is the AGENT"     '.callerAgentId=="agent-123"'
  _fcase "callerTemplate"                 '.callerTemplate=="ciso"'
  _fcase "reason"                         '.reason=="test reason"'
  _fcase "by is the operator"             '(.by|type)=="string" and (.by|length)>0'
  _fcase "requestId"                      '.requestId=="req-9"'
  _fcase "previousCombo (=previousGrants)" '.previousCombo.strategy=="priority"'
  _fcase "newCombo (=newGrants)"          '.newCombo.strategy=="fill-first"'
  _fcase "credentialClass, never the key" '.credentialClass=="manage-api-key"'
  _fcase "no secret-shaped field leaked"  '(keys - ["ts","tool","version","event","callerAgentId","callerTemplate","reason","by","outcome","requestId","requestIssue","credentialClass","previousCombo","newCombo","detail"])|length==0'
  if [ "$(stat -c '%a' "$COMBO_LOG_FILE" 2>/dev/null || echo '?')" = "600" ]; then
    pass=$((pass+1)); printf '  PASS  %-46s %s\n' "log file mode is 0600" "ok"
  else fail=$((fail+1)); c_red "  FAIL  log file mode is not 0600"; fi

  echo "mutations require a reason (RESOLVED-1):"
  local rrc=0; ( COMBO_REASON="" require_reason ) >/dev/null 2>&1 || rrc=$?
  if [ "$rrc" -ne 0 ]; then pass=$((pass+1)); printf '  PASS  %-46s %s\n' "empty reason is rejected" "refuse"
  else fail=$((fail+1)); c_red "  FAIL  empty reason was accepted"; fi

  # ---------------------------------------------------------------- [RESOLVED-8]
  # Audit-write failure. audit() runs after the API write, so these paths decide
  # whether an unlogged mutation is announced or buried. Before the fix, an
  # unwritable log produced a bare "Permission denied" AFTER the combo had been
  # written, with nothing saying so; a malformed field produced a jq usage dump.
  echo "audit-write failure is loud, not bare (RESOLVED-8):"
  local adir; adir="$(mktemp -d)"

  _acase() { local nm="$1" want_rc="$2"; shift 2
    local out rc=0
    out="$( "$@" 2>&1 )" || rc=$?
    if [ "$rc" = "$want_rc" ]; then pass=$((pass+1)); printf '  PASS  %-46s rc=%s\n' "$nm" "$rc"
    else fail=$((fail+1)); c_red "  FAIL  $nm — rc=$rc want=$want_rc: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-160)"; fi; }
  _agrep() { local nm="$1" pat="$2"; shift 2
    local out; out="$( "$@" 2>&1 )" || true
    if printf '%s' "$out" | grep -qF "$pat"; then pass=$((pass+1)); printf '  PASS  %-46s %s\n' "$nm" "ok"
    else fail=$((fail+1)); c_red "  FAIL  $nm — no '$pat' in: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-200)"; fi; }

  # Pure path classifier.
  _prc() { local f="$1"; local r=0; ( COMBO_LOG_FILE="$f" audit_log_path_ok ) || r=$?; printf '%s' "$r"; }
  : > "$adir/real.jsonl"; ln -sf "$adir/real.jsonl" "$adir/link.jsonl"
  for _t in "real.jsonl:0" "link.jsonl:3"; do
    local _f="${_t%%:*}" _w="${_t##*:}" _g; _g="$(_prc "$adir/$_f")"
    if [ "$_g" = "$_w" ]; then pass=$((pass+1)); printf '  PASS  %-46s rc=%s\n' "audit_log_path_ok $_f" "$_g"
    else fail=$((fail+1)); c_red "  FAIL  audit_log_path_ok $_f rc=$_g want=$_w"; fi
  done
  local _g; _g="$(_prc "")"
  if [ "$_g" = "2" ]; then pass=$((pass+1)); printf '  PASS  %-46s rc=2\n' "audit_log_path_ok empty path"
  else fail=$((fail+1)); c_red "  FAIL  audit_log_path_ok empty path rc=$_g want=2"; fi

  # A symlink must be refused, and the file it points at must be untouched. The old
  # code chmod'd a 0644 victim to 0600 and appended the audit record to it.
  printf 'PREEXISTING\n' > "$adir/victim.txt"; chmod 0644 "$adir/victim.txt"
  ln -sf "$adir/victim.txt" "$adir/vlink.jsonl"
  local slrc=0
  ( COMBO_LOG_FILE="$adir/vlink.jsonl" assert_audit_log_writable "apply" ) >/dev/null 2>&1 || slrc=$?
  if [ "$slrc" = "3" ]; then pass=$((pass+1)); printf '  PASS  %-46s rc=3\n' "symlink log path is refused"
  else fail=$((fail+1)); c_red "  FAIL  symlink log path rc=$slrc want=3 (policy refusal)"; fi
  if [ "$(stat -c '%a' "$adir/victim.txt")" = "644" ] && [ "$(wc -l < "$adir/victim.txt")" = "1" ]; then
    pass=$((pass+1)); printf '  PASS  %-46s %s\n' "symlink target left unmodified" "644, 1 line"
  else fail=$((fail+1)); c_red "  FAIL  symlink target was modified: mode=$(stat -c '%a' "$adir/victim.txt") lines=$(wc -l < "$adir/victim.txt")"; fi

  # Malformed field: exit 6, never a raw jq usage dump.
  local mrc=0; ( COMBO_LOG_FILE="$adir/m.jsonl" audit "combo_apply" "written" '{oops' ) >/dev/null 2>&1 || mrc=$?
  if [ "$mrc" = "6" ]; then pass=$((pass+1)); printf '  PASS  %-46s rc=6\n' "malformed detail -> audit_failed"
  else fail=$((fail+1)); c_red "  FAIL  malformed detail rc=$mrc want=6"; fi

  # Unwritable directory, file absent — the reachable production trigger.
  mkdir -p "$adir/ro"; chmod 0500 "$adir/ro"
  local urc=0; ( COMBO_LOG_FILE="$adir/ro/log.jsonl" audit "combo_apply" "written" '{"combo":"c1"}' ) >/dev/null 2>&1 || urc=$?
  if [ "$urc" = "6" ]; then pass=$((pass+1)); printf '  PASS  %-46s rc=6\n' "unwritable log dir -> audit_failed"
  else fail=$((fail+1)); c_red "  FAIL  unwritable log dir rc=$urc want=6 (root ignores 0500?)"; fi

  # The words that matter. A post-mutation failure must say the mutation stands.
  _postfail() { ( COMBO_LOG_FILE="$adir/ro/log.jsonl" MUTATION_APPLIED=1 BACKUP_PATH="/bk/x.sqlite" \
                  audit "combo_apply" "written" '{"combo":"c1"}' ) 2>&1 || true; }
  _prefail()  { ( COMBO_LOG_FILE="$adir/ro/log.jsonl" MUTATION_APPLIED=0 \
                  audit "run_start" "ok" '{"subcommand":"apply"}' ) 2>&1 || true; }
  _agrep "post-mutation says MUTATION WAS APPLIED" "THE MUTATION WAS APPLIED AND IS NOT IN THE LOG." _postfail
  _agrep "post-mutation names the backup"          "/bk/x.sqlite"                                    _postfail
  _agrep "pre-mutation says nothing is unrecorded" "nothing is unrecorded"                           _prefail
  local pre_out; pre_out="$(_prefail)"
  if printf '%s' "$pre_out" | grep -qF "THE MUTATION WAS APPLIED"; then
    fail=$((fail+1)); c_red "  FAIL  pre-mutation failure wrongly claims a mutation was applied"
  else pass=$((pass+1)); printf '  PASS  %-46s %s\n' "pre-mutation does NOT claim a mutation" "ok"; fi

  # The handed-back line must be valid JSON, or "append it by hand" is not an
  # instruction the operator can follow.
  local recov; recov="$(_postfail | grep '^{' | tail -n1)"
  if [ -n "$recov" ] && jq -e 'type=="object" and .event=="combo_apply"' >/dev/null 2>&1 <<<"$recov"; then
    pass=$((pass+1)); printf '  PASS  %-46s %s\n' "recovery line is valid, pasteable JSON" "ok"
  else fail=$((fail+1)); c_red "  FAIL  recovery line not usable JSON: ${recov:0:120}"; fi

  # Preflight must leave a run_start record, and create the file 0600 under a loose umask.
  local frc=0; ( umask 000; COMBO_LOG_FILE="$adir/fresh.jsonl" assert_audit_log_writable "apply" ) >/dev/null 2>&1 || frc=$?
  if [ "$frc" = "0" ] && jq -e '.event=="run_start" and .detail.subcommand=="apply"' >/dev/null 2>&1 <<<"$(tail -n1 "$adir/fresh.jsonl" 2>/dev/null)"; then
    pass=$((pass+1)); printf '  PASS  %-46s %s\n' "preflight writes a run_start record" "ok"
  else fail=$((fail+1)); c_red "  FAIL  preflight wrote no usable run_start record (rc=$frc)"; fi
  if [ "$(stat -c '%a' "$adir/fresh.jsonl" 2>/dev/null || echo '?')" = "600" ]; then
    pass=$((pass+1)); printf '  PASS  %-46s %s\n' "new log is 0600 despite umask 000" "ok"
  else fail=$((fail+1)); c_red "  FAIL  new log mode $(stat -c '%a' "$adir/fresh.jsonl" 2>/dev/null) under umask 000"; fi

  chmod 0700 "$adir/ro" 2>/dev/null || true; rm -rf "$adir"
  rrc=0; ( COMBO_REASON="because" COMBO_REQUEST_AGENT="a1" require_reason ) >/dev/null 2>&1 || rrc=$?
  if [ "$rrc" -eq 0 ]; then pass=$((pass+1)); printf '  PASS  %-46s %s\n' "reason + agent is accepted" "allow"
  else fail=$((fail+1)); c_red "  FAIL  valid reason was rejected (rc=$rrc)"; fi

  # ---------------------------------------------------------------- [RESOLVED-2]
  echo "management credential (RESOLVED-2):"
  local acode=0
  ( MGMT_TOKEN="x" api GET "/api/auth/login" ) >/dev/null 2>&1 || acode=$?
  if [ "$acode" -eq 3 ]; then pass=$((pass+1)); printf '  PASS  %-46s %s\n' "/api/auth/login is out of scope" "refuse"
  else fail=$((fail+1)); c_red "  FAIL  /api/auth/login was not refused (rc=$acode)"; fi
  # Patterns are assembled from fragments and matched against NON-COMMENT lines only.
  # A literal pattern here would match the assertion's own source line and a plain
  # grep of the whole file would match the prose in the header — both would make this
  # test fail forever and teach nothing. The claim is "no such CODE", not "no such
  # word".
  local pw_pat="MANAGEMENT""_PASSWORD" ck_pat="MGMT""_COOKIE" cj_pat="cookie""-jar"
  if ! grep -v '^[[:space:]]*#' "$0" | grep -qE "${pw_pat}|${ck_pat}|${cj_pat}"; then
    pass=$((pass+1)); printf '  PASS  %-46s %s\n' "no password/cookie path remains" "ok"
  else fail=$((fail+1)); c_red "  FAIL  a password or cookie auth path is still present in executable code"; fi
  local ccode=0
  ( OMNIROUTE_MANAGEMENT_KEY="" OMNIROUTE_ENV_FILE="$tmp/nonexistent.env" mgmt_auth ) >/dev/null 2>&1 || ccode=$?
  if [ "$ccode" -ne 0 ]; then pass=$((pass+1)); printf '  PASS  %-46s %s\n' "missing credential fails closed" "ok"
  else fail=$((fail+1)); c_red "  FAIL  mgmt_auth succeeded with no credential"; fi
  ( OMNIROUTE_MANAGEMENT_KEY="oma_abc" mgmt_auth >/dev/null 2>&1; [ "$MGMT_CRED_CLASS" = "scoped-access-token" ] ) \
    && { pass=$((pass+1)); printf '  PASS  %-46s %s\n' "oma_ token classed as scoped, not manage" "ok"; } \
    || { fail=$((fail+1)); c_red "  FAIL  oma_ token was not classed as a scoped access token"; }

  # ---------------------------------------------------------------- [RESOLVED-4]
  # No override flag may exist for nested members. This asserts on the source itself,
  # because the risk is a future edit adding one, not today's behaviour.
  echo "no nesting override exists (RESOLVED-4):"
  local ov_pat="allow""[_-]?nested|follow""[_-]combos|permit""[_-]combo[_-]members"
  if ! grep -v '^[[:space:]]*#' "$0" | grep -qiE "$ov_pat"; then
    pass=$((pass+1)); printf '  PASS  %-46s %s\n' "no nested-member override flag" "ok"
  else fail=$((fail+1)); c_red "  FAIL  a nested-member override flag has been added — remove it"; fi

  # ---------------------------------------------------------------- [RESOLVED-5]
  # Both live error envelopes, captured verbatim from the instance on 2026-08-23.
  # These are fixtures, not synthetic shapes I invented — the point of the test is
  # that the parser handles what the server ACTUALLY sends on each port.
  echo "error envelopes, both ports (RESOLVED-5):"
  local flat_err nest_err raw_err
  # The wrong-port 404. Asserting on .message specifically: parsing this to the bare
  # "not_found" is what the first cut did, and it threw away the one sentence that
  # tells the operator what is actually wrong.
  flat_err="$(printf '%s' '{"error":"not_found","message":"API port only serves OpenAI-compatible routes."}' | api_error_text)"
  case "$flat_err" in
    "not_found: API port only serves OpenAI-compatible routes.")
      pass=$((pass+1)); printf '  PASS  %-46s %s\n' "{error:string} keeps .message diagnostic" "ok" ;;
    *) fail=$((fail+1)); c_red "  FAIL  flat error envelope parsed as '$flat_err'" ;;
  esac
  # A route-handler error with no .message must not grow a trailing separator.
  if [ "$(printf '%s' '{"error":"combo not found"}' | api_error_text)" = "combo not found" ]; then
    pass=$((pass+1)); printf '  PASS  %-46s %s\n' "bare {error:string} unchanged" "ok"
  else fail=$((fail+1)); c_red "  FAIL  bare {error:string} was mangled"; fi

  # Management port 401 is AUTH_001 and nested — NOT {error:string}. Asserting it
  # here because this file previously recorded the management port as flat-only.
  if printf '%s' '{"error":{"code":"AUTH_001","message":"Authentication required","correlation_id":"611ab537-6b6a-48f4-a518-28ba6bf105cc"}}' \
       | api_error_text | grep -q 'AUTH_001.*correlation_id=611ab537'; then
    pass=$((pass+1)); printf '  PASS  %-46s %s\n' "management 401 nested envelope parsed" "ok"
  else fail=$((fail+1)); c_red "  FAIL  management nested 401 envelope not parsed"; fi

  nest_err="$(printf '%s' '{"error":{"code":"AUTH_002","message":"Authentication required","correlation_id":"912b21c1-3a51-41a7-aff1-75df672e9a5e"}}' | api_error_text)"
  case "$nest_err" in
    *AUTH_002*"Authentication required"*correlation_id=912b21c1*)
      pass=$((pass+1)); printf '  PASS  %-46s %s\n' "/v1 nested error + correlation_id kept" "ok" ;;
    *) fail=$((fail+1)); c_red "  FAIL  nested error envelope parsed as '$nest_err'" ;;
  esac

  # An unrecognised body must still surface something. Silently empty error text is
  # how a real failure gets reported as a blank line and then ignored.
  raw_err="$(printf '%s' '<html>502 Bad Gateway</html>' | api_error_text)"
  if [ -n "$raw_err" ]; then
    pass=$((pass+1)); printf '  PASS  %-46s %s\n' "unrecognised body falls back to raw" "ok"
  else fail=$((fail+1)); c_red "  FAIL  unrecognised error body produced empty text"; fi

  # check-endpoints must never put a credential on the wire — that is its entire
  # reason for existing, and a future edit "helpfully" adding auth would defeat it.
  local ce_src; ce_src="$(sed -n '/^cmd_check_endpoints()/,/^}/p' "$0" | grep -v '^[[:space:]]*#')"
  local auth_pat="Authorization""|MGMT_TOKEN|OMNIROUTE_MANAGEMENT_KEY|--config"
  if ! printf '%s' "$ce_src" | grep -qE "$auth_pat"; then
    pass=$((pass+1)); printf '  PASS  %-46s %s\n' "check-endpoints sends no credential" "ok"
  else fail=$((fail+1)); c_red "  FAIL  check-endpoints now references a credential — it must probe unauthenticated"; fi

  rm -rf "$tmp"
  echo
  if [ "$fail" -eq 0 ]; then c_grn "selftest: ${pass} passed, 0 failed"; return 0
  else c_red "selftest: ${pass} passed, ${fail} FAILED"; return 1; fi
}

usage() {
  cat <<EOF
$PROG $VERSION — constrained OmniRoute combo/mapping manager (operator-run)

  selftest                     offline proof of the containment logic. Run this first.
  validate       <spec.json>   offline schema + containment check. No network, no DB.
                               Does NOT check the live catalogue — see dry-run.
  dry-run        <spec.json>   validate + LIVE catalogue check, print the resulting
                               combo. Applies nothing, touches no database.
  apply          <spec.json>   validate + LIVE catalogue check, backup+verify, write,
                               then READ BACK AND ASSERT.
  list                         list combos
  delete         <combo-name>  backup+verify, delete, verify absence
  map-list                     list model_combo_mappings in resolution order
  map-apply      <spec.json>   create a mapping (backup + read-back asserts the row
                               THIS write created, and its pattern/comboId/priority/
                               enabled; warns first if the pattern already exists)
  map-delete     <mapping-id>  delete a mapping (backup + read-back verifies absence)
  allowlist-scaffold           emit a CANDIDATE allowlist from /v1/models for review
  allowlist-audit              re-check the reviewed allowlist against the live
                               catalogue: withdrawn ids, newly-blended routes.
                               Read-only; safe to run on a schedule. Exit 5 if stale.
  check-endpoints              probe both URLs and report which of host, port or
                               credential is wrong. Sends NO credential, so it is
                               safe to run against a URL you do not trust yet.
                               A 401 is a PASS: the endpoint is enforcing auth.

Global flags (before or after the subcommand):
  --reason <text>            why this change is being made. REQUIRED for every
                             mutation; lands in the log's 'reason' field.
  --agent <agent-id>         the agent that proposed this change -> 'callerAgentId'.
  --template <role>          that agent's role template -> 'callerTemplate'.
  --request <request-id>     org_request_queue.sh request being applied.
  --allow-rebind             permit an update that CHANGES or DROPS an existing leg's
                             connectionId. Without it, such an update is refused:
                             'apply' is a full replace, so a spec that omits a
                             connectionId the stored combo has would silently move
                             that leg to a different connection. Not a containment
                             override — it guards data loss, and rebinding is a
                             legitimate thing to do out loud. Also required to MOVE a
                             binding between legs: leg order is the routing order, so
                             swapping which connection serves first is a real change.
  --allow-reorder            accept a read-back where OmniRoute stored the members in a
                             different ORDER than they were sent. Without it that is a
                             mismatch (exit 4), because for priority/fill-first/
                             context-relay/pipeline the list order is the routing order.
                             Whether this server preserves order is not yet known; the
                             first live apply is what settles it.

KNOWN UNMANAGEABLE: context_cache_protection exists as a combos column and in
OmniRoute's code but is absent from the management API payload at every privilege
level, so no API-based tool can read or set it. Changing it is a direct-database
operation under ROLLBACK.md.

TWO CREDENTIALS, DIFFERENT SCOPES — do not conflate them:
  OMNIROUTE_MANAGEMENT_KEY   an API key with 'manage' or 'admin' scope. Sent as
                             Authorization: Bearer (requireManagementAuth type #4).
                             Needed only by apply/list/delete/map-*. Written to a
                             0600 curl --config file, NEVER to argv.
  OMNIROUTE_API_KEY          an ordinary READ key, for the /v1/models catalogue only.

The live catalogue is READ AT RUNTIME from \$OMNIROUTE_MODELS_URL and is never bundled
with this script. dry-run, apply, allowlist-scaffold and allowlist-audit all need it
and all FAIL CLOSED without it. Give them a READ key in OMNIROUTE_API_KEY, or point
COMBO_CATALOGUE_FILE at a snapshot you captured yourself (audited, and warned about,
because a snapshot goes stale).

Env: OMNIROUTE_BASE_URL OMNIROUTE_ENV_FILE OMNIROUTE_SQLITE OMNIROUTE_MANAGEMENT_KEY
     OMNIROUTE_MODELS_URL OMNIROUTE_API_KEY (read scope) COMBO_CATALOGUE_FILE
     COMBO_ALLOWLIST_FILE COMBO_BACKUP_DIR COMBO_LOG_FILE COMBO_OWNED_PREFIX
     COMBO_REASON COMBO_REQUEST_AGENT COMBO_REQUEST_TEMPLATE COMBO_REQUEST_ID
     COMBO_REQUEST_ISSUE COMBO_DB_TABLES

COMBO_DB_TABLES defaults to "combos model_combo_mappings". These are CONFIRMED against
the real storage.sqlite (operator, 2026-08-23) in a schema of 118 tables. The backup
verification counts rows in exactly these names; if they ever differ the tool stops and
prints the actual table list rather than verifying nothing. Four neighbours are NOT the
combo tables and must never be matched by a glob: compression_combos,
compression_combo_assignments, combo_adaptation_state, agent_bridge_mappings.

SQLITE ENGINE: there is no sqlite3 BINARY on the operator's host or in the omniroute
container. The backup uses python3's stdlib sqlite3 .backup() — atomic, WAL-safe, and
it does not lock the live database. The sqlite3 binary is a fallback if it is present.
If NEITHER exists the tool REFUSES to mutate; a missing engine never degrades into
proceeding without a backup. Never cp storage.sqlite: it runs in WAL mode, and a cp of
the main file alone omits everything still in the -wal while integrity_check still
answers 'ok' on the result.

Exit codes: 0 ok  1 error  3 policy refusal  4 read-back mismatch (mutation may stand)
            5 allowlist stale vs live catalogue (allowlist-audit only)
            6 audit log write failed. If it says THE MUTATION WAS APPLIED, a routing
              change is live and unrecorded: append the printed line to the log by
              hand. A mutating run now writes a 'run_start' record during preflight,
              so an unwritable log stops the run BEFORE the backup and the write.
EOF
}

# ================================================================= CHECK-ENDPOINTS
# [RESOLVED-5] The two URLs this tool uses are on DIFFERENT PORTS serving DIFFERENT
# route families, and pointing either at the other produces a confusing failure.
# Verified against the live instance, 2026-08-23:
#     :20128 (management)  /api/combos -> 401 unauthenticated   {error: string}
#     :20129 (OpenAI)      /api/combos -> 404 "API port only serves OpenAI-compatible
#                                              routes."
#     :20129 (OpenAI)      /v1/models  -> 401 {error:{code:AUTH_002,message,
#                                              correlation_id}}
# So an unauthenticated probe alone tells the operator which of host, port and
# credential is wrong, before any credential is put on the wire.
#
# THIS COMMAND DELIBERATELY SENDS NO CREDENTIAL. Its whole purpose is to run when you
# suspect a URL is wrong, and shipping a manage-scoped key at a URL you do not trust
# yet is the one thing you must not do while debugging one. A 401 here is SUCCESS: it
# proves the endpoint is the real OmniRoute and is enforcing auth.
cmd_check_endpoints() {
  need curl
  local rc=0

  _probe() {  # label url expectation
    local label="$1" url="$2" want="$3"
    local out code body cerr
    out="$(curl -s -S --max-time "$CURL_TIMEOUT" -w '\n%{http_code}' "$url" 2>&1)" && cerr=0 || cerr=$?
    if [ "$cerr" -ne 0 ]; then
      c_red "  $label  UNREACHABLE  ($url)"
      log   "         curl exit $cerr — $(printf '%s' "$out" | tr -d '\r' | tail -1)"
      log   "         Host or port is wrong, or OmniRoute is not listening. NOTE: the"
      log   "         container-network alias ('omniroute') and the host loopback"
      log   "         ('127.0.0.1') are NOT interchangeable — this tool runs on the"
      log   "         HOST, so 127.0.0.1 is the expected default here."
      rc=1; return 0
    fi
    code="${out##*$'\n'}"; body="${out%$'\n'*}"
    case "$code" in
      401|403)
        c_grn "  $label  OK — reachable, auth enforced ($code)  $url"
        log   "         $(printf '%s' "$body" | api_error_text)" ;;
      200)
        c_grn "  $label  OK — reachable, and this probe was accepted unauthenticated ($code)  $url"
        c_ylw "         An unauthenticated 200 on a management route would be a finding. Verify this is the read path." ;;
      404)
        c_red "  $label  WRONG PORT ($code)  $url"
        log   "         $(printf '%s' "$body" | api_error_text)"
        log   "         Expected $want. Management routes and OpenAI-compatible routes"
        log   "         are on different ports; swap OMNIROUTE_BASE_URL/OMNIROUTE_MODELS_URL."
        rc=1 ;;
      *)
        c_ylw "  $label  UNEXPECTED $code  $url"
        log   "         $(printf '%s' "$body" | api_error_text)"
        rc=1 ;;
    esac
  }

  log "check-endpoints — read-only, and no credential is sent."
  # Echo the values actually in play. This command is only useful if it is run with
  # the SAME environment as the command that failed; printing the two URLs makes a
  # stale run self-evident instead of silently passing against the defaults.
  log "  OMNIROUTE_BASE_URL   = ${OMNIROUTE_BASE_URL}"
  log "  OMNIROUTE_MODELS_URL = ${OMNIROUTE_MODELS_URL}"
  log "  (if you source an env file, source it BEFORE this command, not after)"
  log ""
  _probe "management" "${OMNIROUTE_BASE_URL}/api/combos" "the management port"
  _probe "catalogue " "${OMNIROUTE_MODELS_URL}"          "the OpenAI-compatible port"
  log ""
  if [ "$rc" -eq 0 ]; then
    c_grn "Both endpoints resolve and enforce auth."
    log   "This does NOT prove your credential is accepted or correctly scoped —"
    log   "that needs one authenticated call. Run '$PROG list' for the cheapest one."
  else
    c_red "At least one endpoint is misconfigured; fix that before running anything else."
  fi
  return "$rc"
}

main() {
  # Provenance flags are global and order-independent so the operator can paste them
  # anywhere in the line. They are stripped before subcommand dispatch.
  local -a rest=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --reason)   COMBO_REASON="${2:?--reason needs a value}"; shift 2 ;;
      --agent)    COMBO_REQUEST_AGENT="${2:?--agent needs a value}"; shift 2 ;;
      --template) COMBO_REQUEST_TEMPLATE="${2:?--template needs a value}"; shift 2 ;;
      --request)  COMBO_REQUEST_ID="${2:?--request needs a value}"; shift 2 ;;
      --issue)    COMBO_REQUEST_ISSUE="${2:?--issue needs a value}"; shift 2 ;;
      --allow-rebind) COMBO_ALLOW_REBIND=1; shift ;;
      --allow-reorder) COMBO_ALLOW_REORDER=1; shift ;;
      --)         shift; rest+=( "$@" ); break ;;
      *)          rest+=( "$1" ); shift ;;
    esac
  done
  set -- "${rest[@]+"${rest[@]}"}"

  local sub="${1:-}"; shift || true
  PREFLIGHT_SUBCOMMAND="$sub"   # recorded in the run_start audit record
  case "$sub" in
    selftest)            preflight_offline; cmd_selftest "$@" ;;
    check-endpoints)     preflight_online;  cmd_check_endpoints "$@" ;;
    validate)            preflight_offline; cmd_validate "$@" ;;
    dry-run|dryrun)      preflight_online;  cmd_dry_run "$@" ;;
    apply)               preflight_mutate;  cmd_apply "$@" ;;
    list)                preflight_online;  cmd_list "$@" ;;
    delete)              preflight_mutate;  cmd_delete "${1:?combo name required}" ;;
    map-list)            preflight_online;  cmd_map_list "$@" ;;
    map-apply)           preflight_mutate;  cmd_map_apply "$@" ;;
    map-delete)          preflight_mutate;  cmd_map_delete "${1:?mapping id required}" ;;
    allowlist-scaffold)  preflight_online;  cmd_allowlist_scaffold "$@" ;;
    allowlist-audit)     preflight_online;  cmd_allowlist_audit "$@" ;;
    ''|-h|--help|help)   usage ;;
    *)                   usage; die "unknown subcommand '$sub'" ;;
  esac
}

main "$@"
