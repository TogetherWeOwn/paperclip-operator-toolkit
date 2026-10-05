# Verb census — 46 open Operator cards classified by host action (2026-09-26)

Source: `GET /api/companies/{id}/issues?q=Operator` (409 operator-titled cards total; 46 open: 27 blocked, 1 in_progress, 1 in_review, 17 todo, 2 backlog).
Baseline: 46 open today; 403 created in the last 30 days ≈ 13.4/day, but dominated by batch-filing bursts (41 on 09-05, 44 on 09-06, 62 on 09-16 — sweeps, not organic flow). The 7-day before/after comparison should use the 7 days immediately pre-live, not this average.

## O4 bound (authoritative, recorded 2026-09-22)

Exactly six write verbs: `plugin.install` / `plugin.restart`, `unit.install`, `cliproxy.apply` (NO OmniRoute lifecycle — retired for agents), `coolify.env.set`, allow-listed `script.run`. Exclusions: no blanket shell/root, no secret export/rotation (**no key rotation, ever**), no custom image. Writes stay disabled until: approved versioned allow-list + per-request authorization + rollback evidence + operator install package + O4 record all hold.

## Classification

### A. Broker-eligible host writes — 11 cards (covered by the O4 six)

| Verb | Cards | What they ask for |
|---|---|---|
| `plugin.install` | 2 | Versioned install plus `package_path` repoint; plugin update plus `refreshAaIndex` proof |
| `unit.install` | 2 | Host DB-backup timer; host-cron timers plus systemd units |
| `cliproxy.apply` | 2 | cliproxy-insight install plus polling; wire the collector into the host CLIProxy collector |
| `script.run` (pinned SHA) | 5 | Staging segcache plus fixture acceptance; staging smoke probe; three staging/authenticated endpoint probes |

### B. Proposed 7th verb (read-only): `logs.read` — 1 card

One card (a read-only plugin-log extract for a balancePass window) needs a bounded service-log tail: fixed unit/service name from an allow-list, `--since` window cap, line cap, secret-redacted output. Read-only like Phase-0; for CISO review as a lower-bar addition.

### C. Stay human — 34 cards (no verb proposed)

- **Discord portal/guild actions — 18.** Nine bot feature activations, a live-fire drill, a two-human window, a goodbye hot-wire (the re-drive step needs a live leave event), one card on HOLD, and five other portal/guild actions. These need the owner's session or the Discord developer portal — no broker verb can or should reach them.
- **Credentials — 5 (never brokered).** One of them is a token revoke.
- **Upstream PR clicks — 3.** Fork-stage plus owner click; stays human.
- **GitHub admin (App 403s) — 1.** Ruleset swap plus merge.
- **Tenant/infra decisions + parked — 5.** Off-site backup provider, docker-socket isolation, owner console, one card in_progress, one card PARKED.
- **Board/config data — 2.** Repricing roster rows (agent-doable in-board, not a host verb) and a mint-budget config change.

## CTO finding

The O4 six cover the **host-action slice** (≈26% of today's queue: 12/46 with `logs.read`). They do not cover the Discord-portal slice (≈39%), which is the actual queue bulk — that slice needs owner-session automation or portal delegation, a separate card, not broader broker verbs. Do not widen the broker to chase it.

## Proposed ≤4h slices (planner creates these, not CTO)

- **Slice A:** `logs.read` spec + tests + transport tool (read-only; no O4 change).
- **Slice B:** MCP transport one-tool-per-verb for the approved write verbs (after the transport is live).
- **Slice C:** allow-list manifests v1 (plugin/unit/script pins) + rollback-evidence harness (after two prerequisite cards land).
- **Slice D:** end-to-end receipt acceptance per verb + 7-day metric post.
