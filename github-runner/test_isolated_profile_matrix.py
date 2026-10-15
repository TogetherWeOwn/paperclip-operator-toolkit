import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from garm.validate_profile_matrix import (
    PROFILE_GLOB,
    RESULT,
    InvalidMatrix,
    parse,
    validate,
    validate_directory,
)

GARM = Path(__file__).with_name("garm")
CHECKER = GARM / "validate_profile_matrix.py"
KNOWN = ("generic-image-profile.json", "isolated-image-profile.json",
         "test-class-image-profile.json", "build-image-profile.json")
SENTINEL = "two-sentinel-never-echoed"


def synthetic(role_label, ineligible, **extra):
    document = {
        "admission_authorized": False,
        "installed": False,
        "role": role_label + "-role",
        "labels": {"eligible": ["self-hosted", role_label],
                   "explicitly_ineligible": sorted(ineligible)},
    }
    document.update(extra)
    return document


def synthetic_set():
    """Three mutually symmetric profiles, independent of the checked-in files."""
    roles = ["two-alpha", "two-beta", "two-gamma"]
    return {role + "-image-profile.json":
            synthetic(role, [other for other in roles if other != role])
            for role in roles}


def real_profiles():
    return {name: parse((GARM / name).read_bytes()) for name in KNOWN}


def write_tree(directory, profiles, extra=None):
    for name, document in profiles.items():
        (Path(directory) / name).write_text(json.dumps(document))
    for name, document in (extra or {}).items():
        (Path(directory) / name).write_text(json.dumps(document))


class ProfileMatrixTest(unittest.TestCase):
    def assertRed(self, profiles, pool_specs=None, field=None, name=None):
        with self.assertRaises(InvalidMatrix) as caught:
            validate(profiles, pool_specs)
        joined = "\n".join(caught.exception.violations)
        if field is not None:
            self.assertIn(field, joined)
        if name is not None:
            self.assertIn(name, joined)
        self.assertNotIn(SENTINEL, joined)
        return caught.exception.violations

    def test_positive_control_never_authorizes(self):
        result = validate(synthetic_set())
        self.assertEqual(result["result"], RESULT)
        for key in ("admission_authorized", "host_verified", "migration_complete"):
            self.assertIs(result[key], False)

    def test_current_tree_is_green_and_globs_every_profile(self):
        result = validate_directory(GARM)
        self.assertEqual(result["result"], RESULT)
        on_disk = sorted(path.name for path in GARM.glob(PROFILE_GLOB))
        self.assertEqual(result["profiles"], on_disk)
        for name in KNOWN:
            self.assertIn(name, result["profiles"])

    def test_checked_in_lists_are_symmetric_for_the_known_roles(self):
        profiles = real_profiles()
        roles = {name: set(doc["labels"]["eligible"]) - {"self-hosted"}
                 for name, doc in profiles.items()}
        for name, doc in profiles.items():
            others = set().union(*(roles[o] for o in profiles if o != name))
            self.assertTrue(others <= set(doc["labels"]["explicitly_ineligible"]),
                            name)

    def test_a_consistent_new_profile_is_picked_up_with_no_code_change(self):
        # Shape of a later role: an extra labels key must not trip the lint.
        profiles = real_profiles()
        newcomer = synthetic("two-newcomer", ["two-ephemeral", "two-isolated",
                                              "two-selfhosted", "two-test",
                                              "two-build"])
        newcomer["labels"]["selector_note"] = "free text"
        for doc in profiles.values():
            doc["labels"]["explicitly_ineligible"].append("two-newcomer")
        profiles["newcomer-image-profile.json"] = newcomer
        self.assertEqual(validate(profiles)["result"], RESULT)
        with tempfile.TemporaryDirectory() as tmp:
            write_tree(tmp, profiles)
            self.assertIn("newcomer-image-profile.json",
                          validate_directory(tmp)["profiles"])

    def test_new_profile_reusing_a_label_goes_red(self):
        for reused in ("two-ephemeral", "two-selfhosted", "two-isolated",
                         "two-test", "two-build"):
            profiles = real_profiles()
            profiles["extra-image-profile.json"] = synthetic(
                reused, ["two-selfhosted"])
            with self.subTest(reused=reused):
                violations = self.assertRed(
                    profiles, field="labels.eligible",
                    name="extra-image-profile.json")
                self.assertTrue(any("shared between profiles" in v
                                    for v in violations))

    def test_new_profile_unknown_to_older_lists_goes_red(self):
        profiles = real_profiles()
        profiles["extra-image-profile.json"] = synthetic(
            "two-fresh", ["two-ephemeral", "two-isolated", "two-selfhosted",
                          "two-test"])
        violations = self.assertRed(
            profiles, field="labels.explicitly_ineligible",
            name="extra-image-profile.json")
        for stale in KNOWN:
            self.assertTrue(any(v.startswith(stale) for v in violations), stale)

    def test_deleting_any_symmetric_entry_goes_red(self):
        # Symmetric entries are the other profiles' role labels. The legacy
        # static-fleet label is not any profile's role; the per-profile
        # suites pin it, so it is out of this lint's scope.
        baseline = real_profiles()
        roles = {name: set(doc["labels"]["eligible"]) - {"self-hosted"}
                 for name, doc in baseline.items()}
        checked = 0
        for name, doc in baseline.items():
            others = set().union(*(roles[o] for o in baseline if o != name))
            for label in sorted(others):
                profiles = copy.deepcopy(baseline)
                profiles[name]["labels"]["explicitly_ineligible"].remove(label)
                with self.subTest(profile=name, deleted=label):
                    self.assertRed(profiles, field="labels.explicitly_ineligible",
                                   name=name)
                checked += 1
        self.assertEqual(checked, 15)

    def test_stale_pre_matrix_lists_go_red(self):
        # Pre-matrix lists predate the test-class and build-class roles,
        # and the generic one still refuses two-selfhosted, now its own
        # role label: three violations on generic, two on isolated.
        profiles = real_profiles()
        profiles[KNOWN[0]]["labels"]["explicitly_ineligible"] = [
            "two-isolated", "two-selfhosted"]
        profiles[KNOWN[1]]["labels"]["explicitly_ineligible"] = [
            "two-ephemeral", "two-selfhosted"]
        violations = self.assertRed(profiles, field="missing role label")
        self.assertEqual(len(violations), 5)
        self.assertTrue(any("its own role label" in v
                            for v in violations))

    def test_own_role_label_in_ineligible_goes_red(self):
        profiles = real_profiles()
        profiles[KNOWN[2]]["labels"]["explicitly_ineligible"].append("two-test")
        self.assertRed(profiles, field="contains its own role label",
                       name=KNOWN[2])

    def test_duplicate_flavor_or_prefix_goes_red(self):
        for key in ("flavor_profile", "runner_prefix"):
            profiles = real_profiles()
            for name in KNOWN[:2]:
                profiles[name]["role"] = name + "-role"
                profiles[name]["pool"] = {key: "shared-name"}
            with self.subTest(key=key, carrier="profiles"):
                self.assertRed(profiles, field="pool." + key,
                               name=KNOWN[0])

    def test_pool_spec_colliding_with_another_role_goes_red(self):
        spec = parse((GARM / "canary-pool-spec.json").read_bytes())
        for key in ("flavor_profile", "runner_prefix"):
            profiles = real_profiles()
            profiles[KNOWN[2]]["role"] = "test-private"
            profiles[KNOWN[2]]["pool"] = {key: spec["pool"][key]}
            with self.subTest(key=key):
                self.assertRed(profiles, {"canary-pool-spec.json": spec},
                               field="pool." + key, name="canary-pool-spec.json")

    def test_same_role_may_repeat_its_own_pool_identifiers(self):
        spec = parse((GARM / "canary-pool-spec.json").read_bytes())
        profiles = real_profiles()
        profiles[KNOWN[1]]["pool"] = {
            "runner_prefix": spec["pool"]["runner_prefix"],
            "flavor_profile": spec["pool"]["flavor_profile"]}
        result = validate(profiles, {"canary-pool-spec.json": spec})
        self.assertEqual(result["result"], RESULT)

    def test_pool_fields_must_be_attributable_strings(self):
        for pool, role, field in [
            ({"flavor_profile": ""}, "x-role", "pool.flavor_profile"),
            ({"runner_prefix": 7}, "x-role", "pool.runner_prefix"),
            ("not-an-object", "x-role", "pool: object required"),
            ({"flavor_profile": "ok"}, None, "role: string required"),
        ]:
            profiles = real_profiles()
            profiles[KNOWN[0]]["pool"] = pool
            if role is None:
                profiles[KNOWN[0]].pop("role")
            else:
                profiles[KNOWN[0]]["role"] = role
            with self.subTest(field=field):
                self.assertRed(profiles, field=field, name=KNOWN[0])

    def test_authorization_and_installed_flags_must_be_false(self):
        for field in ("admission_authorized", "installed"):
            for bad in (True, None, "false", 0):
                profiles = real_profiles()
                profiles[KNOWN[1]][field] = bad
                with self.subTest(field=field, value=repr(bad)):
                    self.assertRed(profiles, field=field + ": must be false",
                                   name=KNOWN[1])
            profiles = real_profiles()
            del profiles[KNOWN[1]][field]
            with self.subTest(field=field, value="missing"):
                self.assertRed(profiles, field=field + ": must be false",
                               name=KNOWN[1])

    def test_label_shapes_fail_closed(self):
        shape = "list of strings required"
        for mutate, expected in (
            (lambda d: d.pop("labels"), "labels.eligible: " + shape),
            (lambda d: d["labels"].pop("eligible"), "labels.eligible: " + shape),
            (lambda d: d["labels"].pop("explicitly_ineligible"),
             "labels.explicitly_ineligible: " + shape),
            (lambda d: d["labels"].update(eligible="two-isolated"),
             "labels.eligible: " + shape),
            (lambda d: d["labels"].update(eligible=["self-hosted", 5]),
             "labels.eligible: " + shape),
            (lambda d: d["labels"].update(explicitly_ineligible=[1, 2]),
             "labels.explicitly_ineligible: " + shape),
            (lambda d: d["labels"].update(eligible=["self-hosted"]),
             "labels.eligible: no role label"),
            (lambda d: d["labels"].update(eligible=[]),
             "labels.eligible: no role label"),
        ):
            profiles = real_profiles()
            mutate(profiles[KNOWN[0]])
            with self.subTest(expected=expected):
                self.assertRed(profiles, field=KNOWN[0] + ": " + expected)

    def test_too_few_profiles_is_not_a_pass(self):
        self.assertRed({}, field="profiles: at least")
        only = {KNOWN[0]: real_profiles()[KNOWN[0]]}
        self.assertRed(only, field="profiles: at least")

    def test_messages_never_echo_values_from_the_files(self):
        profiles = real_profiles()
        profiles[KNOWN[0]]["role"] = SENTINEL
        profiles[KNOWN[0]]["pool"] = {"flavor_profile": SENTINEL}
        profiles[KNOWN[1]]["role"] = SENTINEL + "-b"
        profiles[KNOWN[1]]["pool"] = {"flavor_profile": SENTINEL}
        profiles["extra-image-profile.json"] = synthetic(
            SENTINEL, [SENTINEL + "-x"])
        profiles[KNOWN[2]]["installed"] = SENTINEL
        violations = self.assertRed(profiles)
        self.assertTrue(violations)
        self.assertNotIn(SENTINEL, json.dumps(violations))

    def test_parser_and_files_fail_closed_naming_the_file(self):
        for raw, expected in [
            (b'{"a": 1, "a": 2}', "duplicate key"),
            (b'{"a": NaN}', "non-finite number"),
            (b"{not json", "malformed input"),
            (b"x" * (1024 * 1024 + 1), "input exceeds 1MiB"),
        ]:
            with self.subTest(expected=expected):
                with tempfile.TemporaryDirectory() as tmp:
                    write_tree(tmp, synthetic_set())
                    (Path(tmp) / "bad-image-profile.json").write_bytes(raw)
                    with self.assertRaises(InvalidMatrix) as caught:
                        validate_directory(tmp)
                    joined = "\n".join(caught.exception.violations)
                    self.assertIn("bad-image-profile.json: JSON: " + expected,
                                  joined)

    def test_bad_pool_spec_file_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_tree(tmp, synthetic_set())
            (Path(tmp) / "x-pool-spec.json").write_text("{nope")
            with self.assertRaises(InvalidMatrix) as caught:
                validate_directory(tmp)
            self.assertIn("x-pool-spec.json: JSON: malformed input",
                          "\n".join(caught.exception.violations))

    def run_cli(self, *args):
        return subprocess.run([sys.executable, str(CHECKER), *args],
                              capture_output=True, text=True, timeout=60)

    def test_cli_exit_status_on_current_tree_and_mutant(self):
        green = self.run_cli()
        self.assertEqual(green.returncode, 0, green.stdout + green.stderr)
        self.assertEqual(json.loads(green.stdout)["result"], RESULT)
        with tempfile.TemporaryDirectory() as tmp:
            profiles = real_profiles()
            profiles[KNOWN[0]]["labels"]["explicitly_ineligible"].remove("two-test")
            write_tree(tmp, profiles)
            red = self.run_cli(tmp)
        self.assertEqual(red.returncode, 1, red.stdout + red.stderr)
        report = json.loads(red.stdout)
        self.assertEqual(report["result"], "profile_matrix_rejected")
        self.assertIs(report["admission_authorized"], False)
        self.assertIn(KNOWN[0], red.stdout)
        self.assertEqual(red.stderr, "")

    def test_cli_empty_directory_is_red(self):
        with tempfile.TemporaryDirectory() as tmp:
            red = self.run_cli(tmp)
        self.assertEqual(red.returncode, 1)
        self.assertIn("profiles: at least", red.stdout)


if __name__ == "__main__":
    unittest.main()
