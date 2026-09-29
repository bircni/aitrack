import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { environmentValue } from '../env.js';
import { claudeHomeDirs } from '../readers/paths.js';
import {
  instantValue,
  numberValue,
  QuotaFailure,
  record,
  requestJson,
  stringValue,
  titleCase,
} from './http.js';
import { clampPercent } from './pacing.js';
import type { QuotaSnapshot, QuotaValue, QuotaWindow } from './types.js';

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const KEYCHAIN_TIMEOUT_MS = 5000; // An access prompt nobody answers would otherwise hang the fetch.
const SESSION_SECONDS = 5 * 60 * 60;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

export interface ClaudeCredentials {
  accessToken: string;
  expiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

export function claudeCredentialsPaths(): string[] {
  return claudeHomeDirs({ overrideOnly: true }).map((dir) => join(dir, '.credentials.json'));
}

export function parseClaudeCredentials(text: string): ClaudeCredentials | undefined {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return undefined;
  }
  const oauth = record(record(document)?.claudeAiOauth);
  const accessToken = stringValue(oauth?.accessToken);
  if (!oauth || accessToken === undefined) return undefined;
  return {
    accessToken,
    expiresAt: numberValue(oauth.expiresAt),
    scopes: Array.isArray(oauth.scopes)
      ? oauth.scopes.filter((scope): scope is string => typeof scope === 'string')
      : undefined,
    subscriptionType: stringValue(oauth.subscriptionType),
    rateLimitTier: stringValue(oauth.rateLimitTier),
  };
}

function readKeychainCredentials(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { timeout: KEYCHAIN_TIMEOUT_MS },
      (error, stdout) => {
        resolve(error ? undefined : stdout);
      },
    );
  });
}

/** The file Claude Code writes, then (macOS) the Keychain item it prefers there. */
export async function readClaudeCredentials(): Promise<ClaudeCredentials | undefined> {
  for (const path of claudeCredentialsPaths()) {
    const text = await readFile(path, 'utf8').catch(() => undefined);
    const fromFile = text === undefined ? undefined : parseClaudeCredentials(text);
    if (fromFile) return fromFile;
  }
  // The Keychain item is the default account's, not the one CLAUDE_CONFIG_DIR points at.
  if (process.platform !== 'darwin' || environmentValue('CLAUDE_CONFIG_DIR')) return undefined;
  const keychain = await readKeychainCredentials();
  return keychain === undefined ? undefined : parseClaudeCredentials(keychain);
}

/** "pro" + "default_claude_max_5x" → "Pro 5x". */
export function formatClaudePlan(subscription?: string, tier?: string): string | undefined {
  if (subscription === undefined) return undefined;
  const plan = titleCase(subscription.toLowerCase());
  const multiplier = tier?.split(/[^a-z0-9]/iu).find((part) => /^\d+x$/iu.test(part));
  return multiplier === undefined ? plan : `${plan} ${multiplier}`;
}

function percentWindow(
  id: string,
  label: string,
  percent: unknown,
  resetsAt: unknown,
  periodSeconds: number,
): QuotaWindow | undefined {
  const usedPercent = numberValue(percent);
  if (usedPercent === undefined) return undefined;
  return {
    id,
    label,
    usedPercent,
    resetsAt: instantValue(resetsAt),
    periodSeconds,
    format: 'percent',
  };
}

export function mapClaudeUsage(
  body: Record<string, unknown>,
  credentials: Pick<ClaudeCredentials, 'subscriptionType' | 'rateLimitTier'>,
  now: Date,
): QuotaSnapshot {
  const windows: QuotaWindow[] = [];
  const values: QuotaValue[] = [];
  // First source wins: a scoped "Sonnet" limit repeats seven_day_sonnet.
  const push = (window: QuotaWindow | undefined) => {
    if (window && !windows.some(({ id }) => id === window.id)) windows.push(window);
  };
  for (const [key, id, label, period] of [
    ['five_hour', 'session', 'Session', SESSION_SECONDS],
    ['seven_day', 'weekly', 'Weekly', WEEK_SECONDS],
    ['seven_day_sonnet', 'model:sonnet', 'Sonnet', WEEK_SECONDS],
  ] as const) {
    const window = record(body[key]);
    if (window) push(percentWindow(id, label, window.utilization, window.resets_at, period));
  }

  const limits = Array.isArray(body.limits) ? body.limits : [];
  for (const limit of limits.map((entry) => record(entry))) {
    if (limit?.kind !== 'weekly_scoped') continue;
    const model = stringValue(record(record(limit.scope)?.model)?.display_name);
    if (model === undefined) continue;
    const id = `model:${model.toLowerCase()}`;
    push(percentWindow(id, model, limit.percent, limit.resets_at, WEEK_SECONDS));
  }

  const extra = record(body.extra_usage);
  const usedCents = numberValue(extra?.used_credits);
  if (extra?.is_enabled === true && usedCents !== undefined) {
    const used = usedCents / 100;
    const limit = (numberValue(extra.monthly_limit) ?? 0) / 100;
    if (limit > 0) {
      windows.push({
        id: 'extra',
        label: 'Extra usage',
        usedPercent: clampPercent((used / limit) * 100),
        periodSeconds: 0,
        format: 'dollars',
        usedValue: used,
        limitValue: limit,
      });
    } else if (used > 0) {
      values.push({ id: 'extra', label: 'Extra usage', value: used, format: 'dollars' });
    }
  }

  return {
    provider: 'claude_code',
    plan: formatClaudePlan(credentials.subscriptionType, credentials.rateLimitTier),
    windows,
    values,
    fetchedAt: now.toISOString(),
  };
}

export async function fetchClaudeQuota(now = new Date()): Promise<QuotaSnapshot> {
  const credentials = await readClaudeCredentials();
  if (!credentials) {
    throw new QuotaFailure(
      'noCredentials',
      'No Claude Code login found. Run `claude` and sign in.',
    );
  }
  if (credentials.scopes && !credentials.scopes.includes('user:profile')) {
    throw new QuotaFailure(
      'noCredentials',
      'This Claude Code login cannot read usage limits (missing user:profile scope).',
    );
  }
  if (credentials.expiresAt !== undefined && credentials.expiresAt <= now.getTime()) {
    throw new QuotaFailure('expired', 'Claude Code login expired. Open Claude Code to refresh it.');
  }
  const { body } = await requestJson('Claude', CLAUDE_USAGE_URL, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${credentials.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
    },
  });
  return mapClaudeUsage(body, credentials, now);
}
