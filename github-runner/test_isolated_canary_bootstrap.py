"""Offline Bash behavioral controls in a disposable fake VM, not live sudo proof."""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("canary_bootstrap", ROOT / "garm/canary_bootstrap.py")
bootstrap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bootstrap)
POOL = "11111111-1111-4111-8111-111111111111"
FIXTURE = json.loads((ROOT / "garm/fixture-canary-bootstrap.json").read_text())
CLOUD = FIXTURE["cloud_config"]

# Stateful command doubles: assertions exercise the shipped Bash, including its
# errexit/ordering, against direct and supplementary-group grants. No process
# changes an account, policy or filesystem outside this temporary fake VM.
FAKE = r'''#!/usr/bin/env python3
import os,sys,pathlib,subprocess
w=pathlib.Path(os.environ['WORLD']); cmd=pathlib.Path(sys.argv[0]).name; a=sys.argv[1:]
u=os.environ.get('AS_USER','root')
def log(event):
 with (w/'events').open('a') as f: f.write(event+'\n')
def groups(): return (w/'groups').read_text().strip()
def grant():
 if os.environ.get('FAKE_SUDO_GRANT'): return True
 p=(w/'etc/sudoers').read_text()
 if 'runner ALL=' in p or 'ALL ALL=' in p: return True
 if '%sudo ALL=' in p and 'sudo' in groups().split(): return True
 if '@includedir' in p:
  return any('runner ALL=' in x.read_text() for x in (w/'etc/sudoers.d').iterdir())
 return False
if cmd=='id':
 target='runner' if 'runner' in a else u
 if '-u' in a: print(0 if target=='root' else 1001)
 elif '-un' in a: print(target)
 elif '-gn' in a: print('runner')
 elif '-Gn' in a: print(groups())
elif cmd=='hostname': print(os.environ.get('VM_NAME','garm-iso-fixture'))
elif cmd=='usermod':
 if os.environ.get('FAIL_USERMOD'): sys.exit(1)
 if '--groups' in a: (w/'groups').write_text('runner'); log('groups-revoked')
 else: log('password-locked')
elif cmd=='install':
 p=pathlib.Path(a[-1]); p.mkdir(parents=True,exist_ok=True); p.chmod(0o755)
elif cmd=='chown': pass
elif cmd=='stat':
 p=pathlib.Path(a[-1]); mode=oct(p.stat().st_mode & 0o777)[2:]
 print(('1001:1001:' if os.environ.get('BAD_OWNER') else '0:0:')+mode)
elif cmd=='visudo':
 log('policy-checked')
 if os.environ.get('FAIL_VISUDO'): sys.exit(1)
 p=pathlib.Path(a[-1]) if '-cf' in a else w/'etc/sudoers'
 if 'root ALL=(ALL:ALL) NOPASSWD: ALL' not in p.read_text(): sys.exit(1)
elif cmd=='sudo':
 target=a[a.index('-U')+1] if '-U' in a else u
 if target=='root':
  log('privileged-positive')
  sys.exit(1 if os.environ.get('FAIL_POSITIVE') else 0)
 log('runner-sudo-probe')
 if '-U' in a:
  # Real `sudo -l -U <user>` exits 0 even when the user has no sudo at all;
  # only its output tells denial from grant. Model that exactly.
  if grant():
   print('User %s may run the following commands on fixture:' % target)
   print('    (ALL) NOPASSWD: ALL')
  else:
   print('User %s is not allowed to run sudo on fixture.' % target)
  sys.exit(0)
 sys.exit(0 if grant() else 1)
elif cmd=='runuser':
 env=dict(os.environ,AS_USER='runner'); sys.exit(subprocess.call(a[a.index('--')+1:],env=env))
elif cmd=='curl':
 header=sys.stdin.read()
 if 'fixture-bootstrap' not in header: sys.exit(1)
 if os.environ.get('FAIL_HTTP'): sys.exit(1)
 url=a[-1]
 if '--request' in a: log('idle-callback')
 elif 'credentials/runner' in url: print('{"AgentId":9}')
 elif 'credentials/' in url: print('fixture-credential-bytes')
 else: log('metadata-token'); print('fixture-registration')
else: sys.exit(2)
'''


class FakeVM:
    def __init__(self, template=None, jit=False):
        self.jit = jit
        self.tmp = tempfile.TemporaryDirectory(prefix="garm-bootstrap-", dir=os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR"))
        self.path = Path(self.tmp.name)
        self.bin = self.path / "bin"
        self.bin.mkdir()
        for name in ("bash", "python3", "chmod", "rm", "mktemp", "mv", "sha256sum", "grep"):
            (self.bin / name).symlink_to(shutil.which(name))
        for name in ("id", "hostname", "usermod", "install", "chown", "stat", "visudo", "sudo", "runuser", "curl"):
            p = self.bin / name
            p.write_text(FAKE)
            p.chmod(0o755)
        (self.path / "groups").write_text("runner " + " ".join(CLOUD["system_info"]["default_user"]["groups"]))
        (self.path / "events").write_text("")
        (self.path / "etc/sudoers.d").mkdir(parents=True)
        (self.path / "etc/sudoers").write_text("root ALL=(ALL:ALL) NOPASSWD: ALL\n%sudo ALL=(ALL) NOPASSWD: ALL\n@includedir /etc/sudoers.d\n")
        (self.path / "etc/sudoers.d/90-cloud-init-users").write_text("runner " + CLOUD["system_info"]["default_user"]["sudo"] + "\n")
        home = self.path / "home/runner/actions-runner"
        (home / "bin").mkdir(parents=True)
        for name, body in {
            "bin/Runner.Listener": "printf '%s\\n' \"${TEST_RUNNER_VERSION:-2.337.0}\"",
            "config.sh": "[ \"$ACTIONS_RUNNER_INPUT_TOKEN\" = fixture-registration ] || exit 1\nprintf 'registered\\n' >> \"$WORLD/events\"\n[ -z \"${FAIL_CONFIG:-}\" ] || exit 1\nprintf '{\"agentId\":7}' > .runner",
            "run.sh": "[ ! -s \"$WORLD/install_runner.sh\" ] || exit 1\n[ -z \"${BEARER_TOKEN:-}${ACTIONS_RUNNER_INPUT_TOKEN:-}\" ] || exit 1\nprintf 'started\\n' >> \"$WORLD/events\"",
        }.items():
            p = home / name
            p.write_text("#!/bin/bash\nset -eu\n" + body + "\n")
            p.chmod(0o755)
        self.env = {"WORLD": str(self.path), "AS_USER": "root", "PATH": "/usr/bin:/bin"}
        self.hook = self.path / "hook.sh"
        hook_file = next(f for f in CLOUD["write_files"] if f["path"].startswith("/garm-pre-install/"))
        self.hook.write_text(self.rewrite(base64.b64decode(hook_file["content"]).decode()))
        if template is None:
            override = os.environ.get("BOOTSTRAP_TEST_TEMPLATE")
            rendered = self.render(Path(override).read_text(), jit=self.jit) if override else base64.b64decode(FIXTURE["rendered_template_b64"]).decode()
        else:
            rendered = self.render(template, jit=self.jit)
        self.script = self.path / "install_runner.sh"
        self.script.write_text(self.rewrite(rendered))
        self.script.chmod(0o755)

    def rewrite(self, text):
        paths = ("/var/lib/garm-iso", "/home/runner", "/install_runner.sh", "/var/run/docker.sock", "/run/docker.sock", "/etc")
        text = re.sub("|".join(re.escape(p) for p in paths), lambda m: str(self.path / m[0].lstrip("/")), text)
        text = text.replace("/usr/bin/sudo", str(self.bin / "sudo"))
        return text.replace("export PATH=/usr/sbin:/usr/bin:/sbin:/bin", "export PATH=" + str(self.bin))

    def render(self, text, jit=False):
        def jit_branch(m):
            # `{{- if .UseJITConfig }}A{{- else }}B{{- end }}` renders A on JIT
            # boots and B otherwise; a block without `else` renders A or nothing.
            if_branch, else_branch = m.group(1), m.group(2)
            return if_branch if jit else (else_branch if else_branch is not None else "")
        # Innermost blocks first: a `GitHubRunnerGroup` conditional nests inside
        # the non-JIT branch, and a flat non-greedy match would end the outer
        # `UseJITConfig` block at the inner `{{- end }}` and swallow the tail.
        text = re.sub(r"{{- if \.GitHubRunnerGroup }}.*?{{- end }}", "", text, flags=re.S)
        text = re.sub(r"{{- if \.UseJITConfig }}(.*?)(?:{{- else }}(.*?))?{{- end }}", jit_branch, text, flags=re.S)
        values = {"RunnerUsername": "runner", "RunnerName": "garm-iso-fixture", "RunnerLabels": "self-hosted,garm-managed", "MetadataURL": "https://controller.invalid/metadata", "CallbackURL": "https://controller.invalid/status", "CallbackToken": "fixture-bootstrap", "RepoURL": "https://github.com/example/private"}
        for key, value in values.items():
            text = text.replace("{{ ." + key + " }}", value)
        if "{{" in text:
            raise AssertionError("unrendered Go template")
        return text

    def hook_run(self, **flags):
        return subprocess.run(["bash", str(self.hook)], env=dict(self.env, **flags), capture_output=True, text=True, timeout=10)

    def runner_run(self, **flags):
        try:
            return subprocess.run([str(self.script)], env=dict(self.env, AS_USER="runner", **flags), capture_output=True, text=True, timeout=10)
        except PermissionError:
            return subprocess.CompletedProcess([str(self.script)], 126, "", "installer not executable")

    def cloud_init_run(self, **flags):
        # Replay the actual generated runcmd sequence without assuming that
        # cloud-init stops at a failed pre-install command.
        results = []
        for cmd in CLOUD["runcmd"]:
            if cmd == "/garm-pre-install/00-revoke-canary-sudo.sh":
                results.append(self.hook_run(**flags).returncode)
            elif cmd == "rm -rf /garm-pre-install":
                self.hook.unlink(missing_ok=True)
                results.append(0)
            elif cmd == "su -l -c /install_runner.sh runner":
                results.append(self.runner_run().returncode)
            elif cmd == "rm -f /install_runner.sh":
                self.script.unlink(missing_ok=True)
                results.append(0)
            else:
                raise AssertionError("unexpected generated bootstrap command")
        return results

    def events(self):
        return (self.path / "events").read_text().splitlines()

    def close(self):
        self.tmp.cleanup()


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.vm = FakeVM()
        self.addCleanup(self.vm.close)

    def assert_no_start(self, result):
        self.assertNotEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("registered", self.vm.events())
        self.assertNotIn("started", self.vm.events())

    def test_generated_direct_and_group_grants_revoked_before_registration(self):
        self.assertEqual(self.vm.runner_run().returncode, 1)
        result = self.vm.hook_run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.vm.path / "groups").read_text(), "runner")
        result = self.vm.runner_run()
        self.assertEqual(result.returncode, 0, result.stderr)
        events = self.vm.events()
        self.assertLess(events.index("groups-revoked"), events.index("registered"))
        self.assertLess(events.index("privileged-positive"), events.index("registered"))
        self.assertLess(events.index("registered"), events.index("idle-callback"))
        self.assertLess(events.index("idle-callback"), events.index("started"))
        self.assertEqual(self.vm.script.read_text(), "")

    def test_hook_idempotent(self):
        self.assertEqual(self.vm.hook_run().returncode, 0)
        before = (self.vm.path / "var/lib/garm-iso/bootstrap.ready").read_text()
        self.assertEqual(self.vm.hook_run().returncode, 0)
        self.assertEqual((self.vm.path / "var/lib/garm-iso/bootstrap.ready").read_text(), before)
        self.assertEqual(self.vm.runner_run().returncode, 0)

    def test_missing_hook_never_registers_or_starts(self):
        self.assert_no_start(self.vm.runner_run())

    def test_failed_hook_with_cloud_init_continuation_never_starts(self):
        statuses = self.vm.cloud_init_run(FAIL_VISUDO="1")
        self.assertNotEqual(statuses[0], 0)
        self.assertNotEqual(statuses[2], 0)
        self.assertEqual(statuses[3], 0)  # final rm success is NOT runner success
        self.assertNotIn("registered", self.vm.events())
        self.assertNotIn("started", self.vm.events())

    def test_failed_repeat_invalidates_previous_ready(self):
        self.assertEqual(self.vm.hook_run().returncode, 0)
        self.assertNotEqual(self.vm.hook_run(FAIL_USERMOD="1").returncode, 0)
        self.assert_no_start(self.vm.runner_run())

    def test_default_template_mismatch_never_executes(self):
        self.vm.script.write_text('#!/bin/bash\nprintf "started\\\\n" >> "$WORLD/events"\n')
        self.assertNotEqual(self.vm.hook_run().returncode, 0)
        self.assert_no_start(self.vm.runner_run())

    def test_docker_binary_or_socket_prevents_start(self):
        docker = self.vm.bin / "docker"
        docker.write_text("#!/bin/bash\nexit 0\n")
        docker.chmod(0o755)
        self.assertNotEqual(self.vm.hook_run().returncode, 0)
        self.assert_no_start(self.vm.runner_run())
        docker.unlink()
        socket = self.vm.path / "run/docker.sock"
        socket.parent.mkdir()
        socket.touch()
        self.assertNotEqual(self.vm.hook_run().returncode, 0)
        self.assert_no_start(self.vm.runner_run())

    def test_privileged_positive_control_failure_closes_gate(self):
        self.assertNotEqual(self.vm.hook_run(FAIL_POSITIVE="1").returncode, 0)
        self.assert_no_start(self.vm.runner_run())

    def test_sudo_grant_listing_aborts_hook(self):
        # The lister exits 0 either way, so only its output tells denial from
        # grant. A grant the file-level revocation missed must still abort.
        self.assertNotEqual(self.vm.hook_run(FAKE_SUDO_GRANT="1").returncode, 0)
        self.assert_no_start(self.vm.runner_run())

    def test_non_jit_render_keeps_label_assertion_and_config(self):
        template = (ROOT / "garm" / bootstrap.TEMPLATE).read_text()
        text = self.vm.render(template)
        self.assertIn("[ \"self-hosted,garm-managed\" = 'self-hosted,garm-managed' ]", text)
        self.assertIn("./config.sh", text)
        self.assertNotIn("credentials/runner", text)

    def test_jit_branch_registers_without_config_sh(self):
        # GARM 0.2.1 renders RunnerLabels empty, so the JIT branch must not
        # assert them, must not call config.sh, and must read the capital-A
        # `AgentId` the JIT `.runner` file carries.
        template = (ROOT / "garm" / bootstrap.TEMPLATE).read_text()
        vm = FakeVM(template=template, jit=True)
        self.addCleanup(vm.close)
        text = vm.script.read_text()
        self.assertNotIn("RunnerLabels", text)
        self.assertNotIn("./config.sh", text)
        self.assertIn("credentials/runner", text)
        self.assertEqual(vm.hook_run().returncode, 0)
        result = vm.runner_run()
        self.assertEqual(result.returncode, 0, result.stderr)
        events = vm.events()
        self.assertNotIn("metadata-token", events)
        self.assertNotIn("registered", events)
        self.assertIn("idle-callback", events)
        self.assertIn("started", events)
        self.assertEqual(vm.script.read_text(), "")

    def test_non_canary_vm_unchanged(self):
        before = (self.vm.path / "etc/sudoers").read_text()
        self.assertNotEqual(self.vm.hook_run(VM_NAME="garm-old-fixture").returncode, 0)
        self.assertEqual((self.vm.path / "etc/sudoers").read_text(), before)
        self.assertEqual(self.vm.events(), [])

    def test_non_root_hook_rejected(self):
        self.assertNotEqual(self.vm.hook_run(AS_USER="runner").returncode, 0)
        self.assert_no_start(self.vm.runner_run())

    def test_runtime_regrant_blocks_registration(self):
        self.assertEqual(self.vm.hook_run().returncode, 0)
        policy = self.vm.path / "etc/sudoers"
        policy.chmod(0o600)
        with policy.open("a") as f:
            f.write("runner ALL=(ALL) NOPASSWD: ALL\n")
        policy.chmod(0o440)
        self.assert_no_start(self.vm.runner_run())

    def test_group_regrant_blocks_registration(self):
        self.assertEqual(self.vm.hook_run().returncode, 0)
        (self.vm.path / "groups").write_text("runner sudo")
        self.assert_no_start(self.vm.runner_run())

    def test_marker_wrong_owner_or_tampered_script_blocks(self):
        self.assertEqual(self.vm.hook_run().returncode, 0)
        self.assert_no_start(self.vm.runner_run(BAD_OWNER="1"))
        with self.vm.script.open("a") as f:
            f.write("\n# tamper\n")
        self.assert_no_start(self.vm.runner_run())

    def test_runner_pin_drift_blocks_registration(self):
        self.assertEqual(self.vm.hook_run().returncode, 0)
        self.assert_no_start(self.vm.runner_run(TEST_RUNNER_VERSION="2.999.0"))

    def test_registration_failure_never_starts(self):
        self.assertEqual(self.vm.hook_run().returncode, 0)
        result = self.vm.runner_run(FAIL_CONFIG="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("started", self.vm.events())

    def test_http_failure_never_registers(self):
        self.assertEqual(self.vm.hook_run().returncode, 0)
        self.assert_no_start(self.vm.runner_run(FAIL_HTTP="1"))

    def test_bypass_mutant_is_caught_by_missing_hook_control(self):
        template = (ROOT / "garm" / bootstrap.TEMPLATE).read_text()
        mutant = template.replace("\nverify_hardening\n", "\n# verification bypassed\n")
        self.assertNotEqual(mutant, template)
        vm = FakeVM(template=mutant)
        self.addCleanup(vm.close)
        result = vm.runner_run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("registered", vm.events())
        self.assertIn("started", vm.events())
        # This is the same no-start assertion above, proven red on the mutant.
        with self.assertRaises(AssertionError):
            self.assertNotIn("started", vm.events())

    def test_actual_upstream_fixture_and_source_freshness(self):
        # The upstream source pin is intentionally unpinned in the public tree
        # (all-zeros); the field still pins the fixture to a single revision.
        self.assertEqual(FIXTURE["common_commit"], "0000000000000000000000000000000000000000")
        self.assertEqual(FIXTURE["template_source_sha256"], hashlib.sha256((ROOT / "garm" / bootstrap.TEMPLATE).read_bytes()).hexdigest())
        hook = next(f for f in CLOUD["write_files"] if f["path"].startswith("/garm-pre-install/"))
        self.assertEqual(base64.b64decode(hook["content"]), (ROOT / "garm" / bootstrap.HOOK).read_bytes())
        installer = next(f for f in CLOUD["write_files"] if f["path"] == "/install_runner.sh")
        self.assertEqual(installer["content"], FIXTURE["rendered_template_b64"])
        self.assertEqual(CLOUD["users"], ["default"])
        self.assertEqual(CLOUD["system_info"]["default_user"]["sudo"], "ALL=(ALL) NOPASSWD:ALL")
        self.assertIn("sudo", CLOUD["system_info"]["default_user"]["groups"])
        self.assertIn("docker", CLOUD["system_info"]["default_user"]["groups"])
        self.assertFalse(CLOUD["package_upgrade"])
        result = subprocess.run(["bash", "-n", str(self.vm.script)], capture_output=True)
        self.assertEqual(result.returncode, 0)

    def test_specs_base64_exact_bytes_and_no_apply_claim(self):
        specs = bootstrap.build_specs(POOL)
        self.assertEqual(base64.b64decode(specs["runner_install_template"]), (ROOT / "garm" / bootstrap.TEMPLATE).read_bytes())
        self.assertEqual(base64.b64decode(next(iter(specs["pre_install_scripts"].values()))), (ROOT / "garm" / bootstrap.HOOK).read_bytes())
        receipt = bootstrap.source_receipt(POOL)
        for flag in ("host_mutation_authorized", "admission_authorized", "host_verified"):
            self.assertIs(receipt[flag], False)
        self.assertEqual(receipt["extra_specs_sha256"], hashlib.sha256(json.dumps(specs,sort_keys=True,separators=(",", ":")).encode()).hexdigest())

    def test_partial_or_missing_uuid_rejected(self):
        for value in ("deadbeef", "", "not-a-uuid", POOL.upper()):
            if value == POOL:
                continue
            with self.subTest(value=value), self.assertRaises(ValueError):
                bootstrap.build_specs(value)

    def test_previously_issued_pool_trunk_is_never_reminted(self):
        # The denylist branch: a full canonical UUID carrying a known trunk
        # must refuse even though it parses and is non-zero.
        with self.assertRaises(ValueError):
            bootstrap.build_specs("deadbeef-1111-4111-8111-111111111111")


if __name__ == "__main__":
    unittest.main()
