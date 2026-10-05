#!/usr/bin/env python3
"""paperclip-upgrade/check-plugin-inventory.py -- validate the board-approved
operator plugin inventory and diff it against live plugin state.

The inventory (`inventory.json` from the approved operator handoff) is the
non-secret source of truth for the rehearsal: all persisted plugin
identities, statuses, API versions, manifests, available package/worker
hashes, SDK dependency references, config fingerprints / safe-mode flags and
secret-binding COUNTS. It carries no credential, config value or binding ID.

What this script checks (offline unless --live-plugins/--live-tools given):
  1. Shape: every plugin has id/pluginKey/packageName/version/apiVersion/
     status/manifest; secretBindingCount is a non-negative int; no binding
     ID or secret-value field is present anywhere.
  2. Selector pin: togetherweown.model-selection path contains the current
     selector (default 175996fb7); the retired omniroute-broker is disabled.
     Actual statuses are PRESERVED and reported, never normalized.
  3. Bundled plugins (path null) are reported as bundled, NOT as absent:
     their proof must come from the target image catalog resolver / runtime
     (effective-build-check.sh image mode + rehearse boot), never from this
     file alone. This file is inventory only, NOT a compatibility PASS.
  4. With --live-plugins (a `GET /api/plugins` JSON dump) and --live-tools
     (a `GET /api/plugins/tools` JSON dump): every inventory plugin that was
     `ready` must still be present with the same version, and the tool count
     must not have shrunk. Any drift is FAIL (re-capture the inventory or
     reconcile by hand; never edit the handoff).
  5. With --baseline-out FILE: writes `key|status|version` lines plus the
     expected secret-binding counts, for the drain verify record and the
     compatibility matrix input.

Exit: 0 all gates pass | 1 a gate failed | 2 refused (bad input).
"""
import argparse
import json
import re
import sys

HEX64 = re.compile(r"[0-9a-f]{64}$")
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
REQUIRED_KEYS = ("id", "pluginKey", "packageName", "version", "apiVersion",
                 "status", "manifest")
# Non-manifest per-plugin fields the approved handoff may carry. Anything
# else at that level (a smuggled bindingIds list, a config-values dump) fails
# closed here; the operator re-captures and this checker is updated instead.
ALLOW_TOP = set(REQUIRED_KEYS) | {"path", "configSha256", "secretBindingCount",
                                  "safeModes", "fileHashes", "sdkDependency",
                                  "sdkPeer"}
# Secret MATERIAL patterns (populated values, never schema declarations:
# manifest schemas legitimately name secret-ref TYPED fields such as
# privateKeyRef/apiKeySecretRef, so names are not evidence -- values are).
TOKEN_RE = re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----|"
                      r"sk-[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{10,}|"
                      r"xox[bpas]-[A-Za-z0-9-]+")
POPULATED_SECRETID_RE = re.compile(r'"secretId"\s*:\s*"[0-9a-f-]{36}"')


def refuse(msg):
    print(f"REFUSED: check-plugin-inventory: {msg}", file=sys.stderr)
    sys.exit(2)


def load_json(path, what):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError) as exc:
        refuse(f"cannot read {what} {path}: {exc.__class__.__name__}")


def main(argv):
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--inventory", required=True)
    ap.add_argument("--live-plugins", default=None)
    ap.add_argument("--live-tools", default=None)
    ap.add_argument("--baseline-out", default=None)
    ap.add_argument("--expect-count", type=int, default=10)
    ap.add_argument("--expect-selector", default="175996fb7")
    args = ap.parse_args(argv)

    if args.expect_count < 1:
        refuse("--expect-count must be >= 1")

    inv = load_json(args.inventory, "inventory")
    plugins = inv.get("plugins") if isinstance(inv, dict) else None
    if not isinstance(plugins, list) or not plugins:
        print("FAIL: inventory has no non-empty plugins list")
        return 1

    rc = 0
    ok = lambda m: print(f"ok: {m}")  # noqa: E731

    if len(plugins) != args.expect_count:
        print(f"FAIL: plugin count {len(plugins)} != expected {args.expect_count}")
        rc = 1
    else:
        ok(f"plugin count {len(plugins)}")

    seen_keys = set()
    for p in plugins:
        if not isinstance(p, dict):
            print("FAIL: a plugin entry is not an object")
            rc = 1
            continue
        missing = [k for k in REQUIRED_KEYS if k not in p]
        if missing:
            print(f"FAIL: plugin {p.get('pluginKey', '?')} missing keys: {missing}")
            rc = 1
        key = p.get("pluginKey", "?")
        if key in seen_keys:
            print(f"FAIL: duplicate pluginKey {key}")
            rc = 1
        seen_keys.add(key)
        sbc = p.get("secretBindingCount")
        if not isinstance(sbc, int) or sbc < 0:
            print(f"FAIL: plugin {key} secretBindingCount is not a non-negative int")
            rc = 1
        for h in (p.get("fileHashes") or {}).values():
            if not (isinstance(h, str) and HEX64.match(h)):
                print(f"FAIL: plugin {key} has a malformed file hash")
                rc = 1
                break

    # No credential material may ride along in an inventory file: only
    # counts, fingerprints, hashes and schema declarations (which name
    # secret-ref TYPED config fields without populating them). Gate checks
    # VALUES, never field names.
    for p in plugins:
        if not isinstance(p, dict):
            continue
        extra = [k for k in p if k not in ALLOW_TOP]
        if extra:
            print(f"FAIL: plugin {p.get('pluginKey', '?')} carries "
                  f"unexpected top-level fields: {extra}")
            rc = 1
    raw = json.dumps(inv)
    if POPULATED_SECRETID_RE.search(raw):
        print("FAIL: inventory carries a populated secretId value "
              "(binding ID material, not a schema declaration)")
        rc = 1
    if TOKEN_RE.search(raw):
        print("FAIL: inventory carries token/PEM material")
        rc = 1
    uuids = set()

    def collect_uuids(node):
        if isinstance(node, str):
            if UUID_RE.match(node):
                uuids.add(node)
        elif isinstance(node, dict):
            for v in node.values():
                collect_uuids(v)
        elif isinstance(node, list):
            for v in node:
                collect_uuids(v)

    collect_uuids(inv)
    plugin_ids = {p["id"] for p in plugins if isinstance(p, dict) and "id" in p}
    stray = uuids - plugin_ids
    if stray:
        print(f"FAIL: inventory carries {len(stray)} non-identity UUID "
              f"value(s) (possible binding-ID material)")
        rc = 1
    if rc == 0:
        ok("no binding IDs or secret material present "
           f"(uuids are the {len(plugin_ids)} plugin identities only)")

    by_key = {p.get("pluginKey"): p for p in plugins if isinstance(p, dict)}

    ms = by_key.get("togetherweown.model-selection", {})
    if args.expect_selector not in str(ms.get("path", "")):
        print(f"FAIL: model-selection path lacks selector {args.expect_selector}: "
              f"{ms.get('path')}")
        rc = 1
    else:
        ok(f"model-selection carries selector {args.expect_selector}")

    omni = by_key.get("omniroute-broker", {})
    if omni.get("status") != "disabled":
        print(f"FAIL: retired omniroute-broker is not disabled: {omni.get('status')}")
        rc = 1
    else:
        ok("retired omniroute-broker is disabled")

    bundled = sorted(k for k, p in by_key.items() if p.get("path") is None)
    ready = sorted(k for k, p in by_key.items() if p.get("status") == "ready")
    disabled = sorted(k for k, p in by_key.items() if p.get("status") == "disabled")
    print(f"info: ready ({len(ready)}): {', '.join(ready)}")
    print(f"info: disabled ({len(disabled)}): {', '.join(disabled)}")
    if bundled:
        print(f"info: bundled path-null plugins (NOT absent; prove via target "
              f"image catalog/runtime): {', '.join(bundled)}")

    if args.baseline_out:
        try:
            with open(args.baseline_out, "w", encoding="utf-8") as fh:
                for k in sorted(by_key):
                    p = by_key[k]
                    fh.write(f"{k}|{p.get('status')}|{p.get('version', '')}\n")
                fh.write(f"bundled|{','.join(bundled) if bundled else 'none'}\n")
        except OSError as exc:
            refuse(f"cannot write --baseline-out: {exc.__class__.__name__}")
        ok(f"baseline written to {args.baseline_out}")

    if args.live_plugins:
        live = load_json(args.live_plugins, "live plugins")
        live_list = live if isinstance(live, list) else live.get("plugins", live)
        if not isinstance(live_list, list):
            print("FAIL: live plugins dump is not a list")
            return 1
        live_by_key = {p.get("pluginKey"): p for p in live_list
                       if isinstance(p, dict)}
        for k in ready:
            lp = live_by_key.get(k)
            if lp is None:
                print(f"FAIL: live drift: ready plugin {k} is now missing")
                rc = 1
            elif str(lp.get("version", "")) != str(by_key[k].get("version", "")):
                print(f"FAIL: live drift: {k} version {by_key[k].get('version')} "
                      f"-> {lp.get('version')}")
                rc = 1
        if rc == 0:
            ok(f"live plugins match inventory ({len(live_list)} entries)")
        if args.live_tools:
            tools = load_json(args.live_tools, "live tools")
            n = len(tools) if isinstance(tools, list) else -1
            if n < 0:
                print("FAIL: live tools dump is not a list")
                rc = 1
            else:
                print(f"info: live tool count {n} (compare with drain verify "
                      f"baseline; shrinkage is drift)")

    if rc == 0:
        print("PLUGIN_INVENTORY PROVEN")
    else:
        print("PLUGIN_INVENTORY UNPROVEN")
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
