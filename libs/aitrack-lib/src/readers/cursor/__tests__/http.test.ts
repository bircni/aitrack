import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchCursorUsageCsv } from '../http.js';

function jwt(sub: string): string {
  return `header.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.signature`;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Cursor credential attempts', () => {
  it('remembers the exact subject-cookie variant and never repeats identical headers', async () => {
    const token = jwt('account');
    const headers: string[] = [];
    const fetcher = vi.fn((_url: unknown, init: RequestInit) => {
      headers.push(JSON.stringify(init.headers));
      const cookie = new Headers(init.headers).get('cookie');
      return Promise.resolve(
        new Response('csv', { status: cookie?.includes('account%3A%3A') ? 200 : 401 }),
      );
    });
    vi.stubGlobal('fetch', fetcher);
    const result = await fetchCursorUsageCsv(token);
    expect(result.shape).toBe('cookie-encoded:subject');
    expect(new Set(headers).size).toBe(headers.length);
    fetcher.mockClear();
    const preferred = await fetchCursorUsageCsv(token, result.shape);
    expect(preferred.shape).toBe(result.shape);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([429, 503])('stops after HTTP %s and passes Retry-After to backoff', async (status) => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response('', { status, headers: { 'retry-after': '120' } }));
    vi.stubGlobal('fetch', fetcher);
    await expect(fetchCursorUsageCsv('token')).rejects.toMatchObject({ retryAfterSeconds: 120 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['http://cursor.test', 'must use HTTPS'],
    ['https://user:password@cursor.test', 'must not contain embedded credentials'],
    ['not a URL', 'must be a valid HTTPS URL'],
  ])('rejects the unsafe export endpoint %s before sending credentials', async (url, error) => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    vi.stubEnv('CURSOR_WEB_BASE_URL', url);
    await expect(fetchCursorUsageCsv('secret-token')).rejects.toThrow(error);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('summarises every rejected credential shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response('denied', { status: 401, statusText: 'Unauthorized' })),
      ),
    );
    await expect(fetchCursorUsageCsv('bad-token')).rejects.toThrow('bearer: 401 Unauthorized');
  });
});
