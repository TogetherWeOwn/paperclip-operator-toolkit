#!/usr/bin/env bash
# Propose-only red-main poller. Policy, transport contracts and exits are in
# red_main_poll.py; deployment, scheduling and board writes are intentionally absent.
# Keep the sibling helper beside this entry point. No credential appears in argv.
set +x +v
set -eu
HERE="$(dirname -- "${BASH_SOURCE[0]}")"
exec /usr/bin/python3 -I -B "$HERE/red_main_poll.py" "$@"
