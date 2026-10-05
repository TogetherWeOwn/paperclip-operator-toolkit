#!/usr/bin/env bash
# ===========================================================================
# test-host-audit-wrapper-checks.sh — offline regression suite for the host-audit wrapper
# host-cron audit wrappers.
#
# These three wrappers run unattended on the host under systemd --user with a
# long-lived agent API key. Nothing else in CI exercises them: before this
# suite they were covered only by the blanket "Syntax check every script"
# step, which is why a dead findings path survived review here once.
#
# Five contracts, each with a positive control that proves the assertion can
# still fail:
#   1. FINDINGS-ONLY  — a clean detector makes ZERO API calls.
#   2. FAIL-CLOSED    — a detector that exits 1 or 2, or is missing entirely,
#                       posts a card. Never silence.
#   3. COALESCING     — an already-open card with the same tag gets a comment,
#                       not a second card.
#   4. NON-DISCLOSURE — neither the API key nor the request body ever reaches
#                       curl's argv (/proc/<pid>/cmdline is world-readable).
#   5. DELIVERY       — a non-2xx from the API is never reported as a posted
#                       finding; the wrapper fails loudly instead.
#
# ALL THREE wrappers are executed. The first cut of this suite ran only
# git_remote_credential_sweep_check.sh, and that gap is exactly why two more
# fail-open sites and an inert guard survived it (see the B1/B2/N1 cases below).
#
# Hermetic: no network beyond 127.0.0.1, no credentials, no real detectors.
# A stub API server records what was called; a curl shim records argv.
# ===========================================================================
set -Eeuo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
SRC="${REPO_ROOT}/ops/tog-3554"
PORT="${TOG3554_TEST_PORT:-8791}"
SENTINEL_KEY="SENTINELKEY-must-never-reach-argv"

pass=0; fail=0
ok()   { printf '  ok   %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  FAIL %s\n' "$1"; fail=$((fail+1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; [[ -n "${SRV_PID:-}" ]] && kill "$SRV_PID" 2>/dev/null' EXIT

[[ -d "$SRC" ]] || { echo "REFUSE: ${SRC} not found — suite cannot attribute a result"; exit 3; }

# --- stub API ------------------------------------------------------------
# Records every request to $WORK/calls.jsonl. `seed_open_card` controls
# whether the coalescing lookup finds an existing open card.
cat > "$WORK/api.py" <<'PY'
import http.server, json, os, sys
CALLS = os.environ["CALLS_FILE"]
SEED  = os.environ.get("SEED_OPEN_CARD", "")
STATUS = int(os.environ.get("HTTP_STATUS", "200"))
class H(http.server.BaseHTTPRequestHandler):
    def _h(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n).decode() if n else ""
        with open(CALLS, "a") as f:
            f.write(json.dumps({"m": self.command, "p": self.path,
                                "auth": self.headers.get("Authorization"),
                                "body": body}) + "\n")
        self.send_response(STATUS)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        if self.command == "GET":
            items = ([{"id": "existing-card-id", "title": SEED}] if SEED else [])
            self.wfile.write(json.dumps(items).encode())
        else:
            self.wfile.write(b'{"id":"created-card-id"}')
    do_GET = _h
    do_POST = _h
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PY

# --- curl shim -----------------------------------------------------------
# Records its own argv, then execs the real curl. This is how contract 4 is
# observed: whatever lands here is what a `ps` on the host would show.
REAL_CURL="$(command -v curl)"
mkdir -p "$WORK/bin"
cat > "$WORK/bin/curl" <<SHIM
#!/usr/bin/env bash
printf '%s\0' "\$@" >> "${WORK}/argv.bin"
exec "${REAL_CURL}" "\$@"
SHIM
chmod +x "$WORK/bin/curl"

# --- sandbox: a fake repo root holding the wrappers + stub detectors ------
# build_sandbox <name>; then write stub detectors into $SBX/
build_sandbox() {
  SBX="$WORK/$1"
  rm -rf "$SBX"; mkdir -p "$SBX"
  cp -r "$SRC" "$SBX/tog-3554-dir"
  mkdir -p "$SBX/ops"
  mv "$SBX/tog-3554-dir" "$SBX/ops/tog-3554"
}

stub_detector() { # stub_detector <path> <exit-code> <stdout-line>
  cat > "$1" <<EOF
#!/usr/bin/env bash
echo "$3"
exit $2
EOF
  chmod +x "$1"
}

start_api() { # start_api [seed-open-card-title] [http-status]
  : > "$WORK/calls.jsonl"; : > "$WORK/argv.bin"
  CALLS_FILE="$WORK/calls.jsonl" SEED_OPEN_CARD="${1:-}" HTTP_STATUS="${2:-200}" \
    python3 "$WORK/api.py" "$PORT" & SRV_PID=$!
  for _ in $(seq 1 50); do
    (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null && break
    sleep 0.1
  done
}
stop_api() { [[ -n "${SRV_PID:-}" ]] && kill "$SRV_PID" 2>/dev/null; SRV_PID=""; wait 2>/dev/null || true; }

run_wrapper() { # run_wrapper <sandbox-dir> <wrapper.sh> [EXTRA=env ...] -> prints exit code
  local sbx="$1" wrapper="$2"; shift 2
  local rc=0
  # `env -u BASH_ENV` is load-bearing, not tidiness. Where BASH_ENV is set
  # (Paperclip agent sandboxes set it to a runtime .bashrc), every
  # non-interactive bash sources that file, and it REWRITES PATH -- so the
  # curl shim below silently never runs and contract 4 would assert nothing.
  # The `-s argv.bin` refusal further down is the backstop if this regresses.
  env -u BASH_ENV \
    PATH="$WORK/bin:$PATH" \
    PAPERCLIP_API_URL="http://127.0.0.1:$PORT" \
    PAPERCLIP_AGENT_API_KEY="$SENTINEL_KEY" \
    PAPERCLIP_COMPANY_ID="test-company" \
    PAPERCLIP_ASSIGNEE_AGENT_ID="test-agent" \
    TOG3554_OPS_DIR="$sbx/ops" \
    TOG3554_TRANSCRIPT_ROOT="$sbx/transcripts" \
    "$@" \
    bash "$sbx/ops/tog-3554/${wrapper}" >/dev/null 2>"$WORK/stderr.txt" || rc=$?
  echo "$rc"
}

run_sweep() { run_wrapper "$1" git_remote_credential_sweep_check.sh; }

stderr_txt() { cat "$WORK/stderr.txt"; }

# Stub detectors for the other two wrappers, under $SBX/ops (TOG3554_OPS_DIR).
# daemon_rc / start_rc / redact_rc / eligible are read from the environment at
# run time so one sandbox can serve several scenarios.
stub_sweeper_deps() { # stub_sweeper_deps <sandbox>
  mkdir -p "$1/ops/tog-1079"
  cat > "$1/ops/tog-1079/sweep_daemon.sh" <<'D'
#!/usr/bin/env bash
case "$1" in
  check) echo "daemon check output"; exit "${STUB_CHECK_RC:-0}" ;;
  stop)  echo "stopped"; exit 0 ;;
  start) echo "start output"; exit "${STUB_START_RC:-0}" ;;
esac
exit 0
D
  chmod +x "$1/ops/tog-1079/sweep_daemon.sh"
  cat > "$1/ops/tog-1079/redact_session_secrets.py" <<'R'
import os, sys
print("keys eligible for redaction: %s" % os.environ.get("STUB_ELIGIBLE", "0"))
sys.exit(int(os.environ.get("STUB_REDACT_RC", "0")))
R
}

stub_transcript_deps() { # stub_transcript_deps <sandbox> <exit-code>
  mkdir -p "$1/ops/tog-983" "$1/transcripts"
  stub_detector "$1/ops/tog-983/transcript-mode-audit.sh" "$2" "sidecars=12 drifted=3"
}

calls() { wc -l < "$WORK/calls.jsonl" | tr -d ' '; }
methods_paths() { python3 -c '
import json,sys
for l in open(sys.argv[1]):
    d=json.loads(l); print(d["m"], d["p"].split("?")[0])
' "$WORK/calls.jsonl"; }

echo "host-check contracts"

# === 1. FINDINGS-ONLY ====================================================
build_sandbox clean
stub_detector "$SBX/ops/git_remote_credential_scan.sh" 0 "CLEAN"
start_api
rc="$(run_sweep "$SBX")"
n="$(calls)"
stop_api
[[ "$rc" == "0" && "$n" == "0" ]] \
  && ok "clean detector: wrapper exits 0 and makes 0 API calls" \
  || bad "clean detector should be silent (exit=$rc calls=$n)"

# === 2. FAIL-CLOSED ======================================================
for spec in "1:findings" "2:indeterminate"; do
  code="${spec%%:*}"; label="${spec##*:}"
  build_sandbox "exit$code"
  stub_detector "$SBX/ops/git_remote_credential_scan.sh" "$code" \
    "FINDING repo=/fake config_line=7 kind=gh-app-installation-token host=github.com perms=x"
  start_api
  rc="$(run_sweep "$SBX")"
  n="$(calls)"
  stop_api
  [[ "$rc" == "0" && "$n" -ge 2 ]] \
    && ok "detector exit $code ($label): a card is posted (exit=$rc calls=$n)" \
    || bad "detector exit $code ($label) must post, not die (exit=$rc calls=$n)"
done

# A detector that is missing entirely is indeterminate, not clean.
build_sandbox missing
rm -f "$SBX/ops/git_remote_credential_scan.sh"
start_api
rc="$(run_sweep "$SBX")"
n="$(calls)"
stop_api
[[ "$rc" == "0" && "$n" -ge 2 ]] \
  && ok "missing detector: reported as a finding, not silently clean" \
  || bad "missing detector must post (exit=$rc calls=$n)"

# Positive control: the fail-closed assertion above must be able to fail.
# Re-introduce exactly the dead-findings bug (rc read after an unguarded command
# substitution under set -e) in a COPY, and require the suite to notice.
build_sandbox mutant
stub_detector "$SBX/ops/git_remote_credential_scan.sh" 1 "FINDING repo=/fake"
python3 - "$SBX/ops/tog-3554/git_remote_credential_sweep_check.sh" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
fixed = 'scan_rc=0\nscan_out="$("$SCAN_SCRIPT" 2>&1)" || scan_rc=$?\n'
buggy = 'scan_out="$("$SCAN_SCRIPT" 2>&1)"\nscan_rc=$?\n'
if fixed not in s:
    sys.stderr.write("REFUSE: guarded form not found — control cannot be built\n")
    sys.exit(3)
open(p, "w").write(s.replace(fixed, buggy, 1))
PY
start_api
rc="$(run_sweep "$SBX")"
n="$(calls)"
stop_api
[[ "$n" == "0" ]] \
  && ok "positive control: the dead-findings bug still produces 0 calls (suite is not vacuous)" \
  || bad "positive control did not reproduce the bug (calls=$n) — the fail-closed check may be vacuous"

# === 3. COALESCING =======================================================
build_sandbox coalesce
stub_detector "$SBX/ops/git_remote_credential_scan.sh" 1 "FINDING repo=/fake"
start_api "[tog3554-git-remote-credential-sweep] already open"
rc="$(run_sweep "$SBX")"
paths="$(methods_paths)"
stop_api
if grep -q "POST /api/issues/existing-card-id/comments" <<<"$paths" \
   && ! grep -q "POST /api/companies/test-company/issues" <<<"$paths"; then
  ok "an open card with the same tag gets a comment, not a duplicate card"
else
  bad "coalescing failed; calls were: $(tr '\n' '|' <<<"$paths")"
fi

# Positive control: with no open card, it MUST create one — otherwise the
# assertion above would pass for a helper that never posts at all.
build_sandbox nocoalesce
stub_detector "$SBX/ops/git_remote_credential_scan.sh" 1 "FINDING repo=/fake"
start_api ""
rc="$(run_sweep "$SBX")"
paths="$(methods_paths)"
stop_api
grep -q "POST /api/companies/test-company/issues" <<<"$paths" \
  && ok "positive control: with no open card, a new card is created" \
  || bad "no-open-card path did not create; calls were: $(tr '\n' '|' <<<"$paths")"

# === 4. NON-DISCLOSURE ===================================================
# $WORK/argv.bin holds every argument every curl was invoked with, from the
# coalescing run above. Neither the key nor the finding body may appear.
build_sandbox argv
stub_detector "$SBX/ops/git_remote_credential_scan.sh" 1 \
  "FINDING repo=/fake config_line=7 kind=gh-app-installation-token host=github.com perms=x"
start_api ""
rc="$(run_sweep "$SBX")"
stop_api
argv_txt="$(tr '\0' '\n' < "$WORK/argv.bin")"
[[ -s "$WORK/argv.bin" ]] || bad "REFUSE: curl shim recorded nothing — contract 4 unproven"
if [[ -s "$WORK/argv.bin" ]]; then
  grep -qF "$SENTINEL_KEY" <<<"$argv_txt" \
    && bad "the API key reached curl argv (/proc/<pid>/cmdline)" \
    || ok "the API key never reaches curl argv"
  grep -qF "gh-app-installation-token" <<<"$argv_txt" \
    && bad "the finding body reached curl argv" \
    || ok "the finding body never reaches curl argv"
fi

# Positive control: the argv check must be able to see a leak. Invoke the
# real curl the old way and confirm the same grep fires.
: > "$WORK/argv.bin"
start_api ""
env -u BASH_ENV PATH="$WORK/bin:$PATH" curl -sS -o /dev/null \
  -H "Authorization: Bearer $SENTINEL_KEY" "http://127.0.0.1:$PORT/unused" 2>/dev/null || true
stop_api
grep -qF "$SENTINEL_KEY" <(tr '\0' '\n' < "$WORK/argv.bin") \
  && ok "positive control: an -H bearer on argv IS detected by this check" \
  || bad "positive control failed — the argv check cannot see a real leak"

# === 5. SWEEPER WATCHDOG (contracts 1 + 2 on the second wrapper) =========
# A healthy host: daemon check passes, dry-run reports 0 eligible, no GAP or
# ALERT file. Nothing to say, so nothing may be said.
build_sandbox wd_clean; stub_sweeper_deps "$SBX"
start_api
rc="$(run_wrapper "$SBX" sweeper_watchdog_check.sh STUB_CHECK_RC=0 STUB_ELIGIBLE=0)"
n="$(calls)"
stop_api
[[ "$rc" == "0" && "$n" == "0" ]] \
  && ok "watchdog, healthy host: exits 0 and makes 0 API calls" \
  || bad "watchdog must be silent on a healthy host (exit=$rc calls=$n)"

# Positive control for the line above: restore the `\b` guard, which bash's
# POSIX ERE does not honour, and the clean host starts posting every tick.
build_sandbox wd_inert; stub_sweeper_deps "$SBX"
python3 - "$SBX/ops/tog-3554/sweeper_watchdog_check.sh" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
fixed = 'if [[ "$eligible_line" =~ :[[:space:]]*([0-9]+) ]]; then'
if fixed not in s:
    sys.stderr.write("REFUSE: numeric eligible-count parse not found — control cannot be built\n")
    sys.exit(3)
open(p, "w").write(s.replace(fixed, 'if [[ ! "$eligible_line" =~ :\\ *0\\b ]] && false; then', 1))
PY
start_api
rc="$(run_wrapper "$SBX" sweeper_watchdog_check.sh STUB_CHECK_RC=0 STUB_ELIGIBLE=0)"
n="$(calls)"
stop_api
[[ "$n" -ge 2 ]] \
  && ok "positive control: an inert count guard IS caught by the healthy-host check" \
  || bad "positive control failed — the healthy-host check cannot see an inert guard (calls=$n)"

# A non-zero eligible count is a finding.
build_sandbox wd_eligible; stub_sweeper_deps "$SBX"
start_api
rc="$(run_wrapper "$SBX" sweeper_watchdog_check.sh STUB_CHECK_RC=0 STUB_ELIGIBLE=7)"
n="$(calls)"
stop_api
[[ "$rc" == "0" && "$n" -ge 2 ]] \
  && ok "watchdog: a non-zero eligible count posts a card" \
  || bad "watchdog missed a non-zero eligible count (exit=$rc calls=$n)"

# The case that most needs a card: daemon dead AND the restart fails.
build_sandbox wd_dead; stub_sweeper_deps "$SBX"
start_api
rc="$(run_wrapper "$SBX" sweeper_watchdog_check.sh STUB_CHECK_RC=1 STUB_START_RC=1)"
n="$(calls)"
stop_api
[[ "$rc" == "0" && "$n" -ge 2 ]] \
  && ok "watchdog: daemon dead + restart FAILS still posts a card" \
  || bad "watchdog died instead of posting (exit=$rc calls=$n)"

# Positive control: unguard the restart — the B1 fail-open shape — and the
# assertion above must go to 0 calls.
build_sandbox wd_mutant; stub_sweeper_deps "$SBX"
python3 - "$SBX/ops/tog-3554/sweeper_watchdog_check.sh" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
fixed = 'restart_rc=0\n    restart_out="$({ "$SWEEP_DAEMON" stop 2>&1; "$SWEEP_DAEMON" start 2>&1; })" || restart_rc=$?\n'
buggy = 'restart_rc=0\n    restart_out="$("$SWEEP_DAEMON" stop 2>&1; "$SWEEP_DAEMON" start 2>&1)"\n'
if fixed not in s:
    sys.stderr.write("REFUSE: guarded restart not found — control cannot be built\n")
    sys.exit(3)
open(p, "w").write(s.replace(fixed, buggy, 1))
PY
start_api
rc="$(run_wrapper "$SBX" sweeper_watchdog_check.sh STUB_CHECK_RC=1 STUB_START_RC=1)"
n="$(calls)"
stop_api
[[ "$n" == "0" ]] \
  && ok "positive control: an unguarded restart reproduces the 0-call fail-open" \
  || bad "positive control did not reproduce B1 (calls=$n) — this check may be vacuous"

# A dry-run that cannot complete is indeterminate, which is a finding.
build_sandbox wd_redactfail; stub_sweeper_deps "$SBX"
start_api
rc="$(run_wrapper "$SBX" sweeper_watchdog_check.sh STUB_CHECK_RC=0 STUB_REDACT_RC=1)"
n="$(calls)"
stop_api
[[ "$rc" == "0" && "$n" -ge 2 ]] \
  && ok "watchdog: a failing --dry-run is posted, not fatal" \
  || bad "watchdog died on a failing --dry-run (exit=$rc calls=$n)"

# === 6. TRANSCRIPT MODE AUDIT (third wrapper) ============================
build_sandbox tr_clean; stub_transcript_deps "$SBX" 0
start_api
rc="$(run_wrapper "$SBX" transcript_mode_audit_check.sh)"
n="$(calls)"
stop_api
[[ "$rc" == "0" && "$n" == "0" ]] \
  && ok "transcript audit, clean: exits 0 and makes 0 API calls" \
  || bad "transcript audit must be silent when clean (exit=$rc calls=$n)"

for code in 1 2; do
  build_sandbox "tr_exit$code"; stub_transcript_deps "$SBX" "$code"
  start_api
  rc="$(run_wrapper "$SBX" transcript_mode_audit_check.sh)"
  n="$(calls)"
  stop_api
  [[ "$rc" == "0" && "$n" -ge 2 ]] \
    && ok "transcript audit exit $code: posts a card" \
    || bad "transcript audit exit $code must post (exit=$rc calls=$n)"
done

build_sandbox tr_missing; stub_transcript_deps "$SBX" 0
rm -f "$SBX/ops/tog-983/transcript-mode-audit.sh"
start_api
rc="$(run_wrapper "$SBX" transcript_mode_audit_check.sh)"
n="$(calls)"
stop_api
[[ "$rc" == "0" && "$n" -ge 2 ]] \
  && ok "transcript audit: a missing detector is a finding, not clean" \
  || bad "missing transcript detector must post (exit=$rc calls=$n)"

# === 7. DELIVERY: a non-2xx is never reported as a posted finding ========
# `curl -sS` exits 0 on a 403, so without an explicit status check the helper
# announces success against an API that stored nothing (the B3 shape) — and
# INSTALL.md §1's least-privilege trial and §2's rotation become unfalsifiable.
build_sandbox deny
stub_detector "$SBX/ops/git_remote_credential_scan.sh" 1 "FINDING repo=/fake"
start_api "" 403
rc="$(run_sweep "$SBX")"
err="$(stderr_txt)"
stop_api
if [[ "$rc" != "0" ]] && ! grep -q "created new card" <<<"$err"; then
  ok "a 403 API fails the wrapper loudly instead of claiming a card was created"
else
  bad "a 403 was reported as a posted finding (exit=$rc stderr: $(tr '\n' '|' <<<"$err"))"
fi
grep -q "403" <<<"$err" \
  && ok "the failure names the HTTP status the API actually returned" \
  || bad "the delivery failure does not name the status (stderr: $(tr '\n' '|' <<<"$err"))"

# Positive control: the identical scenario over a 200 must succeed, so the
# two assertions above cannot be satisfied by a helper that always fails.
build_sandbox allow
stub_detector "$SBX/ops/git_remote_credential_scan.sh" 1 "FINDING repo=/fake"
start_api "" 200
rc="$(run_sweep "$SBX")"
err="$(stderr_txt)"
stop_api
[[ "$rc" == "0" ]] && grep -q "created new card" <<<"$err" \
  && ok "positive control: over a 200 the same path posts and exits 0" \
  || bad "positive control failed — the delivery check may reject everything (exit=$rc)"

# === secret hygiene of the package itself ================================
# The shape the Offline job's Secret scan greps for. A decoy in a runbook is
# still a failure; keep the shape assembled at run time (INSTALL.md §4).
if git -C "$REPO_ROOT" grep -qIE '(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})' -- ops/tog-3554 2>/dev/null; then
  bad "a token-shaped literal is committed under ops/tog-3554"
else
  ok "no token-shaped literal under ops/tog-3554"
fi

# The credential must be named for the principal it actually is.
if grep -rq "PAPERCLIP_BOARD_API_KEY" "$SRC"; then
  bad "PAPERCLIP_BOARD_API_KEY survives — POST /agents/{id}/keys mints an AGENT key"
else
  ok "the credential is named PAPERCLIP_AGENT_API_KEY, matching its principal"
fi

echo
echo "passed=$pass failed=$fail"
[[ $fail -eq 0 ]]
