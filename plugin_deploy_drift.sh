#!/usr/bin/env bash
# ===========================================================================
# plugin_deploy_drift.sh — is the manifest the host SERVES the manifest we
# MERGED?
#
# WHY THIS EXISTS (TOG-723). TOG-576 merged an external-disclosure route into
# `plugins/gh-token-broker` and it was never deployed. Measured 2026-08-30
# against this host:
#
#     plugins row `gh-token-broker`: status=ready,
#         package_path=/opt/paperclip-plugin-packages/gh-token-broker
#     deployed manifest_json apiRoutes:  whoami, mint
#     origin/main  apiRoutes:            disclosure-preflight, disclose,
#                                        whoami, mint
#     live probe of the disclosure route: HTTP 404
#
# main was green and merged for days while the capability it added did not
# exist in the running system, and nothing noticed. That is the same class as
# *a detector in CI is not a detector on a clock*: CI proved the code was
# correct, and nothing ever asked whether it was RUNNING.
#
# WHAT MAKES IT DIFFERENT FROM plugin_manifest_gate.sh. That tool answers "if
# somebody activates this PACKAGE DIRECTORY, does the plugin's authority
# change" — deployed-package versus reviewed-ref, and it is pointed at one
# directory by hand. This one answers a question that tool structurally cannot:
#
#   1. It reads the DATABASE ROW, not the package directory. `manifest_json` is
#      what the host READ AT INSTALL and dispatches from RIGHT NOW; the package
#      directory is what it would read at the NEXT activation. On this host
#      those agree for gh-token-broker (both say two routes) and that is luck,
#      not a rule — /opt is exactly as stale as the row. The row is the only
#      side that is authoritative about what the host is serving today.
#
#   2. It ENUMERATES. plugin_manifest_gate.sh needs a --deployed path, so it can
#      only ever be pointed at a plugin somebody already suspects — which is
#      never the one that drifted silently. This walks every row in `plugins`
#      and reports the ones with a repo counterpart, so a plugin nobody thought
#      about is in scope by default.
#
# The two are complements and both should run. This one is the clock.
#
# WHY ROUTE IDENTITY, NOT ROUTE COUNT. The issue is explicit and it is right: a
# count check passes when one route is swapped for another. Routes are compared
# as a SET keyed by routeKey, and each matched pair is compared field by field
# on (method, path, auth, capability, checkoutPolicy, companyResolution). So
# "deployed is missing `disclose`", "deployed has a route main does not", and
# "`mint` is deployed with a different auth" are three different findings and
# none of them is expressible as a number.
#
# WHY THE COMPARISON IS STRUCTURAL. The repo side is a JS module with 60 lines
# of comment in it; the deployed side is jsonb the host normalised. Text and
# hashes disagree on those constantly and always will — TOG-318 had to
# establish by hand that three hash differences were all comments. Both sides
# are evaluated and flattened to sorted leaves, so formatting and comments are
# invisible and a changed `auth` is not.
#
# WHAT IT DELIBERATELY DOES NOT DO. It does not redeploy anything.
# /opt/paperclip-plugin-packages is root-owned (we are uid 1000; `touch` ->
# Permission denied) and no agent in this company holds host presence. Fixing
# the drift is an operator action. This detects and reports it, with the
# evidence an operator needs attached.
#
# EXECUTION WARNING. Extracting the repo-side surface IMPORTS the manifest
# module out of a git ref, so its author runs code as whoever runs this. That
# is the same exposure plugin_manifest_gate.sh carries and the same caveat
# applies: run it as an unprivileged uid, never as root against an
# agent-writable checkout. The DEPLOYED side is jsonb and is never executed.
# ===========================================================================
set -uo pipefail

ME="$(basename "${BASH_SOURCE[0]}")"

# Exit codes are the interface; callers gate on these, never on printed text.
#   0  every plugin with a repo counterpart matches
#   2  refused — measured nothing (no source, unreadable ref, no rows, a
#      manifest that would not evaluate). NEVER conflated with 0.
#   4  drift: at least one plugin's deployed route surface differs from the repo
EXIT_OK=0; EXIT_REFUSED=2; EXIT_DRIFT=4

NODE_TIMEOUT="${PLUGIN_DEPLOY_DRIFT_TIMEOUT:-10}"

# The read seam. Same shape as quota_brake.sh's ROSTER_SOURCE_CMD: the default
# is the real database and a test can substitute a fixture without a database,
# a container or a credential. Emits one TSV row per plugin:
#     pluginKey \t packagePath \t status \t version \t manifestJson
PLUGINS_SOURCE_CMD="${PLUGINS_SOURCE_CMD:-}"

c_red() { printf '\033[31m%s\033[0m\n' "$*"; }
c_grn() { printf '\033[32m%s\033[0m\n' "$*"; }
c_yel() { printf '\033[33m%s\033[0m\n' "$*"; }
die()   { c_red "$ME: $*" >&2; exit $EXIT_REFUSED; }

WORK=""
trap '[ -n "$WORK" ] && rm -rf "$WORK"' EXIT

usage() {
  cat <<EOF
$ME — compare each DEPLOYED plugin manifest against the repo manifest it came from.

  $ME check [options]
      --repo DIR          git checkout holding plugins/ (default: cwd)
      --ref REF           git ref to compare against (default: origin/main)
      --plugins-dir DIR   path within the ref holding one directory per plugin
                          (default: plugins)
      --only KEY          restrict to one plugin_key (repeatable)

  $ME routes
      Print the deployed route surface of every plugin, as
      <pluginKey> \\t <routeKey> \\t <field> \\t <json>.

Environment:
  PLUGINS_SOURCE_CMD   command emitting the deployed rows as TSV.
                       Default: ./pg_source.js plugins

Exit: 0 all match   2 refused (measured nothing)   4 drift found
EOF
}

# The route fields that decide what a route IS and what it is allowed to do.
# Compared per matched routeKey. `capability` and `companyResolution` are in
# here with the obvious three because they are equally authority-bearing:
# companyResolution picks the company the host asserts access against, and
# swapping it is a cross-tenant change that leaves method/path/auth untouched.
ROUTE_FIELDS=(method path auth capability checkoutPolicy companyResolution)

# --- deployed side ----------------------------------------------------------
# Reads the TSV rows and writes one file per plugin holding its manifest JSON.
# Refuses on a row whose manifest does not parse rather than skipping it: a
# skipped plugin is a plugin this tool reports nothing about while exiting 0,
# which is the silent-green failure the whole file exists to prevent.
read_deployed() {
  local src="$PLUGINS_SOURCE_CMD"
  [ -n "$src" ] || src="$SELFDIR/pg_source.js plugins"

  local rows="$WORK/rows.tsv" status
  # `bash -c` because the harness shell does not report a pipeline's real exit
  # status, and a source that fails must refuse rather than read as zero rows.
  bash -c "$src" > "$rows" 2>"$WORK/rows.err"; status=$?
  if [ $status -ne 0 ]; then
    c_red "$ME: the plugins source failed (exit $status): $src" >&2
    sed 's/^/    /' < "$WORK/rows.err" >&2
    exit $EXIT_REFUSED
  fi
  [ -s "$rows" ] || die "the plugins source returned no rows — nothing was measured. Source: $src"

  # TAB IS AN IFS *WHITESPACE* CHARACTER, so `IFS=$'\t' read` collapses a run of
  # them into one separator and an EMPTY FIELD DISAPPEARS. Four of this host's
  # six plugins are registry installs with a NULL package_path, so column 2 is
  # empty on exactly those rows and every later column shifts left: the manifest
  # lands in `version` and `mjson` comes back empty. Measured while writing this
  # — three of six plugins failed to parse, and the naive repair (skip a row
  # whose manifest is empty) would have silently dropped them and exited 0.
  #
  # \x1f is not an IFS whitespace character, so each separator yields its own
  # field and an empty one survives. It cannot occur inside the data: pg renders
  # control characters inside jsonb strings as \uXXXX escapes, and pg_source.js
  # already escapes literal tabs and newlines.
  tr '\t' '\037' < "$rows" > "$rows.us" && mv "$rows.us" "$rows"

  local key path pstatus version mjson n=0
  : > "$WORK/deployed.index"
  while IFS=$'\037' read -r key path pstatus version mjson; do
    [ -n "$key" ] || continue
    printf '%s' "$mjson" > "$WORK/dep.$key.json"
    node -e '
      const fs = require("fs");
      const t = fs.readFileSync(process.argv[1], "utf8");
      if (!t.trim()) { process.exit(9); }
      JSON.parse(t);
    ' "$WORK/dep.$key.json" 2>/dev/null \
      || die "the deployed manifest_json for '$key' is empty or does not parse. Refusing rather than skipping it."
    printf '%s\t%s\t%s\t%s\n' "$key" "$path" "$pstatus" "$version" >> "$WORK/deployed.index"
    n=$((n+1))
  done < "$rows"

  [ "$n" -gt 0 ] || die "parsed zero plugins out of a non-empty source. Nothing was measured."
  # The count goes to a FILE, not to stdout. Returning it on stdout forces every
  # caller to run this in `$(...)`, and a subshell is where a refusal goes to
  # die: `die` exits the SUBSHELL, the caller carries on with an empty count,
  # and the run reaches its summary having refused and then ignored itself.
  # Measured while writing this — an unparseable manifest printed the refusal,
  # then printed a report header, and only exited 2 because a later guard
  # happened to catch it. A refusal that depends on a second guard is not a
  # refusal.
  printf '%s' "$n" > "$WORK/deployed.count"
}

# --- repo side --------------------------------------------------------------
# Maps a plugin_key to its directory under the ref by EVALUATING each candidate
# manifest and reading its `id`. Matching on directory name would be a guess;
# the host derives plugin_key from `manifest.id`
# (/app/server/src/services/plugin-registry.ts:172), so this reads the same
# field the host keyed the row on. A directory whose name and id disagree is
# then matched correctly instead of silently reported as "no repo counterpart",
# which would read as clean.
build_repo_index() {
  local repo="$1" ref="$2" pdir="$3"
  : > "$WORK/repo.index"
  local dirs d id
  dirs="$(git -C "$repo" ls-tree --name-only -d "$ref:$pdir" 2>/dev/null)" \
    || die "cannot list $ref:$pdir in $repo — the reference side is unreadable, so nothing can be compared"
  [ -n "$dirs" ] || die "$ref:$pdir contains no plugin directories"

  for d in $dirs; do
    d="${d%/}"
    local mrel; mrel="$(repo_manifest_rel "$repo" "$ref" "$pdir/$d")" || continue
    git -C "$repo" cat-file -e "$ref:$pdir/$d/$mrel" 2>/dev/null || continue
    local staged="$WORK/ref/$d"
    mkdir -p "$staged/$(dirname "$mrel")"
    git -C "$repo" cat-file blob "$ref:$pdir/$d/$mrel" > "$staged/$mrel" 2>/dev/null || continue
    id="$(manifest_id "$staged/$mrel")" || \
      die "the repo manifest $ref:$pdir/$d/$mrel would not evaluate. Refusing: an unevaluatable reference cannot be compared, and treating it as absent would report a drifted plugin as having no counterpart."
    [ -n "$id" ] || continue
    printf '%s\t%s\t%s\n' "$id" "$pdir/$d/$mrel" "$staged/$mrel" >> "$WORK/repo.index"
  done
  [ -s "$WORK/repo.index" ] || die "no manifest in $ref:$pdir declared an id — the reference side measured nothing"
}

# The manifest pointer out of package.json, defaulting to dist/manifest.js only
# when there is no package.json at all. Repointing that field swaps the whole
# authorization declaration, so it is read rather than assumed.
repo_manifest_rel() {
  local repo="$1" ref="$2" dir="$3"
  if git -C "$repo" cat-file -e "$ref:$dir/package.json" 2>/dev/null; then
    local ptr
    ptr="$(git -C "$repo" cat-file blob "$ref:$dir/package.json" 2>/dev/null | node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d));
      process.stdin.on("end", () => {
        try {
          const p = JSON.parse(s);
          const m = p && p.paperclipPlugin && p.paperclipPlugin.manifest;
          if (typeof m === "string") process.stdout.write(m.replace(/^\.\//, ""));
        } catch { /* fall through to the default */ }
      });
    ' 2>/dev/null)"
    [ -n "$ptr" ] && { printf '%s' "$ptr"; return 0; }
  fi
  printf '%s' "dist/manifest.js"
}

manifest_id() {
  timeout "$NODE_TIMEOUT" node --input-type=module -e '
    const mod = await import(process.argv[1]);
    const m = mod.manifest ?? mod.default;
    if (!m || typeof m !== "object" || typeof m.id !== "string") process.exit(9);
    process.stdout.write(m.id);
  ' "$(cd "$(dirname "$1")" && pwd)/$(basename "$1")" 2>/dev/null
}

# --- the route surface ------------------------------------------------------
# Flattens a manifest's apiRoutes to sorted `routeKey<TAB>field<TAB>json`
# leaves, keyed by routeKey and never by index.
#
# INDEXING WOULD BE WRONG, not merely noisy. origin/main inserts
# disclosure-preflight and disclose BEFORE whoami and mint. Compared by index,
# every one of the four routes reports as changed and the two that are actually
# missing are buried in the noise — the reader sees "everything differs", which
# is indistinguishable from a broken tool and gets muted. Keyed, the finding is
# exactly "two routes absent from the deployed side" and the two that DO match
# are silent.
#
# The mode argument is what makes the same walker read both sides: `module`
# imports a JS manifest, `json` parses jsonb. The deployed side is never
# executed.
ROUTES_JS='
// Under `node -e`, process.argv[0] is the executable and the script arguments
// start at [1] — there is no script path entry to skip.
const [mode, file] = process.argv.slice(1);
const fs = await import("node:fs");
let m;
if (mode === "json") {
  m = JSON.parse(fs.readFileSync(file, "utf8"));
} else {
  const mod = await import(file);
  m = mod.manifest ?? mod.default;
}
if (!m || typeof m !== "object") { console.error("no manifest object"); process.exit(9); }

// KEY ORDER IS NOT A FACT ABOUT THE MANIFEST. The repo side is a JS object
// literal and preserves the order it was written in; the deployed side is
// jsonb, which does not — PostgreSQL stores object keys by length-then-byte
// order. The repo writes { from: "query", key: "companyId" } and the row
// returns {"key":"companyId","from":"query"}. Those are the SAME declaration,
// and the first run of this detector reported both brokers as CHANGED on it.
//
// That false positive is more dangerous than a missed one here: it fires on
// every plugin on every run, so the two genuinely missing routes arrive inside
// a report that is mostly noise, and a detector that is mostly noise gets
// muted. Canonicalising the key order makes reordering invisible and leaves a
// changed VALUE fully visible.
const canon = (v) => {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canon(v[k]);
    return o;
  }
  return v;
};

const routes = Array.isArray(m.apiRoutes) ? m.apiRoutes : [];
const out = [];
for (const r of routes) {
  if (!r || typeof r !== "object") continue;
  const key = typeof r.routeKey === "string" ? r.routeKey : "(no-routeKey)";
  for (const f of process.env.ROUTE_FIELDS.split(" ")) {
    out.push(key + "\t" + f + "\t" + JSON.stringify(canon(r[f] === undefined ? null : r[f])));
  }
}
out.sort();

// THE MEASUREMENT RECEIPT (TOG-375). An empty surface is ambiguous and the
// ambiguity is load-bearing: "this manifest declares no apiRoutes" and "the
// walker broke and read nothing" are the same zero bytes. The caller has to
// tell them apart, because refusing the first is a false alarm that takes the
// WHOLE fleet sweep down (measured: `check` exited 2 on `dispatch` and never
// reached gh-token-broker, which was really drifting), and accepting the
// second is the silent green this file exists to prevent.
//
// So the walker states, out of band, that it got as far as reading apiRoutes.
// Emitted unconditionally and FIRST, before the sorted leaves, so its presence
// is proof of arrival rather than proof of content. The caller strips it: it
// never reaches the comparison, so route findings are byte-identical to before.
process.stdout.write("#MEASURED\t" + routes.length + "\n");
process.stdout.write(out.length ? out.join("\n") + "\n" : "");
'

# Sets ROUTE_SURFACE_MEASURED to the declared route count the walker actually
# read, or to "" if the walker never got that far. Read it INSTEAD of testing
# the surface for emptiness — those two are only the same when a manifest with
# zero routes is impossible, which is exactly the assumption TOG-375 falsified.
ROUTE_SURFACE_MEASURED=""
route_surface() {
  local mode="$1" file="$2" abs out status
  ROUTE_SURFACE_MEASURED=""
  abs="$(cd "$(dirname "$file")" && pwd)/$(basename "$file")"
  out="$(ROUTE_FIELDS="${ROUTE_FIELDS[*]}" timeout "$NODE_TIMEOUT" \
         node --input-type=module -e "$ROUTES_JS" "$mode" "$abs" 2>&1)"; status=$?
  [ $status -eq 0 ] || { printf '%s\n' "$out" >&2; return 1; }

  # The receipt is the walker's own statement that it reached apiRoutes. Its
  # ABSENCE on a zero-status run means the surface came from something that is
  # not this walker, so it is refused rather than read as "no routes".
  local first; first="$(head -n1 <<< "$out")"
  case "$first" in
    '#MEASURED'*) ROUTE_SURFACE_MEASURED="${first#*$'\t'}" ;;
    *) printf '%s: route walker emitted no measurement receipt for %s\n' "$ME" "$abs" >&2; return 1 ;;
  esac
  printf '%s' "$(tail -n +2 <<< "$out")"
}

cmd_routes() {
  WORK="$(mktemp -d)"
  read_deployed
  local key rest
  while IFS=$'\t' read -r key rest; do
    local s; s="$(route_surface json "$WORK/dep.$key.json")" \
      || die "could not read the deployed route surface for $key"
    if [ -z "$s" ]; then
      printf '%s\t(no apiRoutes)\t-\t-\n' "$key"
    else
      printf '%s\n' "$s" | sed "s|^|$key\t|"
    fi
  done < <(cut -f1 "$WORK/deployed.index")
}

cmd_check() {
  local repo="." ref="origin/main" pdir="plugins"
  local -a only=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --repo)        repo="${2:?}"; shift 2 ;;
      --ref)         ref="${2:?}"; shift 2 ;;
      --plugins-dir) pdir="${2:?}"; shift 2 ;;
      --only)        only+=("${2:?}"); shift 2 ;;
      -h|--help)     usage; exit $EXIT_OK ;;
      *) die "unknown argument: $1" ;;
    esac
  done

  WORK="$(mktemp -d)"
  git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || die "--repo $repo is not a git checkout"
  git -C "$repo" rev-parse --verify "$ref" >/dev/null 2>&1 || die "cannot resolve --ref $ref in $repo"

  read_deployed
  local nplugins; nplugins="$(cat "$WORK/deployed.count")"
  build_repo_index "$repo" "$ref" "$pdir"

  printf '\033[1mplugin deploy drift\033[0m\n'
  printf '  deployed   %s plugin row(s) from the host registry\n' "$nplugins"
  printf '  reference  %s:%s\n\n' "$ref" "$pdir"

  local drift=0 compared=0 unpaired=0 routeless=0
  local key ppath pstatus pversion

  while IFS=$'\t' read -r key ppath pstatus pversion; do
    if [ "${#only[@]}" -gt 0 ]; then
      local want=0 o
      for o in "${only[@]}"; do [ "$o" = "$key" ] && want=1; done
      [ "$want" -eq 1 ] || continue
    fi

    local refline; refline="$(awk -F'\t' -v k="$key" '$1==k {print; exit}' "$WORK/repo.index")"
    if [ -z "$refline" ]; then
      # Not a finding. Four of this host's six plugins are third-party packages
      # installed from a registry and have no source in this repo at all; there
      # is nothing to compare them to and saying so every run would train the
      # reader to skim past the section that matters.
      unpaired=$((unpaired+1))
      continue
    fi
    local refpath reffile
    refpath="$(cut -f2 <<< "$refline")"
    reffile="$(cut -f3 <<< "$refline")"

    local dep_s="$WORK/$key.dep.routes" ref_s="$WORK/$key.ref.routes"
    local dep_n ref_n
    route_surface json   "$WORK/dep.$key.json" > "$dep_s" \
      || die "could not read the deployed route surface for $key"
    dep_n="$ROUTE_SURFACE_MEASURED"
    route_surface module "$reffile" > "$ref_s" \
      || die "could not evaluate the repo manifest for $key at $ref:$refpath"
    ref_n="$ROUTE_SURFACE_MEASURED"

    # ZERO ROUTES DECLARED IS NOT A BROKEN WALKER (TOG-375). This guard used to
    # read emptiness off the surface files and `die`, on the stated assumption
    # that a route-less plugin never has a repo counterpart. `dispatch` — merged
    # in PR #161, jobs-only and route-less on BOTH sides — falsified it, and
    # because `die` exits the whole run rather than the plugin, the fleet sweep
    # aborted on the first alphabetical row and NEVER REACHED gh-token-broker,
    # which was genuinely drifting. A detector that refuses is not failing safe
    # if the refusal is what stops it from looking.
    #
    # The receipt makes the two cases distinguishable. The broken-walker half is
    # enforced ONCE, in route_surface, which refuses a surface carrying no
    # receipt — so by this line a measurement always exists and re-checking for
    # an empty one here would be a second mechanism for one invariant. That is
    # not free: two guards over one invariant means deleting either leaves the
    # suite green, so neither can be mutation-tested and the pair reads as
    # covered while being untestable. One guard, at the point of measurement.
    #
    # What is left here is the other half: a measured zero on both sides is a
    # legitimate no-op, reported as uncompared — counted, named, never a silent
    # green.
    if [ "$dep_n" -eq 0 ] && [ "$ref_n" -eq 0 ]; then
      c_yel "  NO ROUTES $key"
      printf '    package  %s\n    both %s:%s and the deployed row declare zero apiRoutes — nothing to compare\n\n' \
        "${ppath:-(registry install)}" "$ref" "$refpath"
      routeless=$((routeless+1))
      continue
    fi

    compared=$((compared+1))

    local findings="$WORK/$key.findings"
    # Joined in awk on the exact (routeKey, field) pair. grep would match a leaf
    # that is a substring of a longer one and compare the wrong pair.
    awk -F'\t' '
      NR==FNR { k=$1 FS $2; ref[k]=$3; rk[$1]=1; seen[k]=1; next }
              { k=$1 FS $2; dep[k]=$3; dk[$1]=1; seen[k]=1 }
      END {
        for (r in rk) if (!(r in dk)) printf "MISSING\t%s\t-\t-\t-\n", r
        for (r in dk) if (!(r in rk)) printf "EXTRA\t%s\t-\t-\t-\n", r
        for (k in seen) {
          split(k, p, FS)
          if (!(p[1] in rk) || !(p[1] in dk)) continue
          rv = (k in ref) ? ref[k] : "(absent)"
          dv = (k in dep) ? dep[k] : "(absent)"
          if (rv != dv) printf "CHANGED\t%s\t%s\t%s\t%s\n", p[1], p[2], rv, dv
        }
      }' "$ref_s" "$dep_s" | sort > "$findings"

    if [ ! -s "$findings" ]; then
      c_grn "  OK        $key"
      printf '    package  %s\n    matches  %s:%s\n\n' "${ppath:-(registry install)}" "$ref" "$refpath"
      continue
    fi

    drift=$((drift+1))
    c_red "  DRIFT     $key"
    printf '    package  %s\n    status   %s   version %s\n    against  %s:%s\n' \
      "${ppath:-(registry install)}" "$pstatus" "$pversion" "$ref" "$refpath"
    local kind rkey field rv dv
    while IFS=$'\t' read -r kind rkey field rv dv; do
      case "$kind" in
        MISSING) printf '    %s route "%s" is in the repo and NOT deployed\n' "$(c_red MISSING)" "$rkey" ;;
        EXTRA)   printf '    %s   route "%s" is deployed and NOT in the repo\n' "$(c_yel EXTRA)" "$rkey" ;;
        CHANGED) printf '    %s route "%s" field %s\n      repo      %s\n      deployed  %s\n' \
                   "$(c_red CHANGED)" "$rkey" "$field" "$rv" "$dv" ;;
      esac
    done < "$findings"
    printf '\n'
  done < "$WORK/deployed.index"

  # If --only named a key that does not exist, nothing was compared and the run
  # would otherwise print a green summary about zero plugins. A route-less
  # plugin is counted here too: it was paired and measured, but comparing it
  # decided nothing, so a sweep that found ONLY those still measured no routes
  # and must not exit green.
  if [ "$compared" -eq 0 ]; then
    die "compared 0 plugins ($unpaired had no counterpart under $ref:$pdir, $routeless declared no routes). Nothing was measured."
  fi

  printf '  %s plugin(s) compared, %s with no repo counterpart, %s declaring no routes (not compared).\n' \
    "$compared" "$unpaired" "$routeless"
  if [ "$drift" -gt 0 ]; then
    c_red "DRIFT: $drift plugin(s) are running a manifest that is not what $ref declares."
    c_red "The merged capability does not exist in the running system. Redeploying is an operator action."
    exit $EXIT_DRIFT
  fi
  c_grn "OK: every compared plugin's deployed route surface matches $ref."
  exit $EXIT_OK
}

SELFDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "${1:-}" in
  check)  shift; cmd_check "$@" ;;
  routes) shift; cmd_routes "$@" ;;
  -h|--help|"") usage; [ -n "${1:-}" ] && exit $EXIT_OK || exit $EXIT_REFUSED ;;
  *) die "unknown subcommand: $1" ;;
esac
