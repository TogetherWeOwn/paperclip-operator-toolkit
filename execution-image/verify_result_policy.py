#!/usr/bin/env python3
"""Stage-B policy checks for gh attestation verify JSON; read-only and never reports authenticity."""
import errno
import hashlib
import json
import math
import os
import re
import selectors
import signal
import stat
import subprocess
import sys
import time

MAX_BYTES = 4 * 1024 * 1024
MAX_DEPTH = 64
MAX_NODES = 100_000
CAPTURE_TIMEOUT_S = 120
CAPTURE_REAP_S = 5

# Mirrors execution-image/manifest.json base.*; test_verify_result_policy.py cross-checks each value.
EXPECTED = {
    "media_type_prefix": "application/vnd.dev.sigstore.bundle.",
    "statement_type": "https://in-toto.io/Statement/v1",
    "predicate_type": "https://slsa.dev/provenance/v1",
    "subject_name": "ghcr.io/paperclipai/paperclip",
    "subject_sha256": "95cc19e5fdd7804b9fd8699fbe33a7202ae6a26e2b42dc5e6fdf4785f213deed",
    "issuer": "https://token.actions.githubusercontent.com",
    "signer_identity": "https://github.com/paperclipai/paperclip/.github/workflows/docker.yml@refs/heads/master",
    "source_uri": "https://github.com/paperclipai/paperclip",
    "source_ref": "refs/heads/master",
    "source_digest": "e4b39da6f6304c18d40dff13a5c7d224b3bf50fd",
    "run_id": "37717359076",
}
RUN_INVOCATION = re.compile(
    r"https://github\.com/paperclipai/paperclip/actions/runs/" + EXPECTED["run_id"] + r"/attempts/[1-9][0-9]{0,8}"
)


class Refusal(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def _reject_duplicate_keys(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise Refusal("duplicate_key")
        obj[key] = value
    return obj


def _reject_constant(_name):
    raise Refusal("non_finite_number")


def _finite_float(text):
    value = float(text)
    if not math.isfinite(value):
        raise Refusal("non_finite_number")
    return value


def _check_bounds(root):
    stack = [(root, 1)]
    nodes = 0
    while stack:
        node, depth = stack.pop()
        nodes += 1
        if nodes > MAX_NODES:
            raise Refusal("too_many_nodes")
        if depth > MAX_DEPTH:
            raise Refusal("too_deep")
        if isinstance(node, dict):
            children = list(node.values())
        elif isinstance(node, list):
            children = node
        else:
            children = []
        stack.extend((child, depth + 1) for child in children)


def _parse(raw):
    if len(raw) > MAX_BYTES:
        raise Refusal("input_too_large")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise Refusal("invalid_encoding") from None
    try:
        root = json.loads(
            text,
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=_reject_constant,
            parse_float=_finite_float,
        )
    except RecursionError:
        raise Refusal("too_deep") from None
    except ValueError:
        raise Refusal("invalid_json") from None
    _check_bounds(root)
    return root


def _field(container, key, kind, code):
    value = container.get(key) if isinstance(container, dict) else None
    if not isinstance(value, kind):
        raise Refusal(code)
    return value


def _is_timestamp(entry):
    return isinstance(entry, dict) and all(
        isinstance(entry.get(key), str) and entry[key] for key in ("type", "uri", "timestamp")
    )


def _check_policy(doc):
    if not isinstance(doc, list) or len(doc) != 1:
        raise Refusal("result_count")
    result = _field(doc[0], "verificationResult", dict, "result_shape")
    if not _field(result, "mediaType", str, "media_type").startswith(EXPECTED["media_type_prefix"]):
        raise Refusal("media_type")
    statement = _field(result, "statement", dict, "statement_shape")
    if statement.get("_type") != EXPECTED["statement_type"]:
        raise Refusal("statement_type")
    if statement.get("predicateType") != EXPECTED["predicate_type"]:
        raise Refusal("predicate_type")
    subjects = _field(statement, "subject", list, "subject_shape")
    if len(subjects) != 1:
        raise Refusal("subject_count")
    subject = subjects[0]
    if not isinstance(subject, dict):
        raise Refusal("subject_shape")
    if subject.get("name") != EXPECTED["subject_name"]:
        raise Refusal("subject_name")
    if _field(subject, "digest", dict, "subject_shape").get("sha256") != EXPECTED["subject_sha256"]:
        raise Refusal("subject_digest")
    signature = _field(result, "signature", dict, "certificate_shape")
    certificate = _field(signature, "certificate", dict, "certificate_shape")
    if certificate.get("issuer") != EXPECTED["issuer"]:
        raise Refusal("issuer")
    if certificate.get("subjectAlternativeName") != EXPECTED["signer_identity"]:
        raise Refusal("signer_identity")
    if certificate.get("buildSignerURI") != EXPECTED["signer_identity"]:
        raise Refusal("build_signer")
    if certificate.get("sourceRepositoryURI") != EXPECTED["source_uri"]:
        raise Refusal("source_uri")
    if certificate.get("sourceRepositoryRef") != EXPECTED["source_ref"]:
        raise Refusal("source_ref")
    if certificate.get("sourceRepositoryDigest") != EXPECTED["source_digest"]:
        raise Refusal("source_digest")
    run = certificate.get("runInvocationURI")
    if not isinstance(run, str) or not RUN_INVOCATION.fullmatch(run):
        raise Refusal("run_invocation")
    timestamps = _field(result, "verifiedTimestamps", list, "timestamps")
    if not timestamps or not all(_is_timestamp(entry) for entry in timestamps):
        raise Refusal("timestamps")


def verdict(code):
    return {
        "policy": "refused" if code else "satisfied",
        "refusal_code": code,
        "authenticity": "not_established",
        "hold_cleared": False,
        "checked": "pinned identity fields in parsed JSON only; no signature, chain, log, or artifact check",
    }


def check_bytes(raw):
    try:
        _check_policy(_parse(raw))
    except Refusal as refusal:
        return verdict(refusal.code)
    return verdict(None)


def _open_regular(path):
    # O_NONBLOCK: open() on a FIFO with no writer would block before the type check.
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise OSError(errno.EINVAL, "not a regular file")
        return os.fdopen(fd, "rb")
    except BaseException:
        os.close(fd)
        raise


def _sha256_file(path, deadline):
    digest = hashlib.sha256()
    with _open_regular(path) as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
            if time.monotonic() >= deadline:
                raise Refusal("timeout")
    return digest.hexdigest()


def _read_bounded(stream, deadline):
    buffer = bytearray()
    selector = selectors.DefaultSelector()
    selector.register(stream, selectors.EVENT_READ)
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise Refusal("timeout")
            if not selector.select(remaining):
                continue
            chunk = os.read(stream.fileno(), 65536)
            if not chunk:
                return bytes(buffer)
            buffer.extend(chunk)
            if len(buffer) > MAX_BYTES:
                raise Refusal("output_limit")
    finally:
        selector.close()


def capture(argv, expected_sha256, timeout_s=CAPTURE_TIMEOUT_S):
    if not isinstance(argv, list) or not argv or not all(isinstance(arg, str) for arg in argv):
        raise Refusal("argv")
    if not 0 < timeout_s <= CAPTURE_TIMEOUT_S:
        raise Refusal("timeout")
    deadline = time.monotonic() + timeout_s
    executable = argv[0]
    if not os.path.isabs(executable) or not os.path.isfile(executable):
        raise Refusal("executable_path")
    if not os.access(executable, os.R_OK | os.X_OK):
        raise Refusal("executable_path")
    try:
        digest = _sha256_file(executable, deadline)
    except OSError:
        raise Refusal("executable_path") from None
    if digest != expected_sha256:
        raise Refusal("executable_sha256")
    try:
        proc = subprocess.Popen(
            argv,
            shell=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except ValueError:
        raise Refusal("argv") from None
    except OSError:
        raise Refusal("spawn") from None
    try:
        output = _read_bounded(proc.stdout, deadline)
        try:
            status = proc.wait(timeout=max(deadline - time.monotonic(), 0))
        except subprocess.TimeoutExpired:
            raise Refusal("timeout") from None
    finally:
        proc.stdout.close()
        if proc.returncode is None:
            # An unreaped leader keeps its pid, so the group id cannot be reused.
            signal_refused = False
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except PermissionError:
                signal_refused = True
            try:
                proc.wait(timeout=CAPTURE_REAP_S)
            except subprocess.TimeoutExpired:
                raise Refusal("kill_refused") from None
            if signal_refused:
                raise Refusal("kill_refused")
    if status != 0:
        raise Refusal("exit_status")
    return output


def _read_regular(path):
    with _open_regular(path) as handle:
        return handle.read(MAX_BYTES + 1)


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1:
        print("usage: verify_result_policy.py <gh-attestation-verify.json>", file=sys.stderr)
        return 2
    try:
        raw = _read_regular(args[0])
    except OSError as error:
        print(f"cannot read input: {error.strerror}", file=sys.stderr)
        return 2
    result = check_bytes(raw)
    print(json.dumps(result, sort_keys=True))
    return 0 if result["policy"] == "satisfied" else 1


if __name__ == "__main__":
    sys.exit(main())
