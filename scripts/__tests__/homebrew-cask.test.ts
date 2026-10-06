import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../homebrew-cask.ts', import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('pins the cask to the released disk image and its checksum', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aitrack-homebrew-cask-'));
  temporaryDirectories.push(directory);
  const dmg = join(directory, 'opentrack_3.1.0_aarch64.dmg');
  writeFileSync(dmg, 'disk image');

  const result = spawnSync(process.execPath, [SCRIPT, 'v3.1.0', dmg], { encoding: 'utf8' });

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('version "3.1.0"');
  expect(result.stdout).toContain(
    'sha256 "0bb2f0f3ed953c47d835a7adaefd95afa328e30a5c80fdce417dd12b014ad602"',
  );
});
