# Preventing agent writes to the deployed Paperclip application tree (TOG-649)

Measured on the live container 2026-08-30 as an ordinary agent run (uid 1000
`node`). Every claim below is a probe result, not a reading of the source.

## The finding, in one line

The agent and the Paperclip server are the same security principal — same
container, same mount namespace, same uid — so there is no boundary around
`/app` to strengthen. There is no boundary at all.

## What was measured

### 1. The agent is a child of the server

Process ancestry from inside this run:

```
bash → claude → MainThread → pid 2 (node server/dist/index.js) → pid 1 (podman-init)
```

`pid 1` is `/run/podman-init -- docker-entrypoint.sh node --import
./server/node_modules/tsx/dist/loader.mjs server/dist/index.js`. The agent is
not *talking to* the orchestrator across a boundary; it is a descendant process
of it. `readlink /proc/1/ns/mnt` is unreadable from the agent only because of
`hidepid`-style `/proc` restrictions — the agent shares the namespace, which is
why it sees `/app` at all.

### 2. `/app` is writable, and the parent directory permission hides it

```
/app                       root:root  0755   ← not writable (the only one)
/app/server                node:node  0755   ← WRITABLE
/app/server/dist/index.js  node:node  0644   ← WRITABLE
/app/node_modules          node:node  0755   ← WRITABLE  (the TOG-643 vector)
/app/package.json          node:node  0644   ← WRITABLE
```

`test -w /app` returns false, which makes the tree look protected. It is not:
only the top directory is root-owned. Everything inside it is owned by the same
uid every agent runs as.

Confirmed by `open(O_WRONLY)` — which asks the kernel the same question a
mutation would, without writing a byte or touching a timestamp:

```
OPEN_WRONLY_OK   /app/server/dist/index.js
OPEN_WRONLY_OK   /app/package.json
OPEN_WRONLY_OK   /app/pnpm-lock.yaml
OPEN_WRONLY_OK   /app/node_modules/.modules.yaml
OPEN_WRONLY_OK   /app/cli/package.json
```

### 3. This is worse than dependency corruption: `src/*.ts` is the live path

The intuitive reading is that `/app/**/src` is build input, and only
`/app/server/dist` is the running server, so a source edit is inert until a
rebuild. That is wrong on this deployment:

```
pid 1: node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js
/app/packages/adapter-utils/package.json      "exports": { ".": "./src/index.ts" }
/app/packages/adapters/claude-local/package.json  "exports": { ".": "./src/index.ts" }
```

The server runs under the `tsx` loader and the workspace packages export
`./src/*.ts` **directly**. An agent writing `/app/packages/**/src/*.ts` is
editing code the next import executes — no rebuild, no deploy, no restart.
TOG-643 hit the dependency tree; the same access reaches server code execution.

### 4. It is not hypothetical — the deployed tree is being written today

Five deployed files carried post-deployment write timestamps at the time this
was first measured (see *Drift detection* below for why this count is
trustworthy); by CISO review (2026-08-30, later the same day) two more had
appeared, for 9; re-measured again for this revision it is 7 — the file set
itself has also changed member-for-member across these measurements, not just
the count. That churn is not noise, it is the finding: the deployed tree is
being written *continuously* by concurrent runs, not once.

```
.claude/settings.local.json
packages/adapter-utils/src/acpx-engine/execute.ts
packages/adapters/claude-local/src/index.ts
packages/plugins/sdk/src/define-plugin.ts
server/src/routes/plugins.ts
server/src/services/plugin-host-services.ts
server/src/services/remote-http-endpoint-guard.ts
```

(current as of this revision; re-run `app_tree_guard.sh --audit` for the
live set — it will not match this list by the time you read it)

Several of these are in the live-executed path described above.

**What this does and does not prove.** It proves the write path is open and in
use: something wrote these files after the image was deployed. It does **not**
prove their contents diverged. Compared against three local release copies, the
four `.ts` files are byte-identical to two of them and differ from the third —
but those copies are *different versions* of Paperclip, so agreement is not
evidence of pristineness and disagreement is not evidence of tampering. The
authoritative oracle would be the overlay `upperdir`
(`…/overlay/7e6b808c…/diff`), which by construction contains exactly the
post-deployment writes; it is a host path and is not readable from inside the
container.

The honest reading: at least one of these writes was almost certainly benign and
idempotent — `writePaperclipClaudeSettings()` at
`packages/adapter-utils/src/acpx-engine/execute.ts:1234` writes
`.claude/settings.local.json` into its `cwd` on every run, and when an agent's
`cwd` is `/app` that lands in the deployed tree. That is the point. A routine,
well-intentioned code path is already writing the deployed tree as a matter of
course, which is precisely why the boundary cannot be left to convention.

### 5. The deployed Quadlet carries no isolation at all

`/app/docker/quadlet/paperclip.container` has no `--read-only`, no `--cap-drop`,
no `--user`, and no per-run container. The image is not the problem; the unit is
simply not asking for any of it.

## Why permissions cannot fix this

The obvious repair — `chown root` or `chmod -R a-w /app` — is not a boundary
here. Every agent is uid `node`, and so is the deployed tree's owner. The agent
owns the files, so it can `chmod` them back. Ownership-based permissions cannot
separate two principals that *are* the same principal.

The separation has to come from the **mount**, which is the one thing a uid-1000
process cannot rewrite for a namespace it does not control.

## The control

`app_tree_guard.sh` uses unprivileged user namespaces — enabled on this host
(`user.max_user_namespaces = 2147483647`, `unprivileged_userns_clone = 1`) — to
drop the agent's own process tree into a namespace where `/app` is bind-mounted
read-only. No root, no host change, invisible to the server and to every other
run.

```
app_tree_guard.sh --audit                 # what can I mutate; what already drifted
app_tree_guard.sh --selftest              # prove the denial matrix
app_tree_guard.sh --exec -- <cmd>         # run <cmd> with /app immutable
```

### It does not come back off

A wrapper the guarded process can undo is theatre. The escape to close is
nesting a second user namespace and remounting. Measured under the guard:

| escape attempt                          | result                      |
|-----------------------------------------|-----------------------------|
| nested `unshare` + `remount,bind,rw`     | `EPERM`                     |
| nested `unshare` + fresh bind, then rw   | denied                      |
| nested `unshare` + `umount /app`         | `EINVAL` "not mounted"      |
| write after all three                    | `EROFS`                     |

The kernel locks a mount inherited from a parent user namespace: its `ro` flag
cannot be cleared and it cannot be unmounted to reveal the writable mount
underneath. That lock is what makes this a control rather than a convention.

**This depends on running the guarded command one namespace below the one
that owns the mount, never inside it.** `--exec` builds the bind+ro mount in
an outer `unshare`, then re-`unshare`s once more before handing control to
the caller's command — so by the time the command runs, the mount it is
sitting on was inherited from a parent namespace, and inheritance is what the
kernel locks. Running the command directly in the mount-owning namespace
instead — the escape table above measures the correct (nested) build — would
hand that command `CAP_SYS_ADMIN` over its own mount, and a single unnested
`mount -o remount,bind,rw "$APP"` would clear the `ro` flag with no `EPERM`
at all. That gap existed in an earlier draft of `--exec` (PR #138), was
caught in CISO review, and is reproduced standalone in
`mount-escape-repro.sh`.

### What stays writable on purpose

Blanket read-only `/app` breaks real work — `vitest` writes its cache into
`/app/node_modules/.vite` and `/app/server/node_modules/.vite`, and ordinary
agent test runs hit those. The guard rebinds exactly those paths onto run-owned
scratch, so the writes succeed and land in the run's own directory. Verified: a
cache write under the guard succeeds and the file does **not** appear in `/app`.

`/paperclip` is deliberately untouched — it is persistent server state the
server needs writable. This control is scoped to the deployed *code* tree.

### Fail closed

If `unshare` is missing or the kernel refuses a namespace, `--exec` **refuses**
and names the reason. It never falls through to running the command unguarded;
a guard that silently degrades is worse than none, because the caller believes
the boundary held. Covered by test, and mutation-tested (below).

## Drift detection

Two wrong approaches were tried and discarded:

- **`/app`'s own mtime as the threshold** — circular and badly wrong. `/app` is
  stamped early in the build, before `pnpm install` populates `node_modules`, so
  **69,522** ordinary image files read as drift.
- **A later artifact's mtime as the threshold** — silently misses anything
  backdated.

The reliable discriminator is **nanosecond granularity, not timestamp value**.
Image layers are tar archives and tar stores whole seconds, so every file the
image extracted has an mtime with exactly zero nanoseconds. Anything written
afterwards by a live process carries the filesystem's real nanosecond clock:

Counts below are a point-in-time snapshot from initial drafting; see the note
in *"It is not hypothetical"* above — the live count moves run to run. Rerun
`--audit --json` for the current figures.

```
zero-ns    (extracted from the image) : 73,937
nonzero-ns (written after deployment) :      7   (5 excluding vite caches)
```

That is a property of *how the file arrived*, not of *when*, and it defeats
**accidental and incidental** writes — the actual threat model here, since
nothing in a routine agent run or code path has a reason to backdate a
timestamp. It is not tamper-proof against a deliberate attacker: `touch -d`
to a whole-second timestamp (e.g. `touch -d '2026-08-18 03:23:05'`) produces
a zero-ns mtime and evades the detector, confirmed by direct test. Anyone
relying on drift detection as an adversarial control, rather than as a
monitor for unintended writes, should not.

## Verification

`test_app_tree_guard.sh` — 32 hermetic tests, no network, no dependence on the
real `/app` (each test builds a throwaway fixture and points the SUT at it via
`APP_TREE_GUARD_APP`). Asserting against the live tree would pass or fail based
on what another run happened to be doing, and would mutate deployed state to
prove that mutation is blocked.

The suite covers the full denial matrix — write/truncate/append, `src/*.ts`
write, unlink, rename, hardlink, symlink, chmod, chown, mkdir, create,
package-manager install dir, and symlink escape from scratch back into `/app` —
plus the three things that must keep working (read, module resolve, cache
write), exit-code propagation, and byte-identical tree after a guarded run.

Two guards against a test that measures nothing:

- **No vacuous pass.** `--selftest` first proves the tree is writable *without*
  the guard. Run against an already-immutable tree it reports every mutation
  denied — and fails, because that result proves nothing about the guard.
- **Mutation-tested.** Breaking the control reddens the suite:

  | mutation                                | result          |
  |-----------------------------------------|-----------------|
  | drop the `remount,bind,ro` (bind only)  | 14 tests fail   |
  | fail *open* instead of closed on no-userns | 3 tests fail |
  | unmutated                               | 32 pass, 0 fail |

### End-to-end reproduction of the TOG-643 vector

A scratch `node_modules` symlinked at the deployed tree, then a package manager:

```
UNGUARDED : writable through symlink → /app     ← the TOG-643 vector, still open
GUARDED   : denied (EROFS)
```

## Scope and what this does not do

This closes the vector for **any run that invokes it**. It is not a
company-wide boundary: an agent that does not call the wrapper still has the
access, because the underlying defect — server and agent as one principal — is
a property of the deployment, not of the wrapper.

The complete fix is the two-container split (server container with
`--read-only`, plus a per-run agent container with `--user`, `--network=none`
and no `/app` mount), already rendered as a carrier under TOG-655 and validated
`--dryrun` only. That needs host authority this issue explicitly withholds, and
fresh CISO + DevOps acceptance before any handoff.

**Nothing here has been installed, applied, or activated.** No host config, no
Quadlet, no image, no service, and no write to `/app`. `--audit` and
`--selftest` are read-only; `--exec` affects only the calling process's own
namespace.

## Recommended adoption

1. Wrap dependency-installing and test-running steps in agent runs:
   `app_tree_guard.sh --exec -- pnpm install …`
2. Run `--audit --json` as a monitor. It exits non-zero while the deployed tree
   is mutable **or** already drifted, which is the correct red state today and
   is what the two-container carrier will eventually turn green.
3. Treat the currently drifted files (see `--audit`; count moves run to run,
   see above) as an open containment item. Note that
   restoring them is **not** the priority and may be unnecessary — their
   contents may well be correct. What matters is that the write path is open;
   restoring content without landing a control just reruns TOG-643.
4. Fix the `cwd`-relative settings write. While the guard blocks it from
   outside, the real repair is that `writePaperclipClaudeSettings()` should
   never resolve into the deployed tree. That is an upstream Paperclip change,
   described here as an uninstalled carrier only.
