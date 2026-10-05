#!/bin/bash
# Pool-local root pre-install hook; never run on the controller or a static runner.
# Runs as a cloud-init pre-install runcmd entry before the installer template
# below; ordering matters because cloud-init is not an errexit chain (see body).
set -euo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

[ "$(id -u)" = 0 ]
case "$(hostname)" in garm-iso-*) ;; *) exit 1 ;; esac
[ -f /install_runner.sh ]
[ ! -L /install_runner.sh ]
# Cloud-init runcmd is not an errexit chain: disable the subsequent direct exec
# FIRST. Any failed hook leaves the installer non-executable, even if the pool
# accidentally retained the default template. Restore execution only on PASS.
chmod 0400 /install_runner.sh
[ ! -L /var/lib/garm-iso ]
install -d -o root -g root -m 0755 /var/lib/garm-iso
rm -f /var/lib/garm-iso/bootstrap.ready
[ "$(id -u runner)" -gt 0 ]
[ "$(id -gn runner)" = runner ]
grep -Fxq '# GARM_ISO_BOOTSTRAP_V1' /install_runner.sh
grep -Fxq 'verify_hardening' /install_runner.sh
[ ! -s /home/runner/.ssh/authorized_keys ]

# Drop ALL supplementary grants, not just the customary sudo/docker/lxd names.
usermod --lock runner
usermod --groups '' runner
[ "$(id -Gn runner)" = runner ]

# Disposable canary VM only: replace the effective policy with root-only sudo.
# No include remains, so direct grants, aliases, wildcards and group drop-ins
# (including cloud-init's 90-cloud-init-users) cannot grant runner anything.
[ -f /etc/sudoers ]
[ ! -L /etc/sudoers ]
policy=$(mktemp /etc/.garm-iso-sudoers.XXXXXX)
trap 'rm -f "$policy"' EXIT
printf '%s\n' 'Defaults env_reset' 'root ALL=(ALL:ALL) NOPASSWD: ALL' > "$policy"
chmod 0440 "$policy"
chown root:root "$policy"
visudo -cf "$policy"
mv -f "$policy" /etc/sudoers
visudo -c

# A broken/missing sudo binary must not be mistaken for a denial.
sudo -n /usr/bin/true
# `sudo -l -U <user>` exits 0 even when the user has no sudo at all (it only
# prints "User runner is not allowed to run sudo"), so the exit status cannot
# prove denial and the old `if sudo -l -U runner` form aborted every boot.
# Match the denial sentence instead; any other listing means the runner holds
# an effective grant and the hook fails closed. No `| grep -q`: it can SIGPIPE
# under pipefail and read a denial as a pass.
runner_sudo_list=$(sudo -l -U runner 2>&1)
[[ "$runner_sudo_list" == *'is not allowed to run sudo'* ]]
if runuser --user runner -- sudo -n /usr/bin/true; then exit 1; fi
[ ! -e /var/run/docker.sock ]
[ ! -e /run/docker.sock ]
if command -v docker || command -v dockerd; then exit 1; fi

# The bootstrap contains short-lived metadata credentials. Give only the
# bootstrap user access; it truncates this file before accepting a job.
chown runner:runner /install_runner.sh
script_hash=$(sha256sum /install_runner.sh)
script_hash=${script_hash%% *}
policy_hash=$(sha256sum /etc/sudoers)
policy_hash=${policy_hash%% *}
ready=$(mktemp /var/lib/garm-iso/.ready.XXXXXX)
printf '%s\n' "$script_hash" "$policy_hash" > "$ready"
chown root:root "$ready"
chmod 0644 "$ready"
mv -f "$ready" /var/lib/garm-iso/bootstrap.ready
chmod 0700 /install_runner.sh
