#!/usr/bin/env bash
# Offline red/green proof. Every assertion pins the exit code, not message text.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
GUARD=${STATIC_LABEL_GUARD:-"$ROOT/scripts/ci_no_new_static_labels.sh"}
TMP=$(mktemp -d "${PAPERCLIP_RUN_SCRATCH_DIR:-${TMPDIR:-/tmp}}/static-label-proof.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
pass=0 fail=0

workflow() {
  printf 'name: fixture\non: [push]\njobs:\n  probe:\n    runs-on: %s\n    steps:\n      - run: echo hi\n' "$1"
}
commit() {
  git -C "$1" add -A
  git -C "$1" -c user.name=fixture -c user.email=fixture@example.invalid commit -qm fixture
}
repo() {
  d="$TMP/$1"
  mkdir -p "$d/.github/workflows"
  git -C "$d" init -qb main
  workflow "${2:-ubuntu-latest}" >"$d/.github/workflows/probe.yml"
  commit "$d"
  git -C "$d" checkout -qb pr
}
expect() {
  local expected=$1 name=$2 status=0
  shift 2
  (cd "$d" && bash "$GUARD" "$@") >"$TMP/out" 2>&1 || status=$?
  if [[ $status == "$expected" ]]; then
    printf 'ok - %s (exit %s)\n' "$name" "$status"
    pass=$((pass + 1))
  else
    printf 'not ok - %s (expected %s, got %s)\n' "$name" "$expected" "$status"
    cat "$TMP/out"
    fail=$((fail + 1))
  fi
}
block() {
  printf 'name: fixture\non: [push]\njobs:\n  probe:\n    runs-on:\n      - self-hosted\n      - %s\n    steps:\n      - run: echo hi\n' "$1"
}
for label in two-isolated two-selfhosted; do
  repo "inline-$label"
  workflow "[self-hosted, $label]" >"$d/.github/workflows/probe.yml"
  commit "$d"
  expect 1 "new $label rejects" main HEAD
  repo "block-$label"
  block "$label" >"$d/.github/workflows/new.yaml"
  commit "$d"
  expect 1 "new block $label rejects" main HEAD
  repo "edit-block-$label"
  block two-ephemeral >"$d/.github/workflows/probe.yml"
  commit "$d"
  git -C "$d" branch -f main HEAD
  block "$label" >"$d/.github/workflows/probe.yml"
  commit "$d"
  expect 1 "existing block item changed to $label rejects" main HEAD
  repo "expression-$label"
  workflow "\${{ fromJSON('[\"self-hosted\",\"$label\"]') }}" >"$d/.github/workflows/probe.yml"
  commit "$d"
  expect 1 "expression $label rejects" main HEAD
 done

for selector in ubuntu-latest '[self-hosted, two-ephemeral, garm-oldctl]'; do
  repo "allowed-$pass"
  workflow "$selector" >"$d/.github/workflows/new.yml"
  commit "$d"
  expect 0 "allowed selector $selector passes" main HEAD
 done
repo allowed-block
block two-ephemeral >"$d/.github/workflows/new.yml"
commit "$d"
expect 0 'ephemeral block passes' main HEAD

repo grandfathered '[self-hosted, two-isolated]'
printf '\n# unrelated change\n' >>"$d/.github/workflows/probe.yml"
commit "$d"
expect 0 'untouched static selector passes' main HEAD
repo grandfathered-block
block two-isolated >"$d/.github/workflows/probe.yml"
commit "$d"
git -C "$d" branch -f main HEAD
printf '\n# unrelated change\n' >>"$d/.github/workflows/probe.yml"
commit "$d"
expect 0 'untouched static block passes' main HEAD
repo other-list
block two-ephemeral >"$d/.github/workflows/probe.yml"
printf '    env:\n      DOCUMENTATION: two-isolated\n    example:\n      - two-selfhosted\n' >>"$d/.github/workflows/probe.yml"
commit "$d"
expect 0 'unrelated lists after runs-on block pass' main HEAD
repo comment
workflow 'ubuntu-latest # previously two-isolated' >"$d/.github/workflows/probe.yml"
printf '\n# runs-on: [self-hosted, two-selfhosted]\n' >>"$d/.github/workflows/probe.yml"
commit "$d"
expect 0 'comment-only mentions pass' main HEAD
repo unchanged-block-blank
block two-isolated >"$d/.github/workflows/probe.yml"
commit "$d"
git -C "$d" branch -f main HEAD
python3 - "$d/.github/workflows/probe.yml" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
p.write_text(p.read_text().replace('      - two-isolated', '\n      # keep the legacy pool\n      - two-isolated'))
PY
commit "$d"
expect 0 'comments and blank lines do not introduce a static label' main HEAD

repo mapping
workflow '{labels: [self-hosted, two-isolated]}' >"$d/.github/workflows/probe.yml"
commit "$d"
expect 1 'runs-on labels mapping rejects' main HEAD
repo alias
workflow '&runner [self-hosted, two-ephemeral]' >"$d/.github/workflows/probe.yml"
printf '  second:\n    runs-on: *runner\n    steps:\n      - run: echo hi\n' >>"$d/.github/workflows/probe.yml"
commit "$d"
git -C "$d" branch -f main HEAD
python3 - "$d/.github/workflows/probe.yml" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
p.write_text(p.read_text().replace('two-ephemeral', 'two-isolated'))
PY
commit "$d"
expect 1 'existing alias anchor edit rejects' main HEAD
repo new-job '[self-hosted, two-isolated]'
printf '  second:\n    runs-on: [self-hosted, two-isolated]\n    steps:\n      - run: echo hi\n' >>"$d/.github/workflows/probe.yml"
commit "$d"
expect 1 'copying grandfathered usage to a new job rejects' main HEAD
repo long-selector
python3 - "$d/.github/workflows/probe.yml" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).write_text('name: fixture\non: [push]\njobs:\n  probe:\n    runs-on: [self-hosted, two-isolated, ' + 'x' * 131072 + ']\n    steps:\n      - run: echo hi\n')
PY
commit "$d"
expect 1 'large selector rejects without a SIGPIPE false pass' main HEAD
repo malformed
printf 'jobs: [unclosed\n' >"$d/.github/workflows/probe.yml"
commit "$d"
expect 2 'malformed workflow refuses measurement' main HEAD
repo no-change
expect 0 'empty valid comparison passes' main HEAD
expect 2 'no implicit origin/main self-baseline'

repo diff-failure
printf 'changed\n' >"$d/README.md"
commit "$d"
mkdir "$TMP/bin"
real_git=$(command -v git)
printf '#!/usr/bin/env bash\nif [[ $1 == diff ]]; then exit 42; fi\nexec %q "$@"\n' "$real_git" >"$TMP/bin/git"
chmod +x "$TMP/bin/git"
PATH="$TMP/bin:$PATH" expect 2 'git diff failure is not a pass' main HEAD
expect 2 'missing base refuses measurement' missing-base HEAD
expect 2 'missing head refuses measurement' main missing-head

# Event-mode exercises the exact command wired into required Offline suites.
repo events
before=$(git -C "$d" rev-parse HEAD)
workflow '[self-hosted, two-isolated]' >"$d/.github/workflows/probe.yml"
commit "$d"
after=$(git -C "$d" rev-parse HEAD)
# Mimic a push checkout whose origin/main already points at the pushed SHA.
git -C "$d" update-ref refs/remotes/origin/main "$after"
event="$TMP/event.json"
write_event() {
  python3 - "$event" "$1" "$2" <<'PY'
import json, sys
from pathlib import Path
Path(sys.argv[1]).write_text(json.dumps({'before': sys.argv[2], 'after': sys.argv[3]}))
PY
}
write_event "$before" "$after"
GITHUB_EVENT_NAME=push GITHUB_EVENT_PATH="$event" expect 1 'main push uses event before/after, not origin/main' --event
write_event "$(printf '%040d' 0)" "$after"
GITHUB_EVENT_NAME=push GITHUB_EVENT_PATH="$event" expect 2 'zero push baseline refuses measurement' --event
write_event '' "$after"
GITHUB_EVENT_NAME=push GITHUB_EVENT_PATH="$event" expect 2 'missing push baseline refuses measurement' --event
printf '{broken' >"$event"
GITHUB_EVENT_NAME=push GITHUB_EVENT_PATH="$event" expect 2 'invalid event JSON refuses measurement' --event
python3 - "$event" "$before" "$after" <<'PY'
import json, sys
from pathlib import Path
Path(sys.argv[1]).write_text(json.dumps({'pull_request': {'base': {'sha': sys.argv[2]}, 'head': {'sha': sys.argv[3]}}}))
PY
GITHUB_EVENT_NAME=pull_request GITHUB_EVENT_PATH="$event" expect 1 'PR event rejects changed block/inline selector' --event
workflow ubuntu-latest >"$d/.github/workflows/probe.yml"
commit "$d"
write_event "$after" "$(git -C "$d" rev-parse HEAD)"
GITHUB_EVENT_NAME=push GITHUB_EVENT_PATH="$event" expect 0 'push removing a static label passes' --event
# The nightly schedule and manual dispatch have no commit range: skip, never fail.
GITHUB_EVENT_NAME=schedule GITHUB_EVENT_PATH="$event" expect 0 'scheduled run skips: no change set' --event
GITHUB_EVENT_NAME=workflow_dispatch GITHUB_EVENT_PATH="$event" expect 0 'manual dispatch skips: no change set' --event
GITHUB_EVENT_NAME=schedule GITHUB_EVENT_PATH="$TMP/absent.json" expect 0 'scheduled run skips without reading the payload' --event
# Every other unknown event still refuses measurement rather than passing.
GITHUB_EVENT_NAME=issues GITHUB_EVENT_PATH="$event" expect 2 'unknown event refuses measurement' --event

# Execute required-path workflow steps, not a duplicate hand-written guard call.
"${STATIC_LABEL_PYTHON:-python3}" - "$ROOT/.github/workflows/ci.yml" "$d" "$before" "$after" "$GUARD" <<'PY'
import json, os, subprocess, sys, tempfile
from pathlib import Path
import yaml
workflow_path, repo, before, after, guard = sys.argv[1:]
document = yaml.safe_load(Path(workflow_path).read_text())
jobs = document['jobs']
job = jobs['offline-suites']
step = next(s for s in job['steps'] if s.get('name') == 'Reject newly added static runner labels')
assert not step.get('continue-on-error') and not step.get('if'), 'Enforcement must not be optional'
assert step['run'].strip() == 'bash scripts/ci_no_new_static_labels.sh --event'
checkout = next(s for s in job['steps'] if str(s.get('uses', '')).startswith('actions/checkout@'))
assert checkout['with']['fetch-depth'] == 0, 'Guard needs complete comparison history'
for trigger in document.get('on', document.get(True, {})).values():
    if isinstance(trigger, dict):
        assert not ({'paths', 'paths-ignore'} & trigger.keys()), 'No required workflow path filtering'
Path(repo, 'scripts').mkdir(exist_ok=True)
Path(repo, 'scripts/ci_no_new_static_labels.sh').write_bytes(Path(guard).read_bytes())
Path(repo, 'scripts/ci_no_new_static_labels.py').write_bytes(Path(guard).with_suffix('.py').read_bytes())
with tempfile.TemporaryDirectory(dir=os.environ.get('PAPERCLIP_RUN_SCRATCH_DIR')) as tmp:
    event = Path(tmp, 'event.json')
    event.write_text(json.dumps({'before': before, 'after': after}))
    env = {**os.environ, 'GITHUB_EVENT_NAME': 'push', 'GITHUB_EVENT_PATH': str(event)}
    result = subprocess.run(['bash', '-e', '-o', 'pipefail', '-c', step['run']], cwd=repo, env=env, capture_output=True)
    assert result.returncode == 1, f'Required enforcing step must reject: {result.returncode}'
    # Every trigger ci.yml declares must be a measured or explicitly skipped event;
    # the nightly full run executes this same required step with no commit range.
    triggers = set(document.get('on', document.get(True, {})))
    handled = {'push', 'pull_request', 'merge_group', 'schedule', 'workflow_dispatch'}
    assert triggers <= handled, f'ci.yml trigger without guard support: {sorted(triggers - handled)}'
    for name in sorted(triggers & {'schedule', 'workflow_dispatch'}):
        env = {**os.environ, 'GITHUB_EVENT_NAME': name, 'GITHUB_EVENT_PATH': str(event)}
        result = subprocess.run(['bash', '-e', '-o', 'pipefail', '-c', step['run']], cwd=repo, env=env, capture_output=True)
        assert result.returncode == 0 and b'SKIP' in result.stdout, f'{name} run must skip, not fail: {result.returncode}'
        print(f'ok - actual required CI step skips {name} run')
print('ok - actual required CI step rejects violating push')
PY
pass=$((pass + 1))
printf '%s passed, %s failed\n' "$pass" "$fail"
(( fail == 0 ))
