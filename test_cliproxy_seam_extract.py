#!/usr/bin/env python3
# ===========================================================================
# test_cliproxy_seam_extract.py — hostile tests for the v3 seam extractor.
# Every case drives the real CLI in a subprocess against a
# synthetic collector generated at runtime. Planted secrets are assembled by
# concatenation so this file itself carries no secret-shaped literal.
#
# What must hold, and what a plausible-but-wrong extractor would get wrong:
#   * no planted secret reaches the extract OR stdout — in a comment, a
#     docstring, a plain literal, an f-string part, a bytes literal, a helper
#     the anchor calls, or a constant the tail reads;
#   * code the seam does not reach (the management fetcher) is not shipped;
#   * the source is never executed (a top-level side effect stays unfired);
#   * every refusal writes nothing and exits 2.
# ===========================================================================
import ast
import hashlib
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, "cliproxy_seam_extract.py")

TOKEN = "gh" + "p_" + "A1b2C3d4" * 5
MGMT_KEY = "mk" + "-" + "9f8e7d6c5b4a" * 3
HASH64 = "6c" + "ab12" * 15 + "e8"
EMAIL = "ops" + "@" + "example" + ".org"
DOC_SECRET = "sk" + "-" + "Zz9" * 10
BIG_INT = 1234567890123456
F_TOKEN = "xox" + "b-" + "77" * 12

SECRETS = [TOKEN, MGMT_KEY, HASH64, EMAIL, DOC_SECRET, str(BIG_INT), F_TOKEN]


def collector_source(sentinel, anchor="_attach_cooldowns", ident="lane"):
    return f'''#!/usr/bin/env python3
# management key is {MGMT_KEY}
import json, os, re, tempfile, time
OUT = "/srv/cliproxy-usage"
STALE = 300
POOL_ROOT = "/home/ubuntu/stacks/cliproxy/auths/subscription-pool"
MGMT_KEY = "{MGMT_KEY}"
open({sentinel!r}, "w").write("executed")

def _mgmt_get(path):
    """fetch with {TOKEN}"""
    return {{"Authorization": "Bearer " + MGMT_KEY, "path": path}}

def _pool_state(provider):
    """reads {DOC_SECRET}"""
    blob = b"{TOKEN}"
    hint = f"acct {F_TOKEN} for {{provider}}"
    p = os.path.join(POOL_ROOT, "providers", provider, "state.json")
    return {{"path": p, "known": "{HASH64}", "limit": {BIG_INT}, "blob": blob, "hint": hint}}

def {anchor}(records, provider):
    st = _pool_state(provider)
    for r in records:
        r["cooldown_until"] = st.get("exhausted_until")

def _apply_health_floor(records):
    for r in records:
        r.setdefault("health", "healthy")

def _mark_unobserved(records):
    for r in records:
        r.setdefault("observed", False)

now = time.strftime("%Y-%m-%dT%H:%M:%SZ")
files = {{"zai.json": [{{"{ident}": "zai-lane-1", "owner": "{EMAIL}"}}]}}
status = {{"ok": True}}
_FILE_PROVIDER = {{"zai.json": "zai", "opencode-go.json": "opencode-go"}}
for _fname, _payload in files.items():
    if _fname != "model-usage-v1.json" and isinstance(_payload, list):
        _attach_cooldowns(_payload, _FILE_PROVIDER.get(_fname))
        _apply_health_floor(_payload)
        _mark_unobserved(_payload)
for _payload in files.values():
    for r in _payload:
        r.setdefault("account_key", r["lane"])  # {TOKEN}
os.makedirs(OUT, exist_ok=True)
for fname, payload in files.items():
    doc = {{"schemaVersion": 1, "observedAt": now, "staleAfterSeconds": STALE, "records": payload}}
    txt = json.dumps(doc, separators=(",", ":"))
    if re.search(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{{2,}}", txt):
        raise SystemExit(f"identity leak guard tripped in {{fname}}")
    fd, tmp = tempfile.mkstemp(dir=OUT, prefix=".tmp-")
    os.write(fd, txt.encode()); os.close(fd); os.chmod(tmp, 0o640)
    os.replace(tmp, os.path.join(OUT, fname))
'''


def fp(data):
    return hashlib.sha256(data).hexdigest(), len(data), data.count(b"\n")


class SeamExtractTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.sentinel = os.path.join(self.tmp, "SIDE_EFFECT")
        self.outdir = os.path.join(self.tmp, "stage")
        os.mkdir(self.outdir, 0o700)
        os.chmod(self.outdir, 0o700)
        self.out = os.path.join(self.outdir, "seam.py")

    def write_src(self, text, name="cliproxy_usage_snapshot.py"):
        p = os.path.join(self.tmp, name)
        with open(p, "w") as f:
            f.write(text)
        return p

    def run_tool(self, src, sha=None, size=None, nl=None, out=None):
        with open(src, "rb") as f:
            d = f.read()
        s, b, n = fp(d)
        cmd = [sys.executable, "-I", "-B", TOOL, "--source", src,
               "--expect-sha256", sha or s, "--expect-bytes", str(size if size is not None else b),
               "--expect-newlines", str(nl if nl is not None else n),
               "--output", out or self.out]
        return subprocess.run(cmd, capture_output=True, text=True, cwd=self.tmp)

    def assert_refused(self, r, fragment):
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("REFUSED:", r.stderr)
        self.assertIn(fragment, r.stderr)
        self.assertEqual(r.stdout, "")
        self.assertFalse(os.path.exists(self.out), "a refusal must write nothing")

    # --- happy path --------------------------------------------------------
    def test_extract_carries_no_planted_secret(self):
        r = self.run_tool(self.write_src(collector_source(self.sentinel)))
        self.assertEqual(r.returncode, 0, r.stderr)
        with open(self.out) as f:
            text = f.read()
        for s in SECRETS:
            self.assertNotIn(s, text, f"secret leaked into extract: {s[:4]}…")
            self.assertNotIn(s, r.stdout, f"secret leaked into manifest: {s[:4]}…")
        self.assertNotIn("management key is", text, "comments must be dropped")
        self.assertNotIn("fetch with", text, "docstrings must be dropped")

    def test_extract_is_the_seam_and_nothing_unreached(self):
        r = self.run_tool(self.write_src(collector_source(self.sentinel)))
        self.assertEqual(r.returncode, 0, r.stderr)
        with open(self.out) as f:
            text = f.read()
        tree = ast.parse(text)  # must be valid Python for review
        defs = {n.name for n in tree.body if isinstance(n, ast.FunctionDef)}
        self.assertEqual(defs, {"_attach_cooldowns", "_apply_health_floor",
                                "_mark_unobserved", "_pool_state"})
        self.assertNotIn("_mgmt_get", text)
        self.assertNotIn("Authorization", text)
        # Constants the seam reads ship; call-built state is only named.
        self.assertIn("_FILE_PROVIDER = {", text)
        self.assertIn("POOL_ROOT = '/home/ubuntu/stacks/cliproxy/auths/subscription-pool'", text)
        self.assertIn("OUT = '/srv/cliproxy-usage'", text)
        self.assertIn("os.replace(tmp, os.path.join(OUT, fname))", text)
        self.assertIn("identity leak guard tripped", text)
        self.assertTrue(text.startswith("# REVIEW-ONLY EXTRACT"))
        m = json.loads(r.stdout)
        # `now` is built by a call, so only its name is listed. The literal
        # `files` dict ships, with the owner address redacted.
        self.assertEqual(m["referenced_not_shipped"], ["now"])
        self.assertIn(f"'owner': '<redacted:str:len={len(EMAIL)}>'", text)
        self.assertNotIn("MGMT_KEY", text)

    def test_redaction_markers_and_counts(self):
        r = self.run_tool(self.write_src(collector_source(self.sentinel)))
        self.assertEqual(r.returncode, 0, r.stderr)
        with open(self.out) as f:
            text = f.read()
        self.assertIn(f"<redacted:str:len={len(HASH64)}>", text)
        self.assertIn(f"<redacted:bytes:len={len(TOKEN)}>", text)
        self.assertIn("_REDACTED_INT", text)
        m = json.loads(r.stdout)
        c = m["counts"]
        self.assertEqual(c["bytes_redacted"], 1)
        self.assertEqual(c["int_redacted"], 1)
        self.assertGreaterEqual(c["str_redacted"], 3)  # hash, owner email, f-string part
        self.assertEqual(c["docstrings_dropped"], 1)   # _pool_state; _mgmt_get never shipped
        self.assertTrue(m["source"]["verified"])
        with open(self.out, "rb") as f:
            self.assertEqual(m["extract"]["sha256"], hashlib.sha256(f.read()).hexdigest())

    def test_source_is_never_executed_or_compiled(self):
        r = self.run_tool(self.write_src(collector_source(self.sentinel)))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse(os.path.exists(self.sentinel), "collector top level ran")
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "__pycache__")))

    def test_output_is_private(self):
        r = self.run_tool(self.write_src(collector_source(self.sentinel)))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(stat.S_IMODE(os.stat(self.out).st_mode), 0o600)

    # --- refusals ----------------------------------------------------------
    def test_refuses_baseline_drift(self):
        src = self.write_src(collector_source(self.sentinel))
        self.assert_refused(self.run_tool(src, sha="0" * 64), "baseline mismatch on sha256")
        self.assert_refused(self.run_tool(src, size=57397), "bytes")
        self.assert_refused(self.run_tool(src, nl=825), "newlines")

    def test_refuses_symlinked_source(self):
        real = self.write_src(collector_source(self.sentinel), "real.py")
        link = os.path.join(self.tmp, "link.py")
        os.symlink(real, link)
        with open(real, "rb") as f:
            s, b, n = fp(f.read())
        self.assert_refused(self.run_tool(link, sha=s, size=b, nl=n), "without following links")

    def test_refuses_symlinked_parent(self):
        realdir = os.path.join(self.tmp, "realdir")
        os.mkdir(realdir)
        with open(os.path.join(realdir, "c.py"), "w") as f:
            f.write(collector_source(self.sentinel))
        os.symlink(realdir, os.path.join(self.tmp, "linkdir"))
        self.assert_refused(self.run_tool(os.path.join(self.tmp, "linkdir", "c.py")),
                            "parent directory is a symlink")

    def test_refuses_existing_output(self):
        src = self.write_src(collector_source(self.sentinel))
        with open(self.out, "w") as f:
            f.write("prior")
        r = self.run_tool(src)
        self.assertEqual(r.returncode, 2)
        self.assertIn("output path already exists", r.stderr)
        with open(self.out) as f:
            self.assertEqual(f.read(), "prior")

    def test_refuses_non_private_output_dir(self):
        src = self.write_src(collector_source(self.sentinel))
        os.chmod(self.outdir, 0o755)
        self.assert_refused(self.run_tool(src), "mode 0700")

    def test_refuses_missing_anchor(self):
        src = self.write_src(collector_source(self.sentinel, anchor="_attach_cooldowns_v2"))
        self.assert_refused(self.run_tool(src), "anchor not found: _attach_cooldowns")

    def test_refuses_secret_shaped_identifier(self):
        ident = "k" + "a1b2c3d4" * 3
        src = self.write_src(collector_source(self.sentinel, ident="lane").replace(
            "st = _pool_state(provider)", f"{ident} = 1\n    st = _pool_state(provider)"))
        self.assert_refused(self.run_tool(src), "secret-shaped identifier")

    def test_rendered_rescan_refuses_what_the_redactor_passes(self):
        # Floats are not redacted, so a long mantissa renders as a 16-digit
        # run. Only the post-render re-scan can stop it.
        src = self.write_src(collector_source(self.sentinel).replace(
            "STALE = 300", "STALE = 300\nEPOCH = 1234567890123456.0").replace(
            "st = _pool_state(provider)", "st = _pool_state(provider); _ = EPOCH"))
        self.assert_refused(self.run_tool(src), "still matches a secret detector")

    def test_refuses_unparseable_source(self):
        src = self.write_src("def _attach_cooldowns(:\n")
        self.assert_refused(self.run_tool(src), "does not parse")


class DetectorTest(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0, HERE)
        import cliproxy_seam_extract as m
        self.m = m

    def test_secret_shapes_are_refused(self):
        for s in SECRETS[:5] + [F_TOKEN, "https://u:p@h/x", "-----BEGIN KEY", "x" * 97,
                                "tab\there", "AKIA" + "ABCD"]:
            self.assertFalse(self.m.literal_allowed(s), s[:6])

    def test_schema_literals_are_kept(self):
        for s in ["zai.json", "opencode-go", "exhausted_until", "/srv/cliproxy-usage",
                  "api.z.ai/monitor/usage/quota/limit", ".tmp-", "%Y-%m-%dT%H:%M:%SZ",
                  r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}",
                  "/home/ubuntu/paperclip-enterprise-company/cliproxy_usage_snapshot.py"]:
            self.assertTrue(self.m.literal_allowed(s), s)


if __name__ == "__main__":
    unittest.main(verbosity=2)
