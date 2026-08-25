#!/usr/bin/env bash
# ===========================================================================
# gh_permission_pin_audit.sh — is every project's GH_APP_PERMISSIONS the pin
# we think it is, and is the reviewed default still the thing they were pinned
# from?  TOG-346.
#
# THE FAILURE THIS EXISTS FOR
#
# The broker takes a project's permission profile as
#
#     const profile = projectPermissions ?? { ...defaultPermissions };
#
# `??`.  A project's `GH_APP_PERMISSIONS` REPLACES `DEFAULT_PERMISSION_PROFILE`
# rather than extending it.  TOG-296 pinned the five projects that had no
# permission set, so it is now 7 of 7 and the default is reached by nothing.
# Editing it changes no project's grant, and no error, no log line and no test
# says so.  TOG-247 already paid for this once: a CI-visibility grant added to
# the default landed on every project EXCEPT the one repo it was written for,
# because that repo was the pinned one.
#
# The direction that matters is removal.  Narrowing the default for a security
# reason would look shipped and do nothing at all.
#
# So the question this answers is not "is the default correct" — it is
# "does each project still carry the pin the registry says it carries, and is
# the registry's baseline still the default it was derived from".  Both halves
# are needed.  Comparing pins to each other misses a default that moved under
# them; comparing the default to itself misses a pin edited on the control
# plane, which needs no PR and leaves no diff.
#
# WHAT IT READS
#
#   permission_pins.txt                        the intended pin, per project,
#                                              expressed as a delta from the
#                                              reviewed default
#   plugins/gh-token-broker/dist/scope.js      DEFAULT_PERMISSION_PROFILE,
#                                              imported rather than regexed —
#                                              a regex that stops matching
#                                              would report "no drift"
#   GET /api/companies/{id}/projects           the LIVE env of every project
#
# NOT A SECURITY BOUNDARY.  Project env is agent-writable (`PATCH
# /api/projects/{id}` succeeds from an ordinary agent token), and this file and
# the registry sit in reach of the same uid as everything else.  This is a
# detector.  All it buys is that a change has to be loud.
#
# NO CREDENTIAL REACHES argv.  $PAPERCLIP_API_KEY goes into a 0600
# `curl --config` file, exactly as gh_token.sh and gh_scope_residue.sh do, so
# it never appears in `ps` or in a shell history.
#
# Requires bash, curl, jq, node.  node is used only to import scope.js; if it
# is absent the audit reports INDETERMINATE and exits 3 rather than skipping
# the baseline check and exiting 0.
#
# Exit codes:
#   0  every project matches its registry line, and the baseline matches the
#      default profile
#   1  at least one FINDING — drift, an unregistered project, a stale registry
#      line, or a baseline that no longer matches the default
#   2  usage error, or a registry this parser cannot read
#   3  INDETERMINATE — something could not be established (no node, scope.js
#      unreadable, the board unreachable, zero projects returned)
#
# 3 exists so this never fails open.  An audit that could not read the board
# has not proven the board clean, and must not exit 0 next to the runs that
# did.  Zero projects examined is INDETERMINATE, not a pass: `[[ "$n" -eq 0 ]]`
# is also true for a variable that was never assigned.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

REGISTRY="$HERE/permission_pins.txt"
SCOPE_FILE="$HERE/plugins/gh-token-broker/dist/scope.js"
OUTPUT=text
MODE=audit

usage() {
  cat >&2 <<'EOF'
usage: gh_permission_pin_audit.sh [options]

  --registry FILE    intended pins (default: ./permission_pins.txt)
  --scope-file FILE  broker scope module to import DEFAULT_PERMISSION_PROFILE
                     from (default: ./plugins/gh-token-broker/dist/scope.js)
  --fanout-plan      print the GH_APP_PERMISSIONS every project SHOULD carry,
                     and the PATCH that sets it, then exit.  Use this after
                     changing the default profile: it is the step whose absence
                     let TOG-247 land everywhere except its own repo.
  --json             machine-readable rows instead of a table

Reads the board through $PAPERCLIP_API_URL with $PAPERCLIP_API_KEY.
Set $PERMISSION_PIN_PROJECTS_JSON to a file to audit a fixture offline; no
socket is opened when it is set.

Exit 0 = clean | 1 = findings | 2 = usage or unreadable registry
       | 3 = indeterminate (nothing was established; do NOT read as a pass)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --registry)   shift; [[ $# -gt 0 ]] || { usage; exit 2; }; REGISTRY="$1" ;;
    --scope-file) shift; [[ $# -gt 0 ]] || { usage; exit 2; }; SCOPE_FILE="$1" ;;
    --fanout-plan) MODE=fanout ;;
    --json)       OUTPUT=json ;;
    -h|--help)    usage; exit 2 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

for tool in curl jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: $tool is required" >&2; exit 2; }
done

FINDINGS=0
INDET=0
declare -a ROWS=()          # verdict<TAB>slug<TAB>projectId<TAB>detail

finding() { FINDINGS=$((FINDINGS + 1)); }
indet()   { INDET=$((INDET + 1)); }

# --- registry --------------------------------------------------------------
#
# A line this parser cannot read is a hard error, never a skip.  A skipped
# registry line turns "this project is audited" into "this project is not
# audited" with no change in the output — the fail-open direction, and the one
# the credential-chain pin gate was written to catch on its own file.

declare -A REG_STATE=() REG_SLUG=() REG_DELTA=() REG_NOTE=()
declare -a REG_ORDER=()
BASELINE_SPEC=""
BASELINE_SEEN=0

[[ -r "$REGISTRY" ]] || { echo "ERROR: cannot read registry: $REGISTRY" >&2; exit 2; }

reg_lineno=0
while IFS= read -r line || [[ -n "$line" ]]; do
  reg_lineno=$((reg_lineno + 1))
  line="${line%$'\r'}"
  [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue

  # Default IFS: the first four fields are whitespace-delimited and the note is
  # whatever is left, so a note may contain spaces without quoting.
  read -r r_state r_pid r_slug r_delta r_note <<<"$line"

  case "$r_state" in
    baseline)
      if [[ $BASELINE_SEEN -ne 0 ]]; then
        echo "ERROR: $REGISTRY:$reg_lineno: a second baseline line; exactly one is allowed" >&2
        exit 2
      fi
      BASELINE_SEEN=1
      BASELINE_SPEC="$r_delta"
      ;;
    verbatim|delta|inherit)
      if [[ ! "$r_pid" =~ ^[0-9a-f-]{8,}$ ]]; then
        echo "ERROR: $REGISTRY:$reg_lineno: '$r_pid' is not a project id" >&2
        exit 2
      fi
      if [[ -n "${REG_STATE[$r_pid]:-}" ]]; then
        echo "ERROR: $REGISTRY:$reg_lineno: project $r_pid listed twice" >&2
        exit 2
      fi
      if [[ "$r_state" != delta && "$r_delta" != "-" ]]; then
        echo "ERROR: $REGISTRY:$reg_lineno: state '$r_state' must have delta '-', got '$r_delta'" >&2
        exit 2
      fi
      if [[ "$r_state" == delta && "$r_delta" == "-" ]]; then
        echo "ERROR: $REGISTRY:$reg_lineno: state 'delta' with no delta is just 'verbatim'" >&2
        exit 2
      fi
      # A divergence with no stated reason is indistinguishable from a mistake,
      # and the next person to read it will helpfully "fix" it back.
      if [[ "$r_state" != verbatim && ( -z "$r_note" || "$r_note" == "-" ) ]]; then
        echo "ERROR: $REGISTRY:$reg_lineno: state '$r_state' requires a note saying why" >&2
        exit 2
      fi
      REG_STATE[$r_pid]="$r_state"
      REG_SLUG[$r_pid]="$r_slug"
      REG_DELTA[$r_pid]="$r_delta"
      REG_NOTE[$r_pid]="$r_note"
      REG_ORDER+=("$r_pid")
      ;;
    *)
      echo "ERROR: $REGISTRY:$reg_lineno: unknown state '$r_state'" >&2
      exit 2
      ;;
  esac
done < "$REGISTRY"

[[ $BASELINE_SEEN -eq 1 ]] || { echo "ERROR: $REGISTRY has no baseline line" >&2; exit 2; }
[[ ${#REG_ORDER[@]} -gt 0 ]] || { echo "ERROR: $REGISTRY registers no project" >&2; exit 2; }

# --- permission-spec arithmetic --------------------------------------------
#
# Comparison is over SETS, never strings.  The live pins are written by hand in
# whatever order the writer felt like: Ops Tooling has `workflows=write` in the
# middle of the list, Community Platform has it at the end.  A string compare
# would call that drift and get muted within a week.

PERM_TOKEN='^[a-z][a-z0-9_]*=(read|write|admin)$'

# canon <name=level ...assoc array name> -> sorted comma spec on stdout
canon_from() {
  local -n _map="$1"
  local k
  for k in "${!_map[@]}"; do printf '%s=%s\n' "$k" "${_map[$k]}"; done \
    | LC_ALL=C sort | paste -sd, -
}

# parse_spec <spec> <assoc array name>  -> 0 ok, 1 malformed
parse_spec() {
  local spec="$1"; local -n _out="$2"
  local tok
  _out=()
  [[ "$spec" == "-" || -z "$spec" ]] && return 0
  for tok in ${spec//,/ }; do
    [[ "$tok" =~ $PERM_TOKEN ]] || return 1
    _out["${tok%%=*}"]="${tok#*=}"
  done
  return 0
}

declare -A BASELINE_MAP=()
parse_spec "$BASELINE_SPEC" BASELINE_MAP \
  || { echo "ERROR: $REGISTRY: malformed baseline profile '$BASELINE_SPEC'" >&2; exit 2; }
[[ ${#BASELINE_MAP[@]} -gt 0 ]] \
  || { echo "ERROR: $REGISTRY: the baseline profile is empty" >&2; exit 2; }
BASELINE_CANON="$(canon_from BASELINE_MAP)"

# expected_spec <delta> -> canonical spec on stdout; returns 1 on a bad delta.
#
# Returns rather than exits on purpose: every caller is a command substitution,
# and an `exit` inside one kills only the subshell.  A validator that cannot
# stop the run it is validating is not a validator.
expected_spec() {
  local delta="$1" tok name
  local -A m=()
  for name in "${!BASELINE_MAP[@]}"; do m["$name"]="${BASELINE_MAP[$name]}"; done
  if [[ "$delta" != "-" && -n "$delta" ]]; then
    for tok in ${delta//,/ }; do
      case "$tok" in
        +*) tok="${tok#+}"
            [[ "$tok" =~ $PERM_TOKEN ]] \
              || { echo "ERROR: $REGISTRY: malformed delta token '+$tok'" >&2; return 1; }
            m["${tok%%=*}"]="${tok#*=}" ;;
        -*) name="${tok#-}"
            [[ "$name" =~ ^[a-z][a-z0-9_]*$ ]] \
              || { echo "ERROR: $REGISTRY: malformed delta token '$tok'" >&2; return 1; }
            # Removing something the baseline never had is a delta that does
            # nothing, which means the registry is describing a profile that no
            # longer exists.  Say so rather than silently agreeing.
            [[ -n "${m[$name]:-}" ]] \
              || { echo "ERROR: $REGISTRY: delta removes '$name', which is not in the baseline" >&2; return 1; }
            unset 'm[$name]' ;;
        *)  echo "ERROR: $REGISTRY: delta token '$tok' must start with + or -" >&2; return 1 ;;
      esac
    done
  fi
  [[ ${#m[@]} -gt 0 ]] \
    || { echo "ERROR: $REGISTRY: a delta empties the profile; the broker refuses to mint with no permissions" >&2; return 1; }
  canon_from m
}

# Resolve every registered project's expected profile up front, so a malformed
# delta is a refusal before any project is reported OK against it.
declare -A REG_EXPECT=()
for _pid in "${REG_ORDER[@]}"; do
  [[ "${REG_STATE[$_pid]}" == inherit ]] && continue
  REG_EXPECT[$_pid]="$(expected_spec "${REG_DELTA[$_pid]}")" || exit 2
done
unset _pid

# A `delta` line whose delta resolves to the baseline is a lie in the registry:
# it claims a deliberate divergence and encodes none, so a later default change
# would fan out to it as if it were verbatim.
for _pid in "${REG_ORDER[@]}"; do
  if [[ "${REG_STATE[$_pid]}" == delta && "${REG_EXPECT[$_pid]}" == "$BASELINE_CANON" ]]; then
    echo "ERROR: $REGISTRY: ${REG_SLUG[$_pid]} is state 'delta' but its delta resolves to the baseline" >&2
    exit 2
  fi
done
unset _pid

# --- the reviewed default, imported rather than pattern-matched -------------
#
# A regex over scope.js would report "no drift" the day the export is renamed
# or reformatted, which is the one day it matters.  Importing it means a
# rename is an error, not a silent pass.

default_profile_json() {
  command -v node >/dev/null 2>&1 || return 3
  [[ -r "$SCOPE_FILE" ]] || return 3
  node --input-type=module -e '
    import { pathToFileURL } from "node:url";
    const mod = await import(pathToFileURL(process.argv[1]).href);
    const p = mod.DEFAULT_PERMISSION_PROFILE;
    if (p == null || typeof p !== "object") process.exit(3);
    process.stdout.write(JSON.stringify(p));
  ' "$SCOPE_FILE" 2>/dev/null || return 3
}

DEFAULT_CANON=""
if DEFAULT_JSON="$(default_profile_json)" && [[ -n "$DEFAULT_JSON" ]]; then
  DEFAULT_CANON="$(jq -r 'to_entries|map("\(.key)=\(.value)")|sort|join(",")' <<<"$DEFAULT_JSON")"
else
  DEFAULT_CANON=""
fi

# --- fan-out plan ----------------------------------------------------------

if [[ "$MODE" == fanout ]]; then
  if [[ -z "$DEFAULT_CANON" ]]; then
    echo "# WARNING: could not import DEFAULT_PERMISSION_PROFILE from $SCOPE_FILE." >&2
    echo "# The plan below is derived from the registry baseline, which is the value" >&2
    echo "# that has NOT been confirmed against the default.  Fix that first." >&2
  elif [[ "$DEFAULT_CANON" != "$BASELINE_CANON" ]]; then
    echo "# WARNING: the registry baseline does not match $SCOPE_FILE." >&2
    echo "#   default:  $DEFAULT_CANON" >&2
    echo "#   baseline: $BASELINE_CANON" >&2
    echo "# Update the baseline line in $REGISTRY first, or this plan fans out the" >&2
    echo "# OLD profile to every project." >&2
  fi
  printf '# Apply with an agent token; project env is writable via PATCH /api/projects/{id}.\n'
  printf '# Send the WHOLE env map back — a partial PATCH clobbers GH_APP_ID / GH_APP_ORG /\n'
  printf '# GH_APP_PRIVATE_KEY, which are secret_ref bindings you cannot re-create.\n\n'
  for pid in "${REG_ORDER[@]}"; do
    slug="${REG_SLUG[$pid]}"
    case "${REG_STATE[$pid]}" in
      inherit)
        printf '# %-22s %s\n#   GH_APP_PERMISSIONS must be ABSENT (inherits the broker default)\n' \
          "$slug" "$pid" ;;
      *)
        printf '# %-22s %s\n%s\n' "$slug" "$pid" "${REG_EXPECT[$pid]}" ;;
    esac
  done
  exit 0
fi

# --- baseline vs default ---------------------------------------------------
#
# The headline check, and the reason this file exists.  Everything below it
# compares pins to the registry; this one compares the registry to the code.

if [[ -z "$DEFAULT_CANON" ]]; then
  ROWS+=("INDETERMINATE"$'\t'"(baseline)"$'\t'"-"$'\t'"could not import DEFAULT_PERMISSION_PROFILE from $SCOPE_FILE (node missing, file unreadable, or the export renamed)")
  indet
elif [[ "$DEFAULT_CANON" == "$BASELINE_CANON" ]]; then
  ROWS+=("OK"$'\t'"(baseline)"$'\t'"-"$'\t'"registry baseline == DEFAULT_PERMISSION_PROFILE ($BASELINE_CANON)")
else
  ROWS+=("BASELINE-DRIFT"$'\t'"(baseline)"$'\t'"-"$'\t'"default is [$DEFAULT_CANON] but the registry was audited against [$BASELINE_CANON] — every project below is compared to a profile that no longer exists")
  finding
fi

# --- live board ------------------------------------------------------------

PROJECTS_FIXTURE="${PERMISSION_PIN_PROJECTS_JSON:-}"

CFG_DIR="$(umask 077; mktemp -d "${TMPDIR:-/tmp}/gh_permission_pin_audit.XXXXXXXX")" \
  || { echo "ERROR: could not create a private temp directory" >&2; exit 2; }
cleanup_cfg() { rm -rf "$CFG_DIR"; return 0; }
trap 'cleanup_cfg' EXIT
trap 'cleanup_cfg; exit 130' INT
trap 'cleanup_cfg; exit 143' TERM
trap 'cleanup_cfg; exit 129' HUP

api_base() { local b="${PAPERCLIP_API_URL:-}"; b="${b%/}"; b="${b%/api}"; printf '%s' "$b"; }

fetch_projects() {
  if [[ -n "$PROJECTS_FIXTURE" ]]; then cat "$PROJECTS_FIXTURE"; return $?; fi
  [[ -n "${PAPERCLIP_API_KEY:-}" && -n "${PAPERCLIP_COMPANY_ID:-}" ]] || return 3
  local cfg rc
  cfg="$(umask 077; mktemp "$CFG_DIR/curlcfg.XXXXXXXX")" || return 3
  chmod 0600 "$cfg"
  {
    printf 'url = "%s"\n' "$(api_base)/api/companies/$PAPERCLIP_COMPANY_ID/projects"
    printf 'request = "GET"\n'
    printf 'header = "Authorization: Bearer %s"\n' "$PAPERCLIP_API_KEY"
    printf 'silent\nshow-error\nfail\n'
  } > "$cfg"
  curl --config "$cfg"
  rc=$?
  rm -f "$cfg"
  return $rc
}

PROJECTS_RAW="$(fetch_projects)"
FETCH_RC=$?

LIVE_TSV=""
if [[ $FETCH_RC -ne 0 || -z "$PROJECTS_RAW" ]]; then
  ROWS+=("INDETERMINATE"$'\t'"(board)"$'\t'"-"$'\t'"could not read the project list (curl rc=$FETCH_RC); no pin was compared")
  indet
else
  # Only literal bindings participate, exactly as scope.js does: a `secret_ref`
  # is treated as absent rather than stringified.  Reading only the bare-string
  # form is how project scoping was inert in production while the suite was
  # green, so both spellings are handled here too.
  LIVE_TSV="$(jq -r '
    def lit: if type=="string" then .
             elif (type=="object" and .type=="plain" and (.value|type)=="string") then .value
             else null end;
    (if type=="array" then . else (.projects // .data // []) end)
    | .[]
    | [ (.id // ""), (.name // ""), ((.env.GH_APP_PERMISSIONS | lit) // "") ]
    | @tsv
  ' <<<"$PROJECTS_RAW" 2>/dev/null)" || LIVE_TSV=""
  if [[ -z "$LIVE_TSV" ]]; then
    ROWS+=("INDETERMINATE"$'\t'"(board)"$'\t'"-"$'\t'"the project list parsed to zero projects; zero-of-zero is not a pass")
    indet
  fi
fi

declare -A SEEN=()
EXAMINED=0

while IFS=$'\t' read -r pid pname pperms; do
  [[ -n "$pid" ]] || continue
  EXAMINED=$((EXAMINED + 1))
  SEEN[$pid]=1
  state="${REG_STATE[$pid]:-}"
  slug="${REG_SLUG[$pid]:-$pname}"

  if [[ -z "$state" ]]; then
    ROWS+=("UNREGISTERED"$'\t'"$slug"$'\t'"$pid"$'\t'"project '$pname' is not in $(basename "$REGISTRY"); its grant is unaudited and a default change will not consider it")
    finding
    continue
  fi

  if [[ "$state" == inherit ]]; then
    if [[ -z "$pperms" ]]; then
      ROWS+=("OK"$'\t'"$slug"$'\t'"$pid"$'\t'"no pin, as registered — takes DEFAULT_PERMISSION_PROFILE at mint time")
    else
      ROWS+=("DRIFT"$'\t'"$slug"$'\t'"$pid"$'\t'"registered as inheriting the default, but a pin is set: [$pperms]")
      finding
    fi
    continue
  fi

  if [[ -z "$pperms" ]]; then
    ROWS+=("UNPINNED"$'\t'"$slug"$'\t'"$pid"$'\t'"registry expects a pin, but GH_APP_PERMISSIONS is absent or a non-literal binding; this project silently takes whatever the DEPLOYED default is")
    finding
    continue
  fi

  declare -A live_map=()
  if ! parse_spec "$pperms" live_map; then
    ROWS+=("INVALID"$'\t'"$slug"$'\t'"$pid"$'\t'"live pin does not parse as name=level: [$pperms] — the broker raises a ScopeError on this, so mints for this project are already failing")
    finding
    continue
  fi
  live_canon="$(canon_from live_map)"
  want="${REG_EXPECT[$pid]}"

  if [[ "$live_canon" == "$want" ]]; then
    ROWS+=("OK"$'\t'"$slug"$'\t'"$pid"$'\t'"$live_canon")
  else
    ROWS+=("DRIFT"$'\t'"$slug"$'\t'"$pid"$'\t'"live [$live_canon] != registered [$want]")
    finding
  fi
done <<<"$LIVE_TSV"

# A registry line with no live project means the registry is describing a world
# that has changed.  Reported as a finding rather than ignored, because the
# fan-out plan would otherwise happily emit a PATCH for a project that is gone.
for pid in "${REG_ORDER[@]}"; do
  [[ -n "${SEEN[$pid]:-}" ]] && continue
  if [[ $INDET -gt 0 ]]; then
    # The board read failed; "not seen" says nothing about this project.
    ROWS+=("INDETERMINATE"$'\t'"${REG_SLUG[$pid]}"$'\t'"$pid"$'\t'"registered, but the board could not be read to confirm it")
    indet
  else
    ROWS+=("MISSING"$'\t'"${REG_SLUG[$pid]}"$'\t'"$pid"$'\t'"registered in $(basename "$REGISTRY") but not returned by the board")
    finding
  fi
done

# --- report ----------------------------------------------------------------

if [[ "$OUTPUT" == json ]]; then
  printf '%s\n' "${ROWS[@]}" | jq -R -s '
    split("\n") | map(select(length > 0)) | map(split("\t")) |
    map({verdict: .[0], slug: .[1], projectId: .[2], detail: .[3]})
  ' | jq --argjson f "$FINDINGS" --argjson i "$INDET" --argjson e "$EXAMINED" \
        --arg b "$BASELINE_CANON" --arg d "$DEFAULT_CANON" \
        '{baseline: $b, defaultProfile: (if $d == "" then null else $d end),
          projectsExamined: $e, findings: $f, indeterminate: $i, rows: .}'
else
  printf '%-14s  %-22s  %s\n' VERDICT PROJECT DETAIL
  printf '%-14s  %-22s  %s\n' -------------- ---------------------- ------
  for row in "${ROWS[@]}"; do
    IFS=$'\t' read -r v s _p d <<<"$row"
    printf '%-14s  %-22s  %s\n' "$v" "$s" "$d"
  done
  printf '\n%d project(s) examined, %d finding(s), %d indeterminate\n' \
    "$EXAMINED" "$FINDINGS" "$INDET"
  if [[ $FINDINGS -eq 0 && $INDET -eq 0 ]]; then
    printf 'Every pin matches its registry line, and the baseline matches the default.\n'
  fi
  if [[ $FINDINGS -gt 0 ]]; then
    printf 'Fix: `%s --fanout-plan` prints the spec each project should carry.\n' \
      "$(basename "$0")"
  fi
fi

# Findings outrank indeterminacy: a confirmed drift is still a drift even if
# another row could not be established.  But indeterminate alone must never
# exit 0 — that is the whole reason for code 3.
if [[ $FINDINGS -gt 0 ]]; then exit 1; fi
if [[ $INDET -gt 0 ]]; then exit 3; fi
if [[ $EXAMINED -eq 0 ]]; then
  echo "ERROR: zero projects examined; refusing to report a pass" >&2
  exit 3
fi
exit 0
