# Closeout debounce and shadow sweep (S3b): format and wiring notes

Parent design: one authoritative snapshot is classified into at most one wake per pass.
Modules: `gh-event-capture/src/closeout-pending.js` (scheduler state),
`gh-event-capture/src/closeout-sweep.js` (decision runner plus review-phase
wiring). The `sweep-cycle.js` review path gains one opt-in hook, default off.
The module validators are authoritative when they disagree with this note.

## What it is

Slice S3b extends the repair sweep to run the S1 decision function per open
PR, **in shadow**: it logs per-PR decisions and aggregate counters and changes
no live behaviour. Nothing here claims, comments, or wakes. The S5a wake
transport does not exist yet, and claiming now would eat the first real wake,
so the runner takes no board, no capture, and no claim-save dependency at all.

## Pending-work file (`pending.json`)

- Same state directory as the consumer, beside `receipts.json` and
  `claims.json`. Own namespace digest, derived as
  `sha256('closeout-pending-v1:' + receiptNamespace)` — same scope inputs,
  different digest, so a scope or mode change starts with an empty debounce
  instead of inheriting silence, and pending state can never be mistaken for
  receipts or claims.
- One entry per `(repository, PR)`: `["<pending key>", <firstSeenMs>]`, where
  the key is the JSON tuple `["closeout-pending","<owner/repo>",<number>]`.
- Lifecycle: recorded on observation (re-observation keeps the original
  first-seen time, so repeats cannot stretch the debounce); due when
  `nowMs - firstSeenMs >= debounceMs` (default 90 s, inside the 60–120 s
  design window); flushed after the due evaluation runs; pruned when the PR
  leaves the open list. A `bypass: true` flag skips the gate for the S6b
  disarm hook and nothing else.
- Hardening matches the sibling stores: absolute directory, `0600` files
  owned by the consumer user, byte and entry budgets, fail-closed errors,
  namespace-mismatch refusal, no lock of its own (the caller holds the
  receipt-store lock for the whole pass). Loss of the state directory only
  re-arms the debounce: exceptions evaluate one snapshot later, never twice.

## Shadow runner (`runCloseoutShadow`)

Per open PR: one `getCloseoutSnapshot` read, resolve via the PR-task index
(unmapped stays unmapped, never guesses; the branch/body ref fallback is
intentionally not fed, so nothing is inferred from fork-controlled text),
classify under the injected `closeoutPolicy`, and a read-only `hasClaim`
check. Output per-PR records
`{ decision, wouldClaim | alreadyClaimed | none }` plus aggregate counters
(total, mapped, unmapped by reason, no-exception, exceptions by class,
would-claim, already-claimed, errors). Unreadable or unclassifiable snapshots
are counted error records, not a thrown run: one bad PR must not blind the
shadow over the rest, and no transport detail is stored.

## Review-phase wiring (`createCloseoutReview`, `sweep-cycle.js` hook)

- `createCloseoutReview` owns the pending store and the debounce clock and
  borrows the caller-loaded claim state read-only. Each `runReview` prunes
  this repository's closed PRs, records observations, evaluates due PRs only,
  flushes what it evaluated, and persists only when something changed.
- `runSweepCycle` accepts an optional `closeoutReview` hook (`{ runReview }`,
  default `null`). It fires once per repository **review** snapshot, never on
  the backfill path, and its summaries surface as `closeoutShadow` in the
  cycle result only when the hook is set. Default runs are byte-for-byte the
  old behaviour: same reconciliations, no extra key, no extra reads.

## Crash and loss behaviour (by construction)

- **Evaluate then flush.** Entries flush after their evaluation runs, so a
  crash between evaluation and flush re-evaluates (and re-logs) one shadow
  record, never a wake.
- **Full store fails loud** (`pending entry budget exceeded`). There is no
  silent skip: a dropped observation would read as "not due yet" and delay
  the exception decision without a trace.
- Recovery from a poisoned file is deletion of `pending.json` only, with the
  consumer stopped: `receipts.json`, `claims.json` and `sweeps.json` are
  untouched, and the next pass re-observes idempotently.

## Migration notes

- This slice is new: there is nothing to migrate. The first deployment starts
  with an absent `pending.json`, which loads as fresh state, and the hook
  unset, which is the old code path exactly.
- S6b consumes the `bypass` flag for disarm; S5a consumes the shadow
  counters to validate coverage before any live wake. Neither may weaken the
  fail-closed loads here.
