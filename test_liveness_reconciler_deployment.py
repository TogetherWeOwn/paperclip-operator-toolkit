#!/usr/bin/env python3

from __future__ import annotations

import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parent
SERVICE = ROOT / "systemd" / "paperclip-liveness-reconciler.service"
TIMER = ROOT / "systemd" / "paperclip-liveness-reconciler.timer"
INSTALLER = ROOT / "systemd" / "install-liveness-reconciler.sh"
DOC = ROOT / "docs" / "liveness-reconciler.md"


class DeploymentContract(unittest.TestCase):
    def test_installer_requires_literal_commit_and_reviewed_bundle(self):
        source = INSTALLER.read_text()
        self.assertIn('[[ "$SOURCE_REF" =~ ^[0-9a-f]{40}$ ]]', source)
        self.assertIn('[[ -n "$BUNDLE" && -f "$BUNDLE" ]]', source)
        self.assertIn('[[ "$(<"$WORK_DIR/REVISION")" == "$SOURCE_REF" ]]', source)
        self.assertIn('/usr/bin/sha256sum --check --strict SHA256SUMS', source)

    def test_installer_never_reads_git_or_mutable_checkout_as_root(self):
        source = INSTALLER.read_text()
        self.assertNotIn('git ', source)
        self.assertNotIn('git\n', source)
        self.assertNotIn('cp liveness_reconciler.py', source)
        self.assertIn('/usr/bin/tar --extract --file "$BUNDLE"', source)

    def test_unprivileged_builder_archives_installer_and_payload_from_reviewed_commit(self):
        source = (ROOT / "systemd" / "build-liveness-reconciler-bundle.sh").read_text()
        self.assertIn('source_type=$(git --no-replace-objects cat-file -t "$SOURCE_REF"', source)
        self.assertIn('[[ "$source_type" == commit ]]', source)
        self.assertIn('systemd/install-liveness-reconciler.sh', source)
        self.assertIn('git --no-replace-objects archive --format=tar "$SOURCE_REF"', source)
        self.assertIn('sha256sum "${files[@]}" REVISION > SHA256SUMS', source)

    def test_installer_never_targets_root_user_manager(self):
        source = INSTALLER.read_text()
        executable_lines = [line for line in source.splitlines() if not line.startswith("printf ")]
        self.assertFalse(any("systemctl --user" in line for line in executable_lines))
        self.assertIn("next: as %s, run systemctl --user daemon-reload", source)

    def test_installer_checks_every_hardcoded_runtime_executable(self):
        source = INSTALLER.read_text()
        for executable in ("/usr/bin/test", "/usr/bin/sha256sum", "/usr/bin/python3", "/usr/bin/timeout", "/usr/local/bin/node"):
            self.assertIn(executable, source)
            self.assertIn('[[ -x "$executable" ]]', source)

    def test_unit_executes_versioned_installed_release_not_checkout(self):
        source = SERVICE.read_text()
        self.assertNotIn("PAPERCLIP_TOOLING_DIR", source)
        executable_lines = "\n".join(
            line for line in source.splitlines()
            if line.startswith(("WorkingDirectory=", "ExecStartPre=", "ExecStart="))
        )
        self.assertNotIn("/paperclip/instances/", executable_lines)
        self.assertGreaterEqual(source.count("/usr/local/libexec/paperclip-liveness-reconciler/@SOURCE_REF@/"), 6)

    def test_unit_verifies_release_hashes_before_credential_preflight(self):
        source = SERVICE.read_text()
        preflights = [line for line in source.splitlines() if line.startswith("ExecStartPre=")]
        checksum_lines = [i for i, line in enumerate(preflights) if "/usr/bin/sha256sum --check --strict" in line]
        credential_lines = [i for i, line in enumerate(preflights) if "--check-service-credential" in line]
        self.assertEqual(len(checksum_lines), 1)
        self.assertEqual(len(credential_lines), 1)
        self.assertLess(checksum_lines[0], credential_lines[0])

    def test_unit_runs_exact_read_only_credential_preflight(self):
        source = SERVICE.read_text()
        lines = [line for line in source.splitlines() if line.startswith("ExecStartPre=")]
        matches = [line for line in lines if "--check-service-credential" in line]
        self.assertEqual(len(matches), 1)
        command = matches[0]
        self.assertTrue(command.startswith("ExecStartPre=/usr/bin/python3 /usr/local/libexec/paperclip-liveness-reconciler/@SOURCE_REF@/liveness_reconciler.py "))
        self.assertIn("--preflight-issue-id ${PAPERCLIP_PREFLIGHT_ISSUE_ID}", command)
        self.assertIn("--preflight-agent-id ${PAPERCLIP_PREFLIGHT_AGENT_ID}", command)
        self.assertNotIn("/usr/bin/true", command)
        self.assertNotIn("#", command)

    def test_unit_prechecks_node_and_timeout_paths(self):
        source = SERVICE.read_text()
        self.assertIn("ExecStartPre=/usr/bin/test -x /usr/local/bin/node", source)
        self.assertIn("ExecStartPre=/usr/bin/test -x /usr/bin/timeout", source)

    def test_timeout_start_sec_covers_preflight_and_oneshot(self):
        source = SERVICE.read_text()
        self.assertRegex(source, r"(?m)^TimeoutStartSec=5m$")

    def test_execstart_retains_bounded_native_first_apply(self):
        source = SERVICE.read_text()
        exec_start = re.search(r"(?m)^ExecStart=(.+)$", source).group(1)
        for token in (" 4m ", " --apply ", "--retry-limit 1"):
            self.assertIn(token, exec_start)
        self.assertNotIn("--claim-command", exec_start)
        self.assertNotIn("liveness_reconciler_claim.py", exec_start)

    def test_repair_cap_is_operator_settable_without_editing_a_root_unit(self):
        # The first live cycle on a new host must be able to run provably
        # incapable of a write (--max-repairs 0). If the cap is baked into the
        # root-owned unit, the operator's only route is editing installed bytes,
        # which breaks the sha256 chain the installer exists to enforce.
        source = SERVICE.read_text()
        exec_start = re.search(r"(?m)^ExecStart=(.+)$", source).group(1)
        self.assertIn("--max-repairs ${PAPERCLIP_RECONCILER_MAX_REPAIRS}", exec_start)
        self.assertNotRegex(exec_start, r"--max-repairs\s+\d")

    def test_unset_repair_cap_defaults_to_zero_not_an_empty_argument(self):
        # systemd expands an unset variable to nothing, which would silently
        # feed --retry-limit's value to --max-repairs. The unit must carry its
        # own safe default, declared before the operator's EnvironmentFile so
        # the env file still wins.
        source = SERVICE.read_text()
        self.assertRegex(source, r"(?m)^Environment=PAPERCLIP_RECONCILER_MAX_REPAIRS=0$")
        # Compare directive lines only -- a comment mentioning EnvironmentFile=
        # must not be mistaken for the directive itself.
        directives = [
            line for line in source.splitlines() if line and not line.startswith("#")
        ]
        default_at = next(
            i for i, line in enumerate(directives)
            if line.startswith("Environment=PAPERCLIP_RECONCILER_MAX_REPAIRS=")
        )
        env_file_at = next(
            i for i, line in enumerate(directives) if line.startswith("EnvironmentFile=")
        )
        self.assertLess(default_at, env_file_at)

    def test_no_writable_home_path_contradicts_protect_home(self):
        # ProtectHome=read-only makes any ReadWritePaths under %h a start-time
        # failure. Nothing writes state today, so the unit must not declare one.
        source = SERVICE.read_text()
        self.assertIn("ProtectHome=read-only", source)
        directives = [line for line in source.splitlines() if line.startswith("ReadWritePaths=")]
        self.assertEqual([d for d in directives if "%h" in d], [])

    def test_timer_targets_exact_reconciler_service(self):
        source = TIMER.read_text()
        self.assertRegex(source, r"(?m)^Unit=paperclip-liveness-reconciler\.service$")

    def test_timer_retains_interval_jitter_and_persistence(self):
        source = TIMER.read_text()
        for line in ("OnUnitActiveSec=10m", "RandomizedDelaySec=90s", "Persistent=true"):
            self.assertIn(line, source)

    def test_installer_only_requires_executables_it_actually_runs(self):
        # A preflight that refuses on a binary nothing ever invokes turns a
        # cosmetic path difference into a failed install. runuser is checked but
        # never called by the installer or either unit, and Debian ships it in
        # /usr/sbin, so the check refuses a host that would have worked.
        source = INSTALLER.read_text()
        service = SERVICE.read_text()
        timer = TIMER.read_text()
        required = re.findall(r"(?m)^for executable in (.+); do$", source)
        self.assertEqual(len(required), 1)
        # An executable counts as invoked if it appears anywhere outside the
        # requirement loop itself -- as a bare command, inside a pipeline, in a
        # substitution, or in either unit file.
        elsewhere = source.replace(required[0], "", 1)
        for executable in required[0].split():
            invoked = executable in elsewhere or executable in service or executable in timer
            self.assertTrue(invoked, f"{executable} is required but never invoked")

    def test_build_script_is_executable_as_the_docs_invoke_it(self):
        # The doc and the install card both call ./systemd/build-...sh directly.
        # A 0644 mode makes that documented command fail with permission denied.
        builder = ROOT / "systemd" / "build-liveness-reconciler-bundle.sh"
        self.assertTrue(builder.stat().st_mode & 0o111, "build script is not executable")

    def test_rollback_stops_timer_and_active_service_before_removal(self):
        source = DOC.read_text()
        timer_marker = "disable --now paperclip-liveness-reconciler.timer"
        service_marker = "systemctl --user stop paperclip-liveness-reconciler.service"
        removal_marker = "sudo rm -f"
        self.assertIn(timer_marker, source)
        self.assertIn(service_marker, source)
        self.assertIn(removal_marker, source)
        timer = source.index(timer_marker)
        service = source.index(service_marker, timer)
        removal = source.index(removal_marker, service)
        self.assertLess(timer, service)
        self.assertLess(service, removal)


if __name__ == "__main__":
    unittest.main(verbosity=2)
