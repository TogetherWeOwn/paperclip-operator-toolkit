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
    for line in Path(path).read_text(encoding="utf-8").splitlines():
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
        if not re.search(r"(?m)^services:\s*$", text):
            add("COMPOSE_SERVICES", p, "compose file declares no `services:`")
        for m in re.finditer(r"(?m)^\s*image:\s*(\S+)\s*$", text):
            img = m.group(1).strip("'\"")
            if ":latest" in img and "@sha256:" not in img:
                add("COMPOSE_PIN", p, f"image {img!r} uses :latest without a digest pin")

    # ---- env contract --------------------------------------------------
    example_keys = set()
    for name in (".env.example", ".env.sample"):
        p = root / name
        if not p.is_file():
            continue
        for key, val in _env_keys(p).items():
            example_keys.add(key)
            if not ENV_KEY.match(key):
                add("ENV_KEY_SHAPE", p, f"env key {key!r} is not SCREAMING_SNAKE")
            if SECRET_VALUE.search(val):
                add("ENV_SECRET_VALUE", p, f"env key {key!r} carries a token-shaped value")
    if example_keys:
        for key in sorted(wrangler_vars - example_keys):
            add("ENV_CONTRACT", root / "wrangler.json", f"wrangler var {key!r} is not declared in the env example")

    # ---- workflows -----------------------------------------------------
    job_contexts = set()
    wf_dir = root / ".github" / "workflows"
    wf_files = []
    if wf_dir.is_dir():
        wf_files = sorted(wf_dir.glob("*.yml")) + sorted(wf_dir.glob("*.yaml"))
    for p in wf_files:
        text = p.read_text(encoding="utf-8", errors="replace")
        # job ids (2-space indent) and their display names
        for m in re.finditer(r"(?m)^  ([A-Za-z0-9_-]+):\s*$", text):
            job_contexts.add(m.group(1))
        for m in re.finditer(r"(?m)^\s+name:\s*(\S.*?)\s*$", text):
            job_contexts.add(m.group(1).strip("'\""))
        jobs_section = text.split("jobs:", 1)[-1] if "jobs:" in text else ""
        job_blocks = re.split(r"(?m)^  [A-Za-z0-9_-]+:\s*$", jobs_section)
        headers = re.findall(r"(?m)^  ([A-Za-z0-9_-]+):\s*$", jobs_section)
        for hid, block in zip(headers, job_blocks[1:]):
            # Reusable-workflow caller jobs cannot carry timeout-minutes.
            if re.search(r"(?m)^\s+uses:\s*\S+", block):
                continue
            if "timeout-minutes:" not in block:
                add("WORKFLOW_TIMEOUT", p, f"job {hid!r} has no `timeout-minutes:`")
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
            if not isinstance(doc, dict) or not isinstance(doc.get("required", []), list):
                raise ValueError("required_checks must be an object with a required list")
            required = [r["context"] for r in doc.get("required", []) if isinstance(r, dict) and r.get("context")]
        except (ValueError, OSError) as exc:
            add("REQUIRED_CHECKS_PARSE", req_path, f"unparseable required_checks.json: {exc}")
            required = []
        for ctx in required:
            if ctx not in job_contexts:
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
