export type ModelClass = "MUSE" | "PRIMARY" | "FALLBACK" | "OTHER";

export interface BridgeLogLine {
  at: string;
  model: string;
  reason: string;
  [field: string]: unknown;
}

export interface ShadowRecord {
  writer?: string;
  tier?: string;
  ts: string;
  pickedModel?: string | null;
  candidates?: Array<{ model?: string; usable?: boolean }>;
}

export interface AgreementRow {
  key: string;
  n: number;
  agree: number;
  disagree: number;
  selOTHER: number;
  agreementPct: number | null;
}

export interface AgreementSummary {
  tier: string;
  records: number;
  totals: { agree: number; disagree: number; selOTHER: number };
  agreementPct: number | null;
  expressible: { bridge_model_usable_candidate: number; bridge_model_not_candidate: number };
  expressiblePct: number | null;
  byRegime: AgreementRow[];
  byTier: AgreementRow[];
  byHour: AgreementRow[];
  skipped: { notShadowWriter: number; otherTier: number; outsideWindow: number; beforeBridgeLog: number };
}

export const DEFAULT_BRIDGE_LOG: string;
export function classifyModel(model: string | null | undefined): ModelClass | null;
export function bridgeAt(bridgeLog: ReadonlyArray<{ at: string }>, ts: string): BridgeLogLine | null;
export function summarize(input: {
  records: Iterable<ShadowRecord>;
  bridgeLog: ReadonlyArray<BridgeLogLine>;
  tier?: string | null;
  since?: string | null;
  until?: string | null;
}): AgreementSummary;
export function readBridgeLog(file: string): Promise<{ lines: BridgeLogLine[]; malformed: number }>;
export function readJsonLines(file: string, counters?: { malformed: number }): AsyncGenerator<Record<string, any>>;
export function shadowFiles(dir: string, includeLegacy: boolean): Promise<string[]>;
export function formatText(summary: AgreementSummary): string;
export function runCli(
  argv: string[],
  io?: {
    stdout?: { write(text: string): unknown };
    stderr?: { write(text: string): unknown };
    env?: Record<string, string | undefined>;
  },
): Promise<number>;
