#!/usr/bin/env python3
"""Stdlib-only measurement/proposal core for runner_disk_pressure.sh.

No remote source, credential discovery, topology inference, or write operation.
See the shell entrypoint for the policy schema and exit contract. Tests use only
synthetic binaries and local fixtures; their green result is not host health.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys


class Refused(ValueError):
    """No complete, validated measurement is available."""


def keyset(value, keys, label):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise Refused(f"{label}: exact schema keys required")


def integer(value, low, high, label):
    if type(value) is not int or not low <= value <= high:
        raise Refused(f"{label}: integer out of range")
    return value


def local_path(value):
    if (not isinstance(value, str) or not value.startswith("/")
            or value.startswith("//") or os.path.normpath(value) != value
            or any(ord(c) < 32 or ord(c) == 127 for c in value)):
        raise Refused("paths must be explicit normalized absolute paths without controls")
    return value


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}", value):
        raise Refused("scope and target ids must be bounded identifiers")
    return value


def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise Refused("duplicate JSON key")
        result[key] = value
    return result


def read_local_json(filename):
    """Read one descriptor, refusing symlinks/devices/untrusted write modes.

    Ownership by the current uid or root is the local trust boundary, not a
    claim of operator/CISO approval. O_NOFOLLOW and fstat avoid a path-swap
    turning a validated file into a different input during this read.
    """
    local_path(filename)
    try:
        fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "r", encoding="utf-8") as stream:
            info = os.fstat(stream.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid not in (0, os.geteuid())
                    or info.st_mode & 0o022):
                raise Refused("input must be a trusted regular local file")
            raw = stream.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                raise Refused("local JSON input too large")
            return json.loads(raw, object_pairs_hook=unique_pairs,
                              parse_constant=lambda _: (_ for _ in ()).throw(Refused("non-finite JSON")))
    except Refused:
        raise
    except (OSError, ValueError, RecursionError) as exc:
        # ValueError includes malformed JSON/Unicode and integer decoder limits.
        raise Refused("local JSON input unavailable or malformed") from exc


def policy(filename):
    data = read_local_json(filename)
    keyset(data, ("schema_version", "scope", "targets", "runner_roots"), "policy")
    integer(data["schema_version"], 1, 1, "schema_version")
    identifier(data["scope"])
    targets = data["targets"]
    if not isinstance(targets, list) or not 1 <= len(targets) <= 64:
        raise Refused("policy needs 1-64 targets")
    ids, paths = set(), set()
    for target in targets:
        keyset(target, ("id", "path", "warn_pct", "crit_pct"), "target")
        tid, path = identifier(target["id"]), local_path(target["path"])
        if tid in ids or path in paths:
            raise Refused("duplicate target id/path")
        ids.add(tid)
        paths.add(path)
        warn = integer(target["warn_pct"], 1, 99, "warn_pct")
        crit = integer(target["crit_pct"], 1, 99, "crit_pct")
        if warn >= crit:
            raise Refused("warn_pct must be below crit_pct")
    roots = data["runner_roots"]
    if not isinstance(roots, list) or len(roots) > 64:
        raise Refused("runner_roots must be an explicit list of at most 64 paths")
    for root in roots:
        local_path(root)
    if len(roots) != len(set(roots)):
        raise Refused("duplicate runner root")
    return data


def existing_keys(filename):
    data = read_local_json(filename)
    keyset(data, ("schema_version", "existing_keys"), "dedupe")
    integer(data["schema_version"], 1, 1, "schema_version")
    keys = data["existing_keys"]
    if (not isinstance(keys, list) or len(keys) > 10000
            or any(not isinstance(k, str) or not re.fullmatch(r"[0-9a-f]{64}", k) for k in keys)
            or len(keys) != len(set(keys))):
        raise Refused("dedupe needs unique SHA-256 keys")
    return set(keys)


def binary(envname, default):
    name = os.environ.get(envname, default)
    local_path(name)
    try:
        if not stat.S_ISREG(os.stat(name).st_mode) or not os.access(name, os.X_OK):
            raise Refused("probe binary must be an executable regular file")
    except OSError as exc:
        raise Refused("probe binary unavailable") from exc
    return name


def probe(argv):
    try:
        # Inherited credentials, shell startup hooks, df block-size overrides,
        # and service endpoints never enter a probe child. No shell evaluation.
        run = subprocess.run(argv, capture_output=True, text=True, timeout=10,
                             env={"PATH": "/usr/bin:/bin", "LC_ALL": "C", "LANG": "C"})
    except (OSError, UnicodeError, subprocess.TimeoutExpired) as exc:
        raise Refused("probe unavailable or timed out") from exc
    if run.returncode != 0 or run.stderr.strip() or len(run.stdout) > 1024 * 1024:
        raise Refused("probe failed or returned ambiguous output")
    return run.stdout


def measurement(target, df_bin):
    rows = probe([df_bin, "-Pk", "--", target["path"]]).splitlines()
    if (len(rows) != 2 or not re.fullmatch(
            r"Filesystem\s+1024-blocks\s+Used\s+Available\s+(?:Capacity|Use%)\s+Mounted on", rows[0])):
        raise Refused("df must return a header and exactly one data row per target")
    match = re.fullmatch(r"(\S+)\s+(\d{1,20})\s+(\d{1,20})\s+(\d{1,20})\s+(\d{1,3})%\s+(.+)", rows[1])
    if not match:
        raise Refused("df fields malformed")
    total, used, avail, percent = map(int, match.group(2, 3, 4, 5))
    if (total <= 0 or max(total, used, avail) > 2**63 - 1 or used > total
            or avail > total or used + avail > total or not 0 <= percent <= 100):
        raise Refused("df numeric fields invalid")
    mount = local_path(match.group(6))
    status = "ok"
    if percent >= target["warn_pct"]:
        status = "pressure"
    if percent >= target["crit_pct"]:
        status = "critical"
    return {"id": target["id"], "path": target["path"], "mount": mount,
            "use_pct": percent, "avail_kb": avail, "warn_pct": target["warn_pct"],
            "crit_pct": target["crit_pct"], "status": status}


def breakdown(roots):
    consumers, notes = [], []
    if not roots:
        return consumers, notes
    try:
        du_bin = binary("DU_BIN", "/usr/bin/du")
    except Refused:
        return [], ["du unavailable; headline verdict stands on df alone"]
    for root in roots:
        try:
            if not Path(root).is_dir():
                notes.append(f"runner root '{root}' not present; headline verdict stands on df alone")
                continue
            children = sorted(str(p) for p in Path(root).iterdir() if not p.name.startswith("."))
            for child in children:
                local_path(child)
            if not children:
                notes.append(f"runner root '{root}' has no visible children; no breakdown")
                continue
            rows = probe([du_bin, "-kx", "-s", "--", *children]).splitlines()
            entries = []
            for row in rows:
                size, sep, path = row.partition("\t")
                if (not sep or not re.fullmatch(r"[0-9]{1,20}", size)
                        or int(size) > 2**63 - 1 or path not in children):
                    raise Refused("du fields malformed")
                entries.append({"kb": int(size), "path": path})
            if sorted(e["path"] for e in entries) != children:
                raise Refused("du coverage incomplete")
            consumers.extend(sorted(entries, key=lambda e: (-e["kb"], e["path"]))[:10])
        except (OSError, Refused):
            notes.append(f"du breakdown of '{root}' failed; headline verdict stands on df alone")
    return consumers, notes


def incident_key(scope, target):
    # Stable across severity changes, target ordering, and changing telemetry.
    # Never identify an incident by a telemetry-provided mount/label/host.
    identity = ["filesystem-pressure-v1", scope, target["id"], target["path"]]
    return hashlib.sha256(json.dumps(identity, separators=(",", ":")).encode()).hexdigest()


def evaluate(args):
    cfg = policy(args.config)
    keys = existing_keys(args.dedupe_file) if args.propose else set()
    df_bin = binary("DF_BIN", "/usr/bin/df")
    measured = []
    for target in cfg["targets"]:
        try:
            measured.append(measurement(target, df_bin))
        except Refused as exc:
            raise Refused(f"target '{target['id']}' unmeasured: {exc}") from exc
    status = max((m["status"] for m in measured), key={"ok": 0, "pressure": 1, "critical": 2}.get)
    proposals, suppressed = [], 0
    if args.propose:
        for item in measured:
            if item["status"] == "ok":
                continue
            key = incident_key(cfg["scope"], item)
            if key in keys:
                suppressed += 1
            else:
                proposals.append({"kind": "filesystem-pressure", "key": key,
                                  "target_id": item["id"], "path": item["path"],
                                  "severity": item["status"], "use_pct": item["use_pct"],
                                  "action": "inspect-and-plan", "read_only": True})
    consumers, notes = breakdown(cfg["runner_roots"])
    return {"schema_version": 1, "read_only": True, "mode": "propose" if args.propose else "measure",
            "scope": cfg["scope"], "status": status, "targets": measured,
            "top_consumers": consumers, "notes": notes, "proposals": proposals,
            "deduped": suppressed}, 0 if status == "ok" else 1


def main():
    parser = argparse.ArgumentParser(description="Read-only disk pressure; explicit trusted local policy required")
    parser.add_argument("--config", required=True, help="absolute local policy JSON file")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--propose", action="store_true", help="emit proposals to stdout only")
    parser.add_argument("--dedupe-file", help="absolute local existing-key snapshot; required for --propose")
    args = parser.parse_args()
    if args.propose != bool(args.dedupe_file):
        parser.error("--propose and --dedupe-file must be supplied together")
    try:
        report, rc = evaluate(args)
    except Refused as exc:
        report = {"schema_version": 1, "read_only": True, "status": "inconclusive",
                  "targets": [], "proposals": [], "notes": [str(exc)]}
        rc = 2
    if args.json:
        print(json.dumps(report, sort_keys=True))
    else:
        word = {"ok": "OK", "pressure": "WARNING", "critical": "CRITICAL", "inconclusive": "INCONCLUSIVE"}
        print(word[report["status"]] + ": read-only filesystem pressure")
        for item in report["targets"]:
            print(f"{word[item['status']]}: {item['path']} {item['use_pct']}% "
                  f"(mount {item['mount']}, avail {item['avail_kb']}K, "
                  f"warn {item['warn_pct']}%, critical {item['crit_pct']}%)")
        for item in report.get("top_consumers", []):
            print(f"  {item['kb']} KB {item['path']}")
        for note in report["notes"]:
            print("note: " + note)
        for item in report["proposals"]:
            print("proposal (stdout only): " + json.dumps(item, sort_keys=True))
        if report["status"] in ("pressure", "critical"):
            print("No cleanup performed. Follow your explicitly approved local procedure.")
    return rc


if __name__ == "__main__":
    sys.exit(main())
