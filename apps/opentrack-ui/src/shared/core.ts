// Helpers and types the renderer shares with aitrack, kept in step with crates/core.

export type ProviderKey = 'claude_code' | 'codex' | 'cursor';
export type QuotaProviderKey = ProviderKey;

/** In display order. */
export const QUOTA_PROVIDERS: readonly QuotaProviderKey[] = ['claude_code', 'codex', 'cursor'];

/** The command that fixes an unconfigured install. */
export const INIT_HINT = 'npx aitrack init';

type QuotaFormat = 'percent' | 'dollars' | 'count';

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
interface QuotaValue {
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

type QuotaErrorKind =
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

interface ProjectProviderUsage {
  key: string;
  label: string;
  tokens: number;
  costUSD: number;
  hasCost: boolean;
  hasUnpricedTokens?: boolean;
}

export interface ProjectUsage {
  project: string;
  tokens: number;
  costUSD: number;
  hasCost: boolean;
  hasUnpricedTokens?: boolean;
  /** The remainder of days that carry no (or only partial) project split. */
  unattributed?: boolean;
  providers: ProjectProviderUsage[];
}

/** Message for anything thrown into an `unknown` catch binding. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type PaceSeverity = 'level' | 'healthy' | 'close' | 'runningOut' | 'spent';

export interface PaceProjection {
  severity: PaceSeverity;
  projectedUsedPercent: number | null;
  evenPacePercent: number | null;
  /** Epoch ms the quota runs out, when that falls before the reset. */
  runOutAt: number | null;
}

const LEVEL: PaceProjection = {
  severity: 'level',
  projectedUsedPercent: null,
  evenPacePercent: null,
  runOutAt: null,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clampPercent(value: number): number {
  return clamp(value, 0, 100);
}

/** Whether a quota will last until it resets, projected from the pace so far. */
export function projectPace(
  window: Pick<QuotaWindow, 'usedPercent' | 'resetsAt' | 'periodSeconds'>,
  now: number,
): PaceProjection {
  const used = clampPercent(window.usedPercent);
  if (Math.round(used) >= 100) {
    return { severity: 'spent', projectedUsedPercent: 100, evenPacePercent: null, runOutAt: now };
  }
  if (used <= 0) return LEVEL;
  const reset = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
  if (!Number.isFinite(reset) || reset <= now || window.periodSeconds <= 0) return LEVEL;
  const periodMs = window.periodSeconds * 1000;
  const start = reset - periodMs;
  const elapsed = Math.max(0, now - start);
  // Too early in the window for a projection to mean anything.
  if (elapsed < Math.max(60_000, periodMs * 0.01)) return LEVEL;
  const progress = clamp(elapsed / periodMs, 0, 1);
  const projected = used / progress;
  const evenPacePercent = progress * 100;
  if (projected <= 90) {
    return {
      severity: 'healthy',
      projectedUsedPercent: projected,
      evenPacePercent,
      runOutAt: null,
    };
  }
  if (used < 5) return LEVEL;
  if (projected <= 100) {
    const severity = Math.round(100 - projected) >= 1 ? 'close' : 'runningOut';
    return { severity, projectedUsedPercent: projected, evenPacePercent, runOutAt: null };
  }
  const runOutAt = start + (elapsed * 100) / used;
  return {
    severity: 'runningOut',
    projectedUsedPercent: projected,
    evenPacePercent,
    runOutAt: runOutAt > now && runOutAt < reset ? runOutAt : null,
  };
}

interface CostTokenSortable {
  tokens: number;
  costUSD?: number;
  cost?: number | null;
}

function costValue(entry: CostTokenSortable): number {
  return entry.costUSD ?? entry.cost ?? 0;
}

export function compareByCostThenTokens(a: CostTokenSortable, b: CostTokenSortable): number {
  return costValue(b) - costValue(a) || b.tokens - a.tokens;
}

/** Ascending fill ratios (tokens / ceiling) at which a heatmap cell moves up a level. */
const INTENSITY_THRESHOLDS = [0.1, 0.35, 0.65] as const;

export function tokenIntensityLevel(tokens: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (!tokens || !max) return 0;
  const r = Math.min(tokens / max, 1);
  const [low, mid, high] = INTENSITY_THRESHOLDS;
  if (r < low) return 1;
  if (r < mid) return 2;
  if (r < high) return 3;
  return 4;
}

// Local YYYY-MM-DD strings in and out; UTC only because it has no DST jumps.
function parseDateString(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** Monday of the week `date` falls in. */
export function mondayOfWeek(date: string): string {
  const day = parseDateString(date);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

/** Number of days from `start` to `end`, inclusive of both ends. */
export function inclusiveDayCount(start: string, end: string): number {
  const milliseconds = parseDateString(end).getTime() - parseDateString(start).getTime();
  return Math.floor(milliseconds / 86_400_000) + 1;
}

export function toLocalDateString(ts: string | Date): string {
  const d = typeof ts === 'string' ? new Date(ts) : ts;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${String(y)}-${m}-${day}`;
}

const STALE_SYNC_MS = 3 * 86_400_000;

/** A machine that synced before but not for three days; one that never synced is reported separately. */
export function isStaleSync(lastUpdated: string, now: number): boolean {
  const at = Date.parse(lastUpdated);
  return !Number.isNaN(at) && now - at > STALE_SYNC_MS;
}

/** toFixed rounds up, so 999_999 scaled by 1e3 gives "1000.0", which must show as "1.0M". */
function roundsPastUnit(n: number, divisor: number): boolean {
  return Number((n / divisor).toFixed(1)) >= 1000;
}

/** Tokens on the K/M/B scale. */
export function fmt(n: number): string {
  if (n >= 1e9 || roundsPastUnit(n, 1e6)) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6 || roundsPastUnit(n, 1e3)) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}
