#!/usr/bin/env python3
"""
Snapshot sections — the `combos` and `model_combo_mappings` sections for the operator snapshot.

WHY THIS FILE EXISTS, AND WHY IT IS NOT AN EDIT TO omniroute_snapshot.py
-----------------------------------------------------------------------
The upstream snapshot builder runs host-side and keeps the master key there, so the
extension cannot be written as a diff against a file this repo cannot open, and it
must not be written as a from-memory reconstruction of one -- a self-authored mock
validates only its author's dialect.

What CAN be produced from inside a run, and is the only honest deliverable, is the part
that carries the whole risk: the two redaction functions, with their allowlists derived
from omniroute's own shipped schema and proven against hostile fixtures. The operator
wires this in and calls the two builders. The transport (auth, HTTP, file append, 0644,
`once|watch|mark`) stays host-side, unchanged, unreviewed by me.

WIRING IT IN -- two routes:

  (1) SUBPROCESS (recommended -- keeps the refuse-to-emit gate):

        out = subprocess.run(
            [sys.executable, "omniroute/snapshot_sections.py", "--build", "-",
             "--kind", "combos"],
            input=json.dumps(GET("/api/combos")),
            capture_output=True, text=True, check=True)
        snap["combos"] = json.loads(out.stdout)

      `--build` re-audits its own output and exits 1 WITHOUT printing if redaction left
      anything credential-shaped, so a leak aborts the snapshot instead of appending to a
      world-readable file. `check=True` turns that into an exception.

  (2) IN-PROCESS, via an explicit loader:

        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "snapshot_sections", "/path/to/snapshot_sections.py")
        snapshot_sections = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(snapshot_sections)
        snap["combos"]   = snapshot_sections.build_combos_section(GET("/api/combos"))
        snap["mappings"] = snapshot_sections.build_mappings_section(
            GET("/api/model-combo-mappings"))

      Taking this route means calling `snapshot_sections.audit(section)` yourself and refusing to
      write on a non-empty result -- route (1) does that for you.

THE FINDING THAT DETERMINES THE DESIGN
--------------------------------------
`combos.data` is one opaque TEXT blob -- `JSON.stringify(combo)` of the entire object
(src/lib/db/repositories/sqliteComboRepository.ts:207). And `comboRuntimeConfigSchema`
ends in `.passthrough()` (src/shared/validation/schemas/combo.ts:279), so `config`
ACCEPTS AND PERSISTS ARBITRARY UNKNOWN KEYS. There is no fixed key set to enumerate and
no upstream validation that would reject a credential parked in a combo's config.

Therefore a denylist over combo data cannot be made safe: it can only remove the key
names somebody thought of, and `.passthrough()` guarantees the set of possible names is
open. This module is a STRUCTURAL ALLOWLIST -- it names the ~20 fields it copies, copies
those by exact key, and drops the entire remainder including every passthrough key,
unread. That matches how the existing `connections` section already behaves (9 keys
copied out of a provider row that carries access_token / refresh_token / api_key /
id_token) and it is the property the issue asks to preserve.

Free-text fields are the second half of the risk and are NOT copied by value. A combo
carries `system_message` (up to 50,000 chars), a per-step `prompt` (up to 20,000) and
`description` (up to 2,000). Those are operator-authored prose that no schema constrains,
so a pasted key would sit in them verbatim. They are reduced to presence + length +
sha256 -- enough to diff a change, insufficient to leak the content. That is a
deliberate fidelity loss: this channel proves WHETHER a protected combo changed, not
what its prompt says.

`model_combo_mappings` carries no credential-shaped column at all (migration
010_model_combo_mappings.sql: id, pattern, combo_id, priority, enabled, description,
created_at, updated_at). It is copied in full except `description`, which is free text
and gets the same digest treatment.

ABSENT vs EMPTY
---------------
Both builders emit the `_dbPresence` discipline the `settings` section already uses,
because a leaf-key walker cannot prove a key is absent -- an empty container emits no
leaves, and absent-vs-empty imply OPPOSITE rollback behaviour. A combo with no
`system_message` row must be restored by DELETING the key, not by writing "". So each
record reports which of the digest-carrying fields were absent as against present-but-
empty, and `_unknownKeysDropped` names the keys this module refused to copy, so a
schema addition upstream is visible in the snapshot instead of being silently swallowed.

VERIFY BEFORE THE FIRST WRITE
-----------------------------
    python3 omniroute/snapshot_sections.py --selftest    # hostile fixtures, exit 1 on leak
    python3 omniroute/snapshot_sections.py --audit FILE  # scan a built section for secrets

`--selftest` plants real-shaped credentials in the positions redaction is responsible
for -- passthrough config keys, nested step objects, system_message, arbitrary depth --
and fails if any survives. Run it against the redacted OUTPUT, never against the input.

It does NOT prove the auditor finds every credential. `SECRET_PATTERNS` is an allowlist
of KNOWN shapes, and it only sees content in positions the structural allowlist copies.
A credential pasted into an allowlisted scalar -- a combo `name`, a `strategy`, a
`modelPattern` -- passes clean if its shape is not listed. The structural allowlist is
the real control here; the auditor is a backstop against it, not a proof of absence.

`--build` has TWO gates and they answer different questions. `audit()` is
confidentiality: did a credential survive redaction (exit 1). `integrity_warnings()` is
integrity: does any part of the document say "empty by failure, not by fact" (exit 3).
A section can audit perfectly clean and still be a false clean baseline, so both gates
refuse to emit -- stdout is piped straight into the world-readable snapshot file.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from typing import Any

SCHEMA_VERSION = "snapshot-sections/1"

# ── Allowlists ───────────────────────────────────────────────────────────────
#
# Derived from omniroute@3.8.50's own schema, not from a hand-written guess:
#   combos              src/shared/validation/schemas/combo.ts  (createComboSchema)
#   ComboStep           src/lib/combos/steps.ts
#   mappings            src/lib/db/migrations/010_model_combo_mappings.sql
#
# Every field here is structural -- an identifier, an enum, a number or a bool. Nothing
# in these sets is free text, and nothing is operator-supplied prose. Adding a key here
# is a security decision: it must be re-audited, because this file is appended to a
# world-readable (0644) channel that every agent on this box can read.

COMBO_SCALARS = (
    "id",
    "name",
    "strategy",
    "sortOrder",
    "isActive",
    "contextLength",
    "contextCacheProtection",
    "dimensions",
    "createdAt",
    "updatedAt",
    "created_at",
    "updated_at",
    "context_length",
    "context_cache_protection",
)

# String lists whose members are identifiers/globs, safe to copy by value.
COMBO_STR_LISTS = ("allowedProviders", "allowedModelFamilies")

# Step fields. `prompt` and `label` are deliberately absent -- see STEP_DIGEST_FIELDS.
STEP_SCALARS = (
    "id",
    "kind",
    "model",
    "provider",
    "providerId",
    "connectionId",
    "comboName",
    "modelPattern",
    "weight",
    "fallbackOnlyOnQuotaExhaustion",
)
STEP_STR_LISTS = ("tags", "allowedConnectionIds")

# Free text -> presence + length + sha256 only. Never copied by value.
COMBO_DIGEST_FIELDS = ("description", "system_message", "tool_filter_regex")
STEP_DIGEST_FIELDS = ("prompt", "label")
MAPPING_DIGEST_FIELDS = ("description",)

MAPPING_SCALARS = (
    "id",
    "pattern",
    "comboId",
    "combo_id",
    "comboName",
    "combo_name",
    "priority",
    "enabled",
    "createdAt",
    "updatedAt",
    "created_at",
    "updated_at",
)

# `config` is .passthrough(): unknown keys persist. So config is NOT copied wholesale.
# Only these routing-shaped knobs are, by exact name. Everything else is dropped unread
# and reported by name in _unknownKeysDropped.
CONFIG_SCALARS = (
    "strategy",
    "maxRetries",
    "retryDelayMs",
    "fallbackDelayMs",
    "timeoutMs",
    "targetTimeoutMs",
    "concurrencyPerModel",
    "queueTimeoutMs",
    "queueDepth",
    "stickyRoundRobinLimit",
    "stickyWeightedLimit",
    "disableSessionStickiness",
    "healthCheckEnabled",
    "healthCheckTimeoutMs",
    "maxComboDepth",
    "maxGlobalAttempts",
    "nestedComboMode",
    "trackMetrics",
    "compressionMode",
    "failoverBeforeRetry",
    "maxSetRetries",
    "setRetryDelayMs",
    "zeroLatencyOptimizationsEnabled",
    "hedging",
    "hedgeDelayMs",
    "fallbackCompressionMode",
    "fallbackCompressionThreshold",
    "predictiveTtftMs",
    "reasoningTokenBufferEnabled",
    "reasoningTransportFallback",
)


def _safe_key_name(name: str) -> str:
    """A dropped key's NAME is reported so schema drift is visible. But a key name can
    itself be secret-shaped -- `{"sk-ant-...": 1}` is legal JSON -- so a name that looks
    like a credential VALUE is replaced by a digest. A name that merely READS like a
    credential field (`access_token`) is reported verbatim: that it exists is exactly
    what the operator needs to see, and the name is not the secret. The value was never
    copied.
    """
    for label, pattern in SECRET_PATTERNS:
        if label == "credential-ish key name":
            continue
        if pattern.search(name):
            return "<redacted-keyname:sha256:" + hashlib.sha256(
                name.encode("utf-8")
            ).hexdigest()[:12] + ">"
    return name


def _digest(value: Any) -> dict[str, Any]:
    """Presence + shape + sha256 for a free-text field. Never returns the content.

    `absent` and `empty` are reported separately and must stay separate: restoring an
    absent field means DELETING the key, restoring an empty one means writing "".
    """
    if value is None:
        return {"absent": True}
    text = value if isinstance(value, str) else json.dumps(value, sort_keys=True)
    return {
        "absent": False,
        "empty": text == "",
        "length": len(text),
        "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
    }


def _copy_allowed(
    row: Any, scalars: tuple[str, ...], str_lists: tuple[str, ...]
) -> tuple[dict[str, Any], list[str], list[str]]:
    """Copy allowlisted keys from one row. Returns (kept, dropped-key-names, warnings).

    Scalars are copied only when they are genuinely scalar; a dict or list smuggled into
    a scalar position is dropped, digested and warned about, because copying it would copy
    whatever it nests and dropping it silently would make two different smuggled values
    serialize identically -- a false clean baseline. String lists get the same treatment:
    a non-list value, or a list with non-string members, is digested and warned about
    (the models-treatment: value digest plus _WARNING so --build exits 3).
    """
    kept: dict[str, Any] = {}
    dropped: list[str] = []
    warnings: list[str] = []
    if not isinstance(row, dict):
        return kept, dropped, warnings

    for key, value in row.items():
        if key in scalars:
            if isinstance(value, (str, int, float, bool)) or value is None:
                kept[key] = value
            else:
                dropped.append(_safe_key_name(key))
                kept[key + "_digest"] = _digest(value)
                warnings.append(
                    f"`{key}` present but of type {type(value).__name__}, not scalar. "
                    "This field is EMPTY BY FAILURE, not by fact. Do not diff as a "
                    f"baseline; compare `{key}_digest` to see whether the value changed."
                )
        elif key in str_lists:
            if isinstance(value, list):
                kept[key] = [v for v in value if isinstance(v, str)]
                if any(not isinstance(v, str) for v in value):
                    dropped.append(_safe_key_name(key) + "[]")
                    kept[key + "_digest"] = _digest(value)
                    warnings.append(
                        f"`{key}` contains non-string members, not identifiers. "
                        "This list is FILTERED BY FAILURE, not by fact. Do not diff as a "
                        f"baseline; compare `{key}_digest` to see whether the value changed."
                    )
            else:
                dropped.append(_safe_key_name(key))
                kept[key + "_digest"] = _digest(value)
                warnings.append(
                    f"`{key}` present but of type {type(value).__name__}, not list. "
                    "This list is EMPTY BY FAILURE, not by fact. Do not diff as a "
                    f"baseline; compare `{key}_digest` to see whether the value changed."
                )
        else:
            dropped.append(_safe_key_name(key))
    return kept, dropped, warnings


def _redact_step(step: Any) -> dict[str, Any]:
    """One combo step, structurally allowlisted."""
    if isinstance(step, str):
        # Legacy bare-string step: the whole value is a model id.
        return {"kind": "model", "model": step, "_legacyString": True}
    if not isinstance(step, dict):
        return {
            "_unsupportedStepType": type(step).__name__,
            "_stepDigest": _digest(step),
            "_WARNING": (
                f"`step` present but of type {type(step).__name__}, not object. "
                "This step is EMPTY BY FAILURE, not by fact. Do not diff as a "
                "baseline; compare `_stepDigest` to see whether the value changed."
            ),
        }

    kept, dropped, str_warnings = _copy_allowed(step, STEP_SCALARS, STEP_STR_LISTS)
    for field in STEP_DIGEST_FIELDS:
        if field in step:
            kept[field + "_digest"] = _digest(step.get(field))
            if field in dropped:
                dropped.remove(field)
    if dropped:
        kept["_unknownKeysDropped"] = sorted(dropped)
    if str_warnings:
        kept["_WARNING"] = " ".join(str_warnings)
    return kept


def _redact_config(config: Any) -> dict[str, Any]:
    """Combo runtime config. `.passthrough()` means unknown keys persist upstream, so
    this copies by exact name and drops the entire remainder unread.

    A config that is present but not an object is an integrity failure, not an empty
    config: returning a bare `{}` would make `config: ["x"]` read identically to
    `config: {}` and hide the drift. `null` is the one non-dict that legitimately means
    "no config", so it is recorded exactly rather than warned about.
    """
    if config is None:
        return {"_configNull": True}
    if not isinstance(config, dict):
        return {
            "_configDigest": _digest(config),
            "_WARNING": (
                f"`config` present but of type {type(config).__name__}, not object. "
                "This config is EMPTY BY FAILURE, not by fact. Do not diff as a "
                "baseline; compare `_configDigest` to see whether the value changed."
            ),
        }
    kept, dropped, cfg_warnings = _copy_allowed(config, CONFIG_SCALARS, ())
    if dropped:
        kept["_unknownKeysDropped"] = sorted(dropped)
    if cfg_warnings:
        kept["_WARNING"] = " ".join(cfg_warnings)
    return kept


def _redact_combo(combo: Any) -> dict[str, Any]:
    if not isinstance(combo, dict):
        return {
            "_unsupportedComboType": type(combo).__name__,
            "_comboDigest": _digest(combo),
            "_WARNING": (
                f"`combo` present but of type {type(combo).__name__}, not object. "
                "This row is EMPTY BY FAILURE, not by fact. Do not diff as a "
                "baseline; compare `_comboDigest` to see whether the value changed."
            ),
        }

    kept, dropped, str_warnings = _copy_allowed(combo, COMBO_SCALARS, COMBO_STR_LISTS)
    row_warnings: list[str] = list(str_warnings)

    for field in COMBO_DIGEST_FIELDS:
        if field in combo:
            kept[field + "_digest"] = _digest(combo.get(field))
            if field in dropped:
                dropped.remove(field)

    models = combo.get("models")
    if isinstance(models, list):
        kept["models"] = [_redact_step(s) for s in models]
        kept["modelCount"] = len(models)
    elif "models" in combo:
        # Same discipline `_unwrap` applies at the envelope, applied at the row. A
        # present-but-non-list `models` collapsed silently to [] makes a combo whose
        # entire step list was rewritten serialize byte-identically to the original --
        # a false clean baseline, the worst failure available to a proof channel.
        kept["models"] = []
        kept["modelCount"] = 0
        # The warning alone does not make the row diffable: two different malformed
        # step lists both stringify to the same type name. Digest the value so a
        # rewritten step list still changes the bytes, without copying its content --
        # the same trade this module makes for free text everywhere else.
        kept["models_digest"] = _digest(models)
        row_warnings.append(
            f"`models` present but of type {type(models).__name__}, not list. Step list "
            "is EMPTY BY FAILURE, not by fact. Do not diff as a baseline; compare "
            "`models_digest` to see whether the malformed value itself changed."
        )
    if "models" in dropped:
        dropped.remove("models")

    if "config" in combo:
        kept["config"] = _redact_config(combo.get("config"))
        dropped.remove("config")

    # `data` is the raw stringified blob. Digest only -- it is a superset of every
    # field above, including every passthrough key.
    if "data" in combo:
        kept["data_digest"] = _digest(combo.get("data"))
        dropped.remove("data")

    if row_warnings:
        kept["_WARNING"] = " ".join(row_warnings)

    kept["_unknownKeysDropped"] = sorted(dropped)
    kept["_dbPresence"] = {
        "absent": sorted(f for f in COMBO_DIGEST_FIELDS if f not in combo),
        "present": sorted(f for f in COMBO_DIGEST_FIELDS if f in combo),
        "note": (
            "absent means NO KEY EXISTS on the row. A restore-on-abort must DELETE the "
            "key, not write an empty value back -- writing \"\" creates a value that "
            "never existed."
        ),
    }
    return kept


def _redact_mapping(mapping: Any) -> dict[str, Any]:
    if not isinstance(mapping, dict):
        return {
            "_unsupportedMappingType": type(mapping).__name__,
            "_mappingDigest": _digest(mapping),
            "_WARNING": (
                f"`mapping` present but of type {type(mapping).__name__}, not object. "
                "This row is EMPTY BY FAILURE, not by fact. Do not diff as a "
                "baseline; compare `_mappingDigest` to see whether the value changed."
            ),
        }
    kept, dropped, map_warnings = _copy_allowed(mapping, MAPPING_SCALARS, ())
    for field in MAPPING_DIGEST_FIELDS:
        if field in mapping:
            kept[field + "_digest"] = _digest(mapping.get(field))
            if field in dropped:
                dropped.remove(field)
    if map_warnings:
        kept["_WARNING"] = " ".join(map_warnings)
    kept["_unknownKeysDropped"] = sorted(dropped)
    return kept


def _unwrap(payload: Any) -> tuple[list[Any], dict[str, Any]]:
    """OmniRoute list endpoints answer `{items,total}`; some answer a bare list.

    Parsing `.mappings` or `.data` here would silently return empty, which would read as
    "no combos exist" -- a false clean baseline, the worst possible failure for a proof
    channel. So an unrecognised envelope is reported, never defaulted to [].
    """
    if isinstance(payload, list):
        return payload, {"envelope": "list"}
    if isinstance(payload, dict):
        for key in ("items", "combos", "mappings", "data"):
            if isinstance(payload.get(key), list):
                meta: dict[str, Any] = {"envelope": key}
                if isinstance(payload.get("total"), int):
                    meta["reportedTotal"] = payload["total"]
                return payload[key], meta
        return [], {"envelope": "UNRECOGNISED", "keys": sorted(payload.keys())}
    return [], {"envelope": "UNRECOGNISED", "type": type(payload).__name__}


def _section(payload: Any, redactor, kind: str) -> dict[str, Any]:
    rows, meta = _unwrap(payload)
    out = [redactor(r) for r in rows]
    section: dict[str, Any] = {
        "_schema": SCHEMA_VERSION,
        "_kind": kind,
        "_rowCount": len(out),
        "rows": out,
    }
    section.update({("_" + k): v for k, v in meta.items()})
    if meta.get("envelope") == "UNRECOGNISED":
        section["_WARNING"] = (
            "Envelope not recognised; row list is EMPTY BY FAILURE, not by fact. Do not "
            "read this as a clean baseline."
        )
    if isinstance(meta.get("reportedTotal"), int) and meta["reportedTotal"] != len(out):
        section["_WARNING"] = (
            f"Server reported total={meta['reportedTotal']} but {len(out)} rows were "
            "returned -- this page is PARTIAL. Do not diff it as a full baseline."
        )
    return section


def build_combos_section(payload: Any) -> dict[str, Any]:
    """Redacted `combos` section. Input: parsed GET /api/combos body."""
    return _section(payload, _redact_combo, "combos")


def build_mappings_section(payload: Any) -> dict[str, Any]:
    """Redacted `model_combo_mappings` section. Input: parsed GET body."""
    return _section(payload, _redact_mapping, "model_combo_mappings")


# ── Audit ────────────────────────────────────────────────────────────────────

# Shapes real credentials take in this system. `sk-` covers OpenAI/OpenRouter/Anthropic
# style keys; the JWT and the long opaque-hex/base64 runs cover OAuth material on
# provider rows (access_token / refresh_token / id_token).
SECRET_PATTERNS = (
    ("openai-style key", re.compile(r"sk-[A-Za-z0-9_\-]{16,}")),
    ("anthropic key", re.compile(r"sk-ant-[A-Za-z0-9_\-]{16,}")),
    ("bearer token", re.compile(r"[Bb]earer\s+[A-Za-z0-9._\-]{20,}")),
    ("jwt", re.compile(r"eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{5,}")),
    ("github token", re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}")),
    ("aws access key id", re.compile(r"\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[A-Z0-9]{16}\b")),
    ("google api key", re.compile(r"\bAIza[A-Za-z0-9_\-]{35}\b")),
    ("slack token", re.compile(r"\bxox[abposr]-[A-Za-z0-9\-]{10,}")),
    ("long opaque run", re.compile(r"\b[A-Fa-f0-9]{40,}\b")),
    ("credential-ish key name", re.compile(
        r"(?i)\b(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|"
        r"client[_-]?secret|password|authorization|private[_-]?key)\b")),
)

# sha256 digests are 64 hex chars and would trip "long opaque run" forever. They are the
# one thing this module deliberately emits, so they are exempted by KEY, not by pattern.
_DIGEST_KEY = re.compile(r"(_digest|sha256)$")


def integrity_warnings(node: Any, path: str = "$") -> list[str]:
    """Collect every `_WARNING` in a BUILT section, with its path.

    `audit()` answers a confidentiality question -- did a credential survive redaction.
    This answers the INTEGRITY one: does any part of this document say "empty by failure,
    not by fact". A section carrying one is not a baseline and must not be diffed as one,
    even though it leaks nothing and audits clean.
    """
    out: list[str] = []
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "_WARNING" and isinstance(value, str):
                out.append(f"{path}: {value}")
            else:
                out.extend(integrity_warnings(value, f"{path}.{key}"))
    elif isinstance(node, list):
        for i, value in enumerate(node):
            out.extend(integrity_warnings(value, f"{path}[{i}]"))
    return out


def audit(
    node: Any,
    path: str = "$",
    findings: list[str] | None = None,
    _names_only: bool = False,
) -> list[str]:
    """Walk a BUILT section and report anything credential-shaped.

    Walks keys as well as values: a secret parked in a key name leaks just as well as
    one in a value. Exempts our own sha256 digests by key name.

    `_unknownKeysDropped` holds NAMES of keys this module refused to copy -- so the
    literal string "access_token" appearing there is the report working, not a leak, and
    the `credential-ish key name` rule is suppressed inside it. Every other rule still
    applies there: `_safe_key_name` has already digested any name that looked like a
    credential VALUE, so a surviving `sk-...` in that list would be a real defect.
    """
    if findings is None:
        findings = []
    if isinstance(node, dict):
        for key, value in node.items():
            if _DIGEST_KEY.search(str(key)):
                continue
            for label, pattern in SECRET_PATTERNS:
                if pattern.search(str(key)):
                    findings.append(f"{path}.{key} <KEY NAME> matches {label}")
            audit(value, f"{path}.{key}", findings,
                  _names_only=(key == "_unknownKeysDropped"))
    elif isinstance(node, list):
        for i, value in enumerate(node):
            audit(value, f"{path}[{i}]", findings, _names_only=_names_only)
    elif isinstance(node, str):
        for label, pattern in SECRET_PATTERNS:
            if _names_only and label == "credential-ish key name":
                continue
            if pattern.search(node):
                findings.append(f"{path} matches {label}")
    return findings


# ── Selftest ─────────────────────────────────────────────────────────────────

# The GitHub-token canary is ASSEMBLED FROM FRAGMENTS so the literal never appears in
# this file whole. CI's "Secret scan" step greps TRACKED files for
# `gh[pousr]_[A-Za-z0-9]{16,}`, and this fixture written out longhand trips the repo's
# own secret gate. The JWT, hex-run and Google fixtures below are fragmented the same
# way: gitleaks runs with default rules in this repo, and those three shapes trip it.
# omniroute_combo_cli.sh splits its literals for exactly this reason; this is the same
# trade, not a new one.
#
# Splitting a canary is also the standard way to make a suite vacuous, so the assembled
# value is asserted against the auditor's OWN pattern in check 2b below. If a future
# edit breaks the assembly, the canary stops being token-shaped and every "no credential
# survives" check would pass by testing nothing. That check goes red instead.
_GH_CANARY = "gh" "p_" + "C" * 32

# The JWT and hex-run fixtures are assembled from fragments for the same reason:
# gitleaks' generic-api-key rule fires on a `"name": "value"` shape beside a
# key-like name, so the samples live here under neutral names and are joined only
# at fixture-build time. The assembled values are byte-identical to the longhand
# originals.
_JWT_SEG1 = "eyJhbGciOiJIUzI1NiJ9"
_JWT_SEG2 = "eyJzdWIiOiIxMjM0NTY3ODkwIn0"
_JWT_SEG3 = "abcdefghij"
_HEX_A = "0123456789abcdef"
_HEX_B = "0123456789abcdef"
_HEX_C = "01234567"


def _hostile_fixture() -> dict[str, Any]:
    """A combos payload with credentials planted in every reachable position.

    Deliberately hostile: the point is to fail if ANY survives redaction, not to model a
    realistic combo. `config` gets passthrough keys because .passthrough() means upstream
    accepts and persists them.
    """
    return {
        "items": [
            {
                "id": "combo-1",
                "name": "pc/claude-primary",
                "strategy": "priority",
                "description": "contact sk-ant-AAAAAAAAAAAAAAAAAAAAAAAA for access",
                "system_message": "You are helpful. Key: sk-proj-BBBBBBBBBBBBBBBBBBBBBBBB",
                "models": [
                    {
                        "kind": "model",
                        "model": "claude-opus-5",
                        "providerId": "anthropic",
                        "connectionId": "85535839-3174-4a24-ad17-d018f69d27b1",
                        "weight": 1,
                        "tags": ["primary"],
                        "prompt": _GH_CANARY,
                        # planted: an unknown nested object on a step
                        "auth": {"api_key": "sk-DDDDDDDDDDDDDDDDDDDDDDDD"},
                    },
                    "claude-sonnet-5",
                ],
                "config": {
                    "strategy": "priority",
                    "maxRetries": 3,
                    # planted via .passthrough()
                    "access_token": _JWT_SEG1 + "." + _JWT_SEG2 + "." + _JWT_SEG3,
                    "customHeaders": {"Authorization": "Bearer EEEEEEEEEEEEEEEEEEEEEEEEEE"},
                    "deeply": {"nested": {"refresh_token": _HEX_A + _HEX_B + _HEX_C}},
                    # planted: the KEY NAME is itself secret-shaped. Legal JSON, and the
                    # drop-list would otherwise echo it verbatim.
                    "sk-ant-JJJJJJJJJJJJJJJJJJJJJJJJ": "whatever",
                },
                # planted: the raw blob, a superset of everything
                "data": json.dumps({"system_message": "sk-ant-FFFFFFFFFFFFFFFFFFFFFFFF"}),
                "allowedProviders": ["anthropic", {"api_key": "sk-GGGGGGGGGGGGGGGGGGGG"}],
                "createdAt": "2026-08-23T17:55:33Z",
            }
        ],
        "total": 1,
    }


def _selftest() -> int:
    failures: list[str] = []
    passes = 0

    def check(name: str, ok: bool, detail: str = "") -> None:
        nonlocal passes
        if ok:
            passes += 1
            print(f"  PASS  {name}")
        else:
            failures.append(f"{name}: {detail}")
            print(f"  FAIL  {name}  {detail}")

    print("snapshot-sections selftest -- hostile fixtures")

    # 1. No planted credential survives combo redaction.
    built = build_combos_section(_hostile_fixture())
    found = audit(built)
    check("no credential survives combos redaction", not found, "; ".join(found[:6]))

    # 2. The literal secret substrings are absent from the serialized output.
    blob = json.dumps(built)
    planted = [
        "sk-ant-AAAA", "sk-proj-BBBB", _GH_CANARY[:8], "sk-DDDD",
        "eyJhbGciOiJIUzI1NiJ9", "Bearer EEEE",
        "0123456789abcdef0123456789abcdef01234567",
        "sk-ant-FFFF", "sk-GGGG", "sk-ant-JJJJ",
    ]
    leaked = [p for p in planted if p in blob]
    check("no planted substring in serialized output", not leaked, f"leaked={leaked}")

    # 2b. The fragment-assembled GitHub canary must still be token-shaped, and must
    #     still be REACHABLE in the fixture. Both halves matter: a broken assembly makes
    #     check 1 pass by planting nothing a pattern can find, and a fixture edit that
    #     drops the field makes it pass by planting nothing at all. Asserted against the
    #     auditor's own compiled pattern rather than a copy of it, so the two cannot
    #     drift apart.
    _gh_pattern = dict((label, pat) for label, pat in SECRET_PATTERNS)["github token"]
    check(
        "the split GitHub canary is still token-shaped and still planted",
        bool(_gh_pattern.search(_GH_CANARY))
        and _GH_CANARY in json.dumps(_hostile_fixture()),
        f"canary_len={len(_GH_CANARY)} matches={bool(_gh_pattern.search(_GH_CANARY))}",
    )

    # 3. Passthrough config keys are dropped AND named.
    cfg = built["rows"][0]["config"]
    dropped = cfg.get("_unknownKeysDropped", [])
    check(
        "passthrough config keys dropped and reported",
        "access_token" in dropped and "customHeaders" in dropped and "deeply" in dropped
        and "access_token" not in cfg,
        f"dropped={dropped}",
    )

    # 4. Allowlisted structural fields ARE kept -- redaction that keeps nothing is
    #    trivially safe and useless as a proof channel.
    row = built["rows"][0]
    step = row["models"][0]
    check(
        "structural fields survive",
        row["name"] == "pc/claude-primary"
        and row["strategy"] == "priority"
        and cfg["maxRetries"] == 3
        and step["model"] == "claude-opus-5"
        and step["connectionId"] == "85535839-3174-4a24-ad17-d018f69d27b1",
        f"row={ {k: row.get(k) for k in ('name', 'strategy')} } step={step}",
    )

    # 5. Nested unknown object on a step is dropped, not walked into.
    check("nested step object dropped", "auth" in step.get("_unknownKeysDropped", []),
          f"dropped={step.get('_unknownKeysDropped')}")

    # 6. Non-string member of a str-list is dropped.
    check("non-string list member dropped",
          row.get("allowedProviders") == ["anthropic"],
          f"allowedProviders={row.get('allowedProviders')}")

    # 7. Free text is digested, and the digest actually distinguishes content.
    d1 = _digest("hello")
    d2 = _digest("hellp")
    check("digest distinguishes content", d1["sha256"] != d2["sha256"])

    # 8. absent != empty. This is the rollback-correctness property.
    da, de = _digest(None), _digest("")
    check("absent and empty are distinguishable",
          da.get("absent") is True and de.get("absent") is False and de.get("empty") is True,
          f"absent={da} empty={de}")

    # 9. A combo with NO system_message reports it absent, not empty.
    minimal = build_combos_section({"items": [{"id": "c", "name": "n", "models": []}], "total": 1})
    pres = minimal["rows"][0]["_dbPresence"]
    check("missing free-text field reported absent",
          "system_message" in pres["absent"] and "system_message" not in pres["present"],
          f"presence={pres}")

    # 10. Unrecognised envelope must WARN, never look like a clean empty baseline.
    bad = build_combos_section({"unexpected": "shape"})
    check("unrecognised envelope warns", "_WARNING" in bad and bad["_rowCount"] == 0,
          f"section={bad}")

    # 11. A partial page must WARN rather than diff as a full baseline.
    partial = build_combos_section({"items": [{"id": "a", "name": "a"}], "total": 9})
    check("partial page warns", "_WARNING" in partial, f"section={partial}")

    # 12. Mappings: full copy, description digested, no credential survives.
    maps = build_mappings_section({
        "items": [{
            "id": "m1", "pattern": "claude-*", "combo_id": "combo-1", "priority": 1000,
            "enabled": 1, "description": "token sk-HHHHHHHHHHHHHHHHHHHHHHHH",
            "created_at": "2026-08-23T17:55:33Z", "updated_at": "2026-08-23T17:55:33Z",
        }],
        "total": 1,
    })
    mrow = maps["rows"][0]
    mfound = audit(maps)
    check("mappings redact clean", not mfound and "sk-HHHH" not in json.dumps(maps),
          "; ".join(mfound[:4]))
    check("mapping structure survives",
          mrow["pattern"] == "claude-*" and mrow["priority"] == 1000
          and mrow["combo_id"] == "combo-1",
          f"row={mrow}")

    # 13. The auditor must be able to FAIL -- a checker that always passes proves
    #     nothing. Prove it catches a known-bad document.
    check("auditor detects a planted secret",
          len(audit({"x": "sk-ant-IIIIIIIIIIIIIIIIIIIIIIII"})) > 0)

    # 14. ...and that it does not flag our own digests.
    check("auditor ignores own digests",
          not audit({"system_message_digest": _digest("anything")}))

    # 15. A secret-shaped KEY NAME is digested in the drop-list, not echoed. Without
    #     this, reporting drift would itself become the leak.
    check("secret-shaped key name is digested in drop-list",
          any(d.startswith("<redacted-keyname:") for d in dropped)
          and not any("sk-ant-JJJJ" in d for d in dropped),
          f"dropped={dropped}")

    # 16. ...but an ordinary credential FIELD name is still reported verbatim, because
    #     "a key called access_token exists here" is the signal the operator needs.
    check("credential-ish field name reported verbatim",
          "access_token" in dropped, f"dropped={dropped}")

    # 17. The drop-list suppression must be NARROW: only the key-name rule is relaxed
    #     inside _unknownKeysDropped. A real secret value planted there must still trip.
    check("drop-list suppression does not blind the auditor",
          len(audit({"_unknownKeysDropped": ["sk-ant-KKKKKKKKKKKKKKKKKKKKKKKK"]})) > 0)

    # 18. THE GATE. `--build` must exit non-zero and emit NOTHING on stdout when
    #     redaction leaves a leak. A gate that prints the leaking document and *also*
    #     returns 1 has already leaked -- the operator pipes stdout into the snapshot.
    #     An allowlisted field (`name`) carrying a secret is the case a structural
    #     allowlist cannot catch by construction, which is exactly why the gate exists.
    import subprocess  # noqa: PLC0415 -- selftest-only, keeps the import surface small

    proc = subprocess.run(
        [sys.executable, __file__, "--build", "-", "--kind", "combos"],
        input=json.dumps({"items": [{"id": "x", "strategy": "priority",
                                     "name": "sk-ant-LLLLLLLLLLLLLLLLLLLLLLLL"}]}),
        capture_output=True, text=True,
    )
    check("--build refuses to emit on a leak",
          proc.returncode == 1 and proc.stdout == "" and "REFUSING TO EMIT" in proc.stderr,
          f"rc={proc.returncode} stdout={len(proc.stdout)}B stderr={proc.stderr[:80]!r}")

    # 19. THE REGRESSION THAT MATTERS (review F1). A combo whose `models` arrives as a
    #     dict rather than a list must NOT serialize identically to a different one.
    #     Before the fix both collapsed to `models: []` and a wholesale rewrite of the
    #     step list -- different models, different connectionIds, an extra step -- read
    #     as no-change. Compare the built sections BYTE-FOR-BYTE, which is exactly how
    #     the snapshot channel is diffed.
    def _combos_with(models: Any) -> str:
        return json.dumps(build_combos_section(
            {"items": [{"id": "c1", "name": "pc/x", "strategy": "priority",
                        "models": models}], "total": 1}),
            sort_keys=True)

    p4_before = _combos_with({"0": {"model": "claude-opus-5", "connectionId": "AAA"}})
    p4_after = _combos_with({"0": {"model": "gpt-4o", "connectionId": "ZZZ"},
                             "1": {"model": "evil", "connectionId": "QQQ"}})
    check("non-list models: a rewritten step list is not byte-identical",
          p4_before != p4_after,
          "a wholesale step-list rewrite serialized identically -- false clean baseline")

    # 20. ...and the reason it differs must be a WARNING, not an accident of ordering.
    #     An empty-by-failure step list must say so in the document itself.
    dict_models = build_combos_section(
        {"items": [{"id": "c", "name": "n", "models": {"0": {"model": "x"}}}], "total": 1})
    warned = integrity_warnings(dict_models)
    check("non-list models warns, and the warning is collectable",
          len(warned) == 1 and "EMPTY BY FAILURE" in warned[0]
          and dict_models["rows"][0]["modelCount"] == 0,
          f"warnings={warned}")

    # 21. A genuinely empty list is NOT a failure and must stay silent -- a gate that
    #     fires on the ordinary case gets switched off.
    check("an empty models list does not warn",
          not integrity_warnings(build_combos_section(
              {"items": [{"id": "c", "name": "n", "models": []}], "total": 1})))

    # 22. Same class, `config`. A list-valued config must not read as an empty one.
    def _cfg(v: Any) -> str:
        return json.dumps(build_combos_section(
            {"items": [{"id": "c", "name": "n", "config": v}], "total": 1}), sort_keys=True)

    check("non-dict config is distinguishable from an empty one",
          _cfg(["a"]) != _cfg({}) and _cfg(None) != _cfg({}) and _cfg(None) != _cfg(["a"]),
          "config list/null/empty-dict collapse to the same bytes")

    # 23. THE INTEGRITY GATE. `--build` must refuse to emit a section that audits clean
    #     but is empty by failure. Confidentiality passing is not integrity passing, and
    #     the operator pipes stdout into the world-readable file either way.
    proc2 = subprocess.run(
        [sys.executable, __file__, "--build", "-", "--kind", "combos"],
        input=json.dumps({"items": [{"id": "x", "name": "ok", "strategy": "priority",
                                     "models": {"0": {"model": "m"}}}], "total": 1}),
        capture_output=True, text=True,
    )
    check("--build refuses to emit an empty-by-failure section",
          proc2.returncode == 3 and proc2.stdout == ""
          and "NOT a baseline" in proc2.stderr,
          f"rc={proc2.returncode} stdout={len(proc2.stdout)}B stderr={proc2.stderr[:80]!r}")

    # 24. ...and that gate must still pass a clean, well-formed section, or it is just a
    #     refuse-everything stub (the check that stops 23 from being vacuous).
    proc3 = subprocess.run(
        [sys.executable, __file__, "--build", "-", "--kind", "combos"],
        input=json.dumps({"items": [{"id": "x", "name": "ok", "strategy": "priority",
                                     "models": [{"model": "m"}]}], "total": 1}),
        capture_output=True, text=True,
    )
    check("--build still emits a clean section",
          proc3.returncode == 0 and '"modelCount": 1' in proc3.stdout,
          f"rc={proc3.returncode} stderr={proc3.stderr[:80]!r}")

    # 25. The three credential shapes the docstring used to over-claim (review F2).
    for _label, _sample in (
        ("aws", "AKIAIOSFODNN7EXAMPLE"),
        ("google", "AIza" "SyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY"),
        ("slack", "xoxb-4827shy2-abcdefghijklmnop"),
    ):
        check(f"auditor detects a {_label} credential shape",
              len(audit({"name": _sample})) > 0, f"sample={_sample[:10]}...")

    # 26. F1 follow-up (review): unsupported-type rows, non-dict steps and malformed
    #     str-lists must digest + warn, never collapse to identical bytes. Before the
    #     fix, "row-A" vs "row-C", step 42 vs 43, and allowedProviders "anthropic" vs
    #     "openai" all serialized byte-identically with no warning and --build exited 0.
    def _dump(section: Any) -> str:
        return json.dumps(section, sort_keys=True)

    _cA = build_combos_section({"items": ["row-A"], "total": 1})
    _cC = build_combos_section({"items": ["row-C"], "total": 1})
    _mA = build_mappings_section({"items": ["row-A"], "total": 1})
    _mC = build_mappings_section({"items": ["row-C"], "total": 1})
    _s42 = build_combos_section(
        {"items": [{"id": "c", "name": "n", "models": [42]}], "total": 1})
    _s43 = build_combos_section(
        {"items": [{"id": "c", "name": "n", "models": [43]}], "total": 1})
    _lA = build_combos_section(
        {"items": [{"id": "c", "name": "n",
                    "allowedProviders": "anthropic"}], "total": 1})
    _lO = build_combos_section(
        {"items": [{"id": "c", "name": "n",
                    "allowedProviders": "openai"}], "total": 1})
    _lMix1 = build_combos_section(
        {"items": [{"id": "c", "name": "n",
                    "allowedProviders": ["anthropic", {"x": 1}]}], "total": 1})
    _lMix2 = build_combos_section(
        {"items": [{"id": "c", "name": "n",
                    "allowedProviders": ["anthropic", {"y": 2}]}], "total": 1})
    # Same class one level down: a dict smuggled into a scalar position must not
    # read as an absent field either.
    _sm1 = build_combos_section(
        {"items": [{"id": "c", "name": {"a": 1}}], "total": 1})
    _sm2 = build_combos_section(
        {"items": [{"id": "c", "name": {"b": 2}}], "total": 1})
    _proc26 = subprocess.run(
        [sys.executable, __file__, "--build", "-", "--kind", "combos"],
        input=json.dumps({"items": ["row-A"], "total": 1}),
        capture_output=True, text=True,
    )
    check("unsupported rows and malformed str-lists warn with digests",
          _dump(_cA) != _dump(_cC)
          and _dump(_mA) != _dump(_mC)
          and _dump(_s42) != _dump(_s43)
          and _dump(_lA) != _dump(_lO)
          and _dump(_lMix1) != _dump(_lMix2)
          and _dump(_sm1) != _dump(_sm2)
          and len(integrity_warnings(_cA)) > 0
          and len(integrity_warnings(_mA)) > 0
          and len(integrity_warnings(_s42)) > 0
          and len(integrity_warnings(_lA)) > 0
          and len(integrity_warnings(_lMix1)) > 0
          and len(integrity_warnings(_sm1)) > 0
          and _proc26.returncode == 3 and _proc26.stdout == "",
          f"cA==cC:{_dump(_cA) == _dump(_cC)} "
          f"warn={len(integrity_warnings(_cA))} rc={_proc26.returncode}")

    print()
    if failures:
        print(f"SELFTEST FAILED -- {len(failures)} check(s):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(f"SELFTEST PASSED -- {passes}/{passes}")
    return 0


def _load(path: str) -> Any:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def main() -> int:
    ap = argparse.ArgumentParser(
        description="combos / model_combo_mappings snapshot sections."
    )
    ap.add_argument("--selftest", action="store_true",
                    help="run hostile-fixture redaction tests (exit 1 on any leak)")
    ap.add_argument("--audit", metavar="FILE",
                    help="scan a BUILT section (JSON) for credential-shaped content; "
                         "'-' reads stdin")
    ap.add_argument("--build", metavar="FILE",
                    help="read a raw API response (JSON) and print the redacted "
                         "section; '-' reads stdin")
    ap.add_argument("--kind", choices=("combos", "mappings"), default="combos",
                    help="which builder --build should use (default: combos)")
    args = ap.parse_args()

    if args.selftest:
        return _selftest()

    if args.audit:
        doc = json.load(sys.stdin) if args.audit == "-" else _load(args.audit)
        found = audit(doc)
        if found:
            print(f"AUDIT FAILED -- {len(found)} finding(s):")
            for f in found:
                print(f"  - {f}")
            return 1
        print("AUDIT CLEAN -- no credential-shaped content found.")
        print("NOTE: clean means no KNOWN shape matched. It is not a proof of absence.")
        warnings = integrity_warnings(doc)
        if warnings:
            print(f"\nINTEGRITY: {len(warnings)} warning(s) -- this document audits "
                  "clean but is NOT a baseline:")
            for w in warnings:
                print(f"  - {w}")
            return 3
        return 0

    if args.build:
        payload = json.load(sys.stdin) if args.build == "-" else _load(args.build)
        builder = build_combos_section if args.kind == "combos" else build_mappings_section
        section = builder(payload)
        leaks = audit(section)
        if leaks:
            print(f"REFUSING TO EMIT -- redaction left {len(leaks)} finding(s):",
                  file=sys.stderr)
            for f in leaks:
                print(f"  - {f}", file=sys.stderr)
            return 1
        # Integrity gate, separate exit code from the leak gate. A section that audits
        # clean can still be empty by failure; appending it to the snapshot channel would
        # publish a false clean baseline. Emitting nothing is the only safe answer,
        # because the operator pipes stdout straight into the world-readable file.
        warnings = integrity_warnings(section)
        if warnings:
            print(f"REFUSING TO EMIT -- {len(warnings)} integrity warning(s); this "
                  "section is NOT a baseline:", file=sys.stderr)
            for w in warnings:
                print(f"  - {w}", file=sys.stderr)
            return 3
        print(json.dumps(section, indent=1, sort_keys=True))
        return 0

    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
