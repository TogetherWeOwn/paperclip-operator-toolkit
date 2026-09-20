#!/usr/bin/env bash
# ===========================================================================
# tog-1014-public-fork-disclosure-audit.sh -- what has this org actually
# PUBLISHED to a public vendor fork, and was each item's content gate closed
# before those bytes went public?
#
# THE DEFECT THIS EXISTS FOR
#
# TOG-1014 is the standing procedure for upstream filings. It was written when
# the only way to publish was to click New PR, so every control in it attached
# to the PR. On 2026-09-05 that stopped being true: TOG-1104 forked
# `paperclipai/paperclip` and TOG-1116 forked `diegosouzapw/OmniRoute` into the
# `TogetherWeOwn` org, and BOTH FORKS ARE PUBLIC. A push to a public fork is
# fetchable, linkable and indexable the moment it lands -- with or without a
# PR. The gate has to attach to the PUSH.
#
# The card was revised in prose to say so at 16:16Z. Prose does not measure.
# In the same breath it asserted "Nothing of ours is published", which was
# true when written for the ONE fork it checked and FALSE 4 minutes later:
# `TogetherWeOwn/OmniRoute` carries `fix/quota-signal-errortext-threading`
# @ ba4b1927, pushed 15:44:20Z, anonymously readable. The sentence was not
# wrong through carelessness -- it was scoped to the fork the author had in
# mind, and a second fork appeared. That is exactly the class of claim that
# must be recomputed rather than re-asserted, so it lives here.
#
# WHY DISCOVERY IS BY ENUMERATION, NEVER A HARDCODED FORK LIST
#
# Hardcoding `paperclip` and `OmniRoute` would rebuild the hole this closes:
# the third fork, created tomorrow by a card nobody here has read, would be
# invisible and silence would read as "nothing published". The org's public
# repo list is enumerated at runtime and every fork in it is scored.
#
# WHY THE REF DIFF IS AGAINST THE PARENT, NOT A BRANCH NAME PATTERN
#
# A fork inherits every upstream branch at fork time -- ~820 on the paperclip
# fork, ~230 on OmniRoute. Those are not ours and flagging them would drown
# the signal. A ref is OURS when it is absent from the parent, or present but
# pointing at a different sha. Both arms matter and both are asserted: a
# NEW-REF is an obvious publication, and a DIVERGED ref is the subtler one --
# force-pushing our commits onto an inherited branch name publishes them just
# as thoroughly while the branch list looks untouched.
#
# WHY AUTHORSHIP DECIDES OURS-VS-THEIRS, AND WHY THAT IS NOT SUFFICIENT ALONE
#
# Upstream's own in-flight branches routinely diverge from what the fork
# snapshotted, so NEW-REF/DIVERGED alone over-reports. The commit author's
# email discriminates: our pushes are authored by the broker identity
# (`eng@togetherweown.com`), upstream's by vendor addresses. Authorship is
# forgeable in general -- it is NOT a security control here. It is a triage
# key for a report a human reads, and every ref is printed either way, so a
# misclassification is visible rather than silent.
#
# EXIT CODES -- three, not two, deliberately
#   0  no bytes of ours are public, or every published item is DECLARED below
#   1  something of ours is public that this file does not declare  <- the finding
#   2  cannot evaluate (no network, GitHub API unreachable/rate-limited)
#
# 2 is separate from 1 because a gate that cannot see the forks must not report
# "clean". An unreachable API and an empty fork are the same silence; conflating
# them is the fail-open this repo exists to prevent.
#
# CI: this gate needs outbound network to api.github.com and is therefore NOT
# registered in ci.yml -- see CONTRIBUTING rule 8 ("if you add a suite CI cannot
# run, say so and say why"). It is an operator/agent-run check. Running it in CI
# would either need a credential CI does not hold or would fail open on the
# sandbox's blocked egress, and a check that goes green when it measured nothing
# is worse than no check.
# ===========================================================================
set -Eeuo pipefail

ORG="${DISCLOSURE_AUDIT_ORG:-TogetherWeOwn}"
API="https://api.github.com"
# Our broker identity. MEASURED, not guessed -- the first draft of this gate
# used `togetherweown|paperclip\.ing` and produced SIX false positives, because
# `paperclip.ing` is the VENDOR's own domain (nicky@paperclip.ing has 13 commits
# on `paperclipai/paperclip` master). Matching the vendor we forked FROM flags
# their in-flight branches as our disclosures. Keep this anchored to domains we
# actually push under; widening it to anything that "looks like us" re-creates
# that bug, and a gate that cries wolf 6 times gets ignored on the 7th -- which
# is the one that matters.
#
# TOG-3327: that first draft was ALSO too narrow, in the direction that actually
# hurts. The `@togetherweown\.(com|invalid)$` form missed the identity most of
# our pushes are made under. `/paperclip/.gitconfig` sets the container-wide git
# default to `togetherweown[bot] <togetherweown[bot]@users.noreply.github.com>`,
# so any ref pushed without an explicit per-repo identity is authored by the App
# bot -- and the bot's address is on `users.noreply.github.com`, not on a
# togetherweown domain at all. Those refs were classified "upstream-authored --
# not ours" and skipped BEFORE the DECLARED allowlist check ever ran. That is a
# FALSE NEGATIVE: the gate reports clean while a real, undeclared publication
# made under the default identity goes unexamined. A false positive costs a
# reader one minute; this costs the whole control.
#
# Measured on the 2026-09-19 run over all 3 public forks, 11 refs were skipped
# this way and are now checked against DECLARED:
#     7  togetherweown[bot]@users.noreply.github.com
#     2  319968614+togetherweown[bot]@users.noreply.github.com
#     1  244704104+togetherweown[bot]@users.noreply.github.com
#     1  engineering@togetherweown.org
#
# Two things that census settles, both of which a guess gets wrong:
#
#   * The numeric prefix is NOT a constant. GitHub's API-authored commits carry
#     `<user-id>+<login>@users.noreply.github.com`, and we have observed TWO
#     distinct ids for the SAME bot login (319968614 and 244704104) -- the App's
#     installation id differs per repo. Pinning the digits, as the reporting
#     card proposed, would have matched neither of them on some repo tomorrow.
#     So the prefix is `([0-9]+\+)?` and the LOGIN carries the identity.
#   * `.org` is ours too. `engineering@togetherweown.org` was missed by the
#     `(com|invalid)` list for no reason other than that nobody had pushed under
#     it when the list was written.
#
# WHY THIS DOES NOT SWALLOW AN EXTERNAL CONTRIBUTOR
#
# `users.noreply.github.com` is the shared privacy domain of EVERY GitHub user,
# so matching that domain alone would call the entire internet "ours" and turn
# the allowlist into a rubber stamp. The discriminator is therefore the LOCAL
# PART, `^`-anchored to our exact bot login, never the domain. The suffix `$`
# binds both arms so a lookalike domain cannot be appended. Verified against a
# table of real external identities taken from this org's own forks -- run
# `--self-test` to re-check it; it is the negative cases that matter, and the
# adversarial near-misses (`eviltogetherweown[bot]@...`,
# `togetherweown[bot]@users.noreply.github.com.evil.tld`) are in there too.
# TOG-3328 review: both arms are `^`-anchored. The first arm used to be bound
# only by `$`, which let anything at all precede the domain -- including a
# second address, so `attacker@evil.com@togetherweown.com` classified as ours.
# `[^@]+` makes the local part exactly one local part.
OUR_AUTHOR_RE="${DISCLOSURE_AUDIT_AUTHOR_RE:-^([^@]+@togetherweown\.(com|org|invalid)|([0-9]+\+)?togetherweown\[bot\]@users\.noreply\.github\.com)$}"

# ---------------------------------------------------------------------------
# --self-test -- the ONLY part of this gate CI can run.
#
# The header explains why the audit proper is not in ci.yml: it needs outbound
# network to api.github.com, and a check that goes green when it measured
# nothing is worse than no check. That reasoning is still right for the audit.
# It is NOT right for the classifier. `OUR_AUTHOR_RE` is a pure function of a
# string, it decides whether a public ref is examined or skipped, and TOG-3327
# is the record of it being silently wrong for an unknown number of months. A
# regex nobody re-evaluates is exactly the artifact that rots, so the table
# below runs offline, deterministically, on every CI run.
#
# The OURS rows are the cheap half. The NOT-OURS rows are the point: every one
# is a real identity observed on this org's own public forks, plus four
# adversarial near-misses. If a future widening makes any NOT-OURS row match,
# the allowlist has silently become a rubber stamp and this fails loudly.
self_test() {
  local ours=(
    'ops@togetherweown.invalid'
    'eng@togetherweown.com'
    'engineering@togetherweown.org'
    'togetherweown[bot]@users.noreply.github.com'
    '319968614+togetherweown[bot]@users.noreply.github.com'
    '244704104+togetherweown[bot]@users.noreply.github.com'
  )
  # Real identities from the 2026-09-19 census, then the near-misses.
  local theirs=(
    'priya@paperclip.ing' 'nicky@paperclip.ing' 'noreply@paperclip.ing'
    '8016841+diegosouzapw@users.noreply.github.com'
    'diegosouzapw@users.noreply.github.com' 'diegosouza.pw@gmail.com'
    '49699333+dependabot[bot]@users.noreply.github.com'
    'vincentkoc@ieee.org' 'steipete@gmail.com' 'tonework@gmail.com'
    '1856877+Rick7C2@users.noreply.github.com' 'bippadotta@protonmail.com'
    'nguyenm7@gmail.com' 'scott.tong@gmail.com'
    'security-engineer@paperclip.local'
    'eviltogetherweown[bot]@users.noreply.github.com'
    'togetherweownxbot@users.noreply.github.com'
    'togetherweown[bot]@users.noreply.github.com.evil.tld'
    'a@togetherweown.com.evil.tld'
    'attacker@evil.com@togetherweown.com'
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
  # A token is optional. Unauthenticated is 60 req/hr for the WHOLE host, which
  # this gate exhausted twice while being written -- and a shared host burns that
  # budget between runs, so the exit-2 path is reached routinely rather than
  # exceptionally. With a token it is 5000/hr and the gate is boringly reliable.
  #
  # The token goes through a 0600 curl config file, NEVER through argv (TOG-3328).
  # `/proc/<pid>/cmdline` is world-readable and every agent on this host shares
  # uid 1000, so `-H "Authorization: Bearer $GH_TOKEN"` publishes the credential
  # to every neighbour for the life of the request -- and `bash -x`, which is how
  # this gate gets debugged, prints it verbatim into a run log. Same pattern as
  # gh_token.sh:229 and gh_permission_pin_audit.sh:382; asserted below by
  # token_argv_test, the way test_gh_scope_residue_monitor.sh:130 asserts it.
  local cfg rc
  [ -n "${GH_TOKEN:-}" ] || { curl -fsSL --max-time 30 "$@" 2>/dev/null; return $?; }
  # umask, not a post-hoc chmod alone: it closes the window between create and
  # write on any platform where mktemp is not already 0600.
  cfg="$(umask 077; mktemp "$TMP/curlcfg.XXXXXXXX")" || return 1
  chmod 0600 "$cfg"
  printf 'header = "Authorization: Bearer %s"\n' "$GH_TOKEN" > "$cfg"
  curl -fsSL --max-time 30 --config "$cfg" "$@" 2>/dev/null
  rc=$?
  rm -f "$cfg"
  return $rc
}

# The other half of what CI can run offline. The regex table above tests a pure
# function of a string; this tests that the CREDENTIAL this gate is meant to run
# with does not end up somewhere a neighbour can read it. It is network-free:
# `curl` is replaced on PATH by a stub that records its argv and exits, so no
# request is made. The positive control matters as much as the argv check -- a
# token that reached nothing at all would otherwise pass the argv assertion
# trivially, which is the shape of a test that cannot fail.
token_argv_test() {
  local probe canary t_pass=0 t_fail=0
  probe="$(umask 077; mktemp -d "$TMP/argv-probe.XXXXXX")" || return 1
  canary='CANARY-not-a-real-token-tog3328'
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

if [ "${1:-}" = '--self-test' ]; then
  st_rc=0
  self_test || st_rc=1
  token_argv_test || st_rc=1
  exit "$st_rc"
fi

# ---------------------------------------------------------------------------
# DECLARED PUBLICATIONS -- the allowlist.
#
# A line here says: these bytes are public ON PURPOSE, their content gate was
# closed BEFORE the push, and here is the card that closed it. Format:
#
#     <repo>|<ref>|<sha>|<card>|<gate-closed-utc>|<note>
#
# An <sha> pin is the point. If the branch is force-pushed to different bytes,
# the declaration stops matching and the gate fails -- a declaration authorizes
# a revision, never a branch name. This mirrors upstream_draft_pins.txt: the
# 2026-08-30 lesson was that an artifact named by anything softer than a digest
# is not actually named.
# ---------------------------------------------------------------------------
DECLARED=$(cat <<'EOF'
paperclip|refs/heads/fix/mcp-gateway-legacy-path-bearer|e949815ac77c96560c6787aec7c70325840a55ce|TOG-1023|2026-09-05T16:04:41Z|Adversarial review TOG-1102 closed 16:04:41Z; pushed 16:30:38Z. Narrowed class per TOG-1094. Added-line scan over the published diff: 0 TOG ids, 0 host URLs, 0 tenant data.
EOF
)

pass=0; fail=0; undeclared=0; unresolved=0; UNRESOLVED_LIST=()
ok()  { printf '  PASS  %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); }

# Read as a STRANGER would. This host installs a broker credential helper for
# github.com (`git config credential.https://github.com.helper`), so a plain
# `git ls-remote` silently authenticates. While writing this gate that made
# the PRIVATE repo TogetherWeOwn/paperclip-ops-tooling answer a "public" read
# with a real sha -- the exact inversion this gate exists to prevent, in the
# direction that matters: it would report bytes as public that are not, and
# (worse) could report a private repo's refs as a publication.
#
# "Is it public" is only answerable with NO credential in the loop, so every
# ref read goes through here.
#
# The env vars alone are NOT sufficient, and that gap was measured, not
# reasoned about. They neutralise SYSTEM and GLOBAL config -- and on this host
# the helper is in /etc/gitconfig, so they do fix the case in front of us. But
# git also reads REPO-LOCAL config, which no environment variable suppresses.
# From inside a checkout carrying `credential.https://github.com.helper` in its
# own .git/config, the vars are set, the read still authenticates, and the
# private repo answers with a sha again. This gate is normally invoked from
# exactly such a checkout. So every anon read is additionally run from a
# NEUTRAL directory outside any repository -- there is no local config to
# inherit there. Belt and braces, because the failure is silent in the
# dangerous direction.
ANON_CWD="$TMP/anon-cwd"; mkdir -p "$ANON_CWD"
anon() {
  ( cd "$ANON_CWD" \
    && GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null \
       GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true \
       GIT_CONFIG_NOSYSTEM=1 "$@" )
}

# Prove the anonymity rather than asserting it. If a future host change makes
# an unauthenticated read succeed against a repo we KNOW is private, every
# "public" verdict below is worthless -- and it would fail open, silently
# reporting private refs as publications. So probe a known-private repo first
# and refuse to report anything if it answers.
#
# Skipped if the probe repo is unreachable for an unrelated reason: the probe
# must not itself become a new way for this gate to be unrunnable offline. We
# distinguish "answered with refs" (fatal) from "no answer" (fine, expected).
#
# The output is CAPTURED and then tested -- deliberately not piped into
# `grep -q`. Under `set -o pipefail`, `grep -q` exits at the first matching
# line, git dies of SIGPIPE (141), and pipefail reports the PIPELINE as
# failed -- so `if ... | grep -q .` evaluates FALSE precisely when refs WERE
# returned. That is this check inverted: it would skip itself silently in the
# one case it exists to catch. Measured, not theorised -- the piped form was
# written first and failed open 3 runs out of 3 against a repo that answers
# with 233 refs. A self-check that cannot fail is decoration.
ANON_PROBE="${DISCLOSURE_AUDIT_PRIVATE_PROBE:-$ORG/paperclip-ops-tooling}"
probe_refs="$(anon git ls-remote "https://github.com/$ANON_PROBE.git" 'refs/heads/*' 2>/dev/null || true)"
if [ -n "$probe_refs" ]; then
  printf 'cannot evaluate: the anonymous read path is NOT anonymous.\n'
  printf '   %s is private, yet an unauthenticated ls-remote returned refs.\n' "$ANON_PROBE"
  printf '   Every public/private verdict this gate makes would be unreliable,\n'
  printf '   so it refuses to make any. Two known causes, in likelihood order:\n\n'
  # Cause 1 was MEASURED on 2026-09-19 under PAPERCLIP_GITHUB_AUTH_MODE=managed
  # and is now the common one, so it leads. The old text named only cause 2,
  # which sent a reader hunting a credential.helper that is not there: the
  # helper is irrelevant when `git` itself is a wrapper. `anon()` neutralises
  # git CONFIG at all three levels, and no amount of config-neutralising
  # reaches a different binary earlier on PATH.
  printf '   1. `git` on PATH is a credential-injecting wrapper, not git.\n'
  printf '      Check:  command -v git      (currently: %s)\n' "$(command -v git)"
  printf '      On a Paperclip managed-GitHub run, BASH_ENV re-exports a PATH\n'
  printf '      whose first entry holds that wrapper -- so it comes back in\n'
  printf '      every non-interactive bash, even one you launched with a\n'
  printf '      cleaned PATH. Re-run with the wrapper genuinely out of reach:\n'
  printf "         env -u BASH_ENV PATH=/usr/bin:/bin GH_TOKEN=\"\$GH_TOKEN\" bash %s\n" "$0"
  printf '   2. A credential.helper is configured for github.com in git config\n'
  printf '      (system/global/local). Check:  git config --get-regexp credential\n'
  exit 2
fi

# api() and TMP are defined above the --self-test dispatch, so the self-test can
# exercise the real api() offline without reaching the anonymity probe below.

# The fork -> parent map is IMMUTABLE (a repo's parent never changes) and it is
# the only thing the REST API is needed for. Cache it, so a re-run costs zero
# API calls and the 60/hr unauthenticated budget stops being the binding
# constraint on how often this can be checked. Refresh by deleting the file, or
# automatically when a fork appears in the org listing that the cache lacks.
CACHE="${DISCLOSURE_AUDIT_CACHE:-$(dirname "$0")/.tog-1014-fork-parents.cache}"

printf '== enumerating public repos in org %s\n\n' "$ORG"

if ! api "$API/orgs/$ORG/repos?per_page=100&type=public" > "$TMP/repos.json"; then
  printf 'cannot evaluate: GitHub API unreachable or rate-limited (org listing)\n'
  # Say WHICH, because they need different responses: wait vs fix the network.
  # Unauthenticated core limit is 60/hr for the whole host, so a busy host can
  # exhaust it between runs and the operator should not go hunting a net fault.
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

# repo_name<TAB>parent_full_name  -- forks only; a non-fork org repo is our own
# project, not a vendor disclosure surface, and is out of scope here.
python3 - "$TMP/repos.json" > "$TMP/forks.tsv" <<'PY'
import json,sys
for r in json.load(open(sys.argv[1])):
    if r.get("fork") and r.get("visibility") == "public":
        print(f"{r['name']}\t{(r.get('parent') or {}).get('full_name') or ''}")
PY

# The org listing omits `parent`; fill it in per-repo. A fork whose parent we
# cannot resolve is exit 2, not a skip -- we cannot diff against an unknown base.
: > "$TMP/forks_resolved.tsv"
while IFS=$'\t' read -r name parent; do
  [ -n "$name" ] || continue
  # Cache hit? (immutable, so a hit is always valid)
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
    if [ -n "$parent" ]; then
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
  # An empty ref listing means the remote answered with nothing, which for a
  # fork of a live repo means the read failed rather than that it is empty.
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

  # Authorship is resolved with git, NOT the REST API. The first draft made one
  # `GET /commits/{sha}` per candidate ref; on the paperclip fork that is 8 calls,
  # and unauthenticated GitHub allows 60/hour for the whole host. It exhausted the
  # budget mid-run and exited 2 with "could not read commit" -- technically the
  # correct exit code, but a message that blames the commit for a quota problem.
  # A single shallow fetch of the candidate refs costs one network round trip,
  # has no rate limit, and reads the same authorship bytes.
  cutrefs=$(cut -f2 "$TMP/candidates.tsv")
  if [ -n "$cutrefs" ]; then
    rm -rf "$TMP/bare"; git init -q --bare "$TMP/bare"
    # shellcheck disable=SC2086
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
      # TOG-3327, second finding. Authorship is ONE signal and the header is
      # honest that it is a triage key, not a control. Fixing the bot-identity
      # blind spot above exposed a residual class it cannot reach: refs whose
      # BRANCH NAME carries one of our own card ids while the author email is
      # someone we cannot claim -- e.g. `tog-2545-ci-hygiene` authored by
      # `security-engineer@paperclip.local`, or `rollback/tog-2372-paperclip-*`
      # by a personal gmail address. A vendor does not name a branch after a
      # TOG card. These are probably ours, pushed under a mis-set identity.
      #
      # They are NOT auto-claimed. Widening the author regex to swallow a
      # personal gmail address is precisely the 6-false-positive mistake the
      # header records, and `paperclip.local` is one edit away from the
      # vendor's own `paperclip.ing`. Provenance here has to be adjudicated by
      # a human, per ref, once -- not pattern-matched.
      #
      # So: print loudly, count separately, and leave the exit code alone.
      # Silence was the actual defect; an unresolved item that names itself in
      # the summary is not silent.
      #
      # ARMED 2026-09-20 (TOG-3329): strict is now the DEFAULT. Every ref in
      # this class has been adjudicated (all removed from the public forks or
      # confirmed upstream), so a NEW unresolved ref is a regression that must
      # fail the gate, not warn. Set DISCLOSURE_AUDIT_STRICT_UNRESOLVED=0 to
      # opt out temporarily (e.g. mid-adjudication of a fresh finding).
      if grep -qEi 'tog-?[0-9]{3,}' <<<"$ref"; then
        unresolved=$((unresolved+1))
        UNRESOLVED_LIST+=("$name $ref @ ${sha:0:10} author=$email")
        printf '   ????? %-8s %s\n           UNRESOLVED -- author (%s) is not ours, but the ref\n' \
          "$kind" "$ref" "$email"
        printf '           name carries a TOG card id. A vendor does not name a branch\n'
        printf '           after our card. Adjudicate: declare it, or confirm it is theirs.\n'
        printf '           %s\n' "https://github.com/$ORG/$name/tree/${ref#refs/heads/}"
        continue
      fi
      printf '   ..... %-8s %s\n           upstream-authored (%s) -- not ours\n' "$kind" "$ref" "$email"
      continue
    fi

    # Ours and public. It must be declared above, pinned to this exact sha.
    if grep -qF "$name|$ref|$sha|" <<<"$DECLARED"; then
      card=$(printf '%s\n' "$DECLARED" | grep -F "$name|$ref|$sha|" | cut -d'|' -f4)
      ok "$name $ref @ ${sha:0:10} -- PUBLIC, declared ($card)"
    else
      undeclared=$((undeclared+1))
      bad "$name $ref @ ${sha:0:10} -- PUBLIC AND UNDECLARED"
      printf '           author %s\n           subject %s\n' "$email" "$subj"
      printf '           %s\n' "https://github.com/$ORG/$name/tree/${ref#refs/heads/}"
      # A branch declared at a DIFFERENT sha is the force-push case; say so,
      # because "undeclared" alone would read as a brand-new branch.
      #
      # But distinguish a force-push from a MALFORMED declaration first. The
      # first draft declared this very branch with an ABBREVIATED sha and the
      # gate reported "DIFFERENT bytes (force-push?)" -- pointing at the same
      # commit it was already looking at. Failing was right (a pin must be
      # exact, per the upstream_draft_pins.txt lesson) but the DIAGNOSIS sent
      # the reader hunting a force-push that never happened. A gate that fails
      # for the right reason with the wrong explanation still costs a run.
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
    fi
  done < "$TMP/candidates.tsv"
  printf '\n'
done < "$TMP/forks_resolved.tsv"

# A declaration for bytes that are no longer public is stale, not a failure --
# the branch may have been deleted after filing. Report it so the file gets
# pruned, but do not fail: the gate's job is to catch UNDECLARED publication.
while IFS='|' read -r drepo dref dsha dcard drest; do
  [ -n "${drepo:-}" ] || continue
  if ! anon git ls-remote "https://github.com/$ORG/$drepo.git" "$dref" 2>/dev/null | grep -q "$dsha"; then
    printf 'NOTE: declared %s %s @ %s (%s) is no longer at that sha -- prune or re-pin\n' \
      "$drepo" "$dref" "${dsha:0:10}" "$dcard"
  fi
done <<< "$DECLARED"

printf '== %s declared/clean, %s undeclared publication(s), %s unresolved\n' \
  "$pass" "$undeclared" "$unresolved"

if [ "$unresolved" -ne 0 ]; then
  printf '\nUNRESOLVED (%s) -- ref named for a TOG card, author not ours:\n' "$unresolved"
  printf '   %s\n' "${UNRESOLVED_LIST[@]}"
  printf 'Each needs a one-time provenance ruling: add to DECLARED (with the card\n'
  printf 'whose gate closed before the push), or confirm it is genuinely upstream.\n'
  if [ "${DISCLOSURE_AUDIT_STRICT_UNRESOLVED:-1}" != "0" ]; then
    printf 'FAIL: strict mode (default; DISCLOSURE_AUDIT_STRICT_UNRESOLVED!=0) and %s ref(s) are unadjudicated.\n' "$unresolved"
    exit 1
  fi
fi

if [ "$fail" -ne 0 ]; then
  printf 'FAIL: bytes of ours are public without a declared, gate-closed provenance.\n'
  printf 'Either add a line to DECLARED naming the card whose content gate closed\n'
  printf 'BEFORE the push, or delete the branch from the public fork.\n'
  exit 1
fi
printf 'PASS: every public byte of ours is declared and gate-closed.\n'
exit 0
