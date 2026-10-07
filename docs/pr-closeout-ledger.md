# Admitted-PR closeout ledger

`pr_closeout_ledger.py` is the automation slice of a Director-owned closeout
loop. It persists
one canonical record per explicitly admitted repo+PR and emits bounded,
diagnostic-only sweep proposals. It does not merge, close, reassign, or
relabel anything: there is no `--apply` flag on purpose.

## What it proves that a status-only sweep does not

A status-only hygiene sweep skips drafts/releases, requires an assigned card
ref parsed from the PR body, and treats `mergeable_state=clean` as all-green without reading checks or reviews.
This tool inverts all three defaults:

- Admission is an explicit registry entry, never a body parse. No
  auto-admission, no legacy cohort.
- `mergeable_state` is read and then ignored. Only required-check attempts at
  the exact head SHA count; anything else is RED or UNKNOWN.
- Drafts and release-please PRs are owned work (`OWNED_NO_AUTOMERGE`) that can
  never auto-merge.

A head move voids prior checks and reviews. Stale evidence is kept in the
record's `history` array, never reused as current proof. Missing checks or
API errors read UNKNOWN, never green.

## Inputs

- `--registry`: `{"entries": [{repo, pr, admission, kind, authorCard,
  successorCard, reviewerCard, securityCard, standingOwner, ceoEvidence,
  admittedAt, deliveryDeadline}]}`. `admittedAt`/`deliveryDeadline` are
  optional ISO timestamps carried onto the record as admission age and the
  delivery promise; absent or unparseable values are evidence gaps, never a
  refusal.
  `admission` is `admitted` or `decision_pending`; `kind` is `standard`,
  `draft`, or `release`. Anything else refuses with exit 5.
- `--snapshot`: `{"snapshots": {repo#pr: {...}}, "reviews": {repo#pr: {...}},
  "cards": {card: {...}}}`. Snapshots carry `headSha`, `checks[]` (each with
  `name`, `sha`, `conclusion`), `requiredChecks[]`, `merged`/`mergeCommitSha`/
  `mergeUrl`, `draft`/`releasePlease` flags, and the company-gate fields.
- `--prior-ledger` (optional): previous ledger state; fuels `history` and
  carries `createdAt`/`lastProgressAt` so stalls are measured honestly.
- `--cards` (optional): extra card rows merged over the snapshot's cards.

## Reading the output

- Exit 0: owned and monitored, or terminal/excluded. Nothing is due.
- Exit 1: diagnostic proposals emitted. Each names `recommendedAction` plus an
  `owner` (author/successor, reviewer, Director, CEO, or the DevOps CI
  steward) and carries the record's `nextCheckAt`, so the plan is the recheck
  schedule. The authorized Operator applies at most one action per admitted
  card per pass.
- Exit 5: could not measure (unreadable/empty registry, empty snapshot).
  Refuses to report a clean board.

Dispositions: `APPROVED_WAIT_CI` (owned, monitored; SHA change voids it),
`NEEDS_REVIEW`, `NEEDS_FIX`, `UNKNOWN_CHECKS`, `CHANGES_HANDBACK` (findings +
same owner + executable action) vs `CHANGES_STRANDED`, `MERGED` (verified
merge SHA/URL only), `OWNED_NO_AUTOMERGE`, `PARKED`/`SUPERSEDED` (CEO evidence
only), `EXCLUDED` (decision-pending; never wakes).

Proposal reasons: hard barriers (`live_run`, `owner_hold`,
`native_recovery_pending`, `pending_interaction`, `review_gate`,
`cancelled_edge`, plus `terminal_card` when a chain end is done/cancelled)
resolved by walking the ownership chain in order -- the first hard-held
card owns the barrier, so a blocked author never absorbs a reviewer's live
run and a live reviewer never promotes the author. A hard guard on the same
card always beats its own dependency wait: a card with a live run behind a
blocked edge is `live_run`-held, not merely waiting.
`blocked_dependency` for an owned non-cancelled blocker wait. The wait
follows multi-hop edges (author -> reviewer -> steward, up to 8 hops): the
terminal card owns the barrier or the unblock, and a cycle or a missing
live row strands with the travelled path named (`A -> B -> A`), never
spinning. A guarded off-chain terminal yields its terminal guard first, so
a done/cancelled chain end reads as moot evidence, never a stall to
escalate; its monitor liveness (healthy/lapsed/absent) is named on the
proposal. One proposal per card per pass covers every branch, barrier and
wait rows included; a second claim on the same card is refused.
`monitor_lapsed`, `approved_wait_ci_owned`, `missing_disposition`, and stall
escalations (`stall_director` past 6h without progress, `stall_ceo` past
24h). A soft wait past its stall window escalates as an owned stall row; a
hard hold keeps its owner and reason with the stall named as awareness. All
are diagnostic with `mutation: "none"`; a re-read without fresh progress
keeps the stall, it never restarts it. An identical CHANGES reread (same
findings/action/head) is not progress and keeps the prior windows.

Records keep the acceptance evidence: per-required-name latest exact-head
attempts (`requiredCheckAttempts` with attempt id, timestamps and status;
verdict and evidence read the SAME newest row, so they never disagree -- a
result-less NEWEST row is a run in flight and never green even beside an
older success, while a result-less older row is a superseded attempt that
does not veto green; untimestamped rows sort oldest, and the newest wins by
time/id, never by API list position), `admittedAt` with
`admissionProvenance` (`registry`, `prior`, `first_sight` for the explicitly
unproven first-seen fallback that survives persisted rereads unrelabeled,
`missing` for a claimed-but-unparseable timestamp), `admissionAgeHours`,
and a validated `deliveryDeadline` (invalid values normalize to a None gap
like `admittedAt`). Cadence is hourly from each read (`nextCheckAt`,
`nextCheckKind: "recheck"`); the 6h/24h windows are stall escalations, not
the recheck schedule. Healthy records emit no proposal: the hourly consumer
reads the recheck schedule from `ledger.records[*].nextCheckAt`, not only
from plan rows.

Progress clock, sticky MERGED and bounded history:

- **`lastProgressAt` advances on real progress** and only then: a head move
  against the last head the ledger read, required checks going RED -> GREEN,
  or an APPROVE newly landing at a head not approved before. An unchanged
  reread keeps the clock, so looking at a stalled record never restarts its
  6h/24h windows. A read gap cannot launder it either: UNKNOWN -> GREEN is
  not progress (a failed read followed by a good one is the same GREEN), an
  APPROVE the record already saw at that head is not new (so a review read
  that flaps APPROVE -> NONE -> APPROVE is one approval), and a push during a
  gap still counts because `lastKnownHeadSha` / `lastApprovedHeadSha` carry
  the baselines across reads that could not name them. A reread after a gap
  that missed a RED -> GREEN transition is not renewed -- conservative, never
  a false renewal. CHANGES handbacks keep their own identical-findings rule.
- **MERGED is sticky.** A prior MERGED record that holds a full merge SHA and
  URL keeps both across an absent snapshot, a failed (`apiError`) read, or a
  merged-without-proof flag, and stays out of proposals. Only a read that
  measured the PR may speak over it: its own merge proof, or a clean
  `merged: false` snapshot (a contradiction surfaced, not hidden). A prior
  MERGED row without proof was never verified and is not sticky.
- **History is bounded.** `history` is stale evidence, not a read log. A row
  is appended only when the prior record's head is no longer the record's
  head: a head move, or one read that could not name a head (once -- a
  persistent gap has no prior head left to supersede). Identical rereads
  append nothing and the list keeps the newest `HISTORY_CAP` (50) rows.
- `APPROVED_WAIT_CI` is reached only on GREEN at the approved head, so its
  next action names the merger: the approving reviewer squash-merges at this
  exact head.
- `PARKED`/`SUPERSEDED` need BOTH a hand-written prior-ledger row marked with
  that disposition AND the registry entry's `ceoEvidence`. A registry
  `ceoEvidence` alone is ignored in this slice, and a prior PARKED row without
  it stays owned as `UNKNOWN_CHECKS`.

## Dry-run smoke (read-only)

```bash
python3 pr_closeout_ledger.py --registry registry.json --snapshot snapshot.json \
  --ledger-out ledger_state.json --plan-out plan.json
echo "exit=$? (0 = nothing due, 1 = proposals, 5 = could not measure)"
```

The live-input producer (the hourly closeout pass that reads GitHub head SHAs,
check runs at exact heads, review verdicts and branch rules) and the plan
consumer (the authorized operator that applies at most one diagnostic action
per admitted card per pass) live outside this tool; it is a pure evaluator over
the registry and snapshot files and writes only the two output files you name.
