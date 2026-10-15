#!/usr/bin/env python3
"""Deterministic concurrency checks (blocker-ledger class 6).

Flags deploy races: migration steps without a concurrency group, and
seeding steps that run after the migration mutex is released (cf. the
Kofra migrate/seed mutex race).

Stdlib only, pure functions, no network/clock/filesystem.
"""

import re

MIGRATION_RUN_MARKERS = ("migrate", "alembic upgrade", "migrations apply")

ISOLATION_MARKERS = ("--isolated",)

SEED_MARKERS = ("seed",)

_TOP_CONCURRENCY_RE = re.compile(r"(?m)^concurrency\s*:")
_JOBS_RE = re.compile(r"^(\s*)jobs\s*:\s*(#.*)?$")
_JOB_KEY_RE = re.compile(r"""^(\s*)(?:"([^"]+)"|'([^']+)'|([\w\-.]+))\s*:\s*(#.*)?$""")
_CONCURRENCY_LINE_RE = re.compile(r"^(\s*)concurrency\s*:")
_STEPS_RE = re.compile(r"^\s*steps\s*:\s*(#.*)?$")


def _contains_any(text, markers):
    lowered = (text or "").lower()
    return any(marker.lower() in lowered for marker in markers)


def step_runs_migrations(step):
    """True when the step's run shell text contains a migration marker
    (case-insensitive)."""
    return _contains_any(step.get("run", ""), MIGRATION_RUN_MARKERS)


def _indent_of(line):
    expanded = line.expandtabs(2)
    return len(expanded) - len(expanded.lstrip(" "))


def _migration_job_has_own_concurrency(lines, job_start, job_indent, next_start):
    """True when the job block declares `concurrency:` as a direct child of
    the job key and the same job runs migrations.

    The direct-child indent is derived from the block itself (the shallowest
    indented mapping line under the job key), so 2-space and 4-space
    workflows both match; quoted job keys are accepted by `_JOB_KEY_RE`.
    A `concurrency:` nested deeper (a `with:` step input, or run-script
    text) does not satisfy the check. Line-anchored heuristic: a
    `concurrency:` line inside a run script at exactly the direct-child
    indent would also match.
    """
    block = lines[job_start + 1:next_start]
    block_text = "\n".join(block)
    if not _contains_any(block_text, MIGRATION_RUN_MARKERS):
        return False
    want = None
    for raw in block:
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = _indent_of(raw)
        if indent <= job_indent:
            continue
        if want is None or indent < want:
            want = indent
    if want is None:
        return False
    for raw in block:
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("- ") or stripped == "-":
            continue
        m = _CONCURRENCY_LINE_RE.match(raw)
        if m and _indent_of(raw) == want:
            return True
    return False


def has_concurrency_group(workflow_text):
    """True when every migrating job is serialised.

    Accepts a top-level `concurrency:` (column 0), which serialises the
    whole workflow, or a `concurrency:` block directly under EACH job key
    whose steps run migrations (direct-child indent is derived from the
    block, so 2-space and 4-space workflows both match). A `concurrency:`
    on a non-migrating job, or a `concurrency:` step input (`with:`),
    does not satisfy the check; one serialised migrating job never covers
    a second migrating job without its own group.
    """
    text = workflow_text or ""
    if _TOP_CONCURRENCY_RE.search(text):
        return True
    lines = text.splitlines()
    jobs_at = None
    jobs_indent = None
    for idx, raw in enumerate(lines):
        m = _JOBS_RE.match(raw)
        if m:
            jobs_at = idx
            jobs_indent = _indent_of(raw)
            break
    if jobs_at is None:
        return False
    # Derive the job-key indent from the block itself (first job-key line
    # under `jobs:`), so 2-space and 4-space workflows both match. Quoted
    # job keys ("deploy":) are accepted.
    job_indent = None
    for idx in range(jobs_at + 1, len(lines)):
        raw = lines[idx]
        if not raw.strip() or raw.strip().startswith("#"):
            continue
        if _indent_of(raw) <= jobs_indent:
            break
        if _JOB_KEY_RE.match(raw):
            indent = _indent_of(raw)
            if job_indent is None or indent < job_indent:
                job_indent = indent
    if job_indent is None:
        return False
    starts = []
    for idx in range(jobs_at + 1, len(lines)):
        raw = lines[idx]
        if not raw.strip() or raw.strip().startswith("#"):
            continue
        indent = _indent_of(raw)
        if indent <= jobs_indent:
            break
        if indent == job_indent and _JOB_KEY_RE.match(raw):
            starts.append((idx, indent))
    migrating = []
    for si, (start, ji) in enumerate(starts):
        end = starts[si + 1][0] if si + 1 < len(starts) else len(lines)
        # Trim at dedent to jobs level (next top-level key).
        for idx in range(start + 1, end):
            raw = lines[idx]
            if not raw.strip() or raw.strip().startswith("#"):
                continue
            if _indent_of(raw) <= jobs_indent:
                end = idx
                break
        block_text = "\n".join(lines[start + 1:end])
        if _contains_any(block_text, MIGRATION_RUN_MARKERS):
            migrating.append((start, ji, end))
    if not migrating:
        return False
    return all(
        _migration_job_has_own_concurrency(lines, start, ji, end)
        for start, ji, end in migrating
    )


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


def job_step_blocks(text):
    """Split workflow text into per-job [{name, run}] step lists.

    Line-based subset parser: follows each `steps:` list, `name:`
    / `run:` scalars and `run: |` blocks. One block per `steps:`
    section, so a migrate step in one job never pairs with a seed
    step in another. Compact sequence lists (a `- ` item at the same
    indent as the `steps:` key) are parsed; anything else unrecognized
    is skipped; never raises (worst case the seed check sees no steps).
    """
    blocks = []
    lines = (text or "").splitlines()
    total = len(lines)
    i = 0
    while i < total:
        if not re.match(r"^\s*steps\s*:\s*(#.*)?$", lines[i]):
            i += 1
            continue
        base = len(lines[i]) - len(lines[i].lstrip(" "))
        i += 1
        block = []
        cur = None
        item_indent = base
        while i < total:
            raw = lines[i]
            stripped = raw.strip()
            if not stripped or stripped.startswith("#"):
                i += 1
                continue
            indent = len(raw) - len(raw.lstrip(" "))
            if indent < base:
                break
            if indent == base and not (
                stripped == "-" or stripped.startswith("- ")
            ):
                # Sibling mapping key at the `steps:` level (e.g. the next
                # job key or `jobs:` section end); a `- ` item at this
                # indent is a compact sequence entry and belongs to us.
                break
            item = re.match(r"^(\s*)-\s+(.*)$", raw)
            if item and indent >= base:
                if cur is not None:
                    block.append(cur)
                cur = {"name": "", "run": ""}
                item_indent = indent
                rest = item.group(2).strip()
                if not rest:
                    i += 1
                    continue
                stripped = rest
                indent += 2
            if cur is None:
                i += 1
                continue
            key = re.match(r"^(name|run)\s*:\s*(.*)$", stripped)
            if key and indent > item_indent:
                field, val = key.group(1), key.group(2).strip()
                if field == "run" and val in (
                    "|", ">", "|-", "|+", ">-", ">+",
                ):
                    i += 1
                    chunk = []
                    while i < total and (
                        not lines[i].strip()
                        or len(lines[i]) - len(lines[i].lstrip(" ")) > indent
                    ):
                        if lines[i].strip():
                            chunk.append(lines[i].strip())
                        i += 1
                    cur["run"] = "\n".join(chunk)
                    continue
                if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
                    val = val[1:-1]
                cur[field] = val
            i += 1
        if cur is not None:
            block.append(cur)
        blocks.append([s for s in block if s.get("run")])
    return blocks


# Back-compat alias: the gate heredoc used this name before the parser
# moved into the lib. New code should use job_step_blocks.
_job_step_blocks = job_step_blocks
