#!/usr/bin/env bash
# TOG-233 — does the LIVE OmniRoute gateway 502 a valid truncated reasoning
# response, and which surfaces are affected?
#
# WHY THIS EXISTS SEPARATELY FROM tog-233-truncated-reasoning-502.sh
#
# That script executes the shipped npm packages: hermetic, credential-free, safe
# in CI. It answers "is the bug in the code?". It cannot answer "is the bug in
# OUR gateway today?" — and on 2026-09-03 those had drifted apart: the issue was
# written against 3.8.49, 3.8.50 shipped a partial fix, and nobody had checked
# which version was actually deployed. This script answers that, and it needs a
# real key, so it is opt-in and NOT wired into CI.
#
# It is read-only: it sends chat completions and reads response headers. It
# never touches the management port and changes no gateway state.
#
# Usage:
#   OMNIROUTE_API_KEY=... [OMNIROUTE_URL=http://omniroute:20129] \
#     verification/tog-233-live-gateway-probe.sh [model]
#
# Exit 0 = no 502 observed on any probed max_tokens (defect absent/fixed).
# Exit 1 = at least one 502 -> the defect is live; read the table.
# Exit 2 = could not run (no key, gateway unreachable, bad response).

set -uo pipefail

URL="${OMNIROUTE_URL:-http://omniroute:20129}"
MODEL="${1:-openrouter/openai/gpt-oss-20b}"
KEY="${OMNIROUTE_API_KEY:-${ANTHROPIC_AUTH_TOKEN:-${ANTHROPIC_API_KEY:-}}}"

if [ -z "$KEY" ]; then
  echo "FATAL: set OMNIROUTE_API_KEY (or ANTHROPIC_AUTH_TOKEN/ANTHROPIC_API_KEY)." >&2
  exit 2
fi
command -v curl   >/dev/null || { echo "FATAL: curl not found"   >&2; exit 2; }
command -v python3 >/dev/null || { echo "FATAL: python3 not found" >&2; exit 2; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

say() { printf '%s\n' "$*"; }

# ------------------------------------------------- which version is running --
# Read it off the wire. A deployed version is a fact about the running system;
# never infer it from a changelog or a lockfile.
hdrs="$WORK/h.txt"
curl -sS -D "$hdrs" -o "$WORK/probe.json" --max-time 120 \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"say ok\"}],\"max_tokens\":300,\"stream\":false}" \
  "$URL/v1/chat/completions" >/dev/null 2>&1 || { say "FATAL: cannot reach $URL"; exit 2; }

VER=$(grep -i '^x-omniroute-version:' "$hdrs" | tr -d '\r' | awk '{print $2}')
say "TOG-233 — live gateway probe"
say "  url     : $URL"
say "  model   : $MODEL"
say "  version : ${VER:-<no x-omniroute-version header>}"
say ""

# The control must pass, or the rest of the table means nothing.
CTRL=$(python3 -c "
import json,sys
try:
    d=json.load(open('$WORK/probe.json'))
    print((d.get('choices') or [{}])[0].get('finish_reason'))
except Exception: print('ERR')
")
if [ "$CTRL" = "ERR" ]; then
  say "FATAL: control request (max_tokens=300) did not return a usable completion."
  head -c 400 "$WORK/probe.json"; exit 2
fi

# --------------------------------------------- sweep the Chat Completions --
say "=== POST /v1/chat/completions (non-stream) ==="
say "  max_tokens |  http | finish_reason | content | reasoning"
rc=0
for MT in 8 16 32 64 128 300; do
  code=$(curl -sS -o "$WORK/b.json" -w '%{http_code}' --max-time 120 \
    -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
    -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"say ok\"}],\"max_tokens\":$MT,\"stream\":false}" \
    "$URL/v1/chat/completions")
  [ "$code" = "502" ] && rc=1
  python3 - "$MT" "$code" "$WORK/b.json" <<'PY'
import json,sys
mt,code,f=sys.argv[1],sys.argv[2],sys.argv[3]
fr=c=r='-'
try:
    d=json.load(open(f)); ch=(d.get('choices') or [{}])[0]; m=ch.get('message') or {}
    if ch.get('finish_reason') is not None:
        fr=str(ch['finish_reason']); c=str(len(m.get('content') or '')); r=str(len(m.get('reasoning') or ''))
except Exception: pass
print(f"  {mt:>10} |  {code}  | {fr:<13} | {c:>7} | {r}")
PY
  sleep 1
done
say ""

# ------------------------------- what did upstream ACTUALLY send at mt=16? --
# stream:true does not route through detectMalformedNonStream, so it reveals
# the real body behind the 502. This is what turns "we got a 502" into "the
# detector manufactured the 502".
say "=== same request, stream:true (bypasses detectMalformedNonStream) ==="
curl -sS -o "$WORK/s.txt" --max-time 120 \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"say ok\"}],\"max_tokens\":16,\"stream\":true}" \
  "$URL/v1/chat/completions" >/dev/null 2>&1
python3 - "$WORK/s.txt" <<'PY'
import json,sys
content=reasoning=''; fr=None
for line in open(sys.argv[1]):
    line=line.strip()
    if not line.startswith('data:'): continue
    p=line[5:].strip()
    if p=='[DONE]': break
    try: d=json.loads(p)
    except Exception: continue
    for ch in d.get('choices') or []:
        delta=ch.get('delta') or {}
        content+=delta.get('content') or ''; reasoning+=delta.get('reasoning') or ''
        if ch.get('finish_reason'): fr=ch['finish_reason']
print(f"  finish_reason = {fr!r}")
print(f"  content   ({len(content)}): {content!r}")
print(f"  reasoning ({len(reasoning)}): {reasoning[:80]!r}")
if fr=='length' and not content and reasoning:
    print("  -> valid truncated reasoning turn; any 502 above was manufactured by the detector.")
PY
say ""

# ------------------------------------- does the Messages surface share it? --
# Scopes the blast radius. Claude Code agent bindings use this surface, so a
# clean result here means agent traffic is NOT exposed on its normal path.
say "=== POST /v1/messages (Anthropic surface — scopes blast radius) ==="
for MT in 8 16 32; do
  code=$(curl -sS -o "$WORK/m.json" -w '%{http_code}' --max-time 120 \
    -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -H 'anthropic-version: 2023-06-01' \
    -d "{\"model\":\"$MODEL\",\"max_tokens\":$MT,\"messages\":[{\"role\":\"user\",\"content\":\"say ok\"}]}" \
    "$URL/v1/messages")
  say "  max_tokens=$MT -> HTTP $code"
  sleep 1
done
say ""

if [ "$rc" -eq 0 ]; then
  say "RESULT: no 502 on any probed max_tokens — defect absent on ${VER:-this version}."
else
  say "RESULT: the truncated-reasoning 502 is LIVE on ${VER:-this version} (rc=$rc)."
fi
exit "$rc"
