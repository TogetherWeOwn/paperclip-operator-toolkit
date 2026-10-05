export interface AdditiveConfigCounts {
  liveBefore: {
    models: number;
    enabled: number;
    withLaneId: number;
    enabledWithLaneId: number;
    pacingLanes: number;
    pacingMode: string | null;
  };
  artifactAfter: AdditiveConfigCounts["liveBefore"];
  preservedLaneBindings: number;
  inferredLaneBindings: number;
  enabledWithoutLane: string[];
  guard: string;
}

export function validateBridgeConfig(live: Record<string, any>, artifact: Record<string, any>): void;

export function assembleBridgeConfig(
  roster: Record<string, unknown>,
  live: Record<string, unknown>,
  options?: { minimumLaneBoundModels?: number },
): ReturnType<typeof assembleAdditiveConfig>;

export function assembleAdditiveConfig(
  roster: Record<string, unknown>,
  live: Record<string, unknown>,
  options?: { minimumLaneBoundModels?: number },
): {
  config: Record<string, any> & { models: Array<Record<string, any> & { id: string }> };
  counts: AdditiveConfigCounts;
};
