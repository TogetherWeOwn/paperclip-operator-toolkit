# Who is "the responsible leader"?

Design decision for TOG-194 / TOG-195. Decided 2026-08-23 by the CTO & Chief AI Officer.
Status: **accepted**. Implemented by `org_request_queue.sh`; tested offline by `test_responsible_leader.sh`.

This document also carries three later decisions on the same mechanism: *Deny is a conversation, not
a dead end* (TOG-198 / TOG-253), *Safer alternatives first* (TOG-388), and *How the requester learns
a request was decided* (TOG-254).

## The question

The owner decided that the responsible leadership agent must be able to *run* the operator
provisioning path, not merely propose changes to a human. A subordinate requests, the responsible
leader evaluates, and approval executes. That requires answering something the previous design never
had to: given a request, **which agent is accountable for deciding it?**

Until now the answer was a closed set of two role templates — `P4_PROVISIONING_STEWARD` (the A0
steward) and `P1_PRESIDENT_COO` (O1). That is a fine answer for an operator-run queue with a handful
of requests. It is the wrong answer once the decision is a real management act, because those two
agents are not accountable for most of the work being requested, and a queue that funnels every
decision into two inboxes is a rubber stamp waiting to happen. The owner was explicit that this is
**not** rubber-stamping: the leader is accountable for the decision.

## The decision

> **The responsible leader for a request is the nearest live ancestor of the requester, walking
> `reports_to` upward, whose own delegation ceiling already contains the requested template.**

Three clauses, each load-bearing.

**"Ancestor, walking `reports_to` upward."** Accountability follows the reporting line, because the
reporting line is what the provisioner already enforces. Every agent the provisioner creates is
placed under the *requester* — invariant 1, `reportsTo` is never caller-supplied. So an approved
request always grows the requester's own subtree, and the person accountable for that subtree is the
person above the requester. No other reading has that property. A project-lead mapping would let
someone with no line responsibility grow another leader's org; a fixed role-template mapping
reproduces the closed-set problem with extra steps.

**"Whose own delegation ceiling already contains the requested template."** A leader may only approve
what it could have done itself. This is the clause that makes approval a real authority check rather
than a signature. It also means the approval never launders authority: if `C1_DIRECTOR_BUILDER` may
create a `D1_MANAGER` directly, it may approve a subordinate's request for one; it may not approve a
request for a `B2_TECH_CHIEF`, because it could not seat one itself.

**"Nearest live."** The walk skips an ancestor only for reasons that are objective, logged, and
outside the requester's control — see the skip rules below.

In the org as it stands on 2026-08-23 this resolves to *the requester's direct manager* in every
case. That is intentional. The walk is not a general search; it is a direct-manager rule with
defined behaviour when the direct manager cannot be the decider.

### Skip rules — and the one that is deliberately absent

| Ancestor state | Behaviour | Why |
|---|---|---|
| `terminated` | skip, logged as `terminated` | There is nobody there to be accountable. |
| ceiling does not contain the template | skip, logged as `ceiling_insufficient` | Cannot approve what it could not do itself. |
| already visited (cycle) | **refuse the whole resolution**, fail closed | A cycle means the org data is wrong; guessing is worse than stopping. |
| chain exhausted / requester is a root | **escalate** to the standing authority set | Defined below. |
| `idle`, `paused`, dormant, slow to answer | **NOT a skip. Wake them.** | See below — this is the important one. |

**Dormancy is never a skip reason, and a pending request never re-targets itself on a timer.** This
is the single most tempting thing to add and it must not be added. If a request could move to a
different, higher approver by waiting, then every requester learns to submit and wait, and the
"responsible leader" becomes whoever is slowest to respond. That is approver-shopping with a clock
instead of a menu. A request that is not decided **expires**; it does not escalate. An expired
request is resubmitted (see *Deny is a conversation*), which puts it back in front of the same
leader, and the expiry is visible in the log so a genuinely stuck leader is an operational problem
someone can see rather than a silent widening of authority.

### The standing authority set is retained — as a floor, not the only path

When the walk finds nobody — the requester is a root agent (`O3` Chief Audit reports to nobody by
design, for independence; `O1` has no ancestor), or every ancestor is terminated — the request
escalates to the **standing authority set**: `P4_PROVISIONING_STEWARD`, then `P1_PRESIDENT_COO`.
That set is exactly today's closed set, so today's behaviour becomes the fallback rather than the
rule, and no request can become undecidable.

A0 and O1 also retain break-glass authority to decide *any* request, including one that has a live
derived leader. Without that, a dormant leader deadlocks its subtree permanently, and the epic is
explicit that a design which only works on the happy path is not acceptable. But a break-glass
decision is **recorded as an override**, naming the leader that was bypassed, so it is attributable
and countable rather than invisible.

This is a deliberate trade: availability and a working escape hatch, bought with a logged bypass,
instead of an unbypassable rule that turns one dormant agent into an outage. The control on the
bypass is that it is visible to `org_access_review.sh` and to O3 audit, not that it is impossible.

### What "visible" actually means

The sentence above was, when first written, a claim about intent rather than about code: the override
was written into the queue, and the only ways to encounter one were to already know the request id
and open its `thread`, or to grep the JSONL. The approval of this design attached a condition — that
`bypassedLeader` be *surfaced*, not merely recorded — because a bypass nobody reads is the same as a
bypass nobody logged. Four things now make it true, deliberately covering both push and pull:

1. **At decision time.** The reviewer that takes a break-glass decision gets a notice naming the
   leader it went over and the exact command that clears it — **on stdout**, because an agent
   reviewer reaches this over `mcp_remote` and a tool wrapper returns stdout while routinely
   discarding stderr. A notice delivered only on stderr would be invisible to exactly the reviewer
   this epic added. A one-line copy goes to stderr for an operator at a terminal.
2. **In the default listing.** `org_request_queue.sh list` carries an `OVERRIDE` column —
   `BYPASSED <leader> — UNREVIEWED` until it is cleared. No request id needed in advance.
3. **As a report and a gate.** `org_request_queue.sh overrides [--all] [--json]` lists them and
   **exits 1 while any are unacknowledged**, which is the same cron/CI contract the access review
   uses. It is database-free on purpose, so it runs in CI and in a container, not only on the VPS.
4. **In the standing access review.** Check 10 of `org_access_review.sh` shells out to that command
   and raises one finding per unacknowledged override. The two cannot drift, because the review does
   not reimplement the query.

### Why acknowledgement exists, and who may give it

A finding that can never clear teaches everyone to ignore the report — which is the same failure as
not reporting at all. So an override is an *open item* that drains: an auditor clears it with
`ack-override --request <ID> --auditor <ROLE> --note "..."`, and the note is mandatory, because
"seen" is not a review finding. The acknowledgement lands in the request's own thread, so the
override and its disposition are one record rather than two.

Two rules keep it from becoming self-service. The acknowledgement set is **`P3_AUDIT_RISK` and
`P1_PRESIDENT_COO`**, deliberately *not* the standing-authority set — P3 is the independent audit
function and is the intended acknowledger; P1 is there so a dormant P3 cannot wedge the review
permanently. And whoever took the override **cannot clear it**, by agent id, on either path. An
override its own author can retire is a log entry, not a control.

The residual limit, stated plainly: this is detective, not preventive. It does not stop a bypass, it
guarantees a bypass is seen and answered for. That is the trade the design already made; this makes
the second half of it real.

## The security properties, and how each survives

The epic named five. Each is stated here with what actually preserves it.

**1. No self-approval, ever, including transitively.** Three layers. (a) The derived reviewer is a
strict ancestor, so it cannot be the requester by construction. (b) The existing identity check —
reviewer agent id ≠ requester agent id at submit — is unchanged and still runs on every decision,
including the break-glass path. (c) **New:** a reviewer that is a *descendant* of the requester is
refused. Derivation cannot produce one, but the break-glass path could if the org were ever
restructured so that the steward sat inside a chief's subtree; that chief could then have "its own"
steward approve its requests. The check costs one subtree query and closes it.

**Exemption, found by the test suite and kept deliberately.** The descendant rule does not apply when
the requester is a *root* agent — one with no `reports_to`. In this org O1 is the root, and the A0
steward reports to O1, so a blanket rule would make every one of O1's own requests undecidable by
anybody: O1 cannot self-approve, and every other agent is inside O1's subtree. The rule could only
produce deadlock there, never protection. O1's requests are still caught by the standing floor and by
the self-approval check. This is a stated limit of the control: a compromised root operator is
outside what a subtree rule can reach, and pretending otherwise would only have cost availability.

The residual case, stated honestly because it is not closed: a leader Q may have its own subordinate
Q′ submit a request that Q then approves. This is not a defect — a leader approving a subordinate's
request *is* the design — and it cannot escalate authority, because Q′'s request ceiling is a strict
subset of Q's, and everything created lands inside Q's own subtree. What it can do is let Q grow its
subtree wider than anyone above Q would have sanctioned. That is a budget and sprawl concern, not an
authority-escalation one. It is contained by making every approval attributable in the grant log and
by `org_access_review.sh` being a standing audit, not by a rule in the queue.

**2. The ceiling re-check at approval time, against fresh state.** Unchanged and extended. The
requester's ceiling is still re-read from live state at approval and re-checked, so a request
approved after the requester was demoted, moved or terminated is still refused. The reviewer's
authority is now *also* resolved against freshly-read state at decision time — the leader is derived
at approval, never cached at submit. A leader recorded at submit time and trusted later would be the
same TOCTOU bug in a new place.

**3. Execution as the original requester.** Unchanged. Approval still shells to
`org_provisioner.sh create --caller <original requester>`, so every section 8.2 invariant reapplies
and the reviewer cannot redirect placement or widen the template.

**4. The reviewer cannot alter the request.** Enforced by the data model: a request record is
immutable once submitted. `review` takes only a decision and a reason — there is no argument that can
change the template, title or placement. A request that needs changing is denied and resubmitted.

**5. No agent holds a credential that bypasses the queue.** This is a transport property, not a queue
property, and it is the one thing the transport work (TOG-196) can silently destroy. Stated as a
requirement on that work: **the MCP server must derive the requester and reviewer identity from the
authenticated agent principal supplied by Paperclip's tool gateway, never from a tool argument.** If
`submit` accepts a `requester` parameter that the model fills in, every property above evaporates in
one line, because any agent can then claim to be any other. This repo has already learned the general
form of this lesson once — the plugin API's `runId` is trusted from the signed JWT claim, not from a
caller-supplied header. Same rule, and TOG-196 does not ship without a test that proves a spoofed
identity argument is ignored.

## Deny is a conversation, not a dead end

A denial carries a reason and the requester can respond. The mechanism is append-only, because the
audit trail has to show the exchange and not just the verdict.

- **Requests are immutable; decisions are final.** A rejection ends that request id.
- **Amendment is a new request that references the old one**, via `submit --supersedes REQ-00N`. The
  new request is validated to have the *same requester agent id* as the one it supersedes, and the
  superseded request must be `rejected` or `expired` — nobody can chain onto someone else's denial,
  or fork a request that is still live.
- **`comment` puts the exchange in the record.** The requester or the derived reviewer may append a
  comment to a pending request. This is how a leader asks for more information *without* having to
  deny, and how a requester supplies it. Authorship is restricted to those two parties so the thread
  stays a record of the decision rather than a discussion board.
- **`thread` renders the whole exchange**, following `supersedes` links backwards, so a reviewer
  looking at REQ-004 sees why REQ-001 through REQ-003 were denied.
- **Supersede chains are capped at 5.** A denied request resubmitted five times is not a
  disagreement to be resolved by resubmission; the cap refuses the sixth and logs it, which forces
  the escalation that should have happened already.
  - **The cap counts amendments of one denial, not the length of one path.** Each amendment records
    the `chainRoot` it descends from, and the cap counts every request sharing that root. Measuring
    path depth alone — `supersedeDepth = previous + 1` — bounded a *chain* but not a *denial*:
    pointing six amendments at the same rejection left every one of them at depth 1, so a single
    denial could be re-argued without limit. Unbounded re-argument is how a rubber stamp is
    manufactured, which is the failure mode this design exists to prevent. Fixed in TOG-253.
  - Five means five: amendments 1–5 are allowed and the sixth is refused. The original submission is
    not an amendment of anything and is not counted. The previous rule allowed four.

- **Every decision carries a reason, approvals included.** A denial needs one so the requester knows
  what to answer. An approval needs one because "why was this approved" is the question an audit
  actually returns for — and until TOG-253 the denial path was guarded while the approval path, the
  one that actually seats an agent, was not.

- **A request id names exactly one submission.** Ids are allocated under a lock (`mkdir`-based;
  `flock` is absent in the paperclip container) and, separately, a record in which one id names two
  submissions is **refused rather than resolved**. The two are not redundant: the lock stops
  duplicates being created, the refusal stops a duplicate that exists anyway — restored backup,
  rotated file, defeated lock — from being acted on. `tail -1` is an arbitrary answer to "which of
  these did the reviewer approve", and an arbitrary answer is worse than a refusal here, because
  every other control still passes while the decision quietly fails to bind to what was decided.

- **Expiry is derived, not awaited.** A pending request past `expiresAt` reads as expired from every
  path — `review`, `list`, `thread`, and the `--supersedes` precondition — with no review attempt
  needed to make it true. Materialising expiry only as a side effect of an attempted review left an
  unread request permanently `pending`, which then refused the documented remedy (`--supersedes`) and
  left the requester with no move at all: a dead end, on the mechanism designed to prevent dead ends.

## Safer alternatives first

Decided 2026-08-25 for TOG-388. Status: **accepted**.

The section above makes a denial *answerable*. It does not make it *useful*. A reviewer could write
"too risky" and stop, and the requester's only move was to argue or to resubmit the same ask with
more words. The owner's instruction, quoted in the `Gated Autonomy` goal:

> A request must state FACTS and REASONING — what is blocked, what was measured, why this capability
> is needed. The responsible agent must then, when the ask is risky, **propose safer alternatives
> that still FULLY unblock the work**. Only when no safer alternative exists may the risky ask be
> granted — never lightly, never without recording which alternatives were considered and why each
> failed.

### The two rules

- **A denial must leave the requester somewhere to go.** `review --reject` now requires, in addition
  to `--reason`, either one or more `--alternative "..."` or an explicit
  `--no-safer-alternative "<finding>"`. The alternatives are written to the decision row, rendered by
  `thread`, and **sent to the requester** in the notification body — an alternative the requester
  never receives is the same dead end as no alternative at all.
- **Granting a risky ask requires the record of what was ruled out.** `review --approve` on a risky
  template requires at least one `--considered "<route>" --because "<why it did not unblock>"` pair.
  The two flags are parsed as one unit and `--because` must immediately follow its `--considered`;
  parsing them as two independent repeatable lists would let a mismatched count pair alternative 1
  with reason 2 and produce a record that is fully populated and entirely wrong — worse than a
  missing one, because it reads as diligence.

The duty to leave a way forward is **unconditional**; the duty to record ruled-out alternatives
attaches to **risky** asks, which is what the owner instruction is about.

### What makes an ask "risky", and why the reviewer is not asked

Risk is derived from the requested template's own permission keys, read live from
`org_provisioner.sh template-keys`. It is never a reviewer-supplied classification: a reviewer-
declared risk level is a checkbox the reviewer clears by declaring the ask safe, which makes the
control optional for exactly the reviewer it is meant to bind.

`RISK_KEYS` maps the owner line — real money, credentials, anything published outside the company,
anything with no rollback — onto this catalog: `tools:admin`, `tools:manage_connections`,
`tools:manage_runtime`, `environments:manage`, `pipelines:write`, `skills:create`, and
`users:manage_permissions` (absent from today's catalog, listed so the day it appears it is risky by
default rather than by somebody remembering). Today that makes four templates risky:
`B2_TECH_CHIEF`, `C2_PLATFORM_DIRECTOR`, `E2_TOOLING_ADMIN`, `E3_PIPELINE_BUILDER`.

**`NONRISK_KEYS` is not decoration and it is not the complement of `RISK_KEYS`.** It is the second
half of a totality check: a template carrying a key on *neither* list makes the classifier **refuse
the decision**. That is the anti-rot property and it is the reason to spend a second list on it. A
bare denylist silently opts every new permission key into "safe", so the day someone adds
`secrets:read` to a template the classifier keeps answering "not risky" and the control quietly stops
applying to the one grant it most exists for. The queue already learned this exact lesson once — see
`STATUS_EVENTS`, where a denylist of event types made every new event a decision.

The classifier fails closed in **two distinguishable ways**, and callers must not collapse them:

| return | meaning | behaviour |
|---|---|---|
| `0` | risky; prints the factors | the record is required |
| `1` | not risky | decide normally |
| `2` | catalog unreadable, or template absent from it | **refuse** — "risk unknown" must never render as "risk absent" |
| `3` | template carries an unclassified key | **refuse**, naming the key; the decision belongs to whoever extended the catalog |

Return 2 is not hypothetical. The provisioner's human `templates` view is piped through `column`,
which is util-linux and is **absent in the paperclip container**, where it prints nothing at all
rather than failing — a risk classifier reading that view would answer "no keys, not risky" for every
template on earth. That is why the queue reads `template-keys`, which is never piped through anything
optional, and why the same fix was applied to `ceiling` while we were there.

### Reading the record

`risk-record [--all] [--json]` lists the two shapes that need an independent read — a risky ask that
was **granted**, and a denial that recorded **no safer alternative** — and exits 1 while any are
unacknowledged. `ack-risk --request <ID> --auditor <ROLE> --note "..."` closes one out, under the
same rules as `ack-override`: an auditor from `AUDIT_AUTHORITY`, a mandatory note, and never the
reviewer who took the decision. `org_access_review.sh` check 11 surfaces the open list.

This is deliberately a **separate** command, event and acknowledgement from `overrides`. They answer
different questions — "who decided this" versus "was a safer route looked for" — a request can carry
both at once, and clearing one must not clear the other. Folding them together would also silently
change the meaning of the exit status check 10 already gates on, which is how a working alarm gets
repurposed into a broken one.

Only **risky** asks land on that list. Every denial must still leave the requester somewhere to go,
but a list that also collected "no safer route to seat a specialist" would be mostly noise within a
month, and an open list nobody finishes reading is the same failure as no list.

### What this control cannot do

It cannot tell a real alternative from the word "none" typed into `--alternative`. No script can.
What it can do is make the omission impossible and the content named, attributed and durable, so a
reviewer who skips the thinking has to write down that they skipped it, under their own role id, in a
record that an independent auditor is prompted to read. That is the same trade the standing-authority
override design already made: convert a silent gap into a loud one. It is written down here because a
control whose limits are undocumented gets trusted for more than it does.

### On "decisions are final"

TOG-388 was filed on the reading that `decisions are final` left a rejected requester with no path
forward. It does not, and it did not before this change. That refusal is scoped to **re-deciding one
request id**, which is what keeps the record binding to what was decided; the same command prints the
two ways forward on every denial, and TOG-194/TOG-198 built `comment` and `--supersedes` for exactly
that. The genuine gap was never the finality rule — it was that a denial could be *empty of a next
move*, and that a risky grant could be recorded without the thinking behind it. Those are what this
section closes.

## How the requester learns a request was decided

Decided 2026-08-24 for TOG-254. Status: **accepted**. Implemented by
`org_request_queue.sh`; tested offline by `test_decision_notify.sh`.

TOG-198 asked for this explicitly and the first implementation did not answer it: *"decide how the
requester LEARNS of the decision. A denial nobody reads is a dead end regardless of how good the
reason is."* There was no notification, no wake and no callback. The requester had to poll
`org_request_queue.sh list`, so the honest description of the previous behaviour is **it does not
learn** — and for an expiry, which no human action produces, nothing happened at all.

> **Every terminal transition notifies the requester, addressed to the agent id recorded at submit.
> Delivery is an outbox, never a gate: the decision is committed first, delivery is attempted after,
> and a failed delivery is logged rather than retried into a different approver.**

### Four terminal states, not three

The issue named denial, approval and expiry. There is a fourth: **`failed`** — the reviewer approved
and the provisioner then refused, so no agent was seated. It ends the request as finally as a denial
does, it is the state in which the requester is *most* confused about what happened, and it was the
one nobody had named. All four notify.

| State | What the requester is told |
|---|---|
| `approved` | who approved it, why, **and the seated agent's id** — that id is the point of having asked |
| `rejected` | the reason, and both next moves: answer in thread (`comment`), or amend (`submit --supersedes`) |
| `expired` | that it aged out, that expiry **did not** re-target it, and how to resubmit to the same leader |
| `failed` | that it was approved but not seated, the provisioner's error, and that no partial state was left |

### The channel, and an honest note about what exists

The right instinct was stated in the issue: whatever wakes the leader is the same mechanism that
should tell the requester, pointed the other way. Checking that turned up something worth writing
down — **neither side has a notifier today.** This document's claim that a dormant leader is *woken*
is, as of now, a statement about design intent with no code behind it, exactly as the requester's
side was. This section defines the mechanism for one direction; the other direction is the same
mechanism and should reuse it rather than grow a second one.

There is no agent-addressed notification route on this instance. Measured 2026-08-24 from an agent
principal:

| Route | Result |
|---|---|
| `GET /api/notifications` | 404 |
| `GET /api/agents/me/notifications` | 404 |
| `GET /api/agents/me/wake` | 404 |

What does work — and is how this instance's agents already reach each other, including how the
review that produced this issue reached its author — is an **issue comment and the wake it
generates**. So delivery is a comment on an issue the recipient is assigned to, named per-request by
`submit --notify-issue`, and carried by `REQUEST_NOTIFY_CMD`. The reference transport is
`notify_paperclip_issue.sh`.

The transport is a seam rather than a hardcoded API call because the queue runs operator-side against
Postgres and holds no Paperclip agent credential of its own. Leaving `REQUEST_NOTIFY_CMD` unset is a
**supported, recorded state** (`pull_only`), not a failure.

#### The notification payload is attacker-adjacent input

Found in review, 2026-08-24, after the transport had shipped. The queue is careful to treat the
notifier as untrusted — a hostile courier cannot block, alter or re-target a decision, and
`test_decision_notify.sh` proves it. Nobody had asked the mirror-image question: **the notifier must
treat its payload as untrusted too.** Two payload fields are written by the requester, the
least-privileged party in the flow, and both reached somewhere they should not.

- **`notifyIssue` chose the route.** It was interpolated into the URL path unvalidated. curl resolves
  dot segments client-side, so a `--notify-issue` of `../../agents/me/secrets?x=` produced a
  `url_effective` with `/api/issues/` gone entirely — a requester steering an *operator-credentialed*
  POST onto a route of its choosing. Now an allowlisted charset (`^[A-Za-z0-9][A-Za-z0-9_-]*$`, so
  `..` is unrepresentable rather than filtered), refused at submit so it is never recorded **and** in
  the transport so a restored or hand-edited queue is still refused. Deliberately not a denylist:
  `..`, `%2e%2e`, a bare `/` and `//host` are one bug, and a denylist is one encoding away from
  missing the next.
- **`body` could forge a verdict.** It was wrapped in a fixed ` ``` ` fence, which text containing
  ` ``` ` closes. A *rejected* request could render a fabricated "REQ-001: approved / Addressed to
  A0" block into the comment — and these comments **wake agents**, so the forgery is read by a
  machine, not merely displayed to a human. The fence is now measured longer than the longest
  backtick run in the body.
- **The credential was on argv.** `-H "Authorization: Bearer $KEY"` puts it in `/proc/<pid>/cmdline`,
  which is world-readable on this shared box. TOG-200 made that a repo-wide rule and `gh_token.sh`
  documents it; the notifier shipped breaking it, which is how a rule decays — one new caller at a
  time. Now a `0600` `curl --config` file, the same pattern as `curl_authed()`.

`test_notify_transport.sh` covers all three, with a `curl` stub on PATH so what would have gone over
the wire is an assertable artifact. Each has a CI mutation gate, because a guard nobody can break on
purpose is a guard nobody knows still works.

**Accepted residual risk:** a requester may still name any *well-formed* issue id it knows, including
one it is not assigned to, and its own decision notice is posted there. Verifying assignment needs an
API read this offline tool deliberately does not make, and the disclosure is bounded to the
requester's own request record, which it already holds. Worth revisiting if the notifier ever carries
anything the requester did not itself submit.

### Push and pull, because push can always fail

`inbox --for <ROLE>` renders every decision on the requester's own requests, with the delivery state
of each. It needs no transport, no credential, no network and no `column`. This is deliberate: if the
only answer to a failed push were another push, the design would have replaced one dead end with a
less obvious one. Push is the thing that makes a decision *timely*; pull is the thing that makes it
*reliable*, and the requirement is reliability.

`notify --list` shows the outbox; `notify --drain` retries; and `notify` **exits 1 while any
notification is undelivered**, which is the same cron/CI contract `overrides` uses. `pull_only` is
explicitly not counted as a failure, or the gate would be red on every correctly-configured
deployment that has chosen the pull path.

### Delivery is not a security control, and is structurally prevented from becoming one

This is the requirement that mattered most: *"a notification that fails must not block, alter, or
re-target a decision, or the notifier becomes a way to influence authorization."* That is enforced by
construction, not by intent:

1. **Ordering.** The decision row is appended to the queue *before* any notification work begins.
   Every failure mode — bad transport, hang, SIGKILL, full disk — happens to a decision that is
   already final. This, not the timeout, is the actual guarantee.
2. **Containment.** Delivery runs in a subshell with its exit status swallowed, so it cannot fail a
   caller, and there is no code path from the notifier back into reviewer derivation, the ceiling
   check, or the decision rows. A malformed payload is dropped rather than appended, because one
   unparseable row breaks every reader of the record.
3. **No re-targeting, ever.** `notify --drain` re-reads the recipient from the recorded
   `notify.queued` row and never re-derives it. A retry that re-derived could be pointed at a
   different agent by an org change made between the decision and the retry — the same hazard the
   issue names, arriving through the back door. The recipient is an **agent id**, not a role string,
   for the same reason: a role can be re-pointed at a different agent, and the decision was made
   about a specific principal.
4. **A hung transport is bounded** by `REQUEST_NOTIFY_TIMEOUT` where coreutils `timeout` exists. This
   is a liveness aid for the reviewer's terminal, not a correctness property — correctness is (1).

### Two things this change hardened on the way past

Both were found by the suite rather than reasoned about in advance, and both are the *same class of
bug the record had already been bitten by once*:

- **Status is now an allowlist, not a denylist.** Queries asked "which rows are *not* comments or
  acknowledgements" and treated the rest as decisions. Adding notification events opted them silently
  into being read as decisions, which gave notified requests a null status and dropped them from
  every filtered listing. The code already carried a written warning about exactly this. It is now
  `STATUS_EVENTS`, stated positively: an event carries a status only if it is on the list.
- **A second terminal decision is refused, not resolved.** The record refused ambiguous
  *submissions* already; it resolved ambiguous *decisions* by `tail -1`. That mattered more once this
  change introduced a new writer to the queue file — `REQUEST_NOTIFY_CMD` is an operator-configured
  subprocess that did not previously exist. It runs as the same user and therefore *can* append; what
  it must not do is have an appended row silently become the decision. `thread`, the view whose whole
  purpose is to be believed, now checks every request in the chain.

The residual limit, stated plainly: this is detective, not preventive. A transport running as the
same user cannot be sandboxed by the script that invokes it. What the change buys is that a forged
decision becomes a loud refusal instead of a silent substitution — the same trade the override design
already made.

## What was considered and rejected

**Direct manager only, no walk.** Simpler, and identical to this design in every current case. Rejected
because it has no defined behaviour when the direct manager is terminated or under-ceilinged, and
"undefined" in an authorization path resolves to whatever the code happens to do.

**Nearest ancestor holding a specific grant.** Attractive, but Paperclip grants do not express
provisioning authority — that is precisely why this repo exists (Constraint A: the native member
grant routes reject agent principals outright). Deriving review authority from a permission key would
be inferring authority from something that does not carry it, which the queue already refuses to do
for `users:manage_permissions`.

**The lead of the project the request concerns.** Rejected. Provisioning grows an org subtree, not a
project. A project lead has no line accountability for an agent that will outlive the project, and
nothing in the placement rules would put the new agent under them anyway.

**Role-template mapping (e.g. "all `D1` requests go to any `C1`").** Rejected: it makes approvers
interchangeable, which is exactly the property that turns review into a stamp. Accountability
requires a named agent, not a class.

**Auto-escalation on timeout.** Rejected, with the reasoning above. It is the design's most likely
future regression, so it is written down as a rejection rather than left unmentioned.

**Polling as the only answer — "the requester runs `list`".** Rejected: it is what the design already
did, and it is why TOG-254 exists. Polling cannot cover expiry, because nothing prompts the requester
to poll at the moment their request quietly dies, and a denial nobody is prompted to read is the dead
end TOG-198 was filed about. Polling is retained as the *backstop* (`inbox`), not as the mechanism.

**Retrying a failed notification to a different recipient — a "fallback approver" or a manager
copy.** Rejected, firmly, and it is the most dangerous thing that could be added here. A notifier
that re-targets on failure is a mechanism by which delivery outcomes select who is involved in an
authorization decision, which is precisely what the requirement forbids. It is the same shape as
auto-escalation on a timer, one layer down, and it would be easy to add believing it was a
reliability improvement. A failed delivery is logged and drained to **the original recipient**, or it
is left visible as an undelivered notification; it is never redirected.

**Blocking the decision until delivery succeeds.** Rejected. It sounds like the safe choice and is
the opposite: it makes an unreachable requester — or a broken transport, or a slow HTTP call — able
to prevent a leader from deciding. That hands anyone who can degrade delivery a veto over
authorization. Notification is a consequence of a decision, never a precondition for one.

**Making the notification itself the audit trail.** Rejected. Delivery state (`delivered`, `failed`,
`pull_only`) is recorded in the queue, but the *record* of what was decided remains the request
thread. Notifications are lossy by nature; a record that lives only where it was sent is a record
that a transport outage can erase.

**Paperclip's native `tool_action_requests` table as the record, instead of this JSONL queue.**
TOG-198 asked for this to be evaluated rather than assumed, and it is the right question: the table
already carries `requested_by_agent_id`, `decided_by_agent_id`, `approval_id`, `interaction_id`,
`preview_markdown`, `canonical_arguments_hash`, `signed_arguments` and `expires_at`, which is most of
what this queue reinvents. **Rejected, on measurement, not on preference.**

There is no agent-reachable surface for it. Probed from an agent principal on 2026-08-23 during the
review of PR #6, and re-probed independently on 2026-08-24 while writing this section:

| Route | Result |
|---|---|
| `GET /api/tool-action-requests` | 404 |
| `GET /api/agents/me/tool-action-requests` | 404 |
| `GET /api/companies/{companyId}/tool-action-requests` | 404 |
| `GET /api/tool-policies` | 404 |
| `GET /api/tool-connections` | 404 |

The table exists in the database and has zero rows on this instance; what does not exist is any HTTP
route an agent can use to write to it or read it back. A record the requester and the reviewer cannot
read is not an audit trail for them, whatever it is for the platform. The second problem is shape: it
models a **single** decision per request, and the exchange this epic is required to preserve —
request, reason, denial, amendment, decision — is multi-round. Representing that would mean either
one row per round with the linkage held somewhere else, or a parallel record anyway.

So the local JSONL queue is the record, deliberately. **Revisit this if** either a company-scoped or
`agents/me` route for `tool_action_requests` ships, or the tool gateway starts writing rows on an
agent's behalf that the agent can then read — at that point the argument changes and this decision
should be re-taken rather than inherited. Do not re-probe the routes above without checking the API
surface has changed first; the answer was the same on both dates.
