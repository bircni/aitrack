import { environmentValue } from '../../env.js';
import { decodeJwtPayload } from './jwt.js';

/**
 * Talking to Cursor's usage-export endpoint.
 *
 * Cursor accepts several credential shapes and which one works has changed
 * over time, so each is tried in turn and every failure is reported together.
 */
const CURSOR_WEB_BASE_URL_ENV = 'CURSOR_WEB_BASE_URL';
const CURSOR_SESSION_COOKIE_NAME = 'WorkosCursorSessionToken';

function getCursorWebBaseUrl(): URL {
  const configured = environmentValue(CURSOR_WEB_BASE_URL_ENV) ?? 'https://cursor.com';
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error(`${CURSOR_WEB_BASE_URL_ENV} must be a valid HTTPS URL`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`${CURSOR_WEB_BASE_URL_ENV} must use HTTPS before Cursor credentials are sent`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(`${CURSOR_WEB_BASE_URL_ENV} must not contain embedded credentials`);
  }
  return url;
}

function buildCookieHeaderValue(cookieValue: string): string {
  return `${CURSOR_SESSION_COOKIE_NAME}=${cookieValue}`;
}

interface FetchAttempt {
  label: string;
  headers: Record<string, string>;
}

function getCursorFetchAttempts(accessToken: string, preferShape?: string): FetchAttempt[] {
  const attempts: FetchAttempt[] = [];
  const seen = new Set<string>();
  const subject = decodeJwtPayload(accessToken)?.sub?.trim();
  const cookieValues = [accessToken];
  if (subject) cookieValues.push(`${subject}::${accessToken}`);

  const pushAttempt = (label: string, headers: Record<string, string>) => {
    const signature = JSON.stringify({
      label,
      headers: Object.entries(headers).toSorted(([a], [b]) => a.localeCompare(b)),
    });
    if (seen.has(signature)) return;
    seen.add(signature);
    attempts.push({ label, headers });
  };

  pushAttempt('bearer', { Authorization: `Bearer ${accessToken}` });
  for (const cookieValue of cookieValues) {
    pushAttempt('cookie', { Cookie: buildCookieHeaderValue(cookieValue) });
    pushAttempt('cookie-encoded', {
      Cookie: buildCookieHeaderValue(encodeURIComponent(cookieValue)),
    });
    pushAttempt('bearer+cookie', {
      Authorization: `Bearer ${accessToken}`,
      Cookie: buildCookieHeaderValue(cookieValue),
    });
    pushAttempt('bearer+cookie-encoded', {
      Authorization: `Bearer ${accessToken}`,
      Cookie: buildCookieHeaderValue(encodeURIComponent(cookieValue)),
    });
  }

  // The shape that worked last time (remembered in the CSV cache) is very
  // likely to work again, so try it first. The full list still follows.
  if (preferShape !== undefined) {
    const index = attempts.findIndex((attempt) => attempt.label === preferShape);
    if (index > 0) attempts.unshift(...attempts.splice(index, 1));
  }
  return attempts;
}

/** A successful export response, plus which credential shape produced it. */
export interface CursorCsvResponse {
  response: Response;
  shape: string;
}

export async function fetchCursorUsageCsv(
  accessToken: string,
  preferShape?: string,
): Promise<CursorCsvResponse> {
  const url = new URL(
    '/api/dashboard/export-usage-events-csv?strategy=tokens',
    getCursorWebBaseUrl(),
  );
  const failures: Array<{ label: string; status: number; statusText: string; body: string }> = [];

  for (const attempt of getCursorFetchAttempts(accessToken, preferShape)) {
    const response = await fetch(url, {
      headers: {
        Accept: 'text/csv,text/plain;q=0.9,*/*;q=0.8',
        ...attempt.headers,
      },
    });
    if (response.ok) return { response, shape: attempt.label };
    const responseBody = await response.text();
    failures.push({
      label: attempt.label,
      status: response.status,
      statusText: response.statusText,
      body: responseBody.trim().slice(0, 200),
    });
  }

  const summary = failures
    .map((f) => {
      const line = `${f.label}: ${String(f.status)} ${f.statusText}`.trim();
      return f.body ? `${line} (${f.body})` : line;
    })
    .join('; ');
  throw new Error(
    `Failed to authenticate Cursor usage export with local auth state from ${url.origin}. ${summary}`,
  );
}
