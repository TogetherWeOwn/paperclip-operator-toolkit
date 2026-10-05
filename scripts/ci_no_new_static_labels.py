#!/usr/bin/env python3
"""Compare complete workflow selectors; grandfather only existing static usage.

Read-only: git objects and the Actions event payload, never runner/host APIs.
Exit 0 = measured clean, 1 = new retired label, 2 = comparison unavailable.
Requires Python 3 and PyYAML; CI installs a hash-pinned, per-job dependency.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys

DENIED = ("two-selfhosted", "two-isolated")  # static-fleet inventory
PATTERNS = {label: re.compile(r"(?<![A-Za-z0-9_.-])" + re.escape(label) + r"(?![A-Za-z0-9_.-])") for label in DENIED}
SHA = re.compile(r"[0-9a-fA-F]{40}")


def git(*args):
    return subprocess.run(["git", *args], check=True, capture_output=True).stdout


# Events whose trigger carries no commit range: the nightly full run and a manual
# dispatch re-run the whole suite, but there is nothing to compare against.
NO_CHANGE_SET_EVENTS = ("schedule", "workflow_dispatch")


def event_refs():
    name = os.environ["GITHUB_EVENT_NAME"]
    if name in NO_CHANGE_SET_EVENTS:
        return None
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    if name == "pull_request":
        base = event["pull_request"]["base"]["sha"]
        head = event["pull_request"]["head"]["sha"]
        merge_base = True
    elif name == "push":
        base, head = event["before"], event["after"]
        merge_base = False
    elif name == "merge_group":
        base = event["merge_group"]["base_sha"]
        head = event["merge_group"]["head_sha"]
        merge_base = False
    else:
        raise ValueError(f"unsupported event: {name}; pass explicit comparison refs")
    if any(not isinstance(ref, str) or not SHA.fullmatch(ref) or set(ref) == {"0"} for ref in (base, head)):
        raise ValueError("event must contain nonzero before/base and after/head commit SHAs")
    if base == head:
        raise ValueError("event comparison must not compare a commit with itself")
    return base, head, merge_base


def labels(value, active=None):
    # safe_load resolves aliases/merge keys without constructing Python objects.
    # Bound recursive YAML aliases explicitly rather than recursing forever.
    active = set() if active is None else active
    if isinstance(value, str):
        return {label for label, pattern in PATTERNS.items() if pattern.search(value)}
    if isinstance(value, (list, dict)):
        if id(value) in active:
            raise ValueError("recursive runner selector")
        active.add(id(value))
        found = set()
        for item in value.values() if isinstance(value, dict) else value:
            found.update(labels(item, active))
        active.remove(id(value))
        return found
    if value is not None:
        raise ValueError("runner selector must be a string, list or mapping")
    return set()


def selectors(ref, path):
    import yaml
    workflow = yaml.safe_load(git("show", f"{ref}:{path}").decode("utf-8"))
    if not isinstance(workflow, dict) or not isinstance(workflow.get("jobs"), dict):
        raise ValueError(f"workflow has no jobs mapping: {path}")
    result = {}
    for job, config in workflow["jobs"].items():
        if not isinstance(config, dict):
            raise ValueError(f"invalid job mapping: {path}")
        result[job] = labels(config.get("runs-on"))
    return result


def main(args):
    if args == ["--event"]:
        refs = event_refs()
        if refs is None:
            # Not a PASS claim: no static-label comparison was made.
            print("SKIP: event has no change set to compare")
            return 0
        base, head, use_merge_base = refs
    elif len(args) in (1, 2) and not args[0].startswith("-"):
        base, head = args[0], args[1] if len(args) == 2 else "HEAD"
        use_merge_base = True
    else:
        raise ValueError("usage: ci_no_new_static_labels.sh <base> [head] | --event")
    # Resolve only commit objects; refuse missing history/head rather than PASS.
    base = git("rev-parse", "--verify", "--end-of-options", base + "^{commit}").decode().strip()
    head = git("rev-parse", "--verify", "--end-of-options", head + "^{commit}").decode().strip()
    if use_merge_base:
        base = git("merge-base", base, head).decode().strip()
    # Capture and check git diff before reading its output. No process substitution
    # whose producer failure the parent shell could mistake for an empty diff.
    changed = git("diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--diff-filter=AM",
                  "--name-status", "-z", base, head, "--", ".github/workflows").split(b"\0")
    violations = []
    for index in range(0, len(changed) - 1, 2):
        status, path = changed[index].decode(), changed[index + 1].decode("utf-8")
        if not path.endswith((".yml", ".yaml")):
            continue
        before = {} if status == "A" else selectors(base, path)
        after = selectors(head, path)
        for job, denied in after.items():
            for label in sorted(denied - before.get(job, set())):
                violations.append((path, job, label))
    for path, job, label in violations:
        # Do not dump workflow bodies or event JSON into CI output.
        print(f"FAIL: new retired runner label {label} in {path}, job {job}")
    if violations:
        return 1
    print(f"PASS: no new static runner labels ({base}..{head})")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as exc:
        # No raw parser snippets, git stderr or event payloads in error logs.
        print(f"FAIL: static-label comparison unavailable ({type(exc).__name__}); verify refs, event, workflow YAML and PyYAML", file=sys.stderr)
        sys.exit(2)
