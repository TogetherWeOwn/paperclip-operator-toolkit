# Pacer concurrency targets

The slow-timescale half of the focused Capacity Orchestrator design: one
`maxConcurrentRuns` target per agent, recomputed from each subscription
account's weekly + 5h headroom. The fast half — per-run admit/hold with
atomic SQL CAS reservations — is a separate design and needs a
run-model/admission hook that the deployed host image does not carry, so
per-run admission stays advisory until a release carries it.

## What decides what

| Question | Owner | This tool |
|---|---|---|
| Which MODEL does a run use? | model-selection (chooser inside the envelope) + host fleet-quota-balancer (model choice only, temporary) | Untouched. No pin, weight, or lane read/write. |
| May this run START now, or hold with retryAfter? | Capacity Orchestrator fast path (blocked on host hook) | Advisory only: `lanes[].admission` in the plan. Shadow, no effect. |
| How many runs may this agent hold at once? | This reconciler (`pacer_concurrency.py`) | Target per agent, applied via the board API. |

`quota_brake.sh` stays as the emergency brake: it only ever moves
down-and-restore from the pooled quota-pacing signal. This
reconciler moves both directions per agent from per-account lane
headroom, with hysteresis and cooldown so the two cannot fight: the
brake's ladder reacts in minutes to pool burn; the reconciler steps
+-1 per decision with a 30-minute dwell. When both fire, the LOWER
target wins at apply time (the applier takes the min), because
overshooting quota costs delivery while undershooting costs only pace.

## Coexistence with the temporary controls

1. **Operator overload caps** (`--caps` JSON): a hard ceiling per agent.
   Scale-up without a caps entry only restores toward the agent's own
   baseline; above-baseline is an operator edit to the caps file, never
   an inference. Caps above 32 are refused, not clamped.
2. **Host fleet-quota-balancer**: model choice only. It keeps running
   unchanged while the reconciler owns concurrency. Once per-run
   admission is enforced from the fork release, the balancer's role
   reduces to tie-breaking between equally-admissible models, then
   retires — that retirement is its own change, not this one.

## Shadow first, then enforce

1. **Shadow (default, `--mode shadow`)**: emit targets with
   `effect:"none"` for >= 1 full 5h window across the Claude, Codex and
   Meta lanes. No board write exists in the code path (pinned by test:
   no urllib/requests/curl/token/API string in source).
2. **Agreement**: `pacer_concurrency.py --audit <pacer-admission-audit.jsonl>
   --events <429s.json>` reports coverage of shadow holds against
   observed 429/exhaustion events. Advance to enforce only when holds
   cover the events that mattered (uncovered events are listed by lane).
3. **Enforce**: `--mode enforce --yes` emits per-move PATCH intents.
   The applier MUST read each agent's full `runtimeConfig` and write it
   back whole (quota_brake.sh rule 1: PATCH replaces, never merges),
   and MUST take min(reconciler target, brake target) when both exist.
4. **Kill switches**: `--frozen-lanes lane,...` pins named lanes to
   nochange in both modes (unknown names are refused, so a typo cannot
   silently freeze nothing). Rollback is
   `--mode enforce --yes --rollback`: restore-to-baseline intents.

## Never

- Cancel, kill, or terminate a run. The output vocabulary has no such
  key (pinned by test); slowing down is `maxConcurrentRuns`, which
  queues work instead of discarding it.
- Scale on unmeasured data. Unknown/stale/missing lane windows hold the
  target (exit 5 when nothing at all was measurable).
- Touch `wakeOnDemand`, daily caps, model pins, or selection mode.
