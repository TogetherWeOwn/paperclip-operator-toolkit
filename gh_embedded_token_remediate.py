#!/usr/bin/env python3
# ===========================================================================
# gh_embedded_token_remediate.py — TOG-3202, adopted into ops-tooling on TOG-3209
# (written and tested against the live incident in the CISO workspace first; the
# body is unchanged apart from the GH_API override the offline suite needs).
#
# WHAT THIS ADDS TO THE EXISTING SWEEP. git_remote_credential_scan.sh (TOG-893)
# finds credentials embedded in git remote URLs, and the documented repair is
#
#     git remote set-url <name> <url-without-credential>
#
# That deletes OUR COPY of the credential. It does not touch the credential.
# A `ghs_` installation token stays valid at GitHub for up to an hour after the
# URL is cleaned, and during that window it is still in every process that read
# the config, in any transcript that echoed it, and in any backup of the tree.
#
# Measured on 2026-09-17 (TOG-3202): the sweep scrubbed a token at ~06:02Z and
# reported the finding remediated. The same token still authenticated to
# api.github.com at 06:07Z and was only killed by an explicit revoke. Scrubbing
# is containment of a copy; revocation is containment of the credential. This
# script does the second one, because nothing else in the toolchain does.
#
# ORDER MATTERS AND IS NOT THE OBVIOUS ONE.
#   1. read + revoke the token   (kills the credential everywhere, at GitHub)
#   2. then scrub the URL        (removes our copy)
# Doing it the other way round means that between the scrub and the revoke you
# no longer hold the token you need in order to revoke it. The scrub destroys
# your only handle on the thing you are trying to kill. That is precisely how
# the 2026-09-17 finding ended up needing a manual recovery from a run-scratch
# cache that could easily have been gone.
#
# REVOCATION IS SELF-AUTHENTICATING. `DELETE /installation/token` authenticates
# with the very token being revoked, so this needs no App PEM, no broker, and no
# permission the leaked token does not already carry. It therefore works even
# when the broker is down — which is when embedded tokens get created.
#
# A REVOKE THAT IS NOT VERIFIED IS NOT A REVOKE. 204 is GitHub saying it
# accepted the request. This re-probes afterwards and requires 401. Anything
# else exits non-zero, because "I asked it to die" is not "it is dead".
#
# THE SECRET NEVER TOUCHES argv, stdout OR stderr. It is read from a file or
# stdin and held in memory. Tokens are identified in all output by a truncated
# SHA-256, which is the same identifier convention the TOG-3199 sweep reports
# use, so findings can be correlated across reports without either of them ever
# naming the secret. `ghs_` tokens are `ghs_` + a dot-separated JWT, so any
# redaction regex that stops at the first dot leaks the tail (TOG-2996).
#
# USAGE
#   gh_embedded_token_remediate.py --repo <path>            # revoke + scrub a checkout
#   gh_embedded_token_remediate.py --repo <path> --dry-run  # report only, change nothing
#   gh_embedded_token_remediate.py --token-file <path>      # revoke a loose token
#   gh_embedded_token_remediate.py --check-file <path>       # liveness only, never revokes
#
# EXIT CODES
#   0  nothing live found, or everything found was revoked AND verified dead
#   1  a live credential was found and could not be verified dead  <-- page someone
#   2  usage / operational error
# ===========================================================================

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

# GH_API exists for test_gh_embedded_token_remediate.sh, which points it at a
# loopback stub; production runs never set it. Same convention as sibling_guard.
API = os.environ.get("GH_API", "https://api.github.com").rstrip("/")
UA = "paperclip-tog-3202-remediate"

# A credential requires a COLON inside the userinfo. `https://x-access-token@host`
# is username-only: it carries no secret and is what a correct broker setup looks
# like, so matching on `[^/@]+@` alone would flag repos that are already right.
# (Same reasoning as git_remote_credential_scan.sh; kept deliberately identical.)
CRED_URL = re.compile(r"^(?P<scheme>https?://)(?P<user>[^/@:\s]+):(?P<secret>[^/@\s]+)@(?P<rest>\S+)$")


def fp(secret: str) -> str:
    """Stable, non-reversible id for a secret. Truncated SHA-256 of the raw bytes."""
    return "sha256:" + hashlib.sha256(secret.encode()).hexdigest()[:12]


def _call(method: str, path: str, token: str):
    req = urllib.request.Request(API + path, method=method)
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", UA)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception as e:                      # network/DNS/TLS
        return "ERR:" + type(e).__name__


def is_live(token: str):
    """True/False, or None when the answer could not be established.

    401 means GitHub looked the credential up and rejected it. Any 2xx/403 means
    it authenticated (403 = authenticated but not entitled to THIS endpoint,
    which is the normal answer for a scoped installation token hitting /user).
    A transport error is NOT evidence of death — an unreachable API and a dead
    token are indistinguishable from the caller's side, and scoring that as
    'dead' is how a live credential gets closed out as remediated.
    """
    st = _call("GET", "/installation/repositories", token)
    if st == 401:
        return False
    if isinstance(st, int) and (200 <= st < 400 or st == 403):
        return True
    return None


def revoke(token: str) -> bool:
    """Revoke, then VERIFY. Returns True only when the token is provably dead."""
    _call("DELETE", "/installation/token", token)
    return is_live(token) is False


def git(repo: str, *args: str, empty_ok: bool = False) -> str:
    """Run git, raising on failure. empty_ok folds `git config`'s no-match rc.

    `git config --get-regexp` exits 1 when nothing matches, which for us is the
    ordinary answer "this checkout has no remotes" — such a repo must read
    CLEAN, not crash. Only rc 1 is folded; any other rc is a real git failure
    and stays loud, because a scrub that silently failed is the worst outcome
    this tool has.
    """
    p = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True)
    if p.returncode != 0 and not (empty_ok and p.returncode == 1):
        raise subprocess.CalledProcessError(p.returncode, p.args, p.stdout, p.stderr)
    return p.stdout.strip()


def remotes_with_creds(repo: str):
    """Yield (remote_name, secret, clean_url) for every credential-bearing remote."""
    out = git(repo, "config", "--local", "--get-regexp", r"^remote\..*\.url$",
              empty_ok=True)
    for line in out.splitlines():
        key, _, url = line.partition(" ")
        m = CRED_URL.match(url)
        if not m:
            continue
        name = key[len("remote."):-len(".url")]
        clean = m.group("scheme") + m.group("rest")
        yield name, m.group("secret"), clean


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", help="checkout whose remotes to revoke then scrub")
    ap.add_argument("--token-file", help="file holding a single token to revoke")
    ap.add_argument("--check-file", help="file holding a token to test; never revokes")
    ap.add_argument("--dry-run", action="store_true", help="report only; revoke nothing, scrub nothing")
    a = ap.parse_args()

    if sum(map(bool, (a.repo, a.token_file, a.check_file))) != 1:
        print("error: pass exactly one of --repo / --token-file / --check-file", file=sys.stderr)
        return 2

    if a.check_file or a.token_file:
        path = a.check_file or a.token_file
        try:
            tok = open(path).read().strip()
        except OSError as e:
            print("error: cannot read token file: %s" % e.strerror, file=sys.stderr)
            return 2
        if not tok:
            print("error: token file is empty", file=sys.stderr)
            return 2
        live = is_live(tok)
        state = {True: "LIVE", False: "dead", None: "UNKNOWN"}[live]
        print("%s %s" % (fp(tok), state))
        if live is None:
            print("  could not reach GitHub; treating as unresolved, not as dead")
            return 1
        if not live:
            return 0
        if a.check_file or a.dry_run:
            print("  live; not revoking (check/dry-run mode)")
            return 1
        ok = revoke(tok)
        print("  revoked and verified dead" if ok else "  REVOKE NOT VERIFIED — still authenticating")
        return 0 if ok else 1

    repo = a.repo
    if not os.path.isdir(os.path.join(repo, ".git")) and not os.path.isfile(os.path.join(repo, ".git")):
        print("error: %s is not a git checkout" % repo, file=sys.stderr)
        return 2

    findings = list(remotes_with_creds(repo))
    if not findings:
        print("CLEAN: no remote URL in %s embeds a credential" % repo)
        return 0

    rc = 0
    for name, secret, clean in findings:
        live = is_live(secret)
        state = {True: "LIVE", False: "dead", None: "UNKNOWN"}[live]
        print("%s remote=%s %s" % (fp(secret), name, state))

        if a.dry_run:
            print("  dry-run: would %sscrub to %s"
                  % ("revoke then " if live else "", clean))
            rc = rc or (1 if live is not False else 0)
            continue

        if live is None:
            # Do not scrub. Scrubbing here would destroy the only handle on a
            # credential whose status we never established.
            print("  could not reach GitHub — leaving URL intact so the token stays revocable")
            rc = 1
            continue

        if live:
            if revoke(secret):
                print("  revoked and verified dead")
            else:
                print("  REVOKE NOT VERIFIED — still authenticating; NOT scrubbing")
                rc = 1
                continue

        git(repo, "remote", "set-url", name, clean)
        print("  scrubbed -> %s" % clean)

    return rc


if __name__ == "__main__":
    sys.exit(main())
