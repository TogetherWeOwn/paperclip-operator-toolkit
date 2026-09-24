#!/usr/bin/env python3
import contextlib
import io
import json
import os
import pathlib
import socketserver
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler
from unittest import mock

import cliproxy_quota_contract as contract
import cliproxy_quota_controller as controller


NOW = "2026-09-15T14:10:00Z"
GO_RATES_PER_DAY = {
    "go-1": 0.025092,
    "go-2": 0.001258,
    "go-3": 0.002375,
}


def window(name, utilization, reset, seconds, weight, role="allowance"):
    return {
        "name": name,
        "role": role,
        "utilization": utilization,
        "resets_at": reset,
        "window_seconds": seconds,
        "allowance_weight": weight,
    }


def direct_record(account, auth, provider, windows, health="healthy", burn=0.0, stale=900):
    return {
        "account_key": account,
        "auth_key": auth,
        "provider": provider,
        "control_scope": "direct_auth",
        "plan": "subscription",
        "plan_weight": 1,
        "health": health,
        "recent_burn_units_per_hour": burn,
        "stale_after_seconds": stale,
        "windows": windows,
    }


def go_record(account, auth, utilization, reset, deficit, share, weekly_utilization=0.0):
    return {
        "account_key": account,
        "auth_key": auth,
        "provider": "opencode-go",
        "control_scope": "logical_account",
        "plan": "go",
        "plan_weight": 1,
        "health": "healthy",
        "recent_burn_units_per_hour": 0.0,
        "stale_after_seconds": 900,
        "windows": [
            window("rolling", 0.0, "2026-09-15T19:10:00Z", 18000, 0.2, "serviceability"),
            window(
                "weekly",
                weekly_utilization,
                "2026-09-21T00:00:00Z",
                604800,
                0.5,
                "serviceability",
            ),
            window("monthly", utilization, reset, 2592000, 1.0),
        ],
        "governing_window": "monthly",
        "normalized_remaining": 1.0 - utilization,
        "governing_reset_at": reset,
        "target_burn_rate": GO_RATES_PER_DAY[account] / 24.0,
        "observed_burn_rate": 0.0,
        "deficit": deficit,
        "recommended_share": share,
    }


def go_fixture(observed=NOW):
    rate_total = sum(GO_RATES_PER_DAY.values())
    return {
        "observedAt": observed,
        "records": [
            go_record(
                "go-1",
                "auth-go-1",
                0.33,
                "2026-10-12T07:01:00Z",
                0.20,
                GO_RATES_PER_DAY["go-1"] / rate_total,
                weekly_utilization=0.61,
            ),
            go_record(
                "go-2",
                "auth-go-2",
                0.99,
                "2026-09-23T12:57:00Z",
                0.01,
                GO_RATES_PER_DAY["go-2"] / rate_total,
            ),
            go_record(
                "go-3",
                "auth-go-3",
                0.95,
                "2026-10-06T15:20:00Z",
                0.05,
                GO_RATES_PER_DAY["go-3"] / rate_total,
                weekly_utilization=0.08,
            ),
        ],
    }


def direct_fixture(observed=NOW):
    return {
        "observedAt": observed,
        "records": [
            direct_record(
                "claude-1",
                "auth-claude-1",
                "claude",
                [window("weekly", 0.25, "2026-09-21T00:00:00Z", 604800, 1.0)],
                burn=0.01,
            ),
            direct_record(
                "codex-1",
                "auth-codex-1",
                "codex",
                [window("weekly", 0.75, "2026-09-21T00:00:00Z", 604800, 1.0)],
            ),
            direct_record(
                "zai-1",
                "auth-zai-1",
                "zai",
                [window("weekly", 0.50, "2026-09-16T12:00:00Z", 604800, 1.0)],
            ),
        ],
    }


def mixed_fixture(observed=NOW):
    return {
        "observedAt": observed,
        "records": direct_fixture(observed)["records"] + go_fixture(observed)["records"],
    }


def assert_go_acceptance(rows):
    expected = {
        "go-1": ("monthly", 0.67, "2026-10-12T07:01:00Z", 0.025092),
        "go-2": ("monthly", 0.01, "2026-09-23T12:57:00Z", 0.001258),
        "go-3": ("monthly", 0.05, "2026-10-06T15:20:00Z", 0.002375),
    }
    indexed = {row["account_key"]: row for row in rows}
    if set(indexed) != set(expected):
        raise AssertionError("Go fixture account identities changed")
    for account_key, (window_name, remaining, reset_at, rate_per_day) in expected.items():
        row = indexed[account_key]
        if row["governing_window"] != window_name:
            raise AssertionError(f"{account_key} no longer uses its monthly governing window")
        if not abs(row["normalized_remaining"] - remaining) < 1e-9:
            raise AssertionError(f"{account_key} normalized remaining changed")
        if row["governing_reset_at"] != reset_at:
            raise AssertionError(f"{account_key} governing reset changed")
        if not abs(row["target_burn_rate"] * 24 - rate_per_day) < 5e-7:
            raise AssertionError(f"{account_key} target burn rate changed")
    shares = [indexed[account]["recommended_share"] for account in sorted(indexed)]
    if max(shares) - min(shares) < 1e-9:
        raise AssertionError("Go recommendations regressed to equal logical-account round-robin")


class FakeState:
    def __init__(self):
        auth_keys = ["auth-claude-1", "auth-codex-1", "auth-zai-1", "auth-go-1", "auth-go-2", "auth-go-3"]
        self.auths = {
            auth_key: {
                "id": auth_key,
                "name": auth_key + ".json",
                "auth_index": "idx-" + auth_key,
                "priority": 7 + index,
                "weight": 10 * index,
                "disabled": False,
            }
            for index, auth_key in enumerate(auth_keys, start=1)
        }
        self.requests = []
        self.bearer = "management-canary"
        self.fail_once = None
        self.corrupt_readback_once = False


class Handler(BaseHTTPRequestHandler):
    server_version = "test"

    def log_message(self, _format, *_args):
        return

    def _json(self):
        length = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(length) or b"{}")

    def _reply(self, body, status=200):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _authorized(self):
        return self.headers.get("Authorization") == f"Bearer {self.server.state.bearer}"

    def do_GET(self):
        if not self._authorized():
            self._reply({"error": "unauthorized"}, 401)
            return
        if self.path != "/v0/management/auth-files":
            self._reply({"error": "not found"}, 404)
            return
        self.server.state.requests.append(("GET", self.path, None))
        files = [dict(value) for value in self.server.state.auths.values()]
        if self.server.state.corrupt_readback_once and len(
            [request for request in self.server.state.requests if request[0] == "GET"]
        ) == 2:
            files[0]["weight"] += 1
        self._reply({"files": files})

    def do_PATCH(self):
        if not self._authorized():
            self._reply({"error": "unauthorized"}, 401)
            return
        body = self._json()
        self.server.state.requests.append(("PATCH", self.path, body))
        if self.server.state.fail_once == (self.path, body.get("name")):
            self.server.state.fail_once = None
            self._reply({"error": "injected"}, 500)
            return
        auth = self.server.state.auths.get(body.get("name"))
        if auth is None:
            self._reply({"error": "missing"}, 404)
            return
        if self.path == "/v0/management/auth-files/fields":
            auth["priority"] = body["priority"]
            auth["weight"] = body["weight"]
            self._reply({"status": "ok"})
        elif self.path == "/v0/management/auth-files/status":
            auth["disabled"] = body["disabled"]
            self._reply({"status": "ok", "disabled": body["disabled"]})
        else:
            self._reply({"error": "not found"}, 404)


@contextlib.contextmanager
def fake_server():
    state = FakeState()
    server = socketserver.TCPServer(("127.0.0.1", 0), Handler)
    server.state = state
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield state, f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


class ContractTests(unittest.TestCase):
    def test_canonical_contract_preserves_stable_keys_and_governor_output(self):
        result = contract.canonicalize_document(go_fixture())
        self.assertEqual([row["account_key"] for row in result["records"]], ["go-1", "go-2", "go-3"])
        self.assertEqual(result["records"][0]["auth_key"], "auth-go-1")
        self.assertEqual(result["records"][0]["control_scope"], "logical_account")
        self.assertEqual(result["records"][0]["governing_window"], "monthly")
        self.assertAlmostEqual(
            result["records"][0]["target_burn_rate"] * 24,
            0.025092,
            places=6,
        )

    # The 2026-09-17 00:39Z Z.ai outage: weekly 0.46 / five-hour 0.60, so every
    # quota window read healthy, while the serving plugin held the account in a
    # "conservative rate-limit cooldown" until 00:43:58Z. Seven runs failed.
    def cooldown_fixture(self, health="healthy", until="2026-09-15T14:43:58Z"):
        fixture = direct_fixture()
        zai = fixture["records"][2]
        zai["windows"] = [
            window("weekly", 0.46, "2026-09-16T12:00:00Z", 604800, 1.0),
            window("five-hour", 0.60, "2026-09-15T19:10:00Z", 18000, 0.2),
        ]
        zai["health"] = health
        zai["cooldown"] = {"until": until, "reason": "conservative rate-limit cooldown"}
        return fixture

    def test_active_cooldown_cannot_be_published_as_healthy(self):
        with self.assertRaisesRegex(
            contract.ContractError, r"cooldown is active until .* must be 'exhausted'"
        ):
            contract.canonicalize_document(self.cooldown_fixture())

    def test_active_cooldown_survives_canonicalization_as_first_class_state(self):
        result = contract.canonicalize_document(self.cooldown_fixture(health="exhausted"))
        zai = next(row for row in result["records"] if row["account_key"] == "zai-1")
        self.assertEqual(
            zai["cooldown"],
            {"until": "2026-09-15T14:43:58Z", "reason": "conservative rate-limit cooldown"},
        )

    def test_expired_cooldown_does_not_bind_health(self):
        fixture = self.cooldown_fixture(until="2026-09-15T13:00:00Z")
        result = contract.canonicalize_document(fixture)
        zai = next(row for row in result["records"] if row["account_key"] == "zai-1")
        self.assertEqual(zai["health"], "healthy")
        self.assertEqual(zai["cooldown"]["until"], "2026-09-15T13:00:00Z")

    def test_cooldown_without_a_reason_is_refused(self):
        fixture = self.cooldown_fixture(health="exhausted")
        del fixture["records"][2]["cooldown"]["reason"]
        with self.assertRaisesRegex(contract.ContractError, r"cooldown\.reason"):
            contract.canonicalize_document(fixture)

    def test_records_without_cooldown_are_unchanged(self):
        result = contract.canonicalize_document(direct_fixture())
        for row in result["records"]:
            self.assertNotIn("cooldown", row)
            self.assertNotIn("exhausted_until", row)

    # The consumer's normalizer reads flat keys off each account row, so the
    # nested object alone never reaches it (TOG-3131 contract note).
    def test_active_cooldown_is_published_under_the_key_the_consumer_reads(self):
        result = contract.canonicalize_document(self.cooldown_fixture(health="exhausted"))
        zai = next(row for row in result["records"] if row["account_key"] == "zai-1")
        self.assertEqual(zai["exhausted_until"], "2026-09-15T14:43:58Z")
        self.assertEqual(zai["exhausted_until"], zai["cooldown"]["until"])

    def test_expired_cooldown_is_not_published_flat(self):
        result = contract.canonicalize_document(
            self.cooldown_fixture(until="2026-09-15T13:00:00Z")
        )
        zai = next(row for row in result["records"] if row["account_key"] == "zai-1")
        self.assertNotIn("exhausted_until", zai)
        self.assertEqual(zai["cooldown"]["until"], "2026-09-15T13:00:00Z")

    # An add-only annotator is sticky: re-running it over its own output can
    # carry a field past the condition that justified it (TOG-3133). The flat
    # key is derived from the nested cooldown on every pass and never read back
    # from input, so it drops itself once the cooldown expires.
    def test_flat_cooldown_is_rederived_not_carried(self):
        published = contract.canonicalize_document(self.cooldown_fixture(health="exhausted"))
        self.assertIn(
            "exhausted_until",
            next(row for row in published["records"] if row["account_key"] == "zai-1"),
        )
        later = json.loads(json.dumps(published))
        later["observedAt"] = "2026-09-15T15:00:00Z"
        for row in later["records"]:
            if row["account_key"] == "zai-1":
                row["health"] = "healthy"
            for entry in row["windows"]:
                entry["resets_at"] = "2026-09-16T12:00:00Z"
        zai = next(
            row
            for row in contract.canonicalize_document(later)["records"]
            if row["account_key"] == "zai-1"
        )
        self.assertNotIn("exhausted_until", zai)
        self.assertEqual(zai["cooldown"]["until"], "2026-09-15T14:43:58Z")

    def test_canonicalization_is_idempotent_over_its_own_output(self):
        fixture = self.cooldown_fixture(health="exhausted")
        fixture["records"][2].update(credential_concurrency=4, credential_in_flight=0)
        once = contract.canonicalize_document(fixture)
        self.assertEqual(contract.canonicalize_document(once), once)

    def shape_fixture(self, **fields):
        fixture = direct_fixture()
        fixture["records"][2].update(fields)
        return fixture

    def test_capacity_shape_is_emitted_under_the_keys_the_consumer_reads(self):
        result = contract.canonicalize_document(
            self.shape_fixture(credential_concurrency=4, credential_in_flight=2)
        )
        zai = next(row for row in result["records"] if row["account_key"] == "zai-1")
        self.assertEqual(zai["credential_concurrency"], 4)
        self.assertEqual(zai["credential_in_flight"], 2)

    def test_zero_in_flight_is_meaningful_not_missing(self):
        result = contract.canonicalize_document(
            self.shape_fixture(credential_concurrency=4, credential_in_flight=0)
        )
        zai = next(row for row in result["records"] if row["account_key"] == "zai-1")
        self.assertEqual(zai["credential_in_flight"], 0)

    def test_nonpositive_concurrency_is_refused_not_published_and_discarded(self):
        for broken in (0, -1):
            with self.subTest(concurrency=broken):
                with self.assertRaisesRegex(
                    contract.ContractError, r"credential_concurrency must be greater than zero"
                ):
                    contract.canonicalize_document(
                        self.shape_fixture(credential_concurrency=broken)
                    )

    def test_capacity_shape_must_be_whole_requests(self):
        for field, value in (
            ("credential_concurrency", 4.5),
            ("credential_in_flight", True),
            ("credential_in_flight", "2"),
        ):
            with self.subTest(field=field, value=value):
                with self.assertRaisesRegex(contract.ContractError, rf"{field} must be an integer"):
                    contract.canonicalize_document(self.shape_fixture(**{field: value}))

    def test_negative_in_flight_is_refused(self):
        with self.assertRaisesRegex(
            contract.ContractError, r"credential_in_flight must be at least 0"
        ):
            contract.canonicalize_document(self.shape_fixture(credential_in_flight=-1))

    def test_camel_case_capacity_shape_is_normalized_to_the_snake_case_head(self):
        result = contract.canonicalize_document(
            self.shape_fixture(credentialConcurrency=3, credentialInFlight=1)
        )
        zai = next(row for row in result["records"] if row["account_key"] == "zai-1")
        self.assertEqual(zai["credential_concurrency"], 3)
        self.assertEqual(zai["credential_in_flight"], 1)
        self.assertNotIn("credentialConcurrency", zai)
        self.assertNotIn("credentialInFlight", zai)

    def test_conflicting_capacity_spellings_are_refused(self):
        with self.assertRaisesRegex(
            contract.ContractError,
            r"credential_concurrency conflicts with .*credentialConcurrency",
        ):
            contract.canonicalize_document(
                self.shape_fixture(credential_concurrency=4, credentialConcurrency=8)
            )

    def test_capacity_shape_is_optional_and_partial(self):
        result = contract.canonicalize_document(self.shape_fixture(credential_in_flight=0))
        zai = next(row for row in result["records"] if row["account_key"] == "zai-1")
        self.assertEqual(zai["credential_in_flight"], 0)
        self.assertNotIn("credential_concurrency", zai)

    def test_in_flight_may_exceed_concurrency_mid_burst(self):
        result = contract.canonicalize_document(
            self.shape_fixture(credential_concurrency=2, credential_in_flight=3)
        )
        zai = next(row for row in result["records"] if row["account_key"] == "zai-1")
        self.assertEqual((zai["credential_concurrency"], zai["credential_in_flight"]), (2, 3))

    def test_duplicate_identity_is_not_silently_repaired(self):
        fixture = go_fixture()
        fixture["records"][1]["account_key"] = fixture["records"][0]["account_key"]
        with self.assertRaisesRegex(contract.ContractError, "duplicate account_key"):
            contract.canonicalize_document(fixture)

    def test_provider_cannot_cross_control_scope_boundary(self):
        fixture = go_fixture()
        fixture["records"][0]["control_scope"] = "direct_auth"
        with self.assertRaisesRegex(contract.ContractError, "requires control_scope 'logical_account'"):
            contract.canonicalize_document(fixture)

    def test_control_scope_is_inferred_from_provider_for_existing_collectors(self):
        fixture = mixed_fixture()
        for record in fixture["records"]:
            del record["control_scope"]
        result = contract.canonicalize_document(fixture)
        scopes = {row["provider"]: row["control_scope"] for row in result["records"]}
        self.assertEqual(scopes["claude"], "direct_auth")
        self.assertEqual(scopes["codex"], "direct_auth")
        self.assertEqual(scopes["zai"], "direct_auth")
        self.assertEqual(scopes["opencode-go"], "logical_account")

    def test_logical_account_governor_fields_are_required(self):
        fixture = go_fixture()
        del fixture["records"][0]["recommended_share"]
        with self.assertRaisesRegex(contract.ContractError, "recommended_share must be a number"):
            contract.canonicalize_document(fixture)

    def test_nested_governor_input_is_accepted_and_emitted_flat(self):
        fixture = go_fixture()
        record = fixture["records"][0]
        record["governor"] = {
            "governingWindow": record.pop("governing_window"),
            "governingResetAt": record.pop("governing_reset_at"),
            "normalizedRemaining": record.pop("normalized_remaining"),
            "targetBurnRate": record.pop("target_burn_rate"),
            "observedBurnRate": record.pop("observed_burn_rate"),
            "deficit": record.pop("deficit"),
            "recommendedShare": record.pop("recommended_share"),
        }
        canonical = contract.canonicalize_document(fixture)["records"][0]
        self.assertEqual(canonical["governing_window"], "monthly")
        self.assertNotIn("governor", canonical)

    def test_identity_surrounding_whitespace_is_rejected(self):
        fixture = go_fixture()
        fixture["records"][0]["account_key"] = " go-1"
        with self.assertRaisesRegex(contract.ContractError, "surrounding whitespace"):
            contract.canonicalize_document(fixture)

    def test_go_windows_require_exact_names_ratios_and_durations(self):
        fixture = go_fixture()
        fixture["records"][0]["windows"][0]["allowance_weight"] = 0.21
        with self.assertRaisesRegex(contract.ContractError, "allowance_weight must be 0.2"):
            contract.canonicalize_document(fixture)
        fixture = go_fixture()
        fixture["records"][0]["windows"].pop()
        with self.assertRaisesRegex(contract.ContractError, "exactly five-hour"):
            contract.canonicalize_document(fixture)

    def test_go_governor_must_match_binding_window(self):
        fixture = go_fixture()
        record = fixture["records"][0]
        record["governing_window"] = "weekly"
        record["governing_reset_at"] = record["windows"][1]["resets_at"]
        record["normalized_remaining"] = 0.5 * (1 - record["windows"][1]["utilization"])
        hours = (
            contract.parse_timestamp(record["governing_reset_at"], "reset")
            - contract.parse_timestamp(fixture["observedAt"], "observed")
        ).total_seconds() / 3600
        record["target_burn_rate"] = record["normalized_remaining"] / hours
        with self.assertRaisesRegex(contract.ContractError, "not the binding window"):
            contract.canonicalize_document(fixture)


class PlanningTests(unittest.TestCase):
    def plan(self, fixture=None, now=NOW):
        document = contract.canonicalize_document(fixture or mixed_fixture())
        return controller.plan(document, contract.parse_timestamp(now, "now"))

    def test_cooled_down_account_is_disabled_despite_quota_headroom(self):
        fixture = direct_fixture()
        zai = fixture["records"][2]
        zai["windows"] = [
            window("weekly", 0.46, "2026-09-16T12:00:00Z", 604800, 1.0),
            window("five-hour", 0.60, "2026-09-15T19:10:00Z", 18000, 0.2),
        ]
        zai["health"] = "exhausted"
        zai["cooldown"] = {
            "until": "2026-09-15T14:43:58Z",
            "reason": "conservative rate-limit cooldown",
        }
        row = next(
            entry
            for entry in self.plan(fixture)["decisions"]
            if entry["account_key"] == "zai-1"
        )
        # Every window still has headroom; only the cooldown makes it unusable.
        self.assertGreater(row["remaining_allowance"], 0)
        self.assertFalse(row["serviceable"])
        self.assertTrue(row["disabled"])
        self.assertEqual(row["weight"], 0)

    def test_go_status_is_exposed_without_static_weight_decisions(self):
        planned = self.plan(go_fixture())
        self.assertEqual(planned["decisions"], [])
        assert_go_acceptance(planned["logical_accounts"])
        for row in planned["logical_accounts"]:
            self.assertNotIn("weight", row)
            self.assertNotIn("priority", row)
            self.assertNotIn("disabled", row)

    def test_go_governor_shares_are_preserved_not_recomputed_as_equal_round_robin(self):
        planned = self.plan(go_fixture())
        shares = [row["recommended_share"] for row in planned["logical_accounts"]]
        self.assertNotEqual(shares, [1 / 3, 1 / 3, 1 / 3])
        self.assertGreater(shares[0], shares[2])
        self.assertGreater(shares[2], shares[1])

    def test_positive_control_kills_weekly_only_go_governor(self):
        planned = self.plan(go_fixture())
        assert_go_acceptance(planned["logical_accounts"])
        mutant = json.loads(json.dumps(planned["logical_accounts"]))
        for row in mutant:
            row["governing_window"] = "weekly"
        with self.assertRaisesRegex(AssertionError, "monthly governing window"):
            assert_go_acceptance(mutant)

    def test_positive_control_kills_equal_go_round_robin(self):
        planned = self.plan(go_fixture())
        assert_go_acceptance(planned["logical_accounts"])
        mutant = json.loads(json.dumps(planned["logical_accounts"]))
        for row in mutant:
            row["recommended_share"] = 1 / 3
        with self.assertRaisesRegex(AssertionError, "equal logical-account round-robin"):
            assert_go_acceptance(mutant)

    def test_direct_auth_priority_is_100_only_inside_final_24_hours(self):
        rows = {row["account_key"]: row for row in self.plan(now="2026-09-15T14:10:00Z")["decisions"]}
        self.assertEqual(rows["zai-1"]["priority"], 100)
        self.assertEqual(rows["claude-1"]["priority"], 0)
        self.assertEqual(rows["codex-1"]["priority"], 0)

    def test_direct_auth_weights_use_binding_clear_rate(self):
        rows = {row["account_key"]: row for row in self.plan(direct_fixture())["decisions"]}
        self.assertGreater(rows["claude-1"]["weight"], rows["codex-1"]["weight"])
        self.assertNotEqual(rows["claude-1"]["weight"], rows["codex-1"]["weight"])

    def test_exhausted_direct_auth_account_is_disabled(self):
        fixture = direct_fixture()
        fixture["records"][0]["windows"][0]["utilization"] = 1.0
        rows = {row["account_key"]: row for row in self.plan(fixture)["decisions"]}
        self.assertTrue(rows["claude-1"]["disabled"])
        self.assertEqual(rows["claude-1"]["weight"], 0)

    def test_stale_telemetry_refuses_mutation(self):
        planned = self.plan(now="2026-09-15T14:30:01Z")
        self.assertFalse(planned["fresh"])
        self.assertFalse(planned["mutation_allowed"])
        self.assertTrue(planned["stale_reasons"])

    def test_same_input_and_now_are_byte_deterministic(self):
        a = json.dumps(self.plan(), sort_keys=True, separators=(",", ":"))
        b = json.dumps(self.plan(), sort_keys=True, separators=(",", ":"))
        self.assertEqual(a, b)

    def test_logical_account_aggregate_sums_only_serviceable_targets(self):
        fixture = go_fixture()
        fixture["records"][1]["health"] = "unavailable"
        planned = self.plan(fixture)
        expected = sum(
            row["target_burn_rate"]
            for row in planned["logical_accounts"]
            if row["serviceable"]
        )
        self.assertAlmostEqual(planned["logical_account_target_burn_rate"], expected)

    def test_expired_window_marks_plan_stale_without_mutation(self):
        fixture = direct_fixture()
        fixture["records"][0]["windows"][0]["resets_at"] = "2026-09-15T14:00:00Z"
        planned = self.plan(fixture)
        self.assertFalse(planned["mutation_allowed"])
        self.assertRegex(";".join(planned["stale_reasons"]), "expired windows")

    def test_sub_hour_binding_uses_actual_positive_seconds(self):
        fixture = direct_fixture()
        fixture["records"][0]["windows"][0]["resets_at"] = "2026-09-15T14:40:00Z"
        row = {row["account_key"]: row for row in self.plan(fixture)["decisions"]}["claude-1"]
        self.assertAlmostEqual(row["hours_to_reset"], 0.5)
        self.assertAlmostEqual(row["clear_rate"], 1.5)


class ControllerIntegrationTests(unittest.TestCase):
    def write_fixture(self, directory, observed=NOW):
        path = pathlib.Path(directory, "telemetry.json")
        path.write_text(json.dumps(mixed_fixture(observed)))
        return path

    @contextlib.contextmanager
    def credential(self, value):
        read_fd, write_fd = os.pipe()
        os.write(write_fd, value.encode())
        os.close(write_fd)
        with mock.patch.dict(os.environ, {"CLIPROXY_MANAGEMENT_KEY_FD": str(read_fd)}, clear=False):
            try:
                yield
            finally:
                try:
                    os.close(read_fd)
                except OSError:
                    pass

    def args(self, mode, tmp, url):
        return type(
            "Args",
            (),
            {
                "mode": mode,
                "management_url": url,
                "decision_log": str(pathlib.Path(tmp, "decisions.jsonl")),
                "rollback_state": str(pathlib.Path(tmp, "rollback.json")),
                "now": NOW,
            },
        )()

    def test_apply_mutates_only_direct_auth_and_rollback_restores_it(self):
        with tempfile.TemporaryDirectory() as tmp, fake_server() as (state, url):
            document = contract.canonicalize_document(mixed_fixture())
            args = self.args("apply", tmp, url)
            original = {key: dict(value) for key, value in state.auths.items()}
            with self.credential(state.bearer), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(controller.run_apply(document, contract.parse_timestamp(NOW, "now"), args), 0)
            patched_names = {
                body["name"]
                for method, _path, body in state.requests
                if method == "PATCH"
            }
            self.assertEqual(patched_names, {"auth-claude-1", "auth-codex-1", "auth-zai-1"})
            for auth_key in ("auth-go-1", "auth-go-2", "auth-go-3"):
                self.assertEqual(state.auths[auth_key], original[auth_key])
            rollback_records = json.loads(pathlib.Path(args.rollback_state).read_text())["records"]
            self.assertEqual(
                {row["auth_key"] for row in rollback_records},
                {"auth-claude-1", "auth-codex-1", "auth-zai-1"},
            )
            with self.credential(state.bearer), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(controller.run_rollback(args), 0)
            for auth_key in ("auth-claude-1", "auth-codex-1", "auth-zai-1"):
                self.assertEqual(state.auths[auth_key], original[auth_key])

    def test_go_only_apply_makes_zero_management_requests(self):
        with tempfile.TemporaryDirectory() as tmp, fake_server() as (state, url):
            document = contract.canonicalize_document(go_fixture())
            args = self.args("apply", tmp, url)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(controller.run_apply(document, contract.parse_timestamp(NOW, "now"), args), 0)
            self.assertEqual(state.requests, [])
            self.assertFalse(pathlib.Path(args.rollback_state).exists())

    def test_second_apply_reuses_original_direct_auth_rollback_baseline(self):
        with tempfile.TemporaryDirectory() as tmp, fake_server() as (state, url):
            document = contract.canonicalize_document(mixed_fixture())
            args = self.args("apply", tmp, url)
            with self.credential(state.bearer), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(controller.run_apply(document, contract.parse_timestamp(NOW, "now"), args), 0)
            baseline = pathlib.Path(args.rollback_state).read_text()
            document["records"][0]["windows"][0]["utilization"] = 0.50
            with self.credential(state.bearer), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(controller.run_apply(document, contract.parse_timestamp(NOW, "now"), args), 0)
            self.assertEqual(pathlib.Path(args.rollback_state).read_text(), baseline)

    def test_stale_apply_never_contacts_management_api(self):
        with tempfile.TemporaryDirectory() as tmp, fake_server() as (state, url):
            document = contract.canonicalize_document(mixed_fixture())
            args = self.args("apply", tmp, url)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(
                    controller.run_apply(document, contract.parse_timestamp("2026-09-15T15:00:00Z", "now"), args),
                    3,
                )
            self.assertEqual(state.requests, [])

    def assert_apply_failure_restores_all(self, failure_path=None, failure_auth=None, readback=False):
        with tempfile.TemporaryDirectory() as tmp, fake_server() as (state, url):
            document = contract.canonicalize_document(mixed_fixture())
            args = self.args("apply", tmp, url)
            original = {key: dict(value) for key, value in state.auths.items()}
            state.fail_once = (failure_path, failure_auth) if failure_path else None
            state.corrupt_readback_once = readback
            with self.credential(state.bearer), self.assertRaises(controller.ControllerError):
                controller.run_apply(document, contract.parse_timestamp(NOW, "now"), args)
            self.assertEqual(state.auths, original)

    def test_apply_field_failure_restores_all_original_records(self):
        self.assert_apply_failure_restores_all(
            "/v0/management/auth-files/fields", "auth-codex-1"
        )

    def test_apply_status_failure_restores_all_original_records(self):
        fixture = mixed_fixture()
        fixture["records"][0]["windows"][0]["utilization"] = 1.0
        with tempfile.TemporaryDirectory() as tmp, fake_server() as (state, url):
            document = contract.canonicalize_document(fixture)
            args = self.args("apply", tmp, url)
            original = {key: dict(value) for key, value in state.auths.items()}
            state.fail_once = ("/v0/management/auth-files/status", "auth-claude-1")
            with self.credential(state.bearer), self.assertRaises(controller.ControllerError):
                controller.run_apply(document, contract.parse_timestamp(NOW, "now"), args)
            self.assertEqual(state.auths, original)

    def test_apply_readback_failure_restores_all_original_records(self):
        self.assert_apply_failure_restores_all(readback=True)

    def test_rollback_now_is_deterministic(self):
        with tempfile.TemporaryDirectory() as tmp, fake_server() as (state, url):
            args = self.args("rollback", tmp, url)
            pathlib.Path(args.rollback_state).write_text(
                json.dumps({"records": [controller.snapshot_entry(state.auths["auth-claude-1"])]})
            )
            output = io.StringIO()
            with self.credential(state.bearer), contextlib.redirect_stdout(output):
                self.assertEqual(controller.run_rollback(args), 0)
            self.assertEqual(json.loads(output.getvalue())["rolled_back_at"], NOW)

    def test_systemd_bundle_has_no_plaintext_secret_configuration(self):
        root = pathlib.Path(__file__).parent
        paths = [
            root / "systemd/cliproxy-quota-controller.env.example",
            root / "systemd/paperclip-cliproxy-quota-controller.service",
            root / "systemd/run-cliproxy-quota-controller.sh",
            root / "systemd/install-cliproxy-quota-controller.sh",
        ]
        env_text = paths[0].read_text()
        self.assertNotRegex(env_text, r"(?m)^CLIPROXY_MANAGEMENT_KEY=")
        self.assertIn("LoadCredentialEncrypted=", paths[1].read_text())
        self.assertIn("CLIPROXY_MANAGEMENT_KEY_FD=3", paths[2].read_text())
        installer = paths[3].read_text()
        self.assertIn("/usr/bin/systemd-creds", installer)
        self.assertIn("forbidden CLIPROXY_MANAGEMENT_KEY plaintext", installer)

    @unittest.skipUnless(pathlib.Path("/proc").exists(), "Linux /proc is required")
    def test_running_process_hides_credential_from_cmdline_and_environ(self):
        with tempfile.TemporaryDirectory() as tmp:
            canary = "process-canary-credential"
            script = pathlib.Path(tmp, "read-fd.py")
            script.write_text(
                "import os,time\n"
                "fd=int(os.environ['CLIPROXY_MANAGEMENT_KEY_FD'])\n"
                "value=os.read(fd,16384)\n"
                "time.sleep(2)\n"
            )
            read_fd, write_fd = os.pipe()
            os.write(write_fd, canary.encode())
            os.close(write_fd)
            process = subprocess.Popen(
                ["python3", str(script)],
                env={**os.environ, "CLIPROXY_MANAGEMENT_KEY_FD": str(read_fd)},
                pass_fds=(read_fd,),
            )
            os.close(read_fd)
            try:
                time.sleep(0.2)
                cmdline = pathlib.Path(f"/proc/{process.pid}/cmdline").read_bytes()
                environ = pathlib.Path(f"/proc/{process.pid}/environ").read_bytes()
                self.assertNotIn(canary.encode(), cmdline)
                self.assertNotIn(canary.encode(), environ)
            finally:
                process.wait(timeout=5)

    def test_management_credential_is_absent_from_argv_logs_and_files(self):
        with tempfile.TemporaryDirectory() as tmp, fake_server() as (state, url):
            telemetry = self.write_fixture(tmp)
            log = pathlib.Path(tmp, "decisions.jsonl")
            rollback = pathlib.Path(tmp, "rollback.json")
            command = [
                "python3",
                str(pathlib.Path(__file__).with_name("cliproxy_quota_controller.py")),
                "apply",
                "--telemetry",
                str(telemetry),
                "--now",
                NOW,
                "--management-url",
                url,
                "--decision-log",
                str(log),
                "--rollback-state",
                str(rollback),
            ]
            read_fd, write_fd = os.pipe()
            os.write(write_fd, state.bearer.encode())
            os.close(write_fd)
            try:
                result = subprocess.run(
                    command,
                    env={**os.environ, "CLIPROXY_MANAGEMENT_KEY_FD": str(read_fd)},
                    pass_fds=(read_fd,),
                    text=True,
                    capture_output=True,
                    check=False,
                )
            finally:
                os.close(read_fd)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn(state.bearer, "\0".join(command))
            self.assertNotIn(state.bearer, result.stdout + result.stderr)
            for path in (telemetry, log, rollback):
                self.assertNotIn(state.bearer, pathlib.Path(path).read_text())


if __name__ == "__main__":
    unittest.main(verbosity=2)
