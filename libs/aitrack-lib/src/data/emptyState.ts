import { tryLoadConfig } from '../config.js';
import { isCloned } from '../git.js';
import { INIT_HINT } from './messages.js';

export function isUsageNotConfigured(): boolean {
  return !tryLoadConfig() || !isCloned();
}

/** Message when merged provider data is unavailable entirely. */
export function usageEmptyMessage(warnedNotConfigured?: boolean): string {
  return warnedNotConfigured
    ? `No local usage data found (Claude Code or Codex). Run: ${INIT_HINT} to sync across machines.`
    : 'No usage data found. Run: npx aitrack sync (Claude/Codex), or use Cursor locally.';
}

/** Message when data exists but a filtered window or ranking is empty. */
export function usageEmptyWindowMessage(windowLabel?: string): string {
  return windowLabel ? `No usage recorded for ${windowLabel}.` : 'No usage recorded.';
}
