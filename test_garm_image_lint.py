#!/usr/bin/env python3
"""Offline regressions: lint text and synthetic archives; never build an image."""
import io
import json
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tarfile
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
LINT = HERE / "garm_image_lint.sh"
DOCKERFILE = HERE / "github-runner/garm/Dockerfile.isolated"
DIGEST = "a" * 64
GOOD = f"""FROM ubuntu:24.04@sha256:{DIGEST}
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates=1.0 && rm -rf /var/lib/apt/lists/*
COPY app /app
USER runner
ENTRYPOINT ["/app/run"]
"""


class ImageLintTests(unittest.TestCase):
    def lint(self, text, expected=0, code=None):
        with tempfile.TemporaryDirectory() as work:
            path = Path(work) / "Dockerfile"
            path.write_text(text)
            result = subprocess.run(["bash", str(LINT), str(path)], capture_output=True,
                                    text=True, env={"PATH": "/usr/bin:/bin"})
        self.assertEqual(result.returncode, expected, result.stderr)
        if code:
            self.assertIn(f"RULE {code} ", result.stderr)
        return result

    def test_checked_in_definition(self):
        self.lint(DOCKERFILE.read_text())

    def test_good_fixture(self):
        self.lint(GOOD)

    def test_root_group_user(self):
        for user in ("root", "0", "root:root", "0:0", "000:runner"):
            with self.subTest(user=user):
                self.lint(GOOD.replace("USER runner", f"USER {user}"), 1, "GARM-USER-02")

    def test_nonroot_group_user(self):
        for user in ("runner:runner", "1001:1001"):
            with self.subTest(user=user):
                self.lint(GOOD.replace("USER runner", f"USER {user}"))

    def test_credential_declarations(self):
        for declaration in ("ARG GH_TOKEN", "ENV GH_TOKEN fixture-only",
                            "ENV NORMAL=value GH_TOKEN=fixture-only",
                            "ENV NORMAL=value \\\n GH_TOKEN=fixture-only", "ARG api_key=fixture-only"):
            with self.subTest(declaration=declaration):
                self.lint(GOOD + declaration + "\n", 1, "GARM-SECRET-07")

    def test_actual_multiline_apt_pins_options_cleanup(self):
        source = DOCKERFILE.read_text()
        for old, new in (("ca-certificates=20240203", "ca-certificates"),
                         ("--no-install-recommends", ""),
                         ("    && rm -rf /var/lib/apt/lists/*", "")):
            with self.subTest(old=old):
                self.assertIn(old, source)
                self.lint(source.replace(old, new), 1, "GARM-APT-04")

    def test_every_install_needs_option(self):
        self.lint(GOOD + "RUN apt-get install -y make=1.0 && rm -rf /var/lib/apt/lists/*\n",
                  1, "GARM-APT-04")

    def test_every_install_needs_cleanup_in_its_layer(self):
        self.lint(GOOD + "RUN apt-get install -y --no-install-recommends make=1.0\n",
                  1, "GARM-APT-04")

    def test_docker_copy(self):
        for instruction in ("COPY docker /usr/local/bin/docker",
                            'COPY ["docker", "/usr/local/bin/docker"]',
                            "COPY payload /usr/local/bin/docker"):
            with self.subTest(instruction=instruction):
                self.lint(GOOD.replace("COPY app /app", instruction), 1, "GARM-PRIV-03")

    def test_piped_installers(self):
        for command in ("curl https://example.com/install.sh | bash",
                        "curl https://example.com/install.sh | /bin/bash",
                        "curl https://example.com/install.sh \\\n | bash",
                        "/usr/bin/wget -O - https://example.com/install.sh | /bin/sh"):
            with self.subTest(command=command):
                self.lint(GOOD + "RUN " + command + "\n", 1, "GARM-FETCH-08")

    def test_exec_json(self):
        for command in ("['/app/run']", '["/app/run",]', '[1]', '["/app/run", null]', "/app/run"):
            with self.subTest(command=command):
                self.lint(GOOD.replace('["/app/run"]', command), 1, "GARM-EXEC-06")

    def test_completed_digest_preserves_operator_marker(self):
        source = DOCKERFILE.read_text()
        self.assertIn("# pinned-at-build:", source)
        self.lint(source.replace("FROM ubuntu:24.04", f"FROM ubuntu:24.04@sha256:{DIGEST}"))

    def test_debian_is_not_the_isolated_profile(self):
        source = DOCKERFILE.read_text().replace("FROM ubuntu:24.04", f"FROM debian:12.0@sha256:{DIGEST}")
        source = re.sub(r"^# pinned-at-build:.*\n", "", source, flags=re.M)
        # Header prose must not satisfy the actual base/profile comparison.
        self.assertIn("ubuntu 24.04", source)
        self.lint(source, 1, "GARM-BASE-01")

    def test_all_rule_controls(self):
        cases = (
            (GOOD.replace(f"ubuntu:24.04@sha256:{DIGEST}", "ubuntu:24"), "GARM-BASE-01"),
            (GOOD.replace("USER runner\n", ""), "GARM-USER-02"),
            (GOOD.replace("COPY app /app", "RUN sudo true"), "GARM-PRIV-03"),
            (GOOD.replace("--no-install-recommends", ""), "GARM-APT-04"),
            (GOOD.replace("COPY app /app", "ADD app /app"), "GARM-COPY-05"),
            (GOOD.replace('["/app/run"]', "/app/run"), "GARM-EXEC-06"),
            (GOOD + "ENV GH_TOKEN=fixture-only\n", "GARM-SECRET-07"),
            (GOOD + "RUN curl https://example.com/i.sh | sh\n", "GARM-FETCH-08"),
            (GOOD + "MAINTAINER nobody@example.com\n", "GARM-FORMAT-09"),
        )
        for text, code in cases:
            with self.subTest(code=code):
                self.lint(text, 1, code)

    def test_base_pinning_controls(self):
        for base in ("ubuntu", "ubuntu:latest", "ubuntu:24", "ubuntu:24.04@sha256:abc",
                     "ubuntu:24.04", "ubuntu:22.04@sha256:" + DIGEST):
            with self.subTest(base=base):
                self.lint(GOOD.replace(f"ubuntu:24.04@sha256:{DIGEST}", base), 1, "GARM-BASE-01")
        self.lint("# pinned-at-build: operator supplies verified digest; source HOLD\n"
                  + GOOD.replace(f"ubuntu:24.04@sha256:{DIGEST}", "ubuntu:24.04"))
        self.lint(GOOD + f"FROM ubuntu:24.04@sha256:{DIGEST}\n", 1, "GARM-BASE-01")

    def test_final_user_is_checked(self):
        self.lint(GOOD + "USER root:runner\n", 1, "GARM-USER-02")
        self.lint(GOOD.replace("USER runner", "USER root\nUSER runner:runner"))
        self.lint(GOOD.replace("USER runner", "USER ${RUNTIME_USER}"), 1, "GARM-USER-02")

    def test_apt_package_and_upgrade_controls(self):
        for command in ("apt-get install -y --no-install-recommends make",
                        "apt-get install -y --no-install-recommends make=1.*",
                        "apt-get install -y --no-install-recommends",
                        "apt-get upgrade", "apt-get dist-upgrade", "apt full-upgrade",
                        "apt-get update \\\n && apt-get upgrade"):
            with self.subTest(command=command):
                self.lint(GOOD + f"RUN {command} && rm -rf /var/lib/apt/lists/*\n", 1, "GARM-APT-04")

    def test_cleanup_cannot_precede_install(self):
        self.lint(GOOD + "RUN rm -rf /var/lib/apt/lists/* && apt-get install -y --no-install-recommends make=1.0\n",
                  1, "GARM-APT-04")

    def test_multiple_installs_share_later_cleanup(self):
        self.lint(GOOD + "RUN apt-get -y install --no-install-recommends make=1.0 \\\n && /usr/bin/apt-get install -y --no-install-recommends gcc=2.0 \\\n && rm -rf /var/lib/apt/lists/*\n")

    def test_docker_install_and_env_controls(self):
        for instruction in ("RUN apt-get install -y --no-install-recommends docker-ce=1.0 && rm -rf /var/lib/apt/lists/*",
                            "ENV DOCKER_HOST=tcp://invalid.example:2375", "VOLUME /var/run/docker.sock"):
            with self.subTest(instruction=instruction):
                self.lint(GOOD + instruction + "\n", 1, "GARM-PRIV-03")

    def test_nonsecret_declarations_and_comments(self):
        self.lint(GOOD + "ARG BUILD_VERSION\nENV NORMAL=value OTHER=\"value with spaces\"\n"
                  + "ENV NORMAL old-style value\n# ENV GH_TOKEN=fixture-only\n# COPY docker /bin/docker\n")

    def test_credentials_are_not_printed(self):
        result = self.lint(GOOD + "ENV NORMAL=value GH_TOKEN=canary-not-a-credential\n",
                           1, "GARM-SECRET-07")
        self.assertNotIn("canary-not-a-credential", result.stdout + result.stderr)
        result = self.lint(GOOD + "RUN app --token canary-not-a-credential\n", 1, "GARM-SECRET-07")
        self.assertNotIn("canary-not-a-credential", result.stdout + result.stderr)

    def test_valid_multiline_exec_json(self):
        self.lint(GOOD + 'CMD ["arg", \\\n "second"]\n')
        self.lint(GOOD.replace('ENTRYPOINT ["/app/run"]', 'entrypoint ["/app/run", "--flag"]'))

    def test_latest_reference_is_not_allowed_in_other_instructions(self):
        self.lint(GOOD + "COPY --from=build:latest /payload /payload\n", 1, "GARM-FORMAT-09")

    def test_opaque_and_malformed_syntax_refuses(self):
        for suffix in ("RUN apt-get install --no-install-recommends make=$VERSION\n",
                       'RUN ["sh", "-c", "apt-get install make"]\n',
                       "RUN curl https://example.com/i.sh \\\n", "RUN curl https://example.com/i.sh |\n",
                       "ENV NORMAL=\"unterminated\n", "INVENTED data\n"):
            with self.subTest(suffix=suffix):
                self.lint(GOOD + suffix, 1, "GARM-FORMAT-09")

    def test_actual_profile_base_and_user(self):
        source = DOCKERFILE.read_text()
        profile = json.loads((HERE / "github-runner/garm/isolated-image-profile.json").read_text())
        # Inspect instructions, not header prose. Independent of the gate parser.
        bases = re.findall(r"^FROM\s+(\S+)", source, flags=re.M | re.I)
        self.assertEqual(len(bases), 1)
        repository, release = bases[0].split("@", 1)[0].split(":", 1)
        self.assertEqual(f"{repository}-{release}", profile["base"]["distribution"])
        users = re.findall(r"^USER\s+(\S+)", source, flags=re.M | re.I)
        self.assertEqual(users[-1].split(":", 1)[0], profile["runtime_user"]["name"])
        self.assertFalse(profile["runtime_user"]["root"])
        self.assertFalse(profile["docker"]["client_installed"])
        body = "\n".join(line for line in source.splitlines() if not line.lstrip().startswith("#"))
        terms = re.findall(r"[A-Za-z_][A-Za-z0-9_.-]*", body.lower())
        for forbidden in ("php", "composer", "sudo", "docker", "docker-ce", "docker.io", "docker_host"):
            self.assertNotIn(forbidden, terms)

    def test_base_and_user_gates_are_load_bearing(self):
        source = (HERE / "garm_image_lint.py").read_text()
        for gate, text in (("base", GOOD.replace(f"ubuntu:24.04@sha256:{DIGEST}", "ubuntu:24")),
                           ("user", GOOD.replace("USER runner", "USER root:root"))):
            with self.subTest(gate=gate), tempfile.TemporaryDirectory() as work:
                root = Path(work)
                profile = root / "github-runner/garm/isolated-image-profile.json"
                profile.parent.mkdir(parents=True)
                shutil.copyfile(HERE / "github-runner/garm/isolated-image-profile.json", profile)
                pattern = rf"    # MUTATION-ANCHOR-START: {gate} gate\n.*?    # MUTATION-ANCHOR-END\n"
                mutant, count = re.subn(pattern, "", source, flags=re.S)
                self.assertEqual(count, 1, "mutation anchor missing")
                (root / "garm_image_lint.py").write_text(mutant)
                (root / "Dockerfile").write_text(text)
                result = subprocess.run(["python3", str(root / "garm_image_lint.py"), str(root / "Dockerfile")],
                                        capture_output=True, text=True, env={"PATH": "/usr/bin:/bin"})
                self.assertEqual(result.returncode, 0, result.stderr)
                self.lint(text, 1, f"GARM-{'BASE-01' if gate == 'base' else 'USER-02'}")

    def test_hermetic_without_hadolint_and_no_environment_leak(self):
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            for name in ("curl", "wget", "docker", "podman", "hadolint"):
                binary = root / name
                binary.write_text(f"#!/bin/sh\n/usr/bin/touch '{root}/called'\nexit 99\n")
                binary.chmod(0o755)
            result = subprocess.run(["bash", str(LINT), str(DOCKERFILE)], capture_output=True,
                                    text=True, env={"PATH": f"{root}:/usr/bin:/bin", "SENTINEL_GARM_TEST": "canary-no-leak"})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse((root / "called").exists())
            self.assertNotIn("canary-no-leak", result.stdout + result.stderr)

    def test_usage_and_missing_file(self):
        for args, expected in (([], 2), (["--help"], 0), ([str(HERE / "nonexistent.Dockerfile")], 2)):
            with self.subTest(args=args):
                result = subprocess.run(["bash", str(LINT), *args], capture_output=True,
                                        text=True, env={"PATH": "/usr/bin:/bin"})
                self.assertEqual(result.returncode, expected, result.stderr)

    def test_multiple_input_files_are_all_checked(self):
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            (root / "good").write_text(GOOD)
            (root / "bad").write_text(GOOD.replace("USER runner", "USER root:root"))
            result = subprocess.run(["bash", str(LINT), str(root / "good"), str(root / "bad")],
                                    capture_output=True, text=True, env={"PATH": "/usr/bin:/bin"})
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn("RULE GARM-USER-02 ", result.stderr)

    def test_archive_extraction_layout(self):
        self.assert_archive_layout(DOCKERFILE.read_text())

    def test_archive_layout_mutants_are_killed(self):
        source = DOCKERFILE.read_text()
        for mutant in (source.replace("mkdir -p /opt/runner /opt/node24", "mkdir -p /opt/stage"),
                       source.replace("--strip-components=1 ", "")):
            with self.subTest(mutant=mutant != source):
                self.assertNotEqual(mutant, source, "mutation anchor missing")
                with self.assertRaises(AssertionError):
                    self.assert_archive_layout(mutant)

    def assert_archive_layout(self, source):
        # Independent continuation join: execute only a tiny allowlisted archive
        # command subset with every /opt path retargeted into run-owned scratch.
        joined = re.sub(r"\\\n\s*", " ", source)
        runs = re.findall(r"^RUN (.*)$", joined, re.M)
        extraction = next(run for run in runs if "tar -xzf /opt/stage/runner-linux-x64.tar.gz" in run)
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            stage = root / "opt/stage"
            stage.mkdir(parents=True)
            for archive, member in (("runner-linux-x64.tar.gz", "bin/Runner.Listener"),
                                    ("node24-linux-x64.tar.gz", "node-v24.1.0-linux-x64/bin/node")):
                with tarfile.open(stage / archive, "w:gz") as bundle:
                    info = tarfile.TarInfo(member)
                    data = b"synthetic archive member; not executed\n"
                    info.size = len(data)
                    info.mode = 0o755
                    bundle.addfile(info, io.BytesIO(data))
            for command in extraction.split("&&"):
                argv = shlex.split(command.strip())
                allowed = {"mkdir", "tar", "rm", "-p", "-xzf", "-C", "-rf", "--strip-components=1",
                           "/opt/stage", "/opt/runner", "/opt/node24",
                           "/opt/stage/runner-linux-x64.tar.gz", "/opt/stage/node24-linux-x64.tar.gz"}
                self.assertIn(argv[0], ("mkdir", "tar", "rm"))
                self.assertTrue(all(arg in allowed for arg in argv), "archive command exceeds safe test subset")
                argv = [str(root) + arg if arg.startswith("/opt/") else arg for arg in argv]
                result = subprocess.run(argv, capture_output=True, text=True,
                                        env={"PATH": "/usr/bin:/bin"}, cwd=root)
                self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((root / "opt/runner/bin/Runner.Listener").is_file())
            self.assertTrue((root / "opt/node24/bin/node").is_file())
            self.assertFalse(stage.exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
