#!/usr/bin/env bash
# Audit public vendor-fork publications against operator-owned exact SHA pins.
# A push publishes bytes even without a PR. Enumerate forks rather than assuming
# a fixed inventory; NEW-REF and DIVERGED are both publication candidates.
# Author email is forgeable triage metadata, NOT authenticated approval.
#
# Real audit/diagnostic mode requires DISCLOSURE_AUDIT_CONFIG_FILE pointing to
# a bounded local version-1 JSON object with exactly these keys:
#   version, organization, authorDomains, botLogins, trackerPrefixes,
#   privateProbe, declaredFile, posthocFile, provenancePolicyFile, parentCacheFile
# organization is one explicit org login; authorDomains are literal domains;
# botLogins are exact logins (optional numeric noreply prefixes are supported);
# trackerPrefixes are literal work-record prefixes. Both author lists may not be
# empty. trackerPrefixes is nonempty. privateProbe is a known-private OWNER/REPO.
# declaredFile/posthocFile are absolute, readable local pin-list paths; an
# explicitly empty file means no grants, not missing configuration. Optional
# provenancePolicyFile/parentCacheFile must be null or absolute local paths.
# There are NO runnable org/identity/probe/review/checkpoint defaults. Legacy
# environment classifier/pin overrides are ignored; only the config file binds
# those values. Config/policy/pins must be maintained in an operator-controlled
# location, never generated from evidence, Git metadata, a webhook or model output.
# This reader validates shape, not the operator's identity, approval or file trust.
# It neither provisions a producer nor authenticates review records.
#
# DECLARED: repo|ref|full-sha|record-id|gate-closed-utc|note
# POSTHOC:  repo|ref|full-sha|record-id|first-public-utc-or-unknown|adjudicated-utc|note
# POSTHOC takes precedence and keeps a separate count. A changed SHA is never
# accepted by an older pin. Consistent provenance diagnostics grant nothing.
#
# Exit 0: no ours-authored unpinned candidates; exit 1: undeclared or unresolved;
# exit 2: unable to evaluate (including missing/malformed trusted configuration).
# Only --self-test is hermetic CI: its settings/identities are synthetic and
# exist solely in that dispatch branch, never as a fallback for real audit mode.
set -Eeuo pipefail
API="https://api.github.com"

load_trusted_config() {
  local path="${DISCLOSURE_AUDIT_CONFIG_FILE:-}" output
  [ -n "$path" ] || { printf 'cannot evaluate: DISCLOSURE_AUDIT_CONFIG_FILE is required.\n' >&2; return 2; }
  output=$(python3 - "$path" <<'CONFIG'
import json, os, re, stat, sys
LIMIT = 2 * 1024 * 1024
def refuse():
    raise ValueError()
def unique(pairs):
    out = {}
    for key, value in pairs:
        if key in out: refuse()
        out[key] = value
    return out
def literal(value, pattern):
    if not isinstance(value, str) or not re.fullmatch(pattern, value): refuse()
    return value
def bounded_list(value, pattern, nonempty=False):
    if not isinstance(value, list) or len(value) > 32 or (nonempty and not value): refuse()
    out = [literal(v, pattern) for v in value]
    if len(set(out)) != len(out): refuse()
    return out
def path(value, optional=False):
    if value is None and optional: return ""
    if not isinstance(value, str) or not value.startswith("/") or len(value) > 4096: refuse()
    if any(ord(c) < 32 or ord(c) == 127 for c in value): refuse()
    return value
try:
    fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode): refuse()
        raw = stream.read(LIMIT + 1)
    if len(raw) > LIMIT: refuse()
    c = json.loads(raw, object_pairs_hook=unique)
    keys = set("version organization authorDomains botLogins trackerPrefixes privateProbe declaredFile posthocFile provenancePolicyFile parentCacheFile".split())
    if not isinstance(c, dict) or set(c) != keys: refuse()
    if type(c["version"]) is not int or c["version"] != 1: refuse()
    org = literal(c["organization"], r"[A-Za-z0-9][A-Za-z0-9-]{0,99}")
    domains = bounded_list(c["authorDomains"], r"[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\.[A-Za-z]{2,63}")
    if any(d.startswith(".") or ".." in d for d in domains): refuse()
    bots = bounded_list(c["botLogins"], r"[A-Za-z0-9][A-Za-z0-9-]{0,99}(?:\[bot\])?")
    prefixes = bounded_list(c["trackerPrefixes"], r"[A-Za-z][A-Za-z0-9]{0,31}", True)
    if not domains and not bots: refuse()
    # A shared privacy domain cannot identify a known author by itself.
    if any(d.lower() == "users.noreply.github.com" for d in domains): refuse()
    probe = literal(c["privateProbe"], r"[A-Za-z0-9._-]+/[A-Za-z0-9._-]+")
    arms = []
    if domains: arms.append(r"[^@]+@(" + "|".join(re.escape(d) for d in domains) + ")")
    if bots: arms.append(r"([0-9]+\+)?(" + "|".join(re.escape(b) for b in bots) + r")@users\.noreply\.github\.com")
    values = [org, "^(" + "|".join(arms) + ")$",
              "(" + "|".join(re.escape(x) for x in prefixes) + ")-?[0-9]{3,}", probe,
              path(c["declaredFile"]), path(c["posthocFile"]),
              path(c["provenancePolicyFile"], True), path(c["parentCacheFile"], True)]
    print("\n".join(values))
except (OSError, UnicodeError, ValueError, RecursionError):
    print("cannot evaluate: unreadable, nonregular or malformed operator configuration.", file=sys.stderr)
    sys.exit(2)
CONFIG
  ) || return 2
  local -a values
  mapfile -t values <<< "$output"
  ORG="${values[0]}"; OUR_AUTHOR_RE="${values[1]}"; CARD_REF_RE="${values[2]}"
  ANON_PROBE="${values[3]}"; DECLARED_FILE="${values[4]}"; POSTHOC_FILE="${values[5]}"
  PROVENANCE_POLICY="${values[6]:-}"; CACHE="${values[7]:-}"
  # Evidence cannot set this policy, nor can a stale ambient override replace it.
  export DISCLOSURE_AUDIT_PROVENANCE_POLICY="$PROVENANCE_POLICY"
}

self_test() {
  local ours=(
    'ops@synthetic-owner.invalid'
    'eng@synthetic-owner.example'
    'engineering@synthetic-owner.test'
    'synthetic-owner[bot]@users.noreply.github.com'
    '1000001+synthetic-owner[bot]@users.noreply.github.com'
    '1000002+synthetic-owner[bot]@users.noreply.github.com'
  )
  local theirs=(
    'maintainer-a@fixture-vendor.invalid' 'maintainer-b@fixture-vendor.invalid'
    'noreply@fixture-vendor.invalid'
    '2000001+fixture-vendor-user@users.noreply.github.com'
    'fixture-vendor-user@users.noreply.github.com' 'fixture-vendor-user@fixture-mail.invalid'
    '2000002+fixture-dependency[bot]@users.noreply.github.com'
    'contributor-a@fixture-university.invalid' 'contributor-b@fixture-mail.invalid'
    'contributor-c@fixture-mail.invalid' 'contributor-d@fixture-mail.invalid'
    'contributor-e@fixture-alt.invalid' 'contributor-f@fixture-mail.invalid'
    'contributor-g@fixture-mail.invalid'
    'synthetic-agent@unconfigured.invalid'
    'evilsynthetic-owner[bot]@users.noreply.github.com'
    'synthetic-ownerxbot@users.noreply.github.com'
    'synthetic-owner[bot]@users.noreply.github.com.evil.invalid'
    'a@synthetic-owner.example.evil.invalid'
    'attacker@evil.invalid@synthetic-owner.example'
  )
  local t_pass=0 t_fail=0 e
  printf '== self-test: OUR_AUTHOR_RE\n   %s\n\n' "$OUR_AUTHOR_RE"
  for e in "${ours[@]}"; do
    if grep -qEi "$OUR_AUTHOR_RE" <<<"$e"; then
      t_pass=$((t_pass+1))
    else
      t_fail=$((t_fail+1))
      printf '  FAIL  ours, but NOT matched (false negative -- ref would be SKIPPED): %s\n' "$e"
    fi
  done
  for e in "${theirs[@]}"; do
    if grep -qEi "$OUR_AUTHOR_RE" <<<"$e"; then
      t_fail=$((t_fail+1))
      printf '  FAIL  external, but MATCHED (false positive -- allowlist weakened): %s\n' "$e"
    else
      t_pass=$((t_pass+1))
    fi
  done
  printf '== %s/%s identity classifications correct\n' \
    "$t_pass" "$((t_pass + t_fail))"
  [ "$t_fail" -eq 0 ] || { printf 'FAIL: OUR_AUTHOR_RE misclassifies %s identity/identities.\n' "$t_fail"; return 1; }
  printf 'PASS: every known identity classifies correctly.\n'
  return 0
}

TMP="$(mktemp -d "${TMPDIR:-/tmp}/fork-disclosure.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

api() {
  local cfg rc
  [ -n "${GH_TOKEN:-}" ] || { curl -fsSL --max-time 30 "$@" 2>/dev/null; return $?; }
  cfg="$(umask 077; mktemp "$TMP/curlcfg.XXXXXXXX")" || return 1
  chmod 0600 "$cfg"
  printf 'header = "Authorization: Bearer %s"\n' "$GH_TOKEN" > "$cfg"
  curl -fsSL --max-time 30 --config "$cfg" "$@" 2>/dev/null
  rc=$?
  rm -f "$cfg"
  return $rc
}

token_argv_test() {
  local probe canary t_pass=0 t_fail=0
  probe="$(umask 077; mktemp -d "$TMP/argv-probe.XXXXXX")" || return 1
  canary='CANARY-not-a-real-token'
  cat > "$probe/curl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$ARGV_LOG"
cfg=''; prev=''
for a in "$@"; do [ "$prev" = '--config' ] && cfg="$a"; prev="$a"; done
if [ -n "$cfg" ]; then cat "$cfg" > "$CFG_LOG"; else : > "$CFG_LOG"; fi
exit 0
STUB
  chmod 0755 "$probe/curl"
  (
    export ARGV_LOG="$probe/argv.log" CFG_LOG="$probe/cfg.log" \
           PATH="$probe:$PATH" GH_TOKEN="$canary"
    api 'https://api.github.com/meta' >/dev/null
  ) || true

  printf '\n== self-test: GH_TOKEN placement\n\n'
  t() { if [ "$1" = ok ]; then t_pass=$((t_pass+1)); printf '  PASS  %s\n' "$2";
        else t_fail=$((t_fail+1)); printf '  FAIL  %s\n' "$2"; fi; }

  grep -qF "$canary" "$probe/argv.log" \
    && t no 'token LEAKED into curl argv (/proc/<pid>/cmdline, bash -x)' \
    || t ok  'token absent from curl argv'
  grep -qF -- '--config' "$probe/argv.log" \
    && t ok  'curl was invoked through --config' \
    || t no  'curl was not invoked through --config'
  grep -qF "Authorization: Bearer $canary" "$probe/cfg.log" \
    && t ok  'positive control: the token did reach curl, via its config file' \
    || t no  'positive control FAILED -- the token reached curl by no path at all'
  [ -z "$(find "$TMP" -maxdepth 1 -name 'curlcfg.*' -print -quit)" ] \
    && t ok  'the config file is removed after the request' \
    || t no  'a config file holding the token was left on disk'

  printf '== %s/%s credential-placement checks correct\n' "$t_pass" "$((t_pass + t_fail))"
  [ "$t_fail" -eq 0 ] || { printf 'FAIL: GH_TOKEN is not handled safely.\n'; return 1; }
  printf 'PASS: GH_TOKEN never enters argv.\n'
  return 0
}

#
#
load_pin_list() {  # <name of the environment variable holding the file path>
  local var="$1" file
  file="${!var:-}"
  [ -n "$file" ] || { printf 'cannot evaluate: missing operator pin file.\n' >&2; return 2; }
  if [ ! -f "$file" ] || [ ! -r "$file" ]; then
    printf 'cannot evaluate: %s=%s is not a readable file\n' "$var" "$file" >&2
    return 2
  fi
  grep -vE '^[[:space:]]*(#|$)' "$file" || [ "$?" -eq 1 ]
}

#
#
#

#
#
#
#

pass=0; posthoc=0; fail=0; undeclared=0; unresolved=0; UNRESOLVED_LIST=()
ok()  { printf '  PASS  %s\n' "$1"; pass=$((pass+1)); }
adj() { printf '  POSTHOC  %s\n' "$1"; posthoc=$((posthoc+1)); }
bad() { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); }

pin_card() {  # <list> <repo> <ref> <sha>
  awk -F'|' -v r="$2" -v f="$3" -v s="$4" \
    '$1==r && $2==f && $3==s && $4!="" {print $4; exit}' <<<"$1"
}

ours_verdict() {  # <repo> <ref> <sha>
  local card
  card=$(pin_card "$POSTHOC" "$1" "$2" "$3")
  if [ -n "$card" ]; then
    adj "$1 $2 @ ${3:0:10} -- PUBLIC, POST-HOC adjudicated ($card)"
    return 0
  fi
  card=$(pin_card "$DECLARED" "$1" "$2" "$3")
  if [ -n "$card" ]; then
    ok "$1 $2 @ ${3:0:10} -- PUBLIC, declared ($card)"
    return 0
  fi
  return 1
}

#
posthoc_test() {
  local p_pass=0 p_fail=0 line out rc repo ref sha card first adjd note
  local sha_re='^[0-9a-f]{40}$'
  local utc_re='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
  local fx=0123456789abcdef0123456789abcdef01234567
  local fx2=89abcdef0123456789abcdef0123456789abcdef
  local saved_posthoc="$POSTHOC" sample
  sample="sample-repo|refs/heads/main|$fx|ISSUE-1|unknown|2000-01-02T00:00:00Z|sample ruling, first publication unknown
sample-repo|refs/heads/feature/sample|$fx2|ISSUE-2|2000-01-01T00:00:00Z|2000-01-02T00:00:00Z|sample ruling, first publication known"
  POSTHOC="${POSTHOC:+$POSTHOC$'\n'}$sample"
  pt() { if [ "$1" = ok ]; then p_pass=$((p_pass+1));
         else p_fail=$((p_fail+1)); printf '  FAIL  %s\n' "$2"; fi; }

  printf '\n== self-test: POSTHOC never reports as declared\n\n'
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    IFS='|' read -r repo ref sha card first adjd note <<<"$line"
    [ "$(awk -F'|' '{print NF}' <<<"$line")" -eq 7 ] \
      && pt ok || pt no "not 7 fields: $line"
    [[ $repo =~ ^[A-Za-z0-9._-]+$ ]] && pt ok || pt no "bad repo: $line"
    [[ $ref == refs/heads/?* ]] && pt ok || pt no "ref not under refs/heads/ (never audited): $line"
    [[ $sha =~ $sha_re ]] && pt ok || pt no "sha not full 40-hex: $line"
    [[ $card =~ ^[A-Za-z][A-Za-z0-9]*-[0-9]+$ ]] && pt ok || pt no "bad card: $line"
    [[ $first == unknown || $first =~ $utc_re ]] && pt ok || pt no "bad first-public-utc: $line"
    [[ $adjd =~ $utc_re ]] && pt ok || pt no "bad adjudicated-utc: $line"
    [ -n "$note" ] && pt ok || pt no "empty note: $line"
    if out=$(ours_verdict "$repo" "$ref" "$sha"); then rc=0; else rc=$?; fi
    [ "$rc" -eq 0 ] && grep -qF "PUBLIC, POST-HOC adjudicated ($card)" <<<"$out" \
      && pt ok || pt no "real entry not reported POST-HOC: $line"
    grep -qF 'declared' <<<"$out" \
      && pt no "real POSTHOC entry printed as declared: $out" || pt ok
  done <<<"$POSTHOC"

  out=$( DECLARED="fx|refs/heads/both|$fx|ISSUE-1|2000-01-01T00:00:00Z|f
fx|refs/heads/decl|$fx|ISSUE-2|2000-01-01T00:00:00Z|f"
         POSTHOC="fx|refs/heads/both|$fx|ISSUE-3|unknown|2000-01-01T00:00:00Z|f
xfx|refs/heads/sub|$fx|ISSUE-4|unknown|2000-01-01T00:00:00Z|f"
         ours_verdict fx refs/heads/both "$fx"
         printf 'counts pass=%s posthoc=%s\n' "$pass" "$posthoc"
         ours_verdict fx refs/heads/decl "$fx"
         ours_verdict fx refs/heads/both "${fx%7}8" || printf 'moved: undeclared\n'
         ours_verdict fx refs/heads/sub "$fx" || printf 'substring: undeclared\n' )
  grep -qF 'fx refs/heads/both @ 0123456789 -- PUBLIC, POST-HOC adjudicated (ISSUE-3)' <<<"$out" \
    && pt ok || pt no 'a ref in BOTH lists did not report POST-HOC'
  grep -qF 'declared' <<<"$(grep -F 'refs/heads/both' <<<"$out")" \
    && pt no 'a ref in BOTH lists printed as declared' || pt ok
  grep -qF 'counts pass=0 posthoc=1' <<<"$out" \
    && pt ok || pt no 'POST-HOC counted as declared/clean, or not counted'
  grep -qF 'fx refs/heads/decl @ 0123456789 -- PUBLIC, declared (ISSUE-2)' <<<"$out" \
    && pt ok || pt no 'positive control FAILED -- a DECLARED-only ref did not print declared'
  grep -qF 'moved: undeclared' <<<"$out" \
    && pt ok || pt no 'a POSTHOC ref at a different sha was not undeclared'
  grep -qF 'substring: undeclared' <<<"$out" \
    && pt ok || pt no 'a POSTHOC line for another repo matched by substring'

  POSTHOC="$saved_posthoc"
  printf '== %s/%s POSTHOC checks correct\n' "$p_pass" "$((p_pass + p_fail))"
  [ "$p_fail" -eq 0 ] || { printf 'FAIL: POSTHOC reporting is unsafe or malformed.\n'; return 1; }
  printf 'PASS: no POSTHOC entry reports as declared.\n'
  return 0
}

provenance_diagnostic() {  # <file> <repo> <ref> <sha>
  {
    while IFS= read -r line; do
      if [ -n "$line" ]; then printf 'POSTHOC|%s\n' "$line"; fi
    done <<< "$POSTHOC"
    while IFS= read -r line; do
      if [ -n "$line" ]; then printf 'DECLARED|%s\n' "$line"; fi
    done <<< "$DECLARED"
  } | python3 "$(dirname "$0")/public_fork_provenance.py" \
        --evidence "$1" --repository "$ORG/$2" --ref "$3" --tip "$4"
}


if [ "${1:-}" = '--self-test' ]; then
  [ "$#" -eq 1 ] || { printf 'usage: %s --self-test\n' "$0" >&2; exit 2; }
  # These are synthetic classifier settings, not runnable audit defaults or
  # declarations. Ignore all caller-supplied identity/pin/configuration values.
  python3 - "$TMP" <<'SYNTHETIC'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
for name in ("declared", "posthoc"):
    (root / name).write_text("")
config = {"version": 1, "organization": "synthetic-owner",
          "authorDomains": ["synthetic-owner.invalid", "synthetic-owner.example", "synthetic-owner.test"],
          "botLogins": ["synthetic-owner[bot]"], "trackerPrefixes": ["ISSUE"],
          "privateProbe": "synthetic-private/probe", "declaredFile": str(root / "declared"),
          "posthocFile": str(root / "posthoc"), "provenancePolicyFile": None, "parentCacheFile": None}
(root / "synthetic-config.json").write_text(json.dumps(config))
SYNTHETIC
  DISCLOSURE_AUDIT_CONFIG_FILE="$TMP/synthetic-config.json"
  load_trusted_config || exit 1
  DECLARED="$(load_pin_list DECLARED_FILE)" || exit 1
  POSTHOC="$(load_pin_list POSTHOC_FILE)" || exit 1
  st_rc=0
  self_test || st_rc=1
  token_argv_test || st_rc=1
  posthoc_test || st_rc=1
  python3 "$(dirname "$0")/test_public_fork_provenance.py" || st_rc=1
  exit "$st_rc"
fi

# Refuse real audit or diagnostic queries before any network/Git operation.
case "${1:-}" in
  '') [ "$#" -eq 0 ] || exit 2;;
  --provenance-diagnostics) [ "$#" -eq 5 ] || { printf 'usage: %s --provenance-diagnostics FILE REPO REF SHA\n' "$0" >&2; exit 2; };;
  *) printf 'cannot evaluate: unsupported arguments.\n' >&2; exit 2;;
esac
load_trusted_config || exit 2
DECLARED="$(load_pin_list DECLARED_FILE)" || exit 2
POSTHOC="$(load_pin_list POSTHOC_FILE)" || exit 2
if [ "${1:-}" = '--provenance-diagnostics' ]; then
  [ "$#" -eq 5 ] || { printf 'usage: %s --provenance-diagnostics FILE REPO REF SHA\n' "$0" >&2; exit 2; }
  if provenance_diagnostic "$2" "$3" "$4" "$5"; then exit 0; else exit "$?"; fi
fi

provenance_unavailable=0

#
#
ANON_CWD="$TMP/anon-cwd"; mkdir -p "$ANON_CWD"
anon() {
  ( cd "$ANON_CWD" \
    && GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null \
       GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true \
       GIT_CONFIG_NOSYSTEM=1 "$@" )
}

#
#
#
if [ -z "$ANON_PROBE" ]; then
  printf 'cannot evaluate: privateProbe is not configured.\n'
  printf '   Set it to OWNER/REPO of a repository you KNOW is private. This gate\n'
  printf '   reads refs anonymously and proves that anonymity by asking for that\n'
  printf '   repository; without the proof every public/private verdict would be\n'
  printf '   unreliable, so it refuses to make any.\n'
  exit 2
fi
probe_refs="$(anon git ls-remote "https://github.com/$ANON_PROBE.git" 'refs/heads/*' 2>/dev/null || true)"
if [ -n "$probe_refs" ]; then
  printf 'cannot evaluate: the anonymous read path is NOT anonymous.\n'
  printf '   %s is private, yet an unauthenticated ls-remote returned refs.\n' "$ANON_PROBE"
  printf '   Refusing: use an unwrapped Git binary, neutral cwd and disabled credential helpers.\n'
  exit 2
fi



printf '== enumerating public repos in org %s\n\n' "$ORG"

if ! api "$API/orgs/$ORG/repos?per_page=100&type=public" > "$TMP/repos.json"; then
  printf 'cannot evaluate: GitHub API unreachable or rate-limited (org listing)\n'
  if curl -fsSL --max-time 15 "$API/rate_limit" > "$TMP/rl.json" 2>/dev/null; then
    python3 - "$TMP/rl.json" <<'PY' || printf '   rate limit response unparseable\n'
import json, sys, time
c = json.load(open(sys.argv[1]))["resources"]["core"]
wait = max(0, c["reset"] - int(time.time()))
print(f'   rate limit: {c["remaining"]}/{c["limit"]} remaining'
      f'{f", resets in {wait//60}m{wait%60}s" if c["remaining"] == 0 else ""}')
PY
    printf '   set GH_TOKEN and re-run, or wait for the reset, then re-run.\n'
  else
    printf '   api.github.com is unreachable from here (network, not quota).\n'
  fi
  exit 2
fi

python3 - "$TMP/repos.json" > "$TMP/forks.tsv" <<'PY'
import json,sys
for r in json.load(open(sys.argv[1])):
    if r.get("fork") and r.get("visibility") == "public":
        print(f"{r['name']}\t{(r.get('parent') or {}).get('full_name') or ''}")
PY

: > "$TMP/forks_resolved.tsv"
while IFS=$'\t' read -r name parent; do
  [ -n "$name" ] || continue
  if [ -z "$parent" ] && [ -f "$CACHE" ]; then
    parent=$(awk -F'\t' -v n="$ORG/$name" '$1==n{print $2}' "$CACHE" | head -1)
  fi
  if [ -z "$parent" ]; then
    if ! api "$API/repos/$ORG/$name" > "$TMP/r.json"; then
      printf 'cannot evaluate: could not read %s/%s\n' "$ORG" "$name"
      printf '   (a cached parent would have avoided this call; see %s)\n' "$CACHE"
      exit 2
    fi
    parent=$(python3 -c 'import json,sys;print((json.load(open(sys.argv[1])).get("parent") or {}).get("full_name") or "")' "$TMP/r.json")
    if [ -n "$parent" ] && [ -n "$CACHE" ]; then
      printf '%s\t%s\n' "$ORG/$name" "$parent" >> "$CACHE" 2>/dev/null || true
    fi
  fi
  [ -n "$parent" ] || { printf 'cannot evaluate: no parent for %s/%s\n' "$ORG" "$name"; exit 2; }
  printf '%s\t%s\n' "$name" "$parent" >> "$TMP/forks_resolved.tsv"
done < "$TMP/forks.tsv"

nforks=$(wc -l < "$TMP/forks_resolved.tsv" | tr -d ' ')
if [ "$nforks" -eq 0 ]; then
  printf 'no public forks in %s -- nothing of ours can be published this way\n' "$ORG"
  exit 0
fi
printf 'public forks found: %s\n\n' "$nforks"

while IFS=$'\t' read -r name parent; do
  printf '== %s/%s  (parent %s)\n' "$ORG" "$name" "$parent"

  if ! anon git ls-remote "https://github.com/$ORG/$name.git" 'refs/heads/*' > "$TMP/fork.refs" 2>/dev/null; then
    printf 'cannot evaluate: ls-remote failed on fork %s\n' "$name"; exit 2
  fi
  if ! anon git ls-remote "https://github.com/$parent.git" 'refs/heads/*' > "$TMP/up.refs" 2>/dev/null; then
    printf 'cannot evaluate: ls-remote failed on parent %s\n' "$parent"; exit 2
  fi
  if [ ! -s "$TMP/fork.refs" ] || [ ! -s "$TMP/up.refs" ]; then
    printf 'cannot evaluate: empty ref listing for %s or %s\n' "$name" "$parent"; exit 2
  fi
  printf '   fork heads %s / parent heads %s\n' \
    "$(wc -l < "$TMP/fork.refs" | tr -d ' ')" "$(wc -l < "$TMP/up.refs" | tr -d ' ')"

  awk 'NR==FNR{u[$2]=$1;next}
       { if (!($2 in u)) print "NEW-REF\t"$2"\t"$1;
         else if (u[$2]!=$1) print "DIVERGED\t"$2"\t"$1 }' \
    "$TMP/up.refs" "$TMP/fork.refs" > "$TMP/candidates.tsv"

  ncand=$(wc -l < "$TMP/candidates.tsv" | tr -d ' ')
  if [ "$ncand" -eq 0 ]; then
    ok "$name: every head matches the parent -- nothing of ours published"
    printf '\n'; continue
  fi
  printf '   %s ref(s) differ from the parent; resolving authorship\n' "$ncand"

  cutrefs=$(cut -f2 "$TMP/candidates.tsv")
  if [ -n "$cutrefs" ]; then
    rm -rf "$TMP/bare"; git init -q --bare "$TMP/bare"
    if ! anon git -C "$TMP/bare" fetch -q --depth=1 \
         "https://github.com/$ORG/$name.git" $cutrefs 2>"$TMP/fetch.err"; then
      printf 'cannot evaluate: shallow fetch of candidate refs failed on %s\n' "$name"
      sed 's/^/   /' "$TMP/fetch.err"; exit 2
    fi
  fi

  while IFS=$'\t' read -r kind ref sha; do
    [ -n "$ref" ] || continue
    if ! email=$(git -C "$TMP/bare" log -1 --format='%ae' "$sha" 2>/dev/null); then
      printf 'cannot evaluate: could not read commit %s on %s\n' "$sha" "$name"; exit 2
    fi
    subj=$(git -C "$TMP/bare" log -1 --format='%s' "$sha" 2>/dev/null | cut -c1-72)

    if ! grep -qEi "$OUR_AUTHOR_RE" <<<"$email"; then
      # An unconfigured identity is not proof of upstream ownership. In either
      # branch-name class, refuse before diagnostics rather than guessing clean.
      unresolved=$((unresolved+1))
      UNRESOLVED_LIST+=("$name $ref @ ${sha:0:10} author=$email")
      printf '   ????? %-8s %s\n           UNRESOLVED -- author (%s) is not configured.\n' "$kind" "$ref" "$email"
      if grep -qEi "$CARD_REF_RE" <<<"$ref"; then
        printf '           The ref name also carries a configured work-record prefix.\n'
      else
        printf '           Unknown authorship cannot be inferred as upstream provenance.\n'
      fi
      printf '           Resolve identity/provenance through trusted local operator configuration.\n'
      printf '           %s\n' "https://github.com/$ORG/$name/tree/${ref#refs/heads/}"
      continue
    fi

    if ! ours_verdict "$name" "$ref" "$sha"; then
      undeclared=$((undeclared+1))
      bad "$name $ref @ ${sha:0:10} -- PUBLIC AND UNDECLARED"
      if [ -n "${DISCLOSURE_AUDIT_PROVENANCE_EVIDENCE:-}" ]; then
        printf '           provenance (diagnostic-only; exact-pin finding unchanged):\n'
        if provenance_diagnostic "$DISCLOSURE_AUDIT_PROVENANCE_EVIDENCE" "$name" "$ref" "$sha"; then
          : # Consistency is NOT acceptance; do not change any verdict/count.
        else
          diagnostic_rc=$?
          if [ "$diagnostic_rc" -ne 1 ]; then provenance_unavailable=1; fi
        fi
      fi
      printf '           author %s\n           subject %s\n' "$email" "$subj"
      printf '           %s\n' "https://github.com/$ORG/$name/tree/${ref#refs/heads/}"
      if grep -qF "$name|$ref|" <<<"$DECLARED"; then
        was=$(printf '%s\n' "$DECLARED" | grep -F "$name|$ref|" | cut -d'|' -f3)
        if [ ${#was} -ne 40 ]; then
          printf '           NOTE: declared sha %s is %s chars, not 40 -- MALFORMED\n' "$was" "${#was}"
          printf '                 declarations must pin the full 40-hex sha. Not a force-push.\n'
        elif [ "${sha#"$was"}" != "$sha" ] || [ "${was#"$sha"}" != "$was" ]; then
          printf '           NOTE: declared sha %s is a prefix/abbreviation -- MALFORMED, pin all 40.\n' "$was"
        else
          printf '           NOTE: declared at %s -- these are DIFFERENT bytes (force-push?)\n' "${was:0:10}"
        fi
      fi
      was=$(awk -F'|' -v r="$name" -v f="$ref" '$1==r && $2==f {print $3; exit}' <<<"$POSTHOC")
      if [ -n "$was" ]; then
        printf '           NOTE: post-hoc adjudicated at %s -- these are DIFFERENT bytes.\n' "${was:0:10}"
        printf '                 A ruling covers one revision: adjudicate again, never move it to DECLARED.\n'
      fi
    fi
  done < "$TMP/candidates.tsv"
  printf '\n'
done < "$TMP/forks_resolved.tsv"

stale_pin_notes() {  # <label> <list>
  local drepo dref dsha dcard drest
  while IFS='|' read -r drepo dref dsha dcard drest; do
    [ -n "${drepo:-}" ] || continue
    if ! grep -q "$dsha" <<<"$(anon git ls-remote "https://github.com/$ORG/$drepo.git" "$dref" 2>/dev/null)"; then
      printf 'NOTE: %s %s %s @ %s (%s) is no longer at that sha -- prune or re-pin\n' \
        "$1" "$drepo" "$dref" "${dsha:0:10}" "$dcard"
    fi
  done <<< "$2"
}
stale_pin_notes declared "$DECLARED"
stale_pin_notes 'post-hoc adjudicated' "$POSTHOC"

printf '== %s declared/clean, %s post-hoc adjudicated, %s undeclared publication(s), %s unresolved\n' \
  "$pass" "$posthoc" "$undeclared" "$unresolved"

if [ "$provenance_unavailable" -ne 0 ]; then
  printf 'cannot evaluate: requested private provenance diagnostics were unavailable or malformed.\n'
  printf '   Exact-pin findings and counts above remain unchanged.\n'
  exit 2
fi

if [ "$unresolved" -ne 0 ]; then
  printf '\nUNRESOLVED (%s) -- author identity not configured:\n' "$unresolved"
  printf '   %s\n' "${UNRESOLVED_LIST[@]}"
  printf 'Each needs a one-time provenance ruling: add to DECLARED (with the card\n'
  printf 'whose gate closed before the push), or confirm it is genuinely upstream.\n'
  printf 'FAIL: %s ref(s) remain unadjudicated; no identity fallback is permitted.\n' "$unresolved"
  exit 1
fi

if [ "$fail" -ne 0 ]; then
  printf 'FAIL: bytes of ours are public without a declared, gate-closed provenance.\n'
  printf 'Either add a line to DECLARED naming the card whose content gate closed\n'
  printf 'BEFORE the push, or delete the branch from the public fork.\n'
  printf 'Bytes published before any gate closed go in POSTHOC, and only once a\n'
  printf 'card has adjudicated them -- never in DECLARED.\n'
  exit 1
fi
if [ "$posthoc" -ne 0 ]; then
  printf 'PASS: every public byte of ours is declared and gate-closed, except %s POST-HOC\n' "$posthoc"
  printf '      adjudicated ref(s) whose gate closed only AFTER publication.\n'
else
  printf 'PASS: every public byte of ours is declared and gate-closed.\n'
fi
exit 0
