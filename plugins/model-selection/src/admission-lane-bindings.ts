import type { LaneAccountBinding } from './admission-observation.js';

/**
 * The ONLY source of account/pool/provider identity for the quota observation
 * adapter. Identities are opaque labels owned by this table, never an email,
 * display name, credential, `record-N` position or iteration order. The lane id
 * is the host's own per-account key in the lane documents
 * (`laneAccountId` in cliproxy-insight: "stable per-account identity within a
 * lane document"). Re-pointing a lane at a different upstream account is a
 * reviewed edit here; the adapter never infers or repairs a binding.
 *
 * Only lanes with in-repo evidence are committed. A lane present in a snapshot
 * but absent here is reported as unmapped and excluded, not guessed. Meta lane
 * ids come from the live lane document read on 2026-10-03
 * (`tests/fixtures/meta-lane-evidence-20261003.json`, host
 * `/srv/cliproxy-usage/meta.json`, sha256 `3462fefa…3910eec`, observed
 * `2026-10-03T20:25:22Z`): meta-lane-1 through meta-lane-8, each its own pool
 * with 5h + weekly windows. Committing an identity certifies nothing about
 * freshness: meta-lane-4 was `cached`/`unavailable` at capture and must never
 * be read as fresh serviceable evidence — per-observation quality governs, and
 * the adapter marks cached observations stale. Each account is its own pool
 * unless a pool id is deliberately shared.
 */
const FIVE_HOUR = { kind: 'five-hour', utilizationField: 'five_hour_utilization', resetField: 'five_hour_resets_at' } as const;
const SEVEN_DAY = { kind: 'weekly', utilizationField: 'seven_day_utilization', resetField: 'seven_day_resets_at' } as const;
const WEEKLY = { kind: 'weekly', utilizationField: 'weekly_utilization', resetField: 'weekly_resets_at' } as const;

export const COMMITTED_LANE_ACCOUNT_BINDINGS: readonly LaneAccountBinding[] = [
  { laneId: 'claude-lane-1', accountId: 'claude-acct-1', poolId: 'claude-pool-1', providerId: 'claude', windows: [FIVE_HOUR, SEVEN_DAY] },
  { laneId: 'claude-lane-2', accountId: 'claude-acct-2', poolId: 'claude-pool-2', providerId: 'claude', windows: [FIVE_HOUR, SEVEN_DAY] },
  { laneId: 'codex-lane-1', accountId: 'codex-acct-1', poolId: 'codex-pool-1', providerId: 'codex', windows: [WEEKLY] },
  { laneId: 'codex-lane-2', accountId: 'codex-acct-2', poolId: 'codex-pool-2', providerId: 'codex', windows: [WEEKLY] },
  { laneId: 'codex-lane-3', accountId: 'codex-acct-3', poolId: 'codex-pool-3', providerId: 'codex', windows: [WEEKLY] },
  { laneId: 'zai-lane-1', accountId: 'zai-acct-1', poolId: 'zai-pool-1', providerId: 'zai', windows: [FIVE_HOUR, WEEKLY] },
  { laneId: 'meta-lane-1', accountId: 'meta-acct-1', poolId: 'meta-pool-1', providerId: 'meta', windows: [FIVE_HOUR, WEEKLY] },
  { laneId: 'meta-lane-2', accountId: 'meta-acct-2', poolId: 'meta-pool-2', providerId: 'meta', windows: [FIVE_HOUR, WEEKLY] },
  { laneId: 'meta-lane-3', accountId: 'meta-acct-3', poolId: 'meta-pool-3', providerId: 'meta', windows: [FIVE_HOUR, WEEKLY] },
  { laneId: 'meta-lane-4', accountId: 'meta-acct-4', poolId: 'meta-pool-4', providerId: 'meta', windows: [FIVE_HOUR, WEEKLY] },
  { laneId: 'meta-lane-5', accountId: 'meta-acct-5', poolId: 'meta-pool-5', providerId: 'meta', windows: [FIVE_HOUR, WEEKLY] },
  { laneId: 'meta-lane-6', accountId: 'meta-acct-6', poolId: 'meta-pool-6', providerId: 'meta', windows: [FIVE_HOUR, WEEKLY] },
  { laneId: 'meta-lane-7', accountId: 'meta-acct-7', poolId: 'meta-pool-7', providerId: 'meta', windows: [FIVE_HOUR, WEEKLY] },
  { laneId: 'meta-lane-8', accountId: 'meta-acct-8', poolId: 'meta-pool-8', providerId: 'meta', windows: [FIVE_HOUR, WEEKLY] },
];
