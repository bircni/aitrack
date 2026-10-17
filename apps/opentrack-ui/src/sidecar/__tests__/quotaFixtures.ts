import type { ProviderState, QuotaSnapshot } from '../../shared/types.js';

export const NOW = Date.parse('2026-06-01T12:00:00.000Z');
export const HOUR = 3_600_000;

export function snapshot(windows: QuotaSnapshot['windows']): QuotaSnapshot {
  return { provider: 'claude_code', windows, values: [], fetchedAt: new Date(NOW).toISOString() };
}

export function sessionWindow(usedPercent: number, elapsedHours: number) {
  return {
    id: 'session',
    label: 'Session',
    usedPercent,
    periodSeconds: 5 * 3600,
    resetsAt: new Date(NOW + (5 - elapsedHours) * HOUR).toISOString(),
    format: 'percent' as const,
  };
}

export function provider(windows: QuotaSnapshot['windows']): ProviderState {
  return {
    key: 'claude_code',
    label: 'Claude Code',
    quota: snapshot(windows),
    refreshing: false,
  };
}
