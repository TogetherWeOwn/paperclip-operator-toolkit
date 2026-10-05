# Red-main poller: least-privilege bridge contract

The poller (`red_main_poll.sh`) has two board-read modes. Unattended timers
must use the bounded one: the deployed API unconditionally answers `403` to
the company-wide issue list for bridge keys, whatever the query, so the legacy
company-list mode needs a key permitted for company-wide reads and is not
suitable for a least-privilege timer credential.

## Bounded mode (required for bridge keys)

Set `RED_MAIN_ROLLUP_PARENT_ID` to the UUID of the pre-created rollup parent
card the key is bound to (alongside `PAPERCLIP_API_URL` and
`RED_MAIN_API_KEY`). The board read then uses only single-issue routes:

- `GET /api/issues/{parent}` — verifies the rollup thread exists;
- `GET /api/issues/{parent}/comments` — searches prior draft bodies and
  filed-key mirrors for dedupe tags.

It makes zero company-wide list calls. Entries carry
`boardRead:"parent-comments"` (vs `"company-list"`), so the filing routine
knows the incident search covered the rollup thread and still owns the final
dedupe check against the full board before opening a card. Any unreadable
thread (transport error, non-200, missing parent, unrecognised body) exits 3
with no snapshot and no drafts — never `incidentExists:false`.

## Compatible key body

A bridge scope with only an assignee allowlist is rejected by the key
validator: at least one project or parent boundary is required. Mint the
timer key parent-bound to the rollup card, assigned to the triage owner only:

```json
POST /api/agents/{triage-owner-agent-id}/keys
{"name": "red-main-poll",
 "scope": {"kind": "task_bridge",
           "parentIssueIds": ["<ROLLUP_PARENT_UUID>"],
           "allowedAssigneeAgentIds": ["<TRIAGE_OWNER_AGENT_ID>"]}}
```

## Compatible finding writes

Under a parent-bound key, a company-wide `POST .../issues` without
`projectId`/`parentId` is refused. Finding writers must not use it. The two
supported writes are:

- `POST /api/issues/{parent}/children` — a new card under the bound parent;
- `POST /api/issues/{parent}/comments` — coalesce onto the rollup thread.

Prefer comments on the rollup parent (one thread per finding kind): no board
search is needed to coalesce, so no duplicate cards. Incident cards stay the
filing routine's to open — the timer is propose-only and never creates or
touches one.

## Comment-only writer (`post_rollup_comment.sh`)

`post_rollup_comment TAG TITLE BODY_FILE` posts one comment on
`PAPERCLIP_ROLLUP_PARENT_ID` and creates nothing. Its contract:

- **Reads before writing.** It GETs the parent first and posts only when the
  parent is open (`backlog,todo,in_progress,in_review,blocked`). A missing,
  denied, misshapen or closed parent stops the write with zero comment POSTs.
- **Never assumes delivery.** Transport failure or any non-2xx returns
  non-zero with no success line; under the wrapper's `set -Eeuo pipefail`
  that fails the tick for retry instead of recording a phantom delivery.
- **At-least-once; the caller dedupes.** Every exit-0 call posted one
  comment; identical repeats are not skipped. Duplicate suppression across
  retry/restart is the caller's digest/cadence state, which must be recorded
  only after this helper succeeds.
- **First line is `TAG TITLE`** (bracketed tag, same convention as the
  shared finding helper), so thread reads find proposals and filed-key
  mirrors by substring. Empty bodies are refused up front.
- **Zero company-wide calls** by construction; key and body never reach
  `curl` argv. Pinned by `test_post_rollup_comment.sh` (26 cases, stub API
  playing the deployed 403 semantics).

## Live finding 2026-10-05: a bound root is not automatically readable

The host preflight proved it: with the key correctly bound to the rollup
(`parentIssueIds` carrying the rollup UUID, DevOps-only assignee allowlist),
both `GET /api/issues/{rollup}` and `GET .../comments` answered `403
{"error":"Issue is outside this actor's authorization boundary"}`. The
rollup was `todo` but **unassigned**, with no children. Bound-plus-unassigned
is outside the actor's boundary on both single-issue routes.

Two candidate gates, both fixed without minting, rotating, widening or
deleting the key:

1. **Assignee gate (supported by the evidence).** The key's
   `allowedAssigneeAgentIds` covers only the triage owner, and the refused
   thread was assigned to nobody. Assigning the thread to the triage owner
   is the narrowest fix.
2. **Root-vs-descendant gate (consistent, unproven).** The bound UUID may
   delimit the subtree *under* it rather than the card itself. If the
   assigned root is still refused, the supported fallback is a pre-created
   child thread under the bound rollup, assigned to the triage owner, with
   `RED_MAIN_ROLLUP_PARENT_ID` / `PAPERCLIP_ROLLUP_PARENT_ID` repointed at
   the child UUID. Same single-issue routes, same key, no scope change.

Operator retest protocol with the EXISTING key only (no new mint):

- (a) Assign the rollup to the triage owner, re-run both GETs. If `200`,
  the assignee gate was the cause: proceed with seeded/live checks.
- (b) Else create one child under the rollup assigned to the triage owner,
  re-run both GETs against the child. If `200`, repoint the env to the
  child and proceed.
- (c) If both still `403`, stop: the key's authority itself is insufficient
  and the change goes through the CEO/CISO chain -- never a broader
  standard/board/run-token substitute by inference.

Both scripts fail closed on any 403 (poller exits 3 with no fragment, writer
posts nothing) and their 403 lines now name this fix.

## Provisioning checklist (operator)

1. Pre-create the rollup parent card (open status) and **assign it to the
   triage owner before minting anything** -- an unassigned bound thread is
   refused (live 2026-10-05). Record its UUID. If the assigned root ever
   stays refused, pre-create one assigned child thread under it as the
   fallback transport and record the child UUID instead.
2. Mint exactly one bridge key with the body above; record the key id, never
   the value, in one 0600 env file with `RED_MAIN_ROLLUP_PARENT_ID` set.
3. Seeded checks before enabling: the offline suite
   (`./test_red_main_poll.sh`, expect `89 passed, 0 failed`), a live
   `snapshot`/`propose` against the parent thread, and one dry tick proving
   zero company-wide calls and no draft for an already-mirrored tag.
4. The filing routine must check the full board for the dedupe tag before
   opening an incident card: the poller's bounded search covers the rollup
   thread, not the whole board.
