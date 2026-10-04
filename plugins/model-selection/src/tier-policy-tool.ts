/**
 * The `model_selection_tier_policy` tool declaration, shared by the
 * manifest and the worker registration so the two cannot drift. Kept free of
 * runtime imports: the manifest bundle loads it.
 */
export const TIER_POLICY_ACTIONS = ["add", "edit", "remove", "validate", "diff"] as const;
export type TierPolicyAction = (typeof TIER_POLICY_ACTIONS)[number];

/** Fields an edit may change. `id` is the tier's identity; renaming is a `name` change. */
export const EDITABLE_TIER_FIELDS = [
  "name",
  "order",
  "entryRules",
  "allowedEfforts",
  "evidence",
  "fallbackOnly",
  "sTier",
  "legacy",
] as const;

export const TIER_POLICY_TOOL_DISPLAY_NAME = "Tier policy: add, edit, remove, validate, diff";

export const TIER_POLICY_TOOL_DESCRIPTION =
  "Prepare a tier-policy change as data: add, edit (name, order, entry rules, efforts, evidence, " +
  "fallbackOnly/sTier, legacy thresholds) or remove a tier, or validate/diff a candidate policy. add/edit/remove need " +
  "expectedRevision (must equal the base revision) and a reason. Returns proposalOnly or rejected with issues, a diff " +
  "keyed by tier id, the dry-run impact and an audit id. Prepare/validate/diff only: writes nothing and never changes " +
  "routing; the base is the built-in active policy unless basePolicy is supplied.";

export const TIER_POLICY_TOOL_PARAMETERS = {
  type: "object",
  required: ["action"],
  properties: {
    action: { type: "string", enum: [...TIER_POLICY_ACTIONS] },
    expectedRevision: { type: "integer", minimum: 1, description: "Compare-and-set: must equal the base policy revision." },
    reason: { type: "string", description: "Why the change is wanted; required for add/edit/remove." },
    dryRun: { type: "boolean", description: "Defaults to true. This build never persists either way." },
    tierId: { type: "string", description: "The tier to edit or remove." },
    tier: { type: "object", description: "add: the full tier definition." },
    patch: {
      type: "object",
      description: `edit: fields to change, any of ${EDITABLE_TIER_FIELDS.join(", ")}; legacy and evidence merge shallowly.`,
    },
    policy: { type: "object", description: "validate/diff: a full candidate policy at the next revision." },
    basePolicy: { type: "object", description: "Optional base to edit instead of the built-in active policy." },
  },
} as const;
