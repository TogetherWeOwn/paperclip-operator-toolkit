#!/usr/bin/env python3
"""Plan, apply, and roll back CLIProxy quota-aware auth weights."""

import argparse
import datetime as dt
import json
import math
import os
import pathlib
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

from cliproxy_quota_contract import ContractError, canonicalize_document, parse_timestamp


MAX_WEIGHT = 1_000_000
PUSH_HOURS = 24.0


class ControllerError(RuntimeError):
    pass


class ManagementClient:
    def __init__(self, base_url, credential):
        self.base_url = base_url.rstrip("/")
        self.credential = credential

    def request(self, method, path, body=None):
        data = None
        headers = {"Authorization": f"Bearer {self.credential}"}
        if body is not None:
            data = json.dumps(body, separators=(",", ":")).encode()
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            self.base_url + path, data=data, headers=headers, method=method
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                payload = response.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read(300).decode("utf-8", "replace")
            raise ControllerError(f"management HTTP {exc.code}: {detail}") from exc
        except OSError as exc:
            raise ControllerError(f"management request failed: {exc}") from exc
        try:
            return json.loads(payload) if payload else {}
        except json.JSONDecodeError as exc:
            raise ControllerError("management response was not JSON") from exc

    def list_auth_files(self):
        payload = self.request("GET", "/v0/management/auth-files")
        files = payload.get("files") if isinstance(payload, dict) else None
        if not isinstance(files, list):
            raise ControllerError("management auth-files response lacks files array")
        return files

    def patch_fields(self, auth_key, priority, weight):
        result = self.request(
            "PATCH",
            "/v0/management/auth-files/fields",
            {"name": auth_key, "priority": priority, "weight": weight},
        )
        if result.get("status") != "ok":
            raise ControllerError("auth-files/fields did not confirm status=ok")

    def patch_disabled(self, auth_key, auth_index, disabled):
        body = {"name": auth_key, "disabled": disabled}
        if auth_index:
            body["auth_index"] = auth_index
        result = self.request("PATCH", "/v0/management/auth-files/status", body)
        if result.get("status") != "ok" or result.get("disabled") is not disabled:
            raise ControllerError("auth-files/status did not confirm disabled state")


def utc_now(value):
    if value:
        return parse_timestamp(value, "--now")
    return dt.datetime.now(dt.timezone.utc)


def binding_window(record, now):
    evaluated = []
    exhausted = False
    expired = []
    for window in record["windows"]:
        reset = parse_timestamp(window["resets_at"], "resets_at")
        seconds_to_reset = (reset - now).total_seconds()
        if seconds_to_reset <= 0:
            expired.append(window["name"])
            continue
        hours_to_reset = seconds_to_reset / 3600.0
        remaining = max(0.0, 1.0 - window["utilization"]) * window["allowance_weight"]
        if window["utilization"] >= 1.0:
            exhausted = True
        if window["role"] == "allowance":
            evaluated.append(
                {
                    "name": window["name"],
                    "reset": reset,
                    "resets_at": window["resets_at"],
                    "hours_to_reset": hours_to_reset,
                    "remaining_allowance": remaining,
                    "clear_rate": remaining / hours_to_reset,
                    "utilization": window["utilization"],
                    "allowance_weight": window["allowance_weight"],
                }
            )
    if not evaluated:
        raise ControllerError(f"{record['account_key']} has no current allowance window")
    evaluated.sort(key=lambda item: (item["clear_rate"], item["reset"], item["name"]))
    return evaluated[0], exhausted, expired


def plan(document, now):
    observed_at = parse_timestamp(document["observedAt"], "observedAt")
    direct_auth_rows = []
    logical_account_rows = []
    stale_reasons = []
    for record in document["records"]:
        age = (now - observed_at).total_seconds()
        if age < -60:
            stale_reasons.append(f"{record['account_key']}: observation is in the future")
        elif age > record["stale_after_seconds"]:
            stale_reasons.append(
                f"{record['account_key']}: age {int(age)}s exceeds {record['stale_after_seconds']}s"
            )
        expired_windows = [
            window["name"]
            for window in record["windows"]
            if parse_timestamp(window["resets_at"], "resets_at") <= now
        ]
        if expired_windows:
            stale_reasons.append(
                f"{record['account_key']}: expired windows {', '.join(sorted(expired_windows))}"
            )
        if record["control_scope"] == "logical_account":
            serviceable = (
                record["health"] == "healthy"
                and not expired_windows
                and all(window["utilization"] < 1.0 for window in record["windows"])
            )
            logical_account_rows.append(
                {
                    "account_key": record["account_key"],
                    "auth_key": record["auth_key"],
                    "accountKey": record["account_key"],
                    "authKey": record["auth_key"],
                    "provider": record["provider"],
                    "plan": record["plan"],
                    "health": record["health"],
                    "serviceable": serviceable,
                    "governing_window": record["governing_window"],
                    "governing_reset_at": record["governing_reset_at"],
                    "normalized_remaining": record["normalized_remaining"],
                    "target_burn_rate": record["target_burn_rate"],
                    "observed_burn_rate": record["observed_burn_rate"],
                    "deficit": record["deficit"],
                    "recommended_share": record["recommended_share"],
                    "governingWindow": record["governing_window"],
                    "governingResetAt": record["governing_reset_at"],
                    "normalizedRemaining": record["normalized_remaining"],
                    "targetBurnRate": record["target_burn_rate"],
                    "observedBurnRate": record["observed_burn_rate"],
                    "recommendedShare": record["recommended_share"],
                }
            )
            continue

        if expired_windows:
            direct_auth_rows.append(
                {
                    "account_key": record["account_key"],
                    "auth_key": record["auth_key"],
                    "provider": record["provider"],
                    "health": record["health"],
                    "binding_window": None,
                    "binding_reset": None,
                    "hours_to_reset": None,
                    "remaining_allowance": None,
                    "clear_rate": 0.0,
                    "recent_burn_units_per_hour": record["recent_burn_units_per_hour"],
                    "clearance_ratio": None,
                    "serviceable": False,
                    "state": "stale",
                    "priority": 0,
                    "weight": 0,
                    "disabled": True,
                }
            )
            continue
        binding, window_exhausted, _expired = binding_window(record, now)
        serviceable = (
            record["health"] == "healthy"
            and not window_exhausted
            and binding["remaining_allowance"] > 0
        )
        push = serviceable and binding["hours_to_reset"] <= PUSH_HOURS
        direct_auth_rows.append(
            {
                "account_key": record["account_key"],
                "auth_key": record["auth_key"],
                "provider": record["provider"],
                "health": record["health"],
                "binding_window": binding["name"],
                "binding_reset": binding["resets_at"],
                "hours_to_reset": binding["hours_to_reset"],
                "remaining_allowance": binding["remaining_allowance"],
                "clear_rate": binding["clear_rate"],
                "recent_burn_units_per_hour": record["recent_burn_units_per_hour"],
                "clearance_ratio": (
                    record["recent_burn_units_per_hour"]
                    * binding["hours_to_reset"]
                    / binding["remaining_allowance"]
                    if binding["remaining_allowance"] > 0
                    else None
                ),
                "serviceable": serviceable,
                "state": "exhausted" if not serviceable else ("push" if push else "normal"),
                "priority": 100 if push else 0,
                "weight": 0,
                "disabled": not serviceable,
            }
        )

    for priority in (0, 100):
        tier = [
            row
            for row in direct_auth_rows
            if row["serviceable"] and row["priority"] == priority
        ]
        if not tier:
            continue
        maximum = max(row["clear_rate"] for row in tier)
        for row in tier:
            if maximum <= 0:
                row["weight"] = 1
            else:
                row["weight"] = max(
                    1, min(MAX_WEIGHT, int(math.floor(row["clear_rate"] / maximum * MAX_WEIGHT + 0.5)))
                )

    return {
        "controller_version": 2,
        "observed_at": document["observedAt"],
        "planned_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "fresh": not stale_reasons,
        "mutation_allowed": not stale_reasons,
        "stale_reasons": stale_reasons,
        "decisions": sorted(direct_auth_rows, key=lambda row: row["account_key"]),
        "logical_accounts": sorted(logical_account_rows, key=lambda row: row["account_key"]),
        "logical_account_target_burn_rate": sum(
            row["target_burn_rate"] for row in logical_account_rows if row["serviceable"]
        ),
    }


def auth_index(files):
    indexed = {}
    for entry in files:
        if not isinstance(entry, dict):
            continue
        keys = {entry.get("id"), entry.get("name")}
        for key in keys:
            if isinstance(key, str) and key:
                if key in indexed:
                    raise ControllerError(f"ambiguous auth identifier: {key}")
                indexed[key] = entry
    return indexed


def snapshot_entry(entry):
    priority = entry.get("priority", 0)
    weight = entry.get("weight", 1)
    disabled = entry.get("disabled", False)
    if isinstance(priority, bool) or not isinstance(priority, (int, float, str)):
        raise ControllerError("existing priority is not numeric")
    if isinstance(weight, bool) or not isinstance(weight, (int, float, str)):
        raise ControllerError("existing weight is not numeric")
    try:
        priority = int(priority)
        weight = int(weight)
    except (TypeError, ValueError) as exc:
        raise ControllerError("existing priority or weight is not an integer") from exc
    if not isinstance(disabled, bool):
        raise ControllerError("existing disabled state is not boolean")
    return {
        "auth_key": entry.get("id") or entry.get("name"),
        "name": entry.get("name"),
        "auth_index": entry.get("auth_index"),
        "priority": priority,
        "weight": weight,
        "disabled": disabled,
    }


def secure_write_json(path, value, exclusive=False):
    destination = pathlib.Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if exclusive:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        fd = os.open(destination, flags, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        return
    fd, temporary = tempfile.mkstemp(prefix=f".{destination.name}.", dir=destination.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def append_decision(path, value):
    destination = pathlib.Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(destination, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")


def desired_diff(old, desired):
    return {
        "old": {
            "priority": old["priority"],
            "weight": old["weight"],
            "disabled": old["disabled"],
        },
        "new": {
            "priority": desired["priority"],
            "weight": desired["weight"],
            "disabled": desired["disabled"],
        },
    }


def load_management_credential():
    fd_text = os.environ.get("CLIPROXY_MANAGEMENT_KEY_FD")
    if not fd_text:
        raise ControllerError("management credential is required via CLIPROXY_MANAGEMENT_KEY_FD")
    try:
        fd = int(fd_text)
        credential = os.read(fd, 16384).decode().strip()
    except (ValueError, OSError, UnicodeDecodeError) as exc:
        raise ControllerError("cannot read CLIPROXY_MANAGEMENT_KEY_FD") from exc
    if not credential:
        raise ControllerError("CLIPROXY_MANAGEMENT_KEY_FD contained no credential")
    return credential


def read_rollback_state(path):
    try:
        with open(path, encoding="utf-8") as handle:
            state = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise ControllerError(f"cannot read rollback state {path}: {exc}") from exc
    records = state.get("records") if isinstance(state, dict) else None
    if not isinstance(records, list) or not records:
        raise ControllerError("rollback state has no records")
    return state


def verify_management_state(client, decisions):
    current = auth_index(client.list_auth_files())
    mismatches = []
    for desired in decisions:
        entry = current.get(desired["auth_key"])
        if entry is None:
            mismatches.append(f"{desired['auth_key']}: missing")
            continue
        actual = snapshot_entry(entry)
        for field in ("priority", "weight", "disabled"):
            if actual[field] != desired[field]:
                mismatches.append(
                    f"{desired['auth_key']}.{field}: got {actual[field]!r}, wanted {desired[field]!r}"
                )
    if mismatches:
        raise ControllerError("management read-back mismatch: " + "; ".join(mismatches))


def client_from_args(args):
    credential = load_management_credential()
    client = ManagementClient(args.management_url, credential)
    credential = ""
    return client


def run_dry(document, now, decision_log):
    planned = plan(document, now)
    event = {"mode": "dry-run", "result": "planned", **planned}
    if decision_log:
        append_decision(decision_log, event)
    print(json.dumps(planned, indent=2, sort_keys=True))
    return 0 if planned["fresh"] else 3


def run_apply(document, now, args):
    planned = plan(document, now)
    if not planned["mutation_allowed"]:
        append_decision(args.decision_log, {"mode": "apply", "result": "refused_stale", **planned})
        print(json.dumps(planned, indent=2, sort_keys=True))
        return 3
    if not planned["decisions"]:
        event = {"mode": "apply", "result": "no_direct_auth_mutations", **planned}
        append_decision(args.decision_log, event)
        print(json.dumps(event, indent=2, sort_keys=True))
        return 0

    client = client_from_args(args)
    current = auth_index(client.list_auth_files())
    originals = []
    mutations = []
    for desired in planned["decisions"]:
        entry = current.get(desired["auth_key"])
        if entry is None:
            raise ControllerError(f"auth_key not found in CLIProxy: {desired['auth_key']}")
        old = snapshot_entry(entry)
        originals.append(old)
        mutations.append({**desired_diff(old, desired), **desired})

    rollback_path = pathlib.Path(args.rollback_state)
    if rollback_path.exists():
        baseline = read_rollback_state(args.rollback_state)
        baseline_keys = sorted(record["auth_key"] for record in baseline["records"])
        current_keys = sorted(record["auth_key"] for record in originals)
        if baseline_keys != current_keys:
            raise ControllerError(
                "existing rollback state covers different auth keys; restore or archive it before changing scope"
            )
    else:
        secure_write_json(
            args.rollback_state,
            {"created_at": planned["planned_at"], "records": originals},
            exclusive=True,
        )

    try:
        for mutation, old in zip(mutations, originals):
            auth_key = mutation["auth_key"]
            client.patch_fields(auth_key, mutation["priority"], mutation["weight"])
            if old["disabled"] != mutation["disabled"]:
                client.patch_disabled(auth_key, old.get("auth_index"), mutation["disabled"])
        verify_management_state(client, planned["decisions"])
    except BaseException as original_error:
        restoration_errors = []
        for old in reversed(originals):
            try:
                client.patch_fields(old["auth_key"], old["priority"], old["weight"])
                client.patch_disabled(old["auth_key"], old.get("auth_index"), old["disabled"])
            except BaseException as restore_error:
                restoration_errors.append(f"{old['auth_key']}: {restore_error}")
        try:
            verify_management_state(client, originals)
        except BaseException as restore_verify_error:
            restoration_errors.append(str(restore_verify_error))
        if restoration_errors:
            raise ControllerError(
                f"apply failed ({original_error}); restoration failed: "
                + "; ".join(restoration_errors)
            ) from original_error
        raise

    event = {"mode": "apply", "result": "applied", **planned, "mutations": mutations}
    append_decision(args.decision_log, event)
    print(json.dumps(event, indent=2, sort_keys=True))
    return 0


def run_rollback(args):
    state = read_rollback_state(args.rollback_state)
    client = client_from_args(args)
    results = []
    for record in state["records"]:
        auth_key = record["auth_key"]
        client.patch_fields(auth_key, int(record["priority"]), int(record["weight"]))
        client.patch_disabled(auth_key, record.get("auth_index"), bool(record["disabled"]))
        results.append(
            {
                "auth_key": auth_key,
                "priority": int(record["priority"]),
                "weight": int(record["weight"]),
                "disabled": bool(record["disabled"]),
            }
        )
    verify_management_state(client, results)
    event = {
        "mode": "rollback",
        "result": "restored",
        "rolled_back_at": utc_now(args.now).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "records": results,
    }
    append_decision(args.decision_log, event)
    completed = args.rollback_state + ".rolled-back"
    if os.path.exists(completed):
        raise ControllerError(f"rollback archive already exists: {completed}")
    os.replace(args.rollback_state, completed)
    print(json.dumps(event, indent=2, sort_keys=True))
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("dry-run", "apply", "rollback"))
    parser.add_argument("--telemetry", help="collector contract JSON")
    parser.add_argument("--now", help="deterministic UTC time, YYYY-MM-DDTHH:MM:SSZ")
    parser.add_argument(
        "--management-url",
        default=os.environ.get("CLIPROXY_MANAGEMENT_URL", "http://127.0.0.1:8317"),
    )
    parser.add_argument(
        "--decision-log",
        default=os.environ.get(
            "CLIPROXY_QUOTA_DECISION_LOG",
            "/var/log/paperclip/cliproxy-quota-controller.jsonl",
        ),
    )
    parser.add_argument(
        "--rollback-state",
        default=os.environ.get(
            "CLIPROXY_QUOTA_ROLLBACK_STATE",
            "/var/lib/paperclip/cliproxy-quota-controller/rollback.json",
        ),
    )
    args = parser.parse_args()

    try:
        if args.mode == "rollback":
            return run_rollback(args)
        if not args.telemetry:
            raise ControllerError("--telemetry is required for dry-run and apply")
        with open(args.telemetry, encoding="utf-8") as handle:
            document = canonicalize_document(json.load(handle))
        now = utc_now(args.now)
        if args.mode == "dry-run":
            return run_dry(document, now, args.decision_log)
        return run_apply(document, now, args)
    except (OSError, json.JSONDecodeError, ContractError, ControllerError, ValueError) as exc:
        error = {"mode": args.mode, "result": "refused", "error": str(exc)}
        try:
            if args.decision_log:
                append_decision(args.decision_log, error)
        except OSError:
            pass
        print(f"REFUSED: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
