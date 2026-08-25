#!/usr/bin/env bash
# ===========================================================================
# Offline regression suite for plugin_manifest_gate.sh — the authority gate.
#
# WHY THIS RUNS ANYWHERE. Both sides of the comparison are fabricable: the
# suite builds a THROWAWAY git repo in mktemp holding a fixture plugin, and a
# separate "deployed" package directory it mutates. No plugin host, no network,
# no credential, and nothing it writes leaves the temp directory.
#
# THE THREE ASSERTIONS THAT CARRY THIS SUITE:
#
#   1. A comment-only change is NOT an escalation. This is the case the tool
#      was written for. On 2026-08-25 the deployed broker differed from
#      origin/main in three files by content hash, and every one of those
#      differences was a comment. TOG-318 had to establish that by eye. If this
#      tool ever regresses into comparing text, it reports ESCALATION on a
#      docstring, and a gate that cries wolf gets muted -- at which point it is
#      indistinguishable from a deleted one.
#
#   2. An UNKNOWN manifest key is scored as an escalation, not as clean. The
#      classification is an allowlist. The failure this pins is the slow one: a
#      future host version starts honouring a new authority-bearing field, and
#      the gate keeps printing OK about it because nobody taught it the name.
#
#   3. A surface that came back EMPTY refuses instead of comparing equal.
#      Zero-vs-zero is "the extractor measured nothing", not "clean".
#
# Exit status and machine-readable leaf paths only. No assertion here matches
# human-readable prose, which drifts.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="${PLUGIN_MANIFEST_GATE_SH:-$HERE/plugin_manifest_gate.sh}"
PASS=0; FAIL=0
ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

[ -x "$GATE" ] || { echo "no executable plugin_manifest_gate.sh at $GATE" >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

REPO="$WORK/repo"; DEP="$WORK/deployed"
PKGDIR="plugins/fixture-plugin"

# --- the fabricated world ---------------------------------------------------
# A manifest with the same SHAPE as the broker's: capabilities, two apiRoutes
# carrying auth/checkoutPolicy/companyResolution, and a config schema. Heavily
# commented on purpose -- assertion 1 needs comments to move.
write_manifest() {
  cat > "$1" <<'MANIFEST'
/**
 * fixture-plugin — manifest.
 * A long banner comment, so that rewriting it is a realistic edit.
 */
export const manifest = {
  id: "fixture-plugin",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Fixture Plugin",
  description: "A fixture.",
  author: "Test",
  categories: ["connector"],
  capabilities: [
    // Expose the routes.
    "api.routes.register",
    "secrets.read-ref",
    "issues.read",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  apiRoutes: [
    {
      // The cheap probe route.
      routeKey: "whoami",
      method: "GET",
      path: "/whoami",
      auth: "agent",
      capability: "api.routes.register",
      checkoutPolicy: "none",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      // The one that mints.
      routeKey: "mint",
      method: "POST",
      path: "/issues/:issueId/token",
      auth: "agent",
      capability: "api.routes.register",
      checkoutPolicy: "none",
      companyResolution: { from: "issue", param: "issueId" },
    },
  ],
  instanceConfigSchema: {
    type: "object",
    required: ["appId"],
    properties: { appId: { type: "string", title: "App ID" } },
  },
};
export default manifest;
MANIFEST
}

write_pkgjson() {
  cat > "$1" <<'PKGJSON'
{
  "name": "fixture-plugin",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "paperclipPlugin": {
    "manifest": "./dist/manifest.js",
    "worker": "./dist/worker.js"
  }
}
PKGJSON
}

mkdir -p "$REPO/$PKGDIR/dist"
write_manifest "$REPO/$PKGDIR/dist/manifest.js"
write_pkgjson  "$REPO/$PKGDIR/package.json"
git -C "$REPO" init -q
git -C "$REPO" config user.email t@example.invalid
git -C "$REPO" config user.name  Test
git -C "$REPO" config commit.gpgsign false
git -C "$REPO" add -A
git -C "$REPO" commit -qm fixture

REF="$(git -C "$REPO" rev-parse HEAD)"
MPATH="$PKGDIR/dist/manifest.js"

# Restores the deployed copy to the committed state before each case.
reset_deployed() {
  rm -rf "$DEP"; mkdir -p "$DEP/dist"
  write_manifest "$DEP/dist/manifest.js"
  write_pkgjson  "$DEP/package.json"
}

# Runs the gate against the deployed copy; sets GOT (exit) and OUT (stdout+err).
run_gate() {
  OUT="$("$GATE" compare --deployed "$DEP" --repo "$REPO" \
        --reference-ref "$REF" --reference-path "$MPATH" 2>&1)"
  GOT=$?
}

# expect <name> <expected-exit> [<leaf>] [<verdict the leaf must be given>]
#
# The verdict argument is not decoration. Without it, every authority test here
# is satisfied by the gate standing NEXT to the one it means to pin: drop `auth`
# from the authority allowlist and the leaf falls through to UNCLASSIFIED, which
# also exits 4, so an exit-code-only assertion stays green while the field is no
# longer recognised as authority-bearing at all. That vacuity was live in this
# suite until the CI mutation gate caught it. Asserting the verdict makes the
# test fail for the reason it is named after.
expect() {
  local name="$1" want="$2" leaf="${3:-}" verdict="${4:-}"
  run_gate
  if [ "$GOT" -ne "$want" ]; then
    bad "$name: exit $GOT, want $want"
    printf '%s\n' "$OUT" | sed 's/^/        /' | head -12
    return
  fi
  if [ -n "$leaf" ] && ! grep -aqF -- "$leaf" <<< "$OUT"; then
    bad "$name: exit $want as expected, but the report never names the leaf $leaf"
    printf '%s\n' "$OUT" | sed 's/^/        /' | head -12
    return
  fi
  # The verdict must be the one attached to THIS leaf, not one that merely
  # appears somewhere in the report. The gate prints a verdict on the line
  # directly above its leaf, so the pairing is checked by adjacency. Grepping
  # for the two independently is not enough: a fixture that perturbs a second
  # field emits a second block, and that block's verdict then satisfies the
  # assertion while the leaf under test is classified some entirely other way.
  # The repointed-package.json case did exactly that.
  if [ -n "$verdict" ]; then
    local paired
    paired="$(awk -v leaf="    leaf       $leaf" -v v="$verdict" '
      index($0, leaf) == 1 && index(prev, v) > 0 { found = 1 }
      { prev = $0 }
      END { print (found ? "yes" : "no") }' <<< "$OUT")"
    if [ "$paired" != yes ]; then
      bad "$name: exit $want and leaf named, but that leaf's own verdict is not '$verdict' — it is being caught by a different rule than the one this test pins"
      printf '%s\n' "$OUT" | sed 's/^/        /' | head -16
      return
    fi
  fi
  ok "$name"
}

# ---------------------------------------------------------------------------
hdr "the baseline: an untouched copy compares clean"
reset_deployed
expect "identical package exits 0" 0

# ---------------------------------------------------------------------------
hdr "assertion 1 — structure, not text: comments must be invisible"
reset_deployed
# Rewrite every comment in the file, including a multi-line banner, and add a
# new one. This is precisely the shape of the live 2026-08-25 broker drift.
python3 - "$DEP/dist/manifest.js" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()
s = s.replace("/**\n * fixture-plugin — manifest.\n * A long banner comment, so that rewriting it is a realistic edit.\n */",
              "/**\n * fixture-plugin — manifest.\n * TOTALLY DIFFERENT banner, several\n * lines longer than\n * the one it replaced.\n */")
s = re.sub(r"//[^\n]*", "// a rewritten comment", s)
s = s.replace('  id: "fixture-plugin",', '  // brand new comment nobody had before\n  id: "fixture-plugin",')
open(p, "w").write(s)
PY
if ! grep -aq "TOTALLY DIFFERENT" "$DEP/dist/manifest.js"; then
  bad "comment-only rewrite: the fixture edit did not apply, so this case tests nothing"
else
  if cmp -s "$DEP/dist/manifest.js" "$REPO/$MPATH"; then
    bad "comment-only rewrite: the files are still byte-identical, so this case tests nothing"
  else
    expect "comment-only rewrite is not an escalation" 0
  fi
fi

# Reordering must not read as a change either: routes are keyed by routeKey and
# capability lists are compared as sets.
reset_deployed
python3 - "$DEP/dist/manifest.js" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
s = s.replace('''    "api.routes.register",
    "secrets.read-ref",
    "issues.read",''', '''    "issues.read",
    "api.routes.register",
    "secrets.read-ref",''')
open(p, "w").write(s)
PY
if cmp -s "$DEP/dist/manifest.js" "$REPO/$MPATH"; then
  bad "capability reordering: the fixture swap did not apply, so this case tests nothing"
else
  expect "capability reordering is not a change" 0
fi

reset_deployed
python3 - "$DEP/dist/manifest.js" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()
# Swap the two route objects whole, comments included. Anchored on each block's
# closing "    },\n" so this is a real reorder and not a rewrite.
blocks = re.findall(r"    \{\n(?:.*?)\n    \},\n", s, re.S)
routes = [b for b in blocks if "routeKey:" in b]
if len(routes) != 2:
    sys.exit("fixture: expected 2 route blocks, found %d" % len(routes))
s = s.replace(routes[0] + routes[1], routes[1] + routes[0])
open(p, "w").write(s)
PY
# A fixture edit that silently does nothing makes the case below pass for the
# wrong reason -- and this one did, until the CI mutation gate found the test
# could not be reddened by indexing routes instead of keying them by routeKey.
if cmp -s "$DEP/dist/manifest.js" "$REPO/$MPATH"; then
  bad "route reordering: the fixture swap did not apply, so this case tests nothing"
else
  expect "route reordering is not a change" 0
fi

# ---------------------------------------------------------------------------
hdr "authority-bearing differences must exit 4"

reset_deployed
sed -i 's|    "issues.read",|    "issues.read",\n    "secrets.read-all",|' "$DEP/dist/manifest.js"
expect "an added capability is an escalation" 4 "capabilities[secrets.read-all]" "ESCALATION  added"

reset_deployed
sed -i '0,/      auth: "agent",/s//      auth: "none",/' "$DEP/dist/manifest.js"
expect "a changed route auth is an escalation" 4 "apiRoutes[whoami].auth" "ESCALATION  changed"

reset_deployed
sed -i '0,/      checkoutPolicy: "none",/s//      checkoutPolicy: "required-for-agent-in-progress",/' "$DEP/dist/manifest.js"
expect "a changed checkoutPolicy is an escalation" 4 "apiRoutes[whoami].checkoutPolicy" "ESCALATION  changed"

reset_deployed
sed -i 's|companyResolution: { from: "issue", param: "issueId" }|companyResolution: { from: "query", key: "companyId" }|' "$DEP/dist/manifest.js"
expect "a changed companyResolution is an escalation" 4 "apiRoutes[mint].companyResolution" "ESCALATION  changed"

reset_deployed
python3 - "$DEP/dist/manifest.js" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
s = s.replace("  ],\n  instanceConfigSchema:", '''    {
      routeKey: "backdoor",
      method: "POST",
      path: "/anything",
      auth: "none",
      capability: "api.routes.register",
      checkoutPolicy: "none",
      companyResolution: { from: "query", key: "companyId" },
    },
  ],
  instanceConfigSchema:''')
open(p, "w").write(s)
PY
expect "an added route is an escalation" 4 "apiRoutes[backdoor].auth" "ESCALATION  added"

reset_deployed
sed -i 's|    worker: "./dist/worker.js",|    worker: "./dist/other.js",|' "$DEP/dist/manifest.js"
expect "a repointed worker entrypoint is an escalation" 4 "entrypoints.worker" "ESCALATION  changed"

# The pointer in package.json selects WHICH file is the authorization
# declaration. Repointing it swaps the whole manifest while leaving the file
# the gate would otherwise have read untouched.
reset_deployed
cp "$DEP/dist/manifest.js" "$DEP/dist/manifest2.js"
sed -i '0,/      auth: "agent",/s//      auth: "none",/' "$DEP/dist/manifest2.js"
sed -i 's|"manifest": "./dist/manifest.js"|"manifest": "./dist/manifest2.js"|' "$DEP/package.json"
expect "a repointed package.json manifest is an escalation" 4 "#packageManifestPath" "ESCALATION  changed"

# ---------------------------------------------------------------------------
hdr "assertion 2 — the classification is an allowlist, so unknown fails closed"
reset_deployed
sed -i 's|  categories: \["connector"\],|  categories: ["connector"],\n  someFutureAuthField: "grant-everything",|' "$DEP/dist/manifest.js"
expect "an unclassified manifest field is an escalation" 4 "someFutureAuthField" "unclassified field"

# ---------------------------------------------------------------------------
hdr "narrowing and cosmetic differences are reported, not scored as escalation"
reset_deployed
sed -i '/    "secrets.read-ref",/d' "$DEP/dist/manifest.js"
expect "a removed capability is narrowing, not escalation" 3 "capabilities[secrets.read-ref]" "NARROWING   removed"

reset_deployed
sed -i 's|  displayName: "Fixture Plugin",|  displayName: "Renamed Fixture",|' "$DEP/dist/manifest.js"
expect "a display-name change is not an escalation" 3 "displayName" "INFO        non-authority"

reset_deployed
sed -i 's|title: "App ID"|title: "Application ID"|' "$DEP/dist/manifest.js"
expect "an instanceConfigSchema change is not an escalation" 3 "instanceConfigSchema" "INFO        non-authority"

# ---------------------------------------------------------------------------
hdr "assertion 3 — a comparison that measured nothing must not read green"

reset_deployed
: > "$DEP/dist/manifest.js"
run_gate
if [ "$GOT" -eq 0 ]; then
  bad "an empty manifest read as OK — a comparison that measured nothing reported clean"
elif [ "$GOT" -ne 2 ]; then
  bad "an empty manifest exited $GOT, want 2 (refused)"
else
  ok "an empty manifest is refused, not compared"
fi

reset_deployed
printf 'export const manifest = {\n  id: "broken",\n' > "$DEP/dist/manifest.js"
run_gate
if [ "$GOT" -eq 0 ]; then
  bad "an unparseable manifest read as OK — a comparison that measured nothing reported clean"
elif [ "$GOT" -ne 2 ]; then
  bad "an unparseable manifest exited $GOT, want 2 (refused)"
else
  ok "an unparseable manifest is refused, not compared"
fi

reset_deployed
printf 'export const notTheManifest = { id: "x" };\n' > "$DEP/dist/manifest.js"
run_gate
if [ "$GOT" -eq 0 ]; then
  bad "a manifest exporting nothing read as OK — a comparison that measured nothing reported clean"
else
  ok "a module exporting no manifest is refused"
fi

# The zero-vs-zero case the authority-leaf guard exists for: both sides
# evaluate cleanly and both degenerate to a contentless surface. Every leaf
# compares equal, so without the guard this prints OK about a comparison that
# measured none of the fields the gate exists to compare.
DEGEN="$WORK/degen"; rm -rf "$DEGEN"; mkdir -p "$DEGEN/dist"
write_pkgjson "$DEGEN/package.json"
printf 'export const manifest = {};\n' > "$DEGEN/dist/manifest.js"
reset_deployed
printf 'export const manifest = {};\n' > "$DEP/dist/manifest.js"
OUT="$("$GATE" compare --deployed "$DEP" --reference-file "$DEGEN/dist/manifest.js" 2>&1)"; GOT=$?
if [ "$GOT" -eq 0 ]; then
  bad "two contentless manifests read as OK — a comparison that measured nothing reported clean"
elif [ "$GOT" -ne 2 ]; then
  bad "two contentless manifests exited $GOT, want 2 (refused)"
else
  ok "a surface with no authority-bearing leaves is refused, not compared"
fi

reset_deployed
sed -i 's|"manifest": "./dist/manifest.js"|"manifest": "./dist/missing.js"|' "$DEP/package.json"
run_gate
if [ "$GOT" -eq 0 ]; then
  bad "a dangling manifest pointer read as OK — a comparison that measured nothing reported clean"
else
  ok "a dangling manifest pointer is refused"
fi

# ---------------------------------------------------------------------------
hdr "refusals"
reset_deployed
OUT="$("$GATE" compare --repo "$REPO" 2>&1)"; GOT=$?
[ "$GOT" -eq 2 ] && ok "compare without --deployed is refused" \
                 || bad "compare without --deployed exited $GOT, want 2"

OUT="$("$GATE" compare --deployed "$DEP" --repo "$REPO" --reference-ref "$REF" \
       --reference-path "plugins/nope/dist/manifest.js" 2>&1)"; GOT=$?
[ "$GOT" -eq 2 ] && ok "an unreadable reference path is refused" \
                 || bad "an unreadable reference path exited $GOT, want 2"

OUT="$("$GATE" frobnicate 2>&1)"; GOT=$?
[ "$GOT" -eq 2 ] && ok "an unknown subcommand is refused" \
                 || bad "an unknown subcommand exited $GOT, want 2"

# ---------------------------------------------------------------------------
printf '\n\033[1m%d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
[ "$PASS" -gt 0 ] || { echo "no assertions ran" >&2; exit 1; }
exit 0
