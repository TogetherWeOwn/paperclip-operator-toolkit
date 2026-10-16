#!/usr/bin/env python3
"""Acceptance tests for the deterministic API-contract checks.

Covers blocker-ledger class 'API contract' (class 5): breaking wire
changes that slip past review. Staging/advisory first: the Builder wires
the gate in warn mode; the deterministic logic itself is pinned here.

Schema shape (plain dicts, no OpenAPI parser needed):

    {
        "GET /users": {
            "req_required": ["page"],      # required request fields
            "resp_required": ["id"],       # required response fields
        },
    }

Endpoint keys are `"METHOD /path"`. Additive changes (new endpoints,
new response fields, fewer required request fields) are non-breaking
and must pass.

Contract under test (to be implemented by the Builder in
`blocker_api_contract_checks.py`, repo root):

- `extract_endpoints(schema) -> set[str]`: the endpoint keys of a schema.
- `check_removed_endpoints(old, new) -> list[str]`: one finding per
  endpoint key present in `old` but missing in `new`. A path rename
  surfaces as a remove (plus an add) by design.
- `check_required_request_fields_added(old, new) -> list[str]`: one
  finding per newly-required request field on a surviving endpoint.
  Findings name the endpoint and the field.
- `check_response_fields_removed(old, new) -> list[str]`: one finding per
  removed required response field on a surviving endpoint. Findings name
  the endpoint and the field.

Style: stdlib unittest, in-memory fixtures, one behavior per test. No
network, no clock, no filesystem writes. The module under test is loaded
via importlib so a missing module fails every test for the right reason.
"""

import importlib.util
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODULE_PATH = HERE / "blocker_api_contract_checks.py"


def load_module():
    spec = importlib.util.spec_from_file_location(
        "blocker_api_contract_checks", MODULE_PATH
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CHECK = load_module()


def schema(*entries):
    return dict(entries)


OLD = schema(
    (
        "GET /users",
        {"req_required": ["page"], "resp_required": ["id", "name"]},
    ),
    (
        "POST /users",
        {"req_required": ["name"], "resp_required": ["id"]},
    ),
)


class ExtractEndpointsTest(unittest.TestCase):
    def test_extract_endpoints_returns_key_set(self):
        self.assertEqual(
            CHECK.extract_endpoints(OLD), {"GET /users", "POST /users"}
        )


class RemovedEndpointsTest(unittest.TestCase):
    def test_identical_schemas_pass(self):
        self.assertEqual(CHECK.check_removed_endpoints(OLD, dict(OLD)), [])

    def test_removed_endpoint_fails(self):
        new = {"GET /users": OLD["GET /users"]}
        findings = CHECK.check_removed_endpoints(OLD, new)
        self.assertEqual(len(findings), 1)
        self.assertIn("POST /users", findings[0])

    def test_added_endpoint_passes(self):
        new = dict(OLD)
        new["DELETE /users"] = {"req_required": [], "resp_required": []}
        self.assertEqual(CHECK.check_removed_endpoints(OLD, new), [])

    def test_renamed_path_surfaces_as_remove(self):
        new = dict(OLD)
        new["GET /v2/users"] = new.pop("GET /users")
        findings = CHECK.check_removed_endpoints(OLD, new)
        self.assertTrue(findings, "rename must surface as a remove")
        self.assertIn("GET /users", findings[0])


class RequiredRequestFieldsTest(unittest.TestCase):
    def test_identical_schemas_pass(self):
        self.assertEqual(
            CHECK.check_required_request_fields_added(OLD, dict(OLD)), []
        )

    def test_added_required_request_field_fails(self):
        new = dict(OLD)
        new["POST /users"] = {
            "req_required": ["name", "email"],
            "resp_required": ["id"],
        }
        findings = CHECK.check_required_request_fields_added(OLD, new)
        self.assertEqual(len(findings), 1)
        self.assertIn("POST /users", findings[0])
        self.assertIn("email", findings[0])

    def test_removed_required_request_field_passes(self):
        new = dict(OLD)
        new["POST /users"] = {"req_required": [], "resp_required": ["id"]}
        self.assertEqual(
            CHECK.check_required_request_fields_added(OLD, new), []
        )


class ResponseFieldsTest(unittest.TestCase):
    def test_identical_schemas_pass(self):
        self.assertEqual(CHECK.check_response_fields_removed(OLD, dict(OLD)), [])

    def test_removed_response_field_fails(self):
        new = dict(OLD)
        new["GET /users"] = {
            "req_required": ["page"],
            "resp_required": ["id"],
        }
        findings = CHECK.check_response_fields_removed(OLD, new)
        self.assertEqual(len(findings), 1)
        self.assertIn("GET /users", findings[0])
        self.assertIn("name", findings[0])

    def test_added_response_field_passes(self):
        new = dict(OLD)
        new["GET /users"] = {
            "req_required": ["page"],
            "resp_required": ["id", "name", "email"],
        }
        self.assertEqual(CHECK.check_response_fields_removed(OLD, new), [])


if __name__ == "__main__":
    unittest.main()
