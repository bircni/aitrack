import { isFiniteNumber, isRecord } from '../data/guards.js';
import { errorMessage } from '../errors.js';
import type { QuotaErrorKind } from './types.js';

/** Per-request limit so one stalled provider cannot hold up a refresh. */
const QUOTA_FETCH_TIMEOUT_MS = 15_000;

export class QuotaFailure extends Error {
  constructor(
    readonly kind: QuotaErrorKind,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'QuotaFailure';
  }
}

export interface JsonResponse {
  body: Record<string, unknown>;
  headers: Headers;
}

/** Seconds from a `retry-after` header, which may be delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds));
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - now) / 1000));
}

/**
 * GET/POST that resolves to a JSON object or throws a typed QuotaFailure.
 *
 * 401/403 mean the stored token is no longer accepted; the app does not
 * refresh tokens itself, so the fix is to reopen the provider's own tool.
 */
export async function requestJson(
  label: string,
  url: string,
  init: RequestInit,
): Promise<JsonResponse> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(QUOTA_FETCH_TIMEOUT_MS) });
  } catch (error) {
    throw new QuotaFailure('network', `${label} request failed: ${errorMessage(error)}`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new QuotaFailure(
      'auth',
      `${label} rejected the saved login (HTTP ${String(response.status)})`,
    );
  }
  if (response.status === 429) {
    throw new QuotaFailure(
      'rateLimited',
      `${label} is rate limiting quota requests`,
      parseRetryAfter(response.headers.get('retry-after')),
    );
  }
  if (!response.ok) {
    throw new QuotaFailure('network', `${label} returned HTTP ${String(response.status)}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new QuotaFailure('invalidResponse', `${label} returned a non-JSON response`);
  }
  if (!isRecord(body)) {
    throw new QuotaFailure('invalidResponse', `${label} returned an unexpected response`);
  }
  return { body, headers: response.headers };
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

/** A finite number, accepting numeric strings as the providers sometimes send them. */
export function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return isFiniteNumber(parsed) ? parsed : undefined;
}

export function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * An ISO instant from an ISO string (a missing zone means UTC) or an epoch
 * number in seconds or milliseconds.
 */
export function instantValue(value: unknown): string | undefined {
  const text = stringValue(value);
  if (text !== undefined && Number.isNaN(Number(text))) {
    const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/iu.test(text) ? text : `${text}Z`;
    const ms = Date.parse(zoned);
    return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
  }
  const raw = numberValue(value);
  if (raw === undefined) return undefined;
  const ms = Math.abs(raw) < 10_000_000_000 ? raw * 1000 : raw;
  return new Date(ms).toISOString();
}

export function titleCase(value: string): string {
  return value
    .split(/[\s_]+/u)
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
