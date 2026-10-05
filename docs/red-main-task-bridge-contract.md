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

## Provisioning checklist (operator)

1. Pre-create the rollup parent card (open status, assigned to the triage
   owner) and record its UUID.
2. Mint exactly one bridge key with the body above; record the key id, never
   the value, in one 0600 env file with `RED_MAIN_ROLLUP_PARENT_ID` set.
3. Seeded checks before enabling: the offline suite
   (`./test_red_main_poll.sh`, expect `89 passed, 0 failed`), a live
   `snapshot`/`propose` against the parent thread, and one dry tick proving
   zero company-wide calls and no draft for an already-mirrored tag.
4. The filing routine must check the full board for the dedupe tag before
   opening an incident card: the poller's bounded search covers the rollup
   thread, not the whole board.
