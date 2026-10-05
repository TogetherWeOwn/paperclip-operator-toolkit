#!/usr/bin/env python3
"""GARM post-job cleanup + isolation probe, source-only offline form.

Part of the GARM-only owned CI fleet work. Implements the cleanup and
isolation-probe runbook spec as repository source ONLY:

- ``cleanup`` removes temp/container residue inside ONE explicit synthetic
  job directory and proves log retention.
- ``probe`` evaluates ONE synthetic job-context fixture and emits the
  spec's ``garm-cleanup-probe:`` verdict lines for checks A/B/C.

This file launches no VM, deletes no live VM, deregisters no runner, and
touches no host path. Every target directory must carry a
``.garm-job-fixture`` marker; without it the command refuses. Symlinks are
never followed and count as remaining residue (FAIL, not silent skip).
Timeouts never count as denials. Registration absence alone is never
reclamation. Standard library only; no network; fixture input bounded to
1 MiB. Never feed credentials or live configs to this tool.
"""

import argparse
import fnmatch
import json
import os
import sys

SCHEMA = "garm-cleanup-probe-context.v1"
MARKER = ".garm-job-fixture"
MAX_INPUT_BYTES = 1024 * 1024

# Basename patterns that count as removable post-job residue. Everything
# else (logs, receipts, manifests) is preserved per spec check A4.
RESIDUE_PATTERNS = (
    "tmp-*",
    "job-tmp-*",
    "container-*",
    "*.tmp",
    "*.residue",
    "*.sock-stub",
)

# Check B applies to isolated-private only; A and C apply to both roles.
B_REQUIRED = ("sudo_denied", "docker_unix_denied", "docker_tcp_denied",
              "sibling_data_denied")
C_REQUIRED = ("metadata_denied", "host_services_denied", "production_denied")
SMOKE_REQUIRED = ("cc", "postgres", "node", "runner")

def is_residue(basename):
    return any(fnmatch.fnmatchcase(basename, pat)
               for pat in RESIDUE_PATTERNS)


def check_marker(jobdir):
    """Refuse any directory that is not a marked synthetic fixture."""
    try:
        with open(os.path.join(jobdir, MARKER), "rb") as handle:
            if handle.read(64).strip() == b"synthetic-fixture":
                return True
    except OSError:
        pass
    return False


def cleanup_job(jobdir, job_id):
    """Remove residue under jobdir; preserve everything else. Returns rc."""
    removed, preserved, skipped = [], [], []
    for root, dirs, files in os.walk(jobdir, followlinks=False):
        # Never descend into symlinked dirs; record and leave them.
        for name in list(dirs):
            full = os.path.join(root, name)
            if os.path.islink(full):
                skipped.append(os.path.relpath(full, jobdir))
                dirs.remove(name)
        for name in files:
            full = os.path.join(root, name)
            rel = os.path.relpath(full, jobdir)
            if os.path.islink(full):
                skipped.append(rel)
                continue
            if name == MARKER:
                # The fixture marker proves synthetic scope; it is not a
                # retained log and must not satisfy check A4.
                continue
            if is_residue(name):
                try:
                    os.remove(full)
                except OSError:
                    skipped.append(rel)
                    continue
                removed.append(rel)
            else:
                preserved.append(rel)
    # Drop directories left empty by residue removal, bottom-up, root kept.
    for root, dirs, _files in os.walk(jobdir, topdown=False,
                                      followlinks=False):
        for name in dirs:
            full = os.path.join(root, name)
            if os.path.islink(full):
                continue
            try:
                os.rmdir(full)
                removed.append(os.path.relpath(full, jobdir) + "/")
            except OSError:
                pass
    if skipped:
        print("garm-cleanup-probe: FAIL step=cleanup job=%s reason=residue-remaining "
              "remaining=%d detail=%s" % (job_id, len(skipped),
                                          ",".join(sorted(skipped)[:5])))
        return 1
    if not preserved:
        # A job dir with nothing preserved means logs/receipts are missing
        # (spec A4) — an empty sweep is not cleanup evidence.
        print("garm-cleanup-probe: FAIL step=cleanup job=%s reason=logs-missing "
              "removed=%d" % (job_id, len(removed)))
        return 1
    print("garm-cleanup-probe: PASS step=cleanup job=%s removed=%d preserved=%d"
          % (job_id, len(removed), len(preserved)))
    return 0


def load_context(path):
    try:
        size = os.path.getsize(path)
    except OSError:
        return None, "unreadable-input"
    if size > MAX_INPUT_BYTES:
        return None, "input-too-large"
    try:
        with open(path, "r", encoding="utf-8") as handle:
            raw = handle.read(MAX_INPUT_BYTES + 1)
    except (OSError, ValueError):
        return None, "unreadable-input"
    if len(raw.encode("utf-8")) > MAX_INPUT_BYTES:
        return None, "input-too-large"
    try:
        doc = json.loads(raw)
    except ValueError:
        return None, "invalid-json"
    if not isinstance(doc, dict) or doc.get("schema") != SCHEMA:
        return None, "schema-mismatch"
    return doc, ""


def check_a(doc):
    """Spec check A: fresh VM, natural finish, deregistered, reclaimed, logs."""
    role, job = doc.get("role"), doc.get("job")
    vm = doc.get("vm") or {}
    reg = doc.get("registration") or {}
    logs = doc.get("logs") or {}
    if doc.get("finish") != "natural":
        print("garm-cleanup-probe: INCONCLUSIVE check=A role=%s job=%s "
              "reason=non-natural-finish" % (role, job))
        return "INCONCLUSIVE"
    created, dispatched = vm.get("created_at"), vm.get("dispatched_at")
    if not created or not dispatched or created < dispatched:
        print("garm-cleanup-probe: FAIL check=A role=%s job=%s "
              "reason=stale-vm-reused" % (role, job))
        return "FAIL"
    if not reg.get("deregistered"):
        print("garm-cleanup-probe: FAIL check=A role=%s job=%s "
              "reason=registration-still-present" % (role, job))
        return "FAIL"
    if not vm.get("reclaimed"):
        if not doc.get("reclamation_window_elapsed", False):
            print("garm-cleanup-probe: INCONCLUSIVE check=A role=%s job=%s "
                  "reason=reclamation-window-pending" % (role, job))
            return "INCONCLUSIVE"
        print("garm-cleanup-probe: FAIL check=A role=%s job=%s "
              "reason=vm-still-present" % (role, job))
        return "FAIL"
    if not logs.get("ref"):
        print("garm-cleanup-probe: FAIL check=A role=%s job=%s "
              "reason=logs-missing" % (role, job))
        return "FAIL"
    print("garm-cleanup-probe: PASS check=A role=%s job=%s vm=%s fresh=%s "
          "deregistered=%s reclaimed=%s logs=%s"
          % (role, job, vm.get("id"), created,
             reg.get("deregistered_at"), vm.get("reclaimed_at"),
             logs.get("ref")))
    return "PASS"


def check_denials(doc, check, required, allowed_reason):
    """Shared B/C logic: every denial needs denied + control, never timeout.

    allowed_reason is per-check per the spec (B: allowed, C: reachable);
    denied tokens render hyphenated per the spec PASS lines.
    """
    role, job = doc.get("role"), doc.get("job")
    by_name = {d.get("name"): d for d in doc.get("denials", [])
               if isinstance(d, dict)}
    denied_names = []
    for name in required:
        entry = by_name.get(name)
        if entry is None or not entry.get("denied"):
            print("garm-cleanup-probe: FAIL check=%s role=%s job=%s "
                  "reason=%s detail=%s" % (check, role, job, allowed_reason,
                                           name))
            return "FAIL"
        if entry.get("via_timeout"):
            # A timeout recorded as a denial fails the probe conduct.
            print("garm-cleanup-probe: FAIL check=%s role=%s job=%s "
                  "reason=timeout-counted-as-deny detail=%s"
                  % (check, role, job, name))
            return "FAIL"
        if not entry.get("control_ok"):
            print("garm-cleanup-probe: FAIL check=%s role=%s job=%s "
                  "reason=control-missing detail=%s" % (check, role, job, name))
            return "FAIL"
        denied_names.append(name.split("_denied")[0].replace("_", "-"))
    return denied_names


def check_b(doc):
    """Spec check B: no-Docker/no-sudo isolation (isolated-private only)."""
    role, job = doc.get("role"), doc.get("job")
    if role != "isolated-private":
        print("garm-cleanup-probe: SKIP check=B role=%s job=%s "
              "reason=not-applicable" % (role, job))
        return "SKIP"
    denied = check_denials(doc, "B", B_REQUIRED, "allowed")
    if denied == "FAIL":
        return "FAIL"
    smoke = doc.get("smoke") or {}
    if not all(smoke.get(tool) for tool in SMOKE_REQUIRED):
        print("garm-cleanup-probe: FAIL check=B role=%s job=%s "
              "reason=smoke-broken" % (role, job))
        return "FAIL"
    print("garm-cleanup-probe: PASS check=B role=%s job=%s "
          "denied=%s controls=ok" % (role, job, ",".join(denied)))
    return "PASS"


def check_c(doc):
    """Spec check C: metadata/host-service/production deny (both roles)."""
    role, job = doc.get("role"), doc.get("job")
    denied = check_denials(doc, "C", C_REQUIRED, "reachable")
    if denied == "FAIL":
        return "FAIL"
    print("garm-cleanup-probe: PASS check=C role=%s job=%s "
          "denied=%s controls=ok" % (role, job, ",".join(denied)))
    return "PASS"


def run_probe(doc):
    results = [check_a(doc), check_b(doc), check_c(doc)]
    decisive = [r for r in results if r != "SKIP"]
    if "FAIL" in decisive:
        return 1
    if "INCONCLUSIVE" in decisive:
        return 2
    return 0


def build_parser():
    parser = argparse.ArgumentParser(
        prog="post_job_cleanup",
        description="GARM post-job cleanup + isolation probe (source-only, "
                    "offline).")
    sub = parser.add_subparsers(dest="command", required=True)
    cleanup = sub.add_parser("cleanup", help="sweep residue in a fixture dir")
    cleanup.add_argument("jobdir", help="marked synthetic fixture directory")
    cleanup.add_argument("--job", required=True, help="job/run id for verdict")
    probe = sub.add_parser("probe", help="evaluate a context fixture")
    probe.add_argument("context", help="JSON fixture file (%s)" % SCHEMA)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.command == "cleanup":
        jobdir = args.jobdir
        if not os.path.isdir(jobdir) or not check_marker(jobdir):
            print("garm-cleanup-probe: REFUSED step=cleanup reason=unmarked-dir "
                  "(target must carry a .garm-job-fixture marker)",
                  file=sys.stderr)
            return 2
        return cleanup_job(os.path.realpath(jobdir), args.job)
    doc, error = load_context(args.context)
    if doc is None:
        print("garm-cleanup-probe: REFUSED check=load reason=%s" % error,
              file=sys.stderr)
        return 2
    if doc.get("role") not in ("isolated-private", "privileged-private"):
        print("garm-cleanup-probe: REFUSED check=load reason=unknown-role",
              file=sys.stderr)
        return 2
    return run_probe(doc)


if __name__ == "__main__":
    sys.exit(main())
