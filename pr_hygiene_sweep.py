#!/usr/bin/env python3
"""PR hygiene sweep for every non-archived org repo (operator timer, every 30 min:
"every PR babysat until merge"). Public mirror of the operator sweep: host-specific
paths and ids are environment-configurable (see the constants below).

Root cause it guards (2026-10-01): GitHub silently skips pull_request workflows on a PR that
conflicts with main, so only CodeQL runs. Agents read the missing `check` as "CI dispatch is not
authorized" and opened permission/receipt card chains instead of merging main.

For each open non-release PR:
  * dirty (conflicts)      -> comment on its open card telling the author to merge main and push
  * clean + required green -> comment telling the assignee to get it reviewed/merged
  * red CI on the head       -> comment naming the failing checks and telling the author to fix them
At most one nudge per (PR, head sha, kind) per 6h; every PATCH attempt (sent or failed) is saved
atomically and observes the cooldown. A blocked card with no open blocker edge is moved to todo
unless the card is parked (a standing monitor/unblock wait or a "parked until"/"do not mutate" line
in its description) so the comment actually dispatches. PRs are read page by page; a lock file
serializes overlapping timer runs. --dry-run prints only. PAUSE file stops it.
Owner: a card with a repo-qualified pull_request work product for the PR, or a card whose branch names it
and whose registered workspace/project repo is that PR's repo (owner_match.py). Body text and bare PR
numbers never choose an owner; ambiguous or unmatched PRs are logged and skipped.
Faults fail visibly and bounded: every GitHub request, docker psql, curl and the token mint carries a
timeout; a timeout, DNS/refused/reset error, non-JSON body, unexpected HTTP status (any except 404) or
non-zero curl exit or invalid board status trailer is logged as a failure row and the run exits 1.
Three consecutive GitHub faults, one hung docker call, or one hung/refused board call stop further calls
of that kind for the run. A live-work guard failure also opens the SQL breaker and stops remaining
nudges; only a successful lookup counts as a clean live-run deferral. Guard diagnostics (exception
class detail and stderr tails) are logged with token-shaped strings redacted.
"""
import fcntl, http.client, json, os, re, socket, subprocess, sys, tempfile, time, urllib.request, urllib.error
HERE = os.path.dirname(os.path.abspath(__file__))
# The live-work guard and owner matching are inlined below (single-file mirror).
STATE_DIR = os.environ.get("PR_HYGIENE_STATE_DIR", "/tmp/pr-hygiene-sweep")
STATE = os.path.join(STATE_DIR, "state.json"); LOG = os.path.join(STATE_DIR, "sweep.log")
LOCK = os.path.join(STATE_DIR, "sweep.lock")
PER_PAGE = 100
PARK_MARKER = re.compile(r"(?im)^\s*(?:parked until|do not mutate)\b")
C = os.environ.get("PAPERCLIP_COMPANY_ID", "")  # board company id, from the operator environment
REPOS = None  # discovered each run: every non-archived org repo
DRY = False  # set by main() from --dry-run
T = ""  # installation token, read by main() after the mint step
TOKEN_FILE = os.environ.get("PR_HYGIENE_TOKEN_FILE", "/tmp/gh-inst-token")
MINT = os.environ.get("PR_HYGIENE_MINT", os.path.expanduser("~/mint-installation-token.sh"))
CURL_CONFIG = os.environ.get("PR_HYGIENE_CURL_CONFIG", os.path.expanduser("~/.pc.curl"))
PAUSE = os.path.join(STATE_DIR, "PAUSE")
GH_TIMEOUT = 30    # per GitHub request
GH_BREAKER = 3     # consecutive GitHub network faults before the run stops calling GitHub
SQL_TIMEOUT = 60   # per docker psql call
API_TIMEOUT = 100  # process backstop above curl's own -m 90
MINT_TIMEOUT = 120
RUN = {"faults": [], "gh_streak": 0, "sql_down": False, "api_down": False}  # per-run fault ledger and breakers, reset by main()
def reset_run():
    global RUN
    RUN = {"faults": [], "gh_streak": 0, "sql_down": False, "api_down": False}
_UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')


def issue_has_live_work(issue_id, on_error=None):
    """True if the issue has a queued, running or scheduled_retry run, due or not. Fail-closed: errors count as live
    and are reported through on_error(reason) when given, so callers can log why the nudge was deferred."""
    def fail_closed(reason):
        if on_error is not None:
            try:
                on_error(reason)
            except Exception:
                pass
        return True

    if not issue_id or not _UUID.fullmatch(str(issue_id)):
        return fail_closed("invalid issue id")
    q = ("select exists(select 1 from heartbeat_runs h where coalesce(h.context_snapshot->>'issueId', "
         "h.context_snapshot->>'taskId')='%s' and h.status in ('queued','running','scheduled_retry'))" % issue_id)
    try:
        result = subprocess.run(['docker', 'exec', '-i', 'paperclip-db', 'psql', '-U', 'paperclip', '-d', 'paperclip', '-At', '-c', q],
                                capture_output=True, text=True, timeout=30)
    except Exception as error:
        return fail_closed("psql lookup failed: %s: %s" % (type(error).__name__, str(error)[:200]))
    # Duck-typed: tests stub the run with a bare stdout namespace, while real
    # CompletedProcess results always carry returncode/stderr. Anything odd is live.
    if getattr(result, "returncode", 0):
        return fail_closed("psql exited %s: %s" % (result.returncode, (getattr(result, "stderr", "") or "").strip()[:200] or "no stderr"))
    out = getattr(result, "stdout", None)
    if not isinstance(out, str):
        return fail_closed("psql returned non-text output")
    out = out.strip()
    if out not in ('t', 'f'):
        return fail_closed("psql returned unexpected output: %s" % (out[:80] or "empty"))
    return out == 't'


_EXTERNAL_ID = re.compile(r"([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)#([0-9]+)")
_PR_URL = re.compile(r"https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/pull/([0-9]+)")
_REPO_URL = re.compile(r"https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)(?:\.git)?/?")
_STALE_STATUSES = frozenset({"merged", "closed", "archived"})


def _key(repo, number):
    return "%s#%d" % (repo.lower(), int(number))


def _match_key(pattern, text):
    match = pattern.fullmatch(text) if isinstance(text, str) else None
    return _key(match.group(1), match.group(2)) if match else None


def _product_key(product):
    if product.get("type") != "pull_request" or product.get("provider") != "github":
        return None
    if product.get("status") in _STALE_STATUSES:
        return None
    external_id, url = product.get("externalId"), product.get("url")
    external_key = _match_key(_EXTERNAL_ID, external_id) if external_id is not None else None
    url_key = _match_key(_PR_URL, url) if url is not None else None
    if external_id is not None and external_key is None:
        return None
    if url is not None and url_key is None:
        return None
    if external_key and url_key and external_key != url_key:
        return None
    return external_key or url_key


def _registered_repos(card):
    urls = [card["workspace_repo"]] if card["workspace_repo"] else card["project_repos"]
    names = (_REPO_URL.fullmatch(url) if isinstance(url, str) else None for url in urls)
    return {match.group(1).lower() for match in names if match}


def _names_card(identifier, branch):
    pattern = r"(?<![0-9A-Za-z])%s(?![0-9])" % re.escape(identifier)
    return re.search(pattern, branch) is not None


def choose_owner(pr, candidates):
    unknown = [card["identifier"] for card in candidates if card["products"] is None]
    if unknown:
        return None, "facts unavailable, owner unknown: %s" % ", ".join(unknown)
    key = _key(pr["repo"], pr["number"])
    repo = pr["repo"].lower()
    same_repo_branch = (pr["head_repo"] or "").lower() == repo
    trusted, rejected = [], []
    for card in candidates:
        if key in {_product_key(product) for product in card["products"]}:
            trusted.append(card)
        elif _names_card(card["identifier"], pr["branch"]):
            if not same_repo_branch:
                rejected.append("%s: branch names it on a PR from another repo" % card["identifier"])
            elif repo in _registered_repos(card):
                trusted.append(card)
            else:
                rejected.append("%s: branch names it, not registered to this repo" % card["identifier"])
        else:
            rejected.append("%s: no repo-qualified provenance" % card["identifier"])
    if len(trusted) == 1:
        return trusted[0], None
    if trusted:
        return None, "ambiguous owner: %s" % ", ".join(card["identifier"] for card in trusted)
    return None, "no trusted owner: %s" % "; ".join(rejected)


def fault(msg):
    """Log a failure row and count it; any counted fault makes main() exit 1."""
    RUN["faults"].append(msg); log(msg)
def live_work_fault(reason):
    RUN["sql_down"] = True
    # The guard reports detail (exception text, stderr) through on_error; that
    # text can carry token-shaped strings, so redact those shapes before the
    # reason reaches the log. The _plain copy keeps the log grep-friendly.
    safe = re.sub(r"(?:gh[pousr]|github_pat)_[A-Za-z0-9_]+", "[redacted]", str(reason))
    fault(f"live-work lookup failed closed: {safe} ({_plain(safe)})")
def _gh_kind(e):
    """Name a network-level failure. Only the class is reported: never the message, which a proxy could fill with headers."""
    reason = e.reason if isinstance(e, urllib.error.URLError) else e
    if isinstance(reason, (TimeoutError, socket.timeout)): return "timeout"
    if isinstance(reason, socket.gaierror): return "dns"
    if isinstance(reason, ConnectionRefusedError): return "refused"
    if isinstance(e, ValueError): return "non-json"
    return "network"
def gh(path):
    where = "gh " + path.split("?")[0]
    if RUN["gh_streak"] >= GH_BREAKER:
        log(f"{where} skipped: GitHub breaker open after {GH_BREAKER} consecutive network faults"); return {"_err": "skipped"}
    r = urllib.request.Request("https://api.github.com/" + path, headers={"Authorization": "Bearer " + T, "Accept": "application/vnd.github+json", "User-Agent": "op-pr-hygiene"})
    try:
        with urllib.request.urlopen(r, timeout=GH_TIMEOUT) as resp: out = json.load(resp)
        if not isinstance(out, (dict, list)): raise ValueError("unexpected JSON shape")
    except urllib.error.HTTPError as e:
        if e.code == 404:  # expected miss (gone PR, missing compare): log only, not a fault
            RUN["gh_streak"] = 0; log(f"{where} failed: HTTP {e.code}"); return {"_err": e.code}
        # 5xx (outage), 401 (bad token), 403 (rate limit) and friends hide as
        # "0 PRs need a nudge" unless counted: fault and feed the breaker.
        RUN["gh_streak"] += 1
        fault(f"{where} failed: HTTP {e.code}"); return {"_err": e.code}
    except (OSError, http.client.HTTPException, ValueError) as e:  # URLError, timeouts, resets, truncated or non-JSON bodies
        kind = _gh_kind(e); RUN["gh_streak"] += kind != "non-json"
        fault(f"{where} failed: {kind} ({type(e).__name__})"); return {"_err": kind}
    RUN["gh_streak"] = 0
    return out
def sql(q):
    if RUN["sql_down"]: log("sql skipped: docker did not answer earlier in this run"); return None
    try:
        r = subprocess.run(["docker", "exec", "-i", "paperclip-db", "psql", "-U", "paperclip", "-d", "paperclip", "-At", "-F", "|", "-c", q], capture_output=True, text=True, timeout=SQL_TIMEOUT)
    except subprocess.TimeoutExpired:
        RUN["sql_down"] = True; fault(f"sql timed out after {SQL_TIMEOUT}s"); return None
    except OSError as e:
        RUN["sql_down"] = True; fault(f"sql could not run: {type(e).__name__}"); return None
    if r.returncode: fault(f"sql failed: {r.stderr.strip()[:200]}"); return None
    return r.stdout.strip()
def _board_split(stdout):
    """Split a curl -w '\\n%{http_code}' body into (body_text, code).

    Missing or malformed status is unknown, never an invented success.
    Only a validated 3-digit code may be logged, never the body or trailer
    (which could carry an error payload).
    """
    text, sep, code = (stdout or "").rpartition("\n")
    if sep and re.fullmatch(r"[1-5][0-9]{2}", code):
        return text, code
    return "", None
def api(method, path, body):
    if RUN.get("api_down"): log(f"board api skipped: board did not answer earlier in this run: {method} {path}"); return {"_err": "skipped"}
    try:
        r = subprocess.run(["curl", "-sS", "-K", CURL_CONFIG, "-m", "90", "-X", method, "-H", "content-type: application/json",
                              "-w", "\n%{http_code}", f"http://127.0.0.1:3100/api/{path}", "-d", json.dumps(body)], capture_output=True, text=True, timeout=API_TIMEOUT)
    except subprocess.TimeoutExpired:
        RUN["api_down"] = True; fault(f"board api timed out after {API_TIMEOUT}s: {method} {path}"); return {"_err": "timeout"}
    except OSError as e:  # curl missing or not executable
        RUN["api_down"] = True; fault(f"board api could not run: {type(e).__name__}: {method} {path}"); return {"_err": "unavailable"}
    if r.returncode:  # curl -m 90 fires before the API_TIMEOUT backstop: exit 28 is the hung-board shape, 7 is refused
        if r.returncode in (7, 28): RUN["api_down"] = True
        fault(f"board api failed: curl exit {r.returncode}: {method} {path}"); return {"_err": f"curl-{r.returncode}"}
    body_text, code = _board_split(r.stdout)
    if code is None:
        fault(f"board api failed: invalid HTTP status trailer: {method} {path}"); return {"_err": "invalid-status"}
    if not code.startswith("2"):  # writes must answer 2xx: 401 (rotated token), 403, 5xx are faults, never silent
        fault(f"board api failed: HTTP {code}: {method} {path}"); return {"_err": f"http-{code}"}
    try: return json.loads(body_text)
    except Exception: return {"_raw": body_text[:200]}
def api_get(path):
    if RUN.get("api_down"): log(f"board api skipped: board did not answer earlier in this run: GET {path}"); return None
    try:
        r = subprocess.run(["curl", "-sS", "-K", CURL_CONFIG, "-m", "90", "-w", "\n%{http_code}",
                              f"http://127.0.0.1:3100/api/{path}"], capture_output=True, text=True, timeout=API_TIMEOUT)
    except subprocess.TimeoutExpired:
        RUN["api_down"] = True; fault(f"board api timed out after {API_TIMEOUT}s: GET {path}"); return None
    except OSError as e:
        RUN["api_down"] = True; fault(f"board api could not run: {type(e).__name__}: GET {path}"); return None
    if r.returncode:  # same hung/refused board as api(): curl -m 90 exit 28/7, never the API_TIMEOUT backstop
        if r.returncode in (7, 28): RUN["api_down"] = True
        fault(f"board api failed: curl exit {r.returncode}: GET {path}"); return None
    body_text, code = _board_split(r.stdout)
    if code is None:
        fault(f"board api failed: invalid HTTP status trailer: GET {path}"); return None
    if code in ("401", "403") or code.startswith("5"):  # expired token or board outage: fault, never a silent skip
        fault(f"board api failed: HTTP {code}: GET {path}"); return None
    try: return json.loads(body_text)
    except Exception: return None
def card_facts(iid):
    issue = api_get(f"issues/{iid}")
    products = api_get(f"issues/{iid}/work-products")
    if not isinstance(issue, dict) or issue.get("id") != iid or not isinstance(products, list):
        fault(f"board facts invalid for {iid}: issue payload failed validation"); return None
    workspace_id, project_id = issue.get("executionWorkspaceId"), issue.get("projectId")
    workspace = api_get(f"execution-workspaces/{workspace_id}") if workspace_id else {}
    project = api_get(f"projects/{project_id}") if project_id else {}
    if workspace_id and not (isinstance(workspace, dict) and workspace.get("id") == workspace_id):
        fault(f"board facts invalid for {iid}: workspace payload failed validation"); return None
    if project_id and not (isinstance(project, dict) and project.get("id") == project_id):
        fault(f"board facts invalid for {iid}: project payload failed validation"); return None
    parked = bool(issue.get("monitorNextCheckAt") or issue.get("unblockDescriptor")
                   or PARK_MARKER.search(issue.get("description") or ""))
    return {"products": products, "workspace_repo": workspace.get("repoUrl"),
            "project_repos": [w.get("repoUrl") for w in project.get("workspaces") or []],
            "parked": parked}
def acquire_run_lock(path=LOCK):
    """Non-blocking flock: an overlapping timer run logs a skip instead of double-nudging."""
    stream = open(path, "a", encoding="utf-8")
    try: fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError: stream.close(); return None
    return stream
def atomic_write_state(path, state):
    """Crash-safe state save: fsync a same-directory temp file, then os.replace it over the old one."""
    directory = os.path.dirname(path) or "."
    tmp = None
    try:
        fd, tmp = tempfile.mkstemp(prefix=".state.", suffix=".tmp", dir=directory)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(state, f, sort_keys=True); f.write("\n"); f.flush(); os.fsync(f.fileno())
        os.replace(tmp, path)
    except OSError as e:
        fault(f"state write failed: {type(e).__name__}")
        if tmp:
            try: os.unlink(tmp)
            except OSError: pass
def load_state():
    """Cooldown map, pruned to 24h. A torn file is a fault row, not a traceback; the next save heals it."""
    if not os.path.exists(STATE): return {}
    try:
        with open(STATE) as f: state = json.load(f)
    except (OSError, ValueError) as e:
        fault(f"state unreadable ({type(e).__name__}), starting empty"); return {}
    if not isinstance(state, dict):
        fault("state is not an object, starting empty"); return {}
    now = time.time()
    return {k: v for k, v in state.items() if isinstance(v, (int, float)) and now - v < 86400}
def _plain(text):
    return re.sub(r"[^A-Za-z0-9._/()+-]", "_", str(text))[:80]
def log(msg):
    line = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()) + " " + msg
    print(line)
    if not DRY:
        try:
            os.makedirs(os.path.dirname(LOG) or ".", exist_ok=True)
            with open(LOG, "a") as f: f.write(line + "\n")
        except OSError:
            pass  # stdout already carries the row; a missing log must not crash the sweep
MSG = {
 "dirty": ("Operator PR-hygiene sweep: {repo} PR #{n} (`{ref}`, head {sha}) **conflicts with main** "
           "(mergeable_state=dirty, {behind} commits behind). GitHub does not run pull_request workflows on a conflicting PR, "
           "which is why only CodeQL ran and `check`/`secret-scan`/`pr-lint` are missing. This is NOT a CI-authorization, "
           "dispatch, credential or receipt problem and needs no new card: merge `origin/main` into the branch (or rebase), "
           "resolve conflicts, run the tests locally, push. CI starts by itself on the push. Then route the PR to review."),
 "red": ("Operator PR-hygiene sweep: {repo} PR #{n} (`{ref}`, head {sha}) has **failing CI**: {failing}. "
         "Fix the failing checks on this branch and push (done = merged). If a failure is unrelated flake, re-run that job once and say so here."),
 "green": ("Operator PR-hygiene sweep: {repo} PR #{n} (`{ref}`, head {sha}) is **mergeable and all checks are green**. "
           "Get it reviewed and squash-merged now (done = merged). If you are the reviewer, review it this run."),
}
FIRST = ["two-web-next", "two-bot-next", "paperclip-ops-tooling", "kofra", "nntune"]
MAX_NUDGES = 15  # per run (30 min): bounded wake load on the fleet; green first, then red, then dirty


def main(argv):
    global DRY
    DRY = "--dry-run" in argv
    try: os.makedirs(os.path.dirname(LOCK) or ".", exist_ok=True)
    except OSError: pass
    if os.path.exists(PAUSE): return 0
    lock = acquire_run_lock(LOCK)
    if lock is None:
        log("skip: another PR-hygiene sweep holds the run lock"); return 0
    try:
        return _run(argv)
    finally:
        lock.close()


def _run(argv):
    global T, REPOS
    reset_run()
    try:
        subprocess.run(["bash", MINT], check=True, capture_output=True, timeout=MINT_TIMEOUT)
        with open(TOKEN_FILE) as f: T = f.read().strip()
    except (subprocess.SubprocessError, OSError) as e:  # class only: the mint's stderr and the token file are never echoed
        log(f"token mint failed: {type(e).__name__}"); return 1
    state = load_state()
    now = time.time()
    REPOS = []
    for page in range(1, 4):
        listing = gh(f"orgs/TogetherWeOwn/repos?per_page=100&page={page}")
        if not isinstance(listing, list):
            # The org is a hard-coded constant, so even a 404 is never an
            # expected miss here: a token that cannot see the org reads as
            # "0 PRs" unless counted. Non-404 gh() errors already faulted.
            if isinstance(listing, dict) and listing.get("_err") == 404:
                fault(f"org repo list page {page} failed: HTTP 404")
            elif isinstance(listing, dict) and "_err" in listing:
                log(f"org repo list page {page} failed {listing}")
            else:
                fault(f"org repo list page {page} failed: non-list body ({type(listing).__name__})")
            continue
        REPOS += [r["name"] for r in listing if isinstance(r, dict) and not r.get("archived")]
    if not REPOS and not RUN["faults"]:
        fault("org discovery returned no repositories")
    REPOS = sorted(REPOS, key=lambda r: (FIRST.index(r) if r in FIRST else len(FIRST), r))
    pending = []
    for repo in REPOS:
        prs = []
        page = 1
        while True:  # every open-PR page: the first 100 are not the whole answer on busy repos
            chunk = gh(f"repos/TogetherWeOwn/{repo}/pulls?state=open&per_page={PER_PAGE}&page={page}")
            if not isinstance(chunk, list):
                # A per-repo 404 may be a logged miss (repo deleted between
                # the two reads); a non-list 2xx body is never a clean list.
                if isinstance(chunk, dict) and "_err" in chunk:
                    log(f"{repo} list page {page} failed {chunk}")
                else:
                    fault(f"{repo} list page {page} failed: non-list body ({type(chunk).__name__})")
                prs = None; break
            prs.extend(chunk)
            if len(chunk) < PER_PAGE: break
            page += 1
        if prs is None: continue
        for p in prs:
            if p["head"]["ref"].startswith("release-please") or p.get("draft"): continue
            d = {}
            for _ in range(3):
                d = gh(f"repos/TogetherWeOwn/{repo}/pulls/{p['number']}")
                if not isinstance(d, dict) or "_err" in d or d.get("mergeable_state") not in (None, "unknown"): break
                time.sleep(3)
            if not isinstance(d, dict) or "_err" in d or "head" not in d:
                log(f"skip {repo}#{p['number']}: PR detail unavailable {d if not isinstance(d, dict) else d.get('_err', 'no head')}"); continue
            ms, sha = d.get("mergeable_state"), d["head"]["sha"]
            kind = None
            failing = []
            if ms == "dirty": kind = "dirty"
            elif ms == "clean": kind = "green"
            elif ms in ("unstable", "blocked"):
                runs = gh(f"repos/TogetherWeOwn/{repo}/commits/{sha}/check-runs?per_page=100")
                if not isinstance(runs, dict) or "_err" in runs:
                    log(f"skip {repo}#{p['number']}: check-runs unavailable {runs if not isinstance(runs, dict) else runs['_err']}"); continue
                runs = runs.get("check_runs", [])
                failing = sorted({c["name"] for c in runs if c.get("conclusion") in ("failure", "timed_out", "startup_failure") and c.get("name")})
                if failing: kind = "red"
            if not kind: continue
            key = f"{repo}#{p['number']}@{sha[:10]}:{kind}"
            if key in state and now - state[key] < 6 * 3600: continue
            refs = sorted(set(re.findall(r"[A-Z]{2,}-\d+", (d.get("body") or "") + " " + d["head"]["ref"] + " " + d["title"])))
            if not refs: continue
            inlist = ",".join(f"'{r}'" for r in refs)
            rows = sql(f"select i.id,i.identifier,i.status,coalesce(a.name,''),"
                       f" exists(select 1 from issue_relations ir join issues b on b.id=ir.issue_id where ir.related_issue_id=i.id and ir.type='blocks' and b.status not in ('done','cancelled'))"
                       f" from issues i left join agents a on a.id=i.assignee_agent_id where i.company_id='{C}' and i.identifier in ({inlist})"
                       f" and i.status not in ('done','cancelled') and i.assignee_agent_id is not null order by i.identifier")
            if rows is None: log(f"skip {repo}#{p['number']}: board query unavailable"); continue
            cards = []
            for row in rows.splitlines():
                # Agent names are free text and may contain '|': the flag is
                # the last field, the name is everything after the 3rd '|'.
                try:
                    head, has_edge = row.rsplit("|", 1)
                    iid, ident, status, agent = head.split("|", 3)
                except ValueError:
                    fault(f"board row malformed for {repo}#{p['number']}: {_plain(row[:80])}")
                    continue
                cards.append({"iid": iid, "identifier": ident, "status": status, "agent": agent, "has_edge": has_edge,
                              **(card_facts(iid) or {"products": None, "workspace_repo": None, "project_repos": []})})
            if not cards: continue
            head_repo = (d["head"].get("repo") or {}).get("full_name")
            owner, why = choose_owner({"repo": f"TogetherWeOwn/{repo}", "number": p["number"], "branch": d["head"]["ref"], "head_repo": head_repo}, cards)
            if owner is None:
                log(f"skip {repo}#{p['number']}: {why}")
                continue
            iid, ident, status, agent, has_edge = owner["iid"], owner["identifier"], owner["status"], owner["agent"], owner["has_edge"]
            behind = 0
            if kind == "dirty":
                cmp = gh(f"repos/TogetherWeOwn/{repo}/compare/main...{sha}")
                behind = cmp.get("behind_by", "?") if isinstance(cmp, dict) else "?"
            body = {"comment": MSG[kind].format(repo=repo, n=p["number"], ref=_plain(d["head"]["ref"]), sha=sha[:8], behind=behind, failing=", ".join(_plain(name) for name in failing[:8]) or "?")}
            if status == "blocked" and has_edge == "f":
                if owner.get("parked"):
                    log(f"skip {repo}#{p['number']}: {ident} is parked (blocked, no open edge); no nudge")
                    continue
                body["status"] = "todo"
            pending.append((REPOS.index(repo), {"green": 0, "red": 1, "dirty": 2}[kind], kind, repo, p["number"], ident, status, agent, iid, body, key))
    sent = attempts = 0
    for _, _, kind, repo, n, ident, status, agent, iid, body, key in sorted(pending, key=lambda x: (x[1], x[0])):
        if attempts >= MAX_NUDGES: break
        log(f"{'DRY ' if DRY else ''}{kind} {repo}#{n} -> {ident} ({status}, {agent}){' ->todo' if 'status' in body else ''}")
        if not DRY:
            if RUN["sql_down"]:
                log("  remaining nudges deferred: live-work lookup unavailable"); break
            if issue_has_live_work(iid, on_error=live_work_fault):
                log(f"  deferred: {ident} has a live run / scheduled retry (a comment would cancel it)")
                continue
        if DRY:
            attempts += 1
            sent += 1; continue
        r = api("PATCH", f"issues/{iid}", body)
        if isinstance(r, dict) and r.get("_err") == "skipped":
            log(f"  patch skipped: board breaker open for {ident}; no cooldown recorded")
            continue
        attempts += 1
        state[key] = now  # failed attempts observe the cooldown too: never retried every run
        atomic_write_state(STATE, state)
        if isinstance(r, dict) and r.get("id"): sent += 1
        else: log(f"  patch failed {str(r)[:150]}")
    log(f"{'DRY ' if DRY else ''}summary: {len(pending)} PRs need a nudge, {'would send' if DRY else 'sent'} {sent}"
        + (f"; {len(RUN['faults'])} FAULTS, see the failure rows above" if RUN["faults"] else ""))
    if not DRY:
        # Heal a torn state file and prune expired cooldowns even when no
        # PATCH ran: without this a quiet run faults every tick and never heals.
        atomic_write_state(STATE, state)
    return 1 if RUN["faults"] else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
