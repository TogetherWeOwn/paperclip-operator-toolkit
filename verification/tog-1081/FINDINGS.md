# TOG-1081 — Stop acpx persisting resolved secrets into session records

**Owner:** CTO & Chief AI Officer
**Date:** 5 Sep 2026
**Status:** patch written, verified, and installed in `/app/patches/acpx@0.12.0.patch`.
**Not yet in effect on the running server** — see §5. That is the one open item.

---

## 1. What I changed

`persistedSessionOptions` (the write boundary named on the card) now filters the env
block before serialization:

```js
env: withoutSecretEnv(storedEnvRecord(options.env))
```

Shipped through the existing `/app/patches/acpx@0.12.0.patch`, as the card asked. All 7
pre-existing hunks are preserved; mine is the 8th. I did **not** hand-edit `dist/` as the
fix — the edit I made to the installed tree is only the mechanism for generating the
patch, and §4 proves the patch reproduces it byte-for-byte from a clean registry copy.

Classification is by key name (exact set + a pattern for `*_SECRET`, `*_API_KEY`,
`*_AUTH_TOKEN`, `*_PRIVATE_KEY`, …) **or** by value shape (any PEM header). The pattern
arm matters: it catches credentials nobody enumerated, which is how this defect
recurs.

## 2. The design decision: omit the key, don't store a placeholder

**The card asked for "replace credential values". I omit the entry instead.** This is a
deliberate deviation and it is the whole correctness argument, so it is recorded here.

`buildAgentEnvironment` (live-checkpoint:2969) builds the child env as
`{...process.env}` and then lets `sessionEnv` **overwrite** it:

```js
if (sessionEnv) for (const [key, value] of Object.entries(sessionEnv)) {
    if (typeof value !== "string" || protectedAuthEnvKeys.has(...)) continue;
    assignSessionEnv(env, key, value);   // record value WINS
}
```

So a placeholder is not inert. It would be assigned to the launched agent as the literal
string `[[redacted:…]]`, replacing the real inherited credential — a silently broken
GitHub/Anthropic path. Omitting the key lets the runner's freshly-resolved value stand.

## 3. A premise on the card that does not hold

The card (and TOG-1079 FINDINGS §5) justify redaction with *"live env WINS at merge —
`mergeSessionOptions` does `{...fallback, ...preferred}` with the record as fallback."*

**`mergeSessionOptions` is not on the lane Paperclip uses.** Verified by grepping every
caller in the shipped bundle:

| Function | `output-*.js` (CLI lane) | `runtime.js` (Paperclip lane) |
|---|---|---|
| `mergeSessionOptions` | 3 call sites | **none** |
| `sessionOptionsFromRecord` | yes | `createTurnClient` (runtime.js:1039) |

`createTurnClient` builds the client from **`sessionOptionsFromRecord(record)` alone** —
no live env is merged in on that path. So on resume the record is not a fallback, it is
the *only* source, and it is layered over `process.env`. That is precisely why §2's
omit-vs-placeholder choice is load-bearing rather than cosmetic. Under the card's stated
premise a placeholder would have been harmless; under the actual code it would not be.

The empirical check agrees: 113 records carrying the TOG-1079 redaction marker had agents
respawn after containment, and across 37 live agent processes **zero** carry a marker in
`GH_APP_PRIVATE_KEY` (31 carry a live key, 6 none). The marker never reached a child —
consistent with the runner supplying fresh env at launch, and with omission being safe.

## 4. Verification

Two harnesses, both driving **acpx's own exported functions**, not a re-implementation.
Kept in this directory; re-runnable.

`verify_write_boundary.mjs` — 40 assertions, all pass:
- each of 7 secret shapes omitted from the persisted record (incl. one caught only by the
  name pattern and one only by PEM shape)
- 13 non-secret keys preserved byte-exact; env key count 13 == 13
- no secret **value** present anywhere in the serialized record
- `assertPersistedKeyPolicy` accepts the result
- resume path (`sessionOptionsFromRecord`) exposes no secret entry
- simulated `buildAgentEnvironment` layering: child keeps the **live** value for all 7
- CLI-lane `mergeSessionOptions` still resolves to the live secret

`verify_real_record.mjs` — against a real on-disk record that held a live 1678-byte key:
- baseline record parses and *does* hold the key (defect reproduced first)
- rewritten record drops all 4 credentials present, keeps `GH_APP_ID`, `GH_APP_ORG`,
  `ANTHROPIC_BASE_URL`, `PAPERCLIP_AGENT_ID`, `PAPERCLIP_TASK_ID`
- `assertPersistedKeyPolicy` passes; `parseSessionRecord` round-trips
- `acp_session_id` and message history preserved

**Survives reinstall — tested, not assumed.** `npm pack acpx@0.12.0` from the registry,
untarred clean, then `git apply`:
- new patch applies cleanly to the pristine tarball
- all 4 patched files are then **sha256-identical** to the live installed tree

That is the acceptance criterion "the change lives in the patch file", proven end to end.

## 5. Open: the fix is not yet in effect

`redact_session_secrets.py --dry-run` reports **0 eligible files** — but that number does
not yet prove anything about the fix. Records written *after* I installed the patch still
contain `GH_APP_PRIVATE_KEY`.

Cause: the writer is **in-process in the server** (pid 3, started 05:36 UTC), which
imported acpx into its heap ~8 hours before the patch landed at 13:55. A JS module edit
cannot affect an already-running process. Agent runs are children of pid 3 and inherit
its loaded module.

**A server restart is required for this fix to take effect**, and restarting the platform
is not my call to make unilaterally mid-flight — it would kill every in-flight agent run
on the box. Handing that to the operator rather than doing it quietly.

Until restart, the interim control stands: `redact_session_secrets.py --apply` on a
schedule (TOG-1079 §6, delegated separately).

**Post-restart acceptance check** — a newly created record must show no credential keys:

```bash
python3 ops/tog-1079/redact_session_secrets.py --dry-run   # expect 0 eligible
node   ops/tog-1081/verify_real_record.mjs                 # expect ALL CHECKS PASSED
```

## 6. Out of scope, deliberately

Transcript-borne key material (`messages[].ToolUse.input`, `tool_results`) is a **separate
leak class** — TOG-1079 §5 bug 2 — and is not touched by an env write-boundary patch. The
real record I tested still holds 22 PEM occurrences in its transcript, put there by agents
cat'ing/editing key files. The sweeper's transcript redactor is what addresses those. I
scoped my assertion to the env block rather than letting a green "no PEM anywhere" claim
paper over it.

Rotation (TOG-1079 §7) remains escalated and untouched here.
