#!/usr/bin/env bash
# ===========================================================================
# test_capture_network_name_evidence.sh
#
# The whole value of capture_network_name_evidence.sh is one function:
# effective_network_name(). It decides case (A) vs case (B), and the two need
# OPPOSITE fixes, so a parsing slip does not degrade the answer — it inverts
# it.
#
# These cases are chosen to be the ones where a `grep NetworkName=` gives the
# WRONG answer. A suite that only tests the happy path measures the branch the
# author already believed in (cf. the 56/56 green suite on the activation gate,
# every fixture of which spelled out the default and so could never see the
# override case). Each test below names which real defect it pins.
# ===========================================================================
set -uo pipefail

GATE="${GATE:-./capture_network_name_evidence.sh}"
[ -f "$GATE" ] || { printf 'not found: %s\n' "$GATE" >&2; exit 2; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0

# Source only the parser, without executing main. The script runs top-to-bottom
# under `set -e`, so we extract the two functions it needs.
sed -n '/^refuse()/,/^}/p;/^effective_network_name()/,/^}/p' "$GATE" > "$TMP/fn.sh"
# refuse() increments this; the real script initialises it before either
# function is reachable. Declare it here so a refusal under test reports its
# message rather than dying on an unbound variable and looking like a
# different failure than the one it is.
REFUSALS=0
# shellcheck disable=SC1090
. "$TMP/fn.sh"

check() { # check <name> <expected> <actual>
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); printf '  ok   %s\n' "$1"
  else FAIL=$((FAIL+1)); printf '  FAIL %s\n       expected [%s]\n       actual   [%s]\n' "$1" "$2" "$3"; fi
}

u() { printf '%s\n' "$1" > "$TMP/u.network"; effective_network_name "$TMP/u.network" 2>/dev/null; }

printf 'effective_network_name()\n'

check 'unset -> empty (default applies)' \
  '' "$(u '[Network]
Driver=bridge')"

check 'plain override is read' \
  'paperclip' "$(u '[Network]
NetworkName=paperclip')"

# --- the four cases a grep gets wrong -------------------------------------

# systemd takes the LAST assignment; grep -m1 takes the first. Getting this
# backwards reports the override that was overridden.
check 'repeated key: LAST wins, not first' \
  'second' "$(u '[Network]
NetworkName=first
NetworkName=second')"

# An EMPTY assignment is a systemd RESET to the default, not "named empty
# string". This is exactly the (A)/(B) boundary: reset means systemd-<stem>.
check 'empty assignment RESETS to default' \
  '' "$(u '[Network]
NetworkName=paperclip
NetworkName=')"

# Outside [Network] the key is not the network name. A section-blind grep
# reports case (A) from a [Container] line and inverts the verdict.
check 'key in another section is ignored' \
  '' "$(u '[Container]
NetworkName=paperclip

[Network]
Driver=bridge')"

check 'commented-out key is ignored' \
  '' "$(u '[Network]
#NetworkName=paperclip
;NetworkName=other')"

# --- whitespace / encoding shapes real units carry -------------------------
check 'surrounding whitespace is trimmed' \
  'paperclip' "$(u '[Network]
   NetworkName =  paperclip   ')"

check 'CRLF-authored unit parses' \
  'paperclip' "$(printf '[Network]\r\nNetworkName=paperclip\r\n' > "$TMP/u.network"; effective_network_name "$TMP/u.network")"

check 'section re-entry keeps reading' \
  'late' "$(u '[Network]
Driver=bridge

[Container]
Image=x

[Network]
NetworkName=late')"

# --- drop-ins override the base unit, in application order ----------------
printf '[Network]\nNetworkName=base\n' > "$TMP/base.network"
printf '[Network]\nNetworkName=dropin\n' > "$TMP/10.conf"
check 'drop-in overrides base unit' \
  'dropin' "$(effective_network_name "$TMP/base.network" "$TMP/10.conf")"

printf '[Network]\nNetworkName=\n' > "$TMP/20.conf"
check 'drop-in empty assignment resets base override' \
  '' "$(effective_network_name "$TMP/base.network" "$TMP/20.conf")"

# --- a truncated name must refuse, never be recorded ----------------------
printf '[Network]\nNetworkName=paper\\\n' > "$TMP/cont.network"
out="$(effective_network_name "$TMP/cont.network" 2>&1)"; rc=$?
check 'line continuation refuses (rc)' '1' "$rc"
case "$out" in
  *networkname_line_continuation*) PASS=$((PASS+1)); printf '  ok   line continuation names its refusal\n' ;;
  *) FAIL=$((FAIL+1)); printf '  FAIL line continuation did not name a refusal: %s\n' "$out" ;;
esac

# --- the real TOG-1110 shapes, end to end ---------------------------------
printf '\nTOG-1110 cases\n'
check 'case (A): paperclip.network overrides -> carrier correct, gate wrong' \
  'paperclip' "$(u '[Unit]
Description=paperclip network

[Network]
NetworkName=paperclip
Driver=bridge

[Install]
WantedBy=default.target')"

check 'case: omniroute.network has no override -> renders systemd-omniroute' \
  '' "$(u '[Unit]
Description=omniroute network

[Network]
Driver=bridge')"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
