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


def _uses_text_runs_migrations(uses):
    """True when a step (or job) `uses:` reference runs migrations.

    Tests the value against `MIGRATION_RUN_MARKERS` plus the `migrat`
    stem, so a local composite action such as
    `./.github/actions/run-migrations` counts: action paths name what
    the action does, unlike `needs:`, names, and comments, which are
    never consulted here. Inline `#` comments are stripped first.
    """
    value = (uses or "").split(" #", 1)[0]
    lowered = value.lower()
    return _contains_any(value, MIGRATION_RUN_MARKERS) or "migrat" in lowered


def step_runs_migrations(step):
    """True when the step runs migrations (case-insensitive).

    Consults the step's `run:` shell text, its `uses:` action reference
    (markers plus the `migrat` stem, so `run-migrations` composites
    count), and its `with:` input values (markers) — never `needs:`,
    names, or comments.
    """
    step = step or {}
    if _contains_any(step.get("run", ""), MIGRATION_RUN_MARKERS):
        return True
    if _uses_text_runs_migrations(step.get("uses", "")):
        return True
    return _contains_any(step.get("with", ""), MIGRATION_RUN_MARKERS)


_USES_LINE_RE = re.compile(r"^\s*uses\s*:\s*(.+?)\s*(#.*)?$")


def _job_level_uses_runs_migrations(job_text):
    """True when the job itself is a `uses:` reference that runs
    migrations (a reusable-workflow call such as
    `uses: ./.github/workflows/migrate.yml`, which has no `steps:` at
    all). Only line-anchored `uses:` keys are consulted — full-line
    comments are skipped — so `needs:`, names, and comments never
    count. A `uses:` line inside a `run:` script block would also
    match; shell scripts never contain one in practice.
    """
    for raw in (job_text or "").splitlines():
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        m = _USES_LINE_RE.match(raw)
        if m and _uses_text_runs_migrations(m.group(1)):
            return True
    return False


def _indent_of(line):
    expanded = line.expandtabs(2)
    return len(expanded) - len(expanded.lstrip(" "))


def _job_block_runs_migrations(job_text):
    """True when the job block runs migrations.

    Parses the block with `job_step_blocks` and tests each step's
    `run:`/`uses:`/`with:` text with `step_runs_migrations`, plus the
    job-level `uses:` (reusable-workflow calls have no `steps:`), so
    `needs:`, names, and comments mentioning migrate never count.
    Never raises (worst case False).
    """
    try:
        for block in job_step_blocks(job_text or ""):
            for step in block:
                if step_runs_migrations(step):
                    return True
        if _job_level_uses_runs_migrations(job_text or ""):
            return True
    except Exception:
        return False
    return False


def _migration_job_has_own_concurrency(lines, job_start, job_indent, next_start):
    """True when the job block declares `concurrency:` as a direct child of
    the job key and the same job runs migrations.

    "Runs migrations" is decided from the job's step `run:` text (via
    `job_step_blocks` / `step_runs_migrations`), never the raw block text:
    a `needs: migrate`, a job/step name, or a comment mentioning migrate
    must not make a non-migrating job count as migrating. The direct-child
    indent is derived from the block itself (the shallowest
    indented mapping line under the job key), so 2-space and 4-space
    workflows both match; quoted job keys are accepted by `_JOB_KEY_RE`.
    A `concurrency:` nested deeper (a `with:` step input, or run-script
    text) does not satisfy the check. Line-anchored heuristic: a
    `concurrency:` line inside a run script at exactly the direct-child
    indent would also match.
    """
    job_text = "\n".join(lines[job_start + 1:next_start])
    if not _job_block_runs_migrations(job_text):
        return False
    block = lines[job_start + 1:next_start]
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
        # Migrating is decided from step `run:` text only (see
        # `_job_block_runs_migrations`): `needs:`, names, and comments
        # mentioning migrate never count.
        if _job_block_runs_migrations("\n".join(lines[start + 1:end])):
            migrating.append((start, ji, end))
    if not migrating:
        return False
    return all(
        _migration_job_has_own_concurrency(lines, start, ji, end)
        for start, ji, end in migrating
    )


def check_workflow_concurrency(workflows):
    """One finding per workflow with a migrating job (a step whose
    `run:`/`uses:`/`with:` text runs migrations, or a job-level `uses:`
    reusable-workflow call) and no concurrency group. A bare `needs:`,
    name, or comment mentioning migrate is not a migrating job, so it
    never flags on its own. Findings name the workflow path."""
    findings = []
    for path in sorted(workflows):
        text = workflows[path] or ""
        if _workflow_has_migrating_job(text) and not has_concurrency_group(
            text
        ):
            findings.append(
                "%s: runs migrations without a concurrency group" % path
            )
    return findings


def _workflow_has_migrating_job(workflow_text):
    """True when any job in the workflow runs migrations (a step whose
    `run:`/`uses:`/`with:` text runs migrations, or a job-level `uses:`
    call). Never raises (worst case False)."""
    try:
        text = workflow_text or ""
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
                starts.append(idx)
        for si, start in enumerate(starts):
            end = starts[si + 1] if si + 1 < len(starts) else len(lines)
            for idx in range(start + 1, end):
                raw = lines[idx]
                if not raw.strip() or raw.strip().startswith("#"):
                    continue
                if _indent_of(raw) <= jobs_indent:
                    end = idx
                    break
            if _job_block_runs_migrations("\n".join(lines[start + 1:end])):
                return True
    except Exception:
        return False
    return False


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


_BLOCK_SCALAR_RE = re.compile(r"[|>](?:[1-9][+-]?|[+-][1-9]?)?(?:\s+#.*)?$")


def _block_scalar(lines, start, indent, folded):
    """Read one scalar to its dedent, never a sibling input, step or job."""
    chunk = []
    i = start
    while i < len(lines) and (
        not lines[i].strip() or _indent_of(lines[i]) > indent
    ):
        value = lines[i].strip()
        if value and not value.startswith("#"):
            chunk.append(value)
        i += 1
    return (" " if folded else "\n").join(chunk), i


def job_step_blocks(text):
    """Split workflow text into per-job [{name, run, uses, with}] steps.

    Line-based subset parser: follows each `steps:` list, `name:` /
    `run:` / `uses:` scalars, literal/folded blocks, and `with:` input
    mappings (including multiline command/script values). One block
    per `steps:` section, so a migrate step in one job never pairs
    with a seed step in another. Compact sequence lists (a `- ` item
    at the same indent as the `steps:` key) are parsed; anything else
    unrecognized is skipped; never raises (worst case the seed check
    sees no steps). `needs:`, job/step names, and comments are never
    captured — only `run:`/`uses:`/`with:` values.
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
        with_indent = None
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
                cur = {"name": "", "run": "", "uses": "", "with": ""}
                item_indent = indent
                with_indent = None
                rest = item.group(2).strip()
                if not rest:
                    i += 1
                    continue
                stripped = rest
                indent += 2
            if cur is None:
                i += 1
                continue
            if with_indent is not None:
                if indent > with_indent:
                    pair = re.match(r"^([\w\-.]+)\s*:\s*(.*)$", stripped)
                    if pair:
                        val = pair.group(2).strip()
                        if _BLOCK_SCALAR_RE.fullmatch(val):
                            val, i = _block_scalar(
                                lines, i + 1, indent, val.startswith(">")
                            )
                            cur["with"] = "\n".join(
                                v for v in (cur["with"], val) if v
                            )
                            continue
                        if len(val) >= 2 and val[0] == val[-1] \
                                and val[0] in "\"'":
                            val = val[1:-1]
                        if val:
                            cur["with"] = (
                                (cur["with"] + "\n" + val)
                                if cur["with"] else val
                            )
                    i += 1
                    continue
                with_indent = None
            with_key = re.match(r"^with\s*:\s*(.*)$", stripped)
            if with_key and indent > item_indent:
                inline = with_key.group(1).strip()
                if inline and inline not in ("{}",):
                    cur["with"] = (
                        (cur["with"] + "\n" + inline)
                        if cur["with"] else inline
                    )
                with_indent = indent
                i += 1
                continue
            key = re.match(r"^(name|run|uses)\s*:\s*(.*)$", stripped)
            if key and indent > item_indent:
                field, val = key.group(1), key.group(2).strip()
                if field == "run" and _BLOCK_SCALAR_RE.fullmatch(val):
                    cur["run"], i = _block_scalar(
                        lines, i + 1, indent, val.startswith(">")
                    )
                    continue
                if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
                    val = val[1:-1]
                cur[field] = val
            i += 1
        if cur is not None:
            block.append(cur)
        blocks.append([
            s for s in block
            if s.get("run") or s.get("uses") or s.get("with")
        ])
    return blocks


# Back-compat alias: the gate heredoc used this name before the parser
# moved into the lib. New code should use job_step_blocks.
_job_step_blocks = job_step_blocks
