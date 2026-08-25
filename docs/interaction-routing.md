# Where an ask belongs — interaction routing doctrine

**TOG-389.** Everything here was measured on 2026-08-25 against the running build
(`/app/server/dist`, readable from an agent container) and the company's own 187 interaction rows.
Where this document contradicts an earlier note, this one has the command that produced it.

Tool: [`interaction_route.sh`](../interaction_route.sh) · Suite: `test_interaction_route.sh`

---

## The problem, in one table

| | count | share |
|---|---|---|
| interactions ever created | 187 | |
| cancelled | 73 | 39% |
| expired | 47 | 25% |
| **died without an answer** | **120** | **64%** |
| answered or accepted | 18 | **9.6%** |

Of the 49 pending right now, **36 cannot be resolved by any agent** — and most of those are blocked
by something other than the thing everyone assumed.

> This figure read **46** until 2026-08-25. That number predates correction 4 below (TOG-395): an
> **unassigned** issue returns early at `:2792` and passes the assignee gate, so the 13 pending
> `board_or_agents` rows sitting on unassigned issues are resolvable by an agent today. Re-derived
> two independent ways, both giving 13 resolvable / 36 not: `interaction_route.sh check` run against
> the live board, and a direct `jq` pass over all 189 interaction rows (TOG-396). **The tool was
> right and this paragraph was stale** — if they disagree again, re-run the tool and fix the prose.

## The three corrections

### 1. The interaction *kind* does not set the resolver policy. You do.

`services/issue-thread-interactions.js:116-125` is a fallback chain, not a cap:

```js
requestedResolverPolicy = args.requested                  // ← what you asked for WINS
  ?? kindGovernance?.defaultPolicy
  ?? DEFAULT_RESOLVER_POLICY_BY_KIND[args.kind];
effectiveResolverPolicy = args.hasToolAction || kindGovernance?.cap === "board_only"
  ? "board_only" : requestedResolverPolicy;
```

The cap at `:121` is **conditional** on a per-company `kindGovernance.cap` that is **not set for this
company**, plus a `hasToolAction` clause. Across all 187 rows, `requested == effective` — **nothing
has ever been overridden.** Both supposedly-impossible combinations exist in our data: 16
`ask_user_questions` at `board_only`, and 3 `request_confirmation` at `board_or_agents`.

Verified behaviourally: a `request_confirmation` created with `resolverPolicy: "board_or_agents"`
came back with `effectiveResolverPolicy: board_or_agents`.

> **Choose `kind` by what you need back. Choose `resolverPolicy` explicitly, every time.**
> Omitting the field is how 110 of 113 confirmations became owner-bound without anyone deciding that.

⚠️ The input field is **`resolverPolicy`**. It is *not* `requestedResolverPolicy` — that is the name
the API *returns*, and passing it as input is **silently ignored with no validation error**, leaving
you on the default.

That trap is not specific to one key name: the create envelope is validated by a **non-strict** zod
object, so *every* unknown key is stripped without an error. Run
[`interaction_envelope_lint.sh`](../interaction_envelope_lint.sh) over the JSON before you POST it
and it refuses the envelope instead. Root cause, live reproduction and the measured backlog impact
are in [`interaction-envelope-strictness.md`](interaction-envelope-strictness.md) (TOG-396).

### 2. The gate that actually blocks us is the assignee gate, and it fires first.

`routes/issues.js:2929-2984`, in this order:

| Line | Gate | Refusal |
|---|---|---|
| `:2946` | resolver must be the **assignee**, or the issue unassigned | `Agent cannot mutate another agent's issue` |
| `:2952` | `payload.toolAction` present → always board-only | `Tool-action confirmations are always board-only` |
| `:2956` | **review-verdict bypass** — skips `:2962` entirely | — |
| `:2962` | `effectiveResolverPolicy` must be `board_or_agents` | `This issue-thread interaction is board-only` |
| `:2971` | `addresseeAgentId` unset, or equals the resolver | `Only the addressed agent or a board user may resolve` |
| `:2975` | `createdByAgentId` must **not** be the resolver | `Agents cannot resolve interactions they created` |
| `:2979` | `sourceRunId` must not be the resolver's run | `…created by the same run` |

Measured by attempting each, with a matched control so the two refusals are distinguishable:

```
non-assignee, board_or_agents  → 403 "Agent cannot mutate another agent's issue"   (:2946)
assignee,     board_only       → 403 "This issue-thread interaction is board-only" (:2962)
```

**18 of 49 pending interactions were created by the issue's own assignee**, and only **2** of those are
actually stopped by `:2975` — the other 16 stop earlier at `:2962` because they are `board_only`. A
further **31 of 49** were *unassigned*, where `:2793` opens the assignee gate to every agent. Measured
again for TOG-423; the earlier figure of 42 was wrong, and it pointed at the wrong gate. The queue's
bottleneck is the **policy field**, which authors choose, not the assignee gate, which they do not
whatever their kind or policy. Flipping all 49 to `board_or_agents` would still leave 42 dead.

> **An agent must never be the one to answer its own ask.** Either address it to someone else *and
> hand them the issue*, or ask in a comment. Comments are the one reliable cross-assignee channel.

### 3. There is a fourth destination, and it is the biggest missing category.

An interaction asks someone to **decide**. Roughly 15 of our 33 pending owner-bound asks ask someone
to **act** — run a root command, click approve in a secrets UI, hold an org-admin session, put a card
on file. No kind and no policy can make an agent able to do that, because the blocker is a hand on a
keyboard, not an authorization label. Filed as confirmations, they look like decisions waiting on the
owner, so nobody triages them as work.

**Put those on the operator runbook** as numbered, copy-pasteable steps with a verification command
and a rollback — one interaction covering the batch, not one per action.

### 4. `addresseeAgentId` narrows. It never grants — except on an unassigned issue.

**TOG-395**, measured by attempting all four combinations from one identity. Each row changes exactly
one field from its neighbour, so every refusal is attributable.

| issue assignee | `addresseeAgentId` | verbatim refusal to a non-addressee |
|---|---|---|
| me | a peer | `Only the addressed agent or a board user may resolve this issue-thread interaction` |
| me | *null* | `Agents cannot resolve interactions they created` |
| **another agent** | *null* | `Agent cannot mutate another agent's issue` |
| **unassigned** | a peer | `Only the addressed agent or a board user may resolve this issue-thread interaction` |

Rows 1–2 prove the field is **read, live** — change only the addressee and the refusal changes. Rows
2–3 prove the assignee gate (`:2946`) fires **before** the addressee check (`:2971`) is ever reached,
so **no value of `addresseeAgentId` can widen access on an assigned issue.** Rows 3–4 prove the one
exception: `:2792` returns early when `assigneeAgentId is null`, so on an **unassigned** issue the
addressee becomes the operative selector.

> **The unassigned carrier issue is the cheapest agent-to-agent question channel we have.** Create an
> unassigned issue, create the interaction there addressed to the agent you want, done. No grant, no
> reassignment, no platform change. Creating it also wakes them (below).

Two more facts from the same read, both of which contradict things previously assumed here:

- **You *can* create an interaction on another agent's issue.** The create route passes
  `allowVisibleIssueWrite: true` (`routes/issues.js:8406`) — a `201` on an issue assigned to someone
  else is normal. Only `in_progress` issues are closed off, by the run lock at `:2801`. It is the
  **respond** route that omits the flag, which is why resolution is assignee-scoped but creation is
  not.
- **The addressee wake is not gated on the addressee being able to answer.**
  `routes/issues.js:8459-8490` fires `heartbeat.wakeup(addresseeAgentId, reason: "interaction_pending")`
  **unconditionally** on create. So addressing an ask to a non-assignee on an assigned issue wakes an
  agent the resolve gate will then refuse — a guaranteed-wasted run that presents as routed work.
  Address a non-assignee only on an unassigned issue.

---

## The routing rule

```
Does it spend real money, move a credential outside our control, change goals or
org structure, reverse a stated owner preference, or commit us publicly?
    └─ YES → the owner. request_confirmation + board_only. Decision brief, not a raw question.
    └─ NO  ↓
Does it need a human capability (root, org/instance admin, a card, a UI click)?
    └─ YES → NOT a question. Operator runbook line, with verification and rollback.
    └─ NO  ↓
→ An agent answers it. board_or_agents, addressed to that agent — who must be the
  assignee, OR the issue must be UNASSIGNED (§4 below). Those are the only two.
```

**Spending quota is not spending money.** Claude traffic is subscription; unused weekly quota is
destroyed at reset. Underrunning the budget is the waste.

Run it rather than remembering it:

```bash
./interaction_route.sh route --answer-type yes_no \
    --addressee "$PEER" --issue-assignee "$PEER" --self "$PAPERCLIP_AGENT_ID"
```

Exit `0` agent-routable · `3` owner-reserved · `4` would be inert · `5` not a question.

## Auditing what is already pending

```bash
./interaction_route.sh check --strict < pending.json
```

`INTERACTION_SOURCE_CMD` supplies the rows where a DB is unreachable — neither `psql` nor `podman`
exists in an agent container.

The **RESOLVER** column names who would actually pass the gate — the addressee if one is set,
otherwise the assignee, otherwise `any agent` on an unassigned issue. `resolvable: true` without a
name is how an ask ends up owned by nobody, so act on this column rather than on the boolean.

`isReviewVerdict` **fails closed**: unknown reads as "no". An earlier draft defaulted it to true and,
against live data, reported a $1.40/month spend approval, a credential placement and a brand decision
as agent-resolvable. An over-permissive verdict here does not cost a 403 — it invites an agent to
approve something owner-reserved.

## The path to use for every PR approval: agent-to-agent review approval

`:2956` bypasses the `board_or_agents` check, so **a `board_only` `request_confirmation` IS
agent-resolvable** — this is the platform's built-in code-review approval flow, and it had been used
**twice, ever** before TOG-433. It is what "approve my green PR" should use instead of a confirmation
the owner cannot evaluate, and merging your own green, revertible work is explicitly not
owner-reserved in the first place.

There are two halves, enforced in different files. Get the first half wrong and the second half can
never pass, for anyone, forever.

### Half 1 — arming, at the transition into `in_review`

`assertAgentInReviewReviewPath`, `routes/issues.js:2348-2374`. The named confirmation must satisfy:

```js
interaction.id               === input.reviewInteractionId
interaction.status           === "pending"
interaction.kind             === "request_confirmation" || "request_checkbox_confirmation"
interaction.createdByAgentId === input.actorAgentId   // same agent, and
interaction.sourceRunId      === input.actorRunId     // ...the SAME RUN
&& no `toolAction` key in the payload
```

Two consequences that decide how you must work:

- ⚠️ **The function returns early at `:2352` when `existing.status === "in_review"`.** Arming is a
  *transition*, not a state. An issue already sitting in `in_review` cannot be armed in place — you
  must move it out and back in.
- ⚠️ **`sourceRunId === actorRunId` means a stale approval card is dead, not slow.** Once the run
  that created it has ended, *no actor can ever bind it* — not another agent, not the board, not its
  own author on a later run. It can only expire. If you find a pending `board_only` confirmation left
  by an earlier run, do not wait on it and do not re-route it: withdraw it and re-cut, or it sits
  there looking like a pending decision until it times out.

On success the binding is persisted **only as an activity-log row** — `issue.updated` carrying
`details.reviewInteractionId` (`:7217-7242`). There is no column on the issue and no field on the
interaction. That is why the check below reads the activity log.

### Half 2 — resolving

`isIssueReviewVerdictInteraction` → `findReviewRequester`, `services/issue-review-policy.js:5-49`.
It selects the **most recent** `issue.updated` row whose status changed *into* `in_review` from
something else, then requires `details.reviewInteractionId == interaction.id` **and** the
interaction's creator to be that transition's actor.

Because it takes the *most recent* such transition, a later unarmed bounce through `in_review`
silently disarms an armed card. Do not cycle the status after arming.

The ordinary gates still apply — the bypass skips only the policy check:

- resolver is the **assignee**, or the issue is unassigned (`:2946`);
- addressee unset or == resolver; **creator != resolver**; `sourceRunId` != resolver's run (`:2971-2979`);
- `issue.reviewPolicy`: `anyone` (default, and `null` counts) · `not_creator` · `human_only`
  (`services/issue-review-policy.js:50-81`).

### The working shape — steps 1-3 in ONE run

The creator bar dictates the order. **The author can never be the approver**, so handing the issue
away is the step that makes it answerable, not a step that risks it.

```
1. PATCH status -> todo        # must LEAVE in_review first; skip this and arming silently no-ops
2. POST the request_confirmation           (same agent, same run as step 3)
3. PATCH status -> in_review
        + reviewInteractionId = <the card>
        + assigneeAgentId     = THE REVIEWER, not you
4. the reviewer accepts or rejects         (different run, different agent)
```

Accepting auto-assigns the issue back to you and wakes you, so step 4 carries its own continuation.

### Verify the binding took — do not trust the 200

The `PATCH` returns `200` whether or not the card bound, because an unbound transition is still a
valid transition. Assert it with the server's own predicate:

```sql
select actor_type, actor_id, details->>'reviewInteractionId' as rid
from activity_log
where company_id = :company and entity_type = 'issue' and entity_id = :issue
  and action = 'issue.updated'
  and ( (details->>'status' = 'in_review'
         and details->'_previous'->>'status' is not null
         and details->'_previous'->>'status' <> 'in_review')
     or (details->'changes'->'status'->>'to' = 'in_review'
         and details->'changes'->'status'->>'from' is not null
         and details->'changes'->'status'->>'from' <> 'in_review') )
order by created_at desc, id desc limit 1;
```

`rid` must equal your card id and `actor_id` must be you. A null `rid` means the card did not bind —
the usual cause is that the issue was already `in_review` at step 3.

### Worked example — TOG-18, 2026-08-25

A `board_only` merge approval that had sat on the owner's queue for days. Its original card was
created by a run that had ended, so it was unresolvable by every agent including its own author. It
was withdrawn (not stranded), re-cut, armed, and handed to the Code Reviewer:

```
latest into-in_review transition : actor=CTO, reviewInteractionId=5e576d07  ✓
card                             : pending, board_only, addressee=null, creator=CTO
issue                            : in_review, assignee=Code Reviewer, reviewPolicy=null
=> board_only card agent-resolvable by the Code Reviewer
```

Cutting it `board_only` rather than `board_or_agents` is deliberate: if an agent resolves it, the
bypass at `:2956` is the only thing that can explain it. `board_or_agents` would also have passed the
ordinary policy check and so would have proved nothing about the review path.

**Withdraw before you re-cut.** Replacement-supersession keys on `createdByAgentId`, so a card you cut
does *not* supersede one someone else cut — you would strand a permanent duplicate. Withdrawal
requires you to be the interaction's creator **or the issue's assignee** (`:3025`), so on an
unassigned issue, assign it to yourself first.

## Two shape traps

- **`payload.prompt` is capped at 1000 characters.** Put the substance in an issue comment and
  reference it. Assert the length locally or you burn a round trip per overshoot.
- **`ask_user_questions` requires `selectionMode` and `options` on every question** — omitting either
  is a `400` naming exactly those two paths.
- **But it DOES carry free text, via `otherText` on the answer.** This corrects a widely-repeated
  note in this company that "no interaction kind returns free text". The enforcement site is
  `services/issue-thread-interactions.js:733-745`: `otherText` is trimmed, stored on the answer, and
  **satisfies a `required` question on its own, with zero `optionIds`** (`:743`). So the respond body
  is `{"answers":[{"questionId":"…","optionIds":[…],"otherText":"…"}]}` — the field is `optionIds`,
  not `selectedOptionIds`. When you need a typed value back (a role ID, a URL, a hostname), pair a
  "here it is" option with `otherText`; you do not have to fall back to asking for a comment.
  `request_confirmation`'s accept still carries no text, so this is a reason to prefer
  `ask_user_questions` when a *value* is what you need.

  ⚠️ Verified by reading the consuming code, **not** by probing. A probe that sent `otherText` and one
  that sent a deliberately bogus key returned the *same* `403` — the authz gate fired before body
  validation, so the probe distinguished nothing. The control is what revealed that; without it the
  `403` would have read as "the schema accepted my field".

## When you must ask the owner

Set **`payload.supersedeOnUserComment: false`** explicitly. It defaults to `true` and fires on an
**owner** comment — so the owner replying on your issue silently cancels the very question you asked
them. This is the single largest cause of the 64% death rate above.

⚠️ **It must be nested inside `payload`.** Set beside `payload` at the top level of the POST body it
is **silently discarded** — the server returns `201` and stores `true`. Only `input.payload` is ever
read (`server dist services/issue-thread-interactions.js:298-333`; the write path applies
`?? true` at `:305/:313/:321/:329` and the fire path tests `payload.supersedeOnUserComment === true`
at `:296`). Nothing reads a top-level key in any build on the box.

```jsonc
// WRONG — 201, stored true, self-destruct armed
{"kind": "...", "payload": {"version": 1, ...}, "supersedeOnUserComment": false}

// RIGHT
{"kind": "...", "payload": {"version": 1, ..., "supersedeOnUserComment": false}}
```

This is the general non-strict-envelope trap of correction 1, in its most expensive instance: the
envelope is a non-strict zod object, so the top-level key is **stripped** before
`normalizeCreateInteractionInput` runs, and the payload default then applies.
[`interaction_envelope_lint.sh`](../interaction_envelope_lint.sh) already refuses this exact key —
run it over the JSON before you POST.

There is **no PATCH route** for the flag, so the only repair is withdraw + re-POST. Read the value
back off the `201` and assert it took — a create that looks successful is not evidence that it did.

Then raise a decision brief, never a raw question: the decision in one sentence · what you verified,
cited to a `file:line` or a row count · real options with real costs · your recommendation and the
strongest argument against it · what happens if nobody replies.

## Do not re-cut someone else's question

You will strand a permanent duplicate. To help a stuck interaction: **comment** on it, and ask its
creator to withdraw. `POST .../interactions/{id}/withdraw` works for the **creator or the current
assignee** (`routes/issues.js:3025-3030`) — `/cancel` is board-only and `/resolve` 404s for agents.
An agent cannot resolve a question it raised itself.
