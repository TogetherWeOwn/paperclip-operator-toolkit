#!/usr/bin/env bash
# ===========================================================================
# Offline regression suite for upstream_filing_readiness.sh — the four-gate
# filing readiness gate (TOG-721).
#
# WHY THIS RUNS ANYWHERE. Every one of the four gates reads through a seam, so
# all four sides are fabricable: the registry and the plugin manifest come out
# of a throwaway git repo in mktemp, the deployed rows come from a FILE instead
# of a database, the host actor object is a small JS file, and the repository
# ceiling is an environment variable. No database, no plugin host, no network,
# no credential, and nothing it writes leaves the temp directory.
#
# THE BASELINE IS THE ALL-OPEN WORLD, WHICH DOES NOT EXIST YET. This is the
# opposite of the usual arrangement here and it is deliberate. On this host all
# four gates are CLOSED, so a suite built from live inputs would assert the
# tool prints red — and would still pass if the tool were `exit 4`. So the
# fixture is the FUTURE world in which all four gates have been opened, the
# baseline asserts exit 0 against it, and every case below is one named
# mutation back toward today's reality. That way each gate's detection is
# pinned by the transition it must catch, and exit 0 is a claim the tool can
# actually distinguish rather than a constant it happens to return.
#
# THE MUTATIONS THIS SUITE EXISTS FOR. A negative grep is not an assertion, so
# each of the four gates is mutated toward the WORSE case and confirmed red:
#
#   - the authorizer registry emptied              -> authorizer-registry closed
#   - the two disclosure routes dropped from the
#     DEPLOYED manifest, repo side untouched       -> route-deployed closed
#   - actorSource removed from the host's actor    -> actor-source closed
#   - destination outside GH_APP_REPOS             -> destination-scope closed
#
# AND THE ONES THAT MATTER MORE — the false greens each probe is built against:
#
#   - a registry key with a keyId but NO publicKey. The array is non-empty, so
#     a length check scores this gate open on a placeholder that would trust
#     nothing.
#   - `actorSource` present in the host file but only on an UNRELATED route.
#     A grep for the word scores this gate open while the actor the worker
#     actually receives still lacks it. Not because the real /app route file
#     contains the word today — measured 2026-08-30, it contains it zero times —
#     but because the host DOES compute it one call away (authz.js:176, reached
#     from plugins.js:1437) and six other files under /app/server/dist already
#     name it. The word arriving on some other line of a 2000-line file is one
#     ordinary edit away; the dispatched actor gaining a key is the actual fix.
#   - a route SWAPPED for another, count unchanged. A count check passes here.
#
# AND THE REFUSALS. A gate that cannot read its input must exit 2, never 0 and
# never 4. Exit 0 is a positive claim that all four gates were measured and all
# four are open; "I measured nothing" reaching that code is the silent-green
# failure the whole file exists to prevent. Scoring a missing input as "closed"
# would be wrong in the other direction — it would report the queue blocked for
# a reason that was never measured.
#
# Assertions are on exit status and machine-readable gate/state names from the
# `gates` subcommand only. No assertion matches human-readable prose.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${UPSTREAM_FILING_READINESS_SH:-$HERE/upstream_filing_readiness.sh}"

PASS=0; FAIL=0
ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; [ $# -gt 1 ] && printf '        %s\n' "$2"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

[ -x "$TOOL" ] || { echo "no executable upstream_filing_readiness.sh at $TOOL" >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 2; }
command -v git  >/dev/null 2>&1 || { echo "git is required" >&2; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

REPO="$WORK/repo"
KEY="gh-token-broker"
DEST="paperclipai/paperclip"

# --- the all-open fixture world ---------------------------------------------

# A real Ed25519 SPKI PEM. Public half only — there is no private key anywhere in
# this suite and nothing here can sign.
PEM_1='-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=\n-----END PUBLIC KEY-----\n'
PEM_2='-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAv2i1oJ0nsHNCoBNMXCWJhMSVSCJ2ozgVAvWQKX2FbEg=\n-----END PUBLIC KEY-----\n'

# A registry with one usable key, in the shape the CONSUMER enforces
# (external_disclosure.js:readTrustStore -> exactKeys keyId, algorithm,
# authorizingPrincipal, publicKeyPem). Anything else the consumer refuses, so
# anything else this gate must score closed.
REG_FULL="{\"version\":1,\"keys\":[{\"keyId\":\"owner-key-1\",\"algorithm\":\"ed25519\",\"authorizingPrincipal\":{\"principalClass\":\"agent\",\"principalId\":\"ciso\"},\"publicKeyPem\":\"$PEM_1\"}]}"
# Non-empty array, unusable entry. The false green for a length check.
REG_PLACEHOLDER='{"version":1,"keys":[{"keyId":"owner-key-1"}]}'
REG_EMPTY='{"version":1,"keys":[]}'
# TOG-762 regressions. Each of these was scored WRONG by the pre-fix probe.
#   the old field name: complete but for `publicKey` where the consumer reads
#   `publicKeyPem`. The consumer dies on exactKeys; the old probe scored it OPEN.
REG_WRONG_FIELD='{"version":1,"keys":[{"keyId":"owner-key-1","publicKey":"MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE="}]}'
#   a well-formed-looking PEM field holding something that is not a key at all.
REG_BAD_PEM="{\"version\":1,\"keys\":[{\"keyId\":\"owner-key-1\",\"algorithm\":\"ed25519\",\"authorizingPrincipal\":{\"principalClass\":\"agent\",\"principalId\":\"ciso\"},\"publicKeyPem\":\"not-a-pem\"}]}"
#   an RSA key where the consumer demands ed25519.
REG_WRONG_ALG="{\"version\":1,\"keys\":[{\"keyId\":\"owner-key-1\",\"algorithm\":\"rsa\",\"authorizingPrincipal\":{\"principalClass\":\"agent\",\"principalId\":\"ciso\"},\"publicKeyPem\":\"$PEM_1\"}]}"
#   two entries sharing a keyId: the consumer dies, so the registry trusts NOTHING.
REG_DUP="{\"version\":1,\"keys\":[{\"keyId\":\"dup\",\"algorithm\":\"ed25519\",\"authorizingPrincipal\":{\"principalClass\":\"agent\",\"principalId\":\"ciso\"},\"publicKeyPem\":\"$PEM_1\"},{\"keyId\":\"dup\",\"algorithm\":\"ed25519\",\"authorizingPrincipal\":{\"principalClass\":\"agent\",\"principalId\":\"cos\"},\"publicKeyPem\":\"$PEM_2\"}]}"
#   the two-key registry TOG-762 was asked to land. Two DISTINCT principals.
REG_TWO_KEY="{\"version\":1,\"keys\":[{\"keyId\":\"ciso-1\",\"algorithm\":\"ed25519\",\"authorizingPrincipal\":{\"principalClass\":\"agent\",\"principalId\":\"ciso\"},\"publicKeyPem\":\"$PEM_1\"},{\"keyId\":\"cos-1\",\"algorithm\":\"ed25519\",\"authorizingPrincipal\":{\"principalClass\":\"agent\",\"principalId\":\"cos\"},\"publicKeyPem\":\"$PEM_2\"}]}"

# Build the throwaway repo holding the registry at a committed ref.
build_repo() {
  local registry="$1"
  rm -rf "$REPO"; mkdir -p "$REPO"
  git -C "$REPO" init -q
  git -C "$REPO" config user.email t@t.t
  git -C "$REPO" config user.name t
  printf '%s\n' "$registry" > "$REPO/external_disclosure_authorizers.json"
  git -C "$REPO" add -A
  git -C "$REPO" commit -qm fixture
}

# Deployed rows as TSV. Route keys are whatever is passed in, so a route can be
# dropped, added or swapped without touching anything else.
#
# The blank package_path on the second row is load-bearing: tab is an IFS
# whitespace character, so a naive `IFS=$'\t' read` collapses the double tab and
# every later column shifts left. Without a row like this the suite is green on
# a tool with that bug still in it.
write_rows() {
  local out="$1"; shift
  local routes="" r
  for r in "$@"; do
    [ -n "$routes" ] && routes="$routes,"
    routes="$routes{\"routeKey\":\"$r\",\"method\":\"POST\",\"path\":\"/x/$r\",\"auth\":\"agent\"}"
  done
  {
    printf '%s\t%s\tready\t0.1.0\t{"id":"%s","apiRoutes":[%s]}\n' \
      "$KEY" "/opt/paperclip-plugin-packages/$KEY" "$KEY" "$routes"
    printf 'other.plugin\t\tready\t0.1.0\t{"id":"other.plugin","apiRoutes":[]}\n'
  } > "$out"
}

# The host file that builds the actor passed to a plugin worker. `--with-source`
# puts actorSource inside the dispatched actor; `--decoy` puts the word in the
# file but on an UNRELATED route, which is the case a grep gets wrong;
# `--nested` puts it inside a NESTED object within the actor, which is the case
# a flat key scan gets wrong — it is a key of `meta`, not a key of the actor,
# so the worker still receives an actor without it.
write_server() {
  local out="$1" mode="$2"
  local src_line="" decoy=""
  [ "$mode" = "with-source" ] && src_line='                    actorSource: actor.actorSource,'
  # The leading `verified: true,` is load-bearing. Without a comma ahead of it
  # the nested key accumulates as "{ actorSource", which the extractor's
  # identifier regex rejects for the brace — so a flat scan would reject it for
  # the WRONG reason and the depth guard would be untested. After a comma the
  # token is a clean identifier, and only the depth guard keeps it out.
  [ "$mode" = "nested" ] && src_line='                    meta: { verified: true, actorSource: actor.actorSource },'
  # TOG-727. A propagated actorSource will realistically land WITH a comment
  # explaining why, and the comment sits between `runId:` and `actorSource:`.
  # The key-walk resets its token on `,` and demands a bare identifier, so
  # comment prose (which contains commas and does not end at one) poisoned the
  # following key and the gate reported CLOSED against a host that propagates.
  # That is a fail-to-flip at exactly the moment the gate exists to flip, so it
  # gets its own case rather than riding on `with-source`.
  [ "$mode" = "with-source-commented" ] && src_line='                    // Host-derived, from the verified credential. Without this a
                    // plugin cannot tell a JWT caller from a key caller, so any
                    // check on the authentication class is unreachable.
                    actorSource: actor.actorSource,'
  # Same trap in block-comment form, and the comment contains a `"` so a
  # quote-aware stripper that mishandles it would desync on the rest of the body.
  [ "$mode" = "with-source-block-comment" ] && src_line='                    /* host-derived; the "agent_jwt" vs agent_key distinction */
                    actorSource: actor.actorSource,'
  [ "$mode" = "decoy" ] && decoy='
router.get("/unrelated", async (req, res) => {
    const actor = getActorInfo(req);
    res.json({ actorSource: actor.actorSource });
});'
  cat > "$out" <<EOF
// fabricated host route file
${decoy}
router.all("/plugins/:pluginId/api/*", async (req, res) => {
    const actor = getActorInfo(req);
    const input = {
        routeKey: match.route.routeKey,
        actor: {
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            userId: actor.actorType === "user" ? actor.actorId : null,
            runId: actor.runId,
${src_line}
        },
        companyId,
    };
    const result = await bridgeDeps.workerManager.call(plugin.id, "handleApiRequest", input);
});
EOF
}

# Run the tool against a fabricated world. Every seam is passed explicitly so a
# case can never accidentally read this host.
#
# `bash -c` because the harness shell does not report a pipeline's real exit
# status, and a case that silently read 0 would pass while proving nothing.
run_gates() {
  local rows="$1" server="$2" repos="$3" dest="$4"
  OUT="$(PLUGINS_SOURCE_CMD="cat $rows" GH_APP_REPOS="$repos" \
    bash -c "'$TOOL' gates --repo '$REPO' --ref HEAD --destination '$dest' --server-routes '$server'" 2>"$WORK/err")"
  RC=$?
  return 0
}

# Assert a named gate reported a given state in the `gates` output.
gate_is() {
  local gate="$1" want="$2"
  printf '%s\n' "$OUT" | awk -F'\t' -v g="$gate" -v w="$want" '$1==g && $2==w {found=1} END {exit !found}'
}

ROWS="$WORK/rows.tsv"
SERVER="$WORK/server.js"

# ===========================================================================
hdr "baseline: all four gates open"
# The control. If this does not go green, every red case below proves nothing —
# a tool that always exits 4 would "pass" all of them.
build_repo "$REG_FULL"
write_rows "$ROWS" disclosure-preflight disclose whoami mint
write_server "$SERVER" with-source
run_gates "$ROWS" "$SERVER" "paperclip-ops-tooling,paperclip" "$DEST"

if [ "$RC" -ne 0 ]; then
  bad "the all-open world exits 0" "got rc=$RC; output: $OUT $(cat "$WORK/err")"
else
  ok "the all-open world exits 0"
fi
for g in authorizer-registry route-deployed actor-source destination-scope; do
  if gate_is "$g" open; then ok "baseline: $g is open"; else bad "baseline: $g is open" "$OUT"; fi
done

# ===========================================================================
hdr "mutation: each gate closed independently"

# --- A: the registry emptied ------------------------------------------------
build_repo "$REG_EMPTY"
write_rows "$ROWS" disclosure-preflight disclose whoami mint
write_server "$SERVER" with-source
run_gates "$ROWS" "$SERVER" "paperclip-ops-tooling,paperclip" "$DEST"
if [ "$RC" -eq 4 ] && gate_is authorizer-registry closed; then
  ok "an empty authorizer registry closes authorizer-registry, exit 4"
else
  bad "an empty authorizer registry closes authorizer-registry, exit 4" "rc=$RC; $OUT"
fi

# --- A': a placeholder key with no publicKey --------------------------------
# THE FALSE GREEN. keys[] is non-empty, so `keys.length > 0` scores this open.
# It would trust nothing at verification time.
build_repo "$REG_PLACEHOLDER"
run_gates "$ROWS" "$SERVER" "paperclip-ops-tooling,paperclip" "$DEST"
if [ "$RC" -eq 4 ] && gate_is authorizer-registry closed; then
  ok "a key entry with no public key does not count as a usable authorizer"
else
  bad "a key entry with no public key does not count as a usable authorizer" "rc=$RC; $OUT"
fi

# --- A'': TOG-762 — the gate must read the CONSUMER's field name ------------
# The probe once required `publicKey`; the consumer requires `publicKeyPem` and
# dies on exactKeys otherwise. That is a FALSE OPEN: the gate would report the
# registry as trusted while every real grant is refused.
build_repo "$REG_WRONG_FIELD"
run_gates "$ROWS" "$SERVER" "paperclip-ops-tooling,paperclip" "$DEST"
if [ "$RC" -eq 4 ] && gate_is authorizer-registry closed; then
  ok "a key using publicKey (not publicKeyPem) is not scored as trusted"
else
  bad "a key using publicKey (not publicKeyPem) is not scored as trusted" "rc=$RC; $OUT"
fi

# A PEM field that is not a key. Length is non-zero, so a typeof/length check
# passes it; the consumer's createPublicKey throws.
build_repo "$REG_BAD_PEM"
run_gates "$ROWS" "$SERVER" "paperclip-ops-tooling,paperclip" "$DEST"
if [ "$RC" -eq 4 ] && gate_is authorizer-registry closed; then
  ok "a publicKeyPem that does not parse is not scored as trusted"
else
  bad "a publicKeyPem that does not parse is not scored as trusted" "rc=$RC; $OUT"
fi

# Right shape, wrong algorithm. The consumer requires ed25519 explicitly.
build_repo "$REG_WRONG_ALG"
run_gates "$ROWS" "$SERVER" "paperclip-ops-tooling,paperclip" "$DEST"
if [ "$RC" -eq 4 ] && gate_is authorizer-registry closed; then
  ok "a non-ed25519 algorithm is not scored as trusted"
else
  bad "a non-ed25519 algorithm is not scored as trusted" "rc=$RC; $OUT"
fi

# A duplicate keyId makes the consumer die, so the registry trusts NOTHING —
# not "one of the two". Counting survivors would score this open.
build_repo "$REG_DUP"
run_gates "$ROWS" "$SERVER" "paperclip-ops-tooling,paperclip" "$DEST"
if [ "$RC" -eq 4 ] && gate_is authorizer-registry closed; then
  ok "a duplicate keyId makes the whole registry untrusted"
else
  bad "a duplicate keyId makes the whole registry untrusted" "rc=$RC; $OUT"
fi

# THE POSITIVE CONTROL FOR THIS FIX. Without it every case above is satisfiable
# by a probe that always reports closed — which is exactly the false CLOSED the
# fix removes. A real two-key registry must flip the gate OPEN and count 2.
build_repo "$REG_TWO_KEY"
run_gates "$ROWS" "$SERVER" "paperclip-ops-tooling,paperclip" "$DEST"
if [ "$RC" -eq 0 ] && gate_is authorizer-registry open; then
  ok "a real-shape two-key registry opens authorizer-registry"
else
  bad "a real-shape two-key registry opens authorizer-registry" "rc=$RC; $OUT"
fi
case "$OUT" in
  *"2 usable authorizer key(s)"*) ok "the two-key registry is counted as 2 usable keys" ;;
  *) bad "the two-key registry is counted as 2 usable keys" "$OUT" ;;
esac

# --- B: the disclosure routes not deployed ----------------------------------
# The repo side is untouched; only the DEPLOYED manifest loses them. This is the
# real TOG-576 defect: merged and green, never deployed.
build_repo "$REG_FULL"
write_rows "$ROWS" whoami mint
run_gates "$ROWS" "$SERVER" "paperclip-ops-tooling,paperclip" "$DEST"
if [ "$RC" -eq 4 ] && gate_is route-deployed closed; then
  ok "disclosure routes absent from the deployed manifest close route-deployed, exit 4"
else
  bad "disclosure routes absent from the deployed manifest close route-deployed, exit 4" "rc=$RC; $OUT"
fi

# --- B': one route swapped for another, count unchanged ---------------------
# Four routes before, four after. A count check passes. Only route IDENTITY
# catches it.
write_rows "$ROWS" disclosure-preflight something-else whoami mint
run_gates "$ROWS" "$SERVER" "paperclip-ops-tooling,paperclip" "$DEST"
if [ "$RC" -eq 4 ] && gate_is route-deployed closed; then
  ok "a route swapped for another at unchanged count still closes route-deployed"
else
  bad "a route swapped for another at unchanged count still closes route-deployed" "rc=$RC; $OUT"
fi

# --- C: actorSource absent from the dispatched actor ------------------------
write_rows "$ROWS" disclosure-preflight disclose whoami mint
write_server "$SERVER" without-source
run_gates "$ROWS" "$SERVER" "paperclip-ops-tooling,paperclip" "$DEST"
if [ "$RC" -eq 4 ] && gate_is actor-source closed; then
  ok "an actor built without actorSource closes actor-source, exit 4"
else
  bad "an actor built without actorSource closes actor-source, exit 4" "rc=$RC; $OUT"
fi

# --- C': actorSource present, but on an unrelated route ---------------------
# THE FALSE GREEN this probe is built against. The word is in the file; the
# actor the worker receives still lacks it. A grep scores this open. The host
# computes actorSource one call away (authz.js:176, reached from the same
# getActorInfo the plugin route already calls), so a line naming it landing
# somewhere else in that file is an ordinary edit, not a hypothetical.
write_server "$SERVER" decoy
run_gates "$ROWS" "$SERVER" "paperclip-ops-tooling,paperclip" "$DEST"
if [ "$RC" -eq 4 ] && gate_is actor-source closed; then
  ok "actorSource on an unrelated route does not open actor-source"
else
  bad "actorSource on an unrelated route does not open actor-source" "rc=$RC; $OUT"
fi

# --- C'': actorSource present inside the actor, but NESTED -------------------
# A flat scan of every `actorSource:` between the actor's braces scores this
# open. It is a key of the nested `meta` object, so the actor the worker
# destructures still has no actorSource of its own and the agent_jwt check
# still reads undefined.
write_server "$SERVER" nested
run_gates "$ROWS" "$SERVER" "paperclip-ops-tooling,paperclip" "$DEST"
if [ "$RC" -eq 4 ] && gate_is actor-source closed; then
  ok "actorSource nested inside another object does not open actor-source"
else
  bad "actorSource nested inside another object does not open actor-source" "rc=$RC; $OUT"
fi

# --- C''': actorSource propagated, with an explanatory comment on the line ---
# TOG-727 measured this against the real candidate patch: the gate reported
# CLOSED against a host that genuinely propagates, purely because a `//`
# comment preceded the key. A gate that cannot flip when the defect is fixed
# reports "still broken" forever, which is the most expensive false negative
# this file can produce — it is the evidence under a reserved decision.
for cmode in with-source-commented with-source-block-comment; do
  write_server "$SERVER" "$cmode"
  run_gates "$ROWS" "$SERVER" "paperclip-ops-tooling,paperclip" "$DEST"
  if gate_is actor-source open; then
    ok "actorSource still detected when the line carries a comment ($cmode)"
  else
    bad "actorSource still detected when the line carries a comment ($cmode)" "rc=$RC; $OUT"
  fi
done

# --- D: destination outside the ceiling -------------------------------------
write_server "$SERVER" with-source
run_gates "$ROWS" "$SERVER" "paperclip-ops-tooling" "$DEST"
if [ "$RC" -eq 4 ] && gate_is destination-scope closed; then
  ok "a destination outside GH_APP_REPOS closes destination-scope, exit 4"
else
  bad "a destination outside GH_APP_REPOS closes destination-scope, exit 4" "rc=$RC; $OUT"
fi

# --- D': a repo whose NAME matches but under another owner ------------------
# The ceiling lists bare names, so owner is not distinguishable from it. This
# pins the documented behaviour rather than leaving it to be rediscovered.
run_gates "$ROWS" "$SERVER" "paperclip-ops-tooling" "someone-else/paperclip-ops-tooling"
if [ "$RC" -eq 0 ] && gate_is destination-scope open; then
  ok "the ceiling is matched on bare repository name, owner not compared"
else
  bad "the ceiling is matched on bare repository name, owner not compared" "rc=$RC; $OUT"
fi

# ===========================================================================
hdr "refusals: a gate that measured nothing must exit 2"

build_repo "$REG_FULL"
write_rows "$ROWS" disclosure-preflight disclose whoami mint
write_server "$SERVER" with-source

# The plugins source fails outright.
OUT="$(PLUGINS_SOURCE_CMD="false" GH_APP_REPOS="paperclip-ops-tooling,paperclip" \
  bash -c "'$TOOL' gates --repo '$REPO' --ref HEAD --destination '$DEST' --server-routes '$SERVER'" 2>/dev/null)"; RC=$?
if [ "$RC" -eq 2 ]; then ok "a failing plugins source refuses (exit 2)"; else bad "a failing plugins source refuses (exit 2)" "rc=$RC"; fi

# The plugins source succeeds but returns nothing. Zero rows is not "no drift".
OUT="$(PLUGINS_SOURCE_CMD="true" GH_APP_REPOS="paperclip-ops-tooling,paperclip" \
  bash -c "'$TOOL' gates --repo '$REPO' --ref HEAD --destination '$DEST' --server-routes '$SERVER'" 2>/dev/null)"; RC=$?
if [ "$RC" -eq 2 ]; then ok "an empty plugins source refuses (exit 2)"; else bad "an empty plugins source refuses (exit 2)" "rc=$RC"; fi

# The broker is not installed at all. Distinct from "installed without routes".
printf 'other.plugin\t\tready\t0.1.0\t{"id":"other.plugin","apiRoutes":[]}\n' > "$WORK/norows.tsv"
run_gates "$WORK/norows.tsv" "$SERVER" "paperclip-ops-tooling,paperclip" "$DEST"
if [ "$RC" -eq 2 ]; then
  ok "a missing broker row refuses rather than reporting a closed route gate"
else
  bad "a missing broker row refuses rather than reporting a closed route gate" "rc=$RC; $OUT"
fi

# A deployed manifest that does not parse.
printf '%s\t%s\tready\t0.1.0\t{"id":"%s","apiRoutes":[\n' "$KEY" "/opt/x" "$KEY" > "$WORK/bad.tsv"
run_gates "$WORK/bad.tsv" "$SERVER" "paperclip-ops-tooling,paperclip" "$DEST"
if [ "$RC" -eq 2 ]; then ok "an unparseable deployed manifest refuses (exit 2)"; else bad "an unparseable deployed manifest refuses (exit 2)" "rc=$RC; $OUT"; fi

# The host route file is absent.
run_gates "$ROWS" "$WORK/nope.js" "paperclip-ops-tooling,paperclip" "$DEST"
if [ "$RC" -eq 2 ]; then ok "a missing host route file refuses (exit 2)"; else bad "a missing host route file refuses (exit 2)" "rc=$RC; $OUT"; fi

# The host route file exists but has no dispatch call to anchor on. Refusing
# beats guessing: scoring this "closed" would report a blocker never measured.
printf '// nothing to anchor on\n' > "$WORK/empty.js"
run_gates "$ROWS" "$WORK/empty.js" "paperclip-ops-tooling,paperclip" "$DEST"
if [ "$RC" -eq 2 ]; then ok "a host file with no dispatch call refuses (exit 2)"; else bad "a host file with no dispatch call refuses (exit 2)" "rc=$RC; $OUT"; fi

# The repository ceiling is unset. Unreadable is not "in scope".
OUT="$(PLUGINS_SOURCE_CMD="cat $ROWS" GH_APP_REPOS="" \
  bash -c "'$TOOL' gates --repo '$REPO' --ref HEAD --destination '$DEST' --server-routes '$SERVER'" 2>/dev/null)"; RC=$?
if [ "$RC" -eq 2 ]; then ok "an unset GH_APP_REPOS refuses rather than assuming scope"; else bad "an unset GH_APP_REPOS refuses rather than assuming scope" "rc=$RC"; fi

# The registry is missing from the ref entirely.
rm -rf "$REPO"; mkdir -p "$REPO"
git -C "$REPO" init -q; git -C "$REPO" config user.email t@t.t; git -C "$REPO" config user.name t
printf 'x\n' > "$REPO/unrelated.txt"; git -C "$REPO" add -A; git -C "$REPO" commit -qm empty
run_gates "$ROWS" "$SERVER" "paperclip-ops-tooling,paperclip" "$DEST"
if [ "$RC" -eq 2 ]; then ok "a ref with no authorizer registry refuses (exit 2)"; else bad "a ref with no authorizer registry refuses (exit 2)" "rc=$RC; $OUT"; fi

# A registry that is valid JSON but the wrong shape.
build_repo '{"version":1}'
run_gates "$ROWS" "$SERVER" "paperclip-ops-tooling,paperclip" "$DEST"
if [ "$RC" -eq 2 ]; then ok "a registry with no keys[] refuses rather than scoring it closed"; else bad "a registry with no keys[] refuses rather than scoring it closed" "rc=$RC; $OUT"; fi

hdr "dispatch: a run that measured nothing must never exit 0"

# EXIT_OK is a positive claim that all four gates were measured and are open.
# Reaching it without running a single probe is the one failure this whole tool
# exists to prevent, so the no-verb path is asserted directly.
OUT="$(bash "$TOOL" 2>&1)"; RC=$?
if [ "$RC" -eq 2 ]; then ok "no subcommand refuses (exit 2) rather than reading as all-gates-open"; else bad "no subcommand refuses (exit 2) rather than reading as all-gates-open" "rc=$RC"; fi
if [ "$RC" -ne 0 ]; then ok "no subcommand never returns EXIT_OK"; else bad "no subcommand never returns EXIT_OK" "rc=0 — a usage screen read as a green light"; fi

# An explicit help request is a different intent and stays exit 0, so the fix
# above is scoped to the empty-argument case and did not just blanket-refuse.
OUT="$(bash "$TOOL" --help 2>&1)"; RC=$?
if [ "$RC" -eq 0 ]; then ok "an explicit --help still exits 0"; else bad "an explicit --help still exits 0" "rc=$RC"; fi

# A mistyped verb must refuse too, not fall through to a measurement.
OUT="$(bash "$TOOL" chek 2>&1)"; RC=$?
if [ "$RC" -eq 2 ]; then ok "an unknown command refuses (exit 2)"; else bad "an unknown command refuses (exit 2)" "rc=$RC"; fi

# ===========================================================================
printf '\n\033[1m%s\033[0m\n' "summary"
printf '  %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
