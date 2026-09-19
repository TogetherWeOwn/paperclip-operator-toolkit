# web_search lane passthrough probe

`websearch_lane_probe.py` is the standing positive control for a lane that
advertises Anthropic's server-side `web_search` tool. It catches the failure in
which the lane accepts the request but drops the tool manifest before dispatch:

```text
Tool 'web_search' not found in provided tools
```

That error can occur inside an otherwise successful agent turn. Organic traffic
cannot provide the denominator: the fleet uses `WebFetch`, and the measurement
that led to this probe found zero `web_search` tool calls across 533 sessions and
42,229 tool calls. The monitor must therefore make a real synthetic tool call.

## Verdicts

| Exit | Verdict | Scheduled action |
|---|---|---|
| `0` | `PASS` | Every scheduled lane invoked `web_search` and returned a result block. |
| `3` | `MANIFEST_DROP` | Post an alarm comment on the current routine issue. |
| `4` | `OTHER_ERROR` | Inconclusive auth, quota, transport, or search failure. Do **not** page as a manifest defect. |

The request forces `web_search` with
`tool_choice: {"type":"tool","name":"web_search"}`. That makes absence of a
`server_tool_use` block diagnostic rather than an optional model decision.
`MANIFEST_DROP` includes the explicit error payload, a 200 response carrying the
same message inline, and the silent case where a lane ignores the forced tool
and returns text only. `OTHER_ERROR` deliberately covers quota and transport
failures so an unreachable gateway does not page the wrong incident.

A 200 only carries manifest evidence when it is a well-formed, *complete*
Messages envelope. An unparseable body, a non-list `content`, an empty
`content`, or a turn that stopped as `max_tokens` / `refusal` / `pause_turn`
before calling anything is `OTHER_ERROR`, not `MANIFEST_DROP` — none of those
shapes shows the lane dropping the tool, and paging on them would train the
board to ignore this alarm. The silent case still pages: a *completed* turn that
answers from memory without a `server_tool_use` block is exit `3`.

## The scheduled set

```bash
python3 websearch_lane_probe.py --scheduled --json
```

The set is fixed in code so a routine edit cannot silently omit the lane this
control exists to cover:

| Label | Base URL | Model | Credential env | Bound secret fallback |
|---|---|---|---|---|
| direct CLIProxy | `http://cliproxy:8317` | `claude-sonnet-5` | `CLIPROXY_API_KEY` | `cliproxy_agent_api_key` |

### Retired: the OmniRoute lane

`https://router.example.net` / `cliproxy/claude-sonnet-5` was the second
scheduled lane until 2026-09-16 (TOG-2905). It is **removed, not red**.

The owner rule of 2026-09-13 routes everything except Hindsight direct to
CLIProxy, and the 07:36Z cutover (TOG-2880) completed that move. A manifest
verdict on a route the fleet no longer takes is not a fleet health signal, so
leaving the row in place would have meant a standing `OTHER_ERROR` — or a page —
about traffic that does not exist. The proposal to bind an OmniRoute inference
credential for it (TOG-2936) was rejected and TOG-2933 cancelled on the same
basis; there is no missing grant to chase here.

`websearch_lane_probe.RETIRED_SCHEDULED_LANES` records the removal in code, and
`test_retired_omniroute_lane_is_not_scheduled` fails if the lane reappears in the
schedule — so putting it back is a deliberate act, not an accident. To re-check
that route ad hoc, use single-lane mode (below).

Each scheduled lane names its own bound Paperclip secret (last column). When the
environment variable is absent, scheduled mode reads that secret on demand
through `/api/agents/me/secrets/.../value`; the value stays in process memory and
never reaches argv. Only the code-pinned scheduled lanes carry a `secret_key` —
a single-lane target supplied on the command line takes its host from the caller,
so it is never allowed to pull a bound secret.

**The identity that runs the schedule must hold every lane's grant.** A lane
whose variable is unset *and* whose secret is not granted never reaches `probe()`
at all: it returns exit `4` every cycle, which is indistinguishable from a quota
blip, so the lane silently stops being measured while the run still reads as
weather. That is the exact false-green this probe exists to catch, so scheduled
mode prints a dedicated `BLIND LANE <label>: no <VAR> and no <secret> run secret`
line to stderr for it. Measured 2026-09-16 from the DevOps agent that owns
routine `19c186f8-6cdc-4410-88ab-f597ad52e740`: `cliproxy_agent_api_key` → HTTP
200. Treat a `BLIND LANE` line as a configuration defect to fix before trusting
the run, not as weather.

Nothing in that table is overridable from the environment. Scheduled mode reads
neither the base URLs nor the credential variable names from `environ`, because
the probe sends the selected credential in both the `x-api-key` and
`authorization` headers: whoever controls the base URL controls where that
credential goes. `CLIPROXY_BASE_URL` and `OMNIROUTE_BASE_URL` are both ignored for that reason.
The latter is the concrete example: it is a live name
in this repo, where `omniroute_combo_cli.sh:189` defaults it to
`127.0.0.1:20128`. (That line is `: "${OMNIROUTE_BASE_URL:=...}"` with no
`export` and no `set -a`, so it does **not** itself leak into a child process —
but any operator or routine that sets the variable for that tool's benefit would
have quietly redirected this probe to localhost while it still reported on the
router.)

`WEBSEARCH_CLIPROXY_KEY_ENV` and `WEBSEARCH_OMNIROUTE_KEY_ENV` no longer do
anything; scheduled mode names them on stderr if set, so a stale deployment
setting fails loudly rather than silently. To probe any other lane — staging, a
new route, a one-off — use single-lane mode, where the target is explicit at the
call site:

```bash
python3 websearch_lane_probe.py --base-url https://staging.example \
  --model cliproxy/claude-sonnet-5 --api-key-env STAGING_KEY
```

## Board signal

A scheduled routine already creates a board issue for every run. On exit `3`,
the script additionally posts a `web_search lane alarm` comment to that current
issue using `PAPERCLIP_TASK_ID`, `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, and
`PAPERCLIP_RUN_ID`. The run id is sent in `X-Paperclip-Run-Id`. Exit `4` performs
no board write, so quota or transport failures remain visible on the routine run
without becoming a manifest-drop page.

If the alarm comment itself cannot be posted, the script writes
`BOARD_ALARM_FAILED` to stderr but preserves exit `3`; a known manifest defect
must not be downgraded to an inconclusive result because its notification path
also failed. The board request allows 60 seconds by default because the live
control-plane response has exceeded 30 seconds; `WEBSEARCH_BOARD_TIMEOUT`
overrides that bound for a deliberate deployment test.

## Cadence

Run this immediately after `./model_lane_probe.sh check` in routine
`19c186f8-6cdc-4410-88ab-f597ad52e740`, trigger
`6516c379-bb75-4cc8-83e1-a0ffa823cef5` (`17 */6 * * *` UTC). The probes are
siblings, not substitutes:

- `model_lane_probe.sh` verifies liveness, the configured model surfaces, and the
  subscription billing leg.
- `websearch_lane_probe.py --scheduled` verifies that server-side tool manifests
  survive the direct CLIProxy path the fleet actually routes through.

## Offline proof

```bash
python3 -m unittest -v test_websearch_lane_probe.py
```

The suite pins exit status for the classifier controls, the exact scheduled set,
alarm precedence, and the board-write boundary: exit `3` posts once; exit `4`
never posts. It also pins the two properties that review found missing: that no
environment variable can redirect a scheduled lane or its credential, and that
inconclusive 200 shapes stay exit `4`. Those regression tests were confirmed to
fail against the pre-fix commit `2d9e5c9f` (11 failures) and pass after it, so
they discriminate rather than merely describe.

The retirement pin is held to the same standard: re-adding the OmniRoute `Lane`
to `SCHEDULED_LANES` fails 4 tests, including
`test_retired_omniroute_lane_is_not_scheduled`. Measured 2026-09-16 — 31/31 pass
with the lane removed, `FAILED (failures=4)` with it restored.
