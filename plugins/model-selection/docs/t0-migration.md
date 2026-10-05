# T0 (S-tier) roster migration — operator runbook

Refs:  (child of ). Design:  `t0-design`, CEO decision 2026-09-29;
CTO admission disposition on  (`t0-cto-disposition`).

T0 is a tier above T1 that **implicit dispatch never reaches**. A card reaches T0 only on an
explicit `tier:T0` label (or, once the worker records it, an explicit-provenance pin). The
classifier never emits T0, a capability exclusion still forces T1, and explore, earn-in, the
derived-tier overlay and the router's own label writes cannot create or leave a T0 placement.

## What changes, and what does not

- **Code (this PR):** `T0` in `TIERS`/`TIER_ORDER`, `SCORE_THRESHOLDS.T0 = 0.90`, the admission
  ceiling (`engine/tier.ts admittedTierCeiling`, pool filter in `select.ts`), tier-policy revision 2.
- **Live config (operator, after deploy):** exactly three roster rows, two fields each:
  `gpt-6-astra`, `claude-opus-5-5`, `claude-fable-5-1`: `tier T1 -> T0`, `fallbackOnly true -> false`.
  Lanes, caps, capabilities, context windows, scores and notes are untouched.
- **Not changed:** `devin/gpt-6-astra` and `devin/claude-fable-5-1` (separate deployed rows on the
  `cliproxy-devin` lane, still interim T1/fallbackOnly). They are named by no approved decision; a CTO
  call decides whether they follow. `selection.mode` stays as is — this migration is not an enforcement flip.

## Step 0 — deployed vs repo reconciliation (recorded)

Receipt: `sanitized-roster-receipt-v1`, captured 2026-10-03T18:59Z by the authorized host
operator ([](/TOG/issues/), sha256 `a6252507ad93a8e7dbbfee04acc2437a9ce2f57d018e0a21137c688c2f0c8445`). 124 live rows against the repo
`reviewed-roster.json`'s 86, no `laneId` in the repo roster, and **no `claude-opus-5-5` row in the
repo**. The live `claude-opus-5-5` row is a distinct roster row (ordinal 120, `cliproxy-claude`,
`aaIndex 54`, interim T1/fallbackOnly) — **not** an alias of `claude-opus-5` (ordinals 0 and 90).
Its *serving* identity is unverified: the roster id is the identity the router routes by, and no
equivalence to Opus 5 is inferred. Because the repo roster lacks lanes and this row, the migration
edits the **live** config; it must never be assembled from `reviewed-roster.json`.

## Order of operations (do not reorder)

1. **Merge this PR, then deploy the build** with the existing hash-verified, atomic plugin-package swap
   and worker restart (operator). The *previous* build rejects `tier: "T0"` as an unknown tier, so the
   config change below must come after the deploy, never before.
2. **Capture the live config** (read-only) to `live.json`.
3. **Plan the migration**:
   ```
   node plugins/model-selection/scripts/migrate-t0-roster.mjs \
     --live live.json --receipt receipt.json --receipt-sha256 a6252507ad93a8e7dbbfee04acc2437a9ce2f57d018e0a21137c688c2f0c8445 \
     --out migrated.json --rollback rollback.json
   ```
   It refuses (writing nothing) when: the receipt hash differs; a target row is missing, duplicated or
   has drifted from the receipt (lane, capabilities, window, index); `claude-opus-5-5` is not attested as
   a distinct row; a target is not in the interim state; a target has no lane. Matching is by exact id.
   Review `migrated.json` against `live.json`: exactly 3 rows x 2 fields differ.
4. **Apply `migrated.json`** through the board config API (operator). Re-running step 3 on the migrated
   config plans nothing (idempotent).
5. **Refresh scores and profiles** (`refreshScores` job; `npm run profiles:refresh`). `buildVolumeProfiles`
   attributes runs to a row's *current* tier, so the three rows' own history builds the T0 volume
   profile. Until it exists an explicit `tier:T0` card is refused (`no volume profile recorded for T0`)
   rather than costed off another tier's numbers.
6. **Shadow verification — record it before any enforcement decision.** With the T0-aware build serving and
   `mode` unchanged:
   ```
   node plugins/model-selection/scripts/verify-t0-shadow.mjs --input <decisions.jsonl|shard dir> \
     --min-decisions 50 --out t0-shadow.json
   ```
   Exit 0 = no decision that did not opt in picked or costed a T0 row, with the `tier ceiling` marker
   present (proof the T0-aware build emitted the stream). Exit 1 = violation. Exit 2 = insufficient
   evidence (too few decisions, or no marker) — wait and re-run; a clean count there is vacuous.
7. **Verify the live rows**: `migrate-t0-roster.mjs --verify --live <fresh GET config> --receipt receipt.json`.

## Rollback

`rollback.json` lists, per row, the interim `tier`/`fallbackOnly` values to restore. Applying it returns the
three rows to T1/fallbackOnly and is accepted by both the old and new build, so no build rollback is needed.
Prefer the patch over replaying a saved full config, which may have drifted since the capture.

## Known live effects to expect after step 4

- An **idle** card hand-pinned to one of the three rows, carrying `tier:T1` (no `tier:T0`, no `pin:operator`),
  is cost-down balanced to T1 by `balancePass` in enforce mode: a pin is history, not an opt-in. Label such a
  card `tier:T0` or `pin:operator` to hold it. Shadow mode writes nothing.
- A T0 row is exempt from the derived-tier overlay in both directions: a posterior cannot drop it into
  implicit T1. Whether it can do T0 work is the capability gate's job (`capable` at T0, bar 0.90).
- `tier-exhausted` for an ordinary card stops at T1: it never escalates onto a healthy T0 row.
- Pin provenance is not yet recorded by the worker, so every pin is `unknown` and `tier:T0` is the only
  way in. The engine and tests already honour an `explicit` provenance when the worker supplies one.
