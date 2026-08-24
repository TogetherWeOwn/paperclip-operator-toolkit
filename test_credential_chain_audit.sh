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
if [[ -d /paperclip/.config ]]; then
  expect_path "the XDG global config path is a hole on this host" \
    HOLE /paperclip/.config/git/config
  rmdir /paperclip/.config/git 2>/dev/null   # audit must not have created it
  if [[ -d /paperclip/.config/git ]]; then
    bad "audit created /paperclip/.config/git as a side effect"
  else
    ok "audit did not create the path it was asked about"
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
sha256sum "$TMP/helper.js" | awk '{print $1"  fixture helper"}' > "$PINFILE"

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
hdr "6. Hash pinning"

if grep -q 'pin: matches known-good' <<<"$out"; then
  ok "a pinned helper reports as matching"
else
  bad "pinned helper did not match" "$out"
fi

printf 'console.log("tampered");\n' >> "$TMP/helper.js"
out_drift="$(run_chain "$PINFILE")"
if grep -q 'pin: DRIFT' <<<"$out_drift"; then
  ok "editing the helper is reported as DRIFT"
else
  bad "helper tampering was not detected" "$out_drift"
fi

out_nopins="$(run_chain "$TMP/pins-that-do-not-exist.txt")"
if grep -q 'pin: no pin file' <<<"$out_nopins"; then
  ok "a missing pin file is indeterminate, not a silent pass"
else
  bad "missing pin file did not register" "$out_nopins"
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
