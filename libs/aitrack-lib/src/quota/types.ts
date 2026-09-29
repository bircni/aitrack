/** Providers with a live quota endpoint. Keys match the provider registry. */
export type QuotaProviderKey = 'claude_code' | 'codex' | 'cursor';

export type QuotaFormat = 'percent' | 'dollars' | 'count';

/** One limit that resets on a schedule, e.g. Claude's five-hour session. */
export interface QuotaWindow {
  id: string;
  label: string;
  usedPercent: number;
  /** ISO instant; absent when the provider does not say. */
  resetsAt?: string;
  /** Window length, used for pacing. Zero when the window has no fixed period. */
  periodSeconds: number;
  format: QuotaFormat;
  usedValue?: number;
  limitValue?: number;
}

/** A balance without a limit, e.g. remaining credits. */
export interface QuotaValue {
  id: string;
  label: string;
  value: number;
  format: 'dollars' | 'count';
}

export interface QuotaSnapshot {
  provider: QuotaProviderKey;
  plan?: string;
  windows: QuotaWindow[];
  values: QuotaValue[];
  fetchedAt: string;
}

export type QuotaErrorKind =
  | 'noCredentials'
  | 'expired'
  | 'auth'
  | 'rateLimited'
  | 'network'
  | 'invalidResponse';

export interface QuotaError {
  kind: QuotaErrorKind;
  message: string;
  retryAfterSeconds?: number;
}

export type QuotaResult = { ok: true; snapshot: QuotaSnapshot } | { ok: false; error: QuotaError };
