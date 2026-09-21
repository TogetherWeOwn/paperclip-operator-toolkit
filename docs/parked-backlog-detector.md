# Parked backlog detector — TOG-3728

## Delivery boundary

TOG-3728 plan revision 2 accepts **detector-only** delivery following the CTO
ruling on TOG-3742 and Director reconciliation on TOG-3747. The actual promotion
caller has no established authorized source/read-path. Its pre-PATCH integration
is **unsupplied and closed as unachievable under that boundary**, not silently
waived or simulated. Reopen integration only under a new task if a platform
read-path becomes available.

This CLI neither patches status nor grants promotion nor automatically unparks.
A passing detector run or CI job does not demonstrate sweep deployment, a change
in scheduling behavior, or reduced park/reactivation recurrence. No host access,
live-card promotion, or upstream publication is part of this delivery.

## Authority rule

Retain documented parks by default. An authoritative unpark requires an explicit
human/CTO-authored decision **on the parking-authority card**. The responsible
agent must separately verify the decision's source, authorship, scope and
applicability to the parked card, and record its exact comment/document reference.
A statement copied into the candidate thread or an identity claimed in text is
not that verification. This tool deliberately provides no override flag.

Never treat any of these alone as authority:

- A `user`-actor status PATCH, including `authorizationReason=allow_board_actor`.
- A generic operator/sweep promotion comment.
- An activity row with `runId=null`.
- A newer unrelated agent or user comment, or a candidate's current status.

Read-only investigation established that `/api/issues/{id}/activity` exposes
`issue.updated` rows with `details.changes.status.{from,to}`. For example,
TOG-3303 activity `8c98e5d2-8499-4c83-99b8-6fa12a960078` recorded a user-actor,
null-run promotion at 2026-09-20T05:24:09.507Z; it did not establish an explicit
unpark. The activity feed's retention/pagination completeness remains unverified.
The detector does not consume or validate it. The TOG-3738/3742 investigation
found no explicit authority-card unpark for the measured burn-cap example.

## Interface and limits

```sh
node scripts/parked_backlog_guard.js --selftest
# Trusted local fixture command only; this environment variable executes a shell.
PARKED_GUARD_SOURCE_CMD='cat /path/to/fixture.json' \
  node scripts/parked_backlog_guard.js --json
```

The fixture is an object with `backlog` and `comments` arrays. Candidates use
`identifier` (or `id`) and `description`. Comments use matching `issueIdentifier`
(or `issueId`), `authorType`, `authorAgentId` for agent comments, `body`,
`createdAt`, and optionally `deletedAt`. Missing or malformed evidence, including
any candidate without a non-deleted comment, yields `UNKNOWN` rather than a
no-signal result. Comments on a different card cannot cover a missing read.

The database adapter requires `DATABASE_URL` and `PAPERCLIP_COMPANY_ID`, sets
Postgres's default transaction read-only, and scopes both queries by company.
`--all-companies` deliberately removes that scope and is not needed for normal
usage. Live SQL/schema compatibility has **not** been exercised in this delivery;
no database or host access was used. Do not interpret fixture verification as a
live database measurement.

| Exit | Verdict | Meaning |
| --- | --- | --- |
| 0 | `NO_PARK_SIGNAL` | No recognized signal in supplied prose; **not permission to promote**. |
| 1 | `PARKED` | A park signal exists; retain the park pending separate authority verification. |
| 2 | Usage error | Invalid CLI/configuration; no scheduling conclusion. |
| 5 | `UNKNOWN` | Empty, malformed or unavailable evidence; no scheduling conclusion. |

Every JSON report includes `mode: "detector-only"`,
`promotionAuthorized: false`, and `schedulingEvidence: "not-verified"`.
Source-command/JSON/database exceptions produce a redacted `UNKNOWN` report,
never raw command text, input contents or exception messages. Successful park
reports quote prose evidence; handle that output as potentially sensitive issue
content rather than publishing it indiscriminately.

All non-deleted agent park comments are considered, even beneath newer notes.
Description evidence is independent of the newest commenter. User prose alone
is not a park signal. Topic words such as `non-product`, `burn cap`, `burn-cap`,
`lane optimization` and `standing cap` are not sufficient by themselves.

This remains a conservative substring detector: an agent merely discussing or
negating "parked" can be flagged; a park expressed without any recognized marker
can be missed. No natural-language completeness or authority classification is
claimed. Internal `classify().verdict === "queuable"` is a legacy label for no
prose signal, not a scheduling decision; consumers must not use it as approval.

## Verification and landing

```sh
bash test_parked_backlog_guard.sh
node verification/tog-3728-mutation-gate.cjs
```

The offline CI job runs both commands. The mutation gate copies source and tests
to a private temporary directory, proves an unmodified baseline, requires each
parse-valid mutant to fail its named test, and proves the restored copy passes.
It never mutates checkout source. Historical TOG-3230/3303 fixtures are inert:
TOG-3230 is done and must not be reactivated for testing.

Landing requires independent Code Reviewer approval naming the exact head SHA,
green required CI on that head, and merge by a non-author. A new push invalidates
that review. The contributing Director must not self-merge either. Register the
PR, merged commit and verification evidence on the task before completion.
