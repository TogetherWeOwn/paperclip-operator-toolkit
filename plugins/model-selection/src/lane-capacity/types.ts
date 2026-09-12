// Vendored (subset) from @togetherweown/lane-capacity (paperclip-model-router,
// packages/lane-capacity/src/types.ts). Only `CapacityHealth` is needed here —
// model-selection has no use for the capacity-evidence/window types, which
// stay in the source package.
export type CapacityHealth = "healthy" | "degraded" | "exhausted" | "unavailable" | "unknown";
