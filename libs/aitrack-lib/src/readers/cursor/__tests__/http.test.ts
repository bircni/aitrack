import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchCursorUsageCsv } from '../http.js';
import { cursorAccountId } from '../jwt.js';

function jwt(sub: string, nonce = ''): string {
  return `header.${Buffer.from(JSON.stringify({ sub, nonce })).toString('base64url')}.signature`;
}

afterEach(() => vi.unstubAllGlobals());

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


  it('hashes identity without persisting credentials and tolerates token rotation', () => {
    expect(cursorAccountId(jwt('a', '1'))).toBe(cursorAccountId(jwt('a', '2')));
    expect(cursorAccountId(jwt('a'))).not.toBe(cursorAccountId(jwt('b')));
    expect(cursorAccountId('token')).toMatch(/^[a-f0-9]{64}$/u);
    expect(cursorAccountId('other')).not.toBe(cursorAccountId('token'));
  });
});
