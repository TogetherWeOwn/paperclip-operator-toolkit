#!/usr/bin/env bash
# ===========================================================================
# Offline regression suite for plugin_deploy_drift.sh — the deployed-vs-repo
# manifest detector.
#
# WHY THIS RUNS ANYWHERE. Both sides are fabricable. The deployed side arrives
# through the PLUGINS_SOURCE_CMD seam, so the suite feeds it a FILE instead of a
# database; the repo side is a throwaway git repo in mktemp. No database, no
# plugin host, no network, no credential, and nothing it writes leaves the temp
# directory.
#
# THE FIXTURE IS A SCRUBBED SNAPSHOT, SHAPED LIKE THE REAL THING.
# tests/fixtures/plugin-deploy/rows.tsv preserves the two load-bearing
# properties of a real `pg_source.js plugins` capture — rows with an EMPTY
# package_path, and manifests with database-reordered object keys — while
# deploy paths, author identities and vendor endpoints are example values.
# A stub with every column populated is green on a detector with the
# double-tab bug still in it, so the properties matter more than the values:
#
#   1. Four rows have an EMPTY package_path. Tab is an IFS *whitespace*
#      character, so `IFS=$'\t' read` collapses the resulting double tab and
#      every later column shifts left — the manifest lands in `version` and the
#      manifest field comes back empty. Three of six plugins failed to parse on
#      the first run because of it. A stub with every column populated is green
#      on a detector with that bug still in it.
#   2. The deployed manifests are jsonb, so PostgreSQL has REORDERED their
#      object keys. The repo writes { from, key } and the row returns
#      { key, from }. The first run reported both brokers as CHANGED on that.
#
# The repo side of the baseline is GENERATED FROM the deployed JSON, so the
# baseline is identical by construction and every red case below is a
# deliberate, named mutation away from it. That is what makes exit 0 mean
# something: it is not a hand-copied pair that happens to agree.
#
# THE MUTATIONS THIS SUITE EXISTS FOR. A negative grep is not an assertion, so
# every capability claimed for the detector is pinned by mutating toward the
# WORSE case and confirming it goes red:
#
#   - a route DELETED from the deployed side          -> MISSING, exit 4
#   - one route's `auth` value SWAPPED                -> CHANGED auth, exit 4
#   - one route SWAPPED FOR ANOTHER, count unchanged  -> exit 4
#         This is the one the issue names. A count check passes here: four
#         routes before, four after. Only route IDENTITY catches it.
#
# AND THE REFUSALS. A detector that cannot read its input must exit 2, never 0.
# Exit 0 from this tool is a positive claim that manifests were compared and
# matched; "I measured nothing" reaching the same exit code is the silent-green
# failure that has hidden three defects on this board.
#
# Assertions are on exit status and machine-readable route/field names only. No
# assertion matches human-readable prose, which drifts.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${PLUGIN_DEPLOY_DRIFT_SH:-$HERE/plugin_deploy_drift.sh}"
FIXTURE="${PLUGIN_DEPLOY_ROWS_FIXTURE:-$HERE/tests/fixtures/plugin-deploy/rows.tsv}"

PASS=0; FAIL=0
ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; [ $# -gt 1 ] && printf '        %s\n' "$2"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

[ -x "$TOOL" ] || { echo "no executable plugin_deploy_drift.sh at $TOOL" >&2; exit 2; }
[ -r "$FIXTURE" ] || { echo "no readable deployed-rows fixture at $FIXTURE" >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 2; }
command -v git  >/dev/null 2>&1 || { echo "git is required" >&2; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

REPO="$WORK/repo"
ROWS="$WORK/rows.tsv"
KEY="gh-token-broker"

# --- the fixture must actually be the thing it claims to be -----------------
# If this file is ever replaced by a stub, or regenerated against a host where
# the broker is absent, every case below still "passes" against whatever it does
# contain. Pin the two properties the suite depends on.
hdr "the fixture is the real deployed artifact"

# CASE NAMES ARE FIXED STRINGS, never interpolated. The mutation gate names the
# case each mutation must redden, so a name carrying a count changes identity
# exactly when the thing under test changes — and the gate can then never match
# it. Counts go in the detail line under the verdict.
FIXROWS="$(wc -l < "$FIXTURE")"
if [ "$FIXROWS" -lt 2 ]; then
  bad "the fixture carries more than one deployed plugin row"
  printf '        got %s row(s); a single-row fixture cannot exercise enumeration\n' "$FIXROWS"
else
  ok "the fixture carries more than one deployed plugin row"
fi

# The empty-package_path rows are what caught the IFS tab-collapse bug. Without
# at least one, this suite is green on a detector that silently drops columns.
EMPTYPATH="$(awk -F'\t' '$2=="" {n++} END {print n+0}' "$FIXTURE")"
if [ "$EMPTYPATH" -lt 1 ]; then
  bad "the fixture has rows with an empty package_path"
  printf '        none found; the IFS tab-collapse column-shift case is not covered\n'
else
  ok "the fixture has rows with an empty package_path"
fi

if ! awk -F'\t' -v k="$KEY" '$1==k {found=1} END {exit !found}' "$FIXTURE"; then
  echo "fixture does not contain the $KEY row; cannot run" >&2
  exit 2
fi

# --- build the repo side FROM the deployed artifact -------------------------
# Emits a real JS manifest module whose apiRoutes are exactly the deployed ones,
# with a banner comment so the comment-invisibility case has something to move.
# `--drop`, `--set-auth` and `--rename` are the mutation levers.
cat > "$WORK/gen.js" <<'GEN'
const fs = require("fs");
const [rowsFile, key, outFile, ...rest] = process.argv.slice(2);

let manifest = null;
for (const line of fs.readFileSync(rowsFile, "utf8").split("\n")) {
  if (!line) continue;
  const c = line.split("\t");
  if (c[0] === key) { manifest = JSON.parse(c[4]); break; }
}
if (!manifest) { console.error("no row for " + key); process.exit(9); }

let routes = Array.isArray(manifest.apiRoutes) ? manifest.apiRoutes : [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--drop") {
    const k = rest[++i];
    const before = routes.length;
    routes = routes.filter((r) => r.routeKey !== k);
    if (routes.length === before) { console.error("no route " + k + " to drop"); process.exit(9); }
  } else if (rest[i] === "--set-auth") {
    const k = rest[++i], v = rest[++i];
    const r = routes.find((x) => x.routeKey === k);
    if (!r) { console.error("no route " + k); process.exit(9); }
    if (r.auth === v) { console.error("route " + k + " auth is already " + v); process.exit(9); }
    r.auth = v;
  } else if (rest[i] === "--rename") {
    // Swap one route for another, leaving the COUNT untouched. This is the
    // mutation a count check cannot see.
    const k = rest[++i], v = rest[++i];
    const r = routes.find((x) => x.routeKey === k);
    if (!r) { console.error("no route " + k); process.exit(9); }
    r.routeKey = v;
  } else if (rest[i] === "--reorder-keys") {
    // Reverse every nested object's key order. Must be invisible to the
    // detector: jsonb does not preserve insertion order, so this difference
    // exists on every real comparison and is not a fact about the manifest.
    const rev = (v) => {
      if (Array.isArray(v)) return v.map(rev);
      if (v && typeof v === "object") {
        const o = {};
        for (const kk of Object.keys(v).reverse()) o[kk] = rev(v[kk]);
        return o;
      }
      return v;
    };
    routes = routes.map(rev);
  } else { console.error("unknown lever " + rest[i]); process.exit(9); }
}
manifest.apiRoutes = routes;

fs.writeFileSync(outFile,
  "/**\n * " + key + " — manifest.\n * Generated for the offline suite from the DEPLOYED artifact.\n */\n" +
  "export const manifest = " + JSON.stringify(manifest, null, 2) + ";\n" +
  "export default manifest;\n");
GEN

PKGDIR="plugins/$KEY"

# Rebuilds the repo side, applying any mutation levers passed through.
build_repo() {
  rm -rf "$REPO"
  mkdir -p "$REPO/$PKGDIR/dist"
  node "$WORK/gen.js" "$FIXTURE" "$KEY" "$REPO/$PKGDIR/dist/manifest.js" "$@" \
    || { echo "fixture generation failed: $*" >&2; return 1; }
  cat > "$REPO/$PKGDIR/package.json" <<PKGJSON
{
  "name": "paperclip-plugin-$KEY",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "paperclipPlugin": { "manifest": "./dist/manifest.js", "worker": "./dist/worker.js" }
}
PKGJSON
  git -C "$REPO" init -q
  git -C "$REPO" config user.email t@example.invalid
  git -C "$REPO" config user.name Test
  git -C "$REPO" config commit.gpgsign false
  git -C "$REPO" add -A
  git -C "$REPO" commit -qm fixture
  REF="$(git -C "$REPO" rev-parse HEAD)"
}

cp "$FIXTURE" "$ROWS"

# Runs the detector against the fixture rows and the throwaway repo.
run_tool() {
  OUT="$(PLUGINS_SOURCE_CMD="cat '$ROWS'" "$TOOL" check \
        --repo "$REPO" --ref "$REF" --plugins-dir plugins "$@" 2>&1)"
  GOT=$?
}

# expect <name> <expected-exit> [<substring the report must contain>]...
expect() {
  local name="$1" want="$2"; shift 2
  run_tool
  if [ "$GOT" -ne "$want" ]; then
    bad "$name: exit $GOT, want $want"
    printf '%s\n' "$OUT" | sed 's/^/        /' | head -14
    return
  fi
  local needle
  for needle in "$@"; do
    if ! grep -aqF -- "$needle" <<< "$OUT"; then
      bad "$name: exit $want as expected, but the report never names '$needle'"
      printf '%s\n' "$OUT" | sed 's/^/        /' | head -14
      return
    fi
  done
  ok "$name"
}

# ---------------------------------------------------------------------------
hdr "the baseline: a repo manifest generated from the deployed one compares clean"
# This is the case that gives exit 0 meaning. If it ever fails, every red case
# below is red for an unknown reason and the suite proves nothing.
build_repo || exit 2
expect "deployed == repo exits 0" 0 "OK        $KEY"

# The baseline must ALSO be reporting real work rather than skipping the plugin.
run_tool
if ! grep -aqE '1 plugin\(s\) compared' <<< "$OUT"; then
  bad "baseline: the run does not report exactly 1 plugin compared — it may be skipping the plugin entirely"
  printf '%s\n' "$OUT" | sed 's/^/        /' | head -14
else
  ok "baseline reports the plugin as actually compared, not skipped"
fi

# ---------------------------------------------------------------------------
hdr "mutation 1 — a route present in the repo and NOT deployed must go red"
# The original defect this pins: origin/main declared disclosure-preflight and
# disclose, the running host declared neither, and nothing noticed for days.
# Dropping a route from the DEPLOYED side is not possible without editing the
# fixture, so the equivalent is to ADD one to the repo side — same asymmetry,
# same finding.
build_repo || exit 2
node - "$REPO/$PKGDIR/dist/manifest.js" <<'PY'
const fs = require("fs");
const p = process.argv[2];
let s = fs.readFileSync(p, "utf8");
const marker = '  "apiRoutes": [\n';
if (!s.includes(marker)) { console.error("fixture shape changed"); process.exit(9); }
s = s.replace(marker, marker + `    {
      "routeKey": "disclosure-preflight",
      "method": "POST",
      "path": "/issues/:issueId/external-disclosures/preflight",
      "auth": "agent",
      "capability": "api.routes.register",
      "checkoutPolicy": "none",
      "companyResolution": { "from": "issue", "param": "issueId" }
    },\n`);
fs.writeFileSync(p, s);
PY
git -C "$REPO" add -A && git -C "$REPO" commit -qm "add a route to the repo side"
REF="$(git -C "$REPO" rev-parse HEAD)"
if ! grep -aq 'disclosure-preflight' "$REPO/$PKGDIR/dist/manifest.js"; then
  bad "route-added-to-repo: the fixture edit did not apply, so this case tests nothing"
else
  expect "a repo route that is not deployed is MISSING and exits 4" 4 \
    'disclosure-preflight' 'MISSING'
fi

# ---------------------------------------------------------------------------
hdr "mutation 2 — a changed route auth must go red"
# The issue names this one separately from route deletion, and rightly: the
# route set is identical here, so anything comparing route NAMES or COUNTS is
# green while a route's authorization has been rewritten.
build_repo --set-auth whoami none || exit 2
expect "a changed auth is CHANGED and exits 4" 4 'whoami' 'auth' 'CHANGED'

# The verdict must be attached to the auth FIELD, not merely present somewhere.
# Without this, dropping `auth` from ROUTE_FIELDS entirely leaves the case green
# by way of some other differing field.
run_tool
if ! grep -aA2 'route "whoami" field auth' <<< "$OUT" | grep -aq '"none"'; then
  bad "the changed auth report names both auth values"
  printf '%s\n' "$OUT" | sed 's/^/        /' | head -14
else
  ok "the changed auth report names both auth values"
fi

# ---------------------------------------------------------------------------
hdr "mutation 3 — one route swapped for another, route COUNT unchanged"
# The assertion the issue calls for by name. Renaming `mint` to `mint-v2` leaves
# the count identical on both sides. A count check is green. Only comparing
# route identity finds it, and it must find it in BOTH directions at once.
build_repo --rename mint mint-v2 || exit 2

# Prove the count really is unchanged, or this case is just mutation 1 again.
DEPN="$(PLUGINS_SOURCE_CMD="cat '$ROWS'" "$TOOL" routes 2>/dev/null \
        | awk -F'\t' -v k="$KEY" '$1==k {print $2}' | sort -u | wc -l)"
REFN="$(node -e '
  import("file://" + process.argv[1]).then((m) => {
    console.log((m.manifest ?? m.default).apiRoutes.length);
  });' "$REPO/$PKGDIR/dist/manifest.js")"
if [ "$DEPN" != "$REFN" ]; then
  bad "swapped route: counts differ ($DEPN vs $REFN) — this case is not testing count-blindness"
else
  ok "both sides declare $DEPN routes: a count check cannot see this mutation"
  expect "a swapped route is caught despite an identical count" 4 \
    'mint-v2' 'MISSING' 'mint' 'EXTRA'
fi

# ---------------------------------------------------------------------------
hdr "the false positive that would get this detector muted"
# jsonb reorders object keys, so this difference is present on every real
# comparison. If it reads as drift, the two genuinely missing routes arrive
# inside a report that is mostly noise — and a noisy detector gets ignored,
# which is indistinguishable from a deleted one.
build_repo --reorder-keys || exit 2
if cmp -s "$REPO/$PKGDIR/dist/manifest.js" /dev/null; then
  bad "key reordering: the generated manifest is empty, so this case tests nothing"
else
  expect "nested key reordering is not drift" 0 "OK        $KEY"
fi

# A comment-only difference must be invisible too — the repo side is a commented
# JS module and the deployed side is jsonb with no comments at all, so any
# text-or-hash comparison reports drift on every plugin forever.
build_repo || exit 2
printf '\n// A comment added after the fact. It grants nothing.\n' >> "$REPO/$PKGDIR/dist/manifest.js"
git -C "$REPO" add -A && git -C "$REPO" commit -qm "comment-only change"
REF="$(git -C "$REPO" rev-parse HEAD)"
expect "a comment-only change is not drift" 0 "OK        $KEY"

# ---------------------------------------------------------------------------
hdr "refusals: measuring nothing must never exit 0"
build_repo || exit 2

OUT="$(PLUGINS_SOURCE_CMD="true" "$TOOL" check --repo "$REPO" --ref "$REF" 2>&1)"; GOT=$?
[ "$GOT" -eq 2 ] && ok "an empty source refuses (exit 2)" \
  || bad "an empty source refuses (exit 2)" "exit $GOT, want 2 — zero rows must not read as zero drift"

OUT="$(PLUGINS_SOURCE_CMD="false" "$TOOL" check --repo "$REPO" --ref "$REF" 2>&1)"; GOT=$?
[ "$GOT" -eq 2 ] && ok "a failing source refuses (exit 2)" \
  || bad "a failing source refuses (exit 2)" "exit $GOT, want 2 — a source that failed measured nothing"

# THE SAME EMPTY SOURCE, THROUGH `routes`, AND NOT AS A DUPLICATE OF THE CASE
# ABOVE. `check` has a second, later guard — "compared 0 plugins" — that also
# exits 2, so the `check` case above stays green even with the empty-source
# refusal deleted outright. Measured: with `[ -s "$rows" ] || die` removed,
# `check` on an empty source still exits 2 (via the compared-0 backstop) while
# `routes` exits 0 and prints nothing at all. A refusal that only holds because
# a different guard catches it later is not a refusal, and `routes` is the
# surface where that distinction is visible.
OUT="$(PLUGINS_SOURCE_CMD="true" "$TOOL" routes 2>&1)"; GOT=$?
[ "$GOT" -eq 2 ] && ok "an empty source refuses on the routes surface too (exit 2)" \
  || bad "an empty source refuses on the routes surface too (exit 2)" "exit $GOT, want 2 — 'routes' has no compared-0 backstop, so it prints an empty surface at exit 0"

# A source that emits a row whose manifest does not parse must refuse, not skip
# it. A skipped plugin is one this tool reports nothing about while exiting 0.
printf 'broken-plugin\t/some/path\tready\t0.1.0\tnot json at all\n' > "$WORK/bad.tsv"
OUT="$(PLUGINS_SOURCE_CMD="cat '$WORK/bad.tsv'" "$TOOL" check --repo "$REPO" --ref "$REF" 2>&1)"; GOT=$?
[ "$GOT" -eq 2 ] && ok "an unparseable manifest_json refuses rather than skipping the row" \
  || bad "an unparseable manifest_json refuses rather than skipping the row" "exit $GOT, want 2 — a skipped plugin is one this tool reports nothing about while exiting 0"

# THE UNPARSEABLE ROW MIXED IN WITH GOOD ONES — the shape the real failure has,
# and the one the all-broken case above cannot pin. When EVERY row is broken,
# skipping them all leaves zero parsed plugins and a different guard ("parsed
# zero plugins out of a non-empty source") refuses anyway; measured, the
# all-broken case exits 2 even with the refusal replaced by `continue`. With one
# good plugin present the skip succeeds: 2 compared, exit 0, and the broken
# plugin is simply absent from a report that looks complete. That is an
# unmonitored plugin wearing a green tick.
cat > "$WORK/mixed.tsv" <<MIXED
$(head -3 "$FIXTURE")
broken-plugin	/some/path	ready	0.1.0	not json at all
MIXED
OUT="$(PLUGINS_SOURCE_CMD="cat '$WORK/mixed.tsv'" "$TOOL" check --repo "$REPO" --ref "$REF" 2>&1)"; GOT=$?
[ "$GOT" -eq 2 ] && ok "one unparseable row among good ones still refuses, rather than being skipped" \
  || bad "one unparseable row among good ones still refuses, rather than being skipped" "exit $GOT, want 2 — the good plugins were compared and the broken one vanished from the report"

# --only naming a plugin that is not there compares nothing. Exiting 0 would be
# a green tick over an empty comparison.
OUT="$(PLUGINS_SOURCE_CMD="cat '$ROWS'" "$TOOL" check --repo "$REPO" --ref "$REF" \
      --only no-such-plugin 2>&1)"; GOT=$?
[ "$GOT" -eq 2 ] && ok "--only with an unknown key refuses (exit 2)" \
  || bad "--only with an unknown key refuses (exit 2)" "exit $GOT, want 2 — it compared nothing"

OUT="$(PLUGINS_SOURCE_CMD="cat '$ROWS'" "$TOOL" check --repo "$WORK/not-a-repo" 2>&1)"; GOT=$?
[ "$GOT" -eq 2 ] && ok "a non-repo --repo refuses (exit 2)" \
  || bad "a non-repo --repo refuses (exit 2)" "exit $GOT, want 2 — the reference side is unreadable"

OUT="$(PLUGINS_SOURCE_CMD="cat '$ROWS'" "$TOOL" check --repo "$REPO" --ref no-such-ref 2>&1)"; GOT=$?
[ "$GOT" -eq 2 ] && ok "an unresolvable --ref refuses (exit 2)" \
  || bad "an unresolvable --ref refuses (exit 2)" "exit $GOT, want 2 — the reference side is unreadable"

OUT="$("$TOOL" frobnicate 2>&1)"; GOT=$?
[ "$GOT" -eq 2 ] && ok "an unknown subcommand refuses (exit 2)" \
  || bad "an unknown subcommand refuses (exit 2)" "exit $GOT, want 2 — an unknown subcommand must not run a check"

# ZERO ROUTES DECLARED AND A BROKEN WALKER ARE DIFFERENT THINGS (TOG-375), and
# the detector must answer them differently. Both look like an empty surface, so
# for a year the tool treated the first as the second and `die`d.
#
# That was wrong in production, not just in principle. `dispatch` is a real,
# merged, jobs-only plugin — route-less on BOTH sides — and because `die` exits
# the RUN rather than the plugin, the whole fleet sweep aborted on the first
# alphabetical row and never reached gh-token-broker, which was genuinely
# drifting. Measured 2026-09-03: `check` exited 2 having compared ONE plugin;
# with the fix, 3 compared and the drift reported.
#
# Two cases, because one signal now distinguishes them: the walker's receipt.
# The repo carries BOTH a route-less plugin and the real gh-token-broker, which
# is what makes (a) meaningful: the route-less row must be stepped over, not
# stopped at. A repo holding only the route-less plugin would exit 2 for the
# honest reason that nothing was measured, and would prove nothing about the bug.
EMPTYREPO="$WORK/emptyrepo"
mkdir -p "$EMPTYREPO/plugins/pix/dist"
cat > "$EMPTYREPO/plugins/pix/dist/manifest.js" <<'EMPTYJS'
export const manifest = { id: "agent-pixels.camera", apiVersion: "1", apiRoutes: [] };
export default manifest;
EMPTYJS
mkdir -p "$EMPTYREPO/plugins/$KEY/dist"
cp "$REPO/$PKGDIR/dist/manifest.js" "$EMPTYREPO/plugins/$KEY/dist/manifest.js"
cp "$REPO/$PKGDIR/package.json"     "$EMPTYREPO/plugins/$KEY/package.json"
git -C "$EMPTYREPO" init -q
git -C "$EMPTYREPO" config user.email t@example.invalid
git -C "$EMPTYREPO" config user.name Test
git -C "$EMPTYREPO" config commit.gpgsign false
git -C "$EMPTYREPO" add -A && git -C "$EMPTYREPO" commit -qm "route-less plugin beside a real one"
EMPTYREF="$(git -C "$EMPTYREPO" rev-parse HEAD)"

# (a) A genuinely route-less plugin is SKIPPED, named, and the sweep carries on
#     past it to the plugins that do declare routes. `agent-pixels.camera` sorts
#     FIRST in the deployed index, so gh-token-broker being compared at all is
#     itself the proof that the sweep did not stop at the route-less row.
#     Asserting only "not exit 2" would pass on a tool that silently dropped
#     every remaining plugin.
OUT="$(PLUGINS_SOURCE_CMD="cat '$ROWS'" "$TOOL" check --repo "$EMPTYREPO" --ref "$EMPTYREF" \
      --plugins-dir plugins 2>&1)"; GOT=$?
if [ "$GOT" -eq 2 ]; then
  bad "a route-less plugin on both sides is skipped, and the sweep continues past it" \
      "exit 2 — the route-less row aborted the whole sweep, which is the TOG-375 defect"
elif ! grep -aq 'NO ROUTES' <<< "$OUT"; then
  bad "a route-less plugin on both sides is skipped, and the sweep continues past it" \
      "exit $GOT but no 'NO ROUTES' line — a skipped plugin that is not NAMED is one nobody knows is unmonitored"
elif ! grep -aqE '1 declaring no routes' <<< "$OUT"; then
  bad "a route-less plugin on both sides is skipped, and the sweep continues past it" \
      "exit $GOT but the route-less count is missing from the summary denominator"
elif ! grep -aqE "^  [0-9]+ plugin\(s\) compared" <<< "$OUT" \
  || [ "$(grep -aoE '^  [0-9]+ plugin\(s\) compared' <<< "$OUT" | grep -aoE '[0-9]+')" -lt 1 ]; then
  bad "a route-less plugin on both sides is skipped, and the sweep continues past it" \
      "exit $GOT but 0 plugins were compared — the sweep stopped at the route-less row"
elif ! grep -aq "$KEY" <<< "$OUT"; then
  # THE ASSERTION THAT CARRIES THE BUG. agent-pixels.camera sorts first; if the
  # route-less row still aborted the run, gh-token-broker is simply absent from
  # the report and every count above can still look plausible.
  bad "a route-less plugin on both sides is skipped, and the sweep continues past it" \
      "exit $GOT but $KEY never appears — the sweep never reached the plugin after the route-less one"
else
  ok "a route-less plugin on both sides is skipped, and the sweep continues past it"
fi

# (b) A surface that does not carry the walker's receipt is REFUSED, never read
#     as "zero routes". Without this the route-less skip in (a) is a loaded gun:
#     anything that makes a surface unreadable silently becomes "nothing to
#     compare", and the detector reports a clean no-op over a plugin it failed
#     to measure.
#
#     Exercised with a repo manifest that writes to stdout at import — a real
#     hazard, since these manifests are JS modules the walker `import`s, and one
#     stray console.log displaces the receipt and shifts every route leaf by a
#     line. Note this case is NOT reachable by breaking the walker for every
#     plugin at once: that degrades to zero comparisons and the compared-zero
#     backstop catches it for its own reasons. The receipt guard earns its place
#     on exactly this partial failure, where other plugins measure fine.
NOISYREPO="$WORK/noisyrepo"
mkdir -p "$NOISYREPO/plugins/$KEY/dist"
{ echo 'console.log("plugin build banner");'; cat "$REPO/$PKGDIR/dist/manifest.js"; } \
  > "$NOISYREPO/plugins/$KEY/dist/manifest.js"
cp "$REPO/$PKGDIR/package.json" "$NOISYREPO/plugins/$KEY/package.json"
git -C "$NOISYREPO" init -q
git -C "$NOISYREPO" config user.email t@example.invalid
git -C "$NOISYREPO" config user.name Test
git -C "$NOISYREPO" config commit.gpgsign false
git -C "$NOISYREPO" add -A && git -C "$NOISYREPO" commit -qm "manifest that prints at import"
NOISYREF="$(git -C "$NOISYREPO" rev-parse HEAD)"
OUT="$(PLUGINS_SOURCE_CMD="cat '$ROWS'" "$TOOL" check --repo "$NOISYREPO" --ref "$NOISYREF" \
      --plugins-dir plugins 2>&1)"; GOT=$?
[ "$GOT" -eq 2 ] && ok "a plugin whose walker returns no measurement refuses rather than reporting OK" \
  || bad "a plugin whose walker returns no measurement refuses rather than reporting OK" "exit $GOT, want 2 — an unreadable surface must never be read as 'declares no routes'"

# ---------------------------------------------------------------------------
hdr "enumeration: plugins with no repo counterpart are counted, not compared"
# Four of the six real rows are registry installs with no source in this repo.
# They must be reported as uncompared rather than silently vanishing — a plugin
# that disappears from the denominator is one nobody knows is unmonitored.
build_repo || exit 2
run_tool
if grep -aqE '[0-9]+ with no repo counterpart' <<< "$OUT"; then
  UNPAIRED="$(grep -aoE '[0-9]+ with no repo counterpart' <<< "$OUT" | grep -aoE '^[0-9]+')"
  WANT=$((FIXROWS - 1))
  if [ "$UNPAIRED" -eq "$WANT" ]; then
    ok "every plugin without a repo counterpart is in the denominator"
  else
    bad "every plugin without a repo counterpart is in the denominator" \
        "reported $UNPAIRED uncompared, want $WANT — rows are being dropped silently"
  fi
else
  bad "every plugin without a repo counterpart is in the denominator" \
      "the report never states how many plugins had no repo counterpart"
fi

# ---------------------------------------------------------------------------
printf '\n\033[1m%s\033[0m\n' "plugin_deploy_drift.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
