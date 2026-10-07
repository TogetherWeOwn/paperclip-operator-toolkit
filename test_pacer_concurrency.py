#!/usr/bin/env python3
# ===========================================================================
# test_pacer_concurrency.py — hostile tests for the pacer concurrency
# reconciler
#
# Written to FAIL a plausible-but-wrong implementation, not to confirm the
# one that exists:
#
# * §2 kills the averaging mutant: a reconciler that means lane headroom
#   across an agent's lanes lets claude-lane-1's comfort hide claude-lane-2's
#   burn and keeps agent-mixed put. Only worst-wins moves it down.
# * §3 kills the dead-hysteresis mutant: thresholds that compare against a
#   constant instead of the measured ratio, or a missing dead band, flip
#   agent-behind down or hold it. The band edges are pinned from both sides.
# * §4 kills the blind-scale mutant: unknown/stale/missing lane data must
#   hold the target, never guess. A reconciler that treats "no data" as
#   "healthy" moves agent-stale up and this goes red.
# * §5 kills the flap mutant: a second decision inside the cooldown that
#   re-moves the target. agent-cool's hold is the only case that sees it.
# * §6 kills the ceiling/floor mutants: scale-up past the operator cap, or
#   any target below 1, or a cap that silently clamps instead of refusing.
# * §1/§5/§6 also pin the review fixes: a thin window retries at ITS reset,
#   the --state shape is exactly what plan records emit, and an agent above
#   its ceiling steps down by one instead of jumping under a scale-up reason.
# * §8 kills the quiet-enforce mutant: enforce-mode output without --yes, or
#   a shadow plan carrying patch intents. Directives must be asked for.
# * §9 kills the cancel mutant: any cancel/kill/terminate/disable key in the
#   schema. The reconciler slows work via maxConcurrentRuns; it never ends
#   a run, and the vocabulary must not grow one.
# * §10 kills the swapped-agreement mutant: coverage counted from allows,
#   or garbage audit lines crashing the report.
#
# Deterministic: every case pins --now explicitly. No network, no clock read,
# no write outside temp dirs (and --out atomicity is tested there too).
# ===========================================================================
import copy
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, "pacer_concurrency.py")
FIX = os.path.join(HERE, "tests", "fixtures", "pacer-concurrency")
NOW = "2026-10-04T12:00:00Z"


def run_plan(*args):
    cp = subprocess.run(
        [sys.executable, TOOL, "--now", NOW, *args],
        capture_output=True, text=True)
    return cp


def plan_obj(*args):
    cp = run_plan(*args)
    assert cp.returncode == 0, "exit %d: %s" % (cp.returncode, cp.stderr)
    return json.loads(cp.stdout)


def single_plan(lane_row, runs=2, baseline=4, cap=None, state=None,
                now=None, extra=()):
    """Plan one agent on one lane row; return the whole plan."""
    agents = {"agents": [{
        "id": "e", "name": "edge-agent", "lanes": ["edge"],
        "maxConcurrentRuns": runs, "baseline": baseline, "status": "idle"}]}
    lanes = {"observedAt": NOW, "lanes": [dict(lane_row, lane="edge")]}
    with tempfile.TemporaryDirectory() as d:
        ap = os.path.join(d, "agents.json")
        lp = os.path.join(d, "lanes.json")
        with open(ap, "w") as f:
            json.dump(agents, f)
        with open(lp, "w") as f:
            json.dump(lanes, f)
        args = ["--lanes", lp, "--agents", ap]
        if cap is not None:
            cpath = os.path.join(d, "caps.json")
            with open(cpath, "w") as f:
                json.dump({"caps": {"edge-agent": cap}}, f)
            args += ["--caps", cpath]
        if state is not None:
            spath = os.path.join(d, "state.json")
            with open(spath, "w") as f:
                json.dump(state, f)
            args += ["--state", spath]
        if now is not None:
            args += ["--now", now]
        return plan_obj(*args, *extra)


def single_agent(lane_row, **kw):
    """Plan one agent on one lane row; return that agent's decision."""
    return single_plan(lane_row, **kw)["agents"][0]


def agents_by_name(plan):
    return {a["name"]: a for a in plan["agents"]}


class ConcurrencyPlanTest(unittest.TestCase):
    def base(self, *extra):
        return plan_obj("--lanes", os.path.join(FIX, "lanes.json"),
                        "--agents", os.path.join(FIX, "agents.json"), *extra)

    # -- §1  shape ---------------------------------------------------------
    def test_01_plan_carries_mode_effect_and_summary(self):
        plan = self.base()
        self.assertEqual(plan["mode"], "shadow")
        self.assertEqual(plan["effect"], "none")
        self.assertEqual(plan["now"], NOW)
        self.assertEqual(plan["summary"]["agents"], 8)
        self.assertIn("lanes", plan)
        self.assertEqual(len(plan["lanes"]), 4)

    def test_01_admission_advisory_present_per_lane(self):
        plan = self.base()
        by_lane = {l["lane"]: l for l in plan["lanes"]}
        self.assertEqual(by_lane["claude-lane-1"]["admission"]["verdict"], "admit")
        stale = by_lane["meta-lane-4"]
        self.assertEqual(stale["admission"]["verdict"], "hold")
        self.assertGreater(stale["admission"]["retryAfterS"], 0)

    def test_01_weekly_thin_hold_retries_at_the_weekly_reset(self):
        # Weekly headroom 0.05 holds until the WEEKLY window rolls (3.5 days
        # out), not at the five-hour reset 2.5 hours away. 0.15 headroom is
        # over the floor and admits.
        base = {"weeklyResetUtc": "2026-10-08T00:00:00Z",
                "fiveHourUtilization": 0.2,
                "fiveHourResetUtc": "2026-10-04T14:30:00Z",
                "observationQuality": "live"}
        thin = single_plan(dict(base, weeklyUtilization=0.95))["lanes"][0]
        self.assertEqual(thin["admission"]["verdict"], "hold")
        self.assertIn("weekly headroom", thin["admission"]["reasons"][0])
        self.assertEqual(thin["admission"]["retryAfterS"], 302400)
        ok = single_plan(dict(base, weeklyUtilization=0.85))["lanes"][0]
        self.assertEqual(ok["admission"]["verdict"], "admit")

    def test_01_five_hour_thin_hold_retries_at_the_five_hour_reset(self):
        base = {"weeklyUtilization": 0.30,
                "weeklyResetUtc": "2026-10-08T00:00:00Z",
                "fiveHourUtilization": 0.90,
                "fiveHourResetUtc": "2026-10-04T14:30:00Z",
                "observationQuality": "live"}
        lane = single_plan(base)["lanes"][0]
        self.assertEqual(lane["admission"]["verdict"], "hold")
        self.assertEqual(lane["admission"]["retryAfterS"], 9000)

    def test_01_both_windows_thin_waits_for_the_later_reset(self):
        lane = single_plan({"weeklyUtilization": 0.95,
                            "weeklyResetUtc": "2026-10-08T00:00:00Z",
                            "fiveHourUtilization": 0.90,
                            "fiveHourResetUtc": "2026-10-04T14:30:00Z",
                            "observationQuality": "live"})["lanes"][0]
        self.assertEqual(len(lane["admission"]["reasons"]), 2)
        self.assertEqual(lane["admission"]["retryAfterS"], 302400)

    # -- §2  worst wins, never the mean ------------------------------------
    def test_02_behind_pace_scales_up_one_step(self):
        a = agents_by_name(self.base())["agent-behind"]
        self.assertEqual(a["action"], "up")
        self.assertEqual((a["from"], a["target"]), (2, 3))
        self.assertAlmostEqual(a["paceRatio"], 0.6, places=2)

    def test_02_ahead_of_pace_scales_down_one_step(self):
        a = agents_by_name(self.base())["agent-ahead"]
        self.assertEqual(a["action"], "down")
        self.assertEqual((a["from"], a["target"]), (3, 2))
        self.assertAlmostEqual(a["paceRatio"], 1.4, places=2)

    def test_02_mixed_lanes_follow_the_worst(self):
        # Kills the averaging mutant: mean(0.6, 1.4) = 1.0 sits inside the
        # dead band and would hold; worst-wins moves down.
        a = agents_by_name(self.base())["agent-mixed"]
        self.assertEqual(a["action"], "down")
        self.assertEqual(a["target"], 1)
        self.assertAlmostEqual(a["paceRatio"], 1.4, places=2)

    def test_02_critical_keeps_floor_1(self):
        a = agents_by_name(self.base())["agent-crit"]
        self.assertEqual(a["action"], "down")
        self.assertEqual(a["target"], 1)
        self.assertTrue(a["critical"])

    # -- §3  hysteresis dead band ------------------------------------------
    def test_03_band_edges_hold(self):
        # Boundaries are inclusive: ratio <= 0.85 moves up, >= 1.15 moves
        # down, strictly inside holds. Elapsed is 0.5 in the fixture, so
        # util/0.5 is the ratio: 0.42->0.84 up, 0.43->0.86 hold,
        # 0.57->1.14 hold, 0.58->1.16 down. A dead-band mutant that compares
        # with the wrong operator fails at least one of these four.
        import tempfile
        agents = {"agents": [{
            "id": "e", "name": "edge-agent", "lanes": ["edge"],
            "maxConcurrentRuns": 2, "baseline": 4, "status": "idle"}]}
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(agents, f)
            ap = f.name
        try:
            for util, want in ((0.42, "up"), (0.43, "nochange"),
                               (0.57, "nochange"), (0.58, "down")):
                lanes = {"observedAt": NOW, "lanes": [{
                    "lane": "edge", "weeklyUtilization": util,
                    "weeklyResetUtc": "2026-10-08T00:00:00Z",
                    "observationQuality": "live"}]}
                with tempfile.NamedTemporaryFile("w", suffix=".json",
                                                  delete=False) as f:
                    json.dump(lanes, f)
                    lp = f.name
                try:
                    plan = plan_obj("--lanes", lp, "--agents", ap)
                    self.assertEqual(plan["agents"][0]["action"], want,
                                     "util %r" % util)
                finally:
                    os.unlink(lp)
        finally:
            os.unlink(ap)

    def test_03_exact_band_edges_are_inclusive(self):
        # Elapsed is exactly 0.5, so util/0.5 is exact in binary floating
        # point: 0.425 -> 0.85 and 0.575 -> 1.15 land ON the thresholds.
        # A strict comparison on either edge holds instead of moving.
        weekly = {"weeklyResetUtc": "2026-10-08T00:00:00Z",
                  "observationQuality": "live"}
        up = single_agent(dict(weekly, weeklyUtilization=0.425))
        self.assertEqual(up["action"], "up")
        self.assertEqual(up["paceRatio"], 0.85)
        down = single_agent(dict(weekly, weeklyUtilization=0.575))
        self.assertEqual(down["action"], "down")
        self.assertEqual(down["paceRatio"], 1.15)

    def test_03_five_hour_headroom_gates_scale_up(self):
        # Weekly pace is behind (0.84) in all three rows. The five-hour
        # window is early (under 5% elapsed), so it contributes headroom but
        # no pace vote. Plenty of headroom scales up; headroom inside the
        # dead band holds; thin headroom scales DOWN despite the weekly
        # slack. A reconciler that ignores the five-hour window scales up
        # in all three.
        row = {"weeklyUtilization": 0.42,
               "weeklyResetUtc": "2026-10-08T00:00:00Z",
               "fiveHourResetUtc": "2026-10-04T16:50:00Z",
               "observationQuality": "live"}
        for five_hour_util, want in ((0.5, "up"), (0.75, "nochange"),
                                     (0.9, "down")):
            a = single_agent(dict(row, fiveHourUtilization=five_hour_util))
            self.assertEqual(a["action"], want,
                             "five-hour util %r" % five_hour_util)

    # -- §4  unmeasured means unmoved --------------------------------------
    def test_04_stale_lane_holds_not_scales(self):
        a = agents_by_name(self.base())["agent-stale"]
        self.assertEqual(a["action"], "nochange")
        self.assertFalse(a["measured"])
        self.assertIn("cached", a["reason"])

    def test_04_missing_lane_holds(self):
        a = agents_by_name(self.base())["agent-unmapped"]
        self.assertEqual(a["action"], "nochange")
        self.assertFalse(a["measured"])

    def test_04_paused_agent_skips(self):
        a = agents_by_name(self.base())["agent-paused"]
        self.assertEqual(a["action"], "skip")

    def test_04_empty_lanes_is_exit_5_not_empty_plan(self):
        import tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump({"lanes": []}, f)
            lp = f.name
        try:
            cp = run_plan("--lanes", lp, "--agents",
                          os.path.join(FIX, "agents.json"))
            self.assertEqual(cp.returncode, 5)
        finally:
            os.unlink(lp)

    # -- §5  dwell / cooldown ------------------------------------------------
    def test_05_move_inside_cooldown_holds(self):
        plan = self.base("--state", os.path.join(FIX, "state.json"))
        a = agents_by_name(plan)["agent-cool"]
        self.assertEqual(a["action"], "nochange")
        self.assertIn("cooldown", a["reason"])
        self.assertEqual(a["target"], 2)

    def test_05_negative_cooldown_refuses(self):
        cp = run_plan("--lanes", os.path.join(FIX, "lanes.json"),
                      "--agents", os.path.join(FIX, "agents.json"),
                      "--cooldown-min", "-1")
        self.assertEqual(cp.returncode, 2)

    def test_05_cooldown_edge_is_exclusive(self):
        # The last target was 3, so a computed move down to 2 revisits it.
        # 29m59s into a 30m dwell holds; exactly 30m has served it and moves.
        ahead = {"weeklyUtilization": 0.58,
                 "weeklyResetUtc": "2026-10-08T00:00:00Z",
                 "observationQuality": "live"}
        held = single_agent(ahead, runs=3, state={"agents": {"e": {
            "target": 3, "decidedAt": "2026-10-04T11:30:01Z"}}})
        self.assertEqual(held["action"], "nochange")
        self.assertIn("cooldown-hold", held["reason"])
        self.assertEqual(held["target"], 3)
        moved = single_agent(ahead, runs=3, state={"agents": {"e": {
            "target": 3, "decidedAt": "2026-10-04T11:30:00Z"}}})
        self.assertEqual(moved["action"], "down")
        self.assertEqual(moved["target"], 2)

    def test_05_plan_records_feed_the_state_file_shape(self):
        # The documented persistence recipe: for each up/down record the
        # applier wrote, store {agents: {<agentId>: {target, decidedAt}}}.
        # Following it verbatim must make the next run's cooldown bite.
        behind = {"weeklyUtilization": 0.42,
                  "weeklyResetUtc": "2026-10-08T00:00:00Z",
                  "observationQuality": "live"}
        ahead = {"weeklyUtilization": 0.58,
                 "weeklyResetUtc": "2026-10-08T00:00:00Z",
                 "observationQuality": "live"}
        first = single_plan(behind, runs=2, baseline=4)["agents"][0]
        self.assertEqual(first["action"], "up")
        self.assertEqual(first["decidedAt"], NOW)
        state = {"agents": {first["agentId"]: {
            "target": first["target"], "decidedAt": first["decidedAt"]}}}
        later = single_agent(ahead, runs=first["target"], baseline=4,
                             state=state, now="2026-10-04T12:10:00Z")
        self.assertEqual(later["action"], "nochange")
        self.assertIn("cooldown-hold", later["reason"])
        self.assertEqual(later["target"], 3)
        past = single_agent(ahead, runs=first["target"], baseline=4,
                            state=state, now="2026-10-04T12:31:00Z")
        self.assertEqual(past["action"], "down")
        self.assertEqual(past["decidedAt"], "2026-10-04T12:31:00Z")

    def test_05_holds_and_skips_carry_no_decided_at(self):
        plan = self.base()
        for a in plan["agents"]:
            if a["action"] in ("nochange", "skip"):
                self.assertNotIn("decidedAt", a, a["name"])
            else:
                self.assertEqual(a["decidedAt"], NOW, a["name"])

    # -- §6  ceilings and floors --------------------------------------------
    def test_06_operator_cap_is_a_ceiling_not_a_hint(self):
        plan = self.base("--caps", os.path.join(FIX, "caps.json"))
        a = agents_by_name(plan)["agent-behind"]
        self.assertEqual(a["action"], "nochange")
        self.assertIn("ceiling 2", a["reason"])

    def test_06_insane_cap_refuses(self):
        import tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump({"caps": {"agent-behind": 64}}, f)
            cp_ = f.name
        try:
            cp = run_plan("--lanes", os.path.join(FIX, "lanes.json"),
                          "--agents", os.path.join(FIX, "agents.json"),
                          "--caps", cp_)
            self.assertEqual(cp.returncode, 2)
        finally:
            os.unlink(cp_)

    def test_06_above_baseline_ceiling_steps_down_by_one(self):
        # 6 runs allowed, baseline 3, no cap, well behind pace. Scaling up is
        # impossible; the old code jumped 6 -> 3 under a "scale up" reason.
        # The rule is +-1 per decision, so it walks back one step and says so.
        behind = {"weeklyUtilization": 0.20,
                  "weeklyResetUtc": "2026-10-08T00:00:00Z",
                  "observationQuality": "live"}
        a = single_agent(behind, runs=6, baseline=3)
        self.assertEqual(a["action"], "down")
        self.assertEqual((a["from"], a["target"]), (6, 5))
        self.assertIn("above ceiling 3", a["reason"])
        self.assertNotIn("scale up", a["reason"])

    def test_06_above_operator_cap_steps_down_by_one(self):
        behind = {"weeklyUtilization": 0.20,
                  "weeklyResetUtc": "2026-10-08T00:00:00Z",
                  "observationQuality": "live"}
        a = single_agent(behind, runs=6, baseline=6, cap=3,
                         extra=("--mode", "enforce", "--yes"))
        self.assertEqual((a["action"], a["from"], a["target"]),
                         ("down", 6, 5))
        self.assertEqual(a["patchIntent"]["runtimeConfig"]["heartbeat"]
                         ["maxConcurrentRuns"], 5)

    def test_06_at_the_ceiling_still_holds(self):
        behind = {"weeklyUtilization": 0.20,
                  "weeklyResetUtc": "2026-10-08T00:00:00Z",
                  "observationQuality": "live"}
        a = single_agent(behind, runs=3, baseline=3)
        self.assertEqual(a["action"], "nochange")
        self.assertIn("already at ceiling 3", a["reason"])

    def test_06_no_target_below_1(self):
        plan = self.base()
        for a in plan["agents"]:
            if isinstance(a.get("target"), int):
                self.assertGreaterEqual(a["target"], 1, a["name"])

    def test_06_floor_holds_for_a_single_run_agent(self):
        # Ahead of pace with one run allowed: the step down would land on 0.
        a = single_agent({"weeklyUtilization": 0.58,
                          "weeklyResetUtc": "2026-10-08T00:00:00Z",
                          "observationQuality": "live"}, runs=1, baseline=1)
        self.assertEqual(a["action"], "nochange")
        self.assertEqual(a["target"], 1)
        self.assertIn("floor", a["reason"])

    # -- §7  kill switch ------------------------------------------------------
    def test_07_frozen_lane_forces_nochange(self):
        plan = self.base("--frozen-lanes", "claude-lane-2")
        for name in ("agent-ahead", "agent-crit", "agent-mixed"):
            a = agents_by_name(plan)[name]
            self.assertEqual(a["action"], "nochange")
            self.assertIn("frozen", a["reason"])
        # ...while an unfrozen agent still moves.
        self.assertEqual(agents_by_name(plan)["agent-behind"]["action"], "up")

    def test_07_frozen_unknown_lane_refuses(self):
        cp = run_plan("--lanes", os.path.join(FIX, "lanes.json"),
                      "--agents", os.path.join(FIX, "agents.json"),
                      "--frozen-lanes", "no-such-lane")
        self.assertEqual(cp.returncode, 2)

    # -- §8  enforce gating ----------------------------------------------------
    def test_08_enforce_without_yes_refuses(self):
        cp = run_plan("--lanes", os.path.join(FIX, "lanes.json"),
                      "--agents", os.path.join(FIX, "agents.json"),
                      "--mode", "enforce")
        self.assertEqual(cp.returncode, 2)

    def test_08_enforce_with_yes_emits_directives_and_intents(self):
        plan = self.base("--mode", "enforce", "--yes")
        self.assertEqual(plan["effect"], "directive")
        up = agents_by_name(plan)["agent-behind"]
        self.assertEqual(up["effect"], "directive")
        self.assertEqual(up["patchIntent"]["runtimeConfig"]["heartbeat"]
                         ["maxConcurrentRuns"], 3)
        held = agents_by_name(plan)["agent-stale"]
        self.assertEqual(held["effect"], "none")
        self.assertNotIn("patchIntent", held)

    def test_08_shadow_carries_no_patch_intents(self):
        plan = self.base()
        blob = json.dumps(plan)
        self.assertNotIn("patchIntent", blob)

    def test_08_rollback_needs_enforce_yes(self):
        cp = run_plan("--lanes", os.path.join(FIX, "lanes.json"),
                      "--agents", os.path.join(FIX, "agents.json"),
                      "--rollback")
        self.assertEqual(cp.returncode, 2)
        plan = self.base("--mode", "enforce", "--yes", "--rollback")
        self.assertEqual(plan["mode"], "rollback")
        restores = [r for r in plan["agents"] if r["action"] == "restore"]
        self.assertTrue(restores)

    def test_08_rollback_without_yes_refuses_even_in_enforce(self):
        cp = run_plan("--lanes", os.path.join(FIX, "lanes.json"),
                      "--agents", os.path.join(FIX, "agents.json"),
                      "--mode", "enforce", "--rollback")
        self.assertEqual(cp.returncode, 2)
        self.assertEqual(cp.stdout.strip(), "")

    # -- §9  no-cancellation vocabulary ----------------------------------------
    def test_09_schema_has_no_kill_keys(self):
        for args in ((), ("--mode", "enforce", "--yes"),
                     ("--mode", "enforce", "--yes", "--rollback")):
            plan = self.base(*args)
            blob = json.dumps(plan).lower()
            for forbidden in ("cancel", "kill", "terminate", "disable",
                              "wakeondemand", "dailyrun", "daily_run"):
                self.assertNotIn(forbidden, blob)

    def test_09_source_has_no_board_write(self):
        with open(TOOL, encoding="utf-8") as fh:
            code = fh.read()
        for coupling in ("urllib", "requests", "curl", "PAPERCLIP_ADMIN_TOKEN",
                         "Bearer ", "/api/agents"):
            self.assertNotIn(coupling, code)

    # -- §10  agreement report --------------------------------------------------
    def test_10_covered_and_uncovered_events(self):
        cp = run_plan("--audit", os.path.join(FIX, "audit.jsonl"),
                      "--events", os.path.join(FIX, "events.json"))
        self.assertEqual(cp.returncode, 0, cp.stderr)
        rep = json.loads(cp.stdout)
        self.assertEqual(rep["events"], 2)
        self.assertEqual(rep["covered"], 1)
        self.assertEqual(rep["uncovered"], 1)
        self.assertAlmostEqual(rep["coverage"], 0.5)
        self.assertEqual(rep["uncoveredEvents"][0]["lane"], "codex-lane-9")

    def test_10_needs_both_audit_and_events(self):
        cp = run_plan("--audit", os.path.join(FIX, "audit.jsonl"))
        self.assertEqual(cp.returncode, 2)

    # -- §11  validation ---------------------------------------------------------
    def test_11_out_of_range_util_refuses(self):
        lanes = {"observedAt": NOW, "lanes": [{
            "lane": "bad", "weeklyUtilization": 1.5,
            "weeklyResetUtc": "2026-10-08T00:00:00Z",
            "observationQuality": "live"}]}
        import tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(lanes, f)
            lp = f.name
        try:
            cp = run_plan("--lanes", lp, "--agents",
                          os.path.join(FIX, "agents.json"))
            self.assertEqual(cp.returncode, 2)
        finally:
            os.unlink(lp)

    def test_11_duplicate_lane_refuses(self):
        lanes = {"observedAt": NOW, "lanes": [
            {"lane": "d", "weeklyUtilization": 0.1,
             "weeklyResetUtc": "2026-10-08T00:00:00Z",
             "observationQuality": "live"},
            {"lane": "d", "weeklyUtilization": 0.2,
             "weeklyResetUtc": "2026-10-08T00:00:00Z",
             "observationQuality": "live"}]}
        agents = {"agents": []}
        import tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(lanes, f)
            lp = f.name
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(agents, f)
            ap = f.name
        try:
            cp = run_plan("--lanes", lp, "--agents", ap)
            self.assertEqual(cp.returncode, 2)
        finally:
            os.unlink(lp)
            os.unlink(ap)


if __name__ == "__main__":
    unittest.main(verbosity=2)
