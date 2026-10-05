#!/usr/bin/env python3
"""Propose-only red-main core and explicit read-only transport boundary.

snapshot/propose <owner/repo> [...]. No create/update/apply/schedule operations.
Exit 0: complete observation, no red entries (snapshot) or no new drafts (propose).
Exit 1: complete observation, red entries / new drafts. Exit 2: local refusal.
Exit 3: incomplete observation, including denied/pending/no-signal/non-started CI.
Incomplete coverage dominates red in BOTH modes; partial red evidence may print.
An unreadable/possibly-truncated board produces NO output, not incidentExists:false.

Trusted operator environment (not remote response fields) supplies configuration:
  RED_MAIN_PROD_PATH_REPOS  REQUIRED JSON array of distinct owner/repo strings.
                           [] explicitly declares no production-path repositories.
                           Missing, malformed or ambiguous policy refuses BEFORE
                           board/CI/HTTP transport. Captured once, never overridden
                           by board/check/reader data. S1 for listed repos, else S2.
                           Required-check/security-gate/S3 triage is not ported.
  GH_TOKEN                 REQUIRED CI credential; no alternate-variable fallback.
  RED_MAIN_API_KEY         REQUIRED board credential; no alternate-key fallback.
  PAPERCLIP_API_URL        REQUIRED HTTPS board base URL, no identity/userinfo/query.
  PAPERCLIP_COMPANY_ID     REQUIRED board coordinate; no default authority.
  GH_API_URL               HTTPS CI base URL (default https://api.github.com).
  GH_CI_STATUS_BIN         Optional trusted executable reader path; defaults to
                           sibling gh_ci_status.sh. Invoked --quiet REPO main.
  INCIDENT_SOURCE_CMD      Optional explicit trusted read-only board supplier,
                           argv parsed with shlex (NEVER a shell/eval). This replaces
                           board HTTP by configuration, NOT on credential/HTTP failure.
                           It must return the COMPLETE open-incident query as JSON.
                           Board URL/company are not needed with this supplier;
                           the explicit board credential is still required.

Operator trust is a deployment requirement, not an attestation this CLI can prove.
Protect env/reader/supplier/PATH from untrusted writers. Remote policy/severity
fields have no authority. Credentials reach children only by env/header files;
child stderr/remote error bodies are not logged. Curl never follows redirects.
The existing reader must remain fail-closed; this port does not rewrite it.

v1 key: red-main:v1:owner/repo:sig8, SHA-1 over the ASCII-lowercased, sorted unique
failure-name set joined by LF with NO trailing LF. Head SHA is evidence, not key.
Only a fully readable empty check set plus an observed external/workflow failure
may use the reader's stable reason as a fallback key. No blind fetch fallback.
"""
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import string
import subprocess
import sys
import tempfile
from urllib.parse import urlencode, urlsplit

BOARD_LIMIT = 1000
OPEN_STATUSES = frozenset(("backlog", "todo", "in_progress", "in_review", "blocked"))
TERMINAL_STATUSES = frozenset(("done", "cancelled", "closed"))
FAIL_CONCLUSIONS = frozenset(("failure", "timed_out", "cancelled", "action_required", "startup_failure"))
LOWER = str.maketrans(string.ascii_uppercase, string.ascii_lowercase)
MAX_BODY = 4 * 1024 * 1024


class Refused(Exception):
    """Invalid local configuration; messages contain no supplied values."""


class Unobserved(Exception):
    """Incomplete remote measurement; never a green or a red incident."""


def unique_object(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError("duplicate JSON field")
        obj[key] = value
    return obj


def read_json(raw):
    if not raw or len(raw.encode("utf-8")) > MAX_BODY:
        raise ValueError("missing/oversized JSON")
    return json.loads(raw, object_pairs_hook=unique_object,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("non-finite JSON")))


def valid_repo(value):
    return (isinstance(value, str) and len(value) <= 255 and ".." not in value
            and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9][A-Za-z0-9_.-]*", value) is not None)


def production_policy(env):
    # This is the ONLY policy source. Do not add remote/env fallback defaults.
    if "RED_MAIN_PROD_PATH_REPOS" not in env:
        raise Refused("RED_MAIN_PROD_PATH_REPOS is required; supply an explicit JSON array (including [])")
    try:
        rows = read_json(env["RED_MAIN_PROD_PATH_REPOS"])
        if not isinstance(rows, list) or not all(valid_repo(r) for r in rows):
            raise ValueError("invalid repository list")
        normalized = [r.lower() for r in rows]
        if len(normalized) != len(set(normalized)):
            raise ValueError("duplicate repositories")
    except (ValueError, UnicodeError, RecursionError):
        raise Refused("RED_MAIN_PROD_PATH_REPOS must be a JSON array of distinct canonical owner/repo strings") from None
    return frozenset(normalized)


def base_url(value):
    try:
        u = urlsplit(value)
        if (not value or any(c.isspace() or ord(c) < 32 for c in value)
                or u.scheme != "https" or not u.hostname or u.username is not None
                or u.password is not None or u.query or u.fragment or "\\" in value
                or ".." in u.path or (u.port is not None and not 1 <= u.port <= 65535)):
            raise ValueError("invalid base URL")
    except ValueError:
        raise Refused("transport base URLs must be explicit HTTPS URLs without userinfo/query/fragment") from None
    return value.rstrip("/")


def credential(env, key):
    value = env.get(key, "")
    if not value or any(c.isspace() or ord(c) < 33 or ord(c) > 126 for c in value):
        raise Refused(key + " is required and must be a single printable credential; no fallback is permitted")
    return value


@dataclass(frozen=True)
class Config:
    production: frozenset
    github_key: str
    board_key: str
    github_url: str
    board_url: str
    company: str
    ci_reader: str
    board_command: tuple
    curl: str
    path: str

    @classmethod
    def from_environment(cls, env):
        # Validate/capture policy BEFORE discovering/invoking ANY transport.
        production = production_policy(env)
        github_key = credential(env, "GH_TOKEN")
        board_key = credential(env, "RED_MAIN_API_KEY")
        github_url = base_url(env.get("GH_API_URL", "https://api.github.com"))
        reader = env.get("GH_CI_STATUS_BIN", str(Path(__file__).resolve().with_name("gh_ci_status.sh")))
        if not Path(reader).is_file() or not os.access(reader, os.X_OK):
            raise Refused("CI reader must be an available trusted executable")
        board_command = ()
        board_url = ""
        company = ""
        if "INCIDENT_SOURCE_CMD" in env:
            try:
                board_command = tuple(shlex.split(env["INCIDENT_SOURCE_CMD"]))
            except ValueError:
                raise Refused("board supplier must be a valid executable argv, not shell syntax") from None
            if not board_command:
                raise Refused("explicit board supplier must not be empty")
            supplier = shutil.which(board_command[0], path=env.get("PATH", os.defpath))
            if not supplier or not Path(supplier).is_file():
                raise Refused("board supplier must be an available trusted executable")
            board_command = (supplier, *board_command[1:])
        else:
            board_url = base_url(env.get("PAPERCLIP_API_URL", ""))
            company = env.get("PAPERCLIP_COMPANY_ID", "")
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", company):
                raise Refused("PAPERCLIP_COMPANY_ID must be an explicit canonical board coordinate")
        path = env.get("PATH", os.defpath)
        curl = shutil.which("curl", path=path)
        if not curl:
            raise Refused("curl must be available")
        return cls(production, github_key, board_key, github_url, board_url, company,
                   reader, board_command, curl, path)

    def redact(self, text):
        for key in sorted((self.github_key, self.board_key), key=len, reverse=True):
            text = text.replace(key, "[redacted]")
        return text


def clean_text(value):
    return (isinstance(value, str) and bool(value.strip()) and len(value) <= 16384
            and not any(ord(c) < 32 or 127 <= ord(c) <= 159 or 0xD800 <= ord(c) <= 0xDFFF for c in value))


def complete_metadata(obj, count):
    """Conservative refusal for supported pagination/incompleteness signals."""
    if not isinstance(obj, dict):
        return
    for field in ("error", "errors"):
        if field in obj:
            raise Unobserved("board error envelope")
    for field in ("hasMore", "has_more", "hasNextPage", "truncated", "incomplete"):
        if field in obj and obj[field] is not False:
            raise Unobserved("board completeness not established")
    for field in ("next", "nextCursor", "next_cursor", "nextPage", "continuationToken"):
        if field in obj and obj[field] not in (None, "", False):
            raise Unobserved("board has another page")
    for field in ("total", "totalCount", "total_count"):
        if field in obj and (type(obj[field]) is not int or obj[field] != count):
            raise Unobserved("board total does not match measured rows")
    for field in ("pagination", "pageInfo", "links"):
        if field in obj:
            if not isinstance(obj[field], dict):
                raise Unobserved("unrecognised board pagination")
            complete_metadata(obj[field], count)


def board_titles(raw):
    try:
        obj = read_json(raw)
    except (ValueError, UnicodeError, RecursionError):
        raise Unobserved("board JSON unreadable") from None
    if isinstance(obj, list):
        rows = obj
    elif isinstance(obj, dict) and ("issues" in obj) != ("data" in obj):
        rows = obj.get("issues", obj.get("data"))
    else:
        raise Unobserved("unrecognised board shape")
    if not isinstance(rows, list) or len(rows) >= BOARD_LIMIT:
        raise Unobserved("board may be truncated")
    complete_metadata(obj, len(rows))
    titles = []
    for row in rows:
        if not isinstance(row, dict) or not clean_text(row.get("title")):
            raise Unobserved("board row unreadable")
        if "status" in row:
            status = row["status"]
            if not isinstance(status, str) or status not in OPEN_STATUSES | TERMINAL_STATUSES:
                raise Unobserved("unrecognised board status")
            if status in TERMINAL_STATUSES:
                continue
        # A supplier omitting status attests that its rows cover the open query.
        titles.append(row["title"])
    return titles


def incident_exists(tag, titles):
    # Literal complete tag, not a substring of an extended repo/hash identifier.
    match = re.compile(r"(?<![A-Za-z0-9_:/.-])" + re.escape(tag) + r"(?![A-Za-z0-9_:/.-])")
    return any(match.search(title) for title in titles)


def signature(key):
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:8]


def severity(repo, production):
    return "S1" if repo.lower() in production else "S2"


class Reads:
    def __init__(self, config, work):
        self.config = config
        self.work = Path(work)
        # A new child environment prevents alternate-credential/config/startup
        # fallback. Private HOME disables inherited curlrc/netrc; no proxy vars.
        self.env = {"PATH": config.path, "HOME": work, "TMPDIR": work,
                    "LC_ALL": "C", "PYTHONDONTWRITEBYTECODE": "1"}

    def run(self, args, extra=None):
        try:
            response = subprocess.run(args, env=dict(self.env, **(extra or {})),
                                      capture_output=True, text=True, timeout=60)
            if len(response.stdout.encode("utf-8")) > MAX_BODY:
                raise Unobserved("transport response oversized")
            return response
        except (OSError, UnicodeError, subprocess.TimeoutExpired):
            raise Unobserved("transport unavailable") from None

    def http(self, url, key):
        # Only literal GET, no redirects, no auth on argv, no credential fallback.
        with tempfile.NamedTemporaryFile(dir=self.work, mode="w", encoding="ascii") as header:
            os.fchmod(header.fileno(), 0o600)
            header.write("Authorization: Bearer " + key + "\nAccept: application/vnd.github+json\n")
            header.flush()
            with tempfile.NamedTemporaryFile(dir=self.work) as body:
                response = self.run([self.config.curl, "-q", "-sS", "--proto", "=https",
                                     "--max-time", "20", "--connect-timeout", "5",
                                     "-o", body.name, "-w", "%{http_code}", "-H", "@" + header.name, url])
                if response.returncode or response.stdout != "200":
                    raise Unobserved("HTTP read failed; no alternate-credential retry")
                body.seek(0)
                try:
                    raw = body.read(MAX_BODY + 1)
                    if len(raw) > MAX_BODY:
                        raise Unobserved("HTTP response oversized")
                    return raw.decode("utf-8")
                except UnicodeError:
                    raise Unobserved("HTTP response unreadable") from None

    def board(self):
        if self.config.board_command:
            response = self.run(self.config.board_command, {"RED_MAIN_API_KEY": self.config.board_key})
            if response.returncode:
                raise Unobserved("board supplier failed")
            raw = response.stdout
        else:
            query = urlencode({"status": ",".join(sorted(OPEN_STATUSES)),
                               "q": "red-main:v1", "limit": BOARD_LIMIT})
            raw = self.http(self.config.board_url + "/api/companies/" + self.config.company + "/issues?" + query,
                            self.config.board_key)
        return board_titles(raw)

    def ci(self, repo):
        response = self.run([self.config.ci_reader, "--quiet", repo, "main"],
                            {"GH_TOKEN": self.config.github_key, "GH_API_URL": self.config.github_url})
        try:
            obj = read_json(response.stdout)
        except (ValueError, UnicodeError, RecursionError):
            raise Unobserved("CI reader JSON unreadable") from None
        if (not isinstance(obj, dict) or obj.get("repo") != repo or obj.get("ref") != "main"
                or type(obj.get("exitCode")) is not int or obj["exitCode"] != response.returncode):
            raise Unobserved("CI reader verdict is unbound/contradictory")
        kind = obj.get("verdict")
        if (response.returncode, kind) not in ((0, "pass"), (1, "fail")):
            raise Unobserved("CI denied/pending/no-signal/not-started or otherwise unobserved")
        if (type(obj.get("signalsObserved")) is not int or obj["signalsObserved"] <= 0
                or not isinstance(obj.get("sources"), dict) or "read" not in obj["sources"].values()
                or obj.get("nonStarted") != []
                or obj.get("nonStartedProbe") not in ("clean", "not-needed")):
            raise Unobserved("CI signal/classification incomplete")
        return obj

    def failure_set(self, repo, ci):
        raw = self.http(self.config.github_url + "/repos/" + repo + "/commits/main/check-runs?per_page=100",
                        self.config.github_key)
        try:
            obj = read_json(raw)
        except (ValueError, UnicodeError, RecursionError):
            raise Unobserved("check set unreadable") from None
        if not isinstance(obj, dict) or not isinstance(obj.get("check_runs"), list):
            raise Unobserved("unrecognised check set")
        rows = obj["check_runs"]
        if type(obj.get("total_count")) is not int or obj["total_count"] != len(rows) or len(rows) >= 100:
            raise Unobserved("check set possibly truncated")
        names = set()
        heads = set()
        for row in rows:
            if (not isinstance(row, dict) or not clean_text(row.get("name"))
                    or row.get("status") != "completed"):
                raise Unobserved("check set pending/unreadable")
            conclusion = row.get("conclusion")
            if not isinstance(conclusion, str) or conclusion not in FAIL_CONCLUSIONS | {"success", "neutral", "skipped"}:
                raise Unobserved("unrecognised check conclusion")
            head = row.get("head_sha", "")
            if not isinstance(head, str) or (head and not re.fullmatch(r"[a-fA-F0-9]{40}|[a-fA-F0-9]{64}", head)):
                raise Unobserved("invalid check head")
            if head:
                heads.add(head.lower())
            if conclusion in FAIL_CONCLUSIONS:
                names.add(row["name"].translate(LOWER))
        if len(heads) > 1:
            raise Unobserved("check heads changed/mixed")
        head = next(iter(heads), "")
        if names:
            return "\n".join(sorted(names)), head, "checks"
        # A failed/empty raw read is NOT licensed as a reason fallback. Only
        # external/workflow failure with a confirmed complete empty set is.
        reason = ci.get("reason")
        sources = ci["sources"]
        if (rows or not clean_text(reason)
                or not any(sources.get(s) == "read" for s in ("commitStatuses", "workflowRuns"))):
            raise Unobserved("fail verdict has no stable measured failure key")
        return reason, head, "reason"


def poll(repo, reads, titles):
    ci = reads.ci(repo)
    if ci["verdict"] == "pass":
        return None
    key, head, source = reads.failure_set(repo, ci)
    sig = signature(key)
    tag = "red-main:v1:" + repo + ":" + sig
    return {"repo": repo, "signature": sig, "dedupeTag": tag, "headSha": head,
            "failingJobs": key, "sigSource": source,
            "suggestedSeverity": severity(repo, reads.config.production),
            "incidentExists": incident_exists(tag, titles)}


def draft(entry):
    return ("### [" + entry["dedupeTag"] + "] Red main: " + entry["repo"] + "\n\n"
            "The `main` branch is red (head `" + (entry["headSha"] or "unknown") + "`).\n\n"
            "Failing checks/key material:\n\n" + entry["failingJobs"] + "\n\n"
            "Dedupe key: `" + entry["dedupeTag"] + "` (signature source: " + entry["sigSource"] + ").\n\n"
            "Suggested severity: " + entry["suggestedSeverity"] + " (trusted production-path policy; "
            "required-check/security-gate classification is not measured here).\n\n"
            "Triage: maintain one open incident per repository plus signature. Refresh existing evidence "
            "rather than opening duplicates. A separately authorized operator owns routing and closure, "
            "based on green main at the fixed head with run evidence and red duration.\n\n"
            "Source: `red_main_poll.sh propose` (propose-only; no board writes).\n\n---\n\n")


def main(args=None, env=None):
    args = list(sys.argv[1:] if args is None else args)
    if args in (["--help"], ["-h"], ["help"]):
        print(__doc__)
        return 0
    try:
        if len(args) < 2 or args[0] not in ("snapshot", "propose"):
            raise Refused("usage: red_main_poll.sh snapshot|propose <owner/repo> [...]; no write mode")
        repos = args[1:]
        if not all(valid_repo(r) for r in repos) or len({r.lower() for r in repos}) != len(repos):
            raise Refused("repositories must be distinct canonical owner/repo strings")
        config = Config.from_environment(dict(os.environ if env is None else env))
    except Refused as error:
        print("red_main_poll: refused: " + str(error), file=sys.stderr)
        return 2
    with tempfile.TemporaryDirectory(prefix="red-main-reads-") as work:
        reads = Reads(config, work)
        try:
            titles = reads.board()
        except Unobserved as error:
            print("red_main_poll: board unreadable; " + str(error), file=sys.stderr)
            return 3
        entries = []
        incomplete = False
        for repo in repos:
            try:
                entry = poll(repo, reads, titles)
                if entry:
                    entries.append(entry)
            except Unobserved as error:
                incomplete = True
                print("UNKNOWN " + repo + " @ main: " + str(error), file=sys.stderr)
        if args[0] == "snapshot":
            safe_entries = [{k: config.redact(v) if isinstance(v, str) else v
                             for k, v in entry.items()} for entry in entries]
            output = json.dumps({"redMains": safe_entries}, ensure_ascii=True) + "\n"
            has_red = bool(entries)
        else:
            drafts = [draft(e) for e in entries if not e["incidentExists"]]
            output = "".join(drafts)
            has_red = bool(drafts)
        # Final rendering also redacts credentials echoed by a hostile response.
        sys.stdout.write(config.redact(output))
        if incomplete:
            return 3
        return 1 if has_red else 0


if __name__ == "__main__":
    sys.exit(main())
