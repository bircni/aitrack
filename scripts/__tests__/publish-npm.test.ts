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

const PLATFORMS = ['darwin-arm64', 'linux-x64', 'linux-arm64', 'win32-x64'].map(
  (t) => `aitrack-cli-${t}`,
);
const PACKS = [...PLATFORMS, 'aitrack'];

describe('publish-npm', () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'aitrack-publish-')));
    // Only what the job's sparse checkout has, so an import from elsewhere fails here.
    mkdirSync(join(root, 'scripts'));
    for (const name of readdirSync(SCRIPTS)) {
      if (name.endsWith('.ts')) copyFileSync(join(SCRIPTS, name), join(root, 'scripts', name));
    }
    mkdirSync(join(root, 'npm/aitrack'), { recursive: true });
    copyFileSync(
      join(SCRIPTS, '../npm/aitrack/targets.json'),
      join(root, 'npm/aitrack/targets.json'),
    );
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
      for (const name of PACKS) writeFileSync(join(root, 'packs', `${name}-${version}.tgz`), '');
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

  it('publishes the platform packages before the launcher that pins them, as file paths', () => {
    const { result, calls } = publish('1.2.3');
    expect(result.status).toBe(0);
    expect(calls).toEqual(PACKS.map((name) => `publish ./packs/${name}-1.2.3.tgz --provenance`));
  });

  it('publishes a prerelease under the next dist-tag', () => {
    const { calls } = publish('1.2.3-0');
    expect(calls.at(-1)).toBe('publish ./packs/aitrack-1.2.3-0.tgz --provenance --tag next');
    expect(calls).toHaveLength(PACKS.length);
  });

  it('finishes a partial release on a re-run by skipping what the registry has', () => {
    const published = ['darwin-arm64', 'linux-x64'].map((t) => `@aitrack/cli-${t}@1.2.3`).join(' ');
    const { result, calls } = publish('1.2.3', { published });
    expect(result.status).toBe(0);
    expect(calls).toEqual(
      PACKS.slice(2).map((name) => `publish ./packs/${name}-1.2.3.tgz --provenance`),
    );
  });

  it('stops at the first failed publish', () => {
    const { result, calls } = publish('1.2.3', { fail: PLATFORMS[1] });
    expect(result.status).toBe(1);
    expect(calls).toEqual(
      PACKS.slice(0, 2).map((name) => `publish ./packs/${name}-1.2.3.tgz --provenance`),
    );
  });

  it('publishes nothing unless every tarball is present', () => {
    writeFileSync(join(root, `packs/${PLATFORMS[0]}-1.2.3.tgz`), '');
    const { result, calls } = publish('1.2.3', { tarballs: false });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Missing tarball: ./packs/${PLATFORMS[1]}-1.2.3.tgz`);
    expect(calls).toEqual([]);
  });
});
