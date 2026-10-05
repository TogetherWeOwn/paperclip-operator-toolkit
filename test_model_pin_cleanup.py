#!/usr/bin/env python3
# ===========================================================================
# test_model_pin_cleanup.py — offline tests for model_pin_cleanup.py
#
# These are written to FAIL a plausible-but-wrong implementation, not to
# confirm the one that exists. A suite that only feeds well-formed input
# validates the author's own dialect and nothing else — so every section below
# is either a shape the live API actually produced on 2026-10-02, or the
# specific shortcut a reimplementation would take.
#
# Deterministic: no network, no credentials, no clock reads. Fixture rows are
# inline so the suite survives the live board changing underneath it.
#
#   python3 ./test_model_pin_cleanup.py
# ===========================================================================
import datetime
import os
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "scripts"))

# The plugin actor id is instance-specific configuration, not a constant of
# the script: the module reads it from the environment at import, so the
# synthetic id below is set BEFORE the import.
PLUGIN = "00000000-0000-4000-8000-0000000000a1"
OTHER_PLUGIN = "00000000-0000-4000-8000-0000000000a2"
AGENT = "00000000-0000-4000-8000-0000000000b1"
os.environ["MODEL_SELECTION_PLUGIN_ACTOR_ID"] = PLUGIN

from model_pin_cleanup import (  # noqa: E402
    BACKUP_VERSION,
    FETCH_WORKERS_DEFAULT,
    FailureBudget,
    build_backup,
    build_plan,
    build_plan_row,
    card_live_reason,
    check_quiescence,
    classify_pin,
    current_pin_model,
    detect_new_wakes,
    fetch_card_feeds,
    is_plugin_row,
    parse_pin_decision,
    parse_time,
    plan_counts,
    plugin_write_model,
    recent_plugin_pin_writes,
    run_budgeted,
    unknown_plugin_pin_writes,
    select_probe_card,
    touches_overrides,
    verify_no_wake,
    wake_ids,
    CleanupError,
    SafetyRefusal,
    PLUGIN_ACTOR_ID,
    PLUGIN_ACTOR_ID_ENV,
)

NOW = datetime.datetime(2026, 10, 2, 16, 30, 0, tzinfo=datetime.timezone.utc)


def ts(minutes_ago):
    return (NOW - datetime.timedelta(minutes=minutes_ago)).strftime(
        "%Y-%m-%dT%H:%M:%S.000Z"
    )


def issue(identifier, iid="issue-1", status="blocked", model="claude-sonnet-5-5",
          run=None):
    row = {
        "id": iid,
        "identifier": identifier,
        "status": status,
        "executionRunId": run,
        "assigneeAdapterOverrides": {"adapterConfig": {"model": model}},
    }
    if model is None:
        row["assigneeAdapterOverrides"] = None
    return row


def decision_row(model, ago, from_model=None, actor=PLUGIN, advisory=False,
                 action=None):
    details = {"modelId": model}
    if from_model:
        details["from"] = from_model
    if advisory:
        details["advisory"] = True
        details["written"] = False
    return {
        "actorType": "plugin",
        "actorId": actor,
        "action": action or f"Model Selection pinned {model} (T1) on this issue",
        "entityType": "issue",
        "entityId": "issue-1",
        "createdAt": ts(ago),
        "details": details,
    }


def write_row(model, ago, actor=PLUGIN):
    return {
        "actorType": "plugin",
        "actorId": actor,
        "action": "issue.updated",
        "entityType": "issue",
        "entityId": "issue-1",
        "createdAt": ts(ago),
        "details": {
            "patch": {"assigneeAdapterOverrides": {"adapterConfig": {"model": model}}},
            "pluginKey": "togetherweown.model-selection",
        },
    }


def agent_write_row(ago, model="gpt-6-astra"):
    return {
        "actorType": "agent",
        "actorId": AGENT,
        "action": "issue.updated",
        "entityType": "issue",
        "entityId": "issue-1",
        "createdAt": ts(ago),
        "details": {
            "changes": {"assigneeAdapterOverrides": {"from": None, "to": {"model": model}}},
        },
    }


# --- §1: timestamp and row-shape parsing ------------------------------------

class ParseTest(unittest.TestCase):
    def test_zulu_and_offset_and_bare(self):
        self.assertIsNotNone(parse_time("2026-10-02T15:21:04.517Z"))
        self.assertIsNotNone(parse_time("2026-10-02T15:21:04+00:00"))
        self.assertIsNotNone(parse_time("2026-10-02T15:21:04"))

    def test_garbage_is_unknown_not_epoch(self):
        # An unparseable timestamp must read as UNKNOWN (skip-safe), never as
        # the epoch (which would make every comparison wrong in one direction).
        self.assertIsNone(parse_time(None))
        self.assertIsNone(parse_time(""))
        self.assertIsNone(parse_time("not-a-time"))
        self.assertIsNone(parse_time({"at": "2026-10-02"}))

    def test_plugin_identity_is_actor_id_not_type(self):
        self.assertTrue(is_plugin_row({"actorId": PLUGIN, "actorType": "agent"}))
        self.assertFalse(is_plugin_row({"actorId": AGENT, "actorType": "plugin"}))
        self.assertFalse(is_plugin_row({"actorType": "plugin"}))
        self.assertFalse(is_plugin_row(None))

    def test_empty_actor_id_matches_no_row(self):
        # No configured actor id must never degrade into "blank actor ids
        # are the plugin": every pin stays manual and nothing is touched.
        for blank in ("", None):
            with self.subTest(blank=blank):
                self.assertFalse(is_plugin_row({"actorId": blank}, ""))
                self.assertFalse(is_plugin_row({}, ""))
                self.assertFalse(is_plugin_row({"actorId": ""}, None))
                klass, reason, _ = classify_pin(
                    issue("ISSUE-60"),
                    [decision_row("claude-sonnet-5-5", 300, actor=blank),
                     write_row("claude-sonnet-5-5", 300, actor=blank)],
                    plugin_actor_id="")
                self.assertEqual((klass, reason), ("manual", "no-plugin-pin-row"))

    def test_plugin_actor_id_comes_from_the_environment(self):
        self.assertEqual(PLUGIN_ACTOR_ID_ENV, "MODEL_SELECTION_PLUGIN_ACTOR_ID")
        self.assertEqual(PLUGIN_ACTOR_ID, PLUGIN)

    def test_cli_refuses_without_a_plugin_actor_id(self):
        script = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              "scripts", "model_pin_cleanup.py")
        # No actor id and no Paperclip credentials: the actor-id check must
        # fire first, before any live client is built.
        cp = subprocess.run(
            [sys.executable, "-B", script, "--json"],
            capture_output=True, text=True, timeout=30,
            env={"PATH": os.environ.get("PATH", "")})
        self.assertEqual(cp.returncode, 2)
        self.assertIn(PLUGIN_ACTOR_ID_ENV, cp.stderr)
        self.assertEqual(cp.stdout, "")

    def test_current_pin_shapes(self):
        self.assertEqual(current_pin_model(issue("T", model="m-1")), "m-1")
        self.assertIsNone(current_pin_model(issue("T", model=None)))
        self.assertIsNone(current_pin_model({"id": "x"}))
        self.assertIsNone(current_pin_model(None))
        self.assertIsNone(current_pin_model({"assigneeAdapterOverrides": {"adapterConfig": {}}}))
        self.assertIsNone(current_pin_model({"assigneeAdapterOverrides": {"adapterConfig": {"model": 42}}}))


# --- §2: pin-decision parsing -------------------------------------------------
# The live feed carries FOUR decision shapes (creation pin, creation re-pin,
# label-only pin, repin pass) plus classification rows that share the
# "Model Selection ..." prefix. The mutation this section kills: parsing the
# message text, or accepting a row without details.modelId.

class DecisionParseTest(unittest.TestCase):
    def test_creation_pin(self):
        row = decision_row("muse-spark-1.3-contributor(xhigh)", 60, action=(
            "Model Selection pinned muse-spark-1.3-contributor(xhigh) (T2) "
            "at card creation (creating-post)"))
        got = parse_pin_decision(row)
        self.assertEqual(got["model"], "muse-spark-1.3-contributor(xhigh)")
        self.assertIsNone(got["from"])
        self.assertFalse(got["advisory"])

    def test_creation_repin_carries_from(self):
        row = decision_row("claude-opus-5", 50, from_model="claude-sonnet-5-5",
                           action="Model Selection re-pinned a -> b (T1) after classification, before the first run started (classified-repin)")
        got = parse_pin_decision(row)
        self.assertEqual((got["model"], got["from"]), ("claude-opus-5", "claude-sonnet-5-5"))

    def test_repin_pass_carries_from(self):
        row = decision_row("b", 40, from_model="a", action="Model Selection re-pinned a -> b (T1): pin expired, re-validated")
        self.assertEqual(parse_pin_decision(row)["from"], "a")

    def test_classification_row_is_not_a_decision(self):
        # Shares the prefix, carries tier but NO modelId: must not confer provenance.
        row = decision_row("x", 40, action="Model Selection classified this issue as T1 (confidence 0.99) at card creation")
        row["details"] = {"tier": "T1", "confidence": 0.99}
        self.assertIsNone(parse_pin_decision(row))

    def test_advisory_flag_survives(self):
        row = decision_row("m", 40, advisory=True)
        self.assertTrue(parse_pin_decision(row)["advisory"])

    def test_label_only_advisory_suffix_still_advisory(self):
        row = decision_row(
            "m", 40, advisory=True,
            action="Model Selection label-only pinned m (T1) from the existing tier label — advisory, nothing written")
        self.assertTrue(parse_pin_decision(row)["advisory"])

    def test_non_plugin_shape_rejected(self):
        self.assertIsNone(parse_pin_decision({"action": "issue.updated", "details": {}}))
        self.assertIsNone(parse_pin_decision({"action": "Model Selection pinned x", "details": "str"}))
        self.assertIsNone(parse_pin_decision(None))
        # A decision row for which the plugin recorded a null model is unknown, not auto.
        row = decision_row("m", 10)
        row["details"]["modelId"] = None
        self.assertIsNone(parse_pin_decision(row))


# --- §3: writer-row and non-plugin touch detection -----------------------------

class WriteShapeTest(unittest.TestCase):
    def test_plugin_write_model(self):
        self.assertEqual(plugin_write_model(write_row("m-1", 30)), "m-1")
        self.assertIsNone(plugin_write_model(write_row("m-1", 30, actor=AGENT)))

    def test_label_write_is_not_a_pin_write(self):
        row = write_row("m-1", 30)
        row["details"]["patch"] = {"labelIds": ["abc"]}
        self.assertIsNone(plugin_write_model(row))

    def test_touches_overrides_both_shapes(self):
        self.assertTrue(touches_overrides({"patch": {"assigneeAdapterOverrides": None}}))
        self.assertTrue(touches_overrides({"changes": {"assigneeAdapterOverrides": {}}}))
        self.assertFalse(touches_overrides({"patch": {"labelIds": []}}))
        self.assertFalse(touches_overrides({"changes": {"status": {}}}))
        self.assertFalse(touches_overrides(None))
        self.assertFalse(touches_overrides("str"))


# --- §4: classification — the hostile core -------------------------------------
# Every case here is a live shape or the exact shortcut that would ship a
# wrong verdict: value-allowlisting, latest-row-wins without the override
# check, ignoring advisory rows, or trusting prose.

class ClassifyTest(unittest.TestCase):
    def test_clean_auto(self):
        card = issue("ISSUE-1")
        rows = [decision_row("claude-sonnet-5-5", 300), write_row("claude-sonnet-5-5", 300)]
        klass, reason, recorded = classify_pin(card, rows)
        self.assertEqual((klass, recorded), ("auto", "claude-sonnet-5-5"))

    def test_repin_to_haiku_matches_current(self):
        card = issue("ISSUE-2", model="muse-spark-1.3-contributor(xhigh)")
        rows = [decision_row("muse-spark-1.3-contributor(xhigh)", 100,
                             from_model="claude-sonnet-5-5")]
        klass, _, _ = classify_pin(card, rows)
        self.assertEqual(klass, "auto")

    def test_repin_matches_from_model(self):
        # Card re-pinned a->b but the current pin is still a (write landed
        # elsewhere): the from-model match keeps it auto for later cleanup.
        card = issue("ISSUE-2b", model="claude-sonnet-5-5")
        rows = [decision_row("muse-spark-1.3-contributor(xhigh)", 100,
                             from_model="claude-sonnet-5-5"),
                write_row("muse-spark-1.3-contributor(xhigh)", 100)]
        klass, _, _ = classify_pin(card, rows)
        self.assertEqual(klass, "auto")

    def test_manual_cto_pin_no_plugin_rows(self):
        card = issue("ISSUE-12", model="gpt-6-astra")
        rows = [decision_row("T1-only", 500, action="Model Selection classified this issue as T1")]
        klass, reason, _ = classify_pin(card, rows)
        self.assertEqual(klass, "manual")
        self.assertEqual(reason, "no-plugin-pin-row")

    def test_later_agent_override_write_wins(self):
        card = issue("ISSUE-3", model="gpt-6-astra")
        rows = [decision_row("claude-sonnet-5-5", 300),
                write_row("claude-sonnet-5-5", 300),
                agent_write_row(10, model="gpt-6-astra")]
        klass, reason, _ = classify_pin(card, rows)
        self.assertEqual((klass, reason), ("manual", "later-non-plugin-override-write"))

    def test_earlier_agent_write_does_not_taint(self):
        card = issue("ISSUE-3b")
        rows = [agent_write_row(500),
                decision_row("claude-sonnet-5-5", 300),
                write_row("claude-sonnet-5-5", 300)]
        self.assertEqual(classify_pin(card, rows)[0], "auto")

    def test_same_instant_tie_fails_closed(self):
        # A non-plugin override write stamped at the SAME instant as the
        # latest plugin row cannot be ordered after it: fail closed (manual).
        stamp = ts(300)
        rows = [decision_row("claude-sonnet-5-5", 300),
                write_row("claude-sonnet-5-5", 300)]
        rows[0]["createdAt"] = stamp
        rows[1]["createdAt"] = stamp
        agent_row = agent_write_row(300)
        agent_row["createdAt"] = stamp
        card = issue("ISSUE-3c", model="gpt-6-astra")
        klass, reason, _ = classify_pin(card, rows + [agent_row])
        self.assertEqual((klass, reason), ("manual", "later-non-plugin-override-write"))

    def test_unknown_timestamp_human_write_fails_closed(self):
        # A non-plugin override write with an unparseable
        # createdAt cannot be ordered against the plugin rows, so it is
        # manual EVEN when it carries the same model as the plugin pin.
        # Without the fail-closed flag this classifies auto (fail-open).
        card = issue("ISSUE-3d")
        rows = [decision_row("claude-sonnet-5-5", 300),
                write_row("claude-sonnet-5-5", 300)]
        human = agent_write_row(300, model="claude-sonnet-5-5")
        human["createdAt"] = "not-a-time"
        klass, reason, _ = classify_pin(card, rows + [human])
        self.assertEqual((klass, reason),
                         ("manual", "non-plugin-override-write-unknown-order"))

    def test_unknown_timestamp_plugin_decision_ignored_but_write_counts(self):
        # A plugin DECISION row with no timestamp cannot anchor provenance,
        # but the timestamped plugin WRITE row still can (fail-closed only
        # governs what cannot be ordered, not what can).
        card = issue("ISSUE-3e")
        undecided = decision_row("claude-sonnet-5-5", 300)
        undecided["createdAt"] = "not-a-time"
        rows = [undecided, write_row("claude-sonnet-5-5", 300)]
        self.assertEqual(classify_pin(card, rows)[0], "auto")

    def test_model_mismatch_is_manual(self):
        # A human changed the pin to a model the plugin never recorded.
        card = issue("ISSUE-4", model="gpt-6-astra")
        rows = [decision_row("claude-sonnet-5-5", 300),
                write_row("claude-sonnet-5-5", 300)]
        klass, reason, _ = classify_pin(card, rows)
        self.assertEqual((klass, reason), ("manual", "pin-model-mismatch"))

    def test_advisory_only_rows_confer_nothing(self):
        # Advisory rows recorded decisions but wrote NOTHING. A card carrying
        # a pin with only advisory rows must be manual: someone else wrote it.
        card = issue("ISSUE-5")
        rows = [decision_row("claude-sonnet-5-5", 300, advisory=True)]
        klass, reason, _ = classify_pin(card, rows)
        self.assertEqual((klass, reason), ("manual", "no-plugin-pin-row"))

    def test_advisory_then_real_write_is_auto(self):
        card = issue("ISSUE-5b")
        rows = [decision_row("claude-sonnet-5-5", 400, advisory=True),
                decision_row("claude-sonnet-5-5", 300),
                write_row("claude-sonnet-5-5", 300)]
        self.assertEqual(classify_pin(card, rows)[0], "auto")

    def test_unparseable_activity_is_manual(self):
        card = issue("ISSUE-6")
        self.assertEqual(classify_pin(card, None)[0], "manual")
        self.assertEqual(classify_pin(card, "rows")[0], "manual")
        self.assertEqual(classify_pin(card, [])[0], "manual")

    def test_no_pin_is_manual(self):
        self.assertEqual(classify_pin(issue("T", model=None), [])[0], "manual")

    def test_other_plugin_actor_is_not_provenance(self):
        card = issue("ISSUE-7")
        rows = [decision_row("claude-sonnet-5-5", 100, actor=OTHER_PLUGIN),
                write_row("claude-sonnet-5-5", 100, actor=OTHER_PLUGIN)]
        klass, _, _ = classify_pin(card, rows)
        self.assertEqual(klass, "manual")

    def test_custom_actor_id_override_respected(self):
        card = issue("ISSUE-7b")
        rows = [decision_row("claude-sonnet-5-5", 100, actor=OTHER_PLUGIN),
                write_row("claude-sonnet-5-5", 100, actor=OTHER_PLUGIN)]
        self.assertEqual(classify_pin(card, rows, plugin_actor_id=OTHER_PLUGIN)[0], "auto")

    def test_decision_without_write_row_still_auto(self):
        # Decision rows are first-class provenance: the write row may have
        # aged out of a bounded feed while the decision row survives.
        card = issue("ISSUE-8")
        self.assertEqual(classify_pin(card, [decision_row("claude-sonnet-5-5", 100)])[0], "auto")

    def test_write_without_decision_row_still_auto(self):
        card = issue("ISSUE-8b")
        self.assertEqual(classify_pin(card, [write_row("claude-sonnet-5-5", 100)])[0], "auto")


# --- §5: liveness skips ---------------------------------------------------------

class LiveTest(unittest.TestCase):
    def test_execution_run_id_skips(self):
        card = issue("T", run="run-1")
        self.assertEqual(card_live_reason(card, []), "live-execution-run")

    def test_in_progress_running_run_skips(self):
        card = issue("T", status="in_progress")
        runs = [{"runId": "r", "status": "running", "startedAt": ts(5), "finishedAt": None}]
        self.assertEqual(card_live_reason(card, runs), "assignee-running-run")

    def test_in_progress_queued_run_skips(self):
        card = issue("T", status="in_progress")
        self.assertEqual(card_live_reason(card, [{"status": "queued"}]), "assignee-running-run")

    def test_blocked_with_old_runs_proceeds(self):
        card = issue("T", status="blocked")
        runs = [{"status": "succeeded"}, {"status": "failed"}]
        self.assertIsNone(card_live_reason(card, runs))

    def test_in_progress_all_finished_proceeds(self):
        card = issue("T", status="in_progress")
        self.assertIsNone(card_live_reason(card, [{"status": "succeeded"}]))

    def test_unknown_shape_skips_safe(self):
        self.assertIsNotNone(card_live_reason(None, []))
        self.assertIsNotNone(card_live_reason("x", []))


# --- §6: plan building, counts, backup -------------------------------------------

class PlanTest(unittest.TestCase):
    def _cards(self):
        auto = issue("ISSUE-A", iid="a", status="blocked")
        manual = issue("ISSUE-M", iid="m", status="blocked", model="gpt-6-astra")
        live = issue("ISSUE-L", iid="l", status="blocked", run="run-9")
        unpinned = issue("ISSUE-U", iid="u", status="blocked", model=None)
        busy = issue("ISSUE-B", iid="b", status="in_progress")
        return [auto, manual, live, unpinned, busy]

    def _feeds(self):
        pin = [decision_row("claude-sonnet-5-5", 300), write_row("claude-sonnet-5-5", 300)]
        return {
            "a": list(pin),
            "m": [],
            "l": list(pin),
            "b": list(pin),
        }

    def test_plan_rows(self):
        cards = self._cards()
        plan = build_plan(cards, self._feeds(),
                          {"b": [{"status": "running"}]}, PLUGIN)
        by_id = {r["id"]: r for r in plan}
        self.assertEqual(len(plan), 4)  # unpinned card absent
        self.assertTrue(by_id["a"]["candidate"])
        self.assertFalse(by_id["m"]["candidate"])
        self.assertEqual(by_id["l"]["skip"], "live-execution-run")
        self.assertFalse(by_id["l"]["candidate"])
        self.assertEqual(by_id["b"]["skip"], "assignee-running-run")

    def test_counts(self):
        cards = self._cards()
        plan = build_plan(cards, self._feeds(), {"b": [{"status": "running"}]}, PLUGIN)
        counts = plan_counts(plan)
        self.assertEqual(counts, {
            "pinned": 4, "auto": 3, "manual": 1, "candidates": 1,
            "skipped_live": 2,
            "by_model": {"claude-sonnet-5-5": 3, "gpt-6-astra": 1},
            "by_reason": {
                "auto:plugin-provenance": 3,
                "manual:no-plugin-pin-row": 1,
            },
        })

    def test_backup_holds_full_overrides_for_candidates_only(self):
        cards = self._cards()
        cards[0]["assigneeAdapterOverrides"] = {
            "adapterConfig": {"model": "claude-sonnet-5-5",
                              "env": {"K": {"type": "plain", "value": "v"}}}}
        plan = build_plan(cards, self._feeds(), {"b": [{"status": "running"}]}, PLUGIN)
        backup = build_backup(plan, cards, "stamp")
        self.assertEqual(backup["version"], BACKUP_VERSION)
        self.assertEqual(len(backup["entries"]), 1)
        entry = backup["entries"][0]
        self.assertEqual(entry["id"], "a")
        self.assertEqual(entry["overrides"]["adapterConfig"]["env"]["K"]["value"], "v")
        # Backup is a deep copy: later mutation of the card must not move it.
        cards[0]["assigneeAdapterOverrides"]["adapterConfig"]["model"] = "MUT"
        self.assertEqual(entry["overrides"]["adapterConfig"]["model"], "claude-sonnet-5-5")


# --- §7: quiescence gate -----------------------------------------------------------
# The gate this section kills: "no recent rows on THIS card" (the writer is
# fleet-wide — per-card quiet proves nothing), and "empty feed means quiet".

class FakeClient:
    def __init__(self, pages):
        self.pages = pages

    def scan_company_activity(self, limit=200, max_pages=50):
        for page in self.pages:
            yield page


class QuiescenceTest(unittest.TestCase):
    def test_recent_write_refuses(self):
        client = FakeClient([[write_row("m", 5), decision_row("m", 400)]])
        with self.assertRaises(SafetyRefusal):
            check_quiescence(client, 20, PLUGIN, NOW)

    def test_boundary_write_refuses(self):
        client = FakeClient([[write_row("m", 20)]])
        with self.assertRaises(SafetyRefusal):
            check_quiescence(client, 20, PLUGIN, NOW)

    def test_old_write_passes(self):
        page = [write_row("m", 60), decision_row("m", 400)]
        self.assertEqual(check_quiescence(FakeClient([page]), 20, PLUGIN, NOW), 2)

    def test_decision_only_is_not_a_write(self):
        # Advisory/label decisions without an override write must not trip the
        # gate. The old row closes the page at the window boundary so the gate
        # can trust the stop (a page that ends inside the window refuses —
        # see test_truncated_feed_refuses).
        page = [decision_row("m", 5), decision_row("m", 400)]
        self.assertEqual(check_quiescence(FakeClient([page]), 20, PLUGIN, NOW), 2)

    def test_empty_feed_refuses(self):
        with self.assertRaises(Exception):
            check_quiescence(FakeClient([[]]), 20, PLUGIN, NOW)

    def test_truncated_feed_refuses(self):
        # A single page newer than the window never reaches the boundary:
        # it measured nothing about the window edge, so it refuses.
        with self.assertRaises(Exception):
            check_quiescence(FakeClient([[decision_row("m", 5)]]), 20, PLUGIN, NOW)

    def test_other_actor_write_passes(self):
        page = [write_row("m", 5, actor=AGENT), write_row("m", 60)]
        self.assertEqual(check_quiescence(FakeClient([page]), 20, PLUGIN, NOW), 2)

    def test_recent_plugin_pin_writes_order_independent(self):
        since = NOW - datetime.timedelta(minutes=20)
        rows = [write_row("m", 5), write_row("m", 60)]
        self.assertEqual(len(recent_plugin_pin_writes(list(reversed(rows)), since)), 1)

    def test_timestamp_free_plugin_write_refuses_gate(self):
        # Same fail-closed principle at fleet scope: a
        # plugin pin-write row with an unparseable timestamp can be neither
        # placed inside nor outside the window, so the gate refuses instead
        # of reading the page as quiet.
        timeless = write_row("m", 60)
        timeless["createdAt"] = "not-a-time"
        page = [timeless, write_row("m", 400)]
        with self.assertRaises(SafetyRefusal):
            check_quiescence(FakeClient([page]), 20, PLUGIN, NOW)

    def test_unknown_plugin_writes_helper(self):
        timeless = write_row("m", 60)
        timeless["createdAt"] = "not-a-time"
        rows = [timeless, write_row("m", 400), decision_row("m", 5),
                write_row("m", 5, actor=AGENT)]
        found = unknown_plugin_pin_writes(rows)
        self.assertEqual(len(found), 1)
        self.assertIs(found[0], timeless)
        self.assertEqual(unknown_plugin_pin_writes([]), [])
        self.assertEqual(unknown_plugin_pin_writes(None), [])


# --- §8: wake-id comparison ----------------------------------------------------------

class WakeTest(unittest.TestCase):
    def test_stable_ids(self):
        diag = {"events": [
            {"kind": "wake_request", "runId": "r1", "requestedAt": "t1"},
            {"kind": "other", "requestedAt": "t2"},
        ]}
        ids = wake_ids(diag)
        self.assertEqual(len(ids), 2)
        self.assertEqual(wake_ids({"events": []}), set())
        self.assertEqual(wake_ids({}), set())
        self.assertEqual(wake_ids(None), set())
        # Same run re-reported with a new timestamp is the same wake.
        again = {"events": [{"kind": "wake_request", "runId": "r1", "requestedAt": "t9"}]}
        self.assertTrue(wake_ids(again) <= ids)


# --- §9: failure budget, wake diff, probe selection -------------------------------
# The mutants this section kills: a budget that never resets on success
# (one isolated fault aborts the fleet), a probe that fires on re-reported
# rows (counts instead of identities), and probe selection that falls back to
# a non-blocked card instead of refusing.

class BudgetTest(unittest.TestCase):
    def test_two_consecutive_trips(self):
        budget = FailureBudget(2)
        self.assertFalse(budget.record_failure())
        self.assertTrue(budget.record_failure())

    def test_success_resets_the_streak(self):
        budget = FailureBudget(2)
        self.assertFalse(budget.record_failure())
        self.assertFalse(budget.record_success())
        self.assertFalse(budget.record_failure())
        self.assertTrue(budget.record_failure())

    def test_budget_one_trips_immediately(self):
        self.assertTrue(FailureBudget(1).record_failure())

    def test_zero_budget_refuses(self):
        with self.assertRaises(ValueError):
            FailureBudget(0)


class WakeDiffTest(unittest.TestCase):
    def test_rereported_row_is_not_new(self):
        before = {("wake_request", "r1")}
        after = {("wake_request", "r1")}
        self.assertEqual(detect_new_wakes(before, after), set())

    def test_genuinely_new_row_detected(self):
        before = {("wake_request", "r1")}
        after = {("wake_request", "r1"), ("wake_request", "r2")}
        self.assertEqual(detect_new_wakes(before, after), {("wake_request", "r2")})

    def test_empty_and_none_safe(self):
        self.assertEqual(detect_new_wakes(set(), set()), set())
        self.assertEqual(detect_new_wakes(None, None), set())
        self.assertEqual(detect_new_wakes(None, {("a", "b")}), {("a", "b")})


class ProbeSelectTest(unittest.TestCase):
    def _live(self):
        return {
            "a": {"id": "a", "identifier": "TOG-A", "status": "in_progress"},
            "b": {"id": "b", "identifier": "TOG-B", "status": "blocked"},
            "c": {"id": "c", "identifier": "TOG-C", "status": "blocked"},
        }

    def test_first_blocked_wins(self):
        ordered = [{"id": "a"}, {"id": "b"}, {"id": "c"}]
        self.assertEqual(select_probe_card(ordered, self._live())["id"], "b")

    def test_no_blocked_refuses(self):
        with self.assertRaises(SafetyRefusal):
            select_probe_card([{"id": "a"}], self._live())

    def test_unknown_ids_refuse(self):
        with self.assertRaises(SafetyRefusal):
            select_probe_card([{"id": "zzz"}], self._live())


# --- §10: budgeted runner and no-wake probe -----------------------------------------
# The mutant this section kills: a second per-mode loop whose reset wiring is
# NOT covered (the --apply loop was tested, the --restore copy was not — so
# both modes now share run_budgeted and this tests the shared runner itself).

class FakeClearClient:
    """Fake PaperclipClient surface for verify_no_wake and run_budgeted."""

    def __init__(self, fail_ids=(), wakes_after=None):
        self.fail_ids = set(fail_ids)
        self.wakes_after = wakes_after
        self.cleared = []
        self.patches = []

    def wake_diagnostics(self, issue_id):
        if self.wakes_after is None:
            return {"events": [{"kind": "wake_request", "runId": "r1"}]}
        if not hasattr(self, "_probed"):
            self._probed = True
            return {"events": []}
        return {"events": self.wakes_after}

    def patch(self, path, body):
        self.patches.append((path, body))
        issue_id = path.rsplit("/", 1)[-1]
        if issue_id in self.fail_ids:
            raise CleanupError(f"PATCH issue {issue_id} failed: HTTP 500")
        if body.get("assigneeAdapterOverrides") is None:
            self.cleared.append(issue_id)
            return {"id": issue_id, "assigneeAdapterOverrides": None}
        model = (body["assigneeAdapterOverrides"].get("adapterConfig") or {}).get("model")
        return {"id": issue_id,
                "assigneeAdapterOverrides": {"adapterConfig": {"model": model}}}


def budgeted_clear(client):
    def attempt(entry):
        from model_pin_cleanup import clear_pin
        clear_pin(client, entry["id"])
    return attempt


class RunBudgetedTest(unittest.TestCase):
    def test_all_success(self):
        client = FakeClearClient()
        entries = [{"id": "a", "identifier": "A"}, {"id": "b", "identifier": "B"}]
        results = run_budgeted(entries, budgeted_clear(client), "CLEAR")
        self.assertTrue(all(r["cleared"] for r in results))
        self.assertEqual(client.cleared, ["a", "b"])

    def test_isolated_failure_does_not_abort(self):
        client = FakeClearClient(fail_ids={"b"})
        entries = [{"id": f"i{i}", "identifier": f"I{i}"} for i in range(4)]
        entries[1]["id"] = "b"
        results = run_budgeted(entries, budgeted_clear(client), "CLEAR")
        # fail, success, success, success: the streak resets, no abort.
        self.assertEqual([r["cleared"] for r in results], [True, False, True, True])
        self.assertEqual(client.cleared, [entries[0]["id"], entries[2]["id"], entries[3]["id"]])

    def test_two_consecutive_abort_with_partial_results(self):
        client = FakeClearClient(fail_ids={"a", "b"})
        entries = [{"id": "a", "identifier": "A"}, {"id": "b", "identifier": "B"},
                   {"id": "c", "identifier": "C"}]
        with self.assertRaises(SafetyRefusal) as ctx:
            run_budgeted(entries, budgeted_clear(client), "CLEAR")
        self.assertEqual(len(ctx.exception.partial_results), 2)
        # The third entry was never attempted.
        self.assertEqual(client.cleared, [])

    def test_success_after_failure_still_counts(self):
        client = FakeClearClient(fail_ids={"a"})
        entries = [{"id": "a", "identifier": "A"}, {"id": "b", "identifier": "B"},
                   {"id": "c", "identifier": "C"}]
        results = run_budgeted(entries, budgeted_clear(client), "CLEAR")
        self.assertEqual([r["cleared"] for r in results], [False, True, True])

    def test_success_between_failures_prevents_abort(self):
        # fail, success, fail: the streak resets in the middle, so the run
        # completes all three. Without the reset the third entry trips the
        # budget and aborts — this is the case that kills a dropped reset.
        client = FakeClearClient(fail_ids={"a", "c"})
        entries = [{"id": "a", "identifier": "A"}, {"id": "b", "identifier": "B"},
                   {"id": "c", "identifier": "C"}]
        results = run_budgeted(entries, budgeted_clear(client), "CLEAR")
        self.assertEqual([r["cleared"] for r in results], [False, True, False])

    def test_uncleared_write_counts_as_failure(self):
        # The server 200s but keeps the overrides: clear_pin raises, so the
        # runner must count it (a mutant that checks only HTTP status sails on).
        class LyingClient(FakeClearClient):
            def patch(self, path, body):
                self.patches.append((path, body))
                return {"id": "x", "assigneeAdapterOverrides": {"adapterConfig": {"model": "m"}}}

        entries = [{"id": "x", "identifier": "X"}, {"id": "y", "identifier": "Y"}]
        with self.assertRaises(SafetyRefusal):
            run_budgeted(entries, budgeted_clear(LyingClient()), "CLEAR")


class NoWakeProbeTest(unittest.TestCase):
    def test_quiet_clear_passes(self):
        import model_pin_cleanup as mpc
        old_sleep = mpc.NO_WAKE_SETTLE_SECONDS
        mpc.NO_WAKE_SETTLE_SECONDS = 0
        try:
            client = FakeClearClient(wakes_after=[])
            record = verify_no_wake(client, {"id": "a", "identifier": "TOG-A"})
        finally:
            mpc.NO_WAKE_SETTLE_SECONDS = old_sleep
        self.assertEqual(record["result"], "no-new-wake")
        self.assertEqual(client.cleared, ["a"])

    def test_new_wake_aborts(self):
        import model_pin_cleanup as mpc
        old_sleep = mpc.NO_WAKE_SETTLE_SECONDS
        mpc.NO_WAKE_SETTLE_SECONDS = 0
        try:
            client = FakeClearClient(
                wakes_after=[{"kind": "wake_request", "runId": "r-new"}])
            with self.assertRaises(SafetyRefusal):
                verify_no_wake(client, {"id": "a", "identifier": "TOG-A"})
        finally:
            mpc.NO_WAKE_SETTLE_SECONDS = old_sleep

    def test_unreadable_diagnostics_abort(self):
        class BlindClient(FakeClearClient):
            def wake_diagnostics(self, issue_id):
                raise CleanupError("HTTP 403")

        import model_pin_cleanup as mpc
        old_sleep = mpc.NO_WAKE_SETTLE_SECONDS
        mpc.NO_WAKE_SETTLE_SECONDS = 0
        try:
            with self.assertRaises(SafetyRefusal):
                verify_no_wake(BlindClient(), {"id": "a", "identifier": "TOG-A"})
        finally:
            mpc.NO_WAKE_SETTLE_SECONDS = old_sleep


# --- §11: bounded concurrent fetch path -------------------------------------------
# The mutants this section kills: a fetch path that classifies from a guessed
# feed (failure swallowed into an empty list), an unbounded pool, a progress
# callback that fires on the wrong count, and a progress row whose class
# differs from the final plan row.

class FakeFeedClient:
    """Fake list/issues/activity/runs surface for fetch_card_feeds."""

    def __init__(self, cards, activity, runs, fail_ids=()):
        self._cards = cards
        self._activity = activity
        self._runs = runs
        self._fail_ids = set(fail_ids)
        self.max_in_flight = 0
        self._in_flight = 0
        self._lock = __import__("threading").Lock()

    def list_all_issues(self):
        return self._cards

    def issue_activity(self, issue_id):
        return self._read("a", issue_id)

    def issue_runs(self, issue_id):
        return self._read("r", issue_id)

    def _read(self, _kind, issue_id):
        with self._lock:
            self._in_flight += 1
            self.max_in_flight = max(self.max_in_flight, self._in_flight)
        try:
            if issue_id in self._fail_ids:
                raise CleanupError(f"GET issue {issue_id} failed: HTTP 500")
            store = self._activity if _kind == "a" else self._runs
            return list(store.get(issue_id, []))
        finally:
            with self._lock:
                self._in_flight -= 1


class FetchPathTest(unittest.TestCase):
    def _two_cards(self):
        auto = issue("ISSUE-A", iid="a", status="blocked")
        manual = issue("ISSUE-M", iid="m", status="blocked", model="gpt-6-astra")
        pin = [decision_row("claude-sonnet-5-5", 300),
               write_row("claude-sonnet-5-5", 300)]
        return ([auto, manual], {"a": list(pin), "m": []}, {"a": [], "m": []})

    def test_fetch_returns_both_feeds(self):
        cards, activity, runs = self._two_cards()
        got_a, got_r = fetch_card_feeds(
            FakeFeedClient(cards, activity, runs), cards, PLUGIN,
            workers=2, progress=lambda *a: None)
        self.assertEqual(got_a, activity)
        self.assertEqual(got_r, runs)

    def test_progress_row_matches_final_plan_row(self):
        cards, activity, runs = self._two_cards()
        seen = []
        fetch_card_feeds(FakeFeedClient(cards, activity, runs), cards, PLUGIN,
                         workers=2, progress=lambda d, t, row: seen.append((d, t, row)))
        self.assertEqual([d for d, _, _ in seen], [1, 2])
        self.assertTrue(all(t == 2 for _, t, _ in seen))
        plan = build_plan(cards, activity, runs, PLUGIN)
        by_id = {r["id"]: r for r in plan}
        for _, _, row in seen:
            self.assertEqual(row, by_id[row["id"]])

    def test_per_card_failure_raises_not_guesses(self):
        cards, activity, runs = self._two_cards()
        with self.assertRaises(CleanupError):
            fetch_card_feeds(FakeFeedClient(cards, activity, runs, fail_ids={"a"}),
                             cards, PLUGIN, workers=2, progress=lambda *a: None)

    def test_zero_workers_refuses(self):
        cards, activity, runs = self._two_cards()
        with self.assertRaises(CleanupError):
            fetch_card_feeds(FakeFeedClient(cards, activity, runs), cards, PLUGIN,
                             workers=0, progress=lambda *a: None)

    def test_pool_is_bounded(self):
        cards = [issue(f"TOG-{i}", iid=f"id-{i}") for i in range(12)]
        activity = {f"id-{i}": [] for i in range(12)}
        runs = {f"id-{i}": [] for i in range(12)}
        client = FakeFeedClient(cards, activity, runs)
        fetch_card_feeds(client, cards, PLUGIN, workers=3,
                         progress=lambda *a: None)
        self.assertLessEqual(client.max_in_flight, 3)

    def test_empty_pin_list_needs_no_calls(self):
        got_a, got_r = fetch_card_feeds(
            FakeFeedClient([], {}, {}), [], PLUGIN,
            progress=lambda *a: None)
        self.assertEqual((got_a, got_r), ({}, {}))

    def test_default_worker_count_is_bounded(self):
        self.assertGreaterEqual(FETCH_WORKERS_DEFAULT, 1)
        self.assertLessEqual(FETCH_WORKERS_DEFAULT, 16)

    def test_build_plan_row_none_for_unpinned(self):
        self.assertIsNone(build_plan_row(issue("T", model=None), [], []))
        self.assertIsNone(build_plan_row(None, [], []))


if __name__ == "__main__":
    unittest.main(verbosity=2)
