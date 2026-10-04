/** Public format names; private deployments may explicitly retain one v1 alias. */
export const PUBLIC_FORMAT_IDENTIFIERS = Object.freeze({
  tierSpecVersion: "benchmark-prior-v1",
  acceptedWorkSpecVersion: "accepted-work-posterior-v1",
  shadowSchemaVersion: "paired-decision-v1",
} as const);

export type FormatName = keyof typeof PUBLIC_FORMAT_IDENTIFIERS;
export type FormatCompatibility = { [Name in FormatName]: string | null };

const FORMAT_FIELDS = {
  tierSpecVersion: "tierSpecVersion",
  acceptedWorkSpecVersion: "specVersion",
  shadowSchemaVersion: "schema",
} as const satisfies Record<FormatName, string>;

type TranslatedFormat<T, Name extends FormatName> = T extends object ? {
  [Key in keyof T]: Key extends (typeof FORMAT_FIELDS)[Name] ? T[Key] | string : T[Key];
} : T;

/** Absence is canonical-only; invalid profiles must not silently change storage. */
export function resolveFormatCompatibility(raw: unknown): FormatCompatibility {
  const result: FormatCompatibility = {
    tierSpecVersion: null,
    acceptedWorkSpecVersion: null,
    shadowSchemaVersion: null,
  };
  if (raw === undefined || raw === null) return result;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("formatCompatibility must be an object");
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(PUBLIC_FORMAT_IDENTIFIERS, key)) throw new Error(`unknown formatCompatibility field: ${key}`);
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || value.length > 80 || !/^[a-z0-9][a-z0-9._:-]*-v1$/.test(value)) {
      throw new Error(`formatCompatibility.${key} must be an exact v1 identifier or null`);
    }
    result[key as FormatName] = value;
  }
  return result;
}

function rewrite<T>(format: FormatName, value: T, expected: string, replacement: string): T {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const field = FORMAT_FIELDS[format];
  if ((value as Record<string, unknown>)[field] !== expected) return value;
  // Clone only the format field. Existing structural/version validation still
  // owns acceptance; this does not make any malformed payload admissible.
  return { ...value, [field]: replacement };
}

export function decodePersistedFormat<T, Name extends FormatName>(format: Name, value: T, compatibility?: FormatCompatibility): TranslatedFormat<T, Name> {
  const alias = compatibility?.[format];
  return (alias ? rewrite(format, value, alias, PUBLIC_FORMAT_IDENTIFIERS[format]) : value) as TranslatedFormat<T, Name>;
}

export function encodePersistedFormat<T, Name extends FormatName>(format: Name, value: T, compatibility?: FormatCompatibility): TranslatedFormat<T, Name> {
  const alias = compatibility?.[format];
  return (alias ? rewrite(format, value, PUBLIC_FORMAT_IDENTIFIERS[format], alias) : value) as TranslatedFormat<T, Name>;
}
