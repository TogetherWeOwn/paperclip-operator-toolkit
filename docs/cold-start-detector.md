# The cold start — post-incident review, and the detector that comes out of it

**Incident:** 2026-08-25. An 89-minute quota drain became a 5.5-hour outage.
**Issue:** TOG-487. The drain itself is TOG-477; this is about why the company never came back.
**Tool:** [`cold_start_detector.sh`](../cold_start_detector.sh) · suite `test_cold_start_detector.sh` ·
mutation gate `verification/tog-487-mutation-gate.sh`.

Every figure below was queried directly against the live database while writing this, not
carried over from a summary. Where a re-measurement disagreed with the issue that commissioned
the work, the disagreement is stated rather than smoothed over.

## Timeline

| Time (UTC) | What happened | How it is known |
|---|---|---|
| 09:43:20 | First run dies `429 All 2 accounts exhausted` | `heartbeat_runs`, `error like '%exhausted%'`, company-scoped |
| 09:43–13:41 | **202 runs** die the same way. **Zero** schedule a retry | `count(*)=202`, `count(scheduled_retry_at)=0` |
| 10:48:16 | Recovery starts opening `stranded_assigned_issue` actions | `issue_recovery_actions` |
| 13:41:17 | Last dying run. The company goes silent | `max(created_at)` over the 202 |
| **15:15:12** | **Quota headroom returns**: one account reports `five_hour = 0`, `pool_verdict = ON_PACE` | `quota-pacing.jsonl` |
| 15:45:21 | The detector in this repo would have fired here | replay, below |
| 17:07 | The company resumes — by hand | `heartbeat_runs` |
| 17:10–17:13 | 17 stranded actions are **cancelled**, not resolved | `status='cancelled'`, `outcome='cancelled'` |

**3h20m of the outage happened after the quota was already back**, and nothing was watching for it.

### Two corrections to the commissioning issue

- It reports headroom returning at **15:45Z**; that is when *both* accounts read zero. Under the
  detector rule it actually commissioned — `five_hour < 0.10` on *at least one* account with
  `pool_verdict != BEHIND` — headroom began at **15:15:12Z**, thirty minutes earlier.
- It reports **38** recovery actions. Counting `stranded_assigned_issue` rows created between
  10:48:16Z and 13:41:17Z gives **49**. 38 was a point-in-time reading; neither number is wrong,
  but the larger one is the size of the backlog.

### And one thing nobody has looked at yet

Of the actions that left `active` after the company restarted, **17 were `cancelled`, not
`resolved`** (17:10:21Z–17:13:08Z, `outcome='cancelled'`). The backlog was largely discarded
rather than worked. "The company recovered" and "the stranded work got done" are different
claims and only the first is currently true. That is not in this tool's scope and is worth its
own issue.

## Root cause: the retry path exists and could not arm

The platform has both a `provider_quota` retry path and a classifier for this exact failure
body. Neither fired. The reason is one function, read in the running build's own source:

| File:line | What it does |
|---|---|
| `services/heartbeat.ts:548-566` | `readHeartbeatRunErrorFamily()` returns a family only if `resultJson.errorFamily` is already set, or `errorCode` is one of `provider_quota`, `codex_transient_upstream`, `claude_transient_upstream`, `codex_harness_crash`. |
| `services/heartbeat.ts:11081-11083` | `transientRecovery` is that function's result. |
| `services/heartbeat.ts:11444-11470` | The retry wakeup builds `providerQuotaRetryNotBefore` only when `transientRecovery?.errorFamily === "provider_quota"`. |
| `services/heartbeat.ts:15832` | The only place a run's `errorFamily` is stamped at failure time: `adapterResult.errorFamily ?? null`. |
| `grep -rn errorFamily /app/server/src/adapters/` | **Returns nothing.** No adapter on the ACP lane emits the field. |

All 202 runs carried `error_code='acpx_turn_failed'` and `result_json->>'errorFamily' IS NULL`, so
`readHeartbeatRunErrorFamily` returned null for every one of them and the retry could never arm.

The classifier at `services/recovery/service.ts:3588` *does* map this body to `provider_quota` —
`services/recovery/teamclaude-quota-recovery.test.ts:31-45` asserts exactly that, for exactly this
error code. But it is read for recovery bookkeeping and never written back onto the run, so the
scheduler's view of the family stayed null. **The classification happened in the wrong layer to
arm a retry.**

Both layers are `/app/server/src` — the Paperclip platform, not this repo. We cannot patch the
scheduler. Hence a detector here rather than a fix there.

## What the detector does

```bash
./cold_start_detector.sh detect --explain    # 0 quiet · 3 ALARM · 5 could not measure
./cold_start_detector.sh plan --max 12       # capped, ordered re-drive — PRINTS ONLY
```

It fires `cold_with_headroom` when all three hold:

1. an account's five-hour window reads `<= 0.10` **as a JSON number**, with `pool_verdict != BEHIND`;
2. that has been continuously true for at least 20 minutes;
3. `runs_in_flight` is 0 and at least one active recovery action has been untouched for 20 minutes.

### Replayed against the real feed

Driving the tool over the actual `quota-pacing.jsonl` and the actual recovery actions,
point-in-time:

| Clock | Verdict | Exit |
|---|---|---|
| 14:30 | `quiet / no_headroom` | 0 |
| 15:00 | `quiet / no_headroom` — **the null-reading sample** | 0 |
| 15:15 | `warming / headroom_too_new` | 0 |
| 15:30 | `warming / headroom_too_new` (15m held) | 0 |
| **15:45** | **`cold_with_headroom`** | **3** |
| 16:45 | `cold_with_headroom` (90m held) | 3 |

**First alarm 15:45:21Z against a hand-restart at 17:07Z: 1h22m of lead time.**

## The three refusals, and why each is load-bearing

**A null five-hour reading is not zero.** `[[ "" -eq 0 ]]` is TRUE in bash. The real feed carries
`five_hour: null` at 15:00:11Z (`[1, null]`) and again at 15:45:21Z (`[null, 0]`). A detector that
coalesced null to zero fires at 15:00 — 45 minutes early, off a hole in the data. The check is
`type=="number"` inside jq so the value never reaches a shell comparison. Note it must hold in
*both* directions: rejecting every record containing any null would also reject 15:45:21Z, which
is genuine headroom, and would have cost 15 minutes.

**A stopped pacer is not an absence of headroom.** If the pacer dies mid-outage its last record
says `THROTTLE` forever, and a detector keyed on "the newest record" stays quiet precisely when
the company is darkest. A newest sample older than 30 minutes is exit 5, never 0.

**A source that did not answer has not reported a clean company.** Every count is validated as a
decimal integer before any comparison, because `(( "" > 0 ))` is false and would report zero
stranded actions from a source that never ran.

## Two limitations, stated rather than hidden

**`runs_in_flight > 0` suppresses the alarm, and that is a known false negative.** It is the
contract TOG-487 asked for and it is implemented literally, but during this outage the only runs
in the dark window were the watchdog's own review issues — so a single watchdog run coinciding
with a pacer sample would have masked a company that was otherwise entirely stopped. When the
recovery half fires and this gate swallows it, the tool prints `SUPPRESSED:` with its counts to
stderr rather than collapsing into a bare "quiet". Tightening it needs a measure of "work the
company chose to do" that can tell a watchdog from a workforce, and we do not have one.

**`plan` writes nothing, deliberately.** The storm that drained the quota ran at ~0.30 wake/15min
per account with 28–47 runs in flight, against a sustainable ~0.05/15min; a detector that fanned
out on its own trigger is a louder version of the drain it detects, and it would do so at full
power on a false positive. An agent cannot wake a peer directly in any case —
`POST /agents/:id/wakeup` is self-only at `routes/agents.ts:3599-3605` — so the working mechanism
is a mention comment, which is a write to somebody else's issue thread and belongs behind a human
reading the plan.

`plan` orders targets by how many stranded issues each owner holds. On the real data that puts
the President & COO first (13) and the CTO second (5), which is the dispatch-owner preference
TOG-487 asked for — reached from the data rather than from a hardcoded role list, so it stays
correct across a reorg.

## Where this is not deployed

Nothing runs this on a schedule. Landing it makes the detector exist and provable; it does not
make anything watch. The tool is cron-shaped on purpose — read-only, distinct exit codes, `3`
meaning "alarm" — but wiring it to a timer needs a host-side crontab this repo does not own.
**Until that happens, a green CI badge here means the detector works, not that anyone is
watching.** Same caveat, and for the same reason, as `tool_drift.sh` and `channel_drift.sh`.
