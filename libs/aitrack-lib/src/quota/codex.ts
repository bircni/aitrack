import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { decodeJwtPayload, jwtExpiryMs } from '../readers/cursor/jwt.js';
import { codexHomeDirs } from '../readers/paths.js';
import {
  instantValue,
  numberValue,
  QuotaFailure,
  record,
  requestJson,
  stringValue,
  titleCase,
} from './http.js';
import type { QuotaSnapshot, QuotaValue, QuotaWindow } from './types.js';

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const SESSION_SECONDS = 5 * 60 * 60;
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const ACCOUNT_CLAIM = 'https://api.openai.com/auth';

export interface CodexCredentials {
  accessToken: string;
  accountId?: string;
  expiresAt?: number;
}

export function codexAuthPaths(): string[] {
  return codexHomeDirs({ overrideOnly: true }).map((dir) => join(dir, 'auth.json'));
}

function accountIdFromJwt(token: string | undefined): string | undefined {
  if (token === undefined) return undefined;
  const payload = decodeJwtPayload(token);
  return (
    stringValue(record(payload?.[ACCOUNT_CLAIM])?.chatgpt_account_id) ??
    stringValue(payload?.chatgpt_account_id)
  );
}

/** `'apiKeyOnly'` when the file holds an API key but no ChatGPT login. */
export function parseCodexAuth(text: string): CodexCredentials | 'apiKeyOnly' | undefined {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return undefined;
  }
  const root = record(document);
  const tokens = record(root?.tokens);
  const accessToken = stringValue(tokens?.access_token);
  if (accessToken === undefined) {
    return stringValue(root?.OPENAI_API_KEY) === undefined ? undefined : 'apiKeyOnly';
  }
  return {
    accessToken,
    accountId: stringValue(tokens?.account_id) ?? accountIdFromJwt(stringValue(tokens?.id_token)),
    expiresAt: jwtExpiryMs(accessToken),
  };
}

export async function readCodexCredentials(): Promise<CodexCredentials | 'apiKeyOnly' | undefined> {
  let apiKeyOnly = false;
  for (const path of codexAuthPaths()) {
    const text = await readFile(path, 'utf8').catch(() => undefined);
    const parsed = text === undefined ? undefined : parseCodexAuth(text);
    if (parsed === 'apiKeyOnly') apiKeyOnly = true;
    else if (parsed) return parsed;
  }
  return apiKeyOnly ? 'apiKeyOnly' : undefined;
}

/** "prolite" and "pro" are ChatGPT's names for the 5x and 20x Pro tiers. */
export function formatCodexPlan(value: unknown): string | undefined {
  const raw = stringValue(value);
  if (raw === undefined) return undefined;
  const lower = raw.toLowerCase();
  if (lower === 'prolite') return 'Pro 5x';
  if (lower === 'pro') return 'Pro 20x';
  return titleCase(raw);
}

type WindowKind = 'session' | 'weekly';

function exactKind(window: Record<string, unknown> | undefined): WindowKind | undefined {
  const seconds = numberValue(window?.limit_window_seconds);
  if (seconds === SESSION_SECONDS) return 'session';
  if (seconds === WEEK_SECONDS) return 'weekly';
  return undefined;
}

/**
 * Primary is usually the session and secondary the week, but the window
 * length is authoritative when present — free plans have only a weekly one.
 */
function mapRateLimit(
  rateLimit: Record<string, unknown> | undefined,
  labels: Record<WindowKind, { id: string; label: string }>,
  now: Date,
): QuotaWindow[] {
  const candidates = (
    [
      [record(rateLimit?.primary_window), 'session'],
      [record(rateLimit?.secondary_window), 'weekly'],
    ] as const
  ).filter(([window]) => window !== undefined);

  const windows: QuotaWindow[] = [];
  for (const kind of ['session', 'weekly'] as const) {
    const match =
      candidates.find(([window]) => exactKind(window) === kind) ??
      candidates.find(([window, fallback]) => exactKind(window) === undefined && fallback === kind);
    const window = match?.[0];
    const usedPercent = numberValue(window?.used_percent);
    if (!window || usedPercent === undefined) continue;
    const resetAfter = numberValue(window.reset_after_seconds);
    windows.push({
      ...labels[kind],
      usedPercent,
      resetsAt:
        instantValue(window.reset_at) ??
        (resetAfter === undefined
          ? undefined
          : new Date(now.getTime() + resetAfter * 1000).toISOString()),
      periodSeconds:
        numberValue(window.limit_window_seconds) ??
        (kind === 'session' ? SESSION_SECONDS : WEEK_SECONDS),
      format: 'percent',
    });
  }
  return windows;
}

export function mapCodexUsage(body: Record<string, unknown>, now: Date): QuotaSnapshot {
  const windows = mapRateLimit(
    record(body.rate_limit),
    { session: { id: 'session', label: 'Session' }, weekly: { id: 'weekly', label: 'Weekly' } },
    now,
  );
  const additional = Array.isArray(body.additional_rate_limits) ? body.additional_rate_limits : [];
  const spark = additional
    .map((entry) => record(entry))
    .find((entry) =>
      [entry?.limit_name, entry?.metered_feature].some((name) =>
        stringValue(name)?.toLowerCase().includes('spark'),
      ),
    );
  if (spark) {
    windows.push(
      ...mapRateLimit(
        record(spark.rate_limit),
        {
          session: { id: 'spark', label: 'Spark' },
          weekly: { id: 'sparkWeekly', label: 'Spark weekly' },
        },
        now,
      ),
    );
  }

  const values: QuotaValue[] = [];
  const credits = record(body.credits);
  const balance = numberValue(credits?.balance) ?? (credits?.has_credits === false ? 0 : undefined);
  if (balance !== undefined) {
    values.push({
      id: 'credits',
      label: 'Credits',
      value: Math.max(0, Math.floor(balance)),
      format: 'count',
    });
  }

  return {
    provider: 'codex',
    plan: formatCodexPlan(body.plan_type),
    windows,
    values,
    fetchedAt: now.toISOString(),
  };
}

export async function fetchCodexQuota(now = new Date()): Promise<QuotaSnapshot> {
  const credentials = await readCodexCredentials();
  if (credentials === 'apiKeyOnly') {
    throw new QuotaFailure(
      'noCredentials',
      'Codex is signed in with an API key; usage limits need a ChatGPT login.',
    );
  }
  if (!credentials) {
    throw new QuotaFailure('noCredentials', 'No Codex login found. Run `codex login`.');
  }
  if (credentials.expiresAt !== undefined && credentials.expiresAt <= now.getTime()) {
    throw new QuotaFailure('expired', 'Codex login expired. Run Codex to refresh it.');
  }
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${credentials.accessToken}`,
  };
  if (credentials.accountId !== undefined) headers['ChatGPT-Account-Id'] = credentials.accountId;
  const { body } = await requestJson('Codex', CODEX_USAGE_URL, { headers });
  return mapCodexUsage(body, now);
}
