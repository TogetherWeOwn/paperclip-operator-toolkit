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
`projectId`/`parentId` is refused. Finding writers must not use it.

**Live correction 2026-10-05 (retest): agent comment writes require a
heartbeat run context the systemd timer does not have.** The deployed
comment/update routes pass every agent write through the
cross-issue-influence gate, which answers `403
cross_issue_influence_run_context_required` when the caller carries no
`X-Paperclip-Run-Id` run. A durable bridge key fired runless from systemd
therefore reads the bound thread (`GET` parent and comments: `200`) but
cannot append to it (`POST .../comments`: `403`) — even assigned, even on
the bound card. That GET-200/POST-403 split is the run gate, not the
boundary, and no key-scope widening inside `task_bridge` changes it: the
gate fires before scope is even consulted.

Minimum supported contract under the EXISTING key, with no authority
change:

- The runless timer READS (bounded poller: parent plus comments) and
  PROPOSES (exit codes, stdout drafts, journal) — it does not board-write.
- The comment POST belongs to a RUNFUL routine: the CEO hourly routine,
  running inside a heartbeat with its run JWT, posts drafts and `filed:`
  mirrors onto the rollup thread with the same comment-only helper.
- If a runless board write is wanted anyway (timer-posted comments or
  child cards from systemd), that is a CEO/CISO design decision on the
  install chain — never a broader key, server relaxation, or credential
  substitution by inference. `POST .../children` was not live-probed and
  is not claimed as a runless path.

Incident cards stay the filing routine's to open — the timer never creates
or touches one, with or without a run.

## Comment-only writer (`post_rollup_comment.sh`)

`post_rollup_comment TAG TITLE BODY_FILE` posts one comment on the rollup
parent and creates nothing. The parent resolves at CALL time from
`PAPERCLIP_ROLLUP_PARENT_ID` with fallback to `RED_MAIN_ROLLUP_PARENT_ID`
(both must name the same bound card; the wrapper sources this file before
exporting the alias, so a source-time requirement would exit 1 before any
transport — live 2026-10-05). Refusals log the HTTP status plus the
server's sanitized error/code, and a run-gate `403` names the
heartbeat-run fix explicitly. Its contract:

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
  `curl` argv. Pinned by `test_post_rollup_comment.sh` (40 cases, stub API
  playing the deployed 403 and run-gate semantics, including the
  RED_MAIN-only clean-env order).

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
- (d) If both GETs answer `200` but the comment POST answers `403` naming
  the heartbeat-run gate (`cross_issue_influence_run_context_required`),
  stop: the thread, key and assignment are all correct and the runless
  timer has reached its supported limit (read/propose). Board writes move
  to the runful CEO routine; a runless-write change goes through the
  CEO/CISO chain. Do not repeat the POST probe.

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
3. Seeded checks before enabling: the offline suites
   (`./test_red_main_poll.sh`, expect `97 passed, 0 failed`;
   `./test_post_rollup_comment.sh`, expect `40 passed, 0 failed`), a live
   `snapshot`/`propose` against the parent thread with the runless key
   (reads `200`, zero company-wide calls, no draft for an already-mirrored
   tag), and one RUNFUL comment drill from the CEO routine's heartbeat
   (the runless timer never POSTs: expect the named run-gate refusal, not
   a phantom delivery, if one is attempted).
4. The filing routine must check the full board for the dedupe tag before
   opening an incident card: the poller's bounded search covers the rollup
   thread, not the whole board.
