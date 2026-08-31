# TOG-750 — the delivery mechanism cancelled exactly the case it existed to serve

**Status:** fixed. Patch written, typechecked, mutation-gated, and proven by a
run row rather than by reading the code. Landing it upstream is a separate step
— see §8. The 12 stranded interactions were disposed of live — see §6.

---

## 1. The defect

An interaction created with an `addresseeAgentId` fires a wake with
`reason: "interaction_pending"` (`server/dist/routes/issues.js:8459`). That wake
has produced 125 runs and **every one was cancelled**. Reproduced against the
live control plane rather than taken from the card:

```
context_snapshot->>'wakeReason'   succeeded  cancelled
interaction_pending                       0        125
    111 issue_assignee_changed · 12 issue_dependencies_blocked · 2 other
issue_commented                         778          —   <- control
issue_comment_mentioned                  93          —   <- control
```

The two controls travel the same gate and behave correctly, so this is not a
broken wake pipeline. It is one exemption that does not cover one reason.

## 2. Root cause

The non-assignee cancel fires when `issue.assigneeAgentId !== run.agentId`,
exempting three cases. The interaction arm is `allowsIssueInteractionWake`:

```ts
const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
if (!wakeReason || !ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS.has(wakeReason)) return false;
return Boolean(deriveCommentId(contextSnapshot, null));
```

An addressed-interaction wake fails **both** clauses. The set holds only
`issue_commented`, `issue_reopened_via_comment`, `issue_comment_mentioned`; and
an interaction is not a comment, so there is no comment id to derive.

**An interaction addressed to a reviewer is by construction addressed to a
non-assignee.** So the mechanism cancels precisely the case it exists to serve.
The other exemption, `isCurrentReviewParticipant`, reads
`issue.executionState.currentParticipant`, which is commonly NULL.

**Why this is worse than a dropped wake.** The interaction stays `pending`
forever — it is never expired. The board renders an undeliverable question
identically to an unanswered one, and `blockerAttention` then reports the issue
`covered`. Nobody is waiting on anybody, and it looks like somebody is.

## 3. Why the proposed fix was wrong, twice

The card proposed adding `interaction_pending` to the set and keying the
exemption on `payload.interactionId`. That fails two ways, and both are the
reason this patch is shaped differently:

**It is forgeable.** `enrichWakeContextSnapshot` copies a caller-supplied
`reason` straight into `contextSnapshot.wakeReason`
(`server/dist/services/heartbeat.js:3710`), and `POST /agents/:id/wakeup`
accepts a free-form `reason` and `payload` on a self-wake (`wakeAgentSchema`,
`packages/shared/dist/validators/agent.js:139`). A context-only check hands
**any agent a bypass of the assignee gate for any issue in its company** — it
just names a wake reason and an interaction id. The exemption would be worse
than the bug.

**The set is shared.** `ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS` also gates
the issue-tree pause-hold bypass through
`isVerifiedIssueTreeControlInteractionWake`
(`server/dist/services/issue-tree-control.js:88`). Widening it would let an
addressed interaction run inside a **paused tree**. A paused tree must stay
paused whether or not someone has addressed a question into it.

## 4. The fix

A separate exemption, `allowsAddressedInteractionWake`, in which the interaction
id is **only ever a lookup key**. Every clause that grants the exemption is read
from the interaction row:

| clause | read from | why |
|---|---|---|
| wake reason is `interaction_pending` | context | cheap gate; not evidence |
| a matching interaction row exists | **DB** | absent row ⇒ forged |
| `status === "pending"` | **DB** | a resolved question is not a standing reason to run |
| `addresseeAgentId === run.agentId` | **DB** | deliver to whom it was asked, nobody else |

Applied at **all three** sites that cancel on this basis, not just the headline
one:

1. the dependency-blocked cancel in `claimQueuedRun` — **12 of the 125 died
   here**, before the assignee gate is ever reached. A fix applied only to the
   assignee gate leaves those dead. A blocked issue is exactly where an
   addressed question needs answering.
2. the non-assignee assignee gate — the remaining 111.
3. the pre-queue `blockedInteractionWake` check.

At the assignee gate it is evaluated **last**, after every cheap in-memory arm
has declined, so the common path never pays for the read.

## 5. Measured, by execution

**Differential at one object** (AC 2) — same interaction shape, same test, the
unfixed source vs the fixed source:

```
before   1 failed   AssertionError: expected 'cancelled' to be 'succeeded'
after    29 passed
```

The `before` row is the point: the new test is red against the current code, so
the green afterwards is a behaviour change and not a tautology.

**A run row, not a code reading** (AC 1). The tests boot a real embedded
Postgres and assert on `heartbeat_runs.status` / `errorCode` / adapter execute
count. This host supports that harness (`{"supported": true}`), which matters
because the suite's own `describeEmbeddedPostgres` degrades to `describe.skip`
where it doesn't — and **a skipped suite is green**. The gate refuses rather
than scoring that.

**No regression** (AC 5): 29/29 in the touched file (24 pre-existing), and
149/149 across the adjacent heartbeat, tree-control and interaction suites.
`tsc --noEmit` clean.

### Proving the tests can fail (AC 3)

`verification/tog-750-mutation-gate.sh` — **9 passed, 0 failed**.

Both directions are covered, because a suite that only caught under-delivery
would score full marks against an exemption that lets anyone run anywhere:

| mutant | direction | result |
|---|---|---|
| revert the exemption at the assignee gate | under | killed |
| revert the exemption at the dependency gate | under | killed |
| wake reason constant no longer matches | under | killed |
| **trust the context instead of the row** | over | **killed** |
| ignore the addressee | over | killed |
| ignore the interaction status | over | killed |
| fail open when the interaction row is absent | over | killed |
| **interaction lookup unscoped by issue** | **decoy — must stay green** | **green** |

The fourth mutant is the one that matters. It is *the fix the card proposed*,
and it passes every "does the addressee get its run" test. Only the forgery
test — which seeds **no interaction row at all** and a random `interactionId` —
can tell the two implementations apart. Without that test the suite would not
constrain the implementation, and the shape of this patch would be unjustified.

The second mutant earned its place too: the dependency-gate call site had no
coverage until a fifth test was added for it, and the mutant survived until then.

**The decoy is what makes the kills mean something.** It is deliberately a real
narrowing — dropping the issue predicate from the lookup — and the fact that
this suite cannot see it is recorded here rather than hidden. The company,
interaction-id and addressee predicates still bound the lookup.

The gate **never writes to `/app`**: it symlinks a shadow tree, applies the
patch into it, and mutates only that. Verified after the run — both files
byte-identical, `find -newermt` reports nothing written.

## 6. The stranded interactions (AC 4)

The card listed 13. Live query found **12** — TOG-549's resolved to `accepted`
at 2026-08-31 00:21Z, after the card was written. Of the 12, **2 are in a
different company** (GST-8, GST-30, both addressed to a CTO whose agent status
is `error`); cross-company access returns 404, so they are out of my reach and
are called out here rather than silently dropped.

**Expiry was not available to me.** `POST …/interactions/:id/withdraw` allows
only the interaction creator, the current issue assignee, or a board user. I am
none of those for any of the 12 — probed and confirmed `403`, with
`updated_at` unchanged afterwards proving no write. `…/cancel` is board-only and
explicitly rejects agent actors. So **delivery** was the available disposition,
via the one path that verifiably wakes a non-assignee: a single-mention comment.

Each comment quotes the original question verbatim, names the interaction id,
states that the question is unchanged and only its delivery failed, and does not
re-ask it. Agent comments do **not** supersede: `expireRequestConfirmationsSupersededByComment`
requires `authorUserId` **and** no `createdByRunId`, so a run-authored comment
cannot expire the question it is delivering. Verified — all three of the first
batch were still `pending` with untouched `updated_at` after posting.

Delivery verified by reading the wake and run rows, never assumed:

| card | addressee | delivery | interaction outcome |
|---|---|---|---|
| TOG-43 | Engineering Manager, Web Platform | `claimed` → running | pending, with the addressee now running |
| TOG-227 | Chief of Staff to Owner | run `succeeded` | pending |
| TOG-565 | Director of Engineering | `queued` | pending |
| TOG-598 | Test Automation Engineer | deferred → promoted → running | **cancelled** by the addressee |
| TOG-621 | President & COO | deferred → promoted → running | **accepted** by the addressee |
| TOG-649 | Chief Audit & Agent Risk Officer | deferred | **cancelled** by the addressee |
| TOG-681 ×2 | President & COO | `claimed` → running | pending (duplicate pair) |
| TOG-713 | Director of Engineering | `queued` | pending |
| TOG-736 | Director of Engineering | `claimed` → running | pending |

Three were resolved by the woken addressee within minutes of delivery — which is
the strongest available evidence that these were live questions that had simply
never arrived, not stale ones.

Two findings worth recording:

- **TOG-681 holds two identical interactions**, created 26 seconds apart. The
  duplicate is a symptom of the bug: the first wake vanished, so a retry looked
  like the right response. The delivery comment says so and asks for one to be
  resolved as a duplicate.
- **A `deferred_issue_execution` wake does promote.** My prior record said 29
  attempts had produced 0 runs. Measured here, TOG-621 and TOG-598 both went
  `deferred` → `issue_execution_promoted` → `running`. The earlier reading was
  a snapshot of wakes that had not yet promoted, not a permanent property.

## 7. Files

| Path | What |
|---|---|
| `patches/TOG-750-addressed-interaction-wake.patch` | the fix + 5 tests |
| `verification/tog-750-mutation-gate.sh` | 9 mutants incl. the decoy; exit 0 clean · 1 survivor · 2 refused |

Reproduce:

```sh
./verification/tog-750-mutation-gate.sh        # 9 passed, 0 failed
```

Verification performed on the patch itself:

- `git apply --check` clean against **pristine** `/app` sources, and the patched
  tree hashes **byte-identical** to the tree the 29 tests actually ran against —
  so the artefact in this repo is the artefact that was measured.
- `tsc --noEmit` clean on the staged tree.
- `/app` never written: `find /app/server/src -newermt <gate start>` empty, and
  both source files still carry their original 2026-08-18 mtimes.

## 8. What this does not do

**It is not deployed.** `/app/server/dist` is what actually runs, and this repo
holds the fix as a patch — the same standing gap as
[`merged-plugin-code-is-not-deployed-code`]. No host mutation, deploy or
activation is authorized by this card, and none was performed. Until it lands
upstream and is built, **addressed interactions still do not wake anybody**, and
the mention-comment workaround remains the only delivery path.

It does not reach **GST-8 and GST-30** — different company, 404 to this agent.

It does not change `supersedeOnUserComment`, which is a separate contributor to
interaction attrition and is independent of this defect: the 125 cancelled wakes
all had it `false`.
