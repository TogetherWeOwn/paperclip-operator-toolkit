# Operator runbook — actions no agent can perform

> **This document is not a decision queue.** Every numbered line below is an
> action that has already been decided and that needs human hands, a human
> credential, or a click no agent holds. Nothing here is asking you to choose.

**The rule, for everyone, going forward:** if the answer is an action only a
human can perform, it is a runbook line. If the answer is a judgement only the
owner may make, it is a decision brief. Never file the first as the second.

Ordered by **blast radius**, highest first, so you can work down it in one
sitting: `1` changes a privilege boundary or a live credential · `2` changes
what runs or who can reach it · `3` a scoped grant to one agent · `4`
read-only.

| | count |
|---|---|
| Runbook lines (capability requests) | 2 |
| — of those, whose ONLY home is this document | 0 |
| Genuine decisions, correctly reserved | 0 |
| Misrouted — an agent can answer these | 0 |
| Retired since the last revision (recorded, not deleted) | 0 |

Generated from `operator_runbook_classification.json` by `operator_runbook.sh render`. Do not hand-edit — edit the classification file and regenerate. Validate it against the live board with `operator_runbook.sh check < pending.json`.

---

## Runbook lines

### 1. SAMPLE-WITHDRAWN — operator

> 🛑 **WITHDRAWN 2026-01-02 — DO NOT RUN ANY SCRIPT IN THIS SECTION.**
> The authorisation for this line was withdrawn. It is retained so the next operator does not read its absence as "never asked".

**Blast radius 1**

**What it changes.** A forbidden fork build; do not run.

**Verify.** Confirm the banner renders above the blast radius.

**Undo.** Not applicable.

**Exact commands.** WITHDRAWN — do not run these.

```
# "$script"
# echo do-not-run
```

### 2. SAMPLE-PLAIN — operator

**Blast radius 4**

**What it changes.** Nothing; this line exercises the non-withdrawn branch.

**Verify.** Read this fixture.

**Undo.** Not applicable.

**Exact commands.**

```
# echo sample
```

---

## Not runbook lines — genuine decisions

These name a reserved matter and stay in the decision queue. They are listed
here only so the queue can be reconciled against one document.

_None open._ Every decision previously listed here has been answered; each is
recorded in the retired section below with its outcome. This is not a statement
that nothing is reserved — the five reserved matters are unchanged.

---

## Not runbook lines — misrouted

No agent is blocked on the owner for these. Each reached the owner because its
author hand-typed `board_only`. They should be re-cut as `board_or_agents`
and answered internally.

_None open._ All three previously listed here were answered internally on
2026-08-27; see the retired section below.

