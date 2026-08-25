#!/usr/bin/env python3
"""
TOG-207 — assemble results.json and run G10.

Two jobs:

  1. Emit the machine-readable per-arm result TOG-207 asks for, so child 4 does not have
     to re-parse logs: requested combo strategy, requested account strategy, BOTH
     read-backs, G2 coverage %, per-connection call counts, per-provider call counts, 429
     count, and the arm window timestamps.

  2. G10 -- the degeneracy detector. If two arms produce per-connection distributions
     within noise, they are ONE BEHAVIOUR and must be reported as one, not as adjacent
     ranks. From source we EXPECT A1 == B2 == B3 (all resolve to static priority order:
     auth.ts sends fill-first to the trailing else -> orderedConnections[0]; headroom and
     reset-window both degrade to static order against a null quota). If A1 and B2 do NOT
     land in one cluster, that CONTRADICTS the source read and is itself the finding --
     it is reported as such, not smoothed over.

Runnable standalone, which matters: per-connection counts are management-side, so the
normal workflow is (a) run the harness, (b) run the g7-*.sql, (c) drop the results into
conn-<arm>.tsv, (d) re-run this to get a full-strength G10.

  ./TOG-207-assemble.py <outdir> > results.json

conn-<arm>.tsv format (tab separated, no header): connection_id, account_label, calls
"""
import json, math, os, sys


def read_jsonl(path):
    out = []
    if not os.path.exists(path):
        return out
    for line in open(path):
        line = line.strip()
        if line:
            try:
                out.append(json.loads(line))
            except Exception:
                pass
    return out


def load_conn_tsv(outdir, arm):
    p = os.path.join(outdir, "conn-%s.tsv" % arm)
    if not os.path.exists(p):
        return None
    counts = {}
    for line in open(p):
        parts = line.rstrip("\n").split("\t")
        if len(parts) >= 3 and parts[2].strip().isdigit():
            counts[(parts[1].strip() or parts[0].strip())] = int(parts[2])
    return counts or None


# ── G10 machinery ────────────────────────────────────────────────────────────
def two_proportion_z(k1, n1, k2, n2):
    """Pooled two-proportion z. Returns None when it is not defined -- an arm with no
    successful requests is not 'the same as' another arm, it is unmeasured, and returning
    0 there would silently merge them."""
    if n1 <= 0 or n2 <= 0:
        return None
    p1, p2 = k1 / n1, k2 / n2
    p = (k1 + k2) / (n1 + n2)
    se = math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2))
    if se == 0:
        # Both arms identical and degenerate (0% or 100% in both). Genuinely the same
        # observed behaviour, so z=0 is the right answer here rather than undefined.
        return 0.0
    return (p1 - p2) / se


def mde(n, p=0.5, alpha=1.96, power_z=0.84):
    """Minimum detectable difference in share for n per arm, two-sided 5%, 80% power.
    Reported because 'within noise' is meaningless without saying how wide the noise is:
    at n=40 the test cannot separate a 50/50 rotation from a 65/35 lean, so a clean
    cluster is partly a statement about sample size."""
    if n <= 0:
        return None
    return round((alpha + power_z) * math.sqrt(2 * p * (1 - p) / n), 3)


def arm_vector(arm, basis):
    """Reduce an arm to (successes, trials) on the chosen basis."""
    if basis == "per-connection":
        conn = arm.get("perConnection") or {}
        if not conn:
            return None
        # Share of the lexicographically-first connection label. Two connections is the
        # designed case; with more, this collapses to first-vs-rest and the collapse is
        # recorded in the output rather than hidden.
        labels = sorted(conn)
        k = conn[labels[0]]
        n = sum(conn.values())
        return (k, n, labels)
    pp = arm.get("perProvider") or {}
    k = pp.get("opencode-go", 0)
    n = k + pp.get("openrouter", 0) + pp.get("other", 0)
    return (k, n, ["opencode-go", "not-opencode-go"])


def run_g10(arms):
    usable = [a for a in arms if a.get("setOk")]
    basis = "per-connection" if usable and all(a.get("perConnection") for a in usable) else "provider-level"

    vectors, skipped = {}, []
    for a in usable:
        v = arm_vector(a, basis)
        if v is None or v[1] <= 0:
            skipped.append(a["arm"])
            continue
        vectors[a["arm"]] = v

    names = sorted(vectors)
    pairs, same = [], {}
    for i, x in enumerate(names):
        for y in names[i + 1:]:
            k1, n1, _ = vectors[x]
            k2, n2, _ = vectors[y]
            z = two_proportion_z(k1, n1, k2, n2)
            within = z is not None and abs(z) < 1.96
            pairs.append({"a": x, "b": y,
                          "shareA": round(k1 / n1, 4), "shareB": round(k2 / n2, 4),
                          "z": None if z is None else round(z, 3),
                          "withinNoise": within})
            same[(x, y)] = within

    # Transitive closure into behaviour clusters. Recorded honestly: "within noise" is not
    # a transitive relation, so a cluster can chain A~B~C while A and C differ. Chained
    # merges are flagged instead of being presented as a clean equivalence class.
    parent = {n: n for n in names}

    def find(n):
        while parent[n] != n:
            parent[n] = parent[parent[n]]
            n = parent[n]
        return n

    for (x, y), ok in same.items():
        if ok:
            rx, ry = find(x), find(y)
            if rx != ry:
                parent[rx] = ry

    clusters = {}
    for n in names:
        clusters.setdefault(find(n), []).append(n)
    cluster_list = []
    for members in clusters.values():
        members = sorted(members)
        chained = [
            [x, y] for i, x in enumerate(members) for y in members[i + 1:]
            if not same.get((x, y), same.get((y, x), True))
        ]
        cluster_list.append({
            "members": members,
            "shares": {m: round(vectors[m][0] / vectors[m][1], 4) for m in members},
            "chainedNotDirectlyEquivalent": chained or None,
        })
    cluster_list.sort(key=lambda c: c["members"])

    # The source-read prediction, checked rather than assumed.
    static = [a for a in ("A1", "B2", "B3") if a in vectors]
    cluster_of = {m: i for i, c in enumerate(cluster_list) for m in c["members"]}
    predicted_ok = len({cluster_of[a] for a in static}) == 1 if len(static) > 1 else None
    if predicted_ok is True:
        verdict = ("CONFIRMS the source read: A1/B2/B3 are one behaviour (static priority "
                   "order). They must be reported as ONE row, not three ranks.")
    elif predicted_ok is False:
        verdict = ("CONTRADICTS the source read: A1/B2/B3 did NOT cluster together, but "
                   "auth.ts routes fill-first to the trailing else and both headroom and "
                   "reset-window degrade to static order against a null quota. This is "
                   "itself a finding -- something other than the strategy is moving the "
                   "selection. Do not rank these arms until it is explained.")
    else:
        verdict = "Not evaluable: fewer than two of A1/B2/B3 produced measurable arms."

    n_typ = max((v[1] for v in vectors.values()), default=0)
    # How big does an arm have to be to resolve a difference worth acting on? Inverting the
    # MDE: n = 2p(1-p)((z_a+z_b)/delta)^2. Stated because "within noise" at a small n is a
    # statement about the sample, and a bake-off that cannot separate a pin from a rotation
    # will report every arm as one behaviour and look beautifully consistent doing it.
    def n_for(delta):
        return int(math.ceil(2 * 0.25 * ((1.96 + 0.84) / delta) ** 2))
    return {
        "basis": basis,
        "basisNote": ("per-connection: distributions compare main vs main-2 directly."
                      if basis == "per-connection" else
                      "provider-level ONLY: per-connection counts were not supplied, so this "
                      "compares opencode-go vs not-opencode-go and is BLIND to main vs main-2 "
                      "-- the very split G10 is meant to judge. Arms that pin and arms that "
                      "rotate look identical here. Fill conn-<arm>.tsv from g7-<arm>.sql and "
                      "re-run for a real answer."),
        "test": "pooled two-proportion z, |z| < 1.96 => within noise",
        "minDetectableShareDiff": mde(n_typ),
        "observedNPerArm": n_typ,
        "requiredNPerArm": {"toDetect_10pt": n_for(0.10), "toDetect_20pt": n_for(0.20),
                            "toDetect_30pt": n_for(0.30)},
        "powerNote": ("With ~%d successful requests/arm the test cannot separate shares "
                      "closer than ~%s. A 'within noise' verdict at this n is partly a "
                      "statement about sample size, not only about the router. To call a "
                      "20-point difference you need ~%d SUCCESSFUL requests per arm (429s "
                      "and errors do not count toward it), and ~%d for 10 points."
                      % (n_typ, mde(n_typ), n_for(0.20), n_for(0.10))),
        "underpowered": bool(n_typ < n_for(0.20)),
        "pairs": pairs,
        "clusters": cluster_list,
        "distinctBehaviours": len(cluster_list),
        "armsSkippedNoData": skipped or None,
        "sourcePrediction": {"expected": "A1 == B2 == B3 (static priority order)",
                             "held": predicted_ok, "verdict": verdict},
    }


def main():
    outdir = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("TOG207_OUT", ".")
    arms = read_jsonl(os.path.join(outdir, "arms.jsonl"))
    records = read_jsonl(os.path.join(outdir, "records.jsonl"))

    # Late-arriving per-connection counts (the normal case: the SQL is run after the
    # harness, management-side).
    for a in arms:
        if not a.get("perConnection"):
            c = load_conn_tsv(outdir, a["arm"])
            if c:
                a["perConnection"] = c

    meta_path = os.path.join(outdir, "run-meta.json")
    meta = {}
    if os.path.exists(meta_path):
        try:
            meta = json.load(open(meta_path))
        except Exception:
            meta = {"warning": "run-meta.json unparseable (run likely aborted)"}

    # The headline metric, per arm, never aggregated: PAYG traffic in an arm that saw no
    # 429 is a fallthrough-with-headroom event.
    for a in arms:
        payg = (a.get("perProvider") or {}).get("openrouter", 0)
        r429 = a.get("rateLimited429", 0)
        a["fallthroughWithHeadroom"] = {
            "paygCalls": payg,
            "rateLimited429": r429,
            "flagged": bool(payg > 0 and r429 == 0),
            "note": ("PAYG served while both Go plans were un-rate-limited: paid inference "
                     "with plan headroom left. This is the failure the task exists to prevent."
                     if payg > 0 and r429 == 0 else
                     "No PAYG traffic, or PAYG only after a 429 (which is legitimate fallback)."),
        }

    # G2 coverage across the run, so the bias caveat is visible in one place.
    #
    # REV 5 (TOG-214). Coverage is now reported ONLY over the arms G2 actually applies to.
    # The old run-wide number pooled A-arm observations into a single "coverage" figure,
    # which read as "the run verified its strategies on N% of requests" while the A-arm
    # share of that N was the literal string `single` on every request -- a constant, not
    # this arm's variable. Pooling it was the aggregate form of the same vacuous
    # assertion. Arms are split by g2.applicable, and the inapplicable side reports its raw
    # observed values instead of a coverage percentage it has not earned.
    applicable_arms = {a["arm"] for a in arms if (a.get("g2") or {}).get("applicable")}
    inapplicable_arms = {a["arm"] for a in arms} - applicable_arms

    def _cov(arm_set):
        s = sum(1 for r in records if r.get("arm") in arm_set and r.get("strategyRan"))
        n = sum(1 for r in records if r.get("arm") in arm_set and r.get("code") == 200)
        return s, n

    seen_app, ok_app = _cov(applicable_arms)
    seen_nap, ok_nap = _cov(inapplicable_arms)
    nap_values = {}
    for r in records:
        if r.get("arm") in inapplicable_arms and r.get("strategyRan"):
            v = r["strategyRan"]
            nap_values[v] = nap_values.get(v, 0) + 1
    by_src = {}
    for r in records:
        if r.get("code") == 200:
            by_src[r.get("providerSource")] = by_src.get(r.get("providerSource"), 0) + 1

    out = {
        "schemaVersion": "tog207.bakeoff.v2",
        "issue": "TOG-207",
        "run": meta,
        "arms": arms,
        "g2Overall": {
            "scope": "arms that VARY the combo strategy; g2.applicable is true on those",
            "applicableArms": sorted(applicable_arms),
            "coveragePct": round(100.0 * seen_app / ok_app, 1) if ok_app else None,
            "observed": seen_app, "successfulRequests": ok_app,
            "armVerdicts": {a["arm"]: (a.get("g2") or {}).get("verdict")
                            for a in arms if a["arm"] in applicable_arms},
            "note": ("Coverage is not completeness. strategy= appears only in the response "
                     "HEADER, which is dropped on ~29% of streaming 200s, and the drop is "
                     "latency-correlated toward the slow (OpenRouter) leg. So the covered "
                     "subset is biased toward opencode-go. Requests are never discarded on "
                     "absence -- discarding is what would corrupt the result. A verdict of "
                     "NOCOV means zero observations and is NOT a pass."),
        },
        "g2NotApplicable": {
            "arms": sorted(inapplicable_arms),
            "observed": seen_nap, "successfulRequests": ok_nap,
            "observedValues": nap_values or None,
            "coveragePct": None,
            "note": ("These arms vary the ACCOUNT strategy. OmniRoute echoes the COMBO "
                     "strategy in x-omniroute-decision and NEVER the account strategy -- "
                     "not in the header, not in the SSE trailer (verified 6/6 live, "
                     "TOG-214/F-11). observedValues is printed raw and deliberately has no "
                     "coverage percentage: a percentage here would read as verification of "
                     "something that was never observed. g2a is what backs these arms."),
        },
        "g2aOverall": {
            "source": "GET /api/settings providerStrategies['opencode-go'].fallbackStrategy",
            "sampling": "immediately before the arm's first request and immediately after its last",
            "perArm": {a["arm"]: {"want": (a.get("g2a") or {}).get("want"),
                                  "before": (a.get("g2a") or {}).get("before"),
                                  "after": (a.get("g2a") or {}).get("after"),
                                  "verdict": (a.get("g2a") or {}).get("verdict")}
                       for a in arms},
            "failedArms": sorted(a["arm"] for a in arms
                                 if (a.get("g2a") or {}).get("verdict") not in ("PASS", None)),
            "note": ("An arm whose g2a verdict is not PASS is UNATTRIBUTABLE: the account "
                     "strategy it claims to measure was not demonstrably in force for the "
                     "whole window. Discard those arms; do not rank them. This setting is "
                     "instance-global, so drift mid-arm is a real failure mode, not a "
                     "theoretical one."),
        },
        "attributionSource": {
            "counts": by_src,
            "note": ("'trailer' is the primary and is universal; 'header' is fallback; "
                     "'none' means unattributed but STILL COUNTED as other, never dropped."),
        },
        "g10": run_g10(arms),
        "consumerNotes": {
            "guardScope": ("Check arms[].g2a BEFORE reading any A-arm's counts: it is the "
                           "only assertion that the arm's varied dimension was in force. "
                           "arms[].g2.applicable is false on A-arms by construction and "
                           "its observedValues there are diagnostic, not verification."),
            "forChild4": ("Read arms[].perProvider, arms[].perConnection, "
                          "arms[].rateLimited429, arms[].window and g10.clusters. Do not "
                          "re-parse the logs. If perConnection is null the run was not "
                          "completed management-side -- say so rather than ranking arms on "
                          "provider counts, which cannot see main vs main-2."),
            "doNotRank": ("Arms in one g10 cluster are ONE behaviour. If run.quotaState is "
                          "QUOTA_DEAD, B1/B2/B3 measured a tie-breaker against a null quota, "
                          "not quota, and must not be ranked against A1-A5 at all."),
        },
    }
    json.dump(out, sys.stdout, indent=2)
    print()


if __name__ == "__main__":
    main()
