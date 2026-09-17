import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * TOG-2481 task #9: `tier_roster.json` (read by the still-running
 * `tier_dispatcher.py`/`model_scores.py` under
 * `~/paperclip-enterprise-company/ops/tog-1926/`) is superseded by this
 * plugin's own checked-in `config/reviewed-roster.json`. This spec is the
 * permanent proof of that claim, not a one-off diff script run by hand.
 *
 * `tests/fixtures/tier_roster.snapshot.json` is a frozen copy of the host
 * file as read on 2026-09-14, the day this consolidation was verified. It is
 * deliberately NOT re-read live from the host path: this plugin must not
 * depend on `~/paperclip-enterprise-company/` at test time any more than it
 * does at run time (that dependency is exactly what TOG-2481's AC3 forbids).
 * The snapshot exists only so a future change to `reviewed-roster.json` that
 * silently drops a canonical model or an owner's dated rule fails CI, per the
 * issue's instruction to "preserve them as tests, not just code."
 */

interface LegacyModel {
  id: string;
  tier: string;
  enabled: boolean;
  note?: string;
}

interface ReviewedModel {
  id: string;
  tier: string;
  enabled: boolean;
  note?: string;
  laneId?: string | null;
}

const legacy = JSON.parse(
  readFileSync(new URL("./fixtures/tier_roster.snapshot.json", import.meta.url), "utf8"),
) as { models: LegacyModel[] };

const reviewed = JSON.parse(
  readFileSync(new URL("../config/reviewed-roster.json", import.meta.url), "utf8"),
) as { models: ReviewedModel[] };

function canonicalId(id: string): string {
  return id.replace(/^cliproxy\//, "");
}

describe("roster consolidation (TOG-2481 task #9): reviewed-roster.json supersedes tier_roster.json", () => {
  it("carries every canonical model id from the legacy roster", () => {
    const reviewedIds = new Set(reviewed.models.map((m) => canonicalId(m.id)));
    const missing = legacy.models.map((m) => canonicalId(m.id)).filter((id) => !reviewedIds.has(id));
    expect(missing).toEqual([]);
  });

  it("preserves every non-empty dated owner-rule note verbatim as a substring", () => {
    const byCanon = new Map<string, ReviewedModel[]>();
    for (const m of reviewed.models) {
      const key = canonicalId(m.id);
      const list = byCanon.get(key) ?? [];
      list.push(m);
      byCanon.set(key, list);
    }

    const lost: string[] = [];
    for (const legacyModel of legacy.models) {
      const note = (legacyModel.note ?? "").trim();
      if (!note) continue;
      const candidates = byCanon.get(canonicalId(legacyModel.id)) ?? [];
      const preserved = candidates.some((c) => (c.note ?? "").includes(note));
      if (!preserved) lost.push(`${legacyModel.id}: ${note.slice(0, 80)}`);
    }
    expect(lost).toEqual([]);
  });

  it("has no enabled-state divergence from the frozen legacy roster", () => {
    const byCanonTier = new Map<string, ReviewedModel>();
    for (const m of reviewed.models) {
      byCanonTier.set(`${canonicalId(m.id)}:${m.tier}`, m);
    }

    const unexplained: string[] = [];
    for (const legacyModel of legacy.models) {
      const key = `${canonicalId(legacyModel.id)}:${legacyModel.tier}`;
      const reviewedModel = byCanonTier.get(key);
      if (!reviewedModel) continue;
      if (legacyModel.enabled === reviewedModel.enabled) continue;
      unexplained.push(`${key}: legacy=${legacyModel.enabled} reviewed=${reviewedModel.enabled}`);
    }
    expect(unexplained).toEqual([]);
  });

  it("carries no legacy cliproxy/ wrapper id (README: rejected in new roster config)", () => {
    const wrapped = reviewed.models.filter((m) => m.id.startsWith("cliproxy/"));
    expect(wrapped).toEqual([]);
  });

  it("carries no laneId — lane binding is deferred to assemble-additive-config.mjs at merge time", () => {
    const laned = reviewed.models.filter((m) => m.laneId != null);
    expect(laned).toEqual([]);
  });
});
