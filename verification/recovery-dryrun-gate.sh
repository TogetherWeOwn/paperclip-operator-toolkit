#!/usr/bin/env bash
# recovery-dryrun-gate.sh — offline gate for the recovery-writer dry-run
# harness. Fails loudly; no credentials, no network, no writes
# except the scratch decision logs under a temp dir.
set -uo pipefail

cd "$(dirname "$0")/.."

fail() { echo "GATE FAIL: $*" >&2; exit 1; }

python3 -m unittest -v test_recovery_dryrun.py \
  || fail "unit tests failed"

# Fresh temp dir every run: the run scratch persists across invocations, and
# leftover decision logs would dedupe the positive control into all-skip.
SCRATCH="$(mktemp -d)"
STAGE=""
cleanup() { rm -rf "$SCRATCH" ${STAGE:+"$STAGE"}; }
trap cleanup EXIT

# Positive control: a snapshot that fires several detector families must
# produce propose decisions with stable 24-hex dedupe keys.
cat > "$SCRATCH/positive.json" <<'JSON'
{"now": "2026-10-03T14:00:00Z",
 "agents": [{"agentId": "a1", "status": "error",
             "errorSince": "2026-10-03T13:00:00Z", "subtype": "crash",
             "owningLead": "cto"}],
 "hosts": [{"host": "host-1", "diskPct": 99, "load": 9.0,
            "vcpu": 4, "sustainedMin": 10}],
 "ciJobs": [], "queueAge": [],
 "issues": [{"id": "iid-1", "identifier": "CARD-1", "inFocus": true,
             "assigneeAgentId": null, "inBacklogMin": 90}],
 "runEvents": [], "parks": [],
 "redMains": [], "secretHits": []}
JSON
# Script-path execution puts watchdog/ on sys.path instead of the repo root,
# so the harness (which imports its sibling detectors module) needs the root.
export PYTHONPATH="$PWD"
python3 watchdog/recovery_dryrun.py --snapshot "$SCRATCH/positive.json" \
  --log "$SCRATCH/decisions.jsonl" > "$SCRATCH/positive.out" \
  || fail "positive snapshot errored"
grep -q '"verdict": "propose"' "$SCRATCH/positive.out" \
  || fail "positive control proposed nothing"
grep -qE '"dedupeKey": "[0-9a-f]{24}"' "$SCRATCH/positive.out" \
  || fail "positive control has no 24-hex dedupe keys"
grep -q '"mutation": "none"' "$SCRATCH/positive.out" \
  || fail "dry-run emitted a non-none mutation"

# Dedupe control: the same snapshot polled again must skip everything, with
# the same keys, and the snapshot file must be byte-identical.
sha_before="$(sha256sum "$SCRATCH/positive.json" | cut -d' ' -f1)"
python3 watchdog/recovery_dryrun.py --snapshot "$SCRATCH/positive.json" \
  --log "$SCRATCH/decisions.jsonl" > "$SCRATCH/repeat.out" \
  || fail "repeat poll errored"
sha_after="$(sha256sum "$SCRATCH/positive.json" | cut -d' ' -f1)"
[[ "$sha_before" == "$sha_after" ]] \
  || fail "harness modified its snapshot input"
grep -q '"verdict": "propose"' "$SCRATCH/repeat.out" \
  && fail "repeat poll proposed a duplicate"
grep -q '"verdict": "skip"' "$SCRATCH/repeat.out" \
  || fail "repeat poll logged no skips"

# No-write control: the harness CLI offers no apply flag.
help_out="$(python3 watchdog/recovery_dryrun.py --help)"
grep -qi apply <<<"$help_out" \
  && fail "harness help mentions apply"
python3 watchdog/recovery_dryrun.py --snapshot "$SCRATCH/positive.json" \
  --log "$SCRATCH/decisions.jsonl" --apply \
  2>/dev/null \
  && fail "harness accepted --apply"

# Load-bearing checks: break one behavior at a time in a throwaway copy and
# require the owning suite to go red, with a green baseline first so each red
# is attributable to its mutation and not to a broken staging copy.
STAGE="$(mktemp -d)"
mkdir -p "$STAGE/watchdog"
touch "$STAGE/watchdog/__init__.py"

# Rebuild the staging tree from the real files. The harness imports its
# sibling detectors module, so the staged tree needs both or the green
# baseline dies on import.
restage() {
  cp -p test_recovery_dryrun.py "$STAGE/"
  cp -p watchdog/recovery_dryrun.py watchdog/detectors.py "$STAGE/watchdog/"
}

restage
(cd "$STAGE" && python3 -m unittest test_recovery_dryrun.py >/dev/null 2>&1) \
  || fail "unmutated staging copy is already red"

# mutant NAME OLD NEW: replace the one occurrence of OLD in the staged
# harness with NEW; the suite must no longer pass.
mutant() {
  local name="$1" old="$2" new="$3" stage_out
  restage
  STAGE_DIR="$STAGE" OLD="$old" NEW="$new" python3 - <<'PY' \
    || fail "mutation target for $name is missing or ambiguous"
import os
import pathlib
path = pathlib.Path(os.environ["STAGE_DIR"]) / "watchdog" / "recovery_dryrun.py"
source = path.read_text()
old = os.environ["OLD"]
assert source.count(old) == 1, "mutation target must appear exactly once"
path.write_text(source.replace(old, os.environ["NEW"]))
PY
  stage_out="$(cd "$STAGE" && python3 -m unittest test_recovery_dryrun.py 2>&1)"
  if grep -q "^OK" <<<"$stage_out"; then
    fail "$name mutant still passes the suite"
  fi
  echo "PASS: $name mutant caught"
}

mutant "dedupe-disabled" \
  "    if key in seen:" \
  "    if False:  # MUTANT: dedupe disabled"
mutant "severity-out-of-key" \
  '            "severity": str(record.get("severity") or "none"),
' \
  ""
mutant "nested-snapshot-tracebacks" \
  "    except (OSError, json.JSONDecodeError, RecursionError) as exc:
        # RecursionError is a deeply nested document" \
  "    except (OSError, json.JSONDecodeError) as exc:
        # RecursionError is a deeply nested document"
mutant "cli-exit-2-narrowed" \
  "    except ValueError as exc:
        print(" \
  "    except OSError as exc:
        print("
mutant "nested-log-line-tracebacks" \
  "            except (json.JSONDecodeError, RecursionError) as exc:" \
  "            except json.JSONDecodeError as exc:"

echo "GATE PASS: recovery dry-run harness"
