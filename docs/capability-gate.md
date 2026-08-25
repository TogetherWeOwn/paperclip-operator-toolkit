# The capability request + approval gate

**Issue:** TOG-387 · **Tool:** [`capability_gate.sh`](../capability_gate.sh) ·
**Suite:** [`test_capability_gate.sh`](../test_capability_gate.sh) (offline, in CI)

An agent that needs a capability it does not hold asks for it here, states the facts
and the reasoning, and a responsible agent decides — or the gate says, on the record,
that no agent may decide it and it stops for the owner.

---

## Why this is not a subcommand of `org_request_queue.sh`

The provisioning queue is a sound authorization core and this reuses its design and its
record layer. It is a separate tool because the two differ in the only place that matters:
**who decides**.

The queue derives authority from the delegation ceiling — *"a leader may only approve what
it could have done itself"* — walking `reports_to` upward to the nearest live ancestor whose
own ceiling contains the requested template. That question is meaningless for a capability.
There is no ceiling that says who may hand out a GitHub token, and no walk up the reporting
chain finds one. Capabilities derive authority from **ownership of the domain**, and custody
of a credential is a **second, independent key**.

Two other things follow from that and are not cosmetic:

- **Separate id space.** `CAP-001` and `REQ-001` are different requests. Mixing them in one
  namespace is how a reviewer decides an id it did not read.
- **No standing-authority override.** The queue has one, so a dormant leader cannot deadlock
  a subtree, and the cost is bounded: the worst case is an agent seated a level early. For a
  capability the worst case is a credential in the wrong hands, so the same trade comes out
  the other way. A dormant domain owner makes the request expire, and an expired capability
  request is a delay. A break-glass path is a standing way around every rule above it.

The shared half — the append-only record's invariants — moved to
[`lib/reqrecord.sh`](../lib/reqrecord.sh) rather than being copied. See that file's header,
and `test_reqrecord_shared.sh` for the gate that keeps the remaining duplication honest.

---

## The owner's model, and how it is encoded

> Requests must state **facts and reasoning**, not just an ask. Always stops for the owner:
> real money · deleting or rotating a credential · anything published outside the company ·
> anything with no rollback. Domain owner decides, CISO holds custody, two keys on the owner
> line.

### The classification is derived, never declared

There is no `--risk` flag, no `--reversible` flag, and no `--routine`. Passing one is a
refusal, not an override — a gate whose risk class is supplied by the party asking is not a
gate, it is a form.

The requester supplies **facts** (what is true) and **reasoning** (why this unblocks the
work). The **registry** supplies the class. They are kept apart on purpose, and every refusal
names which of the two refused.

The registry lives in `capability_gate.sh` as `CAPABILITY_REGISTRY`. Editing it is a reviewed
commit; there is no runtime path that adds an entry.

| field | meaning |
|---|---|
| `domain` | the `orgRoleId` that owns this capability and is therefore its responsible decider |
| `class` | `credential` \| `tool` \| `data` \| `spend` \| `publish` \| `infra` — `credential` is the custody class |
| `rollback` | `full` \| `partial` \| `none` — can the grant be taken back, and does taking it back undo the effect |
| `note` | why the entry is classified as it is. An entry nobody can explain is one somebody will quietly downgrade |

### The four owner-reserved rules

Every rule is evaluated — the classifier does not stop at the first — because *"why did this
stop for the owner"* has more than one right answer and the record should carry all of them.

| rule | fires when |
|---|---|
| `real_money` | `action == spend` or `class == spend` |
| `credential_destruction` | `action ∈ {rotate, delete}` **and** `class == credential` |
| `external_publication` | `action == publish` or `class == publish` |
| `no_rollback` | `rollback == none` |

Three more exist, and each closes a way the four above could be sidestepped:

| rule | fires when | why |
|---|---|---|
| `unregistered_capability` | the key is not in the registry | fail closed on authority: an unknown capability has no known domain owner, class or rollback, so there is nothing an agent could be deciding *on*. Open on process, though — the requester still has a path, and the remedy is a reviewed commit rather than a flag |
| `no_live_decider` | the domain owner's chain is entirely terminated | assigning a request to a corpse is a request nobody decides, and nothing reports it |
| `custody_conflict` | the two keys would collapse into one agent | see below |
| `requester_is_decider_at_root` | the requester owns the domain and has no live ancestor | the only remaining second pair of eyes is the owner's |

An **unknown action** is refused rather than classified. A verb the classifier has never seen
cannot be assessed, and `routine` is the one wrong answer.

### "Two keys on the owner line" does work

Read literally, and the third clause is not decoration. Where the two keys would collapse
into one agent — the CISO is the requester, or the CISO owns the domain — the request does
**not** fall back to one key. It becomes owner-reserved. Two keys means two principals; if
the org cannot supply the second, the owner is the second.

Custody is resolved by **template** (`B3_SECURITY_CHIEF`), not by role id, so re-seating the
CISO under a different `orgRoleId` does not silently vacate custody.

### Facts and reasoning have a floor

`--facts` and `--reasoning` are both required and both have a minimum length. This is a
**floor, not a quality check** — no threshold can tell an argument from a sentence. It exists
because `n/a` and `-` are what an unenforced required field collects, and a record full of
those cannot answer the question the owner asked it to answer.

---

## The lifecycle

```
submit ──► pending ──review(domain owner)──► approved            (one key)
       │                                └──► awaiting_custody
       │                                       └─countersign(CISO)─► approved
       │                                       └─countersign(CISO)─► rejected
       │            └──review --reject────────────────────────────► rejected
       └──► owner_reserved ──► no agent may decide. Waits in `owner-queue`.

any open status past expiresAt ──────────────────────────────────► expired
```

`pending` **and** `awaiting_custody` are open statuses and both age out. A request one key
approved and the other never touched is exactly as undecided as one nobody read, and if it
did not expire it would sit half-approved forever — TOG-390's failure mode reached by a
different road.

### Authority is re-derived at decision time

The decider recorded at submit is **informational and is never read when deciding**. Reviewing
re-runs the classifier against fresh state, which is what notices that the domain owner was
terminated, that custody vanished between the two keys, or that the ask now classifies as
owner-reserved. A decider derived at submit and trusted at approval is the TOCTOU bug
`org_request_queue.sh` already documents, arriving in a new file.

### An approval is not a grant

`capability_gate.sh` does not grant anything. An approved request is a decision record with a
named decider and a stated reason; something else acts on it. Because *"approved"* that
silently does nothing is its own trap, `list` and `thread` render an approved request as
**`approved (not yet effected)`**. Wiring execution is a separate change and needs its own
re-validation at grant time.

---

## The gap this tool inherits and does not close

`--requester`, `--reviewer` and `--custodian` are **unauthenticated flags**, exactly as
`org_request_queue.sh`'s are. Measured, not assumed — agent A0 did this in one shell session
against a scratch queue:

```
$ ./org_request_queue.sh submit --requester T0 --template C1_DIRECTOR_BUILDER --title "..."
SUBMITTED REQ-001  (T0 [B2_TECH_CHIEF] requests C1_DIRECTOR_BUILDER ...)  status=pending
  responsible leader : O1 [P1_PRESIDENT_COO] — will be woken to decide.

$ ./org_request_queue.sh review --reviewer O1 --request REQ-001 --approve --reason "..."
APPROVED REQ-001 by O1
```

A0 submitted as the CTO and approved as the President & COO. Separation of duties held only
because two different names were typed; nothing can tell that one process typed both.

**Therefore this tool is safe only when run by the operator, or reached through a transport
that derives identity from an authenticated principal and refuses to accept it as an
argument.** That transport exists — [`mcp/`](../mcp/README.md), TOG-196 — and today it
forwards the two *provisioning* tools only. Forwarding `submit`, `review` and `countersign`
is the follow-up, and until it lands, do not expose this tool to agents over any path that
lets the caller name itself.

### Why the approval authority cannot live in Paperclip

Measured against the running build on 2026-08-25, both native flows are **board-only** and no
permission grant of any shape changes that:

```
routes/secrets.js:54        assertCompanySecretWrite -> assertBoard(req)
routes/tool-gateway.js:470  POST /tool-gateway/action-requests/:id/approve -> assertBoard(req)
routes/tool-gateway.js:495  POST /tool-gateway/action-requests/:id/decline -> assertBoard(req)

as an agent: approve -> 403 "Board access required"
             decline -> 403 "Board access required"
             list    -> 403 "Board access required"
```

`tool_action_requests` was recommended for reuse on shape. It has a second, independent
disqualifier: rows are only ever created as a **side effect of an already-attempted tool
call** (`tool-access-policy.js:1253`, gated on `decision === "require_approval"` and
`NOT NULL`-bound to `invocation_id`). There is no entry point for *"I need capability X; here
are the facts"* — you cannot request a capability you do not yet have the means to invoke. It
models *approve-this-pending-call*, not *grant-me-this-capability*. Its 0 rows are not an
opportunity; the table is unused because nothing in this deployment routes to it.

---

## Running it

```bash
export COMPANY_ID=...                     # live, via lib/pcsql.sh
export ORG_SNAPSHOT=/path/to/org.tsv      # or offline, no database at all

./capability_gate.sh registry
./capability_gate.sh who --capability github.token --action grant --requester ENG
./capability_gate.sh submit --requester ENG --capability github.token --action grant \
    --facts "..." --reasoning "..."
./capability_gate.sh review      --reviewer  T0 --request CAP-001 --approve --reason "..."
./capability_gate.sh countersign --custodian S0 --request CAP-001 --approve --reason "..."
./capability_gate.sh thread --request CAP-001
./capability_gate.sh owner-queue          # exit 1 while anything is waiting
```

`owner-queue` uses the same cron/CI contract as `org_request_queue.sh`'s `overrides`: exit 1
when the list is non-empty, so a queue nobody drained is a finding rather than a file.
