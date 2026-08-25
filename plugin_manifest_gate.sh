#!/usr/bin/env bash
# ===========================================================================
# plugin_manifest_gate.sh — does activating this package change its AUTHORITY?
#
# WHY THIS EXISTS (TOG-349). The Paperclip host has two ways to replace a
# plugin's registered `manifestJson`, and they enforce different rules:
#
#   POST /api/plugins/:id/upgrade -> loader.upgradePlugin()
#       assertInstanceAdmin, AND a capability-escalation check that refuses,
#       naming the added capabilities.
#
#   activatePlugin() -> refreshPluginManifestFromPackage()
#       no admin check, no escalation check. It re-reads the manifest from the
#       package directory and, if it differs by JSON.stringify, writes it
#       straight into the registry. The only validation is a shape check.
#
# `manifestJson` is the live source of truth for `capabilities`,
# `apiRoutes[].auth`, `apiRoutes[].checkoutPolicy` and
# `apiRoutes[].companyResolution`. It is an authorization declaration, not
# packaging metadata. So the second path re-declares a plugin's authority with
# no approval step, at the next activation.
#
# It is reachable here because gh-token-broker is installed from a local path
# inside an AGENT WORKSPACE, and copying a new dist/ into that directory is the
# sanctioned deploy mechanism. Deploy channel and authority channel are the same
# directory; only one of them is meant to be self-service. Moving the package to
# a host-owned path is the real fix and it needs the operator. This is what can
# be shipped from inside the container in the meantime: it does not PREVENT the
# write, it makes the write legible before somebody activates.
#
# WHAT MAKES IT DIFFERENT FROM tool_drift.sh. That tool answers "is the running
# copy the reviewed copy", by content hash. This one answers a question a hash
# cannot: the deployed manifest may legitimately differ from the reviewed one
# and still declare exactly the same authority — TOG-318 had to establish that
# by hand, by eye, from a diff. Here the difference is comment-only, and a hash
# says DRIFT to that while the authority is untouched. A gate that cries wolf on
# a comment gets muted. This compares the EVALUATED STRUCTURE, so comments and
# formatting are invisible to it and a changed `auth` value is not.
#
# THE CLASSIFICATION IS AN ALLOWLIST, AND UNKNOWN FIELDS FAIL CLOSED. Every
# leaf is either on the authority list or the non-authority list. A leaf on
# NEITHER — a manifest key some future host version starts honouring — is
# reported as UNCLASSIFIED and scored as an escalation. A denylist would score
# it as clean, which is the failure mode where a new authority-bearing field
# arrives and this gate keeps printing OK. Adding a key here is a deliberate
# act; a new key reading green never should be.
#
# WHY NO RANKING OF `auth` / `checkoutPolicy` VALUES. It is tempting to order
# them and only flag the relaxing direction. This tool refuses to, because the
# host's ordering is not the intuitive one and has not been measured: the broker
# manifest's own comment documents that "required-for-agent-in-progress" — which
# reads as the strictest of the three — SKIPS the ownership assertion in exactly
# the case an attacker would pick, and is the weakest. Encoding a guessed rank
# would let the dangerous direction through while printing a confident verdict.
# Any change to those fields is reported and needs a human. That is a smaller
# claim, and it is one this tool can actually support.
#
# EXECUTION WARNING. Extracting the surface IMPORTS the manifest module, so the
# file's author gets to run code as whoever runs this. That is fine for the
# agent that already owns the directory, and it is NOT fine for an operator
# running as root against an agent-writable path. Run it as an unprivileged uid.
# A parse-only extractor would be better and needs a JS parser this box lacks.
# ===========================================================================
set -uo pipefail

ME="$(basename "${BASH_SOURCE[0]}")"

# Exit codes are the interface; callers gate on these, never on printed text.
#   0  compared, authority identical
#   2  refused (bad usage, unreadable input, manifest would not evaluate)
#   3  differences, all of them in non-authority fields
#   4  an authority-bearing or UNCLASSIFIED field differs
EXIT_OK=0; EXIT_REFUSED=2; EXIT_REVIEW=3; EXIT_ESCALATION=4

NODE_TIMEOUT="${PLUGIN_MANIFEST_GATE_TIMEOUT:-10}"

c_red() { printf '\033[31m%s\033[0m\n' "$*"; }
c_grn() { printf '\033[32m%s\033[0m\n' "$*"; }
c_yel() { printf '\033[33m%s\033[0m\n' "$*"; }
die()   { c_red "$ME: $*" >&2; exit $EXIT_REFUSED; }

WORK=""
trap '[ -n "$WORK" ] && rm -rf "$WORK"' EXIT

usage() {
  cat <<EOF
$ME — compare the AUTHORIZATION SURFACE of a plugin package against a reviewed ref.

  $ME surface <package-dir|manifest.js>
      Print the evaluated authorization surface as sorted <path>\\t<json> lines.

  $ME compare --deployed <package-dir|manifest.js> [options]
      --reference-ref REF     git ref to read the reviewed manifest from
                              (default: origin/main)
      --reference-path PATH   path within the ref
                              (default: plugins/gh-token-broker/dist/manifest.js)
      --reference-file FILE   read the reviewed side from a file instead of git
      --repo DIR              git checkout to resolve --reference-ref in
                              (default: the cwd)

Exit: 0 identical  2 refused  3 non-authority differences  4 authority differs
EOF
}

# --- the authority allowlist ------------------------------------------------
# Matched against the flattened leaf paths emitted by extract_surface(). Both
# lists are anchored ERE. A leaf matching neither is UNCLASSIFIED and scored as
# an escalation -- see the header.
#
# `#packageManifestPath` is synthetic: it is the manifest pointer read out of
# package.json's paperclipPlugin.manifest. It has to be in the comparison,
# because repointing it at a different file in the same package swaps the whole
# authorization declaration while leaving the file this tool would otherwise
# have read untouched.
AUTHORITY_PATHS=(
  '^#packageManifestPath$'
  '^id$'
  '^apiVersion$'
  '^capabilities\[.*\]$'
  '^entrypoints\.'
  '^apiRoutes\[[^]]*\]\.(routeKey|method|path|auth|capability|checkoutPolicy)$'
  '^apiRoutes\[[^]]*\]\.companyResolution(\.|$)'
)

# Display and packaging metadata. Reported, never scored as an escalation.
#
# instanceConfigSchema is here deliberately. It describes the shape of config an
# instance admin supplies; it cannot itself grant a capability or relax a route,
# and the values it describes are not in the package. A change to it still
# prints, so a reviewer sees it.
NONAUTHORITY_PATHS=(
  '^version$'
  '^displayName$'
  '^description$'
  '^author$'
  '^categories\[.*\]$'
  '^instanceConfigSchema(\.|$)'
)

classify() {
  local leaf="$1" re
  for re in "${AUTHORITY_PATHS[@]}";     do [[ "$leaf" =~ $re ]] && { echo AUTHORITY;     return; }; done
  for re in "${NONAUTHORITY_PATHS[@]}"; do [[ "$leaf" =~ $re ]] && { echo NONAUTHORITY; return; }; done
  echo UNCLASSIFIED
}

# --- surface extraction -----------------------------------------------------
# Flattens the evaluated manifest to sorted `path<TAB>json` leaves.
#
# Two things are keyed rather than indexed, on purpose:
#   apiRoutes  keyed by routeKey. Indexed, inserting a route at the front
#              reports every later route as changed and buries the one that
#              was added in the noise.
#   string arrays  emitted as a SET, one leaf per element. That makes
#              "capability added" and "capability removed" separate,
#              individually classifiable facts instead of one opaque
#              list-changed, and makes reordering a no-op.
FLATTEN_JS='
const path = process.argv[1];
const out = [];
const enc = (v) => JSON.stringify(v);
function walk(node, prefix) {
  if (node === null || typeof node !== "object") { out.push(prefix + "\t" + enc(node)); return; }
  if (Array.isArray(node)) {
    if (node.length === 0) { out.push(prefix + "\t" + enc([])); return; }
    if (node.every((e) => typeof e === "string")) {
      for (const e of node) out.push(prefix + "[" + e + "]\t" + enc(true));
      return;
    }
    const keyed = node.every((e) => e && typeof e === "object" && typeof e.routeKey === "string");
    node.forEach((e, i) => walk(e, prefix + "[" + (keyed ? e.routeKey : i) + "]"));
    return;
  }
  const keys = Object.keys(node).sort();
  if (keys.length === 0) { out.push(prefix + "\t" + enc({})); return; }
  for (const k of keys) walk(node[k], prefix === "" ? k : prefix + "." + k);
}
const mod = await import(path);
const m = mod.manifest ?? mod.default;
if (!m || typeof m !== "object") { console.error("module exports no manifest object"); process.exit(9); }
walk(m, "");
out.sort();
process.stdout.write(out.join("\n") + "\n");
'

# Resolves a package dir to its manifest file via package.json, and echoes the
# declared relative pointer on fd 3 so the caller can put it in the surface.
# A bare manifest.js argument is accepted too -- then there is no pointer to
# compare and the synthetic leaf is recorded as absent, which is itself a
# difference if the other side has one.
resolve_manifest() {
  local target="$1" pkg ptr
  if [ -d "$target" ]; then
    pkg="$target/package.json"
    [ -r "$pkg" ] || die "no readable package.json in $target"
    ptr="$(node -e '
      const fs=require("fs");
      const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      const m=p&&p.paperclipPlugin&&p.paperclipPlugin.manifest;
      if(typeof m!=="string"){process.exit(9);}
      process.stdout.write(m);
    ' "$pkg" 2>/dev/null)" || die "package.json in $target declares no paperclipPlugin.manifest"
    [ -n "$ptr" ] || die "package.json in $target declares no paperclipPlugin.manifest"
    printf '%s' "$ptr" >&3
    local resolved="$target/${ptr#./}"
    [ -r "$resolved" ] || die "manifest pointer $ptr does not resolve to a readable file under $target"
    printf '%s' "$resolved"
    return 0
  fi
  [ -r "$target" ] || die "not a readable file or directory: $target"
  printf '%s' '(none)' >&3
  printf '%s' "$target"
}

# Writes flattened leaves for $1 (package dir or manifest file) to stdout.
extract_surface() {
  local target="$1" mfile ptr ptrfile
  ptrfile="$WORK/ptr.$$"
  mfile="$(resolve_manifest "$target" 3>"$ptrfile")" || exit $EXIT_REFUSED
  ptr="$(cat "$ptrfile")"

  local abs; abs="$(cd "$(dirname "$mfile")" && pwd)/$(basename "$mfile")"
  local flat status
  flat="$(timeout "$NODE_TIMEOUT" node --input-type=module -e "$FLATTEN_JS" "$abs" 2>&1)"; status=$?
  if [ $status -ne 0 ]; then
    c_red "$ME: could not evaluate the manifest at $abs (node exit $status)" >&2
    printf '%s\n' "$flat" >&2
    exit $EXIT_REFUSED
  fi
  printf '#packageManifestPath\t%s\n' "$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$ptr")"
  printf '%s\n' "$flat"
}

cmd_surface() {
  [ $# -eq 1 ] || { usage >&2; exit $EXIT_REFUSED; }
  WORK="$(mktemp -d)"
  extract_surface "$1" | sort
}

cmd_compare() {
  local deployed="" ref="origin/main" refpath="plugins/gh-token-broker/dist/manifest.js"
  local reffile="" repo="."
  while [ $# -gt 0 ]; do
    case "$1" in
      --deployed)       deployed="${2:?}"; shift 2 ;;
      --reference-ref)  ref="${2:?}"; shift 2 ;;
      --reference-path) refpath="${2:?}"; shift 2 ;;
      --reference-file) reffile="${2:?}"; shift 2 ;;
      --repo)           repo="${2:?}"; shift 2 ;;
      -h|--help)        usage; exit $EXIT_OK ;;
      *) die "unknown argument: $1" ;;
    esac
  done
  [ -n "$deployed" ] || die "compare needs --deployed"

  WORK="$(mktemp -d)"
  local dep_s="$WORK/deployed.surface" ref_s="$WORK/reference.surface"

  extract_surface "$deployed" | sort > "$dep_s" || exit $EXIT_REFUSED

  local ref_label
  if [ -n "$reffile" ]; then
    [ -r "$reffile" ] || die "unreadable --reference-file: $reffile"
    ref_label="$reffile"
    extract_surface "$reffile" | sort > "$ref_s" || exit $EXIT_REFUSED
  else
    git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || die "--repo $repo is not a git checkout"
    ref_label="$ref:$refpath"
    local staged="$WORK/ref-pkg"
    mkdir -p "$staged/$(dirname "$refpath")"
    git -C "$repo" cat-file blob "$ref:$refpath" > "$staged/$refpath" 2>/dev/null \
      || die "cannot read $ref:$refpath out of $repo"
    # Stage the reference with the same package.json pointer, so the synthetic
    # pointer leaf is comparable rather than always-absent on this side.
    local refpkgjson; refpkgjson="$(dirname "$(dirname "$refpath")")/package.json"
    if git -C "$repo" cat-file -e "$ref:$refpkgjson" 2>/dev/null; then
      git -C "$repo" cat-file blob "$ref:$refpkgjson" > "$staged/$refpkgjson"
      extract_surface "$staged/$(dirname "$(dirname "$refpath")")" | sort > "$ref_s" || exit $EXIT_REFUSED
    else
      extract_surface "$staged/$refpath" | sort > "$ref_s" || exit $EXIT_REFUSED
    fi
  fi

  local dep_n ref_n
  dep_n=$(wc -l < "$dep_s"); ref_n=$(wc -l < "$ref_s")

  # The reference must actually contain authority-bearing leaves. Counting total
  # leaves would not do: the extractor always emits the synthetic pointer, and a
  # manifest that evaluates to `{}` still yields a line, so a total-count check
  # can never fire and reads as a safety net while being dead code.
  #
  # What this catches is the zero-vs-zero case: if the walker is ever broken by
  # a refactor, BOTH sides degenerate to the same contentless surface, every
  # leaf compares equal, and the gate prints OK about a comparison that measured
  # none of the fields it exists to compare.
  # `#packageManifestPath` is excluded from the count on purpose: it is emitted
  # unconditionally by the extractor, so counting it would make this guard
  # always satisfied -- the same dead-code failure the check above describes.
  local ref_auth=0 l
  while IFS= read -r l; do
    [ "$l" = '#packageManifestPath' ] && continue
    [ "$(classify "$l")" = AUTHORITY ] && ref_auth=$((ref_auth+1))
  done < <(cut -f1 "$ref_s")
  if [ "$ref_auth" -eq 0 ]; then
    die "the reference surface has no authority-bearing leaves (deployed=$dep_n reference=$ref_n leaves) — the extractor measured none of the fields this gate compares"
  fi

  printf '\033[1mplugin manifest gate\033[0m\n'
  printf '  deployed   %s  (%s leaves)\n' "$deployed" "$dep_n"
  printf '  reference  %s  (%s leaves)\n' "$ref_label" "$ref_n"
  printf '\n'

  local esc=0 rev=0
  local leaf dv rv cls verdict
  # The join is done in awk on the exact leaf key. Doing it with grep would
  # match a leaf that is a substring of a longer one -- `capabilities[issues.read]`
  # against `capabilities[issues.read-all]` -- and silently compare the wrong
  # pair. Emits only the differing leaves, tab-separated: leaf, reference, deployed.
  while IFS=$'\t' read -r leaf rv dv; do
    cls="$(classify "$leaf")"
    case "$cls" in
      AUTHORITY)
        if [ "$rv" = '(absent)' ]; then verdict="ESCALATION  added"
        elif [ "$dv" = '(absent)' ]; then verdict="NARROWING   removed"
        else verdict="ESCALATION  changed"; fi ;;
      UNCLASSIFIED)
        verdict="ESCALATION  unclassified field — this gate does not know what it grants" ;;
      *)
        verdict="INFO        non-authority" ;;
    esac

    case "$verdict" in
      ESCALATION*) esc=$((esc+1)); c_red   "  $verdict" ;;
      NARROWING*)  rev=$((rev+1)); c_yel   "  $verdict" ;;
      *)           rev=$((rev+1)); printf  '  %s\n' "$verdict" ;;
    esac
    printf '    leaf       %s\n    reference  %s\n    deployed   %s\n\n' "$leaf" "$rv" "$dv"
  done < <(awk -F'\t' '
    NR==FNR { ref[$1]=$2; seen[$1]=1; next }
            { dep[$1]=$2; seen[$1]=1 }
    END {
      for (k in seen) {
        r = (k in ref) ? ref[k] : "(absent)"
        d = (k in dep) ? dep[k] : "(absent)"
        if (r != d) printf "%s\t%s\t%s\n", k, r, d
      }
    }' "$ref_s" "$dep_s" | sort)

  if [ "$esc" -gt 0 ]; then
    c_red "ESCALATION: $esc authority-bearing difference(s), $rev other(s)."
    c_red "Activating this package re-declares the plugin's authority. Do not activate without review."
    exit $EXIT_ESCALATION
  fi
  if [ "$rev" -gt 0 ]; then
    c_yel "REVIEW: 0 authority-bearing differences, $rev non-authority difference(s)."
    c_yel "Activation adopts this manifest; the authority it declares is unchanged."
    exit $EXIT_REVIEW
  fi
  c_grn "OK: the deployed authorization surface is identical to $ref_label."
  exit $EXIT_OK
}

case "${1:-}" in
  surface) shift; cmd_surface "$@" ;;
  compare) shift; cmd_compare "$@" ;;
  -h|--help|"") usage; [ -n "${1:-}" ] && exit $EXIT_OK || exit $EXIT_REFUSED ;;
  *) die "unknown subcommand: $1" ;;
esac
