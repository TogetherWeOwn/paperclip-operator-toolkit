# Paperclip task-liveness reconciler

`liveness_reconciler.py` is the owned TOG-586 control for four Paperclip liveness gaps. It does not patch Paperclip, OmniRoute, CLIProxy, or any vendor source.

## Safety contract

- Dry-run is the default. `--apply` is required for any mutation.
- An explicit owner HOLD or external-action prohibition is checked before routing or waking. If no active issue-tree pause hold exists, the reconciler persists one manual `pause` hold through the supported board API. Paperclip then cancels active runs and unclaimed issue wakeups without changing the held issue status. The reconciler re-reads issue runs after hold creation and uses the supported board run-cancellation route for any survivor. Any active pause hold is thereafter an unconditional barrier to reviewer routing, orphan wakes, and operator-decision comments, even if no textual HOLD is present.
- Terminal issues are never reopened.
- A raw pending-interaction/assignee mismatch is diagnostic-only. The reconciler never bounces the issue assignee to an interaction addressee. Independent review must use Paperclip's typed `executionPolicy` stages and `executionState.currentParticipant`, which natively route the reviewer. Active work, conflicting addressees, and non-agent resolver policy remain alarm-only.
- `orphaned_running_run` is diagnostic-only here. Paperclip's native stranded-assigned-issue recovery owns bounded continuation, retry evidence, and pause-hold suppression. The reconciler reports an uncovered orphan but never races the native recovery path with a second wake.
- A ready unassigned blocker is assigned only when Paperclip's supported `unblockDescriptor.owner.agentId` names one intended owner. No owner produces one bounded operator-decision item. Creator provenance is never treated as ownership, and the reconciler never accepts an invented fixture-only field as first-class authority.
- Owner-held status drift is repaired in two contained cycles: first persist the pause hold and cancel any active run, then restore `blocked` with the existing descriptor while the pause remains active. The reconciler re-reads and cancels any run triggered by the blocked-status PATCH and never comments on the held issue.
- Explicit external prohibitions such as “do not publish/contact/deploy/send/release” are holds even without the literal word HOLD; a later explicit supersession/lift directive prevents an older statement from recreating the hold. A current hold-bearing `unblockDescriptor` remains authoritative until task data changes.
- **Hold detection is per-clause, and a release never erases an unrelated hold.** One owner comment routinely lifts one prohibition while restating another (“the vendor-channel hold is lifted, that work may resume — do not publish anything from this card”). Each clause is judged on its own, and a clause that matches both patterns is read as the release *of that hold* rather than a new one. A release supersedes only holds stated strictly before it, and never a hold written in its own body. Evaluating the whole body at once made this fail **open**: the release phrase won and `assign_blocker_owner` passed the apply gate on a held card.
- **A hold in `title`/`description` refuses mutations but never initiates containment.** The issue body is scanned — with the stricter comment pattern, because the looser descriptor pattern matches 6 scoped build instructions (“do not start from scratch”, “do not merge db8eee5”) across 200 live issues — but body prose is ordinary task text, not an authenticated owner directive. Across the 374 live issues in the focus project the body scan finds 8 holds, of which 2 are false: TOG-586 *quotes* the failure mode and TOG-713 says “I do not contact the owner directly”. A false hold is harmless when it refuses a write and harmful when it starts one, since `create_pause_hold` cancels live runs. So `create_pause_hold` is gated on `issue_has_owner_hold(..., include_body=False)` — descriptor or owner comment only — in both the planner and the apply gate, while every refusal path uses the full scan.
- Every proposal has a stable fingerprint. Apply mode re-reads the issue, interactions, runs, comments, activity, active recovery, tree-control state, and blocker diagnostics immediately before every write. Reviewer assignment additionally revalidates the live resolver/review policy plus reviewer existence, status, company, and org-chain health; stale plans refuse rather than mutating.
- Each cycle is capped by `--max-repairs`; deferred repairs are printed as explicit `rate_limited` rows. `--max-repairs 0` is a supported **observe-only** cycle: every trigger is still measured and printed, but each mutating proposal is downgraded to a non-mutating `rate_limited` row, so the run is provably incapable of a write. The installed unit reads the cap from `PAPERCLIP_RECONCILER_MAX_REPAIRS` and defaults it to `0`.
- Zero measured issues and unreadable sources are errors, not clean cycles.

## Source and execution

The API-only reader is available for small fixtures and diagnostic runs. The timer should use the bounded, read-only database source to avoid one request per issue. The owned cycle intentionally covers only the two non-native mutations: converting an explicit owner/external-action directive into a first-class pause hold, and routing a ready blocker from its supported explicit owner field (or recording the ambiguity). Reviewer and orphan cases remain diagnostics for the native paths:

```bash
./liveness_reconciler.py \
  --source-cmd 'node ./liveness_reconciler_source.js --project <project-uuid>'
```

`liveness_reconciler_source.js` sets `default_transaction_read_only=on`, requires a company ID, and emits one JSON document. It cannot write the database.

Apply mode still writes only through supported Paperclip API routes:

```bash
./liveness_reconciler.py --apply \
  --source-cmd 'node ./liveness_reconciler_source.js --project <project-uuid>' \
  --max-repairs 3 --retry-limit 1
```

Each JSONL proposal includes the exact reason, proposed mutation, target, before state, after state, and fingerprint. Save stdout to the journal or an operator-owned log for before/after evidence.

## Installation after independent review

Do not install the timer before an independent reviewer approves the exact commit.

The reviewed commit is `49374f556395126b24c1d9310c4d8728167ccd55` (the PR #219
merge commit, and `main` at the time of writing). **Do not build `ee6a85be`**,
despite TOG-979's title: it is reachable from several branches but is not an
ancestor of `main` (diverged, ahead 23 / behind 1), and its installer preflight
requires `/usr/bin/runuser` — absent on this host, which places it in
`/usr/sbin`, and never invoked by the bundle — so it refuses a host that would
otherwise install cleanly. The builder now enforces this rather than trusting
this paragraph: it refuses any `--source-ref` that is not an ancestor of
`origin/main`. Fetch first, so that ref exists and is current.

```bash
git fetch origin main
reviewed_commit=49374f556395126b24c1d9310c4d8728167ccd55
bundle="$HOME/paperclip-liveness-reconciler-$reviewed_commit.tar"
./systemd/build-liveness-reconciler-bundle.sh \
  --source-ref "$reviewed_commit" --output "$bundle"
# Open the bundle manifest before crossing the privilege boundary.
tar -xOf "$bundle" REVISION
tar -xOf "$bundle" SHA256SUMS
install -d -m 0700 "$HOME/.config/paperclip" \
  "$HOME/.local/state/paperclip-liveness-reconciler"
touch "$HOME/.config/paperclip/liveness-reconciler.env"
chmod 0600 "$HOME/.config/paperclip/liveness-reconciler.env"
# Populate the env file without putting credentials on argv or in logs:
# PAPERCLIP_API_URL=...
# PAPERCLIP_API_KEY=...      # dedicated board/service credential; agent keys are refused
# PAPERCLIP_COMPANY_ID=...
# PAPERCLIP_PROJECT_ID=...
# PAPERCLIP_PREFLIGHT_ISSUE_ID=... # dedicated controlled canary for safe read probes
# PAPERCLIP_PREFLIGHT_AGENT_ID=... # controlled canary for agent-management read probe
# DATABASE_URL=...
# PAPERCLIP_PG_MODULE=/absolute/path/to/node_modules/pg  # required when /app/node_modules is absent
# PAPERCLIP_RECONCILER_MAX_REPAIRS=0  # leave at 0 for the first live cycle; raise only after reading it
sudo ./systemd/install-liveness-reconciler.sh \
  --source-ref "$reviewed_commit" --bundle "$bundle" --target-user "$USER"
# Ensure this account's user manager survives logout/reboot. If lingering is not
# already enabled, the host administrator must run: loginctl enable-linger "$USER"
systemctl --user daemon-reload
# FIRST LIVE CYCLE: run the service once by hand, with the repair cap still at 0,
# BEFORE enabling the timer. The proposal set drifts against live board state, so
# read this cycle rather than trusting any list written earlier. A pause hold
# cancels active runs -- confirm every proposed hold is still genuine and wanted.
systemctl --user start paperclip-liveness-reconciler.service
systemctl --user status paperclip-liveness-reconciler.service --no-pager
journalctl --user -u paperclip-liveness-reconciler.service -n 100 --no-pager
# Only after reading that cycle: raise PAPERCLIP_RECONCILER_MAX_REPAIRS in the env
# file if repairs are wanted, then enable the recurring timer.
systemctl --user enable --now paperclip-liveness-reconciler.timer
grep -Fx "$reviewed_commit" \
  "/usr/local/libexec/paperclip-liveness-reconciler/$reviewed_commit/REVISION"
(cd "/usr/local/libexec/paperclip-liveness-reconciler/$reviewed_commit" && \
  sha256sum --check --strict SHA256SUMS)
systemctl --user show paperclip-liveness-reconciler.service \
  -p ExecStart -p ExecStartPre -p TimeoutStartUSec
```

The service is bounded to four minutes, a ten-minute timer interval with jitter, and `PAPERCLIP_RECONCILER_MAX_REPAIRS` repairs per cycle — `0` unless the env file raises it. It does not dispatch orphan retries; Paperclip's native recovery owns those. `ExecStartPre` refuses an agent API key: scheduled writes require a dedicated board/service identity because agent writes require a live run ID and consume a per-run cross-issue budget.

## Controlled fixture repair

This performs no external or live mutation. `--apply` against a fixture records `fixture_simulated`:

```bash
python3 liveness_reconciler.py --fixture test/fixtures/tog-586-four-cases.json --apply
```

## Rollback

```bash
# Stop future activations first, then stop any oneshot already triggered.
systemctl --user disable --now paperclip-liveness-reconciler.timer
systemctl --user stop paperclip-liveness-reconciler.service
if systemctl --user is-active --quiet paperclip-liveness-reconciler.service; then
  echo "rollback refused: reconciler service is still active" >&2
  exit 1
fi
sudo rm -f /etc/systemd/user/paperclip-liveness-reconciler.timer \
  /etc/systemd/user/paperclip-liveness-reconciler.service
systemctl --user daemon-reload
```

Disabling the timer does not stop a service instance that the timer already launched. Remove the versioned release directory only after the service is confirmed inactive and any required journal/claim-store evidence has been retained.

Disabling the timer stops future reconciliation. Existing Paperclip issue/run history is not deleted. To undo an applied assignment, use the `before` object in the recorded proposal and the supported Paperclip issue API. This reconciler does not create orphan continuations; native Paperclip recovery owns and audits those runs.

Owner-HOLD pause holds are intentionally manual-release controls. After the explicit owner HOLD is superseded, list the active holds and release the reconciler-created hold through the supported board API:

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"reason":"Explicit owner HOLD superseded"}' \
  "$PAPERCLIP_API_URL/api/issues/<issue-id>/tree-holds/<hold-id>/release"
```

Do not release a pause merely because the issue status says `blocked`; the pause is the first-class suppression gate for comment-, interaction-, and mutation-triggered wakes.
