import { errorMessage } from '../errors.js';
import { fetchClaudeQuota } from './claude.js';
import { fetchCodexQuota } from './codex.js';
import { fetchCursorQuota } from './cursor.js';
import { QuotaFailure } from './http.js';
import type { QuotaProviderKey, QuotaResult, QuotaSnapshot } from './types.js';

export type * from './types.js';
export { projectPace, type PaceProjection, type PaceSeverity } from './pacing.js';

/** In display order. */
const FETCHERS: Record<QuotaProviderKey, (now: Date) => Promise<QuotaSnapshot>> = {
  claude_code: fetchClaudeQuota,
  codex: fetchCodexQuota,
  cursor: fetchCursorQuota,
};

export const QUOTA_PROVIDERS = Object.keys(FETCHERS) as readonly QuotaProviderKey[];

/**
 * Live limits for one provider, from the login its own tool already saved.
 *
 * Never throws: every failure comes back as a typed error so one provider
 * being signed out does not take the others down with it.
 */
export async function fetchQuota(
  provider: QuotaProviderKey,
  now = new Date(),
): Promise<QuotaResult> {
  try {
    return { ok: true, snapshot: await FETCHERS[provider](now) };
  } catch (error) {
    if (error instanceof QuotaFailure) {
      return {
        ok: false,
        error: {
          kind: error.kind,
          message: error.message,
          ...(error.retryAfterSeconds === undefined
            ? {}
            : { retryAfterSeconds: error.retryAfterSeconds }),
        },
      };
    }
    return { ok: false, error: { kind: 'invalidResponse', message: errorMessage(error) } };
  }
}
