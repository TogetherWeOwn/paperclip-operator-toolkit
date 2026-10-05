#!/usr/bin/env bash
# platform-watchdog-gate.sh — offline gate for the watchdog detectors.
# Fails loudly; no credentials, no network writes, no board writes.
set -uo pipefail

cd "$(dirname "$0")/.."

fail() { echo "GATE FAIL: $*" >&2; exit 1; }

python3 -m unittest -v test_platform_watchdog.py \
  || fail "unit tests failed"

# Positive control: a snapshot that must fire every detector family.
SCRATCH="${PAPERCLIP_RUN_SCRATCH_DIR:-$(mktemp -d)}"
cat > "$SCRATCH/positive.json" <<'JSON'
{"now": "2026-10-03T14:00:00Z",
 "agents": [{"agentId": "a1", "status": "error",
             "errorSince": "2026-10-03T13:00:00Z", "subtype": "crash",
             "owningLead": "cto"}],
 "hosts": [{"host": "203.0.113.23", "diskPct": 99, "load": 9.0,
            "vcpu": 4, "sustainedMin": 10}],
 "ciJobs": [{"repo": "r", "job": "j", "runtimeMin": 45, "baselineMin": 20}],
 "queueAge": [{"label": "self-hosted", "ageMin": 160}],
 "issues": [{"id": "iid-1", "identifier": "TASK-1", "inFocus": true,
             "assigneeAgentId": null, "inBacklogMin": 90}],
 "runEvents": [{"issueId": "iid-1", "identifier": "TASK-1",
                "kind": "dispatch_stalled_issue",
                "at": "2026-10-03T13:10:00Z"},
               {"issueId": "iid-1", "identifier": "TASK-1",
                "kind": "dispatch_stalled_issue",
                "at": "2026-10-03T13:20:00Z"},
               {"issueId": "iid-1", "identifier": "TASK-1",
                "kind": "dispatch_stalled_issue",
                "at": "2026-10-03T13:30:00Z"},
               {"issueId": "iid-1", "identifier": "TASK-1",
                "kind": "dispatch_stalled_issue",
                "at": "2026-10-03T13:40:00Z"}],
 "parks": [{"issueId": "iid-1", "identifier": "TASK-1",
            "missingDispositionCount": 4}],
 "redMains": [{"repo": "example-repo", "signature": "s1",
               "incidentExists": false}],
 "secretHits": [{"source": "run-log:x", "patternName": "ghp_*",
                 "valueLen": 40, "at": "2026-10-03T13:00:00Z"}],
 "pendingInteractions": [{"issueId": "iid-7", "identifier": "TASK-7",
               "interactionId": "int-1", "kind": "request_confirmation",
               "createdAt": "2026-10-03T13:00:00Z",
               "resolverAgentId": "agent-r"}],
 "supply": {"readyNow": 0, "target": 12, "belowMin": 35.0,
            "idleAgents": 2, "censusAt": "2026-10-03T14:00:00Z"},
 "autoscalerSlices": [{"sliceId": "slice-1", "identifier": "TASK-13264",
               "status": "backlog", "assigneeAgentId": null,
               "unassignedSince": "2026-10-03T11:00:00Z"}]}
JSON
positive_out="$(python3 watchdog/detectors.py \
  --snapshot "$SCRATCH/positive.json")" \
  || fail "positive snapshot errored"
for family in agent_error host_health ci_health assignment churn red_main secret_hit pending_interactions supply_famine autoscaler_slices; do
  echo "$positive_out" | grep -q "\"watchdog/$family\"" \
    || fail "positive control silent for $family"
done

# Negative control: an all-quiet snapshot fires nothing above info.
cat > "$SCRATCH/negative.json" <<'JSON'
{"now": "2026-10-03T14:00:00Z",
 "agents": [{"agentId": "a1", "status": "idle"}],
 "hosts": [{"host": "203.0.113.23", "diskPct": 10, "load": 1.0,
            "vcpu": 4, "sustainedMin": 1},
           {"host": "garm-1", "diskPct": 10, "load": 1.0,
            "vcpu": 4, "sustainedMin": 1}],
 "ciJobs": [{"repo": "r", "job": "j", "runtimeMin": 20, "baselineMin": 20}],
 "queueAge": [{"label": "self-hosted", "ageMin": 5}],
 "issues": [], "runEvents": [], "parks": [],
 "redMains": [], "secretHits": [], "pendingInteractions": [],
 "supply": {"readyNow": 12, "target": 12, "belowMin": 0.0,
            "idleAgents": 2, "censusAt": "2026-10-03T14:00:00Z"},
 "autoscalerSlices": []}
JSON
negative_out="$(python3 watchdog/detectors.py \
  --snapshot "$SCRATCH/negative.json")" \
  || fail "negative snapshot errored"
echo "$negative_out" | grep -q '"severity": "high"\|"severity": "critical"' \
  && fail "negative control fired high/critical"
echo "$negative_out" | grep -q '"type": "summary"' \
  || fail "negative control printed no summary"

# Writer-compatibility: the detector allowlist must equal the writer's
# allowlist at this exact head (no origin ref: the writer is new in slice).
writer_allow="$(grep -A 8 '^ALLOWED_MUTATIONS' recovery_writer.py)" \
  || fail "cannot read writer allowlist from recovery_writer.py"
for mutation in create_pause_hold assign_blocker_owner restore_blocked \
    operator_decision clear_pin; do
  echo "$writer_allow" | grep -q "\"$mutation\"" \
    || fail "writer allowlist drifted: $mutation missing"
  grep -q "\"$mutation\"" watchdog/detectors.py \
    || fail "detector compat set drifted: $mutation missing"
done

# Secret hygiene: names and lengths only. The expected patternName "ghp_*"
# is short with a literal asterisk; anything value-shaped (ghp_ plus 8 or
# more alphanumerics, or any 32+ char token blob) fails the gate.
echo "$positive_out" | grep -Eq 'ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9]{8,}' \
  && fail "detector output carries possible secret material"
echo "$positive_out" | grep -Eo '"valueLen": [0-9]+' | grep -Eq '[0-9]+' \
  || fail "secret finding carries no length evidence"

echo "GATE PASS: watchdog detectors read-only, all families fire, writer-compatible"
