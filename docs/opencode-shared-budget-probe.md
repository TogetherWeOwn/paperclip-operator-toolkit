# Is the paid OpenCode budget shared across lanes?

**Issue:** TOG-894 ask 2. **Prior art:** TOG-845 (the single-lane trace that raised the question),
TOG-842 (a lane catalogue whose "19/23 verified" turned out to be a sampling artifact of this
same throttle).
**Tool:** [`opencode_shared_budget_probe.sh`](../opencode_shared_budget_probe.sh) · suite
[`test_opencode_shared_budget_probe.sh`](../test_opencode_shared_budget_probe.sh).

Every figure below was measured against the live gateway on 2026-09-03 while writing this.

## The question, and why the obvious probe cannot answer it

TOG-845 probed one `opencode-go` lane and watched `401 Missing API key` come and go on a
credential that was demonstrably serving:

```
opencode-go/qwen3.6-plus  401 Missing API key    x6  consecutive  (90s)
opencode-go/qwen3.6-plus  OK model=qwen3.6-plus  x18 consecutive  (next 255s)
```

That is enough to prove the throttle is real and the string is a lie — TOG-894 ask 1, now fixed
in the platform classifier. It is **not** enough for ask 2. A single-lane trace cannot separate:

| Hypothesis | What it looks like on one lane | Correct control surface |
|---|---|---|
| **(a) per-lane limit** | throttle, recovery | a per-lane enable/disable flag |
| **(b) shared budget** | throttle, recovery — *identical* | capacity; the flag is **harmful** |

The consequences are opposite. Under (b), disabling a "broken" lane moves the same demand onto a
sibling drawing the same pool, so the flag makes things worse while looking like a fix.

## The discriminator is coincidence in time, not failure count

The intuitive measurement — count failures per lane — **cannot separate the two hypotheses at
all**, because both eventually produce failures on every lane. What differs is *when*: a shared
pool makes several lanes fail in the **same round**; a per-lane limit scatters them.

So the probe samples several distinct `opencode-go` model **families** in a tight round, over many
rounds, and reports the distribution of "how many lanes throttled simultaneously". Distinct
families, not aliases: two aliases of one model could share an upstream limit for reasons that say
nothing about our budget.

Sections 1 and 2 of the suite feed a known-shared and a known-per-lane world with the **same
number of throttles** and demand different verdicts. A tool that counted failures passes neither.

## The control must be cross-provider

An in-namespace control cannot distinguish "opencode budget exhausted" from "the gateway itself is
unwell" — both make every opencode lane fail at once, which is exactly the signature being tested
for. Each round therefore also probes `cliproxy/claude-haiku-4-5-20251001`, a different credential
on a different provider. **A round whose control also failed is excluded** from the coincidence
arithmetic rather than counted as a shared-budget hit. Without that exclusion a gateway blip reads
as proof of a shared budget.

## What "throttle" means here, precisely

The probe classifies on the **same discriminator the shipped platform classifier uses**
(`GATEWAY_CAPACITY_THROTTLE_RE`, TOG-894): the gateway's `[provider/model] [status]:` prefix, which
is only present once a request was routed upstream — i.e. after our own credential was accepted.

Matching on `missing api key` alone would fold a genuinely absent local key into the capacity
count, which is the original TOG-894 defect wearing a different hat. Suite section 6 pins this.
Deliberately keeping the two regexes the same shape: **if the platform regex changes, change this
probe with it.**

A deterministic upstream fault is not capacity. `opencode-go/gpt-5.6-luna` returns a hard 500;
TOG-845 filed that very response as a missing-credential fault. It is reported as `OTHER` and never
enters the throttle count (section 5).

## Result of the first run — an honest inconclusive

Measured 2026-09-03 23:38–23:46Z, 16 rounds × (4 lanes + 1 control) = **80 calls**:

```
rounds usable=16  control-failed(excluded)=0  lanes=4
    0  opencode-go/qwen3.6-plus
    0  opencode-go/glm-5.3
    0  opencode-go/kimi-k2.6
    0  opencode-go/deepseek-v4-flash
total lane-throttle observations: 0
VERDICT: INCONCLUSIVE
```

**Zero throttles. That does not answer ask 2, and it must not be written up as if it did.** It
shows the window was quiet. The coincidence test needs throttles to exist before it can measure
their clustering, so the tool exits **3 (inconclusive)** rather than 0 here — an exit 0 means the
question was actually answered. Suite section 3 pins that a quiet window is never reported as
"per-lane" or "healthy".

This matters because the failure mode being guarded against is precisely the one TOG-842 hit: a
single quiet sweep read as proof of health.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | answered — see VERDICT (`SHARED` or `PER-LANE`) |
| 1 | usage / environment error |
| 2 | `MIXED` — throttles seen, pattern is neither clean shape |
| 3 | `INCONCLUSIVE` — no throttle in this window; run again later |

## Running it

```sh
ROUNDS=16 SLEEP_BETWEEN=20 ./opencode_shared_budget_probe.sh
```

Needs `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`. The suite needs neither: results arrive
through the `OPENCODE_PROBE_CMD` seam, which defaults to `false` so a test that fell through to the
live gateway fails rather than passing quietly.

**Re-run this during a throttled window.** Until it exits 0, ask 2 is open and the honest statement
is "not yet measured" — not "no evidence of sharing".
