#!/usr/bin/env python3
"""Wake the doer of an open PR whose Paperclip Review errored on the current head (e.g. reviewer hit a quota 429).

A review that errors ("Review execution did not complete") leaves the required check at action_required and nothing
re-runs it: only an authorized mention (`@togetherweown-reviewer review` through Paperclip's built-in GitHub, owner
identity) starts a new one. 2026-10-07 02:45-03:38Z the Claude 5h window was exhausted and 13 open PRs were left
stranded this way. For each stranded (repo, pr, head): if no review for that head is queued/running and the error is
older than MIN_AGE_MIN, comment on the open card that owns the PR until a 2xx answer is recorded (the comment wakes its
assignee). Cards with a live run are skipped this tick (a comment would cancel their retries). Dry-run by default; --apply comments.
Before waking for an errored head the tick consults review_dedup.head_decision() over that head's recent row states
(TOG-24349): a completed or in-flight review, or a second error (one retry max), suppresses the wake. Suppressions are
not recorded in state, so the decision is re-made as rows evolve; the error count only grows and a completed row
persists, which is what makes the suppression permanent.
Every wake and the merge-ready notice also pass card_hold(): blocked or backlog cards, unblock descriptors, recovery
holds, open blocking edges and out-of-focus cards while focus_gate is ACTIVE all suppress them. Cards with a live or
scheduled-retry run are skipped first. A pending ask suppresses the merge-ready notice only. The merge-ready notice asks
for a re-check on the exact head; it never orders a merge.
Every subprocess is bounded (*_TIMEOUT_S below, env-overridable). A timed-out read takes the same path as a failed one
(retry next tick, never a wake or a notice); a timed-out comment POST is a failed post, retried next tick.
"""
import calendar
import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(ROOT))  # single-source guard lives at repo-root review_dedup.py
try:
    sys.path.insert(0, str(ROOT / 'ops/lib'))
    import live_run_guard  # noqa: E402  (private host guard; public fallback below)
except ImportError:
    import re as _re
    import types as _types

    _UUID = _re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
    live_run_guard = _types.SimpleNamespace(
        subprocess=subprocess,
        issue_has_live_work=lambda issue_id: True if not issue_id or not _UUID.fullmatch(str(issue_id)) else _live_work_default(issue_id))
    del _re, _types
import review_dedup  # noqa: E402  (same-head idempotency guard, repo-root single source)


def _live_work_default(issue_id):
    """Fail-closed live-run check used when the private host guard is absent.

    Returns True (treat as live) on any error, so a tick never wakes a card
    it cannot prove is idle. Deployments with a runs database override this
    by providing ops/lib/live_run_guard.py or by patching
    live_run_guard.issue_has_live_work.
    """
    q = ("select exists(select 1 from heartbeat_runs h where coalesce(h.context_snapshot->>'issueId', "
         "h.context_snapshot->>'taskId')='%s' and h.status in ('queued','running','scheduled_retry'))" % issue_id)
    run = getattr(live_run_guard, 'subprocess', subprocess).run
    try:
        out = run(['docker', 'exec', '-i', 'paperclip-db', 'psql', '-U', 'paperclip', '-d', 'paperclip',
                   '-At', '-c', q], capture_output=True, text=True, timeout=30).stdout.strip()
        return out != 'f'
    except Exception:
        return True


# All deployment-specific values come from the environment; the placeholders
# below are never valid credentials, only fail-closed defaults.
CID = os.environ.get('PAPERCLIP_COMPANY_ID', '00000000-0000-0000-0000-000000000000')
API = os.environ.get('PAPERCLIP_API', 'http://127.0.0.1:3100/api')
STATE = Path(os.environ.get('REVIEW_RERQ_STATE', str(ROOT / 'ops/productivity/review-error-rerequest.state.json')))
# Operator log defaults under REVIEW_RERQ_STATE_DIR (not the checkout) so a
# tick never creates an untracked file inside the repo; override with
# REVIEW_RERQ_LOG. STATE/PARKED still default in-tree but are gitignored.
_RERQ_STATE_DIR = os.environ.get('REVIEW_RERQ_STATE_DIR', os.path.expanduser('~/.local/state/flow-guard'))
LOG = Path(os.environ.get('REVIEW_RERQ_LOG', os.path.join(_RERQ_STATE_DIR, 'review-error-rerequest-operator-actions.log')))
PARKED = Path(os.environ.get('REVIEW_RERQ_PARKED', str(ROOT / 'ops/productivity/unreviewed-parked-prs.txt')))


def append_log(line):
    """Append one operator-actions line; a logging failure never aborts the tick."""
    try:
        LOG.parent.mkdir(parents=True, exist_ok=True)
        with LOG.open('a') as f:
            f.write(line + '\n')
    except OSError as e:
        print(f'review-error-rerequest: log write failed ({e}); continuing')


APPLY = '--apply' in sys.argv
MIN_AGE_MIN = 10
MAX_PER_TICK = 15
ELIGIBLE_STATUSES = ('todo', 'in_progress', 'in_review')
_gate = {'STATE': os.environ.get('FOCUS_GATE_STATE_DIR', str(ROOT / '.focus-gate'))}
_focus_src = ROOT / 'ops/paperclip/focus_gate.py'
if _focus_src.exists():
    exec(_focus_src.read_text().split('def tick():')[0], _gate)  # constants + db/api/allowed_sql only; no side effects
else:
    _gate['allowed_sql'] = lambda: 'select 1 where false'  # private focus list absent: nothing is in focus
del _focus_src


def _seconds(name, default):
    v = float(os.environ.get(name, default))
    if not 0 < v <= 3600:
        raise SystemExit(f'{name} must be seconds in (0, 3600], got {v}')
    return v


# A hung gh or psql call used to wedge the job until someone killed it by hand.
PSQL_TIMEOUT_S = _seconds('REVIEW_RERQ_PSQL_TIMEOUT_S', 60)
GH_TIMEOUT_S = _seconds('REVIEW_RERQ_GH_TIMEOUT_S', 60)  # gh_token.sh and every gh call
CURL_TIMEOUT_S = _seconds('REVIEW_RERQ_CURL_TIMEOUT_S', 30)  # curl --max-time; the process gets 10 s more to exit


def psql(sql):
    out = subprocess.run(['docker', 'exec', '-i', 'paperclip-db', 'psql', '-U', 'paperclip', '-d', 'paperclip',
                          '-AtF', '\t', '-c', sql], capture_output=True, text=True, check=True,
                         timeout=PSQL_TIMEOUT_S).stdout
    return [l.split('\t') for l in out.splitlines() if l]


def gh_out(cmd, env=None):
    """stdout of a bounded gh-side command; '' on timeout, which every caller already reads as a failed lookup."""
    try:
        return subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=GH_TIMEOUT_S).stdout
    except subprocess.TimeoutExpired:
        print(f'{Path(cmd[0]).name} {cmd[1]} timed out after {GH_TIMEOUT_S:g}s')
        return ''


def gh_env():
    tok = gh_out([str(ROOT / 'gh_token.sh'), 'token']).strip()
    return {'GH_TOKEN': tok, 'PATH': '/usr/bin:/bin:/usr/local/bin'}


def pr_head(repo, n, env):
    out = gh_out(['gh', 'pr', 'view', str(n), '-R', repo, '--json', 'state,headRefOid'], env)
    try:
        d = json.loads(out)
        return d['state'], d['headRefOid']
    except (ValueError, KeyError):
        return None, None


# Anchored and LIKE-escaped: unanchored, .../pull/7 also matches .../pull/70; '_' is a wildcard.
def pr_url_patterns(repo, n):
    base = f'github.com/{repo}/pull/{n}'.lower().replace('_', r'\_')
    return [f'%{base}', f'%{base}/%', f'%{base}#%', f'%{base}?%']


def owning_card(repo, n):
    match = ' or '.join(f"lower(w.url) like '{p}'" for p in pr_url_patterns(repo, n))
    eligible = ', '.join(f"'{s}'" for s in ELIGIBLE_STATUSES)
    rows = psql(f"""select i.id, i.identifier from issues i where i.company_id='{CID}'
        and i.status not in ('done','cancelled') and i.origin_kind is distinct from 'chat_channel'
        and exists (select 1 from issue_work_products w where w.issue_id=i.id and ({match}))
        order by (i.status in ({eligible})) desc, i.updated_at desc limit 1""")
    return rows[0] if rows else None


def comment(issue_id, body):
    """HTTP status of the POST; 'timeout' when curl did not exit in time. Anything not 2xx is a failed post."""
    try:
        r = subprocess.run(['curl', '-sK', str(ROOT / '.pc.curl'), '-X', 'POST', f'{API}/issues/{issue_id}/comments',
                            '-H', 'content-type: application/json', '-d', json.dumps({'body': body}),
                            '-o', '/dev/null', '--max-time', f'{CURL_TIMEOUT_S:g}', '-w', '%{http_code}'],
                           capture_output=True, text=True, timeout=CURL_TIMEOUT_S + 10)
    except subprocess.TimeoutExpired:
        return 'timeout'
    return r.stdout.strip()


def head_row_states(blob):
    """Server row states for one stranded head, from the query's state blob.

    A missing/empty blob means the state aggregate did not come back (wrong
    query shape, not the TOG-24349 column): fail closed toward suppress via
    an unrecognized marker, never toward a wake. Callers log the suppression;
    the next tick re-reads once the query is fixed.
    """
    if blob:
        states = [s for s in str(blob).split(',') if s]
        if states:
            return states
    return ['__missing_state_blob__']


def save_state(state):
    tmp = STATE.with_name(f'{STATE.name}.{os.getpid()}.tmp')
    tmp.write_text(json.dumps(state, indent=1, sort_keys=True))
    tmp.replace(STATE)


REVIEW_ORG = os.environ.get('REVIEW_ORG', 'example-org')
REPOS = tuple(s.strip() if '/' in s.strip() else f'{REVIEW_ORG}/{s.strip()}'
              for s in os.environ.get('REVIEW_REPOS', 'example-org/example-repo').split(',') if s.strip())
UNREVIEWED_MIN_AGE_H = 2


def merge_ready(env):
    """Open non-draft PRs that are CLEAN with Paperclip Review SUCCESS on the current head: (repo, number, head).
    2026-10-07: three PRs sat merge-ready for hours because the doer waited for a 'merge route' or its monitor ran out."""
    out = []
    for repo in REPOS:
        raw = gh_out(['gh', 'pr', 'list', '-R', repo, '--state', 'open', '--limit', '100', '--json',
                      'number,isDraft,mergeStateStatus,headRefOid,statusCheckRollup'], env)
        try:
            prs = json.loads(raw)
        except ValueError:
            print(f'{repo}: gh pr list gave no JSON; skipped this tick')
            continue
        for p in prs:
            if p['isDraft'] or p['mergeStateStatus'] != 'CLEAN':
                continue
            rv = [c for c in p['statusCheckRollup'] or [] if (c.get('name') or c.get('context')) == 'Paperclip Review']
            if rv and (rv[0].get('conclusion') or rv[0].get('state')) == 'SUCCESS':
                out.append((repo.lower(), p['number'], p['headRefOid']))
    return out


def unreviewed(env):
    """Open non-draft, non-conflicting PRs whose current head has no Paperclip Review check at all and whose last
    commit is older than UNREVIEWED_MIN_AGE_H: (repo, number, head). 2026-10-07: ~35 kofra PRs were never reviewed
    because nobody requested it."""
    out = []
    cutoff = time.time() - UNREVIEWED_MIN_AGE_H * 3600
    for repo in REPOS:
        raw = gh_out(['gh', 'pr', 'list', '-R', repo, '--state', 'open', '--limit', '100', '--json',
                      'number,isDraft,mergeStateStatus,headRefOid,statusCheckRollup'], env)
        try:
            prs = json.loads(raw)
        except ValueError:
            print(f'{repo}: gh pr list gave no JSON; skipped this tick')
            continue
        for p in prs:
            if p['isDraft'] or p['mergeStateStatus'] == 'DIRTY':
                continue
            if any((c.get('name') or c.get('context')) == 'Paperclip Review' for c in p['statusCheckRollup'] or []):
                continue
            last = gh_out(['gh', 'api', f"repos/{repo}/commits/{p['headRefOid']}", '--jq',
                           '.commit.committer.date'], env).strip()
            try:
                t = calendar.timegm(time.strptime(last, '%Y-%m-%dT%H:%M:%SZ'))
            except ValueError:
                print(f'{repo}#{p["number"]}: commit date unreadable; skipped this tick')
                continue
            if t < cutoff:
                out.append((repo.lower(), p['number'], p['headRefOid']))
    return out


def focus_active():
    return (Path(_gate['STATE']) / 'ACTIVE').exists()


def card_facts(issue_id, focus_on):
    rows = psql(f"""select i.status, i.unblock_descriptor is not null,
        (select count(*) from issue_relations r join issues b on b.id=r.issue_id
            where r.related_issue_id=i.id and r.type='blocks' and b.status not in ('done','cancelled')),
        (select count(*) from issue_recovery_actions ra where ra.source_issue_id=i.id
            and (ra.status in ('active','escalated') or ra.evidence->'automaticRecovery'->>'replay'='blocked')),
        (select count(*) from issue_thread_interactions t where t.issue_id=i.id and t.status='pending')
        from issues i where i.id='{issue_id}'""")
    if not rows:
        return None
    status, descriptor, blockers, recovery, pending = rows[0]
    facts = {'status': status, 'descriptor': descriptor == 't', 'blockers': int(blockers),
             'recovery': int(recovery), 'pending': int(pending)}
    if focus_on:
        in_focus = psql(f"{_gate['allowed_sql']()}\nselect exists(select 1 from blk where id='{issue_id}')")
        facts['in_focus'] = in_focus[0][0] == 't'
    return facts


def hold_reason(facts, focus_on, merge=False):
    if facts is None:
        return 'card not found'
    if facts['status'] not in ELIGIBLE_STATUSES:
        return f"status {facts['status']}"
    if facts['descriptor']:
        return 'unblock descriptor'
    if facts['recovery']:
        return 'recovery hold'
    if facts['blockers']:
        return 'unresolved blocking edge'
    # a pending ask blocks a merge order, not a review re-request
    if merge and facts['pending']:
        return 'pending interaction'
    if focus_on and not facts['in_focus']:
        return 'out of focus'
    return None


def card_hold(issue_id, merge=False):
    try:
        focus_on = focus_active()
        return hold_reason(card_facts(issue_id, focus_on), focus_on, merge)
    except Exception as e:
        return f'eligibility check failed ({type(e).__name__})'


def merge_notice(repo, n, sha):
    return (f"**Merge-ready check, not a merge order:** https://github.com/{repo}/pull/{n} is CLEAN with Paperclip Review "
            f"5/5 on head `{sha[:8]}`. Re-check that exact head before you merge: the PR is still open at `{sha[:8]}`, CI "
            "is green on it, every review finding is answered, and no CISO, CEO, security or release gate on this work is "
            "still open. CLEAN and review success never override a hold or a production approval. If any check fails, "
            "leave the PR open and say why on this card. (host operator merge-ready reconciler)")


def host_ok():
    """Fail-open host-pressure check used when the private host_ok module is absent.

    Deployments with disk/queue pressure gating provide host_ok.py on the
    path or patch this function. The default allows the tick to proceed.
    """
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from host_ok import host_ok as _private_host_ok
        return _private_host_ok()
    except ImportError:
        return True, 'ok'


def main():
    ok, why = host_ok()
    if not ok:
        print(f'host under pressure ({why}): no new wakes this run')
        return
    parked = []
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    stranded = psql(f"""with l as (select distinct on (repository, pull_number, head_sha) repository, pull_number,
        head_sha, state, updated_at from chat_github_reviews where company_id='{CID}'
        and created_at > now() - interval '3 days' order by repository, pull_number, head_sha, updated_at desc)
        select l.repository, l.pull_number, l.head_sha, (select string_agg(c.state, ',')
        from chat_github_reviews c where c.company_id='{CID}' and lower(c.repository)=lower(l.repository)
        and c.pull_number=l.pull_number and c.head_sha=l.head_sha and c.created_at > now() - interval '3 days')
        from l where l.state in ('error','incomplete')
        and l.updated_at < now() - interval '{MIN_AGE_MIN} minutes' order by l.updated_at""")
    env = gh_env()
    done = 0
    # The 4th column (state blob) carries the head's recent row states for the
    # dedup guard. A row without it fails closed: head_row_states maps the
    # missing blob to an unrecognized marker so head_decision suppresses the
    # wake instead of re-requesting every errored head.
    stranded = ([(row[0], row[1], row[2], 'error', row[3] if len(row) > 3 else None) for row in stranded]
                + [(r, n, s, 'none', None) for r, n, s in unreviewed(env)]
                + [(r, n, s, 'ready', None) for r, n, s in merge_ready(env)])
    for repo, n, sha, kind, blob in stranded:
        key = f'{repo}#{n}@{sha}' + {'error': '', 'none': ':unreviewed', 'ready': ':mergeready'}[kind]
        if key in state or done >= MAX_PER_TICK:
            continue
        pr_state, head = pr_head(repo, n, env)
        if pr_state is None:
            print(f'{key}: PR lookup failed, retry next tick')
            continue
        if kind == 'ready' and pr_state == 'OPEN' and head == sha:
            try:
                card = owning_card(repo, n)
            except Exception as e:
                print(f'{key}: owner lookup failed ({type(e).__name__}); retry next tick')
                continue
            if not card:
                print(f'{key}: no open card owns this PR (orphan_prs.py handles orphans)')
                continue
            if live_run_guard.issue_has_live_work(card[0]):
                print(f'{key}: {card[1]} has a live run, retry next tick')
                continue
            hold = card_hold(card[0], merge=True)
            if hold:
                print(f'{key}: {card[1]} held ({hold}); no merge notice')
                continue
            if not APPLY:
                print(f'would notify {card[1]} about {key}')
                continue
            code = comment(card[0], merge_notice(repo, n, sha))
            done += 1
            if not code.startswith('2'):
                print(f'{key}: {card[1]} comment failed (HTTP {code}); retry next tick')
                continue
            state[key] = f'{card[1]} {code} {time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}'
            save_state(state)
            append_log(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} review-error-rerequest: merge notice to "
                       f"{card[1]} for {key} (HTTP {code})")
            continue
        if pr_state != 'OPEN' or head != sha:
            state[key] = 'moot'
            continue
        if kind == 'error':
            action, why = review_dedup.head_decision(head_row_states(blob))
            if action != 'request':
                print(f'{key}: {why}; no second request for this head')
                continue
        try:
            card = owning_card(repo, n)
        except Exception as e:
            print(f'{key}: owner lookup failed ({type(e).__name__}); retry next tick')
            continue
        if not card:
            if kind == 'none':
                parked.append(f'{repo}#{n} (no card)')
            else:
                print(f'{key}: no open card owns this PR (orphan_prs.py handles orphans)')
            continue
        issue_id, ident = card
        if live_run_guard.issue_has_live_work(issue_id):
            print(f'{key}: {ident} has a live run, retry next tick')
            continue
        hold = card_hold(issue_id)
        if hold:
            if kind == 'none':
                parked.append(f'{repo}#{n} ({ident}: {hold})')
            else:
                print(f'{key}: {ident} held ({hold}); no review wake')
            continue
        lead = (f"**Paperclip Review errored on the current head** of https://github.com/{repo}/pull/{n} "
                f"(`{sha[:8]}`), most likely while the reviewer's Claude window was exhausted. Nothing re-runs it "
                "automatically, so the required check stays at action_required.\n\n") if kind == 'error' else (
                f"**https://github.com/{repo}/pull/{n} has never been reviewed** on its current head (`{sha[:8]}`, "
                f"last commit over {UNREVIEWED_MIN_AGE_H}h ago). It cannot merge without Paperclip Review 5/5. If it is "
                "still wanted, request the review now. If it is superseded, close the PR with a one-line reason.\n\n")
        body = (lead +
                "Action: re-request it by commenting `@togetherweown-reviewer review` on the PR **through "
                "Paperclip's built-in GitHub (owner identity)**. A mention from the App or a bot account starts a "
                "low-trust review that cannot run. Then answer every finding until 5/5. Merge only after an exact-head "
                "re-check, and only with no open pending decision and no CISO, CEO, security or release gate on this card. "
                "(host operator review-error reconciler)")
        if not APPLY:
            print(f'would wake {ident} for {key}')
            continue
        code = comment(issue_id, body)
        done += 1
        if not code.startswith('2'):
            print(f'{key}: {ident} comment failed (HTTP {code}); retry next tick')
            continue
        state[key] = f'{ident} {code} {time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}'
        save_state(state)
        append_log(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} review-error-rerequest: woke {ident} "
                   f"to re-request review for {key} (HTTP {code})")
        print(f'woke {ident} for {key} HTTP {code}')
    PARKED.write_text(''.join(f'{line}\n' for line in parked))
    if parked:
        print(f'{len(parked)} unreviewed PRs on parked/absent cards listed in ops/productivity/unreviewed-parked-prs.txt')
    if APPLY:
        save_state(state)


if __name__ == '__main__':
    main()
