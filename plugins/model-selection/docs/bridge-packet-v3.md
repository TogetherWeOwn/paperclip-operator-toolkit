# Bridge packet v3 — source correction, NOT apply authority

Supersedes the v1/v2 full-roster command for [](/TOG/issues/).
The existing [](/TOG/issues/) live apply remains STOPPED until
CEO accepts the merged source, exact-head CI/review receipts and a successful
fresh-host preflight. No new Operator card, Zen lane or secret is requested.

## Correction and scope

The old full-roster assembler rejects six roster-only zero-cost Zen T3 rows when
`cliproxy-zen` is absent. Those rows are unrelated to the approved +2 bridge
change. V3 uses `--bridge-only`, not a full-roster refresh:

- Add enabled `muse-spark-1.3-contributor:T3` on existing `cliproxy-meta`.
- Add enabled `claude-sonnet-5-5:T2` on existing `cliproxy-claude`.
- Require the pre-existing enabled `gpt-6.1-sol:T1` on `cliproxy-codex`.
- Keep every existing model object (including id/tier/enabled/laneId), and every
  other top-level value, unchanged. `selection` and `pacing` come from BEFORE
  verbatim; no roster setting is ever merged into this packet.
- Require every enabled row's lane to exist in BEFORE's pacing lane list. An
  enabled unlaned live Zen row is still a STOP, never an exception to the guard.
- Stop if either approved addition already exists, Sol is missing/disabled,
  any required lane is absent, duplicates exist, or any preservation check fails.

The earlier +12-enabled prediction was a full-roster refresh, not preservation.
With the reported 124/16/106 BEFORE shape, the only permitted counts are
**126 models / 18 enabled / 108 lane-bound**. Counts are derived afresh; the
mandatory delta is +2/+2/+2, not a hardcoded replacement roster size. The default
full-roster command remains unchanged and still fails on the six-Zen control.

## Evidence and release prerequisites

`tests/fixtures/bridge-live-shape.ts` is a **sanitized equivalent**, not a fresh
production snapshot. It contains 124 rows, 16 enabled, 106 lane-bound, advise
selection, six existing non-Zen lanes, and none of the six roster-only Zen rows.
CLI tests first reproduce the exact six-row refusal without either output file,
then prove bridge assembly and independent verification/readback end-to-end.
They also refuse missing lanes, uncovered incumbents, disabled Sol, replay,
selection/pacing/binding/row drift and a readback differing from the artifact.

Before host execution, record the **merged source commit**, exact-head CI and
independent review links plus SHA-256 hashes of all three source inputs:

- `config/reviewed-roster.json`
- `scripts/assemble-additive-config.mjs`
- `scripts/verify-bridge-config.mjs`

A source diff, local green tests, or an uploaded bundle is **not** a merge,
independent approval, deployed artifact or renewed live-apply authorization.
The corrected packet changes no plugin worker/dist bytes; it prepares JSON only.

## Fresh-snapshot preflight (authorized host only; no config writes)

Use an operator-owned private working directory (`umask 077`). Read the actual
live `configJson`, not an API envelope, using the existing authorized snapshot
vehicle. Save it as `BEFORE.json`; record the snapshot vehicle and UTC time.
Never put config/secret values on argv or in comments. The following commands
assume verified files from the merged source and a real fresh BEFORE snapshot;
paths are local files, not credentials:

```sh
set -eu
umask 077
# Define the private packet directory first; every path below lives under it.
export PACKET_DIR="$(mktemp -d)"
# Run from the verified plugins/model-selection source directory.
sha256sum config/reviewed-roster.json scripts/assemble-additive-config.mjs \
  scripts/verify-bridge-config.mjs > "$PACKET_DIR/source.sha256"
sha256sum -c "$PACKET_DIR/source.sha256"
sha256sum "$PACKET_DIR/BEFORE.json" > "$PACKET_DIR/before.sha256"
sha256sum -c "$PACKET_DIR/before.sha256"
node scripts/assemble-additive-config.mjs --bridge-only \
  --roster config/reviewed-roster.json --live "$PACKET_DIR/BEFORE.json" \
  --out "$PACKET_DIR/artifact.json" --counts "$PACKET_DIR/counts.json"
node scripts/verify-bridge-config.mjs --live "$PACKET_DIR/BEFORE.json" \
  --artifact "$PACKET_DIR/artifact.json" > "$PACKET_DIR/preflight.json"
```

Any nonzero exit or missing output means STOP. Do not reuse stale outputs from
an earlier attempt: use a new private directory for each snapshot/preflight.
Inspect counts and the verifier's counts-only receipt. Obtain CEO acceptance
on the existing live-apply card. Source hashes must match the accepted receipt.
No application command is supplied here; the named versioned-install vehicle,
its id and separate live-apply authorization remain prerequisites.

Immediately before any authorized apply, take another fresh snapshot through
the same read vehicle as `FRESH.json` and compare it to BEFORE (JSON deep
equality, not merely counts). If it drifted, discard the prepared packet and
regenerate/revalidate; never overwrite intervening config. An installation
vehicle lacking a conditional-update or exclusive-write guarantee must be
dispositioned by CEO before applying. Hash the validated artifact again before
handing it to the vehicle. Apply **only that artifact**; never the full-roster
output or a hand-edited JSON file. Do not change package paths, models, pins,
timers, modes or bindings outside this +2 scope.

```sh
# Drift check: FRESH.json must deep-equal BEFORE.json; hash-compare the artifact.
node -e 'const fs = require("fs"), util = require("util"); const [aPath, bPath] = process.argv.slice(1); const a = JSON.parse(fs.readFileSync(aPath, "utf8")); const b = JSON.parse(fs.readFileSync(bPath, "utf8")); if (!util.isDeepStrictEqual(a, b)) { console.error("drift: FRESH.json differs from BEFORE.json"); process.exit(1); } console.log("no drift: FRESH.json deep-equals BEFORE.json");' \
  "$PACKET_DIR/BEFORE.json" "$PACKET_DIR/FRESH.json"
sha256sum "$PACKET_DIR/artifact.json" > "$PACKET_DIR/artifact.sha256"
sha256sum -c "$PACKET_DIR/artifact.sha256"
```

## Independent AFTER readback and rollback gate

After a separately authorized apply, read fresh live `configJson` as `AFTER.json`
through the independent read vehicle, then:

```sh
node scripts/verify-bridge-config.mjs --live "$PACKET_DIR/BEFORE.json" \
  --artifact "$PACKET_DIR/artifact.json" --readback "$PACKET_DIR/AFTER.json" \
  > "$PACKET_DIR/readback.json"
```

This rechecks full-row/settings preservation and deep equality of AFTER with
the validated artifact. It catches a transient/retained mode flip or binding
change and any altered addition metadata. On failure STOP and use the existing
authorized rollback vehicle to restore BEFORE, then independently read back and
verify equality. Never improvise another credential, lane, write path or secret.

The `APPLIED` receipt must name UTC time, BEFORE/artifact hashes, source commit,
CI/review links, accepted versioned-install vehicle id, preflight/readback
receipts and the two-row delta. Do not publish the underlying live config.

[](/TOG/issues/) remains **NO-GO** on enforcement/retirement.
[](/TOG/issues/) writer repair and the two-hour paired-evidence
window remain independent: shadowEmit=true is not proof of a functioning writer
or agreement. After authorized apply and writer readiness, require host and
plugin-shadow writers, comparablePairs > 0, zero malformed records, and the
accepted headroom-cycle window before any agreement claim. No agreement or
production/runtime result is claimed by this source packet.

## Test runtime source

The CLI specs inspect `spawnSync().status` and `.error`, not console success
phrases; failed preflight/readback must exit nonzero. Node API reference:
https://nodejs.org/docs/latest-v22.x/api/child_process.html#child_processspawnsynccommand-args-options
