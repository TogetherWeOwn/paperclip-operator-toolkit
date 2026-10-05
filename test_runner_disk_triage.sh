#!/usr/bin/env bash
# Regression suite for runner_disk_triage.sh.
#
# Fully offline: every case points the triage at a fixture tree under mktemp
# via the TRIAGE_* overrides, so no live worktree, container root, lxc or zfs
# is ever touched. No credential, network, or host privilege is used.
#
# What it pins:
#   1. ENUMERATION — fixture node_modules/vendor caches are sized and named
#      in text output; --format json parses and carries the same suspects.
#   2. DF FIXTURES — TRIAGE_DF_FILE / TRIAGE_DFI_FILE content appears verbatim.
#   3. LXD FIXTURE — TRIAGE_LXD_INFO_FILE content appears; an absent LXD
#      reports UNAVAILABLE and still exits 0.
#   4. REFUSAL — every write-intent flag exits 2 with REFUSE and leaves the
#      fixture byte-identical (sha snapshot before/after).
#   5. LOAD-BEARING GATE — a mutant with the refusal block deleted accepts
#      --apply (exit 0), proving case 4 measures the gate and not the fixture.
#   6. STATIC READ-ONLY — outside refuse_arg/usage/comments, no write verb is
#      ever invoked as a command, and find never carries -delete/-exec/-ok.
#      Each pattern is first matched against a planted mutant line, so an
#      over-broad pattern cannot silently pass.
#   7. NO SECRET LEAK — a sentinel env value never appears in any output.
#
# Exit 0 all pass; 1 any failure.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRIAGE="$HERE/runner_disk_triage.sh"
PASS=0; FAIL=0
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[[ -x "$TRIAGE" ]] || { echo "ERROR: $TRIAGE not found or not executable" >&2; exit 2; }

ok()  { PASS=$((PASS+1)); printf 'ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL %s\n     %s\n' "$1" "${2:-}"; }

# ---- fixture tree -----------------------------------------------------------
# worktrees/<name>/{node_modules,vendor} with known payload sizes.
mkdir -p "$WORK/wt/alpha/node_modules" "$WORK/wt/alpha/vendor" \
         "$WORK/wt/beta/node_modules" "$WORK/docker" "$WORK/podman"
head -c 20480 /dev/zero > "$WORK/wt/alpha/node_modules/blob.bin" 2>/dev/null
head -c 10240 /dev/zero > "$WORK/wt/alpha/vendor/lib.bin" 2>/dev/null
head -c 5120 /dev/zero > "$WORK/wt/beta/node_modules/b.bin" 2>/dev/null
head -c 3072 /dev/zero > "$WORK/docker/layer.bin" 2>/dev/null
printf 'Filesystem      Size  Used Avail Use%% Mounted on\n/dev/sda1        50G   45G  5.0G  90%% /\n' > "$WORK/df.txt"
printf 'Filesystem     Inodes IUsed IFree IUse%% Mounted on\n/dev/sda1       1M  900K  100K  90%% /\n' > "$WORK/dfi.txt"
printf 'pool lxd-pool driver zfs size 42GB used 38GB\n' > "$WORK/lxd.txt"

TRIAGE_ENV=(env -i PATH="$PATH" HOME="$WORK"
  "TRIAGE_WORKTREE_ROOT=$WORK/wt"
  "TRIAGE_DOCKER_ROOT=$WORK/docker"
  "TRIAGE_PODMAN_ROOT=$WORK/podman"
  "TRIAGE_DF_FILE=$WORK/df.txt"
  "TRIAGE_DFI_FILE=$WORK/dfi.txt"
  "TRIAGE_LXD_INFO_FILE=$WORK/lxd.txt")

# ---- 1. text enumeration names and sizes the fixture caches -----------------
OUT="$("${TRIAGE_ENV[@]}" bash "$TRIAGE" 2>&1)"; RC=$?
[[ "$RC" == "0" ]] && ok "plain run exits 0" || bad "plain run exit" "got $RC: $OUT"
grep -q "alpha/node_modules" <<<"$OUT" && ok "names alpha node_modules" || bad "alpha node_modules named" "$OUT"
grep -q "alpha/vendor" <<<"$OUT" && ok "names alpha vendor" || bad "alpha vendor named" "$OUT"
grep -q "beta/node_modules" <<<"$OUT" && ok "names beta node_modules" || bad "beta node_modules named" "$OUT"
grep -q "45G" <<<"$OUT" && ok "df fixture surfaced" || bad "df fixture" "$OUT"
grep -q "900K" <<<"$OUT" && ok "inode fixture surfaced" || bad "inode fixture" "$OUT"
grep -q "lxd-pool" <<<"$OUT" && ok "lxd fixture surfaced" || bad "lxd fixture" "$OUT"
grep -q "operator-runbook\|operator-owned runbook\|operator-executed" <<<"$OUT" && ok "runbook owner named" || bad "runbook owner" "$OUT"

# ---- 2. json mode parses and carries the same suspects ----------------------
JOUT="$("${TRIAGE_ENV[@]}" bash "$TRIAGE" --format json 2>&1)"; RC=$?
[[ "$RC" == "0" ]] && ok "json run exits 0" || bad "json run exit" "got $RC: $JOUT"
if python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["read_only"] is True; assert any("alpha/node_modules" in s["path"] for s in d["suspects"]), "suspects missing"; assert d["runbook_owner"]=="operator-runbook"' <<<"$JOUT" 2>/dev/null; then
  ok "json parses with suspects + owner"
else
  bad "json shape" "$JOUT"
fi

# ---- 3. absent LXD reports UNAVAILABLE, still exit 0 -------------------------
LOUT="$(env -i PATH="$PATH" HOME="$WORK" "TRIAGE_WORKTREE_ROOT=$WORK/wt" \
  "TRIAGE_DOCKER_ROOT=$WORK/docker" "TRIAGE_PODMAN_ROOT=$WORK/podman" \
  "TRIAGE_DF_FILE=$WORK/df.txt" "TRIAGE_DFI_FILE=$WORK/dfi.txt" \
  bash "$TRIAGE" 2>&1)"; RC=$?
# (no lxc/zfs fixture and neither binary is expected on the runner; if one is
# present the live read-only probe runs instead — either way exit must be 0.)
[[ "$RC" == "0" ]] && ok "no-lxd run exits 0" || bad "no-lxd exit" "got $RC: $LOUT"

# ---- 4. every write-intent flag refuses and changes nothing -----------------
snapshot() { find "$WORK/wt" "$WORK/docker" -type f -exec sha256sum {} + 2>/dev/null | sort; }
BEFORE="$(snapshot)"
for flag in --apply --clean --delete --prune --fix --rm --kill --reclaim --purge --wipe --exec apply delete prune; do
  ROUT="$("${TRIAGE_ENV[@]}" bash "$TRIAGE" "$flag" 2>&1)"; RRC=$?
  if [[ "$RRC" == "2" ]] && grep -q "REFUSE" <<<"$ROUT"; then
    ok "refuses $flag (exit 2)"
  else
    bad "refuses $flag" "exit $RRC: $ROUT"
  fi
done
AFTER="$(snapshot)"
[[ "$BEFORE" == "$AFTER" ]] && ok "fixtures unchanged across refusals" || bad "fixtures changed" "$(diff <(printf '%s' "$BEFORE") <(printf '%s' "$AFTER") | head -5)"

# ---- 5. the refusal gate is load-bearing (mutant control) -------------------
MUTANT="$WORK/mutant.sh"
python3 - "$TRIAGE" "$MUTANT" <<'EOF'
import re, sys
src = open(sys.argv[1]).read()
start = src.index('# MUTATION-ANCHOR-START')
end = src.index('# MUTATION-ANCHOR-END')
open(sys.argv[2], 'w').write(src[:start] + src[end + len('# MUTATION-ANCHOR-END'):])
EOF
bash -n "$MUTANT" || { bad "mutant parses" "mutant is not a valid control"; }
MOUT="$("${TRIAGE_ENV[@]}" bash "$MUTANT" --apply 2>&1)"; MRC=$?
if [[ "$MRC" == "0" ]] && ! grep -q "REFUSE" <<<"$MOUT"; then
  ok "mutant without gate accepts --apply (gate is load-bearing)"
else
  bad "mutant control" "exit $MRC: $MOUT"
fi

# ---- 6. static read-only scan (patterns proven on planted lines first) ------
# Code under test: strip full-line comments, then cut out refuse_arg + usage
# (they legitimately NAME the write intents in patterns and help text).
CODE="$WORK/code.sh"
python3 - "$TRIAGE" "$CODE" <<'EOF'
import re, sys
src = open(sys.argv[1]).read()
src = re.sub(r'(?m)^refuse_arg\(\) \{.*?\n\}\n', '', src, flags=re.S)
src = re.sub(r'(?m)^usage\(\) \{.*?\n\}\n', '', src, flags=re.S)
lines = [l for l in src.split('\n') if not re.match(r'^\s*#', l)]
lines = [l.split('#')[0] for l in lines]
open(sys.argv[2], 'w').write('\n'.join(lines))
EOF
# Each forbidden command pattern must fire on its planted mutant line...
check_pat() { # <label> <ere> <planted-line>
  if grep -qE "$2" <<<"$3"; then
    : # pattern is live
  else
    bad "pattern live: $1" "pattern fails its own planted line"; return 1
  fi
  if grep -qE "$2" "$CODE"; then
    bad "static read-only: $1" "$(grep -E "$2" "$CODE" | head -3)"; return 1
  else
    ok "no $1 in triage code"; return 0
  fi
}
CMD='(^|[;|&(`$]|[[:space:]])(rm|rmdir|unlink|shred|truncate|dd|chmod|chown|mktemp|kill|pkill|systemctl|reboot|shutdown|mv|cp|touch|mkdir)([[:space:];]|$)'
check_pat "write commands" "$CMD" '  rm -rf /x'
check_pat "find mutations" 'find[^#]*(-delete|-exec|-ok)' 'find /x -delete'
check_pat "container mutations" '(docker[^#]*(rm|prune)|lxc[^#]*(delete|remove|storage delete|exec))' 'docker rm c'
check_pat "redirections that write" '(>|>>)[[:space:]]*/(var|home|etc)' 'echo x > /var/lib/docker/z'

# ---- 7. no secret leak -------------------------------------------------------
SENTINEL="SENTINEL_TRIAGE_SECRET_MUST_NEVER_APPEAR_9f3k"
SOUT="$(SENTINEL="$SENTINEL" "${TRIAGE_ENV[@]}" bash "$TRIAGE" 2>&1)"
SOUT_JSON="$(SENTINEL="$SENTINEL" "${TRIAGE_ENV[@]}" bash "$TRIAGE" --json 2>&1)"
if grep -q "$SENTINEL" <<<"$SOUT$SOUT_JSON"; then
  bad "secret leak" "sentinel env value appears in output"
else
  ok "sentinel env value never printed"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" == "0" ]]
