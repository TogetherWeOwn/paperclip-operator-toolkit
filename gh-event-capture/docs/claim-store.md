# Closeout claim store: format and migration notes

Parent design: one authoritative snapshot is classified into at most one wake per pass.
Module: `gh-event-capture/src/claim-store.js`. This note is the format
reference; the module's validators are authoritative when they disagree.

## What it is

A host-local at-most-once set for PR-closeout exception wakes. One entry per
`(repository, PR number, head SHA, class)` that already produced a wake, so the
event path and the periodic repair sweep never wake the owning task twice for
the same exception. It is not the D1 wake-intent ledger: exceptions decided
from a fresh GitHub read (or by the sweep with no delivery at all) have no
stored delivery to claim there.

## Location and namespaces

- Same state directory as the consumer, beside `receipts.json`: `claims.json`.
- The file has its **own namespace digest**, derived as
  `sha256('closeout-claims-v1:' + receiptNamespace)`. Same scope inputs
  (capture origin, board origin, company, repository allowlist, mode), different
  digest, so a scope or mode change starts with no claims instead of inheriting
  silence, and claim state can never be mistaken for delivery receipts.
- Locking: this module takes **no lock of its own**. The caller must hold the
  receipt-store lock for the whole pass (as `consumer-runner.js` does for
  `sweeps.json`). Overlapping passes keep failing closed at the receipt lock.

## File format (`claims.json`)

```json
{"version":1,"namespace":"<64 hex>","claimed":[["<claim key>","<64 hex fingerprint>",1717248000000]]}
```

- `version` is `1`. The envelope has exactly these three keys.
- A claim key is the JSON tuple
  `["closeout","<owner/repo>",<pr number>,"<40 hex head sha>","<class>"]`,
  identical to the S1 classifier's claim tuple, so the two converge when wired.
- A fingerprint is `sha256('fingerprint:' + key)`; a mismatch fails the load.
- `claimedMs` is the claim time, kept for observability and digest Evidence.
- File mode `0600`, owned by the consumer user. Any extra key, duplicate key,
  unknown class, non-40-hex SHA, or over-budget file fails the load loudly and
  the pass stops with the cursor unadvanced. Nothing is ever reset
  automatically.

## Crash and loss behaviour (by construction)

- **Claim before post.** The consumer claims in memory, persists, then posts
  the wake. A crash between the persist and the post loses one wake rather
  than doubling it; the sweep re-derives from live GitHub state.
- **Loss of the whole state directory** degrades to the same bound: a fresh
  `claims.json` means the sweep re-wakes **at most one wake per still-open
  exception PR** (one `(head, class)` each), never a flood, never a
  duplicate for a PR that already merged or moved on.
- **Full store fails loud** (`claim count budget exceeded`). There is no
  silent eviction: evicting an old claim would re-wake its exception.

## Migration notes

- This store is new in this slice: there is nothing to migrate. The first
  deployment starts with an absent `claims.json`, which loads as fresh state.
- If S1's classifier is already deployed when this lands, the first sweep may
  emit one wake per already-known open exception (same bound as directory
  loss above). That is expected once, not a regression.
- Recovery from a poisoned file is deletion of `claims.json` only, with the
  consumer stopped: `receipts.json` and `sweeps.json` are untouched, and the
  next pass re-derives idempotently. Deleting the file re-arms at most one
  wake per open exception PR.
- Future wiring (consumer + sweep, shadow first) must keep the claim-persist
  strictly before `commentIfEligible`; reversing that order turns a crash
  into a duplicate wake.
