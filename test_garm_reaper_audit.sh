#!/usr/bin/env bash
# ===========================================================================
# test_garm_reaper_audit.sh — offline suite for the GARM orphan/stale
# instance audit (read-only, propose-only).
#
# What it pins (each guard has a mutant or positive control proving the
# fixture exercises it):
#   0. PARSE — the audit script parses; --help exits 0 without side effects.
#   1. REFUSALS — unknown args, missing pools, bad TTL/mult/stuck values, a
#                 bad --now clock, an unreadable --pool-json, and a missing
#                 garm binary in live mode all refuse (exit 2), never a
#                 verdict.
#   2. READ-ONLY — the only GARM invocation in the audit script is
#                 `pool show --format json`; no delete/destroy/remove/stop/
#                 kill, no lxc/ssh/systemctl anywhere. A stub garm-cli proves
#                 it at runtime: its argv log carries only pool-show reads.
#   3. CLASSIFICATION — fixed-clock fixtures: healthy ages to OK; past-TTL
#                 busy/idle-excess/stale to PROPOSE (exit 0); orphan, stuck
#                 provisioning, stuck drain, unknown-age, and over-max to
#                 BREACH (exit 1) naming the instance.
#   4. WARM-SPARE EXEMPTION — the newest min_idle idle instances stay exempt
#                 whatever their age; only the oldest excess idle ages into
#                 candidacy. min_idle 1 over two ancient idles breaches on
#                 the oldest only; min_idle 2 is clean.
#   5. POSITIVE CONTROL — the healthy fixture under GARM_INSTANCE_TTL_MIN=1
#                 breaches, proving §3 green is sensitivity, not a dead tool.
#   6. OUT OF SCOPE — the cron push wrapper and the monitoring endpoint
#                 registration stay private with the monitoring stack; this
#                 suite pins the audit only (§0-5).
#
# Hermetic: fixture JSON files and a stub garm-cli on PATH. No host,
# network, credential, or GARM install is used.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUDIT="$HERE/github-runner/garm/audit_stale_instances.sh"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

[[ -f "$AUDIT" ]] || { echo "REFUSE: $AUDIT not found — suite cannot attribute a result"; exit 3; }
command -v jq >/dev/null || { echo "REFUSE: jq required"; exit 3; }
command -v python3 >/dev/null || { echo "REFUSE: python3 required"; exit 3; }
command -v curl >/dev/null || { echo "REFUSE: curl required"; exit 3; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

NOW="2026-10-03T14:00:00Z"
ago() { date -u -d "$NOW - $1 minutes" +%Y-%m-%dT%H:%M:%SZ; }  # ago <min> → ISO

# pool_doc <file> <min_idle> <max> <enabled> [<instance-json> ...]
pool_doc() {
  local f="$1" mi="$2" mx="$3" en="$4"; shift 4
  local insts=""
  if (( $# > 0 )); then
    insts="$(printf '%s\n' "$@" | jq -cs '.')"
  else
    insts="[]"
  fi
  jq -cn --argjson mi "$mi" --argjson mx "$mx" --argjson en "$en" --argjson ii "$insts" \
    '{id:"pool-aaaa1111-bbbb-cccc-dddd-eeeeffff0000",enabled:$en,min_idle_runners:$mi,max_runners:$mx,provider_name:"lxd",instances:$ii}' > "$f"
}
# inst <name> <status> <runner_status> <age_min|"ABSENT">
inst() {
  if [[ "$4" == "ABSENT" ]]; then
    jq -cn --arg n "$1" --arg s "$2" --arg r "$3" '{name:$n,status:$s,runner_status:$r}'
  else
    jq -cn --arg n "$1" --arg s "$2" --arg r "$3" --arg c "$(ago "$4")" \
      '{name:$n,status:$s,runner_status:$r,created_at:$c,updated_at:$c}'
  fi
}

run_audit() {  # run_audit [--json] <pool-json>... → stdout in $OUT, exit in $RC
  local use_json=0
  [[ "${1:-}" == "--json" ]] && { use_json=1; shift; }
  local args=()
  for f in "$@"; do args+=(--pool-json "$f"); done
  if (( use_json )); then OUT="$("$AUDIT" --json --now "$NOW" "${args[@]}" 2>"$WORK/err")"; RC=$?
  else OUT="$("$AUDIT" --now "$NOW" "${args[@]}" 2>"$WORK/err")"; RC=$?; fi
}
verdict_of() { jq -r '.verdict // empty' <<<"$1" 2>/dev/null; }

# === 0. parse + help ========================================================
echo "=== 0. parse + help ==="
bash -n "$AUDIT" && ok "0a. audit script parses" || bad "0a. audit script parses"
"$AUDIT" --help >/dev/null 2>&1 && [[ $? -eq 0 ]] && ok "0c. --help exits 0" || bad "0c. --help exits 0"
"$AUDIT" --frobnicate >/dev/null 2>&1; [[ $? -eq 2 ]] && ok "0d. unknown arg refuses (exit 2)" || bad "0d. unknown arg refuses"

# === 1. refusals ==============================================================
echo "=== 1. refusals ==="
GARM_POOLS="" "$AUDIT" >/dev/null 2>&1; [[ $? -eq 2 ]] && ok "1a. live mode without pools refuses" || bad "1a. live mode without pools refuses"
"$AUDIT" --pool-json /nonexistent.json >/dev/null 2>&1; [[ $? -eq 2 ]] && ok "1b. unreadable --pool-json refuses" || bad "1b. unreadable --pool-json refuses"
"$AUDIT" --now "not-a-time" --pool-json /dev/null >/dev/null 2>&1; [[ $? -eq 2 ]] && ok "1c. bad --now refuses" || bad "1c. bad --now refuses"
pool_doc "$WORK/p.json" 0 5 true
GARM_INSTANCE_TTL_MIN=0 "$AUDIT" --pool-json "$WORK/p.json" >/dev/null 2>&1; [[ $? -eq 2 ]] && ok "1d. TTL 0 refuses" || bad "1d. TTL 0 refuses"
GARM_INSTANCE_TTL_MIN=abc "$AUDIT" --pool-json "$WORK/p.json" >/dev/null 2>&1; [[ $? -eq 2 ]] && ok "1e. non-numeric TTL refuses" || bad "1e. non-numeric TTL refuses"
GARM_BIN=definitely-not-a-garm-binary GARM_POOLS=pool-x "$AUDIT" >/dev/null 2>&1; [[ $? -eq 2 ]] && ok "1f. missing garm binary refuses" || bad "1f. missing garm binary refuses"

# === 2. read-only =============================================================
echo "=== 2. read-only ==="
# Static: the only GARM invocation shape in either file is `pool show`.
invocs="$(grep -hoE '"\$GARM_BIN" [a-z-]+ [a-z-]+|"garm-cli" [a-z-]+ [a-z-]+' "$AUDIT" 2>/dev/null | sort -u)"
[[ "$invocs" == '"$GARM_BIN" pool show' ]] && ok "2a. sole GARM invocation is pool show" || bad "2a. sole GARM invocation is pool show" "$invocs"
# Verb-position match on code lines only (status strings like pending_delete
# and doc prose are not invocations). Any GARM mutating verb, any lxc/ssh/
# systemctl command, or any HTTP DELETE on a code line fails the suite.
if grep -v '^[[:space:]]*#' "$AUDIT" \
  | grep -nEi 'garm-cli[^"`]*\b(delete|destroy|remove|stop|create|update|add)\b|\$GARM_BIN[^"`]*\b(delete|destroy|remove|stop|create|update|add)\b|(^|[;&|])[[:space:]]*(lxc|ssh|systemctl)([[:space:]]|$)|--method[[:space:]]+DELETE|-X[[:space:]]+DELETE' >/dev/null; then
  bad "2b. no mutating/host invocation in either script" "match above"
else
  ok "2b. no mutating/host invocation in either script"
fi
# Runtime: stub garm-cli records argv; the audit must only ever read.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/stub-garm" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$STUB_LOG"
cat "$STUB_POOL"
STUB
chmod +x "$WORK/bin/stub-garm"
pool_doc "$WORK/live.json" 0 5 true "$(inst vm-live running active 30)"
STUB_LOG="$WORK/argv.log" STUB_POOL="$WORK/live.json" PATH="$WORK/bin:$PATH" \
  GARM_BIN=stub-garm GARM_POOLS="pool-live" "$AUDIT" --now "$NOW" >/dev/null 2>&1
if grep -q . "$WORK/argv.log" 2>/dev/null && ! grep -Ei 'delete|destroy|remove|stop|kill' "$WORK/argv.log" >/dev/null; then
  grep -q 'pool show' "$WORK/argv.log" && ok "2c. live run issues only pool-show reads" || bad "2c. live run issues only pool-show reads" "$(cat "$WORK/argv.log")"
else
  bad "2c. live run issues only pool-show reads" "$(cat "$WORK/argv.log" 2>/dev/null)"
fi

# === 3. classification ==========================================================
echo "=== 3. classification ==="
# Healthy: one ancient warm spare (exempt) + one young busy job.
pool_doc "$WORK/healthy.json" 1 5 true "$(inst vm-spare running idle 600)" "$(inst vm-job running active 30)"
run_audit --json "$WORK/healthy.json"
[[ "$RC" == "0" && "$(verdict_of "$OUT")" == "OK" ]] && ok "3a. healthy pool verdicts OK (exit 0)" || bad "3a. healthy pool verdicts OK" "rc=$RC out=$OUT"
# Past-TTL busy (300m, orphan at 480m) → PROPOSE, still exit 0.
pool_doc "$WORK/propose.json" 0 5 true "$(inst vm-long running active 300)"
run_audit --json "$WORK/propose.json"
[[ "$RC" == "0" && "$(verdict_of "$OUT")" == "PROPOSE" ]] && ok "3b. past-TTL busy proposes without breach" || bad "3b. past-TTL busy proposes without breach" "rc=$RC out=$OUT"
grep -q 'vm-long' <<<"$OUT" && ok "3c. proposal names the instance" || bad "3c. proposal names the instance" "$OUT"
# Busy orphan (600m) → BREACH.
pool_doc "$WORK/orphan.json" 0 5 true "$(inst vm-orphan running active 600)"
run_audit --json "$WORK/orphan.json"
[[ "$RC" == "1" && "$(verdict_of "$OUT")" == "BREACH" ]] && ok "3d. busy orphan breaches" || bad "3d. busy orphan breaches" "rc=$RC out=$OUT"
grep -q 'vm-orphan' <<<"$OUT" && ok "3e. breach names the orphan" || bad "3e. breach names the orphan" "$OUT"
# Stuck provisioning (creating 45m) → BREACH; young creating (10m) → info only.
pool_doc "$WORK/provstuck.json" 0 5 true "$(inst vm-prov creating installing 45)"
run_audit --json "$WORK/provstuck.json"
[[ "$RC" == "1" && "$(verdict_of "$OUT")" == "BREACH" ]] && ok "3f. stuck provisioning breaches" || bad "3f. stuck provisioning breaches" "rc=$RC out=$OUT"
pool_doc "$WORK/provyoung.json" 0 5 true "$(inst vm-boot creating installing 10)"
run_audit --json "$WORK/provyoung.json"
[[ "$RC" == "0" && "$(verdict_of "$OUT")" == "OK" ]] && ok "3g. young provisioning is info only" || bad "3g. young provisioning is info only" "rc=$RC out=$OUT"
# Stuck drain (deleting 90m) → BREACH; young drain (10m) → info only.
pool_doc "$WORK/drainstuck.json" 0 5 true "$(inst vm-drain deleting deleting 90)"
run_audit --json "$WORK/drainstuck.json"
[[ "$RC" == "1" && "$(verdict_of "$OUT")" == "BREACH" ]] && ok "3h. stuck drain breaches" || bad "3h. stuck drain breaches" "rc=$RC out=$OUT"
pool_doc "$WORK/drainyoung.json" 0 5 true "$(inst vm-drain deleting deleting 10)"
run_audit --json "$WORK/drainyoung.json"
[[ "$RC" == "0" ]] && ok "3i. young drain is info only" || bad "3i. young drain is info only" "rc=$RC out=$OUT"
# Unknown age (no created_at) → BREACH, never a pass.
pool_doc "$WORK/unknown.json" 0 5 true "$(inst vm-mystery running active ABSENT)"
run_audit --json "$WORK/unknown.json"
[[ "$RC" == "1" ]] && grep -q 'unknown-age' <<<"$OUT" && ok "3j. unknown age fails closed" || bad "3j. unknown age fails closed" "rc=$RC out=$OUT"
# Over-max (2 young instances, max 1) → BREACH.
pool_doc "$WORK/overmax.json" 0 1 true "$(inst vm-a running active 5)" "$(inst vm-b running idle 5)"
run_audit --json "$WORK/overmax.json"
[[ "$RC" == "1" ]] && grep -q 'over max' <<<"$OUT" && ok "3k. over-max breaches (size cap)" || bad "3k. over-max breaches" "rc=$RC out=$OUT"
# Stale stopped past TTL → PROPOSE; past orphan → BREACH.
pool_doc "$WORK/stopped.json" 0 5 true "$(inst vm-stop stopped stopped 300)"
run_audit --json "$WORK/stopped.json"
[[ "$RC" == "0" && "$(verdict_of "$OUT")" == "PROPOSE" ]] && ok "3l. stale stopped past TTL proposes" || bad "3l. stale stopped past TTL proposes" "rc=$RC out=$OUT"

# === 4. warm-spare exemption ======================================================
echo "=== 4. warm-spare exemption ==="
# min_idle 1, two ancient idles: only the OLDEST is excess → breaches alone.
pool_doc "$WORK/spares.json" 1 5 true "$(inst vm-old running idle 600)" "$(inst vm-new running idle 500)"
run_audit --json "$WORK/spares.json"
if [[ "$RC" == "1" ]] && grep -q 'vm-old' <<<"$OUT" && ! grep -q 'vm-new.*idle-excess' <<<"$OUT"; then
  ok "4a. only the oldest excess idle breaches; newest stays spare"
else
  bad "4a. only the oldest excess idle breaches; newest stays spare" "rc=$RC out=$OUT"
fi
# min_idle 2 covers both: clean.
pool_doc "$WORK/spares2.json" 2 5 true "$(inst vm-old running idle 600)" "$(inst vm-new running idle 500)"
run_audit --json "$WORK/spares2.json"
[[ "$RC" == "0" && "$(verdict_of "$OUT")" == "OK" ]] && ok "4b. min_idle covering all idles is clean" || bad "4b. min_idle covering all idles is clean" "rc=$RC out=$OUT"

# === 5. positive control ============================================================
echo "=== 5. positive control ==="
GARM_INSTANCE_TTL_MIN=1 run_audit --json "$WORK/healthy.json"
[[ "$RC" == "1" ]] && ok "5a. healthy fixture breaches under TTL=1 (suite can go red)" || bad "5a. healthy fixture breaches under TTL=1" "rc=$RC out=$OUT"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
