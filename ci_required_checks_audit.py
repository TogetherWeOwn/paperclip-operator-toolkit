#!/usr/bin/env python3
# ===========================================================================
# ci_required_checks_audit.py -- does every REQUIRED check have a job that can
# actually produce it, and can that job actually fail?
#
# THE BUG CLASS THIS EXISTS FOR. A branch ruleset names required checks by
# string. Nothing ties that string to a job. Four ways it goes wrong, all seen
# in this org:
#
#   * a job is renamed and the ruleset entry goes stale. The context never
#     arrives, so every PR waits forever, or the entry is deleted to "unblock"
#     and the gate is
#     gone;
#   * the producing workflow only runs on `push` to main, so the check is never
#     created on a PR head;
#   * the job carries `continue-on-error: true`, or a job-level `if:` that can
#     skip it. GitHub counts a skipped required job as SUCCESS;
#   * the ruleset entry has no `integration_id`, so ANY app or commit status
#     with the same name satisfies it.
#
# WHY IT FAILS CLOSED. This reads workflow YAML with a small line-oriented
# reader, not PyYAML (the self-hosted runners have no PyYAML and an offline
# gate must not depend on a pip install). A reader that cannot understand a file
# must not report "fine", so any file it cannot place is a FAIL, and a run that
# measured zero required checks exits 2, never 0. That is the rule from
# hub-false-green-checks: a counter of disagreements is zero whether you
# compared everything or nothing.
#
# MODES
#   offline (CI gate):  --manifest required_checks.json --workflows .github/workflows
#   live (steward):     --repo OWNER/NAME [--branch main]    (read-only `gh api`)
#   recorded rules:     --rules-json FILE --workflows DIR    (FILE = the output of
#                       `gh api repos/OWNER/NAME/rules/branches/BRANCH`)
#
# EXIT  0 no FAIL   1 at least one FAIL   2 nothing could be measured / bad input
# `--strict` also exits 1 on WARN.
# Read-only. It never writes to GitHub.
# ===========================================================================
from __future__ import annotations

import argparse
import fnmatch
import json
import os
import re
import subprocess
import sys
import tempfile

EXIT_OK, EXIT_FAIL, EXIT_UNMEASURED = 0, 1, 2

# Job-level `if:` values that cannot skip the job. `always()` runs even after a
# failed dependency; `!cancelled()` only skips a cancelled run, which is red or
# absent, never green.
SAFE_IF = {"always()", "${{ always() }}", "!cancelled()", "${{ !cancelled() }}"}

# Events whose check runs land on a PR head commit.
PR_EVENTS = ("pull_request", "pull_request_target")
# `types` values that make a pull_request run on an ordinary PR update.
UPDATE_TYPES = {"opened", "synchronize", "reopened"}
# A PR check is produced by these filters only on some PRs.
PATH_FILTERS = ("paths", "paths-ignore")


class ParseError(Exception):
    """A workflow file the reader cannot place. Always reported as a FAIL."""


class InputError(Exception):
    """Bad arguments, an unreadable file or a failed `gh` call: exit 2."""


# ---------------------------------------------------------------------------
# Workflow reader
# ---------------------------------------------------------------------------
_BLOCK_SCALAR = re.compile(r"^[|>][+-]?\d?\s*(#.*)?$")


def _strip_comment(value: str) -> str:
    v = value.strip()
    if not v or v[0] in "\"'":
        # A quoted scalar may legally contain " #"; keep it whole. The quote
        # closes before any trailing comment, which `_unquote` drops.
        return v
    m = re.search(r"\s#", v)
    return v[: m.start()].rstrip() if m else v


def _unquote(value: str) -> str:
    v = value.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        return v[1:-1]
    if v and v[0] in "\"'":
        close = v.rfind(v[0])
        if close > 0:
            return v[1:close]
    return v


def _logical_lines(text: str):
    """(indent, content) for every non-blank, non-comment line, with block
    scalar bodies folded back into the key line that owns them."""
    raw = text.replace("\t", "  ").splitlines()
    out = []
    i = 0
    while i < len(raw):
        line = raw[i]
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            i += 1
            continue
        indent = len(line) - len(line.lstrip(" "))
        content = stripped
        m = re.match(r"^(-\s+)?([^\s:#][^:]*?):\s*(.*)$", content)
        if m and _BLOCK_SCALAR.match(m.group(3).strip()):
            body = []
            j = i + 1
            while j < len(raw):
                nxt = raw[j]
                if nxt.strip() and (len(nxt) - len(nxt.lstrip(" "))) <= indent:
                    break
                body.append(nxt.strip())
                j += 1
            content = f"{m.group(1) or ''}{m.group(2)}: {' '.join(b for b in body if b)}"
            i = j
        else:
            i += 1
        out.append((indent, content))
    return out


def _split_flow(value: str):
    v = value.strip()
    if not (v.startswith("[") and v.endswith("]")):
        raise ParseError(f"not a flow sequence: {value!r}")
    inner = v[1:-1].strip()
    return [_unquote(p) for p in inner.split(",") if p.strip()] if inner else []


def _kv(content: str):
    m = re.match(r"^([^\s:#'\"][^:]*?|\"[^\"]*\"|'[^']*'):(?:\s+(.*)|)$", content)
    if not m:
        return None
    return _unquote(m.group(1)), (m.group(2) or "").strip()


def _children(lines, start, parent_indent):
    """Index range of the lines nested under lines[start], plus the child indent."""
    j = start + 1
    child_indent = None
    while j < len(lines) and lines[j][0] > parent_indent:
        if child_indent is None:
            child_indent = lines[j][0]
        j += 1
    return start + 1, j, child_indent


def _seq_or_flow(lines, i, indent, value):
    """Value of a key that is a scalar, a flow list or a block list."""
    if value:
        v = _strip_comment(value)
        return _split_flow(v) if v.startswith("[") else [_unquote(v)]
    lo, hi, cind = _children(lines, i, indent)
    items = []
    for k in range(lo, hi):
        ind, c = lines[k]
        if ind == cind and c.startswith("- "):
            items.append(_unquote(_strip_comment(c[2:])))
    return items


def _continue_on_error_steps(lines, start, indent):
    """Names of the steps under lines[start] that carry `continue-on-error: true`."""
    lo, hi, item_indent = _children(lines, start, indent)
    found, i = [], lo
    while i < hi:
        ind, c = lines[i]
        if ind == item_indent and c.startswith("- "):
            keys, j = {}, i
            first = _kv(c[2:])
            if first:
                keys[first[0]] = first[1]
            j = i + 1
            while j < hi and not (lines[j][0] == item_indent and lines[j][1].startswith("- ")):
                if lines[j][0] == item_indent + 2:
                    kv = _kv(lines[j][1])
                    if kv:
                        keys[kv[0]] = kv[1]
                j += 1
            coe = _unquote(_strip_comment(keys.get("continue-on-error", ""))).lower()
            if coe not in ("", "false"):
                label = keys.get("name") or keys.get("uses") or keys.get("run") or "(unnamed step)"
                found.append(_unquote(_strip_comment(label))[:80])
            i = j
        else:
            i += 1
    return found


class Job:
    def __init__(self, job_id):
        self.id = job_id
        self.name = None
        self.if_expr = None
        self.continue_on_error = False
        self.uses = None
        self.has_matrix = False
        self.has_steps = False
        self.coe_steps = []  # names of steps marked `continue-on-error: true`

    @property
    def context(self):
        return self.name if self.name is not None else self.id


class Workflow:
    def __init__(self, path):
        self.path = path
        self.events = {}  # event -> {"filters": set, "types": list|None, "branches": list|None}
        self.jobs = []

    def pr_visible(self, target_branch):
        """(visible, reason). Whether a run of this workflow reaches a PR head."""
        for ev in PR_EVENTS:
            if ev in self.events:
                br = self.events[ev]["branches"]
                if br is not None and not any(fnmatch.fnmatchcase(target_branch, p) for p in br):
                    return False, f"`{ev}` branches filter {br} excludes {target_branch}"
                return True, ev
        push = self.events.get("push")
        if push is not None and not push["filters"] & {"branches", "branches-ignore", "tags", "tags-ignore", "paths", "paths-ignore"}:
            return True, "push (unfiltered: runs on every branch push, PR heads included)"
        return False, "no pull_request trigger and push is filtered to main or absent"


def parse_workflow(text: str, path: str) -> Workflow:
    lines = _logical_lines(text)
    wf = Workflow(path)
    if not lines:
        raise ParseError("empty workflow")
    top = lines[0][0]
    if top != 0:
        raise ParseError("top-level keys are not at column 0")

    on_idx = jobs_idx = None
    for i, (ind, c) in enumerate(lines):
        if ind != 0:
            continue
        kv = _kv(c)
        if kv and kv[0] in ("on", "true"):
            on_idx = i
        elif kv and kv[0] == "jobs":
            jobs_idx = i
    if on_idx is None:
        raise ParseError("no top-level `on:`")
    if jobs_idx is None:
        raise ParseError("no top-level `jobs:`")

    # ---- on:
    _, value = _kv(lines[on_idx][1])
    value = _strip_comment(value)
    if value:
        if value.startswith("{"):
            raise ParseError("flow-mapping `on:` is not supported")
        names = _split_flow(value) if value.startswith("[") else [_unquote(value)]
        for n in names:
            wf.events[n] = {"filters": set(), "types": None, "branches": None}
    else:
        lo, hi, cind = _children(lines, on_idx, 0)
        if cind is None:
            raise ParseError("`on:` has no triggers")
        i = lo
        while i < hi:
            ind, c = lines[i]
            if ind != cind:
                i += 1
                continue
            kv = _kv(c)
            if not kv:
                raise ParseError(f"cannot read trigger line: {c!r}")
            ev, ev_val = kv
            info = {"filters": set(), "types": None, "branches": None}
            l2, h2, c2 = _children(lines, i, cind)
            if c2 is not None:
                k = l2
                while k < h2:
                    ind2, c2txt = lines[k]
                    if ind2 == c2:
                        kv2 = _kv(c2txt)
                        if kv2:
                            key, val = kv2
                            info["filters"].add(key)
                            if key in ("types", "branches"):
                                info[key] = _seq_or_flow(lines, k, ind2, val)
                    k += 1
            wf.events[ev] = info
            i = h2

    # ---- jobs:
    lo, hi, jind = _children(lines, jobs_idx, 0)
    if jind is None:
        raise ParseError("`jobs:` is empty")
    i = lo
    while i < hi:
        ind, c = lines[i]
        if ind != jind:
            i += 1
            continue
        kv = _kv(c)
        if not kv or kv[1]:
            raise ParseError(f"cannot read job header: {c!r}")
        job = Job(kv[0])
        l2, h2, kind = _children(lines, i, jind)
        if kind is None:
            raise ParseError(f"job {job.id!r} has no body")
        k = l2
        while k < h2:
            ind2, ctext = lines[k]
            if ind2 == kind:
                if ctext.startswith("- "):
                    raise ParseError(f"job {job.id!r}: indentless sequence is not supported")
                kv2 = _kv(ctext)
                if kv2:
                    key, val = kv2
                    if key == "name":
                        job.name = _unquote(_strip_comment(val))
                    elif key == "if":
                        job.if_expr = _unquote(_strip_comment(val)).strip()
                    elif key == "continue-on-error":
                        job.continue_on_error = _unquote(_strip_comment(val)).lower() not in ("false", "")
                    elif key == "uses":
                        job.uses = _unquote(_strip_comment(val))
                    elif key == "steps":
                        job.has_steps = True
                        job.coe_steps = _continue_on_error_steps(lines, k, ind2)
                    elif key == "strategy":
                        l3, h3, c3 = _children(lines, k, ind2)
                        for q in range(l3, h3):
                            kvq = _kv(lines[q][1])
                            if lines[q][0] == c3 and kvq and kvq[0] == "matrix":
                                job.has_matrix = True
            k += 1
        if not job.has_steps and not job.uses:
            raise ParseError(f"job {job.id!r} has neither steps nor `uses:`")
        wf.jobs.append(job)
        i = h2

    if not wf.jobs:
        raise ParseError("no jobs read")
    return wf


# ---------------------------------------------------------------------------
# Matching and judging
# ---------------------------------------------------------------------------
def _match(job: Job, context: str):
    """Match kind or None. exact | matrix | dynamic | reusable."""
    ctx = job.context
    if "${{" in ctx:
        pattern = "".join(".+" if p.startswith("${{") else re.escape(p) for p in re.split(r"(\$\{\{.*?\}\})", ctx))
        return "dynamic" if re.fullmatch(pattern, context) else None
    if ctx == context:
        return "exact"
    if job.has_matrix and job.name is None and context.startswith(f"{ctx} ("):
        return "matrix"
    if job.uses and context.startswith(f"{ctx} / "):
        return "reusable"
    return None


def audit(required, workflows, parse_errors, target_branch):
    """Returns the finding list: dicts with severity FAIL|WARN|INFO."""
    findings = []

    def add(sev, code, context, detail):
        findings.append({"severity": sev, "code": code, "context": context, "detail": detail})

    for path, err in sorted(parse_errors.items()):
        add("FAIL", "UNPARSEABLE", None, f"{path}: {err} (fail closed: a required check might hide in this file)")

    produced_by = {}
    for ctx in required:
        name = ctx["context"]
        hits = []
        for wf in workflows:
            for job in wf.jobs:
                kind = _match(job, name)
                if kind:
                    hits.append((wf, job, kind))
        produced_by[name] = hits

        if not hits:
            add("FAIL", "NO_PRODUCER", name, "no job in any workflow produces this check: the ruleset entry is stale or the job was renamed")
            continue

        visible = []
        for wf, job, kind in hits:
            ok, why = wf.pr_visible(target_branch)
            if ok:
                visible.append((wf, job, kind))
            else:
                add("WARN", "PRODUCER_NOT_ON_PR", name, f"{os.path.basename(wf.path)}:{job.id} {why}")
        if not visible:
            add("FAIL", "NO_PR_TRIGGER", name, "every producer is invisible to a pull request, so the check never arrives on a PR head")
            continue
        if len(visible) > 1:
            where = ", ".join(f"{os.path.basename(w.path)}:{j.id}" for w, j, _ in visible)
            add("WARN", "AMBIGUOUS", name, f"{len(visible)} jobs produce this check ({where}); matching is by name, so either can satisfy it")

        for wf, job, kind in visible:
            tag = f"{os.path.basename(wf.path)}:{job.id}"
            if kind != "exact":
                add("WARN", f"UNRESOLVED_{kind.upper()}", name, f"{tag} matched by {kind} name; the exact check name was not proven")
            if job.continue_on_error:
                add("FAIL", "JOB_ALWAYS_PASSES", name, f"{tag} has `continue-on-error: true`: the job reports success even when its steps fail")
            if job.coe_steps:
                add("WARN", "STEP_CONTINUE_ON_ERROR", name, f"{tag} step(s) {job.coe_steps} have `continue-on-error: true`; confirm a later step fails the job on the same signal")
            if job.if_expr is not None and job.if_expr not in SAFE_IF:
                add("WARN", "JOB_CAN_SKIP", name, f"{tag} has job-level `if: {job.if_expr}`: a skipped required job counts as success")
            ev = next((e for e in PR_EVENTS if e in wf.events), None)
            if ev:
                info = wf.events[ev]
                if info["filters"] & set(PATH_FILTERS):
                    add("WARN", "PATH_FILTERED", name, f"{tag} `{ev}` has a paths filter: the check is absent on PRs outside it")
                types = info["types"]
                if types is not None and not (set(types) & UPDATE_TYPES):
                    add("WARN", "OPT_IN_TRIGGER", name, f"{tag} `{ev}` types {types} never run on opened/synchronize: the check exists only when someone triggers it")

        if ctx.get("integration_id") in (None, "", 0):
            add("WARN", "ANY_SOURCE", name, "no integration_id pin: any GitHub App or commit status with this name satisfies the rule")

    # Real PR gates nobody requires.
    required_names = {c["context"] for c in required}
    for wf in workflows:
        ok, _ = wf.pr_visible(target_branch)
        if not ok:
            continue
        for job in wf.jobs:
            if job.context in required_names or any(_match(job, n) for n in required_names):
                continue
            if job.if_expr and job.if_expr.replace(" ", "").startswith(("failure()", "${{failure()")):
                continue
            add("INFO", "NOT_REQUIRED", job.context, f"{os.path.basename(wf.path)}:{job.id} runs on PRs but is not a required check")
    return findings


# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------
def load_workflows(directory):
    workflows, errors = [], {}
    try:
        names = sorted(f for f in os.listdir(directory) if f.endswith((".yml", ".yaml")))
    except OSError as exc:
        raise InputError(f"cannot read workflows directory {directory}: {exc}")
    for fname in names:
        path = os.path.join(directory, fname)
        try:
            with open(path, encoding="utf-8") as fh:
                workflows.append(parse_workflow(fh.read(), path))
        except ParseError as exc:
            errors[path] = str(exc)
    return workflows, errors


def required_from_rules(rules):
    """Flatten `gh api repos/R/rules/branches/B` into [{context, integration_id}]."""
    if not isinstance(rules, list):
        raise InputError("rules JSON is not a list (expected `gh api repos/OWNER/REPO/rules/branches/BRANCH`)")
    out, seen = [], set()
    for rule in rules:
        if rule.get("type") != "required_status_checks":
            continue
        for chk in (rule.get("parameters") or {}).get("required_status_checks") or []:
            key = (chk.get("context"), chk.get("integration_id"))
            if key not in seen:
                seen.add(key)
                out.append({"context": chk.get("context"), "integration_id": chk.get("integration_id")})
    return out


def _gh(gh_bin, *args):
    proc = subprocess.run([gh_bin, *args], capture_output=True, text=True, timeout=60)
    if proc.returncode != 0:
        raise InputError(f"`gh {' '.join(args[:2])}` failed (exit {proc.returncode}): {proc.stderr.strip()[:200]}")
    return proc.stdout


def fetch_live(repo, branch, gh_bin, workdir):
    if not branch:
        branch = _gh(gh_bin, "api", f"repos/{repo}", "--jq", ".default_branch").strip()
    rules = json.loads(_gh(gh_bin, "api", f"repos/{repo}/rules/branches/{branch}"))
    listing = json.loads(_gh(gh_bin, "api", f"repos/{repo}/contents/.github/workflows"))
    os.makedirs(workdir, exist_ok=True)
    for entry in listing:
        name = entry.get("name", "")
        if not name.endswith((".yml", ".yaml")):
            continue
        body = _gh(gh_bin, "api", "-H", "Accept: application/vnd.github.raw", f"repos/{repo}/contents/.github/workflows/{name}")
        with open(os.path.join(workdir, name), "w", encoding="utf-8") as fh:
            fh.write(body)
    return required_from_rules(rules), branch


def load_manifest(path):
    try:
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError) as exc:
        raise InputError(f"cannot read manifest {path}: {exc}")
    req = doc.get("required")
    if not isinstance(req, list) or any(not isinstance(r, dict) or not r.get("context") for r in req):
        raise InputError(f"manifest {path}: `required` must be a list of {{context, integration_id}}")
    return [{"context": r["context"], "integration_id": r.get("integration_id")} for r in req], doc.get("branch", "main")


def main(argv=None):
    ap = argparse.ArgumentParser(description="Audit required checks against the jobs that produce them (read-only).")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--manifest", help="pinned snapshot of the ruleset's required checks (offline CI gate)")
    src.add_argument("--rules-json", help="recorded `gh api repos/OWNER/REPO/rules/branches/BRANCH` output")
    src.add_argument("--repo", help="OWNER/NAME, read live with `gh api` (read-only)")
    ap.add_argument("--workflows", help="directory of workflow files (required with --manifest/--rules-json)")
    ap.add_argument("--branch", default=None, help="target branch (default: manifest branch, else the repo default)")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--strict", action="store_true", help="exit 1 on WARN as well as FAIL")
    ap.add_argument("--show-unrequired", action="store_true", help="also print INFO NOT_REQUIRED rows")
    ap.add_argument("--gh-bin", default=os.environ.get("AUDIT_GH_BIN", "gh"))
    args = ap.parse_args(argv)

    try:
        branch = args.branch or "main"
        if args.manifest:
            required, mbranch = load_manifest(args.manifest)
            branch = args.branch or mbranch
        elif args.rules_json:
            try:
                with open(args.rules_json, encoding="utf-8") as fh:
                    required = required_from_rules(json.load(fh))
            except (OSError, ValueError) as exc:
                raise InputError(f"cannot read rules JSON {args.rules_json}: {exc}")
        if args.repo:
            tmp = tempfile.mkdtemp(prefix="ci-required-audit-")
            required, branch = fetch_live(args.repo, args.branch, args.gh_bin, tmp)
            workdir = tmp
        else:
            if not args.workflows:
                raise InputError("--workflows DIR is required with --manifest / --rules-json")
            workdir = args.workflows
        workflows, errors = load_workflows(workdir)
    except InputError as exc:
        print(f"ci_required_checks_audit: {exc}", file=sys.stderr)
        return EXIT_UNMEASURED

    if not required:
        print("ci_required_checks_audit: no required checks were read, so nothing was measured", file=sys.stderr)
        return EXIT_UNMEASURED
    if not workflows and not errors:
        print("ci_required_checks_audit: no workflow files were read, so nothing was measured", file=sys.stderr)
        return EXIT_UNMEASURED

    findings = audit(required, workflows, errors, branch)
    counts = {s: sum(1 for f in findings if f["severity"] == s) for s in ("FAIL", "WARN", "INFO")}
    if args.json:
        print(json.dumps({"branch": branch, "required": required, "counts": counts, "findings": findings}, indent=2))
    else:
        print(f"required checks: {len(required)} on {branch}; workflows read: {len(workflows)}; unparseable: {len(errors)}")
        for f in findings:
            if f["severity"] == "INFO" and not args.show_unrequired:
                continue
            ctx = f'"{f["context"]}" ' if f["context"] else ""
            print(f'{f["severity"]:4s} {f["code"]:20s} {ctx}{f["detail"]}')
        print(f'result: {counts["FAIL"]} FAIL, {counts["WARN"]} WARN, {counts["INFO"]} INFO')
    if counts["FAIL"] or (args.strict and counts["WARN"]):
        return EXIT_FAIL
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
