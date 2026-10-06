import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../updater-manifest.ts', import.meta.url));
const temporaryDirectories: string[] = [];

function manifest(files: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), 'aitrack-updater-manifest-'));
  temporaryDirectories.push(directory);
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(directory, name), contents, 'utf8');
  }
  return spawnSync(process.execPath, [SCRIPT, 'v3.1.0', directory, 'bircni/aitrack'], {
    encoding: 'utf8',
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('updater manifest', () => {
  it('points every platform at its release asset and signature', () => {
    const result = manifest({
      'opentrack.app.tar.gz': '',
      'opentrack.app.tar.gz.sig': 'mac-signature\n',
      'opentrack_3.1.0_aarch64.dmg': '',
      'opentrack_3.1.0_x64-setup.exe': '',
      'opentrack_3.1.0_x64-setup.exe.sig': 'windows-signature\n',
    });

    expect(result.status).toBe(0);
    const { pub_date: publishedAt, ...manifestFields } = JSON.parse(result.stdout) as Record<
      string,
      unknown
    >;
    expect(typeof publishedAt).toBe('string');
    expect(manifestFields).toEqual({
      version: '3.1.0',
      platforms: {
        'darwin-aarch64': {
          signature: 'mac-signature',
          url: 'https://github.com/bircni/aitrack/releases/download/v3.1.0/opentrack.app.tar.gz',
        },
        'windows-x86_64': {
          signature: 'windows-signature',
          url: 'https://github.com/bircni/aitrack/releases/download/v3.1.0/opentrack_3.1.0_x64-setup.exe',
        },
      },
    });
  });

  it('fails when an installer is unsigned', () => {
    const result = manifest({
      'opentrack.app.tar.gz': '',
      'opentrack.app.tar.gz.sig': 'mac-signature',
      'opentrack_3.1.0_x64-setup.exe': '',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('opentrack_3.1.0_x64-setup.exe has no updater signature.');
  });
});
