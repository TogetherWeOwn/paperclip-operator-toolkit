#!/usr/bin/env bash
# platform-watchdog-gate.sh — offline gate for the watchdog detectors.
# Fails loudly; no credentials, no network writes, no board writes.
set -uo pipefail

cd "$(dirname "$0")/.."

fail() { echo "GATE FAIL: $*" >&2; exit 1; }

# Synthetic deployment settings. The detectors read both from the environment
# and refuse to run without the desk card; the values here are fixtures that
# match the hosts and identifiers in the snapshots below. Exported before the
# first test so every step (unit, CLI, mutation) sees the same configuration.
export WATCHDOG_CEO_DESK_ISSUE="ISSUE-100"
export WATCHDOG_REQUIRED_HOSTS="192.0.2.10"

python3 -m unittest -v test_platform_watchdog.py \
  || fail "unit tests failed"

# CLI exit/JSONL contract and the read-only, no-I/O guarantee of detect():
# temp-file subprocess runs, no credentials, no network.
python3 -m unittest -v test_platform_watchdog_cli.py \
  || fail "CLI/read-only contract tests failed"

# Positive control: a snapshot that must fire every detector family.
SCRATCH="${PAPERCLIP_RUN_SCRATCH_DIR:-$(mktemp -d)}"
cat > "$SCRATCH/positive.json" <<'JSON'
{"now": "2026-10-03T14:00:00Z",
 "agents": [{"agentId": "a1", "status": "error",
             "errorSince": "2026-10-03T13:00:00Z", "subtype": "crash",
             "owningLead": "cto"}],
 "hosts": [{"host": "192.0.2.10", "diskPct": 99, "load": 9.0,
            "vcpu": 4, "sustainedMin": 10}],
 "ciJobs": [{"repo": "r", "job": "j", "runtimeMin": 45, "baselineMin": 20}],
 "queueAge": [{"label": "self-hosted", "ageMin": 160}],
 "issues": [{"id": "iid-1", "identifier": "ISSUE-1", "inFocus": true,
             "assigneeAgentId": null, "inBacklogMin": 90}],
 "runEvents": [{"issueId": "iid-1", "identifier": "ISSUE-1",
                "kind": "dispatch_stalled_issue",
                "at": "2026-10-03T13:10:00Z"},
               {"issueId": "iid-1", "identifier": "ISSUE-1",
                "kind": "dispatch_stalled_issue",
                "at": "2026-10-03T13:20:00Z"},
               {"issueId": "iid-1", "identifier": "ISSUE-1",
                "kind": "dispatch_stalled_issue",
                "at": "2026-10-03T13:30:00Z"},
               {"issueId": "iid-1", "identifier": "ISSUE-1",
                "kind": "dispatch_stalled_issue",
                "at": "2026-10-03T13:40:00Z"}],
 "parks": [{"issueId": "iid-1", "identifier": "ISSUE-1",
            "missingDispositionCount": 4}],
 "redMains": [{"repo": "example-repo", "signature": "s1",
               "incidentExists": false}],
 "secretHits": [{"source": "run-log:x", "patternName": "ghp_*",
                 "valueLen": 40, "at": "2026-10-03T13:00:00Z"}],
 "pendingInteractions": [{"issueId": "iid-7", "identifier": "ISSUE-7",
               "interactionId": "int-1", "kind": "request_confirmation",
               "createdAt": "2026-10-03T13:00:00Z",
               "resolverAgentId": "agent-r"}],
 "supply": {"readyNow": 0, "target": 12, "belowMin": 35.0,
            "idleAgents": 2, "censusAt": "2026-10-03T14:00:00Z"},
 "autoscalerSlices": [{"sliceId": "slice-1", "identifier": "ISSUE-20",
               "status": "backlog", "assigneeAgentId": null,
               "unassignedSince": "2026-10-03T11:00:00Z"}]}
JSON
positive_out="$(python3 watchdog/detectors.py \
  --snapshot "$SCRATCH/positive.json")" \
  || fail "positive snapshot errored"
for family in agent_error host_health ci_health assignment churn red_main secret_hit pending_interactions supply_famine autoscaler_slices; do
  grep -q "\"watchdog/$family\"" <<<"$positive_out" \
    || fail "positive control silent for $family"
done

# Negative control: an all-quiet snapshot fires nothing above info... but the
# required-hosts rule still holds, so expect only info-level or nothing.
cat > "$SCRATCH/negative.json" <<'JSON'
{"now": "2026-10-03T14:00:00Z",
 "agents": [{"agentId": "a1", "status": "idle"}],
 "hosts": [{"host": "192.0.2.10", "diskPct": 10, "load": 1.0,
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
grep -q '"severity": "high"\|"severity": "critical"' <<<"$negative_out" \
  && fail "negative control fired high/critical"
grep -q '"type": "summary"' <<<"$negative_out" \
  || fail "negative control printed no summary"

# The propose-only compatibility set is a subset, not a second auto-action
# allowlist. Read the subjects being tested, never a moving remote ref or a
# truncated grep window that silently drops an entry.
python3 - <<'PY' || fail "writer compatibility drifted"
from recovery_writer import ALLOWED_MUTATIONS
from watchdog.detectors import WRITER_COMPATIBLE_MUTATIONS
assert WRITER_COMPATIBLE_MUTATIONS - {"none"} <= ALLOWED_MUTATIONS
assert "none" in WRITER_COMPATIBLE_MUTATIONS
PY

# Secret hygiene: names and lengths only. The expected patternName "ghp_*"
# is short with a literal asterisk; anything value-shaped (ghp_ plus 8 or
# more alphanumerics, or any 32+ char token blob) fails the gate.
grep -Eq 'ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9]{8,}' <<<"$positive_out" \
  && fail "detector output carries possible secret material"
grep -Eq '[0-9]+' <<<"$(grep -Eo '"valueLen": [0-9]+' <<<"$positive_out")" \
  || fail "secret finding carries no length evidence"

# Mutation control: the CLI/read-only tests must fail when main()
# or detect() breaks the contract. Runs on temporary copies; the checkout is
# never edited.
python3 verification/platform-watchdog-cli-mutation-gate.py \
  || fail "CLI/read-only contract mutation gate failed"

echo "GATE PASS: watchdog detectors read-only, all families fire, writer-compatible"
