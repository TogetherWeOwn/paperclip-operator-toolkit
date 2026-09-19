#!/usr/bin/env python3
"""Synthetic web_search passthrough probe for the direct CLIProxy lane.

The failure this detects is not a failed HTTP request. A lane can accept a
server-side web_search declaration, drop that declaration before dispatch, and
return an in-turn "Tool 'web_search' not found" error while the surrounding
agent run still succeeds.

Exit codes:
    0  PASS          every selected lane served web_search and returned results
    3  MANIFEST_DROP at least one lane dropped the advertised tool manifest
    4  OTHER_ERROR   auth, transport, quota, or another inconclusive failure

Single lane:
    websearch_lane_probe.py --base-url URL --model MODEL [--api-key-env VAR]

Scheduled run:
    websearch_lane_probe.py --scheduled

The scheduled set is deliberately fixed in code to the lanes the fleet actually
routes through. It posts a board-visible comment only for MANIFEST_DROP.
OTHER_ERROR remains non-zero and visible in the routine run, but does not page
as the manifest defect.

The OmniRoute lane (cliproxy/claude-sonnet-5 via router.example.net) was in
this set until 2026-09-16 and is now retired: the owner rule of 2026-09-13 sends
everything except Hindsight direct to CLIProxy, and the 07:36Z cutover
(TOG-2880) completed that move. A verdict on a route no traffic takes is not a
fleet health signal, so the row is removed rather than left to report red. Probe
it ad hoc with single-lane mode if that ever needs re-checking.
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

PROBE_PROMPT = (
    "Use the web_search tool to find what RFC 9110 is titled. "
    "Reply with only the title."
)

MANIFEST_DROP_MARKERS = (
    "not found in provided tools",
    "tool 'web_search' not found",
    "unknown tool: web_search",
)

EXIT_FOR = {"PASS": 0, "MANIFEST_DROP": 3, "OTHER_ERROR": 4}

# A turn that stopped for one of these reasons never got the chance to call the
# tool, so its silence is not manifest evidence.
INCONCLUSIVE_STOP_REASONS = ("max_tokens", "refusal", "pause_turn")

# Read only to warn. Scheduled targets are fixed in code; see scheduled_lanes().
# The OmniRoute name stays on this list after that lane's retirement precisely
# because it is dead: a deployment that still sets it must be told so, not left
# believing it configures a probe that no longer exists.
IGNORED_SCHEDULED_OVERRIDES = (
    "WEBSEARCH_CLIPROXY_KEY_ENV",
    "WEBSEARCH_OMNIROUTE_KEY_ENV",
)


@dataclass(frozen=True)
class Lane:
    label: str
    base_url: str
    model: str
    api_key_env: str
    # Paperclip run-secret to fall back to when api_key_env is unset. Only the
    # code-pinned scheduled lanes carry one: the fetched value is sent to
    # lane.base_url, so a lane whose host came from a caller must never be able
    # to pull a bound secret. See scheduled_lanes().
    secret_key: str | None = None


@dataclass(frozen=True)
class Result:
    lane: str
    verdict: str
    detail: str
    answer: str = ""


def classify(status: int, body_text: str, body_json: Any) -> tuple[str, str]:
    """Return (verdict, detail), where verdict is one of EXIT_FOR."""
    low = body_text.lower()
    if any(marker in low for marker in MANIFEST_DROP_MARKERS):
        return "MANIFEST_DROP", "lane rejected its own advertised web_search tool"

    if status != 200:
        return "OTHER_ERROR", f"HTTP {status}: {body_text[:300]}"

    # A 200 is only evidence about the tool manifest when it is a well-formed,
    # complete Messages envelope. Malformed, empty, or cut-short turns say
    # nothing about whether the lane dropped web_search, so they must stay
    # inconclusive rather than paging the board.
    if not isinstance(body_json, dict):
        return "OTHER_ERROR", f"HTTP 200 with an unparseable envelope: {body_text[:200]}"

    blocks = body_json.get("content")
    if not isinstance(blocks, list):
        return "OTHER_ERROR", f"HTTP 200 with non-list content: {type(blocks).__name__}"
    if not blocks:
        return "OTHER_ERROR", "HTTP 200 with an empty content array"

    kinds = [block.get("type") for block in blocks if isinstance(block, dict)]
    used = "server_tool_use" in kinds
    got_result = "web_search_tool_result" in kinds

    for block in blocks:
        if not isinstance(block, dict) or block.get("type") != "web_search_tool_result":
            continue
        content = block.get("content")
        if isinstance(content, dict) and content.get("type") == "web_search_tool_result_error":
            return "OTHER_ERROR", f"search errored: {content.get('error_code')}"

    if used and got_result:
        return "PASS", f"content blocks: {kinds}"
    if not used:
        stop_reason = body_json.get("stop_reason")
        if stop_reason in INCONCLUSIVE_STOP_REASONS:
            return (
                "OTHER_ERROR",
                f"turn ended as {stop_reason} before any tool call; blocks: {kinds}",
            )
        return "MANIFEST_DROP", f"model never invoked the tool; blocks: {kinds}"
    return "OTHER_ERROR", f"tool invoked but no result block; blocks: {kinds}"


def probe(base_url: str, model: str, api_key: str, timeout: int = 90) -> tuple[str, str, Any]:
    payload = {
        "model": model,
        "max_tokens": 256,
        "messages": [{"role": "user", "content": PROBE_PROMPT}],
        "tools": [{"type": "web_search_20250305", "name": "web_search", "max_uses": 1}],
        "tool_choice": {"type": "tool", "name": "web_search"},
    }
    request = urllib.request.Request(
        base_url.rstrip("/") + "/v1/messages",
        data=json.dumps(payload).encode(),
        headers={
            "content-type": "application/json",
            "x-api-key": api_key,
            "authorization": "Bearer " + api_key,
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode(errors="replace")
            status = response.status
    except urllib.error.HTTPError as error:
        body = error.read().decode(errors="replace")
        status = error.code
    except Exception as error:
        return "OTHER_ERROR", f"{type(error).__name__}: {error}", None

    try:
        parsed = json.loads(body)
    except Exception:
        parsed = None
    verdict, detail = classify(status, body, parsed)
    return verdict, detail, parsed


def answer_from(parsed: Any) -> str:
    if not isinstance(parsed, dict):
        return ""
    return " ".join(
        block.get("text", "")
        for block in (parsed.get("content") or [])
        if isinstance(block, dict) and block.get("type") == "text"
    ).strip()[:200]


def fetch_run_secret(secret_key: str, environ: Mapping[str, str]) -> str | None:
    required = ("PAPERCLIP_API_URL", "PAPERCLIP_API_KEY")
    if any(not environ.get(name) for name in required):
        return None
    url = f"{_paperclip_api_base(environ)}/api/agents/me/secrets/{secret_key}/value"
    request = urllib.request.Request(
        url,
        headers={"authorization": "Bearer " + environ["PAPERCLIP_API_KEY"]},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            payload = json.loads(response.read())
    except Exception:
        return None
    value = payload.get("value") if isinstance(payload, dict) else None
    return value if isinstance(value, str) and value else None


def resolve_api_key(lane: Lane, environ: Mapping[str, str]) -> str | None:
    """Environment first, then the lane's own bound run secret.

    No scheduled lane's credential variable is guaranteed to be exported into an
    agent run, so a lane that had only an environment source would resolve None
    and report OTHER_ERROR every cycle -- never measured, while the run still
    read as weather. That is exactly the false-green this probe exists to catch,
    inside the probe itself. Every code-pinned lane therefore names a bound run
    secret; see the pin in test_websearch_lane_probe.py.
    """
    key = environ.get(lane.api_key_env)
    if key:
        return key
    if lane.secret_key:
        return fetch_run_secret(lane.secret_key, environ)
    return None


def _unavailable_detail(lane: Lane) -> str:
    return f"credential {lane.api_key_env} is unavailable"


def run_lane(lane: Lane, environ: Mapping[str, str]) -> Result:
    key = resolve_api_key(lane, environ)
    if not key:
        return Result(
            lane=lane.label,
            verdict="OTHER_ERROR",
            detail=_unavailable_detail(lane),
        )
    verdict, detail, parsed = probe(lane.base_url, lane.model, key)
    return Result(lane=lane.label, verdict=verdict, detail=detail, answer=answer_from(parsed))


SCHEDULED_LANES = (
    Lane(
        label="direct cliproxy :: claude-sonnet-5",
        base_url="http://cliproxy:8317",
        model="claude-sonnet-5",
        api_key_env="CLIPROXY_API_KEY",
        secret_key="cliproxy_agent_api_key",
    ),
)

# Lanes removed from the schedule, and why. Keeping the row here rather than
# deleting it outright means a future reader can tell "deliberately retired"
# from "never covered" without a git archaeology trip.
RETIRED_SCHEDULED_LANES = {
    "OmniRoute :: cliproxy/claude-sonnet-5": (
        "owner rule 2026-09-13; all traffic except Hindsight goes direct to "
        "CLIProxy, completed by the 07:36Z cutover (TOG-2880). Removed "
        "2026-09-16 (TOG-2905)."
    ),
}


def scheduled_lanes() -> tuple[Lane, ...]:
    """The scheduled set is fixed in code, deliberately.

    probe() sends the selected credential in both the x-api-key and
    authorization headers, so whoever controls the base URL controls where that
    credential is sent. Taking either the host or the credential variable name
    from the environment would mean a stale deployment setting could quietly
    aim a production key at another host, or measure the wrong lane while still
    reporting green. CLIPROXY_BASE_URL and OMNIROUTE_BASE_URL are live names in
    this repo -- an operator or a routine that ran omniroute_combo_cli.sh may
    well have the latter set to that tool's 127.0.0.1:20128 default -- so
    honouring either here would risk silently probing localhost.

    To probe any other lane -- including the retired OmniRoute route, if it ever
    needs re-checking -- use single-lane mode (--base-url / --model /
    --api-key-env), where the target is explicit at the call site.
    """
    return SCHEDULED_LANES


def warn_ignored_overrides(environ: Mapping[str, str]) -> list[str]:
    """Name the dead credential-selector variables so a stale one is not silent."""
    return [name for name in IGNORED_SCHEDULED_OVERRIDES if environ.get(name)]


def aggregate_exit(results: Sequence[Result]) -> int:
    if any(result.verdict == "MANIFEST_DROP" for result in results):
        return 3
    if any(result.verdict != "PASS" for result in results):
        return 4
    return 0


def _paperclip_api_base(environ: Mapping[str, str]) -> str:
    base = environ["PAPERCLIP_API_URL"].rstrip("/")
    return base[:-4] if base.endswith("/api") else base


def post_board_alarm(results: Sequence[Result], environ: Mapping[str, str]) -> None:
    required = ("PAPERCLIP_API_URL", "PAPERCLIP_API_KEY", "PAPERCLIP_TASK_ID", "PAPERCLIP_RUN_ID")
    missing = [name for name in required if not environ.get(name)]
    if missing:
        raise RuntimeError("cannot post board alarm; missing " + ", ".join(missing))

    findings = [result for result in results if result.verdict == "MANIFEST_DROP"]
    lines = [
        "## web_search lane alarm",
        "",
        "**MANIFEST_DROP: a lane advertised `web_search` but did not serve it.**",
        "",
    ]
    for result in findings:
        lines.append(f"- `{result.lane}` — {result.detail}")
    lines.extend(
        [
            "",
            "The scheduled probe exited `3`. Transport, auth, and quota failures exit `4` and do not post this alarm.",
        ]
    )
    body = json.dumps({"body": "\n".join(lines)}).encode()
    url = f"{_paperclip_api_base(environ)}/api/issues/{environ['PAPERCLIP_TASK_ID']}/comments"
    request = urllib.request.Request(
        url,
        data=body,
        headers={
            "authorization": "Bearer " + environ["PAPERCLIP_API_KEY"],
            "content-type": "application/json",
            "x-paperclip-run-id": environ["PAPERCLIP_RUN_ID"],
        },
        method="POST",
    )
    timeout = int(environ.get("WEBSEARCH_BOARD_TIMEOUT", "60"))
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            if response.status < 200 or response.status >= 300:
                raise RuntimeError(f"board alarm returned HTTP {response.status}")
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"board alarm returned HTTP {error.code}") from error


def print_results(results: Sequence[Result], as_json: bool) -> None:
    for result in results:
        if as_json:
            print(json.dumps(result.__dict__))
            continue
        print(f"lane    : {result.lane}")
        print(f"verdict : {result.verdict}")
        print(f"detail  : {result.detail}")
        if result.answer:
            print(f"answer  : {result.answer}")
        print()


def main(argv: Sequence[str] | None = None, environ: Mapping[str, str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url")
    parser.add_argument("--model")
    parser.add_argument("--api-key-env", default="ANTHROPIC_API_KEY")
    parser.add_argument("--label")
    parser.add_argument("--scheduled", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    env = os.environ if environ is None else environ

    if args.scheduled:
        if args.base_url or args.model or args.label:
            parser.error("--scheduled cannot be combined with single-lane options")
        for name in warn_ignored_overrides(env):
            print(
                f"IGNORING {name}: scheduled lanes are fixed in code; "
                "use single-lane mode to probe anything else",
                file=sys.stderr,
            )
        results = [run_lane(lane, env) for lane in scheduled_lanes()]
        # A lane that cannot resolve a credential never reaches probe(), so it
        # measures nothing -- forever, and quietly, because exit 4 is shared
        # with transient quota and transport blips. It must not page as a
        # manifest drop, but it must not look like weather either.
        for lane, result in zip(scheduled_lanes(), results):
            if result.verdict == "OTHER_ERROR" and result.detail == _unavailable_detail(lane):
                print(
                    f"BLIND LANE {lane.label}: no {lane.api_key_env} and no "
                    f"{lane.secret_key or '(none)'} run secret. This lane is not "
                    "being measured at all; fix the credential before trusting "
                    "a green run.",
                    file=sys.stderr,
                )
        exit_code = aggregate_exit(results)
        print_results(results, args.json)
        if exit_code == 3:
            try:
                post_board_alarm(results, env)
            except Exception as error:
                print(f"BOARD_ALARM_FAILED: {error}", file=sys.stderr)
        return exit_code

    if not args.base_url or not args.model:
        parser.error("single-lane mode requires --base-url and --model")
    lane = Lane(
        label=args.label or f"{args.base_url} :: {args.model}",
        base_url=args.base_url,
        model=args.model,
        api_key_env=args.api_key_env,
    )
    result = run_lane(lane, env)
    print_results([result], args.json)
    return EXIT_FOR[result.verdict]


if __name__ == "__main__":
    sys.exit(main())
