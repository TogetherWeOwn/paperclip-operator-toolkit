# Operator runbook: org SDLC baseline ruleset (TOG-24386)

Ruleset writes are 403 for the GitHub App — a human org admin runs the
commands below (or the Operator pastes them into an admin session). Nothing
here runs from CI. Stays in this repo; never copied to the org repo.

## 0. Read the live state first (never blind-write)

```bash
gh api orgs/TogetherWeOwn/rulesets --jq '.[] | "\(.id) \(.name) \(.enforcement)"'
```

If an `sdlc-baseline` ruleset already exists, update it (`PATCH
orgs/TogetherWeOwn/rulesets/{id}`) instead of creating a duplicate. If a
`tier-0-quality-gate` ruleset already requires `ci-ok`, keep both during
stage 1 and retire the older one only after the baseline is active.

## 1. Render the payload (single exclude list, mechanical)

The exclude list is the single source. This step injects it; nothing is
hand-edited in the JSON:

```bash
STAGE=templates/org-github
EXCL_JSON=$(grep -vE '^\s*(#|$)' $STAGE/sdlc-foundation/repo-exclude-list.txt \
  | python3 -c 'import json,sys; print(json.dumps([l.strip() for l in sys.stdin]))')
jq --argjson excl "$EXCL_JSON" \
  '.conditions.repository_name.exclude = $excl' \
  $STAGE/rulesets/sdlc-baseline-evaluate.json > /tmp/sdlc-stage1.json
python3 -c "import json; d=json.load(open('/tmp/sdlc-stage1.json')); assert d['enforcement']=='evaluate' and d['conditions']['repository_name']['include']==['*'], 'rendered payload malformed'" && echo payload-valid
```

## 1b. Render the blocker payloads (same single exclude list)

The blocker-ledger classes 4-7 payloads (`blocker-classes47-report-only`
evaluate first, `blocker-classes47-required` for the flip) inject the same
exclude list — never a second list — plus the Operator-filled numeric
`repository_id` of `TogetherWeOwn/.github` and the adoption commit `sha`:

```bash
STAGE=templates/org-github
EXCL_JSON=$(grep -vE '^\s*(#|$)' $STAGE/sdlc-foundation/repo-exclude-list.txt \
  | python3 -c 'import json,sys; print(json.dumps([l.strip() for l in sys.stdin]))')
REPO_ID=$(gh api repos/TogetherWeOwn/.github --jq .id)
SHA=<adoption-commit-of-the-blocker-gates>
for f in blocker-classes47-report-only blocker-classes47-required; do
  jq --argjson excl "$EXCL_JSON" --argjson repo "$REPO_ID" --arg sha "$SHA" \
    '.conditions.repository_name.exclude = $excl
     | (.rules[] | select(.type == "workflows") | .parameters.workflows[]) |= (.repository_id = $repo | .sha = $sha)' \
    $STAGE/rulesets/$f.json > /tmp/$f.json
done
EXCL_JSON="$EXCL_JSON" python3 - <<'PY'
import glob, json, os
expected_exclude = json.loads(os.environ.get("EXCL_JSON") or "[]")
assert expected_exclude, (
    'exclude list is empty or missing: refusing to validate '
    '(wrong STAGE path, empty exclude file, or the jq step skipped)')
files = sorted(glob.glob('/tmp/blocker-classes47-*.json'))
assert files, 'no blocker payloads rendered'
bad = []
for f in files:
    d = json.load(open(f))
    wfs = [w for r in d.get('rules', []) if r.get('type') == 'workflows'
           for w in r.get('parameters', {}).get('workflows', [])]
    ok = (d['conditions']['repository_name']['include'] == ['*']
          and d['conditions']['repository_name'].get('exclude')
          == expected_exclude
          and wfs
          and all(isinstance(w.get('repository_id'), int)
                  and w.get('ref') == 'refs/heads/main'
                  and w.get('sha') not in ('', 'PINNED_SHA') for w in wfs))
    if ok:
        print(f, 'payload-valid')
    else:
        bad.append(f)
assert not bad, 'invalid blocker payloads: %s' % bad
PY
```

Applied as shipped (empty `exclude`, `repository_id` 0, `sha`
`PINNED_SHA`), the required workflows would also target the policy repo
itself and the read-only `replay-*` mirrors the list excludes. Create the
evaluate ruleset from `/tmp/blocker-classes47-report-only.json` with step
2's command (name `blocker-classes47`), then PATCH to
`/tmp/blocker-classes47-required.json` once its gates measure clean.

## 2. Stage 1 — evaluate (advisory)

```bash
gh api orgs/TogetherWeOwn/rulesets -X POST --input /tmp/sdlc-stage1.json \
  --jq '{id: .id, name: .name, enforcement: .enforcement}'
```

Confirm: open PRs keep merging on repo-level `ci-ok`/`pr-lint`; the baseline
runs appear but cannot block (evaluate mode).

## 3. Pre-flip audit (required before stage 2)

Every non-excluded repo must have a producer for each required check, or the
active flip blocks its PRs forever (the required-check-rename trap).

Audit against the RENDERED PAYLOAD, not live branch rules. The audit's
`--repo` mode builds its required set from
`repos/{repo}/rules/branches/{branch}`, and GitHub omits rules from rulesets
in evaluate or disabled enforcement from that endpoint — during stage 1 the
baseline is exactly such a ruleset, so `--repo` mode cannot see the checks
being vetted and a repo producing neither `ci-ok` nor `pr-lint` reports
clean. Manifest mode takes the required set from the stage-1 payload
instead and measures each repo's own workflows against it:

```bash
STAGE=templates/org-github
$STAGE/sdlc-foundation/discover-repos.sh > /tmp/sdlc-repos.txt
jq '{branch: "main", required: [.rules[]
      | select(.type == "required_status_checks")
      | .parameters.required_status_checks[]]}' \
  /tmp/sdlc-stage1.json > /tmp/sdlc-required.json
while read -r repo; do
  echo "== $repo"
  WF=$(mktemp -d)
  if gh repo clone "$repo" "$WF/repo" -- --depth 1 --branch main >/dev/null 2>&1; then
    python3 ci_required_checks_audit.py --manifest /tmp/sdlc-required.json \
      --workflows "$WF/repo/.github/workflows"
  else
    echo "FAIL: cannot clone $repo (unauditable counts as unproven)"
  fi
  rm -rf "$WF"
done < /tmp/sdlc-repos.txt
```

Flip only when: every repo's audit exits 0 (a `ci-ok` and a `pr-lint`
producer each), no gate's false-positive rate over the last 20 PRs exceeds
5%, and 24h have passed since stage 1. A missing producer is fixed by
shipping the day-1 file set (or its `pr-lint.yml`) to that repo, never by
weakening the payload.

## 4. Stage 2 — active

```bash
RULESET_ID=<id-from-step-2>
STAGE=templates/org-github
EXCL_JSON=$(grep -vE '^\s*(#|$)' $STAGE/sdlc-foundation/repo-exclude-list.txt \
  | python3 -c 'import json,sys; print(json.dumps([l.strip() for l in sys.stdin]))')
jq --argjson excl "$EXCL_JSON" \
  '.conditions.repository_name.exclude = $excl' \
  $STAGE/rulesets/sdlc-baseline-active.json > /tmp/sdlc-stage2.json
gh api orgs/TogetherWeOwn/rulesets/$RULESET_ID -X PATCH --input /tmp/sdlc-stage2.json \
  --jq '{id: .id, name: .name, enforcement: .enforcement}'
```

## 5. Adding a sibling-track check later (rename-trap procedure)

When a sibling track's producing job exists and reports on all open PRs of
every non-excluded repo (verified with step 3's loop): add its context to
BOTH payload files (evaluate twin first), POST the evaluate twin as a new
ruleset version in evaluate mode, confirm it reports without blocking, then
PATCH the active ruleset. Never rename a producing job and the ruleset entry
in the same step — add the new job name first, require it only when all open
PRs report it, then remove the old name. Reserved names: `size-label`
(TOG-24377), `squawk-pg-lint` (TOG-24379), `test-missing` (TOG-24380),
`security-scan` (TOG-24381).

## Rollback (any stage, one command)

```bash
gh api orgs/TogetherWeOwn/rulesets/$RULESET_ID -X PATCH \
  -f enforcement=disabled --jq '{name: .name, enforcement: .enforcement}'
```

Disabling restores the pre-baseline gates (repo-level branch protection is
untouched by these payloads). Delete only when a replacement ruleset is
already active.

## Why merge queue is not in these payloads (verified 2026-10-15)

An org `Merge queue` ruleset cannot be created: POST returns HTTP 422
`/rules/0: data matches no possible input`, and the official GitHub REST
OpenAPI schema confirms `org-rules` excludes `repository-rule-merge-queue`
while repository rules include it. Capability limit, not targeting or token
scope. No org queue ruleset was created; nntunev2's existing queue is
unchanged (before-image:
`/home/ubuntu/paperclip-enterprise-company/ops/sdlc/tog-24376-nntune-ruleset-before.json`).

Stage 3 is therefore NOT an org ruleset. It is: org custom property
`merge_queue_ready` (`true_false`, org-editable; currently set on no repo) +
one shared policy/reconciler that materializes repository queue rules for
property-ready repos (never copied per-repo policy definitions). Proof:
TWO rollout opened two-bot-next#969 and two-web-next#867 with CI running,
queues not yet enabled.

Durable contract (also in BOOTSTRAP-new-repo.md): set
`merge_queue_ready=true` only after all required producing workflows handle
`merge_group` and review carry is available. UNDO while unused: delete the
property schema only.
