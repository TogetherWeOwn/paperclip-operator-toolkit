#!/usr/bin/env python3
"""Deterministic concurrency checks (blocker-ledger class 6).

Flags deploy races: migration steps without a concurrency group, and
seeding steps that run after the migration mutex is released (cf. the
Kofra migrate/seed mutex race).

Stdlib only, pure functions, no network/clock/filesystem.
"""

import re

MIGRATION_RUN_MARKERS = ("migrate", "alembic upgrade")

ISOLATION_MARKERS = ("--isolated",)

SEED_MARKERS = ("seed",)

_CONCURRENCY_RE = re.compile(r"(?m)^concurrency\s*:")


def _contains_any(text, markers):
    lowered = (text or "").lower()
    return any(marker.lower() in lowered for marker in markers)


def step_runs_migrations(step):
    """True when the step's run shell text contains a migration marker
    (case-insensitive)."""
    return _contains_any(step.get("run", ""), MIGRATION_RUN_MARKERS)


def has_concurrency_group(workflow_text):
    """True when the workflow YAML text declares a top-level
    concurrency: block."""
    return bool(_CONCURRENCY_RE.search(workflow_text or ""))


def check_workflow_concurrency(workflows):
    """One finding per workflow whose text runs migrations without a
    concurrency group. Findings name the workflow path."""
    findings = []
    for path in sorted(workflows):
        text = workflows[path] or ""
        if _contains_any(text, MIGRATION_RUN_MARKERS) and not has_concurrency_group(
            text
        ):
            findings.append(
                "%s: runs migrations without a concurrency group" % path
            )
    return findings


def check_migration_seed_same_lock(steps):
    """One finding when an isolation-marked migration step is followed by
    a separate seeding step (seed runs after the mutex is released). A
    single step whose run text both migrates and seeds passes, as do runs
    with no migration step or no seed step. Findings name both steps."""
    for i, step in enumerate(steps):
        run = step.get("run", "") or ""
        if not (
            step_runs_migrations(step)
            and _contains_any(run, ISOLATION_MARKERS)
        ):
            continue
        if _contains_any(run, SEED_MARKERS):
            continue
        for later in steps[i + 1 :]:
            later_run = later.get("run", "") or ""
            if _contains_any(later_run, SEED_MARKERS):
                return [
                    "%s: seed step %r runs outside the migration lock"
                    % (step.get("name", "?"), later.get("name", "?"))
                ]
    return []
