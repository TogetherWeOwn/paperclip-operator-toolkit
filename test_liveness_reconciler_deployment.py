#!/usr/bin/env python3

from __future__ import annotations

import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent
SERVICE = ROOT / "systemd" / "paperclip-liveness-reconciler.service"
TIMER = ROOT / "systemd" / "paperclip-liveness-reconciler.timer"
INSTALLER = ROOT / "systemd" / "install-liveness-reconciler.sh"
BUILDER = ROOT / "systemd" / "build-liveness-reconciler-bundle.sh"
DOC = ROOT / "docs" / "liveness-reconciler.md"


def installer_source() -> str:
    return INSTALLER.read_text()


def manifest_generation_line(source: str) -> str:
    # The one sha256sum invocation that WRITES a manifest (has a redirect),
    # as opposed to the two --check invocations that read one.
    lines = [
        line for line in source.splitlines()
        if "sha256sum " in line and " > " in line and "--check" not in line
    ]
    assert len(lines) == 1, f"expected one manifest-generation line, got {lines}"
    return lines[0]


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

    def test_builder_refuses_a_commit_not_merged_into_the_trusted_line(self):
        # Reachable is not reviewed. ee6a85be is reachable from four remote
        # branches yet is not an ancestor of main, and building it installs the
        # pre-fix installer. Ancestry of the line review merges into is the
        # property that separates the two; a hash pinned here would rot at the
        # next merge, and a comparison against HEAD would diff the tree with
        # itself and pass anything checked out.
        source = (ROOT / "systemd" / "build-liveness-reconciler-bundle.sh").read_text()
        self.assertIn(
            'git --no-replace-objects merge-base --is-ancestor "$SOURCE_REF" "$TRUSTED_LINE"',
            source,
        )
        self.assertIn('rev-parse -q --verify "$TRUSTED_LINE^{commit}"', source)
        self.assertIn('TRUSTED_LINE="origin/main"', source)

    def test_builder_actually_refuses_to_write_a_bundle_for_an_unmerged_commit(self):
        # The sibling test above asserts the check is PRESENT in the source.
        # That is not the same as the check WORKING: appending `|| true` to the
        # merge-base line leaves every asserted string intact and still builds
        # the unmerged commit. So run the builder and assert on what it does --
        # nonzero exit, and above all NO output file, since a written bundle is
        # the thing that reaches a host.
        #
        # The fixture is built with `git init` rather than by cloning this
        # repo, so it holds under the mutation gate, which copies the tree
        # WITHOUT .git. A skip there would let the mutant survive silently.
        repo = pathlib.Path(__file__).resolve().parent
        builder_src = repo / "systemd" / "build-liveness-reconciler-bundle.sh"
        payload = [
            "liveness_reconciler.py",
            "liveness_reconciler_source.js",
            "systemd/install-liveness-reconciler.sh",
            "systemd/paperclip-liveness-reconciler.service",
            "systemd/paperclip-liveness-reconciler.timer",
        ]

        with tempfile.TemporaryDirectory() as td:
            work = pathlib.Path(td) / "repo"
            (work / "systemd").mkdir(parents=True)
            env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@e",
                   "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@e",
                   "GIT_CONFIG_GLOBAL": str(pathlib.Path(td) / "gitconfig"),
                   "GIT_CONFIG_SYSTEM": os.devnull}

            def git(*a):
                r = subprocess.run(["git", *a], cwd=work, env=env,
                                   capture_output=True, text=True)
                self.assertEqual(r.returncode, 0, f"git {a[0]}: {r.stderr}")
                return r.stdout.strip()

            # The builder under test is the one on disk, not a committed copy.
            shutil.copyfile(builder_src, work / "systemd" / "build-liveness-reconciler-bundle.sh")
            (work / "systemd" / "build-liveness-reconciler-bundle.sh").chmod(0o755)
            # Stub payload: the builder only needs these paths to exist at the
            # commit. Synthesizing them keeps the fixture independent of which
            # files the mutation gate copies into its scratch tree.
            for rel in payload:
                (work / rel).parent.mkdir(parents=True, exist_ok=True)
                (work / rel).write_text(f"stub for {rel}\n")

            git("init", "--quiet", "-b", "trusted")
            git("add", "-A")
            git("commit", "--quiet", "--no-verify", "-m", "trusted line")
            trusted = git("rev-parse", "HEAD")

            # A sibling that is NOT an ancestor of the trusted line -- the
            # shape of a commit that re-adds the same files off the merged line.
            git("checkout", "--quiet", "-b", "sibling", trusted)
            (work / "DIVERGED").write_text("not on the reviewed line\n")
            git("add", "DIVERGED")
            git("commit", "--quiet", "--no-verify", "-m", "diverged sibling")
            unmerged = git("rev-parse", "HEAD")
            git("checkout", "--quiet", "trusted")

            def run(source_ref, out):
                return subprocess.run(
                    [str(work / "systemd" / "build-liveness-reconciler-bundle.sh"),
                     "--source-ref", source_ref, "--trusted-line", "trusted",
                     "--output", str(out)],
                    cwd=work, env=env, capture_output=True, text=True,
                )

            bad = pathlib.Path(td) / "bad.tar"
            refused = run(unmerged, bad)
            self.assertNotEqual(refused.returncode, 0,
                                "builder accepted a commit not on the trusted line")
            self.assertFalse(bad.exists(),
                             "builder wrote a bundle for an unmerged commit")

            # Control: the trusted commit still builds, so the refusal above is
            # the ancestry check and not a builder that refuses everything.
            good = pathlib.Path(td) / "good.tar"
            ok = run(trusted, good)
            self.assertEqual(ok.returncode, 0,
                             f"builder refused the trusted commit: {ok.stderr}")
            self.assertTrue(good.exists(), "builder produced no bundle for a good commit")

    def test_build_script_is_executable_as_the_docs_invoke_it(self):
        # The doc and the install card both call ./systemd/build-...sh directly.
        # A 0644 mode makes that documented command fail with permission denied.
        builder = ROOT / "systemd" / "build-liveness-reconciler-bundle.sh"
        self.assertTrue(builder.stat().st_mode & 0o111, "build script is not executable")

    # TOG-4453: the bundle manifest is bundle-scoped (it lists systemd/*
    # paths so the installer can verify the whole reviewed bundle in
    # WORK_DIR), but the pre-fix installer copied it verbatim into the
    # release directory, which holds only liveness_reconciler.py,
    # liveness_reconciler_source.js, and REVISION. The unit's ExecStartPre
    # `sha256sum --check --strict` then failed on every start with 3
    # FAILED-open-or-read lines, so the timer could never run. (The card
    # prose says 2; the measured repro shows 3 -- the bundle manifest also
    # covers the installer itself.) The fix regenerates a release-scoped
    # manifest from the verified bytes and proves the unit's own check
    # passes before claiming INSTALLED. These tests pin both halves: the
    # installer bytes, and the mechanism itself, executed against a real
    # built bundle.
    def test_installer_verifies_bundle_manifest_before_installing(self):
        # The regenerated release manifest is only as trustworthy as the bytes
        # it is generated from; the bundle-scope check in WORK_DIR is what
        # makes them the reviewed bytes. It must stay ahead of the install.
        source = installer_source()
        self.assertIn('(cd "$WORK_DIR" && /usr/bin/sha256sum --check --strict SHA256SUMS)', source)
        check_at = source.index('(cd "$WORK_DIR"')
        release_at = source.index('RELEASE_DIR="/usr/local/libexec/paperclip-liveness-reconciler/$SOURCE_REF"')
        self.assertLess(check_at, release_at)

    def test_installer_does_not_copy_bundle_manifest_into_release(self):
        # The exact TOG-4453 defect: the bundle manifest lists systemd/*
        # paths that are never installed, so copying it into the release dir
        # breaks the unit's preflight permanently.
        source = installer_source()
        self.assertNotIn('"$WORK_DIR/REVISION" "$WORK_DIR/SHA256SUMS" "$RELEASE_DIR/"', source)
        self.assertNotIn('"$WORK_DIR/SHA256SUMS" "$RELEASE_DIR', source)

    def test_installer_regenerates_release_scoped_manifest(self):
        source = installer_source()
        line = manifest_generation_line(source)
        self.assertIn('(cd "$RELEASE_DIR"', line)
        self.assertIn("/usr/bin/sha256sum liveness_reconciler.py liveness_reconciler_source.js REVISION", line)
        self.assertIn('"$WORK_DIR/SHA256SUMS.release"', line)
        self.assertIn('"$WORK_DIR/SHA256SUMS.release" "$RELEASE_DIR/SHA256SUMS"', source)

    def test_installer_proves_unit_preflight_before_claiming_installed(self):
        # The unit runs `sha256sum --check --strict` in the release dir
        # before every start; the installer must run that same check before
        # printing INSTALLED, so a broken release fails the install, not the
        # first timer tick.
        source = installer_source()
        release_check = '(cd "$RELEASE_DIR" && /usr/bin/sha256sum --check --strict SHA256SUMS)'
        self.assertIn(release_check, source)
        self.assertLess(
            source.index(manifest_generation_line(source)),
            source.index(release_check),
        )
        self.assertLess(
            source.index(release_check),
            source.index("printf 'INSTALLED paperclip-liveness-reconciler"),
        )

    def test_release_manifest_covers_exactly_the_installed_byte_set(self):
        # The invariant TOG-4453 violated: every file installed into the
        # release dir must be covered by the regenerated manifest, and the
        # manifest must cover nothing else (a covered-but-absent path is the
        # FAILED-open-or-read the unit died on).
        source = installer_source()
        # Install-command lines only: "$RELEASE_DIR/__pycache__" appears in a
        # `rm -rf` cleanup line, which removes a file, not installs one.
        install_lines = [line for line in source.splitlines() if "/usr/bin/install " in line]
        installed = set(re.findall(r'"\$RELEASE_DIR/([A-Za-z0-9_.\-]+)"', "\n".join(install_lines)))
        self.assertGreaterEqual(installed, {"liveness_reconciler.py", "liveness_reconciler_source.js", "REVISION", "SHA256SUMS"})
        covered = manifest_generation_line(source).split("sha256sum ", 1)[1].split(" > ", 1)[0].split()
        self.assertEqual(set(covered), installed - {"SHA256SUMS"})

    def test_unit_preflight_checks_installed_release_manifest(self):
        # The other end of the contract: the unit checks the manifest the
        # installer regenerates, in the directory the installer fills.
        source = SERVICE.read_text()
        self.assertIn(
            "WorkingDirectory=/usr/local/libexec/paperclip-liveness-reconciler/@SOURCE_REF@",
            source,
        )
        self.assertIn(
            "ExecStartPre=/usr/bin/sha256sum --check --strict "
            "/usr/local/libexec/paperclip-liveness-reconciler/@SOURCE_REF@/SHA256SUMS",
            source,
        )

    def test_bundle_manifest_still_covers_payload_units_and_installer(self):
        # The fix must narrow the RELEASE manifest, never the BUNDLE one:
        # shrinking the bundle manifest would "fix" the preflight by ceasing
        # to verify the reviewed unit files at all.
        source = BUILDER.read_text()
        for member in (
            "liveness_reconciler.py",
            "liveness_reconciler_source.js",
            "systemd/install-liveness-reconciler.sh",
            "systemd/paperclip-liveness-reconciler.service",
            "systemd/paperclip-liveness-reconciler.timer",
        ):
            self.assertIn(member, source)
        self.assertIn('sha256sum "${files[@]}" REVISION > SHA256SUMS', source)

    def test_old_layout_fails_preflight_and_regenerated_manifest_passes(self):
        # TOG-4453, executed rather than asserted as text: build a real bundle
        # with the real builder, lay out a release dir the way the pre-fix
        # installer did, and watch the unit's ExecStartPre equivalent fail
        # with 3 FAILED-open-or-read lines; then lay it out per the fixed
        # installer and watch it pass.
        #
        # The fixture is built with `git init` rather than by cloning this
        # repo, so it holds wherever the suite runs. The manifest-generation
        # command is read out of the installer under test, not hardcoded
        # here, so this follows the fix instead of duplicating it.
        payload = [
            "liveness_reconciler.py",
            "liveness_reconciler_source.js",
            "systemd/install-liveness-reconciler.sh",
            "systemd/paperclip-liveness-reconciler.service",
            "systemd/paperclip-liveness-reconciler.timer",
        ]
        with tempfile.TemporaryDirectory() as td:
            work = pathlib.Path(td) / "repo"
            (work / "systemd").mkdir(parents=True)
            env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@e",
                   "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@e",
                   "GIT_CONFIG_GLOBAL": str(pathlib.Path(td) / "gitconfig"),
                   "GIT_CONFIG_SYSTEM": os.devnull}

            def git(*a):
                r = subprocess.run(["git", *a], cwd=work, env=env,
                                   capture_output=True, text=True)
                self.assertEqual(r.returncode, 0, f"git {a[0]}: {r.stderr}")
                return r.stdout.strip()

            shutil.copyfile(BUILDER, work / "systemd" / "build-liveness-reconciler-bundle.sh")
            (work / "systemd" / "build-liveness-reconciler-bundle.sh").chmod(0o755)
            # Stub payload: the builder only needs these paths to exist at the
            # commit. sha256sum does not care what the bytes mean.
            for rel in payload:
                (work / rel).parent.mkdir(parents=True, exist_ok=True)
                (work / rel).write_text(f"stub for {rel}\n")

            git("init", "--quiet", "-b", "trusted")
            git("add", "-A")
            git("commit", "--quiet", "--no-verify", "-m", "trusted line")
            trusted = git("rev-parse", "HEAD")

            bundle = pathlib.Path(td) / "bundle.tar"
            built = subprocess.run(
                [str(work / "systemd" / "build-liveness-reconciler-bundle.sh"),
                 "--source-ref", trusted, "--trusted-line", "trusted",
                 "--output", str(bundle)],
                cwd=work, env=env, capture_output=True, text=True,
            )
            self.assertEqual(built.returncode, 0, f"builder failed: {built.stderr}")
            self.assertTrue(bundle.exists(), "builder produced no bundle")

            extract = pathlib.Path(td) / "extract"
            extract.mkdir()
            r = subprocess.run(["tar", "-xf", str(bundle), "-C", str(extract)],
                               capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("systemd/paperclip-liveness-reconciler.service",
                          (extract / "SHA256SUMS").read_text())

            # Pre-fix layout: payload + REVISION + the bundle manifest,
            # copied verbatim into the release dir.
            old = pathlib.Path(td) / "release-old"
            old.mkdir()
            shutil.copyfile(extract / "liveness_reconciler.py", old / "liveness_reconciler.py")
            shutil.copyfile(extract / "liveness_reconciler_source.js", old / "liveness_reconciler_source.js")
            shutil.copyfile(extract / "REVISION", old / "REVISION")
            shutil.copyfile(extract / "SHA256SUMS", old / "SHA256SUMS")
            bad = subprocess.run(["sha256sum", "--check", "--strict", "SHA256SUMS"],
                                 cwd=old, capture_output=True, text=True)
            self.assertNotEqual(bad.returncode, 0,
                                "pre-fix layout unexpectedly passed its own preflight")
            combined = bad.stdout + bad.stderr
            self.assertEqual(combined.count("FAILED open or read"), 3, combined)

            # Fixed layout: payload + REVISION + a manifest regenerated by the
            # installer's own generation command.
            covered = manifest_generation_line(installer_source()
                        ).split("sha256sum ", 1)[1].split(" > ", 1)[0].split()
            new = pathlib.Path(td) / "release-new"
            new.mkdir()
            shutil.copyfile(extract / "liveness_reconciler.py", new / "liveness_reconciler.py")
            shutil.copyfile(extract / "liveness_reconciler_source.js", new / "liveness_reconciler_source.js")
            shutil.copyfile(extract / "REVISION", new / "REVISION")
            gen = subprocess.run(["sha256sum", *covered],
                                 cwd=new, capture_output=True, text=True)
            self.assertEqual(gen.returncode, 0, gen.stderr)
            (new / "SHA256SUMS").write_text(gen.stdout)
            good = subprocess.run(["sha256sum", "--check", "--strict", "SHA256SUMS"],
                                  cwd=new, capture_output=True, text=True)
            self.assertEqual(good.returncode, 0,
                             f"fixed layout failed its own preflight: {good.stdout}{good.stderr}")

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
