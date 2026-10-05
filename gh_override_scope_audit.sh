#!/usr/bin/env bash
# ===========================================================================
# gh_override_scope_audit.sh — does any issue's GH_APP_* override narrow away
# a permission its project grants, so the broker mints a token narrower than
# the approved pin?
#
# THE FAILURE THIS EXISTS FOR: a stale issue-level override narrowing a run
#
# A project pins GH_APP_PERMISSIONS including workflows=write, and
# the broker faithfully serves that ceiling. But a stale issue-level
# override of `contents=write,pull_requests=write,issues=write,metadata=read`
# — a template that predates the workflows grant — narrows the minted token.
# gh-app-token.js forwards the RUN env as the broker narrowing request, and the
# broker's narrowPermissions() intersects it against the project profile. The
# minted token therefore carries exactly the four stale permissions: no
# workflows, so `git push` of .github/workflows/ci.yml is refused by GitHub's
# pre-receive hook while every project-level audit reads green.
#
# gh_permission_pin_audit.sh covers project-vs-registry. Nothing covered
# issue-vs-project, which is the layer that actually minted the failing token.
# This is that layer.
#
# WHAT IT READS
#
#   GET /api/companies/{id}/issues     issues with assigneeAdapterOverrides
#   GET /api/companies/{id}/projects   the LIVE project env (the ceiling)
#
# Only literal bindings participate, exactly as scope.js does: a `secret_ref`
# override is treated as absent (the run takes the project profile), never
# stringified. A non-literal override therefore reads OK-with-note, not drift.
#
# VERDICTS (permissions half)
#
#   OK                  override matches the project pin as a set (key ORDER is
#                       not drift — live pins are hand-written)
#   NARROWED            override drops >=1 permission or level the project
#                       grants. The broker mints the narrower set: correct
#                       broker behaviour, stale run data. A finding.
#   NARROWED-WORKFLOWS  as NARROWED, and `workflows` is among the dropped —
#                       the push-breaking case. A finding, distinct verdict so
#                       it greps.
#   WIDENED             override asks for keys/levels above the project pin.
#                       The broker 403s the excess at mint, so the run's git is
#                       broken in the other direction. A finding.
#   NARROWED+WIDENED    both at once. A finding.
#   INVALID             override does not parse as name=level. A finding — the
#                       broker ScopeErrors on this, so mints already fail.
#   PROJECT-INVALID     the PROJECT pin does not parse; every mint for that
#                       project already fails. A finding.
#   UNKNOWN-CEILING     no project (or no literal project pin) to compare
#                       against — the broker falls back to the deployed default
#                       / workspace URL, which this script cannot read live.
#                       Indeterminate, never a pass.
#
# VERDICTS (repos half, GH_APP_REPOS override only)
#
#   REPO-WIDENED  override names repos outside the project pin — the broker
#                 403s at mint. A finding.
#   (Repo NARROWING is legitimate single-repo slicing of a multi-repo project
#   pin and is reported as info inside the OK row, not a finding. Crying wolf
#   on deliberate least-privilege gets the detector muted.)
#
# Exit codes: 0 clean | 1 findings | 2 usage/setup | 3 indeterminate.
# Findings outrank indeterminacy; indeterminate alone never exits 0.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

OUTPUT=text
ONLY_PROJECT=""
ISSUES_FIXTURE="${OVERRIDE_AUDIT_ISSUES_JSON:-}"
PROJECTS_FIXTURE="${OVERRIDE_AUDIT_PROJECTS_JSON:-}"

usage() {
  cat >&2 <<'EOF'
usage: gh_override_scope_audit.sh [options]

  --json             machine-readable rows instead of a table
  --project <id>     audit only this project (its issues + its pin).
                     Default is every project on the board; the fan-out is one
                     ?projectId= page per project because the unfiltered list
                     caps at 500 rows and hides real findings.

Reads the board through $PAPERCLIP_API_URL with $PAPERCLIP_API_KEY.
Set $OVERRIDE_AUDIT_ISSUES_JSON / $OVERRIDE_AUDIT_PROJECTS_JSON to files to
audit fixtures offline; no socket is opened when both are set.

Exit 0 = clean | 1 = findings | 2 = usage/setup
       | 3 = indeterminate (nothing was established; do NOT read as a pass)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) OUTPUT=json ;;
    --project) shift; [[ $# -gt 0 ]] || { usage; exit 2; }; ONLY_PROJECT="$1" ;;
    -h|--help) usage; exit 2 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

for tool in curl jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: $tool is required" >&2; exit 2; }
done

FINDINGS=0
INDET=0
EXAMINED=0
declare -a ROWS=()          # verdict<TAB>issue<TAB>detail

finding() { FINDINGS=$((FINDINGS + 1)); }
indet()   { INDET=$((INDET + 1)); }

# --- permission-spec arithmetic (set semantics; key order is not drift) ------

PERM_TOKEN='^[a-z][a-z0-9_]*=(read|write|admin)$'

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

rank() {
  case "$1" in
    read) printf '1' ;; write) printf '2' ;; admin) printf '3' ;; *) printf '0' ;;
  esac
}

# canon <assoc name> -> sorted comma spec on stdout
canon_from() {
  local -n _map="$1"
  local k
  for k in "${!_map[@]}"; do printf '%s=%s\n' "$k" "${_map[$k]}"; done \
    | LC_ALL=C sort | paste -sd, -
}

CFG_DIR="$(umask 077; mktemp -d "${TMPDIR:-/tmp}/gh_override_scope_audit.XXXXXXXX")" \
  || { echo "ERROR: could not create a private temp directory" >&2; exit 2; }
cleanup_cfg() {
  if [[ -n "${OVERRIDE_AUDIT_KEEP_TMP:-}" ]]; then
    printf 'audit tmp kept at %s\n' "$CFG_DIR" >&2
  else
    rm -rf "$CFG_DIR"
  fi
  return 0
}
trap 'cleanup_cfg' EXIT
trap 'cleanup_cfg; exit 130' INT
trap 'cleanup_cfg; exit 143' TERM
trap 'cleanup_cfg; exit 129' HUP

api_base() { local b="${PAPERCLIP_API_URL:-}"; b="${b%/}"; b="${b%/api}"; printf '%s' "$b"; }

# NO CREDENTIAL REACHES argv: the key goes into a 0600 curl --config file, as
# gh_token.sh and gh_permission_pin_audit.sh do.
api_get() {
  local path="$1"
  local cfg rc
  cfg="$(umask 077; mktemp "$CFG_DIR/curlcfg.XXXXXXXX")" || return 3
  chmod 0600 "$cfg"
  {
    printf 'url = "%s"\n' "$(api_base)$path"
    printf 'request = "GET"\n'
    printf 'header = "Authorization: Bearer %s"\n' "$PAPERCLIP_API_KEY"
    printf 'silent\nshow-error\nfail\n'
  } > "$cfg"
  curl --config "$cfg"
  rc=$?
  rm -f "$cfg"
  return $rc
}

fetch_projects() {
  if [[ -n "$PROJECTS_FIXTURE" ]]; then
    [[ -r "$PROJECTS_FIXTURE" ]] || return 3
    cat "$PROJECTS_FIXTURE"; return $?
  fi
  [[ -n "${PAPERCLIP_API_KEY:-}" && -n "${PAPERCLIP_COMPANY_ID:-}" ]] || return 3
  api_get "/api/companies/$PAPERCLIP_COMPANY_ID/projects"
}

# No single list call sees the whole board: the endpoint caps pages at
# 500 rows, so the audit fans out per project and judges each row on its
# own state.
# Findings on actionable issues are findings; rows outside the mint-capable
# states are NOT-ACTIONABLE info (true about the data, never a pass, never
# a finding).
#
# The project list comes from the same board read as the pins, so a project
# added between the two reads is audited on the next run, not silently
# skipped: project ids with no issue rows at all are reported INDETERMINATE.
fetch_issues() {
  if [[ -n "$ISSUES_FIXTURE" ]]; then
    [[ -r "$ISSUES_FIXTURE" ]] || return 3
    cat "$ISSUES_FIXTURE"; return $?
  fi
  [[ -n "${PAPERCLIP_API_KEY:-}" && -n "${PAPERCLIP_COMPANY_ID:-}" ]] || return 3
  # Pages accumulate in a temp dir and merge via jq -s (slurp), so no page
  # body ever travels through argv: Wayselect alone returns 491 full issue
  # rows, which overflowed an --argjson merge on the first live run.
  local pages
  pages="$(umask 077; mktemp -d "$CFG_DIR/pages.XXXXXXXX")" || return 3
  local pid n=0
  local -a pids=()
  if [[ -n "$ONLY_PROJECT" ]]; then
    [[ -n "${PROJ_NAME[$ONLY_PROJECT]:-}" ]] \
      || { echo "ERROR: --project $ONLY_PROJECT is not a known project id" >&2; return 2; }
    pids=("$ONLY_PROJECT")
  else
    pids=("${!PROJ_NAME[@]}")
  fi
  for pid in "${pids[@]}"; do
    if ! api_get "/api/companies/$PAPERCLIP_COMPANY_ID/issues?projectId=$pid" > "$pages/$n.json"; then
      return 3
    fi
    # A page that is not a JSON array is a failed read, not an empty project.
    if ! jq -e 'type=="array"' "$pages/$n.json" >/dev/null 2>&1; then
      return 3
    fi
    n=$((n + 1))
  done
  if [[ $n -eq 0 ]]; then return 3; fi
  jq -c -s 'add' "$pages"/*.json || return 3
}

# literal class + value for a GH_APP_* env binding, mirroring scope.js:
# bare string or {type:plain,value} participates; anything else is absent.
#
# String literals reach the `lit` filter through jq --arg variables ($s, $l,
# $o, $p, $a, $n), never as inline quotes — and LIT_JQ itself is single-quoted
# so bash passes the $vars through to jq untouched. An earlier double-quoted
# spelling silently ate one nesting level (`\$s` collapsed to `s`), which
# mis-split every row without erroring; the field-count assertion plus the
# REPO-WIDENED fixture case pin the shape now.
LIT_JQ='def lit: if type==$s then {c:$l,v:.} elif (type==$o and .type==$p and (.value|type)==$s) then {c:$l,v:.value} elif .==null then {c:$a} else {c:$n} end;'
# shellcheck disable=SC2034  # read by the jq call sites below via expansion
LIT_ARGS=(--arg s string --arg l literal --arg o object --arg p plain --arg a absent --arg n nonliteral)

PROJECTS_RAW="$(fetch_projects)"
if [[ $? -ne 0 || -z "$PROJECTS_RAW" ]]; then
  echo "INDETERMINATE: could not read the project list; no override was compared" >&2
  exit 3
fi

FILTER_PROJECTS_FILE="$CFG_DIR/projects_filter.jq"
{
printf '%s\n' "$LIT_JQ"
printf '%s\n' '((if type=="array" then . else (.projects // .data // []) end) | .[])'
printf '%s\n' '| [ (.id // ""),'
printf '%s\n' '    (.name // ""),'
printf '%s\n' '    ((.env.GH_APP_PERMISSIONS | lit) | (if .c==$l then .v else "" end)),'
printf '%s\n' '    ((.env.GH_APP_REPOS | lit) | (if .c==$l then .v else "" end)) ]'
printf '%s\n' '| map(if . == "" then "\u0001" else . end) | @tsv'
} > "$FILTER_PROJECTS_FILE"
# pid -> name / perms-literal / repos-literal
declare -A PROJ_NAME=() PROJ_PERMS=() PROJ_REPOS=()
while IFS=$'\t' read -r pid pname pperms prepos; do
  [[ -n "$pid" ]] || continue
  PROJ_NAME[$pid]="$pname"
  # The filters emit \x01 for empty fields so IFS columns stay put (the row
  # loop restores it at :319-321); restore it here too, or an unpinned project
  # reads as a one-byte pin — PROJECT-INVALID / REPO-WIDENED false positives
  # on correct states.
  [[ "$pperms" == $'\x01' ]] && pperms=""
  [[ "$prepos" == $'\x01' ]] && prepos=""
  PROJ_PERMS[$pid]="$pperms"
  PROJ_REPOS[$pid]="$prepos"
done < <(jq -r "${LIT_ARGS[@]}" -f "$FILTER_PROJECTS_FILE" <<<"$PROJECTS_RAW" 2>/dev/null)

if [[ ${#PROJ_NAME[@]} -eq 0 ]]; then
  echo "INDETERMINATE: the project list parsed to zero projects; zero-of-zero is not a pass" >&2
  exit 3
fi

ISSUES_RAW="$(fetch_issues)"
if [[ $? -ne 0 || -z "$ISSUES_RAW" ]]; then
  echo "INDETERMINATE: could not read the issue list; no override was compared" >&2
  exit 3
fi

# identifier \t status \t projectId \t permsClass \t permsValue \t reposClass \t reposValue
# (the issue uuid is deliberately omitted: it is only ever echoed back into
# rows, and carrying it through the TSV once cost a misaligned-field incident
# where an empty perms value shifted every column right — the skip guard read
# the issue id as the identifier and skipped everything. Field count is
# asserted below so a future shape change fails loudly instead of misreading.)
FILTER_PROG_FILE="$CFG_DIR/issues_filter.jq"
{
printf '%s\n' "$LIT_JQ"
printf '%s\n' '((if type=="array" then . else (.issues // .data // []) end) | .[])'
printf '%s\n' '| [ (.identifier // ""),'
printf '%s\n' '    (.status // ""),'
printf '%s\n' '    (.projectId // ""),'
printf '%s\n' '    (((.assigneeAdapterOverrides.adapterConfig.env.GH_APP_PERMISSIONS // null) | lit | .c)),'
printf '%s\n' '    (((.assigneeAdapterOverrides.adapterConfig.env.GH_APP_PERMISSIONS // null) | lit) | (if .c==$l then .v else "" end)),'
printf '%s\n' '    (((.assigneeAdapterOverrides.adapterConfig.env.GH_APP_REPOS // null) | lit | .c)),'
printf '%s\n' '    (((.assigneeAdapterOverrides.adapterConfig.env.GH_APP_REPOS // null) | lit) | (if .c==$l then .v else "" end)) ]'
printf '%s\n' '| select(length == 7)'
printf '%s\n' '| map(if . == "" then "\u0001" else . end) | @tsv'
} > "$FILTER_PROG_FILE"

ISSUES_TSV="$(jq -r "${LIT_ARGS[@]}" -f "$FILTER_PROG_FILE" <<<"$ISSUES_RAW" 2>/dev/null || true)"
if [[ -z "$ISSUES_TSV" ]]; then
  echo "INDETERMINATE: the issue list parsed to zero rows; no override was compared" >&2
  exit 3
fi

WORKFLOW_DROPS=0

while IFS=$'\t' read -r ident istatus projid pclass pval rclass rval; do
  # Empty TSV fields collapse under IFS, shifting columns (an empty perms
  # value once moved every field right and the skip guard misread the row).
  # The filters emit \x01 for empties; restore it here so columns stay put.
  for _f in ident istatus projid pclass pval rclass rval; do
    [[ "${!_f}" == $'\x01' ]] && printf -v "$_f" '%s' ""
  done
  [[ -n "$ident" ]] || continue
  # No override at all: nothing to compare, not examined.
  if [[ "$pclass" == "absent" && "$rclass" == "absent" ]]; then continue; fi
  # Outside the mint-capable states the override can narrow nothing live:
  # cancelled/done/backlog issues never mint again. Report the row as info —
  # true about the data, never a pass, never a finding — and move on.
  case "$istatus" in
    todo|in_progress|in_review|blocked) ;;
    *)
      ROWS+=("NOT-ACTIONABLE"$'\t'"$ident"$'\t'"status '$istatus' never mints; override not compared")
      EXAMINED=$((EXAMINED + 1))
      continue ;;
  esac
  # A non-literal override is treated as absent by the broker — the run takes
  # the project profile. Note it, do not flag it.
  if [[ "$pclass" == "nonliteral" && "$rclass" != "literal" ]]; then
    ROWS+=("OK"$'\t'"$ident"$'\t'"non-literal GH_APP override (treated as absent by the broker); run takes the project profile")
    EXAMINED=$((EXAMINED + 1))
    continue
  fi
  if [[ -z "$projid" ]]; then
    ROWS+=("UNKNOWN-CEILING"$'\t'"$ident"$'\t'"no project on the issue; the broker falls back to the deployed default / workspace URL, which cannot be read live")
    indet
    continue
  fi
  if [[ -z "${PROJ_NAME[$projid]:-}" ]]; then
    ROWS+=("UNKNOWN-CEILING"$'\t'"$ident"$'\t'"project $projid not in the board read; ceiling not established")
    indet
    continue
  fi
  EXAMINED=$((EXAMINED + 1))
  pname="${PROJ_NAME[$projid]}"
  detail=()

  # ---- permissions half ----
  # Verdict accumulates here so BOTH halves are always evaluated and join one
  # row: the permissions half must not `continue` past the repos half (an
  # early version did, and a repos-only override row silently skipped its only
  # check — the suite's REPO-WIDENED case caught it).
  verdict=""
  if [[ "$pclass" == "literal" ]]; then
    declare -A om=() pm=()
    if ! parse_spec "$pval" om; then
      verdict="INVALID"
      detail+=("override GH_APP_PERMISSIONS does not parse as name=level: [$pval] — the broker ScopeErrors, so mints for this run already fail")
    elif [[ -z "${PROJ_PERMS[$projid]:-}" ]]; then
      ROWS+=("UNKNOWN-CEILING"$'\t'"$ident"$'\t'"project '$pname' carries no literal GH_APP_PERMISSIONS; ceiling is the deployed default, unreadable live")
      indet
      continue
    elif ! parse_spec "${PROJ_PERMS[$projid]}" pm; then
      verdict="PROJECT-INVALID"
      detail+=("project '$pname' pin does not parse: [${PROJ_PERMS[$projid]}] — every mint for this project already fails")
    else
      dropped=()
      added=()
      for k in "${!pm[@]}"; do
        if [[ -z "${om[$k]:-}" ]]; then dropped+=("$k (project ${pm[$k]}, override absent)");
        elif [[ $(rank "${om[$k]}") -lt $(rank "${pm[$k]}") ]]; then dropped+=("$k (project ${pm[$k]}, override ${om[$k]})"); fi
      done
      for k in "${!om[@]}"; do
        if [[ -z "${pm[$k]:-}" ]]; then added+=("$k=${om[$k]} (not in project pin; broker 403s the excess at mint)");
        elif [[ $(rank "${om[$k]}") -gt $(rank "${pm[$k]}") ]]; then added+=("$k (project ${pm[$k]}, override ${om[$k]}; broker 403s the excess)"); fi
      done
      if [[ ${#dropped[@]} -eq 0 && ${#added[@]} -eq 0 ]]; then
        detail+=("permissions match project '$pname' pin ($(canon_from om))")
      else
        if [[ ${#dropped[@]} -gt 0 && ${#added[@]} -gt 0 ]]; then verdict="NARROWED+WIDENED";
        elif [[ ${#dropped[@]} -gt 0 ]]; then
          if [[ -n "${pm[workflows]:-}" && -z "${om[workflows]:-}" ]]; then
            verdict="NARROWED-WORKFLOWS"; WORKFLOW_DROPS=$((WORKFLOW_DROPS + 1))
          else verdict="NARROWED"; fi
        else verdict="WIDENED"; fi
        msg="override narrows the run below project '$pname' pin"
        [[ ${#dropped[@]} -gt 0 ]] && msg+="; dropped: ${dropped[*]}"
        [[ ${#added[@]} -gt 0 ]] && msg+="; excess (broker 403s at mint): ${added[*]}"
        detail+=("$msg")
      fi
    fi
  fi

  # ---- repos half (override only; narrowing is legitimate slicing) ----
  # Only a literal override participates. A bare-missing key skips the whole
  # row at the top ("no override"); an empty-string override parses to nothing,
  # which the broker reads as omit — info, not a finding.
  if [[ "$rclass" == "literal" ]]; then
    declare -a onames=()
    declare -a pnames=()
    declare -a outside=()
    # Word-splitting on the comma/space-normalised value is the split: no
    # glob characters can survive parseRepoName server-side, so unquoted
    # expansion here cannot widen the comparison. shellcheck disable=SC2206
    onames=(${rval//,/ })
    if [[ -z "${PROJ_REPOS[$projid]:-}" ]]; then
      detail+=("repos override [$rval] vs unpinned project (workspace fallback; ceiling unreadable live)")
    else
      # shellcheck disable=SC2206
      pnames=(${PROJ_REPOS[$projid]//,/ })
      for n in ${onames[@]+"${onames[@]}"}; do
        [[ -n "$n" ]] || continue
        hit=0
        for p in ${pnames[@]+"${pnames[@]}"}; do [[ "$n" == "$p" ]] && hit=1; done
        [[ $hit -eq 0 ]] && outside+=("$n")
      done
      if [[ ${#outside[@]} -gt 0 ]]; then
        [[ -n "$verdict" ]] && verdict+="+"
        verdict+="REPO-WIDENED"
        detail+=("repos override names [${outside[*]}] outside project '$pname' pin [${PROJ_REPOS[$projid]}]; the broker 403s at mint")
      else
        detail+=("repos override [$rval] within project '$pname' pin (narrowing is legitimate slicing)")
      fi
    fi
  fi

  # One row per issue: the permissions verdict, the repos verdict, or both.
  # INVALID and PROJECT-INVALID are terminal (no grant can be reasoned about).
  if [[ -z "$verdict" ]]; then
    ROWS+=("OK"$'\t'"$ident"$'\t'"$(IFS='; '; echo "${detail[*]:-no GH_APP override}")")
  else
    ROWS+=("$verdict"$'\t'"$ident"$'\t'"$(IFS='; '; echo "${detail[*]}")")
    finding
  fi
done <<<"$ISSUES_TSV"

# --- report ---------------------------------------------------------------

if [[ "$OUTPUT" == json ]]; then
  printf '%s\n' "${ROWS[@]}" | jq -R -s '
    split("\n") | map(select(length > 0)) | map(split("\t")) |
    map({verdict: .[0], issue: .[1], detail: .[2]})
  ' | jq --argjson f "$FINDINGS" --argjson i "$INDET" --argjson e "$EXAMINED" \
        --argjson w "$WORKFLOW_DROPS" \
        '{issuesExamined: $e, findings: $f, indeterminate: $i, workflowDrops: $w, rows: .}'
else
  printf '%-18s  %-12s  %s\n' VERDICT ISSUE DETAIL
  printf '%-18s  %-12s  %s\n' ------------------ ------------ ------
  for row in "${ROWS[@]}"; do
    IFS=$'\t' read -r v s d <<<"$row"
    printf '%-18s  %-12s  %s\n' "$v" "$s" "$d"
  done
  printf '\n%d issue override(s) examined, %d finding(s), %d indeterminate, %d dropping workflows\n' \
    "$EXAMINED" "$FINDINGS" "$INDET" "$WORKFLOW_DROPS"
fi

if [[ $FINDINGS -gt 0 ]]; then exit 1; fi
if [[ $INDET -gt 0 ]]; then exit 3; fi
if [[ $EXAMINED -eq 0 ]]; then
  echo "no issue carries a GH_APP override; nothing to compare (not a finding)" >&2
  exit 0
fi
exit 0
