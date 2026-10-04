# Request context evidence

Context-window demand is the **maximum individual request prompt**, not a sum of
requests in a heartbeat, harness turn, sidechain, or cost profile. This hotfix
changes no roster, tier, lane pacing, fleet-ceiling setting, or production state.
Deployment and configuration remain a separate operator action.

## Durable source contract

Verified against the installed Paperclip source on 2026-10-01 (read-only; no
production DB or run logs were probed):

- `packages/db/src/schema/heartbeat_runs.ts:42-65`: finalized run log identity and
  integrity are `id`, `agent_id`, `log_store`, `log_ref`, `log_bytes`,
  `log_sha256`, `log_compressed`. Run `usage_json` is cost accounting.
- `server/src/services/run-log-store.ts:263-299,302-347`: `local_file` records
  live under `<companyId>/<agentId>/<runId>.ndjson`. Each outer line has
  `{ts, stream, chunk, seq?}`; stdout chunks must be reassembled before parsing
  adapter JSON lines. Final byte length and SHA-256 cover the whole file.
- `packages/adapters/claude-local/src/server/execute.ts:879` and
  `parse.ts:76-94`: Claude stream-json assistant events carry `message`; the
  terminal `result` is a different, cumulative receipt. Only
  `assistant.message.usage` is used here. Claude prompt demand is
  `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`, as
  explicitly defined in Anthropic SDK `resources/messages/messages.d.ts`.
  All three counters must be finite nonnegative safe integers. Missing/invalid
  counters invalidate the run's peak, rather than just dropping a bad turn.
- `server/src/services/heartbeat.ts:3581-3592`: persisted chunks may contain
  `[paperclip truncated run log chunk: ...]`. Such a log cannot prove its maximum.
- `doc/plugins/LOCAL_PLUGIN_DEVELOPMENT.md:198` and
  `doc/plugins/PLUGIN_SPEC.md:1249-1251`: trusted local workers support Node
  filesystem operations. There is **no SDK historical-log reader**. The root is
  explicitly configured, not discovered by searching host files or inheriting
  a credential/environment value.

The lookup retains separate indexed `issueId` and guarded `taskId` branches,
company scoping, and one latest finalized row. It never falls back to an older
row just because the newest row's evidence is missing. Each pass memoizes the
entire lookup/verification so describing and advising one issue do not read it
twice. Only terminal (`finished_at is not null`) rows qualify.

The reader validates the exact company/agent/run reference, realpath containment,
regular-file status, and finalized length/hash. Reads are bounded to 8 MiB; larger
logs fail conservatively. Compressed/remote logs are unsupported. Neither the
32 KiB stdout excerpt nor tail-capped `result_json.stdout` proves completeness.

## Cache semantics and unsupported adapters

Do **not** infer cache accounting from a model ID or provider name:

- Raw Codex/OpenAI `turn.completed.usage.input_tokens` includes
  `cached_input_tokens` as a subset (`codex-local/src/server/parse.ts:74-79`).
  Adding them double-counts cache. Moreover, this receipt is not verified to be
  an individual LLM-request peak; this hotfix deliberately uses fallback, not
  a fabricated observed value, for this contract.
- Codex ACP subtracts cache before publishing normalized ACP `inputTokens`
  (`@agentclientprotocol/codex-acp@1.6.2/dist/index.js:22122-22137`). ACPX
  accumulated usage therefore has different semantics, but still does not
  prove an individual request maximum. It also receives fallback.
- Native durable `usage.reported` has cumulative/run-delta receipts at
  `payload.prpEvent.payload`; these are not interchangeable with raw Claude
  assistant usage. No native-event table grant or platform change is introduced.

Supported observed evidence is intentionally limited to complete Claude
assistant-usage logs. Native/ACPX/OpenAI receipt-only histories, missing log roots,
and unrecognized formats remain honest, labelled fleet-ceiling fallbacks.

## Operator boundary

For peak extraction, the deployment operator must verify the host's actual
`RUN_LOG_BASE_PATH` (or instance `data/run-logs`) and mount/read visibility, then
supply `selection.contextRunLogRoot` to that exact existing root. This document
is not authorization to change production settings. Without that input the
hotfix still stops cumulative totals being reported as peaks, but uses the fleet
fallback for previously run issues. Preserve the existing fleet ceiling (200000
in the 2026-10-01 live configuration) and all live model/lane settings.

## Behavior and tests

- `tests/context-evidence.spec.ts`: chunk reassembly; max versus last/average/sum;
  single-request Claude cache-read/creation; OpenAI subset/ACPX receipt rejection;
  missing/malformed/truncated counters; root/identity/integrity/size checks.
- `tests/worker.spec.ts`: actual temporary finalized NDJSON files with ~2.7M
  cumulative prompt tokens. A 150k peak selects a cheaper 200k model; a 400k peak
  selects the wider model even with a 200k fleet setting. Traces expose observed
  versus fallback provenance, and explicit overrides survive history failures.
- `tests/context.spec.ts`: explicit override precedence, uncapped real peaks,
  conservative fallback, verified no-history behavior, malformed peak handling.
- `tests/context-lookup.spec.ts` and `tests/sql-guard.spec.ts`: indexed company/card
  attribution and the host SQL namespace guard remain intact.

All evidence is synthetic fixture data; no production integration result is
claimed. Before push, a hand-run max-to-last mutant was killed by both parser
and worker-routing tests (3 failing assertions); its source was restored.
