import { tryLoadConfig } from '../config.js';
import { isCloned } from '../git.js';
import { INIT_HINT } from './messages.js';

export type UsageEmptyReason = 'not-configured' | 'no-data' | 'empty-window';

export function isUsageNotConfigured(): boolean {
  return !tryLoadConfig() || !isCloned();
}

export function formatUsageEmptyMessage(reason: UsageEmptyReason, detail?: string): string {
  switch (reason) {
    case 'not-configured': {
      return `No local usage data found (Claude Code or Codex). Run: ${INIT_HINT} to sync across machines.`;
    }
    case 'no-data': {
      return 'No usage data found. Run: npx aitrack sync (Claude/Codex), or use Cursor locally.';
    }
    case 'empty-window': {
      return detail ? `No usage recorded for ${detail}.` : 'No usage recorded.';
    }
  }
}

/** Message when merged provider data is unavailable entirely. */
export function usageEmptyMessage(warnedNotConfigured?: boolean): string {
  return formatUsageEmptyMessage(warnedNotConfigured ? 'not-configured' : 'no-data');
}

/** Message when data exists but a filtered window or ranking is empty. */
export function usageEmptyWindowMessage(windowLabel?: string): string {
  return formatUsageEmptyMessage('empty-window', windowLabel);
}
