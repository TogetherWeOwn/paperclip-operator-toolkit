# ADR-0005 (plugin): Roster prices are reconciled against models.dev, never synced from it

- **Status:** accepted
- **Date:** 2026-09-22
- **Card:** TOG-3996
- **Related:** ADR-0001 (the volume-aware cost term these fields feed), TOG-2438
  (the aa.ai drift sweep this is structured after), CAP-061 (the thirteen rows
  shipped disabled rather than cost-sorted on an estimate)

## Context

ADR-0001's cost term is a **sorter**. It reads `costPerMTokIn`,
`costPerMTokOut` and `costPerMTokCacheRead` straight off each hand-entered
roster row and orders candidates on the result. Nothing else in the plugin
checks those three numbers against anything.

A hand-entered number in a sorter's input has a failure mode with no error in
it. Nothing throws, no gate goes red, no trace says "suspect": the fleet simply
routes to a different model than the one the operator intended, and keeps doing
so until somebody re-derives the prices by hand.

A 2026-09-22 audit against models.dev did exactly that and found **26 of 117
rows mispriced**, including rows the selector was actively choosing:

- All five `muse-spark-*` rows carried `0/0/0`. This is not "slightly wrong".
  A cost term that is identically zero is zero at every volume, so the row wins
  every cost comparison it enters regardless of what it actually costs. Real
  Meta list pricing is `muse-spark-1.3` = 1.25/4.25/0.15 and
  `muse-spark-1.3-contributor` = 0.10/0.20/0.002.
- `claude-sonnet-5` carried 3/15/0.3 against a real 2/10/0.2.
- `gpt-5.5` carried 1.5/7.5/0.15 against a real 5/30/0.5 — a 3.3x
  understatement, in the direction that costs money.

The operator applied all 26 corrections by hand. That fix is good until the
next industry price change, and there is no mechanism that would notice it.

## Decision

A daily job fetches `https://models.dev/api.json` and **reports** the diff.

### It never writes a price

A price change reorders the entire fleet's routing. An automatic write would
mean a vendor's pricing page silently re-ranking every candidate set in the
company overnight, with the first evidence being a changed bill.

So the job emits a diff, stores it, logs the findings to the activity stream,
and stops. An operator applies. This is deliberately the same posture as the
thirteen CAP-061 rows, which shipped **disabled** with the marker *"Would
enable once CLIProxy pricing is confirmed — shipped disabled to avoid an
estimated price silently winning cost-sort over already-proven models."* The
principle is identical: a wrong price that routes is worse than a stale price
that is labelled.

There is consequently no `autoApply` option in `priceSync`. Not "defaulted
off" — absent. An option is an invitation.

### The provider is resolved from `laneId`, never guessed from the id

`LANE_PRICE_PROVIDERS` maps `cliproxy-claude`→`anthropic`,
`cliproxy-codex`→`openai`, `cliproxy-meta`→`meta`, `cliproxy-zai`→`zhipuai`,
`cliproxy-kimi`→`moonshotai`, `cliproxy-opencode-go`→`opencode-go`. Matching is
on the bare id after stripping any `provider/` prefix.

The same model is priced differently at different providers. In today's feed
`kimi-k2.6`, `glm-5`/`5.1`/`5.2`/`5.3`/`5.3-flash` and the
`muse-spark-*-contributor` rows each appear under **both** their native
provider and `opencode-go`, at different rates. A global id search would
therefore return *a* price with full confidence and the wrong one about as
often as the right one — the worst available failure mode, because it is
indistinguishable from success. The lane is the only field on a roster row that
records who we actually buy from.

A lane not in the map is reported **unresolved**, never guessed. Adding a lane
is a code change here, on purpose.

### Four classes of row are correct as-is and are excluded before any lookup

Absence from the feed is **not** evidence of a wrong price. Each exclusion is a
different reason and each is checked before the catalogue is consulted, so an
excluded row cannot produce a finding even if the feed carries a lookalike id.

| class | why |
| --- | --- |
| 28 `devin/*` rows | Devin meters by subscription/ACU, not per token. A $/Mtok figure for it would be a fiction. |
| `*-free` rows | `opencode-go/*-free`, `muse-spark-*-contributor-free`. 0 is the true price, not a missing one. |
| 6 retired Anthropic ids | Enabled, absent from the feed, verified by hand against historical rate cards. The feed drops retired models; that is not a price change. |
| `gpt-image-1.5`, `gpt-image-2` | Per-image pricing. The $/Mtok fields do not describe them. |

### A field the provider does not publish is not a zero

`zhipuai/glm-4.5v` and `glm-4.6v` publish `{input, output}` and no
`cache_read`. The parser records an omitted field as `null`, and the diff
**skips** a `null` rather than comparing the roster value against an implied 0.
Reading it as 0 would manufacture a drift row against every correctly-priced
row whose provider simply has no cache rate — and a report that cries wolf on
correct rows is a report nobody reads. ADR-0002 already establishes that cache
read is a first-class field (it is 44% of the opus bill), which is exactly why
it cannot be silently defaulted.

"Present in the feed but unpriced" and "absent from the feed" stay distinct
outcomes for the same reason.

### Every row lands in exactly one bucket

`drift` / counted in `unchanged` / `excluded` / `unresolved`, and `unresolved`
is further split into `no-lane`, `unmapped-lane`, `absent-from-feed` and
`unpriced-in-feed`. "We chose not to check this", "we could not check this" and
"we checked and the feed does not carry it" are three different facts and only
the first is a settled answer. A row that quietly matched nothing and was never
mentioned is the failure this report shape exists to prevent.

## Consequences

- **These are LIST prices.** Where we are on a flat subscription — Meta Muse
  Power at $50/mo, Codex Pro, Claude Max — our marginal cost is not the list
  price. List prices still give the correct *relative ordering* the selector
  needs, which is why using them is right. They must **not** be presented to
  anyone as what the company actually pays; actual spend is the cost-ledger
  work, sourced from `cost_events`. The caveat is written into the suggested
  note clause, the tool output and every activity-log record, because the
  number itself does not carry it and somebody will eventually quote it.
- The fetch sets a real `User-Agent`. models.dev is behind Cloudflare, which
  403s default library agents at the edge (`Python-urllib` is what the manual
  audit tripped over) before the request reaches an origin. A 403 gets its own
  error code so an operator checks the header instead of hunting for a
  withdrawn feed.
- The timeout is built with `Promise.race`, not `AbortController`:
  `ctx.http.fetch` silently drops `AbortSignal` on the real host per the
  plugin-sdk wire shim, so an abort-based timeout would not fire at all.
- Surfacing is deduped on `(modelId, field, feedPrice)` — including the price.
  A row that stays mispriced because nobody has applied the correction yet must
  not re-alarm daily, but a second, *different* price change on the same row is
  new news and surfaces again.
- A failed fetch or an unparseable payload keeps the prior report and records
  the error. The stored report is dated, so a stale one reads as stale; an
  empty one would read as "nothing is mispriced", which is a lie.
- Requirement: when a correction is applied, the row's `note` records the
  source and fetch date, in the roster's established ` | `-joined dated-clause
  style. `suggestedNote` emits that clause ready to paste — emitted, not
  written.
- Three named mutants in `scripts/mutation-gate.mjs` hold the load-bearing
  invariants, each chosen because breaking it still produces a
  plausible-looking report: `price-provider-by-id-search-instead-of-lane`,
  `price-exclusions-checked-after-the-feed-lookup`, and
  `price-unpublished-cache-read-as-zero`.
- Out of scope: writing any price, changing `tier` or `enabled`, and modelling
  what a flat subscription actually costs per token.
