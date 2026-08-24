# Who is "the responsible leader"?

Design decision for TOG-194 / TOG-195. Decided 2026-08-23 by the CTO & Chief AI Officer.
Status: **accepted**. Implemented by `org_request_queue.sh`; tested offline by `test_responsible_leader.sh`.

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
