#!/usr/bin/env python3
"""Set or clear CI_HOMEPC_RUNNER from home-PC runner liveness.

An operator can leave two on-demand, ephemeral self-hosted runners
(`homepc-r1`, `homepc-r2`, label `two-homepc`) on a home PC. While at least
one is online and idle, the two long single-core mutation jobs
(`long-mutation-gates`, `model-selection-suite`) route there via the
`CI_HOMEPC_RUNNER` repo variable; when none is usable the variable is absent
and both jobs fall back to the overflow/isolated routing in ci.yml.

Modes:
  check  read-only: report observed runners, desired state and current
         variable. Exit 0 aligned, 1 drift, 2 usage/config, 3 unmeasured.
  apply  reconcile: create/update the variable when an idle home-PC runner
         exists, delete it when none does. Fail-closed: any observation
         failure refuses (exit 3) before any write.

The credential travels by inherited environment only (`GH_TOKEN`), never on
argv and never into logs. No host, no systemd, no Paperclip: pure stdlib +
the GitHub REST API, so the offline suite drives it through a stub transport.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

ORG_DEFAULT = "TogetherWeOwn"
REPO_DEFAULT = "TogetherWeOwn/paperclip-operator-toolkit"
LABEL_DEFAULT = "two-homepc"
VAR_DEFAULT = "CI_HOMEPC_RUNNER"
VALUE_DEFAULT = '["self-hosted","two-homepc"]'
JOBS_DEFAULT = '["long-mutation-gates","model-selection-suite"]'
API_DEFAULT = "https://api.github.com"
REQUEST_TIMEOUT = 20


class GuardError(RuntimeError):
    """A refused or unmeasurable step. The message is already log-safe."""


class GitHub:
    def __init__(self, token, api_url):
        self.token = token
        self.api_url = api_url.rstrip("/")

    def request(self, method, path, body=None):
        data = None
        headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": "Bearer " + self.token,
            "User-Agent": "paperclip-operator-toolkit/ci-homepc-guard",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(
            self.api_url + path, data=data, headers=headers, method=method
        )
        try:
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
                payload = resp.read()
                return resp.status, json.loads(payload) if payload else {}
        except urllib.error.HTTPError as exc:
            raise GuardError(f"github HTTP {exc.code} on {method} {path}") from exc
        except OSError as exc:
            raise GuardError(f"github request failed on {method} {path}: {type(exc).__name__}") from exc
        except ValueError as exc:
            raise GuardError(f"github response was not JSON on {method} {path}") from exc


def list_runners(gh, org):
    runners = []
    page = 1
    while True:
        status, payload = gh.request(
            "GET", f"/orgs/{org}/actions/runners?per_page=100&page={page}"
        )
        if status != 200 or not isinstance(payload, dict):
            raise GuardError(f"runner list returned HTTP {status}")
        batch = payload.get("runners")
        if not isinstance(batch, list):
            raise GuardError("runner list response lacks runners array")
        runners.extend(batch)
        if len(batch) < 100:
            break
        page += 1
    return runners


def select_homepc(runners, label):
    matching = [
        r for r in runners
        if label in [str(l.get("name", "")) for l in r.get("labels", [])]
    ]
    online = [r for r in matching if r.get("status") == "online"]
    idle = [r for r in online if not r.get("busy", False)]
    return matching, online, idle


def read_variable(gh, repo, name):
    try:
        status, payload = gh.request(
            "GET", f"/repos/{repo}/actions/variables/{urllib.parse.quote(name, safe='')}"
        )
    except GuardError as exc:
        if "HTTP 404" in str(exc):
            return None
        raise
    if status != 200 or not isinstance(payload, dict):
        raise GuardError(f"variable read returned HTTP {status}")
    return payload.get("value")


def write_variable(gh, repo, name, value, exists):
    path = f"/repos/{repo}/actions/variables/{urllib.parse.quote(name, safe='')}"
    if value is None:
        if not exists:
            return "already-clear"
        try:
            gh.request("DELETE", path)
        except GuardError as exc:
            if "HTTP 404" in str(exc):
                return "already-clear"
            raise
        return "cleared"
    if not exists:
        status, _ = gh.request("POST", f"/repos/{repo}/actions/variables",
                               {"name": name, "value": value})
        if status not in (200, 201):
            raise GuardError(f"variable create returned HTTP {status}")
        return "set"
    status, _ = gh.request("PATCH", path, {"name": name, "value": value})
    if status not in (200, 204):
        raise GuardError(f"variable update returned HTTP {status}")
    return "set"


def observe(gh, org, repo, label, var):
    runners = list_runners(gh, org)
    matching, online, idle = select_homepc(runners, label)
    current = read_variable(gh, repo, var)
    names = sorted(str(r.get("name", "?")) for r in idle)
    return {
        "matching": len(matching),
        "online": len(online),
        "idle": len(idle),
        "idle_names": names,
        "current": current,
    }


def parse_args(argv):
    ap = argparse.ArgumentParser(description="route long jobs to the home PC while it is online")
    ap.add_argument("--mode", choices=("check", "apply"), default="check")
    ap.add_argument("--org", default=os.environ.get("HOMEPC_GH_ORG", ORG_DEFAULT))
    ap.add_argument("--repo", default=os.environ.get("HOMEPC_GH_REPO", REPO_DEFAULT))
    ap.add_argument("--label", default=os.environ.get("HOMEPC_LABEL", LABEL_DEFAULT))
    ap.add_argument("--var", default=os.environ.get("HOMEPC_VAR", VAR_DEFAULT))
    ap.add_argument("--value", default=os.environ.get("HOMEPC_VALUE", VALUE_DEFAULT))
    ap.add_argument("--api-url", default=os.environ.get("HOMEPC_API_URL", API_DEFAULT))
    return ap.parse_args(argv)


def main(argv=None):
    args = parse_args(argv if argv is not None else sys.argv[1:])
    token = os.environ.get("GH_TOKEN", "")
    if not token:
        print("REFUSED: GH_TOKEN is unset; refusing to read or write", file=sys.stderr)
        return 2
    try:
        value = json.loads(args.value)
    except json.JSONDecodeError:
        print("REFUSED: --value is not JSON", file=sys.stderr)
        return 2
    if not isinstance(value, list) or not value:
        print("REFUSED: --value must be a non-empty JSON list", file=sys.stderr)
        return 2
    gh = GitHub(token, args.api_url)
    try:
        obs = observe(gh, args.org, args.repo, args.label, args.var)
    except GuardError as exc:
        print(f"REFUSED: {exc}", file=sys.stderr)
        return 3
    desired = args.value if obs["idle"] else None
    print(
        "homepc runners: matching={matching} online={online} idle={idle} "
        "idle_names={names} var={var} current={current!r} desired={desired!r}".format(
            matching=obs["matching"], online=obs["online"], idle=obs["idle"],
            names=",".join(obs["idle_names"]) or "-",
            var=args.var, current=obs["current"], desired=desired,
        )
    )
    if args.mode == "check":
        return 0 if obs["current"] == desired else 1
    try:
        if obs["current"] == desired:
            print(f"KEPT {args.var} unchanged")
            return 0
        outcome = write_variable(gh, args.repo, args.var, desired, obs["current"] is not None)
        print(f"{outcome.upper()} {args.var}")
        return 0
    except GuardError as exc:
        print(f"REFUSED: {exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
