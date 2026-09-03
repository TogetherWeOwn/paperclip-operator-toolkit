# Bind-mount ownership: real-root is a restart landmine, container-root is the hardening owner

TOG-847 · incident 2026-09-03 ~04:16–05:22Z (~65 min paperclip.service outage).
Standing lesson from the operator, recorded here so it binds every future
hardening line, not just the two that exist today.

## The rule

**Nothing under the Paperclip bind mounts may be owned by real root (host
uid 0).** The container entrypoint runs `chown -R node:node /paperclip` on
every boot and **exits fatally** on any path it cannot chown — and under
rootless podman it cannot chown a real-root-owned path. Every real-root file
under the mounts is therefore a mine that detonates at the *next* restart,
which may be weeks after the file was created and in the middle of an
unrelated deploy.

The same agent-immutability is available without the mine: own the path as
the **host user** (`ubuntu`), which the container sees as **container-root**.
The entrypoint (container-root) can traverse and chown-skip it, agents
(container uid 1000 / `node`) still cannot write or rename it.

## Why this is confusing: the uid map

Rootless podman maps uids, so the same file reads differently depending on
where you stat it:

| owner on the host  | seen from inside the container | entrypoint chown | agent-immutable |
|--------------------|--------------------------------|------------------|-----------------|
| `root` (uid 0)     | `nobody` (unmapped)            | **FATAL**        | yes — but a mine |
| `ubuntu` (host user) | `root` (container-root)      | fine             | **yes** |
| subuid for container 1000 | `node` (agent uid)      | fine             | no |

**Consequence for every hardening doc in this repo:** a line that says "must
be `root:root`" and was *measured from inside an agent container* means
**container-root**, i.e. host `ubuntu`. If the operator executes that line on
the host as real root, `chown root:root` produces the first row — a path that
looks hardened from inside, blocks the next boot, and (worse) reads as
`nobody` from the container so in-container verification output changes too.

## What the incident measured

- First restart in weeks (TOG-516 v2 cutover, attempt 5 — the build and
  commit `51ee6c01b` were **not** defective) tripped the entrypoint chown on
  **4,943 real-root-owned paths** accumulated since the previous restart:
  `.tog373-backups`, `tog-608` recovery dirs, and the plugin-packages-root
  hardening installs.
- Rollback to the previous known-good image hit the identical mines →
  crash-boot loop, 249 restarts, ~65 minutes down.
- Fixes applied by the operator 2026-09-03: `TimeoutStartSec` 300→3600 in the
  Quadlet (headroom for a full chown pass after long uptime); all real-root
  paths converted to host-`ubuntu` ownership; post-boot re-hardening
  re-applied (plugin-packages-root and `/paperclip/.local` container-root
  owned; agent-uid rename probe re-verified denied).

## Operational consequences

1. **Hardening installs on the host use `chown ubuntu:ubuntu`** (or the
   Quadlet's mapped host user), never `chown root:root`, for anything that
   lives under a Paperclip bind mount. Runbook lines TOG-219 and TOG-310
   carry this warning inline.
2. **Verification must name its vantage point.** "`root:root` from inside the
   container" and "`ubuntu:ubuntu` from the host" are the same correct state;
   "`root:root` from the host" is the mine. `nobody` from inside the
   container means a mine already exists.
3. **Deploy scripts probe before restarting.** `TOG-516-operator-v2.sh`
   (staged, not in this repo) now refuses to restart the service while any
   real-root-owned path exists under the unit's bind-mount sources, and its
   health windows match `TimeoutStartSec=3600` — a first boot after long
   uptime legitimately spends most of that in the chown pass.
4. **Backups and recovery snapshots created with `sudo` are mines.** The
   incident's largest mine population was exactly that. Create them as the
   host user, or chown them immediately after.
