#!/usr/bin/env python3
"""Single recovery writer: one policy, one receipt format, detectors stay separate.

WHY THIS EXISTS.

Several host timers used to write board recovery actions independently of each
other (resumes, unblocks, review handbacks, releases, resets, pin clears, load
aborts). Independent writers race: one timer's repair is another timer's
precondition violation, and two writers can bounce one card between states on
alternate ticks. This file is the only writer. Detectors keep doing what they
do -- measuring and proposing -- but nothing reaches the board except through
here, under one allowlist and one receipt schema.

TWO DRIFTS THIS WRITER MAKES STRUCTURALLY IMPOSSIBLE.

1. A unit labelled dry-run that really writes. The old shape took its mode
   from the environment, so an EnvironmentFile meant for credentials could
   flip a detector into a writer without touching argv. Here apply is
   argv-only: ``--apply`` on the command line is the single bit that permits
   mutation, and no environment variable is read for it. ``test`` pins this:
   with a decoy ``RECOVERY_WRITER_APPLY=1`` exported, the writer still runs
   dry. A future unit file must pass ``--apply`` literally; an env-file-only
   unit can never write, whatever its Description says.

2. A loop guard that assigns the owner. One predecessor reassigned a card to
   the owner's own user identity, against the standing rule that owner-bound
   work routes to the chief executive instead. This writer has no code path
   that emits a user assignment: any proposal naming a user target is
   rewritten to the configured chief-executive agent, and the rewrite is
   recorded in the receipt. Without a configured executive the proposal is
   refused, never delivered to the owner. ``test`` pins both halves.

FIRST AUTO-ACTION (one only).

``reset_agent_error`` clears an agent stuck in ``error`` back to ``idle``,
and only for the known-benign exit-143 false-failure: the failed run's
result subtype is ``success`` plus
``unmanagedBackgroundTask.terminalResultSeen=true``, older than 10 minutes.
The detector proposes; the writer re-reads the live agent and the exact run
and refuses on anything stale or non-benign. Every other agent error routes
to the owning lead through detector findings and the CEO routine -- the
writer never decides it. Everything else from the detectors stays
propose-only (``mutation: none`` diagnostics).

MODES.

  python3 recovery_writer.py --proposals proposals.json
      Dry-run (default): validate every proposal against the policy, print
      cycle/proposal/receipt records, mutate nothing. Exit 0 when every
      record is decided, 1 when any apply failed (dry-run never applies, so
      this only fires on undecidable input), 2 on usage/API error.

  python3 recovery_writer.py --proposals proposals.json --apply
      Decide, re-read each live card, and apply the allowed mutations through
      the supported board routes, one JSONL receipt per proposal.

  python3 recovery_writer.py --proposals proposals.json --apply --max-repairs 0
      Observe-only: every trigger is still measured and printed, but each
      mutating decision is downgraded to a non-mutating ``rate_limited`` row,
      so the run is provably incapable of a write. This is the required mode
      for the parallel-run comparison in docs/recovery-writer-migration.md.

Exit codes: 0 decided (dry-run report / apply complete, including clean
refusals -- a refused proposal is the policy working, not a failure), 1 an
apply failed or an input was undecidable/unreadable (loud on stderr, receipt
carries the cause), 2 usage or API error (fail loudly, never silent).

No secrets in output: stdout carries only identifiers, statuses, model ids,
agent ids and classifications. Receipts never include credential material.
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

POLICY_VERSION = 2
WRITER_NAME = "recovery-writer/2"

TERMINAL_STATUSES = {"done", "cancelled"}
LIVE_RUN_STATUSES = {"queued", "running"}

# The writer's whole authority. A detector may propose anything; only these
# mutations can reach the board. Everything else is reported as a diagnostic
# (mutation "none") so the measurement is kept and the write is not done.
# Resumes, unblocks-by-retry, review handbacks, releases and resets are
# deliberately absent: continuation belongs to the platform's native recovery
# paths, and a second writer dispatching parallel replacements is the race
# this consolidation exists to end.
ALLOWED_MUTATIONS = {
    "create_pause_hold",
    "assign_blocker_owner",
    "restore_blocked",
    "operator_decision",
    "clear_pin",
    # First and only auto-action: reset an agent stuck in error to idle, and
    # only for the known-benign exit-143 false-failure (benign_reset_eligible
    # below). Everything else the detectors measure stays propose-only.
    "reset_agent_error",
}

# Mutations that only preserve an already-declared hold. These stay available
# while a hold barrier is live; every other mutation is refused there, and a
# bare comment is refused too (commenting wakes the assignee, which is itself
# a mutation of the card's attention state).
HOLD_MAINTENANCE = {"create_pause_hold", "restore_blocked"}

# First and only auto-action: an agent stuck in error resets to idle past this
# age, and only for the known-benign exit-143 false-failure. Mirrors the
# watchdog detector threshold so the two agree on what "past 10m" means.
AGENT_ERROR_MIN = 10
BENIGN_SUBTYPE = "success"


def benign_reset_evidence(result: Any) -> tuple[bool, str]:
    """Check one run record for the known-benign exit-143 false-failure.

    The signature is exactly two conjuncts: the run's result subtype is
    ``success`` plus ``unmanagedBackgroundTask.terminalResultSeen=true`` --
    the run already produced its terminal result before cleanup SIGTERMed a
    leftover background task. Anything else (missing record, missing keys,
    any other value) is NOT benign: fail closed and route to the owning
    lead, never auto-reset. A detector that forgot to classify must not
    reset by omission, so absence refuses exactly like a wrong value.
    """
    if not isinstance(result, dict):
        return False, (
            "no run result to prove benignity; refusing and routing "
            "to the owning lead"
        )
    subtype = result.get("subtype")
    background = result.get("unmanagedBackgroundTask")
    background = background if isinstance(background, dict) else {}
    seen = background.get("terminalResultSeen")
    if subtype != BENIGN_SUBTYPE or seen is not True:
        return False, (
            f"run is not the benign exit-143 signature "
            f"(subtype={subtype!r}, terminalResultSeen={seen!r}); "
            f"refusing and routing to the owning lead"
        )
    return True, ""


def decide_agent_reset(
    proposal: dict[str, Any],
    now: datetime.datetime | None = None,
) -> Decision:
    """Decide the single auto-action: reset an error-stuck agent to idle.

    Offline evidence gate only. The proposal must pin the EXACT failed run
    (``runId``) plus its benign result (``result``: subtype success plus
    ``unmanagedBackgroundTask.terminalResultSeen=true``) and its
    ``finishedAt``. Age past ``AGENT_ERROR_MIN`` is evaluated here with an
    injectable clock so tests stay deterministic; ``main`` passes no clock.
    Apply re-verifies every conjunct against live reads and refuses on
    anything stale, so a dry-run ``decided`` never implies a live write.
    Non-benign evidence refuses with ``refused:non_benign`` -- the owning
    lead triages through detector findings and the CEO routine, never here.
    """
    identifier = str(proposal.get("identifier") or "?")
    detector = str(proposal.get("detector") or "unknown")
    reason = str(proposal.get("reason") or "benign_agent_error")
    raw_agent = proposal.get("agentId")
    agent_id = str(raw_agent) if raw_agent else None
    raw_run = proposal.get("runId")
    run_id = str(raw_run) if raw_run else None
    before = proposal.get("before") if isinstance(proposal.get("before"), dict) else {}
    after = proposal.get("after") if isinstance(proposal.get("after"), dict) else {}
    note = str(proposal.get("note") or "")

    def refused(cause: str, detail: str) -> Decision:
        return Decision(
            "", identifier, detector, reason, "reset_agent_error",
            agent_id, run_id, None, before, after, detail,
            f"refused:{cause}",
        )

    if agent_id is None:
        return refused("no_agent", "No agent id; the writer resets a named agent only.")
    if run_id is None:
        return refused(
            "no_run",
            "No run id; benignity is proven per exact run, never per agent.",
        )
    finished_raw = proposal.get("finishedAt") or before.get("finishedAt")
    finished = parse_time(finished_raw)
    if finished is None:
        return refused(
            "unaged",
            "No parseable finishedAt; the 10-minute age gate cannot be evaluated.",
        )
    moment = now or datetime.datetime.now(datetime.timezone.utc)
    age_min = (moment - finished).total_seconds() / 60
    if age_min <= AGENT_ERROR_MIN:
        return refused(
            "too_fresh",
            f"Run finished {age_min:.1f}m ago; reset only past {AGENT_ERROR_MIN}m.",
        )
    result = proposal.get("result")
    if not isinstance(result, dict):
        inner = before.get("result")
        result = inner if isinstance(inner, dict) else None
    benign, cause = benign_reset_evidence(result)
    if not benign:
        return refused("non_benign", f"{cause} Routing to the owning lead.")
    return Decision(
        "", identifier, detector, reason, "reset_agent_error",
        agent_id, run_id, None,
        {"agentId": agent_id, "runId": run_id, "status": "error",
         "finishedAt": finished_raw, "subtype": BENIGN_SUBTYPE,
         "terminalResultSeen": True},
        {"agentId": agent_id, "status": "idle"},
        note or "Benign exit-143 false-failure past 10m; auto-reset to idle.",
        "decided",
    )


class WriterError(RuntimeError):
    """Loud, fatal failure: API error, usage error, undecidable input."""


@dataclass(frozen=True)
class Decision:
    issue_id: str
    identifier: str
    detector: str
    reason: str
    mutation: str
    target_agent_id: str | None
    source_id: str | None
    redirected: str | None
    before: dict[str, Any]
    after: dict[str, Any]
    note: str
    outcome: str  # decided | refused:... | rate_limited | no_mutation

    @property
    def fingerprint(self) -> str:
        material = json.dumps(
            {
                "issueId": self.issue_id,
                "reason": self.reason,
                "mutation": self.mutation,
                "targetAgentId": self.target_agent_id,
                "sourceId": self.source_id,
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        return hashlib.sha256(material.encode()).hexdigest()[:24]

    def receipt(self, mode: str, apply_outcome: str | None = None) -> dict[str, Any]:
        return {
            "type": "receipt",
            "writer": WRITER_NAME,
            "policyVersion": POLICY_VERSION,
            "mode": mode,
            "issueId": self.issue_id,
            "identifier": self.identifier,
            "detector": self.detector,
            "reason": self.reason,
            "mutation": self.mutation,
            "targetAgentId": self.target_agent_id,
            "sourceId": self.source_id,
            "redirected": self.redirected,
            "fingerprint": self.fingerprint,
            "before": self.before,
            "after": self.after,
            "note": self.note,
            "decision": self.outcome,
            "apply": apply_outcome,
        }


def parse_time(value: Any) -> datetime.datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        text = value.strip()
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        moment = datetime.datetime.fromisoformat(text)
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=datetime.timezone.utc)
        return moment
    except ValueError:
        return None


def active_pause_hold(issue: dict[str, Any]) -> dict[str, Any] | None:
    state = issue.get("treeControlState")
    if isinstance(state, dict):
        hold = state.get("activePauseHold")
        if isinstance(hold, dict) and hold.get("status") == "active":
            return hold
    return None


def issue_has_hold(issue: dict[str, Any]) -> tuple[bool, str | None]:
    """Report whether a hold barrier covers this issue.

    The writer does not parse prose to FIND holds -- hold detection belongs
    to the detectors. It only honours two first-class signals: an active
    pause hold on the tree-control state, and an explicit hold marker the
    proposing detector already extracted (``holdEvidence``). A bare-body
    mention with no first-class signal refuses nothing here and initiates
    nothing: unauthenticated prose may not steer the single writer.
    """
    pause = active_pause_hold(issue)
    if pause is not None:
        return True, f"active pause hold {pause.get('id', '?')}"
    evidence = issue.get("holdEvidence")
    if isinstance(evidence, str) and evidence:
        return True, f"detector hold evidence: {evidence[:200]}"
    descriptor = issue.get("unblockDescriptor")
    if isinstance(descriptor, dict):
        action = descriptor.get("action")
        if isinstance(action, str) and "hold" in action.lower():
            return True, f"unblockDescriptor: {action[:200]}"
    return False, None


def redirect_user_target(
    proposal: dict[str, Any],
    ceo_agent_id: str | None,
    owner_user_id: str | None,
    owner_agent_id: str | None,
) -> tuple[str | None, str | None, str | None]:
    """Resolve who the write may actually target.

    Returns (target_agent_id, redirected_marker, refusal_cause). The writer
    never emits a user assignment: a proposal naming a user target is
    rewritten to the chief executive ONLY when it matches the configured
    owner identity, and the rewrite is recorded in the receipt. Anything
    else -- an unknown user, the owner identity with no executive
    configured -- is refused, never delivered. Fail closed: without
    --owner-user-id the writer cannot verify a user target IS the owner,
    so every user target refuses.
    """
    target_agent = proposal.get("targetAgentId")
    target_user = proposal.get("targetUserId")
    after = proposal.get("after")
    after_user = after.get("assigneeUserId") if isinstance(after, dict) else None
    names_user = target_user if target_user is not None else after_user
    if names_user is not None:
        if owner_user_id is None or str(names_user) != str(owner_user_id):
            return None, None, (
                f"user target {names_user!r} is not the configured owner identity; "
                f"the writer assigns agents only and redirects no one it cannot verify"
            )
        if not ceo_agent_id:
            return None, None, "owner user target with no chief-executive agent configured; refusing"
        return ceo_agent_id, "user-target->chief-executive", None
    if (
        owner_agent_id is not None
        and isinstance(target_agent, str)
        and target_agent == owner_agent_id
    ):
        if not ceo_agent_id:
            return None, None, "owner agent target with no chief-executive agent configured; refusing"
        return ceo_agent_id, "owner-agent->chief-executive", None
    if isinstance(target_agent, str) and target_agent:
        return target_agent, None, None
    return None, None, None


def decide(
    proposal: dict[str, Any],
    live: dict[str, Any],
    ceo_agent_id: str | None,
    owner_user_id: str | None = None,
    owner_agent_id: str | None = None,
) -> Decision:
    """Apply the single policy to one detector proposal against live state."""
    issue_id = str(proposal.get("issueId") or live.get("id") or "")
    identifier = str(proposal.get("identifier") or live.get("identifier") or "?")
    detector = str(proposal.get("detector") or "unknown")
    reason = str(proposal.get("reason") or "unspecified")
    mutation = str(proposal.get("mutation") or "none")
    source_id = proposal.get("sourceId")
    source_id = str(source_id) if source_id is not None else None
    before = proposal.get("before") if isinstance(proposal.get("before"), dict) else {}
    after = proposal.get("after") if isinstance(proposal.get("after"), dict) else {}
    note = str(proposal.get("note") or "")

    def decided(
        final_mutation: str,
        target: str | None,
        redirected: str | None,
        outcome: str,
        final_note: str,
    ) -> Decision:
        return Decision(
            issue_id, identifier, detector, reason, final_mutation,
            target, source_id, redirected, before, after, final_note or note,
            outcome,
        )

    if mutation == "reset_agent_error":
        # Agent-targeted: the board card is untouched, so no issue id, hold
        # barrier or terminal check applies. All verification is against the
        # live agent and the exact run, re-read at apply.
        return decide_agent_reset(proposal)
    if not issue_id:
        raise WriterError(f"proposal {identifier}: no issue id (proposal and live state both lack one)")
    if mutation not in ALLOWED_MUTATIONS | {"none"}:
        return decided(
            mutation, None, None, f"refused:unknown_mutation",
            f"Mutation {mutation!r} is outside the writer allowlist; "
            f"reported as diagnostic, never applied.",
        )
    if mutation == "none":
        return decided("none", None, None, "no_mutation", note or "Detector diagnostic; no board write proposed.")
    if live.get("status") in TERMINAL_STATUSES:
        return decided(
            mutation, None, None, "refused:terminal",
            "Live card is terminal; the writer never reopens one.",
        )
    hold, hold_evidence = issue_has_hold(live)
    if hold and mutation not in HOLD_MAINTENANCE:
        return decided(
            mutation, None, None, "refused:hold_barrier",
            f"Hold barrier is live ({hold_evidence}); only hold maintenance "
            f"may write while it stands.",
        )

    target, redirected, refusal = redirect_user_target(
        proposal, ceo_agent_id, owner_user_id, owner_agent_id
    )
    if refusal is not None:
        return decided(mutation, None, None, f"refused:{refusal.split(';')[0]}", refusal)

    if mutation == "create_pause_hold":
        if active_pause_hold(live) is not None:
            return decided(mutation, target, redirected, "refused:already_held",
                           "A pause hold is already active; containment is in place.")
        if not proposal.get("holdEvidence") and not issue_has_hold(live)[0]:
            return decided(mutation, target, redirected, "refused:no_hold_evidence",
                           "Containment needs a first-class hold signal; prose alone never initiates one.")
        return decided(mutation, target, redirected, "decided", note)

    if mutation == "assign_blocker_owner":
        if live.get("assigneeAgentId"):
            return decided(mutation, target, redirected, "refused:already_assigned",
                           "Live card already has an assignee; ownership repair is no longer needed.")
        if target is None:
            return decided(mutation, target, redirected, "refused:no_owner",
                           "No first-class intended owner; route to an operator decision instead.")
        live_owner = None
        descriptor = live.get("unblockDescriptor")
        if isinstance(descriptor, dict):
            owner = descriptor.get("owner")
            if isinstance(owner, dict) and owner.get("agentId"):
                live_owner = str(owner.get("agentId"))
        if live_owner is not None and live_owner != target:
            return decided(mutation, target, redirected, "refused:owner_changed",
                           "The intended blocker owner changed before apply; refusing a stale repair.")
        return decided(mutation, target, redirected, "decided", note)

    if mutation == "restore_blocked":
        if live.get("status") == "blocked":
            return decided(mutation, target, redirected, "refused:already_blocked",
                           "Live card is already blocked; restoration is in place.")
        if not isinstance(live.get("unblockDescriptor"), dict):
            return decided(mutation, target, redirected, "refused:no_descriptor",
                           "Restoration needs the live descriptor; refusing to park a card with no resume path.")
        return decided(mutation, target, redirected, "decided", note)

    if mutation == "operator_decision":
        return decided(mutation, target, redirected, "decided", note)

    if mutation == "clear_pin":
        if proposal.get("provenance") != "auto":
            return decided(mutation, target, redirected, "refused:manual_pin",
                           "Only provenance-checked automatic pins are clearable; a manual pin is never touched.")
        live_overrides = live.get("assigneeAdapterOverrides")
        if not isinstance(live_overrides, dict) or not live_overrides:
            return decided(mutation, target, redirected, "refused:pin_gone",
                           "Live card carries no overrides; the pin is already gone.")
        want_pin = proposal.get("pinModel")
        if want_pin is not None:
            live_pin = live_overrides.get("adapterConfig", {}).get("model") if isinstance(
                live_overrides.get("adapterConfig"), dict) else None
            if live_pin != want_pin:
                return decided(mutation, target, redirected, "refused:pin_changed",
                               "The live pin changed since the proposal; refusing a stale clear.")
        return decided(mutation, target, redirected, "decided", note)

    return decided(mutation, target, redirected, "refused:unknown_mutation",
                   f"Mutation {mutation!r} fell through the policy; refusing closed.")


class PaperclipClient:
    def __init__(self, base_url: str, api_key: str, run_id: str | None = None):
        base = base_url.rstrip("/")
        if base.endswith("/api"):
            base = base[:-4]
        self.base_url = base
        self.api_key = api_key
        self.run_id = run_id

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        headers = {"Authorization": f"Bearer {self.api_key}"}
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body, separators=(",", ":")).encode()
        if self.run_id:
            headers["X-Paperclip-Run-Id"] = self.run_id
        request = urllib.request.Request(
            self.base_url + path, data=data, headers=headers, method=method
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                raw = response.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as error:
            raw = error.read().decode(errors="replace")
            raise WriterError(f"{method} {path}: HTTP {error.code}: {raw[:500]}") from error
        except urllib.error.URLError as error:
            raise WriterError(f"{method} {path}: {error.reason}") from error

    def get(self, path: str) -> Any:
        return self._request("GET", path)

    def patch(self, path: str, body: dict[str, Any]) -> Any:
        # Structural guard for the owner-assignment drift: the writer never
        # emits a user assignment on any route. A caller that assembled one
        # fails here, before the bytes leave the process, rather than at the
        # server -- and the test suite asserts this without any network.
        if "assigneeUserId" in body:
            raise WriterError(
                "refusing to PATCH a user assignment; the writer assigns agents only"
            )
        return self._request("PATCH", path, body)

    def post(self, path: str, body: dict[str, Any]) -> Any:
        return self._request("POST", path, body)

    def read_live(self, issue_id: str) -> dict[str, Any]:
        live = self.get(f"/api/issues/{issue_id}")
        if not isinstance(live, dict):
            raise WriterError(f"GET issue {issue_id} returned non-object")
        tree = self.get(f"/api/issues/{issue_id}/tree-control/state")
        if isinstance(tree, dict):
            live["treeControlState"] = tree
        return live


def apply_decision(client: PaperclipClient, decision: Decision) -> dict[str, Any]:
    if decision.outcome != "decided":
        return {"outcome": decision.outcome, "wrote": False}
    issue_id = decision.issue_id
    marker = f"recovery-writer:{decision.fingerprint}"
    if decision.mutation == "create_pause_hold":
        response = client.post(f"/api/issues/{issue_id}/tree-holds", {
            "mode": "pause",
            "reason": f"Owner-HOLD containment ({marker})",
            "releasePolicy": {
                "strategy": "manual",
                "note": "Release only after the explicit hold is superseded.",
            },
            "metadata": {"source": "recovery_writer", "fingerprint": decision.fingerprint},
        })
        hold = response.get("hold") if isinstance(response, dict) else None
        if not isinstance(hold, dict) or hold.get("status") != "active":
            raise WriterError(f"{decision.identifier}: tree-hold API returned no active pause hold")
        return {"outcome": "applied", "wrote": True}
    if decision.mutation == "assign_blocker_owner":
        response = client.patch(
            f"/api/issues/{issue_id}", {"assigneeAgentId": decision.target_agent_id}
        )
        if not isinstance(response, dict) or response.get("assigneeAgentId") != decision.target_agent_id:
            raise WriterError(f"{decision.identifier}: assignee did not take on re-read")
        return {"outcome": "applied", "wrote": True}
    if decision.mutation == "restore_blocked":
        live = client.read_live(issue_id)
        descriptor = live.get("unblockDescriptor")
        if not isinstance(descriptor, dict):
            raise WriterError(f"{decision.identifier}: live descriptor vanished before apply")
        response = client.patch(
            f"/api/issues/{issue_id}", {"status": "blocked", "unblockDescriptor": descriptor}
        )
        if not isinstance(response, dict) or response.get("status") != "blocked":
            raise WriterError(f"{decision.identifier}: status did not restore to blocked")
        return {"outcome": "applied", "wrote": True}
    if decision.mutation == "operator_decision":
        client.post(f"/api/issues/{issue_id}/comments", {
            "body": f"Recovery decision `{marker}`.\n\n- Reason: `{decision.reason}`\n- Detail: {decision.note}",
        })
        return {"outcome": "applied", "wrote": True}
    if decision.mutation == "clear_pin":
        response = client.patch(f"/api/issues/{issue_id}", {"assigneeAdapterOverrides": None})
        if not isinstance(response, dict) or response.get("assigneeAdapterOverrides") is not None:
            raise WriterError(f"{decision.identifier}: overrides did not clear on re-read")
        return {"outcome": "applied", "wrote": True}
    if decision.mutation == "reset_agent_error":
        # Live re-verification: every offline conjunct is proven again
        # against fresh reads. Anything stale or non-benign raises -- a
        # failed apply, loud on stderr -- and the agent is never touched.
        # Only the exact pinned run on the exact pinned agent can authorize
        # this write; a dry-run "decided" never implies a live write.
        agent_id = decision.target_agent_id
        run_id = decision.source_id
        if not agent_id or not run_id:
            raise WriterError(f"{decision.identifier}: reset decision lacks agent or run binding")
        agent = client.get(f"/api/agents/{agent_id}")
        if not isinstance(agent, dict):
            raise WriterError(f"{decision.identifier}: live agent {agent_id} unreadable")
        if agent.get("status") != "error":
            raise WriterError(
                f"{decision.identifier}: live agent is {agent.get('status')!r}, "
                f"not error; refusing a stale reset"
            )
        run = client.get(f"/api/heartbeat-runs/{run_id}")
        if not isinstance(run, dict):
            raise WriterError(f"{decision.identifier}: live run {run_id} unreadable")
        if run.get("agentId") != agent_id:
            raise WriterError(
                f"{decision.identifier}: live run belongs to another agent; "
                f"refusing a stale reset"
            )
        if run.get("status") != "failed":
            raise WriterError(
                f"{decision.identifier}: live run is {run.get('status')!r}, "
                f"not failed; refusing a stale reset"
            )
        live_finished = parse_time(run.get("finishedAt"))
        if live_finished is None:
            raise WriterError(f"{decision.identifier}: live run has no parseable finishedAt; refusing")
        age_min = (datetime.datetime.now(datetime.timezone.utc) - live_finished).total_seconds() / 60
        if age_min <= AGENT_ERROR_MIN:
            raise WriterError(
                f"{decision.identifier}: live run finished {age_min:.1f}m ago; "
                f"refusing a fresh reset"
            )
        benign, cause = benign_reset_evidence(run.get("resultJson"))
        if not benign:
            raise WriterError(f"{decision.identifier}: live run is not benign ({cause})")
        client.post(f"/api/agents/{agent_id}/clear-error", {})
        recheck = client.get(f"/api/agents/{agent_id}")
        if not isinstance(recheck, dict) or recheck.get("status") != "idle":
            raise WriterError(f"{decision.identifier}: agent did not read back idle after clear-error")
        return {"outcome": "applied", "wrote": True}
    raise WriterError(f"{decision.identifier}: decided mutation {decision.mutation!r} has no applier")


def load_proposals(path: str) -> list[dict[str, Any]]:
    """Load detector proposals from JSON or JSONL.

    JSON: ``{"proposals": [...]}`` or a bare list. JSONL (``.jsonl``
    suffix or a leading ``"type"`` record): one JSON document per line, as
    detectors print them; ``type: proposal`` records are taken and
    ``cycle``/``summary``/``receipt`` lines are skipped, so a detector's
    stdout can feed the writer unmodified.
    """
    try:
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
    except OSError as exc:
        raise WriterError(f"cannot read proposals {path}: {exc}") from exc
    rows: list[dict[str, Any]] = []
    if path.endswith(".jsonl") or _looks_like_jsonl(text):
        for lineno, line in enumerate(text.splitlines(), 1):
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                raise WriterError(f"proposals {path} line {lineno}: not JSON: {exc}") from exc
            if not isinstance(record, dict):
                raise WriterError(f"proposals {path} line {lineno}: want an object")
            if record.get("type", "proposal") != "proposal":
                continue
            rows.append(record)
    else:
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise WriterError(f"cannot parse proposals {path}: {exc}") from exc
        candidate = data.get("proposals") if isinstance(data, dict) else None
        if candidate is None and isinstance(data, list):
            candidate = data
        if not isinstance(candidate, list) or not all(isinstance(row, dict) for row in candidate):
            raise WriterError(f"proposals {path}: want {{\"proposals\": [...]}} with object entries")
        rows = candidate
    if not rows:
        raise WriterError(f"proposals {path}: zero proposals; refusing to report a clean cycle")
    return rows


def _looks_like_jsonl(text: str) -> bool:
    first = ""
    for line in text.splitlines():
        if line.strip():
            first = line.strip()
            break
    return first.startswith("{") and '"type"' in first


def parse_args(argv: list[str]) -> argparse.Namespace:
    # NOTE: apply is argv-only ON PURPOSE. No environment variable enables a
    # write; see the module docstring drift note. Do not add one.
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--proposals", default=None, help="JSON file with {\"proposals\": [...]}")
    parser.add_argument("--apply", action="store_true", help="perform decided mutations; default is dry-run")
    parser.add_argument("--max-repairs", type=int, default=5,
                        help="cap on applied mutations per cycle; 0 is observe-only")
    parser.add_argument("--ceo-agent-id", default=None,
                        help="explicit agent receiving owner-bound work; absent or empty refuses the redirect")
    parser.add_argument("--owner-user-id", default=None,
                        help="owner user identity, matched only to refuse/redirect it")
    parser.add_argument("--owner-agent-id", default=None,
                        help="owner-associated agent identity, matched only to redirect it")
    parser.add_argument("--api-url", default=os.environ.get("PAPERCLIP_API_URL"))
    parser.add_argument("--api-key", default=os.environ.get("PAPERCLIP_API_KEY"))
    parser.add_argument("--run-id", default=os.environ.get("PAPERCLIP_RUN_ID"))
    parser.add_argument("--receipt-out", default=None, help="append JSONL receipts to this file")
    parser.add_argument("--check-service-credential", action="store_true",
                        help="refuse unless the API key is a board/service identity with the required safe capabilities")
    parser.add_argument("--preflight-issue-id", default=os.environ.get("PAPERCLIP_PREFLIGHT_ISSUE_ID"),
                        help="controlled issue used for read-only scope checks")
    parser.add_argument("--preflight-agent-id", default=os.environ.get("PAPERCLIP_PREFLIGHT_AGENT_ID"),
                        help="controlled agent used for the exact read-only agents:create authority check")
    parser.add_argument("--company-id", default=os.environ.get("PAPERCLIP_COMPANY_ID"))
    args = parser.parse_args(argv)
    if args.max_repairs < 0:
        parser.error("--max-repairs must be non-negative")
    if args.ceo_agent_id == "":
        args.ceo_agent_id = None
    if args.apply and not (args.api_url and args.api_key):
        parser.error("live --apply requires --api-url and --api-key (or PAPERCLIP_* env)")
    if args.check_service_credential and not (args.api_url and args.api_key and args.company_id):
        parser.error("--check-service-credential requires --api-url, --api-key and --company-id (or PAPERCLIP_* env)")
    if args.check_service_credential and not args.preflight_issue_id:
        parser.error("--check-service-credential requires --preflight-issue-id (or PAPERCLIP_PREFLIGHT_ISSUE_ID)")
    if args.check_service_credential and not args.preflight_agent_id:
        parser.error("--check-service-credential requires --preflight-agent-id (or PAPERCLIP_PREFLIGHT_AGENT_ID)")
    if not args.check_service_credential and not args.proposals:
        parser.error("--proposals is required (unless --check-service-credential)")
    return args


def check_service_credential(
    client: PaperclipClient, company_id: str, issue_id: str, agent_id: str
) -> int:
    """Validate the dedicated board identity and every non-mutating read seam.

    Scheduled writes require a dedicated board/service identity because agent
    writes require a live run ID and consume a per-run cross-issue budget.
    Paperclip has no side-effect-free permission-check endpoint for the write
    routes used by apply mode, so the check proves the read seams and the
    non-viewer membership; the first real repair remains fail-closed if a
    write grant was removed after installation.
    """
    identity = client.get("/api/cli-auth/me")
    if (not isinstance(identity, dict) or identity.get("source") != "board_key"
            or not identity.get("userId")):
        raise WriterError("service timer requires a dedicated board API key")
    memberships = identity.get("memberships")
    memberships = memberships if isinstance(memberships, list) else []
    company_member = any(
        isinstance(membership, dict)
        and membership.get("companyId") == company_id
        and membership.get("status", "active") == "active"
        and membership.get("role") != "viewer"
        for membership in memberships
    )
    if not identity.get("isInstanceAdmin") and not company_member:
        raise WriterError("service board key lacks active write membership in the configured company")
    capability_probes = [
        ("company_issues", f"/api/companies/{company_id}/issues"),
        ("company_agents", f"/api/companies/{company_id}/agents"),
        ("issue", f"/api/issues/{issue_id}"),
        ("runs", f"/api/issues/{issue_id}/runs"),
        ("comments", f"/api/issues/{issue_id}/comments?order=desc&limit=1"),
        ("activity", f"/api/issues/{issue_id}/activity"),
        ("tree_control_state", f"/api/issues/{issue_id}/tree-control/state"),
        ("blocker_diagnostics", f"/api/issues/{issue_id}/diagnostics/blockers"),
        ("agent_manage_authority", f"/api/agents/{agent_id}/keys"),
        # The first auto-action re-reads the live agent and the company run
        # stream before every reset; the exact-run read is proven below
        # against a real run id from that stream.
        ("agent_read", f"/api/agents/{agent_id}"),
        ("heartbeat_runs", f"/api/companies/{company_id}/heartbeat-runs?limit=5"),
    ]
    checked = []
    stream: Any = None
    for name, path in capability_probes:
        result = client.get(path)
        if result is None:
            raise WriterError(f"service credential capability {name} returned no payload")
        checked.append(name)
        if name == "heartbeat_runs":
            stream = result
    # The single-run read seam needs a real run id, which no argument names.
    # Prove it against the newest run in the stream just probed. An empty
    # stream fails closed: the writer cannot prove its exact-run re-read
    # works there, so it refuses to install rather than silently skipping it.
    rows = stream if isinstance(stream, list) else (
        stream.get("runs") if isinstance(stream, dict) else None
    )
    rows = [row for row in rows or [] if isinstance(row, dict) and row.get("id")]
    if not rows:
        raise WriterError("service credential capability heartbeat_run_read: "
                          "run stream is empty; no run id to prove the exact-run read seam")
    first_id = rows[0].get("id")
    if client.get(f"/api/heartbeat-runs/{first_id}") is None:
        raise WriterError("service credential capability heartbeat_run_read returned no payload")
    checked.append("heartbeat_run_read")
    print(json.dumps({
        "type": "credential_preflight",
        "identity": "board_key",
        "status": "accepted",
        "userId": identity.get("userId"),
        "controlledIssueId": issue_id,
        "controlledAgentId": agent_id,
        "capabilities": checked,
        "unprobedWriteAuthorities": [
            "tasks:assign", "issue:update", "issue:comment",
            "tree_hold:create", "tree_hold:release",
            # First auto-action write: no side-effect-free probe exists, so
            # the first real reset stays fail-closed if the grant was
            # removed after installation.
            "agents:clear-error",
        ],
    }, sort_keys=True))
    return 0


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    if args.check_service_credential:
        return check_service_credential(
            PaperclipClient(args.api_url, args.api_key, None), args.company_id,
            args.preflight_issue_id, args.preflight_agent_id,
        )
    mode = "apply" if args.apply else "dry-run"
    proposals = load_proposals(args.proposals)
    client = (
        PaperclipClient(args.api_url, args.api_key, args.run_id)
        if args.apply else None
    )
    receipts: list[dict[str, Any]] = []
    print(json.dumps({"type": "cycle", "writer": WRITER_NAME,
                      "policyVersion": POLICY_VERSION, "mode": mode,
                      "proposals": len(proposals)}, sort_keys=True))
    applied = 0
    failed = 0
    for proposal in proposals:
        issue_id = str(proposal.get("issueId") or "")
        agent_targeted = str(proposal.get("mutation") or "none") == "reset_agent_error"
        live: dict[str, Any] = dict(proposal.get("live") or {})
        if agent_targeted and issue_id:
            # Agent-targeted resets name no board card and accept none: an
            # issue id here is a detector bug, and failing loudly keeps a
            # copy-pasted card proposal from resetting the wrong scope.
            record = {
                "type": "receipt", "writer": WRITER_NAME,
                "policyVersion": POLICY_VERSION, "mode": mode,
                "issueId": issue_id,
                "identifier": str(proposal.get("identifier") or "?"),
                "detector": str(proposal.get("detector") or "unknown"),
                "decision": "refused:undecidable",
                "note": "reset_agent_error is agent-targeted; issueId must be empty",
            }
            print(json.dumps(record, sort_keys=True))
            receipts.append(record)
            failed += 1
            continue
        if client is not None and issue_id:
            try:
                live = client.read_live(issue_id)
            except WriterError as error:
                record = {
                    "type": "receipt", "writer": WRITER_NAME,
                    "policyVersion": POLICY_VERSION, "mode": mode,
                    "issueId": issue_id,
                    "identifier": str(proposal.get("identifier") or "?"),
                    "detector": str(proposal.get("detector") or "unknown"),
                    "decision": "refused:live_unreadable",
                    "note": str(error),
                }
                print(json.dumps(record, sort_keys=True))
                receipts.append(record)
                failed += 1
                continue
        try:
            decision = decide(
                proposal, live, args.ceo_agent_id,
                args.owner_user_id, args.owner_agent_id,
            )
        except WriterError as error:
            record = {
                "type": "receipt", "writer": WRITER_NAME,
                "policyVersion": POLICY_VERSION, "mode": mode,
                "issueId": issue_id,
                "identifier": str(proposal.get("identifier") or "?"),
                "detector": str(proposal.get("detector") or "unknown"),
                "decision": "refused:undecidable",
                "note": str(error),
            }
            print(json.dumps(record, sort_keys=True))
            receipts.append(record)
            failed += 1
            continue
        print(json.dumps({"type": "proposal", **{
            k: v for k, v in decision.receipt(mode).items() if k != "type"
        }, "type": "proposal"}, sort_keys=True))
        apply_outcome: str | None = None
        if client is not None and decision.outcome == "decided":
            if applied >= args.max_repairs:
                apply_outcome = "rate_limited"
                limited = Decision(
                    decision.issue_id, decision.identifier, decision.detector,
                    "rate_limited", "none", decision.target_agent_id,
                    decision.source_id, decision.redirected, decision.before,
                    decision.before,
                    f"Repair cap {args.max_repairs} reached; left for the next bounded cycle.",
                    "rate_limited",
                )
                record = limited.receipt(mode, "rate_limited")
                print(json.dumps(record, sort_keys=True))
                receipts.append(record)
                continue
            try:
                result = apply_decision(client, decision)
                apply_outcome = result["outcome"]
                if result.get("wrote"):
                    applied += 1
                else:
                    failed += 1
            except WriterError as error:
                apply_outcome = f"failed:{error}"
                failed += 1
        elif client is None and decision.outcome == "decided":
            apply_outcome = "dry_run_held"
        else:
            # A refused proposal is the policy WORKING, not a failure: the
            # writer measured a trigger and correctly declined to write. Only
            # an undecidable or unreadable input fails a cycle, and those are
            # counted at their own sites above.
            apply_outcome = decision.outcome
        record = decision.receipt(mode, apply_outcome)
        print(json.dumps(record, sort_keys=True))
        receipts.append(record)
    if args.receipt_out:
        try:
            with open(args.receipt_out, "a", encoding="utf-8") as handle:
                for record in receipts:
                    handle.write(json.dumps(record, sort_keys=True) + "\n")
        except OSError as exc:
            raise WriterError(f"cannot append receipts to {args.receipt_out}: {exc}") from exc
    print(json.dumps({"type": "summary", "writer": WRITER_NAME,
                      "policyVersion": POLICY_VERSION, "mode": mode,
                      "proposals": len(proposals), "applied": applied,
                      "failed": failed}, sort_keys=True))
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, json.JSONDecodeError, WriterError) as error:
        print(f"recovery_writer.py: {error}", file=sys.stderr)
        raise SystemExit(2)
