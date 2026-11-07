import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isCloned: vi.fn(),
  cloneOriginUrl: vi.fn(),
}));
vi.mock('../git.js', () => ({
  isCloned: mocks.isCloned,
  cloneOriginUrl: mocks.cloneOriginUrl,
}));

import { differingOrigin, redactUrl, sameRemote } from '../git/remote.js';

describe('redactUrl', () => {
  it.each([
    ['https://ghp_token@github.com/me/d.git', 'https://***@github.com/me/d.git'],
    ['https://me:pass@github.com/me/d.git', 'https://***@github.com/me/d.git'],
    ['ssh://me:pass@host/d.git', 'ssh://***@host/d.git'],
    ['ssh://git@github.com/me/d.git', 'ssh://git@github.com/me/d.git'],
    ['git@github.com:me/d.git', 'git@github.com:me/d.git'],
    ['https://github.com/me/d@v2.git', 'https://github.com/me/d@v2.git'],
    ['/tmp/a@b/d.git', '/tmp/a@b/d.git'],
    ['', ''],
  ])('%s', (url, expected) => {
    expect(redactUrl(url)).toBe(expected);
  });
});

describe('sameRemote', () => {
  it.each([
    ['https://github.com/me/data', 'https://github.com/me/data.git'],
    ['https://github.com/me/data.git/', 'https://github.com/me/data'],
    ['https://github.com/me/data.git', 'git@github.com:me/data.git'],
    ['ssh://git@github.com/me/data.git', 'git@github.com:me/data.git'],
    ['ssh://git@github.com:22/me/data.git', 'git@github.com:me/data.git'],
    ['git+ssh://git@github.com/me/data', 'https://github.com/me/data'],
    ['https://x-access-token:SECRET@github.com/me/data.git', 'https://github.com/me/data.git'],
    ['https://GitHub.COM/me/data.git', 'git@github.com:me/data.git'],
    ['http://github.com/me/data', 'https://github.com/me/data'],
    ['ssh://git@gitea.local:2222/me/data.git', 'https://gitea.local/me/data.git'],
    ['https://gitea.local:443/me/data', 'https://gitea.local/me/data'],
    ['git@host:/srv/data.git', 'ssh://git@host/srv/data.git'],
    ['file:///srv/data.git', '/srv/data'],
    ['/srv/data/', '/srv/data'],
  ])('%s is %s', (a, b) => {
    expect(sameRemote(a, b)).toBe(true);
    expect(sameRemote(b, a)).toBe(true);
  });

  it.each([
    ['https://github.com/me/data', 'https://github.com/me/other'],
    ['https://github.com/me/data', 'https://github.com/you/data'],
    ['https://github.com/me/data', 'https://gitlab.com/me/data'],
    ['git@github.com:me/data.git', 'git@gitlab.com:me/data.git'],
    ['https://github.com/me/Data', 'https://github.com/me/data'],
    ['http://localhost:3000/me/data', 'http://localhost:4000/me/data'],
    ['ssh://git@host:2222/me/data', 'ssh://git@host/me/data'],
    ['/srv/data', '/srv/other'],
    ['/srv/data', 'https://srv/data'],
    ['C:/srv/data', 'git@C:/srv/data'],
    ['old-url', 'new-url'],
    ['ftp://host/me/data', 'https://host/me/data'],
  ])('%s is not %s', (a, b) => {
    expect(sameRemote(a, b)).toBe(false);
    expect(sameRemote(b, a)).toBe(false);
  });
});

describe('differingOrigin', () => {
  beforeEach(() => {
    mocks.isCloned.mockReturnValue(true);
    mocks.cloneOriginUrl.mockReturnValue('old-url');
  });

  it('names a clone on a remote other than repoUrl', () => {
    expect(differingOrigin('new-url')).toBe('old-url');
  });

  it.each([
    ['the origin matches', 'old-url', () => undefined],
    [
      'the origin is the same remote in another form',
      'https://github.com/me/data',
      () => mocks.cloneOriginUrl.mockReturnValue('git@github.com:me/data.git'),
    ],
    ['the origin cannot be read', 'new-url', () => mocks.cloneOriginUrl.mockReturnValue(null)],
    ['there is no clone', 'new-url', () => mocks.isCloned.mockReturnValue(false)],
    ['repoUrl is empty', '', () => undefined],
  ])('reports nothing when %s', (_name, repoUrl, arrange) => {
    arrange();
    expect(differingOrigin(repoUrl)).toBeNull();
  });
});
