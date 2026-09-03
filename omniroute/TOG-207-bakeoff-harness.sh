#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# TOG-207 — bake-off harness, Rev 5.
#
# ─────────────────────────────────────────────────────────────────────────────
# REV 5 (TOG-214). GUARD 2 WAS VACUOUS ON THE A-ARMS. Fixed here.
#
# Rev 3/Rev 4 specified G2 as "assert the echoed strategy equals the arm", reading
# `strategy=` out of the x-omniroute-decision response header. Measured live on 6/6
# probes (run 61c99472, TOG-152 doc `critical-path-correction` F-11), that header on a
# DIRECT completion reads:
#
#     x-omniroute-decision: strategy=single; provider=opencode-go; latency_ms=0
#
# `strategy=` is the COMBO strategy slot -- what applyStrategyOrdering ran over the LEGS.
# THE ACCOUNT STRATEGY IS NEVER ECHOED ANYWHERE: not in that header, not in the SSE
# trailer, not on any other response surface. And the account strategy is the ONLY thing
# A1-A5 vary (they hold the combo strategy at fill-first on purpose -- see below).
#
# So on an A-arm the old G2 compared a constant to a constant. It reported PASS while
# asserting nothing about the arm -- the same vacuous-assertion shape as the trap-test bug
# fixed in Rev 4, which is why it is being fixed the same way: with a hostile mock that
# makes the old assumption FAIL rather than a comment saying it is wrong.
#
# What Rev 5 changes, and nothing else:
#
#   G2   is now scoped to arms that VARY the combo strategy (B1-B3) and says so in its own
#        output on every arm where it does not apply. It can no longer return PASS from
#        zero observations: zero coverage is NOCOV, which is not a pass. `strategy=single`
#        is classified separately from a mismatch -- on a combo arm it means the combo did
#        not resolve at all, which is a louder failure than running the wrong strategy.
#
#   G2a  is new and is the A-arms' real assertion: GET /api/settings read-back of
#        providerStrategies['opencode-go'].fallbackStrategy taken IMMEDIATELY BEFORE the
#        arm's first request and IMMEDIATELY AFTER its last, both of which must equal the
#        arm's account strategy. G1b already read it once at set time; that does not cover
#        DRIFT DURING the window, and this setting is INSTANCE-GLOBAL -- another writer
#        moving it mid-arm silently re-labels every request in it. Before-only is how that
#        gets missed. An unreadable/absent value is a FAILURE, never an empty-string pass.
#
# Rev 5 does NOT reopen the Rev 4 route fixes (GET /api/providers, PUT /api/providers/{id},
# `name` not `account_label`) or the restore-trap suite. Those were verified against a
# hostile mock and stand.
#
# NOT CHANGED, DELIBERATELY: the A-arms still run through a combo. F-10 established that
# the account selector runs on the direct path and does not NEED one -- but the headline
# metric of this instrument is Go-vs-PAYG fallthrough, and a direct opencode-go request
# has no OpenRouter terminal leg to fall through TO. The combo stays because the
# measurement needs the leg list, not because the selector needs the combo.
# ─────────────────────────────────────────────────────────────────────────────
#
# Rev 3 was the revision TOG-207 specifies.
#
# Supersedes TOG-152-bakeoff-harness.sh. That file's internal header numbered itself
# "Rev 4" against a private lineage; TOG-207 numbers revisions against the DESIGN, and
# this is Rev 3 of the design (`8e442cc4-8c1e-4770-b9e2-1c83f0249b4b`). Same instrument,
# renumbered to the issue's scheme so child 3 and child 4 have one name to refer to.
#
# WHAT THIS IS. A measurement instrument for: does traffic stay on the pooled opencode-go
# plans, or fall through to paid OpenRouter inference while a plan still has headroom?
# It varies TWO selectors across eight arms and counts REQUESTS per provider and per
# connection.
#
# ═════════════════════════════════════════════════════════════════════════════
# ⚠ READ THIS BEFORE RUNNING. Two facts decide whether you can run it at all.
#
# 1. IT NEEDS A MANAGEMENT TOKEN. `:20128/api/*` returns 403 AUTH_001 to an agent key --
#    management is a separate token class, not a scope an agent lacks. Verified again
#    2026-08-23 from the agent container. So this is run management-side, by the Operator
#    or by anything holding OMNIROUTE_MGMT_TOKEN.
#
# 2. IT MUTATES TWO PIECES OF INSTANCE-GLOBAL STATE that other companies' traffic reads:
#      (a) settings.providerStrategies['opencode-go'].fallbackStrategy   -- per arm
#      (b) provider_connections.priority on both Go connections          -- G9 fixture
#    Neither is additive. Both are captured before the first mutation and restored by a
#    trap on EXIT/INT/TERM/HUP, and by a standalone restore script written to disk BEFORE
#    the first mutation for the SIGKILL case no trap can cover. The honest scope of that
#    guarantee is spelled out at G12 -- read it, it is the condition the Operator attached.
#
# ═════════════════════════════════════════════════════════════════════════════
# WHY THE ARM MATRIX LOOKS LIKE THIS (all traced from OmniRoute 3.8.49 source;
# `npm pack omniroute@3.8.49` ships unminified TS. Full citations in
# TOG-152-bakeoff-design-rev3.md.)
#
#   * TWO SELECTORS, NOT ONE. With a single opencode-go leg, the choice between `main`
#     and `main-2` is not made by the combo strategy. It is made by the ACCOUNT selector,
#     src/sse/services/auth.ts:1489:
#         const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy
#                          || "fill-first";
#     The default is `fill-first`, NOT `priority`. An earlier revision set only
#     combos.strategy, leaving this constant across every arm -- six arms picking the same
#     connection for the same reason, reported as a ranking.
#
#   * TWO PINNED GO LEGS. executionKey is per combo STEP (comboStructure.ts:85) and
#     sortTargetsByUsage keys on it "unique per model + account" (targetSorters.ts:107).
#     Pinning each Go leg to a connectionId is what gives least-used / p2c / random /
#     strict-random genuine per-connection resolution. One leg cannot rotate.
#
#   * priority is NOT an arm. It is byte-identical to fill-first at BOTH levels (no
#     `priority` branch exists in applyStrategyOrdering.ts; auth.ts sends it to the
#     trailing else -> orderedConnections[0]). Running both would be two labels on one
#     behaviour, and G10 exists to stop exactly that being read as two ranks.
#
#   * THE A-ARMS HOLD COMBO STRATEGY AT fill-first ON PURPOSE. The combo strategy orders
#     the LEGS, and the leg list ends with the OpenRouter PAYG terminal. Any combo-level
#     strategy that genuinely reorders legs can rotate PAYG to the FRONT -- first attempts
#     going straight to paid inference while both Go plans sit idle. That is this task's
#     failure mode arrived at from the opposite direction. Watch B1's payg column.
#
# Usage:
#   OMNIROUTE_MGMT_TOKEN=... OMNIROUTE_API_KEY=... ./TOG-207-bakeoff-harness.sh [N_PER_ARM]
#
# Optional:
#   TOG207_CONN_COUNTS_CMD  command run as: $CMD <window_start> <window_end>
#                           must print TSV `connection_id<TAB>account_label<TAB>calls`.
#                           This is the G7 hook. Set it management-side (e.g. a sqlite3
#                           one-liner) and per-connection attribution + a full-strength
#                           G10 land in results.json automatically. Unset => those fields
#                           are null and G10 degrades to provider-level, explicitly.
#   TOG207_NORMALIZE_PRIORITY=1   let the harness WRITE the G9 priority normalisation
#                           (main=1, main-2=2) as a fixture it reverts on exit. Default
#                           is 0 = assert-only, because the Operator applied that
#                           normalisation persistently on 2026-08-23. Assert-only keeps
#                           priorities off the mutation surface entirely; only the
#                           account fallbackStrategy is ever written.
#   GO_CONN_MAIN / GO_CONN_MAIN2   override Go connection uuids if they are not named
#                           "main" / "main-2" on this instance.
# ═════════════════════════════════════════════════════════════════════════════

set -uo pipefail

MGMT="${OMNIROUTE_MGMT_TOKEN:?set OMNIROUTE_MGMT_TOKEN (management token, not an agent key)}"
APIKEY="${OMNIROUTE_API_KEY:?set OMNIROUTE_API_KEY (agent key, for the completion path)}"
MGMT_BASE="${OMNIROUTE_MGMT_BASE:-http://omniroute:20128}"
API_BASE="${OMNIROUTE_API_BASE:-http://omniroute:20129}"
N="${1:-40}"
OUT="${TOG207_OUT:-${PAPERCLIP_RUN_SCRATCH_DIR:-/tmp}/tog207-bakeoff}"
mkdir -p "$OUT"
RESULTS_JSON="$OUT/results.json"
RECORDS="$OUT/records.jsonl"
ARMS_JSONL="$OUT/arms.jsonl"
: > "$RECORDS"; : > "$ARMS_JSONL"

mgmt() { curl -sS -m 30 -H "Authorization: Bearer $MGMT" -H 'Content-Type: application/json' "$@"; }
say()  { printf '%s\n' "$*"; }
now()  { date -u +%Y-%m-%dT%H:%M:%SZ; }

# ── G0: at least two active opencode-go connections ──────────────────────────
#
# ROUTE CORRECTION (2026-08-23, TOG-152). Rev 3 of this harness used
# `GET/PATCH /api/provider-connections[/{id}]`. THAT ROUTE HAS NEVER EXISTED.
# The string "provider-connections" appears ZERO times in the whole omniroute@3.8.49
# package (src, dist and the Next.js route manifest), and the Operator measured it
# returning 404 on the live instance. The real surface is:
#
#     GET /api/providers          -> flat list of connection objects
#     PUT /api/providers/{id}     -> update  (PATCH returns 405, so a PATCH-shaped
#                                   assumption fails closed rather than silently)
#
# The label field was wrong too: `account_label`/`accountLabel` do not exist in the
# schema either. Connections are labelled by `name` (src/lib/db/providers.ts:592).
#
# Rev 3 passed 30/30 assertions because TOG-207-mock-omniroute.py was written from the
# same mental model and served the same invented route and field. A mock that agrees
# with the harness cannot falsify it. The mock now speaks the real dialect and 404s
# the invented one, so this class of error cannot pass again.
CONN_JSON="$OUT/connections.json"
CONN_CODE=$(mgmt -o "$CONN_JSON" -w '%{http_code}' "$MGMT_BASE/api/providers" 2>/dev/null)

# Separate "the route is wrong" from "the substrate is empty". Rev 3 reported a 404 as
# "0 active connections", which points the reader at the wrong problem entirely.
if [ "$CONN_CODE" != "200" ]; then
  say "G0 FAILED: GET $MGMT_BASE/api/providers -> HTTP ${CONN_CODE:-no-response}."
  say "  This is a ROUTE/AUTH failure, not a statement about how many connections exist."
  say "  Management is a separate token class: an agent key returns 403 AUTH_001 here."
  # F-25: an empty CONN_CODE means curl never got an HTTP response at all — usually
  # because MGMT_BASE defaults to the container-network alias `omniroute`, which
  # resolves inside the pod but not necessarily from the operator's host shell.
  # Distinguish that from an auth rejection and hand back a usable base.
  case "$CONN_CODE" in
    ""|000)
      say ""
      say "  No HTTP response — the base did not answer. Probing candidates:"
      for _c in "http://omniroute:20128" "http://localhost:20128" "http://127.0.0.1:20128" "https://router.example.net"; do
        _cc=$(curl -sS -m 8 -o /dev/null -w '%{http_code}' "$_c/api/providers" 2>/dev/null) || _cc=""
        if   [ -z "$_cc" ];      then printf '    %-32s unreachable\n' "$_c" >&2
        elif [ "$_cc" = "404" ]; then printf '    %-32s HTTP 404 — not a management surface\n' "$_c" >&2
        else                          printf '    %-32s HTTP %s  <-- usable base\n' "$_c" "$_cc" >&2; fi
      done
      say ""
      say "    export OMNIROUTE_MGMT_BASE=<one that answers>"
      say "  Or run: ./TOG-152-armswitch.sh checkbase   (zero-mutation, same probe)" ;;
    404)
      say ""
      say "  HTTP 404: MGMT_BASE is pointed at the COMPLETION surface (:20129)."
      say "  Management routes live only on :20128." ;;
  esac
  exit 3
fi

read -r GO_N MAIN_ID MAIN_PRIO MAIN2_ID MAIN2_PRIO <<<"$(python3 - "$CONN_JSON" <<'PY'
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: print("0 - - - -"); raise SystemExit
rows=d if isinstance(d,list) else (d.get("data") or d.get("connections") or d.get("providers") or [])
if not isinstance(rows,list): print("0 - - - -"); raise SystemExit
go=[r for r in rows if r.get("provider")=="opencode-go" and r.get("is_active", r.get("isActive",1))]
def f(r,*k):
    for x in k:
        if r.get(x) is not None: return r[x]
    return None
# `name` is the real label column; displayName is a UI override that may be unset.
by={ (f(r,"name","displayName") or "?"): r for r in go }
m,m2 = by.get("main"), by.get("main-2")
print(len(go),
      f(m,"id") if m else "-", f(m,"priority") if m else "-",
      f(m2,"id") if m2 else "-", f(m2,"priority") if m2 else "-")
PY
)"

MAIN_ID="${GO_CONN_MAIN:-$MAIN_ID}"; MAIN2_ID="${GO_CONN_MAIN2:-$MAIN2_ID}"

if ! [[ "$GO_N" =~ ^[0-9]+$ ]] || [ "$GO_N" -lt 2 ]; then
  say "G0 FAILED: active opencode-go connections = ${GO_N:-unknown} (need >= 2)."
  say "  SELECT COUNT(*) FROM provider_connections WHERE provider='opencode-go' AND is_active=1;"
  exit 3
fi

# The two Go connections must have resolved to real ids, or every later arm silently
# measures nothing. `-` here means the labels are not "main"/"main-2" on this instance.
if [ "$MAIN_ID" = "-" ] || [ "$MAIN2_ID" = "-" ]; then
  say "G0 FAILED: could not resolve both Go connections by name (main=$MAIN_ID main-2=$MAIN2_ID)."
  say "  Connections are matched on the \`name\` column. Override explicitly if they differ:"
  say "    GO_CONN_MAIN=<uuid> GO_CONN_MAIN2=<uuid> $0"
  exit 3
fi
say "G0 ok: $GO_N active opencode-go connections. main=$MAIN_ID(p=$MAIN_PRIO) main-2=$MAIN2_ID(p=$MAIN2_PRIO)"

# ═════════════════════════════════════════════════════════════════════════════
# G12 — PRE-STATE CAPTURE AND RESTORE.
#
# Operator condition on TOG-207, quoted: "Read and RECORD the pre-run value before the
# first arm. Restore it at the end AND on abort/failure -- not only on the happy path.
# Use a shell trap ... EXIT INT TERM, not a line at the bottom of the script. If
# restoration on abort cannot be GUARANTEED, say so in this issue and hand the setting
# changes to the Operator."
#
# THE HONEST ANSWER, because that condition was explicitly not a formality:
#
#   COVERED by the trap below -- normal exit, any non-zero exit, SIGINT (Ctrl-C),
#   SIGTERM, SIGHUP. Restore is idempotent and re-runnable. TESTED, not asserted:
#   see TOG-207-trap-test.sh, which kills a real run mid-arm with each signal and
#   diffs the resulting server state against the pre-run state.
#
#   NOT COVERABLE BY ANY TRAP -- SIGKILL, kill -9, OOM-kill, container stop, host
#   death. Bash cannot trap those and neither can anything else. Anyone claiming a
#   100% restore guarantee is wrong.
#
# So the trap is deliberately not the only mitigation. Before the first mutation this
# writes a standalone restore script carrying the literal pre-values, so a SIGKILLed run
# leaves a one-command recovery on disk instead of silent drift. Check for that file
# before assuming a previous run cleaned up after itself.
#
# It also REFUSES TO RUN if the pre-value cannot be read. Mutating state you cannot put
# back is not an experiment.
# ═════════════════════════════════════════════════════════════════════════════
mgmt "$MGMT_BASE/api/settings" > "$OUT/settings-before.json" 2>/dev/null
PRE_ACCT_STRATEGY=$(python3 - "$OUT/settings-before.json" <<'PY'
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: print('UNREADABLE'); raise SystemExit
s=d.get('data',d) if isinstance(d,dict) else d
ps=(s.get('providerStrategies') or {}).get('opencode-go') or {}
# Distinguish "explicitly set to X" from "absent, so the code default applies". Restoring
# an absent key by WRITING the default is not a restore -- it converts an unset field into
# a set one, which is a permanent change of a different kind.
print(ps.get('fallbackStrategy') or '__ABSENT__')
PY
)

if [ "$PRE_ACCT_STRATEGY" = "UNREADABLE" ] || [ -z "$PRE_ACCT_STRATEGY" ]; then
  say "G12 FAILED: could not read pre-run providerStrategies['opencode-go'].fallbackStrategy."
  say "  Refusing to mutate state this harness cannot put back. Fix the read, then re-run."
  exit 3
fi

# Condition 1, "RECORD": to disk, immediately, not just to a shell variable that dies
# with the process.
cat > "$OUT/pre-state.json" <<PRE
{
  "capturedAt": "$(now)",
  "accountFallbackStrategy": "$PRE_ACCT_STRATEGY",
  "connections": {
    "main":   {"id": "$MAIN_ID",  "priority": $MAIN_PRIO},
    "main-2": {"id": "$MAIN2_ID", "priority": $MAIN2_PRIO}
  }
}
PRE
say "G12: pre-run account fallbackStrategy = $PRE_ACCT_STRATEGY (main p=$MAIN_PRIO, main-2 p=$MAIN2_PRIO)"
say "G12: recorded -> $OUT/pre-state.json"

RESTORE_SH="$OUT/restore-tog207.sh"
cat > "$RESTORE_SH" <<RESTORE
#!/usr/bin/env bash
# TOG-207 pre-state restore. Generated BEFORE the first mutation, on purpose: if the
# harness is SIGKILLed its trap never runs, and this file is what puts the instance back.
# Idempotent -- safe to run more than once, and safe to run if nothing was changed.
set -uo pipefail
M="\${OMNIROUTE_MGMT_TOKEN:?set OMNIROUTE_MGMT_TOKEN}"
B="\${OMNIROUTE_MGMT_BASE:-$MGMT_BASE}"
m() { curl -sS -m 30 -H "Authorization: Bearer \$M" -H 'Content-Type: application/json' "\$@"; }
# PUT /api/providers/{id}, not PATCH /api/provider-connections/{id} (404 + 405 respectively).
# A partial PUT body is safe here: the route merges, it does not blank omitted columns --
# measured on the live instance, and worth stating because it is the OPPOSITE of the usual
# PUT semantics and the destructive reading would have wiped access_token/refresh_token.
#
# These two writes only fire if the harness itself changed priorities. It no longer does
# (see G9 below), so on a current run this is a no-op that re-asserts the same values.
pw() { # pw <id> <priority> <label>
  code=\$(m -o /dev/null -w '%{http_code}' -X PUT "\$B/api/providers/\$1" -d "{\"priority\":\$2}")
  [ "\$code" = "200" ] && echo "restored priority \$3=\$2" \
                       || echo "*** RESTORE FAILED *** \$3 priority -> HTTP \$code"
}
pw "$MAIN_ID"  "$MAIN_PRIO"  "main"
pw "$MAIN2_ID" "$MAIN2_PRIO" "main-2"
if [ "$PRE_ACCT_STRATEGY" = "__ABSENT__" ]; then
  echo "NOTE: providerStrategies['opencode-go'].fallbackStrategy was ABSENT before the run."
  echo "      Removing a key is not expressible through PATCH /api/settings, so this script"
  echo "      does NOT write one. Clear it directly if the absence matters:"
  echo "      UPDATE settings SET value=json_remove(value,'\\\$.providerStrategies.\"opencode-go\".fallbackStrategy');"
else
  m -X PATCH "\$B/api/settings" \\
    -d '{"providerStrategies":{"opencode-go":{"fallbackStrategy":"$PRE_ACCT_STRATEGY"}}}' >/dev/null
  echo "restored account fallbackStrategy: $PRE_ACCT_STRATEGY"
fi
RESTORE
chmod +x "$RESTORE_SH"
say "G12: wrote $RESTORE_SH (run it by hand if this process is SIGKILLed)"

CLEANED=0
CURL_PID=""
restore_pre_state() {
  [ "$CLEANED" = "1" ] && return 0
  CLEANED=1
  # Kill an in-flight request first. Without this the restore waits out curl's -m 90.
  [ -n "$CURL_PID" ] && kill "$CURL_PID" 2>/dev/null
  say ""
  say "G12: restoring pre-run state..."
  bash "$RESTORE_SH" || say "G12 *** RESTORE FAILED *** -- run $RESTORE_SH by hand NOW."

  # Bake-off combos are additive and temporary; sweep any this run created and did not
  # get to delete. The glob is our own bakeoff/ namespace only -- never auto/* or
  # hindsight/*.
  for cf in "$OUT"/create-*.json; do
    [ -e "$cf" ] || continue
    cid=$(python3 -c "import json,sys;print(json.load(open('$cf')).get('id',''))" 2>/dev/null)
    [ -n "$cid" ] && mgmt -X DELETE "$MGMT_BASE/api/combos/$cid" >/dev/null 2>&1
  done

  # VERIFY the restore instead of announcing it. A restore that 200s and does not take
  # is worse than a loud failure, because it reads as success in the log.
  mgmt "$MGMT_BASE/api/settings" > "$OUT/settings-after.json" 2>/dev/null
  mgmt "$MGMT_BASE/api/providers" > "$OUT/connections-after.json" 2>/dev/null
  python3 - "$OUT/pre-state.json" "$OUT/settings-after.json" "$OUT/connections-after.json" <<'PY'
import json,sys
pre=json.load(open(sys.argv[1]))
try:
    s=json.load(open(sys.argv[2])); s=s.get('data',s) if isinstance(s,dict) else s
    now=((s.get('providerStrategies') or {}).get('opencode-go') or {}).get('fallbackStrategy') or '__ABSENT__'
except Exception: now='UNREADABLE'
want=pre['accountFallbackStrategy']
ok = (now==want) or (want=='__ABSENT__' and now=='__ABSENT__')
print("G12 VERIFY strategy: want=%s now=%s -> %s" % (want, now, "OK" if ok else "*** MISMATCH ***"))
try:
    rows=json.load(open(sys.argv[3]))
    rows=rows if isinstance(rows,list) else (rows.get('data') or rows.get('connections') or [])
    by={r.get('id'):r for r in rows}
    for label,exp in pre['connections'].items():
        got=(by.get(exp['id']) or {}).get('priority')
        st="OK" if got==exp['priority'] else "*** MISMATCH ***"
        print("G12 VERIFY priority %-7s want=%s now=%s -> %s" % (label, exp['priority'], got, st))
except Exception as e:
    print("G12 VERIFY priority: UNREADABLE (%s)" % e)
PY
  # Flush whatever arms completed, so an aborted run still leaves usable partial output
  # rather than nothing.
  assemble_results || true
  say "G12: restore complete."
}

assemble_results() {
  TOG207_OUT="$OUT" python3 "$(dirname "${BASH_SOURCE[0]}")/TOG-207-assemble.py" \
      "$OUT" > "$RESULTS_JSON" 2>"$OUT/assemble.err" \
    && say "results -> $RESULTS_JSON" \
    || say "assemble failed; see $OUT/assemble.err (records.jsonl and arms.jsonl are intact)"
}

# Re-raise the signal after restoring so the exit status still says "killed by SIGINT".
# Swallowing it would make an aborted run look like a clean one to whatever invoked it.
on_signal() { restore_pre_state; trap - EXIT; exit $((128 + $1)); }
trap 'restore_pre_state' EXIT
trap 'on_signal 2'  INT
trap 'on_signal 15' TERM
trap 'on_signal 1'  HUP

# ── G13 — VERIFY THE TRAPS ACTUALLY INSTALLED. ───────────────────────────────
# Found by testing the trap instead of asserting it (TOG-207-trap-test.sh), which is the
# whole reason the Operator demanded a test:
#
#   `trap ... INT` SILENTLY DOES NOTHING if SIGINT was ignored on entry to the shell.
#   POSIX: signals ignored on entry cannot be trapped or reset. Bash returns SUCCESS and
#   prints no error -- `trap -p INT` then reads `trap -- '' SIGINT`.
#
# Bash sets SIGINT to SIG_IGN in background children of a NON-INTERACTIVE shell. So:
#   ./harness.sh              from a terminal   -> Ctrl-C works, restore runs.
#   ./harness.sh &            from a script     -> SIGINT SILENTLY IGNORED, no restore.
#   nohup / supervisor / CI                     -> same, silently.
#
# Measured: rc=0 and no restore on SIGINT when backgrounded, vs rc=143 and restore in
# ~250ms on SIGTERM. A harness that cannot be Ctrl-C'd, and does not say so, is exactly
# the "untested trap is a claim" failure. So check, and be loud.
TRAP_INT_OK=true
if [ "$(trap -p INT)" = "trap -- '' SIGINT" ]; then
  TRAP_INT_OK=false
  say ""
  say "G13 *** WARNING ***: SIGINT is IGNORED-ON-ENTRY in this shell, so the INT trap did"
  say "    NOT install (bash reported success anyway). Ctrl-C/SIGINT will NOT restore state."
  say "    Cause: this process was backgrounded by a non-interactive shell (\`cmd &\`, nohup,"
  say "    CI runner, supervisor). STILL COVERED: SIGTERM, SIGHUP, and every exit path."
  say "    To get SIGINT coverage back, run it in the foreground, or enable job control"
  say "    (\`set -m\`) in the parent, or send SIGTERM instead of SIGINT to abort."
  say "    Either way $RESTORE_SH remains the backstop."
  say ""
fi
for s in TERM HUP; do
  if [ "$(trap -p $s)" = "trap -- '' SIG$s" ]; then
    say "G13 *** WARNING ***: SIG$s ignored-on-entry; that trap did not install either."
  fi
done
[ "$TRAP_INT_OK" = true ] && say "G13 ok: INT/TERM/HUP traps installed and verified live."

# ── G9: priority normalisation — now a PRECONDITION, not a fixture. ──────────
#
# CHANGED 2026-08-23 (TOG-152). Rev 3 wrote priorities itself and reverted them on exit,
# because the live values were inverted (main=2, main-2=1) and the default fill-first
# therefore silently preferred the NEWER plan. Rev 3 called that a fixture and noted that
# correcting it for real would be "a separate deliberate change with its own review".
#
# The Operator has now made exactly that change, and verified it against a DB backup:
# main=1, main-2=2 is persistent instance state. So this stops being something the harness
# does and becomes something the harness CHECKS.
#
# That is not just bookkeeping. It removes the priority writes from the mutation surface
# altogether, so the set of things a SIGKILL can strand shrinks from three (strategy, two
# priorities) to one (strategy). The cheapest way to make an abort safe is to have less to
# put back.
#
# Not asserting equality: equal priorities make orderedConnections[0] depend on an
# unspecified secondary sort, which would make the control arm nondeterministic.
G9_STATUS="skipped"
if [ "${TOG207_NORMALIZE_PRIORITY:-0}" = "1" ]; then
  # Opt-in escape hatch for an instance where the Operator's normalisation is not in place.
  # Mutates, and therefore re-arms the restore path for priorities.
  say "G9: TOG207_NORMALIZE_PRIORITY=1 — writing priorities (main=1, main-2=2) and re-arming restore."
  mgmt -o /dev/null -X PUT "$MGMT_BASE/api/providers/$MAIN_ID"  -d '{"priority":1}'
  mgmt -o /dev/null -X PUT "$MGMT_BASE/api/providers/$MAIN2_ID" -d '{"priority":2}'
  G9_READBACK=$(mgmt "$MGMT_BASE/api/providers" | python3 -c "
import json,sys
rows=json.load(sys.stdin)
rows=rows if isinstance(rows,list) else (rows.get('data') or rows.get('connections') or rows.get('providers') or [])
by={r.get('id'):r.get('priority') for r in rows}
print('%s,%s' % (by.get('$MAIN_ID'), by.get('$MAIN2_ID')))" 2>/dev/null)
  if [ "$G9_READBACK" = "1,2" ]; then
    G9_STATUS="pass-by-write"
    say "G9 PASS: wrote and read back (main,main-2)=(1,2); was ($MAIN_PRIO,$MAIN2_PRIO); will be restored"
  else
    G9_STATUS="FAIL:$G9_READBACK"
    say "G9 *** FAIL ***: wrote (1,2) but read back ($G9_READBACK). Do not interpret results."
    restore_pre_state; exit 3
  fi
else
  # Assert-only. $MAIN_PRIO/$MAIN2_PRIO come from the G0 read, so this costs no extra call.
  if [ "$MAIN_PRIO,$MAIN2_PRIO" = "1,2" ]; then
    G9_STATUS="pass-by-assert"
    say "G9 ok: priorities already normalised (main=1, main-2=2). Harness writes nothing here."
  else
    G9_STATUS="FAIL:precondition:$MAIN_PRIO,$MAIN2_PRIO"
    say "G9 *** FAILED PRECONDITION ***: (main,main-2) priorities are ($MAIN_PRIO,$MAIN2_PRIO), expected (1,2)."
    say "    fill-first consumes the lower priority first, so the control arm would be measuring"
    say "    the NEWER plan as 'plan A' and every rotation number would be read backwards."
    say "    Either restore the normalisation, or re-run with TOG207_NORMALIZE_PRIORITY=1 to let"
    say "    the harness set it as a reverted fixture. Refusing to produce uninterpretable data."
    exit 3
  fi
fi

# ── G0b: quota liveness. Decides whether the B-arms mean anything at all. ────
QURL="${OMNIROUTE_OPENCODE_QUOTA_URL:-https://opencode.ai/zen/go/v1/quota}"
QCODE=$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "$QURL" 2>/dev/null)
if [ "$QCODE" = "404" ]; then
  QUOTA_STATE="QUOTA_DEAD"
  say "G0b: $QURL -> 404. opencode-go has NO quota signal."
  say "     reset-aware / reset-window / headroom are DEGENERATE BY CONSTRUCTION:"
  say "       reset-aware  -> scoreResetAwareQuota(null)=0.5 for both -> tie -> rotateLeadingTies() -> round-robin (NOT quota)"
  say "       reset-window -> getResetWindowTimestampMs(null)=Infinity -> early return -> static priority order"
  say "       headroom     -> getSaturation fails open to 0 -> equal -> stable ties -> static priority order"
  say "     Still run, as documentation. They MUST NOT be ranked against the A-arms."
else
  QUOTA_STATE="QUOTA_LIVE:$QCODE"
  say "G0b: $QURL -> $QCODE. Quota may be live; B-arms are rankable. Verify payload shape first."
fi

# ── G11: capture pre-state of other companies' routing. Must be unchanged after. ──
mgmt "$MGMT_BASE/api/combos" > "$OUT/combos-before.json" 2>/dev/null
python3 - "$OUT/combos-before.json" > "$OUT/protected-before.txt" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); c=d.get("data",d) if isinstance(d,dict) else d
rows=c if isinstance(c,list) else c.get("combos",[])
for r in sorted(rows,key=lambda x:str(x.get("name"))):
    n=str(r.get("name",""))
    if n.startswith(("auto/","hindsight/")):
        print(n, r.get("strategy"), len(r.get("models") or []))
PY
say "G11: captured $(wc -l < "$OUT/protected-before.txt") protected auto/* + hindsight/* combos"

# ── Combo shape: TWO PINNED Go legs + an OpenRouter terminal leg. ────────────
# Pinning is what makes per-connection rotation possible for the non-expanding strategies.
# Terminal leg is z-ai/glm-5.
#
# CORRECTED 2026-09-03 (TOG-876). This note previously justified the leg with "per TOG-177 the
# stream:false 502 is a gpt-oss-* property, not an OpenRouter one". Both halves are wrong, and
# the justification was self-defeating: TOG-177 §3a measured `z-ai/glm-5` — this exact leg — at
# 502 non-streaming. The 502 is not scoped to any model family. It fires when `max_tokens`
# truncates a reasoning model before its first content token, which is a property of the call
# (§3b: identical input, 502 twice and 200 once).
# So this leg is NOT chosen for stream:false safety, and no model choice could give that. What
# actually keeps this harness safe is guard G3 below: every probe is stream:true, and the 502
# requires stream:false.
LEGS_JSON=$(cat <<EOF
[
  {"kind":"model","model":"glm-5","providerId":"opencode-go","connectionId":"$MAIN_ID"},
  {"kind":"model","model":"glm-5","providerId":"opencode-go","connectionId":"$MAIN2_ID"},
  {"kind":"model","model":"z-ai/glm-5","providerId":"openrouter"}
]
EOF
)

# FIFTH FIELD (Rev 5) = the dimension this arm VARIES. It decides whether G2 is a real
# assertion or a vacuous one, and it is declared here rather than inferred from the arm's
# name so that adding an arm cannot silently re-introduce F-11. `combo` => the echoed
# strategy= slot carries this arm's variable and G2 asserts on it. `account` => the
# variable is invisible to the response entirely and G2a is the only assertion available.
ARMS=(
  "A1:fill-first:fill-first:pin-main:account"
  "A2:fill-first:round-robin:split:account"
  "A3:fill-first:least-used:split:account"
  "A4:fill-first:strict-random:split:account"
  "A5:fill-first:p2c:split:account"
  "B1:reset-aware:fill-first:split-by-tie-NOT-quota:combo"
  "B2:headroom:fill-first:pin-main-no-signal:combo"
  "B3:reset-window:fill-first:pin-main-no-signal:combo"
)

# ── Rev 6 / G0c: ARM SELECTION AND ORDER ─────────────────────────────────────
#
# Until Rev 6 this array was the whole contract: all 8 arms, always, in this order.
# That silently defeated two decisions the Operator made on 2026-08-24 (TOG-208):
#
#   scope=a_only  -- run A1-A5 only. B1-B3 are degenerate BY CONSTRUCTION under
#                    QUOTA_DEAD and are to be DOCUMENTED, not measured. Running them
#                    anyway spends 3/8 of the request budget on arms nobody will rank.
#   order         -- A2-A5 FIRST, A1 LAST. A1 is the control that predicts 100% `main`.
#                    A dead account-strategy switch ALSO produces 100% `main`. Running
#                    A1 first lets an instrument failure ratify itself as the predicted
#                    result; running it last makes the same failure surface as a
#                    contradiction across A2-A5. The order is a falsification device,
#                    not a preference -- so it has to be expressible.
#
# TOG207_ARMS takes arm ids separated by spaces or commas and runs them IN THE ORDER
# GIVEN. Unset => all 8 in declaration order (Rev 5 behaviour, byte for byte).
#
# A typo here must not silently run a shorter matrix -- that is the same class of
# failure as the swallowed conn-counts error below (`|| true`), where an unnoticed
# empty result reads downstream as a real measurement. Unknown ids abort.
if [ -n "${TOG207_ARMS:-}" ]; then
  _sel=$(printf '%s' "$TOG207_ARMS" | tr ',' ' ')
  _picked=()
  for _want in $_sel; do
    _hit=""
    for _entry in "${ARMS[@]}"; do
      [ "${_entry%%:*}" = "$_want" ] && { _picked+=("$_entry"); _hit=1; break; }
    done
    if [ -z "$_hit" ]; then
      say "G0c FAILED: TOG207_ARMS names unknown arm '$_want'."
      say "  Known arms: $(for e in "${ARMS[@]}"; do printf '%s ' "${e%%:*}"; done)"
      say "  Aborting rather than running a silently shorter matrix."
      exit 2
    fi
  done
  ARMS=("${_picked[@]}")
fi

# ── G2a helper: read providerStrategies['opencode-go'].fallbackStrategy, keeping the raw
#    response on disk so the reported value is auditable rather than a bare string that
#    might be empty for three different reasons. Distinguishes:
#      <strategy>   the real stored value
#      __ABSENT__   settings parsed, but the key is not there
#      UNREADABLE   the GET failed or the body did not parse
#    Never returns "". An empty read is exactly how a vacuous guard gets its free PASS.
read_account_strategy() {  # $1 = file to save the raw settings body into
  local f="$1" code
  code=$(mgmt -o "$f" -w '%{http_code}' "$MGMT_BASE/api/settings" 2>/dev/null)
  if [ "$code" != "200" ]; then
    printf 'UNREADABLE(http=%s)' "${code:-no-response}"
    return
  fi
  python3 - "$f" <<'PY'
import json,sys
try:
    d=json.load(open(sys.argv[1]))
except Exception:
    print("UNREADABLE(parse)"); raise SystemExit
s=d.get("data",d) if isinstance(d,dict) else d
if not isinstance(s,dict):
    print("UNREADABLE(shape)"); raise SystemExit
ps=(s.get("providerStrategies") or {}).get("opencode-go") or {}
v=ps.get("fallbackStrategy")
print(v if v else "__ABSENT__")
PY
}

say ""
say "=== TOG-207 bake-off Rev 5: $N req/arm, ${#ARMS[@]} arms, quota=$QUOTA_STATE ==="
say "    G2  asserts the RUNTIME COMBO strategy. Applies to combo-varying arms only (B1-B3)."
say "    G2a asserts the ACCOUNT strategy held for the whole arm window (settings read-back,"
say "        before AND after). This is the ONLY runtime assertion available to A1-A5 --"
say "        the account strategy is never echoed on any response surface (TOG-214/F-11)."
printf '%-4s %-13s %-13s %-16s %-26s %5s %5s %5s %5s %5s\n' \
  ARM COMBO ACCOUNT G2_COMBO G2A_ACCOUNT_HELD GO PAYG 429 ERR OTHER

for entry in "${ARMS[@]}"; do
  IFS=: read -r arm cstrat astrat pred varies <<<"$entry"
  combo="bakeoff/tog207-$arm"
  W_START=$(now)

  mgmt -X POST "$MGMT_BASE/api/combos" -d "$(cat <<EOF
{"name":"$combo","strategy":"$cstrat","description":"TOG-207 bake-off $arm. Temporary.","models":$LEGS_JSON}
EOF
  )" > "$OUT/create-$arm.json" 2>&1

  mgmt -X PATCH "$MGMT_BASE/api/settings" \
    -d "{\"providerStrategies\":{\"opencode-go\":{\"fallbackStrategy\":\"$astrat\"}}}" \
    > "$OUT/settings-$arm.json" 2>&1

  # ── G1: stored COMBO strategy read-back. normalizeRoutingStrategy() coerces any
  #        unrecognised strategy to "priority" with no error and no rejected write. Without
  #        this the likely outcome is eight arms of `priority` converging beautifully on the
  #        conclusion that `priority` is best -- indistinguishable from a real result.
  stored=$(mgmt "$MGMT_BASE/api/combos" | python3 -c "
import json,sys
d=json.load(sys.stdin); c=d.get('data',d) if isinstance(d,dict) else d
rows=c if isinstance(c,list) else c.get('combos',[])
print(next((x.get('strategy') for x in rows if x.get('name')=='$combo'),'MISSING'))" 2>/dev/null)

  # ── G1b: stored ACCOUNT strategy read-back. This is the selector that actually picks
  #         between main and main-2. The combo read-back alone does not cover it -- its
  #         absence is what defined the superseded revision.
  stored_acct=$(mgmt "$MGMT_BASE/api/settings" | python3 -c "
import json,sys
d=json.load(sys.stdin); s=d.get('data',d) if isinstance(d,dict) else d
ps=(s.get('providerStrategies') or {}).get('opencode-go') or {}
print(ps.get('fallbackStrategy') or s.get('fallbackStrategy') or 'MISSING')" 2>/dev/null)

  if [ "$stored" != "$cstrat" ] || [ "$stored_acct" != "$astrat" ]; then
    printf '%-4s %-13s %-13s %s\n' "$arm" "$cstrat" "$astrat" \
      "SET FAILED combo=$stored acct=$stored_acct -- ARM NOT SETTABLE (this is a finding, report it)"
    # REV 5 (TOG-214, F-14): these were `true`/`false`, which are NameErrors in the Python
    # this heredoc feeds. Measured: every arm that failed to set raised, wrote NOTHING to
    # arms.jsonl, and vanished from results.json entirely -- so the machine-readable output
    # silently contained only the arms that worked. The Rev 4 G1/G1b fault-injection cases
    # did not catch it because they grep the LOG for "SET FAILED" rather than reading the
    # JSON. An unsettable arm is a finding and must survive into the results file.
    python3 - >> "$ARMS_JSONL" <<EOF
import json
print(json.dumps({"arm":"$arm","variesDimension":"$varies",
 "requested":{"comboStrategy":"$cstrat","accountStrategy":"$astrat"},
 "readback":{"comboStrategy":"$stored","accountStrategy":"$stored_acct"},
 "setFailed":True,
 "g1":{"pass":$( [ "$stored" = "$cstrat" ] && echo True || echo False )},
 "g1b":{"pass":$( [ "$stored_acct" = "$astrat" ] && echo True || echo False )},
 "g2":{"verdict":"NOT_RUN","applicable":$( [ "$varies" = "combo" ] && echo True || echo False ),
       "note":"arm was not settable; no requests were issued"},
 "g2a":{"verdict":"NOT_RUN","before":None,"after":None,"want":"$astrat",
        "note":"arm was not settable; no requests were issued"},
 "setOk":False,"prediction":"$pred","window":{"start":"$W_START","end":None},
 "quotaState":"$QUOTA_STATE"}))
EOF
    continue
  fi

  # ── G2a (part 1 of 2): account strategy IMMEDIATELY BEFORE the first request. ────────
  # Deliberately a second, independent read rather than a reuse of G1b's value: G1b reads
  # at set time, and everything between set time and the first request is uncovered by it.
  # For A1-A5 this pair of reads is the ONLY evidence that the arm's varied dimension was
  # actually in force while the arm's requests were being served, because that dimension
  # is invisible on every response surface (TOG-214/F-11).
  ACCT_BEFORE=$(read_account_strategy "$OUT/g2a-$arm-before.json")

  go=0; payg=0; err=0; other=0; rate429=0
  strat_seen=0; strat_bad=0; strat_single=0; strat_match=0
  : > "$OUT/strategies-$arm.txt"
  : > "$OUT/sessions-$arm.txt"

  for i in $(seq 1 "$N"); do
    # G8: unique session per request. sessionAffinityPin.ts is explicit that an active pin
    #     for (sessionKey, provider) WINS over the freshly recomputed forcedConnectionId. If
    #     the N requests share a session key, the first pinned connection serves the rest of
    #     the arm regardless of strategy and every arm reads 100%/0%.
    #
    # G8 FIX (TOG-152, measured live). Through Rev 5 this sent `x-omniroute-session-id`,
    # which OMNIROUTE NEVER READS. extractSessionAffinityKey() (src/sse/services/auth.ts:225)
    # reads exactly three headers -- `x-codex-session-id`, `x-session-id`, `x-omniroute-session`
    # (no `-id` suffix) -- and `x-omniroute-session-id` is a RESPONSE-only header. With no
    # readable header it falls through to the body, and finally to
    #     `input:sha256:<hash of the first input text>`
    # ...and every request below sends the identical content "say ok". So all N requests in an
    # arm collapsed onto ONE session key and the first pinned connection served the whole arm.
    # Measured on the live instance:
    #     x-omniroute-session-id: uniq-1/2/3 -> echoed 664a2180a05bc518, 664a..., 664a...  (same)
    #     x-session-id:           uniq-1/2/3 -> echoed ext:uniq-1, ext:uniq-2, ext:uniq-3  (unique)
    # Negative control at arm scale: OLD header, 4 requests -> 1 distinct session.
    #                                NEW header, 8 requests -> 8 distinct sessions.
    #
    # SCOPE OF THE DAMAGE, stated precisely: G8's DETECTOR was never broken. The assertion
    # below (`sess_distinct < tot` -> "G8 FAILED for $arm") would have fired on every arm and
    # reported distinctSessions:1, so this would NOT have produced a silent false null -- it
    # would have produced five loudly-failed arms and a wasted run. It was the MITIGATION that
    # was inert, not the check. The fix converts a run that could only fail into one that can
    # actually measure.
    #
    # Belt and braces: vary the prompt text too, so the input-hash fallback ALSO cannot
    # collapse if the header path ever regresses. The two mitigations are independent.
    SESS="tog207-$arm-$i-$$"
    PROMPT="say ok #$arm-$i"
    # G3: stream:true on every request. Non-streaming at THIS max_tokens kills the OpenRouter
    #     leg (9/9 HTTP 502 vs 14/14 healthy streaming, TOG-177). A non-streaming bake-off
    #     scores every arm "100% Go, PAYG unreachable" -- perfect-looking, entirely artifact.
    #     CORRECTED 2026-09-03 (TOG-876): "kills the OpenRouter leg outright" overstated it.
    #     The leg is not broken and OpenRouter is not at fault — TOG-177 §3c drove the same
    #     models to 0/3 502 at max_tokens 600. The 9/9 above is what stream:false + a 16-token
    #     budget does to a reasoning model, not a standing property of the provider.
    # G4: max_tokens >= 16. max_tokens:1 trips the combo quality validator into a synthetic
    #     502 that reads as a genuine fallthrough.
    #     G3 and G4 are coupled: 16 tokens is only safe BECAUSE G3 forces stream:true. If you
    #     ever relax G3, this budget becomes the exact truncation condition that triggers the
    #     502 — raise max_tokens well above the reasoning preamble (>=600) in that same edit.
    #
    # Backgrounded + `wait` ON PURPOSE, and it is load-bearing for the restore guarantee:
    # bash defers a trapped signal until the running foreground command returns, so a
    # foreground curl would delay restore by up to its 90s timeout. `wait` is interruptible.
    curl -sS -m 90 -D "$OUT/h.txt" -o "$OUT/b.txt" -w '%{http_code}' \
      -H "Authorization: Bearer $APIKEY" -H 'Content-Type: application/json' \
      -H "x-session-id: $SESS" \
      -d '{"model":"'"$combo"'","messages":[{"role":"user","content":"'"$PROMPT"'"}],"max_tokens":16,"stream":true}' \
      "$API_BASE/v1/chat/completions" > "$OUT/code.txt" 2>"$OUT/curl.err" &
    CURL_PID=$!
    wait "$CURL_PID" 2>/dev/null
    CURL_PID=""
    code=$(cat "$OUT/code.txt" 2>/dev/null)

    sess_echo=$(grep -i '^x-omniroute-session-id' "$OUT/h.txt" 2>/dev/null | tr -d '\r' | awk '{print $2}')
    [ -n "$sess_echo" ] && printf '%s\n' "$sess_echo" >> "$OUT/sessions-$arm.txt"

    # G5: count REQUESTS, not tokens. tokens-in/out and response-cost read 0 on real 200s.
    if [ "$code" = "429" ]; then
      rate429=$((rate429+1))
      printf '{"arm":"%s","seq":%d,"session":"%s","code":429,"provider":null,"providerSource":null,"strategyRan":null,"latencyMs":null}\n' \
        "$arm" "$i" "$SESS" >> "$RECORDS"
      continue
    fi
    if [ "$code" != "200" ]; then
      err=$((err+1))
      printf '{"arm":"%s","seq":%d,"session":"%s","code":%s,"provider":null,"providerSource":null,"strategyRan":null,"latencyMs":null}\n' \
        "$arm" "$i" "$SESS" "${code:-0}" >> "$RECORDS"
      continue
    fi

    # G6: attribute from the SSE TRAILER, not the response header. The x-omniroute-* header
    #     block is absent on ~29% of streaming 200s (present 7/7 on opencode-go but only 3/7
    #     on openrouter) because OmniRoute flushes SSE headers early when upstream is slow,
    #     before the route resolves. The loss is LATENCY-CORRELATED, so it drops
    #     predominantly the SLOW leg -- OpenRouter -- which makes measured Go share rise and
    #     fallthrough vanish. Rev 1 discarded exactly those requests and would have
    #     systematically concealed the failure this task exists to prevent. Header is the
    #     fallback, never the primary.
    prov=$(sed -n 's/^: x-omniroute-decision=.*provider=\([a-z0-9-]*\).*/\1/p' "$OUT/b.txt" | head -1)
    psrc="trailer"
    lat=$(sed -n 's/^: x-omniroute-decision=.*latency_ms=\([0-9]*\).*/\1/p' "$OUT/b.txt" | head -1)
    if [ -z "$prov" ]; then
      prov=$(grep -i '^x-omniroute-provider' "$OUT/h.txt" 2>/dev/null | tr -d '\r' | awk '{print $2}')
      psrc="header"
    fi
    [ -z "$prov" ] && psrc="none"

    # G2: per-request runtime COMBO strategy observation. Proves the router RAN this combo
    #     strategy on the request being counted -- a different claim from G1's catch at
    #     SETUP time. Keep both. The trailer form omits strategy=, so this is observable
    #     only on the ~71% of requests that kept their header block, and that subset is
    #     itself biased toward the fast leg. Report it as COVERAGE; NEVER discard a request
    #     on absence, because discarding would throw away exactly the slow/PAYG requests
    #     and bias the result toward Go.
    #
    #     REV 5 (TOG-214/F-11). This slot carries the COMBO strategy ONLY. It is `single`
    #     on a direct completion and it NEVER carries the account strategy. Three outcomes
    #     are counted separately, because collapsing them is what made the old guard
    #     vacuous:
    #       match  -- ran == this arm's combo strategy
    #       single -- the combo did not resolve; the request went down the direct path.
    #                 On a combo-varying arm that is a HARD failure, not a mismatch: the
    #                 arm's leg list (including the PAYG terminal) was not in play at all.
    #       bad    -- ran is some other strategy; the router ran something we did not ask
    #                 for.
    #     Observed values are recorded verbatim to strategies-$arm.txt so the report can
    #     print what was actually seen instead of a summary that hides `single`.
    ran=$(grep -i '^x-omniroute-decision' "$OUT/h.txt" 2>/dev/null | tr -d '\r' | sed -n 's/.*strategy=\([a-z-]*\).*/\1/p')
    if [ -n "$ran" ]; then
      strat_seen=$((strat_seen+1))
      printf '%s\n' "$ran" >> "$OUT/strategies-$arm.txt"
      if [ "$ran" = "single" ]; then
        strat_single=$((strat_single+1))
      elif [ "$ran" = "$cstrat" ]; then
        strat_match=$((strat_match+1))
      else
        strat_bad=$((strat_bad+1))
      fi
    fi

    case "$prov" in
      opencode-go) go=$((go+1)) ;;
      openrouter)  payg=$((payg+1)) ;;
      *)           other=$((other+1)) ;;
    esac

    printf '{"arm":"%s","seq":%d,"session":"%s","code":200,"provider":%s,"providerSource":"%s","strategyRan":%s,"latencyMs":%s}\n' \
      "$arm" "$i" "$SESS" \
      "$( [ -n "$prov" ] && printf '"%s"' "$prov" || printf 'null' )" \
      "$psrc" \
      "$( [ -n "$ran" ] && printf '"%s"' "$ran" || printf 'null' )" \
      "${lat:-null}" >> "$RECORDS"
  done

  W_END=$(now)
  # ── G2a (part 2 of 2): account strategy IMMEDIATELY AFTER the last request. ──────────
  # This is the half that Rev 4 did not have. settings.providerStrategies is
  # INSTANCE-GLOBAL: another operator, another company's tooling, or a half-finished
  # restore from a previous aborted run can move it mid-arm, and a before-only read would
  # attribute every request in the window to a strategy that stopped being in force after
  # request 3. Drift is not a warning here -- the arm is unattributable and must be
  # discarded.
  ACCT_AFTER=$(read_account_strategy "$OUT/g2a-$arm-after.json")

  tot=$(( go + payg + other )); [ "$tot" -eq 0 ] && tot=1
  cov=$(( strat_seen * 100 / tot ))
  sess_distinct=$(sort -u "$OUT/sessions-$arm.txt" 2>/dev/null | grep -c . || true)

  # ── G2 verdict. Scoped: only an arm that VARIES the combo strategy can be asserted on
  #    by this guard. On an account-varying arm the guard reports N/A and says why, in its
  #    own output -- it does not silently report a pass it did not earn.
  if [ "$varies" = "combo" ]; then
    if [ "$strat_seen" -eq 0 ]; then
      G2_VERDICT="NOCOV"      # zero observations is NOT a pass. This is the F-11 shape.
    elif [ "$strat_single" -gt 0 ]; then
      G2_VERDICT="FAIL-single:$strat_single"
    elif [ "$strat_bad" -gt 0 ]; then
      G2_VERDICT="FAIL-mismatch:$strat_bad"
    else
      G2_VERDICT="PASS"
    fi
    G2_CELL="$G2_VERDICT(${cov}%)"
  else
    G2_VERDICT="N/A-account-arm"
    G2_CELL="n/a see G2a"
  fi

  # ── G2a verdict. Both samples must equal the arm's requested account strategy.
  #    UNREADABLE/__ABSENT__ can never pass -- an unread value is not a held value.
  if [ "$ACCT_BEFORE" = "$astrat" ] && [ "$ACCT_AFTER" = "$astrat" ]; then
    G2A_VERDICT="PASS"; G2A_CELL="HELD:$astrat"
  elif [ "$ACCT_BEFORE" != "$astrat" ]; then
    G2A_VERDICT="FAIL-not-in-force"; G2A_CELL="PRE!=$ACCT_BEFORE"
  else
    G2A_VERDICT="FAIL-drift"; G2A_CELL="DRIFT->$ACCT_AFTER"
  fi

  printf '%-4s %-13s %-13s %-16s %-26s %5s %5s %5s %5s %5s\n' \
    "$arm" "$cstrat" "$astrat" "$G2_CELL" "$G2A_CELL" "$go" "$payg" "$rate429" "$err" "$other"

  # Real values, always, on every arm -- including the ones that passed. A guard that only
  # prints when it fails cannot be distinguished from a guard that never ran.
  say "  G2a $arm: providerStrategies['opencode-go'].fallbackStrategy" \
      "before=$ACCT_BEFORE after=$ACCT_AFTER want=$astrat -> $G2A_VERDICT"
  if [ "$varies" = "combo" ]; then
    say "  G2  $arm: runtime combo strategy over $strat_seen/$tot observed requests:" \
        "match=$strat_match single=$strat_single other=$strat_bad -> $G2_VERDICT" \
        "[observed: $(sort "$OUT/strategies-$arm.txt" 2>/dev/null | uniq -c | tr -s ' \n' ' /' | sed 's:/$::')]"
  else
    say "  G2  $arm: NOT APPLICABLE. This arm varies the ACCOUNT strategy, which is never" \
        "echoed in any response (header or SSE trailer). The strategy= slot carries the" \
        "COMBO strategy, held constant at '$cstrat' here, so asserting on it would be" \
        "vacuous (TOG-214/F-11). Observed anyway, for diagnosis only:" \
        "$strat_seen/$tot [$(sort "$OUT/strategies-$arm.txt" 2>/dev/null | uniq -c | tr -s ' \n' ' /' | sed 's:/$::')]" \
        "-- G2a above is this arm's assertion."
  fi
  if [ "$G2A_VERDICT" != "PASS" ]; then
    say "  !! G2a FAILED for $arm: account strategy was not demonstrably in force for the"
    say "     whole window (before=$ACCT_BEFORE after=$ACCT_AFTER want=$astrat)."
    say "     This arm's requests cannot be attributed to '$astrat'. DISCARD IT."
    say "     Raw reads: $OUT/g2a-$arm-before.json  $OUT/g2a-$arm-after.json"
  fi
  if [ "$varies" = "combo" ] && [ "$G2_VERDICT" != "PASS" ]; then
    case "$G2_VERDICT" in
      NOCOV)
        say "  !! G2 INCONCLUSIVE for $arm: strategy= was observed on 0 of $tot requests."
        say "     Not a pass. Either every header block was dropped, or the decision header"
        say "     changed shape. Do not report this arm's combo strategy as verified." ;;
      FAIL-single:*)
        say "  !! G2 FAILED for $arm: $strat_single request(s) echoed strategy=single, i.e."
        say "     the combo did not resolve and the request went down the DIRECT path. The"
        say "     arm's leg list -- including the OpenRouter PAYG terminal -- was not in"
        say "     play, so this arm cannot measure fallthrough at all. DISCARD IT." ;;
      FAIL-mismatch:*)
        say "  !! G2 FAILED for $arm: $strat_bad request(s) ran a combo strategy other than"
        say "     '$cstrat'. The router did not run what the arm asked for. DISCARD IT." ;;
    esac
  fi

  # ── G7: per-connection attribution is MANAGEMENT-SIDE and cannot be done client-side.
  #        x-omniroute-selected-connection-id is emitted only on the 401 path, and every
  #        pooled Go plan reports provider=opencode-go, so even the trailer cannot tell main
  #        from main-2. Emit the SQL with THIS ARM'S WINDOW ALREADY FILLED IN -- child 4 must
  #        not have to reconstruct windows from logs.
  cat > "$OUT/g7-$arm.sql" <<SQL
-- TOG-207 arm $arm  combo=$cstrat  account=$astrat
-- window: [$W_START, $W_END)
-- Read as: even split => the arm ROTATED.  Single connection_id => the arm PINNED.
SELECT uh.connection_id, pc.account_label, pc.priority, COUNT(*) AS calls
  FROM usage_history uh
  LEFT JOIN provider_connections pc ON pc.id = uh.connection_id
 WHERE uh.created_at >= '$W_START' AND uh.created_at < '$W_END'
   AND pc.provider = 'opencode-go'
 GROUP BY uh.connection_id, pc.account_label, pc.priority
 ORDER BY calls DESC;

-- Headline metric, SAME window. Any openrouter row in an arm whose rate_limited count is 0
-- is a fallthrough-with-headroom event -- the failure this task exists to prevent.
-- Report PER ARM, never aggregated.
SELECT pc.provider, COUNT(*) AS calls
  FROM usage_history uh
  LEFT JOIN provider_connections pc ON pc.id = uh.connection_id
 WHERE uh.created_at >= '$W_START' AND uh.created_at < '$W_END'
 GROUP BY pc.provider;

-- G8, DB side: session affinity must not have pinned this arm. Any row here means the
-- split is an artifact of a pin, not of the strategy, and the arm must be discarded.
SELECT COUNT(*) AS affinity_rows
  FROM session_account_affinity
 WHERE provider = 'opencode-go'
   AND created_at >= '$W_START' AND created_at < '$W_END';
SQL

  # G7 ingest hook: if the runner wired up a management-side query, per-connection counts
  # land in results.json automatically and G10 runs at full strength. If not, the field
  # stays null and G10 says so rather than quietly substituting provider-level data.
  CONN_TSV="$OUT/conn-$arm.tsv"
  : > "$CONN_TSV"
  if [ -n "${TOG207_CONN_COUNTS_CMD:-}" ]; then
    # shellcheck disable=SC2086
    $TOG207_CONN_COUNTS_CMD "$W_START" "$W_END" > "$CONN_TSV" 2>"$OUT/conn-$arm.err" || true
    # Rev 6 / G7b. The `|| true` above is deliberate -- a broken attribution hook must not
    # abort a paid arm mid-flight. But until Rev 6 it was also SILENT, and that is the
    # trap: the hook fails, conn-$arm.tsv stays empty, perConnection goes null for every
    # arm, G10 degrades to provider-level, and the run still exits 0 looking complete.
    # Child 4's attribution is then unrecoverable, because the windows have passed.
    #
    # The likeliest cause is the subcommand landing OUTSIDE the variable:
    #   WRONG  TOG207_CONN_COUNTS_CMD=/path/TOG-208-conn-counts.py counts   <- `counts` is
    #          parsed as the command to run, not part of $CMD; the harness then invokes
    #          the script as `... <W_START> <W_END>`, argv[1] is a timestamp, no
    #          subcommand matches, and it dies into conn-$arm.err where nobody looks.
    #   RIGHT  export TOG207_CONN_COUNTS_CMD="/path/TOG-208-conn-counts.py counts"
    # $CMD is word-split unquoted precisely so the multi-word RIGHT form works.
    if ! grep -qE '^[^\t]*\t[^\t]*\t[0-9]+' "$CONN_TSV" 2>/dev/null; then
      say ""
      say "  !! G7b: conn-counts hook was SET but produced no usable TSV rows for $arm."
      say "     per-connection attribution for this arm will be NULL and G10 degrades."
      say "     stderr -> $OUT/conn-$arm.err:"
      sed 's/^/       /' "$OUT/conn-$arm.err" 2>/dev/null | head -5
      say "     If this is arm 1 of the matrix, ABORT NOW and fix the hook -- every"
      say "     later arm will fail identically and the windows cannot be replayed."
      say ""
    fi
  fi

  python3 - >> "$ARMS_JSONL" <<EOF
import json,os
conn={}
p="$CONN_TSV"
if os.path.exists(p):
    for line in open(p):
        parts=line.rstrip("\n").split("\t")
        if len(parts)>=3 and parts[2].strip().isdigit():
            conn[parts[1] or parts[0]]=int(parts[2])
obs={}
p2="$OUT/strategies-$arm.txt"
if os.path.exists(p2):
    for line in open(p2):
        v=line.strip()
        if v: obs[v]=obs.get(v,0)+1
print(json.dumps({
 "arm":"$arm",
 "variesDimension":"$varies",
 "requested":{"comboStrategy":"$cstrat","accountStrategy":"$astrat"},
 "readback":{"comboStrategy":"$stored","accountStrategy":"$stored_acct"},
 "g1":{"pass":True,"requested":"$cstrat","stored":"$stored"},
 "g1b":{"pass":True,"requested":"$astrat","stored":"$stored_acct"},
 "g2":{"verdict":"$G2_VERDICT",
       "applicable":$( [ "$varies" = "combo" ] && echo True || echo False ),
       "scope":"arms that VARY the combo strategy (B1-B3)",
       "pass":$( [ "$G2_VERDICT" = "PASS" ] && echo True || echo False ),
       # coveragePct and the match/single/mismatch counters are NULL on an arm this guard
       # does not apply to. On an A-arm "matches: 40" would be 40 confirmations that a
       # constant equals itself, and a consumer skimming the JSON would read it as the arm
       # having been verified. Leaving the raw observedValues and nothing else forces the
       # reader to g2a, which is where the arm's actual evidence is.
       "coveragePct":$( [ "$varies" = "combo" ] && echo $cov || echo None ),
       "observed":$strat_seen,
       "matches":$( [ "$varies" = "combo" ] && echo $strat_match || echo None ),
       "single":$( [ "$varies" = "combo" ] && echo $strat_single || echo None ),
       "mismatches":$( [ "$varies" = "combo" ] && echo $strat_bad || echo None ),
       "observedValues":(obs or None),
       "note":("Coverage<100 is expected: the SSE trailer omits strategy=, and header loss is latency-correlated toward the slow leg. Requests are NEVER discarded on absence. strategy=single means the combo did not resolve (direct path), which is counted separately from a mismatch."
               if "$varies"=="combo" else
               "NOT APPLICABLE to this arm. strategy= carries the COMBO strategy; this arm holds it constant at '$cstrat' and varies the ACCOUNT strategy, which OmniRoute never echoes on any response surface -- header or SSE trailer (verified 6/6 live, TOG-214/F-11). Asserting here would be vacuous. observedValues is diagnostic only; g2a is this arm's assertion.")},
 "g2a":{"verdict":"$G2A_VERDICT",
        "pass":$( [ "$G2A_VERDICT" = "PASS" ] && echo True || echo False ),
        "source":"GET /api/settings providerStrategies['opencode-go'].fallbackStrategy",
        "want":"$astrat","before":"$ACCT_BEFORE","after":"$ACCT_AFTER",
        "sampledAt":{"before":"immediately before the arm's first request",
                     "after":"immediately after the arm's last request"},
        "rawReads":["g2a-$arm-before.json","g2a-$arm-after.json"],
        "loadBearing":$( [ "$varies" = "account" ] && echo True || echo False ),
        "note":"The account strategy is instance-global and is invisible on the response path, so this before/after pair is the only evidence the arm's varied dimension held for the whole window. UNREADABLE or __ABSENT__ is a failure, never a pass."},
 "g8":{"distinctSessions":$sess_distinct,"requests":$tot,
       "pass":bool($sess_distinct>=$tot or $tot<=1),
       "affinityRows":None,
       "note":"affinityRows is management-side; see g7Sql third statement."},
 "setOk":True,"prediction":"$pred",
 "perProvider":{"opencode-go":$go,"openrouter":$payg,"other":$other},
 "perConnection":(conn or None),
 "rateLimited429":$rate429,"errors":$err,
 "window":{"start":"$W_START","end":"$W_END"},
 "g7Sql":"g7-$arm.sql",
 "quotaState":"$QUOTA_STATE"}))
EOF

  if [ "$sess_distinct" -lt "$tot" ] && [ "$tot" -gt 1 ]; then
    say "  !! G8 FAILED for $arm: $sess_distinct distinct session id(s) across $tot requests (want $tot)."
    say "     Affinity pinning outranks the strategy -- this arm's split is an artifact. Discard it."
  fi

  cid=$(python3 -c "import json;print(json.load(open('$OUT/create-$arm.json')).get('id',''))" 2>/dev/null)
  [ -n "$cid" ] && mgmt -X DELETE "$MGMT_BASE/api/combos/$cid" >/dev/null 2>&1
done

# ── G11: prove additivity. Other companies' routing must be byte-identical. ──
mgmt "$MGMT_BASE/api/combos" > "$OUT/combos-after.json" 2>/dev/null
python3 - "$OUT/combos-after.json" > "$OUT/protected-after.txt" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); c=d.get("data",d) if isinstance(d,dict) else d
rows=c if isinstance(c,list) else c.get("combos",[])
for r in sorted(rows,key=lambda x:str(x.get("name"))):
    n=str(r.get("name",""))
    if n.startswith(("auto/","hindsight/")):
        print(n, r.get("strategy"), len(r.get("models") or []))
PY
if diff -q "$OUT/protected-before.txt" "$OUT/protected-after.txt" >/dev/null 2>&1; then
  G11_STATUS=pass
  say ""
  say "G11 PASS: auto/* and hindsight/* combos unchanged."
else
  G11_STATUS=FAIL
  say ""
  say "G11 *** FAIL ***: protected combos CHANGED. Investigate before reporting anything."
  diff "$OUT/protected-before.txt" "$OUT/protected-after.txt"
fi

cat > "$OUT/run-meta.json" <<META
{"schemaVersion":"tog207.bakeoff.v2","issue":"TOG-207","harnessRev":"rev5",
 "revNotes":{"rev5":"TOG-214: G2 re-scoped to combo-varying arms (B1-B3) and can no longer PASS on zero observations; strategy=single classified separately; G2a added as the A-arms' assertion (settings read-back before AND after each arm). The account strategy is never echoed on any response surface."},
 "startedAt":"$(cat "$OUT/pre-state.json" | python3 -c 'import json,sys;print(json.load(sys.stdin)["capturedAt"])')",
 "finishedAt":"$(now)","requestsPerArm":$N,"quotaState":"$QUOTA_STATE",
 "g9":{"status":"$G9_STATUS","before":{"main":$MAIN_PRIO,"main-2":$MAIN2_PRIO},"after":{"main":1,"main-2":2}},
 "g11":{"status":"$G11_STATUS"},
 "g13":{"sigintTrapInstalled":$TRAP_INT_OK,
        "note":"false means SIGINT was ignored-on-entry (backgrounded by a non-interactive shell) and could not be trapped; SIGTERM/HUP/exit paths still restore."},
 "connections":{"main":"$MAIN_ID","main-2":"$MAIN2_ID"},
 "preRunAccountStrategy":"$PRE_ACCT_STRATEGY"}
META

# assemble_results also runs from the trap, so an aborted run still emits partial JSON.
assemble_results

cat <<WARN

────────────────────────────────────────────────────────────────────────────
G7 — RUN THE PER-ARM SQL BEFORE INTERPRETING THE GO/PAYG COLUMNS.

Those columns are PROVIDER-level. They answer the headline question -- did traffic
stay on opencode-go or fall through to OpenRouter -- and NOTHING FINER. They cannot
distinguish main from main-2: every pooled Go plan reports provider=opencode-go and
x-omniroute-selected-connection-id is emitted only on the 401 path.

Per-arm SQL with windows already filled in: $OUT/g7-*.sql
Machine-readable results for child 4:       $RESULTS_JSON

G10 (degeneracy) has run on whatever basis was available; see results.json
.g10.basis. If it says "provider-level", it could NOT see main vs main-2 and its
clusters are weaker than they look -- feed per-connection counts back in with
TOG207_CONN_COUNTS_CMD, or re-run TOG-207-assemble.py after filling conn-*.tsv.

quota_state=$QUOTA_STATE
If QUOTA_DEAD: B1/B2/B3 measured a tie-breaker, not quota. Do not rank them against
A1-A5, and do not deploy them -- they look like quota strategies and are not.

G2 / G2a — WHICH GUARD BACKS WHICH ARM (Rev 5, TOG-214).
  A1-A5 vary the ACCOUNT strategy. OmniRoute never echoes it: not in
  x-omniroute-decision, not in the SSE trailer, nowhere. arms[].g2.applicable is false
  on those arms and arms[].g2a is what backs them. An A-arm with g2a.verdict != PASS
  is UNATTRIBUTABLE -- discard it, do not rank it.
  B1-B3 vary the COMBO strategy, which IS echoed; arms[].g2 asserts it. g2.verdict
  NOCOV means zero observations, which is not a pass.
────────────────────────────────────────────────────────────────────────────
WARN
