import { readCursorAuthState } from '../readers/cursor/authState.js';
import { jwtExpiryMs } from '../readers/cursor/jwt.js';
import { getCursorStateDatabasePath } from '../readers/cursor/location.js';
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

const DASHBOARD_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService';
const BILLING_PERIOD_SECONDS = 30 * 24 * 60 * 60;

function billingCycle(usage: Record<string, unknown>): {
  resetsAt?: string;
  periodSeconds: number;
} {
  const start = numberValue(usage.billingCycleStart);
  const end = numberValue(usage.billingCycleEnd);
  return {
    resetsAt: instantValue(end),
    periodSeconds:
      start !== undefined && end !== undefined && end > start
        ? Math.round((end - start) / 1000)
        : BILLING_PERIOD_SECONDS,
  };
}

/** A reported positive spend wins; otherwise infer it from limit − remaining. */
function onDemandSpentCents(spend: Record<string, unknown>, limit: number, remaining: number) {
  const reported = ['individualUsed', 'pooledUsed', 'totalSpend']
    .map((key) => numberValue(spend[key]))
    .filter((value): value is number => value !== undefined);
  const positive = reported.find((value) => value > 0);
  if (positive !== undefined) return positive;
  const inferred = Math.max(0, limit - remaining);
  return inferred > 0 ? inferred : (reported[0] ?? 0);
}

/** Maps `GetCurrentPeriodUsage` (+ `GetPlanInfo`'s plan name). Amounts arrive in cents. */
export function mapCursorUsage(
  usage: Record<string, unknown>,
  planName: string | undefined,
  now: Date,
): QuotaSnapshot {
  const planUsage = record(usage.planUsage);
  if (usage.enabled === false || !planUsage) {
    throw new QuotaFailure('invalidResponse', 'Cursor reports no active usage-based plan.');
  }
  const spend = record(usage.spendLimitUsage);
  const limitCents = numberValue(planUsage.limit);
  const totalPercentUsed = numberValue(planUsage.totalPercentUsed);
  if (limitCents === undefined && totalPercentUsed === undefined) {
    throw new QuotaFailure('invalidResponse', 'Cursor did not report a usage limit.');
  }
  const usedCents = Math.max(
    0,
    numberValue(planUsage.totalSpend) ??
      (limitCents ?? 0) - (numberValue(planUsage.remaining) ?? 0),
  );
  const { resetsAt, periodSeconds } = billingCycle(usage);
  const team =
    planName?.toLowerCase() === 'team' ||
    stringValue(spend?.limitType)?.toLowerCase() === 'team' ||
    (numberValue(spend?.pooledLimit) ?? 0) > 0;

  const windows: QuotaWindow[] = [];
  if (team && limitCents !== undefined && limitCents > 0) {
    windows.push({
      id: 'usage',
      label: 'Total usage',
      usedPercent: (usedCents / limitCents) * 100,
      resetsAt,
      periodSeconds,
      format: 'dollars',
      usedValue: usedCents / 100,
      limitValue: limitCents / 100,
    });
  } else {
    const computed = limitCents ? (usedCents / limitCents) * 100 : 0;
    windows.push({
      id: 'usage',
      label: 'Total usage',
      usedPercent: totalPercentUsed ?? computed,
      resetsAt,
      periodSeconds,
      format: 'percent',
    });
  }
  for (const [key, id, label] of [
    ['autoPercentUsed', 'auto', 'Auto usage'],
    ['apiPercentUsed', 'api', 'API usage'],
  ] as const) {
    const usedPercent = numberValue(planUsage[key]);
    if (usedPercent !== undefined) {
      windows.push({ id, label, usedPercent, resetsAt, periodSeconds, format: 'percent' });
    }
  }

  const values: QuotaValue[] = [];
  if (spend) {
    const limit = numberValue(spend.individualLimit) ?? numberValue(spend.pooledLimit) ?? 0;
    const remaining =
      numberValue(spend.individualRemaining) ?? numberValue(spend.pooledRemaining) ?? 0;
    const spent = onDemandSpentCents(spend, limit, remaining);
    if (limit > 0) {
      windows.push({
        id: 'onDemand',
        label: 'On-demand',
        usedPercent: (spent / limit) * 100,
        resetsAt,
        periodSeconds,
        format: 'dollars',
        usedValue: spent / 100,
        limitValue: limit / 100,
      });
    } else if (spent > 0) {
      values.push({ id: 'onDemand', label: 'On-demand', value: spent / 100, format: 'dollars' });
    }
  }

  return {
    provider: 'cursor',
    plan: planName === undefined ? undefined : titleCase(planName),
    windows,
    values,
    fetchedAt: now.toISOString(),
  };
}

function connectPost(method: string, accessToken: string) {
  return requestJson('Cursor', `${DASHBOARD_URL}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
    },
    body: '{}',
  });
}

export async function fetchCursorQuota(now = new Date()): Promise<QuotaSnapshot> {
  const databasePath = getCursorStateDatabasePath();
  const authState = databasePath === null ? undefined : await readCursorAuthState(databasePath);
  const accessToken = authState?.accessToken;
  if (accessToken === undefined) {
    throw new QuotaFailure('noCredentials', 'No Cursor login found. Sign in to Cursor.');
  }
  const expiresAt = jwtExpiryMs(accessToken);
  if (expiresAt !== undefined && expiresAt <= now.getTime()) {
    throw new QuotaFailure('expired', 'Cursor login expired. Open Cursor to refresh it.');
  }
  const [usage, plan] = await Promise.all([
    connectPost('GetCurrentPeriodUsage', accessToken),
    connectPost('GetPlanInfo', accessToken).catch(() => undefined),
  ]);
  const planName = stringValue(record(plan?.body.planInfo)?.planName);
  return mapCursorUsage(usage.body, planName, now);
}
