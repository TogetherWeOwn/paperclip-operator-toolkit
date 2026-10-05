#!/usr/bin/env python3
"""Count how Muse turns end, from Claude Code transcripts. Read-only; writes one JSONL file.

    python3 extract-turn-endings.py --since-minutes 1440 --out endings.jsonl [--projects ~/.claude/projects]

Each output row is one assistant turn that ended with text and no tool call:
    text      the final text (first 1800 chars; do not publish it)
    disp      a disposition write (status PATCH, resume, monitor) happened earlier in the same turn
    ntools    tool calls in the turn
    next      what followed: 'u' a new prompt (the run ended here), 'r' a tool result, 'EOF'

Only rows with next in {'u', 'EOF'} are turns that really ended. Feed the file to
eval-turn-endings.mjs. Run it once before the install and once 48 h after, over the same window
length, and compare the rates. Only transcripts whose model starts with `muse` are counted.
"""
import argparse
import json
import os
import re
import subprocess
import sys

DISP = re.compile(
    r'paperclip-issue-update|-X PATCH|"status"\s*:\s*"(done|in_review|blocked|in_progress)"'
    r'|resume.{0,6}true|monitor/check-now|nextCheckAt'
)


def transcripts(root, since_minutes):
    out = subprocess.run(
        ["find", root, "-maxdepth", "2", "-name", "*.jsonl", "-mmin", f"-{since_minutes}", "-size", "+2k"],
        capture_output=True, text=True, check=False,
    ).stdout.split()
    return out


def endings(path):
    recs = []
    with open(path, errors="replace") as handle:
        for line in handle:
            if not ('"assistant"' in line or '"user"' in line):
                continue
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if record.get("isSidechain"):
                continue
            kind = record.get("type")
            if kind == "assistant":
                message = record.get("message") or {}
                content = message.get("content") if isinstance(message.get("content"), list) else []
                recs.append(("a", message.get("model"), message.get("stop_reason"), content))
            elif kind == "user":
                content = (record.get("message") or {}).get("content")
                is_result = record.get("toolUseResult") is not None or (
                    isinstance(content, list)
                    and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content)
                )
                recs.append(("r" if is_result else "u", None, None, None))
    disp, ntools = False, 0
    for index, (kind, model, stop, content) in enumerate(recs):
        if kind == "u":
            disp, ntools = False, 0
            continue
        if kind != "a":
            continue
        for block in content:
            if block.get("type") == "tool_use":
                ntools += 1
                if DISP.search(json.dumps(block.get("input"))):
                    disp = True
        has_tool = any(b.get("type") == "tool_use" for b in content)
        if stop == "end_turn" and not has_tool and (model or "").startswith("muse"):
            text = "\n".join(b.get("text", "") for b in content if b.get("type") == "text")
            following = recs[index + 1][0] if index + 1 < len(recs) else "EOF"
            yield {"text": text[:1800], "disp": disp, "ntools": ntools, "next": following}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--projects", default=os.path.expanduser("~/.claude/projects"))
    parser.add_argument("--since-minutes", type=int, default=1440)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    files = transcripts(args.projects, args.since_minutes)
    rows = 0
    with open(args.out, "w") as out:
        for path in files:
            try:
                for row in endings(path):
                    out.write(json.dumps(row) + "\n")
                    rows += 1
            except OSError:
                continue
    print(f"{len(files)} transcripts, {rows} text-only turn endings -> {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
