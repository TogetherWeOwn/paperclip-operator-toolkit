#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import pathlib
import shutil
import socket
import stat
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent
BUNDLE = ROOT / "github-runner"
BUILD = BUNDLE / "build-bundle.sh"
INSTALL = BUNDLE / "install.sh"
VERIFY = BUNDLE / "verify.sh"
FLEET_VERIFY = BUNDLE / "verify-fleet.sh"
REMOVE = BUNDLE / "remove.sh"
UNIT = BUNDLE / "actions-runner.service.in"
PIN = BUNDLE / "actions-runner.env"
DOC = ROOT / "docs" / "private-self-hosted-runner.md"


def run(command: list[str], **kwargs) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, text=True, capture_output=True, **kwargs)


class RunnerBundleContract(unittest.TestCase):
    def test_scripts_are_executable_and_parse(self):
        for script in (BUILD, INSTALL, VERIFY, FLEET_VERIFY, REMOVE):
            self.assertTrue(script.stat().st_mode & stat.S_IXUSR, f"{script} is not executable")
            result = run(["bash", "-n", str(script)])
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_builder_uses_reviewed_commit_and_deterministic_manifest(self):
        source = BUILD.read_text()
        self.assertIn('[[ "$SOURCE_REF" =~ ^[0-9a-f]{40}$ ]]', source)
        self.assertIn('merge-base --is-ancestor "$SOURCE_REF" "$TRUSTED_LINE"', source)
        self.assertIn('git --no-replace-objects archive --format=tar "$SOURCE_REF"', source)
        self.assertIn('github-runner/actions-runner.env', source)
        self.assertIn('github-runner/verify-fleet.sh', source)
        self.assertIn('sha256sum "${files[@]}" REVISION > SHA256SUMS', source)
        self.assertIn("--sort=name --mtime='UTC 1970-01-01'", source)

    def test_runner_archive_is_version_and_checksum_pinned(self):
        source = PIN.read_text()
        self.assertIn("RUNNER_VERSION=2.337.0", source)
        self.assertIn("actions-runner-linux-x64-2.337.0.tar.gz", source)
        self.assertRegex(source, r"(?m)^RUNNER_SHA256=[0-9a-f]{64}$")
        installer = INSTALL.read_text()
        self.assertIn("sha256sum --check --strict", installer)
        self.assertIn("--proto '=https' --tlsv1.2", installer)

    def test_registration_and_removal_tokens_never_use_argv(self):
        for script in (INSTALL, REMOVE):
            source = script.read_text()
            self.assertIn('IFS= read -r token <&3', source)
            self.assertIn('export ACTIONS_RUNNER_INPUT_TOKEN="$token"', source)
            self.assertIn('3<"$TOKEN_FILE"', source)
            self.assertNotIn('--token "$TOKEN"', source)
            self.assertNotIn('ACTIONS_RUNNER_INPUT_TOKEN="$TOKEN"', source)
            self.assertNotIn('TOKEN="$(<"$TOKEN_FILE")"', source)
            self.assertIn('rm -f "$TOKEN_FILE"', source)
        installer = INSTALL.read_text()
        self.assertIn('3<"$ROLLBACK_TOKEN_FILE"', installer)
        self.assertIn('registration and rollback token files must be distinct', installer)
        self.assertNotIn('ACTIONS_RUNNER_INPUT_TOKEN="$ROLLBACK', installer)

    def test_service_is_one_non_root_listener_on_rootless_docker(self):
        source = UNIT.read_text()
        self.assertIn("Environment=HOME=@USER_HOME@", source)
        self.assertNotIn("Environment=HOME=/home/@RUNNER_USER@", source)
        self.assertIn("Environment=XDG_RUNTIME_DIR=/run/user/@RUNNER_UID@", source)
        self.assertIn("DOCKER_HOST=unix:///run/user/@RUNNER_UID@/docker.sock", source)
        self.assertNotIn("/run/user/%U", source)
        self.assertIn("User=@RUNNER_USER@", source)
        self.assertIn("ExecStart=@RUNNER_HOME@/run.sh", source)
        self.assertEqual(source.count("ExecStart=@RUNNER_HOME@/run.sh"), 1)
        self.assertIn("DOCKER_HOST=unix:///run/user/@RUNNER_UID@/docker.sock", source)
        self.assertIn("BindReadOnlyPaths=/dev/null:/run/docker.sock", source)
        self.assertIn("BindReadOnlyPaths=/dev/null:/var/run/docker.sock", source)
        self.assertIn("ExecStartPre=/usr/bin/test ! -w /run/docker.sock", source)
        self.assertIn("ReadWritePaths=@RUNNER_HOME@/_diag @RUNNER_HOME@/_work", source)
        self.assertNotIn("EnvironmentFile=", source)

    def test_installer_models_five_org_runners_with_default_labels(self):
        source = INSTALL.read_text()
        self.assertIn('RUNNER_LABEL="two-selfhosted"', source)
        self.assertIn('RUNNER_GROUP="Default"', source)
        self.assertIn('RUNNER_ROOT="/opt/actions-runners"', source)
        self.assertIn('INSTANCE_ROOT="$SCOPE_ROOT/$RUNNER_NAME"', source)
        self.assertIn('--labels "$RUNNER_LABEL"', source)
        self.assertIn('CONFIG_ARGS+=(--runnergroup "$RUNNER_GROUP")', source)
        self.assertNotIn("--no-default-labels", source)
        self.assertIn("--disableupdate", source)
        self.assertIn('[[ $ALLOW_REPLACE -eq 0 ]] || CONFIG_ARGS+=(--replace)', source)
        self.assertNotIn("--replace\n", source)
        self.assertIn('two-selfhosted || "$RUNNER_LABEL" == isolated', source)

    def test_verifier_rejects_host_docker_socket_and_checks_service(self):
        source = VERIFY.read_text()
        self.assertIn("/var/run/docker.sock", source)
        self.assertIn("/run/docker.sock", source)
        self.assertIn('runuser -u "$RUNNER_USER" -- test -w "$socket_path"', source)
        self.assertIn('BindReadOnlyPaths=/dev/null:/run/docker.sock', source)
        self.assertIn('"$SYSTEMCTL" show "$SERVICE_NAME"', source)
        self.assertIn('[[ -z "$(effective_value DropInPaths)" ]]', source)
        self.assertIn('SupplementaryGroups', source)
        self.assertIn('is-enabled --quiet "$SERVICE_NAME"', source)
        self.assertIn('is-active --quiet "$SERVICE_NAME"', source)
        self.assertIn("RUNTIME_DIR=\"/run/user/$RUNNER_UID\"", source)
        self.assertIn("stat -c '%u' \"$RUNTIME_DIR/docker.sock\"", source)

    def test_fleet_verifier_requires_five_named_listeners_and_reports_headroom(self):
        source = FLEET_VERIFY.read_text()
        self.assertIn('RUNNER_COUNT=5', source)
        self.assertIn('NAME_PREFIX="coolify-vps"', source)
        self.assertIn("'actions.runner.*.service'", source)
        self.assertIn('actual_units', source)
        self.assertIn('RUNNER_USER_PREFIX="gha-runner"', source)
        self.assertIn('"perRunnerConcurrency": 1', source)
        self.assertIn('"fleetConcurrency": runner_count', source)
        self.assertIn('"memoryAvailableBytes"', source)
        self.assertIn('"runnerFilesystemFreeBytes"', source)
        self.assertIn('"$HERE/verify.sh" "${args[@]}"', source)

    def test_removal_order_is_stop_unregister_unit_then_tree(self):
        source = REMOVE.read_text()
        identity = source.index('runner metadata does not match --scope and --runner-name')
        stop = source.index('systemctl disable --now "$SERVICE_NAME"')
        inactive = source.index('systemctl is-active --quiet "$SERVICE_NAME"', stop)
        self.assertLess(identity, stop)
        unregister = source.index('"$RUNNER_HOME/config.sh" remove --unattended', inactive)
        metadata_gone = source.index('[[ ! -e "$RUNNER_HOME/.runner" ]]', unregister)
        unit = source.index('rm -f "$UNIT_PATH"', metadata_gone)
        tree = source.index('rm -rf "$RUNNER_HOME"', unit)
        self.assertLess(stop, inactive)
        self.assertLess(inactive, unregister)
        self.assertLess(unregister, metadata_gone)
        self.assertLess(metadata_gone, unit)
        self.assertLess(unit, tree)

    def test_remover_supports_manual_runner_home_and_fails_closed(self):
        source = REMOVE.read_text()
        self.assertIn('--runner-home) RUNNER_HOME=', source)
        self.assertIn('[[ -x "$RUNNER_HOME/config.sh" ]] || refuse', source)
        self.assertIn('[[ -f "$RUNNER_HOME/.runner" ]] || refuse', source)
        self.assertNotIn('disable --now "$SERVICE_NAME" 2>/dev/null || true', source)
        self.assertIn('--delete-user) DELETE_USER=1', source)
        self.assertNotIn('--keep-user)', source)
        self.assertIn('would break another runner service using $RUNNER_USER', source)
        self.assertIn('runner metadata does not match --scope and --runner-name', source)
        self.assertIn('rm -rf "$INSTANCE_ROOT"', source)
        self.assertNotIn('rm -rf "$RUNNER_ROOT"', source)
        self.assertIn('service drop-in path exists; inspect and remove it explicitly', source)

    def test_installer_snapshots_archive_and_cleans_pre_registration_failures(self):
        source = INSTALL.read_text()
        self.assertIn('install -o root -g root -m 0600 "$ARCHIVE" "$VALIDATED_ARCHIVE"', source)
        self.assertIn('sha256sum --check --strict', source)
        self.assertIn('tar --extract --gzip --file "$VALIDATED_ARCHIVE"', source)
        self.assertIn('[[ ! -e "$INSTANCE_ROOT" && ! -L "$INSTANCE_ROOT" ]]', source)
        self.assertIn('STAGING_DIR="$INSTANCE_ROOT/.staging-$RUNNER_VERSION-$$"', source)
        self.assertIn('if [[ $rc -ne 0 && $REGISTERED -eq 1 ]]', source)
        self.assertIn('ROLLED-BACK: post-registration failure removed the remote registration', source)
        self.assertIn('PARTIAL: automatic deregistration failed', source)
        self.assertIn('"$CURRENT_LINK/config.sh" remove --unattended 3<"$ROLLBACK_TOKEN_FILE"', source)
        self.assertIn('systemctl is-active --quiet "$SERVICE_NAME"', source)
        self.assertIn('runuser -u "$RUNNER_USER" -- test -w /run/docker.sock', source)
        self.assertIn('find "$INSTALL_DIR" -xdev -mindepth 1 -maxdepth 1', source)
        self.assertIn('! -name _work ! -name _diag -exec chown -R root:root {} +', source)

    def test_docs_state_private_allowlist_and_forbidden_secrets(self):
        source = DOC.read_text()
        for required in (
            "seven** organization-scoped runners",
            "per-runner concurrency 1 and total concurrency 7",
            "runs-on: [self-hosted, isolated]",
            "Two runner roles",
            "untrusted fork pull-request code",
            "pinned to a full commit SHA",
            "dynamically mapped service-container ports",
            "/var/run/docker.sock",
            "no host deployment secrets",
            "verify-fleet.sh",
            "--dry-run",
        ):
            self.assertIn(required, source)

    def test_docs_record_the_concurrency_evidence_and_expansion_rule(self):
        """TOG-2677 required the boundary be documented and verified. Keep both halves — the
        authorization and the measured evidence — in the operator doc, not only on the board."""
        source = DOC.read_text()
        for required in (
            "## Concurrency decision record",
            "2026-09-15",
            "The scale-up was authorized.",
            "8 vCPU",
            "22 GB total",
            "51% used",
            "queue depth stays above 4 for a continuous hour",
            "--allow-shared-identity",
            "--listener coolify-vps-1:gha-runner:/home/gha-runner",
        ):
            self.assertIn(required, source)

    def test_expansion_ceiling_is_derived_from_the_longest_jobs_timeout(self):
        """The ceiling is worst-green vs `timeout-minutes` on the longest required check, not
        RAM/disk headroom. A ceiling of eight would push `Offline suites` (99.3 min measured at
        five listeners) to ~159 min against its own 150-min timeout — red checks on a green tree.
        Pin the derivation so a future edit cannot quietly restore the unsafe number."""
        source = DOC.read_text()
        for required in (
            "Six listeners is the ceiling on this host",
            ".github/workflows/ci.yml:490",
            "timeout-minutes: 150",
            "99.3 min on `coolify-vps-2`",
            "exceeds the job's own timeout",
            "Expansion is not a remedy for a deep queue",
        ):
            self.assertIn(required, source)
        self.assertNotIn("eight is the ceiling", source)

    def test_docs_flag_that_the_live_fleet_exceeds_the_documented_ceiling(self):
        """The fleet reached seven while this document sat in review, with no superseding
        evidence record. The doc must say so rather than read as ratification."""
        source = DOC.read_text()
        for required in (
            "The fleet is above its own ceiling.",
            "`coolify-vps-6` and `coolify-vps-7` were added after that measurement",
            "do not treat the seven-listener state as ratified",
        ):
            self.assertIn(required, source)

    def test_dry_runs_are_hermetic_and_do_not_mutate_host_fixture(self):
        with tempfile.TemporaryDirectory() as td:
            work = pathlib.Path(td)
            token = work / "token"
            token.write_text("canary-registration-token\n")
            token.chmod(0o600)
            rollback_token = work / "rollback-token"
            rollback_token.write_text("canary-removal-token\n")
            rollback_token.chmod(0o600)
            archive = work / "missing-until-real-install.tar.gz"
            runner_root = work / "runner"
            systemd_dir = work / "systemd"
            systemd_dir.mkdir()
            import pwd
            user = pwd.getpwuid(os.getuid()).pw_name
            before = self.snapshot(work)

            install_result = run([
                str(INSTALL),
                "--scope-url", "https://github.com/TogetherWeOwn",
                "--runner-name", "fixture-runner",
                "--runner-user", user,
                "--token-file", str(token),
                "--rollback-token-file", str(rollback_token),
                "--archive", str(archive),
                "--runner-root", str(runner_root),
                "--systemd-dir", str(systemd_dir),
                "--dry-run",
            ])
            self.assertEqual(install_result.returncode, 2)
            self.assertIn("--archive must be a regular", install_result.stderr)
            self.assertNotIn("canary-registration-token", install_result.stdout + install_result.stderr)
            self.assertEqual(before, self.snapshot(work))

            remove_result = run([
                str(REMOVE),
                "--scope", "TogetherWeOwn",
                "--runner-name", "fixture-runner",
                "--runner-user", user,
                "--token-file", str(token),
                "--runner-root", str(runner_root),
                "--systemd-dir", str(systemd_dir),
                "--dry-run",
            ])
            self.assertEqual(remove_result.returncode, 0, remove_result.stderr)
            self.assertNotIn("canary-registration-token", remove_result.stdout + remove_result.stderr)
            self.assertTrue(token.exists(), "dry-run removed the token file")
            self.assertEqual(before, self.snapshot(work))

    def test_fleet_verifier_refuses_any_sixth_runner_unit(self):
        with tempfile.TemporaryDirectory() as td:
            work = pathlib.Path(td)
            bundle = work / "github-runner"
            bundle.mkdir()
            fleet_verify = bundle / "verify-fleet.sh"
            shutil.copy2(FLEET_VERIFY, fleet_verify)
            fleet_verify.chmod(0o755)
            instance_verify = bundle / "verify.sh"
            instance_verify.write_text("#!/bin/sh\nexit 0\n")
            instance_verify.chmod(0o755)
            runner_root = work / "runners"
            (runner_root / "TogetherWeOwn").mkdir(parents=True)
            systemd_dir = work / "systemd"
            systemd_dir.mkdir()
            for index in range(1, 6):
                (systemd_dir / f"actions.runner.TogetherWeOwn.coolify-vps-{index}.service").write_text("")
            systemctl = work / "systemctl"
            systemctl.write_text(f'''#!/bin/sh
if [ "$1" = list-units ]; then
  for unit in {systemd_dir}/actions.runner.*.service; do
    name=${{unit##*/}}
    printf '%s loaded active running fixture\\n' "$name"
  done
fi
exit 0
''')
            systemctl.chmod(0o755)
            command = [
                str(fleet_verify),
                "--scope", "TogetherWeOwn",
                "--runner-root", str(runner_root),
                "--systemd-dir", str(systemd_dir),
                "--systemctl", str(systemctl),
            ]
            baseline = run(command)
            self.assertEqual(baseline.returncode, 0, baseline.stdout + baseline.stderr)
            self.assertIn('"fleetConcurrency": 5', baseline.stdout)

            (systemd_dir / "actions.runner.TogetherWeOwn.legacy.service").write_text("")
            extra = run(command)
            self.assertEqual(extra.returncode, 2, extra.stdout + extra.stderr)
            self.assertIn("unit set differs", extra.stderr)
            self.assertIn("legacy.service", extra.stderr)

    def test_verify_happy_path_uses_only_fixture_state(self):
        with tempfile.TemporaryDirectory() as td:
            work = pathlib.Path(td)
            runner_root = work / "runner"
            instance_root = runner_root / "TogetherWeOwn" / "fixture-runner"
            release = instance_root / "2.337.0"
            current = instance_root / "current"
            systemd_dir = work / "systemd"
            fake_bin = work / "bin"
            release.mkdir(parents=True)
            systemd_dir.mkdir()
            fake_bin.mkdir()
            current.symlink_to(release)
            (release / "run.sh").write_text("#!/bin/sh\n")
            (release / "run.sh").chmod(0o755)
            (release / ".runner").write_text(json.dumps({
                "agentName": "fixture-runner",
                "gitHubUrl": "https://github.com/TogetherWeOwn",
                "poolName": "Default",
                "labels": [
                    {"name": "self-hosted"},
                    {"name": "Linux"},
                    {"name": "X64"},
                    {"name": "two-selfhosted"},
                ],
            }))
            import pwd
            user = pwd.getpwuid(os.getuid()).pw_name
            service = systemd_dir / "actions.runner.fixture.service"
            uid = os.getuid()
            service.write_text(UNIT.read_text()
                               .replace("@RUNNER_USER@", user)
                               .replace("@RUNNER_UID@", str(uid))
                               .replace("@USER_HOME@", str(pathlib.Path.home()))
                               .replace("@RUNNER_HOME@", str(current)))
            for path in release.iterdir():
                if path.name not in {".runner", "_work", "_diag"}:
                    path.chmod(path.stat().st_mode & ~0o222)
            systemctl = fake_bin / "systemctl"
            systemctl.write_text(f'''#!/bin/sh
if [ "$1" = show ]; then
cat <<'EOF'
FragmentPath={service}
DropInPaths=
User={user}
Group={user}
SupplementaryGroups=
Environment=HOME={pathlib.Path.home()} XDG_RUNTIME_DIR=/run/user/{uid} DOCKER_HOST=unix:///run/user/{uid}/docker.sock RUNNER_ALLOW_RUNASROOT=0
ExecStart={{ path={current / "run.sh"} ; argv[]={current / "run.sh"} ; }}
ReadWritePaths={current / "_diag"} {current / "_work"}
BindReadOnlyPaths=/dev/null:/run/docker.sock /dev/null:/var/run/docker.sock
MainPID=123
EOF
fi
exit 0
''')
            systemctl.chmod(0o755)

            runtime = work / "runtime"
            runtime.mkdir()
            socket_path = runtime / "docker.sock"
            sock = socket.socket(socket.AF_UNIX)
            try:
                sock.bind(str(socket_path))
                result = run([
                    str(VERIFY),
                    "--scope", "TogetherWeOwn",
                    "--runner-name", "fixture-runner",
                    "--runner-user", user,
                    "--runner-root", str(runner_root),
                    "--service-name", service.name,
                    "--systemd-dir", str(systemd_dir),
                    "--runtime-dir", str(runtime),
                    "--systemctl", str(systemctl),
                ])
            finally:
                sock.close()
                socket_path.unlink(missing_ok=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("github-runner-verify: PASS", result.stdout)

    def fleet_fixture(self, work: pathlib.Path, names: list[str], verify_body: str) -> dict:
        """Build a hermetic fleet fixture and return the arguments common to every audit."""
        bundle = work / "github-runner"
        bundle.mkdir()
        fleet_verify = bundle / "verify-fleet.sh"
        shutil.copy2(FLEET_VERIFY, fleet_verify)
        fleet_verify.chmod(0o755)
        instance_verify = bundle / "verify.sh"
        instance_verify.write_text(verify_body)
        instance_verify.chmod(0o755)
        runner_root = work / "runners"
        (runner_root / "TogetherWeOwn").mkdir(parents=True)
        systemd_dir = work / "systemd"
        systemd_dir.mkdir()
        for name in names:
            (systemd_dir / f"actions.runner.TogetherWeOwn.{name}.service").write_text("")
        systemctl = work / "systemctl"
        systemctl.write_text(f'''#!/bin/sh
if [ "$1" = list-units ]; then
  for unit in {systemd_dir}/actions.runner.*.service; do
    name=${{unit##*/}}
    printf '%s loaded active running fixture\\n' "$name"
  done
fi
exit 0
''')
        systemctl.chmod(0o755)
        return {
            "fleet_verify": fleet_verify,
            "command": [
                str(fleet_verify),
                "--scope", "TogetherWeOwn",
                "--runner-root", str(runner_root),
                "--systemd-dir", str(systemd_dir),
                "--systemctl", str(systemctl),
            ],
        }

    def test_fleet_verifier_audits_the_live_shared_identity_layout(self):
        """The deployed fleet shares one account and has irregular homes. The audit must be
        runnable against it, must name the drift, and must not treat it as normal."""
        names = [f"coolify-vps-{index}" for index in range(1, 6)]
        with tempfile.TemporaryDirectory() as td:
            work = pathlib.Path(td)
            fixture = self.fleet_fixture(work, names, "#!/bin/sh\nexit 0\n")
            homes = [work / "home" / "gha-runner"] + [
                work / "home" / "gha-runner" / f"runner{index}" for index in range(2, 6)
            ]
            for home in homes:
                home.mkdir(parents=True, exist_ok=True)
            live = list(fixture["command"])
            for name, home in zip(names, homes):
                live += ["--listener", f"{name}:gha-runner:{home}"]

            refused = run(live)
            self.assertEqual(refused.returncode, 2, refused.stdout + refused.stderr)
            self.assertIn("github-runner-fleet-isolation: DRIFT", refused.stderr)
            self.assertIn("shared-accounts=[gha-runner]", refused.stderr)
            self.assertIn("listeners share an account", refused.stderr)

            acknowledged = run(live + ["--allow-shared-identity"])
            self.assertEqual(acknowledged.returncode, 0, acknowledged.stdout + acknowledged.stderr)
            self.assertIn("github-runner-fleet-isolation: DRIFT", acknowledged.stderr)
            headroom = json.loads(
                acknowledged.stdout.split("github-runner-fleet-headroom: ", 1)[1].splitlines()[0]
            )
            self.assertEqual(headroom["runnerCount"], 5)
            self.assertEqual(headroom["fleetConcurrency"], 5)
            self.assertEqual(headroom["perRunnerConcurrency"], 1)
            self.assertEqual(headroom["distinctRunnerIdentities"], 1)
            self.assertEqual(headroom["isolationPosture"], "shared-identity")
            self.assertEqual(headroom["runnerFilesystemPath"], str(homes[0]))
            self.assertIn("isolation=shared-identity", acknowledged.stdout)

            # Positive control: the same audit over distinct accounts reports no drift, so the
            # DRIFT verdict above is a property of the fleet and not of this code path.
            isolated = list(fixture["command"])
            for index, (name, home) in enumerate(zip(names, homes), start=1):
                isolated += ["--listener", f"{name}:gha-runner-{index}:{home}"]
            control = run(isolated)
            self.assertEqual(control.returncode, 0, control.stdout + control.stderr)
            self.assertNotIn("DRIFT", control.stdout + control.stderr)
            self.assertIn("github-runner-fleet-isolation: OK", control.stdout)
            self.assertIn("isolation=isolated-identities", control.stdout)

    def test_fleet_verifier_audits_every_listener_before_failing(self):
        """A red listener must not stop the sweep: the operator needs the whole fleet's state."""
        names = [f"coolify-vps-{index}" for index in range(1, 6)]
        with tempfile.TemporaryDirectory() as td:
            work = pathlib.Path(td)
            audit_log = work / "audited"
            fixture = self.fleet_fixture(work, names, f'''#!/bin/sh
while [ $# -gt 0 ]; do
  if [ "$1" = --runner-name ]; then printf '%s\\n' "$2" >> {audit_log}; fi
  shift
done
if tail -n 1 {audit_log} | grep -q coolify-vps-2; then exit 1; fi
exit 0
''')
            result = run(fixture["command"])
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertEqual(audit_log.read_text().split(), names)
            self.assertIn("github-runner-fleet-listener: FAIL coolify-vps-2", result.stderr)
            self.assertIn("failing-listeners=[coolify-vps-2]", result.stderr)
            self.assertIn("github-runner-fleet-headroom: ", result.stdout)
            self.assertNotIn("github-runner-fleet-verify: PASS", result.stdout)

    def test_fleet_verifier_rejects_malformed_listener_arguments(self):
        names = ["coolify-vps-1"]
        with tempfile.TemporaryDirectory() as td:
            work = pathlib.Path(td)
            fixture = self.fleet_fixture(work, names, "#!/bin/sh\nexit 0\n")
            for entry, expected in (
                ("coolify-vps-1", "--listener must be NAME:USER[:HOME]"),
                ("coolify-vps-1:root", "non-root local account"),
                ("coolify-vps-1:gha-runner:relative/home", "--listener home must be absolute"),
                ("bad name:gha-runner", "--listener name contains unsafe characters"),
            ):
                result = run(fixture["command"] + ["--listener", entry])
                self.assertEqual(result.returncode, 2, entry)
                self.assertIn(expected, result.stderr, entry)

            duplicate = run(fixture["command"] + [
                "--listener", "coolify-vps-1:gha-runner-1",
                "--listener", "coolify-vps-1:gha-runner-2",
            ])
            self.assertEqual(duplicate.returncode, 2)
            self.assertIn("--listener names must be unique", duplicate.stderr)

    @staticmethod
    def snapshot(root: pathlib.Path) -> dict[str, tuple[int, bytes | str]]:
        result: dict[str, tuple[int, bytes | str]] = {}
        for path in sorted(root.rglob("*")):
            rel = str(path.relative_to(root))
            mode = stat.S_IMODE(path.lstat().st_mode)
            if path.is_symlink():
                value: bytes | str = os.readlink(path)
            elif path.is_file():
                value = path.read_bytes()
            else:
                value = "directory"
            result[rel] = (mode, value)
        return result


if __name__ == "__main__":
    unittest.main(verbosity=2)
