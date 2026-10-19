#!/usr/bin/env python3
"""Read-only, shadow escape proxies. No gate decisions and no repository code execution.

Question 1: how many merges and linked revert/fix/incident events occurred per UTC day?
Question 2: which earlier PRs are implicated, by what evidence, with what review provenance?
Question 3: is a zero measured, or did collection/linkage fail?

Git first-parent blame is an SZZ-style *candidate* signal, not proof of causality.
Only a matched completed review on the exact PR head establishes Claude 5/5.
"""
from __future__ import annotations

import argparse
import collections
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import uuid

UTC = dt.timezone.utc
VERSION = 4
FIX = re.compile(r"(?<![a-z])(?:hotfix|fix)(?:es|ed|ing)?(?![a-z])", re.I)
REVERT = re.compile(r"^\s*revert\b", re.I)
REVERT_SHA = re.compile(r"\bthis reverts commit\s+([0-9a-f]{7,40})\b", re.I)
PR_SUFFIX = re.compile(r"\(#([1-9][0-9]*)\)\s*$")
MERGE_MESSAGE = re.compile(r"^Merge pull request #([1-9][0-9]*)\b")
HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@", re.M)
SHA = re.compile(r"[0-9a-f]{40}")
REPO = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
RUN_ID = str(uuid.uuid4())
ENTRY_POINT = "cli"


def stamp(value: dt.datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def instant(value: str) -> dt.datetime:
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timestamp must have a timezone")
    return parsed.astimezone(UTC)


def emit(event: str, **fields) -> None:
    print(json.dumps(dict(event=event, run_id=RUN_ID, entry_point=ENTRY_POINT,
                          at=stamp(dt.datetime.now(UTC)), **fields)), flush=True)


class CollectionError(RuntimeError):
    """Safe diagnostic: never includes credentials, remote URLs or tool stderr."""


def command(argv, *, env=None, timeout=180, stdin=None, allowed_returncodes=(0,)) -> str:
    # Callers pass fixed executables and argument arrays; never interpolate a shell command.
    try:
        result = subprocess.run(argv, input=stdin, capture_output=True, text=True,
                                encoding="utf-8", errors="surrogateescape",
                                env=env, timeout=timeout, check=False, shell=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise CollectionError(f"{Path(argv[0]).name}: {type(exc).__name__}") from None
    if result.returncode not in allowed_returncodes:
        raise CollectionError(f"{Path(argv[0]).name}: exit {result.returncode}")
    return result.stdout


def atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def save_json(path: Path, value) -> None:
    atomic(path, json.dumps(value, ensure_ascii=True, sort_keys=True) + "\n")


def load_json(path: Path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError, RecursionError):
        return None


@contextlib.contextmanager
def lock(path: Path, *, nonblocking=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX | (fcntl.LOCK_NB if nonblocking else 0))
        yield


class GitHub:
    def __init__(self, token_helper: Path):
        self.token_helper = token_helper
        self.env = dict(os.environ, GH_PROMPT_DISABLED="1", GIT_TERMINAL_PROMPT="0")
        self.minted = 0.0
        self.default_branches = {}

    def pull(self, repo, number):
        owner, name = repo.split("/")
        query = """query($owner:String!,$name:String!,$number:Int!){
          repository(owner:$owner,name:$name){pullRequest(number:$number){
          number title body url mergedAt updatedAt headRefName headRefOid baseRefName mergeCommit{oid}}}}"""
        data = self.api("graphql", {"query": query, "variables": {
            "owner": owner, "name": name, "number": number}}, missing_pull=True)
        row = data["data"]["repository"]["pullRequest"]
        return row if row and row.get("mergedAt") else None

    def environment(self):
        if not self.minted or time.monotonic() - self.minted > 1800 or not self.env.get("GH_TOKEN"):
            token = command([str(self.token_helper), "token", "--permissions",
                             "contents=read,pull_requests=read"], timeout=60).strip()
            if not token or "\n" in token:
                raise CollectionError("token helper returned an invalid token shape")
            self.env["GH_TOKEN"] = token
            self.minted = time.monotonic()
        return self.env

    def api(self, path: str, payload=None, *, missing_pull=False):
        argv = ["gh", "api", path]
        if payload is not None:
            argv += ["--method", "POST", "--input", "-"]
        for attempt in range(3):
            try:
                raw = command(argv, env=self.environment(), timeout=180,
                              stdin=json.dumps(payload) if payload is not None else None,
                              allowed_returncodes=(0, 1) if missing_pull else (0,))
                result = json.loads(raw)
                if missing_pull and not (isinstance(result, dict) and isinstance(result.get("data"), dict)):
                    raise CollectionError("GitHub GraphQL returned no data envelope")
                if isinstance(result, dict) and result.get("errors"):
                    # Fork history can name upstream PRs absent in this repository.
                    # gh exits 1 for that valid negative lookup. Accept ONLY an
                    # accessible repository plus an exact missing-pull error;
                    # auth, repository and transport failures remain incomplete.
                    node = (result.get("data") or {}).get("repository")
                    if (missing_pull and isinstance(node, dict) and "pullRequest" in node
                            and node["pullRequest"] is None and all(
                                error.get("type") == "NOT_FOUND" and
                                error.get("path") == ["repository", "pullRequest"]
                                for error in result["errors"])):
                        return result
                    raise CollectionError("GitHub GraphQL returned errors")
                return result
            except (CollectionError, ValueError, RecursionError):
                if attempt == 2:
                    raise CollectionError("GitHub collection failed after three attempts") from None
                time.sleep(2 ** attempt)

    def repos(self, org):
        repos, page = [], 1
        while True:
            rows = self.api(f"orgs/{org}/repos?type=all&per_page=100&page={page}")
            if not isinstance(rows, list):
                raise CollectionError("repository list is not an array")
            repos += [r["full_name"] for r in rows]
            if len(rows) < 100:
                return sorted(set(repos), key=str.lower)
            page += 1

    def merged(self, repo, since: dt.datetime):
        owner, name = repo.split("/")
        query = """query($owner:String!,$name:String!,$cursor:String){
          repository(owner:$owner,name:$name){defaultBranchRef{name} pullRequests(states:MERGED,first:100,
          after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC}){
          pageInfo{hasNextPage endCursor} nodes{number title body url mergedAt updatedAt
          headRefName headRefOid baseRefName mergeCommit{oid}}}}}"""
        cursor, prs = None, {}
        while True:
            data = self.api("graphql", {"query": query, "variables": {
                "owner": owner, "name": name, "cursor": cursor}})
            node = data["data"]["repository"]
            if not node:
                raise CollectionError("repository is not accessible")
            self.default_branches[repo] = (node.get("defaultBranchRef") or {}).get("name")
            connection = node["pullRequests"]
            rows = connection["nodes"]
            for row in rows:
                if instant(row["mergedAt"]) >= since:
                    prs[row["number"]] = row
            # mergedAt <= updatedAt: a completely older page cannot hide a recent merge.
            if not connection["pageInfo"]["hasNextPage"] or (rows and
                    all(instant(r["updatedAt"]) < since for r in rows)):
                return sorted(prs.values(), key=lambda p: p["mergedAt"])
            next_cursor = connection["pageInfo"]["endCursor"]
            if not next_cursor or next_cursor == cursor:
                raise CollectionError("GraphQL cursor did not advance")
            cursor = next_cursor


def git(mirror: Path, *args, env=None, allowed_returncodes=(0,)) -> str:
    return command(["git", "-c", "core.hooksPath=/dev/null", "-c", "core.quotePath=false",
                    "--git-dir", str(mirror), *args], env=env, allowed_returncodes=allowed_returncodes)


def ensure_mirror(root: Path, repo: str, github: GitHub) -> Path:
    if not REPO.fullmatch(repo):
        raise ValueError("invalid repository name")
    # Same org only. Lock and atomic rename cooperate with other read-only workstreams.
    target = root / (repo.split("/")[1] + ".git")
    root.mkdir(parents=True, exist_ok=True)
    with lock(root / ("." + target.name + ".lock")):
        env = github.environment()
        auth = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"]
        remote = f"https://github.com/{repo}.git"
        if not target.exists():
            temp = Path(tempfile.mkdtemp(prefix=f".{target.name}.", dir=root))
            command(["git", *auth, "clone", "--mirror", "--quiet", remote, str(temp)],
                    env=env, timeout=600)
            if not target.exists():
                temp.rename(target)
            # Never delete another workstream's mirror or partial clone.
        if git(target, "rev-parse", "--is-bare-repository").strip() != "true":
            raise CollectionError("shared mirror is not bare")
        # Fetch only heads without pruning; do not persist credentials or alter origin.
        command(["git", *auth, "--git-dir", str(target), "fetch", "--quiet", "--no-prune",
                 remote, "+refs/heads/*:refs/heads/*"], env=env, timeout=600)
    return target


def ensure_commit(mirror: Path, repo: str, sha: str, github: GitHub) -> None:
    if not sha or not SHA.fullmatch(sha):
        raise CollectionError("missing merge commit identity")
    try:
        git(mirror, "cat-file", "-e", sha + "^{commit}")
    except CollectionError:
        # Deleted bases / force-pushes can leave a merged PR outside current branch history.
        # Fetch the exact immutable object, never check out or execute repository code.
        with lock(mirror.parent / ("." + mirror.name + ".lock")):
            command(["git", "-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential",
                     "--git-dir", str(mirror), "fetch", "--quiet", "--no-tags",
                     f"https://github.com/{repo}.git", sha], env=github.environment(), timeout=300)
        git(mirror, "cat-file", "-e", sha + "^{commit}")


def referenced_prs(text: str, repo: str) -> set[int]:
    """Respect repo identity; a foreign #12 must never become local #12."""
    found = set()
    full = re.compile(r"https://github\.com/([\w.-]+/[\w.-]+)/pull/(\d+)\b|"
                      r"(?<![\w/.-])([\w.-]+/[\w.-]+)#(\d+)\b|"
                      r"(?<![\w/.-])([\w.-]+)#(\d+)\b")
    def consume(match):
        owner_repo = match[1] or match[3] or repo.split("/")[0] + "/" + match[5]
        number = match[2] or match[4] or match[6]
        if owner_repo.lower() == repo.lower():
            found.add(int(number))
        return " "
    remainder = full.sub(consume, text)
    found.update(int(x) for x in re.findall(r"(?<![\w/#])#([1-9][0-9]*)\b", remainder))
    return found


def recent_introducer(pr: dict, fix: dict, days=7) -> bool:
    elapsed = instant(fix["mergedAt"]) - instant(pr["mergedAt"])
    return pr["number"] != fix["number"] and dt.timedelta(0) < elapsed <= dt.timedelta(days=days)


def old_ranges(patch: str) -> list[tuple[int, int]]:
    return [(int(m[1]), int(m[2]) if m[2] is not None else 1)
            for m in HUNK.finditer(patch) if (int(m[2]) if m[2] is not None else 1) > 0]


def blame_rows(text: str):
    for line in text.splitlines():
        match = re.fullmatch(r"(\^?[0-9a-f]{40}) (\d+) (\d+)(?: \d+)?", line)
        if match:
            yield match[1].lstrip("^"), int(match[3])


def message_pr(message: str):
    # Only the subject identifies the owning PR, not arbitrary references in its body.
    subject = message.splitlines()[0] if message else ""
    match = PR_SUFFIX.search(subject) or MERGE_MESSAGE.search(subject)
    return int(match[1]) if match else None


class Linker:
    def __init__(self, repo, mirror, prs, resolver=None):
        self.repo, self.mirror, self.resolver = repo, mirror, resolver
        self.prs = {p["number"]: p for p in prs}
        self.by_sha = {(p.get("mergeCommit") or {}).get("oid"): p["number"] for p in prs}
        self.commit_prs = {}
        self.resolved = set()
        self.unresolved_revert_commits = 0

    def resolve(self, number):
        if number not in self.prs and number not in self.resolved and self.resolver:
            row = self.resolver(self.repo, number)
            if row:
                self.prs[number] = row
                self.by_sha[(row.get("mergeCommit") or {}).get("oid")] = number
            self.resolved.add(number)
        return self.prs.get(number)

    def revert_target(self, abbreviated):
        target = git(self.mirror, "rev-parse", "--verify", "--quiet",
                     abbreviated + "^{commit}", allowed_returncodes=(0, 1)).strip()
        if not target:
            self.unresolved_revert_commits += 1
            return None
        return target

    def direct_reverts(self, branches, start, end):
        existing = set(git(self.mirror, "for-each-ref", "--format=%(refname)", "refs/heads").splitlines())
        # Historical PR base branches may have been deleted after integration.
        # Their merged PRs are analyzed by immutable commit; direct-push scanning uses live bases.
        refs = ["refs/heads/" + b for b in sorted(set(filter(None, branches)))
                if "refs/heads/" + b in existing]
        if not refs:
            return []
        raw = git(self.mirror, "log", "--first-parent", "--since=" + stamp(start),
                  "--format=%H%x00%cI%x00%B%x00%x00", *refs, "--")
        events = []
        seen = set()
        for block in raw.split("\0\0"):
            parts = block.strip("\n").split("\0", 2)
            if len(parts) != 3:
                continue
            sha, occurred, message = parts
            if sha in seen or sha in self.by_sha or not start <= instant(occurred) < end:
                continue
            seen.add(sha)
            links = []
            for abbreviated in REVERT_SHA.findall(message):
                full = self.revert_target(abbreviated)
                if not full:
                    continue
                number = self.introducing_pr(full, resolve=True)
                prior = self.resolve(number) if number else None
                if prior and instant(prior["mergedAt"]) <= instant(occurred):
                    links.append({"repo": self.repo, "number": number,
                                  "evidence": [{"method": "direct_git_revert", "commit": full}]})
            if links:
                events.append({"type": "escape", "id": self.repo + "@" + sha,
                               "repo": self.repo, "commit": sha, "kind": "revert",
                               "at": occurred, "introducers": links, "candidate_only": True})
        return events

    def introducing_pr(self, sha, *, resolve=False):
        if sha in self.by_sha:
            return self.by_sha[sha]
        if sha not in self.commit_prs:
            self.commit_prs[sha] = message_pr(git(self.mirror, "show", "-s", "--format=%B", sha))
        number = self.commit_prs[sha]
        prior = self.resolve(number) if number and resolve else self.prs.get(number)
        # Upstream/cherry-picked subjects can reuse a local PR number. A subject is
        # a lookup hint, never identity proof; bind it to the actual merged/head SHA.
        if prior and sha in {(prior.get("mergeCommit") or {}).get("oid"), prior.get("headRefOid")}:
            return number
        return None

    def analyze(self, pr):
        sha = (pr.get("mergeCommit") or {}).get("oid")
        if not sha or not SHA.fullmatch(sha):
            raise CollectionError("merged PR has no valid merge commit")
        parents = git(self.mirror, "rev-list", "--parents", "-n", "1", sha).split()[1:]
        text = (pr.get("title") or "") + "\n" + (pr.get("body") or "")
        # Squash has one commit; merge commits can contain a git revert in the PR branch.
        messages = git(self.mirror, "log", "--format=%B%x00", f"{parents[0]}..{sha}") if parents else ""
        revert_shas = REVERT_SHA.findall(text + "\n" + messages)
        targets = {}
        for abbreviated in revert_shas:
            full = self.revert_target(abbreviated)
            if not full:
                continue
            number = self.introducing_pr(full, resolve=True)
            prior = self.resolve(number) if number else None
            if prior and number != pr["number"] and instant(prior["mergedAt"]) < instant(pr["mergedAt"]):
                targets[number] = full
        # A feature branch can undo its own unmerged experiment before merging.
        # Such internal git reverts are NOT escapes of an earlier merged PR.
        is_revert = bool(REVERT.match(pr["title"]) or REVERT_SHA.search(text) or targets)
        is_fix = bool(FIX.search(pr["title"] + " " + pr["headRefName"]))
        if not (is_revert or is_fix):
            return None
        links = collections.defaultdict(list)
        for number in referenced_prs(text, self.repo):
            previous = self.resolve(number) if is_revert else self.prs.get(number)
            if previous and instant(previous["mergedAt"]) < instant(pr["mergedAt"]) and (
                    is_revert or recent_introducer(previous, pr)):
                links[number].append({"method": "explicit_pr_reference"})
        for number, full in targets.items():
            links[number].append({"method": "reverted_commit", "commit": full})
        stats = {"modified_files": 0, "blamed_lines": 0, "unmapped_lines": 0,
                 "outside_seven_day_lines": 0, "files_without_old_text_lines": 0}
        if parents and ((is_fix and not is_revert) or (is_revert and not links)):
            base = parents[0]  # API baseRefOid after merge is NOT the historical fix base.
            paths = git(self.mirror, "diff", "--no-ext-diff", "--no-renames", "--name-only",
                        "--diff-filter=MD", "-z", base, sha).split("\0")
            for path in filter(None, paths):
                patch = git(self.mirror, "diff", "--no-ext-diff", "--no-textconv", "--no-renames",
                            "--unified=0", base, sha, "--", path)
                ranges = old_ranges(patch)
                if not ranges:
                    stats["files_without_old_text_lines"] += 1
                    continue  # Binary changes and pure additions have no old text lines.
                stats["modified_files"] += 1
                args = ["blame", "--no-textconv", "--first-parent", "--line-porcelain"]
                for start, count in ranges:
                    args += ["-L", f"{start},+{count}"]
                rows = list(blame_rows(git(self.mirror, *args, base, "--", path)))
                if len(rows) != sum(count for _, count in ranges):
                    raise CollectionError("blame returned fewer lines than requested")
                by_origin = collections.defaultdict(list)
                for commit, line in rows:
                    stats["blamed_lines"] += 1
                    number = self.introducing_pr(commit, resolve=is_revert)
                    earlier = self.resolve(number) if is_revert and number else self.prs.get(number)
                    if not earlier:
                        stats["unmapped_lines"] += 1
                    elif instant(earlier["mergedAt"]) >= instant(pr["mergedAt"]):
                        stats["unmapped_lines"] += 1
                    elif not is_revert and not recent_introducer(earlier, pr):
                        stats["outside_seven_day_lines"] += 1
                    else:
                        by_origin[(number, commit)].append(line)
                for (number, commit), lines in by_origin.items():
                    links[number].append({"method": "revert_first_parent_blame" if is_revert else "first_parent_blame", "commit": commit,
                                          "path": path, "base": base, "lines": lines})
        return {"kind": "revert" if is_revert else "hotfix", "links": dict(links),
                "blame": stats, "eligible": is_revert or bool(links)}


def review_status(pr, reviews):
    same = [r for r in reviews if r.get("head_sha") == pr.get("headRefOid") and
            r.get("completed_at") and instant(r["completed_at"]) <= instant(pr["mergedAt"])]
    latest = max(same, key=lambda r: instant(r["completed_at"]), default=None)
    if not latest:
        return {"claude_5_of_5": None, "reason": "no_exact_head_premerge_review"}
    model = latest.get("model") or ""
    answer = (str(latest.get("score")) == "5" and latest.get("conclusion") == "success")
    return {"claude_5_of_5": answer if "claude" in model.lower() else (False if model else None),
            "paperclip_5_of_5": answer, "model": model or None,
            "review_id": latest.get("id"), "reviewed_head": latest["head_sha"],
            "completed_at": latest["completed_at"],
            "reason": "exact_head_premerge" if model else "review_model_unknown"}


def collect_reviews(container, runtime="docker"):
    if not container:
        return {}, "not_configured"
    # Do not export prompts, secrets, entire run snapshots or mutable agent defaults.
    query = """SELECT row_to_json(t) FROM (
      SELECT r.id, lower(r.repository) AS repo, r.pull_number, r.head_sha,
        r.assessment->>'score' AS score, r.conclusion, r.updated_at AS completed_at,
        COALESCE(h.usage_json->>'model', h.context_snapshot->'modelDecision'->>'model') AS model
      FROM chat_github_reviews r LEFT JOIN heartbeat_runs h ON h.id=r.run_id
      WHERE r.assessment IS NOT NULL AND r.conclusion IS NOT NULL
    ) t"""
    raw = command([runtime, "exec", container, "psql", "-U", "paperclip", "-d", "paperclip",
                   "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", query], timeout=120)
    index = collections.defaultdict(list)
    for line in raw.splitlines():
        row = json.loads(line)
        index[(row["repo"], row["pull_number"])].append(row)
    return index, "complete"


def incident_date(line, source):
    match = re.search(r"\b(20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d))", line)
    if match:
        return instant(match[1]), True
    match = re.search(r"\b(20\d\d-\d\d-\d\d)(?:\b|(?=T))", line)
    if match:
        return instant(match[1] + "T00:00:00Z"), True
    match = re.search(r"(20\d{6})", source.name)
    if match:
        value = dt.datetime.strptime(match[1], "%Y%m%d").replace(tzinfo=UTC)
        return value, False
    return None, False


def incident_lines(source, errors):
    try:
        with source.open(errors="replace") as handle:
            yield from enumerate(handle, 1)
    except OSError:
        errors.append(f"incident source unreadable: {source}")


def memory_dir_for_root(root):
    # Claude Code derives the project slug by replacing every
    # non-alphanumeric character with "-": the leading "/" becomes the
    # first dash, and a first component starting with "." or "_" keeps
    # its own dash ("/.x/repo" -> "--x-repo"). Never strip: dropping a
    # dash resolves a directory Claude Code never wrote to.
    project = re.sub(r"[^A-Za-z0-9]", "-", str(root.expanduser().resolve()))
    return Path.home() / ".claude/projects" / project / "memory"


def collect_incidents(paths, repositories, prs_by_repo, start, end):
    events, unlinked, errors, seen = [], [], [], set()
    commits = collections.defaultdict(set)
    for repo, prs in prs_by_repo.items():
        for number, row in prs.items():
            for sha in ((row.get("mergeCommit") or {}).get("oid"), row.get("headRefOid")):
                if sha and SHA.fullmatch(sha):
                    commits[sha].add((repo, number))
    for source in paths:
        for lineno, line in incident_lines(source, errors):
            if not re.search(r"\bINCIDENT(?:S)?\b", line, re.I):
                continue
            try:
                occurred, inline_date = incident_date(line, source)
            except ValueError:
                errors.append(f"incident date invalid: {source}:{lineno}")
                continue
            if not occurred or not start <= occurred < end:
                continue
            links = []
            exact_time = bool(re.search(
                r"\b20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)", line))
            cutoff = occurred if exact_time else min(occurred + dt.timedelta(days=1), end)
            for repo in repositories:
                name = repo.split("/")[1]
                # Short #N is meaningful only with an explicit repository on this line.
                if not re.search(r"(?<![\w.-])" + re.escape(name) + r"(?![\w.-])", line, re.I):
                    continue
                for number in referenced_prs(line, repo):
                    prior = prs_by_repo.get(repo, {}).get(number)
                    if prior and instant(prior["mergedAt"]) <= cutoff:
                        links.append({"repo": repo, "number": number,
                                      "evidence": [{"method": "incident_pr_reference"}]})
            for prefix in set(re.findall(r"(?<![\w-])([0-9a-f]{7,40})(?![\w-])", line, re.I)):
                targets = set().union(*(ids for sha, ids in commits.items() if sha.startswith(prefix.lower())))
                if len(targets) != 1:
                    continue  # Ambiguous short hashes/fork copies are never guessed.
                repo, number = next(iter(targets))
                if instant(prs_by_repo[repo][number]["mergedAt"]) > cutoff:
                    continue
                evidence = {"method": "incident_commit_reference", "commit_prefix": prefix}
                present = next((x for x in links if x["repo"] == repo and x["number"] == number), None)
                if present:
                    present["evidence"].append(evidence)
                else:
                    links.append({"repo": repo, "number": number, "evidence": [evidence]})
            # Inline-dated copies identify one occurrence across source files; filename-only
            # dates retain source and line identity so separate notes are not collapsed.
            identity = "" if inline_date else f"{source.resolve()}:{lineno}"
            digest = hashlib.sha256((stamp(occurred) + "\0" + identity + "\0" + line.strip()).encode()).hexdigest()
            if digest in seen:
                continue
            seen.add(digest)
            entry = {"id": "incident:" + digest, "kind": "incident", "at": stamp(occurred),
                     "repo": links[0]["repo"] if len({x["repo"] for x in links}) == 1 else None,
                     "introducers": links, "source": str(source), "source_line": lineno,
                     "time_precision": "second" if exact_time else "day",
                     "candidate_only": True}
            (events if links else unlinked).append(entry)
    return events, unlinked, errors


def aggregate(merges, events, repos, start, end):
    rows = []
    days = (end.date() - start.date()).days + (1 if end.time() != dt.time() else 0)
    dates = [(start + dt.timedelta(days=n)).date() for n in range(days)]
    for period in ("day", "week"):
        def bucket(value):
            day = instant(value).date()
            return day if period == "day" else day - dt.timedelta(days=day.weekday())
        keys = sorted(set(d if period == "day" else d - dt.timedelta(days=d.weekday()) for d in dates))
        for repo in [*repos, "ALL"]:
            for day in keys:
                count = sum(1 for p in merges if (repo == "ALL" or p["repo"] == repo)
                            and bucket(p["mergedAt"]) == day)
                selected = [e for e in events if (repo == "ALL" or e["repo"] == repo or
                            (e["kind"] == "incident" and any(p["repo"] == repo for p in e.get("introducers", []))))
                            and bucket(e["at"]) == day]
                kinds = collections.Counter(e["kind"] for e in selected)
                # For weeks on the window boundaries, use only observed calendar days.
                exposure = sum((d if period == "day" else d - dt.timedelta(days=d.weekday())) == day for d in dates)
                rows.append({"type": "aggregate", "period": period, "repo": repo, "date": str(day),
                             "merges": count, "merges_per_day": round(count / exposure, 4),
                             "reverts": kinds["revert"], "hotfixes": kinds["hotfix"],
                             "incidents": kinds["incident"], "escapes": len(selected),
                             "escapes_per_100_merges": round(100 * len(selected) / count, 4) if count else None})
    return rows


def render(metadata, rows, events, unlinked):
    text = ["# Shadow escape ledger", "", f"Generated: {metadata['generated_at']}",
            f"Window: [{metadata['start']}, {metadata['end']}) UTC.",
            f"Collection: **{metadata['status']}**; {len(metadata['repos'])} accessible repositories discovered.",
            "", "## Interpretation", "",
            "These are deterministic escape **proxies**, not confirmed production defects. "
            "Fix-title/branch selection plus a <=7-day PR reference or first-parent blame is heuristic. "
            "A changed line is not proof that its earlier author introduced a defect. "
            "Do not promote a gate or claim non-inferiority from this baseline alone.",
            "Reverts count once per reverting PR; a revert is not also a hotfix. "
            "Each fix PR counts once even when it implicates several earlier PRs. "
            "Linked incident evidence counts separately and can overlap a fix/revert; "
            "repeated differently-worded incident notes need adjudication. "
            "Unlinked incident mentions are excluded and shown as a coverage gap.",
            "Rates use event occurrence dates and merges on those dates, not introducer cohorts. "
            "The final day is partial; recent merge cohorts have not had seven days to mature. "
            "Zero denominators are N/A, not 0%. Pure additions and binary changes cannot be blamed. "
            "Only accessible org repositories are observable; discovery is dynamic.",
            "Claude status uses the latest exact-head pre-merge review row and its run's recorded model. "
            "Missing model/review provenance is unknown, never assumed to mean unreviewed.",
            "", "## Per-repository baseline", "",
            "| Repo | Merges | Merges/day | Reverts | Hotfixes | Incidents | Proxies/100 merges |",
            "|---|---:|---:|---:|---:|---:|---:|"]
    for repo in [*metadata["repos"], "ALL"]:
        selected = [r for r in rows if r["period"] == "day" and r["repo"] == repo]
        values = {k: sum(r[k] for r in selected) for k in ("merges", "reverts", "hotfixes", "incidents", "escapes")}
        complete = all(r.get("coverage_status", "complete") == "complete" for r in selected)
        rate = f"{100 * values['escapes'] / values['merges']:.2f}" if values["merges"] and complete else "N/A"
        label = repo if complete else repo + " (PARTIAL; observed counts only)"
        text.append(f"| {label} | {values['merges']} | {values['merges'] / max(len(selected), 1):.2f} | "
                    f"{values['reverts']} | {values['hotfixes']} | {values['incidents']} | {rate} |")
    for period in ("week", "day"):
        text += ["", f"## Org-wide {period} trend", "",
                 "| UTC period start | Merges | Reverts | Hotfixes | Incidents | Proxies/100 merges |",
                 "|---|---:|---:|---:|---:|---:|"]
        for row in rows:
            if row["period"] == period and row["repo"] == "ALL":
                rate = row["escapes_per_100_merges"]
                text.append(f"| {row['date']} | {row['merges']} | {row['reverts']} | {row['hotfixes']} | "
                            f"{row['incidents']} | {rate if rate is not None else 'N/A'} |")
    text += ["", "## Linked events", "",
             "| Event date | Kind | Event | Introducing PR(s); Claude 5/5 |",
             "|---|---|---|---|"]
    for event in events:
        links = [f"{p['repo']}#{p['number']} ({p.get('review', {}).get('claude_5_of_5')})"
                 for p in event["introducers"]]
        label = f"{event['repo']}#{event['number']}" if event.get("number") else event["id"]
        text.append(f"| {event['at'][:10]} | {event['kind']} | {label} | {'; '.join(links) or 'unlinked'} |")
    text += ["", "## Coverage and limitations", "",
             f"Unlinked incident mentions: **{len(unlinked)}** (excluded from numerator).",
             f"Review source: {metadata['review_source']}. See JSONL for merge/head identities, "
             "line-level blame, per-repository coverage, daily/weekly rows and source pointers."]
    for failure in metadata["errors"]:
        text.append(f"- PARTIAL: {failure}")
    for incident in unlinked:
        text.append(f"- Unlinked {incident['at']}: `{incident['source']}:{incident['source_line']}`")
    return "\n".join(text) + "\n"


def run(args):
    end = instant(args.until) if args.until else dt.datetime.now(UTC)
    midnight = end.replace(hour=0, minute=0, second=0, microsecond=0)
    start = midnight - dt.timedelta(days=args.days - (1 if end != midnight else 0))
    lookup_start = start - dt.timedelta(days=7)
    state_home = Path(os.environ.get("XDG_STATE_HOME", ""))
    if not state_home.is_absolute():
        state_home = Path.home() / ".local/state"
    out = getattr(args, "output_dir", None) or state_home / "togetherweown/escape-ledger"
    out.mkdir(parents=True, exist_ok=True)
    with lock(out / ".escape-ledger.lock", nonblocking=True):
        github = GitHub(args.token_helper or args.root / "gh_token.sh")
        repos = sorted(set(args.repo or github.repos(args.org)), key=str.lower)
        if not repos or any(not REPO.fullmatch(r) or r.split('/')[0].lower() != args.org.lower() for r in repos):
            raise CollectionError("empty or invalid repository discovery")
        errors, coverage, merges, events, prs_by_repo = [], [], [], [], {}
        try:
            reviews, review_source = collect_reviews(
                args.review_db_container, getattr(args, "container_runtime", "docker"))
        except (CollectionError, ValueError, KeyError):
            reviews, review_source = {}, "unavailable"
            errors.append("review source unavailable; review provenance is unknown")
        for repo in repos:
            began = time.monotonic()
            emit("repo_started", repo=repo)
            try:
                prs = github.merged(repo, lookup_start)
                prs = [p for p in prs if instant(p["mergedAt"]) < end]
                prs_by_repo[repo] = {p["number"]: p for p in prs}
                window = [p for p in prs if instant(p["mergedAt"]) >= start]
                for pr in window:
                    merges.append({"type": "merge", "repo": repo, "number": pr["number"],
                                   "mergedAt": pr["mergedAt"], "head": pr["headRefOid"],
                                   "merge_commit": (pr.get("mergeCommit") or {}).get("oid"),
                                   "review": review_status(pr, reviews.get((repo.lower(), pr["number"]), []))})
                # Direct pushes can revert an older PR even with no window merges.
                # Always scan the discovered default branch, using the resolver for
                # introducing PRs outside the seven-day lookback.
                mirror = ensure_mirror(args.mirror_root, repo, github)
                linker = Linker(repo, mirror, prs, resolver=github.pull)
                analyzed, candidates, unlinked_fixes = 0, 0, 0
                cache_dir = out / ".escape-cache" / repo.split("/")[1]
                for pr in window:
                    key = hashlib.sha256(json.dumps([VERSION, pr], sort_keys=True).encode()).hexdigest()
                    cached = load_json(cache_dir / (key + ".json"))
                    try:
                        if isinstance(cached, dict) and "analysis" in cached:
                            analysis = cached["analysis"]
                            linker.unresolved_revert_commits += cached.get("unresolved_revert_commits", 0)
                        else:
                            ensure_commit(mirror, repo, (pr.get("mergeCommit") or {}).get("oid"), github)
                            unresolved_before = linker.unresolved_revert_commits
                            analysis = linker.analyze(pr)
                            unresolved = linker.unresolved_revert_commits - unresolved_before
                            save_json(cache_dir / (key + ".json"), {
                                "analysis": analysis,
                                "unresolved_revert_commits": unresolved,
                            })
                    except CollectionError as exc:
                        errors.append(f"{repo}#{pr['number']}: {exc}")
                        continue
                    analyzed += 1
                    if not analysis:
                        continue
                    candidates += 1
                    if not analysis["eligible"]:
                        unlinked_fixes += 1
                        continue
                    introducing = []
                    for number, evidence in analysis["links"].items():
                        number = int(number)
                        prior = linker.resolve(number)
                        introducing.append({"repo": repo, "number": number, "evidence": evidence,
                                            "merged_at": prior["mergedAt"] if prior else None,
                                            "review": review_status(prior, reviews.get((repo.lower(), number), []))
                                            if prior else {"claude_5_of_5": None, "reason": "outside_lookup_window"}})
                    events.append({"type": "escape", "id": f"{repo}#{pr['number']}", "repo": repo,
                                   "number": pr["number"], "kind": analysis["kind"], "at": pr["mergedAt"],
                                   "introducers": introducing, "blame": analysis["blame"], "candidate_only": True})
                branches = [p["baseRefName"] for p in window] + [github.default_branches.get(repo)]
                for direct in linker.direct_reverts(branches, start, end):
                    for intro in direct["introducers"]:
                        prior = linker.resolve(intro["number"])
                        intro["review"] = review_status(prior, reviews.get((repo.lower(), intro["number"]), []))
                    events.append(direct)
                prs_by_repo[repo] = linker.prs
                unresolved_reverts = linker.unresolved_revert_commits
                coverage.append({"repo": repo, "merges": len(window), "analyzed": analyzed,
                                 "fix_or_revert_candidates": candidates, "unlinked_fixes": unlinked_fixes,
                                 "unresolved_revert_commits": unresolved_reverts if isinstance(unresolved_reverts, int) else 0,
                                 "status": "complete" if analyzed == len(window) else "partial"})
                emit("repo_completed", repo=repo, merges=len(window), analyzed=analyzed,
                     seconds=round(time.monotonic() - began, 2))
            except (CollectionError, ValueError, KeyError, TypeError) as exc:
                errors.append(f"{repo}: collection failed ({type(exc).__name__})")
                coverage.append({"repo": repo, "status": "unavailable"})
                emit("repo_failed", repo=repo, error=type(exc).__name__,
                     detail=str(exc) if isinstance(exc, CollectionError) else "invalid response shape")
        legacy_source = args.root / "ops/worker-vps/operator-actions.log"
        sources = [legacy_source] if legacy_source.is_file() else []
        incidents_complete = True
        memory_dir = getattr(args, "memory_dir", None)
        if getattr(args, "memory_dir_from_root", False):
            memory_dir = memory_dir_for_root(args.root)
        if memory_dir:
            if memory_dir.is_dir():
                sources += sorted(memory_dir.glob("*.md"))
            else:
                incidents_complete = False
                errors.append(f"incident memory directory missing: {memory_dir}")
        source_available = bool(sources) or bool(memory_dir and memory_dir.is_dir())
        if not source_available:
            incidents_complete = False
            errors.append("no incident sources available")
        present = [source for source in sources if source.is_file()]
        incidents, unlinked, incident_errors = collect_incidents(present, repos, prs_by_repo, start, end)
        errors.extend(incident_errors)
        incidents_complete = incidents_complete and not incident_errors
        # These shared sources can contain incidents for any discovered repo.
        # Keep observed counts, but never publish a complete rate for any repo
        # when an incident source is missing, unreadable, or malformed.
        for entry in coverage:
            entry["incident_status"] = "complete" if incidents_complete else "partial"
            if not incidents_complete and entry["status"] == "complete":
                entry["status"] = "partial"
        for event in incidents:
            event["type"] = "escape"
            for intro in event["introducers"]:
                prior = prs_by_repo[intro["repo"]][intro["number"]]
                intro["review"] = review_status(prior, reviews.get((intro["repo"].lower(), intro["number"]), []))
        events.extend(incidents)
        events.sort(key=lambda e: (e["at"], e["id"]))
        rows = aggregate(merges, events, repos, start, end)
        coverage_by_repo = {r["repo"]: r["status"] for r in coverage}
        for row in rows:
            row["coverage_status"] = ("partial" if errors else "complete") if row["repo"] == "ALL" else coverage_by_repo[row["repo"]]
            if row["coverage_status"] != "complete":
                row["escapes_per_100_merges"] = None
        metadata = {"type": "metadata", "schema_version": VERSION, "run_id": RUN_ID,
                    "tool_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                    "scope": "explicit_repositories" if args.repo else "all_visible_org_repositories",
                    "mode": "shadow", "generated_at": stamp(dt.datetime.now(UTC)),
                    "start": stamp(start), "end": stamp(end), "repos": repos,
                    "status": "partial" if errors else "complete", "errors": errors,
                    "review_source": review_source, "coverage": coverage,
                    "merges": len(merges), "escapes": len(events),
                    "kinds": dict(collections.Counter(e["kind"] for e in events)),
                    "unlinked_incident_mentions": len(unlinked),
                    "escapes_per_100_merges": 100 * len(events) / len(merges) if merges and not errors else None}
        records = [metadata, *merges, *events, *rows,
                   *[dict(e, type="unlinked_incident") for e in unlinked]]
        # Each file is atomic; matching run_id/timestamp identifies a crash between the two renames.
        snapshot = "".join(json.dumps(r, ensure_ascii=True, sort_keys=True) + "\n" for r in records)
        atomic(out / "escapes.jsonl", snapshot)
        atomic(out / "ESCAPES.md", render(metadata, rows, events, unlinked))
        # Keep daily snapshots so the original baseline survives the rolling 30-day window.
        # A failed retry must not overwrite a completed historical baseline.
        if not errors:
            atomic(out / "escape-history" / (end.date().isoformat() + ".jsonl"), snapshot)
        emit("ledger_completed", status=metadata["status"], merges=len(merges), escapes=len(events),
             kinds=metadata["kinds"], rate=metadata["escapes_per_100_merges"], errors=len(errors))
        return 2 if errors else 0


def main(argv=None):
    global ENTRY_POINT
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True, help="Host ops root; outputs stay private")
    parser.add_argument("--org", default="TogetherWeOwn")
    parser.add_argument("--repo", action="append", help="Restrict to a full org/repo; default discovers all")
    parser.add_argument("--mirror-root", type=Path, required=True)
    parser.add_argument("--token-helper", type=Path)
    memory = parser.add_mutually_exclusive_group()
    memory.add_argument("--memory-dir", type=Path)
    memory.add_argument("--memory-dir-from-root", action="store_true",
                        help="Read Claude project memory for the configured checkout")
    parser.add_argument("--review-db-container", help="Optional read-only Paperclip review provenance")
    parser.add_argument("--container-runtime", choices=["docker", "podman"], default="docker")
    parser.add_argument("--output-dir", type=Path, help="Private state directory outside the checkout")
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument("--until", help="Exclusive UTC timestamp (default host clock now)")
    parser.add_argument("--entry-point", choices=["cli", "systemd"], default="cli")
    args = parser.parse_args(argv)
    if not 1 <= args.days <= 366:
        parser.error("--days must be between 1 and 366")
    ENTRY_POINT = args.entry_point
    try:
        return run(args)
    except BlockingIOError:
        emit("ledger_already_running")
        return 0
    except (CollectionError, OSError, ValueError, KeyError, TypeError) as exc:
        emit("ledger_failed", error=type(exc).__name__, previous_snapshot_preserved=True)
        return 2


if __name__ == "__main__":
    sys.exit(main())
