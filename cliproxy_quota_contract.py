#!/usr/bin/env python3
"""Validate and canonically emit the CLIProxy per-account quota contract."""

import argparse
import datetime as dt
import json
import math
import os
import pathlib
import tempfile


HEALTH_VALUES = {"healthy", "exhausted", "unavailable"}
WINDOW_ROLES = {"allowance", "serviceability"}
CONTROL_SCOPES = {"direct_auth", "logical_account"}
DIRECT_AUTH_PROVIDERS = {"claude", "codex", "zai"}
LOGICAL_ACCOUNT_PROVIDERS = {"opencode-go"}
GO_WINDOW_SPECS = {
    "five-hour": (18000, 0.2),
    "weekly": (604800, 0.5),
    "monthly": (None, 1.0),
}
FLOAT_ABS_TOLERANCE = 1e-6
TARGET_RATE_REL_TOLERANCE = 0.02


class ContractError(ValueError):
    pass


def parse_timestamp(value, field):
    if not isinstance(value, str) or not value.endswith("Z"):
        raise ContractError(f"{field} must be an RFC3339 UTC timestamp ending in Z")
    try:
        parsed = dt.datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as exc:
        raise ContractError(f"{field} is not a valid timestamp") from exc
    if parsed.tzinfo is None:
        raise ContractError(f"{field} must include a timezone")
    return parsed.astimezone(dt.timezone.utc)


def finite_number(value, field, minimum=None, strictly_positive=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ContractError(f"{field} must be a number")
    value = float(value)
    if not math.isfinite(value):
        raise ContractError(f"{field} must be finite")
    if strictly_positive and value <= 0:
        raise ContractError(f"{field} must be greater than zero")
    if minimum is not None and value < minimum:
        raise ContractError(f"{field} must be at least {minimum}")
    return value


def nonempty_string(value, field):
    if not isinstance(value, str) or not value:
        raise ContractError(f"{field} must be a non-empty string")
    if value != value.strip():
        raise ContractError(f"{field} must not contain surrounding whitespace")
    return value


def close_enough(actual, expected, *, relative=0.0):
    return math.isclose(
        actual,
        expected,
        rel_tol=relative,
        abs_tol=FLOAT_ABS_TOLERANCE,
    )


def governor_input(record, prefix):
    flat_fields = {
        "governingWindow": "governing_window",
        "governingResetAt": "governing_reset_at",
        "normalizedRemaining": "normalized_remaining",
        "targetBurnRate": "target_burn_rate",
        "observedBurnRate": "observed_burn_rate",
        "deficit": "deficit",
        "recommendedShare": "recommended_share",
    }
    nested = record.get("governor")
    if nested is not None and not isinstance(nested, dict):
        raise ContractError(f"{prefix}.governor must be an object")
    nested = nested or {}
    result = {}
    for nested_name, flat_name in flat_fields.items():
        flat_present = flat_name in record
        nested_present = nested_name in nested
        if flat_present and nested_present and record[flat_name] != nested[nested_name]:
            raise ContractError(
                f"{prefix}.{flat_name} conflicts with {prefix}.governor.{nested_name}"
            )
        if flat_present:
            result[flat_name] = record[flat_name]
        elif nested_present:
            result[flat_name] = nested[nested_name]
        else:
            result[flat_name] = None
    return result


def bounded_integer(value, field, *, minimum, strictly_positive=False):
    if isinstance(value, bool) or not isinstance(value, int):
        raise ContractError(f"{field} must be an integer")
    if strictly_positive and value <= 0:
        raise ContractError(f"{field} must be greater than zero")
    if value < minimum:
        raise ContractError(f"{field} must be at least {minimum}")
    return value


def capacity_shape(record, prefix):
    """Optional per-credential capacity SHAPE, alongside quota percentage.

    A credential can be at 5% of its weekly allowance and still have no room
    right now because every one of its concurrent slots is busy. Quota
    utilization cannot express that, so concurrency and in-flight are carried
    separately (TOG-3131). Both are read-if-present by the consumer: absent
    leaves today's behaviour unchanged.

    Key names are the consumer's, not ours. `pace.ts` reads the first present
    of several aliases per row; we emit the snake_case head of each alias list
    (`credential_concurrency`, `credential_in_flight`) so the match never
    depends on alias ordering. camelCase input is accepted and normalized.
    """
    aliases = {
        "credential_concurrency": "credentialConcurrency",
        "credential_in_flight": "credentialInFlight",
    }
    result = {}
    for flat_name, camel_name in aliases.items():
        flat_present = flat_name in record
        camel_present = camel_name in record
        if flat_present and camel_present and record[flat_name] != record[camel_name]:
            raise ContractError(f"{prefix}.{flat_name} conflicts with {prefix}.{camel_name}")
        value = record[flat_name] if flat_present else record.get(camel_name)
        if not flat_present and not camel_present:
            continue
        if value is None:
            continue
        result[flat_name] = value
    if "credential_concurrency" in result:
        # The consumer treats 0 or negative as a broken value and ignores it.
        # Refuse here so the producer fails loudly instead of silently
        # publishing a field that is discarded downstream.
        result["credential_concurrency"] = bounded_integer(
            result["credential_concurrency"],
            f"{prefix}.credential_concurrency",
            minimum=1,
            strictly_positive=True,
        )
    if "credential_in_flight" in result:
        # Zero is meaningful here — an idle credential — not missing. It is
        # allowed to exceed concurrency: a reading taken mid-burst legitimately
        # observes more in flight than the ceiling the pool intends to hold.
        result["credential_in_flight"] = bounded_integer(
            result["credential_in_flight"],
            f"{prefix}.credential_in_flight",
            minimum=0,
        )
    return result


def canonicalize_document(document):
    if not isinstance(document, dict):
        raise ContractError("document must be an object")
    observed_at = nonempty_string(document.get("observedAt"), "observedAt")
    observed_time = parse_timestamp(observed_at, "observedAt")
    records = document.get("records")
    if not isinstance(records, list) or not records:
        raise ContractError("records must be a non-empty array")

    account_keys = set()
    auth_keys = set()
    canonical_records = []
    for index, record in enumerate(records):
        prefix = f"records[{index}]"
        if not isinstance(record, dict):
            raise ContractError(f"{prefix} must be an object")
        account_key = nonempty_string(record.get("account_key"), f"{prefix}.account_key")
        auth_key = nonempty_string(record.get("auth_key"), f"{prefix}.auth_key")
        if account_key in account_keys:
            raise ContractError(f"duplicate account_key: {account_key}")
        if auth_key in auth_keys:
            raise ContractError(f"duplicate auth_key: {auth_key}")
        account_keys.add(account_key)
        auth_keys.add(auth_key)

        provider = nonempty_string(record.get("provider"), f"{prefix}.provider")
        if provider in DIRECT_AUTH_PROVIDERS:
            expected_control_scope = "direct_auth"
        elif provider in LOGICAL_ACCOUNT_PROVIDERS:
            expected_control_scope = "logical_account"
        else:
            raise ContractError(f"{prefix}.provider {provider!r} is outside controller policy")
        reported_control_scope = record.get("control_scope")
        if reported_control_scope is not None:
            control_scope = nonempty_string(
                reported_control_scope, f"{prefix}.control_scope"
            )
            if control_scope not in CONTROL_SCOPES:
                raise ContractError(
                    f"{prefix}.control_scope must be one of {', '.join(sorted(CONTROL_SCOPES))}"
                )
            if control_scope != expected_control_scope:
                raise ContractError(
                    f"{prefix}.provider {provider!r} requires control_scope {expected_control_scope!r}"
                )
        else:
            control_scope = expected_control_scope
        plan = nonempty_string(record.get("plan"), f"{prefix}.plan")
        plan_weight = finite_number(
            record.get("plan_weight"), f"{prefix}.plan_weight", strictly_positive=True
        )
        health = nonempty_string(record.get("health"), f"{prefix}.health")
        if health not in HEALTH_VALUES:
            raise ContractError(
                f"{prefix}.health must be one of {', '.join(sorted(HEALTH_VALUES))}"
            )
        # A lane can refuse work while every quota window still looks healthy:
        # the cooldown lives in the serving plugin, not in the allowance. Quota
        # headroom therefore cannot stand in for serviceability, so an active
        # cooldown is carried explicitly and must agree with health.
        cooldown = record.get("cooldown")
        canonical_cooldown = None
        active_cooldown_until = None
        if cooldown is not None:
            if not isinstance(cooldown, dict):
                raise ContractError(f"{prefix}.cooldown must be an object")
            until = nonempty_string(cooldown.get("until"), f"{prefix}.cooldown.until")
            until_time = parse_timestamp(until, f"{prefix}.cooldown.until")
            canonical_cooldown = {
                "until": until,
                "reason": nonempty_string(
                    cooldown.get("reason"), f"{prefix}.cooldown.reason"
                ),
            }
            if until_time > observed_time:
                if health != "exhausted":
                    raise ContractError(
                        f"{prefix}.cooldown is active until {until} so {prefix}.health "
                        f"must be 'exhausted', not {health!r}"
                    )
                active_cooldown_until = until
        recent_burn = finite_number(
            record.get("recent_burn_units_per_hour"),
            f"{prefix}.recent_burn_units_per_hour",
            minimum=0,
        )
        stale_after = record.get("stale_after_seconds")
        if isinstance(stale_after, bool) or not isinstance(stale_after, int) or stale_after <= 0:
            raise ContractError(f"{prefix}.stale_after_seconds must be a positive integer")

        windows = record.get("windows")
        if not isinstance(windows, list) or not windows:
            raise ContractError(f"{prefix}.windows must be a non-empty array")
        window_names = set()
        canonical_windows = []
        for window_index, window in enumerate(windows):
            wp = f"{prefix}.windows[{window_index}]"
            if not isinstance(window, dict):
                raise ContractError(f"{wp} must be an object")
            name = nonempty_string(window.get("name"), f"{wp}.name")
            if provider == "opencode-go" and name == "rolling":
                name = "five-hour"
            if name in window_names:
                raise ContractError(f"{prefix} has duplicate window name: {name}")
            window_names.add(name)
            role = nonempty_string(window.get("role"), f"{wp}.role")
            if role not in WINDOW_ROLES:
                raise ContractError(
                    f"{wp}.role must be one of {', '.join(sorted(WINDOW_ROLES))}"
                )
            utilization = finite_number(
                window.get("utilization"), f"{wp}.utilization", minimum=0
            )
            resets_at = nonempty_string(window.get("resets_at"), f"{wp}.resets_at")
            parse_timestamp(resets_at, f"{wp}.resets_at")
            window_seconds = window.get("window_seconds")
            if (
                isinstance(window_seconds, bool)
                or not isinstance(window_seconds, int)
                or window_seconds <= 0
            ):
                raise ContractError(f"{wp}.window_seconds must be a positive integer")
            allowance_weight = finite_number(
                window.get("allowance_weight"),
                f"{wp}.allowance_weight",
                strictly_positive=True,
            )
            canonical_windows.append(
                {
                    "name": name,
                    "role": role,
                    "utilization": utilization,
                    "resets_at": resets_at,
                    "window_seconds": window_seconds,
                    "allowance_weight": allowance_weight,
                }
            )
        if provider != "opencode-go" and not any(
            window["role"] == "allowance" for window in canonical_windows
        ):
            raise ContractError(f"{prefix} must contain at least one allowance window")
        if provider == "opencode-go":
            if window_names != set(GO_WINDOW_SPECS):
                raise ContractError(
                    f"{prefix}.windows must contain exactly five-hour, weekly, and monthly"
                )
            for window in canonical_windows:
                expected_seconds, expected_ratio = GO_WINDOW_SPECS[window["name"]]
                if expected_seconds is not None and window["window_seconds"] != expected_seconds:
                    raise ContractError(
                        f"{prefix}.{window['name']}.window_seconds must be {expected_seconds}"
                    )
                if not close_enough(window["allowance_weight"], expected_ratio):
                    raise ContractError(
                        f"{prefix}.{window['name']}.allowance_weight must be {expected_ratio}"
                    )
            if next(
                window for window in canonical_windows if window["name"] == "monthly"
            )["role"] != "allowance":
                raise ContractError(f"{prefix}.monthly must be an allowance window")

        canonical_record = {
            "account_key": account_key,
            "auth_key": auth_key,
            "provider": provider,
            "control_scope": control_scope,
            "plan": plan,
            "plan_weight": plan_weight,
            "health": health,
            "recent_burn_units_per_hour": recent_burn,
            "windows": sorted(canonical_windows, key=lambda item: item["name"]),
            "stale_after_seconds": stale_after,
        }
        if canonical_cooldown is not None:
            canonical_record["cooldown"] = canonical_cooldown
        if active_cooldown_until is not None:
            # The nested object above is for humans and for history. The
            # consumer's normalizer reads FLAT keys off each account row
            # (`pace.ts` `firstValue(record, [...])`), so a nested-only
            # cooldown is invisible to it — the producer would look correct
            # and the pacer would still hand work to a cooled-down credential.
            # `exhausted_until` is the head of the alias list it accepts.
            #
            # Only an ACTIVE cooldown is published flat. An expired one stays
            # in the nested object: a reader that takes mere presence as "in
            # cooldown" would otherwise park a credential that is already free,
            # and a reader that compares the instant to now loses nothing.
            canonical_record["exhausted_until"] = active_cooldown_until
        canonical_record.update(capacity_shape(record, prefix))
        if control_scope == "logical_account":
            governor = governor_input(record, prefix)
            governing_window = nonempty_string(
                governor["governing_window"], f"{prefix}.governing_window"
            )
            if governing_window == "rolling":
                governing_window = "five-hour"
            windows_by_name = {window["name"]: window for window in canonical_windows}
            if governing_window not in windows_by_name:
                raise ContractError(f"{prefix}.governing_window does not name a supplied window")
            governing_reset_at = nonempty_string(
                governor["governing_reset_at"], f"{prefix}.governing_reset_at"
            )
            parse_timestamp(governing_reset_at, f"{prefix}.governing_reset_at")
            normalized_remaining = finite_number(
                governor["normalized_remaining"], f"{prefix}.normalized_remaining", minimum=0
            )
            if normalized_remaining > 1:
                raise ContractError(f"{prefix}.normalized_remaining must be at most 1")
            target_burn_rate = finite_number(
                governor["target_burn_rate"], f"{prefix}.target_burn_rate", minimum=0
            )
            observed_burn_rate = finite_number(
                governor["observed_burn_rate"], f"{prefix}.observed_burn_rate", minimum=0
            )
            deficit = finite_number(governor["deficit"], f"{prefix}.deficit", minimum=0)
            recommended_share = finite_number(
                governor["recommended_share"], f"{prefix}.recommended_share", minimum=0
            )
            if recommended_share > 1:
                raise ContractError(f"{prefix}.recommended_share must be at most 1")

            rates = []
            for window in canonical_windows:
                reset = parse_timestamp(window["resets_at"], f"{prefix}.{window['name']}.resets_at")
                seconds = (reset - observed_time).total_seconds()
                if seconds <= 0:
                    raise ContractError(f"{prefix}.{window['name']}.resets_at must be after observedAt")
                remaining = window["allowance_weight"] * max(
                    0.0, 1.0 - window["utilization"]
                )
                rates.append((remaining / (seconds / 3600.0), reset, window["name"]))
            expected_governing_window = min(rates)[2]
            if governing_window != expected_governing_window:
                raise ContractError(
                    f"{prefix}.governing_window is not the binding window {expected_governing_window!r}"
                )
            governing = windows_by_name[governing_window]
            if governing_reset_at != governing["resets_at"]:
                raise ContractError(f"{prefix}.governing_reset_at does not match governing window")
            expected_remaining = governing["allowance_weight"] * max(
                0.0, 1.0 - governing["utilization"]
            )
            if not close_enough(normalized_remaining, expected_remaining):
                raise ContractError(f"{prefix}.normalized_remaining is inconsistent with governing window")
            seconds_remaining = (
                parse_timestamp(governing_reset_at, f"{prefix}.governing_reset_at") - observed_time
            ).total_seconds()
            expected_target = (
                expected_remaining / (seconds_remaining / 3600.0)
                if seconds_remaining > 0
                else 0.0
            )
            if seconds_remaining <= 0:
                raise ContractError(f"{prefix}.governing_reset_at must be after observedAt")
            if not close_enough(
                target_burn_rate, expected_target, relative=TARGET_RATE_REL_TOLERANCE
            ):
                raise ContractError(f"{prefix}.target_burn_rate is inconsistent with governing window")
            canonical_record.update(
                {
                    "governing_window": governing_window,
                    "governing_reset_at": governing_reset_at,
                    "normalized_remaining": normalized_remaining,
                    "target_burn_rate": target_burn_rate,
                    "observed_burn_rate": observed_burn_rate,
                    "deficit": deficit,
                    "recommended_share": recommended_share,
                }
            )
        elif record.get("governor") is not None or any(
            name in record
            for name in (
                "governing_window",
                "governing_reset_at",
                "normalized_remaining",
                "target_burn_rate",
                "observed_burn_rate",
                "deficit",
                "recommended_share",
            )
        ):
            raise ContractError(f"{prefix} governor fields are only valid for logical accounts")

        canonical_records.append(canonical_record)

    return {
        "contract_version": 4,
        "observedAt": observed_at,
        "records": sorted(
            canonical_records, key=lambda item: (item["account_key"], item["auth_key"])
        ),
    }


def secure_atomic_write(path, payload):
    destination = pathlib.Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{destination.name}.", dir=destination.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", default="-", help="source JSON file, or - for stdin")
    parser.add_argument("--output", default="-", help="canonical JSON file, or - for stdout")
    args = parser.parse_args()

    try:
        if args.input == "-":
            document = json.load(__import__("sys").stdin)
        else:
            with open(args.input, encoding="utf-8") as handle:
                document = json.load(handle)
        canonical = canonicalize_document(document)
    except (OSError, json.JSONDecodeError, ContractError) as exc:
        print(f"REFUSED: {exc}", file=__import__("sys").stderr)
        return 2

    payload = json.dumps(canonical, indent=2, sort_keys=True) + "\n"
    if args.output == "-":
        print(payload, end="")
    else:
        secure_atomic_write(args.output, payload)
        print(f"WROTE {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
