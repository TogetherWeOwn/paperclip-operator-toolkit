#!/usr/bin/env python3
"""Structural GARM image lint. Standard library only; no execution or network."""
import json
from pathlib import Path
import re
import shlex
import sys
from typing import NamedTuple

PROFILE = Path(__file__).resolve().parent / "github-runner/garm/isolated-image-profile.json"
SECRET_NAME = re.compile(r"password|passwd|secret|token|api[-_]?key|_key", re.I)
PACKAGE_PIN = re.compile(r"[a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?=[a-zA-Z0-9][a-zA-Z0-9.+:~_-]*")
KNOWN_INSTRUCTIONS = {"FROM", "RUN", "COPY", "ADD", "USER", "ENV", "ARG", "ENTRYPOINT",
                      "CMD", "SHELL", "WORKDIR", "LABEL", "EXPOSE", "VOLUME", "STOPSIGNAL",
                      "HEALTHCHECK", "MAINTAINER"}


class Instruction(NamedTuple):
    line: int
    op: str
    args: str
    comments: str


class FormatError(ValueError):
    pass


def instructions(text):
    """Join Docker continuations before inspecting any instruction's operands."""
    result = []
    comments = []
    pending = ""
    start = 0
    for number, physical in enumerate(text.splitlines(), 1):
        stripped = physical.strip()
        if stripped.startswith("#"):
            if re.match(r"#\s*escape\s*=", stripped, re.I) and not stripped.endswith("\\"):
                raise FormatError("unsupported Docker escape directive")
            if not pending:
                comments.append(stripped)
            continue
        if not stripped:
            continue
        if not pending:
            start = number
        # Docker continuations use a trailing backslash, not shell execution.
        continued = stripped.endswith("\\")
        pending += (stripped[:-1] + " ") if continued else stripped
        if continued:
            continue
        match = re.fullmatch(r"([A-Za-z]+)\s+(.+)", pending)
        if not match or match[1].upper() not in KNOWN_INSTRUCTIONS:
            raise FormatError("unknown or malformed Docker instruction")
        result.append(Instruction(start, match[1].upper(), match[2], "\n".join(comments)))
        comments = []
        pending = ""
    if pending:
        raise FormatError("unterminated Docker continuation")
    if not result:
        raise FormatError("empty Dockerfile")
    return result


def shell_commands(args):
    """Literal shell commands with their preceding connector, never evaluated.

    Opaque RUN forms are refused instead of silently dropping them from gates.
    This is a structural policy checker, not a general shell security analyser.
    """
    if args.startswith("[") or any(part in args for part in ("$", "`", "<<")):
        raise FormatError("RUN must use the supported literal shell form")
    lexer = shlex.shlex(args, posix=True, punctuation_chars=";&|<>()")
    lexer.whitespace_split = True
    lexer.commenters = ""  # only full-line Docker comments are comments
    words = list(lexer)
    result = []
    command = []
    before = ""
    for word in words:
        if word in {"&&", "||", ";", "|"}:
            if not command:
                raise FormatError("empty shell command")
            result.append((before, command))
            command = []
            before = word
        elif re.fullmatch(r"[;&|<>()]+", word):
            raise FormatError("unsupported shell operator")
        else:
            command.append(word)
    if not command:
        raise FormatError("empty shell command")
    result.append((before, command))
    return result


def executable(command):
    words = list(command)
    while words and re.match(r"[A-Za-z_][A-Za-z0-9_]*=", words[0]):
        words.pop(0)
    if words and Path(words[0]).name == "env":
        words.pop(0)
        while words and (words[0].startswith("-") or "=" in words[0]):
            words.pop(0)
    return Path(words[0]).name if words else ""


def cleans_apt(command):
    return (executable(command) == "rm"
            and any(word in {"-rf", "-fr"} for word in command[1:])
            and "/var/lib/apt/lists/*" in command[1:])


def findings(text, distribution):
    problems = []

    def fail(code, line, detail):
        # Details are fixed strings: never echo operands which may be secrets.
        problems.append((code, line, detail))

    try:
        body = instructions(text)
    except (FormatError, ValueError):
        return [("GARM-FORMAT-09", 0, "unsupported or malformed Dockerfile syntax")]

    # MUTATION-ANCHOR-START: base gate
    bases = [inst for inst in body if inst.op == "FROM"]
    if len(bases) != 1:
        fail("GARM-BASE-01", 0, "want exactly one FROM")
    else:
        base = bases[0]
        words = shlex.split(base.args)
        reference = words[0] if words else ""
        repository, release = distribution.rsplit("-", 1)
        pin = re.fullmatch(r"([^:@\s]+):([0-9]+\.[0-9]+)(?:@sha256:([0-9a-fA-F]{64}))?", reference)
        if (len(words) != 1 or not pin or pin[1] != repository or pin[2] != release):
            fail("GARM-BASE-01", base.line, "FROM must match the isolated profile's repository and full release")
        elif not pin[3] and not re.search(r"#\s*pinned-at-build:\s*\S", base.comments, re.I):
            fail("GARM-BASE-01", base.line, "base needs a digest or an operator pinned-at-build justification")
    # MUTATION-ANCHOR-END

    # MUTATION-ANCHOR-START: user gate
    users = [inst for inst in body if inst.op == "USER"]
    if not users:
        fail("GARM-USER-02", 0, "no USER: image would run as root")
    else:
        user = users[-1]
        value = user.args.split(":", 1)[0]
        if (not re.fullmatch(r"(?:[A-Za-z_][A-Za-z0-9_-]*|[0-9]+)(?::(?:[A-Za-z_][A-Za-z0-9_-]*|[0-9]+))?", user.args)
                or value.lower() == "root" or (value.isdigit() and int(value) == 0)):
            fail("GARM-USER-02", user.line, "final USER must name a literal non-root account, before its optional group")
    # MUTATION-ANCHOR-END

    for inst in body:
        terms = re.findall(r"[A-Za-z_][A-Za-z0-9_.-]*", inst.args.lower())
        if any(term == "sudo" or term.startswith("sudo-") for term in terms):
            fail("GARM-PRIV-03", inst.line, "sudo refused on the isolated image")
        if any(term in {"docker", "docker.io", "docker_host", "moby-engine"}
               or term.startswith("docker-") for term in terms) or "/var/run/docker" in inst.args.lower():
            fail("GARM-PRIV-03", inst.line, "Docker client, daemon, socket or relay surface refused")
        if inst.op == "ADD":
            fail("GARM-COPY-05", inst.line, "ADD refused: use COPY")
        if inst.op in {"ENTRYPOINT", "CMD", "SHELL"}:
            try:
                value = json.loads(inst.args)
                if not isinstance(value, list) or not value or not all(isinstance(word, str) for word in value):
                    raise ValueError("not an exec array")
            except (ValueError, TypeError):
                fail("GARM-EXEC-06", inst.line, "use a valid nonempty JSON array of strings")
        if inst.op in {"ENV", "ARG"}:
            words = shlex.split(inst.args)
            if inst.op == "ARG":
                if len(words) != 1:
                    fail("GARM-FORMAT-09", inst.line, "ARG must declare one name with an optional default")
                names = [word.split("=", 1)[0] for word in words]
            elif words and "=" not in words[0]:  # legacy ENV name value
                names = words[:1]
                if len(words) < 2:
                    fail("GARM-FORMAT-09", inst.line, "ENV must declare a value")
            else:
                names = [word.split("=", 1)[0] for word in words]
                if not words or any("=" not in word for word in words):
                    fail("GARM-FORMAT-09", inst.line, "ENV assignments must each declare a value")
            if any(SECRET_NAME.search(name) for name in names):
                fail("GARM-SECRET-07", inst.line, "credential-shaped ENV/ARG name refused")
        if re.search(r"--(?:password|token|api-?key)(?:[=\s]|$)", inst.args, re.I):
            fail("GARM-SECRET-07", inst.line, "credential flag refused")
        if re.search(r":latest(?:[\s\"'@,\]]|$)", inst.args, re.I) or inst.op == "MAINTAINER":
            fail("GARM-FORMAT-09", inst.line, "floating latest tag or deprecated MAINTAINER refused")
        if inst.op != "RUN":
            continue
        try:
            commands = shell_commands(inst.args)
        except (FormatError, ValueError):
            fail("GARM-FORMAT-09", inst.line, "unsupported or malformed RUN syntax")
            continue
        downloaded = False
        for index, (before, command) in enumerate(commands):
            name = executable(command)
            if before != "|":
                downloaded = False
            if name in {"curl", "wget"}:
                downloaded = True
            elif downloaded and before == "|" and name in {"sh", "bash", "dash", "zsh"}:
                fail("GARM-FETCH-08", inst.line, "piped remote installer refused: COPY verified artifacts")
            if name not in {"apt-get", "apt"}:
                continue
            if any(word in {"upgrade", "dist-upgrade", "full-upgrade"} for word in command[1:]):
                fail("GARM-APT-04", inst.line, "apt upgrades float the base: rebuild instead")
            if "install" not in command[1:]:
                continue
            position = command.index("install")
            options = command[1:position] + command[position + 1:]
            if "--no-install-recommends" not in options or "--install-recommends" in options:
                fail("GARM-APT-04", inst.line, "each install needs --no-install-recommends")
            packages = [word for word in command[position + 1:] if not word.startswith("-")]
            if not packages or any(not PACKAGE_PIN.fullmatch(word) for word in packages):
                fail("GARM-APT-04", inst.line, "each apt package needs a literal exact =version pin")
            if not any(cleans_apt(later) for _, later in commands[index + 1:]):
                fail("GARM-APT-04", inst.line, "each install layer must clean /var/lib/apt/lists/* after installing")
    return problems


def main(argv):
    if argv in (["-h"], ["--help"]):
        print("Usage: garm_image_lint.sh <Dockerfile> [...]\nOffline structural lint; no image or host operations.")
        return 0
    if not argv:
        print("Usage: garm_image_lint.sh <Dockerfile> [...]", file=sys.stderr)
        return 2
    try:
        distribution = json.loads(PROFILE.read_text())["base"]["distribution"]
        if not isinstance(distribution, str) or not re.fullmatch(r"[a-z0-9]+-[0-9]+\.[0-9]+", distribution):
            raise ValueError("invalid profile base")
    except (OSError, ValueError, KeyError, TypeError):
        print("RULE GARM-USAGE profile:0 unreadable or invalid isolated profile", file=sys.stderr)
        return 2
    failed = False
    unreadable = False
    for path in argv:
        try:
            problems = findings(Path(path).read_text(), distribution)
        except OSError:
            print(f"RULE GARM-USAGE {path}:0 unreadable file", file=sys.stderr)
            unreadable = True
            continue
        except (ValueError, TypeError):
            problems = [("GARM-FORMAT-09", 0, "malformed instruction operands")]
        for code, line, detail in problems:
            print(f"RULE {code} {path}:{line} {detail}", file=sys.stderr)
            failed = True
    return 1 if failed else 2 if unreadable else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
