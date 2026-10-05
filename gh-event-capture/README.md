# gh-event-capture

A self-hosted store of GitHub webhook deliveries for a GitHub org.

Orgs on GitHub Free have no audit-log API: `GET /orgs/{org}/audit-log` returns `404` — there is
no forensic record of GitHub-side activity, not an empty one, none. This build accepts that gap
(`audit_log_posture` → `accept_plus_webhooks`) as a scoped partial substitute. No GitHub spend
is assumed.

---

## 1. Read this before you rely on it

**This is a monitoring aid. It is not forensic evidence.** Five properties are not covered, and
the difference is not academic. The first four are copied from § 5.1 of the engineering standard
so that the next reader learns them from the artifact rather than mid-incident. The fifth is not
in the standard — it was found in security review of this build and measured against these
modules.

**It can be switched off from inside the blast radius it watches.**
Unsubscribing the events or repointing the webhook URL requires `organization_administration`
— precisely the scope this capture exists to observe, and precisely the scope every agent token
carries today. An adversary who has what we are watching for can silence the watcher, and the
silencing is not itself recorded. `scripts/check-subscription.sh` *notices* drift on a schedule;
it cannot prevent it, and whoever can unsubscribe can also stop that cron.

**It captures no reads.**
No webhook fires when an installation token is minted, when a secret is read, or when a
repository is cloned. "Was the credential used?" stays **partly unanswerable even with this
running.** It tells you what was *changed*, never what was *seen*. Do not let anyone claim
otherwise once the endpoint is green.

**It captures no non-event org settings.**
Changing `default_repository_permission`, or turning the 2FA requirement on or off, produces no
webhook and will never appear in this store.

**A gap in the store is uninformative, never evidence of quiet.**
An empty week means the events were not subscribed, or the URL was repointed, or the Worker was
down, or nothing happened — and this store cannot tell you which. If an incident review turns on
what this store does or does not contain, that review has reached the edge of what the plan
supports, and the answer is to reason about scope and exposure window instead.

It also means **no adversary is required to create a gap**. The D1 allowance is shared with the
production `routeware-shadow-api` Worker on the same Cloudflare account, and the coupling runs both
ways: if that Worker exhausts the account's allowance, `store.append` throws, and `receive()` does
not wrap it. The error propagates, GitHub sees a `5xx`, and after 3 days of retries those
deliveries are gone for good. Capture does not degrade into a read-only store when the quota goes
— it stops, and what it leaves behind is an ordinary-looking gap. § 3 has the coupling.

**A row in it proves the secret was held, not that GitHub sent it.**
The signature proves possession of `WEBHOOK_SECRET`. Anyone holding that secret — which includes
anyone with Cloudflare account access — can write a correctly signed row asserting something that
never happened, and it will pass re-verification forever. Unlike a `DROP TRIGGER`, this leaves no
trace: the triggers stay intact and the row is indistinguishable from a real delivery. Append-only
then makes it permanent — a row known to be false cannot be retracted. Presence is evidence about
the secret, not about GitHub.

Measured, not theorised: a fabricated delivery naming a sender who did nothing was stored (`200`)
and passed § 7's own "Re-verifying the store" recipe unchanged. The other four properties above are
all about what this store fails to *contain*; this one is about what it can be made to contain
*falsely*, which is why it reads differently. § 7 carries the comparison against the `DROP TRIGGER`
path — writing false history is strictly cheaper than rewriting it — and the second edge of the
same root, where a pre-inserted `delivery_id` silently drops the genuine delivery.

Tamper-evidence is the one property GitHub Enterprise Cloud has that self-hosted capture
structurally cannot. We knowingly did not buy it.

### What it *is* good for

One thing above all: the installation holds `repository_selection: all` across every repo in the
org, so a newly created repository joins the org-admin installation **silently and with no
notification** — the blast-radius growth otherwise only findable by after-the-fact measurement.
An `installation_repositories` delivery announces that transition as it happens.

```bash
./scripts/query.sh joins
```

That, on its own, is worth more against our actual threat model than the audit log would have
been.

---

## 2. Status

| Gate | State |
|---|---|
| 0 — a publicly reachable HTTPS endpoint | **platform confirmed, deploy credential missing.** See § 3. |
| 1 — receiver + durable append-only store | **built**, this directory |
| 2 — a way to query it | **built** — `GET /events`, `GET /stats`, `scripts/query.sh` |
| 3 — an unsigned payload proven rejected | **proven** in `test/capture.test.mjs` and over a real socket in `test/test_verify_deployment.sh`; both suites are proven able to fail. `scripts/verify-deployment.sh` re-proves it against the live URL once § 4 is done. |
| 4 — register the webhook, subscribe the events | **owner action**, not yet done — § 5 |

Until gate 4 completes, `expected-subscription.json` has an empty `hook_url` and
`scripts/check-subscription.sh` exits `2` (PENDING). That is the correct state, not a fault.

---

## 3. Gate 0 — where this can actually run

The org already operates a **Cloudflare Workers account in production**: account
`209cf7dd678adfb683947dd7874d05af`, which serves the `routeware-shadow-api` Worker with D1, R2
and Durable Objects. So the prerequisite is not missing infrastructure. A Worker gives a real,
durable, publicly reachable HTTPS origin on a hostname that survives a process restart — not a
tunnel that dies with an agent run.

**What is missing is a deploy credential.** No `CLOUDFLARE_API_TOKEN` exists in any agent
environment, and `routeware-shadow-api` has its own CI deploy job switched off for exactly this
reason (see that repo's `docs/HANDOVER.md` § 0). So the deploy in § 4 is an **operator action**,
which is also how this whole repo works: agents propose, the operator applies.

Marginal cost is zero — the account is already paid for, and this Worker adds no cron, no
Durable Object and no browser binding. It does consume that account's D1 quota.

**That sharing runs both ways, and the return direction is the one that bites.** This Worker
drawing on the shared allowance is the documented half. The undocumented half was that
`routeware-shadow-api` exhausting the same allowance makes `store.append` throw here — and
`receive()` does not wrap the append, so the throw becomes a `5xx` to GitHub and capture stops on
live deliveries. Measured against the real module. GitHub retries for 3 days and then drops them,
so a quota incident on an unrelated service silently costs this store real history. § 1 records it
next to "a gap in the store is uninformative", because that is what it produces: a gap that looks
exactly like quiet.

---

## 4. Deploy (operator) — capture-only setup

This section installs **only** the capture Worker and its D1 store. It does not
install any product-runtime consumer, timer, board key, or subscription beyond
the seven capture events in § 5. The combined capture + product-only consumer
install is `OPERATOR-RECIPE.md` — the one combined operator recipe — and nothing
here authorizes or performs it. Do not mix this section's commands with
product-runtime inputs. Both paths keep secret values in private files, never
stdout or argv. This initial-capture setup generates keys; the combined runtime
recipe reuses the existing capture secrets and does not authorize their rotation.

Use only the approved pinned Wrangler executable at a recorded version. Do not
run bare `npx wrangler`: that downloads an unpinned deployment CLI and is not
an approved deploy path. The `npm run migrate` / `npm run deploy` scripts invoke
a bare `wrangler` from `PATH`, so the operator invokes the pinned binary
directly with the same arguments instead. Work from a private shell with tracing
off.

```bash
set -euo pipefail
set +x
umask 077
WRANGLER=/absolute/path/to/approved/pinned/wrangler
test -x "$WRANGLER"
cd gh-event-capture

# 1. Create the database and paste the id into wrangler.toml.
"$WRANGLER" d1 create gh-event-capture
#    -> database_id = "..."   replace REPLACE_WITH_D1_DATABASE_ID

# 2. Create the schema. This is what makes the store append-only.
"$WRANGLER" d1 migrations apply gh-event-capture --remote

# 3. Two secrets. Both must be set or the Worker fails closed with 503.
#    WEBHOOK_SECRET must be byte-identical to the secret entered in the App
#    settings UI at gate 4. Generate each secret once, directly into a private
#    0600 file — never to stdout, argv, or a committed file — and load it into
#    the Worker via stdin. Do not print, echo, or cat key values to a shared log.
umask 077
PRIVATE="$HOME/credential-drop/gh-event-capture"
for directory in "$HOME/credential-drop" "$PRIVATE"; do
  if test ! -e "$directory" && test ! -L "$directory"; then mkdir -m 700 "$directory"; fi
  test -d "$directory" && test ! -L "$directory"
  test "$(stat -c '%a %u' "$directory")" = "700 $UID"
done
test ! -e "$PRIVATE/WEBHOOK_SECRET" && test ! -L "$PRIVATE/WEBHOOK_SECRET"
test ! -e "$PRIVATE/QUERY_TOKEN" && test ! -L "$PRIVATE/QUERY_TOKEN"
openssl rand -hex 32 > "$PRIVATE/WEBHOOK_SECRET"
openssl rand -hex 32 > "$PRIVATE/QUERY_TOKEN"
chmod 600 "$PRIVATE/WEBHOOK_SECRET" "$PRIVATE/QUERY_TOKEN"
test "$(stat -c '%a %u' "$PRIVATE/WEBHOOK_SECRET")" = "600 $UID"
test "$(stat -c '%a %u' "$PRIVATE/QUERY_TOKEN")" = "600 $UID"
"$WRANGLER" secret put WEBHOOK_SECRET < "$PRIVATE/WEBHOOK_SECRET"
"$WRANGLER" secret put QUERY_TOKEN < "$PRIVATE/QUERY_TOKEN"

# 4. Deploy, then confirm it is up and configured.
"$WRANGLER" deploy
curl -s https://gh-event-capture.REPLACE_SUBDOMAIN.workers.dev/health
#    { "ok": true, "webhook_secret_configured": true, "query_token_configured": true }
```

**Deploy before registering the webhook, never after.** GitHub keeps delivery history for **3
days only**, so anything delivered before the store exists is simply gone — there is no backfill
and GitHub's own delivery log is a debugging backstop, never the record.

### 4a. Prove the deployment, before gate 4

The suite proves the *logic*. It cannot prove that **this deployment** holds the right secret,
reached the right D1 database, or is even the code you think it is — which are the ways a deploy
goes quietly wrong. Run the verifier against the live URL:

The verifier takes secrets only from its process environment, never argv
(`verify-deployment.sh` refuses secret arguments because `/proc` cmdlines are
world-readable). Do not `export` secrets into a persistent shell and do not
paste key values into the command line. Pass the § 4 private files as a
one-shot environment for that process only:

```bash
set -euo pipefail
set +x
PRIVATE="$HOME/credential-drop/gh-event-capture"
for secret in QUERY_TOKEN WEBHOOK_SECRET; do
  test -f "$PRIVATE/$secret" && test ! -L "$PRIVATE/$secret"
  test "$(stat -c '%a %u' "$PRIVATE/$secret")" = "600 $UID"
done
GH_CAPTURE_URL=https://gh-event-capture.REPLACE_SUBDOMAIN.workers.dev \
GH_CAPTURE_TOKEN="$(cat "$PRIVATE/QUERY_TOKEN")" \
GH_CAPTURE_SECRET="$(cat "$PRIVATE/WEBHOOK_SECRET")" \
  ./scripts/verify-deployment.sh          # exit 0 = ready for gate 4
```

It checks, against the real endpoint: health reports both secrets set; unsigned, malformed,
wrong-secret and tampered-body deliveries are all `401`; the read API is closed without a token
and an unknown filter is `400`; a correctly signed delivery is **stored** and readable back; a
replay is de-duplicated and still `200`; and the rejection counters moved. **Exit status is the
gate** — it never prints a warning and exits 0. If anything fails, do not register the webhook:
GitHub keeps 3 days of history and there is nothing to replay from.

**It writes one permanent row.** The store is append-only by trigger, so the signed probe cannot
be deleted afterwards — that is the append-only property working, not a defect. Probe rows carry
event `x_capture_probe` and are easy to exclude:

```bash
./scripts/query.sh events event=x_capture_probe
```

Re-run it any time with `--no-probe`, which runs every refusal check and writes nothing.

---

## 5. Gate 4 — register the webhook (owner only)

Event subscriptions **cannot be set through the API**. They are App settings UI, and App
`4685085` is owner-owned. In *Settings → Developer settings → GitHub Apps → togetherweown*:

1. **Webhook → Active**, URL `https://gh-event-capture.REPLACE_SUBDOMAIN.workers.dev/gh/webhook`,
   secret = the `WEBHOOK_SECRET` from § 4 step 3.
2. **Subscribe to events** — exactly these seven:

   `push` · `repository` · `member` · `membership` · `organization` · `installation` ·
   `installation_repositories`

   The first six are the scoped set. **`installation_repositories` is the
   one addition**, and it is the one that carries the whole rationale: a repository joining or
   leaving the org-admin installation arrives on `installation_repositories`, *not* on
   `installation` (which covers the installation itself being created, deleted, suspended or
   unsuspended). Subscribing `installation` alone would miss the exact transition this issue was
   filed to catch.

   Anything beyond these seven is a widening. Flag it on the issue first and update
   `expected-subscription.json` in the same change, or the drift check goes red on a legitimate
   subscription.
3. Then close the loop:
   ```bash
   # paste the live URL into expected-subscription.json -> "hook_url"
   ./scripts/check-subscription.sh        # 0 = live and matching
   ./scripts/query.sh events event=ping   # GitHub sends a ping on registration
   ```
4. Put `check-subscription.sh` on the operator's cron. Its whole value is that it runs
   unattended; run by hand only, and it will be run the day after someone needed it.

   ```cron
   # hourly; mail non-zero exits to the operator. Exit 1 = DRIFT, 2 = PENDING, 3 = broken.
   17 * * * * cd /path/to/gh-event-capture && ./scripts/check-subscription.sh
   ```

   **Check the exit status of the first cron-fired run, not just a run in your own shell.**
   A by-hand run inherits your PATH; cron gives it `PATH=/usr/bin:/bin`. The script resolves
   `node` itself precisely so that difference cannot kill it — it used to exit `3` every hour
   under cron while exiting `2` and looking healthy by hand, which is the failure mode this
   whole check exists to avoid: a control that is not running, reported as one that is. If
   node lives somewhere unusual on the VPS, set `NODE_BIN=/path/to/node` in the crontab rather
   than editing cron's `PATH`. `test/test_scripts.sh` holds the cron-PATH regression case.

---

## 6. Querying

```bash
set -euo pipefail
set +x
export GH_CAPTURE_URL=https://gh-event-capture.REPLACE_SUBDOMAIN.workers.dev
PRIVATE="$HOME/credential-drop/gh-event-capture"
test -f "$PRIVATE/QUERY_TOKEN" && test ! -L "$PRIVATE/QUERY_TOKEN"
test "$(stat -c '%a %u' "$PRIVATE/QUERY_TOKEN")" = "600 $UID"
capture_query() {
  GH_CAPTURE_TOKEN="$(cat "$PRIVATE/QUERY_TOKEN")" ./scripts/query.sh "$@"
}
capture_query stats
capture_query events repository=TogetherWeOwn/kofra limit=20
capture_query events event=member action=added since=2026-08-01
capture_query joins                      # repos entering/leaving the installation
capture_query get REPLACE_WITH_DELIVERY_ID   # one delivery, raw body included
```

Filters: `event` `action` `repository` `sender` `organization` `delivery_id` `since` `until`
`limit` `cursor` `include_body`. **An unknown filter is a 400, not a silent ignore** — a typo'd
filter that gets dropped returns *more* rows than you asked for, and that reads like "nothing
was excluded", which is a wrong answer wearing the shape of a right one.

Paging is by keyset: pass `next_cursor` back as `cursor=`. `OFFSET` would shift underneath a
delivery arriving mid-page, and this store is written to while it is read.

### What this does not tell you

`GET /health` returning 200 means **this service is up**. It does not mean events are arriving,
and it is not evidence that the App is still subscribed. It deliberately reports no counts and
no timestamps, so that nothing about it can be read as "all quiet". The only thing that speaks
to subscription liveness is `scripts/check-subscription.sh`, and § 1 states what that can and
cannot do.

**What it does tell anyone who asks: whether this receiver is armed.** `/health` is
unauthenticated and `webhook_secret_configured: false` says plainly to the whole internet that the
org's GitHub event capture is currently blind — a timing signal for anyone who would rather act
unobserved. This is stated rather than fixed, and the reason is that gating those two fields behind
`QUERY_TOKEN` would not close the channel, only the readable one. The same fact is available two
other ways to the same anonymous caller, both of them load-bearing fail-closed behaviour we are not
going to make ambiguous:

```
POST /gh/webhook   ->  503 {"reason":"secret_unconfigured"}   vs  401 unauthorized when armed
GET  /events       ->  503 query API is not configured        vs  401 unauthorized when armed
```

So the honest position is that arming state is public, not that it is protected. The exposure
window is deploy → gate 4, § 4 has the operator read exactly these fields to confirm a deploy
landed, and that is a real need worth the disclosure. If that trade ever stops being acceptable,
the fix is all three responses at once, not the one that is easiest to see.

---

## Bridge primitives (not a deployed consumer)

`src/bridge.js` classifies PR and check-suite events. It does not write to Paperclip,
check issue eligibility, reconcile reviews, backfill PRs, or install a timer. Those
consumer responsibilities remain unfinished; these primitives alone do not satisfy
the capture/parity metrics. The subscription baseline is intentionally unchanged
until the App actually subscribes to `pull_request` and `check_suite`.

`classifyCheckSuiteEvent(payload, resolvedPullRequests)` needs full PR records from
GitHub or verified stored PR events. Records must match repository, PR number and head
SHA and have author `togetherweown[bot]`. Slim suite PR references lack an author;
without matching records the classifier returns no candidates. The consumer must
resolve missing records before advancing its cursor, not silently discard the event.

PR decisions emit Paperclip lifecycle statuses: `active` for an open non-draft PR,
`draft` for an open draft PR, and `merged`/`closed` on close. They always omit
`reviewState`: neither drafting nor merging establishes an aggregate review verdict.
The consumer must obtain authoritative reviews and map them to Paperclip's
`none`/`needs_board_review`/`approved`/`changes_requested` contract. Omission is not an
instruction to reset an existing verdict. GitHub's `open` and `draft` are not valid
Paperclip status and review-state values, respectively.

### Claim contract

`POST /bridge/claim` uses the same bearer token as `/events`. All bodies require
`issue_ref`, `kind`, and a nonempty `delivery_id` (the stored GitHub delivery ID).

- Wake kinds: `check_suite_completed` and `pull_request_merged`. A nonempty `head_sha`
  is required. Their key is `(issue, head SHA, kind)`, independent of delivery ID,
  so multiple suites/retries for the same head cannot send duplicate wakes.
- Work-product kinds: `work_product_create` and `work_product_update`. Also require
  `pr_url` and `action`; `head_sha` may be null. The key is the JSON tuple
  `["work_product", issue, head SHA, kind, PR URL, action, delivery ID]`. Different
  PRs, repeated edits and close/reopen transitions must not consume each other's claims.
- A merged PR requires **two independent claims**: one for its product update and
  one with kind `pull_request_merged` for its wake. Never gate the wake on obtaining
  the product-update claim. Check blocked/done/pending-human eligibility before waking.
- The route loads `delivery_id` from the immutable store and reclassifies its body;
  caller fields select an effect, never establish one. Missing deliveries return 404.
  Truncated/malformed bodies, unrelated events, unknown kinds and mismatched effect
  identities return 400 **before insertion**, leaving the genuine claim available.
- Suite claims also require `pr_delivery_id`: a stored, complete `pull_request` delivery
  proving bot author, repository, PR number, issue reference and the suite's exact head.
  A slim suite reference or caller-supplied GitHub object alone cannot claim a wake.
  Missing author evidence is a retriable prerequisite, not permission to drop an event
  or advance the consumer cursor. This unshipped route cannot yet claim suite wakes
  for PRs known only through backfill/GitHub reads; the consumer must arrange verified
  evidence rather than manufacture a delivery ID.
- HTTP 200 with `claimed: false` is a duplicate, not permission to perform the effect
  again. Claim verification happens even on retries.
- `GET /bridge/claims` accepts only `issue_ref` and `limit` (default 50, range 1–500).
  Unknown/duplicate parameters, malformed values and out-of-range limits return 400;
  there is no silent clamp or unscoped fallback. `/events` shares the strict limit and
  parameter validation helpers.

This tightens the initial, unshipped work-product claim contract. Existing wake keys
retain their encoding; old work-product clients without PR/action identity fail closed.
The `claim_key` column needs no schema change. Both HTTP and module callers use the
same key function, so they cannot disagree on collision boundaries.

### What a missed wake looks like

A claim records **intent**, not proof of a successful board write. The append-only
ledger deliberately chooses at-most-once: a crash after claim but before comment may
lose a wake. Replaying that claim must not post again. Inspect the board audit trail
and delivery together before an explicit recovery action; never delete claims to retry.
Work-product recovery should reconcile authoritative PR state rather than infer success
from a claim. `query.sh bridged-daily` counts claims in its bounded 500-row window, not
verified deliveries or a complete historical metric. Transport failures exit nonzero
and never print partial response bodies as successful query output.

### Consumer core (offline contract, not an installed service)

`src/consumer.js` exports `createConsumer({github, board, capture,
allowedRepositories, mode})` with `processDelivery(row)` and `backfill(references)`.
The adapters are injected. `src/github-adapter.js` implements GitHub reads through
`gh`; `src/capture-adapter.js` supplies bounded capture reads and wake claims;
`src/paperclip-adapter.js` supplies non-waking product operations only.
`test/consumer.test.mjs` exercises the real capture routes using signed fixtures
and **contract doubles** for GitHub and Paperclip; green is not deployment evidence.

**Staged scope decision:** the CTO authorized PR work-product
and review-state synchronization without wakes. Set `mode: 'products-only-v1'`
explicitly. PR and suite deliveries reconcile current authenticated GitHub PR state
and return `disabled-by-policy` wake outcomes. They never read wake eligibility,
look up stored author evidence for a wake, claim D1 intent, or post a comment. Bot
identity, repository scope and issue binding are still checked against current
GitHub state. All issue statuses may receive product updates; no issue lifecycle
is changed. Backfill remains non-waking. Unknown modes fail at construction.
The default `full-v1` preserves the original gated behavior for offline tests; it
is **not** a deployable mode with the product-only Paperclip adapter.

The original wake requirement and CI-poll reduction from 33/day to fewer than 10
remain **deferred, not completed**. Resumption requires a supported
atomic capability; upstream work stays parked under the pause. Product-only success must never be reported
as full bridge acceptance or wake delivery.

The core reconciles the **current** GitHub PR, not the webhook snapshot. The
GitHub adapter must return a consistent current REST-style PR plus authoritative
GraphQL `reviewDecision`: explicit null → `none`, `REVIEW_REQUIRED` →
`needs_board_review`, `APPROVED` → `approved`, `CHANGES_REQUESTED` →
`changes_requested`. Missing or unknown decisions fail before a board write.
Adapters must reject partial/paginated responses presented as complete lists and
must bind the review decision to the same PR/head as the lifecycle snapshot.

Product writes are replayable: the core adopts the canonical `${repo}#${number}`
external ID or an existing exact-URL row, rejects ambiguous duplicates, and
preserves unrelated metadata. A lost create response can be retried without
intentionally creating a second row. This depends on serialized execution and
fresh complete product lists; the runner must hold an exclusive process lock.
This is not a cross-writer uniqueness guarantee. Backfill makes no synthetic
deliveries, claims, or wakes. PR issue-binding changes reconcile the current
issue; migration/cleanup of an old issue's row is not implemented.

Wake claims remain at-most-once per issue/head/kind. Stale heads or changed issue
bindings never wake. Before and after claiming, only assigned-agent cards in
`todo`/`in_progress`/`in_review`, with all blockers done and no pending interaction,
are eligible. Incomplete eligibility responses fail closed. A failure leaves the
caller's input cursor unadvanced; claimed wakes are nevertheless never replayed.

**Live wake transport gate:** `board.commentIfEligible(id, body)` must atomically
check eligibility and post, returning `{sent: false}` if eligibility changed or
`{sent: true, comment: {id}}` on success. A plain board-auth
`POST /api/issues/{id}/comments` is **not** a valid implementation. Installed
Paperclip source inspected on 2026-09-21 (`server/src/routes/issues.ts`,
`shouldImplicitlyMoveCommentedIssueToTodo` and the comment route) can implicitly
move user-authored comments on blocked/closed assigned cards back to `todo`.
`reopen: false` / `resume: false` do not disable that behavior. Two client reads
cannot close this race. No supported atomic transport has yet been established;
without one the core refuses before claiming. Do not bypass this gate with direct
DB writes, a borrowed agent identity, or an unapproved host/server patch.

Remaining before staged installation: live transport validation; durable one-shot
open-PR backfill and periodic review reconciliation around the single-pass event
runner below;
60-second user timer; 30-day board-key renewal and two-missed-firing alert; the single
Operator subscription/install card; merged artifacts and live Worker/timer evidence.
A missing stored PR author-evidence delivery is a retry prerequisite, not permission
to discard a suite. Capture `/events` pagination is descending `(received_ms,
delivery_id)`, with inclusive `since`/`until` bounds and an exclusive older-than
cursor, not an ascending append sequence. Do not treat a saved maximum timestamp
as proof every earlier delivery was consumed: concurrent/late inserts can fall
behind an already-read boundary. The receipt cycle below therefore repeats full
bounded scans rather than advancing a timestamp. No timer, subscriptions, baseline,
secrets, or deployment are changed by this core. The 7-day acceptance metrics remain
unmeasured.

### Durable receipts and serialized delivery cycle (not a service)

`src/receipt-store.js` supplies `withReceiptStore({directory, namespace}, callback)`;
`src/receipt-cycle.js` supplies `receiptNamespace(config)` and
`runReceiptCycle({capture, consumer, receipts, allowedRepositories})`. The callback
must hold the store lock throughout **all** external effects. The product-only runner
constructs the namespace from the actual capture origin, board origin, company
ID, exact repository allowlist and processing mode (`full-v1` or `products-only-v1`).
Pass the same mode to the core and receipt cycle; mismatches refuse before scans.
Changing any namespace input refuses existing state; do not silently reset it or
reuse receipts for a different processing policy. Full-mode outcomes never accept
`disabled-by-policy`; product-mode outcomes never assert `sent`. A future transition
to full mode needs an explicit replay/migration policy, not relabelled receipts.

Each pass completes PR and suite metadata scans for every configured repository,
without a time lower bound. It then processes unreceipted delivery IDs oldest-first,
serially, checking metadata/body identity and full-body SHA-256 before effects.
A confirmed core outcome is persisted **after**, never before, processing. Failed
reads, missing evidence, incomplete results and transport failures remain pending
and are tried once on a later pass. Other candidates can proceed within the same
budget. Reopening the store skips successful IDs, not everything before a timestamp;
a late insert behind a traversed page boundary is discoverable on a subsequent full
scan. Scans are not transactional snapshots, nor proof that webhooks were captured.

The default effect budget is 100 deliveries/pass. `ok: false` reports failures or
deferred work; a CLI must treat this as incomplete/non-success, not a healthy tick.
Scan, receipt-capacity and persistence failures throw. Storage failure stops the
pass before further external effects. Only validated delivery IDs and fixed stage
labels enter failure reports; state holds ID/fingerprint pairs, no payloads,
credentials or raw errors. The existing capture page budget remains loud: exceeding
it aborts before effects, never moves a checkpoint. This all-history design is a
bounded correctness baseline, **not a scalable incremental feed**. Metadata scan
cost grows with history; many permanently failing old events can consume the effect
budget and defer later events. Before production, set/test budgets against actual
volume and define repair/alert handling; do not fix budget pressure with a timestamp
cutoff, silent receipt eviction or unbounded retry loop.

The state directory must be owned by the service user and private (0700), on a
local Linux filesystem with atomic rename and file/directory fsync support. State
files are 0600. Every new receipt rewrites a bounded snapshot via a synced temporary
file, atomic rename and directory sync. Default limits are 100,000 receipts and
16 MiB; there is no automatic pruning. The directory's parent must already exist
and be trusted. Symlinked state/directory, corrupt state, scope/version changes,
duplicate IDs and changed fingerprints fail closed; no automatic reset. This
protects against accidental concurrent consumers, not a malicious same-user writer.

An exclusive `lock` directory is held across reads, writes and the entire callback.
Normal errors release it; a process crash leaves it in place. **No PID/age-based
stale-lock stealing.** Recovery requires the operator to stop the timer/service,
prove no consumer owns this state directory, inspect the state and any
`.receipts-*.tmp` remnants, then remove only the stale lock and unused temporary
files. Never delete receipts or D1 claims to retry. Do not install multiple state
directories for the same consumer scope; local locking does not serialize them.
A crash before the receipt may replay product reconciliation. A crash after a D1
wake claim can still lose that wake: replay sees the existing claim, not permission
to send again. A receipt means a confirmed terminal **processing outcome**, which
can be suppression or duplicate intent; it is not proof of comment delivery.

`test/receipt-cycle.test.mjs` covers reopening, late/tied timestamps, missing evidence,
ambiguous effects, capacity/corruption, cross-process locking and abrupt process exit,
plus real signed capture + consumer integration with a contract-double board. These
are offline filesystem/route tests, not live host or power-loss verification.
The event-pass CLI below supplies shared transport/time budgets. Periodic review
reconciliation, durable backfill completion, monitoring/alerts and live deployment
remain unfinished.

An architecture assessment found **no supported atomic wake
operation** in installed Paperclip and recommended a work-product-only alternative.
That recommendation does not satisfy the original wake requirement or authorize a
plain-comment fallback. The full-mode core remains gated; no wake transport or
scope relaxation is introduced by these receipts.

### Single-pass product-only runner (not installed)

`src/consumer-cli.js` now wires the real capture/GitHub/Paperclip adapters, explicit
product-only core, scoped receipt namespace and exclusive receipt lock. It runs
**one event pass and exits**; it does not backfill or periodically refresh reviews.
Do not install this event-only slice as the complete bridge service. The next slice
must add durable backfill/review scheduling under the same serialization boundary,
then timer/health/alert packaging and the one Operator handoff. No host changes,
subscription changes or production credential reads have been performed here.

Linux/Node 22+ invocation once the host prerequisites are authorized and installed:

```sh
node gh-event-capture/src/consumer-cli.js events /absolute/private/config.json
```

Only a command and config **path** go in argv. The configuration is a private JSON
file, owned by the service user, containing paths rather than secret values. Example
shape (substitute the real origins and absolute service-user paths at installation):

```json
{
  "version": 1,
  "mode": "products-only-v1",
  "captureOrigin": "https://capture.example.net",
  "boardOrigin": "http://127.0.0.1:3100",
  "companyId": "12345678-1234-4234-8234-123456789abc",
  "allowedRepositories": ["ExampleOrg/example-tooling"],
  "stateDirectory": "/absolute/private/bridge-state",
  "captureTokenFile": "/absolute/credential-drop/capture-query.key",
  "boardTokenFile": "/absolute/credential-drop/bridge-board.key",
  "limits": {"durationMs": 45000, "maxRequests": 300, "maxDeliveries": 100,
    "pageSize": 100, "maxPages": 100, "maxReceipts": 100000,
    "maxReceiptBytes": 16777216, "maxSweepItems": 50, "maxSweepAttempts": 5,
    "reviewIntervalMs": 600000}
}
```

The state parent must exist and be trusted. Config and key files must be regular,
user-owned, with no group/other permissions; final-component symlinks are refused.
Their parent paths must also be trusted (same-user attackers are out of scope).
Config is capped at 64 KiB; each key at 16 KiB, allowing one trailing newline. Config
and keys cannot reside inside the state directory. Unknown config/limit fields and
any mode other than `products-only-v1` reject; there is no full-mode CLI switch.
Credentials are reread per invocation, not cached across firings. `PAPERCLIP_API_KEY`
is never used as a host board key. `PAPERCLIP_RUN_ID`, if present during an authorized
agent invocation, is used only for the board mutation audit header; a host invocation
without it does not invent one. `gh` uses the installed credential path, not token
arguments. Live host authentication is still an installation gate.

One shared request budget counts capture HTTP calls (including every page and body),
board HTTP calls, and `gh` invocations. It counts transport operations, **not** hidden
broker requests or internal `gh` HTTP exchanges. Defaults: 300 operations, 45 seconds,
100 event attempts, 100 rows/page, 100 pages/stream, 100,000 receipts and 16 MiB of
receipt state. All overrides have hard maxima (`runnerLimits`); capacity exhaustion
is non-success, not permission to truncate a scan, discard receipts or widen scope.

The monotonic deadline covers the locked pass, HTTP headers/bodies and child calls.
Cancellation on SIGINT/SIGTERM aborts in-flight transports; no new transport starts
after a stop. Child execution uses SIGKILL on timeout/abort and waits for `close`,
not only `execFile`'s early abort callback. There is no `Promise.race` that releases
the lock while work continues. Already accepted remote writes may still complete
following cancellation: without a receipt, the next pass reconciles them. Local
filesystem operations and draining transport/child closure are awaited; this is a
cooperative I/O deadline, **not a hard wall-clock limit on the whole process** or a
process-tree sandbox. The future service must supply an outer stop timeout and
cgroup cleanup; forced exit leaves the conservative lock-recovery procedure above.

Output is one JSON result: `ok`, fixed `mode`/`reason`, operation count and, when
available, the event-cycle counters/failure IDs. Provider text, credential paths,
raw errors and payloads never enter CLI error output. Exit 0 means this bounded
scan processed everything it observed; exit 1 means failed/incomplete/cancelled;
exit 2 means usage error. A stopped pass may have durable successes even when its
aggregate event result is null. Replay consults receipts, not this output. This is
not a backfill, global health, review freshness or seven-day acceptance assertion.

`test/consumer-runner.test.mjs` covers real adapter/core/capture/receipt wiring with
fake GitHub/board transports, exact request limits, deferral, ambiguous-create
recovery, header/body deadlines, child cancellation and real child reaping,
pre-cancellation, overlapping runs, private configuration, CLI exit codes and
redaction. These tests make no live network calls or deployment claims.

### Paperclip product-only transport

`createPaperclipAdapter({baseUrl, token, companyId, allowedRepositories, runId?})`
exposes only `getIssue`, `listWorkProducts`, `createWorkProduct`, and
`updateWorkProduct`. No comment, wakeup, issue mutation or eligibility method exists.
HTTPS origins and loopback HTTP origins are accepted, without credentials, path,
query or fragment. Supply a dedicated authorized board key from protected host
configuration, never argv or a checked-in file. Do not reuse ephemeral run credentials
for a host service. When used under an authorized agent run, supply that run's UUID
for the mutation audit header; host board-key operation does not invent a run ID.
Real host board-key permission and expiration checks remain installation gates.

Each request refuses redirects/cookies, has a 30-second header/body deadline, and
limits actual streamed JSON to 4 MiB. Configuration allows smaller/larger bounded
budgets. Error bodies, causes and credential values are not exposed, and writes
are not retried internally. A lost create response is recovered by a subsequent
complete product list through the serialized core, not an immediate blind POST.

Issue lookups require a TOG reference or UUID and verify returned identifier/UUID
and configured company. Writes require a previously resolved issue; updates also
require a GitHub PR row discovered in that issue's list (or created in this adapter).
Lists validate every row's company, issue, identity, enums and metadata shape, reject
duplicates and clear obsolete update bindings on refresh. The installed list API is
a complete bare array with no pagination/cap; an unknown envelope is an error, not
an empty list. An explicit 10,000-product budget and the body-byte budget fail loud.
There is no 100-row truncation. Writes whitelist product fields, validate canonical
GitHub URL/external ID/repository/head, and verify the returned product and echoes.
These are client-side containment checks, not a substitute for server authorization
or a global uniqueness/transaction guarantee across other writers.

Source contract inspected 2026-09-22: `server/src/routes/issues.ts` issue GET around
8828, product list 9589, create 10637 and update 11062; `services/work-products.ts`
`listForIssue` 179–203 has no limit; shared `validators/work-product.ts` 81–105.
Product writes log activity and may cancel stale active source-recovery actions,
but those routes do not enqueue agent wakes. No `refreshPullRequests` query is used.
Tests cover route/field containment, company/repository mismatch, complete lists,
redaction/deadlines, lost-create recovery with the real core, and an actual loopback
HTTP socket backed by a contract double. They do **not** prove live board deployment
or that a future server revision preserves this non-waking contract.

### Capture transport adapter

`createCaptureAdapter({baseUrl, queryToken, allowedRepositories})` accepts an HTTPS
origin (no embedded credentials, URL path, query or fragment). The caller supplies
the query token from its authorized secret source; the adapter never loads it from
argv or prints it. Requests refuse redirects, use no ambient cookies, and enforce
a 30-second deadline through body consumption plus a streamed 4-MiB byte limit.
HTTP errors, partial successes, malformed/non-JSON bodies and incomplete transfers
throw sanitized errors without response contents or causal exceptions. Requests
are not retried, including ambiguous claim writes. Both limits are configurable
within bounded ranges; the runner still needs a whole-cycle request/time budget.

- `listDeliveries({repository, event, sinceMs?, untilMs?})` returns **metadata**, not
  bodies. Only `pull_request`/`check_suite` and allowlisted repositories are allowed.
  Unknown filters fail, not silently broaden. The scan follows every descending
  cursor page, validates ordering/IDs/filter bounds, and returns only after the
  terminal page. An exactly full final page requires one extra empty-page request.
  Defaults: 50 rows/page, 100 pages/scan. Exceeding the budget is an error, never a
  partial success. This is pagination, **not** a durable receipt/checkpoint policy.
- `getDelivery(id)` returns the complete row and validates ID, repository, event,
  body and JSON shape. Truncated rows fail; re-fetching cannot repair capture-time
  truncation. Supported delivery IDs are 1–128 ASCII letters/digits or `._:-`,
  covering GitHub UUIDs and the capture cursor contract.
- `getPullRequestDelivery(repo, number, sha)` walks stored PR metadata and resolves
  bodies newest-first for exact repository/number/head/bot evidence. The API has no
  PR-number filter: this can require many reads. A future runner may cache verified
  evidence, but must not invent it or silently advance when missing. An unreadable
  candidate fails the lookup; null means no matching evidence in the completed scan.
- `claim(body)` supports wake claims only. It re-reads source/evidence scope before
  POST; the real claim route validates the effect against stored signed bodies.
  Only a matching key and explicit boolean outcome confirm the write. A failed or
  lost response is not retried automatically; replay may find the intent already
  claimed, so wake delivery is still at-most-once, not guaranteed exactly-once.

`test/capture-adapter.test.mjs` drives real capture routes and the consumer using
signed events, streamed response failures and a fake board. It tests deadlines,
byte/page budgets, equal timestamps, evidence mismatches and lost claim responses.
It does not exercise live Cloudflare/D1 or install the missing atomic board gate.
All scans restart at the newest page; concurrent/late arrivals still need the
runner's durable replay strategy. Do not substitute timestamp high-water marks.

### GitHub read adapter

`createGithubAdapter({allowedRepositories})` supplies `getPullRequest(repo, number)`
and `listOpenPullRequests(repo)`. The former fetches author, head, lifecycle, text
and `reviewDecision` in **one GraphQL query**, then normalizes to the core's
REST-style shape. This avoids joining separately timed REST and review requests;
it does not claim GitHub offers a transactional snapshot or prevent a later push.
Only a GraphQL `Bot` actor can acquire the REST `[bot]` suffix. Deleted authors
remain null and are ignored by the core. Missing/unknown verdicts or inconsistent
identity/lifecycle fields fail closed, including HTTP-200 partial GraphQL errors.

Open-PR enumeration follows cursor pages in creation order without a 100-result
cap. It returns references only after the final page and validates counts,
duplicate identities and cursor progress. Its configurable `maxPages` (default
100) is a request budget, not truncation: exhausting it throws. Changing counts
also throws; the runner must retry the entire scan rather than mark backfill done.
GitHub pagination is not a global snapshot: equal-count concurrent membership
changes may still be undetectable. Event reconciliation and subsequent full scans
are required; enumeration alone is not evidence of complete capture.

The adapter calls `gh api --hostname github.com graphql` via shell-free `execFile`,
with separate argv values, a 30-second request timeout and a 4-MiB output limit.
It uses the installed `gh` credential path; it does not mint/export a token, place
credentials in argv, or retain subprocess stdout/stderr in errors. Failures do
not retry or poll. The future host installation must supply authorized `gh`
authentication independently of ephemeral run credentials. At runtime the wrapper
is resolved by absolute path — `$SECURE/bin/gh` beside `consumer.json` — never
through `PATH` (`src/runtime-github.js` pins it; preflight, init and every run
refuse unless the directories are canonical user-owned private directories and
the wrapper is a user-owned private regular executable). Both unattended
credentials are refused in JWT shape (three dot-separated segments). Tests use
injected responses plus an actual local child-process test; no live GitHub
credentials or CI polling are involved. Live permission/schema validation remains
outstanding.

## 7. How it is built

```
src/verify.js           X-Hub-Signature-256, HMAC-SHA256, constant-time compare
src/record.js           verified delivery -> stored row; truncation with a full-body digest
src/query.js            strict query-string parsing (unknown parameter = 400)
src/rejection-counter.js coalescing buffer, so anonymous traffic cannot become D1 write volume
src/store-d1.js         Cloudflare D1 adapter — the durable store
src/store-memory.js     test double with the same observable semantics
src/app.js              routing and policy; runtime-agnostic
src/worker.js           Cloudflare entry point; binds D1 and returns app(request)
migrations/d1/          schema, indexes, and the append-only triggers
```

Zero runtime dependencies. Nothing is installed to run the tests.

**Signature verification is not optional and there is no bypass.** The URL is public by
construction — GitHub has to reach it, so anyone can. Every path that does not end in a verified
signature ends in a rejection, including "no secret configured", which is a `503` and never a
stored row. A store containing one forged row is worse than an empty store, because the empty
one does not mislead anyone.

**De-duplication** is the `delivery_id` primary key. GitHub retries anything it did not see a
`2xx` for, reusing the same `X-GitHub-Delivery`, so a retry is normal traffic: it changes
nothing, does not overwrite the first receipt time, and is answered `200` — answering `409`
would make every retry permanent.

**First writer wins, permanently**, which is the second edge of § 1's fifth property. A
secret-holder who pre-inserts a `delivery_id` causes the genuine delivery carrying that id to be
dropped in silence: `200`, `duplicate: true`, nothing anomalous anywhere in the response, and
append-only means the squatted row cannot be corrected afterwards. Measured through the real app,
not inferred from the schema. The dedupe rule is right for its purpose — retries must not be
permanent — and this is what it costs.

**Append-only is enforced by the schema**, by triggers that `RAISE(ABORT)` on `UPDATE` and
`DELETE` — a property of the database rather than a discipline application code has to keep. Its
limit, stated rather than glossed: an actor with Cloudflare account access can `DROP TRIGGER`,
and the drop is not recorded anywhere in this database.

There is a second path to a false store, and it is strictly cheaper than that one:

| | needs | leaves a trace | reversible |
|---|---|---|---|
| rewrite history | Cloudflare account access + `DROP TRIGGER` | yes — a visible hole in `sqlite_master` | n/a |
| write false history | the shared secret only | **no** — triggers stay intact, re-verification passes forever | **no** — append-only makes it permanent |

Everywhere else in this design append-only is a defence. Here it is the property that makes a row
known to be false impossible to retract.

**Rejections are counted, never stored as rows, and the counting is coalesced.** One counter per
(UTC day, reason). The webhook route is unauthenticated by construction, so a row per rejected
request would hand any passer-by an unbounded write channel into the store the control depends on.

Bounding the *rows* was not enough on its own, and the first version of this service got that
wrong. Fixed cardinality still meant **one D1 write per rejected request** — so an anonymous flood
converted directly into write volume against an account-level allowance **shared with the
production `routeware-shadow-api` Worker**. Flooding the security control would have degraded an
unrelated service: the endpoint whose job is to notice trouble was the lever for causing it.

So `src/rejection-counter.js` buffers in the isolate and settles to D1 at most once per interval.
The first rejection an isolate sees is written immediately — a single probe against a quiet
endpoint is the event most worth seeing — and only a sustained flood is coalesced, which is the
case where the individual writes had stopped carrying information anyway. `GET /stats` settles the
buffer before reporting, so an operator reading the counters never sees a stale number; that write
is reachable only with a valid `QUERY_TOKEN`, so it cannot be used to force writes anonymously.

**That bound is per-isolate, not global, and the difference is large.** Measured: 500 forged
requests through **one** isolate cost **one** D1 write — the coalescing holds exactly as designed.
The same 500 spread across cold isolates cost **500**, because the immediate-first-flush fires once
per isolate. The honest bound is roughly

```
writes  ≈  isolates_touched × (1 + duration / interval)
```

and an attacker influences `isolates_touched` for free, by distributing the flood geographically.
500 is a worst case rather than a prediction — Cloudflare reuses isolates aggressively, so the
realistic multiplier is colos reached plus scale-out and eviction churn — but nothing in this
design caps it. Read the coalescing as "a flood cannot cost one write per request", never as "a
flood is globally bounded".

Capping the immediate flush to the first *N* rejections per isolate, the obvious next move, does
not help: the cold-isolate case already costs exactly one write per isolate, and no *N* ≥ 1 goes
below one. The only lever that would move this worst case is dropping the immediate flush
altogether, which spends the lone-probe signal that is the main reason the counters exist. We keep
the flush and state the bound.

**The consequence, stated rather than buried: the rejection counters are a lower bound.** Counts
buffered when Cloudflare evicts an isolate are lost, so a count of 40 means "at least 40". That is
acceptable only because these counters were never evidence — they answer "is someone probing this
endpoint?", and a lower bound answers that just as well. **Nothing in `deliveries` goes through
this path.** Every verified delivery is still written synchronously, exactly once, before its 200.

### Re-verifying the store

Each row keeps the raw body, its SHA-256, and the HMAC that verified it. So the store can be
re-checked end to end against the secret at any later date — a row whose signature no longer
verifies was altered after receipt.

**The converse does not hold, and the converse is what a reader under pressure will reach for.** A
row whose signature *does* verify was signed by someone holding `WEBHOOK_SECRET`. That is not the
same claim as "GitHub sent it", and this recipe cannot tell the two apart: it detects alteration
after receipt, and a fabrication is correctly signed at receipt. A fabricated row passes this check
today and will pass it forever. See § 1.

An HMAC is not a secret and cannot be reversed into one,
which is why keeping it costs nothing. Rows with `body_truncated = 1` cannot be re-verified from
the stored body alone, but `body_sha256` and `body_bytes` still describe the **full** payload, so
such a row can be matched against a complete copy from elsewhere.

---

## 8. Tests

```bash
npm test                       # node --test — no credentials, no network, no Cloudflare, nothing installed
./test/test_scripts.sh         # the shell tools, against a stub API on 127.0.0.1
./test/test_verify_deployment.sh  # the receiver over a REAL socket + the deploy verifier
```

Both are gated on **exit status**, never on a test count, and they assert on shape and behaviour
rather than on message text. `test_scripts.sh` generates a throwaway RSA key per run and invokes
the script under `env -i`, so a live `GH_APP_PRIVATE_KEY` in the operator's shell cannot reach a
test run.

`test_verify_deployment.sh` is the only place the receiver meets a real HTTP socket: it runs the
actual app under `node:http` and drives it with `curl`, which catches what an in-process test
structurally cannot — a header lost in transit, a body arriving as a stream, bytes re-encoded
somewhere between the socket and the HMAC.

CI additionally reintroduces the bug this module exists to prevent — a receiver that skips
signature verification — into a **throwaway copy** and requires the suite to go red. The deploy
verifier gets the same treatment against four broken receivers (no secret, no query token,
verification bypassed, accepts-without-storing). A green suite that cannot fail is worse than no
suite, because it is believed.

The `test:sweep-mutants`, `test:health-mutants` and `test:package-mutants`
suites are **local author/operator-preflight gates only** (author pre-handoff
and the `OPERATOR-RECIPE.md` §2 operator run). They are not CI gates and no
workflow file is added or edited for them. A green CI result alone does not
establish mutant coverage.

---

## 9. Provenance

| Claim | Source |
|---|---|
| No org audit log; `GET /orgs/{org}/audit-log` → 404 on Free | scope verification against the audit-log endpoint |
| `accept_plus_webhooks` posture, no spend assumed | scoping decision |
| The first four uncovered properties | the engineering standard § 5.1 |
| The fifth — a row proves secret possession, not GitHub origin | security review; re-measured against `src/` |
| A fabricated delivery stores `200` and passes § 7 re-verification | measured against `app.js` + `verify.js`, 2026-08-24 |
| Dedupe is first-writer-wins; a squatted `delivery_id` drops the genuine delivery | measured against a real SQLite engine; re-measured through the app |
| Coalescing: 500 forged requests cost 1 write in one isolate, 500 across cold isolates | measured against `rejection-counter.js`, 2026-08-24 |
| An exhausted shared D1 allowance makes `receive()` return 5xx, not degrade | measured — `store.append` throws and is not wrapped, 2026-08-24 |
| `/health` discloses arming state to an anonymous caller | two corroborating 503s measured against the app |
| Unregistered App: `events: []`, `hook_attributes.url: null`, hook APIs 404 | `GET /app` against a fresh App |
| GitHub retains webhook deliveries 3 days | docs.github.com — viewing webhook deliveries |
| Deliveries fire for any actor, gated by permissions + subscriptions | docs.github.com — using webhooks with GitHub Apps |
| `repository_selection: all` across the org's repos | scope verification against the App settings |
| `check-subscription.sh` exited 3 under cron's PATH and 2 by hand — two arms, identical env | measured 2026-09-17; fixed, regression case in `test/test_scripts.sh` |
| Worker account already in production use | deployment record |
