# Upstream defect reports — the Paperclip host and its vendors

Ten defect reports on `main`, written against the **Paperclip host and the
vendor software it runs**, not against anything in this repository. They are held
here because there is nowhere else for them to live and nowhere an agent can send
them.

Five are against the plugin host. `agent-run-credential-isolation.md` is against
the agent container runtime, and `interaction-comment-supersession-default.md` is
against the issue-thread interaction service. Both were written here rather than
imported.

Three are against parties other than the Paperclip host itself:
`omniroute-false-cliproxy-terminal-state.md` and
`omniroute-truncated-reasoning-false-502.md` are against **OmniRoute**, the model
gateway Paperclip consumes, and `hindsight-company-config-bootstrap.md` is against
the vendor plugin `@vectorize-io/hindsight-paperclip`. They live here because they
share the queue's single blocker — no agent-reachable route to any upstream — not
because they are host defects.

An eleventh report, `discord-plugin-proactive-job-scope.md` (TOG-676), exists **only
on branch `tog-676-upstream-report`** and is deliberately not counted above. Saying
"eleven" unqualified sends a reader looking on `main` for a file that is not there.

## Why they are here and not filed

There is no agent-reachable upstream tracker. `GH_APP_REPOS` projects exactly one
repository — `paperclip-ops-tooling` — and these are defects in the platform that
runs the agents, so no repo we can push to is the right destination. Filing them
with the vendor is an **operator action**. See "What the operator is being asked
to do" below.

Until 2026-08-25 the only copy of each draft lived in
`/paperclip/instances/default/workspaces/6a02a7ed-…/gh-token-broker/`, unversioned,
inside an agent workspace — which is the very directory
`manifest-refresh-escalation.md` identifies as the reachability condition for its
own finding. A workspace reprovision would have taken all five with it. Moving
them into git changes nothing about their status: they are still unfiled. It
means they now have a reviewable history and more than one copy.

The five imported reports are committed verbatim and were hash-checked against
their workspace originals at import (TOG-349). The other reports were authored
here directly. The `DRAFT — not filed` banner each one opens with is kept
deliberately, and should be edited only by whoever actually files it.

Every draft here is pinned by sha256 in `upstream_draft_pins.txt` in the
repository root; `./upstream_draft_pin_audit.sh` verifies the pins have not
drifted, and `--update` repins after an intentional edit.

## The reports

| file | class | what it is about |
|---|---|---|
| `manifest-refresh-escalation.md` | privilege escalation | `activatePlugin()` → `refreshPluginManifestFromPackage()` re-registers a plugin's manifest with no admin check and no capability-escalation check — the check `upgradePlugin()` does enforce. `manifestJson` is the live source of truth for `capabilities`, `apiRoutes[].auth`, `checkoutPolicy` and `companyResolution`, so this re-declares authority without approval. Also covers the `lifecycle.upgrade()` ordering defect that turns a rejected upgrade into a worker outage, and the dev watcher that never attaches to boot-loaded plugins. |
| `actor-runid-provenance.md` | authorization | `actor.runId` is a signed JWT claim on one auth path and an unvalidated request header on the other, and the host does not tell a plugin which path applied. |
| `checkout-policy.md` | authorization | The three `checkoutPolicy` values do not order the way their names suggest; `required-for-agent-in-progress` skips the ownership assertion in exactly the case an attacker would choose. |
| `plugin-auth-surface.md` | authorization | The overall shape of what a plugin route can and cannot rely on the host to have checked. |
| `process-tree-reaping.md` | reliability | Process-tree reaping behaviour. |
| `agent-run-credential-isolation.md` | missing trust boundary | Concurrent agent runs share a uid and a PID namespace, so any agent can read another agent's `PAPERCLIP_API_KEY` and bound secrets out of `/proc`. Every two-principal control the host offers — `requestedByAgentId` vs `decidedByAgentId`, custody, per-agent secret bindings — is attributed from a bearer token the actor's peers can read. Measured 2026-08-25 (TOG-393). |
| `interaction-comment-supersession-default.md` | silent destructive default | Four interaction kinds store `supersedeOnUserComment: true` when the caller omits it, so the next human comment can terminate an unanswered card. The full company sweep found 18 historical comment-supersession deaths and 19 armed pending cards; the requested change makes supersession explicit opt-in (TOG-429). |
| `omniroute-false-cliproxy-terminal-state.md` | reliability — **not** a host defect | Against **OmniRoute**. Two related but distinct findings against the same subsystem. (1) A per-model upstream error (unsupported-model 404, or a per-model 402) on a multi-model connection incorrectly trips the whole connection's terminal state, so later valid requests on other models get `503 … all upstream accounts are inactive`. Two measured episodes: 2026-08-26→08-28 (147 failed requests, unsupported-model trigger, TOG-713) and 2026-09-02 20:32-20:55Z (64 failed requests, per-model 402 trigger, TOG-833 — this one killed all fleet Claude traffic for ~7 min via `cliproxy-main`). Root cause cited by file:line in OmniRoute's `auth.ts`; no config knob exists, fix must be upstream code. (2) The synced-model-discovery cache has no TTL and no invalidation on provider-connection restart, so a `cliproxy` container restart left every `cliproxy/*` model id 404ing through OmniRoute while cliproxy served them fine directly (2026-09-02 21:15Z, TOG-833) — a near-miss for the Model Router health probe, which reads the same stale catalogue. Fixed operationally by restarting OmniRoute; root cause cited by file:line in `modelDiscovery.ts`/`db/models.ts`. |
| `omniroute-truncated-reasoning-false-502.md` | reliability — **not** a host defect | Against **OmniRoute**. `detectMalformedNonStream` (`open-sse/utils/diagnostics.ts`) rewrites a valid *truncated* completion (`content:""`, `finish_reason:"length"`) into HTTP 502 `upstream_empty_response`, because it lacks the `LEGIT_EMPTY_OPENAI_FINISH` exemption that the pre-translation check `isEmptyContentResponse` (`services/errorClassifier.ts`) already applies to the same body — the two validators disagree. A second, narrower gap reads the reasoning text under only some of its field names. **`3.8.50` (2026-08-28) partially fixes this**: it adds `msg.reasoning`, but still omits `reasoning_details[]` and still has no `finish_reason` exemption, so a truncated completion carrying no reasoning text is a 502 today. Measured 9/9 non-streaming 502s vs 14/14 healthy streaming on `gpt-oss-*` (TOG-177); lands on the terminal PAYG fallback leg. Verified by executing the real shipped function — `verification/tog-233-truncated-reasoning-502.sh` (TOG-233). **Confirmed live 2026-09-03** against the running gateway (`x-omniroute-version: 3.8.49`): 502 for `max_tokens<=32`, 200 from 64 up, and the same request with `stream:true` returns a well-formed `finish_reason:"length"` + `reasoning` turn, so the detector manufactures the 502. The Anthropic `/v1/messages` surface returns 200 across that whole band, so agent bindings are not exposed on their normal path — re-runnable via `verification/tog-233-live-gateway-probe.sh`. |
| `hindsight-company-config-bootstrap.md` | missing bootstrap — vendor plugin | Against `@vectorize-io/hindsight-paperclip` v0.2.0. The plugin cannot establish its own `plugin_config` row for a new company, so operators carry external reconcilers. It already declares `events.subscribe`; `company.created` is in the host minimum event set. Cannot be fixed our side — `syncJobDeclarations()` makes `plugin_jobs` a pure projection of `manifest.jobs` and the manifest declares no `jobs` key (TOG-713). |

## What the operator is being asked to do

1. **File these with the vendor**, through whatever channel the Paperclip
   relationship actually has. No agent in this company can reach it. Note the
   last two go to **different** recipients — OmniRoute and Vectorize — not to
   the Paperclip vendor.
2. Track the fixes requested in `manifest-refresh-escalation.md`:
   - apply the capability-escalation comparison in
     `refreshPluginManifestFromPackage()`, not only in `upgradePlugin()`;
   - treat `auth` and `checkoutPolicy` relaxations as escalations, not just
     added capabilities;
   - move the `deactivatePluginRuntime()` call in `lifecycle.upgrade()` to
     *after* validation, so a rejected upgrade does not also stop the worker.

## What does not depend on the vendor

`manifest-refresh-escalation.md` is only *reachable here* because
`gh-token-broker` is installed from a path inside an agent workspace. That part
is ours, and it is tracked separately in
[`../plugin-package-path.md`](../plugin-package-path.md) — the host-owned package
path handoff. The vendor fix and our fix are independent; either one alone closes
the path for this plugin.

`plugin_manifest_gate.sh` in the repository root is the detection control that
ships in the meantime. It does not prevent the write. It makes the write legible
before somebody activates.
