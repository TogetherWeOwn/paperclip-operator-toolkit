"""Behavioral acceptance tests for Land #940: the org SSRF/redirect +
extended-secrets security packs, mirrored into this public repo at
templates/org-github/.

These pin the properties that make the packs safe to adopt, each named
for the production change that would break it:

- The SSRF pack carries exactly the four WARN-first rules (dynamic
  fetch JS/TS + Python, non-literal redirect JS/TS + Python) and the
  secrets pack exactly the six ERROR rules (real-shape Discord, Slack,
  AWS, OpenAI, Stripe-live, GitHub credentials) -- a silently dropped
  rule id is a silently uncovered attack class.
- Severities stay WARN-first for SSRF/redirect (triage hint only; the
  gate flips report-only -> enforcing as a whole) and ERROR for
  committed secrets, every rule is tier0-live, and every rule stays out
  of test/spec/fixture/vendor paths.
- The URL-shape regexes fire on input-influenced URL expressions and
  stay silent on string literals (proven by evaluating the staged
  expressions, not by reading the rule file), and the redirect rules
  skip literal targets in either argument position.
- Every secrets pattern-regex fires on its real-shape canary and stays
  silent on short test-fixture canaries and documented EXAMPLE
  placeholders -- evaluated per rule with its own pattern-not guards,
  mirroring semgrep match/skip semantics.
- The staged rules embed no real-shaped secret outside their own
  pattern definitions, so the repo's own scan stays clean.
- The shared CodeQL config selects the security-extended suite with no
  custom query paths, and the port-additions manifest lists exactly the
  post-pin files in the machine shape the drift gate parses.
- The always-run local secret scan trips on each new zero-FP shape and
  names it, stays clean on the short fixture canary suites plant at
  runtime, and keeps its pre-existing GitHub-token and private-key
  coverage -- executed in disposable git repos, never in this checkout.

Hermetic: stdlib only, no network, no credentials, no semgrep install
(the tier-0 Gate 5 folder scan stays the engine; the staged contract
suite executes the rules wherever semgrep is on PATH). Canaries are
assembled from split non-secret fragments at runtime so this file never
contains a scannable shape -- the extended scan stays strict with no
test-path exemptions.

RED before the Land #940 mirror: the staged tree is absent and every
test fails on that fact. GREEN after: all pass.
"""

import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BASE = ROOT / "templates" / "org-github"
RULES_DIR = BASE / "tier-0" / "semgrep-rules"
SSRF = RULES_DIR / "security-ssrf-redirect.yaml"
SECRETS = RULES_DIR / "security-secrets-extended.yaml"
MANIFEST = BASE / "tier-0" / "PORT-ADDITIONS.md"
CODEQL = BASE / "codeql" / "codeql-config.yml"
SCAN = ROOT / "verification" / "secret-scan.sh"

SSRF_IDS = (
    "tier0-ssrf-dynamic-fetch-js",
    "tier0-ssrf-dynamic-url-py",
    "tier0-open-redirect-js",
    "tier0-open-redirect-py",
)
SECRETS_IDS = (
    "tier0-secret-discord-webhook",
    "tier0-secret-slack-token",
    "tier0-secret-aws-key",
    "tier0-secret-openai-key",
    "tier0-secret-stripe-live-key",
    "tier0-secret-github-token",
)

# Canary fragments: joined at runtime only, so this file never holds an
# adjacent scannable shape.
DISC = "discord"
DISC_APP = "discordapp"
WEB = ".com/api/"
HOOKS = "webhooks/"
CHAN_A = "123456"
CHAN_B = "789012345678"
TOK_A = "abcdefghijklmnop"
TOK_B = "qrstUVWXYZ012345"
SLACK_P = "xoxb-"
SLACK_BODY = "4827364927364-5827364927364-2hWdFy7ejxVuN3P8F6aZbCdE9"
AWS_P = "AKIA"
AWS_BODY = "QWERTYUIOPASDFGH"
AWS_EXAMPLE = "IOSFODNN7EXAMPLE"
OPENAI_P = "sk-"
OPENAI_PROJ = "proj-"
OPENAI_BODY = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMn"
STRIPE_SK = "sk_"
STRIPE_RK = "rk_"
LIVE = "live_"
STRIPE_BODY = "abcDEF1234567890"
GH_P = "ghp_"
GH_BODY = "AbCdEfGhIjKlMnOp"
GH_PAT = "github_pat_"
KEY_BEG = "BEGIN "
KEY_ALG = "RSA "
KEY_TAIL = "PRIVATE KEY"


def discord_url(host=DISC):
    return "https://" + host + WEB + HOOKS + CHAN_A + CHAN_B + "/" + TOK_A + TOK_B


RULE_RE = re.compile(r"^  - id: (\S+)\s*$", re.M)


def split_rules(text):
    """Split a staged rules file into (id, block) pairs by indentation."""
    starts = [(m.group(1), m.start()) for m in RULE_RE.finditer(text)]
    blocks = {}
    for i, (rid, start) in enumerate(starts):
        end = starts[i + 1][1] if i + 1 < len(starts) else len(text)
        blocks[rid] = text[start:end]
    return blocks


def one(block, pattern):
    m = re.search(pattern, block, re.M)
    return m.group(1) if m else None


def rule_languages(block):
    raw = one(block, r"^\s+languages: \[(.*?)\]")
    return [p.strip() for p in raw.split(",")] if raw else []


def rule_severity(block):
    return one(block, r"^\s+severity: (\S+)")


def rule_tier0(block):
    return one(block, r'tier0:\s*"([^"]+)"')


def list_values(block, key):
    return re.findall(r"^\s+- " + key + r": '(.*)'\s*$", block, re.M)


def exclude_entries(block):
    after_paths = block.split("paths:", 1)
    scope = after_paths[1] if len(after_paths) > 1 else ""
    return re.findall(r'^\s+- "?([^"\s]+)"?\s*$', scope, re.M)


def url_regex(block):
    m = re.search(r"metavariable: \$URL\n\s+regex: (.+)$", block, re.M)
    return m.group(1).strip() if m else None


def secrets_rule_fires(block, text):
    """Any positive pattern-regex matches and no pattern-not-regex does."""
    positives = list_values(block, "pattern-regex")
    negatives = list_values(block, "pattern-not-regex")
    if not positives:
        return None
    hit = any(re.search(p, text) for p in positives)
    skip = any(re.search(p, text) for p in negatives)
    return hit and not skip


class StagedTreeCase(unittest.TestCase):
    def setUp(self):
        self.assertTrue(
            BASE.is_dir(),
            "templates/org-github/ absent -- the Land #940 security "
            "packs have not been mirrored into this public repo",
        )
        for path in (SSRF, SECRETS, MANIFEST, CODEQL, SCAN):
            self.assertTrue(
                path.is_file(), f"missing staged file: {path.relative_to(ROOT)}"
            )


class RuleInventoryTest(StagedTreeCase):
    def test_packs_carry_exactly_the_landing_rule_ids(self):
        # A dropped id is an uncovered class; an extra id is an
        # unreviewed rule riding the landing.
        ssrf = split_rules(SSRF.read_text())
        secrets = split_rules(SECRETS.read_text())
        self.assertEqual(set(ssrf), set(SSRF_IDS))
        self.assertEqual(set(secrets), set(SECRETS_IDS))

    def test_ssrf_rules_are_warn_first(self):
        # WARNING is a triage hint only; the gate flips report-only ->
        # enforcing as a whole, so per-rule ERROR here would silently
        # promote one rule ahead of the measured rollout.
        for rid, block in split_rules(SSRF.read_text()).items():
            self.assertEqual(rule_severity(block), "WARNING", rid)

    def test_secrets_rules_are_error(self):
        # A committed credential is compromised on landing: ERROR, with
        # the gate mode deciding when it fires.
        for rid, block in split_rules(SECRETS.read_text()).items():
            self.assertEqual(rule_severity(block), "ERROR", rid)

    def test_every_rule_is_tier0_live(self):
        for path in (SSRF, SECRETS):
            for rid, block in split_rules(path.read_text()).items():
                self.assertEqual(rule_tier0(block), "live", f"{path.name}/{rid}")

    def test_rule_languages_match_the_pack_split(self):
        ssrf = split_rules(SSRF.read_text())
        self.assertEqual(rule_languages(ssrf["tier0-ssrf-dynamic-fetch-js"]),
                         ["javascript", "typescript"])
        self.assertEqual(rule_languages(ssrf["tier0-open-redirect-js"]),
                         ["javascript", "typescript"])
        self.assertEqual(rule_languages(ssrf["tier0-ssrf-dynamic-url-py"]),
                         ["python"])
        self.assertEqual(rule_languages(ssrf["tier0-open-redirect-py"]),
                         ["python"])
        for rid, block in split_rules(SECRETS.read_text()).items():
            self.assertEqual(rule_languages(block), ["generic"], rid)

    def test_every_rule_excludes_test_fixture_vendor_paths(self):
        for path in (SSRF, SECRETS):
            for rid, block in split_rules(path.read_text()).items():
                blob = "\n".join(exclude_entries(block))
                for needle in ("test", "vendor", "fixture"):
                    self.assertIn(needle, blob, f"{path.name}/{rid} excludes {needle}")

    def test_every_rule_is_complete(self):
        for path in (SSRF, SECRETS):
            for rid, block in split_rules(path.read_text()).items():
                for key in ("languages:", "message:", "severity:"):
                    self.assertIn(key, block, f"{path.name}/{rid} has {key}")
                self.assertTrue(
                    "patterns:" in block or "pattern:" in block
                    or "pattern-regex" in block,
                    f"{path.name}/{rid} carries patterns",
                )


class SsrfShapeTest(StagedTreeCase):
    def test_fetch_rules_cover_each_client_shape(self):
        ssrf = split_rules(SSRF.read_text())
        js = ssrf["tier0-ssrf-dynamic-fetch-js"]
        self.assertIn("fetch($URL", js)
        self.assertIn("axios.$METHOD($URL", js)
        py = ssrf["tier0-ssrf-dynamic-url-py"]
        self.assertIn("requests.$METHOD($URL", py)
        self.assertIn("httpx.$METHOD($URL", py)
        self.assertIn("urllib.request.urlopen($URL", py)

    def test_redirect_rules_cover_each_framework_shape(self):
        ssrf = split_rules(SSRF.read_text())
        js = ssrf["tier0-open-redirect-js"]
        self.assertIn("$RES.redirect($URL", js)
        self.assertIn("NextResponse.redirect($URL", js)
        self.assertIn("redirect($URL", js)
        py = ssrf["tier0-open-redirect-py"]
        self.assertIn("redirect($URL", py)
        self.assertIn("HttpResponseRedirect($URL", py)
        self.assertIn("RedirectResponse($URL", py)

    def test_redirect_rules_skip_literal_targets(self):
        # Literals never match: without the pattern-not skips every
        # hardcoded redirect would fire.
        ssrf = split_rules(SSRF.read_text())
        for rid in ("tier0-open-redirect-js", "tier0-open-redirect-py"):
            skips = re.findall(r"^\s+- pattern-not: (.*)$", ssrf[rid], re.M)
            self.assertTrue(skips, f"{rid} skips literal targets")
            self.assertTrue(any('"..."' in s for s in skips),
                            f"{rid} skips a quoted literal target")

    def test_url_shape_fires_on_input_silent_on_literal(self):
        # The FP-budget property, evaluated: the staged $URL expression
        # must match a request-influenced URL and must not match a plain
        # string literal.
        ssrf = split_rules(SSRF.read_text())
        cases = (
            ("tier0-ssrf-dynamic-fetch-js", "req.query.url", True),
            ("tier0-ssrf-dynamic-fetch-js", "https://api.internal/health", False),
            ("tier0-ssrf-dynamic-url-py", 'request.args["u"]', True),
            ("tier0-ssrf-dynamic-url-py", "https://api.internal/health", False),
            ("tier0-open-redirect-js", "req.query.next", True),
            ("tier0-open-redirect-py", 'request.args["next"]', True),
        )
        for rid, url, expected in cases:
            regex = url_regex(ssrf[rid])
            self.assertIsNotNone(regex, f"{rid} constrains $URL")
            got = re.search(regex, url) is not None
            self.assertEqual(got, expected, f"{rid} on {url!r}")


class SecretsRegexTest(StagedTreeCase):
    def test_real_shapes_fire_short_and_example_shapes_stay_silent(self):
        secrets = split_rules(SECRETS.read_text())
        discord = discord_url()
        discord_app = discord_url(DISC_APP)
        cases = [
            ("tier0-secret-discord-webhook", discord, True),
            ("tier0-secret-discord-webhook", discord_app, True),
            ("tier0-secret-discord-webhook",
             "https://discord.com/api/webhooks/123/abc", False),
            ("tier0-secret-slack-token", SLACK_P + SLACK_BODY, True),
            ("tier0-secret-slack-token", "xoxb-EXAMPLE-TOKEN-FOR-DOCS-12345", False),
            ("tier0-secret-aws-key", AWS_P + AWS_BODY, True),
            ("tier0-secret-aws-key", AWS_P + AWS_EXAMPLE, False),
            ("tier0-secret-openai-key", OPENAI_P + OPENAI_PROJ + OPENAI_BODY, True),
            ("tier0-secret-openai-key",
             OPENAI_P + OPENAI_BODY[:32], True),
            ("tier0-secret-openai-key",
             "risk-assessmentconfigurationmanager", False),
            ("tier0-secret-stripe-live-key", STRIPE_SK + LIVE + STRIPE_BODY, True),
            ("tier0-secret-stripe-live-key", STRIPE_RK + LIVE + STRIPE_BODY, True),
            ("tier0-secret-stripe-live-key", STRIPE_SK + LIVE + "abc", False),
            ("tier0-secret-github-token", GH_P + GH_BODY, True),
            ("tier0-secret-github-token", GH_PAT + GH_BODY + "Qr", True),
            ("tier0-secret-github-token", GH_P + "abc", False),
        ]
        for rid, text, expected in cases:
            got = secrets_rule_fires(secrets[rid], text)
            self.assertIsNotNone(got, f"{rid} carries pattern-regex")
            self.assertEqual(got, expected, f"{rid} on {text[:40]!r}")

    def test_staged_rules_embed_no_real_secret(self):
        # Examples stay truncated or EXAMPLE-marked, so the repo's own
        # scan stays clean after the mirror.
        canaries = [
            discord_url(),
            discord_url(DISC_APP),
            SLACK_P + SLACK_BODY,
            AWS_P + AWS_BODY,
            OPENAI_P + OPENAI_PROJ + OPENAI_BODY,
            STRIPE_SK + LIVE + STRIPE_BODY,
            STRIPE_RK + LIVE + STRIPE_BODY,
            GH_P + GH_BODY,
        ]
        for path in (SSRF, SECRETS):
            text = path.read_text()
            for canary in canaries:
                self.assertNotIn(canary, text, f"{path.name} embeds a real shape")


class CodeqlConfigTest(StagedTreeCase):
    def test_shared_config_selects_security_extended(self):
        text = CODEQL.read_text()
        self.assertIn("security-extended", text)

    def test_shared_config_carries_no_custom_query_paths(self):
        # Custom queries arrive per language with the central-repo
        # rollout; a local path here would 404 every consumer.
        uses = re.findall(r"^\s+- uses: (\S+)\s*$", CODEQL.read_text(), re.M)
        self.assertTrue(uses, "codeql config lists queries")
        for entry in uses:
            self.assertNotIn("/", entry, f"custom query path: {entry}")


class ManifestTest(StagedTreeCase):
    def test_manifest_machine_lists_both_rule_files(self):
        text = MANIFEST.read_text()
        for rule in ("security-ssrf-redirect.yaml", "security-secrets-extended.yaml"):
            self.assertRegex(
                text,
                r"(?m)^- `semgrep-rules/" + re.escape(rule) + r"` — ",
                f"manifest machine-list bullet for {rule}",
            )

    def test_manifest_records_the_coverage_gain(self):
        text = MANIFEST.read_text()
        self.assertIn("12 live", text)
        self.assertIn("4 of 4", text)
        self.assertIn("codeql-config.yml", text)


class SecretScanBehaviorTest(StagedTreeCase):
    GITIGNORE = ["*.env", "*.pem", "*.key", "*.jsonl",
                 ".gh-app-token.json", "__pycache__/", "*.pyc"]

    def setUp(self):
        super().setUp()
        self.work = Path(tempfile.mkdtemp(prefix="secpacks"))
        self.addCleanup(shutil.rmtree, self.work, True)

    def fresh_repo(self):
        repo = Path(tempfile.mkdtemp(dir=str(self.work)))
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
        (repo / ".gitignore").write_text("\n".join(self.GITIGNORE) + "\n")
        subprocess.run(["git", "-C", str(repo), "add", ".gitignore"], check=True)
        return repo

    def run_scan(self, repo):
        proc = subprocess.run(
            ["bash", str(SCAN)], cwd=str(repo),
            capture_output=True, text=True,
        )
        return proc.returncode, proc.stdout + proc.stderr

    def assert_trips(self, content, expect):
        repo = self.fresh_repo()
        (repo / "canary.txt").write_text(content + "\n")
        subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
        rc, out = self.run_scan(repo)
        self.assertNotEqual(rc, 0, f"scan passes on {expect} canary")
        self.assertIn(expect, out, f"scan names the {expect} shape")

    def test_each_new_shape_trips_and_names_itself(self):
        self.assert_trips('url = "%s"' % discord_url(), "Discord-webhook")
        self.assert_trips('url = "%s"' % discord_url(DISC_APP), "Discord-webhook")
        self.assert_trips("key = \"%s\"" % (STRIPE_SK + LIVE + STRIPE_BODY),
                          "Stripe-live-key")
        self.assert_trips("key = \"%s\"" % (STRIPE_RK + LIVE + STRIPE_BODY),
                          "Stripe-live-key")

    def test_short_fixture_canary_stays_clean(self):
        repo = self.fresh_repo()
        (repo / "short.txt").write_text(
            "x=https://discord.com/api/webhooks/123/abc\n")
        subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
        rc, out = self.run_scan(repo)
        self.assertEqual(rc, 0, f"scan trips on the short fixture canary: {out}")

    def test_pre_existing_coverage_survives_the_rollout(self):
        self.assert_trips("token = \"%s\"" % (GH_P + GH_BODY), "GitHub-token")
        self.assert_trips("-----" + KEY_BEG + KEY_ALG + KEY_TAIL + "-----",
                          "private key")


class SuiteSelfCleanTest(StagedTreeCase):
    def test_new_scan_shapes_find_nothing_in_these_suites(self):
        # These suites stay committable under the extended scan they
        # pin: canaries live in memory only, never as adjacent literals.
        text = SCAN.read_text()
        patterns = []
        for line in text.splitlines():
            if "api/webhooks" in line or "sk_live_" in line or "rk_live_" in line:
                m = re.search(r"git grep -nE '([^']+)'", line)
                if m:
                    patterns.append(m.group(1))
        self.assertTrue(patterns, "extended scan carries the new shapes")
        for suite in (Path(__file__).name, "test_security_packs_placement.sh"):
            blob = (ROOT / suite).read_bytes().decode()
            for pattern in patterns:
                self.assertIsNone(re.search(pattern, blob),
                                  f"extended shape matches {suite}")


if __name__ == "__main__":
    unittest.main()
