#!/usr/bin/env bash
# ===========================================================================
# upstream_filing_readiness.sh — could we actually FILE an upstream report
# today, if someone said yes?
#
# WHY THIS EXISTS (TOG-721). Seven upstream defect reports sit in
# `docs/upstream/` waiting on a decision that was framed, for weeks, as one
# gate: the external-disclosure authorizer registry is empty, so provision a
# key and the queue clears. That framing was measured and is WRONG. Filing is
# blocked by FOUR independent gates, and the registry is only the first:
#
#   A  authorizer registry   external_disclosure_authorizers.json = {keys:[]}
#   B  route deployed        the deployed gh-token-broker manifest serves
#                            whoami + mint. `disclose` and
#                            `disclosure-preflight` were merged by TOG-576 and
#                            NEVER DEPLOYED.
#   C  actorSource           the host builds the plugin route actor WITHOUT
#                            `actorSource`; the worker refuses anything that is
#                            not `agent_jwt`. Every call 403s.
#   D  destination in scope  GH_APP_REPOS projects exactly one repository, and
#                            it is not where these reports go.
#
# So provisioning a key opens ONE of four gates on a code path that does not
# run. It would file NOTHING, and it would do so after a reserved decision was
# spent. That is precisely the shape TOG-574 already paid for once: authority
# granted against an artifact nobody had measured.
#
# WHY IT IS A SCRIPT AND NOT A PARAGRAPH. The four facts above are true on
# 2026-08-30. Three of them are one deploy, one host upgrade, or one env change
# away from silently becoming false — and a decision brief that says "four
# gates" will still say "four gates" long after two of them have opened. Prose
# does not re-measure itself. Anything with a number in it belongs in a script,
# so the same input gives the same output forever.
#
# THE FAILURE MODE IT IS BUILT AGAINST. Not "reports a gate that is open" — the
# expensive one is the reverse: exiting 0 because it measured nothing. Every
# probe below either measures its gate or REFUSES (exit 2). A gate whose input
# is missing is never scored as open. Exit 0 from this tool is a positive claim
# that all four were measured and all four are clear.
#
# WHAT IT DELIBERATELY DOES NOT DO. It files nothing, mints nothing, signs
# nothing and needs no credential. Every probe is a read. It does not decide
# whether the reports SHOULD be sent — that is owner-reserved and stays that
# way. It answers only the prior question the decision depends on: if the
# answer were yes, would anything happen?
# ===========================================================================
set -uo pipefail

ME="$(basename "${BASH_SOURCE[0]}")"
SELFDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Exit codes are the interface; callers gate on these, never on printed text.
#   0  all four gates measured and OPEN — filing could execute
#   2  refused — a probe could not measure its gate. NEVER conflated with 0.
#   4  at least one gate is CLOSED — filing would execute nothing
EXIT_OK=0; EXIT_REFUSED=2; EXIT_BLOCKED=4

# --- seams ------------------------------------------------------------------
# Each gate reads through a seam so the regression suite can fabricate every
# side of it with no database, no plugin host, no network and no credential.
REPO_DIR="${UPSTREAM_READINESS_REPO:-$SELFDIR}"
REF="${UPSTREAM_READINESS_REF:-origin/main}"
# Deployed plugin rows as TSV: key \t packagePath \t status \t version \t manifestJson
PLUGINS_SOURCE_CMD="${PLUGINS_SOURCE_CMD:-}"
# The host file that builds the actor passed to a plugin's handleApiRequest.
SERVER_ROUTES_FILE="${UPSTREAM_READINESS_SERVER_ROUTES:-/app/server/dist/routes/plugins.js}"
# The repository these reports are destined for, and the app's repo ceiling.
DESTINATION_REPO="${UPSTREAM_READINESS_DESTINATION:-paperclipai/paperclip}"
ALLOWED_REPOS="${GH_APP_REPOS-}"

PLUGIN_KEY="gh-token-broker"
REQUIRED_ROUTES=(disclosure-preflight disclose)

c_red() { printf '\033[31m%s\033[0m\n' "$*"; }
c_grn() { printf '\033[32m%s\033[0m\n' "$*"; }
c_yel() { printf '\033[33m%s\033[0m\n' "$*"; }
c_bold() { printf '\033[1m%s\033[0m\n' "$*"; }
die()   { c_red "$ME: $*" >&2; exit $EXIT_REFUSED; }

WORK=""
trap '[ -n "$WORK" ] && rm -rf "$WORK"' EXIT

usage() {
  cat <<EOF
$ME — measure whether an upstream defect report could actually be filed.

  $ME check [options]
      --repo DIR         git checkout holding the registry + plugins
                         (default: the script's own directory)
      --ref REF          git ref to read the repo side from (default: origin/main)
      --destination R    owner/repo the reports are destined for
                         (default: $DESTINATION_REPO)
      --server-routes F  host file that builds the plugin-route actor
                         (default: $SERVER_ROUTES_FILE)

  $ME gates
      Print one line per gate as <gate> \\t <open|closed> \\t <detail>.
      Same measurement, machine-readable, same exit codes.

Environment:
  PLUGINS_SOURCE_CMD  command emitting deployed plugin rows as TSV.
                      Default: <repo>/pg_source.js plugins
  GH_APP_REPOS        the GitHub App repository ceiling, read as-is.

Exit: 0 all gates open   2 refused (measured nothing)   4 a gate is closed
EOF
}

# Every probe appends exactly one record here. Nothing else writes it, and the
# verdict is computed from it rather than from a counter a probe could forget
# to bump.
record() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$WORK/gates.tsv"; }

# ---------------------------------------------------------------------------
# GATE A — is any external-disclosure authorizer trusted?
#
# The registry is the artifact the whole decision was originally framed around.
# It is read from the REF, not the working tree: a key added to an uncommitted
# working copy is not a key the merged gate would trust.
# ---------------------------------------------------------------------------
gate_registry() {
  local json
  json="$(git -C "$REPO_DIR" show "$REF:external_disclosure_authorizers.json" 2>/dev/null)" \
    || die "cannot read external_disclosure_authorizers.json from $REF in $REPO_DIR. Measured nothing."

  local n
  n="$(printf '%s' "$json" | node -e '
    const fs = require("fs");
    let t = "";
    try { t = fs.readFileSync(0, "utf8"); } catch { process.exit(9); }
    let v;
    try { v = JSON.parse(t); } catch { process.exit(9); }
    if (!v || !Array.isArray(v.keys)) process.exit(9);
    // "Usable" must mean usable TO THE CONSUMER, not merely well-populated. The
    // consumer is external_disclosure.js:readTrustStore(), which calls
    // exactKeys(entry, ["keyId","algorithm","authorizingPrincipal","publicKeyPem"])
    // and then crypto.createPublicKey() on the PEM. Measured 2026-08-31 (TOG-762):
    // this probe previously required `publicKey`, a field name that appears in NO
    // consumer. Both directions were wrong and both were silent:
    //
    //   - false CLOSED: a correctly-shaped registry ({...,publicKeyPem}) scored 0
    //     usable keys, so the gate stayed red at the exact moment it should flip.
    //     Verified: a two-key real-shape registry read `closed` while the consumer
    //     accepted the same file and verified a signature against it.
    //   - false OPEN: {keyId, publicKey:"not-a-key"} scored usable, while the
    //     consumer dies on exactKeys before ever reaching the crypto.
    //
    // So the shape is checked exactly as the consumer checks it, and the PEM is
    // parsed rather than merely measured for length. An entry that would make the
    // consumer die is not an authorizer this gate will score as trust.
    const crypto = require("crypto");
    const EXACT = ["algorithm", "authorizingPrincipal", "keyId", "publicKeyPem"];
    const usable = v.keys.filter((k) => {
      if (!k || typeof k !== "object" || Array.isArray(k)) return false;
      const got = Object.keys(k).sort();
      if (got.length !== EXACT.length) return false;
      if (!got.every((n, i) => n === EXACT[i])) return false;
      if (k.algorithm !== "ed25519") return false;
      if (typeof k.keyId !== "string" || !k.keyId) return false;
      const p = k.authorizingPrincipal;
      if (!p || typeof p !== "object" || Array.isArray(p)) return false;
      if (typeof p.principalClass !== "string" || !p.principalClass) return false;
      if (typeof p.principalId !== "string" || !p.principalId) return false;
      if (typeof k.publicKeyPem !== "string" || !k.publicKeyPem) return false;
      try {
        return crypto.createPublicKey(k.publicKeyPem).asymmetricKeyType === "ed25519";
      } catch { return false; }
    });
    // A duplicate keyId makes the consumer die outright, so the whole registry is
    // unusable — not "usable minus one". Score it as trusting nothing.
    const ids = new Set(usable.map((k) => k.keyId));
    process.stdout.write(String(ids.size === usable.length ? usable.length : 0));
  ' 2>/dev/null)" \
    || die "external_disclosure_authorizers.json at $REF is not the shape this gate reads ({version, keys[]}). Refusing rather than scoring it."

  if [ "$n" -gt 0 ]; then
    record authorizer-registry open "$n usable authorizer key(s) trusted at $REF"
  else
    record authorizer-registry closed "no usable authorizer keys at $REF — every signed grant is refused as untrusted"
  fi
}

# ---------------------------------------------------------------------------
# GATE B — are the disclosure routes actually DEPLOYED?
#
# Reads the `plugins` DATABASE ROW, because `manifest_json` is what the host
# read at install and dispatches from right now. The package directory under
# /opt is what it would read at the NEXT activation, and on this host those can
# disagree. This is the same seam and the same reasoning as
# plugin_deploy_drift.sh, narrowed to the two routes filing depends on.
# ---------------------------------------------------------------------------
gate_routes_deployed() {
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
  # them and an EMPTY FIELD DISAPPEARS. Most rows on this host are registry
  # installs with a NULL package_path, so column 2 is empty and every later
  # column shifts left — the manifest lands in `version`. \x1f is not IFS
  # whitespace, so each separator yields its own field and an empty one
  # survives. It cannot occur in the data: pg renders control characters inside
  # jsonb strings as \uXXXX escapes.
  tr '\t' '\037' < "$rows" > "$rows.us" && mv "$rows.us" "$rows"

  local key path pstatus version mjson found=0
  while IFS=$'\037' read -r key path pstatus version mjson; do
    [ "$key" = "$PLUGIN_KEY" ] || continue
    found=1
    printf '%s' "$mjson" > "$WORK/deployed.json"
    break
  done < "$rows"

  # A missing plugin row is a REFUSAL, not a closed gate. "The broker is not
  # installed at all" and "the broker is installed without these routes" are
  # different facts and this tool must not blur them into one verdict.
  [ "$found" -eq 1 ] \
    || die "no deployed row for plugin '$PLUGIN_KEY' in the plugins source. Measured nothing about route deployment."

  local deployed
  deployed="$(node -e '
    const fs = require("fs");
    const t = fs.readFileSync(process.argv[1], "utf8");
    if (!t.trim()) process.exit(9);
    let m;
    try { m = JSON.parse(t); } catch { process.exit(9); }
    const routes = Array.isArray(m.apiRoutes) ? m.apiRoutes : [];
    process.stdout.write(routes.map((r) => r && r.routeKey).filter(Boolean).join(" "));
  ' "$WORK/deployed.json" 2>/dev/null)" \
    || die "the deployed manifest_json for '$PLUGIN_KEY' is empty or does not parse. Refusing rather than scoring it."

  local missing=() r
  for r in "${REQUIRED_ROUTES[@]}"; do
    case " $deployed " in
      *" $r "*) ;;
      *) missing+=("$r") ;;
    esac
  done

  if [ ${#missing[@]} -eq 0 ]; then
    record route-deployed open "deployed manifest serves ${REQUIRED_ROUTES[*]}"
  else
    record route-deployed closed "deployed manifest is missing route(s): ${missing[*]} (serves: ${deployed:-none})"
  fi
}

# ---------------------------------------------------------------------------
# GATE C — does the host give the worker the actorSource it demands?
#
# The worker fails closed on anything that is not `agent_jwt`
# (plugins/gh-token-broker/dist/worker.js: "requires a host-verified agent_jwt
# actor source"). The host builds the actor it passes to handleApiRequest. If
# that object has no actorSource key, the check reads `undefined`, and EVERY
# call to the disclosure route 403s no matter what else is provisioned.
#
# This is measured STRUCTURALLY, not by grepping for the word. What the worker
# needs is a KEY OF THE DISPATCHED ACTOR, which is not the same question as
# whether a string occurs in a file. Measured 2026-08-30: `actorSource` occurs
# zero times in the host route file today, so a grep and this probe agree right
# now — but they agree by luck, and they come apart in both directions:
#
#   - open on a word: the host calls getActorInfo at plugins.js:1437, and
#     authz.js:176 DOES return actorSource on that object. Any later edit that
#     names the field in a log line, a comment, or a different route on this
#     2000-line file flips a grep to green while the dispatched actor is
#     unchanged. Six other files under /app/server/dist already carry the word.
#   - open on a nested key: `meta: { actorSource }` inside the actor literal is
#     a key of `meta`, not of the actor the worker destructures.
#
# So the actor object literal at the handleApiRequest call site is brace-matched
# and its TOP-LEVEL keys enumerated. Both false greens are pinned by cases in
# the regression suite.
# ---------------------------------------------------------------------------
gate_actor_source() {
  [ -f "$SERVER_ROUTES_FILE" ] \
    || die "cannot read the host plugin route file at $SERVER_ROUTES_FILE. Measured nothing about actorSource."

  local keys
  keys="$(node -e '
    const fs = require("fs");
    const src = fs.readFileSync(process.argv[1], "utf8");

    // Anchor on the dispatch call itself. This is the one call site whose
    // actor object reaches a plugin worker.
    const call = src.indexOf("handleApiRequest");
    if (call < 0) process.exit(9);

    // The actor literal is built just above the call, inside the same input
    // object. Take the nearest preceding `actor: {`.
    const head = src.slice(0, call);
    const at = head.lastIndexOf("actor: {");
    if (at < 0) process.exit(9);

    // Brace-match forward so nested objects do not truncate the block.
    let i = head.indexOf("{", at), depth = 0, end = -1;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) process.exit(9);

    const rawBody = src.slice(src.indexOf("{", at) + 1, end);

    // Strip comments BEFORE tokenizing. Measured on the TOG-727 candidate patch:
    // a `//` comment sitting between `runId:` and `actorSource:` made this
    // extractor drop actorSource entirely and report the gate CLOSED against a
    // host that propagates it. The tokenizer below resets on `,` and requires
    // the accumulated token to be a bare identifier, so prose (which contains
    // commas, and does not end at one) poisons the following key. Since a fixed
    // host is overwhelmingly likely to land WITH an explanatory comment on that
    // exact line, the gate would have failed to flip at the moment it mattered.
    //
    // Quote-aware, because `actorType === "user"` puts a string in this body and
    // a naive strip would treat a `//` inside one as a comment.
    let body = "", q = null, esc = false;
    for (let i = 0; i < rawBody.length; i++) {
      const c = rawBody[i];
      if (q) {
        body += c;
        if (esc) { esc = false; continue; }
        if (c === "\\") { esc = true; continue; }
        if (c === q) q = null;
        continue;
      }
      if (c === "\"" || c === "\x27" || c === "`") { q = c; body += c; continue; }
      if (c === "/" && rawBody[i + 1] === "/") {
        while (i < rawBody.length && rawBody[i] !== "\n") i++;
        body += "\n";
        continue;
      }
      if (c === "/" && rawBody[i + 1] === "*") {
        i += 2;
        while (i < rawBody.length && !(rawBody[i] === "*" && rawBody[i + 1] === "/")) i++;
        i++;
        body += " ";
        continue;
      }
      body += c;
    }

    // Top-level keys only: a key inside a nested object is not a key of the
    // actor the worker receives.
    const out = [];
    let d = 0, tok = "";
    for (const c of body) {
      if (c === "{" || c === "[" || c === "(") d++;
      else if (c === "}" || c === "]" || c === ")") d--;
      if (d === 0) {
        if (c === ",") { tok = ""; continue; }
        if (c === ":") { const k = tok.trim().replace(/^["\x27]|["\x27]$/g, ""); if (/^[A-Za-z_$][\w$]*$/.test(k)) out.push(k); tok = ""; continue; }
        tok += c;
      }
    }
    if (!out.length) process.exit(9);
    process.stdout.write(out.join(" "));
  ' "$SERVER_ROUTES_FILE" 2>/dev/null)" \
    || die "could not structurally extract the plugin-route actor object from $SERVER_ROUTES_FILE. Refusing rather than guessing."

  case " $keys " in
    *" actorSource "*)
      record actor-source open "host propagates actorSource to the plugin worker (actor keys: $keys)" ;;
    *)
      record actor-source closed "host builds the plugin actor without actorSource (actor keys: $keys) — the worker's agent_jwt check reads undefined and 403s" ;;
  esac
}

# ---------------------------------------------------------------------------
# GATE D — is the destination repository inside the App's ceiling?
#
# GH_APP_REPOS is the ceiling the broker mints against. If the destination is
# not in it, a token for that repository cannot be minted at all — independent
# of every other gate, and not fixable by any agent.
#
# An UNSET ceiling is a refusal, not an open gate. Treating "I could not read
# the ceiling" as "the destination is inside it" is the fail-open this whole
# file is built against.
# ---------------------------------------------------------------------------
gate_destination_scope() {
  [ -n "${ALLOWED_REPOS:-}" ] \
    || die "GH_APP_REPOS is unset or empty, so the repository ceiling could not be read. Measured nothing about destination scope."

  # The ceiling lists bare repo names; the destination is owner/repo.
  local want="${DESTINATION_REPO##*/}"
  [ -n "$want" ] || die "destination '$DESTINATION_REPO' has no repository component. Measured nothing."

  local hit=0 entry
  local IFS=', '
  for entry in $ALLOWED_REPOS; do
    entry="${entry##*/}"
    [ "$entry" = "$want" ] && hit=1
  done
  unset IFS

  if [ "$hit" -eq 1 ]; then
    record destination-scope open "$DESTINATION_REPO is inside GH_APP_REPOS ($ALLOWED_REPOS)"
  else
    record destination-scope closed "$DESTINATION_REPO is NOT in GH_APP_REPOS ($ALLOWED_REPOS) — no token can be minted for it"
  fi
}

run_all_gates() {
  WORK="$(mktemp -d)" || die "cannot create a work directory"
  : > "$WORK/gates.tsv"
  gate_registry
  gate_routes_deployed
  gate_actor_source
  gate_destination_scope

  # Every gate must have reported. A probe that returned without recording is a
  # gate nobody measured, and scoring the run without it would be the silent
  # green this tool exists to prevent.
  local n
  n="$(wc -l < "$WORK/gates.tsv")"
  [ "$n" -eq 4 ] || die "expected 4 gate records, got $n. A probe returned without recording; refusing to score this run."
}

cmd_gates() {
  run_all_gates
  cat "$WORK/gates.tsv"
  grep -q '	closed	' "$WORK/gates.tsv" && exit $EXIT_BLOCKED
  exit $EXIT_OK
}

cmd_check() {
  run_all_gates

  c_bold "upstream filing readiness"
  printf '  repo       %s\n' "$REPO_DIR"
  printf '  reference  %s\n' "$REF"
  printf '  destination %s\n\n' "$DESTINATION_REPO"

  local gate state detail closed=0
  while IFS=$'\t' read -r gate state detail; do
    if [ "$state" = "open" ]; then
      c_grn "  OPEN    $gate"
    else
      c_red "  CLOSED  $gate"
      closed=$((closed+1))
    fi
    printf '          %s\n' "$detail"
  done < "$WORK/gates.tsv"

  printf '\n'
  if [ "$closed" -eq 0 ]; then
    c_grn "All 4 gates are open. Filing an upstream report would execute."
    exit $EXIT_OK
  fi

  c_red "$closed of 4 gates are CLOSED. Filing would execute nothing."
  c_yel "Authorizing a filing today spends a reserved decision on a code path that does not run."
  exit $EXIT_BLOCKED
}

main() {
  local mode="${1:-}"
  [ $# -gt 0 ] && shift
  case "$mode" in
    check|gates) ;;
    -h|--help|help) usage; exit $EXIT_OK ;;
    # No subcommand measured nothing, so it must never return EXIT_OK — that is
    # the code meaning "all four gates open, filing could execute". A caller
    # that forgets the verb (or a CI line that drops it) would otherwise read a
    # usage screen as a green light. Refuse, exactly like any unmeasured gate.
    "") c_red "$ME: no command given — nothing was measured" >&2; usage >&2; exit $EXIT_REFUSED ;;
    *) c_red "$ME: unknown command '$mode'" >&2; usage >&2; exit $EXIT_REFUSED ;;
  esac

  while [ $# -gt 0 ]; do
    case "$1" in
      --repo)          REPO_DIR="${2:-}"; shift 2 || die "--repo needs a value" ;;
      --ref)           REF="${2:-}"; shift 2 || die "--ref needs a value" ;;
      --destination)   DESTINATION_REPO="${2:-}"; shift 2 || die "--destination needs a value" ;;
      --server-routes) SERVER_ROUTES_FILE="${2:-}"; shift 2 || die "--server-routes needs a value" ;;
      *) die "unknown option '$1'" ;;
    esac
  done
  [ -n "$REPO_DIR" ] || die "--repo needs a value"
  [ -n "$REF" ] || die "--ref needs a value"
  [ -n "$DESTINATION_REPO" ] || die "--destination needs a value"
  [ -n "$SERVER_ROUTES_FILE" ] || die "--server-routes needs a value"

  case "$mode" in
    check) cmd_check ;;
    gates) cmd_gates ;;
  esac
}

main "$@"
