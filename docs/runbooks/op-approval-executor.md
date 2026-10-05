# Runbook: approval-queue executor (Part B3, source-only)

The approval-queue executor (`op_approval_executor.sh`) is the only path
from "approved on the request card" to "a root command ran". An action id
resolves through a root-owned allowlist to one fixed runbook script plus
validated arguments. There is no shell passthrough, no arbitrary command,
no eval, and no caller-selected executable. The optional `command` field on
a request is untrusted data: it is never executed and its presence is
recorded in the receipt as `ignored_untrusted_command`.

SHADOW is preserved: while the shadow marker exists, `execute` refuses
(exit 4) and runs nothing. `verify-only` still checks the full chain and
reports `shadow=present`, so a pre-flight can tell "would run" apart from
"shadow blocks" without executing. The host operator owns installation and
the Part B switchover after the acceptance gates below.

## Source / install manifest

| File | Role |
| --- | --- |
| `op_approval_executor.sh` | The executor. Installed root-owned, non-writable by group/other. |
| `test_op_approval_executor.sh` | Offline refusal/regression suite (54 cases). Runs in CI. |
| `docs/runbooks/op-approval-executor.md` | This file. |

Hashes below pin the reviewed revision. The approving reviewer re-checks
them at the exact head that merges; a re-push re-pins.

```
f91c47e1fbe92e80a6aec9a09209d143b2eedff5e79ce15ebc03d6ef33320766  op_approval_executor.sh
2afad60972a0f814cf77a510afdd07a6d232eaa529b79c38f18fafc8f0e5805f  test_op_approval_executor.sh
```

## Credential custody contract

- The board-only key, if one is ever provisioned, lives root-only BEHIND
  the executor. It is never exported to agent env, never passed on argv
  (`/proc/*/cmdline` is world-readable), and never written to the queue,
  the receipt, or the log.
- The executor takes no credential on argv, reads no credential file, and
  exports no credential variable. Secret-shaped argument NAMES are refused
  outright; secret-shaped VALUES in free text are scrubbed to `[redacted]`
  in receipts and log lines.
- Source work never mints, invites, grants, or reads live secrets. The
  suite asserts this structurally (the `command=` case proves the attacker
  binary never ran; no case touches a credential path).

## Install (host operator only, bounded)

All paths are examples. Private host maps stay private.

1. Copy `op_approval_executor.sh` to `/usr/local/sbin/op-approve-exec`
   (or the private scripts dir), `chown root:root`, `chmod 755`.
2. Write the private allowlist (`/etc/paperclip-operator/allowlist.json`)
   and approvers file from the private host map. `chown root:root`,
   `chmod 644` (allowlist) / `chmod 644` (approvers). No private content
   from this repo is needed for either file — the formats are specified
   in the executor header.
3. Ensure the processed dir is root-only: `chown root:root`,
   `chmod 755` on the dir; receipts inherit root ownership from the
   executor. Agents keep NO write path to the processed dir, the
   allowlist, or the scripts.
4. Leave the SHADOW marker in place. Do not delete it in this step.

Time bound: under 15 minutes. Blast radius: none — nothing is restarted,
no service is reloaded, and with SHADOW present the executor cannot run
anything.

## Rollback (bounded)

1. Remove the installed executor binary.
2. Leave the allowlist and approvers files in place (they authorize
   nothing without the executor), or restore the previous versions from
   the host backup.
3. Confirm SHADOW still exists and the shadow timer is still enabled.
4. No restart is required. Total: under 10 minutes.

## Verification (non-destructive; hand back to the activation handoff)

Run these from the repo checkout. None touches production, mints anything,
or restarts a service.

```bash
bash -n op_approval_executor.sh && bash -n test_op_approval_executor.sh
./test_op_approval_executor.sh        # expect: 54 passed, 0 failed
sha256sum op_approval_executor.sh test_op_approval_executor.sh
```

Expected: exit 0, `54 passed, 0 failed`, and hashes equal to the manifest
above. On the host (operator only, read-only):

```bash
test -f /etc/paperclip-operator/SHADOW && echo SHADOW-present
ls -l /usr/local/sbin/op-*            # root-owned, no group/other write
/usr/local/sbin/op-approve-exec verify-only \
  --request  /var/lib/paperclip-operator/queue/<id>.req.json \
  --approval /var/lib/paperclip-operator/queue/<id>.app.json
```

Expected: SHADOW present, wrappers root-owned, and `verify-only` reports
the chain state with `shadow=present` without executing.

## Exit codes (pinned by the suite)

0 executed / verified · 2 usage or bad config · 3 evidence/approval
refusal · 4 SHADOW refusal (nothing ran) · 5 filesystem/ownership refusal
· 6 replay or concurrent claim (nothing ran) · 7 script failed or timed
out (receipt recorded, never auto-retried) · 1 I/O failure.
