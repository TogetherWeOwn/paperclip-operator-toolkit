#!/usr/bin/env python3
"""Acceptance tests for Land #941: shared config/deploy checks.

Paired with PR TogetherWeOwn/paperclip-ops-tooling#941, which adds one
stdlib checker (wrangler, compose, env-contract, workflow-lint and
required-check rules), one reusable workflow, one caller template and
one org ruleset template in the private repo. Every one of those files
is public-able, so the repo-placement gate requires the mirror to live
in THIS public repo: the checker at the root as config_deploy_check.py
(exercised here) and the staged org drop under
templates/org-github/config-deploy/ (pinned by
test_config_deploy_placement.sh).

This suite covers the checker's documented contract plus the landing
risks its own in-PR suite does not: fail-closed behaviour on
non-object JSON (a gate must report a finding, never crash), the
wrangler `main` existence rule, JSONC strings that merely look like
comments, docker/local action pins, and the CLI exit-code contract
(0 clean, 1 findings in error mode, 2 nothing measured).

RED (before the fix): config_deploy_check is absent from this repo, so
the import fails -- the placement risk reproduced. GREEN (after): the
Builder mirrors the checker on this branch without touching test
files. One behaviour per test; docstrings name the production change
that makes each test fail. Stdlib only; no network, no clock.
"""
import contextlib
import io
import json
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config_deploy_check as cdc  # noqa: E402

SHA = "11d5960a326750d5838078e36cf38b85af677262"  # any 40-hex action pin


def write(root, rel, body):
    p = Path(root) / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(textwrap.dedent(body), encoding="utf-8")
    return p


def codes(root):
    return [f.code for f in cdc.check_tree(root)]


def token(*fragments):
    # Token-shaped values are assembled at runtime from split non-secret
    # fragments, so no contiguous token-shaped literal exists in this
    # source for scanners to flag while the detector must still fire.
    return "".join(fragments)


class WranglerTest(unittest.TestCase):
    def test_jsonc_comments_and_trailing_comma_pass(self):
        """Fails if JSONC comment/trailing-comma tolerance is dropped."""
        with tempfile.TemporaryDirectory() as d:
            write(d, "wrangler.jsonc", """\
                {
                  /* staging worker */
                  "name": "worker-staging",
                  "compatibility_date": "2026-01-01",
                }
                """)
            self.assertEqual(codes(d), [])

    def test_jsonc_url_inside_string_is_not_a_comment(self):
        """Fails if // inside a string literal is stripped as a comment."""
        with tempfile.TemporaryDirectory() as d:
            write(d, "wrangler.jsonc", """\
                {
                  "name": "worker",
                  "compatibility_date": "2026-01-01",
                  "vars": {"API_URL": "https://example.com"}
                }
                """)
            write(d, ".env.example", "API_URL=\n")
            self.assertEqual(codes(d), [])

    def test_whitespace_only_name_fails(self):
        """Fails if a blank-but-present wrangler name is accepted."""
        with tempfile.TemporaryDirectory() as d:
            write(d, "wrangler.json",
                  '{"name": "   ", "compatibility_date": "2026-01-01"}\n')
            self.assertIn("WRANGLER_NAME", codes(d))

    def test_missing_compat_date_fails(self):
        """Fails if an absent compatibility_date is accepted."""
        with tempfile.TemporaryDirectory() as d:
            write(d, "wrangler.json", '{"name": "x"}\n')
            self.assertIn("WRANGLER_COMPAT_DATE", codes(d))

    def test_missing_main_file_fails(self):
        """Fails if a wrangler `main` pointing nowhere is accepted."""
        with tempfile.TemporaryDirectory() as d:
            write(d, "wrangler.json",
                  '{"name": "x", "compatibility_date": "2026-01-01",'
                  ' "main": "src/gone.ts"}\n')
            self.assertIn("WRANGLER_MAIN", codes(d))

    def test_existing_main_file_passes(self):
        """Fails if an existing wrangler `main` file is flagged."""
        with tempfile.TemporaryDirectory() as d:
            write(d, "wrangler.json",
                  '{"name": "x", "compatibility_date": "2026-01-01",'
                  ' "main": "src/index.ts"}\n')
            write(d, "src/index.ts", "export default {}\n")
            self.assertEqual(codes(d), [])

    def test_non_object_wrangler_document_fails_closed(self):
        """Fails if a non-object wrangler document crashes the checker.

        A fail-closed gate must turn `[1, 2]` into a finding with the
        documented exit path, never an exception escaping check_tree.
        """
        with tempfile.TemporaryDirectory() as d:
            write(d, "wrangler.json", "[1, 2]\n")
            got = codes(d)
            self.assertTrue(
                any(c.startswith("WRANGLER_") for c in got),
                f"expected a WRANGLER_* finding, got {got}",
            )


class ComposeTest(unittest.TestCase):
    def test_quoted_latest_image_fails(self):
        """Fails if quoting an image hides a mutable :latest tag."""
        with tempfile.TemporaryDirectory() as d:
            write(d, "docker-compose.yaml", """\
                services:
                  app:
                    image: "myapp:latest"
                """)
            self.assertIn("COMPOSE_PIN", codes(d))

    def test_latest_with_digest_passes(self):
        """Fails if :latest pinned by digest is flagged."""
        with tempfile.TemporaryDirectory() as d:
            write(d, "compose.yaml", """\
                services:
                  app:
                    image: myapp:latest@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
                """)
            self.assertEqual(codes(d), [])

    def test_latest_image_with_trailing_comment_fails(self):
        """Fails if a YAML comment after an image hides a mutable tag.

        `image: redis:latest # TODO pin` must still report COMPOSE_PIN;
        a trailing comment is common and must not disable the check.
        """
        with tempfile.TemporaryDirectory() as d:
            write(d, "docker-compose.yml", """\
                services:
                  app:
                    image: redis:latest # TODO pin
                """)
            self.assertIn("COMPOSE_PIN", codes(d))


class EnvContractTest(unittest.TestCase):
    def test_env_sample_is_also_checked(self):
        """Fails if .env.sample escapes the key-shape rule."""
        with tempfile.TemporaryDirectory() as d:
            write(d, ".env.sample", "lower_key=\n")
            self.assertIn("ENV_KEY_SHAPE", codes(d))

    def test_digit_leading_key_fails(self):
        """Fails if a key that cannot be a shell identifier is accepted."""
        with tempfile.TemporaryDirectory() as d:
            write(d, ".env.example", "1ST_KEY=\n")
            self.assertIn("ENV_KEY_SHAPE", codes(d))

    def test_comment_and_blank_lines_are_ignored(self):
        """Fails if example-file comments are parsed as keys."""
        with tempfile.TemporaryDirectory() as d:
            write(d, ".env.example", "# lower=not-a-key\n\nVALID_KEY_2=\n")
            self.assertEqual(codes(d), [])

    def test_aws_shaped_value_fails(self):
        """Fails if an AWS-key-shaped value in an example is accepted."""
        synthetic = token("AK", "IA", "IOSFODNN7", "EXAMPLE")
        with tempfile.TemporaryDirectory() as d:
            write(d, ".env.example", f"AWS_ACCESS_KEY_ID={synthetic}\n")
            self.assertIn("ENV_SECRET_VALUE", codes(d))

    def test_private_key_shaped_value_fails(self):
        """Fails if a private-key header value in an example is accepted."""
        synthetic = token("BEGIN ", "RSA ", "PRIVATE ", "KEY")
        with tempfile.TemporaryDirectory() as d:
            write(d, ".env.example", f"DEPLOY_KEY={synthetic}\n")
            self.assertIn("ENV_SECRET_VALUE", codes(d))

    def test_invalid_utf8_env_example_does_not_crash(self):
        """Fails if invalid UTF-8 in .env.example crashes the checker.

        A fail-closed gate must degrade to findings (or a clean key
        list), never raise UnicodeDecodeError out of check_tree.
        """
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / ".env.example").write_bytes(b"VALID_KEY=\xff\xfe\n")
            got = codes(d)
            self.assertIsInstance(got, list)

    def test_no_example_file_means_no_contract_finding(self):
        """Pins current scope: vars are cross-checked only when an
        example file exists to declare them in."""
        with tempfile.TemporaryDirectory() as d:
            write(d, "wrangler.json",
                  '{"name": "x", "compatibility_date": "2026-01-01",'
                  ' "vars": {"FOO": "bar"}}\n')
            self.assertNotIn("ENV_CONTRACT", codes(d))


class WorkflowLintTest(unittest.TestCase):
    WF = """\
        name: CI
        on: [push]
        jobs:
          test:
            runs-on: ubuntu-latest
            timeout-minutes: 5
            steps:
              - uses: {uses}
        """

    def _codes_for_uses(self, uses):
        with tempfile.TemporaryDirectory() as d:
            write(d, ".github/workflows/ci.yml", self.WF.format(uses=uses))
            return codes(d)

    def test_local_action_passes(self):
        """Fails if a same-repo ./ action is demanded to carry a SHA."""
        self.assertEqual(self._codes_for_uses("./.github/actions/setup"), [])

    def test_docker_action_without_digest_fails(self):
        """Fails if a docker:// action on a moving tag is accepted."""
        got = self._codes_for_uses("docker://alpine:3.8")
        self.assertIn("WORKFLOW_ACTION_PIN", got)

    def test_docker_action_with_digest_passes(self):
        """Fails if a digest-pinned docker:// action is flagged."""
        digest = "docker://alpine@sha256:" + "a" * 64
        self.assertEqual(self._codes_for_uses(digest), [])

    def test_empty_uses_fails(self):
        """Fails if an empty uses: value is silently skipped."""
        self.assertIn("WORKFLOW_ACTION_PIN", self._codes_for_uses(""))

    def test_sha_pin_with_version_comment_passes(self):
        """Fails if the conventional '# v4' pin comment breaks parsing."""
        got = self._codes_for_uses(f"actions/checkout@{SHA} # v4")
        self.assertEqual(got, [])

    def test_subpath_action_sha_pin_passes(self):
        """Fails if owner/repo/subpath@sha actions are rejected."""
        got = self._codes_for_uses(f"github/codeql-action/init@{SHA}")
        self.assertEqual(got, [])

    def test_commented_out_uses_is_ignored(self):
        """Fails if a commented-out unpinned step is flagged."""
        with tempfile.TemporaryDirectory() as d:
            write(d, ".github/workflows/ci.yml", """\
                name: CI
                on: [push]
                jobs:
                  test:
                    runs-on: ubuntu-latest
                    timeout-minutes: 5
                    steps:
                      # - uses: actions/checkout@v4
                      - uses: actions/checkout@PIN
                """.replace("PIN", SHA))
            self.assertEqual(codes(d), [])

    def test_only_the_regular_job_needs_a_timeout(self):
        """Fails if caller-job exemption swallows a regular job, or a
        reusable-workflow caller job is demanded to carry a timeout."""
        with tempfile.TemporaryDirectory() as d:
            write(d, ".github/workflows/ci.yml", """\
                name: CI
                on: [push]
                jobs:
                  caller:
                    uses: TogetherWeOwn/paperclip-ops-tooling/.github/workflows/config-deploy.yml@PIN
                  regular:
                    runs-on: ubuntu-latest
                    steps:
                      - uses: actions/checkout@PIN
                """.replace("PIN", SHA))
            self.assertEqual(codes(d).count("WORKFLOW_TIMEOUT"), 1)

    def test_step_level_uses_does_not_exempt_job_from_timeout(self):
        """Fails if a step-level uses: exempts a regular job from
        WORKFLOW_TIMEOUT. Only a job-level reusable-workflow call
        (a job with no runs-on/steps of its own) is exempt, because
        such a caller job cannot carry timeout-minutes; a normal job
        that merely runs an action step can, and must."""
        with tempfile.TemporaryDirectory() as d:
            write(d, ".github/workflows/ci.yml", """\
                name: CI
                on: [push]
                jobs:
                  regular:
                    runs-on: ubuntu-latest
                    steps:
                      - name: Checkout
                        uses: actions/checkout@PIN
                """.replace("PIN", SHA))
            self.assertIn("WORKFLOW_TIMEOUT", codes(d))

    def test_commented_job_header_does_not_hide_missing_timeout(self):
        """Fails if a trailing comment on a job header merges its block
        into the previous job. build has no timeout and must still flag
        WORKFLOW_TIMEOUT when lint's header carries a `# fast lane`
        comment."""
        with tempfile.TemporaryDirectory() as d:
            write(d, ".github/workflows/ci.yml", """\
                name: CI
                on: [push]
                jobs:
                  build:
                    runs-on: ubuntu-latest
                    steps:
                      - uses: actions/checkout@PIN
                  lint: # fast lane
                    runs-on: ubuntu-latest
                    timeout-minutes: 5
                    steps:
                      - uses: actions/checkout@PIN
                """.replace("PIN", SHA))
            self.assertIn("WORKFLOW_TIMEOUT", codes(d))

    def test_nonstandard_job_indent_with_timeout_passes(self):
        """Fails if a valid 4-space job timeout is not recognized."""
        with tempfile.TemporaryDirectory() as d:
            write(d, ".github/workflows/ci.yml", """\
                name: CI
                on: [push]
                jobs:
                    test:
                        runs-on: ubuntu-latest
                        timeout-minutes: 5
                        steps:
                            - uses: actions/checkout@PIN
                """.replace("PIN", SHA))
            self.assertNotIn("WORKFLOW_TIMEOUT", codes(d))

    def test_four_space_workflow_call_is_recognized(self):
        """Fails if a reusable workflow at four-space indentation is
        mistaken for a direct workflow and bare contexts accepted."""
        with tempfile.TemporaryDirectory() as d:
            write(d, "required_checks.json", json.dumps({"required": [{"context": "config-deploy"}]}))
            write(d, ".github/workflows/caller.yml", """\
                name: caller
                on:
                    workflow_call:
                jobs:
                    config-deploy:
                        uses: TogetherWeOwn/shared/.github/workflows/deploy.yml@PIN
                """.replace("PIN", SHA))
            self.assertIn("REQUIRED_CHECK_MISSING", codes(d))

    def test_four_space_reusable_caller_does_not_require_timeout(self):
        """Fails if the parser cannot recognize a four-space job-level uses."""
        with tempfile.TemporaryDirectory() as d:
            write(d, ".github/workflows/caller.yml", """\
                name: caller
                on: [push]
                jobs:
                    config-deploy:
                        uses: TogetherWeOwn/shared/.github/workflows/deploy.yml@PIN
                """.replace("PIN", SHA))
            self.assertNotIn("WORKFLOW_TIMEOUT", codes(d))

    def test_jobs_key_without_readable_jobs_fails_closed(self):
        """Fails if `jobs:` with no parseable headers reports clean."""
        with tempfile.TemporaryDirectory() as d:
            write(d, ".github/workflows/ci.yml", """\
                name: CI
                on: [push]
                jobs:
                  # jobs to be added
                """)
            self.assertIn("WORKFLOW_PARSE", codes(d))


class RequiredCheckTest(unittest.TestCase):
    def test_unparseable_required_checks_fails_closed(self):
        """Fails if broken required_checks.json is reported clean."""
        with tempfile.TemporaryDirectory() as d:
            write(d, "required_checks.json", "{not json\n")
            self.assertIn("REQUIRED_CHECKS_PARSE", codes(d))

    def test_non_object_required_checks_fails_closed(self):
        """Fails if a non-object required_checks.json crashes the
        checker instead of producing a parse finding."""
        with tempfile.TemporaryDirectory() as d:
            write(d, "required_checks.json", "[1]\n")
            self.assertIn("REQUIRED_CHECKS_PARSE", codes(d))

    def test_required_not_a_list_fails_closed(self):
        """Fails if `"required": "ci-ok"` silently means no requirements.

        A malformed shape must not read as an empty contract: the
        ruleset would then require a check nothing was checked against.
        """
        with tempfile.TemporaryDirectory() as d:
            write(d, "required_checks.json", '{"required": "ci-ok"}')
            self.assertIn("REQUIRED_CHECKS_PARSE", codes(d))

    def test_display_name_with_spaces_is_a_producer(self):
        """Fails if a job display name containing spaces cannot satisfy
        a required context (GitHub reports the display name)."""
        with tempfile.TemporaryDirectory() as d:
            write(d, "required_checks.json",
                  json.dumps({"required": [{"context": "Private gates"}]}))
            write(d, ".github/workflows/ci.yaml", """\
                name: CI
                on: [push]
                jobs:
                  gates:
                    name: Private gates
                    runs-on: ubuntu-latest
                    timeout-minutes: 5
                    steps:
                      - uses: actions/checkout@PIN
                """.replace("PIN", SHA))
            self.assertEqual(codes(d), [])


    def test_malformed_required_entries_fail_closed(self):
        """Fails if a malformed required entry is silently dropped.

        Entries must be objects with a non-empty string context.
        Silently filtering a bad entry out would shrink the contract
        while the gate still reports clean, so every shape below must
        produce REQUIRED_CHECKS_PARSE, never a crash or a pass.
        """
        payloads = [
            '{"required": [42]}',
            '{"required": ["config-deploy / config-deploy"]}',
            '{"required": [{}]}',
            '{"required": [{"name": "config-deploy"}]}',
            '{"required": [{"context": 42}]}',
            '{"required": [{"context": true}]}',
            '{"required": [{"context": null}]}',
            '{"required": [{"context": ""}]}',
            '{"required": [{"context": "   "}]}',
        ]
        for payload in payloads:
            with self.subTest(payload=payload):
                with tempfile.TemporaryDirectory() as d:
                    write(d, "required_checks.json", payload + "\n")
                    self.assertIn("REQUIRED_CHECKS_PARSE", codes(d))

    def _codes_with_required(self, contexts, workflows):
        with tempfile.TemporaryDirectory() as d:
            write(d, "required_checks.json",
                  json.dumps({"required": [{"context": c} for c in contexts]}))
            for rel, body in workflows.items():
                write(d, rel, body.replace("PIN", SHA))
            return codes(d)

    REUSABLE_TREE = {
        ".github/workflows/caller.yml": """\
            name: config-deploy
            on: [push]
            jobs:
              config-deploy:
                uses: TogetherWeOwn/.github/.github/workflows/config-deploy.yml@PIN
            """,
        ".github/workflows/config-deploy.yml": """\
            name: config-deploy
            on:
              workflow_call:
            jobs:
              config-deploy:
                name: config-deploy
                runs-on: ubuntu-latest
                timeout-minutes: 5
                steps:
                  - uses: actions/checkout@PIN
            """,
    }

    def test_reusable_workflow_context_matches_produced_check(self):
        """Fails if the produced check for a reusable-workflow call is
        not `<caller job> / <called job>`: GitHub reports exactly
        `config-deploy / config-deploy` for this tree, so requiring
        that exact context must produce no REQUIRED_CHECK_* finding."""
        got = self._codes_with_required(
            ["config-deploy / config-deploy"], self.REUSABLE_TREE)
        self.assertFalse(
            [c for c in got if c.startswith("REQUIRED_CHECK")],
            f"expected no REQUIRED_CHECK_* finding, got {got}",
        )

    def test_bare_context_does_not_match_reusable_produced_check(self):
        """Fails if the bare `config-deploy` is accepted as the check
        a reusable-workflow call produces. The produced context is the
        composite `config-deploy / config-deploy`; a ruleset naming
        only the bare name requires a check nothing produces."""
        got = self._codes_with_required(["config-deploy"], self.REUSABLE_TREE)
        self.assertIn("REQUIRED_CHECK_MISSING", got)

    DUAL_TRIGGER_TREE = {
        ".github/workflows/ci.yml": """\
            name: CI
            on:
              pull_request:
              workflow_call:
            jobs:
              test:
                runs-on: ubuntu-latest
                timeout-minutes: 5
                steps:
                  - uses: actions/checkout@PIN
            """,
    }

    def test_dual_trigger_workflow_still_produces_bare_context(self):
        """Fails if a workflow triggered by both pull_request and
        workflow_call is treated as caller-only. On PRs GitHub still
        reports the bare job name, so requiring `test` must produce no
        REQUIRED_CHECK_* finding."""
        got = self._codes_with_required(["test"], self.DUAL_TRIGGER_TREE)
        self.assertFalse(
            [c for c in got if c.startswith("REQUIRED_CHECK")],
            f"expected no REQUIRED_CHECK_* finding, got {got}",
        )

    MATRIX_TREE = {
        ".github/workflows/ci.yml": """\
            name: CI
            on: [push]
            jobs:
              build:
                runs-on: ubuntu-latest
                timeout-minutes: 5
                strategy:
                  matrix:
                    os:
                      - ubuntu-latest
                      - windows-latest
                steps:
                  - uses: actions/checkout@PIN
            """,
    }

    def test_matrix_contexts_match_produced_job_checks(self):
        """Fails if matrix-expanded contexts are not produced checks:
        GitHub reports `build (ubuntu-latest)` and
        `build (windows-latest)` for this job, so requiring both must
        produce no REQUIRED_CHECK_* finding."""
        got = self._codes_with_required(
            ["build (ubuntu-latest)", "build (windows-latest)"],
            self.MATRIX_TREE)
        self.assertFalse(
            [c for c in got if c.startswith("REQUIRED_CHECK")],
            f"expected no REQUIRED_CHECK_* finding, got {got}",
        )

    def test_bare_job_id_does_not_match_matrix_produced_checks(self):
        """Fails if the bare job id is accepted as a matrix job's
        check: every produced context carries its matrix values, so
        requiring `build` alone names a check nothing produces."""
        got = self._codes_with_required(["build"], self.MATRIX_TREE)
        self.assertIn("REQUIRED_CHECK_MISSING", got)


class MeasuredAndExitTest(unittest.TestCase):
    def test_measured_files_covers_every_documented_kind(self):
        """Fails if a documented file kind stops being measured, which
        would silently shrink the gate while it still reports clean."""
        with tempfile.TemporaryDirectory() as d:
            for rel in ("wrangler.json", "compose.yaml", ".env.sample",
                        "required_checks.json", ".github/workflows/a.yaml"):
                write(d, rel, "{}\n")
            names = {Path(p).name for p in cdc.measured_files(d)}
            self.assertEqual(
                names,
                {"wrangler.json", "compose.yaml", ".env.sample",
                 "required_checks.json", "a.yaml"},
            )

    def _main(self, root, mode="error"):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = cdc.main(["--root", str(root), "--mode", mode])
        return rc, out.getvalue() + err.getvalue()

    def test_empty_tree_exits_2_never_clean(self):
        """Fails if an unmeasured tree can report clean (hub false green)."""
        with tempfile.TemporaryDirectory() as d:
            rc, _ = self._main(d)
            self.assertEqual(rc, 2)

    def test_clean_tree_exits_0(self):
        """Fails if a measured clean tree does not exit 0."""
        with tempfile.TemporaryDirectory() as d:
            write(d, "wrangler.json",
                  '{"name": "x", "compatibility_date": "2026-01-01"}\n')
            rc, _ = self._main(d)
            self.assertEqual(rc, 0)

    def test_findings_exit_1_in_error_mode_0_in_warn_mode(self):
        """Fails if error mode stops failing, or warn mode starts to."""
        with tempfile.TemporaryDirectory() as d:
            write(d, "wrangler.json", '{"compatibility_date": "2026-01-01"}\n')
            rc_error, out = self._main(d, "error")
            rc_warn, _ = self._main(d, "warn")
            self.assertEqual((rc_error, rc_warn), (1, 0))
            self.assertIn("WRANGLER_NAME", out)

    def test_check_tree_is_deterministic(self):
        """Fails if finding order/content varies between runs on one tree."""
        with tempfile.TemporaryDirectory() as d:
            write(d, "wrangler.json", '{"compatibility_date": "nope"}\n')
            write(d, "docker-compose.yml", "services:\n  a:\n    image: x:latest\n")
            first = [(f.code, f.file, f.level) for f in cdc.check_tree(d)]
            second = [(f.code, f.file, f.level) for f in cdc.check_tree(d)]
            self.assertEqual(first, second)
            self.assertTrue(all(level == "error" for _, _, level in first))


if __name__ == "__main__":
    unittest.main()
