#!/usr/bin/env python3
"""Validate a source packet offline; never build, install, verify trust, or adopt it."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

MAX_BYTES = 64 * 1024
FILES = {"Dockerfile", "native.sources", "native-packages.json",
         "runtime-contract.json", "validate.py", "test_manifest.py", "README.md"}
PACKAGES = {"binutils", "gcc", "gcc-14", "libc6-dev", "pkg-config", "pkgconf"}
RUNTIME = {
    "schema": "execution-image.runtime-contract.v1",
    "execution_user": "1000:1000",
    "startup_user": "0:0_for_inherited_initialization_only",
    "entrypoint": "inherit_verified_standard_production",
    "command": "inherit_verified_standard_production",
    "rust_toolchain": "preserve_existing_package_owned_1.98.1",
    "compiler_paths": ["/usr/bin/cc", "/usr/bin/gcc", "/usr/bin/ld", "/usr/bin/ar", "/usr/bin/pkg-config"],
    "wrapper": "preserve_exact_source_pin_no_direct_cargo",
    "pool": "preserve_existing_protected_finite_filesystem_no_new_pool",
    "outputs": "preserve_target_scratch_external_outputs_leases_and_process_ownership",
    "runtime_policy": "preserve_read_only_root_no_writable_app_no_privilege_or_network_expansion",
    "adoption": "requires_current_configuration_specific_acceptance",
    "rollback": "drain_then_restore_previous_verified_image_and_configuration_preserve_outputs",
}


class InvalidPacket(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise InvalidPacket(message)


def obj(value, keys, field):
    require(type(value) is dict and set(value) == set(keys),
            field + ": missing or unexpected fields")
    return value


def match(value, pattern, field):
    require(type(value) is str and re.fullmatch(pattern, value) is not None, field)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "JSON: duplicate key")
        result[key] = value
    return result


def parse(raw):
    require(len(raw) <= MAX_BYTES, "JSON: input exceeds 64KiB")

    def reject_constant(_value):
        raise InvalidPacket("JSON: non-finite number")
    try:
        return json.loads(raw, object_pairs_hook=unique_object, parse_constant=reject_constant)
    except InvalidPacket:
        raise
    except (ValueError, UnicodeDecodeError, RecursionError):
        raise InvalidPacket("JSON: malformed input") from None


def sources(native):
    return ("Types: deb\n"
            f"URIs: https://snapshot.debian.org/archive/debian/{native['snapshot']}/\n"
            "Suites: trixie\nComponents: main\nArchitectures: amd64\n"
            "Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg\n")


def dockerfile(base, native):
    """The only permitted recipe. No variables, compiler/env injection, or live hook."""
    pins = " \\\n        ".join(f"{name}={version}" for name, version in sorted(native["packages"].items()))
    checks = " \\\n    && ".join(f'test "$(dpkg-query -W -f=\'${{Version}}\' {name})" = "{version}"'
                             for name, version in sorted(native["packages"].items()))
    apt = ("apt-get -o Dir::Etc::sourcelist=/usr/local/share/execution-image/native.sources "
           "-o Dir::Etc::sourceparts=-")
    return ("# Source recipe only. Image creation requires separate authorization and verified provenance.\n"
            f"FROM {base['image_ref']}\n"
            "USER 0:0\n"
            "COPY native.sources /usr/local/share/execution-image/native.sources\n"
            "RUN test \"$(dpkg --print-architecture)\" = amd64 \\\n"
            "    && . /etc/os-release && test \"$ID:$VERSION_CODENAME\" = debian:trixie \\\n"
            f"    && {apt} update \\\n"
            f"    && {apt} install -y --no-install-recommends \\\n        {pins} \\\n"
            f"    && {checks} \\\n"
            "    && dpkg-query -W -f='${binary:Package}=${Version}\\n' > /usr/local/share/execution-image/installed-packages.txt \\\n"
            "    && rm -rf /var/lib/apt/lists/*\n"
            "# Preserve root entrypoint initialization; drop privileges only for this build-time check.\n"
            "RUN gosu 1000:1000 sh -eu -c 'test \"$(id -u):$(id -g)\" = 1000:1000 \\\n"
            "    && test -x /usr/bin/cc && test -x /usr/bin/gcc \\\n"
            "    && test -x /usr/bin/ld && test -x /usr/bin/ar && test -x /usr/bin/pkg-config \\\n"
            "    && test -r /usr/include/stdio.h \\\n"
            "    && /usr/bin/gcc --version && /usr/bin/ld --version && /usr/bin/pkg-config --version'\n")


def validate(manifest, files):
    """Pure consistency validation. Source hashes are not independent acceptance."""
    m = obj(manifest, {"schema", "state", "carrier_repository", "carrier_base_revision",
                       "base", "wrapper", "files", "output", "authorization"}, "manifest")
    require(m["schema"] == "execution-image.source-packet.v1", "manifest.schema")
    require(m["state"] == "unbuilt_recipe", "manifest.state: source only")
    require(m["carrier_repository"] == "TogetherWeOwn/paperclip-operator-toolkit", "carrier_repository")
    match(m["carrier_base_revision"], r"[0-9a-f]{40}", "carrier_base_revision")
    b = obj(m["base"], {"image_ref", "source_repository", "source_ref", "source_revision",
                        "signer_workflow", "producer_run_url", "attestation_url",
                        "independent_signature_verification"}, "base")
    match(b["image_ref"], r"ghcr\.io/paperclipai/paperclip@sha256:[0-9a-f]{64}", "base.image_ref")
    require(b["source_repository"] == "paperclipai/paperclip", "base.source_repository")
    require(b["source_ref"] == "refs/heads/master", "base.source_ref")
    match(b["source_revision"], r"[0-9a-f]{40}", "base.source_revision")
    require(b["signer_workflow"] == "paperclipai/paperclip/.github/workflows/docker.yml@refs/heads/master",
            "base.signer_workflow")
    match(b["producer_run_url"], r"https://github\.com/paperclipai/paperclip/actions/runs/[0-9]+", "producer_run_url")
    match(b["attestation_url"], r"https://github\.com/paperclipai/paperclip/attestations/[0-9]+", "attestation_url")
    require(b["independent_signature_verification"] == "UNESTABLISHED",
            "base: source packet cannot assert signature verification")
    w = obj(m["wrapper"], {"repository", "source_revision", "path", "sha256", "toolchain_version",
                           "toolchain_file_sha256", "current_policy_acceptance"}, "wrapper")
    require(w["repository"] == "TogetherWeOwn/two-bot-next", "wrapper.repository")
    match(w["source_revision"], r"[0-9a-f]{40}", "wrapper.source_revision")
    require(w["path"] == "scripts/cargo_cache.py", "wrapper.path")
    for key in ("sha256", "toolchain_file_sha256"):
        match(w[key], r"[0-9a-f]{64}", "wrapper." + key)
    require(w["toolchain_version"] == "1.98.1", "wrapper.toolchain_version")
    require(w["current_policy_acceptance"] == "UNESTABLISHED", "wrapper.current_policy_acceptance")
    obj(m["files"], FILES, "files")
    obj(files, FILES, "source files")
    for name in sorted(FILES):
        match(m["files"][name], r"[0-9a-f]{64}", "files." + name)
        require(hashlib.sha256(files[name]).hexdigest() == m["files"][name], "source hash drift: " + name)
    n = obj(parse(files["native-packages.json"]), {"schema", "architecture", "distribution", "snapshot",
                                                 "index_url", "packages", "evidence"}, "native")
    require(n["schema"] == "execution-image.native-packages.v1", "native.schema")
    require(n["architecture"] == "amd64" and n["distribution"] == "trixie", "native.platform")
    match(n["snapshot"], r"[0-9]{8}T[0-9]{6}Z", "native.snapshot")
    require(n["index_url"] == "https://snapshot.debian.org/archive/debian/" + n["snapshot"]
            + "/dists/trixie/main/binary-amd64/Packages.xz", "native.index_url")
    require(n["evidence"] == "read_only_snapshot_index_not_an_installed_package_receipt", "native.evidence")
    obj(n["packages"], PACKAGES, "native.packages")
    for name, version in n["packages"].items():
        match(version, r"[0-9][A-Za-z0-9.+:~\-]{0,79}", "native.packages." + name)
    require(parse(files["runtime-contract.json"]) == RUNTIME, "runtime contract drift")
    require(files["native.sources"] == sources(n).encode(), "APT sources drift")
    require(files["Dockerfile"] == dockerfile(b, n).encode(), "recipe drift")
    out = obj(m["output"], {"image_digest", "exact_runtime_receipt", "dependency_inventory",
                           "configuration_receipt"}, "output")
    require(all(value is None for value in out.values()), "output: nothing produced or accepted")
    auth = obj(m["authorization"], {"image_creation", "runtime_change", "host_action", "hold_clearance"}, "authorization")
    require(all(value is False for value in auth.values()), "authorization: no action authorized")
    return {"result": "source_packet_consistent", "state": "unbuilt_recipe",
            "base_signature_verification": "UNESTABLISHED", "image_digest": None,
            "runtime_acceptance": "UNESTABLISHED", "image_creation_authorized": False,
            "manifest_canonical_sha256": hashlib.sha256(json.dumps(m, sort_keys=True, separators=(",", ":")).encode()).hexdigest()}


def read_regular(path):
    # Linux source packets only. Never block opening a FIFO, and check the opened
    # descriptor rather than trusting a path-level check that can race a swap.
    require(stat.S_ISREG(path.lstat().st_mode), "non-regular source refused: " + path.name)
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        require(stat.S_ISREG(os.fstat(fd).st_mode), "non-regular source refused: " + path.name)
        with os.fdopen(fd, "rb", closefd=False) as stream:
            raw = stream.read(MAX_BYTES + 1)
        require(len(raw) <= MAX_BYTES, "source input exceeds 64KiB: " + path.name)
        return raw
    finally:
        os.close(fd)


def read_packet(path):
    # Fixed sibling names only; manifest data cannot select arbitrary files.
    manifest = parse(read_regular(path))
    files = {name: read_regular(path.parent / name) for name in sorted(FILES)}
    return manifest, files


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args()
    try:
        result = validate(*read_packet(args.manifest))
    except (InvalidPacket, OSError) as exc:
        reason = str(exc) if isinstance(exc, InvalidPacket) else "source input unavailable"
        print(json.dumps({"result": "source_packet_rejected", "reason": reason,
                          "image_creation_authorized": False}))
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
