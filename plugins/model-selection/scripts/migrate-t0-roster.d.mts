export const T0_MIGRATION_TARGETS: readonly string[];

export interface T0MigrationChange {
  id: string;
  ordinal: number;
  laneId: string;
  before: { tier: string; fallbackOnly: boolean };
  after: { tier: string; fallbackOnly: boolean };
}

export interface T0MigrationPlan {
  config: Record<string, any> & { models: Array<Record<string, any>> };
  changes: T0MigrationChange[];
  alreadyMigrated: string[];
  rollback: Array<{ id: string; ordinal: number; set: { tier: string; fallbackOnly: boolean } }>;
}

export function planT0Migration(
  live: Record<string, any>,
  receipt: Record<string, any>,
  options?: { targets?: readonly string[] },
): T0MigrationPlan;

export function assertOnlyExpectedChanges(
  before: Record<string, any>,
  after: Record<string, any>,
  changes: ReadonlyArray<Pick<T0MigrationChange, "id" | "ordinal">>,
): void;

export function verifyT0Roster(
  live: Record<string, any>,
  receipt: Record<string, any>,
  options?: { targets?: readonly string[] },
): string[];
