# GARM Wave-1 cutover dry-run walkthrough + rollback note (source-only tabletop)

Status: tabletop preparation ONLY, 2026-10-03. This document authorizes NO host
build, NO pool/image/profile/label/cap change, NO workflow publication or merge,
NO CI dispatch on live infra, NO static drain or retirement, NO credential action
and NO production-DB contact. It does not revise the preparation-only approval of
the execution packet (current reviewed revision): entry gates, HOLDs and
ownership there are unchanged. No mutating CLI syntax is published here: UNKNOWN
command syntax stays a blocker and is never filled from examples.

## 0. Registers this walkthrough stands on

| # | Register | State | What it proves (and does not prove) |
|---|----------|-------|--------------------------------------|
| W0-1 | Min-idle lifecycle record, ACCEPTED | done | Provision 0→1 ≈2 min, reclaim 1→0 ≈2 min; pool fields unchanged (max 2, provider, flavor, tags, enabled); no other host or pool touched. Proves idle lifecycle ONLY, not job pickup or throughput. |
| W0-2 | Wave-0 backups | retained privately | Before/after plus sanitized verification retained privately (location recorded in the operator log); agent-unreadable by design. Cited by location only, never quoted. |
| W0-3 | Wave-0 self-reverting scope | done | No static/label/service/cache/workspace/credential action in Wave-0. |
| W0-4 | `garm-cli` JSON gotcha | recorded | `pool show` omits `min_idle_runners` when it is 0: treat absent as 0 and confirm via table output. |
| W1-C | Cohort definition, packet §Wave 1 | recorded revision | First bounded LIVE cohort = a private cohort repository `jobs.port-gate`, pinned source, job, service and secret names. A broad red sibling job is excluded as evidence. |
| W1-R | Readiness S1/S2/S3 | recorded revision | S1 concurrency fix (not conditional cancellation); S2 push-to-main-only arm after protection proof; S3 no invented host selector. None applied by this document. |
| W1-Q | QA reference | done, HOLD | Gate real: 16 cases / 278 assertions at the pin, N=1. Not a baseline, p95 or throughput claim. |
| W1-P | Prior Wave-1 prep | reviewed, source-only | Rehearsal plus threshold and guard reviews; source-only, nothing installed. Threshold scope reused; live numbers re-read at the window (gap G3). |
| W1-O | Observability | pool-watch script plus canary workflow | 5-minute pool/queue watch; pickup/completion proof shape. Merges are not deployment. |

## 1. Cutover walkthrough (tabletop sequence)

Preconditions (every one must read PASS or HOLD-clear at window open; any
UNKNOWN is HOLD, never a guessed proceed): packet entry gates — private
repo plus exact group/ref trust; pinned source, job, service and secret NAMES;
a verified EXISTING one-host trial selector; fresh CPU/RAM/PSI/IO/filesystem
plus busy/idle VMs and reservations with the trial-host ≤1-vs-max-2
reconciliation; image/toolchain match for `port-gate` (the isolated class OUT
of this privileged trial); matched static history, independent packet approval,
exact-head review, explicit bounded execution authorization and deployed read
paths.

- **T0 — Backups, against the Wave-0 register.** Keep W0-1/W0-2 untouched and
  add: exact old workflow blob plus reviewed diff; check identities, matrix,
  artifact names; preserved static replacement capacity; a fallback-availability
  verdict (if static fallback is unsafe, HOLD and escalate — never promise
  rollback works). Without these, HOLD.
- **T1 — Concurrency guard (S1) lands first**, under its own separate review on
  the candidate repository. It affects both sibling jobs. Never restore
  cancel-in-progress as an emergency rollback while a run is active: routing
  rollback restores only the selected job's future assignment.
- **T2 — One-job selector flip.** Exactly one job's `runs-on` becomes
  `[self-hosted, two-ephemeral, <verified-trial-host-only-tag>]`. Order: verify
  group admission for the exact repository first (public PRs excluded, no
  permission widening), then flip the selector; check names, matrix, caches and
  artifact upload unchanged. Generic `two-ephemeral` alone matches BOTH hosts
  and is NOT adequate. No verified tag: HOLD for a separate reviewed idle-safe
  configuration step, never an invented selector or ad hoc relabeling. The
  canary workflow stays untouched.
- **T3 — Window opens.** Record pool/host before-state, eligible queue depth and
  zero overlapping unlogged host actions. No static drain yet. Ordinary trusted
  traffic only; no synthetic load dispatched by inference.
- **T4 — First eligible pickup (≤15 min).** Record `RUNNER_NAME` (must be
  `garm-*`, else a static runner carries a GARM label), pool/provider/VM
  identity and queued/started/completed stamps. No pickup: HOLD subsequent
  rollout, report label/group/provider state; no blind pool restart or
  enlargement, no cancelling active/queued work to obtain a green result.
- **T5 — Completion.** Record conclusion, artifact upload and the
  Tests/Assertions line (expect 16/278 at this pin; explain any source change
  before comparing). Missing or skipped tests are HOLD, not green.
- **T6 — Cleanup and isolation (≤15 min after completion).** The EXACT job VM
  must disappear from BOTH GARM and provider inventories; the next matched job
  must land on a fresh identity with no prior state. Registration absence alone
  is NOT VM reclamation. Leak or missing evidence: NO-GO, stop expansion, let
  active work finish; cleanup only through a separately approved idle-only
  operation, never an inferred forced delete.
- **T7 — Comparison.** At least 24 hours from the routing merge AND at least 10
  comparable completed attempts per arm, static fleet untouched, under a real
  armed monitor; then the numerical go/no-go goes to the designated
  trial-decision record. Short traffic: extend once under the monitor
  or report INCONCLUSIVE — never manufacture traffic or call it PASS.

NOT-steps (explicitly out of this cutover): synthetic workload dispatch; pool
restart, enlargement or relabeling; static runner drain, unregistration or
retirement; provider upgrade or restart; cache/workspace deletion; profile
changes on running VMs; production or staging endpoint contact.

Validation commands (TABLETOP — read-only; mutating syntax stays a blocker):

```sh
# Pool state (reviewed in push-garm-pool.sh): FULL pool UUIDs only, short
# prefixes are rejected; absent min_idle_runners means 0.
garm-cli pool show <FULL-pool-UUID> --format json

# Eligible demand (pattern reviewed in push-garm-pool.sh): oldest queued job
# carrying the eligible label, server-side --created walk, job-level check.
gh run list --repo <cohort-owner>/<cohort-repo> --status queued --created "<cutoff>" --limit 1000 --json databaseId,createdAt
gh api repos/<cohort-owner>/<cohort-repo>/actions/runs/<RID>/jobs?per_page=100  # label filter via jq

# Job proof shape (packet v2-C): RUNNER_NAME, pool/provider/VM identity,
# queued/started/completed stamps, conclusion, artifact reference,
# Tests/Assertions line.
```

Live watch during the window: the pool monitor (5-minute cron, 10-minute
heartbeat, 60-minute eligible-label breach pages). Scale-to-zero with
no eligible demand is HEALTHY, not a stall.

## 2. Rollback note

Two-tier triggers. HOLD (stop rollout, keep observing): no pickup within
15 min; missing/skipped tests; stale or missing budget evidence; any relevant
filesystem at or above 95% or an unresolved pressure incident; static fallback
unavailable (escalate, never promise rollback works). NO-GO (immediate,
independent of speed): an interrupted active job; production-DB contact;
unauthorized access or routing; an unexplained lifecycle leak; any cap or
admission increase; a host-pressure stop breach.

Machine verdict (source-only):
`github-runner/garm/wave1_window_verdict.py` reads one `garm-wave1-window.v1`
observation file and prints PROCEED, HOLD, NO-GO or UNKNOWN with reason codes.
NO-GO outranks HOLD outranks UNKNOWN; PROCEED needs every field present and
inside its threshold, so a null or missing field is UNKNOWN. Budget evidence
older than 15 min is stale: a code-side bound, since this note names none, for
the operator window to ratify. A trial below the adequacy floor is
INCONCLUSIVE and is emitted as UNKNOWN. A verdict licenses no cap, label,
routing or pool change; every result carries `admission_authorized:false`,
`host_verified:false` and `migration_complete:false`. The window stays
Operator-owned. `test_isolated_wave1_window_verdict.py` fails when these
numbers and the code disagree.

Backout steps (deltas against the Wave-0 register):

- **R1 — Routing revert.** Exact one-job revert to `[self-hosted,
  two-selfhosted]` under reviewer-owned merge with normal checks. It affects
  future assignments only; already-running GARM jobs continue naturally and
  upload artifacts. W1-1 backups make this exact; W0 pool state was never
  mutated by the trial.
- **R2 — No collateral mutation.** No VM, profile, pool, cap, pin or admission
  change during backout; the provider is never restarted by inference; no
  automatic rollback may restore privileged access to isolated jobs.
- **R3 — Fallback capacity is the precondition.** Static replacement capacity
  preserved throughout the trial is what makes R1 safe (gap G8 if it is not).
- **R4 — Evidence preserved.** A leaked VM is cleaned only through a separately
  approved idle-only operation with before/after correlation on both
  inventories.
- **R5 — Re-entry needs fresh gates**, not resume-from-rollback.

Source-only rollback of THIS document: before merge, revise this branch; after
merge, revert the exact squash commit through normal review and CI. Nothing is
installed, so there is no host runtime state to revert.

Timings table (measured anchors vs window budgets):

| Step | Measured anchor | Source | Window budget / gate |
|------|-----------------|--------|----------------------|
| Wave-0 provision | ≈2 min (0→1, RUNNING/IDLE shortly after) | min-idle lifecycle record | 15-min confirm limit |
| Wave-0 reclaim | ≈2 min (1→0, absent both inventories shortly after) | min-idle lifecycle record | 15-min post-completion lifecycle deadline (packet D) |
| Canary probe ceiling | job `timeout-minutes: 15` | canary workflow | per-job ceiling |
| Canary service readiness | bounded TCP health-cmd plus retry | reviewed canary change | initdb-race guard, not a trial gate |
| `port-gate` reference exec | ≈137 s exec, ≈38 s created-to-start proxy, ≈24 s gate step | reference run | matched-comparison baseline (N=1, not p95) |
| Eligible-queue watch | */5 cron, 10-min heartbeat, 60-min breach | pool-watch script | paging signal, not the tighter 15-min trial pickup gate |
| Trial adequacy | ≥24 h from routing merge AND ≥10 comparable completed attempts per arm | trial contract via packet E | extend once under a real monitor, else INCONCLUSIVE |
| Scale-down guard | TTL 15 min, cooldown 20 min, 120-min flap hold, floor 1 plus reviewer/fixer reserve 1 | scale-down guard record | post-trial drain only, never cutover |

Decision thresholds (carried from the registers above; the operator window
ratifies them against fresh measurements, never from this document alone):
pickup 15 min; cleanup 15 min post-completion; queue page 60 min; trial 24 h
plus 10/arm; filesystem stop floor 95%; trial-host ≤1-vs-max-2 reconciled before
the wave; any safety violation is NO-GO regardless of speed.

## 3. Gap list (follow-ups; no redesign here)

- **G1.** No verified trial-host-exclusive selector exists; generic
  `two-ephemeral` matches both hosts. Window precondition, else a separate
  reviewed idle-safe configuration step (packet gate 3, readiness S3).
- **G2.** Target-image toolchain for `port-gate` unproved (database client,
  language runtime plus extensions, package manager, setup egress, cold-cache
  demand, bundled action runtime): needs a built, reviewed and rehearsed image
  or a trusted pinned job container — never improvised installation (packet
  gate 5; reuses the recorded image prep and its host packet).
- **G3.** Budget/quota/reset-window numbers must be re-read fresh at the
  window; dated baselines are not admission permission (packet gate 4).
- **G4.** Trial coordination still points at a superseded comparison; re-point
  that path to the actual comparison before any trial, preserving numeric
  go/no-go ownership.
- **G5.** Required-check and ruleset identity for `port-gate` unverified; do
  not suppress, reinterpret or weaken the intentionally red sibling `test`.
- **G6.** Isolation rollout still blocked for the shared path: relevant only if
  isolated suites later ride this path; this privileged trial explicitly
  excludes the isolated class.
- **G7.** Legacy-host image and compatibility unknown: trial-host-first
  sequencing holds; no generic-selector trial.
- **G8.** Fresh reservations and workload-specific reserve/pressure bounds need
  operator/reviewer approval from a measured baseline BEFORE the wave,
  including the trial-host ≤1-vs-max-2 reconciliation.
- **G9.** A real issue monitor must be armed at trial start with an owner and
  path (packet E); this slice carries none per card scope.
- **G10.** Trust policy: private visibility plus no-forking is not a trusted
  contributor attestation; the S2 push-to-main-only arm needs branch-protection
  proof first.

## Evidence and limits

Inspected in this worktree/sandbox on 2026-10-03: execution-packet v2
(current reviewed revision, full body reviewed); readiness, admission,
source-preparation and host-packet revisions (abort/rollback section); the
min-idle lifecycle receipt timings; the port-gate audit (reviewed revision);
the canary workflow and its reviewed commits; the pool-watch script header
defaults (60-min threshold, */5 cron, full-UUID requirement); the rehearsal
record (passing run, bundle mechanics only); the scale-down guard record
(TTL 15, cooldown 20, flap hold 120); the budget-scope record (description
only; detail sub-routes were unavailable from this sandbox, so only its
threshold scope is reused here). No live state was touched
or observed in this slice; no secrets were seen or printed.

What this document does not do: publish a selector, invent CLI syntax, confer
live authority, redesign the cutover, or substitute for the missing admission
evidence. The next deliverable is that evidence plus the operator window, not
another survey.
