#!/usr/bin/env bash
# ===========================================================================
# test_gh_shim.sh — regression suite for gh-shim.
#
# gh-shim is the `gh` CLI wrapper installed in a per-user bin directory,
# ahead of /usr/bin on PATH. It mints a fresh GitHub App installation token
# per invocation by shelling out to gh-app-token.js, then execs the real gh.
#
# The defect this guards against: the shim used to gate minting on
# GH_APP_PRIVATE_KEY being present in the environment —
#   if [ -z "${GH_TOKEN:-}" ] && [ -z "${GITHUB_TOKEN:-}" ] && [ -n "${GH_APP_PRIVATE_KEY:-}" ]; then
# — which is backwards: gh-app-token.js already does its own broker-first,
# PEM-fallback selection. Once an agent's environment stops binding
# GH_APP_PRIVATE_KEY (the credential-unbind cutover), that condition would
# silently skip minting altogether and hand `gh` no token at all, while
# `git push` (a different credential path) kept working. The hand-fix on the
# running instance already removed the PEM clause; this suite is what stops a
# re-bootstrap from reintroducing it.
#
# Since /usr/bin/gh is not something this suite can safely overwrite (and may
# not even be writable), each behavioral test stages a COPY of the tracked
# gh-shim and retargets only the REAL_GH constant to a local stub via sed —
# not the logic under test, an unrelated dependency swap, matching this
# repo's own staged-copy testing convention (see test_credential_chain_pin_gate.sh).
# `node` is stubbed via PATH order to simulate gh-app-token.js's mint
# succeeding or failing, since the shim invokes `node` bare (PATH-resolved),
# not by absolute path.
#
# Exit: 0 all assertions passed | 1 something failed
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE" || exit 1

SHIM="$HERE/gh-shim"
[[ -r "$SHIM" ]] || { echo "ERROR: missing gh-shim; cannot test it" >&2; exit 1; }

PASS=0
FAIL=0

hdr() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()  { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m  %s\n' "$*"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m  %s\n' "$*"; }

TMP="$(mktemp -d "${PAPERCLIP_RUN_SCRATCH_DIR:-${TMPDIR:-/tmp}}/gh-shim-XXXXXX")" || exit 1
trap 'rm -rf "$TMP"' EXIT

# --- static checks -----------------------------------------------------------
hdr "static checks"

if bash -n "$SHIM" 2>/dev/null; then
  ok "gh-shim parses as valid bash"
else
  bad "gh-shim does not parse"
fi

# Comments may document the removed PEM-gate history; only CODE must never
# reference GH_APP_PRIVATE_KEY again. Herestring, not a pipe into grep -q: under
# pipefail a pipe can report the producer's SIGPIPE instead of the match result.
if grep -q 'GH_APP_PRIVATE_KEY' <<<"$(grep -v '^\s*#' "$SHIM")"; then
  bad "gh-shim code still references GH_APP_PRIVATE_KEY — the PEM gate is back"
else
  ok "gh-shim code does not gate minting on GH_APP_PRIVATE_KEY"
fi

if grep -qE 'if \[ -z "\$\{GH_TOKEN:-\}" \] && \[ -z "\$\{GITHUB_TOKEN:-\}" \]; then' "$SHIM"; then
  ok "explicit-token-wins guard is present and unconditional"
else
  bad "explicit-token-wins guard is missing or has grown extra conditions"
fi

# --- behavioral setup ---------------------------------------------------------
# Each staged dir gets: a copy of gh-shim with REAL_GH retargeted to a local
# stub `gh`, plus a stub `node` earlier on PATH standing in for gh-app-token.js.
stage() {
  local d="$1"
  mkdir -p "$d/bin"
  cp "$SHIM" "$d/gh-shim"
  sed -i "s|^REAL_GH=/usr/bin/gh\$|REAL_GH=$d/bin/real-gh|" "$d/gh-shim"
  chmod +x "$d/gh-shim"

  cat > "$d/bin/real-gh" <<'EOF'
#!/usr/bin/env bash
echo "real-gh ran: GH_TOKEN=${GH_TOKEN:-<unset>} args=$*"
EOF
  chmod +x "$d/bin/real-gh"
}

run_shim() {
  local d="$1"; shift
  env -i PATH="$d/bin:/usr/bin:/bin" HOME="$d" "$d/gh-shim" "$@"
}

# --- test 1: mints without GH_APP_PRIVATE_KEY (the removed-PEM-gate regression) -
hdr "mints a token when only GH_TOKEN/GITHUB_TOKEN/GH_APP_PRIVATE_KEY are all unset"
D1="$TMP/mints-without-pem"; stage "$D1"
cat > "$D1/bin/node" <<'EOF'
#!/usr/bin/env bash
echo "minted-token-abc123"
EOF
chmod +x "$D1/bin/node"

out="$(run_shim "$D1" pr status 2>&1)"
if grep -q 'GH_TOKEN=minted-token-abc123' <<<"$out"; then
  ok "shim minted a token with GH_APP_PRIVATE_KEY unset"
else
  bad "shim did not mint without GH_APP_PRIVATE_KEY set (got: $out)"
fi

# --- test 2: explicit GH_TOKEN always wins, mint is never attempted ----------
hdr "an explicit GH_TOKEN is never overridden by a mint attempt"
D2="$TMP/explicit-token-wins"; stage "$D2"
cat > "$D2/bin/node" <<'EOF'
#!/usr/bin/env bash
echo "should-not-be-called" >&2
exit 1
EOF
chmod +x "$D2/bin/node"

out="$(env -i PATH="$D2/bin:/usr/bin:/bin" HOME="$D2" GH_TOKEN="caller-supplied-token" "$D2/gh-shim" pr status 2>&1)"
if grep -q 'GH_TOKEN=caller-supplied-token' <<<"$out"; then
  ok "explicit GH_TOKEN passed through unchanged"
else
  bad "explicit GH_TOKEN was not preserved (got: $out)"
fi
if grep -q 'should-not-be-called' <<<"$out"; then
  bad "shim invoked node/mint despite an explicit GH_TOKEN being set"
else
  ok "shim did not attempt to mint when GH_TOKEN was already set"
fi

# --- test 3: a failed mint falls through cleanly, gh still runs -------------
hdr "a failed mint falls through to an unauthenticated gh, not a crash"
D3="$TMP/failed-mint-falls-through"; stage "$D3"
cat > "$D3/bin/node" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$D3/bin/node"

out="$(run_shim "$D3" pr status 2>&1)"; rc=$?
if [[ $rc -eq 0 ]] && grep -q 'GH_TOKEN=<unset>' <<<"$out"; then
  ok "failed mint left GH_TOKEN unset and still exec'd the real gh"
else
  bad "failed mint did not fall through cleanly (rc=$rc, got: $out)"
fi

printf '\n\033[1mRESULT: %d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
