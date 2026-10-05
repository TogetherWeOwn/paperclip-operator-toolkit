# Muse Stop guard: install handoff

For the operator (main session). Reviewed package; this document is the whole install. Nothing in
it needs a credential, a restart or a model call.

## What it is

A Claude Code `Stop` hook. When a Muse run's turn ends as text with no tool call, and that text is a
statement of intent ("Running the focused tests now:", "Work product registered. Marking the card
done."), it hands the turn back with a reason. The model continues in the same run, warm cache, and
either does the step or records the card disposition. Without it the run ends, nothing happens, and
Paperclip parks the card for a missing disposition.

## Evidence

| Check | Result |
|---|---|
| Size of the problem. 2,107 Muse sessions, 24 h to 2026-10-03 03:20Z, read from the agents' Claude Code project transcripts | 4,554 turns ended on text with no tool call. 946 (20.8%) ended on a statement of intent or empty text. 821 (18.0% of ended turns) had no disposition write in the turn. |
| Classifier against 28 announce and 25 genuine endings, labelled by hand from those sessions | 28/28 announce flagged, 0/25 genuine flagged |
| Hand read, small samples, not a measured rate | About 5 of 100 flagged turns looked like genuine finals (a status line such as "waiting on CI, no push while it runs"). About 5 of the 70 shortest unflagged turns were announcements (imperative wording: "Final disposition: mark the card done."). |
| Unit and integration tests, `node --test hooks/muse-stop-guard/muse-stop-guard.test.mjs` | 29 pass |
| Mutation check, 12 targeted mutants applied to copies | 12/12 killed |
| Real Claude Code 2.1.285 against a local stub model, `node hooks/muse-stop-guard/smoke/run-smoke.mjs`, 4 scenarios, run 3 times | 12/12 pass. Loopback only, no credential, throwaway HOME. |

What the smoke test proved about the harness: Claude Code passes `last_assistant_message`,
`stop_hook_active`, `background_tasks` and `session_crons` to a Stop hook; it honours
`{"decision":"block"}`; the model next sees `Stop hook feedback:` followed by our reason; the second
Stop arrives with `stop_hook_active: true`; the run ends at the guard's cap of 2.

**One defect the smoke test found, fixed here.** Claude Code writes the transcript asynchronously.
At Stop time the first assistant record of a fresh session can still be missing (2 of 3 early runs),
so a hook that reads the model from the transcript alone does nothing. The hook now falls back to
`PAPERCLIP_ASSIGNED_MODEL`/`ANTHROPIC_MODEL` and, if neither names a model, waits at most 300 ms for
the transcript. Long sessions never hit this path.

## Scope

- **Reach.** One entry under `hooks.Stop` in the user-scope Claude Code settings file (`$SETTINGS` in
  the Install block below, by default `$HOME/.claude/settings.json`), which every `claude_local` agent
  on this box reads because they share one HOME. That is the same file that holds the model guard and
  the pacer hooks. The installer refuses to write it without
  `--i-understand-this-reaches-every-agent`.
- **Who it acts on.** Only runs whose model starts with `muse`. For every other agent it reads the
  transcript tail (or the env var), allows the stop, writes nothing and logs nothing.
- **When.** Only the main-thread `Stop` event. Not `SubagentStop`. Not while `background_tasks` or
  `session_crons` is non-empty (the session is paused on purpose).
- **Cost bound.** At most 2 hand-backs per run (`MAX_NUDGES`), counted outside the transcript. Claude
  Code adds its own cap of 8. If the counter cannot be written the hook allows the stop, because the
  loop could not be bounded. Expected volume: at the 24 h rate above, up to about 1,900 extra
  model calls a day across the fleet (946 flagged turns, 2 each at most), in a warm session, on the
  lane the agents already use. No new spend path.
- **Fails open.** Any error, bad input, 8 s deadline: allow, exit 0.
- **Does not touch.** Any other hook event, any other `Stop` entry, any other setting. The installer
  proves it by comparing the file with our entry removed, before and after, and refuses on a
  difference. Invalid JSON is refused, never overwritten.
- **Second guard, unsaved work.** Uncommitted files or unpushed commits at stop. Ships in `observe`
  mode: logs, never blocks. Do not switch it to `enforce` without the 48 h numbers (see Measurement).
- **Not covered.** Muse behaviour in OpenCode and Hermes: different harnesses, no Claude Code hook.

In-flight runs: nothing is stopped or restarted. Claude Code's file watcher normally picks up direct
edits to hooks in a settings file (hooks reference, "Disable or remove hooks"), so a Muse run that is
already going may start using the hook at its next stop. That is harmless: the hook can only hand one
turn back, at most twice. Rollback step 0 below covers both new and in-flight sessions.

## Install

Operator-owned step, host-executed. Run as the user that owns the existing hook install directory
(the one that holds your model guard hook; `OWNER_REF` below), from the operator's host shell —
never from an agent run. The user-scope file (`$SETTINGS`) is owned by the same uid every agent run
shares, so no in-installer flag can substitute for this: since the tripwire below, the installer
itself refuses user-scope `--apply` when `PAPERCLIP_RUN_ID`/`PAPERCLIP_AGENT_ID` is set, even with the
acknowledgement flag. `SRC` is a checkout of this repository at the merge commit of the PR that added
this directory. The three path variables are environment-overridable; the defaults are neutral
directories under `$HOME`.

```bash
SRC=<checkout>/hooks/muse-stop-guard
DEST="${MUSE_STOP_GUARD_DEST:-$HOME/muse-stop-guard}"        # where the runtime files are installed
SETTINGS="${CLAUDE_SETTINGS_FILE:-$HOME/.claude/settings.json}"  # the user-scope settings file
OWNER_REF="${HOOK_OWNER_REF:-$HOME/model-guard}"             # a directory already owned by the agents' uid

# 1. Copy the three runtime files. The tests, fixtures and smoke harness stay in the repo.
install -d -m 0755 "$DEST"
install -m 0644 "$SRC/muse-stop-guard.mjs" "$SRC/install-muse-stop-guard.mjs" "$SRC/summarize-decisions.mjs" "$DEST/"
: > "$DEST/decisions.jsonl" && chmod 0664 "$DEST/decisions.jsonl"
chown -R --reference="$OWNER_REF" "$DEST"                # the hook runs as the agents' uid and appends here

# 2. Dry run. Nothing is written. Expect installed:false.
node "$DEST/install-muse-stop-guard.mjs" status --settings "$SETTINGS"

# 3. Review the diff. Expect ONE added block, "Stop", and nothing else.
# Both sides go through jq -S: the dry-run output is pretty-printed with 2-space
# indent, while diff needs sorted keys on both sides to show only the added block.
diff <(jq -S . "$SETTINGS") \
  <(node "$DEST/install-muse-stop-guard.mjs" install --settings "$SETTINGS" 2>/dev/null | jq -S .)

# 4. Apply. It prints the backup path; keep it. From the host shell these markers are
# unset, so the write proceeds; from any agent run the installer refuses instead.
env | grep -E '^PAPERCLIP_(RUN|AGENT)_ID=' && echo "STOP: operator shell only" && exit 1
node "$DEST/install-muse-stop-guard.mjs" install --apply --i-understand-this-reaches-every-agent --settings "$SETTINGS"
```

## Verify (no model spend)

```bash
# Hook keys: expect PreToolUse, Stop, UserPromptSubmit.
jq '.hooks | keys' "$SETTINGS"

# Nothing else changed: this must print nothing.
diff <(jq -S 'del(.hooks.Stop)' "$SETTINGS") <(jq -S 'del(.hooks.Stop)' <BACKUP_PATH>)

# Behaviour, announce for a muse model: expect one JSON line with "decision":"block".
echo '{"hook_event_name":"Stop","session_id":"op-check","last_assistant_message":"Running the tests now:","transcript_path":"/nonexistent"}' \
  | PAPERCLIP_ASSIGNED_MODEL=muse-spark-1.3-contributor PAPERCLIP_RUN_ID=op-check-$(date +%s) node "$DEST/muse-stop-guard.mjs"; echo "exit=$?"

# Behaviour, any other model: expect no output and exit=0.
echo '{"hook_event_name":"Stop","session_id":"op-check","last_assistant_message":"Running the tests now:","transcript_path":"/nonexistent"}' \
  | PAPERCLIP_ASSIGNED_MODEL=claude-sonnet-5-5 PAPERCLIP_RUN_ID=op-check-$(date +%s) node "$DEST/muse-stop-guard.mjs"; echo "exit=$?"
```

The first check writes one `op-check-*` line to the decision log. Then confirm live agents reach the
hook. This is the one assumption the repo cannot prove: Muse agents use the same adapter and HOME as
the other `claude_local` agents, but no transcript records hook activity.

```bash
# Within ~30 minutes of the next Muse runs ending: stopsSeen must be above the op-check line.
node "$DEST/summarize-decisions.mjs"
```

If `stopsSeen` stays at the single `op-check` line while Muse runs are ending, those agents do not read
`$SETTINGS` (a per-agent `CLAUDE_CONFIG_DIR`). Nothing is harmed. Report it to the rollout owner and
leave the hook installed or roll back, as you prefer.

## Rollback

Fastest first. Each is independent. The commands use `DEST` and `SETTINGS` as set in the Install block.

| Step | Command | Effect |
|---|---|---|
| 0. Instant, no settings edit, also covers sessions that already loaded the hook | `touch "$DEST/DISABLED"` | Every stop is allowed. Undo with `rm`. |
| 0b. Keep it installed, stop blocking | write `{"maxNudges":0}` to `$DEST/muse-stop-guard.config.json` | Same, and the log keeps recording what it would have flagged as `nudge-cap-reached`. |
| 1. Remove our entry only | `node "$DEST/install-muse-stop-guard.mjs" uninstall --apply --settings "$SETTINGS"` | Removes our `Stop` entry and any container it leaves empty. Backs up first. |
| 2. Restore the pre-install file | `cp <BACKUP_PATH> "$SETTINGS"` | Only if nobody else has edited the settings since. Otherwise use step 1. |

Prove it: `node "$DEST/install-muse-stop-guard.mjs" status --settings "$SETTINGS"` shows `installed:false`
(steps 1, 2), and `jq '.hooks | keys'` matches the pre-install list.

## Measurement

Baseline before the rollout: 352 missing-disposition notices and 225 parks in 24 h over 5,662
runs, mostly Muse ending a turn on a sentence of intent.

1. Before install, record the transcript baseline:
   `python3 measure/extract-turn-endings.py --since-minutes 2880 --out before.jsonl && node measure/eval-turn-endings.mjs before.jsonl`
2. 48 h after install, the same command to `after.jsonl`. The metric is the share of ended turns that
   end on an announcement with no disposition write (18.0% in the 24 h baseline above).
3. `node "$DEST/summarize-decisions.mjs" --since <install time>`: blocks, runs
   nudged, nudges per nudged run, how often the cap was reached.
4. From Paperclip: missing-disposition notices and parks per Muse run, 48 h before versus after.
5. Report the result to the rollout owner. If more than 10% of nudges are followed by a turn
   that repeats the same announcement, or the cap is reached on more than 5% of nudged runs, the
   wording of the reason needs work, not the cap.

## Tuning without touching settings

`$DEST/muse-stop-guard.config.json` (beside the hook), environment variables win over it:

| Key | Env | Default | Meaning |
|---|---|---|---|
| `maxNudges` | `MUSE_STOP_GUARD_MAX_NUDGES` | 2 | Hand-backs per run. 1 gives the strict "one nudge per chain" reading of `stop_hook_active`. 0 turns blocking off. |
| `unsaved` | `MUSE_STOP_GUARD_UNSAVED` | `observe` | `off`, `observe` (log only) or `enforce` (hand back a stop with unpushed work). |

## Known limits

- The classifier is wording heuristics on the last sentence. It is tuned on one day of one model's
  output and will drift when the model or the prompts change. Re-run
  `measure/eval-turn-endings.mjs --sample announce 40` and `--sample nodisp 40` monthly and read the
  samples.
- It cannot tell "waiting on CI, nothing armed" from "waiting on CI, monitor armed", because Paperclip
  monitors are server-side and invisible to the hook. Both are handed back; the cost is one turn.
- A hand-back that the model answers with a bare "done" restarts the same problem one level up; the cap
  is what ends it.
