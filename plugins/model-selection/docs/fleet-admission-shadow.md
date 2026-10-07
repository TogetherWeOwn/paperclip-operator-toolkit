# Fleet admission shadow validation

This path is report-only. It does not select a model, reserve capacity, change admission, or actuate the host. Enabling account admission shadow must not change the legacy advice or apply result.

## Weekly proposal inputs

The vendored fleet proposer and burn-down source remain byte-faithful to the router revision in their headers. The plugin adapter supplies the plugin pace engine's effective weekly allowance weight (`allowanceWeight ?? account.weight`), rather than letting the proposer default per-window capacity to equal account weights.

Only a computable weekly allowance governor contributes to the weekly projection and spend order. Unknown lanes and serviceability-only accounts remain in inventory but cannot supply a weekly score. Five-hour exhaustion remains a share-gated backstop; it is not a weekly governor. The input ledger is never mutated.

The previous known proposal level is persisted across advise cycles. An unknown cycle preserves that level and the history without recording a proposal. Added and cancelled accounts come from the next live verdict, not from a maintained account list.

## Reset-aligned daily table

The shadow history stores each lane's weighted weekly utilization, linear projection, source observation time and weekly reset identity. Accounts with different weekly resets are separate report rows. A temporarily tripped five-hour account contributes its measured weekly utilization, not an artificial 100% weekly utilization.

The daily job reads this recorded history. It must not use the current ledger as the actual for an earlier or upcoming reset. Rows are keyed by lane and weekly reset:

- `pending-reset`: the weekly reset has not happened. The actual, error and target-band result are null.
- `reset-observed`: the last source observation at or before a completed reset is within 15 minutes of that reset. The table compares that measured utilization with the projection from the same weekly window. This is a bounded pre-reset sample, not a claim of exact-at-reset measurement.
- `reset-reading-unavailable`: the reset happened, but there is no endpoint reading inside that sampling budget. The actual, error and target-band result are null.
- `unknown-window`: old history lacks reset identity. It cannot validate a landing.

Re-reading an old ledger never updates its source observation time. Post-reset zero readings are not measurements of the previous window. History is bounded to 200 cycles; a missing or evicted endpoint remains unknown.

## Host governor comparison

The comparison consumes sanitized `governorLevels` observations on the stored shadow document. Each entry has a known fleet level and an ISO source `asOf`. The advise writer preserves those entries. Level agreement is reported only when the proposal and governor observations are within 15 minutes of each other; missing or unaligned governor observations produce a null comparison with a limitation note.

Host snapshot ingestion and live report receipt must be independently verified before using this artifact to authorize enforcement. A sample report, a passing unit test, or a table of unknowns is not evidence of seven consecutive complete daily reports. Enforcement remains a separate approval.

## Offline regressions

`fleet-admission-shadow.spec.ts` uses real normalizer/evaluator output to test unequal allowance weights, unknown and serviceability-only exclusions, inventory reflow, hysteresis and majority/minority backstops. `fleet-predicted-vs-actual.spec.ts` tests completed versus future resets, source timestamp alignment, missing endpoints and measured weekly utilization under five-hour trips. `worker.spec.ts` exercises real advise cycles, bounded history, unknown no-op, the scheduled daily job and the company-scoped read tool. Named worker mutations protect the state wiring, not just the pure helpers.
