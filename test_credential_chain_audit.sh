#!/usr/bin/env bash
# Regression suite for credential_chain_audit.sh  (TOG-310).
#
# The failure that matters is reporting a clean chain when a hole exists,
# because a clean report is what would authorise closing TOG-310 and telling
# eight agents the credential path is safe.  Every test below is therefore
# written against that direction: a hole must never read as OK, and anything
# the audit could not establish must never read as OK either.
#
# Both bugs this suite pins were real, found by checking the audit's own output
# against live write probes rather than by reading the code:
#
#   * /bin and /sbin reported as world-writable holes.  They are symlinks into
#     /usr, and a symlink's own mode is always 0777.  stat had to dereference.
#     False positives are not harmless here -- an audit that flags /bin gets
#     ignored, and then it is not an audit.
#
#   * /paperclip/.config/git/config reported OK because its parent directory
#     did not exist.  `mkdir -p` succeeds, so git would read whatever an agent
#     put there.  That one was failing open on the exact link that survives the
#     fix TOG-310 originally asked for.
#
# Runs as an ordinary agent.  It cannot chown, so "clean" fixtures are real
# root-owned paths that already exist (/usr/bin/git, /etc) rather than
# synthesised ones -- a fixture this suite could chown would not be a fixture
# for a boundary this suite is trying to prove.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUDIT="$HERE/credential_chain_audit.sh"
PASS=0; FAIL=0

# The principal to audit is always whoever is running this suite, and it has to
# be: the fixtures below are files this process creates, so they are owned by
# this user, and "can X substitute this file" only asks the intended question
# when X is the same user that made it. Auditing as anyone else turns every
# HOLE fixture into an OK and the suite reports 27 failures for no reason.
#
# In the agent container this resolves to `node`, the shared uid every agent
# runs as (TOG-191), which is exactly the principal TOG-310 is about. On a
# GitHub runner it resolves to `runner`. Hardcoding `node` was the first
# version and it made the whole suite exit 2 on the runner, where no such user
# exists.
AS_USER="$(id -un)"
if [[ "$(id -u "$AS_USER")" == "0" ]]; then
  echo "ERROR: running as root -- these assertions are about an unprivileged" >&2
  echo "       principal and root is not subject to the bits they measure." >&2
  exit 2
fi
AUDIT_ARGS=(--as-uid "$AS_USER")

TMP="$(mktemp -d "${PAPERCLIP_RUN_SCRATCH_DIR:-${TMPDIR:-/tmp}}/tog310-XXXXXX")" || exit 2
cleanup() { chmod -R u+rwX "$TMP" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT

ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); shift; [[ $# -gt 0 ]] && sed 's/^/        /' <<<"$*"; }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# expect_path <desc> <expected-verdict> <path>
expect_path() {
  local desc="$1" want="$2" p="$3" out got
  out="$("$AUDIT" "${AUDIT_ARGS[@]}" --check-path "$p" 2>&1)"
  got="$(cut -f1 <<<"$out")"
  if [[ "$got" == "$want" ]]; then ok "$desc"; else bad "$desc (want $want, got $got)" "$out"; fi
}

# ---------------------------------------------------------------------------
hdr "1. Ownership is write permission, regardless of mode bits"
# This is the rule TOG-310's requested fix depends on being true: chmod alone is
# not a remedy, only chown is.  If the audit ever scores a node-owned 0444 file
# as OK, it will bless a "fix" that an attacker undoes with one chmod.

printf 'x' > "$TMP/owned-by-me"
expect_path "a node-owned 0644 file is substitutable" HOLE "$TMP/owned-by-me"

chmod 0444 "$TMP/owned-by-me"
expect_path "a node-owned file at 0444 is STILL substitutable (owner may chmod)" \
  HOLE "$TMP/owned-by-me"
chmod 0644 "$TMP/owned-by-me"

expect_path "a root-owned file in a root-owned dir holds" OK /usr/bin/git

# ---------------------------------------------------------------------------
hdr "2. Absent is not safe -- creatable counts (fail-open regression)"

expect_path "absent config under a root-owned dir is OK" OK /etc/gitconfig
expect_path "absent config in a node-owned dir is a hole" HOLE "$TMP/not-there.cfg"

# The exact shape that scored OK before the fix: several missing levels beneath
# a directory the agent owns.
expect_path "absent config several mkdir -p levels down is a hole" \
  HOLE "$TMP/a/b/c/config"

# And the live-system instance of it, which is the one that matters for TOG-310.
#
# This assertion used to hardcode HOLE.  That was true when it was written and
# is not true now: on 2026-08-27 root created /paperclip/.config/git
# (root:root 0755) inside a sticky 1777 /paperclip/.config, which closes the
# exact hole TOG-310 named.  A hardcoded verdict about live host state is a test
# that goes red the day the thing it asks for gets FIXED -- and this one did,
# taking CI red with it and blocking unrelated work.
#
# So the verdict is no longer written down here; it is probed, the way the rest
# of this suite works (see the header): ask the host whether the path is really
# substitutable, then require the audit to agree.  Two independent probes,
# because there are two distinct ways to own that config file:
#
#   write-into  can this uid create /paperclip/.config/git/config itself?
#   displace    can this uid unlink or rename the directory out of the way?
#
# The displace probe is `rmdir` on a NON-EMPTY directory.  It cannot succeed and
# therefore cannot mutate anything; it is run only to read its errno.  EPERM or
# EACCES means the parent genuinely holds, ENOTEMPTY means we had the right and
# were stopped only by the contents.  It is guarded on non-emptiness so it can
# never be the call that actually removes something.  Both probes must say
# "cannot" before this suite will accept OK -- doubt resolves to HOLE.
if [[ -d /paperclip/.config ]]; then
  xdg_dir=/paperclip/.config/git
  # Snapshot BEFORE the audit runs -- this is what makes the side-effect check
  # below able to distinguish "the audit created it" from "it was already there".
  xdg_pre_existed=0; [[ -d "$xdg_dir" ]] && xdg_pre_existed=1

  xdg_want=HOLE
  if [[ $xdg_pre_existed -eq 1 && -n "$(ls -A "$xdg_dir" 2>/dev/null)" ]]; then
    xdg_probe="$xdg_dir/.tog310-probe.$$"
    if touch "$xdg_probe" 2>/dev/null; then
      rm -f "$xdg_probe" 2>/dev/null          # we could write into it: HOLE
    else
      case "$(rmdir "$xdg_dir" 2>&1)" in
        *"Operation not permitted"*|*"Permission denied"*) xdg_want=OK ;;
      esac
    fi
  fi
  note_probe="probed: cannot write into and cannot displace"
  [[ "$xdg_want" == HOLE ]] && note_probe="probed: substitutable by $AS_USER"
  printf '  (%s -> expecting %s)\n' "$note_probe" "$xdg_want"

  expect_path "the audit agrees with a live substitution probe on the XDG global config path" \
    "$xdg_want" "$xdg_dir/config"

  # The audit must not create the path it was asked about.  This is only
  # answerable when the path did not already exist: the previous version ran a
  # bare `rmdir` and then blamed the audit for any directory that survived it,
  # which on this host means accusing the audit of having created a root-owned
  # directory it cannot even write to.  A test that reports a false positive
  # about its own tool gets muted, and then it is not a test.
  if [[ $xdg_pre_existed -eq 0 ]]; then
    rmdir "$xdg_dir" 2>/dev/null
    if [[ -d "$xdg_dir" ]]; then
      bad "audit created $xdg_dir as a side effect"
    else
      ok "audit did not create the path it was asked about"
    fi
  else
    ok "audit did not create the path it was asked about (pre-existing, root-owned)"
  fi
fi

# ---------------------------------------------------------------------------
hdr "3. Symlinks are judged by their target (false-positive regression)"
# lrwxrwxrwx is every symlink on Linux and means nothing.

if [[ -L /bin ]]; then
  expect_path "/bin (symlink into /usr, both root-owned) is not reported writable" OK /bin/sh
fi

# A path is only as strong as every component's name.  This one resolves into
# root-owned /usr/bin, so judging it by the target alone says OK -- but the
# agent owns the link and `ln -sfn` repoints it wherever it likes.  Judging by
# the target alone was the audit's behaviour until this test existed.
ln -sfn /usr/bin "$TMP/link-to-usrbin"
expect_path "an agent-owned symlink component is a hole despite a root-owned target" \
  HOLE "$TMP/link-to-usrbin/git"

# A dangling symlink in a directory the agent owns is a hole, not an oddity:
# creating the target is one command and the link goes live.  Asserted because
# the tempting answer -- "the file isn't there, nothing to see" -- is the same
# fail-open reflex as case 2.
ln -sfn "$TMP/nowhere-at-all" "$TMP/broken-link"
expect_path "a dangling symlink the agent can complete is a hole" HOLE "$TMP/broken-link"

# Where the link points is irrelevant when the link's own name is in reach:
# pointing at root-owned /etc changes nothing, because the agent can just
# replace the symlink.
ln -sfn /etc/gitconfig "$TMP/dangling-into-etc"
expect_path "a symlink aimed at a root-owned path is still a hole if the link is ours" \
  HOLE "$TMP/dangling-into-etc"

# ---------------------------------------------------------------------------
hdr "4. Sticky bit only protects files you do not own"
# /paperclip/.local/bin is drwxr-xr-t and every file in it is node-owned, which
# is why the sticky bit buys nothing there.  Both halves of that are asserted.

mkdir -p "$TMP/sticky"; chmod 1777 "$TMP/sticky"
printf 'x' > "$TMP/sticky/mine"
expect_path "sticky dir, file owned by the principal => substitutable" HOLE "$TMP/sticky/mine"
expect_path "sticky dir, new name => creatable" HOLE "$TMP/sticky/brand-new"

# ---------------------------------------------------------------------------
hdr "5. Chain walk finds the helper program the config names"

HOMEDIR="$TMP/home"; mkdir -p "$HOMEDIR"
cat > "$TMP/helper.js" <<'EOF'
#!/usr/bin/env node
console.log("username=x");
EOF
chmod +x "$TMP/helper.js"
cat > "$HOMEDIR/.gitconfig" <<EOF
[credential "https://github.com"]
	helper =
	helper = !$TMP/helper.js credential
EOF

run_chain() { "$AUDIT" "${AUDIT_ARGS[@]}" --home "$HOMEDIR" --system "$TMP/no-system" --pins "$1" 2>&1; }

PINFILE="$TMP/pins.txt"
helper_sha() { sha256sum "$TMP/helper.js" | cut -d' ' -f1; }
printf 'expected  %s  fixture helper\n' "$(helper_sha)" > "$PINFILE"

out="$(run_chain "$PINFILE")"
if grep -qF "$TMP/helper.js" <<<"$out" && grep -q 'helper program' <<<"$out"; then
  ok "the !-form helper program is resolved out of the config"
else
  bad "helper program not resolved" "$out"
fi

if grep -q 'helper dir' <<<"$out"; then
  ok "the helper's containing directory is audited separately"
else
  bad "helper directory not audited" "$out"
fi

# An empty helper value is git's "discard the list so far" idiom.  It is not a
# program, and treating it as one would put a bogus row in every report -- the
# live /paperclip/.gitconfig has exactly this line.
if grep -qE 'helper program: *$|helper program: cannot stat' <<<"$out"; then
  bad "empty helper value was treated as a program" "$out"
else
  ok "an empty helper value is not mistaken for a program"
fi

# ---------------------------------------------------------------------------
hdr "6. Hash pinning -- 'is this the EXPECTED build', not 'have we seen it'"
# The distinction these assertions defend, and why it is not pedantry: the pin
# file's first form was a flat known-good list, and the incident it was written
# for -- the 2026-08-24 03:32 helper swap -- installed 49cfcd95, a real build
# this repo had shipped and reviewed.  A flat list scores that OK.  Downgrade IS
# the attack: revert the helper to a build predating a fix and the fix is gone
# with every hash still checking out.

# pin_row <pins-file> -- the pin verdict line, ANSI stripped, verdict first.
pin_row() { run_chain "$1" | sed 's/\x1b\[[0-9;]*m//g' | grep -F 'pin:' | head -1; }

row_pin="$(pin_row "$PINFILE")"
if grep -q 'OK' <<<"$row_pin" && grep -q 'matches the expected build' <<<"$row_pin"; then
  ok "the expected build reports OK"
else
  bad "expected build did not report OK" "$row_pin"
fi

# A build this repo shipped once, running where a different one should be.  It
# must be a finding, and it must be distinguishable from a file nobody has ever
# reviewed, because the remedy differs: a rollback/lagging deploy versus an
# unknown binary in the credential path.
{ printf 'expected  %s  a build that is NOT live\n' "$(printf 'not-the-live-one' | sha256sum | cut -d' ' -f1)"
  printf 'reviewed  %s  the live fixture, shipped once, now superseded\n' "$(helper_sha)"
} > "$TMP/pins-downgrade.txt"
row_stale="$(pin_row "$TMP/pins-downgrade.txt")"
if grep -q 'HOLE' <<<"$row_stale" && grep -q 'pin: STALE' <<<"$row_stale"; then
  ok "a downgrade to a previously reviewed build is a HOLE, not OK"
else
  bad "a downgrade to a previously reviewed build is a HOLE, not OK" "$row_stale"
fi

printf 'console.log("tampered");\n' >> "$TMP/helper.js"
row_drift="$(pin_row "$PINFILE")"
if grep -q 'HOLE' <<<"$row_drift" && grep -q 'pin: DRIFT' <<<"$row_drift"; then
  ok "editing the helper is reported as DRIFT"
else
  bad "helper tampering was not detected" "$row_drift"
fi
# ...and DRIFT and STALE must not be the same word, or the report cannot tell an
# unreviewed file from a superseded one.
if grep -q 'pin: STALE' <<<"$row_drift"; then
  bad "an unreviewed build was reported as STALE" "$row_drift"
else
  ok "an unreviewed build is DRIFT, not STALE"
fi
printf 'expected  %s  fixture helper\n' "$(helper_sha)" > "$PINFILE"   # re-pin the tampered fixture

out_nopins="$(run_chain "$TMP/pins-that-do-not-exist.txt")"
if grep -q 'pin: no pin file' <<<"$out_nopins"; then
  ok "a missing pin file is indeterminate, not a silent pass"
else
  bad "missing pin file did not register" "$out_nopins"
fi

# Every way of not being able to answer must land on INDETERMINATE.  A pin file
# the audit cannot make sense of has told it nothing about the live helper, and
# "nothing" must not be spelled the same way as "fine" -- these are the shapes a
# half-finished edit to the real pin file leaves behind.
pins_indet() {
  local desc="$1" want="$2" file="$3" r
  r="$(pin_row "$file")"
  if grep -q 'INDET' <<<"$r" && grep -qF "$want" <<<"$r"; then ok "$desc"
  else bad "$desc" "$r"; fi
}

printf 'reviewed  %s  no expected line anywhere\n' "$(helper_sha)" > "$TMP/pins-no-expected.txt"
pins_indet "a pin file with no expected build is INDETERMINATE, not a pass" \
  "no expected build declared" "$TMP/pins-no-expected.txt"

{ printf 'expected  %s  one\n' "$(helper_sha)"
  printf 'expected  %s  two\n' "$(printf 'other' | sha256sum | cut -d' ' -f1)"
} > "$TMP/pins-two-expected.txt"
pins_indet "two expected builds is ambiguous, and refused rather than picked" \
  "pin file unusable" "$TMP/pins-two-expected.txt"

printf 'blessed  %s  unknown state word\n' "$(helper_sha)" > "$TMP/pins-bad-state.txt"
pins_indet "an unknown state word is refused, not ignored" \
  "pin file unusable" "$TMP/pins-bad-state.txt"

# The old flat format, exactly as it was before this change.  It must not be
# silently accepted: read as <state><sha>, its first field is a hash and its
# second is prose, so accepting it leniently would mean a file that pins
# nothing reads as a file that pins everything.
printf '%s  bare hash, pre-2026-08-25 format\n' "$(helper_sha)" > "$TMP/pins-legacy.txt"
pins_indet "the superseded flat format is refused, not read as expected" \
  "pin file unusable" "$TMP/pins-legacy.txt"

# ---------------------------------------------------------------------------
hdr "6b. The pin file shipped in this repo must stay in step with the helper"
# This is the assertion that stops the control dying of false positives.
# TOG-238 changed gh-app-token.js and merged without repinning; when that build
# was deployed the audit reported DRIFT against the reviewed tip of main --
# a red verdict on the correct state, which is how a detector gets muted.
# tool_drift.sh's header names the general rule: a committed hash list "would be
# wrong the first time anyone landed a PR, and a drift detector that cries wolf
# gets muted."  CI is what keeps this list from being that: a PR that changes
# the helper without moving the `expected` line fails here, in the PR that
# caused it, not weeks later on someone else's console.
#
# Retirement: the App-token minter was deleted (pushes use the Paperclip
# built-in GitHub connection), so a checkout with NEITHER file is the
# expected end state, not drift -- there is nothing left to pin. Exactly one
# file present is a half-finished removal and still fails.
REAL_PINS="$HERE/credential_chain_pins.txt"
REAL_HELPER="$HERE/gh-app-token.js"
if [[ -r "$REAL_PINS" && -r "$REAL_HELPER" ]]; then
  exp_line="$(grep -c '^expected  ' "$REAL_PINS")"
  if [[ "$exp_line" == "1" ]]; then
    ok "credential_chain_pins.txt declares exactly one expected build"
  else
    bad "credential_chain_pins.txt declares exactly one expected build" \
      "declares $exp_line"
  fi
  exp_sha="$(awk '$1=="expected"{print $2}' "$REAL_PINS" | head -1)"
  repo_sha="$(sha256sum "$REAL_HELPER" | cut -d' ' -f1)"
  if [[ "$exp_sha" == "$repo_sha" ]]; then
    ok "the expected pin is the sha256 of gh-app-token.js in this checkout"
  else
    bad "the expected pin is the sha256 of gh-app-token.js in this checkout" \
      "gh-app-token.js changed and the pin did not -- repin it in THIS PR:
  expected pin: ${exp_sha:-<none>}
  repo helper:  $repo_sha"
  fi
  malformed="$(awk '!/^#/ && NF { if ($1 != "expected" && $1 != "reviewed") print NR": "$1; else if ($2 !~ /^[0-9a-f]{64}$/) print NR": "$2 }' "$REAL_PINS")"
  if [[ -z "$malformed" ]]; then
    ok "every line of credential_chain_pins.txt parses as <state> <sha256>"
  else
    bad "every line of credential_chain_pins.txt parses as <state> <sha256>" "$malformed"
  fi
elif [[ ! -e "$REAL_PINS" && ! -e "$REAL_HELPER" ]]; then
  ok "minter retired: no pin file and no helper, nothing to pin"
elif [[ -e "$REAL_PINS" ]]; then
  bad "credential_chain_pins.txt is present but gh-app-token.js is gone -- finish the retirement, delete the pin file too"
else
  bad "gh-app-token.js is present but credential_chain_pins.txt is gone -- an unpinned helper is what this section exists to catch, repin it in THIS PR"
fi

# ---------------------------------------------------------------------------
hdr "7. Exit-code discipline -- the audit must never report clean on doubt"

"$AUDIT" "${AUDIT_ARGS[@]}" --check-path /usr/bin/git >/dev/null 2>&1
[[ $? -eq 0 ]] && ok "clean path exits 0" || bad "clean path did not exit 0"

"$AUDIT" "${AUDIT_ARGS[@]}" --check-path "$TMP/owned-by-me" >/dev/null 2>&1
[[ $? -eq 1 ]] && ok "hole exits 1" || bad "hole did not exit 1"

"$AUDIT" --as-uid no-such-user-here >/dev/null 2>&1
[[ $? -eq 2 ]] && ok "unknown principal is an error, not a clean run" || bad "unknown principal did not exit 2"

# Auditing as root would score every link OK, because root is not subject to the
# bits this tool reads.  It must refuse rather than produce that report.
out_root="$("$AUDIT" --as-uid root 2>&1)"; rc_root=$?
if [[ $rc_root -eq 2 ]] && grep -q 'meaningless' <<<"$out_root"; then
  ok "--as-uid root is refused rather than answered"
else
  bad "auditing as root was not refused (rc=$rc_root)" "$out_root"
fi

"$AUDIT" --nonsense-flag >/dev/null 2>&1
[[ $? -eq 2 ]] && ok "unknown flag exits 2" || bad "unknown flag did not exit 2"

# An unreadable config file is the fail-open case: the audit cannot see what
# helpers it names, so it must not count that file as clean.
mkdir -p "$TMP/unreadable-home"
printf '[credential]\n\thelper = !/bin/true\n' > "$TMP/unreadable-home/.gitconfig"
chmod 0000 "$TMP/unreadable-home/.gitconfig"
out_unread="$("$AUDIT" "${AUDIT_ARGS[@]}" --home "$TMP/unreadable-home" --system "$TMP/no-system" --pins "$PINFILE" 2>&1)"
rc_unread=$?
chmod 0644 "$TMP/unreadable-home/.gitconfig"
if grep -q 'unreadable; helpers unknown' <<<"$out_unread" && [[ $rc_unread -ne 0 ]]; then
  ok "an unreadable config is flagged and never exits 0"
else
  bad "unreadable config was not flagged (rc=$rc_unread)" "$out_unread"
fi

# That same run carries a hole (the config is node-owned) and an indeterminate
# (its contents are unreadable), which pins the precedence rule: a hole is a
# finding, an indeterminate is only an absence of one, so 1 wins over 3.
if [[ $rc_unread -eq 1 ]]; then
  ok "a run with both a hole and an indeterminate exits 1"
else
  bad "hole did not outrank indeterminate (rc=$rc_unread)"
fi

# Note on exit 3 standalone: reaching it requires a link the audit can neither
# stat nor rule out, and as an agent uid on this host that combination does not
# occur -- everything node cannot stat is root-owned, which is a clean OK.  The
# reachable no-fail-open guards are the two above and the missing-pin-file case
# in section 6.  Exit 3 stays wired for hosts laid out differently.

# ---------------------------------------------------------------------------
hdr "8. The live chain, for the record"
# Not an assertion about the host -- this suite has to keep passing after the
# operator applies the fix and the holes go away.  It asserts only that the
# audit produces a verdict for the two links TOG-310 turns on.
# Everything above is host-independent and runs anywhere, including a GitHub
# runner where /paperclip does not exist.  This last section only means
# something inside the agent container, so it is skipped rather than failed
# elsewhere -- a suite that fails in CI for being in CI gets switched off.
if [[ -d /paperclip/.local/bin ]]; then
  # --home is pinned rather than inherited: this section asserts something about
  # the container's real HOME, and reading it from the environment makes the
  # assertion depend on who exported what.
  live="$("$AUDIT" "${AUDIT_ARGS[@]}" --home /paperclip --pins "$HERE/credential_chain_pins.txt" 2>&1)"
  for link in /paperclip/.gitconfig /paperclip/.local/bin; do
    if grep -qF "$link" <<<"$live"; then ok "live chain reports on $link"
    else bad "live chain never mentions $link" "$live"; fi
  done
else
  printf '  \033[33mSKIP\033[0m  not in the agent container; live-chain checks skipped\n'
fi

# ---------------------------------------------------------------------------
hdr "9. Staged root-run scripts must drift loudly (--staged)"
# TOG-310's own remediation was staged at /paperclip/operator-handoff as a
# node-owned file the operator was asked to `podman exec -u root`.  Any agent
# could have rewritten it in the twelve hours it sat there.  The control is
# detection: the staged mirror is compared against its reviewed source in git.
#
# These assertions read ROWS, not the exit code, on purpose.  The staged check
# only runs inside a full chain walk, and on this host the chain walk always
# finds holes of its own -- so exit 1 would pass whether or not the staged
# logic ran at all.  A test that cannot fail is not a test.

mkdir -p "$TMP/home"
MAN="$TMP/manifest.txt"
printf 'canonical\n' > "$TMP/source.sh"
# Manifest sources are repo-relative in production; the audit also accepts an
# absolute path, which is what lets these fixtures live under $TMP.
printf '%s\t%s\n' "$TMP/staged.sh" "$TMP/source.sh" > "$MAN"

# staged_verdict -> the audit's row for the fixture mirror, colour stripped
staged_verdict() {
  "$AUDIT" "${AUDIT_ARGS[@]}" --home "$TMP/home" --staged-manifest "${1:-$MAN}" 2>&1 \
    | sed 's/\x1b\[[0-9;]*m//g' | grep -F "${2:-$TMP/staged.sh}"
}

# (a) mirror matches the reviewed source
cp "$TMP/source.sh" "$TMP/staged.sh"
got="$(staged_verdict)"
if grep -q '^ *OK' <<<"$got"; then ok "a mirror identical to its source reads OK"
else bad "identical mirror did not read OK" "$got"; fi

# (b) mirror edited out from under the operator -- the case that matters
printf 'tampered\n' >> "$TMP/staged.sh"
got="$(staged_verdict)"
if grep -q '^ *HOLE' <<<"$got" && grep -q 'DRIFT' <<<"$got"; then
  ok "a tampered mirror is a HOLE and says DRIFT"
else
  bad "tampered mirror did not read as DRIFT" "$got"
fi

# (c) not staged at all is the desired end state, not a finding
rm -f "$TMP/staged.sh"
got="$(staged_verdict)"
if grep -q '^ *OK' <<<"$got"; then ok "an absent mirror reads OK (nothing to root-run)"
else bad "absent mirror did not read OK" "$got"; fi

# (d) a manifest naming a source that is not in the checkout must not read OK.
# This is the fail-open shape: no source to compare against means the mirror is
# unverified, and unverified must never be indistinguishable from verified.
printf 'mirror\n' > "$TMP/staged.sh"
printf '%s\t%s\n' "$TMP/staged.sh" "$TMP/no-such-source.sh" > "$MAN"
got="$(staged_verdict)"
if grep -q '^ *INDET' <<<"$got"; then ok "a missing canonical source is INDETERMINATE, not OK"
else bad "missing source did not read INDET" "$got"; fi

# (e) an unreadable manifest must not silently check nothing and look clean
got="$(staged_verdict "$TMP/no-manifest" "no-manifest")"
if grep -q '^ *INDET' <<<"$got"; then ok "an unreadable manifest is INDETERMINATE, not silence"
else bad "unreadable manifest was not reported" "$got"; fi

# (f) and the check must stay opt-in: without --staged there is no staged row,
# so the existing callers and CI keep their current verdicts.
got="$("$AUDIT" "${AUDIT_ARGS[@]}" --home "$TMP/home" 2>&1 | sed 's/\x1b\[[0-9;]*m//g')"
if grep -qF "$TMP/staged.sh" <<<"$got"; then
  bad "staged rows appeared without --staged" "$got"
else
  ok "no staged rows without --staged"
fi

# (g) the real manifest shipped in this repo must name sources that exist.
# Without this, deleting or renaming credential_chain_lockdown.sh degrades the
# live check to INDET and nothing notices.
if [[ -r "$HERE/staged_root_scripts.txt" ]]; then
  missing=""
  while IFS=$'\t' read -r _staged src; do
    [[ -z "${_staged// }" || "$_staged" == \#* ]] && continue
    src="${src// }"
    [[ -n "$src" && ! -r "$HERE/$src" ]] && missing="$missing $src"
  done < "$HERE/staged_root_scripts.txt"
  if [[ -z "$missing" ]]; then ok "every source in staged_root_scripts.txt exists"
  else bad "staged_root_scripts.txt names missing source(s):$missing"; fi
fi

# ---------------------------------------------------------------------------
printf '\n\033[1m%d passed, %d failed\033[0m\n\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]] || exit 1
