#!/usr/bin/env python3
"""Orphan-PR sweeper (owner 2026-10-05: "why isn't this PR getting handled and monitored until merge?").

Agent-opened PRs are owned by the card that opened them. PRs opened by bots (Dependabot, release automation)
or by people outside the board have no card, so nobody shepherds them (two-web-next #526 sat green for 6h).
Every open, non-draft PR in the repos below with no open card referencing it gets one card, assigned to the
repo's engineer, with the PR linked as a work product. The card owns it until merged or closed with a reason.

Dry run by default; --apply to act. At most MAX_NEW cards per run; a PR younger than MIN_AGE_MIN is skipped
(its author's card may still be linking it). Stop: touch ~/.local/state/flow-guard/PAUSE.
"""
import calendar, json, os, re, subprocess, sys, time
from pathlib import Path

ROOT = os.environ.get('OPERATOR_ROOT', str(Path(__file__).resolve().parents[2]))
CID = os.environ.get('PAPERCLIP_COMPANY_ID', '00000000-0000-0000-0000-000000000000')


def _default_repos():
    try:
        raw = os.environ.get('ORPHAN_REPOS_JSON')
        if raw:
            return {repo: tuple(pair) for repo, pair in json.loads(raw).items()}
    except (ValueError, TypeError, AttributeError):
        pass
    return {  # repo: (assignee name, project name); override via ORPHAN_REPOS_JSON
        'example-org/example-repo': ('Example Engineer', 'Example Project'),
    }


REPOS = _default_repos()
APPLY = '--apply' in sys.argv
MAX_NEW, MIN_AGE_MIN = 5, 30
STATE_DIR = os.environ.get('ORPHAN_STATE_DIR', os.path.expanduser('~/.local/state/flow-guard'))
# Parent step bound for the run-deadline guard (the scheduler step that hosts
# this sweeper). The deadline above must stay below it; see TimeoutConfig.
PARENT_STEP_BOUND_SECONDS = int(os.environ.get('ORPHAN_PARENT_STEP_BOUND_SECONDS', '120'))


def timeout_seconds(name, default):
    value = int(os.environ.get(name, default))
    if value <= 0:
        raise ValueError(f'{name} must be a positive integer')
    return value


PSQL_TIMEOUT_SECONDS = timeout_seconds('ORPHAN_PRS_PSQL_TIMEOUT_SECONDS', 30)
CURL_TIMEOUT_SECONDS = timeout_seconds('ORPHAN_PRS_CURL_TIMEOUT_SECONDS', 65)
TOKEN_TIMEOUT_SECONDS = timeout_seconds('ORPHAN_PRS_TOKEN_TIMEOUT_SECONDS', 30)
GH_TIMEOUT_SECONDS = timeout_seconds('ORPHAN_PRS_GH_TIMEOUT_SECONDS', 60)
# Internal write deadline: stop starting new writes before the parent
# flow-guard step bound (FLOW_GUARD_STEP_TIMEOUT_SECONDS=120) can SIGKILL us,
# so the kill lands between writes, never mid-write. Backfill below heals a
# kill that still lands inside one write.
RUN_DEADLINE_SECONDS = timeout_seconds('ORPHAN_PRS_RUN_DEADLINE_SECONDS', 100)


def psql(sql):
    out = subprocess.run(['docker', 'exec', '-i', 'paperclip-db', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'paperclip',
                          '-d', 'paperclip', '-At', '-F', '\x1f'], input=sql, capture_output=True, text=True,
                         check=True, timeout=PSQL_TIMEOUT_SECONDS).stdout
    return [l.split('\x1f') for l in out.splitlines() if l]


def api(method, path, body):
    try:
        out = subprocess.run(['curl', '-sK', f'{ROOT}/.pc.curl', '-m', '60', '-X', method, '-H', 'content-type: application/json',
                              f'http://127.0.0.1:3100/api/{path}', '--data-binary', json.dumps(body)],
                             capture_output=True, text=True, timeout=CURL_TIMEOUT_SECONDS).stdout
    except subprocess.TimeoutExpired:
        print(f'{method} {path} timed out after {CURL_TIMEOUT_SECONDS}s; outcome unknown, not retried', file=sys.stderr)
        return {'error': 'timeout'}
    try:
        return json.loads(out)
    except ValueError:
        return {'raw': out[:200]}


def reference_patterns(repo, n):
    # a number ends at a non-digit (PR 5 is not PR 50); a short name starts at a boundary (two-web-next is not legacy-two-web-next)
    end = '([^0-9]|$)'
    url = re.escape(f'github.com/{repo}/pull/{n}'.lower()) + end
    short = '(^|[^a-z0-9-])' + re.escape(f'{repo.split("/")[1]}#{n}'.lower()) + end
    return url, short


def referenced(repo, n):
    url, short = reference_patterns(repo, n)
    hit = psql(f"""select 1 from issues i where i.company_id='{CID}' and i.status not in ('done','cancelled') and (
        exists (select 1 from issue_work_products w where w.issue_id=i.id and w.url ~* '{url}')
        or i.title ~* '{short}' or coalesce(i.description,'') ~* '{url}'
        or coalesce(i.description,'') ~* '{short}'
        or exists (select 1 from issue_comments c where c.issue_id=i.id and c.created_at>now()-interval '7 days'
                   and (c.body ~* '{url}' or c.body ~* '{short}'))) limit 1""")
    return bool(hit)


def deadline_reached(start):
    return (time.monotonic() - start) >= RUN_DEADLINE_SECONDS


def find_open_card(repo, n):
    """Return (id, identifier) of the sweeper card for repo#n, or None.

    Only the card this sweeper created is eligible: its title is
    ``Shepherd <repo-short>#<n> to merge`` and its description carries the
    'Found by the orphan-PR sweeper' marker (oldest first). A broad
    reference match (review card, digest, discussion) must never receive
    the PR's work product: when ANY open card already links the PR, there
    is nothing to heal, so no row is returned.

    Timeout reads fail closed: None defers the backfill to the next tick and
    never authorizes a duplicate card.
    """
    url, _ = reference_patterns(repo, n)
    title = f"Shepherd {repo.split('/')[1]}#{n} to merge".replace("'", "''")
    try:
        rows = psql(f"""select i.id, i.identifier from issues i where i.company_id='{CID}' and i.status not in ('done','cancelled') and i.title = '{title}' and coalesce(i.description,'') like '%Found by the orphan-PR sweeper%' and not exists (select 1 from issue_work_products w join issues i2 on i2.id=w.issue_id where i2.company_id='{CID}' and i2.status not in ('done','cancelled') and w.url ~* '{url}') order by i.created_at asc limit 1""")
    except subprocess.TimeoutExpired:
        print(f'{repo}#{n}: card lookup timed out after {PSQL_TIMEOUT_SECONDS}s; backfill deferred',
              file=sys.stderr)
        return None
    return tuple(rows[0]) if rows else None


def work_product_present(card_id, repo, n):
    """True when the card already links the PR. Timeout reads fail closed."""
    url, _ = reference_patterns(repo, n)
    try:
        rows = psql(f"select 1 from issue_work_products where issue_id='{card_id}' and url ~* '{url}' limit 1")
    except subprocess.TimeoutExpired:
        print(f'{repo}#{n}: work-product check timed out after {PSQL_TIMEOUT_SECONDS}s; backfill deferred',
              file=sys.stderr)
        return True
    return bool(rows)


def card_description(url):
    return f"""Shepherd {url} to a final state. No card owned it, so nobody was watching it. Found by the orphan-PR sweeper.

Own it until it is **merged**, or **closed with a stated reason** (superseded, obsolete, or rejected):
1. Read the PR and its checks. If CI is red, fix it on the PR branch, or open a superseding PR and close this one with a link.
2. The required `Paperclip Review` check (5/5 to pass) must have run on the current head. If it shows "Authorized manual review required", first confirm the current head is not already covered: a queued/in-progress Paperclip Review run or a success/failure verdict on this head, or an existing `@togetherweown-reviewer review` mention for this head in the PR comments, means a review is already in flight or done. Re-requesting a covered head opens duplicate same-head reviews, so mention at most once per head, **through Paperclip's built-in GitHub (owner identity)**. A mention from the App or a bot account starts a low-trust review that cannot run. Answer every finding until 5/5.
3. When CI is green and the review is clean, do an exact-head re-check before you merge: confirm no CISO, CEO, security or release gate on this card is open, then squash-merge per the repo standard. A clean check never overrides a hold.
4. Done-test: the PR is merged, or closed with a reason posted on it. Keep this card's state honest meanwhile (`blocked` on a real blocker, or a scheduled monitor while CI runs)."""


def main():
    if os.path.exists(f'{STATE_DIR}/PAUSE'):
        return
    start = time.monotonic()
    try:
        token = subprocess.run([f'{ROOT}/gh_token.sh', 'token'], capture_output=True, text=True,
                               timeout=TOKEN_TIMEOUT_SECONDS).stdout.strip()
    except subprocess.TimeoutExpired:
        print(f'gh_token.sh timed out after {TOKEN_TIMEOUT_SECONDS}s; all repos skipped', file=sys.stderr)
        return
    env = dict(os.environ, GH_TOKEN=token)
    try:
        agents = {r[0]: r[1] for r in psql(f"select name, id from agents where company_id='{CID}' and status<>'terminated'")}
        projects = {r[0]: r[1] for r in psql(f"select name, id from projects where company_id='{CID}'")}
    except subprocess.TimeoutExpired:
        print(f'psql roster read timed out after {PSQL_TIMEOUT_SECONDS}s; all repos skipped', file=sys.stderr)
        return
    orphans = []
    already_owned = []
    for repo, (who, proj) in REPOS.items():
        repo_orphans = []
        try:
            prs = json.loads(subprocess.run(['gh', 'pr', 'list', '-R', repo, '--state', 'open', '--limit', '100', '--json',
                                             'number,title,author,isDraft,createdAt,url,mergeStateStatus'],
                                            capture_output=True, text=True, env=env, timeout=GH_TIMEOUT_SECONDS).stdout or '[]')
            for p in prs:
                age = (time.time() - calendar.timegm(time.strptime(p['createdAt'], '%Y-%m-%dT%H:%M:%SZ'))) / 60
                # release-please PRs stay open on purpose until a release is cut; merging one is a release decision.
                if p['title'].startswith('chore(main): release'):
                    continue
                if p['isDraft'] or age < MIN_AGE_MIN:
                    continue
                if referenced(repo, p['number']):
                    already_owned.append((repo, p))
                    continue
                repo_orphans.append((repo, who, proj, p))
        except subprocess.TimeoutExpired as error:
            step = 'gh pr list' if error.cmd[0] == 'gh' else 'psql reference read'
            print(f'{repo}: {step} timed out after {error.timeout}s; repo skipped', file=sys.stderr)
            continue
        orphans.extend(repo_orphans)
    print(f'{len(orphans)} orphan PR(s)')
    for repo, who, _, p in orphans:
        print(f"  {repo}#{p['number']} by {p['author']['login']} {p['mergeStateStatus']} -> {who} | {p['title'][:60]}")
    if not APPLY:
        return
    backfill_writes = 0
    for repo, p in already_owned:
        if backfill_writes >= MAX_NEW:
            break
        if deadline_reached(start):
            print(f'run deadline {RUN_DEADLINE_SECONDS}s reached; work-product backfill deferred to next tick',
                  file=sys.stderr)
            break
        n = p['number']
        found = find_open_card(repo, n)
        if not found:
            continue
        card_id, ident = found
        if work_product_present(card_id, repo, n):
            continue
        wp = api('POST', f'issues/{card_id}/work-products', {'type': 'pull_request', 'provider': 'github',
                                                             'url': p['url'], 'title': f'{repo}#{n}', 'status': 'active'})
        backfill_writes += 1
        if not isinstance(wp, dict) or not wp.get('id'):
            continue
        with open(f'{ROOT}/ops/worker-vps/operator-actions.log', 'a') as f:
            f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} orphan-prs: backfilled work product for "
                    f"{repo}#{n} on {ident}; the card POST predated its link.\n")
        print('backfilled', ident, repo, n)
    pending = orphans[:MAX_NEW]
    for idx, (repo, who, proj, p) in enumerate(pending):
        if deadline_reached(start):
            print(f'run deadline {RUN_DEADLINE_SECONDS}s reached; {len(pending) - idx} card(s) deferred to next tick',
                  file=sys.stderr)
            break
        n, author = p['number'], p['author']['login']
        with open(f'{ROOT}/ops/worker-vps/operator-actions.log', 'a') as f:
            f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} orphan-prs: attempting {repo}#{n} "
                    f"(by {author}) for {who}; outcome unknown if interrupted.\n")
        card = api('POST', f'companies/{CID}/issues', {
            'title': f"Shepherd {repo.split('/')[1]}#{n} to merge", 'description': card_description(p['url']),
            'status': 'todo', 'priority': 'medium', 'assigneeAgentId': agents.get(who), 'projectId': projects.get(proj)})
        if card.get('error') == 'timeout':
            continue
        if not card.get('id'):
            print(f"{repo}#{n}: card POST failed ({json.dumps(card)[:120]}); deferred to next tick",
                  file=sys.stderr)
            continue
        api('POST', f"issues/{card['id']}/work-products", {'type': 'pull_request', 'provider': 'github',
                                                         'url': p['url'], 'title': f'{repo}#{n}', 'status': 'active'})
        with open(f'{ROOT}/ops/worker-vps/operator-actions.log', 'a') as f:
            f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} orphan-prs: {repo}#{n} (by {author}) had no card; "
                    f"created {card.get('identifier')} for {who}. Rollback: cancel the card.\n")
        print('created', card.get('identifier'), repo, n)


if __name__ == '__main__':
    main()
