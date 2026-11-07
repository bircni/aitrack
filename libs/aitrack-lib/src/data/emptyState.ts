import { tryLoadConfig } from '../config.js';
import { isCloned } from '../git.js';
import { providerLabel } from '../providers/index.js';
import { INIT_HINT } from './messages.js';

const DOCTOR_HINT = 'npx aitrack doctor';

export function isUsageNotConfigured(): boolean {
  return !tryLoadConfig() || !isCloned();
}

/** Message when merged provider data is unavailable entirely, or `providers` left none of it. */
export function usageEmptyMessage(
  warnedNotConfigured?: boolean,
  providers: readonly string[] = [],
): string {
  if (providers.length > 0) {
    const labels = providers.map((provider) => providerLabel(provider)).join(', ');
    return `No usage found for ${labels}. Run: ${DOCTOR_HINT} to see which sources were checked.`;
  }
  return warnedNotConfigured
    ? `No local usage data found (Claude Code or Codex). Run: ${DOCTOR_HINT} to see which logs were checked, or ${INIT_HINT} to sync across machines.`
    : 'No usage data found. Run: npx aitrack sync (Claude/Codex), or use Cursor locally.';
}

/** Message when data exists but a filtered window or ranking is empty. */
export function usageEmptyWindowMessage(windowLabel?: string): string {
  return windowLabel ? `No usage recorded for ${windowLabel}.` : 'No usage recorded.';
}
