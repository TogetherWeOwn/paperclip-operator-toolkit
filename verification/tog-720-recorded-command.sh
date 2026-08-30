#!/usr/bin/env bash
# ===========================================================================
# tog-720-recorded-command.sh — proof that the command TOG-720's monitor runs
# every cycle is still runnable from a clean tree.
# ---------------------------------------------------------------------------
# TOG-720 is a card that exists to hold a clock. Its heartbeat runs one
# command, and that command lives in prose: in the issue description, and
# (separately) in the issue's monitorNotes. Prose has no gate that ever
# executes it. On 2026-08-30 the card carried the same command in two places,
# one of them said to run `./discord_job_health_monitor.sh` bare, and the
# shared workspace was 52 commits behind main on a feature branch where that
# script does not exist -- exit 127. A wrapper that never runs never re-arms,
# so that failure does not retry in an hour. It stops the clock permanently
# and silently. Nothing was red. Nothing was going to go red.
#
# The half-fix is the trap this file exists to close. CI already runs both
# scripts, but it runs them BY PATH from ci.yml. Rename either one and update
# ci.yml in the same commit -- the obvious, careful thing to do -- and CI stays
# green while the recorded command silently starts exiting 128. The paths are
# load-bearing for something no test executes.
#
# So this gate reads the command from verification/tog-720-recorded-command.txt,
# which is the checked-in copy of what the card says, and proves:
#
#   * every repo path the command names still resolves in this tree
#   * the command's files are a CLOSED set AND are in the LAYOUT the wrapper
#     needs: extracted alone into an otherwise empty directory, the wrapper
#     gets all the way past resolving its detector. The wrapper resolves the
#     detector as "$HERE/scripts/discord_job_health.js" -- a path that is
#     hardcoded in the wrapper and appears nowhere in ci.yml or in the .txt.
#     So the recorded command can name a detector that exists, at a path the
#     wrapper will never look in. Existence checks cannot see that.
#
# ---------------------------------------------------------------------------
# WHY THE PROBE IS DIFFERENTIAL, AND NOT `--help`
#
# The first version of this file ran `"$wrapper" --help` as the closed-set
# proof. That probe was vacuous. `--help` is handled in the argument loop,
# which returns at discord_job_health_monitor.sh:79 -- sixteen lines BEFORE
# the wrapper ever resolves its detector at :95. Measured 2026-08-30: a
# directory containing the wrapper and NOTHING ELSE passes `--help` with
# exit 0. The limb advertised as the one an existence check would miss was
# the one limb that could not fail, and it scored a PASS on every run.
#
# It looked mutation-controlled because it was not: all three mutants were
# killed by the path-existence limb above it, so the closed-set limb was
# never the thing under test. The mutant that isolates it -- move the
# detector to lib/ and update the .txt to match, exactly what a careful
# developer does -- was not in the set. It is now (mutant 4), and against
# the `--help` probe it passed.
#
# The replacement does not assert an exit code or grep for a message,
# because either would fail open the moment the wrapper reorders its checks:
# if the API-credential check moved above the detector check, a fixed
# rc/string assertion would still be satisfied while measuring nothing.
#
# Instead it runs the wrapper TWICE and requires the two runs to DISAGREE:
#
#   POS  the extracted tree, exactly as the recorded command builds it
#   NEG  the same tree with the detector deleted -- the baseline that MUST
#        be refused
#
# If POS and NEG produce the same outcome, this probe is not measuring
# detector resolution at all, and that is scored a FAILURE of this gate
# rather than a pass. A guard whose baseline does not refuse first cannot
# distinguish "the tree is good" from "nothing is being checked".
#
# Both runs are credential-free: PAPERCLIP_API_URL and PAPERCLIP_API_KEY are
# unset for them, so the wrapper halts at its own `:?` guard immediately
# after the detector check. It never runs the detector, never opens a socket,
# and never touches the monitor. This gate is offline and read-only.
#
# And then it proves it can go red, because a check that cannot fail is not
# evidence. Each mutation is applied to a scratch copy and the gate is re-run
# against it; a mutation the gate does not catch is a failure of this file.
# A mutation that does not actually change the input is also a failure -- a
# sed or mv that matched nothing would otherwise score as a kill.
#
# Exit 0 only if the live tree passes AND every mutant is caught.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
RECORDED="${TOG720_RECORDED:-$HERE/tog-720-recorded-command.txt}"
PASS=0; FAIL=0

ok()  { printf '  \033[32m  PASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31m  FAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

[ -f "$RECORDED" ] || { echo "FATAL: no recorded-command file at $RECORDED" >&2; exit 4; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tog720_recorded.XXXXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# recorded_paths <recorded-file>
# The repo paths the command names, as `origin/main:<path>` arguments to
# git show. Anchored on that form rather than on script names, so a rename
# cannot slip past by editing the .txt: if the .txt names a path, we check it.
recorded_paths() {
  sed -n '/BEGIN RECORDED COMMAND/,/END RECORDED COMMAND/p' "$1" \
    | grep -oE 'origin/main:[A-Za-z0-9._/-]+' | sed 's|^origin/main:||' | sort -u
}

# run_wrapper <tree> <wrapper> -- one credential-free invocation of the
# extracted wrapper, from inside the tree. Echoes "<rc>|<first line of stderr>".
#
# The tree's own path is scrubbed out of the message and replaced with a
# fixed token. Every tree here is a fresh mktemp directory, so an unscrubbed
# message embeds a unique random path -- which made two IDENTICAL outcomes
# ("detector not found" in both runs) compare as different and read as a
# working differential. Measured 2026-08-30 against mutant 4: it passed a
# broken tree until this scrub was added. Normalise anything that varies
# per-run before comparing two runs, or the comparison measures the
# scratch-directory name.
#
# --issue is passed so the run does not depend on PAPERCLIP_TASK_ID being
# set or unset in the surrounding environment; the id is never used, because
# the wrapper halts on the missing API URL long before it would be.
run_wrapper() {
  local tree="$1" wrapper="$2" err rc line abs
  err="$WORK/probe.err.$$"
  ( cd "$tree" && env -u PAPERCLIP_API_URL -u PAPERCLIP_API_KEY \
      "./$(basename "$wrapper")" --issue TOG720GATE ) >/dev/null 2>"$err"
  rc=$?
  line="$(head -1 "$err" | tr -d '\r')"
  rm -f "$err"
  abs="$(cd "$tree" && pwd)"
  # Scrub both the resolved path and the literal, and also $WORK, in case a
  # message names a sibling scratch directory rather than the tree itself.
  line="${line//$abs/<TREE>}"
  line="${line//$tree/<TREE>}"
  line="${line//$WORK/<WORK>}"
  printf '%s|%s' "$rc" "$line"
}

# --- the check itself, factored so the mutation control can re-run it --------
# Takes a tree root and a recorded-command file. Prints diagnostics. Returns 0
# only if every named path resolves AND the differential layout probe holds.
check_tree() {
  local root="$1" recorded="$2" out="$3"
  local rc=0 paths path n=0

  paths="$(recorded_paths "$recorded")"

  if [ -z "$paths" ]; then
    echo "    no repo paths found in the recorded command block" >>"$out"
    return 1
  fi

  local ext="$WORK/extract.$$.$RANDOM"
  rm -rf "$ext"; mkdir -p "$ext"

  while IFS= read -r path; do
    [ -n "$path" ] || continue
    n=$((n+1))
    if [ -f "$root/$path" ]; then
      echo "    resolves: $path" >>"$out"
      mkdir -p "$ext/$(dirname "$path")"
      cp "$root/$path" "$ext/$path"
    else
      echo "    MISSING:  $path" >>"$out"
      rc=1
    fi
  done <<EOF
$paths
EOF

  [ "$n" -ge 2 ] || { echo "    expected at least 2 paths, found $n" >>"$out"; rc=1; }
  [ "$rc" -eq 0 ] || { rm -rf "$ext"; return 1; }

  # Closed-set + layout proof. The extracted tree contains ONLY the files the
  # recorded command names, at the paths it names them. If the wrapper needs
  # anything else from the repo, or looks for the detector somewhere the
  # recorded command does not put it, this is where it shows up.
  local wrapper
  wrapper="$(find "$ext" -maxdepth 1 -name '*_monitor.sh' -print -quit)"
  if [ -z "$wrapper" ]; then
    echo "    no monitor wrapper among the extracted files" >>"$out"
    rm -rf "$ext"; return 1
  fi
  chmod +x "$wrapper"

  local pos neg
  pos="$(run_wrapper "$ext" "$wrapper")"

  # The baseline that must be refused: same tree, detector deleted. Anything
  # extracted that is not the wrapper is a file the command supplies to it.
  local neg_tree="$WORK/negctl.$$.$RANDOM"
  rm -rf "$neg_tree"; cp -R "$ext" "$neg_tree"
  local removed=0 wbase
  wbase="$(basename "$wrapper")"
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    [ "$path" = "$wbase" ] && continue
    if [ -f "$neg_tree/$path" ]; then rm -f "$neg_tree/$path"; removed=$((removed+1)); fi
  done <<EOF
$paths
EOF

  if [ "$removed" -eq 0 ]; then
    # Nothing to take away means there is no negative control, so the
    # comparison below would be meaningless. Never score that as a pass.
    echo "    no non-wrapper file to remove; negative control is impossible" >>"$out"
    rm -rf "$ext" "$neg_tree"; return 1
  fi
  neg="$(run_wrapper "$neg_tree" "$wrapper")"

  # The DECOY control. POS != NEG establishes that the wrapper's outcome is
  # sensitive to SOMETHING about the tree. It does not establish that the
  # something is the detector. A wrapper that never resolves the detector but
  # whose output varies with tree CONTENT -- a file count, a directory
  # listing, a checksum of the working directory -- differs between POS and
  # NEG for a reason that has nothing to do with the layout, and the
  # difference-only rule reads that as a working differential.
  #
  # Measured 2026-08-30 against the POS/NEG-only version of this probe: a
  # wrapper replaced by `echo "stub: $(find . -type f | wc -l) files"; exit 0`
  # scored PASS. It resolves nothing at all. NEG has one file fewer than POS,
  # so the two runs disagreed, and disagreement was the whole test.
  #
  # So perturb the tree in a way the recorded command does NOT name, and
  # require the outcome to be UNCHANGED. A wrapper that resolves exactly its
  # own hardcoded detector path cannot notice a file it never looks for; a
  # wrapper that is merely reacting to the shape of the directory will. If
  # DECOY differs from POS, the POS/NEG difference is not attributable to
  # detector resolution and this gate has measured nothing -- scored a
  # FAILURE, like the vacuous case, not a pass.
  local decoy_tree="$WORK/decoy.$$.$RANDOM"
  rm -rf "$decoy_tree"; cp -R "$ext" "$decoy_tree"
  # A name no recorded command will ever contain, at the top level where a
  # content-sensitive wrapper is most likely to see it.
  printf 'not named by the recorded command\n' > "$decoy_tree/.tog720-decoy-file"
  [ -f "$decoy_tree/.tog720-decoy-file" ] || {
    echo "    could not place the decoy file; the control is impossible" >>"$out"
    rm -rf "$ext" "$neg_tree" "$decoy_tree"; return 1
  }
  local decoy
  decoy="$(run_wrapper "$decoy_tree" "$wrapper")"

  echo "    closed-set run  (detector present): rc|err = $pos" >>"$out"
  echo "    negative control (detector absent): rc|err = $neg" >>"$out"
  echo "    decoy control (unrelated file added): rc|err = $decoy" >>"$out"

  if [ "$pos" = "$neg" ]; then
    # Identical outcomes with and without the detector: this probe is not
    # measuring detector resolution. That is a broken gate, not a good tree.
    echo "    PROBE IS VACUOUS: removing the detector changed nothing," >>"$out"
    echo "    so a passing run here would prove nothing about the layout" >>"$out"
    rc=1
  elif [ "$decoy" != "$pos" ]; then
    # It reacts to a file the recorded command never names, so POS != NEG
    # tells us nothing about the detector specifically.
    echo "    PROBE IS UNATTRIBUTED: adding a file the command does not name" >>"$out"
    echo "    also changed the outcome, so the POS/NEG difference is not" >>"$out"
    echo "    evidence that the detector was resolved" >>"$out"
    rc=1
  else
    echo "    the wrapper distinguishes present from absent, and ignores a" >>"$out"
    echo "    file the command does not name, so it did resolve the detector" >>"$out"
    echo "    at the path the recorded command puts it" >>"$out"
  fi

  rm -rf "$ext" "$neg_tree" "$decoy_tree"
  return "$rc"
}

# --- 1. the live tree -------------------------------------------------------
hdr "The recorded command against this tree"
LIVE_OUT="$WORK/live.txt"; : >"$LIVE_OUT"
if check_tree "$ROOT" "$RECORDED" "$LIVE_OUT"; then
  sed 's/^/  /' "$LIVE_OUT"
  ok "every path in the recorded command resolves, and the files run alone in the layout the wrapper needs"
else
  sed 's/^/  /' "$LIVE_OUT"
  bad "the recorded command is NOT runnable from this tree (see above)"
fi

# --- 2. the gate must be able to go red -------------------------------------
# The baseline has to refuse first, or "not caught" is indistinguishable
# between a working guard and a guard that never fires.
hdr "Mutation control: the gate refuses a broken tree"

# mutate_tree <label> <recorded-transformer|-> <mutator> [args...]
#
# The recorded-transformer rewrites the .txt for this mutant only. `-` keeps
# the pristine one, which models a rename where the card was NOT updated.
# A transformer that changes nothing is a failed mutation, not a kill.
mutate_tree() {
  local label="$1" xform="$2" ; shift 2
  local mut="$WORK/mut.$RANDOM"
  rm -rf "$mut"; mkdir -p "$mut"
  local paths
  paths="$(recorded_paths "$RECORDED")"
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    [ -f "$ROOT/$p" ] || continue
    mkdir -p "$mut/$(dirname "$p")"
    cp "$ROOT/$p" "$mut/$p"
  done <<EOF
$paths
EOF

  local rec="$RECORDED"
  if [ "$xform" != "-" ]; then
    rec="$WORK/recorded.$RANDOM.txt"
    if ! "$xform" "$RECORDED" "$rec"; then
      bad "$label -- recorded-command transform did not apply (changed nothing)"
      rm -rf "$mut"; return
    fi
    if cmp -s "$RECORDED" "$rec"; then
      bad "$label -- recorded-command transform produced an identical file"
      rm -rf "$mut"; return
    fi
  fi

  "$@" "$mut"
  local mrc=$?
  if [ "$mrc" -ne 0 ]; then
    bad "$label -- mutation did not apply (changed nothing; a no-op mutant is not a kill)"
    rm -rf "$mut"; return
  fi

  local mout="$WORK/mut.txt"; : >"$mout"
  if check_tree "$mut" "$rec" "$mout"; then
    bad "$label -- gate PASSED a broken tree"
    sed 's/^/      /' "$mout"
  else
    ok "$label -- caught"
  fi
  rm -rf "$mut"
}

# Mutation 1: the rename, card not updated. Someone moves the detector and
# updates ci.yml, so every existing suite stays green.
mut_rename_detector() {
  local mut="$1"
  local f="$mut/scripts/discord_job_health.js"
  [ -f "$f" ] || return 1
  mv "$f" "$mut/scripts/discord_health.js" || return 1
  [ -f "$f" ] && return 1   # assert the mutation actually destroyed the anchor
  return 0
}
mutate_tree "detector renamed, card not updated" - mut_rename_detector

# Mutation 2: the wrapper moved into a subdirectory. Paths still "exist" in
# the repo, so a naive `test -f` list built from a glob would still pass.
mut_move_wrapper() {
  local mut="$1"
  local f="$mut/discord_job_health_monitor.sh"
  [ -f "$f" ] || return 1
  mkdir -p "$mut/bin" || return 1
  mv "$f" "$mut/bin/discord_job_health_monitor.sh" || return 1
  [ -f "$f" ] && return 1
  return 0
}
mutate_tree "wrapper moved to bin/ (path list alone would not notice)" - mut_move_wrapper

# Mutation 3: the layout break, card not updated.
mut_flatten_layout() {
  local mut="$1"
  local f="$mut/scripts/discord_job_health.js"
  [ -f "$f" ] || return 1
  mv "$f" "$mut/discord_job_health.js" || return 1
  [ -f "$f" ] && return 1
  return 0
}
mutate_tree "detector flattened out of scripts/, card not updated" - mut_flatten_layout

# Mutation 4: THE ONE THE FIRST VERSION OF THIS GATE MISSED, and the one the
# closed-set limb exists for. The detector moves to lib/ and the recorded
# command is updated to match -- the careful, conscientious edit. Every path
# the card names still resolves, so the existence limb is satisfied. But the
# wrapper's own default is the hardcoded "$HERE/scripts/discord_job_health.js",
# which appears in neither ci.yml nor the .txt, so the monitor dies at exit 2
# while nothing anywhere goes red. Only a run that resolves the detector
# catches this. Measured against the `--help` probe: not caught.
mut_recorded_to_lib() {
  local src="$1" dst="$2"
  sed 's|origin/main:scripts/discord_job_health\.js|origin/main:lib/discord_job_health.js|' \
    "$src" > "$dst" || return 1
  grep -q 'origin/main:lib/discord_job_health\.js' "$dst" || return 1
  return 0
}
mut_detector_to_lib() {
  local mut="$1"
  local f="$mut/scripts/discord_job_health.js"
  [ -f "$f" ] || return 1
  mkdir -p "$mut/lib" || return 1
  mv "$f" "$mut/lib/discord_job_health.js" || return 1
  [ -f "$f" ] && return 1
  [ -f "$mut/lib/discord_job_health.js" ] || return 1
  return 0
}
mutate_tree "detector moved to lib/ AND the card updated to match (existence limb satisfied)" \
  mut_recorded_to_lib mut_detector_to_lib

# Mutation 5: the probe's own failure mode. Replace the wrapper with one that
# never looks at the detector. Every path resolves and the tree is a closed
# set, but the differential probe collapses -- POS and NEG become identical.
# This must be scored a failure, because a probe that cannot tell the two
# apart is not evidence that the layout is intact. Without this mutant, the
# `--help` regression could come back unnoticed.
mut_wrapper_ignores_detector() {
  local mut="$1"
  local f="$mut/discord_job_health_monitor.sh"
  [ -f "$f" ] || return 1
  cat >"$f" <<'STUB'
#!/usr/bin/env bash
# stands in for a wrapper that resolves its detector lazily or not at all
echo "stub: nothing was resolved" >&2
exit 0
STUB
  chmod +x "$f" || return 1
  grep -q 'stub: nothing was resolved' "$f" || return 1
  return 0
}
mutate_tree "wrapper stops resolving the detector (the --help regression itself)" \
  - mut_wrapper_ignores_detector

# Mutation 6: the decoy control's own reason to exist, and the mutant that
# isolates it the way mutant 4 isolates the closed-set limb. Mutant 5 is
# killed by the POS/NEG rule alone, so on its own it does not prove the decoy
# limb does anything -- the same trap that made the `--help` limb look
# controlled by mutants 1-3.
#
# This wrapper also resolves NOTHING, but its output varies with tree
# CONTENT rather than with the detector. NEG has one file fewer than POS, so
# POS and NEG disagree and the difference-only rule reads that as a working
# differential. Measured against the POS/NEG-only probe: PASS, on a wrapper
# that never looks for a detector at all. Only the decoy control catches it,
# because the decoy tree has a file POS does not and this wrapper notices.
mut_wrapper_counts_files() {
  local mut="$1"
  local f="$mut/discord_job_health_monitor.sh"
  [ -f "$f" ] || return 1
  cat >"$f" <<'STUB'
#!/usr/bin/env bash
# resolves nothing, but reacts to the shape of the directory -- so a probe
# that only requires POS and NEG to DIFFER scores this as working.
echo "stub: $(find . -type f | wc -l) files present" >&2
exit 0
STUB
  chmod +x "$f" || return 1
  grep -q 'files present' "$f" || return 1
  return 0
}
mutate_tree "wrapper resolves nothing but reacts to tree content (POS/NEG differ for the wrong reason)" \
  - mut_wrapper_counts_files

printf '\npassed %d, failed %d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
