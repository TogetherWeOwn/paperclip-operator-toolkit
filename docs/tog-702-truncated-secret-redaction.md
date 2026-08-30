# TOG-702 — secret redaction only worked on the case least likely to happen

**Status:** fixed. Patch written, typechecked, mutation-gated, and proven to flip
the measurement against a real 2048-bit RSA key. Landing it upstream is a
separate step — see §7.

---

## 1. The defect

`server/src/services/run-secret-redaction.ts` matched registered secrets by
**exact substring**:

```js
function redactText(input, values) {
  return values.reduce((result, value) =>
    value.length > 0 ? result.split(value).join(REDACTED_EVENT_VALUE) : result, input);
}
```

A **cut** secret is not a substring of the registered value, so it was emitted
verbatim.

**Cutting is the normal case, not the exotic one**, and two independent
mechanisms in this product guarantee it:

| mechanism | where | what reaches the redactor |
|---|---|---|
| agent error reason capped at 500 chars | `heartbeat.ts:12813` `truncateAgentErrorReason` | a 500-char **prefix** |
| `/log` reads are an offset byte window | `agents.ts:3970` `readRunLogLimitBytes` | an **interior slice** |

A 2048-bit PKCS#1 key is **1679 characters** (measured, not estimated). So a
capped error message carries a 500-character prefix of it, and a windowed log
read carries a slice cut at *both* ends. The redactor saw neither.

## 2. Why the previous incident was luck, not a control

In TOG-638 a GitHub App private key reached 35 transcripts through exactly this
hole. That was harmless only because the deepest cut landed at DER byte 288 of
1193 — 11 bytes into `d`, entirely inside the region derivable from the public
`(n,e)` (see [`truncated-key-leak-measure-der-offsets`] in memory). **The
500-character display cap is what bounded the blast radius.** A cut a few hundred
bytes later leaks prime material and evades redaction identically.

A display cap is not an access control. That is the whole reason this card is
independent of TOG-638's disposition.

## 3. Measured before and after, by execution

The deployed redactor was extracted from `/app/server/dist` and executed
directly — the field was never merely read. Against a freshly generated real
2048-bit key:

```
case                            DEPLOYED    FIXED
full value                      redacted    redacted
500-char cap (error_reason)     LEAKED      redacted
interior slice (/log window)    LEAKED      redacted
json-escaped 500-cut            LEAKED      redacted
cut at both ends                LEAKED      redacted
benign log line                 untouched   untouched
```

The **benign row is half the result.** A redactor that redacts everything
"fixes" the first five rows and destroys the product's logs; the acceptance
criterion is the differential, not the redaction.

## 4. The fix

Match any sufficiently long **fragment** of a registered value at **any offset**,
in both the raw and the JSON-escaped spelling.

- **Escaped spelling matters** because transcripts, event payloads and captured
  stdout are all JSON, so the literal value never appears in them.
- **Whole-value replacement still runs first**, so registered values shorter than
  the fragment floor keep working and overlapping values keep collapsing
  longest-first (an existing test pins that).

Two floors bound **over**-redaction, which is the failure mode a naive fix
introduces:

| floor | value | why |
|---|---|---|
| `MIN_FRAGMENT_LENGTH` | 16 | shorter fragments are not distinguishable from ordinary text |
| `MIN_FRAGMENT_DISTINCT_CHARS` | 6 | without it, a run of spaces inside a registered value redacts every indented line in every log |

Measured against real PKCS#1 keys, the least varied 16-character window holds
**9** distinct characters, so neither floor ever suppresses genuine key material.

Matching is prefiltered by a base-31 rolling hash into a 64 KiB table. **The hash
is a filter, never a decision** — every candidate is confirmed character by
character, so a collision costs time and can never redact unrelated text.

### Cost

At the `/log` route's 1 MiB maximum:

| input | cost |
|---|---|
| **no registered secrets** (the overwhelmingly common path) | **0.31 ms** — unchanged |
| one registered key | 58 ms |
| twelve registered keys | 227 ms |

A run only pays once it has actually registered a secret.

### One accepted trade-off, recorded rather than hidden

A PEM's opening armour line is 31 characters *of the registered value*, so
fragment matching redacts that line wherever it appears. It is a public
constant, so this costs a reader some context and discloses nothing. Suppressing
it would mean special-casing known-public prefixes — a denylist, which rots.
**This is asserted as a test**, so flipping it later is a deliberate argument
rather than an incidental change.

### The fixtures assemble their armour lines rather than spelling them

The test fixture and `tog-702-find-hash-collision.mjs` both build
`-----BEGIN … PRIVATE KEY-----` from fragments at runtime. This repo's CI
carries a secret scan that greps **tracked files** for exactly that shape, and a
PEM-shaped fixture written out literally trips it. That matters more than it
sounds: the cheapest way to fix that red is to weaken the scan, and then the
gate that exists to catch a real committed key has been narrowed by a test that
never held one. `test_gh_app_token.sh:59-63` assembles its token canaries from
fragments for the same reason and says so; this follows that precedent. The
collision generator's output is byte-identical before and after the change,
which is the check that the assembly reproduces the same fixture.

## 5. Proving the tests can fail

`verification/tog-702-mutation-gate.sh` — **9 passed, 0 failed**.

The gate mutates the fix and requires the suite to react. It covers **both**
directions, because a suite that only catches under-redaction would score full
marks against a redactor that eats every log in the product:

| mutant | direction | result |
|---|---|---|
| revert to exact substring matching | under | killed |
| fragment floor raised above a 500-cut | under | killed |
| stop indexing the JSON-escaped spelling | under | killed |
| only match fragments at offset 0 | under | killed |
| redact every string wholesale | over | killed |
| drop the distinct-character floor | over | killed |
| trust the hash without confirming chars | over | killed |
| **prefilter table resized** | **decoy — must stay green** | **green** |

Three of these **survived on the first run**, and each was a real hole in my own
tests rather than a gate artefact:

- **JSON-escaped variant.** A PEM's lines are 64 characters, so most 16-character
  windows contain no newline and read identically escaped or raw — measured, 226
  of 313. The PEM case passed *without* the escaped index. Closing it needed a
  secret whose lines are **shorter than the fragment floor**, where every fragment
  straddles a newline and the raw spelling never appears in JSON at all.
- **Distinct-character floor.** Needed a registered value containing a long run of
  one character, then an assertion that ordinary text sharing that run survives.
- **Hash confirmation.** Random text will not collide with a 32-bit hash, so the
  suite could not tell a confirming matcher from a trusting one. Fixed by finding
  a **real collision** by meet-in-the-middle
  (`verification/tog-702-find-hash-collision.mjs`, ~2^16 tries instead of 2^32):
  `AAAAAABzAAAAAdnj` hashes identically to the key window `AZyLk9WvIh6TsFe3` and
  shares no substring with the key. The test asserts the collision still holds
  before relying on it, so the fixture cannot silently stop testing anything.

**The decoy is what makes the kills mean something.** Without it, a suite that
went red on any edit whatsoever would post eight kills and prove nothing about
attribution.

The gate **never writes to `/app`**: it symlinks a shadow tree, applies the patch
into it, and mutates only that. Verified after the run — both files byte-identical
to their originals, and `find -newermt` reports nothing written.

## 6. Files

| Path | What |
|---|---|
| `patches/TOG-702-truncated-secret-redaction.patch` | the fix + 20 tests |
| `verification/tog-702-mutation-gate.sh` | 9 mutants incl. the decoy; exit 0 clean · 1 survivor · 2 refused |
| `verification/tog-702-find-hash-collision.mjs` | regenerates the collision fixture if the hash params change |

Reproduce:

```sh
./verification/tog-702-mutation-gate.sh        # 9 passed, 0 failed
node verification/tog-702-find-hash-collision.mjs
```

Verification performed on the patch itself:

- `tsc --noEmit -p tsconfig.json` clean against the real server project config.
- **Negative control on that green** — typing `MIN_FRAGMENT_LENGTH` as `string`
  fails with `TS2322`/`TS2365`, rc=2. The green was real.
- `git apply --check` clean against **pristine** upstream sources, and the
  patched tree hashes byte-identical to the tree the tests actually ran against.
- `/app` restored and verified by sha256 (`2c2a6b7b…`).

## 7. What this does not do

**It is not deployed.** `/app/server/dist` is what actually runs, and this repo
holds the fix as a patch — the same standing gap as
[`merged-plugin-code-is-not-deployed-code`]. Until it lands upstream and is
built, `/log` and `/events` still leak truncated secrets.

It also does not touch **TOG-703**: transcript reads are still company-scoped
rather than run-scoped, so a foreign agent got `200` on both `/log` and `/events`.
That is an independent defect on the same surface and is filed separately.
