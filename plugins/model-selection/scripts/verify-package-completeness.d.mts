export interface RequiredPath {
  kind: "file" | "dir";
  rel: string;
  via: string;
}

export interface CompletenessResult {
  missing: RequiredPath[];
  found: RequiredPath[];
}

export interface PackageInputs {
  pkg: Record<string, any>;
  manifest: Record<string, any>;
}

export function normalizeRel(raw: unknown): string | null;
export function requiredPaths(pkg: unknown, manifest: unknown): RequiredPath[];
export function checkCompleteness(
  required: RequiredPath[],
  packedFiles: string[],
): CompletenessResult;
export function loadPackageInputs(): Promise<PackageInputs>;
