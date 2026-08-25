#!/usr/bin/env bash
# =====================================================================================
# dropchannel_scan.sh — operator-run redaction scanner for /paperclip/operator-handoff
#
# TOG-151 (Phase 1b, follow-on). Proposal for operator review — NOT a deployment.
# Author: Chief Security & Trust Officer / CISO agent, 2026-08-23.
#
# WHY THIS EXISTS
#   /paperclip/operator-handoff is the one path agents can write and the operator can
#   read. It is world-readable to every agent on this box, so a secret written there is
#   disclosed to every company on the instance the moment it lands. The allowlist inside
#   omniroute_snapshot.py is the primary control; this is the independent check that the
#   control held. It is standalone, not a combo-CLI subcommand, because the CLI is about
#   combos and this is about a shared filesystem boundary — it must stay runnable when
#   nobody is touching combos.
#
#   Operator instruction, 2026-08-23: scan the WHOLE directory, not just
#   omniroute-snapshots.jsonl, and exit non-zero on a hit so it is cron-able and
#   CI-able the same way org_access_review.sh is.
#
# ------------------------------------------------------------------------------------
# WHAT THIS REFUSES TO DO, AND WHY IT MATTERS
# ------------------------------------------------------------------------------------
#   1. It never prints a matched value. Findings carry a rule id, a length, a SHA-256
#      fingerprint prefix and at most 3 leading characters. A scanner that echoes the
#      secret it found turns a cron mail or a CI log into a second copy of the leak.
#   2. It never follows a symlink. The channel is mode 0777 (see FINDING-A below), so a
#      symlink in it is attacker-controlled and could aim the scanner — or the operator's
#      `cat` — at /proc/self/environ or an omniroute.env on the host side of the mount.
#      Symlinks are reported as findings, not traversed.
#   3. It fails CLOSED. An unreadable file, an oversized file, a decode failure — each is
#      a FAIL finding, never a silent skip. "0 findings" must mean "I read everything and
#      found nothing", not "I found nothing in the part I could read".
#   4. It writes nothing. No cache, no report file, no state. Output is stdout only.
#
# ------------------------------------------------------------------------------------
# FINDING-A — the channel is world-writable, and this scanner cannot fix it
# ------------------------------------------------------------------------------------
#   Measured 2026-08-23, not assumed:
#
#     /paperclip/operator-handoff  ->  drwxrwxrwx root:root  (0777, NO sticky bit)
#     TOG-151-omniroute_combo_cli.sh -> -rwxr-xr-x node:node
#     every agent on this instance runs as uid 1000(node)
#
#   Two consequences, both demonstrated rather than reasoned:
#     - Any agent can overwrite the combo CLI in place. It is owned by the same uid every
#       agent runs as. The operator then executes it on the host with a manage-scoped
#       OmniRoute key.
#     - Any agent can unlink or rename ANY entry here, including the root-owned REFERENCE
#       files. Without a sticky bit, deletion is governed by directory write permission;
#       the file's own mode is irrelevant. Probed with a 0400 file: unlink succeeded.
#
#   So the drop channel is an unauthenticated input to an operator-run, credential-bearing
#   command. The scanner reports drift (`verify`), but the real control is out of its
#   reach and belongs to the operator: compare the SHA-256 against the value published in
#   the Paperclip issue thread before running anything from here. The issue thread is the
#   only channel in this loop that an agent on this box cannot rewrite.
#
# ------------------------------------------------------------------------------------
# FINDING-B — owner-write IS cross-agent write here, and the check above cannot see it
# (TOG-344, split out of TOG-219; fixed 2026-08-24)
# ------------------------------------------------------------------------------------
#   FINDING-A's check fires on any write bit OUTSIDE the owner with no sticky bit. That
#   predicate is correct on a normal multi-user host. On this box it is structurally
#   blind, because EVERY AGENT RUNS AS uid 1000(node). Owner-write is the entire
#   cross-agent exposure, and the check never looked at it. Reproduced:
#
#     $ mkdir -p sim/<agent-id> && chmod 0755 sim/<agent-id>   # drwxr-xr-x node node
#     $ dropchannel_scan.sh scan --root sim/<agent-id>
#     CLEAN — every file read in full, no findings.            rc=0
#     $ [ -w sim/<agent-id>/probe.md ] && echo owner-writable  # ... and every agent IS
#     owner-writable                                           #     the owner
#
#   Same shape as the root:node 0775 hole FINDING-A closed — a mode that reads like a
#   tightening and is not — one level further in. It mattered immediately: the original
#   TOG-219 proposal was per-agent subdirectories, which would have produced exactly
#   this, a node-owned directory reporting CLEAN while writable by every agent on the
#   instance. TOG-219 was re-scoped partly on this finding.
#
#   COROLLARY, and it removes a control from the list: the sticky bit provides ZERO
#   protection between agents here. Sticky permits unlink/rename by the FILE'S OWNER;
#   every agent-authored file is node:node; so any agent can unlink, rename or replace
#   any other agent's file in a 1777 channel. Only root-owned entries are protected.
#   Sticky is doing work against nothing on this host.
#
#   WHAT THE FIX DOES
#     - Under a shared uid, any directory in the scan not owned by root is a FAIL,
#       regardless of mode. Root ownership is the only mode that closes it.
#     - The agent-owned FILES are reported once, in aggregate, at REVIEW — not once per
#       file. Sixty findings that are all the same structural fact is how a scanner
#       teaches its operator to ignore it. The fingerprint is bound to the CONDITION,
#       not the file count, so one acknowledgement stays valid while the condition does
#       and stops applying the moment the box is no longer shared-uid.
#     - Detection is auto (one interactive non-system account in the passwd database),
#       overridable with DROPSCAN_SHARED_UID, and the verdict plus its reason is PRINTED
#       on every non-quiet run. A check that silently turns itself off is the bug being
#       fixed here, so an unreadable passwd database is a FAIL finding, not a default.
#
#   This is a DETECTION fix only. The root cause is the shared runtime uid, it is not an
#   agent-fixable condition, and it belongs to the platform vendor — tracked in TOG-191.
#   The scanner's job is to stop reporting CLEAN over it.
#
# ------------------------------------------------------------------------------------
# PATTERN SELF-REFERENCE — why the rules are assembled from fragments
# ------------------------------------------------------------------------------------
#   A credential scanner that stores its own patterns as literals flags itself the moment
#   it is placed in the directory it scans. The usual fix is to exclude self by path,
#   which is worse: it creates one filename in the channel that is never scanned, in a
#   directory any agent can write. So every rule here is CONCATENATED AT RUNTIME from
#   fragments, no token-shaped literal appears in this file, and the scanner scans itself
#   like any other file. The selftest asserts both halves of that: this file scans clean,
#   AND a copy of this file with a secret planted in it is caught.
#
# ------------------------------------------------------------------------------------
# EXIT CODES  (non-zero on any hit, per the operator's cron requirement)
# ------------------------------------------------------------------------------------
#   0  clean — every file read in full, no findings
#   1  FAIL findings     — credential-shaped value, or a file that could not be scanned
#   2  REVIEW findings only — high-entropy strings a human must rule on
#   3  refusal / usage error
#   4  operational error (missing interpreter, unreadable root)
#
# ------------------------------------------------------------------------------------
# USAGE
#   ./dropchannel_scan.sh scan [--root DIR] [--strict] [--quiet]
#   ./dropchannel_scan.sh selftest
#   ./dropchannel_scan.sh manifest [--root DIR]      # emit SHA-256 manifest to stdout
#   ./dropchannel_scan.sh verify --manifest FILE [--root DIR]
#   ./dropchannel_scan.sh help
#
#   --strict   treat REVIEW findings as FAIL (exit 1). Use in CI once the channel is
#              quiet; leave off for cron so entropy noise does not mask a real hit.
#
# ENVIRONMENT
#   DROPSCAN_ROOT            default /paperclip/operator-handoff
#   DROPSCAN_ALLOWLIST_FILE  fingerprints to suppress, one per line: <fp12> # reason
#                            Suppressions are COUNTED AND PRINTED, never silent.
#   DROPSCAN_MAX_BYTES       per-file read cap, default 33554432 (32 MiB). Exceeding it
#                            is a FAIL finding, not a truncation.
#   DROPSCAN_SHARED_UID      1 | 0 | auto (default auto). See FINDING-B. `auto` reads the
#                            passwd database and calls it shared when exactly ONE
#                            interactive non-system account exists. The verdict and its
#                            reason are printed on every non-quiet run — this check is
#                            never silently on or silently off.
#   DROPSCAN_PASSWD_FILE     account database for auto-detect, default /etc/passwd.
#                            Exists so the selftest can exercise both verdicts offline
#                            instead of inheriting the host's answer.
#
# CRON (operator; note the 0600 redirect — findings are not world-readable)
#   17 * * * * /path/dropchannel_scan.sh scan >> ~/dropscan.log 2>&1
# =====================================================================================
set -euo pipefail

c_red() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
c_grn() { printf '\033[32m%s\033[0m\n' "$*" >&2; }
c_ylw() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
log()   { printf '%s\n' "$*" >&2; }
die()    { c_red "FATAL: $*"; exit 4; }
refuse() { c_red "REFUSED: $*"; exit 3; }

need() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }

# -------------------------------------------------------------------------------------
# Temp-file cleanup.
#
# [RESOLVED-S1] This was `trap 'rm -rf "$tmp"' RETURN` with `tmp` declared `local`. Bash
# tears locals down BEFORE the RETURN trap fires, so under `set -u` the trap referenced
# an unbound variable, failed, and THAT failure became the function's exit status. The
# result was the exact inverse of a silent success:
#
#     selftest: 33 passed, 0 failed          <- printed
#     $? = 1                                 <- returned
#     VERIFIED — channel matches the manifest <- printed, in green
#     $? = 1                                 <- returned
#
# The screen said one thing and the exit code said the opposite. For `verify` that is
# security-relevant: the exit code IS the tamper signal, so an unmodified channel
# reported drift, and anyone who wired it into cron would have learned to ignore it.
# A registry plus one EXIT trap at the top level has no scoping problem and also cleans
# up on the `set -e` abort paths the RETURN trap never covered.
# -------------------------------------------------------------------------------------
_DROPSCAN_TMP=""
_dropscan_cleanup() { local d; for d in $_DROPSCAN_TMP; do [ -n "$d" ] && rm -rf "$d"; done; }
trap _dropscan_cleanup EXIT
mk_tmpdir()  { local d; d="$(mktemp -d)"; _DROPSCAN_TMP="$_DROPSCAN_TMP $d"; printf '%s' "$d"; }
mk_tmpfile() { local f; f="$(mktemp)";    _DROPSCAN_TMP="$_DROPSCAN_TMP $f"; printf '%s' "$f"; }

DROPSCAN_ROOT="${DROPSCAN_ROOT:-/paperclip/operator-handoff}"
DROPSCAN_ALLOWLIST_FILE="${DROPSCAN_ALLOWLIST_FILE:-}"
DROPSCAN_MAX_BYTES="${DROPSCAN_MAX_BYTES:-33554432}"
DROPSCAN_SHARED_UID="${DROPSCAN_SHARED_UID:-auto}"
DROPSCAN_PASSWD_FILE="${DROPSCAN_PASSWD_FILE:-/etc/passwd}"
STRICT=0
QUIET=0

# -------------------------------------------------------------------------------------
# The scan engine.
#
# Python rather than grep: the entropy rule needs real arithmetic, binary files need
# printable-run extraction rather than a skip, and `grep -P` is not guaranteed present.
# The bash wrapper keeps the shape of org_provisioner.sh and owns the exit codes.
#
# Everything below reads config from the environment. Nothing is passed in argv —
# /proc/*/cmdline is world-readable and every company shares this host.
# -------------------------------------------------------------------------------------
run_engine() {
  ROOT="$1" MODE="${2:-scan}" python3 - <<'PYEOF'
import hashlib, math, os, re, sys

ROOT      = os.environ["ROOT"]
STRICT    = os.environ.get("STRICT") == "1"
QUIET     = os.environ.get("QUIET") == "1"
MAXB      = int(os.environ.get("DROPSCAN_MAX_BYTES", "33554432"))
ALLOWFILE = os.environ.get("DROPSCAN_ALLOWLIST_FILE", "")
SUID_ENV  = (os.environ.get("DROPSCAN_SHARED_UID") or "auto").strip().lower()
PASSWDF   = os.environ.get("DROPSCAN_PASSWD_FILE") or "/etc/passwd"

# --- shared-uid detection (FINDING-B) -------------------------------------------------
# Read the account database instead of assuming either answer. "One interactive
# non-system account" is the signal: it means every process on the box that is not a
# daemon is the SAME uid, so file ownership stops separating anyone from anyone.
# System accounts are excluded by uid range, and nologin/false shells are excluded
# because a service account cannot be the uid an agent runs work as.
def detect_shared_uid(path):
    accounts = []
    with open(path, "r", errors="replace") as fh:
        for raw in fh:
            parts = raw.rstrip("\n").split(":")
            if len(parts) < 7:
                continue
            try:
                uid = int(parts[2])
            except ValueError:
                continue
            shell = parts[6]
            if uid < 1000 or uid == 65534:
                continue
            if shell.endswith("nologin") or shell.endswith("/false"):
                continue
            accounts.append((parts[0], uid))
    if len(accounts) == 1:
        return True, (f"{path} lists exactly one interactive non-system account "
                      f"({accounts[0][0]}, uid {accounts[0][1]}) — every agent is that uid")
    names = ", ".join(n for n, _ in accounts) or "none"
    return False, f"{path} lists {len(accounts)} interactive non-system accounts ({names})"

SHARED_UID = False
SUID_WHY   = ""
SUID_ERR   = ""
if SUID_ENV in ("1", "true", "yes", "on"):
    SHARED_UID, SUID_WHY = True, f"forced ON by DROPSCAN_SHARED_UID={SUID_ENV}"
elif SUID_ENV in ("0", "false", "no", "off"):
    SHARED_UID, SUID_WHY = False, f"forced off by DROPSCAN_SHARED_UID={SUID_ENV}"
elif SUID_ENV == "auto":
    try:
        SHARED_UID, why = detect_shared_uid(PASSWDF)
        SUID_WHY = "auto-detected — " + why
    except OSError as e:
        # Never a silent default. If the box cannot be classified, the owner-write check
        # is running blind, and that fact is a finding in its own right (see walk()).
        SUID_ERR = f"cannot read {PASSWDF}: {e.strerror or e}"
        SUID_WHY = "auto-detect FAILED — check is OFF and that is reported as a FAIL"
else:
    print(f"FATAL: DROPSCAN_SHARED_UID must be 1, 0 or auto (got {SUID_ENV!r})",
          file=sys.stderr)
    sys.exit(4)

# --- fingerprints -------------------------------------------------------------------
def fp(val: str) -> str:
    return hashlib.sha256(val.encode("utf-8", "replace")).hexdigest()[:12]

def mask(val: str) -> str:
    """At most 3 leading chars. Never enough to use, enough to recognise."""
    head = val[:3]
    head = "".join(ch if ch.isprintable() else "." for ch in head)
    return f"{head}...({len(val)} chars)"

allow = {}
if ALLOWFILE:
    if not os.path.isfile(ALLOWFILE):
        print(f"FATAL: allowlist file not found: {ALLOWFILE}", file=sys.stderr)
        sys.exit(4)
    with open(ALLOWFILE, "r", errors="replace") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            tok, _, reason = line.partition("#")
            tok = tok.strip()
            if tok:
                allow[tok] = reason.strip() or "(no reason given)"

# --- rules ---------------------------------------------------------------------------
# Assembled from fragments so this file contains no token-shaped literal and can scan
# itself. See the header note on pattern self-reference. Do not "tidy" these into
# literals — that reintroduces the self-flagging problem the exclusion-by-path fix
# solves badly.
# NB replaces `\b` on every rule below. `\b` treats `_` as a word character, so a key
# glued to an identifier by an underscore -- prefix_<key> -- had NO boundary before it
# and every prefixed rule silently missed it. This was already fixed once in
# secret-assignment; the selftest then caught the same bug surviving in the other eight.
# The lookbehind rejects only a preceding ALPHANUMERIC, so `_<key>` matches and a key
# buried mid-word does not.
NB   = r"(?<![A-Za-z0-9])"
B64  = r"[A-Za-z0-9_\-]"
B64S = r"[A-Za-z0-9+/=_\-]"
_sk   = "s" + "k"
_ant  = _sk + "-" + "ant"
_ey   = "e" + "yJ"
_gh   = "g" + "h"
_xox  = "x" + "ox"
_akia = "AK" + "IA"
_asia = "AS" + "IA"
_aiza = "AI" + "za"
_oma  = "o" + "ma_"
_pem  = "-----" + "BEGIN"

# The credential-named key half of the secret-assignment rule, named once because TWO
# places need to agree on it: the rule itself, and the nested-value guard in
# noncredential_value() below. Two copies of this alternation would drift, and the
# direction it drifts in is silent: the guard stops recognising a key the rule still
# matches, and a nested assignment under that key goes quiet without anyone deciding it.
# No leading \b: the boundary is the bug. In `management_password` the char before
# `pass` is `_`, which IS a word char, so \b never matched and the single most likely
# real-world spelling sailed straight through. Caught by the selftest.
#
# TOG-406 — why this is a CROSS-PRODUCT and not a longer hand-written list.
#   The list used to be eleven spellings written out one by one, and four of the most
#   common credential key names in the world were not among them: `access_token`,
#   `secret_key`, `bearer_token`, `auth_key`. `secret_key` is the instructive one — it
#   READS as covered, because `secret` is in the list. It is not: after `secret` the
#   rule needs `\s*[:=]`, gets `_key`, and no other alternative can start a match on
#   that string. Enumerating the four reported names would have left 31 more of exactly
#   the same shape; measured over <prefix>_<suffix> spellings, 35 of 56 missed.
#   So the alternation is now generated: a credential-CONTEXT word, then `key`, `token`
#   or `secret`. Every spelling the old list had is still produced by it.
#
#   What is deliberately NOT here is the other half of the cross-product. Bare `key`,
#   `token` and `id` are not alternatives and must not become alternatives: `key: value`,
#   `tokens_input = 41234` and `client_id = ...` are ordinary runbook lines, and `id` as
#   a SUFFIX is an identifier, never a secret. `public` is not a prefix for the same
#   reason — a public key is publishable by definition. Each of those is pinned by a
#   negative case in the selftest, because with no left boundary (above) this rule
#   matches mid-word and a careless prefix is how it would start firing on prose.
#   `app` is NOT in this list, and it is the one prefix that was tried and REMOVED. It
#   was measured against this repository as a second corpus and produced exactly one new
#   FAIL: a WARNING line in test_gh_app_token.sh, where the tool's own name supplies
#   `app_token`, the log's colon supplies the separator, and the next word supplies an
#   8-character "value". Nothing was ever secret there. `app_key` is a real credential
#   spelling, but it is a rare one, and this repo says the tool's own name will collide
#   with it in prose forever. A permanently-red scanner is a muted scanner — that is the
#   whole lesson of TOG-385 one section down. Pinned by a negative case in the selftest.
CRED_PRE = (r"(?:access|api|auth|bearer|client|consumer|encryption|id|master"
            r"|oauth|private|refresh|secret|session|signing|token)")
CRED_SUF = r"(?:key|token|secret)"
CRED_KEY = (r"(?:pass(?:word|wd|phrase)|secret|credential"
            r"|" + CRED_PRE + r"[_\-]?" + CRED_SUF + r")s?")
CRED_ASSIGN_RE = re.compile(
    r"(?i)" + CRED_KEY + r"(?![A-Za-z0-9])\s*[:=]\s*"
    r"[\"']?(?P<val>[^\s\"',;]{8,})[\"']?")
# No leading `^`, for the same reason the rule has no leading \b — and it is the same
# bug: this guard was anchored at BOTH ends while the rule it is supposed to agree with
# was anchored at neither, so the guard silently stopped recognising every PREFIXED
# spelling the rule still matched. Measured: it missed `x-api-key`, `api_secret` and
# `AWS_SECRET_ACCESS_KEY` — 48 of the same 56 spellings. That is not cosmetic. A key
# the guard does not recognise takes the recursion path instead of the strict one, and
# the recursion re-applies the 8-char floor, so an `x-api-key` nested one level under a
# `credential` key and carrying a seven-character payload scanned CLEAN. Described here
# rather than quoted: the example line IS a live assignment, and this file scans itself
# (see the header note on pattern self-reference). It is quoted where it belongs, as a
# runtime-assembled selftest case. Probed, not reasoned. The trailing `$` stays:
# the rule requires the credential name to sit immediately before the separator, so the
# key must END with it. `.search`, not `.match` — `.match` re-imposes the `^`.
CRED_KEY_RE = re.compile(r"(?i)" + CRED_KEY + r"$")

RULES = [
    # id, tier, regex, description
    ("pem-private-key", "FAIL",
     re.compile(_pem + r"[ A-Z]*PRIVATE KEY-----"),
     "PEM private key block"),
    ("pem-any", "FAIL",
     re.compile(_pem + r"[ A-Z]*(?:CERTIFICATE|RSA|OPENSSH|PGP)[ A-Z]*-----"),
     "PEM-armoured key material"),
    ("anthropic-key", "FAIL",
     re.compile(NB + _ant + r"-" + B64 + r"{16,}"),
     "Anthropic API key"),
    ("openai-style-key", "FAIL",
     re.compile(NB + _sk + r"-" + B64 + r"{20,}"),
     "OpenAI-style secret key"),
    ("jwt", "FAIL",
     re.compile(NB + _ey + B64 + r"{6,}\." + B64 + r"{8,}\." + B64 + r"{8,}"),
     "JWT — note PAPERCLIP_API_KEY is exactly this shape"),
    ("jwt-header-only", "FAIL",
     re.compile(NB + _ey + B64 + r"{20,}"),
     "base64 JSON header, probable truncated JWT"),
    ("github-token", "FAIL",
     re.compile(NB + _gh + r"[pousr]_[A-Za-z0-9]{20,}"),
     "GitHub personal access / app token"),
    ("slack-token", "FAIL",
     re.compile(NB + _xox + r"[abprs]-[A-Za-z0-9\-]{10,}"),
     "Slack token"),
    ("aws-access-key-id", "FAIL",
     re.compile(NB + r"(?:" + _akia + r"|" + _asia + r")[0-9A-Z]{16}\b"),
     "AWS access key id"),
    ("google-api-key", "FAIL",
     re.compile(NB + _aiza + B64 + r"{30,}"),
     "Google API key"),
    ("omniroute-access-token", "FAIL",
     re.compile(NB + _oma + B64 + r"{16,}"),
     "OmniRoute scoped access token"),
    ("bearer-header", "FAIL",
     re.compile(r"(?i)authorization\s*:\s*(?:bearer|basic)\s+" + B64S + r"{16,}"),
     "inline Authorization header with a value"),
    ("secret-assignment", "FAIL", CRED_ASSIGN_RE,
     "assignment to a credential-named key"),
]

# Values that look like assignments but are structurally incapable of being a secret.
# Kept deliberately tight: every entry here is a hole in the secret-assignment rule.
PLACEHOLDER = re.compile(
    r"(?i)^(?:"
    r"[.<>*x\-_?]{3,}"                       # ..., <...>, xxxxxxx, ---
    r"|null|none|true|false|undefined|nil"
    r"|change[_\-]?me|redacted|placeholder|example|sample|dummy|test+"
    r"|your[_\-].*|my[_\-].*|the[_\-].*"
    r"|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?"       # $VAR / ${VAR} — a reference, not a value
    r"|0600|0644|0755|0777"                  # file modes, common in these docs
    r"|[0-9]+"                               # counts, ports, timeouts
    r")$"
)
# Prose forms — "the password is loaded from", "api_key: never write one here".
PROSE = re.compile(r"(?i)^(?:is|are|was|were|not|never|must|should|may|can|will|from|to|"
                   r"in|on|for|via|by|with|and|or|of|the|a|an|it|this|that|here|there|"
                   r"loaded|stored|held|read|passed|set|unset|absent|present|gone|"
                   r"handling|rotation|material|shaped|bearing|named|scoped)$")

UUID_RE   = re.compile(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
HEXDIG_RE = re.compile(r"(?i)^[0-9a-f]{32}$|^[0-9a-f]{40}$|^[0-9a-f]{64}$|^[0-9a-f]{128}$")
# Context words that make a bare hex digest a checksum rather than a key.
DIGEST_CTX = re.compile(r"(?i)sha-?(?:1|256|512)?|checksum|digest|integrity|hash|"
                        r"commit|blob|oid|head[_\- ]?sha|fingerprint|etag")
# `=` may only appear as trailing base64 padding. With `=` in the body, the sweep glued
# the key onto the value — `sha256=084ad...` scanned as ONE token, so it was no longer a
# bare hex digest, the checksum exemption never applied, and every published SHA in the
# runbook came back as a REVIEW finding. Caught by the selftest.
TOKEN_RE  = re.compile(r"[A-Za-z0-9+/_\-]{24,}={0,2}")
WORDY_RE  = re.compile(r"^[A-Za-z_\-]+$")            # identifiers, any case
PATHY_RE  = re.compile(r"^[A-Za-z0-9_\-./]*[/.][A-Za-z0-9_\-./]*$")

SEG_RE = re.compile(r"[._\-]")
# camelCase / PascalCase: every capital is followed by a RUN of >=2 lowercase. That run
# requirement is the whole discriminator. `alwaysPreserveClientCache` matches;
# `aQxZbWpLnRtVcYuIoPdF` does not, because its capitals are followed by single letters.
CAMEL_RE = re.compile(r"^[A-Z]?[a-z]{2,}(?:[A-Z][a-z]{2,})+$")

def is_identifier(tok: str) -> bool:
    """Identifier/filename shape: TWO OR MORE separator-delimited segments, each one
    purely alphabetic (<=20 chars) or purely numeric.

    The discriminator is that random blobs mix letters and digits WITHIN a segment,
    while names keep them apart:
        OMNIROUTE_MANAGEMENT_KEY        -> alpha|alpha|alpha        identifier
        TOG-151-omniroute_combo_cli     -> alpha|num|alpha|alpha|alpha  identifier
        Xk92Lm4QzR7vB1nT8y(...)          -> one mixed segment    NOT exempt
        sk-<26 alnum>                   -> alpha|mixed             NOT exempt

    The >=2 segment floor is load-bearing: without it a single long alphabetic blob
    like `aQxZbWpLnRtVcYuIoPdF`(...) would be exempted, and that is a plausible
    credential. A single word is left to the entropy threshold, not exempted here."""
    segs = [s for s in SEG_RE.split(tok) if s != ""]
    if len(segs) < 2:
        # Single segment: only camelCase/PascalCase qualifies. Every OmniRoute settings
        # key is this shape (alwaysPreserveClientCache, comboStickyRoundRobinLimit), and
        # without it every snapshot line produced a REVIEW finding.
        return bool(CAMEL_RE.match(tok))
    for s in segs:
        if s.isdigit():
            continue
        if s.isalpha() and (len(s) <= 20 or CAMEL_RE.match(s)):
            continue
        # A segment of <=3 chars cannot hide a credential, and role ids on this box are
        # spelled that way: B5_LEGAL_COMPLIANCE_CHIEF, D2_ORCHESTRATION_MANAGER.
        if len(s) <= 3 and s.isalnum():
            continue
        return False
    return True

# --- value-shape gating for secret-assignment (TOG-385) -------------------------------
# The rule fires on a credential-NAMED key followed by a value. The trigger is right —
# `management_password` must fire — but "there is a value after the colon" is not the
# same claim as "that value is a credential". A row in a probe RESULT table,
#
#     cc-headers + x-api-key            : http=200
#
# is a credential-named key, a colon, and an 8-character value, and there has never been
# a secret on that line. It was the ONE FAIL on the live channel. FAIL is the exit-1
# verdict the operator's cron reads, so the scanner was permanently red over a line with
# nothing in it — and a detector that is always red is a muted detector.
#
# THE INVARIANT, and the reason the compound cases below are written as RECURSION rather
# than as more patterns in PLACEHOLDER:
#
#     a compound value is exempt only when its PAYLOAD is exempt by the same base
#     predicate — i.e. only when a direct assignment of that payload was already exempt.
#
# `x-api-key: http=200` goes quiet because `x-api-key: 200` was always quiet.
# `x-api-key: token=<real key>` stays red because `x-api-key: <real key>` is red. No
# case below can open a hole the base predicate did not already have, which is the whole
# difference between narrowing a credential rule and weakening one.
#
# Deliberately NOT an exclusion by path, filename or extension. A real key pasted into a
# findings document is precisely the disclosure this scanner exists to catch, so nothing
# here may turn on "it is a markdown file".
VARREF_RE = re.compile(r"^\$\{?[A-Za-z_]")
# A k=v pair carried as a value: `http=200`, `rc=0`, `status=ok`. The payload group is
# `.+` and not `.*` on purpose: with `.*`, base64 padding (`...c2VjcmV0=`) would parse as
# a k=v with an EMPTY payload, and an empty payload is exempt — so every padded base64
# secret would have exempted itself. That is the one way this shape could have gone
# wrong, and it is pinned in the selftest.
INNER_KV_RE = re.compile(r"^([A-Za-z][A-Za-z0-9_.\-]{0,31})=(.+)$")
URL_RE      = re.compile(r"(?i)^(?:https?|ftp|ftps|git|ssh|file|wss?)://(.+)$")
# `@` is a URL delimiter and belongs in this split. It also keeps the userinfo guard
# below HONEST: without it, `user:<pw>@host` stays one segment, no base case admits an
# `@`, so that segment is credential-shaped whatever it holds and the guard would be
# unreachable dead code that still reads like a control.
URL_SEG_RE  = re.compile(r"[/?&#;=:@]")


def noncredential_value(val: str, depth: int = 0) -> bool:
    """True when this value is structurally incapable of being the secret the rule is
    looking for. Read the invariant above before adding a case."""
    if depth > 3:
        # Fail closed. Nesting this deep is not a shape we are prepared to vouch for,
        # and an unbounded recursion is its own denial-of-service.
        return False
    if len(val) < 8:
        # Below the rule's own floor: the regex will not accept a value shorter than
        # this at the top level, so a nested payload shorter than this cannot be what
        # the rule would have caught either. At depth 0 this is unreachable.
        return True

    # --- base cases: unchanged behaviour, moved here so the compound cases can reuse it
    if PLACEHOLDER.match(val) or PROSE.match(val):
        return True
    # A value that is itself a path or a bare word is documentation, not a credential.
    # Both appear constantly in these runbooks.
    if PATHY_RE.match(val) and not TOKEN_RE.fullmatch(val):
        return True
    if WORDY_RE.match(val):
        return True
    # `KEY="${KEY}"` — a reference to a value, not the value.
    if VARREF_RE.match(val):
        return True

    # --- compound case: the value is itself an assignment
    m = INNER_KV_RE.match(val)
    if m:
        inner_key, inner_val = m.group(1), m.group(2)
        if CRED_KEY_RE.search(inner_key):
            # A nested assignment whose OWN key is credential-named. The outer match has
            # already consumed it, so finditer will never report it a second time, and
            # recursing normally would drop that payload through the 8-char floor and
            # lose it. Only a structural non-value is exempt here.
            return bool(PLACEHOLDER.match(inner_val) or PROSE.match(inner_val)
                        or VARREF_RE.match(inner_val))
        return noncredential_value(inner_val, depth + 1)

    # --- compound case: the value is a URL
    m = URL_RE.match(val)
    if m:
        rest = m.group(1)
        # maxsplit by KEYWORD: positional is deprecated in 3.13 and the warning goes to
        # stderr, i.e. straight into the operator's cron mail, mid-report.
        if "@" in re.split(r"[/?#]", rest, maxsplit=1)[0]:
            # userinfo. `https://user:<token>@host` is a credential in a URL's clothing.
            return False
        if CRED_ASSIGN_RE.search(rest):
            # `?access_token=...`. The outer match swallowed the whole URL, so this is
            # the only chance to see it — finditer will not report it a second time.
            return False
        return all(noncredential_value(seg, depth + 1)
                   for seg in URL_SEG_RE.split(rest) if seg)

    return False


def shannon(s: str) -> float:
    if not s:
        return 0.0
    counts = {}
    for ch in s:
        counts[ch] = counts.get(ch, 0) + 1
    n = len(s)
    return -sum((c / n) * math.log2(c / n) for c in counts.values())

findings = []      # (tier, path, locator, rule_id, desc, value)
suppressed = []    # (fp, path, rule_id, reason)
stats = {"files": 0, "bytes": 0, "binary": 0, "lines": 0, "regular": 0, "agent_owned": 0}

def record(tier, path, locator, rule_id, desc, value):
    f = fp(value)
    if f in allow:
        suppressed.append((f, path, rule_id, allow[f]))
        return
    findings.append((tier, path, locator, rule_id, desc, value))

def scan_text(path, text, is_binary):
    lines = text.split("\n")
    stats["lines"] += len(lines)
    for lineno, line in enumerate(lines, 1):
        if not line:
            continue
        loc = f"run {lineno}" if is_binary else f"line {lineno}"
        for rule_id, tier, rx, desc in RULES:
            for m in rx.finditer(line):
                val = m.groupdict().get("val") or m.group(0)
                if rule_id == "secret-assignment" and noncredential_value(val):
                    continue
                record(tier, path, loc, rule_id, desc, val)

        # --- entropy sweep (REVIEW tier) ---------------------------------------------
        for m in TOKEN_RE.finditer(line):
            tok = m.group(0)
            # Trailing '=' is base64 padding OR an assignment operator, and the sweep
            # cannot tell which. Strip it before every structural test: with it
            # attached, `OMNIROUTE_MANAGEMENT_KEY=` stopped looking like an identifier
            # and every `NAME=value` line in a shell snippet became a REVIEW finding.
            tok = tok.rstrip("=")
            if len(tok) < 24:
                continue
            if UUID_RE.match(tok):
                continue
            if HEXDIG_RE.match(tok):
                # Downgraded ONLY when the same line says it is a digest. Without that
                # context it stays a REVIEW finding — a 64-hex API key is a real shape.
                if DIGEST_CTX.search(line):
                    suppressed.append((fp(tok), path, "entropy-hexdigest",
                                       "hex digest with checksum context on the same line"))
                    continue
            if is_identifier(tok) or PATHY_RE.match(tok):
                continue
            if shannon(tok) < 3.6:
                continue
            record("REVIEW", path, loc, "high-entropy-string",
                   f"entropy {shannon(tok):.2f} over {len(tok)} chars", tok)

def printable_runs(data: bytes):
    """Binary files are scanned, not skipped. A skip is a blind spot in a directory
    any agent can write to."""
    out, cur = [], bytearray()
    for b in data:
        if 32 <= b < 127 or b in (9,):
            cur.append(b)
        else:
            if len(cur) >= 6:
                out.append(cur.decode("ascii", "replace"))
            cur = bytearray()
    if len(cur) >= 6:
        out.append(cur.decode("ascii", "replace"))
    return out

def walk():
    if not os.path.isdir(ROOT):
        print(f"FATAL: scan root is not a directory: {ROOT}", file=sys.stderr)
        sys.exit(4)

    st = os.stat(ROOT)
    mode = st.st_mode & 0o7777
    # Any write bit outside the owner, with no sticky bit, means a non-owner can unlink
    # or replace ANY file here regardless of that file's own mode. Checking only o+w
    # (the original version) left a hole that reads like a tightening: root:node 0775
    # looks stricter than 1777, but every agent is gid node, so it is the SAME exposure
    # with the sticky protection removed — and it scanned CLEAN. Group write is judged
    # by whether THIS process is actually in the directory's group: exploitable-by-me is
    # a FAIL, merely-group-writable is a REVIEW a human rules on. The fingerprint stays
    # bound to the literal mode, so an acknowledgement of one mode can never silently
    # carry over to a different one.
    if not (mode & 0o1000) and (mode & 0o022):
        in_grp = st.st_gid in os.getgroups() or st.st_gid == os.getgid()
        if mode & 0o002:
            who, tier = "any uid on this box", "FAIL"
        elif in_grp:
            who, tier = f"any uid in gid {st.st_gid}, which includes this process", "FAIL"
        else:
            who, tier = f"any uid in gid {st.st_gid}", "REVIEW"
        record(tier, ROOT, "-", "channel-writable-no-sticky",
               f"scan root is mode {mode:04o} with no sticky bit — {who} can replace or "
               f"unlink ANY file here, including operator-run scripts",
               f"__channel_mode_{mode:04o}__")

    # The check above deliberately still treats the sticky bit as sufficient, because on
    # a normal multi-user host it is. Under a shared uid it is not, and that is NOT
    # patched into the predicate above — sticky-with-mixed-owners and
    # sticky-with-one-owner are different facts and get different findings. See below.
    if SUID_ERR:
        record("FAIL", PASSWDF, "-", "shared-uid-undetectable",
               f"{SUID_ERR} — cannot determine whether every agent on this host shares "
               f"one uid, so the owner-write check (FINDING-B) is OFF and this scan is "
               f"blind to it. Set DROPSCAN_SHARED_UID=1 or 0 explicitly and re-run.",
               "__shared_uid_undetectable__")

    def check_dir_owner(dirpath):
        """Under a shared uid, a non-root-owned directory is exposure at ANY mode.
        0755 is not a tightening when every agent is the owner."""
        try:
            dst = os.stat(dirpath)
        except OSError as e:
            record("FAIL", dirpath, "-", "unscannable", f"stat failed: {e}",
                   f"__unscannable_dir_{dirpath}__")
            return
        if dst.st_uid == 0:
            return
        rel   = os.path.relpath(dirpath, ROOT)
        shown = ROOT if rel == "." else rel
        dmode = dst.st_mode & 0o7777
        record("FAIL", shown, "-", "dir-agent-owned-shared-uid",
               f"directory is mode {dmode:04o} owned by uid {dst.st_uid}, not root, on a "
               f"host where every agent runs as ONE uid. Owner-write IS cross-agent "
               f"write: any agent can add, replace, unlink or rename entries here at any "
               f"mode, and the sticky bit cannot help because every entry shares that "
               f"owner. Root ownership is the only mode that closes this. Root cause is "
               f"the shared runtime uid — TOG-191, not fixable from inside this scan",
               f"__shareduid_dir_{shown}_{dst.st_uid}__")

    for dirpath, dirnames, filenames in os.walk(ROOT, followlinks=False):
        # ROOT is the first dirpath os.walk yields, so this covers the scan root too.
        if SHARED_UID:
            check_dir_owner(dirpath)
        # Report symlinked directories, do not descend into them.
        for d in list(dirnames):
            full = os.path.join(dirpath, d)
            if os.path.islink(full):
                dirnames.remove(d)
                record("FAIL", full, "-", "symlink-in-channel",
                       f"symlinked directory -> {os.readlink(full)!r}; not traversed",
                       f"__symlink_{full}__")
        for fn in sorted(filenames):
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, ROOT)
            if os.path.islink(full):
                record("FAIL", rel, "-", "symlink-in-channel",
                       f"symlink -> {os.readlink(full)!r}; not followed",
                       f"__symlink_{rel}__")
                continue
            try:
                fst = os.stat(full)
            except OSError as e:
                record("FAIL", rel, "-", "unscannable", f"stat failed: {e}",
                       f"__unscannable_{rel}__")
                continue
            if not os.path.isfile(full):
                continue
            stats["regular"] += 1
            if SHARED_UID and fst.st_uid != 0:
                # Counted, not recorded. One finding per file would be sixty copies of a
                # single structural fact; see the aggregate at the end of walk().
                stats["agent_owned"] += 1
            if fst.st_size > MAXB:
                # Explicitly NOT a silent truncation.
                record("FAIL", rel, "-", "oversized",
                       f"{fst.st_size} bytes exceeds cap {MAXB}; NOT SCANNED",
                       f"__oversized_{rel}__")
                continue
            if fst.st_mode & 0o002:
                record("REVIEW", rel, "-", "file-world-writable",
                       f"mode {fst.st_mode & 0o7777:04o} — writable by every agent",
                       f"__wwfile_{rel}__")
            try:
                with open(full, "rb") as fh:
                    data = fh.read(MAXB + 1)
            except OSError as e:
                record("FAIL", rel, "-", "unscannable", f"read failed: {e}",
                       f"__unscannable_{rel}__")
                continue
            if len(data) > MAXB:
                record("FAIL", rel, "-", "oversized",
                       f"grew past cap {MAXB} during read; NOT SCANNED",
                       f"__oversized_{rel}__")
                continue

            stats["files"] += 1
            stats["bytes"] += len(data)
            is_binary = b"\x00" in data[:8192]
            if is_binary:
                stats["binary"] += 1
                scan_text(rel, "\n".join(printable_runs(data)), True)
            else:
                try:
                    scan_text(rel, data.decode("utf-8"), False)
                except UnicodeDecodeError:
                    # Fail closed: decode failure is reported, then scanned lossily so a
                    # secret in the readable part is still caught.
                    record("FAIL", rel, "-", "unscannable",
                           "not valid UTF-8 and not NUL-delimited binary; scanned lossily",
                           f"__decode_{rel}__")
                    scan_text(rel, data.decode("utf-8", "replace"), False)

    # --- aggregate: agent-owned files under a shared uid (FINDING-B corollary) --------
    # REVIEW, not FAIL: unlike a directory, agent-authored FILES in a handoff channel are
    # the channel working as intended — the exposure is that nothing separates one
    # agent's file from another's, which is a standing property of the host, not drift.
    # The fingerprint is bound to the CONDITION and carries no count, so one human
    # acknowledgement stays valid as files come and go, and stops applying entirely the
    # day this host is no longer shared-uid (the finding simply does not fire).
    if SHARED_UID and stats["agent_owned"]:
        record("REVIEW", ROOT, "-", "shared-uid-file-integrity",
               f"{stats['agent_owned']} of {stats['regular']} files here are owned by a "
               f"non-root uid, and every agent on this box IS that uid — so any agent can "
               f"rewrite, truncate, unlink or rename any of them, whatever their mode says. "
               f"The sticky bit gives ZERO inter-agent protection for these files; it only "
               f"protects the root-owned entries. Nothing inside this channel can fix that: "
               f"the only integrity control is comparing each SHA-256 against the value "
               f"published in the Paperclip issue thread before running or trusting a file",
               "__shared_uid_file_integrity__")

walk()

# --- report ---------------------------------------------------------------------------
fails   = [f for f in findings if f[0] == "FAIL"]
reviews = [f for f in findings if f[0] == "REVIEW"]

if not QUIET:
    print(f"dropchannel scan: {ROOT}")
    print(f"  files scanned : {stats['files']} ({stats['binary']} binary), "
          f"{stats['bytes']} bytes, {stats['lines']} lines")
    print(f"  rules         : {len(RULES)} credential rules + entropy sweep")
    # Printed on every run, in both directions. A mode check whose own state is invisible
    # is how FINDING-B survived: the scan said CLEAN and never said what it had looked at.
    print(f"  shared-uid    : {'ON' if SHARED_UID else 'off'}  ({SUID_WHY})")
    # Two different things end up in this list: a finding a HUMAN accepted in the
    # allowlist file, and a built-in engine downgrade nobody was asked about. Printing
    # both under one word invites reading an automatic rule as a human decision. The
    # tag says which is which, so "suppressed: 1" can be audited rather than trusted.
    n_ack = sum(1 for f, _, _, _ in suppressed if f in allow)
    n_auto = len(suppressed) - n_ack
    print(f"  suppressed    : {len(suppressed)}  ({n_ack} acknowledged in allowlist, "
          f"{n_auto} built-in engine rule)")
    for f, path, rule, reason in suppressed[:20]:
        src = "ACK " if f in allow else "AUTO"
        print(f"      - [{src}] {f}  {path}  [{rule}]  {reason}")
    if len(suppressed) > 20:
        print(f"      ... and {len(suppressed)-20} more suppressions")
    print()

for tier, path, loc, rule_id, desc, value in fails + reviews:
    print(f"{tier}  {path}  {loc}")
    print(f"      rule={rule_id}  {desc}")
    print(f"      value={mask(value)}  fp={fp(value)}")

if not QUIET:
    print()
    print(f"FAIL findings   : {len(fails)}")
    print(f"REVIEW findings : {len(reviews)}")

if fails:
    sys.exit(1)
if reviews:
    sys.exit(1 if STRICT else 2)
sys.exit(0)
PYEOF
}

# -------------------------------------------------------------------------------------
cmd_scan() {
  need python3
  [ -d "$DROPSCAN_ROOT" ] || die "scan root is not a directory: $DROPSCAN_ROOT"
  local rc=0
  STRICT="$STRICT" QUIET="$QUIET" \
  DROPSCAN_MAX_BYTES="$DROPSCAN_MAX_BYTES" \
  DROPSCAN_ALLOWLIST_FILE="$DROPSCAN_ALLOWLIST_FILE" \
  DROPSCAN_SHARED_UID="$DROPSCAN_SHARED_UID" \
  DROPSCAN_PASSWD_FILE="$DROPSCAN_PASSWD_FILE" \
    run_engine "$DROPSCAN_ROOT" scan || rc=$?
  case "$rc" in
    0) c_grn "CLEAN — every file read in full, no findings." ;;
    1) c_red "HIT — credential-shaped content or an unscannable file. Do not treat this channel as reviewed." ;;
    2) c_ylw "REVIEW — high-entropy strings need a human call. Nothing matched a credential rule." ;;
    *) c_red "scan did not complete (rc=$rc)" ;;
  esac
  return "$rc"
}

cmd_manifest() {
  need python3
  [ -d "$DROPSCAN_ROOT" ] || die "scan root is not a directory: $DROPSCAN_ROOT"
  ROOT="$DROPSCAN_ROOT" python3 - <<'PYEOF'
import hashlib, os, sys
ROOT = os.environ["ROOT"]
rows = []
for dirpath, dirnames, filenames in os.walk(ROOT, followlinks=False):
    for d in list(dirnames):
        if os.path.islink(os.path.join(dirpath, d)):
            dirnames.remove(d)
    for fn in filenames:
        full = os.path.join(dirpath, fn)
        rel = os.path.relpath(full, ROOT)
        if os.path.islink(full):
            print(f"SYMLINK\t{rel}\t-> {os.readlink(full)}", file=sys.stderr)
            continue
        h = hashlib.sha256()
        with open(full, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        rows.append((h.hexdigest(), rel))
for digest, rel in sorted(rows, key=lambda r: r[1]):
    print(f"{digest}  {rel}")
PYEOF
}

cmd_verify() {
  need python3
  local man="${1:-}"
  [ -n "$man" ] || refuse "verify requires --manifest FILE"
  [ -f "$man" ] || die "manifest not found: $man"
  local tmp rc=0
  tmp="$(mk_tmpfile)"
  cmd_manifest > "$tmp"
  MAN="$man" NOW="$tmp" python3 - <<'PYEOF' || rc=$?
import os, sys
def load(p):
    out = {}
    with open(p, "r", errors="replace") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            digest, _, rel = line.partition("  ")
            if rel:
                out[rel] = digest.strip()
    return out
old, new = load(os.environ["MAN"]), load(os.environ["NOW"])
changed = [r for r in sorted(set(old) & set(new)) if old[r] != new[r]]
added   = sorted(set(new) - set(old))
removed = sorted(set(old) - set(new))
for r in changed: print(f"CHANGED  {r}\n      was {old[r][:16]}...  now {new[r][:16]}...")
for r in added:   print(f"ADDED    {r}  {new[r][:16]}...")
for r in removed: print(f"REMOVED  {r}  was {old[r][:16]}...")
print(f"\nmanifest: {len(old)} entries   now: {len(new)} entries")
print(f"changed={len(changed)} added={len(added)} removed={len(removed)}")
sys.exit(1 if (changed or added or removed) else 0)
PYEOF
  if [ "$rc" -eq 0 ]; then c_grn "VERIFIED — channel matches the manifest."
  else c_red "DRIFT — the channel does not match the manifest. Re-check every SHA against the issue thread before running anything from here."; fi
  return "$rc"
}

# -------------------------------------------------------------------------------------
# Offline selftest. Every rule gets a positive case; the false-positive corpus is drawn
# from real strings in this channel (sha256 digests, account_key tuples, mode bits,
# prose about credentials). The last two cases are the ones that matter most:
# self-scan clean, and self-scan-with-planted-secret caught.
# -------------------------------------------------------------------------------------
cmd_selftest() {
  need python3
  local tmp; tmp="$(mk_tmpdir)"
  local pass=0 fail=0
  local SELF; SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

  # ---------------------------------------------------------------------------------
  # Every generic helper pins DROPSCAN_SHARED_UID=0, for the same reason it pins
  # DROPSCAN_ALLOWLIST_FILE="": a fixture directory made by mktemp is owned by whoever
  # runs the selftest, so on THIS box (one shared uid) the FINDING-B check would fire on
  # all ~40 of them and every rc=0 assertion in the file would go red for a reason that
  # has nothing to do with the rule under test. The shared-uid behaviour therefore gets
  # its own explicit cases below, driving BOTH verdicts from fixture passwd files rather
  # than inheriting the host's answer — so this selftest gives the same result on a
  # shared-uid box and on an ordinary multi-user one.
  # ---------------------------------------------------------------------------------
  _case() { # name expected_rc dir
    local nm="$1" expect="$2" dir="$3" rc=0
    STRICT=0 QUIET=1 DROPSCAN_MAX_BYTES="$DROPSCAN_MAX_BYTES" DROPSCAN_SHARED_UID=0 \
      DROPSCAN_ALLOWLIST_FILE="" run_engine "$dir" scan >/dev/null 2>&1 || rc=$?
    if [ "$rc" = "$expect" ]; then pass=$((pass+1)); printf '  PASS  %-52s rc=%s\n' "$nm" "$rc"
    else fail=$((fail+1)); c_red "  FAIL  $nm  expected rc=$expect got rc=$rc"; fi
  }
  _case_allow() { # name expected_rc dir allowfile
    # _case pins DROPSCAN_ALLOWLIST_FILE="" so suppression can never leak into an
    # ordinary case. Allowlist behaviour therefore needs its own helper rather than an
    # env prefix on _case, which would be silently discarded.
    local nm="$1" expect="$2" dir="$3" af="$4" rc=0
    STRICT=0 QUIET=1 DROPSCAN_MAX_BYTES="$DROPSCAN_MAX_BYTES" DROPSCAN_SHARED_UID=0 \
      DROPSCAN_ALLOWLIST_FILE="$af" run_engine "$dir" scan >/dev/null 2>&1 || rc=$?
    if [ "$rc" = "$expect" ]; then pass=$((pass+1)); printf '  PASS  %-52s rc=%s\n' "$nm" "$rc"
    else fail=$((fail+1)); c_red "  FAIL  $nm  expected rc=$expect got rc=$rc"; fi
  }
  _fp_mode() { # octal-mode -> the 12-hex fingerprint the engine uses for that mode
    python3 -c 'import hashlib,sys;v="__channel_mode_%04o__"%int(sys.argv[1],8);print(hashlib.sha256(v.encode()).hexdigest()[:12])' "$1"
  }
  _rule() { # name rule_id_expected filecontent
    local nm="$1" want="$2" content="$3" d="$tmp/r$$_$RANDOM"
    mkdir -p "$d"; printf '%s\n' "$content" > "$d/sample.txt"
    local out; out="$(STRICT=0 QUIET=1 DROPSCAN_ALLOWLIST_FILE="" DROPSCAN_SHARED_UID=0 \
      run_engine "$d" scan 2>&1 || true)"
    if printf '%s' "$out" | grep -q "rule=$want"; then
      pass=$((pass+1)); printf '  PASS  %-52s %s\n' "$nm" "$want"
    else
      fail=$((fail+1)); c_red "  FAIL  $nm  expected rule=$want, got: $(printf '%s' "$out" | tr '\n' ' ' | head -c 160)"
    fi
    rm -rf "$d"
  }
  _clean() { # name filecontent  -> must produce NO finding at all
    local nm="$1" content="$2" d="$tmp/c$$_$RANDOM" rc=0
    mkdir -p "$d"; printf '%s\n' "$content" > "$d/sample.txt"
    STRICT=0 QUIET=1 DROPSCAN_ALLOWLIST_FILE="" DROPSCAN_SHARED_UID=0 \
      run_engine "$d" scan >/dev/null 2>&1 || rc=$?
    if [ "$rc" = "0" ]; then pass=$((pass+1)); printf '  PASS  %-52s clean\n' "$nm"
    else fail=$((fail+1)); c_red "  FAIL  $nm  expected clean, got rc=$rc"; fi
    rm -rf "$d"
  }

  echo "=== credential rules — every rule must fire on its own shape ==="
  # ------------------------------------------------------------------------------
  # Fixture material is ASSEMBLED AT RUNTIME, never written as a literal. Two separate
  # reasons, and the selftest caught both:
  #   - a literal credential prefix makes the scanner flag its own source (the reason
  #     the RULES are fragmented too);
  #   - a literal 24+ char random-looking blob trips the scanner's own entropy sweep,
  #     so the "scans itself clean" case fails for a reason that has nothing to do
  #     with the rule under test.
  # Brace expansion gives the entropy without any long token appearing in this file.
  # ------------------------------------------------------------------------------
  local A26 A26U D10
  A26="$(printf '%s' {a..z})"      # a..z, concatenated
  A26U="$(printf '%s' {A..Z})"
  D10="$(printf '%s' {0..9})"
  local SK="s""k-" ANT="s""k-ant-" EY="e""yJ" GH="g""h" XOX="x""ox" AK="AK""IA" AZ="AI""za" OM="o""ma_"
  local PEMB="-----""BEGIN" AUTHZ="Authoriz""ation" PASSW="pass""word"
  # TOG-385 fixtures. The KEY is what has to be fragmented here, not the value: a
  # positive case for secret-assignment is by construction a live assignment, so spelling
  # the key literally makes this file flag itself and breaks the self-scan pair below.
  local XAK="x-api-""key" APIK="api_""key" CSEC="client_""secret" STOK="session_""token"
  # TOG-406 fixtures, same rule: the key is what must be fragmented. The doubled quote
  # is load-bearing — `bearer_""token` does not match `bearer[_\-]?token`, so this file
  # keeps scanning itself clean while the assembled value does fire.
  local ATOK="access_""token" SKEY="secret_""key" BTOK="bearer_""token" ASEC="api_""secret"
  local BLOB="${A26U:0:8}${D10:2:5}${A26:9:9}${A26U:14:6}${D10:0:4}"   # 32 chars, high entropy

  _rule "openai-style key"        openai-style-key       "OPENAI_KEY=${SK}${A26}${D10:0:6}"
  _rule "anthropic key"           anthropic-key          "key: ${ANT}api03-${A26U:0:4}${A26:1:4}${A26:2:4}${A26:3:4}${A26:4:4}${A26:5:4}"
  _rule "JWT (PAPERCLIP_API_KEY)" jwt                    "${EY}${A26U:0:10}.${EY}${A26:0:12}.${BLOB}"
  _rule "github token"            github-token           "${GH}p_${A26U}${D10}"
  _rule "slack token"             slack-token            "${XOX}b-${D10}12-${A26:0:12}"
  _rule "aws access key id"       aws-access-key-id      "${AK}IOSFODNN7EXAMPLE"
  _rule "google api key"          google-api-key         "${AZ}Sy${A26U:3:1}-${D10}${A26:0:23}"
  _rule "omniroute access token"  omniroute-access-token "token=${OM}${A26:0:6}${D10}${A26:0:6}"
  _rule "PEM private key"         pem-private-key        "${PEMB} RSA PRIVATE KEY-----"
  _rule "inline Bearer header"    bearer-header          "${AUTHZ}: Bearer ${A26}${D10:0:6}"
  _rule "credential assignment"   secret-assignment      "management_${PASSW} = hunter2-correct"
  _rule "high-entropy blob"       high-entropy-string    "blob ${BLOB}"

  echo "=== false positives — real strings from this channel must NOT fire ==="
  _clean "sha256 with digest context" "backup verified sha256=084ad4b5c2119f0e7a3d5b6c8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b"
  _clean "UUID"                       "combo id 63364b03-b24f-4cd6-bcc6-d2d9d045fd58"
  _clean "account_key tuple"          '"account_key": ["connection","opencode-go","de31382a-0ceb-4867-93b1-71beba18da2d"]'
  _clean "prose about credentials"    "The management password is loaded from a 0600 file into the environment, never argv."
  _clean "mode bits and counts"       "log file mode: 0600   tokens_input = 41234   api_key: never write one here"
  _clean "env var reference"          'OMNIROUTE_MANAGEMENT_KEY="${OMNIROUTE_MANAGEMENT_KEY}"'
  _clean "path-valued assignment"     "private_key_path = /paperclip/operator-handoff/README.md"
  _clean "ordinary runbook prose"     "Run the drop-guard step before the swap, then record the row counts."
  # Every one of these was a live REVIEW finding on the real channel before the
  # camelCase and short-segment rules existed. Pinned so they cannot come back.
  _clean "camelCase settings key"     '"alwaysPreserveClientCache": true'
  _clean "long camelCase key"         '"autoRefreshProviderQuotaInterval": 3600'
  _clean "camelCase fn name"          "see normalizeRoutingStrategy() in the combo CLI"
  _clean "PascalCase identifier"      "applyDefaultAgentTaskAssignGrant is applied company-wide"
  _clean "role id with B5_ prefix"    "--template B5_LEGAL_COMPLIANCE_CHIEF --title x"
  _clean "role id with D2_ prefix"    "caller D2_ORCHESTRATION_MANAGER may not exceed its ceiling"

  echo "=== the identifier exemption must NOT swallow real secrets ==="
  # The exemption above is the riskiest change in this file: every rule that says
  # "this looks like a name" is a potential hole. These are the shapes it must still
  # catch — capitals followed by SINGLE letters, and mixed-class segments.
  _rule "mixed-case alpha blob is NOT an identifier" high-entropy-string \
        "blob ${A26U:0:1}${A26:16:1}${A26:23:1}${A26U:25:1}${A26:1:1}${A26U:22:1}${A26:15:1}${A26U:11:1}${A26:13:1}${A26U:17:1}${A26:19:1}${A26U:21:1}${A26:2:1}${A26U:24:1}${A26:20:1}${A26U:8:1}${A26:14:1}${A26U:15:1}${A26:3:1}${A26U:5:1}${A26:7:1}${A26U:9:1}${A26:10:1}${A26U:12:1}${A26:11:1}"
  _rule "secret glued to a word by _ still fires"    openai-style-key \
        "prefix_${SK}${A26}${D10:0:6}"

  echo "=== TOG-385: value shape, not just key name — the false positive ==="
  # The literal line from TOG-153-teamclaude-omniroute-findings.md:102 that made the
  # channel cron permanently red. A probe RESULT table, not an assignment.
  _clean "probe result table: x-api-key : http=200" \
         "cc-headers + x-api-key            : http=200"
  _clean "k=v value with a word payload"    "api_key: status=notfound"
  _clean "bare number value"                "client_secret: 1234567890"
  _clean "URL value with a port"            "x-api-key : https://omniroute.internal:20129/v1/models"
  _clean "URL value with a benign query"    "access_key: https://h.example/v1/list?page=2&sort=name"

  echo "=== TOG-385: ...and the narrowing must not cost a single real catch ==="
  # This half is the point. Every case below is a shape the narrowing COULD have
  # swallowed, and each is written so that ONLY secret-assignment can produce the
  # verdict — the payloads are under the entropy sweep's 24-char floor and match no
  # prefix rule, so a green here cannot be the neighbouring rule covering for this one.
  _rule "the reported key itself, with a real value" secret-assignment \
        "${XAK}: hunter2-correct-horse"
  _rule "k=v whose payload IS credential-shaped"     secret-assignment \
        "${XAK} : token=hunter2-correct"
  _rule "inner key is credential-named too"          secret-assignment \
        "credential: ${PASSW}=hunter2"
  _rule "base64 padding is not an empty k=v"         secret-assignment \
        "${CSEC}: dGhpc2lzYTZzZWNyZXQ="
  # These two payloads are deliberately PURE ALPHABETIC, which the base predicate
  # exempts (WORDY_RE) and the entropy sweep ignores at under 24 chars. That is the
  # point: with a payload the base predicate already catches, these cases would be
  # satisfied by the segment recursion next door and would prove nothing about the two
  # guards they are named for. Position is the whole signal here — userinfo and a
  # credential-named query parameter are credentials whatever shape they arrive in.
  _rule "URL carrying a token query parameter"       secret-assignment \
        "${APIK}: https://h.example/cb?${STOK}=correcthorsebattery"
  _rule "URL with userinfo is a credential in a URL" secret-assignment \
        "${APIK}: https://user:correcthorse@h.example/v1"
  _rule "URL carrying an opaque query parameter"     secret-assignment \
        "${XAK} : https://h.example/cb?t=hunter2-correct"
  _rule "nesting past the depth cap fails CLOSED"    secret-assignment \
        "${XAK} : a=b=c=d=e=hunter2-correct"

  echo "=== TOG-406: the credential key names the alternation did not know ==="
  # Payloads are 21 chars: over the rule's 8-char floor, under the entropy sweep's
  # 24-char floor, and matching no prefix rule — so a green here can only be
  # secret-assignment, never a neighbouring rule covering for it.
  _rule "access_token is a credential key"           secret-assignment \
        "${ATOK} = hunter2-correct-horse"
  _rule "secret_key is a credential key"             secret-assignment \
        "${SKEY} = hunter2-correct-horse"
  _rule "bearer_token is a credential key"           secret-assignment \
        "${BTOK} = hunter2-correct-horse"
  # api_secret is NOT a fourth case of the same kind, and writing it as one would have
  # been vacuous. A DIRECT assignment to `api_secret` ALREADY fired before TOG-406 (not
  # written out: it would be a live assignment in a file that scans itself). The rule
  # has no left boundary, so the bare `secret` alternative matches the tail of it. The
  # issue's table is wrong on that row. Where that spelling was genuinely uncovered is
  # the GUARD, which was anchored `^...$` and so recognised none of the prefixed
  # spellings — measured on this file. Hence an inner-key case, which is the shape that
  # actually changes behaviour: it went CLEAN -> FAIL with TOG-406.
  # It is a regression pin and NOT a coverage claim. The mutation gate says why: this
  # spelling is now reachable by two independent limbs, so no single mutation can redden
  # it, and it is the only case here the gate does not list. The anchor limb it exercises
  # is attributed by the `x-api-key` case below, which nothing else can carry.
  _rule "api_secret as a nested credential key"      secret-assignment \
        "credential: ${ASEC}=hunter2"
  _rule "prefixed nested key is credential-named"    secret-assignment \
        "credential: ${XAK}=hunter2"

  echo "=== TOG-406: ...and the widened alternation must not fire on these ==="
  # Every value here is the SAME 21-char payload the cases above fire on, so a green is
  # a statement about the key name and nothing else. These are the halves of the
  # cross-product that were deliberately left out; without them the prefix and suffix
  # lists could be widened later with nothing to say it had gone too far.
  _clean "public_key is publishable by definition" "public_key = hunter2-correct-horse"
  _clean "client_id is an identifier, not a secret" "client_id = hunter2-correct-horse"
  _clean "next_token is pagination"                 "next_token = hunter2-correct-horse"
  _clean "partition_key is a database key"          "partition_key = hunter2-correct-horse"
  _clean "bare key= is not a credential name"       "key = hunter2-correct-horse"
  # The measured cost of the `app` prefix, kept as a case so re-adding it goes red here
  # rather than in the operator's cron mail. This is a log line, not an assignment: the
  # tool's own name ends in a credential-shaped word and the log's colon separates it
  # from the next word. Assembled at runtime like every other fixture.
  _clean "a log line whose tool name ends in a token" \
         "test_gh_""app_""token: WARNING: could not attribute the seeded cache"

  echo "=== fail-closed behaviour — an unreadable or oversized file is a FAIL ==="
  local d1="$tmp/unreadable"; mkdir -p "$d1"; echo "harmless" > "$d1/secret.txt"; chmod 0000 "$d1/secret.txt"
  if [ "$(id -u)" = "0" ]; then
    printf '  SKIP  %-52s running as root, mode 0000 is not enforced\n' "unreadable file is FAIL"
  else
    _case "unreadable file is FAIL (not a silent skip)" 1 "$d1"
  fi
  chmod 0644 "$d1/secret.txt" 2>/dev/null || true

  local d2="$tmp/oversized"; mkdir -p "$d2"
  head -c 4096 /dev/zero | tr '\0' 'a' > "$d2/big.txt"
  local rc2=0
  STRICT=0 QUIET=1 DROPSCAN_MAX_BYTES=1024 DROPSCAN_ALLOWLIST_FILE="" DROPSCAN_SHARED_UID=0 \
    run_engine "$d2" scan >/dev/null 2>&1 || rc2=$?
  if [ "$rc2" = "1" ]; then pass=$((pass+1)); printf '  PASS  %-52s rc=1\n' "oversized file is FAIL (no silent truncation)"
  else fail=$((fail+1)); c_red "  FAIL  oversized file expected rc=1 got rc=$rc2"; fi

  local d3="$tmp/symlink"; mkdir -p "$d3"; ln -sf /etc/passwd "$d3/link.txt"
  _case "symlink is FAIL and is not followed" 1 "$d3"

  local d4="$tmp/binary"; mkdir -p "$d4"
  printf 'header\x00\x01\x02%s%s\x00trailer' "${SK}" "${A26}${D10:0:6}" > "$d4/blob.bin"
  _case "secret inside a BINARY file is caught" 1 "$d4"

  echo "=== writable-channel detection (every write bit, not just o+w) ==="
  local d5="$tmp/ww"; mkdir -p "$d5"; chmod 0777 "$d5"; echo "hello" > "$d5/ok.txt"
  _case "world-writable root without sticky is FAIL" 1 "$d5"
  chmod 1777 "$d5"
  _case "world-writable root WITH sticky is clean"   0 "$d5"
  # The hole that read like a tightening. This dir is owned by our own gid, so g+w is
  # exploitable by this very process; 0775 must not be quieter than 0777.
  chmod 0775 "$d5"
  _case "group-writable (our gid) without sticky is FAIL" 1 "$d5"
  chmod 1775 "$d5"
  _case "group-writable WITH sticky is clean"             0 "$d5"
  chmod 0770 "$d5"
  _case "g+w no o+r without sticky is still FAIL"         1 "$d5"
  chmod 0755 "$d5"
  _case "0755 root is clean"                              0 "$d5"

  echo "=== a mode acknowledgement never carries across modes ==="
  # Requirement from the operator, 2026-08-23: an ack must stop suppressing if the mode
  # changes again. The fingerprint is bound to the literal mode, so this is structural.
  local d5b="$tmp/wwack"; mkdir -p "$d5b"; echo "hello" > "$d5b/ok.txt"
  local ack="$tmp/ack.allow"
  printf '%s  # 0777 accepted\n' "$(_fp_mode 0777)" > "$ack"
  chmod 0777 "$d5b"
  _case_allow "ack for 0777 suppresses 0777"      0 "$d5b" "$ack"
  chmod 0775 "$d5b"
  _case_allow "ack for 0777 does NOT cover 0775"  1 "$d5b" "$ack"
  chmod 1777 "$d5b"
  _case_allow "sticky needs no ack at all"        0 "$d5b" "$ack"
  chmod 0755 "$d5b"

  # ---------------------------------------------------------------------------------
  # FINDING-B / TOG-344. Both verdicts are driven from FIXTURE passwd files, never from
  # the host's own /etc/passwd, so these cases assert the same thing on a shared-uid box
  # and on an ordinary multi-user one. A test that only passes on the box that has the
  # bug proves nothing about the check.
  # ---------------------------------------------------------------------------------
  _fp_lit() { # literal fingerprint value -> the 12-hex fingerprint the engine uses
    python3 -c 'import hashlib,sys;print(hashlib.sha256(sys.argv[1].encode()).hexdigest()[:12])' "$1"
  }
  _suid_out() { # dir shared_uid passwdfile [allowfile] -> full report text
    STRICT=0 QUIET=0 DROPSCAN_MAX_BYTES="$DROPSCAN_MAX_BYTES" \
      DROPSCAN_SHARED_UID="$2" DROPSCAN_PASSWD_FILE="$3" DROPSCAN_ALLOWLIST_FILE="${4:-}" \
      run_engine "$1" scan 2>&1 || true
  }
  _case_suid() { # name expected_rc dir shared_uid passwdfile [allowfile]
    local nm="$1" expect="$2" dir="$3" su="$4" pw="$5" af="${6:-}" rc=0
    STRICT=0 QUIET=1 DROPSCAN_MAX_BYTES="$DROPSCAN_MAX_BYTES" \
      DROPSCAN_SHARED_UID="$su" DROPSCAN_PASSWD_FILE="$pw" DROPSCAN_ALLOWLIST_FILE="$af" \
      run_engine "$dir" scan >/dev/null 2>&1 || rc=$?
    if [ "$rc" = "$expect" ]; then pass=$((pass+1)); printf '  PASS  %-52s rc=%s\n' "$nm" "$rc"
    else fail=$((fail+1)); c_red "  FAIL  $nm  expected rc=$expect got rc=$rc"; fi
  }
  _has() {   # name haystack needle
    if printf '%s' "$2" | grep -qF -- "$3"; then
      pass=$((pass+1)); printf '  PASS  %-52s present\n' "$1"
    else fail=$((fail+1)); c_red "  FAIL  $1  expected to find: $3"; fi
  }
  _hasnt() { # name haystack needle
    if printf '%s' "$2" | grep -qF -- "$3"; then
      fail=$((fail+1)); c_red "  FAIL  $1  did NOT expect: $3"
    else pass=$((pass+1)); printf '  PASS  %-52s absent\n' "$1"; fi
  }

  echo "=== shared uid: owner-write IS cross-agent write (FINDING-B / TOG-344) ==="
  local pw_shared="$tmp/passwd.shared" pw_multi="$tmp/passwd.multi"
  { echo "root:x:0:0:root:/root:/bin/bash"
    echo "daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin"
    echo "svc:x:998:998::/nonexistent:/usr/sbin/nologin"
    echo "nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin"
    echo "node:x:1000:1000::/paperclip:/bin/bash"; } > "$pw_shared"
  cp "$pw_shared" "$pw_multi"
  echo "alice:x:1001:1001::/home/alice:/bin/bash" >> "$pw_multi"

  local dsu="$tmp/shareduid"; mkdir -p "$dsu"; chmod 0755 "$dsu"
  echo "routine handoff note" > "$dsu/probe.md"
  local MYUID; MYUID="$(id -u)"

  # THE REGRESSION. Before this fix the first line below was rc=0, printed in green.
  _case_suid "0755 agent-owned dir is FAIL under a shared uid"      1 "$dsu" 1 "$pw_shared"
  _case_suid "same dir is CLEAN when the uid is NOT shared"         0 "$dsu" 0 "$pw_shared"
  _case_suid "auto: one interactive account  -> check ON"           1 "$dsu" auto "$pw_shared"
  _case_suid "auto: two interactive accounts -> check off"          0 "$dsu" auto "$pw_multi"
  # Undetectable must be loud. A check that silently defaults to off is the bug itself.
  _case_suid "auto: unreadable passwd is FAIL, never a silent off"  1 "$dsu" auto "$tmp/no-such-passwd"

  # "Regardless of mode" is the whole claim, so it is tested at both extremes: the
  # tightest mode a directory can have, and the mode FINDING-A treats as safe.
  chmod 0700 "$dsu"
  _case_suid "0700 is no safer: mode is irrelevant under one uid"   1 "$dsu" 1 "$pw_shared"
  chmod 1777 "$dsu"
  _case_suid "sticky does not rescue an agent-owned dir either"     1 "$dsu" 1 "$pw_shared"

  # Corollary: sticky protects nothing between agents, because every file has one owner.
  local osu; osu="$(_suid_out "$dsu" 1 "$pw_shared")"
  _has   "sticky root still reports agent-owned FILES exposed" "$osu" "rule=shared-uid-file-integrity"
  _has   "the shared-uid verdict is printed, not implicit"     "$osu" "shared-uid    : ON"
  local osu0; osu0="$(_suid_out "$dsu" 0 "$pw_shared")"
  _has   "the OFF verdict is printed just as loudly"           "$osu0" "shared-uid    : off"
  _hasnt "check off means no shared-uid finding at all"        "$osu0" "rule=dir-agent-owned-shared-uid"
  chmod 0755 "$dsu"

  echo "=== a shared-uid ack is bound to the condition, not to the file count ==="
  local afs="$tmp/shareduid.allow"
  printf '%s # TOG-191 shared runtime uid, accepted by the operator\n' \
    "$(_fp_lit '__shared_uid_file_integrity__')" > "$afs"
  local oack; oack="$(_suid_out "$dsu" 1 "$pw_shared" "$afs")"
  _hasnt "acked file-integrity finding is suppressed"          "$oack" "rule=shared-uid-file-integrity"
  _has   "...and the suppression is printed, not silent"       "$oack" "TOG-191 shared runtime uid"
  _has   "...while the DIRECTORY finding still fires"          "$oack" "rule=dir-agent-owned-shared-uid"
  echo "a second file arrives" > "$dsu/second.md"
  local oack2; oack2="$(_suid_out "$dsu" 1 "$pw_shared" "$afs")"
  _hasnt "ack survives a new file (fingerprint has no count)"  "$oack2" "rule=shared-uid-file-integrity"

  # Directory acks are per-path, so accepting the scan root can never quietly accept a
  # per-agent subdirectory that appears inside it later — the TOG-219 layout exactly.
  mkdir -p "$dsu/per-agent-6a02a7ed"; echo "note" > "$dsu/per-agent-6a02a7ed/n.md"
  local afd="$tmp/shareduid-dir.allow"
  printf '%s # scan root itself accepted\n' "$(_fp_lit "__shareduid_dir_${dsu}_${MYUID}__")" > "$afd"
  local odir; odir="$(_suid_out "$dsu" 1 "$pw_shared" "$afd")"
  _hasnt "ack for the scan root suppresses the scan root"      "$odir" "FAIL  $dsu  -"
  _has   "...but a NESTED agent-owned dir still FAILs"         "$odir" "FAIL  per-agent-6a02a7ed"
  rm -rf "$dsu"

  echo "=== allowlist suppresses by fingerprint, and says so ==="
  local d6="$tmp/allow"; mkdir -p "$d6"
  printf "blob $BLOB\n" > "$d6/sample.txt"
  local fp6; fp6="$(printf '%s' "$BLOB" | sha256sum | cut -c1-12)"
  printf '%s # reviewed: selftest fixture\n' "$fp6" > "$tmp/allow.txt"
  local rc6=0
  STRICT=0 QUIET=1 DROPSCAN_ALLOWLIST_FILE="$tmp/allow.txt" DROPSCAN_SHARED_UID=0 \
    run_engine "$d6" scan >/dev/null 2>&1 || rc6=$?
  if [ "$rc6" = "0" ]; then pass=$((pass+1)); printf '  PASS  %-52s rc=0\n' "allowlisted fingerprint is suppressed"
  else fail=$((fail+1)); c_red "  FAIL  allowlist expected rc=0 got rc=$rc6"; fi
  local out6; out6="$(STRICT=0 QUIET=0 DROPSCAN_ALLOWLIST_FILE="$tmp/allow.txt" DROPSCAN_SHARED_UID=0 run_engine "$d6" scan 2>&1 || true)"
  if printf '%s' "$out6" | grep -q "reviewed: selftest fixture"; then
    pass=$((pass+1)); printf '  PASS  %-52s printed\n' "suppression is visible, not silent"
  else fail=$((fail+1)); c_red "  FAIL  suppression was silent"; fi

  # ---------------------------------------------------------------------------------
  # Regression for [RESOLVED-S1]. These drive the SUBCOMMANDS end to end rather than
  # run_engine, because the bug lived in the bash wrapper's cleanup and was invisible
  # to every engine-level test: the engine returned the right code and the wrapper
  # then threw it away. A printed verdict that disagrees with $? is the failure mode
  # this whole tool exists to catch, so it is tested on the tool itself.
  # ---------------------------------------------------------------------------------
  echo "=== exit code must agree with the printed verdict (subcommand level) ==="
  local dv="$tmp/verify"; mkdir -p "$dv"; echo "stable content" > "$dv/a.txt"
  local manv="$tmp/verify.manifest"
  local rcm=0; "$SELF" manifest --root "$dv" > "$manv" 2>/dev/null || rcm=$?
  if [ "$rcm" = "0" ] && [ -s "$manv" ]; then
    pass=$((pass+1)); printf '  PASS  %-52s rc=0\n' "manifest emits and exits 0"
  else fail=$((fail+1)); c_red "  FAIL  manifest rc=$rcm size=$(wc -c <"$manv" 2>/dev/null || echo 0)"; fi

  local rcv=0; "$SELF" verify --manifest "$manv" --root "$dv" >/dev/null 2>&1 || rcv=$?
  if [ "$rcv" = "0" ]; then
    pass=$((pass+1)); printf '  PASS  %-52s rc=0\n' "verify UNCHANGED prints VERIFIED and exits 0"
  else fail=$((fail+1)); c_red "  FAIL  verify unchanged: printed VERIFIED but exited $rcv"; fi

  echo "tampered" >> "$dv/a.txt"
  local rcv2=0; "$SELF" verify --manifest "$manv" --root "$dv" >/dev/null 2>&1 || rcv2=$?
  if [ "$rcv2" = "1" ]; then
    pass=$((pass+1)); printf '  PASS  %-52s rc=1\n' "verify TAMPERED reports drift and exits 1"
  else fail=$((fail+1)); c_red "  FAIL  verify tampered: expected rc=1 got $rcv2"; fi

  local dc="$tmp/cleanscan"; mkdir -p "$dc"; echo "nothing to see" > "$dc/a.txt"
  local rcs=0; DROPSCAN_SHARED_UID=0 "$SELF" scan --root "$dc" >/dev/null 2>&1 || rcs=$?
  if [ "$rcs" = "0" ]; then
    pass=$((pass+1)); printf '  PASS  %-52s rc=0\n' "scan CLEAN prints CLEAN and exits 0"
  else fail=$((fail+1)); c_red "  FAIL  scan clean: printed CLEAN but exited $rcs"; fi

  echo "=== --strict promotes REVIEW to FAIL ==="
  local d7="$tmp/strict"; mkdir -p "$d7"
  printf "blob $BLOB\n" > "$d7/sample.txt"
  local rc7a=0 rc7b=0
  STRICT=0 QUIET=1 DROPSCAN_ALLOWLIST_FILE="" DROPSCAN_SHARED_UID=0 run_engine "$d7" scan >/dev/null 2>&1 || rc7a=$?
  STRICT=1 QUIET=1 DROPSCAN_ALLOWLIST_FILE="" DROPSCAN_SHARED_UID=0 run_engine "$d7" scan >/dev/null 2>&1 || rc7b=$?
  if [ "$rc7a" = "2" ] && [ "$rc7b" = "1" ]; then
    pass=$((pass+1)); printf '  PASS  %-52s %s->%s\n' "REVIEW-only rc, strict promotes it" "$rc7a" "$rc7b"
  else fail=$((fail+1)); c_red "  FAIL  strict: expected 2 then 1, got $rc7a then $rc7b"; fi

  echo "=== output never contains the secret it found ==="
  local d8="$tmp/leak"; mkdir -p "$d8"
  local SECRET="${SK}${A26}${D10:0:6}"
  printf 'OPENAI_KEY=%s\n' "$SECRET" > "$d8/sample.txt"
  local out8; out8="$(STRICT=0 QUIET=0 DROPSCAN_ALLOWLIST_FILE="" DROPSCAN_SHARED_UID=0 run_engine "$d8" scan 2>&1 || true)"
  if printf '%s' "$out8" | grep -qF "$SECRET"; then
    fail=$((fail+1)); c_red "  FAIL  scanner echoed the secret into its own output"
  else pass=$((pass+1)); printf '  PASS  %-52s masked\n' "matched value is not echoed"; fi
  if printf '%s' "$out8" | grep -q "fp=$(printf '%s' "$SECRET" | sha256sum | cut -c1-12)"; then
    pass=$((pass+1)); printf '  PASS  %-52s present\n' "fingerprint is reported instead"
  else fail=$((fail+1)); c_red "  FAIL  fingerprint missing from output"; fi

  echo "=== self-scan: the pair that proves the fragment trick works ==="
  local d9="$tmp/self"; mkdir -p "$d9"; cp "$SELF" "$d9/scanner.sh"
  _case "this scanner scans ITSELF clean (no self-flagging)" 0 "$d9"
  printf '\n# %s\n' "OPENAI_KEY=${SK}${A26}${D10:0:6}" >> "$d9/scanner.sh"
  _case "planted secret in that same copy IS caught"        1 "$d9"

  echo
  if [ "$fail" -eq 0 ]; then c_grn "selftest: $pass passed, 0 failed"; return 0
  else c_red "selftest: $pass passed, $fail FAILED"; return 1; fi
}

usage() {
  # Was `sed -n '2,100p'`, a hard-coded window onto the header. Adding FINDING-B pushed
  # the header past line 100 and silently truncated `help` mid-sentence. Print the
  # contiguous comment block after the shebang and stop at the first line of code, so
  # the range can never drift out of sync with the header again.
  awk 'NR>=2 { if ($0 ~ /^#/) { sub(/^# ?/, ""); print; next } exit }' "${BASH_SOURCE[0]}"
}

main() {
  local cmd="${1:-help}"; shift || true
  local manifest=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --root)     DROPSCAN_ROOT="${2:-}"; shift 2 ;;
      --manifest) manifest="${2:-}"; shift 2 ;;
      --strict)   STRICT=1; shift ;;
      --quiet)    QUIET=1; shift ;;
      *) refuse "unknown argument: $1" ;;
    esac
  done
  case "$cmd" in
    scan)     cmd_scan ;;
    selftest) cmd_selftest ;;
    manifest) cmd_manifest ;;
    verify)   cmd_verify "$manifest" ;;
    help|-h|--help) usage ;;
    *) refuse "unknown command: $cmd (try: scan, selftest, manifest, verify, help)" ;;
  esac
}

main "$@"
