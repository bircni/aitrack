import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPTS = fileURLToPath(new URL('..', import.meta.url));

// Only `npm view` answers from the list and only `npm publish` is logged.
const FAKE_NPM = `#!/bin/sh
if [ "$1" = view ]; then
  case " $FAKE_PUBLISHED " in *" $2 "*) echo "\${2##*@}"; exit 0 ;; esac
  exit 1
fi
echo "$*" >> "$FAKE_LOG"
case "$2" in */"$FAKE_FAIL"-*) exit 1 ;; esac
`;

describe('publish-npm', () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'aitrack-publish-')));
    // Only what the job's sparse checkout has, so an import from elsewhere fails here.
    mkdirSync(join(root, 'scripts'));
    for (const name of readdirSync(SCRIPTS)) {
      if (name.endsWith('.ts')) copyFileSync(join(SCRIPTS, name), join(root, 'scripts', name));
    }
    mkdirSync(join(root, 'packs'));
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin/npm'), FAKE_NPM);
    chmodSync(join(root, 'bin/npm'), 0o755);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function publish(version: string, { published = '', fail = '', tarballs = true } = {}) {
    if (tarballs) {
      for (const name of ['aitrack-lib', 'aitrack']) {
        writeFileSync(join(root, 'packs', `${name}-${version}.tgz`), '');
      }
    }
    const log = join(root, 'npm.log');
    writeFileSync(log, '');
    const result = spawnSync(process.execPath, ['scripts/publish-npm.ts', `v${version}`, 'packs'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${join(root, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
        FAKE_PUBLISHED: published,
        FAKE_FAIL: fail,
        FAKE_LOG: log,
      },
    });
    return { result, calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) };
  }

  it('publishes the library first, as file paths, under the default dist-tag', () => {
    const { result, calls } = publish('1.2.3');
    expect(result.status).toBe(0);
    expect(calls).toEqual([
      'publish ./packs/aitrack-lib-1.2.3.tgz --provenance',
      'publish ./packs/aitrack-1.2.3.tgz --provenance',
    ]);
  });

  it('publishes a prerelease under the next dist-tag', () => {
    const { calls } = publish('1.2.3-0');
    expect(calls).toEqual([
      'publish ./packs/aitrack-lib-1.2.3-0.tgz --provenance --tag next',
      'publish ./packs/aitrack-1.2.3-0.tgz --provenance --tag next',
    ]);
  });

  it('finishes a partial release on a re-run by skipping what the registry has', () => {
    const { result, calls } = publish('1.2.3', { published: 'aitrack-lib@1.2.3' });
    expect(result.status).toBe(0);
    expect(calls).toEqual(['publish ./packs/aitrack-1.2.3.tgz --provenance']);
  });

  it('stops at the first failed publish', () => {
    const { result, calls } = publish('1.2.3', { fail: 'aitrack-lib' });
    expect(result.status).toBe(1);
    expect(calls).toEqual(['publish ./packs/aitrack-lib-1.2.3.tgz --provenance']);
  });

  it('publishes nothing unless every tarball is present', () => {
    writeFileSync(join(root, 'packs/aitrack-lib-1.2.3.tgz'), '');
    const { result, calls } = publish('1.2.3', { tarballs: false });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing tarball: ./packs/aitrack-1.2.3.tgz');
    expect(calls).toEqual([]);
  });
});
