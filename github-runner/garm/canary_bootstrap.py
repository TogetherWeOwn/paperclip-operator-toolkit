#!/usr/bin/env python3
"""Render source-only, pool-local provider 0.1.3 extra_specs. No network/apply."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import sys
import uuid

HERE = Path(__file__).resolve().parent
HOOK = "revoke-canary-sudo.sh"
TEMPLATE = "canary-no-sudo-install.tmpl"


def build_specs(pool_id):
    """Require the resolved canary UUID, never a prefix or an existing-pool ID."""
    parsed = uuid.UUID(pool_id)
    # Trunks of previously-issued pool IDs (synthetic here): a new canary pool
    # mints a fresh UUID, never re-mints a known one.
    if str(parsed) != pool_id or parsed.int == 0 or pool_id.startswith(("deadbeef-", "feedface-")):
        raise ValueError("canonical full NEW canary pool UUID required")
    # These are Go []byte fields, so JSON encodes them as base64, not raw text.
    hook = (HERE / HOOK).read_bytes()
    template = (HERE / TEMPLATE).read_bytes()
    if not hook or not template:
        raise ValueError("missing bootstrap source")
    return {
        "disable_updates": True,
        "extra_packages": [],
        "enable_boot_debug": False,
        "pre_install_scripts": {
            "00-revoke-canary-sudo.sh": base64.b64encode(hook).decode("ascii")
        },
        "runner_install_template": base64.b64encode(template).decode("ascii"),
        "extra_context": {"canary_pool_uuid": pool_id},
    }


def source_receipt(pool_id):
    specs = build_specs(pool_id)
    encoded = json.dumps(specs, sort_keys=True, separators=(",", ":")).encode()
    return {
        "schema": "garm-canary-bootstrap-source.v1",
        "canary_pool_uuid": pool_id,
        "runner_prefix": "garm-iso",
        "host": "canary-host",
        "garm_version": "0.2.1",
        "provider_version": "0.1.3",
        "lxd_version": "5.21.8",
        "extra_specs_sha256": hashlib.sha256(encoded).hexdigest(),
        "hook_sha256": hashlib.sha256((HERE / HOOK).read_bytes()).hexdigest(),
        "template_sha256": hashlib.sha256((HERE / TEMPLATE).read_bytes()).hexdigest(),
        "host_mutation_authorized": False,
        "admission_authorized": False,
        "host_verified": False,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--canary-pool-uuid", required=True)
    parser.add_argument("--receipt", action="store_true")
    args = parser.parse_args(argv)
    try:
        result = source_receipt(args.canary_pool_uuid) if args.receipt else build_specs(args.canary_pool_uuid)
    except (ValueError, OSError):
        print("HOLD: canonical canary UUID and complete reviewed source required", file=sys.stderr)
        return 2
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
