#!/usr/bin/env python3
"""Shared deterministic config/deploy checks.

Defined ONCE here and consumed by every repo via the reusable workflow
`.github/workflows/config-deploy.yml` (org home: TogetherWeOwn/.github).
Per-repo consumers carry only the tiny caller workflow; the rules live here.

Checks (all stdlib, no network, no credentials):
  * wrangler.json/jsonc — parseable, non-empty `name`, valid
    `compatibility_date` (YYYY-MM-DD), `main` file exists when named.
  * docker-compose.yml/yaml, compose.yml/yaml — declares `services:`, no
    `:latest` image without a `@sha256:` digest.
  * env/secret name contract — `.env.example` keys are SCREAMING_SNAKE,
    carry no token-shaped value, and declare every `wrangler.vars` key.
  * workflow lint — `.github/workflows/*.yml` jobs carry `timeout-minutes`
    and every `uses:` is SHA-pinned (same rule as action_pins.py).
  * required-check stability — every context in `required_checks.json`
    has a producing job (`name:` or job id) in the workflows.

Exit: 0 clean, 1 findings in error mode, 2 nothing measured.
`--mode warn` prints findings but exits 0. A tree with zero measured
files exits 2, never 0 (hub-false-green rule).
"""
import argparse
import json
import re
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

SECRET_VALUE = re.compile(r"(ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY)")
ENV_KEY = re.compile(r"^[A-Z][A-Z0-9_]*$")
PINNED = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_./-]+)?@[0-9a-fA-F]{40}$")
USES = re.compile(r"(?:^|[{,\-])\s*[\"']?uses[\"']?\s*:\s*(?P<val>\S+)?")


@dataclass
class Finding:
    level: str  # "error" | "warning"
    code: str
    file: str
    message: str


@dataclass
class WorkflowJob:
    id: str
    name: str = None
    uses: bool = False
    has_matrix: bool = False
    has_timeout: bool = False
    is_reusable_workflow: bool = False

    @property
    def context(self):
        return self.name if self.name is not None else self.id


def _yaml_scalar(value):
    quote = None
    escaped = False
    for i, char in enumerate(value):
        if quote:
            if quote == '"' and char == "\\" and not escaped:
                escaped = True
                continue
            if char == quote and not escaped:
                quote = None
            escaped = False
        elif char in "'\"":
            quote = char
        elif char == "#" and (i == 0 or value[i - 1].isspace()):
            return value[:i].rstrip()
    return value.strip()


def _workflow_triggers(text):
    """Return whether workflow_call and any other triggers appear under `on:`."""
    block_match = re.search(r"(?m)^on:\s*(?:#.*)?$", text)
    if block_match:
        rest = text[block_match.end():]
        end = re.search(
            r"(?m)^(jobs|name|permissions|env|defaults|concurrency|run-name):\s*(?:#.*)?$",
            rest,
        )
        on_block = rest[: end.start()] if end else rest
        trigger_indents = [
            len(match.group(1))
            for match in re.finditer(r"(?m)^( +)[A-Za-z0-9_-]+:", on_block)
        ]
        if trigger_indents:
            indent = min(trigger_indents)
            triggers = re.findall(
                r"(?m)^ {" + str(indent) + r"}([A-Za-z0-9_-]+):",
                on_block,
            )
        else:
            triggers = []
        has_call = "workflow_call" in triggers
        return has_call, any(trigger != "workflow_call" for trigger in triggers)
    inline = re.search(r"(?m)^on:\s*(.+?)\s*(?:#.*)?$", text)
    if inline:
        parts = [
            part.rstrip(":")
            for part in re.split(r"[\s,\[\]{}]+", inline.group(1).strip())
            if part
        ]
        has_call = "workflow_call" in parts
        return has_call, any(part != "workflow_call" for part in parts)
    return False, False


def _workflow_jobs(text):
    has_call, has_other = _workflow_triggers(text)
    is_reusable_workflow = has_call and not has_other
    jobs_match = re.search(r"(?m)^jobs:\s*(?:#.*)?$", text)
    if not jobs_match:
        return []
    jobs_section = text[jobs_match.end():]
    candidates = list(
        re.finditer(r"(?m)^( +)([A-Za-z0-9_-]+):\s*(?:#.*)?$", jobs_section)
    )
    candidates = [c for c in candidates if len(c.group(1)) > 0]
    if not candidates:
        return []
    indent = min(len(c.group(1)) for c in candidates)
    if indent == 0:
        return []
    headers = [c for c in candidates if len(c.group(1)) == indent]
    jobs = []
    for i, header in enumerate(headers):
        end = headers[i + 1].start() if i + 1 < len(headers) else len(jobs_section)
        block = jobs_section[header.end():end]
        child_indents = [
            len(match.group(1))
            for match in re.finditer(r"(?m)^( +)[A-Za-z0-9_-]+:", block)
            if len(match.group(1)) > indent
        ]
        key = min(child_indents) if child_indents else indent + 2
        pad = lambda n: " {" + str(n) + "}"
        name_match = re.search(r"(?m)^" + pad(key) + r"name:\s*(.*?)\s*$", block)
        name = _yaml_scalar(name_match.group(1)).strip("'\\\"") if name_match else None
        uses = bool(re.search(r"(?m)^" + pad(key) + r"uses:\s*\S+", block))
        strategy = re.search(
            r"(?ms)^" + pad(key) + r"strategy:\s*\n(.*?)(?=^" + pad(key) + r"\S|\Z)",
            block,
        )
        matrix_indent = None
        if strategy:
            strategy_indents = [
                len(match.group(1))
                for match in re.finditer(r"(?m)^( +)[A-Za-z0-9_-]+:", strategy.group(1))
            ]
            if strategy_indents:
                matrix_indent = min(strategy_indents)
        has_matrix = bool(
            strategy and matrix_indent is not None
            and re.search(r"(?m)^ {" + str(matrix_indent) + r"}matrix:\s*", strategy.group(1))
        )
        has_timeout = bool(
            re.search(r"(?m)^" + pad(key) + r"timeout-minutes:\s*\S+", block)
        )
        jobs.append(
            WorkflowJob(
                header.group(2), name, uses, has_matrix, has_timeout,
                is_reusable_workflow,
            )
        )
    return jobs


def _job_context_matches(job, context):
    if job.is_reusable_workflow:
        return False
    base = job.context
    if "${{" in base:
        pattern = "".join(
            ".+" if part.startswith("${{") else re.escape(part)
            for part in re.split(r"(\$\{\{.*?\}\})", base)
        )
        if re.fullmatch(pattern, context):
            return True
    if base == context and not job.uses and not job.has_matrix:
        return True
    if job.has_matrix and context.startswith(f"{base} (") and context.endswith(")"):
        return len(context) > len(base) + 3
    return bool(job.uses and context.startswith(f"{base} / "))


def _strip_jsonc(text):
    out, in_str, i = [], False, 0
    while i < len(text):
        ch = text[i]
        if in_str:
            out.append(ch)
            if ch == "\\":
                if i + 1 < len(text):
                    out.append(text[i + 1]); i += 2; continue
            elif ch == '"':
                in_str = False
            i += 1; continue
        if ch == '"':
            in_str = True; out.append(ch); i += 1; continue
        if text.startswith("//", i):
            j = text.find("\n", i)
            if j == -1:
                break
            i = j; continue
        if text.startswith("/*", i):
            j = text.find("*/", i + 2)
            i = len(text) if j == -1 else j + 2; continue
        out.append(ch); i += 1
    return re.sub(r",(\s*[}\]])", r"\1", "".join(out))


def _load_wrangler(path):
    return json.loads(_strip_jsonc(Path(path).read_text(encoding="utf-8")))


def _env_keys(path):
    keys = {}
    for line in Path(path).read_text(encoding="utf-8", errors="replace").splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, _, v = s.partition("=")
        keys[k.strip()] = v.strip()
    return keys


def measured_files(root):
    root = Path(root)
    found = []
    for pat in ("wrangler.json", "wrangler.jsonc", "docker-compose.yml", "docker-compose.yaml",
                "compose.yml", "compose.yaml", ".env.example", ".env.sample", "required_checks.json"):
        p = root / pat
        if p.is_file():
            found.append(str(p))
    wf = root / ".github" / "workflows"
    if wf.is_dir():
        found.extend(str(p) for p in sorted(wf.glob("*.yml")) + sorted(wf.glob("*.yaml")))
    return found


def check_tree(root):
    root = Path(root)
    findings = []

    def add(code, file, message):
        findings.append(Finding("error", code, str(file), message))

    # ---- wrangler ------------------------------------------------------
    wrangler_vars = set()
    for name in ("wrangler.json", "wrangler.jsonc"):
        p = root / name
        if not p.is_file():
            continue
        try:
            doc = _load_wrangler(p)
        except (ValueError, OSError) as exc:
            add("WRANGLER_PARSE", p, f"unparseable wrangler file: {exc}")
            continue
        if not isinstance(doc, dict):
            add("WRANGLER_PARSE", p, "wrangler document is not a JSON object")
            continue
        if not str(doc.get("name") or "").strip():
            add("WRANGLER_NAME", p, "wrangler `name` is missing or empty")
        cd = str(doc.get("compatibility_date") or "")
        try:
            datetime.strptime(cd, "%Y-%m-%d")
        except ValueError:
            add("WRANGLER_COMPAT_DATE", p, f"`compatibility_date` {cd!r} is not YYYY-MM-DD")
        main = doc.get("main")
        if main and not (root / str(main)).exists():
            add("WRANGLER_MAIN", p, f"`main` file {main!r} does not exist")
        if isinstance(doc.get("vars"), dict):
            wrangler_vars.update(doc["vars"].keys())

    # ---- compose -------------------------------------------------------
    for name in ("docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"):
        p = root / name
        if not p.is_file():
            continue
        text = p.read_text(encoding="utf-8", errors="replace")
        if not re.search(r"(?m)^services:\s*(?:#.*)?$", text):
            add("COMPOSE_SERVICES", p, "compose file declares no `services:`")
        for m in re.finditer(r"(?m)^\s*image:\s*(\S+)\s*(?:#.*)?$", text):
            img = m.group(1).strip("'\"")
            if ":latest" in img and "@sha256:" not in img:
                add("COMPOSE_PIN", p, f"image {img!r} uses :latest without a digest pin")

    # ---- env contract --------------------------------------------------
    example_keys = set()
    for name in (".env.example", ".env.sample"):
        p = root / name
        if not p.is_file():
            continue
        try:
            env_keys = _env_keys(p)
        except OSError as exc:
            add("ENV_READ", p, f"could not read env example: {exc}")
            continue
        for key, val in env_keys.items():
            example_keys.add(key)
            if not ENV_KEY.match(key):
                add("ENV_KEY_SHAPE", p, f"env key {key!r} is not SCREAMING_SNAKE")
            if SECRET_VALUE.search(val):
                add("ENV_SECRET_VALUE", p, f"env key {key!r} carries a token-shaped value")
    if example_keys:
        for key in sorted(wrangler_vars - example_keys):
            add("ENV_CONTRACT", root / "wrangler.json", f"wrangler var {key!r} is not declared in the env example")

    # ---- workflows -----------------------------------------------------
    workflow_jobs = []
    wf_dir = root / ".github" / "workflows"
    wf_files = []
    if wf_dir.is_dir():
        wf_files = sorted(wf_dir.glob("*.yml")) + sorted(wf_dir.glob("*.yaml"))
    for p in wf_files:
        text = p.read_text(encoding="utf-8", errors="replace")
        jobs = _workflow_jobs(text)
        if not jobs and re.search(r"(?m)^jobs:\s*(?:#.*)?$", text):
            add("WORKFLOW_PARSE", p, "workflow has `jobs:` but no job headers were parsed")
        workflow_jobs.extend(jobs)
        for job in jobs:
            # Reusable-workflow caller jobs cannot carry timeout-minutes.
            if not job.uses and not job.has_timeout:
                add("WORKFLOW_TIMEOUT", p, f"job {job.id!r} has no `timeout-minutes:`")
        for i, line in enumerate(text.splitlines(), start=1):
            if line.lstrip().startswith("#"):
                continue
            m = USES.search(line)
            if not m:
                continue
            val = (m.group("val") or "").split("#", 1)[0].strip().strip(",}").strip("'\"")
            if not val:
                add("WORKFLOW_ACTION_PIN", p, f"line {i}: empty `uses:`")
            elif val.startswith("./") or val.startswith("docker://"):
                if val.startswith("docker://") and "@sha256:" not in val:
                    add("WORKFLOW_ACTION_PIN", p, f"line {i}: unpinned action `{val}`")
            elif not PINNED.match(val):
                add("WORKFLOW_ACTION_PIN", p, f"line {i}: unpinned action `{val}`")

    # ---- required checks ----------------------------------------------
    req_path = root / "required_checks.json"
    if req_path.is_file():
        try:
            doc = json.loads(req_path.read_text(encoding="utf-8"))
            if not isinstance(doc, dict) or not isinstance(doc.get("required"), list):
                raise ValueError("required_checks must be an object with a required list")
            required = []
            for item in doc["required"]:
                if (
                    not isinstance(item, dict)
                    or not isinstance(item.get("context"), str)
                    or not item["context"].strip()
                ):
                    raise ValueError("each required entry must have a non-empty string context")
                required.append(item["context"].strip())
        except (ValueError, OSError) as exc:
            add("REQUIRED_CHECKS_PARSE", req_path, f"unparseable required_checks.json: {exc}")
            required = []
        for ctx in required:
            if not any(_job_context_matches(job, ctx) for job in workflow_jobs):
                add("REQUIRED_CHECK_MISSING", req_path, f"required check {ctx!r} has no producing job")

    return findings


def main(argv=None):
    ap = argparse.ArgumentParser(description="Deterministic config/deploy checks (shared, org-level).")
    ap.add_argument("--root", default=".", help="repo root to check")
    ap.add_argument("--mode", choices=["warn", "error"], default="error")
    args = ap.parse_args(argv)
    files = measured_files(args.root)
    if not files:
        print("config_deploy_check: no wrangler/compose/env/workflow/required-check files measured — refusing to report clean", file=sys.stderr)
        return 2
    findings = check_tree(args.root)
    for f in findings:
        print(f"::{f.level} file={f.file}::{f.code}: {f.message}")
    print(f"config-deploy: {len(files)} file(s) measured, {len(findings)} finding(s), mode={args.mode}")
    if findings and args.mode == "error":
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
