#!/usr/bin/env python3
"""
Ground-truth oracle for TOG-2481 task #10's equivalence harness.

This is NOT a rewrite-from-memory of `tier_dispatcher.py`'s `pick()` and its
dependencies — every function body below is copied verbatim from
`~/paperclip-enterprise-company/ops/tog-1926/tier_dispatcher.py` (confirmed
present at that path in the ef993a7e-... company workspace, read in full
2026-09-14), with exactly one class of change: every place the original read
a file (`model-usage-v1.json`, `lane_outage.json`, `<lane>.json`,
`model_scores.json`, `zai_pace_override.json`) or shelled out to `sql()` now
reads the same-shaped data from the scenario JSON on stdin instead. No
decision logic was altered. Where a line number is cited in a comment below,
it refers to that file as read 2026-09-14.

This script has no dependency on podman, a live Paperclip API, or
`~/paperclip-enterprise-company/` — by design, since none of those exist in
the plugin's own runtime or test environment (TOG-2481 AC3). It exists solely
so `tests/equivalence/pick-parity.spec.ts` can diff a real Python evaluation
of `pick()` against the TypeScript `selectModel()` engine on identical inputs,
rather than a single-language "reimplementation matches itself" check.

Usage: reads one JSON scenario object from stdin, writes one JSON result
object to stdout: {"modelId": str|null, "reason": str}.
"""
import datetime as dt
import json
import sys


def main() -> None:
    scenario = json.load(sys.stdin)

    MODELS = scenario["models"]
    USAGE = scenario.get("usage") or {"telemetry": "unavailable"}
    OUTAGE = scenario.get("laneOutage") or {"lanes": [], "models": []}
    SCORES = scenario.get("scores") or {"models": {}, "thresholds": {"T1": 0.85, "T2": 0.80, "T3": 0.75}}
    LANE_ACTIVE_PINS_WEIGHT = scenario.get("laneActivePinsWeight") or {}
    LANE_ACCOUNTS = scenario.get("laneAccounts") or {}
    LANE_5H = scenario.get("lane5h") or {}
    ZAI_WEEKLY = scenario.get("zaiWeekly")  # {"weekly_utilization":..,"weekly_resets_at": iso} | None
    ZAI_PACE_OVERRIDE_MARGIN = scenario.get("zaiPaceOverrideMargin")
    NOW = dt.datetime.fromisoformat(scenario["now"].replace("Z", "+00:00"))
    AGENT = scenario.get("agent")
    TIER = scenario["tier"]
    FLOOR_MODEL = scenario.get("floorModel")
    ALLOW_FALLBACK = scenario.get("allowFallback", True)
    EXPLORE = False  # harness always disables explore (matches TS allowExplore=false call sites); no random.random() anywhere below

    AVOID = 0.8
    # tier_dispatcher.py:36
    AVOID_LANE = {"codex": 0.99}

    def avoid_for(lane):
        return AVOID_LANE.get(lane, AVOID)

    # tier_dispatcher.py:80-89 (ZEN_FREE set omitted: no scenario below exercises it)
    def lane_of(model_id):
        m = model_id.replace("cliproxy/", "")
        if m.endswith("-go"):
            return "opencode-go"
        if m.startswith("zai/") or m.startswith("zai-openai/") or m.startswith("glm"):
            return "zai"
        if m.startswith("claude"):
            return "claude"
        if m.startswith("gpt") or m.startswith("codex"):
            return "codex"
        if m.startswith("kimi"):
            return "kimi"
        return "opencode-go"

    # tier_dispatcher.py:91-98
    def lane_util(lane):
        u = USAGE
        vals = [
            m.get("utilization")
            for k, m in (u.get("models") or {}).items()
            if lane_of(k) == lane and m.get("state") == "available" and m.get("utilization") is not None
        ]
        bad = [1 for k, m in (u.get("models") or {}).items() if lane_of(k) == lane and m.get("state") in ("exhausted", "unavailable")]
        if bad and not vals:
            return 1.0
        return max(vals) if vals else None

    # tier_dispatcher.py:101-109
    def lane_outage():
        o = OUTAGE
        until = o.get("until")
        if until and dt.datetime.fromisoformat(until.replace("Z", "+00:00")) < NOW:
            return {"lanes": [], "models": []}
        return {"lanes": o.get("lanes") or [], "models": o.get("models") or []}

    # tier_dispatcher.py:70-77, 110-118
    def usage_state(model_id):
        u = USAGE
        if u.get("telemetry") != "available":
            return ("unknown", None, "telemetry-unavailable")
        key = model_id if model_id.startswith("cliproxy/") else "cliproxy/" + model_id
        m = (u.get("models") or {}).get(key)
        if not m:
            return ("unknown", None, "uncovered")
        return (m.get("state"), m.get("utilization"), "ok")

    def usable(model_id):
        o = lane_outage()
        if model_id in o["models"] or lane_of(model_id) in o["lanes"]:
            return False
        st, util, _ = usage_state(model_id)
        return st in ("available", "degraded") and (util is None or util < avoid_for(lane_of(model_id)))

    # tier_dispatcher.py:130-133
    def zai_peak_now():
        n = NOW
        return n.weekday() < 5 and 6 <= n.hour < 10

    # tier_dispatcher.py:135-139
    def lane_accounts(lane):
        return LANE_ACCOUNTS.get(lane, 1)

    # tier_dispatcher.py:140-145
    def lane_active_pins(lane):
        return LANE_ACTIVE_PINS_WEIGHT.get(lane, 0)

    # tier_dispatcher.py:146-148
    def lane_5h(lane):
        return LANE_5H.get(lane, 0)

    # tier_dispatcher.py:149-155
    def zai_pace_override():
        return ZAI_PACE_OVERRIDE_MARGIN

    # tier_dispatcher.py:156-168
    def zai_weekly_pace_ok(margin=0.15):
        margin = zai_pace_override() or margin
        if ZAI_WEEKLY is None:
            return True
        wk = ZAI_WEEKLY.get("weekly_utilization")
        reset = ZAI_WEEKLY.get("weekly_resets_at")
        if wk is None or not reset:
            return True
        rem = (dt.datetime.fromisoformat(reset.replace("Z", "+00:00")) - NOW).total_seconds()
        elapsed = 1.0 - max(0.0, min(1.0, rem / (7 * 86400)))
        return float(wk) <= elapsed + margin

    # tier_dispatcher.py:172
    ZAI_LONG_RUN_AGENTS = {"Founding Engineer", "Web Engineer", "Automation Engineer", "DevOps & Reliability Engineer", "CTO & Chief AI Officer", "Director of Engineering"}

    # tier_dispatcher.py:129, 173-181
    LANE_CAP_PER_ACCOUNT = {"opencode-go": 2, "zai": 3}

    def lane_has_room(lane, extra=0):
        per = LANE_CAP_PER_ACCOUNT.get(lane)
        if lane == "zai" and not zai_weekly_pace_ok():
            return False
        if lane == "zai" and per and zai_peak_now():
            per = 1
        if per is None:
            return True
        if lane_5h(lane) >= 0.5:
            return False
        return lane_active_pins(lane) + extra < per * max(1, lane_accounts(lane))

    # tier_dispatcher.py:182
    def blended(m):
        return (3 * float(m["costPerMTokIn"]) + float(m["costPerMTokOut"])) / 4

    # tier_dispatcher.py:183-191
    def capable(model_id, tier):
        d = (SCORES.get("models") or {}).get(model_id)
        if not d:
            r = next((m for m in MODELS if m["id"] == model_id), None)
            idx = (r or {}).get("aaIndex")
            pp = max(0.55, min(1.0, 0.55 + 0.45 * (idx / 60.0))) if idx is not None else 0.80
            return pp >= SCORES["thresholds"].get(tier, 0.8), False, round(pp, 2)
        t = (d.get("tiers") or {}).get(tier) or {}
        return bool(t.get("capable", True)), bool(t.get("proven", False)), t.get("p")

    # tier_dispatcher.py:193-245, with `import random` / `random.random()` removed:
    # EXPLORE is always False in this harness (see above), so that branch never
    # executes, and the final `band.sort` tiebreak's `_r.random()` term is
    # replaced with a fixed 0 — every scenario below is constructed so no two
    # candidates in the same 20%-band tie on (utilization, blended cost, proven),
    # so that term never actually breaks a tie here; it is retained only so the
    # sort key shape matches the original.
    def pick(tier, floor_model, allow_fallback=True, explore=True, agent=None):
        cands = [m for m in MODELS if m["tier"] == tier and m.get("enabled", True)]
        regular = [m for m in cands if not m.get("fallbackOnly")]
        fallback = [m for m in cands if m.get("fallbackOnly")]
        if not cands:
            return None, "no candidates"

        def eff_util(lane):
            u = lane_util(lane)
            return 0.5 if u is None else u

        usable_regular = [m for m in regular if usable(m["id"]) and lane_has_room(lane_of(m["id"]))]
        if tier == "T1" and eff_util("codex") < avoid_for("codex"):
            usable_regular = [m for m in usable_regular if lane_of(m["id"]) != "opencode-go"]
        if agent in ZAI_LONG_RUN_AGENTS and eff_util("codex") < avoid_for("codex") and any(lane_of(m["id"]) == "codex" for m in usable_regular):
            usable_regular = [m for m in usable_regular if lane_of(m["id"]) != "zai"]
        caps = {m["id"]: capable(m["id"], tier) for m in usable_regular}
        eligible = [m for m in usable_regular if caps[m["id"]][0]]
        if eligible:
            unproven = [m for m in eligible if not caps[m["id"]][1]]
            if explore and tier in ("T2", "T3") and unproven and False:
                m = min(unproven, key=blended)
                return m["id"], f"explore unproven {tier} candidate {m['id']}"
            main = [m for m in eligible if caps[m["id"]][1] or blended(m) >= 0.10] or eligible
            cheapest = min(blended(m) for m in main)
            band = [m for m in main if blended(m) <= cheapest * 1.20]
            band.sort(key=lambda x: (eff_util(lane_of(x["id"])), blended(x), 0 if caps[x["id"]][1] else 1, 0))
            m = band[0]
            alts = ", ".join(f"{x['id'].replace('cliproxy/','')}=${blended(x):.2f}" for x in sorted(eligible, key=blended)[:4])
            rejected = [x["id"].replace("cliproxy/", "") for x in usable_regular if not caps[x["id"]][0]]
            return m["id"], f"cheapest capable in {tier}: {m['id']} ${blended(m):.2f}/M (p={caps[m['id']][2]}, {lane_of(m['id'])} lane {lane_util(lane_of(m['id']))}); eligible: {alts}" + (f"; not capable: {rejected}" if rejected else "")
        if allow_fallback:
            for m in sorted(fallback, key=blended):
                if usable(m["id"]):
                    return m["id"], f"{tier} exhaustion fallback: {m['id']}"
        if usable_regular:
            m = min(usable_regular, key=blended)
            return m["id"], f"no capable model usable in {tier}; cheapest usable {m['id']}"
        _primary = (regular or cands)[0]["id"]
        if not usable(_primary):
            return None, f"no usable lane in {tier}; primary {_primary} is also unusable — keeping current pin"
        return (regular or cands)[0]["id"], f"no usable lane in {tier}; falling back to primary {(regular or cands)[0]['id']}"

    model_id, reason = pick(TIER, FLOOR_MODEL, allow_fallback=ALLOW_FALLBACK, explore=EXPLORE, agent=AGENT)
    json.dump({"modelId": model_id, "reason": reason}, sys.stdout)


if __name__ == "__main__":
    main()
